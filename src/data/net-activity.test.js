import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  netInflight, netIdle, netStalled, netHardStalled, tableOfUrl, isUnrelatedTable,
  _netBegin, _netEnd, _resetNetActivity, NET_STALL_MS, NET_IDLE_MS, NET_HARD_MS,
  markNetLoadWindow, netTrackedFetch
} from './net-activity.js';

beforeEach(function () {
  _resetNetActivity();
});
afterEach(function () {
  vi.useRealTimers();
  _resetNetActivity();
});

describe('tableOfUrl · 从 PostgREST URL 取表名', function () {
  it('普通 REST 路径', function () {
    expect(tableOfUrl('https://x.supabase.co/rest/v1/auction_watchlist?select=date')).toBe('auction_watchlist');
  });
  it('非 REST（auth / storage / realtime）⇒ 空串', function () {
    expect(tableOfUrl('https://x.supabase.co/auth/v1/token')).toBe('');
    expect(tableOfUrl('https://x.supabase.co/storage/v1/object/x')).toBe('');
    expect(tableOfUrl('https://x.supabase.co/realtime/v1/websocket')).toBe('');
  });
  it('空值不炸', function () {
    expect(tableOfUrl('')).toBe('');
    expect(tableOfUrl(null)).toBe('');
  });
});

describe('isUnrelatedTable · 排除列表方向必须是「默认计入」', function () {
  it('选股依赖的表【必须计入】（反向白名单会让门控永久挂起）', function () {
    ['auction_watchlist', 'market_metrics', 'stock_topics', 'core_topics',
      'auction_board_tags', 'daily_highlights', 'dragon_leaders', 'auction_presence',
      'stock_range_pct', 'stock_range20_pct', 'tvrb_ebb_days'
    ].forEach(function (t) {
      expect(isUnrelatedTable(t)).toBe(false);
    });
  });
  it('历史腿表可排除：它的结论由 buy-settle ⑥「20 日涨幅结论」单独把关，继续在途只影响展示列', function () {
    // 实测：这张表以 ≈1.5s 节拍连续起跑 40s+，计进来会让「网络静默」永远到不了（买点侧白等 40s）
    expect(isUnrelatedTable('stock_daily_pct')).toBe(true);
  });
  it('未知新表默认计入（保守：宁可多等，不漏）', function () {
    expect(isUnrelatedTable('some_future_table')).toBe(false);
  });
  it('明确无关的其它看板表可排除', function () {
    expect(isUnrelatedTable('tick_minute')).toBe(true);
    expect(isUnrelatedTable('early_etf_data')).toBe(true);
    expect(isUnrelatedTable('jiwang_data')).toBe(true);
  });
});

describe('在途计数 · 只统计会参与选股结论的请求', function () {
  it('相关表：begin 计入、end 归零', function () {
    expect(_netBegin('https://x.supabase.co/rest/v1/auction_watchlist?select=date')).toBe(true);
    expect(netInflight.value).toBe(1);
    _netEnd();
    expect(netInflight.value).toBe(0);
  });
  it('无关表 / 非 REST：不计入（否则分笔每秒到货会让门控永不放行）', function () {
    expect(_netBegin('https://x.supabase.co/rest/v1/tick_minute?date=eq.2026-10-30')).toBe(false);
    expect(_netBegin('https://x.supabase.co/auth/v1/token')).toBe(false);
    expect(netInflight.value).toBe(0);
  });
  it('多个并发请求逐一归零；多余 end 不会把计数压成负数（§10 不许出现负水位）', function () {
    _netBegin('https://x.supabase.co/rest/v1/market_metrics?scope=eq.auction');
    _netBegin('https://x.supabase.co/rest/v1/market_metrics?scope=eq.auction&offset=1000');
    _netEnd();
    expect(netInflight.value).toBe(1);
    _netEnd();
    expect(netInflight.value).toBe(0);
    _netEnd();
    expect(netInflight.value).toBe(0);
  });
});

