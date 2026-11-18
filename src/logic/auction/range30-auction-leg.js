// range30-auction-leg.js — 「30日涨幅 · 9:26 竞价口径」的唯一数据出口（Logic 层，§2 / §5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-18）：「30日涨幅和20日涨幅功能差不多，有竞价口径和收盘口径，要注意下。」
// ══════════════════════════════════════════════════════════════════════════════════════
// 两种口径的差别【只有今天那一根腿】：
//   · 收盘口径 = 期末收盘 / 期初前收盘 − 1（range30.js，落库 leg='close'）；
//   · 竞价口径 = 把今天那根【收盘腿】换回 9:25【竞价腿】，其余 29 根不动。
//
// 反解实现【不另写】：`auction-leg-pct.js#buildAuctionLegPctMap`（十日 / 二十日同一个函数，
//   内部走 `range-window.js#recoverAuctionLeg`）⇒ §6 一把尺子，⛔ 这里不许出现第二套换算。
//   ⇒ 早上还没收盘覆盖时反解前提不成立 ⇒ 原样返回 ⇒ 两套口径数值自然相同
//     （这正是十日/二十日 toggle 的既有行为，30 日与之逐字一致）。
//
// 红线：
//   §10 结果表不可用 / 指标行读不到 ⇒ 返回 **null**（判不出），⛔ 绝不拿收盘口径顶替
//       （那等于拿错口径冒充对口径）。
//   §11 开关关着时不调用（由调用方 ensureAuctionLegRanges 统一门控，本模块不发任何主动请求）。
//   §32 按日期会话缓存 + 单飞，同一天最多一次（底层两个读取器自己也带缓存）。

import { readRange30Rows } from '../../data/stock-range30-cache.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { buildAuctionLegPctMap } from './auction-leg-pct.js';
import { getRange30Pct } from './range30.js';

/** date -> Map<名, {pct,days}> | null（null = 判不出，与既有实现同口径） */
const _cache = new Map();
/** 单飞：date -> Promise<Map|null> */
const _inflight = new Map();

async function _fetch(date) {
  // 收盘口径优先取【已发布的现算结果】（同一次 ensureRange30 的产出，含刚拉到的 K 线值）；
  // 没发布过（例如用户只开了竞价口径）⇒ 退到结果表；两者都不行 ⇒ null（§10 判不出）。
  const published = getRange30Pct(date);
  const closeMap = published || await readRange30Rows(date);
  if (!closeMap) return null;
  const metricRows = await readMarketMetricsForDate(date, 'auction');
  return buildAuctionLegPctMap(closeMap, metricRows);
}

/**
 * 读取某日【9:26 竞价口径】的 30 日涨幅（全市场）。
 *
 * @param {string} date YYYY-MM-DD（展示日）
 * @returns {Promise<Map<string,{pct:number,days:number}>|null>} null = 判不出（调用方据此不显示数值）
 */
export function readAuctionLegRange30Pct(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(null);
  const hit = _cache.get(d);
  if (hit !== undefined) return Promise.resolve(hit);
  const fly = _inflight.get(d);
  if (fly) return fly;
  const p = _fetch(d).then(function (map) {
    // ⚠️ null 也缓存：它表示「加速层不可用」这个稳定条件（与 range20-auction-leg 逐字同款）。
    //    抛错不缓存（§10：一次失败不能被记成「这天判不出」的永久结论）。
    _cache.set(d, map);
    return map;
  }).catch(function () {
    return null;
  }).finally(function () {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用） */
export function clearAuctionLegRange30Cache() {
  _cache.clear();
  _inflight.clear();
}
