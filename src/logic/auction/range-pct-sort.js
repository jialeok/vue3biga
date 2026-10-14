// range-pct-sort.js — 「十日涨幅」toggle 专用排序纯函数（§15 独立业务模块，§6 单一真相）
//
// 产品口径（2026-10-14 用户口径）：
//   · 原「三天竞跌」toggle【整体下线】，开关位改为「十日涨幅」；
//   · 打开后：**全部股票**（龙头组 + 观察组 + 常规组，不分块）按「近 10 个交易日区间涨幅」
//     由高到低排成一条列表，并逐行标出该数值 —— 用户要一眼看出「市场总龙头是谁、哪只更强」。
//
// 数据源（§6 单一真相）：`dragon-rank.js#getDragonRangePct(date)` 返回的
//   `Map<股票名, { pct, days }>`（= 云端 `stock_range_pct`，与题材模式的龙一/龙二徽章、
//   决策看板排名【同一个来源同一个字段】）。本模块【只读】该 Map，⛔ 不请求、不落库、不评选。
//
// §10 宁缺勿错：缺数据的票 → `pct = null`，**一律置底**且不参与 pct 比较，
//   ⛔ 绝不补 0 参与排序（补 0 会让「没查到」的票凭空插到跌 5% 的票前面）。
//
// 本模块只含纯函数：无副作用、不依赖响应式状态，可独立单测。

/**
 * 读单只股票的「十日区间涨幅」。
 * @param {Map<string, {pct:number|null, days:number}>|null} rangeMap
 * @param {string} stockName
 * @returns {number|null} 数值（可为负）；Map 未加载 / 没有这只票 / pct 缺失或非法 → null
 */
export function readRangePct(rangeMap, stockName) {
  if (!rangeMap || !stockName) return null;
  const entry = rangeMap.get(String(stockName).trim());
  if (!entry) return null;
  const raw = entry.pct;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

/**
 * 按「十日区间涨幅」由高到低重排渲染顺序。
 *
 * @param {number[]} order 当前渲染顺序（renderList 的索引数组）
 * @param {Array<object>} rows renderList（索引 → 行对象，行需带 `stock`）
 * @param {Map<string, {pct:number|null, days:number}>|null} rangeMap 十日涨幅（可能未加载 → null）
 * @returns {number[]} 新的索引数组
 *
 * 排序键（三级，完全确定）：
 *   ① 有涨幅的在前、缺数据的置底（§10 缺数据不冒充 0 参与比较）；
 *   ② 同档内按 pct 由高到低；
 *   ③ pct 相同 / 都缺数据 → 保持原有相对顺序（稳定排序，不依赖引擎实现）。
 *
 * 性能（§19/§23）：pct 在排序**之前**一次性取出（单次遍历），
 *   ⛔ 不在比较器里做 Map 查找 / 字符串处理 —— 否则 n log n 次比较会被放大成 n log n 次解析。
 */
export function sortIndicesByRangePct(order, rows, rangeMap) {
  if (!order || order.length === 0) return [];
  const keyed = order.map(function(idx, pos) {
    const row = rows ? rows[idx] : null;
    const name = row && row.stock ? String(row.stock).trim() : '';
    return { idx: idx, pos: pos, pct: readRangePct(rangeMap, name) };
  });
  keyed.sort(function(a, b) {
    const aMissing = (a.pct === null);
    const bMissing = (b.pct === null);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;   // ① 缺数据置底
    if (!aMissing && b.pct !== a.pct) return b.pct - a.pct; // ② 由高到低
    return a.pos - b.pos;                                   // ③ 稳定
  });
  return keyed.map(function(k) { return k.idx; });
}
