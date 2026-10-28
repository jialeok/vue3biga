// morning-sync.test.js —— 早盘自愈的「跨天 re-arm」与幂等回归
//
// 【为什么要这几个用例】用户最关心的一条：**晚上提前打开页面、次早 9:26 不按 F5**。
//   旧实现的 `startMorningSync()` 在函数【第一行】就 `_started = true`，
//   于是晚上（>15:00）打开时走进「已过收盘，不启动早盘自愈」分支后，
//   `_started` 永远为 true ⇒ 次早 9:24 窗口到了也【不会有任何调度】⇒ 9:25 数据永远不到。
//   这组用例把「晚上打开 ⇒ 明早真的会自愈」钉死成回归。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 可控的「今天」：晚开 / 次早跨天都要能切换
let _todayStr = '2026-10-28';

vi.mock('./auction-pull-window.js', () => ({
  beijingTodayStr: () => _todayStr
}));

vi.mock('../date/trading-day-helpers.js', () => ({
  isTradingDay: () => true
}));

vi.mock('../../data/watchlist-and-metrics.js', () => ({
  pullAuctionMarketDataForDate: vi.fn(() => Promise.resolve())
}));

vi.mock('../../data/debug-log.js', () => ({
  _dbgLog: () => {}
}));

import { startMorningSync, _resetMorningSyncState, _todayDataArrived } from './morning-sync.js';
import { pullAuctionMarketDataForDate } from '../../data/watchlist-and-metrics.js';
import { state } from '../app-state.js';

const MIN = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  _todayStr = '2026-10-28';
  state._auctionMemCache = {};
  pullAuctionMarketDataForDate.mockClear();
  _resetMorningSyncState();
});

afterEach(() => {
  _resetMorningSyncState();
  vi.useRealTimers();
});

describe('morning-sync 跨天自愈（用户场景：晚上提前打开 → 次早不刷新）', () => {
  it('晚上 21:00 打开：不立刻自愈，但会 re-arm；次早 09:24 真的会拉一次当天数据', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 21, 0, 0)); // 本地时间 21:00（北京时间分钟口径同源）

    startMorningSync();
    // 晚上不该发起任何补拉
    expect(pullAuctionMarketDataForDate).toHaveBeenCalledTimes(0);

    // 跨到次日：re-arm 应该在 09:24:05 触发
    _todayStr = '2026-10-29';
    await vi.advanceTimersByTimeAsync(12 * 60 * MIN + 24 * MIN + 10 * 1000);

    // ★ 关键断言：次早窗口到了，真的去拉「当天」的数据
    expect(pullAuctionMarketDataForDate).toHaveBeenCalled();
    expect(pullAuctionMarketDataForDate.mock.calls[0][0]).toBe('2026-10-29');
  });

  it('晚上打开过一次，次日窗口仍然有效（_started 不会被钉死）', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 22, 30, 0));
    startMorningSync();
    expect(pullAuctionMarketDataForDate).toHaveBeenCalledTimes(0);

    _todayStr = '2026-10-29';
    await vi.advanceTimersByTimeAsync(11 * 60 * MIN + 10 * 1000); // 到 09:24:10 之后
    await vi.advanceTimersByTimeAsync(2 * MIN);

    expect(pullAuctionMarketDataForDate).toHaveBeenCalled();
  });

  it('早于窗口打开（09:10）：等到 09:24 才开始，不白跑', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 9, 10, 0));
    startMorningSync();
    expect(pullAuctionMarketDataForDate).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(pullAuctionMarketDataForDate).toHaveBeenCalled();
    expect(pullAuctionMarketDataForDate.mock.calls[0][0]).toBe('2026-10-28');
  });

  it('同一次启动内重复调用 startMorningSync 仍然幂等（不重复调度）', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 9, 20, 0));
    startMorningSync();
    startMorningSync();
    startMorningSync();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(pullAuctionMarketDataForDate).toHaveBeenCalledTimes(1);
  });
});

describe('morning-sync · _todayDataArrived（判定「当天这批数据到了没」）', () => {
  it('没有任何行 ⇒ 未到', () => {
    state._auctionMemCache = { '2026-10-28': [] };
    expect(_todayDataArrived('2026-10-28')).toBe(false);
  });

  it('有行但三个行情字段全空 ⇒ 仍未到（影子里只有名单，不算到齐）', () => {
    state._auctionMemCache = { '2026-10-28': [{ stock: '大业股份', auc_pct_chg: '', volume: '  ', change_pct: null }] };
    expect(_todayDataArrived('2026-10-28')).toBe(false);
  });

  it('任一行带竞价涨幅 ⇒ 已到', () => {
    state._auctionMemCache = { '2026-10-28': [{ stock: '大业股份', auc_pct_chg: '5.2' }] };
    expect(_todayDataArrived('2026-10-28')).toBe(true);
  });
});
