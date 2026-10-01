// vol-ratio-trend.test.js — 决策看板「竞价量比 近 5 日」展示视图的回归用例
//
// 钉住三件事（后期改口径时先看这里）：
//   ① §10 红线：缺数据 → value=null / text=''，⛔ 绝不用 0 冒充「量比很小」；
//   ② 徽标只认【展示日（序列最后一天）】的值 —— 历史有、今天没有 ⇒ 一样不显示徽标；
//   ③ 只要序列里有任一有效点 ⇒ hasData=true（模板画曲线）；全为空 ⇒ false（模板画「暂无数据」）。

import { describe, it, expect } from 'vitest';
import { buildVolRatioView, VOL_RATIO_TREND_DAYS } from './vol-ratio-trend.js';

const D = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];

describe('buildVolRatioView', () => {
  it('窗口常量固定为 5 个交易日（与早盘竞价趋势图一致）', () => {
    expect(VOL_RATIO_TREND_DAYS).toBe(5);
  });

  it('正常序列：解析成数字、徽标取展示日（最后一天）、两位小数', () => {
    const v = buildVolRatioView([
      { date: D[0], value: '1.20' },
      { date: D[1], value: '0.85' },
      { date: D[2], value: '3.00' },
      { date: D[3], value: '4.5' },
      { date: D[4], value: '2.18' }
    ]);
    expect(v.points.map(p => p.value)).toEqual([1.2, 0.85, 3, 4.5, 2.18]);
    expect(v.points[4].date).toBe('2026-09-25');
    expect(v.hasData).toBe(true);
    expect(v.text).toBe('量比 2.18');
  });

  it('§10：展示日缺值 → 空串徽标（⛔ 不补 0.00），但历史点照常画', () => {
    const v = buildVolRatioView([
      { date: D[0], value: '1.20' },
      { date: D[1], value: null },
      { date: D[2], value: '' },
      { date: D[3], value: '-' },
      { date: D[4], value: null }
    ]);
    expect(v.points.map(p => p.value)).toEqual([1.2, null, null, null, null]);
    expect(v.hasData).toBe(true);   // 有历史点 → 仍画曲线
    expect(v.text).toBe('');        // 展示日没值 → 不渲染徽标
  });

  it('整条序列全空 → hasData=false 且 text 为空串（模板改画「暂无数据」）', () => {
    const v = buildVolRatioView(D.map(d => ({ date: d, value: null })));
    expect(v.hasData).toBe(false);
    expect(v.text).toBe('');
    expect(v.points.length).toBe(5);
  });

  it('空/异常输入不抛错（§10 读取失败 ≠ 空数据，由调用方如实呈现）', () => {
    expect(buildVolRatioView(null).points).toEqual([]);
    expect(buildVolRatioView(undefined).hasData).toBe(false);
    expect(buildVolRatioView([]).text).toBe('');
  });

  it('0 是有效值（量比 0 与「没有数据」必须区分开）', () => {
    const v = buildVolRatioView([
      { date: D[0], value: '0' },
      { date: D[1], value: '0.00' }
    ]);
    expect(v.points.map(p => p.value)).toEqual([0, 0]);
    expect(v.hasData).toBe(true);
    expect(v.text).toBe('量比 0.00');
  });

  it('非数字串（如「--」「N/A」）按缺值处理，不产生 NaN', () => {
    const v = buildVolRatioView([
      { date: D[0], value: '--' },
      { date: D[1], value: 'N/A' },
      { date: D[2], value: '2.5' }
    ]);
    expect(v.points.map(p => p.value)).toEqual([null, null, 2.5]);
    expect(v.text).toBe('量比 2.50');
  });
});
