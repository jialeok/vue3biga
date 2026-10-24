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
//   · ★ 命中提醒时【选股一行未改】（票名 / 档位 / 只数 / notes 与量比达标时逐项一致）。
//
// 覆盖【第十六轮 · 空仓提醒下的买点改写】（2026-10-16 用户口径）：
//   · 命中空仓提醒（非退潮日）⇒ 买点侧每行的动作标签【覆盖式】改写成【分歧日不买】
//     （含原本的【持有】/ 竞价买 / 尾盘买…），仓位槽与行尾【持有】一并清空；
//   · ⛔ 卖点侧一行不动；⛔ 客观数据（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）逐项保留；
//   · ★ 优先级：退潮首日 > 空仓提醒（退潮日标签仍是【退潮不买】，⛔ 不被【分歧日不买】盖掉）。
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
  CASH_NO_BUY_TAG,
  CASH_NO_BUY_TONE,
  DIVERGE_DIP_TAG,
  DIVERGE_FOLLOW_TAG,
  DIVERGE_NO_BUY_TAG,
  DIVERGE_RULE_NO,
  resolveTvrbTier,
  avgVolRatioOf,
  formatAvgVolRatio,
  buildCashAlert,
  detectEbbDay,
  buildEbbDayRecord,
  buildTopicVolRatioPlan,
  buildTvrbRulesLines,
  secondEbbTopicOfPrevDay,
  // ★ [SWITCH 2026-10-22] 第二十八条【新龙 / 新题材切换日】
  SWITCH_RULE_NO,
  NEW_DRAGON_TAG,
  NEW_DRAGON_TONE,
  NEW_DRAGON_TOP_N,
  NEW_DRAGON_LOOKBACK_DAYS,
  detectSwitchDay,
  pickNewDragon,
  // ★★ [EBB-20D 2026-10-22] 退潮事件计数窗口（用户「时间太短没有检查到10月13日那天」）
  EBB_EVENT_WINDOW_DAYS,
  // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条【十日涨幅 · 在列次数候补】
  RANGE10_BACKUP_TAG,
  RANGE10_BACKUP_TONE,
  RANGE10_BACKUP_RULE_NO
} from './topic-vol-ratio-rules.js';
// ★★ [CORE-CAT 2026-10-22] 「题材 → 核心词大类」归一的唯一实现（文化传媒 ⇒ AI应用）
import { makeCoreTopicResolver } from '../topic/core-category.js';
import {
  RULE_NO,
  HOLD_TAG,
  BUY_NOW_TAG,
  BUY_LATE_SWAP_TAG,
  DRAGON_YIZI_HOLD_TAG,
  SELL_OUT_TAG,
  TOPIC_PREV_BOUGHT_TAG,
  topicStreakText,
  rankDragonsWithPctMap
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

  it('★ 命中提醒时【选股一行未改】：档位 / 只数 / 票名 / notes 与「量比达标」时逐项一致', function() {
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
    // ⚠️ ⛔ 标签【不再】逐项一致 —— 第十六轮用户口径：命中提醒时买点动作改成【分歧日不买】
    //   （逐项钉在下面「第十六轮 · 空仓提醒下的买点改写」那一段，这里只钉「选股没变」）。
    expect(pOk.blocks[0].picks[0].buyActionTag).not.toBe(CASH_NO_BUY_TAG);
    expect(pLow.blocks[0].picks[0].buyActionTag).toBe(CASH_NO_BUY_TAG);
  });

  it('buildCashAlert 直接调用：空块 / 缺均值都返回同一份「不提示」冻结常量', function() {
    expect(buildCashAlert(null)).toBe(buildCashAlert(undefined));
    expect(buildCashAlert(null).show).toBe(false);
    expect(TVRB_CASH_ALERT_AVG_VR).toBe(25);
  });
});

// ── 第十六轮 · 空仓提醒下的买点改写（2026-10-16 用户口径）─────────────────────────────────
// 用户原话：「题材量比有这个提示时：⚠️ 今日建议空仓 · 不开仓……这个提示下的买点侧，全部变成灰色
//   （卖点侧不变），买点侧股票标签改成"分歧日不买"。那个灰色的样式类似 10月13日的退潮首日那个
//   买点侧整版灰色，你可以参考下。其它不变。」
//   ⚠️ 本测试只覆盖【Logic 层】：整段灰化是【视图层】挂同一个 `.tvrb-ebb` 类的视觉行为，
//      条件同样取 cashAlert.show（含退潮首日）—— 见 views/TopicVolRatioBoard.vue。
describe('tvrb · 空仓提醒下的买点改写（非退潮日 ⇒ 分歧日不买）', function() {
  // AI应用 10 只（> 8 ⇒ big 档 ⇒ 取 2 只：甲一 / 甲二），量比由参数控制（< 25 触发提醒）
  const names = ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六', '甲七', '甲八', '甲九', '甲十'];
  function topicsWith(vr) {
    return [block('AI应用', 1, names.map(function(n, i) {
      return m(n, {
        aucVolRatio: vr, aucShare: 6,
        code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1))
      });
    }))];
  }
  const dm = dragonMap(names.map(function(n, i) { return [n, i + 1]; }));

  function sellRow(name, over) {
    return Object.assign({
      name: name, topic: 'AI应用', pct: 20, code: '600001',
      aucPct: 3, volRatioDir: '', volRatioTimes: null, aucShare: 1, inTodayList: true
    }, over || {});
  }
  const rows = [sellRow('甲一', { aucShare: 6 }), sellRow('甲三', { aucShare: 1 })];

  // 退潮首日的事实（总龙 = 甲一 停牌 ⇒ ebb 成立），★ 它同时让 cashAlert.show = true
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

  it('常量：标签 = 分歧日不买；配色档与【退潮不买】同档（灰化容器下唯一可读档，⛔ 不新造第二套 CSS）', function() {
    expect(CASH_NO_BUY_TAG).toBe('分歧日不买');
    expect(CASH_NO_BUY_TONE).toBe(EBB_NO_BUY_TONE);
  });

  it('★ 命中提醒（非退潮日）⇒ 每行动作标签改【分歧日不买】+ 仓位槽 / 行尾【持有】一并清空', function() {
    const p = buildTopicVolRatioPlan(topicsWith(10), dm, {});
    expect(p.ebb).toBe(null);                  // 没有 ebbCtx ⇒ 不是退潮日（只有空仓提醒这一种成因）
    expect(p.cashAlert.show).toBe(true);
    expect(p.cashAlert.avgVolRatioText).toBe('10.00');
    // 选股照旧：AI应用 10 只 ⇒ big 档 ⇒ 取 2 只
    expect(p.pickCount).toBe(2);
    expect(p.blocks[0].picks.map(function(x) { return x.name; })).toEqual(['甲一', '甲二']);
    p.blocks[0].picks.forEach(function(x) {
      expect(x.buyActionTag).toBe(CASH_NO_BUY_TAG);
      expect(x.buyActionTone).toBe(CASH_NO_BUY_TONE);
      expect(x.position).toBe('');             // ⛔ 不再可能出现【持有】落在仓位槽
      expect(x.holdTag).toBe('');              // ⛔ 行尾【持有】也清空
      // 行内说明：把「为什么」「照常列出」讲清（文案在 Logic 层，§21 模板零计算）
      expect(x.actionNote).toContain('分歧日');
      expect(x.actionNote).toContain('AI应用');
      expect(x.actionNote).toContain('10.00'); // 平均量比按 formatAvgVolRatio 给（两位小数）
      expect(x.actionNote).toContain(String(TVRB_CASH_ALERT_AVG_VR));
      expect(x.actionNote).toContain('照常列出');
    });
  });

  it('⛔ 客观数据一行未动：十日涨幅 / 龙标 / 票名 / 序位 / 选股理由 逐项保留（§11）', function() {
    const p = buildTopicVolRatioPlan(topicsWith(10), dm, {});
    const p0 = p.blocks[0].picks[0];
    expect(p0.name).toBe('甲一');
    expect(p0.seq).toBe(1);
    expect(p0.dragonLabel).toBe('龙一');
    expect(p0.dragonRank).toBe(1);
    expect(p0.pctText).toBe('+20%');
    // 选股理由（题材级）不因提醒而变化 —— 提醒只改「今天买不买」，不改「为什么选它」
    expect(p.blocks[0].reason).toContain('平均竞价量比 10.00');
    expect(p.blocks[0].qualified).toBe(true);
  });

  it('§11 未命中（量比达标 30 ⇒ 不提示）⇒ 标签保持 finishBuyBlock 的原值，一行未改', function() {
    const p = buildTopicVolRatioPlan(topicsWith(30), dm, {});
    expect(p.cashAlert.show).toBe(false);
    expect(p.blocks[0].picks[0].buyActionTag).toBe(BUY_NOW_TAG);   // 占比 6% 达标 ⇒ 竞价买
    expect(p.blocks[0].picks[0].buyActionTag).not.toBe(CASH_NO_BUY_TAG);
    expect(p.blocks[0].picks[1].buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.blocks[0].picks[0].actionNote).not.toContain('分歧日');
  });

  it('★ 优先级：退潮首日 > 空仓提醒 ⇒ 标签仍是【退潮不买】，⛔ 不被【分歧日不买】盖掉', function() {
    // 这一组：量比 10（< 25）⇒ cashAlert.show = true；同时 ebbCtx 成立 ⇒ ebb 也成立（两者同时为真）
    const p = buildTopicVolRatioPlan(topicsWith(10), dm, { ebbCtx: EBB_CTX });
    expect(p.ebb).not.toBe(null);                    // 确实是退潮首日
    expect(p.cashAlert.show).toBe(true);             // 提醒也确实在（走退潮口径的标语）
    expect(p.blocks[0].picks.length).toBeGreaterThan(0);
    p.blocks[0].picks.forEach(function(x) {
      expect(x.buyActionTag).toBe(EBB_NO_BUY_TAG);   // ★ 更具体的那一枚赢
      expect(x.buyActionTag).not.toBe(CASH_NO_BUY_TAG);
      // [EBB-R20] 提示语已阶段化：无历史 ⇒ 首次退潮（题材名进标题）
      expect(x.actionNote).toContain('主线AI应用首次退潮');
    });
  });

  it('⛔ 卖点侧一行不动：命中提醒与量比达标时，卖点【动作标签 / 时机 / 说明】逐项一致（用户「卖点侧不变」）', function() {
    const hit = buildTopicVolRatioPlan(topicsWith(10), dm, { sellRows: rows });
    const ok = buildTopicVolRatioPlan(topicsWith(30), dm, { sellRows: rows });
    expect(hit.cashAlert.show).toBe(true);
    expect(ok.cashAlert.show).toBe(false);
    expect(hit.sell.length).toBeGreaterThan(0);
    expect(hit.sell.length).toBe(ok.sell.length);
    // ★ 逐行深比较（名牌 / 动作标签 / 配色档 / 时机 / 说明…）—— 卖点段在两种情形下【逐字相同】
    expect(hit.sell.map(function(g) { return g.items; }))
      .toEqual(ok.sell.map(function(g) { return g.items; }));
    // ⚠️ ⛔ 只比【行】不比【题材块头】：卖点分组头上的 avgVolRatioText 是【客观数据】，
    //   两个夹具的题材量比本来就不同（10 vs 30，为了让一个命中一个不命中）⇒ 那块差异与规则无关。
    expect(hit.sell[0].avgVolRatioText).not.toBe(ok.sell[0].avgVolRatioText);
  });

  it('规则手册：第十九条必须写清「整段灰化 + 标签改分歧日不买 + 卖点侧不变 + 退潮优先」', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain(CASH_NO_BUY_TAG);
    expect(all).toContain('整段变灰');
    expect(all).toContain('卖点侧一行不变');
    expect(all).toContain(EBB_NO_BUY_TAG);
    expect(all).toContain('优先');
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
    // 买点侧走退潮口径的空仓标语（[EBB-R20] 提示语已阶段化：无历史 ⇒ 首次退潮）
    expect(e.buyHeadline).toContain('首次退潮');
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

  it('★ [EBB-R20] 总龙一恒按【龙头门槛 3.5%】判占比（⛔ 不因十日龙位不是龙一而降到 2% 档）', function() {
    // 10-20 实测根因：总龙新华传媒 20日全市场第一，但当日十日口径里是 AI应用 龙三 ⇒
    //   旧逻辑落到 2% 档 ⇒ 2.5% 被误判「达标」⇒ 用户拍板的退潮整条静默失效。
    //   修后：总龙一就是市场龙头，2.5% < 3.5% ⇒ 退潮（reason = share）。
    const e = detectEbbDay(ebb({
      leader: { name: '创票', pct: 159.51, topic: 'AI应用', code: '300001', rank: null, isYizi: false },
      leaderShare: 2.5
    }));
    expect(e).not.toBe(null);
    expect(e.reason).toBe('share');
    expect(e.detail).toContain('龙头门槛');
    // 恰好 3.5% 达标 ⇒ 不退潮（与龙头门槛同一把尺子）
    expect(detectEbbDay(ebb({ leaderShare: 3.5 }))).toBe(null);
    expect(detectEbbDay(ebb({ leaderShare: 9 }))).toBe(null);
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
    expect(findItem(p, '甲二').actionNote).toContain('主线AI应用首次退潮');
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
    // 退潮日 ⇒ 提示，且是退潮口径（[EBB-R20] 阶段化提示语：无历史 ⇒ 首次退潮）
    expect(p.cashAlert.show).toBe(true);
    expect(p.cashAlert.headline).toContain('首次退潮');
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
    expect(note).toContain('首次退潮');
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

  it('第六轮补的【退潮不买】必须写进规则（买点侧除替补外没有买点）', function() {
    const all = lines.join('\n');
    expect(all).toContain(EBB_NO_BUY_TAG);
    expect(all).toContain('除替补外没有买点');
  });

  it('第七轮的【总龙排除口径】必须写进规则（非主板排除：创业板 / 科创板 / 北交所一律不要）', function() {
    const all = lines.join('\n');
    expect(all).toContain('非主板');     // 总龙一~五替补的排除口径（[EBB-R20]）
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

  it('§10：昨日状态两处都取不到 ⇒ 按【可触发】处理（宁可多提醒一次，不漏掉风险）', function() {
    const e = detectEbbDay(ctx({ prevLeader: null }), null);
    expect(e).not.toBe(null);
    expect(e.firstDay).toBe(true);
    expect(e.firstDaySource).toBe('unknown');
    expect(e.detail).toContain('按【可触发】处理');
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

// ── ★ [EBB-R20 2026-10-20 用户口径] 买点侧替补（≤2 只）—— 旧【总龙二买】的升级版 ────────────
//   用户原话（本轮）：「从20日涨幅中的总龙一到总龙五选出两只排名靠前的。而且是不同总龙一题材的
//   股票……从这五只中，要判断是不是创业板，科创板，北交所等非主板的股票，如果是先排除，
//   剩下的看是不是和总龙一是同题材，是也排除，剩下的就选排名靠前的那两只。只选好两只，
//   已经完成任务，后面不选了。」
describe('tvrb · 买点侧替补（≤2 只，20日涨幅总龙一~五里选）', function() {
  /** 10-20 的真实例子：九阳股份 002242 = 总龙二（20日涨幅 106.51%） */
  const SECOND = {
    name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242',
    rank20: 2, days: 20, isYizi: false, suspended: false
  };

  function ctx(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      leaderSuspended: true,
      leaderShare: null,
      siblingDragons: [],
      secondInfo: null,
      prevLeader: null,        // 两处都取不到 ⇒ 按可触发处理（闸门放行）
      buyPicks: [SECOND],      // [EBB-R20] 采集层选好的替补（≤2 只）
      buyTrail: [
        { name: '新华传媒', rank20: 1, topic: 'AI应用', pct: 159.51, picked: false, reason: '总龙一本人，正是被判定退潮的那只 ⇒ 不买' },
        { name: '九阳股份', rank20: 2, topic: '大消费', pct: 106.51, picked: true, reason: '主板、与总龙一不同题材 ⇒ 入选' }
      ]
    }, over || {});
  }

  it('★ 有替补 ⇒ 买点标语改口径，别名兼容字段 = 第一只替补（总龙N 标签与「20日涨幅」toggle 同源）', function() {
    const e = detectEbbDay(ctx(), null);
    expect(e.buyPicksOn).toBe(true);
    expect(e.buySecondOn).toBe(true);            // 兼容别名 = 第一只替补
    expect(e.buySecondName).toBe('九阳股份');
    expect(e.buySecondLabel).toBe('总龙二');      // totalDragonLabel(2)，§6 同一份实现
    expect(e.buySecondPctText).toBe('+107%');     // formatRangePct 取整（106.51 ⇒ +107%）
    expect(e.buySecondTopic).toBe('大消费');
    expect(e.buySecondCode).toBe('002242');
    expect(e.buyPickNames).toEqual(['九阳股份']);
    expect(e.buyHeadline).toContain(EBB_SECOND_BUY_TAG);
    expect(e.buyHeadline).toContain('1 只');
    // 五只去留留痕（判定可追溯）
    expect(e.buyTrailText).toContain('总龙一本人');
    expect(e.buyTrailText).toContain('九阳股份');
    expect(e.buyDetail).toContain('九阳股份');
    expect(e.buyDetail).toContain('总龙二');
    expect(e.buyDetail).toContain('五只去留');
    expect(e.buyDetail).toContain(EBB_NO_BUY_TAG);   // 其余入选票一律【退潮不买】
  });

  it('§10：20日前五没算出来 / 一只替补都选不出 ⇒ 标语如实改空仓口径（⛔ 不拿别的票顶替）', function() {
    const e = detectEbbDay(ctx({ buyPicks: [], buyTrail: [] }), null);
    expect(e.buySecondOn).toBe(false);
    expect(e.buySecondName).toBe('');
    expect(e.buyHeadline).toContain('空仓');
    expect(e.buySecondTrouble).toContain('选不出');
    // 退潮本身仍然成立（卖点侧照旧收紧），只是买点侧给不出替补
    expect(e.reason).toBe('suspend');
  });

  it('它今日停牌 / 竞价一字 ⇒ 照样列出来并如实标注（⛔ 不顺延到第五名之外）', function() {
    const s = detectEbbDay(ctx({ buyPicks: [Object.assign({}, SECOND, { suspended: true })] }), null);
    expect(s.buySecondOn).toBe(true);
    expect(s.buySecondTrouble).toContain('停牌');
    const y = detectEbbDay(ctx({ buyPicks: [Object.assign({}, SECOND, { isYizi: true })] }), null);
    expect(y.buySecondOn).toBe(true);
    expect(y.buySecondTrouble).toContain('一字');
  });
});

// ── ★ [EBB-R20 2026-10-20 用户口径] 首次 / 二次确认 / 无第三次（近 10 个交易日的退潮事件计数）──
//   用户原话：「判断是不是首日要看它最近10天的表现，如果十天内出现首日退潮，那今天就不能算是
//   首日了，而是确认主线退潮……注意没有第三次了，退潮后基本不看了这个题材了。」
//   ⚠️ 本 describe 经 detectEbbDay 的第 3 参（ebbHistory）钉 _ebbPhaseOf 的行为（§6 不直接测私有函数）。
describe('tvrb · [EBB-R20] 首次 / 二次确认 / 无第三次（退潮事件计数）', function() {
  function ctx(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      leaderSuspended: true,
      leaderShare: null,
      siblingDragons: [],
      secondInfo: null,
      prevLeader: null,
      buyPicks: [],
      buyTrail: []
    }, over || {});
  }
  /** 一条 tvrb_ebb_days 历史行（date / prevDate 由组合式链好 —— 与 useTopicVolRatioBoard 注入的形状一致） */
  function h(date, prevDate, over) {
    return Object.assign({
      date: date, prevDate: prevDate,
      leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true
    }, over || {});
  }

  it('§10：ebbHistory 缺省 / 空 ⇒ 计 0 次 ⇒ 首次退潮（与「取不到就按可触发处理」同一拍板）', function() {
    const e = detectEbbDay(ctx(), null, null);
    expect(e).not.toBe(null);
    expect(e.phase).toBe('first');
    expect(e.phaseCount).toBe(0);
    expect(e.phaseTitle).toBe('主线AI应用首次退潮');   // 用户原话示例的格式
    expect(e.firstDay).toBe(true);
    const e2 = detectEbbDay(ctx(), null, []);
    expect(e2.phaseTitle).toBe('主线AI应用首次退潮');
  });

  it('★ 近 10 天里有 1 次同题材退潮事件 ⇒ 二次确认退潮（用户原话示例：AI应用二次确认退潮）', function() {
    const hist = [h('2026-10-13', '2026-10-12')];      // 10-13 首次退潮落库
    const e = detectEbbDay(ctx(), null, hist);
    expect(e).not.toBe(null);
    expect(e.phase).toBe('second');
    expect(e.phaseCount).toBe(1);
    expect(e.phaseTitle).toBe('AI应用二次确认退潮');
    expect(e.firstDay).toBe(false);
    expect(e.phaseNote).toContain('2026-10-13');       // 最近一次事件的日期如实写出
  });

  it('★ 近 10 天里已有 2 次事件 ⇒ 没有第三次 ⇒ 返回 null（按平常日子选股）', function() {
    const hist = [h('2026-10-08', '2026-10-07'), h('2026-10-13', '2026-10-12')];
    expect(detectEbbDay(ctx(), null, hist)).toBe(null);
  });

  it('★ 【事件】≠【天数】：连续多日退潮只算一次（次日的前一交易日也有同题材记录 ⇒ 延续不计数）', function() {
    const hist = [
      h('2026-10-13', '2026-10-12'),   // 事件起点
      h('2026-10-14', '2026-10-13'),   // 前一交易日也在退潮 ⇒ 延续
      h('2026-10-15', '2026-10-14')    // 同上
    ];
    const e = detectEbbDay(ctx(), null, hist);
    expect(e).not.toBe(null);
    expect(e.phaseCount).toBe(1);
    expect(e.phase).toBe('second');
  });

  it('★ 只认【同题材】：别的题材的退潮不计入本题材（ebb=false 的行同样不计）', function() {
    const hist = [
      h('2026-10-13', '2026-10-12', { leaderTopic: '新能源汽车', leaderStock: '别的龙' }),
      h('2026-10-15', '2026-10-14', { ebb: false })
    ];
    const e = detectEbbDay(ctx(), null, hist);
    expect(e.phaseCount).toBe(0);
    expect(e.phaseTitle).toBe('主线AI应用首次退潮');
  });

  it('★ 题材取不到时退回按【同一只总龙】认（⛔ 不乱认亲）', function() {
    const noTopicCtx = ctx({
      leader: { name: '新华传媒', pct: 159.51, topic: '', code: '600825', rank: 1, isYizi: false }
    });
    // 按总龙名认到了 ⇒ 二次确认
    const e = detectEbbDay(noTopicCtx, null, [h('2026-10-13', '2026-10-12')]);
    expect(e.phaseCount).toBe(1);
    expect(e.phase).toBe('second');
    // 昨天退潮的是【别的票】⇒ 认不到 ⇒ 首次
    const e2 = detectEbbDay(noTopicCtx, null, [
      h('2026-10-13', '2026-10-12', { leaderStock: '别的龙' })
    ]);
    expect(e2.phaseCount).toBe(0);
    expect(e2.phaseTitle).toBe('主线总龙题材首次退潮');
  });
});

// ── ★ [EBB-R20] 退潮替补【两只】块（10-20 真实例子：九阳股份 + 澳弘电子）───────────────────
describe('tvrb · [EBB-R20] 退潮替补 · 两只替补块（经 buildTopicVolRatioPlan）', function() {
  const names = ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六', '甲七', '甲八', '甲九', '甲十'];
  const topics = [block('AI应用', 1, names.map(function(n, i) {
    return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
  }))];
  const dm = dragonMap(names.map(function(n, i) { return [n, i + 1]; }));

  const PICKS = [
    { name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242', rank20: 2, days: 20, isYizi: false, suspended: false },
    { name: '澳弘电子', pct: 90.73, topic: '电子/通信/算力', code: '605733', rank20: 4, days: 20, isYizi: false, suspended: false }
  ];
  const EBB_CTX2 = {
    ready: true,
    leader: { name: '甲一', pct: 159.51, topic: 'AI应用', code: '600001', rank: 1, isYizi: false },
    leaderSuspended: true,
    leaderShare: null,
    siblingDragons: [],
    secondInfo: null,
    prevLeader: null,
    buyPicks: PICKS,
    buyTrail: [
      { name: '甲一', rank20: 1, topic: 'AI应用', pct: 159.51, picked: false, reason: '总龙一本人，正是被判定退潮的那只 ⇒ 不买' },
      { name: '九阳股份', rank20: 2, topic: '大消费', pct: 106.51, picked: true, reason: '主板、与总龙一不同题材 ⇒ 入选' },
      { name: '澳弘电子', rank20: 4, topic: '电子/通信/算力', pct: 90.73, picked: true, reason: '主板、与总龙一不同题材 ⇒ 入选' }
    ]
  };

  it('★ 两只替补都渲染【退潮替补买】，总龙N 标签与容器标语写明「只有这 2 只」', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { ebbCtx: EBB_CTX2 });
    expect(p.ebbBuy).not.toBe(null);
    expect(p.ebbBuy.picks.length).toBe(2);
    p.ebbBuy.picks.forEach(function(x) {
      expect(x.buyActionTag).toBe(EBB_SECOND_BUY_TAG);
      expect(x.buyActionTone).toBe(EBB_SECOND_BUY_TONE);
      expect(x.holdTag).toBe('');
      expect(x.position).toBe('');
    });
    // 排名顺序 = 采集层给定的顺序（20日涨幅降序）+ 总龙N 标签（§6 与「20日涨幅」toggle 同源）
    expect(p.ebbBuy.picks[0].name).toBe('九阳股份');
    expect(p.ebbBuy.picks[0].dragonLabel).toBe('总龙二');
    expect(p.ebbBuy.picks[1].name).toBe('澳弘电子');
    expect(p.ebbBuy.picks[1].dragonLabel).toBe('总龙四');
    expect(p.ebb.buyHeadline).toContain('2 只');
    expect(p.ebb.buyOnlyLabelText).toContain('2 只');
    expect(p.ebb.buyPickNames).toEqual(['九阳股份', '澳弘电子']);
    // 两只都进买点名单（卖点侧放行的尺子）
    expect(p.buyNames.has('九阳股份')).toBe(true);
    expect(p.buyNames.has('澳弘电子')).toBe(true);
  });

  it('★ 行内说明 / notes：20日涨幅名次 + 常规买点信号 + 五只去留 + 客观数据 一枚不丢', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { ebbCtx: EBB_CTX2 });
    const note = p.ebbBuy.picks[1].actionNote;
    expect(note).toContain('主线AI应用首次退潮');
    expect(note).toContain('20日涨幅全市场排名第 4');
    expect(note).toContain('澳弘电子');
    expect(note).toContain(EBB_NO_BUY_TAG);
    const notes = p.ebbBuy.notes.join('\n');
    expect(notes).toContain('五只去留');
    expect(notes).toContain('总龙一本人');
    expect(notes).toContain('非主板');
    expect(notes).toContain('20日涨幅');
  });

  it('§10 替补混进停牌 / 一字 ⇒ 照样列出并如实标注（⛔ 不顺延第五名之外 —— 用户「只选两只」）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, {
      ebbCtx: Object.assign({}, EBB_CTX2, {
        buyPicks: [
          Object.assign({}, PICKS[0], { suspended: true }),
          Object.assign({}, PICKS[1], { isYizi: true })
        ]
      })
    });
    expect(p.ebbBuy).not.toBe(null);
    expect(p.ebbBuy.picks.length).toBe(2);
    expect(p.ebb.buySecondTrouble).toContain('停牌');
    expect(p.ebb.buySecondTrouble).toContain('一字');
    const notes = p.ebbBuy.notes.join('\n');
    expect(notes).toContain('停牌');
    expect(notes).toContain('竞价一字');
  });
});

