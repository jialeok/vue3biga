// paged-fetch.test.js — data/paged-fetch.js 的行为契约（§10 / §32 / §33）
//
// 为什么要这份测试：
//   这个助手决定了「一次逻辑读取到底把哪些行搬回内存」。它一错，全天所有看板的数据都会
//   少行或重行 —— 而且是静默的（看起来"加载成功"）。所以下面每条断言都对着一条红线：
//     · 行数必须与云端完全一致（不少、不重、不漏）—— 数据完整性
//     · 不再发 count 探测（去掉了 5.8 秒的 COUNT）—— 性能改动的核心目的
//     · 读失败必须抛 —— §10（失败 ≠ 空数据）
//     · 小结果集只发 1 条请求 —— 首屏窗口大多数查询就是这个情形
import { describe, it, expect } from 'vitest';
import { fetchAllPages, PAGED_FETCH_LIMITS } from './paged-fetch.js';

/**
 * 造一个假 PostgREST 查询构造器。
 * ⚠️ 故意【不提供 select / order / eq】—— 本助手一旦想回头去发 count 探测就会抛
 *    TypeError，测试立刻红（这是「不许再探总数」的硬保险）。
 */
function makeFakeDb(totalRows, opts) {
    const o = opts || {};
    const stat = { rangeCalls: 0, ranges: [] };
    const buildQuery = function() {
        return {
            range: function(from, to) {
                stat.rangeCalls++;
                stat.ranges.push([from, to]);
                if (o.failAt && stat.rangeCalls === o.failAt) {
                    return Promise.resolve({ data: null, error: new Error('boom') });
                }
                const rows = [];
                for (let i = from; i <= to && i < totalRows; i++) rows.push({ no: i, stock: 'S' + i });
                return Promise.resolve({ data: rows, error: null });
            }
        };
    };
    return { buildQuery: buildQuery, stat: stat };
}

describe('data/paged-fetch · 分页取全量', () => {
    it('空表 ⇒ 返回 []，且只发 1 条请求', async () => {
        const db = makeFakeDb(0);
        const rows = await fetchAllPages(db.buildQuery);
        expect(rows).toEqual([]);
        expect(db.stat.rangeCalls).toBe(1);
        expect(db.stat.ranges[0]).toEqual([0, 999]);
    });

    it('不满一页 ⇒ 返回全部行，只发 1 条请求（不再先探总数）', async () => {
        const db = makeFakeDb(37);
        const rows = await fetchAllPages(db.buildQuery);
        expect(rows).toHaveLength(37);
        expect(rows[0].no).toBe(0);
        expect(rows[36].no).toBe(36);
        expect(db.stat.rangeCalls).toBe(1);
    });

    it('恰好一整页（1000 行）⇒ 不多不少 1000 行（末页为空也要正确收尾）', async () => {
        const db = makeFakeDb(1000);
        const rows = await fetchAllPages(db.buildQuery);
        expect(rows).toHaveLength(1000);
        // 1000 行 = 第 0 页刚好满 ⇒ 必须继续翻页确认，但结果不能多出任何行
        expect(db.stat.rangeCalls).toBeGreaterThan(1);
        const uniq = new Set(rows.map(r => r.no));
        expect(uniq.size).toBe(1000);
    });

    it('多页（2500 行）⇒ 行数一致、无重复、无遗漏', async () => {
        const db = makeFakeDb(2500);
        const rows = await fetchAllPages(db.buildQuery);
        expect(rows).toHaveLength(2500);
        const nos = rows.map(r => r.no).sort((a, b) => a - b);
        expect(nos[0]).toBe(0);
        expect(nos[nos.length - 1]).toBe(2499);
        for (let i = 0; i < nos.length; i++) expect(nos[i]).toBe(i);
    });

    it('大表（7000 行 = 7 页）⇒ 行数一致且不漏', async () => {
        const db = makeFakeDb(7000);
        const rows = await fetchAllPages(db.buildQuery);
        expect(rows).toHaveLength(7000);
        expect(new Set(rows.map(r => r.no)).size).toBe(7000);
    });

    it('concurrency 生效：只有 1 页数据时不会并发扇出', async () => {
        const db = makeFakeDb(20);
        await fetchAllPages(db.buildQuery, { concurrency: 2 });
        expect(db.stat.rangeCalls).toBe(1);
    });

    it('§10 读失败必须抛出，⛔ 绝不返回空数组冒充没有数据', async () => {
        const db = makeFakeDb(2500, { failAt: 1 });
        await expect(fetchAllPages(db.buildQuery)).rejects.toThrow('boom');
    });

    it('§10 后续页读失败同样必须抛出（不许把半截数据当成功返回）', async () => {
        const db = makeFakeDb(5000, { failAt: 3 });
        await expect(fetchAllPages(db.buildQuery)).rejects.toThrow('boom');
    });

    it('pageSize 可调，且分页区间连续、互不重叠', async () => {
        const db = makeFakeDb(250);
        const rows = await fetchAllPages(db.buildQuery, { pageSize: 100 });
        expect(rows).toHaveLength(250);
        const starts = db.stat.ranges.map(r => r[0]).sort((a, b) => a - b);
        const ends = db.stat.ranges.map(r => r[1]).sort((a, b) => a - b);
        // 每页 [k*100, k*100+99]；不允许出现重叠区间
        for (let i = 0; i < starts.length; i++) expect(ends[i] - starts[i]).toBe(99);
        expect(new Set(starts).size).toBe(starts.length);
    });

    it('导出常量与实现一致（诊断/测试用的硬闸不被悄悄改掉）', () => {
        expect(PAGED_FETCH_LIMITS.pageSize).toBe(1000);
        expect(PAGED_FETCH_LIMITS.concurrency).toBe(6);
        expect(PAGED_FETCH_LIMITS.maxPages).toBe(200);
    });
});
