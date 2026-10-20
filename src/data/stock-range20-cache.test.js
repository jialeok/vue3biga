// stock-range20-cache.test.js — 「20日涨幅」结果表 stock_range20_pct 的读写入口（加速层）
//
// 这组用例锁的是**正确性护栏**，不是性能数字。三条不可退让的判据：
//   ① `pickUsableRows` 必须按【当前口径】过滤：leg 不匹配 ≡「还没有」⇒ 触发重算。
//      漏掉这条 ⇒ 收盘后一直显示早上那份「前19收盘 × 今天竞价」的数（用户反馈过的现象）。
//   ② 读失败必须返回 null（⛔ 不 throw、⛔ 不写缓存）。
//      这是【加速层】：调用方见 null 就降级为纯内存计算（功能不受影响）。
//      ⚠️ 与 `stock-range-pct.js#readRangePctForDate` 刻意相反 —— 那边是真相源，失败必须 throw
//      （空 Map 会被误读成「这天没算过」⇒ 重复消耗猫抓额度）。⛔ 别"统一"两个语义。
//   ③ 写成功必须作废该日会话缓存（「写完立刻读」的调用者 —— 分批发布后落库就属这类）。

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

const {
    readRange20Rows, pickUsableRows, upsertRange20Rows, clearRange20Cache
} = await import('./stock-range20-cache.js');

function row(stock, pct, days, leg) {
    return { stock: stock, pct: pct === null ? null : String(pct), days: days || 20, leg: leg || 'close' };
}

beforeEach(function() {
    calls.length = 0;
    mode = 'ok';
    rowsByDate = {};
    selectGate = null;
    clearRange20Cache();
});

describe('stock-range20-cache · 解析（§10 不做 0）', function() {
    it('pct 是带 % / + 的字符串 ⇒ 数字；空值 ⇒ null（⛔ 不补 0）', async function() {
        rowsByDate['2026-10-19'] = [
            row('新华传媒', '+210.98'),
            row('某票', null),
            row('甲票', '86'),
        ];
        const m = await readRange20Rows('2026-10-19');
        expect(m.get('新华传媒').pct).toBe(210.98);
        expect(m.get('某票').pct).toBe(null);
        expect(m.get('甲票').pct).toBe(86);
        expect(m.get('新华传媒').days).toBe(20);
    });

    it('leg 缺列 ⇒ 按 close 处理（历史行没有 leg 也不会被误当 auc）', async function() {
        rowsByDate['2026-10-19'] = [{ stock: '甲票', pct: '10', days: 20 }];
        const m = await readRange20Rows('2026-10-19');
        expect(m.get('甲票').leg).toBe('close');
    });

    it('stock 为空 / 空白 ⇒ 丢弃（主键不能是空串）', async function() {
        rowsByDate['2026-10-19'] = [{ stock: '', pct: '10' }, { stock: '   ', pct: '12' }, row('甲票', '5')];
        const m = await readRange20Rows('2026-10-19');
        expect(m.size).toBe(1);
        expect(m.has('甲票')).toBe(true);
    });
});

describe('stock-range20-cache · ★ pickUsableRows 口径过滤（最关键）', function() {
    it('★★ 当前口径 auc ⇒ close 行必须被剔除（否则收盘后仍显示早上那份数）', async function() {
        rowsByDate['2026-10-19'] = [
            row('新华传媒', '210.98', 20, 'close'),
            row('澳弘电子', '42.70', 20, 'auc'),
        ];
        const m = await readRange20Rows('2026-10-19');
        const auc = pickUsableRows(m, 'auc');
        expect(auc.has('澳弘电子')).toBe(true);
        expect(auc.has('新华传媒')).toBe(false);
    });

    it('★★ 当前口径 close ⇒ auc 行必须被剔除（触发重算，拿真收盘）', async function() {
        rowsByDate['2026-10-19'] = [
            row('新华传媒', '210.98', 20, 'close'),
            row('澳弘电子', '42.70', 20, 'auc'),
        ];
        const m = await readRange20Rows('2026-10-19');
        const close = pickUsableRows(m, 'close');
        expect(close.has('新华传媒')).toBe(true);
        expect(close.has('澳弘电子')).toBe(false);
    });

    it('pct 为 null / NaN 的行 ⇒ 剔除（宁可重算，⛔ 不把 null 当结果发布）', function() {
        const src = new Map([
            ['甲票', { pct: null, days: 20, leg: 'close' }],
            ['乙票', { pct: NaN, days: 20, leg: 'close' }],
            ['丙票', { pct: 12.5, days: 20, leg: 'close' }],
        ]);
        const out = pickUsableRows(src, 'close');
        expect(out.size).toBe(1);
        expect(out.has('丙票')).toBe(true);
    });

    it('leg 非法/缺省 ⇒ 当 close 处理（保守：收盘口径是主用途）', function() {
        const src = new Map([['甲票', { pct: 10, days: 20, leg: 'close' }]]);
        expect(pickUsableRows(src, undefined).size).toBe(1);
        expect(pickUsableRows(src, 'whatever').size).toBe(1);
    });

    it('null / 空 Map 入参 ⇒ 空 Map（⛔ 不抛）', function() {
        expect(pickUsableRows(null, 'close').size).toBe(0);
        expect(pickUsableRows(new Map(), 'close').size).toBe(0);
    });

    it('输出只带 {pct, days}，不回传 leg（调用方不该再关心口径）', function() {
        const out = pickUsableRows(new Map([['甲票', { pct: 10, days: 20, leg: 'close' }]]), 'close');
        expect(out.get('甲票')).toEqual({ pct: 10, days: 20 });
    });
});

