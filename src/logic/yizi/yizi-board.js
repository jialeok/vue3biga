// yizi-board.js — 「竞价一字」看板的 Logic 层（业务规则 / 编排 / 协调，§4）
//
// 架构位置：UI（views/AuctionYiziBoard.vue + composables/useAuctionYizi.js）
//          → 本模块（加载 / 题材解析与分组 / 十日涨幅 / 连板 / ST 剔除 / 选龙头 / 粘贴导入）
//          → Data（data/auction-yizi.js、data/stock-range-pct.js、data/limit-pool.js、
//                  data/stock-topics.js、data/stock-code-map.js）
//          → Supabase / 同花顺 fuyao
//
// 数据链（四条腿，全部是既有单一真相，不新增第二套口径）：
//   ① 竞价一字快照 ← auction_yizi 表（Supabase Edge Function auction-yizi-fetch
//        每交易日【北京 09:25】抓猫抓数据 daily_auc_fd 落库，由 pg_cron 触发；
//        ⚠️ 本看板【不做前端自愈抓取】：9:15~9:25 的竞价快照有强时效性，
//           前端补抓必然发生在错过窗口之后，无意义且会多烧一份小号额度）
//   ② 十日涨幅  ← stock_range_pct 表（缺的票补算，走 logic/auction/range-fill.js，
//                  与「涨跌停」看板【共用同一份实现口径】；十日涨幅 = 块内排序 + 选龙头的度量）
//                  🔴 但【通道一的数据源是本看板自己的小号】（2026-09-19 修正）：
//                     先读 yizi_trend（0 请求）→ 有缺口才调 /trend（自带 5 道额度闸门）→
//                     再退回同花顺 K 线（0 猫抓额度）。
//                     ⛔ 绝不使用 stock-range-pct.js 的 numcat 通道（= 主账号 = 早盘竞价的额度）。
//                  ⚠️ 只把【满窗】的值回写 stock_range_pct（NO-PARTIAL-WRITE）；
//                     残缺窗口（停牌 / 次新）只本地展示，⛔ 不落库。
//   ③ 连板标    ← limit_pool 表（同花顺涨停池落库）：T-1 的连板数 +1 = T 日一字板的连板档位
//                  （复用语义：一字板在 9:25 就已封上涨停价 ⇒ T 日必然涨停）
//   ④ 题材归属 ← 三级优先：接口自带 开盘啦(theme_names_kpl) → 选股宝(theme_names_xgb)
//        → 共享题材库 stock_topics（与涨跌停看板 / 早盘竞价看板同一张表，手动导入互通）
//
// ★★ 加载性能（2026-09-20 用户反馈「切历史日期时竞价一字比早盘竞价慢很多」的四条成因与对策）
//   用户原话：「早盘竞价看板加载完了，竞价一字看板要等……早盘时间很宝贵，影响到判断时间」，
//   而且它直接拖慢早盘竞价看板「题材 toggle → 补竞价一字 toggle」的可用时机。
//   ① 串行 await 链：快照 → 涨幅缓存 → 补算 → 涨停池 → 题材回填，五趟往返排队相加
//      ⇒ 改为【四条独立读同时起跑】（§32），并把「题材自动回填」移出关键路径（后台跑）。
//   ② 主数据陪着附加信息一起等：十日涨幅 / 连板标只是附加信息，却压住了「今天有几只一字」
//      ⇒ 首屏等待预算 FIRST_PAINT_BUDGET_MS：超预算先发布主数据，附加信息到了再补发一次
//      （§33 Loading 范围必须与数据影响范围一致）。⛔ 预算内到齐仍只发布一次，行为与优化前一致。
//   ③ 来回切历史日期每次都整日重读：历史快照是【已落库的既成事实】（只有 9:25 的 Edge 会写）
//      ⇒ 会话内按日缓存 auction_yizi / stock_range_pct / 连板标结果，非 force 一律命中。
//   ④ 日期切换误用 force：force = 「忽略缓存重读」，只该用于手动刷新 / Realtime / 导入后重算
//      ⇒ 切日期改用非 force（数据集本来就换了，指纹必然不同，一定会重新发布）。
//
// 红线：
//   §10  读取失败 ≠ 空。读失败 → error 有值 + 显示提示，绝不渲染成「今天没有一字」。
//        连板标/十日涨幅属于「附加信息」：读失败只让对应列显示 '-'，⛔ 绝不因此丢行或落库。
//   §17  只在数据真正变化时发布（内容指纹比对），避免无意义重渲染。
//   §6   选龙头【不落库】：这是「快照 + 题材库 + 十日涨幅」的派生视图，落库会立刻多出第二个真相源
//        （题材库稍后变更就会让它变陈旧、被永久冻结）。
//   §8   本看板的任何业务/UI 状态都不落 localStorage。
//   §26  日期切换时，迟到的旧请求一律丢弃（_loadSeq 序号闸门）。
//   ★ 一字判据（2026-09-15 修正）：「竞价一字」= 9:25 竞价涨幅 ≈ 涨停幅度
//        （logic/auction/limit-up.js#isAuctionYiZi，与早盘竞价看板的红线下划线同一份实现）。
//        ⛔ 曾经的判据「9:15~9:25 存在任一非空 fa_*」是错的 —— 9:20 前挂的涨停价买单可撤单，
//        于是「挂过又撤掉」的票全被收进来（09-18 表里 121 行里真一字只有 8 只，看板却显示 113 只）。
//        Edge Function 已同步修正；本文件在读取后再闸一次（脏行不会被后端修正自动清掉）。

