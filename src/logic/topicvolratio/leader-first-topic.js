// leader-first-topic.js — 第二十八条【老题材 = 老龙一第一次霸榜总龙一那天的题材大类】（Logic 层，纯函数，§15）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [LEADER-FIRST-TOPIC 2026-11-12 用户口径] 用户原话（逐字保留，本文件唯一需求来源）：
// ══════════════════════════════════════════════════════════════════════════════════════
//   「选票是正确了，但是我不知道你表述错误，还是逻辑错误，我都说了提到题材的时候要说大类，
//     你说农业（老龙一 东方海洋），要考究东方海洋的大类，首先要确定它老龙一霸榜的题材是什么，
//     从第一次霸榜总龙一开始，你检索下历史20个交易日，它第一次霸榜总龙一是不是在11月4日，
//     当时20日涨幅竞价口径，羊字辈就有5只，东方海洋总龙一，排名是，3百洋股份，4九阳股份，
//     5海洋王，7阳光照明，已经是超过标准了，确定是羊字辈的题材。你在11月12日看来，这个就是
//     作为老题材，你要检索下它20日涨幅，20个交易日第一次霸榜总龙一的题材是什么，这个称为老题材，
//     也就是羊字辈。而不是你说的农业」
//   「你要注意，我会随时改核心词，选股有时也会根据核心词的同义词进行调整，你提就要提核心词（大类）
//     不要说一些同义词细分，这个我之前有要求过的。」
//
// ── 上一版错在哪 ────────────────────────────────────────────────────────────────
//   上一版直接拿【退潮日落库行的 leader_topic】当老题材（`switchDay.topic`）。
//   那一条是「退潮那天这个题材被叫成什么」，不是「老龙一霸榜时它是什么」：
//     11-10 那一天算出来的题材是「农业」（东方海洋题材串「水产品,农业,东方,羊字辈」经核心词
//     归一后 `水产品→农业`）⇒ 提示板上写着「农业（老龙一 东方海洋）」，与用户口径不符。
//   而真正的老题材 = 羊字辈：11-04 那天它第一次霸榜总龙一，前十里有【5 只羊字辈】。
//
// ── 本版判据（三步，全部基于【9:25 竞价口径 · 20日涨幅】）──────────────────────────
//   ① 【第一次霸榜】窗口 = 展示日往前 `LEADER_FIRST_TOPIC_WINDOW_DAYS(20)` 个交易日；
//      逐日算「当天竞价口径榜第 1 名是谁」，取该票**最早**排第 1 的那天（11-12 ⇒ 11-04）。
//      ⚠️ 榜的口径与用户在「20日涨幅 toggle · 竞价口径」上看到的完全同一份实现
//        （`range20-auction-leg.js#buildAuctionLegPctMap` 反解 + `tvrb-auction-board.js#buildTvrbAuctionBoard`
//        只主板 / 9:25 名单白名单 / 腿数门槛 / 排序）—— §6 一把尺子，⛔ 不另写一套。
//   ② 【老题材】= 那一天前十按【题材段】分组后，**它所在组里成员最多的那一段**（且 ≥2 只）。
//      为什么要「成员最多」而不是核心词归一：用户口径是「前排里同一个炒作线有几只」，
//      11-04 实测 羊字辈 5 只 > 水产品 2 只 = 农业 2 只 > 东方 1 只 ⇒ 羊字辈 ✅
//      ⚠️ 平局时【字辈线优先】（`isLineageTopic`：库里「…字辈」就是老周期阵营的标记），
//        再按「组内最靠前名次」、最后字典序 —— 结果确定可复现（§6）。
//   ③ 【核心词大类】最终题材再过 `_normTopic(raw, coreRes)`（用户「提就要提核心词（大类）」）。
//      羊字辈 不在核心词表里 ⇒ 原样保留（`makeCoreTopicResolver` 的既有语义）。
//
// ── 边界（§10）──────────────────────────────────────────────────────────────────
//   · 窗口里一天的榜都算不出来 ⇒ `ready:false, reason:'no-board'`（⛔ 不返回空结论）
//   · 该票在窗口内一次都没排第 1 ⇒ `ready:false, reason:'never-top1'`（这是【判出「没有」】）
//   · 找到首霸日但该票所在组没有一段 ≥2 只 ⇒ `ready:false, reason:'no-family'`
//     （调用方退回落库行的题材，并如实标注「首霸日题材不足 2 只」）
//   · ⛔ 本文件不读 state / 不发请求 / 不拼展示文案（§4 / §21）
// ══════════════════════════════════════════════════════════════════════════════════════

