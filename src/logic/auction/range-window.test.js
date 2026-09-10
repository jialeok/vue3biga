import { describe, it, expect } from 'vitest';
import {
  RANGE_WINDOW_DAYS,
  parsePct,
  compoundPct,
  isAuctionLegActive,
  resolveTDayPct
} from './range-window.js';

describe('parsePct 涨幅解析', () => {
  it('支持百分号 / 正负号 / 数字', () => {
    expect(parsePct('2.34%')).toBe(2.34);
    expect(parsePct('+2.34%')).toBe(2.34);
    expect(parsePct('-7.71%')).toBe(-7.71);
    expect(parsePct(3)).toBe(3);
    expect(parsePct('-9.2926')).toBe(-9.2926);
  });

  it('无数据一律 null（绝不返回 0 —— 0 是真实涨幅，不能表示"没数据"）', () => {
    expect(parsePct('')).toBeNull();
    expect(parsePct(null)).toBeNull();
    expect(parsePct(undefined)).toBeNull();
    expect(parsePct('abc')).toBeNull();
    expect(parsePct(NaN)).toBeNull();
  });
});

describe('compoundPct 复利累乘（区间涨幅的核心算法）', () => {
  it('两日 +10% / -10% → -1%（复利，不是简单相加 0%）', () => {
    expect(compoundPct([10, -10])).toBeCloseTo(-1, 6);
  });

  it('单日 → 等于该日涨幅', () => {
    expect(compoundPct([5])).toBeCloseTo(5, 6);
  });

  it('空数组 → null（不伪造 0）', () => {
    expect(compoundPct([])).toBeNull();
    expect(compoundPct(null)).toBeNull();
  });

  it('[真实数据回归] 万向德农 2026-08-27→09-09 十天窗口 = +61.43%', () => {
    // 窗口逐日涨幅（猫抓 daily 与同花顺前后复权收盘价三源一致，2026-09-10 实测）
    const daily = [9.958, 10.009, 9.965, 10.008, 3.295, -9.293, 4.740, 10.000, 5.043, -2.716];
    expect(daily.length).toBe(RANGE_WINDOW_DAYS);
    expect(compoundPct(daily)).toBeCloseTo(61.43, 1);
  });

  it('[真实数据回归] 亚盛集团(600108) 2026-08-27→09-09 十天窗口 = +65.99%', () => {
    const daily = [9.884, 0.794, -2.887, 5.946, -8.163, 10.000, 10.101, 10.092, 10.000, 8.144];
    expect(compoundPct(daily)).toBeCloseTo(65.99, 1);
  });

  it('[真实数据回归] 沃华医药(002107) 08-27→09-09 = +15.00% —— 历史 T 腿必须取收盘涨幅', () => {
    // 收盘价（该股窗口内无除权 → 前复权 = 不复权）：8/26 起，首根只作基准不出现在窗口里
    const close = [6.40, 6.57, 7.23, 6.70, 7.37, 7.07, 6.90, 6.82, 6.84, 7.18, 7.36];
    const daily = close.slice(1).map((c, i) => (c / close[i] - 1) * 100);
    expect(daily.length).toBe(RANGE_WINDOW_DAYS);
    expect(compoundPct(daily)).toBeCloseTo(15.0, 1);
    // 反例：9/9 那天 market_metrics.change_pct 是竞价值的副本（-1.81），
    // 而真实收盘是 +2.51 → 若 T 腿回退到 change_pct，区间涨幅会系统性少 4.8 个百分点（+10.16%）。
    const wrongT = daily.slice(0, 9).concat([-1.81]);
    expect(compoundPct(wrongT)).toBeCloseTo(10.16, 1);
  });

  it('[真实数据回归] 华正新材(603186) 08-27→09-09 = +20.94% —— 窗口必须含首日 T-9', () => {
    const close = [175.35, 183.39, 183.6, 182.5, 171.07, 181.31, 180.36, 169.17, 186.09, 192.78, 212.06];
    const daily = close.slice(1).map((c, i) => (c / close[i] - 1) * 100);
    expect(compoundPct(daily)).toBeCloseTo(20.94, 1);
    // 反例：丢了窗口首日（K 线取数起点太晚 / 只取到 9 天）→ 只剩 +15.63%（线上曾是这个错值）
    expect(compoundPct(daily.slice(1))).toBeCloseTo(15.63, 1);
  });
});

describe('T 腿口径（龙一/龙二排名的关键）', () => {
  it('今天 + 未收盘 → 用竞价涨幅占位', () => {
    expect(isAuctionLegActive('2026-09-10', '2026-09-10', false)).toBe(true);
    expect(resolveTDayPct(true, false, 5.0, 2.1)).toBe(2.1);
  });

  it('今天 + 已收盘 → 用收盘涨幅', () => {
    expect(isAuctionLegActive('2026-09-10', '2026-09-10', true)).toBe(false);
    expect(resolveTDayPct(true, true, 5.0, 2.1)).toBe(5.0);
  });

  it('历史日期 → 必须用收盘涨幅（用竞价腿会让区间涨幅系统性失真）', () => {
    expect(isAuctionLegActive('2026-09-09', '2026-09-10', false)).toBe(false);
    expect(resolveTDayPct(false, false, -2.716, -7.71)).toBe(-2.716);
  });

  it('收盘涨幅取不到 → 退回竞价涨幅（有总比没有强）', () => {
    expect(resolveTDayPct(false, false, '', -7.71)).toBe(-7.71);
    expect(resolveTDayPct(true, true, null, 2.1)).toBe(2.1);
  });

  it('两者都没有 → null（该腿不参与，不补 0）', () => {
    expect(resolveTDayPct(false, false, null, '')).toBeNull();
    expect(resolveTDayPct(true, false, 5, null)).toBeNull();
  });
});
