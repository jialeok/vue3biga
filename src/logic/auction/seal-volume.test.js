// seal-volume.test.js — 「封单量（手）/ 封单额」换算与展示口径的回归用例
//
// 为什么把它钉死：
//   · limit_pool **没有**「封单量」字段（同花顺上游只给 seal_money / max_seal_money），
//     封单量是**换算**出来的（seal_money ÷ price ÷ 100）。换算口径一错，两个看板的数字全错，
//     而且错得很像真的（量级不对但看着正常）。
//   · 用户 2026-10-11 拍板：早盘竞价看板走【封单量（手）】、决策看板走【封单额】；
//     「变化」= 今日 − 上一交易日，增加红 ↑ / 减少绿 ↓。
//   · §10 红线：非涨停日 / 缺价格 / 缺封单额一律 null，⛔ 绝不用 0 冒充「封单为 0」。
//
// 交易日窗口用 mock（真实 getPreviousTradingDay 依赖交易日历 + 假期表加载，与本用例无关）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** mock 池表：date → { stock: row } */
const poolTable = {};
/** mock 交易日历：date → 上一交易日 */
const prevMap = {};

vi.mock('../../data/limit-pool.js', () => ({
  getLimitPoolRow: (date, stock) => {
    const day = poolTable[date];
    if (!day) return null;
    return day[String(stock)] || null;
  }
}));

vi.mock('../date/trading-day-helpers.js', () => ({
  getPreviousTradingDay: (d) => prevMap[d] || null
}));

import {
  sealLotsOfRow,
  sealLotsOf,
  sealMoneyOf,
  sealRowOf,
  formatSealLots,
  formatSealLotsDelta,
  sealLotsDeltaTone,
  sealLotsDeltaArrowOf,
  sealLotsDelta,
  getSealLotsTrend,
  sealLotsPointsOfHistory,
  sealLotsHasData,
  summarizeSealLots,
  getSealMoneyDelta,
  decorateSealFields,
  SEAL_TREND_DAYS
} from './seal-volume.js';

beforeEach(() => {
  Object.keys(poolTable).forEach((k) => delete poolTable[k]);
  Object.keys(prevMap).forEach((k) => delete prevMap[k]);
});

describe('sealLotsOfRow —— 封单量（手）= 封单额 ÷ 价格 ÷ 100', () => {
  it('正常换算：封单额 68,160,866 元 / 价 55.58 元 ⇒ 12263.56 手', () => {
    const lots = sealLotsOfRow({ sealMoney: 68160866, price: 55.58 });
    expect(lots).toBeCloseTo(68160866 / 55.58 / 100, 6);
    expect(Math.round(lots)).toBe(12264);
  });

  it('缺价格 / 价格 ≤ 0 / 缺封单额 ⇒ null（算不出来，⛔ 不补 0）', () => {
    expect(sealLotsOfRow({ sealMoney: 1e8, price: null })).toBe(null);
    expect(sealLotsOfRow({ sealMoney: 1e8, price: undefined })).toBe(null);
    expect(sealLotsOfRow({ sealMoney: 1e8, price: 0 })).toBe(null);
    expect(sealLotsOfRow({ sealMoney: 1e8, price: -3 })).toBe(null);
    expect(sealLotsOfRow({ sealMoney: null, price: 10 })).toBe(null);
    expect(sealLotsOfRow({ price: 10 })).toBe(null);
  });

  it('空行 / null ⇒ null', () => {
    expect(sealLotsOfRow(null)).toBe(null);
    expect(sealLotsOfRow(undefined)).toBe(null);
    expect(sealLotsOfRow({})).toBe(null);
  });

  it('★ 封单额 0 是「真的没有封单」⇒ 0 手（≠ null）；但 0 手在展示层会被判为无值', () => {
    expect(sealLotsOfRow({ sealMoney: 0, price: 10 })).toBe(0);
  });
});

