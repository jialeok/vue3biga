// abnormal-10d.test.js — 第三十四条【监管异动】的单测（★ 2026-11-25 换【官方偏离值】口径后重写）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [DEV-RULE 2026-11-25 用户口径，逐字]
//   「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准……确实是需要改下统一口径是
//     官方偏离值那里产生异动监管，而不是自定义的。也是按照原来的规则要记录首次异动、
//     异动次日等规则不变，只是口径要改变。」
//
//   ⇒ 覆盖四层（与旧版一一对应，只换了尺子）：
//     ① 分级 `classifyDeviation` —— 官方「严重异常波动」红线（10日 ≥ +100% / 30日 ≥ +200%）；
//     ② `resolveAbnormalFact` —— 三种形态（异动次日 / 当日异动 / 票级）+ §10 判不出；
//     ③ `_applyAbnormalSweep` —— 全场空仓标语接管 + 逐行改写 + 下线特殊通道 + 清空 buyNames；
//     ④ `_applyDeviationNearRule` / `_applyDeviationSellOverlay` —— 第三十六 / 三十六·b。
//
// ⚠️ 真实数据锚点（11-25 真库 36 个交易日逐日复算，「位移」就是这四天造成的）：
//     · 11-11 东方海洋：十日涨幅 95.71%（旧口径 ⇒ 不算），**偏离值 +100.01%**（官方 ⇒ 异动）；
//     · 11-12 东方海洋：十日涨幅 100.78%（旧口径 ⇒ 异动），**偏离值 +99.14%**（官方 ⇒ 差 0.86 点，不算）；
//     · 10-30 大业股份：偏离值 +100.14%（官方独有）；
//     · 11-24 北纬科技：偏离值 +100.11%（官方独有）。
//   ⇒ 异动日 11-12 → **11-11**；「异动后第三天」禁入日 11-16 → **11-13**（用户已拍板接受）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyDeviation, isOverOfficialRedLine, isDeviationNearOrOver,
  resolveAbnormalFact, devPctText,
  ABNORMAL_LEVEL_UNKNOWN, ABNORMAL_LEVEL_OK, ABNORMAL_LEVEL_NEAR, ABNORMAL_LEVEL_ABNORMAL
} from './abnormal-10d.js';
import {
  ABNORMAL_NO_BUY_TAG, ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW
} from './tvrb-constants.js';
import { _applyAbnormalSweep, _applyDeviationNearRule, _applyDeviationSellOverlay } from './tvrb-plan.js';
import { DEV_NEAR_RULE_TAG, DEVIATION_SELL_TAG, DEVIATION_SELL_TONE } from '../auction/deviation-rule-facts.js';

// ── 夹具：直接造「偏离事实」（本文件测的是【判定 + 收口】，不是偏离值怎么算）──────
//   `deviationRuleStage` 只读 `ok` / `stage`，所以这里必须**同时**给对 stage 与数字，
//   否则测的就不是同一件事。档位与数字的自洽性由 deviation-rule-facts.test.js 用真实腿锁住。
function fact(stage, dev10, dev30) {
  return {
    ok: true,
    dev10: dev10 === undefined ? null : dev10,
    dev30: dev30 === undefined ? null : dev30,
    stage: stage,
    stageText: stage
  };
}
const OK = function () { return fact('ok', 34.4, 60.2); };
const WATCH = function () { return fact('watch', 70.8, 120.5); };
const NEAR = function (d10) { return fact('near', d10 === undefined ? 91.1 : d10, 150.2); };
const SEVERE = function (d10) { return fact('severe', d10 === undefined ? 100.42 : d10, 150.2); };
const UNKNOWN = function () { return { ok: false, dev10: null, dev30: null, stage: 'unknown' }; };

