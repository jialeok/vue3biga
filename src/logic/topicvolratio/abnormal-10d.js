// abnormal-10d.js — 「监管异动」的【唯一判定实现】（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★★ [DEV-RULE 2026-11-25 口径整体替换] 本文件已从「十日涨幅硬上限」换成
//      **交易所官方「收盘价格涨跌幅偏离值累计值」**。
//      ★ [2026-11-26] 旧口径的常量（95 / 97 / 100）与文案提及**已从上到下彻底删除** ——
//        仓库里不再有「自定义涨幅上限」这个东西，⛔ 也别加回来。
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户原话（2026-11-25，逐字）：
//     「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准，之前你们也提醒要更换口径，
//       换成官方偏离值，当时我说观察一段时间，现在观察后，确实是需要改下统一口径是官方偏离值
//       那里产生异动监管，而不是自定义的。也是按照原来的规则要记录首次异动，异动次日等规则不变，
//       只是口径要改变。」
//
//   ⇒ 形态与后果**一律不变**，只换尺子 + 收紧【判定对象】：
//     · 判定对象 = **市龙一**（= 30 日涨幅排名第一的【主板】票，用户 11-18 自造的概念，
//       与「总龙一 = 20 日涨幅第一」是两套独立名次，⛔ 别混）。
//     · 形态：① 异动次日（市龙一昨日越线）② 当日异动（市龙一今日越线）。**没有第三种**。
//     · 后果：**全场级** —— 整个市场整片灰 + 空仓 + 一张票都不买（[FULL-MARKET] 口径沿用）。
//     · 新尺子：10 日偏离 ≥ +100% 或 30 日偏离 ≥ +200%（负向 ≤ −50% / ≤ −70%）
//       —— 阈值唯一来源 `abnormal-deviation.js#DEV_THRESHOLDS`，⛔ 不许在这里再写数字。
//
//   ★★ [MARKET-DRAGON-ONLY 2026-11-25 用户当场纠正，本文件最重要的一条口径] ★★
//     用户原话（逐字）：
//       「11月24日，北纬科技，竞价口径，它不是30日涨幅市龙一（涨幅最高的），不能按照市龙一的
//         标准去做判断，这只能是它个股行为，甚至也不能影响到题材。市龙一冰山冷热没触发监管异动，
//         就不要出现监管异动 · 今日空仓（不买任何票）……这个红色大提示。
//         ……如果它触发异动（非逼近红线），才会有原来那个红色提示空仓大板……
//         不是每只股票一异动，都要提示这个的，因为很多股票都不是市龙一。这个你没理解，
//         他们只是属于个股异动，和题材无关。」
//     ⇒ ⛔ **删掉「入选票异动 ⇒ 全场空仓」这一形态**（旧 `kind='stock'`）：
//       个股越线只是【个股行为】，后果由第三十六条处理（只灰这一只、不空仓、不影响题材）。
//     ⇒ 只有【市龙一】越线才产生「监管异动 · 今日空仓」红色大板。
//     ⇒ 这也是 11-24 那次误报的根因：北纬科技（+100.11%）越线但不是市龙一（市龙一 = 冰山冷热），
//       却被当成「入选票异动」⇒ 全屏空仓 + 华东重机/盛剑科技 被无故灰掉。
//
//   ★ 为什么必须换尺子（11-25 真库 36 个交易日逐日复算的实测位移）：
//     **只有 3 天重合**（10-08 / 10-09 / 10-12）。
//     旧口径独有：10-13、10-14、11-12；官方独有：10-30（大业股份 +100.14%）、
//     **11-11（东方海洋 +100.01%）**、11-24（北纬科技 +100.11%）。
//     ⚠️ 这张表只是「为什么必须换尺子」的诊断证据，⛔ 不是规则，也不用来判断任何一天。
//     ⚠️ 上表是【全市场偏离值最高票】口径的对照结果，**不等于市龙一口径的异动日**：
//       市龙一口径下还要再过一个闸 —— 那只票当天是不是 30 日涨幅第 1 的主板票。
//       实测 11-24 的市龙一是**冰山冷热**（30日 134.21，凡拓数创 150.83 是创业板被排除），
//       北纬科技不是市龙一 ⇒ 11-24 **不算**异动日（当天按正常规则选票）。
//       ⇒ 所以「哪天真的空仓」必须按市龙一重新过一遍，⛔ 不要拿上面那张表当结论。
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
//   · 市龙一身份读不到（30 日涨幅榜没就绪）⇒ fact.unknownLeader = true，文案如实写「判不出」，
//     ⛔ 绝不退回「随便挑一只偏离值最高的票」冒充市龙一（11-24 那次误报就是这么来的）；
//   · 昨日那份没读到 ⇒ 只判「当日异动」，不判「异动次日」，文案注明缺口（⛔ 不能沉默）。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG,
  ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW, TVRB_ABNORMAL_NONE
} from './tvrb-constants.js';
// ★ [DEV-RULE 2026-11-25] 官方偏离值口径：档位判据统一走 deviation-rule-facts（§6 一份实现）
//   ★ [MARKET-DRAGON-ONLY 2026-11-25] `pickSevereDeviation`（「越线最严重那只」= 择一触发源）
//     已不再需要：判定对象唯一是市龙一，⛔ 没有「从一批票里挑一个」的场景。
import { deviationRuleStage, DEV_RULE_SEVERE, DEV_RULE_NEAR } from '../auction/deviation-rule-facts.js';

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
 * ★★ [MARKET-DRAGON-ONLY 2026-11-25] `pickRedLineSource`【已废除（repealed）】。
 *
 *   它做的是「从一批票的偏离事实里挑越线最严重的那一只」充当触发源 —— 这个抽象本身就是
 *   上一版口径误解的产物（把「二十日总龙一 / 偏离值最高的票」当触发源）。用户当场纠正：
 *   「不是每只股票一异动，都要提示这个的，因为很多股票都不是市龙一。这个你没理解，
 *     他们只是属于个股异动，和题材无关。」
 *   ⇒ 触发源是**唯一确定的**（市龙一，由组合式 `ebbCtx.mktDragon1` 注入），不存在「挑一只」；
 *     个股越线由第三十六条 `_applyDeviationNearRule` 逐只处理。函数已删除，⛔ 不许再加回来。
 */