describe('netTrackedFetch · 包装器语义不许变', function () {
  it('成功 / 失败都必须归零（⛔ 失败不 end ⇒ 门控永久挂起）', async function () {
    const orig = globalThis.fetch;
    globalThis.fetch = function () { return Promise.resolve({ ok: true, status: 200 }); };
    try {
      const r = await netTrackedFetch('https://x.supabase.co/rest/v1/auction_watchlist?select=date');
      expect(r.status).toBe(200);
      expect(netInflight.value).toBe(0);

      globalThis.fetch = function () { return Promise.reject(new Error('boom')); };
      await expect(netTrackedFetch('https://x.supabase.co/rest/v1/market_metrics')).rejects.toThrow('boom');
      expect(netInflight.value).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('netIdle · 「整批真的读完了」才是放行判据', function () {
  const U = 'https://x.supabase.co/rest/v1/auction_watchlist?select=date';

  it('初始就是静默态（首帧还没起请求时，没有要等的东西）', function () {
    expect(netIdle.value).toBe(true);
  });

  it('请求一起跑立刻退出静默（⛔ 不许用瞬时值，否则中途放行）', function () {
    _netBegin(U);
    expect(netIdle.value).toBe(false);
  });

  it('在途归零后还要静默 NET_IDLE_MS 才算读完（分批起跑的波间空档不算）', function () {
    vi.useFakeTimers();
    _netBegin(U);
    _netEnd();
    expect(netInflight.value).toBe(0);
    expect(netIdle.value).toBe(false);          // ← 归零的瞬间**不许**判读完了
    vi.advanceTimersByTime(NET_IDLE_MS - 1);
    expect(netIdle.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(netIdle.value).toBe(true);
  });

  it('静默期里来了新请求 ⇒ 重新计时（这是「放行后又换票」的直接防线）', function () {
    vi.useFakeTimers();
    _netBegin(U);
    _netEnd();
    vi.advanceTimersByTime(NET_IDLE_MS - 100);
    _netBegin('https://x.supabase.co/rest/v1/market_metrics');
    expect(netIdle.value).toBe(false);
    _netEnd();
    vi.advanceTimersByTime(NET_IDLE_MS - 1);
    expect(netIdle.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(netIdle.value).toBe(true);
  });

  it('无关表（分笔）不参与静默判定（否则高频到货会让门控永不放行）', function () {
    vi.useFakeTimers();
    _netBegin('https://x.supabase.co/rest/v1/tick_minute?date=eq.2026-10-30');
    expect(netIdle.value).toBe(true);
    _netEnd();
    vi.advanceTimersByTime(NET_IDLE_MS);
    expect(netIdle.value).toBe(true);
  });

  it('静默时长必须 ≥ 选股指纹稳定期（两道闸门不能互相打架）', function () {
    expect(NET_IDLE_MS).toBeGreaterThanOrEqual(1500);
  });
});

describe('装载窗口 · 软超时 / 硬兜底两级', function () {
  it('软超时（20s）不该等于放行 —— 业务侧还要看名单是否就绪', function () {
    vi.useFakeTimers();
    _netBegin('https://x.supabase.co/rest/v1/auction_watchlist?select=stock');
    markNetLoadWindow();
    expect(netStalled.value).toBe(false);
    vi.advanceTimersByTime(NET_STALL_MS);
    expect(netStalled.value).toBe(true);
    expect(netHardStalled.value).toBe(false);      // ← 还没到硬兜底
  });

  it('硬兜底（45s）无条件置位（防「拉取失败 ⇒ 买点侧永久空着」）', function () {
    vi.useFakeTimers();
    _netBegin('https://x.supabase.co/rest/v1/auction_watchlist?select=stock');
    markNetLoadWindow();
    vi.advanceTimersByTime(NET_HARD_MS);
    expect(netHardStalled.value).toBe(true);
    expect(netStalled.value).toBe(true);
  });

  it('下一个装载窗口把两级旗标都收掉', function () {
    vi.useFakeTimers();
    _netBegin('https://x.supabase.co/rest/v1/auction_watchlist?select=stock');
    markNetLoadWindow();
    vi.advanceTimersByTime(NET_HARD_MS);
    expect(netHardStalled.value).toBe(true);
    markNetLoadWindow();
    expect(netHardStalled.value).toBe(false);
    expect(netStalled.value).toBe(false);
  });

  it('硬兜底必须晚于软超时（⛔ 写反了就等于「永远靠兜底」）', function () {
    expect(NET_HARD_MS).toBeGreaterThan(NET_STALL_MS);
  });
});

describe('netStalled · 防卡死的粘性闸门', function () {
  it('在途归零【不许】清掉超时旗标（清了就会「放行→又挂回占位」闪回）', function () {
    _netBegin('https://x.supabase.co/rest/v1/market_metrics');
    netStalled.value = true;            // 等价于 markNetLoadWindow 的 25s 到期
    expect(netInflight.value).toBe(1);
    _netEnd();
    expect(netStalled.value).toBe(true);
  });
});

describe('停滞阈值', function () {
  it('必须远大于最慢单条实测（13.8s），否则会在正常慢网下误判超时', function () {
    expect(NET_STALL_MS).toBeGreaterThanOrEqual(20000);
  });
  it('初始不处于停滞态', function () {
    expect(netStalled.value).toBe(false);
  });
});
