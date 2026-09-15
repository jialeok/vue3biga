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
 * 把候选池整理成「题材 → 成员」分组，供 pickTopicLeaders 评选。
 *
 * 这一步是「一个题材只有一只龙头」的**前提**：池子里每只票必须先被归到【唯一一个】题材，
 * 否则同一只票会在多个题材里各当一次龙头，次日龙头组就会冒出多余的人。
 * 因此这里不接受「一只票属于多个题材」的输入 —— 题材归属由调用方通过 resolveTopic 解析为单值
 *（题材 toggle 的口径：正式列表走 getPrimaryTopicMap、注入壳行走 classifyStockPrimaryTopic）。
 *
 * 边界：
 *   · '其它' 不是题材 → 整行丢弃，不评它的龙头（题材 toggle 侧也不给"其它"上色/排龙一）；
 *   · resolveTopic 返回空 → 视为 '其它'，同样丢弃；
 *   · 同名重复 → 只保留第一次出现（池已去重，这里是双保险）；
 *   · resolveTopic 缺省（非函数）→ 全部归入 '其它' → 返回空分组（宁缺勿错，不瞎猜题材）。
 *
 * @param {Array<{stock:string, code?:string}>} pool 候选池行
 * @param {(row:object)=>string} [resolveTopic] 单只股票的【主题材】解析器（调用方注入，避免本文件依赖题材模块）
 * @param {(name:string)=>string} [resolveCode] 缺 code 时的兜底解析
 * @returns {Array<{topic:string, stocks:Array<{stock:string, code:string}>}>} 分组（已排除"其它"）
 */
export function buildTopicGroupsFromPool(pool, resolveTopic, resolveCode) {
  const byTopic = new Map();
  (pool || []).forEach(function(row) {
    if (!row || !row.stock) return;
    const nm = String(row.stock).trim();
    if (!nm) return;
    const topic = (typeof resolveTopic === 'function' ? resolveTopic(row) : '') || '';
    if (!topic || topic === '其它') return;        // 非题材 → 不参与评选
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    const arr = byTopic.get(topic);
    if (arr.some(function(s) { return s.stock === nm; })) return;   // 同名去重
    arr.push({ stock: nm, code: row.code || (resolveCode ? (resolveCode(nm) || '') : '') });
  });
  return Array.from(byTopic.entries()).map(function(e) {
    return { topic: e[0], stocks: e[1] };
  });
}

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

/**
 * 算出「名册整表对齐」要做什么（纯函数：不触云端、无副作用，见 dragon-group.js#_reconcileRoster）。
 *
 * 背景（实测事故 2026-09-15 → 9/16 龙头组只剩 1 只）：
 *   dragon_leaders 主键是 (date, topic)，落库用的是 upsert ⇒ **只增不删**。
 *   一旦某次评选因输入不全（如共享题材库尚未就绪 → 绝大多数票落「其它」）只算出 1 行，
 *   这行残缺就会永久留在表里；而「名册非空 ⇒ 视为该日已评选」还会让补评选再也不触发
 *   → 残缺被永久冻结，次日看板一整天只显示那 1 只龙头。
 *   ⇒ 权威评选之后必须把「本次已不成立」的题材行清掉，表才等于真相。
 *
 * 删除范围刻意收窄到「本次分组里成员数 < 门槛」的题材（§10 宁缺勿错）：
 *   · 「成员数够、但暂时查不到区间涨幅」的题材 **保留旧行** —— 那是数据未到（会重试），
 *     不是「这个题材没有龙头」的结论，删了就再也回不来了；
 *   · 旧名册读不到时调用方会跳过删除（不知道删哪几行）。
 *
 * @param {Array<{topic:string,stock:string,rangePct:number|null,groupSize:number}>} existing 云端现有名册行
 * @param {Array<{topic:string,stock:string,pct:number|null,groupSize:number}>} picked 本次权威评选结果
 * @param {Set<string>} qualifyingTopics 本次「成员数达门槛」的题材集合
 * @returns {{expired:string[], unchanged:boolean}}
 *   · expired   = 要从云端删掉的题材名（精确匹配）
 *   · unchanged = 名册与本次结果逐字段一致 → 调用方应直接返回、不做任何写入（幂等，零网络往返）
 */
export function planRosterReconcile(existing, picked, qualifyingTopics) {
  const ex = Array.isArray(existing) ? existing : [];
  const pk = Array.isArray(picked) ? picked : [];
  const quals = (qualifyingTopics instanceof Set) ? qualifyingTopics : new Set();

  const expired = ex
    .filter(function(r) { return r && r.topic && !quals.has(String(r.topic).trim()); })
    .map(function(r) { return String(r.topic).trim(); });

  let unchanged = (expired.length === 0) && (ex.length === pk.length);
  if (unchanged) {
    const byTopic = new Map();
    ex.forEach(function(r) { byTopic.set(String(r.topic).trim(), r); });
    for (let i = 0; i < pk.length; i++) {
      const np = pk[i];
      const old = byTopic.get(String(np.topic).trim());
      if (!old) { unchanged = false; break; }
      if (String(old.stock).trim() !== String(np.stock).trim()) { unchanged = false; break; }
      const oldPct = (old.rangePct === null || old.rangePct === undefined) ? null : Number(old.rangePct);
      const newPct = (np.pct === null || np.pct === undefined) ? null : Number(np.pct);
      const samePct = (oldPct === null && newPct === null) ||
                      (oldPct !== null && newPct !== null && Math.abs(oldPct - newPct) < 0.005);
      if (!samePct) { unchanged = false; break; }
      if ((Number(old.groupSize) || 0) !== (Number(np.groupSize) || 0)) { unchanged = false; break; }
    }
  }
  return { expired: expired, unchanged: unchanged };
}
