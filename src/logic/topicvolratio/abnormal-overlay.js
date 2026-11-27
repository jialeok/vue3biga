// abnormal-overlay.js — 第三十四条【监管异动】对【已定稿计划】的显示层叠加（Logic 层纯函数）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-11-13 原话，逐字）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「昨天异动，11月12日买点侧也应该是灰色整片啊，也要提醒空仓啊，因为昨天买入的话，
//     就是个坑，也没有买点，现在还显示着东方海洋和大东方，这不合理的，要买点侧全部灰色」
//
// ── 根因（11-12 库内取证，不是推断）──────────────────────────────────────────────
//   `tvrb_plan_snapshot(2026-11-12)` 是 **v4 规则**下定稿的（revision=4）：
//     cashAlert.show=false、没有 abnormal 字段、newDragon.picks = 东方海洋/大东方（tag=新龙买）。
//   `displayPlan` 命中 `snap.status === 'hit'` 后直接返回那一份 ⇒ 第三十四条（v7 才上线的规则）
//   的规则层结果被整个丢弃。历史日按既定红线【保持定稿】（收盘后不得改写 9:25 复盘结论），
//   所以⛔ 不能靠 bump 规则版本让 11-12 重算。
//
// ⇒ 本模块把监管异动当成【显示层总约束】：不管计划来自定稿存档 / 发布结论 / 实时计算，
//   上屏前一律叠加一次「空仓标语 + 逐行不买 + 全灰标记」。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────
//   · ⛔ 不改写任何存档：返回【新对象】，传入的 frozen 一个字段都不动（§11 只读不覆盖）；
//     计划里的选票 / 题材 / 客观数据一律保留 —— 用户「选出的票整块变灰色（不用去掉）」；
//   · ⛔ 不重新选股、不删块：newDragon / catchUp / ebbBuy 等独立通道原样留着，只改标签；
//   · §10：fact 缺失 / show=false ⇒ 原样返回，⛔ 绝不拿「没算出来」当「没有异动」；
//   · 幂等：plan 已带 show=true 的 abnormal（实时路径已收口）⇒ 原样返回，不叠第二遍；
//   · §21：标语文案全部由 buildCashAlert / resolveAbnormalFact 在 Logic 层拼好，视图零计算。
// ══════════════════════════════════════════════════════════════════════════════════════

import { buildCashAlert } from './tvrb-blocks.js';
// ★★ [MARKET-DRAGON-ONLY 2026-11-25] 只留 `resolveAbnormalFact`：判定对象唯一是市龙一，
//   所以 `pickRedLineSource`（从一批票里挑越线最严重那只）+ 主板过滤 + 代码表三条 import
//   全部删掉。主板上限现在由「市龙一本身就是 30 日榜第 1 名·主板」结构性保证。
import { resolveAbnormalFact } from './abnormal-10d.js';
import {
  ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG, ABNORMAL_NO_BUY_TONE
} from './tvrb-constants.js';
import {
  eachBuyBlock, BUY_SLOT_KEYS, EXTRA_BLOCK_KEYS
} from './plan-live-overlay.js';

/** 块 / 票行各拷贝一层：够改标签，又不会把存档对象污染掉 */
function _cloneBlock(b) {
  if (!b || typeof b !== 'object') return b;
  const c = Object.assign({}, b);
  if (Array.isArray(b.picks)) {
    c.picks = b.picks.map(function (p) {
      return (p && typeof p === 'object') ? Object.assign({}, p) : p;
    });
  }
  return c;
}

/**
 * 把「监管异动 ⇒ 今天空仓」叠加到一份 plan 上（纯函数，返回新对象）。
 *
 * @param {object|null} plan 任意来源的计划（定稿存档解码结果 / 发布结论 / 实时计算）
 * @param {object|null} fact resolveAbnormalFact 的返回（show=true 才生效）
 * @returns {object|null} 叠加后的新 plan；无需叠加 ⇒ 原样返回同一个引用
 */
