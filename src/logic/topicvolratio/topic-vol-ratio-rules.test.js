// topic-vol-ratio-rules.test.js — 「题材量比」看板纯规则的单元测试
//
// 覆盖用户 2026-10-11 给出的口径与举例（【第一轮 · 选股】）：
//   · 档位边界：< 4 只不入选 / 4~8 只取 1 只 / > 8 只取 2 只；
//   · 平均竞价量比（含灰行、全缺值 → null）；
//   · 举例：机器人 3 只（排 1）排除 → AI应用 5 只（排 2，取 1）→ 大消费 10 只（排 3，取 2）；
//   · 龙位顺延：龙一竞价涨停 ⇒ 看龙二（⛔ 与决策看板「占名次不递补」不同，本看板要顺延）；
//   · 无龙位（创业板 / 科创板）的成员不进候选。
//
// 覆盖【第二轮 · 完善】的口径：
//   · 买点块 = 【决策看板形状】+ finishBuyBlock 收口（本看板没有第二套标签实现）；
//   · 无 ctx ⇒ 持有 / 昨有买入 / N 次入选【一枚都不打】（§10：未知 ≠ 没有）；
//   · 有 ctx ⇒ 打出来的值与决策看板的常量【逐字一致】；
//   · 占比达标 ⇒ 动作标签 = 决策看板的【竞价买】；
//   · buy 槽位 heavy / light（通用装饰器按它遍历）；
//   · 卖点段 = buildSellPlan 的同一份实现（「今天又进买点 ⇒ 持有」用本看板自己的名单）；
//   · 规则文案扩到 14 条且口径齐全。
//
// 覆盖【第四轮 · 空仓提醒】（2026-10-13 用户口径）：
//   · 能入选的排名第一题材 平均竞价量比 < 25 ⇒ cashAlert.show = true（判据看【能入选的】，
//     量比更高但数量不足被排除的题材不算）；
//   · 边界 25 不触发（用户说的是「小于 25」）；缺量比 / 无入选题材都不触发（§10）；
//   · ★ 命中提醒时选股 / 标签 / 说明【一行未改】（提醒只是一段独立文案）。
//
// 覆盖【第五轮 · 退潮首日】（2026-10-13 用户口径）：
//   · 判据：市场总龙（昨日十日涨幅第一）今日【停牌】或【占比不达标】⇒ 退潮（二者有一即算）；
//     占比缺数据 ⇒ 不判（§10）；两条都不成立 ⇒ null（不是退潮日）；
//   · 两只「看分笔卖」：同题材可用龙位（顺延）× 市场总龙二（不顺延，必须正好涨幅第二）；
//   · 其余（含原本【持有】）一律【竞价卖】；只改动作标签、客观数据逐项保留；
//   · 买点侧改走退潮口径的空仓标语，选股一行未改（灰化只是视觉）。
//
// ⚠️ 断言里刻意【引用 decision-rules 的常量】而不是手写中文字面量：
//   本看板的口径就是「标签与决策看板完全同一套」⇒ 决策看板改名时两边要一起动，
//   手写字面量会让这个测试变成「挡住正确改名」的绊脚石。

import { describe, it, expect } from 'vitest';
import {
  TVRB_MIN_COUNT,
  TVRB_MID_MAX,
  TVRB_PICK_MID,
  TVRB_PICK_BIG,
  TVRB_TOPIC_LIMIT,
  TVRB_CASH_ALERT_AVG_VR,
  EBB_PICK_TAG,
  EBB_PICK_TONE,
  EBB_NO_BUY_TAG,
  EBB_NO_BUY_TONE,
  EBB_SECOND_BUY_TAG,
  EBB_SECOND_BUY_TONE,
  EBB_SECOND_RULE_NO,
  resolveTvrbTier,
  avgVolRatioOf,
  formatAvgVolRatio,
  buildCashAlert,
  detectEbbDay,
  buildEbbDayRecord,
  buildTopicVolRatioPlan,
  buildTvrbRulesLines
} from './topic-vol-ratio-rules.js';
import {
  RULE_NO,
  HOLD_TAG,
  BUY_NOW_TAG,
  BUY_LATE_SWAP_TAG,
  DRAGON_YIZI_HOLD_TAG,
  SELL_OUT_TAG,
  TOPIC_PREV_BOUGHT_TAG,
  topicStreakText
} from '../decision/decision-rules.js';

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────
function m(name, opts) {
  return Object.assign({
    name: name,
    isYizi: false,
    pct: 20,
    aucPct: 5,
    aucVolRatio: 5,
    aucShare: null,
    volRatioDir: '',
    code: '000001',
    countable: true,
    inheritSold: false
  }, opts || {});
}

function block(topic, rank, members) {
  return {
    topic: topic,
    rank: rank,
    count: members.length,
    yiziCount: members.filter(function(x) { return x.isYizi; }).length,
    members: members
  };
}

/** 龙位名册：name → rank（_buyCandidates 只读 .rank） */
function dragonMap(entries) {
  const map = new Map();
  entries.forEach(function(e) { map.set(e[0], { rank: e[1], topic: '', groupSize: 0, pct: 20 }); });
  return map;
}

// ── 档位 ─────────────────────────────────────────────────────────────────────────────────
describe('tvrb · resolveTvrbTier 档位', function() {
  it('常量与用户口径逐字一致（<4 / 4~8 / >8）', function() {
    expect(TVRB_MIN_COUNT).toBe(4);
    expect(TVRB_MID_MAX).toBe(8);
    expect(TVRB_PICK_MID).toBe(1);
    expect(TVRB_PICK_BIG).toBe(2);
    expect(TVRB_TOPIC_LIMIT).toBe(2);
  });

  it('< 4 只 ⇒ none（不入选）', function() {
    [0, 1, 2, 3].forEach(function(c) {
      const t = resolveTvrbTier(c);
      expect(t.tier).toBe('none');
      expect(t.pickCount).toBe(0);
    });
  });

  it('4 ~ 8 只 ⇒ mid（取 1 只）', function() {
    [4, 5, 6, 7, 8].forEach(function(c) {
      const t = resolveTvrbTier(c);
      expect(t.tier).toBe('mid');
      expect(t.pickCount).toBe(1);
    });
  });

  it('> 8 只 ⇒ big（取 2 只）', function() {
    [9, 10, 25].forEach(function(c) {
      const t = resolveTvrbTier(c);
      expect(t.tier).toBe('big');
      expect(t.pickCount).toBe(2);
    });
  });

  it('§10：缺值 / 非法 → 落到 none（绝不假装是大题材）', function() {
    [null, undefined, '', 'abc', NaN, -1].forEach(function(c) {
      expect(resolveTvrbTier(c).tier).toBe('none');
    });
    // 字符串数字照常解析
    expect(resolveTvrbTier('10').tier).toBe('big');
  });
});

// ── 平均竞价量比 ─────────────────────────────────────────────────────────────────────────
describe('tvrb · avgVolRatioOf', function() {
  it('= 有值行的算术平均（含灰行 countable=false）', function() {
    const b = block('AI应用', 1, [
      m('A', { aucVolRatio: 60 }),
      m('B', { aucVolRatio: 80 }),
      m('C', { aucVolRatio: '100', countable: false })   // 灰行也计入分母
    ]);
    expect(avgVolRatioOf(b)).toBe(80);
  });

  it('§10：缺量比的行【不计入分母】（不是当 0 算）', function() {
    const b = block('X', 1, [
      m('A', { aucVolRatio: 60 }),
      m('B', { aucVolRatio: null }),
      m('C', { aucVolRatio: '' })
    ]);
    expect(avgVolRatioOf(b)).toBe(60);
  });

  it('§10：全部缺值 ⇒ null（绝不返回 0）', function() {
    const b = block('X', 1, [m('A', { aucVolRatio: null }), m('B', { aucVolRatio: '' })]);
    expect(avgVolRatioOf(b)).toBeNull();
    expect(formatAvgVolRatio(null)).toBe('—');
  });

  it('formatAvgVolRatio 保留 2 位小数', function() {
    expect(formatAvgVolRatio(78)).toBe('78.00');
    expect(formatAvgVolRatio(68.456)).toBe('68.46');
  });
});

