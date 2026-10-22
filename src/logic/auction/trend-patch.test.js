// trend-patch.test.js — 趋势图「缺数据日」同花顺兜底补缺 · 纯函数换算语义单测
//
// 复刻 2026-10-21 用户报障实例（时代万恒 600241，10-20 补位票趋势图当天空白）的换算语义：
//   库内真相（market_metrics 10-19 行，实测值）：
//     change_pct=-9.96% / auc_pct_chg=-9.89% / yest_volume=8176(万股,=10-16 全天量)
//   K 线真相（同花顺 historical，实测值）：
//     10-16: vol=81806100 股, close=14.15
//     10-19: vol=80381300 股, open=12.75, close=12.74
//     10-20: vol=96742200 股, open=11.96, close=13.62
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeKlineDayPatch, ensureTrendPatch } from './trend-patch.js';
import { fuyaoApiGet } from '../../data/api/fuyao-proxy.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';

// [TREND-PATCH-FIX 2026-10-22] mock 上游两腿：K 线腿 / 快照腿（ensureTrendPatch 集成语义）
vi.mock('../../data/api/fuyao-proxy.js', async (importOriginal) => {
    const actual = await importOriginal();
    return Object.assign({}, actual, { fuyaoApiGet: vi.fn() });
});
vi.mock('../../data/stock-range-pct.js', () => ({ fetchFuyaoDailyPctRange: vi.fn() }));

describe('trend-patch · computeKlineDayPatch（K线腿换算，复刻时代万恒 10-20 实例）', () => {
  // 与探针逐字节一致的 K 线 series（键 = YYYYMMDD，量 = 股）
  const volKeep = new Map([
    ['20261016', 81806100],
    ['20261019', 80381300],
    ['20261020', 96742200]
  ]);
  const keep = new Map([
    ['20261019', (12.74 / 14.15 - 1) * 100],
    ['20261020', (13.62 / 12.74 - 1) * 100]
  ]);
  const openKeep = new Map([
    ['20261019', (12.75 / 14.15 - 1) * 100],
    ['20261020', (11.96 / 12.74 - 1) * 100]
  ]);

  it('10-19（窗口内缺日）：换算值与库内 market_metrics 逐位对齐', () => {
    const r = computeKlineDayPatch('20261019', keep, openKeep, volKeep);
    expect(r.changePct).toBeCloseTo(-9.96, 1);          // 库内 change_pct = "-9.96%"
    expect(r.aucPctChg).toBeCloseTo(-9.89, 1);          // 库内 auc_pct_chg = "-9.89%"
    expect(r.yestVolume).toBeCloseTo(8180.61, 0);       // 10-16 量 81806100 股 → 8180.61 万股（库内 8176，同口径）
  });

  it('10-20（用户报障的那一天）：竞价涨幅 -6.12% / 涨幅 +6.91% / 昨日成交量 = 10-19 的量', () => {
    const r = computeKlineDayPatch('20261020', keep, openKeep, volKeep);
    expect(r.aucPctChg).toBeCloseTo(-6.12, 1);          // 11.96/12.74-1（10-21 凌晨快照实测同一值）
    expect(r.changePct).toBeCloseTo(6.91, 1);           // 13.62/12.74-1（10-20 涨停）
    expect(r.yestVolume).toBeCloseTo(8038.13, 0);       // 10-19 量 80381300 股 → 万股
    expect(r.volume).toBeUndefined();                    // K 线没有竞价量（由快照腿补，本函数不产出）
  });

  it('窗口首日的「昨日」在窗口外：只要 series 覆盖到就能取到（K线起点已前移 20 自然日）', () => {
    // 缺日 = 10-13（窗口首日），series 只含 10-12 一根更早的 K 线
    const v = new Map([['20261012', 94190000], ['20261013', 99890000]]);
    const k = new Map([['20261013', -0.62]]);
    const r = computeKlineDayPatch('20261013', k, null, v);
    expect(r.yestVolume).toBeCloseTo(9419, 0);
    expect(r.changePct).toBeCloseTo(-0.62, 5);
    expect(r.aucPctChg).toBeNull();                      // openOut 缺 ⇒ null（§10 不猜）
  });

  it('上一根 K 线是停牌缺 bar：跳过它取更早的那根（严格早于的最近一天）', () => {
    const v = new Map([['20261009', 58600000], ['20261013', 99890000], ['20261014', 107090000]]);
    // 10-10~10-12 中 10-10/11 是周末、若 10-12 停牌缺 bar ⇒ 10-14 的「昨日」= 10-13（不是不存在的 10-13+1）
    const r = computeKlineDayPatch('20261014', null, null, v);
    expect(r.yestVolume).toBeCloseTo(9989, 0);
  });

  it('所有腿都取不到 ⇒ 三字段全 null（趋势图该点画 --，§10 绝不补 0）', () => {
    const r = computeKlineDayPatch('20261020', null, null, null);
    expect(r.changePct).toBeNull();
    expect(r.aucPctChg).toBeNull();
    expect(r.yestVolume).toBeNull();
  });

  it('成交量 ≤ 0 / 非数字：yestVolume = null（不用 0 冒充「昨天没成交量」）', () => {
    const v = new Map([['20261019', 0], ['20261020', 96742200]]);
    const r = computeKlineDayPatch('20261020', null, null, v);
    expect(r.yestVolume).toBeNull();
    const v2 = new Map([['20261019', NaN], ['20261020', 96742200]]);
    const r2 = computeKlineDayPatch('20261020', null, null, v2);
    expect(r2.yestVolume).toBeNull();
  });

  it('没有更早 K 线（上市首日/窗口起点即 K 线首日）：yestVolume = null', () => {
    const v = new Map([['20261020', 96742200]]);
    const r = computeKlineDayPatch('20261020', null, null, v);
    expect(r.yestVolume).toBeNull();
  });
});

