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
import { isTradingDay, getPreviousTradingDay } from '../date/trading-day-helpers.js';
// §6 单一真相：涨跌停幅度（主板 10% / ST 5% / 创业科创 20% / 北交所 30%）与「竞价是否打在板价上」
// 的判定，全部复用「早盘竞价」看板那一份（logic/auction/limit-up.js），⛔ 不在本看板另起一套口径。
import { getAuctionLimitState } from '../auction/limit-up.js';
import { getDragonWindowDates } from '../auction/dragon-rank.js';
// §6 单一真相：「十日涨幅取值 + 缺失票用同花顺 K 线补算」与「竞价一字」看板共用同一份实现
// （logic/auction/range-fill.js），两个看板对同一只票必须算出同一个十日涨幅。
import { makeRangePctOf, getRangeFill } from '../auction/range-fill.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap } from '../auction/topic-sort.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';
import {
    readLimitPoolForDate,
    fetchLimitPoolFromFuyao,
    replaceLimitPoolForDate,
    BOARD_UP,
    BOARD_DOWN
} from '../../data/limit-pool.js';
import { readRangePctForDate } from '../../data/stock-range-pct.js';
// ★ 2026-09-22 需求 2：「竞价就涨停 / 竞价就跌停」的判据 = 9:25 竞价涨幅 auc_pct_chg，
//   唯一落库处在 market_metrics(scope='auction')（与早盘竞价看板同一张表、同一个字段，§6）。
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { getStockCode } from '../../data/stock-code-map.js';
import {
    isTopicLibraryReady,
    ensureTopicLibraryLoaded,
    pushStockTopicsToCloud,
    invalidateTopicCache,
    buildTopicCache
} from '../../data/stock-topics.js';
import { buildTopicBlocks, parseTopicPaste } from './model.js';
// ★ 2026-09-18 需求 1：「竞价一字」的接口自带题材会自动回填进共享题材库（只补空缺、不覆盖），
//   本看板在这里触发一次，用户即使不打开一字看板也能拿到自动补的题材，
//   从而不必再手动粘贴导入。失败静默（只记日志）——「这次没自动补」≠「看板坏了」。
import { syncYiziTopicsIntoLibrary } from '../topics/topic-sync.js';

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
    // ★ 2026-09-22 需求 1【次日继承】：本屏行数据是【哪一天】的真实收盘抓取结果。
    //   · inheritedFrom = ''   → 就是当天自己抓的（正常路径）
    //   · inheritedFrom = 'D'  → 当天还没抓到，屏幕上摆的是 D 日收盘后那一池（原封不动照搬）
    //   ⚠️ 只展示、不落库：继承结果【绝不写回 limit_pool】，
    //      否则库里会混进「看起来是 D+1 的、其实是 D 的」行 → 下一次又被当成真实快照继承下去，
    //      链式污染（D+2 借道 D+1 拿到 D）。不写库 ⇒ 库里每一行都是真实抓取 ⇒ 「只继承一天」是结构性保证。
    inheritedFrom: '',
    // 本屏行数据的真实归属日（= inheritedFrom || date）。竞价涨幅要按【这一天】取，
    // 因为屏幕上的股票本来就是那一天的池子。
    dataDate: '',
    // 竞价涨幅读取失败时置位（只是「标不出下划线」，不阻断看板；⛔ 不静默，UI 会提示）
    aucLimitError: '',
    // 题材库就绪态：未就绪 → 题材分组不可信（UI 需要提示；但不落库，所以只是提示）
    topicLibraryReady: true,
    // ★ 2026-09-18 需求 1：题材自动回填的只数**不存在这里** —— 它是全应用唯一真相，
    //    由 logic/topics/topic-sync.js 的响应式计数持有，UI 侧用 getAutoFilledForDate(date) 读。
    //    ⛔ 曾经在这里放过一份副本 `topicAutoFilled`，实测会陈旧（本板那次回填中止、另一板随后补上时，
    //       副本永久停在 0 → 界面显示「没自动补」，与事实相反）→ 已按 §6 单一真相删除。
    // 十日涨幅覆盖情况
    rangeReady: false,
    rangeError: '',
    rangeCovered: 0,
    // 内容指纹：仅用于「变了才发布」
    signature: ''
});

