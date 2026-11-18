import { describe, it, expect, vi } from 'vitest';

// ⚠️ 交易日历必须桩掉：真实实现（logic/date/trading-day-helpers.js）要经 supabase-client#loadAllData
//   读 localStorage / 做迁移，在 node 单测环境里根本没有这些依赖。
//   本文件要验的是【窗口结构 + 比值算法】，不是节假日数据 ⇒ 用「周一~周五」的最简日历代替即可，
//   而且这个桩是确定性的（不受真实 holiday 表配置影响）。
vi.mock('../date/trading-day-helpers.js', function() {
  const fmt = function(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  };
  const isTradingDay = function(d) {
    const dow = new Date(String(d) + 'T00:00:00').getDay();
    return dow !== 0 && dow !== 6;
  };
  const getPreviousTradingDay = function(d) {
    const dt = new Date(String(d) + 'T00:00:00');
    for (let i = 0; i < 10; i++) {
      dt.setDate(dt.getDate() - 1);
      const s = fmt(dt);
      if (isTradingDay(s)) return s;
    }
    return null;
  };
  return { isTradingDay: isTradingDay, getPreviousTradingDay: getPreviousTradingDay };
});

import {
  RANGE30_WINDOW_DAYS,
  RANGE30_MIN_LEGS,
  buildRange30Window,
  normalizeBars,
  barOnOrBefore,
  range30FromBars
} from './range30.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// 这一组测试锁死的是「30 日涨幅 = 期末收盘 / 期初前收盘 − 1」这条用户口径（2026-11-18）：
//   · 数学上与逐日累乘等价，但**不许**在实现里改回连乘（那会重新引入舍入误差与腿表依赖）；
//   · 停牌 / 次新股 / 缺价 一律判不出（§10 不补 0），这几种是线上真实会遇到的形态；
//   · 窗口口径必须与官方「连续 30 个交易日」一致（含 asOf 当天）。
// ⚠️ 交易日历在单测环境里 holidays=[] ⇒ 只有周末不算交易日。所以断言只谈「结构」与
//   「用窗口自身推导出的数值」，⛔ 不写死某个具体日期是/不是交易日（那是日历数据的测试，不是本模块的）。
// ══════════════════════════════════════════════════════════════════════════════════════

describe('buildRange30Window 窗口构造', () => {
  it('返回 30 个升序交易日，且 baseDate = 窗口首日的前一个交易日', () => {
    const w = buildRange30Window('2026-10-28');
    expect(w).not.toBeNull();
    expect(w.dates.length).toBe(RANGE30_WINDOW_DAYS);
    expect(w.start).toBe(w.dates[0]);
    expect(w.end).toBe(w.dates[w.dates.length - 1]);
    // 升序 + 无重复 + 全是工作日（单测环境 holidays=[]，所以只需排除周六周日）
    for (let i = 0; i < w.dates.length; i++) {
      if (i > 0) expect(w.dates[i] > w.dates[i - 1]).toBe(true);
      const dow = new Date(w.dates[i] + 'T00:00:00').getDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }
    // baseDate 必须严格早于 start，而且离 start 最近（再往后一天就是 start 本身或更晚）
    expect(w.baseDate < w.start).toBe(true);
    expect(w.dates.indexOf(w.baseDate)).toBe(-1);
  });

  it('asOf 是周末 ⇒ 自动退到上一个交易日（窗口末日不会是周六/周日）', () => {
    const w = buildRange30Window('2026-10-31');   // 周六
    expect(w).not.toBeNull();
    const dow = new Date(w.end + 'T00:00:00').getDay();
    expect(dow).not.toBe(0);
    expect(dow).not.toBe(6);
  });

  it('非法 / 空日期 ⇒ null（⛔ 不猜一个默认窗口）', () => {
    expect(buildRange30Window('')).toBeNull();
    expect(buildRange30Window(null)).toBeNull();
    expect(buildRange30Window('2026/10/28')).toBeNull();
    expect(buildRange30Window('not-a-date')).toBeNull();
  });
});

describe('normalizeBars K 线标准化', () => {
  it('按日期升序、同日去重（后者覆盖前者）、丢弃 close<=0 与非法日期', () => {
    const out = normalizeBars([
      { ymd: '2026-10-28', close: 14.81 },
      { ymd: '2026-10-09', close: 10 },
      { ymd: '2026-10-09', close: 11 },       // 同日重复 ⇒ 后者优先
      { ymd: '2026-10-10', close: 0 },        // 停牌/无效价 ⇒ 丢
      { ymd: 'bad', close: 5 },               // 非法日期 ⇒ 丢
      { ymd: '2026-10-11', close: -1 },       // 负价 ⇒ 丢
      null
    ]);
    expect(out.map(function(b) { return b.ymd; })).toEqual(['2026-10-09', '2026-10-28']);
    expect(out[0].close).toBe(11);
  });

  it('空 / 非数组 ⇒ 空数组（⛔ 不抛错）', () => {
    expect(normalizeBars(null)).toEqual([]);
    expect(normalizeBars([])).toEqual([]);
  });
});

