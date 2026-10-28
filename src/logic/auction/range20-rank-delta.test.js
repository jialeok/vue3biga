// range20-rank-delta.test.js —— 「20日涨幅」模式占比列 → 名次变化（对比昨日）的口径回归
//
// 用户口径（2026-10-28）：「排名上升就用红色+数字，比如+6，排名下降就用绿色，比如-7，
//   也就是按照20日涨幅的排序，对比昨日排名情况进行标注」。
// 这组用例钉死四件事：
//   ① 变化 = 昨日名次 − 今日名次（正 = 上升）；
//   ② 两天都在【同一可比集合内】重排（⛔ 不拿今天的名次减昨天全表的名次 —— 名单长度不同会造假信号）；
//   ③ 判不出（今天没值 / 昨天不在榜）⇒ 不在结果表里，由调用方显示 '—'（⛔ 不用 0 冒充「没变化」）；
//   ④ 空输入 / 只有一只可比票 ⇒ 空表（⛔ 别显示一排「0」）。
import { describe, it, expect } from 'vitest';
import { buildRange20RankDelta, RANGE20_DELTA_UNKNOWN_TEXT } from './range20-rank-delta.js';

/** 造一个「今日屏幕 Map」（stock -> {pct, days}） */
function today(entries) {
  const m = new Map();
  entries.forEach(function(e) { m.set(e[0], { pct: e[1], days: 20 }); });
  return m;
}

/** 造一个「昨日名次表」（Data 层返回的形状：ranks + pcts） */
function prev(entries) {
  const ranks = new Map();
  const pcts = new Map();
  const sorted = entries.slice().sort(function(a, b) { return b[1] - a[1]; });
  sorted.forEach(function(e, i) { ranks.set(e[0], i + 1); pcts.set(e[0], e[1]); });
  return { ranks: ranks, pcts: pcts, count: entries.length };
}

describe('buildRange20RankDelta · 20日涨幅名次变化', () => {
  it('★ 核心：昨天第 7、今天第 1 ⇒ 显示 +6（上升，红）', () => {
    // 七只票：今天 A 最强，昨天 A 排最后
    const t = today([['A', 90], ['B', 80], ['C', 70], ['D', 60], ['E', 50], ['F', 40], ['G', 30]]);
    const p = prev([['G', 90], ['F', 80], ['E', 70], ['D', 60], ['C', 50], ['B', 40], ['A', 30]]);
    const d = buildRange20RankDelta(t, p);
    expect(d.get('A').delta).toBe(6);      // 昨 7 → 今 1 ⇒ +6
    expect(d.get('A').text).toBe('+6');
    expect(d.get('A').tone).toBe('up');
    expect(d.get('G').delta).toBe(-6);     // 昨 1 → 今 7 ⇒ -6
    expect(d.get('G').text).toBe('-6');
    expect(d.get('G').tone).toBe('down');
    expect(d.get('D').delta).toBe(0);      // 两天都第 4
    expect(d.get('D').text).toBe('0');
    expect(d.get('D').tone).toBe('flat');
  });

  it('★ 口径：两天在【同一可比集合】内重排，不受「今天多了一只、昨天少了一只」干扰', () => {
    // 今天 4 只，昨天只有 B/C/D（A 是新面孔）。可比集合 = {B,C,D}
    const t = today([['A', 99], ['B', 80], ['C', 70], ['D', 60]]);
    const p = prev([['B', 80], ['D', 70], ['C', 60]]);
    const d = buildRange20RankDelta(t, p);
    // 若拿「今天全表名次」减「昨天全表名次」：B 昨天第1、今天第2 ⇒ -1（假信号）
    // 同一集合内：B 两天都第 1 ⇒ 0
    expect(d.has('A')).toBe(false);        // 昨天不在榜 ⇒ 判不出
    expect(d.get('B').delta).toBe(0);
    // C：昨天第 3 → 今天第 2 ⇒ +1；D：昨天第 2 → 今天第 3 ⇒ -1
    expect(d.get('C').delta).toBe(1);
    expect(d.get('D').delta).toBe(-1);
  });

  it('§10：昨天不在榜 / 今天没值的票 ⇒ 不进结果表（调用方显示 —）', () => {
    const t = today([['A', 90], ['B', null], ['C', 70], ['X', 50]]);
    const p = prev([['A', 90], ['C', 70], ['B', 60]]);
    const d = buildRange20RankDelta(t, p);
    expect(d.has('B')).toBe(false);        // 今天没值
    expect(d.has('X')).toBe(false);        // 昨天不在榜
    expect(d.has('A')).toBe(true);
    expect(RANGE20_DELTA_UNKNOWN_TEXT).toBe('—');
  });

  it('空输入 / 数据未到 ⇒ 空表（⛔ 不返回一排 0）', () => {
    expect(buildRange20RankDelta(null, prev([['A', 1]]))).toBeInstanceOf(Map);
    expect(buildRange20RankDelta(null, prev([['A', 1]])).size).toBe(0);
    expect(buildRange20RankDelta(today([['A', 1]]), null).size).toBe(0);
    expect(buildRange20RankDelta(today([['A', 1]]), { ranks: new Map(), pcts: new Map(), count: 0 }).size).toBe(0);
  });

  it('可比集合只有 1 只 ⇒ 空表（位移恒为 0，没有信息量）', () => {
    const t = today([['A', 50], ['B', null]]);
    const p = prev([['A', 10]]);
    expect(buildRange20RankDelta(t, p).size).toBe(0);
  });

  it('同值股票用股票名定序，结果稳定可复现', () => {
    const t = today([['乙', 50], ['甲', 50], ['丙', 10]]);
    const p = prev([['乙', 50], ['甲', 50], ['丙', 10]]);
    const d1 = buildRange20RankDelta(t, p);
    const d2 = buildRange20RankDelta(t, p);
    expect(d1.get('甲').delta).toBe(0);
    expect(d1.get('乙').delta).toBe(0);
    expect(d1.get('丙').delta).toBe(0);
    expect(Array.from(d1.keys())).toEqual(Array.from(d2.keys()));
  });
});
