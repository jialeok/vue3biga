import { describe, it, expect } from 'vitest';
import { getLimitUpPct, parseAucPct, isAuctionYiZi, buildYiZiSet, isStStockName } from './limit-up.js';

describe('limit-up 涨停幅度', () => {
  it('主板 10% / ST 5%', () => {
    expect(getLimitUpPct('600371', '万向德农')).toBe(10);
    expect(getLimitUpPct('000001', '平安银行')).toBe(10);
    expect(getLimitUpPct('600371', '*ST某某')).toBe(5);
  });
  it('创业板/科创板 20%（ST 也是 20%）', () => {
    expect(getLimitUpPct('300750', '宁德时代')).toBe(20);
    expect(getLimitUpPct('688111', '金山办公')).toBe(20);
    expect(getLimitUpPct('300750', 'ST某某')).toBe(20);
  });
  it('北交所 30%', () => {
    expect(getLimitUpPct('830799', '某某')).toBe(30);
    expect(getLimitUpPct('920002', '某某')).toBe(30);
  });
  it('缺代码按主板兜底（ST 名走 5%）', () => {
    expect(getLimitUpPct('', '某某')).toBe(10);
    expect(getLimitUpPct(null, 'ST某某')).toBe(5);
  });
  it('ST 名称识别', () => {
    expect(isStStockName('*ST海航')).toBe(true);
    expect(isStStockName('ST中安')).toBe(true);
    expect(isStStockName('中百集团')).toBe(false);
  });
});

describe('parseAucPct', () => {
  it('解析常见写法，解析不出返回 null（不退化成 0）', () => {
    expect(parseAucPct('+10.02%')).toBe(10.02);
    expect(parseAucPct('-7.71%')).toBe(-7.71);
    expect(parseAucPct('10.02')).toBe(10.02);
    expect(parseAucPct('')).toBe(null);
    expect(parseAucPct(null)).toBe(null);
    expect(parseAucPct('-')).toBe(null);
  });
});

describe('isAuctionYiZi 竞价一字判定', () => {
  it('主板 10.02% 判一字，9.5% 不判', () => {
    expect(isAuctionYiZi({ stock: '华脉科技', auc_pct_chg: '+10.02%' }, '603042')).toBe(true);
    expect(isAuctionYiZi({ stock: '中百集团', auc_pct_chg: '+8.44%' }, '000759')).toBe(false);
    expect(isAuctionYiZi({ stock: '亚盛集团', auc_pct_chg: '+9.47%' }, '600108')).toBe(false);
  });
  it('四舍五入容差：9.98% 仍判一字', () => {
    expect(isAuctionYiZi({ stock: '某某', auc_pct_chg: '+9.98%' }, '600000')).toBe(true);
  });
  it('创业板需 20% 才算一字（12% 不算）', () => {
    expect(isAuctionYiZi({ stock: '某某', auc_pct_chg: '+12.00%' }, '300750')).toBe(false);
    expect(isAuctionYiZi({ stock: '某某', auc_pct_chg: '+20.00%' }, '300750')).toBe(true);
  });
  it('ST 主板 5% 即一字', () => {
    expect(isAuctionYiZi({ stock: '*ST某某', auc_pct_chg: '+5.03%' }, '600000')).toBe(true);
  });
  it('无竞价涨幅字段 → false（绝不把没数据当成一字）', () => {
    expect(isAuctionYiZi({ stock: '某某' }, '600000')).toBe(false);
    expect(isAuctionYiZi(null, '600000')).toBe(false);
  });
});

describe('buildYiZiSet', () => {
  it('批量产出名称集合', () => {
    const list = [
      { stock: '甲', auc_pct_chg: '+10.01%', code: '600001' },
      { stock: '乙', auc_pct_chg: '+3.00%', code: '600002' },
      { stock: '丙', auc_pct_chg: '+19.99%', code: '300001' }
    ];
    const set = buildYiZiSet(list);
    expect([...set].sort()).toEqual(['丙', '甲']);
  });
});
