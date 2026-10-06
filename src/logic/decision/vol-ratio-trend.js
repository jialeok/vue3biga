// vol-ratio-trend.js — 「决策」看板：竞价量比（auc_vol_ratio）近 5 个交易日趋势（Logic 层）
//
// ══ 为什么单独开一个文件（§15 业务模块标准结构）══
//   · decision-rules.js 是【纯函数】文件（不读 state、不发请求、不 import store）——
//     竞价量比要读内存真相（Data 层的只读选择器），塞进去会破坏它的契约；
//   · decision-collect.js 是「采集」文件 —— 再写一段取数进去只会让它继续膨胀（§16）。
//   所以：口径 + 展示视图集中在本文件，collect 只负责调用一次。
//
// ══ 数据来源（§6 单一真相：与早盘竞价看板【同一个字段、同一个选择器】）══
//   src/data/watchlist-helpers.js#getStockHistoryValue(date, name, 'aucVolRatio')
//     → 读 market_metrics(scope='auction') 的 auc_vol_ratio（存的是字符串，如 "2.18"）
//   早盘竞价看板趋势图里那行小字「竞价量比」用的就是它（useAuctionBoard#dailyAuctionMetrics），
//   ⛔ 本文件绝不另起一套取数口径，也绝不去猜字段。
//
// ══ 边界（§4 / §32）══
//   · 只读，不发请求、不落库、不消费猫抓额度；
//   · 不碰 DOM、不 import 任何组件（Data → UI 的反向依赖被禁止）。
//
// ══ §10 红线 ══
//   某天没有这一行 / 该字段为空 ⇒ 该天 value = null（图上画「--」），
//   ⛔ 不用 0 冒充「量比很小」；展示日缺值 ⇒ text 为空串 ⇒ UI 整个徽标不渲染。

import { getStockHistoryValue } from '../../data/watchlist-helpers.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';

/** 趋势图窗口：与早盘竞价看板趋势图保持一致（近 5 个交易日）。 */
export const VOL_RATIO_TREND_DAYS = 5;

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [VR-COMPARE 2026-10-02 用户口径] 「今日竞价量比 vs 上一交易日」的方向判定 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话（9/3 案例）：「竞价量比当天比昨日（上个交易日）下降…预测当天优势不是很好」
//   「上个交易日龙版传媒的竞价量比是 37.28，当天的是 36.71，差距不到 4，如果四舍五入基本是平的，
//     说明还没走弱；如果当天的是 30，四舍五入（保留整数）也就救不了，而且是竞价量比下降，
//     那就按原来的立刻出；但是差距不到 5 的话，就尾盘出」
//   「香江控股…从上交易日的 4.86 到当天的 2.78，四舍五入整数后相差…两个指标，说明要立刻出」
//
// ⇒ 判据 = 【两个值各自四舍五入到整数后作差】（用户明确点名「四舍五入（保留整数）」）：
//     差 ≥ +1 → 增强（UP）    差 = 0 → 基本平（FLAT）    差 ≤ -1 → 下降（DOWN）
//
// ⚠️ 为什么【必须用整数差、不能用「原始差 < 5」】：香江控股原始差只有 2.08（< 5），按原始差会被
//   判成「平」，但用户明确说它「明显要立刻出」；而整数差 round(4.86)-round(2.78) = 5-3 = 2 ≤ -1
//   → 下降，与用户口径一致。⇒ 阈值只能是「四舍五入后作差」，⛔ 不要改成原始差或百分比差。
//
// §10：任一天缺值 / 空串 / 非数字 → 返回空串（未知），⛔ 绝不当成「平」——
//   「没查到」与「量比没变化」是两件事，判错方向会直接给出相反的买卖建议。
/** 量比相对上一交易日【增强】（四舍五入整数差 ≥ +1） */
export const VR_DIR_UP = 'up';
/** 量比相对上一交易日【基本平】（四舍五入整数差 = 0） */
export const VR_DIR_FLAT = 'flat';
/** 量比相对上一交易日【下降】（四舍五入整数差 ≤ -1） */
export const VR_DIR_DOWN = 'down';
/** 方向 → 箭头符（UI 直接渲染，⛔ 模板不判断方向，§21） */
export const VR_ARROW_UP = '↑';
export const VR_ARROW_DOWN = '↓';

/**
 * 「今日 vs 上一交易日」竞价量比方向（纯函数，可单测）。
 * @param {*} today 今日原始值（字符串 / 数字 / null）
 * @param {*} prev  上一交易日原始值
 * @returns {'up'|'flat'|'down'|''} 空串 = 缺数据（§10 未知，不猜方向）
 */
