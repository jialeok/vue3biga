import { describe, it, expect } from 'vitest';
import { sortByTopicGroups } from './topic-sort.js';

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