// ── ★ [EBB-R20b 2026-10-20 用户口径] 二次确认退潮 ⇒ 先常规选股（排除退潮题材），兜底才替补 ──────
//   用户原话：「二次确认退潮的时候，应该先看常规选股，就是按题材平均量比选股（注意是新题材，
//   不是退潮那个题材，即使是退潮时这个题材还符合常规选股，但是毕竟它退潮了，所以不选这个题材），
//   如果符合平均量比的新题材……就按照常规选股就行了。如果排名前二的新题材都没有符合条件，
//   兜底就是选总市场的排名前面的龙，所以才回到20日涨幅选股法。如果常规选股题材量比符合，
//   从常规中选出股票，说明文字那里该加一句，主线AI应用二次确认退潮，作为补涨题材选出的股票。」
describe('tvrb · [EBB-R20b] 二次确认退潮 ⇒ 先常规选股（排除退潮题材），兜底才替补', function() {
  // 题材排名（数组顺序 = 平均量比降序）：AI应用（退潮题材）→ 商业航天（合格新题材）→ 电力（数量不足）
  function mkTopics() {
    return [
      block('AI应用', 1, ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六'].map(function(n, i) {
        return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
      })),
      block('商业航天', 2, ['海一', '海二', '海三', '海四', '海五'].map(function(n, i) {
        return m(n, { aucVolRatio: 50, aucShare: 6, code: '6010' + (i + 1) });
      })),
      block('电力', 3, ['电一', '电二', '电三'].map(function(n, i) {
        return m(n, { aucVolRatio: 40, aucShare: 6, code: '6003' + (i + 1) });
      }))
    ];
  }
  const dm = dragonMap([['甲一', 1], ['甲二', 2], ['海一', 1]]);

  function ebbCtx(over) {
    return Object.assign({
      ready: true,
      leader: { name: '新华传媒', pct: 159.51, topic: 'AI应用', code: '600825', rank: 1, isYizi: false },
      leaderSuspended: false,
      leaderShare: 2.5,            // ＜ 龙头门槛 3.5% ⇒ 判据②（占比不达标）
      siblingDragons: [],
      secondInfo: null,
      prevLeader: null,
      buyPicks: [],
      buyTrail: []
    }, over || {});
  }
  /** 近 10 天里已有一次 AI应用 退潮事件（10-13）⇒ 今天 = 二次确认 */
  const HIST = [{ date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }];

  it('★ 二次确认 + 有合格新题材 ⇒ 常规选股照常（退潮题材剔除顺延）、行内说明加注、⛔ 不灰化不退潮不买', function() {
    const p = buildTopicVolRatioPlan(mkTopics(), dm, { ebbCtx: ebbCtx(), ebbHistory: HIST });
    expect(p.ebb).not.toBe(null);
    expect(p.ebb.phase).toBe('second');
    // 退潮题材被剔除：blocks 里没有 AI应用，商业航天顶上
    expect(p.blocks.map(function(b) { return b.topic; })).not.toContain('AI应用');
    expect(p.blocks.map(function(b) { return b.topic; })).toContain('商业航天');
    // 常规标签照旧（占比 6% 达标 ⇒ 竞价买），⛔ 不是【退潮不买】
    const pick = p.blocks[0].picks[0];
    expect(pick.name).toBe('海一');
    expect(pick.buyActionTag).toBe(BUY_NOW_TAG);
    expect(pick.buyActionTag).not.toBe(EBB_NO_BUY_TAG);
    // 行内说明加注（用户原话句式）
    expect(pick.actionNote).toContain('主线AI应用二次确认退潮，作为补涨题材选出的股票');
    // ★ [EBB-WHY 2026-10-22] 判定依据事实句（与卖点侧横幅同款）：买点侧必须写清「为什么退潮、怎么判定」
    expect(pick.actionNote).toContain('判定依据：市场总龙【');
    expect(pick.actionNote).toContain('⇒ 判定为【AI应用二次确认退潮】');
    expect(pick.actionNote).toContain('（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）');
    // 替补兜底不启用
    expect(p.ebbBuy).toBe(null);
    expect(p.buy.ebbSecond).toBe(null);
    // ★ [EBB-R20c] 买点侧顶部的【节点说明】横幅（文案全在 Logic 层）
    expect(p.ebbNodeNote).not.toBe(null);
    expect(p.ebbNodeNote.headline).toContain('退潮节点');
    expect(p.ebbNodeNote.headline).toContain('AI应用');
    // ★ [EBB-WHY 2026-10-22] 节点横幅句首同样带判定依据事实句
    expect(p.ebbNodeNote.detail).toContain('判定依据：市场总龙【');
    expect(p.ebbNodeNote.detail).toContain('补涨题材');
    expect(p.ebbNodeNote.detail).toContain('轮动行情');
    expect(p.ebbNodeNote.detail).toContain('常规选股规则');
    // 不灰化（常规第一题材量比 50 ≥ 25 ⇒ cashAlert 走常规判据不提示）
    expect(p.cashAlert.show).toBe(false);
    // 剔除原因如实写进 notes
    expect(p.notes.join('\n')).toContain('不参与买点选股');
    expect(p.notes.join('\n')).toContain('二次确认退潮');
  });

  it('★ 二次确认 + 排名前二的新题材都不符合条件（一个都选不出）⇒ 兜底替补（退潮口径接管）', function() {
    const picks2 = [
      { name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242', rank20: 2, days: 20, isYizi: false, suspended: false },
      { name: '澳弘电子', pct: 93.07, topic: '电子/通信/算力', code: '605733', rank20: 3, days: 20, isYizi: false, suspended: false }
    ];
    // 只有退潮题材合格 + 一个数量不足的题材 ⇒ 排除后常规选不出 ⇒ 兜底
    const topics2 = [
      block('AI应用', 1, ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六'].map(function(n, i) {
        return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
      })),
      block('电力', 2, ['电一', '电二', '电三'].map(function(n, i) {
        return m(n, { aucVolRatio: 40, aucShare: 6, code: '6003' + (i + 1) });
      }))
    ];
    const p = buildTopicVolRatioPlan(topics2, dm, {
      ebbCtx: ebbCtx({ buyPicks: picks2, buyTrail: [] }),
      ebbHistory: HIST
    });
    expect(p.blocks.length).toBe(0);
    expect(p.ebbBuy).not.toBe(null);
    expect(p.ebbBuy.picks.length).toBe(2);
    expect(p.ebbBuy.picks.every(function(x) { return x.buyActionTag === EBB_SECOND_BUY_TAG; })).toBe(true);
    // 退潮口径接管 cashAlert（灰化 + 替补标语）
    expect(p.cashAlert.show).toBe(true);
    expect(p.cashAlert.headline).toContain('二次确认退潮');
  });

  it('★ 首次退潮不走常规选股（同 ctx 无历史）⇒ 全部【退潮不买】+ 替补照旧（旧口径一行不变）', function() {
    const picks1 = [
      { name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242', rank20: 2, days: 20, isYizi: false, suspended: false }
    ];
    const p = buildTopicVolRatioPlan(mkTopics(), dm, {
      ebbCtx: ebbCtx({ buyPicks: picks1, buyTrail: [] })
    });
    expect(p.ebb.phase).toBe('first');
    // 首次退潮：退潮题材【不剔除】（旧口径）⇒ blocks 含 AI应用，全部退潮不买
    expect(p.blocks.map(function(b) { return b.topic; })).toContain('AI应用');
    p.blocks.forEach(function(b) {
      b.picks.forEach(function(x) { expect(x.buyActionTag).toBe(EBB_NO_BUY_TAG); });
    });
    expect(p.ebbBuy).not.toBe(null);
    expect(p.ebbBuy.picks[0].name).toBe('九阳股份');
  });

  it('★ 卖点侧：二次确认常规选出 + 昨天买过今天又进买点 ⇒ 保持持有（放行）；退潮题材票照旧竞价卖', function() {
    const sellRows = [{
      name: '海一', topic: '商业航天', pct: 30, code: '60101',
      aucPct: 3, volRatioDir: '', volRatioTimes: null, aucShare: 6, inTodayList: true
    }];
    const p = buildTopicVolRatioPlan(mkTopics(), dm, { sellRows: sellRows, ebbCtx: ebbCtx(), ebbHistory: HIST });
    let found = null;
    p.sell.forEach(function(g) { (g.items || []).forEach(function(x) { if (x.name === '海一') found = x; }); });
    expect(found).not.toBe(null);
    expect(found.sellActionTag).toBe(HOLD_TAG);       // 今天又进买点 ⇒ 持有（放行，⛔ 不改竞价卖）

    const sellRows2 = [{
      name: '甲一', topic: 'AI应用', pct: 30, code: '600001',
      aucPct: 3, volRatioDir: '', volRatioTimes: null, aucShare: 6, inTodayList: true
    }];
    const p2 = buildTopicVolRatioPlan(mkTopics(), dm, { sellRows: sellRows2, ebbCtx: ebbCtx(), ebbHistory: HIST });
    let found2 = null;
    p2.sell.forEach(function(g) { (g.items || []).forEach(function(x) { if (x.name === '甲一') found2 = x; }); });
    expect(found2).not.toBe(null);
    expect(found2.sellActionTag).toBe(SELL_OUT_TAG);  // 退潮题材、非今日买点 ⇒ 一律竞价卖（收紧不变）
  });

  it('规则面板：二十/二十一条必须写清「二次确认先常规选股 + 兜底才替补 + 补涨题材加注」', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('先按常规选股');
    expect(all).toContain('作为补涨题材选出的股票');
    expect(all).toContain('兜底');
    expect(all).toContain('排除退潮题材本身');
    // ★ [EBB-R20c] 节点概念（退潮节点 / 补涨题材 / 轮动行情）也要写进规则面板
    expect(all).toContain('退潮节点');
    expect(all).toContain('轮动行情');
    expect(all).toContain('节点说明横幅');
  });

  it('★ [EBB-R20c] 节点说明横幅只在「二次确认 ∧ 常规选出」时出现：首次退潮 / 二次兜底 / 非退潮日 ⇒ null', function() {
    // 首次退潮（同一 ctx、无历史）⇒ null（卖点横幅 + 灰化已把状态说满，不再叠一条）
    const p1 = buildTopicVolRatioPlan(mkTopics(), dm, {
      ebbCtx: ebbCtx({ buyPicks: [{ name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242', rank20: 2, days: 20, isYizi: false, suspended: false }], buyTrail: [] })
    });
    expect(p1.ebb.phase).toBe('first');
    expect(p1.ebbNodeNote).toBe(null);
    // 二次确认 + 常规选不出（兜底替补）⇒ null
    const topics2 = [
      block('AI应用', 1, ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六'].map(function(n, i) {
        return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
      })),
      block('电力', 2, ['电一', '电二', '电三'].map(function(n, i) {
        return m(n, { aucVolRatio: 40, aucShare: 6, code: '6003' + (i + 1) });
      }))
    ];
    const picks2 = [
      { name: '九阳股份', pct: 106.51, topic: '大消费', code: '002242', rank20: 2, days: 20, isYizi: false, suspended: false },
      { name: '澳弘电子', pct: 93.07, topic: '电子/通信/算力', code: '605733', rank20: 3, days: 20, isYizi: false, suspended: false }
    ];
    const p2 = buildTopicVolRatioPlan(topics2, dm, {
      ebbCtx: ebbCtx({ buyPicks: picks2, buyTrail: [] }),
      ebbHistory: HIST
    });
    expect(p2.blocks.length).toBe(0);
    expect(p2.ebbBuy).not.toBe(null);
    expect(p2.ebbNodeNote).toBe(null);
    // 非退潮日 ⇒ null（绝不能拿出一个「猜的」节点说明，§10）
    const p0 = buildTopicVolRatioPlan(mkTopics(), dm, {});
    expect(p0.ebb).toBe(null);
    expect(p0.ebbNodeNote).toBe(null);
  });
});

