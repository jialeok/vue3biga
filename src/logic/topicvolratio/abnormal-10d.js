// abnormal-10d.js — 「监管异动 · 十日涨幅硬上限」的【唯一判定实现】（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-11-13 原话，逐字）★★ 见 tvrb-constants.js 的第三十四条常量块
// ══════════════════════════════════════════════════════════════════════════════════════
//   核心三句：
//     ① 「新增总约束，十日涨幅竞价口径不能超过 95%」—— 95 是【自定义选股上限】；
//     ② 「十日达到 100% 异动，提示空仓，选出的票整块变灰色（不用去掉）」；
//     ③ 「总龙一异动次日……也要空仓，不再选票……不在买进任何股票」。
//
// 职责边界（§3 / §4 / §21）：
//   · 本模块【只做两件事】：把涨幅分级（ok / near / abnormal）+ 把事实拼成一块可渲染的标语；
//   · ⛔ 不取数、不落库、不发请求：昨日十日涨幅 / 今日十日涨幅 / 总龙一身份全部由
//     组合式（useTopicVolRatioBoard）与采集层注入 —— 与本模块无关；
//   · ⛔ 不判「要不要顺延下一龙位」：那是 _buildBlock 的事（用本模块的 classifyRange10 一处判据）；
//   · ⛔ 不删任何票：本模块只产出文案 + 事实，票的去留由规则层决定 —— 用户「不用去掉」。
//     ⚠️ [审查订正 2026-11-13] 整块灰化【不是】靠某个 `abnormalGray` 字段（代码里没有这个字段，
//        旧注释把人往不存在的实现上引）：规则层把 fact 交给 buildCashAlert ⇒ cashAlert.show
//        驱动视图既有的 `.tvrb-buy-list.tvrb-ebb`（§6 不造第二套灰化）；
//        `_applyAbnormalNoBuyRules` 只把逐行标签改成【异动不买】。`abnormalPick` 是留痕字段。
//
// §10 红线（⛔ 一次都不能破）：
//   · 涨幅读不到（null / 空串 / 非法）⇒ 分级 = 'unknown'，⛔ 绝不补 0、⛔ 绝不当成「没异动」下结论；
//   · 总龙一身份读不到 ⇒ fact.unknownLeader = true，文案如实写「判不出」，⛔ 不假装「总龙一没异动」；
//   · 昨日那份没读到 ⇒ 只判「当日异动」，不判「异动次日」，文案注明缺口（⛔ 不能沉默）。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  TVRB_RANGE10_CAP, TVRB_RANGE10_ABNORMAL, ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG,
  ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW, ABNORMAL_KIND_STOCK, TVRB_ABNORMAL_NONE
} from './tvrb-constants.js';
import { _num, _pct2 } from './tvrb-utils.js';

/** 分级：未知（读不到） / 正常 / 超限（95~100） / 异动（≥100） */
export const ABNORMAL_LEVEL_UNKNOWN = 'unknown';
export const ABNORMAL_LEVEL_OK = 'ok';
export const ABNORMAL_LEVEL_NEAR = 'near';
export const ABNORMAL_LEVEL_ABNORMAL = 'abnormal';

/**
 * 【纯函数】十日涨幅（竞价口径，单位 = %）→ 分级。
 *
 * 边界口径（⛔ 别改，改了与规则手册条文不一致）：
 *   · pct ≥ 100  ⇒ 'abnormal'（异动，含恰好 100）
 *   · pct >  95  ⇒ 'near'    （超出自定义上限，但未到交易所红线）
 *   · pct ≤ 95   ⇒ 'ok'
 *   · 读不到     ⇒ 'unknown'（§10 不补 0）
 *
 * @param {number|string|null|undefined} pct
 * @returns {{level:string, pct:number|null, pctText:string}}
 */
export function classifyRange10(pct) {
  const n = _num(pct);
  if (n === null) {
    return { level: ABNORMAL_LEVEL_UNKNOWN, pct: null, pctText: '—' };
  }
  if (n >= TVRB_RANGE10_ABNORMAL) {
    return { level: ABNORMAL_LEVEL_ABNORMAL, pct: n, pctText: _pct2(n) };
  }
  if (n > TVRB_RANGE10_CAP) {
    return { level: ABNORMAL_LEVEL_NEAR, pct: n, pctText: _pct2(n) };
  }
  return { level: ABNORMAL_LEVEL_OK, pct: n, pctText: _pct2(n) };
}

