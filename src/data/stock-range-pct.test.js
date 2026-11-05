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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    return {
        getSupabase: function() { return { from: makeQuery }; },
        // [R10-SELF-HEAL] healTodayRangePct 用它拼 Authorization 头；测试里只要非空即可
        SUPABASE_ANON_KEY: 'test-anon-key'
    };
});
vi.mock('./api/numcat-proxy.js', function() {
    return { numcatApiPost: function() { return Promise.reject(new Error('不应被调用')); } };
});
vi.mock('./api/fuyao-proxy.js', function() {
    return {
        fuyaoApiGet: function() { return Promise.reject(new Error('不应被调用')); },
        tickerToThscode: function(c) { return c; },
        // [FUYAO-OFF] 本文件的用例全在「同花顺通道已停用」的前提下跑（真实现状），
        //   `fetchFuyaoDailyPctRange` 见 true 就立刻抛错 —— 正好锁住「一个请求都不发」。
        isFuyaoOff: function() { return true; }
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

// ===========================================================================
// [FUYAO-OFF 2026-10-30] 同花顺通道临时停用时的语义
//
// 现场：fuyao-proxy 到上游整条断掉（150s 不返回 / 546 / 502），而本函数有 6 处调用方
// **没传 requestTimeoutMs** ⇒ 单请求无超时，`range-fill` 一批 20 只 × 3 次重试 ⇒ 几十个
// 永久 pending 请求把标签页占满，用户表现为「点不动、切日期没反应」。
// ⇒ 通道关掉时必须**一个请求都不发**，并且**抛错**（⛔ 不返回空 Map：空 Map 会被上层
//   误读成「这些票本来就没涨幅」，而本文件头的红线就是「失败 ≠ 没有数据」）。
// ===========================================================================
describe('fetchFuyaoDailyPctRange · FUYAO-OFF', function() {
    it('通道停用 ⇒ 立刻抛错，且不产生任何网络请求', async function() {
        const before = calls.length;
        const { fetchFuyaoDailyPctRange } = await import('./stock-range-pct.js');
        await expect(
            fetchFuyaoDailyPctRange([{ stock: '甲', code: '600000' }], ['2026-10-20', '2026-10-21'])
        ).rejects.toThrow(/同花顺通道已临时停用/);
        expect(calls.length).toBe(before);   // 连 supabase 都没碰
    });

    it('通道停用是【明确抛错】而不是伪装成「没有腿」', async function() {
        const { fetchFuyaoDailyPctRange } = await import('./stock-range-pct.js');
        let caught = null;
        try {
            await fetchFuyaoDailyPctRange([{ stock: '甲', code: '600000' }], ['2026-10-20']);
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(Error);   // ⛔ 不能是 return new Map()
    });
});

// ===========================================================================
// [R10-SELF-HEAL 2026-11-05] 当天 stock_range_pct 为空 ⇒ 云端零上游自愈
//
// 这一步把「09:25 Edge cron 成功」从【硬依赖】降级成【优化】。事故链（用户第 8 次报障）：
//   cron 的 K 线主循环吃满 190s 预算 ⇒ 当天 stock_range_pct 0 行 ⇒ 前端读云端得空
//   ⇒ 补算又被 _inMorningGuard（09:00~09:45）整段挡下 ⇒ rangeMap 恒空
//   ⇒ collectDecisionTopics 返回「十日涨幅 / 龙头数据尚未加载完成」⇒ 题材量比看板一只票都不选。
// ===========================================================================
describe('healTodayRangePct · 当天云端为空的零上游自愈', function() {
    const REAL_FETCH = globalThis.fetch;

    function beijingToday() {
        return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }

    beforeEach(async function() {
        const m = await import('./stock-range-pct.js');
        m._resetHealTried();
    });

    afterEach(function() { globalThis.fetch = REAL_FETCH; });

    it('非当天 ⇒ 一个请求都不发（历史日的腿早已固化，回补是运维的活）', async function() {
        let hit = 0;
        globalThis.fetch = function() { hit++; return Promise.resolve({ ok: true, json: function() { return Promise.resolve({}); } }); };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const r = await healTodayRangePct('2026-10-12');
        expect(r.ok).toBe(false);
        expect(r.skipped).toMatch(/非当天/);
        expect(hit).toBe(0);
    });

    it('★ 当天 + 写入成功 ⇒ ok:true 且返回行数，并且【作废该日缓存】（否则写后读还是空 Map）', async function() {
        rowsByDate[beijingToday()] = [];
        await readRangePctForDate(beijingToday());          // 先读一次：缓存里存了「空」
        const before = calls.length;
        let url = '';
        globalThis.fetch = function(u) {
            url = u;
            return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ ok: true, range10: { written: 46 } }); } });
        };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const r = await healTodayRangePct(beijingToday());
        expect(r.ok).toBe(true);
        expect(r.written).toBe(46);
        expect(url).toContain('range10=1');                 // 必须是「只算 10 日涨幅」那个零上游入口
        expect(url).toContain('range20-cron-2026');
        // 缓存已作废 ⇒ 再读会真的发一次请求
        rowsByDate[beijingToday()] = [row('大晟文化', '23.31')];
        const m = await readRangePctForDate(beijingToday());
        expect(calls.length).toBeGreaterThan(before);
        expect(m.get('大晟文化').pct).toBe(23.31);
    });

    it('「竞价涨幅还没落库」属于【过几秒就好】⇒ 允许再试，但最多 3 次就不再打（§32）', async function() {
        let hit = 0;
        globalThis.fetch = function() {
            hit++;
            return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ range10: { written: 0, skipped: '当天 market_metrics 没有 auc_pct_chg（竞价涨幅未落库）' } }); } });
        };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        for (let i = 0; i < 3; i++) {
            const r = await healTodayRangePct(beijingToday());
            expect(r.ok).toBe(false);
            expect(r.skipped).toMatch(/竞价涨幅/);
        }
        // 第 4 次：次数用尽，一个请求都不再发
        const last = await healTodayRangePct(beijingToday());
        expect(last.ok).toBe(false);
        expect(last.skipped).toMatch(/已打过/);
        expect(hit).toBe(3);
    });

    it('「池子为空」这类结构性 0 行 ⇒ 一次用尽，⛔ 不重试', async function() {
        let hit = 0;
        globalThis.fetch = function() {
            hit++;
            return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ range10: { written: 0 } }); } });
        };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const a = await healTodayRangePct(beijingToday());
        expect(a.ok).toBe(false);
        const b = await healTodayRangePct(beijingToday());
        expect(b.skipped).toMatch(/已打过/);
        expect(hit).toBe(1);
    });

    it('网络层抛错 ⇒ 吞掉、返回 ok:false（⛔ 不能把「加载十日涨幅」整条链拖挂）', async function() {
        globalThis.fetch = function() { return Promise.reject(new Error('Failed to fetch')); };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const r = await healTodayRangePct(beijingToday());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Failed to fetch/);
    });

    it('HTTP 500 ⇒ 吞掉、返回 ok:false 并带状态码', async function() {
        globalThis.fetch = function() {
            return Promise.resolve({ ok: false, status: 500, text: function() { return Promise.resolve('boom'); } });
        };
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const r = await healTodayRangePct(beijingToday());
        expect(r.ok).toBe(false);
        expect(r.error).toBe('HTTP 500');
    });

    it('无日期 ⇒ 直接跳过（不抛错）', async function() {
        const { healTodayRangePct } = await import('./stock-range-pct.js');
        const r = await healTodayRangePct('');
        expect(r.ok).toBe(false);
        expect(r.skipped).toMatch(/无日期/);
    });
});
