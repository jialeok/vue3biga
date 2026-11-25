// abnormal-10d.js — 「监管异动」的【唯一判定实现】（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★★ [DEV-RULE 2026-11-25 口径整体替换] 本文件已从「十日涨幅硬上限」换成
//      **交易所官方「收盘价格涨跌幅偏离值累计值」**。旧的 95 / 97 / 100 三个自定义阈值
//      **全部废除（repealed）**，只在文案里留作历史对照，⛔ 不再参与任何判定。
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户原话（2026-11-25，逐字）：
//     「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准，之前你们也提醒要更换口径，
//       换成官方偏离值，当时我说观察一段时间，现在观察后，确实是需要改下统一口径是官方偏离值
//       那里产生异动监管，而不是自定义的。也是按照原来的规则要记录首次异动，异动次日等规则不变，
//       只是口径要改变。」
//
//   ⇒ **三种形态与后果一律不变**，只换尺子：
//     · 形态：① 异动次日（昨日越线）② 当日异动（今日越线）③ 入选票异动；
//     · 后果：**全场级** —— 整个市场整片灰 + 空仓 + 一张票都不买（[FULL-MARKET] 口径沿用，
//       用户 11-13 原话「总龙一影响范围很大的，这个波及到所有的票」）。
//     · 新尺子：10 日偏离 ≥ +100% 或 30 日偏离 ≥ +200%（负向 ≤ −50% / ≤ −70%）
//       —— 阈值唯一来源 `abnormal-deviation.js#DEV_THRESHOLDS`，⛔ 不许在这里再写数字。
//
//   ★ 为什么必须换（11-25 真库 36 个交易日逐日复算的实测位移）：
//     两把尺子各触发 6 天，**只有 3 天重合**（10-08 / 10-09 / 10-12）。
//     自定义独有：10-13、10-14、11-12；官方独有：10-30（大业股份 100.14%）、
//     **11-11（东方海洋 100.01%）**、11-24（北纬科技 100.11%）。
//     ⇒ 异动日 11-12 → **11-11**，第三十四条延伸的禁令日 11-16 → **11-13**。
//       用户已拍板「接受位移，要按新口径覆盖的」⇒ 历史日按新口径重算覆盖。
//
// 职责边界（§3 / §4 / §21）：
//   · 本模块【只做两件事】：把偏离事实分级（near / severe）+ 把事实拼成一块可渲染的标语；
//   · ⛔ 不取数、不落库、不发请求：偏离事实由组合式（useAbnormalDeviation）算好注入；
//   · ⛔ 不判「要不要顺延下一龙位」：[FULL-MARKET] 口径下**根本没有顺延**；
//     `_buildBlock` 只负责逐行打标签，全场整片灰由收口与显示层叠加；
//   · ⛔ 不删任何票：本模块只产出文案 + 事实，票的去留由规则层决定 —— 用户「不用去掉」。
//     ⚠️ 整块灰化【不是】靠某个 `abnormalGray` 字段（代码里没有这个字段）：规则层把 fact 交给
//        buildCashAlert ⇒ cashAlert.show 驱动视图既有的 `.tvrb-buy-list.tvrb-ebb`（§6 不造第二套灰化）。
//
// §10 红线（⛔ 一次都不能破）：
//   · 偏离值读不到（`ok!==true` / 腿缺）⇒ 分级判不出，⛔ 绝不补 0、⛔ 绝不当成「没异动」下结论；
//   · 总龙一身份读不到 ⇒ fact.unknownLeader = true，文案如实写「判不出」；
//   · 昨日那份没读到 ⇒ 只判「当日异动」，不判「异动次日」，文案注明缺口（⛔ 不能沉默）。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  TVRB_RANGE10_CAP, ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG,
  ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW, ABNORMAL_KIND_STOCK, TVRB_ABNORMAL_NONE
} from './tvrb-constants.js';
// ★ [DEV-RULE 2026-11-25] 官方偏离值口径：档位判据 / 触发源择一全部走 deviation-rule-facts（§6 一份实现）
import {
  deviationRuleStage, DEV_RULE_SEVERE, DEV_RULE_NEAR, pickSevereDeviation
} from '../auction/deviation-rule-facts.js';

