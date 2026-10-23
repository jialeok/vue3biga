import { describe, it, expect } from 'vitest';
import {
  KXIAN_KIND,
  GUANCHA_PROCESS,
  GUANCHA_RESULT,
  kxianKind,
  deriveGuanchaByKxian
} from './kxian-trend.js';
import {
  GUOCHENG_UP,
  GUOCHENG_DOWN,
  GUOCHENG_POSITIVE,
  GUOCHENG_NEGATIVE,
  JIELUN_ACT,
  JIELUN_EMPTY,
  toPct,
  deriveGuochengAndJielun
} from './auction-derive.js';

// 全部断言直接对应用户 2026-10-23 的原话，注释里保留原句，方便日后核对。

/** 快捷构造：把 K 线文案数组变成「按时间倒序」的序列 */
const S = (...labels) => labels.map((label) => ({ label }));

describe('kxian-trend / kxianKind', () => {
  it('七种 K 线文案都能认出类型', () => {
    expect(kxianKind('大阳3.6%')).toBe(KXIAN_KIND.DAYANG);
    expect(kxianKind('中阳2.8%')).toBe(KXIAN_KIND.ZHONGYANG);
    expect(kxianKind('小阳1.9%')).toBe(KXIAN_KIND.XIAOYANG);
    expect(kxianKind('十字星0.03%')).toBe(KXIAN_KIND.CROSS);
    expect(kxianKind('小阴-1.87%')).toBe(KXIAN_KIND.XIAOYIN);
    expect(kxianKind('中阴-2.8%')).toBe(KXIAN_KIND.ZHONGYIN);
    expect(kxianKind('大阴-4%')).toBe(KXIAN_KIND.DAYIN);
  });

  it('负号 / 空值 / 认不出的写法 ⇒ 空串（⛔ 不猜）', () => {
    expect(kxianKind('十字星-0.58%')).toBe(KXIAN_KIND.CROSS);
    expect(kxianKind('')).toBe('');
    expect(kxianKind(null)).toBe('');
    expect(kxianKind('普涨')).toBe('');
  });
});

describe('kxian-trend / deriveGuanchaByKxian', () => {
  it('★ 阴线一律看结果（原话：十字星、小阴、大阴 → 最近多板结果）', () => {
    expect(deriveGuanchaByKxian(S('小阴-1.87%', '小阳1.9%')).guancha).toBe(GUANCHA_RESULT);
    expect(deriveGuanchaByKxian(S('大阴-4.2%', '小阳1.9%')).guancha).toBe(GUANCHA_RESULT);
    expect(deriveGuanchaByKxian(S('中阴-2.8%', '小阳1.9%')).guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 十字星看结果（阳线十字星、阴线十字星都一样）', () => {
    expect(deriveGuanchaByKxian(S('十字星0.81%', '中阳2.3%')).guancha).toBe(GUANCHA_RESULT);
    expect(deriveGuanchaByKxian(S('十字星-0.58%', '中阳2.3%')).guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 大阳看结果（原话：大阳的话看结果）', () => {
    expect(deriveGuanchaByKxian(S('大阳5.2%', '中阳2.3%')).guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 中阳·第一次 ⇒ 过程，且前缀写「第一次中阳」（前一日是十字星）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '十字星0.81%', '小阳1.9%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次中阳');
    expect(r.isFirstZhongyang).toBe(true);
  });

  it('★ 中阳·第一次（前一日是阴线）也算第一次', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '小阴-1.6%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次中阳');
  });

  it('★ 中阳·第二次 ⇒ 结果，且不再标前缀（原话：第二次中阳看结果）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '中阳1.8%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
    expect(r.kxianPrefix).toBe('');
    expect(r.isFirstZhongyang).toBe(false);
  });

  it('★ 中阳·第 3 次及以上 ⇒ 结果（原话：前面两次以上都是结果）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '中阳1.8%', '中阳1.2%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 十字星是临界点：中间隔了十字星，更早的中阳不参与计数 ⇒ 重新算第一次', () => {
    // 中阳 → 十字星 → 中阳：今天这个中阳仍是「第一次」
    const r = deriveGuanchaByKxian(S('中阳2.3%', '十字星0.1%', '中阳1.8%', '中阳1.5%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次中阳');
  });

  it('★ 中阳之间夹了别的不算连续（只认连续同类）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '小阳1.9%', '中阳1.8%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);   // 前一日不是中阳 ⇒ 第一次
  });

  it('★ 小阳：前面不足 2 根 ⇒ 过程（原话：小阳看过程）', () => {
    expect(deriveGuanchaByKxian(S('小阳1.9%', '十字星0.5%')).guancha).toBe(GUANCHA_PROCESS);
    expect(deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '十字星0.5%')).guancha).toBe(GUANCHA_PROCESS);
  });

  it('★ 小阳：前面已有 2 根 ⇒ 结果（原话：但是前面有两根小阳，看结果）', () => {
    const r = deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '小阳1.1%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 小阳前面被十字星打断 ⇒ 重新从 0 数', () => {
    const r = deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '十字星0.1%', '小阳1.1%', '小阳1.0%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);   // 十字星之后只有 1 根
  });

  it('★ 数据缺口必须中断计数，⛔ 不许跨过空格继续数（§10）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '', '中阳1.8%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
  });

  it('★ 序列为空 / 首项认不出 ⇒ null（前台保持 "-"，⛔ 不猜）', () => {
    expect(deriveGuanchaByKxian([])).toBeNull();
    expect(deriveGuanchaByKxian(null)).toBeNull();
    expect(deriveGuanchaByKxian(S('', '中阳2.3%'))).toBeNull();
    expect(deriveGuanchaByKxian(S('普涨', '中阳2.3%'))).toBeNull();
  });
});

