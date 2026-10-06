// auction-share.test.js — 「决策」看板【竞价占比】规则的回归用例
//
// ⭐ [SHARE-RULE 2026-10-03 用户口径] 这个文件的 11 条「案例」用例【逐条对应用户给出的原话】——
//    用户列了 8/31、9/1、9/2 三天的买卖点标注（金健米业 / 海登种业 / 花溪科技 / 捷荣技术 /
//    楚天龙 / 龙版传媒 / 登海种业 / 华阳国际 / 浙江世宝），并明确「以新规则为准」。
//    ⛔ 改判据 / 改门槛之前，先把这个文件跑一遍：这 11 条是用户亲自算过的验收基准。
//
// 口径（唯一实现在 auction-share.js）：
//   竞价占比（%）= 当日竞价量 ÷ 昨日成交量 × 100，【保留 1 位小数】（用户原话「这样更准确」）。
//   ⚠️ 与早盘竞价第一页那个占比【同一个公式】，但那一页是【四舍五入取整】——
//      两处精度【刻意不同】，⛔ 不要去对齐（用户原话「那个是四舍五入算法，只取整数」）。
//   门槛：龙头（今日【龙一】，或昨日在龙头名册里）→ 4% 容错 0.5% ⇒ 3.5%；其余（龙二及以下）→ 2%。
//     ⚠️ [DRAGON-TIER 2026-10-06 用户口径 · 9/8 翠微股份] 门槛【只分两级】，⛔ 龙二【不再】算龙头。
//     ⚠️ 三分法（龙头 龙一 / 中军 龙二~龙四 / 后排 龙五及以下）只决定「跟不跟同题材龙一卖」，
//        ⛔ 不参与门槛（龙头 > 中军 > 后排 是强度排序，不是门槛分档）。
//   买点：达标 → 竞价买；不达标 → 尾盘买（若昨天已买过 ⇒ 【尾盘买（先卖后买）】且清掉【持有】）。
//   卖点：达标 → 尾盘卖（今天又进买点 ⇒ 持有）；不达标 + 今天又进买点 → 竞价卖（先卖后买）；
//         不达标 + 今天没进买点 → 竞价卖（真的弱了）；同题材龙一倒下 ⇒ 中军/后排【跟龙竞价卖】。
//   §10：占比缺数据 → 回落旧的量比方向口径，并如实写进 actionNote（⛔ 不当 0）。

import { describe, it, expect } from 'vitest';
import {
  rankDecisionTopics,
  rankDragons,
  buildBuyPlan,
  buildSellPlan,
  buildVolRatioRulesLines,
  joinRulesLines,
  resolveDragonScope,
  // [DRAGON-TIER 2026-10-06 用户口径 · 9/8 翠微股份] 三分档（龙头 / 中军 / 后排）
  dragonTierOf,
  BUY_NOW_TAG,
  BUY_LATE_TAG,
  BUY_LATE_SWAP_TAG,
  SELL_FIRST_BUY_LATER_TAG,
  SELL_LATE_TAG,
  SELL_OUT_TAG,
  // [DRAGON-SWAP 2026-10-06 用户口径 · 9/3 楚天龙] 【竞价卖（先卖后买）】—— 卖点侧与
  //   【尾盘买（先卖后买）】成对；同时是【跟龙竞价卖】的刹车（龙一有它就说明当天还看好）。
  SELL_OUT_SWAP_TAG,
  // [FOLLOW-DRAGON 2026-10-05 用户口径 · 9/9 国芳集团 + 安记食品] 同题材龙一限制（优先规则）
  SELL_FOLLOW_DRAGON_TAG,
  SELL_ACTION_TONE_FOLLOW,
  // [DIVE-BUY 2026-10-07 用户口径 · 9/7 爱仕达] 中军三项指标正面异常 ⇒ 下杀买（竞价异常）
  BUY_DIVE_TAG,
  DIVE_AUC_PCT_MIN,
  DIVE_VOL_RATIO_DELTA_MIN,
  DIVE_SHARE_MIN,
  // [SELL-TEN-MIN 2026-10-07 用户口径 · 9/7 我爱我家] 龙一占比差一点点 + 量比增加 ⇒ 10分钟时卖
  SELL_TEN_MIN_TAG,
  SELL_ACTION_TONE_TEN_MIN,
  SELL_TIME_TEN_MIN,
  SELL_TEN_MIN_GAP,
  HOLD_TAG,
  RULE_NO
} from './decision-rules.js';
import {
  computeAuctionShare,
  formatAuctionShare,
  auctionShareThresholdOf,
  passesAuctionShare,
  auctionShareZoneOf,
  AUCTION_SHARE_FRONT_STD,
  AUCTION_SHARE_TOLERANCE,
  AUCTION_SHARE_FRONT_MIN,
  AUCTION_SHARE_BACK_STD
} from './auction-share.js';
// [SHARE-PRIORITY 2026-10-04] 一字模式（legacy）的规则文案也要带上新规 —— 两套模式共用同一份
//   买卖时机实现（_decorateShareAction），条文必须一起更新，⛔ 不许只改量比模式那一份。
import { buildRulesLines } from './decision-rules-legacy.js';
import { VR_DIR_UP, VR_DIR_DOWN, VR_DIR_FLAT } from './vol-ratio-trend.js';

/* ─────────────────────────── 桩数据 ─────────────────────────── */

/**
 * 造一行决策数据。
 * @param {string} name 股票名
 * @param {string} topic 题材
 * @param {number} pct 十日涨幅（决定题材内【龙几】）
 * @param {number|null} aucPct 竞价涨幅（%）
 * @param {number|null} volRatio 竞价量比（买点选票依据）
 * @param {number|null} share 竞价占比（%）—— 本文件的主角；null = 缺数据（§10）
 * @param {string} [dir] 竞价量比方向（up/flat/down/''），占比缺数据时的退路依据
 * @param {number|null} [delta] 竞价量比与上一交易日的【整数差】——[DIVE-BUY 2026-10-07] 下杀买档的硬指标。
 *        ⚠️ 不传一律写 null（= 缺数据）⇒ 该档【不生效】（§10：缺数据 ≠ 没增加）。
 */
function R(name, topic, pct, aucPct, volRatio, share, dir, delta) {
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: false,
    countable: true,
    code: '',
    inheritSold: false,
    aucPct: (aucPct === undefined) ? null : aucPct,
    aucVolRatio: (volRatio === undefined) ? null : volRatio,
    aucShare: (share === undefined) ? null : share,
    volRatioDir: dir || '',
    volRatioDelta: (delta === undefined) ? null : delta
  };
}

/** 凑数票：十日涨幅极低（龙位排最后）+ 量比很低 ⇒ 不会抢走选票名额，但把题材只数撑到档位 */
function F(topic, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(R('凑' + topic + (i + 1), topic, -100 - i, 0.1, 0.01, 1.0));
  return out;
}

/** 行集合 → 买点计划（题材块 + 龙头排名都由真实实现算出来，不手搓中间态） */
function buy(rows, opts) {
  const blocks = rankDecisionTopics(rows);
  return buildBuyPlan(blocks, rankDragons(blocks), opts || {});
}

/** 行集合 → 卖点计划（卖点候选 = 昨日打过「买」标签的股票，这里直接按 rows 传） */
function sell(rows, opts) {
  const o = opts || {};
  // 用同一批行造题材块 / 龙头排名，保证 dragonRank 与买点侧同口径（§6）
  const memberRows = o.memberRows || rows.map(function(r) {
    return R(r.name, r.topic, r.pct, r.aucPct, 1, r.aucShare, r.volRatioDir);
  });
  const blocks = rankDecisionTopics(memberRows);
  const dragonMap = rankDragons(blocks);
  const sellRows = rows.map(function(r) {
    return {
      name: r.name, topic: r.topic, pct: r.pct, inTodayList: true,
      aucPct: r.aucPct, volRatioDir: r.volRatioDir, volRatioTimes: r.volRatioTimes,
      aucShare: r.aucShare
    };
  });
  return buildSellPlan(sellRows, blocks, dragonMap, o.prevDragonNames || null, o.todayBuyNames || null);
}

/** 从买点计划里按名字取一只票（⛔ 找不到会抛错，避免用例静默变成空测） */
function pickOf(plan, name) {
  const all = [];
  ['heavy', 'light'].forEach(function(k) {
    const b = plan[k];
    if (b && b.picks) b.picks.forEach(function(p) { all.push(p); });
  });
  (plan.candidates || []).forEach(function(b) {
    if (b && b.picks) b.picks.forEach(function(p) { all.push(p); });
  });
  const hit = all.filter(function(p) { return p.name === name; })[0];
  if (!hit) throw new Error('买点里没有 ' + name + '（本用例的桩数据没有把它选出来）');
  return hit;
}

/** 把买点计划里【所有块】的块级说明拼成一段（断言「不能出现自相矛盾的话」用） */
function allBlockNotes(plan) {
  const out = [];
  ['heavy', 'light'].forEach(function(k) {
    const b = plan[k];
    if (b && b.notes) b.notes.forEach(function(n) { out.push(n); });
  });
  (plan.candidates || []).forEach(function(b) {
    if (b && b.notes) b.notes.forEach(function(n) { out.push(n); });
  });
  return out.join('\n');
}

/** 从卖点计划里按名字取一行（⛔ 找不到会抛错） */
function itemOf(plan, name) {
  for (let i = 0; i < plan.length; i++) {
    const hit = (plan[i].items || []).filter(function(x) { return x.name === name; })[0];
    if (hit) return hit;
  }
  throw new Error('卖点里没有 ' + name);
}

/* ════════════════════════════════════════════════════════════════════════════════
   一、公式与门槛（用户逐字给的算术）
   ════════════════════════════════════════════════════════════════════════════════ */

