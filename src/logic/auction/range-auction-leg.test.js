// range-auction-leg.test.js — 「9:26 口径区间涨幅」读取器（题材量比看板买点侧专用）
//
// 锁死三件事（每一条都对应一个真实事故面）：
//   ① 【口径正确】两行都已按收盘口径写入 ⇒ 反解出 9:26 那一份（与 replaceTDayLeg 互为逆运算）；
//      ⛔ 前提不足（没换腿 / 竞价腿缺失 / 指标行缺失）一律【保留原值】—— 那正是「不猜」的落点，
//      因为未换腿的行其原值本来就是 9:26 口径（见 range-auction-leg.js 文件头）。
//   ② 【§32】同一天只读一次（会话缓存 + 单飞）。
//   ③ 【§10】读取失败必须 throw（⛔ 绝不返回空 Map 冒充「这天没有数据」）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const rangeCalls = [];
const metricCalls = [];
let rangeMode = 'ok';
let metricMode = 'ok';
let rangeRows = [];
let metricRows = [];
let rangeGate = null;

vi.mock('../../data/stock-range-pct.js', function() {
    return {
        readRangePctForDate: function(date) {
            rangeCalls.push(date);
            const done = function() {
                if (rangeMode === 'fail') throw new Error('区间涨幅读取失败');
                const m = new Map();
                (rangeRows || []).forEach(function(r) {
                    m.set(r.stock, { pct: r.pct, days: r.days === undefined ? 10 : r.days, updatedAt: r.updatedAt || '' });
                });
                return m;
            };
            if (rangeGate) {
                const g = rangeGate; rangeGate = null;
                return g.then(function() { return done(); });
            }
            return Promise.resolve().then(done);
        }
    };
});

vi.mock('../../data/market-metrics.js', function() {
    return {
        readMarketMetricsForDate: function(date, scope) {
            metricCalls.push(date + '|' + scope);
            return Promise.resolve().then(function() {
                if (metricMode === 'fail') throw new Error('指标表读取失败');
                return (metricRows || []).map(function(r) { return Object.assign({}, r); });
            });
        }
    };
});

const { readAuctionLegRangeMap, clearAuctionLegCache } = await import('./range-auction-leg.js');

// 北京时间 15:00 = UTC 07:00。这里用「该日 15:00 之后」的 ISO 串表示已换腿。
const AFTER = '2026-10-13T08:00:37.399+00:00';   // 16:00 北京
const BEFORE = '2026-10-13T01:25:40.920+00:00';  // 09:25 北京

function m(stock, rangePct, updatedAt, days) {
    return { stock: stock, pct: rangePct, days: days, updatedAt: updatedAt };
}
function mm(stock, changePct, aucPct, updatedAt) {
    return { stock: stock, change_pct: changePct, auc_pct_chg: aucPct, updated_at: updatedAt };
}

beforeEach(function() {
    rangeCalls.length = 0;
    metricCalls.length = 0;
    rangeMode = 'ok';
    metricMode = 'ok';
    rangeRows = [];
    metricRows = [];
    rangeGate = null;
    clearAuctionLegCache();
});

