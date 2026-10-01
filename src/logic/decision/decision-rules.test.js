// decision-rules.test.js — 「决策」看板规则回归用例
//
// ⭐ [QUANT-PICK 2026-10-01 买点整体重写] 新买点只有三步，用例就围着这三步钉：
//   ⓪ 题材排名 = 早盘竞价「题材 toggle」的组序（复用 sortByTopicGroups，不另写比较器），
//      2026-10-01 起口径 = 【该题材的平均竞价量比】降序 → 组大小 → 题材名；
//   ① 取排名【第 1 / 第 2】两个题材；
//   ② 按【题材股票数量】分档（resolvePickTier）：≥10 → 3 只 / 7~9 → 2 只 / 4~6 → 1 只 / ≤3 → 不出票；
//   ③ 档内按【竞价量比】降序取票（pickByVolRatio）：前 N 只重仓、其余轻仓；
//      竞价一字一律跳过；创业板 / 科创板 / 北交所【照选】；⛔ 不分龙一 / 龙二。
//   ⛔ 旧规则（一字门槛 / 题材替换 / 连板天梯兜底 / 小题材 / 亏钱效应 / 弱势题材 / 双主线 /
//      买入只数 / 龙一特例 / 卡位补偿）已整体删除，对应用例一并删除 —— 不要再加回来。
//
// 其它仍然钉住的：卖点时点与竞价高低开细分（用户口径「卖点先不变」）、题材行/股票行标记、
//   规则文案与实现同处一处（§6）、一键复制逐行还原。
//
// ⚠️ 题材名刻意用 T1/T2/T3：组序的兜底比较是【题材名升序】，中文名按 Unicode 码点排
//    （实测「丙」<「乙」，肉眼极易看错），用 ASCII 名才能让用例意图一目了然。
//
// ⚠️【量比是选票的唯一依据】——测「按量比选票」的用例【必须显式传 E() 的第 9 个参数】，
//    否则量比全为 null，测到的是 §10 的「按龙头名次」退路，而不是主路径。

import { describe, it, expect } from 'vitest';
import {
  rankDecisionTopics,
  rankDragons,
  buildBuyPlan,
  buildSellPlan,
  buildRulesLines,
  joinRulesLines,
  formatRangePct,
  // [QUANT-PICK 2026-10-01] 新买点的两个核心实现
  resolvePickTier,
  pickByVolRatio,
  PICK_TIER_BIG_MIN,
  PICK_TIER_MID_MIN,
  PICK_TIER_MIN_COUNT,
  PICK_COUNT_BIG,
  PICK_COUNT_MID,
  PICK_COUNT_MIN,
  PICK_HEAVY_BIG,
  PICK_HEAVY_MID,
  PICK_HEAVY_MIN,
  SELL_TIME_CLOSE,
  SELL_TIME_MIDDAY,
  SELL_DEEP_LOW,
  SELL_MILD_HIGH,
  SELL_TONE_DANGER,
  SELL_TONE_WATCH,
  SELL_TONE_PLAN,
  POSITION_HEAVY,
  POSITION_LIGHT,
  POSITION_ADD,
  POSITION_TONE_HEAVY,
  POSITION_TONE_LIGHT,
  POSITION_TONE_ADD,
  positionToneOf,
  HOLD_TAG,
  PREV_BOUGHT_TAG,
  TOPIC_PREV_BOUGHT_TAG,
  TOPIC_STREAK_WINDOW,
  topicStreakText,
  RULE_NO,
  ruleTag
} from './decision-rules.js';

/** E(股票名, 题材, 十日涨幅, 是否竞价一字, 是否计入数量, 当日竞价涨幅%, 代码, 是否卖标签继承, 竞价量比) */
/**
 * 样本行构造。
 * @param {string} name 股票名
 * @param {string} topic 题材
 * @param {number|null} pct 十日涨幅
 * @param {boolean} [isYizi] 是否竞价一字（买不进 ⇒ 选票时一律跳过）
 * @param {boolean} [countable] 是否计入题材数量（false = 早盘竞价里「灰色名称 / 灰色题材」的灰行）
 * @param {number|null} [aucPct] 竞价涨幅（只影响行内徽标与「低开龙一提醒」）
 * @param {string} [code] 股票代码（旧版据此跳过 20% / 30% 板；新规【照选】，已不再需要，保留以便构造真实样本）
 * @param {boolean} [inheritSold] 是否「昨日卖标签继承」的复盘行（照常参与量比均值与选票）
 * @param {number|null} [volRatio]
 *        [QUANT-PICK 2026-10-01] 当日【竞价量比】（倍数）= 买点选票的【唯一排序依据】。
 *        ⚠️ 不传 / null = 【缺量比】（§10）—— 规则层会退回「按龙头名次」取票并写进说明，
 *           所以测「按量比选票」的用例【必须显式传这一项】，否则测到的是退路而不是主路径。
 */
function E(name, topic, pct, isYizi, countable, aucPct, code, inheritSold, volRatio) {
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: !!isYizi,
    countable: countable !== false,
    code: code || '',
    inheritSold: inheritSold === true,
    aucPct: (aucPct === undefined || aucPct === null) ? null : aucPct,
    aucVolRatio: (volRatio === undefined || volRatio === null) ? null : volRatio
  };
}

/**
 * 「凑数票」—— 把题材撑到指定只数的工具。
 *
 * ⚠️ [QUANT-PICK 2026-10-01 重写] 现在【题材只数直接决定买几只】，凑数不再是「顺手加几只」，
 *    而会影响测到的档位 ⇒ 每个用例请先算清楚自己要哪个档：
 *      ≥ 10 只 → big（3 只）｜7~9 只 → mid（2 只）｜4~6 只 → small（1 只）｜≤3 只 → 不出票。
 *    本函数默认按【非一字 + 计入数量 + 十日涨幅极低（排到龙位末尾）】构造，
 *    且竞价量比一律【不传】（= null，§10）⇒ 它们一律排在有量比的票【后面】，不会抢走名额。
 *    竞价涨幅给 +0.1（小高开）只是让它像个正常票，不影响任何选票结论。
 *
 * @param {string} topic 题材名
 * @param {number} n 要几只
 */
function FILLER(topic, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(E('凑' + topic + (i + 1), topic, -100 - i, false, true, 0.1));
  return out;
}

