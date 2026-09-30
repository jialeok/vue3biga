// decision-rules.test.js — 「决策」看板规则回归用例
//
// 钉住三件事（后期改规则时先看这里）：
//   ① 题材排名必须与早盘竞价「题材 toggle」同源（复用 sortByTopicGroups，不另写比较器）；
//   ② 买点必须【跳过竞价一字】再按龙头顺序取（一字买不进）；
//   ③ 卖点时点（第二层 · 兜底）：题材排前二 → 14:50，否则 → 11:20；
//   ④ 卖点细分（第一层 · 优先，[SELL-OPEN 2026-09-29]）：按【今日竞价涨幅】分三档 ——
//      ≤ -3% → 盯盘（10:00 前定夺）｜(-3%, 0) → 开盘立刻出（❗危）｜(0, +3%) → 看分时（向上 11:20、走弱立刻）；
//      未命中（≥ +3% / 平开 / 缺竞价涨幅）→ 不产提示，回落 ③ 的题材排名时点。
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
  SELL_DEEP_LOW,
  SELL_MILD_HIGH,
  SELL_TONE_DANGER,
  SELL_TONE_WATCH,
  SELL_TONE_PLAN,
  POSITION_HEAVY,
  POSITION_LIGHT,
  HOLD_TAG,
  PREV_BOUGHT_TAG,
  BUY_COUNT_MAX_SMALL,
  BUY_COUNT_MAX_MID,
  RULE_NO,
  ruleTag,
  DUAL_MAIN_MIN_COUNT
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

/**
 * [BUY-COUNT 2026-09-27] 造 n 只「凑数票」把题材撑到 > 10 只。
 *
 * 为什么必须撑：新规则「第 1 名题材 ≤6 只最多买 1 只 / ≤10 只最多买 2 只」会砍票，
 *   而 ①②③④ 的常规档位用例原来【只有 5 只】（>4 只是为了避开 ⑥ 小题材兜底），
 *   不撑就会被砍成 1 只 → 常规档位根本测不到。
 *
 * 凑数票刻意设定为：非一字 + 计入数量 + 十日涨幅极低（排到龙位末尾，不影响龙一~龙五）。
 *
 * ⚠️ 竞价涨幅设为【+0.1（小高开）】而不是 null，是刻意的：
 *    ⑧「弱势题材」规则的分母 = 题材股票总数，缺竞价涨幅的行按【未高开】计入分母。
 *    凑数票若填 null，会把样例题材的高开率一路拉到 0%，于是每个 > 10 只的用例
 *    都被⑧砍成「只买龙一轻仓」—— 那就测不到 ①②③④ 的常规档位了。
 *    +0.1 又足够小，不会在 pickHeavyTwo 里抢走「竞价涨幅最高」那一只（真实票都 ≥ 1%）。
 */
function FILLER(topic, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(E('凑' + topic + (i + 1), topic, -100 - i, false, true, 0.1));
  return out;
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
  // [2026-09-27 修正] 「昨日卖标签继承」的行（早盘竞价里是灰色实心卖标签）【照常占龙位】：
  //   9/8 大消费龙一国芳集团就是这种行，上一版把它过滤掉 ⇒ 第一买点没选进来。
  it('「昨日卖标签继承」的行（inheritSold）【照常占龙位】', () => {
    const blocks = rankDecisionTopics([
      // countable=false（统计不计它）+ inheritSold=true（昨日卖标签继承）——两者在采集层成对出现
      E('卖标签继承', 'T1', 99, false, false, null, '', true), E('正式一', 'T1', 30), E('正式二', 'T1', 20)
    ]);
    expect(blocks[0].count).toBe(2);                 // 统计仍只数正式成员
    const dragon = rankDragons(blocks);
    expect(dragon.get('卖标签继承').rank).toBe(1);
    expect(dragon.get('正式一').rank).toBe(2);
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
  // T1：11 只、2 个一字（排名第一）；T2 / T3：0 个一字，各 2 只 → T2 排第二、T3 排第三
  // ⛔ T1 刻意撑到 11 只（> BUY_COUNT_MAX_MID）：
  //    ① ≤4 只会命中 ⑥「小题材 + 一字」高风险兜底，被它截走就测不到常规档位；
  //    ② [BUY-COUNT 2026-09-27] ≤6 / ≤10 只会被「买入只数」规则砍成 1 / 2 只，
  //       同样测不到 ①②③④ 的完整档位 —— 所以这里补 6 只凑数票撑过 10 只。
  const entries = [
    E('一字A', 'T1', 40, true, true, 10), E('一字B', 'T1', 39, true, true, 9.98),
    E('可买C', 'T1', 30, false, true, 3), E('可买D', 'T1', 20, false, true, 2),
    E('可买E', 'T1', 5, false, true, 1),
    // ⛔ T2 必须带 aucPct：第 2 名题材现在只选【竞价高开】的票，缺竞价涨幅 → 选不出来
    E('T2一', 'T2', 10, false, true, 2), E('T2二', 'T2', 9, false, true, -1),
    E('T3一', 'T3', 5), E('T3二', 'T3', 4)
  ].concat(FILLER('T1', 6));

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
    ].concat(FILLER('T1', 6)));   // ⛔ 撑过 10 只，否则「买入只数」会砍成 2 只
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
    ].concat(FILLER('T1', 6)));   // ⛔ 撑过 10 只，否则「买入只数」会砍成 1 只
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
    // ⛔ 2026-09-27：理由尾部会追加「→ 根据规则①」出处（用户要求像法律条文能查出处），故改用 toContain
    expect(plan.heavy.reason).toContain('题材排第一，股票数量11只，2个竞价一字');
    expect(plan.heavy.reason).toContain('根据规则' + RULE_NO.HEAVY_DOUBLE);
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

