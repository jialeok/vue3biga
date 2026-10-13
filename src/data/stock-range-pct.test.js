// stock-range-pct.test.js — 「近10日区间涨幅」缓存表的读写入口
//
// 重点锁【§32 会话内缓存 + 单飞】这条 2026-10-14 的性能修复：
//   实测一次「切换日期」有 6 个消费者各自读同一天 ——
//     useTopicVolRatioBoard（昨日，判退潮）/ dragon-rank-change-store（昨日，名次变化）/
//     dragon-rank#ensureDragonRangePct / dragon-group#DragonGroupForDate / limit-pool / yizi-board，
//   它们全在同一个 tick 发起，而本函数原先既不缓存也不单飞 ⇒ 同一天被打 6 次
//   （浏览器网络面板实测：stock_range_pct?date=2026-10-12 出现 6 次，其中 5 次结果逐字相同）。
//
// 同时锁住两条不可退让的口径：
//   ① 读取失败必须 throw（§10：⛔ 不许返回空 Map 伪装成「没有数据」——上层会误判为「需要重调接口」白烧额度）；
//   ② 写入成功必须让该日期的缓存作废（收盘覆盖链路是「upsert 完立刻 read」的调用者）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];
let mode = 'ok';
let rowsByDate = {};
let selectGate = null;      // 可选的「挂住」开关：返回一个手动 resolve 的 promise

function makeQuery(table) {
    const st = { table: table, op: '', eqVal: null, payload: null, onConflict: null };
    calls.push(st);
    const done = function() {
        if (st.op === 'upsert') {
            if (mode === 'upsertfail') return { data: null, error: { message: '写失败' } };
            rowsByDate[st.payload[0].date] = st.payload;
            return { data: null, error: null };
        }
        if (mode === 'fail') return { data: null, error: { message: '读取失败' } };
        return { data: (rowsByDate[st.eqVal] || []).slice(), error: null };
    };
    const b = {
        select: function() { st.op = 'select'; return b; },
        eq: function(col, val) { st.eqVal = val; return b; },
        upsert: function(p, o) { st.op = 'upsert'; st.payload = p; st.onConflict = o && o.onConflict; return b; },
        then: function(res, rej) {
            if (selectGate) { const g = selectGate; selectGate = null; return g.then(function() { return done(); }).then(res, rej); }
            return Promise.resolve(done()).then(res, rej);
        }
    };
    return b;
}

vi.mock('./supabase-client.js', function() {
    return { getSupabase: function() { return { from: makeQuery }; } };
});
vi.mock('./api/numcat-proxy.js', function() {
    return { numcatApiPost: function() { return Promise.reject(new Error('不应被调用')); } };
});
vi.mock('./api/fuyao-proxy.js', function() {
    return {
        fuyaoApiGet: function() { return Promise.reject(new Error('不应被调用')); },
        tickerToThscode: function(c) { return c; }
    };
});

const {
    readRangePctForDate, upsertRangePctRows, clearRangePctCache
} = await import('./stock-range-pct.js');

function row(stock, pct, days) {
    return { stock: stock, range_pct: pct === null ? null : String(pct), days: days || 10, updated_at: '' };
}

beforeEach(function() {
    calls.length = 0;
    mode = 'ok';
    rowsByDate = {};
    selectGate = null;
    clearRangePctCache();
});

describe('stock-range-pct · readRangePctForDate 解析', function() {
    it('range_pct 是带 % / + 的字符串 ⇒ 解析成数字；空值 ⇒ null（§10 不做 0）', async function() {
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51'), row('某票', null), row('甲票', '86')];
        const m = await readRangePctForDate('2026-10-12');
        expect(m.get('新华传媒').pct).toBe(159.51);
        expect(m.get('某票').pct).toBe(null);
        expect(m.get('甲票').pct).toBe(86);
        expect(m.get('新华传媒').days).toBe(10);
    });
});

