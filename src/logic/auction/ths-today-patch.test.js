// ths-today-patch.test.js — 「同花顺临时补今日竞价」的回归护栏
//
// 事故背景（2026-10-26）：猫抓 numcat 每日只有 10 次额度，两把 key 同时 403 ⇒
// market_metrics 当天 0 行 ⇒ 全站看板"加载中"。用户要求「用同花顺接口临时补下数据」。
//
// 这组用例锁住四条红线：
//   ① 字段格式必须与库内既有行逐字一致（否则看板把 "+10.00%" 当脏值丢掉）
//   ② ⛔ 只填空字段：库里已有值一律不覆盖（幂等 / 不破坏 worker 的正确数据）
//   ③ ⛔ 双重日期闸门：快照非终态或服务端日不符 ⇒ 竞价量/量比一律不写（防跨日写错）
//   ④ ⛔ 只允许补「今天」；读名单失败 / 名单为空 必须如实返回 ok:false，不伪装成功

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TODAY = '2026-10-26';

vi.mock('../../data/auction-metrics-patch.js', () => ({
  readAuctionRoster: vi.fn(),
  readAuctionMetrics: vi.fn(),
  upsertAuctionMetrics: vi.fn(),
  AUCTION_SCOPE: 'auction',
}));
vi.mock('../../data/daily-pct-range.js', () => ({ fetchDailyPctRange: vi.fn() }));
vi.mock('../../data/api/fuyao-proxy.js', () => ({
  fuyaoApiGet: vi.fn(),
  tickerToThscode: function(c) { return /^\d{6}$/.test(c) ? c + '.SH' : c; },
}));
vi.mock('./auction-pull-window.js', () => ({ beijingTodayStr: () => '2026-10-26' }));
vi.mock('../../data/debug-log.js', () => ({ _dbgLog: () => {} }));
// ★ [VOL-COVER 2026-11-05] 「展示名单」由 dragon-rank 提供；这里换成可控夹具，
//   用来验证「补数目标 = 展示名单，而不只是 auction_watchlist」这条新口径。
vi.mock('./dragon-rank.js', () => ({ getDragonTargetRows: vi.fn(() => []) }));
// ★ [CODE-ON-DEMAND 2026-11-05] 内存缓存里查不到的股票名，靠 stockcodemap 按名补一次。
//   E2E 实测：观察组壳行没有 code ⇒ 被 /^\d{6}$/ 静默滤掉 ⇒ 那两只永远 "-"。
//   （日志：「展示名单 78 只，其中带 6 位代码 76 只」）
const codeMapMock = vi.hoisted(() => ({ codes: {}, resolved: {}, asked: [] }));
vi.mock('../../data/stock-code-map.js', () => ({
  getStockCode: vi.fn(function(n) { return codeMapMock.codes[n] || ''; }),
  resolveStockCodes: vi.fn(async function(names) {
    codeMapMock.asked = (names || []).slice();
    const out = new Map();
    (names || []).forEach(function(n) { if (codeMapMock.resolved[n]) out.set(n, codeMapMock.resolved[n]); });
    return out;
  }),
}));

import {
  patchTodayAuctionFromThs,
  autoFillTodayAuctionVolume,
  _resetAutoFillForTest,
  fmtPct, fmtIntVol, fmtRatio,
  _resetThsPatchForTest,
} from './ths-today-patch.js';
import { readAuctionRoster, readAuctionMetrics, upsertAuctionMetrics } from '../../data/auction-metrics-patch.js';
import { fetchDailyPctRange } from '../../data/daily-pct-range.js';
import { fuyaoApiGet } from '../../data/api/fuyao-proxy.js';
import { getDragonTargetRows } from './dragon-rank.js';

/** 北京某天的时间戳（快照顶层 timestamp 用它做日期闸门） */
const TS_TODAY = Date.parse('2026-10-26T15:00:00+08:00');
const TS_PREV = Date.parse('2026-10-23T15:00:00+08:00');

