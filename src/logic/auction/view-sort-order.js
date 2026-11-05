// view-sort-order.js — 早盘竞价第一页的【主排序矩阵】唯一实现（Logic 层，§6 / §15）
//
// ══════════════════════════════════════════════════════════════════════════
// 【为什么单独一个模块】
//   用户 2026-11-05：「有大到小，由复杂到简单，拆解文件……不要把所以的逻辑和功能都挤到
//   一个文件里」。`view-helpers.js#computeAuctionViewData` 当时 1090 行，其中这一段
//   「谁排在前面」的矩阵是**最容易被误改的一块**：
//     · 竞/昨（分层）· 竞/昨占比（分层）· 十日涨幅（单层）· 20日涨幅（单层）四条主排序
//     · 外加 resolveTopicTier（题材分组时用的「档位」判定，必须与上面四条的口径逐字一致）
//   以前档位判定和排序分支隔了 60 行，改一处忘一处就会出现「档位边界错位」——
//   特征是同题材块里高光票跑到下面去了。现在两者在同一个文件里，一眼能对照。
//
// 【红线】
//   §6  比较器只有一份：单层排序一律走 `range-pct-sort.js#sortIndicesByRangePct`，
//       ⛔ 本文件不另写 pct 比较（缺数据置底 / 稳定序都由那个纯函数保证）。
//   §10 Map 未就绪（null）或某行缺数据 ⇒ 该行置底且不参与比较，⛔ 绝不补 0。
//   §11 关掉的 toggle 必须零行为变化：本文件只负责「返回一个索引顺序」，
//       没有副作用、不读 store、不发请求。
//
// 【调用关系】
//   view-helpers#computeAuctionViewData
//     ├── buildRenderOrder(...)          → 主排序（返回 renderOrder 索引数组）
//     └── resolveTopicTierOf(...)        → 作为第 3 参传给 topic-sort.js#sortByTopicGroups
// ══════════════════════════════════════════════════════════════════════════

import { sortIndicesByRangePct } from './range-pct-sort.js';

/**
 * 十/20日涨幅区间排序的公共实现（两者只差一份 Map，⛔ 不是两套比较器）。
 * @param {number[]} order 待排序的 renderList 索引
 * @param {Array} list renderList
 * @param {Map<string,{pct:number,days:number}>|null} rangeMap 取哪一份由调用方决定
 * @returns {number[]}
 */
function _byRangePct(order, list, rangeMap) {
  // §10：Map 未加载（null）或某行缺数据 → 该行置底且不参与 pct 比较（⛔ 绝不补 0）。
  // 置底/稳定序的实现收敛在 range-pct-sort.js 纯函数里，可独立单测（§15 / §42）。
  return sortIndicesByRangePct(order, list, rangeMap);
}

/**
 * 主排序矩阵：把 renderList 的索引数组重排。
 *
 * @param {Object} o
 * @param {number[]} o.renderOrder       初始顺序（通常 = renderList 的恒等索引）
 * @param {Array} o.renderList           待排序的行（= auctionList ∪ 三组注入壳）
 * @param {Object} o.sortState           当前 toggle 状态
 * @param {Set<string>} o.jingYestHighlightSet 竞昨高光全集（tier0 判据）
 * @param {Set<string>} o.parallelStocksToday  平行达标集合（竞/昨的 tier1 判据）
 * @param {Function} o.rangeMapOf10      () => 十日涨幅 Map（**惰性**：只在对应分支里调）
 * @param {Function} o.rangeMapOf20      () => 20日涨幅 Map（同上）
 * @param {Function} o.auctionPctOf      (row) => 竞价涨幅（竞/昨同档排序键）
 * @returns {number[]} 新的索引顺序
 */
