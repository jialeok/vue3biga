// tvrb-auction-board.test.js — 题材量比【恒 9:25 竞价口径 20 日涨幅榜】的契约锁
//
// 背景（11-10 事故）：题材量比全部吃 20 日涨幅候选池的规则原先注入 `getRange20Leaders*`，
// 那份榜 15:00 后从 auc 切 close 重新发布、16:30 又被云端补位票改写 ⇒ 同一天早晚选股不同。
// 这里同时锁住：① 纯函数口径 ② 组合式「不许把发布榜再接回规则层」的静态契约。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  buildTvrbAuctionBoard,
  getTvrbAuctionBoard,
  getTvrbAuctionBoardToken,
  hasTvrbAuctionBoardVerdict,
  ensureTvrbAuctionBoard,
  clearTvrbAuctionBoardCache
} from './tvrb-auction-board.js';
import { resolveBuySettle } from './buy-settle.js';

// ── 纯函数：候选池 / 口径 / 门槛 ───────────────────────────────────────────────
function fixture() {
  const pctMap = new Map([
    ['主板A', { pct: 90, days: 20 }],
    ['主板B', { pct: 80, days: 20 }],
    ['主板C', { pct: 70, days: 20 }],
    ['创业板', { pct: 999, days: 20 }],  // 30 开头 ⇒ 非主板
    ['腿不足', { pct: 888, days: 2 }],   // days < RANGE20_LEADER_MIN_LEGS
    ['补位票', { pct: 777, days: 20 }],  // 16:30 补位：不在当日 9:25 名单
    ['无竞涨幅', { pct: 666, days: 20 }] // 名单里但没有竞价涨幅
  ]);
  const metricRows = [
    { stock: '主板A', code: '600001', auc_pct_chg: '+1.00%' },
    { stock: '主板B', code: '000002', auc_pct_chg: '+2.00%' },
    { stock: '主板C', code: '002003', auc_pct_chg: '+3.00%' },
    { stock: '创业板', code: '300004', auc_pct_chg: '+4.00%' },
    { stock: '腿不足', code: '600005', auc_pct_chg: '+5.00%' },
    { stock: '无竞涨幅', code: '600006', auc_pct_chg: null }
  ];
  return { pctMap, metricRows };
}

