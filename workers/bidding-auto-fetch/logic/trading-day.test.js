// trading-day.test.js — 交易日判定「三源合并」回归测试
//
// 锁死 2026-09-29 两起真实事故，防止再犯：
//   ① 硬编码表【漏】2026-09-25（中秋）→ worker 把休市日当交易日跑整轮，写脏名单、prevDay 错位；
//   ② 硬编码表【多】2026-10-08 → 开市日被判「非交易日」→ 早盘 + 收盘两轮整轮 skip
//      （当天四个趋势图与十日涨幅全空）。
// 以及本次新机制：用户在前端顶栏标的假期（云端覆盖表）必须能压过 fuyao 与硬编码表 ——
// 这是唯一能提前表达「国庆连休」这类未来假期的手段（fuyao 至多只能判到次日）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mergeTradingDay, resolveIsTradingDay, fetchTradingDayOverrides, _resetTradingDayOverrideCache
} from '../../_shared-source/trading-day.js';
import { getRecentTradingDays, isTradingDay } from './holiday-check.js';

const OVERRIDE_URL_PART = '/rest/v1/trading_day_overrides';
const FUYAO_PROXY_PART = 'fuyao-proxy';

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'test-key' };

function urlOf(u) {
  if (typeof u === 'string') return u;
  if (u && typeof u.url === 'string') return u.url;
  return String(u);
}

/**
 * 拦下所有网络请求。⚠️ fuyao 那一路必须返回【成功】响应：
 * fuyaoCalendarTradingDays 内层有 retryFuyao(4 次、900/1800/3600ms 退避)，返回 5xx 会让测试白等 6 秒+。
 * 「fuyao 不可用」的路径改用 mergeTradingDay(…, null) 纯函数覆盖，不走网络。
 */
function stubFetch({ overrides = [], fuyaoDates = [], failOverride = false } = {}) {
  const fn = vi.fn(async (url) => {
    const u = urlOf(url);
    if (u.includes(OVERRIDE_URL_PART)) {
      if (failOverride) return { ok: false, status: 500, text: async () => 'db down' };
      return { ok: true, status: 200, json: async () => overrides };
    }
    if (u.includes(FUYAO_PROXY_PART)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { item: fuyaoDates.map(d => ({ date: d.replace(/-/g, '') })) } })
      };
    }
    throw new Error('测试未预期的请求: ' + u);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { _resetTradingDayOverrideCache(); });
afterEach(() => { vi.unstubAllGlobals(); _resetTradingDayOverrideCache(); });

describe('mergeTradingDay · 四层优先级（纯函数）', () => {
  it('① 用户标为假期 → 非交易日，压过 fuyao 与硬编码表', () => {
    // 2026-10-08 硬编码表里是交易日、fuyao 也说它是交易日，但用户标了假期 → 以用户为准
    expect(mergeTradingDay('2026-10-08', new Map([['2026-10-08', true]]), ['2026-10-08'])).toBe(false);
  });

  it('① 用户显式取消假期 → 交易日，压过硬编码表（取消靠 is_holiday=false，不是删行）', () => {
    // 2026-10-01 是硬编码表里的法定假期；用户显式取消 → 必须判为交易日
    expect(mergeTradingDay('2026-10-01', new Map([['2026-10-01', false]]), [])).toBe(true);
  });

  it('② 周末优先级高于 fuyao：fuyao 说它是交易日也不算', () => {
    expect(mergeTradingDay('2026-10-10', null, ['2026-10-10'])).toBe(false); // 2026-10-10 周六
  });

  it('③ fuyao 覆盖区间内命中 → 交易日；区间内未命中 → 假期（真实日历能覆盖调休）', () => {
    const fuyao = ['2026-09-24', '2026-09-28'];
    expect(mergeTradingDay('2026-09-28', null, fuyao)).toBe(true);
    expect(mergeTradingDay('2026-09-25', null, fuyao)).toBe(false);
  });

  it('③ fuyao 覆盖区间外 → 弃权，交给硬编码表（绝不因「日历里没有」就判非交易日）', () => {
    const fuyao = ['2026-09-24', '2026-09-28'];
    // 2026-09-30 晚于日历 last（区间外），硬编码表里不是假期 → 交易日
    expect(mergeTradingDay('2026-09-30', null, fuyao)).toBe(true);
  });

  it('④ 硬编码表已修正：9/25 中秋=假期、10/08 开市日=交易日、10/01 假期', () => {
    expect(mergeTradingDay('2026-09-25', null, null)).toBe(false); // 事故①：原来漏了这天
    expect(mergeTradingDay('2026-10-08', null, null)).toBe(true);  // 事故②：原来多了这天
    expect(mergeTradingDay('2026-10-01', null, null)).toBe(false);
  });
});

