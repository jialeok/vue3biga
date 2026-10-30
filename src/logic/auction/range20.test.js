// range20.test.js — 「20日涨幅」口径单测（§15 纯函数优先，§42 验收清单）
//
// 覆盖用户 2026-10-19 明确的硬口径：
//   ① 窗口含今天、共 20 个交易日；
//   ② 复利累乘（不是简单相加）；
//   ③ T 腿：盘中 ⇒ 竞价涨幅；收盘后 / 历史日 ⇒ 收盘涨幅（随 15:00 换腿，见文末 R20-TSWITCH）。
// 外加 §10 的两条红线：缺数据不补 0、腿不全时如实给 days。

import { describe, it, expect } from 'vitest';
import {
  RANGE20_WINDOW_DAYS,
  RANGE20_PROBE_DAYS,
  pickRealWindowDates,
  resolveT20Leg,
  resolveT20LegMode,
  isAfterCloseOf,
  closeLegOf,
  legs20FromRows,
  legs20FromDaily,
  mergeBaseLegs,
  needsKlineLegs,
  isLegTableStale,
  countMissingRange20,
  dailyRowsFromKline,
  merge20Legs,
  compound20
} from './range20.js';

/** 20 个连续「交易日」（这里只当日期键用，不需要真日历） */
function mkDates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 8, 1) + i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** 日期 -> (股票名 -> 行) */
function mkRowsByDate(perDate) {
  const m = new Map();
  Object.keys(perDate).forEach(function(d) {
    const inner = new Map();
    Object.keys(perDate[d]).forEach(function(name) { inner.set(name, perDate[d][name]); });
    m.set(d, inner);
  });
  return m;
}

describe('RANGE20_WINDOW_DAYS', () => {
  it('窗口长度 = 20（含今天，用户口径）', () => {
    expect(RANGE20_WINDOW_DAYS).toBe(20);
  });
});

describe('T 腿口径（resolveT20Leg）', () => {
  it('★ 今天 ⇒ 用竞价涨幅，⛔ 不是收盘涨幅（用户原话「记住用今天的竞价涨幅」）', () => {
    const row = { auc_pct_chg: '3.50', changePct: '-1.20' };
    expect(resolveT20Leg(row, true)).toBe(3.5);
  });

  it('★ 今天但竞价涨幅缺失 ⇒ 退回收盘涨幅（§10 缺失才退，不补 0）', () => {
    const row = { auc_pct_chg: '', changePct: '-1.20' };
    expect(resolveT20Leg(row, true)).toBe(-1.2);
  });

  it('★ 今天且竞价涨幅真的是 0% ⇒ 就是 0（0 是合法涨幅，⛔ 不能因为 falsy 就退回收盘）', () => {
    const row = { auc_pct_chg: '0', changePct: '5.00' };
    expect(resolveT20Leg(row, true)).toBe(0);
  });

  it('历史日 ⇒ 收盘涨幅优先（用户口径「昨天的或者历史的算到收盘」）', () => {
    const row = { auc_pct_chg: '3.50', changePct: '-1.20' };
    expect(resolveT20Leg(row, false)).toBe(-1.2);
  });

  it('历史日缺收盘涨幅 ⇒ 退回竞价涨幅；两者都没有 ⇒ null', () => {
    expect(resolveT20Leg({ changePct: '', auc_pct_chg: '2.00' }, false)).toBe(2);
    expect(resolveT20Leg({}, false)).toBe(null);
    expect(resolveT20Leg(null, true)).toBe(null);
  });

  it('closeLegOf 兼容 snake_case / camelCase / 带 % 的字符串', () => {
    expect(closeLegOf({ change_pct: '+2.34%' })).toBe(2.34);
    expect(closeLegOf({ changePct: -7.71 })).toBe(-7.71);
    expect(closeLegOf({ changePct: '' })).toBe(null);
  });
});

