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
import { computeKlineDayPatch, computeQtDayPatches, ensureTrendPatch } from './trend-patch.js';
import { fuyaoApiGet, isFuyaoOff, isFuyaoSnapshotAllowed } from '../../data/api/fuyao-proxy.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { fetchQtDailyBars } from '../../data/api/qt-kline.js';
import { fetchQtRealtimeQuotes, qtAucPctOf, qtChangePctOf } from '../../data/api/qt-quote.js';

// [TREND-PATCH-FIX 2026-10-22] mock 上游两腿：K 线腿 / 快照腿（ensureTrendPatch 集成语义）
vi.mock('../../data/api/fuyao-proxy.js', async (importOriginal) => {
    const actual = await importOriginal();
    // [QT-PATCH 2026-11-01] isFuyaoOff 也必须可 mock：真实模块里它是写死的 true（总闸开着），
    // 不 mock 的话所有集成测试都会走腾讯腿而不是被测的 fuyao 腿。默认 false = 「通道可用」，
    // 腾讯腿的用例里再单独改成 true。
    // [FUYAO-SNAPSHOT 2026-11-02] isFuyaoSnapshotAllowed 同理：总闸开着时它表示「快照端点受控放行」。
    return Object.assign({}, actual, {
        fuyaoApiGet: vi.fn(),
        isFuyaoOff: vi.fn(() => false),
        isFuyaoSnapshotAllowed: vi.fn(() => true)
    });
});
vi.mock('../../data/stock-range-pct.js', () => ({ fetchFuyaoDailyPctRange: vi.fn() }));
// [QT-PATCH 2026-11-01] 腾讯腿同样 mock（⛔ 绝不让单测打真实网络）
vi.mock('../../data/api/qt-kline.js', () => ({ fetchQtDailyBars: vi.fn(), qtSymOf: vi.fn(() => '') }));
// [QT-TODAY 2026-11-02] 腾讯实时行情腿也 mock（换算函数用真实实现，只挡网络）
vi.mock('../../data/api/qt-quote.js', async (importOriginal) => {
    const actual = await importOriginal();
    return Object.assign({}, actual, { fetchQtRealtimeQuotes: vi.fn() });
});

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
        isFuyaoOff.mockReturnValue(false);   // 默认「同花顺可用」，腾讯腿用例里单独改 true
        fetchQtRealtimeQuotes.mockResolvedValue(new Map());  // 默认：实时行情腿无数据
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
            new Map([['新华传媒', [todayYmd]]]),
            { nowHms: '17:00:00' }   // ★ [QT-TODAY] 钉住「收盘口径」：changePct 只认 K 线，无 bar ⇒ null
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