export function applyAbnormalOverlay(plan, fact) {
  if (!plan || !fact || fact.show !== true) return plan;                 // §10 / §11
  if (plan.abnormal && plan.abnormal.show === true) return plan;         // 幂等

  // ① 浅拷贝 plan + 按【对象身份】复用块拷贝：plan.blocks[0] 与 plan.buy.heavy 常是同一对象，
  //    分别拷贝会破坏引用一致性（视图 / 分笔装饰依赖它）。
  const ref = new Map();
  const cloneOf = function (b) {
    if (!b || typeof b !== 'object') return b;
    if (!ref.has(b)) ref.set(b, _cloneBlock(b));
    return ref.get(b);
  };
  const out = Object.assign({}, plan);
  if (Array.isArray(plan.blocks)) out.blocks = plan.blocks.map(cloneOf);
  if (plan.buy && typeof plan.buy === 'object') {
    const buy = Object.assign({}, plan.buy);
    BUY_SLOT_KEYS.forEach(function (k) {
      if (buy[k] && typeof buy[k] === 'object') buy[k] = cloneOf(buy[k]);
    });
    if (Array.isArray(plan.buy.candidates)) buy.candidates = plan.buy.candidates.map(cloneOf);
    out.buy = buy;
  }
  EXTRA_BLOCK_KEYS.forEach(function (k) {
    if (plan[k] && typeof plan[k] === 'object') out[k] = cloneOf(plan[k]);
  });
  out.notes = (Array.isArray(plan.notes) ? plan.notes : []).slice();

  // ② 逐行改写【动作标签】—— ⛔ 不碰任何客观数据（涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）。
  //    eachBuyBlock 覆盖常规块 + buy 八槽 + 六个渲染在灰化容器之外的独立通道（§6 唯一遍历）。
  eachBuyBlock(out, function (b) {
    (b.picks || []).forEach(function (p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = ABNORMAL_NO_BUY_TAG;
      p.buyActionTone = ABNORMAL_NO_BUY_TONE;
      p.actionNote = '【第' + ABNORMAL_RULE_NO + '条 · 监管异动】今天【空仓、不买任何票】。' +
        '本股原有的买点信号一律作废；股票照常列出仅供核对（⛔ 不删除），整块已灰化。';
    });
  });

  // ③ 空仓标语 + 全灰标记 + 「选出 0 只」
  //    cashAlert.show 同时驱动视图既有的 .tvrb-buy-list.tvrb-ebb 与 .tvrb-section-title.tvrb-ebb；
  //    abnormal.show 驱动六个独立容器（视图里的 abnormalGray），两者合起来才是「买点侧全部灰色」。
  out.abnormal = fact;
  out.cashAlert = buildCashAlert(null, null, fact);
  out.buyNames = new Set();
  out.pickCount = 0;
  out.notes.push('🚨【第' + ABNORMAL_RULE_NO + '条 · 监管异动 · 总约束叠加】' +
    '该日买点结论已【定稿存档】，按红线不重算、不改写；但监管异动是覆盖所有规则的总约束 ⇒ ' +
    '本页按【今日空仓、不买任何票】显示：上方空仓标语、买点侧整片灰化、所有票标签改为【' +
    ABNORMAL_NO_BUY_TAG + '】。⚠️ 股票仍按当日原结论照常列出（用户「不用去掉」），仅供参考核对。');
  return out;
}

/**
 * 视图用的「整片灰」开关（§21：判据在 Logic 层，模板只读布尔值）。
 * ⚠️ 只看 abnormal.show，⛔ 不看 cashAlert.show —— 后者在退潮 / 量比低时也 true，
 *    那些日子的独立买点块是「今天真要买的票」，必须保持不灰（§11 零行为变化）。
 */
export function isAbnormalAllGray(plan) {
  return !!(plan && plan.abnormal && plan.abnormal.show === true);
}

/**
 * 【显示层兜底】按【市龙一的官方偏离值事实】判一次异动（历史日中间态用）。
 *
 * 为什么需要：历史日 `data.value.plan` 可能还是「异步未就绪」的中间态（偏离事实还没回），
 * 只取 `plan.abnormal` 会漏掉异动日。事实由组合式算好传进来，⛔ 本函数不取数。
 *
 * ★★ [MARKET-DRAGON-ONLY 2026-11-25 用户当场纠正] ★★
 *   判定对象**只有市龙一**（30 日涨幅第 1 的主板票，名字由调用方传入）。用户原话：
 *   「不是每只股票一异动，都要提示这个的，因为很多股票都不是市龙一……他们只是属于个股异动，
 *     和题材无关。」
 *   ⇒ ⛔ 删掉「在这两张 Map 里挑偏离值最高的票」的择一逻辑 —— 那正是 11-24 误报的根因
 *     （北纬科技 +100.11% 最高，但它不是市龙一，市龙一是冰山冷热）。
 *
 * ★★ [DEV-RULE 2026-11-25 口径整体替换] 入参从「三份十日涨幅 Map」换成「两份偏离事实 Map」+
 *   市龙一名字：
 *   · 旧：`{todayMap, prevAucMap, prevCloseMap}` + `maxRangePctOf` + `pickAbnormalSource`（97% 口径）
 *   · 新：`{dragonName, todayDev, prevDev}`（官方严重异常波动，只查市龙一那一只）
 *
 * §10：市龙一名字没读到 / 两份 Map 都没有 ⇒ null（⛔ 不拿「没算出来」当「没有异动」，
 *   也 ⛔ 不凭空造空仓；⛔ 更不拿别的票冒充市龙一）。
 *
 * @param {{dragonName?:string, todayDev?:Map<string,object>, prevDev?:Map<string,object>}|null} o
 * @returns {object|null} resolveAbnormalFact 的返回；判不出 ⇒ null
 */
export function buildAbnormalFactFromMaps(o) {
  const x = o || {};
  const dragonName = String(x.dragonName || '').trim();
  const todayDev = (x.todayDev instanceof Map) ? x.todayDev : null;
  const prevDev = (x.prevDev instanceof Map) ? x.prevDev : null;
  if (!dragonName) return null;                       // 市龙一判不出 ⇒ 本条判不出（§10）
  if (!todayDev && !prevDev) return null;

  // 只取【市龙一这一只】的两份事实，⛔ 不再遍历 / 择一
  const todayFact = todayDev ? (todayDev.get(dragonName) || null) : null;
  const prevFact = prevDev ? (prevDev.get(dragonName) || null) : null;
  if (!todayFact && !prevFact) return null;

  return resolveAbnormalFact({
    leaderName: dragonName,
    leaderTopic: '',
    leaderDevToday: todayFact,
    leaderDevPrev: prevFact
  });
}
