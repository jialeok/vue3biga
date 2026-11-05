// supabase-write.test.js — [PGRST102 2026-11-05] worker 批量 upsert 必须按「键集」分桶
//
// 【事故现场】（2026-11-05 16:00 收盘 worker，bidding_fetch_log 原始日志）
//   [extras] 库内缺「四要素/竞价涨幅」的行 27 行
//   [extras] numcat 返回 1314 行
//   [extras] ❌ 第 1 批写入失败: HTTP 400 {"code":"PGRST102","message":"All object keys must match"}
//   [extras] ✅ 补写 0/27 行
// ⇒ 猫抓拿到了、库里 27 行等着补，整批丢光 ⇒ 当天 auc_vol_ratio 只有 58/78。
//
// 本文件钉死三条不变量：
//   ① 异键集的行绝不进同一个请求体（否则 PostgREST 直接 400，一行都不写）；
//   ② 桶内键集**完全相同** ⇒ 不存在「缺列」⇒ 不会把现有值抹成 NULL；
//   ③ ⛔ Prefer 里不许再出现 `missing=default`（它语义是「缺的列取 DEFAULT/NULL」，
//      配合 merge-duplicates 就是抹值；而且 PGRST102 在解析阶段就 400，它根本来不及生效）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  CONFIG: { SUPABASE_URL: 'https://sb.test' }
}));

const calls = [];
// ⚠️ 必须用 vi.stubGlobal 而不是直接赋值 globalThis.fetch：
//   直接赋值在 vitest 里会**跨文件泄漏**（同线程复用），实测把
//   src/data/stock-range-pct.test.js 的 5 条 healTodayRangePct 用例全打挂过。
function mockFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async function (url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: url, headers: opts.headers, body: body });
    return handler ? handler(calls.length, body) : { ok: true, text: async () => '' };
  }));
}

const { bucketRowsByKeySet, upsertMarketMetrics, upsertAuctionWatchlist } = await import('./supabase-write.js');
const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'k' };

beforeEach(() => {
  calls.length = 0;
  mockFetch(null);
});

afterEach(() => {
  // ⛔ 必须还原：否则后面跑的测试文件会拿到这个假 fetch
  vi.unstubAllGlobals();
});

describe('[PGRST102] bucketRowsByKeySet：按键集分桶', () => {
  it('★ 事故原型的 4 行（键集各不相同）⇒ 分成 4 桶，每桶内部键集一致', () => {
    const rows = [
      { date: 'd', stock: 'A', scope: 'auction', code: '1', auc_vol_ratio: '1.2', source: 'worker' },
      { date: 'd', stock: 'B', scope: 'auction', code: '2', um_vol: '3', source: 'worker' },
      { date: 'd', stock: 'C', scope: 'auction', source: 'worker' },
      { date: 'd', stock: 'D', scope: 'auction', code: '4', auc_turnover: '0.5', source: 'worker' }
    ];
    const buckets = bucketRowsByKeySet(rows);
    expect(buckets).toHaveLength(4);
    buckets.forEach(function (b) {
      const sigs = new Set(b.rows.map(function (r) { return Object.keys(r).sort().join(','); }));
      expect(sigs.size).toBe(1);                 // 桶内键集唯一
      expect(b.keys).toEqual(Object.keys(b.rows[0]).sort());
    });
    expect(buckets.reduce(function (n, b) { return n + b.rows.length; }, 0)).toBe(4);
  });

  it('★ 键顺序不同但键集相同 ⇒ 同一桶（签名与顺序无关）', () => {
    const buckets = bucketRowsByKeySet([
      { a: 1, b: 2 },
      { b: 3, a: 4 }
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].rows).toHaveLength(2);
  });

  it('同键集 27 行 ⇒ 1 桶（正常路径不许多发请求，§32）', () => {
    const rows = [];
    for (let i = 0; i < 27; i++) rows.push({ date: 'd', stock: 'S' + i, auc_vol_ratio: '1' });
    expect(bucketRowsByKeySet(rows)).toHaveLength(1);
  });

  it('空 / null / undefined ⇒ 空数组，不抛错', () => {
    expect(bucketRowsByKeySet([])).toEqual([]);
    expect(bucketRowsByKeySet(null)).toEqual([]);
    expect(bucketRowsByKeySet(undefined)).toEqual([]);
  });

  it('脏数据（null 元素）跳过而不是炸掉整批', () => {
    expect(bucketRowsByKeySet([null, { a: 1 }, undefined])).toHaveLength(1);
  });
});

describe('[PGRST102] upsertMarketMetrics：异键集不再整批丢失', () => {
  it('★ 3 种键集 ⇒ 3 个请求，每个请求体内部键集完全一致（不会再 PGRST102）', async () => {
    await upsertMarketMetrics(ENV, [
      { date: 'd', stock: 'A', scope: 'auction', auc_vol_ratio: '1.1' },
      { date: 'd', stock: 'B', scope: 'auction', um_vol: '9' },
      { date: 'd', stock: 'C', scope: 'auction', auc_vol_ratio: '2.2', auc_turnover: '0.3' }
    ]);
    expect(calls).toHaveLength(3);
    calls.forEach(function (c) {
      expect(c.url).toContain('/rest/v1/market_metrics?on_conflict=date,stock,scope');
      const sigs = new Set(c.body.map(function (r) { return Object.keys(r).sort().join(','); }));
      expect(sigs.size).toBe(1);
    });
    const total = calls.reduce(function (n, c) { return n + c.body.length; }, 0);
    expect(total).toBe(3);                        // 一行都没丢
  });

  it('★ Prefer 里 ⛔ 不许出现 missing=default（它会把没写的列抹成 NULL）', async () => {
    await upsertMarketMetrics(ENV, [{ date: 'd', stock: 'A', scope: 'auction', auc_vol_ratio: '1' }]);
    expect(calls[0].headers.Prefer).toContain('resolution=merge-duplicates');
    expect(calls[0].headers.Prefer).not.toContain('missing=');
  });

  it('★ 某一桶失败 ⇒ 抛错且文案带桶序号/行数/键集（§10 报错必须能定位）', async () => {
    mockFetch(function (n) {
      if (n === 2) {
        return { ok: false, status: 400, text: async () => '{"code":"PGRST102"}' };
      }
      return { ok: true, text: async () => '' };
    });
    await expect(upsertMarketMetrics(ENV, [
      { date: 'd', stock: 'A', scope: 'auction', auc_vol_ratio: '1' },
      { date: 'd', stock: 'B', scope: 'auction', um_vol: '9' }
    ])).rejects.toThrow(/第 2\/2 桶.*键集/);
  });

  it('空数组 ⇒ 一个请求都不发', async () => {
    await upsertMarketMetrics(ENV, []);
    expect(calls).toHaveLength(0);
  });

  it('auction_watchlist 也走同一套分桶（同一个 Data 层入口，§6）', async () => {
    await upsertAuctionWatchlist(ENV, [
      { date: 'd', stock: 'A', code: '1' },
      { date: 'd', stock: 'B' }
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('auction_watchlist?on_conflict=date,stock');
  });
});
