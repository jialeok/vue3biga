// decision-chart-judge.test.js — 手动「竞价图形判断」的回归用例
//
// ⭐ [CHART-JUDGE 2026-10-09 用户口径] 这些用例【逐条对应用户给出的原话】：
//    「组件有三个选项：默认请选择｜竞图符合（预判当天走势会好）｜竞图不符合（预判当天走势不好）」
//    「会直接影响到 竞价买 / 竞价卖 / 尾盘买 / 尾盘卖 这四个选项」
//    「原有标签是尾盘买，当我选择竞价图符合 ⇒ 标签变成竞价买（更有性价比，溢价更高）」
//    「原有标签竞价买，我选择竞价图形不符合 ⇒ 标签显示尾盘买（更安全）」
//    「卖点：标签是竞价卖，我选择竞价图符合 ⇒ 变成尾盘卖（走势好、尾盘获利更高）；
//      如果选竞价图不符合，或者默认，就按原来的竞价卖显示，果断出局」
//    「原来规则不变」「颜色显著些」「能存起来，刷新也不会变」
//   ⛔ 改这张映射表之前，先把本文件跑一遍 —— 它是用户亲自拍过板的验收基准。
//
// 覆盖：① 取值归一（§10 不猜）；② 哪四种标签受控；③ 三档映射；④ 逐行套用（含共享块去重）；
//      ⑤ 说明文字；⑥ 规则面板文案；⑦ 两套模式的文案拼接顺序。

import { describe, it, expect } from 'vitest';
import {
  BUY_NOW_TAG,
  BUY_LATE_TAG,
  BUY_LATE_SWAP_TAG,
  BUY_DIVE_TAG,
  BUY_MAKEUP_TAG,
  DRAGON_YIZI_HOLD_TAG,
  BUY_ACTION_TONE_NOW,
  BUY_ACTION_TONE_LATE,
  SELL_OUT_TAG,
  SELL_LATE_TAG,
  SELL_OUT_SWAP_TAG,
  SELL_TEN_MIN_TAG,
  SELL_FOLLOW_DRAGON_TAG,
  SELL_LIMIT_UP_TAG,
  SELL_ACTION_TONE_OUT,
  SELL_ACTION_TONE_LATE,
  HOLD_TAG
} from './decision-rules.js';
import {
  JUDGE_DEFAULT,
  JUDGE_OK,
  JUDGE_BAD,
  CHART_JUDGE_OPTIONS,
  SIDE_BUY,
  SIDE_SELL,
  normalizeChartJudge,
  isChartJudgeTarget,
  resolveChartJudge,
  chartJudgeNoteText,
  applyChartJudge,
  chartJudgeRulesLines
} from './decision-chart-judge.js';
import { buildRulesLines, MODE_VOL_RATIO, MODE_YIZI } from './decision-mode.js';
import { sellRulesLines } from './decision-rules.js';

/* ══════════════════════════════════════════════════════════════════════════════════════
   假数据：只造 applyChartJudge 真正会碰的那几个字段
   （name / buyActionTag / buyActionTone / sellActionTag / sellActionTone / actionNote）
   ⚠️ 刻意不跑 collectDecisionData —— 那要整套早盘竞价内存真相；本文件测的是【映射】，
      纯函数单元测试比造一整套行情桩更稳（§22 不被无关模块的改动牵连）。
   ══════════════════════════════════════════════════════════════════════════════════════ */
function mkBuyRow(name, tag, tone) {
  return {
    name: name,
    buyActionTag: tag || '',
    buyActionTone: tone || '',
    actionNote: tag ? ('买点原规则说明-' + name) : ''
  };
}
function mkSellRow(name, tag, tone) {
  return {
    name: name,
    sellActionTag: tag || '',
    sellActionTone: tone || '',
    actionNote: tag ? ('卖点原规则说明-' + name) : ''
  };
}
function mkBlock(topic, picks) {
  return { block: { topic: topic }, picks: picks };
}

