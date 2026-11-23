// range30-fetch.test.js — 「30日涨幅补位票并入 9:25 抓取名单」的取数口径 + 接线回归测试
//
// 【为什么必须有这个测试 / 2026-11-23 用户报障】
//   用户原话：「30日强势补位的票为什么没有显示完整数据，五日趋势图几乎是空白，只有当天三个数据，
//   其余都没数据，我之前要求它获取数据的标准和20日强势补位一样，20日的强势补位票是放到worker中的，
//   和同花顺最近多板源股票一起获取数据，这样就是消耗同一个额度，就可以获取数据，你审查下30日强势
//   补位的票是不是这个逻辑，如果不是的话，要完善下。」
//
//   审查结论：**不是**。`fetchAndWriteWatchlist` 的组B 只有 5 路，只把 `range20Stocks` 并进
//   `constituents`；`stock_range30_pct` 那张榜从头到尾没被读过 ⇒ 30天补位票当天在
//   `market_metrics` 【无行】⇒ 竞价量比（唯一来源 = 猫抓 `daily_auc.auc_vol_ratio`，§1 铁律）
//   整列 `-`；前端 `trend-patch.js` 只能用腾讯日线补「涨幅 / 竞价涨幅 / 昨日成交量」三项
//   ⇒ 屏幕上正是「当天三个数据 + 两个破折号」。
//
// 【本文件钉死的东西】
//   A. `readRange30TopForDate` 的五条取数不变量（与 20 日逐条对齐，⛔ 不许各自演化）：
//      ① `pct` 是文本列 ⇒ 必须按 Number 降序（字典序会把 8.94 排在 78.46 前面）；
//      ② 脏写法可解析（' 8.94 % ' / '1,234.50'）；
//      ③ 空 / 非数值 pct 剔除，⛔ 绝不当 0 参与排名（§10）；
//      ④ 读失败必须抛错并带 `[R30-FETCH]` 定位标记，⛔ 不许伪装成「昨天榜为空」；
//      ⑤ 同股双腿只取一行且 close 优先（该表目前只有 close，但主键含 leg，未来出现双腿不能混口径）。
//   B. `mergeRankedStocksIntoConstituents`（20 日 / 30 日共用的一份实现）的行为：
//      并入的是 `constituents` 抓取名单，⛔ 不产生任何 watchlist 行；查不到 code 必须逐只留痕。
//   C. 接线静态锁：组B 必须真的读了 30 日榜、并且**两条榜都走同一个合并函数**
//      （本轮事故的类根因就是「20 日加了、30 日没加」——抄成两份必然还会漏第三份）。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRange30TopForDate } from '../data/supabase-write.js';
import { mergeRankedStocksIntoConstituents } from '../logic/morning-workflow.js';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-test' };
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** 用一个假 fetch 固定返回给定的行；并记录被请求的 URL */
function stubRows(rows, opt) {
  const o = opt || {};
  const calls = [];
  globalThis.fetch = async function (url) {
    calls.push(String(url));
    if (o.status && o.status !== 200) {
      return { ok: false, status: o.status, text: async () => 'boom' };
    }
    return { ok: true, status: 200, json: async () => rows };
  };
  return calls;
}

