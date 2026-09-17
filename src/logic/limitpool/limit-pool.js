// limit-pool.js — 「涨跌停」看板的 Logic 层（业务规则 / 编排 / 协调，§4）
//
// 架构位置：UI（views/LimitBoard.vue + composables/useLimitBoard.js）
//          → 本模块（加载 / 自愈 / 题材分组 / 选龙头 / 粘贴导入）
//          → Data（data/limit-pool.js、data/stock-range-pct.js、data/stock-topics.js）
//          → Supabase / 同花顺 fuyao
//
// 数据链（三条腿，全部是既有单一真相，不新增第二套口径）：
//   ① 涨跌停池  ← limit_pool 表（Supabase Edge Function limit-pool-fetch 北京 15:40 抓，pg_cron 触发；
//                 前端打开看板时若当日为空且已过 15:40 → 自愈补抓并落库，作为兜底）
//   ② 十日涨幅  ← stock_range_pct 表（缺的票用同花顺 K 线补齐，复用 range-window.js 的窗口/复利口径）
//   ③ 题材归属  ← 共享题材库 stock_topics（与早盘竞价看板互通；分类走 topic-sort.js 的题材 toggle 同款口径）
//
// 红线：
//   §10  读取失败 ≠ 空。读失败 → error 有值 + 显示 '-'，绝不渲染成「今天没有涨跌停」/ 补 0。
//   §17  只在数据真正变化时发布（内容指纹比对），避免无意义重渲染。
//   §22  短时多次变化（整日对齐 = 上百条）合并成一次刷新（Realtime 侧已防抖）。
//   §6   选龙头【不落库】：这是「池 + 题材库 + 十日涨幅」的派生视图，落库会立刻多出第二个真相源
//        （且题材库稍后变更就会让它变陈旧、被永久冻结 —— 与 2026-09-15 龙头组事故同构）。

import { reactive } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { getDragonWindowDates } from '../auction/dragon-rank.js';
import { buildRangeRows } from '../auction/range-window.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic } from '../auction/topic-sort.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';
import {
    readLimitPoolForDate,
    fetchLimitPoolFromFuyao,
    replaceLimitPoolForDate,
    BOARD_UP,
    BOARD_DOWN
} from '../../data/limit-pool.js';
import { readRangePctForDate, fetchFuyaoDailyPctRange, upsertRangePctRows } from '../../data/stock-range-pct.js';
import { getStockCode } from '../../data/stock-code-map.js';
import {
    isTopicLibraryReady,
    ensureTopicLibraryLoaded,
    pushStockTopicsToCloud,
    invalidateTopicCache,
    buildTopicCache
} from '../../data/stock-topics.js';
import { buildTopicBlocks, parseTopicPaste } from './model.js';

// ===== 看板状态（本模块唯一的响应式真相，供 composable/UI 读取）=====
export const limitBoardState = reactive({
    date: '',
    loading: false,
    error: '',
    // 分组结果（跌停在上、涨停在下由 UI 决定，这里只给数据）
    upBlocks: [],
    downBlocks: [],
    upCount: 0,
    downCount: 0,
    // 该日云端是否确实存在快照（false 且 error 为空 = 该日确实没有抓取记录）
    hasSnapshot: false,
    updatedAt: '',
    // 题材库就绪态：未就绪 → 题材分组不可信（UI 需要提示；但不落库，所以只是提示）
    topicLibraryReady: true,
    // 十日涨幅覆盖情况
    rangeReady: false,
    rangeError: '',
    rangeCovered: 0,
    // 内容指纹：仅用于「变了才发布」
    signature: ''
});

// 本会话已经尝试过自愈抓取的日期（避免反复打上游）
const _fetchAttempted = new Set();
// 本会话已经尝试过补齐十日涨幅的日期
const _rangeFillAttempted = new Set();
// 单飞：同一日期同一时刻只跑一次加载
let _inflight = null;

function _pad2(n) { return String(n).padStart(2, '0'); }

/** 北京「今天」YYYY-MM-DD（与 workers/_shared-source/date-utils.js#beijingToday 同口径） */
function _beijingTodayStr() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + _pad2(d.getUTCMonth() + 1) + '-' + _pad2(d.getUTCDate());
}

