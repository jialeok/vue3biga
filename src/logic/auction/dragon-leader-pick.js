// dragon-leader-pick.js — 「龙头组」评选的【纯函数】（零依赖叶子模块，§15 模块结构 / §I 解环约定）
//
// 为什么单独成文件：
//   ① §6 单一真相：评选口径（成员门槛 + 取区间涨幅最高）必须只有一份实现，前端展示与 worker
//      并入的名单同源，规则一改必同步；
//   ② 可测：纯函数可直接单测（dragon-leader-pick.test.js），无需 mock 云端；
//   ③ 解环：dragon-group.js 会 import vue / DB / 题材分组等重依赖，把「纯判定」下沉到零依赖叶子，
//      避免测试与 worker 打包被牵连。
// ⚠️ 本文件必须保持【零 import】：任何 import 都会把依赖图带进测试与 worker 单文件产物。

/**
 * 为每个「成员 >= minSize」的题材选出【唯一一只】龙头 = 该题材内「近 10 个交易日区间涨幅」最高者。
 *
 * 边界（刻意的「宁缺勿错」，§10 精神）：
 *   · 题材成员 < minSize → 不评选（需求：三只及以上才选龙头）；
 *   · 某成员在区间涨幅表里【无值/非数】→ 跳过它，绝不当 0 参与比较
 *     （否则「没数据」会被当成 0 涨幅选成龙头）；
 *   · 一个题材内所有成员都无值 → 该题材本次无龙头（不产出、不写空行）；
 *   · 同幅 → 取分组顺序中先出现的（稳定，不引入额外随机性）。
 *
 * @param {Array<{topic:string, stocks:Array<{stock:string, code?:string}>}>} groups 题材分组（getTopicGroups 输出）
 * @param {Map<string,{pct:number|null}>} rpMap 股票名 → {pct}（近 10 日区间涨幅，来自 stock_range_pct）
 * @param {number} minSize 评选门槛（DRAGON_GROUP_MIN_SIZE）
 * @param {(name:string)=>string} [resolveCode] 缺 code 时的兜底解析（由调用方注入，避免本文件依赖代码映射表）
 * @returns {Array<{topic:string, stock:string, code:string, pct:number, groupSize:number}>}
 */
export function pickTopicLeaders(groups, rpMap, minSize, resolveCode) {
  const picked = [];
  (groups || []).forEach(function(g) {
    const stocks = (g && g.stocks) || [];
    if (stocks.length < minSize) return;          // 需求：三只及以上才选龙头
    let best = null;
    stocks.forEach(function(s) {
      const nm = s && s.stock ? String(s.stock).trim() : '';
      if (!nm) return;
      const entry = rpMap ? rpMap.get(nm) : null;
      const pct = entry ? entry.pct : null;
      if (pct === null || pct === undefined || isNaN(pct)) return;  // 无值 → 不参与（禁止当 0）
      if (!best || pct > best.pct) {
        best = {
          topic: g.topic,
          stock: nm,
          code: (s && s.code) || (resolveCode ? (resolveCode(nm) || '') : ''),
          pct: pct,
          groupSize: stocks.length
        };
      }
    });
    if (best) picked.push(best);
  });
  return picked;
}