// ── 用户举例（核心口径） ─────────────────────────────────────────────────────────────────
describe('tvrb · buildTopicVolRatioPlan（用户 2026-10-11 举例）', function() {
  // 机器人 3 只（平均量比 78，排 1，数量不够 ⇒ 排除）
  const robot = block('机器人', 1, [
    m('中大力德', { aucVolRatio: 78 }),
    m('双环传动', { aucVolRatio: 78 }),
    m('巨轮智能', { aucVolRatio: 78 })
  ]);
  // AI应用 5 只（平均量比 68，排 2 ⇒ 取 1 只）；龙一竞价涨停 ⇒ 顺延龙二
  const ai = block('AI应用', 2, [
    m('金山办公', { aucVolRatio: 100, isYizi: true }),
    m('三六零', { aucVolRatio: 60 }),
    m('昆仑万维', { aucVolRatio: 60 }),
    m('万兴科技', { aucVolRatio: 60 }),
    m('汤姆猫', { aucVolRatio: 60 })
  ]);
  // 大消费 10 只（平均量比 45，排 3 ⇒ 取 2 只）；龙一竞价涨停 ⇒ 顺延龙二、龙三
  const cons = block('大消费', 3, [
    m('贵州茅台', { aucVolRatio: 45, isYizi: true }),
    m('五粮液', { aucVolRatio: 45 }),
    m('泸州老窖', { aucVolRatio: 45 }),
    m('洋河股份', { aucVolRatio: 45 }),
    m('山西汾酒', { aucVolRatio: 45 }),
    m('古井贡酒', { aucVolRatio: 45 }),
    m('今世缘', { aucVolRatio: 45 }),
    m('舍得酒业', { aucVolRatio: 45 }),
    m('水井坊', { aucVolRatio: 45 }),
    m('迎驾贡酒', { aucVolRatio: 45 })
  ]);

  const topics = [robot, ai, cons];
  const dmap = dragonMap([
    ['中大力德', 1], ['双环传动', 2], ['巨轮智能', 3],
    ['金山办公', 1], ['三六零', 2], ['昆仑万维', 3], ['万兴科技', 4], ['汤姆猫', 5],
    ['贵州茅台', 1], ['五粮液', 2], ['泸州老窖', 3], ['洋河股份', 4], ['山西汾酒', 5],
    ['古井贡酒', 6], ['今世缘', 7], ['舍得酒业', 8], ['水井坊', 9], ['迎驾贡酒', 10]
  ]);

  const plan = buildTopicVolRatioPlan(topics, dmap, {});

  it('排除数量不足 4 只的题材，并顺延到下一题材', function() {
    expect(plan.excludedTopics.map(function(t) { return t.topic; })).toEqual(['机器人']);
    expect(plan.blocks.map(function(b) { return b.topic; })).toEqual(['AI应用', '大消费']);
  });

  it('AI应用（5 只 → mid）：龙一竞价涨停 ⇒ 顺延取龙二三六零', function() {
    const aiBlk = plan.blocks[0];
    expect(aiBlk.tier).toBe('mid');
    expect(aiBlk.pickCount).toBe(1);
    expect(aiBlk.picks.map(function(p) { return p.name; })).toEqual(['三六零']);
    expect(aiBlk.picks[0].dragonLabel).toBe('龙二');
  });

  it('大消费（10 只 → big）：龙一竞价涨停 ⇒ 顺延取龙二、龙三', function() {
    const cBlk = plan.blocks[1];
    expect(cBlk.tier).toBe('big');
    expect(cBlk.pickCount).toBe(2);
    expect(cBlk.picks.map(function(p) { return p.name; })).toEqual(['五粮液', '泸州老窖']);
    expect(cBlk.picks.map(function(p) { return p.dragonLabel; })).toEqual(['龙二', '龙三']);
  });

  it('序号连续（1 起）、被顺延的竞价涨停票写进 skippedNames', function() {
    expect(plan.blocks[0].picks[0].seq).toBe(1);
    expect(plan.blocks[1].picks.map(function(p) { return p.seq; })).toEqual([1, 2]);
    expect(plan.blocks[0].skippedNames).toEqual(['龙一金山办公']);
    expect(plan.blocks[1].skippedNames).toEqual(['龙一贵州茅台']);
  });

  it('平均量比按【有值行的均值】算出并写进块', function() {
    expect(plan.blocks[0].avgVolRatio).toBe(68);
    expect(plan.blocks[0].avgVolRatioText).toBe('68.00');
    expect(plan.blocks[1].avgVolRatio).toBe(45);
  });

  it('pickCount 汇总 + 看板级说明含被排除题材', function() {
    expect(plan.pickCount).toBe(3);
    expect(plan.notes.join('\n')).toContain('机器人');
    expect(plan.notes.join('\n')).toContain('不足 4 只');
  });

  it('topics 里保留全部参与排名的题材（含被排除的）', function() {
    expect(plan.topics.map(function(t) { return t.topic; })).toEqual(['机器人', 'AI应用', '大消费']);
  });
});

// ── 边界与 §10 ───────────────────────────────────────────────────────────────────────────
describe('tvrb · 边界与 §10', function() {
  it('题材内成员全部竞价涨停 ⇒ qualified=false、picks 为空（不递补其它题材）', function() {
    const b = block('X', 1, [
      m('甲', { isYizi: true }), m('乙', { isYizi: true }),
      m('丙', { isYizi: true }), m('丁', { isYizi: true })
    ]);
    const plan = buildTopicVolRatioPlan([b], dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4]]), {});
    expect(plan.blocks[0].qualified).toBe(false);
    expect(plan.blocks[0].picks).toHaveLength(0);
    expect(plan.pickCount).toBe(0);
  });

  it('无龙位（创业板 / 科创板）的成员不进候选', function() {
    // rank 为 null 的成员（未进 dragonMap）被 topicCandidates 剔除
    const b = block('Y', 1, [
      m('主板甲'), m('主板乙'), m('创业丙'), m('创业丁')
    ]);
    const plan = buildTopicVolRatioPlan([b], dragonMap([['主板甲', 1], ['主板乙', 2]]), {});
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['主板甲']);
  });

  it('可买（非一字）的票不足本档只数 ⇒ 少取，⛔ 不补位', function() {
    // big 档要 2 只，但只有 1 只非一字
    const b = block('Z', 1, [
      m('龙一', { isYizi: true }), m('龙二'), m('龙三', { isYizi: true }),
      m('龙四', { isYizi: true }), m('龙五', { isYizi: true }),
      m('龙六', { isYizi: true }), m('龙七', { isYizi: true }),
      m('龙八', { isYizi: true }), m('龙九', { isYizi: true })
    ]);
    const dm = dragonMap([['龙一', 1], ['龙二', 2], ['龙三', 3], ['龙四', 4], ['龙五', 5],
      ['龙六', 6], ['龙七', 7], ['龙八', 8], ['龙九', 9]]);
    const plan = buildTopicVolRatioPlan([b], dm, {});
    expect(plan.blocks[0].tier).toBe('big');
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['龙二']);
    expect(plan.blocks[0].notes.join('\n')).toContain('不足 2 只');
  });

  it('空题材列表 ⇒ 空计划（不抛错）', function() {
    const plan = buildTopicVolRatioPlan([], new Map(), {});
    expect(plan.blocks).toEqual([]);
    expect(plan.pickCount).toBe(0);
    expect(plan.topics).toEqual([]);
  });

  it('入选题材少于 2 个时给出说明', function() {
    const b = block('唯一', 1, [m('甲'), m('乙'), m('丙'), m('丁')]);
    const plan = buildTopicVolRatioPlan([b], dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4]]), {});
    expect(plan.blocks).toHaveLength(1);
    expect(plan.notes.join('\n')).toContain('不足 2 个');
  });
});

