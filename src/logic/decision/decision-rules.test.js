// decision-rules.test.js — 「决策」看板规则回归用例
//
// 钉住三件事（后期改规则时先看这里）：
//   ① 题材排名必须与早盘竞价「题材 toggle」同源（复用 sortByTopicGroups，不另写比较器）；
//   ② 买点必须【跳过竞价一字】再按龙头顺序取（一字买不进）；
//   ③ 卖点时点：题材排前二 → 14:50，否则 → 11:20。
//
// ⚠️ 题材名刻意用 T1/T2/T3：组序的兜底比较是【题材名升序】，中文名按 Unicode 码点排
//    （实测「丙」<「乙」，肉眼极易看错），用 ASCII 名才能让用例意图一目了然。

import { describe, it, expect } from 'vitest';
import {
  rankDecisionTopics,
  rankDragons,
  pickBuyable,
  pickLadder,
  buildBuyPlan,
  buildSellPlan,
  buildRulesLines,
  formatRangePct,
  SELL_TIME_CLOSE,
  SELL_TIME_MIDDAY,
  POSITION_HEAVY,
  POSITION_LIGHT
} from './decision-rules.js';
import { getDragonLabel } from '../auction/dragon-rank.js';

/** E(股票名, 题材, 十日涨幅, 是否竞价一字, 是否计入数量, 当日竞价涨幅%) */
function E(name, topic, pct, isYizi, countable, aucPct) {
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: !!isYizi,
    countable: countable !== false,
    aucPct: (aucPct === undefined || aucPct === null) ? null : aucPct
  };
}

describe('rankDecisionTopics', () => {
  it('组序 = 一字多的题材在前（与早盘竞价同一口径）', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 10), E('a2', 'T1', 9, true), E('a3', 'T1', 8, true),
      E('b1', 'T2', 5), E('b2', 'T2', 4)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T1', 'T2']);
    expect(blocks[0].rank).toBe(1);
    expect(blocks[0].yiziCount).toBe(2);
    expect(blocks[0].count).toBe(3);
  });

  it('一字相同 → 人多的题材在前', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 1), E('a2', 'T1', 2),
      E('b1', 'T2', 3), E('b2', 'T2', 4), E('b3', 'T2', 5)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T1']);
  });

  it('一字与人头都相同 → 题材名升序（ASCII 名保证确定性）', () => {
    const blocks = rankDecisionTopics([
      E('x1', 'T3', 1), E('x2', 'T3', 2),
      E('y1', 'T2', 3), E('y2', 'T2', 4)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T3']);
  });

  it('「其它」与不足 2 只的题材都排除', () => {
    const blocks = rankDecisionTopics([
      E('x1', '其它', 1), E('x2', '其它', 2),
      E('y1', '孤儿', 3),
      E('z1', '成组', 4), E('z2', '成组', 5)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['成组']);
  });

  it('countable=false 的行不计数（数量 / 一字都不算）但仍留在组里', () => {
    // a3 是「昨日卖标签继承」的复盘行：不计入数量与一字，可是仍然渲染在该题材组里
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 1), E('a2', 'T1', 2, true), E('a3', 'T1', 3, true, false)
    ]);
    expect(blocks.length).toBe(1);
    expect(blocks[0].count).toBe(2);
    expect(blocks[0].yiziCount).toBe(1);
    expect(blocks[0].members.length).toBe(3);
  });

  it('可计数的不足 2 只 → 不成题材（口径与早盘竞价统计条一致）', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 1), E('a2', 'T1', 2, false, false)
    ]);
    expect(blocks.length).toBe(0);
  });
});

describe('pickBuyable（跳过一字）', () => {
  it('龙一是一字 → 跳过，买龙二 + 龙三', () => {
    const blocks = rankDecisionTopics([
      E('龙一', 'T1', 30, true), E('龙二', 'T1', 20), E('龙三', 'T1', 10)
    ]);
    const picks = pickBuyable(blocks[0], rankDragons(blocks), 2, POSITION_HEAVY);
    expect(picks.map(p => p.name)).toEqual(['龙二', '龙三']);
    expect(picks[0].dragonLabel).toBe('龙二');
  });

  it('龙一非一字 → 就是买龙一，再补下一只非一字', () => {
    const blocks = rankDecisionTopics([
      E('龙一', 'T1', 30), E('二字', 'T1', 20, true), E('龙三', 'T1', 10)
    ]);
    const picks = pickBuyable(blocks[0], rankDragons(blocks), 2, POSITION_HEAVY);
    expect(picks.map(p => p.name)).toEqual(['龙一', '龙三']);
  });
});

