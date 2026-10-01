import { describe, it, expect } from 'vitest';
import {
  buildTopicDayStats,
  buildTopicTrendSeries,
  TOPIC_TREND_DAYS,
  TOPIC_TREND_MIN_GROUP
} from './topic-trend.js';

describe('buildTopicDayStats 单日题材统计与名次', () => {
  it('名次按「一字数量降序」，同字数按组大小降序', () => {
    const m = buildTopicDayStats([
      { topic: '芯片', name: 'A', isYiZi: true },
      { topic: '芯片', name: 'B', isYiZi: true },
      { topic: '农业', name: 'C', isYiZi: true },
      { topic: '农业', name: 'D', isYiZi: false },
      { topic: '通信', name: 'E', isYiZi: false },
      { topic: '通信', name: 'F', isYiZi: false }
    ]);
    expect(m.get('芯片').rank).toBe(1); // 2 只一字
    expect(m.get('农业').rank).toBe(2); // 1 只一字
    expect(m.get('通信').rank).toBe(3); // 0 只一字
    expect(m.get('芯片').yiziCount).toBe(2);
    expect(m.get('通信').yiziCount).toBe(0);
  });

  it('一字数量相同时按组大小降序，仍相同按题材名升序', () => {
    const m = buildTopicDayStats([
      { topic: '算力', name: 'A' },
      { topic: '算力', name: 'B' },
      { topic: '算力', name: 'C' },
      { topic: '芯片', name: 'D' },
      { topic: '芯片', name: 'E' }
    ]);
    expect(m.get('算力').rank).toBe(1); // 3 只 > 2 只
    expect(m.get('芯片').rank).toBe(2);

    // 同大小 → 题材名升序：'芯'(U+82AF) > '算'(U+7B97) ⇒ 算力在前
    const m2 = buildTopicDayStats([
      { topic: '芯片', name: 'A' },
      { topic: '芯片', name: 'B' },
      { topic: '算力', name: 'C' },
      { topic: '算力', name: 'D' }
    ]);
    expect(m2.get('算力').rank).toBe(1);
    expect(m2.get('芯片').rank).toBe(2);
  });

  it('「其它」与不足 2 只的题材不参与名次（与统计条成组门槛同源）', () => {
    const m = buildTopicDayStats([
      { topic: '其它', name: 'A', isYiZi: true },
      { topic: '其它', name: 'B', isYiZi: true },
      { topic: '独苗', name: 'C', isYiZi: true },
      { topic: '芯片', name: 'D' },
      { topic: '芯片', name: 'E' }
    ]);
    expect(m.has('其它')).toBe(false);
    expect(m.has('独苗')).toBe(false);
    expect(m.get('芯片').rank).toBe(1);
    expect(TOPIC_TREND_MIN_GROUP).toBe(2);
  });

  it('⛔ 补竞价一字的股票不在输入里 ⇒ 天然不会被算进一字数量', () => {
    // 本函数只接收「当日早盘竞价列表自己」的 entries；补入行根本不在这里（见 topic-trend.js 文件头）
    const m = buildTopicDayStats([
      { topic: '芯片', name: 'A', isYiZi: true },
      { topic: '芯片', name: 'B', isYiZi: false }
    ]);
    expect(m.get('芯片').yiziCount).toBe(1);
  });
});

describe('buildTopicTrendSeries 五日趋势点序列', () => {
  it('按时间升序输出名次点与一字数点', () => {
    const chip1 = new Map([['芯片', { topic: '芯片', size: 3, yiziCount: 2, rank: 1 }]]);
    const chip2 = new Map([['芯片', { topic: '芯片', size: 3, yiziCount: 1, rank: 2 }]]);
    const s = buildTopicTrendSeries('芯片', [
      { date: '2026-09-15', stats: chip2 },
      { date: '2026-09-16', stats: chip1 }
    ]);
    expect(s.dates).toEqual(['2026-09-15', '2026-09-16']);
    expect(s.rankPoints.map(p => p.value)).toEqual([2, 1]);
    expect(s.yiziPoints.map(p => p.value)).toEqual([1, 2]);
    expect(s.hasRank).toBe(true);
    expect(s.hasYizi).toBe(true);
    expect(s.dayCount).toBe(2);
  });

  it('§10 某日无数据 → 该日两个点都是 null（断点），绝不补 0', () => {
    const only = new Map([['芯片', { topic: '芯片', size: 2, yiziCount: 3, rank: 1 }]]);
    const s = buildTopicTrendSeries('芯片', [
      { date: '2026-09-15', stats: null },   // 该日没拉到 / 非交易日
      { date: '2026-09-16', stats: only }
    ]);
    expect(s.rankPoints[0].value).toBeNull();
    expect(s.yiziPoints[0].value).toBeNull();
    expect(s.rankPoints[1].value).toBe(1);
    expect(s.yiziPoints[1].value).toBe(3);
  });

  it('某日该题材不存在（未成组）→ 同样画断点，不是第 0 名', () => {
    const other = new Map([['农业', { topic: '农业', size: 2, yiziCount: 1, rank: 1 }]]);
    const s = buildTopicTrendSeries('芯片', [{ date: '2026-09-16', stats: other }]);
    expect(s.rankPoints[0].value).toBeNull();
    expect(s.yiziPoints[0].value).toBeNull();
    expect(s.hasRank).toBe(false);
    expect(s.hasYizi).toBe(false);
  });

  it('一字数真的为 0 时如实输出 0（区别于「无数据」的 null）', () => {
    const m = new Map([['通信', { topic: '通信', size: 2, yiziCount: 0, rank: 2 }]]);
    const s = buildTopicTrendSeries('通信', [{ date: '2026-09-16', stats: m }]);
    expect(s.yiziPoints[0].value).toBe(0);
    expect(s.hasYizi).toBe(true); // 0 是有效数据 → 图要画
  });

  it('默认窗口 5 个交易日', () => {
    expect(TOPIC_TREND_DAYS).toBe(5);
  });
});

