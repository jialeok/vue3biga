// leader-diverge.test.js — 第二十五条【总龙首次分歧 / 二次分歧】（2026-11-12 用户口径）
//
// 夹具全部是【真库数字】（`market_metrics(scope=auction)` × `stock_daily_pct`）：
//   东方海洋 2026-11-03 ~ 11-12：竞价涨幅 / 收盘涨幅 / 竞价占比
//   11-03 +9.97 / +9.97 / 6.82      ← 首板
//   11-04 +4.68 / **−4.09** / 14.93  ← 高开低走收绿（D2）⇒ 用户：「11月04日首次分歧」
//   11-05  0.00 / +10.06 / **2.93**  ← 占比塌（D3），与 11-04 连续 ⇒ 与它合并成【一次】
//   11-06 +1.66 / +9.97 / 4.79
//   11-09 +5.04 / +10.08 / 5.45
//   11-10 +0.69 / +5.72 / **2.93**   ← 占比塌（D3）⇒ 用户：「11月10日又分歧一次 = 二次分歧」
//   11-11 −0.87 / +1.52 / **2.00**   ← 竞价低开（D1）+ 占比塌，与 11-10 连续 ⇒ 合并
//   11-12 +10.02 / +10.02 / 10.01    ← 一字回封，不是分歧
import { describe, it, expect } from 'vitest';
import {
  isDivergeShape, buildDivergePhases, classifyLeaderDiverge, divergeTitleOf, divergeNoteOf,
  buildDivergeDayRow,
  DIVERGE_SHAPE_LOW_OPEN, DIVERGE_SHAPE_OPEN_HIGH_CLOSE_RED, DIVERGE_SHAPE_SHARE
} from './leader-diverge.js';
import { DIVERGE_TOTAL_DAYS_MIN, DIVERGE_SECOND_MIN_BOARDS, DIVERGE_WINDOW_DAYS } from './tvrb-constants.js';

/** 一行逐日行情 */
function R(date, aucPct, closePct, share, limitUp) {
  return { date: date, aucPct: aucPct, closePct: closePct, share: share, limitUp: !!limitUp };
}

/** 东方海洋 11-03 ~ 11-12 真值 */
const DFHY = [
  R('2026-11-03', 9.97, 9.97, 6.82, true),
  R('2026-11-04', 4.68, -4.09, 14.93, false),
  R('2026-11-05', 0.00, 10.06, 2.93, true),
  R('2026-11-06', 1.66, 9.97, 4.79, true),
  R('2026-11-09', 5.04, 10.08, 5.45, true),
  R('2026-11-10', 0.69, 5.72, 2.93, false),
  R('2026-11-11', -0.87, 1.52, 2.00, false),
  R('2026-11-12', 10.02, 10.02, 10.01, true)
];

describe('isDivergeShape —— 三种分歧形态', function() {
  it('D1 竞价低开（竞价口径）：11-11 −0.87%', function() {
    expect(isDivergeShape({ aucPct: -0.87, closePct: 1.52, share: 10 })).toBe(DIVERGE_SHAPE_LOW_OPEN);
  });
  it('D2 高开低走收绿（★本轮新增，收盘口径）：11-04 竞价 +4.68 但收 −4.09', function() {
    expect(isDivergeShape({ aucPct: 4.68, closePct: -4.09, share: 14.93 })).toBe(DIVERGE_SHAPE_OPEN_HIGH_CLOSE_RED);
  });
  it('⛔ 高开高走不算分歧（竞价 +1.66 / 收 +9.97 / 占比 4.79 达标）', function() {
    expect(isDivergeShape({ aucPct: 1.66, closePct: 9.97, share: 4.79 })).toBe('');
  });
  it('D3 占比塌陷：11-10 竞价 +0.69（不是低开）但占比 2.93% < 3.5%', function() {
    expect(isDivergeShape({ aucPct: 0.69, closePct: 5.72, share: 2.93 })).toBe(DIVERGE_SHAPE_SHARE);
  });
  it('§10 缺数据不硬判（aucPct=null 且 share=null ⇒ 不是分歧，⛔ 不猜）', function() {
    expect(isDivergeShape({ aucPct: null, closePct: null, share: null })).toBe('');
  });
  it('占比刚好 3.5% ⇒ 达标（不是分歧）；2.9% ⇒ 塌', function() {
    expect(isDivergeShape({ aucPct: 1, closePct: 1, share: 3.5 })).toBe('');
    expect(isDivergeShape({ aucPct: 1, closePct: 1, share: 2.9 })).toBe(DIVERGE_SHAPE_SHARE);
  });
});