// 本会话已经尝试过自愈抓取的日期（避免反复打上游）
const _fetchAttempted = new Set();
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

/**
 * ★ 2026-09-22 需求 1【次日继承】：当天还没抓到池子时，允许摆出「最近一个交易日」那一池。
 *
 * 口径（用户逐字定）：
 *   ① 只继承【一天】：D+1 照搬 D；⛔ D+2 不能借道 D+1 去拿 D —— 那是错误继承。
 *   ② 继承的是 D 日【收盘后抓取】的那一池，原封不动。
 *   ③ D 日收盘自动抓取一落地，D+1 立刻换成真实数据（本函数返回 inherit=false 的反向过程，
 *      由「当天读到了自己的行」自动完成 —— 不需要任何额外的清理动作）。
 *
 * ★★ 为什么【只继承一天】是一条结构性保证，而不是靠某个 if 记着：
 *   继承结果**从不写回 limit_pool**（见 state.inheritedFrom 的头注）。
 *   于是库里每一行都必然是某天 15:40 的真实抓取结果，不存在「继承来的行」。
 *   ⇒ 回退时只看【严格最近一个交易日】= 最多一跳，物理上不可能链式。
 *      就算 D+1 那天上游抓取失败、库里空着，D+2 也只会看到「D+1 没有」→ 显示空，
 *      而不会滑到 D 去（这正是用户要的「不能无限继承」）。
 *
 * @param {string} date 目标交易日 YYYY-MM-DD
 * @param {string} today 北京今天 YYYY-MM-DD
 * @param {string|null} prevTradingDay getPreviousTradingDay(date)
 * @returns {{inherit:boolean, from:string, reason:string}} reason 仅用于日志/排查
 */
export function planPoolInheritance(date, today, prevTradingDay) {
    if (!date) return { inherit: false, from: '', reason: 'no-date' };
    // 将来的日期：那天还没到，谈不上传承（否则「明天」会显示今天的池子，误导）
    if (date > today) return { inherit: false, from: '', reason: 'future' };
    if (!prevTradingDay) return { inherit: false, from: '', reason: 'no-prev-trading-day' };
    return { inherit: true, from: prevTradingDay, reason: 'prev-trading-day' };
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
    // 【次日继承】继承态必须跟着一起清 —— 否则「昨天继承、今天翻到一个空日子」会残留昨天的继承标记
    limitBoardState.inheritedFrom = '';
    limitBoardState.dataDate = '';
    limitBoardState.aucLimitError = '';
    if (extra && extra.error !== undefined) limitBoardState.error = extra.error;
}

// 「个股 → 十日涨幅」取值函数与「缺失票补算」已抽到 logic/auction/range-fill.js（§6 单一真相），
// 本看板与「竞价一字」看板共用同一份实现；此处不再保留第二份。

// _fillMissingRangePct 已抽到 logic/auction/range-fill.js#fillMissingRangePct（§6 单一真相）。

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
    const primarySize = buildTopicSizeMap(primaryMap);
    const fallbackFn = function(row) { return classifyStockPrimaryTopic(row, primarySize); };
    const rangePctOf = makeRangePctOf(rangeMap, localMap);
    void date;
    return buildTopicBlocks(enriched, primaryMap, fallbackFn, rangePctOf);
}

/** 内容指纹：变了才发布（§17）。
 *  ⚠️ 必须带上 dataDate：同样的分块内容可能来自「当天自己抓的」或「继承昨天的」，
 *     这两种来源对用户是两件事（要不要显示继承提示），指纹相同会导致状态卡住不更新。 */
