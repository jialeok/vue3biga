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
import { describe, it, expect } from 'vitest';
import fx from './abnormal-dev-cases.json';
import {
  DEV_INDEX, DEV_INDEX_CODES, DEV_THRESHOLDS, DEV_NEAR_RATIO, DEV_WATCH_RATIO,
  DEV_STAGE_OK, DEV_STAGE_WATCH, DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_STAGE_UNKNOWN,
  STAGE_TEXT, STAGE_TONE,
  pickBaseIndexForCode, devIndexName, thresholdsForBoard,
  cumulativeDeviation, needGainToThreshold, classifyDeviation,
  computeDeviation, devText, needText, deviationBadge, deviationGapText,
  deviationDetailLine, isDeviationSevere, isDeviationAlert
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
    expect(f.badge).toMatch(/^30日偏离 \+199\.\d%$/);
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
    expect(line).toContain('自核：30 日偏离 = 个股区间涨幅');
    expect(line).toContain('股价每再涨 1%，偏离约增加');
    expect(line).toContain('口径：截至最近一个收盘日');
    const auc = deviationDetailLine(Object.assign({}, s, { basis: 'auction' }));
    expect(auc).toContain('9:25 竞价');
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
