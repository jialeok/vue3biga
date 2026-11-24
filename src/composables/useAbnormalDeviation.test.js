// useAbnormalDeviation.test.js — 「早上 9:25 默认就是竞价口径」的行为级回归锁
//
// ★★ [DEV-AUC-WAIT 2026-11-24 用户原话]
//   「那个官方偏离值竞价口径是默认打开的（默认是竞价口径数值），这样早上我就能一眼看到竞价口径
//     进行选股判断……也就是早上 9 点 25 分左右，我就可以看到的是竞价口径，而不是昨天的收盘口径，
//     这个很重要。收盘口径只是复盘用。」
//
// 这条测试直接跑 `useAbnormalDeviation().load()`（真 composable，不是读源码），把三个 Data 层
// 入口换成夹具，验证四件事：
//   ① 9:26 + 竞价涨幅已到 + 当日收盘腿未到 ⇒ **默认口径 = auction**（这就是用户要的）
//   ② 16:30 + 当日收盘腿已到        ⇒ 默认口径 = close（收盘覆盖，复盘用）
//   ③ 复盘历史日                    ⇒ 默认口径 = close（⛔ 不拿竞价涨幅改历史）
//   ④ 竞价口径的数值真的把「今日竞价涨幅」算进去了（不是昨天的数）
//
// ⚠️ 夹具里的指数腿只到「昨日」——这正是 9:25 的真实处境（指数没有集合竞价价），
//   竞价口径靠 `indexTodayFlat` 补一根 pct=0 才让窗口含今天。⛔ 别给它补今日指数腿。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const D_TODAY = '2026-11-24';
const D_PREV = '2026-11-23';