// ══════════════════════════════════════════════════════════════════════════════
// [QT-PATCH 2026-11-01] 腾讯 qfq 日线腿（同花顺通道停用期间的兜底，复刻九阳股份 10-30 实例）
//   库内真相（worker 行）：10-28 yest_volume = 12,083 万股（= 10-27 全天量 1,209,555 手量纲核对）
//   腾讯真相（fqkline，实测）：10-29 open=22.380 close=23.000；10-30 open=21.860 close=22.140
//     ⇒ 10-30 竞价涨幅 = 21.860/23.000-1 = -4.956%；涨幅 = 22.140/23.000-1 = -3.739%
// ══════════════════════════════════════════════════════════════════════════════
describe('trend-patch · computeQtDayPatches（腾讯日线腿换算，复刻九阳股份 10-30 实例）', () => {
  const bars = [
    { ymd: '2026-10-29', open: 22.380, close: 23.000, volHand: 1172052 },
    { ymd: '2026-10-30', open: 21.860, close: 22.140, volHand: 1039511 },
    { ymd: '2026-10-28', open: 21.320, close: 22.380, volHand: 1209555 }
  ];

  it('涨幅 / 竞价涨幅换算与腾讯 bar 逐位对齐（乱序输入也能算）', () => {
    const m = computeQtDayPatches(bars, ['2026-10-30']);
    const r = m.get('2026-10-30');
    expect(r.changePct).toBeCloseTo((22.140 / 23.000 - 1) * 100, 2);
    expect(r.aucPctChg).toBeCloseTo((21.860 / 23.000 - 1) * 100, 2);
    // 昨日成交量 = 前一日 1,172,052 手 ÷ 100 = 11,720.52 万股（与 worker 库内同量纲）
    expect(r.yestVolume).toBeCloseTo(11720.52, 2);
  });

  it('窗口首日（无昨收基准）/ 无 bar 的日子 ⇒ 不产出该日（调用方补 null，§10 不猜）', () => {
    const m1 = computeQtDayPatches([{ ymd: '2026-10-30', open: 21.86, close: 22.14, volHand: 100 }], ['2026-10-30']);
    expect(m1.has('2026-10-30')).toBe(false);
    const m2 = computeQtDayPatches(bars, ['2026-10-31']);
    expect(m2.size).toBe(0);
    expect(computeQtDayPatches(null, ['2026-10-30']).size).toBe(0);
  });

  // ★★ [QT-TODAY 2026-11-02] 复刻「九阳股份 / 新华传媒 11-02 当天整日全空」的现场：
  //   竞价期腾讯日线**没有今天这根 bar**（实测最后一根是 10-30）⇒ 旧逻辑整日 continue
  //   ⇒ 连「昨日成交量」都补不上，而它跟今天的 bar 毫无关系。
  it('当日还没有 bar（noBarYmd）⇒ 昨日成交量照样能算，涨幅/竞价涨幅留 null', () => {
    const m = computeQtDayPatches(bars, ['2026-11-02'], { noBarYmd: '2026-11-02' });
    const r = m.get('2026-11-02');
    expect(r.yestVolume).toBeCloseTo(10395.11, 2);   // 10-30 那根 1,039,511 手 ÷ 100
    expect(r.changePct).toBeNull();                  // ⛔ 今天自己的收盘价还没有，不猜
    expect(r.aucPctChg).toBeNull();                  // ⛔ 今天自己的开盘价也没有，交给实时行情腿
  });

  it('noBarYmd 只豁免「当日」：其它无 bar 日（停牌 / 非交易日）仍然不产出', () => {
    // 10-31 没有 bar，但 noBarYmd 是 11-02 ⇒ 不属于「当日豁免」⇒ 照旧不产出
    const m = computeQtDayPatches(bars, ['2026-10-31'], { noBarYmd: '2026-11-02' });
    expect(m.size).toBe(0);
  });
});

