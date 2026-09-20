// yizi-supplement.test.js — 「早盘竞价 · 补竞价一字」纯函数层单测
//
// 只测纯变换：一字看板的题材分块 → 补充区显示分组。⛔ 不碰网络 / state / DB / 早盘竞价数据。
// 重点锁死三条（写错会让用户拿到错误的「哪个题材一字多」结论）：
//   ① 组序 = 一字只数（组大小）降序 → 题材名 → 「其它」恒置底；
//   ② 空块被丢弃（不产出「【题材】0只」的假分组）；
//   ③ 只搬运既有字段（序号 / 龙头 / 十日涨幅 / 连板 / 封单额），⛔ 不重算任何口径。
import { describe, it, expect } from 'vitest';
import { buildYiziSupplementGroups, summarizeSupplement } from './yizi-supplement.js';

function row(stock, extra) {
  return Object.assign({ stock: stock, seq: 1, topicsDisplay: stock + ',题材A' }, extra || {});
}

describe('buildYiziSupplementGroups', () => {
  it('按一字只数降序排题材，「其它」恒置底（即使它最大）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '其它', count: 9, stocks: [row('无题A'), row('无题B'), row('无题C')] },
      { topic: '机器人', count: 5, stocks: [row('甲'), row('乙')] },
      { topic: '算力', count: 3, stocks: [row('丙'), row('丁'), row('戊')] }
    ]);
    expect(groups.map(g => g.topic)).toEqual(['算力', '机器人', '其它']);
    expect(groups.map(g => g.count)).toEqual([3, 2, 3]);
  });

  it('只数相同 → 按题材名升序（稳定，不受上游顺序影响）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: 'B题材', count: 1, stocks: [row('b1')] },
      { topic: 'A题材', count: 1, stocks: [row('a1')] }
    ]);
    expect(groups.map(g => g.topic)).toEqual(['A题材', 'B题材']);
  });

  it('空块被丢弃（不产出「0只」的假分组）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '空题材', count: 0, stocks: [] },
      { topic: '有题材', count: 1, stocks: [row('甲')] }
    ]);
    expect(groups.map(g => g.topic)).toEqual(['有题材']);
  });

  it('无题材字段 / 脏行不入渲染（stock 为空的行被剔除）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '', count: 3, stocks: [row('甲'), { stock: '  ' }, null] }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].topic).toBe('其它');
    expect(groups[0].count).toBe(1);
    expect(groups[0].stocks.map(s => s.stock)).toEqual(['甲']);
  });

  it('字段只搬运不重算：序号 / 龙头 / 十日涨幅 / 连板 / 封单额原样透出', () => {
    const groups = buildYiziSupplementGroups([
      {
        topic: '算力',
        count: 2,
        stocks: [
          row('甲', {
            seq: 1, isLeader: true, continueText: '三板',
            rangeText: '+50.29%(5/10日)', rangeTone: 'up', rangePct: 50.29,
            seal920Text: '3.20亿', sealDeltaText: '+0.50亿', sealDeltaTone: 'up'
          }),
          row('乙', { seq: 2, isLeader: false, rangePct: null })
        ]
      }
    ]);
    const [a, b] = groups[0].stocks;
    expect(a).toMatchObject({
      stock: '甲', seq: 1, isLeader: true, continueText: '三板',
      rangeText: '+50.29%(5/10日)', rangeTone: 'up',
      seal920Text: '3.20亿', sealDeltaText: '+0.50亿', sealDeltaTone: 'up'
    });
    // 缺十日涨幅的行：文本按缺省（空串 = 模板不渲染），⛔ 绝不伪造 0 / '-'
    expect(b.rangeText).toBe('');
    expect(b.isLeader).toBe(false);
    expect(b.continueText).toBe('');
  });

  it('十日涨幅缺失（null / undefined）不会退化成 0 或 "0.00%"', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 3, stocks: [row('甲', { rangePct: null }), row('乙', { rangePct: undefined }), row('丙', { rangeText: '0.00%', rangeTone: 'flat', rangePct: 0 })] }
    ]);
    const [a, b, c] = groups[0].stocks;
    expect(a.rangeText).toBe('');
    expect(b.rangeText).toBe('');
    // 真值 0 由一字看板自己格式化成 '0.00%' —— 这里原样透出，不做第二次判断
    expect(c.rangeText).toBe('0.00%');
  });

  it('缺 seq 时按行序回退（1 起），绝不留空序号', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 2, stocks: [row('甲', { seq: 0 }), row('乙', { seq: undefined })] }
    ]);
    expect(groups[0].stocks.map(s => s.seq)).toEqual([1, 2]);
  });

  it('入参不是数组 → 返回空数组（不抛）', () => {
    expect(buildYiziSupplementGroups(null)).toEqual([]);
    expect(buildYiziSupplementGroups(undefined)).toEqual([]);
    expect(buildYiziSupplementGroups({})).toEqual([]);
  });
});

