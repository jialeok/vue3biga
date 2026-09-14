import { describe, it, expect } from 'vitest';
import { pickTopicLeaders } from './dragon-leader-pick.js';

// 便捷构造：股票名 → {pct}
function rp(entries) {
  const m = new Map();
  Object.keys(entries).forEach(function(k) { m.set(k, { pct: entries[k] }); });
  return m;
}

describe('pickTopicLeaders 龙头评选（题材成员>=3 选区间涨幅最高）', () => {
  it('成员>=3 → 选出区间涨幅最高者，并带上题材/成员数', () => {
    const groups = [
      { topic: '机器人', stocks: [{ stock: '甲' }, { stock: '乙' }, { stock: '丙' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 甲: 5.1, 乙: 31.7, 丙: 12.0 }), 3, () => 'SH600000');
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe('机器人');
    expect(out[0].stock).toBe('乙');
    expect(out[0].pct).toBe(31.7);
    expect(out[0].groupSize).toBe(3);
    expect(out[0].code).toBe('SH600000');
  });

  it('成员 < 3 → 不评选（需求：三只及以上）', () => {
    const groups = [
      { topic: 'A', stocks: [{ stock: '甲' }, { stock: '乙' }] },
      { topic: 'B', stocks: [{ stock: '丙' }] }
    ];
    expect(pickTopicLeaders(groups, rp({ 甲: 99, 乙: 1, 丙: 88 }), 3, () => '')).toEqual([]);
  });

  it('【红线】区间涨幅缺失的成员不参与比较，绝不当 0 选成龙头', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '最差' }, { stock: '缺值' }, { stock: '较好' }] }
    ];
    // 若「缺值(null)」被当作 0，它就会压过 -8.2 / -3.0 被选成龙头（正是要禁止的错值）。
    const out = pickTopicLeaders(groups, rp({ 最差: -8.2, 缺值: null, 较好: -3.0 }), 3, () => '');
    expect(out).toHaveLength(1);
    expect(out[0].stock).toBe('较好');
    expect(out[0].pct).toBe(-3.0);
  });

  it('一个题材内所有成员都无值 → 该题材本次无龙头（不产出空行）', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '甲' }, { stock: '乙' }, { stock: '丙' }] }
    ];
    expect(pickTopicLeaders(groups, rp({ 甲: null, 乙: null, 丙: null }), 3, () => '')).toEqual([]);
    // 区间涨幅表整体为空（Map 为空）→ 同样不评选
    expect(pickTopicLeaders(groups, new Map(), 3, () => '')).toEqual([]);
  });

  it('同幅 → 取分组顺序中先出现的（稳定，不引入随机性）', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '先' }, { stock: '后' }, { stock: '尾' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 先: 20, 后: 20, 尾: 20 }), 3, () => '');
    expect(out[0].stock).toBe('先');
  });

  it('多个题材各自选一只；行上自带的 code 优先于兜底解析函数', () => {
    const groups = [
      { topic: 'A', stocks: [{ stock: '甲', code: 'OWN' }, { stock: '乙' }, { stock: '丙' }] },
      { topic: 'B', stocks: [{ stock: '丁' }, { stock: '戊' }, { stock: '己' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 甲: 30, 乙: 10, 丙: 1, 丁: 2, 戊: 9, 己: 3 }), 3, () => 'FB');
    expect(out.map(function(r) { return r.topic + ':' + r.stock; })).toEqual(['A:甲', 'B:戊']);
    expect(out[0].code).toBe('OWN'); // 行上自带 → 不被兜底覆盖
    expect(out[1].code).toBe('FB');  // 行上缺失 → 用兜底解析
  });

  it('非法输入（undefined / 空 stocks）不抛错', () => {
    expect(pickTopicLeaders(null, rp({}), 3, () => '')).toEqual([]);
    expect(pickTopicLeaders([{ topic: 'T' }, null], rp({}), 3, () => '')).toEqual([]);
  });
});