/** 北京当前分钟数（0~1439） */
function _beijingMinutes() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 涨跌停池抓取时刻（北京）：收盘 15:00 后等 40 分钟，避开上游收盘瞬间未终态
const POOL_FETCH_HOUR = 15;
const POOL_FETCH_MIN = 40;

/**
 * 该日是否已到「可以抓涨跌停池」的时刻。
 *   · 过去日期 → true（上游支持 date_ms，可补历史）
 *   · 将来日期 → false
 *   · 今天     → 北京 15:40 之后
 * @param {string} date
 * @returns {boolean}
 */
export function isPoolFetchTimeReached(date) {
    if (!date) return false;
    const today = _beijingTodayStr();
    if (date < today) return true;
    if (date > today) return false;
    return _beijingMinutes() >= POOL_FETCH_HOUR * 60 + POOL_FETCH_MIN;
}

/** 共享题材库里该股票的题材（去掉括号，便于喂给分类函数） */
function _libraryTopics(name) {
    const raw = getStockHistoryTopics(name);
    return raw ? String(raw).replace(/[()（）]/g, '') : '';
}

/** 取股票代码（池行自带 → state 映射兜底） */
function _codeOf(row) {
    const c = String((row && row.code) || '').trim();
    if (/^\d{6}$/.test(c)) return c;
    return getStockCode(row && row.stock) || '';
}

/** 把状态发布为「空」（该日无涨跌停 / 非交易日 / 读失败）—— 绝不用 0 或旧值顶替 */
function _publishEmpty(date, extra) {
    const sig = 'empty|' + date;
    if (limitBoardState.signature === sig) return;
    limitBoardState.signature = sig;
    limitBoardState.date = date;
    limitBoardState.upBlocks = [];
    limitBoardState.downBlocks = [];
    limitBoardState.upCount = 0;
    limitBoardState.downCount = 0;
    limitBoardState.hasSnapshot = false;
    limitBoardState.updatedAt = '';
    limitBoardState.rangeCovered = 0;
    if (extra && extra.error !== undefined) limitBoardState.error = extra.error;
}

/**
 * 用池行组出「个股 → 十日涨幅」的取值函数。
 * @param {Map<string,{pct:number|null,days:number}>} rangeMap 云端 stock_range_pct
 * @param {Map<string,{pct:number|null,days:number}>} localMap 本次会话本地补算（含缺腿值，仅供展示）
 */
function _makeRangePctOf(rangeMap, localMap) {
    return function(row) {
        const nm = row && row.stock ? String(row.stock).trim() : '';
        if (!nm) return null;
        if (rangeMap && rangeMap.has(nm)) return rangeMap.get(nm);
        if (localMap && localMap.has(nm)) return localMap.get(nm);
        return null;
    };
}

/**
 * 前端补算「池内缺失」的十日涨幅（同花顺 K 线，0 猫抓额度）。
 *
 * 口径完全复用 range-window.js（窗口 [T-9,T] + 复利累乘 + 查表取腿）：
 *   · 只对「云端 stock_range_pct 没有该股票」的池内票补；
 *   · ⛔ 只有【满窗(days === 窗口长度)】的行才写云（NO-PARTIAL-WRITE，残缺行会按日期级复用地污染排名）；
 *   · 缺腿的值只留在本地供展示（UI 会显示 `N/10日`），下次仍可被更完整的数据覆盖。
 *
 * 失败只记日志（fail-soft）：十日涨幅缺失 → 显示 '-'，绝不影响涨跌停池本身的展示。
 *
 * @returns {Promise<Map<string,{pct:number|null,days:number}>>} 本地补算结果（含缺腿值）
 */
