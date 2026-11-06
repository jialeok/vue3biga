// daily-legs-heal.test.js — [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐口径回归锁
//
// 锁的是「把本机脚本搬到云端」这件事最重要的一条：
//   ⛔ 绝不把 9:25 的竞价涨幅当收盘腿写进 stock_daily_pct（会让 20 日复利整体算错）。
//   本机脚本用腾讯前复权日线比对 426 条验证过这条闸 99.7% 准确，迁移时一个字都不能放宽。
import { describe, it, expect } from 'vitest';
import { numPct, pickCloudDailyLegs, isAfterClose } from './daily-legs-heal.js';

const TODAY = '2026-11-06';
const NOW = '2026-11-06T08:10:00.000Z';

function m(stock, date, c, a) {
  return { stock: stock, date: date, change_pct: c, auc_pct_chg: a };
}

describe('numPct', () => {
  it("吃 '+2.44' / '-9.97%' / number；缺失与坏值返回 null（⛔ 不返回 0）", () => {
    expect(numPct('+2.44')).toBe(2.44);
    expect(numPct('-9.97%')).toBe(-9.97);
    expect(numPct(3.1)).toBe(3.1);
    expect(numPct('')).toBeNull();
    expect(numPct(null)).toBeNull();
    expect(numPct('garbage')).toBeNull();
  });
});

describe('pickCloudDailyLegs — 收盘覆盖闸', () => {
  it('change_pct != auc_pct_chg ⇒ 认作收盘腿，写 src=metrics_close', () => {
    const r = pickCloudDailyLegs(
      [m('A', '2026-11-05', '+3.20%', '+1.10%')], new Map(), TODAY, false, NOW
    );
    expect(r.rows).toEqual([{
      date: '2026-11-05', stock: 'A', pct: '+3.20', src: 'metrics_close', updated_at: NOW
    }]);
  });

  it('⛔ change_pct == auc_pct_chg（仍是竞价副本）⇒ 一律拒，绝不写', () => {
    const r = pickCloudDailyLegs(
      [m('A', '2026-11-05', '+1.10%', '+1.10%'), m('B', '2026-11-05', '+1.105%', '+1.10%')],
      new Map(), TODAY, false, NOW
    );
    expect(r.rows).toEqual([]);
    expect(r.rejected).toBe(2);
  });

  it('已有腿 / 缺 change_pct / 未来日期 ⇒ 一律不写（纯新增、宁缺勿错）', () => {
    const existing = new Map([['2026-11-05', new Set(['A'])]]);
    const r = pickCloudDailyLegs([
      m('A', '2026-11-05', '+3.20%', '+1.10%'),   // 已有
      m('B', '2026-11-05', '', '+1.10%'),          // 缺值
      m('C', '2026-11-05', null, '+1.10%'),        // 缺值
      m('D', '2026-11-07', '+3.20%', '+1.10%')     // 未来
    ], existing, TODAY, false, NOW);
    expect(r.rows).toEqual([]);
    expect(r.already).toBe(1);
  });

  it('今天那根腿：15:05 前跳过，收盘后才允许写', () => {
    const rows = [m('A', TODAY, '+3.20%', '+1.10%')];
    expect(pickCloudDailyLegs(rows, new Map(), TODAY, false, NOW).todaySkipped).toBe(1);
    expect(pickCloudDailyLegs(rows, new Map(), TODAY, false, NOW).rows).toEqual([]);
    expect(pickCloudDailyLegs(rows, new Map(), TODAY, true, NOW).rows).toHaveLength(1);
  });

  it('负数带符号、正数带 +，与本机脚本 / Edge 同格式', () => {
    const r = pickCloudDailyLegs([
      m('跌', '2026-11-05', '-2.5', '+1.0'),
      m('涨', '2026-11-05', '4', '1')
    ], new Map(), TODAY, false, NOW);
    expect(r.rows.map(x => x.pct)).toEqual(['-2.50', '+4.00']);
  });
});

describe('isAfterClose（北京 15:05）', () => {
  function bj(h, mi) { return new Date(Date.UTC(2026, 10, 6, h, mi, 0)); }
  it('09:26 / 15:04 不算，15:05 / 16:00 算', () => {
    expect(isAfterClose(bj(9, 26))).toBe(false);
    expect(isAfterClose(bj(15, 4))).toBe(false);
    expect(isAfterClose(bj(15, 5))).toBe(true);
    expect(isAfterClose(bj(16, 0))).toBe(true);
  });
});
