import { describe, it, expect } from 'vitest';
import { getLimitUpPct, parseAucPct, isAuctionYiZi, buildYiZiSet, isStStockName, getCloseLimitState, getCloseNameTone } from './limit-up.js';

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

describe('getCloseLimitState 收盘涨停/跌停判定（2026-09-11 新增）', () => {
  it('主板：+10.02% 涨停 / -9.97% 跌停 / ±9.5% 都不是', () => {
    expect(getCloseLimitState('+10.02%', '600865', '百大集团')).toBe('up');
    expect(getCloseLimitState('-9.97%', '600865', '百大集团')).toBe('down');
    expect(getCloseLimitState('+9.50%', '600865', '百大集团')).toBe(null);
    expect(getCloseLimitState('-9.50%', '600865', '百大集团')).toBe(null);
  });

  it('四舍五入容差：+9.88%（低价股涨停价四舍五入所致）仍判涨停', () => {
    expect(getCloseLimitState('+9.88%', '600000', '某某')).toBe('up');
    expect(getCloseLimitState('-9.88%', '600000', '某某')).toBe('down');
  });

  it('创业板/科创板 20%、北交所 30%、ST 主板 5%', () => {
    expect(getCloseLimitState('+20.00%', '300750', '宁德时代')).toBe('up');
    expect(getCloseLimitState('+10.00%', '300750', '宁德时代')).toBe(null); // 10% 不是创业板涨停
    expect(getCloseLimitState('+30.00%', '830799', '某某')).toBe('up');
    expect(getCloseLimitState('+5.03%', '600000', '*ST某某')).toBe('up');
    expect(getCloseLimitState('-5.03%', '600000', '*ST某某')).toBe('down');
  });

  it('接受 number 入参；0% 与无数据都返回 null（绝不把没数据当停板）', () => {
    expect(getCloseLimitState(10.01, '600000', '某某')).toBe('up');
    expect(getCloseLimitState(0, '600000', '某某')).toBe(null);
    expect(getCloseLimitState('', '600000', '某某')).toBe(null);
    expect(getCloseLimitState(null, '600000', '某某')).toBe(null);
    expect(getCloseLimitState(undefined, '600000', '某某')).toBe(null);
  });

  it('缺代码按主板 10% 兜底', () => {
    expect(getCloseLimitState('+10.00%', '', '某某')).toBe('up');
  });
});

describe('getCloseNameTone 股票名字体颜色档位（2026-09-11 新增）', () => {
  // 闸门就绪 = 题材模式 + 该日已是收盘口径（北京 16:05 起）
  const READY = { byTopic: true, closeWindow: true };

  it('收盘涨幅 > 0 → 红（up）', () => {
    expect(getCloseNameTone(3.21, READY)).toBe('up');
    expect(getCloseNameTone('+0.01%', READY)).toBe('up');
    expect(getCloseNameTone('+10.00%', READY)).toBe('up');
  });

  it('收盘涨幅 < 0 → 绿（down）', () => {
    expect(getCloseNameTone(-2.5, READY)).toBe('down');
    expect(getCloseNameTone('-0.01%', READY)).toBe('down');
    expect(getCloseNameTone('-9.97%', READY)).toBe('down');
  });

  it('平盘（= 0）→ null（保持默认色，不作红/绿）', () => {
    expect(getCloseNameTone(0, READY)).toBe(null);
    expect(getCloseNameTone('0', READY)).toBe(null);
    expect(getCloseNameTone('0.00%', READY)).toBe(null);
    expect(getCloseNameTone('-0', READY)).toBe(null);
  });

  it('无数据 → null（§10：绝不把「没数据」着色）', () => {
    expect(getCloseNameTone(null, READY)).toBe(null);
    expect(getCloseNameTone(undefined, READY)).toBe(null);
    expect(getCloseNameTone('', READY)).toBe(null);
    expect(getCloseNameTone('--', READY)).toBe(null);
    expect(getCloseNameTone(NaN, READY)).toBe(null);
    expect(getCloseNameTone(Infinity, READY)).toBe(null);
  });

  it('与停板判定相互独立：未涨停但上涨仍然上红色', () => {
    // +3% 不是涨停（getCloseLimitState → null），但方向为涨 → 名字要红
    expect(getCloseLimitState('+3.00%', '600000', '某某')).toBe(null);
    expect(getCloseNameTone('+3.00%', READY)).toBe('up');
  });

  it('【核心需求】早盘未到收盘口径 → 一律不上色（change_pct 只是竞价副本）', () => {
    // 竞价阶段哪怕涨幅 +9.9%（看起来是红的），也必须保持默认黑
    expect(getCloseNameTone('+9.90%', { byTopic: true, closeWindow: false })).toBe(null);
    expect(getCloseNameTone('-5.00%', { byTopic: true, closeWindow: false })).toBe(null);
  });

  it('非题材模式 → 不上色（与竞价一字 / 停板蚂蚁线同口径）', () => {
    expect(getCloseNameTone('+3.00%', { byTopic: false, closeWindow: true })).toBe(null);
    expect(getCloseNameTone('-3.00%', {})).toBe(null);
  });

  it('闸门内置：ctx 缺失/不完整 → 安全方向（不上色），绝不拿竞价副本冒充收盘', () => {
    expect(getCloseNameTone('+9.90%')).toBe(null);
    expect(getCloseNameTone('+9.90%', null)).toBe(null);
    expect(getCloseNameTone('+9.90%', { byTopic: true })).toBe(null);
    expect(getCloseNameTone('+9.90%', { closeWindow: true })).toBe(null);
  });
});
