// yizi-board.js — 「竞价一字」看板的 Logic 层（业务规则 / 编排 / 协调，§4）
//
// 架构位置：UI（views/AuctionYiziBoard.vue + composables/useAuctionYizi.js）
//          → 本模块（加载 / 题材解析与分组 / 选龙头 / 粘贴导入）
//          → Data（data/auction-yizi.js、data/stock-topics.js、data/stock-code-map.js）
//          → Supabase
//
// 数据链（两条腿，全部是既有单一真相，不新增第二套口径）：
//   ① 竞价一字快照 ← auction_yizi 表（Supabase Edge Function auction-yizi-fetch
//        每交易日【北京 09:25】抓猫抓数据 daily_auc_fd 落库，由 pg_cron 触发；
//        ⚠️ 本看板【不做前端自愈抓取】：9:15~9:25 的竞价快照有强时效性，
//           前端补抓必然发生在错过窗口之后，无意义且会多烧一份小号额度）
//   ② 题材归属 ← 三级优先：接口自带 开盘啦(theme_names_kpl) → 选股宝(theme_names_xgb)
//        → 共享题材库 stock_topics（与涨跌停看板 / 早盘竞价看板同一张表，手动导入互通）
//
// 红线：
//   §10  读取失败 ≠ 空。读失败 → error 有值 + 显示提示，绝不渲染成「今天没有一字」。
//   §17  只在数据真正变化时发布（内容指纹比对），避免无意义重渲染。
//   §6   选龙头【不落库】：这是「快照 + 题材库」的派生视图，落库会立刻多出第二个真相源
//        （题材库稍后变更就会让它变陈旧、被永久冻结）。
//   §8   本看板的任何业务/UI 状态都不落 localStorage。

import { reactive } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic } from '../auction/topic-sort.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';
import { readAuctionYiziForDate } from '../../data/auction-yizi.js';
import { getStockCode } from '../../data/stock-code-map.js';
import {
    isTopicLibraryReady,
    ensureTopicLibraryLoaded,
    pushStockTopicsToCloud,
    invalidateTopicCache,
    buildTopicCache
} from '../../data/stock-topics.js';
import {
    buildYiziBlocks,
    resolveYiziTopics,
    parseTopicPaste,
    yiziSignature
} from './model.js';

// ===== 看板状态（本模块唯一的响应式真相，供 composable/UI 读取）=====
export const yiziBoardState = reactive({
    date: '',
    loading: false,
    error: '',
    // 分组结果（题材块，顺序即共享核心的组序：组大者前 → 题材名 → 「其它」置底）
    blocks: [],
    count: 0,
    // 该日云端是否确实存在快照（false 且 error 为空 = 该日确实没有抓取记录）
    hasSnapshot: false,
    updatedAt: '',
    // 题材库就绪态：未就绪 → 题材分组不可信（UI 需要提示；但不落库，所以只是提示）
    topicLibraryReady: true,
    // 题材来源统计（可解释性：一眼看出这批一字票的题材主要来自哪里）
    themeFromKpl: 0,
    themeFromXgb: 0,
    themeFromLib: 0,
    themeNone: 0,
    // 内容指纹：仅用于「变了才发布」
    signature: ''
});

// 单飞：同一日期同一时刻只跑一次加载
let _inflight = null;

function _pad2(n) { return String(n).padStart(2, '0'); }

/** 北京「今天」YYYY-MM-DD（与 workers/_shared-source/date-utils.js#beijingToday 同口径） */
export function beijingTodayStr() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + _pad2(d.getUTCMonth() + 1) + '-' + _pad2(d.getUTCDate());
}

/** 共享题材库里该股票的题材（去掉括号，便于喂给分类函数） */
function _libraryTopics(name) {
    const raw = getStockHistoryTopics(name);
    return raw ? String(raw).replace(/[()（）]/g, '') : '';
}

// 竞价一字抓取时刻（北京）：集合竞价 9:25 结束即抓，不晚于 9:26
// （与 supabase/functions/auction-yizi-fetch/index.ts 的 WINDOW_START 同口径）
const YIZI_FETCH_HOUR = 9;
const YIZI_FETCH_MIN = 25;