// [AVG-VRATIO-TREND 2026-10-01 用户追加] 「题材平均竞价量比」五日趋势
//   口径 = 组内【有量比的当日列表行】的算术平均（§10 缺值不进分母、不补 0）；
//   与统计条最上面那一行同源（同一个 Data 层读取器 getAucVolRatio）。
describe('[AVG-VRATIO-TREND 2026-10-01] 平均竞价量比', () => {
  it('按题材算出量比均值，分母只数「拿得到量比」的行', () => {
    const m = buildTopicDayStats([
      { topic: '农业', name: 'A1', volRatio: 10 },
      { topic: '农业', name: 'A2', volRatio: 20 },
      { topic: '农业', name: 'A3', volRatio: null },   // §10：缺值不进分母
      { topic: '农业', name: 'A4' }                     // 完全没有该字段，同样不进分母
    ]);
    expect(m.get('农业').size).toBe(4);              // 组大小照旧按全部行算
    expect(m.get('农业').avgVolRatio).toBe(15);      // (10 + 20) / 2，⛔ 不是 30/4
  });

  it('量比真的是 0 是有效值 —— 计入分母，不是「没数据」', () => {
    const m = buildTopicDayStats([
      { topic: '通信', name: 'B1', volRatio: 0 },
      { topic: '通信', name: 'B2', volRatio: 12 }
    ]);
    expect(m.get('通信').avgVolRatio).toBe(6);       // (0 + 12) / 2，0 照常参与
    expect(m.get('通信').avgVolRatio).not.toBeNull();
  });

  it('字符串量比照常解析（云端 auc_vol_ratio 存的是 "2.18" 这类字符串）', () => {
    const m = buildTopicDayStats([
      { topic: '芯片', name: 'C1', volRatio: '2.5' },
      { topic: '芯片', name: 'C2', volRatio: '3.5' }
    ]);
    expect(m.get('芯片').avgVolRatio).toBe(3);
  });

  it('整组一行量比都拿不到 → avgVolRatio = null（§10，UI 整行不渲染而不是 0.00）', () => {
    const m = buildTopicDayStats([
      { topic: '电力', name: 'D1', volRatio: null },
      { topic: '电力', name: 'D2', volRatio: null }
    ]);
    expect(m.get('电力').avgVolRatio).toBeNull();
    expect(m.get('电力').size).toBe(2);              // 组还在（名次/一字数量照常）
  });

  it('五日序列：ratioPoints 按时间升序，某日没有该题材 → 该点 null（断点）', () => {
    const d1 = new Map([['芯片', { topic: '芯片', size: 2, yiziCount: 1, rank: 2, avgVolRatio: 3.2 }]]);
    const d2 = new Map([['芯片', { topic: '芯片', size: 3, yiziCount: 2, rank: 1, avgVolRatio: 9.5 }]]);
    const other = new Map([['农业', { topic: '农业', size: 2, yiziCount: 1, rank: 1, avgVolRatio: 8 }]]);
    const s = buildTopicTrendSeries('芯片', [
      { date: '2026-09-24', stats: d1 },
      { date: '2026-09-25', stats: null },      // 该日没拉到数据
      { date: '2026-09-28', stats: other },     // 该日芯片未成组
      { date: '2026-09-29', stats: d2 }
    ]);
    expect(s.dates).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29']);
    expect(s.ratioPoints.map(p => p.value)).toEqual([3.2, null, null, 9.5]);
    expect(s.hasRatio).toBe(true);
  });

  it('该日题材在、但整组无量比 → 该点 null（与「题材不在」同为断点，绝不补 0）', () => {
    const noRatio = new Map([['芯片', { topic: '芯片', size: 2, yiziCount: 0, rank: 1, avgVolRatio: null }]]);
    const s = buildTopicTrendSeries('芯片', [{ date: '2026-09-29', stats: noRatio }]);
    expect(s.ratioPoints[0].value).toBeNull();
    expect(s.hasRatio).toBe(false);          // ⇒ 面板整张图不渲染
    expect(s.hasYizi).toBe(true);            // 但一字数量图照常画（0 是有效值）
  });

  it('5 天全部无量比 → hasRatio=false（面板不画这张图，也不画一条 0 的水平线）', () => {
    const only = new Map([['芯片', { topic: '芯片', size: 2, yiziCount: 2, rank: 1, avgVolRatio: null }]]);
    const s = buildTopicTrendSeries('芯片', [
      { date: '2026-09-25', stats: only },
      { date: '2026-09-28', stats: only }
    ]);
    expect(s.hasRatio).toBe(false);
    expect(s.ratioPoints.every(p => p.value === null)).toBe(true);
  });
});
