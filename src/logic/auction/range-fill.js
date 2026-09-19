// range-fill.js — 【跨看板共享】「十日涨幅」取值 + 缺失票补算（Logic 纯编排，§15 / §6 单一真相）
//
// 为什么要有这个模块：
//   「涨跌停」看板（logic/limitpool/）与「竞价一字」看板（logic/yizi/）都要在行内展示
//   【十日涨幅】，且都要用同一份数据当作「块内排序 + 选龙头」的度量。
//   这套「读云缓存 → 缺的票补算 → 满窗才回写」的流程只能有一份实现，
//   否则两个看板会对同一只票算出/显示出不同的十日涨幅（正是 §6 要禁止的第二真相源）。
//
// 数据链（两条腿 + 补算两个通道）：
//   ① 云端缓存 stock_range_pct（跨设备共享，命中即用，0 请求）
//   ② 补算【通道一 · 逐日涨幅批量】—— ★ 主通道
//   ③ 补算【通道二 · 同花顺 K 线】—— 仅在通道一失败（额度用尽 / 403）时兜底
//
// 🔴🔴 通道一的【额度归属】必须由调用方显式决定（2026-09-20 修正）：
//   · 缺省实现 `fetchNumcatDailyPctRange` → `numcat-proxy` → **主账号 NUMCAT_API_KEY**
//     ⇒ 这是【早盘竞价看板】的额度，**竞价一字看板禁止使用**。
//   · 竞价一字必须传 `opts.fetchDailyRange` = `data/yizi-trend.js#fetchYiziDailyPctRange`
//     （走本看板小号：先读 yizi_trend 缓存，0 请求；有缺口才调 /trend，自带 5 道额度闸门）。
//   · 用户原话（2026-09-19）：「如果竞价一字看板的额度用完了，就不要用早盘竞价的那个主账号额度，
//     因为早盘竞价那个额度是主要的功能，如果占用就会影响到我买卖股票效果，
//     这两个自动获取的账户要不影响额度。」
//   ⇒ 结论：**「共用一套口径代码」不等于「共用一把 key」**。三个看板共用本模块的
//     窗口/复利/T 腿/落库口径，但**各用自己的数据通道**，额度互不侵占。
//
// 口径完全复用 range-window.js（窗口 [T-9,T] + 复利累乘 + T 腿 resolveTDayPct），不另算一套。
//
// ─────────────────────────────────────────────────────────────────────────
// ★ 2026-09-18 重要修正：补算主通道从「同花顺逐只 K 线」改为「猫抓 daily 批量」
//
//   背景：本模块原先照抄 logic/limitpool 的补算实现，只走同花顺逐只 K 线。
//   实测（生产真实数据，2026-09-18 的 121 只一字票）：
//     · 同花顺逐只：并发 3 → 单只均摊 5301ms → 外推 110 只 ≈ 583s；并发 1 ≈ 692s。
//       并发提不上去的根本原因不是我们的代码，而是【上游有全局速率限制】——
//       并发 4~6 会返回被截断的 K 线，且高频请求直接 `HTTP 429 Global request rate limit exceeded`。
//       ⇒ 这条路根本撑不起「一百多只票的前端实时补算」，「看板打开要等 10 分钟」就是它。
//     · 猫抓 daily 批量：**1 次请求**拿回 121 只 × 10 个交易日 = 1200 行，耗时 **1732ms**。
//       覆盖：满窗 119 只 / 缺腿 2 只 / 完全没数据 0 只。
//   ⇒ 相差 300 倍以上，且这正是 logic/auction/dragon-rank.js#_fetchRangeFor 早就采用的
//     「主通道 = 猫抓 daily 批量、兜底 = 同花顺 K 线」分层（本模块此前漏抄了主通道）。
//
// 红线：
//   §10  读取失败 ≠ 空。读失败由调用方处理（标记 rangeError），本模块只负责「补」。
//   §NO-PARTIAL-WRITE  只有【满窗(days === 窗口长度)】的行才写云；残缺行只留本地展示。
//        （残缺行按日期级复用地污染排名 —— 与 2026-09-15 龙头组事故同构）
//   口径定型闸门  今天【未收盘】时 T 腿只能取到竞价涨幅（占位口径）→ **不写云**。
//        否则盘中那次的占位值会被永久冻结（下次因为「缓存已有该股」而跳过重算），
//        见 fillMissingRangePct 内的 [T-LEG GATE] 说明。
//   fail-soft  补算失败只记日志：十日涨幅缺失 → 显示 '-'，绝不影响看板本身的展示。