export function buildRenderOrder(o) {
  const renderOrderIn = o.renderOrder;
  const renderList = o.renderList;
  const sortState = o.sortState || {};
  const jingYestHighlightSet = o.jingYestHighlightSet;
  const parallelStocksToday = o.parallelStocksToday;
  const auctionPctOf = o.auctionPctOf;
  let renderOrder = renderOrderIn;

  if (sortState.byJingYest) {
    // [FIX 2026-08-18] 同档排序按「当天竞价涨幅 auc_pct_chg」由高到低。
    //   分档条件不变：tier0=竞昨高光(平行+diff>0) / tier1=仅平行 / tier2=其它。
    //   原 digitGap+diff 排序键废弃，改用 auctionPctOf（专用竞价涨幅字段）。
    //   [RANGE-PCT 2026-10-14] 本分支一行未动：「三天竞跌」下线不影响它 ——
    //     它历史上的「同档按竞价涨幅」只是因为当时两个 toggle 共用同一个读取器，不是同一套口径。
    // [§32 不重复调用] 平行达标集合由调用方**传进来**（上游早就为 resolveTopicTier 取过一次），
    //   ⛔ 本文件不再自己调 getParallelStocksForDate —— 同一天同一数据源取两遍等于白构建一次
    //   覆盖全表的指纹串（§6 单一真相：口径不可能分叉，因为就是同一个对象）。
    const parallelStockNamesForSort = parallelStocksToday;
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const isParallel = parallelStockNamesForSort.has(stockName);
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
      const pctVal = auctionPctOf(it);
      return { idx, pos, tier, pctVal };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
      if (a.pctVal === null) return 1;
      if (b.pctVal === null) return -1;
      return b.pctVal - a.pctVal;
    }).map(x => x.idx);

  } else if (sortState.byJingYestRatio) {
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : 1;
      const vol = renderList[idx] ? (parseFloat(renderList[idx].volume) || 0) : 0;
      const yvol = renderList[idx] ? (parseFloat(renderList[idx].yestVolume) || 0) : 0;
      const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
      return { idx, pos, jr, tier };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.jr === null && b.jr === null) return a.pos - b.pos;
      if (a.jr === null) return 1;
      if (b.jr === null) return -1;
      return b.jr - a.jr;
    }).map(x => x.idx);
  } else if (sortState.byRangePct) {
    // [RANGE-PCT 2026-10-14 用户口径] 「十日涨幅」toggle（开关位由原「三天竞跌」改造）：
    //   ★ 全部股票（龙头组 + 观察组 + 常规组，不分块）按「近 10 个交易日区间涨幅」由高到低排。
    //   用户原话：「我点击十日涨幅 toggle 后，十日涨幅由高到低排序，并标上十日涨幅数据。
    //   所有的股票都要排，包括龙头组，观察组，常规组。这样我就清楚找到市场总龙头。」
    //   数据源 = getDragonRangePct(currentDate)（云端 stock_range_pct，与题材龙位徽章/决策看板
    //   排名同一个来源同一个字段，§6 单一真相）；同步读取，**0 网络请求、0 猫抓额度**。
    //   ⚠️ 数据未到时不假装有值：ensureDragonRangePct 一发布新 Map，指纹变化会自动重算本视图。
    renderOrder = _byRangePct(renderOrder, renderList, o.rangeMapOf10());
  } else if (sortState.byRangePct20) {
    // [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle（开关位由原「量比抢筹」改造）：
    //   ★ 全部股票（龙头组 + 观察组 + 常规组，不分块）按「含今天在内的 20 个交易日区间涨幅」
    //     由高到低排，并逐行标出该数值 —— 与「十日涨幅」同款，只是时间段不同。
    //   用户原话：「和十日涨幅toggle类似，只是时间段涨幅不一样，这样在市场总龙出现分歧的时候，
    //   我可能用这个toggle做参考。」
    //   ⚠️ 两个 map 各自独立：十日读云端 stock_range_pct；20 日读 range20.js 现算结果
    //      （云端没有 20 日行 —— 表主键 (date,stock)，写进去会覆盖 10 日行，见 range20.js 文件头）。
    renderOrder = _byRangePct(renderOrder, renderList, o.rangeMapOf20());
  }
  // [TWO-MODES 2026-10-02 用户口径] ⛔ 这里原有 `else if (sortState.byParallel)` 主排序分支（平行达标档
  //   按 digitGap 升序 → diff 降序；内层还套了一个永远走不到的 `if (sortState.byJingYest)` 子分支）
  //   —— 整段已删除（§16 不留死代码）：
  //     · 平行 toggle 的开关位被「一字」toggle 占用，`byParallel` 从状态里移除；
  //     · 平行随之【并入竞/昨】（竞/昨 的 tier0 = 平行+diff>0 高光、tier1 = 仅平行），
  //       这一层排序本来就被上面 `sortState.byJingYest` 覆盖（它在链上更靠前）；
  //     · 用户在 AskUserQuestion 里明确选了「保留现有『竞/昨』口径」，所以没有把 digitGap 排序搬过去。
  //   ⛔ 想恢复旧行为 ⇒ `git revert` 引入本改动的那次提交。
  //
  // [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] ⛔ 这里原有 `if (sortState.byWeakStrong) { … }` 三档排序
  //   （tier0 高光 = 连跌≥2 且竞价转向 / tier1 仅竞价转向 / tier2 其余），整段已随「弱转强」toggle 删除。
  //   开关位由「竞价口径」占用 —— 但那是一个【口径修饰开关】，不是一个主排序档，
  //   所以它【不在这里占分支】，而是由调用方的 `rangeMapOf10 / rangeMapOf20` 决定用哪一份数值。

  return renderOrder;
}

/**
 * 主排序「档位」判定 —— 题材分组时用（`topic-sort.js#sortByTopicGroups` 的第 3 参）。
 *
 * ⚠️ 必须与 `buildRenderOrder` 里各分支的 tier 口径【逐字一致】，否则档位边界错位，
 *    表现为「同题材块里高光票跑到下面去了」。
 *
 * @param {Array} renderList
 * @param {number} idx
 * @param {{sortState:Object, jingYestHighlightSet:Set, parallelStocksToday:Set}} o
 * @returns {number} 0 = 最高档
 */
export function resolveTopicTierOf(renderList, idx, o) {
  const sortState = (o && o.sortState) || {};
  const jingYestHighlightSet = o && o.jingYestHighlightSet;
  const parallelStocksToday = o && o.parallelStocksToday;
  const it = renderList[idx];
  const nm = it && it.stock ? it.stock.trim() : '';
  // [AUCTION-LEG-TOGGLE 2026-10-25] ⛔ 原「弱转强达标 ⇒ tier0 / 否则 tier1」已随该 toggle 删除。
  //   「竞价口径」不是分层排序（它只换数值来源、不改档位）⇒ 本函数不需要为它开分支。
  if (sortState.byJingYestRatio) {
    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
    return ih ? 0 : 1;
  }
  if (sortState.byJingYest) {
    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
    const ip = nm && parallelStocksToday && parallelStocksToday.has(nm);
    return ih ? 0 : (ip ? 1 : 2);
  }
  // [RANGE20 2026-10-19] ⛔ 原「量比抢筹」达标档在这里（tier0 = 竞价量比>=10 且 抢筹幅度>1，
  //   否则 tier1）—— 已随该 toggle 整体删除（§16：不留死分支）。
  // 其它主排序（默认 / 十日涨幅 / 20日涨幅）无分层概念，统一单档
  return 0;
}
