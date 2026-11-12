// sell-members.js — 「次日卖点侧成员」的唯一判定（Logic 层，纯函数，§15 可单测）
//
// ★★ [SELL-AUTO 2026-11-12 用户口径] 用户原话：
//   「卖点侧那里，要不你把昨日的买点侧，统一放到次日的卖点侧，这样就不要我手动添加，
//     因为我早上也是按照买点侧那里买的，这样就不会每次点击买入，才进去次日的题材量比的卖点侧，
//     让它自动进去就可以了。帮我实现下，包括打标签的逻辑，也要标清楚。那些持有，卖出的标签
//     你看怎么不冲突，要区分开来。还有手动的添加买入也不要冲突。」
//
// ── 改动前的状态（为什么必须改）──────────────────────────────────────────────
//   卖点侧成员原来**只**来自 `auction_board_tags(前一交易日)` 里 `tag='buy'` 的票
//   （`decision-collect#_prevBoughtNames`）。用户早上是按**买点侧**（规则选出来的那几只）买进去的，
//   但他不会逐只回去补打「买入」标签 ⇒ 次日卖点侧**缺票**，得手动点一遍才有。
//
// ── 现在的成员规则（三个来源 + 一道否决，⛔ 别自行加减）─────────────────────
//   ✅ ① `auto`   —— 昨日【买点侧】的票（`tvrb_plan_snapshot(前一日)` 的 picks，见
//                    `plan-live-overlay#collectBuyNames`）⇒ 自动进，**不需要打任何标签**。
//   ✅ ② `buy`    —— 昨日手动打过「买入」标签的票 ⇒ 进，且【优先于 auto】显示为「手动买」
//                    （同一天同一只票只出现一次，⛔ 不重复、不冲突）。
//   ✅ ③ `hold`   —— 昨日手动打过「持有」标签的票 ⇒ 进（还拿着，当然要继续看卖点），显示「持有」。
//   ❌ ④ `sell`   —— 昨日打过「卖出」标签的票 ⇒ **一票否决，一律不进**。
//                    理由：已经卖掉了，再自动推回卖点侧就是「卖了还天天让你卖」，
//                    且会与 auto 冲突（规则可能昨天也选中了它）。
//
//   ⚠️ 这三条与「今日买点侧」的【持有】标签是**不同维度**、不会互相覆盖：
//      · 本模块的 source = 「这只票**为什么**在今天的卖点侧」（昨日来源）
//      · `buildSellPlan` 的 `holdTag` = 「今天它又进了买点侧」（连续两天被选中）
//      两者可以同时存在（昨日自动继承 + 今天又进买点 ⇒ 「自动」+「持有」两条信息都对）。
//
// ⛔ 红线：本模块只决定【卖点侧成员】。⛔ 绝不参与买点侧任何判定
//   （`prevBought` 原样不动 —— 它还驱动买点侧的【持有】/【加仓】标签，动它就是动定稿结论）。
// §10：`prevBuyPlanNames` 为 null = 「昨日买点侧还不知道」（存档还没读到 / 读不到 / 表不存在），
//   ⛔ 绝不折成空数组当「昨天买点侧一只都没有」；此时只用标签成员，并把 `planKnown:false` 交给上层
//   在说明区如实标注。

/** 成员来源：昨日买点侧自动继承 */
export const SELL_SOURCE_AUTO = 'auto';
/** 成员来源：昨日手动「买入」标签 */
export const SELL_SOURCE_BUY = 'buy';
/** 成员来源：昨日手动「持有」标签 */
export const SELL_SOURCE_HOLD = 'hold';

/** 来源 → 行内小标文案（空串 ⇒ 组件不渲染，§10 不显示占位符） */
const SOURCE_LABEL = {
  auto: '自动',
  buy: '手动买',
  hold: '持有'
};

/** 来源 → 悬停说明（把「为什么它在这里」讲清楚，省得用户以为是打了标签） */
const SOURCE_TITLE = {
  auto: '昨日【买点侧】选中的票，今日自动进入卖点侧（不需要手动打「买入」标签）。' +
    '若昨日对它打了「卖出」，则不会再自动进来。',
  buy: '昨日手动打过「买入」标签 —— 与「自动继承」去重后只显示这一条（手动优先）。',
  hold: '昨日手动打过「持有」标签 —— 还拿着，所以继续留在今日卖点侧看卖点。'
};

/** @param {string} source @returns {string} */
export function sellSourceLabel(source) {
  return SOURCE_LABEL[source] || '';
}

/** @param {string} source @returns {string} */
export function sellSourceTitle(source) {
  return SOURCE_TITLE[source] || '';
}

/**
 * 组装「次日卖点侧成员」。
 *
 * @param {object|null} prevDayTags 前一交易日的标签表 `{ 股票名: 'buy'|'sell'|'hold' }`
 *        （来自 `auctionTagStore.tags[prevDate]`；null/undefined 按「这一天没有标签」处理）
 * @param {string[]|Set<string>|null} prevBuyPlanNames 前一交易日【买点侧】的股票名；
 *        null = 还不知道（§10，⛔ 不折成空）
 * @returns {{members:Array<{name:string,source:string}>, stats:object}}
 *          members 已按名字升序（确定性，便于比对与单测）；
 *          stats = { total, auto, buy, hold, excludedSell, planCount, planKnown }
 */
export function buildSellMembers(prevDayTags, prevBuyPlanNames) {
  const tags = (prevDayTags && typeof prevDayTags === 'object') ? prevDayTags : {};
  const planKnown = Array.isArray(prevBuyPlanNames)
    || (prevBuyPlanNames && typeof prevBuyPlanNames.forEach === 'function');
  const planNames = planKnown ? Array.from(prevBuyPlanNames) : [];

  /** name -> source（先到先得：手动标签先写，auto 后补 ⇒ 天然「手动优先」） */
  const picked = new Map();
  const excludedSell = [];

  // ①② 先处理手动标签：buy / hold 进，sell 一票否决
  Object.keys(tags).forEach(function (raw) {
    const nm = String(raw == null ? '' : raw).trim();
    if (!nm) return;
    const t = String(tags[raw] || '');
    if (t === 'sell') { excludedSell.push(nm); return; }
    if (t === 'buy') picked.set(nm, SELL_SOURCE_BUY);
    else if (t === 'hold') picked.set(nm, SELL_SOURCE_HOLD);
  });

  // ③ 再补昨日买点侧：已有手动来源的保持不动（⛔ 不覆盖，这就是「不冲突」）
  //    昨日已打「卖出」的票跳过（④ 一票否决优先于 auto）
  const sellSet = new Set(excludedSell);
  planNames.forEach(function (raw) {
    const nm = String(raw == null ? '' : raw).trim();
    if (!nm) return;
    if (picked.has(nm)) return;
    if (sellSet.has(nm)) return;
    picked.set(nm, SELL_SOURCE_AUTO);
  });

  const members = Array.from(picked.keys()).sort().map(function (nm) {
    return { name: nm, source: picked.get(nm) };
  });

  let auto = 0, buy = 0, hold = 0;
  members.forEach(function (m) {
    if (m.source === SELL_SOURCE_AUTO) auto++;
    else if (m.source === SELL_SOURCE_BUY) buy++;
    else if (m.source === SELL_SOURCE_HOLD) hold++;
  });

  return {
    members: members,
    stats: {
      total: members.length,
      auto: auto,
      buy: buy,
      hold: hold,
      excludedSell: excludedSell.length,
      planCount: planNames.length,
      planKnown: !!planKnown
    }
  };
}