function _signature(upBlocks, downBlocks, date, dataDate) {
    const one = function(blocks) {
        return blocks.map(function(b) {
            return b.topic + '#' + b.count + '#' + (b.leaderStock || '') + '#' + (b.leaderPct === null ? '' : b.leaderPct) +
                '[' + b.stocks.map(function(s) { return s.stock + ':' + (s.rangePct === null ? '' : s.rangePct) + ':' + s.continueText; }).join(',') + ']';
        }).join('||');
    };
    return date + '|@' + dataDate + '||UP||' + one(upBlocks) + '||DOWN||' + one(downBlocks);
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

        // ③-b ★ 2026-09-22 需求 1【次日继承】：当天真的没有（自愈也没抓到）→ 摆出【最近一个交易日】那一池。
        //
        //     ⛔ 关键：只做【读取时的一次性替身】，⛔ 绝不写回 limit_pool。
        //        写回去的后果：库里出现「date=D+1 但内容其实是 D」的行 → 下一天又被当成真实快照
        //        继承一次 → 链式污染（D+2 借道 D+1 拿到 D），正是用户点名的错误继承方式。
        //        不写库 ⇒ 库里每一行都是真实抓取 ⇒ 回退最多一跳，物理上不可能链式。
        //     ⛔ 读失败必须抛（§10）：readLimitPoolForDate 失败 ≠ 「那天没有涨跌停」，
        //        抛给外层 catch 显示加载失败，绝不退化成空。
        let dataDate = date;
        let inheritedFrom = '';
        if (rows.length === 0) {
            const plan = planPoolInheritance(date, _beijingTodayStr(), getPreviousTradingDay(date));
            if (plan.inherit) {
                const prevRows = await readLimitPoolForDate(plan.from);
                if (prevRows.length > 0) {
                    rows = prevRows;
                    dataDate = plan.from;
                    inheritedFrom = plan.from;
                    _dbgLog('[LIMIT-POOL] ' + date + ' 当日无池 → 继承 ' + plan.from +
                        '（涨停 ' + prevRows.filter(function(r) { return r.board === BOARD_UP; }).length +
                        ' 只，跌停 ' + prevRows.filter(function(r) { return r.board === BOARD_DOWN; }).length + ' 只；只展示不落库）');
                } else {
                    _dbgLog('[LIMIT-POOL] ' + date + ' 次日继承未命中：' + plan.from + ' 也没有池子 → 如实呈现空');
                }
            }
        }

        if (rows.length === 0) {
            _publishEmpty(date, { error: limitBoardState.error });
            return;
        }

        // ④ 十日涨幅（读失败 → 不假装为 0，标记 rangeError 让 UI 提示）
        //    ⚠️ 取【dataDate】：继承时屏幕上是 D 那一池，十日涨幅必须是「截至 D」的，
        //       按 D+1 取会拿到一堆空值（那只票在 D+1 的快照里还没进过池）→ 整列 '-'。
        let rangeMap = new Map();
        let rangeReady = true;
        try {
            rangeMap = await readRangePctForDate(dataDate);
        } catch (e) {
            rangeReady = false;
            limitBoardState.rangeError = '十日涨幅读取失败：' + (e && e.message || e);
            _dbgLog('[LIMIT-POOL] ' + dataDate + ' 读 stock_range_pct 失败: ' + (e && e.message || e));
        }

        // ⑤ 缺失的十日涨幅：按股票增量补算（fail-soft；getRangeFill 自带会话内缓存与单飞，
        //    已补过的票不再重复打上游，缺腿的值也不会因为「第二次打开」而消失）
        let localMap = new Map();
        if (rangeReady) {
            try {
                localMap = await getRangeFill({
                    date: dataDate,
                    rows: rows,
                    rangeMap: rangeMap,
                    codeOf: _codeOf,
                    windowDates: getDragonWindowDates(dataDate),
                    tag: '[LIMIT-POOL]'
                });
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

        // ⑥-b ★ 需求 1（2026-09-18）：先尝试从「竞价一字」快照自动补题材进共享库，再分组。
        //
        // 为什么必须【在 ⑦ 之前】：
        //   `_buildBlocks` 的题材取自 `_libraryTopics`（读共享库）→ 若回填放在分组之后，
        //   本次补进来的题材要等下一次刷新才生效（用户看到「导入没用」的延迟感）。
        //
        // 为什么可以在这里做：库已就绪（⑥ 刚做过闸门）→ 写回安全（pushStockTopicsToCloud 的
        //   「读云端已有 → 合并 → 写回」前提是库已加载，否则会把云端已有读成空集而覆盖丢数据）。
        // ⚠️ 幂等：同一天本会话只跑一次（模块内去重）；重复打开看板不会反复写库。
        // ⛔ 失败绝不写 error、绝不阻断 —— 自动补题材是**增强**，涨跌停看板本身的数据不依赖它。
        // 📌 这里【不接收】回填只数：提示由 UI 直接读 topic-sync 的响应式单一真相
        //    （getAutoFilledForDate），⛔ 不在本看板留副本（会陈旧，理由见 state 声明处）。
        try {
            await syncYiziTopicsIntoLibrary(date);
        } catch (e) {
            _dbgLog('[LIMIT-POOL] ' + date + ' 题材自动回填异常（不影响看板）: ' + (e && e.message || e));
        }

        // ⑥-c ★ 2026-09-22 需求 2：竞价就涨停 → 股票名下方【实心红线】；竞价就跌停 → 【实心绿线】。
        //
        //   判据 = dataDate 那天的 9:25 竞价涨幅（market_metrics.auc_pct_chg）是否打在该股涨跌停价上。
        //   ⚠️ 取【dataDate】而不是 date：屏幕上的股票本来就是 dataDate 那一池，
        //      拿「今天」的竞价涨幅去标「昨天」的涨停板 = 张冠李戴（§6：同一天、同一票、同一个值）。
        //   ⚠️ 幅度口径复用 logic/auction/limit-up.js（与早盘竞价「竞价一字」同一把尺子），⛔ 不自造。
        //   ⚠️ 覆盖面：market_metrics(auction) 是【早盘竞价自选列表】的指标表，不是全市场 ——
        //      池子里不在自选列表的股票拿不到竞价涨幅 ⇒ 无标记（null），⛔ 绝不当成「不是一字」。
        //      （不为此新增上游抓取：用户明确「获取股票数据不变」。）
        let aucMap = new Map();
        limitBoardState.aucLimitError = '';
        try {
            const metrics = await readMarketMetricsForDate(dataDate, 'auction');
            metrics.forEach(function(m) {
                const nm = m && m.stock ? String(m.stock).trim() : '';
                if (nm) aucMap.set(nm, m.auc_pct_chg || '');
            });
        } catch (e) {
            // fail-soft + 显式提示：拿不到竞价涨幅只是「标不出线」，池子本身依然可信；
            // 但⛔ 绝不静默 —— 否则用户会以为「今天一只竞价一字都没有」（§10 无数据 ≠ 没有）。
            limitBoardState.aucLimitError = '竞价涨幅读取失败，涨跌停看板的竞价标记暂不可用';
            _dbgLog('[LIMIT-POOL] ' + dataDate + ' 读 market_metrics 失败: ' + (e && e.message || e));
        }
        rows = rows.map(function(r) {
            const nm = r && r.stock ? String(r.stock).trim() : '';
            const raw = nm ? aucMap.get(nm) : undefined;
            if (raw === undefined || raw === null || raw === '') return r;
            // ⛔ 用 Object.assign 产新对象：继承来的行是 Data 层读回的原对象，就地改会污染
            return Object.assign({}, r, { aucLimit: getAuctionLimitState(raw, _codeOf(r), nm) });
        });

        // ⑦ 分组 + 选龙头
        const upRows = rows.filter(function(r) { return r.board === BOARD_UP; });
        const downRows = rows.filter(function(r) { return r.board === BOARD_DOWN; });
        const upBlocks = _buildBlocks(date, upRows, rangeMap, localMap);
        const downBlocks = _buildBlocks(date, downRows, rangeMap, localMap);

        const sig = _signature(upBlocks, downBlocks, date, dataDate);
        if (!force && limitBoardState.signature === sig) {
            // 内容一致：只更新轻量字段，不重放分块（§17）
            limitBoardState.loading = false;
            limitBoardState.date = date;
            limitBoardState.dataDate = dataDate;
            limitBoardState.inheritedFrom = inheritedFrom;
            limitBoardState.rangeReady = rangeReady;
            limitBoardState.rangeCovered = _countCovered(rows, rangeMap, localMap);
            return;
        }
        limitBoardState.signature = sig;
        limitBoardState.date = date;
        limitBoardState.dataDate = dataDate;
        limitBoardState.inheritedFrom = inheritedFrom;
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