describe('buildDivergePhases —— 连续满足日合并成【一次】事件', function() {
  it('东方海洋：11-04 起 ⇒ 【首次 11-04~11-05】+【二次 11-10~11-11】两次', function() {
    const ph = buildDivergePhases(DFHY, '2026-11-03');
    expect(ph.length).toBe(2);
    expect(ph[0].date).toBe('2026-11-04');
    expect(ph[0].endDate).toBe('2026-11-05');   // 与 11-05 连续 ⇒ 同一次
    expect(ph[0].days).toBe(2);
    expect(ph[1].date).toBe('2026-11-10');
    expect(ph[1].endDate).toBe('2026-11-11');
    expect(ph[1].days).toBe(2);
  });
  it('首板之前的分歧不算（fromDate = 11-03）', function() {
    const rows = [R('2026-10-30', -2, 1, 20, false)].concat(DFHY);
    const ph = buildDivergePhases(rows, '2026-11-03');
    expect(ph[0].date).toBe('2026-11-04');      // ⛔ 不是 10-30
  });
  it('不传 fromDate ⇒ 全文都算', function() {
    const rows = [R('2026-10-30', -2, 1, 20, false)].concat(DFHY);
    expect(buildDivergePhases(rows, '')[0].date).toBe('2026-10-30');
  });
});

describe('classifyLeaderDiverge —— 11-12 用户叙述的完整复现', function() {
  it('★ 满窗口 + 霸榜 3 天 ⇒ kind=second（首次分歧 11-04 / 二次分歧 11-10）', function() {
    const r = classifyLeaderDiverge(DFHY, { dragonDays: 3 });
    expect(r.qualified).toBe(true);
    expect(r.kind).toBe('second');
    expect(r.reason).toBe('second-diverge');
    expect(r.firstDate).toBe('2026-11-04');
    expect(r.secondDate).toBe('2026-11-10');
    expect(r.startDate).toBe('2026-11-03');      // 首板那天
    expect(r.eventCount).toBe(2);
    // 用户：「二次分歧 5 个交易日内至少有两个连板」—— 首次分歧之后 5 日内有 11-06 / 11-09 / 11-12 三个涨停
    expect(r.boardsAfterFirst).toBe(3);
    expect(r.boardsAfterFirst >= DIVERGE_SECOND_MIN_BOARDS).toBe(true);
  });

  it('只到 11-09（还没出现二次分歧）⇒ kind=first', function() {
    const r = classifyLeaderDiverge(DFHY.slice(0, 5), { dragonDays: 3 });
    expect(r.kind).toBe('first');
    expect(r.firstDate).toBe('2026-11-04');
    expect(r.secondDate).toBe('');
  });

  it('★ 霸榜不够 3 天 ⇒ 不认（用户「要霸榜总龙一至少三天」）', function() {
    expect(DIVERGE_TOTAL_DAYS_MIN).toBe(3);
    const r = classifyLeaderDiverge(DFHY, { dragonDays: 2 });
    expect(r.qualified).toBe(false);
    expect(r.kind).toBe('none');
    expect(r.reason).toBe('not-total-dragon');
  });

  it('§10 霸榜天数读不到 ⇒ kind=unknown（⛔ 不返 none 冒充「没有分歧」）', function() {
    const r = classifyLeaderDiverge(DFHY, { dragonDays: null });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toBe('dragon-days-unknown');
    expect(r.dragonDays).toBe(null);
  });

  it('★ 首次分歧之后 5 日内只 1 个涨停 ⇒ 只认首次分歧（「这叫趋势」）', function() {
    // 把 11-06 / 11-12 的涨停去掉，只剩 11-09 一个
    const rows = DFHY.map(function(r) {
      if (r.date === '2026-11-06' || r.date === '2026-11-12') return Object.assign({}, r, { limitUp: false });
      return r;
    });
    const r = classifyLeaderDiverge(rows, { dragonDays: 3 });
    expect(r.boardsAfterFirst).toBe(1);
    expect(r.kind).toBe('first');
    expect(r.reason).toBe('second-no-streak');
  });

  it('窗口内没有涨停 ⇒ kind=none / no-limit-up（判出「没有」，不是判不出）', function() {
    const rows = DFHY.map(function(x) { return Object.assign({}, x, { limitUp: false }); });
    const r = classifyLeaderDiverge(rows, { dragonDays: 3 });
    expect(r.kind).toBe('none');
    expect(r.reason).toBe('no-limit-up');
    expect(r.startDate).toBe('');
  });

  it('§10 行数不足 ⇒ kind=unknown / rows-missing', function() {
    expect(classifyLeaderDiverge([R('2026-11-12', 1, 1, 5, false)], { dragonDays: 3 }).reason).toBe('rows-missing');
    expect(classifyLeaderDiverge(null, { dragonDays: 3 }).reason).toBe('rows-missing');
  });

  it('输入乱序也能算对（内部按日期升序 + 只取最后 N 个交易日，确定性 §6）', function() {
    const shuffled = DFHY.slice().reverse();
    const r = classifyLeaderDiverge(shuffled, { dragonDays: 3 });
    expect(r.kind).toBe('second');
    expect(r.firstDate).toBe('2026-11-04');
    expect(r.secondDate).toBe('2026-11-10');
  });

  it('窗口常量 = 20（用户「注意范围是 20 个交易日」）', function() {
    expect(DIVERGE_WINDOW_DAYS).toBe(20);
  });
});