// ── ★ [DIVERGE 2026-10-20 用户口径] 市场总龙一首次分歧 ⇒ 分歧买点（下杀买 + 高标跟随 ≤2 只）────
//   用户原话：「市场总龙一，第一次出现分歧的时候，是买点……标签应该是下杀买。也就是题材量比
//   买点侧只有市场总龙一，还有其它不同题材的两只高标股票（20日涨幅前五的），同题材的不要……最多三只。」
describe('tvrb · [DIVERGE] 总龙首次分歧 ⇒ 分歧买点', function() {
  // 复用 EBB-R20b 的夹具形状：AI应用（退潮题材之外的场景里是普通题材）+ 商业航天 + 电力
  function mkTopics() {
    return [
      block('AI应用', 1, ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六'].map(function(n, i) {
        return m(n, { aucVolRatio: 60, aucShare: 6, code: '6000' + (i < 9 ? '0' + (i + 1) : (i + 1)) });
      })),
      block('商业航天', 2, ['海一', '海二', '海三', '海四', '海五'].map(function(n, i) {
        return m(n, { aucVolRatio: 50, aucShare: 6, code: '6010' + (i + 1) });
      })),
      block('电力', 3, ['电一', '电二', '电三'].map(function(n, i) {
        return m(n, { aucVolRatio: 40, aucShare: 6, code: '6003' + (i + 1) });
      }))
    ];
  }
  const dm = dragonMap([['甲一', 1], ['甲二', 2], ['海一', 1]]);
  // 复刻用户 10-19 实例的 top5 结构：总龙三同题材淘汰、总龙五非主板淘汰
  const LD = {
    todayFirst: true,
    firstBoardYmd: '2026-09-21',
    firstDivergenceYmd: '2026-10-19',
    aucPctText: '-1.06%',
    leaderName: '甲一',
    leaderCode: '600001',
    leaderPct: 210.98,
    leaderPctText: '+210.98%',
    leaderTopic: 'AI应用',
    top5: [
      { name: '甲一', code: '600001', topic: 'AI应用', rank20: 1, pct: 210.98 },
      { name: '海一', code: '601001', topic: '商业航天', rank20: 2, pct: 117.38 },
      { name: '甲三', code: '600003', topic: 'AI应用', rank20: 3, pct: 116.68 },
      { name: '电一', code: '600301', topic: '电力', rank20: 4, pct: 91.89 },
      { name: '莱美药业', code: '300006', topic: '医药', rank20: 5, pct: 79.10 }
    ]
  };

  it('★ 分歧日：分歧买点块 = 总龙一【下杀买】+ 不同题材主板高标 ≤2 只【高标跟随买】', function() {
    const p = buildTopicVolRatioPlan(mkTopics(), dm, { leaderDiverge: LD });
    expect(p.ebb).toBe(null);
    expect(p.divergeBuy).not.toBe(null);
    expect(p.divergeBuy.ruleNo).toBe(DIVERGE_RULE_NO);
    const picks = p.divergeBuy.picks;
    expect(picks.length).toBe(3);
    expect(picks[0].name).toBe('甲一');
    expect(picks[0].buyActionTag).toBe(DIVERGE_DIP_TAG);           // 下杀买（用户原话）
    expect(picks.map(function(x) { return x.name; })).toContain('海一');
    expect(picks.map(function(x) { return x.name; })).toContain('电一');
    picks.slice(1).forEach(function(x) {
      expect(x.buyActionTag).toBe(DIVERGE_FOLLOW_TAG);             // 高标跟随买
    });
    // 同题材 / 非主板被排除
    expect(picks.map(function(x) { return x.name; })).not.toContain('甲三');
    expect(picks.map(function(x) { return x.name; })).not.toContain('莱美药业');
    // 五只去留留痕
    expect(p.divergeBuy.notes.join('\n')).toContain('同题材');
    expect(p.divergeBuy.notes.join('\n')).toContain('非主板');
  });

  it('★ 分歧日其余入选票【总龙分歧不买】+ 大字标语接管（灰化走 cashAlert.show 既有通道）', function() {
    const p = buildTopicVolRatioPlan(mkTopics(), dm, { leaderDiverge: LD });
    expect(p.cashAlert.show).toBe(true);
    expect(p.cashAlert.headline).toContain('首次分歧');
    expect(p.cashAlert.headline).toContain('甲一');
    p.blocks.forEach(function(b) {
      b.picks.forEach(function(x) {
        expect(x.buyActionTag).toBe(DIVERGE_NO_BUY_TAG);
        expect(x.holdTag).toBe('');
        expect(x.position).toBe('');
      });
    });
    // notes 有分歧说明
    expect(p.notes.join('\n')).toContain('总龙首次分歧');
  });

  it('★ 优先级：退潮日接管（ebb ≠ null）⇒ 分歧规则让位（divergeBuy 恒 null）', function() {
    // ebbCtx 与 EBB-R20b describe 同款：占比 2.5% ＜ 龙头门槛 3.5% ⇒ 判据②命中 ⇒ 首次退潮
    const ebbCtx = function() {
      return {
        ready: true,
        leader: { name: '甲一', pct: 210.98, topic: 'AI应用', code: '600001', rank: 1, isYizi: false },
        leaderSuspended: false,
        leaderShare: 2.5,
        siblingDragons: [],
        secondInfo: null,
        prevLeader: null,
        buyPicks: [],
        buyTrail: []
      };
    };
    const p = buildTopicVolRatioPlan(mkTopics(), dm, { leaderDiverge: LD, ebbCtx: ebbCtx() });
    expect(p.ebb).not.toBe(null);
    expect(p.divergeBuy).toBe(null);
    p.blocks.forEach(function(b) {
      b.picks.forEach(function(x) { expect(x.buyActionTag).toBe(EBB_NO_BUY_TAG); });
    });
  });

  it('★ 非首次分歧日（todayFirst=false / ld 缺省）⇒ 零行为（§11 缺省不变）', function() {
    const notFirst = buildTopicVolRatioPlan(mkTopics(), dm, {
      leaderDiverge: Object.assign({}, LD, { todayFirst: false })
    });
    expect(notFirst.divergeBuy).toBe(null);
    expect(notFirst.cashAlert.show).toBe(false);
    const none = buildTopicVolRatioPlan(mkTopics(), dm, {});
    expect(none.divergeBuy).toBe(null);
  });

  it('规则面板：第二十五条必须写清 首板 / 首次分歧 / 分歧转一致 / 下杀买 + 高标跟随 / 优先级', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('首板');
    expect(all).toContain('首次分歧');
    expect(all).toContain('分歧转一致');
    expect(all).toContain('下杀买');
    expect(all).toContain('高标跟随买');
    expect(all).toContain('总龙分歧不买');
    expect(all).toContain('退潮（第二十/二十一条）> 总龙首次分歧');
  });
});

