// deviation-rule-facts.test.js — 「官方偏离值 → 选股规则信号」适配层的单测
//
// ★★ [DEV-RULE 2026-11-25 用户口径] 本文件锁的是【新尺子】：
//   · near  = 逼近交易所偏离红线（红线 × 0.9）⇒ 只这一只不给买点（第三十六条）
//   · severe= 已达严重异常波动（≥ 红线）    ⇒ 第三十四条全场空仓 / 三十六·b 异动卖
//   · watch = 偏离放大（留意）              ⇒ **用户明确不算**（「这个不是很严重」）⇒ 一律 ''
//
// ⚠️ 这里刻意**不手写 stage**：档位一律由真实 `computeDeviation` 从逐日腿算出来，
//   再用 `deviationRuleStage` 映射。若哪天有人把阈值 / 档位改错，这组用例会一起红
//   （手写夹具的测试拦不住「stage 与数字不一致」这类错，§15 判据必须可单测）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeDeviation, DEV_THRESHOLDS, DEV_NEAR_RATIO, DEV_WATCH_RATIO
} from './abnormal-deviation.js';
import {
  deviationRuleStage, isDeviationRuleHit, isDeviationOverRedLine, deviationStageText,
  pickSevereDeviation, deviationRuleBuyNote, deviationSellNote, deviationRuleGapText,
  DEV_NEAR_RULE_TAG, DEVIATION_SELL_TAG, DEVIATION_SELL_TONE, DEV_RULE_NO,
  DEV_OFFICIAL_RED_LINE_10D, DEV_OFFICIAL_RED_LINE_30D, DEV_RULE_NONE,
  DEV_RULE_NEAR, DEV_RULE_SEVERE
} from './deviation-rule-facts.js';

// ── 造腿：n 个交易日，每天都是同一个涨幅；指数一律 0%（= 偏离值＝个股区间涨幅）──────
const D = function (i) { return '2026-11-' + String(i).padStart(2, '0'); };
function legs(n, pct) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ date: D(i), pct: pct });
  return out;
}
/** 沪主板（600xxx ⇒ 对应指数 sh000002）；indexPct 缺省 0 ⇒ 偏离值 = 个股复利区间涨幅 */
function factOf(code, days, pct) {
  const n = Math.max(days, 3);
  return computeDeviation({
    code: code || '600001',
    stockLegs: legs(n, pct),
    indexLegs: legs(n, 0),
    asOf: D(n)
  });
}

describe('阈值与档位常量（⛔ 只认一个来源）', () => {
  it('红线 = 交易所严重异常波动：10日 +100% / 30日 +200%', () => {
    expect(DEV_OFFICIAL_RED_LINE_10D).toBe(100);
    expect(DEV_OFFICIAL_RED_LINE_30D).toBe(200);
    // 必须与 abnormal-deviation 的阈值表同源（⛔ 不是抄一份数字）
    expect(DEV_OFFICIAL_RED_LINE_10D).toBe(DEV_THRESHOLDS.main.dev10);
    expect(DEV_OFFICIAL_RED_LINE_30D).toBe(DEV_THRESHOLDS.main.dev30);
  });

  it('逼近系数 = 0.9；留意系数 = 0.7（留意不参与规则）', () => {
    expect(DEV_NEAR_RATIO).toBe(0.9);
    expect(DEV_WATCH_RATIO).toBe(0.7);
  });

  it('标签 / 编号 / 色调是唯一来源（视图与规则层都从这里取）', () => {
    expect(DEV_NEAR_RULE_TAG).toBe('逼近红线不买');
    expect(DEVIATION_SELL_TAG).toBe('异动卖');
    expect(DEVIATION_SELL_TONE).toBe('dev-sell');
    expect(DEV_RULE_NO).toBe('36');
  });
});

