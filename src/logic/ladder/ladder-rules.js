// ladder-rules.js — 「连板天梯晋级」看板的核心规则（Logic 层纯函数，§15 独立业务模块 / §21 模板零计算）
//
// 本文件【只有纯函数】：不读 state、不发请求、不碰 DOM、不 import 任何 store。
// 所有输入输出都是普通对象/数组 → 可单测，后期加规则只动这一个文件。
//
// ── 产品口径（2026-09-24 用户原话整理；后期还会继续完善，刻意做成可配置的常量）──
//
// 【入选】只看早盘竞价 9:25 抓到的当日列表，挑出【二板及以上】的股票（首板/趋势不进本看板）。
//         连板数 streak 的判定 = 前 9 个历史交易日（不含当天）的连续收盘涨停天数，
//         与早盘竞价行内那个「二板/三板」灰标【同源】（limit-streak.js，§6）。
//
// 【分组】按连板数分档，档位条上标数量，例如：
//            三板  8
//         档位排序 = 连板数【降序】（高板在上，天梯从顶往下走）。
//
// 【行内】序号  股票名称  [高开/低开/平开标]  十日涨幅  题材  晋级
//         · 高开 / 低开 / 平开 = 当日【竞价涨幅】方向（>0 红 / <0 绿 / =0 灰；缺数据不出标）
//           与早盘竞价龙标底色同一口径（AuctionDragonBadge 的 pctChg）。
//         · 题材 = 早盘竞价「题材 toggle」那套主题材（完整展示、允许折行，不截断）。
//
// 【晋级】三态（⛔ 不做二值硬猜，§10「还没到收盘」≠「晋级失败」）：
//         ① 已到权威收盘口径（收盘后覆盖过涨幅）→ 收盘涨停 = 成功（红），否则 = 失败（绿）；
//         ② 未到收盘口径 但【竞价一字】（9:25 直接封板）→ 先算【成功】（红）—— 用户口径；
//         ③ 未到收盘口径 且 不是一字 → 【待定】（灰），等收盘覆盖涨幅后再定。
//
// 【§10 红线】任何一段数据缺失 → 该段【不产出】（返回空 / 不给出结论），
//   绝不用 0 / '-' / 空字符串伪装成「有数据」。

import { getStreakLabel } from '../auction/limit-streak.js';

/** 进本看板的最低连板数（用户口径：二连板及以上） */
export const LADDER_MIN_STREAK = 2;

/** 竞价开平方向：与早盘竞价龙标底色同一口径（涨红跌绿平灰） */
export const AUC_OPEN_HIGH = 'high';
export const AUC_OPEN_LOW = 'low';
export const AUC_OPEN_FLAT = 'flat';

/** 晋级三态 */
export const PROMOTE_SUCCESS = 'success';
export const PROMOTE_FAIL = 'fail';
export const PROMOTE_PENDING = 'pending';

const OPEN_TEXT = {};
OPEN_TEXT[AUC_OPEN_HIGH] = '高开';
OPEN_TEXT[AUC_OPEN_LOW] = '低开';
OPEN_TEXT[AUC_OPEN_FLAT] = '平开';

const PROMOTE_TEXT = {};
PROMOTE_TEXT[PROMOTE_SUCCESS] = '晋级成功';
PROMOTE_TEXT[PROMOTE_FAIL] = '晋级失败';
PROMOTE_TEXT[PROMOTE_PENDING] = '待定';

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 竞价开平方向。
 * ⛔ null = 缺竞价涨幅数据 → 调用方必须【不出标】（§10：缺数据 ≠ 平开）。
 * @param {number|null} aucPct 当日竞价涨幅（%）
 * @returns {'high'|'low'|'flat'|null}
 */
export function getAucOpenKind(aucPct) {
  const n = _num(aucPct);
  if (n === null) return null;
  if (n > 0) return AUC_OPEN_HIGH;
  if (n < 0) return AUC_OPEN_LOW;
  return AUC_OPEN_FLAT;
}

/** 开平标记文案；null（缺数据）→ 空串（模板不渲染） */
export function getAucOpenText(kind) {
  return kind ? (OPEN_TEXT[kind] || '') : '';
}

