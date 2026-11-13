// abnormal-10d.test.js — 第三十四条【监管异动 · 十日涨幅硬上限】的单测
//
// 覆盖四层（缺一层就会漏掉一类回归）：
//   ① classifyRange10  —— 自定义禁选上限 / 100 两个阈值的边界（含恰好等于）；
//   ② resolveAbnormalFact —— 三种触发形态（异动次日 / 当日异动 / 票级异动）+ §10 判不出；
//   ③ _buildBlock —— 自定义上限「跳过顺延」与 100% 红线「保留展示 + 停止选股」两种语义；
//   ④ _applyAbnormalSweep / _applyAbnormalNoBuyRules —— 空仓标语接管 + 逐行改写 + 下线特殊通道。
//
// ⚠️ 真实数据锚点（2026-11-11 / 11-12 / 11-13，东方海洋）：
//     11-11 = 95.711445%（★ [CAP-97] 用户要求「11月11日这样能正常运行」⇒ 必须判 ok）、
//     11-12 = 100.78%（异动成立）、11-13 回落到 73.14% ⇒ 只看今日判不出「异动次日」。
//     所以下面专门有「11-11 正常」与「今日 73 / 昨日 100.78 ⇒ 仍判异动次日」两组用例。

import { describe, it, expect } from 'vitest';
import {
  classifyRange10, isOverRange10Cap, resolveAbnormalFact,
  ABNORMAL_LEVEL_UNKNOWN, ABNORMAL_LEVEL_OK, ABNORMAL_LEVEL_NEAR, ABNORMAL_LEVEL_ABNORMAL
} from './abnormal-10d.js';
import {
  TVRB_RANGE10_CAP, TVRB_RANGE10_ABNORMAL, ABNORMAL_NO_BUY_TAG,
  ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW, ABNORMAL_KIND_STOCK
} from './tvrb-constants.js';
import { _buildBlock, _applyAbnormalNoBuyRules } from './tvrb-blocks.js';
import { _applyAbnormalSweep } from './tvrb-plan.js';