describe('pickLadder（龙二～龙五的高开票 → 轻仓）', () => {
  // 按十日涨幅排：一=龙一、二=龙二…六=龙六
  const blocks = rankDecisionTopics([
    E('一', 'T1', 90, false, true, 5),     // 龙一：不在龙二~龙五范围
    E('二', 'T1', 80, true, true, 9),      // 龙二：竞价一字 → 买不进
    E('三', 'T1', 70, false, true, 3),     // 龙三：高开 → 入选
    E('四', 'T1', 60, false, true, -2),    // 龙四：低开（≤0）→ 淘汰
    E('五', 'T1', 50, false, true, null),  // 龙五：缺竞价涨幅 → 计入 unknownCount，不入选
    E('六', 'T1', 40, false, true, 8)      // 龙六：超出龙五 → 淘汰
  ]);
  const dragon = rankDragons(blocks);

  it('只收「龙二到龙五 + 非一字 + 竞价涨幅>0」', () => {
    const r = pickLadder(blocks[0], dragon, new Set(), POSITION_LIGHT);
    expect(r.picks.map(p => p.name)).toEqual(['三']);
    expect(r.picks[0].dragonLabel).toBe('龙三');
    expect(r.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('缺竞价涨幅 → 不当高开也不静默丢掉，如实记 unknownCount', () => {
    const r = pickLadder(blocks[0], dragon, new Set(), POSITION_LIGHT);
    expect(r.unknownCount).toBe(1);
  });

  it('已被重仓挑走的股票不会被重复选成轻仓', () => {
    const r = pickLadder(blocks[0], dragon, new Set(['三']), POSITION_LIGHT);
    expect(r.picks).toEqual([]);
  });
});

describe('buildBuyPlan', () => {
  // T1：2 个一字（排名第一）；T2 / T3：0 个一字，各 2 只 → T2 排第二、T3 排第三
  const entries = [
    E('一字A', 'T1', 40, true), E('一字B', 'T1', 39, true), E('可买C', 'T1', 30), E('可买D', 'T1', 20),
    E('T2一', 'T2', 10), E('T2二', 'T2', 9),
    E('T3一', 'T3', 5), E('T3二', 'T3', 4)
  ];

  it('第 1 名题材一字≥2 → 重仓 2 只；第 2 名题材 → 轻仓 1 只', () => {
    const blocks = rankDecisionTopics(entries);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.block.topic).toBe('T1');
    expect(plan.heavy.mode).toBe('double');
    expect(plan.heavy.qualified).toBe(true);
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['可买C', '可买D']);
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    expect(plan.heavy.picks[1].position).toBe(POSITION_HEAVY);
    expect(plan.light.block.topic).toBe('T2');
    expect(plan.light.picks.length).toBe(1);
    expect(plan.light.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('第 1 名题材【只有 1 个一字】→ 龙一重仓 + 龙二~龙五高开票轻仓，序号连续', () => {
    const blocks = rankDecisionTopics([
      E('A龙一', 'T1', 50, false, true, 4),   // 龙一 非一字 → 重仓
      E('B一字', 'T1', 45, true, true, 10),   // 龙二 = 那唯一的一字 → 买不进
      E('C龙三', 'T1', 40, false, true, 2),   // 龙三 高开 → 轻仓
      E('D龙四', 'T1', 30, false, true, -3),  // 龙四 低开 → 不入选
      E('E龙五', 'T1', 20, false, true, 1),   // 龙五 高开 → 轻仓
      E('T2一', 'T2', 10), E('T2二', 'T2', 9)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.mode).toBe('single');
    expect(plan.heavy.qualified).toBe(true);
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['A龙一', 'C龙三', 'E龙五']);
    expect(plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT, POSITION_LIGHT]);
    expect(plan.heavy.picks.map(p => p.seq)).toEqual([1, 2, 3]);
    // 第 2 名题材那只仍然是轻仓、且独立成块
    expect(plan.light.picks.length).toBe(1);
    expect(plan.light.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('缺竞价涨幅的股票不入选轻仓，但会如实说明有几只未纳入', () => {
    const blocks = rankDecisionTopics([
      E('A龙一', 'T1', 50, false, true, 4),
      E('B一字', 'T1', 45, true, true, 10),
      E('C缺', 'T1', 40, false, true, null),  // 缺竞价涨幅 → 不能当高开
      E('D龙四', 'T1', 30, false, true, 2),
      E('T2一', 'T2', 10), E('T2二', 'T2', 9)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['A龙一', 'D龙四']);
    expect(plan.heavy.notes.join('｜')).toContain('缺竞价涨幅');
    expect(plan.heavy.notes.join('｜')).toContain('1 只');
  });

  it('第 1 名题材一字 0 个 → 不达门槛，只展示数据不给建议', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 10), E('a2', 'T1', 9), E('a3', 'T1', 8),
      E('b1', 'T2', 5), E('b2', 'T2', 4)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.mode).toBe('none');
    expect(plan.heavy.qualified).toBe(false);
    expect(plan.heavy.picks.length).toBe(0);
    expect(plan.heavy.notQualifiedText).toContain('未达买入条件');
  });

  it('理由文案：题材排第几 + 股票数量 + 一字数', () => {
    const blocks = rankDecisionTopics(entries);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.reason).toBe('题材排第一，股票数量4只，2个竞价一字');
    expect(plan.light.reason).toBe('题材排第二，股票数量2只，0个竞价一字');
  });
});

describe('buildSellPlan', () => {
  // T1 排第一（2 个一字）、T2 排第二、T3 排第三
  const blocks = rankDecisionTopics([
    E('T1一', 'T1', 30, true), E('T1二', 'T1', 20, true), E('T1三', 'T1', 10),
    E('T2一', 'T2', 9), E('T2二', 'T2', 8),
    E('T3一', 'T3', 5), E('T3二', 'T3', 4)
  ]);
  const dragon = rankDragons(blocks);

  it('题材排第一 / 第二 → 14:50 卖', () => {
    const plan = buildSellPlan(
      [{ name: 'T1三', topic: 'T1', pct: 10, inTodayList: true },
       { name: 'T2一', topic: 'T2', pct: 9, inTodayList: true }],
      blocks, dragon, new Set(['T1三'])
    );
    expect(plan.map(g => g.topic)).toEqual(['T1', 'T2']);
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_CLOSE);
    expect(plan[0].reason).toContain('14:50卖');
    expect(plan[1].items[0].sellAt).toBe(SELL_TIME_CLOSE);
  });

  it('题材排名第 3（不在前二）+ 昨日龙头 → 11:20 卖，理由写明「但昨日是龙头」', () => {
    const plan = buildSellPlan(
      [{ name: 'T3一', topic: 'T3', pct: 5, inTodayList: true }],
      blocks, dragon, new Set(['T3一'])
    );
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_MIDDAY);
    expect(plan[0].reason).toContain('题材排不在第一，第二');
    expect(plan[0].reason).toContain('但昨日是龙头（十日涨幅最高）');
    expect(plan[0].reason).toContain('11:20卖');
  });

  // === [2026-09-24 例外] 题材排第 2 且只有 1 个竞价一字 → 组内时点分裂 ===
  // T1：2 个一字 → 第 1 名；T2：1 个一字 → 第 2 名；T3：0 个一字 → 第 3 名
  // T2 内按十日涨幅：榜一=龙一、一字那位=龙二、老三=龙三
  const blocks2 = rankDecisionTopics([
    E('T1甲', 'T1', 60, true), E('T1乙', 'T1', 55, true), E('T1丙', 'T1', 50),
    E('T2榜一', 'T2', 40), E('T2一字', 'T2', 35, true), E('T2老三', 'T2', 30),
    E('T3甲', 'T3', 20), E('T3乙', 'T3', 15)
  ]);
  const dragon2 = rankDragons(blocks2);

  it('题材排第 2 且只有 1 个竞价一字 → 龙一 14:50 卖，其余非龙一 11:20 卖', () => {
    const plan = buildSellPlan(
      [{ name: 'T2榜一', topic: 'T2', pct: 40, inTodayList: true },
       { name: 'T2老三', topic: 'T2', pct: 30, inTodayList: true }],
      blocks2, dragon2, new Set()
    );
    expect(plan[0].topic).toBe('T2');
    expect(plan[0].items[0].name).toBe('T2榜一');
    expect(plan[0].items[0].dragonLabel).toBe('龙一');
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_CLOSE);
    expect(plan[0].items[1].name).toBe('T2老三');
    expect(plan[0].items[1].sellAt).toBe(SELL_TIME_MIDDAY);
  });

  it('同上情形：卖出理由要同时写清「龙一 14:50 卖，其余非龙一 11:20 卖」', () => {
    const plan = buildSellPlan(
      [{ name: 'T2榜一', topic: 'T2', pct: 40, inTodayList: true }],
      blocks2, dragon2, new Set()
    );
    expect(plan[0].reason).toContain('只有1个竞价一字涨停');
    expect(plan[0].reason).toContain('龙一' + SELL_TIME_CLOSE + '卖，其余非龙一' + SELL_TIME_MIDDAY + '卖');
  });

  it('例外只在「第 2 名 + 恰好 1 个一字」生效：第 2 名有 2 个一字时整组仍 14:50', () => {
    const blocks3 = rankDecisionTopics([
      E('X1', 'X1', 60, true), E('X2', 'X1', 55, true), E('X3', 'X1', 50, true), // 3 个一字 → 第 1 名
      E('Y1', 'Y2', 40, true), E('Y2', 'Y2', 35, true), E('Y3', 'Y2', 30)        // 2 个一字 → 第 2 名
    ]);
    const dragon3 = rankDragons(blocks3);
    const plan = buildSellPlan(
      [{ name: 'Y3', topic: 'Y2', pct: 30, inTodayList: true }],
      blocks3, dragon3, new Set()
    );
    expect(plan[0].topicRank).toBe(2);
    expect(plan[0].yiziCount).toBe(2);
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_CLOSE); // 不满足例外条件 → 非龙一也拿到尾盘
  });

  it('今日不在列表（题材未成组）→ 11:20 卖，不抛错', () => {
    const plan = buildSellPlan(
      [{ name: '已卖飞', topic: '', pct: null, inTodayList: false }],
      blocks, dragon, new Set()
    );
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_MIDDAY);
    expect(plan[0].reason).toContain('题材今日未成组');
    expect(plan[0].items[0].dragonLabel).toBe('');
  });

  it('昨日龙头名册【未加载】(null) → 时点照给，但理由写「未加载」，⛔ 不退化成「昨日非龙头」', () => {
    const plan = buildSellPlan(
      [{ name: 'T3一', topic: 'T3', pct: 5, inTodayList: true }],
      blocks, dragon, null
    );
    expect(plan[0].items[0].sellAt).toBe(SELL_TIME_MIDDAY);
    expect(plan[0].items[0].isPrevDragon).toBe(null);
    expect(plan[0].reason).toContain('昨日龙头名册未加载');
    expect(plan[0].reason).not.toContain('昨日非龙头');
  });

  it('行内带「龙几」标签与序号', () => {
    const plan = buildSellPlan(
      [{ name: 'T1三', topic: 'T1', pct: 10, inTodayList: true }],
      blocks, dragon, new Set()
    );
    expect(plan[0].items[0].dragonLabel).toBe('龙三');
    expect(plan[0].items[0].seq).toBe(1);
  });
});

