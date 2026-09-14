// extras-workflow.test.js — 「竞价四要素补漏」的额度安全回归测试
//
// 【为什么必须有这个测试】
//   猫抓 daily_auc 对【当日】行永远不返回四要素（um_vol/open_bid_pct/auc_vol_ratio/auc_turnover），
//   要等这一天结算后才出现。所以把「今天」算进待补集合的唯一效果 = 每天白烧 1 次额度（日额度共 10 次），
//   而这件事【失败得非常安静】：返回值是 ok:true / patched:0，日志也只是一行 ℹ️，看不出任何异常。
//   2026-09-11 实测：16:00 close 补漏 patched=0，而当天 9/11 的四要素依旧 0/67 —— 就是这条静默浪费。
//   ⇒ 用测试把不变量钉死：默认（自动跑）绝不能为「今天」发任何请求。
//
//   如果哪天有人把 includeToday 的默认值改回 true、或删掉那句 filter，
//   下面第一个用例会立刻失败（因为 stub 的 fetch 会抛「不应发任何网络请求」）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { runAuctionExtrasPatch, runTodaySnapshotPatch } from './extras-workflow.js';
import { beijingToday } from '../../_shared-source/date-utils.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('runAuctionExtrasPatch 额度安全', () => {
  it('默认自动跑：待补窗口只剩「今天」时零请求返回（不烧额度）', async () => {
    const today = beijingToday();
    const calls = [];
    globalThis.fetch = (...args) => {
      calls.push(args[0]);
      throw new Error('不应发任何网络请求，实际请求了: ' + args[0]);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // env 故意传空对象：只要这个用例走到任何真实 IO，就一定会炸出来
    const r = await runAuctionExtrasPatch({}, { dates: [today] });

    expect(calls).toEqual([]);                       // 核心断言：零 IO
    expect(r.patched).toBe(0);
    expect(r.dates).toEqual([]);
    expect(r.reason).toBe('只剩当天');               // 走的是「提前返回」而不是「发请求后没补到」
    expect(String(r.logs.join('\n'))).toContain('零请求');
  });

  it('手动传 includeToday:true：保留「今天」在窗口内（排查用的逃生门）', async () => {
    const today = beijingToday();
    const urls = [];
    // 库内返回空数组 → 无缺口 → 读完就返回，不会去调猫抓
    globalThis.fetch = (url) => {
      urls.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    };

    const r = await runAuctionExtrasPatch({}, { dates: [today], includeToday: true });

    expect(r.dates).toContain(today);                // 今天没有被过滤掉
    expect(urls).toHaveLength(1);                    // 只读了 1 次库内现状
    expect(urls[0]).toContain('market_metrics');
    expect(urls.some(u => u.includes('numcat'))).toBe(false);  // 无缺口时不碰猫抓额度
  });

  it('读取库内失败必须抛错中断，绝不能被当成「全都缺」而整体覆盖（§10）', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await runAuctionExtrasPatch({}, { dates: ['2026-09-10'], includeToday: true });

    expect(r.ok).toBe(false);
    expect(r.patched).toBe(0);
    expect(String(r.logs.join('\n'))).toContain('中断');
    expect(String(r.error || '')).toContain('500');
  });
});