describe('竞价占比：公式（当日竞价量 ÷ 昨日成交量，保留 1 位小数）', () => {
  it('⭐ 金健米业：实际 0.0435 → 4.4%（用户原话「那就是 4.4%」）', () => {
    expect(computeAuctionShare(435, 10000)).toBe(4.4);
    expect(formatAuctionShare(4.35)).toBe('4.4%');
  });

  it('⭐ 华阳国际：93 ÷ 2657 = 0.035002 → 3.5%（用户原话「那就是 3.5%小于 4%」）', () => {
    expect(computeAuctionShare(93, 2657)).toBe(3.5);
    expect(formatAuctionShare(3.5)).toBe('3.5%');
  });

  it('⭐ 海登种业：占比 1% —— 怎么算都小于 4%（用户原话）', () => {
    expect(computeAuctionShare(10, 1000)).toBe(1);
    expect(formatAuctionShare(1)).toBe('1.0%');
  });

  it('用户给的其余案例数值逐条对上（4.4 / 7.0 / 5.5 / 6.9 / 3.6 / 0.15 / 3.9 / 2.6 / 9.4 / 1.8）', () => {
    expect(formatAuctionShare(computeAuctionShare(44, 1000))).toBe('4.4%');    // 花溪科技 9/1
    expect(formatAuctionShare(computeAuctionShare(70, 1000))).toBe('7.0%');    // 捷荣技术 9/1
    expect(formatAuctionShare(computeAuctionShare(55, 1000))).toBe('5.5%');    // 楚天龙
    expect(formatAuctionShare(computeAuctionShare(69, 1000))).toBe('6.9%');    // 龙版传媒
    expect(formatAuctionShare(computeAuctionShare(36, 1000))).toBe('3.6%');    // 花溪科技 9/2
    expect(formatAuctionShare(computeAuctionShare(15, 10000))).toBe('0.2%');   // 0.15 → 0.2（海登种业量级）
    expect(formatAuctionShare(computeAuctionShare(39, 1000))).toBe('3.9%');    // 金健米业 9/1 卖点
    expect(formatAuctionShare(computeAuctionShare(94, 1000))).toBe('9.4%');    // 捷荣技术 9/2 卖点
    expect(formatAuctionShare(computeAuctionShare(18, 1000))).toBe('1.8%');    // 华阳国际
  });

  it('保留 1 位小数是【四舍五入到 1 位】，不是截断', () => {
    expect(computeAuctionShare(4350, 100000)).toBe(4.4);   // 4.35 → 4.4（进位）
    expect(computeAuctionShare(4340, 100000)).toBe(4.3);   // 4.34 → 4.3
    expect(computeAuctionShare(4451, 100000)).toBe(4.5);   // 4.451 → 4.5
  });

  it('§10：缺当日竞价量 / 缺昨日成交量 ⇒ null（⛔ 绝不当 0）', () => {
    expect(computeAuctionShare(null, 1000)).toBe(null);
    expect(computeAuctionShare(100, null)).toBe(null);
    expect(computeAuctionShare('', 1000)).toBe(null);
    expect(computeAuctionShare('abc', 1000)).toBe(null);
    expect(computeAuctionShare(undefined, undefined)).toBe(null);
  });

  it('§10：昨日成交量为 0 / 负数 ⇒ 除不出来 ⇒ null（绝不返回 Infinity）', () => {
    expect(computeAuctionShare(100, 0)).toBe(null);
    expect(computeAuctionShare(100, -5)).toBe(null);
  });

  it('字符串形态（云端存的是字符串）也要能算', () => {
    expect(computeAuctionShare('93', '2657')).toBe(3.5);
  });
});

describe('竞价占比：门槛与强度档', () => {
  it('两个标准值：龙头（今日龙一 / 昨日龙头）4%（容错 0.5% ⇒ 3.5%）/ 其余（龙二及以下）2%', () => {
    expect(AUCTION_SHARE_FRONT_STD).toBe(4);
    expect(AUCTION_SHARE_TOLERANCE).toBe(0.5);
    expect(AUCTION_SHARE_FRONT_MIN).toBe(3.5);
    expect(AUCTION_SHARE_BACK_STD).toBe(2);
    expect(auctionShareThresholdOf(true)).toBe(3.5);
    expect(auctionShareThresholdOf(false)).toBe(2);
  });

  it('达标判定：龙头 3.5 起 / 其余 2 起；边界值取「≥」（含端点）', () => {
    expect(passesAuctionShare(3.5, true)).toBe(true);
    expect(passesAuctionShare(3.4, true)).toBe(false);
    expect(passesAuctionShare(3.4, false)).toBe(true);
    expect(passesAuctionShare(2.0, false)).toBe(true);
    expect(passesAuctionShare(1.9, false)).toBe(false);
  });

  it('§10：占比为 null ⇒ 不算达标（false），由调用方走回落分支', () => {
    expect(passesAuctionShare(null, true)).toBe(false);
    expect(passesAuctionShare(null, false)).toBe(false);
    expect(passesAuctionShare('', false)).toBe(false);
  });

  it('强度档：≥ 4% strong ｜ ≥ 2% meet ｜ 其余 weak ｜ 缺值空串', () => {
    expect(auctionShareZoneOf(4)).toBe('strong');
    expect(auctionShareZoneOf(7)).toBe('strong');
    expect(auctionShareZoneOf(3.9)).toBe('meet');
    expect(auctionShareZoneOf(2)).toBe('meet');
    expect(auctionShareZoneOf(1.9)).toBe('weak');
    expect(auctionShareZoneOf(0.15)).toBe('weak');
    expect(auctionShareZoneOf(null)).toBe('');
  });

  it('§10：formatAuctionShare(null) = 空串（⛔ 绝不写成 0.0%）', () => {
    expect(formatAuctionShare(null)).toBe('');
    expect(formatAuctionShare(undefined)).toBe('');
    expect(formatAuctionShare('abc')).toBe('');
    expect(formatAuctionShare(0)).toBe('0.0%');
  });
});

