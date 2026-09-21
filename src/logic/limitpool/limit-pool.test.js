// limit-pool.test.js — 「涨跌停」看板 Logic 层的单测
//
// 只测【纯函数】部分（planPoolInheritance）。异步编排（_load）依赖 Data 层与网络，
// 不在这里做集成测试 —— 它的正确性由「继承结果绝不写回 limit_pool」这条结构性约束保证。
import { describe, it, expect } from 'vitest';
import { planPoolInheritance } from './limit-pool.js';

describe('planPoolInheritance 次日继承（★ 只继承一天，绝不链式）', () => {
  it('当天没抓到 → 继承最近一个交易日', () => {
    const r = planPoolInheritance('2026-09-21', '2026-09-21', '2026-09-18');
    expect(r.inherit).toBe(true);
    expect(r.from).toBe('2026-09-18');
  });

  it('过去的日期同样可以继承（上游那天确实没抓到时）', () => {
    const r = planPoolInheritance('2026-09-15', '2026-09-21', '2026-09-14');
    expect(r.inherit).toBe(true);
    expect(r.from).toBe('2026-09-14');
  });

  it('⛔ 将来的日期不继承 —— 「明天」不能显示今天的池子', () => {
    const r = planPoolInheritance('2026-09-22', '2026-09-21', '2026-09-21');
    expect(r.inherit).toBe(false);
    expect(r.from).toBe('');
    expect(r.reason).toBe('future');
  });

  it('没有前一个交易日（日历边界）→ 不继承', () => {
    const r = planPoolInheritance('2026-09-21', '2026-09-21', null);
    expect(r.inherit).toBe(false);
    expect(r.reason).toBe('no-prev-trading-day');
  });

  it('缺日期 → 不继承', () => {
    const r = planPoolInheritance('', '2026-09-21', '2026-09-18');
    expect(r.inherit).toBe(false);
    expect(r.reason).toBe('no-date');
  });

  it('★ 只回退一跳：本函数永远只接受「一个」源日期，拿不到就返回 false', () => {
    // 链式污染的根因是「继承结果被写回库」；本函数签名里根本没有上一跳的概念，
    // 因此调用方物理上无法构造出 D+2 ← D 的路径（配合「继承不落库」即可彻底杜绝）。
    const r = planPoolInheritance('2026-09-22', '2026-09-22', '2026-09-21');
    expect(r.from).toBe('2026-09-21'); // 只会是 D+1 的紧邻前一日，绝不会跳到 2026-09-18
    expect(r.from).not.toBe('2026-09-18');
  });
});