/**
 * 【纯函数】某只票是不是「超出自定义上限、今天不该买」（95 < pct < 100，或恰好也含 100 的展示口径另算）。
 *
 * ⚠️ 调用方（tvrb-blocks#_buildBlock）用它做选股闸门：
 *   pct ≥ 100 ⇒ 走【异动】那条（保留展示 + 整段灰化），⛔ 不是「跳过」；
 *   95 < pct < 100 ⇒ 跳过错该龙位、顺延下一只（名额照买满）。
 *
 * @param {number|string|null} pct
 * @returns {boolean} true = 超过 95% 上限（含异动）
 */
export function isOverRange10Cap(pct) {
  const lv = classifyRange10(pct).level;
  return lv === ABNORMAL_LEVEL_NEAR || lv === ABNORMAL_LEVEL_ABNORMAL;
}

/** 「X（题材 +101.20%）」这类点名文案（⛔ 只用于说明，不参与判定，§21 文案在 Logic 层拼好） */
function _pointOf(name, topic, pctText) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '，' : '（') + '十日涨幅 ' + pctText + '）';
}

/**
 * 【纯函数】把注入的「事实」判成一块可渲染的异动标语（= cashAlert 的同形状对象）。
 *
 * @param {object} [input]
 * @param {string} [input.leaderName]      市场总龙一 = 20日涨幅主板第 1 名（采集层 ebbCtx.top5[0]）
 * @param {string} [input.leaderTopic]     它的题材（只用于点名，⛔ 不参与判定）
 * @param {number|string|null} [input.leaderPctToday] 它【今日】的十日涨幅（9:26 竞价口径，pctMap）
 * @param {number|string|null} [input.leaderPctPrev]  它【昨日】的十日涨幅（组合式 prevRange10）
 * @param {'auction'|'close'|''} [input.leaderPctPrevBasis] 昨日那份用的是【竞价口径】还是【收盘口径】
 *        —— ★ 用户要的是竞价口径（原话「东方海洋，昨天竞价口径就超过 100% 了」）；
 *        竞价那份没读到时退回收盘口径，必须在文案里说清（§10：口径不许含糊）。
 * @param {Array<{name:string, topic?:string, pct:number|string|null}>} [input.rows]
 *        今天【会被选中的票】—— 常规题材块 picks + 十日涨幅候补（口径都是十日涨幅）
 *        ⚠️ ⛔ 别把「20日涨幅」通道的票（退潮替补 / 新龙 / 抱团 / 补涨）塞进来：
 *           那些行的 pct 是 20日涨幅，拿它比 95/100 是【口径串用】，比不判更坏。
 * @returns {object} 与 TVRB_ABNORMAL_NONE 同形状（show=false ⇒ 一字不动，§11）
 */
