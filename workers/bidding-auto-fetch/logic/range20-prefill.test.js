// range20-prefill.test.js — [R20-CLOUD 2026-11-06] 9:26 云端 20 日涨幅补缺的口径回归锁
//
// 锁住三件事：
//   ① 复利口径与 Edge `rangeFromLegs` 逐字等价（19 根历史腿 + 1 根 T 腿，days=20）；
//   ② 腿不够 19 根 / T 腿不是数值 ⇒ 一律不写（§10 宁缺勿错，⛔ 不折 0）；
//   ③ 竞价/收盘 leg 的 15:00 边界与 Edge、前端 resolveT20LegMode 同源。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RANGE20_LEG_DAYS,
  compoundRange20,
  legModeOf,
  groupLegs,
  runRange20Prefill,
  fillLegsFromKline
} from './range20-prefill.js';
import { RANGE20_MIN_TARGETS, isRange20TargetListReady } from '../../../src/logic/auction/range-window.js';

// [LEGS-FILL-CLOUD 2026-11-20] 新面孔缺腿的根因回归：mock 掉 Data 层，只验「补不补、写什么」
const h = vi.hoisted(() => ({
  wl: [], metrics: [], have: [], legs: [], upserted: [], throwOnRead: '',
  // ★★ 补腿通道：批量日线返回值 / 交易日序列 / 逐日腿写入留痕
  bars: new Map(), tradeDates: [], legUpserted: [], failBars: false, barArgs: []
}));
vi.mock('../data/supabase-write.js', () => ({
  readAuctionWatchlistForDate: async () => {
    if (h.throwOnRead === 'wl') throw new Error('HTTP 503');
    return h.wl;
  },
  readMarketMetricsForDate: async () => {
    if (h.throwOnRead === 'metrics') throw new Error('HTTP 503');
    return h.metrics;
  },
  readRange20StocksForDate: async () => new Set(h.have),
  readDailyLegsForStocks: async () => h.legs,
  upsertRange20Rows: async (env, rows) => { h.upserted.push(rows); },
  readRecentTradeDates: async () => h.tradeDates,
  upsertDailyPctRows: async (env, rows) => { h.legUpserted.push(rows); }
}));
vi.mock('../data/fuyao-api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,                       // 纯函数 barsToDailyPctMap 用【真实实现】，不许 copy 一份假的
    fetchFuyaoBatchBars: async (env, codes, from, to) => {
      h.barArgs.push({ codes: codes.slice(), from: from, to: to });
      if (h.failBars) throw new Error('fuyao 429');
      return h.bars;
    }
  };
});

function n(v, k) { return new Array(k).fill(v); }

function bj(h, m) { return new Date(Date.UTC(2026, 10, 6, h, m, 0)); }

describe('compoundRange20（与 Edge rangeFromLegs 同源）', () => {
  it('19 根历史腿 + 1 根 T 腿 = 20 日；复利累乘而不是求和', () => {
    const r = compoundRange20(n(1, 19), 1);
    // 1.01^20 - 1 = 22.019003...%
    expect(r.pct).toBe('22.02');
    expect(r.days).toBe(20);
  });

  it('腿超过 19 根 ⇒ 只取最近 19 根（窗口滑动，⛔ 不把更早的算进去）', () => {
    const hist = n(0, 3).concat(n(1, 19));   // 前 3 根是 0，最近 19 根是 +1
    const r = compoundRange20(hist, 0);
    expect(r.days).toBe(20);
    expect(r.pct).toBe('20.81');            // 1.01^19 - 1
  });

  it('腿不足 19 根 ⇒ null（绝不拿半截复利当 20 日涨幅）', () => {
    expect(compoundRange20(n(1, RANGE20_LEG_DAYS - 1), 1)).toBeNull();
    expect(compoundRange20([], 1)).toBeNull();
    expect(compoundRange20(null, 1)).toBeNull();
  });

  it('T 腿非数值 ⇒ null（缺竞价涨幅时不许用 0 顶替）', () => {
    expect(compoundRange20(n(1, 19), NaN)).toBeNull();
    expect(compoundRange20(n(1, 19), undefined)).toBeNull();
    expect(compoundRange20(n(1, 19), 'x')).toBeNull();
  });

  it('负腿也要正确复利（跌 10% × 2 天 ≠ -20%）', () => {
    const hist = n(0, 18).concat([-10]);
    expect(compoundRange20(hist, -10).pct).toBe('-19.00');
  });
});