// 🔴 [R20-TSWITCH 2026-10-19] 用户第二次反馈的口径：T 腿要【随 15:00 换腿】。
//   原话：「第20天也就是当天，早上开盘我看到前面19天加今天竞价涨幅……收盘后这二十天全部是
//   收盘涨幅计算20天涨幅，这样就和炒股软件对得上。这个就和那个趋势图覆盖类似。」
//   实测依据（同花顺日线复算 4 只票的 20 天全收盘，与用户炒股软件【逐项差 0.00】）：
//     新华传媒 210.98% / 新华文轩 116.68% / 澳弘电子 117.38% / 九阳股份 91.89%
describe('T 腿随 15:00 换腿（R20-TSWITCH）', () => {
  it('resolveT20LegMode：今天 + 未收盘 ⇒ auc；今天 + 已收盘 ⇒ close；历史日 ⇒ close', () => {
    expect(resolveT20LegMode(true, false)).toBe('auc');
    expect(resolveT20LegMode(true, true)).toBe('close');
    expect(resolveT20LegMode(false, false)).toBe('close');
    expect(resolveT20LegMode(false, true)).toBe('close');
  });

  it('isAfterCloseOf：判尺 = 当日北京 15:00（可注入 now）', () => {
    const closeMs = Date.parse('2026-10-19T07:00:00Z');       // 北京 15:00
    expect(isAfterCloseOf('2026-10-19', closeMs - 1)).toBe(false);
    expect(isAfterCloseOf('2026-10-19', closeMs)).toBe(true);
    expect(isAfterCloseOf('2026-10-19', closeMs + 60000)).toBe(true);
  });

  it('isAfterCloseOf：日期非法 ⇒ false（§10 不猜，退回早上竞价口径 = 主用途）', () => {
    expect(isAfterCloseOf('', 0)).toBe(false);
    expect(isAfterCloseOf('2026/10/19', 0)).toBe(false);
    expect(isAfterCloseOf(null, 0)).toBe(false);
  });

  it('★ 收盘后 T 腿必须切到收盘涨幅（否则永远对不上炒股软件）', () => {
    const row = { auc_pct_chg: '2.75', changePct: '10.00' };
    expect(resolveT20Leg(row, true, false)).toBe(2.75);       // 盘中：竞价
    expect(resolveT20Leg(row, true, true)).toBe(10);          // 收盘后：收盘
    // 未传 afterClose ⇒ 保守按竞价（向后兼容，早盘是主用途）
    expect(resolveT20Leg(row, true)).toBe(2.75);
  });

  it('收盘后收盘涨幅缺失 ⇒ 退回竞价涨幅（§10 缺失才退，不补 0）', () => {
    expect(resolveT20Leg({ changePct: '', auc_pct_chg: '2.75' }, true, true)).toBe(2.75);
  });

  it('legs20FromRows 把 afterClose 透传给 T 腿', () => {
    const dates = mkDates(20);
    const tDate = dates[19];
    const rowsByDate = mkRowsByDate({
      [tDate]: { '甲': { auc_pct_chg: '2.75', changePct: '10.00' } }
    });
    const intraday = legs20FromRows([{ stock: '甲' }], dates, rowsByDate, { tIsToday: true });
    const closed = legs20FromRows([{ stock: '甲' }], dates, rowsByDate, { tIsToday: true, afterClose: true });
    expect(intraday.get('甲').get(tDate)).toBe(2.75);
    expect(closed.get('甲').get(tDate)).toBe(10);
  });

  it('★ merge20Legs tKeepAuctionLeg:false ⇒ K 线的今日收盘【覆盖】竞价腿', () => {
    const dates = mkDates(20);
    const tDate = dates[19];
    const tYmd = tDate.replace(/-/g, '');
    const baseLegs = new Map([['甲', new Map([[tDate, 2.75]])]]);
    const extra = new Map([['甲', new Map([[tYmd, 10]])]]);

    // 盘中：保护 T 腿（竞价口径不许被"今天盘中价"顶掉）
    const keep = merge20Legs(baseLegs, extra, dates, { tDate: tDate, tKeepAuctionLeg: true });
    expect(keep.get('甲').get(tDate)).toBe(2.75);

    // 收盘后：让 K 线覆盖（用户口径「这二十天全部是收盘涨幅」）
    const covered = merge20Legs(baseLegs, extra, dates, { tDate: tDate, tKeepAuctionLeg: false });
    expect(covered.get('甲').get(tDate)).toBe(10);
  });

  it('merge20Legs 不传 tKeepAuctionLeg 时保持旧语义（保护 T 腿）', () => {
    const dates = mkDates(20);
    const tDate = dates[19];
    const baseLegs = new Map([['甲', new Map([[tDate, 2.75]])]]);
    const extra = new Map([['甲', new Map([[tDate.replace(/-/g, ''), 10]])]]);
    expect(merge20Legs(baseLegs, extra, dates, { tDate: tDate }).get('甲').get(tDate)).toBe(2.75);
  });
});

