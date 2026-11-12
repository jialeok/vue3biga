// leader-diverge-days.test.js — [LD-CLOUD 2026-11-13] 第二十五条「总龙分歧」云端预计算的口径回归锁
//
// 锁住五件事（都是「错了没人会发现」的那种）：
//   ① 口径阶段：9:27 = intraday（今天没有收盘腿，D2 不可能成立）/ 16:00 = close；
//   ② 每日腿的去重：同一天同股有 auc / close 两行时【优先 auc】（原值即 9:25 口径，免反解）；
//   ③ 逐日事实的取列：收盘涨幅只认 `stock_daily_pct.pct`（market_metrics.change_pct 会判反）；
//   ④ 端到端：首次 → 二次分歧的完整事件流能被判出来并落库（含霸榜天数 / 首次后涨停数）；
//   ⑤ §10：榜没就绪 ⇒ 0 写入；读失败 ⇒ 抛错（⛔ 不写「猜的」判定）；写失败 ⇒ ok=false 且可见。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  legPhaseOf,
  rangeRowsMapOf,
  buildDaysForStock,
  runLeaderDivergeDays
} from './leader-diverge-days.js';

const h = vi.hoisted(() => ({
  dates: [],
  auc: [],
  metrics: [],
  range20: [],
  daily: [],
  written: [],
  throwOn: ''
}));

vi.mock('../data/supabase-write.js', () => ({
  readRecentTradeDates: async () => {
    if (h.throwOn === 'dates') throw new Error('HTTP 503');
    return h.dates;
  },
  readAuctionRowsForDates: async () => {
    if (h.throwOn === 'auc') throw new Error('HTTP 503');
    return h.auc;
  },
  readMetricsForDates: async () => h.metrics,
  readRange20ForDates: async () => h.range20,
  readDailyPctForDates: async () => h.daily,
  upsertLeaderDivergeRows: async (env, rows) => {
    if (h.throwOn === 'write') throw new Error('HTTP 400 PGRST204');
    h.written.push(rows);
  }
}));

const LEADER = '东方海洋';
const CODE = '002086';   // 深主板 ⇒ 涨停幅度 10%

/** 造 20 个交易日（升序、字符串可比） */
function dates20() {
  const out = [];
  for (let i = 1; i <= 20; i++) out.push('2026-10-' + String(i).padStart(2, '0'));
  return out;
}

/**
 * 造一份「首次分歧 → 连板 → 二次分歧」的完整序列：
 *   d0~d4 涨停（首板链）→ d5 竞价低开（首次分歧）→ d6~d10 五连板 →
 *   d11 竞价低开（二次分歧）→ 余下横盘。
 */
function seed(over) {
  const o = over || {};
  const ds = dates20();
  h.dates = ds;
  h.auc = ds.map(function (d) {
    return { date: d, stock: LEADER, volume: '5000', yest_volume: '50000' };  // 占比 10%（不触发 D3）
  });
  h.metrics = ds.map(function (d, i) {
    const auc = o.aucAt ? o.aucAt(i) : ((i === 5 || i === 11) ? '-1.50' : '3.00');
    return { date: d, stock: LEADER, code: CODE, auc_pct_chg: auc, change_pct: '0.00' };
  });
  h.range20 = ds.map(function (d, i) {
    return { date: d, stock: LEADER, pct: String(200 - i), days: 20, leg: 'close' };
  });
  h.daily = ds.map(function (d, i) {
    const pct = (i <= 4 || (i >= 6 && i <= 10)) ? '10.00' : '0.50';
    return { date: d, stock: LEADER, pct: String(pct) };
  });
}

beforeEach(() => {
  h.written = [];
  h.throwOn = '';
  seed();
});

describe('legPhaseOf（口径阶段）', () => {
  it('北京 09:27 ⇒ intraday（今天的收盘腿还不存在）', () => {
    expect(legPhaseOf(new Date(Date.UTC(2026, 10, 13, 9, 27, 0)))).toBe('intraday');
  });

  it('北京 16:00 ⇒ close（收盘腿齐全，「高开低走收绿」才判得出来）', () => {
    expect(legPhaseOf(new Date(Date.UTC(2026, 10, 13, 16, 0, 0)))).toBe('close');
  });
});