function _pointOfName(name, topic) {
  const t = String(topic || '').trim();
  return '【' + String(name || '—') + '】' + (t ? '（' + t + '）' : '');
}

/**
 * 【纯函数】把「市龙一的偏离事实」判成一块可渲染的异动标语（= cashAlert 的同形状对象）。
 *
 * ★★ [MARKET-DRAGON-ONLY 2026-11-25 用户当场纠正] ★★
 *   判定对象**只有市龙一**（30 日涨幅第 1 的主板票）。用户原话：
 *   「不是每只股票一异动，都要提示这个的，因为很多股票都不是市龙一。这个你没理解，
 *     他们只是属于个股异动，和题材无关。」
 *   ⇒ ⛔ 本函数没有 `rows` 入参了（旧「入选票异动 ⇒ 全场空仓」的形态**已删除**）。
 *     个股越线 ⇒ 第三十六条只灰那一只，⛔ 不空仓、⛔ 不影响题材。
 *
 * ★★ [DEV-RULE 2026-11-25 口径整体替换] 尺子从【十日涨幅数字】换成【官方偏离值事实】：
 *     旧：十日涨幅（9:25 竞价）＞ 97%
 *     新：官方严重异常波动（10日偏离 ≥ +100% / 30日 ≥ +200%；负向 ≤ −50% / ≤ −70%）
 *
 * ⚠️ `near`（逼近红线，红线 ×0.9）**不在这里处理** —— 那是第三十六条（只禁这一只，不空仓）。
 *   用户明确「不含「偏离放大（留意）」，因为这个不是很严重」。
 *
 * @param {object} [input]
 * @param {string} [input.leaderName]   市龙一的名字（30 日涨幅第 1 · 只主板）
 * @param {string} [input.leaderTopic]  它的题材（只用于点名；拿不到就空着，⛔ 不猜）
 * @param {object|null} [input.leaderDevToday] 它【今日】的偏离事实（当前口径：9:25 竞价）
 * @param {object|null} [input.leaderDevPrev]  它【昨日】的偏离事实（收盘口径 = 官方唯一口径）
 * @returns {object} 与 TVRB_ABNORMAL_NONE 同形状（show=false ⇒ 一字不动，§11）
 */
