// range30-fill.test.js — [R30-CLOUD 2026-11-20] 当天名单 30 日涨幅云端补位回归锁
//
// 病根（生产取证）：Actions 的 cron 漂移到北京凌晨且常丢，凌晨跑时当天名单还没生成 ⇒
//   候选池退化成近 40 日名单 ⇒ 当天首次出现的票整天没有 30 日涨幅（11-20 缺 5 只）。
// 修法：Worker 在 09:26 用「当天名单」补位、16:03 用当天收盘价覆盖。
//   本组测试锁住三件事：① 只填空不覆盖；② 窗口口径（30 日 + 基准日）；③ 算不出不写 0。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRange30Fill } from './range30-fill.js';

const h = vi.hoisted(() => ({
  wl: [], metrics: [], have: [], cal: [], bars: new Map(), upserted: [], failBars: false
}));

vi.mock('../data/supabase-write.js', () => ({
  readAuctionWatchlistForDate: async () => h.wl,
  readMarketMetricsForDate: async () => h.metrics,
  readRange30StocksForDate: async () => new Set(h.have),
  readRecentTradeDates: async () => h.cal,
  upsertRange30Rows: async (env, rows) => { h.upserted.push(rows); }
}));
vi.mock('../data/fuyao-api.js', () => ({
  fetchFuyaoBatchBars: async () => {
    if (h.failBars) throw new Error('fuyao 429');
    return h.bars;
  }
}));

function setup() {
  h.wl = []; h.metrics = []; h.have = []; h.cal = [];
  h.bars = new Map(); h.upserted = []; h.failBars = false;
  // 32 个交易日（都在目标日之前）；开盘前窗口末日 = 最后一个交易日
  h.cal = new Array(32).fill(0).map((_, i) => {
    const d = new Date(Date.parse('2026-09-15T00:00:00Z') + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
}
function barsFor(code, base, end) {
  return h.cal.map((d, i) => ({ ymd: d, close: base + (end - base) * i / (h.cal.length - 1) }));
}

describe('runRange30Fill — 当天名单补位（新面孔不再整天空白）', () => {
  beforeEach(setup);

  it('★ 5 只新面孔缺行、其余已有 ⇒ 只补这 5 只，已有行一根不碰', async () => {
    const missing = ['京蓝科技', '华升股份', '格林达', '江化微', '海立股份'];
    h.wl = missing.concat(['盛剑科技']).map((name, i) => ({ name, code: String(600000 + i) }));
    h.metrics = h.wl.map(x => ({ name: x.name, code: x.code, auc_pct_chg: '+1.00' }));
    h.have = ['盛剑科技'];
    missing.forEach((name, i) => {
      h.bars.set(String(600000 + i), barsFor(String(600000 + i), 100, 115));
    });
    const r = await runRange30Fill({}, { date: '2026-11-20', endAtDate: false });
    expect(r.ok).toBe(true);
    expect(r.targets).toBe(6);
    expect(r.need).toBe(5);
    expect(r.written).toBe(5);
    expect(h.upserted).toHaveLength(1);
    expect(h.upserted[0].map(x => x.stock).sort()).toEqual(missing.slice().sort());
    expect(h.upserted[0].every(x => x.leg === 'close' && x.date === '2026-11-20')).toBe(true);
  });

  it('★ 已有行默认不覆盖；overwrite=true 才重算（16:03 收盘口径）', async () => {
    h.wl = [{ name: '盛剑科技', code: '603155' }];
    h.metrics = [{ name: '盛剑科技', code: '603155' }];
    h.have = ['盛剑科技'];
    h.bars.set('603155', barsFor('603155', 100, 115));

    const r1 = await runRange30Fill({}, { date: '2026-11-20', endAtDate: false });
    expect(r1.written).toBe(0);
    expect(r1.skipped).toMatch(/已全覆盖/);

    const r2 = await runRange30Fill({}, { date: '2026-11-20', endAtDate: true, overwrite: true });
    expect(r2.written).toBe(1);
    expect(h.upserted[0][0].stock).toBe('盛剑科技');
    // 末日取 11-20 当天（收盘口径）时，窗口 end 必须是 11-20
    expect(r2.logs.join(' ')).toMatch(/窗口 [^\s]+~2026-11-20/);
  });

  it('★ 批量日线拿不到 ⇒ 0 写入（§10 宁缺勿错，⛔ 不补 0）', async () => {
    h.wl = [{ name: '京蓝科技', code: '000711' }];
    h.metrics = [{ name: '京蓝科技', code: '000711' }];
    h.failBars = true;
    const r = await runRange30Fill({}, { date: '2026-11-20', endAtDate: false });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(h.upserted).toHaveLength(0);
  });

  it('★ 没有代码 / 判不出（次新股）⇒ 不写，也不会把已有行清空', async () => {
    h.wl = [{ name: '未知票', code: '' }, { name: '次新股', code: '001234' }];
    h.metrics = [{ name: '次新股', code: '001234' }];       // code 只在 market_metrics 里算真值
    h.bars.set('001234', [{ ymd: h.cal[0], close: 10 }]);   // 只有 1 根 bar
    const r = await runRange30Fill({}, { date: '2026-11-20', endAtDate: false });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(0);
    expect(h.upserted).toHaveLength(0);
    expect(r.skipped).toMatch(/一只都不写/);
  });

  it('★ 名单/行情读不到 ⇒ 整轮停止（§10 读失败 ≠ 空名单）', async () => {
    setup();
    // 空名单 + 空行情 ⇒ skipped 而不是「算出 0 只也算成功」
    const r = await runRange30Fill({}, { date: '2026-11-20' });
    expect(r.ok).toBe(false);
    expect(r.targets).toBe(0);
    expect(r.written).toBe(0);
    expect(h.upserted).toHaveLength(0);
  });
});
