import { describe, it, expect } from 'vitest';
import { getStreakLabel, computeStreak, buildLimitStreakMap, STREAK_LOOKBACK_DAYS } from './limit-streak.js';

describe('getStreakLabel 连板档位文案', () => {
  it('0=趋势 / 1=首板 / 2=二板 / 3=三板', () => {
    expect(getStreakLabel(0)).toBe('趋势');
    expect(getStreakLabel(1)).toBe('首板');
    expect(getStreakLabel(2)).toBe('二板');
    expect(getStreakLabel(3)).toBe('三板');
  });
  it('4..10 用中文数字，超过 10 用阿拉伯数字（不生造汉字）', () => {
    expect(getStreakLabel(4)).toBe('四板');
    expect(getStreakLabel(9)).toBe('九板');
    expect(getStreakLabel(10)).toBe('十板');
    expect(getStreakLabel(11)).toBe('11板');
    expect(getStreakLabel(15)).toBe('15板');
  });
  it('非法/缺失入参一律落到「趋势」（0 档）', () => {
    expect(getStreakLabel(undefined)).toBe('趋势');
    expect(getStreakLabel(null)).toBe('趋势');
    expect(getStreakLabel(NaN)).toBe('趋势');
    expect(getStreakLabel(-3)).toBe('趋势');
  });
});

describe('computeStreak 连续收盘涨停判定（用户给的 9/11 案例，descPcts[0] = 最近历史日 9/10）', () => {
  // 主板 600xxx：涨停 10%
  it('9/9、9/10 两个连续涨停 → 二板', () => {
    // 9/7 5.6%，9/8 1%，9/9 10.1%，9/10 10.1%
    const desc = ['+10.1%', '+10.1%', '+1%', '+5.6%'];
    expect(computeStreak(desc, '600000', '某某')).toEqual({ streak: 2, label: '二板' });
  });
  it('9/8、9/9、9/10 三个连续涨停 → 三板', () => {
    const desc = ['+10.1%', '+10.1%', '+10%', '+5.6%'];
    expect(computeStreak(desc, '600000', '某某')).toEqual({ streak: 3, label: '三板' });
  });
  it('断板：只有 9/10 涨停（9/9 为 3.2%）→ 首板', () => {
    const desc = ['+10.1%', '+3.2%', '+1%', '+5.6%'];
    expect(computeStreak(desc, '600000', '某某')).toEqual({ streak: 1, label: '首板' });
  });
  it('没有连板：9/10 为 7.2%（9/9 曾涨停也已断板）→ 趋势', () => {
    const desc = ['+7.2%', '+10.1%', '+1%', '+5.6%'];
    expect(computeStreak(desc, '600000', '某某')).toEqual({ streak: 0, label: '趋势' });
  });
  it('窗口内从未涨停 → 趋势', () => {
    const desc = ['+1.2%', '-0.8%', '+0.3%', '+2.1%'];
    expect(computeStreak(desc, '600000', '某某')).toEqual({ streak: 0, label: '趋势' });
  });
});

describe('computeStreak 涨停幅度按板块/ST（复用停板口径 getCloseLimitState）', () => {
  it('四舍五入容差：主板 +9.88% 仍算涨停（与蚂蚁线同一判据）', () => {
    const desc = ['+9.88%', '+10.02%'];
    expect(computeStreak(desc, '600000', '某某').streak).toBe(2);
  });
  it('创业板 10% 不算涨停（需 20%）→ 趋势', () => {
    expect(computeStreak(['+10.00%', '+20.00%'], '300750', '宁德时代').label).toBe('趋势');
  });
  it('创业板 20% 连续两天 → 二板', () => {
    expect(computeStreak(['+20.00%', '+19.98%'], '300750', '宁德时代')).toEqual({ streak: 2, label: '二板' });
  });
  it('北交所 30%', () => {
    expect(computeStreak(['+30.00%', '+10.00%'], '830799', '某某').label).toBe('首板');
  });
  it('ST 主板 5% 即涨停', () => {
    expect(computeStreak(['+5.03%', '+5.00%', '+1%'], '600000', '*ST某某')).toEqual({ streak: 2, label: '二板' });
  });
});

