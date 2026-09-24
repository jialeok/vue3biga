import { describe, it, expect } from 'vitest';
import {
  sortByTopicGroups,
  buildTopicColorMap,
  selectPrimaryTopic,
  buildTopicSizeMap,
  OTHER_TOPIC
} from './topic-sort.js';

// 构造 3 个题材：AI(3 只，含 2 个一字)、农业(4 只，含 1 个一字)、电力(15 只，无一字)
function setup() {
  const list = [
    { stock: 'AI1', code: '600001', auc_pct_chg: '+10.02%' },
    { stock: 'AI2', code: '600002', auc_pct_chg: '+10.00%' },
    { stock: 'AI3', code: '600003', auc_pct_chg: '+1.00%' },
    { stock: '农1', code: '600011', auc_pct_chg: '+9.99%' },
    { stock: '农2', code: '600012', auc_pct_chg: '+2.00%' },
    { stock: '农3', code: '600013', auc_pct_chg: '+0.00%' },
    { stock: '农4', code: '600014', auc_pct_chg: '-1.00%' }
  ];
  const topicOf = {
    AI1: '人工智能', AI2: '人工智能', AI3: '人工智能',
    农1: '农业', 农2: '农业', 农3: '农业', 农4: '农业'
  };
  return {
    list,
    order: list.map((_, i) => i),
    tierFn: () => 0,
    primaryTopicOf: (idx) => topicOf[list[idx].stock] || '其它'
  };
}

describe('sortByTopicGroups 题材组排序', () => {
  it('无一字时退化为「题材数量降序」（既有口径不变）', () => {
    const s = setup();
    const out = sortByTopicGroups(s.order, s.list, s.tierFn, s.primaryTopicOf);
    expect(out.map(i => s.list[i].stock)).toEqual(['农1', '农2', '农3', '农4', 'AI1', 'AI2', 'AI3']);
  });

  it('一字数量多的题材排最前（AI 2 个一字 > 农业 1 个一字，尽管农业股票更多）', () => {
    const s = setup();
    const yiZiOf = (idx) => String(s.list[idx].auc_pct_chg).startsWith('+1');
    const out = sortByTopicGroups(s.order, s.list, s.tierFn, s.primaryTopicOf, null, yiZiOf);
    expect(out.map(i => s.list[i].stock)).toEqual(['AI1', 'AI2', 'AI3', '农1', '农2', '农3', '农4']);
  });

  it('无一字题材按题材数量降序（电力 15 > AI应用 12）', () => {
    const list = [];
    const topicOf = {};
    for (let i = 0; i < 15; i++) { topicOf['D' + i] = '电力'; list.push({ stock: 'D' + i, auc_pct_chg: '+1%' }); }
    for (let i = 0; i < 12; i++) { topicOf['A' + i] = 'AI应用'; list.push({ stock: 'A' + i, auc_pct_chg: '+1%' }); }
    const order = list.map((_, i) => i);
    const out = sortByTopicGroups(order, list, () => 0, (idx) => topicOf[list[idx].stock], null, () => false);
    expect(out[0]).toBe(0); // 电力在最前
    expect(list[out[out.length - 1]].stock).toBe('A11'); // AI应用 12 只在后
  });

  it('"其它"组永远置底', () => {
    const list = [
      { stock: 'X1', auc_pct_chg: '+1%' },
      { stock: 'X2', auc_pct_chg: '+10%' }
    ];
    const topicOf = { X1: '其它', X2: '农业' };
    const out = sortByTopicGroups([0, 1], list, () => 0, (idx) => topicOf[list[idx].stock], null, (idx) => idx === 0);
    expect(list[out[0]].stock).toBe('X2');
    expect(list[out[1]].stock).toBe('X1');
  });
});

