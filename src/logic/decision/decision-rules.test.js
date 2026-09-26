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
  buildNoYiziPlan,
  isSmallRiskyTopic,
  buildSmallTopicPlan,
  pickFirstHighOpen,
  pickSecondTopicBuy,
  pickHeavyTwo,
  resolveSecondTopicByLadder,
  BIG_TOPIC_MIN_COUNT,
  buildSellPlan,
  buildRulesLines,
  formatRangePct,
  NO_YIZI_MIN_TOPIC_COUNT,
  SELL_TIME_CLOSE,
  SELL_TIME_MIDDAY,
  POSITION_HEAVY,
  POSITION_LIGHT
} from './decision-rules.js';
import { getDragonLabel } from '../auction/dragon-rank.js';

/** E(股票名, 题材, 十日涨幅, 是否竞价一字, 是否计入数量, 当日竞价涨幅%) */
/**
 * 样本行构造。
 * @param {string} name 股票名
 * @param {string} topic 题材
 * @param {number|null} pct 十日涨幅
 * @param {boolean} [isYizi] 是否竞价一字
 * @param {boolean} [countable] 是否计入题材数量（false = 早盘竞价里「灰色名称 / 灰色题材」的灰行）
 * @param {number|null} [aucPct] 竞价涨幅
 * @param {string} [code] 股票代码（判 20% / 30% 涨跌幅板用）
 * @param {boolean} [inheritSold] 是否「昨日卖标签继承」的复盘行（⛔ 唯一【不参与】龙位与选票的行）
 */
function E(name, topic, pct, isYizi, countable, aucPct, code, inheritSold) {
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: !!isYizi,
    countable: countable !== false,
    code: code || '',
    inheritSold: inheritSold === true,
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

// === [NOT-FORMAL-DRAGON 2026-09-25] 龙一 / 龙二 的位次口径 ===
// 事故现场：9/16 电子/通信/算力 真龙一 = 超声电子（低开）、龙二 = 澳弘电子（高开），
//   决策看板却把「高开的那只」判成龙一；9/17 真龙二 = 超声电子（低开）被判成高开。
//   根因：龙位候选集没被「当日正式列表 / 计入统计的行」约束 ⇒ 灰行（继承壳、复盘行）
//   占了名次，把真龙一 / 真龙二往后挤。
describe('rankDragons（龙一 / 龙二 位次口径）', () => {
  it('「昨日卖标签继承」的复盘行（inheritSold）【不占龙位】', () => {
    // 「复盘」十日涨幅最高，但它是昨日卖标签继承的复盘行 → 不计数、也不该当龙一
    const blocks = rankDecisionTopics([
      E('复盘', 'T1', 99, false, true, null, '', true), E('真龙一', 'T1', 30), E('真龙二', 'T1', 20)
    ]);
    const dragon = rankDragons(blocks);
    expect(dragon.get('复盘')).toBeUndefined();
    expect(dragon.get('真龙一').rank).toBe(1);
    expect(dragon.get('真龙二').rank).toBe(2);
  });

  // [GRAY-DRAGON 2026-09-26] 灰行 = 不在当日正式列表（早盘竞价画灰），用户要求【照常参与】龙位：
  //   9/8 大消费的龙一国芳集团就是这种行 —— 它是同期龙头，有参考价值。
  it('灰行（countable=false 但不是 inheritSold）【照常占龙位】', () => {
    const blocks = rankDecisionTopics([
      E('灰行龙头', 'T1', 99, false, false), E('正式一', 'T1', 30), E('正式二', 'T1', 20)
    ]);
    expect(blocks[0].count).toBe(2);                 // 数量 / 一字数仍只数正式成员
    const dragon = rankDragons(blocks);
    expect(dragon.get('灰行龙头').rank).toBe(1);
    expect(dragon.get('正式一').rank).toBe(2);
  });

  it('缺十日涨幅的行排不进龙位（§10 绝不当 0 参与比较）', () => {
    const blocks = rankDecisionTopics([
      E('缺涨幅', 'T1', null), E('甲', 'T1', 30), E('乙', 'T1', 20)
    ]);
    const dragon = rankDragons(blocks);
    expect(dragon.get('缺涨幅')).toBeUndefined();
    expect(dragon.get('甲').rank).toBe(1);
    expect(dragon.get('乙').rank).toBe(2);
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
  // T1：5 只、2 个一字（排名第一；⛔ 刻意 5 只 —— ≤4 只会命中 ⑥「小题材 + 一字」高风险兜底，
  //    被它截走就测不到常规档位了）；T2 / T3：0 个一字，各 2 只 → T2 排第二、T3 排第三
  const entries = [
    E('一字A', 'T1', 40, true), E('一字B', 'T1', 39, true), E('可买C', 'T1', 30), E('可买D', 'T1', 20),
    E('可买E', 'T1', 5),
    // ⛔ T2 必须带 aucPct：第 2 名题材现在只选【竞价高开】的票，缺竞价涨幅 → 选不出来
    E('T2一', 'T2', 10, false, true, 2), E('T2二', 'T2', 9, false, true, -1),
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
      E('T2一', 'T2', 10, false, true, 3), E('T2二', 'T2', 9, false, true, -2)
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
      E('E龙五', 'T1', 25, false, true, -1),  // ⛔ 第 5 只：让 T1 有 5 只，不命中 ⑥ 小题材兜底
      E('T2一', 'T2', 10), E('T2二', 'T2', 9)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['A龙一', 'D龙四']);
    expect(plan.heavy.notes.join('｜')).toContain('缺竞价涨幅');
    expect(plan.heavy.notes.join('｜')).toContain('1 只');
  });

  it('【全部题材】一字 0 个 → 不走常规档位，改走弱市兜底（plan.noYizi）', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 10), E('a2', 'T1', 9), E('a3', 'T1', 8),
      E('b1', 'T2', 5), E('b2', 'T2', 4)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), { ladderReady: true, ladderTopicGroups: [] });
    expect(plan.heavy).toBe(null);
    expect(plan.light).toBe(null);
    expect(plan.noYizi).not.toBe(null);
    expect(plan.noYizi.mode).toBe('noYizi');
  });

  it('只要有任何一个题材有一字 → 弱市兜底（⑤）必须为 null（两条规则互斥）', () => {
    // ⛔ T1 刻意 5 只：≤4 只 + 1 个一字会命中 ⑥「小题材 + 一字」兜底，被它截走就测不到常规档位
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 10, true), E('a2', 'T1', 9), E('a3', 'T1', 8), E('a4', 'T1', 7), E('a5', 'T1', 6),
      E('b1', 'T2', 5), E('b2', 'T2', 4)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), { ladderReady: true, ladderTopicGroups: [] });
    expect(plan.noYizi).toBe(null);
    expect(plan.smallTopic).toBe(null);
    expect(plan.heavy).not.toBe(null);
  });

  it('理由文案：题材排第几 + 股票数量 + 一字数', () => {
    const blocks = rankDecisionTopics(entries);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.reason).toBe('题材排第一，股票数量5只，2个竞价一字');
    expect(plan.light.reason).toContain('题材排第二，股票数量2只，0个竞价一字');
    expect(plan.light.reason).toContain('龙一不是一字则直接买龙一');
  });
});

