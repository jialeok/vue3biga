// row-groups/range20-group-rows.js — 【20日补位】名册读取 + 壳行注入（唯一实现，§6）
//
// 【这一组为什么存在】
//   用户口径（2026-10-19）原话：
//     「当天我怕错过一些不在正式列表的市场龙头……比如今天的九阳股份，如果它不是继承上交易的
//      龙头组，就消失了，我就看不见了……如果消失了，我看这个20天涨幅就没多大意义，就不准确。」
//     「如果这五只也在当天列表中，那就不用重复补了……要自动补上去，补到龙头组……
//      要区分，就在后面添加标签"20天"。」
//   ⇒ 补的是「20 日涨幅前五里、今天看不见的票」，且必须能打「20天」标签区分。
//
// 【红线】
//   §6  只读 `getRange20LeadersForAuctionBoard` 的结论，⛔ 本文件不重算名次（评选在 range20-leaders.js）。
//   §10 名册为 null（该日还没有结论）与 `[]`（确实没有可补的）语义不同，都要如实透传；
//       ⛔ 不许用 `|| []` 抹平。
//   §6  注入只设 `range20AutoAdded`；去重三条（正式列表 / 已被龙头组认领 / 本组已注入）
//       全部由 registry 承担，本文件不再自己判一遍。
//
// ★★ [BOARD-AUC-MEMBERS 2026-11-11 用户 P0] **名册源必须是「竞价口径成员榜」**，
//   ⛔ 不是 `getRange20Leaders`（按当前 legMode 评选，15:00 后切收盘口径）。
//   事故：11-11 山东青岛食品（001219）竞价口径 93.57% 排第 4、收盘口径 75.14% 掉到第 8
//   ⇒ 盘后打开看板时前五不含它 ⇒ 不注入 ⇒ 20日涨幅 toggle 里彻底消失。
//   用户原话：「我打开早盘竞价看板20日toggle，还是没有看到青岛食品显示出来啊……
//     没有竞价量比但有竞价涨幅也要显示啊，而不是删除」。
//   补位区块的**存在意义就是早盘竞价那一眼别错过龙头** ⇒ 成员必须是竞价时点定下来的那一批，
//   收盘后不得重排（用户最高口径：「每天收盘后不要改变竞价期间的结论」）。

import { getRange20LeadersForAuctionBoard } from '../range20-leaders.js';

/**
 * 读展示日的「20日涨幅前五补位」名册 —— **恒竞价口径**（见文件头 [BOARD-AUC-MEMBERS]）。
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code?:string, pct:any, days:any}>|null} null = 该日还没有结论
 */
export function resolveRange20Group(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  try {
    const list = getRange20LeadersForAuctionBoard(d);
    if (list === null || list === undefined) return null;
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

/**
 * 注入 20日补位壳行。
 *
 * @param {Array|null} group resolveRange20Group 的返回
 * @param {object} reg createInjectionRegistry 的返回
 * @returns {{injected:number, meta:Map<string,{pct:any,days:any}>}}
 *          `meta` 供区块标题/行徽章显示（股票名 → 20日涨幅与天数）
 */
export function injectRange20Rows(group, reg) {
  const meta = new Map();
  if (!group || !reg || !Array.isArray(group)) return { injected: 0, meta: meta };
  const before = reg.rows.length;
  group.forEach(function(m) {
    const n = m && m.stock ? String(m.stock).trim() : '';
    if (!n) return;
    if (reg.has(n)) return;          // 已在正式列表 / 已被龙头组认领 ⇒ 用户「不用重复补」
    if (reg.pushShadow(n, m, 'range20AutoAdded')) {
      meta.set(n, { pct: m.pct, days: m.days });
    }
  });
  return { injected: reg.rows.length - before, meta: meta };
}