/**
 * 分级（★ [DEV-RULE 2026-11-25] 换官方口径后，四档语义重写）：
 *   · `unknown`  —— 偏离值判不出（腿缺 / 读失败）。⛔ 绝不等价于「没异动」
 *   · `ok`       —— 已算出且未越线（含 `watch`「偏离放大·留意」：用户明确不算，见 deviation-rule-facts）
 *   · `near`     —— 逼近交易所偏离红线（红线 × 0.9），**还没越线**
 *   · `abnormal` —— 已达交易所「严重异常波动」标准（10日 ≥ +100% / 30日 ≥ +200%）
 * ⚠️ [FULL-MARKET] `near` 与 `abnormal` 在**本条（第三十四条）里后果不同**：
 *     只有 `abnormal`（真越线）才构成「监管异动 ⇒ 全场空仓」；
 *     `near` 由第三十六条单独处理（**只那一只**不给买点）。⛔ 别再把两者混为一谈
 *     —— 那是旧自定义口径（>97% 即全场空仓）留下的语义，用户已明确改掉。
 */
export const ABNORMAL_LEVEL_UNKNOWN = 'unknown';
export const ABNORMAL_LEVEL_OK = 'ok';
export const ABNORMAL_LEVEL_NEAR = 'near';
export const ABNORMAL_LEVEL_ABNORMAL = 'abnormal';

/**
 * 【纯函数】一条官方偏离值事实 → 监管异动分级。
 *
 * ★★ [DEV-RULE 2026-11-25 口径整体替换 · 旧口径已 repealed] ★★
 *   旧口径（已删除）：`classifyRange10(pct)` 按「十日涨幅（9:26 竞价）> 97%」分级。
 *   用户原话：「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准，之前你们也提醒要
 *     更换口径，换成官方偏离值……现在观察后，确实是需要改下统一口径是官方偏离值那里产生
 *     异动监管，而不是自定义的。也是按照原来的规则要记录首次异动，异动次日等规则不变，
 *     只是口径要改变。」
 *   ⇒ 现在只认【官方严重异常波动】：10日偏离 ≥ +100% 或 30日 ≥ +200%（负向 ≤ −50% / ≤ −70%）。
 *
 * 为什么两套尺子会给出不同答案（11-25 真实库实测，36 个交易日）：
 *   · 11-12 东方海洋：十日涨幅 +100.78%（旧口径 ⇒ 异动），但同期指数在涨，
 *     偏离值只有 **+99.14%**（官方 ⇒ 差 0.86 点，不算异动）；
 *   · 11-11 东方海洋：十日涨幅只有 95.71%（旧口径 ⇒ 不算），偏离值却是 **+100.01%**（官方 ⇒ 异动）。
 *   两套尺子 36 天里各触发 6 天、只有 3 天重合 ⇒ 这就是用户说的「有些不准」。
 *
 * @param {object|null} fact `abnormal-deviation.js#computeDeviation` 的返回
 * @returns {{level:string, dev10:number|null, dev30:number|null, stage:string}}
 *          `unknown` = 判不出（§10 绝不当作「没异动」）；`near` 与 `abnormal` 的**后果不同**：
 *          `abnormal` = 监管异动（第三十四条：全场空仓 + 三十四·b 三天同题材禁入）；
 *          `near` = 逼近红线（第三十六条：只这只票不给买点 / 卖点当天出掉）。
 */
export function classifyDeviation(fact) {
  const st = deviationRuleStage(fact);
  const f = fact || {};
  const out = {
    level: ABNORMAL_LEVEL_UNKNOWN,
    dev10: _devNum(f.dev10),
    dev30: _devNum(f.dev30),
    stage: String(f.stage || '')
  };
  if (!f || f.ok !== true) return out;                  // §10 判不出
  if (st === DEV_RULE_SEVERE) out.level = ABNORMAL_LEVEL_ABNORMAL;
  else if (st === DEV_RULE_NEAR) out.level = ABNORMAL_LEVEL_NEAR;
  else out.level = ABNORMAL_LEVEL_OK;                  // ok / watch 都算「没进规则」
  return out;
}

/** 偏离值文本（`+100.11%` / `—`），⛔ 不补 0 */
export function devPctText(v) {
  const n = _devNum(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function _devNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[%,+\s]/g, ''));
  return isFinite(n) ? n : null;
}

