// abnormal-10d.js — 「监管异动 · 十日涨幅硬上限」的【唯一判定实现】（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-11-13 原话，逐字）★★ 见 tvrb-constants.js 的第三十四条常量块
// ══════════════════════════════════════════════════════════════════════════════════════
//   核心三句（① 的阈值已被 2026-11-13 晚间用户修订，见下）：
//     ① 「新增总约束，十日涨幅竞价口径不能超过 95%」—— 95 是【自定义选股上限】；
//     ② 「十日达到 100% 异动，提示空仓，选出的票整块变灰色（不用去掉）」；
//     ③ 「总龙一异动次日……也要空仓，不再选票……不在买进任何股票」。
//
// ★★ [CAP-97 2026-11-13 晚间用户修订] ① 的自定义上限 95 → **97**：
//     用户原话：「不是这样的，超过95%该题材或者股票就比较危险，你把它调到97%吧，
//     这样就比较合理些，11月11日这样能正常运行，超过97%该题材或者股票就不能选，监管异动了」。
//     ⇒ 11-11 东方海洋真实竞价口径 95.711445% 必须落在【正常】区间（⛔ 不再顺延 / 不再下线候补）。
//
// ★★★ [FULL-MARKET 2026-11-13 用户当场纠正，最高口径] ★★★
//     用户原话：「是整个题材的，你没听懂吗？也就是全场整片灰，整个市场也是灰色，没有票可以买，
//     我都说了总龙一影响范围很大的。这个波及到所有的票。」
//     ⇒ **> 97% 就是【全场级监管异动】**：不是「跳过那只、顺延下一只」，不是「该题材不选」，
//       而是【整个市场】整片灰 + 空仓 + 一张票都不买。触发源可以是总龙一 / 昨日总龙一 /
//       任何一只会被选中的票，但【后果一律波及所有票】（总龙一影响范围很大）。
//     ⇒ 实现：isOverRange10Cap（near || abnormal）就是【全场禁买判据】；
//       resolveAbnormalFact 用它判三种 kind，显示层叠加据此整片灰，规则层收口据此清空 buyNames。
//     ⚠️ 100% 仍保留为文案里的「交易所严重异常波动」分级，只说明【严重程度】，
//        ⛔ 不再作为「要不要全场空仓」的分界线。
//
// 职责边界（§3 / §4 / §21）：
//   · 本模块【只做两件事】：把涨幅分级（ok / near / abnormal）+ 把事实拼成一块可渲染的标语；
//   · ⛔ 不取数、不落库、不发请求：昨日十日涨幅 / 今日十日涨幅 / 总龙一身份全部由
//     组合式（useTopicVolRatioBoard）与采集层注入 —— 与本模块无关；
//   · ⛔ 不判「要不要顺延下一龙位」：[FULL-MARKET] 口径下**根本没有顺延**；
//     _buildBlock 只负责「踩线票保留展示 + 本块停止选股」，全场整片灰由收口与显示层叠加；
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

/** 分级：未知（读不到） / 正常 / 已触发全场监管异动（>97 且 <100） / 程度更重的异动（≥100）
 *  ⚠️ [FULL-MARKET] near 与 abnormal 只是【文案程度分级】，**后果完全相同**（全场空仓）。 */
export const ABNORMAL_LEVEL_UNKNOWN = 'unknown';
export const ABNORMAL_LEVEL_OK = 'ok';
export const ABNORMAL_LEVEL_NEAR = 'near';
export const ABNORMAL_LEVEL_ABNORMAL = 'abnormal';

/**
 * 【纯函数】十日涨幅（竞价口径，单位 = %）→ 分级。
 *
 * 边界口径（[CAP-97] + [FULL-MARKET] ⛔ 别改，改了与规则手册条文不一致）：
 *   · pct ≥ 100              ⇒ 'abnormal'（程度更重；后果与 near **完全相同**）
 *   · pct >  TVRB_RANGE10_CAP ⇒ 'near'（已触发【全场级监管异动】：整片灰 + 全市场空仓）
 *   · pct ≤  TVRB_RANGE10_CAP ⇒ 'ok'（含 11-11 真实的 95.711445% ⇒ 正常运行）
 *   · 读不到                  ⇒ 'unknown'（§10 不补 0）
 *   ⚠️ near / abnormal 的区别【只在文案】，`isOverRange10Cap` 对两者都返回 true。
 *      ⛔ 不许再把它读成「票级禁选预警」或「顺延下一只」。
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
 * 【纯函数 · §15 唯一「全场禁买」判据】某只票的十日涨幅是否触发【全场级监管异动】。
 *
 * ★ [FULL-MARKET 2026-11-13] 这是第三十四条**唯一的触发尺子**：near（>97 且 <100）
 *   与 abnormal（≥100）后果**完全相同** —— 全场整片灰、空仓、一张票都不买。
 *   ⛔ 不再有「near 只跳过这一只、顺延下一只」这种票级处理（用户当场否掉）。
 *
 * 调用方：
 *   · resolveAbnormalFact —— 判三种 kind（异动次日 / 当日异动 / 票级异动）；
 *   · tvrb-blocks#_buildBlock —— 踩线票所在块【只展示这一只、停止选股】；
 *   · pct ≤ CAP（含 11-11 的 95.711445%）⇒ false，按原规则正常选股。
 *
 * @param {number|string|null} pct
 * @returns {boolean} true = 触发全场禁买
 */