describe('legModeOf（竞价 / 收盘口径）', () => {
  it('15:00 前 auc、15:00 起 close（与 Edge 选腿、前端 resolveT20LegMode 同源）', () => {
    expect(legModeOf(bj(9, 26))).toBe('auc');
    expect(legModeOf(bj(14, 59))).toBe('auc');
    expect(legModeOf(bj(15, 0))).toBe('close');
    expect(legModeOf(bj(16, 30))).toBe('close');
  });
});

describe('groupLegs（腿表扁平行 → 升序数值腿）', () => {
  it('按日期升序、剥 %/±、跳过坏值（⛔ 不把坏值折成 0）', () => {
    const m = groupLegs([
      { stock: 'A', date: '2026-11-05', pct: '+2.00%' },
      { stock: 'A', date: '2026-11-04', pct: '-1.50' },
      { stock: 'A', date: '2026-11-06', pct: '' },
      { stock: 'A', date: '2026-11-03', pct: 'garbage' },
      { stock: 'B', date: '2026-11-05', pct: '3.10' }
    ]);
    expect(m.get('A')).toEqual([-1.5, 2]);
    expect(m.get('B')).toEqual([3.1]);
    expect(m.has('C')).toBe(false);
  });

  it('空输入返回空 Map，不抛错', () => {
    expect(groupLegs([]).size).toBe(0);
    expect(groupLegs(null).size).toBe(0);
  });
});

