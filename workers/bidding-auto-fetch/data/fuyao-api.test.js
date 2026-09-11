// fuyao-api.test.js — 「区间涨幅缺腿行 · 同花顺 K 线通道」回归测试
//
// 【为什么必须有这个测试】
//   猫抓 daily 每天只有 10 次额度，16:00 收盘时经常已被白天用尽 → 区间涨幅整段重算拿不到窗口
//   → 只能退化为「只换 T 腿」，而缺腿行（days < 窗口）【绝不能】换腿（代数反解必然更错）。
//   结果就是缺腿行的错值长期冻结（2026-09-11 实测 7 只，国芳集团 91.11%）。
//   本通道是缺腿行唯一的修复路径（无额度限制），所以它的口径必须被钉死：
//     · 前复权（不复权在除权日会假暴跌）；
//     · date_ms 是北京时间午夜 → 必须 +8h 才是正确交易日（否则整段错位一天）；
//     · 窗口首日需要「上一交易日收盘价」→ 起始必须早于窗口首日；
//     · 覆盖不足要重试（上游并发下会返回被截断的少数 K 线）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchFuyaoKlineWindowPct } from './fuyao-api.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// env 只需一个 key（fuyaoProxyGet 取 SERVICE_ROLE_KEY || ANON_KEY）
const ENV = { SUPABASE_ANON_KEY: 'test-key' };

/** 构造 fuyao historical 响应：rows = [{ ymd:'YYYYMMDD', close:number }] */
function histResp(rows) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      code: 0,
      data: {
        item: rows.map(r => ({
          // date_ms = 北京时间午夜（必须与真实上游一致，才能验证 +8h 换算）
          date_ms: Date.parse(
            r.ymd.slice(0, 4) + '-' + r.ymd.slice(4, 6) + '-' + r.ymd.slice(6, 8) + 'T00:00:00+08:00'
          ),
          close_price: String(r.close)
        }))
      }
    })
  };
}

/** 按 thscode 路由的 fetch 桩，记录所有请求 URL */
function stubFetch(byThscode) {
  const urls = [];
  globalThis.fetch = (url) => {
    const s = String(url);
    urls.push(s);
    const m = /thscode=([^&]+)/.exec(s);
    const thscode = m ? decodeURIComponent(m[1]) : '';
    const rows = byThscode[thscode];
    if (rows === undefined) return Promise.resolve(histResp([]));
    return Promise.resolve(histResp(rows));
  };
  return urls;
}

describe('fetchFuyaoKlineWindowPct', () => {
  it('按收盘价算窗口日涨幅，date_ms 是北京午夜 → +8h 后日期不偏移', async () => {
    // 9/9 收 10 → 9/10 收 11（+10%）→ 9/11 收 12.1（+10%）
    const urls = stubFetch({
      '600000.SH': [
        { ymd: '20260909', close: 10 },
        { ymd: '20260910', close: 11 },
        { ymd: '20260911', close: 12.1 }
      ]
    });

    const got = await fetchFuyaoKlineWindowPct(ENV, [{ name: '测试股', code: '600000' }],
      ['2026-09-10', '2026-09-11'], { concurrency: 3 });

    const dm = got.get('测试股');
    expect(dm).toBeTruthy();
    // 关键：9/10、9/11 都必须命中（若 +8h 漏了，键会整体错位到 9/9、9/10）
    expect(dm.get('20260910')).toBeCloseTo(10, 6);
    expect(dm.get('20260911')).toBeCloseTo(10, 6);
    expect(dm.has('20260909')).toBe(false); // 窗口外不返回
    // 必须前复权（不复权在除权除息日会算出假暴跌）
    expect(urls[0]).toContain('adjust=forward');
    expect(urls[0]).toContain('interval=1d');
  });

  it('北交所 920 号段必须映射到 .BJ（否则 K 线恒空）', async () => {
    const urls = stubFetch({ '920895.BJ': [{ ymd: '20260910', close: 5 }, { ymd: '20260911', close: 5.5 }] });
    const got = await fetchFuyaoKlineWindowPct(ENV, [{ name: '花溪科技', code: '920895' }],
      ['2026-09-10', '2026-09-11']);
    expect(urls[0]).toContain('thscode=920895.BJ');
    expect(got.get('花溪科技').get('20260911')).toBeCloseTo(10, 6);
  });

  it('窗口覆盖不足时重试（上游并发下会返回被截断的少数 K 线）', async () => {
    let n = 0;
    globalThis.fetch = () => {
      n++;
      // 前两次缺 9/9（→ 只能算出 1 天，覆盖不足），第三次给全 3 根（→ 覆盖整个窗口）
      return Promise.resolve(histResp(n < 3
        ? [{ ymd: '20260910', close: 10 }, { ymd: '20260911', close: 11 }]
        : [{ ymd: '20260909', close: 9 }, { ymd: '20260910', close: 10 }, { ymd: '20260911', close: 11 }]));
    };
    const got = await fetchFuyaoKlineWindowPct(ENV, [{ name: 'A', code: '600000' }],
      ['2026-09-10', '2026-09-11']);
    expect(n).toBe(3);                                  // 覆盖不足 → 重试
    expect(got.get('A').size).toBe(2);                  // 最终拿到完整窗口
  });

  it('完全取不到（代码错/长期停牌）：不进结果、不抛错、也不无谓重试', async () => {
    let n = 0;
    globalThis.fetch = () => { n++; return Promise.resolve(histResp([])); };
    const got = await fetchFuyaoKlineWindowPct(ENV, [{ name: '坏码', code: '999999' }],
      ['2026-09-10', '2026-09-11']);
    expect(got.size).toBe(0);
    expect(n).toBe(1); // 0 根 → 立刻放弃（重试不会改变结果）
  });

  it('熔断：连续多只取不到完整窗口 → 停止剩余请求（§36 不靠无限重试掩盖上游缺陷）', async () => {
    const urls = stubFetch({}); // 所有代码都返回空
    const items = [];
    for (let i = 1; i <= 7; i++) items.push({ name: 'S' + i, code: '60000' + i });
    await fetchFuyaoKlineWindowPct(ENV, items, ['2026-09-10', '2026-09-11'], { concurrency: 3 });
    // 熔断阈值 6：第 7 只不应再发请求（6 只 × 1 次 = 6）
    expect(urls).toHaveLength(6);
    expect(urls.some(u => u.includes('600007'))).toBe(false);
  });

  it('空输入直接返回空（不发任何请求）', async () => {
    const urls = stubFetch({});
    expect((await fetchFuyaoKlineWindowPct(ENV, [], ['2026-09-11'])).size).toBe(0);
    expect((await fetchFuyaoKlineWindowPct(ENV, [{ name: 'A', code: '600000' }], [])).size).toBe(0);
    expect(urls).toEqual([]);
  });
});