export function compareVolRatioDirection(today, prev) {
  const a = _toNum(today);
  const b = _toNum(prev);
  if (a === null || b === null) return '';
  const d = Math.round(a) - Math.round(b);
  if (d > 0) return VR_DIR_UP;
  if (d < 0) return VR_DIR_DOWN;
  return VR_DIR_FLAT;
}

/** 方向 → 箭头符（UP ↑ / DOWN ↓ / 其余空串） */
export function volRatioArrowOf(dir) {
  if (dir === VR_DIR_UP) return VR_ARROW_UP;
  if (dir === VR_DIR_DOWN) return VR_ARROW_DOWN;
  return '';
}

/**
 * 方向 → 量比标签的【配色档】（[VR-COMPARE 2026-10-02 用户口径]）。
 *
 * 用户原话：「竞价量比当天比昨日（上个交易日）下降…在量比标签里文字右边那里添加向下箭头，
 *   【整个标签绿色】。如果竞价量比当天比昨日（上个交易日）增强，就是向上箭头，【整个标签红色】。」
 * ⇒ 配色沿用全站「涨红跌绿」：增强 = 红 / 下降 = 绿。
 *
 * ⚠️ 与【竞价涨幅】徽标（aucTone 复用 getAucOpenKind）的语义【刻意相反】方向的判定依据不同：
 *   竞价涨幅 >> 红 = 价格涨；量比 >> 红 = 量能【增强】。两者都符合「红 = 强 / 绿 = 弱」，⛔ 不是写反了。
 * ⚠️ 未知（''）/ 基本平（flat）⇒ 返回空串 ⇒ 模板回落默认靛蓝底（§10：不猜方向，
 *   也【不】给平档涂色 —— 用户口径里「平」既不是增强也不是下降，涂红/绿都会给错暗示）。
 * @param {'up'|'flat'|'down'|''} dir
 * @returns {'up'|'down'|''}
 */
export function volRatioToneOf(dir) {
  if (dir === VR_DIR_UP) return VR_DIR_UP;
  if (dir === VR_DIR_DOWN) return VR_DIR_DOWN;
  return '';
}

/**
 * 取某只股票「今日 vs 上一交易日」的竞价量比方向（读内存真相，§6 与 trend 同源同字段）。
 * ⚠️ 交易日窗口走 getPreviousTradingDay（交易日历）⇒ 自动跳过假期 / 周末，与全站同一口径。
 * @param {string} stockName
 * @param {string} endDate 展示日 YYYY-MM-DD
 * @returns {'up'|'flat'|'down'|''}
 */
export function getVolRatioDir(stockName, endDate) {
  const name = String(stockName || '').trim();
  if (!name || !endDate) return '';
  const prev = getPreviousTradingDay(endDate);
  if (!prev) return '';
  return compareVolRatioDirection(
    getStockHistoryValue(endDate, name, 'aucVolRatio'),
    getStockHistoryValue(prev, name, 'aucVolRatio')
  );
}


// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [DIVE-BUY 2026-10-07 用户口径 · 爱仕达 9/7] 「今日竞价量比 － 上一交易日」的【整数差】★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「中军选手竞价涨幅超过 7%……竞价量比比上个交易日多 30（一般不超过 20，这是个硬指标，
//   同比减少都不符合）……所以应该打上标签「下杀买（竞价异常）」」。
//
// ⇒ 判据口径与上面的【方向】（compareVolRatioDirection）【逐字节同源】：两个值各自四舍五入到整数
//   后再作差（用户 2026-10-02 明确点名「四舍五入（保留整数）」）。⛔ 不要改成「原始差」——
//   那样 101.89 vs 71.90 与 101.10 vs 71.90 会给出不同结论，与徽标上那个 ↑/↓ 的判断分叉（§6）。
//
// 与「倍数」（§SELL-SURGE）的区别：方向/差值回答「强了多少」，倍数回答「放大了几倍」——
//   三个口径各有用途，⛔ 不许互相替代（判据见 decision-rules#_isDiveBuyPick 的 ②）。
//
// §10：任一天缺值 / 空串 / 非数字 ⇒ 返回 null（未知），⛔ 绝不当成 0 参与比较 ——
//   「没查到」与「量比没增加」是两件事，后者会直接把「下杀买」判丢。
/**
 * 「今日 － 上一交易日」竞价量比【整数差】（纯函数，可单测）。
 * @param {*} today 今日原始值（字符串 / 数字 / null）
 * @param {*} prev  上一交易日原始值
 * @returns {number|null} 四舍五入后的整数差；null = 缺数据（§10 未知，不猜）
 */
