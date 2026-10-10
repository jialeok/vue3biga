// seal-volume.js — 「封单量 / 封单额」的换算与展示口径（Logic 层纯函数，§15 独立业务模块）
//
// ══ 数据来源（§6 单一真相 / ⛔ 不消费猫抓额度）══════════════════════════════════════
//   limit_pool 表（board='up'）的 seal_money（封单额，元）+ price（收盘价 = 涨停价，元/股）。
//   这张表由 Supabase Edge Function `limit-pool-fetch` 每交易日 15:40 用【同花顺 fuyao
//   limit-up-pool 接口】抓取落库 —— 该接口免费、不限累计次数、**0 猫爪额度**（§数据源矩阵）。
//   ⇒ 前端只是「读库 + 换算」，⛔ 不新增任何猫抓 apiname、不消耗任何调用次数。
//
// ══ 口径（用户 2026-10-11 拍板）═════════════════════════════════════════════════════
//   · 早盘竞价看板的统计条 / 五日趋势图：**封单量（手）**；
//   · 决策看板：**封单额（元 → 亿/万）** + 日变化；
//   · 「变化」= 今日 − 上一交易日，增加红 ↑ / 减少绿 ↓（A 股涨红跌绿口径）。
//
//   ⚠️ 封单量（手）= 封单额 ÷ 涨停价 ÷ 100：
//        封单额（元）÷ 价格（元/股）= 封单股数；÷ 100 = 手。
//      limit_pool 里【没有】封单量字段（同花顺上游只给 seal_money / max_seal_money），
//      所以必须换算 —— 换算需要 price，缺 price 或 price ≤ 0 ⇒ 算不出 ⇒ null（⛔ 不补 0）。
//
// ══ §10 红线 ══════════════════════════════════════════════════════════════════════
//   · 当日不是涨停（不在 limit_pool）⇒ 没有封单 ⇒ 该日 value = null，图上画「--」；
//     ⛔ 绝不用 0 冒充「封单为 0」——「没涨停 / 没抓到」与「封单是 0」是完全不同的两件事。
//   · 缺其中一天的封单 ⇒ 变化量算不出来 ⇒ 返回空串 / null ⇒ UI 整个不渲染（⛔ 不显示 +0）。
//   · 读取缓存里没有这一天 ⇒ 同步读值返回 null（= 没有这一行的数据），绝不返回一个全 0 的假行。
//
// ══ 边界（§4 / §32）═══════════════════════════════════════════════════════════════
//   · 本文件只读内存缓存、不发请求、不写库、不碰 DOM、不 import 任何组件；
//   · 「什么时候把 limit_pool 读进缓存」由组合式负责（ensureLimitPoolDays），纯函数只做同步取值。

import { getLimitPoolRow, hasLimitPoolDay, ensureLimitPoolDays } from '../../data/limit-pool.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
// 封单额（亿 / 万）与变化量（+3.20亿）的格式化早就有【唯一实现】，直接复用（§6 单一真相）：
//   · formatSealMoney       —— 「涨跌停」看板 / 「竞价一字」看板同款封单额展示；
//   · formatSealMoneyDelta  —— 「竞价一字」看板的 9:25−9:20 封单额变化量（★ 用户指定 `+20亿` 格式）；
//   · sealDeltaTone         —— 增加红 / 减少绿 / 无值灰（同一个口径，⛔ 不另写一套）。
//   ⛔ 不在这里重写一遍 —— 同一个数值在两个看板显示成不同格式是最容易被用户抓到的低级错误。
import { formatSealMoney } from '../topics/topic-block.js';
import { formatSealMoneyDelta, sealDeltaTone } from '../yizi/model.js';

/** 趋势图窗口：与早盘竞价看板那几张趋势图保持一致（近 5 个交易日）。 */
export const SEAL_TREND_DAYS = 5;

/** 变化方向 → 箭头符（UI 直接渲染，⛔ 模板不判断方向，§21） */
export const SEAL_ARROW_UP = '↑';
export const SEAL_ARROW_DOWN = '↓';

/** 序列取值说明：封单量序列的 value = 手、封单额序列的 value = 元；非涨停日 / 无数据一律 null（§10 ⛔ 不补 0）。 */