describe('formatSealLots —— 封单量展示（万手 / 手 自适应）', () => {
  it('≥ 1 万手 → X.XX万手', () => {
    expect(formatSealLots(12264)).toBe('1.23万手');
    expect(formatSealLots(1015000)).toBe('101.50万手');
    expect(formatSealLots(10000)).toBe('1.00万手');
  });

  it('< 1 万手 → 整数手', () => {
    expect(formatSealLots(5133.2)).toBe('5133手');
    expect(formatSealLots(326)).toBe('326手');
  });

  it('无值 / 0 → 空串（⛔ 不显示 "0手"，那会被读成「封单为 0」而非「没有这个数据」）', () => {
    expect(formatSealLots(null)).toBe('');
    expect(formatSealLots(undefined)).toBe('');
    expect(formatSealLots(0)).toBe('');
    expect(formatSealLots('')).toBe('');
    expect(formatSealLots('abc')).toBe('');
  });
});

describe('formatSealLotsDelta —— 封单量变化量（★ 必须带符号；0 是有效结论要显示）', () => {
  it('增加带 +、减少带 -', () => {
    expect(formatSealLotsDelta(10500)).toBe('+1.05万手');
    expect(formatSealLotsDelta(-30000)).toBe('-3.00万手');
    expect(formatSealLotsDelta(30)).toBe('+30手');
    expect(formatSealLotsDelta(-30)).toBe('-30手');
  });

  it('★ 变化量 0 要显式渲染成 0（两日封单一致 = 有效结论，⛔ 不能当成「没数据」返回空串）', () => {
    expect(formatSealLotsDelta(0)).toBe('0');
  });

  it('算不出来（null / 非数）→ 空串（§10 ⛔ 绝不伪造 0）', () => {
    expect(formatSealLotsDelta(null)).toBe('');
    expect(formatSealLotsDelta(undefined)).toBe('');
    expect(formatSealLotsDelta(NaN)).toBe('');
  });

  it('★ 不足 1 万手直接给「手」：避免出现 `+0.00万手`（有变化却显示成 0 的自相矛盾）', () => {
    expect(formatSealLotsDelta(20)).toBe('+20手');
    expect(formatSealLotsDelta(-99)).toBe('-99手');
  });
});

describe('sealLotsDeltaTone / sealLotsDeltaArrowOf —— 增加红 ↑ / 减少绿 ↓（A 股口径）', () => {
  it('> 0 → up ↑；< 0 → down ↓；0 / 无值 → 不涂色、不画箭头', () => {
    expect(sealLotsDeltaTone(100)).toBe('up');
    expect(sealLotsDeltaTone(-100)).toBe('down');
    expect(sealLotsDeltaTone(0)).toBe('');
    expect(sealLotsDeltaTone(null)).toBe('');
    expect(sealLotsDeltaArrowOf(100)).toBe('↑');
    expect(sealLotsDeltaArrowOf(-100)).toBe('↓');
    expect(sealLotsDeltaArrowOf(0)).toBe('');
    expect(sealLotsDeltaArrowOf(null)).toBe('');
  });
});

describe('sealLotsDelta —— 任一天缺值 ⇒ null（§10 不猜）', () => {
  it('两天都有 → 相减；任一天 null → null', () => {
    expect(sealLotsDelta(300, 100)).toBe(200);
    expect(sealLotsDelta(100, 300)).toBe(-200);
    expect(sealLotsDelta(null, 100)).toBe(null);
    expect(sealLotsDelta(100, null)).toBe(null);
    expect(sealLotsDelta(0, 0)).toBe(0);
  });
});

describe('summarizeSealLots —— 题材合计封单量 + 变化（★ 变化只算「连板」）', () => {
  it('合计 = 今日有封单量的股票之和；变化只累加【两天都有】的股票', () => {
    const r = summarizeSealLots([
      { sealLots: 1000, sealLotsPrev: 800 },   // 连板：+200
      { sealLots: 500, sealLotsPrev: 900 },    // 连板：-400
      { sealLots: 700, sealLotsPrev: null },   // 首板：只进合计，不进变化
      { sealLots: null, sealLotsPrev: null }   // 今天没涨停：两边都不进
    ]);
    expect(r.lots).toBe(2200);       // 1000 + 500 + 700
    expect(r.count).toBe(3);
    expect(r.delta).toBe(-200);      // +200 - 400
    expect(r.deltaCount).toBe(2);
  });

  it('★ 一只都没封单量 ⇒ lots=null（布局层整段不产出，⛔ 不显示 0手）', () => {
    const r = summarizeSealLots([{ sealLots: null, sealLotsPrev: 100 }, { sealLots: null }]);
    expect(r.lots).toBe(null);
    expect(r.count).toBe(0);
  });

  it('★ 全是首板（两天都有值的为 0 只）⇒ delta=null（只出合计、不出变化）', () => {
    const r = summarizeSealLots([{ sealLots: 1000, sealLotsPrev: null }]);
    expect(r.lots).toBe(1000);
    expect(r.delta).toBe(null);
    expect(r.deltaCount).toBe(0);
  });

  it('空数组 / 非数组 ⇒ 全是 null', () => {
    expect(summarizeSealLots([]).lots).toBe(null);
    expect(summarizeSealLots(null).lots).toBe(null);
  });
});