export function isOverRange10Cap(pct) {
  const lv = classifyRange10(pct).level;
  return lv === ABNORMAL_LEVEL_NEAR || lv === ABNORMAL_LEVEL_ABNORMAL;
}

/**
 * 【纯函数 · §15】第三十四条【触发源】的择一：把几份候选拼成「一只票的完整事实」。
 *
 * ★★ [ABN-SAME-SOURCE 2026-11-13 用户报错后修] 为什么必须有这一步：
 *   用户原话「11月13日提示那个就有错误，上面说市场总龙一闵发铝业十日涨幅100.78%，
 *   根本不是……相差太大了」。库内真实数据：11-13 今日竞价最高 = 闽发铝业 84.88%，
 *   11-12 昨日竞价最高 = 东方海洋 100.78% ⇒ 旧实现把「今日的名」和「昨日的数」拼一起，
 *   差 13~16 个点，还把二十日涨幅只排到 48.56% 的票叫成「市场总龙一」。
 *
 * 判据（⛔ 不许改，改了就是重演事故）：
 *   ① 候选 = { name, topic, pct, basis, isTop1 } **四件套整体存在**，禁止拆开取用；
 *   ② 昨日【竞价口径】优先于【收盘口径】—— 11-11 东方海洋收盘 100.43 / 竞价 95.71，
 *      取收盘会把它误判成异动（用户明确要竞价口径）；
 *   ③ 同一口径内取 pct 最高那只（全市场硬约束「所有大a主板10日涨幅」不能只盯总龙一）；
 *   ④ 触发优先级：昨日（异动次日）> 今日（当日异动），与 resolveAbnormalFact 的 kind 一致；
 *   ⑤ 没触发 ⇒ `triggered:false`，`name` 回落总龙一（保持旧行为，§11）。
 *
 * @param {object} [input]
 * @param {string} [input.leaderName]   20日涨幅主板第 1 名
 * @param {string} [input.leaderTopic]
 * @param {number|string|null} [input.leaderToday]      总龙一今日十日涨幅（竞价口径）
 * @param {number|string|null} [input.leaderPrevAuc]    总龙一昨日十日涨幅（竞价口径）
 * @param {number|string|null} [input.leaderPrevClose]  总龙一昨日十日涨幅（收盘口径，退路）
 * @param {{name:string,pct:number}|null} [input.marketToday]     全市场今日竞价最高票
 * @param {{name:string,pct:number}|null} [input.marketPrevAuc]   全市场昨日竞价最高票
 * @param {{name:string,pct:number}|null} [input.marketPrevClose] 全市场昨日收盘最高票
 * @returns {{triggered:boolean, name:string, topic:string, isTop1:boolean,
 *            basis:string, prevHit:object|null, todayHit:object|null}}
 *          注意：返回值只交代【是哪只票、哪一份口径触发的】，两个具体数值由调用方
 *          **按这个名字重新取**（⛔ 不许在这里顺手塞别的票的数字）。
 */
