// vol-ratio-action.test.js — [VR-ACTION / VR-COMPARE 2026-10-02 用户口径] 回归用例
//
// 这一份钉的是【竞价量比 vs 上一交易日】这条新口径带来的全部新行为：
//   ① vol-ratio-trend：方向判定（四舍五入整数差）、箭头、标签配色档；
//   ② 卖点：低开 + 量比下降 → 一律【开盘立刻出】（⛔ 覆盖原深低开「盯盘」档）；
//            小幅高开 + 量比【没走弱】→ 【尾盘卖】（看好），量比下降 / 未知 → 保持原「看分时」；
//            深低开 + 量比【暴增】≥ 5 倍 → 【冲高就卖】（[SELL-SURGE 2026-10-03]）；
//   ③ 买点（一字模式）：量比【下降】→ 【尾盘买】；下降 + 昨天买过 → 【先卖后买】；
//            量比【增强】→ 【竞价买】（[BUY-NOW 2026-10-03]，判据只看量比方向，不再要求涨幅 < 0）；
//   ④ §10 红线：缺竞价涨幅 / 缺一天量比 ⇒ 一律【不产出】新档位，回落原逻辑，⛔ 绝不猜方向。
//
// ⚠️ 用户给的两个算例（⛔ 改口径前先拿它们对一遍）：
//   · 龙版传媒 37.28 → 36.71：四舍五入后 37 vs 37 ⇒ 差 0 ⇒ 基本平（不是下降）；
//   · 香江控股 4.86 → 2.78：四舍五入后 5 vs 3 ⇒ 差 -2 ⇒ 下降（原始差只有 2.08，
//     若按「原始差 < 5 = 平」会被判成平，与用户「明显要立刻出」直接矛盾 ⇒ 阈值只能是整数差）。
//
// ⚠️ 9/30 的两个新算例（[BUY-NOW] / [SELL-SURGE] 2026-10-03）：
//   · 大亚圣象：竞价涨幅 +0.31%，量比 38.37 → 7.90 ⇒ 下降 ⇒ 买点标【尾盘买】
//     （⛔ 它是【小幅高开】，旧「弱票」定义要求涨幅 < 0 ⇒ 拿不到徽标，正是本次要修的）；
//   · 世联行：竞价涨幅 -9.97%，量比 3.95 → 24.45 = 6.19 倍 ≥ 5 ⇒ 卖点标【冲高就卖】。

import { describe, it, expect } from 'vitest';

import {
  compareVolRatioDirection,
  compareVolRatioTimes,
  isVolRatioSurge,
  VR_SURGE_TIMES,
  volRatioArrowOf,
  volRatioToneOf,
  VR_DIR_UP,
  VR_DIR_FLAT,
  VR_DIR_DOWN,
  VR_ARROW_UP,
  VR_ARROW_DOWN
} from './vol-ratio-trend.js';

import {
  rankDecisionTopics,
  rankDragons,
  buildSellPlan,
  sellRulesLines,
  isWeakAucDay,
  BUY_LATE_TAG,
  BUY_NOW_TAG,
  SELL_FIRST_BUY_LATER_TAG,
  BUY_ACTION_TONE_LATE,
  BUY_ACTION_TONE_SWAP,
  BUY_ACTION_TONE_NOW,
  HOLD_TAG,
  POSITION_HOLD,
  SELL_TIME_CLOSE,
  SELL_TONE_DANGER,
  SELL_TONE_WATCH,
  SELL_TONE_HOLD,
  SELL_TONE_PLAN,
  SELL_TONE_SURGE,
  SELL_SURGE_LABEL
} from './decision-rules.js';

import { buildBuyPlan, buildRulesLines, RULE_NO } from './decision-rules-legacy.js';
import { MODE_YIZI } from './decision-mode.js';

/** 一字模式的题材排名（老版口径 = 竞价一字数量降序），与 decision-rules-legacy.test.js 同一包装 */
const rankByYizi = (entries) => rankDecisionTopics(entries, MODE_YIZI);