describe('readRange30TopForDate —— 30日涨幅榜取数口径（与 20 日逐条对齐）', () => {
  it('① 按【数值】降序：字典序会把 8.94 排在 78.46 前面，这里必须反过来', async () => {
    stubRows([
      { stock: '弱票A', pct: '8.94', days: 30, leg: 'close' },
      { stock: '强票B', pct: '78.46', days: 30, leg: 'close' },
      { stock: '中票C', pct: '9.18', days: 30, leg: 'close' }
    ]);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 5);
    expect(out.map(r => r.name)).toEqual(['强票B', '中票C', '弱票A']);
    expect(out[0].pct).toBe(78.46);
  });

  it('② 脏写法可解析：带 % / 空格 / 千分位逗号', async () => {
    stubRows([
      { stock: 'A', pct: ' 8.94 % ', days: 30, leg: 'close' },
      { stock: 'B', pct: '1,234.50', days: 30, leg: 'close' }
    ]);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 5);
    expect(out.map(r => r.name)).toEqual(['B', 'A']);
    expect(out[0].pct).toBe(1234.5);
    expect(out[1].pct).toBeCloseTo(8.94, 6);
  });

  it('③ 空/非数值 pct 必须剔除 —— ⛔ 绝不当 0 参与排名', async () => {
    stubRows([
      { stock: '空值票', pct: null, days: 30, leg: 'close' },
      { stock: '空串票', pct: '', days: 30, leg: 'close' },
      { stock: '乱码票', pct: '--', days: 30, leg: 'close' },
      { stock: '正常票', pct: '-3.20', days: 30, leg: 'close' }
    ]);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 5);
    expect(out.map(r => r.name)).toEqual(['正常票']);
  });

  it('④ 表里 0 行 → []（当天榜 9:25 必然为空：要与读失败严格区分）', async () => {
    stubRows([]);
    await expect(readRange30TopForDate(ENV, '2026-11-23', 20)).resolves.toEqual([]);
  });

  it('④b [§10] 读失败必须抛错，且错误里带 [R30-FETCH] 定位标记', async () => {
    stubRows(null, { status: 500 });
    await expect(readRange30TopForDate(ENV, '2026-11-20', 20))
      .rejects.toThrow(/\[R30-FETCH\] 读取 stock_range30_pct\(2026-11-20\) 失败: HTTP 500/);
  });

  it('⑤ 同股双行：只取一行，且优先收盘口径（未来出现 auc 腿时不混口径）', async () => {
    stubRows([
      { stock: '双行票', pct: '10.00', days: 30, leg: 'close' },
      { stock: '双行票', pct: '9.00', days: 30, leg: 'auc' },
      { stock: '单行票', pct: '11.00', days: 30, leg: 'close' }
    ]);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 10);
    expect(out).toHaveLength(2);
    const dup = out.find(r => r.name === '双行票');
    expect(dup.leg).toBe('close');
    expect(dup.pct).toBe(10);
    expect(out.map(r => r.name)).toEqual(['单行票', '双行票']);
  });

  it('⑤b leg 为空按 close 对待（旧行缺省就是收盘口径）', async () => {
    stubRows([{ stock: '空腿票', pct: '6.00', days: 30, leg: '' }]);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 10);
    expect(out[0].leg).toBe('close');
  });

  it('取前 N 只：limit 生效', async () => {
    const rows = [];
    for (let i = 1; i <= 40; i++) rows.push({ stock: 'S' + i, pct: String(i), days: 30, leg: 'close' });
    stubRows(rows);
    const out = await readRange30TopForDate(ENV, '2026-11-20', 25);
    expect(out.length).toBe(25);
    expect(out[0].name).toBe('S40');
  });

  it('查询参数：读的是 stock_range30_pct、按日期过滤，且必须在 JS 里排序', async () => {
    const calls = stubRows([]);
    await readRange30TopForDate(ENV, '2026-11-20', 20);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('stock_range30_pct');
    expect(calls[0]).toContain('date=eq.2026-11-20');
    expect(calls[0]).not.toContain('order=pct.desc');   // 文本列字典序 = 错榜
  });
});