export function pickAbnormalSource(input) {
  const i = input || {};
  const leaderName = String(i.leaderName || '').trim();
  const leaderTopic = String(i.leaderTopic || '').trim();

  const _cand = function(name, topic, pct, basis, isTop1) {
    const nm = String(name || '').trim();
    const v = _num(pct);
    if (!nm || v === null) return null;
    return { name: nm, topic: String(topic || '').trim(), pct: v, basis: basis || '', isTop1: !!isTop1 };
  };
  const _bestOf = function(cands) {
    let best = null;
    (cands || []).forEach(function(c) { if (c && (!best || c.pct > best.pct)) best = c; });
    return best;
  };
  const _mktName = function(m) { return (m && m.name) ? m.name : ''; };
  const _mktPct = function(m) { return (m && m.pct !== undefined) ? m.pct : null; };

  const prevAucHit = _bestOf([
    _cand(leaderName, leaderTopic, i.leaderPrevAuc, 'auction', true),
    _cand(_mktName(i.marketPrevAuc), '', _mktPct(i.marketPrevAuc), 'auction', false)
  ]);
  const prevCloseHit = _bestOf([
    _cand(leaderName, leaderTopic, i.leaderPrevClose, 'close', true),
    _cand(_mktName(i.marketPrevClose), '', _mktPct(i.marketPrevClose), 'close', false)
  ]);
  const todayHit = _bestOf([
    _cand(leaderName, leaderTopic, i.leaderToday, 'auction', true),
    _cand(_mktName(i.marketToday), '', _mktPct(i.marketToday), 'auction', false)
  ]);
  const prevHit = prevAucHit || prevCloseHit;

  let hit = null;
  if (prevHit && isOverRange10Cap(prevHit.pct)) hit = prevHit;
  else if (todayHit && isOverRange10Cap(todayHit.pct)) hit = todayHit;

  if (!hit) {
    return {
      triggered: false,
      name: leaderName,
      topic: leaderTopic,
      isTop1: true,
      basis: '',
      prevHit: prevHit,
      todayHit: todayHit
    };
  }
  return {
    triggered: true,
    name: hit.name,
    topic: hit.topic,
    isTop1: hit.isTop1,
    basis: hit.basis,
    prevHit: prevHit,
    todayHit: todayHit
  };
}

/** 「X（题材 +101.20%）」这类点名文案（⛔ 只用于说明，不参与判定，§21 文案在 Logic 层拼好） */
function _pointOf(name, topic, pctText) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '，' : '（') + '十日涨幅 ' + pctText + '）';
}

/**
 * 只带名字 / 题材的点名（涨幅放到后一句）。
 * ★ [ABN-SAME-SOURCE] 触发源那句要写成「…【昨日】十日涨幅 100.78% ＞ 97%」，
 *   如果这里也带一遍涨幅，就会变成「十日涨幅 100.78%…十日涨幅 ＞ 97%」两句重复。
 */
function _pointOfName(name, topic) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '）' : '');
}

/**
 * 【纯函数】把注入的「事实」判成一块可渲染的异动标语（= cashAlert 的同形状对象）。
 *
 * @param {object} [input]
 * ★★ [ABN-SAME-SOURCE 2026-11-13 用户报错后修] 本函数吃的是【一只票的完整事实】：
 *   `leaderName` 与 `leaderPctToday` / `leaderPctPrev` **必须同属那一只票**。
 *   用户原话：「11月13日提示那个就有错误，上面说市场总龙一闵发铝业十日涨幅100.78%，
 *   根本不是，不知道这些数据从哪里来，相差太大了」——实测 11-13 闽发铝业竞价口径只有
 *   84.88%（11-12 是 87.04%），100.78% 是【东方海洋】11-12 的十日涨幅 ⇒ 典型的
 *   「名字取今日最高票、数值取昨日最高票」张冠李戴。⛔ 调用方不许把两份不同来源的
 *   名字 / 数值拼进来；拼对了才准传（取数侧见 tvrb-plan#_abnBestOf）。
 *
 * @param {string} [input.leaderName]      触发源那【一只】票的名字
 *        （正常 = 20日涨幅主板第 1 名；若被全市场最高票接管 ⇒ 是那只票，见 leaderIsTop1）
 * @param {string} [input.leaderTopic]     它的题材（只用于点名，⛔ 不参与判定）
 * @param {boolean} [input.leaderIsTop1]   它到底是不是「20日涨幅主板第 1 名」。
 *        true / 缺省 ⇒ 文案写「市场总龙一」（保持旧行为，旧测试不受影响）；
 *        false ⇒ 写「市场十日涨幅最高票」，⛔ 不许把普通票叫成总龙一。
 * @param {number|string|null} [input.leaderPctToday] 它【今日】的十日涨幅（9:26 竞价口径，pctMap）
 * @param {number|string|null} [input.leaderPctPrev]  它【昨日】的十日涨幅（组合式 prevRange10）
 * @param {'auction'|'close'|''} [input.leaderPctPrevBasis] 昨日那份用的是【竞价口径】还是【收盘口径】
 *        —— ★ 用户要的是竞价口径（原话「东方海洋，昨天竞价口径就超过 100% 了」）；
 *        竞价那份没读到时退回收盘口径，必须在文案里说清（§10：口径不许含糊）。
 * @param {Array<{name:string, topic?:string, pct:number|string|null}>} [input.rows]
 *        今天【会被选中的票】—— 常规题材块 picks + 十日涨幅候补（口径都是十日涨幅）
 *        ⚠️ ⛔ 别把「20日涨幅」通道的票（退潮替补 / 新龙 / 抱团 / 补涨）塞进来：
 *           那些行的 pct 是 20日涨幅，拿它比 TVRB_RANGE10_CAP / 100 是【口径串用】，比不判更坏。
 * @returns {object} 与 TVRB_ABNORMAL_NONE 同形状（show=false ⇒ 一字不动，§11）
 */
