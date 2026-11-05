// row-groups/index.js — 四组行的**唯一装配口**（Logic 层，§6 / §15）
//
// 【四组是哪四组】
//   常规组  、观察组 、龙头组 、20日补位
//   用户口径：「列表里面有正式成员、龙头组、观察组、20日补的，要分清楚啊」
//              「四组互斥且相加 = 合计」
//
// 【为什么拆成四个文件】
//   用户原话（2026-11-05）：「这四组你可以为他们拆成四个组件，这样哪个组件出现问题就修复哪个，
//     不要理到一起乱战」「不要把所以的逻辑和功能都挤到一个文件里」。
//   之前四组的成员判定 + 壳行注入 + 去重全挤在 `view-helpers.js#computeAuctionViewData`
//   这一个 1170 行的函数里，加一个组就要动那段，任何一组出问题都只能整段读。
//
// 【本文件只做三件事】
//   ① 按固定顺序调三组注入（顺序是语义的一部分，见下）；
//   ② 把四组的「成员/名册/元信息」原样交回调用方；
//   ③ 不重算任何判据 —— 成员判定在各组自己的文件里，去重在 registry.js 里（§6 单一真相）。
//
// 【注入顺序：观察组 → 龙头组 → 20日补位（与拆分前逐字一致，⛔ 别改）】
//   为什么观察组在前：它的集合最大（前日竞昨高光全集），先认领可以保证「已在观察组的票」
//   不会再被造一份龙头组壳行 —— 一只票只能有一行，否则「四组相加 ≠ 行数」。
//   而**最终显示在哪个区块**不由这里的顺序决定：索引层会把龙头行从观察组里剔出去
//   （旧代码原话「去重：龙头不进观察组」）⇒ 真正优先的是龙头组。
//   ⚠️ 也就是说：注入顺序决定「谁认领这一行」，索引层决定「显示在哪个区块」，两件事分开。
//   本次拆分只搬代码不改顺序 —— 顺序一改就是归属变化，必须走单独验证。
//
// 返回值的 `obs` / `dragon` / `range20` 是各组的**名册原件**，
// 索引层后面的分栏判定直接读它们（⛔ 不要在这里预先筛成「已注入的票」）。

import { createInjectionRegistry } from './registry.js';
import { resolveObsGroup, injectObsRows } from './obs-group.js';
import { resolveDragonGroup, injectDragonRows } from './dragon-group-rows.js';
import { resolveRange20Group, injectRange20Rows } from './range20-group-rows.js';

/**
 * 装配四组行。
 *
 * @param {object} opts
 * @param {string} opts.date        展示日
 * @param {string} opts.prevDate    前一交易日
 * @param {string} [opts.dataSource] 'auction' | 'hot'
 * @param {Array}  opts.list        当日正式列表（auctionList = getTodayGroupList 的结果）
 * @param {Map<string,object>} opts.dayRowMap 当日云端行（股票名 → 影子行）
 * @param {Function} [opts.codeOf]  名称 → 6 位代码
 * @returns {{
 *   injectedRows: Array<object>,
 *   renderList: Array<object>,
 *   obs: object,            // { set, boughtSet, isMember }
 *   dragon: Map|null,       // 龙头名册
 *   range20: Array|null,    // 20日补位名册
 *   range20Meta: Map,
 *   existingNames: Set<string>,
 *   injectedNames: Set<string>
 * }}
 */
export function collectRowGroups(opts) {
  const o = opts || {};
  const list = Array.isArray(o.list) ? o.list : [];
  const date = String(o.date || '').trim();
  const prevDate = String(o.prevDate || '').trim();

  // ★ 三组名册必须在注入之前一次读完（都是同步读 ref / 内存缓存，不发请求）
  const obs = resolveObsGroup({ date: date, prevDate: prevDate, dataSource: o.dataSource });
  const dragon = resolveDragonGroup(date);
  const range20 = resolveRange20Group(date);

  const reg = createInjectionRegistry({
    list: list,
    dayRowMap: o.dayRowMap,
    codeOf: o.codeOf,
  });

  // 顺序 = 与拆分前逐字一致（观察组 → 龙头组 → 20日补位），见文件头说明
  injectObsRows(obs, reg);
  injectDragonRows(dragon, reg);
  const r20 = injectRange20Rows(range20, reg);

  const injectedRows = reg.rows;
  return {
    injectedRows: injectedRows,
    // renderList 仅服务视图渲染；真实业务数据 list 保持不变，统计口径仍基于 list。
    renderList: injectedRows.length ? list.concat(injectedRows) : list,
    obs: obs,
    dragon: dragon,
    range20: range20,
    range20Meta: r20.meta,
    existingNames: reg.existingNames,
    injectedNames: reg.injectNames,
  };
}