// ── ① 分级边界 ────────────────────────────────────────────────────────────────
describe('classifyRange10 · ' + TVRB_RANGE10_CAP + ' / ' + TVRB_RANGE10_ABNORMAL + ' 两个阈值', () => {
  it('[CAP-97] 自定义禁选上限 = 97（用户 2026-11-13 晚间把 95 上调到 97）', () => {
    expect(TVRB_RANGE10_CAP).toBe(97);
    expect(TVRB_RANGE10_ABNORMAL).toBe(100);
    // ⛔ 97 = 禁选预警线，100 = 全市场空仓线，两条不许合并
    expect(TVRB_RANGE10_CAP).toBeLessThan(TVRB_RANGE10_ABNORMAL);
  });

  it('读不到 ⇒ unknown（§10 不补 0）', () => {
    [null, undefined, '', 'abc', NaN].forEach(function(v) {
      const r = classifyRange10(v);
      expect(r.level).toBe(ABNORMAL_LEVEL_UNKNOWN);
      expect(r.pct).toBeNull();
      expect(r.pctText).toBe('—');
    });
  });

  it('★ [CAP-97] 11-11 真实值 95.711445% ⇒ ok（用户「11月11日这样能正常运行」）', () => {
    expect(classifyRange10(95.71144503546094).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10('95.71%').level).toBe(ABNORMAL_LEVEL_OK);
    expect(isOverRange10Cap(95.71144503546094)).toBe(false);
  });

  it('≤ ' + TVRB_RANGE10_CAP + ' ⇒ ok（含恰好等于上限）', () => {
    expect(classifyRange10(0).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10(94.99).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10(96.2).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10(TVRB_RANGE10_CAP).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10(97).pctText).toBe('+97.00%');
  });

  it(TVRB_RANGE10_CAP + ' < pct < ' + TVRB_RANGE10_ABNORMAL + ' ⇒ near（监管异动预警 · 不能选）', () => {
    expect(classifyRange10(97.01).level).toBe(ABNORMAL_LEVEL_NEAR);
    expect(classifyRange10(98).level).toBe(ABNORMAL_LEVEL_NEAR);
    expect(classifyRange10(99).level).toBe(ABNORMAL_LEVEL_NEAR);
    expect(classifyRange10(99.99).level).toBe(ABNORMAL_LEVEL_NEAR);
  });

  it('≥ 100 ⇒ abnormal（含恰好 100）', () => {
    expect(classifyRange10(TVRB_RANGE10_ABNORMAL).level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(classifyRange10(100.78).level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(classifyRange10(180).level).toBe(ABNORMAL_LEVEL_ABNORMAL);
  });

  it('字符串数字按同一口径解析（表里 pct 是文本列）', () => {
    expect(classifyRange10('100.78').level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(classifyRange10('95.71').level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10('98.2').level).toBe(ABNORMAL_LEVEL_NEAR);
  });

  it('isOverRange10Cap：near + abnormal 都为真，ok / unknown 为假', () => {
    expect(isOverRange10Cap(94)).toBe(false);
    expect(isOverRange10Cap(95.71144503546094)).toBe(false);
    expect(isOverRange10Cap(96)).toBe(false);
    expect(isOverRange10Cap(97)).toBe(false);
    expect(isOverRange10Cap(98)).toBe(true);
    expect(isOverRange10Cap(120)).toBe(true);
    expect(isOverRange10Cap(null)).toBe(false);
  });
});

// ── ② 事实判定 ────────────────────────────────────────────────────────────────
describe('resolveAbnormalFact · 三种触发形态', () => {
  it('★ 真实锚点：今日 73.14 / 昨日 100.78 ⇒ 仍判【异动次日】空仓', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋',
      leaderTopic: '海洋经济',
      leaderPctToday: 73.14,
      leaderPctPrev: 100.78,
      leaderPctPrevBasis: 'auction',
      rows: [{ name: '某某股份', topic: '机器人', pct: 60 }]
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.headline).toContain('空仓');
    expect(f.detail).toContain('东方海洋');
    expect(f.detail).toContain('100.78%');
    expect(f.detail).toContain('异动次日');
    expect(f.detail).toContain(ABNORMAL_NO_BUY_TAG);
  });

  it('总龙一【今日】≥100 ⇒ 当日异动', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '海洋经济',
      leaderPctToday: 102, leaderPctPrev: 90, rows: []
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.detail).toContain('今日');
  });

  it('入选票 ≥100 ⇒ 票级异动，并点名', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderPctToday: 60, leaderPctPrev: 60,
      rows: [
        { name: '甲股份', topic: '机器人', pct: 100 },
        { name: '乙股份', topic: '机器人', pct: 40 }
      ]
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_STOCK);
    expect(f.names).toEqual(['甲股份']);
    expect(f.detail).toContain('甲股份');
  });

  it('优先级的顺序：异动次日 > 当日异动 > 票级', () => {
    const f = resolveAbnormalFact({
      leaderName: 'L', leaderPctToday: 130, leaderPctPrev: 120,
      rows: [{ name: 'X', pct: 150 }]
    });
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
  });

  it('都没到 100 ⇒ show=false（但监管异动预警票照实点名，供说明区用）', () => {
    const f = resolveAbnormalFact({
      leaderName: 'L', leaderPctToday: 80, leaderPctPrev: 70,
      rows: [{ name: '丙股份', topic: 'T', pct: 98 }]
    });
    expect(f.show).toBe(false);
    expect(f.headline).toBe('');
    expect(f.nearNames).toEqual(['丙股份']);
  });

  it('★ [CAP-97] 11-11 真实形态：今日 95.711445 / 昨日更低 ⇒ 不空仓、不灰、不点名', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '羊字辈',
      leaderPctToday: 95.71144503546094,
      leaderPctPrev: 82.44,
      leaderPctPrevBasis: 'auction',
      rows: [{ name: '东方海洋', topic: '羊字辈', pct: 95.71144503546094 }]
    });
    expect(f.show).toBe(false);
    expect(f.kind).toBe('');
    expect(f.headline).toBe('');
    expect(f.nearNames).toEqual([]);
    expect(f.names).toEqual([]);
    expect(f.unknownLeader).toBe(false);
  });

  it('§10：总龙一缺数据 ⇒ unknownLeader，不当成「没异动」', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderPctToday: null, leaderPctPrev: null, rows: []
    });
    expect(f.show).toBe(false);
    expect(f.unknownLeader).toBe(true);
  });

  it('§10：昨日读不到但今日有值 ⇒ 判得出「不是异动次日」，不误报', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderPctToday: 40, leaderPctPrev: null, rows: []
    });
    expect(f.show).toBe(false);
    expect(f.unknownLeader).toBe(false);
  });

  it('昨日用收盘口径兜底时，文案必须标明口径（不许含糊）', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderPctToday: 50, leaderPctPrev: 101,
      leaderPctPrevBasis: 'close', rows: []
    });
    expect(f.show).toBe(true);
    expect(f.detail).toContain('收盘口径');
  });

  it('阈值常量与文案一致（自定义上限 / 100 不许写死在别处）', () => {
    const f = resolveAbnormalFact({
      leaderName: 'L', leaderPctToday: 50, leaderPctPrev: 101, rows: []
    });
    expect(f.detail).toContain(String(TVRB_RANGE10_CAP) + '%');
    expect(f.detail).toContain(String(TVRB_RANGE10_ABNORMAL) + '%');
  });
});

