import { describe, it, expect } from 'vitest';
import {
  RANGE30_WINDOW_DAYS,
  RANGE30_MIN_LEGS,
  windowFromTradingDays,
  range30InWindow
} from './range30-math.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// `range30-math.js` 是「30日涨幅」的**唯一算式**（前端 range30.js / 云端 compute-range30-pct.mjs
// 都 import 它）。这里锁死两件事：
//   ① 窗口口径 = 含 asOf 往前 30 个交易日，baseDate = 窗口首日的前一个交易日；
//   ② 比值口径 = 期末收盘 / 期初前收盘 − 1，判不出时返回 null（⛔ 绝不补 0）。
// ⚠️ 本文件的日历全是**手写**的（不依赖任何数据源），所以断言可以写死日期。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 造一段连续交易日（跳过周末），返回升序 YYYY-MM-DD */
function tradingDaysOf(endYmd, n) {
  const out = [];
  const d = new Date(endYmd + 'T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

describe('windowFromTradingDays 窗口构造（日历为入参）', () => {
  const cal = tradingDaysOf('2026-10-28', 40);   // 40 个交易日，末日 10-28

  it('取最后 30 个交易日，baseDate = 窗口首日的前一个交易日', () => {
    const w = windowFromTradingDays(cal, '2026-10-28', 30);
    expect(w).not.toBeNull();
    expect(w.dates.length).toBe(RANGE30_WINDOW_DAYS);
    expect(w.end).toBe('2026-10-28');
    // 窗口首日在整段日历里的前一个元素就是 baseDate
    const idx = cal.indexOf(w.start);
    expect(idx).toBeGreaterThan(0);
    expect(w.baseDate).toBe(cal[idx - 1]);
    expect(w.baseDate < w.start).toBe(true);
  });

  it('asOf 不是交易日 ⇒ end 退到 ≤ asOf 的最后一个交易日（周末/节假日等价）', () => {
    const w = windowFromTradingDays(cal, '2026-10-31', 30);   // 周六
    expect(w.end).toBe('2026-10-28');
    expect(w.dates.length).toBe(RANGE30_WINDOW_DAYS);
  });

  it('日历不够 30 天 ⇒ null（⛔ 不拿半截窗口硬算）', () => {
    expect(windowFromTradingDays(cal.slice(-10), '2026-10-28', 30)).toBeNull();
    expect(windowFromTradingDays([], '2026-10-28', 30)).toBeNull();
  });

  it('asOf 早于整段日历 ⇒ null', () => {
    expect(windowFromTradingDays(cal, '2020-01-01', 30)).toBeNull();
  });

  it('非法日期 ⇒ null（⛔ 不猜一个默认窗口）', () => {
    expect(windowFromTradingDays(cal, '2026/10/28', 30)).toBeNull();
    expect(windowFromTradingDays(cal, '', 30)).toBeNull();
  });
});

describe('range30InWindow 一次性比值', () => {
  const cal = tradingDaysOf('2026-10-28', 40);
  const win = windowFromTradingDays(cal, '2026-10-28', 30);

  /** 新华传媒 600825 的真值：期初前收盘 5.31 → 期末 14.81 = +178.91% */
  function realBars() {
    const bars = [{ ymd: win.baseDate, close: 5.31 }];
    for (let i = 0; i < 12; i++) bars.push({ ymd: win.dates[i], close: 5.31 + i * 0.1 });
    bars.push({ ymd: win.end, close: 14.81 });
    return bars;
  }

  it('期末收盘 / 期初前收盘 − 1 ⇒ +178.91%', () => {
    const got = range30InWindow(realBars(), win);
    expect(got).not.toBeNull();
    expect(got.pct).toBeCloseTo(178.91, 2);
    expect(got.days).toBeGreaterThanOrEqual(RANGE30_MIN_LEGS);
    expect(got.baseDate).toBe(win.baseDate);
    expect(got.endDate).toBe(win.end);
  });

  it('窗口还没构造出来（baseDate 缺失）⇒ null', () => {
    expect(range30InWindow(realBars(), Object.assign({}, win, { baseDate: '' }))).toBeNull();
    expect(range30InWindow(realBars(), null)).toBeNull();
  });

  it('次新股（K 线从窗口中间才上市）⇒ null，⛔ 不拿上市首日当基准', () => {
    const bars = [
      { ymd: win.dates[4], close: 8 },
      { ymd: win.end, close: 14.81 }
    ];
    expect(range30InWindow(bars, win)).toBeNull();
  });

  it('窗口内成交腿数不足门槛 ⇒ null（默认 ' + RANGE30_MIN_LEGS + ' 根）', () => {
    const bars = [
      { ymd: win.baseDate, close: 5.31 },
      { ymd: win.end, close: 14.81 }
    ];
    expect(range30InWindow(bars, win)).toBeNull();
    // 放宽门槛就能出值（说明 null 是腿数判据，不是算不出来）
    expect(range30InWindow(bars, win, { minLegs: 1 }).pct).toBeCloseTo(178.91, 2);
  });

  it('停牌等价：基准日 / 期末当天没有 bar ⇒ 取更早那根（价格未变，数值不变）', () => {
    const bars = [
      { ymd: '2026-09-01', close: 5.31 },          // 基准日之前最后一根
      { ymd: win.dates[10], close: 9 },
      { ymd: win.dates[12], close: 9.5 }
    ];
    const got = range30InWindow(bars, win, { minLegs: 1 });
    expect(got.baseDate).toBe('2026-09-01');
    expect(got.endDate).toBe(win.dates[12]);
  });

  it('负涨幅照实返回负数', () => {
    const bars = [
      { ymd: win.baseDate, close: 10 },
      { ymd: win.end, close: 6 }
    ];
    expect(range30InWindow(bars, win, { minLegs: 1 }).pct).toBeCloseTo(-40, 6);
  });
});