describe('buildTvrbAuctionBoard — 恒竞价口径 20 日榜（纯函数）', () => {
  it('① 只主板 + 腿数达标 + 当日 9:25 名单，按涨幅降序产三份同形状榜单', () => {
    const { pctMap, metricRows } = fixture();
    const b = buildTvrbAuctionBoard(pctMap, metricRows);
    expect(b.ready).toBe(true);
    expect(b.rank.map(r => r.stock)).toEqual(['主板A', '主板B', '主板C']);
    expect(b.top5).toEqual(b.rank.slice(0, 5));
    expect(b.wide).toEqual(b.rank.slice(0, 8));
    expect(b.top10).toEqual(b.rank.slice(0, 10));
    // 形状必须与 getRange20Leaders* 逐字一致（采集层 _buildPool 读 stock/pct/days/code）
    expect(Object.keys(b.top5[0]).sort()).toEqual(['code', 'days', 'pct', 'stock']);
    expect(b.top5[0]).toEqual({ stock: '主板A', code: '600001', pct: 90, days: 20 });
  });

  it('② ★ 16:30 补位票恒不进榜（11-10 事故根因之一）', () => {
    const { pctMap, metricRows } = fixture();
    const b = buildTvrbAuctionBoard(pctMap, metricRows);
    expect(b.rank.some(r => r.stock === '补位票')).toBe(false);
    expect(b.listed).toBe(5);                       // 只有 5 行有竞价涨幅
    expect(b.excludedNoAuc).toBe(1);                // 「无竞涨幅」被排除
    expect(b.rank.some(r => r.stock === '无竞涨幅')).toBe(false);
  });

  it('③ 非主板 / 腿数不足一律不占名次（与发布侧同一把尺子）', () => {
    const { pctMap, metricRows } = fixture();
    const b = buildTvrbAuctionBoard(pctMap, metricRows);
    expect(b.rank.some(r => r.stock === '创业板')).toBe(false);
    expect(b.rank.some(r => r.stock === '腿不足')).toBe(false);
    expect(b.covered).toBe(5);                     // 5 只在名单且有数值（含被门槛剔掉的 2 只）
  });

  it('④ §10 pctMap=null（读失败 / 表不可用）⇒ ready=false，⛔ 绝不返回空榜冒充「没有龙头」', () => {
    const { metricRows } = fixture();
    const b = buildTvrbAuctionBoard(null, metricRows);
    expect(b.ready).toBe(false);
    expect(b.reason).toBe('range20-read-failed');
    expect(b.top5).toEqual([]);
    expect(b.wide).toEqual([]);
    expect(b.top10).toEqual([]);
  });

  it('⑤ §10 指标行读失败 ⇒ ready=false', () => {
    const { pctMap } = fixture();
    const b = buildTvrbAuctionBoard(pctMap, null);
    expect(b.ready).toBe(false);
    expect(b.reason).toBe('metrics-read-failed');
  });

  it('⑥ 当日 9:25 名单为空 / 无主板票 ⇒ 判不出（不是「今天没有龙头」）', () => {
    const { pctMap } = fixture();
    expect(buildTvrbAuctionBoard(pctMap, []).reason).toBe('empty-auction-list');
    const onlyGrowth = buildTvrbAuctionBoard(
      new Map([['创业板', { pct: 999, days: 20 }]]),
      [{ stock: '创业板', code: '300004', auc_pct_chg: '+4%' }]
    );
    expect(onlyGrowth.ready).toBe(false);
    expect(onlyGrowth.reason).toBe('no-mainboard-rows');
  });

  it('⑦ 竞价涨幅固定 ⇒ 任何时刻重算都是同一份榜（收盘后不改变）', () => {
    const { pctMap, metricRows } = fixture();
    const a = buildTvrbAuctionBoard(pctMap, metricRows);
    // 模拟 15:00 / 16:30 之后：只有发布榜会变，本模块两份输入都是 9:25 定值
    const c = buildTvrbAuctionBoard(pctMap, metricRows);
    expect(c.rank).toEqual(a.rank);
    expect(c.top5).toEqual(a.top5);
  });

  it('⑧ 代码缺失时走 codeOf 兜底；仍拿不到 ⇒ 宁可少加票也不猜板块', () => {
    const pctMap = new Map([
      ['有兜底', { pct: 50, days: 20 }],
      ['无兜底', { pct: 40, days: 20 }]
    ]);
    const metricRows = [
      { stock: '有兜底', auc_pct_chg: '+1%' },
      { stock: '无兜底', auc_pct_chg: '+2%' }
    ];
    const b = buildTvrbAuctionBoard(pctMap, metricRows, {
      codeOf: n => (n === '有兜底' ? '600001' : '')
    });
    expect(b.rank.map(r => r.stock)).toEqual(['有兜底']);
    expect(b.excludedNoCode).toBe(1);
  });
});

// ── 模块级状态：单飞 / 指纹 / 日期核对 ───────────────────────────────────────────
vi.mock('../auction/range20-auction-leg.js', () => ({ readAuctionLegRange20Pct: vi.fn() }));
vi.mock('../../data/market-metrics.js', () => ({ readMarketMetricsForDate: vi.fn() }));
vi.mock('../../data/stock-code-map.js', () => ({ getStockCode: vi.fn(() => '') }));

import { readAuctionLegRange20Pct } from '../auction/range20-auction-leg.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';