/** 造一份决策数据；shared 块【同时】挂在 light 与 candidates[0] 上（= 降级场景的真实形状） */
function mkDecisionData() {
  const shared = mkBlock('共享题材', [
    mkBuyRow('共享票', BUY_LATE_TAG, BUY_ACTION_TONE_LATE)
  ]);
  return {
    ready: true,
    buy: {
      heavy: mkBlock('重仓题材', [mkBuyRow('竞价票', BUY_NOW_TAG, BUY_ACTION_TONE_NOW)]),
      light: shared,
      candidates: [shared],
      noYizi: null,
      smallTopic: null,
      bigTopic: null
    },
    sell: [
      {
        groupKey: 'g1',
        items: [
          mkSellRow('卖竞价票', SELL_OUT_TAG, SELL_ACTION_TONE_OUT),
          mkSellRow('卖尾盘票', SELL_LATE_TAG, SELL_ACTION_TONE_LATE)
        ]
      }
    ]
  };
}

/**
 * 取回套用过的行（按名字，跨买点块 / 卖点组都能找）。
 * ⚠️ 按【对象身份】去重：降级场景里 light 与 candidates[0] 是【同一个块对象】，
 *    于是同一行会被遍历到两次 —— 那是真实形状，不是重复数据（§6 同一个对象只有一份）。
 */