/** 默认上游夹具：票A 有完整三腿，票B 只有 K 线腿 */
function setUpstream(over) {
  const o = over || {};
  fetchDailyPctRange.mockImplementation(async function(items, dates, opts) {
    const out = new Map();
    items.forEach(function(it) {
      out.set(it.stock, new Map(o.pct && o.pct[it.stock] ? o.pct[it.stock] : []));
      if (opts && opts.openOut) opts.openOut.set(it.stock, new Map(o.open && o.open[it.stock] ? o.open[it.stock] : []));
      if (opts && opts.volOut) opts.volOut.set(it.stock, new Map(o.vol && o.vol[it.stock] ? o.vol[it.stock] : []));
    });
    return out;
  });
  fuyaoApiGet.mockResolvedValue({
    timestamp: o.snapTs || TS_TODAY,
    data_status: o.snapStatus || 'final',
    item: o.snapItems || [
      { thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49, auction_volume_ratio: 12.5, auction_turnover_pct: 2.271 },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetThsPatchForTest();
  _resetAutoFillForTest();
  getDragonTargetRows.mockReturnValue([]);
  codeMapMock.codes = {};
  codeMapMock.resolved = {};
  codeMapMock.asked = [];
  readAuctionRoster.mockResolvedValue([{ stock: '票A', code: '600001' }]);
  readAuctionMetrics.mockResolvedValue([]);
  upsertAuctionMetrics.mockImplementation(async function(rows) { return rows.length; });
  setUpstream({
    pct: { 票A: [['20261026', -3.77]] },
    open: { 票A: [['20261026', -2.5]] },
    vol: { 票A: [['20261023', 61370000]] },   // 前一交易日成交量（股）→ 6137 万股
  });
});

describe('字段格式（必须与库内既有行逐字一致）', () => {
  it('fmtPct：正数带 +，负数原样，两位小数，百分号', () => {
    expect(fmtPct(10)).toBe('+10.00%');
    expect(fmtPct(-3.77)).toBe('-3.77%');
    expect(fmtPct(0)).toBe('0.00%');
    // ⚠️ 3.215 在 IEEE754 里实际是 3.21499999… ⇒ toFixed(2) 得 "3.21"（不是 3.22）。
    //    这是 JS 浮点行为，不是本函数的 bug；上游给的就是这种小数，照着格式化即可。
    expect(fmtPct(3.215)).toBe('+3.21%');
    expect(fmtPct(3.216)).toBe('+3.22%');
  });

  it('fmtPct：null / 非数 / 空串 ⇒ null（⛔ 不补 0、不写成 "0.00%"）', () => {
    expect(fmtPct(null)).toBe(null);
    expect(fmtPct(undefined)).toBe(null);
    expect(fmtPct(NaN)).toBe(null);
    // ★ 空串必须算缺失：Number('') === 0，不拦住就会把"没有值"写成 "0.00%"（编造数据）
    expect(fmtPct('')).toBe(null);
    expect(fmtPct('   ')).toBe(null);
  });

  it('fmtIntVol：整数万股；0 / 负数 / 空 ⇒ null', () => {
    expect(fmtIntVol(612.4)).toBe('612');
    expect(fmtIntVol(6137)).toBe('6137');
    expect(fmtIntVol(0)).toBe(null);
    expect(fmtIntVol(-5)).toBe(null);
    expect(fmtIntVol(null)).toBe(null);
  });

  it('fmtRatio：两位小数、无单位', () => {
    expect(fmtRatio(55.184)).toBe('55.18');
    expect(fmtRatio(12.5)).toBe('12.50');
    expect(fmtRatio(null)).toBe(null);
  });
});

describe('patchTodayAuctionFromThs — 闸门', () => {
  it('⛔ 只允许补今天：历史日直接拒绝', async () => {
    const r = await patchTodayAuctionFromThs('2026-10-23');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('只允许补今天');
    expect(readAuctionRoster).not.toHaveBeenCalled();
  });

  it('名单为空 ⇒ ok:false，不写库（⛔ 不伪装成功）', async () => {
    readAuctionRoster.mockResolvedValue([]);
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('名单为空');
    expect(upsertAuctionMetrics).not.toHaveBeenCalled();
  });

  it('名单里没有 6 位代码 ⇒ ok:false（§40 不猜代码）', async () => {
    readAuctionRoster.mockResolvedValue([{ stock: '票A', code: '' }]);
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(upsertAuctionMetrics).not.toHaveBeenCalled();
  });

  it('读名单抛错 ⇒ 向上抛（§10 读失败不伪装成"没数据"）', async () => {
    readAuctionRoster.mockRejectedValue(new Error('network'));
    await expect(patchTodayAuctionFromThs(TODAY)).rejects.toThrow('network');
  });
});

describe('patchTodayAuctionFromThs — 组装（库里 0 行的场景 = 今天真实情况）', () => {
  it('★ 全空库 ⇒ 一次补齐四要素 + 竞价量比', async () => {
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    expect(r.patchedRows).toBe(1);
    const rows = upsertAuctionMetrics.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.date).toBe(TODAY);
    expect(row.stock).toBe('票A');
    expect(row.scope).toBe('auction');
    expect(row.change_pct).toBe('-3.77%');       // K 线腿
    expect(row.auc_pct_chg).toBe('+3.21%');      // 快照终态优先于 K线 open(-2.5)
    expect(row.yest_volume).toBe('6137');        // 前一交易日量 → 万股
    expect(row.volume).toBe('388');              // 38830.49 手 ÷100 = 388 万股
    // ⛔ 竞价量比(auc_vol_ratio) 不补：同花顺 auction_volume_ratio 与猫爪 auc_vol_ratio
    //   口径不同源，补上去就是错数据（用户 2026-10-26：「额度用完了就留空」）
    expect(row.auc_vol_ratio).toBeUndefined();
    expect(row.auc_turnover).toBe('2.27');       // ← auction_turnover_pct，两位小数
    // ⛔ um_vol / open_bid_pct 不在同花顺快照能力内 ⇒ 必须留空（§40 不猜）
    expect(row.um_vol).toBeUndefined();
    expect(row.open_bid_pct).toBeUndefined();
  });

  it('新行如实标注来源 ths-patch（⛔ 不冒充 worker）', async () => {
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.source).toBe('ths-patch');
    expect(row.updated_by).toBe('ths-patch');
  });
});