describe('deviationRuleStage · 真实偏离值 → 规则档位', () => {
  it('正常（dev10 ≈ +34%）⇒ 不进规则', () => {
    const f = factOf('600001', 10, 3);
    expect(f.ok).toBe(true);
    expect(deviationRuleStage(f)).toBe(DEV_RULE_NONE);
    expect(isDeviationRuleHit(f)).toBe(false);
    expect(isDeviationOverRedLine(f)).toBe(false);
  });

  it('★ 偏离放大（watch，红线 ×0.7）⇒ 不进规则（用户：「这个不是很严重」）', () => {
    const f = factOf('600001', 10, 5.5);       // 1.055^10 ≈ 1.708 ⇒ dev10 ≈ 70.8%
    expect(f.stage).toBe('watch');
    expect(deviationRuleStage(f)).toBe(DEV_RULE_NONE);
    expect(deviationStageText(f)).toBe('');
  });

  it('逼近（near，红线 ×0.9）⇒ near；未越线', () => {
    const f = factOf('600001', 10, 6.7);       // 1.067^10 ≈ 1.911 ⇒ dev10 ≈ 91.1%
    expect(f.stage).toBe('near');
    expect(deviationRuleStage(f)).toBe(DEV_RULE_NEAR);
    expect(isDeviationRuleHit(f)).toBe(true);
    expect(isDeviationOverRedLine(f)).toBe(false);   // ★ 只有 severe 才算越线（全场空仓）
  });

  it('已达红线（severe）⇒ severe + 越线', () => {
    const f = factOf('600001', 10, 7.2);       // 1.072^10 ≈ 2.005 ⇒ dev10 ≈ +100.5%
    expect(f.stage).toBe('severe');
    expect(deviationRuleStage(f)).toBe(DEV_RULE_SEVERE);
    expect(isDeviationOverRedLine(f)).toBe(true);
  });

  it('30 日窗口越线（10 日没越）也算 severe', () => {
    const f = factOf('600001', 30, 3.8);       // 1.038^30 ≈ 3.056 ⇒ dev30 ≈ +205.6%
    expect(f.dev30).toBeGreaterThan(200);
    expect(f.dev10).toBeLessThan(100);
    expect(deviationRuleStage(f)).toBe(DEV_RULE_SEVERE);
  });

  it('§10：判不出（ok=false / 缺腿）⇒ 空档位（⛔ 不是「安全」）', () => {
    expect(deviationRuleStage(null)).toBe(DEV_RULE_NONE);
    expect(deviationRuleStage(undefined)).toBe(DEV_RULE_NONE);
    expect(deviationRuleStage({})).toBe(DEV_RULE_NONE);
    expect(deviationRuleStage({ ok: false, stage: 'severe' })).toBe(DEV_RULE_NONE);
    // 指数腿一条都没有 ⇒ computeDeviation 判不出
    const f = computeDeviation({ code: '600001', stockLegs: legs(10, 12), indexLegs: [], asOf: D(10) });
    expect(f.ok).toBe(false);
    expect(deviationRuleStage(f)).toBe(DEV_RULE_NONE);
  });

  it('北交所（无对应指数）⇒ 判不出 ⇒ 不进规则（⛔ 不猜指数）', () => {
    const f = computeDeviation({ code: '830001', stockLegs: legs(10, 12), indexLegs: legs(10, 0), asOf: D(10) });
    expect(f.ok).toBe(false);
    expect(deviationRuleStage(f)).toBe(DEV_RULE_NONE);
  });
});

describe('pickSevereDeviation · 触发源（越线最严重的那一只）', () => {
  it('只收 severe；near / ok / 判不出都不算', () => {
    const m = new Map([
      ['正常票', factOf('600001', 10, 3)],
      ['逼近票', factOf('600002', 10, 6.7)],
      ['越线票', factOf('600003', 10, 7.2)]
    ]);
    const hit = pickSevereDeviation(m);
    expect(hit).not.toBe(null);
    expect(hit.name).toBe('越线票');
  });

  it('多只越线 ⇒ 按「归一化超线倍数」取最严重的（10日 vs 30日 各自除以自己的红线）', () => {
    const m = new Map([
      ['十日越线', factOf('600001', 10, 7.2)],        // dev10/100 ≈ 1.005
      ['三十日越线', factOf('600002', 30, 3.8)]       // dev30/200 ≈ 1.028 ⇒ 更严重
    ]);
    expect(pickSevereDeviation(m).name).toBe('三十日越线');
  });

  it('isEligible 可收窄（第三十四条只认主板 ⇒ 创业板越线不算它的触发源）', () => {
    const m = new Map([
      ['创业板票', factOf('300001', 10, 7.2)],
      ['主板票', factOf('600002', 10, 7.2)]
    ]);
    const hit = pickSevereDeviation(m, {
      isEligible: function (name) { return name === '主板票'; }
    });
    expect(hit.name).toBe('主板票');
  });

  it('一只都没越线 ⇒ null（⛔ 不许拿「最高的那只」冒充）', () => {
    const m = new Map([['逼近票', factOf('600002', 10, 6.7)]]);
    expect(pickSevereDeviation(m)).toBe(null);
    expect(pickSevereDeviation(new Map())).toBe(null);
    expect(pickSevereDeviation(null)).toBe(null);
  });

  it('也接受 fact 数组（元素带 name）', () => {
    const f = factOf('600003', 10, 7.2);
    const hit = pickSevereDeviation([Object.assign({ name: '越线票' }, f)]);
    expect(hit.name).toBe('越线票');
  });
});

