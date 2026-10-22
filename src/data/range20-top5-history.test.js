// range20-top5-history.test.js — 「20日涨幅前五 · 历史每日榜」读取入口
//
// 【为什么必须有这个测试】第二十八条（新龙 / 新题材切换日）的判据是
//   「20 个交易日内，这只股票有没有上过前五」——它只可能由【历史每天的榜】回答。
//   这里一旦判错，后果不是「少选一只」而是【把老龙当新龙买进去】。三条不可退让的判据：
//
//   ① 同一天两腿（leg='auc' 9:25 / leg='close' 15:05）必须【只认一腿】且优先 close。
//      漏了 ⇒ 同一只票在榜上出现两次、名次被它自己挤掉别人 ⇒ 「首次上榜」判错。
//   ② 分页必须真的翻页：20 天 × 80 只 ≈ 1600 行 > 单次 1000 行上限。
//      漏了 ⇒ 后面的日期整段读不到 ⇒ 那些天上过榜的老票被当成「首次上榜」。
//   ③ 读失败必须 throw（⛔ 绝不返回空 Map 冒充「这些天都没有榜」）——§10。
//      空 Map 会让规则层算出「五只全是首次上榜」= 全买，这是最坏的一种静默错误。
//
// ⚠️ 覆盖度如实上报：`days` = 真正拿到榜的天数。系统里可能只有 10 天有落库行，
//   规则层要把它写进说明（「近 N 个交易日」不能假装查过 N 天）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];
let mode = 'ok';
/** date -> 行数组（每行 {date, stock, pct, leg}） */
let rowsByDate = {};

