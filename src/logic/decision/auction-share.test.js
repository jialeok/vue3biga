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
//   门槛：前排（今日或昨日 龙一 / 龙二）→ 4% 容错 0.5% ⇒ 3.5%；后排（其余）→ 2%。
//   买点：达标 → 竞价买；不达标 → 尾盘买（若昨天已买过 ⇒ 【尾盘买（先卖后买）】且清掉【持有】）。
//   卖点：达标 → 尾盘卖（今天又进买点 ⇒ 持有）；不达标 → 竞价卖（进了买点也是竞价卖，不给持有）。
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
  BUY_NOW_TAG,
  BUY_LATE_TAG,
  BUY_LATE_SWAP_TAG,
  SELL_FIRST_BUY_LATER_TAG,
  SELL_LATE_TAG,
  SELL_OUT_TAG,
  // [FOLLOW-DRAGON 2026-10-05 用户口径 · 9/9 国芳集团 + 安记食品] 同题材龙一限制（优先规则）
  SELL_FOLLOW_DRAGON_TAG,
  SELL_ACTION_TONE_FOLLOW,
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
 */
function R(name, topic, pct, aucPct, volRatio, share, dir) {
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
    volRatioDir: dir || ''
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
  it('两个标准值：前排 4%（容错 0.5% ⇒ 3.5%）/ 后排 2%', () => {
    expect(AUCTION_SHARE_FRONT_STD).toBe(4);
    expect(AUCTION_SHARE_TOLERANCE).toBe(0.5);
    expect(AUCTION_SHARE_FRONT_MIN).toBe(3.5);
    expect(AUCTION_SHARE_BACK_STD).toBe(2);
    expect(auctionShareThresholdOf(true)).toBe(3.5);
    expect(auctionShareThresholdOf(false)).toBe(2);
  });

  it('达标判定：前排 3.5 起 / 后排 2 起；边界值取「≥」（含端点）', () => {
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

describe('resolveDragonScope：前排 = 今日龙一/龙二 或 昨日在龙头名册里', () => {
  it('今日龙一 / 龙二 → 前排', () => {
    expect(resolveDragonScope(1, false).isFront).toBe(true);
    expect(resolveDragonScope(2, false).isFront).toBe(true);
  });

  it('今日龙三及以下 → 后排（用户口径「龙三或者以下就不可以了太弱了」）', () => {
    expect(resolveDragonScope(3, false).isFront).toBe(false);
    expect(resolveDragonScope(9, false).isFront).toBe(false);
  });

  it('昨日龙一 / 龙二（在龙头名册里）→ 即便今日不是前二也算前排', () => {
    expect(resolveDragonScope(5, true).isFront).toBe(true);
    expect(resolveDragonScope(9, true).isFront).toBe(true);
  });

  it('§10：昨日名册未加载（null）→ 不算前排，但标记 frontUnknown 供说明文字如实写出', () => {
    const s = resolveDragonScope(5, null);
    expect(s.isFront).toBe(false);
    expect(s.frontUnknown).toBe(true);
    // 今日前二仍然照常算前排
    expect(resolveDragonScope(1, null).isFront).toBe(true);
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
    // 今日龙五 ⇒ 今日这一腿不算前排；靠【昨日龙头名册】那条腿拿 3.5% 的门槛
    const high = [];
    for (let i = 0; i < 4; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const rows = [...high, R('花溪科技', 'T1', 1, -5.02, 50, 3.6, VR_DIR_DOWN)];
    const plan = buy(rows, { prevDragonNames: new Set(['花溪科技']) });
    const p = pickOf(plan, '花溪科技');
    expect(p.dragonRank).toBe(5);
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.aucShareThresholdText).toContain('3.5');   // 说明文字里必须写出容错后的门槛
  });

  it('反例：3.6% 但【昨日不是前排】→ 后排门槛 2% 也过 ⇒ 仍是竞价买（换个更弱的数看差异）', () => {
    const high = [];
    for (let i = 0; i < 4; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const rows = [...high, R('花溪科技', 'T1', 1, -5.02, 50, 1.8, VR_DIR_DOWN)];
    // 非前排：门槛 2% ⇒ 1.8% 不达标 ⇒ 尾盘买
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
    expect(p.dragonRank).toBe(1);                       // 今日龙一 ⇒ 前排门槛 3.5% ⇒ 2.5% 不达标
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
    expect(p.aucShareScopeText).toContain('前排');
    expect(p.aucShareThresholdText).toContain('3.5');
  });

  it('后排的强度档与门槛文案', () => {
    const high = [];
    for (let i = 0; i < 5; i++) high.push(R('高' + i, 'T1', 20 - i, 0.5, 1, 1.0));
    const p = pickOf(buy([...high, R('甲', 'T1', 1, 1, 50, 2.6, VR_DIR_UP)]), '甲');
    expect(p.aucShareTone).toBe('meet');
    expect(p.aucShareScopeText).toContain('后排');
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
    const rows = topic6(1, '金健米业');            // 今日龙六 ⇒ 靠「昨日龙一」拿前排门槛
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
    expect(it0.dragonRank).toBe(null);          // 今日未成组 ⇒ 无龙位 ⇒ 后排
    expect(it0.aucShareScopeText).toContain('后排');
  });

  it('⑤ 华阳国际（龙三，非前排，占比 1.8% < 2%）→ 【竞价卖】', () => {
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

  it('⑦ 楚天龙 9/3（龙一 / 占比 2.5% 不达标 + 今天又进买点）→ 【竞价卖】，⛔ 不给【持有】', () => {
    // 用户原话：「占比2.5不达标。所以应该是竞价卖。同时它有进了买点那里。那就尾盘买。
    //   ……卖点方面，提示持有标签，卖点方面的提示不是很具体，应该去掉持有。应该是这个标签，'竞价卖'」
    // 补充口径（2026-10-04）：「因为它是龙一，按照占比3.5%的标准，它不合格」
    const rows = [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN), ...F('T1', 3)];
    const plan = sell(
      [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN)],
      {
        memberRows: rows,
        todayBuyNames: new Set(['楚天龙'])       // 同时进了买点 —— 旧实现会标【持有】
      }
    );
    const it0 = itemOf(plan, '楚天龙');
    expect(it0.dragonRank).toBe(1);              // 龙一 ⇒ 前排门槛 3.5%
    expect(it0.aucSharePass).toBe(false);        // 2.5% < 3.5% ⇒ 不达标
    expect(it0.sellActionTag).toBe('竞价卖');
    expect(it0.sellActionTag).toBe(SELL_OUT_TAG);
    expect(it0.sellActionTag).not.toBe(HOLD_TAG);
    expect(it0.sellActionTone).toBe('out');
    expect(it0.holdTag).toBe('');                // ⛔ 不再标【持有】
    expect(it0.sellHint).toBe(null);             // 占比有数据 ⇒ 旧口径让路
    expect(it0.actionNote).toContain('走弱');
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
   ⛔ 本条只改【标签】—— 门槛（前排 3.5% / 后排 2%）、公式、精度一律不动。
   ════════════════════════════════════════════════════════════════════════════════ */
describe('★ 9/3 楚天龙：买点 + 卖点同时存在时的标签（逻辑不变，只去掉【持有】）', () => {
  // 楚天龙 = 今日龙一 ⇒ 前排门槛 3.5%；占比 2.5% ⇒ 不达标
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

  it('卖点行 → 【竞价卖】（不是【持有】）', () => {
    const plan = sell(
      [R('楚天龙', 'T1', 10, -3.36, 7.8, 2.5, VR_DIR_DOWN)],
      { memberRows: ROWS(), todayBuyNames: new Set(['楚天龙']) }
    );
    const it0 = itemOf(plan, '楚天龙');
    expect(it0.dragonRank).toBe(1);
    expect(it0.aucShareText).toBe('2.5%');
    expect(it0.sellActionTag).toBe('竞价卖');
    expect(it0.sellActionTag).not.toBe(HOLD_TAG);
    expect(it0.holdTag).toBe('');
    expect(it0.sellHint).toBe(null);
  });

  it('只改标签：门槛与判定没动（前排仍是 3.5% / 后排仍是 2%，公式与精度不变）', () => {
    expect(AUCTION_SHARE_FRONT_MIN).toBe(3.5);
    expect(AUCTION_SHARE_BACK_STD).toBe(2);
    expect(auctionShareThresholdOf(true)).toBe(3.5);
    expect(auctionShareThresholdOf(false)).toBe(2);
    expect(computeAuctionShare(25, 1000)).toBe(2.5);      // 25/1000 = 2.5%
    expect(formatAuctionShare(2.5)).toBe('2.5%');
    // 后排：2.6% ≥ 2% ⇒ 依然达标（用户口径「后排选手占比要求大于2%没错」）
    expect(passesAuctionShare(2.6, false)).toBe(true);
    // 前排：2.5% < 3.5% ⇒ 不达标（楚天龙就是这一档）
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
   ⛔ 只加这一条优先规则 —— 门槛（前排 3.5% / 后排 2%）、公式、精度、其它规则一律不动。
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
      R('别后排', '别的题材', 5, 0.5, 1, 3.0)     // 龙三 ⇒ 后排，占比 3.0% ≥ 2% ⇒ 尾盘卖
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

  it('配色档：不达标 → out（进了买点也是 out）；达标 + 进买点 → hold', () => {
    const manyRows = [
      R('高甲', 'T1', 30, 0.5, 1, 1.0), R('高乙', 'T1', 25, 0.5, 1, 1.0),
      R('高丙', 'T1', 20, 0.5, 1, 1.0), R('高丁', 'T1', 15, 0.5, 1, 1.0)
    ];
    // 甲 = 龙五 ⇒ 后排，门槛 2% ⇒ 1.8% 不达标 ⇒ 竞价卖（out）
    const out = itemOf(sell(
      [R('甲', 'T1', 5, -1.3, 1, 1.8, VR_DIR_DOWN)],
      { memberRows: manyRows, prevDragonNames: new Set(['别的']) }
    ), '甲');
    expect(out.sellActionTone).toBe('out');

    // 🔴 [SHARE-PRIORITY 2026-10-04] 不达标 + 今天又进买点【也是 out】——
    //   旧实现这一档给的是 hold，用户 9/3 楚天龙案例明确要求去掉【持有】。
    const outToo = itemOf(sell(
      [R('甲', 'T1', 5, -1.3, 1, 1.8, VR_DIR_DOWN)],
      { memberRows: manyRows, prevDragonNames: new Set(['别的']), todayBuyNames: new Set(['甲']) }
    ), '甲');
    expect(outToo.sellActionTag).toBe(SELL_OUT_TAG);
    expect(outToo.sellActionTone).toBe('out');

    // 换成【达标】的占比（2.6% ≥ 后排门槛 2%）⇒ 这一档才是 hold
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
