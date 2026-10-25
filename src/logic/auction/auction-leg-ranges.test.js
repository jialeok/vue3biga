// auction-leg-ranges.test.js — 「竞价口径」开关的数据出口（早盘竞价 toggle 专用）
//
// 锁死四件事（每一条都对应一个会让用户「看到错数 / 看到空表」的真实失败面）：
//   ① 【两套都发】十日与二十日【各读一次】，互不拖累（一侧判不出不影响另一侧）；
//   ② 【§10】判不出必须塌成 null（⛔ 不许拿空 Map 冒充「这天没有数据」，更不许悄悄退回收盘口径）；
//   ③ 【§32】同一天只读一次（缓存 + 单飞）；
//   ④ 【切日期】新日期必须能发布出去（曾经写成与 state.date 比 ⇒ 第二次切日期永远发不出去）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls10 = [];
const calls20 = [];
let mode10 = 'ok';      // 'ok' | 'fail' | 'null'
let mode20 = 'ok';      // 'ok' | 'fail' | 'null'
let gate = null;        // 让读取挂住，用来测单飞

vi.mock('./range-auction-leg.js', function() {
    return {
        readAuctionLegRangeMap: function(date) {
            calls10.push(date);
            const done = function() {
                if (mode10 === 'fail') throw new Error('十日区间读取失败');
                if (mode10 === 'null') return null;
                return new Map([['十日票', { pct: 11.1, days: 10 }]]);
            };
            if (gate) { const g = gate; return g.then(done); }
            return Promise.resolve().then(done);
        }
    };
});

vi.mock('./range20-auction-leg.js', function() {
    return {
        readAuctionLegRange20Pct: function(date) {
            calls20.push(date);
            const done = function() {
                if (mode20 === 'fail') throw new Error('二十日区间读取失败');
                if (mode20 === 'null') return null;
                return new Map([['二十日票', { pct: 22.2, days: 20 }]]);
            };
            if (gate) { const g = gate; return g.then(done); }
            return Promise.resolve().then(done);
        }
    };
});

const {
    ensureAuctionLegRanges,
    getAuctionLegRange10,
    getAuctionLegRange20,
    isAuctionLegRangesLoaded,
    getAuctionLegRangesFingerprintToken,
    clearAuctionLegRanges
} = await import('./auction-leg-ranges.js');

beforeEach(function() {
    calls10.length = 0;
    calls20.length = 0;
    mode10 = 'ok';
    mode20 = 'ok';
    gate = null;
    clearAuctionLegRanges();
});

describe('auction-leg-ranges · 两套口径各自加载', function() {
    it('★ 加载后十日 / 二十日各自的数值都能读到（互不串）', async function() {
        await ensureAuctionLegRanges('2026-10-23');
        expect(getAuctionLegRange10('2026-10-23').get('十日票').pct).toBe(11.1);
        expect(getAuctionLegRange20('2026-10-23').get('二十日票').pct).toBe(22.2);
        expect(isAuctionLegRangesLoaded('2026-10-23')).toBe(true);
        // ⛔ 十日里不该冒出二十日的票（两张表是两个数据源，混了就成假真相）
        expect(getAuctionLegRange10('2026-10-23').has('二十日票')).toBe(false);
    });

    it('★ 未加载 / 日期不匹配 ⇒ 两个 getter 都返回 null（⛔ 不返回空 Map 冒充「没有数据」）', async function() {
        expect(getAuctionLegRange10('2026-10-23')).toBeNull();
        expect(getAuctionLegRange20('2026-10-23')).toBeNull();
        await ensureAuctionLegRanges('2026-10-23');
        // 切到另一天、还没加载 ⇒ null（这一帧必须视为「没有数据」）
        expect(getAuctionLegRange10('2026-10-24')).toBeNull();
        expect(getAuctionLegRange20('2026-10-24')).toBeNull();
        expect(isAuctionLegRangesLoaded('2026-10-24')).toBe(false);
    });

    it('★ 切日期后【新日期】必须能发布（回归：护栏写成与 state.date 比 ⇒ 永远发不出去）', async function() {
        await ensureAuctionLegRanges('2026-10-23');
        await ensureAuctionLegRanges('2026-10-24');
        expect(isAuctionLegRangesLoaded('2026-10-24')).toBe(true);
        expect(getAuctionLegRange10('2026-10-24')).not.toBeNull();
        expect(getAuctionLegRange10('2026-10-23')).toBeNull();     // 旧日期这一份已经不属于当前状态
    });

    it('空日期 ⇒ 不发任何请求', async function() {
        await ensureAuctionLegRanges('');
        await ensureAuctionLegRanges(null);
        expect(calls10.length).toBe(0);
        expect(calls20.length).toBe(0);
    });
});