describe('legs20FromRows：逐日抽腿', () => {
  const dates = mkDates(20);
  // ⚠️ 本组用例验证的是「从逐日行里怎么抽腿」这个纯函数逻辑本身。
  //   最终数据链路里历史日【不采用】库内值（见下方 R20-CLOSE-LEG 的用例），
  //   所以要考察抽腿逻辑必须显式打开 useDbLegsForHistory。

  it('★ 满窗口：20 天全有 ⇒ 20 根腿，且 T 腿来自竞价涨幅', () => {
    const perDate = {};
    dates.forEach(function(d) { perDate[d] = { 甲: { changePct: '1.00' } }; });
    // 最后一天（T）收盘与竞价不同 ⇒ 必须取竞价
    perDate[dates[19]] = { 甲: { changePct: '-5.00', auc_pct_chg: '2.00' } };
    const legs = legs20FromRows([{ stock: '甲' }], dates, mkRowsByDate(perDate), { tIsToday: true, useDbLegsForHistory: true });
    expect(legs.get('甲').size).toBe(20);
    expect(legs.get('甲').get(dates[19])).toBe(2);
    expect(legs.get('甲').get(dates[18])).toBe(1);
  });

  it('★ 停牌三天（那三天没有行）⇒ 只有 17 根腿，⛔ 不补 0（数值上等价于 0%，靠 days 如实体现）', () => {
    const perDate = {};
    dates.forEach(function(d, i) {
      if (i >= 5 && i <= 7) return;                 // 中间停 3 天
      perDate[d] = { 新华传媒: { changePct: '0.50' } };
    });
    const legs = legs20FromRows([{ stock: '新华传媒' }], dates, mkRowsByDate(perDate), { tIsToday: false, useDbLegsForHistory: true });
    expect(legs.get('新华传媒').size).toBe(17);
    expect(legs.get('新华传媒').has(dates[5])).toBe(false);
  });

  it('§10：某行涨幅字段缺失 ⇒ 这根腿不放进去（不是 0%）', () => {
    const perDate = {};
    dates.forEach(function(d) { perDate[d] = { 乙: { changePct: '1.00' } }; });
    perDate[dates[3]] = { 乙: { changePct: '' } };
    const legs = legs20FromRows([{ stock: '乙' }], dates, mkRowsByDate(perDate), { tIsToday: false, useDbLegsForHistory: true });
    expect(legs.get('乙').size).toBe(19);
  });

  it('🔴 R20-CLOSE-LEG：默认 ⛔ 不采用库内历史值（库内可能是竞价涨幅 / 缺行）', () => {
    const perDate = {};
    dates.forEach(function(d) { perDate[d] = { 甲: { changePct: '1.00' } }; });
    perDate[dates[19]] = { 甲: { changePct: '-5.00', auc_pct_chg: '2.00' } };
    const legs = legs20FromRows([{ stock: '甲' }], dates, mkRowsByDate(perDate), { tIsToday: true });
    // 只剩 T 腿（竞价涨幅）；历史 19 天一律不取库内值，等 K 线补
    expect(legs.get('甲').size).toBe(1);
    expect(legs.get('甲').get(dates[19])).toBe(2);
  });

  it('一只票 20 天全无行 ⇒ 不出现在结果里（调用方据此不显示数值）', () => {
    const perDate = {};
    dates.forEach(function(d) { perDate[d] = { 甲: { changePct: '1.00' } }; });
    const legs = legs20FromRows([{ stock: '丙' }], dates, mkRowsByDate(perDate), { tIsToday: false, useDbLegsForHistory: true });
    expect(legs.has('丙')).toBe(false);
  });

  it('目标清单按股票名去重（同名多行只算一次）', () => {
    const perDate = {};
    dates.forEach(function(d) { perDate[d] = { 甲: { changePct: '1.00' } }; });
    const legs = legs20FromRows([{ stock: '甲' }, { stock: ' 甲 ' }], dates, mkRowsByDate(perDate), { tIsToday: false, useDbLegsForHistory: true });
    expect(legs.size).toBe(1);
  });
});

describe('merge20Legs：历史日由 K 线覆盖（R20-CLOSE-LEG）', () => {
  const dates = mkDates(3);

  it('★ 库内值被 K 线【覆盖】（库内可能是早盘写入的竞价涨幅）', () => {
    const base = new Map([['甲', new Map([[dates[0], 10]])]]);
    const extra = new Map([['甲', new Map([[dates[0].replace(/-/g, ''), 99], [dates[1].replace(/-/g, ''), 5]])]]);
    const out = merge20Legs(base, extra, dates);
    expect(out.get('甲').get(dates[0])).toBe(99);   // ★ 被 K 线真收盘覆盖（旧口径是保留 10）
    expect(out.get('甲').get(dates[1])).toBe(5);    // 库内缺的那天也补上
  });

  it('🔴 T 日（今天）的腿 ⛔ 不被 K 线覆盖（今天要竞价涨幅）', () => {
    const t = dates[2];
    const base = new Map([['甲', new Map([[dates[0], 10], [t, 2.75]])]]);   // t 日 = 竞价涨幅
    const extra = new Map([['甲', new Map([[dates[0].replace(/-/g, ''), 99], [t.replace(/-/g, ''), 10.0]])]]);
    const out = merge20Legs(base, extra, dates, { tDate: t });
    expect(out.get('甲').get(t)).toBe(2.75);        // ★ 保住竞价涨幅，没被 K 线的 10.00 盖掉
    expect(out.get('甲').get(dates[0])).toBe(99);   // 历史日照样被覆盖
  });

  it('不传 opts 时视为「无 T 日例外」（历史日全覆盖）', () => {
    const base = new Map([['甲', new Map([[dates[2], 7]])]]);
    const extra = new Map([['甲', new Map([[dates[2].replace(/-/g, ''), 42]])]]);
    const out = merge20Legs(base, extra, dates);
    expect(out.get('甲').get(dates[2])).toBe(42);
  });

  it('K 线缺该日 ⇒ 保留库内值（有总比没有好，days 如实记）', () => {
    const base = new Map([['甲', new Map([[dates[1], 6]])]]);
    const extra = new Map([['甲', new Map([[dates[0].replace(/-/g, ''), 1]])]]);
    const out = merge20Legs(base, extra, dates);
    expect(out.get('甲').get(dates[1])).toBe(6);
  });

  it('不修改入参（纯函数）', () => {
    const base = new Map([['甲', new Map([[dates[0], 10]])]]);
    const extra = new Map([['甲', new Map([[dates[1].replace(/-/g, ''), 5]])]]);
    merge20Legs(base, extra, dates);
    expect(base.get('甲').size).toBe(1);
  });

  it('补算里多出来的窗口外日期被忽略（由 compound20 的 window 过滤兜底）', () => {
    const base = new Map();
    const extra = new Map([['甲', new Map([['19990101', 50], [dates[2].replace(/-/g, ''), 3]])]]);
    const out = merge20Legs(base, extra, dates);
    const rows = compound20(out, dates);
    expect(rows.length).toBe(1);
    expect(rows[0].days).toBe(1);
  });
});