describe('tvrb · 买点侧替补那一行接进 buildTopicVolRatioPlan', function() {
  // ⚠️ 刻意把【家电】放在第 3 位：本看板只取排名最靠前的 2 个题材（TVRB_TOPIC_LIMIT）⇒
  //    家电【不会成为常规入选块】，九阳股份也就【不可能靠常规通路】进 buyNames。
  //    这样「九阳股份在 buyNames 里」这条断言才真正证明【是替补接线放进去的】，而不是被常规选股顺带带入。
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
    buyPicks: [{
      name: '九阳股份', pct: 86, topic: '家电', code: '002242',
      rank20: 2, days: 20, isYizi: false, suspended: false
    }],
    buyTrail: []
  };

  it('★ 产出 out.ebbBuy：替补票 + 专属标签 + 槽位同步 + 进买点名单', function() {
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

  it('★ 行内说明：写出它的常规买点信号（占比达标 ⇒ 竞价买）+ 20日涨幅名次，信息一枚不丢', function() {
    const p = buildTopicVolRatioPlan(topics, dm, { ebbCtx: EBB_CTX2 });
    const note = p.ebbBuy.picks[0].actionNote;
    expect(note).toContain('总龙二');
    expect(note).toContain('20日涨幅全市场排名第 2');
    expect(note).toContain(EBB_SECOND_BUY_TAG);
    expect(note).toContain(EBB_NO_BUY_TAG);
    expect(note).toContain('常规买点信号');
  });

  it('§10：算不出替补（20日前五未就绪）⇒ 没有这一行、没有槽位、也不进买点名单（⛔ 不拿别的票顶替）', function() {
    const p = buildTopicVolRatioPlan(topics, dm, {
      ebbCtx: Object.assign({}, EBB_CTX2, { buyPicks: [], buyTrail: [] })
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

  it('【只在首次 / 二次确认生效】必须写进规则（含取数来源与「只认同一只总龙」）', function() {
    expect(all).toContain('只在首次');
    expect(all).toContain('没有第三次');
    expect(all).toContain('tvrb_ebb_days');
    expect(all).toContain('推断');
    expect(all).toContain('同一只总龙');
  });

  it('第二十一条【退潮替补买】必须写进规则（20日涨幅口径 / 非主板与同题材排除 / 只选前两只）', function() {
    expect(all).toContain(EBB_SECOND_RULE_NO);
    expect(all).toContain(EBB_SECOND_BUY_TAG);
    expect(all).toContain('当日 20日涨幅');   // 与总龙的同一列（[EBB-R20] 改 20日口径）
    expect(all).toContain('非主板');         // 排除创业板 / 科创板 / 北交所
    expect(all).toContain('前两只');         // 用户口径「只选两只，后面不选了」
  });
});

// ── ★ [MANTRA 2026-10-14 第九轮用户口径] 用户要求「在那个提示文字板上加上一句口诀」──────
//   原话：「买在分歧，卖在一致。弱势切抱团，分歧切核心。今天是总市场龙一分歧，核心就是
//          总市场龙二。龙一分歧时，就切到龙二。」
//   ⛔ 用户的口诀必须逐字在规则面板里（他要的就是这几句），并且要和第二十一条【总龙二买】互相指得着。
describe('tvrb · 第九轮规则文案（口诀：分歧切龙二）', function() {
  const all = buildTvrbRulesLines().join('\n');

  it('口诀原话必须逐句写进规则（买在分歧 / 卖在一致 / 弱势切抱团 / 分歧切核心）', function() {
    expect(all).toContain('买在分歧，卖在一致');
    expect(all).toContain('弱势切抱团，分歧切核心');
  });

  it('「市场总龙一分歧 ⇒ 核心就是市场总龙二 / 龙一分歧就切到龙二」必须写进去，并指向第二十一条', function() {
    expect(all).toContain('总市场龙一分歧');
    expect(all).toContain('核心就是总市场龙二');
    expect(all).toContain('龙一分歧时，就切到龙二');
    expect(all).toContain(EBB_SECOND_RULE_NO);   // 口诀 ⇄ 第二十一条【总龙二买】互相指得着
  });
});

// ── ★★ [TVRB-926 2026-10-14 用户口径] 买点侧选股固定用【9:26 口径】的十日涨幅 ──────────────────
//   用户原话：「题材量比看板选股买点侧，为什么早上的，和收盘的不一样，我只想要早上 9 点 26 分的……
//             因为我对照历史日期的时候就对不上，比如今天我明明买了某只股票，过些时间我再翻开那个时期，
//             又成另外一只股票，非常不合理。」
//   根因 = 区间涨幅的 T 腿在 15:00 后被由竞价涨幅换成收盘涨幅 ⇒ 组内十日涨幅重排 ⇒ 龙一换人。
//   实测事故（2026-10-13）：可比题材组 7 个里【5 个】龙一换人。
describe('tvrb · ★ 买点侧选股用【9:26 口径】的十日涨幅（TVRB-926）', function() {
  // 5 只 ⇒ mid（取 1 只）。成员自带 pct = 收盘口径（甲最高）；9:26 口径里乙最高 ⇒ 龙一换人。
  const mk = function() {
    return block('AI应用', 1, [
      m('甲票', { pct: 50, code: '600001' }),
      m('乙票', { pct: 40, code: '600002' }),
      m('丙票', { pct: 30, code: '600003' }),
      m('丁票', { pct: 20, code: '600004' }),
      m('戊票', { pct: 10, code: '600005' })
    ]);
  };
  const p926 = new Map([
    ['甲票', { pct: 10 }], ['乙票', { pct: 45 }], ['丙票', { pct: 30 }],
    ['丁票', { pct: 20 }], ['戊票', { pct: 5 }]
  ]);

  it('rankDragonsWithPctMap：与 rankDragons 同一把尺子，只换「算龙位用的十日涨幅」', function() {
    const topics = [mk()];
    const closeDragon = rankDragonsWithPctMap(topics, null);      // 传 null ⇒ 等价 rankDragons
    const buyDragon = rankDragonsWithPctMap(topics, p926);
    expect(closeDragon.get('甲票').rank).toBe(1);                 // 收盘口径：甲龙一
    expect(closeDragon.get('乙票').rank).toBe(2);
    expect(buyDragon.get('乙票').rank).toBe(1);                   // 9:26 口径：乙龙一（换人）
    expect(buyDragon.get('甲票').rank).toBe(4);   // 9:26 口径下甲退到第 4（乙45 > 丙30 > 丁20 > 甲10）
    // ⭐ 只发主板龙标签这条闸门仍在（创业板 rank 恒 null）—— 与决策看板共用 computeDragonRankMap
    const withGrowth = block('AI应用', 1, [
      m('创业板票', { pct: 99, code: '300001' }),
      m('主板甲', { pct: 50, code: '600001' }),
      m('主板乙', { pct: 40, code: '600002' }),
      m('主板丙', { pct: 30, code: '600003' })
    ]);
    const dmGrowth = rankDragonsWithPctMap([withGrowth], new Map([['创业板票', { pct: 99 }]]));
    expect(dmGrowth.get('创业板票').rank).toBeNull();
    expect(dmGrowth.get('主板甲').rank).toBe(1);
  });

  it('★ 选股与行上十日涨幅【同口径】：选的是 9:26 的龙一，数值也是 9:26 那份', function() {
    const topics = [mk()];
    const closeDragon = rankDragonsWithPctMap(topics, null);
    const buyDragon = rankDragonsWithPctMap(topics, p926);
    const plan = buildTopicVolRatioPlan(topics, closeDragon, { buyDragonMap: buyDragon, pctMap: p926 });
    const b = plan.blocks[0];
    expect(b.picks.map(function(p) { return p.name; })).toEqual(['乙票']);
    expect(b.picks[0].dragonLabel).toBe('龙一');
    expect(b.picks[0].pct).toBe(45);
    expect(b.picks[0].pctText).toContain('45');
    // ⛔ 内部自洽：绝不让「龙一」的标签配着收盘口径的数值（40 是甲的收盘口径值，50 是甲的）
    expect(b.picks[0].pct).not.toBe(40);
  });

  it('缺省 buyDragonMap / pctMap ⇒ 逐字回到旧行为（§11 默认零行为变化）', function() {
    const topics = [mk()];
    const closeDragon = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, closeDragon, {});
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['甲票']);
    expect(plan.blocks[0].picks[0].pct).toBe(50);
    // 空 Map 同样按缺省处理（不做「空集合 ⇒ 全员无龙位」那种悄悄改变选股的降级）
    const plan2 = buildTopicVolRatioPlan(topics, closeDragon, { buyDragonMap: new Map(), pctMap: new Map() });
    expect(plan2.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['甲票']);
  });

  it('§10 某只票在 9:26 那份里没有值 ⇒ 退回成员自带 pct（⛔ 不补 0、不改名次来源）', function() {
    const topics = [mk()];
    const partial = new Map([['乙票', { pct: 45 }]]);          // 甲/丙/丁/戊 都没读到
    const dm2 = rankDragonsWithPctMap(topics, partial);
    const plan = buildTopicVolRatioPlan(topics, dm2, { buyDragonMap: dm2, pctMap: partial });
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['甲票']);
    expect(plan.blocks[0].picks[0].pct).toBe(50);               // 甲自己的值，不是 0
  });

  it('规则面板必须写明「买点侧选股用 9:26 口径」（§6 文案与口径同处一处）', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('二十三');
    expect(all).toContain('9:26');
    expect(all).toContain('买点侧选股');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 第六轮 · 【连续停牌的票买不进】（2026-10-14 用户口径 · SUSPEND-NOBUY）
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：
//   「10月14日的新华传媒是停牌（非首日），不应该选进买点侧，因为停牌的股票根本不能买，也买不进。
//     昨日还可以入选因为是首日停牌。新华传媒如果今天复牌，有成交量，有占比等数据，选进去理所当然，
//     所以改变下规则，停牌首日可选入（已实现），次日还是停牌（没有竞价涨幅，竞价量，昨日成交量等），
//     就不要选进去了，相当于一字买不进，因为当天有 14 只，选 2 只，退到龙二，龙三，
//     买点侧的这个题材应该是今天早上的龙二，龙三（因为能买进）。」
// ⇒ 买点侧遇到【连续停牌】（第 2 天及以上）的龙位，与「竞价一字」走同一条【跳过并顺延】路径。
// ⛔ 只改「买点侧选谁」：题材只数（档位）照旧按全部成员算；退潮 / 总龙 / 卖点一律不看它（§11）。
// ⚠️ 本 describe 只钉【规则层对 buySkipNames 的响应】；「哪些票算连续停牌」在
//    decision-collect.test.js#nonFirstDaySuspendNames 里钉（那是数据层职责，§6）。
describe('tvrb · ★ 买点侧【连续停牌】占掉名额、不再补位（SUSPEND-OCCUPY）', function() {
  /** 14 只 ⇒ big 档 = 取 2 只（与用户举例「当天有 14 只，选 2 只」逐字对齐） */
  const mkBig = function() {
    const members = [];
    for (let i = 1; i <= 14; i++) {
      const n = (i < 10 ? '0' : '') + i;
      members.push(m('票' + n, { pct: 100 - i, code: '6000' + n }));
    }
    return block('AI应用', 1, members);
  };

  it('★★ [用户口径 2026-10-15] 龙一连续停牌 ⇒ 占掉一个名额、只买龙二 1 只（10-14 AI应用 逐字复现）', function() {
    const topics = [mkBig()];
    const dm = rankDragonsWithPctMap(topics, null);
    // 对照组：不跳的时候确实取龙一 + 龙二（证明下面的差异只来自 buySkipNames）
    const before = buildTopicVolRatioPlan(topics, dm, {});
    expect(before.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['票01', '票02']);
    // 龙一（票01）连续停牌 ⇒ 买不进 ⇒ 该名额作废 ⇒ 只剩 1 个名额 ⇒ 只买龙二（票02）1 只
    const plan = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set(['票01']) });
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['票02']);
    expect(plan.blocks[0].picks.map(function(p) { return p.dragonLabel; })).toEqual(['龙二']);
    // §10 说明区必须如实写出「不补位 / 少取」
    const notes = plan.blocks[0].notes.join('\n');
    expect(notes).toContain('不再补位');
    expect(notes).toContain('实际取 1 只');
  });

  it('★ 题材只数（档位）不因停牌而变：仍按全部成员 14 只算 ⇒ 取 2 只', function() {
    const topics = [mkBig()];
    const dm = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set(['票01', '票02']) });
    expect(plan.blocks[0].block.count).toBe(14);
    // 前两名都停牌 ⇒ 2 个名额全被占掉 ⇒ 实际一只都不取（⛔ 不往下补位）
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual([]);
  });

  it('§11 不传 / 传 null / 传空 Set ⇒ 逐字回到旧行为（停牌票照旧可入选）', function() {
    const topics = [mkBig()];
    const dm = rankDragonsWithPctMap(topics, null);
    const a = buildTopicVolRatioPlan(topics, dm, {});
    const b = buildTopicVolRatioPlan(topics, dm, { buySkipNames: null });
    const c = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set() });
    const names = function(p) { return p.blocks[0].picks.map(function(x) { return x.name; }); };
    expect(names(a)).toEqual(['票01', '票02']);
    expect(names(b)).toEqual(names(a));
    expect(names(c)).toEqual(names(a));
  });

  it('停牌的票【不在】前排龙位 ⇒ 取票结果不变（名额早已用满，轮不到它）', function() {
    const topics = [mkBig()];
    const dm = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set(['票05']) });
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['票01', '票02']);
  });

  it('★ 与【竞价一字】并存 ⇒ 语义不同：一字顺延补位（不占名额）、停牌占名额不补', function() {
    const members = [
      m('一字票', { pct: 90, isYizi: true, code: '600001' }),   // 龙一：一字 ⇒ 顺延，不占名额
      m('停牌票', { pct: 80, code: '600002' }),                  // 龙二：连续停牌 ⇒ 占掉 1 个名额
      m('正常甲', { pct: 70, code: '600003' }),                  // 龙三：补上第 2 个名额
      m('正常乙', { pct: 60, code: '600004' })
    ];
    for (let i = 5; i <= 14; i++) members.push(m('票' + i, { pct: 60 - i, code: '6000' + i }));
    const topics = [block('AI应用', 1, members)];
    const dm = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set(['停牌票']) });
    // 2 个名额：一字票不占 ⇒ 关键在停牌票占掉一个 ⇒ 只剩「正常甲」1 只
    expect(plan.blocks[0].picks.map(function(p) { return p.name; })).toEqual(['正常甲']);
    const notes = plan.blocks[0].notes.join('\n');
    expect(notes).toContain('竞价涨停');
    expect(notes).toContain('连续停牌');
  });

  it('§10 说明区如实写出「连续停牌 ⇒ 买不进 ⇒ 不再补位」，且点明【首日不跳】', function() {
    const topics = [mkBig()];
    const dm = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, dm, { buySkipNames: new Set(['票01']) });
    const notes = plan.blocks[0].notes.join('\n');
    expect(notes).toContain('连续停牌');
    expect(notes).toContain('不再补位');
    expect(notes).toContain('票01');
    expect(notes).toContain('首日');
  });

  it('规则面板必须写明第二十四条（§6 文案与口径同处一处）', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('二十四');
    expect(all).toContain('连续停牌');
    expect(all).toContain('买不进');
    expect(all).toContain('不再补位');
  });
});