// [NOT-FORMAL 2026-09-23] 只统计「当天 9:25 正式成员」：观察组继承壳照常渲染、照常落进自己的题材组，
// 但不贡献「组大小 / 一字数」⇒ 题材块顺序 == 统计条数字 == 趋势图名次（用户反馈的错位根因）。
describe('sortByTopicGroups countableOf（只统计正式成员）', () => {
  it('不计入的行仍在自己的题材组里渲染，只是不贡献计数', () => {
    // 人工智能：正式 1 只(AI1, 一字) + 继承壳 2 只(AI2/AI3，其中 AI2 也是一字)
    // 农业    ：正式 2 只，0 个一字
    const s = setup();
    const formal = new Set(['AI1', '农1', '农2']);
    const countableOf = (idx) => formal.has(s.list[idx].stock);
    const yiZiOf = (idx) => String(s.list[idx].auc_pct_chg).startsWith('+1');
    const out = sortByTopicGroups(s.order, s.list, s.tierFn, s.primaryTopicOf, null, yiZiOf, countableOf);
    // 人工智能 1 个一字 > 农业 0 个 → 人工智能在前；继承壳 AI2/AI3 跟着本组一起走（没有被丢掉）
    expect(out.map(i => s.list[i].stock)).toEqual(['AI1', 'AI2', 'AI3', '农1', '农2', '农3', '农4']);
  });

  it('⚠️ 继承壳的一字【不算】→ 题材组顺序按正式成员的一字数排（错位修复的本体）', () => {
    // 电子：正式 0 个一字（两只都只有 +1%），但继承壳 E3 是一字 → 若把壳算进去电子会排第一（错位）
    const list = [
      { stock: 'E1', auc_pct_chg: '+0.5%' },
      { stock: 'E2', auc_pct_chg: '+2%' },
      { stock: 'E3', auc_pct_chg: '+10%', obsAutoAdded: true }, // 观察组继承壳，一字
      { stock: 'C1', auc_pct_chg: '+10%' },                      // 通信：正式成员 1 个一字
      { stock: 'C2', auc_pct_chg: '+3%' }
    ];
    const topicOf = { E1: '电子', E2: '电子', E3: '电子', C1: '通信', C2: '通信' };
    const order = list.map((_, i) => i);
    const yiZiOf = (idx) => String(list[idx].auc_pct_chg).startsWith('+1');

    // 不传 countableOf（旧行为）：电子 1 个一字 == 通信 1 个一字 → 按组大小，电子(3) > 通信(2) → 电子在前
    const old = sortByTopicGroups(order, list, () => 0, (idx) => topicOf[list[idx].stock], null, yiZiOf);
    expect(list[old[0]].stock).toBe('E1');

    // 传 countableOf（正式成员口径）：电子 0 一字 < 通信 1 一字 → 通信排到电子前
    const formal = new Set(['E1', 'E2', 'C1', 'C2']);
    const next = sortByTopicGroups(order, list, () => 0, (idx) => topicOf[list[idx].stock], null, yiZiOf,
      (idx) => formal.has(list[idx].stock));
    expect(next.map(i => list[i].stock)).toEqual(['C1', 'C2', 'E1', 'E2', 'E3']); // 继承壳 E3 仍跟在本组里渲染
  });

  it('整个题材没有正式成员 → 组大小 0，排在有正式成员的题材之后', () => {
    const list = [
      { stock: 'G1', auc_pct_chg: '+1%' },   // 光模块：只有继承壳
      { stock: 'Z1', auc_pct_chg: '+1%' },   // 算力：2 只正式成员
      { stock: 'Z2', auc_pct_chg: '+2%' }
    ];
    const topicOf = { G1: '光模块', Z1: '算力', Z2: '算力' };
    const order = list.map((_, i) => i);
    const formal = new Set(['Z1', 'Z2']);
    const out = sortByTopicGroups(order, list, () => 0, (idx) => topicOf[list[idx].stock], null, () => false,
      (idx) => formal.has(list[idx].stock));
    expect(out.map(i => list[i].stock)).toEqual(['Z1', 'Z2', 'G1']);
  });
});

// [NOT-FORMAL 2026-09-23] 底色【不】按正式成员过滤（过滤过，用户反馈「题材组内的底色不见了」）。
// 这条用例把「不足 2 只不上色」的既有门槛钉住，防止日后有人顺手改成按统计口径过滤。
describe('buildTopicColorMap 门槛（不按正式成员过滤）', () => {
  it('不足 2 只的题材不上色；达到 2 只就上色（含观察组继承行）', () => {
    const m = new Map([['甲', '芯片'], ['乙', '芯片'], ['丙', '农业']]);
    expect(buildTopicColorMap(m).has('芯片')).toBe(true);
    expect(buildTopicColorMap(m).has('农业')).toBe(false);
  });
});

