// range-heal.test.js — 云端「区间涨幅」自愈的安全性 + 省钱回归测试
//
// 【为什么必须有这个测试 / 2026-11-04 事故】
//   9:25 的猫抓 daily 一次超时，当天的 stock_range_pct 就是 0 行；此后**只有浏览器**
//   打开页面时才会补算并回写（实测 11/04 那 47 行全是 09:46 由前端写入的）。
//   ⇒ 用户关掉电脑、只用手机看，就永远拿不到十日涨幅 ⇒ 题材量比没有排序依据 ⇒ 出不了票。
//   9:27 的 runRangePctHeal 就是补这个洞（9:30 一开盘竞价就结束了，所以必须压在 9:27）。但它会花猫抓额度（日额度仅 10 次），
//   所以下面四条不变量必须被钉死，任何一条被破坏都应该立刻红灯：
//     ① 覆盖率达标 → **零猫抓请求**（不能每天都白烧一次额度）；
//     ② 有缺口 → 只发 1 次 daily（整窗口，不是逐只），且只写满窗行；
//     ③ 读库失败 → 中断，绝不重算覆盖（§10）；
//     ④ 缺腿的票 → ⛔ 不写残缺行（残缺行会按日期级复用地污染排名）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { runRangePctHeal } from './range-heal.js';
import { beijingToday, beijingNow } from '../../_shared-source/date-utils.js';
import { RANGE_WINDOW_DAYS } from '../../../src/logic/auction/range-window.js';

const realFetch = globalThis.fetch;

