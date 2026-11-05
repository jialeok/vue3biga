// stock-code-resolver.test.js — 「名称 → 6 位代码」解析链的回归护栏
//
// 事故（2026-11-05 用户第 9 次报障）：
//   「上海洗霸和大洋电机也没有当天数据，到底哪里错了」——竞价量列永远是 '-'。
//   逐层取证得到两个硬事实，这组用例把它们钉死：
//     ① `stockcodemap` **不是全量表**（实测全表 1130 行 / 全市场 5000+），
//        上海洗霸(603200) / 大洋电机(002249) 一条都没有 ⇒ 只查这张表必然漏；
//     ② 唯一能按中文名反查的上游（宽基成分股）被 `FUYAO_OFF` 拦着 ⇒ 那条腿线上从没成功过。
//   所以解析必须「本地已有真数据优先，上游兜底最后」，任何一级失败都不算「这只票没代码」。
//
// 这组用例锁住：
//   ① 一级命中就**不再发**二级请求（§32）；
//   ② stockcodemap 没有 ⇒ 落到 market_metrics 历史行的真 code；
//   ③ 再没有 ⇒ 落到 auction_watchlist 历史行；
//   ④ 任何一级抛错都**不许中断**整条链（§10 读失败 ≠ 查不到）；
//   ⑤ 解析结果必须回写内存缓存，让同步的 getStockCode 也能命中；
//   ⑥ ⛔ 非 6 位代码一律不收（§40 不猜、不补零）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 可控的 supabase 桩：每张表返回一份「行数组」，`throwOn` 里的表直接抛错
const sbMock = vi.hoisted(() => ({
  tables: {},
  throwOn: new Set(),
  calls: [],
}));

vi.mock('./supabase-client.js', () => ({
  getSupabase: function() {
    return {
      from: function(table) {
        sbMock.calls.push(table);
        const builder = {
          _t: table,
          select: function() { return builder; },
          in: function() { return builder; },
          not: function() { return builder; },
          order: function() { return builder; },
          limit: function() { return builder; },
          then: function(resolve, reject) {
            if (sbMock.throwOn.has(builder._t)) {
              return Promise.reject(new Error('mock boom: ' + builder._t)).then(resolve, reject);
            }
            return Promise.resolve({ data: sbMock.tables[builder._t] || [], error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  },
}));

vi.mock('./api/fuyao-proxy.js', () => ({ fuyaoApiGet: vi.fn() }));
vi.mock('./debug-log.js', () => ({ _dbgLog: () => {} }));

import { resolveCodesByNames, _resetStockCodeResolverCache } from './stock-code-resolver.js';
import { fuyaoApiGet } from './api/fuyao-proxy.js';
import { state } from '../logic/app-state.js';

beforeEach(() => {
  sbMock.tables = {};
  sbMock.throwOn = new Set();
  sbMock.calls = [];
  vi.clearAllMocks();
  _resetStockCodeResolverCache();
  state._scMapCache = {};
  // 上游一律返回空（模拟 FUYAO_OFF 下的真实行为：抛错）
  fuyaoApiGet.mockRejectedValue(new Error('同花顺通道已临时停用'));
});

describe('解析链：本地真数据优先，上游兜底最后', () => {
  it('① 内存缓存命中 ⇒ 一个数据库请求都不发', async () => {
    state._scMapCache = { 票A: '600001' };
    const r = await resolveCodesByNames(['票A']);
    expect(r).toEqual({ 票A: '600001' });
    expect(sbMock.calls).toEqual([]);
  });

  it('② stockcodemap 命中 ⇒ 不再查历史行（§32 不重复请求）', async () => {
    sbMock.tables.stockcodemap = [{ stock: '票A', code: '600001' }];
    const r = await resolveCodesByNames(['票A']);
    expect(r).toEqual({ 票A: '600001' });
    expect(sbMock.calls).toEqual(['stockcodemap']);
  });

  it('③ stockcodemap 缺这只（1130 行不是全量的真实形状）⇒ 落到 market_metrics 历史行的真 code', async () => {
    sbMock.tables.stockcodemap = [];
    sbMock.tables.market_metrics = [{ stock: '上海洗霸', code: '603200', date: '2026-11-04' }];
    const r = await resolveCodesByNames(['上海洗霸']);
    expect(r).toEqual({ 上海洗霸: '603200' });
    expect(sbMock.calls).toContain('market_metrics');
  });

  it('④ market_metrics 也没有 ⇒ 再落到 auction_watchlist 历史行', async () => {
    sbMock.tables.stockcodemap = [];
    sbMock.tables.market_metrics = [];
    sbMock.tables.auction_watchlist = [{ stock: '大洋电机', code: '002249', date: '2026-11-04' }];
    const r = await resolveCodesByNames(['大洋电机']);
    expect(r).toEqual({ 大洋电机: '002249' });
    expect(sbMock.calls).toContain('auction_watchlist');
  });

  it('§10：某一级抛错不许中断整条链 —— 后面几级照走', async () => {
    sbMock.throwOn = new Set(['stockcodemap']);
    sbMock.tables.market_metrics = [{ stock: '票A', code: '600001', date: '2026-10-01' }];
    const r = await resolveCodesByNames(['票A']);
    expect(r).toEqual({ 票A: '600001' });
  });

  it('五级全空 ⇒ 如实返回空对象（⛔ 不猜代码、不补零）', async () => {
    const r = await resolveCodesByNames(['查不到的票']);
    expect(r).toEqual({});
    // 上游腿必须真的被试过（⛔ 不是直接放弃）
    expect(fuyaoApiGet).toHaveBeenCalled();
  });

  it('⑤ 解析结果必须回写内存缓存（同步的 getStockCode 随后能命中）', async () => {
    sbMock.tables.stockcodemap = [{ stock: '票A', code: '600001' }];
    await resolveCodesByNames(['票A']);
    expect(state._scMapCache['票A']).toBe('600001');
  });

  it('⑥ ⛔ 非 6 位代码一律不收（哪怕表里真有这行）', async () => {
    sbMock.tables.stockcodemap = [
      { stock: '票A', code: '6001' },        // 太短
      { stock: '票B', code: '6000011' },     // 太长
      { stock: '票C', code: 'SH600001' },    // 带前缀
    ];
    const r = await resolveCodesByNames(['票A', '票B', '票C']);
    expect(r).toEqual({});
    expect(state._scMapCache['票A']).toBeUndefined();
  });

  it('同一只票多条历史行 ⇒ 只取一个且稳定（倒序第一条）', async () => {
    sbMock.tables.stockcodemap = [];
    sbMock.tables.market_metrics = [
      { stock: '票A', code: '600001', date: '2026-11-04' },
      { stock: '票A', code: '600001', date: '2026-11-03' },
    ];
    const r = await resolveCodesByNames(['票A', '票A', ' 票A ']);   // 重复入参也要去重
    expect(r).toEqual({ 票A: '600001' });
  });

  it('空入参 ⇒ 直接返回空对象（不发任何请求）', async () => {
    expect(await resolveCodesByNames([])).toEqual({});
    expect(await resolveCodesByNames(null)).toEqual({});
    expect(sbMock.calls).toEqual([]);
  });
});