// ============================================================
// [TREND-PATCH-FIX 2026-10-22] ensureTrendPatch 集成语义（复刻新华传媒 600825 · 10-22 报障）：
//   ① K 线腿盘中拉「今天」⇒ 上游无今天 bar ⇒ 主返回 keep 为空，但 openOut/volOut
//      （修复后的超集出口）仍交付昨天 bar ⇒ yestVolume 必须能算出；
//   ② 快照腿请求 thscodes【必须带交易所后缀】（裸 6 位码上游返 code:1002 ⇒ 整腿 throw）；
//   ③ 响应 item.thscode 带【.SH 后缀】⇒ codeOf 双键匹配 ⇒ 当日竞价量/竞价涨幅/量比补上。
// 「今天」用真实北京时间当天（ensureTrendPatch 内部按 _beijingTodayYmd 判定，不可注入）。
// ============================================================
describe('trend-patch · ensureTrendPatch 集成（快照腿带后缀 + 双键匹配 + K线腿超集出口）', () => {
    const todayYmd = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const todayYmdKey = todayYmd.replace(/-/g, '');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('复刻 10-22：K线今天无bar（keep空、volOut有昨天）+ 快照带后缀 ⇒ 五腿全补上', async () => {
        // K 线腿 mock：模拟修复①后的交付形状 —— 主返回空（今天无 bar），openOut/volOut 超集交付
        fetchFuyaoDailyPctRange.mockImplementation(async (list, dates, opts) => {
            if (opts && opts.volOut) {
                opts.volOut.set('新华传媒', new Map([
                    ['20261021', 52000000],
                    [todayYmdKey, 61000000]   // 盘中其实没有今天 bar，多给无害（按 ymd 取值）
                ]));
            }
            if (opts && opts.openOut) opts.openOut.set('新华传媒', new Map());
            return new Map();   // keep 为空 ⇒ changePct/aucPctChg 该日 null（§10 不补 0）
        });
        // 快照腿 mock：断言请求带后缀 + 响应 thscode 带后缀（真实上游形状）
        // ⚠️ mock 语义 = 真 fuyaoApiGet：返回【data 字段本身】（code!==0 时真实现会 throw）
        fuyaoApiGet.mockImplementation(async (path, params) => {
            expect(path).toBe('/api/a-share/auction/snapshot');
            expect(params.stage).toBe('final');
            expect(params.thscodes).toBe('600825.SH');   // ← 修复②核心断言（裸码 600825 = code:1002）
            return {
                timestamp: Date.now(),                   // 服务端时间 = 今天 ⇒ 过日期闸门
                data_status: 'final',
                item: [{
                    thscode: '600825.SH',                // ← 带后缀响应（修复③双键匹配）
                    ticker: '600825',
                    name: '新华传媒',
                    auction_volume: 36365.21,            // 手
                    auction_pct: -1.8553,
                    auction_volume_ratio: 1.37
                }]
            };
        });

        const result = await ensureTrendPatch(
            [{ stock: '新华传媒', code: '600825' }],
            new Map([['新华传媒', [todayYmd]]])
        );

        const day = result.get('新华传媒').get(todayYmd);
        expect(day.volume).toBeCloseTo(363.6521, 3);    // 36365.21 手 ÷ 100 = 万股
        expect(day.aucPctChg).toBeCloseTo(-1.8553, 4);  // 快照 auction_pct 优先
        expect(day.aucVolRatio).toBeCloseTo(1.37, 5);
        expect(day.yestVolume).toBeCloseTo(5200, 0);    // 10-21 量 52000000 股 → 5200 万股（K线腿超集出口）
        expect(day.changePct).toBeNull();                // 今天无 bar ⇒ null（§10 宁缺勿错）
    });

    it('快照闸门（data_status≠final）⇒ 当日竞价量不补，K线腿照常交付', async () => {
        fetchFuyaoDailyPctRange.mockImplementation(async (list, dates, opts) => {
            if (opts && opts.volOut) opts.volOut.set('测试股', new Map([['20261021', 10000000]]));
            return new Map();
        });
        fuyaoApiGet.mockResolvedValue({
            timestamp: Date.now(), data_status: 'not_ready', item: []
        });

        const result = await ensureTrendPatch(
            [{ stock: '测试股', code: '000001' }],
            new Map([['测试股', [todayYmd]]])
        );
        const day = result.get('测试股').get(todayYmd);
        expect(day.volume).toBeNull();                   // 闸门拒绝 ⇒ 不补（防跨日写错）
        expect(day.yestVolume).toBeCloseTo(1000, 0);     // K 线腿不受影响
    });
});
