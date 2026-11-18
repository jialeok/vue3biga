// range-leaders-pool-range.test.js — 「20天补 / 30天补」的候选【范围】必须等于标签含义
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户 2026-11-18 原话
//   「有30天补的标签是三十个交易日内的股票吧？不是像20日补的，范围只有20个交易日，这个你要区分？我想确认下」
// ══════════════════════════════════════════════════════════════════════════════════════
// 修复前的事实（用真实库数据量过，⛔ 不是推测）：
//   · 20天补 的候选池 = 近 `RANGE20_PROBE_DAYS`(45) 个交易日的名单并集 ≈ 357 只
//   · 30天补 的候选池 = 近 60 个交易日的名单并集 ≈ 479 只
//   ⇒ 两者都不是「20 / 30 个交易日」，而且 30 天那条比 20 天那条还宽 120 只。
//   探测期本来是【取腿的回溯深度】（假期/停牌票要多往前够几天才凑得满 N 根腿），
//   却被顺手当成业务范围用了 ⇒ 一只 40~50 个交易日没进过名单的票也能被打上「30天」标签。
//   实测并集：近 20 日 225 只 / 近 30 日 286 只 / 近 45 日 357 只 / 近 60 日 479 只。
//
// 修复口径（本文件锁死，⛔ 别改回用 probeDates 建池）：
//   · 20天补：候选池 = 近 `RANGE20_WINDOW_DAYS`(20) 个交易日的名单并集；
//   · 30天补：候选池 = 近 `RANGE30_WINDOW_DAYS`(30) 个交易日（= 涨幅窗口本身 `win.dates`）；
//   · 两者仍各自保留更深的 `probeDates`（45 / 60）—— 但**只用于取腿与粗筛**。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RANGE20_WINDOW_DAYS, RANGE20_PROBE_DAYS } from './range20.js';
import { RANGE30_WINDOW_DAYS } from './range30-math.js';
import { RANGE20_LEADER_TOP_N } from './range20-leaders.js';
import { RANGE30_LEADER_TOP_N } from './range30-leaders.js';

const ROOT = process.cwd();
const SRC20 = fs.readFileSync(path.join(ROOT, 'src/logic/auction/range20-leaders.js'), 'utf8');
const SRC30 = fs.readFileSync(path.join(ROOT, 'src/logic/auction/range30-leaders.js'), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');

describe('[POOL-RANGE] 两个标签的量纲：20 天 / 30 天，不是一个数', () => {
  it('窗口常量必须分别是 20 / 30（⛔ 不许被改成同一个值）', () => {
    expect(RANGE20_WINDOW_DAYS).toBe(20);
    expect(RANGE30_WINDOW_DAYS).toBe(30);
    expect(RANGE30_WINDOW_DAYS).not.toBe(RANGE20_WINDOW_DAYS);
  });

  it('探测期必须比窗口长（取腿要回溯），但**不能**当候选范围', () => {
    expect(RANGE20_PROBE_DAYS).toBeGreaterThan(RANGE20_WINDOW_DAYS);
    // 30 天那条的探测深度（60）也明显大于 30 ⇒ 差异是真实存在的，必须靠「建池用哪一份」区分
    expect(norm(SRC30)).toContain('const probeDates = getRange20WindowDates(d, 60);');
  });

  it('补位只数都是前五', () => {
    expect(RANGE20_LEADER_TOP_N).toBe(5);
    expect(RANGE30_LEADER_TOP_N).toBe(5);
  });
});

describe('[POOL-RANGE] 20天补：池 = 近 20 个交易日名单并集', () => {
  it('必须用 RANGE20_WINDOW_DAYS 切出 poolDates，再按它筛 rowsByDate', () => {
    expect(norm(SRC20)).toContain(
      'const poolDates = new Set(getRange20WindowDates(date, RANGE20_WINDOW_DAYS));'
    );
    expect(norm(SRC20)).toContain(
      'probeRowsByDate.forEach(function(v, k) { if (poolDates.has(k)) poolRowsByDate.set(k, v); });'
    );
    expect(norm(SRC20)).toContain('const pool = unionPoolFromDates(poolRowsByDate);');
  });

  it('★ 反证：⛔ 不许再出现「用 probeDates 直接建池」', () => {
    expect(norm(SRC20)).not.toContain('const pool = unionPoolFromDates(rowsByDate);');
  });

  it('探测期那一份必须保留给取腿（legs20FromRows 仍吃 45 天口径的 rowsByDate）', () => {
    expect(norm(SRC20)).toContain('const rowsByDate = probeRowsByDate;');
    expect(SRC20).toContain('legs20FromRows(pool, probeDates, rowsByDate');
  });
});

describe('[POOL-RANGE] 30天补：池 = 近 30 个交易日（与涨幅窗口同一份日历）', () => {
  it('必须取 win.dates 当候选范围（§6：候选范围与涨幅窗口不分叉）', () => {
    expect(norm(SRC30)).toContain('const poolDates = win.dates;');
    expect(norm(SRC30)).toContain('const rowsByDate = _formalRowsByDate(poolDates);');
    expect(norm(SRC30)).toContain('const pool = unionPoolFromDates(rowsByDate);');
  });

  it('★ 反证：⛔ 不许再出现「用 probeDates(60) 直接建池」', () => {
    expect(norm(SRC30)).not.toContain('const rowsByDate = _formalRowsByDate(probeDates);');
    expect(norm(SRC30)).not.toContain('unionPoolFromDates(rowsByDate2)');
  });

  it('probeDates(60) 必须仍用于取腿 / 粗筛', () => {
    expect(SRC30).toContain('legs20FromDaily(pool, probeDates, dailyMap)');
    expect(SRC30).toContain('compound20(dailyLegs, probeDates, { windowDays: RANGE30_WINDOW_DAYS })');
  });
});

describe('[POOL-RANGE] 两个模块的候选范围必须不同（20 ≠ 30）', () => {
  it('20 用 RANGE20_WINDOW_DAYS 建池、30 用 win.dates(30 天) 建池 —— 两个来源不许混用', () => {
    expect(SRC20).toContain('RANGE20_WINDOW_DAYS)');
    expect(SRC20).not.toContain('poolDates = win.dates');
    expect(SRC30).not.toContain('RANGE20_WINDOW_DAYS)');
  });
});