describe('trend-patch · ensureTrendPatch 集成 · 同花顺停用（FUYAO_OFF=true）⇒ 走腾讯腿', () => {
  const todayYmd = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('停用时：K 线腿改走 fetchQtDailyBars，fuyao 两腿一个请求都不发', async () => {
    isFuyaoOff.mockReturnValue(true);
    const hist = '2026-10-30';
    fetchQtDailyBars.mockResolvedValue(new Map([
      ['002242', [
        { ymd: '2026-10-29', open: 22.380, close: 23.000, volHand: 1172052 },
        { ymd: '2026-10-30', open: 21.860, close: 22.140, volHand: 1039511 }
      ]]
    ]));

    const result = await ensureTrendPatch(
      [{ stock: '九阳股份', code: '002242' }],
      new Map([['九阳股份', [hist]]])
    );
    const day = result.get('九阳股份').get(hist);
    expect(day.changePct).toBeCloseTo((22.140 / 23.000 - 1) * 100, 2);
    expect(day.aucPctChg).toBeCloseTo((21.860 / 23.000 - 1) * 100, 2);
    expect(day.yestVolume).toBeCloseTo(11720.52, 1);
    // 历史日竞价量/量比：日线里没有 9:25 瞬时值 ⇒ null（§10 宁缺勿错，⛔ 不拿全天量冒充）
    expect(day.volume).toBeNull();
    expect(day.aucVolRatio).toBeNull();
    // ⛔ 停用期间同花顺通道必须零请求
    expect(fetchFuyaoDailyPctRange).not.toHaveBeenCalled();
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('停用时：快照腿【受控放行】—— 只走这一个端点、必须显式 allowWhenOff + 硬超时', async () => {
    isFuyaoOff.mockReturnValue(true);
    fetchQtDailyBars.mockResolvedValue(new Map([
      ['600825', [
        { ymd: '2026-10-29', open: 13.8, close: 13.9, volHand: 480000 },
        { ymd: todayYmd, open: 14.0, close: 14.2, volHand: 500000 }
      ]]
    ]));
    fuyaoApiGet.mockResolvedValue({
      timestamp: Date.now(), data_status: 'final',
      item: [{ thscode: '600825.SH', auction_volume: 36365.21, auction_pct: -1.8553, auction_volume_ratio: 1.37 }]
    });
    const result = await ensureTrendPatch(
      [{ stock: '新华传媒', code: '600825' }],
      new Map([['新华传媒', [todayYmd]]]),
      { nowHms: '09:26:00' }
    );
    const day = result.get('新华传媒').get(todayYmd);
    // 竞价量/量比在别处【没有任何等价来源】（腾讯 [49] 量比是另一个口径）⇒ 必须靠这条腿
    expect(day.volume).toBeCloseTo(363.6521, 3);
    expect(day.aucVolRatio).toBeCloseTo(1.37, 5);
    expect(day.aucPctChg).toBeCloseTo(-1.8553, 4);
    expect(day.yestVolume).toBeCloseTo(4800, 0);
    // ★ [FUYAO-SNAPSHOT 2026-11-02] 受控放行三条：端点精确 / 显式 allowWhenOff / timeoutMs>0
    expect(fuyaoApiGet).toHaveBeenCalledTimes(1);
    const call = fuyaoApiGet.mock.calls[0];
    expect(call[0]).toBe('/api/a-share/auction/snapshot');
    expect(call[2] && call[2].allowWhenOff).toBe(true);
    expect(call[2] && call[2].timeoutMs).toBeGreaterThan(0);
    // 同花顺 K 线腿仍然零请求（总闸照旧，⛔ 不是把总闸打开）
    expect(fetchFuyaoDailyPctRange).not.toHaveBeenCalled();
  });

  it('停用时 + 快照腿失败 ⇒ 腾讯实时行情兜底：竞价涨幅/涨幅补上，竞价量仍 null（§10 不冒充）', async () => {
    isFuyaoOff.mockReturnValue(true);
    // ★ 复刻 2026-11-02 实测：竞价期腾讯【日线】没有今天这根 bar（最后一根是上一交易日）
    fetchQtDailyBars.mockResolvedValue(new Map([
      ['002242', [
        { ymd: '2026-10-29', open: 22.380, close: 23.000, volHand: 1172052 },
        { ymd: '2026-10-30', open: 21.860, close: 22.140, volHand: 1039511 }
      ]]
    ]));
    fuyaoApiGet.mockRejectedValue(new Error('upstream boom'));
    fetchQtRealtimeQuotes.mockResolvedValue(new Map([
      ['002242', { ymd: todayYmd, hms: '09:26:03', price: 21.50, prevClose: 22.14, open: 21.50, volHand: 25521 }]
    ]));
    const result = await ensureTrendPatch(
      [{ stock: '九阳股份', code: '002242' }],
      new Map([['九阳股份', [todayYmd]]]),
      { nowHms: '09:26:00' }
    );
    const day = result.get('九阳股份').get(todayYmd);
    // 昨日成交量：今天没有 bar，但只需要【上一交易日那一根】⇒ 必须补齐（用户点名的两个字段之一）
    expect(day.yestVolume).toBeCloseTo(10395.11, 1);
    expect(day.aucPctChg).toBeCloseTo(-2.89, 2);   // 21.50/22.14-1 = -2.8907%（同花顺 auction_pct 同值）
    expect(day.changePct).toBeCloseTo(-2.89, 2);   // 竞价期 change_pct 就是竞价涨幅（与 worker 9:25 同口径）
    expect(day.volume).toBeNull();                 // ⛔ 竞价量没有合法来源，绝不拿全天成交量冒充
    expect(day.aucVolRatio).toBeNull();
  });
});
