// daily-pct-range.test.js — 统一 K 线区间涨幅读取器的回归护栏
//
// 事故背景（2026-11-02 用户报障）：FUYAO-OFF 总闸把 fetchFuyaoDailyPctRange 变成「入口即 throw」，
// 全仓 7 个调用点 K 线腿集体断源 ⇒ 题材量比看板 9:26 起「总龙分歧判定计算中」挂死、
// 20日涨幅灰色行当天空白，交易被迫终止。本文件锁住三条红线：
//   ① FUYAO-OFF ⇒ 必须走腾讯腿且**换算契约与同花顺腿同形**（主返回 / openOut / volOut）；
//   ② 腾讯 volume 是手、fuyao 契约是股 ⇒ ×100 量纲对齐（别改岔）；
//   ③ FUYAO 恢复 ⇒ 透传同花顺腿、腾讯腿一个请求都不发（§11 既有行为逐字不变）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api/fuyao-proxy.js', () => ({ isFuyaoOff: vi.fn() }));
vi.mock('./api/qt-kline.js', () => ({ fetchQtDailyBars: vi.fn() }));
vi.mock('./stock-range-pct.js', () => ({ fetchFuyaoDailyPctRange: vi.fn() }));
vi.mock('./debug-log.js', () => ({ _dbgLog: () => {} }));

import { fetchDailyPctRange } from './daily-pct-range.js';
import { isFuyaoOff } from './api/fuyao-proxy.js';
import { fetchQtDailyBars } from './api/qt-kline.js';
import { fetchFuyaoDailyPctRange } from './stock-range-pct.js';

/** 一只票两根 K 线：昨收 10.00 → 今收 11.00，今开 10.00，昨量 1000 手 / 今量 2000 手 */
const BARS_A = [
    { ymd: '2026-10-16', open: 10.5, close: 10.0, volHand: 1000 },
    { ymd: '2026-10-19', open: 10.0, close: 11.0, volHand: 2000 },
];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('fetchDailyPctRange · FUYAO-OFF（腾讯腿）', function() {
    it('按同花顺腿同形契约换算：主返回=收盘涨幅%、openOut=开盘涨幅%、volOut=手×100（股）', async function() {
        isFuyaoOff.mockReturnValue(true);
        fetchQtDailyBars.mockResolvedValue(new Map([['600000', BARS_A]]));
        const openOut = new Map();
        const volOut = new Map();
        const out = await fetchDailyPctRange(
            [{ stock: '甲', code: '600000' }], ['2026-10-19'],
            { openOut: openOut, volOut: volOut });
        // ⛔ 契约锁：fetchQtDailyBars 收【字符串数组】——首版误传 {stock,code} 对象数组，
        //   qtSymOf('[object Object]') 恒空 ⇒ 0 请求空 Map（2026-11-02 现场实证），锁死防回归。
        const codesArg = fetchQtDailyBars.mock.calls[0][0];
        expect(Array.isArray(codesArg)).toBe(true);
        expect(codesArg.length).toBe(1);
        expect(typeof codesArg[0]).toBe('string');
        expect(codesArg[0]).toBe('600000');
        const legs = out.get('甲');
        expect(legs).toBeDefined();
        expect(legs.get('20261019')).toBeCloseTo(10.0, 6);          // 11/10-1 = +10%
        const open = openOut.get('甲');
        expect(open.get('20261019')).toBeCloseTo(0.0, 6);           // 10/10-1 = 0%
        const vol = volOut.get('甲');
        expect(vol.get('20261019')).toBe(2000 * 100);               // 手 → 股
        // volOut 记录的是【全部】series 日子（不只 wantSet）——昨日成交量要用窗口外的 bar
        expect(vol.get('20261016')).toBe(1000 * 100);
    });

    it('起点前移 20 自然日（窗口首日的涨幅需要上一交易日收盘价做基准）', async function() {
        isFuyaoOff.mockReturnValue(true);
        fetchQtDailyBars.mockResolvedValue(new Map());
        await fetchDailyPctRange([{ stock: '甲', code: '600000' }], ['2026-11-02']);
        const argFrom = fetchQtDailyBars.mock.calls[0][1];
        const argTo = fetchQtDailyBars.mock.calls[0][2];
        const fromMs = Date.parse(argFrom + 'T00:00:00Z');
        const toMs = Date.parse(argTo + 'T00:00:00Z');
        const spanDays = Math.round((toMs - fromMs) / 86400000);
        expect(spanDays).toBeGreaterThanOrEqual(22);   // 20 前移 + 2 后延
        expect(spanDays).toBeLessThanOrEqual(24);      // 时区/解析余量
    });

    it('整轮失败 / 单票无 bar ⇒ 该票不进主返回（不伪装、不补 0、不 throw）', async function() {
        isFuyaoOff.mockReturnValue(true);
        fetchQtDailyBars.mockResolvedValue(new Map());  // 全部无 bar
        const out = await fetchDailyPctRange([{ stock: '甲', code: '600000' }]);
        expect(out.size).toBe(0);
    });

    it('retryShortWindow=true 且首轮缺票 ⇒ 追加第二轮拉取（满窗调用方依赖）', async function() {
        isFuyaoOff.mockReturnValue(true);
        const short = new Map();                        // 首轮：无 bar
        const full = new Map([['600000', BARS_A]]);     // 二轮：有了
        fetchQtDailyBars
            .mockResolvedValueOnce(short)
            .mockResolvedValueOnce(full);
        const out = await fetchDailyPctRange(
            [{ stock: '甲', code: '600000' }], ['2026-10-19'],
            { retryShortWindow: true });
        expect(fetchQtDailyBars.mock.calls.length).toBe(2);
        expect(out.get('甲').get('20261019')).toBeCloseTo(10.0, 6);
    });

    it('批量拉取整体抛错 ⇒ 不 throw 冒出去（返回空 Map，调用方按取不到补 null）', async function() {
        isFuyaoOff.mockReturnValue(true);
        fetchQtDailyBars.mockRejectedValue(new Error('network down'));
        const out = await fetchDailyPctRange([{ stock: '甲', code: '600000' }]);
        expect(out.size).toBe(0);
    });
});

describe('fetchDailyPctRange · 同花顺通道可用（透传）', function() {
    it('透传 fetchFuyaoDailyPctRange，腾讯腿一个请求都不发（§11 既有行为不变）', async function() {
        isFuyaoOff.mockReturnValue(false);
        const fake = new Map([['甲', new Map([['20261019', 10]])]]);
        fetchFuyaoDailyPctRange.mockResolvedValue(fake);
        const out = await fetchDailyPctRange([{ stock: '甲', code: '600000' }], ['2026-10-19'], { concurrency: 3 });
        expect(out).toBe(fake);
        expect(fetchFuyaoDailyPctRange).toHaveBeenCalledTimes(1);
        expect(fetchFuyaoDailyPctRange.mock.calls[0][0]).toEqual([{ stock: '甲', code: '600000' }]);
        expect(fetchFuyaoDailyPctRange.mock.calls[0][1]).toEqual(['2026-10-19']);
        expect(fetchFuyaoDailyPctRange.mock.calls[0][2]).toEqual({ concurrency: 3 });
        expect(fetchQtDailyBars).not.toHaveBeenCalled();
    });
});
