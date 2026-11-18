// range30-math.js — 「30日涨幅」的**纯计算**（Logic 层，§6 单一真相 / §15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么单独拆这个文件（2026-11-18 用户口径「要云端运行」）
// ══════════════════════════════════════════════════════════════════════════════════════
//   30 日涨幅原来只有前端一份实现（range30.js），而那份文件顶部 import 了 vue / Supabase
//   ⇒ Cloudflare Worker（workers/bidding-auto-fetch）**不能 import 它**（会把浏览器依赖打进 worker）。
//   结果就是：这份数值只能靠「用户手机上的浏览器」现打腾讯接口现算 ——
//     一旦手机网络到不了腾讯（或腾讯 WAF 收口），整列就空白，且关掉电脑/换设备都救不回来。
//   ⇒ 把**数学部分**（窗口构造 / 停牌等价取值 / 一次性比值）抽到这里：零 import、纯函数。
//     · 前端 `range30.js`   → import 本文件（日历由它自己出）
//     · 云端 `range30-cloud.js` → 直接 import 本文件（日历由 worker 的交易日历出）
//   ⛔ 任何一处算 30 日涨幅的地方都必须走这里，别再复制第二份公式。
//
// ── 口径（用户拍板，⛔ 别改回逐日连乘）────────────────────────────────────────────────
//   N 日区间涨幅 = 期末收盘价 / 期初前收盘价 − 1。
//   数学上与逐日复利连乘完全等价（中间项全部约掉），但少一层「逐日两位小数」的舍入误差。
//   实测：新华传媒 600825（10-28，窗口 09-09~10-28）5.31 → 14.81 = **+178.91%**，两法一致。
//
// ── 窗口 ────────────────────────────────────────────────────────────────────────────
//   含 asOf 在内往前数 30 个【交易日】；baseDate = 窗口首日的【前一个交易日】。
//   停牌等价：取「≤ 目标日的最后一个 bar」（停牌期间前收盘不变）。
//   ⛔ 次新股（上市日在窗口内）取不到 baseBar ⇒ 不出值（绝不拿上市首日凑数）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10 算不出 ⇒ **null**（⛔ 绝不补 0）：次新股 / 窗口内有成交的腿数不足 / 缺基准价或期末价。

/** 窗口长度：含当天在内的 30 个交易日 */
export const RANGE30_WINDOW_DAYS = 30;

/**
 * 可信门槛：窗口内至少这么多根成交腿才算得出可信的 30 日涨幅。
 * 与二十日门槛同比例（RANGE20 是 6/20 = 30%）⇒ 30 日对应 10/30 ≈ 33%。
 * ⚠️ 别拍脑袋调大：长期停牌的票（实测新华传媒 30 日窗口内只有 19 根腿）必须仍能出值。
 */
export const RANGE30_MIN_LEGS = 10;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 【纯函数】K 线标准化：只留 close>0 的合法 bar，按日期升序、同日去重（后者优先）
 * @param {Array<{ymd:string, close:number}>} bars
 * @returns {Array<{ymd:string, close:number}>}
 */
export function normalizeBars(bars) {
  const byDate = new Map();
  (bars || []).forEach(function (b) {
    if (!b) return;
    const ymd = String(b.ymd || '').slice(0, 10);
    if (!YMD_RE.test(ymd)) return;
    const close = Number(b.close);
    if (!isFinite(close) || close <= 0) return;
    byDate.set(ymd, { ymd: ymd, close: close });
  });
  return Array.from(byDate.values()).sort(function (a, b) {
    return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0);
  });
}

/** 【纯函数】取「≤ ymd 的最后一个 bar」（停牌期间前收盘不变 ⇒ 等价于当日收盘） */
export function barOnOrBefore(series, ymd) {
  if (!ymd || !Array.isArray(series)) return null;
  let out = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].ymd <= ymd) out = series[i];
    else break;
  }
  return out;
}