describe('rangeRowsMapOf（同一天同股两腿的去重）', () => {
  it('auc / close 两行都在 ⇒ 取 auc（原值即 9:25 竞价口径，⛔ 不再反解一次）', () => {
    const m = rangeRowsMapOf([
      { stock: 'A', pct: '81.36', days: 20, leg: 'close' },
      { stock: 'A', pct: '92.48', days: 20, leg: 'auc' }
    ]);
    expect(m.get('A').pct).toBe('92.48');
    expect(m.get('A').leg).toBe('auc');
  });

  it('只有 close 行 ⇒ 保留 close（下游按 leg 决定反解）', () => {
    const m = rangeRowsMapOf([{ stock: 'A', pct: '81.36', days: 20, leg: 'close' }]);
    expect(m.get('A').leg).toBe('close');
  });

  it('leg 缺失 ⇒ 按 close 对待（旧行缺省就是收盘口径）', () => {
    const m = rangeRowsMapOf([{ stock: 'A', pct: '81.36', days: 20 }]);
    expect(m.get('A').leg).toBe('close');
  });

  it('auc 行不论顺序都赢（先 close 后 auc 也对）', () => {
    const m = rangeRowsMapOf([
      { stock: 'A', pct: '1', days: 20, leg: 'auc' },
      { stock: 'A', pct: '2', days: 20, leg: 'close' }
    ]);
    expect(m.get('A').pct).toBe('1');
  });

  it('空股票名跳过（⛔ 不造一个无名行）', () => {
    const m = rangeRowsMapOf([{ stock: '', pct: '1', days: 20, leg: 'auc' }]);
    expect(m.size).toBe(0);
  });
});

describe('buildDaysForStock（逐日事实取哪几列）', () => {
  const dates = ['2026-10-01'];

  function src(over) {
    const o = over || {};
    return {
      metrics: new Map([['2026-10-01', new Map([[LEADER, { stock: LEADER, code: CODE, auc_pct_chg: '3.00', change_pct: '0.00' }]])]]),
      daily: new Map([['2026-10-01', new Map([[LEADER, '10.00']])]]),
      auction: new Map([['2026-10-01', new Map([[LEADER, { volume: '5000', yest_volume: '50000' }]])]]),
      leaderOfDay: new Map([['2026-10-01', o.leader || LEADER]])
    };
  }

  it('收盘涨幅取 stock_daily_pct.pct（⛔ 不用 market_metrics.change_pct，它会停在 9:25 涨幅）', () => {
    const days = buildDaysForStock(dates, LEADER, src());
    expect(days[0].dailyPct).toBe('10.00');
    expect(days[0].closePct).toBe('0.00');       // 只作退路，判据不读它
    expect(days[0].limitUpPct).toBe(10);          // 主板 10%
  });

  it('竞价占比 = 竞价量 ÷ 昨量（同一行，⛔ 不走上一交易日）', () => {
    const days = buildDaysForStock(dates, LEADER, src());
    expect(days[0].volume).toBe('5000');
    expect(days[0].yestVolume).toBe('50000');
  });

  it('isDragonOne 只认「那一格榜的第 1 名就是它」', () => {
    expect(buildDaysForStock(dates, LEADER, src())[0].isDragonOne).toBe(true);
    expect(buildDaysForStock(dates, LEADER, src({ leader: '别人' }))[0].isDragonOne).toBe(false);
  });

  it('缺行 ⇒ 各列 null（§10 未知 ≠ 0，⛔ 不折成 0 参与判定）', () => {
    const days = buildDaysForStock(['2026-10-02'], LEADER, src());
    expect(days[0].aucPct).toBe(null);
    expect(days[0].dailyPct).toBe(null);
    expect(days[0].volume).toBe(null);
    expect(days[0].limitUpPct).toBe(null);
  });
});