describe('compound20：复利口径（★ 不是简单相加）', () => {
  const dates = mkDates(2);

  it('★ 两天各 +10% ⇒ +21%（复利），不是 +20%', () => {
    const legs = new Map([['甲', new Map([[dates[0], 10], [dates[1], 10]])]]);
    const rows = compound20(legs, dates);
    expect(rows).toHaveLength(1);
    expect(rows[0].pct).toBeCloseTo(21, 6);
    expect(rows[0].days).toBe(2);
  });

  it('★ 停牌日按 0% 计入 ⇒ 与「跳过该日」数值完全一致（乘 1 是恒等变换）', () => {
    const dates3 = mkDates(3);
    const withGap = new Map([['甲', new Map([[dates3[0], 10], [dates3[2], 10]])]]);      // 中间停 1 天
    const noGap = new Map([['甲', new Map([[dates3[0], 10], [dates3[1], 0], [dates3[2], 10]])]]); // 显式 0%
    const a = compound20(withGap, dates3)[0];
    const b = compound20(noGap, dates3)[0];
    expect(a.pct).toBeCloseTo(b.pct, 9);
    expect(a.days).toBe(2);   // 腿数如实少 1（行上显示 n/20日）
    expect(b.days).toBe(3);
  });

  it('一根腿都没有 ⇒ 不产出该行（⛔ 不伪造 0%）', () => {
    expect(compound20(new Map([['甲', new Map()]]), dates)).toEqual([]);
    expect(compound20(new Map(), dates)).toEqual([]);
  });

  it('窗口外的腿不参与累乘', () => {
    const legs = new Map([['甲', new Map([['1999-01-01', 100], [dates[0], 10]])]]);
    const rows = compound20(legs, dates);
    expect(rows[0].pct).toBeCloseTo(10, 6);
    expect(rows[0].days).toBe(1);
  });

  it('多只票各自独立（互不影响）', () => {
    const legs = new Map([
      ['甲', new Map([[dates[0], 50]])],
      ['乙', new Map([[dates[0], -10]])]
    ]);
    const rows = compound20(legs, dates);
    const by = new Map(rows.map(function(r) { return [r.stock, r.pct]; }));
    expect(by.get('甲')).toBeCloseTo(50, 6);
    expect(by.get('乙')).toBeCloseTo(-10, 6);
  });
});

// 🔴 [R20-PERSTOCK-WIN 2026-10-19] 用户第二次反馈的残差：新华传媒显示 193.41%（12/20日），
//   炒股软件 210.98%。根因 = 窗口被「全市场统一截到 20 天」⇒ 它停牌 10 天，20 天里只有 12 根腿，
//   早期那 8 天涨幅被挤出窗口。改成「每只票自己取最近 20 个有腿日」后 = 210.98%（逐位吻合）。
//   ★ 满窗票两种算法完全等价 ⇒ 只影响停牌/缺数据票。
describe('compound20：窗口按【每只票自己】的 20 个交易日（R20-PERSTOCK-WIN）', () => {
  const dates = mkDates(30);   // 30 个真实交易日，比窗口长（模拟探针 45 槽）
  const d = function(i) { return dates[i]; };

  it('★ 停牌票回溯取满 20 根腿（⛔ 不因"统一窗口"被截成 12 天）', () => {
    const a = new Map();
    for (let i = 0; i <= 9; i++) a.set(d(i), 10);        // 早期 10 天有腿
    for (let i = 15; i <= 24; i++) a.set(d(i), 10);       // 中段 10 天有腿
    // 最近 5 天（i=25..29）停牌 ⇒ 没有腿
    const rows = compound20(new Map([['停牌票', a]]), dates);
    expect(rows[0].days).toBe(20);
    // 20 根全都是 +10% ⇒ 复利；且窗口确实跨到了 i=0（早于"统一窗口"的起点 i=10）
    expect(rows[0].pct).toBeCloseTo((Math.pow(1.1, 20) - 1) * 100, 6);
  });

  it('满窗票：取最近 20 个交易日，⛔ 不会因为 ascDates 有 30 天就多算', () => {
    const b = new Map();
    for (let i = 0; i < 30; i++) b.set(d(i), 1);
    const rows = compound20(new Map([['满窗票', b]]), dates);
    expect(rows[0].days).toBe(20);
    expect(rows[0].pct).toBeCloseTo((Math.pow(1.01, 20) - 1) * 100, 6);
  });

  it('windowDays 可覆盖窗口长度（缺省 = RANGE20_WINDOW_DAYS）', () => {
    const b = new Map();
    for (let i = 0; i < 30; i++) b.set(d(i), 1);
    const rows = compound20(new Map([['甲', b]]), dates, { windowDays: 10 });
    expect(rows[0].days).toBe(10);
    expect(rows[0].pct).toBeCloseTo((Math.pow(1.01, 10) - 1) * 100, 6);
  });

  it('两根票窗口不同也能各算各的（- 停牌票 days 仍为 20）', () => {
    const a = new Map();
    for (let i = 0; i <= 9; i++) a.set(d(i), 5);
    for (let i = 20; i <= 29; i++) a.set(d(i), 5);        // 最近 10 天 + 更早 10 天
    const b = new Map();
    for (let i = 0; i < 30; i++) b.set(d(i), 2);
    const rows = compound20(new Map([['甲', a], ['乙', b]]), dates);
    const by = new Map(rows.map(function(r) { return [r.stock, r]; }));
    expect(by.get('甲').days).toBe(20);
    expect(by.get('乙').days).toBe(20);
    expect(by.get('甲').pct).toBeCloseTo((Math.pow(1.05, 20) - 1) * 100, 6);
    expect(by.get('乙').pct).toBeCloseTo((Math.pow(1.02, 20) - 1) * 100, 6);
  });
});