// ── 第二轮 · 买点块 = 决策看板形状 + finishBuyBlock 收口 ────────────────────────────────────
describe('tvrb · 买点块由决策看板的收口函数打标签', function() {
  // AI应用 4 只（mid 档 ⇒ 取 1 只）：龙一竞价一字 ⇒ 顺延取龙二【三六零】
  function aiTopic() {
    return block('AI应用', 1, [
      m('金山办公', { aucVolRatio: 60, isYizi: true, aucShare: 9, aucPct: 10 }),
      m('三六零', { aucVolRatio: 60, aucShare: 6, code: '601360' }),
      m('昆仑万维', { aucVolRatio: 60, aucShare: 6, code: '300418' }),
      m('汤姆猫', { aucVolRatio: 60, aucShare: 6, code: '300459' })
    ]);
  }
  const dm = dragonMap([['金山办公', 1], ['三六零', 2], ['昆仑万维', 3], ['汤姆猫', 4]]);

  /** 一个完整的标记上下文（= decision-collect#_actionContext 的出口形状） */
  function fullCtx(over) {
    return Object.assign({
      prevDragonNames: new Set(['金山办公']),
      prevBuyNames: new Set(['三六零']),
      prevBought: new Set(),
      prevBoughtTopics: new Set(['AI应用']),
      topicStreakPast: new Map([['AI应用', 2]])
    }, over || {});
  }

  it('块形状与决策看板一致（收口要读的字段一个都不能少）', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, {});
    const b = plan.blocks[0];
    // ⭐ 少了 block.topic / block.members，_markTopicPrevBought / _markTopicStreak 会【静默】不打标记
    expect(b.block).toBeTruthy();
    expect(b.block.topic).toBe('AI应用');
    expect(b.block.members).toHaveLength(4);
    // picks 上必须预置 aucShare / dragonRank（收口跑在派生徽标之前，缺了就判不出先卖后买）
    expect(b.picks[0].name).toBe('三六零');
    expect(b.picks[0].dragonRank).toBe(2);
    expect(b.picks[0].aucShare).toBe(6);
    expect(b.picks[0].code).toBe('601360');
    // 规则编号借决策看板买点段的 ①（⛔ 不另立一套编号）
    expect(b.ruleNo).toBe(RULE_NO.FIRST);
  });

  it('§10：没有 ctx ⇒ 持有 / 昨有买入 / N 次入选【一枚都不打】', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, {});
    const b = plan.blocks[0];
    const p = b.picks[0];
    expect(b.prevBoughtTag || '').toBe('');   // 题材「昨有买入」
    expect(b.streakTag || '').toBe('');       // 题材「N 次入选」
    expect(p.holdTag || '').toBe('');         // 个股「持有」（③）
    expect(p.position).toBe('');              // 行尾仓位（本看板无仓位口径 ⇒ 恒空）
  });

  it('有 ctx ⇒ 打出来的值与 decision-rules 的常量逐字一致', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, { ctx: fullCtx() });
    const b = plan.blocks[0];
    const p = b.picks[0];
    expect(b.prevBoughtTag).toBe(TOPIC_PREV_BOUGHT_TAG);   // '昨有买入'
    expect(b.streakTag).toBe(topicStreakText(3));          // pastCounts 2 + 今天这次 = 三次入选
    expect(b.topicStreakN).toBe(3);
    expect(p.holdTag).toBe(HOLD_TAG);                      // ③ 上一个交易日也在买点里 ⇒ 强势股
    expect(p.position).toBe('');                           // 本看板无仓位口径
    // 说明文字也必须落到块上（§10 理由必须可见），而不是被静默吞掉
    expect(b.notes.join('\n')).toContain(HOLD_TAG);
  });

  it('昨天真买过 ⇒ 行尾仓位改标【持有】、③ 的【持有】让位（决策看板同一口径）', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, {
      ctx: fullCtx({ prevBought: new Set(['三六零']) })
    });
    const p = plan.blocks[0].picks[0];
    expect(p.position).toBe('持有');
    expect(p.positionTone).toBe('hold');
    // [HOLD-UNIFY] 同一行不出现两个【持有】
    expect(p.holdTag || '').toBe('');
  });

  it('占比达标 ⇒ 动作标签 = 决策看板的【竞价买】', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, { ctx: fullCtx() });
    const p = plan.blocks[0].picks[0];
    expect(p.aucShareText).toBe('6.0%');       // 占比展示（1 位小数，缺数据才不渲染）
    expect(p.aucShareTone).toBe('strong');
    expect(p.aucSharePass).toBe(true);
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.buyActionTone).toBe('now');
  });

  it('占比不达标 + 昨天真买过 ⇒ 【尾盘买（先卖后买）】（先卖后买档，⛔ 不标持有）', function() {
    // ⚠️ 刻意【不给龙一龙位】：本题材龙一（金山办公）在真实数据里是 688 科创板，本来就没有龙位。
    //    若给它 rank 1 且标成竞价一字，这一档会被【龙一字持有】接管（见下一条用例）——
    //    那条是另一条规则，本用例要验的是【纯先卖后买】。
    const topics = [block('AI应用', 1, [
      m('金山办公', { aucVolRatio: 60, aucShare: 9 }),
      m('三六零', { aucVolRatio: 60, aucShare: 0.4 }),
      m('昆仑万维', { aucVolRatio: 60, aucShare: 0.4 }),
      m('汤姆猫', { aucVolRatio: 60, aucShare: 0.4 })
    ])];
    const noLeader = dragonMap([['三六零', 2], ['昆仑万维', 3], ['汤姆猫', 4]]);
    const plan = buildTopicVolRatioPlan(topics, noLeader, {
      ctx: fullCtx({ prevDragonNames: null, prevBought: new Set(['三六零']) })
    });
    const p = plan.blocks[0].picks[0];
    expect(p.name).toBe('三六零');
    expect(p.aucSharePass).toBe(false);
    expect(p.buyActionTag).toBe(BUY_LATE_SWAP_TAG);
    expect(p.holdTag || '').toBe('');
    expect(p.position).toBe('');
  });

  it('同题材今日龙一竞价一字 ⇒ 占比不达标改标【龙一字持有】（同一份规则的另一档，自动生效）', function() {
    const topics = [block('AI应用', 1, [
      m('金山办公', { aucVolRatio: 60, isYizi: true, aucShare: 9 }),
      m('三六零', { aucVolRatio: 60, aucShare: 0.4 }),
      m('昆仑万维', { aucVolRatio: 60, aucShare: 0.4 }),
      m('汤姆猫', { aucVolRatio: 60, aucShare: 0.4 })
    ])];
    const plan = buildTopicVolRatioPlan(topics, dm, {
      ctx: fullCtx({ prevBought: new Set(['三六零']) })
    });
    const p = plan.blocks[0].picks[0];
    expect(p.aucSharePass).toBe(false);
    // 被龙一带着走 ⇒ 不算走弱 ⇒ 不改【先卖后买】
    expect(p.buyActionTag).toBe(DRAGON_YIZI_HOLD_TAG);
  });

  it('buy 槽位：第 1 块 → heavy、第 2 块 → light；三个兜底槽位恒 null（形状契约）', function() {
    const t1 = block('甲题材', 1, [m('甲一'), m('甲二'), m('甲三'), m('甲四')]);
    const t2 = block('乙题材', 2, [m('乙一'), m('乙二'), m('乙三'), m('乙四')]);
    const d = dragonMap([
      ['甲一', 1], ['甲二', 2], ['甲三', 3], ['甲四', 4],
      ['乙一', 1], ['乙二', 2], ['乙三', 3], ['乙四', 4]
    ]);
    const plan = buildTopicVolRatioPlan([t1, t2], d, {});
    expect(plan.buy.heavy).toBe(plan.blocks[0]);
    expect(plan.buy.light).toBe(plan.blocks[1]);
    expect(plan.buy.candidates).toEqual([]);
    expect(plan.buy.noYizi).toBeNull();
    expect(plan.buy.smallTopic).toBeNull();
    expect(plan.buy.bigTopic).toBeNull();
  });

  it('buyNames = 本次选出的票（喂给卖点判「今天又进买点 ⇒ 持有」）', function() {
    const plan = buildTopicVolRatioPlan([aiTopic()], dm, { ctx: fullCtx() });
    expect(Array.from(plan.buyNames)).toEqual(['三六零']);
  });
});

// ── 第二轮 · 卖点段（decision-rules#buildSellPlan 的同一份实现）────────────────────────────
describe('tvrb · 卖点段复用决策看板的卖点计划', function() {
  // ⚠️ 与买点段同款处理：题材里的龙一（金山办公，688 科创板）【本来就没有龙位】。
  //    若给它 rank 1 且标成竞价一字，「龙一一字 ⇒ 全题材龙一字持有」这一档会盖掉所有其它档
  //    （那是 decision-rules 的既有规则，不是本看板的），本组用例要验的是常规卖出分档。
  const topics = [block('AI应用', 1, [
    m('金山办公', { aucVolRatio: 60, aucShare: 9 }),
    m('三六零', { aucVolRatio: 60, aucShare: 6, code: '601360' }),
    m('昆仑万维', { aucVolRatio: 60, aucShare: 6, code: '300418' }),
    m('汤姆猫', { aucVolRatio: 60, aucShare: 6, code: '300459' })
  ])];
  const dm = dragonMap([['三六零', 2], ['昆仑万维', 3], ['汤姆猫', 4]]);

  function sellRow(name, over) {
    return Object.assign({
      name: name,
      topic: 'AI应用',
      pct: 20,
      code: '601360',
      aucPct: 3,
      volRatioDir: '',
      volRatioTimes: null,
      aucShare: 1,
      inTodayList: true
    }, over || {});
  }

  it('没有卖点候选 ⇒ 不产卖点段（⛔ 不伪造一个空分组）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, {});
    expect(plan.sell).toEqual([]);
  });

  it('有候选 ⇒ 按题材分组，分组字段齐全（UI 直接拿来当 key / 题材行）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, { sellRows: [sellRow('昆仑万维')] });
    expect(plan.sell).toHaveLength(1);
    const g = plan.sell[0];
    expect(g.groupKey).toBeTruthy();
    expect(g.topic).toBe('AI应用');
    expect(g.topicRank).toBe(1);
    expect(g.items.map(function(x) { return x.name; })).toEqual(['昆仑万维']);
    // 卖出理由由 decision-rules 的同一份文案给（⛔ 本看板不另写一份「为什么卖」）
    expect(typeof g.reason).toBe('string');
    expect(g.reason.length).toBeGreaterThan(0);
    // §21：十日涨幅文案由 Logic 层补好，⛔ 组件不再 format 一次
    expect(g.items[0].pctText).toBe('+20%');
    // ★ [SELL-AVG-VR 2026-10-11 用户报障] 卖点侧的题材标题行也要有【平均竞价量比】——
    //   原先漏传 ⇒ 组件回落到 '—'（用户原话「题材的平均量比数值没有显示出来，只出现 -」）。
    //   值必须与买点侧同源（同一个 avgVolRatioOf）：本组 4 只成员量比都是 60 ⇒ 60.00
    expect(g.avgVolRatioText).toBe('60.00');
    expect(g.avgVolRatioText).toBe(plan.blocks[0].avgVolRatioText);
  });

  it('卖点题材【今日未成组】⇒ 平均量比如实给「—」（§10 ⛔ 不编 0.00 / 不默认为空）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, {
      sellRows: [sellRow('昆仑万维', { topic: '昨日已散题材' })]
    });
    expect(plan.sell).toHaveLength(1);
    expect(plan.sell[0].topic).toBe('昨日已散题材');
    expect(plan.sell[0].avgVolRatioText).toBe('—');
  });

  it('今天又进【本看板】买点 ⇒ 卖点标【持有】（而不是竞价卖）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, {
      sellRows: [sellRow('三六零', { aucShare: 6 })]
    });
    const it0 = plan.sell[0].items[0];
    expect(it0.name).toBe('三六零');
    expect(it0.sellActionTag).toBe(HOLD_TAG);
    expect(it0.sellActionTone).toBe('hold');
  });

  it('没进买点且占比不达标 ⇒ 卖点标【竞价卖】（走决策看板同一批判据）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, { sellRows: [sellRow('昆仑万维')] });
    const it0 = plan.sell[0].items[0];
    expect(it0.aucShareText).toBe('1.0%');
    expect(it0.sellActionTag).toBe(SELL_OUT_TAG);
    expect(it0.sellActionTone).toBe('out');
  });

  it('卖点段出场时把口径写进看板级说明（§10 理由必须可见）', function() {
    const plan = buildTopicVolRatioPlan(topics, dm, { sellRows: [sellRow('昆仑万维')] });
    expect(plan.notes.join('\n')).toContain('卖点候选');
  });
});