// ============================================================================
// 窗口取数（两个看板共用同一份实现，§6 单一真相）
// ============================================================================
//
// ⚠️ 为什么窗口是「展示日 + 往前 5 个交易日」共 6 天（而不是刚好 5 天）：
//   前 5 天 = 逐票「封单量五日趋势图」的窗口（与早盘竞价其它趋势图同窗口）；
//   再往前 1 天 = 上一交易日 —— 题材统计条的「封单变化」与决策看板的「封单额变化」都要用。
// ⚠️ 只走 getPreviousTradingDay（交易日历）：趋势图的横轴日期来自 getAuctionStockHistory，
//   它用的就是 getPreviousTradingDay —— 两处必须逐字相同，否则封单量的点会与横轴差一天。
// ⛔ 读取失败 ensureSealWindow 会 throw（§10 读取失败 ≠ 空数据），由调用方决定怎么呈现。

/**
 * 封单量所需的 limit_pool 窗口日期。
 * @param {string} endDate 展示日 YYYY-MM-DD
 * @param {number} [back] 往前几个交易日，默认 SEAL_TREND_DAYS；返回天数 = back + 1
 * @returns {string[]} 展示日在前
 */
export function sealWindowDates(endDate, back) {
    const n = _count(back === undefined ? SEAL_TREND_DAYS : back);
    const out = [];
    let d = endDate;
    for (let i = 0; i <= n; i++) {
        if (!d) break;
        out.push(d);
        d = getPreviousTradingDay(d);
    }
    return out;
}

/**
 * 窗口里是否还有没读进内存缓存的日子（false ⇒ 一个请求都不用发，§32）。
 *
 * ⚠️ 读取失败后的【冷却期】内也返回 false：本函数被挂在 `auction-refresh` 这类**高频事件**上
 *    （早盘 9:25 前后行情每动一下就会来一次）。若表缺失 / 权限不对（读取必然失败），
 *    不冷却就会「每来一个事件打一次必然失败的请求」—— 那正是 §32 要防的。
 *    冷却期内视为「暂时不需要读」；到期后自动重试（§10 未就绪 ≠ 没有，之后会自愈）。
 * @param {string} endDate
 * @param {number} [back]
 * @returns {boolean} true = 需要读库
 */
export function sealWindowPending(endDate, back) {
    if (_inFailCooldown()) return false;
    return sealWindowDates(endDate, back).some(function(d) { return !hasLimitPoolDay(d); });
}

/**
 * 确保封单量窗口已进 Data 层内存缓存（供上面那些【同步】读取器取值）。
 * ⛔ 不消费猫抓额度：limit_pool 由 Edge Function 15:40 用同花顺 fuyao 免费抓取落库，这里只读库。
 * ⚠️ 读取失败会 throw（由调用方决定怎么呈现，§10 读取失败 ≠ 空数据），并进入冷却期（见 sealWindowPending）。
 * @param {string} endDate
 * @param {number} [back]
 * @returns {Promise<string[]>} 已保证的日期列表
 */
export function ensureSealWindow(endDate, back) {
    if (!endDate || _inFailCooldown()) return Promise.resolve([]);
    return ensureLimitPoolDays(sealWindowDates(endDate, back)).catch(function(e) {
        _sealFailUntil = Date.now() + SEAL_FAIL_COOLDOWN_MS;
        throw e;
    });
}

/** 读取失败冷却（§32）：冷却期内不再自动重试，避免高频事件把必然失败的请求打爆 */
const SEAL_FAIL_COOLDOWN_MS = 60000;
let _sealFailUntil = 0;
function _inFailCooldown() { return Date.now() < _sealFailUntil; }

/**
 * 数值归一：null / 空串 / 非有限值 → null（§10 缺值 ≠ 0）。
 * @param {*} v
 * @returns {number|null}
 */
function _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/** 天数归一：非法 → 默认 5 */
function _count(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : SEAL_TREND_DAYS;
}

/**
 * 【纯函数】一行 limit_pool 行 → 封单量（手）。
 *
 * 封单量（手）= seal_money（元）÷ price（元/股）÷ 100。
 * 缺封单额 / 缺价格 / 价格 ≤ 0 ⇒ null（算不出来，⛔ 不补 0）。
 *
 * @param {object|null} row limit_pool 行（Data 层归一后的视图行）
 * @returns {number|null} 手（可为小数，展示时取整）
 */
export function sealLotsOfRow(row) {
    if (!row) return null;
    const money = _num(row.sealMoney);
    const price = _num(row.price);
    if (money === null || price === null || price <= 0) return null;
    return money / price / 100;
}

/**
 * 【同步读】某交易日某只股票的封单量（手）—— 从 Data 层内存缓存取，⛔ 不发请求。
 * §10：缓存里没有这一天 / 没这只票 / 该票当天没封单额 ⇒ null。
 * @param {string} date YYYY-MM-DD
 * @param {string} stock 股票名
 * @returns {number|null}
 */
