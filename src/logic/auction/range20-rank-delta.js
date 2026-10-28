// range20-rank-delta.js — 「20日涨幅」模式下的【名次变化】计算（Logic 层，纯函数、可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-10-28 原话）：
//   「还有20日涨幅，你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，
//     比如+6，排名下降就用绿色，比如-7，也就是按照20日涨幅的排序，对比昨日排名情况进行标注，
//     其它不变。这个数值变化，也很重要，可以看出个股突破。」
//
// 【口径定义】（这是本条最容易做歪的地方，先写死再实现）
//   · 集合 = 【今天屏幕上有 20日涨幅、且昨天也有落库名次】的那批股票（= 可比集合）。
//     ⛔ 不拿「今天的名次」和「昨天全表的名次」直接相减 —— 两天名单长度不同，那样得到的位移
//        有一半是「名单换了」造成的假信号，看不出「个股突破」。所以两天都在【同一集合内】重排。
//   · 今日名次 = 可比集合内按今日 20日涨幅降序的位置（1 起）；
//   · 昨日名次 = 同一集合内按昨日 20日涨幅降序的位置（1 起）；
//   · 变化 = 昨日名次 − 今日名次 ⇒ 正数 = 上升（红），负数 = 下降（绿），0 = 不变。
//   · 判不出（今天没值 / 昨天没名次）⇒ delta = null，行上显示 '—'（§10：判不出 ≠ 没变化）。
//
// ⛔ 本模块【不发请求、不碰 DOM】：数据由 data/range20-prev-rank.js 提供，渲染由视图/组件负责。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 数值解析：null / '' / 非数字 ⇒ null（⛔ 不返回 0） */
function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 计算「20日涨幅」名次变化表。
 *
 * @param {Map<string, {pct:number|null, days:number}>|null} todayMap 今日屏幕各行（range20.js 的会话 Map）
 * @param {{ranks: Map<string, number>, pcts: Map<string, number>}|null} prevRec 昨日名次表（Data 层）
 * @returns {Map<string, {delta:number, dir:'up'|'down'|'flat', text:string, tone:'up'|'down'|'flat'}>}
 *          只包含【比得出来】的股票；判不出的股票不在 Map 里（调用方按 '—' 处理）
 */
export function buildRange20RankDelta(todayMap, prevRec) {
  const out = new Map();
  if (!todayMap || typeof todayMap.forEach !== 'function') return out;
  if (!prevRec || !prevRec.ranks || !prevRec.pcts || prevRec.ranks.size === 0) return out;

  // ① 可比集合：今天有值 + 昨天有名次
  const pair = [];
  todayMap.forEach(function(v, stock) {
    const name = String(stock || '').trim();
    if (!name) return;
    const t = _num(v && v.pct);
    if (t === null) return;
    const pr = prevRec.ranks.get(name);
    const pp = prevRec.pcts.get(name);
    if (pr === undefined || pp === undefined || pp === null) return;
    pair.push({ stock: name, today: t, prev: pp });
  });
  // 集合里只有一只 ⇒ 任何位移都是 0，没有信息量 ⇒ 判不出（⛔ 别显示一排「0」）
  if (pair.length < 2) return out;

  // ② 同一集合内分别按今日 / 昨日降序排（同值按股票名定序，保证结果稳定、可复现）
  const byName = function(a, b) { return String(a.stock).localeCompare(String(b.stock), 'zh'); };
  const todayRanked = pair.slice().sort(function(a, b) { return (b.today - a.today) || byName(a, b); });
  const prevRanked = pair.slice().sort(function(a, b) { return (b.prev - a.prev) || byName(a, b); });
  const prevPos = new Map();
  prevRanked.forEach(function(it, i) { prevPos.set(it.stock, i + 1); });

  // ③ 变化 = 昨日名次 − 今日名次（正 = 上升）
  todayRanked.forEach(function(it, i) {
    const todayRank = i + 1;
    const prevRank = prevPos.get(it.stock);
    if (!prevRank) return;
    const delta = prevRank - todayRank;
    out.set(it.stock, {
      delta: delta,
      dir: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
      // 文案在 Logic 层拼好（§21：模板零计算）；上升带 '+'，下降本身带 '−'
      text: delta > 0 ? ('+' + delta) : String(delta),
      tone: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    });
  });
  return out;
}

/** 行上「判不出」时统一显示这个（⛔ 不要用 0 冒充「没变化」） */
export const RANGE20_DELTA_UNKNOWN_TEXT = '—';
