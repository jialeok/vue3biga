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
  // [MAKEUP-BUY 2026-10-08 用户口径 · 9/15 华正新材] 被达标龙一带动的补涨 ⇒ 补涨竞价买
  BUY_MAKEUP_TAG,
  BUY_ACTION_TONE_MAKEUP,
  MAKEUP_AUC_PCT_MIN,
  MAKEUP_STREAK,
  // [BOARD-RISK 2026-10-07 用户口径] 买点行【创业板 / 科创板风险极高】：文案常量 + 板块取文案的函数
  BOARD_RISK_TAG_GROWTH,
  BOARD_RISK_TAG_STAR,
  BOARD_RISK_TONE,
  boardRiskTagOf,
  POSITION_HEAVY,
  POSITION_LIGHT,
  POSITION_HOLD,
  // [SELL-TEN-MIN 2026-10-07 用户口径 · 9/7 我爱我家] 龙一占比差一点点 + 量比增加 ⇒ 10分钟时卖
  SELL_TEN_MIN_TAG,
  SELL_ACTION_TONE_TEN_MIN,
  SELL_TIME_TEN_MIN,
  SELL_TEN_MIN_GAP,
  // [SELL-LIMIT-UP 2026-10-07 用户口径] 竞价一字涨停 ⇒ 竞价就走、落袋为安
  SELL_LIMIT_UP_TAG,
  SELL_ACTION_TONE_LIMIT_UP,
  SELL_ACTION_TONE_OUT,
  // [DRAGON-YIZI-HOLD 2026-10-08 用户口径 · 泛微网络 8/5] 龙一一字涨停 ⇒ 中军 / 后排【龙一字持有】
  DRAGON_YIZI_HOLD_TAG,
  SELL_ACTION_TONE_YIZI_HOLD,
  BUY_ACTION_TONE_YIZI_HOLD,
  isAuctionYiZiRow,
  sellRulesLines,
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
// [BOARD-RISK 2026-10-07] 板块判定复用早盘竞价的唯一实现（⛔ 测试也【不许】手写 /^30|68/ 前缀，
//   否则测的是「另一份口径」，判据被改坏也测不出来）。
import { getBoardKind, BOARD_BJ } from '../auction/limit-up.js';

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
 * @param {string} [code] 6 位股票代码 —— [BOARD-RISK 2026-10-07] 创业板 / 科创板风险提示要靠它判板块。
 *        ⚠️ 不传一律写 ''（= 缺代码）⇒ 该票【不标】风险提示（§10 绝不凭股票名猜板块）。
 */
