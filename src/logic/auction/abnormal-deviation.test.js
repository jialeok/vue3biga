// abnormal-deviation.test.js — 官方「收盘价格涨跌幅偏离值」的回归锁
//
// ★ 夹具 abnormal-dev-cases.json 是【真实行情】：
//   腾讯前复权日线（与 stock_daily_pct 同源，2026-11-14 实测）换算的逐日涨幅腿，
//   官方对应指数同样取腾讯（sh000002 / sz399107 / sh000688）。
//   ⛔ 别把它改成手编数组：手编数组锁不住「期初前收盘」「复利连乘」「对应指数」这三个要害。
//
// ★ 验收基准 = 交易所 `abnormal-monitor-list` 里 4 条真实严重异动记录（type=1）：
//     600825 新华传媒 start 2026-10-09 ⇒ 本模块首次越线必须是 2026-10-08（+1 个交易日）
//     000993 闽东电力 start 2026-09-23 ⇒ 首次越线 2026-09-22
//     688137 近岸蛋白 start 2026-10-08 ⇒ 首次越线 2026-09-30
//   官方「公布即从次一交易日重新计算」⇒ 触发日 = start − 1 个交易日，这是【判据本身】，
//   ⛔ 不是「差一天」的误差。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import fx from './abnormal-dev-cases.json';
import {
  DEV_INDEX, DEV_INDEX_CODES, DEV_THRESHOLDS, DEV_NEAR_RATIO, DEV_WATCH_RATIO,
  DEV_STAGE_OK, DEV_STAGE_WATCH, DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_STAGE_UNKNOWN,
  STAGE_TEXT, STAGE_TONE,
  pickBaseIndexForCode, devIndexName, thresholdsForBoard,
  cumulativeDeviation, needGainToThreshold, classifyDeviation,
  computeDeviation, devText, needText, deviationBadge, deviationGapText, deviationCalcText,
  deviationCellTexts, deviationIndexLabel,
  deviationNeedValueText, deviationNeedAlert, deviationIndexBeta, deviationNeedWithIndexMove,
  deviationDetailLine, isDeviationSevere, isDeviationAlert,
  DEV_FORMULA_LINES, DEV_NEED_HINT, DEV_INDEX_NOTE_LINES,
  countSevereTriggers, severeOrdinalText, ABN_TRIGGER_LOOKBACK_DAYS,
  buildDeviationMap,
  // ★ [DEV-BASIS] 竞价口径 / 收盘口径
  DEV_CLOSE_HHMM, deviationBasisFor, deviationBasisNote, withIndexFlatLeg, deviationNeedDir,
  // ★ [DEV-NEG-WARN] 深市 ST 三日阈值
  DEV_THRESHOLDS_SZ_ST, isStName, thresholdsForStock
} from './abnormal-deviation.js';

/** 夹具里的腿是紧凑形态 {d,p}（省体积），这里统一转成业务形态 {date,pct} */
const _norm = function (arr) {
  return (arr || []).map(function (x) { return { date: x.d, pct: x.p }; });
};
const legsOf = function (code) { return _norm(fx.stocks[code].legs); };
const idxOf = function (code) { return _norm(fx.idx[fx.stocks[code].idx]); };
const idxDates = function (code) {
  return Array.from(new Set(idxOf(code).map(function (x) { return x.date; }))).sort();
};
/** 官方基准：给出「连续 n 日偏离首次 ≥ thr」的那一天 */
function firstCross(code, n, thr) {
  const s = legsOf(code);
  const i = idxOf(code);
  const dates = idxDates(code);
  for (let k = n - 1; k < dates.length; k++) {
    const r = cumulativeDeviation(s, i, n, dates[k]);
    if (r && r.dev >= thr) return { date: r.to, dev: r.dev };
  }
  return null;
}

describe('[ABN-DEV] 官方「对应指数」映射（⛔ 不是上证综指/深证成指/创业板指）', () => {
  it('四个板块各对应一个官方指数', () => {
    expect(pickBaseIndexForCode('600825').code).toBe('sh000002');   // 沪主板 → 上证A股指数
    expect(pickBaseIndexForCode('002242').code).toBe('sz399107');   // 深主板 → 深证A股指数
    expect(pickBaseIndexForCode('000993').code).toBe('sz399107');
    expect(pickBaseIndexForCode('301313').code).toBe('sz399102');   // 创业板 → 创业板综指
    expect(pickBaseIndexForCode('688137').code).toBe('sh000688');   // 科创板 → 科创50
  });

  it('⛔ 上证综指 000001 / 深证成指 399001 / 创业板指 399006 一个都不许出现', () => {
    expect(DEV_INDEX_CODES).toEqual(['sh000002', 'sz399107', 'sz399102', 'sh000688']);
    ['000001', '399001', '399006'].forEach(function (c) {
      expect(DEV_INDEX_CODES).not.toContain(c);
    });
  });

  it('北交所（4/8/92）⇒ null（官方口径不同，§40 不猜）', () => {
    expect(pickBaseIndexForCode('830799')).toBe(null);
    expect(pickBaseIndexForCode('430047')).toBe(null);
    expect(pickBaseIndexForCode('920819')).toBe(null);
    expect(pickBaseIndexForCode('')).toBe(null);
    expect(pickBaseIndexForCode('60082')).toBe(null);
  });

  it('指数代码 → 中文名（查不到原样返回，⛔ 不编名字）', () => {
    expect(devIndexName('sh000002')).toBe('上证A股指数');
    expect(devIndexName('sz399107')).toBe('深证A股指数');
    expect(devIndexName('sz399102')).toBe('创业板综指');
    expect(devIndexName('sh000688')).toBe('科创50');
    expect(devIndexName('sh999999')).toBe('sh999999');
  });
});

describe('[ABN-DEV] 阈值阶梯（沪深主板 vs 创业板/科创板）', () => {
  it('三档阈值照官方条文', () => {
    expect(DEV_THRESHOLDS.main).toMatchObject({ dev3: 20, dev10: 100, dev30: 200, neg10: -50, neg30: -70, times10: 4 });
    expect(DEV_THRESHOLDS.growth).toMatchObject({ dev3: 30, dev10: 100, dev30: 200, times10: 3 });
    expect(DEV_THRESHOLDS.star.dev3).toBe(30);
    expect(thresholdsForBoard('main')).toBe(DEV_THRESHOLDS.main);
    expect(thresholdsForBoard('')).toBe(null);
  });

  it('预警带 = 红线的 90%（90 / 180），留意带 = 70%（70 / 140）', () => {
    expect(DEV_NEAR_RATIO).toBe(0.9);
    expect(DEV_WATCH_RATIO).toBe(0.7);
  });
});

describe('[ABN-DEV] 官方公式 · 用真实行情复核交易所名单', () => {
  it('600825 新华传媒 10 日偏离首次 ≥100% = 2026-10-08（官方 start 10-09 ⇒ +1 个交易日）', () => {
    const c = firstCross('600825', 10, 100);
    expect(c).not.toBe(null);
    expect(c.date).toBe('2026-10-08');
    expect(c.dev).toBeGreaterThan(100);
    expect(c.dev).toBeLessThan(130);
  });

  it('000993 闽东电力 10 日偏离首次 ≥100% = 2026-09-22（官方 start 09-23）', () => {
    const c = firstCross('000993', 10, 100);
    expect(c).not.toBe(null);
    expect(c.date).toBe('2026-09-22');
  });

  it('688137 近岸蛋白（科创板）10 日偏离首次 ≥100% = 2026-09-30（官方 start 10-08，中间是长假）', () => {
    const c = firstCross('688137', 10, 100);
    expect(c).not.toBe(null);
    expect(c.date).toBe('2026-09-30');
  });

  it('⚠️ 原始涨幅会误报：新华传媒「首次 ≥100%」在 10-08，但之后一路涨到 11 月才停 —— 判据必须是偏离值', () => {
    // 直接证据：11-13 收盘它的 10 日偏离已经是 −2.9%（跌回来了），而十日【原始涨幅】仍可能 >0
    const s = legsOf('600825');
    const i = idxOf('600825');
    const d10 = cumulativeDeviation(s, i, 10, '2026-11-13');
    const d30 = cumulativeDeviation(s, i, 30, '2026-11-13');
    expect(d10.dev).toBeLessThan(0);
    expect(d30.dev).toBeGreaterThan(60);
    // 同期它【扣掉的指数】是小幅波动的 ⇒ 偏离值与原始涨幅的差 = 指数区间涨幅
    expect(Math.abs(d10.indexChain)).toBeLessThan(15);
    expect(d10.dev).toBeCloseTo(d10.stockChain - d10.indexChain, 6);
  });

  it('复利连乘口径：dev = 个股区间涨幅 − 指数区间涨幅（⛔ 不是逐日偏离相加）', () => {
    const s = legsOf('002578');
    const i = idxOf('002578');
    const r = cumulativeDeviation(s, i, 10, '2026-11-13');
    expect(r.dev).toBeCloseTo(r.stockChain - r.indexChain, 6);
    // 逐日偏离相加会得到明显不同的数 ⇒ 用它当反例，锁住「不能改回累加式」
    const sm = new Map(s.map(function (x) { return [x.date, x.pct]; }));
    const im = new Map(i.map(function (x) { return [x.date, x.pct]; }));
    const dates = Array.from(new Set(i.map(function (x) { return x.date; }))).sort();
    const win = dates.slice(-10);
    let sum = 0;
    win.forEach(function (d) { sum += (sm.has(d) ? sm.get(d) : 0) - im.get(d); });
    expect(Math.abs(sum - r.dev)).toBeGreaterThan(5);
  });
});

