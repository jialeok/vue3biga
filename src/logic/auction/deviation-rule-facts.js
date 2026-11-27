// deviation-rule-facts.js — 「官方偏离值」做成【选股规则输入】的唯一适配层（Logic 层纯函数）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [DEV-RULE 2026-11-25 用户口径，逐字] ★★
//   ① 「官方偏离值那里，设置的有标签逼近交易所偏离红线的股票……有这个标签的，当天买点侧
//      如果出现这只股票，是不能买的（可以显示灰块），如果是卖点侧，要当天出掉（要有提示说明）」
//   ② 「不含「偏离放大（留意）」，因为这个不是很严重」
//   ③ 「新增标签"异动卖"」
//   ④ 「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准……确实是需要改下统一口径
//      是官方偏离值那里产生异动监管，而不是自定义的。也是按照原来的规则要记录首次异动、
//      异动次日等规则不变，只是口径要改变」
//
// ── 本模块的职责边界（§3 / §4 / §21）──────────────────────────────────────────────────
//   · 只做「事实 → 规则可用信号」的翻译：档位、触发源、文案。⛔ 不取数、⛔ 不落库、⛔ 不发请求；
//   · ⛔ 不判「要不要空仓 / 要不要买」：那是第三十四条（abnormal-10d.js）与第三十六条
//     （tvrb-plan.js）的事，本模块只交出「这只票在什么档位」这一个事实；
//   · ⛔ 不另起一把尺子算偏离值：档位一律来自 `abnormal-deviation.js#computeDeviation`（§6）。
//
// ── 档位口径（与面板逐字一致，⛔ 不许在这里改数字）──────────────────────────────────────
//   红线（交易所「严重异常波动」）：10日偏离 ≥ +100% / 30日 ≥ +200%；负向 ≤ −50% / ≤ −70%
//   near  = 红线 × 0.9（`DEV_NEAR_RATIO`）：10日 ≥ +90% / 30日 ≥ +180%；负向 ≤ −45% / ≤ −63%
//   watch = 红线 × 0.7（`DEV_WATCH_RATIO`）：**用户明确不算**（「这个不是很严重」）
//   ⇒ 规则只认 `near` 与 `severe`；`watch` 一律返回 ''（= 不参与任何买卖规则）。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_NEAR_RATIO, DEV_THRESHOLDS
} from './abnormal-deviation.js';

/** 规则用档位（三态，`''` = 不进规则） */
export const DEV_RULE_NONE = '';
export const DEV_RULE_NEAR = 'near';
export const DEV_RULE_SEVERE = 'severe';

/** 官方「严重异常波动」10 日红线（+100%）。阈值唯一来源 = abnormal-deviation#DEV_THRESHOLDS，⛔ 不另写数字 */
export const DEV_OFFICIAL_RED_LINE_10D = DEV_THRESHOLDS.main.dev10;
/** 官方 30 日红线（+200%） */
export const DEV_OFFICIAL_RED_LINE_30D = DEV_THRESHOLDS.main.dev30;
/** 预警带系数（0.9）—— 转出给规则层写文案用，⛔ 别在别处再写一个 0.9 */
export { DEV_NEAR_RATIO };

/** 买点侧「逼近红线不买」标签（唯一来源，⛔ 各通道不许自己写字面量） */
export const DEV_NEAR_RULE_TAG = '逼近红线不买';
/** 卖点侧「异动卖」标签（唯一来源） */
export const DEVIATION_SELL_TAG = '异动卖';
/**
 * 卖点「异动卖」的胶囊色调（视图只读字符串，§21）。
 * ⚠️ 单独一枚而不是复用 `ABNORMAL_NO_BUY_TONE`：买点侧那枚是「深墨无描边」（= 今天不开新仓），
 *   卖点这枚是「深墨 + 琥珀描边」（= 手里这只今天必须走），语义不同、位置也不同，
 *   ⛔ 别合并。用深墨而不用红色系：本看板「涨红跌绿」，红色系 = 今天要买，会把人读反。
 */
export const DEVIATION_SELL_TONE = 'dev-sell';
/** 规则编号（买点 三十六 / 卖点 三十六·b，文案里统一写「第36条」） */
export const DEV_RULE_NO = '36';

