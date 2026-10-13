// ebb-days.test.js — 「退潮判定表」tvrb_ebb_days 读写入口的单元测试
//
// 背景（用户 2026-10-14 原话）：
//   「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断没有竞价量等
//     判断出来的，是缓存吧？你要完善这点」
// ⇒ 把每天算出的退潮判定落库，次日判「是不是首日」直接读那一行（见 topic-vol-ratio-rules#_prevLeaderDayState）。
//
// 本测试锁 5 件事，任何一条被打回都说明红线被改坏了：
//   ① 同一批日期在会话内只请求一次（§32）—— 加缓存前，一天最多被打 6 次；
//   ② 表还不存在（部署前置）⇒ 本会话不再重试、返回空 Map 走退路（不是抛错、也不是静默）；
//   ③ 读取失败（不是「表不存在」）⇒ 必须 throw（§10：⛔ 不许伪装成「那天没记录」）；
//   ④ upsert 的列与 _normalize 的键逐字对应，且写成功后会同步会话缓存；
//   ⑤ 写失败【不抛给调用方】也不阻断看板，但必须留痕后返回 false。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Supabase 假客户端（只覆盖本模块用到的那两种调用形状）──────────────────────────────
const calls = [];
let mode = 'ok';          // 'ok' | 'missing' | 'fail' | 'writefail'
let rowsByDate = {};

function _missingError() {
    return { code: 'PGRST205', message: "Could not find the table 'public.tvrb_ebb_days' in the schema cache" };
}

const sb = {
    from(table) {
        const st = { table: table, op: '', inVal: null, payload: null, onConflict: null };
        calls.push(st);
        const done = function() {
            if (st.op === 'upsert') {
                if (mode === 'missing') return { data: null, error: _missingError() };
                if (mode === 'writefail') return { data: null, error: { message: '权限不足' } };
                rowsByDate[st.payload.date] = st.payload;
                return { data: null, error: null };
            }
            if (mode === 'missing') return { data: null, error: _missingError() };
            if (mode === 'fail') return { data: null, error: { message: '网络抖动' } };
            const want = st.inVal || [];
            const data = want.filter(function(d) { return !!rowsByDate[d]; })
                .map(function(d) { return Object.assign({}, rowsByDate[d]); });
            return { data: data, error: null };
        };
        const b = {
            select: function() { st.op = 'select'; return b; },
            eq: function() { return b; },
            in: function(col, vals) { st.op = 'select'; st.inVal = vals; return b; },
            upsert: function(p, o) { st.op = 'upsert'; st.payload = p; st.onConflict = o && o.onConflict; return b; },
            then: function(res, rej) { return Promise.resolve(done()).then(res, rej); }
        };
        return b;
    }
};

vi.mock('./supabase-client.js', function() {
    return { getSupabase: function() { return sb; } };
});

const mod = await import('./ebb-days.js');
const {
    EBB_DAYS_TABLE, readEbbDays, upsertEbbDay,
    clearEbbDaysCache, _resetEbbDaysTableMissing
} = mod;

/** 造一条「库里那一行」（snake_case，与建表 SQL 一致） */
function dbRow(date, over) {
    return Object.assign({
        date: date,
        leader_stock: '新华传媒',
        leader_topic: 'AI应用',
        leader_pct: 159.51,
        leader_rank: 1,
        suspended: true,
        share: 1.2,
        share_fail: false,
        ebb: true,
        buy_second: '九阳股份',
        buy_second_pct: 86,
        source: 'tvrb-board',
        updated_at: '2026-10-14T01:30:00.000Z'
    }, over || {});
}

beforeEach(function() {
    calls.length = 0;
    mode = 'ok';
    rowsByDate = {};
    clearEbbDaysCache();
    _resetEbbDaysTableMissing();
});

describe('ebb-days · 表名与列口径', function() {
    it('表名是 tvrb_ebb_days（唯一出处，建表 SQL 与代码都从这里对）', function() {
        expect(EBB_DAYS_TABLE).toBe('tvrb_ebb_days');
    });
});

describe('ebb-days · readEbbDays（§32 会话内缓存 + 单飞）', function() {
    it('一次读多天：只发一次请求，且按 date 建索引（没记录的日期不建键）', async function() {
        rowsByDate['2026-10-13'] = dbRow('2026-10-13');
        const m = await readEbbDays(['2026-10-13', '2026-10-12']);
        expect(calls.filter(function(c) { return c.op === 'select'; }).length).toBe(1);
        expect(m.get('2026-10-13').leaderStock).toBe('新华传媒');
        expect(m.get('2026-10-13').suspended).toBe(true);
        expect(m.get('2026-10-13').leaderPct).toBe(159.51);
        expect(m.get('2026-10-13').buySecond).toBe('九阳股份');
        expect(m.get('2026-10-13').buySecondPct).toBe(86);
        expect(m.has('2026-10-12')).toBe(false);   // 那天没有记录 ⇒ 不放键
    });

    it('★ 同一天第二次读 ⇒ 命中会话缓存，0 个新请求（这是加缓存的理由）', async function() {
        rowsByDate['2026-10-12'] = dbRow('2026-10-12');
        await readEbbDays(['2026-10-12']);
        const n1 = calls.filter(function(c) { return c.op === 'select'; }).length;
        await readEbbDays(['2026-10-12']);
        const n2 = calls.filter(function(c) { return c.op === 'select'; }).length;
        expect(n1).toBe(1);
        expect(n2).toBe(1);                        // 没涨
    });

    it('★ 并发读同一批 ⇒ 单飞（两次调用只产生一个请求）', async function() {
        rowsByDate['2026-10-12'] = dbRow('2026-10-12');
        await Promise.all([readEbbDays(['2026-10-12']), readEbbDays(['2026-10-12'])]);
        expect(calls.filter(function(c) { return c.op === 'select'; }).length).toBe(1);
    });

    it('「那天确实没记录」也会被记住 ⇒ 不再白查一遍', async function() {
        await readEbbDays(['2026-10-12']);
        await readEbbDays(['2026-10-12']);
        expect(calls.filter(function(c) { return c.op === 'select'; }).length).toBe(1);
    });

    it('空入参 / 全是空串 ⇒ 不发请求', async function() {
        await readEbbDays([]);
        await readEbbDays(['', null, undefined]);
        expect(calls.length).toBe(0);
    });
});