describe('range-auction-leg · 反解成 9:26 口径', function() {
    it('★ 两行都已是收盘口径 ⇒ 把 T 腿换回竞价腿', async function() {
        // 库里（收盘腿口径）= prevAcc × (1+10.02) − 1；9:26 口径 = prevAcc × (1+6.66) − 1
        const prevAcc = 1.5;                                  // 除当天以外的 9 天复利
        const stored = (prevAcc * (1 + 10.02 / 100) - 1) * 100;
        const want = (prevAcc * (1 + 6.66 / 100) - 1) * 100;
        rangeRows = [m('甲票', stored, AFTER, 10)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%', AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('甲票').pct).toBeCloseTo(want, 6);
        expect(mt.get('甲票').days).toBe(10);
        expect(metricCalls).toEqual(['2026-10-13|auction']);
    });

    it('★ 区间行写于 15:00 之前（还没换腿）⇒ 原值本来就是 9:26 口径 ⇒ 原样保留', async function() {
        rangeRows = [m('乙票', 12.34, BEFORE, 10)];
        metricRows = [mm('乙票', '+8.00%', '+2.00%', AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('乙票').pct).toBe(12.34);
    });

    it('★ 指标行还停在 15:00 之前（change_pct 仍是竞价副本）⇒ 不反解，原样保留', async function() {
        rangeRows = [m('丙票', 12.34, AFTER, 10)];
        metricRows = [mm('丙票', '+2.00%', '+2.00%', BEFORE)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('丙票').pct).toBe(12.34);
    });

    it('§10 竞价腿读不到 ⇒ 原样保留（⛔ 绝不当 0 把那根腿抹掉）', async function() {
        rangeRows = [m('丁票', 12.34, AFTER, 10)];
        metricRows = [mm('丁票', '+10.02%', null, AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('丁票').pct).toBe(12.34);
    });

    it('§10 该票没有指标行 ⇒ 原样保留（也没换过腿，原值即 9:26 口径）', async function() {
        rangeRows = [m('戊票', 12.34, AFTER, 10)];
        metricRows = [];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('戊票').pct).toBe(12.34);
    });

    it('§10 原值缺失（null）⇒ 仍是 null（⛔ 不伪造 0）', async function() {
        rangeRows = [m('己票', null, AFTER, 9)];
        metricRows = [mm('己票', '+10.02%', '+6.66%', AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('己票').pct).toBeNull();
    });

    it('只收区间涨幅表里有的票（指标表多出来的票不进结果）', async function() {
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricRows = [mm('甲票', '+1%', '+1%', AFTER), mm('多头票', '+5%', '+5%', AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(Array.from(mt.keys())).toEqual(['甲票']);
    });
});

describe('range-auction-leg · §32 缓存 + 单飞', function() {
    it('★ 同一天读 5 次 ⇒ 每个数据源只读 1 次', async function() {
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricRows = [mm('甲票', '+1%', '+1%', AFTER)];
        for (let i = 0; i < 5; i++) await readAuctionLegRangeMap('2026-10-13');
        expect(rangeCalls).toEqual(['2026-10-13']);
        expect(metricCalls).toEqual(['2026-10-13|auction']);
    });

    it('★ 并发读同一天 ⇒ 单飞（返回同一个 Map 引用）', async function() {
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricRows = [mm('甲票', '+1%', '+1%', AFTER)];
        rangeGate = new Promise(function(r) { setTimeout(r, 5); });
        const [a, b, c] = await Promise.all([
            readAuctionLegRangeMap('2026-10-13'),
            readAuctionLegRangeMap('2026-10-13'),
            readAuctionLegRangeMap('2026-10-13')
        ]);
        expect(rangeCalls.length).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('不同日期各自读（缓存按日期分键）', async function() {
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricRows = [mm('甲票', '+1%', '+1%', AFTER)];
        await readAuctionLegRangeMap('2026-10-13');
        await readAuctionLegRangeMap('2026-10-14');
        expect(metricCalls).toEqual(['2026-10-13|auction', '2026-10-14|auction']);
    });

    it('空日期 ⇒ 空 Map，不发任何请求', async function() {
        expect((await readAuctionLegRangeMap('')).size).toBe(0);
        expect((await readAuctionLegRangeMap(null)).size).toBe(0);
        expect(rangeCalls.length).toBe(0);
        expect(metricCalls.length).toBe(0);
    });
});

describe('range-auction-leg · §10 读取失败必须 throw', function() {
    it('★ 区间涨幅读失败 ⇒ 抛错（⛔ 绝不返回空 Map 让上层以为「这天没数据」）', async function() {
        rangeMode = 'fail';
        await expect(readAuctionLegRangeMap('2026-10-13')).rejects.toBeTruthy();
    });

    it('★ 指标表读失败 ⇒ 抛错（拿不到收盘腿就无法判断该不该反解，不能静默按收盘口径将就）', async function() {
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricMode = 'fail';
        await expect(readAuctionLegRangeMap('2026-10-13')).rejects.toBeTruthy();
    });

    it('★ 失败【不写缓存】⇒ 下次还是真去读', async function() {
        rangeMode = 'fail';
        await readAuctionLegRangeMap('2026-10-13').catch(function() {});
        rangeMode = 'ok';
        rangeRows = [m('甲票', 1, AFTER, 10)];
        metricRows = [mm('甲票', '+1%', '+1%', AFTER)];
        const mt = await readAuctionLegRangeMap('2026-10-13');
        expect(mt.get('甲票').pct).toBeCloseTo(1, 6);
    });
});