describe('resolveDragonScope：龙头门槛 = 今日【龙一】或昨日在龙头名册里（⛔ 龙二不算）', () => {
  it('⭐ [DRAGON-TIER 2026-10-06] 今日龙一 → 龙头（3.5%）；⚠️ 龙二【不】算龙头 ⇒ 走 2%', () => {
    expect(resolveDragonScope(1, false).isFront).toBe(true);
    // 🔴 用户原话（9/8 翠微股份龙二 2.6%）：「把龙二当作前排选手，占比要大于3.5，感觉准确不高」
    //   ⇒ 龙二不再享受龙头门槛，一律 2%（2.6% ≥ 2% ⇒ 尾盘卖）。
    expect(resolveDragonScope(2, false).isFront).toBe(false);
  });

  it('今日龙三及以下 → 非龙头（2%）', () => {
    expect(resolveDragonScope(3, false).isFront).toBe(false);
    expect(resolveDragonScope(4, false).isFront).toBe(false);
    expect(resolveDragonScope(9, false).isFront).toBe(false);
  });

  it('昨日龙头（在龙头名册里）→ 即便今日不是龙一也算龙头（用户 2026-10-06 明确保留「龙一多条命」）', () => {
    expect(resolveDragonScope(2, true).isFront).toBe(true);
    expect(resolveDragonScope(5, true).isFront).toBe(true);
    expect(resolveDragonScope(9, true).isFront).toBe(true);
  });

  it('§10：昨日名册未加载（null）→ 不算龙头，但标记 frontUnknown 供说明文字如实写出', () => {
    const s = resolveDragonScope(5, null);
    expect(s.isFront).toBe(false);
    expect(s.frontUnknown).toBe(true);
    // 今日龙一仍然照常算龙头
    expect(resolveDragonScope(1, null).isFront).toBe(true);
  });

  it('三分档 dragonTierOf：龙一 = 龙头 ｜ 龙二~龙四 = 中军 ｜ 龙五及以下 / 未知 = 后排', () => {
    // 用户原话：「龙头只有一个，那就是龙一。前排选手是龙二到龙四，
    //   后排选手就是龙四以下（不包含龙四，比如龙五，龙六，龙七……）」
    expect(dragonTierOf(1)).toBe('leader');
    expect(dragonTierOf(2)).toBe('middle');
    expect(dragonTierOf(3)).toBe('middle');
    expect(dragonTierOf(4)).toBe('middle');
    expect(dragonTierOf(5)).toBe('back');
    expect(dragonTierOf(9)).toBe('back');
    // §10：龙位未知 ⇒ 按最弱的后排处理（不猜它是中军）
    expect(dragonTierOf(null)).toBe('back');
    // ⛔ 三分档【只管跟不跟龙一】，与门槛完全两件事
    expect(resolveDragonScope(2, false).isFront).toBe(false);   // 中军 ⇒ 门槛 2%
    expect(resolveDragonScope(4, false).isFront).toBe(false);   // 中军 ⇒ 门槛 2%
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   二、买点：用户给的 7 个案例
   ════════════════════════════════════════════════════════════════════════════════ */

describe('★ 买点（占比说了算）：用户 8/31 · 9/1 · 9/2 的标注逐条复现', () => {
  it('① 金健米业（昨日/今日龙一，占比 4.4% ≥ 3.5%）→ 【竞价买】', () => {
    const plan = buy([
      R('金健米业', 'T1', 10, 0.17, 11.72, 4.4, VR_DIR_UP),
      ...F('T1', 3)
    ]);
    const p = pickOf(plan, '金健米业');
    expect(p.dragonRank).toBe(1);
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.aucShareText).toBe('4.4%');
  });

  it('② 花溪科技（龙一，占比 4.4%，量比增强 → 不看竞价涨幅 -6.22%）→ 【竞价买】', () => {
    const plan = buy([
      R('花溪科技', 'T1', 10, -6.22, 18.59, 4.4, VR_DIR_UP),
      ...F('T1', 3)
    ]);
    expect(pickOf(plan, '花溪科技').buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('③ 捷荣技术（龙一，占比 7.0%，量比【下降】+ 高开 8.07%）→ 【竞价买】（旧口径会错判尾盘买）', () => {
    const plan = buy([
      R('捷荣技术', 'T1', 10, 8.07, 60.82, 7.0, VR_DIR_DOWN),
      ...F('T1', 3)
    ]);
    const p = pickOf(plan, '捷荣技术');
    // 用户原话：「现在提示尾盘买，实际是早盘就买」⇒ 新规必须给竞价买
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.buyActionTag).not.toBe(BUY_LATE_TAG);
  });

  it('④ 楚天龙（昨日/今日龙一，占比 5.5% ≥ 4%）→ 【竞价买】', () => {
    const plan = buy([
      R('楚天龙', 'T1', 10, 0.1, 20, 5.5, VR_DIR_UP),
      ...F('T1', 3)
    ], { prevDragonNames: new Set(['楚天龙']) });
    expect(pickOf(plan, '楚天龙').buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⑤ 海登种业（龙七 = 后排，占比 0.15% < 2%）→ 【尾盘买】', () => {
    // 造一个 7 只的题材（中档 ⇒ 取 2 只）；6 只高涨幅的排前面 ⇒ 目标正好是龙七
    const high = [];
    for (let i = 0; i < 6; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const plan = buy([
      ...high,
      R('海登种业', 'T1', 1, 2.68, 50, 0.15, VR_DIR_FLAT)
    ]);
    const p = pickOf(plan, '海登种业');
    expect(p.dragonRank).toBe(7);
    expect(p.buyActionTag).toBe(BUY_LATE_TAG);
    expect(p.aucShareText).toBe('0.2%');   // 0.15 → 保留 1 位小数 = 0.2%
  });

  it('⑥ 龙版传媒（龙六 = 后排，占比 6.9% ≥ 2%）→ 【竞价买】（后排占比够强也竞价买）', () => {
    const high = [];
    for (let i = 0; i < 5; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const plan = buy([
      ...high,
      R('龙版传媒', 'T1', 1, 1.46, 50, 6.9, VR_DIR_DOWN)
    ]);
    const p = pickOf(plan, '龙版传媒');
    expect(p.dragonRank).toBe(6);
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⑦ 花溪科技 9/2（昨日龙一，今日非前二，占比 3.6% ≥ 3.5% 用容错）→ 【竞价买】', () => {
    // 今日龙五 ⇒ 今日这一腿不算龙头；靠【昨日龙头名册】那条腿拿 3.5% 的门槛
    const high = [];
    for (let i = 0; i < 4; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const rows = [...high, R('花溪科技', 'T1', 1, -5.02, 50, 3.6, VR_DIR_DOWN)];
    const plan = buy(rows, { prevDragonNames: new Set(['花溪科技']) });
    const p = pickOf(plan, '花溪科技');
    expect(p.dragonRank).toBe(5);
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.aucShareThresholdText).toContain('3.5');   // 说明文字里必须写出容错后的门槛
  });

  it('反例：3.6% 但【昨日不是龙头】→ 其余门槛 2% 也过 ⇒ 仍是竞价买（换个更弱的数看差异）', () => {
    const high = [];
    for (let i = 0; i < 4; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const rows = [...high, R('花溪科技', 'T1', 1, -5.02, 50, 1.8, VR_DIR_DOWN)];
    // 非龙头：门槛 2% ⇒ 1.8% 不达标 ⇒ 尾盘买
    const plan = buy(rows, { prevDragonNames: new Set(['别的股票']) });
    expect(pickOf(plan, '花溪科技').buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('⑧ 楚天龙 9/3（昨有买入 + 占比 2.5% 不达标）→ 只留【尾盘买（先卖后买）】，【持有】被去掉', () => {
    // 用户原话：「少楚天龙，昨有买入，当天进去决策看板的买点，同时进入卖点……
    //   占比2.5不达标……买点方面，提示尾盘买（已有，把持有去掉就可以），
    //   改成只有「尾盘买（先卖后买）」」
    const rows = [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN), ...F('T1', 3)];
    const plan = buy(rows, {
      prevBoughtNames: new Set(['楚天龙']),   // 昨有买入（⇒ 卖点里也有它）
      prevBuyNames: new Set(['楚天龙'])       // ③ 会先标【持有】—— 必须被新规清掉
    });
    const p = pickOf(plan, '楚天龙');
    expect(p.dragonRank).toBe(1);                       // 今日龙一 ⇒ 龙头门槛 3.5% ⇒ 2.5% 不达标
    expect(p.aucShareText).toBe('2.5%');
    expect(p.aucSharePass).toBe(false);
    expect(p.buyActionTag).toBe('尾盘买（先卖后买）');   // ⛔ 不是普通的【尾盘买】
    expect(p.buyActionTag).toBe(BUY_LATE_SWAP_TAG);
    expect(p.holdTag).toBe('');                          // ③ 的【持有】被清
    expect(p.position).toBe('');                         // 行尾仓位【持有】也被清 ⇒ 整行只剩上面那一枚
    expect(p.positionTone).toBe('');
    expect(p.actionNote).toContain('先卖后买');
    // ③ 的【持有】让路 ⇒ 块级说明也【不许】再写「强势股，可持有」（否则与行内打架）
    const notes = allBlockNotes(plan);
    expect(notes).not.toContain('强势股，可【' + HOLD_TAG + '】');
    expect(notes).toContain('不算强势股');
  });

  it('⑧-反例：占比达标时【持有】照旧保留（花溪科技 9/2 3.6% 达标）', () => {
    const rows = [R('花溪科技', 'T1', 10, -5.02, 50, 3.6, VR_DIR_DOWN), ...F('T1', 3)];
    const plan = buy(rows, {
      prevBoughtNames: new Set(['花溪科技']),
      prevBuyNames: new Set(['花溪科技'])
    });
    const p = pickOf(plan, '花溪科技');
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);   // 达标 ⇒ 竞价买
    expect(p.position).toBe('持有');             // ⛔ 这一档不受新规影响
    // 达标 ⇒ ③ 照常标、块级说明照常写「可持有」
    expect(allBlockNotes(plan)).toContain('强势股，可【' + HOLD_TAG + '】');
  });
});

describe('买点：§10 占比缺数据 → 回落旧的量比方向口径（并如实写明）', () => {
  it('量比【增强】→ 竞价买（退路）', () => {
    const plan = buy([R('甲', 'T1', 10, 1, 9, null, VR_DIR_UP), ...F('T1', 3)]);
    expect(pickOf(plan, '甲').buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('量比【下降】+ 手上没有 → 尾盘买（退路）', () => {
    const plan = buy([R('甲', 'T1', 10, 1, 9, null, VR_DIR_DOWN), ...F('T1', 3)]);
    expect(pickOf(plan, '甲').buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('量比【下降】+ 昨天买过 → 先卖后买（退路）', () => {
    const plan = buy([R('甲', 'T1', 10, 1, 9, null, VR_DIR_DOWN), ...F('T1', 3)],
      { prevBoughtNames: new Set(['甲']) });
    expect(pickOf(plan, '甲').buyActionTag).toBe(SELL_FIRST_BUY_LATER_TAG);
  });

  it('量比【持平 / 方向未知】→ 不给动作标签（未知 ≠ 增强，也 ≠ 下降）', () => {
    expect(pickOf(buy([R('甲', 'T1', 10, 1, 9, null, VR_DIR_FLAT), ...F('T1', 3)]), '甲').buyActionTag)
      .toBeFalsy();
    expect(pickOf(buy([R('甲', 'T1', 10, 1, 9, null, ''), ...F('T1', 3)]), '甲').buyActionTag)
      .toBeFalsy();
  });

  it('★ 说明文字里必须写明「缺数据」，⛔ 不许暗示成「占比很低」', () => {
    const p = pickOf(buy([R('甲', 'T1', 10, 1, 9, null, VR_DIR_UP), ...F('T1', 3)]), '甲');
    expect(p.actionNote).toContain('缺数据');
    expect(p.actionNote).toContain('§10');
    expect(p.aucShareText).toBe('');       // 徽标不渲染
    expect(p.aucSharePass).toBe(null);     // null = 未知，不是 false
  });
});

describe('买点：行内展示字段（§21 模板零计算）', () => {
  it('占比徽标文案 + 配色档 + 门槛说明都由 Logic 层给好', () => {
    const p = pickOf(buy([R('甲', 'T1', 10, 1, 9, 4.4, VR_DIR_UP), ...F('T1', 3)]), '甲');
    expect(p.aucShareText).toBe('4.4%');
    expect(p.aucShareTone).toBe('strong');
    expect(p.aucSharePass).toBe(true);
    // [DRAGON-TIER 2026-10-06] 文案由「前排 / 后排」改为「龙头 / 非龙头」（只有龙一算龙头）
    expect(p.aucShareScopeText).toContain('龙头');
    expect(p.aucShareThresholdText).toContain('3.5');
  });

  it('非龙头（龙二及以下）的强度档与门槛文案', () => {
    const high = [];
    for (let i = 0; i < 5; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const p = pickOf(buy([...high, R('甲', 'T1', 1, 1, 50, 2.6, VR_DIR_UP)]), '甲');
    expect(p.aucShareTone).toBe('meet');
    expect(p.aucShareScopeText).toContain('非龙头');
    expect(p.aucShareThresholdText).toContain('2');
  });

  it('每只票的 actionNote 都包含「竞价占比」与辅助指标（用户要求说明文字写清楚）', () => {
    const p = pickOf(buy([R('甲', 'T1', 10, 0.17, 9, 4.4, VR_DIR_UP), ...F('T1', 3)]), '甲');
    expect(p.actionNote).toContain('竞价占比 4.4%');
    expect(p.actionNote).toContain('辅助');
    expect(p.actionNote).toContain(RULE_NO.SHARE);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   三、卖点：用户给的 6 个案例
   ════════════════════════════════════════════════════════════════════════════════ */

describe('★ 卖点（占比说了算）：用户 9/1 · 9/2 的标注逐条复现', () => {
  // 造一个 6 只的题材 T1（只数只影响买点档位，卖点只用题材排名与龙位）
  function topic6(targetPct, targetName) {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    rows.push(R(targetName, 'T1', targetPct, 0.08, 1, 1.0));
    return rows;
  }

  it('① 金健米业（昨日龙一，占比 3.9% ≥ 3.5% 容错）→ 【尾盘卖】', () => {
    const rows = topic6(1, '金健米业');            // 今日龙六 ⇒ 靠「昨日龙一」拿龙头门槛
    const plan = sell(
      [R('金健米业', 'T1', 1, 0.08, 1, 3.9, VR_DIR_DOWN)],
      { memberRows: rows, prevDragonNames: new Set(['金健米业']) }
    );
    const it0 = itemOf(plan, '金健米业');
    expect(it0.sellActionTag).toBe(SELL_LATE_TAG);
    expect(it0.aucShareText).toBe('3.9%');
    expect(it0.aucSharePass).toBe(true);
  });

  it('② 登海种业（龙九 = 后排，占比 2.6% ≥ 2%）→ 【尾盘卖】', () => {
    const rows = topic6(1, '登海种业');
    const plan = sell(
      [R('登海种业', 'T1', 1, -0.28, 1, 2.6, VR_DIR_UP)],
      { memberRows: rows, prevDragonNames: new Set(['别的股票']) }
    );
    expect(itemOf(plan, '登海种业').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('③ 捷荣技术（昨日龙一，占比 9.4%，前两个指标都弱）→ 【尾盘卖】', () => {
    const rows = topic6(1, '捷荣技术');
    const plan = sell(
      [R('捷荣技术', 'T1', 1, -3.95, 1, 9.4, VR_DIR_DOWN)],
      { memberRows: rows, prevDragonNames: new Set(['捷荣技术']) }
    );
    const it0 = itemOf(plan, '捷荣技术');
    expect(it0.sellActionTag).toBe(SELL_LATE_TAG);
    expect(it0.aucShareText).toBe('9.4%');
  });

  it('④ 浙江世宝（今日无题材 = 后排，占比 2.6%，竞价涨幅 -6.52%）→ 【尾盘卖】', () => {
    // 用户口径里占比是【决定性】的：涨幅 -6.52% 偏弱，但占比 2.6% ≥ 2% 仍给尾盘卖
    const plan = sell([R('浙江世宝', '', 1, -6.52, 6.62, 2.6, VR_DIR_UP)]);
    const it0 = itemOf(plan, '浙江世宝');
    expect(it0.sellActionTag).toBe(SELL_LATE_TAG);
    expect(it0.dragonRank).toBe(null);          // 今日未成组 ⇒ 无龙位 ⇒ 非龙头（2% 门槛）
    expect(it0.aucShareScopeText).toContain('非龙头');
  });

  it('⑤ 华阳国际（龙三，非龙头，占比 1.8% < 2%）→ 【竞价卖】', () => {
    const rows = topic6(30, '华阳国际');        // pct 30 ⇒ 龙一？改造成龙三见下
    // 精确造龙三：两只比它高的
    const r = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0),
      R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('华阳国际', 'T1', 20, -1.3, 4.31, 1.8, VR_DIR_DOWN),
      R('低甲', 'T1', 10, 0.5, 1, 1.0)
    ];
    expect(rows.length).toBe(6);
    const plan = sell(
      [R('华阳国际', 'T1', 20, -1.3, 4.31, 1.8, VR_DIR_DOWN)],
      { memberRows: r, prevDragonNames: new Set(['别的股票']) }
    );
    const it0 = itemOf(plan, '华阳国际');
    expect(it0.dragonRank).toBe(3);
    expect(it0.sellActionTag).toBe(SELL_OUT_TAG);
    expect(it0.aucSharePass).toBe(false);
  });

  it('⑥ 花溪科技（今天又进买点，占比 3.6%）→ 【持有】（不是先卖后买）', () => {
    const rows = topic6(1, '花溪科技');
    const plan = sell(
      [R('花溪科技', 'T1', 1, -5.02, 50, 3.6, VR_DIR_DOWN)],
      {
        memberRows: rows,
        prevDragonNames: new Set(['花溪科技']),
        todayBuyNames: new Set(['花溪科技'])
      }
    );
    const it0 = itemOf(plan, '花溪科技');
    expect(it0.sellActionTag).toBe(HOLD_TAG);
    expect(it0.buyActionTag).toBe('');        // ⛔ 用户明确「而不是先卖后买」
    expect(it0.sellHint).toBe(null);          // 占比有数据 ⇒ 旧口径让路
  });

  it('⑦ 楚天龙 9/3（龙一 / 占比 2.5% 不达标 + 今天又进买点）→ 【竞价卖（先卖后买）】，⛔ 不给【持有】', () => {
    // 用户原话（2026-10-03 / 10-04）：「占比2.5不达标。所以应该是竞价卖。……卖点方面，提示持有标签……
    //   应该去掉持有。」「因为它是龙一，按照占比3.5%的标准，它不合格」
    // 🔴 [DRAGON-SWAP 2026-10-06 进一步细化] 标签升级为【竞价卖（先卖后买）】——
    //   用户原话：「在楚天龙卖点标签应该是'竞价卖（先卖后买）'，有这个标签后，说明当天这只票
    //     还是是强的，没有倒下，龙版传媒就要标上'持有'，而不是现在的'竞价卖'。」
    const rows = [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN), ...F('T1', 3)];
    const plan = sell(
      [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN)],
      {
        memberRows: rows,
        todayBuyNames: new Set(['楚天龙'])       // 同时进了买点 —— 旧实现会标【持有】
      }
    );
    const it0 = itemOf(plan, '楚天龙');
    expect(it0.dragonRank).toBe(1);              // 龙一 ⇒ 龙头门槛 3.5%
    expect(it0.aucSharePass).toBe(false);        // 2.5% < 3.5% ⇒ 不达标
    expect(it0.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
    expect(it0.sellActionTag).toBe('竞价卖（先卖后买）');
    expect(it0.sellActionTag).not.toBe(SELL_OUT_TAG);   // ⛔ 不是【纯竞价卖】
    expect(it0.sellActionTag).not.toBe(HOLD_TAG);
    expect(it0.sellActionTone).toBe('swap');     // 紫 —— 与买点侧【尾盘买（先卖后买）】同一个类
    expect(it0.holdTag).toBe('');                // ⛔ 不再标【持有】
    expect(it0.sellHint).toBe(null);             // 占比有数据 ⇒ 旧口径让路
    expect(it0.actionNote).toContain('先卖后买');
    expect(it0.actionNote).toContain('不算「前排倒下」');
    expect(it0.aucFollowDragon).toBe(false);     // 龙一自己不是「跟龙」
  });

  it('⑦-反例：占比【达标】+ 今天又进买点 ⇒ 仍是【持有】（花溪科技 9/2 3.6%）—— 见上一条 ⑥', () => {
    const rows = topic6(1, '甲');
    const plan = sell(
      [R('甲', 'T1', 1, -5.02, 50, 4.4, VR_DIR_DOWN)],
      {
        memberRows: rows,
        prevDragonNames: new Set(['甲']),
        todayBuyNames: new Set(['甲'])
      }
    );
    expect(itemOf(plan, '甲').sellActionTag).toBe(HOLD_TAG);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ 9/3 楚天龙 · 「买点 + 卖点【同时存在】」的对照（用户原话逐条对齐）
   用户原话（2026-10-03 与 2026-10-04 两次）：
     「楚天龙，昨有买入，当天进去决策看板的买点，同时进入卖点，两个同时存在。……
       占比2.5不达标。所以应该是竞价卖。同时它有进了买点那里。那就尾盘买。」
     「把持有标签去掉，改成我要求的标签，逻辑不变的，后排选手占比要求大于2%没错啊，
       我只说那个买点和卖点的持有标签，要去掉……因为它是龙一，按照占比3.5%的标准，
       它不合格，它当天的占比显示只有2.5%，所以卖点那里，是竞价卖，
       但是它又进了今天的买点，所以尾盘买（先卖后买）。」
   ⛔ 本条只改【标签】—— 门槛（龙头 3.5% / 其余 2%）、公式、精度一律不动。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/3 楚天龙：买点 + 卖点同时存在时的标签（逻辑不变，只去掉【持有】）', () => {
  // 楚天龙 = 今日龙一 ⇒ 龙头门槛 3.5%；占比 2.5% ⇒ 不达标
  const ROWS = function() {
    return [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN), ...F('T1', 3)];
  };
  const OPTS = function() {
    return {
      prevBoughtNames: new Set(['楚天龙']),   // 昨有买入 ⇒ 卖点候选里一定有它
      prevBuyNames: new Set(['楚天龙'])       // 昨天也在买点里 ⇒ ③ 本来会标【持有】
    };
  };

  it('买点行 → 只剩【尾盘买（先卖后买）】一枚（【持有】与行尾仓位都去掉）', () => {
    const plan = buy(ROWS(), OPTS());
    const p = pickOf(plan, '楚天龙');
    expect(p.dragonRank).toBe(1);
    expect(p.aucShareText).toBe('2.5%');
    expect(p.aucSharePass).toBe(false);
    expect(p.buyActionTag).toBe('尾盘买（先卖后买）');
    expect(p.holdTag).toBe('');                 // ③ 的【持有】去掉
    expect(p.position).toBe('');                // 行尾仓位【持有】去掉
    expect(p.positionTone).toBe('');
    // 块级说明也【不许】再说这一只「强势股，可持有」（否则与行内打架）
    expect(allBlockNotes(plan)).not.toContain('强势股，可【' + HOLD_TAG + '】');
  });

  it('卖点行 → 【竞价卖（先卖后买）】（不是【持有】，也不是【纯竞价卖】）', () => {
    const plan = sell(
      [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN)],
      { memberRows: ROWS(), todayBuyNames: new Set(['楚天龙']) }
    );
    const it0 = itemOf(plan, '楚天龙');
    expect(it0.dragonRank).toBe(1);
    expect(it0.aucShareText).toBe('2.5%');
    // 与买点侧的【尾盘买（先卖后买）】成对：开盘先卖、尾盘接回
    expect(it0.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
    expect(it0.sellActionTag).not.toBe(HOLD_TAG);
    expect(it0.sellActionTag).not.toBe(SELL_OUT_TAG);
    expect(it0.sellActionTone).toBe('swap');
    expect(it0.holdTag).toBe('');
    expect(it0.sellHint).toBe(null);
  });

  it('只改标签：门槛与判定没动（龙头仍是 3.5% / 其余仍是 2%，公式与精度不变）', () => {
    expect(AUCTION_SHARE_FRONT_MIN).toBe(3.5);
    expect(AUCTION_SHARE_BACK_STD).toBe(2);
    expect(auctionShareThresholdOf(true)).toBe(3.5);
    expect(auctionShareThresholdOf(false)).toBe(2);
    expect(computeAuctionShare(25, 1000)).toBe(2.5);      // 25/1000 = 2.5%
    expect(formatAuctionShare(2.5)).toBe('2.5%');
    // 后排：2.6% ≥ 2% ⇒ 依然达标（用户口径「后排选手占比要求大于2%没错」）
    expect(passesAuctionShare(2.6, false)).toBe(true);
    // 龙头：2.5% < 3.5% ⇒ 不达标（楚天龙就是这一档）
    expect(passesAuctionShare(2.5, true)).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [FOLLOW-DRAGON 2026-10-05 用户口径 · 9/9 国芳集团 + 安记食品] 同题材龙一限制
   用户原话：「9月9日，决策看板，卖点，大消费题材，有两只票，一只是国芳集团，龙一（前排），
     提示竞价卖（正确的），一只是安记食品，龙九（后排），提示尾盘卖（错误的，规则没有错，
     但是还需要添加规则）。……如果同个题材前排倒下，后排是避免不了下跌的。因为他们是同类的。
     相当于将军倒下了，士兵不会幸免。……应该和龙一绑定在一起，标签是'跟龙竞价卖'，
     这样好区分点，也符合逻辑。……如果不是同题材，和原来一样……只是在原来规则⑦的基础上，
     加上这条优先规则，规则⑦要让路。」
   ⛔ 只加这一条优先规则 —— 门槛（龙头 3.5% / 其余 2%）、公式、精度、其它规则一律不动。
   🔴 [DRAGON-SWAP 2026-10-06 补充] 本轮把「龙一倒下」的判据【收紧】为：
     龙一的卖点标签必须是【纯「竞价卖」】（= 占比不达标【且】龙一今天没进买点）。
     国芳集团 9/9 当天【没有】进买点 ⇒ 判据与下面的用例都不变；
     龙一带「（先卖后买）」的情形见下面 9/3 龙版传媒那一组用例。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/9 大消费：同题材龙一限制（优先规则，规则⑦让路）', () => {
  // 9 只的「大消费」题材：国芳集团十日涨幅最高 ⇒ 龙一；安记食品最低 ⇒ 龙九。
  // ⛔ 龙位由真实实现（rankDragons）算出来，不手搓中间态。
  function daxfRows(guofangShare, anjiShare) {
    const rows = [R('国芳集团', '大消费', 50, 0.8, 1, guofangShare)];
    for (let i = 0; i < 7; i++) rows.push(R('大消费填充' + (i + 1), '大消费', 45 - i, 0.5, 1, 1.0));
    rows.push(R('安记食品', '大消费', 5, -0.6, 1, anjiShare));
    return rows;
  }
  // 卖点候选 = 昨日打过「买」标签的股票 ⇒ 这里就是国芳集团 + 安记食品两只
  function daxfSell(guofangShare, anjiShare, opts) {
    const o = opts || {};
    return sell(
      [
        R('国芳集团', '大消费', 50, 0.8, 1, guofangShare),
        R('安记食品', '大消费', 5, -0.6, 1, anjiShare)
      ],
      {
        memberRows: o.memberRows || daxfRows(guofangShare, anjiShare),
        prevDragonNames: o.prevDragonNames || new Set(['别的股票']),
        todayBuyNames: o.todayBuyNames || null
      }
    );
  }

  it('① 国芳集团（龙一，占比 2.5% < 3.5%）→ 【竞价卖】（规则⑦自己的结论，不被优先规则改写）', () => {
    const g = itemOf(daxfSell(2.5, 3.0), '国芳集团');
    expect(g.dragonRank).toBe(1);
    expect(g.aucShareText).toBe('2.5%');
    expect(g.aucSharePass).toBe(false);
    expect(g.sellActionTag).toBe(SELL_OUT_TAG);
    expect(g.aucFollowDragon).toBe(false);       // ⛔ 龙一自己不是「跟龙」
  });

  it('② 安记食品（龙九，自己占比 3.0% 本来够【尾盘卖】）→ 改判【跟龙竞价卖】', () => {
    const a = itemOf(daxfSell(2.5, 3.0), '安记食品');
    expect(a.dragonRank).toBe(9);                // 龙九 = 后排
    expect(a.aucSharePass).toBe(true);           // 自己的占比确实达标（规则没算错，只是要让路）
    expect(a.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(a.sellActionTone).toBe(SELL_ACTION_TONE_FOLLOW);
    expect(a.aucFollowDragon).toBe(true);
    // 行下方说明文字要写清是哪只龙一倒了、以及「规则⑦让路」
    expect(a.actionNote).toContain('国芳集团');
    expect(a.actionNote).toContain('龙一');
    expect(a.actionNote).toContain(RULE_NO.SHARE);
    expect(a.sellHint).toBe(null);               // 占比有数据 ⇒ 旧口径让路
  });

  it('③ 优先于【持有】：安记食品同时进了今天的买点 ⇒ ⛔ 不给【持有】，仍【跟龙竞价卖】', () => {
    const a = itemOf(daxfSell(2.5, 3.0, { todayBuyNames: new Set(['安记食品']) }), '安记食品');
    expect(a.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(a.sellActionTag).not.toBe(HOLD_TAG);
    expect(a.holdTag).toBe('');
  });

  it('④ 非同题材 ⇒ 和原来一样（别题材龙一没倒，本行仍【尾盘卖】）', () => {
    const memberRows = daxfRows(2.5, 3.0).concat([
      R('别龙一', '别的题材', 50, 0.5, 1, 5.0),   // 占比 5.0% ≥ 3.5% ⇒ 没倒 ⇒ 尾盘卖
      R('别甲', '别的题材', 30, 0.5, 1, 1.0),
      R('别后排', '别的题材', 5, 0.5, 1, 3.0)     // 龙三 ⇒ 中军，占比 3.0% ≥ 2% ⇒ 尾盘卖
    ]);
    const plan = sell(
      [
        R('国芳集团', '大消费', 50, 0.8, 1, 2.5),
        R('安记食品', '大消费', 5, -0.6, 1, 3.0),
        R('别龙一', '别的题材', 50, 0.5, 1, 5.0),
        R('别后排', '别的题材', 5, 0.5, 1, 3.0)
      ],
      { memberRows: memberRows, prevDragonNames: new Set(['别的股票']) }
    );
    expect(itemOf(plan, '安记食品').sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(itemOf(plan, '别龙一').sellActionTag).toBe(SELL_LATE_TAG);
    expect(itemOf(plan, '别后排').sellActionTag).toBe(SELL_LATE_TAG);   // 跨题材 ⇒ 一个字不改
  });

  it('⑤ 龙一占比【达标】（没倒）⇒ 后排不跟，各判各的', () => {
    const plan = daxfSell(5.0, 3.0);
    expect(itemOf(plan, '国芳集团').sellActionTag).toBe(SELL_LATE_TAG);
    expect(itemOf(plan, '安记食品').sellActionTag).toBe(SELL_LATE_TAG);
    expect(itemOf(plan, '安记食品').aucFollowDragon).toBe(false);
  });

  it('⑥ §10：龙一占比【缺数据】⇒ 不算倒下，后排仍按规则⑦（【尾盘卖】）', () => {
    const plan = daxfSell(null, 3.0);
    expect(itemOf(plan, '安记食品').sellActionTag).toBe(SELL_LATE_TAG);
    expect(itemOf(plan, '安记食品').aucFollowDragon).toBe(false);
  });

  it('⑦ 龙一【不在今天的卖点候选里】⇒ 不跟（看不到它的结论，就不替它下结论）', () => {
    // memberRows 里国芳集团照旧是龙一、占比 2.5%（倒），但它【不出现在卖点候选】里
    const plan = sell(
      [R('安记食品', '大消费', 5, -0.6, 1, 3.0)],
      { memberRows: daxfRows(2.5, 3.0), prevDragonNames: new Set(['别的股票']) }
    );
    const a = itemOf(plan, '安记食品');
    expect(a.dragonRank).toBe(9);
    expect(a.sellActionTag).toBe(SELL_LATE_TAG);
    expect(a.aucFollowDragon).toBe(false);
  });

  it('⑧ 规则文案：优先规则与 9/9 案例都写进灰色问号面板（两套模式共用同一份卖点条文）', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain(SELL_FOLLOW_DRAGON_TAG);
    expect(lines).toContain('9/9 大消费');
    expect(lines).toContain('国芳集团');
    expect(lines).toContain('安记食品');
    expect(lines).toContain('让路');
    expect(lines).toContain('将军');             // 用户原话的比喻，便于对照
    // legacy（一字模式）的规则面板走同一个 sellRulesLines() ⇒ 也必须带上
    expect(buildRulesLines().join('\n')).toContain(SELL_FOLLOW_DRAGON_TAG);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [DRAGON-SWAP 2026-10-06 用户口径 · 9/3 楚天龙（龙一）+ 龙版传媒（龙四）]
     「9月3日的决策看板，龙版传媒卖点逻辑不对，因为它是龙四，占比8.7%是达标的，
       龙一楚天龙，占比是2.5%，竞价卖，没错。但是买点上是的标签是尾盘买（先卖后买），
       这个也没错，因为它今天也入选了买点。但是影响到后排选手决策的是龙一的"买"，
       楚天龙作为龙一，后面还有标签先卖后买，说明当天还是看好的，不然不会买，
       所以其实将军并没有倒下，所以这个不影响后排选手龙版传媒龙四。
       龙版传媒的标签应该是持有。而不是竞价卖。如果龙一只有竞价卖，不是竞价卖（先卖后买），
       那后排选手就可以那样标竞价卖。……
       所以你要做的就是，在楚天龙卖点标签应该是'竞价卖（先卖后买）'，有这个标签后，
       说明当天这只票还是是强的，没有倒下，龙版传媒就要标上'持有'，而不是现在的'竞价卖'，
       如果龙一卖点标签只有竞价卖，那么没有那个'竞价卖（先卖后买）'的标签，说明真的弱了，
       后排选手也会跟着倒下，就也就跟着'竞价卖'。」
   ⇒ 唯一判据 = 【龙一今天有没有进买点】：
       进 ⇒ 它的标签带「（先卖后买）」⇒ 当天还看好 ⇒ 没倒下 ⇒ 后排【不跟】；
       没进 ⇒ 标签是纯【竞价卖】⇒ 真的弱了 ⇒ 后排【跟】。
   ⛔ 门槛（龙头 3.5% / 其余 2%）、公式、精度、选票一律不动。
   ⚠️ [DRAGON-TIER 2026-10-06] 本组里的「龙版传媒（龙四）」按三分法属【中军】，不是【后排】——
      但它仍然【不跟】带（先卖后买）的龙一（中军跟随龙头走强），结论不变，只是叫法要分清。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/3 楚天龙（龙一）+ 龙版传媒（龙四 = 中军）：龙一「带不带（先卖后买）」决定谁跟', () => {
  // 同一个题材 T1：楚天龙十日涨幅最高 ⇒ 龙一；龙版传媒最低 ⇒ 龙四（后排）。
  // ⛔ 龙位由真实实现（rankDragons）算出来，不手搓中间态。
  function t1Rows() {
    return [
      R('楚天龙', 'T1', 50, -3.36, 7.8, 2.5, VR_DIR_DOWN),
      R('甲二', 'T1', 40, 0.5, 1, 1.0),
      R('乙三', 'T1', 30, 0.5, 1, 1.0),
      R('龙版传媒', 'T1', 20, 1.46, 37.28, 8.7, VR_DIR_DOWN)
    ];
  }
  // 卖点候选 = 昨日打过「买」标签的股票 ⇒ 这里就是楚天龙 + 龙版传媒两只
  function s3(todayBuyNames) {
    return sell(
      [
        R('楚天龙', 'T1', 50, -3.36, 7.8, 2.5, VR_DIR_DOWN),
        R('龙版传媒', 'T1', 20, 1.46, 37.28, 8.7, VR_DIR_DOWN)
      ],
      {
        memberRows: t1Rows(),
        prevDragonNames: new Set(['别的股票']),
        todayBuyNames: todayBuyNames || null
      }
    );
  }
  const BOTH_IN_BUY = new Set(['楚天龙', '龙版传媒']);   // 两只今天都入选了买点
  const ONLY_MAIN_IN_BUY = new Set(['龙版传媒']);        // 只有后排进了买点（龙一没进）

  it('① 龙一楚天龙（占比 2.5% 不达标 + 今天又进买点）→ 【竞价卖（先卖后买）】', () => {
    const c = itemOf(s3(BOTH_IN_BUY), '楚天龙');
    expect(c.dragonRank).toBe(1);                 // 龙一 ⇒ 龙头门槛 3.5%
    expect(c.aucSharePass).toBe(false);           // 2.5% < 3.5%
    expect(c.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
    expect(c.sellActionTag).toBe('竞价卖（先卖后买）');
    expect(c.sellActionTag).not.toBe(SELL_OUT_TAG);   // ⛔ 不是【纯竞价卖】
    expect(c.sellActionTone).toBe('swap');        // 紫 —— 与买点侧【尾盘买（先卖后买）】配对
  });

  it('② 龙版传媒（龙四 = 中军，占比 8.7% ≥ 2% 达标 + 今天又进买点）→ 【持有】（⛔ 不被跟龙带走）', () => {
    const m = itemOf(s3(BOTH_IN_BUY), '龙版传媒');
    expect(m.dragonRank).toBe(4);                 // 龙四 ⇒ 中军（三分法），门槛 2%（非龙头）
    expect(m.aucShareText).toBe('8.7%');
    expect(m.aucSharePass).toBe(true);            // 占比达标
    expect(m.sellActionTag).toBe(HOLD_TAG);       // 用户口径「龙版传媒的标签应该是持有」
    expect(m.sellActionTone).toBe('hold');
    expect(m.aucFollowDragon).toBe(false);        // ⛔ 不是「跟龙竞价卖」
  });

  it('③ 反例（用户口径的另一半）：龙一【只有】纯【竞价卖】⇒ 中军+后排都跟着倒 ⇒ 【跟龙竞价卖】', () => {
    // 楚天龙今天【没】进买点 ⇒ 标签是纯【竞价卖】= 真的弱了 ⇒ 将军倒下 ⇒ 中军+后排都跟卖
    const plan = s3(ONLY_MAIN_IN_BUY);
    const c = itemOf(plan, '楚天龙');
    expect(c.sellActionTag).toBe(SELL_OUT_TAG);           // 纯「竞价卖」（没有「（先卖后买）」）
    expect(c.actionNote).toContain('没有');               // 说明文字要写清「今天没进买点」
    const m = itemOf(plan, '龙版传媒');
    expect(m.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(m.aucFollowDragon).toBe(true);
    expect(m.actionNote).toContain('楚天龙');             // 写清是哪只龙一倒了
  });

  it('④ 判据就是【龙一有没有进买点】这一条：其余输入完全相同，只翻转它 ⇒ 结论翻转', () => {
    const withBuy = s3(BOTH_IN_BUY);
    const noBuy = s3(ONLY_MAIN_IN_BUY);
    expect(itemOf(withBuy, '龙版传媒').sellActionTag).toBe(HOLD_TAG);
    expect(itemOf(noBuy, '龙版传媒').sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    // 后排自己的占比一个字没变 ⇒ 结论差异【只】来自龙一那一枚标签
    expect(itemOf(withBuy, '龙版传媒').aucShareText).toBe(itemOf(noBuy, '龙版传媒').aucShareText);
  });

  it('⑤ 规则文案：新标签与 9/3 这个案例都写进灰色问号面板（两套模式共用同一份卖点条文）', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain(SELL_OUT_SWAP_TAG);
    expect(lines).toContain('龙版传媒 9/3');
    expect(lines).toContain('8.7%');
    expect(lines).toContain('并没有');
    // 买点段也要写出「卖点那边是对应的“竞价卖（先卖后买）”」
    expect(lines).toContain('成对');
    // legacy（一字模式）共用 sellRulesLines() ⇒ 也必须带上
    expect(buildRulesLines().join('\n')).toContain(SELL_OUT_SWAP_TAG);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [DRAGON-TIER 2026-10-06 用户口径 · 9/8 翠微股份（龙二）]
     「9月8日 决策看板，卖点，翠微股份龙二，-2.47%，量比10.35同比减少，占比2.6，
       标签是竞价卖。现在问题把龙二当作前排选手，占比要大于3.5，感觉准确不高，
       如果当作后排选手大于2%，即可满足尾盘卖（当天实际走强，符合实际情况）。」
     「所以规则改下，龙头只有一个，那就是龙一。前排选手是龙二到龙四，
       后排选手就是龙四以下（不包含龙四，比如龙五，龙六，龙七……）」
   ⇒ 门槛【只分两级】：龙头（今日龙一 / 昨日龙头）3.5%；**龙二及以下一律 2%**。
     龙二 2.6% ≥ 2% ⇒ 【尾盘卖】（⛔ 不再是【竞价卖】）。
   ⛔ 公式 / 精度 / 龙位判定（rankDragons）一律不动，只动「谁走哪个门槛」。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/8 翠微股份（龙二）：门槛只分两级 —— 龙二及以下一律 2%', () => {
  // 同一题材 T1：龙一票（占比达标 ⇒ 没倒）+ 翠微股份（龙二）+ 两只更弱的
  function t1Rows(share) {
    return [
      R('龙一票', 'T1', 50, 0.5, 1, 5.0),                            // 龙一，占比 5.0% 达标
      R('翠微股份', 'T1', 40, -2.47, 10.35, share, VR_DIR_DOWN),     // 龙二
      R('后排甲', 'T1', 30, 0.5, 1, 1.0),
      R('后排乙', 'T1', 20, 0.5, 1, 1.0)
    ];
  }
  function s1(share) {
    const rows = t1Rows(share);
    return sell([rows[1]], { memberRows: rows, prevDragonNames: new Set(['别的股票']) });
  }

  it('① 翠微股份（龙二，占比 2.6% ≥ 2%）→ 【尾盘卖】（旧口径算前排、按 3.5% 会误判成【竞价卖】）', () => {
    const c = itemOf(s1(2.6), '翠微股份');
    expect(c.dragonRank).toBe(2);
    expect(c.aucShareText).toBe('2.6%');
    expect(c.aucSharePass).toBe(true);              // 走 2% 门槛 ⇒ 达标
    expect(c.sellActionTag).toBe(SELL_LATE_TAG);
    expect(c.aucShareThresholdText).toContain('2');  // 门槛文案写 2%
    expect(c.aucShareScopeText).toContain('非龙头');  // 龙二 ⇒ 非龙头
    expect(c.aucFollowDragon).toBe(false);           // 龙一没倒 ⇒ 不跟
    expect(c.actionNote).toContain(SELL_LATE_TAG);
  });

  it('② ⛔ 龙二【不】享受 3.5% 门槛：同一只票、同一个 2.6%，只因龙位不同 ⇒ 结论不同', () => {
    // 龙一（同一占比 2.6% < 3.5%）⇒ 不达标 ⇒ 【纯竞价卖】
    const leader = itemOf(sell(
      [R('甲', 'T1', 50, -2.47, 10.35, 2.6, VR_DIR_DOWN)],
      { memberRows: [R('甲', 'T1', 50, -2.47, 10.35, 2.6, VR_DIR_DOWN), ...F('T1', 3)],
        prevDragonNames: new Set(['别的股票']) }
    ), '甲');
    expect(leader.dragonRank).toBe(1);
    expect(leader.aucSharePass).toBe(false);        // 龙头 3.5% ⇒ 2.6% 不达标
    expect(leader.sellActionTag).toBe(SELL_OUT_TAG);
    // 龙二（同一占比 2.6% ≥ 2%）⇒ 达标 ⇒ 【尾盘卖】
    const middle = itemOf(s1(2.6), '翠微股份');
    expect(middle.aucSharePass).toBe(true);
    expect(middle.sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('③ 三分档：龙二 / 龙三 / 龙四 = 中军；龙五及以下 = 后排', () => {
    expect(dragonTierOf(2)).toBe('middle');
    expect(dragonTierOf(3)).toBe('middle');
    expect(dragonTierOf(4)).toBe('middle');
    expect(dragonTierOf(5)).toBe('back');
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [DRAGON-TIER 2026-10-06 用户口径 · 9/9 国芳集团 + 安记食品 的进一步细分]
     「……但是龙二到龙四都要听从龙一指挥，因为这是中军比较强势些（同题材中强度，
       龙头大于中军大于后排，后排最弱），也就是那个龙一（龙头）竞价卖（先卖后买），
       龙头没走弱（还有买），所以准确说中军（前排）一起跟着走强，但是后排（龙五到龙n）
       选手由于龙一提示竞价卖，所以惊慌失措都要跌……中军跟着龙头买，后排跟着龙头卖要分清，
       这个案例要分龙头（龙一），中军，后排，更加清晰。」
   ⇒ 跟龙联动分三层：龙头（龙一）｜ 中军（龙二~龙四）｜ 后排（龙五及以下）
       · 龙一【纯竞价卖】（真的弱了）          ⇒ 中军 + 后排【都跟】；
       · 龙一【竞价卖（先卖后买）】（没走弱）  ⇒ 只有【后排】跟，中军按自己占比判。
   ⛔ 门槛仍是【龙一 3.5% / 其余 2%】—— 三分法只管「跟不跟」，⛔ 不参与门槛。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 三分法跟龙：龙头（龙一）/ 中军（龙二~龙四）/ 后排（龙五及以下）', () => {
  // 同一题材 T1 共 5 只：龙一 + 中军（龙二/龙三/龙四）+ 后排（龙五）。
  // 中军与后排自己的占比都给 3.0%（≥ 2% 达标）⇒ 若「不跟」应各自判【尾盘卖】，
  //   与【跟龙竞价卖】形成清晰对比（⛔ 不给 1.x% 那种「反正都不达标」的糊结果）。
  function t1Rows(leaderShare) {
    return [
      R('龙一票', 'T1', 50, 0.5, 1, leaderShare),   // 龙一
      R('中军二', 'T1', 40, 0.5, 1, 3.0),           // 龙二
      R('中军三', 'T1', 30, 0.5, 1, 3.0),           // 龙三
      R('中军四', 'T1', 20, 0.5, 1, 3.0),           // 龙四
      R('后排五', 'T1', 10, 0.5, 1, 3.0)            // 龙五
    ];
  }
  // 卖点候选 = 全部 5 只（龙一必须在候选里，才看得到它的结论）
  function s1(leaderShare, todayBuyNames) {
    const rows = t1Rows(leaderShare);
    return sell(rows, {
      memberRows: rows,
      prevDragonNames: new Set(['别的股票']),
      todayBuyNames: todayBuyNames || null
    });
  }
  const LEADER_IN_BUY = new Set(['龙一票']);   // 龙一今天也进了买点 ⇒ 它带「（先卖后买）」，没走弱

  it('① 先确认档位本身：龙二 / 龙三 / 龙四 = 中军，龙五 = 后排', () => {
    const m = s1(2.5, null);
    expect(itemOf(m, '中军二').dragonRank).toBe(2);
    expect(itemOf(m, '中军三').dragonRank).toBe(3);
    expect(itemOf(m, '中军四').dragonRank).toBe(4);
    expect(itemOf(m, '后排五').dragonRank).toBe(5);
    expect(dragonTierOf(itemOf(m, '中军二').dragonRank)).toBe('middle');
    expect(dragonTierOf(itemOf(m, '后排五').dragonRank)).toBe('back');
  });

  it('② 龙一【竞价卖（先卖后买）】（2.5% 不达标 + 今天进买点）⇒ 只有【后排】跟，中军各判各的', () => {
    const plan = s1(2.5, LEADER_IN_BUY);
    const g = itemOf(plan, '龙一票');
    expect(g.sellActionTag).toBe(SELL_OUT_SWAP_TAG);            // 龙一：竞价卖（先卖后买）
    // 中军（龙二~龙四）：⛔ 不跟 —— 按自己占比 3.0% 达标 ⇒ 【尾盘卖】
    ['中军二', '中军三', '中军四'].forEach(function(n) {
      const it0 = itemOf(plan, n);
      expect(it0.sellActionTag).toBe(SELL_LATE_TAG);
      expect(it0.aucFollowDragon).toBe(false);
    });
    // 后排（龙五）：跟 —— 同一个占比 3.0%（本来够【尾盘卖】），仍改判【跟龙竞价卖】
    const b = itemOf(plan, '后排五');
    expect(b.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(b.aucFollowDragon).toBe(true);
    expect(b.sellActionTone).toBe(SELL_ACTION_TONE_FOLLOW);
  });

  it('③ 龙一【纯竞价卖】（2.5% 不达标 + 今天没进买点）⇒ 中军 + 后排【都跟】', () => {
    const plan = s1(2.5, null);
    expect(itemOf(plan, '龙一票').sellActionTag).toBe(SELL_OUT_TAG);
    ['中军二', '中军三', '中军四', '后排五'].forEach(function(n) {
      const it0 = itemOf(plan, n);
      expect(it0.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
      expect(it0.aucFollowDragon).toBe(true);
    });
  });

  it('④ 唯一开关就是龙一那枚标签：其余输入一个不动，只翻转「龙一进没进买点」⇒ 中军翻面、后排始终跟', () => {
    const withBuy = s1(2.5, LEADER_IN_BUY);   // 龙一 = 竞价卖（先卖后买）
    const noBuy = s1(2.5, null);              // 龙一 = 纯竞价卖
    expect(itemOf(withBuy, '龙一票').sellActionTag).toBe(SELL_OUT_SWAP_TAG);
    expect(itemOf(noBuy, '龙一票').sellActionTag).toBe(SELL_OUT_TAG);
    // 中军：withBuy 时不跟（尾盘卖）→ noBuy 时跟（跟龙竞价卖）
    expect(itemOf(withBuy, '中军二').sellActionTag).toBe(SELL_LATE_TAG);
    expect(itemOf(noBuy, '中军二').sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    // 后排：两种情形都跟
    expect(itemOf(withBuy, '后排五').sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(itemOf(noBuy, '后排五').sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    // 后排自己的占比一个字没变 ⇒ 差异只来自龙一那一枚标签
    expect(itemOf(withBuy, '后排五').aucShareText).toBe(itemOf(noBuy, '后排五').aucShareText);
  });

  it('⑤ 龙一占比【达标】（没倒）⇒ 三层谁都不跟，各判各的', () => {
    const plan = s1(5.0, null);              // 龙一 5.0% ≥ 3.5% ⇒ 没倒
    expect(itemOf(plan, '龙一票').sellActionTag).toBe(SELL_LATE_TAG);
    ['中军二', '中军三', '中军四', '后排五'].forEach(function(n) {
      expect(itemOf(plan, n).sellActionTag).toBe(SELL_LATE_TAG);
      expect(itemOf(plan, n).aucFollowDragon).toBe(false);
    });
  });

  it('⑥ 中军的跟龙说明文字要写清「听龙一指挥」＋本股是【中军】', () => {
    const plan = s1(2.5, null);
    const n = itemOf(plan, '中军二');
    expect(n.actionNote).toContain('龙一票');            // 哪只龙一倒了
    expect(n.actionNote).toContain('中军');              // 本股档位
    expect(n.actionNote).toContain(RULE_NO.SHARE);       // 规则⑦让路
    expect(n.actionNote).toContain(SELL_FOLLOW_DRAGON_TAG);
  });

  it('⑦ 后排的跟龙说明文字写清【后排】最弱、龙一一提示就先慌', () => {
    const plan = s1(2.5, LEADER_IN_BUY);
    const b = itemOf(plan, '后排五');
    expect(b.actionNote).toContain('后排');
    expect(b.actionNote).toContain('龙一票');
  });
});

describe('卖点：§10 占比缺数据 → 整体回落旧口径', () => {
  it('占比有数据 ⇒ 旧的竞价高低开细分【不再出现】（新规优先，旧规则让路）', () => {
    const rows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    const plan = sell(
      [R('甲', 'T1', 5, -5, 1, 2.6, VR_DIR_DOWN)],   // 深低开（旧口径会给「盯盘」）
      { memberRows: rows, prevDragonNames: new Set(['别的']) }
    );
    const it0 = itemOf(plan, '甲');
    expect(it0.sellActionTag).toBe(SELL_LATE_TAG);
    expect(it0.sellHint).toBe(null);
  });

  it('占比缺数据 ⇒ sellActionTag 为空、回落 sellHint（旧口径照常生效）', () => {
    const rows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    const plan = sell(
      [R('甲', 'T1', 5, -5, 1, null, VR_DIR_DOWN)],
      { memberRows: rows, prevDragonNames: new Set(['别的']) }
    );
    const it0 = itemOf(plan, '甲');
    expect(it0.sellActionTag).toBe('');
    expect(it0.sellHint).not.toBe(null);      // 回落旧的竞价高低开细分
    expect(it0.actionNote).toContain('缺数据');
  });

  it('占比缺数据 + 今天又进买点 + 弱票 ⇒ 仍回落【先卖后买】（旧口径保留）', () => {
    const rows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    const plan = sell(
      [R('甲', 'T1', 5, -5, 1, null, VR_DIR_DOWN)],
      {
        memberRows: rows,
        prevDragonNames: new Set(['别的']),
        todayBuyNames: new Set(['甲'])
      }
    );
    const it0 = itemOf(plan, '甲');
    expect(it0.buyActionTag).toBe(SELL_FIRST_BUY_LATER_TAG);
    expect(it0.holdTag).toBe('');
  });

  it('占比缺数据 + 今天又进买点 + 不弱 ⇒ 持有（旧口径保留）', () => {
    const rows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    const plan = sell(
      [R('甲', 'T1', 5, 1.2, 1, null, VR_DIR_UP)],
      {
        memberRows: rows,
        prevDragonNames: new Set(['别的']),
        todayBuyNames: new Set(['甲'])
      }
    );
    const it0 = itemOf(plan, '甲');
    expect(it0.holdTag).toBe(HOLD_TAG);
    expect(it0.sellActionTag).toBe('');
  });
});

describe('卖点：行内展示字段', () => {
  it('占比徽标 + 动作配色档都由 Logic 层给好', () => {
    const plan = sell([R('甲', '', 1, -6.52, 6.62, 2.6, VR_DIR_UP)]);
    const it0 = itemOf(plan, '甲');
    expect(it0.aucShareText).toBe('2.6%');
    expect(it0.aucShareTone).toBe('meet');
    expect(it0.sellActionTone).toBe('selllate');
    expect(it0.actionNote).toContain('竞价占比 2.6%');
    expect(it0.actionNote).toContain(RULE_NO.SHARE);
  });

  it('配色档：不达标【没进买点】→ out；不达标【进了买点】→ swap；达标 + 进买点 → hold', () => {
    const manyRows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    // 甲 = 龙五 ⇒ 后排，门槛 2% ⇒ 1.8% 不达标 + 没进买点 ⇒ 【纯竞价卖】（绿 out）
    const out = itemOf(sell(
      [R('甲', 'T1', 5, -1.3, 1, 1.8, VR_DIR_DOWN)],
      { memberRows: manyRows, prevDragonNames: new Set(['别的']) }
    ), '甲');
    expect(out.sellActionTag).toBe(SELL_OUT_TAG);
    expect(out.sellActionTone).toBe('out');

    // 🔴 [DRAGON-SWAP 2026-10-06] 不达标 + 今天又进买点 ⇒ 【竞价卖（先卖后买）】（紫 swap）——
    //   与买点侧【尾盘买（先卖后买）】成对；⛔ 既不是 hold，也不是纯 SELL_OUT_TAG。
    //   （2026-10-04 那一版给的是纯 out；用户 9/3 口径进一步细化。）
    const swapToo = itemOf(sell(
      [R('甲', 'T1', 5, -1.3, 1, 1.8, VR_DIR_DOWN)],
      { memberRows: manyRows, prevDragonNames: new Set(['别的']), todayBuyNames: new Set(['甲']) }
    ), '甲');
    expect(swapToo.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
    expect(swapToo.sellActionTone).toBe('swap');

    // 换成【达标】的占比（2.6% ≥ 其余门槛 2%）⇒ 这一档才是 hold
    const hold = itemOf(sell(
      [R('甲', 'T1', 5, -1.3, 1, 2.6, VR_DIR_DOWN)],
      { memberRows: manyRows, prevDragonNames: new Set(['别的']), todayBuyNames: new Set(['甲']) }
    ), '甲');
    expect(hold.sellActionTag).toBe(HOLD_TAG);
    expect(hold.sellActionTone).toBe('hold');
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   四、规则文案（§6：规则与说明同处一处）
   ════════════════════════════════════════════════════════════════════════════════ */

describe('规则文案：占比规则必须写进灰色问号面板（可一键复制）', () => {
  it('买点 / 卖点文案里都有【占比】与规则编号', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain('竞价占比');
    expect(lines).toContain(RULE_NO.SHARE);
    expect(lines).toContain(String(AUCTION_SHARE_FRONT_STD));
    expect(lines).toContain(String(AUCTION_SHARE_FRONT_MIN));
    expect(lines).toContain(String(AUCTION_SHARE_BACK_STD));
    expect(lines).toContain(BUY_NOW_TAG);
    expect(lines).toContain(BUY_LATE_TAG);
    expect(lines).toContain(SELL_LATE_TAG);
    expect(lines).toContain(SELL_OUT_TAG);
    expect(lines).toContain(BUY_LATE_SWAP_TAG);
  });

  it('用户给的案例数值也写进文案里（便于照着对账）', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    ['4.4%', '7.0%', '5.5%', '6.9%', '3.6%', '0.15%', '3.9%', '9.4%', '1.8%', '2.6%', '2.5%'].forEach(function(v) {
      expect(lines).toContain(v);
    });
  });

  it('9/3 楚天龙的新规（先卖后买）也写进文案里', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain('楚天龙 9/3');
    expect(lines).toContain(BUY_LATE_SWAP_TAG);
    // 买点段与卖点段都要写出「占比不达标 ⇒ 不给持有」这条
    expect(lines).toContain('先卖后买');
  });

  it('legacy 模式（一字）的规则文案里也带上了【尾盘买（先卖后买）】', () => {
    const lines = buildRulesLines().join('\n');
    expect(lines).toContain(BUY_LATE_SWAP_TAG);
    expect(lines).toContain('楚天龙 9/3');
  });

  it('一键复制逐行还原（加了分隔线后仍然一字不差）', () => {
    const lines = buildVolRatioRulesLines();
    const back = joinRulesLines(lines).split('\n');
    expect(back.length).toBe(lines.length);
    expect(back).toEqual(lines);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [DIVE-BUY 2026-10-07 用户口径 · 9/7 爱仕达] 中军三项指标【正面异常】⇒【下杀买（竞价异常）】
   用户原话（9/7 爱仕达 = 龙四，与龙一国芳集团同题材）：
     「竞价涨幅高达 9.04%，量比 101.89 同比增长，占比高达 20.2，竞价买，三个指标都是正面反馈没错，
       所有指标都没有错，到这步也没错。但是作为中军选手来说，它属于指标异常了……如果竞价买，
       风险还是很高，因为溢价不是很高，涨停盈利只有 1%，所以竞价买，不是很有性价比，
       等它下杀后买溢价才高……添加标签的话，应该是「下杀买（竞价异常）」，这种一般它先下杀一阵，
       把不坚定的筹码洗掉，然后再涨停的概率非常大。」
     「判断标准，同题材有两只以上（包含两种，一种龙头和一种中军）进入决策买点（说明是大题材），
       龙一符合竞价买。中军选手符合竞价买。中军选手竞价涨幅超过 7% 没有涨停（标准一般 -2% 到 3%），
       竞价量比比上个交易日多 30（一般不超过 20，这是个硬指标，同比减少都不符合），
       占比大于 20%（标准大于 2%），这属于指标正面异常（非负面），这三个指标同时满足。缺一个不行。」
     「像 9 月 8 日的安记食品（也是消费题材有国芳集团龙一入选，安记食品龙七是后排选手）
       不符合这个标准，所以它保持不变，竞价买。」
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/7 爱仕达（龙四 = 中军）：三项指标正面异常 ⇒ 【下杀买（竞价异常）】', () => {
  /**
   * 造一个 7 只的题材「大消费」：
   *   国芳集团（龙一，默认占比 4.0% ≥ 3.5% ⇒ 竞价买）+ 5 只量比很低的中间票 + 目标票（量比 101.89）。
   *   targetPct 决定目标票的龙位：25 ⇒ 龙四（中军）｜-10 ⇒ 龙七（后排）。
   *   ⚠️ 中间票的十日涨幅是 40 / 30 / 20 / 10 / 0 ⇒ 目标票要落在「20 与 30 之间」才是龙四，
   *      写 15 会掉到龙五（后排）—— 【下杀买】只认中军，档位写错用例会静默变成空测。
   *   7 只 ⇒ 中档 ⇒ 取 2 只；量比降序 = 目标票(101.89) ＞ 国芳集团(80) ⇒ 两只都进买点（① 成立）。
   */
  function topicRows(targetName, targetPct, aucPct, share, dir, delta, leaderShare) {
    const rows = [R('国芳集团', '大消费', 50, 0.5, 80,
      (leaderShare === undefined ? 4.0 : leaderShare), VR_DIR_UP)];
    [40, 30, 20, 10, 0].forEach(function(pct, i) {
      rows.push(R('中间' + (i + 1), '大消费', pct, 0.2, 3 - i * 0.1, 1.0));
    });
    rows.push(R(targetName, '大消费', targetPct, aucPct, 101.89, share, dir, delta));
    return rows;
  }
  /** 爱仕达 9/7 的真实数值（可用 extra 逐项改掉某一个指标，做「缺一不行」的反例） */
  function aisida(extra) {
    const o = extra || {};
    return topicRows('爱仕达', 25,
      (o.aucPct === undefined ? 9.04 : o.aucPct),
      (o.share === undefined ? 20.2 : o.share),
      (o.dir === undefined ? VR_DIR_UP : o.dir),
      (o.delta === undefined ? 40 : o.delta),
      o.leaderShare);
  }
  const tagOf = function(rows, name) { return pickOf(buy(rows), name).buyActionTag; };

  it('① 命中：龙头（国芳集团=龙一）+ 中军（爱仕达=龙四）都在买点里，三项指标同时爆表 ⇒ 【下杀买（竞价异常）】', () => {
    const plan = buy(aisida());
    const a = pickOf(plan, '爱仕达');
    expect(a.dragonRank).toBe(4);                        // 龙四 ⇒ 中军
    expect(a.aucPct).toBeCloseTo(9.04);
    expect(a.aucShare).toBeCloseTo(20.2);
    expect(a.volRatioDelta).toBe(40);
    expect(a.aucLimitUp).toBe(false);                    // 9.04% < 10% ⇒ 没涨停
    expect(a.buyActionTag).toBe(BUY_DIVE_TAG);
    expect(a.buyActionTag).toBe('下杀买（竞价异常）');
    expect(a.buyActionTone).toBe('dive');
    // 龙头自己【不受】本档影响 —— 它照旧是【竞价买】（本档只针对中军）
    expect(pickOf(plan, '国芳集团').buyActionTag).toBe(BUY_NOW_TAG);
    // 行内说明要把「为什么」写全（正面异常 / 量化补涨 / 等下杀）
    expect(a.actionNote).toContain(BUY_DIVE_TAG);
    expect(a.actionNote).toContain('正面异常');
    expect(a.actionNote).toContain('量化');
    expect(a.actionNote).toContain(String(DIVE_SHARE_MIN));
  });

  it('② 反例（用户点名）：9/8 安记食品是龙七 =【后排】，指标再异常也不适用 ⇒ 保持【竞价买】', () => {
    const rows = topicRows('安记食品', -10, 9.04, 20.2, VR_DIR_UP, 40);
    const a = pickOf(buy(rows), '安记食品');
    expect(a.dragonRank).toBe(7);                        // 龙七 ⇒ 后排（不是中军）
    expect(a.aucPct).toBeCloseTo(9.04);
    expect(a.aucShare).toBeCloseTo(20.2);
    expect(a.buyActionTag).toBe(BUY_NOW_TAG);            // ⛔ 不变
  });

  it('③ 缺一不行 ①：竞价涨幅只到 6.5%（不 > ' + DIVE_AUC_PCT_MIN + '%）⇒ 仍是【竞价买】', () => {
    expect(tagOf(aisida({ aucPct: 6.5 }), '爱仕达')).toBe(BUY_NOW_TAG);
  });

  it('④ 缺一不行 ②：量比只比上一交易日多 20（不 ≥ ' + DIVE_VOL_RATIO_DELTA_MIN +
    '，硬指标）⇒ 仍是【竞价买】', () => {
    expect(tagOf(aisida({ delta: 20 }), '爱仕达')).toBe(BUY_NOW_TAG);
    // 边界：正好多 30 也【算】（用户口径「多 30」）
    expect(tagOf(aisida({ delta: DIVE_VOL_RATIO_DELTA_MIN }), '爱仕达')).toBe(BUY_DIVE_TAG);
  });

  it('⑤ 缺一不行 ③：占比 18%（不 > ' + DIVE_SHARE_MIN + '%）⇒ 仍是【竞价买】', () => {
    expect(tagOf(aisida({ share: 18 }), '爱仕达')).toBe(BUY_NOW_TAG);
  });

  it('⑥ 【已经涨停】就不算（没有下杀空间）：涨幅 +10.02% ⇒ 仍是【竞价买】', () => {
    const a = pickOf(buy(aisida({ aucPct: 10.02 })), '爱仕达');
    expect(a.aucLimitUp).toBe(true);
    expect(a.buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⑦ §10：量比差值缺数据（null）⇒ 不判本档（缺数据 ≠ 没增加）', () => {
    const a = pickOf(buy(aisida({ delta: null })), '爱仕达');
    expect(a.volRatioDelta).toBe(null);
    expect(a.buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⑧ 前提不成立：龙头（国芳集团）自己占比不达标（2.0% < 3.5%）⇒ 不判本档', () => {
    const plan = buy(aisida({ leaderShare: 2.0 }));
    expect(pickOf(plan, '国芳集团').aucSharePass).toBe(false);
    expect(pickOf(plan, '爱仕达').buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⑨ 前提不成立：同题材只有龙头一只进买点（中军没被选出来）⇒ 不判本档', () => {
    // 目标票量比只有 1.5（排在中量比之后）⇒ 只剩国芳集团一只被选中 ⇒ ① 不成立
    const rows = [R('国芳集团', '大消费', 50, 0.5, 80, 4.0, VR_DIR_UP)];
    [40, 30, 20, 10, 0].forEach(function(pct, i) {
      rows.push(R('中间' + (i + 1), '大消费', pct, 0.2, 3 - i * 0.1, 1.0));
    });
    rows.push(R('中军票', '大消费', 15, 9.04, 1.5, 20.2, VR_DIR_UP, 40));
    const plan = buy(rows);
    expect(pickOf(plan, '国芳集团').buyActionTag).toBe(BUY_NOW_TAG);
    // 「中军票」没被选中 ⇒ 本用例只断言龙头那只没被误改（§10：没选中就不给动作）
    expect(plan.heavy.picks.concat(plan.light ? plan.light.picks : [])
      .some(function(p) { return p.name === '中军票'; })).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════
   ★ [SELL-TEN-MIN 2026-10-07 用户口径 · 9/7 我爱我家] 【10分钟时卖】
   用户原话：
     「卖点 我爱我家龙一，占比很接近 3.5%，它只有 3.2%，竞价量比 9.53 增加，竞价涨幅减少。
       上面两个指标说明（竞价量比同比增加，和相差不大的占比（标准门槛 3.5%），相差在 0.5% 左右，
       所以要同时满足这两个条件，特别是在占比相差不大的时候，龙一会出现这种情况），盘中有冲高可能。
       如果竞价卖，容易卖飞。应该是 9：40 卖，等 10 分钟，等到时间不管冲不冲高，都要卖的。
       标签应该是「10分钟时卖」」
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/7 我爱我家（今日龙一）：占比差一点点 + 量比增加 ⇒ 【10分钟时卖】', () => {
  // 同一题材 T1 共 5 只：龙一 = 我爱我家（十日涨幅最高）+ 中军（龙二~龙四）+ 后排（龙五）。
  //   中军 / 后排自己的占比都给 3.0%（≥ 2% 达标）⇒ 若「不跟」应各自判【尾盘卖】。
  function t1Rows(leaderShare, leaderDir) {
    return [
      R('我爱我家', 'T1', 50, -0.5, 9.53, leaderShare, leaderDir),
      R('中军二', 'T1', 40, 0.5, 1, 3.0),
      R('中军三', 'T1', 30, 0.5, 1, 3.0),
      R('中军四', 'T1', 20, 0.5, 1, 3.0),
      R('后排五', 'T1', 10, 0.5, 1, 3.0)
    ];
  }
  function s(leaderShare, leaderDir, todayBuyNames) {
    const rows = t1Rows(leaderShare, leaderDir);
    return sell(rows, {
      memberRows: rows,
      prevDragonNames: new Set(['别的股票']),
      todayBuyNames: todayBuyNames || null
    });
  }

  it('① 命中：龙一占比 3.2%（离门槛 3.5% 只差 0.3%）＋ 量比增加 ⇒ 【10分钟时卖】（不是竞价卖）', () => {
    const x = itemOf(s(3.2, VR_DIR_UP), '我爱我家');
    expect(x.dragonRank).toBe(1);
    expect(x.aucShareText).toBe('3.2%');
    expect(x.aucSharePass).toBe(false);              // 3.2% < 3.5% ⇒ 不达标
    expect(x.sellActionTag).toBe(SELL_TEN_MIN_TAG);
    expect(x.sellActionTag).toBe('10分钟时卖');
    expect(x.sellActionTone).toBe(SELL_ACTION_TONE_TEN_MIN);
    expect(x.actionNote).toContain(SELL_TIME_TEN_MIN);   // 9:40
    expect(x.actionNote).toContain('卖飞');
    expect(x.sellHint).toBe(null);                   // 占比有数据 ⇒ 旧口径让路
  });

  it('② 只满足一半（占比差一点点，但量比【下降】）⇒ 照旧【竞价卖】', () => {
    expect(itemOf(s(3.2, VR_DIR_DOWN), '我爱我家').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('③ 只满足一半（占比差一点点，但量比【基本平】）⇒ 照旧【竞价卖】', () => {
    expect(itemOf(s(3.2, VR_DIR_FLAT), '我爱我家').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('④ 占比差得多（2.5%，离门槛差 1.0%）＋ 量比增加 ⇒ 照旧【竞价卖】（不是差一点点）', () => {
    expect(itemOf(s(2.5, VR_DIR_UP), '我爱我家').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('⑤ 边界：正好差 ' + SELL_TEN_MIN_GAP + '%（占比 3.0%）⇒ 命中；差 0.6%（2.9%）⇒ 不命中', () => {
    expect(itemOf(s(3.0, VR_DIR_UP), '我爱我家').sellActionTag).toBe(SELL_TEN_MIN_TAG);
    expect(itemOf(s(2.9, VR_DIR_UP), '我爱我家').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('⑥ 占比【达标】（3.5%）⇒ 走【尾盘卖】，不是本档', () => {
    expect(itemOf(s(3.5, VR_DIR_UP), '我爱我家').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('⑦ 优先级：龙一【也进了买点】⇒ 【竞价卖（先卖后买）】优先，⛔ 不让本档抢走', () => {
    // 买点侧的说明文字直接引用卖点标签名（「开盘先按卖点的【竞价卖（先卖后买）】卖掉」），
    // 本档若抢走会让两侧文案打架 ⇒ 两档同时成立时必须以「先卖后买」为准。
    const x = itemOf(s(3.2, VR_DIR_UP, new Set(['我爱我家'])), '我爱我家');
    expect(x.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
  });

  it('⑧ 只认【今日龙一】：中军（龙二）占比 1.2% + 量比增加 ⇒ 仍是【竞价卖】，不是本档', () => {
    const rows = [
      R('龙头票', 'T1', 50, -0.5, 1, 5.0, VR_DIR_UP),      // 龙一占比达标 ⇒ 不触发跟龙
      R('中军二', 'T1', 40, -0.5, 1, 1.2, VR_DIR_UP),
      R('中军三', 'T1', 30, 0.5, 1, 3.0)
    ];
    const plan = sell(rows, { memberRows: rows, prevDragonNames: new Set(['别的股票']) });
    const m = itemOf(plan, '中军二');
    expect(m.dragonRank).toBe(2);
    expect(m.sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('⑨ 跟龙联动：龙一判本档 ⇒ 说明它【没那么弱】⇒ 只有【后排】跟（中军各判各的）', () => {
    const plan = s(3.2, VR_DIR_UP);
    expect(itemOf(plan, '我爱我家').sellActionTag).toBe(SELL_TEN_MIN_TAG);
    ['中军二', '中军三', '中军四'].forEach(function(n) {
      expect(itemOf(plan, n).sellActionTag).toBe(SELL_LATE_TAG);
      expect(itemOf(plan, n).aucFollowDragon).toBe(false);
    });
    const b = itemOf(plan, '后排五');
    expect(b.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
    expect(b.aucFollowDragon).toBe(true);
    // 跟龙的说明文字要如实写出龙一那一枚标签（本档，不是「先卖后买」）
    expect(b.actionNote).toContain(SELL_TEN_MIN_TAG);
  });
});

describe('规则文案：两条新规则（下杀买 / 10分钟时卖）必须写进灰色问号面板', () => {
  it('买点段写出【下杀买（竞价异常）】的四个条件与 9/7 / 9/8 两个案例', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain(BUY_DIVE_TAG);
    expect(lines).toContain(String(DIVE_AUC_PCT_MIN));
    expect(lines).toContain(String(DIVE_VOL_RATIO_DELTA_MIN));
    expect(lines).toContain(String(DIVE_SHARE_MIN));
    expect(lines).toContain('爱仕达');
    expect(lines).toContain('安记食品');
  });

  it('卖点段写出【10分钟时卖】的两个条件与 9:40', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain(SELL_TEN_MIN_TAG);
    expect(lines).toContain(SELL_TIME_TEN_MIN);
    expect(lines).toContain('我爱我家');
    expect(lines).toContain(String(SELL_TEN_MIN_GAP));
  });

  it('legacy（一字）文案也带上【下杀买（竞价异常）】—— 两套模式共用同一份买卖时机实现', () => {
    const lines = buildRulesLines().join('\n');
    expect(lines).toContain(BUY_DIVE_TAG);
    expect(lines).toContain(SELL_TEN_MIN_TAG);
  });
});