describe('rankDecisionTopics（题材组序 = 与早盘竞价同一口径）', () => {
  // === [TOPIC-ORDER 2026-10-01 用户口径] 组序主键从「一字数量」换成「平均竞价量比」 ===
  // 用户原话：「以前单独打开题材 toggle，题材是按一字数量排序，我希望现在是按题材的平均竞价量比排序，
  //   平均竞价量比高的题材排在前面。这样能分出排在第一和第二的题材」。
  it('⭐ 组序 = 【平均竞价量比】高的在前，一字数量【不再】决定名次', () => {
    const blocks = rankDecisionTopics([
      // T1 平均量比 (1 + 3) / 2 = 2.0；T2 (8 + 10) / 2 = 9.0 ⇒ T2 第一
      E('a1', 'T1', 10, true, true, 1, '', false, 1), E('a2', 'T1', 9, true, true, 1, '', false, 3),
      E('b1', 'T2', 5, false, true, 1, '', false, 8), E('b2', 'T2', 4, false, true, 1, '', false, 10)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T1']);
    expect(blocks[0].rank).toBe(1);
    expect(blocks[0].yiziCount).toBe(0);       // T2 一个一字都没有，照样排第一（一字不再是主键）
    expect(blocks[1].yiziCount).toBe(2);
  });

  it('量比均值【含灰行】—— 与早盘竞价统计条「平均竞价量比」同一个分母（§6）', () => {
    // ⚠️ 这是本口径最容易被改错的地方：只数正式行 ⇒ T1 均值 = 0 ＜ T2 的 9 ⇒ 顺序反了。
    //   用户是拿统计条上那个数字来核对顺序的，两边必须同一个分母。
    const blocks = rankDecisionTopics([
      E('正式一', 'T1', 10, false, true, 1, '', false, 0),
      E('正式二', 'T1', 9, false, true, 1, '', false, 0),
      E('灰甲', 'T1', 8, false, false, 1, '', false, 30),
      E('灰乙', 'T1', 7, false, false, 1, '', false, 60),
      E('b1', 'T2', 5, false, true, 1, '', false, 9), E('b2', 'T2', 4, false, true, 1, '', false, 9)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T1', 'T2']);   // (0+0+30+60)/4 = 22.5 ＞ 9
    expect(blocks[0].count).toBe(2);                          // 但【数量】仍只数正式行（灰行不计）
  });

  it('§10：一行量比都拿不到的题材【置底】—— 绝不把「没抓到」当成「量比很小」', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 10, true, true, 1), E('a2', 'T1', 9, true, true, 1),          // 2 个一字，但没量比
      E('b1', 'T2', 5, false, true, 1, '', false, 0.5), E('b2', 'T2', 4, false, true, 1, '', false, 0.5)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T1']);
  });

  it('量比相同 → 人多的题材在前', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 1, false, true, 1, '', false, 2), E('a2', 'T1', 2, false, true, 1, '', false, 2),
      E('b1', 'T2', 3, false, true, 1, '', false, 2), E('b2', 'T2', 4, false, true, 1, '', false, 2),
      E('b3', 'T2', 5, false, true, 1, '', false, 2)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T1']);
  });

  it('量比与人头都相同 → 题材名升序（ASCII 名保证确定性）', () => {
    const blocks = rankDecisionTopics([
      E('x1', 'T3', 1, false, true, 1, '', false, 2), E('x2', 'T3', 2, false, true, 1, '', false, 2),
      E('y1', 'T2', 3, false, true, 1, '', false, 2), E('y2', 'T2', 4, false, true, 1, '', false, 2)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T3']);
  });

  it('两个题材都缺量比 → 落到「人多的在前」（与早盘竞价同一条退路）', () => {
    const blocks = rankDecisionTopics([
      E('a1', 'T1', 1), E('a2', 'T1', 2),
      E('b1', 'T2', 3), E('b2', 'T2', 4), E('b3', 'T2', 5)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T2', 'T1']);
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

// 「陪跑」的第 1 名题材 X：5 只，全部【没有竞价量比】⇒ 与只有 4 只的 T 相比，
//   组序会落到「人多的在前」这一档 ⇒ X 稳坐第 1 名、T 稳坐第 2 名（多个用例共用，故提到模块作用域）。
// ⚠️ 新规则下「第几名」由【平均竞价量比 → 组大小 → 题材名】决定，跟一字数量无关了。
const headTopic = [
  E('X一字', 'X', 50, true, true, 10), E('X二', 'X', 40, true, true, 9),
  E('X三', 'X', 30, false, true, 2), E('X四', 'X', 20, false, true, 3),
  E('X五', 'X', 10, false, true, -1)
];

// === [2026-09-29] 买点行也挂【竞价涨幅】徽标（与卖点同款：涨红底 / 跌绿底 / 平灰底） ===
// 位置：紧随「十日涨幅」之后。文本 / 配色全部由 Logic 层派生（§21 模板零计算），
// 且必须走与卖点【同一份】formatAucPct + getAucOpenKind（§6），所以这里逐档钉死输出。
describe('买点 · 竞价涨幅徽标（AUC-BADGE）', () => {
  // 第 2 名题材 T 用 4 只（落到 small 档 ⇒ 只取 1 只）⇒ 一个场景就能喂进任意 aucPct，逐档验证徽标。
  // ⚠️ T 必须 ≥ 4 只：≤3 只的题材在新规下【不出票】，picks 为空就测不到徽标了。
  const run = (aucPct) => {
    const blocks = rankDecisionTopics(headTopic.concat([
      E('股1', 'T', 90, false, true, aucPct),
      E('股2', 'T', 80, false, true, 5),
      E('股3', 'T', 70, false, true, 5),
      E('股4', 'T', 60, false, true, 5)
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

  it('第 1 名题材（重仓档）也带徽标 —— ① / ② 两个入口都要覆盖，别只改了一个', () => {
    // T1 = 4 只 ⇒ small 档（取 1 只、重仓）；两个一字买不进 ⇒ 只剩 大A / 大B，
    // 且全部缺量比 ⇒ 走 §10 退路按龙头名次取 ⇒ 大A（十日涨幅最高）。
    const blocks = rankDecisionTopics([
      E('一A', 'T1', 40, true, true, 10), E('一B', 'T1', 39, true, true, 9.98),
      E('大A', 'T1', 30, false, true, 1.5), E('大B', 'T1', 20, false, true, -2)
    ]);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.block.count).toBe(4);
    expect(plan.heavy.qualified).toBe(true);
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['大A']);
    expect(plan.heavy.picks[0].position).toBe(POSITION_HEAVY);
    const p0 = plan.heavy.picks[0];
    expect(p0.aucPctText).toBe('+1.50%');
    expect(p0.aucTone).toBe('high');
  });
});

// === [2026-09-26] 灰行（不在正式列表）也能被选进买点 ===
describe('灰行参与选票（GRAY-DRAGON）', () => {
  // T = 第 1 名（5 只正式成员），X = 第 2 名（2 只）；两边都缺量比 ⇒ 组序落到「人多的在前」
  it('第 1 名题材的龙一是灰行 → 照常入选（9/8 大消费 · 国芳集团）', () => {
    const blocks = rankDecisionTopics([
      E('老龙灰行', 'T', 96, false, false, 2),      // countable=false 灰行，十日涨幅最高 = 龙一
      E('T一字一', 'T', 80, true), E('T一字二', 'T', 70, true),
      E('T四', 'T', 60, false, true, 1), E('T五', 'T', 50, false, true, 0.5),
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
  // （其中还有灰行的一字）→ 只能跳过一字，往下取龙六云南旅游、龙七补充。
  // ⭐ 新规下「只数」本身决定买几只：T 的正式成员 11 只 ⇒ 落到 big 档 ⇒ 取 3 只（前 2 重仓 + 第 3 轻仓）。
  it('龙一=卖标签继承的灰行 + 龙二~龙五全是一字 → 跳过一字往下取（9/8 大消费）', () => {
    const blocks = rankDecisionTopics([
      E('国芳集团', 'T', 96, false, false, 2, '', true),   // 龙一：灰行 + 昨日卖标签继承
      E('一字二', 'T', 80, true),
      E('一字三', 'T', 70, true, false),                   // 灰行的一字，同样买不进
      E('一字四', 'T', 60, true),
      E('一字五', 'T', 50, true),
      E('云南旅游', 'T', 40, false, true, 5),              // 龙六
      E('补充', 'T', 30, false, true, 1),                  // 龙七
      E('X一', 'X', 20), E('X二', 'X', 10)
    ].concat(FILLER('T', 6)));   // 正式成员 = 5 + 6 = 11 只 ⇒ 大档（取 3 只）
    expect(blocks[0].count).toBe(11);
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    // 全部缺量比 ⇒ §10 退路：按龙头名次取前 3（一字买不进，自动跳过）⇒ 大档前二重仓 + 第三轻仓
    expect(plan.heavy.picks.map(p => p.name)).toEqual(['国芳集团', '云南旅游', '补充']);
    expect(plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('第 2 名题材的龙一是灰行 → 照常入选（9/8 农业 · 万向德农）', () => {
    const blocks = rankDecisionTopics([
      E('T一', 'T', 60, true), E('T二', 'T', 50, true), E('T三', 'T', 40),
      E('T四', 'T', 30), E('T五', 'T', 20),
      E('农业老龙', 'X', 82, false, false, -1),     // 灰行龙一（低开也照样入选，见下面的 L 形提醒）
      // ⚠️ [QUANT-PICK 2026-10-01] X 的【正式成员】必须 ≥ 4 只：只数直接决定档位，
      //    ≤ 3 只（灰行不计入数量）会落到「不进入决策范围 ⇒ 空仓」⇒ 本用例测的就不再是灰行选票了。
      E('X二', 'X', 30), E('X三', 'X', 20), E('X四', 'X', 10), E('X五', 'X', 5)
    ]);
    expect(blocks.map(b => b.topic)).toEqual(['T', 'X']);
    expect(blocks[1].count).toBe(4);                                   // 灰行 农业老龙 不计入 ⇒ 4 只
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.light.picks.map(p => p.name)).toEqual(['农业老龙']);   // small 档 ⇒ 1 只、重仓
    expect(plan.light.picks[0].position).toBe(POSITION_HEAVY);
  });
});

// === [2026-09-26] ④ 龙一低开 → 只加「跌停 L 形 → 尾盘买」提醒文字 ===
describe('低开龙一的 L 形提醒（只提醒、不改选票）', () => {
  // T = 第 1 名（5 只正式成员，落到 small 档 ⇒ 只取 1 只）；X = 第 2 名（3 只，不出票）
  // 全部缺量比 ⇒ 取票走 §10 退路 = 龙头名次第一的「龙头票」，正是要验证的那只。
  const lowOpenRows = (aucOfDragonOne) => [
    E('龙头票', 'T', 90, false, true, aucOfDragonOne),
    E('T一字', 'T', 80, true),
    E('股3', 'T', 70, false, true, 3),
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

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [QUANT-PICK 2026-10-01 用户口径] 买点新规：前二题材 × 按数量分档 × 按竞价量比取票 ★★
// ══════════════════════════════════════════════════════════════════════════════════════

describe('resolvePickTier（题材数量 → 买几只 · §6 唯一实现）', () => {
  it('⭐ 四档边界与用户原话逐字对应：≥10 → 3 只 / 7~9 → 2 只 / 4~6 → 1 只 / 1~3 → 不出票', () => {
    // 上界（≥10）
    [10, 11, 17].forEach(function(n) {
      expect(resolvePickTier(n)).toMatchObject({ tier: 'big', max: PICK_COUNT_BIG, heavyCount: PICK_HEAVY_BIG });
    });
    // 中档（7~9）
    [7, 8, 9].forEach(function(n) {
      expect(resolvePickTier(n)).toMatchObject({ tier: 'mid', max: PICK_COUNT_MID, heavyCount: PICK_HEAVY_MID });
    });
    // 小档（4~6）
    [4, 5, 6].forEach(function(n) {
      expect(resolvePickTier(n)).toMatchObject({ tier: 'small', max: PICK_COUNT_MIN, heavyCount: PICK_HEAVY_MIN });
    });
    // 空仓（1~3）
    [0, 1, 2, 3].forEach(function(n) {
      expect(resolvePickTier(n)).toMatchObject({ tier: 'none', max: 0, heavyCount: 0 });
    });
  });

  it('边界值不重叠：10 归 big（不是 mid）、9 归 mid；4 归 small（不是 none）、3 归 none', () => {
    expect(resolvePickTier(9).tier).toBe('mid');
    expect(resolvePickTier(10).tier).toBe('big');
    expect(resolvePickTier(3).tier).toBe('none');
    expect(resolvePickTier(4).tier).toBe('small');
  });

  it('§10：count 缺失 / 非法 → none 档（⛔ 绝不因为「数字没读到」就假装它是大题材去铺票）', () => {
    [null, undefined, '', 'abc', -1].forEach(function(v) {
      expect(resolvePickTier(v).tier).toBe('none');
    });
  });

  it('云端可能存字符串（"12"）→ 照样认', () => {
    expect(resolvePickTier('12').tier).toBe('big');
    expect(resolvePickTier('5').tier).toBe('small');
  });

  it('档位文字里带得出边界（用户要拿它核对「为什么买 3 只」）', () => {
    expect(resolvePickTier(12).rangeText).toContain(String(PICK_TIER_BIG_MIN));
    expect(resolvePickTier(8).rangeText).toContain(String(PICK_TIER_MID_MIN));
    expect(resolvePickTier(5).rangeText).toContain(String(PICK_TIER_MIN_COUNT));
  });
});

describe('pickByVolRatio（按竞价量比降序取票 · §6 唯一实现）', () => {
  const mk = (members) => {
    const blocks = rankDecisionTopics(members);
    return { blocks: blocks, dragon: rankDragons(blocks), blk: blocks[0] };
  };

  it('⭐ 量比降序取票，前 N 只重仓、其余轻仓 —— 龙一量比小就被挤掉（用户原话的例子）', () => {
    // 龙一 5.6 / 龙二 8.9 / 龙三 20.5 / 龙四 5.4 / 龙五 7.9
    const { blk, dragon } = mk([
      E('龙一', 'T', 90, false, true, 3, '', false, 5.6),
      E('龙二', 'T', 80, false, true, 3, '', false, 8.9),
      E('龙三', 'T', 70, false, true, 3, '', false, 20.5),
      E('龙四', 'T', 60, false, true, 3, '', false, 5.4),
      E('龙五', 'T', 50, false, true, 3, '', false, 7.9)
    ]);
    const r = pickByVolRatio(blk, dragon, 3, 2, RULE_NO.FIRST);
    expect(r.picks.map(p => p.name)).toEqual(['龙三', '龙二', '龙五']);
    expect(r.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
    expect(r.picks.map(p => p.seq)).toEqual([1, 2, 3]);
    expect(r.byRankFallback).toBe(false);
    // ⛔ 龙一（量比最小档）没被选中 —— 这是「不保底龙一」的直接体现
    expect(r.picks.map(p => p.name)).not.toContain('龙一');
  });

  it('竞价一字一律跳过：不占名额，也不参与量比排序（量比再大也买不进）', () => {
    const { blk, dragon } = mk([
      E('一字天量比', 'T', 90, true, true, 10, '', false, 999),
      E('甲', 'T', 80, false, true, 3, '', false, 1),
      E('乙', 'T', 70, false, true, 3, '', false, 2)
    ]);
    const r = pickByVolRatio(blk, dragon, 2, 2, RULE_NO.FIRST);
    expect(r.picks.map(p => p.name)).toEqual(['乙', '甲']);
  });

  it('⭐ 创业板 / 科创板 / 北交所【照选】—— 不再因板块顺延下一位', () => {
    const { blk, dragon } = mk([
      E('主板甲', 'T', 90, false, true, 3, '600001', false, 1),
      E('创业板乙', 'T', 80, false, true, 3, '300001', false, 9),
      E('科创板丙', 'T', 70, false, true, 3, '688001', false, 5)
    ]);
    const r = pickByVolRatio(blk, dragon, 2, 2, RULE_NO.FIRST);
    expect(r.picks.map(p => p.name)).toEqual(['创业板乙', '科创板丙']);
  });

  it('§10：缺量比的票排在有量比的票【后面】（⛔ 绝不当 0 去比大小）', () => {
    const { blk, dragon } = mk([
      E('没量比', 'T', 90, false, true, 3),
      E('有量比', 'T', 80, false, true, 3, '', false, 0.1)
    ]);
    const r = pickByVolRatio(blk, dragon, 2, 2, RULE_NO.FIRST);
    expect(r.picks.map(p => p.name)).toEqual(['有量比', '没量比']);
  });

  it('§10：全体缺量比 ⇒ 退回【按龙头名次】取，并如实写进说明（byRankFallback=true）', () => {
    const { blk, dragon } = mk([E('甲', 'T', 90), E('乙', 'T', 80), E('丙', 'T', 70)]);
    const r = pickByVolRatio(blk, dragon, 2, 2, RULE_NO.FIRST);
    expect(r.byRankFallback).toBe(true);
    expect(r.picks.map(p => p.name)).toEqual(['甲', '乙']);
    expect(r.notes.join('｜')).toContain('全部缺竞价量比');
  });

  it('量比并列 → 龙头名次靠前的优先（只是稳定次序，⛔ 不是选票依据）', () => {
    const { blk, dragon } = mk([
      E('甲', 'T', 90, false, true, 3, '', false, 2),
      E('乙', 'T', 80, false, true, 3, '', false, 2)
    ]);
    const r = pickByVolRatio(blk, dragon, 1, 1, RULE_NO.FIRST);
    expect(r.picks.map(p => p.name)).toEqual(['甲']);
  });

  it('可买的票不够 maxCount → 只取到有的那些（如实呈现，不硬凑）', () => {
    const { blk, dragon } = mk([
      E('一字', 'T', 90, true),
      E('甲', 'T', 80, false, true, 3, '', false, 1),
      E('乙', 'T', 70, false, true, 3, '', false, 2)
    ]);
    const r = pickByVolRatio(blk, dragon, 3, 2, RULE_NO.FIRST);
    expect(r.picks.length).toBe(2);
  });

  it('说明文字里带上规则编号与量比数值（用户要能逐条核对）', () => {
    const { blk, dragon } = mk([
      E('甲', 'T', 90, false, true, 3, '', false, 12.3),
      E('乙', 'T', 80, false, true, 3, '', false, 4.5)
    ]);
    const r = pickByVolRatio(blk, dragon, 2, 1, RULE_NO.SECOND);
    const text = r.notes.join('｜');
    expect(text).toContain(ruleTag(RULE_NO.SECOND));
    expect(text).toContain('12.3');
    expect(text).toContain('4.5');
  });
});

describe('buildBuyPlan（新买点：排名前二题材 × 数量分档 × 竞价量比）', () => {
  /**
   * 陪跑题材 X 的 n 只成员（十日涨幅递减 ⇒ 龙一 = X1）。
   * 量比刻意给低值 ⇒ X 永远排在第 2 名，T1 稳坐第 1 名。
   */
  const XROWS = (n, ratio) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(E('X' + (i + 1), 'X', 20 - i, false, true, 1, '', false, ratio));
    return out;
  };
  const plan = (members) => {
    const blocks = rankDecisionTopics(members);
    return { blocks: blocks, plan: buildBuyPlan(blocks, rankDragons(blocks)) };
  };

  it('⭐ 第 1 名题材 ≥10 只 → 取 3 只：量比前二【重仓】+ 第三【轻仓】', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8),
      E('丙', 'T1', 70, false, true, 3, '', false, 7), E('丁', 'T1', 60, false, true, 3, '', false, 6)
    ].concat(FILLER('T1', 6)).concat(XROWS(4, 1)));
    expect(r.blocks.map(b => b.topic)).toEqual(['T1', 'X']);
    expect(r.plan.heavy.block.count).toBe(10);
    expect(r.plan.heavy.qualified).toBe(true);
    expect(r.plan.heavy.picks.map(p => p.name)).toEqual(['甲', '乙', '丙']);
    expect(r.plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
    expect(r.plan.heavy.ruleNo).toBe(RULE_NO.FIRST);
    expect(r.plan.heavy.reason).toContain('根据规则' + RULE_NO.FIRST);
  });

  it('⭐ 第 1 名题材 7~9 只 → 取 2 只：量比第一【重仓】+ 第二【轻仓】', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8),
      E('丙', 'T1', 70, false, true, 3, '', false, 7)
    ].concat(FILLER('T1', 5)).concat(XROWS(4, 1)));
    expect(r.plan.heavy.block.count).toBe(8);
    expect(r.plan.heavy.picks.map(p => p.name)).toEqual(['甲', '乙']);
    expect(r.plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('⭐ 第 1 名题材 4~6 只 → 只取 1 只（量比最高、重仓）', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8)
    ].concat(FILLER('T1', 3)).concat(XROWS(4, 1)));
    expect(r.plan.heavy.block.count).toBe(5);
    expect(r.plan.heavy.picks.map(p => p.name)).toEqual(['甲']);
    expect(r.plan.heavy.picks.map(p => p.position)).toEqual([POSITION_HEAVY]);
  });

  it('⭐ 1~3 只 → 该题材【不出票、空仓】，另一个题材照常出票', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9),
      E('乙', 'T1', 80, false, true, 3, '', false, 8),
      E('丙', 'T1', 70, false, true, 3, '', false, 7)
    ].concat(XROWS(4, 1)));
    expect(r.blocks.map(b => b.topic)).toEqual(['T1', 'X']);
    // 第 1 名题材：3 只 ⇒ 空仓（不是「买 1 只」，也不是「整块不显示」）
    expect(r.plan.heavy.qualified).toBe(false);
    expect(r.plan.heavy.picks).toEqual([]);
    expect(r.plan.heavy.notQualifiedText).toContain('空仓');
    expect(r.plan.heavy.notQualifiedText).toContain(ruleTag(RULE_NO.FIRST));
    // ⛔ 另一个题材照常出票（这才是用户口径「该题材不出票，另一个照常」）
    expect(r.plan.light.qualified).toBe(true);
    expect(r.plan.light.picks.map(p => p.name)).toEqual(['X1']);
  });

  it('第 2 名题材用的是【同一套】分档规则（只差排名词与规则编号）', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8)
    ].concat(FILLER('T1', 8)).concat(XROWS(7, 1)));
    expect(r.plan.light.block.count).toBe(7);          // 7 只 ⇒ mid 档
    expect(r.plan.light.picks.length).toBe(2);
    expect(r.plan.light.picks.map(p => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
    expect(r.plan.light.ruleNo).toBe(RULE_NO.SECOND);
    expect(r.plan.light.reason).toContain('根据规则' + RULE_NO.SECOND);
  });

  it('⛔ 一字门槛已删除：题材【0 个竞价一字】照样按分档出票', () => {
    // 2 只具名 + 8 只凑数 = 10 只 ⇒ 大档（取 3 只）—— 一字数为 0 也照样出票（一模一样的档位规则）
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8)
    ].concat(FILLER('T1', 8)).concat(XROWS(4, 1)));
    expect(r.plan.heavy.block.count).toBe(10);
    expect(r.plan.heavy.block.yiziCount).toBe(0);
    expect(r.plan.heavy.reason).toContain('大档');      // 10 只 ⇒ 大档（3 只：前二重仓 + 第 3 轻仓）
    expect(r.plan.heavy.qualified).toBe(true);
    expect(r.plan.heavy.picks.length).toBe(3);
    expect(r.plan.heavy.picks.map(p => p.position))
      .toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
  });

  it('结构契约：noYizi / smallTopic / bigTopic 恒为 null（UI 的 buySpecial 兜底面板永不出现）', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9),
      E('乙', 'T1', 80, false, true, 3, '', false, 8)
    ].concat(XROWS(4, 1)));
    expect(r.plan.noYizi).toBe(null);
    expect(r.plan.smallTopic).toBe(null);
    expect(r.plan.bigTopic).toBe(null);
    expect(r.plan.dualMainNotes).toBeUndefined();       // ⑨ 双主线整体删除
  });

  it('当日没有成组题材 → heavy / light 都是 null（⛔ 不能返回空壳对象，模板 v-if 会崩）', () => {
    const p = buildBuyPlan([], new Map());
    expect(p.heavy).toBe(null);
    expect(p.light).toBe(null);
  });

  it('只有第 1 名题材（没有第 2 名）→ light 为 null，heavy 照常', () => {
    const r = plan([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8),
      E('丙', 'T1', 70, false, true, 3, '', false, 7), E('丁', 'T1', 60, false, true, 3, '', false, 6)
    ].concat(FILLER('T1', 6)));
    expect(r.plan.heavy.qualified).toBe(true);
    expect(r.plan.light).toBe(null);
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
  const text = () => lines.join('\n');

  // === [QUANT-PICK 2026-10-01] 规则说明必须同步买点新规（§6：规则与文案同处一处）===
  it('规则说明必须写清【题材排名 = 平均竞价量比降序】+【买点只看前二】', () => {
    const t = text();
    expect(t).toContain('平均竞价量比');        // 新的题材排名依据
    expect(t).toContain('排在第一和第二的题材');
    expect(t).toContain('题材排名前二');
  });

  it('规则说明必须写清【选票唯一依据 = 竞价量比】+ 不分龙一龙二 + 一字跳过 + 20%/30% 板照选', () => {
    const t = text();
    expect(t).toContain('竞价量比');            // 新规的核心字眼
    expect(t).toContain('不保底龙一');          // 用户原话「不选龙一」
    expect(t).toContain('先不分龙一 / 龙二了');
    expect(t).toContain('竞价一字买不进');      // 一字一律跳过
    expect(t).toContain('照选');                // 创业板 / 科创板 / 北交所不再顺延
    expect(t).toContain('§10');                 // 缺量比的处置写明了
  });

  it('规则说明必须写清【按题材数量分档】—— 四档的边界与只数都要能对上', () => {
    const t = text();
    expect(t).toContain(String(PICK_TIER_BIG_MIN));                     // 10
    expect(t).toContain(String(PICK_TIER_MID_MIN));                     // 7
    expect(t).toContain(String(PICK_TIER_MIN_COUNT));                   // 4
    expect(t).toContain('取【' + PICK_COUNT_BIG + ' 只】');
    expect(t).toContain('取【' + PICK_COUNT_MID + ' 只】');
    expect(t).toContain('取【' + PICK_COUNT_MIN + ' 只】');
    expect(t).toContain('空仓');                                        // 1~3 只 → 不出票
    expect(t).toContain(RULE_NO.FIRST + ' 排名第 1 的题材');
    expect(t).toContain(RULE_NO.SECOND + ' 排名第 2 的题材');
  });

  it('规则说明必须【点名已作废的旧规则】，否则用户会照旧条文理解', () => {
    const t = text();
    expect(t).toContain('已作废的旧规则');
    ['连板天梯兜底', '小题材兜底', '亏钱效应', '弱势题材', '双主线竞争', '买入只数限制', '卡位补偿']
      .forEach(function(w) { expect(t).toContain(w); });
  });

  it('规则说明必须覆盖【卖点按今日竞价高低开细分】（SELL-OPEN 第一层）', () => {
    const t = text();
    expect(t).toContain('按今日竞价高低开细分');     // 第一层标题
    expect(t).toContain('盯盘');                     // 深低开
    expect(t).toContain('立刻出');                   // 小低开
    expect(t).toContain('危');                       // 小低开的感叹号警示
    expect(t).toContain('分时整体曲线');             // 小幅高开
    expect(t).toContain('题材排名兜底时点');         // 第二层标题
    expect(t).toContain(SELL_TIME_CLOSE);
    expect(t).toContain(SELL_TIME_MIDDAY);
    expect(t).toContain('排第 2');                   // 第 2 名 + 只有 1 个一字的例外
    expect(t).toContain('只有龙一');
    expect(t).toContain(String(SELL_DEEP_LOW) + '%');
    expect(t).toContain('+' + SELL_MILD_HIGH + '%');
  });

  it('规则说明必须覆盖【行内竞价涨幅标签】（涨红底 / 跌绿底 / 平灰底）', () => {
    const t = text();
    expect(t).toContain('【竞价涨幅】小标签');
    expect(t).toContain('红底');
    expect(t).toContain('绿底');
    expect(t).toContain('灰底');
    expect(t).toContain('不显示这个标签');          // §10 缺数据不画成平开
  });

  it('规则说明必须覆盖【题材行 / 股票行数据口径】与三条后置标记', () => {
    const t = text();
    expect(t).toContain('实心红圆点');                              // 题材行的排名圆点说明
    expect(t).toContain('【股票行的数据】');
    expect(t).toContain(RULE_NO.HOLD + ' 【' + HOLD_TAG + '】');
    expect(t).toContain(RULE_NO.PREV_BOUGHT + ' 【' + TOPIC_PREV_BOUGHT_TAG + '】');
    expect(t).toContain(RULE_NO.TOPIC_STREAK + ' 【入选次数】');
  });

  it('规则文案里不再出现「建议」二字（用户要求：直接写重仓/轻仓、几点卖）', () => {
    expect(text()).not.toContain('建议');
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
  /**
   * 把一个买点计划里所有档位的 picks 摊平。
   * ⚠️ [QUANT-PICK 2026-10-01] 三个兜底键现在恒为 null（用户口径「不分弱势题材」），
   *    保留 5 槽位遍历是为了「以后真加回兜底方案时用例口径不会静默变窄」，⛔ 不是死代码。
   */
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

  /** 档位与龙位是这套样本的前提，先钉住 —— 否则下面所有断言都可能测到空气 */
  it('样本前提：T = 10 只（大档 3 只）｜X = 7 只（中档 2 只：1 重仓 + 1 轻仓）', () => {
    const plan = buildBuyPlan(rankDecisionTopics(rows()), rankDragons(rankDecisionTopics(rows())));
    expect(plan.heavy.block.topic).toBe('T');
    expect(plan.heavy.block.count).toBe(10);
    expect(plan.heavy.picks.map((p) => p.name))
      .toEqual(['昨天买过的', '昨天没买的', '凑T1']);
    expect(plan.heavy.picks.map((p) => p.position))
      .toEqual([POSITION_HEAVY, POSITION_HEAVY, POSITION_LIGHT]);
    expect(plan.light.block.topic).toBe('X');
    expect(plan.light.block.count).toBe(7);
    expect(plan.light.picks.map((p) => p.name)).toEqual(['X一', 'X二']);
    expect(plan.light.picks.map((p) => p.position)).toEqual([POSITION_HEAVY, POSITION_LIGHT]);
  });

  // ⚠️ 样本刻意让【同一题材 T】里既有「昨天买过」的、也有「昨天没买过」的 —— 这就是
  //    2026-09-30 用户反馈的真实事故形态：9/29 的 buy 标签只有【世联行、新华文轩】，
  //    地产链里的大亚圣象没买过，却被【整块】标上了「昨天已买」（因为当时按题材判）。
  //
  // ⚠️ [QUANT-PICK 2026-10-01] 只数直接决定档位，所以两个题材的只数【刻意排开】：
  //    T = 4 具名 + 6 凑数 = 10 只 ⇒ 大档（3 只：前二重仓 + 第 3 轻仓）→ 用来看「重仓也被标」；
  //    X = 2 具名 + 5 凑数 = 7 只 ⇒ 中档（2 只：第 1 只重仓 + 第 2 只轻仓）→ 用来看「轻仓也被标」。
  //    全部【不传竞价量比】⇒ 走 §10 退路「按龙头名次取票」，龙位顺序完全是确定的
  //    （X一 十日涨幅 20 > X二 10 > 凑数票 -100…），用例因此不依赖任何数字巧合。
  const rows = () => [
    E('昨天买过的', 'T', 90, false, true, 5),   // 十日涨幅最高 → 龙一，必入选（重仓档）
    E('昨天没买的', 'T', 85, false, true, 4),   // 龙二，同样入选（重仓档）
    E('T一字A', 'T', 80, true),
    E('T一字B', 'T', 70, true),
    E('X一', 'X', 20, false, true, 2), E('X二', 'X', 10, false, true, -1)
  ].concat(FILLER('T', 6)).concat(FILLER('X', 5));   // T→10 只（大档）｜X→7 只（中档）

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
    // ⚠️ [VRATIO-PICK 2026-10-01] ① 的量比说明本来就会把入选项逐个列出（含「昨天没买的」），
    //    所以这里必须【只挑 ⑫ 那条说明】来断言 —— ⛔ 不能对整块 notes 做 not.toContain。
    const prevNotes = (plan.heavy.notes || []).filter(function(n) {
      return String(n).indexOf(PREV_BOUGHT_TAG) >= 0;
    });
    expect(prevNotes.length).toBeGreaterThan(0);
    expect(prevNotes.join('｜')).toContain('昨天买过的');
    expect(prevNotes.join('｜')).not.toContain('昨天没买的');
  });

  it('昨天一只都没买（空集）→ 一个都不标，仓位也不改', () => {
    const plan = planOf(new Set());
    const picks = allPicks(plan);
    expect(picks.some((p) => p.prevBoughtTag)).toBe(false);
    expect(picks.some((p) => p.position === POSITION_ADD)).toBe(false);
    expect(picks.every((p) => p.position === POSITION_HEAVY || p.position === POSITION_LIGHT)).toBe(true);
    expect(plan.heavy.notes.join('｜')).not.toContain(PREV_BOUGHT_TAG);
  });

  it('§10：昨天的标签没读到（null）→ 一律不标，仓位也不改（未知 ≠ 昨天没买）', () => {
    const plan = planOf(null);
    const picks = allPicks(plan);
    expect(picks.some((p) => p.prevBoughtTag)).toBe(false);
    expect(picks.some((p) => p.position === POSITION_ADD)).toBe(false);
    expect(plan.heavy.notes.join('｜')).not.toContain(PREV_BOUGHT_TAG);
  });

  // ===== [POSITION-ADD 2026-09-30 用户口径] 带【昨天已买】标 ⇒ 仓位改标【加仓】 =====
  // 用户原话：「买点被选出的股票那里如果标记昨天已买的标签，旁边那个轻仓应该变成加仓，
  //           这样更加知道那是昨天的票延续走强」；随后明确选择「重仓、轻仓都变加仓」。
  // 语义：「重仓 / 轻仓」是【建多少仓】的建议；昨天已经买了 ⇒ 今天这一笔的动作是【加仓】。
  it('🔴 重仓的票带【昨天已买】⇒ 仓位改标【加仓】，配色档同步换成 add', () => {
    const plan = planOf(new Set(['昨天买过的']));
    const p = allPicks(plan).find((x) => x.name === '昨天买过的');
    expect(p.prevBoughtTag).toBe(PREV_BOUGHT_TAG);
    expect(p.position).toBe(POSITION_ADD);           // 原来是重仓
    expect(p.positionTone).toBe(POSITION_TONE_ADD);  // ⛔ tone 必须一起换，否则 UI 还是红的
  });

  it('🔴 轻仓的票带【昨天已买】⇒ 仓位同样改标【加仓】', () => {
    // 第 2 名题材 X（7 只 ⇒ 中档）取 2 只：X一【重仓】+ X二【轻仓】。
    // 本用例要的是【轻仓】那一只 ⇒ 直接用 X二（⛔ 别拿 X一 测「轻仓」，它是重仓）。
    // ① 先在不打标的计划里确认它【本来就是轻仓】（否则下面测的就不是「轻仓 → 加仓」了）
    const plain = allPicks(planOf(new Set())).find((x) => x.name === 'X二');
    expect(plain).toBeTruthy();
    expect(plain.position).toBe(POSITION_LIGHT);
    expect(plain.positionTone).toBe(POSITION_TONE_LIGHT);
    // ② 打上「昨天已买」⇒ 仓位与配色档【一起】改标加仓
    const plan = planOf(new Set(['X二']));
    const light = allPicks(plan).find((x) => x.name === 'X二');
    expect(light).toBeTruthy();                      // 先钉住「它确实在买点里」，否则是空测
    expect(light.prevBoughtTag).toBe(PREV_BOUGHT_TAG);
    expect(light.position).toBe(POSITION_ADD);
    expect(light.positionTone).toBe(POSITION_TONE_ADD);
  });

  it('没被标的票保持原仓位，配色档也正确（重仓=heavy / 轻仓=light）', () => {
    const picks = allPicks(planOf(new Set(['昨天买过的'])));
    picks.filter((p) => p.name === '昨天没买的').forEach((p) => {
      expect(p.position).toBe(POSITION_HEAVY);
      expect(p.positionTone).toBe(POSITION_TONE_HEAVY);
    });
    // X一 = 中档第 1 只 ⇒ 重仓；X二 = 中档第 2 只 ⇒ 轻仓（两只都没被标，各自保持原仓位）
    picks.filter((p) => p.name === 'X一').forEach((p) => {
      expect(p.position).toBe(POSITION_HEAVY);
      expect(p.positionTone).toBe(POSITION_TONE_HEAVY);
    });
    picks.filter((p) => p.name === 'X二').forEach((p) => {
      expect(p.position).toBe(POSITION_LIGHT);
      expect(p.positionTone).toBe(POSITION_TONE_LIGHT);
    });
  });

  it('positionToneOf：未知 / 缺值一律回落「重仓」档（⛔ 不会拼出空类名把样式丢掉）', () => {
    expect(positionToneOf(POSITION_HEAVY)).toBe(POSITION_TONE_HEAVY);
    expect(positionToneOf(POSITION_LIGHT)).toBe(POSITION_TONE_LIGHT);
    expect(positionToneOf(POSITION_ADD)).toBe(POSITION_TONE_ADD);
    expect(positionToneOf('')).toBe(POSITION_TONE_HEAVY);
    expect(positionToneOf(undefined)).toBe(POSITION_TONE_HEAVY);
  });

  it('🔴 两个买点块都按【股票级】标：第 1 名块与第 2 名块各自命中各自的行', () => {
    // 用户口径：昨天已买是【个股】结论 ⇒ 与它在第几个题材块无关，两块一视同仁。
    const plan = planOf(new Set(['昨天没买的', 'X二']));
    const tagged = allPicks(plan).filter((p) => p.prevBoughtTag === PREV_BOUGHT_TAG)
      .map((p) => p.name).sort();
    expect(tagged).toEqual(['X二', '昨天没买的']);
    // 反派：同题材里没被标的票⛔ 不许被顺带标上（这正是 9/30 那次事故的形态）
    expect(allPicks(plan).find((p) => p.name === '昨天买过的').prevBoughtTag).toBeUndefined();
    expect(allPicks(plan).find((p) => p.name === 'X一').prevBoughtTag).toBeUndefined();
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

  // ===== [TOPIC-PREV-BOUGHT 2026-09-30 用户口径 · 第三版] 标记【回到题材行】=====
  // 用户原话：「昨天已买应该是标注在题材名称旁那里（竞价一字右边）」；
  // 并在 AskUserQuestion 里确认选【只标题材行】⇒ 题材级标记改用措辞【昨有买入】
  // （⛔ 继续叫「昨天已买」又会被读成个股结论 —— 那正是同日的第一次事故形态）。
  const topicPlanOf = (prevBoughtNames, prevBoughtTopics) => {
    const blocks = rankDecisionTopics(rows());
    return buildBuyPlan(blocks, rankDragons(blocks), {
      prevBoughtNames: prevBoughtNames,
      prevBoughtTopics: prevBoughtTopics
    });
  };

  it('🔴 回归：题材行标【昨有买入】，且只按题材命中 —— 集合外的题材不标', () => {
    const plan = topicPlanOf(new Set(['昨天买过的']), new Set(['T']));
    expect(plan.heavy.block.topic).toBe('T');
    expect(plan.heavy.prevBoughtTag).toBe(TOPIC_PREV_BOUGHT_TAG);
    // 第 2 名题材 X 没在集合里 → 题材行不标
    expect(plan.light.prevBoughtTag).toBeUndefined();
  });

  it('🔴 反派回归：题材行【不许】再挂「昨天已买」这个说法，旧字段名也不许复活', () => {
    const plan = topicPlanOf(new Set(['昨天买过的']), new Set(['T']));
    expect(plan.heavy.prevBoughtTag).not.toBe(PREV_BOUGHT_TAG);
    expect(plan.heavy.block.prevBoughtTopic).toBeUndefined();
    expect(plan.heavy.prevBoughtTopic).toBeUndefined();
  });

  it('§10：prevBoughtTopics = null / 空集 → 题材行一律不标（未知 ≠ 昨天没人买）', () => {
    expect(topicPlanOf(new Set(['昨天买过的']), null).heavy.prevBoughtTag).toBeUndefined();
    expect(topicPlanOf(new Set(['昨天买过的']), new Set()).heavy.prevBoughtTag).toBeUndefined();
  });

  it('🔴 回归（9/30 事故形态）：题材行有标时，同题材里【昨天没买过的那只】仍不改加仓', () => {
    const plan = topicPlanOf(new Set(['昨天买过的']), new Set(['T']));
    const picks = plan.heavy.picks;
    expect(plan.heavy.prevBoughtTag).toBe(TOPIC_PREV_BOUGHT_TAG);   // 题材级：标了
    expect(picks.find((p) => p.name === '昨天买过的').position).toBe(POSITION_ADD);
    // ⛔ 这只在同一个题材块里，但昨天没买 → 【不许】跟着变加仓
    expect(picks.find((p) => p.name === '昨天没买的').position).toBe(POSITION_HEAVY);
  });

  // ===== [TOPIC-STREAK 2026-09-30 用户口径] 题材入选次数（近 5 个交易日，含今日）=====
  // 用户原话：「如果题材在五天内，第一次入选进入买点，题材行（竞价一字旁边）应该标上，
  //           一次入选，二次入选，三次入选……，这样我就知道频率」。
  it('topicStreakText：1~5 用中文序数；0 / 非法 → 空串（⛔ 不显示成「零次入选」）', () => {
    expect(topicStreakText(1)).toBe('一次入选');
    expect(topicStreakText(2)).toBe('二次入选');
    expect(topicStreakText(3)).toBe('三次入选');
    expect(topicStreakText(4)).toBe('四次入选');
    expect(topicStreakText(5)).toBe('五次入选');
    expect(topicStreakText(0)).toBe('');
    expect(topicStreakText(null)).toBe('');
    expect(topicStreakText(undefined)).toBe('');
    expect(topicStreakText('x')).toBe('');
  });

  it('🔴 入选次数 = 过去窗口内次数 + 1（今天的这一块本身就是本次入选）', () => {
    const blocks = rankDecisionTopics(rows());
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      topicStreakPast: new Map([['T', 3]])        // 过去 4 个交易日里 T 进过 3 次
    });
    expect(plan.heavy.streakTag).toBe('四次入选');   // 3 + 今天这一次
    // 第 2 名题材 X 过去没进过 → 今天是第一次
    expect(plan.light.streakTag).toBe('一次入选');
  });

  it('§10：topicStreakPast = null / 未传（窗口内有历史日算不出来）→ 【两块都】不标', () => {
    const blocks = rankDecisionTopics(rows());
    const dragon = rankDragons(blocks);
    // null = 明确「读不到」；undefined = 调用方压根没给 ⇒ 一律不标（⛔ 不用偏低次数冒充）
    [null, undefined].forEach(function(past) {
      const plan = buildBuyPlan(blocks, dragon, { topicStreakPast: past });
      expect(plan.heavy.streakTag).toBeUndefined();
      expect(plan.light.streakTag).toBeUndefined();
    });
  });

  it('🔴 两块各数各的：第 1 名与第 2 名的入选次数【互不串味】', () => {
    const blocks = rankDecisionTopics(rows());
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      // 只给 X 历史次数（过去 2 次），T 不在表里 ⇒ T 今天是第一次
      topicStreakPast: new Map([['X', 2]])
    });
    expect(plan.heavy.block.topic).toBe('T');
    expect(plan.heavy.streakTag).toBe('一次入选');
    expect(plan.light.block.topic).toBe('X');
    expect(plan.light.streakTag).toBe('三次入选');   // 过去 2 次 + 今天这一次
    // ⛔ 窗口内有历史日但某题材一次都没进过 = 0 次，不是「读不到」⇒ 仍然标「一次入选」
    expect(plan.heavy.streakTag).not.toBeUndefined();
    expect(TOPIC_STREAK_WINDOW).toBe(5);   // 窗口 = 近 5 个交易日（含今日），数字只认常量
  });

  it('题材级【昨有买入】只认前二块自己的题材，⛔ 不会因为「别的题材昨天买过」而串标', () => {
    const blocks = rankDecisionTopics(rows());
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {
      prevBoughtNames: new Set(['昨天买过的']),
      prevBoughtTopics: new Set(['某个没进前二的题材'])
    });
    expect(plan.heavy.prevBoughtTag).toBeUndefined();
    expect(plan.light.prevBoughtTag).toBeUndefined();
  });

  it('卖点侧不出现这两个题材行标记（⑫ / ⑬ 都是买点侧专有）', () => {
    const blocks = rankDecisionTopics([
      E('S龙一', 'S', 30, true), E('S龙二', 'S', 20, true), E('S三', 'S', 10),
      E('W一', 'W', 9), E('W二', 'W', 8)
    ]);
    const plan = buildSellPlan(
      [{ name: 'S三', topic: 'S', pct: 10, inTodayList: true }],
      blocks, rankDragons(blocks), new Set(), new Set()
    );
    expect(plan[0].prevBoughtTag).toBeUndefined();
    expect(plan[0].streakTag).toBeUndefined();
  });

  it('规则面板里有 ⑬ 这条，且 ⑫ / ⑬ 两个说法都能逐条核对', () => {
    const text = buildRulesLines().join('\n');
    expect(text).toContain(RULE_NO.TOPIC_STREAK);
    expect(text).toContain(TOPIC_PREV_BOUGHT_TAG);
    expect(text).toContain(String(TOPIC_STREAK_WINDOW));
  });
});