/**
 * 【纯函数】一条偏离值事实 → 规则档位。
 *
 * ⚠️ 三态刻意收成字符串而不是布尔（与 `resolveAbnormalFact` 的 kind 同一范式）：
 *   买点侧只关心「能不能买」，卖点侧要写「逼近」还是「已达」，文案必须分得开。
 *
 * §10：`ok=false`（腿没到位 / 判不出）⇒ `''`（⛔ 绝不返回 near/severe，
 *   也绝不返回「安全」这种正结论 —— 调用方只看 '' 时应当**不施加任何限制**，
 *   但必须在说明区如实写「判不出」，见 `deviationRuleGapText`）。
 *
 * @param {object|null} fact `computeDeviation` 的返回
 * @returns {''|'near'|'severe'}
 */
export function deviationRuleStage(fact) {
  const f = fact || null;
  if (!f || f.ok !== true) return DEV_RULE_NONE;
  if (f.stage === DEV_STAGE_SEVERE) return DEV_RULE_SEVERE;
  if (f.stage === DEV_STAGE_NEAR) return DEV_RULE_NEAR;
  return DEV_RULE_NONE;                       // ok / watch / unknown ⇒ 不进规则
}

/** 【纯函数】这只票是否进规则（near 或 severe） */
export function isDeviationRuleHit(fact) {
  return deviationRuleStage(fact) !== DEV_RULE_NONE;
}

/** 【纯函数】是否越了官方红线（只有它才构成「监管异动」） */
export function isDeviationOverRedLine(fact) {
  return deviationRuleStage(fact) === DEV_RULE_SEVERE;
}

/**
 * 【纯函数】从一批事实里挑「越线最严重」的那一只 —— 第三十四条 / 三十四·b 的【触发源】。
 *
 * 口径（⛔ 别改成「十日涨幅最高」）：
 *   · 候选 = 传进来的那一批（总龙一 + 前五 + 入选票 + 卖点候选），⛔ 不扫全市场
 *     （偏离值要逐日腿，全市场 5000 只不可行；规则本来就只关心「会被选中的票」+「龙头」）；
 *   · 排序键 = `max(|dev10| / 100, |dev30| / 200)` 降序 —— 两个窗口按各自红线归一，才可比；
 *   · 只收 `severe`；没有 ⇒ null（§10 判不出 ≠ 没异动，调用方要自己交代）；
 *   · `opts.isEligible(name, fact)` 可再收窄（第三十四条只认主板），缺省全放行。
 *
 * @param {Map<string,object>|Array<object>} facts 票名 → fact（或 fact 数组，元素需带 name）
 * @param {{isEligible?:function(string,object):boolean}} [opts]
 * @returns {{name:string, fact:object, score:number}|null}
 */
export function pickSevereDeviation(facts, opts) {
  const o = opts || {};
  const eligible = (typeof o.isEligible === 'function') ? o.isEligible : function () { return true; };
  const list = [];
  if (facts instanceof Map) {
    facts.forEach(function (f, name) { list.push({ name: String(name || ''), fact: f }); });
  } else if (Array.isArray(facts)) {
    facts.forEach(function (f) {
      if (f && f.name) list.push({ name: String(f.name), fact: f });
    });
  }
  let best = null;
  list.forEach(function (x) {
    if (!x.name || !x.fact) return;
    if (deviationRuleStage(x.fact) !== DEV_RULE_SEVERE) return;
    if (!eligible(x.name, x.fact)) return;
    const d10 = _absNum(x.fact.dev10);
    const d30 = _absNum(x.fact.dev30);
    const score = Math.max(
      d10 === null ? 0 : d10 / 100,
      d30 === null ? 0 : d30 / 200
    );
    if (!best || score > best.score) best = { name: x.name, fact: x.fact, score: score };
  });
  return best;
}

function _absNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[%,+\s]/g, ''));
  if (!isFinite(n)) return null;
  return Math.abs(n);
}

/** 【纯函数】档位 → 人话（买点行 / 卖点行说明的第一句） */
export function deviationStageText(fact) {
  const st = deviationRuleStage(fact);
  if (st === DEV_RULE_SEVERE) return '已达交易所严重异常波动标准';
  if (st === DEV_RULE_NEAR) return '逼近交易所偏离红线';
  return '';
}

