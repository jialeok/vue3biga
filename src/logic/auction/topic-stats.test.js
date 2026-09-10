import { describe, it, expect } from 'vitest';
import {
  buildTopicStatsMap,
  formatTopicStatsLayout,
  topicStatsSignature,
  TOPIC_STATS_MIN_GROUP
} from './topic-stats.js';

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
    const lay = formatTopicStatsLayout(s);
    expect(lay.row2.some(x => x.key === 'leader')).toBe(true);
    expect(lay.row2.some(x => x.key === 'lrng')).toBe(false); // 不伪造十日涨幅（§10）
  });

  it('[2026-09-10] 只有一只股票的题材不产出统计条（避免列表变乱）', () => {
    const entries = [
      { topic: '农业', name: '独苗', isYiZi: true, aucPct: 5, rangePct: 20 },
      { topic: '人工智能', name: 'A', aucPct: 1, rangePct: 3 },
      { topic: '人工智能', name: 'B', aucPct: 2, rangePct: 9 }
    ];
    const m = buildTopicStatsMap(entries);
    expect(m.has('农业')).toBe(false); // 单只 → 过滤掉
    expect(m.has('人工智能')).toBe(true); // 两只 → 保留
    expect(TOPIC_STATS_MIN_GROUP).toBe(2);
  });

  it('[2026-09-10] 「其它」默认不统计（与 buildTopicColorMap 配色口径一致）', () => {
    const entries = [
      { topic: '', name: 'A', aucPct: 1, rangePct: 1 },
      { topic: '其它', name: 'B', aucPct: 1, rangePct: 2 }
    ];
    expect(buildTopicStatsMap(entries).size).toBe(0);
    expect(buildTopicStatsMap(entries, { includeOther: true }).has('其它')).toBe(true);
  });

  it('minGroupSize 可调（默认 2）', () => {
    const entries = [
      { topic: 'T', name: 'A', aucPct: 1, rangePct: 1 },
      { topic: 'T', name: 'B', aucPct: 1, rangePct: 1 },
      { topic: 'T', name: 'C', aucPct: 1, rangePct: 1 }
    ];
    expect(buildTopicStatsMap(entries, { minGroupSize: 3 }).has('T')).toBe(true);
    expect(buildTopicStatsMap(entries, { minGroupSize: 4 }).has('T')).toBe(false);
  });

  it('空输入返回空 Map，不抛错', () => {
    expect(buildTopicStatsMap(null).size).toBe(0);
    expect(buildTopicStatsMap([]).size).toBe(0);
  });
});

describe('formatTopicStatsLayout 两格两行布局', () => {
  it('第一行 数量/一字/竞价高开；第二行 龙头/竞价/十日（红色加粗 strong）', () => {
    const lay = formatTopicStatsLayout({
      topic: '农业', count: 12, yiziCount: 2, highOpenCount: 8,
      leader: '万向德农', leaderAucPct: 2, leaderRangePct: 102
    });
    expect(lay.topic).toBe('农业');
    expect(lay.row1.map(x => x.key)).toEqual(['count', 'yizi', 'high']);
    expect(lay.row2.map(x => x.key)).toEqual(['leader', 'lpct', 'lrng']);
    expect(lay.row1.find(x => x.key === 'high').value).toBe('8');
    // [2026-09-10] 第二行（龙头行）三个数值统一红色加粗（strong=true），不再按涨跌分 tone
    expect(lay.row2.find(x => x.key === 'leader').value).toBe('万向德农');
    expect(lay.row2.find(x => x.key === 'leader').strong).toBe(true);
    // 竞价数值只保留 1 位小数
    expect(lay.row2.find(x => x.key === 'lpct').value).toBe('+2.0%');
    expect(lay.row2.find(x => x.key === 'lpct').strong).toBe(true);
    expect(lay.row2.find(x => x.key === 'lpct').tone).toBeUndefined();
    // 十日涨幅取整数（四舍五入）
    expect(lay.row2.find(x => x.key === 'lrng').value).toBe('+102%');
    expect(lay.row2.find(x => x.key === 'lrng').strong).toBe(true);
  });

  it('[2026-09-10] 竞价 1 位小数四舍五入；十日取整四舍五入', () => {
    const lay = formatTopicStatsLayout({
      topic: 'T', count: 2, yiziCount: 0, highOpenCount: 0,
      // 注：不用 -3.55 这类「二进制无法精确表示」的边界值（实际是 -3.5499... → toFixed 得 -3.5）
      leader: 'X', leaderAucPct: -3.56, leaderRangePct: 46.81
    });
    expect(lay.row2.find(x => x.key === 'lpct').value).toBe('-3.6%');
    expect(lay.row2.find(x => x.key === 'lrng').value).toBe('+47%');
  });

  it('无龙头时第二行为空数组（组件塌陷为单行）', () => {
    const lay = formatTopicStatsLayout({
      topic: 'T', count: 2, yiziCount: 0, highOpenCount: 1,
      leader: '', leaderAucPct: null, leaderRangePct: null
    });
    expect(lay.row1.length).toBe(3);
    expect(lay.row2).toEqual([]);
  });

  it('stats 为 null → null（父级 v-if 直接不渲染）', () => {
    expect(formatTopicStatsLayout(null)).toBeNull();
  });

  it('[2026-09-10] 下跌的龙头行同样统一红色加粗（strong，无 tone）', () => {
    const lay = formatTopicStatsLayout({
      topic: 'T', count: 2, yiziCount: 0, highOpenCount: 0,
      leader: 'X', leaderAucPct: -3.5, leaderRangePct: -8
    });
    expect(lay.row2.find(x => x.key === 'lpct').value).toBe('-3.5%');
    expect(lay.row2.find(x => x.key === 'lpct').strong).toBe(true);
    expect(lay.row2.find(x => x.key === 'lpct').tone).toBeUndefined();
    expect(lay.row2.find(x => x.key === 'lrng').value).toBe('-8%');
    expect(lay.row2.find(x => x.key === 'lrng').strong).toBe(true);
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