describe('stock-range-pct · §32 会话内缓存 + 单飞（2026-10-14 性能修复）', function() {
    it('★ 同一天读 6 次 ⇒ 只发 1 个请求（原先每天被 6 个消费者各打一次）', async function() {
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51')];
        for (let i = 0; i < 6; i++) await readRangePctForDate('2026-10-12');
        expect(calls.length).toBe(1);
    });

    it('★ 并发读同一天 ⇒ 单飞（都拿到同一个 Map 引用）', async function() {
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51')];
        selectGate = new Promise(function(r) { setTimeout(r, 5); });
        const [a, b, c] = await Promise.all([
            readRangePctForDate('2026-10-12'),
            readRangePctForDate('2026-10-12'),
            readRangePctForDate('2026-10-12')
        ]);
        expect(calls.length).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('不同日期各自请求（缓存按日期分键）', async function() {
        rowsByDate['2026-10-12'] = [row('甲', '1')];
        rowsByDate['2026-10-13'] = [row('乙', '2')];
        await readRangePctForDate('2026-10-12');
        await readRangePctForDate('2026-10-13');
        expect(calls.length).toBe(2);
    });

    it('★ 缓存【不改变返回值语义】：命中缓存仍返回同一份内容', async function() {
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51')];
        const a = await readRangePctForDate('2026-10-12');
        const b = await readRangePctForDate('2026-10-12');
        expect(b.get('新华传媒').pct).toBe(159.51);
        expect(a).toBe(b);
    });

    it('空日期 ⇒ 空 Map，不发请求', async function() {
        expect((await readRangePctForDate('')).size).toBe(0);
        expect((await readRangePctForDate(null)).size).toBe(0);
        expect(calls.length).toBe(0);
    });
});

describe('stock-range-pct · §10 红线', function() {
    it('★ 读取失败必须 throw（⛔ 绝不返回空 Map 伪装成「没有数据」）', async function() {
        mode = 'fail';
        await expect(readRangePctForDate('2026-10-12')).rejects.toBeTruthy();
    });

    it('★ 失败【不写缓存】⇒ 下次还是真去读（一次失败不能被记成「这天没数据」）', async function() {
        mode = 'fail';
        await readRangePctForDate('2026-10-12').catch(function() {});
        mode = 'ok';
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51')];
        const m = await readRangePctForDate('2026-10-12');
        expect(m.get('新华传媒').pct).toBe(159.51);
    });
});

describe('stock-range-pct · upsertRangePctRows 与缓存失效', function() {
    it('写成功 ⇒ 该日期缓存作废（收盘覆盖链路 upsert 完立刻 read 必须拿到新值）', async function() {
        rowsByDate['2026-10-12'] = [row('新华传媒', '+159.51')];
        await readRangePctForDate('2026-10-12');               // 先把旧值读进缓存
        await upsertRangePctRows('2026-10-12', [{ stock: '新华传媒', pct: 12.34, days: 10 }]);
        const m = await readRangePctForDate('2026-10-12');     // 必须重新请求
        expect(m.get('新华传媒').pct).toBe(12.34);
        expect(calls.filter(function(c) { return c.op === 'select'; }).length).toBe(2);
    });

    it('写入按 (date,stock) upsert，pct 统一保留 2 位小数的文本口径（与库内既有形态一致）', async function() {
        await upsertRangePctRows('2026-10-12', [{ stock: '甲', pct: 12.3456, days: 10 }, { stock: '乙', pct: null, days: 3 }]);
        const c = calls[calls.length - 1];
        expect(c.op).toBe('upsert');
        expect(c.onConflict).toBe('date,stock');
        expect(c.payload[0].range_pct).toBe('12.35');
        expect(c.payload[1].range_pct).toBe(null);
    });

    it('写失败必须 throw（调用方要能看见）', async function() {
        mode = 'upsertfail';
        await expect(upsertRangePctRows('2026-10-12', [{ stock: '甲', pct: 1, days: 10 }])).rejects.toBeTruthy();
    });

    it('空 rows / 空 date ⇒ 0，不发请求', async function() {
        expect(await upsertRangePctRows('', [])).toBe(0);
        expect(await upsertRangePctRows('2026-10-12', [])).toBe(0);
        expect(calls.length).toBe(0);
    });
});