export function sealLotsOf(date, stock) {
    return sealLotsOfRow(getLimitPoolRow(date, stock));
}

/**
 * 【同步读】某交易日某只股票的封单额（元）。
 * @param {string} date YYYY-MM-DD
 * @param {string} stock 股票名
 * @returns {number|null}
 */
export function sealMoneyOf(date, stock) {
    const row = getLimitPoolRow(date, stock);
    if (!row) return null;
    return _num(row.sealMoney);
}

/**
 * 【同步读】某交易日某只股票的池行（封单额 / 封单量 / 连板文案 / 峰值都在上面）。
 * @param {string} date
 * @param {string} stock
 * @returns {object|null}
 */
export function sealRowOf(date, stock) {
    return getLimitPoolRow(date, stock);
}

/**
 * 封单量展示文本（单位自适应，与 formatSealMoney 的「亿 / 万」分档同款观感）。
 *   · ≥ 1 万手 → '12.30万手'
 *   · < 1 万手 → '326手'（取整）
 *   · 无值 / 0  → ''（⛔ 不显示 '0手'，那会被读成「封单为 0」而非「没有这个数据」）
 * @param {number|null} lots 手
 * @returns {string}
 */
export function formatSealLots(lots) {
    const n = _num(lots);
    if (n === null || n === 0) return '';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万手';
    return sign + Math.round(abs) + '手';
}

/**
 * 封单量【变化量】展示文本（★ 用户口径：增加带向上箭头 / 减少带向下箭头，见 sealLotsDeltaArrowOf）。
 *   · 与 formatSealLots 的关系 = formatSealMoneyDelta 与 formatSealMoney 的关系：
 *     **必须带符号**（`+`/`-` 就是这条信息的主体），**0 要显示**（= 「两日封单一致」这个有效结论）。
 *   · 算不出来（任一天缺值）→ ''，由 UI 显示 `-`（§10 ⛔ 绝不伪造 0）。
 * @param {number|null} delta 今日封单量 − 上一交易日封单量（手）
 * @returns {string} 形如 '+1.05万手' / '-30手' / '0'
 */
export function formatSealLotsDelta(delta) {
    const n = _num(delta);
    if (n === null) return '';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : '-';
    // 分档与 formatSealLots 一致，保证「单值与变化量看着是同一量级」；
    // ⚠️ 不足 1 万手直接给「手」，避免出现 `+0.00万手` 这种「有变化却显示成 0」的自相矛盾。
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万手';
    return sign + Math.round(abs) + '手';
}

/**
 * 变化方向 → 配色档（★ 用户 2026-10-11：「增加用红色，减少用绿色」，A 股涨红跌绿口径）。
 * 无值 / 0 → ''（灰，⛔ 不把「没变化」涂成红或绿，也⛔ 不把「算不出来」当成「没变化」）。
 * @param {number|null} delta
 * @returns {'up'|'down'|''}
 */
export function sealLotsDeltaTone(delta) {
    const n = _num(delta);
    if (n === null || n === 0) return '';
    return n > 0 ? 'up' : 'down';
}

/**
 * 变化方向 → 箭头符（增加 ↑ / 减少 ↓ / 无变化或算不出 → ''）。
 * @param {number|null} delta
 * @returns {string}
 */
export function sealLotsDeltaArrowOf(delta) {
    const tone = sealLotsDeltaTone(delta);
    if (tone === 'up') return SEAL_ARROW_UP;
    if (tone === 'down') return SEAL_ARROW_DOWN;
    return '';
}

/**
 * 今日 vs 上一交易日封单量之差（手）。§10：任一天缺值 ⇒ null（算不出，⛔ 不当 0）。
 * @param {number|null} today
 * @param {number|null} prev
 * @returns {number|null}
 */
export function sealLotsDelta(today, prev) {
    const a = _num(today);
    const b = _num(prev);
    if (a === null || b === null) return null;
    return a - b;
}

/**
 * 取某只股票【近 count 个交易日】的封单量（手）序列，**正序**（早 → 晚）。
 * 窗口逐日走 getPreviousTradingDay（交易日历）⇒ 自动跳过假期 / 周末，与全站同一口径。
 * @param {string} stockName
 * @param {string} endDate 展示日 YYYY-MM-DD
 * @param {number} [count] 默认 SEAL_TREND_DAYS
 * @returns {Array<{date:string, value:number|null}>} value = 手；非涨停日 = null
 */
