import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBuyQuiesce, buildBuySelectionSig, BUY_QUIET_MS } from './buy-quiesce.js';

// ★★ [BUY-SETTLE-2 2026-10-31] 买点侧「结果确认」第三版：结果侧稳定期判据。
//
// 这几条用例守的是【用户第三次报障】里最容易回退的三件事：
//   ① 票变了 ⇒ 指纹必须变（否则放行后还会换票 = 用户看到的「一只 → 两只 → 一只」）；
//   ② 指纹没变 ⇒ 计时器不能被重置（分笔 / 量比箭头每秒钟在抖，重置一次就永远不放行）；
//   ③ 显示之后又被推翻 ⇒ 必须立刻变成「不稳定」（挂回占位，⛔ 不让屏幕停在作废的票上）。

const eachRowFrom = (rows) => (buy, sell, fn) => {
  (rows || []).forEach(fn);
};

describe('buildBuySelectionSig · 指纹只认「用户能看见的选股结论」', () => {
  it('同一批票（数值抖动）⇒ 指纹不变', () => {
    const a = buildBuySelectionSig({ buy: {}, pickCount: 1, excludedTopics: [] }, eachRowFrom([{ name: '上海九百', pct: 12.3 }]));
    const b = buildBuySelectionSig({ buy: {}, pickCount: 1, excludedTopics: [] }, eachRowFrom([{ name: '上海九百', pct: 99.9 }]));
    expect(a).toBe(b);
  });

  it('把一只票换掉 ⇒ 指纹必须变', () => {
    const a = buildBuySelectionSig({ buy: {}, pickCount: 2 }, eachRowFrom([{ name: '上海九百' }, { name: '文投控股' }]));
    const b = buildBuySelectionSig({ buy: {}, pickCount: 2 }, eachRowFrom([{ name: '上海九百' }]));
    expect(a).not.toBe(b);
  });

  it('档位（今天买几只）变 ⇒ 指纹变', () => {
    const rows = [{ name: '上海九百' }];
    const a = buildBuySelectionSig({ buy: {}, pickCount: 1 }, eachRowFrom(rows));
    const b = buildBuySelectionSig({ buy: {}, pickCount: 2 }, eachRowFrom(rows));
    expect(a).not.toBe(b);
  });

  it('六个「灰化容器之外」的独立买点块：出现 / 消失 / 换票都要变', () => {
    const none = buildBuySelectionSig({ buy: {}, pickCount: 1 }, eachRowFrom([]));
    const withEbb = buildBuySelectionSig({ buy: {}, pickCount: 1, ebbBuy: { picks: [{ name: '甲' }] } }, eachRowFrom([]));
    const withEbb2 = buildBuySelectionSig({ buy: {}, pickCount: 1, ebbBuy: { picks: [{ name: '乙' }] } }, eachRowFrom([]));
    const withWeak = buildBuySelectionSig({ buy: {}, pickCount: 1, weakHuddle: { picks: [{ name: '甲' }] } }, eachRowFrom([]));
    expect(none).not.toBe(withEbb);
    expect(withEbb).not.toBe(withEbb2);
    expect(withEbb).not.toBe(withWeak);
  });

  it('灰化题材整段增减 ⇒ 指纹变（票名可能没变，但屏幕明显变了）', () => {
    const a = buildBuySelectionSig({ buy: {}, pickCount: 1, excludedTopics: ['农业'] }, eachRowFrom([]));
    const b = buildBuySelectionSig({ buy: {}, pickCount: 1, excludedTopics: [] }, eachRowFrom([]));
    expect(a).not.toBe(b);
  });

  it('没有计划 ⇒ 空串（= 还没有买点结论，门控不据此放行）', () => {
    expect(buildBuySelectionSig(null, eachRowFrom([]))).toBe('');
  });
});

describe('createBuyQuiesce · 稳定期状态机', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('指纹保持不变满 quietMs 才放行', () => {
    const q = createBuyQuiesce({ quietMs: 1500 });
    q.note('sig-A');
    expect(q.isStable('sig-A')).toBe(false);
    vi.advanceTimersByTime(1499);
    expect(q.isStable('sig-A')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(q.isStable('sig-A')).toBe(true);
    q.dispose();
  });

  it('同一指纹被重复通知（高频重算）⇒ 不重置计时器', () => {
    const q = createBuyQuiesce({ quietMs: 1000 });
    q.note('sig-A');
    // 模拟分笔 / 量比每秒到货导致 data 重算 5 次，但选股结论没变
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(200);
      q.note('sig-A');
    }
    expect(q.isStable('sig-A')).toBe(true);
    q.dispose();
  });

  it('稳定期内指纹变了 ⇒ 重新计时，且立刻不再 stable（旧票已作废）', () => {
    const q = createBuyQuiesce({ quietMs: 1000 });
    q.note('sig-A');
    vi.advanceTimersByTime(900);
    q.note('sig-B');
    expect(q.isStable('sig-A')).toBe(false);
    vi.advanceTimersByTime(900);
    expect(q.isStable('sig-B')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(q.isStable('sig-B')).toBe(true);
    q.dispose();
  });

  it('放行之后又被推翻 ⇒ 再次变回不稳定（挂回占位）', () => {
    const q = createBuyQuiesce({ quietMs: 1000 });
    q.note('sig-A');
    vi.advanceTimersByTime(1000);
    expect(q.isStable('sig-A')).toBe(true);
    q.note('sig-C');                       // 上游迟到的一项把结论推翻了
    expect(q.isStable('sig-A')).toBe(false);
    expect(q.locked.value).toBe('');
    vi.advanceTimersByTime(1000);
    expect(q.isStable('sig-C')).toBe(true);
    q.dispose();
  });

  it('空指纹（未就绪 / 切日期）⇒ 不放行也不起计时器', () => {
    const q = createBuyQuiesce({ quietMs: 1000 });
    q.note('');
    vi.advanceTimersByTime(5000);
    expect(q.isStable('')).toBe(false);
    // 之后真有了结论，照常跑稳定期
    q.note('sig-A');
    vi.advanceTimersByTime(1000);
    expect(q.isStable('sig-A')).toBe(true);
    q.dispose();
  });

  it('dispose 后定时器不再生效（看板关掉不该还在跑）', () => {
    const q = createBuyQuiesce({ quietMs: 1000 });
    q.note('sig-A');
    q.dispose();
    vi.advanceTimersByTime(3000);
    expect(q.isStable('sig-A')).toBe(false);
  });

  it('默认稳定期 = BUY_QUIET_MS（别被随手改小成 0）', () => {
    expect(BUY_QUIET_MS).toBeGreaterThanOrEqual(1000);
    const q = createBuyQuiesce();
    q.note('sig-A');
    vi.advanceTimersByTime(BUY_QUIET_MS - 1);
    expect(q.isStable('sig-A')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(q.isStable('sig-A')).toBe(true);
    q.dispose();
  });
});