// ── 屏幕自核解析器 ─────────────────────────────────────────────────────────────
// 🔴🔴 [ABN-DEV-UNIT 2026-11-14] 用户是【照屏幕做加法】的：
//   「185.5% + 5.2% = 190.7%，30 日还没到 200% 啊」⇒ 他拿徽标上的偏离值加括号里的百分数。
//   所以测试必须把【屏幕上那两个数】抠出来相加，⛔ 不许改成复算内部变量 ——
//   内部算对了、屏幕上印错了，用户照样会来问。
const shownDev = function (f) {          // '30日偏离 +199.9%' ⇒ 199.9
  const m = String(f.badge).match(/([+-]?\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
};
const shownGap = function (f) {          // '距 200% 差 0.1 点（…）' ⇒ {thr:200, gap:0.1}
  const m = String(f.gapText).match(/^距 (\d+(?:\.\d+)?)% 差 (\d+(?:\.\d+)?) 点/);
  return m ? { thr: Number(m[1]), gap: Number(m[2]) } : null;
};

describe('[ABN-DEV] 11-13 收盘实物（用户点名的那四只）', () => {
  it('九阳股份 002242：30 日偏离 199.9，距 200 差 0.1 点 —— 屏幕上相加刚好等于 200', () => {
    const f = computeDeviation({ code: '002242', stockLegs: legsOf('002242'), indexLegs: idxOf('002242') });
    expect(f.ok).toBe(true);
    expect(f.dev30).toBeCloseTo(199.9, 0);
    expect(f.stage).toBe(DEV_STAGE_NEAR);            // 未越线 ⇒ near，不是 severe
    expect(f.gap30).toBeLessThan(0.5);
    expect(f.need30).toBeLessThan(1);                 // 「周一只要不跌就构成」
    expect(f.badge).toMatch(/^30日偏离 \+199\.\d{1,2}%$/);
    expect(f.gapText).toMatch(/^距 200% 差 0\.\d+ 点（股价再涨约 \+0\.\d+%）$/);
    const g = shownGap(f);
    expect(g.thr).toBe(200);
    expect(shownDev(f) + g.gap).toBeCloseTo(200, 6);  // 🔴 用户的自核动作，必须成立
  });

  it('闽发铝业 002578：10 日偏离 72.7 ⇒ 差 27.3 点 ⇒ 股价再涨约 +16%（两个单位都给）', () => {
    const f = computeDeviation({ code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578') });
    expect(f.dev10).toBeCloseTo(72.7, 0);
    expect(f.need10).toBeGreaterThan(12);
    expect(f.need10).toBeLessThan(20);
    expect(f.stage).toBe(DEV_STAGE_WATCH);            // 72.7 ≥ 70% × 100
    expect(f.gapText).toBe('距 100% 差 27.3 点（股价再涨约 +16%）');
    expect(shownDev(f) + shownGap(f).gap).toBeCloseTo(100, 6);
  });

  it('🔴 用户当场看到的那一行（新华传媒 10-28：30日偏离 +185.5%，还需 +5.2%）—— 两个单位怎么换算', () => {
    const f = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    expect(f.ok).toBe(true);
    expect(f.dev30).toBeCloseTo(185.5, 1);           // 面板上印的 +185.5%
    expect(f.stockChain30).toBeCloseTo(178.9, 1);    // 个股 30 日区间涨幅 +178.91%
    expect(f.indexChain30).toBeCloseTo(-6.6, 1);     // 上证A股指数同期 −6.57%
    expect(f.need30).toBeCloseTo(5.2, 1);            // 括号里的「股价再涨约 +5.2%」
    // 现场效果：14.5 个点 ÷ 汇率 2.789 ≈ 5.2% —— 两个数不一样大是对的，⛔ 不是算错
    expect(f.gapText).toBe('距 200% 差 14.5 点（股价再涨约 +5.2%）');
    expect(shownDev(f) + shownGap(f).gap).toBeCloseTo(200, 6);
    // detailLine 里那句自核必须能把这条路走通（汇率按 1 位小数印：2.789 ⇒ 2.8）
    expect(deviationDetailLine(f)).toContain('股价每再涨 1%，偏离约增加 2.8 个点');
  });

  it('🔴 点差 ≠ 股价涨幅：need = 点差 / (1 + 个股区间涨幅)（这就是 14.5 点只值 5.2% 的原因）', () => {
    [['002242', 'need30', 'thr30', 'dev30', 'stockChain30'],
      ['002578', 'need10', 'thr10', 'dev10', 'stockChain10']].forEach(function (c) {
      const f = computeDeviation({ code: c[0], stockLegs: legsOf(c[0]), indexLegs: idxOf(c[0]) });
      const pts = f[c[2]] - f[c[3]];                    // 还差的【点】数
      const rate = 1 + f[c[4]] / 100;                   // 复利汇率 (1+S)
      expect(pts / rate).toBeCloseTo(f[c[1]], 6);       // 换算成【股价涨幅】
      expect(f[c[1]]).toBeLessThan(pts);                // 涨幅永远小于点数（只要 S > 0）
    });
  });
});

describe('[ABN-DEV] needGainToThreshold · 还需涨多少（指数不动假设）', () => {
  it('公式：(1+I+thr/100)/(1+S) − 1', () => {
    // S = +50%、I = +5%、thr = 100 ⇒ (1.05+1)/1.5 − 1 = 36.67%
    expect(needGainToThreshold(50, 5, 100)).toBeCloseTo(36.67, 1);
    expect(needGainToThreshold(0, 0, 100)).toBeCloseTo(100, 6);
    expect(needGainToThreshold(100, 0, 100)).toBeCloseTo(0, 6);
  });

  it('已越线 ⇒ ≤ 0（视图据此写「已越线」，⛔ 不写「还需 +0%」）', () => {
    expect(needGainToThreshold(120, 0, 100)).toBeLessThan(0);
    expect(needText(needGainToThreshold(120, 0, 100))).toBe('已越线');
    expect(needText(needGainToThreshold(72.7, 5, 100))).toBe('还需 +19%');
  });

  it('§10 判不出 ⇒ null（⛔ 不补 0）', () => {
    expect(needGainToThreshold(null, 5, 100)).toBe(null);
    expect(needGainToThreshold(50, null, 100)).toBe(null);
    expect(needGainToThreshold(50, 5, null)).toBe(null);
    expect(needGainToThreshold(-100, 5, 100)).toBe(null);   // 区间跌幅 ≥100% = 数据异常
    expect(needText(null)).toBe('—');
  });
});

describe('[ABN-DEV] classifyDeviation · 档位', () => {
  it('10 日 +100.3 ⇒ severe', () => {
    const r = classifyDeviation({ board: 'main', dev3: 5, dev10: 100.3, dev30: 150 });
    expect(r.stage).toBe(DEV_STAGE_SEVERE);
    expect(r.hasSevere10).toBe(true);
    expect(r.hasSevere30).toBe(false);
    expect(r.hits.map(function (h) { return h.code; })).toContain('D10');
  });

  it('30 日 +200.1 ⇒ severe（30 日那档单独也能触发）', () => {
    const r = classifyDeviation({ board: 'main', dev3: 5, dev10: 40, dev30: 200.1 });
    expect(r.stage).toBe(DEV_STAGE_SEVERE);
    expect(r.hasSevere30).toBe(true);
  });

  it('199.9 / 72.7 / 48.8 三档分别落在 near / watch / ok', () => {
    expect(classifyDeviation({ board: 'main', dev10: 18.6, dev30: 199.9 }).stage).toBe(DEV_STAGE_NEAR);
    expect(classifyDeviation({ board: 'main', dev10: 72.7, dev30: 48.4 }).stage).toBe(DEV_STAGE_WATCH);
    expect(classifyDeviation({ board: 'main', dev10: 11.0, dev30: 69.2 }).stage).toBe(DEV_STAGE_OK);
  });

  it('负方向同样管：10 日 −50.2 ⇒ severe（官方 −50% / −70%）', () => {
    const r = classifyDeviation({ board: 'main', dev10: -50.2, dev30: -10 });
    expect(r.stage).toBe(DEV_STAGE_SEVERE);
    expect(r.hits.map(function (h) { return h.code; })).toContain('N10');
  });

  it('3 日偏离 ±20%（主板）/ ±30%（科创创业）是最早那一档 ⇒ watch', () => {
    expect(classifyDeviation({ board: 'main', dev3: 21, dev10: 10, dev30: 10 }).stage).toBe(DEV_STAGE_WATCH);
    expect(classifyDeviation({ board: 'growth', dev3: 21, dev10: 10, dev30: 10 }).stage).toBe(DEV_STAGE_OK);
    expect(classifyDeviation({ board: 'growth', dev3: 31, dev10: 10, dev30: 10 }).stage).toBe(DEV_STAGE_WATCH);
  });

  it('§10：三个都判不出 ⇒ unknown（⛔ 不判成 ok）', () => {
    const r = classifyDeviation({ board: 'main', dev3: null, dev10: null, dev30: null });
    expect(r.stage).toBe(DEV_STAGE_UNKNOWN);
    expect(classifyDeviation({ board: '', dev10: 50 }).stage).toBe(DEV_STAGE_UNKNOWN);
  });
});

describe('[ABN-DEV] §10 缺数据红线', () => {
  it('指数腿完全没有 ⇒ 判不出（⛔ 不拿 0 顶替，⛔ 不换别的指数）', () => {
    expect(cumulativeDeviation(legsOf('002242'), [], 10)).toBe(null);
    expect(cumulativeDeviation(legsOf('002242'), null, 10)).toBe(null);
  });

  it('指数腿不够一整个窗口 ⇒ 判不出', () => {
    const few = idxOf('002242').slice(-5);
    expect(cumulativeDeviation(legsOf('002242'), few, 10)).toBe(null);
  });

  it('个股末腿缺失 ⇒ 判不出（那天没交易，判不了这个窗口）', () => {
    const s = legsOf('002242').slice(0, -1);
    expect(cumulativeDeviation(s, idxOf('002242'), 10)).toBe(null);
  });

  it('个股中间缺腿 ⇒ 按 0 计入但必须记账 missingLegs（停牌前收盘不变，数学上正确）', () => {
    const s = legsOf('002242').slice();
    const drop = s.length - 5;
    s.splice(drop, 1);
    const r = cumulativeDeviation(s, idxOf('002242'), 10);
    expect(r).not.toBe(null);
    expect(r.missingLegs).toBe(1);
  });

  it('北交所/非法代码 ⇒ computeDeviation 返回 ok:false 且全 null', () => {
    const f = computeDeviation({ code: '830799', stockLegs: [], indexLegs: [] });
    expect(f.ok).toBe(false);
    expect(f.dev10).toBe(null);
    expect(f.dev30).toBe(null);
    expect(f.badge).toBe('');
    expect(f.stage).toBe(DEV_STAGE_UNKNOWN);
  });

  it('每只票返回独立的 hits 数组（⛔ 不许共享同一个空数组，会串味）', () => {
    const a = computeDeviation({ code: '830799', stockLegs: [], indexLegs: [] });
    const b = computeDeviation({ code: '430047', stockLegs: [], indexLegs: [] });
    expect(a.hits).not.toBe(b.hits);
  });
});

describe('[ABN-DEV] 上屏文案（§21 模板零计算）', () => {
  const f242 = computeDeviation({ code: '002242', stockLegs: legsOf('002242'), indexLegs: idxOf('002242') });
  const f578 = computeDeviation({ code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578') });

  it('devText / needText', () => {
    expect(devText(72.7)).toBe('+72.7%');
    expect(devText(-2.94)).toBe('-2.9%');
    expect(devText(null)).toBe('—');
    expect(needText(16.2)).toBe('还需 +16%');
    expect(needText(3.21)).toBe('还需 +3.2%');
    expect(needText(-1)).toBe('已越线');
  });

  it('badge 挑「离红线最近的那一档」来说', () => {
    expect(f242.badge).toContain('30日偏离');       // 199.9/200 比 18.6/100 更近
    expect(f578.badge).toBe('10日偏离 +72.7%');
  });

  it('🔴 徽标与「距红线」必须说同一档（⛔ 徽标说 30日、括号里算 10日 —— 正是用户质疑的那类自相矛盾）', () => {
    [[f242, '30日偏离', 200], [f578, '10日偏离', 100]].forEach(function (c) {
      expect(c[0].badge.indexOf(c[1])).toBe(0);
      expect(c[0].gapText.indexOf('距 ' + c[2] + '% 差 ')).toBe(0);
    });
  });

  it('gapText 双单位：「差 N 点」能直接和徽标相加，「股价再涨」才是可执行的那一步', () => {
    expect(f242.gapText).toMatch(/^距 200% 差 0\.\d+ 点（股价再涨约 \+0\.\d+%）$/);
    expect(f578.gapText).toBe('距 100% 差 27.3 点（股价再涨约 +16%）');
  });

  it('🔴 取整一致性：显示偏离 + 点差 === 阈值（199.96 那种会印成 200.0 的卡线票也要对上）', () => {
    const mk = function (dev30) {
      const f = {
        ok: true, stage: 'near', dev10: 40, dev30: dev30, gap10: 60, gap30: 200 - dev30,
        need10: 30, need30: (200 - dev30) / 2.5, thr10: 100, thr30: 200, hits: []
      };
      f.badge = deviationBadge(f);       // 徽标与点差必须同一精度，⛔ 不在这里手写
      f.gapText = deviationGapText(f);
      return f;
    };
    // [真实偏离, 期望点差文案] —— 199.96 是「1 位小数会把未越线印成 200.0」的边界
    [[199.9454, '差 0.1 点'], [199.96, '差 0.04 点'], [199.4, '差 0.6 点'], [196, '差 4.0 点']]
      .forEach(function (c) {
        const f = mk(c[0]);
        expect(deviationGapText(f)).toContain(c[1]);
        expect(shownDev(f) + shownGap(f).gap).toBeCloseTo(200, 6);   // 🔴 屏幕相加 === 阈值
        expect(shownDev(f)).toBeLessThan(200);                        // 未越线就是未越线
      });
    // 差 < 1 点给两位小数（⛔ 不许印成「差 0.0 点」）
    expect(deviationGapText(mk(199.96))).toContain('差 0.04 点');
  });

  it('line = badge + gapText（买点行徽标直接用，模板不拼字符串）', () => {
    expect(f578.line).toBe('10日偏离 +72.7% · 距 100% 差 27.3 点（股价再涨约 +16%）');
  });

  it('detailLine 交代指数名 + 距红线 + 自核算式 + 口径', () => {
    const s = f578;
    const line = deviationDetailLine(s);
    expect(line).toContain('深证A股指数');
    expect(line).toContain('10日偏离');
    expect(line).toContain('30日偏离');
    expect(line).toContain('★ 距红线：距 100% 差 27.3 点');
    // 自核句：让用户自己能验「为什么 27.3 个点只值 +16%」
    // 自核算式跟点差走【同一档】（闽发最近的是 10 日那档）
    expect(line).toContain('自核：10 日偏离 = 个股区间涨幅');
    expect(line).toContain('股价每再涨 1%，偏离约增加');
    expect(line).toContain('口径：截至最近一个收盘日');
    const auc = deviationDetailLine(Object.assign({}, s, { basis: 'auction' }));
    expect(auc).toContain('9:25 竞价');
  });

  it('🔴 自核算式：个股区间涨幅 − 对应指数同期涨幅 = 偏离值（屏幕上三个数能相加对上）', () => {
    const f = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    expect(f.calcText).toBe('自核 30日：+178.9% − (-6.6%) = +185.5%');
    // 三个数真能对上：178.9 − (−6.6) = 185.5（只取冒号后面，⛔ 别把「30日」里的 30 也算进来）
    const nums = f.calcText.split('：')[1].match(/[+-]?\d+(?:\.\d+)?/g).map(Number);
    expect(nums[0] - nums[1]).toBeCloseTo(nums[2], 6);
    // 10 日那档同理（闽发铝业：+74.9 − (+2.2) = +72.7）
    const g = computeDeviation({ code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578') });
    expect(g.calcText).toBe('自核 10日：+74.9% − (+2.2%) = +72.7%');
    const gn = g.calcText.split('：')[1].match(/[+-]?\d+(?:\.\d+)?/g).map(Number);
    expect(gn[0] - gn[1]).toBeCloseTo(gn[2], 6);
  });

  it('自核算式与徽标/点差【同一档、同一精度】（⛔ 不许算式说 10 日、点差算 30 日）', () => {
    [f242, f578].forEach(function (f) {
      const tag = String(f.badge).indexOf('30日') === 0 ? '30日' : '10日';
      expect(f.calcText.indexOf('自核 ' + tag)).toBe(0);
      // 等号右边的数必须与徽标里那个数逐字相同
      const shown = String(f.badge).match(/([+-]?\d+(?:\.\d+)?)%$/)[1];
      expect(f.calcText.slice(f.calcText.lastIndexOf('= ') + 2)).toBe(shown + '%');
    });
  });

  it('判不出 ⇒ calcText 是空串（⛔ 不写「— = —」占位）', () => {
    expect(computeDeviation({ code: '830799' }).calcText).toBe('');
    expect(deviationCalcText(null)).toBe('');
    expect(deviationCalcText({ ok: true, dev10: 50, thr10: 100, stockChain10: null, indexChain10: 1 })).toBe('');
  });

  it('计算公式七条必须与实现的等式逐字一致（算法一改，这里就该红）', () => {
    expect(DEV_FORMULA_LINES.length).toBe(7);
    expect(DEV_FORMULA_LINES[0]).toContain('个股区间涨幅 − 对应指数同期涨幅');
    expect(DEV_FORMULA_LINES[1]).toContain('点差 = 阈值 − 偏离值');
    expect(DEV_FORMULA_LINES[2]).toContain('点差 ÷ (1 + 个股区间涨幅)');
    // 算例里的数字必须是真实行情（新华传媒 10-28），⛔ 不许手编一个好看的数
    expect(DEV_FORMULA_LINES[0]).toContain('+178.9%');
    expect(DEV_FORMULA_LINES[0]).toContain('+185.5%');
    // ★ [IDX-MOVE] ④⑤ 必须如实交代「指数不动 = 条件估算」与窗口滚动，⛔ 不许写成精确预测
    expect(DEV_FORMULA_LINES[3]).toContain('条件估算');
    expect(DEV_FORMULA_LINES[3]).toContain('β = (1+指数区间涨幅) ÷ (1+个股区间涨幅)');
    expect(DEV_FORMULA_LINES[3]).toContain('窗口每天滚动');
    expect(DEV_FORMULA_LINES[4]).toContain('+1% ⇒ 需涨 +5.5%');
    expect(DEV_FORMULA_LINES[4]).toContain('−2% ⇒ +4.5%');
    // ★ [DEV-NEG-WARN] ⑥ 负方向必须把阈值写出来，且点差方向反着来
    expect(DEV_FORMULA_LINES[5]).toContain('−50%');
    expect(DEV_FORMULA_LINES[5]).toContain('−70%');
    expect(DEV_FORMULA_LINES[5]).toContain('偏离值 − 阈值');
    expect(DEV_FORMULA_LINES[5]).toContain('「跌」');
    // ★ [DEV-TIMES10] ⑦ 官方三条判据要如实交代「本面板只算②③」
    expect(DEV_FORMULA_LINES[6]).toContain('判据');
    expect(DEV_FORMULA_LINES[6]).toContain('4 次');
    expect(DEV_FORMULA_LINES[6]).toContain('只算 ②③');
    expect(DEV_FORMULA_LINES[6]).toContain('不等于官方一定不认定');
  });

  it('🔴 用户质疑「指数也在变，这只是大概推测吧」⇒ β = (1+指数区间涨幅)/(1+个股区间涨幅)', () => {
    const f = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    // 10-28 实测：cs=2.7891、ci=0.9343 ⇒ β=0.33498
    expect(f.indexBeta).toBeCloseTo((1 + f.indexChain30 / 100) / (1 + f.stockChain30 / 100), 8);
    expect(f.indexBeta).toBeCloseTo(0.335, 2);
    expect(f.indexBeta).toBeLessThan(1);              // 个股涨得比指数多 ⇒ 影响被压缩
    expect(deviationIndexBeta(null)).toBe(null);      // §10 判不出不补 0
  });

  it('🔴 指数涨跌对「股价再涨」的具体影响：need(h) = need0 + β·h，方向不能搞反', () => {
    const f = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    // ⚠️ 基线必须取「显示出来的那个 need」（由屏幕点差 14.5 ÷ cs 反推），
    //   ⛔ 不能用 f.need30 的原始值 —— 两者差 0.0075 点，是取整造成的（ABN-CHECK）。
    const n0 = deviationNeedWithIndexMove(f, 0);
    expect(n0).toBeCloseTo(5.2, 1);
    [[1, 5.535], [-1, 4.865], [2, 5.87], [-2, 4.53]].forEach(function (c) {
      const v = deviationNeedWithIndexMove(f, c[0]);
      expect(v).toBeCloseTo(c[1], 1);
      expect(v - n0).toBeCloseTo(f.indexBeta * c[0], 6);
    });
    // 指数【涨】⇒ 偏离被扣得更多 ⇒ 要涨【更多】；指数【跌】⇒ 要涨【更少】
    expect(deviationNeedWithIndexMove(f, 1)).toBeGreaterThan(n0);
    expect(deviationNeedWithIndexMove(f, -1)).toBeLessThan(n0);
    // 九阳卡线票：指数跌 1% 光靠指数就触发了 ⇒ 写「已触发」，⛔ 不写 '+0%'
    const g = computeDeviation({ code: '002242', stockLegs: legsOf('002242'), indexLegs: idxOf('002242') });
    expect(deviationNeedWithIndexMove(g, -1)).toBeLessThan(0);
    expect(g.indexMoveText).toContain('已触发');
    expect(g.indexMoveText).not.toContain('+0%');
  });

  it('上屏数值与警示色判据：+5.2% 红、+16% 不红、判不出不红', () => {
    const a = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    expect(a.needValueText).toBe('+5.2%');
    expect(a.needAlert).toBe(true);                   // 需涨 ≤10% ⇒ 接近警示
    expect(deviationNeedValueText(a)).toBe('+5.2%');
    const b = computeDeviation({ code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578') });
    expect(b.needValueText).toBe('+16%');
    expect(b.needAlert).toBe(false);
    const c = computeDeviation({ code: '830799' });
    expect(c.needValueText).toBe('');
    expect(c.needAlert).toBe(false);
    expect(c.indexBeta).toBe(null);
    expect(c.indexMoveText).toBe('');
    // 限定语必须常驻（用户质疑精度，⛔ 不许印一个没有前提的预测值）
    expect(DEV_NEED_HINT).toContain('同期指数不动');
    expect(DEV_NEED_HINT).toContain('条件估算');
  });

  it('detailLine / 每行小字都得交代 β 与「仅作推测」', () => {
    const f = computeDeviation({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-28'
    });
    expect(deviationDetailLine(f)).toContain('同期指数不动估算');
    expect(deviationDetailLine(f)).toContain('β=0.335');
    expect(f.indexMoveText).toBe('指数 ±1% ⇒ 需涨 +5.5% / +4.9%（β0.335）');
  });

  it('判不出 ⇒ detailLine 如实说「未就绪」，⛔ 不说成「没有异动」', () => {
    expect(deviationDetailLine(computeDeviation({ code: '600825', stockLegs: [], indexLegs: [] })))
      .toContain('数据未就绪');
    expect(deviationDetailLine(computeDeviation({ code: '830799' }))).toContain('北交所');
    expect(deviationDetailLine(null)).toBe('');
  });

  it('isDeviationSevere / isDeviationAlert 两把尺子', () => {
    expect(isDeviationSevere(f242)).toBe(false);      // 199.9 尚未越线
    expect(isDeviationAlert(f242)).toBe(true);        // 但在预警带
    expect(isDeviationSevere(null)).toBe(false);
    const severe = computeDeviation({
      code: '002242', stockLegs: legsOf('002242'), indexLegs: idxOf('002242')
    });
    expect(isDeviationAlert(severe)).toBe(true);
    expect(isDeviationAlert({ ok: true, stage: DEV_STAGE_OK })).toBe(false);
    expect(isDeviationAlert({ ok: true, stage: DEV_STAGE_WATCH })).toBe(false);
  });
});

describe('[IDX-LABEL 2026-11-14] 「对应指数」到底是哪个指数（用户「大盘？沪市？深市？」）', () => {
  it('顶部说明四行：按板块取，并点名排除三个常被误用的指数', () => {
    expect(DEV_INDEX_NOTE_LINES.length).toBe(4);
    const all = DEV_INDEX_NOTE_LINES.join('');
    expect(all).toContain('按上市板块指定');
    expect(all).toContain('不是笼统的「大盘指数」');
    ['sh000002', 'sz399107', 'sz399102', 'sh000688'].forEach(function (c) {
      expect(all).toContain(c);
    });
    // ⛔ 三大误用指数必须明写出来，只写「不是大盘」不够
    ['000001', '399001', '399006'].forEach(function (c) {
      expect(all).toContain(c);
    });
    expect(all).toContain('北交所不计算');
  });

  it('票名后小标签按【该票自己的板块】给，不是全表同一个指数', () => {
    const cases = [
      ['600825', 'sh000002', '上证A股指数', '沪市主板'],
      ['002242', 'sz399107', '深证A股指数', '深市主板'],
      ['301313', 'sz399102', '创业板综指', '深市创业板'],
      ['688137', 'sh000688', '科创50', '沪市科创板']
    ];
    cases.forEach(function (c) {
      // 腿给空 ⇒ dev 判不出，但指数映射只由代码决定 ⇒ 标签照样要有（口径不藏）
      const f = computeDeviation({ code: c[0], stockLegs: [], indexLegs: [] });
      const label = deviationIndexLabel(f);
      expect(label.text).toBe(c[2]);
      expect(label.title).toContain(c[1]);
      expect(label.title).toContain(c[3]);
      expect(label.title).toContain('⛔ 不是上证综指');
    });
  });

  it('§10 判不出 / 北交所 ⇒ 标签是空串（⛔ 不编一个指数名挂上去）', () => {
    expect(deviationIndexLabel(null)).toEqual({ text: '', title: '' });
    expect(deviationIndexLabel({ ok: false })).toEqual({ text: '', title: '' });
    expect(deviationIndexLabel({ ok: true, indexName: '', indexCode: '' })).toEqual({ text: '', title: '' });
    expect(deviationIndexLabel(computeDeviation({ code: '830799' }))).toEqual({ text: '', title: '' });
  });

  it('悬停说明里也要写指数代码（用户不用猜是哪个指数）', () => {
    const f = computeDeviation({ code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578') });
    expect(deviationDetailLine(f)).toContain('深证A股指数 sz399107');
  });
});

describe('[ABN-CHECK 2026-11-14] 真实库 11-13 九阳股份：五处上屏数字必须逐字对得上', () => {
  // ★ 这组数字来自真实库（.tmpdiag/_abn-002242-1113.mjs，stock_daily_pct + market_metrics scope=index）：
  //   cs=2.848747、ci=0.849155 ⇒ dev30 = 199.9592 点，10 日 dev10 = 18.6137 点。
  //   ⛔ 别改成手编的「好看数字」：正是 199.9592 卡在 1 位小数会印成 200.0 的边界上，
  //      才会暴露「表格 +200.0% / 徽标 +199.96% / 自核 184.87−(-15.08)=199.95」三处打架。
  const f = {
    ok: true, code: '002242', board: 'main', indexName: '深证A股指数',
    stage: 'near', stageText: '逼近交易所偏离红线',
    dev10: 18.6137, dev30: 199.9592,
    stockChain10: 20.8277, indexChain10: 2.2140,
    stockChain30: 184.8747, indexChain30: -15.0845,
    thr10: 100, thr30: 200, need10: 81.3863, need30: 0.0143,
    indexBeta: 0.298, hits: [], missingLegs: 0, basis: 'close'
  };
  f.badge = deviationBadge(f);
  f.gapText = deviationGapText(f);
  f.calcText = deviationCalcText(f);

  it('🔴 表格列不许印成 +200.0%（那会被读成「已越线」）', () => {
    const c = deviationCellTexts(f);
    expect(c.dev10Text).toBe('+18.6%');
    expect(c.dev30Text).toBe('+199.95%');
    expect(c.dev30Text).not.toBe('+200.0%');
    expect(deviationDetailLine(f)).toContain('30日偏离 +199.95%');
    expect(deviationDetailLine(f)).not.toContain('+200.0%');
  });

  it('🔴 徽标 / 点差 / 自核算式是同一组数，且等号真的加得起来', () => {
    expect(f.badge).toBe('30日偏离 +199.95%');
    expect(f.gapText).toBe('距 200% 差 0.05 点（股价再涨约 +0.02%）');
    expect(f.calcText).toBe('自核 30日：+184.87% − (-15.08%) = +199.95%');
    const n = f.calcText.split('：')[1].match(/[+-]?\d+(?:\.\d+)?/g).map(Number);
    expect(n[0] - n[1]).toBeCloseTo(n[2], 6);
    expect(shownDev(f) + shownGap(f).gap).toBeCloseTo(200, 6);
  });

  it('🔴「股价再涨」按屏幕上的点差反推（0.05 ÷ 2.849 ≈ 0.02%），⛔ 不许拿原始 dev 另算', () => {
    expect(f.gapText).toContain('+0.02%');
    expect(f.gapText).not.toContain('+0.01%');
  });
});

describe('[ABN-DEV] 档位常量齐全（视图只读字符串，⛔ 不在模板里判数字）', () => {
  it('五个档位都有中文名与色调', () => {
    [DEV_STAGE_UNKNOWN, DEV_STAGE_OK, DEV_STAGE_WATCH, DEV_STAGE_NEAR, DEV_STAGE_SEVERE].forEach(function (s) {
      expect(typeof STAGE_TEXT[s]).toBe('string');
      expect(STAGE_TEXT[s].length).toBeGreaterThan(0);
      expect(typeof STAGE_TONE[s]).toBe('string');
    });
  });

  it('严重度顺序：ok < watch < near < severe（判据依赖它，⛔ 不许调换）', () => {
    const rank = {};
    [DEV_STAGE_OK, DEV_STAGE_WATCH, DEV_STAGE_NEAR, DEV_STAGE_SEVERE].forEach(function (s, i) { rank[s] = i; });
    expect(rank[DEV_STAGE_SEVERE]).toBeGreaterThan(rank[DEV_STAGE_NEAR]);
    expect(rank[DEV_STAGE_NEAR]).toBeGreaterThan(rank[DEV_STAGE_WATCH]);
    expect(rank[DEV_STAGE_WATCH]).toBeGreaterThan(rank[DEV_STAGE_OK]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [ABN-TRIGGER 2026-11-15 用户口径] 「首次触发 / 二次触发 / 三次触发」
// ★★ [ABN-TRIGGER-2 2026-11-16 用户当场纠正] 「第几次」= 连续第几个触发日（⛔ 不按事件合并）
//
// 用户原话（11-15）：「你在官方偏离值那里（原版）给已达到交易所严重异常波动标准的股票，
//   打上标签，首次触发，二次触发，三次触发等字样，这样我就知道它是第几次，这样我好采取不同策略」
// 用户原话（11-16 纠正）：「10月8日新华传媒显示首次触发，10月9日显示也是首次触发，明显不对
//   你的代码有问题……要精准啊，不要瞎改」
//
// 验收基准（真实夹具，600825 新华传媒，与云端库逐字一致）：
//   10-08 10日偏离 +116.6%（首次） / 10-09 +137.6%（二次） / 10-12 +162.5%（三次）
//   10-13~10-15 个股腿缺 ⇒ 判不出（streak 保持不变）
//   10-16 +99.6% 未越线 ⇒ 归零
// 官方严重异动 start_date = 2026-10-09 ⇒ 首次越线必然是 10-08（「公布即从次一交易日重算」）。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('[ABN-TRIGGER] 严重异常波动的「第几次触发」', function () {
  it('序号文案：1 首次 / 2 二次 / 3 三次 / 10 十次 / 11 第 11 次 / 0 空串', function () {
    expect(severeOrdinalText(1)).toBe('首次触发');
    expect(severeOrdinalText(2)).toBe('二次触发');
    expect(severeOrdinalText(3)).toBe('三次触发');
    expect(severeOrdinalText(10)).toBe('十次触发');
    expect(severeOrdinalText(11)).toBe('第 11 次触发');
    expect(severeOrdinalText(0)).toBe('');
    expect(severeOrdinalText(null)).toBe('');
    expect(severeOrdinalText(-1)).toBe('');
    expect(severeOrdinalText('2')).toBe('二次触发');
  });

  it('★ 真实夹具：新华传媒 600825 首次越线那天（10-08）⇒ 首次触发', function () {
    const r = countSevereTriggers({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-08'
    });
    expect(r.ok).toBe(true);
    expect(r.ordinal).toBe(1);
    expect(r.text).toBe('首次触发');
    expect(r.tone).toBe('first');
    expect(r.count).toBeGreaterThanOrEqual(1);
    // 第一段事件必须从 10-08 起（与官方 start_date 10-09 的 −1 个交易日对齐）
    expect(r.events[0].start).toBe('2026-10-08');
  });

  it('🔴🔴 [ABN-TRIGGER-2] 同一次事件内必须逐日递增：10-09 二次、10-12 三次', function () {
    // 用户 11-16 当场纠正的就是这一条：旧实现把连续触发日合并成一次 ⇒ 三天全印「首次触发」
    const run = function (d) {
      return countSevereTriggers({
        code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: d
      });
    };
    const d09 = run('2026-10-09');
    expect(d09.ok).toBe(true);
    expect(d09.ordinal).toBe(2);
    expect(d09.text).toBe('二次触发');
    expect(d09.tone).toBe('repeat');
    // 三次以上仍是同一档色调（实心红），⛔ 不另开第三档
    const d12 = run('2026-10-12');
    expect(d12.ordinal).toBe(3);
    expect(d12.text).toBe('三次触发');
    expect(d12.tone).toBe('repeat');
    // 独立事件数（「被监管过几次」）依然是 1，与逐日序号是两个不同的数
    expect(d09.count).toBe(1);
    expect(d12.count).toBe(1);
  });

  it('官方口径差一天是【判据本身】：10-07 还不是首次（那天还没越线）', function () {
    const r = countSevereTriggers({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-07'
    });
    // 要么那天判不出（腿不够），要么判出「未触发」—— ⛔ 绝不能是「首次触发」
    expect(r.text).not.toBe('首次触发');
  });

  it('★ 逐日递增 + 断开归零 + 判不出不断链（40 日可手算构造）', function () {
    // 构造（⛔ 不用复利噪声，每天要么 0 要么一次性 +150%，便于手算）：
    //   d1~d19 平；d20 单日 +150%；d21~d39 平；d40 再来一次 +150%
    //   ⇒ 10 日窗口里只要含 d20 就 ≥ +100%（d20 ~ d29，连续 10 个触发日）
    //   ⇒ d30 起 d20 掉出 10 日窗口 ⇒ dev10 = 0 ⇒ 归零
    //   ⇒ d40 再越线 ⇒ 又从「首次」起，独立事件数变 2
    const dates = [];
    for (let i = 1; i <= 30; i++) dates.push('2026-04-' + String(i).padStart(2, '0'));
    for (let i = 1; i <= 10; i++) dates.push('2026-05-' + String(i).padStart(2, '0'));
    const pct = new Array(40).fill(0);
    pct[19] = 150;      // d20
    pct[39] = 150;      // d40
    const stockLegs = dates.map(function (d, i) { return { date: d, pct: pct[i] }; });
    const indexLegs = dates.map(function (d) { return { date: d, pct: 0 }; });
    const run = function (d) {
      return countSevereTriggers({ code: '600825', stockLegs: stockLegs, indexLegs: indexLegs, asOf: d });
    };

    // ① d20 第一次越线 ⇒ 首次触发
    const d20 = run(dates[19]);
    expect(d20.ok).toBe(true);
    expect(d20.ordinal).toBe(1);
    expect(d20.text).toBe('首次触发');
    expect(d20.tone).toBe('first');

    // ② 🔴 d25 / d29 仍在连续触发区间 ⇒ 必须累加（这次纠正的核心）
    expect(run(dates[24]).ordinal).toBe(6);
    expect(run(dates[24]).text).toBe('六次触发');
    expect(run(dates[28]).ordinal).toBe(10);
    expect(run(dates[28]).text).toBe('十次触发');

    // ③ d30 已回落 ⇒ 今天不是触发日 ⇒ 不显示标签（⛔ 不沿用上一次的序号）
    const d30 = run(dates[29]);
    expect(d30.ordinal).toBe(0);
    expect(d30.text).toBe('');
    expect(d30.count).toBe(1);

    // ④ d40 再次越线 ⇒ 归零后重新从「首次」起；独立事件数 = 2
    const d40 = run(dates[39]);
    expect(d40.ordinal).toBe(1);
    expect(d40.text).toBe('首次触发');
    expect(d40.tone).toBe('first');
    expect(d40.count).toBe(2);
    expect(d40.events[0].start).toBe(dates[19]);
    expect(d40.events[0].end).toBe(dates[28]);
    expect(d40.events[0].days).toBe(10);
    expect(d40.events[1].start).toBe(dates[39]);
  });

  it('§10：判不出【不打断】连续计数（不能证明它回落了），但当天判不出就不显示序号', function () {
    // 把 10-09 的个股腿抠掉 ⇒ 那天「判不出」（末腿缺失）⇒ 不能当成「未触发」
    // 于是 10-12 应是连续第 2 个【可判定的】触发日（10-08=1 → 10-09 判不出 → 10-12=2）；
    // 若错把判不出当归零，10-12 会掉成 1 —— 这条断言就是用来锁住这个区别的。
    const s = legsOf('600825').filter(function (l) { return l.date !== '2026-10-09'; });
    const r = countSevereTriggers({
      code: '600825', stockLegs: s, indexLegs: idxOf('600825'), asOf: '2026-10-12'
    });
    expect(r.gapDays).toBeGreaterThan(0);
    expect(r.ordinal).toBe(2);
    expect(r.text).toBe('二次触发');
    // 而「asOf 当天判不出」时，⛔ 不许拿上一次的序号冒充
    const r2 = countSevereTriggers({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-13'
    });
    expect(r2.ordinal).toBe(0);
    expect(r2.text).toBe('');
  });

  it('§10：腿不够一天都判不出 ⇒ ok=false 且 text 为空（⛔ 绝不返回「首次」）', function () {
    const few = [{ date: '2026-03-01', pct: 1 }, { date: '2026-03-02', pct: 1 }];
    const r = countSevereTriggers({ code: '600825', stockLegs: few, indexLegs: few, asOf: '2026-03-02' });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('');
    expect(r.ordinal).toBe(0);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('§10：指数腿一股都没有 / 个股腿一股都没有 ⇒ ok=false（⛔ 不拿空当「没触发」）', function () {
    const legs = [{ date: '2026-03-01', pct: 1 }];
    expect(countSevereTriggers({ code: '600825', stockLegs: legs, indexLegs: [], asOf: '2026-03-01' }).ok).toBe(false);
    expect(countSevereTriggers({ code: '600825', stockLegs: [], indexLegs: legs, asOf: '2026-03-01' }).ok).toBe(false);
    // 北交所 / 代码不全 ⇒ 官方口径不适用
    expect(countSevereTriggers({ code: '830799', stockLegs: legs, indexLegs: legs, asOf: '2026-03-01' }).ok).toBe(false);
    expect(countSevereTriggers({ code: '', stockLegs: legs, indexLegs: legs, asOf: '2026-03-01' }).ok).toBe(false);
  });

  it('title 必须交代：口径是逐日递增的复算、官方公布后会重算、判不出的天数', function () {
    const r = countSevereTriggers({
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-09'
    });
    expect(r.title).toContain('不是交易所公布的官方计数');
    expect(r.title).toContain('重新计算');
    expect(r.title).toContain('连续第几个触发日');
    expect(r.title).toContain('次独立触发');     // 「被监管几次」的信息在 title，⛔ 不上主标签
    expect(r.title).toContain('可判定');
  });

  it('默认回看窗口 = ABN_TRIGGER_LOOKBACK_DAYS；显式传 maxLookback 会被采纳', function () {
    expect(ABN_TRIGGER_LOOKBACK_DAYS).toBeGreaterThanOrEqual(30);
    const legs = [];
    for (let i = 1; i <= 60; i++) legs.push({ date: '2026-04-' + String(i).padStart(2, '0'), pct: 0 });
    const r1 = countSevereTriggers({ code: '600825', stockLegs: legs, indexLegs: legs, asOf: '2026-04-60' });
    const r2 = countSevereTriggers({
      code: '600825', stockLegs: legs, indexLegs: legs, asOf: '2026-04-60', maxLookback: 40
    });
    expect(r1.lookback).toBe(60);
    expect(r2.lookback).toBe(40);
  });
});

describe('[ABN-TRIGGER] 接线锁：默认零耗时，只有面板要才复算', function () {
  it('computeDeviation 默认不挂 trigger（§11：买点行徽标那条老路径零行为变化）', function () {
    const base = {
      code: '600825', stockLegs: legsOf('600825'), indexLegs: idxOf('600825'), asOf: '2026-10-08'
    };
    const off = computeDeviation(base);
    expect(off.trigger).toBe(null);
    expect(off.triggerText).toBe('');
    expect(off.triggerOrdinal).toBe(0);
    const on = computeDeviation(Object.assign({}, base, { withTrigger: true }));
    expect(on.trigger).toBeTruthy();
    expect(on.triggerOrdinal).toBe(1);
    expect(on.triggerText).toBe('首次触发');
    // ★ 开关不影响任何既有字段（偏离值本身必须逐字相同）
    expect(on.dev10).toBe(off.dev10);
    expect(on.dev30).toBe(off.dev30);
    expect(on.stage).toBe(off.stage);
    expect(on.badge).toBe(off.badge);
  });

  it('buildDeviationMap 透传 withTrigger；不传时一次都不多算', function () {
    const daily = new Map([['新华传媒', new Map(legsOf('600825').map(function (l) { return [l.date, l.pct]; }))]]);
    const idxMap = new Map([['sh000002', idxOf('600825')]]);
    const off = buildDeviationMap({
      names: ['新华传媒'], dailyByStock: daily, indexLegs: idxMap,
      codeOf: function () { return '600825'; }, asOf: '2026-10-08'
    });
    expect(off.map.get('新华传媒').trigger).toBe(null);
    const on = buildDeviationMap({
      names: ['新华传媒'], dailyByStock: daily, indexLegs: idxMap,
      codeOf: function () { return '600825'; }, asOf: '2026-10-08', withTrigger: true
    });
    expect(on.map.get('新华传媒').triggerOrdinal).toBe(1);
  });

  it('源码锁：composable 开启复算 + 视图与样式都接上了 trigger', function () {
    const comp = readFileSync('src/composables/useAbnormalDeviation.js', 'utf8');
    expect(comp).toContain('withTrigger: true');
    expect(comp).toContain('triggerText:');
    // 双闸门：达到标准 ∧ 复算出序号，才给文字（⛔ 不许只判一个）
    expect(comp).toContain('f.stage === DEV_STAGE_SEVERE && f.triggerOrdinal > 0');
    const vue = readFileSync('src/components/topicvolratio/TvrbDeviationBoard.vue', 'utf8');
    expect(vue).toContain('r.triggerText');
    expect(vue).toContain('tvrb-dev-trigger');
    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-dev-trigger-first');
    expect(css).toContain('.tvrb-dev-trigger-repeat');
    // ⛔ 不许用裁切来「解决」窄屏拥挤
    expect(css).not.toMatch(/\.tvrb-dev-trigger[a-z-]*\s*\{[^}]*overflow:\s*hidden/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ★ [DEV-BASIS 2026-11-24] 用户原话：「在竞价时间就可以知道它的偏离值看是否触发，所以用竞价口径，
//   等到收盘，再覆盖下，再计算……分为竞价口径和收盘口径」「再添加一个竞价口径 toggle，我点开的时候，
//   就可以看到竞价时间的看是否触发，这样我就可以对比收盘口径」。
//   ⇒ 三件事必须锁死：① 口径判据；② 竞价口径下窗口真的含「今天」；③ 口径文案如实交代算到哪一天（§10）。
// ════════════════════════════════════════════════════════════════════════════════
describe('[DEV-BASIS] 竞价口径 / 收盘口径的判据（纯函数，⛔ 不许散落在 composable）', () => {
  const TODAY = '2026-11-24';
  const base = { date: TODAY, today: TODAY, asOf: TODAY, hhmm: '09:26' };

  it('复盘历史日 ⇒ 永远收盘口径（§11 稳定复盘，⛔ 不许拿竞价涨幅去改历史）', () => {
    expect(deviationBasisFor({ ...base, date: '2026-11-21', auctionReady: true,
      closeLegReady: false, hhmm: '09:26' })).toBe('close');
    expect(deviationBasisFor({ ...base, date: '2026-11-21', auctionReady: true,
      closeLegReady: false, hhmm: '10:30' })).toBe('close');
  });

  it('今天 + 收盘腿已入库 ⇒ 收盘口径（收盘覆盖，与几点无关）', () => {
    expect(deviationBasisFor({ ...base, auctionReady: true, closeLegReady: true })).toBe('close');
    // 即便还在 9:26，只要真收盘涨幅已在库里，就用收盘腿
    expect(deviationBasisFor({ ...base, hhmm: '09:26', auctionReady: true,
      closeLegReady: true })).toBe('close');
  });

  it('今天 + 过 15:00 但收盘腿还没落库（16:00 才写）⇒ 收盘口径（靠文案交代）', () => {
    expect(DEV_CLOSE_HHMM).toBe('15:00');
    expect(deviationBasisFor({ ...base, hhmm: '15:00', auctionReady: true,
      closeLegReady: false })).toBe('close');
    expect(deviationBasisFor({ ...base, hhmm: '15:59', auctionReady: true,
      closeLegReady: false })).toBe('close');
    // 边界：14:59 仍算盘中 ⇒ 走竞价口径
    expect(deviationBasisFor({ ...base, hhmm: '14:59', auctionReady: true,
      closeLegReady: false })).toBe('auction');
  });

  it('今天 + 9:25 竞价档就绪 ⇒ 竞价口径（这才是用户要的「早上就能看」）', () => {
    expect(deviationBasisFor({ ...base, auctionReady: true, closeLegReady: false })).toBe('auction');
  });

  it('今天 + 竞价档没就绪 ⇒ close（§10 宁可显示上一交易日，也不显示假数）', () => {
    expect(deviationBasisFor({ ...base, auctionReady: false, closeLegReady: false })).toBe('close');
    expect(deviationBasisFor({ ...base })).toBe('close');
  });

  it('缺日期 ⇒ close（⛔ 不许默认成竞价，那会把历史日算错）', () => {
    expect(deviationBasisFor({})).toBe('close');
    expect(deviationBasisFor(null)).toBe('close');
    expect(deviationBasisFor({ date: '', today: TODAY, auctionReady: true })).toBe('close');
    expect(deviationBasisFor({ date: TODAY, today: '', auctionReady: true })).toBe('close');
  });

  it('口径文案必须如实交代「算到哪一天」（§10：口径不符是最坏的错）', () => {
    // 竞价口径
    expect(deviationBasisNote({ ...base, basis: 'auction', auctionReady: true }))
      .toContain('竞价口径');
    expect(deviationBasisNote({ ...base, basis: 'auction', auctionReady: true }))
      .toContain('9:25');
    // 历史日：无需提示
    expect(deviationBasisNote({ basis: 'close', asOf: '2026-11-21', today: TODAY })).toBe('');
    // 今天 + 收盘腿已到
    expect(deviationBasisNote({ ...base, basis: 'close', closeLegReady: true }))
      .toContain('收盘腿已入库');
    // 今天 + 过 15:00 还没落库 ⇒ 必须说「截至上一交易日」
    expect(deviationBasisNote({ ...base, basis: 'close', hhmm: '15:30' }))
      .toContain('上一交易日');
    // 今天 + 竞价档没就绪 ⇒ 必须说「不是没有异动」（防误读）
    expect(deviationBasisNote({ ...base, basis: 'close', hhmm: '09:26', auctionReady: false }))
      .toContain('不是「没有异动」');
  });
});

describe('[DEV-AUC-WIN] 竞价口径补腿：指数没有「今天」那根腿时，窗口会静默前移一天', () => {
  // 用真实夹具：九阳股份 002242，asOf = 2026-11-13（夹具末日）
  const legs = legsOf('002242');
  const idxFull = idxOf('002242');
  const asOf = legs[legs.length - 1].date;
  const prev = legs[legs.length - 2].date;
  const daily = new Map();
  const dayMap = new Map();
  legs.forEach(function (l) { dayMap.set(l.date, l.pct); });
  daily.set('九阳股份', dayMap);
  // 9:25 时点的真实处境：个股有今日腿（竞价涨幅），指数【没有】今日腿
  const idxNoToday = idxFull.filter(function (x) { return x.date !== asOf; });
  const codeOf = function () { return '002242'; };
  const run = function (o) {
    return buildDeviationMap(Object.assign({
      names: ['九阳股份'], dailyByStock: daily, codeOf: codeOf
    }, o)).map.get('九阳股份');
  };

  it('withIndexFlatLeg：缺则补、有则不覆盖、force 才覆盖、只动 asOf 那一天', () => {
    const src = [{ date: '2026-11-10', pct: 1 }, { date: '2026-11-11', pct: 2 }];
    // 缺 asOf ⇒ 补一根 pct=0，且升序
    const a = withIndexFlatLeg(src, '2026-11-12');
    expect(a.length).toBe(3);
    expect(a[2]).toEqual({ date: '2026-11-12', pct: 0 });
    // 已有 asOf 且 force≠true ⇒ 一根都不动（⛔ 不许悄悄改真收盘涨幅）
    const b = withIndexFlatLeg(src, '2026-11-11');
    expect(b.length).toBe(2);
    expect(b[1].pct).toBe(2);
    // force=true ⇒ 覆盖成 0（竞价时点指数还没有价格）
    const c = withIndexFlatLeg(src, '2026-11-11', 0, true);
    expect(c.length).toBe(2);
    expect(c.filter(function (x) { return x.date === '2026-11-11'; })[0].pct).toBe(0);
    // 只动 asOf 那一天：别的日期逐字保留
    expect(c[0]).toEqual({ date: '2026-11-10', pct: 1 });
    // §11：不修改入参
    expect(src.length).toBe(2);
    expect(src[1].pct).toBe(2);
    // 脏输入不炸
    expect(withIndexFlatLeg(null, '2026-11-12')).toEqual([{ date: '2026-11-12', pct: 0 }]);
    expect(withIndexFlatLeg(src, '')).toEqual(src);
    // pct 走 numOfText，兼容 DB 的 '+3.21' 文本
    expect(withIndexFlatLeg(src, '2026-11-12', '+3.21')[2].pct).toBe(3.21);
  });

  it('🔴 不补腿 ⇒ 今日竞价涨幅被窗口丢掉，数就是【上一交易日】的数（这就是原来那个 bug）', () => {
    const todayAuc = 5;   // 今日竞价 +5%
    const stale = run({ indexLegs: new Map([['sz399107', idxNoToday]]), asOf: asOf,
      todayPctOf: function () { return todayAuc; }, basis: 'auction' });
    // 上一交易日的真值（指数也没有 asOf 腿 ⇒ 窗口停在 prev）
    const prevFact = run({ indexLegs: new Map([['sz399107', idxNoToday]]), asOf: prev });
    expect(stale.dev10).toBeCloseTo(prevFact.dev10, 10);
    expect(stale.dev30).toBeCloseTo(prevFact.dev30, 10);
  });

  it('✅ 补腿后（indexTodayFlat）窗口真的含今天：今日 +5% 必须把偏离值顶上去', () => {
    const todayAuc = 5;
    const on = run({ indexLegs: new Map([['sz399107', idxNoToday]]), asOf: asOf,
      todayPctOf: function () { return todayAuc; }, basis: 'auction', indexTodayFlat: true });
    const off = run({ indexLegs: new Map([['sz399107', idxNoToday]]), asOf: asOf,
      todayPctOf: function () { return todayAuc; }, basis: 'auction' });
    // 夹具实测：off dev30=187.99（near）→ on dev30=211.24（severe）
    //   ⇒ 9:25 不补腿会把「已触发」报成「接近」，这就是用户看不到触发的原因
    expect(on.dev30).toBeGreaterThan(off.dev30);
    expect(on.dev10).toBeGreaterThan(off.dev10);
    expect(off.stage).toBe(DEV_STAGE_NEAR);
    expect(on.stage).toBe(DEV_STAGE_SEVERE);
    // 补腿 = 指数按不动计，因此结果必须与「显式把 asOf 那根指数腿写成 pct=0」逐字相等，
    //   ⛔ 不是「差不多」——差一点就说明还有别的日期被动过
    const flatIdx = withIndexFlatLeg(idxFull, asOf, 0, true);
    const anchor = run({ indexLegs: new Map([['sz399107', flatIdx]]), asOf: asOf,
      todayPctOf: function () { return 5; } });
    expect(on.dev10).toBeCloseTo(anchor.dev10, 10);
    expect(on.dev30).toBeCloseTo(anchor.dev30, 10);
  });

  it('补腿只注入「今日竞价涨幅」，不是别的数（契约锁：⛔ 别再传 10 日区间涨幅）', () => {
    const mk = function (pct) {
      return run({ indexLegs: new Map([['sz399107', idxFull]]), asOf: asOf,
        todayPctOf: function () { return pct; }, basis: 'auction', indexTodayFlat: true });
    };
    // 今日涨幅越大，10 日偏离值必须单调递增（若传错的量纲，这条会红）
    expect(mk(0).dev10).toBeLessThan(mk(5).dev10);
    expect(mk(5).dev10).toBeLessThan(mk(10).dev10);
    // taskPct 为 null（当天竞价涨幅没落库）⇒ 不替换末腿，保持收盘腿口径的数（§10 不补 0）
    const nul = run({ indexLegs: new Map([['sz399107', idxFull]]), asOf: asOf,
      todayPctOf: function () { return null; }, basis: 'auction' });
    const close = run({ indexLegs: new Map([['sz399107', idxFull]]), asOf: asOf });
    expect(nul.dev10).toBeCloseTo(close.dev10, 10);
  });
});

describe('[DEV-NEG-WARN] 负方向（杀跌）分档与文案：同一套算法、阈值与方向都反着来', () => {
  // 合成腿：连续 10 个交易日每日 −6.43%、指数每日 +0.12%
  //   （真实夹具里没有深跌票，这里只锁「方向语义」，⛔ 不当作行情结论）
  const days = [];
  let cur = new Date('2026-11-02T00:00:00Z');
  for (let k = 0; k < 10; k++) {
    const d = cur.toISOString().slice(0, 10);
    days.push(d);
    cur = new Date(cur.getTime() + 86400000);
  }
  const mk = function (pct) {
    return computeDeviation({
      code: '002148', name: '北纬科技',
      stockLegs: days.map(function (d) { return { date: d, pct: pct }; }),
      indexLegs: days.map(function (d) { return { date: d, pct: 0.12 }; }),
      asOf: days[days.length - 1]
    });
  };

  it('跌到 −50% 的 90% 以内必须进 near（原来判 ok，是漏报）', () => {
    const f = mk(-6.43);   // dev10 ≈ −49.76，距 −50% 只剩 0.24 点
    expect(f.dev10).toBeLessThan(-45);
    expect(f.stage).toBe(DEV_STAGE_NEAR);
    expect(isDeviationAlert(f)).toBe(true);
  });

  it('徽标、点差、文案三处都必须是「跌」方向，⛔ 不许出现「再涨」「距 200%」', () => {
    const f = mk(-6.43);
    expect(f.badge).toContain('-');
    expect(f.gapText).toContain('-50%');
    expect(f.gapText).not.toContain('200%');
    expect(f.gapText).toContain('再跌');
    expect(deviationNeedDir(f)).toBe('跌');
    expect(deviationNeedValueText(f)).toContain('%');
    expect(deviationNeedValueText(f)).not.toContain('+');
  });

  it('跌穿 −50% ⇒ severe（负方向的越线判据是 d ≤ 阈值，⛔ 不是 ≥）', () => {
    const f = mk(-7.0);    // dev10 ≈ −53.9
    expect(f.dev10).toBeLessThan(-50);
    expect(f.stage).toBe(DEV_STAGE_SEVERE);
    expect(f.gapText).toContain('已触发');
    // ⛔ 不许出现括号套括号：`已触发（10日（跌） -52.8%）`
    expect(f.gapText).not.toContain('（跌）');
    expect(f.gapText).toContain('10日');
    expect(f.gapText).toContain('-5');
  });

  it('正负候选不许串台：跌的票拿不到 30 日 +200% 那把尺子', () => {
    const f = mk(-6.43);
    // dev30 此时 ≈ null（只有 10 根腿），文案必须落在 10 日 / −50% 上
    expect(f.gapText).not.toContain('+200%');
    expect(f.gapText).not.toContain('距 200%');
  });
});

describe('[DEV-ST] 深市 ST / *ST 三日阈值 ±12%（沪市未核实 ⇒ 不猜）', () => {
  it('票名识别', () => {
    expect(isStName('*ST北纬')).toBe(true);
    expect(isStName('ST海航')).toBe(true);
    expect(isStName('S*ST前锋')).toBe(true);
    expect(isStName('退市海润')).toBe(true);
    expect(isStName(' st 康达')).toBe(true);
    expect(isStName('北纬科技')).toBe(false);
    expect(isStName('')).toBe(false);
    expect(isStName(null)).toBe(false);
    // ⛔ 别把「ST」出现在中间的名字当 ST
    expect(isStName('中ST科技')).toBe(false);
  });

  it('深市 0 开头 + ST ⇒ 三日 ±12%，其余两档与主板同（官方不区分 ST）', () => {
    const th = thresholdsForStock('main', '002148', '*ST北纬');
    expect(th.dev3).toBe(12);
    expect(th.dev10).toBe(100);
    expect(th.dev30).toBe(200);
    expect(th.neg10).toBe(-50);
    expect(th.neg30).toBe(-70);
    expect(DEV_THRESHOLDS_SZ_ST.dev3).toBe(12);
  });

  it('沪市 ST ⇒ 不降到 12%（对应条款未核实，§40 不猜数字）', () => {
    expect(thresholdsForStock('main', '600825', 'ST新华').dev3)
      .toBe(thresholdsForBoard('main').dev3);
  });

  it('非 ST ⇒ 与板块阈值逐字相同（零行为变化）', () => {
    expect(thresholdsForStock('main', '002148', '北纬科技'))
      .toEqual(thresholdsForBoard('main'));
    expect(thresholdsForStock('growth', '301313', '凡拓数创'))
      .toEqual(thresholdsForBoard('growth'));
    expect(thresholdsForStock('x', '002148', '北纬科技')).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ★ [DEV-BASIS-TOGGLE 2026-11-24] 用户原话：「再添加一个竞价口径 toggle，我点开的时候，
//   就可以看到竞价时间的看是否触发，这样我就可以对比收盘口径…这两个都要保存起来，
//   我以后翻开历史日期时，比较方便复盘」
//   ⇒ 四件事缺一不可：① 两套数一次算好都留着（不是点了再取数）；② 切换是纯切换；
//     ③ 视图真的接上按钮 + emit；④ 收盘后能绕过 9:25 的读缓存重新取真收盘腿。
// ════════════════════════════════════════════════════════════════════════════════
describe('[DEV-BASIS-TOGGLE] 竞价口径 toggle 的全链路（源码锁：断开任一环，这里该红）', () => {
  const comp = readFileSync('src/composables/useAbnormalDeviation.js', 'utf8');
  const board = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
  const view = readFileSync('src/views/TopicVolRatioBoard.vue', 'utf8');
  const vue = readFileSync('src/components/topicvolratio/TvrbDeviationBoard.vue', 'utf8');
  const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
  const daily = readFileSync('src/data/stock-daily-pct.js', 'utf8');

  it('两套口径一次算好、都留着（⛔ 不许「点了再取数」——那样切一次就要等一次网络）', () => {
    expect(comp).toContain('mapClose');
    expect(comp).toContain('mapAuc');
    expect(comp).toContain('basis.value === \'auction\' ? mapAuc.value : mapClose.value');
    // 竞价那套必须带 indexTodayFlat（否则今日竞价涨幅被窗口丢掉，见 [DEV-AUC-WIN]）
    expect(comp).toContain('indexTodayFlat: true');
    expect(comp).toContain('basis: \'auction\'');
    expect(comp).toContain('basis: \'close\'');
  });

  it('竞价那套的今日涨幅直接读 auc_pct_chg（⛔ 不许再传 10 日区间涨幅）', () => {
    expect(comp).toContain('_readAucPctMap');
    expect(comp).toContain('readMarketMetricsForDate');
    expect(comp).toContain('auc_pct_chg');
    // 历史留下的错误契约：todayPctOf 取 buyRangeMap.pct（10 日区间涨幅）。
    //   ⚠️ 注释里仍会提到它（讲清踩过什么坑），所以只锁【代码里有没有再用】
    expect(comp).not.toMatch(/todayPctOf:\s*buyRangeMap/);
    // 正确契约：todayPctOf 只从竞价涨幅 Map 里取
    expect(comp).toMatch(/todayPctOf:\s*function \(n\) \{\s*const v = aucMap\.get/);
  });

  it('切换是纯切换：setBasis 不再取数（零请求）', () => {
    expect(comp).toContain('function setBasis');
    expect(comp).toContain('function toggleBasis');
    expect(comp).toContain('setBasis(basis.value === \'auction\' ? \'close\' : \'auction\')');
    // setBasis 体内不许出现任何取数调用
    const body = comp.slice(comp.indexOf('function setBasis'), comp.indexOf('function toggleBasis'));
    expect(body).not.toContain('await ');
    expect(body).not.toContain('load(');
  });

  it('收盘后必须绕过 9:25 的读缓存，否则切到收盘口径还是旧数', () => {
    // ★ [PERF-DEV] 但只绕到「第一次确认今天收盘腿已入库」为止（见 [PERF-DEV] 那组）
    expect(comp).toContain('const fresh = isToday && hhmm >= DEV_CLOSE_HHMM && !_closeSeen.has(asOf)');
    // 数据层真的实现了 fresh（精确命中 + 覆盖命中 + inflight 三条都要让路）
    expect(daily).toContain('opts.fresh');
    expect(daily).toContain('_subCache');
  });

  it('面板把 toggle 接上了（按钮 + emit + 板层 handler + 视图绑定）', () => {
    expect(vue).toContain('tvrb-dev-basis-btn');
    expect(vue).toContain('@click="$emit(\'toggle-basis\')"');
    expect(vue).toContain('defineEmits([\'toggle-basis\'])');
    expect(vue).toContain(':disabled="!meta.canToggle"');
    expect(board).toContain('function toggleDeviationBasis');
    expect(board).toContain('canToggle:');
    expect(view).toContain('@toggle-basis="toggleDeviationBasis"');
    expect(view).toContain('toggleDeviationBasis');
    // 样式：窄屏允许折行，⛔ 不许用裁切解决拥挤（[DEV-LAYOUT]）
    expect(css).toContain('.tvrb-dev-basis-row');
    expect(css).toContain('.tvrb-dev-basis-btn.is-on');
    expect(css).not.toMatch(/\.tvrb-dev-basis[a-z-]*\s*\{[^}]*overflow:\s*hidden/);
  });

  it('口径变了要重算一次（version 进 watch 键），否则收盘覆盖后仍是早上那屏', () => {
    expect(board).toContain('version.value');
    expect(board).toContain('_reloadDeviation');
    // 口径判据只允许在 Logic 层，⛔ 板层不许自己判 hhmm >= '15:00'
    expect(board).not.toContain('>= DEV_CLOSE_HHMM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ★★ [DEV-AUC-WAIT 2026-11-24 用户原话]
//   「那个官方偏离值竞价口径是默认打开的（默认是竞价口径数值），这样早上我就能一眼看到竞价口径
//     进行选股判断……也就是早上 9 点 25 分左右，我就可以看到的是竞价口径，而不是昨天的收盘口径，
//     这个很重要。收盘口径只是复盘用。」
//
// 真实时点取证（11-24 `bidding_fetch_log`）：09:25:05 起抓、09:25:32 morning 收工、
// 09:26:39 ladder26、09:27:25 snapshot 补量比 ⇒ **auc_pct_chg 在 09:25:35 之后才在库里**。
// ⇒ 「9:25:10 就打开页面」那次，收盘口径是【数据还没到】而不是【判据错了】，
//   所以必须有「到货即切」的有界重试；否则会一直停在昨天的收盘数。
// ════════════════════════════════════════════════════════════════════════════════
describe('[DEV-AUC-WAIT] 早盘默认竞价口径 + 到货即切（源码锁：断开任一环这里该红）', () => {
  const comp = readFileSync('src/composables/useAbnormalDeviation.js', 'utf8');

  it('竞价窗口内、竞价档没就绪 ⇒ 有界重试（⛔ 不许常驻轮询）', () => {
    expect(comp).toContain('AUC_WAIT_MS');
    expect(comp).toContain('AUC_WAIT_MAX');
    expect(comp).toContain('AUC_WINDOW_FROM');
    expect(comp).toContain('function _scheduleAucWait');
    expect(comp).toContain('function _stopAucWait');
    // 触发条件必须三个都在：竞价窗口内 + 竞价档没就绪 + 收盘腿也没到
    expect(comp).toContain('inAucWindow && !aucReady && !closeLegReady');
    // ⛔ 不许 setInterval 常驻
    expect(comp).not.toContain('setInterval');
    // 上限必须写死（15 次 × 12s ≈ 3 分钟），超出就停
    expect(comp).toMatch(/AUC_WAIT_MAX\s*=\s*\d+/);
  });

  it('重试时不许把面板打回「读取中…」（否则每 12 秒闪一次）', () => {
    expect(comp).toContain('quiet');
    expect(comp).toContain('opt.quiet !== true');
    expect(comp).toContain('{ quiet: true }');
  });

  it('清空/切日期必须掐掉重试（⛔ 不许后台继续跑）', () => {
    const body = comp.slice(comp.indexOf('function clear()'), comp.indexOf('function clear()') + 400);
    expect(body).toContain('_stopAucWait()');
  });

  it('数据一就绪就停：竞价档就绪 / 收盘腿到了 / 非今天 都不等', () => {
    expect(comp).toContain('} else {');
    expect(comp).toContain('_stopAucWait();');
    // 历史日永远不等（复盘不需要等今日竞价）
    expect(comp).toContain('const inAucWindow = isToday && hhmm >= AUC_WINDOW_FROM');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ★ [PERF-DEV 2026-11-24 用户报障「题材量比的响应速度有些变慢了，你主要看上次的修改是否拖慢」]
//   真实链路计时（node 直连真库，14 只票）：
//     冷启动  4733ms / 11 请求 → 2162ms / 3 请求（8 个腾讯 501 消失 + 并行化）
//     热重算   545ms /  1 请求 →   17ms / 0 请求（auc 按日缓存 + daily/index 缓存命中）
// ════════════════════════════════════════════════════════════════════════════════
describe('[PERF-DEV] 重算必须 0 额外请求（会话内一次读取、反复重算）', () => {
  const comp = readFileSync('src/composables/useAbnormalDeviation.js', 'utf8');
  const daily = readFileSync('src/data/stock-daily-pct.js', 'utf8');
  const idx = readFileSync('src/data/index-daily-pct.js', 'utf8');

  it('竞价涨幅按日缓存，且【空结果不缓存】（9:25 还没落库要能重试）', () => {
    expect(comp).toContain('_aucPctCache');
    expect(comp).toContain('function _putAucCache');
    expect(comp).toContain('if (!date || !(m instanceof Map) || m.size === 0) return');
    expect(comp).toContain('const hit = _aucPctCache.get(d)');
  });

  it('fresh 只绕到「第一次确认今天收盘腿入库」为止（否则等于把缓存删了）', () => {
    expect(comp).toContain('_closeSeen');
    expect(comp).toContain('!_closeSeen.has(asOf)');
    expect(comp).toContain('if (closeLegReady) _closeSeen.add(asOf)');
    expect(daily).toContain('opts.fresh');
  });

  it('竞价涨幅与个股腿并行发（互不依赖，⛔ 别串行等）', () => {
    expect(comp).toContain('const aucPromise = _readAucPctMap(asOf)');
    expect(comp).toContain('const aucMap = await aucPromise');
    // ⛔ 不许又回到「先 await daily 再读 auc」
    expect(comp).not.toContain('await _readAucPctMap(asOf);');
  });

  it('只取这批票真正用到的对应指数（不是 4 只全取）', () => {
    expect(comp).toContain('idxCodes');
    expect(comp).toContain('readIndexLegsForDates(dates, idxCodes.length ? { codes: idxCodes } : {})');
  });

  it('腾讯兜底熔断：整批失败后 10 分钟内不再打（⛔ 每片都白打 8 个 501）', () => {
    expect(idx).toContain('_qtCooldownUntil');
    expect(idx).toContain('QT_FAIL_COOLDOWN_MS');
    expect(idx).toContain('indicesNeedingQt');
    // 旧判据（拿条数比日期数 ⇒ 前缀缺口恒为真）必须已经从【代码】里消失。
    // ⚠️ 注释里仍会写它（讲清踩过什么坑），所以只锁「有没有再这样算」。
    expect(idx).not.toMatch(/const need = DEV_INDEX_CODES\.filter/);
    expect(idx).toContain('const need = indicesNeedingQt(wantCodes, map, horizon)');
  });
});
