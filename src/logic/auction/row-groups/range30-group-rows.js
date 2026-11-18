// row-groups/range30-group-rows.js — 【30天补位】名册读取 + 壳行注入（唯一实现，§6）
//
// 【这一组为什么存在】
//   用户口径（2026-11-18 原话）：
//     「还有要最近多板看板的30日所有的股票，取前五进行补位，标签是30天，这个和20天补的逻辑差不多，
//      你看下怎么实现，可以参考20日补的。」
//   ⇒ 补的是「30 日涨幅前五里、今天看不见的票」，行上打「30天」标签与 20 日补位区分。
//
// 【与 range20-group-rows.js 的结构完全同构，但⛔ 不共用一份实现】
//   两组各自读自己的名册（range30-leaders.js / range20-leaders.js）。共用会把两套成员的评选口径
//   耦合在一起：日后改 20 日的评选规则时，30 日会静默跟着变（§37 影响范围审查）。
//   共用的只有注入登记器（registry.js，去重三条的唯一实现）。
//
// 【红线】
//   §6  只读 `getRange30Leaders` 的结论，⛔ 本文件不重算名次（评选在 range30-leaders.js）。
//   §10 名册为 null（该日还没有结论）与 `[]`（确实没有可补的）语义不同，都要如实透传；
//       ⛔ 不许用 `|| []` 抹平。
//   §6  注入只设 `range30AutoAdded`；去重三条（正式列表 / 已被别组认领 / 本组已注入）全由 registry 承担。

import { getRange30Leaders } from '../range30-leaders.js';

/**
 * 读展示日的「30日涨幅前五补位」名册。
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code?:string, pct:any, days:any}>|null} null = 该日还没有结论
 */
export function resolveRange30Group(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  try {
    const list = getRange30Leaders(d);
    if (list === null || list === undefined) return null;
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

/**
 * 注入 30 天补位壳行。
 *
 * @param {Array|null} group resolveRange30Group 的返回
 * @param {object} reg createInjectionRegistry 的返回
 * @returns {{injected:number, meta:Map<string,{pct:any,days:any}>}}
 *          `meta` 供区块行徽章与悬停文案显示（股票名 → 30日涨幅与天数）
 */
export function injectRange30Rows(group, reg) {
  const meta = new Map();
  if (!group || !reg || !Array.isArray(group)) return { injected: 0, meta: meta };
  const before = reg.rows.length;
  group.forEach(function(m) {
    const n = m && m.stock ? String(m.stock).trim() : '';
    if (!n) return;
    if (reg.has(n)) return;          // 已在正式列表 / 已被别组认领 ⇒ 用户「不用重复补」
    if (reg.pushShadow(n, m, 'range30AutoAdded')) {
      meta.set(n, { pct: m.pct, days: m.days });
    }
  });
  return { injected: reg.rows.length - before, meta: meta };
}