/** 逐日腿夹具：10 个交易日，个股每天 +7%、指数每天 +0.2%（偏离会稳定走高） */
function makeDays(n) {
  const out = [];
  let t = Date.parse('2026-11-10T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}
const DAYS = makeDays(10);
const D_LAST = DAYS[DAYS.length - 1];

let MOCK = {};

vi.mock('../data/stock-daily-pct.js', () => ({
  readDailyPctRowsFor: vi.fn(async () => MOCK.daily)
}));
vi.mock('../data/market-metrics.js', () => ({
  readMarketMetricsForDate: vi.fn(async () => MOCK.auc)
}));
vi.mock('../data/index-daily-pct.js', () => ({
  readIndexLegsForDates: vi.fn(async () => MOCK.idx),
  indexLegsOf: vi.fn((map, code, asOf) => {
    const m = map.get(code);
    if (!m) return [];
    return Array.from(m.entries())
      .map(function (e) { return { date: e[0], pct: e[1] }; })
      .filter(function (x) { return !asOf || x.date <= asOf; })
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  }),
  indexLegsGapText: vi.fn(() => ''),
  shiftYmd: vi.fn((ymd, n) => {
    const t = Date.parse(String(ymd).slice(0, 10) + 'T00:00:00Z');
    return new Date(t + n * 86400000).toISOString().slice(0, 10);
  })
}));

const { useAbnormalDeviation, clearDeviationSessionCaches } = await import('./useAbnormalDeviation.js');

beforeEach(function () {
  clearDeviationSessionCaches();
  MOCK = { daily: new Map(), auc: [], idx: { ready: true, map: new Map(), missing: [], src: 'db', error: '' } };
});

/** 造一份「个股腿到 D_LAST、指数腿也到 D_LAST」的夹具；withTodayLeg 控制当天那根腿在不在 */
function buildDaily(withTodayLeg) {
  const day = new Map();
  DAYS.forEach(function (d, i) {
    if (d === D_LAST && !withTodayLeg) return;             // 9:25：当天收盘腿还没入库
    day.set(d, i === DAYS.length - 1 && withTodayLeg ? 3.07 : 7.0);
  });
  const daily = new Map();
  daily.set('北纬科技', day);
  const im = new Map();
  DAYS.forEach(function (d) { im.set(d, 0.2); });
  return {
    daily: daily,
    idx: { ready: true, map: new Map([['sz399107', im]]), missing: [], src: 'db', error: '' },
    auc: [{ stock: '北纬科技', code: '002148', auc_pct_chg: '+2.98%' }]
  };
}

const ARGS = {
  names: ['北纬科技'],
  codeOf: function () { return '002148'; }
};

describe('[DEV-AUC-WAIT] 默认口径：早上就是竞价口径，收盘才切回顾收', () => {
  it('① 9:26 + 竞价涨幅已到 + 当日收盘腿未到 ⇒ 默认 auction（用户要的就是这个）', async () => {
    MOCK = buildDaily(false);
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_LAST, hhmm: '09:26' }));
    const m = dev.meta.value;
    expect(m.aucReady).toBe(true);
    expect(m.closeReady).toBe(false);
    expect(m.basis).toBe('auction');
    expect(m.basisText).toContain('竞价口径');
    // 口径文案必须交代「指数按不动计」
    expect(m.basisText).toContain('指数');
  });

  it('② 16:30 + 当日收盘腿已入库 ⇒ 默认 close（收盘覆盖；收盘口径只用于复盘）', async () => {
    MOCK = buildDaily(true);
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_LAST, hhmm: '16:30' }));
    const m = dev.meta.value;
    expect(m.closeReady).toBe(true);
    expect(m.basis).toBe('close');
    expect(m.basisText).toContain('收盘腿已入库');
  });

  it('③ 复盘历史日 ⇒ 永远 close（⛔ 不拿竞价涨幅改历史）', async () => {
    MOCK = buildDaily(true);
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_TODAY, hhmm: '09:26' }));
    expect(dev.meta.value.basis).toBe('close');
  });

  it('④ 竞价口径的数真的含「今日竞价涨幅」：与「昨天的数」必须不同', async () => {
    // 竞价口径：今日 +2.98%（auc），指数今日按 0
    MOCK = buildDaily(false);
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_LAST, hhmm: '09:26' }));
    const aucFact = dev.devMap.value.get('北纬科技');
    expect(aucFact.ok).toBe(true);

    // 换成「窗口只到昨天」的收盘口径（= 旧 bug 当时给出的数）
    const yesterday = DAYS[DAYS.length - 2];
    const dev2 = useAbnormalDeviation();
    await dev2.load(Object.assign({}, ARGS, { asOf: yesterday, today: D_LAST, hhmm: '09:26' }));
    const prevFact = dev2.devMap.value.get('北纬科技');

    expect(aucFact.dev10).not.toBeCloseTo(prevFact.dev10, 6);   // ✅ 今日涨幅真的进了窗口
  });

  it('⑤ 竞价涨幅没落库（9:25:10 那一刻）⇒ close + 如实说明「不是没有异动」', async () => {
    MOCK = buildDaily(false);
    MOCK.auc = [];                                        // 还没写
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_LAST, hhmm: '09:26' }));
    const m = dev.meta.value;
    expect(m.aucReady).toBe(false);
    expect(m.basis).toBe('close');
    expect(m.basisText).toContain('竞价档还没就绪');
    expect(m.basisText).toContain('不是「没有异动」');
  });

  it('⑥ toggle 只切「看哪一套」，两套都已算好（⛔ 不重新取数）', async () => {
    MOCK = buildDaily(false);
    const dev = useAbnormalDeviation();
    await dev.load(Object.assign({}, ARGS, { asOf: D_LAST, today: D_LAST, hhmm: '09:26' }));
    expect(dev.basis.value).toBe('auction');
    dev.toggleBasis();
    expect(dev.basis.value).toBe('close');
    expect(dev.devMap.value.get('北纬科技').ok).toBe(false);   // 收盘腿没入库 ⇒ 收盘口径判不出（§10）
    dev.toggleBasis();
    expect(dev.basis.value).toBe('auction');
    expect(dev.devMap.value.get('北纬科技').ok).toBe(true);
  });
});
