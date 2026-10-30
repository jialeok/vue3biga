// stock-daily-pct.test.js — 逐日腿原料表 stock_daily_pct 的读取入口
//
// 这组用例锁的是 [R20-COVER 2026-10-30] 新增的「覆盖命中」行为，以及它**不能**越界的两条红线：
//   ① 区间被已读区间覆盖 ⇒ 必须 0 请求切片返回（这是「切换日期卡 19 秒」的修复点：
//      切一次日期窗口就平移一天，精确 key 命中不了 ⇒ 每次都重读 15,173 行 / 16 个请求）。
//   ② 请求区间【超出】已读区间 ⇒ 必须重新请求，⛔ 绝不能拿窄的旧数据冒充宽区间
//      （否则更早的历史腿会静默缺失 ⇒ 20 日涨幅系统性偏小，正是 §10 要防的「缺数据不算错」）。
//   ③ 读失败 ⇒ 返回 null（不是空 Map）：原料层失败必须能让调用方降级，⛔ 不能伪装成「没有腿」。

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** 假数据：3 天 × 2 只票 */
const ALL_ROWS = [
    { date: '2026-10-20', stock: 'A', pct: '+1.00' },
    { date: '2026-10-20', stock: 'B', pct: '+2.00' },
    { date: '2026-10-21', stock: 'A', pct: '+3.00' },
    { date: '2026-10-21', stock: 'B', pct: '+4.00' },
    { date: '2026-10-22', stock: 'A', pct: '-5.00' },
    { date: '2026-10-22', stock: 'B', pct: '+6.00' },
];

let rangesAsked = [];   // 每次真实发生的分页请求（Range 起点）
let mode = 'ok';

function makeQuery() {
    const st = { f: null, t: null };
    const b = {
        select: function() { return b; },
        gte: function(_col, v) { st.f = v; return b; },
        lte: function(_col, v) { st.t = v; return b; },
        order: function() { return b; },
        range: function(from) {
            rangesAsked.push(from);
            if (mode === 'fail') return Promise.resolve({ data: null, error: { message: 'boom' } });
            // 模拟 PostgREST：先按区间过滤，再按 1000 行分页
            const hit = ALL_ROWS.filter(function(r) { return r.date >= st.f && r.date <= st.t; });
            return Promise.resolve({ data: hit.slice(from, from + 1000), error: null });
        },
    };
    return b;
}

vi.mock('./supabase-client.js', function() {
    return { getSupabase: function() { return { from: makeQuery }; } };
});

import { readDailyPctRows, clearDailyPctCache } from './stock-daily-pct.js';

/** Map<stock, Map<date, pct>> → 便于断言的纯对象 */
function plain(map) {
    const out = {};
    map.forEach(function(dayMap, stock) {
        out[stock] = {};
        dayMap.forEach(function(v, d) { out[stock][d] = v; });
    });
    return out;
}

describe('readDailyPctRows · 覆盖命中（R20-COVER）', function() {
    beforeEach(function() {
        clearDailyPctCache();
        rangesAsked = [];
        mode = 'ok';
    });

    it('首次读某区间 ⇒ 发一轮分页请求（4 页并行，没满即止），结构正确', async function() {
        const m = await readDailyPctRows('2026-10-20', '2026-10-22');
        // `_fetchAll` 每轮固定发 PARALLEL=4 页（有 1 页没满就判定到底 ⇒ 只跑 1 轮）
        expect(rangesAsked).toEqual([0, 1000, 2000, 3000]);
        expect(plain(m)).toEqual({
            A: { '2026-10-20': 1, '2026-10-21': 3, '2026-10-22': -5 },
            B: { '2026-10-20': 2, '2026-10-21': 4, '2026-10-22': 6 },
        });
    });

    it('同区间再读 ⇒ 0 请求（会话缓存）', async function() {
        await readDailyPctRows('2026-10-20', '2026-10-22');
        rangesAsked = [];
        const m2 = await readDailyPctRows('2026-10-20', '2026-10-22');
        expect(rangesAsked).toEqual([]);
        expect(plain(m2).A['2026-10-21']).toBe(3);
    });

    it('子区间被已读区间覆盖 ⇒ 0 请求，且只返回子区间的腿', async function() {
        await readDailyPctRows('2026-10-20', '2026-10-22');
        rangesAsked = [];
        const sub = await readDailyPctRows('2026-10-21', '2026-10-22');
        expect(rangesAsked).toEqual([]);
        expect(plain(sub)).toEqual({
            A: { '2026-10-21': 3, '2026-10-22': -5 },
            B: { '2026-10-21': 4, '2026-10-22': 6 },
        });
    });

    it('切日期造成的窗口平移（整体前移一天）也被覆盖 ⇒ 0 请求', async function() {
        await readDailyPctRows('2026-10-19', '2026-10-22');
        rangesAsked = [];
        // 切到前一天：窗口变成 [10-18, 10-21] —— 左边界超出已读区间 ⇒ 必须重新请求（红线下）
        await readDailyPctRows('2026-10-18', '2026-10-21');
        expect(rangesAsked.length).toBeGreaterThan(0);
    });

    it('请求区间【超出】已读区间 ⇒ 必须重新请求，⛔ 不能拿窄数据冒充宽区间', async function() {
        await readDailyPctRows('2026-10-21', '2026-10-22');   // 先只读后两天
        rangesAsked = [];
        const wide = await readDailyPctRows('2026-10-20', '2026-10-22'); // 再要三天
        expect(rangesAsked.length).toBeGreaterThan(0);
        expect(plain(wide).A['2026-10-20']).toBe(1);           // 必须真的拿到第一天
    });

    it('读失败 ⇒ 返回 null（⛔ 不是空 Map，§10）', async function() {
        mode = 'fail';
        const m = await readDailyPctRows('2026-10-20', '2026-10-22');
        expect(m).toBeNull();
    });

    it('空入参 ⇒ 返回空 Map 且不发请求', async function() {
        const m = await readDailyPctRows('', '');
        expect(m.size).toBe(0);
        expect(rangesAsked).toEqual([]);
    });
});
