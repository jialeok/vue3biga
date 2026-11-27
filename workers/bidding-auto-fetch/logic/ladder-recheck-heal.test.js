// ladder-recheck-heal.test.js — [RANGE20-RATIO-HEAL 2026-11-11] 9:26 量比补缺的端到端回归锁
//
// 事故原型：11-11「青岛食品」（20 日涨幅补位票）当天 market_metrics 有行但没竞价量比，
//   而同为补位票的「海洋王」9:25 就抓到 1.94。
//   取证：9:25 名单 77 行足量 ⇒ `runLadderRecheck` 在 ① 直接 return ⇒
//         `fillAucFromNumcat` 只在 ⑥（名单恢复成功路径）才跑 ⇒ 补位票永远补不到量比。
//
// 这组用例锁的是【结构】，不是某个函数：
//   ① 9:25 名单足量（skipped）路径也必须检查并补「当日已有行但缺量比」的票；
//   ② 只发 1 次猫抓请求、只补缺的那只（§32 不重复请求）；
//   ③ 9:25 全抓全时 0 请求、0 额度；
//   ④ 补写只带「量比 + 行内为空字段」，已有值绝不出现在 payload（§11 只填空）；
//   ⑤ [WL-CANDIDATES 2026-11-19] metrics 0 行时正式名单照样进补抓（11-19 空转事故锁）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  watchlist: [],
  metrics: [],
  numcatCalls: [],
  upserts: [],
  numcatPayload: null,
}));

vi.mock('../data/supabase-write.js', () => ({
  readAuctionWatchlistForDate: vi.fn(async () => state.watchlist.slice()),
  readMarketMetricsSnapshotFieldsForDate: vi.fn(async () => state.metrics.slice()),
  upsertAuctionWatchlist: vi.fn(async () => {}),
  upsertMarketMetrics: vi.fn(async (_env, rows) => { state.upserts.push(rows); }),
  deleteLadderFallbackRows: vi.fn(async () => 0),
}));

vi.mock('../data/fuyao-api.js', () => ({
  fetchLadderConstituents: vi.fn(async () => {
    throw new Error('9:25 名单足量时不应重查 883410（§32 0 上游请求）');
  }),
}));

vi.mock('../data/numcat-api.js', () => ({
  numcatDailyAuc: vi.fn(async (_env, symbols) => {
    state.numcatCalls.push(symbols);
    return state.numcatPayload;
  }),
}));

const { runLadderRecheck } = await import('./ladder-recheck.js');
const { MIN_LADDER_ROWS } = await import('./ladder-heal.js');

const TODAY = '2026-11-11';

function realRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: '票' + i,
      code: String(600000 + i),
      source: 'worker',
      obs_auto_added: false
    });
  }
  return out;
}

/** 猫抓 daily_auc 的最小真实响应形状：fields + 二维数组 items */
function numcatOf(rows) {
  return {
    fields: ['symbol', 'tradedate', 'auc_vol', 'auc_pct_chg', 'auc_vol_ratio'],
    items: rows.map(r => [r.code, '20261111', r.vol === undefined ? 15100 : r.vol,
      r.pct === undefined ? '-0.52' : r.pct, r.ratio])
  };
}

beforeEach(() => {
  state.watchlist = realRows(MIN_LADDER_ROWS);
  state.metrics = [];
  state.numcatCalls.length = 0;
  state.upserts.length = 0;
  state.numcatPayload = null;
});

