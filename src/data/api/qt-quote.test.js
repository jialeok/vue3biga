// qt-quote.test.js — 腾讯实时行情腿（竞价期唯一能给出「今天」的数据源）· 纯函数 + 解析语义
//
// 复刻 2026-11-02 现场实测（九阳股份 002242 / 新华传媒 600825，16:14 抓到的真实报文）：
//   sz002242: 现价 23.33 / 昨收 22.14 / 今开 21.50 ⇒ 涨幅 +5.37% / 竞价涨幅 -2.8907%
//   sh600825: 现价 12.47 / 昨收 13.36 / 今开 12.02 ⇒ 涨幅 -6.66% / 竞价涨幅 -10.0299%
// 同花顺同一时刻的 auction_pct：-2.8907 / -10.0299 —— 与上面逐位一致（这就是选它的依据）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchQtRealtimeQuotes, qtParseStamp, qtAucPctOf, qtChangePctOf } from './qt-quote.js';

describe('qt-quote · 纯函数换算', () => {
    it('时间戳解析：14 位 → YYYY-MM-DD + HH:MM:SS（非 14 位 ⇒ 空串，⛔ 不猜）', () => {
        expect(qtParseStamp('20261102161454')).toEqual({ ymd: '2026-11-02', hms: '16:14:54' });
        expect(qtParseStamp('')).toEqual({ ymd: '', hms: '' });
        expect(qtParseStamp('2026-11-02')).toEqual({ ymd: '', hms: '' });
        expect(qtParseStamp(undefined)).toEqual({ ymd: '', hms: '' });
    });

    it('竞价涨幅 = 今开/昨收-1：与同花顺 auction_pct 逐位一致（九阳 / 新华实测值）', () => {
        expect(qtAucPctOf({ open: 21.50, prevClose: 22.14 })).toBeCloseTo(-2.89, 2);   // 同花顺 -2.8907
        expect(qtAucPctOf({ open: 12.02, prevClose: 13.36 })).toBeCloseTo(-10.03, 2);  // 同花顺 -10.0299
    });

    it('涨幅 = 现价/昨收-1', () => {
        expect(qtChangePctOf({ price: 23.33, prevClose: 22.14 })).toBeCloseTo(5.37, 2);
        expect(qtChangePctOf({ price: 12.47, prevClose: 13.36 })).toBeCloseTo(-6.66, 2);
    });

    it('今开还没定（集合竞价未完成，腾讯给 0）⇒ 竞价涨幅 null（§10 宁缺勿错，⛔ 不补 0）', () => {
        expect(qtAucPctOf({ open: 0, prevClose: 22.14 })).toBeNull();
        expect(qtAucPctOf({ open: null, prevClose: 22.14 })).toBeNull();
        expect(qtAucPctOf({ open: 21.5, prevClose: 0 })).toBeNull();
        expect(qtAucPctOf(null)).toBeNull();
    });

    it('缺字段 / 非法值 ⇒ null（⛔ 不把「取不到」伪装成「没有」）', () => {
        expect(qtChangePctOf({ price: null, prevClose: 22.14 })).toBeNull();
        expect(qtChangePctOf({})).toBeNull();
        expect(qtChangePctOf(undefined)).toBeNull();
    });
});

describe('qt-quote · fetchQtRealtimeQuotes 解析', () => {
    // 真实报文是 88 个 `~` 分隔字段（实测 v_sz002242 字段数 = 88）。按位下标构造，
    // 保证断言的就是真接口的位序（[3]现价 [4]昨收 [5]今开 [6]成交量(手) [30]时间戳 [32]涨幅%）。
    function payload(sym, name, price, prev, open, vol, stamp, pct) {
        const f = new Array(88).fill('0');
        f[0] = '51'; f[1] = name; f[2] = sym.slice(2);
        f[3] = String(price); f[4] = String(prev); f[5] = String(open);
        f[6] = String(vol); f[30] = stamp; f[32] = String(pct);
        return 'v_' + sym + '="' + f.join('~') + '";\n';
    }
    const REAL = payload('sz002242', '九阳股份', 23.33, 22.14, 21.50, 1116097, '20261102161454', 5.37)
        + payload('sh600825', '新华传媒', 12.47, 13.36, 12.02, 1774184, '20261102161456', -6.66);

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => REAL })));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('按 6 位代码返回行情，字段位序与真实报文一致（[3]现价 [4]昨收 [5]今开 [6]量 [30]时间戳）', async () => {
        const m = await fetchQtRealtimeQuotes(['002242', '600825']);
        expect(m.size).toBe(2);
        const a = m.get('002242');
        expect(a.ymd).toBe('2026-11-02');
        expect(a.hms).toBe('16:14:54');
        expect(a.price).toBe(23.33);
        expect(a.prevClose).toBe(22.14);
        expect(a.open).toBe(21.50);
        expect(a.volHand).toBe(1116097);
        expect(qtAucPctOf(a)).toBeCloseTo(-2.89, 2);
        expect(m.get('600825').open).toBe(12.02);
    });

    it('非法代码 / 空输入 ⇒ 零请求、空 Map（⛔ 不构造脏 URL）', async () => {
        expect((await fetchQtRealtimeQuotes([])).size).toBe(0);
        const m = await fetchQtRealtimeQuotes(['', 'abc', '12345']);
        expect(m.size).toBe(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('上游失败 ⇒ 空 Map 且不抛（调用方按「取不到 = 补 null」处理，§10）', async () => {
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' });
        const m = await fetchQtRealtimeQuotes(['002242']);
        expect(m.size).toBe(0);
    });
});
