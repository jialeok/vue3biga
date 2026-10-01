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
  return target;
}