async function _fillMissingRangePct(date, rows, rangeMap) {
    const localMap = new Map();
    const missing = [];
    const seen = new Set();
    rows.forEach(function(r) {
        const nm = r && r.stock ? String(r.stock).trim() : '';
        if (!nm || seen.has(nm)) return;
        seen.add(nm);
        if (rangeMap && rangeMap.has(nm)) return;
        const code = _codeOf(r);
        if (!code) return;
        missing.push({ stock: nm, code: code });
    });
    if (missing.length === 0) return localMap;

    const winDesc = getDragonWindowDates(date);
    if (!winDesc || winDesc.length === 0) return localMap;
    const winAsc = winDesc.slice().reverse();          // buildRangeRows 要求升序，最后一项 = T
    const windowLen = winAsc.length;
    const tYmd = String(date).replace(/-/g, '');

    _dbgLog('[LIMIT-POOL] ' + date + ' 十日涨幅缺失 ' + missing.length + ' 只 → 用同花顺 K 线补算');
    const pctMap = await fetchFuyaoDailyPctRange(missing, winAsc, { concurrency: 3 });

    const targets = [];
    const dailyByCode = Object.create(null);
    const tLegByCode = Object.create(null);
    missing.forEach(function(it) {
        const m = pctMap.get(it.stock);
        if (!m || m.size === 0) return;
        const dm = Object.create(null);
        m.forEach(function(v, ymd) {
            if (ymd === tYmd) tLegByCode[it.code] = v;
            else dm[ymd] = v;
        });
        dailyByCode[it.code] = dm;
        targets.push({ name: it.stock, code: it.code });
    });

    const computed = buildRangeRows(targets, winAsc, dailyByCode, tLegByCode);
    const fullRows = [];
    computed.forEach(function(r) {
        localMap.set(r.stock, { pct: r.pct, days: r.days });
        if (r.days === windowLen) fullRows.push({ stock: r.stock, pct: r.pct, days: r.days });
    });

    if (fullRows.length > 0) {
        try {
            await upsertRangePctRows(date, fullRows);
            _dbgLog('[LIMIT-POOL] ' + date + ' 十日涨幅补算并落库 ' + fullRows.length +
                ' 行（满窗 ' + windowLen + ' 日），本地另持残缺值 ' + (localMap.size - fullRows.length) + ' 条');
        } catch (e) {
            _dbgLog('[LIMIT-POOL] 十日涨幅落库失败（不影响展示）: ' + (e && e.message || e));
        }
    }
    return localMap;
}

/** 把池行 + 十日涨幅 + 题材 → 分块结构（含龙头） */
function _buildBlocks(date, rows, rangeMap, localMap) {
    // 预置「该股全题材文本」，随行透出到分块结果（供看板行内展示，避免 UI 再去读题材库）
    const enriched = rows.map(function(r) {
        return Object.assign({}, r, { topicsText: _libraryTopics(r.stock) });
    });
    const topicRows = enriched.map(function(r) {
        return {
            stock: r.stock,
            changePct: r.board === BOARD_DOWN ? '跌停' : '涨停',
            topics: r.topicsText
        };
    });
    // 整表分类（题材 toggle 同款一票归一）→ 单票兜底；两者都是既有单一真相
    const primaryMap = getPrimaryTopicMap(topicRows);
    const fallbackFn = function(row) { return classifyStockPrimaryTopic(row); };
    const rangePctOf = _makeRangePctOf(rangeMap, localMap);
    void date;
    return buildTopicBlocks(enriched, primaryMap, fallbackFn, rangePctOf);
}

/** 内容指纹：变了才发布（§17） */
function _signature(upBlocks, downBlocks, date) {
    const one = function(blocks) {
        return blocks.map(function(b) {
            return b.topic + '#' + b.count + '#' + (b.leaderStock || '') + '#' + (b.leaderPct === null ? '' : b.leaderPct) +
                '[' + b.stocks.map(function(s) { return s.stock + ':' + (s.rangePct === null ? '' : s.rangePct) + ':' + s.continueText; }).join(',') + ']';
        }).join('||');
    };
    return date + '||UP||' + one(upBlocks) + '||DOWN||' + one(downBlocks);
}