// === [NO-YIZI 2026-09-25] 「全部题材竞价一字 0 个」的弱市兜底规则 ===
describe('buildNoYiziPlan（连板天梯 · 题材连扳）', () => {
  /** 造一个「题材连扳」分组：G(题材, [[名, 十日涨幅, 竞价涨幅%, 是否一字], ...]) */
  function G(topic, rows) {
    return {
      topic: topic,
      count: rows.length,
      rows: rows.map(function(r) {
        return { name: r[0], pct: r[1], aucPct: (r[2] === null ? null : r[2]), isYiZi: !!r[3] };
      })
    };
  }
  /** 造龙头排名：D(名1, 名2, ...) → 依次是龙一 / 龙二 / … */
  function D() {
    const m = new Map();
    Array.prototype.slice.call(arguments).forEach(function(n, i) { m.set(n, { rank: i + 1 }); });
    return m;
  }

  it('取【股票数量最多】的题材：龙一低开 + 龙二高开 → 只买龙二（轻仓）', () => {
    const groups = [
      G('T1', [['A', 30, -2], ['B', 20, 3], ['C', 10, 5]]),   // 3 只（最多）
      G('T2', [['D', 9, 4], ['E', 8, 4]])                       // 2 只
    ];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks.length).toBe(1);
    expect(plan.blocks[0].block.topic).toBe('T1');
    expect(plan.blocks[0].block.count).toBe(3);
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['B']);
    expect(plan.blocks[0].picks[0].dragonLabel).toBe('龙二');
    expect(plan.blocks[0].picks[0].position).toBe(POSITION_LIGHT);
    expect(plan.blocks[0].notes.join('｜')).toContain('只买高开的龙二');
  });

  it('龙一 / 龙二【都高开】→ 两只都买', () => {
    const groups = [G('T1', [['A', 30, 2], ['B', 20, 5], ['C', 10, -1]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A', 'B']);
    expect(plan.blocks[0].picks.map(p => p.position)).toEqual([POSITION_LIGHT, POSITION_LIGHT]);
    expect(plan.blocks[0].picks.map(p => p.seq)).toEqual([1, 2]);
  });

  it('龙一 / 龙二【都低开】→ 只买龙一', () => {
    const groups = [G('T1', [['A', 30, -3], ['B', 20, -1], ['C', 10, 6]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A']);
    expect(plan.blocks[0].notes.join('｜')).toContain('只买龙一');
  });

  it('数量【并列】→ 并列的题材全都选票（用户举例：AI应用也是 3 只）', () => {
    const groups = [
      G('T1', [['A', 30, 2], ['B', 20, 2], ['C', 10, 2]]),
      G('T2', [['D', 29, 4], ['E', 19, -1], ['F', 9, 4]]),
      G('T3', [['G', 5, 9]])
    ];
    const plan = buildNoYiziPlan(groups, {
      dragonMap: D('A', 'B', 'C', 'D', 'E', 'F', 'G'),
      ladderReady: true
    });
    expect(plan.blocks.map(b => b.block.topic)).toEqual(['T1', 'T2']);
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A', 'B']);  // 龙一 / 龙二 都高开 → 都买
    expect(plan.blocks[1].picks.map(p => p.name)).toEqual(['D']);       // 龙一高开、龙二低开 → 只买龙一
    expect(plan.notes.join('｜')).toContain('并列最多');
  });

  it('题材连扳里股票最多的题材【不足 ' + 3 + ' 只】→ 空仓（太弱）', () => {
    const groups = [G('T1', [['A', 30, 5], ['B', 20, 5]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B'), ladderReady: true });
    expect(NO_YIZI_MIN_TOPIC_COUNT).toBe(3);
    expect(plan.qualified).toBe(false);
    expect(plan.blocks.length).toBe(0);
    expect(plan.emptyText).toContain('空仓');
    expect(plan.emptyText).toContain('不足 3 只');
  });

  it('连板天梯数据未就绪 → 如实报「未就绪」，⛔ 不退化成「今天没有连板梯队」', () => {
    const plan = buildNoYiziPlan([], { dragonMap: new Map(), ladderReady: false, ladderReason: '连板数据尚未加载完成' });
    expect(plan.qualified).toBe(false);
    expect(plan.emptyText).toContain('未就绪');
    expect(plan.emptyText).toContain('连板数据尚未加载完成');
    expect(plan.emptyText).not.toContain('空仓');
  });

  it('缺竞价涨幅【不算高开】，并如实说明有几只未纳入（§10 不猜）', () => {
    const groups = [G('T1', [['A', 30, null], ['B', 20, 3], ['C', 10, 1]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['B']);
    expect(plan.blocks[0].notes.join('｜')).toContain('缺竞价涨幅');
  });

  it('题材里只有龙一（缺十日涨幅排不出龙二）→ 仍按规则只买龙一，不静默空手', () => {
    const groups = [G('T1', [['A', 30, -1], ['无涨幅', null, 8], ['C', null, 8]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A'), ladderReady: true });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A']);
    expect(plan.blocks[0].notes.join('｜')).toContain('无龙二');
  });

  it('完全排不出龙一 / 龙二（全员缺十日涨幅）→ 不选票，如实说明', () => {
    const groups = [G('T1', [['A', null, 5], ['B', null, 5], ['C', null, 5]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: new Map(), ladderReady: true });
    expect(plan.qualified).toBe(false);
    expect(plan.blocks[0].picks.length).toBe(0);
    expect(plan.blocks[0].notes.join('｜')).toContain('缺十日涨幅');
    expect(plan.emptyText).toContain('空仓');
  });

  it('「其它」题材不参与（与全局题材口径一致）', () => {
    // 其它 有 4 只（最多）但被排除 → 最多的是 T1（3 只）
    const groups = [
      G('其它', [['X', 90, 9], ['Y', 80, 9], ['Z', 70, 9], ['W', 60, 9]]),
      G('T1', [['A', 30, 2], ['B', 20, 2], ['C', 10, 2]])
    ];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks.map(b => b.block.topic)).toEqual(['T1']);
  });

  it('一字票买不进 → 直接跳过（龙一是一字时由后面的票顶上）', () => {
    const groups = [G('T1', [['A', 30, 10, true], ['B', 20, 3], ['C', 10, 4]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['B', 'C']);
  });

  it('题材下面那行小字要写清「为什么选它」（数量最多 + 只买高开）', () => {
    const groups = [G('T1', [['A', 30, 1], ['B', 20, 1], ['C', 10, 1]])];
    const plan = buildNoYiziPlan(groups, { dragonMap: D('A', 'B', 'C'), ladderReady: true });
    expect(plan.blocks[0].reason).toContain('股票数量最多');
    expect(plan.blocks[0].reason).toContain('3 只');
    expect(plan.blocks[0].reason).toContain('竞价高开');
  });

  // === [NOT-FORMAL-DRAGON 2026-09-25] 龙一 / 龙二 的排名人群 = 早盘竞价题材组 ===
  // 题材连扳（连板票子集）只负责决定【选哪个题材】；名次本身必须回到早盘竞价口径，
  // 否则「真龙一当天没连板」就会被跳过，龙二被顶成龙一（9/16 电子/通信/算力 事故）。
  it('龙一当天没连板（不在题材连扳里）也不能被跳过 → 名次仍按早盘竞价口径', () => {
    // 题材连扳 T1 只有 B / C / D 三只连板票；真龙一 A 当天没连板，不在这个子集里
    const groups = [G('T1', [['B', 20, 3], ['C', 10, 4], ['D', 5, -1]])];
    const blocks = rankDecisionTopics([
      E('A', 'T1', 30, false, true, -2),   // 龙一：低开
      E('B', 'T1', 20, false, true, 3),    // 龙二：高开
      E('C', 'T1', 10, false, true, 4),
      E('D', 'T1', 5, false, true, -1)
    ]);
    const plan = buildNoYiziPlan(groups, {
      dragonMap: rankDragons(blocks), ladderReady: true, auctionTopicBlocks: blocks
    });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['B']);   // 龙一低开 + 龙二高开 → 只买龙二
    expect(plan.blocks[0].notes.join('｜')).toContain('龙二【竞价高开】');
    expect(plan.blocks[0].notes.join('｜')).not.toContain('没有同名题材');
  });

  it('龙一高开 + 龙二低开 → 只买龙一（龙二是否在题材连扳里不影响名次）', () => {
    const groups = [G('T1', [['A', 30, 5], ['C', 10, 4], ['D', 5, 3]])];
    const blocks = rankDecisionTopics([
      E('A', 'T1', 30, false, true, 5),    // 龙一：高开
      E('B', 'T1', 20, false, true, -1),   // 龙二：低开（当天没连板，不在题材连扳里）
      E('C', 'T1', 10, false, true, 4),
      E('D', 'T1', 5, false, true, 3)
    ]);
    const plan = buildNoYiziPlan(groups, {
      dragonMap: rankDragons(blocks), ladderReady: true, auctionTopicBlocks: blocks
    });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A']);
    expect(plan.blocks[0].notes.join('｜')).toContain('龙一【竞价高开】');
  });

  it('找不到同名题材块 → 退回「题材连扳」成员自排，并如实说明（§10 不猜）', () => {
    const groups = [G('T9', [['A', 30, 5], ['B', 20, -1], ['C', 10, 2]])];
    const plan = buildNoYiziPlan(groups, {
      dragonMap: new Map(), ladderReady: true, auctionTopicBlocks: []
    });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['A']);
    expect(plan.blocks[0].notes.join('｜')).toContain('没有同名题材');
  });
});

// === [SMALL-TOPIC 2026-09-25] ⑥「小题材 + 一字 = 高风险」兜底规则 ===
// 用户实例（9/15）：AI应用 3 只（2 个一字）、医药 4 只（1 个一字）→ 常规规则准确率低；
//   题材连扳里 电力新能源 3 / AI应用 3 / 电子通信算力 3 数量相当，
//   再看早盘竞价总数：AI应用 3 只（排除）、电力新能源 4 只（入选）、电子通信算力 10 只（入选）。
describe('isSmallRiskyTopic（高风险小题材判定）', () => {
  function B(topic, count, yizi) {
    return { topic: topic, count: count, yiziCount: yizi, members: [] };
  }
  it('≤4 只 且 1 个一字 → 命中', () => {
    expect(isSmallRiskyTopic(B('T', 4, 1))).toBe(true);
  });
  it('≤4 只 且 2 个一字 → 命中', () => {
    expect(isSmallRiskyTopic(B('T', 3, 2))).toBe(true);
  });
  it('5 只（>4）即使有 1 个一字 → 不命中（票够了）', () => {
    expect(isSmallRiskyTopic(B('T', 5, 1))).toBe(false);
  });
  it('≤4 只但 0 个一字 → 不命中（那是 ⑤ 弱市兜底的活）', () => {
    expect(isSmallRiskyTopic(B('T', 3, 0))).toBe(false);
  });
  it('≤4 只但 3 个一字 → 不命中（超出 1~2 个的区间）', () => {
    expect(isSmallRiskyTopic(B('T', 4, 3))).toBe(false);
  });
});

describe('buildSmallTopicPlan（⑥ 改看题材连扳 + 早盘竞价股票数）', () => {
  /** 造一个「题材连扳」分组：LG(题材, 连板只数) */
  function LG(topic, n) { return { topic: topic, count: n, rows: [] }; }

  // 早盘竞价题材块：电子/通信/算力 10 只（曾用 E 造 10 只太多，这里只造前几只 + 直接改 count）
  function auctionBlocks() {
    const blocks = rankDecisionTopics([
      E('电龙一', '电力新能源', 60, false, true, 2),
      E('电龙二', '电力新能源', 50, false, true, -1),
      E('电龙三', '电力新能源', 40, false, true, 3),
      E('电龙四', '电力新能源', 30, false, true, 0),
      // 电子/通信/算力：龙一 1%、龙二 -2%、龙三 3.6%、龙四 0%、龙五 6.5%（用户原例）
      E('算龙一', '电子算力', 90, false, true, 1),
      E('算龙二', '电子算力', 80, false, true, -2),
      E('算龙三', '电子算力', 70, false, true, 3.6),
      E('算龙四', '电子算力', 60, false, true, 0),
      E('算龙五', '电子算力', 50, false, true, 6.5),
      E('算龙六', '电子算力', 40, false, true, 8),
      // AI应用 早盘竞价只有 3 只 → 应被排除
      E('A一', 'AI应用', 30), E('A二', 'AI应用', 20), E('A三', 'AI应用', 10)
    ]);
    // 题材连扳的「连板只数」与早盘竞价总数不同：这里把「电子算力」在早盘竞价的数量撑到 10（用户实例）
    const ec = blocks.find(b => b.topic === '电子算力');
    return blocks.map(b => (b === ec ? Object.assign({}, b, { count: 10 }) : b));
  }

  it('早盘竞价股票数 < 4 只的题材（AI应用 3 只）被排除', () => {
    const blocks = auctionBlocks();
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('电子算力', 3), LG('电力新能源', 3), LG('AI应用', 3)],
      ladderReady: true
    });
    expect(plan.mode).toBe('smallTopic');
    expect(plan.blocks.map(b => b.block.topic)).toEqual(['电子算力', '电力新能源']);
  });

  it('数量最多的题材：龙一重仓 + 龙一~龙五里竞价涨幅最高的那只轻仓', () => {
    const blocks = auctionBlocks();
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('电子算力', 3), LG('电力新能源', 3), LG('AI应用', 3)],
      ladderReady: true
    });
    const top = plan.blocks[0];
    // 高开的是 龙一(+1) / 龙三(+3.6) / 龙五(+6.5) → 龙一优先重仓，其余按涨幅取最高 = 龙五
    expect(top.picks.map(p => p.name)).toEqual(['算龙一', '算龙五']);
    expect(top.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
    expect(top.picks.map(p => p.dragonLabel)).toEqual(['龙一', '龙五']);
    expect(top.picks.map(p => p.seq)).toEqual([1, 2]);
  });

  it('数量第二的题材：只取龙一，轻仓', () => {
    const blocks = auctionBlocks();
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('电子算力', 3), LG('电力新能源', 3), LG('AI应用', 3)],
      ladderReady: true
    });
    const second = plan.blocks[1];
    expect(second.block.topic).toBe('电力新能源');
    expect(second.picks.map(p => p.name)).toEqual(['电龙一']);
    expect(second.picks[0].position).toBe(POSITION_LIGHT);
    expect(second.picks[0].dragonLabel).toBe('龙一');
  });

  it('龙一【低开】→ 舍弃龙一，只在龙二~龙五里取竞价涨幅最高的两只，都轻仓', () => {
    // 用户实例（龙一 −6%）：龙一 −6、龙二 −2、龙三 +3.6、龙四 0、龙五 +6.5 → 只取 龙五 + 龙三
    const blocks = rankDecisionTopics([
      E('甲龙一', 'T1', 90, false, true, -6),
      E('乙龙二', 'T1', 80, false, true, -2),
      E('丙龙三', 'T1', 70, false, true, 3.6),
      E('丁龙四', 'T1', 60, false, true, 0),
      E('戊龙五', 'T1', 50, false, true, 6.5),
      E('T2一', 'T2', 60), E('T2二', 'T2', 50)
    ]);
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('T1', 5), LG('T2', 2)], ladderReady: true
    });
    const top = plan.blocks[0];
    expect(top.picks.map(p => p.name)).toEqual(['戊龙五', '丙龙三']);   // 按竞价涨幅降序
    expect(top.picks.map(p => p.dragonLabel)).toEqual(['龙五', '龙三']);
    expect(top.picks.map(p => p.position)).toEqual([POSITION_LIGHT, POSITION_LIGHT]);
    expect(top.notes.join('｜')).toContain('舍弃龙一');
  });

  it('龙一【平开（0%）】同样不算高开 → 舍弃龙一', () => {
    const blocks = rankDecisionTopics([
      E('甲龙一', 'T1', 90, false, true, 0),
      E('乙龙二', 'T1', 80, false, true, 5),
      E('丙龙三', 'T1', 70, false, true, 3),
      E('丁龙四', 'T1', 60, false, true, 1),
      E('T2一', 'T2', 60), E('T2二', 'T2', 50)
    ]);
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('T1', 4), LG('T2', 2)], ladderReady: true
    });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['乙龙二', '丙龙三']);
    expect(plan.blocks[0].picks.map(p => p.position)).toEqual([POSITION_LIGHT, POSITION_LIGHT]);
    expect(plan.blocks[0].notes.join('｜')).toContain('龙一未高开');
  });

  it('龙一【高开】→ 龙一重仓 + 其余里竞价涨幅最高的一只轻仓', () => {
    const blocks = rankDecisionTopics([
      E('甲龙一', 'T1', 90, false, true, 1),     // 龙一 +1% 高开
      E('乙龙二', 'T1', 80, false, true, 4),     // 涨幅比龙一高，但龙一高开时龙一固定重仓
      E('丙龙三', 'T1', 70, false, true, 3.6),
      E('丁龙四', 'T1', 60, false, true, 0),
      E('戊龙五', 'T1', 50, false, true, 6.5),   // 其余里涨幅最高 → 轻仓
      E('T2一', 'T2', 60), E('T2二', 'T2', 50)
    ]);
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('T1', 5), LG('T2', 2)], ladderReady: true
    });
    const top = plan.blocks[0];
    expect(top.picks.map(p => p.name)).toEqual(['甲龙一', '戊龙五']);
    expect(top.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('一字买不进 → 跳过；缺竞价涨幅不算高开', () => {
    const blocks = rankDecisionTopics([
      E('甲龙一', 'T1', 90, true, true, 10),     // 一字
      E('乙龙二', 'T1', 80, false, true, null),  // 缺竞价涨幅
      E('丙龙三', 'T1', 70, false, true, 4),
      E('丁龙四', 'T1', 60, false, true, -2),    // 第 4 只：早盘竞价满 4 只才进得了 ⑥ 的候选
      E('T2一', 'T2', 60), E('T2二', 'T2', 50)
    ]);
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('T1', 3), LG('T2', 2)], ladderReady: true
    });
    expect(plan.blocks[0].picks.map(p => p.name)).toEqual(['丙龙三']);
    expect(plan.blocks[0].notes.join('｜')).toContain('缺竞价涨幅');
  });

  it('连板天梯未就绪 → 如实报「未就绪」，⛔ 不退回常规规则', () => {
    const blocks = auctionBlocks();
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [], ladderReady: false, ladderReason: '连板数据尚未加载完成'
    });
    expect(plan.qualified).toBe(false);
    expect(plan.blocks.length).toBe(0);
    expect(plan.emptyText).toContain('未就绪');
    expect(plan.emptyText).toContain('连板数据尚未加载完成');
  });

  it('所有候选题材在早盘竞价都 < 4 只 → 空仓并如实说明', () => {
    const blocks = rankDecisionTopics([
      E('A一', 'T1', 30), E('A二', 'T1', 20), E('A三', 'T1', 10)
    ]);
    const plan = buildSmallTopicPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('T1', 3)], ladderReady: true
    });
    expect(plan.qualified).toBe(false);
    expect(plan.emptyText).toContain('空仓');
    expect(plan.emptyText).toContain('早盘竞价股票数');
  });

  it('触发时 buildBuyPlan 不再产出 heavy / light（常规规则整体让位给 ⑥）', () => {
    // 第 1 名题材 = 4 只 + 1 个一字 → 高风险小题材
    const blocks = rankDecisionTopics([
      E('一字A', 'T1', 40, true), E('B', 'T1', 39), E('C', 'T1', 30), E('D', 'T1', 20),
      E('电龙一', '电力新能源', 60, false, true, 2),
      E('电龙二', '电力新能源', 50, false, true, 3),
      E('电龙三', '电力新能源', 40, false, true, 1),
      E('电龙四', '电力新能源', 30, false, true, 5)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('电力新能源', 4), LG('T1', 2)], ladderReady: true
    });
    expect(plan.heavy).toBeNull();
    expect(plan.light).toBeNull();
    expect(plan.noYizi).toBeNull();
    expect(plan.smallTopic).not.toBeNull();
    expect(plan.smallTopic.notes.join('｜')).toContain('T1（4只 / 1个一字）');
  });
});