function findRow(d, name) {
  const seen = new Set();
  const out = [];
  const push = function(p) {
    if (!p || p.name !== name || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const buy = d.buy;
  [buy.heavy, buy.light].forEach(function(b) {
    if (b) b.picks.forEach(push);
  });
  (buy.candidates || []).forEach(function(b) { b.picks.forEach(push); });
  d.sell.forEach(function(g) { g.items.forEach(push); });
  return out;
}

/** 唯一一行（并顺带断言「只找到一条」—— 共享块不该让同一行出现两次） */
function row(d, name) {
  const got = findRow(d, name);
  expect(got.length).toBe(1);
  return got[0];
}

describe('「竞价图形判断」取值归一（§10：不认识的输入一律回落【默认】，绝不猜）', () => {
  it('ok / bad 原样通过', () => {
    expect(normalizeChartJudge(JUDGE_OK)).toBe(JUDGE_OK);
    expect(normalizeChartJudge(JUDGE_BAD)).toBe(JUDGE_BAD);
  });

  it('缺省 / 空串 / 空值 / 乱码 / 大小写异常 → 默认', () => {
    [undefined, null, '', JUDGE_DEFAULT, 'OK', 'ok ', 'yes', 0, 1, {}, []].forEach(function(v) {
      expect(normalizeChartJudge(v)).toBe(JUDGE_DEFAULT);
    });
  });

  it('三个选项的取值 / 文案 / 顺序只有一处定义（§6）', () => {
    expect(CHART_JUDGE_OPTIONS.map(function(o) { return o.value; }))
      .toEqual([JUDGE_DEFAULT, JUDGE_OK, JUDGE_BAD]);
    expect(CHART_JUDGE_OPTIONS.map(function(o) { return o.label; }))
      .toEqual(['默认', '符合', '不符']);
    // 悬停说明要把「改哪个标签」讲清楚，不能只写「符合 / 不符合」
    expect(CHART_JUDGE_OPTIONS[1].title).toContain(BUY_NOW_TAG);
    expect(CHART_JUDGE_OPTIONS[2].title).toContain(BUY_LATE_TAG);
  });
});

describe('「竞价图形判断」只对【四种基础标签】生效（用户口径点名的四个选项）', () => {
  it('买点：竞价买 / 尾盘买 受控', () => {
    expect(isChartJudgeTarget(SIDE_BUY, BUY_NOW_TAG)).toBe(true);
    expect(isChartJudgeTarget(SIDE_BUY, BUY_LATE_TAG)).toBe(true);
  });

  it('卖点：竞价卖 / 尾盘卖 受控', () => {
    expect(isChartJudgeTarget(SIDE_SELL, SELL_OUT_TAG)).toBe(true);
    expect(isChartJudgeTarget(SIDE_SELL, SELL_LATE_TAG)).toBe(true);
  });

  it('买点的特殊标签【不受控】（各自还带着别的信息，覆盖掉就是丢信息）', () => {
    [BUY_LATE_SWAP_TAG, BUY_DIVE_TAG, BUY_MAKEUP_TAG, DRAGON_YIZI_HOLD_TAG, HOLD_TAG, ''].forEach(function(t) {
      expect(isChartJudgeTarget(SIDE_BUY, t)).toBe(false);
    });
  });

  it('卖点的特殊标签【不受控】', () => {
    [SELL_OUT_SWAP_TAG, SELL_TEN_MIN_TAG, SELL_FOLLOW_DRAGON_TAG, SELL_LIMIT_UP_TAG, HOLD_TAG, ''].forEach(function(t) {
      expect(isChartJudgeTarget(SIDE_SELL, t)).toBe(false);
    });
  });

  it('侧别错的标签不受控（买点不许被卖点标签带跑，反之亦然）', () => {
    expect(isChartJudgeTarget(SIDE_BUY, SELL_OUT_TAG)).toBe(false);
    expect(isChartJudgeTarget(SIDE_SELL, BUY_NOW_TAG)).toBe(false);
    expect(isChartJudgeTarget('bogus', BUY_NOW_TAG)).toBe(false);
  });

  it('null / undefined 标签不受控（§10 未知 ≠ 受控）', () => {
    expect(isChartJudgeTarget(SIDE_BUY, null)).toBe(false);
    expect(isChartJudgeTarget(SIDE_SELL, undefined)).toBe(false);
  });
});

describe('「竞价图形判断」三档映射（用户逐条给的口径）', () => {
  it('默认 → 不改动（tag / tone 都给空串，⛔ 不猜一个标签出来）', () => {
    [SIDE_BUY, SIDE_SELL].forEach(function(side) {
      const r = resolveChartJudge(side, JUDGE_DEFAULT);
      expect(r.judge).toBe(JUDGE_DEFAULT);
      expect(r.tag).toBe('');
      expect(r.tone).toBe('');
    });
  });

  it('买点 · 符合 ⇒ 竞价买（更有性价比、溢价更高）', () => {
    const r = resolveChartJudge(SIDE_BUY, JUDGE_OK);
    expect(r.tag).toBe(BUY_NOW_TAG);
    expect(r.tone).toBe(BUY_ACTION_TONE_NOW);
    expect(r.why).toContain('溢价');
  });

  it('买点 · 不符 ⇒ 尾盘买（更安全，别追开盘）', () => {
    const r = resolveChartJudge(SIDE_BUY, JUDGE_BAD);
    expect(r.tag).toBe(BUY_LATE_TAG);
    expect(r.tone).toBe(BUY_ACTION_TONE_LATE);
    expect(r.why).toContain('安全');
  });

  it('卖点 · 符合 ⇒ 尾盘卖（走势好、尾盘获利更高）', () => {
    const r = resolveChartJudge(SIDE_SELL, JUDGE_OK);
    expect(r.tag).toBe(SELL_LATE_TAG);
    expect(r.tone).toBe(SELL_ACTION_TONE_LATE);
    expect(r.why).toContain('尾盘');
  });

  it('卖点 · 不符 ⇒ 竞价卖（果断出局）', () => {
    const r = resolveChartJudge(SIDE_SELL, JUDGE_BAD);
    expect(r.tag).toBe(SELL_OUT_TAG);
    expect(r.tone).toBe(SELL_ACTION_TONE_OUT);
    expect(r.why).toContain('出局');
  });

  it('§10：非法档位 / 非法侧别 ⇒ 一律回落【默认】，不会凭空给出标签', () => {
    expect(resolveChartJudge(SIDE_BUY, 'zzz').tag).toBe('');
    expect(resolveChartJudge('bogus', JUDGE_OK).tag).toBe('');
  });
});

describe('「竞价图形判断」套用到行上（applyChartJudge）', () => {
  it('买点：尾盘买 + 符合 ⇒ 竞价买（用户原话那条例子）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 共享票: JUDGE_OK });
    const p = row(d, '共享票');
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_NOW);
    expect(p.chartJudge).toBe(JUDGE_OK);
    expect(p.chartJudgeTarget).toBe(true);
    // 原规则的说明文字【保留】，手动判断的说明【接在后面】
    expect(p.actionNote).toContain('买点原规则说明-共享票');
    expect(p.actionNote).toContain('手动「竞价图形判断」');
  });

  it('买点：竞价买 + 不符 ⇒ 尾盘买（用户原话那条例子）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 竞价票: JUDGE_BAD });
    const p = row(d, '竞价票');
    expect(p.buyActionTag).toBe(BUY_LATE_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_LATE);
    expect(p.chartJudgeNote).toContain(BUY_LATE_TAG);
  });

  it('买点：竞价买 + 符合 ⇒ 标签不变，但必须说明「与原规则一致」（不然用户以为没保存）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 竞价票: JUDGE_OK });
    const p = row(d, '竞价票');
    expect(p.buyActionTag).toBe(BUY_NOW_TAG);
    expect(p.buyActionTone).toBe(BUY_ACTION_TONE_NOW);
    expect(p.chartJudgeNote).toContain('与原规则一致');
  });

  it('卖点：竞价卖 + 符合 ⇒ 尾盘卖（用户原话那条例子）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 卖竞价票: JUDGE_OK });
    const p = row(d, '卖竞价票');
    expect(p.sellActionTag).toBe(SELL_LATE_TAG);
    expect(p.sellActionTone).toBe(SELL_ACTION_TONE_LATE);
  });

  it('卖点：竞价卖 + 不符 ⇒ 仍是【竞价卖】（用户原话「果断出局」，标签不变但要说明）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 卖竞价票: JUDGE_BAD });
    const p = row(d, '卖竞价票');
    expect(p.sellActionTag).toBe(SELL_OUT_TAG);
    expect(p.sellActionTone).toBe(SELL_ACTION_TONE_OUT);
    expect(p.chartJudgeNote).toContain('与原规则一致');
  });

  it('卖点：尾盘卖 + 不符 ⇒ 竞价卖（图差 ⇒ 果断出局，与买点「图差 ⇒ 保守」同一方向）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 卖尾盘票: JUDGE_BAD });
    const p = row(d, '卖尾盘票');
    expect(p.sellActionTag).toBe(SELL_OUT_TAG);
    expect(p.sellActionTone).toBe(SELL_ACTION_TONE_OUT);
  });

  it('默认档 ⇒ 一个字节都不动（标签 / 配色 / 说明都保持原样）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 共享票: JUDGE_DEFAULT, 竞价票: JUDGE_DEFAULT });
    [['共享票', BUY_LATE_TAG, BUY_ACTION_TONE_LATE], ['竞价票', BUY_NOW_TAG, BUY_ACTION_TONE_NOW]]
      .forEach(function(t) {
        const p = row(d, t[0]);
        expect(p.buyActionTag).toBe(t[1]);
        expect(p.buyActionTone).toBe(t[2]);
        expect(p.chartJudge).toBe(JUDGE_DEFAULT);
        expect(p.chartJudgeNote).toBe('');
        expect(p.actionNote).toBe('买点原规则说明-' + t[0]);
      });
  });

  it('§10：表里查不到这一只 ⇒ 默认（⛔ 不猜「符合」）', () => {
    const d = mkDecisionData();
    applyChartJudge(d, {});
    const p = row(d, '共享票');
    expect(p.chartJudge).toBe(JUDGE_DEFAULT);
    expect(p.chartJudgeTarget).toBe(true);      // 仍然受控（用户还能选），只是当前是默认
    expect(p.buyActionTag).toBe(BUY_LATE_TAG);
  });

  it('§10：判断值非法（DB 里是脏值） ⇒ 当成默认，⛔ 不用脏值改标签', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 共享票: 'YES', 卖竞价票: '不晓得' });
    expect(row(d, '共享票').buyActionTag).toBe(BUY_LATE_TAG);
    expect(row(d, '卖竞价票').sellActionTag).toBe(SELL_OUT_TAG);
  });

  it('★共享块（light 与 candidates[0] 是同一个对象）⇒ 只处理一次，说明文字不重复拼', () => {
    const d = mkDecisionData();
    applyChartJudge(d, { 共享票: JUDGE_OK });
    const p = row(d, '共享票');
    const hits = (p.actionNote.match(/手动「竞价图形判断」/g) || []).length;
    expect(hits).toBe(1);
  });

  it('买点 / 卖点共用同一个判断：同一只票两侧一起按同一方向变', () => {
    const d = mkDecisionData();
    // 同一只票同时出现在买点（竞价买）与卖点（尾盘卖）—— 占比达标时就是这个形状
    const buyTwo = mkBuyRow('两头票', BUY_NOW_TAG, BUY_ACTION_TONE_NOW);
    const sellTwo = mkSellRow('两头票', SELL_LATE_TAG, SELL_ACTION_TONE_LATE);
    d.buy.heavy.picks.push(buyTwo);
    d.sell[0].items.push(sellTwo);
    applyChartJudge(d, { 两头票: JUDGE_BAD });
    expect(buyTwo.buyActionTag).toBe(BUY_LATE_TAG);          // 买点 → 保守
    expect(buyTwo.buyActionTone).toBe(BUY_ACTION_TONE_LATE);
    expect(sellTwo.sellActionTag).toBe(SELL_OUT_TAG);        // 卖点 → 果断
    expect(sellTwo.sellActionTone).toBe(SELL_ACTION_TONE_OUT);
    // 两侧都是「图差」这一个判断推出来的，方向一致（同一张图不可能有两个结论）
    expect([buyTwo.chartJudge, sellTwo.chartJudge]).toEqual([JUDGE_BAD, JUDGE_BAD]);
  });

  it('特殊标签的行：不受控 + 不改标签 + 不产说明（选择器也不渲染）', () => {
    const d = mkDecisionData();
    d.buy.heavy.picks.push(mkBuyRow('先卖后买票', BUY_LATE_SWAP_TAG, 'swap'));
    d.sell[0].items.push(mkSellRow('十分钟票', SELL_TEN_MIN_TAG, 'tenmin'));
    applyChartJudge(d, { 先卖后买票: JUDGE_OK, 十分钟票: JUDGE_OK });
    const a = row(d, '先卖后买票');
    expect(a.chartJudgeTarget).toBe(false);
    expect(a.buyActionTag).toBe(BUY_LATE_SWAP_TAG);
    expect(a.chartJudgeNote).toBe('');
    const b = row(d, '十分钟票');
    expect(b.chartJudgeTarget).toBe(false);
    expect(b.sellActionTag).toBe(SELL_TEN_MIN_TAG);
  });

  it('三条兜底方案（无一字 / 小题材 / 大题材）里的块也要被覆盖到', () => {
    const d = mkDecisionData();
    d.buy.noYizi = { blocks: [mkBlock('兜底题材', [mkBuyRow('兜底票', BUY_LATE_TAG, BUY_ACTION_TONE_LATE)])] };
    applyChartJudge(d, { 兜底票: JUDGE_OK });
    let found = null;
    d.buy.noYizi.blocks[0].picks.forEach(function(p) { if (p.name === '兜底票') found = p; });
    expect(found).not.toBeNull();
    expect(found.buyActionTag).toBe(BUY_NOW_TAG);
  });

  it('数据形状异常 / 空数据 ⇒ 原样返回，不抛错（看板不能因为没数据就崩）', () => {
    expect(applyChartJudge(null, {})).toBe(null);
    expect(applyChartJudge(undefined, {})).toBe(undefined);
    const empty = { ready: false, buy: null, sell: [] };
    expect(applyChartJudge(empty, { X: JUDGE_OK })).toBe(empty);
    const weird = { ready: true, buy: { heavy: null, light: null, candidates: null }, sell: null };
    expect(applyChartJudge(weird, { X: JUDGE_OK })).toBe(weird);
  });

  it('judgeMap 缺省 / 不是对象 ⇒ 当成「全默认」，⛔ 不抛错', () => {
    const d = mkDecisionData();
    expect(function() { applyChartJudge(d, null); }).not.toThrow();
    expect(function() { applyChartJudge(d, 'zzz'); }).not.toThrow();
    expect(row(d, '共享票').buyActionTag).toBe(BUY_LATE_TAG);
  });
});