describe('buildRulesLines（灰色问号里的规则说明）', () => {
  const lines = buildRulesLines();

  it('规则说明必须覆盖买点三档 + 卖点三档 + 题材行数据口径', () => {
    const text = lines.join('\n');
    expect(text).toContain('竞价一字 ≥ 2');                 // 第 1 名 · 双票重仓
    expect(text).toContain('只有 1 个');                     // 第 1 名 · 龙一重仓
    expect(text).toContain('竞价涨幅 > 0');                  // 龙二~龙五 高开轻仓
    expect(text).toContain('龙二～龙五');
    expect(text).toContain('排名第 2 的题材');               // 第 2 名 · 轻仓
    expect(text).toContain(SELL_TIME_CLOSE);
    expect(text).toContain(SELL_TIME_MIDDAY);
    expect(text).toContain('实心红圆点');                    // 题材行的排名圆点说明
    expect(text).toContain('排第 2');                        // 第 2 名 + 只有 1 个一字的例外
    expect(text).toContain('只有龙一');
  });

  it('规则文案里不再出现「建议」二字（用户要求：直接写重仓/轻仓、几点卖）', () => {
    const text = lines.join('\n');
    expect(text).not.toContain('建议');
  });

  it('文案里的排名区间必须由 getDragonLabel 派生（避免两处分叉）', () => {
    const text = lines.join('\n');
    expect(text).toContain('【' + getDragonLabel(2) + '～' + getDragonLabel(5) + '】');
  });
});

describe('formatRangePct', () => {
  it('有值 → 符号 + 整数百分比', () => {
    expect(formatRangePct(62.87)).toBe('+63%');
    expect(formatRangePct(-3.2)).toBe('-3%');
  });
  it('缺失 → 空串（§10 绝不补 0 / -）', () => {
    expect(formatRangePct(null)).toBe('');
    expect(formatRangePct(undefined)).toBe('');
    expect(formatRangePct('')).toBe('');
  });
});