// ── 第四轮 · 空仓提醒（2026-10-13 用户口径）─────────────────────────────────────────────
describe('tvrb · 空仓提醒（入选题材里排名第一 平均量比 < 25 ⇒ 买点侧提示空仓）', function() {
  it('常量 = 25（用户原话的阈值，⛔ 不是推导值；改它等于改「今天开不开仓」）', function() {
    expect(TVRB_CASH_ALERT_AVG_VR).toBe(25);
  });

  /** 四个成员、量比全等于 v 的题材（平均量比 = v） */
  function flatTopic(topic, rank, v, n) {
    const members = [];
    const ranks = [];
    const cnt = n || 4;
    for (let i = 1; i <= cnt; i++) {
      const nm = topic + '票' + i;
      members.push(m(nm, { aucVolRatio: v }));
      if (i <= 3) ranks.push([nm, i]);
    }
    return { b: block(topic, rank, members), ranks: ranks };
  }

  /**
   * 用户 2026-10-13 的真实例子：
   *   电力新能源 3 只（平均量比 45.92，排 1，数量不足 4 只 ⇒ 排除）
   *   AI应用 14 只（平均量比 21.51，排 2 ⇒ 正常入选，成为「能入选的」排名第一）
   */
  function todayFixtures(aiRatio) {
    const power = flatTopic('电力新能源', 1, 45.92, 3);
    const ai = flatTopic('AI应用', 2, aiRatio === undefined ? 21.51 : aiRatio, 14);
    const dm = new Map();
    power.ranks.concat(ai.ranks).forEach(function(e) { dm.set(e[0], { rank: e[1], topic: '', groupSize: 0, pct: 20 }); });
    return { topics: [power.b, ai.b], dm: dm };
  }

  it('★ 用户今天的例子：量比最高的题材被排除 ⇒ 判据看【能入选的】排名第一 ⇒ 提示空仓', function() {
    const f = todayFixtures();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {});
    // 选股照旧：电力新能源排除、AI应用入选（下面「选股照常」用例还会逐项钉一遍）
    expect(plan.excludedTopics.map(function(t) { return t.topic; })).toEqual(['电力新能源']);
    expect(plan.blocks.map(function(b) { return b.topic; })).toEqual(['AI应用']);
    // 提醒
    expect(plan.cashAlert.show).toBe(true);
    expect(plan.cashAlert.topic).toBe('AI应用');            // ⛔ 不是被排除的电力新能源
    expect(plan.cashAlert.rank).toBe(2);
    expect(plan.cashAlert.avgVolRatio).toBeCloseTo(21.51, 10);
    expect(plan.cashAlert.avgVolRatioText).toBe('21.51');
    expect(plan.cashAlert.threshold).toBe(25);
    // 文案：大字标语 + 说明（字数不是重点，关键是「空仓」二字与「照常列出」的口径）
    expect(plan.cashAlert.headline).toContain('空仓');
    expect(plan.cashAlert.detail).toContain('21.51');
    expect(plan.cashAlert.detail).toContain(String(TVRB_CASH_ALERT_AVG_VR));
    expect(plan.cashAlert.detail).toContain('照常列出');
  });

  it('边界：恰好 25 ⇒ 不提示（用户口径是「小于 25」）；再低 0.01 就提示', function() {
    const eq = buildTopicVolRatioPlan(todayFixtures(25).topics, todayFixtures(25).dm, {});
    expect(eq.cashAlert.show).toBe(false);

    const hi = buildTopicVolRatioPlan(todayFixtures(25.01).topics, todayFixtures(25.01).dm, {});
    expect(hi.cashAlert.show).toBe(false);

    const lo = buildTopicVolRatioPlan(todayFixtures(24.99).topics, todayFixtures(24.99).dm, {});
    expect(lo.cashAlert.show).toBe(true);
    expect(lo.cashAlert.avgVolRatioText).toBe('24.99');
  });

  it('能入选的排名第一量比达标 ⇒ 不提示（⛔ 排名第二再低也不提示：它只会更低）', function() {
    const a = flatTopic('强题材', 1, 30);
    const b = flatTopic('弱题材', 2, 10);
    const dm = new Map();
    a.ranks.concat(b.ranks).forEach(function(e) { dm.set(e[0], { rank: e[1], topic: '', groupSize: 0, pct: 20 }); });
    const plan = buildTopicVolRatioPlan([a.b, b.b], dm, {});
    expect(plan.blocks.map(function(x) { return x.topic; })).toEqual(['强题材', '弱题材']);
    expect(plan.cashAlert.show).toBe(false);   // 第一达标 ⇒ 不提示（哪怕第二只有 10）
  });

  it('§10：平均量比读不出来（该题材一行量比都没有）⇒ 不提示（未知 ≠ 低）', function() {
    const b = block('无量比题材', 1, [
      m('甲', { aucVolRatio: null }), m('乙', { aucVolRatio: '' }),
      m('丙', { aucVolRatio: null }), m('丁', { aucVolRatio: undefined })
    ]);
    const plan = buildTopicVolRatioPlan([b], dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4]]), {});
    expect(avgVolRatioOf(b)).toBeNull();
    expect(plan.cashAlert.show).toBe(false);
    expect(plan.cashAlert.avgVolRatioText).toBe('—');
  });

  it('一个题材都没入选 ⇒ 不提示（那是「没有合格题材」，看板另有说明，⛔ 不拿这条冒充）', function() {
    const b = flatTopic('只有三只', 1, 5, 3);
    const plan = buildTopicVolRatioPlan([b.b], dragonMap(b.ranks), {});
    expect(plan.blocks).toEqual([]);
    expect(plan.cashAlert.show).toBe(false);
    expect(plan.cashAlert).toEqual(buildCashAlert(null));
  });

  it('★ 命中提醒时【选股与标签一行未改】：档位 / 只数 / 票名与「量比达标」时逐项一致', function() {
    const low = todayFixtures(21.51);
    const ok = todayFixtures(30);
    const pLow = buildTopicVolRatioPlan(low.topics, low.dm, {});
    const pOk = buildTopicVolRatioPlan(ok.topics, ok.dm, {});
    // 提醒：一个开一个不开
    expect(pLow.cashAlert.show).toBe(true);
    expect(pOk.cashAlert.show).toBe(false);
    // 选股：完全一致（AI应用 14 只 ⇒ big 档 ⇒ 取 2 只）
    expect(pLow.blocks.map(function(b) { return b.topic + '|' + b.tier + '|' + b.pickCount; }))
      .toEqual(pOk.blocks.map(function(b) { return b.topic + '|' + b.tier + '|' + b.pickCount; }));
    expect(pLow.blocks[0].picks.map(function(p) { return p.name; }))
      .toEqual(pOk.blocks[0].picks.map(function(p) { return p.name; }));
    expect(pLow.pickCount).toBe(pOk.pickCount);
    expect(pLow.pickCount).toBe(2);
    // 说明文字也不因提醒而变化（提醒是独立一段，不进 notes）
    expect(pLow.notes).toEqual(pOk.notes);
    expect(pLow.notes.join('\n')).not.toContain('空仓');
  });

  it('buildCashAlert 直接调用：空块 / 缺均值都返回同一份「不提示」冻结常量', function() {
    expect(buildCashAlert(null)).toBe(buildCashAlert(undefined));
    expect(buildCashAlert(null).show).toBe(false);
    expect(TVRB_CASH_ALERT_AVG_VR).toBe(25);
  });
});