export function resolveAbnormalFact(input) {
  const i = input || {};
  const leaderName = String(i.leaderName || '').trim();
  const leaderTopic = String(i.leaderTopic || '').trim();
  // ★ [ABN-SAME-SOURCE] 称谓必须与事实一致：不是二十日涨幅总龙一就不许这么叫。
  const leaderLabel = (i.leaderIsTop1 === false) ? '市场十日涨幅最高票' : '市场总龙一';
  const today = classifyRange10(i.leaderPctToday);
  const prev = classifyRange10(i.leaderPctPrev);
  const rows = Array.isArray(i.rows) ? i.rows : [];

  // ① 点名：★ [FULL-MARKET] > 自定义禁选上限的票【一律是全场禁买触发源】。
  //    near 与 abnormal 都进 hits（后果完全相同）；near / severe 另留一份供说明区点名分级。
  const hits = [];
  const near = [];
  const severe = [];
  const seen = new Set();
  rows.forEach(function(r) {
    if (!r) return;
    const nm = String(r.name || '').trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    const lv = classifyRange10(r.pct);
    const item = { name: nm, topic: String(r.topic || '').trim(), pct: lv.pct, pctText: lv.pctText };
    if (lv.level === ABNORMAL_LEVEL_ABNORMAL) { hits.push(item); severe.push(item); }
    else if (lv.level === ABNORMAL_LEVEL_NEAR) { hits.push(item); near.push(item); }
  });

  // ② 触发形态（优先级：异动次日 > 当日异动 > 入选票异动）
  // ★ [FULL-MARKET] 判据统一走 isOverRange10Cap（near || abnormal）——
  //   ⛔ 不再只认 abnormal：97~100 一样要【全场整片灰 + 空仓】，绝不顺延下一只。
  let kind = '';
  if (isOverRange10Cap(i.leaderPctPrev)) kind = ABNORMAL_KIND_NEXT_DAY;
  else if (isOverRange10Cap(i.leaderPctToday)) kind = ABNORMAL_KIND_LEADER_NOW;
  else if (hits.length > 0) kind = ABNORMAL_KIND_STOCK;

  // ③ §10：总龙一的十日涨幅两份都读不到 ⇒ 如实标记「判不出」（⛔ 不假装没有异动）
  const unknownLeader = !leaderName || (today.level === ABNORMAL_LEVEL_UNKNOWN && prev.level === ABNORMAL_LEVEL_UNKNOWN);

  const base = {
    show: false,
    kind: kind,
    ruleNo: ABNORMAL_RULE_NO,
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderLabel: leaderLabel,
    leaderIsTop1: (i.leaderIsTop1 === false) ? false : true,
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
    leaderLabel: base.leaderLabel,
    leaderIsTop1: base.leaderIsTop1,
    leaderPctPrev: base.leaderPctPrev,
    leaderPctPrevText: base.leaderPctPrevText,
    leaderPctToday: base.leaderPctToday,
    leaderPctTodayText: base.leaderPctTodayText,
    nearNames: base.nearNames,
    unknownLeader: base.unknownLeader
  });

  // ④ 文案（§21：★ 大字标语 + 说明全部在 Logic 层拼好，模板零计算）
  const capLine = '★ 硬上限口径（第' + ABNORMAL_RULE_NO + '条）：十日涨幅（竞价口径）' +
    '＞ ' + TVRB_RANGE10_CAP + '% ⇒ 【全场监管异动】：整个市场整片灰、【空仓、一张票都不买】；' +
    '达到 ' + TVRB_RANGE10_ABNORMAL + '% 是交易所「严重异常波动」（程度更重，后果相同）。' +
    '票照常列出供你核对，⛔ 不删。';
  const whyLine = '★ 为什么：用户「总龙一影响范围很大的，这个波及到所有的票」——' +
    '一旦总龙一（或任何一只会被选中的票）十日涨幅异动，它所在题材次日大概率崩，' +
    '甚至带崩整个市场情绪 ⇒ 不是「换一只次强的买」，而是【整个市场今天都不买】。' +
    '自定义禁选上限设在交易所红线前 ' + (TVRB_RANGE10_ABNORMAL - TVRB_RANGE10_CAP) +
    ' 个点，就是防「99% 就开始有题材崩盘节奏」。★ [CAP-97 2026-11-13 晚间用户修订] ' +
    '由 95% 上调到 ' + TVRB_RANGE10_CAP + '%：11-11 东方海洋真实的 95.71% 正常运行。';

  const _trig = function(lv) {
    return '＞ ' + TVRB_RANGE10_CAP + '%（全场监管异动）' +
      (lv.level === ABNORMAL_LEVEL_ABNORMAL
        ? '，且已达 ' + TVRB_RANGE10_ABNORMAL + '% 交易所「严重异常波动」'
        : '');
  };
  const prevBasisText = (i.leaderPctPrevBasis === 'auction')
    ? '（昨日竞价口径）'
    : (i.leaderPctPrevBasis === 'close' ? '（昨日收盘口径 —— 昨日竞价那份没读到）' : '');
  let lead = '';
  if (kind === ABNORMAL_KIND_NEXT_DAY) {
    lead = leaderLabel + _pointOfName(leaderName, leaderTopic) +
      '【昨日（上一交易日）】十日涨幅 ' + prev.pctText + ' ' + _trig(prev) +
      ' ⇒ 今天是【异动次日】：' +
      '按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  } else if (kind === ABNORMAL_KIND_LEADER_NOW) {
    lead = leaderLabel + _pointOfName(leaderName, leaderTopic) +
      '【今日】（9:26 竞价口径）十日涨幅 ' + today.pctText + ' ' + _trig(today) +
      ' ⇒ 按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  } else {
    lead = '入选票 ' + hits.map(function(x) {
      return _pointOf(x.name, x.topic, x.pctText);
    }).join('、') + ' 十日涨幅 ＞ ' + TVRB_RANGE10_CAP + '%（全场监管异动）⇒ 按第' +
      ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
  }

  const tail = [];
  if (leaderName) {
    // ★ [ABN-SAME-SOURCE] 这里两个数字**必须同属这一只票**（同名、同日口径），
    //   用户就是靠这一行自核的：11-13 曾把闽发铝业（84.88%）和东方海洋的 100.78% 拼在一起。
    tail.push('（自核用）' + leaderLabel + ' ' + leaderName + '：今日十日涨幅 ' + today.pctText +
      (prev.level === ABNORMAL_LEVEL_UNKNOWN
        ? '，昨日那份未读到（判不出异动次日）'
        : '，昨日 ' + prev.pctText + prevBasisText) +
      '（以上两个数字取自【同一只票】的同一套口径，可逐个核对）。');
  } else {
    tail.push('⚠️ 总龙一（20日涨幅主板第 1 名）还没读到 ⇒ 只判了入选票自身，' +
      '「异动次日」这一条【判不出】（§10：判不出 ≠ 没有异动）。');
  }
  if (near.length > 0) {
    tail.push('⚠️ 其中 ' + near.map(function(x) {
      return _pointOf(x.name, x.topic, x.pctText);
    }).join('、') + ' 落在 ' + TVRB_RANGE10_CAP + '%~' + TVRB_RANGE10_ABNORMAL +
      '%（已超自定义禁选上限、未到交易所红线）—— ★ 按【全场监管异动】口径一样是' +
      '【整片灰 + 全市场空仓】，⛔ 不顺延任何票、不换次强的买。');
  }
  if (severe.length > 0) {
    tail.push('⚠️ 达到 ' + TVRB_RANGE10_ABNORMAL + '% 交易所「严重异常波动」的票：' +
      severe.map(function(x) { return _pointOf(x.name, x.topic, x.pctText); }).join('、') + '。');
  }
  tail.push('⚠️ 下方股票仍按原规则【照常列出】（不删不改），但买点标签一律为【' + ABNORMAL_NO_BUY_TAG +
    '】，不计入「选出 N 只」。');

  return Object.assign(base, {
    show: true,
    headline: '🚨 监管异动 · 今日空仓（不买任何票）',
    detail: lead + whyLine + capLine + tail.join('')
  });
}
