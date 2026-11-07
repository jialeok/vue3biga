import { describe, it, expect } from 'vitest';
import {
  KXIAN_KIND,
  GUANCHA_PROCESS,
  GUANCHA_RESULT,
  PREFIX_FIRST,
  isBoundaryKind,
  kxianKind,
  buildKxianPrefix,
  formatKxianWithPrefix,
  deriveGuanchaByKxian,
  viewKxianSeries
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

describe('kxian-trend / isBoundaryKind', () => {
  it('★ 十字星与阴线（小阴/中阴/大阴）是临界点', () => {
    expect(isBoundaryKind(KXIAN_KIND.CROSS)).toBe(true);
    expect(isBoundaryKind(KXIAN_KIND.XIAOYIN)).toBe(true);
    expect(isBoundaryKind(KXIAN_KIND.ZHONGYIN)).toBe(true);
    expect(isBoundaryKind(KXIAN_KIND.DAYIN)).toBe(true);
  });

  it('★ 阳线（大阳/中阳/小阳）不是临界点', () => {
    expect(isBoundaryKind(KXIAN_KIND.DAYANG)).toBe(false);
    expect(isBoundaryKind(KXIAN_KIND.ZHONGYANG)).toBe(false);
    expect(isBoundaryKind(KXIAN_KIND.XIAOYANG)).toBe(false);
  });
});

describe('kxian-trend / buildKxianPrefix', () => {
  it('★ 扫到最近的十字星/阴线为止（含它自己）', () => {
    expect(buildKxianPrefix(S('中阳2.5%', '小阳1.2%', '十字星0.5%', '大阳3.9%')))
      .toBe('十字星0.5%+小阳1.2%');
    expect(buildKxianPrefix(S('中阳2.5%', '小阴-1.6%', '小阳1.2%')))
      .toBe('小阴-1.6%');
  });

  it('★ 找不到临界点时最多取 KXIAN_PREFIX_MAX_DAYS(3) 天（按时间正序）', () => {
    expect(buildKxianPrefix(S('中阳2.5%', '中阳1.8%', '中阳1.2%', '中阳1.1%', '中阳1.0%')))
      .toBe('中阳1.1%+中阳1.2%+中阳1.8%');
  });

  it('★ 遇数据缺口立即停，⛔ 不跨过空格继续拼（§10）', () => {
    expect(buildKxianPrefix(S('中阳2.5%', '', '小阳1.2%'))).toBe('');
  });

  it('★ 序列只有 1 项 ⇒ 空串', () => {
    expect(buildKxianPrefix(S('中阳2.5%'))).toBe('');
    expect(buildKxianPrefix(null)).toBe('');
  });
});

describe('kxian-trend / formatKxianWithPrefix', () => {
  it('★ 「第一次」⇒ 第一次中阳 2.5%（标记词，不重复 K 线名）', () => {
    expect(formatKxianWithPrefix('第一次', '中阳2.5%')).toBe('第一次中阳 2.5%');
  });

  it('★ 序列前缀 ⇒ 用 + 连接，三天一起', () => {
    expect(formatKxianWithPrefix('十字星0.5%+小阳1.2%', '中阳2.5%'))
      .toBe('十字星0.5%+小阳1.2%+中阳2.5%');
  });

  it('★ 无前缀 ⇒ 原样返回', () => {
    expect(formatKxianWithPrefix('', '中阳2.5%')).toBe('中阳2.5%');
    expect(formatKxianWithPrefix(null, '小阴-1.87%')).toBe('小阴-1.87%');
  });

  it('★ 旧数据前缀写着「第一次中阳」也要去重，⛔ 不许出现「第一次中阳+中阳2.3%」', () => {
    expect(formatKxianWithPrefix('第一次中阳', '中阳2.3%')).toBe('第一次中阳 2.3%');
    expect(formatKxianWithPrefix('第一次中阳', '中阳2.3%')).not.toContain('第一次中阳+');
  });

  it('★ 只有本体没有类型词时兜住不拼出空格', () => {
    expect(formatKxianWithPrefix('第一次', '普涨')).toBe('第一次普涨');
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

  it('★ 中阳·第一次 ⇒ 过程，前缀写「第一次」（前一日是十字星）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '十字星0.81%', '小阳1.9%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次');
    expect(r.kxianPrefix).toBe(PREFIX_FIRST);
    expect(r.isFirstZhongyang).toBe(true);
  });

  it('★ 中阳·第一次（前一日是阴线）也算第一次', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '小阴-1.6%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次');
  });

  it('★ 中阳·第二次 ⇒ 结果，前缀给出 K 线序列（原话：第二次中阳看结果）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '中阳1.8%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
    expect(r.kxianPrefix).toBe('十字星0.5%+中阳1.8%');
    expect(r.isFirstZhongyang).toBe(false);
  });

  it('★ 中阳·第 3 次及以上 ⇒ 结果（原话：前面两次以上都是结果）', () => {
    const r = deriveGuanchaByKxian(S('中阳2.3%', '中阳1.8%', '中阳1.2%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
  });

  it('★ 十字星是临界点：中间隔了十字星，更早的中阳不参与 ⇒ 重新算第一次', () => {
    // 中阳 → 十字星 → 中阳 → 中阳：今天这个中阳仍是「第一次」
    const r = deriveGuanchaByKxian(S('中阳2.3%', '十字星0.1%', '中阳1.8%', '中阳1.5%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);
    expect(r.kxianPrefix).toBe('第一次');
  });

  it('★★ 十字星+小阳+中阳 ⇒ 看结果，前缀写「十字星0.5%+小阳1.2%」（用户点名的反例）', () => {
    // 用户原话：「比如前面两天是十字星+小阳，今天的昨多板k线是中阳，那就看结果，
    //            相当于十字星+小阳+中阳，前缀应该写，十字星0.5%+小阳1.2%」
    const r = deriveGuanchaByKxian(S('中阳2.5%', '小阳1.2%', '十字星0.5%', '大阴-4.0%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);          // ⛔ 不是过程！昨天是小阳不是第一次
    expect(r.kxianPrefix).toBe('十字星0.5%+小阳1.2%');
    expect(r.isFirstZhongyang).toBe(false);
    // 拼出来的最终文案：三天一起、无重复
    expect(formatKxianWithPrefix(r.kxianPrefix, '中阳2.5%'))
      .toBe('十字星0.5%+小阳1.2%+中阳2.5%');
  });

  it('★ 小阳：前面不足 2 根 ⇒ 过程（原话：小阳看过程）', () => {
    expect(deriveGuanchaByKxian(S('小阳1.9%', '十字星0.5%')).guancha).toBe(GUANCHA_PROCESS);
    expect(deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '十字星0.5%')).guancha).toBe(GUANCHA_PROCESS);
  });

  it('★ 小阳：前面已有 2 根 ⇒ 结果（原话：但是前面有两根小阳，看结果）', () => {
    const r = deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '小阳1.1%', '十字星0.5%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
    expect(r.kxianPrefix).toBe('十字星0.5%+小阳1.1%+小阳1.2%');
  });

  it('★ 小阳前面被十字星打断 ⇒ 重新从 0 数', () => {
    const r = deriveGuanchaByKxian(S('小阳1.9%', '小阳1.2%', '十字星0.1%', '小阳1.1%', '小阳1.0%'));
    expect(r.guancha).toBe(GUANCHA_PROCESS);   // 十字星之后只有 1 根
  });

  it('★ 中阳/小阳 但上个交易日数据缺失 ⇒ null，⛔ 不猜过程还是结果（§10）', () => {
    expect(deriveGuanchaByKxian(S('中阳2.3%', '', '中阳1.8%'))).toBeNull();
    expect(deriveGuanchaByKxian(S('中阳2.3%'))).toBeNull();
    expect(deriveGuanchaByKxian(S('小阳1.9%'))).toBeNull();
  });

  it('★ 序列为空 / 首项认不出 ⇒ null（前台保持 "-"，⛔ 不猜）', () => {
    expect(deriveGuanchaByKxian([])).toBeNull();
    expect(deriveGuanchaByKxian(null)).toBeNull();
    expect(deriveGuanchaByKxian(S('', '中阳2.3%'))).toBeNull();
    expect(deriveGuanchaByKxian(S('普涨', '中阳2.3%'))).toBeNull();
  });

  it('★★ 所有 K 线类型都要带序列前缀（用户：三天的都填好，前面一个格子填前面两天的）', () => {
    // 阴线 / 十字星 / 大阳 / 小阳 一律带前缀，不再只有「中阳·非首次」才带
    expect(deriveGuanchaByKxian(S('小阴-1.87%', '小阳1.9%', '十字星-0.3%')).kxianPrefix)
      .toBe('十字星-0.3%+小阳1.9%');
    expect(deriveGuanchaByKxian(S('十字星0.81%', '中阳2.3%', '小阳1.2%')).kxianPrefix)
      .toBe('小阳1.2%+中阳2.3%');
    expect(deriveGuanchaByKxian(S('大阳5.2%', '小阳1.9%', '十字星0.5%')).kxianPrefix)
      .toBe('十字星0.5%+小阳1.9%');
    expect(deriveGuanchaByKxian(S('小阳1.9%', '十字星-0.3%')).kxianPrefix)
      .toBe('十字星-0.3%');
  });

  it('★★ 前缀格 + K 线格 = 三天一起，且不重复', () => {
    const r = deriveGuanchaByKxian(S('小阴-1.87%', '小阳1.9%', '十字星-0.3%', '小阴-2.18%'));
    expect(formatKxianWithPrefix(r.kxianPrefix, '小阴-1.87%'))
      .toBe('十字星-0.3%+小阳1.9%+小阴-1.87%');
  });

  it('★ 序列只有当前一天 ⇒ 前缀为空（没有前面几天可继承）', () => {
    const r = deriveGuanchaByKxian(S('小阴-1.87%'));
    expect(r.guancha).toBe(GUANCHA_RESULT);
    expect(r.kxianPrefix).toBe('');
    expect(formatKxianWithPrefix(r.kxianPrefix, '小阴-1.87%')).toBe('小阴-1.87%');
  });

  it('★ 前缀遇数据缺口立即停，⛔ 不跨过空格继续拼', () => {
    const r = deriveGuanchaByKxian(S('小阴-1.87%', '', '十字星-0.3%'));
    expect(r.kxianPrefix).toBe('');
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

// [KXIAN-GAP 2026-11-07] 生产事故回归锁：
//   11-05 看板「昨多板K线」只显示 '-'，用户以为是「昨日跌涨 1:6 没识别出来」。
//   真因：bidding_data['2026-11-04']['最近多板%'].close 整天为空 ⇒ series[0] 空 ⇒
//   deriveGuanchaByKxian 整体 null ⇒ 连 series[1]/[2] 里本来就有的 K 线也一起被吞。
describe('kxian-trend / viewKxianSeries [KXIAN-GAP]', () => {
  it('★ 正常三天：与 deriveGuanchaByKxian 完全一致，不带缺口', () => {
    const s = S('中阳2.5%', '小阳1.2%', '十字星0.5%');
    const g = deriveGuanchaByKxian(s);
    const v = viewKxianSeries(s);
    expect(v.kxian).toBe('中阳2.5%');
    expect(v.kxianPrefix).toBe(g.kxianPrefix);
    expect(v.kxianPrefix).toBe('十字星0.5%+小阳1.2%');
    expect(v.guancha).toBe(GUANCHA_RESULT);
    expect(v.missingDates).toEqual([]);
    expect(v.gapNote).toBe('');
  });

  it('★ 首次中阳：前缀仍是「第一次」，⛔ 不能被 buildKxianPrefix 覆盖', () => {
    const v = viewKxianSeries(S('中阳2.3%', '十字星0.81%', '小阳1.9%'));
    expect(v.kxianPrefix).toBe(PREFIX_FIRST);
    expect(v.guancha).toBe(GUANCHA_PROCESS);
    expect(v.isFirstZhongyang).toBe(true);
  });

  it('★ 11-05 真实数据形状：本体(11-04)缺失 ⇒ 观察留空，但前序序列不丢且点名日期', () => {
    const series = [
      { ymd: '2026-11-04', label: '' },
      { ymd: '2026-11-03', label: '十字星-0.77%' },
      { ymd: '2026-11-02', label: '小阳1.88%' },
      { ymd: '2026-10-30', label: '中阴-3.71%' }
    ];
    const v = viewKxianSeries(series);
    // 观察该空就空（⛔ 不拿缺失冒充真值）
    expect(v.kxian).toBe('');
    expect(v.guancha).toBe('');
    // 11-03 十字星是临界点，扫到即停（含它自己）⇒ 前缀只有这一段
    expect(v.kxianPrefix).toBe('十字星-0.77%');
    expect(v.missingDates).toEqual(['2026-11-04']);
    expect(v.gapNote).toContain('2026-11-04');
    expect(v.gapNote).toContain('收盘涨幅');
  });

  it('★ 中阳本体在、但上个交易日缺失 ⇒ 不判「第几次」，点名再前一交易日', () => {
    const series = [
      { ymd: '2026-11-04', label: '中阳2.8%' },
      { ymd: '2026-11-03', label: '' }
    ];
    const v = viewKxianSeries(series);
    expect(v.kxian).toBe('中阳2.8%');
    expect(v.guancha).toBe('');
    expect(v.missingDates).toEqual(['2026-11-03']);
    expect(v.gapNote).toContain('无法判断第几次');
    expect(v.kxianPrefix).toBe('');
  });

  it('空序列 ⇒ 全空 + 点名「前一交易日」，⛔ 不抛错、不造标签', () => {
    const v = viewKxianSeries([]);
    expect(v.kxian).toBe('');
    expect(v.kxianPrefix).toBe('');
    expect(v.guancha).toBe('');
    expect(v.missingDates).toEqual(['前一交易日']);
  });

  it('★ 本体缺失时前缀仍可交给前台：formatKxianWithPrefix 不会吞掉它', () => {
    const v = viewKxianSeries([
      { ymd: '2026-11-04', label: '' },
      { ymd: '2026-11-03', label: '十字星-0.77%' }
    ]);
    // UI 分支：k 为空 ⇒ 直接显示 p，不能再 return '-'
    expect(formatKxianWithPrefix(v.kxianPrefix, '')).toBe('十字星-0.77%');
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
