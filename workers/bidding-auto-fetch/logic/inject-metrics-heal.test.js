// inject-metrics-heal.test.js — [R30-METRICS-HEAL 2026-11-23] 补位票「历史日整行都不存在」的补建回归锁
//
// 用户报障：「今天不能重补下30日强势补位票的数据吗？也就是那两只，现在数据只有三个，
//   趋势图也是几乎空白的，能补吗？」
//
// 真实库病根：百洋股份 11-17~11-20 在 market_metrics **一行都没有**（不是字段空，是没行），
//   11-23 只有 ths-patch 写的 volume/auc_pct_chg/auc_turnover，量比/昨量/涨幅全 null。
//   ⇒ 既有的 extras 链路（只补已存在行的字段）对它无效 —— 必须先**新建行**。
//
// 本文件锁住六条不变量：
//   ① 缺行 ⇒ 新建；已有行 ⇒ 只补空位（⛔ 不覆盖 ths-patch 已写的竞价量）；
//   ② 历史日的 change_pct 用【同花顺日线真值】，窗口末日用猫抓的竞价副本；
//   ③ 猫抓某天没给值 ⇒ 那一天**不建行**（⛔ 不造空行冒充「有数据」，§10）；
//   ④ 库内已完整 ⇒ 零猫抓请求（不白烧额度，§32）；
//   ⑤ 查不到 code 的票 ⇒ 不发请求、逐只留痕；
//   ⑥ 猫抓失败 ⇒ ok=false，且一行都不写。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInjectedMetricsBackfill } from './inject-metrics-heal.js';

const h = vi.hoisted(() => ({
  cal: [], existing: [], r30: [], r20: [], codeMap: {}, codeByName: {},
  aucRows: [], aucFail: false, numcatCalls: 0,
  bars: new Map(), barPcts: new Map(), upserted: []
}));

vi.mock('../data/supabase-write.js', () => ({
  readMarketMetricsRowsForDate: async (env, date) => {
    return h.existing.filter(r => r.date === date).map(r => {
      const c = Object.assign({}, r);
      delete c.date;
      return c;
    });
  },
  readStockCodeMap: async () => h.codeMap,
  readCodesFromMetricsByNames: async () => h.codeByName,
  readRange30TopForDate: async () => h.r30,
  readRange20TopForDate: async () => h.r20,
  upsertMarketMetrics: async (env, rows) => { h.upserted.push(rows); }
}));
vi.mock('./holiday-check.js', () => ({
  getRecentTradingDays: async () => h.cal
}));
vi.mock('../data/numcat-api.js', () => ({
  numcatDailyAuc: async () => {
    h.numcatCalls++;
    if (h.aucFail) throw new Error('numcat 403 额度用尽');
    return { fields: FIELDS, items: h.aucRows };
  }
}));
vi.mock('../data/fuyao-api.js', () => ({
  fetchFuyaoBatchBars: async () => h.bars,
  barsToDailyPctMap: () => h.barPcts
}));