export function compareVolRatioDelta(today, prev) {
  const a = _toNum(today);
  const b = _toNum(prev);
  if (a === null || b === null) return null;
  return Math.round(a) - Math.round(b);
}

/**
 * 取某只股票「今日 － 上一交易日」的竞价量比整数差（读内存真相，§6 与 getVolRatioDir 同源同字段）。
 * ⚠️ 交易日窗口走 getPreviousTradingDay（交易日历）⇒ 自动跳过假期 / 周末，与全站同一口径。
 * @param {string} stockName
 * @param {string} endDate 展示日 YYYY-MM-DD
 * @returns {number|null} null = 缺一天数据（§10 不猜）
 */
export function getVolRatioDelta(stockName, endDate) {
  const name = String(stockName || '').trim();
  if (!name || !endDate) return null;
  const prev = getPreviousTradingDay(endDate);
  if (!prev) return null;
  return compareVolRatioDelta(
    getStockHistoryValue(endDate, name, 'aucVolRatio'),
    getStockHistoryValue(prev, name, 'aucVolRatio')
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [SELL-SURGE 2026-10-03 用户口径] 「今日竞价量比 ÷ 上一交易日竞价量比」的倍数 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话（9/30 案例）：「房地产的新世联（世联行），竞价跌幅 -9.97%，竞价量比增加 5 倍以上，
//   这类就要耐心等待冲高，概率非常高，打标签【冲高就卖】」
//
// 实测核对（market_metrics.auc_vol_ratio）：
//   世联行 9-29 = 3.95 → 9-30 = 24.45 ⇒ 24.45 / 3.95 = 6.19 倍（≥ 5）⇒ 命中本档。
//
// ⇒ 判据 = 【今日 ÷ 上一交易日】的倍数（⛔ 不是整数差 —— 整数差只回答「方向」，
//    倍数才回答「放大了多少」；两者服务于不同规则，别混用）。
//
// §10：任一天缺值 / 为空 / 上一交易日量比为 0 或负数（除不出来）⇒ 返回 null（未知），
//   ⛔ 绝不当成 1 倍（= 没变化）—— 「没查到」与「量比没放大」是两件事。
/** 量比【暴增】倍数阈值：今日 ÷ 上一交易日 ≥ 此值 ⇒ 抢筹明显（用户口径「5 倍以上」） */
export const VR_SURGE_TIMES = 5;

/**
 * 「今日 ÷ 上一交易日」竞价量比倍数（纯函数，可单测）。
 * @param {*} today 今日原始值（字符串 / 数字 / null）
 * @param {*} prev  上一交易日原始值
 * @returns {number|null} 倍数（保留 2 位小数）；null = 缺数据 / 除不出来（§10 未知）
 */
export function compareVolRatioTimes(today, prev) {
  const a = _toNum(today);
  const b = _toNum(prev);
  if (a === null || b === null || b <= 0) return null;
  return Math.round((a / b) * 100) / 100;
}

/**
 * 倍数是否达到【暴增】档（§6：阈值只从 VR_SURGE_TIMES 取，⛔ 不各处写死 5）。
 * @param {number|null} times compareVolRatioTimes 的结果
 * @returns {boolean} null / 非数 ⇒ false（§10 未知 ≠ 暴增）
 */
export function isVolRatioSurge(times) {
  const t = Number(times);
  if (!isFinite(t) || t <= 0) return false;
  return t >= VR_SURGE_TIMES;
}

/**
 * 取某只股票「今日 ÷ 上一交易日」的竞价量比倍数（读内存真相，§6 与 getVolRatioDir 同源同字段）。
 * @param {string} stockName
 * @param {string} endDate 展示日 YYYY-MM-DD
 * @returns {number|null}
 */
export function getVolRatioTimes(stockName, endDate) {
  const name = String(stockName || '').trim();
  if (!name || !endDate) return null;
  const prev = getPreviousTradingDay(endDate);
  if (!prev) return null;
  return compareVolRatioTimes(
    getStockHistoryValue(endDate, name, 'aucVolRatio'),
    getStockHistoryValue(prev, name, 'aucVolRatio')
  );
}

/**
 * 字符串 → 数值；空串 / null / 非数字一律 → null（§10 缺数据 ≠ 0）。
 * @param {*} v
 * @returns {number|null}
 */
function _toNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/**
 * 把「每日原始 auc_vol_ratio」整理成趋势图 + 徽标所需的展示视图（**纯函数，可单测**）。
 *
 * @param {Array<{date:string, value:*}>} days 正序（早 → 晚）的原始序列
 * @returns {{points:Array<{date:string, value:number|null}>, hasData:boolean, text:string}}
 *   points   —— 直接喂 TrendChart 的点集（value=null 的天画「--」，不连线）
 *   hasData  —— 整条序列是否有任一有效点（false ⇒ 模板改画一行「暂无数据」说明，⛔ 不画满屏 '--'）
 *   text     —— 行内徽标文案，如「量比 2.18」；展示日缺值 ⇒ 空串（§10 不补 0.00）
 */
export function buildVolRatioView(days) {
  const points = (Array.isArray(days) ? days : []).map(function(d) {
    return {
      date: (d && d.date) ? String(d.date) : '',
      value: _toNum(d ? d.value : null)
    };
  });
  const hasData = points.some(function(p) { return p.value !== null; });
  const last = points.length > 0 ? points[points.length - 1] : null;
  const text = (last && last.value !== null)
    ? ('量比 ' + last.value.toFixed(2))
    : '';
  return { points: points, hasData: hasData, text: text };
}

/**
 * 取某只股票【近 count 个交易日】的竞价量比原始序列（含 endDate 当天），**正序**（早 → 晚）。
 * 窗口逐日走 getPreviousTradingDay（交易日历）⇒ 自动跳过假期 / 周末，与全站同一口径。
 *
 * @param {string} stockName 股票名（与 auction_watchlist / market_metrics 的 stock 同口径）
 * @param {string} endDate   展示日 YYYY-MM-DD（= 决策看板当前日期）
 * @param {number} [count]   天数，默认 VOL_RATIO_TREND_DAYS
 * @returns {Array<{date:string, value:*}>}
 */
export function getVolRatioTrend(stockName, endDate, count) {
  const name = String(stockName || '').trim();
  const n = Number(count) > 0 ? Math.floor(Number(count)) : VOL_RATIO_TREND_DAYS;
  if (!name || !endDate) return [];
  const days = [];
  let d = endDate;
  for (let i = 0; i < n; i++) {
    if (!d) break;
    days.push({ date: d, value: getStockHistoryValue(d, name, 'aucVolRatio') });
    d = getPreviousTradingDay(d);
  }
  days.reverse(); // 正序：从早到晚（与 getAuctionStockHistory 同款）
  return days;
}

/**
 * 一次算好 UI 需要的三个字段并挂到行对象上（§21 模板零计算）。
 * 挂的字段（全部由 Logic 层给，模板只读不判断）：
 *   · `volRatioTrend`    —— TrendChart 的点集
 *   · `volRatioHasData`  —— 有无有效点（决定画曲线还是画「暂无数据」）
 *   · `volRatioText`     —— 行内徽标文案（空串 = 不渲染）
 *
 * @param {object} target  买点 pick / 卖点 item（须有 name）
 * @param {string} endDate 展示日
 * @param {number} [count]
 * @returns {object} 同一个 target（便于链式写法）
 */
export function decorateVolRatioFields(target, endDate, count) {
  if (!target) return target;
  const name = String(target.name || '').trim();
  if (!name) return target;
  const view = buildVolRatioView(getVolRatioTrend(name, endDate, count));
  target.volRatioTrend = view.points;
  target.volRatioHasData = view.hasData;
  target.volRatioText = view.text;
  // [VR-COMPARE 2026-10-02] 方向 + 箭头：末点 = 今日、倒数第二点 = 上一交易日（trend 已按交易日历排好序）。
  //   ⛔ 与 collect 在规则层之前挂的 volRatioDir 用的是【同一个】compareVolRatioDirection，
  //     两处结果必然一致（§6 单一口径）；这里再算一次只是为了拿到 UI 要的箭头符。
  const pts = view.points;
  const todayP = pts.length >= 1 ? pts[pts.length - 1] : null;
  const prevP = pts.length >= 2 ? pts[pts.length - 2] : null;
  // ⚠️ 序列长度不足 2 时【不覆盖】上游已给的方向（上游可能是逐日查出来的，这里只是拿不到倒数第二点）
  if (pts.length >= 2) {
    target.volRatioDir = compareVolRatioDirection(todayP ? todayP.value : null, prevP ? prevP.value : null);
  } else if (target.volRatioDir === undefined) {
    target.volRatioDir = '';
  }
  target.volRatioArrow = volRatioArrowOf(target.volRatioDir);
  // [VR-COMPARE 2026-10-02 用户口径] 整标签配色档：增强 → 红 / 下降 → 绿 / 平或未知 → 空串（回落靛蓝底）。
  //   ⛔ 模板只做 `'dcb-vratio-' + tone` 拼接，不自己判方向（§21）。
  target.volRatioTone = volRatioToneOf(target.volRatioDir);
  return target;
}
