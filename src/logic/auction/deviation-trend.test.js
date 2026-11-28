// deviation-trend.test.js — 「官方偏离值 5 日趋势」的回归锁
//
// 锁用户 2026-11-28 的四条口径：
//   ① 只画【最后 5 个交易日】（以指数腿为交易日历）；
//   ② 上面竞价口径 / 下面收盘口径：某天竞价涨幅缺 ⇒ 那个点判不出（⛔ 不当 0）；
//   ③ 窗口跟着徽标走：徽标 10 日 ⇒ 10 日偏离，徽标 30 日 ⇒ 30 日偏离；
//   ④ 颜色档：逼近（≥90% 红线）橙 / 触发（≥100%）红。
import { describe, it, expect } from 'vitest';
import { buildDeviationTrend, DEV_TREND_DAYS } from './deviation-trend.js';
import { computeDeviation, deviationBadgeWindow } from './abnormal-deviation.js';

/** 造一段逐日腿：start 起连续 n 个工作日（这里直接按 2026-09-01 起顺延，不走日历） */
function makeLegs(startDay, n, dailyPct) {
  const out = [];
  const t0 = Date.parse(startDay + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, pct: dailyPct });
  }
  return out;
}

const idxLegs = function (n) { return makeLegs('2026-09-01', n, 0); };

describe('[DEV-TREND] buildDeviationTrend · 五日双口径', () => {
  it('只取最后 5 个交易日，窗口天数跟着徽标走', () => {
    const legs = makeLegs('2026-09-01', 40, 1);
    const idx = idxLegs(40);
    const asOf = idx[idx.length - 1].date;

    const t10 = buildDeviationTrend({
      name: '测试票', code: '002242', closeLegs: legs, indexLegs: idx,
      windowDays: 10, asOf: asOf
    });
    const t30 = buildDeviationTrend({
      name: '测试票', code: '002242', closeLegs: legs, indexLegs: idx,
      windowDays: 30, asOf: asOf
    });

    expect(t10.dates.length).toBe(DEV_TREND_DAYS);
    expect(t10.close.length).toBe(DEV_TREND_DAYS);
    expect(t10.thr).toBe(100);          // 10 日红线 +100%
    expect(t30.thr).toBe(200);          // 30 日红线 +200%
  });

  it('竞价涨幅缺失 ⇒ 那个点判不出（⛔ 不拿 0 冒充）', () => {
    const legs = makeLegs('2026-09-01', 20, 1);
    const idx = idxLegs(20);
    const asOf = idx[idx.length - 1].date;

    const noAuc = buildDeviationTrend({
      name: '测试票', code: '002242', closeLegs: legs, indexLegs: idx,
      windowDays: 10, asOf: asOf
    });
    noAuc.auction.forEach(function (p) {
      expect(p.ok).toBe(false);
      expect(p.dev).toBe(null);
      expect(p.tone).toBe('muted');
    });

    const oneAuc = buildDeviationTrend({
      name: '测试票', code: '002242', closeLegs: legs, indexLegs: idx,
      windowDays: 10, asOf: asOf, aucByDate: new Map([[asOf, 3]])
    });
    expect(oneAuc.auction[oneAuc.auction.length - 1].ok).toBe(true);
  });

  it('色阶：触发（≥100% 红线）severe / 逼近（≥90%）near / 平常 ok', () => {
    const cases = [
      { daily: 7.2, tone: 'severe' },   // 1.072^10 - 1 ≈ +100.4%
      { daily: 6.7, tone: 'near' },     // 1.067^10 - 1 ≈ +91.3%
      { daily: 1, tone: 'ok' }
    ];
    cases.forEach(function (c) {
      const legs = makeLegs('2026-09-01', 20, c.daily);
      const idx = idxLegs(20);
      const asOf = idx[idx.length - 1].date;
      const t = buildDeviationTrend({
        name: '测试票', code: '002242', closeLegs: legs, indexLegs: idx,
        windowDays: 10, asOf: asOf
      });
      const last = t.close[t.close.length - 1];
      expect(last.ok).toBe(true);
      expect(last.tone).toBe(c.tone);
    });
  });

  it('缺代码 / 缺指数腿 ⇒ 如实返回 note，⛔ 不造一条 0 线', () => {
    const legs = makeLegs('2026-09-01', 12, 1);
    const a = buildDeviationTrend({ name: '', code: '002242', closeLegs: legs, indexLegs: idxLegs(12) });
    expect(a.hasAny).toBe(false);
    expect(a.note).not.toBe('');
    const b = buildDeviationTrend({ name: '测试票', code: '002242', closeLegs: legs, indexLegs: [] });
    expect(b.hasAny).toBe(false);
    expect(b.note).not.toBe('');
  });
});

describe('[DEV-TREND] deviationBadgeWindow · 趋势窗口必须复用徽标的同一选择器', () => {
  it('30 日偏离占比更高 ⇒ 徽标说 30 日，趋势图也画 30 日', () => {
    // 30 天每天 +3% ⇒ 30 日偏离 ≈ +143%（0.71），10 日 ≈ +34%（0.34）⇒ 徽标取 30 日
    const legs = makeLegs('2026-09-01', 40, 3);
    const idx = idxLegs(40);
    const asOf = idx[idx.length - 1].date;
    const f = computeDeviation({
      code: '002242', name: '测试票', stockLegs: legs, indexLegs: idx, asOf: asOf
    });
    expect(f.ok).toBe(true);
    expect(deviationBadgeWindow(f)).toBe(30);
  });

  it('判不出的票 ⇒ 窗口为 null（⛔ 不许默认 10 日硬画）', () => {
    expect(deviationBadgeWindow({ ok: false })).toBe(null);
    expect(deviationBadgeWindow(null)).toBe(null);
  });
});