import { reactive } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { isTradingDay, getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap } from '../auction/topic-sort.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';
import { getStreakLabel } from '../auction/limit-streak.js';
import { getDragonWindowDates } from '../auction/dragon-rank.js';
// §6 单一真相：「十日涨幅取值 + 缺失票用同花顺 K 线补算」与「涨跌停」看板共用同一份实现
import { makeRangePctOf, getRangeFill } from '../auction/range-fill.js';
import { readAuctionYiziForDate } from '../../data/auction-yizi.js';
import { readRangePctForDate } from '../../data/stock-range-pct.js';
// 🔴 十日涨幅【通道一的数据源】= 本看板自己的小号（2026-09-19 修正额度归属）：
//    先读 yizi_trend 缓存（0 上游请求），有缺口才调 /trend（自带 5 道额度闸门）。
//    ⛔ 绝不能沿用 stock-range-pct.js#fetchNumcatDailyPctRange —— 那条走 numcat-proxy=【主账号】，
//    是早盘竞价的额度（用户明确要求两个自动获取的账号互不侵占额度）。
import { fetchYiziDailyPctRange } from '../../data/yizi-trend.js';
import { readLimitPoolForDate, BOARD_UP } from '../../data/limit-pool.js';
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
    yiziSignature,
    dropStRows,
    filterYiziRows
} from './model.js';
// ★ 2026-09-18 需求 1：把本看板接口自带的题材【自动回填】进共享题材库，
//   这样「涨跌停」看板不用再手动粘贴导入（用户原话：「我就不用那么麻烦去手动复制粘贴导入了」）。
//   ⚠️ 写的是同一张 stock_topics（§6），所以三个看板都受益；只补空缺、不覆盖、不写空。
import { syncYiziTopicsIntoLibrary } from '../topics/topic-sync.js';

// ===== 看板状态（本模块唯一的响应式真相，供 composable/UI 读取）=====
export const yiziBoardState = reactive({
    date: '',
    loading: false,
    // 加载阶段（仅用于「加载中…」文案，让用户知道在等什么 —— 首次补算十日涨幅可能偏慢）：
    // '' | 'read'（读快照/题材库/涨幅缓存）| 'range'（用同花顺 K 线补算缺失的十日涨幅）| 'group'（分块选龙头）
    phase: '',
    error: '',
    // 分组结果（题材块，顺序即共享核心的组序：组大者前 → 题材名 → 「其它」置底）
    blocks: [],
    // 池子只数（= 剔除 ST 之后、看板真正展示的只数）
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
    // ★ 2026-09-18 需求 1：本次加载往【共享题材库】自动补进了几只股票的题材 ——
    //    ⛔ 不在这里存：它是全应用唯一真相，由 logic/topics/topic-sync.js 的响应式计数持有，
    //    UI 侧用 getAutoFilledForDate(date) 读（§6 单一真相；副本会陈旧，理由见 topic-sync.js）。
    // 十日涨幅覆盖情况（块内排序 + 选龙头的度量，覆盖不全时 UI 要如实提示）
    rangeReady: false,
    rangeError: '',
    rangeCovered: 0,
    // 当日快照里被剔除的 ST 只数（⛔ 必须让用户看见，否则会被误读成「当天一字很少」）
    stRemoved: 0,
    // 当日快照里【口径不符】被剔除的行数（★ 2026-09-15 新增）。
    // 「竞价一字」的唯一判据是「竞价涨幅 ≈ 涨停幅度」（logic/auction/limit-up.js#isAuctionYiZi）；
    // 表里若残留了旧判据（任一非空 fa_*）收进来的非一字行，这里如实剔除并计数 ——
    // ⛔ 绝不静默剔除：只数必须呈现，否则用户会把「口径剔除」误读成「当天一字很少」。
    yiziRemoved: 0,
    // 其中「竞价涨幅缺失/无法解析 → 无法判定」的只数（§10：不猜，但也不悄悄扔掉不说）
    yiziRemovedNoPct: 0,
    // 内容指纹：仅用于「变了才发布」
    signature: ''
});

// 单飞：同一日期同一时刻只跑一次加载
let _inflight = null;

// 加载序号（单调递增）：日期快速切换时会有多个加载同时在飞，
// 它们**完成顺序不确定**。只有序号 === 当前序号的请求才允许写状态，
// 迟到的旧请求一律丢弃 —— 否则「09-17 的慢请求」会比「09-14 的快请求」晚回来，
// 把 09-14 的页面覆盖成 09-17 的数据（§26 日期切换 / §23 数据集切换：新日期必须整体换源）。
let _loadSeq = 0;