describe('computeStreak 缺数据（§10 绝不用「没数据」冒充结果）', () => {
  it('最近历史日无数据 → null（不出标记，而不是猜成「趋势」）', () => {
    expect(computeStreak([null, '+10.1%'], '600000', '某某')).toBe(null);
    expect(computeStreak(['', '+10.1%'], '600000', '某某')).toBe(null);
    expect(computeStreak([undefined], '600000', '某某')).toBe(null);
  });
  it('空数组 / 非数组 → null', () => {
    expect(computeStreak([], '600000', '某某')).toBe(null);
    expect(computeStreak(null, '600000', '某某')).toBe(null);
  });
  it('中间某日缺数据 → 连板链在该处断开', () => {
    // T-1 涨停、T-2 涨停、T-3 缺数据、T-4 涨停 → 只能数到 2
    expect(computeStreak(['+10.1%', '+10.1%', null, '+10.1%'], '600000', '某某')).toEqual({ streak: 2, label: '二板' });
  });
  it('接受 number 入参；0% 是真实数据（判为趋势，不是「没数据」）', () => {
    expect(computeStreak([10.01, 9.99], '600000', '某某')).toEqual({ streak: 2, label: '二板' });
    expect(computeStreak([0, 10.01], '600000', '某某')).toEqual({ streak: 0, label: '趋势' });
  });
});

describe('buildLimitStreakMap 组装映射', () => {
  const D1 = '2026-09-10'; // T-1
  const D2 = '2026-09-09';
  const D3 = '2026-09-08';
  const dates = [D1, D2, D3];

  function mkRows() {
    return new Map([
      [D1, new Map([
        ['甲', { stock: '甲', code: '600001', change_pct: '+10.02%' }],
        ['乙', { stock: '乙', code: '600002', change_pct: '+7.20%' }],
        ['丙', { stock: '丙', code: '600003', change_pct: '+10.02%' }]
      ])],
      [D2, new Map([
        ['甲', { stock: '甲', code: '600001', change_pct: '+10.01%' }],
        ['乙', { stock: '乙', code: '600002', change_pct: '+10.01%' }],
        ['丙', { stock: '丙', code: '600003', change_pct: '+1.00%' }]
      ])],
      [D3, new Map([
        ['甲', { stock: '甲', code: '600001', change_pct: '+1.00%' }],
        ['乙', { stock: '乙', code: '600002', change_pct: '+1.00%' }]
      ])]
    ]);
  }

  it('基准 = T-1 有行的股票；逐日降序取收盘涨幅（兼容 changePct 别名）', () => {
    const m = buildLimitStreakMap(dates, mkRows(), (r) => r.code);
    expect(m.get('甲')).toEqual({ streak: 2, label: '二板' });
    expect(m.get('乙')).toEqual({ streak: 0, label: '趋势' });
    expect(m.get('丙')).toEqual({ streak: 1, label: '首板' });
  });

  it('T-1 没有这一行的股票 ⇒ 映射里没有它（不伪造「趋势」）', () => {
    const rows = mkRows();
    rows.get(D1).set('丁', { stock: '丁', code: '600004', change_pct: '' });
    const m = buildLimitStreakMap(dates, rows, (r) => r.code);
    expect(m.has('丁')).toBe(false);
  });

  it('changePct（camelCase 别名）同样可读', () => {
    const rows = new Map([[D1, new Map([['戊', { stock: '戊', code: '600005', changePct: '+10.02%' }]])]]);
    const m = buildLimitStreakMap([D1], rows, (r) => r.code);
    expect(m.get('戊')).toEqual({ streak: 1, label: '首板' });
  });

  it('缺日期 / 空行 → 空映射（不抛错）', () => {
    expect(buildLimitStreakMap([], mkRows()).size).toBe(0);
    expect(buildLimitStreakMap(dates, null).size).toBe(0);
    expect(buildLimitStreakMap(dates, new Map()).size).toBe(0);
  });
});

describe('STREAK_LOOKBACK_DAYS', () => {
  it('回看 9 个历史交易日（与 10 日区间窗口 [T-9,T] 去掉当天重合）', () => {
    expect(STREAK_LOOKBACK_DAYS).toBe(9);
  });
});