/** 北京当前分钟数（0~1439） */
function _beijingMinutes() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 该日是否已到「可以有一字数据」的时刻。
 *   · 过去日期 → true
 *   · 将来日期 → false
 *   · 今天     → 北京 09:25 之后（数据由 auction-yizi-fetch 在 09:25~09:26 之间落库）
 * 仅用于 UI 提示「数据什么时候会出现」，⛔ 不用来决定要不要读库。
 * @param {string} date
 * @returns {boolean}
 */
export function isYiziFetchTimeReached(date) {
    if (!date) return false;
    const today = beijingTodayStr();
    if (date < today) return true;
    if (date > today) return false;
    return _beijingMinutes() >= YIZI_FETCH_HOUR * 60 + YIZI_FETCH_MIN;
}

/** 取股票代码（库行自带 → state 映射兜底） */
export function codeOfYiziRow(row) {
    const c = String((row && row.code) || '').trim();
    if (/^\d{6}$/.test(c)) return c;
    return getStockCode(row && row.stock) || '';
}

/** 把状态发布为「空」（该日无一字 / 非交易日 / 读失败）—— 绝不用 0 或旧值顶替 */
function _publishEmpty(date, extra) {
    const sig = 'empty|' + date;
    if (yiziBoardState.signature === sig) {
        if (extra && extra.error !== undefined) yiziBoardState.error = extra.error;
        return;
    }
    yiziBoardState.signature = sig;
    yiziBoardState.date = date;
    yiziBoardState.blocks = [];
    yiziBoardState.count = 0;
    yiziBoardState.hasSnapshot = false;
    yiziBoardState.updatedAt = '';
    yiziBoardState.themeFromKpl = 0;
    yiziBoardState.themeFromXgb = 0;
    yiziBoardState.themeFromLib = 0;
    yiziBoardState.themeNone = 0;
    if (extra && extra.error !== undefined) yiziBoardState.error = extra.error;
}

/**
 * 行 + 题材 → 分块结构（含龙头）。
 *
 * 题材解析走 model.resolveYiziTopics 的三级优先（接口 kpl → 接口 xgb → 共享题材库），
 * 解析结果写回行的 topicsText，随后由共享核心统一做「展示 / 无题材判定」。
 *
 * @param {object[]} rows data/auction-yizi.js 读出的行
 * @returns {{blocks: Array<object>, stats: {kpl:number,xgb:number,lib:number,none:number}}}
 */
export function buildBlocksFromRows(rows) {
    const stats = { kpl: 0, xgb: 0, lib: 0, none: 0 };
    const enriched = (rows || []).map(function(r) {
        const res = resolveYiziTopics(r, _libraryTopics(r.stock));
        if (res.source === 'kpl') stats.kpl++;
        else if (res.source === 'xgb') stats.xgb++;
        else if (res.source === 'lib') stats.lib++;
        else stats.none++;
        return Object.assign({}, r, { topicsText: res.text, themeSource: res.source });
    });
    if (enriched.length === 0) return { blocks: [], stats: stats };

    // 整表分类（题材 toggle 同款一票归一）→ 单票兜底；两者都是既有单一真相。
    // ⚠️ 这里必须传【已解析好的题材文本】而不是库里的原始字段，
    //    否则「接口无题材、要靠共享库兜底」的票会被判成无题材（分组与展示就分叉了）。
    const topicRows = enriched.map(function(r) {
        return {
            stock: r.stock,
            changePct: r.aucPct || '',
            topics: r.topicsText
        };
    });
    const primaryMap = getPrimaryTopicMap(topicRows);
    const fallbackFn = function(row) { return classifyStockPrimaryTopic(row); };
    return { blocks: buildYiziBlocks(enriched, primaryMap, fallbackFn), stats: stats };
}