// ============================================================================
// [SNAPSHOT-EXTRAS 2026-09-14] 当日竞价字段补漏（同花顺快照）
//
// 【为什么必须有这个测试】9:25 早盘从猫抓拿不到【当天】的 auc_pct_chg / auc_vol_ratio /
//   auc_turnover，而 extras 补漏默认排除今天 → 这三个字段整天为空 → 看板趋势图竞价涨幅空缺、
//   龙一/龙二徽章掉色、竞价一字红线判不出（2026-09-14 实测事故）。
//   同花顺 auction/snapshot 能免费拿到当天终态值，但它是【滚动的最近交易日】——
//   一旦服务端日期 ≠ 目标日却仍写入，就会把上一交易日的数据写到今天（比缺字段更糟）。
//   下面用例把这几条不变量钉死。
// ============================================================================
describe('runTodaySnapshotPatch 当日竞价字段补漏（同花顺快照）', () => {
  const today = beijingToday();
  const tsToday = Date.parse(today + 'T10:00:00+08:00');

  function stub(routes) {
    globalThis.fetch = (url, init) => {
      const u = String(url);
      const m = (init && init.method) || 'GET';
      for (const r of routes) {
        if (r.test(u, m)) return Promise.resolve(r.res(u, init));
      }
      throw new Error('未预期的请求: ' + m + ' ' + u);
    };
  }
  const isSnap = (u) => decodeURIComponent(u).includes('auction/snapshot');
  const isMmGet = (u, m) => u.includes('/market_metrics') && m === 'GET';
  const isMmPost = (u, m) => u.includes('/market_metrics') && m === 'POST';

  it('库内已完整 → 只读一次，不发快照请求（零额外 IO）', async () => {
    let reads = 0;
    stub([{
      test: isMmGet,
      res: () => {
        reads++;
        return { ok: true, json: () => Promise.resolve([
          { stock: 'A', code: '000001', auc_pct_chg: '+1.00%', auc_vol_ratio: '1.00', auc_turnover: '1.00', volume: '10' }
        ]) };
      }
    }]);
    const r = await runTodaySnapshotPatch({}, { date: today });
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(0);
    expect(reads).toBe(1);
  });

  it('快照服务端日期 ≠ 目标日 → 拒绝写入（ok:false，不 POST）', async () => {
    let posted = false;
    stub([
      { test: isMmGet, res: () => ({ ok: true, json: () => Promise.resolve([
        { stock: 'A', code: '000001', auc_pct_chg: '', auc_vol_ratio: '', auc_turnover: '', volume: '10' }
      ]) }) },
      { test: isSnap, res: () => ({ ok: true, json: () => Promise.resolve({
        code: 0, data: { timestamp: tsToday - 86400000, auction_phase: 'closed', data_status: 'final', item: [] }
      }) }) },
      { test: isMmPost, res: () => { posted = true; return { ok: true, json: () => Promise.resolve([]) }; } }
    ]);
    const r = await runTodaySnapshotPatch({}, { date: today });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('日期不符');
    expect(posted).toBe(false);
  });

  it('日期相符 + final → 只写缺失字段（um_vol/open_bid_pct 绝不写入 §40）', async () => {
    let body = null;
    stub([
      { test: isMmGet, res: () => ({ ok: true, json: () => Promise.resolve([
        { stock: '桂林旅游', code: '000978', auc_pct_chg: '', auc_vol_ratio: '', auc_turnover: '', volume: '1925' }
      ]) }) },
      { test: isSnap, res: () => ({ ok: true, json: () => Promise.resolve({
        code: 0, data: {
          timestamp: tsToday, auction_phase: 'closed', data_status: 'final',
          item: [{ ticker: '000978', auction_pct: 4.6606, auction_volume_ratio: 2.4549, auction_turnover_pct: 4.1125, auction_volume: 192513.9, auction_unmatched: 22.1 }]
        }
      }) }) },
      { test: isMmPost, res: (u, init) => { body = JSON.parse(init.body); return { ok: true, json: () => Promise.resolve([]) }; } }
    ]);
    const r = await runTodaySnapshotPatch({}, { date: today });
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(1);
    expect(body).toHaveLength(1);
    expect(body[0].auc_pct_chg).toBe('+4.66%');
    expect(body[0].auc_vol_ratio).toBe('2.45');
    expect(body[0].auc_turnover).toBe('4.11');
    expect(body[0].um_vol).toBeUndefined();        // snapshot.auction_unmatched 语义不同源 → 不写
    expect(body[0].open_bid_pct).toBeUndefined();  // 无对应字段 → 不写
    expect(body[0].volume).toBeUndefined();        // 库内已有 → 不覆盖
  });

  it('读取库内失败 → 中断，绝不整体覆盖（§10）', async () => {
    stub([{ test: isMmGet, res: () => ({ ok: false, status: 500, text: () => Promise.resolve('boom') }) }]);
    const r = await runTodaySnapshotPatch({}, { date: today });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toContain('500');
  });
});