import { LEADER_FIRST_TOPIC_WINDOW_DAYS, OLD_TOPIC_FAMILY_MIN_COUNT } from './tvrb-constants.js';
// §6 单一数据源：竞价口径反解 / 榜口径 / 题材分段 / 字辈线判定，全部复用既有实现
import { buildAuctionLegPctMap } from '../auction/range20-auction-leg.js';
import { buildTvrbAuctionBoard } from './tvrb-auction-board.js';
import { splitTopicSegs, isLineageTopic } from './new-dragon-family.js';
import { _normTopic } from './tvrb-utils.js';

/**
 * 单日的「竞价口径前十」——薄封装：反解 + 榜口径，两个既有纯函数各调一次（§6）。
 *
 * @param {{rangeRows:Map, metricRows:Array}|null} input 某日的原始行
 * @param {{codeOf?:Function, minDays?:number}} [opts]
 * @returns {null|{top10:Array, rank:Array}} null = 这天算不出（§10）
 */
export function boardOfDay(input, opts) {
  if (!input) return null;
  const pctMap = buildAuctionLegPctMap(input.rangeRows, input.metricRows);
  if (!pctMap) return null;
  const board = buildTvrbAuctionBoard(pctMap, input.metricRows, opts);
  return board && board.ready ? board : null;
}

/**
 * ★★ [LEADER-FIRST-TOPIC] 从「近 N 个交易日每日榜」里找出这只票【第一次霸榜总龙一】的那天。
 *
 * @param {Map<string,{top10:Array, rank:Array}>} boardsByDate 日期 -> boardOfDay 的返回（只放算得出的天）
 * @param {string} leaderName 老龙一（退潮那只总龙）
 * @returns {{firstDate:string, leaderDays:number, topPct:number|null, days:number, dates:string[]}}
 *          firstDate='' ⇒ 窗口内一次都没排第 1（≠ 判不出）
 */
export function detectLeaderFirstDay(boardsByDate, leaderName) {
  const name = String(leaderName || '').trim();
  const out = { firstDate: '', leaderDays: 0, topPct: null, days: 0, dates: [] };
  if (!boardsByDate || typeof boardsByDate.forEach !== 'function') return out;
  const dates = [];
  boardsByDate.forEach(function(_v, d) { dates.push(String(d)); });
  dates.sort();
  out.days = dates.length;
  out.dates = dates;
  if (!name) return out;
  for (let i = 0; i < dates.length; i++) {
    const b = boardsByDate.get(dates[i]);
    const top = b && Array.isArray(b.rank) && b.rank.length > 0 ? b.rank[0] : null;
    if (!top || String(top.stock || '').trim() !== name) continue;
    out.leaderDays += 1;
    if (!out.firstDate) {
      out.firstDate = dates[i];
      out.topPct = Number(top.pct);
    }
  }
  return out;
}

/**
 * ★★ [LEADER-FIRST-TOPIC] 某日的前十里，这只票所在【题材组】里成员最多的那一段 = 老题材。
 *
 * @param {Array<{stock:string, pct:number}>} top10 该日竞价口径前十（已排序）
 * @param {string} leaderName
 * @param {{topicOf?:(name:string)=>string, coreRes?:Function, minCount?:number}} [opts]
 *        `topicOf` = 股票名 → 题材串（组合式用题材库注入；⛔ 本层不读库）
 * @returns {{topic:string, raw:string, count:number, members:Array<{name:string,rank20:number}>,
 *            groups:Array<{topic:string,count:number,bestRank:number}>}}
 *          topic='' ⇒ 判不出（没有一段 ≥minCount）
 */
export function pickOldTopicFamily(top10, leaderName, opts) {
  const o = opts || {};
  const name = String(leaderName || '').trim();
  const list = Array.isArray(top10) ? top10 : [];
  const topicOf = (typeof o.topicOf === 'function') ? o.topicOf : null;
  const minCount = Number(o.minCount) > 0 ? Number(o.minCount) : OLD_TOPIC_FAMILY_MIN_COUNT;
  const empty = { topic: '', raw: '', count: 0, members: [], groups: [] };
  if (!name || list.length === 0 || !topicOf) return empty;

  // ① 按题材段分组（一段一个组：库里的「水产品,农业,东方,羊字辈」= 4 个组，⛔ 不做核心词合并）
  const map = new Map();
  list.forEach(function(c, i) {
    const nm = String((c && c.stock) || '').trim();
    if (!nm) return;
    const rank20 = Number(c && c.rank20) || (i + 1);
    let raw = '';
    try { raw = String(topicOf(nm) || ''); } catch (e) { raw = ''; }
    splitTopicSegs(raw).forEach(function(seg) {
      let g = map.get(seg);
      if (!g) { g = { topic: seg, members: [], isLineage: isLineageTopic(seg) }; map.set(seg, g); }
      if (g.members.some(function(m) { return m.name === nm; })) return;
      g.members.push({ name: nm, rank20: rank20 });
    });
  });

  const groups = [];
  map.forEach(function(g) {
    groups.push({
      topic: g.topic,
      count: g.members.length,
      bestRank: g.members.length > 0 ? g.members[0].rank20 : 0,
      isLineage: g.isLineage,
      members: g.members
    });
  });
  // 排序（§6 确定性）：成员多 → ★字辈线优先（老周期阵营标记）→ 组内最靠前 → 字典序
  groups.sort(function(a, b) {
    if (b.count !== a.count) return b.count - a.count;
    if (a.isLineage !== b.isLineage) return a.isLineage ? -1 : 1;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });

  // ② 只在【这只票自己所属】的组里选（它在别人的题材里不可能是老龙）
  const own = groups.filter(function(g) {
    return g.members.some(function(m) { return m.name === name; });
  });
  const pubGroups = groups.map(function(g) {
    return { topic: g.topic, count: g.count, bestRank: g.bestRank };
  });
  const hit = own.filter(function(g) { return g.count >= minCount; })[0] || null;
  if (!hit) return Object.assign({}, empty, { groups: pubGroups });
  return {
    topic: _normTopic(hit.topic, o.coreRes),
    raw: hit.topic,
    count: hit.count,
    members: hit.members.slice().sort(function(a, b) { return a.rank20 - b.rank20; }),
    groups: pubGroups
  };
}