describe('[CLOUD-0927-HEAL] §11 半截名单不许补位', () => {
  beforeEach(() => {
    h.wl = []; h.metrics = []; h.have = []; h.legs = []; h.upserted = []; h.throwOnRead = '';
  });

  it('★ 下限常量与前端共用同一份（⛔ 前后端各写一份必然分叉）', () => {
    expect(RANGE20_MIN_TARGETS).toBe(20);
    expect(isRange20TargetListReady(new Array(19).fill('A'))).toBe(false);
    expect(isRange20TargetListReady(new Array(20).fill('A'))).toBe(true);
  });

  it('★ 9:25 只落了 5 行 ⇒ 0 写入、明确 skipped（⛔ 不打「✅ 补缺 5 行」）', async () => {
    h.wl = new Array(5).fill(0).map((_, i) => ({ name: 'S' + i, code: '00000' + i }));
    h.metrics = h.wl.map(s => ({ name: s.name, auc_pct_chg: '+1.00' }));
    const r = await runRange20Prefill({}, { today: '2026-11-10' });
    expect(r.targets).toBe(5);
    expect(r.written).toBe(0);
    expect(r.skipped).toMatch(/9:25 尚未落库完/);
    expect(h.upserted).toHaveLength(0);
  });

  it('★ 名单读取失败 ⇒ 整轮停止、0 写入（§10 读失败 ≠ 空名单）', async () => {
    h.throwOnRead = 'wl';
    const r = await runRange20Prefill({}, { today: '2026-11-10' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/读取当日名单\/行情失败/);
    expect(r.written).toBe(0);
    expect(h.upserted).toHaveLength(0);
  });

  it('★ 云端已有行一律不覆盖（§11 纯加法、幂等）', async () => {
    h.wl = new Array(RANGE20_MIN_TARGETS).fill(0).map((_, i) => ({ name: 'S' + i, code: '00000' + i }));
    h.metrics = h.wl.map(s => ({ name: s.name, auc_pct_chg: '+1.00' }));
    h.have = h.wl.map(s => s.name);
    const r = await runRange20Prefill({}, { today: '2026-11-10' });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(0);
    expect(r.skipped).toMatch(/已全覆盖/);
    expect(h.upserted).toHaveLength(0);
  });
});

describe('[LEGS-FILL-CLOUD 2026-11-20] 新面孔缺腿 ⇒ 云端批量补腿', () => {
  beforeEach(() => {
    h.bars = new Map(); h.tradeDates = []; h.legUpserted = []; h.failBars = false; h.barArgs = [];
    h.wl = []; h.metrics = []; h.have = []; h.legs = []; h.upserted = []; h.throwOnRead = '';
  });

  function tradeDates(n) {
    return new Array(n).fill(0).map((_, i) => '2026-10-' + String(i + 1).padStart(2, '0'));
  }

  it('★ 只有 3 根腿的新面孔：批量日线补齐 19 根 ⇒ 20 日涨幅真的写入（不再永远空白）', async () => {
    const dates = tradeDates(19);
    const bars = dates.map((d, i) => ({ ymd: d, close: 100 + i }));   // 每日约 +1%
    h.bars = new Map([['000711', bars]]);
    h.tradeDates = dates;
    h.wl = new Array(RANGE20_MIN_TARGETS).fill(0).map((_, i) => ({ name: 'S' + i, code: '00000' + i }));
    h.wl[0] = { name: '京蓝科技', code: '000711' };
    h.metrics = h.wl.map(s => ({
      name: s.name, code: s.code, auc_pct_chg: '+1.00'
    }));
    // 京蓝科技故意只给 3 根腿（新面孔的实测形态），其它票给满 19 根
    h.legs = [];
    h.wl.forEach((s, idx) => {
      for (let k = 0; k < (idx === 0 ? 3 : 19); k++) {
        h.legs.push({ stock: s.name, date: dates[k], pct: '+1.00' });
      }
    });
    const r = await runRange20Prefill({}, { today: '2026-11-20' });
    expect(r.legsFill).not.toBeNull();
    expect(r.legsFill.written).toBeGreaterThan(0);
    expect(h.legUpserted).toHaveLength(1);
    // 只补缺的那 16 天，已有 3 天一根都不碰（§11 纯加法）
    expect(h.legUpserted[0]).toHaveLength(16);
    expect(h.legUpserted[0].every(x => x.src === 'fuyao_kline' && x.stock === '京蓝科技')).toBe(true);
    const picked = h.upserted[0].find(x => x.stock === '京蓝科技');
    expect(picked).toBeDefined();
    expect(picked.days).toBe(20);
  });

  it('★ [FILL-START-BAR] 取日线的起点必须早于 19 日窗口首日（否则首日没基准 bar，19 根补不满）', async () => {
    const dates = tradeDates(19);
    h.bars = new Map([['000711', dates.map((d, i) => ({ ymd: d, close: 100 + i }))]]);
    await fillLegsFromKline({}, {
      stocks: ['京蓝科技'], tradeDates: dates,
      codeOf: () => '000711', haveOf: () => null
    });
    expect(h.barArgs).toHaveLength(1);
    expect(h.barArgs[0].from < dates[0]).toBe(true);
    expect(h.barArgs[0].to).toBe(dates[dates.length - 1]);
  });

  it('★ 批量日线拿不到 ⇒ 0 写入（§10 宁缺勿错，⛔ 不拿 0 当涨幅）', async () => {
    const dates = tradeDates(19);
    h.tradeDates = dates;
    h.failBars = true;
    const r = await fillLegsFromKline({}, {
      stocks: ['京蓝科技'], tradeDates: dates,
      codeOf: () => '000711', haveOf: () => new Set()
    });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(h.legUpserted).toHaveLength(0);
  });

  it('★ 已有腿一根都不重写（幂等；重跑只填空不覆盖）', async () => {
    const dates = tradeDates(19);
    h.bars = new Map([['000711', dates.map((d, i) => ({ ymd: d, close: 100 + i }))]]);
    const r = await fillLegsFromKline({}, {
      stocks: ['京蓝科技'], tradeDates: dates,
      codeOf: () => '000711', haveOf: () => new Set(dates)
    });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(0);
    expect(h.legUpserted).toHaveLength(0);
  });

  it('★ 没有 6 位代码 ⇒ 不发上游请求（⛔ 别拿乱代码打接口）', async () => {
    const dates = tradeDates(19);
    h.tradeDates = dates;
    const r = await fillLegsFromKline({}, {
      stocks: ['未知票'], tradeDates: dates,
      codeOf: () => '', haveOf: () => null
    });
    expect(r.requested).toBe(0);
    expect(r.skipped).toMatch(/没有 6 位代码/);
    expect(h.legUpserted).toHaveLength(0);
  });
});
