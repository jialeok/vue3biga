// presence-recompute.test.js — [PRESENCE-0926 2026-11-16] 云端在 09:26 触发在列次数重算
//
// 这条闸门的唯一职责：让 `auction_presence`（第二十九条的必需输入）在 **09:27 定稿之前**就位。
// 它原来只由 pg_cron 在 09:30 生成 ⇒ 定稿时恒缺 ⇒ 第二十九条 每天被 §10 放行 ⇒ 收盘后重算翻脸。
// 三条红线：
//   ① 成功时把 RPC 返回的行数如实带出来（留痕，便于事后核对是不是真空算了一次）；
//   ② **失败绝不抛错**（这是派生表，正确性不依赖它；抛了会把 09:26 那一整趟 ladder26 拖挂）；
//   ③ 失败必须写进 logs（§10 禁止静默失败）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPresenceRecompute } from './presence-recompute.js';

const ENV = { SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: 'k' };

describe('[PRESENCE-0926] runPresenceRecompute', () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('① 成功 ⇒ ok + rows（RPC 直接回整数）+ 日志里写明「必须在 09:27 定稿前就位」', async () => {
    const calls = [];
    globalThis.fetch = async function(url, opts) {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async function() { return '403'; } };
    };
    const logs = [];
    const r = await runPresenceRecompute(ENV, { date: '2026-11-16', logs: logs });
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(403);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://demo.supabase.co/rest/v1/rpc/recompute_auction_presence');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ p_date: '2026-11-16' });
    expect(logs.join('\n')).toContain('09:27 定稿前就位');
  });

  it('② HTTP 非 2xx ⇒ ok=false、rows=0，且【不抛错】（不许拖挂 ladder26）', async () => {
    globalThis.fetch = async function() {
      return { ok: false, status: 404, text: async function() { return 'function not found'; } };
    };
    const logs = [];
    const r = await runPresenceRecompute(ENV, { date: '2026-11-16', logs: logs });
    expect(r.ok).toBe(false);
    expect(r.rows).toBe(0);
    expect(logs.join('\n')).toContain('404');
  });

  it('③ 网络异常 ⇒ ok=false 且不抛错（§10：失败必须可见、不许炸整趟）', async () => {
    globalThis.fetch = async function() { throw new Error('ETIMEDOUT'); };
    const logs = [];
    const r = await runPresenceRecompute(ENV, { date: '2026-11-16', logs: logs });
    expect(r.ok).toBe(false);
    expect(logs.join('\n')).toContain('ETIMEDOUT');
  });

  it('④ 不传 date ⇒ body 里 p_date 为 null（由库内函数自己算北京今天）', async () => {
    let body = null;
    globalThis.fetch = async function(url, opts) {
      body = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async function() { return '0'; } };
    };
    await runPresenceRecompute(ENV, {});
    expect(body).toEqual({ p_date: null });
  });

  it('⑤ SUPABASE_URL 尾部带斜杠也要拼对（不许出现 //rest/v1）', async () => {
    let seen = '';
    globalThis.fetch = async function(url) {
      seen = url;
      return { ok: true, status: 200, text: async function() { return '1'; } };
    };
    const r = await runPresenceRecompute({ SUPABASE_URL: 'https://demo.supabase.co/', SUPABASE_ANON_KEY: 'k' }, {});
    expect(r.ok).toBe(true);
    expect(seen).toBe('https://demo.supabase.co/rest/v1/rpc/recompute_auction_presence');
  });
});
