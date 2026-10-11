// topic-vol-ratio-rules.test.js — 「题材量比」看板纯规则的单元测试
//
// 覆盖用户 2026-10-11 给出的口径与举例：
//   · 档位边界：< 4 只不入选 / 4~8 只取 1 只 / > 8 只取 2 只；
//   · 平均竞价量比（含灰行、全缺值 → null）；
//   · 举例：机器人 3 只（排 1）排除 → AI应用 5 只（排 2，取 1）→ 大消费 10 只（排 3，取 2）；
//   · 龙位顺延：龙一竞价涨停 ⇒ 看龙二（⛔ 与决策看板「占名次不递补」不同，本看板要顺延）；
//   · 无龙位（创业板 / 科创板）的成员不进候选。

import { describe, it, expect } from 'vitest';
import {
  TVRB_MIN_COUNT,
  TVRB_MID_MAX,
  TVRB_PICK_MID,
  TVRB_PICK_BIG,
  TVRB_TOPIC_LIMIT,
  resolveTvrbTier,
  avgVolRatioOf,
  formatAvgVolRatio,
  buildTopicVolRatioPlan,
  buildTvrbRulesLines
} from './topic-vol-ratio-rules.js';

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

// ── 规则文案 ─────────────────────────────────────────────────────────────────────────────
describe('tvrb · buildTvrbRulesLines 规则文案', function() {
  const lines = buildTvrbRulesLines();

  it('是逐行数组，且条数 ≥ 5', function() {
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    lines.forEach(function(l) { expect(typeof l).toBe('string'); });
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
});