describe('runLeaderDivergeDays（端到端 · 云端预计算）', () => {
  it('首次分歧 → 连板 → 二次分歧 ⇒ kind=second 并落库（含霸榜天数 / 首次后涨停数）', async () => {
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20', phase: 'intraday' });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(1);
    const row = h.written[0][0];
    expect(row.date).toBe('2026-10-20');
    expect(row.stock).toBe(LEADER);
    expect(row.kind).toBe('second');
    expect(row.qualified).toBe(true);
    expect(row.dragon_days).toBe(20);              // 整窗都是第 1 名
    expect(row.first_date).toBe('2026-10-06');     // d5（index 5）
    expect(row.second_date).toBe('2026-10-12');    // d11
    expect(row.boards_after_first).toBe(5);        // d6~d10 五连板
    expect(row.leg_phase).toBe('intraday');
    expect(Array.isArray(row.rows)).toBe(true);
    expect(row.rows.length).toBe(20);
    // 逐日留痕要能追溯到「哪一天低开」（留痕里已是数值，不是原始字符串）
    const low = row.rows.filter(function (x) { return x.aucPct === -1.5; });
    expect(low.length).toBe(2);
    expect(low.map(function (x) { return x.date; })).toEqual(['2026-10-06', '2026-10-12']);
  });

  it('只有一次分歧 ⇒ kind=first（⛔ 不冒充二次分歧、不冒充退潮）', async () => {
    seed({ aucAt: function (i) { return i === 5 ? '-1.50' : '3.00'; } });
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20', phase: 'close' });
    expect(r.ok).toBe(true);
    expect(h.written[0][0].kind).toBe('first');
    expect(h.written[0][0].second_date).toBe(null);
  });

  it('霸榜不足 3 天 ⇒ qualified=false / kind=none（用户「要霸榜总龙一至少三天」）', async () => {
    // 另一只票在前 18 天 20 日涨幅更高 ⇒ 真正的总龙一是它；东方海洋只在最后 2 天霸榜
    const ds = dates20();
    ds.forEach(function (d, i) {
      h.metrics.push({ date: d, stock: '别人', code: '600000', auc_pct_chg: '1.00', change_pct: '0.00' });
      h.auc.push({ date: d, stock: '别人', volume: '5000', yest_volume: '50000' });
      h.range20.push({ date: d, stock: '别人', pct: String(i < 18 ? 300 : 1), days: 20, leg: 'close' });
      h.daily.push({ date: d, stock: '别人', pct: '10.00' });
    });
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20', days: 1 });
    expect(r.ok).toBe(true);
    // 展示日（10-20）的总龙一是「别人」（它那天也该是第 1 名？—— 不，最后两天东方海洋 pct=200-i 更大）
    // ⇒ 展示日总龙一仍是东方海洋（d19 它 181 > 别人 1），但整窗只霸榜 2 天 ⇒ 资格不达标
    const row = h.written[0][0];
    expect(row.stock).toBe(LEADER);
    expect(row.dragon_days).toBe(2);
    expect(row.qualified).toBe(false);
    expect(row.kind).toBe('none');
  });

  it('榜没就绪（当天没有 9:25 名单）⇒ 0 写入、ok=false（§10 ⛔ 不猜总龙一）', async () => {
    h.metrics = [];                                // 白名单空 ⇒ buildAuctionLegBoard.ready=false
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20' });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(r.error).toBe('nothing-to-write');
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(h.written.length).toBe(0);
  });

  it('取不到任何交易日 ⇒ ok=false / no-trade-dates', async () => {
    h.dates = [];
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-trade-dates');
  });

  it('读失败 ⇒ 抛错（⛔ 不写一行「猜的」判定）', async () => {
    h.throwOn = 'auc';
    await expect(runLeaderDivergeDays({}, { today: '2026-10-20' })).rejects.toThrow('HTTP 503');
    expect(h.written.length).toBe(0);
  });

  it('写失败 ⇒ ok=false 且错误可见（表没建 / 网络）', async () => {
    h.throwOn = 'write';
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('write-failed');
    expect(r.logs.join('\n')).toContain('create_tvrb_leader_diverge.sql');
  });

  it('days=2 ⇒ 写最近两个展示日（手动回补用）', async () => {
    const r = await runLeaderDivergeDays({}, { today: '2026-10-20', days: 2 });
    expect(r.written).toBe(2);
    expect(h.written[0].map(function (x) { return x.date; })).toEqual(['2026-10-19', '2026-10-20']);
  });
});
