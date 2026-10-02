// decision-mode.test.js — 「决策」看板【两套买点模式】的分派点回归用例
//
// [TWO-MODES 2026-10-02 用户口径] 用户要「两种方式并存、互斥、可对比」：
//   · 早盘竞价「题材」toggle 打开 → 决策看板走【量比模式】（题材按平均竞价量比排名 + 三步买点）；
//   · 早盘竞价「一字」toggle 打开 → 决策看板走【一字模式】（题材按竞价一字数量排名 + 老版完整买点）。
//
// 本文件钉住【分派】这件事本身（业务规则分别由 decision-rules.test.js /
// decision-rules-legacy.test.js 覆盖）：
//   ① resolveDecisionMode 的四态（含「两个 toggle 都关」这个必须确定的兜底态）；
//   ② rankDecisionTopics / buildBuyPlan / buildRulesLines 按 mode 真的换了一套；
//   ③ 两套模式对 UI 的【结构契约完全一致】（六键齐全、candidates 恒为数组）——
//      ⛔ 契约一破，DecisionBoard.vue 就会在某种模式下崩，而那正是用户最难自查的场景；
//   ④ needsLadderData：一字模式【按需】采连板天梯（老版两条兜底要用），量比模式【永不】采。
//
// ⚠️ 断言的形状刻意取 `plan.heavy.block.topic`：两套实现的 heavy 都是这个形状
//    （decision-rules.js / decision-rules-legacy.js 都是 `{block, mode, picks, ...}`），
//    §6 单一真相 —— 两模式共用同一个 UI 渲染分支。

import { describe, it, expect } from 'vitest';
import {
  MODE_VOL_RATIO,
  MODE_YIZI,
  normalizeDecisionMode,
  resolveDecisionMode,
  rankDecisionTopics,
  buildBuyPlan,
  buildRulesLines,
  needsLadderData
} from './decision-mode.js';
import { rankDragons, sellRulesLines } from './decision-rules.js';

/**
 * 造一行「决策看板」输入（字段口径见 decision-rules.js#rankDecisionTopics 的 JSDoc）。
 * @param {string} name  股票名
 * @param {string} topic 题材名
 * @param {{pct?:number, isYizi?:boolean, countable?:boolean, aucPct?:number|null,
 *          vol?:number|null, code?:string}} [o]
 *        pct 十日涨幅（排龙位用）｜isYizi 竞价一字｜countable 是否计入题材数量（false = 灰行）
 *        aucPct 当日竞价涨幅（%），默认 +1（高开，让老版第 2 名题材能选出票）
 *        vol 当日竞价量比（量比模式的选票唯一依据）
 */
function E(name, topic, o) {
  const opt = o || {};
  return {
    name: name,
    topic: topic,
    pct: opt.pct === undefined ? 10 : opt.pct,
    isYizi: !!opt.isYizi,
    countable: opt.countable !== false,
    aucPct: opt.aucPct === undefined ? 1 : opt.aucPct,
    aucVolRatio: opt.vol === undefined ? null : opt.vol,
    code: opt.code || ''
  };
}

// ══════════════════════════════════════════════════════════════════════════════════
// 共用样本：三个题材，刻意让【两种口径给出的组序完全不同】
//   TA：4 只、0 个一字、平均竞价量比 100  → 量比模式排第 1，一字模式排最后
//   TB：4 只、3 个一字、平均竞价量比 1    → 一字模式排第 1，量比模式排最后
//   TC：5 只、2 个一字、平均竞价量比 5    → 两模式都排第 2
// 三个题材数量都 ≥ 4（PICK_TIER_MIN_COUNT）⇒ 都进入决策范围、都能出票，
//   于是「第 1 名是谁」这件事就只由【排序口径】决定 —— 正好用来证明分派真的生效。
// ══════════════════════════════════════════════════════════════════════════════════
const ENTRIES = [
  E('A一', 'TA', { pct: 40, vol: 100 }), E('A二', 'TA', { pct: 30, vol: 100 }),
  E('A三', 'TA', { pct: 20, vol: 100 }), E('A四', 'TA', { pct: 10, vol: 100 }),
  E('B一', 'TB', { pct: 40, isYizi: true, vol: 1 }),
  E('B二', 'TB', { pct: 30, isYizi: true, vol: 1 }),
  E('B三', 'TB', { pct: 20, isYizi: true, vol: 1 }),
  E('B四', 'TB', { pct: 10, vol: 1 }),
  E('C一', 'TC', { pct: 50, isYizi: true, vol: 5 }),
  E('C二', 'TC', { pct: 40, isYizi: true, vol: 5 }),
  E('C三', 'TC', { pct: 30, vol: 5 }),
  E('C四', 'TC', { pct: 20, vol: 5 }),
  E('C五', 'TC', { pct: 10, vol: 5 })
];