/**
 * 晋级判定（唯一实现；后期改规则只改这里）。
 *
 * @param {{isYiZi:boolean, closeLimit:'up'|'down'|null, closeReady:boolean}} row
 *        isYiZi      = 9:25 竞价一字（竞价涨幅已达涨停幅度）
 *        closeLimit  = 当日收盘停板状态（'up' 涨停 / 'down' 跌停 / null 未达板 或 缺数据）
 *        closeReady  = 该日是否已进入【权威收盘口径】（收盘涨幅已覆盖过，可信）
 * @returns {'success'|'fail'|'pending'}
 */
export function judgePromotion(row) {
  const r = row || {};
  // ① 收盘口径已成立 → 收盘说了算：涨停 = 晋级成功，没封住 = 晋级失败
  if (r.closeReady) return r.closeLimit === 'up' ? PROMOTE_SUCCESS : PROMOTE_FAIL;
  // ② 早盘阶段：竞价一字（9:25 就封板）先算成功（用户口径）
  if (r.isYiZi) return PROMOTE_SUCCESS;
  // ③ 早盘阶段且不是一字 → 还没走完，不猜
  return PROMOTE_PENDING;
}

/** 晋级文案 */
export function getPromoteText(state) {
  return PROMOTE_TEXT[state] || '';
}

// ── 「题材连扳」模式（2026-09-24 需求）：按【题材】分组看「连板梯队的完整性」──
//
// ⚠️ 完整性 = 有【连续】的板数连在一起，且这段连续板数至少 3 档。
//    只看「一共有几个不同层级」是不够的（旧实现就是只看层级数，已被用户否掉）。
//
// 用户口径（2026-09-24 原话整理）：
//   · 二板 + 三板 + 四板            ⇒ 最长连续 3 档 ⇒ 完整
//   · 三板 + 四板                    ⇒ 最长连续 2 档 ⇒ ⛔ 不完整（两个连在一起也不行）
//   · 二板 + 三板 + 三板 + 四板      ⇒ 去重后 二/三/四 ⇒ 连续 3 档 ⇒ 完整
//   · 四板 + 五板 + 六板             ⇒ 连续 3 档 ⇒ 完整
//   · 二板 + 四板 + 五板 + 六板      ⇒ 最长连续 4/5/6 = 3 档 ⇒ 完整（不管多少只，连在一起就行）
//   · 二板 + 四板                    ⇒ 没有任何连续段 ⇒ 不完整

/** 算「成梯队」要求的最长【连续】板数（用户口径：连续 3 档才算梯队完整） */
export const LADDER_MIN_RUN = 3;

/**
 * 最长连续板数：输入一组（可重复、可乱序的）连板数，返回最长「相邻 +1」连续段的长度。
 *   [2,4,5,6] → 3（4/5/6）；[3,4] → 2；[2,3,4] → 3；[2,2,3,4] → 3（重复数先去重）
 * ⛔ 这是「梯队是否完整」的唯一判据实现（§6），不要在别处再写一遍。
 * @param {Iterable<number>|Array<number>} levels
 * @returns {number} 最长连续段长度（空输入 → 0）
 */