/**
 * ★★ [LEADER-FIRST-TOPIC] 一步到位：近 N 个交易日的原始行 → 老题材（大类）+ 判定日 + 成员。
 *
 * @param {Map<string, {rangeRows:Map, metricRows:Array}>} inputsByDate
 *        `data/leader-rank-history.js#readLeaderRankInputsForDates` 的返回
 * @param {string} leaderName 老龙一（退潮那一行上的总龙）
 * @param {{topicOf?:(name:string)=>string, coreRes?:Function, minCount?:number,
 *          windowDays?:number, codeOf?:Function}} [opts]
 * @returns {{
 *   ready:boolean, reason:string,
 *   firstDate:string, topic:string, rawTopic:string, count:number,
 *   members:Array<{name:string,rank20:number}>, groups:Array,
 *   leaderDays:number, topPct:number|null, days:number, windowDays:number
 * }}
 *   `ready:true` ⇒ 老题材可用（`topic` 已过核心词大类归一）；
 *   `ready:false` ⇒ 调用方退回「退潮日落库行的题材」，并把 `reason` 如实写进说明（§10）。
 */
export function detectLeaderFirstTopic(inputsByDate, leaderName, opts) {
  const o = opts || {};
  const windowDays = Number(o.windowDays) > 0 ? Number(o.windowDays) : LEADER_FIRST_TOPIC_WINDOW_DAYS;
  const base = {
    ready: false, reason: '', firstDate: '', topic: '', rawTopic: '', count: 0,
    members: [], groups: [], leaderDays: 0, topPct: null, days: 0, windowDays: windowDays
  };
  const name = String(leaderName || '').trim();
  if (!name) return Object.assign({}, base, { reason: 'no-leader' });
  if (!inputsByDate || typeof inputsByDate.forEach !== 'function' || inputsByDate.size === 0) {
    return Object.assign({}, base, { reason: 'no-board' });     // §10 判不出（⛔ 不是「没有」）
  }

  // ① 逐日算榜（只放算得出的天）
  const boards = new Map();
  const codeOf = (typeof o.codeOf === 'function') ? o.codeOf : null;
  inputsByDate.forEach(function(input, d) {
    const boardOpts = codeOf ? { codeOf: codeOf } : undefined;
    const b = boardOfDay(input, boardOpts);
    if (b) boards.set(String(d), b);
  });
  if (boards.size === 0) return Object.assign({}, base, { reason: 'no-board' });

  // ② 第一次霸榜总龙一
  const first = detectLeaderFirstDay(boards, name);
  const withFirst = Object.assign({}, base, {
    firstDate: first.firstDate, leaderDays: first.leaderDays,
    topPct: first.topPct, days: first.days
  });
  if (!first.firstDate) {
    return Object.assign(withFirst, { reason: 'never-top1' });   // 判出「没有」，不是判不出
  }

  // ③ 那天前十 → 它所在组里成员最多的那一段
  const day = boards.get(first.firstDate);
  const fam = pickOldTopicFamily(day.top10, name, {
    topicOf: o.topicOf, coreRes: o.coreRes, minCount: o.minCount
  });
  if (!fam.topic) {
    return Object.assign(withFirst, { reason: 'no-family', groups: fam.groups });
  }
  return Object.assign(withFirst, {
    ready: true,
    reason: 'first-leader-day',
    topic: fam.topic,
    rawTopic: fam.raw,
    count: fam.count,
    members: fam.members,
    groups: fam.groups
  });
}