/** 样本行：多一个 volRatioDir（今日 vs 上交易日竞价量比方向） */
function E(name, topic, pct, opts) {
  const o = opts || {};
  return {
    name: name,
    topic: topic,
    pct: pct,
    isYizi: !!o.isYizi,
    countable: o.countable !== false,
    code: o.code || '',
    inheritSold: o.inheritSold === true,
    aucPct: (o.aucPct === undefined || o.aucPct === null) ? null : o.aucPct,
    aucVolRatio: (o.volRatio === undefined || o.volRatio === null) ? null : o.volRatio,
    volRatioDir: o.dir || ''
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 一、方向判定口径
// ══════════════════════════════════════════════════════════════════════════════════════
describe('compareVolRatioDirection（今日 vs 上交易日 · 四舍五入整数差）', () => {
  it('⭐ 用户算例：龙版传媒 37.28 → 36.71 = 基本平（37 vs 37，差 0）', () => {
    expect(compareVolRatioDirection('36.71', '37.28')).toBe(VR_DIR_FLAT);
  });

  it('⭐ 用户算例：香江控股 4.86 → 2.78 = 下降（5 vs 3，差 -2）', () => {
    expect(compareVolRatioDirection('2.78', '4.86')).toBe(VR_DIR_DOWN);
  });

  it('⭐ 用户算例：捷荣技术 40.37 → 15.64 = 下降；竞业达 39.09 → 124.85 = 增强', () => {
    expect(compareVolRatioDirection('15.64', '40.37')).toBe(VR_DIR_DOWN);
    expect(compareVolRatioDirection('124.85', '39.09')).toBe(VR_DIR_UP);
  });

  it('原始差 < 5 也可能判成【下降】（⛔ 阈值是整数差，不是原始差）', () => {
    // 香江控股原始差 2.08 < 5，按「原始差 < 5 = 平」会判错；整数差 5-3=2 ⇒ 下降
    expect(compareVolRatioDirection(2.78, 4.86)).toBe(VR_DIR_DOWN);
  });

  it('边界：小数抖动只要不跨整数就仍是【平】（10.49 → 10.40 差 round 0）', () => {
    expect(compareVolRatioDirection(10.40, 10.49)).toBe(VR_DIR_FLAT);
    expect(compareVolRatioDirection(10.49, 10.40)).toBe(VR_DIR_FLAT);
  });

  it('边界：跨过一个整数就算增强 / 下降（10.49 → 10.60 = +1 / 10.60 → 10.49 = -1）', () => {
    expect(compareVolRatioDirection(10.60, 10.49)).toBe(VR_DIR_UP);
    expect(compareVolRatioDirection(10.49, 10.60)).toBe(VR_DIR_DOWN);
  });

  it('§10：任一侧缺值 / 空串 / 非数字 → 空串（未知），⛔ 绝不当「平」', () => {
    expect(compareVolRatioDirection(null, 1)).toBe('');
    expect(compareVolRatioDirection(1, null)).toBe('');
    expect(compareVolRatioDirection('', '2')).toBe('');
    expect(compareVolRatioDirection('--', '2')).toBe('');
    expect(compareVolRatioDirection(undefined, undefined)).toBe('');
  });

  it('0 是有效值（量比 0 → 0.6 属于增强，不是缺数据）', () => {
    expect(compareVolRatioDirection('0.6', '0')).toBe(VR_DIR_UP);
    expect(compareVolRatioDirection('0', '0.6')).toBe(VR_DIR_DOWN);
  });
});

describe('volRatioArrowOf / volRatioToneOf（箭头与整标签配色档）', () => {
  it('增强 → ↑ 且红档；下降 → ↓ 且绿档', () => {
    expect(volRatioArrowOf(VR_DIR_UP)).toBe(VR_ARROW_UP);
    expect(volRatioArrowOf(VR_DIR_DOWN)).toBe(VR_ARROW_DOWN);
    expect(volRatioToneOf(VR_DIR_UP)).toBe('up');
    expect(volRatioToneOf(VR_DIR_DOWN)).toBe('down');
  });

  it('基本平 / 未知 → 不带箭头、不给配色档（回落靛蓝底，§10 不猜方向）', () => {
    expect(volRatioArrowOf(VR_DIR_FLAT)).toBe('');
    expect(volRatioArrowOf('')).toBe('');
    expect(volRatioArrowOf(null)).toBe('');
    expect(volRatioToneOf(VR_DIR_FLAT)).toBe('');
    expect(volRatioToneOf('')).toBe('');
  });
});

describe('compareVolRatioTimes / isVolRatioSurge（[SELL-SURGE 2026-10-03] 今日 ÷ 上交易日）', () => {
  it('⭐ 用户算例：世联行 3.95 → 24.45 = 6.19 倍（≥ 5 ⇒ 暴增）', () => {
    expect(compareVolRatioTimes('24.45', '3.95')).toBe(6.19);
    expect(isVolRatioSurge(compareVolRatioTimes('24.45', '3.95'))).toBe(true);
  });

  it('⭐ 用户算例：大亚圣象 38.37 → 7.90 = 0.21 倍（量能大幅萎缩，不是暴增）', () => {
    expect(isVolRatioSurge(compareVolRatioTimes('7.90', '38.37'))).toBe(false);
  });

  it('阈值只认 VR_SURGE_TIMES（5）：4.99 不命中 / 5 命中', () => {
    expect(VR_SURGE_TIMES).toBe(5);
    expect(isVolRatioSurge(4.99)).toBe(false);
    expect(isVolRatioSurge(5)).toBe(true);
  });

  it('⛔ 倍数 ≠ 方向：量比从 1.2 → 6.1（方向增强）也只有 5.08 倍，别拿整数差当倍数', () => {
    expect(compareVolRatioDirection('6.1', '1.2')).toBe(VR_DIR_UP);
    expect(compareVolRatioTimes('6.1', '1.2')).toBe(5.08);
  });

  it('§10：缺值 / 上交易日为 0 或负数 / 非数字 → null（未知），⛔ 绝不当 1 倍', () => {
    expect(compareVolRatioTimes(null, '3')).toBe(null);
    expect(compareVolRatioTimes('3', null)).toBe(null);
    expect(compareVolRatioTimes('3', '0')).toBe(null);
    expect(compareVolRatioTimes('3', '-1')).toBe(null);
    expect(compareVolRatioTimes('--', '3')).toBe(null);
    expect(isVolRatioSurge(null)).toBe(false);
    expect(isVolRatioSurge(0)).toBe(false);
  });
});

describe('isWeakAucDay（弱票 = 低开 + 量比下降，两处共用同一个判据 §6）', () => {
  it('低开（< 0）+ 量比下降 → true', () => {
    expect(isWeakAucDay(-3.68, VR_DIR_DOWN)).toBe(true);
    expect(isWeakAucDay(-0.01, VR_DIR_DOWN)).toBe(true);
  });

  it('只满足一个指标就不算弱票', () => {
    expect(isWeakAucDay(-1.2, VR_DIR_FLAT)).toBe(false);
    expect(isWeakAucDay(-1.2, VR_DIR_UP)).toBe(false);
    expect(isWeakAucDay(1.8, VR_DIR_DOWN)).toBe(false);
  });

  it('§10：平开 / 缺竞价涨幅 / 方向未知 → 一律 false（⛔ 未知不退化成「下降」）', () => {
    expect(isWeakAucDay(0, VR_DIR_DOWN)).toBe(false);
    expect(isWeakAucDay(null, VR_DIR_DOWN)).toBe(false);
    expect(isWeakAucDay(-1, '')).toBe(false);
    expect(isWeakAucDay(-1, null)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 二、卖点：量比方向叠加到高低开档位上
// ══════════════════════════════════════════════════════════════════════════════════════
describe('buildSellPlan · [VR-ACTION] 量比方向叠加卖点档位', () => {
  const blocks = rankDecisionTopics([
    E('T1一', 'T1', 30, { isYizi: true }),
    E('T1二', 'T1', 20, { isYizi: true }),
    E('T1三', 'T1', 10),
    E('T2一', 'T2', 9),
    E('T2二', 'T2', 8)
  ]);
  const dragon = rankDragons(blocks);

  /** 造一行卖点候选并取回它的 hint（第 3 参 = 今日 ÷ 上交易日的量比倍数，缺省 = 未知） */
  function hintOf(aucPct, dir, times) {
    const plan = buildSellPlan(
      [{
        name: 'T1三', topic: 'T1', pct: 10, inTodayList: true,
        aucPct: aucPct, volRatioDir: dir,
        volRatioTimes: (times === undefined ? null : times)
      }],
      blocks, dragon, null, null
    );
    return plan[0].items[0];
  }

  it('⭐ 弱票：低开 + 量比下降 → 开盘立刻出（❗危）', () => {
    const it = hintOf(-1.88, VR_DIR_DOWN);            // 香江控股（小低开）
    expect(it.sellHint.tone).toBe(SELL_TONE_DANGER);
    expect(it.sellHint.timeLabel).toBe('开盘立刻出');
    expect(it.sellHint.badge).toBe('❗危');
  });

  it('⭐ 弱票【覆盖】深低开档：-3.68% + 量比下降 → 立刻出（不再是「盯盘 10:00 前」）', () => {
    const it = hintOf(-3.68, VR_DIR_DOWN);            // 捷荣技术式的深低开 + 量比腰斩
    expect(it.sellHint.tone).toBe(SELL_TONE_DANGER);
    expect(it.sellHint.timeLabel).toBe('开盘立刻出');
  });

  it('深低开但量比【没】下降 → 保持原样「盯盘 · 10:00 前」', () => {
    expect(hintOf(-5, VR_DIR_FLAT).sellHint.tone).toBe(SELL_TONE_WATCH);
    expect(hintOf(-5, VR_DIR_FLAT).sellHint.timeLabel).toBe('盯盘 · 10:00 前');
    expect(hintOf(-5, VR_DIR_UP).sellHint.tone).toBe(SELL_TONE_WATCH);
    expect(hintOf(-5, '').sellHint.tone).toBe(SELL_TONE_WATCH);   // §10 未知 → 回落原档
  });

  it('⭐ 小幅高开 + 量比基本平 → 尾盘卖（看好，新增 hold 档）', () => {
    const it = hintOf(1.01, VR_DIR_FLAT);             // 龙版传媒 36.71 vs 37.28
    expect(it.sellHint.tone).toBe(SELL_TONE_HOLD);
    expect(it.sellHint.timeLabel).toBe('尾盘卖 · ' + SELL_TIME_CLOSE);
  });

  it('小幅高开 + 量比【增强】→ 同样尾盘卖（更强，没理由早走）', () => {
    expect(hintOf(1.5, VR_DIR_UP).sellHint.tone).toBe(SELL_TONE_HOLD);
  });

  it('小幅高开 + 量比【下降 / 未知】→ 保持原样「看分时定」（用户口径「按原来的不变」）', () => {
    expect(hintOf(1.01, VR_DIR_DOWN).sellHint.tone).toBe(SELL_TONE_PLAN);
    expect(hintOf(1.01, VR_DIR_DOWN).sellHint.timeLabel).toBe('看分时定');
    expect(hintOf(1.01, '').sellHint.tone).toBe(SELL_TONE_PLAN);
  });

  it('§10：缺竞价涨幅 / ≥ +3% → 不产提示（回落题材排名时点）', () => {
    expect(hintOf(null, VR_DIR_DOWN).sellHint).toBe(null);
    expect(hintOf(4, VR_DIR_FLAT).sellHint).toBe(null);
  });

  // ══ [SELL-SURGE 2026-10-03 用户口径] 深低开 + 量比暴增 → 【冲高就卖】══
  it('⭐ 9/30 世联行：-9.97% ＋ 量比 3.95 → 24.45（6.19 倍 ≥ 5）→ 【冲高就卖】', () => {
    const it = hintOf(-9.97, VR_DIR_UP, 6.19);
    expect(it.sellHint.tone).toBe(SELL_TONE_SURGE);
    expect(it.sellHint.timeLabel).toBe(SELL_SURGE_LABEL);
    expect(it.sellHint.badge).toBe('冲');
    expect(it.sellHint.text).toContain('6.19');
    expect(it.sellHint.text).toContain('耐心等待冲高');
  });

  it('深低开 + 量比【刚好 5 倍】→ 命中（阈值取 ≥，用户口径「5 倍以上」）', () => {
    expect(hintOf(-4, VR_DIR_UP, 5).sellHint.tone).toBe(SELL_TONE_SURGE);
  });

  it('深低开 + 量比只放大 4.9 倍（< 5）→ 不命中，仍是「盯盘 · 10:00 前」', () => {
    const it = hintOf(-4, VR_DIR_UP, 4.9);
    expect(it.sellHint.tone).toBe(SELL_TONE_WATCH);
    expect(it.sellHint.timeLabel).toBe('盯盘 · 10:00 前');
  });

  it('§10：倍数未知（null）→ 不命中，回落深低开档（⛔ 未知 ≠ 暴增）', () => {
    expect(hintOf(-9.97, VR_DIR_UP, null).sellHint.tone).toBe(SELL_TONE_WATCH);
  });

  it('⭐ 弱票（低开 + 量比下降）优先级更高：即便量比也放大了 → 仍是【开盘立刻出】', () => {
    const it = hintOf(-4, VR_DIR_DOWN, 8);
    expect(it.sellHint.tone).toBe(SELL_TONE_DANGER);
    expect(it.sellHint.timeLabel).toBe('开盘立刻出');
  });

  it('小幅高开不受本档影响（只有深低开才谈「等冲高」）', () => {
    expect(hintOf(1.01, VR_DIR_UP, 9).sellHint.tone).toBe(SELL_TONE_HOLD);
  });

  it('⭐ 持有 / 加仓 + 弱票 → 改用【先卖后买】，且【照常给】卖点提示（它的动作就是先卖）', () => {
    const plan = buildSellPlan(
      [{ name: 'T1三', topic: 'T1', pct: 10, inTodayList: true, aucPct: -3.36, volRatioDir: VR_DIR_DOWN }],
      blocks, dragon, null, new Set(['T1三'])          // 今天又出现在买点里
    );
    const it = plan[0].items[0];
    expect(it.holdTag).toBe('');                       // ⛔ 不再是「持有 / 加仓」
    expect(it.buyActionTag).toBe(SELL_FIRST_BUY_LATER_TAG);
    expect(it.buyActionTone).toBe(BUY_ACTION_TONE_SWAP);
    expect(it.sellHint).not.toBe(null);                // 先卖 → 这一行必须给卖点节奏
    expect(it.sellHint.timeLabel).toBe('开盘立刻出');
  });

  it('持有 / 加仓 + 强票（高开 + 量比增强）→ 保持【持有 / 加仓】，且不产卖点提示', () => {
    const plan = buildSellPlan(
      [{ name: 'T1三', topic: 'T1', pct: 10, inTodayList: true, aucPct: 1.8, volRatioDir: VR_DIR_UP }],
      blocks, dragon, null, new Set(['T1三'])
    );
    const it = plan[0].items[0];
    expect(it.holdTag).toBe(HOLD_TAG);
    expect(it.buyActionTag).toBe('');
    expect(it.sellHint).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 三、买点（一字模式）：尾盘买 / 先卖后买
// ══════════════════════════════════════════════════════════════════════════════════════
describe('buildBuyPlan · [VR-ACTION ⑭] 一字模式买点的尾盘买 / 先卖后买', () => {
  /**
   * 造一个「第 1 名题材 = T1、恰好 1 个竞价一字、龙一 = 指定强弱」的买点方案。
   * T1 共 6 只（> 4，避开 ⑥ 小题材兜底），龙一由 pct 最高确定。
   */
  function planWith(leaderOpts, opts) {
    const blocks = rankByYizi([
      E('一字甲', 'T1', 60, { isYizi: true }),
      E('龙一', 'T1', 50, leaderOpts),
      E('龙二', 'T1', 40, { aucPct: 1.2, dir: VR_DIR_UP }),
      E('龙三', 'T1', 30, { aucPct: 0.8, dir: VR_DIR_FLAT }),
      E('龙四', 'T1', 20, { aucPct: 0.5, dir: VR_DIR_UP }),
      E('龙五', 'T1', 10, { aucPct: 0.3, dir: VR_DIR_FLAT }),
      E('b1', 'T2', 5, { aucPct: 0.4, dir: VR_DIR_FLAT }),
      E('b2', 'T2', 4, { aucPct: 0.4, dir: VR_DIR_FLAT })
    ]);
    return buildBuyPlan(blocks, rankDragons(blocks), opts || {});
  }

  /** 在方案里找某只票（heavy / light 两块都找） */
  function pickOf(plan, name) {
    const all = [];
    ['heavy', 'light'].forEach(function(k) {
      const b = plan[k];
      if (b && b.picks) b.picks.forEach(function(p) { all.push(p); });
    });
    return all.filter(function(p) { return p.name === name; })[0] || null;
  }

  it('⭐ 弱票（低开 + 量比下降）+ 手上没有 → 【尾盘买】', () => {
    const plan = planWith({ aucPct: -3.68, dir: VR_DIR_DOWN });
    const p = pickOf(plan, '龙一');
    expect(p).not.toBe(null);
    expect(p.buyActionTag).toBe(BUY_LATE_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_LATE);
  });

  it('⭐ 弱票 + 手上已有（昨有买入 → 行尾是【加仓】）→ 【先卖后买】', () => {
    const plan = planWith({ aucPct: -3.36, dir: VR_DIR_DOWN },
      { prevBoughtNames: new Set(['龙一']) });
    const p = pickOf(plan, '龙一');
    expect(p.position).toBe(POSITION_HOLD);             // 判据：昨天真被打过「买」标签
    expect(p.buyActionTag).toBe(SELL_FIRST_BUY_LATER_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_SWAP);
  });

  // ⚠️ [BUY-NOW 2026-10-03] 判据已由「弱票（涨幅 < 0 + 量比下降）」改为【只看量比方向】，
  //    所以「高开 + 量比增强」不再是「不标」，而是【竞价买】—— 见下面那条新用例。
  it('⭐ 量比【增强】→ 【竞价买】（有人在抢筹，竞价就得买）', () => {
    const plan = planWith({ aucPct: 1.8, dir: VR_DIR_UP });
    const p = pickOf(plan, '龙一');
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_NOW);
  });

  it('⭐ 9/30 大亚圣象：小幅高开 +0.31% ＋ 量比【下降】→ 【尾盘买】', () => {
    // 旧判据要求「竞价涨幅 < 0」⇒ +0.31% 拿不到徽标，正是本次要修的（用户口径）
    const plan = planWith({ aucPct: 0.31, dir: VR_DIR_DOWN });
    const p = pickOf(plan, '龙一');
    expect(p.buyActionTag).toBe(BUY_LATE_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_LATE);
  });

  it('⭐ 竞价涨幅缺失但量比【下降】→ 照样标【尾盘买】（判据只看量比方向）', () => {
    const plan = planWith({ aucPct: null, dir: VR_DIR_DOWN });
    expect(pickOf(plan, '龙一').buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('§10：量比方向未知 → 不标（⛔ 未知 ≠ 增强，也 ≠ 下降）', () => {
    expect(pickOf(planWith({ aucPct: -2, dir: '' }), '龙一').buyActionTag).toBeFalsy();
    expect(pickOf(planWith({ aucPct: 1.8, dir: '' }), '龙一').buyActionTag).toBeFalsy();
  });

  it('低开但量比【基本平】→ 不标（两个指标必须同时走弱）', () => {
    expect(pickOf(planWith({ aucPct: -2, dir: VR_DIR_FLAT }), '龙一').buyActionTag).toBeFalsy();
  });

  it('★ 规则编号与文案：⑭ 与三个徽标文案对得上（§6 规则与说明同处一处）', () => {
    expect(RULE_NO.BUY_ACTION).toBe('⑭');
    const lines = buildRulesLines().join('\n');
    expect(lines).toContain('⑭');
    expect(lines).toContain(BUY_NOW_TAG);
    expect(lines).toContain(BUY_LATE_TAG);
    expect(lines).toContain(SELL_FIRST_BUY_LATER_TAG);
  });

  it('★ 说明文字里也写到了量比方向（红底 ↑ / 绿底 ↓ / 平不带箭头）', () => {
    const lines = buildRulesLines().join('\n');
    expect(lines).toContain('↑');
    expect(lines).toContain('↓');
    expect(lines).toContain('四舍五入');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 四、规则说明文案（卖点段，两模式共用）
// ══════════════════════════════════════════════════════════════════════════════════════
describe('sellRulesLines · [VR-ACTION] 卖点文案与实现同步', () => {
  const text = sellRulesLines().join('\n');

  it('写清了「低开 + 量比下降 → 立刻出」且标明【覆盖】深低开档', () => {
    expect(text).toContain('弱票');
    expect(text).toContain('覆盖');
    expect(text).toContain('立刻出');
  });

  it('写清了「小幅高开 + 量比平/增强 → 尾盘卖」与「下降/未知 → 看分时」', () => {
    expect(text).toContain('尾盘卖');
    expect(text).toContain('看分时');
  });

  it('★ [SELL-SURGE 2026-10-03] 写清了「深低开 + 量比暴增 ≥ 5 倍 → 冲高就卖」', () => {
    expect(text).toContain(SELL_SURGE_LABEL);
    expect(text).toContain('≥ ' + VR_SURGE_TIMES + ' 倍');
    expect(text).toContain('冲高的概率非常高');
  });

  it('写清了【先卖后买】的适用条件（弱票 + 今天又在买点里）', () => {
    expect(text).toContain(SELL_FIRST_BUY_LATER_TAG);
    expect(text).toContain(HOLD_TAG);
  });

  it('把量比方向的口径（四舍五入整数差）写进条文，方便用户逐条核对', () => {
    expect(text).toContain('四舍五入');
    expect(text).toContain('增强');
    expect(text).toContain('下降');
  });
});