// ── ③ 选股闸门（_buildBlock）────────────────────────────────────────────────────
/** 造一个最小题材块（members 形状与 rankDecisionTopics 的出口一致） */
function mkBlock(members) {
  const ms = members.map(function(m) {
    return {
      name: m[0], code: m[1], pct: m[2], isYizi: false,
      aucPct: 3, aucVolRatio: 40, aucShare: 2
    };
  });
  return {
    topic: '机器人', rank: 1, count: ms.length, yiziCount: 0, members: ms
  };
}
function mkDragonMap(names) {
  const m = new Map();
  names.forEach(function(n, i) { m.set(n, { rank: i + 1, pct: null }); });
  return m;
}
const TIER_1 = { tier: 'mid', count: 5, pickCount: 1, rangeText: '4 ~ 8 只' };

describe('_buildBlock · ' + TVRB_RANGE10_CAP + '% 禁选线与 100% 红线', () => {
  it('★ [CAP-97] 龙一 95.711445%（11-11 东方海洋真实值）⇒ 正常选中，零异动标记', () => {
    const blk = _buildBlock(
      mkBlock([['东方海洋', '600001', 95.71144503546094], ['乙股份', '600002', 80]]),
      mkDragonMap(['东方海洋', '乙股份']), TIER_1
    );
    expect(blk.picks.map(function(p) { return p.name; })).toEqual(['东方海洋']);
    expect(blk.abnormalPick).toBeNull();
    expect(blk.skippedAbnormalNames).toEqual([]);
    expect(blk.notes.join('')).not.toContain('超过自定义上限');
    expect(blk.notes.join('')).not.toContain('监管异动');
  });

  it('龙一 98%（监管异动预警、未到红线）⇒ 不选入、顺延龙二', () => {
    const blk = _buildBlock(
      mkBlock([['甲股份', '600001', 98], ['乙股份', '600002', 80]]),
      mkDragonMap(['甲股份', '乙股份']), TIER_1
    );
    expect(blk.picks.map(function(p) { return p.name; })).toEqual(['乙股份']);
    expect(blk.abnormalPick).toBeNull();
    expect(blk.skippedAbnormalNames).toEqual(['龙一甲股份']);
    expect(blk.notes.join('')).toContain('超过自定义上限');
  });

  it('龙一 101%（异动）⇒ 保留展示 + 停止选股（⛔ 不顺延龙二）', () => {
    const blk = _buildBlock(
      mkBlock([['甲股份', '600001', 101], ['乙股份', '600002', 80]]),
      mkDragonMap(['甲股份', '乙股份']), TIER_1
    );
    expect(blk.picks.map(function(p) { return p.name; })).toEqual(['甲股份']);
    expect(blk.abnormalPick).not.toBeNull();
    expect(blk.abnormalPick.name).toBe('甲股份');
    expect(blk.abnormalPick.topic).toBe('机器人');
    expect(blk.notes.join('')).toContain('监管异动');
  });

  it('龙一 90% ⇒ 正常选中，零异动标记（§11 老行为不变）', () => {
    const blk = _buildBlock(
      mkBlock([['甲股份', '600001', 90], ['乙股份', '600002', 80]]),
      mkDragonMap(['甲股份', '乙股份']), TIER_1
    );
    expect(blk.picks.map(function(p) { return p.name; })).toEqual(['甲股份']);
    expect(blk.abnormalPick).toBeNull();
    expect(blk.skippedAbnormalNames).toEqual([]);
  });

  it('pct 读不到 ⇒ 既不跳过也不判异动（§10 不猜）', () => {
    const blk = _buildBlock(
      mkBlock([['甲股份', '600001', null], ['乙股份', '600002', null]]),
      mkDragonMap(['甲股份', '乙股份']), TIER_1
    );
    expect(blk.picks.map(function(p) { return p.name; })).toEqual(['甲股份']);
    expect(blk.abnormalPick).toBeNull();
  });
});