describe('resolveIsTradingDay · 覆盖表读取与降级（§10 禁止静默失败）', () => {
  it('读到用户设置 → 判定以用户为准，日志标明来源', async () => {
    stubFetch({ overrides: [{ date: '2026-10-08', is_holiday: true }] });
    const logs = [];
    const ok = await resolveIsTradingDay(
      ENV, ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, '2026-10-08', ['2026-10-08'], logs
    );
    expect(ok).toBe(false);
    expect(logs.join('\n')).toContain('用户前端设置:假期');
  });

  it('覆盖表读取失败 → 明确记日志，并继续用后续判据（读不到 ≠ 非交易日）', async () => {
    stubFetch({ failOverride: true });
    const logs = [];
    const ok = await resolveIsTradingDay(
      ENV, ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, '2026-10-08', null, logs
    );
    expect(ok).toBe(true);
    expect(logs.join('\n')).toContain('交易日覆盖表读取失败');
  });

  it('缺少 baseUrl/key → fetchTradingDayOverrides 直接返回 null（不发请求）', async () => {
    const fn = stubFetch({});
    expect(await fetchTradingDayOverrides('', '')).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('getRecentTradingDays · 窗口推算必须认用户设置', () => {
  // 模拟 fuyao 日历被上游截断/过期、误把中秋 9/25 当成交易日
  const FUYAO_WITH_0925 = ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'];

  it('无用户设置 → 以 fuyao 为准（9/25 进窗口）', async () => {
    stubFetch({ overrides: [], fuyaoDates: FUYAO_WITH_0925 });
    expect(await getRecentTradingDays(ENV, '2026-09-29', 3))
      .toEqual(['2026-09-25', '2026-09-28', '2026-09-29']);
  });

  it('用户标 9/25 为假期 → 从窗口剔除（这正是 9/28 prevDay 错位的根因）', async () => {
    stubFetch({ overrides: [{ date: '2026-09-25', is_holiday: true }], fuyaoDates: FUYAO_WITH_0925 });
    expect(await getRecentTradingDays(ENV, '2026-09-29', 3))
      .toEqual(['2026-09-24', '2026-09-28', '2026-09-29']);
  });

  it('周末天然不进窗口，无需用户标注', async () => {
    stubFetch({ overrides: [], fuyaoDates: FUYAO_WITH_0925 });
    const days = await getRecentTradingDays(ENV, '2026-09-29', 5);
    expect(days.some(d => ['2026-09-26', '2026-09-27'].includes(d))).toBe(false);
  });
});

describe('isTradingDay · 用户设置优先于 fuyao', () => {
  it('fuyao 含该日、但用户标了假期 → 非交易日', async () => {
    stubFetch({ overrides: [{ date: '2026-09-25', is_holiday: true }], fuyaoDates: ['2026-09-25'] });
    expect(await isTradingDay(ENV, '2026-09-25')).toBe(false);
  });

  it('无用户设置、fuyao 含该日 → 交易日', async () => {
    stubFetch({ overrides: [], fuyaoDates: ['2026-09-25'] });
    expect(await isTradingDay(ENV, '2026-09-25')).toBe(true);
  });
});