// === [2026-09-29] 买点行也挂【竞价涨幅】徽标（与卖点同款：涨红底 / 跌绿底 / 平灰底） ===
// 位置：紧随「十日涨幅」之后。文本 / 配色全部由 Logic 层派生（§21 模板零计算），
// 且必须走与卖点【同一份】formatAucPct + getAucOpenKind（§6），所以这里逐档钉死输出。
describe('买点 · 竞价涨幅徽标（AUC-BADGE）', () => {
  // 第 1 名题材 X（2 个一字）扛住排名 → 第 2 名题材 T 落到「龙一优先」档，
  // 而那一档【不看竞价涨跌幅】都会买龙一 ⇒ 一个场景就能喂进任意 aucPct，逐档验证徽标。
  const run = (aucPct) => {
    const blocks = rankDecisionTopics(headTopic.concat([
      E('股1', 'T', 90, false, true, aucPct),
      E('股2', 'T', 80, false, true, 5)
    ]));
    return buildBuyPlan(blocks, rankDragons(blocks)).light.picks[0];
  };

  it('竞价高开 → 补 "+"、tone=high（UI 映射红底）', () => {
    const p = run(2.35);
    expect(p.aucPctText).toBe('+2.35%');
    expect(p.aucTone).toBe('high');
  });

  it('竞价低开 → 带 "-"、tone=low（UI 映射绿底）', () => {
    const p = run(-6);
    expect(p.aucPctText).toBe('-6.00%');
    expect(p.aucTone).toBe('low');
  });

  it('恰好平开 → 0.00%、tone=flat（UI 映射灰底）', () => {
    const p = run(0);
    expect(p.aucPctText).toBe('0.00%');
    expect(p.aucTone).toBe('flat');
  });

  it('缺竞价涨幅 → 文本空串（模板 v-if 不渲染，§10 绝不补 0.00% 伪装成平开）', () => {
    const p = run(null);
    expect(p.aucPctText).toBe('');
    expect(p.aucTone).toBe('');
  });

  it('第 1 名题材（重仓档）也带徽标 —— 两个收口函数都要覆盖，别只改了一个', () => {
    // T1 撑到 6 只：>4 只避开 ⑥ 小题材兜底，又 ≤6 只 ⇒ 「买入只数」砍成 1 只（保留龙位最靠前那只）
    const blocks = rankDecisionTopics([
      E('一A', 'T1', 40, true, true, 10), E('一B', 'T1', 39, true, true, 9.98),
      E('大A', 'T1', 30, false, true, 1.5), E('大B', 'T1', 20, false, true, -2)
    ].concat(FILLER('T1', 2)));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.length).toBe(1);
    const p0 = plan.heavy.picks[0];
    expect(p0.name).toBe('大A');
    expect(p0.aucPctText).toBe('+1.50%');
    expect(p0.aucTone).toBe('high');
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

  // 9/8 大消费原型：龙一国芳集团（灰名 + 灰题材 + 灰色实心卖标签），龙二~龙五全是竞价一字
  // （其中还有灰行的一字）→ 只能跳过一字，往下取龙六云南旅游。
  it('龙一=卖标签继承的灰行 + 龙二~龙五全是一字 → 龙一重仓 + 龙六重仓（9/8 大消费）', () => {
    const blocks = rankDecisionTopics([
      E('国芳集团', 'T', 96, false, false, 2, '', true),   // 龙一：灰行 + 昨日卖标签继承
      E('一字二', 'T', 80, true),
      E('一字三', 'T', 70, true, false),                   // 灰行的一字，同样买不进
      E('一字四', 'T', 60, true),
      E('一字五', 'T', 50, true),
      E('云南旅游', 'T', 40, false, true, 5),              // 龙六 → 选它
      E('补充', 'T', 30, false, true, 1),                  // ⛔ 让正式成员凑够 5 只，避开 ⑥ 兜底
      E('X一', 'X', 20), E('X二', 'X', 10)
    ].concat(FILLER('T', 6)));   // ⛔ 撑过 10 只，否则「买入只数」会把云南旅游砍掉
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['国芳集团', '云南旅游']);
    expect(plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_HEAVY]);
    // 统计口径不变：灰行不计入数量（正式成员 = 5 只真实票 + 6 只凑数票 = 11 只）
    expect(plan.heavy.block.count).toBe(11);
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

// === [SELL-OPEN 2026-09-29] 卖点按【今日竞价高低开】细分（第一层，优先于题材排名时点）===
describe('卖点 · 竞价高低开细分（SELL-OPEN）', () => {
  // T1 排第一（2 个一字）、T2 排第二 —— 兜底时点是 14:50 / 14:50
  const blocks = rankDecisionTopics([
    E('T1一', 'T1', 30, true), E('T1二', 'T1', 20, true), E('T1三', 'T1', 10),
    E('T2一', 'T2', 9), E('T2二', 'T2', 8)
  ]);
  const dragon = rankDragons(blocks);

  /** 造一只「昨日买了、今天要卖」的票，指定【今日竞价涨幅】 */
  function sellRow(name, topic, aucPct) {
    return { name: name, topic: topic, pct: 10, aucPct: aucPct, inTodayList: true };
  }

  it('深低开（≤ -3%）→ 盯盘「10:00 前定夺」，题材排第 1 的兜底时点仍是 14:50', () => {
    const plan = buildSellPlan([sellRow('T1三', 'T1', -3)], blocks, dragon, new Set());
    const it0 = plan[0].items[0];
    expect(it0.sellHint.tone).toBe(SELL_TONE_WATCH);
    expect(it0.sellHint.timeLabel).toContain('10:00');
    expect(it0.sellHint.text).toContain('10:00 前看有没有反弹');
    expect(it0.sellHint.text).toContain('反弹不起来');
    // 规则不变：兜底 sellAt 照旧算出来（只是被提示顶替显示）
    expect(it0.sellAt).toBe(SELL_TIME_CLOSE);
  });

  it('深低开边界：-5%（用户原话那一档）与 -3% 同档；-2.9% 不算深低开', () => {
    const deep = buildSellPlan([sellRow('T1三', 'T1', -5)], blocks, dragon, new Set());
    expect(deep[0].items[0].sellHint.tone).toBe(SELL_TONE_WATCH);
    const mild = buildSellPlan([sellRow('T1三', 'T1', -2.9)], blocks, dragon, new Set());
    expect(mild[0].items[0].sellHint.tone).toBe(SELL_TONE_DANGER);
  });

  it('小低开（-3% ~ 0）→ 开盘立刻出 + 「❗危」警示', () => {
    const plan = buildSellPlan([sellRow('T1三', 'T1', -1.2)], blocks, dragon, new Set());
    const it0 = plan[0].items[0];
    expect(it0.sellHint.tone).toBe(SELL_TONE_DANGER);
    expect(it0.sellHint.badge).toContain('危');
    expect(it0.sellHint.timeLabel).toBe('开盘立刻出');
    expect(it0.sellHint.text).toContain('立刻出');
  });

  it('小幅高开（0 ~ +3%）→ 看分时：向上拿到 11:20 卖、走弱立刻卖', () => {
    const plan = buildSellPlan([sellRow('T1三', 'T1', 1.5)], blocks, dragon, new Set());
    const it0 = plan[0].items[0];
    expect(it0.sellHint.tone).toBe(SELL_TONE_PLAN);
    expect(it0.sellHint.text).toContain('分时整体曲线');
    expect(it0.sellHint.text).toContain(SELL_TIME_MIDDAY);
    expect(it0.sellHint.text).toContain('立刻卖');
  });

  // [AUC-BADGE 2026-09-29] 行内「竞价涨幅」标签：文本与配色档都必须由 Logic 层算好（模板零计算 §21）
  it('行内竞价涨幅标签：文本固定 2 位小数，配色档 high / low / flat，缺数据整条不产', () => {
    [
      [1.2, '+1.20%', 'high'],     // 涨 → 红底
      [-2.6, '-2.60%', 'low'],     // 跌 → 绿底
      [0, '0.00%', 'flat'],        // 平 → 灰底
      [null, '', '']               // §10 缺数据 → 空串 + 空档 ⇒ 组件不渲染，绝不当平开
    ].forEach(function(c) {
      const plan = buildSellPlan([sellRow('T1三', 'T1', c[0])], blocks, dragon, new Set());
      const it0 = plan[0].items[0];
      expect(it0.aucPctText).toBe(c[1]);
      expect(it0.aucTone).toBe(c[2]);
    });
  });

  it('竞价涨幅标签的配色档与「开平方向」同源：涨红 / 跌绿 / 平灰（涨红跌绿，国内惯例）', () => {
    const up = buildSellPlan([sellRow('T1三', 'T1', 2)], blocks, dragon, new Set());
    expect(up[0].items[0].aucTone).toBe('high');
    const down = buildSellPlan([sellRow('T1三', 'T1', -2)], blocks, dragon, new Set());
    expect(down[0].items[0].aucTone).toBe('low');
    const flat = buildSellPlan([sellRow('T1三', 'T1', 0)], blocks, dragon, new Set());
    expect(flat[0].items[0].aucTone).toBe('flat');
  });

  it('未命中三档（≥ +3% / 恰好平开 / 缺竞价涨幅）→ 不产提示，回落题材排名时点', () => {
    [3, 5, 0, null].forEach(function(auc) {
      const plan = buildSellPlan([sellRow('T1三', 'T1', auc)], blocks, dragon, new Set());
      const it0 = plan[0].items[0];
      expect(it0.sellHint).toBe(null);
      expect(it0.sellAt).toBe(SELL_TIME_CLOSE);   // 题 1 → 14:50（原规则不变）
    });
  });

  it('§10：缺竞价涨幅【不】退化成「平开」去套档（不产提示、不抛错）', () => {
    const plan = buildSellPlan(
      [{ name: 'T1三', topic: 'T1', pct: 10, inTodayList: true }],   // 完全没有 aucPct 字段
      blocks, dragon, new Set()
    );
    expect(plan[0].items[0].aucPct).toBe(null);
    expect(plan[0].items[0].aucPctText).toBe('');
    expect(plan[0].items[0].aucTone).toBe('');
    expect(plan[0].items[0].sellHint).toBe(null);
  });

  it('今天又进买点（【持有 / 加仓】）→ 不产卖点提示（它本来就不卖）', () => {
    const plan = buildSellPlan(
      [sellRow('T1三', 'T1', -1.2)], blocks, dragon, new Set(), new Set(['T1三'])
    );
    const it0 = plan[0].items[0];
    expect(it0.holdTag).toBe(HOLD_TAG);
    expect(it0.sellHint).toBe(null);
  });

  it('档位阈值就是顶部常量本身（改档位只改常量，不散落字面量）', () => {
    expect(SELL_DEEP_LOW).toBe(-3);
    expect(SELL_MILD_HIGH).toBe(3);
    expect(SELL_TONE_DANGER).toBe('danger');
    expect(SELL_TONE_WATCH).toBe('watch');
    expect(SELL_TONE_PLAN).toBe('plan');
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

  it('规则说明必须覆盖【卖点按今日竞价高低开细分】（SELL-OPEN 第一层）', () => {
    const text = lines.join('\n');
    expect(text).toContain('按今日竞价高低开细分');     // 第一层标题
    expect(text).toContain('盯盘');                     // 深低开
    expect(text).toContain('立刻出');                   // 小低开
    expect(text).toContain('危');                       // 小低开的感叹号警示
    expect(text).toContain('分时整体曲线');             // 小幅高开
    expect(text).toContain('题材排名兜底时点');         // 第二层标题
    expect(text).toContain(String(SELL_DEEP_LOW) + '%');
    expect(text).toContain('+' + SELL_MILD_HIGH + '%');
  });

  it('规则说明必须覆盖【行内竞价涨幅标签】（涨红底 / 跌绿底 / 平灰底）', () => {
    const text = lines.join('\n');
    expect(text).toContain('【竞价涨幅】小标签');
    expect(text).toContain('红底');
    expect(text).toContain('绿底');
    expect(text).toContain('灰底');
    expect(text).toContain('不显示这个标签');          // §10 缺数据不画成平开
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

// === [2026-09-27] 一 · 亏钱效应：题材里有【竞价一字跌停】 → 只买龙一 + 只轻仓 ===
describe('亏钱效应（LOSS-EFFECT）', () => {
  /**
   * 农业原型：龙一敦煌种业（非一字）+ 2 个竞价一字 + 1 只竞价一字跌停（跌停票）。
   * @param {number|null} dianTingAuc 跌停票的竞价涨幅（null = 缺数据，用来验证 §10）
   */
  const nongYe = (dianTingAuc, fillerN) => [
    E('敦煌种业', '农业', 80, false, true, 3),      // 龙一
    E('农业一字A', '农业', 70, true),
    E('农业一字B', '农业', 65, true),
    E('跌停票', '农业', 60, false, true, dianTingAuc),
    E('农业五', '农业', 55, false, true, 4),
    E('X一', 'X', 20), E('X二', 'X', 10)
  ].concat(FILLER('农业', fillerN));

  it('9/11 农业 12 只：有 1 只竞价一字跌停 → 只买敦煌种业（龙一、轻仓）', () => {
    const rows = nongYe(-10, 7);                     // 5 只真实票 + 7 只凑数 = 12 只
    const blocks = rankDecisionTopics(rows);
    expect(blocks[0].count).toBe(12);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    // 不加亏钱效应时本来是「龙一重仓 + 龙二/龙三」，加了之后只剩龙一
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(plan.heavy.picks[0].dragonLabel).toBe('龙一');
    expect(plan.heavy.picks[0].position).toBe(POSITION_LIGHT);
    expect(plan.heavy.notes.join('｜')).toContain('亏钱效应');
    expect(plan.heavy.notes.join('｜')).toContain('只买龙一');
  });

  it('9/10 农业 11 只（1 个一字 + 跌停票）→ 同样只买敦煌种业、轻仓', () => {
    const rows = [
      E('敦煌种业', '农业', 80, false, true, 3),
      E('农业一字', '农业', 70, true),
      E('跌停票', '农业', 60, false, true, -9.98),   // 主板跌停 -10%（容差内）
      E('农业四', '农业', 55, false, true, 4),
      E('农业五', '农业', 50, false, true, 2),
      E('X一', 'X', 20), E('X二', 'X', 10)
    ].concat(FILLER('农业', 6));                      // 5 + 6 = 11 只
    const blocks = rankDecisionTopics(rows);
    expect(blocks[0].count).toBe(11);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(plan.heavy.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('题材里没有竞价一字跌停 → 不受影响（龙一仍然是重仓）', () => {
    const rows = nongYe(-2, 7);                      // 只是低开，不是跌停
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain('亏钱效应');
    expect(plan.heavy.picks[0].name).toBe('敦煌种业');
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    // 常规「①双票重仓」不受影响：龙一 + 涨幅最高的农业五（重仓）+ 名次第二的跌停票（轻仓，发生卡位）
    expect(plan.heavy.picks.length).toBe(3);
  });

  it('§10：竞价涨幅缺失的票【不算】一字跌停，不触发亏钱效应', () => {
    const rows = nongYe(null, 7);
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain('亏钱效应');
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
  });
});

// === [2026-09-27 修复] 亏钱效应必须覆盖【收盘跌停】（9/10 农业 · 泸天化）===
// 事故现场：9/10 当天全市场【没有任何一只】竞价打到跌停价（最深就是泸天化的 -7.69%），
//   而泸天化【收盘 -10.00%】躺在跌停板里 —— 用户盯的就是这一档。
//   只判「竞价」时这条规则在复盘日一半日期都失灵，必须补上收盘那一档。
/**
 * 12 只农业原型（全部行都有竞价涨幅，便于算高开率）：
 *   龙一敦煌种业（+3）+ 2 个竞价一字（+10 / +9.98，当然也算高开）+ 9 只普通票。
 * @param {number} extraHigh 9 只普通票里有几只是【竞价高开】的 → 高开总数 = 3 + extraHigh
 */
function NONGYE12(extraHigh) {
  const rows = [
    E('敦煌种业', '农业', 80, false, true, 3),
    E('农业一字A', '农业', 75, true, true, 10),
    E('农业一字B', '农业', 72, true, true, 9.98)
  ];
  ['票C', '票D', '票E', '票F', '票G', '票H', '票I', '票J', '票K'].forEach(function(n, i) {
    const isHigh = i < extraHigh;
    rows.push(E(n, '农业', 70 - i * 5, false, true, isHigh ? (2 + i * 0.1) : (-1 - i * 0.3)));
  });
  return rows;
}
describe('⑧ 弱势题材：大题材却没人高开（WEAK-OPEN）', () => {
  it('9/11 农业 12 只、只有 3 只竞价高开（25% < 35%）→ 只买敦煌种业（龙一、轻仓）', () => {
    const blocks = rankDecisionTopics(NONGYE12(0));
    expect(blocks[0].count).toBe(12);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(plan.heavy.picks[0].dragonLabel).toBe('龙一');
    expect(plan.heavy.picks[0].position).toBe(POSITION_LIGHT);
    const notes = plan.heavy.notes.join('｜');
    expect(notes).toContain('题材虚胖');
    expect(notes).toContain('25%');
  });

  it('12 只里 5 只高开（约 42% ≥ 35%）→ 不触发，回到常规「双票重仓」档位', () => {
    const blocks = rankDecisionTopics(NONGYE12(2));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain('题材虚胖');
    expect(plan.heavy.picks.length).toBeGreaterThan(1);
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
  });

  it('≤ 10 只不看这条（交给「买入只数」管），不触发', () => {
    const blocks = rankDecisionTopics([
      E('敦煌种业', '农业', 80, false, true, 3),
      E('农业一字A', '农业', 75, true, true, 10),
      E('票C', '农业', 70, false, true, -1),
      E('票D', '农业', 65, false, true, -2),
      E('票E', '农业', 60, false, true, -3),
      E('票F', '农业', 55, false, true, -4),
      E('票G', '农业', 50, false, true, -5),
      E('票H', '农业', 45, false, true, -6)
    ]);
    expect(blocks[0].count).toBe(8);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain('题材虚胖');
  });

  it('§10：一只都没有竞价涨幅 → 高开率是未知，不触发（不算「没人高开」），且如实说明', () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(E('无数据' + i, '农业', 100 - i, i <= 2));
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain('题材虚胖');
    expect(plan.heavy.notes.join('｜')).toContain('无法判定竞价高开率');
  });

  it('亏钱效应与弱势题材同时命中时，只出一条「只买龙一轻仓」结论（不重复砍）', () => {
    const rows = NONGYE12(0).map(function(r) {
      return r.name === '票C' ? E(r.name, '农业', r.pct, false, true, -10, '000930') : r;
    });
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(plan.heavy.picks[0].position).toBe(POSITION_LIGHT);
    expect(plan.heavy.notes.join('｜')).toContain('竞价一字跌停');
    expect(plan.heavy.notes.join('｜')).toContain('题材虚胖');
  });
});

// === [2026-09-27 事故回归] ⑧ 弱势题材【也必须覆盖兜底方案】 ===
// 事故：9/11 农业 12 只、只有 3 只竞价高开（25% < 35%），用户预期「只选龙一敦煌种业轻仓」，
//   实际却选出 2 只（敦煌种业 + 新农开发）。根因不是阈值、也不是分母口径：
//   当天第 1 名题材 = 电力新能源（4 只 / 1 个一字）命中「高风险小题材」，
//   buildBuyPlan 走 ⑥ 兜底（smallTopic）→ 由「题材连扳里数量最多」挑中农业，
//   而兜底方案走的是 _finishPlanBlocks —— 上一版那里【只调了 _applyLossEffect】，
//   ⑧ 在这条链路上从未被调用过 ⇒ 规则形同虚设。
// ⛔ 规则是「入选题材」的筛选条件，与它是被哪条规则选中的无关 —— 所有买点块必须一视同仁。
describe('⑧ 弱势题材也覆盖【兜底方案】（WEAK-OPEN · FALLBACK）', () => {
  /** 造一个「题材连扳」分组 */
  function LG(topic, n) { return { topic: topic, count: n, rows: [] }; }

  /**
   * 9/11 真实形态：
   *   · 第 1 名题材 = 电力新能源（4 只 / 1 个一字）→ isSmallRiskyTopic ⇒ 走 ⑥ smallTopic 兜底；
   *   · 题材连扳里数量最多的是农业（12 只）→ 兜底方案挑中农业；
   *   · 农业 12 只里只有 3 只竞价高开（敦煌种业 +1.75 / 新农开发 +7.68 / 天禾股份 +1.59）= 25%。
   */
  function nongYe0911() {
    const rows = [
      E('闽东电力', '电力新能源', 39.92, true, true, 9.98, '000993'),
      E('电票B', '电力新能源', 30, false, true, -1),
      E('电票C', '电力新能源', 20, false, true, -2),
      E('电票D', '电力新能源', 10, false, true, -3),
      E('中新赛克', 'AI应用', 41.24, true, true, 10.01, '605398'),
      E('A票B', 'AI应用', 20, false, true, -1),
      E('A票C', 'AI应用', 10, false, true, -2),
      E('敦煌种业', '农业', 33.61, false, true, 1.75, '600354'),
      E('新农开发', '农业', 20, false, true, 7.68, '600359'),
      E('天禾股份', '农业', 16, false, true, 1.59, '002999'),
      E('金正大', '农业', 14, false, true, 0, '002470')
    ];
    ['农票E', '农票F', '农票G', '农票H', '农票I', '农票J', '农票K', '农票L'].forEach(function(n, i) {
      rows.push(E(n, '农业', 12 - i, false, true, -1 - i * 0.5));
    });
    return rows;
  }

  function plan0911() {
    const blocks = rankDecisionTopics(nongYe0911());
    return {
      blocks: blocks,
      plan: buildBuyPlan(blocks, rankDragons(blocks), {
        ladderTopicGroups: [LG('农业', 12), LG('电力新能源', 4), LG('AI应用', 3)],
        ladderReady: true
      })
    };
  }

  it('确实是走 ⑥ 兜底方案挑中农业的（先钉死事故现场，别让回归测试测了个空）', () => {
    const r = plan0911();
    expect(r.plan.smallTopic).not.toBeNull();
    expect(r.plan.heavy).toBeNull();
    expect(r.plan.smallTopic.blocks.map(b => b.block.topic)).toEqual(['农业', '电力新能源']);
    expect(r.blocks.find(b => b.topic === '农业').count).toBe(12);
  });

  it('9/11 农业 12 只 / 3 只高开（25%）→ 兜底块也只留【龙一敦煌种业】，且轻仓', () => {
    const r = plan0911();
    const nong = r.plan.smallTopic.blocks.find(b => b.block.topic === '农业');
    expect(nong.block.count).toBe(12);
    expect(nong.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(nong.picks[0].dragonLabel).toBe('龙一');
    expect(nong.picks[0].position).toBe(POSITION_LIGHT);
    const notes = nong.notes.join('｜');
    expect(notes).toContain('题材虚胖');
    expect(notes).toContain('25%');
  });

  it('兜底块【members 必须带上】：⑧ 靠它数高开只数，缺了就静默不生效', () => {
    const r = plan0911();
    r.plan.smallTopic.blocks.forEach(function(b) {
      expect(Array.isArray(b.block.members)).toBe(true);
      expect(b.block.members.length).toBeGreaterThan(0);
    });
  });

  it('≤ 10 只的兜底块不受 ⑧ 影响（电力新能源 4 只照常选票）', () => {
    const r = plan0911();
    const dian = r.plan.smallTopic.blocks.find(b => b.block.topic === '电力新能源');
    expect(dian.block.count).toBe(4);
    expect(dian.notes.join('｜')).not.toContain('题材虚胖');
    expect(dian.picks.length).toBeGreaterThan(0);
  });

  // ⓘ noYizi 只在第 1 / 第 2 名题材【都 < BIG_TOPIC_MIN_COUNT(10) 只】时才走得到，
  //   所以 ⑧（要 > 10 只）在那条链路上天然不会命中；这里钉的是同一处修复的【另一半】：
  //   ⑦ 亏钱效应此前也因为 members 缺失而在兜底方案里静默失效。
  it('无一字兜底（noYizi）块同样带 members，⑦ 亏钱效应一样生效', () => {
    const rows = [
      E('农龙一', '农业', 60, false, true, 3, '600354'),
      E('农龙二', '农业', 50, false, true, 5, '600359'),
      E('农票3', '农业', 40, false, true, -10, '000930')      // 竞价一字跌停
    ];
    for (let i = 4; i <= 8; i++) rows.push(E('农票' + i, '农业', 40 - i, false, true, -1));
    const blocks = rankDecisionTopics(rows);
    expect(blocks[0].count).toBe(8);                          // < 10 ⇒ 不会先被「大题材兜底」截走
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      ladderTopicGroups: [LG('农业', 8)],
      ladderReady: true
    });
    expect(plan.noYizi).not.toBeNull();
    const b0 = plan.noYizi.blocks[0];
    expect(b0.block.members.length).toBe(8);
    expect(b0.picks.map(p => p.name)).toEqual(['农龙一']);
    expect(b0.picks[0].position).toBe(POSITION_LIGHT);
    expect(b0.notes.join('｜')).toContain('竞价一字跌停');
  });
});

// === [2026-09-27] 二 · 买入只数：第 1 名题材按【早盘竞价股票数】限制买几只 ===
describe('买入只数（BUY-COUNT）', () => {
  it('9/18 AI应用 ≤ ' + BUY_COUNT_MAX_SMALL + ' 只 → 最多买 1 只', () => {
    const blocks = rankDecisionTopics([
      E('AI龙一', 'AI应用', 90, false, true, 5),
      E('AI一字A', 'AI应用', 80, true),
      E('AI一字B', 'AI应用', 70, true),
      E('AI四', 'AI应用', 60, false, true, 3),
      E('AI五', 'AI应用', 50, false, true, 2),
      E('AI六', 'AI应用', 40, false, true, 1),
      E('X一', 'X', 20), E('X二', 'X', 10)
    ]);
    expect(blocks[0].count).toBe(BUY_COUNT_MAX_SMALL);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    // 常规档位（2 个一字）本来是「龙一重仓 + 涨幅最高的那只重仓」= 2 只 → 被砍成 1 只
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['AI龙一']);
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    expect(plan.heavy.notes.join('｜')).toContain('最多买 1 只');
  });

  it('9/21 电子/通信/算力 ≤ ' + BUY_COUNT_MAX_MID + ' 只 → 最多买 2 只', () => {
    const blocks = rankDecisionTopics([
      E('D龙一', '电子', 90, false, true, 5),
      E('D一字', '电子', 80, true),
      E('D龙三', '电子', 70, false, true, 4),
      E('D龙四', '电子', 60, false, true, 3),
      E('D龙五', '电子', 50, false, true, 2),
      E('D龙六', '电子', 40, false, true, 1)
    ].concat(FILLER('电子', 4)));                     // 6 + 4 = 10 只
    expect(blocks[0].count).toBe(BUY_COUNT_MAX_MID);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    // 常规档位（1 个一字）本来是「龙一重仓 + 龙三/龙四/龙五 高开轻仓」= 4 只 → 被砍成 2 只
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['D龙一', 'D龙三']);
    expect(plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
    expect(plan.heavy.notes.join('｜')).toContain('最多买 2 只');
  });

  it('> ' + BUY_COUNT_MAX_MID + ' 只 → 按原规则，不砍票', () => {
    const blocks = rankDecisionTopics([
      E('D龙一', '电子', 90, false, true, 5),
      E('D一字', '电子', 80, true),
      E('D龙三', '电子', 70, false, true, 4),
      E('D龙四', '电子', 60, false, true, 3),
      E('D龙五', '电子', 50, false, true, 2),
      E('D龙六', '电子', 40, false, true, 1)
    ].concat(FILLER('电子', 5)));                     // 6 + 5 = 11 只
    expect(blocks[0].count).toBe(BUY_COUNT_MAX_MID + 1);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.picks.length).toBe(4);
    expect(plan.heavy.notes.join('｜')).not.toContain('最多买');
  });
});

// === [2026-09-27] 三 · 持有 / 加仓：上交易日也在买点里 → 强势股 ===
describe('持有 / 加仓标记（HOLD）', () => {
  const holdRows = () => [
    E('强势票', 'T', 90, false, true, 5),
    E('T一字A', 'T', 80, true),
    E('T一字B', 'T', 70, true),
    E('T四', 'T', 60, false, true, 1),
    E('X一', 'X', 20), E('X二', 'X', 10)
  ].concat(FILLER('T', 6));                            // 4 + 6 = 10 只以上，避开只数限制
  const planOf = (prevBuyNames) => {
    const blocks = rankDecisionTopics(holdRows());
    return buildBuyPlan(blocks, rankDragons(blocks), { prevBuyNames: prevBuyNames });
  };

  it('上交易日也在买点里 → 行上标【持有 / 加仓】并写进说明', () => {
    const plan = planOf(new Set(['强势票']));
    expect(plan.heavy.picks[0].name).toBe('强势票');
    expect(plan.heavy.picks[0].holdTag).toBe(HOLD_TAG);
    expect(plan.heavy.picks[1].holdTag).toBeUndefined();
    expect(plan.heavy.notes.join('｜')).toContain(HOLD_TAG);
  });

  it('昨天没选中 → 不标', () => {
    const plan = planOf(new Set(['别的票']));
    expect(plan.heavy.picks[0].holdTag).toBeUndefined();
    expect(plan.heavy.notes.join('｜')).not.toContain(HOLD_TAG);
  });

  it('§10：昨天的买点没算出来（null）→ 一律不标（未知 ≠ 昨天没选中）', () => {
    const plan = planOf(null);
    expect(plan.heavy.picks[0].holdTag).toBeUndefined();
    expect(plan.heavy.notes.join('｜')).not.toContain(HOLD_TAG);
  });

  it('卖点侧：今天又在买点里 → 标【持有 / 加仓】（UI 用它顶替卖出时点）', () => {
    const blocks = rankDecisionTopics([
      E('S龙一', 'S', 30, true), E('S龙二', 'S', 20, true), E('S三', 'S', 10),
      E('W一', 'W', 9), E('W二', 'W', 8)
    ]);
    const dragon = rankDragons(blocks);
    const rows = [{ name: 'S三', topic: 'S', pct: 10, inTodayList: true }];
    const plan = buildSellPlan(rows, blocks, dragon, new Set(), new Set(['S三']));
    expect(plan[0].items[0].holdTag).toBe(HOLD_TAG);
    const plan2 = buildSellPlan(rows, blocks, dragon, new Set(), new Set());
    expect(plan2[0].items[0].holdTag).toBe('');
    expect(plan2[0].items[0].sellAt).toBe(SELL_TIME_CLOSE);
  });
});

// === [2026-09-30] ⑫ 昨天已买：股票级标记（只标在【买点】的股票行上；卖点侧一律不标）===
describe('昨天已买标记（PREV-BOUGHT，股票级）', () => {
  /** 把一个买点计划里所有档位的 picks 摊平（含兜底方案的 blocks） */
  function allPicks(plan) {
    const out = [];
    ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic'].forEach((k) => {
      const b = plan[k];
      if (!b) return;
      (b.picks || []).forEach((p) => out.push(p));
      (b.blocks || []).forEach((bb) => (bb.picks || []).forEach((p) => out.push(p)));
    });
    return out;
  }

  // ⚠️ 样本刻意让【同一题材 T】里既有「昨天买过」的、也有「昨天没买过」的 —— 这就是
  //    2026-09-30 用户反馈的真实事故形态：9/29 的 buy 标签只有【世联行、新华文轩】，
  //    地产链里的大亚圣象没买过，却被【整块】标上了「昨天已买」（因为当时按题材判）。
  const rows = () => [
    E('昨天买过的', 'T', 90, false, true, 5),   // 十日涨幅最高 → 龙一，必入选
    E('昨天没买的', 'T', 85, false, true, 4),   // 龙二，同样入选
    E('T一字A', 'T', 80, true),
    E('T一字B', 'T', 70, true),
    E('X一', 'X', 20), E('X二', 'X', 10)
  ].concat(FILLER('T', 6));                     // 撑过 10 只，避开只数限制

  const planOf = (prevBoughtNames) => {
    const blocks = rankDecisionTopics(rows());
    return buildBuyPlan(blocks, rankDragons(blocks), { prevBoughtNames: prevBoughtNames });
  };

  it('🔴 回归：同题材里【只有昨天真的买过的那只】被标，没买过的不会被带标', () => {
    const plan = planOf(new Set(['昨天买过的']));
    const picks = allPicks(plan);
    // 打标集合必须恰好 = {昨天买过的}
    expect(picks.filter((p) => p.prevBoughtTag === PREV_BOUGHT_TAG).map((p) => p.name))
      .toEqual(['昨天买过的']);
    // 且「昨天没买的」确实也在买点里（否则这条回归测的是空气）
    expect(picks.map((p) => p.name)).toContain('昨天没买的');
    picks.filter((p) => p.name === '昨天没买的').forEach((p) => {
      expect(p.prevBoughtTag).toBeUndefined();
    });
    // 🔴 反派回归：⛔ 不许再往【题材块】上写任何「昨天已买」字段 ——
    //    上一版正是 block.prevBoughtTopic 让「题材里有一只买过」变成「整块都买过」。
    expect(plan.heavy.block.prevBoughtTopic).toBeUndefined();
  });

  it('说明文字里如实写出是哪几只（可追溯到个股）', () => {
    const plan = planOf(new Set(['昨天买过的']));
    expect(plan.heavy.notes.join('｜')).toContain(PREV_BOUGHT_TAG);
    expect(plan.heavy.notes.join('｜')).toContain('昨天买过的');
    expect(plan.heavy.notes.join('｜')).not.toContain('昨天没买的');
  });

  it('昨天一只都没买（空集）→ 一个都不标', () => {
    const plan = planOf(new Set());
    expect(allPicks(plan).some((p) => p.prevBoughtTag)).toBe(false);
    expect(plan.heavy.notes.join('｜')).not.toContain(PREV_BOUGHT_TAG);
  });

  it('§10：昨天的标签没读到（null）→ 一律不标（未知 ≠ 昨天没买）', () => {
    const plan = planOf(null);
    expect(allPicks(plan).some((p) => p.prevBoughtTag)).toBe(false);
    expect(plan.heavy.notes.join('｜')).not.toContain(PREV_BOUGHT_TAG);
  });

  it('兜底方案（无一字 · 大题材）里的票同样按【股票级】标', () => {
    const big = [];
    for (let i = 1; i <= BIG_TOPIC_MIN_COUNT; i++) big.push(E('A' + i, 'A', 100 - i));
    for (let i = 1; i <= BIG_TOPIC_MIN_COUNT; i++) big.push(E('B' + i, 'B', 90 - i));
    const blocks = rankDecisionTopics(big);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      ladderReady: true, ladderTopicGroups: [], prevBoughtNames: new Set(['A1'])
    });
    expect(plan.bigTopic).not.toBe(null);
    const picks = allPicks(plan);
    expect(picks.filter((p) => p.prevBoughtTag === PREV_BOUGHT_TAG).map((p) => p.name)).toEqual(['A1']);
  });

  it('卖点侧【不标】：卖点候选本来就是昨天买过的股票，标了没有信息量（用户口径）', () => {
    const blocks = rankDecisionTopics([
      E('S龙一', 'S', 30, true), E('S龙二', 'S', 20, true), E('S三', 'S', 10),
      E('W一', 'W', 9), E('W二', 'W', 8)
    ]);
    const dragon = rankDragons(blocks);
    const sellRows = [{ name: 'S三', topic: 'S', pct: 10, inTodayList: true }];
    const plan = buildSellPlan(sellRows, blocks, dragon, new Set(), new Set());
    // 题材级（上一版的错误做法）与股票级都不能出现
    expect(plan[0].prevBoughtTopic).toBeUndefined();
    expect(plan[0].items[0].prevBoughtTag).toBeUndefined();
  });

  it('规则面板里有 ⑫ 这条（规则实现了就必须能逐条核对）', () => {
    const text = buildRulesLines().join('\n');
    expect(text).toContain(RULE_NO.PREV_BOUGHT);
    expect(text).toContain(PREV_BOUGHT_TAG);
  });
});

// === [2026-09-27] ⑨ 双主线竞争：两个大容量题材并存 → 比竞价高开率，谁高谁重仓 ===
/**
 * 9/10 真实形态（用户给的锚点）：
 *   农业 11 只（龙一敦煌种业，2 个竞价一字）、竞价高开 5 只 = 45%；
 *   大消费 10 只（龙一国芳集团，1 个竞价一字）、竞价高开 8 只 = 80%。
 *   ⇒ 大消费龙一国芳集团【重仓】，农业龙一敦煌种业【轻仓】，各只选 1 只。
 */
function NONGYE_11() {
  return [
    E('敦煌种业', '农业', 53.49, false, true, -1.55, '600354'),   // 龙一（低开）
    E('新农开发', '农业', 40, true, true, 10.05, '600359'),        // 一字 · 高开
    E('农票H', '农业', 38, true, true, 9.99),                      // 一字 · 高开
    E('中粮科技', '农业', 26, false, true, 6.71, '000930'),        // 高开
    E('新赛股份', '农业', 30, false, true, 1.94, '600540'),        // 高开
    E('亚盛集团', '农业', 28, false, true, 1.58, '600108'),        // 高开
    E('泸天化', '农业', 24, false, true, -7.69, '000912'),
    E('农票G', '农业', 20, false, true, -1),
    E('农票I', '农业', 18, false, true, -2),
    E('农票J', '农业', 16, false, true, -3),
    E('农票K', '农业', 12, false, true, -4)
  ];
}
function XIAOFEI_10() {
  return [
    E('国芳集团', '大消费', 99.34, false, true, -2.22, '601086'),  // 龙一（低开）
    E('桂林旅游', '大消费', 50, true, true, 9.99, '000978'),       // 一字 · 高开
    E('百大集团', '大消费', 18, false, true, 8.8, '600865'),
    E('中百集团', '大消费', 30, false, true, 5.67, '000759'),
    E('云南旅游', '大消费', 40, false, true, 4.83, '002059'),
    E('会稽山', '大消费', 20, false, true, 3.79, '601579'),
    E('海欣食品', '大消费', 12, false, true, 2.33, '002702'),
    E('华天酒店', '大消费', 14, false, true, 2.1, '000428'),
    E('安记食品', '大消费', 16, false, true, 0.83, '603696'),
    E('红棉股份', '大消费', 10, false, true, -1, '000523')
  ];
}
function plan0910() {
  const blocks = rankDecisionTopics(NONGYE_11().concat(XIAOFEI_10()));
  return { blocks: blocks, plan: buildBuyPlan(blocks, rankDragons(blocks)) };
}

describe('⑨ 双主线竞争：两个大题材并存 → 比竞价高开率（DUAL-MAIN）', () => {
  it('先钉死事故现场：农业 11 只 2 一字（第 1 名）、大消费 10 只 1 一字（第 2 名）', () => {
    const r = plan0910();
    expect(r.blocks[0].topic).toBe('农业');
    expect(r.blocks[0].count).toBe(11);
    expect(r.blocks[0].yiziCount).toBe(2);
    expect(r.blocks[1].topic).toBe('大消费');
    expect(r.blocks[1].count).toBe(10);
    expect(r.blocks[1].yiziCount).toBe(1);
  });

  it('9/10：大消费 80% ＞ 农业 45% ⇒ 大消费龙一国芳集团【重仓】、农业龙一敦煌种业【轻仓】', () => {
    const r = plan0910();
    // ⛔ 大消费虽然是【第 2 名】，但高开率更高 → 它才是重仓那一档
    expect(r.plan.heavy.block.topic).toBe('大消费');
    expect(r.plan.heavy.picks.map(p => p.name)).toEqual(['国芳集团']);
    expect(r.plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    expect(r.plan.light.block.topic).toBe('农业');
    expect(r.plan.light.picks.map(p => p.name)).toEqual(['敦煌种业']);
    expect(r.plan.light.picks[0].position).toBe(POSITION_LIGHT);
  });

  it('各【只选 1 只】（大容量题材并存不铺票）', () => {
    const r = plan0910();
    expect(r.plan.heavy.picks.length).toBe(1);
    expect(r.plan.light.picks.length).toBe(1);
  });

  it('说明文字必须带【规则⑨】与两个题材的高开率，用户能直接核对', () => {
    const r = plan0910();
    const notes = r.plan.heavy.notes.join('｜');
    expect(notes).toContain(ruleTag(RULE_NO.DUAL_MAIN));
    expect(notes).toContain('80%');
    expect(notes).toContain('45%');
    expect(r.plan.heavy.reason).toContain('根据规则' + RULE_NO.DUAL_MAIN);
    expect(r.plan.light.reason).toContain('根据规则' + RULE_NO.DUAL_MAIN);
    expect(r.plan.heavy.ruleNo).toBe(RULE_NO.DUAL_MAIN);
  });

  it('第 2 名题材不够大（< ' + DUAL_MAIN_MIN_COUNT + ' 只）→ 本条不适用，回到常规档位', () => {
    const rows = [];
    for (let i = 1; i <= 11; i++) rows.push(E('农' + i, '农业', 90 - i, i <= 2, true, i <= 5 ? 3 : -1));
    for (let i = 1; i <= 5; i++) rows.push(E('消' + i, '大消费', 80 - i, false, true, -1));
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(blocks[1].count).toBe(5);
    expect(plan.heavy.block.topic).toBe('农业');
    expect(plan.heavy.notes.join('｜')).not.toContain(ruleTag(RULE_NO.DUAL_MAIN));
    expect(plan.heavy.ruleNo).toBe(RULE_NO.HEAVY_DOUBLE);
  });

  it('§10：某题材一只都没有竞价涨幅 → 高开率未知 → 无从比较 → 退回常规档位', () => {
    const rows = NONGYE_11().concat(XIAOFEI_10()).map(function(r) {
      return r.topic === '大消费' ? E(r.name, r.topic, r.pct, r.isYizi, true, null, r.code) : r;
    });
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.notes.join('｜')).not.toContain(ruleTag(RULE_NO.DUAL_MAIN));
  });

  it('高开率【完全相同】→ 维持原排名（第 1 名重仓），并如实说明', () => {
    const rows = [];
    for (let i = 1; i <= 11; i++) rows.push(E('农' + i, '农业', 90 - i, i <= 2, true, i <= 5 ? 3 : -1));
    for (let i = 1; i <= 11; i++) rows.push(E('消' + i, '大消费', 80 - i, i === 1, true, i <= 5 ? 3 : -1));
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.block.topic).toBe('农业');       // 并列 → 第 1 名胜出
    expect(plan.heavy.notes.join('｜')).toContain('完全相同');
  });
});

// === [2026-09-27] 说明文字必须标注规则编号（用户口径：像法律条文一样能查出处）===
describe('规则编号标注（RULE-NO）', () => {
  it('RULE_NO 每个编号唯一（编号一旦撞车，用户就分不清是哪条规则）', () => {
    const vals = Object.keys(RULE_NO).map(k => RULE_NO[k]);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('① 常规档位的理由与说明都带编号', () => {
    // ⛔ T1 刻意 6 只：≤4 只 + 1~2 个一字会命中 ⑥「小题材 + 一字」兜底，被它截走就测不到常规档位
    const blocks = rankDecisionTopics([
      E('一字A', 'T1', 90, true, true, 10), E('一字B', 'T1', 80, true, true, 9.98),
      E('票C', 'T1', 70, false, true, 8), E('票D', 'T1', 60, false, true, 7),
      E('票E', 'T1', 50, false, true, 6), E('票F', 'T1', 40, false, true, 5),
      E('T2一', 'T2', 30), E('T2二', 'T2', 20)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.reason).toContain('根据规则' + RULE_NO.HEAVY_DOUBLE);
    expect(plan.heavy.ruleNo).toBe(RULE_NO.HEAVY_DOUBLE);
    expect(plan.light.reason).toContain('根据规则' + RULE_NO.SECOND);
  });

  it('⑦⑧⑩⑪ 的说明都带编号', () => {
    // 12 只里只有 2 只高开（≈17% < 35%）→ ⑧；第 1 名题材 12 只 → ⑩ 不触发，改用 ⑦ 造一条
    const rows = [
      E('敦煌种业', '农业', 80, false, true, 3, '600354'),
      E('跌停票', '农业', 70, false, true, -10, '000930'),         // 竞价一字跌停 → ⑦
      E('一字A', '农业', 60, true, true, 10),
      E('一字B', '农业', 55, true, true, 9.98)
    ];
    for (let i = 1; i <= 8; i++) rows.push(E('农票' + i, '农业', 50 - i, false, true, -1 - i));
    const blocks = rankDecisionTopics(rows);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), { prevBuyNames: new Set(['敦煌种业']) });
    const notes = plan.heavy.notes.join('｜');
    expect(notes).toContain(ruleTag(RULE_NO.LOSS_EFFECT));   // ⑦
    expect(notes).toContain(ruleTag(RULE_NO.WEAK_OPEN));     // ⑧
    expect(notes).toContain(ruleTag(RULE_NO.HOLD));          // ⑪
  });

  it('⑩ 买入只数的说明带编号', () => {
    const blocks = rankDecisionTopics([
      E('一字A', 'T1', 90, true, true, 10), E('一字B', 'T1', 80, true, true, 9.98),
      E('票C', 'T1', 70, false, true, 8), E('票D', 'T1', 60, false, true, 7),
      E('票E', 'T1', 50, false, true, 6), E('票F', 'T1', 40, false, true, 5),
      E('T2一', 'T2', 30), E('T2二', 'T2', 20)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(blocks[0].count).toBe(6);
    expect(plan.heavy.notes.join('｜')).toContain(ruleTag(RULE_NO.BUY_COUNT));
  });

  it('规则说明清单（灰色问号）里的编号与 RULE_NO 一致，且不重复', () => {
    const text = buildRulesLines().join('\n');
    expect(text).toContain('⑨ 【双主线竞争】');
    expect(text).toContain('⑩ 【买入只数】');
    expect(text).toContain('⑪ 【' + HOLD_TAG + '】');
  });
});
