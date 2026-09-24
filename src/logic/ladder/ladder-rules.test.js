// ladder-rules.test.js — 「连板天梯晋级」规则回归用例
//
// 钉住四件事（后期改规则时先看这里）：
//   ① 只有【二板及以上】进本看板（首板 / 趋势不进）；
//   ② 分档按连板数【降序】，档位条带数量，档内按十日涨幅降序；
//   ③ 高开 / 低开 / 平开 = 竞价涨幅方向，缺竞价涨幅 → 不出标（不是平开）；
//   ④ 晋级三态：收盘口径后按收盘涨停定成败；未到收盘口径时「竞价一字」先算成功，其余待定。

import { describe, it, expect } from 'vitest';
import {
  groupByStreak,
  getAucOpenKind,
  getAucOpenText,
  judgePromotion,
  getPromoteText,
  countLadder,
  formatRangePct,
  hasSeriesData,
  LADDER_MIN_STREAK,
  AUC_OPEN_HIGH,
  AUC_OPEN_LOW,
  AUC_OPEN_FLAT,
  PROMOTE_SUCCESS,
  PROMOTE_FAIL,
  PROMOTE_PENDING
} from './ladder-rules.js';

/** R(股票名, 连板数, 十日涨幅, 竞价涨幅, 是否一字, 收盘停板, 题材) */
function R(name, streak, pct, aucPct, isYiZi, closeLimit, topic) {
  return {
    name: name,
    streak: streak,
    pct: pct === undefined ? null : pct,
    aucPct: aucPct === undefined ? null : aucPct,
    isYiZi: !!isYiZi,
    closeLimit: closeLimit || null,
    topic: topic || ''
  };
}

describe('getAucOpenKind（高开 / 低开 / 平开）', () => {
  it('竞价涨幅 >0 高开 / <0 低开 / =0 平开', () => {
    expect(getAucOpenKind(3.2)).toBe(AUC_OPEN_HIGH);
    expect(getAucOpenKind(-1.5)).toBe(AUC_OPEN_LOW);
    expect(getAucOpenKind(0)).toBe(AUC_OPEN_FLAT);
  });

  it('缺竞价涨幅 → null（§10：缺数据 ≠ 平开），文案为空', () => {
    expect(getAucOpenKind(null)).toBe(null);
    expect(getAucOpenKind(undefined)).toBe(null);
    expect(getAucOpenText(null)).toBe('');
  });

  it('文案与方向一一对应', () => {
    expect(getAucOpenText(AUC_OPEN_HIGH)).toBe('高开');
    expect(getAucOpenText(AUC_OPEN_LOW)).toBe('低开');
    expect(getAucOpenText(AUC_OPEN_FLAT)).toBe('平开');
  });
});

describe('judgePromotion（晋级三态）', () => {
  it('已到收盘口径 → 收盘涨停才算晋级成功', () => {
    expect(judgePromotion({ isYiZi: false, closeLimit: 'up', closeReady: true })).toBe(PROMOTE_SUCCESS);
    expect(judgePromotion({ isYiZi: true, closeLimit: null, closeReady: true })).toBe(PROMOTE_FAIL);
    expect(judgePromotion({ isYiZi: false, closeLimit: 'down', closeReady: true })).toBe(PROMOTE_FAIL);
  });

  it('未到收盘口径 且 竞价一字 → 先算晋级成功（用户口径）', () => {
    expect(judgePromotion({ isYiZi: true, closeLimit: null, closeReady: false })).toBe(PROMOTE_SUCCESS);
  });

  it('未到收盘口径 且 非一字 → 待定，绝不猜成失败', () => {
    expect(judgePromotion({ isYiZi: false, closeLimit: null, closeReady: false })).toBe(PROMOTE_PENDING);
    expect(getPromoteText(PROMOTE_PENDING)).toBe('待定');
  });

  it('早盘阶段即使行里带着收盘副本也不能当收盘结果用', () => {
    // closeReady=false 时，closeLimit 由采集层强制传 null（见 ladder-collect），这里再兜一层
    expect(judgePromotion({ isYiZi: false, closeLimit: 'up', closeReady: false })).toBe(PROMOTE_PENDING);
  });

  it('文案与状态对应', () => {
    expect(getPromoteText(PROMOTE_SUCCESS)).toBe('晋级成功');
    expect(getPromoteText(PROMOTE_FAIL)).toBe('晋级失败');
  });
});