// ============================================================================
// [MAJORITY-SIDE 2026-09-24] 一只股票当天同时命中多个大类题材时，【站队到数量多的那一边】。
// 旧实现按「分组数组里第一次出现」站队 ⇒ 七匹狼(服装家纺/海峡两岸)被塞进人少的大消费、
// 新华都(AI营销/AI应用/海峡两岸)被塞进人少的 AI应用。下面的用例把新口径钉死。
// ============================================================================
describe('selectPrimaryTopic（多题材股票站队到数量多的一边）', () => {
  it('海峡两岸 11 只 > AI应用 6 只 ⇒ 新华都站队海峡两岸', () => {
    const size = new Map([['AI应用', 6], ['海峡两岸', 11]]);
    expect(selectPrimaryTopic(['AI营销', 'AI应用', '海峡两岸'], size, null)).toBe('海峡两岸');
    expect(selectPrimaryTopic(['AI应用', '海峡两岸'], size, null)).toBe('海峡两岸');
  });

  it('顺序无关：候选数组谁先谁后，结果都一样（旧实现就是栽在这）', () => {
    const size = new Map([['大消费', 4], ['海峡两岸', 11]]);
    expect(selectPrimaryTopic(['大消费', '海峡两岸'], size, null)).toBe('海峡两岸');
    expect(selectPrimaryTopic(['海峡两岸', '大消费'], size, null)).toBe('海峡两岸');
  });

  it('⛔ 真实题材压过「其它」：「其它」是兜底大杂烩，数量天然最大，绝不能靠数量赢', () => {
    const size = new Map([['其它', 30], ['AI应用', 6]]);
    expect(selectPrimaryTopic(['其它', 'AI应用'], size, null)).toBe('AI应用');
    expect(selectPrimaryTopic(['AI应用', '其它'], size, null)).toBe('AI应用');
  });

  it('只有「其它」一个候选时才落到「其它」', () => {
    const size = new Map([['其它', 30], ['AI应用', 6]]);
    expect(selectPrimaryTopic(['其它'], size, null)).toBe(OTHER_TOPIC);
  });

  it('数量相同 → 按分组原顺序（星星数多的题材靠前）', () => {
    const size = new Map([['甲题材', 5], ['乙题材', 5]]);
    const order = new Map([['甲题材', 3], ['乙题材', 1]]);
    expect(selectPrimaryTopic(['甲题材', '乙题材'], size, order)).toBe('乙题材');
    expect(selectPrimaryTopic(['乙题材', '甲题材'], size, order)).toBe('乙题材');
  });

  it('数量与顺序都相同 → 按题材名字典序，保证每次渲染完全一致', () => {
    const size = new Map([['T2', 5], ['T1', 5]]);
    expect(selectPrimaryTopic(['T2', 'T1'], size, new Map())).toBe('T1');
    expect(selectPrimaryTopic(['T1', 'T2'], size, new Map())).toBe('T1');
  });

  it('§10 边界：候选为空 / 无规模数据 → 不抛错，退回「其它」或第一个候选', () => {
    expect(selectPrimaryTopic([], new Map(), null)).toBe(OTHER_TOPIC);
    expect(selectPrimaryTopic(null, new Map(), null)).toBe(OTHER_TOPIC);
    // 完全拿不到规模数据时退化为「取第一个候选」（既有行为，绝不炸）
    expect(selectPrimaryTopic(['T3', 'T4'], null, null)).toBe('T3');
  });
});

describe('buildTopicSizeMap（题材 → 当日股票数）', () => {
  it('由「股票名 → 主题材」反推各题材的成员数，供兜底路径复用同一套站队规则', () => {
    const m = new Map([['甲', '海峡两岸'], ['乙', '海峡两岸'], ['丙', 'AI应用']]);
    const sizes = buildTopicSizeMap(m);
    expect(sizes.get('海峡两岸')).toBe(2);
    expect(sizes.get('AI应用')).toBe(1);
  });

  it('空映射 → 空结果，不抛错', () => {
    expect(buildTopicSizeMap(null).size).toBe(0);
    expect(buildTopicSizeMap(new Map()).size).toBe(0);
  });
});