// ── 第五轮 · 退潮首日（2026-10-13 用户口径）──────────────────────────────────────────────
// 用户原话：「市场上十日涨幅最高的那只股票所在的题材，在题材退潮首日（龙一停牌或者占比不达标），
//   卖点侧同题材龙二可以看分笔卖出……还有不同题材的龙一也可以这样，但要有条件，不同题材的龙一
//   必须是总市场的龙二……相当于选出两只可以等开盘卖出的。……其它普通股票都可以竞价卖，降低风险。」
// 用户拍板的 4 条口径：涨幅排名用【昨日】/ 其余票连【持有】也一起改竞价卖 / 龙位【顺延】下一个 /
//   买点侧【整体全灰】。
describe('tvrb · 退潮首日 detectEbbDay（判据）', function() {
  /** 用户 2026-10-13 的真实例子：新华传媒（AI应用，昨日 159.51%）+ 时代万恒（新能源汽车龙一，80.98%） */
  function ebb(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      second: { name: '时代万恒', pct: 80.98, topic: '新能源汽车' },
      leaderSuspended: false,
      leaderShare: 1.2,
      siblingDragons: [
        { name: '新华文轩', rank: 2, isYizi: false, suspended: false },
        { name: '皖新传媒', rank: 3, isYizi: false, suspended: false }
      ],
      secondInfo: {
        name: '时代万恒', pct: 80.98, topic: '新能源汽车',
        rank: 1, isYizi: false, suspended: false
      }
    }, over || {});
  }

  it('§10：事实未就绪 / 缺 leader / 缺涨幅 ⇒ null（未知 ≠ 不是退潮日）', function() {
    expect(detectEbbDay(null)).toBe(null);
    expect(detectEbbDay(undefined)).toBe(null);
    expect(detectEbbDay({ ready: false, leader: null })).toBe(null);
    expect(detectEbbDay({ ready: true, leader: null })).toBe(null);
    expect(detectEbbDay(ebb({ leader: { name: '新华传媒', pct: null, topic: 'AI应用' } }))).toBe(null);
  });

  it('★ 判据①：总龙今日【停牌】⇒ 退潮（reason = suspend）', function() {
    const e = detectEbbDay(ebb({ leaderSuspended: true }));
    expect(e).not.toBe(null);
    expect(e.reason).toBe('suspend');
    expect(e.leaderName).toBe('新华传媒');
    expect(e.leaderTopic).toBe('AI应用');
    // ⚠️ 十日涨幅的展示口径 = decision-rules#formatRangePct（取整，与行内「+160%」逐字一致，§6）
    expect(e.leaderPctText).toBe('+160%');
    expect(e.whyText).toContain('停牌');
  });

  it('★ 判据②：总龙【占比不达标】⇒ 退潮（reason = share）；达标 ⇒ 不是退潮日', function() {
    const bad = detectEbbDay(ebb({ leaderShare: 1.2 }));
    expect(bad.reason).toBe('share');
    expect(bad.whyText).toContain('1.2%');

    // 它是今日龙一 ⇒ 走【龙头门槛 3.5%】：恰好 3.5 达标 ⇒ 不退潮
    expect(detectEbbDay(ebb({ leaderShare: 3.5 }))).toBe(null);
    expect(detectEbbDay(ebb({ leaderShare: 9 }))).toBe(null);
  });

  it('§10：占比【缺数据】⇒ 不判退潮（未知 ≠ 不达标）', function() {
    expect(detectEbbDay(ebb({ leaderShare: null }))).toBe(null);
  });

  it('★ 允许【看分笔卖】的两只 = 同题材可用龙位 + 市场总龙二', function() {
    const e = detectEbbDay(ebb({ leaderSuspended: true }));
    expect(EBB_PICK_TAG).toBe('看分笔卖');
    expect(EBB_PICK_TONE).toBe('pen');
    expect(e.siblingName).toBe('新华文轩');
    expect(e.siblingRank).toBe(2);
    expect(e.siblingLabel).toBe('龙二');
    expect(e.secondName).toBe('时代万恒');
    expect(e.secondTopic).toBe('新能源汽车');
    expect(e.secondPctText).toBe('+81%');
    // 「说明」里必须把两只是谁 + 其余怎么办都写清（用户要「改下标签和说明」）
    expect(e.detail).toContain('新华文轩');
    expect(e.detail).toContain('时代万恒');
    expect(e.detail).toContain(EBB_PICK_TAG);
    expect(e.detail).toContain(SELL_OUT_TAG);
    expect(e.detail).toContain('退潮');
    // 买点侧走退潮口径的空仓标语
    expect(e.buyHeadline).toContain('退潮首日');
    expect(e.buyHeadline).toContain('空仓');
  });

  it('★ 同题材龙位【顺延】：龙二停牌 / 龙二一字 ⇒ 都取龙三（用户拍板「顺延下一个」）', function() {
    const susp = detectEbbDay(ebb({
      leaderSuspended: true,
      siblingDragons: [
        { name: '新华文轩', rank: 2, isYizi: false, suspended: true },
        { name: '皖新传媒', rank: 3, isYizi: false, suspended: false }
      ]
    }));
    expect(susp.siblingName).toBe('皖新传媒');
    expect(susp.siblingRank).toBe(3);
    expect(susp.siblingLabel).toBe('龙三');

    const yizi = detectEbbDay(ebb({
      leaderSuspended: true,
      siblingDragons: [
        { name: '新华文轩', rank: 2, isYizi: true, suspended: false },
        { name: '皖新传媒', rank: 3, isYizi: false, suspended: false }
      ]
    }));
    expect(yizi.siblingName).toBe('皖新传媒');
  });

  it('★ 同题材龙位全不可用 ⇒ 该只不成立（⛔ 不回落到总龙自己、也不收无龙位票）', function() {
    const e = detectEbbDay(ebb({
      leaderSuspended: true,
      siblingDragons: [
        { name: '新华文轩', rank: 2, isYizi: true, suspended: true },
        { name: '创票', rank: null, isYizi: false, suspended: false }
      ]
    }));
    expect(e.siblingName).toBe('');
    expect(e.siblingRank).toBe(null);
    expect(e.picksText).toContain('时代万恒');   // 另一只（市场总龙二）仍在
  });

  it('★ 市场总龙二【不顺延】：不是它题材的龙一 / 一字 / 停牌 / 与总龙同题材 ⇒ 一律不成立', function() {
    const cases = [
      { rank: 3, isYizi: false, suspended: false, topic: '新能源汽车' },   // 不是龙一
      { rank: null, isYizi: false, suspended: false, topic: '新能源汽车' },// 无龙位
      { rank: 1, isYizi: true, suspended: false, topic: '新能源汽车' },    // 竞价一字
      { rank: 1, isYizi: false, suspended: true, topic: '新能源汽车' },    // 停牌
      { rank: 1, isYizi: false, suspended: false, topic: 'AI应用' }        // 与总龙同题材
    ];
    cases.forEach(function(over) {
      const e = detectEbbDay(ebb({
        leaderSuspended: true,
        secondInfo: Object.assign({ name: '时代万恒', pct: 80.98 }, over)
      }));
      expect(e.secondName).toBe('');
    });
    // 两只都不成立 ⇒ 如实说「本日无符合条件的票」
    const none = detectEbbDay(ebb({
      leaderSuspended: true,
      siblingDragons: [],
      secondInfo: { name: '时代万恒', pct: 80.98, topic: '新能源汽车', rank: 3, isYizi: false, suspended: false }
    }));
    expect(none.picksText).toContain('无符合条件');
    expect(none.detail).toContain('今天没有符合条件');
  });

  it('★ 总龙不是今日龙一（无龙标）⇒ 走【非龙头门槛 2%】（更宽松 ⇒ 更不容易误判成退潮）', function() {
    const e = detectEbbDay(ebb({
      leader: { name: '创票', pct: 159.51, topic: 'AI应用', code: '300001', rank: null, isYizi: false },
      leaderShare: 2.5
    }));
    expect(e).toBe(null);                       // 2.5 ≥ 2 ⇒ 达标 ⇒ 不退潮
    const e2 = detectEbbDay(ebb({
      leader: { name: '创票', pct: 159.51, topic: 'AI应用', code: '300001', rank: null, isYizi: false },
      leaderShare: 1.5
    }));
    expect(e2.reason).toBe('share');
  });
});