describe('groupByStreak（分档）', () => {
  it('只收二板及以上：首板 / 趋势不进本看板', () => {
    const groups = groupByStreak([
      R('首板股', 1, 10, 2),
      R('趋势股', 0, 5, 1),
      R('二板股', 2, 20, 3),
      R('三板股', 3, 30, 4)
    ], {});
    expect(groups.map(g => g.streak)).toEqual([3, 2]);
    expect(groups.map(g => g.count)).toEqual([1, 1]);
  });

  it('档位按连板数降序（高板在上），档位文案走 getStreakLabel', () => {
    const groups = groupByStreak([
      R('a', 2, 1, 1), R('b', 5, 2, 1), R('c', 3, 3, 1), R('d', 4, 4, 1)
    ], {});
    expect(groups.map(g => g.label)).toEqual(['五板', '四板', '三板', '二板']);
  });

  it('同档内按十日涨幅降序，序号连续', () => {
    const groups = groupByStreak([
      R('低', 2, 5, 1), R('高', 2, 50, 1), R('中', 2, 20, 1)
    ], {});
    expect(groups[0].rows.map(r => r.name)).toEqual(['高', '中', '低']);
    expect(groups[0].rows.map(r => r.seq)).toEqual([1, 2, 3]);
  });

  it('档位条的数量 = 该档股票数；countLadder 是所有档之和', () => {
    const groups = groupByStreak([
      R('a', 2, 1, 1), R('b', 2, 2, 1), R('c', 3, 3, 1)
    ], {});
    expect(groups[0].label).toBe('三板');
    expect(groups[0].count).toBe(1);
    expect(groups[1].label).toBe('二板');
    expect(groups[1].count).toBe(2);
    expect(countLadder(groups)).toBe(3);
  });

  it('最低门槛常量就是 2（二连板）', () => {
    expect(LADDER_MIN_STREAK).toBe(2);
  });

  it('行上带全：连板标 / 开平标 / 十日涨幅 / 题材 / 晋级', () => {
    const groups = groupByStreak([
      R('某股', 3, 62.8, 2.5, false, null, 'T1')
    ], { closeReady: false });
    const row = groups[0].rows[0];
    expect(row.streakLabel).toBe('三板');
    expect(row.aucOpenText).toBe('高开');
    expect(row.topic).toBe('T1');
    expect(row.promote).toBe(PROMOTE_PENDING);
    expect(row.promoteText).toBe('待定');
  });

  it('竞价值缺失时开平标为空串（不是「平开」）', () => {
    const groups = groupByStreak([R('无竞价', 2, 10, null)], {});
    expect(groups[0].rows[0].aucOpen).toBe(null);
    expect(groups[0].rows[0].aucOpenText).toBe('');
  });

  it('收盘口径下按收盘涨停给成功 / 失败', () => {
    const groups = groupByStreak([
      R('封住了', 2, 10, 1, false, 'up'),
      R('没封住', 2, 9, 1, false, null)
    ], { closeReady: true });
    const byName = {};
    groups[0].rows.forEach(function(r) { byName[r.name] = r.promote; });
    expect(byName['封住了']).toBe(PROMOTE_SUCCESS);
    expect(byName['没封住']).toBe(PROMOTE_FAIL);
  });
});

describe('格式化与趋势序列', () => {
  it('formatRangePct：有值带符号，缺失空串', () => {
    expect(formatRangePct(62.87)).toBe('+63%');
    expect(formatRangePct(-3.2)).toBe('-3%');
    expect(formatRangePct(null)).toBe('');
  });

  it('hasSeriesData：全空的腿不画图', () => {
    expect(hasSeriesData([{ date: 'd', value: 1 }])).toBe(true);
    expect(hasSeriesData([{ date: 'd', value: null }])).toBe(false);
    expect(hasSeriesData(null)).toBe(false);
  });
});