/**
 * 加载某交易日的「涨跌停」看板数据（看板唯一入口）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function loadLimitBoard(date, opts) {
    const force = !!(opts && opts.force);
    if (!date) return;
    if (_inflight && _inflight.date === date && !force) return _inflight.promise;
    const p = _load(date, force).finally(function() {
        if (_inflight && _inflight.date === date) _inflight = null;
    });
    _inflight = { date: date, promise: p };
    return p;
}

async function _load(date, force) {
    limitBoardState.loading = true;
    limitBoardState.error = '';
    limitBoardState.rangeError = '';
    try {
        // ① 非交易日：明确呈现空（上游也不会有数据），不读不写
        let trading = true;
        try {
            trading = isTradingDay(date);
        } catch (e) {
            _dbgLog('[LIMIT-POOL] 交易日历读取失败（放行）: ' + (e && e.message || e));
        }
        if (!trading) {
            _publishEmpty(date);
            return;
        }

        // ② 读云端快照（§10：读失败必须抛，绝不伪装成空）
        let rows = await readLimitPoolForDate(date);

        // ③ 当日为空 + 已到抓取时刻 + 本会话未试过 → 自愈补抓并整日对齐落库
        if (rows.length === 0 && isPoolFetchTimeReached(date) && !_fetchAttempted.has(date)) {
            _fetchAttempted.add(date);
            try {
                const snap = await fetchLimitPoolFromFuyao(date);
                if (snap.up.length === 0 && snap.down.length === 0) {
                    // 两池皆空：上游可能尚未就绪（交易中途/异常日）→ 不写库，如实呈现空（§10 未就绪 ≠ 没有）
                    _dbgLog('[LIMIT-POOL] ' + date + ' 上游返回涨停 0 只、跌停 0 只 → 不写库（可能上游未就绪）');
                } else {
                    await replaceLimitPoolForDate(snap);
                    _dbgLog('[LIMIT-POOL] ' + date + ' 自愈抓取完成：涨停 ' + snap.up.length + ' 只，跌停 ' + snap.down.length + ' 只');
                    rows = await readLimitPoolForDate(date);
                }
            } catch (e) {
                limitBoardState.error = '涨跌停池抓取失败：' + (e && e.message || e);
                _dbgLog('[LIMIT-POOL] ' + date + ' 自愈抓取失败: ' + (e && e.message || e));
            }
        }

        if (rows.length === 0) {
            _publishEmpty(date, { error: limitBoardState.error });
            return;
        }

        // ④ 十日涨幅（读失败 → 不假装为 0，标记 rangeError 让 UI 提示）
        let rangeMap = new Map();
        let rangeReady = true;
        try {
            rangeMap = await readRangePctForDate(date);
        } catch (e) {
            rangeReady = false;
            limitBoardState.rangeError = '十日涨幅读取失败：' + (e && e.message || e);
            _dbgLog('[LIMIT-POOL] ' + date + ' 读 stock_range_pct 失败: ' + (e && e.message || e));
        }

        // ⑤ 缺失的十日涨幅：本会话每个日期只补算一次（fail-soft）
        let localMap = new Map();
        if (rangeReady && !_rangeFillAttempted.has(date)) {
            _rangeFillAttempted.add(date);
            try {
                localMap = await _fillMissingRangePct(date, rows, rangeMap);
            } catch (e) {
                _dbgLog('[LIMIT-POOL] ' + date + ' 十日涨幅补算失败: ' + (e && e.message || e));
            }
        }

        // ⑥ 题材库就绪闸门（幂等；未就绪 → 只提示，不落库，所以不会冻结任何结论）
        let libReady = isTopicLibraryReady();
        if (!libReady) {
            try {
                libReady = await ensureTopicLibraryLoaded();
            } catch (e) {
                _dbgLog('[LIMIT-POOL] 题材库加载失败: ' + (e && e.message || e));
            }
        }
        limitBoardState.topicLibraryReady = libReady;

        // ⑦ 分组 + 选龙头
        const upRows = rows.filter(function(r) { return r.board === BOARD_UP; });
        const downRows = rows.filter(function(r) { return r.board === BOARD_DOWN; });
        const upBlocks = _buildBlocks(date, upRows, rangeMap, localMap);
        const downBlocks = _buildBlocks(date, downRows, rangeMap, localMap);

        const sig = _signature(upBlocks, downBlocks, date);
        if (!force && limitBoardState.signature === sig) {
            // 内容一致：只更新轻量字段，不重放分块（§17）
            limitBoardState.loading = false;
            limitBoardState.date = date;
            limitBoardState.rangeReady = rangeReady;
            limitBoardState.rangeCovered = _countCovered(rows, rangeMap, localMap);
            return;
        }
        limitBoardState.signature = sig;
        limitBoardState.date = date;
        limitBoardState.upBlocks = upBlocks;
        limitBoardState.downBlocks = downBlocks;
        limitBoardState.upCount = upRows.length;
        limitBoardState.downCount = downRows.length;
        limitBoardState.hasSnapshot = true;
        limitBoardState.updatedAt = (rows[0] && rows[0].updatedAt) || '';
        limitBoardState.rangeReady = rangeReady;
        limitBoardState.rangeCovered = _countCovered(rows, rangeMap, localMap);
    } catch (e) {
        limitBoardState.error = '涨跌停看板加载失败：' + (e && e.message || e);
        _dbgLog('[LIMIT-POOL] ' + date + ' 加载失败: ' + (e && e.message || e));
    } finally {
        limitBoardState.loading = false;
    }
}

/** 有十日涨幅的股票数（用于「覆盖度」提示，让用户知道数据是否完整） */
function _countCovered(rows, rangeMap, localMap) {
    const seen = new Set();
    let n = 0;
    rows.forEach(function(r) {
        const nm = r && r.stock ? String(r.stock).trim() : '';
        if (!nm || seen.has(nm)) return;
        seen.add(nm);
        if ((rangeMap && rangeMap.has(nm)) || (localMap && localMap.has(nm))) n++;
    });
    return n;
}

