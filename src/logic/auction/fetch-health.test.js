// fetch-health.test.js — 「今日行情为什么没到」诊断的回归护栏
//
// 事故背景（2026-10-26）：numcat 两把 key 同时 403「今日调用额度已用完」⇒ market_metrics
// 当天 0 行 ⇒ 早盘竞价/题材量比等看板全部"加载中"。用户以为是自己反复刷新把数据刷没了。
// 本模块的唯一职责是把真实原因说清楚，所以三条红线必须锁住：
//   ① 不是今天 / 非交易日 / 没有行 / 行情已到 ⇒ 一律**不提示**（⛔ 不许到处弹）
//   ② 抓取失败（ok=false）⇒ 必须给出具体原因，且**明确指出与用户操作无关**
//   ③ 「读不到日志」与「没有记录」与「跑了但失败」三态⛔ 绝不合并（§10）

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TODAY = '2026-10-26';

vi.mock('../../data/fetch-log.js', () => ({ fetchMorningFetchLog: vi.fn() }));
vi.mock('./morning-sync.js', () => ({ _todayDataArrived: vi.fn() }));
vi.mock('./auction-pull-window.js', () => ({ beijingTodayStr: () => '2026-10-26' }));
vi.mock('../date/trading-day-helpers.js', () => ({ isTradingDay: vi.fn() }));
vi.mock('../app-state.js', () => ({ state: { _auctionMemCache: {} } }));
vi.mock('../../data/debug-log.js', () => ({ _dbgLog: () => {} }));

import { diagnoseTodayAuction, _reasonFromDetail, _humanize } from './fetch-health.js';
import { fetchMorningFetchLog } from '../../data/fetch-log.js';
import { _todayDataArrived } from './morning-sync.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { state } from '../app-state.js';

/** 造一份「名单已到」的内存缓存 */
function seedRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ stock: '票' + i, code: '60000' + i });
  state._auctionMemCache = { [TODAY]: rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  state._auctionMemCache = {};
  isTradingDay.mockReturnValue(true);
  _todayDataArrived.mockReturnValue(false);
  fetchMorningFetchLog.mockResolvedValue([]);
});

describe('_reasonFromDetail — 从 worker 日志里挑根因', () => {
  it('优先挑「额度」那行（它是整条链失败的源头，比后面的连带错误有用）', () => {
    const detail = {
      logs: [
        'today=2026-10-26 启动@09:25:18',
        '⚠️ numcat daily_auc key=NUMCAT_API_KEY 失败: 今日调用额度已用完（上游 code=403）',
        'numcat 调用失败: numcat daily_auc 错误: 今日调用额度已用完（上游 code=403）',
      ],
    };
    expect(_reasonFromDetail(detail)).toContain('额度');
    expect(_reasonFromDetail(detail)).toContain('403');
  });

  it('有 detail.error 时直接用它', () => {
    expect(_reasonFromDetail({ error: '抓取失败: 上游超时' })).toBe('抓取失败: 上游超时');
  });

  it('没有额度行时退而取最后一条带「失败 / 错误」的行', () => {
    const detail = { logs: ['开始', '命名解析完成', '抓取失败: 连接重置'] };
    expect(_reasonFromDetail(detail)).toBe('抓取失败: 连接重置');
  });

  it('detail 为空 / 非对象 / 无可用行 ⇒ 空串（⛔ 不编原因）', () => {
    expect(_reasonFromDetail(null)).toBe('');
    expect(_reasonFromDetail(undefined)).toBe('');
    expect(_reasonFromDetail({})).toBe('');
    expect(_reasonFromDetail({ logs: ['一切正常'] })).toBe('');
  });
});

describe('_humanize — 把长日志压成用户能读懂的一句', () => {
  it('额度类 ⇒ 直说是数据源额度用尽（不是"网络错误"这种没信息量的话）', () => {
    const t = _humanize('⚠️ numcat daily_auc key=X 失败: 今日调用额度已用完（上游 code=403）');
    expect(t).toContain('额度已用尽');
    expect(t).toContain('猫抓');
  });

  it('非额度类 ⇒ 去掉 ⚠️ 前缀后原样保留可读部分', () => {
    const t = _humanize('⚠️ 抓取失败: 连接重置');
    expect(t.indexOf('⚠')).toBe(-1);
    expect(t).toContain('连接重置');
  });

  it('超长原因截断到 100 字 + 省略号（手机一行放不下）', () => {
    const t = _humanize('错误'.repeat(200));
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t.endsWith('…')).toBe(true);
  });

  it('空串 ⇒ 空串', () => {
    expect(_humanize('')).toBe('');
  });
});

describe('diagnoseTodayAuction — 什么时候该提示 / 不该提示', () => {
  it('不是今天 ⇒ 不提示（历史日缺数据由按天补拉兜底，不吃"今日抓取失败"这套解释）', async () => {
    seedRows(50);
    const r = await diagnoseTodayAuction('2026-10-23');
    expect(r.need).toBe(false);
    expect(fetchMorningFetchLog).not.toHaveBeenCalled();
  });

  it('非交易日 ⇒ 不提示', async () => {
    seedRows(50);
    isTradingDay.mockReturnValue(false);
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(false);
  });

  it('今天一行都没有 ⇒ 不提示（"名单未到"另有提示，⛔ 不叠加两套说法）', async () => {
    state._auctionMemCache = {};
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(false);
  });

  it('行情已经到齐 ⇒ 不提示', async () => {
    seedRows(50);
    _todayDataArrived.mockReturnValue(true);
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(false);
  });
});

describe('diagnoseTodayAuction — 三态必须分开说（§10 读不到 ≠ 没有 ≠ 失败）', () => {
  it('★ 跑了但失败（ok=false，额度用尽）⇒ warn + 具体原因 + 明确「不是你操作的问题」', async () => {
    seedRows(50);
    fetchMorningFetchLog.mockResolvedValue([{
      ok: false,
      detail: {
        logs: [
          'today=2026-10-26 启动@09:25:18',
          'auction_watchlist 写入 49 行',
          '⚠️ numcat daily_auc 失败: 今日调用额度已用完（上游 code=403）',
        ],
      },
    }]);
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(true);
    expect(r.level).toBe('warn');
    expect(r.title).toContain('50');          // 名单已就绪 50 只
    expect(r.text).toContain('额度');
    expect(r.text).toContain('刷新');          // 明确劝阻反复刷新
  });

  it('没有任何记录（[]）⇒ info +「还没有自动抓取记录」，⛔ 不能说成失败', async () => {
    seedRows(50);
    fetchMorningFetchLog.mockResolvedValue([]);
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(true);
    expect(r.level).toBe('info');
    expect(r.text).toContain('还没有自动抓取记录');
    expect(r.text).not.toContain('额度');
  });

  it('日志读不到（抛错）⇒ info + 如实说「无法确定原因」，⛔ 不猜', async () => {
    seedRows(50);
    fetchMorningFetchLog.mockRejectedValue(new Error('network down'));
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(true);
    expect(r.level).toBe('info');
    expect(r.text).toContain('无法确定原因');
    expect(r.text).not.toContain('额度');
  });

  it('ok=true 但行情仍没到 ⇒ info +「可能还在写入」，不能说成失败', async () => {
    seedRows(50);
    fetchMorningFetchLog.mockResolvedValue([{ ok: true, detail: { logs: ['完成'] } }]);
    const r = await diagnoseTodayAuction(TODAY);
    expect(r.need).toBe(true);
    expect(r.level).toBe('info');
    expect(r.text).toContain('写入');
  });
});