describe('stock-range20-cache · 失败语义（加速层 ≠ 真相源）', function() {
    it('★★ 读失败 ⇒ 返回 null（⛔ 不 throw）——调用方据此降级为纯内存计算', async function() {
        mode = 'fail';
        await expect(readRange20Rows('2026-10-19')).resolves.toBe(null);
    });

    it('★ 读失败 ⇒ 30s 冷却期内的再次读 0 请求（表还没建时别每次打开都白打一次 REST）', async function() {
        mode = 'fail';
        await readRange20Rows('2026-10-19');
        const before = calls.length;
        await readRange20Rows('2026-10-19');
        await readRange20Rows('2026-10-20');
        expect(calls.length).toBe(before);      // 冷却期内一条都不发
    });

    it('★★ 读失败 ⇒ ⛔ 不写缓存（冷却结束/重置后必须真的再请求一次拿真值）', async function() {
        mode = 'fail';
        await readRange20Rows('2026-10-19');
        mode = 'ok';
        rowsByDate['2026-10-19'] = [row('甲票', '5')];
        clearRange20Cache();                    // 等价于「冷却 30s 到了」
        const m = await readRange20Rows('2026-10-19');
        expect(m.get('甲票').pct).toBe(5);
        expect(calls.length).toBe(2);
    });

    it('写失败 ⇒ 返回 0、不抛（正确性不依赖落库）', async function() {
        mode = 'upsertfail';
        await expect(upsertRange20Rows('2026-10-19', [{ stock: '甲票', pct: 5, days: 20 }], 'close'))
            .resolves.toBe(0);
    });
});

describe('stock-range20-cache · §32 会话内缓存 + 单飞', function() {
    it('★ 同一天并发读 6 次 ⇒ 只发 1 个请求（主 toggle + 补位组件 + 多消费者同 tick 读）', async function() {
        rowsByDate['2026-10-19'] = [row('甲票', '5')];
        await Promise.all([
            readRange20Rows('2026-10-19'), readRange20Rows('2026-10-19'), readRange20Rows('2026-10-19'),
            readRange20Rows('2026-10-19'), readRange20Rows('2026-10-19'), readRange20Rows('2026-10-19'),
        ]);
        expect(calls.length).toBe(1);
    });

    it('命中缓存后不再请求', async function() {
        rowsByDate['2026-10-19'] = [row('甲票', '5')];
        await readRange20Rows('2026-10-19');
        await readRange20Rows('2026-10-19');
        expect(calls.length).toBe(1);
    });

    it('空日期入参 ⇒ 空 Map 且 0 请求（⛔ 别去打一个 date 为空串的 REST）', async function() {
        const m = await readRange20Rows('');
        expect(m.size).toBe(0);
        expect(calls.length).toBe(0);
    });
});

describe('stock-range20-cache · upsertRange20Rows', function() {
    it('按 (date,stock) upsert，pct 固定两位小数，leg 写本批口径', async function() {
        const n = await upsertRange20Rows('2026-10-19',
            [{ stock: '新华传媒', pct: 210.981, days: 20 }], 'close');
        expect(n).toBe(1);
        const c = calls[0];
        expect(c.table).toBe('stock_range20_pct');
        expect(c.op).toBe('upsert');
        expect(c.onConflict).toBe('date,stock');
        expect(c.payload[0]).toEqual({
            date: '2026-10-19', stock: '新华传媒', pct: '210.98', days: 20,
            leg: 'close', updated_at: expect.any(String)
        });
    });

    it('pct 为 null 的行 ⇒ 过滤掉（§10：残缺值落库会永久污染，宁可不写）', async function() {
        const n = await upsertRange20Rows('2026-10-19', [
            { stock: '甲票', pct: null, days: 20 },
            { stock: '乙票', pct: 8, days: 20 },
        ], 'close');
        expect(n).toBe(1);
        expect(calls[0].payload.length).toBe(1);
        expect(calls[0].payload[0].stock).toBe('乙票');
    });

    it('空清单 / 空日期 ⇒ 0 行 0 请求', async function() {
        expect(await upsertRange20Rows('', [{ stock: '甲票', pct: 1 }], 'close')).toBe(0);
        expect(await upsertRange20Rows('2026-10-19', [], 'close')).toBe(0);
        expect(calls.length).toBe(0);
    });

    it('★ 写成功后该日会话缓存作废 ⇒「写完立刻读」拿到新值而不是旧缓存', async function() {
        rowsByDate['2026-10-19'] = [row('甲票', '5')];
        await readRange20Rows('2026-10-19');                       // 先缓存一份旧的
        await upsertRange20Rows('2026-10-19', [{ stock: '甲票', pct: 99, days: 20 }], 'close');
        const m = await readRange20Rows('2026-10-19');
        expect(m.get('甲票').pct).toBe(99);
    });
});
