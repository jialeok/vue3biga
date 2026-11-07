// [BIDDING-CLOSE-CLOUD 2026-11-07] 收盘列取值口径：前端 / Worker 共用，锁住口径不分叉
import { describe, it, expect } from 'vitest';
import {
  BIDDING_SECTOR_ETFS,
  BIDDING_BIG_ETFS,
  MAIN_INDEX_THSCODE,
  biddingEtfToSnapshotCode,
  biddingSnapshotCodeGroups,
  normalizeFuyaoSnapshotPct,
  biddingNumOf,
  biddingPctLookup,
  computeBiddingCloseValues,
  resolveBiddingRowTargets
} from './snapshot-spec.js';

describe('bidding snapshot spec · 代码分组', () => {
  it('48 个观察标的里 3 个指数走指数快照，其余走 ETF 快照', () => {
    expect(BIDDING_SECTOR_ETFS).toHaveLength(48);
    const g = biddingSnapshotCodeGroups();
    expect(g.indexCodes).toHaveLength(3);
    expect(g.etfCodes).toHaveLength(45);
    expect(g.allIndexCodes).toContain(MAIN_INDEX_THSCODE);
    expect(g.allIndexCodes).toContain('886078.TI');
    expect(g.allIndexCodes).toContain('885939.TI');
    // 000001.SH 已在 indexCodes 里（来自 1A0001），不能重复
    expect(new Set(g.allIndexCodes).size).toBe(g.allIndexCodes.length);
  });

  it('5 开头 SH / 其余 SZ / 指数走 TI', () => {
    expect(biddingEtfToSnapshotCode('512480')).toEqual({ thscode: '512480.SH', type: 'stock' });
    expect(biddingEtfToSnapshotCode('159995')).toEqual({ thscode: '159995.SZ', type: 'stock' });
    expect(biddingEtfToSnapshotCode('886078')).toEqual({ thscode: '886078.TI', type: 'index' });
    expect(biddingEtfToSnapshotCode('1A0001')).toEqual({ thscode: '000001.SH', type: 'index' });
  });

  it('宽基 ETF 固定 4 只', () => {
    expect(BIDDING_BIG_ETFS).toEqual(['510500', '512100', '510300', '510050']);
  });
});

describe('normalizeFuyaoSnapshotPct / biddingNumOf / biddingPctLookup', () => {
  it('上游把跌幅报成正数时按 price_change 纠符号', () => {
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: 2.31, price_change: -0.5 })).toBe(-2.31);
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: -2.31, price_change: -0.5 })).toBe(-2.31);
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: 1.2, current_price: 9, prev_close: 10 })).toBe(-1.2);
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: 1.2, current_price: 11, prev_close: 10 })).toBe(1.2);
  });

  it('缺字段 / 非数字一律返回 null，不折 0', () => {
    expect(normalizeFuyaoSnapshotPct(null)).toBeNull();
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: null })).toBeNull();
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: '' })).toBeNull();
    expect(normalizeFuyaoSnapshotPct({ price_change_ratio_pct: 'abc' })).toBeNull();
    expect(biddingNumOf(null)).toBeNull();
    expect(biddingNumOf('')).toBeNull();
    expect(biddingNumOf('abc%')).toBeNull();
  });

  it('number 与 \'+1.23%\' 两端口径都认', () => {
    expect(biddingNumOf(1.23)).toBe(1.23);
    expect(biddingNumOf('+1.23%')).toBe(1.23);
    expect(biddingNumOf('-2.50%')).toBe(-2.5);
  });

  it('lookup 兼容带后缀 thscode 与 6 位代码', () => {
    const a = { '600519.SH': 1.5 };
    const b = { '600519': '+1.50%' };
    expect(biddingPctLookup(a, '600519.SH')).toBe(1.5);
    expect(biddingPctLookup(a, '600519')).toBeUndefined();
    expect(biddingPctLookup(b, '600519.SH')).toBe('+1.50%');
    expect(biddingPctLookup(b, '600519')).toBe('+1.50%');
  });
});