describe('文案（§21：视图零计算，文案在 Logic 层拼好）', () => {
  it('买点说明必须能独立看懂：档位 + 两个窗口 + 红线 + 口径 + 「不给买点」', () => {
    // ★ 用 30 天腿：要同时验「10日 / 30日 两个窗口都写进说明」，10 天腿算不出 dev30
    const f = factOf('600001', 30, 3.8);
    const t = deviationRuleBuyNote(f, { basis: 'auction' });
    expect(t).toContain(DEV_NEAR_RULE_TAG);
    expect(t).toContain('第' + DEV_RULE_NO + '条');
    expect(t).toContain('10日偏离');
    expect(t).toContain('30日偏离');
    expect(t).toContain('+100%');
    expect(t).toContain('9:25 竞价');
    expect(t).toContain('不给买点');
    // 收盘口径要换个说法（⛔ 不许任何口径都写「9:25 竞价」）
    expect(deviationRuleBuyNote(f, { basis: 'close' })).toContain('收盘');
  });

  it('不进规则的票 ⇒ 文案为空串（⛔ 别给正常票挂一句解释）', () => {
    expect(deviationRuleBuyNote(factOf('600001', 10, 3))).toBe('');
    expect(deviationRuleBuyNote(factOf('600001', 10, 5.5))).toBe('');
    expect(deviationSellNote(factOf('600001', 10, 3))).toBe('');
  });

  it('卖点说明必须写「当天出掉」+ 原本的动作（对照用）', () => {
    const f = factOf('600001', 10, 6.7);
    const t = deviationSellNote(f, { basis: 'auction', prevActionText: '竞价卖' });
    expect(t).toContain(DEVIATION_SELL_TAG);
    expect(t).toContain('当天出掉');
    expect(t).toContain('原本'.slice(0, 0) + '原卖点动作：竞价卖');
    expect(t).toContain('9:25 竞价口径');
  });

  it('§10 缺口说明：算出几只 / 共几只（⛔ 不许静默当成安全）', () => {
    const m = new Map([
      ['算出的', factOf('600001', 10, 3)],
      ['判不出的', { ok: false, dev10: null, dev30: null, stage: 'unknown' }]
    ]);
    const t = deviationRuleGapText(m);
    expect(t).toContain('1/2');
    expect(t).toContain('没有施加');
    expect(t).toContain('不是「已确认安全」');
    // 全算得出 / 空 Map ⇒ 无提示
    expect(deviationRuleGapText(new Map([['a', factOf('600001', 10, 3)]]))).toBe('');
    expect(deviationRuleGapText(new Map())).toBe('');
    expect(deviationRuleGapText(null)).toBe('');
  });
});

describe('源码静态锁：旧口径的坑不许复活', () => {
  const src = readFileSync('src/logic/auction/deviation-rule-facts.js', 'utf8');

  it('⛔ 不许在本文件里重新写死 100 / 200 / 0.9', () => {
    expect(src).not.toMatch(/DEV_OFFICIAL_RED_LINE_10D\s*=\s*100/);
    expect(src).not.toMatch(/DEV_OFFICIAL_RED_LINE_30D\s*=\s*200/);
    expect(src).not.toMatch(/DEV_NEAR_RATIO\s*=\s*0\.9/);
    // 只能从 abnormal-deviation 取
    expect(src).toContain('DEV_THRESHOLDS.main.dev10');
    expect(src).toContain('DEV_THRESHOLDS.main.dev30');
  });

  it('⛔ watch（偏离放大 · 留意）永远不进规则', () => {
    expect(src).toMatch(/ok \/ watch \/ unknown ⇒ 不进规则|watch[\s\S]{0,20}不进规则/);
  });
});