// ── ④ 收口：标语接管 + 逐行改写 + 下线特殊通道 ────────────────────────────────────
function mkPick(name, pct) {
  return {
    name: name, pct: pct, dragonLabel: '龙一', dragonRank: 1,
    position: '重仓', holdTag: '持有', buyActionTag: '竞价买', buyActionTone: 'x',
    actionNote: '原始说明'
  };
}

describe('_applyAbnormalNoBuyRules · 逐行覆盖', () => {
  it('标签改【异动不买】、仓位与持有清空、客观数据不动', () => {
    const blocks = [{ topic: '机器人', picks: [mkPick('甲股份', 101)] }];
    _applyAbnormalNoBuyRules(blocks, {
      show: true, kind: ABNORMAL_KIND_NEXT_DAY,
      leaderName: '东方海洋', leaderPctPrevText: '+100.78%', names: []
    });
    const p = blocks[0].picks[0];
    expect(p.buyActionTag).toBe(ABNORMAL_NO_BUY_TAG);
    expect(p.position).toBe('');
    expect(p.holdTag).toBe('');
    expect(p.pct).toBe(101);                 // ★ 客观数据一行不动
    expect(p.actionNote).toContain(ABNORMAL_NO_BUY_TAG);
    expect(p.actionNote).toContain('东方海洋');
  });

  it('show=false ⇒ 零副作用（§11）', () => {
    const blocks = [{ topic: '机器人', picks: [mkPick('甲股份', 101)] }];
    _applyAbnormalNoBuyRules(blocks, { show: false });
    expect(blocks[0].picks[0].buyActionTag).toBe('竞价买');
    expect(blocks[0].picks[0].position).toBe('重仓');
  });
});