import {
    buildRangeRows,
    parsePct,
    resolveTDayPct,
    isAuctionLegActive
} from './range-window.js';
import {
    fetchNumcatDailyPctRange,
    fetchFuyaoDailyPctRange,
    upsertRangePctRows
} from '../../data/stock-range-pct.js';
import { beijingTodayStr } from './auction-pull-window.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 北京 15:00 收盘 —— T 腿口径分界（与 logic/auction/dragon-rank.js#CLOSE_COVER_HOUR 同口径） */
const CLOSE_HOUR = 15;

/** 北京当前分钟数（0~1439） */
function _beijingMinutes() {
    const n = new Date();
    return ((n.getUTCHours() + 8) % 24) * 60 + n.getUTCMinutes();
}

/**
 * 通道二的规模上限（只数）。
 *
 * 为什么必须有：通道二（同花顺逐只 K 线）单只均摊 5s+，100 只 = 10 分钟 —— 那不是
 * 「加载慢」，是「看板卡死」。通道一（猫抓批量）失败属于【上游额度用尽】这种
 * 短时间内不会自愈的状态，硬跑通道二只会让用户白等。
 *
 * 20 只 ≈ 35s，是「还能让用户等」的极限；超过就放弃，十日涨幅显示 '-'，
 * 由 UI 的 rangeHint 如实提示「覆盖 N/M 只（缺失的票不参与龙头评选）」——
 * 这是【诚实的降级】，比伪装成「涨幅为 0」或让页面卡 10 分钟都好（§10 / §36）。
 */
const KLINE_FALLBACK_MAX = 20;

/**
 * 通道超时（ms）—— 上游挂死时绝不能让看板永久卡在「加载中」。
 *
 * 为什么必须有（2026-09-18 实测事故）：`fetch()` 没有超时，上游（Edge Function → 猫抓）
 * 偶发不返回也不断开时，`_collectLegsViaNumcat` 会一直挂着 → `fillMissingRangePct` 永不
 * resolve → 看板停在「加载中…（正在补算十日涨幅，首次稍慢）」，刷三次里有一次
 * 【96 秒后一行都没有】。更糟的是 getRangeFill 的 `_inflight` 单飞把这个挂死的 Promise
 * 复用给该日期后续所有加载 ⇒ 那一天在本会话内【永久】加载不出来。
 * 加超时后：超时即判定该通道不可用 → fall-soft（显示 '-' 或走另一通道），
 * 看板一定能渲染出来。⛔ 宁可少一根十日涨幅，也不能整块板子打不开。
 */
const NUMCAT_TIMEOUT_MS = 15000;
/** 通道二自身就慢（逐只 ~5s + 退避重试），预算给大一点，但仍必须有上限 */
const KLINE_TIMEOUT_MS = 45000;

/**
 * 给 Promise 套一个超时闸门（超时 → reject，由调用方按 fail-soft 处理）。
 * ⚠️ 底层 fetch 无法被真正取消（未用 AbortController），超时后它仍在后台跑完 ——
 *    但结果会被丢弃，不会再影响任何状态或落库。
 * @param {Promise} p
 * @param {number} ms
 * @param {string} label 用于日志
 * @returns {Promise}
 */
function _withTimeout(p, ms, label) {
    let timer = null;
    const guard = new Promise(function(_, reject) {
        timer = setTimeout(function() {
            reject(new Error(label + ' 超时（' + ms + 'ms 未返回，判定该通道不可用）'));
        }, ms);
    });
    return Promise.race([p, guard]).finally(function() {
        if (timer) clearTimeout(timer);
    });
}