/**
 * 加载某交易日的「竞价一字」看板数据（看板唯一入口）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function loadYiziBoard(date, opts) {
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
    yiziBoardState.loading = true;
    yiziBoardState.error = '';
    try {
        // ① 非交易日：明确呈现空（上游也不会有数据），不读不写
        let trading = true;
        try {
            trading = isTradingDay(date);
        } catch (e) {
            _dbgLog('[AUCTION-YIZI] 交易日历读取失败（放行）: ' + (e && e.message || e));
        }
        if (!trading) {
            _publishEmpty(date);
            return;
        }

        // ② 读云端快照（§10：读失败必须抛，绝不伪装成空）
        const rows = await readAuctionYiziForDate(date);
        if (rows.length === 0) {
            _publishEmpty(date, { error: '' });
            return;
        }

        // ③ 题材库就绪闸门（幂等；未就绪 → 只提示，不落库，所以不会冻结任何结论）
        let libReady = isTopicLibraryReady();
        if (!libReady) {
            try {
                libReady = await ensureTopicLibraryLoaded();
            } catch (e) {
                _dbgLog('[AUCTION-YIZI] 题材库加载失败: ' + (e && e.message || e));
            }
        }
        yiziBoardState.topicLibraryReady = libReady;

        // ④ 分组 + 选龙头
        const built = buildBlocksFromRows(rows);
        const sig = yiziSignature(built.blocks, date);
        if (!force && yiziBoardState.signature === sig) {
            // 内容一致：只更新轻量字段，不重放分块（§17）
            yiziBoardState.loading = false;
            yiziBoardState.date = date;
            yiziBoardState.themeFromKpl = built.stats.kpl;
            yiziBoardState.themeFromXgb = built.stats.xgb;
            yiziBoardState.themeFromLib = built.stats.lib;
            yiziBoardState.themeNone = built.stats.none;
            return;
        }
        yiziBoardState.signature = sig;
        yiziBoardState.date = date;
        yiziBoardState.blocks = built.blocks;
        yiziBoardState.count = rows.length;
        yiziBoardState.hasSnapshot = true;
        yiziBoardState.updatedAt = (rows[0] && rows[0].updatedAt) || '';
        yiziBoardState.themeFromKpl = built.stats.kpl;
        yiziBoardState.themeFromXgb = built.stats.xgb;
        yiziBoardState.themeFromLib = built.stats.lib;
        yiziBoardState.themeNone = built.stats.none;
    } catch (e) {
        yiziBoardState.error = '竞价一字看板加载失败：' + (e && e.message || e);
        _dbgLog('[AUCTION-YIZI] ' + date + ' 加载失败: ' + (e && e.message || e));
    } finally {
        yiziBoardState.loading = false;
    }
}

/**
 * 题材库变化后重算分组（池行不在内存里，走一次完整加载即可；读 auction_yizi 是廉价查询）。
 * @param {string} [date]
 */
export async function rebuildYiziGrouping(date) {
    await loadYiziBoard(date || yiziBoardState.date, { force: true });
}

/**
 * 手动粘贴导入题材 → 写入【共享题材库】stock_topics。
 *
 * 与涨跌停看板 / 早盘竞价看板同一张表、同一套「累加去重、不覆盖」规则（pushStockTopicsToCloud），
 * 因此三个看板的题材天然互通：这里导的题材，另两个看板立刻可用；反之亦然。
 *
 * @param {string} text 粘贴文本
 * @returns {Promise<{ok:boolean, imported:number, skipped:number, failed:number, message:string}>}
 */
export async function importYiziTopicsFromPaste(text) {
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
            _dbgLog('[AUCTION-YIZI] 题材写入失败 ' + row.stock + ': ' + (e && e.message || e));
        }
    }
    // 题材缓存失效后【必须立刻重建】（§22/§F：只失效不重建会留中间态 → 后续读取走慢路径）
    invalidateTopicCache();
    buildTopicCache();
    // 通知其它消费端：题材库已变（与其自身 Realtime 回调同一条链路，口径一致）
    if (imported > 0) _emit('auction-refresh');
    // 本看板立即按新题材重算分组
    const date = yiziBoardState.date;
    if (date) await loadYiziBoard(date, { force: true });
    const message = '题材导入完成：成功 ' + imported + ' 只，失败 ' + failed + ' 只' +
        (parsed.skipped > 0 ? '，跳过 ' + parsed.skipped + ' 行（无有效题材）' : '');
    return { ok: imported > 0, imported: imported, skipped: parsed.skipped, failed: failed, message: message };
}

// ===== Realtime 回调入口（channel 由 data/auction-yizi.js 持有）=====
/**
 * Realtime 通知到达时调用：重新加载当前日。
 * @param {string} [date]
 */
export async function onYiziRealtimeUpdate(date) {
    const d = date || yiziBoardState.date || beijingTodayStr();
    if (!d) return;
    await loadYiziBoard(d, { force: true });
}
