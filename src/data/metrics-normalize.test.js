// src/data/metrics-normalize.test.js
// [AUC-VOL-GUARD 2026-11-04] 竞价量归一（假 0 ⇒ 缺失）的单测。
//
// 守的是什么（回归红线）：
//   ① 竞价量 0 而量比 > 0（或占昨量 % > 0）= 物理矛盾（量比 = 竞价量 ÷ 基准量，分子为 0 则必为 0）
//      ⇒ 上游未就绪 ⇒ 必须归一成 null（视图显示 '-'/断点），⛔ 绝不显示 0（§10）。
//   ② 真·0（量比、占昨量都没有或都是 0）必须原样保留 —— ⛔ 不是「把 0 一律抹掉」。
//   ③ 非 0 值一律不被改动（含字符串形态、小数）。
import { describe, it, expect } from 'vitest';
import { normalizeAucVolume, isFakeZeroVolume } from './metrics-normalize.js';

describe('metrics-normalize · 竞价量假 0 归一', () => {
  it('① 0 + 量比>0 ⇒ null（2026-11-04 实测：25/47 只是这种假 0）', () => {
    expect(normalizeAucVolume('0', '15.29')).toBe(null);   // 七匹狼
    expect(normalizeAucVolume('0', '144.88')).toBe(null);  // 浙文影业
    expect(normalizeAucVolume(0, 5.43)).toBe(null);
  });

  it('① b 0 + 占昨量%>0 但量比缺失 ⇒ 同样判假 0', () => {
    expect(normalizeAucVolume('0', null, '12.5')).toBe(null);
    expect(normalizeAucVolume('0', '', '0.01')).toBe(null);
  });

  it('② 真·0（量比与占昨量都没有 / 都是 0）⇒ 原样保留，不许抹成缺失', () => {
    expect(normalizeAucVolume('0', '0')).toBe('0');
    expect(normalizeAucVolume('0', '', '')).toBe('0');
    expect(normalizeAucVolume('0', null, null)).toBe('0');
    expect(normalizeAucVolume(0, 0, 0)).toBe(0);
  });

  it('③ 非 0 值不被改动（字符串/小数都原样返回）', () => {
    expect(normalizeAucVolume('3442', '26.78')).toBe('3442');
    expect(normalizeAucVolume('0.3', '1.2')).toBe('0.3');
    expect(normalizeAucVolume(18, null)).toBe(18);
  });

  it('④ 空值原样返回（是否落库由调用方决定，⛔ 不在这里造 0）', () => {
    expect(normalizeAucVolume('', '5')).toBe('');
    expect(normalizeAucVolume(null, '5')).toBe(null);
    expect(normalizeAucVolume(undefined, '5')).toBe(undefined);
  });

  it('⑤ 脏输入不炸（非数字字符串 / 布尔）', () => {
    expect(normalizeAucVolume('abc', '5')).toBe('abc');
    expect(isFakeZeroVolume('abc', '5')).toBe(false);
    expect(isFakeZeroVolume('0', '5')).toBe(true);
    expect(isFakeZeroVolume('0', '0')).toBe(false);
  });
});