describe('tvrb · 退潮首日的卖点改写（经 buildTopicVolRatioPlan）', function() {
  // AI应用 10 只（> 8 ⇒ big 档 ⇒ 取 2 只：甲一 / 甲二）⇒ 买点名单 = 甲一 / 甲二
  const names = ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六', '甲七', '甲八', '甲九', '甲十'];
  const topics = [block('AI应用', 1, names.map(function(n, i) {
    return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
  }))];
  const dm = dragonMap(names.map(function(n, i) { return [n, i + 1]; }));

  function sellRow(name, over) {
    return Object.assign({
      name: name, topic: 'AI应用', pct: 20, code: '600001',
      aucPct: 3, volRatioDir: '', volRatioTimes: null, aucShare: 1, inTodayList: true
    }, over || {});
  }
  // 退潮首日的事实：总龙 = 甲一（停牌）；同题材可用龙位 = 甲二；市场总龙二 = 时代万恒
  const EBB_CTX = {
    ready: true,
    leader: { name: '甲一', pct: 159.51, topic: 'AI应用', code: '600001', rank: 1, isYizi: false },
    second: { name: '时代万恒', pct: 80.98, topic: '新能源汽车' },
    leaderSuspended: true,
    leaderShare: null,
    siblingDragons: [{ name: '甲二', rank: 2, isYizi: false, suspended: false }],
    secondInfo: {
      name: '时代万恒', pct: 80.98, topic: '新能源汽车',
      rank: 1, isYizi: false, suspended: false
    }
  };
  const rows = [
    sellRow('甲二', { aucShare: 6 }),                                // 可用龙位（原本占比达标 + 今天又进买点 ⇒ 持有）
    sellRow('甲一', { aucShare: 6 }),                                // 总龙自己（原本也是持有）
    sellRow('甲五', { aucShare: 1 }),                                // 普通票（原本尾盘卖 / 竞价卖）
    sellRow('时代万恒', { topic: '新能源汽车', aucShare: null })       // 市场总龙二
  ];

  function findItem(plan, name) {
    for (let i = 0; i < plan.sell.length; i++) {
      const items = plan.sell[i].items || [];
      for (let k = 0; k < items.length; k++) if (items[k].name === name) return items[k];
    }
    return null;
  }

  it('不传 ebbCtx ⇒ 卖点完全走原口径（ebb 恒为 null，⛔ 不误判成退潮日）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows });
    expect(p.ebb).toBe(null);
    expect(findItem(p, '甲二').sellActionTag).toBe(HOLD_TAG);   // 原本是【持有】
  });

  it('ebbCtx 未就绪（昨日涨幅还没读回来）⇒ 同「不是退潮日」（§10 不猜）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, {
      sellRows: rows, ebbCtx: { ready: false, leader: null }
    });
    expect(p.ebb).toBe(null);
    expect(findItem(p, '甲二').sellActionTag).toBe(HOLD_TAG);
  });

  it('★ 退潮首日：那两只标【看分笔卖】，其余（含原本【持有】的）一律【竞价卖】', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    expect(p.ebb).not.toBe(null);
    expect(p.ebb.reason).toBe('suspend');

    // ① 同题材可用龙位
    const sib = findItem(p, '甲二');
    expect(sib.sellActionTag).toBe(EBB_PICK_TAG);
    expect(sib.sellActionTone).toBe(EBB_PICK_TONE);
    expect(sib.holdTag).toBe('');                 // 与「看分笔卖」互斥（原口径的持有让路）
    // ② 市场总龙二
    expect(findItem(p, '时代万恒').sellActionTag).toBe(EBB_PICK_TAG);
    // ③ 其余：总龙自己 + 普通票 —— 用户拍板「连持有也一起改竞价卖」
    const one = findItem(p, '甲一');
    expect(one.sellActionTag).toBe(SELL_OUT_TAG);
    expect(one.sellActionTone).toBe('out');
    expect(one.holdTag).toBe('');
    expect(findItem(p, '甲五').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('★ 只改【动作标签】：客观数据（涨幅 / 占比 / 龙标）逐项保留', function() {
    const base = buildTopicVolRatioPlan(topics, dm, { sellRows: rows });
    const ebbP = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    ['甲一', '甲二', '甲五'].forEach(function(n) {
      const a = findItem(base, n);
      const b = findItem(ebbP, n);
      expect(b.pctText).toBe(a.pctText);
      expect(b.aucShareText).toBe(a.aucShareText);
      expect(b.aucShareTone).toBe(a.aucShareTone);
      expect(b.dragonLabel).toBe(a.dragonLabel);
      expect(b.aucPctText).toBe(a.aucPctText);
    });
  });

  it('★ 退潮首日的行内说明写清「为什么是这两只 / 其余为什么竞价卖 / 不看占比」', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    expect(findItem(p, '甲二').actionNote).toContain('退潮首日');
    expect(findItem(p, '甲二').actionNote).toContain('市场总龙');
    expect(findItem(p, '甲二').actionNote).toContain('分笔成交');
    expect(findItem(p, '时代万恒').actionNote).toContain('市场总龙二');
    expect(findItem(p, '甲五').actionNote).toContain('降低风险');
    expect(findItem(p, '甲五').actionNote).toContain('不看');
  });

  it('★ 买点侧改走【退潮口径】的空仓标语，且【选股一行未改】', function() {
    const base = buildTopicVolRatioPlan(topics, dm, { sellRows: rows });
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    // 平时不提示（本组平均量比 60 ≥ 25）
    expect(base.cashAlert.show).toBe(false);
    // 退潮日 ⇒ 提示，且是退潮口径
    expect(p.cashAlert.show).toBe(true);
    expect(p.cashAlert.headline).toContain('退潮首日');
    expect(p.cashAlert.headline).toContain('空仓');
    // 选股（档位 / 只数 / 票名）与平时逐项一致 —— 灰化只是视觉，⛔ 不动数据
    expect(p.blocks.map(function(b) { return b.topic + '|' + b.tier + '|' + b.pickCount; }))
      .toEqual(base.blocks.map(function(b) { return b.topic + '|' + b.tier + '|' + b.pickCount; }));
    expect(p.blocks[0].picks.map(function(x) { return x.name; }))
      .toEqual(base.blocks[0].picks.map(function(x) { return x.name; }));
  });

  // ── ★ [第六轮 2026-10-13 用户口径] 买点侧「退潮不买」────────────────────────────────────
  //   用户原话：「退潮当天，只有卖没有买吗？新华文轩买点侧还标有 持有 竞价买，应该标的是，
  //     『退潮不买』……还是我说的规则，标签改变下。其它不变。」
  it('不传 ebbCtx ⇒ 买点标签完全走原口径（⛔ 不把「不是退潮日」写成「退潮不买」）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows });
    expect(p.ebb).toBe(null);
    const picks = p.blocks[0].picks;
    // 甲一 / 甲二：占比达标 ⇒ 决策看板的【竞价买】（挡位原样）
    expect(picks.map(function(x) { return x.buyActionTag; })).toContain(BUY_NOW_TAG);
    expect(picks.every(function(x) { return x.buyActionTag !== EBB_NO_BUY_TAG; })).toBe(true);
  });

  it('ebbCtx 未就绪 ⇒ 买点同样走原口径（§10 不猜）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, {
      sellRows: rows, ebbCtx: { ready: false, leader: null }
    });
    expect(p.ebb).toBe(null);
    expect(p.blocks[0].picks.every(function(x) { return x.buyActionTag !== EBB_NO_BUY_TAG; })).toBe(true);
  });

  it('★ 退潮首日：买点侧每一只的标签一律【退潮不买】（用户「只有卖没有买」）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    expect(p.ebb).not.toBe(null);
    p.blocks.forEach(function(b) {
      b.picks.forEach(function(x) {
        expect(x.buyActionTag).toBe(EBB_NO_BUY_TAG);
        expect(x.buyActionTone).toBe(EBB_NO_BUY_TONE);
      });
    });
  });

  it('★ 买点侧：原本的【持有】/ 仓位槽被清掉（同一行不会既【退潮不买】又【持有】）', function() {
    // 用带「昨天真买过」的 ctx ⇒ 平时 buying 侧的甲一 / 甲二 会被标【持有】
    const ctx = { prevBought: new Set(['甲一', '甲二']), prevDragonNames: new Set() };
    const base = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ctx: ctx });
    const eb = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ctx: ctx, ebbCtx: EBB_CTX });
    // 平时：仓位槽 / 行尾持有至少有一处写着【持有】
    const baseHold = base.blocks[0].picks.some(function(x) {
      return x.holdTag === HOLD_TAG || x.position === HOLD_TAG;
    });
    expect(baseHold).toBe(true);
    // 退潮日：两处都被清空，只剩【退潮不买】
    eb.blocks[0].picks.forEach(function(x) {
      expect(x.holdTag).toBe('');
      expect(x.position).toBe('');
      expect(x.buyActionTag).toBe(EBB_NO_BUY_TAG);
    });
  });

  it('★ 买点侧只改【标签与说明】：客观数据（十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标）逐项保留', function() {
    const base = buildTopicVolRatioPlan(topics, dm, { sellRows: rows });
    const eb = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    base.blocks[0].picks.forEach(function(a, i) {
      const b = eb.blocks[0].picks[i];
      expect(b.name).toBe(a.name);
      expect(b.pctText).toBe(a.pctText);
      expect(b.aucPctText).toBe(a.aucPctText);
      expect(b.volRatioText).toBe(a.volRatioText);
      expect(b.aucShareText).toBe(a.aucShareText);
      expect(b.dragonLabel).toBe(a.dragonLabel);
      expect(b.seq).toBe(a.seq);
    });
  });

  it('★ 买点侧的逐行说明讲清「为什么今天不买 / 原信号作废 / ⛔ 不动买卖点本身」', function() {
    const eb = buildTopicVolRatioPlan(topics, dm, { sellRows: rows, ebbCtx: EBB_CTX });
    const note = eb.blocks[0].picks[0].actionNote;
    expect(note).toContain('退潮首日');
    expect(note).toContain('市场总龙');
    expect(note).toContain('不开新仓');
    expect(note).toContain(HOLD_TAG);      // 原信号作废（点名【持有】）
    expect(note).toContain('作废');
  });
});

// ── 规则文案 ─────────────────────────────────────────────────────────────────────────────
describe('tvrb · buildTvrbRulesLines 规则文案', function() {
  const lines = buildTvrbRulesLines();

  it('是逐行数组，且条数 ≥ 10（选股 7 条 + 第二轮补的买卖标签 / 卖点 / 分笔 / 数据来源等）', function() {
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(10);
    lines.forEach(function(l) { expect(typeof l).toBe('string'); });
  });

  it('第三轮补的【操作纪律】必须写进规则（用户要求：写进规范，起提醒作用 + 规范自己的交易行为）', function() {
    const all = lines.join('\n');
    // 八条操作纪律：买点侧 / 卖点侧各一条（用户 2026-10-11 原话交代的实盘流程）
    expect(all).toContain('操作纪律');
    expect(all).toContain('9:26');        // 竞价看到【竞价买】⇒ 9:26 左右先买一笔
    expect(all).toContain('9:31');        // 9:31 左右看分笔成交的结论
    expect(all).toContain('补一笔');      // 分笔提示【下杀买】⇒ 再补一笔摊低成本
    expect(all).toContain('拉低持仓成本');
    expect(all).toContain('再补');        // 【立刻买】⇒ 不再补（两个买点吻合）
    expect(all).toContain('卖半仓');      // 【竞价卖】⇒ 竞价期间先卖半仓
    expect(all).toContain('冲高再清');    // 【冲高卖】⇒ 等冲高再清
    expect(all).toContain('止损');        // 【立刻卖】⇒ 止损
    // 上游成交笔数的口径也要写进规则（用户提问：4190 是什么意思）
    expect(all).toContain('上游成交笔数');
    expect(all).toContain('快照');
  });

  it('含标题与关键口径，且数字来自常量（不是写死）', function() {
    const all = lines.join('\n');
    expect(all).toContain('题材量比');
    expect(all).toContain('平均竞价量比');
    expect(all).toContain('龙一');
    expect(all).toContain('竞价涨停');
    // 档位数字与常量一致
    expect(all).toContain(String(TVRB_MIN_COUNT));
    expect(all).toContain(String(TVRB_MID_MAX));
    expect(all).toContain(String(TVRB_TOPIC_LIMIT));
  });

  it('第二轮补齐的口径必须都写进规则（买卖标签同源 / 卖点段 / 无仓位 / 分笔图 / 不抓数据）', function() {
    const all = lines.join('\n');
    expect(all).toContain('决策看板完全同一套');   // 八：买点 / 卖点标签复用同一份实现
    expect(all).toContain('卖点段');               // 九：卖点候选与动作
    expect(all).toContain('不标重仓');             // 十：本看板没有仓位口径
    expect(all).toContain('分笔');                 // 十一：展开面板 = 分笔明细
    expect(all).toContain('不抓数据');             // 十三：不额外消耗额度
  });

  it('第四轮补的【空仓提醒】必须写进规则（阈值取常量，⛔ 不写死；口径要写清「不改选股」）', function() {
    const all = lines.join('\n');
    expect(all).toContain('空仓提醒');
    expect(all).toContain(String(TVRB_CASH_ALERT_AVG_VR));
    expect(all).toContain('不改变选股');
  });

  it('第五轮补的【退潮首日】必须写进规则（判据 / 两只 / 其余竞价卖 / 买点侧空仓）', function() {
    const all = lines.join('\n');
    expect(all).toContain('退潮首日');
    expect(all).toContain('市场总龙');
    expect(all).toContain(EBB_PICK_TAG);
    expect(all).toContain('顺延');            // 同题材龙位可顺延
    expect(all).toContain('不顺延');          // 市场总龙二不顺延
    expect(all).toContain('昨日');            // 涨幅口径必须是昨日
    expect(all).toContain('竞价卖');          // 其余一律竞价卖
  });

  it('第六轮补的【退潮不买】必须写进规则（买点侧只有卖没有买）', function() {
    const all = lines.join('\n');
    expect(all).toContain(EBB_NO_BUY_TAG);
    expect(all).toContain('只有卖');
  });

  it('第七轮补的【总龙只认有龙位的票】必须写进规则（创业板 / 科创板无龙标 ⇒ 不参排）', function() {
    const all = lines.join('\n');
    expect(all).toContain('有龙位');     // 总龙候选池的闸门口径
    expect(all).toContain('创业板');      // 讲清被排除的是哪一类（300/301）
    expect(all).toContain('科创板');      // 以及 688/689
  });
});