export function getSealLotsTrend(stockName, endDate, count) {
    const name = String(stockName || '').trim();
    const n = _count(count);
    if (!name || !endDate) return [];
    const days = [];
    let d = endDate;
    for (let i = 0; i < n; i++) {
        if (!d) break;
        days.push({ date: d, value: sealLotsOf(d, name) });
        d = getPreviousTradingDay(d);
    }
    days.reverse(); // 正序：从早到晚（与 getAuctionStockHistory / getVolRatioTrend 同款）
    return days;
}

/**
 * 【早盘竞价看板 · 逐票五日趋势图用】按【已有的 history 日期】取封单量点集。
 *
 * ⚠️ 为什么不自己走交易日历：趋势面板上那 5 张图（竞价量 / 昨日成交量 / 竞价量比 / 竞价涨幅 /
 *   涨幅）的横轴日期全部来自 useAuctionBoard#getAuctionStockHistory 的同一条 history。
 *   封单量图必须与它们**逐日对齐**，所以日期只认 history 给的 —— 自己再走一遍日历，
 *   一旦两处口径差一天（如 isTradingDay 过滤差异），图上就会出现一根「串位」的柱子。
 *
 * @param {Array<{date:string}>} history getAuctionStockHistory 的返回（正序）
 * @param {string} stockName
 * @returns {Array<{date:string, value:number|null}>} value = 手（取整）；非涨停日 = null
 */
export function sealLotsPointsOfHistory(history, stockName) {
    const name = String(stockName || '').trim();
    if (!name || !Array.isArray(history)) return [];
    return history.map(function(h) {
        const date = h && h.date ? h.date : '';
        if (!date) return { date: '', value: null };
        const lots = sealLotsOf(date, name);
        return { date: date, value: lots === null ? null : Math.round(lots) };
    });
}

/**
 * 整条封单量序列是否有任一有效点（false ⇒ 模板整块不渲染，§10 不画满屏「--」）。
 * @param {Array<{value:number|null}>} points
 * @returns {boolean}
 */
export function sealLotsHasData(points) {
    return Array.isArray(points) && points.some(function(p) { return p && p.value !== null; });
}

/**
 * 【早盘竞价看板 · 题材统计条用】一组股票的封单量合计 + 日变化。
 *
 * 口径（用户 2026-10-11）：
 *   · 合计 = 该题材【今日有封单量的股票】之和（手）；
 *   · 变化 = Σ (今日 − 上一交易日)，**只累加两天都有封单量的股票** ——
 *     首板股昨天没涨停（没有封单），把它算成「+今日封单」会把「新开板」读成「加单」，
 *     而用户要的是「**连板涨停后**的封单变化」。所以首板只进「合计」，不进「变化」。
 *   · §10：一只都拿不到封单量 ⇒ lots=null / text='' ⇒ 布局层整段不产出（⛔ 不显示 0手）。
 *
 * @param {Array<{sealLots?:number|null, sealLotsPrev?:number|null}>} entries 该题材的行（含灰行）
 * @returns {{lots:number|null, count:number, delta:number|null, deltaCount:number}}
 *   lots = 合计封单量（手），null = 一只都没有；
 *   count = 计入合计的股票数；
 *   delta = 合计变化量（手），null = 没有任何一只两天都有数据（⛔ 不显示 0）。
 */
export function summarizeSealLots(entries) {
    let lots = 0;
    let count = 0;
    let delta = 0;
    let deltaCount = 0;
    (Array.isArray(entries) ? entries : []).forEach(function(e) {
        if (!e) return;
        const today = _num(e.sealLots);
        if (today !== null) { lots += today; count++; }
        const prev = _num(e.sealLotsPrev);
        if (today !== null && prev !== null) { delta += (today - prev); deltaCount++; }
    });
    return {
        lots: count > 0 ? lots : null,
        count: count,
        delta: deltaCount > 0 ? delta : null,
        deltaCount: deltaCount
    };
}

// ============================================================================
// 决策看板：逐票「封单额 + 变化」（用户 2026-10-11 拍板口径 = 封单额，不是封单量）
// ============================================================================

/**
 * 取某只股票「今日 vs 上一交易日」的封单额变化（元）。
 * @param {string} stockName
 * @param {string} endDate 展示日
 * @returns {number|null} null = 任一天缺封单额（§10 算不出）
 */
export function getSealMoneyDelta(stockName, endDate) {
    const name = String(stockName || '').trim();
    if (!name || !endDate) return null;
    const prev = getPreviousTradingDay(endDate);
    if (!prev) return null;
    const today = sealMoneyOf(endDate, name);
    const before = sealMoneyOf(prev, name);
    if (today === null || before === null) return null;
    return today - before;
}

