// range20-prefill.test.js — [R20-PREFILL 2026-11-05] 「20日涨幅结果表 0 上游预填」单测
//
// 背景（实测取证，不是假设）：2026-11-05 当天 `stock_range20_pct` 只有 63/78 行，缺 15 只，
//   而这 15 只在 `stock_daily_pct` 里每只都有 25 条逐日腿 ⇒ 数据齐、只是没人算。
//   根因 = 结果表只有两个写入点，一个由 toggle 触发、一个只写它选出的 ~25 只龙头。
//   `prefillRange20FromDailyLegs` 就是「进看板就顺带把结果表补齐」的那条 0 上游通路。
//
// 本文件锁的是它的三条红线（判据与 `ensureRange20` 阶段② 的 `finalRows` 必须同一份）：
//   ① 腿不齐 ⛔ 不写（绝不把「只有当天涨幅」当 20 日涨幅落库，§10 宁缺勿错）
//   ② 云端已有的票 ⛔ 不覆盖（那是 K 线算过的真值，重写只会把准的写粗）
//   ③ 云端已全覆盖 ⇒ 一次查询就收工，不读原料表、不算、不写（常态路径）

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cloud: new Map(),      // 结果表内容：name -> {pct, days}
  saved: [],             // upsertRange20Rows 的入参留痕
  daily: null,           // 原料表：name -> Map(date -> pct)；null = 表读不到
  auctionData: {},       // 内存逐日行（T 腿来源）
}));

// ── Data 层：结果表 / 原料表 ───────────────────────────────────────────────
vi.mock('../../data/stock-range20-cache.js', () => ({
  readRange20Rows: async () => h.cloud,
  // 真实现按 leg 过滤；本测试只关心「这个名字云端有没有」，透传即可
  pickUsableRows: (map) => (map instanceof Map ? map : new Map()),
  upsertRange20Rows: async (date, rows, leg) => {
    h.saved.push({ date: date, rows: rows, leg: leg });
    return rows.length;
  }
}));
vi.mock('../../data/stock-daily-pct.js', () => ({
  readDailyPctRows: async () => h.daily,
  readDailyPctRowsFor: async () => h.daily,
  upsertDailyPctRows: async () => 0
}));

// ── 环境：日历 / 内存行 / 全局状态 ────────────────────────────────────────
const TODAY = '2026-11-05';
const T = '2026-11-04';

vi.mock('./dragon-rank.js', () => ({
  // 升序探针的源头：返回【降序】45 天，range20#getRange20WindowDates 会 reverse 成升序
  getDragonWindowDates: (date, days) => {
    const out = [date];
    let cur = Date.parse(date + 'T00:00:00Z');
    for (let i = 1; i < days; i++) {
      cur -= 86400000;
      out.push(new Date(cur).toISOString().slice(0, 10));
    }
    return out;
  }
}));
vi.mock('../date/trading-day-helpers.js', () => ({ isTradingDay: () => true }));
vi.mock('../tagTitles/rules.js', () => ({ _getLocalTodayStr: () => TODAY }));
vi.mock('../app-core-api.js', () => ({ getAuctionData: () => h.auctionData }));
vi.mock('../app-state.js', () => ({ state: { _scMapCache: {} } }));
vi.mock('./auction-fetch-helpers.js', () => ({ ensureAuctionCodeMapping: async () => {} }));

const { prefillRange20FromDailyLegs, getRange20WindowDates, RANGE20_PROBE_DAYS } =
  await import('./range20.js');

/** 升序探针日期（与 range20 内部完全同一个函数，⛔ 不在测试里另造一套日历） */
function probeDatesOf() {
  return getRange20WindowDates(T, RANGE20_PROBE_DAYS);
}

/** 前 n 只票：T 腿（内存行）+ 历史 19 根腿（原料表）—— 一眼看去就该被写进结果表 */
function mkHealthy(count, dates) {
  const asc = dates;
  const tIdx = asc.length - 1;                 // 最后一个是 T
  const histDates = asc.slice(tIdx - 19, tIdx); // T 之前的 19 天
  const names = [];
  const daily = new Map();
  const rows = [];
  for (let i = 0; i < count; i++) {
    const name = 'HEALTHY' + i;
    names.push(name);
    const m = new Map();
    histDates.forEach(function(d) { m.set(d, 1); });   // 每天 +1% ⇒ 复利后 > 20%
    daily.set(name, m);
    rows.push({ stock: name, changePct: '1.00' });      // T 腿（收盘口径 ⇒ 需要它存在）
  }
  return { names: names, daily: daily, rows: rows };
}

beforeEach(() => {
  h.cloud = new Map();
  h.saved = [];
  h.daily = null;
  h.auctionData = {};
});

