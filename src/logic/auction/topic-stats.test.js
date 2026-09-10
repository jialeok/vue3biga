import { describe, it, expect } from 'vitest';
import { buildTopicStatsMap, formatTopicStatsSegments, topicStatsSignature } from './topic-stats.js';

describe('buildTopicStatsMap 题材分组统计', () => {
  it('统计数量 / 一字 / 竞价高开（>=0 才算高开）', () => {
    const entries = [
      { topic: '农业', name: 'A', isYiZi: true, aucPct: 2.1, rangePct: 102 },
      { topic: '农业', name: 'B', isYiZi: true, aucPct: 0, rangePct: 30 },
      { topic: '农业', name: 'C', isYiZi: false, aucPct: -1.2, rangePct: 5 },
      { topic: '农业', name: 'D', isYiZi: false, aucPct: null, rangePct: null }
    ];
    const m = buildTopicStatsMap(entries);
    const s = m.get('农业');
    expect(s.count).toBe(4);
    expect(s.yiziCount).toBe(2);
    expect(s.highOpenCount).toBe(2); // 2.1 与 0 计入；-1.2 与 null 不计入
    expect(s.leader).toBe('A'); // 区间涨幅最高
    expect(s.leaderAucPct).toBe(2.1);
    expect(s.leaderRangePct).toBe(102);
  });

  it('龙头 = 组内区间涨幅最高者；与排列顺序无关', () => {
    const entries = [
      { topic: 'T', name: '甲', isYiZi: false, aucPct: 9, rangePct: 10 },
      { topic: 'T', name: '乙', isYiZi: false, aucPct: 1, rangePct: 88 },
      { topic: 'T', name: '丙', isYiZi: false, aucPct: 3, rangePct: 44 }
    ];
    const s = buildTopicStatsMap(entries).get('T');
    expect(s.leader).toBe('乙');
    expect(s.leaderRangePct).toBe(88);
    expect(s.leaderAucPct).toBe(1); // 跟的是龙头自己的竞价涨幅
  });

  it('组内全无区间涨幅（新票/次新股）→ 退化为竞价涨幅最高者，十日段留空', () => {
    const entries = [
      { topic: 'T', name: '新票', isYiZi: false, aucPct: 3.5, rangePct: null },
      { topic: 'T', name: '另一只', isYiZi: false, aucPct: -2, rangePct: null }
    ];
    const s = buildTopicStatsMap(entries).get('T');
    expect(s.leader).toBe('新票');
    expect(s.leaderRangePct).toBeNull();
    const seg = formatTopicStatsSegments(s);
    expect(seg.some(x => x.key === 'leader')).toBe(true);
    expect(seg.some(x => x.key === 'lrng')).toBe(false); // 不伪造十日涨幅（§10）
  });

  it('题材为空 / 缺省 → 归入「其它」，可通过 includeOther 关闭', () => {
    const entries = [
      { topic: '', name: 'A', aucPct: 1, rangePct: 1 },
      { topic: '其它', name: 'B', aucPct: 1, rangePct: 2 }
    ];
    expect(buildTopicStatsMap(entries).has('其它')).toBe(true);
    expect(buildTopicStatsMap(entries, { includeOther: false }).size).toBe(0);
  });

  it('空输入返回空 Map，不抛错', () => {
    expect(buildTopicStatsMap(null).size).toBe(0);
    expect(buildTopicStatsMap([]).size).toBe(0);
  });
});

describe('formatTopicStatsSegments 输出片段', () => {
  it('缺失段不产出；涨红跌绿 tone 正确', () => {
    const seg = formatTopicStatsSegments({
      topic: '农业', count: 12, yiziCount: 2, highOpenCount: 8,
      leader: '万向德农', leaderAucPct: 2, leaderRangePct: 102
    });
    expect(seg.map(x => x.key)).toEqual(['topic', 'count', 'yizi', 'high', 'leader', 'lpct', 'lrng']);
    expect(seg.find(x => x.key === 'lpct').value).toBe('+2.00%');
    expect(seg.find(x => x.key === 'lpct').tone).toBe('up');
    expect(seg.find(x => x.key === 'lrng').value).toBe('+102.00%');
  });

  it('stats 为 null → 空数组', () => {
    expect(formatTopicStatsSegments(null)).toEqual([]);
  });

  it('tone 下跌为 down', () => {
    const seg = formatTopicStatsSegments({
      topic: 'T', count: 1, yiziCount: 0, highOpenCount: 0,
      leader: 'X', leaderAucPct: -3.5, leaderRangePct: -8
    });
    expect(seg.find(x => x.key === 'lpct').tone).toBe('down');
    expect(seg.find(x => x.key === 'lpct').value).toBe('-3.50%');
  });
});

describe('topicStatsSignature 增量渲染签名', () => {
  it('内容相同 → 签名相同；任一字段变化 → 签名不同', () => {
    const base = { topic: 'T', count: 3, yiziCount: 1, highOpenCount: 2, leader: 'A', leaderAucPct: 1, leaderRangePct: 5 };
    expect(topicStatsSignature(base)).toBe(topicStatsSignature({ ...base }));
    expect(topicStatsSignature(base)).not.toBe(topicStatsSignature({ ...base, yiziCount: 2 }));
    expect(topicStatsSignature(base)).not.toBe(topicStatsSignature({ ...base, leader: 'B' }));
    expect(topicStatsSignature(null)).toBe('');
  });
});
