// deviation-overlay.js — 「官方偏离值」对【已定稿计划】的显示层叠加（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【用户口径（2026-11-14 原话，逐字）】
//   「这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，我看一遍股票或者市场前十，
//     就知道怎么参考了。」
//
// ⇒ 本模块只干一件事：把「某只票的 10 日 / 30 日偏离值离交易所红线还有多远」贴到买点行上。
//
// ── 为什么做成【叠加层】而不是塞进规则层 ─────────────────────────────────────────
//   · 规则层（tvrb-plan）正在被「97% 原始涨幅」那套守卫占着，动它要连带改一圈规则与文案；
//   · 偏离值本质是【解释性事实】：它不改变「选哪几只」，只改变「这一行该怎么读」；
//   · 定稿存档（plan_snapshot）冻结的是选股结论 —— 偏离值属于客观行情事实，
//     应当按「读得到就显示、读不到就不显示」处理，⛔ 不该冻进存档、也不该逼历史日重算。
//   ⇒ 与 `applyAbnormalOverlay` 同一套路（§6 只此一份），上屏前叠加，不写库。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────
//   · ⛔ 不改选股结论、不删票、不改 buyActionTag / position / holdTag / 任何客观数据；
//   · ⛔ 不改写传入的 plan（§11 只读）—— 返回带新字段的新对象；
//   · §10：devMap 里没有这只票 / fact.ok=false ⇒ 该行**不加任何徽标**（⛔ 不写「—」占位、
//     ⛔ 不写「0%」、⛔ 绝不把它当成「没有异动」下结论）；
//   · §21：徽标文字已在 `abnormal-deviation.js` 拼好（badge / gapText / detailLine），
//     视图零计算；
//   · 幂等：纯函数 + 全量重算 ⇒ 同一个输入永远同一个输出，⛔ 不需要「叠过就跳过」的分支
//     （跳过反而会让「先缺数据后到货」的情况永远补不上）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { eachBuyBlock, BUY_SLOT_KEYS, EXTRA_BLOCK_KEYS } from './plan-live-overlay.js';
import {
  DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_STAGE_WATCH, STAGE_TEXT
} from '../auction/abnormal-deviation.js';

/** 买点行上要写的那几个字段（⛔ 与 range20Label / pctText 完全分开，绝不改它们） */
const DEV_ROW_FIELDS = ['devStage', 'devBadge', 'devGap', 'devTone', 'devTitle', 'devStageText'];

/** 清掉旧叠加（幂等重算前先抹掉，避免 devMap 变小时残留上一轮的值） */
function _clearDev(p) {
  DEV_ROW_FIELDS.forEach(function (k) { delete p[k]; });
}

function _clonePlan(plan) {
  const ref = new Map();
  const cloneBlock = function (b) {
    if (!b || typeof b !== 'object') return b;
    if (ref.has(b)) return ref.get(b);
    const c = Object.assign({}, b);
    if (Array.isArray(b.picks)) {
      c.picks = b.picks.map(function (p) {
        return (p && typeof p === 'object') ? Object.assign({}, p) : p;
      });
    }
    ref.set(b, c);
    return c;
  };
  const out = Object.assign({}, plan);
  if (Array.isArray(plan.blocks)) out.blocks = plan.blocks.map(cloneBlock);
  if (plan.buy && typeof plan.buy === 'object') {
    const buy = Object.assign({}, plan.buy);
    BUY_SLOT_KEYS.forEach(function (k) { if (buy[k]) buy[k] = cloneBlock(buy[k]); });
    if (Array.isArray(plan.buy.candidates)) buy.candidates = plan.buy.candidates.map(cloneBlock);
    out.buy = buy;
  }
  EXTRA_BLOCK_KEYS.forEach(function (k) {
    if (plan[k] && typeof plan[k] === 'object' && plan[k].picks) out[k] = cloneBlock(plan[k]);
  });
  return out;
}

/**
 * 把偏离值贴到买点侧每一行（纯函数，返回新对象）。
 *
 * @param {object|null} plan 任意来源的计划（定稿存档 / 发布结论 / 实时计算）
 * @param {Map<string, object>|null} devMap 票名 → `computeDeviation` 的 fact
 * @param {object} [meta] { ready, total, note, asOf }
 * @returns {object|null} 叠加后的新 plan；无需叠加（无 devMap 或无一行命中）⇒ 原样返回同一引用
 */