describe('[R20-PREFILL] 腿齐的票 ⇒ 补进结果表', () => {
  it('★ 云端缺的票被写进去，且写入行数 = 缺口数（不是全量重写）', async () => {
    const dates = probeDatesOf();
    const ok = mkHealthy(5, dates);
    h.daily = ok.daily;
    h.auctionData[T] = ok.rows;
    // 云端已经有前 3 只 ⇒ 只该补后 2 只
    ok.names.slice(0, 3).forEach(function(n) { h.cloud.set(n, { pct: 30, days: 20 }); });

    const st = await prefillRange20FromDailyLegs(T, ok.names.map(function(n) { return { stock: n }; }));

    expect(st.targets).toBe(5);
    expect(st.covered).toBe(3);
    expect(st.written).toBe(2);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].date).toBe(T);
    expect(h.saved[0].rows.map(function(r) { return r.stock; }).sort())
      .toEqual(['HEALTHY3', 'HEALTHY4']);
    // 复利口径：19 天各 +1% 再叠加 T 腿 +1% ⇒ 20 根腿、数值 > 20%（不是简单相加的 20）
    const r0 = h.saved[0].rows.find(function(r) { return r.stock === 'HEALTHY3'; });
    expect(r0.days).toBe(20);
    expect(r0.pct).toBeGreaterThan(20);
  });

  it('★ 云端已全覆盖 ⇒ 一次查询就收工：不读原料表、不计算、不写（常态路径）', async () => {
    const dates = probeDatesOf();
    const ok = mkHealthy(3, dates);
    h.daily = null;                  // 故意让原料表「读不到」：全覆盖时根本不该碰它
    ok.names.forEach(function(n) { h.cloud.set(n, { pct: 30, days: 20 }); });

    const st = await prefillRange20FromDailyLegs(T, ok.names.map(function(n) { return { stock: n }; }));

    expect(st.covered).toBe(3);
    expect(st.written).toBe(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe('[R20-PREFILL] §10 宁缺勿错：腿不齐一律不写', () => {
  it('★ 只有 T 腿、没有历史腿的票 ⛔ 不写（否则「今天涨 1%」会被当成 20 日涨幅落库）', async () => {
    const dates = probeDatesOf();
    const ok = mkHealthy(2, dates);
    h.daily = ok.daily;
    // 第二只：原料表里一根腿都没有 —— 只有 T 腿
    h.daily.delete('HEALTHY1');
    h.auctionData[T] = ok.rows;

    const st = await prefillRange20FromDailyLegs(T, [
      { stock: 'HEALTHY0' }, { stock: 'HEALTHY1' }
    ]);

    expect(st.written).toBe(1);
    expect(st.skipped).toBe(1);
    expect(h.saved[0].rows.map(function(r) { return r.stock; })).toEqual(['HEALTHY0']);
  });

  it('★ 原料表整张读不到 ⇒ 一只都不写（只剩 T 腿，全是假数）', async () => {
    const dates = probeDatesOf();
    const ok = mkHealthy(3, dates);
    h.daily = null;                  // 读失败
    h.auctionData[T] = ok.rows;

    const st = await prefillRange20FromDailyLegs(T, ok.names.map(function(n) { return { stock: n }; }));

    expect(st.written).toBe(0);
    expect(h.saved).toHaveLength(0);
  });

  it('★ 真实交易日凑不满 20 天 ⇒ 不写（现在写进去的一定是偏小的数）', async () => {
    const dates = probeDatesOf();
    const asc = dates;
    const tIdx = asc.length - 1;
    const only5 = asc.slice(tIdx - 5, tIdx);      // 只有 5 天历史腿
    const daily = new Map();
    const m = new Map();
    only5.forEach(function(d) { m.set(d, 1); });
    daily.set('SHORT', m);
    h.daily = daily;
    h.auctionData[T] = [{ stock: 'SHORT', changePct: '1.00' }];

    const st = await prefillRange20FromDailyLegs(T, [{ stock: 'SHORT' }]);

    expect(st.written).toBe(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe('[R20-PREFILL] 边界', () => {
  it('目标为空 / 日期为空 ⇒ 直接返回零统计，不抛错', async () => {
    expect((await prefillRange20FromDailyLegs('', [{ stock: 'A' }])).written).toBe(0);
    expect((await prefillRange20FromDailyLegs(T, [])).written).toBe(0);
    expect(h.saved).toHaveLength(0);
  });

  it('历史日（T 不是今天）不受影响：同样能补（收盘口径要求 T 腿存在，缺则不写）', async () => {
    const dates = probeDatesOf();
    const ok = mkHealthy(2, dates);
    h.daily = ok.daily;
    h.auctionData[T] = ok.rows;      // 内存里有 T 行 ⇒ 收盘口径也有 T 腿

    const st = await prefillRange20FromDailyLegs(T, ok.names.map(function(n) { return { stock: n }; }));

    expect(st.written).toBe(2);
  });
});
