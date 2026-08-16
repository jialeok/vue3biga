import { describe, it, expect } from 'vitest';
import {
  _shiftDateStr,
  getPreviousDate,
  getNextDate,
  buildYesterdayListFromToday,
} from './date-helpers.js';

describe('date-helpers：_shiftDateStr 偏移天数', () => {
  it('正常 +1 天', () => {
    expect(_shiftDateStr('2024-01-01', 1)).toBe('2024-01-02');
  });

  it('跨月：1 月末 +1 -> 2 月（闰年 2024-02-29）', () => {
    expect(_shiftDateStr('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('跨年：2024-12-31 +1 -> 2025-01-01', () => {
    expect(_shiftDateStr('2024-12-31', 1)).toBe('2025-01-01');
  });

  it('正常 -1 天回到闰年 2 月末', () => {
    expect(_shiftDateStr('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('偏移 0 天返回原值', () => {
    expect(_shiftDateStr('2024-06-15', 0)).toBe('2024-06-15');
  });
});

describe('date-helpers：getPreviousDate / getNextDate 日历相邻日', () => {
  it('getPreviousDate 普通日', () => {
    expect(getPreviousDate('2024-01-02')).toBe('2024-01-01');
  });

  it('getPreviousDate 跨周末（周一 -> 周日，纯日历不判交易）', () => {
    expect(getPreviousDate('2024-01-08')).toBe('2024-01-07');
  });

  it('getNextDate 闰年 2 月末', () => {
    expect(getNextDate('2024-02-28')).toBe('2024-02-29');
  });

  it('getNextDate 跨年', () => {
    expect(getNextDate('2024-12-31')).toBe('2025-01-01');
  });
});

describe('date-helpers：buildYesterdayListFromToday 边界与已知值', () => {
  it('空集输入返回空数组', () => {
    expect(buildYesterdayListFromToday([], {}, '2024-01-01')).toEqual([]);
  });

  it('无昨日数据时字段回填默认空值', () => {
    const out = buildYesterdayListFromToday(
      [{ stock: '贵州茅台', code: '600519' }],
      {},
      '2024-01-01'
    );
    expect(out).toEqual([
      {
        stock: '贵州茅台',
        code: '600519',
        volume: '',
        yestVolume: '',
        note: '',
        changePct: '',
        topics: '',
        selected: false,
        bought: false,
        sold: false,
        fixed: false,
      },
    ]);
  });

  it('昨日已有同名股票时继承其业务字段（按 trim 匹配）', () => {
    const today = [{ stock: 'A' }];
    const auctionData = {
      '2024-01-01': [
        { stock: ' A ', code: '600000', volume: '100', bought: true, yestVolume: '90' },
      ],
    };
    const out = buildYesterdayListFromToday(today, auctionData, '2024-01-01');
    expect(out[0].code).toBe('600000');
    expect(out[0].volume).toBe('100');
    expect(out[0].yestVolume).toBe('90');
    expect(out[0].bought).toBe(true);
  });
});