export function attachDeviationFacts(plan, devMap, meta) {
  if (!plan || !(devMap instanceof Map) || devMap.size === 0) return plan;   // §10 / §11

  let touched = 0;
  const alertNames = [];
  const severeNames = [];
  const watchNames = [];
  let matched = 0;

  const out = _clonePlan(plan);
  eachBuyBlock(out, function (b) {
    (b.picks || []).forEach(function (p) {
      if (!p || !p.name) return;
      _clearDev(p);                                   // 幂等：先抹掉上一轮
      const f = devMap.get(String(p.name).trim());
      if (!f || f.ok !== true) return;                 // §10：判不出 ⇒ 不加任何徽标
      matched++;
      p.devStage = f.stage;
      p.devStageText = f.stageText || STAGE_TEXT[f.stage] || '';
      p.devBadge = f.badge || '';
      // ⚠️ 买点行是横向挤着的一行（龙标+名次+涨幅+竞价+量比…）⇒ 只印【短版点差】，
      //    「股价再涨约 +16%」那句留给面板和 title（完整版在 f.gapText / f.line）。
      //    ⛔ 不许为了「短」就改成股价涨幅 —— 那正是用户 11-14 对不上账的原因。
      p.devGap = f.gapShort || f.gapText || '';
      p.devTone = f.tone || 'muted';
      p.devTitle = f.line ? (f.line + '。' + (f.stageText || '')) : (f.stageText || '');
      if (f.stage === DEV_STAGE_SEVERE) severeNames.push(p.name);
      else if (f.stage === DEV_STAGE_NEAR) alertNames.push(p.name);
      else if (f.stage === DEV_STAGE_WATCH) watchNames.push(p.name);
      touched++;
    });
  });

  if (touched === 0) return plan;                      // 一行都没命中 ⇒ 原样返回，不造空对象

  out.deviation = {
    applied: true,
    asOf: (meta && meta.asOf) || '',
    ready: (meta && typeof meta.ready === 'number') ? meta.ready : null,
    total: (meta && typeof meta.total === 'number') ? meta.total : null,
    matched: matched,          // ⚠️ 是「命中的【行】数」，不是去重票数（同一只票可在多个块里）
    matchedRows: matched,
    matchedStocks: Array.from(new Set(
      [].concat(severeNames, alertNames, watchNames)
    )).length,
    severeNames: severeNames,
    alertNames: alertNames,
    watchNames: watchNames,
    note: _deviationNote({ severeNames, alertNames, watchNames, meta })
  };
  return out;
}

/** 说明区那一句（§21 文案在 Logic 层拼好） */
function _deviationNote(o) {
  const m = o.meta || {};
  const parts = [];
  if (o.severeNames.length > 0) {
    parts.push('🚨 买点侧有票【已达交易所严重异常波动标准】（' + o.severeNames.join('、') +
      '）：10 日偏离 ≥ +100% 或 30 日偏离 ≥ +200%，交易所会要求披露核查公告、无法披露即停牌。');
  }
  if (o.alertNames.length > 0) {
    parts.push('⚠️ 买点侧有票【逼近偏离红线】（' + o.alertNames.join('、') +
      '）：已到红线的 90%，再涨一两天就可能触发严重异动。');
  }
  if (o.watchNames.length > 0) {
    parts.push('· 偏离值放大（留意）：' + o.watchNames.join('、') + '。');
  }
  if (parts.length === 0) return '';
  const cover = (typeof m.ready === 'number' && typeof m.total === 'number')
    ? '（偏离值覆盖 ' + m.ready + '/' + m.total + ' 只，' + (m.asOf || '—') + ' 口径）'
    : '';
  return parts.join('') + '★ 口径：交易所官方「收盘价格涨跌幅偏离值累计值」，' +
    '对应指数按板块取（沪主板=上证A股指数／深主板=深证A股指数／创业板=创业板综指／科创板=科创50）' +
    '，⛔ 不是「原始十日涨幅」那一套。' + cover;
}

/**
 * 视图用的「有没有偏离预警」布尔（§21：判据在 Logic 层，模板只读布尔值）。
 * ⚠️ 只认 near / severe —— watch 只是留意，不给整块上色，避免满屏黄。
 */
export function hasDeviationAlert(plan) {
  const d = plan && plan.deviation;
  return !!(d && d.applied && ((d.severeNames && d.severeNames.length) || (d.alertNames && d.alertNames.length)));
}

/** 供视图取单行色调：'severe' | 'near' | 'watch' | 'normal' | 'muted' */
export function devToneOf(pick) {
  const t = pick && pick.devTone;
  return (typeof t === 'string' && t) ? t : '';
}