/**
 * 【纯函数 · 第三十四条唯一触发尺子】这只票是否已越【官方严重异常波动】红线。
 *
 * ★★ [DEV-RULE 2026-11-25] 旧 `isOverRange10Cap(pct)`（十日涨幅 > 97%）**已废除（repealed）**。
 *   新判据 = 官方严重异常波动（10日偏离 ≥ +100% / 30日 ≥ +200%；负向 ≤ −50% / ≤ −70%）。
 *
 * ⚠️ 与 `near`（逼近红线）**后果不同**：`near` 只禁这一只（第三十六条），
 *   越线才构成监管异动（第三十四条：全场空仓）。⛔ 别把两者合并成一个布尔 ——
 *   用户 2026-11-25 明确：「不含「偏离放大（留意）」，因为这个不是很严重」，
 *   同理 near 也不该引发全场空仓。
 *
 * @param {object|null} fact `computeDeviation` 的返回
 * @returns {boolean} true = 越线（构成本条异动）
 */
export function isOverOfficialRedLine(fact) {
  return classifyDeviation(fact).level === ABNORMAL_LEVEL_ABNORMAL;
}

/** 【纯函数】是否进了第三十六条的「不买」范围（near + abnormal） */
export function isDeviationNearOrOver(fact) {
  const lv = classifyDeviation(fact).level;
  return lv === ABNORMAL_LEVEL_NEAR || lv === ABNORMAL_LEVEL_ABNORMAL;
}

/**
 * 【纯函数 · 第三十四条 / 三十四·b 的触发源】从一批票的偏离事实里挑「越线最严重」那只。
 *
 * ⛔ 旧 `pickAbnormalSource`（按十日涨幅最高票择一）**已废除**：官方口径下「谁越线」
 *   由偏离值决定，与十日涨幅名次无关（10-30 大业股份十日涨幅只有 82.75%，
 *   偏离值却已 +100.14% —— 旧口径根本发现不了它）。
 *
 * 边界（§10）：候选里一只越线的都没有 ⇒ `{found:false, ...}`，⛔ 不许拿「十日涨幅最高」冒充。
 *
 * @param {{facts?:Map<string,object>, isEligible?:function(string,object):boolean}} o
 * @returns {{found:boolean, name:string, fact:object|null}}
 */
export function pickRedLineSource(o) {
  const x = o || {};
  const hit = pickSevereDeviation(x.facts, { isEligible: x.isEligible });
  if (!hit) return { found: false, name: '', fact: null };
  return { found: true, name: hit.name, fact: hit.fact };
}

/** 「X（题材，10日偏离 +101.20%）」这类点名文案（⛔ 只用于说明，不参与判定，§21 文案在 Logic 层拼好） */
function _pointOf(name, topic, devText) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '，' : '（') + '10日偏离 ' + devText + '）';
}

/**
 * 只带名字 / 题材的点名（数值放到后一句）。
 * ★ 触发源那句要写成「…【昨日】10日偏离 +100.78%」，数值只在后一句出现一次，
 *   ⛔ 这里再带一遍就会变成「10日偏离 +100.78%…10日偏离 …」两句重复。
 */
function _pointOfName(name, topic) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '）' : '');
}

/**
 * 【纯函数】把「事实」判成一块可渲染的异动标语（= cashAlert 的同形状对象）。
 *
 * ★★ [DEV-RULE 2026-11-25 口径整体替换] 入参从【十日涨幅数字】换成【官方偏离值事实】。★★
 *   用户原话：「确实是需要改下统一口径是官方偏离值那里产生异动监管，而不是自定义的。
 *     也是按照原来的规则要记录首次异动，异动次日等规则不变，只是口径要改变。」
 *   ⇒ 三种形态（异动次日 / 当日异动 / 入选票异动）**结构一字不变**，只把尺子换掉：
 *     旧：十日涨幅（9:26 竞价）＞ 97%
 *     新：官方严重异常波动（10日偏离 ≥ +100% / 30日 ≥ +200%；负向 ≤ −50% / ≤ −70%）
 *
 * ⚠️ `near`（逼近红线，红线 ×0.9）**不在这里处理** —— 那是第三十六条（只禁这一只，
 *   不空仓）。用户 2026-11-25 明确「不含「偏离放大（留意）」，因为这个不是很严重」，
 *   同理 near 也不该引发全场空仓。
 *
 * @param {object} [input]
 * @param {string} [input.leaderName]   总龙一（20日涨幅主板第 1 名）的名字
 * @param {string} [input.leaderTopic]  它的题材（只用于点名）
 * @param {boolean} [input.leaderIsTop1] 缺省 true；false ⇒ 文案写「市场偏离值最高票」
 * @param {object|null} [input.leaderDevToday] 它【今日】的偏离事实（当前口径：9:26 竞价）
 * @param {object|null} [input.leaderDevPrev]  它【昨日】的偏离事实（收盘口径 = 官方唯一口径）
 * @param {Array<{name:string, topic?:string, dev?:object|null}>} [input.rows]
 *        今天【会被选中的票】+ 卖点候选的偏离事实。`dev` 是 `computeDeviation` 的返回。
 * @returns {object} 与 TVRB_ABNORMAL_NONE 同形状（show=false ⇒ 一字不动，§11）
 */