// 本会话已经尝试过「读涨跌停池拿连板标」的日期（连板标是附加信息，失败不值得重试）
const _streakAttempted = new Set();

// ============================================================================
// 会话内【按日】缓存（§32 同一业务数据不重复请求 / §26 日期切换来回切不必重读）
// ============================================================================
// 为什么必须有（2026-09-20 用户反馈「切换历史日期时竞价一字比早盘竞价慢很多」的三条成因之一）：
//   原本每次切日期都要把 auction_yizi / stock_range_pct 整日重读一遍，
//   而历史日期的快照是【已落库的既成事实】（只有 9:25 的 Edge 会写，当天之外不会再变），
//   重读既拿不到新东西，又让用户每次切日期都白等几趟往返。
//
// ⚠️ 缓存的【只是云端读回来的原始事实】，不是派生结论：
//   · blocks / count / 龙头 这一类派生视图一律不缓存（⛔ 缓存派生 = 第二个真相源，§6）；
//   · ⛔ force 一律不命中缓存（force 的语义就是「忽略缓存重读」：手动刷新 / Realtime /
//     题材导入后重算 / 整日对齐 都走它，绝不会被缓存喂旧数据）；
//   · 连板标原本「同一日期只尝试一次」，切走再切回时标会凭空消失 —— 改为按日缓存【结果】复用。
//
// 容量：一次只看一天，10 个日期足够覆盖来回切换；超出按插入序淘汰（LRU）。
const _CACHE_MAX_DATES = 10;
/** date -> rawRows（readAuctionYiziForDate 的返回） */
const _snapshotCache = new Map();
/** date -> Map<stock,{pct,days}>（readRangePctForDate 的返回） */
const _rangeCloudCache = new Map();
/** date -> Map<stock,连板文案> */
const _streakCache = new Map();

/** 写入并按插入序淘汰最久未用的日期（Map 保持插入序） */
function _lruSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > _CACHE_MAX_DATES) map.delete(map.keys().next().value);
}

/** force 加载：该日的缓存全部作废（读回来后会按最新结果回写） */
function _invalidateDateCaches(date) {
    _snapshotCache.delete(date);
    _rangeCloudCache.delete(date);
    _streakCache.delete(date);
    // force 时允许重试连板标（原本「只尝试一次」会让手动刷新也拿不回失败的附加信息）
    _streakAttempted.delete(date);
}

/**
 * 包一层「永不 reject」的旁路 Promise。
 *
 * 用途：附加信息（十日涨幅云端缓存 / 涨停池 / 题材库）的读取失败属于 fail-soft，
 * ⛔ 绝不能让它们把【主数据（一字池）】一起拖进 catch（§10 只要求主数据「读失败必须抛」）。
 * @param {Promise} p
 * @returns {Promise<{ok:boolean, value:*, error:*}>}
 */
function _settle(p) {
    return Promise.resolve(p).then(
        function(v) { return { ok: true, value: v }; },
        function(e) { return { ok: false, value: null, error: e }; }
    );
}

/**
 * 【首屏等待预算】附加信息最多等这么久；到点先返回 null（原 Promise 继续跑，稍后可再 await）。
 *
 * 为什么（用户原话：「早盘竞价加载完了，竞价一字还在等……早盘时间很宝贵」）：
 *   十日涨幅 / 连板标都是【附加信息】，而「今天有几只一字、分别属于什么题材」才是主数据。
 *   ⛔ 让主数据陪着附加信息一起等（尤其历史日期缺涨幅时还要打上游补算）——
 *      正是「早盘竞价看板早已出数、竞价一字还卡在加载中」的根因。
 *   到点即先发布主数据（§33：Loading 范围必须与数据影响范围一致），附加信息随后补上再发一次。
 *
 * ⚠️ 预算内到齐 ⇒ 只发布一次，与优化前【逐行一致】（不会看到列表重排）。
 */
const FIRST_PAINT_BUDGET_MS = 800;

function _withinBudget(p, ms) {
    if (!(ms > 0)) return p;
    let timer = null;
    const guard = new Promise(function(resolve) {
        timer = setTimeout(function() { resolve(null); }, ms);
    });
    return Promise.race([p, guard]).finally(function() {
        if (timer) clearTimeout(timer);
    });
}

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
    yiziBoardState.rangeCovered = 0;
    yiziBoardState.stRemoved = 0;
    yiziBoardState.phase = '';
    if (extra && extra.error !== undefined) yiziBoardState.error = extra.error;
}

// ============================================================================
// 连板标（首板 / 二板 / 三板…）
// ============================================================================