// ── ★ [EBB-D1 2026-10-21 用户口径] 昨日二次确认退潮 ⇒ 次日禁入买点侧（第二十六条）──────────
//   用户原话：「主线题材如果昨天已经二次确认退潮了，次日就不要进入买点侧了，也就是说次日即使
//     这个题材符合平均量比的条件，题材平均量比排名第二，也不应该买了，因为风险很高。其它题材可以。
//     ……你把买点侧的主线题材入选的票的区域，变成灰色，不用去掉，其它题材不变。」
//   （10-21 实例：AI应用 10-20 二次确认退潮，10-21 它平均量比排第二、慈文传媒进了买点侧 ⇒ 不合理。）
describe('tvrb · [EBB-D1] secondEbbTopicOfPrevDay（昨日二次确认退潮判据）', function() {
  // 事件链：10-13 首次退潮（AI应用）……10-20 二次确认退潮（AI应用）
  const HIST = [
    { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];

  it('昨日那笔退潮 = 起点前已有 1 次同题材事件 ⇒ 判【二次确认】并返回题材', function() {
    const r = secondEbbTopicOfPrevDay(HIST, '2026-10-20');
    expect(r).not.toBeNull();
    expect(r.topic).toBe('AI应用');
    expect(r.leaderName).toBe('新华传媒');
    expect(r.since).toBe('2026-10-20');
  });

  it('昨日是【首次】退潮（起点前 0 次事件）⇒ null（首次退潮次日不在本规则内）', function() {
    const r = secondEbbTopicOfPrevDay([HIST[0]], '2026-10-13');
    expect(r).toBeNull();
  });

  it('昨日无退潮行 / 昨日 ebb=false ⇒ null', function() {
    expect(secondEbbTopicOfPrevDay(HIST, '2026-10-16')).toBeNull();          // 那天没有行
    expect(secondEbbTopicOfPrevDay([
      { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
      { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: false }
    ], '2026-10-20')).toBeNull();
  });

  it('⛔ 防御：prevDate 缺省 / history 缺省 ⇒ null（§10 判不出 ≠ 昨天没退潮，但也绝不误禁）', function() {
    expect(secondEbbTopicOfPrevDay(HIST, '')).toBeNull();
    expect(secondEbbTopicOfPrevDay(null, '2026-10-20')).toBeNull();
    expect(secondEbbTopicOfPrevDay([], '2026-10-20')).toBeNull();
  });

  it('连续退潮日合并为一次事件：昨日与前一交易日同题材都退潮 ⇒ 起点合并，事件序数不变', function() {
    // 10-19 与 10-20 连续退潮（同题材）⇒ 走回连续链找到起点 10-19；10-19 前已有 1 次事件 ⇒ 仍是二次确认
    const rows = [
      { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
      { date: '2026-10-19', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
      { date: '2026-10-20', prevDate: '2026-10-19', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
    ];
    const r = secondEbbTopicOfPrevDay(rows, '2026-10-20');
    expect(r).not.toBeNull();
    expect(r.since).toBe('2026-10-19');
  });

  it('起点前已有 ≥2 次事件 ⇒ null（无第三次，连这条禁入规则也不再适用）', function() {
    const rows = [
      { date: '2026-10-09', prevDate: '2026-10-08', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
      { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
      { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
    ];
    expect(secondEbbTopicOfPrevDay(rows, '2026-10-20')).toBeNull();
  });

  it('认亲按【题材】：昨日退潮行是别的题材 ⇒ 与本题材无关 ⇒ null', function() {
    const rows = [
      { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: 'XX龙一', leaderTopic: '机器人', ebb: true },
      { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
    ];
    // AI应用 起点=10-20，之前没有 AI应用 的事件 ⇒ 首次 ⇒ null
    expect(secondEbbTopicOfPrevDay(rows, '2026-10-20')).toBeNull();
  });
});

describe('tvrb · [EBB-D1] 经 buildTopicVolRatioPlan：昨日二次确认退潮题材灰化保留（第二十六条）', function() {
  /** 高量比题材（平均量比 ≥ 25 ⇒ 不触发空仓提醒，隔离本规则的效果） */
  function hiBlock(topic, rank, names) {
    const members = names.map(function(n, i) {
      return m(n, { aucVolRatio: 60 - i, pct: 60 - i, code: '6000' + (i + 1) });
    });
    return block(topic, rank, members);
  }
  const HIST = [
    { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];

  function build() {
    const topics = [
      hiBlock('AI应用', 1, ['新华传媒', '慈文传媒', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']),
      hiBlock('机器人', 2, ['B1', 'B2', 'B3', 'B4'])
    ];
    const dm = rankDragonsWithPctMap(topics, null);
    return buildTopicVolRatioPlan(topics, dm, { prevDate: '2026-10-20', ebbHistory: HIST });
  }

  it('命中题材：整块灰化旗 + 照常入选（不删）+ 标签一律【退潮不买】+ 持有/仓位清空', function() {
    const plan = build();
    const ai = plan.blocks.filter(function(b) { return b.block.topic === 'AI应用'; })[0];
    expect(ai).toBeDefined();                       // ⛔ 不删：题材块照常入选占位
    expect(ai.prevEbbGray).toBe(true);              // 视图层据此挂 .tvrb-prev-ebb-gray
    ai.picks.forEach(function(p) {
      expect(p.buyActionTag).toBe(EBB_NO_BUY_TAG);
      expect(p.buyActionTone).toBe(EBB_NO_BUY_TONE);
      expect(p.holdTag).toBe('');
      expect(p.position).toBe('');
      expect(p.actionNote).toContain('二次确认退潮');
      expect(p.actionNote).toContain('第二十六条');
    });
    expect(ai.notes.join('\n')).toContain('禁止买入');
    expect(plan.notes.join('\n')).toContain('AI应用');
    expect(plan.notes.join('\n')).toContain('第二十六条');
  });

  it('其它题材【一字不变】：不灰化、标签不走退潮不买', function() {
    const plan = build();
    const rb = plan.blocks.filter(function(b) { return b.block.topic === '机器人'; })[0];
    expect(rb).toBeDefined();
    expect(rb.prevEbbGray).toBeFalsy();
    rb.picks.forEach(function(p) {
      expect(p.buyActionTag).not.toBe(EBB_NO_BUY_TAG);
    });
  });

  it('⛔ 禁入的票【不进买点名单】（卖点侧不得因「今天又进买点」标持有）', function() {
    const plan = build();
    expect(plan.buyNames.has('慈文传媒')).toBe(false);
    expect(plan.buyNames.has('新华传媒')).toBe(false);
    expect(plan.buyNames.size).toBeGreaterThan(0);   // 其它题材的票照常进名单
  });

  it('⛔ 缺省（无 prevDate / 无 ebbHistory）⇒ 零行为（§11）', function() {
    const topics = [
      hiBlock('AI应用', 1, ['新华传媒', '慈文传媒', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'])
    ];
    const dm = rankDragonsWithPctMap(topics, null);
    const p1 = buildTopicVolRatioPlan(topics, dm, {});
    const p2 = buildTopicVolRatioPlan(topics, dm, { prevDate: '2026-10-20' });
    const p3 = buildTopicVolRatioPlan(topics, dm, { ebbHistory: HIST });
    [p1, p2, p3].forEach(function(p) {
      p.blocks.forEach(function(b) { expect(b.prevEbbGray).toBeFalsy(); });
      expect(p.buyNames.has('慈文传媒')).toBe(true);
    });
  });

  it('规则面板必须写明第二十六条（§6 文案与口径同处一处）', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('二十六');
    expect(all).toContain('二次确认退潮');
    expect(all).toContain('次日禁入买点侧');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ 第二十八条【新龙 / 新题材切换日】（2026-10-22 用户口径）
//
// 用户原话（逐条对应下面的用例）：
//   「二次退潮次日后一天就要切换新题材或寻找新题材了。」
//   「20个交易日内，上述的时间点这只股票名称有没有上榜？今天是不是首次20日涨幅上榜前五？
//     如果是，看下一个条件，是不是和老龙一是不是同个题材，如果不是，说明这是个新龙。」
//   「规则要添加下：只选20日涨幅排名前五题材，没有出现过的新龙。」
//   「如果看20日涨幅没有符合条件……接下来就是常规班选股了，不做限制。」
//
// 时间轴：D = 二次确认退潮日（10-20）→ D+1 禁买主轴（第二十六条，10-21）→ D+2 = 切换日（10-22）。
// 10-22 实测前五：新华传媒(AI应用·老龙一) / 九阳股份(大消费·已上过榜) / 冰山冷热(电子通信算力·首次)
//                / 慈文传媒(AI应用) / 新华文轩(AI应用)
//   ⇒ 新龙 = 冰山冷热；常规侧收紧到【一个题材、一只】= 工业4.0 的宁波东力。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [SWITCH] 常量与用户口径逐字一致', function() {
  it('规则编号 / 前八只数 / 回看 20 个交易日', function() {
    expect(SWITCH_RULE_NO).toBe('二十八');
    expect(NEW_DRAGON_TOP_N).toBe(8);              // 「如果前五找不到，你就找前八的，改用排名前八的」
    expect(NEW_DRAGON_LOOKBACK_DAYS).toBe(20);     // 「20个交易日内……有没有上过榜」
    expect(NEW_DRAGON_TAG).toBe('新龙买');
    expect(NEW_DRAGON_TONE).toBe(EBB_SECOND_BUY_TONE);  // 复用「退潮替补买」的琥珀金（不新造配色档）
  });
});

describe('tvrb · [SWITCH] detectSwitchDay（切换日判据 = 二次确认退潮正好在前两个交易日）', function() {
  // 10-13 首次退潮 → 10-20 二次确认退潮（同题材 = 认亲成立）
  const HIST = [
    { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];

  it('前两个交易日 = 二次确认退潮日 ⇒ 切换日成立（返回退潮日 / 题材 / 老龙一）', function() {
    const r = detectSwitchDay(HIST, '2026-10-20');
    expect(r).not.toBeNull();
    expect(r.ebbDate).toBe('2026-10-20');
    expect(r.topic).toBe('AI应用');
    expect(r.leaderName).toBe('新华传媒');
  });

  it('前一个交易日 = 二次确认退潮日 ⇒ 那是【退潮次日·禁入日】（第二十六条）不是切换日', function() {
    expect(detectSwitchDay(HIST, '2026-10-21')).toBeNull();
  });

  it('前两个交易日是【首次】退潮 ⇒ 不是切换日（首发次日走退潮不买 + 替补）', function() {
    expect(detectSwitchDay(HIST, '2026-10-13')).toBeNull();
  });

  it('⛔ 缺省（无 prevPrevDate / 无历史）⇒ null（§11 默认零行为变化）', function() {
    expect(detectSwitchDay(HIST, '')).toBeNull();
    expect(detectSwitchDay(HIST, null)).toBeNull();
    expect(detectSwitchDay(null, '2026-10-20')).toBeNull();
    expect(detectSwitchDay([], '2026-10-20')).toBeNull();
  });

  it('★ 脏值题材（落库 leaderTopic = \'16950\'）⇒ topic 归一成空串，绝不把数字当题材', function() {
    const rows = [
      { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: '16950', ebb: true },
      { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: '16950', ebb: true }
    ];
    const r = detectSwitchDay(rows, '2026-10-20');
    expect(r).not.toBeNull();                 // 判据仍成立（靠同一只总龙认亲）
    expect(r.topic).toBe('');                 // ⛔ 不渲染「主线16950」
    expect(r.leaderName).toBe('新华传媒');
  });
});

describe('tvrb · [SWITCH] pickNewDragon（首次上榜前五 + 与老龙一不同题材 ⇒ 新龙）', function() {
  /** 当日 20日涨幅前五（decision-collect 富化后的形状） */
  function top5Real() {
    return [
      { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 188.12, pctText: '+188.12%', rank20: 1 },
      { name: '九阳股份', code: '002242', topic: '大消费', pct: 133.69, pctText: '+133.69%', rank20: 2 },
      { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 87.18, pctText: '+87.18%', rank20: 3 },
      { name: '慈文传媒', code: '002343', topic: 'AI应用', pct: 80.10, pctText: '+80.10%', rank20: 4 },
      { name: '新华文轩', code: '601811', topic: 'AI应用', pct: 75.50, pctText: '+75.50%', rank20: 5 }
    ];
  }
  /** 近 20 个交易日内【上过前五】的票：新华传媒、九阳股份曾上榜；冰山冷热从没上过 */
  function everReal() {
    return new Set(['新华传媒', '九阳股份', '慈文传媒', '新华文轩', '三孚股份']);
  }

  it('★ 10-22 实测：跳过老龙一 / 跳过已上榜 / 跳过同题材 ⇒ 选出【冰山冷热】', function() {
    const r = pickNewDragon(top5Real(), everReal(), { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.pick).not.toBeNull();
    expect(r.pick.name).toBe('冰山冷热');
    expect(r.oldTopic).toBe('AI应用');
  });

  it('五只去留全部可追溯（每条都有理由，逐条对应判据）', function() {
    const r = pickNewDragon(top5Real(), everReal(), { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    const byName = {};
    r.trail.forEach(function(t) { byName[t.name] = t; });
    expect(byName['新华传媒'].picked).toBe(false);
    expect(byName['新华传媒'].reason).toContain('老龙一');
    expect(byName['九阳股份'].picked).toBe(false);
    expect(byName['九阳股份'].reason).toContain('已上过前五');
    expect(byName['九阳股份'].reason).toContain('8 个交易日');   // 覆盖度如实上报
    expect(byName['冰山冷热'].picked).toBe(true);
    expect(byName['冰山冷热'].reason).toContain('首次');
    // 新龙已选定 ⇒ 后两只照样留痕（⛔ 不从「五只去留」里凭空消失），理由写明「前面已选出」
    expect(byName['慈文传媒'].picked).toBe(false);
    expect(byName['慈文传媒'].reason).toContain('冰山冷热');
    expect(byName['新华文轩'].picked).toBe(false);
    expect(r.trail.length).toBe(5);                    // ⛔ 不只报结果，五只全留痕
  });

  it('同题材的排除理由必须写明「老周期不买」（不是靠「前面已选出」蒙过去）', function() {
    // 老龙一与九阳都排在新龙前面被排除，慈文/文轩才轮到「同题材」这一条
    const top5 = [
      { name: '九阳股份', topic: '大消费', pct: 133.69, rank20: 2 },
      { name: '慈文传媒', topic: 'AI应用', pct: 80.10, rank20: 4 },
      { name: '新华文轩', topic: 'AI应用', pct: 75.50, rank20: 5 }
    ];
    const r = pickNewDragon(top5, new Set(['九阳股份']), { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.pick).toBeNull();
    expect(r.trail[1].reason).toContain('同题材');
    expect(r.trail[2].reason).toContain('同题材');
  });

  it('五只全是老题材（同题材）⇒ 无新龙（回落常规）', function() {
    const top5 = top5Real().map(function(c) { return Object.assign({}, c, { topic: 'AI应用' }); });
    const r = pickNewDragon(top5, everReal(), { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.pick).toBeNull();
  });

  it('五只 20 日内都上过榜 ⇒ 无新龙（「没有出现过的新龙」这条没满足）', function() {
    const ever = new Set(['新华传媒', '九阳股份', '冰山冷热', '慈文传媒', '新华文轩']);
    const r = pickNewDragon(top5Real(), ever, { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.pick).toBeNull();
  });

  it('★ 老龙题材缺失 ⇒ 退回「今天榜第一名的题材」（停牌的老龙仍占榜首，语义等价）', function() {
    const r = pickNewDragon(top5Real(), everReal(), { oldTopic: '', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.oldTopic).toBe('AI应用');                 // ← 由 top5[0].topic 兜底
    expect(r.pick.name).toBe('冰山冷热');
  });

  it('题材解析不到（脏值 / 空）⇒ 保守排除，不当新龙（§10 无法证明是新题材）', function() {
    const top5 = top5Real().map(function(c) {
      return c.name === '冰山冷热' ? Object.assign({}, c, { topic: '16950' }) : c;
    });
    const r = pickNewDragon(top5, everReal(), { oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 8 });
    expect(r.pick).toBeNull();
    const bad = r.trail.filter(function(t) { return t.name === '冰山冷热'; })[0];
    expect(bad.picked).toBe(false);
    expect(bad.reason).toContain('题材');
  });

  it('分段题材串（\'AI应用,数据中心\'）与老题材认亲成立 ⇒ 同题材，跳过', function() {
    const top5 = [
      { name: '新华传媒', topic: 'AI应用', pct: 188, rank20: 1 },
      { name: '某票', topic: 'AI应用,数据中心', pct: 90, rank20: 2 }
    ];
    const r = pickNewDragon(top5, new Set(['新华传媒']), { oldTopic: 'AI应用', oldLeaderName: '新华传媒' });
    expect(r.pick).toBeNull();
    expect(r.trail[1].reason).toContain('同题材');
  });

  it('空榜 / 空历史 ⇒ pick=null 且不抛错（防御；规则层另有「读不到历史就不判」的闸门）', function() {
    expect(pickNewDragon([], new Set(), {}).pick).toBeNull();
    expect(pickNewDragon(null, null, {}).pick).toBeNull();
  });
});

describe('tvrb · [SWITCH] 经 buildTopicVolRatioPlan：切换日买点侧 = 新龙 + 常规收紧一只', function() {
  /** 高量比题材（平均量比 ≥ 25 ⇒ 不触发空仓提醒，隔离本规则） */
  function hiBlock(topic, rank, names) {
    const members = names.map(function(n, i) {
      return m(n, { aucVolRatio: 60 - i, pct: 60 - i, code: '6000' + (i + 1) });
    });
    return block(topic, rank, members);
  }
  const HIST = [
    { date: '2026-10-13', prevDate: '2026-10-12', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-20', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];
  const TOP5 = [
    { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 188.12, rank20: 1 },
    { name: '九阳股份', code: '002242', topic: '大消费', pct: 133.69, rank20: 2 },
    { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 87.18, rank20: 3 },
    { name: '慈文传媒', code: '002343', topic: 'AI应用', pct: 80.10, rank20: 4 },
    { name: '新华文轩', code: '601811', topic: 'AI应用', pct: 75.50, rank20: 5 }
  ];
  const EVER = new Set(['新华传媒', '九阳股份', '慈文传媒', '新华文轩']);

  function topicsReal() {
    return [
      hiBlock('AI应用', 1, ['新华传媒', '慈文传媒', 'A3', 'A4', 'A5', 'A6']),
      hiBlock('电子通信算力', 2, ['冰山冷热', 'C2', 'C3', 'C4', 'C5']),
      hiBlock('工业4.0', 3, ['宁波东力', 'D2', 'D3', 'D4', 'D5']),
      hiBlock('房地产', 4, ['E1', 'E2', 'E3', 'E4'])
    ];
  }
  function build(over) {
    const topics = topicsReal();
    const dm = rankDragonsWithPctMap(topics, null);
    return buildTopicVolRatioPlan(topics, dm, Object.assign({
      // ready:false ⇒ 今天不算退潮日（隔离退潮分支，只看切换日规则）；top5 照常下发
      ebbCtx: { ready: false, top5: TOP5 },
      prevPrevDate: '2026-10-20',
      ebbHistory: HIST,
      top5HistoryEver: EVER,
      top5HistoryDays: 8
    }, over || {}));
  }

  it('★ 判出切换日 + 新龙 ⇒ switchDay / newDragon 同时非空', function() {
    const plan = build();
    expect(plan.switchDay).not.toBeNull();
    expect(plan.switchDay.leaderName).toBe('新华传媒');
    expect(plan.switchDay.topic).toBe('AI应用');
    expect(plan.newDragon).not.toBeNull();
    expect(plan.newDragon.block.topic).toBe('新龙 · 电子通信算力');
    expect(plan.newDragon.isNewDragon).toBe(true);
    expect(plan.newDragon.rank).toBeNull();          // ⛔ 不是题材排名，不给圆点
  });

  it('★ 新龙那一行的动作标签 = 【新龙买】，客观数据仍在（走过 finishBuyBlock）', function() {
    const plan = build();
    const picks = plan.newDragon.picks;
    expect(picks).toHaveLength(1);
    const p = picks[0];
    expect(p.name).toBe('冰山冷热');
    expect(p.buyActionTag).toBe(NEW_DRAGON_TAG);
    expect(p.buyActionTone).toBe(NEW_DRAGON_TONE);
    expect(p.holdTag).toBe('');                      // 与「今天要买」互斥
    expect(p.position).toBe('');
    expect(p.dragonLabel).toBe('总龙三');            // 20日涨幅第 3 名（客观数据未被标签改写影响）
    expect(p.actionNote).toContain('第二十八条');
    expect(p.actionNote).toContain('新周期');
  });

  it('★ 名次文案必须跟数据走：第 6 名时⛔ 绝不许写「上到前五」（2026-10-22 用户当场抓到的表述错误）', function() {
    // 前八：前 5 只全不合格（老龙一 / 已上过前五 / 同题材），新龙落在第 6 名
    const WIDE = [
      { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 188.12, rank20: 1 },
      { name: '九阳股份', code: '002242', topic: '大消费', pct: 133.69, rank20: 2 },
      { name: '慈文传媒', code: '002343', topic: 'AI应用', pct: 80.10, rank20: 3 },
      { name: '新华文轩', code: '601811', topic: 'AI应用', pct: 75.50, rank20: 4 },
      { name: '粤传媒', code: '002181', topic: 'AI应用', pct: 70.00, rank20: 5 },
      { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 87.18, rank20: 6 }
    ];
    const plan = build({ ebbCtx: { ready: false, top5: TOP5, newDragonPool: WIDE } });
    expect(plan.newDragon).not.toBeNull();
    const p = plan.newDragon.picks[0];
    expect(p.name).toBe('冰山冷热');
    // 前五才有「总龙N」标；第 6 名如实写「20日涨幅第 6 名」（⛔ 不出现 totalDragonLabel 的 '' 与「总龙?」）
    expect(p.dragonLabel).toBe('');
    expect(plan.newDragon.reason).toContain('20日涨幅第 6 名');
    expect(plan.newDragon.reason).not.toContain('总龙?');
    // 名次文案：写「今日排名第 6 名」，⛔ 不再有「上到前五」这种假话
    expect(plan.newDragon.reason).toContain('今日排名第 6 名');
    expect(plan.newDragon.reason).not.toContain('上到前五');
    expect(p.actionNote).toContain('今日排名第 6 名');
    expect(p.actionNote).not.toContain('上到前五');
    expect(plan.notes.join('\n')).not.toContain('总龙?');
  });

  it('★ 历史榜只覆盖 8/20 天 ⇒ 文案必须同时写出窗口与实际覆盖（⛔ 不许把 8 说成 20）', function() {
    const plan = build();                    // top5HistoryDays: 8
    // 窗口口径是 20 个交易日（NEW_DRAGON_LOOKBACK_DAYS），实际只有 8 天有落库行
    expect(plan.newDragon.reason).toContain('8 个交易日');
    expect(plan.newDragon.reason).toContain('实际覆盖 8/20 天');
    // 覆盖足 20 天时不加这句（避免天天挂一句噪音）
    const full = build({ top5HistoryDays: 20 });
    expect(full.newDragon.reason).toContain('20 个交易日');
    expect(full.newDragon.reason).not.toContain('实际覆盖');
  });

  it('★ 常规侧【收紧】：只选一个题材、只取一只，且跳过老题材与新龙题材', function() {
    const plan = build();
    expect(plan.blocks).toHaveLength(1);             // ← 只有一个题材（默认是 2）
    expect(plan.blocks[0].block.topic).toBe('工业4.0');
    expect(plan.blocks[0].picks).toHaveLength(1);    // ← 只取一只（该题材 > 8 只时默认取 2）
    expect(plan.blocks[0].picks[0].name).toBe('宁波东力');
    expect(plan.pickCount).toBe(2);                  // = 新龙 1 + 常规 1
  });

  it('新旧两个题材被跳过的原因都写进说明（可追溯）', function() {
    const plan = build();
    const all = plan.notes.join('\n');
    expect(all).toContain('第二十八条');
    expect(all).toContain('老周期');                 // AI应用 被跳过
    expect(all).toContain('新龙');                   // 电子通信算力 被跳过
  });

  it('新龙那只票进 buyNames（卖点侧「今天又进买点 ⇒ 持有」要用它）', function() {
    const plan = build();
    expect(plan.buyNames.has('冰山冷热')).toBe(true);
    expect(plan.buyNames.has('宁波东力')).toBe(true);
    expect(plan.buyNames.has('新华传媒')).toBe(false);   // 老龙一不买
  });

  it('★ decision-collect 的装饰器遍历买点块时必须能看到它（挂进 buy.newDragon）', function() {
    const plan = build();
    expect(plan.buy.newDragon).toBe(plan.newDragon);
    expect(plan.buy.newDragon.picks[0].name).toBe('冰山冷热');
  });

  it('切换日但【没有】符合条件的新龙 ⇒ 新龙行不出现 + 回落常规（仍只取一个题材）+ 原因可见', function() {
    const plan = build({ top5HistoryEver: new Set(['新华传媒', '九阳股份', '冰山冷热', '慈文传媒', '新华文轩']) });
    expect(plan.switchDay).not.toBeNull();
    expect(plan.newDragon).toBeNull();
    expect(plan.buy.newDragon).toBeNull();
    // ★ [CYCLE 2026-10-22 用户口径] 切换日【始终】收紧到「一个题材、一只」——
    //   老周期昨天已结束，今天不可能再买两个题材（与「判不出新龙就不收紧」的旧口径相反）。
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].picks).toHaveLength(1);
    expect(plan.notes.join('\n')).toContain('回落常规');
    expect(plan.notes.join('\n')).toContain('八只去留');   // 判不出的原因逐只留痕
  });

  it('⛔ 历史榜读不到（top5HistoryEver 缺省）⇒ 判不出，⛔ 绝不把「没数据」当「首次上榜」', function() {
    const plan = build({ top5HistoryEver: null });
    expect(plan.switchDay).not.toBeNull();
    expect(plan.newDragon).toBeNull();                // ← 没有凭空冒出「新龙」
    expect(plan.blocks).toHaveLength(1);              // ← 回落常规（但仍只取一个题材）
    expect(plan.notes.join('\n')).toContain('无法判定');
  });

  it('⛔ 前五未就绪（top5 为空）⇒ 同样判不出（不猜），说明可见', function() {
    const plan = build({ ebbCtx: { ready: false, top5: [] } });
    expect(plan.newDragon).toBeNull();
    expect(plan.notes.join('\n')).toContain('未就绪');
  });

  it('⛔ 非切换日（prevPrevDate = 退潮次日 10-21）⇒ 零行为变化（§11）', function() {
    const plan = build({ prevPrevDate: '2026-10-21' });
    expect(plan.switchDay).toBeNull();
    expect(plan.newDragon).toBeNull();
    // 常规照旧：前两个题材（AI应用 rank1 + 电子通信算力 rank2）都入选，不收紧、不跳题材
    expect(plan.blocks.map(function(b) { return b.block.topic; })).toEqual(['AI应用', '电子通信算力']);
    expect(plan.notes.join('\n')).not.toContain('第二十八条');
  });

  it('⛔ 缺省（无 prevPrevDate / 无 ebbHistory / 无 top5）⇒ 逐字等于旧行为（§11）', function() {
    const topics = topicsReal();
    const dm = rankDragonsWithPctMap(topics, null);
    const base = buildTopicVolRatioPlan(topics, dm, {});
    const p1 = buildTopicVolRatioPlan(topics, dm, { prevPrevDate: '2026-10-20' });
    const p2 = buildTopicVolRatioPlan(topics, dm, { ebbHistory: HIST });
    const p3 = buildTopicVolRatioPlan(topics, dm, { top5HistoryEver: EVER });
    [p1, p2, p3].forEach(function(p) {
      expect(p.switchDay).toBeNull();
      expect(p.newDragon).toBeNull();
      expect(p.buy.newDragon).toBeNull();
      expect(p.blocks.map(function(b) { return b.block.topic; }))
        .toEqual(base.blocks.map(function(b) { return b.block.topic; }));
      expect(p.pickCount).toBe(base.pickCount);
    });
  });

  it('规则面板必须写明第二十八条与「只选 20日涨幅前五…没有出现过的新龙」（§6 文案同处一处）', function() {
    const all = buildTvrbRulesLines().join('\n');
    expect(all).toContain('二十八');
    expect(all).toContain('新龙');
    expect(all).toContain('首次');
    expect(all).toContain('前五');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [CORE-CAT / EBB-20D / CYCLE 2026-10-22 用户报障回归]
//
// 用户原话（10-22 收盘后）：
//   「主线文化传媒首次退潮 · 买点替补只有这 2 只（退潮替补买）……这个逻辑错了，我都说不是首次退潮了，
//     首次退潮是在它首次停牌哪天（10-13），它停牌好几天的。……买点侧选的应该是冰山冷热，和宁波东力。
//     而不是现在的 九阳股份，冰山冷热，下面还有重复的冰山冷热。……还有时间点，你也没计算清楚。
//     ……还是说你判断的时候用的时间段错了，提示板上写着（近10个交易日内AI应用没有退潮事件），
//     时间太短没有检查到10月13日那天？」
//
// 四条根因 + 四条修法（本 describe 逐条钉住）：
//   ① 题材名漂移（行上「文化传媒」vs 落库「AI应用」）⇒ 事件计数 2→0 ⇒ 误报首次退潮
//      ⇒ 修：题材按【核心词大类】认亲（o.coreTopics 注入）；
//   ② 计数窗口只有 10 个交易日 ⇒ 修：EBB_EVENT_WINDOW_DAYS = 20；
//   ③ 切换日仍判退潮 ⇒ 退潮替补与切换日新龙两条买点路径同时输出
//      ⇒ 修：切换日 out.ebb 恒 null、退潮替补恒 null；
//   ④ 冰山冷热在「退潮替补」和「新龙」两处重复 ⇒ 修：买点侧全局同名去重（新龙优先）。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [EBB-20D] 退潮事件计数窗口 = 近 20 个交易日', function() {
  it('常量 = 20（用户「时间太短没有检查到10月13日那天？」）', function() {
    expect(EBB_EVENT_WINDOW_DAYS).toBe(20);
  });

  /** 造一条「退潮事件」：同题材、ebb=true */
  function ebbRow(date, prevDate) {
    return { date: date, prevDate: prevDate, leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true };
  }
  /** 造 20 个交易日（升序）：第 i 天 = 2026-09-01 起顺延的假日期，只为构造「第 N 个交易日前」 */
  function days(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('2026-09-' + String(i + 1).padStart(2, '0'));
    return out;
  }
  const EBB_CTX = {
    ready: true, leader: { name: '新华传媒', pct: 200, topic: 'AI应用' },
    leaderSuspended: true, leaderShare: null,
    siblingDragons: [], secondInfo: null, prevLeader: null, buyPicks: [], buyTrail: [], top5: []
  };

  it('★ 事件落在第 15 个交易日前（旧 10 天窗口看不到）⇒ 现在能看到 ⇒ 计为【二次确认】不是首次', function() {
    const d = days(20);
    // 第 15 天前（= 窗口内、但 10 天窗口外）的一次退潮事件
    const hist = [ebbRow(d[2], d[1])];
    const r = detectEbbDay(EBB_CTX, null, hist, null, d[0]);
    expect(r).not.toBeNull();                 // 停牌 ⇒ 触发退潮
    expect(r.phase).toBe('second');           // ← 20 天窗口看得到 ⇒ 二次确认
    expect(r.phaseTitle).toContain('二次确认');
  });

  it('★ 20 天内已有 2 次事件 ⇒ 命中「无第三次」⇒ 不判退潮（返回 null）', function() {
    const d = days(20);
    const hist = [ebbRow(d[2], d[1]), ebbRow(d[15], d[14])];
    expect(detectEbbDay(EBB_CTX, null, hist, null, d[0])).toBeNull();
  });

  it('窗口起点之前的事件不计入（windowFrom = 第 20 个交易日的日期）', function() {
    const d = days(22);
    // d[0] 是第 22 个交易日前 ⇒ 在窗口起点（d[2]）之前 ⇒ 不计入
    const hist = [ebbRow(d[0], '2026-08-31')];
    const r = detectEbbDay(EBB_CTX, null, hist, null, d[2]);
    expect(r).not.toBeNull();
    expect(r.phase).toBe('first');            // 窗口外 ⇒ 看不到 ⇒ 仍是首次
  });
});

describe('tvrb · [CORE-CAT] 题材按【核心词大类】认亲（文化传媒 ⇒ AI应用）', function() {
  // 用户口径：核心管理里「AI应用」这个大类的同义词包含「文化传媒」。
  const CORES = [
    { name: 'AI应用', synonyms: ['文化传媒', '影视院线', '短剧'] },
    { name: '机器人', synonyms: ['人形机器人', '减速器'] },
    { name: '电力', synonyms: ['风电'] }
  ];
  /** 10-22 实况：行上市细题材是「文化传媒」，落库历史行写的是「AI应用」 */
  const EBB_CTX = {
    ready: true, leader: { name: '新华传媒', pct: 214.3, topic: '文化传媒' },
    leaderSuspended: true, leaderShare: null,
    siblingDragons: [], secondInfo: null, prevLeader: null, buyPicks: [], buyTrail: [], top5: []
  };
  // 10-14 + 10-15 连续停牌（1 次事件，合并）+ 10-20 二次确认（1 次事件）= 2 次
  const HIST = [
    { date: '2026-10-14', prevDate: '2026-10-13', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-15', prevDate: '2026-10-14', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-16', prevDate: '2026-10-15', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: false },
    { date: '2026-10-19', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: false },
    { date: '2026-10-20', prevDate: '2026-10-19', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];
  const coreRes = makeCoreTopicResolver(CORES);

  it('⛔ 不传大类映射（旧行为）⇒ 文化传媒 认不上 AI应用 ⇒ 误报【首次退潮】（这就是用户报障的现象）', function() {
    const r = detectEbbDay(EBB_CTX, null, HIST);
    expect(r).not.toBeNull();
    expect(r.phase).toBe('first');
    expect(r.phaseTitle).toBe('主线文化传媒首次退潮');
  });

  it('★ 传大类映射 ⇒ 文化传媒 ⇒ AI应用 ⇒ 20 日内已有 2 次事件 ⇒ 不再判退潮', function() {
    expect(detectEbbDay(EBB_CTX, null, HIST, coreRes)).toBeNull();
  });

  it('★ 标题也按大类渲染（不再出现「主线文化传媒」这样的细分串）', function() {
    // 只留 1 次事件（10-14/10-15 合并）+ 别把 10-20 放进来 ⇒ 仍会触发，但标题应写 AI应用
    const hist = HIST.filter(function(r) { return r.date < '2026-10-20'; });
    const r = detectEbbDay(EBB_CTX, null, hist, coreRes);
    expect(r).not.toBeNull();
    expect(r.leaderTopic).toBe('AI应用');
    expect(r.phaseTitle).toContain('AI应用');
    expect(r.phaseTitle).not.toContain('文化传媒');
  });

  it('大类归一也作用在 secondEbbTopicOfPrevDay（昨日二次确认的题材 = 大类名）', function() {
    const r = secondEbbTopicOfPrevDay(HIST, '2026-10-20', coreRes);
    expect(r).not.toBeNull();
    expect(r.topic).toBe('AI应用');
  });
});

describe('tvrb · [CYCLE] 切换日不判退潮（周期状态）', function() {
  const HIST = [
    { date: '2026-10-14', prevDate: '2026-10-13', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-15', prevDate: '2026-10-14', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-19', prevDate: '2026-10-16', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: false },
    { date: '2026-10-20', prevDate: '2026-10-19', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];
  /** 10-22：总龙仍在停牌（占比也塌）——若照旧判，会重开一次退潮事件 */
  function ebbCtxOf() {
    return {
      ready: true, leader: { name: '新华传媒', pct: 214.3, topic: 'AI应用' },
      leaderSuspended: true, leaderShare: 2.0,
      siblingDragons: [{ name: '慈文传媒', rank: 2, isYizi: false, suspended: false }],
      secondInfo: null, prevLeader: null,
      // 退潮替补那两只（用户明确说「不该是九阳 + 冰山」）
      buyPicks: [
        { name: '九阳股份', code: '002242', topic: '大消费', pct: 137, rank20: 2 },
        { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 74.4, rank20: 5 }
      ],
      buyTrail: [],
      top5: [
        { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 214.3, rank20: 1 },
        { name: '九阳股份', code: '002242', topic: '大消费', pct: 137.0, rank20: 2 }
      ],
      newDragonPool: [
        { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 214.3, rank20: 1, mainBoard: true },
        { name: '九阳股份', code: '002242', topic: '大消费', pct: 137.0, rank20: 2, mainBoard: true },
        { name: '慈文传媒', code: '002343', topic: '文化传媒', pct: 85.6, rank20: 3, mainBoard: true },
        { name: '新华文轩', code: '601811', topic: '文化传媒', pct: 79.8, rank20: 4, mainBoard: true },
        { name: '凡拓数创', code: '301313', topic: '数字孪生', pct: 78.5, rank20: 5, mainBoard: false },
        { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 74.4, rank20: 6, mainBoard: true }
      ]
    };
  }
  const CORES = [{ name: 'AI应用', synonyms: ['文化传媒'] }];

  it('★ 切换日 ⇒ plan.ebb 恒 null（即使总龙停牌、占比也不达标）', function() {
    const plan = buildTopicVolRatioPlan([], new Map(), {
      ebbCtx: ebbCtxOf(),
      prevPrevDate: '2026-10-20',
      ebbHistory: HIST,
      top5HistoryEver: new Set(['新华传媒', '九阳股份']),
      coreTopics: CORES
    });
    expect(plan.switchDay).not.toBeNull();
    expect(plan.ebb).toBeNull();                    // ← 核心：切换日不判退潮
    expect(plan.ebbBuy).toBeNull();                 // ← 退潮替补不再输出（用户：「不该是九阳 + 冰山」）
    expect(plan.notes.join('\n')).toContain('今天【不再判退潮】');
  });

  it('★ 非切换日（同一份事实）⇒ 仍判退潮（确认上面那条是【切换日】在生效，不是别的原因）', function() {
    const plan = buildTopicVolRatioPlan([], new Map(), {
      ebbCtx: ebbCtxOf(),
      prevPrevDate: '2026-10-19',                     // ← 换成前两个交易日不是 10-20 ⇒ 不是切换日
      ebbHistory: HIST,
      top5HistoryEver: new Set(['新华传媒', '九阳股份']),
      coreTopics: CORES
    });
    expect(plan.switchDay).toBeNull();
    // 20 日内 2 次事件 ⇒ 无第三次 ⇒ 也不判退潮（这是「无第三次」在生效，与切换日无关）
    expect(plan.ebb).toBeNull();
  });
});

describe('tvrb · [NEW-DRAGON-08] 前八候选 + 只主板 / 非竞价一字 / 非停牌', function() {
  const EVER = new Set(['新华传媒', '九阳股份']);

  function cand(name, code, topic, rank20, over) {
    return Object.assign({
      name: name, code: code, topic: topic, pct: 100 - rank20, rank20: rank20, mainBoard: true
    }, over || {});
  }

  it('★ 前八：第 6 名也能当新龙（前五不够就顺延）', function() {
    const pool = [
      cand('新华传媒', '600825', 'AI应用', 1),
      cand('九阳股份', '002242', '大消费', 2),
      cand('慈文传媒', '002343', '文化传媒', 3),
      cand('新华文轩', '601811', '文化传媒', 4),
      cand('A5', '600005', 'AI应用', 5),
      cand('冰山冷热', '000530', '电子通信算力', 6)
    ];
    const r = pickNewDragon(pool, EVER, {
      oldTopic: 'AI应用', oldLeaderName: '新华传媒', windowDays: 20,
      coreRes: makeCoreTopicResolver([{ name: 'AI应用', synonyms: ['文化传媒'] }])
    });
    expect(r.pick).not.toBeNull();
    expect(r.pick.name).toBe('冰山冷热');
    expect(r.pick.rank20).toBe(6);
  });

  it('★ 非主板（创业板 301xxx）⇒ 排除，继续往下找', function() {
    const pool = [
      cand('新华传媒', '600825', 'AI应用', 1),
      cand('凡拓数创', '301313', '数字孪生', 2, { mainBoard: false }),
      cand('冰山冷热', '000530', '电子通信算力', 3)
    ];
    const r = pickNewDragon(pool, new Set(['新华传媒']), { oldTopic: 'AI应用', oldLeaderName: '新华传媒' });
    expect(r.pick.name).toBe('冰山冷热');
    expect(r.trail.find(function(t) { return t.name === '凡拓数创'; }).reason).toContain('非主板');
  });

  it('★ 竞价一字涨停 ⇒ 买不进，不能作新龙', function() {
    const pool = [
      cand('新华传媒', '600825', 'AI应用', 1),
      cand('一字票', '600066', '机器人', 2, { isYizi: true }),
      cand('冰山冷热', '000530', '电子通信算力', 3)
    ];
    const r = pickNewDragon(pool, new Set(['新华传媒']), { oldTopic: 'AI应用', oldLeaderName: '新华传媒' });
    expect(r.pick.name).toBe('冰山冷热');
    expect(r.trail.find(function(t) { return t.name === '一字票'; }).reason).toContain('一字');
  });

  it('★ 停牌 ⇒ 买不进，不能作新龙', function() {
    const pool = [
      cand('新华传媒', '600825', 'AI应用', 1),
      cand('停牌票', '600067', '机器人', 2, { suspended: true }),
      cand('冰山冷热', '000530', '电子通信算力', 3)
    ];
    const r = pickNewDragon(pool, new Set(['新华传媒']), { oldTopic: 'AI应用', oldLeaderName: '新华传媒' });
    expect(r.pick.name).toBe('冰山冷热');
    expect(r.trail.find(function(t) { return t.name === '停牌票'; }).reason).toContain('停牌');
  });

  it('★ 题材按大类认亲：文化传媒 = AI应用 ⇒ 同题材排除', function() {
    const pool = [
      cand('新华传媒', '600825', '文化传媒', 1),
      cand('慈文传媒', '002343', '文化传媒', 2)
    ];
    const r = pickNewDragon(pool, new Set(), {
      oldTopic: 'AI应用', oldLeaderName: '别的票',
      coreRes: makeCoreTopicResolver([{ name: 'AI应用', synonyms: ['文化传媒'] }])
    });
    expect(r.pick).toBeNull();
    expect(r.trail.every(function(t) { return !t.picked; })).toBe(true);
  });

  it('⛔ mainBoard / isYizi / suspended 缺省 ⇒ 不据此排除（§11 老调用方零行为变化）', function() {
    const pool = [{ name: '新票', code: '', topic: '机器人', pct: 50, rank20: 1 }];
    const r = pickNewDragon(pool, new Set(), { oldTopic: 'AI应用' });
    expect(r.pick).not.toBeNull();
    expect(r.pick.name).toBe('新票');
  });
});

describe('tvrb · [SWITCH-DEDUPE] 买点侧同名去重（新龙优先）', function() {
  function hiBlock(topic, rank, names) {
    const members = names.map(function(n, i) {
      return m(n, { aucVolRatio: 60 - i, pct: 60 - i, code: '6000' + (i + 1) });
    });
    return block(topic, rank, members);
  }
  const HIST = [
    { date: '2026-10-14', prevDate: '2026-10-13', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true },
    { date: '2026-10-20', prevDate: '2026-10-19', leaderStock: '新华传媒', leaderTopic: 'AI应用', ebb: true }
  ];

  it('★ 冰山冷热同时落在【新龙】与常规题材里 ⇒ 常规块里那一只被剔除，只出现一次', function() {
    const topics = [
      hiBlock('AI应用', 1, ['新华传媒', '慈文传媒', 'A3', 'A4', 'A5', 'A6']),
      hiBlock('电子通信算力', 2, ['冰山冷热', 'C2', 'C3', 'C4', 'C5']),
      hiBlock('工业4.0', 3, ['宁波东力', 'D2', 'D3', 'D4', 'D5'])
    ];
    const dm = rankDragonsWithPctMap(topics, null);
    const plan = buildTopicVolRatioPlan(topics, dm, {
      ebbCtx: {
        ready: false,
        top5: [],
        newDragonPool: [
          { name: '新华传媒', code: '600825', topic: 'AI应用', pct: 214.3, rank20: 1, mainBoard: true },
          { name: '冰山冷热', code: '000530', topic: '电子通信算力', pct: 87.2, rank20: 2, mainBoard: true }
        ]
      },
      prevPrevDate: '2026-10-20',
      ebbHistory: HIST,
      top5HistoryEver: new Set(['新华传媒']),
      top5HistoryDays: 20
    });
    expect(plan.newDragon.picks.map(function(p) { return p.name; })).toEqual(['冰山冷热']);
    // 常规侧：老题材与新龙题材都被跳过 ⇒ 只剩工业4.0
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].picks[0].name).toBe('宁波东力');
    // 买点侧全局不重复
    const all = [];
    plan.blocks.forEach(function(b) { (b.picks || []).forEach(function(p) { all.push(p.name); }); });
    (plan.newDragon.picks || []).forEach(function(p) { all.push(p.name); });
    expect(all.filter(function(n) { return n === '冰山冷热'; })).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ 第二十九条 · 十日涨幅 · 在列次数候补（2026-10-24 用户口径）
//
// 用户原话（见 topic-vol-ratio-rules.js 里 RANGE10_BACKUP_TAG 上方那一段逐字注释）。
// 本组用例钉住六件事：
//   ① 排名【第二】的题材量比 < 25 ⇒ 整块作废（不列股票）+ 出候补那一只；
//   ② 排名【第一】的题材量比 < 25 ⇒ 空仓标语【保留】+ 灰化照旧 + 另外给一只候补（用户四答之①）；
//   ③ 候补票 = 十日涨幅前十 · 首次在列 · 与 20日涨幅总龙一不同题材（例 10-20 海洋王）；
//   ④ 选不出候补 ⇒ 不出那一行，说明区如实写「空仓 / 判不出」（§10）；
//   ⑤ 优先级：退潮兜底 / 切换日 / 分歧日 ⇒ 本规则一律不生效（⛔ 不许两条同时输出买点）；
//   ⑥ §10：在列次数没读到 ⇒ 【不作废】题材、不出候补，只留一条说明。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · 第二十九条 十日涨幅 · 在列次数候补', function() {
  /** 4 只同量比的题材（avgVolRatio 可控） */
  function topic4(name, rank, vr, codeBase) {
    const names = [name + '一', name + '二', name + '三', name + '四'];
    const ms = names.map(function(n, i) {
      return m(n, { aucVolRatio: vr, aucShare: 6, code: String(codeBase + i).padStart(6, '0') });
    });
    return { b: block(name, rank, ms), names: names };
  }

  /** 题材量比充足的「强题材」+ 量比 7.47 的「房地产」（10-20 的真实数值） */
  function twoTopics(secondVr) {
    const a = topic4('强题材', 1, 60, 600100);
    const b = topic4('房地产', 2, secondVr === undefined ? 7.47 : secondVr, 600200);
    const dm = new Map();
    a.names.concat(b.names).forEach(function(n, i) {
      dm.set(n, { rank: (i % 4) + 1, topic: '', groupSize: 0, pct: 20 });
    });
    return { topics: [a.b, b.b], dm: dm, first: a, second: b };
  }

  /** 十日涨幅池（含 10-20 的真实票：海洋王 = 首次在列、LED ≠ 文化传媒） */
  const POOL = [
    { name: '九阳股份', code: '002242', topic: '家电', pct: 80.99 },
    { name: '慈文传媒', code: '002343', topic: 'AI视频', pct: 79.20 },
    { name: '新华传媒', code: '600825', topic: '文化传媒', pct: 61.43 },
    { name: '冰山冷热', code: '000530', topic: '冰雪产业', pct: 56.81 },
    { name: '吉大正元', code: '003029', topic: 'AI应用', pct: 48.00 },
    { name: '莱美药业', code: '300006', topic: '医药', pct: 46.23 },
    { name: '百洋股份', code: '002696', topic: '水产品', pct: 45.07 },
    { name: '海洋王', code: '002724', topic: 'LED', pct: 29.51 },
    { name: '京城股份', code: '600860', topic: '机器人概念', pct: 27.26 },
    { name: '东安动力', code: '600178', topic: '飞行汽车', pct: 25.10 },
    { name: '金奥博', code: '002917', topic: '并购重组', pct: 23.96 }
  ];
  const CNT = {
    九阳股份: 9, 慈文传媒: 6, 新华传媒: 8, 冰山冷热: 4, 吉大正元: 2, 莱美药业: 4,
    百洋股份: 6, 海洋王: 1, 京城股份: 1, 东安动力: 1, 金奥博: 4
  };
  function presence(cntObj) {
    const counts = new Map();
    Object.keys(cntObj).forEach(function(k) { counts.set(k, { cnt: cntObj[k] }); });
    return { counts: counts, coveredDays: 10 };
  }
  /** 20日涨幅总龙一（新华传媒 · 文化传媒/AI应用 大类）+ 非退潮（占比达标、不停牌） */
  function ebbCtxOf(top1Topic) {
    return {
      ready: true,
      leader: { name: '新华传媒', topic: top1Topic || '文化传媒', pct: 202.59 },
      leaderSuspended: false,
      leaderShare: 9,
      top5: [{ name: '新华传媒', topic: top1Topic || '文化传媒', pct: 202.59, rank20: 1 }],
      newDragonPool: [],
      siblingDragons: [],
      secondInfo: null
    };
  }

  it('★ 10-20：房地产（量比 7.47）整块作废 ⇒ 候补换成海洋王（首次在列 · 主板第 7 名）', function() {
    const f = twoTopics();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: presence(CNT),
      ebbCtx: ebbCtxOf()
    });
    // ① 第二题材整块作废：不在 blocks 里，buy.light 也必须是 null（⛔ 不留悬空槽位）
    expect(plan.blocks.map(function(b) { return b.block.topic; })).toEqual(['强题材']);
    expect(plan.buy.light).toBeNull();
    // ② 候补那一只 = 海洋王
    expect(plan.range10Backup).toBeTruthy();
    expect(plan.range10Backup.picks.map(function(p) { return p.name; })).toEqual(['海洋王']);
    expect(plan.buy.range10Backup).toBe(plan.range10Backup);
    // ③ 专属标签 + 徽标（十日涨幅第 7 名 / 首次在列）
    expect(plan.range10Backup.picks[0].buyActionTag).toBe(RANGE10_BACKUP_TAG);
    expect(plan.range10Backup.picks[0].buyActionTone).toBe(RANGE10_BACKUP_TONE);
    expect(plan.range10Backup.picks[0].range10Label).toContain('第 7 名');
    expect(plan.range10Backup.picks[0].range10Label).toContain('首次在列');
    expect(plan.range10Backup.picks[0].dragonLabel).toBe('');   // ⛔ 不冒充题材龙位
    expect(plan.range10Backup.ruleNo).toBe(RANGE10_BACKUP_RULE_NO);
    // ④ 进买点名单（卖点侧才会判「持有」而不是「竞价清仓」）
    expect(plan.buyNames.has('海洋王')).toBe(true);
    // ⑤ 选股总数 = 强题材 1 只 + 候补 1 只
    expect(plan.pickCount).toBe(2);
    // ⑥ 说明区写清「作废 + 替换」
    const notes = plan.notes.join('\n');
    expect(notes).toContain('房地产');
    expect(notes).toContain('7.47');
    expect(notes).toContain('海洋王');
    // ⛔ 不再报「当日只有 1 个题材满足条件」——那是另一件事
    expect(notes).not.toContain('当日只有 1 个题材满足条件');
  });

  it('★ 第一题材量比也 < 25 ⇒ 空仓标语【保留】+ 灰化照旧 + 另给一只候补', function() {
    const f = twoTopics(60);   // 第二题材量比 60 ⇒ 不作废
    // 把第一题材的量比压到 10
    f.topics[0].members.forEach(function(x) { x.aucVolRatio = 10; });
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: presence(CNT),
      ebbCtx: ebbCtxOf()
    });
    expect(plan.blocks).toHaveLength(2);                 // 两个题材都照常列出
    expect(plan.cashAlert.show).toBe(true);              // 空仓标语【不撤】
    expect(plan.cashAlert.detail).toContain('另有 1 只十日周期候补');
    expect(plan.cashAlert.hasRange10Backup).toBe(true);
    // 常规块被灰化改写（第十六条照旧），候补那一行是今天唯一还能买的
    expect(plan.blocks[0].picks[0].buyActionTag).toBe(CASH_NO_BUY_TAG);
    expect(plan.range10Backup.picks[0].buyActionTag).toBe(RANGE10_BACKUP_TAG);
  });

  it('§10：选不出候补 ⇒ 不出那一行，说明区如实写「空仓」（⛔ 不留空壳）', function() {
    const f = twoTopics();
    const allThree = {};
    Object.keys(CNT).forEach(function(k) { allThree[k] = 5; });
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: presence(allThree),
      ebbCtx: ebbCtxOf()
    });
    expect(plan.range10Backup).toBeNull();
    expect(plan.buy.range10Backup).toBeNull();
    const notes = plan.notes.join('\n');
    expect(notes).toContain('没有候补');
    expect(notes).toContain('空仓');
    expect(plan.buyNames.has('海洋王')).toBe(false);
  });

  it('§10：在列次数没读到 ⇒ 【不作废】第二题材、不出候补，只留一条说明', function() {
    const f = twoTopics();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: null,       // 数据未到
      ebbCtx: ebbCtxOf()
    });
    expect(plan.blocks).toHaveLength(2);            // ⛔ 不因为一次数据缺口白扔一个题材
    expect(plan.blocks[1].block.topic).toBe('房地产');
    expect(plan.range10Backup).toBeNull();
    expect(plan.notes.join('\n')).toContain('暂不作废');
  });

  // ★★ [R10-STOCK-LEVEL 2026-10-24 用户口径 · 第二次修正] 本规则是【股票级通道】：
  //   「这个 10 日涨幅和 20 日涨幅排名，是【选股票】，前者（题材量比）是【选题材】」——
  //   题材块灰化 / 作废是【题材级】结论，⛔ 不否决这条股票级通道：
  //   同一只票可以在上方灰化块里重复出现一次（用户：「上面是重复出现的兆威机电也是逻辑」）。
  const POOL_1023 = [
    { name: '海洋王', code: '002724', topic: 'LED', pct: 80.53 },
    { name: '慈文传媒', code: '002343', topic: 'AI视频', pct: 79.11 },
    { name: '冰山冷热', code: '000530', topic: '冰雪产业', pct: 78.80 },
    { name: '大业股份', code: '603278', topic: '机器人概念', pct: 58.02 },
    { name: '九阳股份', code: '002242', topic: '家电', pct: 42.30 },
    { name: '百洋股份', code: '002696', topic: '水产品', pct: 40.03 },
    { name: '福莱新材', code: '605488', topic: '灵巧手', pct: 36.79 },
    { name: '兆威机电', code: '003021', topic: '灵巧手', pct: 32.79 },
    { name: '宁波东力', code: '002164', topic: '机器人概念', pct: 30.93 },
    { name: '吉大正元', code: '003029', topic: 'AI应用', pct: 28.63 },
    { name: '上海九百', code: '600838', topic: '零售', pct: 26.44 }
  ];
  const CNT_1023 = {
    海洋王: 3, 慈文传媒: 8, 冰山冷热: 7, 大业股份: 4, 九阳股份: 8, 百洋股份: 9,
    福莱新材: 3, 兆威机电: 1, 宁波东力: 3, 吉大正元: 5, 上海九百: 1
  };
  /** 10-23 真实场景：只有一个入选题材【工业4.0】，平均量比 15.18（< 25） */
  function industrial40() {
    const ms = [
      m('兆威机电', { aucVolRatio: 15.18, aucShare: 6, code: '003021' }),
      m('大业股份', { aucVolRatio: 15.18, aucShare: 5, code: '603278' }),
      m('宁波东力', { aucVolRatio: 15.18, aucShare: 4, code: '002164' }),
      m('福莱新材', { aucVolRatio: 15.18, aucShare: 3, code: '605488' })
    ];
    const dm = new Map();
    ms.forEach(function(x, i) { dm.set(x.name, { rank: i + 1, topic: '工业4.0', groupSize: 4, pct: 20 }); });
    return { topics: [block('工业4.0', 1, ms)], dm: dm };
  }

  it('★★ 10-23：工业4.0（量比 15.18 < 25）整块灰化空仓，但兆威机电仍被选为十日涨幅候补', function() {
    const f = industrial40();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL_1023,
      range10Presence: presence(CNT_1023),
      ebbCtx: ebbCtxOf()          // 总龙一 = 新华传媒（文化传媒）
    });
    // ① 题材级结论【不变】：工业4.0 那块照旧列出、照旧灰化空仓（⛔ 不因为出了候补就恢复它）
    expect(plan.cashAlert.show).toBe(true);
    const names = plan.blocks[0].picks.map(function(p) { return p.name; });
    expect(names).toContain('兆威机电');                                  // 灰化块里仍然展示这只票
    plan.blocks[0].picks.forEach(function(p) {
      expect(p.buyActionTag).toBe(CASH_NO_BUY_TAG);                       // 一律「不开新仓」
    });
    // ② 股票级通道照常生效：兆威机电 = 十日涨幅第 8 名 + 首次在列 + 灵巧手 ≠ 文化传媒
    expect(plan.range10Backup).toBeTruthy();
    expect(plan.range10Backup.picks.map(function(p) { return p.name; })).toEqual(['兆威机电']);
    expect(plan.range10Backup.picks[0].buyActionTag).toBe(RANGE10_BACKUP_TAG);
    expect(plan.range10Backup.picks[0].range10Label).toContain('首次在列');
    expect(plan.buy.range10Backup).toBe(plan.range10Backup);
    // ③ 说明区必须点明「同一只票重复出现是设计如此」+ 题材块灰化不恢复
    const notes = plan.range10Backup.notes.join('\n');
    expect(notes).toContain('重复出现');
    expect(notes).toContain('工业4.0');
    expect(plan.range10Backup.picks[0].actionNote).toContain('工业4.0');
    expect(plan.range10Backup.reason).toContain('股票级');
    // ④ 空仓标语里那句话不能自相矛盾（候补票本身就在第一题材里）
    expect(plan.cashAlert.detail).toContain('这只候补除外');
    // ⑤ 进了买点名单（卖点侧才会按「今日要买」处理）
    expect(plan.buyNames.has('兆威机电')).toBe(true);
  });

  it('⛔ 今日【确实要买】的票不重复选（灰化的才算「不占用名额」）', function() {
    // 场景：第二题材 房地产（7.47）作废 ⇒ 触发候补；而排名第一的【强题材】量比 60 达标，
    //   ⇒ 它的票是【今天真要买的】，⛔ 不能被候补再选一次。
    const f = twoTopics();
    const pool = [{ name: '强题材一', code: '600100', topic: '强题材', pct: 99 }].concat(POOL);
    const cnt = Object.assign({}, CNT, { 强题材一: 1 });   // 前十第 1 名 + 首次在列（如果不排除就会被选走）
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: pool,
      range10Presence: presence(cnt),
      ebbCtx: ebbCtxOf()
    });
    expect(plan.blocks[0].picks[0].name).toBe('强题材一');       // 它确实是今日买点
    expect(plan.range10Backup.picks[0].name).not.toBe('强题材一');
    expect(plan.range10Backup.picks[0].name).toBe('海洋王');
    expect(plan.range10Backup.picks[0].actionNote).not.toContain('重复出现');
  });

  it('★ 被整块作废的题材里的票：只要它自己是【首次在列】且 ≠ 总龙一题材，仍可当选候补', function() {
    // 用户口径：「题材选不了，但从总市场中选股（非选题材）」—— 题材级作废 ≠ 这只票被禁买，
    //   只要股票自己的三个条件成立就仍然可以当选（说明区会交代它来自刚被作废的那块）。
    const f = twoTopics();
    const pool = [{ name: '房地产一', code: '600200', topic: '房地产', pct: 99 }].concat(POOL);
    const cnt = Object.assign({}, CNT, { 房地产一: 1 });
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: pool,
      range10Presence: presence(cnt),
      ebbCtx: ebbCtxOf()
    });
    expect(plan.blocks.map(function(b) { return b.block.topic; })).toEqual(['强题材']);  // 题材块照旧作废
    expect(plan.range10Backup.picks[0].name).toBe('房地产一');
    expect(plan.range10Backup.picks[0].actionNote).toContain('整块作废');
    expect(plan.range10Backup.notes.join('\n')).toContain('重复出现');
  });

  it('§11：调用方没传十日涨幅池 ⇒ 与旧行为逐字一致（不作废、不出候补、不加说明）', function() {
    const f = twoTopics();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, { ebbCtx: ebbCtxOf() });
    expect(plan.blocks).toHaveLength(2);
    expect(plan.range10Backup).toBeNull();
    expect(plan.notes.join('\n')).not.toContain('十日涨幅候补');
  });

  // ★★ [R10-POOL 2026-10-24] 池子完整性闸门 —— 10-23 事故（选到上海九百）的直接防线：
  //   采集层发现「20天补位行还没就绪」时会传 range10Complete=false，此时名次与屏幕对不上
  //   ⇒ 规则层必须【判不出】（既不选票、也不作废题材），⛔ 绝不能拿错位的名次当真。
  it('§10：池子与屏幕对不上（补位行未就绪）⇒ 【不作废】题材、不出候补，且说明缺口', function() {
    const f = twoTopics();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Complete: false,       // ← 采集层：补位数据未就绪
      range10Presence: presence(CNT),
      ebbCtx: ebbCtxOf()
    });
    // ⛔ 数据缺口 ≠ 判决：房地产（7.47）不许因此被作废
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks[1].block.topic).toBe('房地产');
    expect(plan.range10Backup).toBeNull();
    expect(plan.buy.range10Backup).toBeNull();
    const notes = plan.notes.join('\n');
    expect(notes).toContain('暂不作废');
    expect(notes).toContain('补位行');
  });

  // ★★ [R10-GATE 2026-10-24] 「必须与 20日涨幅总龙一不同题材」是用户四个条件之一：
  //   总龙一都不知道时，这道闸门根本没被验证过 ⇒ ⛔ 不许放行（旧版传空 = 放行，属于静默猜测）。
  it('§10：20日涨幅总龙一未就绪 ⇒ 候补【不猜】，说明区写明原因', function() {
    const f = twoTopics();
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: presence(CNT),
      ebbCtx: null                   // ← 总龙一（ebbCtx.top5[0]）不知道
    });
    // 第二题材量比 7.47 仍照常作废（这条判据不依赖总龙一），但候补给不出来
    expect(plan.blocks).toHaveLength(1);
    expect(plan.range10Backup).toBeNull();
    const notes = plan.notes.join('\n');
    expect(notes).toContain('判不出候补');
    expect(notes).toContain('总龙一');
    expect(notes).not.toContain('本次【没有候补】');   // 措辞要区分「判不出」与「确实没有」
  });

  it('优先级：退潮兜底日（首次退潮）⇒ 本规则不生效', function() {
    const f = twoTopics();
    const ctx = ebbCtxOf();
    ctx.leaderSuspended = true;      // 总龙停牌 ⇒ 退潮日
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: POOL,
      range10Presence: presence(CNT),
      ebbCtx: ctx
    });
    expect(plan.ebb).toBeTruthy();
    expect(plan.range10Backup).toBeNull();
    expect(plan.blocks).toHaveLength(2);   // 退潮日只灰化，不作废
  });

  it('候补票必须与 20日涨幅总龙一【不同题材】（大类归一后仍同类 ⇒ 跳过）', function() {
    const f = twoTopics();
    // 把海洋王 认成「文化传媒」（= 总龙一 的细分题材）⇒ 必须被剔除，选下一只首次在列
    const pool = POOL.map(function(p) {
      return p.name === '海洋王' ? Object.assign({}, p, { topic: '文化传媒' }) : p;
    });
    const plan = buildTopicVolRatioPlan(f.topics, f.dm, {
      range10Rows: pool,
      range10Presence: presence(CNT),
      ebbCtx: ebbCtxOf()
    });
    expect(plan.range10Backup).toBeTruthy();
    expect(plan.range10Backup.picks[0].name).toBe('京城股份');
    expect(plan.range10Backup.notes.join('\n')).toContain('海洋王');
    expect(plan.range10Backup.notes.join('\n')).toContain('同题材');
  });

  it('规则手册里有第二十九条，且写明门槛 / 优先级 / 十日周期', function() {
    const lines = buildTvrbRulesLines();
    const line = lines.filter(function(s) { return s.indexOf('二十九、【十日涨幅 · 在列次数候补】') === 0; })[0];
    expect(line).toBeTruthy();
    expect(line).toContain(String(TVRB_CASH_ALERT_AVG_VR));
    expect(line).toContain('首次在列');
    expect(line).toContain('二次在列');
    expect(line).toContain('海洋王');
    expect(line).toContain(RANGE10_BACKUP_TAG);
  });
});
