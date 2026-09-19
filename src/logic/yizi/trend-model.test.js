// trend-model.test.js — 「竞价一字 · 趋势图」纯函数模型层单测
//
// 只测纯变换：库行 → 四条曲线。⛔ 不碰网络/state/DB。
// 重点锁死三条口径（写错会让趋势图整体偏 100 倍或把「没数据」画成「0」）：
//   ① 竞价量 = auc_vol(手) ÷ 100（万）
//   ② 昨日成交量 = yest_volume 原样透传（⛔ 不再算第二遍）
//   ③ 缺失格 = null（⛔ 绝不用 0 顶替）
import { describe, it, expect } from 'vitest';
import {
    pctTextToNum,
    emptyYiziTrendSeries,
    buildYiziTrendSeries,
    trendMetricItems
} from './trend-model.js';

describe('pctTextToNum', () => {
    it('解析带符号 / 百分号 / Unicode 负号的文本', () => {
        expect(pctTextToNum('+10.02')).toBe(10.02);
        expect(pctTextToNum('-0.24')).toBe(-0.24);
        expect(pctTextToNum('3.25%')).toBe(3.25);
        expect(pctTextToNum('+3.25%')).toBe(3.25);
        expect(pctTextToNum('−1.50')).toBe(-1.5);
        expect(pctTextToNum(10.03)).toBe(10.03);
        expect(pctTextToNum('0')).toBe(0);
    });
    it('解析不出来 → null（绝不退化成 0）', () => {
        expect(pctTextToNum(null)).toBeNull();
        expect(pctTextToNum(undefined)).toBeNull();
        expect(pctTextToNum('')).toBeNull();
        expect(pctTextToNum('--')).toBeNull();
        expect(pctTextToNum('abc')).toBeNull();
    });
});

describe('emptyYiziTrendSeries', () => {
    it('四点全部 null，且日期轴与入参一致（顺序不乱）', () => {
        const s = emptyYiziTrendSeries(['2026-09-16', '2026-09-17']);
        ['volume', 'yestVolume', 'aucPctChg', 'changePct'].forEach(function(k) {
            expect(s[k].map(function(p) { return p.date; })).toEqual(['2026-09-16', '2026-09-17']);
            expect(s[k].every(function(p) { return p.value === null; })).toBe(true);
        });
        expect(s.latest).toBeNull();
        expect(s.hasAucPct).toBe(false);
        expect(s.hasChangePct).toBe(false);
    });
});

describe('buildYiziTrendSeries', () => {
    const window = ['2026-09-15', '2026-09-16', '2026-09-17'];
    const rows = [
        // 其它股票的行必须被忽略（同一天有很多只）
        { date: '2026-09-15', stock: '别的股票', aucVol: 99900, yestVolume: 999, aucPctChg: '+1.00', changePct: '+1.00' },
        // 当天缺竞价量（只有涨幅）→ 竞价量点为 null，涨幅点有值
        { date: '2026-09-15', stock: '华软科技', aucVol: null, aucPctChg: '', yestVolume: null, changePct: '+3.25' },
        { date: '2026-09-16', stock: '华软科技', aucVol: 123400, aucPctChg: '+10.10', yestVolume: 5600, changePct: '+10.10' },
        { date: '2026-09-17', stock: '华软科技', aucVol: 456700, aucPctChg: '+9.99', yestVolume: 3200, changePct: '-1.20' }
    ];

    it('竞价量按「手 ÷ 100 = 万」换算', () => {
        const s = buildYiziTrendSeries(rows, window, '华软科技');
        expect(s.volume.map(function(p) { return p.value; })).toEqual([null, 1234, 4567]);
    });

    it('昨日成交量原样透传', () => {
        const s = buildYiziTrendSeries(rows, window, '华软科技');
        expect(s.yestVolume.map(function(p) { return p.value; })).toEqual([null, 5600, 3200]);
    });

    it('两个涨幅序列解析成 number', () => {
        const s = buildYiziTrendSeries(rows, window, '华软科技');
        expect(s.aucPctChg.map(function(p) { return p.value; })).toEqual([null, 10.1, 9.99]);
        expect(s.changePct.map(function(p) { return p.value; })).toEqual([3.25, 10.1, -1.2]);
        expect(s.hasAucPct).toBe(true);
        expect(s.hasChangePct).toBe(true);
    });

    it('窗口里没有行的那一天 → 四个点全 null（⛔ 不是 0）', () => {
        const s = buildYiziTrendSeries(rows, ['2026-09-14', '2026-09-15'], '华软科技');
        expect(s.volume[0].value).toBeNull();
        expect(s.yestVolume[0].value).toBeNull();
        expect(s.aucPctChg[0].value).toBeNull();
        expect(s.changePct[0].value).toBeNull();
    });

    it('latest = 日期轴上最后一个「有任意数据」的那天（不是盲目取最后一项）', () => {
        const twoDays = buildYiziTrendSeries(rows, ['2026-09-15', '2026-09-16', '2026-09-17'], '华软科技');
        expect(twoDays.latestDate).toBe('2026-09-17');
        const onlyFirst = buildYiziTrendSeries(rows, ['2026-09-15', '2026-09-16', '2026-09-17'], '别的股票');
        expect(onlyFirst.latestDate).toBe('2026-09-15');
    });

    it('股票不在池内 → 空序列（不抛、不猜）', () => {
        const s = buildYiziTrendSeries(rows, window, '不存在的股票');
        expect(s.latest).toBeNull();
        expect(s.volume.every(function(p) { return p.value === null; })).toBe(true);
    });

    it('股票名为空 / 窗口为空 → 直接返回空序列', () => {
        expect(buildYiziTrendSeries(rows, window, '').latest).toBeNull();
        expect(buildYiziTrendSeries(rows, [], '华软科技').volume).toEqual([]);
    });
});

describe('trendMetricItems', () => {
    const window = ['2026-09-16', '2026-09-17'];
    it('汇总项与曲线同源（按 latestDate 定位，标签与数值同一天）', () => {
        const rows = [
            { date: '2026-09-16', stock: 'A', aucVol: 10000, aucPctChg: '+1.00', yestVolume: 100, changePct: '+1.00' },
            { date: '2026-09-17', stock: 'A', aucVol: 20000, aucPctChg: '+2.00', yestVolume: 200, changePct: '+2.00' }
        ];
        const s = buildYiziTrendSeries(rows, window, 'A');
        const items = trendMetricItems(s);
        const map = {};
        items.forEach(function(it) { map[it.label] = it.value; });
        expect(map['最新日期']).toBe('09-17');
        expect(map['竞价量']).toBe('200万');
        expect(map['昨日成交量']).toBe('200万');
        expect(map['竞价涨幅']).toBe('+2.00%');
        expect(map['涨幅']).toBe('+2.00%');
    });
    it('最新那天没有的数据 → 显示 -（不显示 0）', () => {
        const rows = [{ date: '2026-09-17', stock: 'A', aucVol: null, aucPctChg: '', yestVolume: 200, changePct: '' }];
        const items = trendMetricItems(buildYiziTrendSeries(rows, ['2026-09-17'], 'A'));
        const map = {};
        items.forEach(function(it) { map[it.label] = it.value; });
        expect(map['竞价量']).toBe('-');
        expect(map['竞价涨幅']).toBe('-');
        expect(map['涨幅']).toBe('-');
        expect(map['昨日成交量']).toBe('200万');
    });
    it('整条序列全空 → 返回空数组（面板不渲染汇总行）', () => {
        expect(trendMetricItems(emptyYiziTrendSeries(['2026-09-17']))).toEqual([]);
    });
});