describe('auction-leg-ranges · §10 判不出就是判不出', function() {
    it('★ 十日报错 ⇒ 十日为 null，但二十日照常可用（一侧失败不拖累另一侧）', async function() {
        mode10 = 'fail';
        await ensureAuctionLegRanges('2026-10-23');
        expect(getAuctionLegRange10('2026-10-23')).toBeNull();
        expect(getAuctionLegRange20('2026-10-23').get('二十日票').pct).toBe(22.2);
        // ⛔ 关键：ensure 本身不能 reject（否则调用方会以为整件事失败、连二十日也一起丢掉）
        expect(isAuctionLegRangesLoaded('2026-10-23')).toBe(true);
    });

    it('★ 二十日报错 ⇒ 二十日为 null，十日照常可用', async function() {
        mode20 = 'fail';
        await ensureAuctionLegRanges('2026-10-23');
        expect(getAuctionLegRange20('2026-10-23')).toBeNull();
        expect(getAuctionLegRange10('2026-10-23').get('十日票').pct).toBe(11.1);
    });

    it('★ 读取器明确返回 null（加速层不可用）⇒ 保持 null（⛔ 不塌成空 Map）', async function() {
        mode10 = 'null';
        mode20 = 'null';
        await ensureAuctionLegRanges('2026-10-23');
        expect(getAuctionLegRange10('2026-10-23')).toBeNull();
        expect(getAuctionLegRange20('2026-10-23')).toBeNull();
    });
});

describe('auction-leg-ranges · §32 缓存 + 单飞', function() {
    it('★ 同一天 ensure 5 次 ⇒ 每个数据源只读 1 次', async function() {
        for (let i = 0; i < 5; i++) await ensureAuctionLegRanges('2026-10-23');
        expect(calls10).toEqual(['2026-10-23']);
        expect(calls20).toEqual(['2026-10-23']);
    });

    it('★ 并发 ensure 同一天 ⇒ 单飞（只发一轮）', async function() {
        gate = new Promise(function(r) { setTimeout(r, 5); });
        await Promise.all([
            ensureAuctionLegRanges('2026-10-23'),
            ensureAuctionLegRanges('2026-10-23'),
            ensureAuctionLegRanges('2026-10-23')
        ]);
        expect(calls10.length).toBe(1);
        expect(calls20.length).toBe(1);
    });

    it('★ 引用稳定（§19）：同一天反复读取拿到的是同一个 Map 实例', async function() {
        await ensureAuctionLegRanges('2026-10-23');
        const a = getAuctionLegRange10('2026-10-23');
        const b = getAuctionLegRange10('2026-10-23');
        expect(a).toBe(b);
    });
});

describe('auction-leg-ranges · 指纹令牌（增量渲染用）', function() {
    it('未加载 ⇒ off（后台到货不会让整表白重排，§11）', function() {
        expect(getAuctionLegRangesFingerprintToken()).toBe('off');
    });

    it('加载后 ⇒ 令牌随日期 / 版本变化', async function() {
        await ensureAuctionLegRanges('2026-10-23');
        const t1 = getAuctionLegRangesFingerprintToken();
        expect(t1).toContain('2026-10-23');
        expect(t1).not.toBe('off');
        await ensureAuctionLegRanges('2026-10-24');
        expect(getAuctionLegRangesFingerprintToken()).not.toBe(t1);
    });

    it('清空后 ⇒ 回到 off 且 getter 全部 null', async function() {
        await ensureAuctionLegRanges('2026-10-23');
        clearAuctionLegRanges();
        expect(getAuctionLegRangesFingerprintToken()).toBe('off');
        expect(getAuctionLegRange10('2026-10-23')).toBeNull();
        expect(getAuctionLegRange20('2026-10-23')).toBeNull();
    });
});