// 20 日 / 30 日共用的一份合并实现 —— 两条榜都必须靠它进抓取名单（§6 单一实现）
describe('mergeRankedStocksIntoConstituents —— 涨幅榜候选并入抓取名单（唯一实现）', () => {
  const CODE_MAP = { 百洋股份: '002696', 慈文传媒: '002343', 东方海洋: '002086', 无名票: '' };

  it('① 名单里没有的 30 天补位票要并进 constituents（这才是量比能落库的前提）', () => {
    const logs = [];
    const base = [{ name: '最近多板A', code: '600001' }];
    const out = mergeRankedStocksIntoConstituents(
      base,
      [{ name: '百洋股份', pct: 70.10 }, { name: '慈文传媒', pct: 67.84 }],
      CODE_MAP,
      { label: '30日涨幅补位', prevDay: '2026-11-20', logs: logs }
    );
    expect(out.map(c => c.name)).toEqual(['最近多板A', '百洋股份', '慈文传媒']);
    expect(out[1]).toEqual({ name: '百洋股份', code: '002696' });
    expect(logs[0]).toBe('30日涨幅补位(基于 2026-11-20 完整榜, 前 2 名): 2 只，' +
      '合并到抓取名单（不写 watchlist，0 猫抓额度）');
  });

  it('② ⛔ 不写 watchlist：产出的对象只有 name/code，没有 date/source/obs_auto_added', () => {
    const out = mergeRankedStocksIntoConstituents(
      [], [{ name: '百洋股份', pct: 70 }], CODE_MAP,
      { label: '30日涨幅补位', prevDay: '2026-11-20', logs: [] }
    );
    expect(Object.keys(out[0]).sort()).toEqual(['code', 'name']);
  });

  it('③ 已在名单内 / code 重复 ⇒ 不重复并入，且日志如实说「均已在抓取名单内」', () => {
    const logs = [];
    const base = [{ name: '东方海洋', code: '002086' }];
    const out = mergeRankedStocksIntoConstituents(
      base, [{ name: '东方海洋', pct: 79.15 }], CODE_MAP,
      { label: '20日涨幅补位', prevDay: '2026-11-20', logs: logs }
    );
    expect(out).toHaveLength(1);
    expect(logs[0]).toBe('20日涨幅补位: 榜上前 1 名均已在抓取名单内');
  });

  it('④ §10 查不到 code 的票 ⛔ 不许静默丢弃：一条都不并入，但必须逐只打印名字', () => {
    const logs = [];
    const out = mergeRankedStocksIntoConstituents(
      [], [{ name: '无名票', pct: 50 }, { name: '百洋股份', pct: 40 }], CODE_MAP,
      { label: '30日涨幅补位', prevDay: '2026-11-20', logs: logs }
    );
    expect(out.map(c => c.name)).toEqual(['百洋股份']);
    const warn = logs.find(function (l) { return l.indexOf('⚠️ 30日涨幅补位有 1 只查不到 code') === 0; });
    expect(warn).toBeTruthy();
    expect(warn).toContain('无名票');
  });

  it('⑤ 空榜 / 非数组 ⇒ 原样返回（§10 空 ≠ 读失败，⛔ 不抛错、不造票）', () => {
    const base = [{ name: 'A', code: '600001' }];
    expect(mergeRankedStocksIntoConstituents(base, [], CODE_MAP,
      { label: '30日涨幅补位', prevDay: '2026-11-20', logs: [] })).toBe(base);
    expect(mergeRankedStocksIntoConstituents(base, null, CODE_MAP,
      { label: '30日涨幅补位', prevDay: '2026-11-20', logs: [] })).toBe(base);
  });
});

describe('接线静态锁 —— 组B 必须真的读了 30 日榜，且两条榜走同一份合并实现', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = fs.readFileSync(path.join(HERE, '..', 'logic', 'morning-workflow.js'), 'utf8');

  it('⑥ 组B 必须把 readRange30TopForDate 放进 Promise.all（否则 30 天补位票永远无行）', () => {
    expect(SRC).toContain('readRange30TopForDate(env, prevDay, RANGE30_FETCH_TOP_N)');
    // 🔴 取 50 而不是 20 日那个 25：真实库实测 11-20 的 30 日榜里百洋股份只排第 45（9.77%），
    //   而它正是 11-23 用户截图里 30天补位的第一名 ⇒ 取 25 等于修不好用户看到的那只票。
    expect(SRC).toContain('const RANGE30_FETCH_TOP_N = 50;');
    // 六路并行：range30Res 必须和 range20Res 在同一个解构里
    expect(SRC).toMatch(/const \[prevWlRes, todayWlRes, tagRes, dragonRes, range20Res, range30Res\]/);
  });

  it('⑦ 读失败必须计入 groupBReadFailures（否则「读不到」会被当成「昨天没榜」）', () => {
    expect(SRC).toContain('[prevWlRes, todayWlRes, tagRes, dragonRes, range20Res, range30Res]');
  });

  it('⑧ 30 日榜的名字要进「按名补码」池（该表没有 code 列）', () => {
    expect(SRC).toContain('.concat(range30Stocks)');
  });

  it('⑨ ⛔ 两条榜必须调用同一个 mergeRankedStocksIntoConstituents（本轮类根因就是抄少一份）', () => {
    expect(SRC).toContain('mergeRankedStocksIntoConstituents(constituents, range20Stocks, codeMap');
    expect(SRC).toContain('mergeRankedStocksIntoConstituents(constituents, range30Stocks, codeMap');
    // 同一个函数只能定义一次（⛔ 不许退回「各写一份内联循环」）
    expect((SRC.match(/function mergeRankedStocksIntoConstituents\(/g) || []).length).toBe(1);
  });
});