/**
 * 组「股票名 → 连板文案」映射（0 猫抓额度，只读既有的 limit_pool 表）。
 *
 * 口径：一字板在 9:25 就已封上涨停价 ⇒ T 日必属涨停 ⇒
 *       **T 日连板数 = 前一交易日(T-1) 的连续涨停天数 + 1**。
 * 因此主通道读 T-1 的涨停池；T-1 那一行在池里 → cnt+1；不在池里 → 首板（1）。
 *
 * T-1 池子缺失时的兜底：若 T 日自己的涨停池已有该票（收盘后 15:40 抓过），
 * 直接用它的 cnt（该日连续涨停天数，无需 +1）。
 *
 * §10 边界（很重要）：
 *   · 读库失败 → 直接抛给调用方（catch 后只记日志，不阻断看板）；
 *   · 池子读到了但【一条涨停都没有】且 T-1 是交易日 ⇒ 判定为「数据缺失」，
 *     一律【不出连板标】—— ⛔ 绝不把「没数据」猜成「全都是首板」。
 *
 * @param {string} date YYYY-MM-DD
 * @param {object[]} rows 一字池行
 * @param {Promise<{ok:boolean,value:*}>|null} [prevPoolSettled] 【已并发发起】的 T-1 涨停池读取
 *        （由 _load 提前起跑，省掉一趟串行往返；null = 调用方未预取，本函数自己读）
 * @returns {Promise<Map<string,string>>} 股票名 → '首板' | '二板' | …（无依据的票不进 Map）
 */
async function _buildStreakMap(date, rows, prevPoolSettled) {
    const out = new Map();
    const names = new Set();
    (rows || []).forEach(function(r) {
        const nm = r && r.stock ? String(r.stock).trim() : '';
        if (nm) names.add(nm);
    });
    if (names.size === 0) return out;

    const prev = getPreviousTradingDay(date);
    let prevPool = [];
    if (prevPoolSettled) {
        const r = await prevPoolSettled;
        if (r && r.ok && Array.isArray(r.value)) {
            prevPool = r.value.filter(function(x) { return x && x.board === BOARD_UP; });
        }
    } else if (prev) {
        const pool = await readLimitPoolForDate(prev);
        prevPool = pool.filter(function(r) { return r && r.board === BOARD_UP; });
    }

    if (prevPool.length > 0) {
        const inPrev = new Map();
        prevPool.forEach(function(r) {
            const nm = String(r.stock || '').trim();
            if (!nm || inPrev.has(nm)) return;
            const cnt = isFinite(r.continueCnt) ? Number(r.continueCnt) : null;
            if (cnt !== null) inPrev.set(nm, cnt);
        });
        names.forEach(function(nm) {
            // T-1 在涨停池 → T 日 = cnt+1 板
            if (inPrev.has(nm)) { out.set(nm, getStreakLabel(inPrev.get(nm) + 1)); return; }
            // T-1 不在涨停池 → 连板链在 T-1 断开 → T 日涨停 = 首板
            out.set(nm, getStreakLabel(1));
        });
        return out;
    }

    // T-1 池子为空：要么 T-1 不是交易日，要么那一日的数据没抓到（§10 缺失 ≠ 没有）
    let prevTrading = false;
    try { prevTrading = !!prev && isTradingDay(prev); } catch (e) { prevTrading = false; }
    if (prevTrading) {
        _dbgLog('[AUCTION-YIZI] ' + prev + ' 涨停池无数据 → 连板标跳过（不猜成首板）');
    }

    // 兜底：该日自己的涨停池（收盘后已抓过）→ 直接取该日连续涨停天数
    const todayPool = await readLimitPoolForDate(date);
    const upToday = todayPool.filter(function(r) { return r && r.board === BOARD_UP; });
    upToday.forEach(function(r) {
        const nm = String(r.stock || '').trim();
        if (!nm || !names.has(nm) || out.has(nm)) return;
        const cnt = isFinite(r.continueCnt) ? Number(r.continueCnt) : null;
        if (cnt !== null && cnt > 0) out.set(nm, getStreakLabel(cnt));
    });
    return out;
}

// ============================================================================
// 分块
// ============================================================================

/**
 * 行 + 题材 + 十日涨幅 + 连板标 → 分块结构（含龙头）。
 *
 * @param {object[]} rows 已 enrich 的行（含 topicsText / themeSource / rangePct / rangeDays / continueText）
 * @returns {{blocks: Array<object>, stats: {kpl:number,xgb:number,lib:number,none:number}}}
 */