// ============================================================================
// [RANGE20 2026-10-19] 真实交易日校准（pickRealWindowDates）
//
// 事故原型（⛔ 改这里前先读一遍）：
//   云端 owner.data.holidays 是空数组 ⇒ isTradingDay 退化为「只判周末」 ⇒ 国庆/中秋这种
//   工作日假期被当成交易日。20 日窗口（09-14~10-19）里混进 6 个假交易日，实测同花顺 K 线
//   里这 6 天根本没有数据（miss=20260925,20261001,20261002,20261005,20261006,20261007）
//   ⇒ 按 App 日历直接取 20 天，实际只覆盖 14 个真实交易日。
//   解法 = 取数用 30 个槽位的探针窗口，再用「这一天有没有任何一只票拿到腿」重建真实交易日窗口。
// ============================================================================
describe('pickRealWindowDates（剔除 App 日历里的工作日假期）', () => {
  const dates = mkDates(10);

  it('没有任何腿的日期被剔除（模拟假期）', () => {
    // 只有 dates[0] / dates[1] / dates[3] / dates[4] 有腿 ⇒ dates[2] 视为非交易日
    const legs = new Map([
      ['甲', new Map([[dates[0], 1], [dates[1], 2], [dates[3], 3], [dates[4], 4]])],
      ['乙', new Map([[dates[1], 1], [dates[4], 2]])]
    ]);
    const real = pickRealWindowDates(legs, dates, 10);
    expect(real).toEqual([dates[0], dates[1], dates[3], dates[4]]);
  });

  it('只要「任意一只票」有腿 ⇒ 该日算真实交易日（停牌票不影响判断）', () => {
    const legs = new Map([
      ['停牌票', new Map([[dates[0], 0]])],
      ['正常票', new Map([[dates[5], 3]])]
    ]);
    const real = pickRealWindowDates(legs, dates, 10);
    expect(real).toEqual([dates[0], dates[5]]);
  });

  it('只取最后 N 个真实交易日（窗口对所有票全局一致）', () => {
    const legs = new Map([['甲', new Map(dates.map(function(d) { return [d, 1]; }))]]);
    const real = pickRealWindowDates(legs, dates, 4);
    expect(real).toEqual(dates.slice(-4));
  });

  it('候选窗口外的腿不参与（防止把探针外的日期算进窗口）', () => {
    const legs = new Map([['甲', new Map([['1999-01-01', 9], [dates[1], 1]])]]);
    expect(pickRealWindowDates(legs, dates, 10)).toEqual([dates[1]]);
  });

  it('空输入 ⇒ 空数组（⛔ 不伪造日期、不补 0）', () => {
    expect(pickRealWindowDates(new Map(), dates, 10)).toEqual([]);
    expect(pickRealWindowDates(null, dates, 10)).toEqual([]);
    expect(pickRealWindowDates(new Map([['甲', new Map([[dates[0], 1]])]]), [], 10)).toEqual([]);
  });

  it('真实交易日不足 N 天 ⇒ 有多少给多少（如实体现 days < 20）', () => {
    const legs = new Map([['甲', new Map([[dates[2], 1], [dates[7], 2]])]]);
    expect(pickRealWindowDates(legs, dates, 20)).toEqual([dates[2], dates[7]]);
  });
});