describe('divergeTitleOf / divergeNoteOf —— 提示语（用户「提示应该是二次分歧等同该题材退潮」）', function() {
  it('二次分歧 ⇒ 「羊字辈二次分歧 · 等同退潮」', function() {
    const r = classifyLeaderDiverge(DFHY, { dragonDays: 3 });
    expect(divergeTitleOf(r, '羊字辈')).toBe('羊字辈二次分歧 · 等同退潮');
  });
  it('首次分歧 / 没有分歧 ⇒ 空串（⛔ 不乱挂标题）', function() {
    expect(divergeTitleOf(classifyLeaderDiverge(DFHY.slice(0, 5), { dragonDays: 3 }), '羊字辈')).toBe('');
    expect(divergeTitleOf({ kind: 'none' }, '羊字辈')).toBe('');
    expect(divergeTitleOf(null, '羊字辈')).toBe('');
  });
  it('依据文案写明 首次/二次 日期与连板数（判定可追溯 §10）', function() {
    const r = classifyLeaderDiverge(DFHY, { dragonDays: 3 });
    const t = divergeNoteOf(r, '羊字辈');
    expect(t).toContain('首次分歧 2026-11-04');
    expect(t).toContain('二次分歧 2026-11-10');
    expect(t).toContain('霸榜总龙一 3 天');
    expect(t).toContain('3 个涨停');
    expect(t).toContain('羊字辈');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [NUM-TEXT 2026-11-13] 线上实证的回归锁：库里 `auc_pct_chg` 是 '+2.30%' 这种**字符串**。
//   上面所有夹具都是数字 ⇒ 旧实现 `Number('+4.68%') = NaN ⇒ null` 时测试根本不红。
//   于是线上出现：写入 tvrb_leader_diverge 的逐日留痕 aucPct 全 null，
//   D1（竞价低开）/ D2（高开低走收绿）两类判据永不触发，只剩 D3 占比塌陷在工作。
//   ⇒ 这里用【真实形态】再测一遍，谁把 numOfText 换回 Number() 就立刻红。
// ════════════════════════════════════════════════════════════════════════════
describe('[NUM-TEXT] DB 真实形态（带 % 的字符串）必须判得出 D1 / D2', function() {
  it('★ 11-04 竞价 "+4.68%" 收 "-4.09%" ⇒ D2 高开低走收绿', function() {
    const row = buildDivergeDayRow({
      date: '2026-11-04', aucPct: '+4.68%', dailyPct: '-4.09', volume: 1493, yestVolume: 100, limitUpPct: 10
    });
    expect(row.aucPct).toBe(4.68);
    expect(row.closePct).toBe(-4.09);
    expect(isDivergeShape(row)).toBe(DIVERGE_SHAPE_OPEN_HIGH_CLOSE_RED);
  });

  it('★ 11-11 竞价 "-0.87%" ⇒ D1 竞价低开', function() {
    const row = buildDivergeDayRow({
      date: '2026-11-11', aucPct: '-0.87%', dailyPct: '+1.52%', volume: '200', yestVolume: '100', limitUpPct: 10
    });
    expect(row.aucPct).toBe(-0.87);
    expect(isDivergeShape(row)).toBe(DIVERGE_SHAPE_LOW_OPEN);
  });

  it('成交量的文本千分位也要能算占比（1,234 / 100 ⇒ 1234%）', function() {
    const row = buildDivergeDayRow({ date: 'd', aucPct: '+1.00%', dailyPct: '1', volume: '1,234', yestVolume: '100' });
    expect(row.share).toBe(1234);
  });

  it('§10 解析不出来 ⇒ null（不硬判、不折 0）', function() {
    const row = buildDivergeDayRow({ date: 'd', aucPct: '—', dailyPct: '', volume: null, yestVolume: null });
    expect(row.aucPct).toBeNull();
    expect(row.closePct).toBeNull();
    expect(row.share).toBeNull();
    expect(isDivergeShape(row)).toBe('');
  });

  it('涨停判定同样吃文本收盘涨幅（"+10.05%" ≥ 10 − 容差）', function() {
    const row = buildDivergeDayRow({ date: 'd', aucPct: '0', dailyPct: '+10.05%', limitUpPct: 10 });
    expect(row.limitUp).toBe(true);
  });
});