describe('patchTodayAuctionFromThs — ⛔ 只填空，已有值不覆盖（幂等）', () => {
  it('库里 change_pct 已有值 ⇒ 提交行不含该字段（merge 语义下原值保留）', async () => {
    readAuctionMetrics.mockResolvedValue([{ stock: '票A', change_pct: '+5.00%', auc_pct_chg: '', volume: '', yest_volume: '', auc_vol_ratio: '' }]);
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.change_pct).toBeUndefined();      // 绝不覆盖
    expect(row.auc_pct_chg).toBe('+3.21%');      // 空字段照补
  });

  it('已有行不再写 source（不篡改 worker 写的来源标记）', async () => {
    readAuctionMetrics.mockResolvedValue([{ stock: '票A', change_pct: '', auc_pct_chg: '', volume: '', yest_volume: '', auc_vol_ratio: '' }]);
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.source).toBeUndefined();
  });

  it('所有字段都已完整 ⇒ 一次写库都不发，reason="已完整"', async () => {
    readAuctionMetrics.mockResolvedValue([{
      stock: '票A', change_pct: '+5.00%', auc_pct_chg: '+2.00%',
      volume: '100', yest_volume: '5000', auc_vol_ratio: '3.00', auc_turnover: '2.27',
    }]);
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    expect(r.patchedRows).toBe(0);
    expect(r.reason).toContain('已完整');
    expect(upsertAuctionMetrics).not.toHaveBeenCalled();
  });

  it('auc_turnover 已有值 ⇒ 不覆盖（它也是"只填空"的一员）', async () => {
    // 留一个空字段（auc_pct_chg）保证这一行确实会提交，才能观察到"换手没被覆盖"
    readAuctionMetrics.mockResolvedValue([{
      stock: '票A', change_pct: '+5.00%', auc_pct_chg: '',
      volume: '100', yest_volume: '5000', auc_vol_ratio: '3.00', auc_turnover: '9.99',
    }]);
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.auc_turnover).toBeUndefined();    // 库里 9.99 保留，不写 2.27
    expect(row.auc_pct_chg).toBe('+3.21%');      // 同一次提交里空字段照补
  });
});