describe('resolveDecisionMode（早盘竞价排序状态 → 决策看板买点模式）', () => {
  it('一字 toggle 打开（byTopic + topicOrderBy=yizi）→ 一字模式', () => {
    expect(resolveDecisionMode({ byTopic: true, topicOrderBy: MODE_YIZI })).toBe(MODE_YIZI);
  });

  it('题材 toggle 打开（byTopic + topicOrderBy=volRatio）→ 量比模式', () => {
    expect(resolveDecisionMode({ byTopic: true, topicOrderBy: MODE_VOL_RATIO })).toBe(MODE_VOL_RATIO);
  });

  it('两个题材 toggle 都关 → 量比模式（⛔ 决策看板必须永远有确定口径，不能空着）', () => {
    // 要点：topicOrderBy 还留着 'yizi'（关闭 toggle 时【保留口径】供下次打开），
    //   但 byTopic=false ⇒ 一字 toggle 并没生效 ⇒ 必须回落量比模式。
    expect(resolveDecisionMode({ byTopic: false, topicOrderBy: MODE_YIZI })).toBe(MODE_VOL_RATIO);
  });

  it('入参缺失 / 形状不对 / 未知口径 → 一律量比模式（§10 不抛错，本函数跑在 computed 里）', () => {
    expect(resolveDecisionMode(undefined)).toBe(MODE_VOL_RATIO);
    expect(resolveDecisionMode(null)).toBe(MODE_VOL_RATIO);
    expect(resolveDecisionMode({})).toBe(MODE_VOL_RATIO);
    expect(resolveDecisionMode({ byTopic: true })).toBe(MODE_VOL_RATIO);
    expect(resolveDecisionMode({ byTopic: true, topicOrderBy: '字一' })).toBe(MODE_VOL_RATIO);
    expect(resolveDecisionMode({ byTopic: true, topicOrderBy: 1 })).toBe(MODE_VOL_RATIO);
  });
});

describe('normalizeDecisionMode', () => {
  it('只有 MODE_YIZI 被认作一字模式，其余（含 undefined / null / 拼错 / 非字符串）一律量比', () => {
    expect(normalizeDecisionMode(MODE_YIZI)).toBe(MODE_YIZI);
    expect(normalizeDecisionMode(MODE_VOL_RATIO)).toBe(MODE_VOL_RATIO);
    expect(normalizeDecisionMode(undefined)).toBe(MODE_VOL_RATIO);
    expect(normalizeDecisionMode(null)).toBe(MODE_VOL_RATIO);
    expect(normalizeDecisionMode('')).toBe(MODE_VOL_RATIO);
    expect(normalizeDecisionMode('YIZI')).toBe(MODE_VOL_RATIO);
    expect(normalizeDecisionMode('bogus')).toBe(MODE_VOL_RATIO);
  });
});

describe('rankDecisionTopics（按模式换题材排序口径）', () => {
  it('量比模式：题材按【平均竞价量比】降序', () => {
    const blocks = rankDecisionTopics(ENTRIES, MODE_VOL_RATIO);
    expect(blocks.map(b => b.topic)).toEqual(['TA', 'TC', 'TB']);
    expect(blocks[0].rank).toBe(1);
  });

  it('一字模式：题材按【竞价一字数量】降序（老版口径，一字多的题材在前）', () => {
    const blocks = rankDecisionTopics(ENTRIES, MODE_YIZI);
    expect(blocks.map(b => b.topic)).toEqual(['TB', 'TC', 'TA']);
    expect(blocks[0].yiziCount).toBe(3);
  });

  it('同一份数据、两种口径 → 组序确实不同（这就是「两种方式可对比」的前提）', () => {
    const v = rankDecisionTopics(ENTRIES, MODE_VOL_RATIO).map(b => b.topic);
    const y = rankDecisionTopics(ENTRIES, MODE_YIZI).map(b => b.topic);
    expect(v).not.toEqual(y);
    expect(v[0]).toBe('TA');
    expect(y[0]).toBe('TB');
  });

  it('两模式产出的题材块【结构一致】（count / yiziCount / members 都在，UI 才能共用渲染分支）', () => {
    [MODE_VOL_RATIO, MODE_YIZI].forEach(function(mode) {
      rankDecisionTopics(ENTRIES, mode).forEach(function(b) {
        expect(typeof b.topic).toBe('string');
        expect(typeof b.rank).toBe('number');
        expect(typeof b.count).toBe('number');
        expect(typeof b.yiziCount).toBe('number');
        expect(Array.isArray(b.members)).toBe(true);
        b.members.forEach(function(m) {
          expect(typeof m.name).toBe('string');
          expect(typeof m.isYizi).toBe('boolean');
          expect(typeof m.countable).toBe('boolean');
          expect('aucVolRatio' in m).toBe(true);
        });
      });
    });
  });

  it('mode 缺省 / 非法 → 量比模式（与 resolveDecisionMode 的兜底保持一致）', () => {
    const a = rankDecisionTopics(ENTRIES).map(b => b.topic);
    const b = rankDecisionTopics(ENTRIES, MODE_VOL_RATIO).map(b => b.topic);
    expect(a).toEqual(b);
    expect(rankDecisionTopics(ENTRIES, 'bogus').map(x => x.topic)).toEqual(b);
  });
});

