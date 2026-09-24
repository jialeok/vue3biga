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
  groupByTopicLadder,
  getAucOpenKind,
  getAucOpenText,
  judgePromotion,
  getPromoteText,
  countLadder,
  formatRangePct,
  hasSeriesData,
  LADDER_MIN_STREAK,
  LADDER_MIN_LEVELS,
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

// ============================================================================
// [题材连扳 2026-09-24] 按【题材】看连板梯队的完整性。
// 用户原话：AI应用 里 四板 新华文轩 / 三板 新华传媒 / 二板 天威视讯 ⇒ 出现二板+三板+四板 = 3 层；
//           只出现二板+三板 = 2 层，同样算成梯队。
// ============================================================================
describe('groupByTopicLadder（题材连扳梯队）', () => {
  it('AI应用 占 二板/三板/四板 = 3 层 ⇒ 梯队完整', () => {
    const groups = groupByTopicLadder([
      R('新华文轩', 4, 30, 2, false, null, 'AI应用'),
      R('新华传媒', 3, 20, 2, false, null, 'AI应用'),
      R('天威视讯', 2, 10, 2, false, null, 'AI应用')
    ], {});
    expect(groups.length).toBe(1);
    expect(groups[0].topic).toBe('AI应用');
    expect(groups[0].levelCount).toBe(3);
    expect(groups[0].levelText).toBe('3层');
    expect(groups[0].levelDetail).toBe('四板/三板/二板');
    expect(groups[0].isComplete).toBe(true);
    expect(groups[0].completeText).toBe('梯队完整');
    expect(groups[0].count).toBe(3);
  });

  it('只有二板 + 三板 = 2 层，也算成梯队（用户明确要的口径）', () => {
    const groups = groupByTopicLadder([
      R('甲', 3, 10, 1, false, null, 'T1'),
      R('乙', 2, 10, 1, false, null, 'T1')
    ], {});
    expect(groups[0].levelCount).toBe(LADDER_MIN_LEVELS);
    expect(groups[0].isComplete).toBe(true);
  });

  it('只有二板 = 1 层 ⇒ 单层，不算成梯队（但照样显示出来）', () => {
    const groups = groupByTopicLadder([
      R('甲', 2, 10, 1, false, null, 'T1'),
      R('乙', 2, 9, 1, false, null, 'T1')
    ], {});
    expect(groups[0].levelCount).toBe(1);
    expect(groups[0].isComplete).toBe(false);
    expect(groups[0].completeText).toBe('单层');
    expect(groups[0].count).toBe(2);
  });

  it('题材内按天梯顺序：连板数降序 → 十日涨幅降序', () => {
    const groups = groupByTopicLadder([
      R('二板弱', 2, 5, 1, false, null, 'T1'),
      R('三板强', 3, 80, 1, false, null, 'T1'),
      R('二板强', 2, 50, 1, false, null, 'T1'),
      R('四板', 4, 1, 1, false, null, 'T1')
    ], {});
    expect(groups[0].rows.map(r => r.name)).toEqual(['四板', '三板强', '二板强', '二板弱']);
    expect(groups[0].rows.map(r => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it('题材排序：层级多的在前 → 股票数降序 → 题材名（"其它"永远置底）', () => {
    const groups = groupByTopicLadder([
      R('a1', 2, 1, 1, false, null, '其它'),
      R('a2', 3, 1, 1, false, null, '其它'),   // 其它：2 层，但必须排最后
      R('b1', 2, 1, 1, false, null, 'T2'),     // T2：1 层
      R('c1', 2, 1, 1, false, null, 'T1'),
      R('c2', 3, 1, 1, false, null, 'T1'),
      R('c3', 4, 1, 1, false, null, 'T1')      // T1：3 层 → 最前
    ], {});
    expect(groups.map(g => g.topic)).toEqual(['T1', 'T2', '其它']);
  });

  it('首板 / 趋势不进题材梯队（与档位模式同一条入选门槛）', () => {
    const groups = groupByTopicLadder([
      R('首板股', 1, 10, 1, false, null, 'T1'),
      R('趋势股', 0, 10, 1, false, null, 'T1'),
      R('二板股', 2, 10, 1, false, null, 'T1'),
      R('三板股', 3, 10, 1, false, null, 'T1')
    ], {});
    expect(groups.length).toBe(1);
    expect(groups[0].count).toBe(2);
  });

  it('与 groupByStreak 同源：同一批 rows 两种切法，股票总数不变', () => {
    const rows = [
      R('甲', 4, 30, 2, true, null, 'T1'),
      R('乙', 3, 20, 2, false, null, 'T1'),
      R('丙', 2, 10, 2, false, null, 'T2'),
      R('丁', 2, 9, -1, false, null, 'T2')
    ];
    const byStreak = groupByStreak(rows, { closeReady: false });
    const byTopic = groupByTopicLadder(rows, { closeReady: false });
    const n1 = byStreak.reduce((n, g) => n + g.count, 0);
    const n2 = byTopic.reduce((n, g) => n + g.count, 0);
    expect(n1).toBe(4);
    expect(n2).toBe(4);
    // 竞价一字那只在两种切法里都是「晋级成功」（早盘阶段口径）
    expect(byTopic[0].rows[0].promote).toBe(PROMOTE_SUCCESS);
  });

  it('§10 边界：空输入 / 无一只二板以上 → 空数组，绝不返回半成品分组', () => {
    expect(groupByTopicLadder([], {})).toEqual([]);
    expect(groupByTopicLadder(null, {})).toEqual([]);
    expect(groupByTopicLadder([R('首板', 1, 1, 1, false, null, 'T1')], {})).toEqual([]);
  });
});