describe('patchTodayAuctionFromThs — 快照双重日期闸门（防把上一交易日写到今天）', () => {
  it('data_status 非 final ⇒ 竞价量 / 量比一律不写（K 线腿照常补）', async () => {
    setUpstream({
      pct: { 票A: [['20261026', -3.77]] },
      open: { 票A: [['20261026', -2.5]] },
      vol: { 票A: [['20261023', 61370000]] },
      snapStatus: 'not_ready',
    });
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.volume).toBeUndefined();
    expect(row.auc_vol_ratio).toBeUndefined();
    // K 线腿不受影响
    expect(row.change_pct).toBe('-3.77%');
    // 竞价涨幅退回 K 线 open 换算值（-2.5），⛔ 不用非终态的 auction_pct
    expect(row.auc_pct_chg).toBe('-2.50%');
  });

  it('快照服务端日期 ≠ 目标日（滚动上一交易日）⇒ 竞价量 / 量比一律不写', async () => {
    setUpstream({ snapTs: TS_PREV, snapStatus: 'final' });
    await patchTodayAuctionFromThs(TODAY);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.volume).toBeUndefined();
    expect(row.auc_vol_ratio).toBeUndefined();
  });

  it('K 线腿失败 ⇒ 只降级该腿，快照腿仍然补（不整体失败）', async () => {
    fetchDailyPctRange.mockRejectedValue(new Error('kline down'));
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.change_pct).toBeUndefined();
    expect(row.volume).toBe('388');
    // ⛔ 竞价量比(auc_vol_ratio) 不补：同花顺 auction_volume_ratio 与猫爪 auc_vol_ratio
    //   口径不同源，补上去就是错数据（用户 2026-10-26：「额度用完了就留空」）
    expect(row.auc_vol_ratio).toBeUndefined();
  });

  it('快照腿失败 ⇒ 只降级该腿，K 线腿仍然补', async () => {
    fuyaoApiGet.mockRejectedValue(new Error('snapshot down'));
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.change_pct).toBe('-3.77%');
    expect(row.volume).toBeUndefined();
  });
});

