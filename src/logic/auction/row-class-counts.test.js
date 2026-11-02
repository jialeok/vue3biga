// src/logic/auction/row-class-counts.test.js
// [ROW-CLASS 2026-11-02 用户口径] 「四类行分账」纯函数的单测。
//
// 守的是什么（回归红线）：
//   ① 四类数字必须能相加 = 屏幕上实际行数（用户「每天90多条，肯定不对」的对账依据）；
//   ② 正式成员 + 自动补 − 折叠 也必须能对上同一批行（两把尺子量同一件事，必须同值）；
//   ③ 任何脏输入（undefined / NaN / 负数 / 字符串）都不能变成屏幕上的 `NaN 只`；
//   ④ 空态不报「不齐」（没有行就无所谓分账，⛔ 不产生假警）。
import { describe, it, expect, vi } from 'vitest';
import { buildRowClassCounts, describeRowClassMismatch } from './row-class-counts.js';

describe('row-class-counts · 四类行分账', () => {
  it('默认分块模式：四块互斥相加 = 渲染行数，且与「正式成员 + 自动补」对得上', () => {
    // 2026-11-02 实况形状：今日名单 56 行（= auction_watchlist 56 行），自动补 20 行（龙头/观察/补位壳行）
    // ⇒ 屏幕上 76 行；四块：龙头组 3 / 20日补位 5 / 观察组 12 / 常规组 56。
    const c = buildRowClassCounts({
      total: 76, formal: 56, injected: 20, hidden: 0,
      dragon: 3, range20: 5, obs: 12, regular: 56,
      split: true
    });
    expect(c.total).toBe(76);
    expect(c.blocksSum).toBe(76);
    expect(c.balanced).toBe(true);
    // 两把尺子同值：56（正式名单）+ 20（自动补）− 0（折叠）= 76（四块之和）
    expect(c.formal + c.injected - c.hidden).toBe(c.total);
  });

  it('观察组里含双身份票（正式成员同时属观察组）时仍然平衡', () => {
    // 用户口径「打 * 的票按正式成员对待」：它显示在观察组区块里，但也算正式成员
    // ⇒ 正式成员数 ≠ 常规组行数，这【不是】脏数据，对账用 blocksSum 而不是 formal。
    const c = buildRowClassCounts({
      total: 70, formal: 56, injected: 14, hidden: 0,
      dragon: 2, range20: 4, obs: 18, regular: 46,
      split: true
    });
    expect(c.balanced).toBe(true);
    // 常规组 46 + 观察组里的 10 只正式成员 = 正式成员 56（结构自查，不是相等断言的核心）
    expect(c.formal + c.injected - c.hidden).toBe(70);
    expect(c.blocksSum).toBe(70);
  });

  it('非分块模式（题材 / 十日 / 20日 / 竞昨折叠）：三块为 0，常规组那一块就是全部', () => {
    const c = buildRowClassCounts({
      total: 76, formal: 56, injected: 20, hidden: 0,
      dragon: 0, range20: 0, obs: 0, regular: 76,
      split: false
    });
    expect(c.split).toBe(false);
    expect(c.blocksSum).toBe(76);
    expect(c.balanced).toBe(true);
  });

  it('竞昨高光模式折叠掉观察组行：折叠数单独计数，不当作「不齐」', () => {
    // 折叠 8 行 ⇒ 屏幕上 68 行；正式成员 56 + 自动补 20 − 折叠 8 = 68
    const c = buildRowClassCounts({
      total: 68, formal: 56, injected: 20, hidden: 8,
      dragon: 0, range20: 0, obs: 0, regular: 68,
      split: false
    });
    expect(c.hidden).toBe(8);
    expect(c.balanced).toBe(true);
    expect(c.formal + c.injected - c.hidden).toBe(c.total);
  });

  it('有行没被分到任何区块 → balanced=false（这是「分不清 / 混进脏数据」的早期信号）', () => {
    const c = buildRowClassCounts({
      total: 76, formal: 56, injected: 20, hidden: 0,
      dragon: 3, range20: 5, obs: 12, regular: 50, // 3+5+12+50 = 70 ≠ 76
      split: true
    });
    expect(c.blocksSum).toBe(70);
    expect(c.balanced).toBe(false);
    expect(describeRowClassMismatch(c)).toContain('对不上');
    expect(describeRowClassMismatch(c)).toContain('76');
  });

  it('同一行被重复分进两个区块 → 也判不平衡（块之和大于行数）', () => {
    const c = buildRowClassCounts({
      total: 60, formal: 60, injected: 0, hidden: 0,
      dragon: 6, range20: 0, obs: 6, regular: 54, // 66 > 60
      split: true
    });
    expect(c.blocksSum).toBe(66);
    expect(c.balanced).toBe(false);
  });

  it('脏输入归一化：undefined / NaN / 负数 / 字符串 / 小数都不会漏到屏幕上', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = buildRowClassCounts({
      total: undefined,
      formal: NaN,
      injected: -3,
      hidden: '7',
      dragon: 2.9,
      range20: Infinity,
      obs: null,
      regular: 'abc'
    });
    expect(c.total).toBe(0);
    expect(c.formal).toBe(0);
    expect(c.injected).toBe(0);
    expect(c.hidden).toBe(7);   // 数字字符串可以救回来
    expect(c.dragon).toBe(2);   // 行数只能是整数 → 向下取整
    expect(c.range20).toBe(0);  // Infinity 不是行数
    expect(c.obs).toBe(0);
    expect(c.regular).toBe(0);
    expect(c.split).toBe(false); // 只认严格 true
    // 每个字段都是有限整数 —— 模板里直接插值，绝不能出现 NaN / undefined
    Object.keys(c).forEach(function(k) {
      if (k === 'split' || k === 'balanced') return;
      expect(Number.isFinite(c[k])).toBe(true);
    });
    warn.mockRestore();
  });

  it('空态（无数据）不报不平衡：没有行就无所谓分账', () => {
    const c = buildRowClassCounts();
    expect(c.total).toBe(0);
    expect(c.blocksSum).toBe(0);
    expect(c.split).toBe(false);
    expect(c.balanced).toBe(true); // ⛔ 空态不许报警（§10：没数据 ≠ 数据错）
  });

  it('describeRowClassMismatch 不抛错、可脱参调用', () => {
    expect(function() { describeRowClassMismatch(); }).not.toThrow();
    expect(describeRowClassMismatch()).toContain('[ROW-CLASS]');
  });
});