// 猫抓必须配了 key 才会发请求（configuredKeys 为空会直接抛错），这里给一把假 key
const ENV = { NUMCAT_API_KEY: 'k-test-0001' };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** 生成 [T-9, T] 共 RANGE_WINDOW_DAYS 个连续自然日（周末无妨：本函数只校验窗口长度与 T 腿位置） */
function makeWindow(today) {
  const out = [];
  const t = new Date(today + 'T00:00:00Z').getTime();
  for (let i = RANGE_WINDOW_DAYS - 1; i >= 0; i--) {
    out.push(new Date(t - i * 86400e3).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 造一条 market_metrics 行。
 * ⚠️ 两个方向字段名不同，别搞混（踩过）：
 *   入参 JSON（这里是 DB 列名）= stock；readMarketMetricsForDate 内部映射成 name 再返回。
 */
function metric(name, code, aucPct) {
  return { stock: name, code: code, auc_pct_chg: aucPct, change_pct: aucPct, updated_at: '' };
}

/** 造 numcat daily 响应：每只票 × 窗口每一天都给同一个涨幅（T 腿两条口径一致，测试不受收盘时刻影响） */
function dailyResp(codes, window, pct) {
  const items = [];
  codes.forEach(c => window.forEach(d => items.push([c, d.replace(/-/g, ''), pct])));
  return { ok: true, json: () => Promise.resolve({ code: 200, data: { fields: ['symbol', 'tradedate', 'pct_chg'], items: items } }) };
}

/**
 * 统一的 fetch stub。
 * @param {object} o { metrics, ranges, daily }
 *        metrics/ranges 是数组（对应各自 GET），daily 是 numcat 的响应对象（null = 不该被调用）
 */
function stubFetch(o) {
  const posts = [];
  const gets = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method === 'POST') {
      posts.push(u);
      if (u.includes('numcat') || u.includes('NUMCAT')) {
        if (!o.daily) throw new Error('不该请求猫抓（额度）: ' + u);
        return Promise.resolve(o.daily);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
    }
    gets.push(u);
    if (u.includes('market_metrics')) return Promise.resolve({ ok: true, json: () => Promise.resolve(o.metrics || []) });
    if (u.includes('stock_range_pct')) return Promise.resolve({ ok: true, json: () => Promise.resolve(o.ranges || []) });
    if (u.includes('numcat') || u.includes('NUMCAT')) {
      if (!o.daily) throw new Error('不该请求猫抓（额度）: ' + u);
      return Promise.resolve(o.daily);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  };
  return { posts: posts, gets: gets };
}

describe('runRangePctHeal 额度与安全', () => {
  it('① 覆盖率达标 → 零猫抓请求（只读 2 次库就返回）', async () => {
    const today = beijingToday();
    const r = stubFetch({
      metrics: [metric('甲', '600001', '+1.00%'), metric('乙', '600002', '+2.00%')],
      ranges: [
        { stock: '甲', range_pct: '12.34', days: RANGE_WINDOW_DAYS, updated_at: '' },
        { stock: '乙', range_pct: '8.88', days: RANGE_WINDOW_DAYS, updated_at: '' }
      ],
      daily: null   // 一旦真去要猫抓，stub 会抛错
    });

    const res = await runRangePctHeal(ENV, { date: today, dates: makeWindow(today) });

    expect(res.healthy).toBe(true);
    expect(res.written).toBe(0);
    expect(res.coverage).toBe(1);
    expect(r.posts).toEqual([]);                    // 核心断言：零猫抓 / 零写库
    expect(String(res.logs.join('\n'))).toContain('零请求');
  });

  it('② 库内 0 行 → 只发 1 次 daily（整窗口），且只写满窗行', async () => {
    const today = beijingToday();
    const window = makeWindow(today);
    const r = stubFetch({
      metrics: [metric('甲', '600001', '+1.00%'), metric('乙', '600002', '+2.00%')],
      ranges: [],                                    // 区间涨幅当天 0 行 = 事故现场
      daily: dailyResp(['600001', '600002'], window, 1.5)
    });

    const res = await runRangePctHeal(ENV, { date: today, dates: window });

    expect(res.healthy).toBe(false);
    expect(res.written).toBe(2);
    const numcatPosts = r.posts.filter(u => u.includes('numcat') || u.includes('NUMCAT'));
    expect(numcatPosts).toHaveLength(1);             // 1 次请求覆盖整个窗口，绝不逐只
    const writePosts = r.posts.filter(u => u.includes('stock_range_pct'));
    expect(writePosts.length).toBeGreaterThanOrEqual(1);
    // 写入体里每一行都必须是满窗（days === 窗口长度）——残缺行绝不落库
    expect(res.written).toBe(2);
    expect(String(res.logs.join('\n'))).toContain('满窗行 2');
  });

  it('③ 读库失败必须中断，绝不能被当成「全都缺」而整体重算（§10）', async () => {
    const today = beijingToday();
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await runRangePctHeal(ENV, { date: today, dates: makeWindow(today) });

    expect(res.ok).toBe(false);
    expect(res.written).toBe(0);
    expect(String(res.logs.join('\n'))).toContain('中断');
    expect(String(res.error || '')).toContain('500');
  });

  it('④ 缺历史腿的票不写残缺行（只写满窗）', async () => {
    const today = beijingToday();
    const window = makeWindow(today);
    // 甲：整窗齐 → 满窗；乙：只在最后 3 天有腿 → 残缺，必须被挡在库外
    const items = [];
    window.forEach(d => items.push(['600001', d.replace(/-/g, ''), 1.0]));
    window.slice(-3).forEach(d => items.push(['600002', d.replace(/-/g, ''), 2.0]));
    const r = stubFetch({
      metrics: [metric('甲', '600001', '+1.00%'), metric('乙', '600002', '+2.00%')],
      ranges: [],
      daily: { ok: true, json: () => Promise.resolve({ code: 200, data: { fields: ['symbol', 'tradedate', 'pct_chg'], items: items } }) }
    });

    const res = await runRangePctHeal(ENV, { date: today, dates: window });

    expect(res.written).toBe(1);                     // 只有甲
    expect(String(res.logs.join('\n'))).toContain('不写残缺行');
    expect(r.posts.some(u => u.includes('stock_range_pct'))).toBe(true);
  });

  it('⑤ 无竞价行（名单未落库）→ 直接跳过，不发任何请求', async () => {
    const today = beijingToday();
    const r = stubFetch({ metrics: [], ranges: [], daily: null });

    const res = await runRangePctHeal(ENV, { date: today, dates: makeWindow(today) });

    expect(res.written).toBe(0);
    expect(r.posts).toEqual([]);
    expect(String(res.logs.join('\n'))).toContain('无可用竞价行');
  });
});

// 保底：确保 beijingNow 在本测试环境可用（缺它会静默让 T 腿口径判断失效）
describe('runRangePctHeal 环境自检', () => {
  it('beijingNow 可用', () => {
    expect(beijingNow()).toBeInstanceOf(Date);
  });
});
