/**
 * [TVRB-PLAN-SNAPSHOT 2026-11-11] 选股结论快照表 Data 层读写契约单测。
 *
 * 背景：用户「历史日期复盘为什么老是搞失踪」⇒ 结论必须按日落库，且历史日优先读存档。
 *
 * 本测试锁 5 条整类红线：
 *   ① 四态分明：hit / empty / unavailable(表不存在) / error(读失败)，⛔ 不许一律折成「没有存档」（§10）；
 *   ② 表不存在 / 读失败都不许伪装成「那天没选股」；读失败不缓存（下次可重试）；
 *   ③ 写入 ignoreDuplicates + onConflict=date ⇒ 先写的定稿永不被后写覆盖（用户硬口径）；
 *   ④ 已有存档不再发第二次写请求（§32），写失败不抛给调用方但留痕；
 *   ⑤ 同日并发读单飞，一天只查一次。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];
let mode = 'ok';       // 'ok' | 'missing' | 'readfail' | 'writefail'
let row = null;

function missingError() {
  return { code: 'PGRST205', message: "Could not find the table 'public.tvrb_plan_snapshot' in the schema cache" };
}

const sb = {
  from(table) {
    const st = { table: table, op: '', eqCol: '', eqVal: '', payload: null, opts: null };
    calls.push(st);
    const done = function() {
      if (st.op === 'upsert') {
        if (mode === 'missing') return { data: null, error: missingError() };
        if (mode === 'writefail') return { data: null, error: { message: '权限不足' } };
        row = {
          date: st.payload.date,
          plan: st.payload.plan,
          leg: st.payload.leg,
          source: st.payload.source,
          settled_at: st.payload.settled_at
        };
        return { data: null, error: null };
      }
      if (mode === 'missing') return { data: null, error: missingError() };
      if (mode === 'readfail') return { data: null, error: { message: '网络抖动' } };
      return { data: (row && row.date === st.eqVal) ? [Object.assign({}, row)] : [], error: null };
    };
    const b = {
      select: function() { st.op = 'select'; return b; },
      eq: function(c, v) { st.eqCol = c; st.eqVal = v; return b; },
      limit: function() { return b; },
      upsert: function(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return b; },
      then: function(res, rej) { return Promise.resolve(done()).then(res, rej); }
    };
    return b;
  }
};

vi.mock('./supabase-client.js', function() {
  return { getSupabase: function() { return sb; } };
});
vi.mock('./debug-log.js', function() {
  return { _dbgLog: function() {} };
});

const mod = await import('./tvrb-plan-snapshot.js');
const {
  PLAN_SNAPSHOT_TABLE, readPlanSnapshot, writePlanSnapshot,
  clearPlanSnapshotCache, _resetPlanSnapshotTableMissing
} = mod;

const D = '2026-11-10';

describe('tvrb-plan-snapshot · 定稿结论按日落库', function() {
  beforeEach(function() {
    mode = 'ok';
    row = null;
    calls.length = 0;
    clearPlanSnapshotCache();
    _resetPlanSnapshotTableMissing();
  });

  it('① 表名是唯一出处常量（⛔ 别在别处再写一次字符串）', function() {
    expect(PLAN_SNAPSHOT_TABLE).toBe('tvrb_plan_snapshot');
  });

  it('② 空表 ⇒ status=empty，且同一天只读一次（会话缓存）', async function() {
    expect((await readPlanSnapshot(D)).status).toBe('empty');
    expect((await readPlanSnapshot(D)).status).toBe('empty');
    expect(calls.filter(function(c) { return c.op === 'select'; })).toHaveLength(1);
  });

  it('③ 有存档 ⇒ status=hit，原样带回 row 供 Logic 层解码', async function() {
    row = { date: D, plan: { blocks: [], buy: {} }, leg: 'auc', source: 'tvrb-board', settled_at: '2026-11-10T01:25:40Z' };
    const r = await readPlanSnapshot(D);
    expect(r.status).toBe('hit');
    expect(r.row.plan).toEqual({ blocks: [], buy: {} });
    expect(r.row.settled_at).toBe('2026-11-10T01:25:40Z');
    expect(calls[0].eqVal).toBe(D);
    expect(calls[0].table).toBe('tvrb_plan_snapshot');
  });

  it('④ 表不存在 ⇒ unavailable，且本会话不再重试（§32）', async function() {
    mode = 'missing';
    const r = await readPlanSnapshot(D);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('table-missing');
    expect((await readPlanSnapshot(D)).status).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('⑤ 🔴 读失败 ⇒ error 且【不缓存】（§10：读失败 ≠ 没有存档）', async function() {
    mode = 'readfail';
    const r = await readPlanSnapshot(D);
    expect(r.status).toBe('error');
    expect(r.reason).toContain('网络抖动');
    mode = 'ok';
    row = { date: D, plan: { blocks: [] }, leg: 'auc', source: 'tvrb-board', settled_at: 'x' };
    expect((await readPlanSnapshot(D)).status).toBe('hit');   // 第二次真的重读了
    expect(calls).toHaveLength(2);
  });

  it('⑥ 同日并发读单飞 ⇒ 只发一次请求', async function() {
    const pair = await Promise.all([readPlanSnapshot(D), readPlanSnapshot(D)]);
    expect(pair[0].status).toBe('empty');
    expect(pair[1].status).toBe('empty');
    expect(calls).toHaveLength(1);
  });

  it('⑦ 🔴 写入必须 ignoreDuplicates + onConflict=date（先写的定稿不被覆盖）', async function() {
    const ok = await writePlanSnapshot('2026-11-11', { blocks: [], buy: {}, notes: [], pickCount: 1 });
    expect(ok).toBe(true);
    const w = calls.filter(function(c) { return c.op === 'upsert'; })[0];
    expect(w.opts).toEqual({ onConflict: 'date', ignoreDuplicates: true });
    expect(w.payload.date).toBe('2026-11-11');
    expect(w.payload.leg).toBe('auc');
    expect(w.payload.source).toBe('tvrb-board');
    expect(w.payload.plan).toEqual({ blocks: [], buy: {}, notes: [], pickCount: 1 });
    expect(typeof w.payload.settled_at).toBe('string');
  });

  it('⑧ 已有存档 ⇒ 不再发第二次写（一天一行、只写一次）', async function() {
    expect(await writePlanSnapshot('2026-11-11', { a: 1 })).toBe(true);
    expect(await writePlanSnapshot('2026-11-11', { a: 2 })).toBe(false);
    expect(calls.filter(function(c) { return c.op === 'upsert'; })).toHaveLength(1);
  });

  it('⑨ 写失败 / 表不存在 ⇒ 返回 false 且【不抛】给调用方（展示不该被存档拖垮）', async function() {
    mode = 'writefail';
    expect(await writePlanSnapshot('2026-11-11', { a: 1 })).toBe(false);
    _resetPlanSnapshotTableMissing();
    mode = 'missing';
    expect(await writePlanSnapshot('2026-11-12', { a: 1 })).toBe(false);
  });

  it('⑩ 非法入参直接跳过，不发请求', async function() {
    expect(await writePlanSnapshot('', { a: 1 })).toBe(false);
    expect(await writePlanSnapshot('2026-11-11', null)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('⑪ 写成功后当天再读 ⇒ 立刻命中会话缓存里的那一份', async function() {
    await writePlanSnapshot('2026-11-11', { blocks: [], pickCount: 1 });
    const r = await readPlanSnapshot('2026-11-11');
    expect(r.status).toBe('hit');
    expect(r.row.plan).toEqual({ blocks: [], pickCount: 1 });
    expect(calls.filter(function(c) { return c.op === 'select'; })).toHaveLength(0);
  });
});
