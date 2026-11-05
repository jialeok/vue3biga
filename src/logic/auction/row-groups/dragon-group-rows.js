// row-groups/dragon-group-rows.js — 【龙头组】名册读取 + 壳行注入（唯一实现，§6）
//
// 【龙头组到底是什么】
//   展示日 D 的龙头组 = 名册中 `date = 前一交易日(D)` 的那批票（=「当天评出的龙头放到次日看」）。
//   用户口径（2026-09-14）：「昨天在正式列表中、今天不在，也要出现」。
//
// 【红线】
//   §6  本文件只「读名册 + 注入壳行」，⛔ 不做评选。评选唯一实现在 dragon-group.js。
//   §10 名册为 null（未加载 / 加载失败）⇒ 本次不产生龙头组，但**绝不用空列表伪装成
//       「今天没有龙头」** —— 调用方据 null 决定「不渲染区块」而不是「渲染一个空区块」。
//   §6  注入行只设 `dragonAutoAdded`，⛔ 刻意不设 obsAutoAdded：
//       它不是观察组行，两个 flag 混用会让「组归属」出现第二个判据。

import { getDragonLeadersForDisplay } from '../dragon-group.js';

/**
 * 读展示日的龙头名册。
 * @param {string} date 展示日
 * @returns {Map<string,{code?:string, topic?:string}>|null} null = 名册未就绪
 */
export function resolveDragonGroup(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  try {
    const m = getDragonLeadersForDisplay(d);
    if (m instanceof Map) return m;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 注入龙头组壳行（今日不在正式列表的龙头）。
 *
 * 当日云端有同名行（worker 9:25 会把龙头并入抓取名单 → market_metrics 有影子行）就复用行情字段，
 * 否则留空壳，后续 enrich / 数据层照常补。
 *
 * @param {Map<string,object>|null} group resolveDragonGroup 的返回
 * @param {object} reg createInjectionRegistry 的返回
 * @returns {number} 实际注入行数
 */
export function injectDragonRows(group, reg) {
  if (!group || !reg || typeof group.forEach !== 'function') return 0;
  const before = reg.rows.length;
  group.forEach(function(meta, name) {
    reg.pushShadow(name, meta, 'dragonAutoAdded');
  });
  return reg.rows.length - before;
}
