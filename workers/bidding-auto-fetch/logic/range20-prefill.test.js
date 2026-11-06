// range20-prefill.test.js — [R20-CLOUD 2026-11-06] 9:26 云端 20 日涨幅补缺的口径回归锁
//
// 锁住三件事：
//   ① 复利口径与 Edge `rangeFromLegs` 逐字等价（19 根历史腿 + 1 根 T 腿，days=20）；
//   ② 腿不够 19 根 / T 腿不是数值 ⇒ 一律不写（§10 宁缺勿错，⛔ 不折 0）；
//   ③ 竞价/收盘 leg 的 15:00 边界与 Edge、前端 resolveT20LegMode 同源。
import { describe, it, expect } from 'vitest';
import {
  RANGE20_LEG_DAYS,
  compoundRange20,
  legModeOf,
  groupLegs
} from './range20-prefill.js';

function n(v, k) { return new Array(k).fill(v); }

function bj(h, m) { return new Date(Date.UTC(2026, 10, 6, h, m, 0)); }

describe('compoundRange20（与 Edge rangeFromLegs 同源）', () => {
  it('19 根历史腿 + 1 根 T 腿 = 20 日；复利累乘而不是求和', () => {
    const r = compoundRange20(n(1, 19), 1);
    // 1.01^20 - 1 = 22.019003...%
    expect(r.pct).toBe('22.02');
    expect(r.days).toBe(20);
  });

  it('腿超过 19 根 ⇒ 只取最近 19 根（窗口滑动，⛔ 不把更早的算进去）', () => {
    const hist = n(0, 3).concat(n(1, 19));   // 前 3 根是 0，最近 19 根是 +1
    const r = compoundRange20(hist, 0);
    expect(r.days).toBe(20);
    expect(r.pct).toBe('20.81');            // 1.01^19 - 1
  });

  it('腿不足 19 根 ⇒ null（绝不拿半截复利当 20 日涨幅）', () => {
    expect(compoundRange20(n(1, RANGE20_LEG_DAYS - 1), 1)).toBeNull();
    expect(compoundRange20([], 1)).toBeNull();
    expect(compoundRange20(null, 1)).toBeNull();
  });

  it('T 腿非数值 ⇒ null（缺竞价涨幅时不许用 0 顶替）', () => {
    expect(compoundRange20(n(1, 19), NaN)).toBeNull();
    expect(compoundRange20(n(1, 19), undefined)).toBeNull();
    expect(compoundRange20(n(1, 19), 'x')).toBeNull();
  });

  it('负腿也要正确复利（跌 10% × 2 天 ≠ -20%）', () => {
    const hist = n(0, 18).concat([-10]);
    expect(compoundRange20(hist, -10).pct).toBe('-19.00');
  });
});

describe('legModeOf（竞价 / 收盘口径）', () => {
  it('15:00 前 auc、15:00 起 close（与 Edge 选腿、前端 resolveT20LegMode 同源）', () => {
    expect(legModeOf(bj(9, 26))).toBe('auc');
    expect(legModeOf(bj(14, 59))).toBe('auc');
    expect(legModeOf(bj(15, 0))).toBe('close');
    expect(legModeOf(bj(16, 30))).toBe('close');
  });
});

describe('groupLegs（腿表扁平行 → 升序数值腿）', () => {
  it('按日期升序、剥 %/±、跳过坏值（⛔ 不把坏值折成 0）', () => {
    const m = groupLegs([
      { stock: 'A', date: '2026-11-05', pct: '+2.00%' },
      { stock: 'A', date: '2026-11-04', pct: '-1.50' },
      { stock: 'A', date: '2026-11-06', pct: '' },
      { stock: 'A', date: '2026-11-03', pct: 'garbage' },
      { stock: 'B', date: '2026-11-05', pct: '3.10' }
    ]);
    expect(m.get('A')).toEqual([-1.5, 2]);
    expect(m.get('B')).toEqual([3.1]);
    expect(m.has('C')).toBe(false);
  });

  it('空输入返回空 Map，不抛错', () => {
    expect(groupLegs([]).size).toBe(0);
    expect(groupLegs(null).size).toBe(0);
  });
});