// ── ① 分级 ────────────────────────────────────────────────────────────────────
describe('classifyDeviation · 官方「严重异常波动」口径', () => {
  it('判不出 ⇒ unknown，⛔ 不折 0、⛔ 不折成「没异动」', () => {
    [null, undefined, {}, UNKNOWN()].forEach(function (f) {
      const r = classifyDeviation(f);
      expect(r.level).toBe(ABNORMAL_LEVEL_UNKNOWN);
      expect(r.dev10).toBe(null);
    });
    expect(devPctText(null)).toBe('—');
  });

  it('ok / watch 都算「没进规则」（用户：偏离放大·留意 不算）', () => {
    expect(classifyDeviation(OK()).level).toBe(ABNORMAL_LEVEL_OK);
    expect(classifyDeviation(WATCH()).level).toBe(ABNORMAL_LEVEL_OK);
  });

  it('near ⇒ 逼近（还没越线）', () => {
    const r = classifyDeviation(NEAR());
    expect(r.level).toBe(ABNORMAL_LEVEL_NEAR);
    expect(isDeviationNearOrOver(NEAR())).toBe(true);
    expect(isOverOfficialRedLine(NEAR())).toBe(false);
  });

  it('severe ⇒ 越线（唯一构成「监管异动」的档位）', () => {
    const r = classifyDeviation(SEVERE());
    expect(r.level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(isOverOfficialRedLine(SEVERE())).toBe(true);
    expect(isDeviationNearOrOver(SEVERE())).toBe(true);
  });

  it('文本型偏离值（库里可能带 % / 正号）按同一口径解析', () => {
    expect(classifyDeviation(fact('severe', '100.11%', '+150.2%')).level).toBe(ABNORMAL_LEVEL_ABNORMAL);
    expect(devPctText('100.11%')).toBe('+100.11%');
    expect(devPctText(-45.5)).toBe('-45.50%');
  });

  it('★ 位移锚点：11-11 +100.01 是异动；11-12 +99.14 只是逼近（差 0.86 点）', () => {
    expect(isOverOfficialRedLine(SEVERE(100.01))).toBe(true);      // 11-11 东方海洋 ⇒ 异动
    expect(isOverOfficialRedLine(NEAR(99.14))).toBe(false);        // 11-12 ⇒ 不异动（旧口径误判）
    expect(classifyDeviation(NEAR(99.14)).level).toBe(ABNORMAL_LEVEL_NEAR);
  });
});

// ★★ [MARKET-DRAGON-ONLY 2026-11-25] 原 `pickRedLineSource`（从一批票里挑越线最严重那只）
//   的整段测试已随函数一起删除 —— 触发源唯一是市龙一，不存在「挑一只」这件事。
//   ⛔ 不要因为它「看起来覆盖了某条边界」就把它加回来：那会重新引入「按偏离值最高票触发」的错口径。

// ── ② resolveAbnormalFact：两种形态 + 优先级（★ [MARKET-DRAGON-ONLY] 第三种已删除）────
describe('resolveAbnormalFact · 两种触发形态（判定对象唯一 = 市龙一）', () => {
  const base = { leaderName: '东方海洋', leaderTopic: '水产品' };

  it('★ 异动次日：昨日越线、今日回落 ⇒ 仍判空仓', () => {
    const f = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: NEAR(73.14), leaderDevPrev: SEVERE(100.01)
    }));
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderDevPrevText).toBe('+100.01%');
    expect(f.detail).toContain('异动次日');
    expect(f.detail).toContain(ABNORMAL_NO_BUY_TAG);
  });

  it('当日异动：今日越线 ⇒ 今天空仓', () => {
    const f = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: SEVERE(100.42), leaderDevPrev: OK()
    }));
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.detail).toContain('9:25 竞价口径');
  });

  it('★★ 已删除的形态：「入选票异动」不再存在（个股越线 ≠ 全场空仓）', () => {
    // 市龙一自己都只是 ok，却另有一只票越线 ⇒ 本条【判不出异动】（那只票归第三十六条）
    const f = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: OK(), leaderDevPrev: OK()
    }));
    expect(f.show).toBe(false);
    expect(f.kind).toBe('');
    // 函数签名里已经没有 rows / leaderIsTop1 了，多传也不会改变结论（⛔ 不许被它们影响）
    const g = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: OK(), leaderDevPrev: OK(),
      rows: [{ name: '九阳股份', topic: '大消费', dev: SEVERE(100.11) }],
      leaderIsTop1: false
    }));
    expect(g.show).toBe(false);
    expect(g.detail).toBe('');
  });

  it('优先级：异动次日 > 当日异动', () => {
    const f = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: SEVERE(), leaderDevPrev: SEVERE()
    }));
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
  });

  it('★ near 只记不空仓（第三十六条接管，⛔ 不许让它触发全场空仓）', () => {
    const f = resolveAbnormalFact(Object.assign({}, base, {
      leaderDevToday: NEAR(), leaderDevPrev: NEAR()
    }));
    expect(f.show).toBe(false);
    // 事实照样带出去（第三十六条逐只灰靠它），但⛔ 没有「名单」这种东西了
    expect(f.leaderDevTodayLevel).toBe('near');
    expect(f.nearNames).toBeUndefined();
  });

  it('§10：两份都判不出 ⇒ show=false 且如实标 unknownLeader', () => {
    const f = resolveAbnormalFact({ leaderDevToday: UNKNOWN(), leaderDevPrev: UNKNOWN() });
    expect(f.show).toBe(false);
    expect(f.unknownLeader).toBe(true);
  });

  it('文案必须写明官方红线与「旧自定义口径已废除」', () => {
    const f = resolveAbnormalFact(Object.assign({}, base, { leaderDevToday: SEVERE() }));
    expect(f.detail).toContain('+100%');
    expect(f.detail).toContain('+200%');
    expect(f.detail).toContain('已废除');
    expect(f.detail).toContain('偏离值 = 个股累计涨幅 − 对应指数累计涨幅');
  });

  it('称谓恒为「市龙一（30日涨幅第1·主板）」—— ⛔ 不再有第二套叫法', () => {
    const f = resolveAbnormalFact({
      leaderName: '福莱新材', leaderDevToday: SEVERE()
    });
    expect(f.leaderLabel).toBe('市龙一（30日涨幅第1·主板）');
    expect(f.detail).toContain('只认市龙一');
    expect(f.detail).not.toContain('市场总龙一');
    expect(f.detail).not.toContain('市场偏离值最高票');
  });

  it('★ §10：市龙一名字读不到 ⇒ 判不出（⛔ 绝不拿别的票顶替）', () => {
    const f = resolveAbnormalFact({ leaderDevToday: SEVERE(), leaderDevPrev: SEVERE() });
    expect(f.show).toBe(false);
    expect(f.unknownLeader).toBe(true);
  });
});

