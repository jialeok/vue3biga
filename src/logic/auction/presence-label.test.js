// presence-label.test.js — 涨幅前十「在列次数」标签（§15 纯函数单测）
//
// 用户口径（2026-10-23 逐字）：
//   「10日涨幅 toggle 单独打开后，把排名前十的股票，在这 10 个交易日中出现过几次标记起来……
//     打上小标签比如"5次在列"，"首次在列"，单独打开 20 日涨幅 toggle 时也要。」
//   AskUserQuestion 三答：「只给前十名标」/「Supabase 定时算好落表」/「含今天」。
//
// 本文件锁住六件事：
//   ① 只标前十（第 11 只起一律不标）；
//   ② 次数 → 文案：0「未在列」/ 1「首次在列」/ n「n次在列」，非法值 ⇒ 空串；
//   ③ 10 日窗口读 rangePct、20 日窗口读 rangePct20（⛔ 不互相顶替）；
//   ④ §10：次数数据没到 ⇒ 全表不标（⛔ 绝不把「不知道」显示成「未在列」）；
//   ⑤ §10：没有区间涨幅的行跳过且【不占名次】；
//   ⑥ 未命中 counts 的票 = 真实 0 次（补位票整个窗口没进过名单）—— 不是缺数据。

import { describe, it, expect } from 'vitest';
import {
  PRESENCE_TOP_N,
  PRESENCE_WINDOW_10,
  PRESENCE_WINDOW_20,
  presenceLabelOf,
  presenceSortValueOf,
  assignPresenceLabels
} from './presence-label.js';

/** 造行：10 日模式看 rangePct，20 日模式看 rangePct20 */
function row(stock, rangePct, rangePct20) {
  return { stock, rangePct, rangePct20 };
}

/** counts 构造器：{ 股票名: 次数 } */
function countsOf(obj) {
  const m = new Map();
  Object.keys(obj).forEach(function(k) { m.set(k, { cnt: obj[k], dates: '' }); });
  return m;
}

describe('presence-label · 常量与文案', () => {
  it('打标只数 = 10，窗口常量 = 10 / 20', () => {
    expect(PRESENCE_TOP_N).toBe(10);
    expect(PRESENCE_WINDOW_10).toBe(10);
    expect(PRESENCE_WINDOW_20).toBe(20);
  });

  it('次数 → 文案：0 未在列 / 1 首次在列 / n n次在列', () => {
    expect(presenceLabelOf(0)).toBe('未在列');
    expect(presenceLabelOf(1)).toBe('首次在列');
    expect(presenceLabelOf(2)).toBe('2次在列');
    expect(presenceLabelOf(5)).toBe('5次在列');
    expect(presenceLabelOf(10)).toBe('10次在列');
    expect(presenceLabelOf('7')).toBe('7次在列');
  });

  it('非法值 ⇒ 空串（⛔ 不把「没数据」写成「0次」）', () => {
    expect(presenceLabelOf(null)).toBe('');
    expect(presenceLabelOf(undefined)).toBe('');
    expect(presenceLabelOf('')).toBe('');
    expect(presenceLabelOf('abc')).toBe('');
    expect(presenceLabelOf(-1)).toBe('');
  });

  it('排序键：10 日读 rangePct、20 日读 rangePct20；缺值 ⇒ null（⛔ 不补 0）', () => {
    const r = row('甲', 12.5, null);
    expect(presenceSortValueOf(r, 10)).toBe(12.5);
    expect(presenceSortValueOf(r, 20)).toBeNull();
    const r2 = row('乙', null, 88.8);
    expect(presenceSortValueOf(r2, 20)).toBe(88.8);
    expect(presenceSortValueOf(r2, 10)).toBeNull();
    expect(presenceSortValueOf(null, 10)).toBeNull();
    // 字符串数值兼容（云端 range_pct 是 text，形如 '+3.10'；Number('+3.10') = 3.1）
    expect(presenceSortValueOf({ rangePct: '+3.10' }, 10)).toBe(3.1);
    expect(presenceSortValueOf({ rangePct: '' }, 10)).toBeNull();
  });
});