export function longestConsecutiveRun(levels) {
  const arr = (levels instanceof Set)
    ? Array.from(levels)
    : (Array.isArray(levels) ? levels.slice() : []);
  const nums = [];
  for (const v of arr) {
    const n = Math.floor(Number(v));
    if (isFinite(n) && nums.indexOf(n) < 0) nums.push(n);
  }
  if (nums.length === 0) return 0;
  nums.sort(function(a, b) { return a - b; });
  let best = 1;
  let cur = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/**
 * 行对象组装（groupByStreak / groupByTopicLadder 共用，§6 单一实现）。
 * @returns {object} 模板可直接渲染的一行
 */
function _buildRow(m, seq, closeReady) {
  const s = Math.floor(Number(m.streak));
  const openKind = getAucOpenKind(m.aucPct);
  const promote = judgePromotion({
    isYiZi: !!m.isYiZi,
    closeLimit: m.closeLimit || null,
    closeReady: closeReady
  });
  return {
    seq: seq,
    name: m.name,
    streak: s,
    streakLabel: getStreakLabel(s),
    aucPct: _num(m.aucPct),
    aucOpen: openKind,
    aucOpenText: getAucOpenText(openKind),
    pct: _num(m.pct),
    topic: m.topic || '',
    isYiZi: !!m.isYiZi,
    promote: promote,
    promoteText: getPromoteText(promote)
  };
}

/** 档内排序：连板数降序 → 十日涨幅降序（缺失排最后）→ 股票名稳定 */
function _sortMembers(arr) {
  return arr.slice().sort(function(a, b) {
    const sa = Math.floor(Number(a.streak));
    const sb = Math.floor(Number(b.streak));
    if (sa !== sb) return sb - sa;
    const pa = _num(a.pct);
    const pb = _num(b.pct);
    const ra = (pa === null ? Number.MIN_SAFE_INTEGER : pa);
    const rb = (pb === null ? Number.MIN_SAFE_INTEGER : pb);
    if (ra !== rb) return rb - ra;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
}

/** 题材组（或档位）内通用的「二板及以上」过滤器 */
function _filterLadder(rows) {
  return (rows || []).filter(function(r) {
    return r && r.name && _num(r.streak) !== null && _num(r.streak) >= LADDER_MIN_STREAK;
  });
}

/**
 * 按连板数分档（只保留二板及以上）。
 *
 * @param {Array<{name:string, streak:number, topic:string, aucPct:number|null, pct:number|null,
 *                isYiZi:boolean, closeLimit:string|null}>} rows
 * @param {{closeReady?:boolean}} [opts] closeReady = 该日是否已到权威收盘口径
 * @returns {Array<{streak:number, label:string, count:number, rows:Array}>}
 *          档位按连板数【降序】；档内按十日涨幅降序（涨幅缺失排最后），保证「谁最强」一眼可见。
 */
export function groupByStreak(rows, opts) {
  const closeReady = !!(opts && opts.closeReady);
  const list = _filterLadder(rows);
  if (list.length === 0) return [];

  const byStreak = new Map();
  list.forEach(function(r) {
    const s = Math.floor(Number(r.streak));
    if (!byStreak.has(s)) byStreak.set(s, []);
    byStreak.get(s).push(r);
  });

  const groups = [];
  Array.from(byStreak.keys())
    .sort(function(a, b) { return b - a; })          // 高板在上
    .forEach(function(s) {
      const members = _sortMembers(byStreak.get(s));
      groups.push({
        streak: s,
        label: getStreakLabel(s),
        count: members.length,
        rows: members.map(function(m, i) { return _buildRow(m, i + 1, closeReady); })
      });
    });
  return groups;
}

/**
 * 按【题材】分组看连板梯队（「题材连扳」toggle 打开时用）。
 *
 * 完整性判据（唯一实现 `longestConsecutiveRun`，§6）：
 *   最长的【连续板数】≥ LADDER_MIN_RUN(3) ⇒ 梯队完整。
 *   例：二/三/四 = 连续 3 档 ⇒ 完整；三/四 = 连续 2 档 ⇒ 不完整；
 *       二/四/五/六 ⇒ 最长连续 4-5-6 = 3 档 ⇒ 完整。
 *
 * @param {Array} rows - 与 groupByStreak 同一份 rows
 * @param {{closeReady?:boolean, otherTopic?:string}} [opts]
 * @returns {Array<{topic:string, levelCount:number, levelText:string, levelDetail:string,
 *                  runLength:number, runText:string, isComplete:boolean, completeText:string,
 *                  hintText:string, count:number, rows:Array}>}
 *          题材排序：最长连续板数降序 → 层级数降序 → 股票数降序 → 题材名（'其它'永远置底）；
 *          题材内行序：连板数降序 → 十日涨幅降序（天梯从顶往下走）。
 */
export function groupByTopicLadder(rows, opts) {
  const o = opts || {};
  const closeReady = !!o.closeReady;
  const otherTopic = o.otherTopic || '其它';
  const list = _filterLadder(rows);
  if (list.length === 0) return [];

  // ① 按题材归堆（一只票只落一个题材：与早盘竞价题材 toggle 同源的 getPrimaryTopicMap 已保证）
  const byTopic = new Map();
  list.forEach(function(r) {
    const tp = r.topic || otherTopic;
    if (!byTopic.has(tp)) byTopic.set(tp, []);
    byTopic.get(tp).push(r);
  });

  // ② 每个题材：算层级数 + 最长连续板数 + 组内按天梯顺序排
  const groups = [];
  byTopic.forEach(function(members, topic) {
    const levels = new Set();
    members.forEach(function(m) { levels.add(Math.floor(Number(m.streak))); });
    const sorted = _sortMembers(members);
    const levelList = Array.from(levels).sort(function(a, b) { return b - a; });
    const levelDetail = levelList.map(function(s) { return getStreakLabel(s); }).join('/');
    const runLength = longestConsecutiveRun(levels);
    const isComplete = runLength >= LADDER_MIN_RUN;
    const completeText = isComplete ? '梯队完整' : '未成梯队';
    groups.push({
      topic: topic,
      levelCount: levels.size,
      levelText: levels.size + '档',
      // 层级明细（四板/三板/二板）：给标题 hover 用，一眼看出这个题材占了哪几级
      levelDetail: levelDetail,
      runLength: runLength,
      runText: '连' + runLength + '档',
      isComplete: isComplete,
      completeText: completeText,
      // §21：hover 说明也在 Logic 层拼好，模板只渲染
      hintText: topic + ' 有 ' + levels.size + ' 个连板档（' + levelDetail + '），'
        + '最长连续 ' + runLength + ' 档（连续满 ' + LADDER_MIN_RUN + ' 档才算完整）',
      count: sorted.length,
      rows: sorted.map(function(m, i) { return _buildRow(m, i + 1, closeReady); })
    });
  });

  // ③ 题材顺序：连续板数多的在前（梯队最完整的题材最值得先看）→ 层级数 → 股票数 → 题材名；「其它」置底
  groups.sort(function(a, b) {
    if (a.topic === otherTopic && b.topic !== otherTopic) return 1;
    if (b.topic === otherTopic && a.topic !== otherTopic) return -1;
    if (b.runLength !== a.runLength) return b.runLength - a.runLength;
    if (b.levelCount !== a.levelCount) return b.levelCount - a.levelCount;
    if (b.count !== a.count) return b.count - a.count;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });
  return groups;
}

/**
 * 总数量（看板头部摘要用）。
 */
export function countLadder(groups) {
  return (groups || []).reduce(function(n, g) { return n + g.count; }, 0);
}

/**
 * 数值 → 展示文本（§21：格式化在 Logic 层做完，模板只负责渲染）。
 * 缺失一律返回 ''（§10 绝不补 0 / '-'）。
 */
export function formatRangePct(pct) {
  const n = _num(pct);
  if (n === null) return '';
  return (n >= 0 ? '+' : '') + String(Math.round(n)) + '%';
}

/**
 * 趋势序列组装（供给 TrendChart 的 points）。
 * ⛔ 只在【有数据】时返回该条腿；全空 → 该腿不渲染（§10 不画一条全空的线充数）。
 *
 * @param {Array<{date:string, volume?:*, yestVolume?:*, aucPctChg?:*, changePct?:*}>} history
 * @returns {{volume:Array, yestVolume:Array, aucPctChg:Array|null, changePct:Array|null}}
 */
export function buildTrendSeries(history) {
  const h = Array.isArray(history) ? history : [];
  const series = {
    volume: h.map(function(x) { return { date: x.date, value: _num(x.volume) }; }),
    yestVolume: h.map(function(x) { return { date: x.date, value: _num(x.yestVolume) }; }),
    aucPctChg: h.map(function(x) { return { date: x.date, value: _num(x.aucPctChg) }; }),
    changePct: h.map(function(x) { return { date: x.date, value: _num(x.changePct) }; })
  };
  return series;
}

/** 某条腿是否有任一有效点（用于决定渲不渲染这张图） */
export function hasSeriesData(points) {
  return Array.isArray(points) && points.some(function(p) { return p && p.value !== null; });
}