const FIELDS = ['symbol', 'name', 'tradedate', 'auc_vol', 'auc_pct_chg',
  'auc_to_pre_vol_pct', 'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];

const CAL = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'];
const LAST = '2026-11-23';

/** auc_vol(手) / auc_pct_chg / 占比 / um_vol / obp / 量比 / 换手 */
function aucRow(code, name, ymd, o) {
  const d = o || {};
  return [code, name, ymd.replace(/-/g, ''),
    d.vol === undefined ? 50000 : d.vol,
    d.pct === undefined ? 1.5 : d.pct,
    d.ratio === undefined ? 2.5 : d.ratio,
    d.um === undefined ? 1200 : d.um,
    d.obp === undefined ? 0.8 : d.obp,
    d.avr === undefined ? 4.2 : d.avr,
    d.atr === undefined ? 1.1 : d.atr];
}

function setup() {
  h.cal = CAL.slice();
  h.existing = [];
  h.r30 = [];
  h.r20 = [];
  h.codeMap = {};
  h.codeByName = {};
  h.aucRows = [];
  h.aucFail = false;
  h.numcatCalls = 0;
  h.bars = new Map();
  h.barPcts = new Map();
  h.upserted = [];
}

describe('runInjectedMetricsBackfill — 补位票历史行情补建', () => {
  beforeEach(setup);

  it('★ ① 缺行新建 + 已有行只补空位（⛔ 不覆盖 ths-patch 已写的竞价量）', async () => {
    h.codeMap = { 百洋股份: '002696' };
    // 库内只有「当天」一行，且 volume/auc_pct_chg 已由 ths-patch 写过
    h.existing = [{
      date: LAST, name: '百洋股份', code: '002696',
      volume: '163', auc_pct_chg: '+1.50%', auc_turnover: '0.49',
      yest_volume: '', change_pct: '', um_vol: '', open_bid_pct: '', auc_vol_ratio: ''
    }];
    // 猫抓给满整个窗口（含当天 —— 当天就是靠它补量比/昨量这些 ths-patch 补不了的项）
    h.aucRows = CAL.map(d => aucRow('002696', '百洋股份', d));
    h.bars = new Map([['002696', [{ ymd: '2026-11-20', close: 10 }]]]);
    h.barPcts = new Map([['2026-11-20', 2.0]]);

    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['百洋股份'] });
    expect(r.ok).toBe(true);
    expect(r.targets).toBe(1);
    expect(r.created).toBe(5);          // 11-16~11-20
    expect(r.filled).toBe(1);           // 11-23 补空位
    expect(h.numcatCalls).toBe(1);      // 只烧一次额度

    const rows = h.upserted[0];
    const today = rows.find(x => x.date === LAST);
    // ⛔ 已有非空值一个都不许覆盖
    expect(today.volume).toBeUndefined();
    expect(today.auc_pct_chg).toBeUndefined();
    expect(today.auc_turnover).toBeUndefined();
    // 空位要补上
    expect(today.auc_vol_ratio).toBe('4.20');
    expect(today.yest_volume).toBe('20000');   // 50000 手 ÷ 2.5
    expect(today.um_vol).toBe('12');           // 1200 手 → 12 万手
  });

  it('② 历史日 change_pct 用日线真值，窗口末日用猫抓竞价副本', async () => {
    h.codeMap = { 百洋股份: '002696' };
    h.aucRows = [aucRow('002696', '百洋股份', '2026-11-20', { pct: 1.5 })];
    h.bars = new Map([['002696', [{ ymd: '2026-11-20', close: 10 }]]]);
    h.barPcts = new Map([['2026-11-20', 2.0]]);
    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['百洋股份'] });
    expect(r.created).toBe(1);
    const row = h.upserted[0].find(x => x.date === '2026-11-20');
    expect(row.change_pct).toBe('+2.00%');     // ⛔ 不是 +1.50%（那是竞价涨幅，另存 auc_pct_chg）
    expect(row.auc_pct_chg).toBe('+1.50%');
  });

  it('③ 猫抓某天没给值 ⇒ 那天不建行（⛔ 不造空行冒充有数据）', async () => {
    h.codeMap = { 百洋股份: '002696' };
    // 只给 11-19 一天
    h.aucRows = [aucRow('002696', '百洋股份', '2026-11-19')];
    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['百洋股份'] });
    expect(r.created).toBe(1);
    expect(h.upserted[0].map(x => x.date)).toEqual(['2026-11-19']);
  });

  it('④ 库内已完整 ⇒ 零猫抓请求（不白烧额度）', async () => {
    h.codeMap = { 百洋股份: '002696' };
    h.existing = CAL.map(d => ({
      date: d, name: '百洋股份', code: '002696',
      volume: '100', yest_volume: '9000', change_pct: '+1.00%', auc_pct_chg: '+0.50%',
      um_vol: '1', open_bid_pct: '0.10', auc_vol_ratio: '3.00', auc_turnover: '0.50'
    }));
    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['百洋股份'] });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(0);
    expect(r.filled).toBe(0);
    expect(h.numcatCalls).toBe(0);      // ★ 一次请求都不发
    expect(h.upserted).toHaveLength(0);
  });

  it('⑤ 查不到 code ⇒ 不发请求、逐只留痕（§10）', async () => {
    h.codeMap = {};
    h.codeByName = {};
    const logs = [];
    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['无名票'], logs: logs });
    expect(r.ok).toBe(false);
    expect(r.targets).toBe(0);
    expect(h.numcatCalls).toBe(0);
    expect(logs.some(l => l.indexOf('⚠️ [r30backfill] 1 只查不到 code') === 0 && l.indexOf('无名票') > 0)).toBe(true);
  });

  it('⑥ 猫抓失败 ⇒ ok=false 且一行都不写（⛔ 不许落半截）', async () => {
    h.codeMap = { 百洋股份: '002696' };
    h.aucFail = true;
    const r = await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['百洋股份'] });
    expect(r.ok).toBe(false);
    expect(h.upserted).toHaveLength(0);
  });

  it('⑦ 未指定 stocks 时取「前一交易日 30 日榜 ∪ 20 日榜」并去重', async () => {
    h.r30 = [{ name: '百洋股份', pct: 70 }, { name: '慈文传媒', pct: 67 }];
    h.r20 = [{ name: '慈文传媒', pct: 45 }, { name: '东方海洋', pct: 79 }];
    h.codeMap = { 百洋股份: '002696', 慈文传媒: '002343', 东方海洋: '002086' };
    h.aucRows = [
      aucRow('002696', '百洋股份', LAST),
      aucRow('002343', '慈文传媒', LAST),
      aucRow('002086', '东方海洋', LAST)
    ];
    const r = await runInjectedMetricsBackfill({}, { date: LAST });
    expect(r.targets).toBe(3);          // 慈文传媒只算一次
    expect(r.created).toBe(3);
  });

  it('⑧ 新建行必须带 scope=auction / source=numcat / updated_by，且不写 stock_range / watchlist 字段', async () => {
    h.codeMap = { 慈文传媒: '002343' };
    h.aucRows = [aucRow('002343', '慈文传媒', '2026-11-19')];
    await runInjectedMetricsBackfill({}, { date: LAST, stocks: ['慈文传媒'] });
    const row = h.upserted[0][0];
    expect(row.scope).toBe('auction');
    expect(row.source).toBe('numcat');
    expect(row.updated_by).toBe('worker-r30backfill');
    expect(row.stock).toBe('慈文传媒');
    expect(row.code).toBe('002343');
    // ⛔ 只写行情表，不带任何名单字段
    expect(row.selected).toBeUndefined();
    expect(row.obs_auto_added).toBeUndefined();
  });
});