describe('assignPresenceLabels · 只标前十', () => {
  it('前十依次挂标，第 11 只起清零', () => {
    const items = [];
    for (let i = 1; i <= 12; i++) items.push(row('S' + i, 100 - i, 100 - i));
    const counts = countsOf({ S1: 5, S2: 1, S3: 0, S10: 10 });
    const n = assignPresenceLabels(items, PRESENCE_TOP_N, {
      windowDays: 10, counts: counts, coveredDays: 10
    });
    expect(n).toBe(10);
    expect(items[0].presenceLabel).toBe('5次在列');
    expect(items[1].presenceLabel).toBe('首次在列');
    expect(items[2].presenceLabel).toBe('未在列');
    expect(items[9].presenceLabel).toBe('10次在列');
    // 第 11、12 只必须被显式清零（增量缓存复用不得残留标签，§11）
    expect(items[10].presenceLabel).toBe('');
    expect(items[10].presenceCnt).toBeNull();
    expect(items[11].presenceLabel).toBe('');
  });

  it('未命中的票 = 真实 0 次（补位票整个窗口没进过名单），不是缺数据', () => {
    const items = [row('补位票', 200, 200)];
    assignPresenceLabels(items, 10, { windowDays: 10, counts: countsOf({}), coveredDays: 10 });
    expect(items[0].presenceCnt).toBe(0);
    expect(items[0].presenceLabel).toBe('未在列');
  });

  it('§10：次数数据没到（counts=null）⇒ 全表不标', () => {
    const items = [row('甲', 50, 50), row('乙', 40, 40)];
    const n = assignPresenceLabels(items, 10, { windowDays: 10, counts: null, coveredDays: 0 });
    expect(n).toBe(0);
    items.forEach(function(it) {
      expect(it.presenceCnt).toBeNull();
      expect(it.presenceLabel).toBe('');
    });
  });

  it('§10：窗口内一天名单数据都没有（coveredDays=0）⇒ 全表不标', () => {
    const items = [row('甲', 50, 50)];
    const n = assignPresenceLabels(items, 10, {
      windowDays: 10, counts: countsOf({ 甲: 3 }), coveredDays: 0
    });
    expect(n).toBe(0);
    expect(items[0].presenceLabel).toBe('');
  });

  it('§10：没有区间涨幅的行不占名次（缺数据的行不会被标成「未在列」）', () => {
    const items = [row('甲', null, null), row('乙', 40, 40), row('丙', 30, 30)];
    const n = assignPresenceLabels(items, 10, {
      windowDays: 10, counts: countsOf({ 乙: 2, 丙: 1 }), coveredDays: 10
    });
    expect(n).toBe(2);
    expect(items[0].presenceLabel).toBe('');   // 无涨幅 ⇒ 不打标
    expect(items[1].presenceLabel).toBe('2次在列');
    expect(items[2].presenceLabel).toBe('首次在列');
  });

  it('20 日窗口用 rangePct20 取名次，10 日字段不干扰', () => {
    const items = [row('甲', 999, 10), row('乙', 1, 80)];
    const n = assignPresenceLabels(items, 10, {
      windowDays: 20, counts: countsOf({ 甲: 4, 乙: 4 }), coveredDays: 20
    });
    expect(n).toBe(2);
    // items 顺序由调用方（已按 rangePct20 降序）保证；本函数只按顺序取前 N
    expect(items[0].presenceWindowDays).toBe(20);
    expect(items[0].presenceCoveredDays).toBe(20);
  });

  it('每行都写窗口/覆盖天数（悬停文案要如实报 n/N，§10）', () => {
    const items = [row('甲', 10, 10), null];
    assignPresenceLabels(items, 10, {
      windowDays: 20, counts: countsOf({ 甲: 1 }), coveredDays: 17
    });
    expect(items[0].presenceWindowDays).toBe(20);
    expect(items[0].presenceCoveredDays).toBe(17);
  });

  it('空输入 / topN 非法 ⇒ 安全（不抛错，回落到默认 10）', () => {
    expect(assignPresenceLabels([], 10, { windowDays: 10, counts: countsOf({}), coveredDays: 10 })).toBe(0);
    expect(assignPresenceLabels(null, 10, { windowDays: 10, counts: countsOf({}), coveredDays: 10 })).toBe(0);
    const items = [];
    for (let i = 1; i <= 12; i++) items.push(row('S' + i, 100 - i, 100 - i));
    const n = assignPresenceLabels(items, 'abc', { windowDays: 10, counts: countsOf({}), coveredDays: 10 });
    expect(n).toBe(10);
  });
});