describe('buildBuyPlan（按模式分派买点规则）', () => {
  it('两模式都返回【六键结构】，且 candidates 恒为数组（UI 结构契约，⛔ 破一个就白屏）', () => {
    [MODE_VOL_RATIO, MODE_YIZI].forEach(function(mode) {
      const blocks = rankDecisionTopics(ENTRIES, mode);
      const plan = buildBuyPlan(blocks, rankDragons(blocks), {}, mode);
      ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic'].forEach(function(k) {
        expect(k in plan).toBe(true);
      });
      expect(Array.isArray(plan.candidates)).toBe(true);
    });
  });

  it('同一份输入下，两模式选出的【第 1 名题材不同】—— 证明分派真的换了一套规则', () => {
    const blocksV = rankDecisionTopics(ENTRIES, MODE_VOL_RATIO);
    const planV = buildBuyPlan(blocksV, rankDragons(blocksV), {}, MODE_VOL_RATIO);
    expect(planV.heavy).not.toBe(null);
    expect(planV.heavy.block.topic).toBe('TA');

    const blocksY = rankDecisionTopics(ENTRIES, MODE_YIZI);
    const planY = buildBuyPlan(blocksY, rankDragons(blocksY), {}, MODE_YIZI);
    expect(planY.heavy).not.toBe(null);
    expect(planY.heavy.block.topic).toBe('TB');
  });

  it('一字模式：常规档位不需要连板天梯也能出票（ladderReady 缺省不影响 ①~④）', () => {
    const blocks = rankDecisionTopics(ENTRIES, MODE_YIZI);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {}, MODE_YIZI);
    expect(plan.heavy.block.topic).toBe('TB');
    expect(plan.light).not.toBe(null);
    expect(plan.light.block.topic).toBe('TC');
  });

  it('一字模式：candidates 是【补】出来的空数组，不是老版返回里本来就有的键', () => {
    const blocks = rankDecisionTopics(ENTRIES, MODE_YIZI);
    const plan = buildBuyPlan(blocks, rankDragons(blocks), {}, MODE_YIZI);
    expect(plan.candidates).toEqual([]);
  });

  it('mode 缺省 → 走量比模式（与 resolveDecisionMode 的兜底一致）', () => {
    const blocks = rankDecisionTopics(ENTRIES, MODE_VOL_RATIO);
    const withMode = buildBuyPlan(blocks, rankDragons(blocks), {}, MODE_VOL_RATIO);
    const noMode = buildBuyPlan(blocks, rankDragons(blocks), {});
    expect(noMode.heavy.block.topic).toBe(withMode.heavy.block.topic);
  });
});

describe('buildRulesLines（按模式换规则文案）', () => {
  const v = buildRulesLines(MODE_VOL_RATIO);
  const y = buildRulesLines(MODE_YIZI);

  it('两套模式给出【不同】的规则条文', () => {
    expect(Array.isArray(v)).toBe(true);
    expect(Array.isArray(y)).toBe(true);
    expect(v.length).toBeGreaterThan(0);
    expect(y.length).toBeGreaterThan(0);
    expect(v).not.toEqual(y);
  });

  it('量比模式文案：按平均竞价量比排名 + 明说老规则已作废', () => {
    const text = v.join('\n');
    expect(text).toContain('平均竞价量比');
    expect(text).toContain('已作废的旧规则');
  });

  it('一字模式文案：保留老版的「题材连扳」兜底条文（量比模式里没有）', () => {
    const text = y.join('\n');
    expect(text).toContain('题材连扳');
    expect(v.join('\n')).not.toContain('题材连扳');
  });

  it('卖点段【两模式完全共用】（§6 单一真相：卖点只有一套规则，不随买点模式变）', () => {
    const sell = sellRulesLines();
    expect(sell.length).toBeGreaterThan(0);
    expect(v.slice(-sell.length)).toEqual(sell);
    expect(y.slice(-sell.length)).toEqual(sell);
  });

  it('mode 缺省 / 非法 → 量比模式文案', () => {
    expect(buildRulesLines()).toEqual(v);
    expect(buildRulesLines('bogus')).toEqual(v);
  });
});