/**
 * 通道二的【等待预算】（ms）：到点就不等了，先把看板渲染出来。
 *
 * 为什么需要（2026-09-19 用户反馈「竞价一字看板响应有些慢」的真凶）：
 *   通道二是【逐只】同花顺 K 线（单只均摊 ~5s）。涨跌停池 77 只时会因为
 *   `KLINE_FALLBACK_MAX=20` 直接放弃（快），但**竞价一字池在「一字口径闸门」之后通常只剩个位数只**
 *   ⇒ 数量上「合法」（≤20），于是 8 只 × 5s ≈ **40s 原样卡在首屏**。
 *   这条路只在【通道一失败】时才走到（猫抓额度用尽 / 403 / 超时），但那种时段用户会觉得
 *   看板「打不开」。
 *
 * 取舍（明确记录，便于回退）：预算到点即放弃等待 ⇒ 本轮这些票的十日涨幅显示 `'-'`
 *   （看板照旧有 `rangeCovered / rangeHint` 如实提示「缺 N 只、不参与龙头评选」），
 *   ⛔ 不再让看板白等几十秒。**通道一（猫抓 daily 批量，1 次请求 ≈2s）不受任何影响，仍是主通道。**
 *   若希望「宁可慢也要补全」，只需把本值调大（或设为 0 = 不限，退回旧行为）。
 */
const KLINE_BUDGET_MS = 12000;

/**
 * 给 Promise 套一个「等待预算」：到点返回 null（不 reject，调用方按「本轮拿不到」处理）。
 * ⚠️ 预算到点后原 Promise **仍在后台跑**（它自己还有 KLINE_TIMEOUT_MS 兜底），
 *    结果会被丢弃 —— 因此这里必须挂一个空 catch，否则会产生 unhandledrejection 噪声。
 * @param {Promise} p
 * @param {number} ms 0 / 负数 = 不限（退回 await 原行为）
 * @returns {Promise<*|null>}
 */
function _raceBudget(p, ms) {
    if (!(ms > 0)) return p;
    p.catch(function() {});
    let timer = null;
    const guard = new Promise(function(resolve) {
        timer = setTimeout(function() { resolve(null); }, ms);
    });
    return Promise.race([p, guard]).finally(function() {
        if (timer) clearTimeout(timer);
    });
}

/**
 * 用「云端缓存 + 本地补算」组出「行 → {pct, days}」的取值函数。
 *
 * 优先级：云端缓存 > 本地补算（云端是跨设备共享的权威缓存，本地只是本次会话的临时值）。
 *
 * @param {Map<string,{pct:number|null,days:number}>} rangeMap 云端 stock_range_pct
 * @param {Map<string,{pct:number|null,days:number}>} localMap 本次会话本地补算（含缺腿值，仅供展示）
 * @returns {(row:object)=>({pct:number|null,days:number}|null)}
 */
export function makeRangePctOf(rangeMap, localMap) {
    return function(row) {
        const nm = row && row.stock ? String(row.stock).trim() : '';
        if (!nm) return null;
        if (rangeMap && rangeMap.has(nm)) return rangeMap.get(nm);
        if (localMap && localMap.has(nm)) return localMap.get(nm);
        return null;
    };
}

// ============================================================================
// 通道一：猫抓 daily 批量（★ 主通道）
// ============================================================================

/**
 * 一次请求取回「全部缺票 × 整个窗口」的逐日涨幅，组装成 buildRangeRows 的入参。
 *
 * 为什么是主通道：猫抓 daily 接口接受【逗号拼接的多个 symbols + 一个日期区间】，
 * 1 次请求即可覆盖全部股票 × 10 个交易日（实测 121 只 × 10 天 = 1200 行 / 1732ms）。
 * 额度极省：整批只算 1 次调用。
 *
 * 🔴 **额度归属（2026-09-20 修正，⛔ 别再改回单一通道）**：
 *   缺省实现 `fetchNumcatDailyPctRange` 打的是 `numcat-proxy` → **主账号 NUMCAT_API_KEY**。
 *   这条腿只允许【早盘竞价 / 涨跌停】使用 —— 它们的额度与主账号同源。
 *   **竞价一字看板必须传入自己的 `fetchDailyRange`**（走本看板小号，
 *   见 `data/yizi-trend.js#fetchYiziDailyPctRange`），否则就是在偷烧早盘竞价的额度：
 *   用户原话「如果竞价一字看板的额度用完了，就不要用早盘竞价的那个主账号额度……
 *   这两个自动获取的账户要不影响额度」。
 *
 * @param {Array<{stock:string, code:string, row:object}>} missing 缺票（已按股票名去重）
 * @param {string[]} winAsc 升序窗口 ['YYYY-MM-DD', …]，最后一项 = T
 * @param {string} date 区间结束日 T
 * @param {(row:object)=>(*)} [aucPctOf] 取「当日竞价涨幅」的回调（今天未收盘时作 T 腿）
 * @param {(symbols:string, startYmd:string, endYmd:string)=>(Promise<Map>)} [fetchDailyRange]
 *        逐日涨幅的数据源（缺省 = 主账号 numcat-proxy；竞价一字必须显式传入小号通道）
 * @returns {Promise<{targets:Array, dailyByCode:Object, tLegByCode:Object}|null>}
 *          接口失败 / 返回空 → null（由调用方决定是否走兜底通道）
 */