// 第 1 名题材 X：5 只 + 1 个一字（⛔ 刻意 5 只，≤4 只会命中 ⑥ 小题材兜底；
//   ⛔ 必须有 1 个一字，否则全部题材 0 一字 → 走 ⑤ 弱市兜底，就测不到第 2 名题材这一档）
// 两个「第 2 名题材」用例组共用，故提到模块作用域。
// ⛔ X 刻意给【2 个一字】：T 只有 1 个一字时才稳坐第 2 名（否则一字数打平会被 T 抢到第 1 名）
const headTopic = [
  E('X一字', 'X', 50, true, true, 10), E('X二', 'X', 40, true, true, 9),
  E('X三', 'X', 30, false, true, 2), E('X四', 'X', 20, false, true, 3),
  E('X五', 'X', 10, false, true, -1)
];

// === [2026-09-26] 第 2 名题材改选「名次最靠前的那只在竞价高开」 ===
// 事故现场：9/24 大消费 9 只，按龙头顺序取第一名 → 取到奥康国际（龙二、低开）。
describe('pickFirstHighOpen（第 2 名题材：名次最靠前的高开票）', () => {
  it('龙一~龙八全低开、只有龙九高开 → 就选龙九', () => {
    const members = [];
    for (let i = 1; i <= 9; i++) members.push(E('股' + i, 'T', 100 - i * 5, false, true, i === 9 ? 4 : -1));
    const blocks = rankDecisionTopics(members.concat([E('X1', 'X', 1), E('X2', 'X', 0)]));
    const blk = blocks.find(b => b.topic === 'T');
    const r = pickFirstHighOpen(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.picks.map(p => p.name)).toEqual(['股9']);
    expect(r.picks[0].dragonLabel).toBe('龙九');
    expect(r.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('龙四与龙八都高开 → 选名次更靠前的龙四', () => {
    const members = [
      E('股1', 'T', 90, false, true, -3), E('股2', 'T', 80, false, true, -2),
      E('股3', 'T', 70, false, true, -1), E('股4', 'T', 60, false, true, 2),
      E('股5', 'T', 50, false, true, -4), E('股6', 'T', 40, false, true, -5),
      E('股7', 'T', 30, false, true, -6), E('股8', 'T', 20, false, true, 8)
    ];
    const blocks = rankDecisionTopics(members.concat([E('X1', 'X', 1), E('X2', 'X', 0)]));
    const blk = blocks.find(b => b.topic === 'T');
    const r = pickFirstHighOpen(blk, rankDragons(blocks), POSITION_LIGHT);
    // 龙八 +8% 涨幅更高，但规则要的是【名次最靠前】的高开票 → 龙四
    expect(r.picks.map(p => p.name)).toEqual(['股4']);
    expect(r.picks[0].dragonLabel).toBe('龙四');
  });

  it('一字买不进 → 跳过该名次，取下一个高开的', () => {
    const blocks = rankDecisionTopics([
      E('股1', 'T', 90, true, true, 10),    // 龙一 = 一字
      E('股2', 'T', 80, false, true, -1),   // 龙二 低开
      E('股3', 'T', 70, false, true, 5),    // 龙三 高开 → 选它
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const blk = blocks.find(b => b.topic === 'T');
    const r = pickFirstHighOpen(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.picks.map(p => p.name)).toEqual(['股3']);
    expect(r.picks[0].dragonLabel).toBe('龙三');
  });

  it('龙一是一字 → 回退：全组没有高开票 → 不选票，并在块里如实说明（§10）', () => {
    const blocks = rankDecisionTopics(headTopic.concat([
      // ⛔ T 必须凑够 5 只：≤4 只 + 1 个一字会被 ⑥ 小题材兜底截走，就测不到常规 ④
      E('股1', 'T', 90, true, true, 10),    // 龙一 = 一字（买不进）→ 走回退规则
      E('股2', 'T', 80, false, true, -1), E('股3', 'T', 70, false, true, -2),
      E('股4', 'T', 60, false, true, -3), E('股5', 'T', 50, false, true, -4)
    ]));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.light.block.topic).toBe('T');
    expect(plan.light.picks.length).toBe(0);
    expect(plan.light.notes.join('｜')).toContain('龙一是一字涨停（买不进）');
    expect(plan.light.notes.join('｜')).toContain('没有「非一字 且 竞价高开」的股票');
  });

  it('龙一是一字 → 回退：缺竞价涨幅不算高开，如实说明有几只未纳入（§10 不猜）', () => {
    const blocks = rankDecisionTopics(headTopic.concat([
      E('股1', 'T', 90, true, true, 10),    // 龙一 = 一字（买不进）→ 走回退规则
      E('股2', 'T', 80, false, true, null), // 缺竞价涨幅
      E('股3', 'T', 70, false, true, 3),    // 高开 → 选它
      E('股4', 'T', 60, false, true, -1), E('股5', 'T', 50, false, true, -2)
    ]));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.light.block.topic).toBe('T');
    expect(plan.light.picks.map(p => p.name)).toEqual(['股3']);
    expect(plan.light.notes.join('｜')).toContain('1 只缺竞价涨幅');
  });
});

// === [2026-09-26] 第 2 名题材再补一条【优先规则】：龙一不是一字 → 直接买龙一 ===
describe('pickSecondTopicBuy（第 2 名题材：龙一优先，龙一是一字才回退）', () => {
  const secondTopic = (members) => {
    const blocks = rankDecisionTopics(members);
    return { blocks: blocks, blk: blocks.find(b => b.topic === 'T') };
  };

  it('龙一不是一字、且是【低开】→ 直接买龙一（不看竞价涨跌幅）', () => {
    const { blocks, blk } = secondTopic(headTopic.concat([
      E('股1', 'T', 90, false, true, -5),   // 龙一 低开
      E('股2', 'T', 80, false, true, 6),    // 龙二 高开且涨幅更高，也不能抢龙一
      E('股3', 'T', 70, false, true, 7)
    ]));
    const r = pickSecondTopicBuy(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.viaDragonOne).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['股1']);
    expect(r.picks[0].dragonLabel).toBe('龙一');
    expect(r.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('龙一不是一字、竞价涨幅缺失 → 照样直接买龙一（不看竞价涨跌幅）', () => {
    const { blocks, blk } = secondTopic(headTopic.concat([
      E('股1', 'T', 90, false, true, null), // 龙一 缺竞价涨幅
      E('股2', 'T', 80, false, true, 4)
    ]));
    const r = pickSecondTopicBuy(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.viaDragonOne).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['股1']);
  });

  it('龙一不是一字、本身就是高开 → 也是直接买龙一（规则不变形）', () => {
    const { blocks, blk } = secondTopic(headTopic.concat([
      E('股1', 'T', 90, false, true, 5),
      E('股2', 'T', 80, false, true, 9)
    ]));
    const r = pickSecondTopicBuy(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.viaDragonOne).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['股1']);
  });

  it('龙一是一字（买不进）→ 回退：龙二低开、龙三高开、龙八高开 → 选名次更靠前的龙三', () => {
    const { blocks, blk } = secondTopic(headTopic.concat([
      E('股1', 'T', 90, true, true, 10),    // 龙一 = 一字
      E('股2', 'T', 80, false, true, -1),   // 龙二 低开
      E('股3', 'T', 70, false, true, 2),    // 龙三 高开 → 选它
      E('股4', 'T', 60, false, true, -3), E('股5', 'T', 50, false, true, -4),
      E('股6', 'T', 40, false, true, -5), E('股7', 'T', 30, false, true, -6),
      E('股8', 'T', 20, false, true, 9)     // 龙八 高开且涨幅更高，但名次靠后
    ]));
    const r = pickSecondTopicBuy(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.viaDragonOne).toBe(false);
    expect(r.dragonOneYizi).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['股3']);
    expect(r.picks[0].dragonLabel).toBe('龙三');
  });

  it('题材内没有可判定的龙一（全是缺十日涨幅）→ 走回退规则', () => {
    const { blocks, blk } = secondTopic(headTopic.concat([
      E('股1', 'T', null, false, true, 5),
      E('股2', 'T', null, false, true, 3)
    ]));
    const r = pickSecondTopicBuy(blk, rankDragons(blocks), POSITION_LIGHT);
    expect(r.viaDragonOne).toBe(false);
    expect(r.dragonOneYizi).toBe(false);
    expect(r.picks.length).toBe(0);
  });

  it('buildBuyPlan 里落到 light 档：龙一低开也买龙一，并写明理由', () => {
    const blocks = rankDecisionTopics(headTopic.concat([
      E('股1', 'T', 90, false, true, -6),
      E('股2', 'T', 80, false, true, 5)
    ]));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.light.block.topic).toBe('T');
    expect(plan.light.picks.map(p => p.name)).toEqual(['股1']);
    expect(plan.light.notes.join('｜')).toContain('直接买龙一');
  });
});

// === [2026-09-26] ① 第 1 名题材「2 个一字」：第二只按竞价涨幅选，卡位则共选 3 只 ===
describe('pickHeavyTwo（第 1 名题材 · 卡位选票）', () => {
  const mk = (members) => {
    const blocks = rankDecisionTopics(members);
    return { blocks: blocks, dragon: rankDragons(blocks), blk: blocks.find(b => b.topic === 'T') };
  };

  it('龙二涨幅 < 龙三涨幅（卡位）→ 龙一重仓 + 龙三重仓 + 龙二轻仓（共 3 只）', () => {
    // 9/1 农业原型：龙二金健米业 +0.1%、龙三万向德农 +7.3%
    const { dragon, blk } = mk([
      E('股1', 'T', 90, false, true, 3),    // 龙一
      E('股2', 'T', 80, false, true, 0.1),  // 龙二
      E('股3', 'T', 70, false, true, 7.3),  // 龙三：涨幅最高 → 卡位
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const r = pickHeavyTwo(blk, dragon);
    expect(r.jumped).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['股1', '股3', '股2']);
    expect(r.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('涨幅最高的恰好就是龙二 → 维持 2 只，都重仓', () => {
    const { dragon, blk } = mk([
      E('股1', 'T', 90, false, true, 1),
      E('股2', 'T', 80, false, true, 5),    // 龙二同时是涨幅最高
      E('股3', 'T', 70, false, true, 2),
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const r = pickHeavyTwo(blk, dragon);
    expect(r.jumped).toBe(false);
    expect(r.picks.map(p => p.name)).toEqual(['股1', '股2']);
    expect(r.picks.every(p => p.position === POSITION_HEAVY)).toBe(true);
  });

  it('其余票全缺竞价涨幅 → 第二只退回按龙头名次取（§10 不猜）', () => {
    const { dragon, blk } = mk([
      E('股1', 'T', 90, false, true, 1),
      E('股2', 'T', 80, false, true, null),
      E('股3', 'T', 70, false, true, null),
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const r = pickHeavyTwo(blk, dragon);
    expect(r.picks.map(p => p.name)).toEqual(['股1', '股2']);
    expect(r.notes.join('｜')).toContain('缺竞价涨幅');
  });
});

// === [2026-09-26] ③ 非龙一的创业板 / 科创板（20% 板）顺延下一位 ===
describe('创业板 / 科创板顺延（GROWTH-BOARD）', () => {
  const mk = (members) => {
    const blocks = rankDecisionTopics(members);
    return { blocks: blocks, dragon: rankDragons(blocks), blk: blocks.find(b => b.topic === 'T') };
  };

  it('龙二是创业板 → 跳过，往下取龙三（9/2 AI应用：龙五芒果超媒 → 改选龙六）', () => {
    const { dragon, blk } = mk([
      E('股1', 'T', 90, false, true, 1),
      E('创业板票', 'T', 80, false, true, 9, '300413'),   // 龙二，20% 板 → 顺延
      E('股3', 'T', 70, false, true, 2),
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const picks = pickBuyable(blk, dragon, 2, POSITION_HEAVY);
    expect(picks.map(p => p.name)).toEqual(['股1', '股3']);
  });

  it('龙一自己是创业板也照选（龙一是最强票，不因板块被跳过）', () => {
    const { dragon, blk } = mk([
      E('创龙一', 'T', 90, false, true, 1, '300413'),
      E('股2', 'T', 80, false, true, 5),
      E('X1', 'X', 1), E('X2', 'X', 0)
    ]);
    const picks = pickBuyable(blk, dragon, 2, POSITION_HEAVY);
    expect(picks.map(p => p.name)).toEqual(['创龙一', '股2']);
  });
});

// === [2026-09-26] ⑤ 第 2 名题材 vs 连板天梯数量第一题材：比早盘竞价股票数 ===
describe('resolveSecondTopicByLadder（第 2 名题材数量对比）', () => {
  // X = 第 1 名（2 个一字）；A = 第 2 名（1 个一字，7 只）；B = 第 3 名（0 一字，10 只）
  const bigTopic = 'B';
  const blocksOf = (bCount) => {
    const rows = [
      E('X一', 'X', 50, true), E('X二', 'X', 40, true), E('X三', 'X', 30), E('X四', 'X', 20),
      E('A一', 'A', 60, true), E('A二', 'A', 50), E('A三', 'A', 40), E('A四', 'A', 30),
      E('A五', 'A', 20), E('A六', 'A', 10), E('A七', 'A', 5)
    ];
    for (let i = 1; i <= bCount; i++) rows.push(E('B' + i, bigTopic, 90 - i));
    return rankDecisionTopics(rows);
  };

  it('天梯第一的题材在早盘竞价里更多 → 改选它（9/3 大消费 7 ＜ AI应用 10）', () => {
    const blocks = blocksOf(10);
    const second = blocks.find(b => b.topic === 'A');
    const rs = resolveSecondTopicByLadder(blocks, second, {
      ladderReady: true, ladderTopicGroups: [{ topic: bigTopic, count: 4 }]
    });
    expect(rs.replaced).toBe(true);
    expect(rs.block.topic).toBe(bigTopic);
    expect(rs.notes.join('｜')).toContain('改选');
  });

  it('天梯第一的题材在早盘竞价里更少 → 沿用第 2 名题材', () => {
    const blocks = blocksOf(5);
    const second = blocks.find(b => b.topic === 'A');
    const rs = resolveSecondTopicByLadder(blocks, second, {
      ladderReady: true, ladderTopicGroups: [{ topic: bigTopic, count: 4 }]
    });
    expect(rs.replaced).toBe(false);
    expect(rs.block.topic).toBe('A');
  });

  it('天梯第一的题材【已经】入选过 → 同题材不重复，不做替换（9/8 大消费）', () => {
    // 第 1 名 = A（2 个一字）；第 2 名 = B（1 个一字）；天梯第一也是 A
    const blocks = rankDecisionTopics([
      E('A一', 'A', 60, true), E('A二', 'A', 50, true), E('A三', 'A', 40),
      E('A四', 'A', 30), E('A五', 'A', 20),
      E('B一', 'B', 55, true), E('B二', 'B', 45), E('B三', 'B', 35),
      E('B四', 'B', 25), E('B五', 'B', 15)
    ]);
    const second = blocks.find(b => b.topic === 'B');
    const rs = resolveSecondTopicByLadder(blocks, second, {
      ladderReady: true, ladderTopicGroups: [{ topic: 'A', count: 6 }]
    }, ['A']);
    expect(rs.replaced).toBe(false);
    expect(rs.block.topic).toBe('B');
    expect(rs.notes.join('｜')).toContain('同题材不重复入选');
  });

  it('连板天梯未就绪 → 沿用第 2 名题材并如实说明（§10 不猜）', () => {
    const blocks = blocksOf(10);
    const second = blocks.find(b => b.topic === 'A');
    const rs = resolveSecondTopicByLadder(blocks, second, {
      ladderReady: false, ladderReason: '未加载', ladderTopicGroups: []
    });
    expect(rs.replaced).toBe(false);
    expect(rs.notes.join('｜')).toContain('未做「题材数量对比」');
  });
});

// === [2026-09-26] ⑥ 无一字 + 大题材（≥10 只）→ 各取龙一轻仓 ===
describe('buildBigTopicPlan（无一字 · 大题材兜底）', () => {
  const rowsOf = (n1, n2) => {
    const rows = [];
    for (let i = 1; i <= n1; i++) rows.push(E('A' + i, 'A', 100 - i));
    for (let i = 1; i <= n2; i++) rows.push(E('B' + i, 'B', 90 - i));
    return rows;
  };

  it('全部题材 0 一字 + 两个题材都 ≥ 10 只 → 各取龙一轻仓（9/4：17 只 / 10 只）', () => {
    const blocks = rankDecisionTopics(rowsOf(BIG_TOPIC_MIN_COUNT + 7, BIG_TOPIC_MIN_COUNT));
    const plan = buildBuyPlan(blocks, rankDragons(blocks), { ladderReady: false });
    expect(blocks[0].count).toBeGreaterThanOrEqual(BIG_TOPIC_MIN_COUNT);
    expect(plan.bigTopic).not.toBe(null);
    expect(plan.noYizi).toBe(null);
    expect(plan.bigTopic.blocks.length).toBe(2);
    expect(plan.bigTopic.blocks[0].picks.length).toBe(1);
    expect(plan.bigTopic.blocks[0].picks[0].dragonLabel).toBe('龙一');
    expect(plan.bigTopic.blocks[0].picks[0].position).toBe(POSITION_LIGHT);
  });

  it('不足 10 只 → 不走大题材，回到原来的「题材连扳」兜底', () => {
    const blocks = rankDecisionTopics(rowsOf(5, 4));
    const plan = buildBuyPlan(blocks, rankDragons(blocks), { ladderReady: false });
    expect(plan.bigTopic).toBe(null);
    expect(plan.noYizi).not.toBe(null);
  });
});

// === [2026-09-26] ⑦ 灰行（不在正式列表）也能被选进买点 ===
describe('灰行参与选票（GRAY-DRAGON）', () => {
  // T = 第 1 名（2 个一字，龙一是灰行「老龙」），X = 第 2 名（0 一字）
  it('第 1 名题材的龙一是灰行 → 照常入选重仓（9/8 大消费 · 国芳集团）', () => {
    const blocks = rankDecisionTopics([
      E('老龙灰行', 'T', 96, false, false, 2),      // countable=false 灰行，十日涨幅最高 = 龙一
      E('T一字一', 'T', 80, true), E('T一字二', 'T', 70, true),
      E('T四', 'T', 60, false, true, 1), E('T五', 'T', 50, false, true, 0.5),
      // ⛔ T 的正式成员必须 ≥5 只：≤4 只 + 2 个一字会被 ⑥ 小题材兜底截走
      E('T六', 'T', 45, false, true, 0.2),
      E('X一', 'X', 40), E('X二', 'X', 30)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks[0].name).toBe('老龙灰行');
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    // 数量统计仍然只数正式成员（灰行不计入）：共 6 只，其中灰行 1 只 → 5 只
    expect(plan.heavy.block.count).toBe(5);
  });

  it('第 2 名题材的龙一是灰行 → 照常入选轻仓（9/8 农业 · 万向德农）', () => {
    const blocks = rankDecisionTopics([
      E('T一', 'T', 60, true), E('T二', 'T', 50, true), E('T三', 'T', 40),
      E('T四', 'T', 30), E('T五', 'T', 20),
      E('农业老龙', 'X', 82, false, false, -1),     // 灰行龙一（低开也照样入选，见 ④ 只提醒）
      E('X二', 'X', 30), E('X三', 'X', 20)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.light.picks.map(p => p.name)).toEqual(['农业老龙']);
    expect(plan.light.notes.join('｜')).toContain('直接买龙一');
  });
});

// === [2026-09-26] 买点里同一个题材不能重复出现 ===
describe('同题材不重复入选', () => {
  it('第 2 名题材若与第 1 名同题材 → 该档不出现（买点里每个题材只出现一次）', () => {
    const blocks = rankDecisionTopics([
      E('A一', 'A', 60, true), E('A二', 'A', 50, true), E('A三', 'A', 40),
      E('A四', 'A', 30), E('A五', 'A', 20)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      // 天梯第一也是 A（已经在买点里）→ 不做替换
      ladderReady: true, ladderTopicGroups: [{ topic: 'A', count: 6 }]
    });
    expect(plan.heavy).not.toBe(null);
    expect(plan.light).toBe(null);
  });

  it('替换后与第 1 名同题材 → 直接丢弃这一档，不留重复题材', () => {
    const blocks = rankDecisionTopics([
      E('A一', 'A', 60, true), E('A二', 'A', 50, true), E('A三', 'A', 40),
      E('A四', 'A', 30), E('A五', 'A', 20),
      E('B一', 'B', 55, true), E('B二', 'B', 45), E('B三', 'B', 35),
      E('B四', 'B', 25), E('B五', 'B', 15)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      ladderReady: true, ladderTopicGroups: [{ topic: 'A', count: 6 }]
    });
    // 第 2 名 B 只有 1 个一字 → 会尝试替换成天梯第一 A，但 A 已入选 → 回到 B，两者不同名 → 保留
    expect(plan.light).not.toBe(null);
    expect(plan.light.block.topic).toBe('B');
    expect(plan.light.notes.join('｜')).toContain('同题材不重复入选');
  });
});

// === [2026-09-26] ④ 龙一低开 → 只加「跌停 L 形 → 尾盘买」提醒文字 ===
describe('低开龙一的 L 形提醒（只提醒、不改选票）', () => {
  // T = 第 1 名（1 个一字，龙一不是一字）；X = 第 2 名（0 一字）
  const lowOpenRows = (aucOfDragonOne) => [
    E('龙头票', 'T', 90, false, true, aucOfDragonOne),
    E('T一字', 'T', 80, true),
    E('股3', 'T', 70, false, true, 3),
    // ⛔ T 必须凑够 5 只：≤4 只 + 1 个一字会被 ⑥ 小题材兜底截走，就测不到常规档位
    E('股4', 'T', 60, false, true, 1), E('股5', 'T', 50, false, true, 2),
    E('X一', 'X', 50), E('X二', 'X', 40), E('X三', 'X', 30)
  ];

  it('龙一竞价低开 → 买点块里出现 L 形提醒，且选票结果不变', () => {
    const blocks = rankDecisionTopics(lowOpenRows(-4));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy).not.toBe(null);
    const joined = (plan.heavy.notes || []).join('｜');
    expect(joined).toContain('跌停 L 形');
    expect(joined).toContain('尾盘买');
    // 提醒不改结果：龙一仍然是重仓票
    expect(plan.heavy.picks[0].name).toBe('龙头票');
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
  });

  it('龙一高开 → 不出现该提醒', () => {
    const blocks = rankDecisionTopics(lowOpenRows(4));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect((plan.heavy.notes || []).join('｜')).not.toContain('跌停 L 形');
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

  it('规则说明必须覆盖【无一字弱市兜底 ⑤】（连板天梯 · 题材连扳）', () => {
    const text = lines.join('\n');
    expect(text).toContain('连板天梯');
    expect(text).toContain('股票数量最多');
    expect(text).toContain('并列');
    expect(text).toContain('两只都高开');
    expect(text).toContain('两只都低开');
    expect(text).toContain('空仓');
    expect(text).toContain('不足 ' + NO_YIZI_MIN_TOPIC_COUNT + ' 只');
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