describe('「竞价图形判断」逐行说明文字', () => {
  it('默认档不产说明（行内保持干净，省空间）', () => {
    expect(chartJudgeNoteText(SIDE_BUY, JUDGE_DEFAULT, BUY_LATE_TAG, BUY_NOW_TAG)).toBe('');
  });

  it('改标签 / 没改标签两种情形都能读出来', () => {
    const changed = chartJudgeNoteText(SIDE_BUY, JUDGE_OK, BUY_LATE_TAG, BUY_NOW_TAG);
    expect(changed).toContain(BUY_LATE_TAG);
    expect(changed).toContain(BUY_NOW_TAG);
    const same = chartJudgeNoteText(SIDE_BUY, JUDGE_OK, BUY_NOW_TAG, BUY_NOW_TAG);
    expect(same).toContain('与原规则一致');
  });

  it('说明里必须写明「原有规则没改，只是让位」（用户口径：原规则作为辅助）', () => {
    expect(chartJudgeNoteText(SIDE_SELL, JUDGE_OK, SELL_OUT_TAG, SELL_LATE_TAG))
      .toContain('原有规则一条都没改');
  });
});

describe('规则文案：手动「竞价图形判断」必须写进灰色问号面板', () => {
  const text = chartJudgeRulesLines().join('\n');

  it('点明它是【最终决定权】、原规则降为辅助（用户原话）', () => {
    expect(text).toContain('最终决定权');
    expect(text).toContain('辅助');
  });

  it('四个受控标签 + 三档对应关系都要写清楚', () => {
    [BUY_NOW_TAG, BUY_LATE_TAG, SELL_OUT_TAG, SELL_LATE_TAG].forEach(function(t) {
      expect(text).toContain(t);
    });
    expect(text).toContain('默认');
    expect(text).toContain('符合');
    expect(text).toContain('不符');
  });

  it('点名说明哪些【特殊标签不受影响】', () => {
    [BUY_LATE_SWAP_TAG, BUY_DIVE_TAG, BUY_MAKEUP_TAG, DRAGON_YIZI_HOLD_TAG,
      SELL_OUT_SWAP_TAG, SELL_TEN_MIN_TAG, SELL_FOLLOW_DRAGON_TAG, SELL_LIMIT_UP_TAG, HOLD_TAG]
      .forEach(function(t) { expect(text).toContain(t); });
  });

  it('写清保存口径（按日期 + 股票存云端表、刷新不丢、选回默认 = 删记录）', () => {
    expect(text).toContain('decision_chart_judge');
    expect(text).toContain('db/create_decision_chart_judge.sql');
    expect(text).toContain('localStorage');
  });

  it('⛔ 不许出现「题材连扳」（decision-mode.test.js 用它区分两套模式的买点段）', () => {
    expect(text).not.toContain('题材连扳');
  });
});

describe('规则文案：两套模式都把该段【前置】，且卖点段仍留在尾部', () => {
  const seg = chartJudgeRulesLines();

  it('量比模式 / 一字模式都以该段开头', () => {
    [MODE_VOL_RATIO, MODE_YIZI].forEach(function(m) {
      const lines = buildRulesLines(m);
      expect(lines.slice(0, seg.length)).toEqual(seg);
    });
  });

  it('卖点段仍在【最后】（decision-mode.test.js 的断言依赖这一点，⛔ 不能改成追加）', () => {
    const sell = sellRulesLines();
    [MODE_VOL_RATIO, MODE_YIZI].forEach(function(m) {
      const lines = buildRulesLines(m);
      expect(lines.slice(-sell.length)).toEqual(sell);
    });
  });

  it('两套模式仍然各自不同（前置的公共段不影响「按模式换条文」）', () => {
    expect(buildRulesLines(MODE_VOL_RATIO)).not.toEqual(buildRulesLines(MODE_YIZI));
  });
});
