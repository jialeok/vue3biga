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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TODAY = '2026-10-26';

vi.mock('../../data/auction-metrics-patch.js', () => ({
  readAuctionRoster: vi.fn(),
  readAuctionMetrics: vi.fn(),
  upsertAuctionMetrics: vi.fn(),
  AUCTION_SCOPE: 'auction',
}));
vi.mock('../../data/stock-range-pct.js', () => ({ fetchFuyaoDailyPctRange: vi.fn() }));
vi.mock('../../data/api/fuyao-proxy.js', () => ({
  fuyaoApiGet: vi.fn(),
  tickerToThscode: function(c) { return /^\d{6}$/.test(c) ? c + '.SH' : c; },
}));
vi.mock('./auction-pull-window.js', () => ({ beijingTodayStr: () => '2026-10-26' }));
vi.mock('../../data/debug-log.js', () => ({ _dbgLog: () => {} }));

import {
  patchTodayAuctionFromThs,
  fmtPct, fmtIntVol, fmtRatio,
  _resetThsPatchForTest,
} from './ths-today-patch.js';
import { readAuctionRoster, readAuctionMetrics, upsertAuctionMetrics } from '../../data/auction-metrics-patch.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { fuyaoApiGet } from '../../data/api/fuyao-proxy.js';

/** 北京某天的时间戳（快照顶层 timestamp 用它做日期闸门） */
const TS_TODAY = Date.parse('2026-10-26T15:00:00+08:00');
const TS_PREV = Date.parse('2026-10-23T15:00:00+08:00');

/** 默认上游夹具：票A 有完整三腿，票B 只有 K 线腿 */
function setUpstream(over) {
  const o = over || {};
  fetchFuyaoDailyPctRange.mockImplementation(async function(items, dates, opts) {
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
      { thscode: '600001.SH', auction_pct: 3.21, auction_volume: 38830.49, auction_volume_ratio: 12.5 },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetThsPatchForTest();
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
    expect(row.auc_vol_ratio).toBe('12.50');
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
      volume: '100', yest_volume: '5000', auc_vol_ratio: '3.00',
    }]);
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    expect(r.patchedRows).toBe(0);
    expect(r.reason).toContain('已完整');
    expect(upsertAuctionMetrics).not.toHaveBeenCalled();
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
    fetchFuyaoDailyPctRange.mockRejectedValue(new Error('kline down'));
    const r = await patchTodayAuctionFromThs(TODAY);
    expect(r.ok).toBe(true);
    const row = upsertAuctionMetrics.mock.calls[0][0][0];
    expect(row.change_pct).toBeUndefined();
    expect(row.volume).toBe('388');
    expect(row.auc_vol_ratio).toBe('12.50');
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