describe('patchTodayAuctionFromThs — §32 单飞', () => {
  it('并发调用只跑一次上游（连点按钮不会重复烧请求）', async () => {
    const [a, b] = await Promise.all([
      patchTodayAuctionFromThs(TODAY),
      patchTodayAuctionFromThs(TODAY),
    ]);
    expect(a).toBe(b);                            // 同一个 Promise 结果
    expect(readAuctionRoster).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★ [VOL-COVER 2026-11-05] 用户第 9 次报障的护栏：
//   「襄阳轴承五日趋势图有当天竞价量，第一页的竞价量却显示横杠……这是一类问题」
//   「上海洗霸和大洋电机也没有当天数据」
//   根因两条，各用一组用例锁死：
//   ① 补数目标名单必须 = 【展示名单】（含观察组/20日补位壳行），不能只认 auction_watchlist；
//   ② 自动补必须受时间闸 + 缺口预检约束，且只走快照腿（不烧 K 线腿）。
// ══════════════════════════════════════════════════════════════════════════

describe('展示名单口径（补数目标 ≠ worker 抓取名单）', () => {
  it('只在视图里出现的票（观察组/20日补位壳行）也在补数目标内', async () => {
    // 正式名单只有票A；票B 只在展示名单里（今天四张表都没有它 —— 上海洗霸/大洋电机就是这个形状）
    getDragonTargetRows.mockReturnValue([{ stock: '票A', code: '600001' }, { stock: '票B', code: '600002' }]);
    fuyaoApiGet.mockResolvedValue({
      timestamp: TS_TODAY,
      data_status: 'final',
      item: [
        { thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49, auction_turnover_pct: 2.271 },
        { thscode: '600002.SH', auction_pct: -1.1, auction_volume: 12300, auction_turnover_pct: 0.9 },
      ],
    });
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    const rows = upsertAuctionMetrics.mock.calls[0][0];
    const names = rows.map((x) => x.stock).sort();
    expect(names).toEqual(['票A', '票B']);
    // 票B 是整行新建（库里原本一行都没有）⇒ 必须如实标来源，⛔ 不冒充 worker
    const b = rows.find((x) => x.stock === '票B');
    expect(b.source).toBe('ths-patch');
    expect(b.volume).toBe('123');   // 12300 手 ÷ 100 = 123 万股
  });

  it('⛔ 竞价量比(auc_vol_ratio) 永不补 —— 即使快照里有这个字段', async () => {
    fuyaoApiGet.mockResolvedValue({
      timestamp: TS_TODAY,
      data_status: 'final',
      item: [{ thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49, auction_volume_ratio: 12.5 }],
    });
    await patchTodayAuctionFromThs(TODAY);
    const rows = upsertAuctionMetrics.mock.calls[0][0];
    rows.forEach((x) => expect(x.auc_vol_ratio).toBeUndefined());
  });
});

describe('autoFillTodayAuctionVolume — 自动补的闸门', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** 把「现在」定在北京某时刻（只伪造 Date，setTimeout/Promise 保持真实） */
  function setBeijing(iso) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  it('⛔ 非当天 ⇒ 一个请求都不发', async () => {
    setBeijing('2026-10-26T10:00:00+08:00');
    const r = await autoFillTodayAuctionVolume('2026-10-23');
    expect(r.ok).toBe(false);
    expect(readAuctionRoster).not.toHaveBeenCalled();
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('⛔ 9:25 之前 ⇒ 不补（快照还是上一交易日）', async () => {
    setBeijing('2026-10-26T09:24:00+08:00');
    const r = await autoFillTodayAuctionVolume(TODAY);
    expect(r.ok).toBe(false);
    expect(String(r.skipped)).toContain('9:25');
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('⛔ 15:00 之后 ⇒ 不补（交给收盘覆盖链路）', async () => {
    setBeijing('2026-10-26T15:00:00+08:00');
    const r = await autoFillTodayAuctionVolume(TODAY);
    expect(r.ok).toBe(false);
    expect(String(r.skipped)).toContain('收盘');
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('竞价量已齐 ⇒ 判「无缺口」，不发快照请求', async () => {
    setBeijing('2026-10-26T09:30:00+08:00');
    readAuctionMetrics.mockResolvedValue([{ stock: '票A', volume: '388' }]);
    const r = await autoFillTodayAuctionVolume(TODAY);
    expect(r.ok).toBe(true);
    expect(r.missing).toBe(0);
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('有缺口 ⇒ 只走快照腿（⛔ 不跑 K 线腿，省上游请求）', async () => {
    setBeijing('2026-10-26T09:30:00+08:00');
    const r = await autoFillTodayAuctionVolume(TODAY);
    expect(r.ok).toBe(true);
    expect(r.patchedRows).toBeGreaterThan(0);
    expect(fetchDailyPctRange).not.toHaveBeenCalled();
    expect(fuyaoApiGet).toHaveBeenCalled();
  });

  it('§32：同一批缺口 30s 内不重复补（连调不会重复烧请求）', async () => {
    setBeijing('2026-10-26T09:30:00+08:00');
    await autoFillTodayAuctionVolume(TODAY);
    const callsAfterFirst = fuyaoApiGet.mock.calls.length;
    await autoFillTodayAuctionVolume(TODAY);   // 30s 内、缺口指纹与上次完全相同
    expect(fuyaoApiGet.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('快照腿必须「受控放行」（否则总闸一开，这条腿就静默死掉）', () => {
  it('调用上游时必须带 allowWhenOff + timeoutMs（2026-11-05 第一页整列 "-" 的直接成因）', async () => {
    await patchTodayAuctionFromThs(TODAY);
    const call = fuyaoApiGet.mock.calls.find((c) => c[0] === '/api/a-share/auction/snapshot');
    expect(call).toBeTruthy();
    const opts = call[2] || {};
    // 这两条是 fuyao-proxy.js#fuyaoApiGet 的放行条件（缺一条就 throw，且是在 new URL 之前抛）
    expect(opts.allowWhenOff).toBe(true);
    expect(Number(opts.timeoutMs)).toBeGreaterThan(0);
  });
});

describe('补数目标的最后一块：调用方「当前渲染的行」', () => {
  it('obsBought / 龙头组壳行由调用方传入 ⇒ 也进补数目标（上海洗霸 / 大洋电机 的形状）', async () => {
    // 这两只既不在 auction_watchlist，也不在 getDragonTargetRows 的可见集合里，
    // 但它们确实显示在第一页（观察组壳行）⇒ 必须能补到，否则永远是 '-'
    getDragonTargetRows.mockReturnValue([{ stock: '票A', code: '600001' }]);
    fuyaoApiGet.mockResolvedValue({
      timestamp: TS_TODAY,
      data_status: 'final',
      item: [
        { thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49 },
        { thscode: '600003.SH', auction_pct: 0.5, auction_volume: 4560 },
      ],
    });
    const r = await patchTodayAuctionFromThs(TODAY, { extraStocks: [{ stock: '票C', code: '600003' }] });
    expect(r.ok).toBe(true);
    const names = upsertAuctionMetrics.mock.calls[0][0].map((x) => x.stock).sort();
    expect(names).toEqual(['票A', '票C']);
    const c = upsertAuctionMetrics.mock.calls[0][0].find((x) => x.stock === '票C');
    expect(c.volume).toBe('46');   // 4560 手 ÷ 100 = 45.6 → 四舍五入 46 万股
  });

  it('autoFill 也会把 displayStocks 透传下去', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T09:30:00+08:00'));
    fuyaoApiGet.mockResolvedValue({
      timestamp: TS_TODAY, data_status: 'final',
      item: [{ thscode: '600003.SH', auction_pct: 0.5, auction_volume: 4560 }],
    });
    readAuctionMetrics.mockResolvedValue([{ stock: '票A', volume: '388' }]);  // 正式名单那只已齐
    const r = await autoFillTodayAuctionVolume(TODAY, { displayStocks: [{ stock: '票C', code: '600003' }] });
    expect(r.missing).toBe(1);
    expect(r.patchedRows).toBe(1);
    vi.useRealTimers();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★ [CODE-ON-DEMAND 2026-11-05] 补数目标名单的第四块拼图：**代码**。
//
//   事故（E2E 第三次实测）：名单已经 78 只全对，日志却写着
//     「展示名单 78 只，其中带 6 位代码 76 只」
//   ⇒ 缺代码的 2 只（上海洗霸 / 大洋电机）被 /^\d{6}$/ 静默滤掉，
//     既不算缺口也不会报错，页面永远 "-"。这类「静默过滤」是最难查的形状。
//
//   修法：内存缓存查不到 ⇒ 按名去 stockcodemap 精确补一次（1 个请求）。
//   这里锁死三件事：
//     ① 补到代码的票必须真的进补数队列（不是补完就忘）；
//     ② ⛔ 只对「没有代码」的票发请求（§32，不许把整个名单再问一遍）；
//     ③ 补失败必须降级为「跳过这几只」而不是整条链挂掉。
// ══════════════════════════════════════════════════════════════════════════

describe('按名补代码（壳行没有 code 时的最后一道兜底）', () => {
  it('extraStocks 缺 code ⇒ 补到后仍能写入竞价量（上海洗霸 / 大洋电机的形状）', async () => {
    getDragonTargetRows.mockReturnValue([{ stock: '票A', code: '600001' }]);
    codeMapMock.resolved['上海洗霸'] = '603200';
    fuyaoApiGet.mockResolvedValue({
      timestamp: TS_TODAY,
      data_status: 'final',
      item: [
        { thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49 },
        { thscode: '603200.SH', auction_pct: -0.8, auction_volume: 15948.86 },
      ],
    });
    const r = await patchTodayAuctionFromThs(TODAY, { extraStocks: [{ stock: '上海洗霸' }] });
    expect(r.ok).toBe(true);
    // ① 真的按名去查了，而且只查那 1 只（票A 自己有代码 ⇒ 不许再问）
    expect(codeMapMock.asked).toEqual(['上海洗霸']);
    // ② 补到的票必须进补数队列并落库
    const rows = upsertAuctionMetrics.mock.calls[0][0];
    const names = rows.map((x) => x.stock);
    expect(names).toContain('上海洗霸');
    const sh = rows.find((x) => x.stock === '上海洗霸');
    expect(sh.volume).toBe('159');     // 15948.86 手 ÷ 100 = 159.49 → 159 万股
    expect(sh.code).toBe('603200');
  });

  it('⛔ 按名补不到代码 ⇒ 只跳过这只，其余照旧补（不整条链失败）', async () => {
    getDragonTargetRows.mockReturnValue([{ stock: '票A', code: '600001' }]);
    // resolved 里故意不登记 => resolveStockCodes 返回空 Map（stockcodemap 里确实没有）
    const r = await patchTodayAuctionFromThs(TODAY, { extraStocks: [{ stock: '查不到的票' }] });
    expect(r.ok).toBe(true);
    expect(codeMapMock.asked).toEqual(['查不到的票']);
    const names = upsertAuctionMetrics.mock.calls[0][0].map((x) => x.stock);
    expect(names).toContain('票A');
    expect(names).not.toContain('查不到的票');
  });

  it('名单全部自带代码 ⇒ 一次都不发补码请求（§32 不重复请求）', async () => {
    getDragonTargetRows.mockReturnValue([{ stock: '票A', code: '600001' }, { stock: '票C', code: '600003' }]);
    await patchTodayAuctionFromThs(TODAY);
    expect(codeMapMock.asked).toEqual([]);
  });
});