describe('探针窗口', () => {
  it('RANGE20_PROBE_DAYS 必须大于窗口长度（否则假期一多就凑不满 20 天）', () => {
    expect(RANGE20_PROBE_DAYS).toBeGreaterThan(RANGE20_WINDOW_DAYS);
  });
  // ⚠️ 不在这里断言 getRange20WindowDates 返回的日期：它内部走 getPreviousTradingDay
  //   （依赖云端 allData.holidays + localStorage），单测环境没有那份数据（§10 别让单测去猜日历）。
  //   纯函数部分（pickRealWindowDates / compound20 / merge20Legs）已各自覆盖。
});

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [R20-DAILY 2026-10-30 用户口径] 逐日腿原料表 —— 「历史数据先存好，次日只补当天」
//
// 用户原话：
//   「为什么每次打开都要实时计算，非常耗时间，比如那些历史数据先存好，次日在算次日，这样不更快吗？
//     为什么每次都要同花顺实时重新拉取，拉取当天的就可以，再加上历史日期，有些票不在当天正式列表的，
//     看表里有没有数据，有的话看哪天没有补哪天，没有的话，就全补，这样局部补数据，而不是每次整体获取，
//     这样很慢，影响体验。」
//
// 四个纯函数各司其职：
//   legs20FromDaily  读表 ⇒ 历史腿（⛔ 绝不含 T）
//   mergeBaseLegs    表里的历史腿 + 当天的 T 腿（T 必须最后覆盖）
//   needsKlineLegs   这只票要不要补 K 线（腿够 ⇒ 一个请求都不发）
//   dailyRowsFromKline  K 线结果 ⇒ 入库行（⛔ 绝不写 T，盘中那根是现价不是收盘）
// ══════════════════════════════════════════════════════════════════════════════════════
describe('逐日腿原料（R20-DAILY）', () => {
  const dates = mkDates(20);                 // 20 个日期键，最后一个 = 展示日 T
  const T = dates[19];

  /** 造一份「20 天全有腿」的原料表 */
  function fullDaily() {
    const inner = new Map();
    dates.forEach(function(d) { inner.set(d, 1); });
    return new Map([['甲', inner]]);
  }

  it('legs20FromDaily：只给 T 之前的历史腿，⛔ 不含 T（T 腿归 resolveT20Leg）', () => {
    const legs = legs20FromDaily([{ stock: '甲' }], dates, fullDaily());
    const m = legs.get('甲');
    expect(m).toBeTruthy();
    expect(m.size).toBe(19);
    expect(m.has(T)).toBe(false);
    expect(m.has(dates[0])).toBe(true);
  });

  it('legs20FromDaily：表里 T 行有值也不许当今天的腿（否则把隔夜涨幅算进去）', () => {
    const daily = fullDaily();
    daily.get('甲').set(T, 99);              // 人为塞一根"今天的腿"
    const legs = legs20FromDaily([{ stock: '甲' }], dates, daily);
    expect(legs.get('甲').has(T)).toBe(false);
  });

  it('legs20FromDaily：缺某天 ⇒ 那天没有腿（§10 不补 0）', () => {
    const daily = fullDaily();
    daily.get('甲').delete(dates[5]);
    const legs = legs20FromDaily([{ stock: '甲' }], dates, daily);
    expect(legs.get('甲').size).toBe(18);
    expect(legs.get('甲').has(dates[5])).toBe(false);
  });

  it('legs20FromDaily：表不可用（null）/ 空表 ⇒ 空结果（调用方据此退回全量补）', () => {
    expect(legs20FromDaily([{ stock: '甲' }], dates, null).size).toBe(0);
    expect(legs20FromDaily([{ stock: '甲' }], dates, new Map()).size).toBe(0);
    expect(legs20FromDaily([], dates, fullDaily()).size).toBe(0);
  });

  it('mergeBaseLegs：T 腿必须【最后】覆盖（表里的同日行属于历史，不是今天）', () => {
    const dailyLegs = new Map([['甲', new Map([[dates[18], 2]])]]);
    const tLegs = new Map([['甲', new Map([[T, 5]])]]);
    const merged = mergeBaseLegs(tLegs, dailyLegs);
    expect(merged.get('甲').get(dates[18])).toBe(2);
    expect(merged.get('甲').get(T)).toBe(5);
    // 顺序反过来的写法是错的 ⇒ 这里断言"表里若也有 T 也必须被 T 腿盖掉"
    const dirtyDaily = new Map([['甲', new Map([[T, 99], [dates[18], 2]])]]);
    const merged2 = mergeBaseLegs(tLegs, dirtyDaily);
    expect(merged2.get('甲').get(T)).toBe(5);
  });

  it('needsKlineLegs：19 根历史腿 = 够（不发请求）；18 根 = 缺（要补）', () => {
    const full = mergeBaseLegs(new Map(), legs20FromDaily([{ stock: '甲' }], dates, fullDaily()));
    expect(needsKlineLegs(full, '甲', T)).toBe(false);          // 19 根 ⇒ 够
    full.get('甲').delete(dates[3]);
    expect(needsKlineLegs(full, '甲', T)).toBe(true);           // 18 根 ⇒ 缺
  });

  it('needsKlineLegs：表里没这只票 / 表不可用 ⇒ 要补（= 改造前的全量行为，§11 零回归）', () => {
    expect(needsKlineLegs(new Map(), '甲', T)).toBe(true);
    expect(needsKlineLegs(null, '甲', T)).toBe(true);
    // 只有 T 一根腿（改造前阶段① 的形状）⇒ 必须补，⛔ 不能拿一根腿冒充 20 日涨幅
    const onlyT = new Map([['甲', new Map([[T, 3]])]]);
    expect(needsKlineLegs(onlyT, '甲', T)).toBe(true);
  });

  // ★★ [R20-REQT 2026-10-30] 收盘口径下「不在今日名单的票」（补位票 / 候选池里今天没上榜的票）
  //   没有当天行 ⇒ 没有 T 腿。若不强制补，compound20 会往前多取一根凑满 20
  //   ⇒ 锚点变成「截至昨天收盘」，与同屏上了榜的票基准不一致（排名会串）。
  it('needsKlineLegs · requireT：19 根历史腿但缺 T 腿 ⇒ 盘中算够、收盘口径算缺', () => {
    const legs = mergeBaseLegs(new Map(), legs20FromDaily([{ stock: '甲' }], dates, fullDaily()));
    // 盘中（'auc'）：K 线的"今天"是现价，补了也用不上 ⇒ 不传 requireT
    expect(needsKlineLegs(legs, '甲', T)).toBe(false);
    // 收盘口径：没有当天行就拿不到今日收盘 ⇒ 必须补一次 K 线
    expect(needsKlineLegs(legs, '甲', T, undefined, { requireT: true })).toBe(true);
  });

  it('needsKlineLegs · requireT：历史腿够 + T 腿也在 ⇒ 两种口径都不用补', () => {
    const legs = mergeBaseLegs(
      new Map([['甲', new Map([[T, 4.5]])]]),
      legs20FromDaily([{ stock: '甲' }], dates, fullDaily())
    );
    expect(needsKlineLegs(legs, '甲', T)).toBe(false);
    expect(needsKlineLegs(legs, '甲', T, undefined, { requireT: true })).toBe(false);
  });

  it('needsKlineLegs · requireT：T 腿的值为 null ⇒ 视为缺失（§10 缺数据 ≠ 0%）', () => {
    const legs = mergeBaseLegs(
      new Map([['甲', new Map([[T, null]])]]),
      legs20FromDaily([{ stock: '甲' }], dates, fullDaily())
    );
    expect(needsKlineLegs(legs, '甲', T, undefined, { requireT: true })).toBe(true);
  });

  // ★ 端到端复现「todo.length === 0 分支必须过 §10 过滤」这个坑：
  //   只有 T 腿的票（腿不够、但这一轮没进 todo）若不过滤就会被 compound20 算成
  //   「20 日涨幅 = 今日涨幅 / days=1」，而且发布时 fresh 会覆盖同名的云端真值。
  it('端到端：只有 T 腿的票必须被 §10 过滤挡掉，⛔ 不拿当天涨幅冒充 20 日涨幅', () => {
    const legs = mergeBaseLegs(
      new Map([['甲', new Map([[T, 10]])], ['乙', new Map([[T, -3]])]]),
      legs20FromDaily([{ stock: '甲' }], dates, fullDaily())
    );
    const all = compound20(legs, dates);
    // 不设防时：乙只有一根腿 ⇒ 直接被算成 -3%（= 当天涨幅），天数 1
    expect(all.map(function(r) { return r.stock; }).sort()).toEqual(['乙', '甲']);
    const guarded = all.filter(function(r) {
      return !needsKlineLegs(legs, r.stock, T);
    });
    expect(guarded.map(function(r) { return r.stock; })).toEqual(['甲']);
    expect(guarded[0].days).toBe(20);
  });

  // ★★ [R20-STALE 2026-10-30] 正确性红线：`compound20` 对「某天没腿」是**跳过**（停牌语义），
  //   表整体落后一天时会被当成"那天停牌"⇒ 多算一天、少算一天，数字偏了还查不出来。
  //   而 needsKlineLegs 只数根数（45 槽里够 19 根就行），落后 1~2 天照样「够」⇒ 完全防不住。
  it('isLegTableStale：表里最新腿 = 日历前一交易日 ⇒ 新鲜（不发多余请求）', () => {
    const legs = legs20FromDaily([{ stock: '甲' }], dates, fullDaily());
    expect(isLegTableStale(legs, dates)).toBe(false);
  });

  it('isLegTableStale：表里最新腿落后日历一天 ⇒ 判落后（本轮强制全部走 K 线，宁慢勿错）', () => {
    const daily = fullDaily();
    daily.get('甲').delete(dates[18]);          // 昨天的腿还没写进来
    const legs = legs20FromDaily([{ stock: '甲' }], dates, daily);
    // 注意：根数仍然有 18 >= 19? 不是 —— 这里只是证明「根数」之外还需要这条判据
    expect(isLegTableStale(legs, dates)).toBe(true);
  });

  it('isLegTableStale：表里有比日历更新的日期 ⇒ 不算落后（容忍时钟差）', () => {
    const legs = new Map([['甲', new Map([[dates[18], 1], ['2099-01-01', 1]])]]);
    expect(isLegTableStale(legs, dates)).toBe(false);
  });

  it('isLegTableStale：表为空 / 日历不足两天 ⇒ false（那种情况 needsKlineLegs 本来就全补）', () => {
    expect(isLegTableStale(new Map(), dates)).toBe(false);
    expect(isLegTableStale(null, dates)).toBe(false);
    expect(isLegTableStale(new Map([['甲', new Map([[T, 1]])]]), [T])).toBe(false);
  });

  it('dailyRowsFromKline：只写 T 之前的腿（盘中"今天"是现价，写进去会被当成收盘腿）', () => {
    const extra = new Map([['甲', new Map([
      [dates[17].replace(/-/g, ''), 2.5],
      [dates[18].replace(/-/g, ''), -1.5],
      [T.replace(/-/g, ''), 8.88]            // ← 今天，必须被挡掉
    ])]]);
    const rows = dailyRowsFromKline(extra, T);
    expect(rows).toHaveLength(2);
    expect(rows.map(function(r) { return r.date; })).toEqual([dates[17], dates[18]]);
    expect(rows.every(function(r) { return r.stock === '甲'; })).toBe(true);
    expect(rows[1].pct).toBe(-1.5);
  });

  it('dailyRowsFromKline：空值 / 非法日期键一律跳过（§10 不造值）', () => {
    const extra = new Map([['甲', new Map([
      [dates[17].replace(/-/g, ''), null],
      ['badkey', 1],
      [dates[18].replace(/-/g, ''), 3]
    ])]]);
    expect(dailyRowsFromKline(extra, T)).toHaveLength(1);
    expect(dailyRowsFromKline(null, T)).toEqual([]);
    expect(dailyRowsFromKline(extra, '')).toEqual([]);
  });

  it('端到端：次日只缺 1 根腿 ⇒ 用表 + 当天 T 腿算出复利（0 个 K 线请求）', () => {
    // 昨天收盘后把 T-1 写进了表 ⇒ 今天算 T 的窗口时 19 根历史腿全在
    const legs = mergeBaseLegs(
      new Map([['甲', new Map([[T, 10]])]]),      // 今天竞价 +10%
      legs20FromDaily([{ stock: '甲' }], dates, fullDaily())
    );
    expect(needsKlineLegs(legs, '甲', T)).toBe(false);
    const rows = compound20(legs, dates);
    expect(rows).toHaveLength(1);
    expect(rows[0].days).toBe(20);
    // 19 天各 +1% 再乘今天 +10%：1.01^19 * 1.1 - 1
    const want = (Math.pow(1.01, 19) * 1.1 - 1) * 100;
    expect(rows[0].pct).toBeCloseTo(want, 6);
  });
});

