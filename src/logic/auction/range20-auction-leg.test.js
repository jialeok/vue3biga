// range20-auction-leg.test.js — 买点侧总龙名次 + 早盘竞价「竞价口径」toggle 的两个消费者
//
// 锁死四件事：
//   ① 【全市场 pct Map】不筛主板、不筛天数 —— 「20日涨幅」那一列是全表排序 + 逐行标数值，
//      创业板 / 天数不够的票也必须有数（否则开关一开这些行就空了，用户以为数据丢了）；
//   ② 【名次 Map】仍然只主板 + 天数达标（与买点侧发布口径同一个常量，§6）；
//   ③ leg='auc' 的行原值就是竞价口径 ⇒ ⛔ 不再反解（再反解一次 = 把竞价腿当收盘腿除，会算出假数）；
//   ④ 【§32】两个消费者共用同一次取数（⛔ 不许各读一遍）；【§10】加速层不可用 ⇒ 两侧都 null。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const rowsCalls = [];
const metricCalls = [];
let rowsMode = 'ok';        // 'ok' | 'null' | 'fail'
let rows = [];
let metricRows = [];

vi.mock('../../data/stock-range20-cache.js', function() {
    return {
        readRange20Rows: function(date) {
            rowsCalls.push(date);
            return Promise.resolve().then(function() {
                if (rowsMode === 'fail') throw new Error('加速层读取失败');
                if (rowsMode === 'null') return null;       // 加速层不可用（表不存在 / 冷却期）
                const m = new Map();
                (rows || []).forEach(function(r) {
                    m.set(r.stock, { pct: r.pct, days: r.days, leg: r.leg || 'close' });
                });
                return m;
            });
        }
    };
});

vi.mock('../../data/market-metrics.js', function() {
    return {
        readMarketMetricsForDate: function(date, scope) {
            metricCalls.push(date + '|' + scope);
            return Promise.resolve((metricRows || []).map(function(r) { return Object.assign({}, r); }));
        }
    };
});

// 「只主板」判据用的是 getStockCode + getBoardKind（§6）；这里只把代码映射钉死。
//   · 甲 / 丙 / 丁 / 戊 = 沪主板（60 开头）→ 占名次
//   · 乙              = 创业板（30 开头）→ ⛔ 不占名次（专用于验证「只主板」这一条）
vi.mock('../../data/stock-code-map.js', function() {
    const CODES = { '甲票': '600001', '乙票': '300001', '丙票': '600003', '丁票': '600004', '戊票': '600005' };
    return {
        getStockCode: function(name) { return CODES[String(name || '').trim()] || ''; }
    };
});

// 可信门槛（与发布侧同一个常量）：20 天窗口下 = 6
vi.mock('./range20-leaders.js', function() {
    return { RANGE20_LEADER_MIN_LEGS: 6 };
});

const {
    readAuctionLegRange20Pct,
    readAuctionLegRange20Rank,
    rankMainBoardByPct,
    clearAuctionLegRange20Cache
} = await import('./range20-auction-leg.js');

function row(stock, pct, days, leg) { return { stock: stock, pct: pct, days: days, leg: leg }; }
function mm(stock, changePct, aucPct) {
    return { stock: stock, change_pct: changePct, auc_pct_chg: aucPct };
}

beforeEach(function() {
    rowsCalls.length = 0;
    metricCalls.length = 0;
    rowsMode = 'ok';
    rows = [];
    metricRows = [];
    clearAuctionLegRange20Cache();
});