export function buildBlocksFromRows(rows) {
    const stats = { kpl: 0, xgb: 0, lib: 0, none: 0 };
    const list = rows || [];
    list.forEach(function(r) {
        const src = r && r.themeSource;
        if (src === 'kpl') stats.kpl++;
        else if (src === 'xgb') stats.xgb++;
        else if (src === 'lib') stats.lib++;
        else stats.none++;
    });
    if (list.length === 0) return { blocks: [], stats: stats };

    // 整表分类（题材 toggle 同款一票归一）→ 单票兜底；两者都是既有单一真相。
    // ⚠️ 这里必须传【已解析好的题材文本】而不是库里的原始字段，
    //    否则「接口无题材、要靠共享库兜底」的票会被判成无题材（分组与展示就分叉了）。
    const topicRows = list.map(function(r) {
        return {
            stock: r.stock,
            // ⚠️ 这里【必须传字符串】。`changePct` 在这一行的语义是「行内涨幅的展示文本」，
            //    只会被 note/helpers.js#getDisplayNote 拼成 `${changePct}(题材…)` 的前缀，
            //    ⛔ 从不参与任何数值计算。
            //    2026-09-18 实测事故：曾把它填成本看板的数值 rangePct(number)，
            //    于是「该股无题材」时 buildNoteFromFields 的 `note += …` 不执行 →
            //    note 保持为 number → extractTopics 里 `note.match(…)` 直接抛
            //    `t.match is not a function`，整个看板加载失败（一个错值炸掉整块板）。
            //    本看板的排序/龙头度量是 rangePct（由 buildYiziBlocks 的 metricOf 传入），
            //    与这个展示前缀无关，因此这里保持空串即可。
            changePct: '',
            // 与「竞价一字」的度量口径对齐（本看板的排序/龙头依据 = 十日涨幅）
            topics: r.topicsText
        };
    });
    const primaryMap = getPrimaryTopicMap(topicRows);
    const primarySize = buildTopicSizeMap(primaryMap);
    const fallbackFn = function(row) { return classifyStockPrimaryTopic(row, primarySize); };
    return { blocks: buildYiziBlocks(list, primaryMap, fallbackFn), stats: stats };
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

/**
 * 【附加信息】十日涨幅 + 连板标的并行采集（与主数据完全解耦，失败一律 fail-soft）。
 *
 * ⛔ 这里只碰「附加信息」：十日涨幅影响块内排序 / 选龙头，连板标只是行内小标，
 *    两者缺失都只让对应列显示 '-'，⛔ 绝不丢行、绝不阻断看板（§10 / §29 行边界）。
 *
 * @param {string} date
 * @param {object[]} rows 已过闸（一字口径 + ST）的池行
 * @param {Promise<{ok:boolean,value:*}>} pRangeCloud 已并发发起的 stock_range_pct 读取
 * @param {Promise<{ok:boolean,value:*}>|null} pPrevPool 已并发发起的 T-1 涨停池读取
 * @param {() => boolean} isLatest 本次加载是否仍是「最新日期」的请求
 * @returns {Promise<{rangeMap:Map, localMap:Map, rangeReady:boolean, rangeError:string, streakMap:Map}>}
 */
async function _collectExtras(date, rows, pRangeCloud, pPrevPool, isLatest) {
    // ---- 十日涨幅：云端缓存（已并发起跑，这里只是收结果）----
    let rangeMap = new Map();
    let rangeReady = true;
    let rangeError = '';
    const rc = await pRangeCloud;
    if (rc && rc.ok && rc.value) {
        rangeMap = rc.value;
        _lruSet(_rangeCloudCache, date, rangeMap);
    } else if (rc && !rc.ok) {
        rangeReady = false;
        rangeError = '十日涨幅读取失败：' + ((rc.error && rc.error.message) || rc.error);
        _dbgLog('[AUCTION-YIZI] ' + date + ' 读 stock_range_pct 失败: ' + ((rc.error && rc.error.message) || rc.error));
    }

    // ---- 十日涨幅：缺失的票补算（getRangeFill = 会话缓存 + 单飞 + 增量补）----
    let localMap = new Map();
    if (rangeReady) {
        if (isLatest()) yiziBoardState.phase = 'range';
        try {
            localMap = await getRangeFill({
                date: date,
                rows: rows,
                rangeMap: rangeMap,
                codeOf: codeOfYiziRow,
                windowDates: getDragonWindowDates(date),
                // T 腿（当天那根）口径：今天未收盘时用快照里的【竞价涨幅】占位 ——
                // 一字板在 9:25 已封上涨停价，竞价涨幅就是它当天的真实起步，
                // 与「涨跌停」看板（dragon-rank / worker P0）同口径。
                aucPctOf: function(r) { return r && r.aucPct; },
                // 🔴 通道一的数据源必须显式指定为【本看板小号】：
                //    不传就会退回 numcat-proxy（主账号）⇒ 偷烧早盘竞价的额度。
                fetchDailyRange: fetchYiziDailyPctRange,
                tag: '[AUCTION-YIZI]'
            });
        } catch (e) {
            _dbgLog('[AUCTION-YIZI] ' + date + ' 十日涨幅补算失败: ' + (e && e.message || e));
        }
    }

    // ---- 连板标（附加信息，fail-soft：失败只是不出标，绝不影响池子本身）----
    let streakMap = _streakCache.get(date) || null;
    if (!streakMap && !_streakAttempted.has(date)) {
        _streakAttempted.add(date);
        try {
            streakMap = await _buildStreakMap(date, rows, pPrevPool);
            _lruSet(_streakCache, date, streakMap);
        } catch (e) {
            _dbgLog('[AUCTION-YIZI] ' + date + ' 连板标读取失败（不影响展示）: ' + (e && e.message || e));
        }
    }
    return {
        rangeMap: rangeMap,
        localMap: localMap,
        rangeReady: rangeReady,
        rangeError: rangeError,
        streakMap: streakMap || new Map()
    };
}

/** 「附加信息还没到」时的占位（首屏发布用：十日涨幅/连板标一律为空，不做任何猜测） */
function _emptyExtras() {
    return { rangeMap: new Map(), localMap: new Map(), rangeReady: false, rangeError: '', streakMap: new Map() };
}

/**
 * enrich + 分块 + 发布（唯一的发布出口，首屏与补全后走的是同一条路）。
 *
 * @param {string} date
 * @param {object[]} rows 已过闸的池行
 * @param {number} stRemoved 当日被剔除的 ST 只数
 * @param {object} extras _collectExtras 的结果（或 _emptyExtras()）
 * @param {boolean} force
 * @param {() => boolean} isLatest
 */
function _publishBoard(date, rows, stRemoved, extras, force, isLatest) {
    if (!isLatest()) return;
    yiziBoardState.phase = 'group';
    const ex = extras || _emptyExtras();
    // ⑦ 逐行 enrich：题材解析（三级优先）→ 十日涨幅 → 连板标
    const rangePctOf = makeRangePctOf(ex.rangeMap, ex.localMap);
    const enriched = rows.map(function(r) {
        const res = resolveYiziTopics(r, _libraryTopics(r.stock));
        const rg = rangePctOf(r);
        return Object.assign({}, r, {
            topicsText: res.text,
            themeSource: res.source,
            rangePct: rg ? rg.pct : null,
            rangeDays: rg ? rg.days : 0,
            continueText: ex.streakMap.get(r.stock) || ''
        });
    });

    // ⑧ 分组 + 选龙头
    const built = buildBlocksFromRows(enriched);
    const sig = yiziSignature(built.blocks, date);
    if (!isLatest()) return;
    if (!force && yiziBoardState.signature === sig) {
        // 内容一致：只更新轻量字段，不重放分块（§17）
        yiziBoardState.date = date;
        _publishLightStats(built.stats, rows, ex.rangeMap, ex.localMap);
        yiziBoardState.rangeReady = !!ex.rangeReady;
        yiziBoardState.rangeError = ex.rangeError || '';
        yiziBoardState.stRemoved = stRemoved;
        yiziBoardState.loading = false;
        return;
    }
    yiziBoardState.signature = sig;
    // ⚠️ 下面四个字段（date / blocks / count / hasSnapshot）必须【一起】赋值：
    //    UI 用 state.date === 选中日期 判定这份快照是否属于当前日，
    //    中间态出现「date 已换、blocks 未换」会被判成过期而闪一下加载中。
    yiziBoardState.date = date;
    yiziBoardState.blocks = built.blocks;
    yiziBoardState.count = rows.length;
    yiziBoardState.hasSnapshot = true;
    yiziBoardState.updatedAt = (rows[0] && rows[0].updatedAt) || '';
    _publishLightStats(built.stats, rows, ex.rangeMap, ex.localMap);
    yiziBoardState.rangeReady = !!ex.rangeReady;
    yiziBoardState.rangeError = ex.rangeError || '';
    yiziBoardState.stRemoved = stRemoved;
    yiziBoardState.loading = false;
}

async function _load(date, force) {
    const mySeq = ++_loadSeq;
    // 「迟到的旧请求」判据：序号不再是最新 → 本次结果已过期，禁止写任何状态
    const isLatest = function() { return mySeq === _loadSeq; };
    yiziBoardState.loading = true;
    yiziBoardState.phase = 'read';
    yiziBoardState.error = '';
    yiziBoardState.rangeError = '';
    try {
        // ① 非交易日：明确呈现空（上游也不会有数据），不读不写
        let trading = true;
        try {
            trading = isTradingDay(date);
        } catch (e) {
            _dbgLog('[AUCTION-YIZI] 交易日历读取失败（放行）: ' + (e && e.message || e));
        }
        if (!isLatest()) return;
        if (!trading) {
            _publishEmpty(date);
            return;
        }
        if (force) _invalidateDateCaches(date);

        // ② ★ 四条彼此独立的读【同时起跑】（§32：同一业务数据的多趟往返不得串行排队）。
        //    优化前它们是 快照 → 涨幅缓存 → 补算 → 涨停池 的串行 await 链，
        //    每趟 150~400ms 累加起来就是「早盘竞价早已出数、竞价一字还在转」的成因之一。
        //    ⚠️ 主数据（快照）失败必须抛（§10）；其余三趟是附加信息 → _settle 包成永不 reject。
        const prevDay = getPreviousTradingDay(date);
        const needStreak = !!prevDay && !_streakCache.has(date) && !_streakAttempted.has(date);
        const pSnapshot = _snapshotCache.has(date)
            ? Promise.resolve(_snapshotCache.get(date))
            : readAuctionYiziForDate(date);
        const pRangeCloud = _rangeCloudCache.has(date)
            ? Promise.resolve({ ok: true, value: _rangeCloudCache.get(date) })
            : _settle(readRangePctForDate(date));
        const pPrevPool = needStreak ? _settle(readLimitPoolForDate(prevDay)) : null;
        const pTopicLib = isTopicLibraryReady() ? null : _settle(ensureTopicLibraryLoaded());

        const rawRows = await pSnapshot;
        if (!isLatest()) return;
        // 历史日期的快照是【已落库的既成事实】（只有 9:25 的 Edge 会写）→ 按日缓存，
        // 来回切历史日期时省掉这趟往返。force 读回来的也会回写（永远是最新的那份）。
        _lruSet(_snapshotCache, date, rawRows);

        // ③-0 ★ 一字口径闸门（2026-09-15 修正）：只留「竞价涨幅 ≈ 涨停幅度」的行。
        //      为什么必须有这一道：表里的历史行是【旧判据】落下的 ——
        //      旧判据「9:15~9:25 存在任一非空 fa_*」会把「9:20 前挂过涨停价买单又撤掉」的票
        //      也当成一字（09-18 实测 121 行里只有 8 行是真一字，看板却显示 113 只）。
        //      Edge Function 的判据已同步修正，但它只对【未来抓取】生效；已落库的脏行不会被它清掉，
        //      所以这里再闸一次 —— 判据来源仍是同一个 isAuctionYiZi，不是第二套口径。
        //      ⛔ 剔除只数如实记录（yiziRemoved / yiziRemovedNoPct），绝不静默。
        const gated = filterYiziRows(rawRows);
        yiziBoardState.yiziRemoved = gated.removed;
        yiziBoardState.yiziRemovedNoPct = gated.droppedNoPct;
        if (gated.removed > 0) {
            _dbgLog('[AUCTION-YIZI] ' + date + ' 口径剔除 ' + gated.removed + ' 行（未达涨停幅度 ' +
                gated.droppedNotLimit + ' / 缺竞价涨幅 ' + gated.droppedNoPct + '），表内原 ' + rawRows.length + ' 行');
        }

        // ③ 剔除 ST（★ 用户指定：本看板不出现 ST）。
        //    ⛔ 表里照旧保留 ST 行（快照真相），这里只是展示口径 —— 但必须计入 stRemoved 让用户看见。
        const dropped = dropStRows(gated.rows);
        const rows = dropped.rows;
        yiziBoardState.stRemoved = dropped.removed;
        if (rows.length === 0) {
            _publishEmpty(date, { error: '' });
            yiziBoardState.stRemoved = dropped.removed;
            // ⚠️ _publishEmpty 会把口径剔除只数一并归零，这里必须还原：
            //    「表里有 121 行、但没有一行是真一字」这件事恰恰是最需要告诉用户的
            //    （否则他会看到「暂无数据」并以为抓取坏了）。§10：未就绪 ≠ 没有，脏数据 ≠ 没有。
            yiziBoardState.yiziRemoved = gated.removed;
            yiziBoardState.yiziRemovedNoPct = gated.droppedNoPct;
            return;
        }

        // ④ 题材库就绪闸门（幂等；未就绪 → 只提示，不落库，所以不会冻结任何结论）
        let libReady = true;
        if (pTopicLib) {
            const r = await pTopicLib;
            libReady = !!(r && r.ok && r.value !== false);
        } else {
            libReady = isTopicLibraryReady();
        }
        if (!isLatest()) return;
        yiziBoardState.topicLibraryReady = libReady;

        // ④-b ★ 题材自动回填 → 【完全移出关键路径】（后台跑，不 await）。
        //
        // 为什么可以安全地下放到后台（2026-09-20）：
        //   本行题材是【三级优先】取的（接口自带 开盘啦 → 选股宝 → 共享库），
        //   而回填写进共享库的恰恰就是「接口自带的那份题材」——
        //   ⇒ 本板这些票的 topicsText / themeSource 无论回填与否都是同一结果（'kpl' / 'xgb'），
        //     回填【只惠及其它两个看板】，对本板自己的显示没有任何影响。
        //   旧实现把它 await 在 enrich 之前，于是「第一次打开某日」要等 N 次写库往返
        //   才能看到第一行 —— 那正是「竞价一字比早盘竞价慢」的成因之一。
        //   ⛔ 失败照旧只记日志（§20 增强不阻断主流程）。
        syncYiziTopicsIntoLibrary(date, { rows: rawRows }).catch(function(e) {
            _dbgLog('[AUCTION-YIZI] ' + date + ' 题材自动回填异常（不影响看板）: ' + (e && e.message || e));
        });
        if (!isLatest()) return;

        // ⑤ 附加信息（十日涨幅 + 连板标）并行采集，并给首屏一个等待预算：
        //   · 预算内到齐 → 只发布一次（与优化前逐行一致，看不到任何重排）；
        //   · 超时未到齐 → **先发布主数据**（一字池 + 题材分组），附加信息到了再补发一次
        //     （§33：Loading 范围必须与数据影响范围一致）。
        //     ⛔ 主数据不该陪着附加信息一起等 —— 早盘时间宝贵，「今天有几只一字」必须立刻可见，
        //        也直接影响早盘竞价看板「补竞价一字」开关能否立刻用上。
        const pExtras = _collectExtras(date, rows, pRangeCloud, pPrevPool, isLatest);
        // 附加信息绝不允许把主数据的加载拖进 catch：真出现未预期异常时这里吞掉，
        // extras 取到 null → _publishBoard 按「附加信息全空」发布（⛔ 不猜、不丢行，§10）。
        pExtras.catch(function() {});
        let extras = await _withinBudget(pExtras, FIRST_PAINT_BUDGET_MS);
        if (extras) {
            _publishBoard(date, rows, dropped.removed, extras, force, isLatest);
            return;
        }
        _publishBoard(date, rows, dropped.removed, _emptyExtras(), force, isLatest);
        extras = await pExtras;
        if (!isLatest()) return;
        _publishBoard(date, rows, dropped.removed, extras, force, isLatest);
    } catch (e) {
        if (!isLatest()) return;
        yiziBoardState.error = '竞价一字看板加载失败：' + (e && e.message || e);
        _dbgLog('[AUCTION-YIZI] ' + date + ' 加载失败: ' + (e && e.message || e));
    } finally {
        // 只有最新请求才有权把 loading 置回 false：
        // 否则「早发出的慢请求」会让后发请求的加载中提示提前消失（表现为状态错位）。
        if (isLatest()) {
            yiziBoardState.loading = false;
            yiziBoardState.phase = '';
        }
    }
}

/** 题材来源统计 + 十日涨幅覆盖度（两者都是「关于这一天的事实」，与视图过滤无关） */
function _publishLightStats(stats, rows, rangeMap, localMap) {
    yiziBoardState.themeFromKpl = stats.kpl;
    yiziBoardState.themeFromXgb = stats.xgb;
    yiziBoardState.themeFromLib = stats.lib;
    yiziBoardState.themeNone = stats.none;
    const seen = new Set();
    let n = 0;
    (rows || []).forEach(function(r) {
        const nm = r && r.stock ? String(r.stock).trim() : '';
        if (!nm || seen.has(nm)) return;
        seen.add(nm);
        if ((rangeMap && rangeMap.has(nm)) || (localMap && localMap.has(nm))) n++;
    });
    yiziBoardState.rangeCovered = n;
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
 * ── ⚠️ 先明确一件事（2026-09-15 用户提问：「导入题材是不是有问题，导致股票数量变多」）──
 *   **本函数【不可能】改变本看板的股票只数。** 看板只数的唯一链路是：
 *     state.count ← 本文件 rows.length ← data/auction-yizi.js#readAuctionYiziForDate(auction_yizi)
 *   而本函数只调 pushStockTopicsToCloud 写 `stock_topics`（题材库），
 *   ⛔ 从不写 `auction_yizi`（全仓只有 Edge Function 与 db/yizi-backfill.mjs 写它）。
 *   导入后确实会走一次整板重载（loadYiziBoard force），但重读的还是同一张 auction_yizi。
 *   用户当天看到「数量变多」的真凶是【一字判据】把非一字票收进了表里（见文件头 ★ 判据说明）——
 *   导入只是恰好触发了一次重载，让本来就错的表内容第一次显示出来。
 *   为了让这件事可核对，下面会把「本次导入的票里有几只在当前看板池内」一并回报。
 *
 * @param {string} text 粘贴文本
 * @returns {Promise<{ok:boolean, imported:number, skipped:number, failed:number, inPool:number, message:string}>}
 */
export async function importYiziTopicsFromPaste(text) {
    const parsed = parseTopicPaste(text);
    if (parsed.rows.length === 0) {
        return { ok: false, imported: 0, skipped: parsed.skipped, failed: 0, inPool: 0, message: '没有解析到有效的「股票 + 题材」行' };
    }

    // ★ 写库前必须先确保题材库已加载。
    //   原因（真实数据丢失路径）：pushStockTopicsToCloud 是「读云端已有 → 合并本次 → 写回」，
    //   它读的是 state._cloudTopicsCache。若题材库尚未加载（缓存为空/为 null），
    //   「云端已有」会被读成空集 → 写回时就**用本次这一批题材覆盖掉线上已有的题材**（丢数据）。
    //   导入是低频人工操作，这里多等一次加载完全可接受；失败也不阻断（只是提示风险）。
    try {
        await ensureTopicLibraryLoaded();
    } catch (e) {
        _dbgLog('[AUCTION-YIZI] 导入前加载题材库失败（继续导入，但可能覆盖线上已有题材）: ' + (e && e.message || e));
    }

    // 当前看板池内的股票名集合（用于回报「本次导入的票有多少真属于本板」）
    const poolNames = new Set();
    (yiziBoardState.blocks || []).forEach(function(b) {
        (b.stocks || []).forEach(function(s) {
            if (s && s.stock) poolNames.add(String(s.stock).trim());
        });
    });

    let imported = 0;
    let failed = 0;
    let inPool = 0;
    for (const row of parsed.rows) {
        const code = row.code || getStockCode(row.stock) || '';
        if (poolNames.has(String(row.stock).trim())) inPool++;
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
        (parsed.skipped > 0 ? '，跳过 ' + parsed.skipped + ' 行（无有效题材）' : '') +
        (poolNames.size > 0 ? '（其中 ' + inPool + ' 只在本看板当前一字池内，其余只影响其它看板；' +
            '导入不会改变本看板的股票只数）' : '');
    return { ok: imported > 0, imported: imported, skipped: parsed.skipped, failed: failed, inPool: inPool, message: message };
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