describe('ensureTvrbAuctionBoard — 会话缓存 / 单飞 / §10 判不出', () => {
  beforeEach(() => {
    clearTvrbAuctionBoardCache();
    vi.clearAllMocks();
  });

  it('① 到货后同步读得到，且指纹随到货变化', async () => {
    const { pctMap, metricRows } = fixture();
    readAuctionLegRange20Pct.mockResolvedValue(pctMap);
    readMarketMetricsForDate.mockResolvedValue(metricRows);
    const before = getTvrbAuctionBoardToken();
    await ensureTvrbAuctionBoard('2026-11-10');
    const b = getTvrbAuctionBoard('2026-11-10');
    expect(b && b.ready).toBe(true);
    expect(hasTvrbAuctionBoardVerdict('2026-11-10')).toBe(true);
    expect(getTvrbAuctionBoardToken()).not.toBe(before);
    expect(getTvrbAuctionBoard('2026-11-11')).toBeNull();
  });

  it('② §32 同一天并发只发一轮取数（单飞）', async () => {
    const { pctMap, metricRows } = fixture();
    readAuctionLegRange20Pct.mockResolvedValue(pctMap);
    readMarketMetricsForDate.mockResolvedValue(metricRows);
    await Promise.all([
      ensureTvrbAuctionBoard('2026-11-10'),
      ensureTvrbAuctionBoard('2026-11-10'),
      ensureTvrbAuctionBoard('2026-11-10')
    ]);
    expect(readAuctionLegRange20Pct).toHaveBeenCalledTimes(1);
    expect(readMarketMetricsForDate).toHaveBeenCalledTimes(1);
  });

  it('③ §10 取数失败 ⇒ 记「读过但判不出」，⛔ 不抛错、不伪装成空榜', async () => {
    readAuctionLegRange20Pct.mockRejectedValue(new Error('HTTP 500'));
    readMarketMetricsForDate.mockResolvedValue([]);
    const b = await ensureTvrbAuctionBoard('2026-11-10');
    expect(b.ready).toBe(false);
    expect(hasTvrbAuctionBoardVerdict('2026-11-10')).toBe(true);
    expect(getTvrbAuctionBoard('2026-11-10')).toBeNull();
  });
});

// ── 定稿门控：竞价榜没算完 ⇒ 不许定稿（11-11 起【所有日期】，不再只限今天）────────
// 🔴 旧标题里的「仅今天」、旧用例 ④「历史日不强制」都建立在错误假设上：
//    「历史日口径本来就恒 close、结果稳定」。取证（11-11）：切历史日期会解冻重算，
//    11-10 的 20 日结果表 81 行全是 16:30 写的 close 腿、0 行 auc 腿，market_metrics 的
//    11-10 行 11-11 09:25 又被 worker 重写 ⇒ 历史输入恰恰最不稳定。
//    ⇒ 历史日跳过本门控，会在异步竞价口径榜算完前把中间态定稿冻结，票「消失」且改不回来。
describe('resolveBuySettle — 第⑬项（所有日期）', () => {
  const base = {
    date: '2026-11-10', prevDate: '', coreTopicsLoaded: true,
    buyRangeDate: '2026-11-10', curRangeDate: '2026-11-10',
    ebbHistoryDate: '2026-11-10', range10PresenceDate: '2026-11-10',
    range20Settled: true, topicLibraryReady: true, range10PoolReady: true,
    range20CoverageReady: true
  };
  it('① 老调用方不传新参数 ⇒ 零行为变化（§11）', () => {
    expect(resolveBuySettle(base).settled).toBe(true);
  });
  it('② 今天 + 竞价榜还没读过 ⇒ 挂住不定稿', () => {
    const r = resolveBuySettle(Object.assign({}, base, {
      auctionBoardToday: true, auctionBoardTried: false
    }));
    expect(r.settled).toBe(false);
    expect(r.missing).toContain('9:25 竞价口径 20 日涨幅榜');
  });
  it('③ 今天 + 读过（哪怕判不出）⇒ 放行（§10 读过就算落地）', () => {
    expect(resolveBuySettle(Object.assign({}, base, {
      auctionBoardToday: true, auctionBoardTried: true
    })).settled).toBe(true);
  });
  it('④ 🔴 [11-11 整类修复] 历史日同样强制 ⇒ 不许拿重算中间态定稿', () => {
    const r = resolveBuySettle(Object.assign({}, base, {
      auctionBoardToday: false, auctionBoardTried: false
    }));
    expect(r.settled).toBe(false);
    expect(r.missing).toContain('9:25 竞价口径 20 日涨幅榜');
  });
  it('⑤ 历史日「读过」（哪怕判不出）⇒ 放行（§10 读过就算落地，⛔ 不永久锁死）', () => {
    expect(resolveBuySettle(Object.assign({}, base, {
      auctionBoardToday: false, auctionBoardTried: true
    })).settled).toBe(true);
  });
});