describe('range20-auction-leg · 全市场 pct Map（「竞价口径」toggle 用）', function() {
    it('★ 不筛主板、不筛天数：创业板票 / 天数不够的票都要有数', async function() {
        rows = [row('甲票', 40, 20), row('乙票', 50, 20, 'auc'), row('丙票', 30, 5)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        const mt = await readAuctionLegRange20Pct('2026-10-23');
        expect(Array.from(mt.keys()).sort()).toEqual(['丙票', '乙票', '甲票'].sort());
        expect(mt.get('乙票').pct).toBe(50);
        expect(mt.get('丙票').days).toBe(5);
    });

    it('★ leg=close ⇒ 把今天那一根腿换回竞价腿；leg=auc ⇒ 原样保留（⛔ 不二次反解）', async function() {
        const prevAcc = 1.5;                                  // 除今天以外的 19 天复利
        const stored = (prevAcc * (1 + 10.02 / 100) - 1) * 100;
        const want = (prevAcc * (1 + 6.66 / 100) - 1) * 100;
        rows = [row('甲票', stored, 20, 'close'), row('乙票', 50, 20, 'auc')];
        metricRows = [mm('甲票', '+10.02%', '+6.66%'), mm('乙票', '+10.02%', '+6.66%')];
        const mt = await readAuctionLegRange20Pct('2026-10-23');
        expect(mt.get('甲票').pct).toBeCloseTo(want, 6);
        expect(mt.get('乙票').pct).toBe(50);                  // auc 腿不再反解
    });

    it('§10 原值缺失（null）⇒ 该票不进结果（⛔ 不伪造 0）', async function() {
        rows = [row('甲票', null, 20), row('乙票', 50, 20, 'auc')];
        const mt = await readAuctionLegRange20Pct('2026-10-23');
        expect(mt.has('甲票')).toBe(false);
        expect(mt.has('乙票')).toBe(true);
    });
});

describe('range20-auction-leg · 名次 Map（买点侧总龙用）', function() {
    it('★ 仍然只主板 + 天数达标：创业板票、天数不够的票不占名次', async function() {
        rows = [row('甲票', 40, 20), row('乙票', 50, 20, 'auc'), row('丙票', 30, 5)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        const rank = await readAuctionLegRange20Rank('2026-10-23');
        expect(Array.from(rank.keys())).toEqual(['甲票']);
        expect(rank.get('甲票').rank).toBe(1);
    });

    it('★ 名次按涨幅降序，且 days 参与同名次时的次序（与发布侧同构）', async function() {
        // ⚠️ 只用主板票（甲 / 丙 / 丁）—— 用创业板票会先被「只主板」滤掉，测不到次序分支。
        const mk = function(name, pct, days) { return { name: name, pct: pct, days: days }; };
        const m = rankMainBoardByPct([
            mk('甲票', 30, 20), mk('丁票', 40, 20), mk('丙票', 40, 10)
        ], { minDays: 6 });
        expect(m.get('丁票').rank).toBe(1);    // 涨幅相同 ⇒ 天数多者优先
        expect(m.get('丙票').rank).toBe(2);
        expect(m.get('甲票').rank).toBe(3);
    });

    it('★ 涨幅、天数都相同 ⇒ 按名字升序（与发布侧同构，保证多次排序结果稳定）', async function() {
        const mk = function(name, pct, days) { return { name: name, pct: pct, days: days }; };
        const m = rankMainBoardByPct([
            mk('戊票', 40, 20), mk('甲票', 40, 20), mk('丁票', 40, 20)
        ], { minDays: 6 });
        const order = Array.from(m.keys());
        expect(order).toEqual(order.slice().sort());
        expect(m.get(order[0]).rank).toBe(1);
        expect(m.get(order[2]).rank).toBe(3);
    });

    it('★ days 不到门槛 / 缺值 ⇒ 不占名次（⛔ 不让弱证据挤掉强证据）', async function() {
        const mk = function(name, pct, days) { return { name: name, pct: pct, days: days }; };
        const m = rankMainBoardByPct([
            mk('甲票', 10, 20), mk('丁票', 99, 5), mk('丙票', null, 20)
        ], { minDays: 6 });
        expect(Array.from(m.keys())).toEqual(['甲票']);
        expect(m.get('甲票').rank).toBe(1);   // 涨停 99% 但只有 5 天 ⇒ 不进榜，甲票仍是第 1
    });
});

describe('range20-auction-leg · §32 两个消费者共用一次取数', function() {
    it('★ 先要 pct 再要名次 ⇒ 底层只读一次（⛔ 不各读一遍）', async function() {
        rows = [row('甲票', 40, 20)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        const pct = await readAuctionLegRange20Pct('2026-10-23');
        const rank = await readAuctionLegRange20Rank('2026-10-23');
        expect(pct).toBeTruthy();
        expect(rank.get('甲票').rank).toBe(1);
        expect(rowsCalls).toEqual(['2026-10-23']);
        expect(metricCalls).toEqual(['2026-10-23|auction']);
    });

    it('★ 反过来先要名次再要 pct 同样只读一次', async function() {
        rows = [row('甲票', 40, 20)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        await readAuctionLegRange20Rank('2026-10-23');
        await readAuctionLegRange20Pct('2026-10-23');
        expect(rowsCalls.length).toBe(1);
    });

    it('★ 名次 Map 引用稳定（§19：反复读拿到同一个实例）', async function() {
        rows = [row('甲票', 40, 20)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        const a = await readAuctionLegRange20Rank('2026-10-23');
        const b = await readAuctionLegRange20Rank('2026-10-23');
        expect(a).toBe(b);
    });
});

describe('range20-auction-leg · §10 加速层不可用', function() {
    it('★ rows = null ⇒ 两个消费者都返回 null（⛔ 不返回空 Map 冒充「这天没有数据」）', async function() {
        rowsMode = 'null';
        expect(await readAuctionLegRange20Pct('2026-10-23')).toBeNull();
        expect(await readAuctionLegRange20Rank('2026-10-23')).toBeNull();
        // null 是稳定条件 ⇒ 缓存住，不重复打请求
        expect(rowsCalls.length).toBe(1);
    });

    it('★ rows 读取抛错 ⇒ 返回 null（判不出）且【不写缓存】⇒ 下次真去读', async function() {
        rowsMode = 'fail';
        expect(await readAuctionLegRange20Pct('2026-10-23')).toBeNull();
        rowsMode = 'ok';
        rows = [row('甲票', 40, 20)];
        metricRows = [mm('甲票', '+10.02%', '+6.66%')];
        const mt = await readAuctionLegRange20Pct('2026-10-23');
        expect(mt).toBeTruthy();
        expect(mt.has('甲票')).toBe(true);
    });

    it('空日期 ⇒ null，不发请求', async function() {
        expect(await readAuctionLegRange20Pct('')).toBeNull();
        expect(await readAuctionLegRange20Rank(null)).toBeNull();
        expect(rowsCalls.length).toBe(0);
    });
});