describe('_applyAbnormalSweep · 收口', () => {
  function mkOut(withAbnormalPick) {
    const blk = { topic: '机器人', picks: [mkPick('乙股份', 60)], notes: [] };
    const abnBlk = withAbnormalPick === false
      ? { topic: '海洋经济', picks: [mkPick('甲股份', 55)], notes: [], abnormalPick: null }
      : { topic: '海洋经济', picks: [mkPick('甲股份', 101)], notes: [], abnormalPick: { name: '甲股份' } };
    const backup = { topic: '十日涨幅候补', picks: [mkPick('丙股份', 88)], notes: [] };
    return {
      blocks: [blk, abnBlk],
      range10Backup: backup,
      weakHuddle: { picks: [mkPick('丁股份', null)] },
      catchUp: { picks: [mkPick('戊股份', null)] },
      newDragon: { picks: [mkPick('己股份', null)] },
      ebbBuy: { picks: [mkPick('庚股份', null)] },
      divergeBuy: { picks: [mkPick('辛股份', null)] },
      ebbNodeNote: { headline: 'x' },
      buy: {
        heavy: blk, light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null,
        ebbSecond: { picks: [] }, newDragon: { picks: [] }, range10Backup: backup,
        weakHuddle: { picks: [] }, catchUp: { picks: [] }
      },
      buyNames: new Set(['甲股份', '乙股份']),
      cashAlert: { show: false, headline: '', detail: '' },
      abnormal: { show: false },
      notes: [],
      pickCount: 3
    };
  }

  it('票级异动 ⇒ 空仓标语接管 + 全行改标签 + 特殊通道全下线 + buyNames 清空', () => {
    const out = mkOut();
    const fact = _applyAbnormalSweep(out, {
      leaderName: '东方海洋', leaderPctToday: 60, leaderPctPrev: 60
    });
    expect(fact.show).toBe(true);
    expect(fact.kind).toBe(ABNORMAL_KIND_STOCK);
    expect(out.cashAlert.show).toBe(true);
    expect(out.cashAlert.headline).toContain('空仓');
    // 所有买入行都不可买（含没有异动票的那个题材块 —— 用户「不再买进任何股票」）
    out.blocks.forEach(function(b) {
      b.picks.forEach(function(p) { expect(p.buyActionTag).toBe(ABNORMAL_NO_BUY_TAG); });
    });
    // 特殊通道全下线（否则空仓日还会给一份买入清单）
    expect(out.weakHuddle).toBeNull();
    expect(out.catchUp).toBeNull();
    expect(out.newDragon).toBeNull();
    expect(out.ebbBuy).toBeNull();
    expect(out.divergeBuy).toBeNull();
    expect(out.ebbNodeNote).toBeNull();
    expect(out.buy.weakHuddle).toBeNull();
    expect(out.buy.catchUp).toBeNull();
    expect(out.buy.newDragon).toBeNull();
    expect(out.buy.range10Backup).toBeNull();
    // buyNames 清空 ⇒ 卖点侧不会把昨天买过的票标成【持有】
    expect(out.buyNames.size).toBe(0);
    // ★ 票不删（用户「不用去掉」）
    expect(out.blocks.length).toBe(2);
    expect(out.notes.join('')).toContain('监管异动');
  });

  it('无异动 ⇒ 完全不介入（cashAlert / 通道 / 标签一律不动，§11）', () => {
    const out = mkOut(false);
    const fact = _applyAbnormalSweep(out, {
      leaderName: '东方海洋', leaderPctToday: 60, leaderPctPrev: 70
    });
    expect(fact.show).toBe(false);
    expect(out.cashAlert.show).toBe(false);
    expect(out.weakHuddle).not.toBeNull();
    expect(out.buy.weakHuddle).not.toBeNull();
    expect(out.buyNames.size).toBe(2);
    expect(out.blocks[0].picks[0].buyActionTag).toBe('竞价买');
    expect(out.notes.length).toBe(0);
  });

  it('★ 异动次日：只看昨日那份（今日已回落到 73%）', () => {
    const out = mkOut();
    const fact = _applyAbnormalSweep(out, {
      leaderName: '东方海洋', leaderPctToday: 73.14, leaderPctPrev: 100.78,
      leaderPctPrevBasis: 'auction'
    });
    expect(fact.show).toBe(true);
    expect(fact.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(out.cashAlert.detail).toContain('100.78%');
  });

  it('十日涨幅候补那只异动 ⇒ 也被点名（它是「会被选中的票」）', () => {
    const out = mkOut();
    out.blocks = [];
    out.range10Backup.picks = [mkPick('候补甲', 130)];
    const fact = _applyAbnormalSweep(out, {
      leaderName: '东方海洋', leaderPctToday: 50, leaderPctPrev: 50
    });
    expect(fact.show).toBe(true);
    expect(fact.names).toContain('候补甲');
  });
});

// ── ⑤ [NUM-TEXT 2026-11-13] 真实库内文本形态：防止「夹具全是数字」的假绿 ──────────
//   本项目两次踩过同一类坑：market_metrics 的涨幅列存成 '+2.30%' / '-0.84%' 字符串，
//   裸 Number() 恒 NaN ⇒ 静默折 null ⇒ 判据「读不到」⇒ 规则从不触发，而纯数字夹具全绿。
//   第三十四条 自定义禁选上限 / 100% 两条线全部经 tvrb-utils#_num 解析，必须锁住真实形态。
describe('[NUM-TEXT] 文本型涨幅不得静默判不出（§10 不补 0）', () => {
  it('带 % / 全角+ / 千分位的文本按同一口径分级', () => {
    expect(classifyRange10('+100.78%').level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(classifyRange10('＋100.78%').pct).toBeCloseTo(100.78, 2);
    expect(classifyRange10('95.71%').level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10('96.20%').level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyRange10('98.20%').level).toBe(ABNORMAL_LEVEL_NEAR);
    expect(classifyRange10('1,234%').level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(classifyRange10('-0.84%').level).toBe(ABNORMAL_LEVEL_OK);
  });

  it('脏值仍返回 unknown（⛔ 不折 0 / 不折「没异动」）', () => {
    expect(classifyRange10('—').level).toBe(ABNORMAL_LEVEL_UNKNOWN);
    expect(classifyRange10('  ').level).toBe(ABNORMAL_LEVEL_UNKNOWN);
    expect(isOverRange10Cap('%')).toBe(false);
  });

  it('★ 异动次日用文本型昨日涨幅照样触发空仓', () => {
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '东方',
      leaderPctToday: '73.14%', leaderPctPrev: '+100.78%',
      leaderPctPrevBasis: 'auction', rows: []
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderPctPrevText).toBe('+100.78%');
  });
});