function R(name, topic, pct, aucPct, volRatio, share, dir, delta, code) {
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: false,
    countable: true,
    code: (code === undefined || code === null) ? '' : code,
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
      aucShare: r.aucShare,
      // [SELL-LIMIT-UP 2026-10-07] 代码透传：判「竞价是不是涨停」要靠它（涨停幅度按板块分）。
      //   ⛔ 与线上 sellRows 同结构（decision-collect.js 也是这么透传的）。
      code: r.code || ''
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
   ★ [DIVE-BUY 2026-10-07 用户口径 · 9/7 爱仕达] 非龙头三项指标【正面异常】⇒【下杀买（竞价异常）】
   用户原话（9/7 爱仕达，与龙一国芳集团同题材）：
     「竞价涨幅高达 9.04%，量比 101.89 同比增长，占比高达 20.2，竞价买，三个指标都是正面反馈没错，
       所有指标都没有错，到这步也没错。但是作为中军选手来说，它属于指标异常了……如果竞价买，
       风险还是很高，因为溢价不是很高，涨停盈利只有 1%，所以竞价买，不是很有性价比，
       等它下杀后买溢价才高……添加标签的话，应该是「下杀买（竞价异常）」，这种一般它先下杀一阵，
       把不坚定的筹码洗掉，然后再涨停的概率非常大。」
     「判断标准，同题材有两只以上（包含两种，一种龙头和一种中军）进入决策买点（说明是大题材），
       龙一符合竞价买。中军选手符合竞价买。中军选手竞价涨幅超过 7% 没有涨停（标准一般 -2% 到 3%），
       竞价量比比上个交易日多 30（一般不超过 20，这是个硬指标，同比减少都不符合），
       占比大于 20%（标准大于 2%），这属于指标正面异常（非负面），这三个指标同时满足。缺一个不行。」
   🔴 [DIVE-TUNE 2026-10-07 复核实测后用户拍板] 两处口径以【真实数据 + 用户拍板】为准：
     ① 龙位：9/7 爱仕达【实测是龙五】（十日涨幅 33.73，排在云南旅游 36.4 之后；用户界面显示龙六），
        不是记忆里的「龙四」。旧实现限定「中军 = 龙二~龙四」⇒ 会静默漏掉它。
        用户拍板：「从龙二以下（包含龙二），都可以覆盖」⇒ 条件②改为【只要不是龙一】。
     ② 量比整数差：实测 +29（101.89→102，73.18→73）⇒ 阈值由 30 放宽为【20】（用户拍板）。
     ③ 条件①「龙头 + 中军都进买点」【保持】—— 一字模式 9/7 的 picks 里
        【国芳集团确实入选】（占比 3.5%，刚好达 3.5% 门槛）；
        ⛔ 别拿「题材竞价量比」模式的数据来判断本档。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/7 爱仕达（实测龙五 = 非龙头）：三项指标正面异常 ⇒ 【下杀买（竞价异常）】', () => {
  /**
   * 造一个 7 只的题材「大消费」：
   *   国芳集团（龙一，默认占比 4.0% ≥ 3.5% ⇒ 竞价买）+ 5 只量比很低的中间票 + 目标票（量比 101.89）。
   *   targetPct 决定目标票的龙位：15 ⇒ 龙五（与 9/7 爱仕达实测一致）｜-10 ⇒ 龙七。
   *   ⚠️ 中间票的十日涨幅是 40 / 30 / 20 / 10 / 0 ⇒ 目标票写 15 落在「10 与 20 之间」⇒ 龙五；
   *      写 25 会变成龙四。
   *      🔴 本档现已【不挑龙位】（只要不是龙一），但用例仍要写对龙位 ——
   *        否则「断言 dragonRank」的用例会因为写错档位而误通过 / 误失败。
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
    return topicRows('爱仕达', 15,   // 15 ⇒ 落在「10 与 20 之间」⇒ 龙五（与 9/7 实测一致）
      (o.aucPct === undefined ? 9.04 : o.aucPct),
      (o.share === undefined ? 20.2 : o.share),
      (o.dir === undefined ? VR_DIR_UP : o.dir),
      (o.delta === undefined ? 40 : o.delta),
      o.leaderShare);
  }
  const tagOf = function(rows, name) { return pickOf(buy(rows), name).buyActionTag; };

  it('① 命中：龙头（国芳集团=龙一）+ 爱仕达（龙五 = 非龙头，与 9/7 实测一致）都在买点里，' +
    '三项指标同时爆表 ⇒ 【下杀买（竞价异常）】', () => {
    const plan = buy(aisida());
    const a = pickOf(plan, '爱仕达');
    expect(a.dragonRank).toBe(5);                        // 龙五 = 非龙头（9/7 实测）
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

  it('② [DIVE-TUNE 2026-10-07 用户拍板] 本档【不再排除后排】：龙七指标同样爆表 ⇒ 也打【下杀买（竞价异常）】', () => {
    const rows = topicRows('安记食品', -10, 9.04, 20.2, VR_DIR_UP, 40);
    const a = pickOf(buy(rows), '安记食品');
    expect(a.dragonRank).toBe(7);                        // 龙七（旧口径的「后排」）
    expect(a.aucPct).toBeCloseTo(9.04);
    expect(a.aucShare).toBeCloseTo(20.2);
    // 依据：9/7 爱仕达实测龙五 / 界面显示龙六 ⇒ 用户拍板「从龙二以下（包含龙二），都可以覆盖」
    expect(a.buyActionTag).toBe(BUY_DIVE_TAG);
  });

  it('②b 仍然【排除龙一】：龙头自己三项指标也爆表 ⇒ 仍保持【竞价买】（本档只针对非龙头）', () => {
    const rows = [R('国芳集团', '大消费', 50, 9.04, 101.89, 20.2, VR_DIR_UP, 40)];
    [40, 30, 20, 10, 0].forEach(function(pct, i) {
      rows.push(R('中间' + (i + 1), '大消费', pct, 0.2, 3 - i * 0.1, 1.0));
    });
    rows.push(R('爱仕达', '大消费', 15, 9.04, 9.5, 20.2, VR_DIR_UP, 40));
    const plan = buy(rows);
    const g = pickOf(plan, '国芳集团');
    expect(g.dragonRank).toBe(1);
    expect(g.buyActionTag).toBe(BUY_NOW_TAG);            // ⛔ 龙头强是应该的，不改标
    expect(pickOf(plan, '爱仕达').buyActionTag).toBe(BUY_DIVE_TAG);  // 非龙头那只照打本档
  });

  it('③ 缺一不行 ①：竞价涨幅只到 6.5%（不 > ' + DIVE_AUC_PCT_MIN + '%）⇒ 仍是【竞价买】', () => {
    expect(tagOf(aisida({ aucPct: 6.5 }), '爱仕达')).toBe(BUY_NOW_TAG);
  });

  it('④ 缺一不行 ②：量比只比上一交易日多 ' + (DIVE_VOL_RATIO_DELTA_MIN - 1) +
    '（不 ≥ ' + DIVE_VOL_RATIO_DELTA_MIN + '，硬指标）⇒ 仍是【竞价买】', () => {
    expect(tagOf(aisida({ delta: DIVE_VOL_RATIO_DELTA_MIN - 1 }), '爱仕达')).toBe(BUY_NOW_TAG);
    // 边界：正好差 DIVE_VOL_RATIO_DELTA_MIN 也【算】
    expect(tagOf(aisida({ delta: DIVE_VOL_RATIO_DELTA_MIN }), '爱仕达')).toBe(BUY_DIVE_TAG);
    // 真实值校验：9/7 爱仕达实测 +29（101.89→102，73.18→73）⇒ 命中本档
    expect(tagOf(aisida({ delta: 29 }), '爱仕达')).toBe(BUY_DIVE_TAG);
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

  it('⑨ 前提不成立：同题材只有龙头一只进买点（非龙头没被选出来）⇒ 不判本档', () => {
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
   ★ [MAKEUP-BUY 2026-10-08 用户口径 · 9/15 华正新材] 【补涨竞价买】
   用户原话：
     「9月15日，华正新材就是补涨，补涨的意思就是占比不达标它只有 1.5%，竞价量比也不高只有 3.24
       同比减少，竞价涨幅却达到 4.5%，也就是被龙一超声电子带动的，超声电子当天占比达 4.5%，
       入了决策买点，电子/通信/算力题材是显示是二次入选，当天就是超声电子和华正新材入选决策买点。
       华正新材只有竞价涨幅是正向的，其它不达标。这足以说明华正新材就是补涨……
       所以应该打的标签是"补涨竞价买"」
   四条判据（缺一不行）：
     ① 同题材当天入选买点的票【只有龙一 + 中军】两只（夹带任何后排 ⇒ 不算）；
     ② 该题材【恰好二次入选】（用户口径「三次就有可能不准了……现在限定是二次入选」）；
     ③ 该题材【龙一占比达标】（≥ 3.5%）；
     ④ 中军那只【竞价涨幅 > 3%】，其它重要指标（占比 / 竞价量比）可以不达标。
   ⚠️ 9/18 中新赛克是【反例】：涨幅 1.54% ≤ 3% ⇒ 按原规则处理（轻仓 + 尾盘买），不变。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/15 华正新材（龙二 = 中军）：被达标龙一带起来的补涨 ⇒ 【补涨竞价买】', () => {
  /**
   * 造题材 T1（8 只 ⇒ 中档 ⇒ 一个块里正好选出 2 只，构成【龙一 + 中军】）。
   * 十日涨幅序：超声电子 55（龙一）> 华正新材 47（龙二 = 中军）> 其余 40/35/30/25/20/15（龙三~龙八）。
   * 竞价量比序：超声电子 8.56 > 华正新材 3.24 > 其余（2.9 ~ 2.4）⇒ 选票正好落在前两只。
   * 超声电子占比 4.5%（龙头门槛 3.5%）⇒ 达标 ⇒ 【竞价买】；
   * 华正新材占比 1.5%（非龙头门槛 2%）⇒ 不达标 ⇒ 落到本档去判。
   * @param {object} [o] 逐项改掉某个判据做「缺一不行」的反例
   */
  function makeupRows(o) {
    const c = o || {};
    return [
      R('超声电子', 'T1', 55, 1.64, 8.56,
        (c.leaderShare === undefined ? 4.5 : c.leaderShare), VR_DIR_DOWN, -5),
      R('华正新材', 'T1', 47,
        (c.midAucPct === undefined ? 4.81 : c.midAucPct), 3.24, 1.5, VR_DIR_DOWN, -1),
      R('凑1', 'T1', 40, 0, 2.9, 1.1),
      R('凑2', 'T1', 35, 0, 2.8, 1.1),
      R('凑3', 'T1', 30, 0, 2.7, 1.1),
      R('凑4', 'T1', 25, 0, 2.6, 1.1),
      R('凑5', 'T1', 20, 0, 2.5, 1.1),
      R('凑6', 'T1', 15, 0, 2.4, 1.1)
    ];
  }
  /**
   * 题材入选次数 = past + 1（今天这一次）。past=1 ⇒ 二次入选；past=2 ⇒ 三次入选。
   * @param {number|null} past 过去窗口内的次数；null = 不提供（模拟 topicStreakPast 未加载）
   */
  function streakOpts(past) {
    return past === null ? {} : { topicStreakPast: new Map([['T1', past]]) };
  }
  const planOf = function(past, extra) { return buy(makeupRows(extra), streakOpts(past)); };
  const hz = function(plan) { return pickOf(plan, '华正新材'); };

  it('① 命中：二次入选 + 龙一占比达标 + 买点只有【龙一 + 中军】+ 中军涨幅 > ' +
    MAKEUP_AUC_PCT_MIN + '% ⇒ 【补涨竞价买】', () => {
    const plan = planOf(MAKEUP_STREAK - 1);
    expect(plan.heavy.picks.length).toBe(2);              // 只有超声电子 + 华正新材两只
    const h = hz(plan);
    expect(h.dragonRank).toBe(2);                         // 中军（龙二）—— 9/15 实测位次
    expect(h.aucPct).toBeCloseTo(4.81);                   // 唯一的正向指标
    expect(h.aucShare).toBeCloseTo(1.5);                  // 占比【不达标】（< 2%）
    expect(h.volRatioDelta).toBe(-1);                     // 竞价量比同比【减少】
    expect(h.buyActionTag).toBe(BUY_MAKEUP_TAG);
    expect(h.buyActionTag).toBe('补涨竞价买');
    expect(h.buyActionTone).toBe(BUY_ACTION_TONE_MAKEUP);
    // 行内说明要把「凭什么不按常规」写全
    expect(h.actionNote).toContain(BUY_MAKEUP_TAG);
    expect(h.actionNote).toContain('补涨');
    expect(h.actionNote).toContain('二次入选');
    expect(h.actionNote).toContain(String(MAKEUP_AUC_PCT_MIN));
    // ⛔ 本档【只换动作】：行尾仓位照旧（仍是今天的买点票，只是不等尾盘）
    expect(h.position).toBe('轻仓');
    // 龙头自己不受本档影响 —— 它占比达标，照旧【竞价买】
    expect(pickOf(plan, '超声电子').buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('⓪ 题材入选次数的【数字真相】落到块上：past=1 ⇒ topicStreakN=2（与题材行显示同源）', () => {
    expect(planOf(MAKEUP_STREAK - 1).heavy.topicStreakN).toBe(2);
    expect(planOf(MAKEUP_STREAK - 1).heavy.streakTag).toBe('二次入选');
    expect(planOf(2).heavy.topicStreakN).toBe(3);
    expect(planOf(2).heavy.streakTag).toBe('三次入选');
    // §10：pastCounts 未加载 ⇒ 索引压根不在（undefined），不是 0
    expect(planOf(null).heavy.topicStreakN).toBe(undefined);
    expect(planOf(null).heavy.streakTag).toBe(undefined);
  });

  it('② 缺一不行 ①：题材是【三次入选】⇒ 不判本档（用户口径「三次就有可能不准了」）', () => {
    const plan = planOf(MAKEUP_STREAK);                   // past=2 ⇒ 含今日共 3 次
    expect(plan.heavy.topicStreakN).toBe(3);
    expect(hz(plan).buyActionTag).toBe(BUY_LATE_TAG);     // 回落普通【尾盘买】
  });

  it('②b §10：题材入选次数【未加载】⇒ 不判本档（未知 ≠ 二次入选）', () => {
    expect(hz(planOf(null)).buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('③ 缺一不行 ②：龙一（超声电子）自己占比【不达标】⇒ 不判本档', () => {
    const plan = planOf(MAKEUP_STREAK - 1, { leaderShare: 2.0 });
    expect(pickOf(plan, '超声电子').aucSharePass).toBe(false);
    expect(hz(plan).buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('④ 缺一不行 ③：中军竞价涨幅 1.54%（9/18 中新赛克实测，不 > ' +
    MAKEUP_AUC_PCT_MIN + '%）⇒ 【按原规则处理，不变】= 尾盘买', () => {
    const plan = planOf(MAKEUP_STREAK - 1, { midAucPct: 1.54 });
    const h = hz(plan);
    expect(h.aucPct).toBeCloseTo(1.54);
    expect(h.buyActionTag).toBe(BUY_LATE_TAG);            // ⛔ 不是补涨竞价买
    expect(h.buyActionTone).not.toBe(BUY_ACTION_TONE_MAKEUP);
    // 边界：正好 == MAKEUP_AUC_PCT_MIN 也不算（判据是【大于】）
    expect(hz(planOf(MAKEUP_STREAK - 1, { midAucPct: MAKEUP_AUC_PCT_MIN })).buyActionTag)
      .toBe(BUY_LATE_TAG);
  });

  it('⑤ 缺一不行 ④：买点里混进【后排】⇒ 不判本档（用户原话「如果还有后排其它票那就不算了」）', () => {
    // 10 只 ⇒ 大档 ⇒ 一个块选 3 只；把第 3 名的量比给一只【后排】（龙位 ≥ 5）
    const rows = [
      R('超声电子', 'T1', 55, 1.64, 8.56, 4.5, VR_DIR_DOWN, -5),
      R('华正新材', 'T1', 47, 4.81, 3.24, 1.5, VR_DIR_DOWN, -1),
      R('后排票', 'T1', 5, 4.5, 3.0, 1.5, VR_DIR_DOWN, -1),   // 量比第 3 ⇒ 被选中；十日涨幅最低 ⇒ 龙十
      R('凑1', 'T1', 40, 0, 2.9, 1.1),
      R('凑2', 'T1', 35, 0, 2.8, 1.1),
      R('凑3', 'T1', 30, 0, 2.7, 1.1),
      R('凑4', 'T1', 25, 0, 2.6, 1.1),
      R('凑5', 'T1', 20, 0, 2.5, 1.1),
      R('凑6', 'T1', 15, 0, 2.4, 1.1),
      R('凑7', 'T1', 10, 0, 2.3, 1.1)
    ];
    const plan = buy(rows, streakOpts(MAKEUP_STREAK - 1));
    expect(plan.heavy.picks.length).toBe(3);
    expect(dragonTierOf(pickOf(plan, '后排票').dragonRank)).toBe('back');
    expect(pickOf(plan, '华正新材').buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('⑥ 龙一自己【不适用】本档：题材达标的是龙头，不需要「补涨」这个解释', () => {
    // 让「超声电子」变成中军位、把华正新材顶成龙一，且华正新材也满足四个条件 → 仍不打本档
    const rows = [
      R('华正新材', 'T1', 55, 4.81, 8.56, 1.5, VR_DIR_DOWN, -1),  // 龙一（占比 1.5 不达标）
      R('超声电子', 'T1', 47, 1.64, 3.24, 4.5, VR_DIR_DOWN, -5),  // 龙二（占比达标）
      R('凑1', 'T1', 40, 0, 2.9, 1.1),
      R('凑2', 'T1', 35, 0, 2.8, 1.1),
      R('凑3', 'T1', 30, 0, 2.7, 1.1),
      R('凑4', 'T1', 25, 0, 2.6, 1.1),
      R('凑5', 'T1', 20, 0, 2.5, 1.1),
      R('凑6', 'T1', 15, 0, 2.4, 1.1)
    ];
    const plan = buy(rows, streakOpts(MAKEUP_STREAK - 1));
    expect(pickOf(plan, '华正新材').dragonRank).toBe(1);
    // 龙一不被本档改标（它自己没有「被谁带动」这回事）⇒ 照常走占比逻辑 = 尾盘买
    expect(pickOf(plan, '华正新材').buyActionTag).toBe(BUY_LATE_TAG);
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

describe('规则文案：[MAKEUP-BUY 2026-10-08] 【补涨竞价买】必须写进两套模式的灰色问号面板', () => {
  it('量比模式买点段：写出四条判据 + 9/15 华正新材正例 + 9/18 中新赛克反例', () => {
    const lines = buildVolRatioRulesLines().join('\n');
    expect(lines).toContain(BUY_MAKEUP_TAG);
    expect(lines).toContain(String(MAKEUP_AUC_PCT_MIN));
    expect(lines).toContain('二次入选');               // 判据②：限定二次
    expect(lines).toContain('三次');                   // 明确写出「三次不准」
    expect(lines).toContain('华正新材');
    expect(lines).toContain('超声电子');
    expect(lines).toContain('中新赛克');               // ⛔ 反例：涨幅不够 ⇒ 按原规则
    expect(lines).toContain('后排');                   // ⛔ 判据①：夹带后排就不算
  });

  it('legacy（一字）文案：⑭ 里列出【补涨竞价买】且阈值不手抄', () => {
    const lines = buildRulesLines().join('\n');
    expect(lines).toContain(BUY_MAKEUP_TAG);
    expect(lines).toContain(String(MAKEUP_AUC_PCT_MIN));
    expect(lines).toContain('二次入选');
    expect(lines).toContain('中新赛克');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ [BOARD-RISK 2026-10-07 用户口径] 买点行【创业板 / 科创板风险极高】提示
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「凡是进入决策看板买点的非主板的股票，自动打上标签"创业板风险极高"……
//   不受规则控制，这种一般是套利的，也不准确，风险极高，很容易吃亏。文字前面警示标志，
//   这样更加醒目些，避免误买。其它不变。但是选票逻辑不变，还是按照原来的。」
// ⛔ 当初的口径是【只做提示】：不参与选票 / 仓位 / 买卖时机的任何判断。
//
// 🔴 [MAIN-BOARD-ONLY 2026-10-07 用户口径 · 紧接其后的新需求] 情况已经变了：
//   用户要求「不要把创业板或者科创板的选进来」⇒ 创业板 / 科创板【根本不进买点了】
//   ⇒ 这枚 ⚠ 标签在界面上【不会再出现】。代码与配色【特意保留】作兜底（⛔ 未删除，
//      用户没说删；万一以后又放开选票范围，它立刻恢复作用）。
//   所以本组用例现在只钉两件事：
//     ① 板块 → 文案的映射表本身没被改坏（boardRiskTagOf / getBoardKind，§6 唯一实现）；
//     ② 主板 / 北交所 / 代码缺失这些【还会进买点】的票，照样不挂这枚标签（不误伤）。
//   「谁进得了买点」由下一个 describe（只选主板）负责。
describe('★ [BOARD-RISK 2026-10-07] 买点行 ⚠【创业板 / 科创板风险极高】（保留兜底 · 现已不触发）', () => {
  /**
   * 造题材 T1（8 只 ⇒ 中档 ⇒ 一块正好选 2 只：甲票重仓 + 乙票轻仓）。
   * 甲票（龙一）占比 5.0% 达标 ⇒ 【竞价买】；乙票 占比 1.5% 不达标 ⇒ 【尾盘买】。
   * @param {string} [code] 甲票的股票代码（板块由它决定）
   */
  function riskRows(code) {
    return [
      R('甲票', 'T1', 55, 2, 9, 5.0, VR_DIR_UP, 5, code),
      R('乙票', 'T1', 47, 1, 3, 1.5),
      R('凑1', 'T1', 40, 0, 2.9, 1.1),
      R('凑2', 'T1', 35, 0, 2.8, 1.1),
      R('凑3', 'T1', 30, 0, 2.7, 1.1),
      R('凑4', 'T1', 25, 0, 2.6, 1.1),
      R('凑5', 'T1', 20, 0, 2.5, 1.1),
      R('凑6', 'T1', 15, 0, 2.4, 1.1)
    ];
  }
  const first = (code) => buy(riskRows(code)).heavy.picks[0];

  it('① 板块 → 文案映射：创业板（300 / 301）⇒ 文案【创业板风险极高】+ 高警示配色档', () => {
    expect(boardRiskTagOf(getBoardKind('300750'))).toBe(BOARD_RISK_TAG_GROWTH);
    expect(boardRiskTagOf(getBoardKind('301269'))).toBe(BOARD_RISK_TAG_GROWTH);   // 301 同样算创业板
    expect(BOARD_RISK_TAG_GROWTH).toBe('创业板风险极高');
    expect(BOARD_RISK_TONE).toBe('high');
  });

  it('② 板块 → 文案映射：科创板（688 / 689）⇒ 【科创板风险极高】（⛔ 不写成「创业板」，板块要准）', () => {
    expect(boardRiskTagOf(getBoardKind('688981'))).toBe(BOARD_RISK_TAG_STAR);
    expect(boardRiskTagOf(getBoardKind('689009'))).toBe(BOARD_RISK_TAG_STAR);
    expect(BOARD_RISK_TAG_STAR).toBe('科创板风险极高');
  });

  it('③ 主板（沪 60 / 深 00 · 01）⇒ 不标', () => {
    expect(first('600519').riskTag).toBe('');
    expect(first('000651').riskTag).toBe('');
    expect(first('001234').riskTag).toBe('');
    expect(first('600519').riskTone).toBe('');
  });

  it('④ §10：代码缺失 ⇒ 不标（⛔ 绝不凭股票名猜板块）', () => {
    expect(first('').riskTag).toBe('');
    expect(first(undefined).riskTag).toBe('');
    expect(first('').riskTone).toBe('');
  });

  it('⑤ ⛔ 北交所（43 / 83 / 87 / 88 / 92）这次【明确不标】—— 用户只要创业板 + 科创板', () => {
    expect(first('830799').riskTag).toBe('');
    expect(first('430047').riskTag).toBe('');
    // 顺带钉住判据表本身没被改坏：北交所仍然是放开板，只是本标签不涵盖它
    expect(getBoardKind('830799')).toBe(BOARD_BJ);
    expect(boardRiskTagOf(BOARD_BJ)).toBe('');
  });

  it('⑥ 组合：挂不挂这枚标签，除了 riskTag / riskTone 之外不改变任何其它字段', () => {
    // ⚠️ 原来这条是「借 first('300750') 与 first('') 逐字段对比」来证明「纯提示」。
    //    现在 300750 已经进不了买点（选票范围收窄），那条路径不存在了 ⇒ 改用【直接给 pick 挂标签】的方式，
    //    仍然钉住同一件事：风险提示【只加两个字段】，不碰仓位 / 买卖动作 / 其它任何字段。
    const plan = buy(riskRows(''));
    const picks = plan.heavy.picks;
    expect(picks.map(p => p.name)).toEqual(['甲票', '乙票']);
    expect(picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
    expect(picks[0].buyActionTag).toBe(BUY_NOW_TAG);       // 占比 5.0% 达标
    expect(picks[1].buyActionTag).toBe(BUY_LATE_TAG);      // 占比 1.5% 不达标
    const before = JSON.parse(JSON.stringify(picks));
    picks[0].riskTag = BOARD_RISK_TAG_GROWTH;
    picks[0].riskTone = BOARD_RISK_TONE;
    Object.keys(before[0]).forEach((k) => {
      if (k === 'riskTag' || k === 'riskTone') return;      // 这两枚就是要改的字段，单独断言
      expect(picks[0][k]).toEqual(before[0][k]);            // 其余字段一个都没被改
    });
    expect(picks[0].riskTag).toBe('创业板风险极高');
    expect(picks[0].riskTone).toBe(BOARD_RISK_TONE);
  });

  it('⑦ 卖点侧【不标】（本次只要买点；判据挂在买点块收口 _decorateAucBadge 上）', () => {
    const plan = sell([R('甲票', 'T1', 55, 2, 9, 5.0, VR_DIR_UP, 5, '300750')]);
    // ⛔ 卖点计划的结构是 [{ topic, items }]，不是 { blocks: [{ picks }] } —— 写错会取不到行，
    //    整条用例就变成「永远通过」的空测。所以先断言【真的取到了这一行】。
    const hit = (plan || []).flatMap(g => g.items || []).find(p => p.name === '甲票');
    expect(hit).toBeTruthy();
    expect(hit.riskTag).toBeUndefined();      // 卖点行压根没有这个字段（判据挂在买点收口上）
  });

  it('⑧ 规则文案：两套模式的灰色问号面板都要写清【标签 + 用于提示 + 不参与规则】', () => {
    const vol = buildVolRatioRulesLines().join('\n');
    expect(vol).toContain(BOARD_RISK_TAG_GROWTH);
    expect(vol).toContain(BOARD_RISK_TAG_STAR);
    expect(vol).toContain('不参与');
    expect(vol).toContain('选票逻辑不变');
    const leg = buildRulesLines().join('\n');
    expect(leg).toContain(BOARD_RISK_TAG_GROWTH);
    expect(leg).toContain(BOARD_RISK_TAG_STAR);
    expect(leg).toContain('不受任何规则控制');
    expect(leg).toContain('完全不变');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ [MAIN-BOARD-ONLY 2026-10-07 用户口径] 龙位只发主板 ⇒ 决策看板只选「有龙标签」的票
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：
//   「你选票的时候，不要把创业板或者科创板的选进来，体验效果很差。如果创业板或者科创板的票
//    是龙一，就要让位给主板的。所以早盘竞价的创业板或者科创板，没有龙一，龙二……等标签，
//    只排主板的，但是它们的十日涨幅排序不变（只是没有了龙的标签），决策看板选票的逻辑不变，
//    只是不选创业板或者科创板的票进去了，不然会造成困扰。」
//   「8月21日，电子/通信/算力 题材 龙一是中石科技（创业板），早盘竞价排序第一，龙二是艾艾精工
//    （主板），早盘竞价排序第二，中石科技没有龙一标签后，龙一就变成了艾艾精工。」
// ⛔ 闸门只有一处：computeDragonRankMap 发不发 rank（§6 单一真相）。
//    屏幕上有龙标签 ⟺ 决策看板选得出来 —— 两处天然同源，不会各说各话。
describe('★ [MAIN-BOARD-ONLY 2026-10-07] 龙位只发主板，决策看板只选有龙标签的票', () => {
  /** 行集合 → 龙位表（走真实实现：rankDecisionTopics + rankDragons，⛔ 不手搓中间态） */
  function dragonsOf(rows) {
    return rankDragons(rankDecisionTopics(rows));
  }

  // ── 8/21 电子/通信/算力 真实数据：中石科技 62.67 / 艾艾精工 50.29 / 哈森股份 39.04 ──
  const ZHONGSHI = R('中石科技', '电子/通信/算力', 62.67, 1, 9, 5.0, VR_DIR_UP, 5, '300684'); // 创业板
  const AIAI = R('艾艾精工', '电子/通信/算力', 50.29, 1, 8, 5.0, VR_DIR_UP, 5, '603580');      // 主板
  const HASEN = R('哈森股份', '电子/通信/算力', 39.04, 1, 7, 5.0, VR_DIR_UP, 5, '603958');     // 主板

  it('① 8/21：创业板龙一【让位】—— 中石科技无龙位，艾艾精工变龙一、哈森股份变龙二', () => {
    const d = dragonsOf([ZHONGSHI, AIAI, HASEN]);
    expect(d.get('中石科技').rank).toBeNull();   // 创业板 ⇒ 没有龙标签
    expect(d.get('艾艾精工').rank).toBe(1);       // 顺延成龙一
    expect(d.get('哈森股份').rank).toBe(2);       // 依次递补成龙二
  });

  it('② ⛔ 但【排序位次不变】：seq 仍是 1 / 2 / 3（= 十日涨幅降序），中石科技照样排第一', () => {
    const d = dragonsOf([ZHONGSHI, AIAI, HASEN]);
    expect(d.get('中石科技').seq).toBe(1);
    expect(d.get('艾艾精工').seq).toBe(2);
    expect(d.get('哈森股份').seq).toBe(3);
    expect(d.get('中石科技').pct).toBe(62.67);
    // ⛔ 早盘竞价组内排序键必须用 seq（= 十日涨幅位次），用 rank 会把弃权票「置底」⇒ 排序就变了
    expect(d.get('中石科技').rank).not.toBe(d.get('中石科技').seq);
  });

  /** 8 只 ⇒ 中档（取 2 只）。甲票量比 9 居首、乙票 3 次之，其余凑数票量比极低。 */
  function boardRows(codeOfJia) {
    return [
      R('甲票', 'T1', 55, 2, 9, 5.0, VR_DIR_UP, 5, codeOfJia),
      R('乙票', 'T1', 47, 1, 3, 1.5),
      R('凑1', 'T1', 40, 0, 2.9, 1.1),
      R('凑2', 'T1', 35, 0, 2.8, 1.1),
      R('凑3', 'T1', 30, 0, 2.7, 1.1),
      R('凑4', 'T1', 25, 0, 2.6, 1.1),
      R('凑5', 'T1', 20, 0, 2.5, 1.1),
      R('凑6', 'T1', 15, 0, 2.4, 1.1)
    ];
  }

  it('③ 决策看板：创业板龙一【不进买点】，名额让给后面的主板票（A/B 对照）', () => {
    // A：甲票是创业板 ⇒ 被剔除，前两名变成 乙票（新龙一）+ 凑1
    const growth = buy(boardRows('300750'));
    expect(growth.heavy.picks.map(p => p.name)).toEqual(['乙票', '凑1']);
    expect(growth.heavy.picks.map(p => p.name)).not.toContain('甲票');
    // B：唯一区别 = 甲票换成主板代码 ⇒ 立刻回到原来的选票结果（证明「只改范围，不改逻辑」）
    const main = buy(boardRows('600519'));
    expect(main.heavy.picks.map(p => p.name)).toEqual(['甲票', '乙票']);
    expect(main.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('④ 科创板（688 / 689）同样不进买点', () => {
    const d = dragonsOf([
      R('科创甲', 'T1', 70, 1, 9, 5.0, VR_DIR_UP, 5, '688981'),
      R('科创乙', 'T1', 60, 1, 8, 5.0, VR_DIR_UP, 5, '689009'),
      R('主板丙', 'T1', 50, 1, 7, 5.0, VR_DIR_UP, 5, '600519')
    ]);
    expect(d.get('科创甲').rank).toBeNull();
    expect(d.get('科创乙').rank).toBeNull();
    expect(d.get('主板丙').rank).toBe(1);        // 顺延成龙一
  });

  it('⑤ 北交所【照旧】有龙标签（用户只点名创业板 + 科创板，⛔ 别顺手把北交所也砍了）', () => {
    const d = dragonsOf([
      R('北交甲', 'T1', 70, 1, 9, 5.0, VR_DIR_UP, 5, '830799'),
      R('主板乙', 'T1', 50, 1, 8, 5.0, VR_DIR_UP, 5, '600519')
    ]);
    expect(d.get('北交甲').rank).toBe(1);
    expect(d.get('主板乙').rank).toBe(2);
  });

  it('⑥ §10：代码缺失 ⇒ 判不出板块 ⇒【照发龙标签】（保持既有行为，⛔ 不猜成「非主板」）', () => {
    const d = dragonsOf([
      R('无码甲', 'T1', 70, 1, 9, 5.0, VR_DIR_UP, 5, ''),
      R('主板乙', 'T1', 50, 1, 8, 5.0, VR_DIR_UP, 5, '600519')
    ]);
    expect(d.get('无码甲').rank).toBe(1);
    expect(d.get('主板乙').rank).toBe(2);
  });

  it('⑦ 只收窄选票范围，档位规则不变：主板票的仓位 / 买卖动作与改造前逐字段一致', () => {
    const plan = buy(boardRows('600519'));
    const jia = plan.heavy.picks[0];
    expect(jia.name).toBe('甲票');
    expect(jia.dragonRank).toBe(1);
    expect(jia.dragonLabel).toBe('龙一');
    expect(jia.position).toBe(POSITION_HEAVY);
    expect(jia.buyActionTag).toBe(BUY_NOW_TAG);   // 占比 5.0% 达标 ⇒ 竞价买（占比规则没动）
  });

  it('⑧ 规则文案：两套模式的买点段都写明【只选主板】+ 8/21 中石科技 / 艾艾精工 例子', () => {
    const vol = buildVolRatioRulesLines().join('\n');
    expect(vol).toContain('只选主板');
    expect(vol).toContain('中石科技');
    expect(vol).toContain('艾艾精工');
    // 一字模式（用户默认界面）同样要有
    const leg = buildRulesLines().join('\n');
    expect(leg).toContain('只选主板');
    expect(leg).toContain('中石科技');
    expect(leg).toContain('艾艾精工');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ [SELL-LIMIT-UP 2026-10-07 用户口径] 卖点【竞价涨停卖】
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「把决策看板卖点的股票如果出现竞价涨幅是涨停幅度的（一字涨停的，一般涨停幅度是
//   9.9%-10.1%，大多是10%），标签换成竞价卖。如果是尾盘卖，很容易有变故，盘中下杀风险，
//   利润要保住先。其它不变。就是只换标签，添加新标签，"竞价涨停卖"，并添加这个规则。
//   其它股票在卖点的没有涨停的，原来的规则保持不变。」
// ⛔ 本档【最优先】：压过 ⑦ 的四档，也压过【跟龙竞价卖】那条优先规则（风控不让位于「还看好」）。
describe('★ [SELL-LIMIT-UP 2026-10-07] 卖点【竞价涨停卖】', () => {
  /**
   * 甲票（龙一）占比 5.0% 达标且没进买点 ⇒ 正常该判【尾盘卖】；
   * 乙票（龙二）占比 1.5% 不达标 ⇒ 正常该判【竞价卖】。
   * @param {number|null} aucPct 甲票今日竞价涨幅（%）
   * @param {string} [code] 甲票股票代码
   */
  function sellRowsOf(aucPct, code) {
    return [
      R('甲票', 'T1', 55, aucPct, 9, 5.0, VR_DIR_UP, 5, code),
      R('乙票', 'T1', 47, 1, 3, 1.5)
    ];
  }
  /** 从卖点计划里按名字取一行（⛔ 找不到就抛，避免用例静默变成空测） */
  function sellPickOf(plan, name) {
    const hit = (plan || []).flatMap(g => g.items || []).find(p => p.name === name);
    if (!hit) throw new Error('卖点里没有 ' + name);
    return hit;
  }
  const jia = (aucPct, code, opts) =>
    sellPickOf(sell(sellRowsOf(aucPct, code), opts || {}), '甲票');

  it('① 主板竞价一字涨停（+10%）⇒ 【竞价涨停卖】（压过原本的【尾盘卖】）', () => {
    const p = jia(10, '600519');
    expect(p.sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    expect(p.sellActionTag).toBe('竞价涨停卖');
    expect(p.sellActionTone).toBe(SELL_ACTION_TONE_LIMIT_UP);
  });

  it('② 容差内都算涨停：+9.9% / +10.02% ⇒ 【竞价涨停卖】', () => {
    expect(jia(9.9, '600519').sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    expect(jia(10.02, '600519').sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    // 差太远（+9.5%）就不算涨停 ⇒ 原规则不变（占比 5.0% 达标 ⇒ 【尾盘卖】）
    expect(jia(9.5, '600519').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('③ ⛔ 涨停幅度【按板块分】：创业板 300xxx 竞价 +10% 【不是】涨停 ⇒ 原规则不变', () => {
    // 20% 板要 +20% 才算一字 —— 这条专门钉住「别把 10% 写死」（写死会漏掉最猛的那批票）
    expect(jia(10, '300750').sellActionTag).toBe(SELL_LATE_TAG);
    expect(jia(20, '300750').sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    expect(jia(20, '688981').sellActionTag).toBe(SELL_LIMIT_UP_TAG);  // 科创板同为 20%
  });

  it('④ §10：竞价涨幅【缺数据】⇒ 判不出 ⇒ 不判本档，原规则照跑', () => {
    expect(jia(null, '600519').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('⑤ 压过【持有】：占比达标 + 今天又进买点（本来是持有）⇒ 也改判【竞价涨停卖】', () => {
    const p = jia(10, '600519', { todayBuyNames: new Set(['甲票']) });
    expect(p.sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    expect(p.holdTag).toBe('');      // ⛔「拿着别动」与「竞价就走」直接矛盾，必须清掉
    // 对照：不涨停时照旧给【持有】
    const plain = jia(3, '600519', { todayBuyNames: new Set(['甲票']) });
    expect(plain.sellActionTag).toBe(HOLD_TAG);
  });

  it('⑥ ⛔ 只换标签：占比结论 / 卖出时点 / 竞价涨幅徽标 一律不变', () => {
    const hit = jia(10, '600519');
    const plain = jia(3, '600519');
    expect(hit.aucShare).toBe(plain.aucShare);
    expect(hit.aucSharePass).toBe(plain.aucSharePass);
    expect(hit.aucShareText).toBe(plain.aucShareText);
    expect(hit.sellAt).toBe(plain.sellAt);
    expect(hit.aucPctText).toBe('+10.00%');
    expect(hit.aucTone).toBe('high');
  });

  it('⑦ 同题材【非龙一】的票：龙一一字涨停 ⇒ 改标【龙一字持有】（2026-10-08 请求 Y）', () => {
    // ⚠️ 本用例在请求 Y 后【按新口径重写】：乙票是龙二，龙一（甲票）竞价 +10% 一字涨停
    //   ⇒ 题材当天最强 ⇒ 乙票不该按「自己走弱」卖 ⇒ 【龙一字持有】（不是原来的【竞价卖】）。
    const yi = sellPickOf(sell(sellRowsOf(10, '600519')), '乙票');
    expect(yi.sellActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
    expect(yi.sellActionTag).toBe('龙一字持有');
    expect(yi.sellActionTone).toBe(SELL_ACTION_TONE_YIZI_HOLD);
    // A/B 对照：唯一区别 = 龙一【没有】一字涨停（+3%）⇒ 乙票立刻回到【竞价卖】
    //   （证明「只改『龙一一字』这一档，其它规则没动」）
    const plain = sellPickOf(sell(sellRowsOf(3, '600519')), '乙票');
    expect(plain.sellActionTag).toBe(SELL_OUT_TAG);
    expect(plain.sellActionTone).toBe(SELL_ACTION_TONE_OUT);
  });

  it('⑧ 规则文案：卖点条文里写了【竞价涨停卖】且标明「最优先 / 只换标签」', () => {
    const lines = sellRulesLines().join('\n');
    expect(lines).toContain(SELL_LIMIT_UP_TAG);
    expect(lines).toContain('最优先');
    expect(lines).toContain('利润要保住先');
    expect(lines).toContain('只换标签');
  });

  it('⑨ ⛔ 一字【跌停】（-10%）【不】触发本档 ⇒ 原规则不变（占比 5.0% 达标 ⇒ 尾盘卖）', () => {
    // 钉住判据必须严格 === 'up'：写成 `!== null` / `!== ''` 会把跌停也当成涨停。
    expect(jia(-10, '600519').sellActionTag).toBe(SELL_LATE_TAG);
    expect(jia(-9.99, '600519').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('⑩ 股票代码回带到卖点输出行（判「用哪个板块的涨停幅度」可追溯）', () => {
    expect(jia(10, '600519').code).toBe('600519');
    // 代码缺失 ⇒ 空串（⛔ 不凭股票名猜板块），判据回落主板 10% 兜底
    expect(jia(10, '').code).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ [DRAGON-YIZI-HOLD 2026-10-08 用户口径 · 泛微网络 8/5] 【龙一字持有】
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「8月5日，决策看板买点，当天泛微网络是龙二，占比1.4%，不达标，标有"竞价卖（先卖后买）"，
//   当天同题材的龙一传智教育没有入选决策看板（因为是一字涨停，所以没有入选，一字是买不到的，
//   现规则没错）。但是当天的传智教育龙一，一字涨停了，说明这个题材很强，如果泛微网络打
//   "竞价卖（先卖后买）"，不是很合理……龙一是竞价一字涨停的，说明题材很强，卖都不用卖，
//   应该持有或者加仓。标签应该换成"龙一字持有"。」
//
// ⇒ 两条判据：① 同题材今日龙一竞价【一字涨停】；② 本股【不是龙一】。
// ⛔ 用例全部用【A/B 对照】写法：唯一变量 = 龙一是不是一字，其余桩数据一模一样
//    —— 这样能钉住「只改这一档，其它规则没动」（9/30 事故同型的教训）。
describe('★ [DRAGON-YIZI-HOLD 2026-10-08] 【龙一字持有】', () => {
  /**
   * 七只票的题材（数量 7 ⇒ 中档取【2】名）：
   *   · 龙一甲 = 龙一，量比 100（第 1 名）；龙二乙 = 龙二，量比 20（第 2 名）⇒ 两只都进名次；
   *   · 龙二乙 占比 1.5%（< 2% 不达标）—— 本档规则的落点。
   * ⚠️ 为什么必须是 7 只（取 2 名）而不是 4 只（取 1 名）：A/B 对照要求【龙二乙在两边都入选】——
   *    只取 1 名时，龙一不是一字 ⇒ 那唯一一个名额被龙一自己占掉，龙二乙根本不进买点，
   *    对照组就变成了空测（这正是第一次写这条用例踩到的坑）。
   * @param {object} [o] { leaderYizi, leaderPct, leaderShare }
   */
  function yiziRows(o) {
    const c = o || {};
    const leader = R('龙一甲', 'T1', 60,
      (c.leaderPct === undefined ? 10 : c.leaderPct), 100,
      (c.leaderShare === undefined ? 5.0 : c.leaderShare), VR_DIR_UP, 5, '600519');
    leader.isYizi = (c.leaderYizi !== false);      // 一字 ⇒ 买不进、不进 picks（8/5 传智教育同型）
    return [
      leader,
      R('龙二乙', 'T1', 50, -1, 20, 1.5, VR_DIR_DOWN, -2, '600520'),
      R('龙三丙', 'T1', 40, 0.5, 15, 3.0, VR_DIR_UP, 1, '600521'),
      R('龙四丁', 'T1', 30, 0.3, 12, 2.5, VR_DIR_UP, 1, '600522'),
      R('凑一', 'T1', -10, 0, 3, 1.0, VR_DIR_UP, 0, '600523'),
      R('凑二', 'T1', -11, 0, 2, 1.0, VR_DIR_UP, 0, '600524'),
      R('凑三', 'T1', -12, 0, 1, 1.0, VR_DIR_UP, 0, '600525')
    ];
  }
  /** 卖点里按名字取一行 */
  function sellOf(rows, name, opts) {
    const hit = (sell(rows, opts) || []).flatMap(g => g.items || []).find(p => p.name === name);
    if (!hit) throw new Error('卖点里没有 ' + name);
    return hit;
  }

  it('① 判据 isAuctionYiZiRow：isYizi 标记 / 按板块判涨停 两条腿', () => {
    expect(isAuctionYiZiRow({ isYizi: true })).toBe(true);
    expect(isAuctionYiZiRow({ aucPct: 10, code: '600519', name: '甲' })).toBe(true);   // 主板 10%
    expect(isAuctionYiZiRow({ aucPct: 9.9, code: '600519', name: '甲' })).toBe(true);  // 容差内
    // ⛔ 创业板 / 科创板是 20% 板，+10% 根本不是一字（写死 10% 会误判）
    expect(isAuctionYiZiRow({ aucPct: 10, code: '300750', name: '乙' })).toBe(false);
    expect(isAuctionYiZiRow({ aucPct: 20, code: '300750', name: '乙' })).toBe(true);
    // §10：缺数据 / 空 ⇒ false（⛔ 未知 ≠ 一字）；跌停也不算
    expect(isAuctionYiZiRow({ aucPct: null, code: '600519', name: '甲' })).toBe(false);
    expect(isAuctionYiZiRow({ aucPct: -10, code: '600519', name: '甲' })).toBe(false);
    expect(isAuctionYiZiRow(null)).toBe(false);
  });

  it('② 卖点 · 龙一一字 + 龙二不达标 + 今天又进买点 ⇒ 【龙一字持有】（替掉【竞价卖（先卖后买）】）', () => {
    const yi = sellOf(yiziRows(), '龙二乙', { todayBuyNames: new Set(['龙二乙']) });
    expect(yi.sellActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
    expect(yi.sellActionTag).toBe('龙一字持有');
    expect(yi.sellActionTone).toBe(SELL_ACTION_TONE_YIZI_HOLD);
    // A/B 对照：唯一区别 = 龙一【没有】一字 ⇒ 立刻回到【竞价卖（先卖后买）】
    const plain = sellOf(yiziRows({ leaderYizi: false, leaderPct: 3 }), '龙二乙',
      { todayBuyNames: new Set(['龙二乙']) });
    expect(plain.sellActionTag).toBe(SELL_OUT_SWAP_TAG);
  });

  it('③ 卖点 · 龙一一字 + 龙二不达标 + 今天没进买点 ⇒ 【龙一字持有】（替掉【竞价卖】）', () => {
    // 8/5 泛微网络正是这一档（它没进当天买点）
    const yi = sellOf(yiziRows(), '龙二乙');
    expect(yi.sellActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
    const plain = sellOf(yiziRows({ leaderYizi: false, leaderPct: 3 }), '龙二乙');
    expect(plain.sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('④ ⛔ 龙一【自己】不适用：它一字涨停 ⇒ 【竞价涨停卖】（请求 W 最优先档）', () => {
    const jia = sellOf(yiziRows(), '龙一甲');
    expect(jia.sellActionTag).toBe(SELL_LIMIT_UP_TAG);
    expect(jia.sellActionTag).not.toBe(DRAGON_YIZI_HOLD_TAG);
  });

  it('⑤ ⛔ 占比【达标】的档【不动】：龙二占比 3.0% 达标 ⇒ 照旧【持有】/【尾盘卖】', () => {
    const rows = yiziRows();
    rows[1].aucShare = 3.0;                       // 龙二乙 3.0% ≥ 2%（非龙头门槛）
    expect(sellOf(rows, '龙二乙', { todayBuyNames: new Set(['龙二乙']) }).sellActionTag).toBe(HOLD_TAG);
    expect(sellOf(rows, '龙二乙').sellActionTag).toBe(SELL_LATE_TAG);
  });

  it('⑥ ⛔ 龙一一字【不算「将军倒下」】⇒ 中军 / 后排【不会】被拖成【跟龙竞价卖】', () => {
    // 龙一占比 1.0%（< 3.5% 龙头门槛、不达标）⇒ 按 [FOLLOW-DRAGON] 规则本该让中军 / 后排跟跌；
    // 但它竞价一字涨停 = 题材最强 ⇒ 该题材【不进】fallenDragon ⇒ 龙二拿【龙一字持有】。
    const rows = yiziRows({ leaderShare: 1.0 });
    const yi = sellOf(rows, '龙二乙');
    expect(yi.sellActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
    expect(yi.sellActionTag).not.toBe(SELL_FOLLOW_DRAGON_TAG);
    // A/B 对照：龙一【不】一字 + 同样占比 1.0% ⇒ 真的倒下 ⇒ 龙二（中军）跟跌【跟龙竞价卖】
    const plain = sellOf(yiziRows({ leaderYizi: false, leaderPct: 3, leaderShare: 1.0 }), '龙二乙');
    expect(plain.sellActionTag).toBe(SELL_FOLLOW_DRAGON_TAG);
  });

  it('⑦ 买点 · 龙一一字 + 龙二不达标 + 昨天买过 ⇒ 【龙一字持有】且【保留】仓位与【持有】', () => {
    const opts = { prevBuyNames: new Set(['龙二乙']), prevBoughtNames: new Set(['龙二乙']) };
    const yi = pickOf(buy(yiziRows(), opts), '龙二乙');
    expect(yi.buyActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
    expect(yi.buyActionTone).toBe(BUY_ACTION_TONE_YIZI_HOLD);
    // ⛔ 关键：本档【不清】行尾仓位 —— 语义就是「持有或加仓」
    expect(yi.position).toBe(POSITION_HOLD);
    // A/B 对照：龙一【没有】一字 ⇒ 回到【尾盘买（先卖后买）】，且仓位被清空（原口径）
    const plain = pickOf(buy(yiziRows({ leaderYizi: false, leaderPct: 3 }), opts), '龙二乙');
    expect(plain.buyActionTag).toBe(BUY_LATE_SWAP_TAG);
    expect(plain.position).toBe('');
  });

  it('⑧ 买点 · 块级说明不再自相矛盾：龙一一字时【不写】「不算强势股、不标持有」', () => {
    const opts = { prevBuyNames: new Set(['龙二乙']), prevBoughtNames: new Set(['龙二乙']) };
    const withYizi = allBlockNotes(buy(yiziRows(), opts));
    expect(withYizi).toContain(DRAGON_YIZI_HOLD_TAG);
    expect(withYizi).not.toContain('不算强势股');
    const plain = allBlockNotes(buy(yiziRows({ leaderYizi: false, leaderPct: 3 }), opts));
    expect(plain).toContain('不算强势股');
  });

  it('⑨ 规则文案：量比模式买点段 + 一字模式买点段 + 共用卖点段 三处都写了【龙一字持有】', () => {
    expect(buildVolRatioRulesLines().join('\n')).toContain(DRAGON_YIZI_HOLD_TAG);
    expect(buildRulesLines().join('\n')).toContain(DRAGON_YIZI_HOLD_TAG);
    const sellTxt = sellRulesLines().join('\n');
    expect(sellTxt).toContain(DRAGON_YIZI_HOLD_TAG);
    expect(sellTxt).toContain('卖都不用卖');
    expect(sellTxt).toContain('泛微网络');
  });
});
