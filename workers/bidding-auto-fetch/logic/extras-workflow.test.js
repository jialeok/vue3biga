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
import { runAuctionExtrasPatch } from './extras-workflow.js';
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