function makeQuery(table) {
  const st = { table: table, inDates: null, from: 0, to: 0 };
  calls.push(st);
  const done = function() {
    if (mode === 'fail') return { data: null, error: { message: '读取失败' } };
    const all = [];
    (st.inDates || []).forEach(function(d) {
      (rowsByDate[d] || []).forEach(function(r) { all.push(r); });
    });
    all.sort(function(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return { data: all.slice(st.from, st.to + 1), error: null };
  };
  const b = {
    select: function() { return b; },
    in: function(col, list) { st.inDates = list; return b; },
    order: function() { return b; },
    range: function(from, to) { st.from = from; st.to = to; return b; },
    then: function(res, rej) { return Promise.resolve(done()).then(res, rej); }
  };
  return b;
}

vi.mock('./supabase-client.js', function() {
  return { getSupabase: function() { return { from: makeQuery }; } };
});

const { readTop5History, everInTop5Set, clearTop5HistoryCache, TOP5_HISTORY_N } =
  await import('./range20-top5-history.js');

beforeEach(function() {
  calls.length = 0;
  mode = 'ok';
  rowsByDate = {};
  clearTop5HistoryCache();
});

/** 造一天的榜：pcts 按 index 递减（第一只最强） */
function dayPcts(date, entries) {
  rowsByDate[date] = entries.map(function(e) {
    return { date: date, stock: e[0], pct: e[1], leg: e[2] || 'close' };
  });
}

describe('range20-top5-history · 单日两腿（auc / close）只认一腿', function() {
  it('同一天同时有 auc 与 close ⇒ 取 close 的值，且该票只出现一次', async function() {
    rowsByDate['2026-10-20'] = [
      { date: '2026-10-20', stock: '新华传媒', pct: 182.5, leg: 'auc' },
      { date: '2026-10-20', stock: '新华传媒', pct: 188.12, leg: 'close' },
      { date: '2026-10-20', stock: '九阳股份', pct: 133.69, leg: 'close' }
    ];
    const r = await readTop5History(['2026-10-20']);
    const names = r.byDate.get('2026-10-20');
    expect(names).toEqual(['新华传媒', '九阳股份']);   // ⛔ 新华传媒不重复
    expect(r.days).toBe(1);
  });

  it('同一天两腿顺序反过来（close 先到）⇒ 仍然是 close 胜出', async function() {
    rowsByDate['2026-10-20'] = [
      { date: '2026-10-20', stock: 'A', pct: 50, leg: 'close' },
      { date: '2026-10-20', stock: 'A', pct: 40, leg: 'auc' },
      { date: '2026-10-20', stock: 'B', pct: 45, leg: 'close' }
    ];
    const r = await readTop5History(['2026-10-20']);
    expect(r.byDate.get('2026-10-20')).toEqual(['A', 'B']);   // A 用 50 参与排序
  });

  it('只有 auc 腿 ⇒ 照常入榜（历史日可能只有竞价腿）', async function() {
    rowsByDate['2026-10-19'] = [
      { date: '2026-10-19', stock: 'A', pct: 30, leg: 'auc' },
      { date: '2026-10-19', stock: 'B', pct: 20, leg: 'auc' }
    ];
    const r = await readTop5History(['2026-10-19']);
    expect(r.byDate.get('2026-10-19')).toEqual(['A', 'B']);
  });

  it('pct 算不出的行（null / 空串 / 非数字）⇒ 不进榜（§10 不拿 0 冒充）', async function() {
    rowsByDate['2026-10-19'] = [
      { date: '2026-10-19', stock: 'A', pct: 30, leg: 'close' },
      { date: '2026-10-19', stock: 'B', pct: null, leg: 'close' },
      { date: '2026-10-19', stock: 'C', pct: '', leg: 'close' },
      { date: '2026-10-19', stock: 'D', pct: 'n/a', leg: 'close' }
    ];
    const r = await readTop5History(['2026-10-19']);
    expect(r.byDate.get('2026-10-19')).toEqual(['A']);
  });
});

describe('range20-top5-history · 名次与只数', function() {
  it('按 pct 降序取前 5（用户口径「20日涨幅排名前五」）', async function() {
    dayPcts('2026-10-22', [
      ['新华传媒', 188.12], ['九阳股份', 133.69], ['冰山冷热', 87.18],
      ['慈文传媒', 80.1], ['新华文轩', 75.5], ['宁波东力', 62.9], ['第七只', 50]
    ]);
    const r = await readTop5History(['2026-10-22']);
    expect(r.byDate.get('2026-10-22')).toEqual(['新华传媒', '九阳股份', '冰山冷热', '慈文传媒', '新华文轩']);
    expect(TOP5_HISTORY_N).toBe(5);
  });

  it('pct 并列 ⇒ 名字升序（可复现，不随库里返回顺序抖动）', async function() {
    dayPcts('2026-10-22', [['B', 10], ['A', 10], ['C', 9]]);
    const r2 = await readTop5History(['2026-10-22']);
    expect(r2.byDate.get('2026-10-22')).toEqual(['A', 'B', 'C']);
    // 换一批顺序再读（缓存已清）⇒ 结果必须一样
    clearTop5HistoryCache();
    dayPcts('2026-10-22', [['A', 10], ['C', 9], ['B', 10]]);
    const r3 = await readTop5History(['2026-10-22']);
    expect(r3.byDate.get('2026-10-22')).toEqual(r2.byDate.get('2026-10-22'));
  });

  it('某天没有任何行 ⇒ 该天不入 byDate、不计入 days（覆盖度如实上报）', async function() {
    dayPcts('2026-10-20', [['A', 10]]);
    const r = await readTop5History(['2026-10-19', '2026-10-20']);
    expect(r.byDate.has('2026-10-19')).toBe(false);
    expect(r.days).toBe(1);
    expect(r.dates).toEqual(['2026-10-20']);
  });
});

describe('range20-top5-history · 分页（20 天 × ~80 只 > 1000 行上限）', function() {
  it('超过 1000 行时必须继续翻页，⛔ 不能截断后面的日期', async function() {
    // 12 天 × 100 只 = 1200 行 > PAGE(1000)
    const dates = [];
    for (let d = 1; d <= 12; d++) {
      const date = '2026-09-' + String(d).padStart(2, '0');
      dates.push(date);
      const rows = [];
      for (let i = 0; i < 100; i++) {
        rows.push({ date: date, stock: date + '#' + i, pct: 1000 - i, leg: 'close' });
      }
      rowsByDate[date] = rows;
    }
    const r = await readTop5History(dates);
    expect(r.days).toBe(12);                          // ← 12 天全部读到（不是前 10 天）
    expect(r.byDate.get('2026-09-12')).toBeDefined(); // ← 最后一天没被截掉
    expect(calls.length).toBeGreaterThan(1);          // ← 确实翻了页
    expect(calls[0].from).toBe(0);
    expect(calls[1].from).toBe(1000);
  });

  it('不足一页 ⇒ 只发一次请求就停（⛔ 不无限循环）', async function() {
    dayPcts('2026-10-20', [['A', 10], ['B', 9]]);
    await readTop5History(['2026-10-20']);
    expect(calls.length).toBe(1);
  });
});

describe('range20-top5-history · §10 读取失败绝不冒充「没有榜」', function() {
  it('查询报错 ⇒ throw（⛔ 不返回空 Map）', async function() {
    mode = 'fail';
    await expect(readTop5History(['2026-10-20'])).rejects.toThrow('读取失败');
  });

  it('失败后进入冷却 ⇒ 短时间内再读直接报错，不再白打 REST', async function() {
    mode = 'fail';
    await expect(readTop5History(['2026-10-20'])).rejects.toThrow();
    const before = calls.length;
    await expect(readTop5History(['2026-10-21'])).rejects.toThrow('冷却');
    expect(calls.length).toBe(before);                // ← 冷却期内零请求
  });

  it('清缓存后冷却一并解除（换账户 / 切数据源的逃生门）', async function() {
    mode = 'fail';
    await expect(readTop5History(['2026-10-20'])).rejects.toThrow();
    clearTop5HistoryCache();
    mode = 'ok';
    dayPcts('2026-10-20', [['A', 10]]);
    const r = await readTop5History(['2026-10-20']);
    expect(r.days).toBe(1);
  });
});

describe('range20-top5-history · 缓存与单飞', function() {
  it('同一批日期第二次读 ⇒ 命中会话缓存，零请求（§32）', async function() {
    dayPcts('2026-10-20', [['A', 10]]);
    await readTop5History(['2026-10-20']);
    const n = calls.length;
    await readTop5History(['2026-10-20']);
    expect(calls.length).toBe(n);
  });

  it('日期顺序不同但集合相同 ⇒ 命中同一份缓存', async function() {
    dayPcts('2026-10-19', [['A', 10]]);
    dayPcts('2026-10-20', [['B', 10]]);
    await readTop5History(['2026-10-19', '2026-10-20']);
    const n = calls.length;
    await readTop5History(['2026-10-20', '2026-10-19']);
    expect(calls.length).toBe(n);
  });

  it('并发同一批日期 ⇒ 只发一次请求（单飞）', async function() {
    dayPcts('2026-10-20', [['A', 10]]);
    const [a, b] = await Promise.all([
      readTop5History(['2026-10-20']),
      readTop5History(['2026-10-20'])
    ]);
    expect(calls.length).toBe(1);
    expect(a).toBe(b);
  });
});

describe('range20-top5-history · everInTop5Set（判定「首次上榜」的输入）', function() {
  it('把 byDate 展开成名字集合（跨天去重）', async function() {
    dayPcts('2026-10-19', [['新华传媒', 100], ['九阳股份', 90]]);
    dayPcts('2026-10-20', [['新华传媒', 110], ['冰山冷热', 80]]);
    const hist = await readTop5History(['2026-10-19', '2026-10-20']);
    const ever = everInTop5Set(hist);
    expect(ever.has('新华传媒')).toBe(true);
    expect(ever.has('九阳股份')).toBe(true);
    expect(ever.has('冰山冷热')).toBe(true);
    expect(ever.has('宁波东力')).toBe(false);          // ← 从没上过榜 = 新龙的候选
    expect(ever.size).toBe(3);
  });

  it('null / 空历史 ⇒ 空集合（⛔ 不抛错；调用方据此判「读不到」而不是「都没上过」）', function() {
    expect(everInTop5Set(null).size).toBe(0);
    expect(everInTop5Set({}).size).toBe(0);
    expect(everInTop5Set({ byDate: new Map() }).size).toBe(0);
  });
});