async function _collectLegsViaNumcat(missing, winAsc, date, aucPctOf, fetchDailyRange) {
    const startYmd = String(winAsc[0]).replace(/-/g, '');
    const endYmd = String(winAsc[winAsc.length - 1]).replace(/-/g, '');
    const fetchFn = typeof fetchDailyRange === 'function' ? fetchDailyRange : fetchNumcatDailyPctRange;
    const byCode = await fetchFn(
        missing.map(function(it) { return it.code; }).join(','),
        startYmd,
        endYmd
    );
    if (!byCode || byCode.size === 0) return null;

    const tDate = winAsc[winAsc.length - 1];
    const tYmd = String(tDate).replace(/-/g, '');
    const isToday = date === beijingTodayStr();
    const afterClose = _beijingMinutes() >= CLOSE_HOUR * 60;

    const targets = [];
    const dailyByCode = Object.create(null);
    const tLegByCode = Object.create(null);
    missing.forEach(function(it) {
        const src = byCode.get(it.code);
        if (!src) return;
        const dm = Object.create(null);
        let tDay = null;
        winAsc.forEach(function(d) {
            const ymd = String(d).replace(/-/g, '');
            const v = src.has(ymd) ? src.get(ymd) : null;
            // T 日单独摘出来当「T 腿」，不能混进 dailyByCode（buildRangeRows 会按 tLegByCode 覆盖）
            if (ymd === tYmd) { tDay = parsePct(v); return; }
            if (v !== null && v !== undefined && isFinite(v)) dm[ymd] = Number(v);
        });
        // T 腿口径单一真相（range-window.js#resolveTDayPct）：
        //   今天【未收盘】→ 竞价涨幅占位（竞价缺失才退回当日实时/行内涨幅，⛔ 绝不丢 T 腿）；
        //   已收盘 / 历史日期 → 当日收盘涨幅。
        const tLeg = resolveTDayPct(isToday, afterClose, tDay, aucPctOf ? parsePct(aucPctOf(it.row)) : null);
        dailyByCode[it.code] = dm;
        if (tLeg !== null) tLegByCode[it.code] = tLeg;
        targets.push({ name: it.stock, code: it.code });
    });
    if (targets.length === 0) return null;
    return { targets: targets, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
}

// ============================================================================
// 通道二：同花顺 K 线（兜底）
// ============================================================================

/**
 * 逐只用同花顺前复权 K 线算窗口内日涨幅（0 猫抓额度）。
 *
 * ⚠️ 单只均摊 5s 以上，且上游有全局速率限制（并发 >3 会返回被截断的 K 线、高频直接 429）
 *    ⇒ **只作兜底**，且只对少数缺票使用（见 KLINE_FALLBACK_MAX）。⛔ 不要把它改回主通道。
 *
 * @param {Array<{stock:string, code:string, row:object}>} missing
 * @param {string[]} winAsc 升序窗口
 * @param {string} date
 * @param {(row:object)=>(*)} [aucPctOf]
 * @param {number} concurrency
 * @returns {Promise<{targets:Array, dailyByCode:Object, tLegByCode:Object}|null>}
 */
async function _collectLegsViaKline(missing, winAsc, date, aucPctOf, concurrency) {
    const pctMap = await fetchFuyaoDailyPctRange(missing, winAsc, { concurrency: concurrency });
    if (!pctMap || pctMap.size === 0) return null;

    const tDate = winAsc[winAsc.length - 1];
    const tYmd = String(tDate).replace(/-/g, '');
    const isToday = date === beijingTodayStr();
    const afterClose = _beijingMinutes() >= CLOSE_HOUR * 60;

    const targets = [];
    const dailyByCode = Object.create(null);
    const tLegByCode = Object.create(null);
    missing.forEach(function(it) {
        const m = pctMap.get(it.stock);
        if (!m || m.size === 0) return;
        const dm = Object.create(null);
        let tDay = null;
        m.forEach(function(v, ymd) {
            if (ymd === tYmd) tDay = parsePct(v);
            else if (v !== null && v !== undefined && isFinite(v)) dm[ymd] = Number(v);
        });
        // 与通道一【同一句】T 腿口径：K 线里的 T 日只有收盘后才存在，
        // 所以盘中这里必然靠竞价涨幅占位（拿不到就不放这根腿 → days 少 1 → 不满窗 → 自然不落库）。
        const tLeg = resolveTDayPct(isToday, afterClose, tDay, aucPctOf ? parsePct(aucPctOf(it.row)) : null);
        dailyByCode[it.code] = dm;
        if (tLeg !== null) tLegByCode[it.code] = tLeg;
        targets.push({ name: it.stock, code: it.code });
    });
    if (targets.length === 0) return null;
    return { targets: targets, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
}

// ============================================================================
// 补算主入口
// ============================================================================

/**
 * 前端补算「池内缺失」的十日涨幅。
 *
 * 行为：
 *   · 只对「rangeMap 里没有该股票」的行补算（已缓存的票不浪费请求）；
 *   · 同一日期内按股票名去重（一字池与涨跌停池都可能同名多行）；
 *   · 依次尝试【通道一 猫抓批量】→【通道二 同花顺 K 线】（fail-soft）；
 *   · 只回写【满窗】的行（NO-PARTIAL-WRITE）；且今天未收盘时不回写（口径定型闸门）。
 *
 * @param {object} opts
 * @param {string} opts.date           交易日 YYYY-MM-DD（区间结束日 T）
 * @param {object[]} opts.rows         池行（需含 stock，与 codeOf 能取到 6 位代码）
 * @param {Map<string,{pct:number|null,days:number}>} opts.rangeMap 云端缓存（已有的不补）
 * @param {(row:object)=>string} opts.codeOf 取 6 位代码
 * @param {string[]} opts.windowDates  窗口交易日【降序】[T, T-1, …]（getDragonWindowDates 的输出）
 * @param {(row:object)=>(*)} [opts.aucPctOf] 取「当日竞价涨幅」的回调（今天未收盘时作 T 腿；
 *        一字看板传 r => r.aucPct；不传则 T 腿只用收盘/实时涨幅）
 * @param {string} [opts.tag]          日志前缀（便于区分是哪个看板在补）
 * @param {number} [opts.concurrency]  通道二的并发度（默认 3：上游并发 >3 会返回被截断的 K 线）
 * @param {Set<string>} [opts.tried]   本会话已经补算过的股票名（命中则跳过，避免反复打上游）
 * @returns {Promise<Map<string,{pct:number|null,days:number}>>} 本地补算结果（含缺腿值，可能为空 Map）
 */
export async function fillMissingRangePct(opts) {
    const o = opts || {};
    const tag = o.tag || '[RANGE-FILL]';
    const localMap = new Map();
    const rows = Array.isArray(o.rows) ? o.rows : [];
    const rangeMap = o.rangeMap;
    const tried = o.tried;
    const codeOf = typeof o.codeOf === 'function' ? o.codeOf : function(r) { return (r && r.code) || ''; };
    const aucPctOf = typeof o.aucPctOf === 'function' ? o.aucPctOf : null;
    // 🔴 通道一的数据源：缺省走主账号（numcat-proxy）。【竞价一字看板必须传自己的小号通道】
    //    —— 见 data/yizi-trend.js#fetchYiziDailyPctRange 与本节头部的「额度归属」说明。
    const fetchDailyRange = typeof o.fetchDailyRange === 'function' ? o.fetchDailyRange : null;
    const winDesc = o.windowDates;

    const missing = [];
    const seen = new Set();
    rows.forEach(function(r) {
        const nm = r && r.stock ? String(r.stock).trim() : '';
        if (!nm || seen.has(nm)) return;
        seen.add(nm);
        if (rangeMap && rangeMap.has(nm)) return;
        if (tried && tried.has(nm)) return;
        const code = codeOf(r);
        if (!code) return;
        if (tried) tried.add(nm);
        missing.push({ stock: nm, code: code, row: r });
    });
    if (missing.length === 0) return localMap;
    if (!winDesc || winDesc.length === 0) return localMap;

    const winAsc = winDesc.slice().reverse();          // buildRangeRows 要求升序，最后一项 = T
    const windowLen = winAsc.length;

    _dbgLog(tag + ' ' + o.date + ' 十日涨幅缺失 ' + missing.length + ' 只 → 通道一（逐日涨幅批量）');

    // ---- 通道一：逐日涨幅批量（1 次请求覆盖全部缺票 × 整个窗口）----
    // ⚠️ 日志刻意不写「猫抓」二字：数据源是可注入的 —— 早盘竞价/涨跌停走主账号（numcat-proxy），
    //    竞价一字走自己的小号（yizi_trend）。写死名字会让排查时误判是谁在烧额度。
    let legs = null;
    const tChan1 = Date.now();
    try {
        legs = await _withTimeout(
            _collectLegsViaNumcat(missing, winAsc, o.date, aucPctOf, fetchDailyRange),
            NUMCAT_TIMEOUT_MS,
            '通道一（逐日涨幅批量）'
        );
        _dbgLog(tag + ' ' + o.date + ' 通道一耗时 ' + (Date.now() - tChan1) + 'ms');
    } catch (e) {
        // 额度用尽（403）/ 网络异常 / 超时 —— 不阻断，转通道二。
        // fail-soft 只记日志（§10：读失败由调用方处理，本模块只负责「补」）。
        _dbgLog(tag + ' 通道一（逐日涨幅批量）不可用，转同花顺 K 线兜底（耗时 ' +
            (Date.now() - tChan1) + 'ms）: ' + (e && e.message || e));
    }

    // ---- 通道二：同花顺 K 线（仅兜底，且限制规模 + 限等待预算）----
    if (!legs || legs.targets.length === 0) {
        if (missing.length > KLINE_FALLBACK_MAX) {
            _dbgLog(tag + ' 通道一不可用且缺票 ' + missing.length + ' 只 > 上限 ' + KLINE_FALLBACK_MAX +
                ' 只 → 放弃逐只兜底（逐只单只 ~5s，跑完会让看板卡死数分钟）。' +
                '结果：这些票的十日涨幅显示 "-"，不参与龙头评选。');
            return localMap;
        }
        const tChan2 = Date.now();
        try {
            // ★ 2026-09-19：再套一层「等待预算」。KLINE_TIMEOUT_MS(45s) 是「硬上限」，
            //   而这里问的是「用户愿意为附加信息等多久」——答案是个位数秒。
            //   ⇒ 到点即放弃等待，看板立刻渲染（缺的票显示 '-'，有 rangeHint 如实提示）。
            legs = await _raceBudget(
                _withTimeout(
                    _collectLegsViaKline(missing, winAsc, o.date, aucPctOf, o.concurrency || 3),
                    KLINE_TIMEOUT_MS,
                    '通道二（同花顺 K 线）'
                ),
                KLINE_BUDGET_MS
            );
            if (!legs) {
                _dbgLog(tag + ' ' + o.date + ' 通道二（同花顺 K 线）超过等待预算 ' + KLINE_BUDGET_MS +
                    'ms → 本轮不再等待：这些票的十日涨幅显示 "-"（不参与龙头评选）');
            } else {
                _dbgLog(tag + ' ' + o.date + ' 通道二耗时 ' + (Date.now() - tChan2) + 'ms');
            }
        } catch (e) {
            _dbgLog(tag + ' 通道二（同花顺 K 线）也失败: ' + (e && e.message || e));
        }
    }
    if (!legs || legs.targets.length === 0) return localMap;

    const computed = buildRangeRows(legs.targets, winAsc, legs.dailyByCode, legs.tLegByCode);
    const fullRows = [];
    computed.forEach(function(r) {
        localMap.set(r.stock, { pct: r.pct, days: r.days });
        if (r.days === windowLen) fullRows.push({ stock: r.stock, pct: r.pct, days: r.days });
    });

    // [T-LEG GATE] 今天【未收盘】⇒ T 腿是竞价涨幅占位口径 ⇒ 【绝不回写云端】。
    //   缘由（与 §M 十日涨幅四闸门同源）：stock_range_pct 是按【日期级】复用的缓存，
    //   一旦把「含竞价占位腿」的值写进去，收盘后前端会因为「rangeMap 里已有该股」
    //   而永远跳过重算 → 十日涨幅被永久冻结在盘中口径（龙头排名随之系统性偏低）。
    //   盘中不写云只影响「缓存」，本次会话照样有值（localMap + getRangeFill 会话缓存兜住）。
    const auctionLeg = isAuctionLegActive(o.date, beijingTodayStr(), _beijingMinutes() >= CLOSE_HOUR * 60);
    if (fullRows.length > 0 && auctionLeg) {
        _dbgLog(tag + ' ' + o.date + ' 十日涨幅补算 ' + fullRows.length +
            ' 行，但当日未收盘（T 腿=竞价涨幅占位）→ 只留本地，不写云（收盘后重算再落库）');
    } else if (fullRows.length > 0) {
        try {
            // 落库只是「把缓存捂热」，但它是 await 的 —— 若 supabase 挂死同样会把看板
            // 卡在加载中，所以一并套超时闸门。失败/超时都只记日志（fail-soft，不影响展示）。
            await _withTimeout(
                upsertRangePctRows(o.date, fullRows),
                NUMCAT_TIMEOUT_MS,
                '十日涨幅落库'
            );
            _dbgLog(tag + ' ' + o.date + ' 十日涨幅补算并落库 ' + fullRows.length +
                ' 行（满窗 ' + windowLen + ' 日），本地另持残缺值 ' + (localMap.size - fullRows.length) + ' 条');
        } catch (e) {
            _dbgLog(tag + ' 十日涨幅落库失败（不影响展示）: ' + (e && e.message || e));
        }
    }
    return localMap;
}

// ============================================================================
// 会话内缓存 + 单飞（两个看板共用）
// ============================================================================
//
// 为什么必须有缓存（线上会直接看到的功能缺陷）：
//   `stock_range_pct` 只回写【满窗 + 已收盘】的行；缺腿的行（次新股 / 停牌）与
//   盘中那次补算都进不了云端。若每次都现补一次，那些票【只有当天第一次打开看板】
//   才有十日涨幅，第二次打开（切页切回来、切走再切回）就全变成 '-'。
//   ⛔ 这不是「缓存优化」，是「同一份输入必须得到同一份输出」的正确性问题。
//
// tried 按【股票】而非按【日期】记录：池子在会话内可能变大（同日自愈抓取补全、
// 题材导入后重算），按日期记录会让新增的票永远补不到。

/** date -> { map: Map<stock,{pct,days}>, tried: Set<stock> } */
const _cache = new Map();
/** date -> Promise（同一日期同时只跑一次补算，避免并发重复打上游） */
const _inflight = new Map();
/** 最多记住多少个日期的补算结果（看板一次只看一天，10 天足够覆盖来回切换） */
const _CACHE_MAX_DATES = 10;

function _touchDate(date, entry) {
    // LRU：重新插入到 Map 末尾（Map 保持插入序），超限时淘汰最久未用的日期
    _cache.delete(date);
    _cache.set(date, entry);
    while (_cache.size > _CACHE_MAX_DATES) {
        const oldest = _cache.keys().next().value;
        _cache.delete(oldest);
    }
}

/**
 * 取某日「本地补算」的十日涨幅（带会话内缓存 + 单飞 + 增量补）。
 *
 * 与 fillMissingRangePct 的区别：本函数可以安全地被反复调用（每次加载都会调）——
 * 已补过的票直接命中缓存，只对「云端没有 + 本会话没试过」的票发起补算请求。
 *
 * @param {object} opts 同 fillMissingRangePct（date / rows / rangeMap / codeOf / windowDates / aucPctOf / tag / concurrency）
 * @returns {Promise<Map<string,{pct:number|null,days:number}>>}
 */
export async function getRangeFill(opts) {
    const o = opts || {};
    const date = o.date;
    if (!date) return new Map();
    if (_inflight.has(date)) return _inflight.get(date);

    let entry = _cache.get(date);
    if (!entry) {
        entry = { map: new Map(), tried: new Set() };
        _cache.set(date, entry);
    }
    const promise = fillMissingRangePct(Object.assign({}, o, { tried: entry.tried }))
        .then(function(m) {
            m.forEach(function(v, k) { entry.map.set(k, v); });
            _touchDate(date, entry);
            return entry.map;
        })
        .finally(function() {
            _inflight.delete(date);
        });
    _inflight.set(date, promise);
    return promise;
}

/** 清空补算缓存（供题材库/日期相关的强制重算场景使用；一般不需要调） */
export function clearRangeFillCache() {
    _cache.clear();
}