/**
 * 【纯函数】用**调用方给的交易日序列**构造窗口（日历是入参，不在本文件里读任何数据源）。
 *
 * @param {string[]} tradingDays 升序交易日（至少含 asOf 之前的 30 个）；允许含 asOf 之后的日期
 * @param {string} asOf 窗口末日
 * @param {number} [n] 窗口交易日数，默认 30
 * @returns {{dates:string[], start:string, end:string, baseDate:string}|null}
 *          end = ≤ asOf 的最后一个交易日（asOf 非交易日自动退到最近交易日）
 *          baseDate = 窗口首日的前一个交易日；历史尽头取不到 ⇒ ''
 */
export function windowFromTradingDays(tradingDays, asOf, n) {
  const want = Math.max(1, Number(n) || RANGE30_WINDOW_DAYS);
  const end = String(asOf || '').slice(0, 10);
  if (!YMD_RE.test(end)) return null;
  const days = (tradingDays || []).filter(function (d) {
    return YMD_RE.test(String(d || ''));
  }).map(function (d) { return String(d).slice(0, 10); });
  if (days.length < want) return null;
  // 升序假定：调用方（前端交易日历 / worker getRecentTradingDays）都保证
  let endIdx = -1;
  for (let i = 0; i < days.length; i++) {
    if (days[i] <= end) endIdx = i;
    else break;
  }
  if (endIdx < 0) return null;
  const startIdx = endIdx - want + 1;
  if (startIdx < 0) return null;
  const baseIdx = startIdx - 1;
  return {
    dates: days.slice(startIdx, endIdx + 1),
    start: days[startIdx],
    end: days[endIdx],
    baseDate: baseIdx >= 0 ? days[baseIdx] : ''
  };
}

/**
 * 【纯函数】在已构造好的窗口里算 30 日涨幅（一次性比值）。
 *
 * @param {Array<{ymd:string, close:number}>} bars 该票日 K（任意顺序；内部会标准化）
 * @param {{dates:string[], start:string, end:string, baseDate:string}} win
 * @param {{minLegs?:number}} [opts]
 * @returns {{pct:number, days:number, start:string, end:string,
 *            baseDate:string, baseClose:number, endDate:string, endClose:number}|null}
 *          null = 判不出（§10：次新股 / 腿数不足 / 缺基准价，⛔ 一律不补 0）
 */
export function range30InWindow(bars, win, opts) {
  if (!win || !win.baseDate || !win.start || !win.end) return null;
  const o = opts || {};
  const series = normalizeBars(bars);
  if (series.length === 0) return null;

  const endBar = barOnOrBefore(series, win.end);
  const baseBar = barOnOrBefore(series, win.baseDate);
  // ① 拿不到基准 / 期末价 ⇒ 判不出。
  //   ★ 次新股天然落在这里：它的 K 线从上市日开始，`barOnOrBefore(baseDate)` 找不到任何 bar
  //     ⇒ baseBar=null ⇒ 直接不出值。⛔ 绝不拿「上市首日」当 30 日前的基准凑数（那不是 30 日涨幅）。
  if (!endBar || !baseBar) return null;
  // ② 期初与期末是同一根 bar（区间内完全没有成交）⇒ 判不出（⛔ 不返回 0%）
  if (endBar.ymd <= baseBar.ymd) return null;

  // ③ 腿数门槛：窗口内实际有成交的根数（停牌 / 次新股会 < 30）
  let legs = 0;
  for (let i = 0; i < series.length; i++) {
    const d = series[i].ymd;
    if (d >= win.start && d <= win.end) legs++;
  }
  const minLegs = (o.minLegs === undefined || o.minLegs === null) ? RANGE30_MIN_LEGS : Number(o.minLegs);
  if (isFinite(minLegs) && minLegs > 0 && legs < minLegs) return null;

  const pct = (endBar.close / baseBar.close - 1) * 100;
  if (!isFinite(pct)) return null;
  return {
    pct: pct,
    days: legs,
    start: win.start,
    end: win.end,
    baseDate: baseBar.ymd,
    baseClose: baseBar.close,
    endDate: endBar.ymd,
    endClose: endBar.close
  };
}