// ── ③ 收口：全场空仓 ──────────────────────────────────────────────────────────
function makeOut() {
  return {
    blocks: [{ topic: 'AI应用', picks: [{ name: '甲', buyActionTag: '' }, { name: '乙', buyActionTag: '' }] }],
    range10Backup: { topic: '十日涨幅候补', picks: [{ name: '丙', buyActionTag: '' }] },
    ebbBuy: { picks: [{ name: '丁' }] },
    divergeBuy: { picks: [{ name: '戊' }] },
    newDragon: { picks: [{ name: '己' }] },
    weakHuddle: { picks: [] },
    catchUp: { picks: [] },
    top30Huddle: { picks: [] },
    ebbNodeNote: 'x',
    buy: { newDragon: { picks: [{ name: '己' }] } },
    buyNames: new Set(['甲', '乙', '丙', '丁', '戊', '己']),
    notes: []
  };
}

describe('_applyAbnormalSweep · 越线 ⇒ 全场空仓收口', () => {
  it('市龙一越线 ⇒ 标语接管 + 全行改【异动不买】+ 特殊通道全下线 + buyNames 清空', () => {
    const out = makeOut();
    const f = _applyAbnormalSweep(out, {
      leaderName: '甲',
      devAuto: new Map([['甲', SEVERE()], ['乙', OK()]])
    });
    expect(f.show).toBe(true);
    expect(out.cashAlert.show).toBe(true);
    (out.blocks[0].picks || []).forEach(function (p) {
      expect(p.buyActionTag).toBe(ABNORMAL_NO_BUY_TAG);   // 行不删、只改标签
    });
    expect(out.ebbBuy).toBe(null);
    expect(out.divergeBuy).toBe(null);
    expect(out.newDragon).toBe(null);
    expect(out.range10Backup).toBe(null);
    expect(out.buyNames.size).toBe(0);
    expect(out.notes.join('\n')).toContain('市龙一监管异动');
  });

  it('★ 只有 near ⇒ 本条【不收口】（那是第三十六条的事，只禁这一只）', () => {
    const out = makeOut();
    const f = _applyAbnormalSweep(out, {
      leaderName: '甲',
      devAuto: new Map([['甲', NEAR()], ['乙', NEAR()]])
    });
    expect(f.show).toBe(false);
    expect(out.ebbBuy).not.toBe(null);
    expect(out.blocks[0].picks[0].buyActionTag).toBe('');
    expect(out.buyNames.size).toBe(6);
  });

  it('★ 异动次日：只看昨日那份（今日已回落到 73%）', () => {
    const out = makeOut();
    const f = _applyAbnormalSweep(out, {
      leaderName: '东方海洋',
      devAuto: new Map([['东方海洋', NEAR(73.14)]]),
      devPrev: new Map([['东方海洋', SEVERE(100.01)]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(out.notes.join('\n')).toContain('昨日（收盘口径）10日偏离 +100.01%');
  });

  it('§10：一张事实都没有 ⇒ 不收口（判不出 ≠ 没异动，由说明区交代）', () => {
    const out = makeOut();
    const f = _applyAbnormalSweep(out, { leaderName: '', devAuto: new Map() });
    expect(f.show).toBe(false);
    expect(out.buyNames.size).toBe(6);
  });
});

// ── ④ 第三十六 / 三十六·b ────────────────────────────────────────────────────
describe('_applyDeviationNearRule · 逼近红线只禁这一只（第三十六条）', () => {
  it('near / severe 的行改标签 + 灰块 + 剔出 buyNames；同块其它票照常', () => {
    const out = makeOut();
    const n = _applyDeviationNearRule(out, {
      devAuto: new Map([['甲', NEAR()], ['乙', OK()]]),
      basis: 'auction'
    });
    expect(n).toBe(1);
    const [p1, p2] = out.blocks[0].picks;
    expect(p1.buyActionTag).toBe(DEV_NEAR_RULE_TAG);
    expect(p1.buyActionTone).toBe('ebb-nobuy');
    expect(p1.actionNote).toContain('不给买点');
    expect(p1.devRuleStage).toBe('near');
    // ★★ [ROW-GRAY 2026-11-25] 「不能买 ⇒ 那一只灰色块（非题材）」必须下发行级旗子
    expect(p1.noBuyRowGray).toBe(true);
    expect(p2.noBuyRowGray).toBeFalsy();
    expect(p2.buyActionTag).toBe('');
    expect(out.buyNames.has('甲')).toBe(false);      // ★ 必须剔出（否则卖点侧会标【持有】）
    expect(out.buyNames.has('乙')).toBe(true);
    expect(out.notes.join('\n')).toContain(DEV_NEAR_RULE_TAG);
    expect(out.notes.join('\n')).toContain('其它票照常');
  });

  it('★ watch（偏离放大·留意）不施加任何限制（用户明确不算）', () => {
    const out = makeOut();
    const n = _applyDeviationNearRule(out, { devAuto: new Map([['甲', WATCH()]]), basis: 'close' });
    expect(n).toBe(0);
    expect(out.blocks[0].picks[0].buyActionTag).toBe('');
    expect(out.buyNames.size).toBe(6);
  });

  // ★★ [GOLDEN · DEV-RULE-AUC-ONLY 2026-11-25] 华东重机两日真库回放
  //   真库 .tmpdiag/_dev-basis-e2e.mjs 取证（11-24）：
  //     收盘 dev10=94.29 / dev30=91.48 ⇒ near（旧口径在此被灰 —— 用户报障的那一次）
  //     竞价 dev10=83.32 / dev30=81.08 ⇒ watch（按用户口径【不该灰】）
  //     11-25 真库：收盘 100.03 / 99.05 ⇒ severe，竞价 95.05 / 94.26 ⇒ near（该灰）。
  it('★ GOLDEN 11-24 华东重机：竞价 watch 不灰；反证误吃收盘 near 就会灰', () => {
    function outOf1124() {
      const out = makeOut();
      out.blocks[0].picks[0].name = '华东重机';
      out.buyNames.delete('甲');
      out.buyNames.add('华东重机');
      return out;
    }

    // ✅ 修复后：选股侧一律竞价 ⇒ watch ⇒ 不灰、不剔出
    const good = outOf1124();
    const n = _applyDeviationNearRule(good, {
      devAuto: new Map([['华东重机', fact('watch', 83.32, 81.08)]]),
      basis: 'auction'
    });
    expect(n).toBe(0);
    expect(good.blocks[0].picks[0].noBuyRowGray).toBeFalsy();
    expect(good.blocks[0].picks[0].buyActionTag).toBe('');
    expect(good.buyNames.has('华东重机')).toBe(true);

    // 🔴 反证：若错吃收盘（旧 bug），11-24 就会被灰 + 剔出 —— 锁死口径不能回退
    const bad = outOf1124();
    _applyDeviationNearRule(bad, {
      devAuto: new Map([['华东重机', fact('near', 94.29, 91.48)]]),
      basis: 'close'
    });
    expect(bad.blocks[0].picks[0].noBuyRowGray).toBe(true);
    expect(bad.buyNames.has('华东重机')).toBe(false);

    // ✅ 11-25 竞价 near ⇒ 当日确实该灰（用户口径不变，别把 11-24 的修复做成「永不灰」）
    const d25 = outOf1124();
    _applyDeviationNearRule(d25, {
      devAuto: new Map([['华东重机', fact('near', 95.05, 94.26)]]),
      basis: 'auction'
    });
    expect(d25.blocks[0].picks[0].noBuyRowGray).toBe(true);
    expect(d25.blocks[0].picks[0].actionNote).toContain('9:25 竞价');
  });

  it('§10：判不出的票不施加限制，但必须写明「不是已确认安全」', () => {
    const out = makeOut();
    _applyDeviationNearRule(out, { devAuto: new Map([['甲', UNKNOWN()], ['乙', UNKNOWN()]]) });
    expect(out.buyNames.size).toBe(6);
    expect(out.notes.join('\n')).toContain('没有施加');
    expect(out.notes.join('\n')).toContain('不是「已确认安全」');
  });

  it('覆盖全部买点通道（含 out.buy.* 的第二份引用）', () => {
    const out = makeOut();
    _applyDeviationNearRule(out, { devAuto: new Map([['己', SEVERE()]]), basis: 'auction' });
    expect(out.newDragon.picks[0].buyActionTag).toBe(DEV_NEAR_RULE_TAG);
    expect(out.buy.newDragon.picks[0].buyActionTag).toBe(DEV_NEAR_RULE_TAG);
    expect(out.buyNames.has('己')).toBe(false);
  });
});

describe('_applyDeviationSellOverlay · 异动卖（三十六·b）', () => {
  function sellOut() {
    return {
      sell: [{
        topic: '水产品',
        items: [
          { name: '东方海洋', sellActionTag: '竞价卖', sellActionTone: 'out', holdTag: '', buyActionTag: '' },
          { name: '其它票', sellActionTag: '持有', sellActionTone: 'hold', holdTag: '持有', buyActionTag: '' }
        ]
      }]
    };
  }

  it('逼近 / 越线的持仓 ⇒ 动作改【异动卖】+ 专属色调 + 写清原本的动作', () => {
    const out = sellOut();
    const n = _applyDeviationSellOverlay(out, {
      devAuto: new Map([['东方海洋', NEAR()]]), basis: 'auction'
    });
    expect(n).toBe(1);
    const it = out.sell[0].items[0];
    expect(it.sellActionTag).toBe(DEVIATION_SELL_TAG);
    expect(it.sellActionTone).toBe(DEVIATION_SELL_TONE);
    expect(it.actionNote).toContain('当天出掉');
    expect(it.actionNote).toContain('原卖点动作：竞价卖');
    // ⛔ 不许再挂「持有」——「今天必须走」与「持有」正面矛盾
    expect(it.holdTag).toBe('');
    expect(it.buyActionTag).toBe('');
    // 另一只不受影响
    expect(out.sell[0].items[1].sellActionTag).toBe('持有');
  });

  it('watch / 判不出 ⇒ 一律不动', () => {
    const out = sellOut();
    const n = _applyDeviationSellOverlay(out, {
      devAuto: new Map([['东方海洋', WATCH()], ['其它票', UNKNOWN()]])
    });
    expect(n).toBe(0);
    expect(out.sell[0].items[0].sellActionTag).toBe('竞价卖');
  });

  it('没有卖点段 / 空事实 ⇒ 零行为（§11）', () => {
    expect(_applyDeviationSellOverlay({}, { devAuto: new Map() })).toBe(0);
    expect(_applyDeviationSellOverlay(null, {})).toBe(0);
    expect(_applyDeviationSellOverlay(sellOut(), { devAuto: null })).toBe(0);
  });
});

// ── 源码静态锁：旧口径的判据不许复活 ─────────────────────────────────────────
describe('源码静态锁 · 旧自定义口径（95 / 97 / 100）必须彻底消失', () => {
  const src = readFileSync('src/logic/topicvolratio/abnormal-10d.js', 'utf8');

  it('⛔ 不再导出 classifyRange10 / isOverRange10Cap / pickAbnormalSource', () => {
    expect(src).not.toMatch(/export function classifyRange10/);
    expect(src).not.toMatch(/export function isOverRange10Cap/);
    expect(src).not.toMatch(/export function pickAbnormalSource/);
  });

  it('✅ 新判据只走 deviation-rule-facts（§6 一把尺子）', () => {
    expect(src).toContain("from '../auction/deviation-rule-facts.js'");
    expect(src).toContain('deviationRuleStage');
  });
});
