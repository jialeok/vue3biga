// topic-block.test.js — 共享分块核心 buildTopicBlocks 的回归闸门（§6 单一真相 / §4.5 排名可比性）
//
// 本文件锁一条规则（2026-09-20 新增）：
//   **度量窗口不足 `rankMinDays` 的残缺值，不参与块内排序、也不参与选龙头；
//     但它自己的度量值仍然照常写在行内（照样显示）**。
//
// 为什么要单独锁住（真实用户场景）：
//   2026-09-18 经纬股份（301390）因「筹划控制权变更」自 09-10 起停牌、09-17 复牌，
//   于是它 [T-9, T] 的 10 个交易日里只有 5 天有 K 线 ⇒ 十日涨幅 = 复利累乘(5 根腿) = 50.29%，
//   行内标注 "50.29%(5/10日)"。
//   区间涨幅是【复利累乘】，窗口天数不同的两个值**不可比**：若让这个 5/10 日的残缺值
//   与满窗值同尺排序，它会凭空抢走题材龙头，把「这个题材今天谁是龙头」这个结论整体带偏。
//   ⇒ 残缺值只展示、不排名。
//
// ⚠️ 反向约束同样重要：**不能靠「把 value 置 null」来实现不排名** ——
//    那样会把行内的十日涨幅也抹成 '-'（用户要的是「不参与排名」，不是「看不到值」）。

import { describe, it, expect } from 'vitest';
import { buildTopicBlocks } from './topic-block.js';

/**
 * 造一批行 + 调共享核心。
 * @param {Array<{stock:string, topic:string, pct:number, days:number}>} defs
 * @param {object} [opts] 额外透传给 buildTopicBlocks 的 opts
 */
function build(defs, opts) {
    const rows = defs.map(function(d) {
        return { stock: d.stock, topicsText: d.topic };
    });
    const primaryMap = new Map(defs.map(function(d) { return [d.stock, d.topic]; }));
    const byStock = new Map(defs.map(function(d) { return [d.stock, d]; }));
    return buildTopicBlocks(rows, Object.assign({
        primaryMap: primaryMap,
        fallbackFn: function() { return '其它'; },
        metricOf: function(row) {
            const d = byStock.get(row.stock);
            if (!d) return null;
            return { pct: d.pct, days: d.days };
        },
        metricKey: 'rangePct',
        metricDaysKey: 'rangeDays'
    }, opts || {}));
}

const DEFS = [
    { stock: '经纬股份', topic: '并购重组', pct: 50.29, days: 5 },   // 停牌残缺窗口
    { stock: '中材科技', topic: '并购重组', pct: 25.89, days: 10 },  // 满窗
    { stock: '华软科技', topic: '并购重组', pct: 7.25, days: 10 }    // 满窗
];

describe('buildTopicBlocks · rankMinDays 排名资格闸门', () => {
    it('不传 rankMinDays：行为与旧版完全一致（残缺值照样参与排序与选龙头）', () => {
        const blocks = build(DEFS);
        expect(blocks).toHaveLength(1);
        // 50.29 > 25.89 ⇒ 旧行为下残缺值就是龙头
        expect(blocks[0].leaderStock).toBe('经纬股份');
        expect(blocks[0].hasLeader).toBe(true);
        expect(blocks[0].stocks[0].isLeader).toBe(true);
        expect(blocks[0].stocks[0].rangePct).toBeCloseTo(50.29, 6);
    });

    it('rankMinDays=10：残缺值(5/10日)不得当龙头，改由满窗值第一名当龙头', () => {
        const blocks = build(DEFS, { rankMinDays: 10 });
        expect(blocks[0].hasLeader).toBe(true);
        expect(blocks[0].leaderStock).toBe('中材科技');
        // ⚠️ 字段名以 buildTopicBlocks 原始返回为准：leaderMetric（不是 leaderRangePct，
        //    后者只存在于 model.js 的 buildYiziBlocks 包装层）
        expect(blocks[0].leaderMetric).toBeCloseTo(25.89, 6);
        expect(blocks[0].leaderDays).toBe(10);
    });

    it('rankMinDays=10：残缺行【只是不排名】，值必须照旧显示，且排在满窗行之后', () => {
        const blocks = build(DEFS, { rankMinDays: 10 });
        const stocks = blocks[0].stocks;
        expect(stocks.map(function(s) { return s.stock; })).toEqual(['中材科技', '华软科技', '经纬股份']);
        const bad = stocks.find(function(s) { return s.stock === '经纬股份'; });
        // ★ 这条是「不许把 value 置 null」的反向闸门：值必须还在，天数也必须还在
        expect(bad.rangePct).toBeCloseTo(50.29, 6);
        expect(bad.rangeDays).toBe(5);
        expect(bad.isLeader).toBe(false);
    });

    it('rankMinDays=10：全部行都不满窗 → 不选龙头（绝不硬点一个）', () => {
        const blocks = build([
            { stock: '甲', topic: 'AI', pct: 50.29, days: 5 },
            { stock: '乙', topic: 'AI', pct: 12.0, days: 3 }
        ], { rankMinDays: 10 });
        expect(blocks[0].hasLeader).toBe(false);
        expect(blocks[0].leaderStock).toBe('');
        expect(blocks[0].leaderMetric).toBe(null);
        expect(blocks[0].stocks.every(function(s) { return s.isLeader === false; })).toBe(true);
    });

    it('无有效度量（pct=null）的行同样不参与排名，且不产生龙头', () => {
        const blocks = build([
            { stock: '甲', topic: 'AI', pct: null, days: 0 },
            { stock: '乙', topic: 'AI', pct: null, days: 0 }
        ], { rankMinDays: 10 });
        // metricOf 返回 null ⇒ value=null ⇒ 无龙头
        expect(blocks[0].hasLeader).toBe(false);
    });
});
