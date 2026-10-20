// range20-top5-label.test.js — 「20日涨幅」toggle 专属显示层：前五打「总龙一…总龙五」（§15 纯函数单测）
//
// 用户口径（2026-10-20 逐字）：
//   「单独打开 20 日涨幅 toggle，我希望看到排名前五的标上总龙一，总龙二，总龙三，总龙四，
//     总龙五的标签，其它票不标。就是按 20 日涨幅由高到低标这五只。」
//
// 本文件锁住四件事：
//   ① 只标前五（第 6 只起一律不标）；
//   ② 顺序语义：items 顺序 = 已排序的顺序，本模块⛔ 不排序；
//   ③ §10：没有 20 日涨幅的行跳过且【不占名次】（⛔ 不补 0 顶名次）；
//   ④ 越界/空输入安全（⛔ 不产出「总龙6」这种文案）。

import { describe, it, expect } from 'vitest';
import {
  RANGE20_TOTAL_DRAGON_TOP_N,
  TOTAL_DRAGON_LABELS,
  totalDragonLabel,
  assignTotalDragonRanks
} from './range20-top5-label.js';

/** 造行：只带本模块要读的两个字段（别的字段与判定无关） */
function row(stock, rangePct20) {
  return { stock, rangePct20 };
}

describe('range20-top5-label · 常量与文案', () => {
  it('只数上限 = 5，文案顺序 = 总龙一…总龙五', () => {
    expect(RANGE20_TOTAL_DRAGON_TOP_N).toBe(5);
    expect(TOTAL_DRAGON_LABELS).toEqual(['总龙一', '总龙二', '总龙三', '总龙四', '总龙五']);
  });

  it('rank → 文案：1..5 有值，0 / 6 / 非数 ⇒ 空串（⛔ 不产出越界文案）', () => {
    expect(totalDragonLabel(1)).toBe('总龙一');
    expect(totalDragonLabel(5)).toBe('总龙五');
    expect(totalDragonLabel(0)).toBe('');
    expect(totalDragonLabel(6)).toBe('');
    expect(totalDragonLabel(-1)).toBe('');
    expect(totalDragonLabel('abc')).toBe('');
    expect(totalDragonLabel(null)).toBe('');
  });
});

describe('assignTotalDragonRanks · 按顺序给前五打标', () => {
  it('前五依次拿 1..5，第六只及以后不打标', () => {
    const items = [
      row('新华传媒', 197.82),
      row('九阳股份', 106.51),
      row('新华文轩', 101.90),
      row('澳弘电子', 90.73),
      row('慈文传媒', 79.41),
      row('时代万恒', 60.04)
    ];
    const n = assignTotalDragonRanks(items);
    expect(n).toBe(5);
    expect(items.map(i => i.totalDragonLabel)).toEqual(['总龙一', '总龙二', '总龙三', '总龙四', '总龙五', '']);
    expect(items.map(i => i.totalDragonRank)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('★ 缺值的行【跳过且不占名次】：第 3 只没有 20 日涨幅 ⇒ 第 4 只拿「总龙三」', () => {
    const items = [
      row('A', 90),
      row('B', 80),
      row('C', null),
      row('D', 70),
      row('E', 60),
      row('F', 50)
    ];
    const n = assignTotalDragonRanks(items);
    expect(n).toBe(5);
    expect(items.map(i => i.totalDragonLabel)).toEqual(['总龙一', '总龙二', '', '总龙三', '总龙四', '总龙五']);
    expect(items[2].totalDragonRank).toBe(0);
  });

  it('★ 负涨幅也算有效值（§10：不因为是负数就当没数据）', () => {
    const items = [row('A', -2.88), row('B', -16.09)];
    expect(assignTotalDragonRanks(items)).toBe(2);
    expect(items[0].totalDragonLabel).toBe('总龙一');
    expect(items[1].totalDragonLabel).toBe('总龙二');
  });

  it('有值的行不足 5 只 ⇒ 返回实际只数，剩下的不打标', () => {
    const items = [row('A', 10), row('B', null), row('C', 5)];
    expect(assignTotalDragonRanks(items)).toBe(2);
    expect(items.map(i => i.totalDragonLabel)).toEqual(['总龙一', '', '总龙二']);
  });

  it('topN 可覆盖（传 3 ⇒ 只标三只）', () => {
    const items = [row('A', 9), row('B', 8), row('C', 7), row('D', 6)];
    expect(assignTotalDragonRanks(items, 3)).toBe(3);
    expect(items[3].totalDragonLabel).toBe('');
  });

  it('空输入 / 空数组 / 含 null 元素 ⇒ 不抛错', () => {
    expect(assignTotalDragonRanks(null)).toBe(0);
    expect(assignTotalDragonRanks([])).toBe(0);
    const items = [null, row('A', 1)];
    expect(assignTotalDragonRanks(items)).toBe(1);
    expect(items[1].totalDragonLabel).toBe('总龙一');
  });

  it('重复调用是幂等的（重算不会把名次越加越大）', () => {
    const items = [row('A', 9), row('B', 8)];
    assignTotalDragonRanks(items);
    assignTotalDragonRanks(items);
    expect(items.map(i => i.totalDragonRank)).toEqual([1, 2]);
  });
});