describe('countMissingRange20：状态条「还差 N 只」的判据（R20-FAILVIS）', () => {
  // 用户原话（2026-10-30）：「点开20日toggle，有涨幅的只有23只，总数是43只，怎么回事？
  //   是每写入吗？还是没有抓取？」—— 屏幕上只有 `—`，用户分不清「在补 / 补失败 / 没数据」。
  // ⇒ 状态条必须能说清「还差几只」，判据必须守 §10：**没有可上屏的数值就算缺**。
  it('全部有值 ⇒ missing=0', () => {
    const pub = new Map([['甲', { pct: 12.5, days: 20 }], ['乙', { pct: -3, days: 20 }]]);
    expect(countMissingRange20(pub, [{ stock: '甲' }, { stock: '乙' }]))
      .toEqual({ total: 2, missing: 0 });
  });

  it('🔴 上游截断（只回 12 根）的票：发布了但 pct 为空 ⇒ 必须算缺', () => {
    // 这是本次报障的最迷惑形态：`extra.has(stock)` 为真（所以旧统计认为"成功"），
    // 但腿不够 ⇒ 这一列是 `—`。按 extra 统计会显示「全部成功」，屏幕却一半空白。
    const pub = new Map([['甲', { pct: null, days: 0 }], ['乙', { pct: 5, days: 20 }]]);
    expect(countMissingRange20(pub, [{ stock: '甲' }, { stock: '乙' }]))
      .toEqual({ total: 2, missing: 1 });
  });

  it('压根没发布过的票 ⇒ 算缺（⛔ 不能当成 0%）', () => {
    const pub = new Map([['甲', { pct: 8, days: 20 }]]);
    expect(countMissingRange20(pub, [{ stock: '甲' }, { stock: '乙' }, { stock: '丙' }]))
      .toEqual({ total: 3, missing: 2 });
  });

  it('pct=0 是合法值（平盘）⇒ 不算缺', () => {
    const pub = new Map([['甲', { pct: 0, days: 20 }]]);
    expect(countMissingRange20(pub, [{ stock: '甲' }])).toEqual({ total: 1, missing: 0 });
  });

  it('pubMap 为空 / 目标为空 ⇒ 不炸', () => {
    expect(countMissingRange20(null, [{ stock: '甲' }])).toEqual({ total: 1, missing: 1 });
    expect(countMissingRange20(null, [])).toEqual({ total: 0, missing: 0 });
    expect(countMissingRange20(new Map(), null)).toEqual({ total: 0, missing: 0 });
  });

  it('目标里有空名字 ⇒ 跳过，不污染 total', () => {
    const pub = new Map([['甲', { pct: 1, days: 20 }]]);
    expect(countMissingRange20(pub, [{ stock: '甲' }, null, { stock: '' }, {}]))
      .toEqual({ total: 1, missing: 0 });
  });
});