// ── 第八轮 · 退潮「只在首日生效」闸门（2026-10-14 用户口径）──────────────────────────────────
// 用户原话：「我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
//   又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
// 用户拍板：昨日状态【优先读落库的判定】（tvrb_ebb_days 表），读不到用昨日行情行推断，
//   两处都取不到 ⇒ 按首日处理（宁可多提醒一次）。
describe('tvrb · 第八轮 · 退潮「只在首日生效」闸门', function() {
  function ctx(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      leaderSuspended: true,
      leaderShare: null,
      siblingDragons: [],
      secondInfo: null,
      buySecond: null,
      // 退路用的【昨日行情行】事实（落库判定缺失时才会被读）
      prevLeader: { volume: 0, share: null, suspendedLike: true, shareFail: false, bad: true }
    }, over || {});
  }

  it('§10：昨日状态两处都取不到 ⇒ 按【首日】处理（宁可多提醒一次，不漏掉风险）', function() {
    const e = detectEbbDay(ctx({ prevLeader: null }), null);
    expect(e).not.toBe(null);
    expect(e.firstDay).toBe(true);
    expect(e.firstDaySource).toBe('unknown');
    expect(e.detail).toContain('按【首日】处理');
  });

  it('★ 落库判定：昨日同一只总龙【已经退潮】⇒ 今天不是首日 ⇒ 规则不生效（返回 null）', function() {
    expect(detectEbbDay(ctx(), { leader_stock: '新华传媒', ebb: true })).toBe(null);
  });

  it('★ 落库判定：昨日同一只总龙【没退潮】⇒ 今天是首日（正常生效）', function() {
    const e = detectEbbDay(ctx(), { leader_stock: '新华传媒', ebb: false });
    expect(e).not.toBe(null);
    expect(e.firstDaySource).toBe('table');
    expect(e.detail).toContain('落库判定');
  });

  it('★ 落库判定：昨日总龙是【别的票】⇒ 对今天这只是首日（只认同一只总龙）', function() {
    const e = detectEbbDay(ctx(), { leader_stock: '别的龙', ebb: true });
    expect(e).not.toBe(null);
    expect(e.firstDaySource).toBe('table');
    expect(e.detail).toContain('不是同一只');
  });

  it('★ 表里没有昨天 ⇒ 退化为【昨日行情行推断】：竞价量 0 ⇒ 已在坏状态 ⇒ 今天不算首日', function() {
    expect(detectEbbDay(ctx({ prevLeader: { volume: 0, share: null, bad: true } }), null)).toBe(null);
  });

  it('★ 推断：昨日行情行状态正常（有竞价 + 占比达标）⇒ 今天是首日', function() {
    const e = detectEbbDay(ctx({ prevLeader: { volume: 12345, share: 5, bad: false } }), null);
    expect(e).not.toBe(null);
    expect(e.firstDaySource).toBe('inferred');
    expect(e.detail).toContain('行情行推断');
  });
});

// ── 第八轮 · 买点侧唯一那只【总龙二买】（2026-10-14 用户口径）──────────────────────────────
// 用户原话：「买点只有一个，那就是市场的龙二（不是同题材的），是整个早盘竞价看板的股票列表中的
//   十日涨幅排名第二的龙二，就像今天的九阳股份（市场排名十日涨幅 86%，总列表排名第二），
//   把它入选到买点侧……注意我说的的时间点，是市场总龙头出现首日停牌或者占比不达标的情况下，
//   买点侧只有一个，那就是市场的龙二（十日涨幅排名第二），其它都是卖点侧不变。」
describe('tvrb · 第八轮 · 买点侧唯一那只「总龙二买」', function() {
  /** 10-13 的真实例子：九阳股份 002242，当日十日涨幅 86%，全列表排名第二（当日龙二） */
  const SECOND = {
    name: '九阳股份', pct: 86, topic: '家电', code: '002242',
    rank: 2, isYizi: false, suspended: false
  };

  function ctx(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      leaderSuspended: true,
      leaderShare: null,
      siblingDragons: [],
      secondInfo: null,
      prevLeader: null,        // 两处都取不到 ⇒ 按首日处理（闸门放行）
      buySecond: SECOND
    }, over || {});
  }

  it('★ 有龙二 ⇒ 买点标语改口径，明细写清「只有这一只 / 它是排名第二」', function() {
    const e = detectEbbDay(ctx(), null);
    expect(e.buySecondOn).toBe(true);
    expect(e.buySecondName).toBe('九阳股份');
    expect(e.buySecondLabel).toBe('龙二');
    expect(e.buySecondPctText).toBe('+86%');
    expect(e.buySecondTopic).toBe('家电');
    expect(e.buySecondCode).toBe('002242');
    expect(e.buyHeadline).toContain(EBB_SECOND_BUY_TAG);
    expect(e.buyDetail).toContain('九阳股份');
    expect(e.buyDetail).toContain('排名第二');
    expect(e.buyDetail).toContain('市场龙二');
    expect(e.buyDetail).toContain(EBB_NO_BUY_TAG);   // 其余入选票一律【退潮不买】
  });

  it('§10：当日涨幅没加载（算不出龙二）⇒ 标语如实说「算不出」并回到空仓口径（⛔ 不拿昨日口径顶替）', function() {
    const e = detectEbbDay(ctx({ buySecond: null }), null);
    expect(e.buySecondOn).toBe(false);
    expect(e.buySecondName).toBe('');
    expect(e.buyHeadline).toContain('空仓');
    // 退潮本身仍然成立（卖点侧照旧收紧），只是买点侧给不出那一只
    expect(e.reason).toBe('suspend');
  });

  it('它今日停牌 / 竞价一字 ⇒ 照样列出来并如实标注（⛔ 不顺延到第三名）', function() {
    const s = detectEbbDay(ctx({ buySecond: Object.assign({}, SECOND, { suspended: true }) }), null);
    expect(s.buySecondOn).toBe(true);
    expect(s.buySecondTrouble).toContain('停牌');
    const y = detectEbbDay(ctx({ buySecond: Object.assign({}, SECOND, { isYizi: true }) }), null);
    expect(y.buySecondOn).toBe(true);
    expect(y.buySecondTrouble).toContain('一字');
  });
});

