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
import { resolveAbnormalFact, pickAbnormalSource } from './abnormal-10d.js';
import { maxRangePctOf } from './tvrb-plan.js';
import { _num } from './tvrb-utils.js';
import {
  ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG, ABNORMAL_NO_BUY_TONE
} from './tvrb-constants.js';
import {
  eachBuyBlock, BUY_SLOT_KEYS, EXTRA_BLOCK_KEYS
} from './plan-live-overlay.js';

/** 按【票名】从一份竞价口径 Map 里取那只票自己的涨幅（§10：取不到 ⇒ null，⛔ 不补 0） */
function _pctOf(map, name) {
  if (!(map instanceof Map) || !name) return null;
  const hit = map.get(String(name).trim());
  return hit ? _num(hit.pct) : null;
}

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
 * 【显示层兜底】直接按三份【云端竞价口径 Map】判一次异动事实。
 *
 * 为什么需要：历史日 `data.value.plan` 可能还是「异步未就绪」的中间态（buyRangeMap 还没回来），
 * 只取 `plan.abnormal` 会漏掉 11-12 这种定稿日。三份 Map 都由 `readAuctionLegRangeMap` /
 * `readRangePctForDate` 从 Supabase 读回，⛔ 不是本机算的，关电脑后别人打开页面照样判得出。
 *
 * ⚠️ 与规则层 `buildTopicVolRatioPlan` 用的是【同一批纯函数】（maxRangePctOf +
 *    resolveAbnormalFact），判据仍是一把尺子（§6）；规则层额外有「入选票异动」形态，
 *    所以调用方【优先】取规则层那份，本函数只作补位。
 * §10：三份都读不到 ⇒ null（⛔ 不拿「没算出来」当「没有异动」，也不凭空造空仓）。
 *
 * @param {{todayMap?:Map, prevAucMap?:Map, prevCloseMap?:Map}|null} o
 * @returns {object|null} resolveAbnormalFact 的返回；判不出 ⇒ null
 */
export function buildAbnormalFactFromMaps(o) {
  const x = o || {};
  const t = maxRangePctOf(x.todayMap);
  const pa = maxRangePctOf(x.prevAucMap);
  const pc = maxRangePctOf(x.prevCloseMap);
  if (!t && !pa && !pc) return null;

  // ★★ [ABN-SAME-SOURCE 2026-11-13 用户报错后修] 这里原来写的是
  //     `leaderName: (t || p).name` + `leaderPctPrev: p.pct`
  //   ⇒ 「名字取【今日】最高票、数值取【昨日】最高票」—— 正是用户看到的那句话：
  //     「11月13日提示……市场总龙一闵发铝业十日涨幅100.78%，根本不是，相差太大了」。
  //   11-13 实测：今日最高 = 闽发铝业 84.88%，昨日最高 = 东方海洋 100.78%
  //   ⇒ 拼出「闽发铝业 100.78%」（差 13.74 个点）。
  //   修复：先定【触发源是哪只票】（择一走同一把纯函数 pickAbnormalSource），
  //   再按这个名字分别取今日 / 昨日的值；两个数字永远同属一只票。
  const pick = pickAbnormalSource({
    leaderName: '',            // ★ 本路径没有「二十日涨幅总龙一」的信息（§10 不猜）
    leaderToday: null,
    leaderPrevAuc: null,
    leaderPrevClose: null,
    marketToday: t,
    marketPrevAuc: pa,
    marketPrevClose: pc
  });
  const name = (pick.triggered ? pick.name : ((t || pa || pc).name));
  const todayPct = _pctOf(x.todayMap, name);
  const prevAucPct = _pctOf(x.prevAucMap, name);
  const prevClosePct = _pctOf(x.prevCloseMap, name);
  const prevPct = (prevAucPct !== null) ? prevAucPct : prevClosePct;
  const basis = (prevAucPct !== null) ? 'auction' : (prevClosePct !== null ? 'close' : '');

  return resolveAbnormalFact({
    leaderName: name,
    leaderTopic: '',
    // ⛔ 不许自称「市场总龙一」：这条路径拿不到二十日涨幅榜，只能如实说「十日涨幅最高票」
    leaderIsTop1: false,
    leaderPctToday: todayPct,
    leaderPctPrev: prevPct,
    leaderPctPrevBasis: basis,
    rows: []
  });
}