describe('computeBiddingCloseValues · 收盘列取值', () => {
  const base = {
    ladderCodes: ['600001.SH', '600002.SH'],
    top10Codes: ['600003.SH', '600004.SH'],
    stockPcts: {
      '600001.SH': 1, '600002.SH': 3, '600003.SH': -1, '600004.SH': 2,
      '512480.SH': 1, '159995.SZ': -2
    },
    etfPcts: {
      '512480.SH': 1, '159995.SZ': -2,
      '510500.SH': 1, '512100.SH': 2, '510300.SH': 3, '510050.SH': 2
    },
    indexPcts: { '000001.SH': 0.35, '886078.TI': 1, '885939.TI': -1 }
  };

  it('五行齐全：最近多板均值 / 大盘ETF均值 / 上证 / 两个上涨家数', () => {
    const v = computeBiddingCloseValues(base);
    expect(v['最近多板%']).toBe('2.00');
    expect(v['大盘ETF']).toBe('2.00');
    expect(v['大盘（%）']).toBe('0.35');
    expect(v['昨日资金前十']).toBe('1');
    expect(Number(v['板块ETF'])).toBeGreaterThanOrEqual(3);
  });

  it('Worker 的 6 位代码 + 带 % 字符串得到完全相同的值（口径不分叉）', () => {
    const worker = computeBiddingCloseValues({
      ladderCodes: ['600001', '600002'],
      top10Codes: ['600003', '600004'],
      stockPcts: {
        '600001': '+1.00%', '600002': '+3.00%', '600003': '-1.00%', '600004': '+2.00%',
        '512480': '+1.00%', '159995': '-2.00%'
      },
      etfPcts: {
        '512480': '+1.00%', '159995': '-2.00%',
        '510500': '+1.00%', '512100': '+2.00%', '510300': '+3.00%', '510050': '+2.00%'
      },
      indexPcts: { '000001.SH': 0.35, '886078.TI': 1, '885939.TI': -1 }
    });
    const front = computeBiddingCloseValues(base);
    expect(worker).toEqual(front);
  });

  it('★ §10 读取失败 ≠ 0：快照全空时一行都不给值，绝不写 0 家 / 0.00%', () => {
    const v = computeBiddingCloseValues({
      ladderCodes: ['600001.SH'], top10Codes: ['600003.SH'],
      stockPcts: {}, etfPcts: {}, indexPcts: {}
    });
    expect(v).toEqual({});
  });

  it('缺失只影响对应行，不给别的行造值', () => {
    const v = computeBiddingCloseValues({
      ladderCodes: ['600001.SH'], top10Codes: [],
      stockPcts: { '600001.SH': -1.5 }, etfPcts: {}, indexPcts: {}
    });
    expect(v).toEqual({ '最近多板%': '-1.50' });
  });

  it('0 家上涨是合法值（有快照但全跌），不能和「没数据」混为一谈', () => {
    const v = computeBiddingCloseValues({
      ladderCodes: [], top10Codes: ['600003.SH'],
      stockPcts: { '600003.SH': -1 }, etfPcts: {}, indexPcts: {}
    });
    expect(v['昨日资金前十']).toBe('0');
  });
});

describe('resolveBiddingRowTargets · 幂等填空', () => {
  const values = {
    '最近多板%': '2.37', '大盘（%）': '0.10', '大盘ETF': '1.20',
    '昨日资金前十': '4', '板块ETF': '37'
  };
  const rows = [
    { name: '最近多板%', close: '' },
    { name: '最近多板%time26', close: '' },
    { name: '大盘（%）', close: null },
    { name: '大盘ETF', close: '' },
    { name: '封单家数', close: '' },
    { name: '昨日资金前十', close: '' },
    { name: '板块ETF(48)', close: '' }
  ];

  it('只挑 close 为空 + values 有值的行；板块ETF(48) 走前缀映射', () => {
    const t = resolveBiddingRowTargets(rows, values);
    expect(t.map(x => x.name)).toEqual([
      '最近多板%', '大盘（%）', '大盘ETF', '昨日资金前十', '板块ETF(48)'
    ]);
    const etf = t.find(x => x.name === '板块ETF(48)');
    expect(etf.close).toBe('37');
    expect(etf.from).toBe('板块ETF');
  });

  it('★ 已有非空 close 一律不覆盖（用户手工修正优先）', () => {
    const locked = rows.map(r => r.name === '最近多板%' ? { ...r, close: '9.99' } : r);
    const t = resolveBiddingRowTargets(locked, values);
    expect(t.some(x => x.name === '最近多板%')).toBe(false);
  });

  it('close 是空白字符串也算空，允许云端补齐', () => {
    const t = resolveBiddingRowTargets([{ name: '最近多板%', close: '   ' }], values);
    expect(t).toEqual([{ name: '最近多板%', close: '2.37', from: '最近多板%' }]);
  });

  it('values 缺某行 ⇒ 该行留空，不造值', () => {
    const t = resolveBiddingRowTargets(rows, { '板块ETF': '12' });
    expect(t).toEqual([{ name: '板块ETF(48)', close: '12', from: '板块ETF' }]);
  });

  it('空 existingRows ⇒ 不造行', () => {
    expect(resolveBiddingRowTargets([], values)).toEqual([]);
  });
});