describe('tvrb · 第八轮 · 唯一买点那一行接进 buildTopicVolRatioPlan', function() {
  // ⚠️ 刻意把【家电】放在第 3 位：本看板只取排名最靠前的 2 个题材（TVRB_TOPIC_LIMIT）⇒
  //    家电【不会成为常规入选块】，九阳股份也就【不可能靠常规通路】进 buyNames。
  //    这样「九阳股份在 buyNames 里」这条断言才真正证明【是龙二接线放进去的】，而不是被常规选股顺带带入。
  const names = ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六', '甲七', '甲八', '甲九', '甲十'];
  const bNames = ['乙一', '乙二', '乙三', '乙四', '乙五', '乙六', '乙七', '乙八', '乙九', '乙十'];
  const jdNames = ['九阳股份', '家电乙', '家电丙', '家电丁', '家电戊'];
  const topics = [
    block('AI应用', 1, names.map(function(n, i) {
      return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
    })),
    block('电力新能源', 2, bNames.map(function(n, i) {
      return m(n, { aucVolRatio: 50, aucShare: 6, code: '6001' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
    })),
    block('家电', 3, jdNames.map(function(n, i) {
      return m(n, { aucVolRatio: 30, aucShare: 3, code: '00224' + i });
    }))
  ];
  const dm = dragonMap(names.map(function(n, i) { return [n, i + 1]; }));
  bNames.forEach(function(n, i) { dm.set(n, { rank: i + 1, topic: '电力新能源', groupSize: 10, pct: 40 }); });
  dm.set('九阳股份', { rank: 2, topic: '家电', groupSize: 5, pct: 86 });

  const EBB_CTX2 = {
    ready: true,
    leader: { name: '甲一', pct: 159.51, topic: 'AI应用', code: '600001', rank: 1, isYizi: false },
    leaderSuspended: true,
    leaderShare: null,
    siblingDragons: [],
    secondInfo: null,
    prevLeader: null,
    buySecond: {
      name: '九阳股份', pct: 86, topic: '家电', code: '002242',
      rank: 2, isYizi: false, suspended: false
    }
  };

  it('★ 产出 out.ebbBuy：单只票 + 专属标签 + 槽位同步 + 进买点名单', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { ebbCtx: EBB_CTX2 });
    expect(p.ebb).not.toBe(null);
    expect(p.ebbBuy).not.toBe(null);
    expect(p.ebbBuy.isEbbSecond).toBe(true);
    expect(p.ebbBuy.picks.length).toBe(1);
    const pick = p.ebbBuy.picks[0];
    expect(pick.name).toBe('九阳股份');
    expect(pick.buyActionTag).toBe(EBB_SECOND_BUY_TAG);
    expect(pick.buyActionTone).toBe(EBB_SECOND_BUY_TONE);
    expect(pick.holdTag).toBe('');
    expect(pick.position).toBe('');
    expect(p.ebbBuy.ruleNo).toBe(EBB_SECOND_RULE_NO);
    // 槽位同步 ⇒ 四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）经 buyBlocksFlat 遍历得到它
    expect(p.buy.ebbSecond).toBe(p.ebbBuy);
    // 买点名单 ⇒ 它若同时在卖点侧，卖点标【持有】而不是被要求清仓
    expect(p.buyNames.has('九阳股份')).toBe(true);
    // 用户拍板：常规题材块照旧列出来（灰化空仓视觉保留），只是不再有买点
    expect(p.blocks[0].picks.every(function(x) { return x.buyActionTag === EBB_NO_BUY_TAG; })).toBe(true);
    expect(p.blocks[0].picks.length).toBeGreaterThan(0);
  });

  it('★ 行内说明：写出它的常规买点信号（占比达标 ⇒ 竞价买），信息一枚不丢', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { ebbCtx: EBB_CTX2 });
    const note = p.ebbBuy.picks[0].actionNote;
    expect(note).toContain('市场龙二');
    expect(note).toContain('排名第二');
    expect(note).toContain(EBB_SECOND_BUY_TAG);
    expect(note).toContain(EBB_NO_BUY_TAG);
    expect(note).toContain('常规买点信号');
  });

  it('§10：算不出龙二（当日涨幅未就绪）⇒ 没有这一行、没有槽位、也不进买点名单（⛔ 不拿别的票顶替）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, {
      ebbCtx: Object.assign({}, EBB_CTX2, { buySecond: null })
    });
    expect(p.ebb).not.toBe(null);          // 退潮本身仍成立（卖点侧照旧收紧）
    expect(p.ebbBuy).toBe(null);
    expect(p.buy.ebbSecond).toBe(null);
    // 家电没进 blocks ⇒ 九阳股份本就【不可能】靠常规通路进名单 ⇒ 这一条挂掉只可能是接线出的错
    expect(p.buyNames.has('九阳股份')).toBe(false);
    // 全计划里【一枚】总龙二买的标签都不该出现
    const allTags = [];
    p.blocks.forEach(function(b) {
      (b.picks || []).forEach(function(x) { allTags.push(x.buyActionTag); });
    });
    expect(allTags).not.toContain(EBB_SECOND_BUY_TAG);
  });

  it('不是退潮日 / ebbCtx 未就绪 ⇒ 没有 ebbBuy（⛔ 不误给一只票）', function() {
    expect(buildTopicVolRatioPlan(topics, dm, {}).ebbBuy).toBe(null);
    expect(buildTopicVolRatioPlan(topics, dm, { ebbCtx: { ready: false, leader: null } }).ebbBuy).toBe(null);
  });

  it('★ 它同时在卖点侧（昨天买过）⇒ 卖点标签不被改写成【竞价卖】（今天又进买点 ⇒ 持有）', function() {
    const sellRows = [{
      name: '九阳股份', topic: '家电', pct: 30, code: '002242',
      aucPct: 3, volRatioDir: '', volRatioTimes: null, aucShare: 6, inTodayList: true
    }];
    const p = buildTopicVolRatioPlan(topics, dm, { sellRows: sellRows, ebbCtx: EBB_CTX2 });
    let found = null;
    p.sell.forEach(function(g) {
      (g.items || []).forEach(function(x) { if (x.name === '九阳股份') found = x; });
    });
    expect(found).not.toBe(null);
    // 放行 ⇒ 保持 buildSellPlan 自己的结论（今天又进买点 ⇒ 持有），⛔ 不是 SELL_OUT_TAG
    expect(found.sellActionTag).not.toBe(SELL_OUT_TAG);
    expect(found.sellActionTag).toBe(HOLD_TAG);
  });
});

// ── 第八轮 · 落库行 buildEbbDayRecord（次日判首日的输入）──────────────────────────────────
// 用户原话：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断
//   没有竞价量等判断出来的，是缓存吧？你要完善这点」
describe('tvrb · 第八轮 · buildEbbDayRecord 落库行', function() {
  it('§10：事实未就绪 / 缺日期 ⇒ null（⛔ 绝不落一行猜的判定，明天会拿它判首日）', function() {
    expect(buildEbbDayRecord(null, null, '2026-10-13')).toBe(null);
    expect(buildEbbDayRecord(null, { ready: false, leader: null }, '2026-10-13')).toBe(null);
    expect(buildEbbDayRecord(null, { ready: true, leader: null }, '2026-10-13')).toBe(null);
    expect(buildEbbDayRecord(null, {
      ready: true, leader: { name: '甲一', pct: 1, topic: 'x', rank: 1 }
    }, '')).toBe(null);
  });

  it('★【不带首日闸门】：ebb = 停牌 or 占比不达标（这正是次日判首日的输入）', function() {
    const row = buildEbbDayRecord(null, {
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', rank: 1 },
      leaderSuspended: true,
      leaderShare: null
    }, '2026-10-13');
    expect(row.date).toBe('2026-10-13');
    expect(row.leaderStock).toBe('新华传媒');
    expect(row.leaderTopic).toBe('AI应用');
    expect(row.suspended).toBe(true);
    expect(row.shareFail).toBe(false);
    expect(row.ebb).toBe(true);          // ⚠️ 即使 detectEbbDay 因首日闸门会返 null，这一行仍是 true
    expect(row.buySecond).toBe('');      // 没传 ebb ⇒ 不写买点侧那只
    expect(row.source).toBe('tvrb-board');
  });

  it('★ 买点侧那一只只在【今天确实算出退潮首日】时才写进去（留痕供复核）', function() {
    const ctx = {
      ready: true,
      leader: { name: '甲一', pct: 1, topic: 'x', rank: 1 },
      leaderSuspended: true,
      leaderShare: null
    };
    const off = buildEbbDayRecord(null, ctx, '2026-10-13');
    expect(off.ebb).toBe(true);
    expect(off.buySecond).toBe('');
    const on = buildEbbDayRecord({ buySecondName: '九阳股份', buySecondPct: 86 }, ctx, '2026-10-13');
    expect(on.buySecond).toBe('九阳股份');
    expect(on.buySecondPct).toBe(86);
  });

  it('占比不达标（非停牌）也算「处在坏状态」', function() {
    const row = buildEbbDayRecord(null, {
      ready: true,
      leader: { name: '甲一', pct: 1, topic: 'x', rank: 1 },
      leaderSuspended: false,
      leaderShare: 1.2
    }, '2026-10-13');
    expect(row.shareFail).toBe(true);
    expect(row.ebb).toBe(true);
  });

  it('§10：占比缺数据 / 停牌且无占比 ⇒ 不判不达标（ebb 仍可为 true，但 share_fail 必须是 false）', function() {
    const row = buildEbbDayRecord(null, {
      ready: true,
      leader: { name: '甲一', pct: 1, topic: 'x', rank: 1 },
      leaderSuspended: true,
      leaderShare: null
    }, '2026-10-13');
    expect(row.shareFail).toBe(false);
    expect(row.share).toBe(null);
    expect(row.ebb).toBe(true);
  });

  it('两条都不成立（没停牌 + 占比达标）⇒ ebb = false（次日读到它 ⇒ 今天是首日）', function() {
    const row = buildEbbDayRecord(null, {
      ready: true,
      leader: { name: '甲一', pct: 1, topic: 'x', rank: 1 },
      leaderSuspended: false,
      leaderShare: 9
    }, '2026-10-13');
    expect(row.ebb).toBe(false);
  });
});

describe('tvrb · 第八轮规则文案（首日限定 + 总龙二买）', function() {
  const all = buildTvrbRulesLines().join('\n');

  it('【只在首日生效】必须写进规则（含三条取数来源与「只认同一只总龙」）', function() {
    expect(all).toContain('只在首日生效');
    expect(all).toContain('tvrb_ebb_days');
    expect(all).toContain('推断');
    expect(all).toContain('同一只总龙');
  });

  it('第二十一条【总龙二买】必须写进规则（当日口径 / 同一把尺子 / 不顺延 / 不参与灰化）', function() {
    expect(all).toContain(EBB_SECOND_RULE_NO);
    expect(all).toContain(EBB_SECOND_BUY_TAG);
    expect(all).toContain('当日十日涨幅');   // 与总龙的「昨日」口径区分清楚
    expect(all).toContain('有龙位');         // 与总龙同一把尺子
    expect(all).toContain('不参与');         // 它不参与买点侧整体灰化
  });
});