// === [RULE-NO 2026-09-27 用户口径] 说明文字必须标注规则编号（像法律条文一样能查出处）===
// ⚠️ [QUANT-PICK 2026-10-01 重排] 旧编号 ⑤~⑩ 对应的规则已整体删除，编号收起为 ①②③④⑤：
//    ① 第 1 名题材 / ② 第 2 名题材 / ③ 持有加仓 / ④ 昨有买入与加仓 / ⑤ 入选次数。
describe('规则编号标注（RULE-NO）', () => {
  it('每个编号唯一（编号一旦撞车，用户就分不清是哪条规则）', () => {
    const vals = Object.keys(RULE_NO).map(function(k) { return RULE_NO[k]; });
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('编号集中在 RULE_NO 里，⛔ 不在别处手写字面量（ruleTag 是唯一出口）', () => {
    expect(ruleTag('X')).toBe('【规则X】');
    expect(ruleTag(RULE_NO.HOLD)).toBe('【规则' + RULE_NO.HOLD + '】');
  });

  it('买点块带出自己的规则编号：第 1 名 → ①、第 2 名 → ②，理由文字里也带上', () => {
    const blocks = rankDecisionTopics([
      E('甲', 'T1', 90, false, true, 3, '', false, 9), E('乙', 'T1', 80, false, true, 3, '', false, 8),
      E('丙', 'T1', 70, false, true, 3, '', false, 7), E('丁', 'T1', 60, false, true, 3, '', false, 6),
      E('X1', 'X', 20, false, true, 1, '', false, 1), E('X2', 'X', 19, false, true, 1, '', false, 1),
      E('X3', 'X', 18, false, true, 1, '', false, 1), E('X4', 'X', 17, false, true, 1, '', false, 1)
    ].concat(FILLER('T1', 6)));
    const plan = buildBuyPlan(blocks, rankDragons(blocks));
    expect(plan.heavy.ruleNo).toBe(RULE_NO.FIRST);
    expect(plan.heavy.reason).toContain('根据规则' + RULE_NO.FIRST);
    expect(plan.light.ruleNo).toBe(RULE_NO.SECOND);
    expect(plan.light.reason).toContain('根据规则' + RULE_NO.SECOND);
  });
});

// === [COPY-ALL 2026-10-01 用户要求] 规则面板「一键复制」的纯文本 ===
// 复制出去的那段字，是用户拿去【核对规则对不对】的唯一凭据 ⇒ 必须与面板里逐行渲染的内容
// 一字不差（同一个 lines 数组）。这里钉住三件事：① 逐行还原；② 不掺 undefined/null；
// ③ 全角空格缩进不被吃掉（规则正文靠它分层，吃了就看不出层级了）。
describe('joinRulesLines（一键复制的纯文本）', () => {
  it('逐行还原 buildRulesLines()：行数一致、内容一字不差、顺序不变', () => {
    const lines = buildRulesLines();
    const back = joinRulesLines(lines).split('\n');
    expect(back.length).toBe(lines.length);
    expect(back).toEqual(lines);
  });

  it('复制文本里不得出现 undefined / null 字面量', () => {
    const text = joinRulesLines(buildRulesLines());
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('保留全角空格缩进（⛔ 不能被 trim / 过滤掉）', () => {
    const lines = buildRulesLines();
    const text = joinRulesLines(lines);
    const indented = lines.filter((l) => l.indexOf('　') === 0);
    expect(indented.length).toBeGreaterThan(0);
    indented.forEach((l) => {
      expect(text).toContain(l);
    });
  });

  it('坏输入不炸：null / undefined / 空串逐项跳过，其余照常拼接', () => {
    expect(joinRulesLines(null)).toBe('');
    expect(joinRulesLines(undefined)).toBe('');
    expect(joinRulesLines([])).toBe('');
    expect(joinRulesLines('不是数组')).toBe('');   // ⛔ 传字符串也当空处理，绝不按字符拆
    expect(joinRulesLines(['A', null, 'B', undefined, '', 'C'])).toBe('A\nB\nC');
  });

  it('非字符串项按 String() 转换（数字行不丢，0 也是有效值）', () => {
    expect(joinRulesLines(['A', 1, 0])).toBe('A\n1\n0');
    expect(joinRulesLines([0])).toBe('0');
  });

  it('确实覆盖了整份规则：抽买点/卖点/股票行三段代表条文都能找到', () => {
    const text = joinRulesLines(buildRulesLines());
    expect(text).toContain('【买点】只看题材排名前二的题材');
    expect(text).toContain('【卖点】候选 = 昨日打过「买」标签的股票');
    expect(text).toContain('【股票行的数据】');
  });
});
