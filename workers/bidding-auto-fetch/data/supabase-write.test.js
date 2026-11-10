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

const {
  bucketRowsByKeySet, upsertMarketMetrics, upsertAuctionWatchlist,
  readDailyLegsForStocks, readRange20StocksForDate
} = await import('./supabase-write.js');
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

// ============================================================================
// [R20-LEGS-PAGED 2026-11-10 P0] 9:26 云端 20 日涨幅补位读腿【不许截断】
//
// 事故：readDailyLegsForStocks 每批写死 limit=1000 且不分页。
//   11-10：75 只票 × 44 根腿 ≈ 3300 行，被砍成 2×1000 ⇒ 21 只票（含冰山冷热）
//   误判「腿不足 19 根」拒写 ⇒ 20 日涨幅主板前三里没有它 ⇒ 题材量比首屏只给空仓，
//   10:00 浏览器精算补齐后才出现（用户切日期解冻定稿才看得到）。
// ============================================================================
describe('[R20-LEGS-PAGED] 逐日腿读取必须 Range 分页，⛔ 不许 limit 截断', () => {
  const pageCalls = [];
  function stubPaged(rows) {
    pageCalls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async function (url, opts) {
      const range = String((opts.headers && opts.headers.Range) || '0-999');
      const from = Number(range.split('-')[0]) || 0;
      const page = rows.slice(from, from + 1000);
      pageCalls.push({ url: url, range: range });
      return {
        ok: true,
        status: 200,
        json: async () => page,
        text: async () => JSON.stringify(page)
      };
    }));
  }

  it('★ 1200 行（>单页 1000）⇒ 全部读回，旧实现只会拿到 1000 行', async () => {
    const rows = Array.from({ length: 1200 }, function (_, i) {
      return { stock: '测试票', date: '2026-10-' + String((i % 28) + 1).padStart(2, '0'), pct: '+1.00' };
    });
    stubPaged(rows);
    const got = await readDailyLegsForStocks(ENV, '2026-09-01', '2026-11-10', ['测试票']);
    expect(got).toHaveLength(1200);
    expect(pageCalls).toHaveLength(2);
    expect(pageCalls[0].range).toBe('0-999');
    expect(pageCalls[1].range).toBe('1000-1999');
  });

  it('★ URL 里不再有 limit=1000，且带确定性 order（Range 分页前提）', async () => {
    stubPaged([{ stock: '测试票', date: '2026-11-09', pct: '+1.00' }]);
    await readDailyLegsForStocks(ENV, '2026-09-01', '2026-11-10', ['测试票']);
    expect(pageCalls[0].url).not.toContain('limit=1000');
    expect(pageCalls[0].url).toContain('order=stock.asc,date.asc');
  });

  it('★ 读取失败 ⇒ 抛错并带批次号（§10 不把读失败折成空数组）', async () => {
    vi.stubGlobal('fetch', vi.fn(async function () {
      return { ok: false, status: 500, text: async () => 'boom', json: async () => [] };
    }));
    await expect(readDailyLegsForStocks(ENV, '2026-09-01', '2026-11-10', ['测试票']))
      .rejects.toThrow(/第 1 批/);
  });

  it('★ readRange20StocksForDate 同样分页（「已有行不覆盖」的判据不能漏行）', async () => {
    const rows = Array.from({ length: 1200 }, function (_, i) {
      return { stock: '票' + i };
    });
    stubPaged(rows);
    const set = await readRange20StocksForDate(ENV, '2026-11-10');
    expect(set.size).toBe(1200);
    expect(pageCalls).toHaveLength(2);
  });
});