export function resolveAbnormalFact(input) {
  const i = input || {};
  const leaderName = String(i.leaderName || '').trim();
  const leaderTopic = String(i.leaderTopic || '').trim();
  const today = classifyRange10(i.leaderPctToday);
  const prev = classifyRange10(i.leaderPctPrev);
  const rows = Array.isArray(i.rows) ? i.rows : [];

  // ① 点名：哪些票已经异动（≥100） / 哪些只是超限（95~100）
  const hits = [];
  const near = [];
  const seen = new Set();
  rows.forEach(function(r) {
    if (!r) return;
    const nm = String(r.name || '').trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    const lv = classifyRange10(r.pct);
    if (lv.level === ABNORMAL_LEVEL_ABNORMAL) {
      hits.push({ name: nm, topic: String(r.topic || '').trim(), pct: lv.pct, pctText: lv.pctText });
    } else if (lv.level === ABNORMAL_LEVEL_NEAR) {
      near.push({ name: nm, topic: String(r.topic || '').trim(), pct: lv.pct, pctText: lv.pctText });
    }
  });

  // ② 触发形态（优先级：异动次日 > 当日异动 > 入选票异动）
  let kind = '';
  if (prev.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_NEXT_DAY;
  else if (today.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_LEADER_NOW;
  else if (hits.length > 0) kind = ABNORMAL_KIND_STOCK;

  // ③ §10：总龙一的十日涨幅两份都读不到 ⇒ 如实标记「判不出」（⛔ 不假装没有异动）
  const unknownLeader = !leaderName || (today.level === ABNORMAL_LEVEL_UNKNOWN && prev.level === ABNORMAL_LEVEL_UNKNOWN);

  const base = {
    show: false,
    kind: kind,
    ruleNo: ABNORMAL_RULE_NO,
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderPctPrev: prev.pct,
    leaderPctPrevText: prev.pctText,
    leaderPctToday: today.pct,
    leaderPctTodayText: today.pctText,
    names: hits.map(function(x) { return x.name; }),
    nearNames: near.map(function(x) { return x.name; }),
    unknownLeader: unknownLeader,
    headline: '',
    detail: ''
  };

  if (!kind) return Object.assign({}, TVRB_ABNORMAL_NONE, {
    // 没有异动也要把「判没判过」带出去：说明区靠 unknownLeader / nearNames 交代缺口与超限票。
    leaderName: base.leaderName,
    leaderTopic: base.leaderTopic,
    leaderPctPrev: base.leaderPctPrev,
    leaderPctPrevText: base.leaderPctPrevText,
    leaderPctToday: base.leaderPctToday,
    leaderPctTodayText: base.leaderPctTodayText,
    nearNames: base.nearNames,
    unknownLeader: base.unknownLeader
  });

  // ④ 文案（§21：★ 大字标语 + 说明全部在 Logic 层拼好，模板零计算）
  const capLine = '★ 硬上限口径（第' + ABNORMAL_RULE_NO + '条）：十日涨幅（竞价口径）' +
    '＞ ' + TVRB_RANGE10_CAP + '% 的票【一律不选】；达到 ' + TVRB_RANGE10_ABNORMAL +
    '% = 交易所「严重异常波动」⇒ 整段灰化、一枚买点都不给（票照常列出，供你核对，⛔ 不删）。';
  const whyLine = '★ 为什么：单只票十日涨幅到达 ' + TVRB_RANGE10_ABNORMAL +
    '% 就是监管异动；一旦【总龙一】异动，它所在题材的股票【次日基本都会崩】，甚至带崩整个市场情绪。' +
    '所以第' + ABNORMAL_RULE_NO + '条是【总约束】—— 比 ' + TVRB_RANGE10_CAP +
    '% 还低 ' + (TVRB_RANGE10_ABNORMAL - TVRB_RANGE10_CAP) + ' 个点，就是防「99% 就开始有题材崩盘节奏」。';

  const prevBasisText = (i.leaderPctPrevBasis === 'auction')
    ? '（昨日竞价口径）'
    : (i.leaderPctPrevBasis === 'close' ? '（昨日收盘口径 —— 昨日竞价那份没读到）' : '');
  let lead = '';
  if (kind === ABNORMAL_KIND_NEXT_DAY) {
    lead = '市场总龙一' + _pointOf(leaderName, leaderTopic, prev.pctText) +
      '【昨日（上一交易日）】就已触发监管异动（≥ ' + TVRB_RANGE10_ABNORMAL + '%）⇒ 今天是【异动次日】：' +
      '按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  } else if (kind === ABNORMAL_KIND_LEADER_NOW) {
    lead = '市场总龙一' + _pointOf(leaderName, leaderTopic, today.pctText) +
      '【今日】（9:26 竞价口径）触发监管异动（≥ ' + TVRB_RANGE10_ABNORMAL + '%）⇒ 按第 ' +
      ABNORMAL_RULE_NO + ' 条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  } else {
    lead = '入选票 ' + hits.map(function(x) {
      return _pointOf(x.name, x.topic, x.pctText);
    }).join('、') + ' 十日涨幅达到 ' + TVRB_RANGE10_ABNORMAL + '%（监管异动）⇒ 按第 ' +
      ABNORMAL_RULE_NO + ' 条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  }

  const tail = [];
  if (leaderName) {
    tail.push('（自核用）总龙一 ' + leaderName + '：今日十日涨幅 ' + today.pctText +
      (prev.level === ABNORMAL_LEVEL_UNKNOWN
        ? '，昨日那份未读到（判不出异动次日）'
        : '，昨日 ' + prev.pctText + prevBasisText) + '。');
  } else {
    tail.push('⚠️ 总龙一（20日涨幅主板第 1 名）还没读到 ⇒ 只判了入选票自身，' +
      '「异动次日」这一条【判不出】（§10：判不出 ≠ 没有异动）。');
  }
  if (near.length > 0) {
    tail.push('⚠️ 另有超出自定义上限 ' + TVRB_RANGE10_CAP + '% 的票（已按【不选入】处理、顺延下一只）：' +
      near.map(function(x) { return _pointOf(x.name, x.topic, x.pctText); }).join('、') + '。');
  }
  tail.push('⚠️ 下方股票仍按原规则【照常列出】（不删不改），但买点标签一律为【' + ABNORMAL_NO_BUY_TAG +
    '】，不计入「选出 N 只」。');

  return Object.assign(base, {
    show: true,
    headline: '🚨 监管异动 · 今日空仓（不买任何票）',
    detail: lead + whyLine + capLine + tail.join('')
  });
}