/**
 * 一次算好决策看板一行要的封单展示字段并挂到行对象上（§21 模板零计算）。
 *
 * 挂的字段（全部由 Logic 层给，模板只读不渲染判断）：
 *   · `sealMoneyText`    今日封单额文案，如 '3.20亿'；无值 / 0 ⇒ 空串 ⇒ 徽标不渲染（§10）
 *   · `sealDeltaText`    与上一交易日的变化量，如 '+1.10亿' / '-8500万'；算不出 ⇒ 空串
 *   · `sealDeltaTone`    变化配色档（'up' 增加红 / 'down' 减少绿），算不出 ⇒ 空串
 *   · `sealDeltaArrow`   '↑' / '↓' / ''（由 sealLotsDeltaArrowOf 同源给出）
 *   · `sealDeltaTitle`   悬停说明：写清「昨x亿 → 今y亿（+z）」；⛔ 不失真
 *   · `sealMaxMoneyText` 当日封单峰值，如 '4.30亿'（封单额最大值，判断板有多硬）
 *   · `sealContinueText` 连板文案（'首板' / '2连板' …），直接来自 limit_pool.continue_text
 *   · `sealContinueTag`  ★ 只在【真连板】（continueCnt ≥ 2）时给文案，否则空串 ——
 *                        用户口径「方便同步知道哪些股票是连板」⇒ 首板不必占位；
 *                        ⛔ 判断收在这里，模板只读不判断（§21 模板零计算）。
 *   · `sealContinueCnt`  连板天数（数字，1 = 首板）
 *
 * §10：当天没涨停（不在 limit_pool）⇒ 全部为空串 / null ⇒ 一枚徽标都不显示（⛔ 绝不猜）。
 *
 * @param {object} target 买点 pick / 卖点 item（须有 name）
 * @param {string} endDate 展示日
 * @returns {object} 同一个 target（便于链式写法）
 */
export function decorateSealFields(target, endDate) {
    if (!target) return target;
    const name = String(target.name || '').trim();
    if (!name) return target;
    const row = sealRowOf(endDate, name);
    const money = row ? _num(row.sealMoney) : null;
    const prevDate = getPreviousTradingDay(endDate);
    const prevMoney = prevDate ? sealMoneyOf(prevDate, name) : null;

    target.sealMoneyText = formatSealMoney(money);
    const delta = (money !== null && prevMoney !== null) ? (money - prevMoney) : null;
    const tone = delta === null ? '' : sealDeltaTone(delta);
    target.sealDeltaText = formatSealMoneyDelta(delta);
    // 'flat'（恰好 0，两日封单一致）⇒ 空串：**不涂色**（⛔ 涂红/绿都会给出错误方向暗示）。
    target.sealDeltaTone = tone === 'flat' ? '' : tone;
    target.sealDeltaArrow = delta === null ? '' : (delta > 0 ? SEAL_ARROW_UP : (delta < 0 ? SEAL_ARROW_DOWN : ''));
    target.sealDeltaTitle = _sealDeltaTitle(money, prevMoney, delta, endDate, prevDate);
    target.sealMaxMoneyText = row ? formatSealMoney(_num(row.maxSealMoney)) : '';
    const continueCnt = row ? _num(row.continueCnt) : null;
    const continueText = row && row.continueText ? String(row.continueText) : '';
    target.sealContinueText = continueText;
    target.sealContinueCnt = continueCnt;
    // ★ 只有【真连板】（≥ 2 连板）才出标签：首板（cnt = 1）满屏都是，标了没有信息量。
    target.sealContinueTag = (continueCnt !== null && continueCnt >= 2) ? continueText : '';
    return target;
}

/** 决策看板封单徽标的悬停说明（纯文案，⛔ 不参与任何判断） */
function _sealDeltaTitle(money, prevMoney, delta, endDate, prevDate) {
    if (money === null) return '今日没有封单额数据（当天未涨停 / limit_pool 尚未写入）';
    const bits = ['封单额 ' + formatSealMoney(money) + '（' + endDate + ' 收盘快照）'];
    if (delta === null) {
        bits.push('上一交易日（' + (prevDate || '—') + '）没有封单额数据 ⇒ 算不出变化（可能是首板）');
    } else {
        bits.push('上一交易日 ' + formatSealMoney(prevMoney) + ' → 今日 ' +
            formatSealMoney(money) + '（' + formatSealMoneyDelta(delta) + '）');
    }
    return bits.join('｜');
}