/**
 * 题材库变化后，仅用内存里已有的池行重算分组（0 网络请求）。
 * @param {string} date
 */
export async function rebuildTopicGrouping(date) {
    // 池行不在内存里（状态只存分组结果）→ 走一次完整加载即可（readLimitPoolForDate 是廉价查询）
    await loadLimitBoard(date || limitBoardState.date, { force: true });
}

/**
 * 手动粘贴导入题材 → 写入【共享题材库】stock_topics。
 *
 * 与早盘竞价看板同一张表、同一套「累加去重、不覆盖」规则（pushStockTopicsToCloud），
 * 因此两个看板的题材天然互通：这里导的题材，早盘竞价看板立刻可用；反之亦然。
 *
 * @param {string} text 粘贴文本
 * @returns {Promise<{ok:boolean, imported:number, skipped:number, failed:number, message:string}>}
 */
export async function importTopicsFromPaste(text) {
    const parsed = parseTopicPaste(text);
    if (parsed.rows.length === 0) {
        return { ok: false, imported: 0, skipped: parsed.skipped, failed: 0, message: '没有解析到有效的「股票 + 题材」行' };
    }
    let imported = 0;
    let failed = 0;
    for (const row of parsed.rows) {
        const code = row.code || getStockCode(row.stock) || '';
        try {
            await pushStockTopicsToCloud(row.stock, row.topics, code);
            imported++;
        } catch (e) {
            failed++;
            _dbgLog('[LIMIT-POOL] 题材写入失败 ' + row.stock + ': ' + (e && e.message || e));
        }
    }
    // 题材缓存失效后【必须立刻重建】（§22/§F：只失效不重建会留中间态 → 后续读取走慢路径）
    invalidateTopicCache();
    buildTopicCache();
    // 通知早盘竞价看板等消费端：题材库已变（与其自身 Realtime 回调同一条链路，口径一致）
    if (imported > 0) _emit('auction-refresh');
    // 本看板立即按新题材重算分组
    const date = limitBoardState.date;
    if (date) await loadLimitBoard(date, { force: true });
    const message = '题材导入完成：成功 ' + imported + ' 只，失败 ' + failed + ' 只' +
        (parsed.skipped > 0 ? '，跳过 ' + parsed.skipped + ' 行（无有效题材）' : '');
    return { ok: imported > 0, imported: imported, skipped: parsed.skipped, failed: failed, message: message };
}