describe('auction-derive / toPct', () => {
  it('解析百分比字符串', () => {
    expect(toPct('0.42')).toBe(0.42);
    expect(toPct('-3.22')).toBe(-3.22);
    expect(toPct('+1.6')).toBe(1.6);
    expect(toPct('2.3%')).toBe(2.3);
    expect(toPct(1.5)).toBe(1.5);
  });

  it('★ 空 / 非法 ⇒ null，⛔ 不返回 0（§10 不拿 0 冒充「涨跌持平」）', () => {
    expect(toPct('')).toBeNull();
    expect(toPct(null)).toBeNull();
    expect(toPct(undefined)).toBeNull();
    expect(toPct('abc')).toBeNull();
  });
});

describe('auction-derive / deriveGuochengAndJielun', () => {
  it('★ 9:25 > 0 ⇒ 结果为正 + 出手（原话：数值大于 0，结果为正……得出结论选出手）', () => {
    expect(deriveGuochengAndJielun({ time925: '0.42' }))
      .toEqual({ guochengJieguo: GUOCHENG_POSITIVE, jielun: JIELUN_ACT });
  });

  it('★ 9:25 < 0 ⇒ 结果为负 + 空仓', () => {
    expect(deriveGuochengAndJielun({ time925: '-3.22' }))
      .toEqual({ guochengJieguo: GUOCHENG_NEGATIVE, jielun: JIELUN_EMPTY });
  });

  it('★ 9:25 恰好为 0 ⇒ null（正负都不成立，留空给人工）', () => {
    expect(deriveGuochengAndJielun({ time925: '0' })).toBeNull();
  });

  it('★ 9:25 缺失 ⇒ null（⛔ 不拿「结果为正」冒充）', () => {
    expect(deriveGuochengAndJielun({ time925: '' })).toBeNull();
    expect(deriveGuochengAndJielun({})).toBeNull();
  });

  it('★ 观察=过程：9:25 > 9:20 ⇒ 过程递增 + 出手', () => {
    expect(deriveGuochengAndJielun({ time920: '-6.59', time925: '-3.22', byAuctionTrend: true }))
      .toEqual({ guochengJieguo: GUOCHENG_UP, jielun: JIELUN_ACT });
  });

  it('★ 观察=过程：9:25 < 9:20 ⇒ 过程递减 + 空仓', () => {
    expect(deriveGuochengAndJielun({ time920: '1.11', time925: '0.42', byAuctionTrend: true }))
      .toEqual({ guochengJieguo: GUOCHENG_DOWN, jielun: JIELUN_EMPTY });
  });

  it('★ 观察=过程：9:25 == 9:20 ⇒ 按递增处理、出手（用户明确答复）', () => {
    expect(deriveGuochengAndJielun({ time920: '1.50', time925: '1.50', byAuctionTrend: true }))
      .toEqual({ guochengJieguo: GUOCHENG_UP, jielun: JIELUN_ACT });
  });

  it('★ 观察=过程但 9:20 缺失 ⇒ null（⛔ 不许退化成「看正负」）', () => {
    expect(deriveGuochengAndJielun({ time920: '', time925: '2.0', byAuctionTrend: true })).toBeNull();
  });

  it('★ 观察=结果走正负分支，不看 9:20', () => {
    // 9:25 < 9:20 但 9:25 > 0 ⇒ 仍是「结果为正 + 出手」
    expect(deriveGuochengAndJielun({ time920: '5.0', time925: '2.0', byAuctionTrend: false }))
      .toEqual({ guochengJieguo: GUOCHENG_POSITIVE, jielun: JIELUN_ACT });
  });
});

describe('jxian-trend × auction-derive 口径自洽', () => {
  it('★ 首次中阳 ⇒ 观察=过程 ⇒ 过程结果只能是递增/递减（不会出现「结果为正」）', () => {
    const g = deriveGuanchaByKxian(S('中阳2.3%', '十字星0.81%'));
    const r = deriveGuochengAndJielun({ time920: '-6.59', time925: '-3.22', byAuctionTrend: g.guancha === GUANCHA_PROCESS });
    expect(g.guancha).toBe(GUANCHA_PROCESS);
    expect([GUOCHENG_UP, GUOCHENG_DOWN]).toContain(r.guochengJieguo);
  });

  it('★ 非首次中阳 ⇒ 观察=结果 ⇒ 过程结果只能是正/负（不会出现「过程递增」）', () => {
    const g = deriveGuanchaByKxian(S('中阳2.3%', '中阳1.8%'));
    const r = deriveGuochengAndJielun({ time920: '-6.59', time925: '-3.22', byAuctionTrend: g.guancha === GUANCHA_PROCESS });
    expect(g.guancha).toBe(GUANCHA_RESULT);
    expect([GUOCHENG_POSITIVE, GUOCHENG_NEGATIVE]).toContain(r.guochengJieguo);
  });
});