describe('barOnOrBefore 停牌等价取值', () => {
  const series = [
    { ymd: '2026-09-04', close: 5.31 },
    { ymd: '2026-09-21', close: 7 },
    { ymd: '2026-10-28', close: 14.81 }
  ];

  it('命中当天 ⇒ 当天那根', () => {
    expect(barOnOrBefore(series, '2026-09-21').close).toBe(7);
  });

  it('当天停牌（区间内没有这根）⇒ 取它之前最后一根（停牌期间前收盘不变，数学等价）', () => {
    expect(barOnOrBefore(series, '2026-09-18').close).toBe(5.31);   // 09-18 无 bar
    expect(barOnOrBefore(series, '2026-10-20').close).toBe(7);
  });

  it('早于序列第一根 ⇒ null（次新股就是这种形态）', () => {
    expect(barOnOrBefore(series, '2026-09-01')).toBeNull();
  });
});

describe('range30FromBars 30 日涨幅（一次性比值）', () => {
  // 新华传媒 600825 的真实数字（2026-11-18 用户对账口径）：
  //   30 日窗口 09-09~10-28，期初前收盘 5.31 → 期末收盘 14.81 = +178.91%
  //   ⚠️ 这里不写死日期（依赖日历数据），而是用 buildRange30Window 现推窗口，
  //      这样「比值算法」被测到，而「哪天是交易日」不归本测试管。
  const ASOF = '2026-10-28';
  const win = buildRange30Window(ASOF);

  it('期末收盘 / 期初前收盘 − 1 = 178.91%（与逐日累乘完全一致的真值）', () => {
    const bars = [
      { ymd: win.baseDate, close: 5.31 },
      { ymd: win.end, close: 14.81 }
    ];
    const got = range30FromBars(bars, ASOF, { minLegs: 1 });
    expect(got).not.toBeNull();
    expect(got.pct).toBeCloseTo(178.91, 1);
    expect(got.baseClose).toBe(5.31);
    expect(got.endClose).toBe(14.81);
    expect(got.baseDate).toBe(win.baseDate);
    expect(got.endDate).toBe(win.end);
  });

  it('停牌不影响数值：基准日那天没有 bar ⇒ 用更早的收盘，结果与原值一致', () => {
    const pausedBase = [
      { ymd: '2026-09-04', close: 5.31 },          // 基准日之前最后一个有成交的日子
      { ymd: win.end, close: 14.81 }
    ];
    const got = range30FromBars(pausedBase, ASOF, { minLegs: 1 });
    expect(got).not.toBeNull();
    expect(got.pct).toBeCloseTo(178.91, 1);
    // 如实报出「实际用的是哪一天的前收盘」，⛔ 不假装是窗口首日前一天
    expect(got.baseDate).toBe('2026-09-04');
  });

  it('asOf 当天停牌 ⇒ 期末取 ≤ asOf 的最后一根（价格未变，等价）', () => {
    const bars = [
      { ymd: win.baseDate, close: 5.31 },
      { ymd: '2026-10-26', close: 14.81 }
    ];
    const got = range30FromBars(bars, ASOF, { minLegs: 1 });
    expect(got).not.toBeNull();
    expect(got.endDate).toBe('2026-10-26');
    expect(got.pct).toBeCloseTo(178.91, 1);
  });

  it('次新股（K 线从窗口中间才开始）⇒ null，⛔ 绝不拿上市首日当基准凑数', () => {
    const bars = [
      { ymd: win.start, close: 8 },                // 窗口首日才上市
      { ymd: win.end, close: 14.81 }
    ];
    expect(range30FromBars(bars, ASOF, { minLegs: 1 })).toBeNull();
  });

  it('窗口内成交腿数不足门槛 ⇒ null（默认门槛 10 天）', () => {
    const bars = [
      { ymd: win.baseDate, close: 5.31 },
      { ymd: win.end, close: 14.81 }
    ];
    // 默认 minLegs = RANGE30_MIN_LEGS(10)，这里窗口内只有 1 根腿
    expect(RANGE30_MIN_LEGS).toBe(10);
    expect(range30FromBars(bars, ASOF)).toBeNull();
  });

  it('腿数够（凑满 10 根）⇒ 出值，且 days = 窗口内真实成交根数', () => {
    const bars = [{ ymd: win.baseDate, close: 5.31 }];
    // 取窗口内前 10 个交易日各一根腿
    for (let i = 0; i < 10; i++) bars.push({ ymd: win.dates[i], close: 5.31 + i * 0.1 });
    bars.push({ ymd: win.end, close: 14.81 });
    const got = range30FromBars(bars, ASOF);
    expect(got).not.toBeNull();
    expect(got.days).toBe(11);   // 10 根 + 期末那根（若期末恰好在窗口内）
  });

  it('空序列 / 全非法 ⇒ null（⛔ 不返回 0%）', () => {
    expect(range30FromBars([], ASOF)).toBeNull();
    expect(range30FromBars(null, ASOF)).toBeNull();
    expect(range30FromBars([{ ymd: 'bad', close: 1 }], ASOF)).toBeNull();
  });

  it('跨 0 与负涨幅：期末低于期初 ⇒ 负数（不是 0，也不是绝对值）', () => {
    const bars = [
      { ymd: win.baseDate, close: 10 },
      { ymd: win.end, close: 6 }
    ];
    const got = range30FromBars(bars, ASOF, { minLegs: 1 });
    expect(got.pct).toBeCloseTo(-40, 6);
  });
});