export function resolveAbnormalFact(input) {
  const i = input || {};
  const leaderName = String(i.leaderName || '').trim();
  const leaderTopic = String(i.leaderTopic || '').trim();
  const leaderLabel = (i.leaderIsTop1 === false) ? '市场偏离值最高票' : '市场总龙一';
  const today = classifyDeviation(i.leaderDevToday);
  const prev = classifyDeviation(i.leaderDevPrev);
  const rows = Array.isArray(i.rows) ? i.rows : [];

  // ① 点名：越红线的票 = 全场禁买触发源；逼近红线的票另记一份（只做说明，不空仓）
  const hits = [];      // 越线（severe）
  const near = [];      // 逼近（near）—— 只说明，⛔ 不空仓
  const seen = new Set();
  rows.forEach(function (r) {
    if (!r) return;
    const nm = String(r.name || '').trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    const lv = classifyDeviation(r.dev);
    const item = {
      name: nm,
      topic: String(r.topic || '').trim(),
      dev10: lv.dev10,
      dev30: lv.dev30,
      level: lv.level
    };
    if (lv.level === ABNORMAL_LEVEL_ABNORMAL) hits.push(item);
    else if (lv.level === ABNORMAL_LEVEL_NEAR) near.push(item);
  });

  // ② 触发形态（优先级：异动次日 > 当日异动 > 入选票异动）—— 与旧口径逐字一致
  let kind = '';
  if (prev.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_NEXT_DAY;
  else if (today.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_LEADER_NOW;
  else if (hits.length > 0) kind = ABNORMAL_KIND_STOCK;

  // ③ §10：总龙一今日/昨日两份都判不出 ⇒ 如实标记「判不出」（⛔ 不假装没有异动）
  const unknownLeader = !leaderName ||
    (today.level === ABNORMAL_LEVEL_UNKNOWN && prev.level === ABNORMAL_LEVEL_UNKNOWN);

  const base = {
    show: false,
    kind: kind,
    ruleNo: ABNORMAL_RULE_NO,
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderLabel: leaderLabel,
    leaderIsTop1: (i.leaderIsTop1 === false) ? false : true,
    leaderDevPrev: prev.dev10,
    leaderDevPrev30: prev.dev30,
    leaderDevPrevText: devPctText(prev.dev10),
    leaderDevPrev30Text: devPctText(prev.dev30),
    leaderDevPrevLevel: prev.level,
    leaderDevToday: today.dev10,
    leaderDevToday30: today.dev30,
    leaderDevTodayText: devPctText(today.dev10),
    leaderDevToday30Text: devPctText(today.dev30),
    leaderDevTodayLevel: today.level,
    names: hits.map(function (x) { return x.name; }),
    nearNames: near.map(function (x) { return x.name; }),
    unknownLeader: unknownLeader,
    headline: '',
    detail: ''
  };

  if (!kind) {
    // 没有异动也要把「判没判过」带出去：说明区靠 unknownLeader / nearNames 交代缺口与逼近票
    return Object.assign({}, TVRB_ABNORMAL_NONE, {
      leaderName: base.leaderName,
      leaderTopic: base.leaderTopic,
      leaderLabel: base.leaderLabel,
      leaderIsTop1: base.leaderIsTop1,
      leaderDevPrev: base.leaderDevPrev,
      leaderDevPrev30: base.leaderDevPrev30,
      leaderDevPrevText: base.leaderDevPrevText,
      leaderDevPrev30Text: base.leaderDevPrev30Text,
      leaderDevPrevLevel: base.leaderDevPrevLevel,
      leaderDevToday: base.leaderDevToday,
      leaderDevToday30: base.leaderDevToday30,
      leaderDevTodayText: base.leaderDevTodayText,
      leaderDevToday30Text: base.leaderDevToday30Text,
      leaderDevTodayLevel: base.leaderDevTodayLevel,
      nearNames: base.nearNames,
      unknownLeader: base.unknownLeader
    });
  }

  // ④ 文案（§21：大字标语 + 说明全部在 Logic 层拼好，模板零计算）
  const capLine = '★ 判定口径（第' + ABNORMAL_RULE_NO + '条，2026-11-25 换官方口径）：' +
    '交易所「严重异常波动」= 连续 10 日【收盘价格涨跌幅偏离值】累计 ≥ +100% 或连续 30 日 ≥ +200%' +
    '（负向 ≤ −50% / ≤ −70%）⇒ 【全场监管异动】：整个市场整片灰、【空仓、一张票都不买】。' +
    '⛔ 旧的自定义口径「十日涨幅 ＞ ' + TVRB_RANGE10_CAP + '%」已废除（用户：那个有些不准）。' +
    '票照常列出供你核对，⛔ 不删。';
  const whyLine = '★ 为什么：用户「总龙一影响范围很大的，这个波及到所有的票」——' +
    '一旦总龙一（或任何一只会被选中的票）触及交易所严重异常波动，它所在题材次日大概率崩，' +
    '甚至带崩整个市场情绪 ⇒ 不是「换一只次强的买」，而是【整个市场今天都不买】。' +
    '偏离值 = 个股累计涨幅 − 对应指数累计涨幅（复利区间差），所以同样的涨幅，指数涨得多就不算异动。';

  const _trig = function (lv) {
    return '10日偏离 ' + devPctText(lv.dev10) + ' / 30日偏离 ' + devPctText(lv.dev30) +
      ' ⇒ 越「严重异常波动」红线（+100% / +200%）';
  };
  let lead = '';
  if (kind === ABNORMAL_KIND_NEXT_DAY) {
    lead = leaderLabel + _pointOfName(leaderName, leaderTopic) +
      '【昨日（上一交易日，收盘口径）】' + _trig(prev) +
      ' ⇒ 今天是【异动次日】：按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' +
      ABNORMAL_NO_BUY_TAG + '）。';
  } else if (kind === ABNORMAL_KIND_LEADER_NOW) {
    lead = leaderLabel + _pointOfName(leaderName, leaderTopic) +
      '【今日】（9:25 竞价口径）' + _trig(today) +
      ' ⇒ 按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  } else {
    lead = '入选票 ' + hits.map(function (x) {
      return _pointOf(x.name, x.topic, devPctText(x.dev10));
    }).join('、') + ' 已越「严重异常波动」红线（10日偏离 ≥ +100%）⇒ 按第' +
      ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  }

  const tail = [];
  if (leaderName) {
    // ★ [ABN-SAME-SOURCE] 这里两组数字**必须同属这一只票**（同名、各自口径），
    //   用户就是靠这一行自核的：11-13 曾把闽发铝业（84.88%）和东方海洋的 100.78% 拼在一起。
    tail.push('（自核用）' + leaderLabel + ' ' + leaderName + '：今日（9:25 竞价口径）10日偏离 ' +
      base.leaderDevTodayText + ' / 30日 ' + base.leaderDevToday30Text +
      (prev.level === ABNORMAL_LEVEL_UNKNOWN
        ? '；昨日那份判不出（逐日腿或指数腿缺）⇒「异动次日」这一条判不出'
        : '；昨日（收盘口径）10日偏离 ' + base.leaderDevPrevText + ' / 30日 ' + base.leaderDevPrev30Text) +
      '（以上两组数字取自【同一只票】的同一套官方口径，可逐个核对）。');
  } else {
    tail.push('⚠️ 总龙一（20日涨幅主板第 1 名）还没读到 ⇒ 只判了入选票自身，' +
      '「异动次日」这一条【判不出】（§10：判不出 ≠ 没有异动）。');
  }
  if (near.length > 0) {
    tail.push('⚠️ 另有 ' + near.map(function (x) {
      return _pointOf(x.name, x.topic, devPctText(x.dev10));
    }).join('、') + ' 只是【逼近红线】（红线 ×0.9），未越线 ⇒ ⛔ 不触发空仓，' +
      '按第三十六条只剔掉这一只的买点。');
  }
  tail.push('⚠️ 下方股票仍按原规则【照常列出】（不删不改），但买点标签一律为【' +
    ABNORMAL_NO_BUY_TAG + '】，不计入「选出 N 只」。');

  return Object.assign(base, {
    show: true,
    headline: '🚨 监管异动 · 今日空仓（不买任何票）',
    detail: lead + whyLine + capLine + tail.join('')
  });
}
