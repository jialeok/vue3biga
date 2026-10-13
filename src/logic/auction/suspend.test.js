import { describe, it, expect, afterEach } from 'vitest';
import {
  toThscode,
  pickSuspendedFromAuctionItems,
  pickSuspendedFromPriceItems,
  decorateSuspendField,
  isSuspended,
  suspendState,
  SUSPEND_TAG_TEXT
} from './suspend.js';

// ===== 真实样本（2026-10-13 盘中 11:15 逐字取自 fuyao 原始返回）=====
// 竞价快照：正常票 15 字段；停牌票只剩 6 字段（缺 auction_price / auction_pct / auction_volume…）
const AUC_NORMAL = {
  thscode: '600519.SH', ticker: '600519', name: '贵州茅台',
  auction_price: 1287, auction_pct: -0.0776, auction_volume: 201,
  auction_amount: 25868700, auction_unmatched: -16.25, auction_turnover_pct: 0.0016,
  auction_yesterday_ratio_pct: 0.637, auction_volume_ratio: 1.1824,
  pre_close_price: 1288, open_price: 1287, last_price: 1277.48,
  float_market_cap: 1596354204477
};
const AUC_SUSPENDED = {
  thscode: '600825.SH', ticker: '600825', name: '新华传媒',
  auction_volume_ratio: 1.621, pre_close_price: 13.78, float_market_cap: 14398554573
};
// 行情快照：正常票有成交；停牌票 volume/turnover 全 0、价格全 null，但 prev_price 有值
const PX_NORMAL = {
  thscode: '600519.SH', ticker: '600519', volume: 1140710, turnover: 1461357700,
  last_price: 1277, price_change: -11, price_change_ratio_pct: -0.854037,
  open_price: 1287, high_price: 1288.48, low_price: 1273.18, prev_price: 1288
};
const PX_SUSPENDED = {
  thscode: '600825.SH', ticker: '600825', volume: 0, turnover: 0,
  last_price: null, price_change: null, price_change_ratio_pct: null,
  open_price: null, high_price: null, low_price: null, prev_price: 13.78
};

describe('suspend · toThscode（绝不把股票名当代码）', () => {
  it('6 位代码补交易所后缀', () => {
    expect(toThscode({ code: '600825' })).toBe('600825.SH');
    expect(toThscode({ code: '000001' })).toBe('000001.SZ');
    expect(toThscode({ code: '300750' })).toBe('300750.SZ');
    expect(toThscode({ code: '920895' })).toBe('920895.BJ');
  });
  it('已带后缀原样返回', () => {
    expect(toThscode({ code: '600825.SH' })).toBe('600825.SH');
    expect(toThscode({ code: '430001.BJ' })).toBe('430001.BJ');
  });
  it('中文股票名 / 空值 → 空串（不参与判定）', () => {
    expect(toThscode({ stock: '新华传媒' })).toBe('');
    expect(toThscode({ stock: '新华传媒', code: '' })).toBe('');
    expect(toThscode({ code: '6008250' })).toBe('');
    expect(toThscode(null)).toBe('');
    expect(toThscode('600825')).toBe('600825.SH');
    expect(toThscode('新华传媒')).toBe('');
  });
});