// ── 静态契约锁：⛔ 不许把会随收盘变化的发布榜重新接回规则层 ───────────────────
describe('★ 静态契约 [TVRB-AUC-BOARD 2026-11-10]', () => {
  const SRC = fs.readFileSync(
    new URL('../../composables/useTopicVolRatioBoard.js', import.meta.url), 'utf8');
  const AT = SRC.indexOf('const rec = collectDecisionTopics(');
  const CALL = SRC.slice(AT, AT + 4200);

  it('① 三个 20 日榜入参必须走恒竞价口径变量', () => {
    expect(CALL).toContain('range20Top: _r20Top');
    expect(CALL).toContain('range20Wide: _r20Wide');
    expect(CALL).toContain('range20Top10: _r20Top10');
    expect(SRC).toContain('ensureTvrbAuctionBoard(d)');
    expect(SRC).toContain('void getTvrbAuctionBoardToken()');
  });

  it('② ★ 绝不允许 `range20Top: getRange20Leaders(d)` 这类直接注入复发', () => {
    expect(SRC).not.toContain('range20Top: getRange20Leaders(d)');
    expect(SRC).not.toContain('range20Wide: getRange20LeadersWide(d)');
    expect(SRC).not.toContain('range20Top10: getRange20LeadersTop10(d)');
  });

  it('③ 数据闸门 / 分歧买点 / 定稿门控都必须同源', () => {
    expect(SRC).toContain('range20Ready: _aucReady || hasRange20LeadersVerdictForDate(d)');
    expect(SRC).toContain('range20Count: (Array.isArray(_r20Top) ? _r20Top : []).length');
    expect(SRC).toContain('const _l0 = (Array.isArray(_r20Top) ? _r20Top : [])[0] || null');
    expect(SRC).toContain('auctionBoardTried: _aucReady || hasTvrbAuctionBoardVerdict(d)');
  });

  it('④ §10 回落必须可见（说明区写明不是竞价口径）', () => {
    expect(SRC).toContain('⚠️ 本日【9:25 竞价口径 20 日涨幅榜】判不出');
  });

  it('⑤ 🔴 [11-11] 回落警示不许再限定「只标今天」（历史日同样吃竞价口径榜）', () => {
    expect(SRC).not.toContain('只标今天：历史日的口径本来就恒 close');
    expect(SRC).not.toContain("d === _getLocalTodayStr() && hasTvrbAuctionBoardVerdict(d)");
    expect(SRC).toContain('if (!_aucReady && hasTvrbAuctionBoardVerdict(d))');
  });

  it('⑥ 🔴 [TVRB-PLAN-SNAPSHOT 11-11] 结论存档接线不许被拆掉（历史复盘稳定的唯一保障）', () => {
    expect(SRC).toContain('_loadPlanSnapshot(d)');
    expect(SRC).toContain('_persistPlanSnapshot(_pd, plan)');
    expect(SRC).toContain("snap.status === 'hit'");
    expect(SRC).toContain('planSnapshotReady: planSnapshotReady.value');
    expect(SRC).toContain('readPlanSnapshot');
    expect(SRC).toContain('writePlanSnapshot');
  });

  it('⑦ 🔴🔴 [REVISABLE 11-11] 历史日期必须能存、存档必须可修订（⛔ 不许退回「只写今天 / 只写一次」）', () => {
    // 用户：「历史日期既然能计算出来也要存起来……结果不是一成不变的」
    expect(SRC).toContain('currentRulesSig');
    expect(SRC).toContain('_recheckPlanSnapshotFreshness');
    expect(SRC).toContain('shouldPersistPlanSnapshot');
    expect(SRC).toContain('buildRulesFingerprint');
    expect(SRC).toContain("'stale'");
    expect(SRC).toContain('_recheckPlanSnapshotFreshness(\'user-refresh\')');
    // ⛔ 旧设计的两处标志，出现任意一处都说明被改回去了
    expect(SRC).not.toContain("key !== _getLocalTodayStr()");
    expect(SRC).not.toContain('ignoreDuplicates');
  });
});