describe('ebb-days · 表不存在（部署前置）的降级', function() {
    it('★ 表不存在 ⇒ 返回空 Map（不抛错），且本会话不再重复请求不存在的表', async function() {
        mode = 'missing';
        const m1 = await readEbbDays(['2026-10-13']);
        expect(m1.size).toBe(0);
        expect(calls.length).toBe(1);
        const m2 = await readEbbDays(['2026-10-11']);   // 另一个日期
        expect(m2.size).toBe(0);
        expect(calls.length).toBe(1);                    // ⛔ 不再发请求
    });

    it('★ 表不存在时 upsert ⇒ 返回 false，且同样不再重试', async function() {
        mode = 'missing';
        const ok = await upsertEbbDay({ date: '2026-10-13', leaderStock: '甲一' });
        expect(ok).toBe(false);
        const n = calls.length;
        await upsertEbbDay({ date: '2026-10-13', leaderStock: '甲一' });
        expect(calls.length).toBe(n);
    });
});

describe('ebb-days · §10 读取失败必须可见', function() {
    it('读取失败（非「表不存在」）⇒ 抛错（⛔ 不许伪装成「那天没退潮」）', async function() {
        mode = 'fail';
        await expect(readEbbDays(['2026-10-13'])).rejects.toBeTruthy();
    });

    it('失败【不写缓存】⇒ 下次还会重试（一次失败不能被记成「这天没数据」）', async function() {
        mode = 'fail';
        await readEbbDays(['2026-10-13']).catch(function() {});
        mode = 'ok';
        rowsByDate['2026-10-13'] = dbRow('2026-10-13');
        const m = await readEbbDays(['2026-10-13']);
        expect(m.get('2026-10-13').leaderStock).toBe('新华传媒');
    });
});

describe('ebb-days · upsertEbbDay', function() {
    it('列名与业务键逐字对应，onConflict = date（幂等覆盖同一天）', async function() {
        const ok = await upsertEbbDay({
            date: '2026-10-13',
            leaderStock: '新华传媒', leaderTopic: 'AI应用', leaderPct: 159.51, leaderRank: 1,
            suspended: true, share: 1.2, shareFail: false, ebb: true,
            buySecond: '九阳股份', buySecondPct: 86
        });
        expect(ok).toBe(true);
        const c = calls[calls.length - 1];
        expect(c.op).toBe('upsert');
        expect(c.onConflict).toBe('date');
        expect(c.payload.leader_stock).toBe('新华传媒');
        expect(c.payload.leader_pct).toBe(159.51);
        expect(c.payload.suspended).toBe(true);
        expect(c.payload.share_fail).toBe(false);
        expect(c.payload.ebb).toBe(true);
        expect(c.payload.buy_second).toBe('九阳股份');
        expect(c.payload.buy_second_pct).toBe(86);
        expect(c.payload.source).toBe('tvrb-board');
        expect(typeof c.payload.updated_at).toBe('string');
    });

    it('缺字段 ⇒ 写 null / false（⛔ 绝不写 0 冒充「没有」）', async function() {
        await upsertEbbDay({ date: '2026-10-13', leaderStock: '甲一' });
        const p = calls[calls.length - 1].payload;
        expect(p.leader_topic).toBe(null);
        expect(p.leader_pct).toBe(null);
        expect(p.share).toBe(null);
        expect(p.buy_second).toBe(null);
        expect(p.buy_second_pct).toBe(null);
        expect(p.suspended).toBe(false);
        expect(p.ebb).toBe(false);
    });

    it('★ 写成功后会话缓存同步 ⇒ 紧接着读该日 0 请求', async function() {
        await upsertEbbDay({ date: '2026-10-13', leaderStock: '甲一', ebb: true });
        const n = calls.length;
        const m = await readEbbDays(['2026-10-13']);
        expect(calls.length).toBe(n);
        expect(m.get('2026-10-13').leaderStock).toBe('甲一');
        expect(m.get('2026-10-13').ebb).toBe(true);
    });

    it('§10：写失败【不抛】给调用方（落库是给明天用的，不该让今天的看板失败），如实返回 false', async function() {
        mode = 'writefail';
        const ok = await upsertEbbDay({ date: '2026-10-13', leaderStock: '甲一' });
        expect(ok).toBe(false);
    });

    it('缺 date ⇒ 直接 false，不发请求（§10 不猜）', async function() {
        expect(await upsertEbbDay(null)).toBe(false);
        expect(await upsertEbbDay({})).toBe(false);
        expect(calls.length).toBe(0);
    });
});
