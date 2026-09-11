import { describe, it, expect } from 'vitest';
import {
  RANGE_WINDOW_DAYS,
  parsePct,
  compoundPct,
  isAuctionLegActive,
  resolveTDayPct,
  replaceTDayLeg,
  buildRangeRows,
  collectDailyLegs
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

// [方案A 2026-09-10] 9:25 worker 用竞价腿把区间涨幅算好落库，收盘后只换 T 腿（0 请求）。
// 该换算直接决定「收盘后龙头排位」，一旦算错会系统性错排，必须有回归用例。
describe('replaceTDayLeg 收盘后替换 T 腿', () => {
  it('同一天九腿不变、只换 T 腿 → 等于用收盘腿重算的复利结果', () => {
    const legs9 = [1.5, -2, 3.2, 0.8, -1.1, 4.0, -0.5, 2.2, 1.0]; // T-9..T-1
    const auc = 6.66;   // 9:25 竞价涨幅（旧 T 腿）
    const close = 10.02; // 收盘涨幅（新 T 腿）
    const oldRange = compoundPct(legs9.concat([auc]));
    const expectNew = compoundPct(legs9.concat([close]));
    const got = replaceTDayLeg(oldRange, auc, close);
    expect(got).toBeCloseTo(expectNew, 6);
  });

  it('旧 T 腿缺失（null/空）时按 0 处理（复利里 (1+0)=1，等价于不含 T 腿）', () => {
    const legs9 = [2, 3, 1];
    const oldRange = compoundPct(legs9); // 只算了 9 天
    const got = replaceTDayLeg(oldRange, null, 5);
    expect(got).toBeCloseTo(compoundPct(legs9.concat([5])), 6);
    expect(replaceTDayLeg(oldRange, '', 5)).toBeCloseTo(compoundPct(legs9.concat([5])), 6);
  });

  it('竞价腿与收盘腿相同（一字板/停牌）→ 结果不变', () => {
    const oldRange = 33.33;
    expect(replaceTDayLeg(oldRange, 9.99, 9.99)).toBeCloseTo(33.33, 6);
  });

  it('新 T 腿取不到 → null（不返回原值，避免调用方误以为校正成功）', () => {
    expect(replaceTDayLeg(12.5, 2.0, null)).toBeNull();
    expect(replaceTDayLeg(12.5, 2.0, '')).toBeNull();
    expect(replaceTDayLeg(null, 2.0, 5)).toBeNull();
  });

  it('支持字符串入参（云端 range_pct 是 text、tag 值是 "+1.23%"）', () => {
    expect(replaceTDayLeg('+20.00', '+5.00%', '0')).toBeCloseTo(
      ((1 + 20 / 100) / (1 + 5 / 100) - 1) * 100, 6
    );
  });
});

describe('buildRangeRows 组装区间涨幅行（worker 早盘/收盘共用）', () => {
  const D = ['2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02',
    '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09'];
  const targets = [{ name: '甲', code: '600001' }, { name: '乙', code: '600002' }];
  // 甲：9 天历史 1% 每日；乙：缺 3 天历史
  const dailyByCode = {
    '600001': Object.fromEntries(D.slice(0, 9).map(d => [d.replace(/-/g, ''), 1])),
    '600002': {
      '20260827': 2, '20260828': 2, '20260831': 2, '20260901': 2,
      '20260902': 2, '20260903': 2
    }
  };

  it('10 天齐全 → 复利累乘，days=10', () => {
    const rows = buildRangeRows(targets, D, dailyByCode, { '600001': 5, '600002': 0 });
    const a = rows.find(r => r.stock === '甲');
    expect(a.days).toBe(10);
    expect(a.pct).toBeCloseTo(compoundPct(new Array(9).fill(1).concat([5])), 6);
  });

  it('历史缺天数 → days 如实反映，不补 0（禁伪造）', () => {
    const rows = buildRangeRows(targets, D, dailyByCode, { '600001': 5, '600002': 0 });
    const b = rows.find(r => r.stock === '乙');
    expect(b.days).toBe(7); // 6 天历史 + 当天 1 天
  });

  it('当天(T)腿缺该股票 → 当天不计入（days 少 1），绝不当作 0%', () => {
    const rows = buildRangeRows(targets, D, dailyByCode, { '600001': 5 });
    const b = rows.find(r => r.stock === '乙');
    expect(b.days).toBe(6); // 只有 6 天历史，当天那根腿缺失 → 不补 0
    expect(b.pct).toBeCloseTo(compoundPct(new Array(6).fill(2)), 6);
  });

  it('一天数据都没有 → 不产出行（不写空行）', () => {
    const rows = buildRangeRows([{ name: '丙', code: '600003' }], D, {}, {});
    expect(rows).toEqual([]);
  });

  it('同名去重 / 缺码跳过', () => {
    const rows = buildRangeRows(
      [{ name: '甲', code: '600001' }, { name: '甲', code: '600001' }, { name: '丁', code: '' }],
      D, dailyByCode, { '600001': 5 }
    );
    expect(rows).toHaveLength(1);
  });

  it('T 腿口径可切换（竞价 3% vs 收盘 6%）→ 只影响最后一个因数', () => {
    const auc = buildRangeRows(targets, D, dailyByCode, { '600001': 3 });
    const close = buildRangeRows(targets, D, dailyByCode, { '600001': 6 });
    const a1 = auc.find(r => r.stock === '甲').pct;
    const c1 = close.find(r => r.stock === '甲').pct;
    expect(a1).not.toBeCloseTo(c1, 6);
    expect(c1).toBeCloseTo(replaceTDayLeg(a1, 3, 6), 6); // 与「换腿」结果一致，两条路径同源
  });

  it('空窗口 / 空名单 → 空数组（不抛错）', () => {
    expect(buildRangeRows(targets, [], dailyByCode, {})).toEqual([]);
    expect(buildRangeRows([], D, dailyByCode, {})).toEqual([]);
    expect(buildRangeRows(null, D, null, null)).toEqual([]);
  });
});

describe('[LOCAL-RECOMPUTE 2026-09-11] collectDailyLegs 按日取腿（本地重算的数据准备）', () => {
  // 升序窗口 [T-9 ... T]
  const D = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
  const T = '2026-09-11';

  /** 造「某日一整行数据」：name -> { change_pct, auc_pct_chg } */
  function mk(rows) {
    const m = new Map();
    Object.keys(rows).forEach(function(n) { m.set(n, rows[n]); });
    return m;
  }
  /** 交易日 -> 当日行索引（模拟内存 getAuctionData()[date]） */
  function mkByDate(perDate) {
    const byDate = new Map();
    D.forEach(function(d) { byDate.set(d, mk(perDate[d] || {})); });
    return byDate;
  }
  // T 腿口径：历史日取收盘，当天取收盘（本用例都是「已收盘」场景）
  const legOf = function(row, d) {
    if (d === T) return resolveTDayPct(false, true, row.change_pct, row.auc_pct_chg);
    return parsePct(row.change_pct);
  };

  it('库里 10 天齐全 → 组装出完整区间涨幅（这就是「存起来了本地就能算」）', () => {
    const perDate = {};
    D.forEach(function(d) { perDate[d] = { 国芳集团: { change_pct: '+10.00%', auc_pct_chg: '+2.00%' } }; });
    const got = collectDailyLegs([{ name: '国芳集团', code: '601086' }], D, mkByDate(perDate), legOf);
    expect(got.targets).toEqual([{ name: '国芳集团', code: '601086' }]);
    expect(Object.keys(got.dailyByCode['601086'])).toHaveLength(9); // 9 个历史日
    expect(got.tLegByCode['601086']).toBe(10);                     // 当天 T 腿单独放
    // 交给「组装成行的唯一实现」→ 10 根腿
    const rows = buildRangeRows(got.targets, D, got.dailyByCode, got.tLegByCode);
    expect(rows).toHaveLength(1);
    expect(rows[0].days).toBe(10);
    expect(rows[0].pct).toBeCloseTo(compoundPct(new Array(10).fill(10)), 6);
  });

  it('某一天库内没有这一行 → days 少 1（残缺但值是真的，绝不补 0）', () => {
    const perDate = {};
    D.forEach(function(d) { perDate[d] = { 百大集团: { change_pct: '+5.00%' } }; });
    delete perDate['2026-08-31']; // 该股当天还没进名单
    const got = collectDailyLegs([{ name: '百大集团', code: '600865' }], D, mkByDate(perDate), legOf);
    const rows = buildRangeRows(got.targets, D, got.dailyByCode, got.tLegByCode);
    expect(rows[0].days).toBe(9);
    expect(rows[0].pct).toBeCloseTo(compoundPct(new Array(9).fill(5)), 6);
  });

  it('T 腿口径交给调用方：同一份数据，竞价腿与收盘腿结果不同', () => {
    const perDate = {};
    D.forEach(function(d) { perDate[d] = { A: { change_pct: '+6.00%', auc_pct_chg: '+2.00%' } }; });
    const byDate = mkByDate(perDate);
    const closeLeg = collectDailyLegs([{ name: 'A', code: '1' }], D, byDate,
      function(row, d) { return d === T ? resolveTDayPct(false, true, row.change_pct, row.auc_pct_chg) : parsePct(row.change_pct); });
    const aucLeg = collectDailyLegs([{ name: 'A', code: '1' }], D, byDate,
      function(row, d) { return d === T ? resolveTDayPct(true, false, row.change_pct, row.auc_pct_chg) : parsePct(row.change_pct); });
    expect(closeLeg.tLegByCode['1']).toBe(6);
    expect(aucLeg.tLegByCode['1']).toBe(2);
  });

  it('缺 code 用「名字键」兜底，不会整只票丢掉', () => {
    const perDate = {};
    D.forEach(function(d) { perDate[d] = { 无码股: { change_pct: '+1.00%' } }; });
    const got = collectDailyLegs([{ name: '无码股' }], D, mkByDate(perDate), legOf);
    expect(got.targets[0].code).toBe('n:无码股');
    const rows = buildRangeRows(got.targets, D, got.dailyByCode, got.tLegByCode);
    expect(rows[0].days).toBe(10);
  });

  it('同名去重 / 该票一天数据都没有 → 不产出行', () => {
    const perDate = {};
    D.forEach(function(d) { perDate[d] = { 有数据: { change_pct: '+1.00%' } }; });
    const got = collectDailyLegs(
      [{ name: '有数据', code: '1' }, { name: '有数据', code: '1' }, { name: '没数据', code: '2' }],
      D, mkByDate(perDate), legOf
    );
    expect(got.targets).toHaveLength(2); // 第二个「有数据」被去重
    const rows = buildRangeRows(got.targets, D, got.dailyByCode, got.tLegByCode);
    expect(rows.map(function(r) { return r.stock; })).toEqual(['有数据']);
  });

  it('空输入 → 空结果（不抛错）', () => {
    const got = collectDailyLegs([], D, new Map(), legOf);
    expect(got.targets).toEqual([]);
    expect(buildRangeRows(got.targets, D, got.dailyByCode, got.tLegByCode)).toEqual([]);
  });
});