describe('sealLotsPointsOfHistory —— 横轴日期只认 history（必须与上面几张图逐日对齐）', () => {
  it('日期逐日取自 history；非涨停日 → null；手数取整', () => {
    poolTable['2026-10-09'] = { 甲: { sealMoney: 68160866, price: 55.58 } };
    poolTable['2026-10-08'] = { 甲: { sealMoney: 1e8, price: 10 } };
    const history = [{ date: '2026-10-01' }, { date: '2026-10-08' }, { date: '2026-10-09' }];
    const pts = sealLotsPointsOfHistory(history, '甲');
    expect(pts.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-08', '2026-10-09']);
    expect(pts[0].value).toBe(null);
    expect(pts[1].value).toBe(100000);   // 1e8 / 10 / 100
    expect(pts[2].value).toBe(12264);    // 取整
  });

  it('没有股票名 / 非数组 ⇒ 空数组', () => {
    expect(sealLotsPointsOfHistory([{ date: '2026-10-09' }], '')).toEqual([]);
    expect(sealLotsPointsOfHistory(null, '甲')).toEqual([]);
  });
});

describe('sealLotsOf / sealMoneyOf / sealRowOf / getSealLotsTrend —— 同步读缓存', () => {
  it('读得到 → 值；缓存里没这一天 → null（§10 缺这一天 ≠ 封单为 0）', () => {
    poolTable['2026-10-09'] = { 甲: { sealMoney: 1e8, price: 10, continueText: '2连板', continueCnt: 2 } };
    expect(sealLotsOf('2026-10-09', '甲')).toBe(100000);
    expect(sealMoneyOf('2026-10-09', '甲')).toBe(1e8);
    expect(sealRowOf('2026-10-09', '甲').continueText).toBe('2连板');
    expect(sealLotsOf('2026-10-07', '甲')).toBe(null);
    expect(sealLotsOf('2026-10-09', '乙')).toBe(null);
    expect(sealMoneyOf('2026-10-07', '甲')).toBe(null);
  });

  it('getSealLotsTrend 正序（早→晚）+ 窗口走交易日历', () => {
    prevMap['2026-10-09'] = '2026-10-08';
    prevMap['2026-10-08'] = '2026-10-07';
    prevMap['2026-10-07'] = null;
    poolTable['2026-10-09'] = { 甲: { sealMoney: 5000, price: 10 } };   // 5000/10/100 = 5 手
    poolTable['2026-10-08'] = { 甲: { sealMoney: 3000, price: 10 } };   // 3 手
    const t = getSealLotsTrend('甲', '2026-10-09', 3);
    expect(t.map((p) => p.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(t.map((p) => p.value)).toEqual([null, 3, 5]);
  });

  it('SEAL_TREND_DAYS 默认 5 天，与早盘竞价其它趋势图同窗口', () => {
    expect(SEAL_TREND_DAYS).toBe(5);
  });
});

describe('sealLotsHasData —— 判定（false ⇒ 整块不渲染，§10 不画满屏「--」）', () => {
  it('有任一有效点 → true；全 null / 非数组 → false', () => {
    expect(sealLotsHasData([{ value: null }, { value: 5 }])).toBe(true);
    expect(sealLotsHasData([{ value: null }, { value: null }])).toBe(false);
    expect(sealLotsHasData([])).toBe(false);
    expect(sealLotsHasData(null)).toBe(false);
    expect(sealLotsHasData({})).toBe(false);
  });
});

describe('getSealMoneyDelta / decorateSealFields —— 决策看板：封单额 + 变化', () => {
  beforeEach(() => {
    prevMap['2026-10-09'] = '2026-10-08';
    poolTable['2026-10-09'] = {
      甲: { sealMoney: 3.2e8, price: 10, maxSealMoney: 4.3e8, continueText: '2连板', continueCnt: 2 },
      丙: { sealMoney: 1.1e8, price: 10, maxSealMoney: 1.3e8, continueText: '首板', continueCnt: 1 }
    };
    poolTable['2026-10-08'] = {
      甲: { sealMoney: 2.1e8, price: 10, continueText: '首板', continueCnt: 1 }
    };
  });

  it('连板：封单额 + 变化 + 箭头 + 连板文案都有值', () => {
    const p = decorateSealFields({ name: '甲' }, '2026-10-09');
    expect(p.sealMoneyText).toBe('3.20亿');
    expect(p.sealDeltaText).toBe('+1.10亿');
    expect(p.sealDeltaTone).toBe('up');
    expect(p.sealDeltaArrow).toBe('↑');
    expect(p.sealMaxMoneyText).toBe('4.30亿');
    expect(p.sealContinueText).toBe('2连板');
    expect(p.sealContinueCnt).toBe(2);
    // ★ 只有【真连板】（≥ 2 连板）才给标签文案（用户口径「方便知道哪些股票是连板」）
    expect(p.sealContinueTag).toBe('2连板');
    expect(p.sealDeltaTitle).toContain('3.20亿');
  });

  it('★ 首板：昨天没有封单额 ⇒ 变化算不出 ⇒ 变化段全空（⛔ 不显示 +1.10亿）', () => {
    const p = decorateSealFields({ name: '丙' }, '2026-10-09');
    expect(p.sealMoneyText).toBe('1.10亿');
    expect(p.sealDeltaText).toBe('');
    expect(p.sealDeltaTone).toBe('');
    expect(p.sealDeltaArrow).toBe('');
    expect(p.sealContinueText).toBe('首板');
    // 首板（cnt = 1）⇒ 不出连板标签（满屏首板没有信息量）
    expect(p.sealContinueTag).toBe('');
  });

  it('★ 当天没涨停（不在 limit_pool）⇒ 一枚徽标都不渲染，且说明写清「不是 0」', () => {
    const p = decorateSealFields({ name: '丁' }, '2026-10-09');
    expect(p.sealMoneyText).toBe('');
    expect(p.sealDeltaText).toBe('');
    expect(p.sealDeltaTone).toBe('');
    expect(p.sealDeltaArrow).toBe('');
    expect(p.sealMaxMoneyText).toBe('');
    expect(p.sealContinueText).toBe('');
    expect(p.sealContinueTag).toBe('');
    expect(p.sealDeltaTitle).toContain('没有封单额数据');
  });

  it('减少 → 绿 + ↓', () => {
    poolTable['2026-10-09'].乙 = { sealMoney: 1e8, price: 10, maxSealMoney: 2e8 };
    poolTable['2026-10-08'].乙 = { sealMoney: 2.5e8, price: 10 };
    const p = decorateSealFields({ name: '乙' }, '2026-10-09');
    expect(p.sealDeltaText).toBe('-1.50亿');
    expect(p.sealDeltaTone).toBe('down');
    expect(p.sealDeltaArrow).toBe('↓');
  });

  it('缺 name / 空对象 ⇒ 原样返回，不挂任何字段', () => {
    const t = { name: '' };
    expect(decorateSealFields(t, '2026-10-09')).toBe(t);
    expect(t.sealMoneyText).toBeUndefined();
    expect(decorateSealFields(null, '2026-10-09')).toBe(null);
  });

  it('getSealMoneyDelta：昨日无封单额 ⇒ null（首板算不出变化）', () => {
    expect(getSealMoneyDelta('甲', '2026-10-09')).toBeCloseTo(1.1e8, 0);
    expect(getSealMoneyDelta('丙', '2026-10-09')).toBe(null);
  });
});
