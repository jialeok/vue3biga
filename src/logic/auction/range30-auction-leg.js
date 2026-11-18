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

/** Map 的条数（非 Map / null ⇒ 0，§10 不抛错） */
function _sizeOfPct(m) {
  if (!m || typeof m.forEach !== 'function') return 0;
  let n = 0;
  m.forEach(function() { n++; });
  return n;
}

/**
 * 【纯函数】在【云端结果表】与【浏览器现算发布值】之间选一份更全的收盘口径 30 日涨幅源。
 *
 * ★★ [RULE-35-SRC 2026-11-19] 为什么需要它（这条判据本身就是那次事故的修复）：
 *   上一版写的是 `getRange30Pct(date) || await readRange30Rows(date)` —— **顺序反了**。
 *   `getRange30Pct` 是本会话浏览器现算的发布值，**可能是个空 Map**，而「空 Map」在 `||` 里
 *   也是真值 ⇒ 永远挡住结果表 ⇒ `buildAuctionLegBoard` 过滤后 0 只 ⇒ `ready=false`
 *   ⇒ 第三十五条永远「判不出」（11-17 / 11-18 两天现场）。
 *   ⚠️ node 侧探针从没跑过 `ensureRange30` ⇒ `getRange30Pct` 返回 null ⇒ 走结果表 ⇒ 371 行成功
 *     —— 这就是「本地能算、线上算不出」的全部原因（不是时序、不是部署、不是缓存）。
 *
 * 口径：**按条数取更全的那份**（不是简单换次序）——
 *   · 结果表齐 ⇒ 用结果表（云端落库的全市场真值，与 20 日版 `readRange20Rows` 同源同层级）；
 *   · 结果表缺 / 早上 9:40 前还没写 ⇒ 现算值更全 ⇒ 用现算兜底（⛔ 不是错值，是有胜于无）。
 * §10：两份都空 ⇒ **null**（判不出），⛔ 绝不返回空 Map 冒充「这天没有 30 日龙头」。
 *
 * @param {Map|null} rows       `readRange30Rows(date)` 的结果（带 leg，云端真值）
 * @param {Map|null} published  `getRange30Pct(date)` 的结果（不带 leg，浏览器现算）
 * @returns {Map|null}
 */
export function pickCloseRange30Source(rows, published) {
  const nRows = _sizeOfPct(rows);
  const nPub = _sizeOfPct(published);
  if (nRows >= nPub && nRows > 0) return rows;
  if (nPub > 0) return published;
  return null;
}

async function _fetch(date) {
  // ★★ [RULE-35-SRC 2026-11-19 用户报障「还是一样啊…刷新好几次了」] 数据源优先级修正 + 加固。
  //
  //   🔴 上一版写的是 `getRange30Pct(date) || await readRange30Rows(date)` —— **顺序反了**：
  //     · `readRange30Rows` = 云端 9:40/16:20 落库的**全市场结果表真值**（带 `leg` 字段，
  //       11-17 实测 371 行 / 11-18 364 行）；与 20 日版 `range20-auction-leg.js#_fetch`
  //       用的 `readRange20Rows` **完全同源同层级**；
  //     · `getRange30Pct`  = 本会话【浏览器现算】的发布结果（`range30.js#_state.map`），
  //       它可能是 **null / 空 Map / 只有粗筛候选池那 286 只**（30天补的池），而且**不带 `leg`**。
  //   把它放在 `||` 第一位 ⇒ 只要本会话为这一天发布过（哪怕发布的是**空 Map**，空 Map 仍是真值），
  //   就**永远不会去看结果表** ⇒ `buildAuctionLegBoard` 过滤后 `keep.length === 0`
  //   ⇒ `empty('no-mainboard-rows')` ⇒ `ready=false` ⇒ 第三十五条永远走「判不出」。
  //
  //   ✅ 这正好解释了「node 能算、线上算不出」：node 探针从没跑过 `ensureRange30`
  //     ⇒ `getRange30Pct` 返回 null ⇒ 走结果表 ⇒ 371 行 ⇒ ready=true；
  //     而浏览器里只要打开过「30日涨幅」toggle（或任何链路为这天跑过 ensureRange30），
  //     就有一个（可能为空的）发布值挡在前面。用户反复刷新也不会变好 —— 因为它不是时序问题。
  //
  //   ⇒ 选源判据抽成纯函数 `pickCloseRange30Source`（§15 可单测），这里只负责取数 + 反解。
  const rows = await readRange30Rows(date);
  const published = getRange30Pct(date);
  const closeMap = pickCloseRange30Source(rows, published);
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