// ============================================================================
// 排除「已在早盘竞价列表中」的股票（★ 本功能唯一有张力的一处）
//   用户两个要求必须同时满足：
//     (a) 补充的股票不是列表里的股票（不重复列同一只票）；
//     (b) 「看哪个题材的一字多」→ 题材的一字总只数必须是真话。
//   ⇒ 只数与行分开：totalCount 说真话、stocks 只放补充进来的那些、差额如实报。
// ============================================================================
describe('buildYiziSupplementGroups · 排除列表内股票', () => {
  it('列表内的股票不进行，且题材条仍能说出真实总只数', () => {
    const groups = buildYiziSupplementGroups([
      {
        topic: '算力', count: 3,
        stocks: [row('甲', { seq: 1 }), row('乙', { seq: 2 }), row('丙', { seq: 3 })]
      }
    ], { excludeNames: ['甲', '丙'] });

    expect(groups).toHaveLength(1);
    expect(groups[0].totalCount).toBe(3);   // 「算力有 3 只一字」= 事实，⛔ 不能因为排除就变成 1
    expect(groups[0].count).toBe(1);        // 真正补进来的只有 1 只
    expect(groups[0].inListCount).toBe(2);
    expect(groups[0].stocks.map(s => s.stock)).toEqual(['乙']);
  });

  it('排除后不重排序号（序号 = 题材内十日涨幅真实排名，可能出现跳号）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 3, stocks: [row('甲', { seq: 1 }), row('乙', { seq: 2 }), row('丙', { seq: 3 })] }
    ], { excludeNames: new Set(['甲', '乙']) });
    expect(groups[0].stocks.map(s => s.seq)).toEqual([3]);
  });

  it('整块都在列表里 → 该题材仍然保留（count=0），绝不整块消失', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 2, stocks: [row('甲'), row('乙')] },
      { topic: '机器人', count: 1, stocks: [row('丙')] }
    ], { excludeNames: ['甲', '乙'] });
    expect(groups.map(g => g.topic)).toEqual(['算力', '机器人']);
    expect(groups[0].count).toBe(0);
    expect(groups[0].stocks).toEqual([]);
    expect(groups[0].totalCount).toBe(2);
  });

  it('组序按【一字总只数】排（被列表占掉的不影响题材热度排序）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '小题材', count: 1, stocks: [row('甲')] },
      { topic: '大题材', count: 3, stocks: [row('乙'), row('丙'), row('丁')] }
    ], { excludeNames: ['乙', '丙', '丁'] });
    // 大题材一字总量 3 > 小题材 1 ⇒ 大题材仍排在前（尽管它一只都没补进来）
    expect(groups.map(g => g.topic)).toEqual(['大题材', '小题材']);
  });

  it('块内同名只算一次（防上游重复落行把题材热度算虚高）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 3, stocks: [row('甲', { seq: 1 }), row('甲', { seq: 2 }), row('乙', { seq: 3 })] }
    ]);
    expect(groups[0].totalCount).toBe(2);
    expect(groups[0].stocks.map(s => s.stock)).toEqual(['甲', '乙']);
  });

  it('excludeNames 接受数组 / Set / 空值，且会对空名与前后空格做归一', () => {
    const blocks = [{ topic: '算力', count: 2, stocks: [row('甲'), row('乙')] }];
    expect(buildYiziSupplementGroups(blocks, { excludeNames: [' 甲 '] })[0].stocks.map(s => s.stock)).toEqual(['乙']);
    expect(buildYiziSupplementGroups(blocks, { excludeNames: new Set(['甲']) })[0].stocks.map(s => s.stock)).toEqual(['乙']);
    expect(buildYiziSupplementGroups(blocks, { excludeNames: [] })[0].stocks.map(s => s.stock)).toEqual(['甲', '乙']);
    expect(buildYiziSupplementGroups(blocks, {})[0].stocks.map(s => s.stock)).toEqual(['甲', '乙']);
  });

  it('封单额色调 / 首封时刻也一并搬运（供行内配色与悬停提示）', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 1, stocks: [row('甲', { seal920Text: '3.20亿', seal920Tone: 'strong', firstTimeText: '09:15:03' })] }
    ]);
    expect(groups[0].stocks[0]).toMatchObject({
      seal920Text: '3.20亿', seal920Tone: 'strong', firstTimeText: '09:15:03'
    });
  });
});

describe('summarizeSupplement', () => {
  it('统计总只数 / 补充只数 / 题材个数 / 已在列表只数', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 2, stocks: [row('甲'), row('乙')] },
      { topic: '机器人', count: 1, stocks: [row('丙')] }
    ]);
    expect(summarizeSupplement(groups)).toEqual({
      stockCount: 3, topicCount: 2, totalStockCount: 3, inListCount: 0
    });
  });

  it('有排除时：总数不变、补充数变小、差额计入 inListCount', () => {
    const groups = buildYiziSupplementGroups([
      { topic: '算力', count: 3, stocks: [row('甲'), row('乙'), row('丙')] },
      { topic: '机器人', count: 1, stocks: [row('丁')] }
    ], { excludeNames: ['甲', '丁'] });
    expect(summarizeSupplement(groups)).toEqual({
      stockCount: 2, topicCount: 2, totalStockCount: 4, inListCount: 2
    });
  });

  it('空输入 → 全 0', () => {
    expect(summarizeSupplement([])).toEqual({ stockCount: 0, topicCount: 0, totalStockCount: 0, inListCount: 0 });
    expect(summarizeSupplement(null)).toEqual({ stockCount: 0, topicCount: 0, totalStockCount: 0, inListCount: 0 });
  });
});