describe('suspend · 主判据：竞价字段缺席 ⇒ 停牌', () => {
  it('停牌票被挑出，正常票不被挑出', () => {
    const items = [AUC_SUSPENDED, AUC_NORMAL];
    const r = pickSuspendedFromAuctionItems(items, new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(true);
    expect([...r.suspended]).toEqual(['600825.SH']);
  });

  it('auction_pct = null 同样算缺席', () => {
    const r = pickSuspendedFromAuctionItems(
      [{ thscode: '600825.SH', auction_pct: null }, AUC_NORMAL],
      new Set(['600825.SH', '600519.SH'])
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.has('600825.SH')).toBe(true);
  });

  it('全部缺席 ⇒ ok=false（竞价尚未产生，不得据此判停牌）', () => {
    const all = [AUC_SUSPENDED, { thscode: '000016.SZ', name: '*ST康佳A' }];
    const r = pickSuspendedFromAuctionItems(all, new Set(['600825.SH', '000016.SZ']));
    expect(r.ok).toBe(false);
  });

  it('空数组 ⇒ ok=false', () => {
    expect(pickSuspendedFromAuctionItems([], new Set(['600825.SH'])).ok).toBe(false);
    expect(pickSuspendedFromAuctionItems(null, null).ok).toBe(false);
  });

  it('wantSet 过滤：不在关心名单里的票不进结果', () => {
    const r = pickSuspendedFromAuctionItems(
      [AUC_SUSPENDED, AUC_NORMAL],
      new Set(['600519.SH'])       // 只关心茅台
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });
});

describe('suspend · 降级判据：当日零成交 ⇒ 停牌', () => {
  it('零成交量 + 无成交价 ⇒ 停牌；同批有票成交 ⇒ 本腿可用', () => {
    const r = pickSuspendedFromPriceItems([PX_SUSPENDED, PX_NORMAL], new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(true);
    expect([...r.suspended]).toEqual(['600825.SH']);
  });

  it('★ 闸门：整批都没有成交价（尚未开盘）⇒ ok=false，绝不全员误判为停牌', () => {
    const preOpen = [
      { thscode: '600825.SH', volume: 0, turnover: 0, last_price: null },
      { thscode: '600519.SH', volume: 0, turnover: 0, last_price: null }
    ];
    const r = pickSuspendedFromPriceItems(preOpen, new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(false);
    expect(r.suspended.size).toBe(0);
  });

  it('有成交价但成交量为 0 ⇒ 不算停牌（只认「零成交 + 无价」二者同时成立）', () => {
    const r = pickSuspendedFromPriceItems(
      [{ thscode: '600825.SH', volume: 0, turnover: 0, last_price: 13.78 }, PX_NORMAL],
      new Set(['600825.SH', '600519.SH'])
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });

  it('成交量非 0 但有成交价 ⇒ 正常票', () => {
    const r = pickSuspendedFromPriceItems([PX_NORMAL], new Set(['600519.SH']));
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });
});

describe('suspend · 两腿交叉（§10 宁缺勿错）', () => {
  it('2026-10-13 实测：两腿对同一批票结论一致（13 停牌 / 5 正常）', () => {
    const codes = ['600825.SH', '600519.SH', '000001.SZ'];
    const auc = pickSuspendedFromAuctionItems(
      [AUC_SUSPENDED, AUC_NORMAL, { thscode: '000001.SZ', auction_pct: 0 }],
      new Set(codes)
    );
    const px = pickSuspendedFromPriceItems(
      [PX_SUSPENDED, PX_NORMAL, { thscode: '000001.SZ', volume: 3480, turnover: 4082040, last_price: 11.67 }],
      new Set(codes)
    );
    // 取交集 = 两腿都认可才标停牌
    const both = new Set();
    auc.suspended.forEach((t) => { if (px.suspended.has(t)) both.add(t); });
    expect([...both]).toEqual(['600825.SH']);
  });
});

// [BOARD-SUSPEND 2026-10-13 用户口径]「三个选股看板（决策 / 题材量比 / 分笔买卖）都要标停牌」——
// 收口函数 decorateSuspendField 的行为必须钉死：命中给文案、未命中给空串（§10 不显示「未知」占位）。
describe('suspend · decorateSuspendField（三个选股看板的唯一展示收口）', () => {
  const D = '2026-10-13';
  const saved = suspendState.value;
  afterEach(() => { suspendState.value = saved; });

  function arm(date, names) {
    suspendState.value = { date, set: new Set(names), version: 1, loadedAt: Date.now() };
  }

  it('命中 ⇒ 写入「停牌」文案', () => {
    arm(D, ['新华传媒']);
    const row = { name: '新华传媒', code: '600825' };
    expect(decorateSuspendField(row, D)).toBe(row);   // 原地写、返回同一对象
    expect(row.suspendTag).toBe(SUSPEND_TAG_TEXT);
  });

  it('未命中 ⇒ 空串（§10 不渲染占位）', () => {
    arm(D, ['新华传媒']);
    const row = { name: '东方明珠' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('日期不匹配（历史日 / 切日期瞬间）⇒ 空串', () => {
    arm(D, ['新华传媒']);
    const row = { name: '新华传媒' };
    decorateSuspendField(row, '2026-10-12');
    expect(row.suspendTag).toBe('');
  });

  it('集合为空（尚未加载 / 判不出来）⇒ 空串 —— ⛔ 绝不把「判不出来」当「没停牌」也不当「停牌」', () => {
    arm(D, []);
    const row = { name: '新华传媒' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('空行 / 无名字 ⇒ 不抛错、不打标', () => {
    arm(D, ['新华传媒']);
    expect(decorateSuspendField(null, D)).toBe(null);
    const row = {};
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('名字前后空格按 trim 命中（与 isSuspended 同一口径）', () => {
    arm(D, ['新华传媒']);
    expect(isSuspended(D, ' 新华传媒 ')).toBe(true);
    const row = { name: ' 新华传媒 ' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe(SUSPEND_TAG_TEXT);
  });
});