/**
 * 【纯函数】买点行说明（第三十六条）——「为什么不能买 + 离红线多远 + 口径」。
 *
 * 用户口径：「你要有说明文字提醒」⇒ 这行必须能独立看懂，不能只留一个标签。
 *
 * @param {object} fact
 * @param {{basis?:''|'auction'|'close', asOf?:string}} [opts]
 * @returns {string}
 */
export function deviationRuleBuyNote(fact, opts) {
  const o = opts || {};
  const st = deviationRuleStage(fact);
  if (!st) return '';
  const head = st === DEV_RULE_SEVERE
    ? '已达交易所「严重异常波动」标准（越线）'
    : '逼近交易所偏离红线（红线的 ' + Math.round(DEV_NEAR_RATIO * 100) + '%）';
  const nums = [];
  if (_hasNum(fact.dev10)) nums.push('10日偏离 ' + _signed(fact.dev10) + '%（红线 +100% / −50%）');
  if (_hasNum(fact.dev30)) nums.push('30日偏离 ' + _signed(fact.dev30) + '%（红线 +200% / −70%）');
  const basis = o.basis === 'auction'
    ? '口径：9:25 竞价（盘中判「开盘前会不会触发」）'
    : (o.basis === 'close' ? '口径：收盘' : '');
  const recap = '偏离值 = 个股累计涨幅 − 对应指数累计涨幅（复利区间差），只算 10 日 / 30 日两个窗口';
  return '【第' + DEV_RULE_NO + '条 · ' + DEV_NEAR_RULE_TAG + '】' + head +
    (nums.length ? '：' + nums.join('、') : '') + '。' +
    (basis ? basis + '；' : '') + recap + '。出现这个标签 ⇒ 今天这只票不给买点（题材块里其它票照常）。';
}

/**
 * 【纯函数】卖点行说明（第三十六条·b）——「为什么当天必须出掉」。
 *
 * @param {object} fact
 * @param {{basis?:''|'auction'|'close', prevActionText?:string}} [opts]
 *        `prevActionText` = 原本的卖点动作（竞价卖 / 尾盘卖 / 持有…），写进说明便于对照
 * @returns {string}
 */
export function deviationSellNote(fact, opts) {
  const o = opts || {};
  const st = deviationRuleStage(fact);
  if (!st) return '';
  const head = st === DEV_RULE_SEVERE
    ? '已达交易所「严重异常波动」标准'
    : '逼近交易所偏离红线';
  const nums = [];
  if (_hasNum(fact.dev10)) nums.push('10日偏离 ' + _signed(fact.dev10) + '%');
  if (_hasNum(fact.dev30)) nums.push('30日偏离 ' + _signed(fact.dev30) + '%');
  const basis = o.basis === 'auction' ? '（9:25 竞价口径）' : (o.basis === 'close' ? '（收盘口径）' : '');
  const prev = String(o.prevActionText || '').trim();
  return '【第' + DEV_RULE_NO + '条 · ' + DEVIATION_SELL_TAG + '】' + head +
    (nums.length ? '：' + nums.join('、') : '') + basis +
    ' ⇒ 今天【当天出掉】，不留到明天（异动票次日大概率继续被监管 / 情绪反噬）。' +
    (prev ? '（原卖点动作：' + prev + '）' : '');
}

/**
 * 【纯函数】§10 缺口说明：这一屏有多少只票的偏离值「判不出」。
 * 用户口径是「有这个标签就不能买」—— 那「算不出来」必须说出来，⛔ 不能静默当成安全。
 */
export function deviationRuleGapText(facts) {
  if (!(facts instanceof Map) || facts.size === 0) return '';
  let bad = 0;
  facts.forEach(function (f) { if (!f || f.ok !== true) bad++; });
  if (bad === 0) return '';
  return '⚠️ 偏离值有 ' + bad + '/' + facts.size + ' 只算不出（逐日腿或指数腿缺）⇒ 这 ' + bad +
    ' 只【没有施加】逼近红线限制，不是「已确认安全」。';
}

function _hasNum(v) {
  return v !== null && v !== undefined && v !== '' && isFinite(Number(String(v).replace(/[%,+\s]/g, '')));
}
function _signed(v) {
  const n = Number(String(v).replace(/[%,+\s]/g, ''));
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