describe('needsLadderData（要不要采连板天梯 · 懒采集闸门）', () => {
  const byMode = (entries, mode) => rankDecisionTopics(entries, mode);

  it('量比模式【一律不采】—— 它的买点只用题材排名前二 + 数量 + 竞价量比', () => {
    const noYizi = [E('一', 'T1', { pct: 10 }), E('二', 'T1', { pct: 9 })];
    expect(needsLadderData(byMode(noYizi, MODE_VOL_RATIO), MODE_VOL_RATIO)).toBe(false);
    expect(needsLadderData(byMode(ENTRIES, MODE_VOL_RATIO), MODE_VOL_RATIO)).toBe(false);
  });

  it('一字模式 · 全部题材都没有竞价一字 → 要采（老版 ⑤ 无一字弱市兜底）', () => {
    const entries = [
      E('一', 'T1', { pct: 30 }), E('二', 'T1', { pct: 20 }),
      E('三', 'T2', { pct: 10 }), E('四', 'T2', { pct: 5 })
    ];
    expect(needsLadderData(byMode(entries, MODE_YIZI), MODE_YIZI)).toBe(true);
  });

  it('一字模式 · 第 1 名是「票 ≤4 只 + 1~2 个一字」的高危小题材 → 要采（老版 ⑥）', () => {
    const entries = [
      // T1：3 只、1 个一字 ⇒ 高危小题材（且靠 1 个一字排到第 1）
      E('一', 'T1', { pct: 30, isYizi: true }),
      E('二', 'T1', { pct: 20 }), E('三', 'T1', { pct: 10 }),
      // T2：4 只、0 一字
      E('四', 'T2', { pct: 9 }), E('五', 'T2', { pct: 8 }),
      E('六', 'T2', { pct: 7 }), E('七', 'T2', { pct: 6 })
    ];
    const blocks = byMode(entries, MODE_YIZI);
    expect(blocks[0].topic).toBe('T1');
    expect(needsLadderData(blocks, MODE_YIZI)).toBe(true);
  });

  it('一字模式 · 第 2 名题材只有 1 个竞价一字 → 要采（老版 ④ 题材替换要和题材连扳比数量）', () => {
    const entries = [
      // T1：5 只、2 个一字（非高危）⇒ 第 1
      E('一', 'T1', { pct: 50, isYizi: true }), E('二', 'T1', { pct: 40, isYizi: true }),
      E('三', 'T1', { pct: 30 }), E('四', 'T1', { pct: 20 }), E('五', 'T1', { pct: 10 }),
      // T2：6 只、1 个一字（数量 >4 所以不是高危小题材，但仍触发「第 2 名只有 1 个一字」）
      E('六', 'T2', { pct: 9, isYizi: true }), E('七', 'T2', { pct: 8 }),
      E('八', 'T2', { pct: 7 }), E('九', 'T2', { pct: 6 }),
      E('十', 'T2', { pct: 5 }), E('甲', 'T2', { pct: 4 })
    ];
    const blocks = byMode(entries, MODE_YIZI);
    expect(blocks[1].topic).toBe('T2');
    expect(blocks[1].yiziCount).toBe(1);
    expect(needsLadderData(blocks, MODE_YIZI)).toBe(true);
  });

  it('一字模式 · 常规形态（第 1 名 5 只 2 一字、第 2 名 6 只 2 一字）→ 不采', () => {
    const entries = [
      E('一', 'T1', { pct: 50, isYizi: true }), E('二', 'T1', { pct: 40, isYizi: true }),
      E('三', 'T1', { pct: 30 }), E('四', 'T1', { pct: 20 }), E('五', 'T1', { pct: 10 }),
      E('六', 'T2', { pct: 9, isYizi: true }), E('七', 'T2', { pct: 8, isYizi: true }),
      E('八', 'T2', { pct: 7 }), E('九', 'T2', { pct: 6 }),
      E('十', 'T2', { pct: 5 }), E('甲', 'T2', { pct: 4 })
    ];
    expect(needsLadderData(byMode(entries, MODE_YIZI), MODE_YIZI)).toBe(false);
  });

  it('入参缺失 / 空题材 → false（§10 不抛错；空题材今天根本不出票，不必采天梯）', () => {
    expect(needsLadderData(undefined, MODE_YIZI)).toBe(false);
    expect(needsLadderData(null, MODE_YIZI)).toBe(false);
    expect(needsLadderData([], MODE_YIZI)).toBe(false);
  });

  it('mode 缺省 → 量比模式口径（false）', () => {
    expect(needsLadderData(byMode(ENTRIES, MODE_YIZI))).toBe(false);
  });
});