export function resolveAbnormalFact(input) {
  const i = input || {};
  const leaderName = String(i.leaderName || '').trim();
  const leaderTopic = String(i.leaderTopic || '').trim();
  // 判定对象固定是市龙一 —— ⛔ 不再有「市场偏离值最高票 / 市场总龙一」两种称谓分支
  const leaderLabel = '市龙一（30日涨幅第1·主板）';
  const today = classifyDeviation(i.leaderDevToday);
  const prev = classifyDeviation(i.leaderDevPrev);
  // ① [MARKET-DRAGON-ONLY] 判定对象只有一个：市龙一。⛔ 不再遍历「会被选中的票」——
  //   个股越线（哪怕 +150%）也只是个股行为，由第三十六条灰那一只，⛔ 不空仓、⛔ 不影响题材。
  //   （`hits` / `near` 两份收集已随该口径删除，⛔ 不要因为「字段还有人读」再把它们加回来。）

  // ② 触发形态只有两种（优先级：异动次日 > 当日异动）
  let kind = '';
  if (prev.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_NEXT_DAY;
  else if (today.level === ABNORMAL_LEVEL_ABNORMAL) kind = ABNORMAL_KIND_LEADER_NOW;

  // ★★ [MARKET-DRAGON-ONLY 2026-11-25 · §10 硬闸] 市龙一名字读不到 ⇒ 本条【一律判不出】。
  //   为什么必须显式清空 kind，而不是只在文案里写「判不出」：
  //     · 本函数的事实是按【名字】取的；名字空着还能 has 到某个事实，只可能是调用方传错
  //       （例如把全市场 Map 当成「市龙一的事实」塞进 leaderDevToday）。那种情况下判成空仓
  //       = 拿一只不知名的票让全市场停手，正是 11-24 那次误报的同款后果。
  //     · 用户口径：「不是每只股票一异动，都要提示这个的」。宁可写「判不出」，⛔ 绝不猜。
  if (!leaderName) kind = '';

  // ③ §10：市龙一今日/昨日两份都判不出 ⇒ 如实标记「判不出」（⛔ 不假装没有异动）
  const unknownLeader = !leaderName ||
    (today.level === ABNORMAL_LEVEL_UNKNOWN && prev.level === ABNORMAL_LEVEL_UNKNOWN);

  const base = {
    show: false,
    kind: kind,
    ruleNo: ABNORMAL_RULE_NO,
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderLabel: leaderLabel,
    // ★ [MARKET-DRAGON-ONLY 2026-11-25] `leaderIsTop1` 已删除：称谓只有一种（市龙一），
    //   「是不是二十日总龙一」这个问题本身不存在了 ⇒ 再留一个恒 true 的布尔只会误导后来人。
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
    // 保留 `names`（恒空数组）：`tvrb-blocks.js` 的说明文案里还有一处 `abnormal.names` 读取，
    // 留个空数组只为不改那处容错分支。★ 它**不再是**触发源，⛔ 别靠它传递「谁越线了」。
    names: [],
    unknownLeader: unknownLeader,
    headline: '',
    detail: ''
  };

  if (!kind) {
    // 没有异动也要把「判没判过」带出去：说明区靠 unknownLeader 交代缺口
    return Object.assign({}, TVRB_ABNORMAL_NONE, {
      leaderName: base.leaderName,
      leaderTopic: base.leaderTopic,
      leaderLabel: base.leaderLabel,
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
      unknownLeader: base.unknownLeader
    });
  }

  // ④ 文案（§21：大字标语 + 说明全部在 Logic 层拼好，模板零计算）
  const capLine = '★ 判定对象（第' + ABNORMAL_RULE_NO + '条）：**只认市龙一**（= 30日涨幅排名第一的' +
    '【主板】票，也就是「30日涨幅」那栏的第一名）。⛔ 不是总龙一（20日涨幅第1）、⛔ 也不是' +
    '「今天偏离值最高的那只票」—— 别的票就算越线，那只是【个股异动】，不会让全市场空仓。' +
    '★ 判定口径：交易所「严重异常波动」= 10日【收盘价格涨跌幅偏离值】累计 ≥ +100%' +
    ' 或 30日 ≥ +200%（负向 ≤ −50% / ≤ −70%）。票照常列出供你核对，⛔ 不删。';
  const whyLine = '★ 为什么：用户「总龙一影响范围很大的，这个波及到所有的票」——' +
    '市龙一是全市场最强的那一只，它一旦被交易所认定严重异常波动，情绪会带崩整个市场，' +
    '所有题材一起崩 ⇒ 不是「换一只次强的买」，而是【整个市场今天都不买】。' +
    '反过来，不是市龙一的票越线只属于它自己的事（个股行为），⛔ 不影响题材、⛔ 不让市场空仓。' +
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
  } else {
    lead = leaderLabel + _pointOfName(leaderName, leaderTopic) +
      '【今日】（9:25 竞价口径）' + _trig(today) +
      ' ⇒ 按第' + ABNORMAL_RULE_NO + '条，今天【空仓】—— 不买任何票（' + ABNORMAL_NO_BUY_TAG + '）。';
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
    tail.push('⚠️ 市龙一（30日涨幅第 1 名·只主板）还没读到 ⇒ 第' + ABNORMAL_RULE_NO +
      '条【判不出】（§10：判不出 ≠ 没有异动）。⛔ 不会拿「偏离值最高的那只票」冒充市龙一。');
  }
  tail.push('⚠️ 下方股票仍按原规则【照常列出】（不删不改），但买点标签一律为【' +
    ABNORMAL_NO_BUY_TAG + '】，不计入「选出 N 只」。');
  tail.push('ℹ️ 今天其它票（非市龙一）即使越线，也只是【个股异动】⇒ 只按第三十六条灰掉那一只，' +
    '不空仓、不影响它所在题材。');

  return Object.assign(base, {
    show: true,
    headline: '🚨 监管异动 · 今日空仓（不买任何票）',
    detail: lead + whyLine + capLine + tail.join('')
  });
}