describe('[RANGE20-RATIO-HEAL] 9:26 skipped 路径也必须补竞价量比', () => {
  it('★★ 11-11 青岛食品原型：名单足量 + 补位票有行无量比 ⇒ 发 1 次猫抓并只补这一列', async () => {
    state.metrics = [
      { name: '青岛食品', code: '001219', auc_vol_ratio: '', auc_pct_chg: '-0.52%', auc_turnover: '0.80', volume: '151' },
      { name: '海洋王', code: '002724', auc_vol_ratio: '1.94', auc_pct_chg: '+0.08%', auc_turnover: '0.34', volume: '77' },
    ];
    state.numcatPayload = numcatOf([{ code: '001219', ratio: '1.85' }]);
    const logs = [];
    const out = await runLadderRecheck({}, { today: TODAY, logs });

    expect(out.skipped).toBe(true);                       // 没有重查 883410
    expect(state.numcatCalls).toHaveLength(1);            // ★ 整轮仍然只发 1 次请求（§32）
    // [WL-CANDIDATES 2026-11-19] 名单 30 只（metrics 没有它们的行）也在这一次请求里
    const syms = state.numcatCalls[0].split(',');
    expect(syms).toContain('001219');
    expect(syms).toHaveLength(31);
    expect(out.auc.attempted).toBe(true);
    // 猫抓只回了 001219 ⇒ 名单成员拿不到值 ⇒ 一行不写（§10 宁缺勿错），只写青岛食品
    expect(out.auc.written).toBe(1);
    expect(state.upserts).toHaveLength(1);
    const row = state.upserts[0][0];
    expect(row.stock).toBe('青岛食品');
    expect(row.auc_vol_ratio).toBe('1.85');
    // §11：已有行快照里 auc_pct_chg / volume / auc_turnover 都有值 ⇒ 不出现在 payload；
    //      猫抓给了 change_pct（今日竞价副本口径）⇒ 行内为空 ⇒ 可以补；
    //      猫抓没给 yest_volume（fields 里没有）⇒ 不出现
    expect(Object.keys(row).sort()).toEqual(
      ['auc_vol_ratio', 'change_pct', 'date', 'scope', 'stock', 'updated_at', 'updated_by'].sort()
    );
  });

  it('★★ 9:25 全抓全 ⇒ 名单足量路径 0 次猫抓请求、0 额度（§32）', async () => {
    // 全抓全 = 名单成员在 metrics 里都有行且都有量比（11-19 前的 mock 缺这层 ⇒ 误伤新候选源）
    state.metrics = state.watchlist.map(w => ({ name: w.name, code: w.code, auc_vol_ratio: '1.00' }))
      .concat([
        { name: '海洋王', code: '002724', auc_vol_ratio: '1.94' },
        { name: '青岛食品', code: '001219', auc_vol_ratio: '1.85' },
      ]);
    const logs = [];
    const out = await runLadderRecheck({}, { today: TODAY, logs });

    expect(out.skipped).toBe(true);
    expect(state.numcatCalls).toEqual([]);
    expect(out.auc.attempted).toBe(false);
    expect(out.auc.skipped).toContain('0 次猫抓请求');
    expect(state.upserts).toHaveLength(0);
  });

  // ★★ [WL-CANDIDATES 2026-11-19] 11-19 事故原型（端到端锁）：
  //   morning 猫抓 403 ⇒ metrics 当日 0 行 + 883410 残缺 ⇒ 旧实现 symbols=0 谎报「量比齐全」；
  //   新实现用正式名单做候选 ⇒ 1 次猫抓把 30 只成员整行补上。
  it('★★ 11-19 原型：metrics 0 行 ⇒ 正式名单候选整行补抓（source=worker）', async () => {
    state.metrics = [];   // morning 全灭
    state.numcatPayload = numcatOf(
      state.watchlist.map(w => ({ code: w.code, ratio: '2.00', vol: 15000, pct: '+1.00' }))
    );
    const logs = [];
    const out = await runLadderRecheck({}, { today: TODAY, logs });

    expect(state.numcatCalls).toHaveLength(1);
    expect(state.numcatCalls[0].split(',')).toHaveLength(30);
    expect(out.auc.attempted).toBe(true);
    expect(out.auc.written).toBe(30);
    expect(state.upserts).toHaveLength(1);
    const row0 = state.upserts[0][0];
    expect(row0.source).toBe('worker');
    expect(row0.scope).toBe('auction');
    expect(row0.auc_vol_ratio).toBe('2.00');
    // 日志必须如实（⛔ 不许再出现「量比齐全」的假话）
    expect(logs.join('\n')).not.toContain('量比齐全');
  });

  it('当日 market_metrics 读取失败 ⇒ 停止补抓，⛔ 不把读失败当空表（§10）', async () => {
    const { readMarketMetricsSnapshotFieldsForDate } = await import('../data/supabase-write.js');
    readMarketMetricsSnapshotFieldsForDate.mockRejectedValueOnce(new Error('REST 500'));
    const logs = [];
    const out = await runLadderRecheck({}, { today: TODAY, logs });

    expect(state.numcatCalls).toEqual([]);
    expect(out.auc.error).toContain('读取当日 market_metrics 失败');
    expect(state.upserts).toHaveLength(0);
  });

  it('猫抓返回缺 auc_vol_ratio ⇒ 一行都不写（⛔ 不拿同花顺顶替）', async () => {
    state.metrics = [{ name: '青岛食品', code: '001219', auc_vol_ratio: '' }];
    state.numcatPayload = { fields: ['symbol', 'tradedate', 'auc_vol'], items: [['001219', '20261111', 15100]] };
    const out = await runLadderRecheck({}, { today: TODAY, logs: [] });

    expect(state.numcatCalls).toHaveLength(1);
    expect(out.auc.written).toBe(0);
    expect(state.upserts).toHaveLength(0);
  });

  it('静态锁：skipped 分支必须走 finish()，且补抓必须开 includeAllRows', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./ladder-recheck.js', import.meta.url), 'utf8');
    const skippedBranch = src.slice(src.indexOf('if (!needsLadderRecheck'), src.indexOf('const officialNames'));
    expect(skippedBranch).toContain('return finish()');
    expect(src).toContain('includeAllRows: true');
    expect(src).toContain('ladderForAuc');
  });

  // ★★ [AUC-RATIO-0927 2026-11-12] 9:27 兜底锁。
  //   为什么必须是静态锁：这条链在 index.js 的 snapshot 分支里，跑真实路径要起整套 Supabase mock；
  //   而它真正怕的退化是「有人把这段删了 / 换个只在 9:26 跑的位置」——
  //   字符串级断言正好能钉住「9:27 这一趟确实还会去补量比」。
  it('静态锁：9:27 snapshot 必须再兜一次竞价量比，并落结构化留痕', async () => {
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const snapBranch = idx.slice(idx.indexOf("if (point === 'snapshot')"), idx.indexOf("if (point === 'extras')"));
    // ① 必须在 snapshot 分支内调用（⛔ 不是只在 ladder26 里）
    expect(snapBranch).toContain('fillAucFromNumcat(env, date || beijingToday(), null');
    // ② 必须带可 grep 的标记（verify-deploy 用它证明线上真的换了版本）
    expect(snapBranch).toContain('[AUC-RATIO-0927]');
    // ③ 结果必须带结构化字段（⛔ 只看 ok 会把零补写伪装成成功）
    expect(snapBranch).toContain('aucRatioWritten');
    expect(snapBranch).toContain('aucRatioHeal');
    // ④ 落库侧必须真的写进 bidding_fetch_log.detail
    expect(idx).toContain('aucRatioWritten: r.aucRatioWritten');
    // ⑤ 实现必须复用 9:26 同一份函数（§6 单一实现），⛔ 别在 index.js 里另写一套
    expect(idx).toContain('runLadderRecheck, fillAucFromNumcat');
  });
});
