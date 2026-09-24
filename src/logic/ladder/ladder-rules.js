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
  const list = (rows || []).filter(function(r) {
    return r && r.name && _num(r.streak) !== null && _num(r.streak) >= LADDER_MIN_STREAK;
  });
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
      const members = byStreak.get(s).slice().sort(function(a, b) {
        const pa = _num(a.pct);
        const pb = _num(b.pct);
        const ra = (pa === null ? Number.MIN_SAFE_INTEGER : pa);
        const rb = (pb === null ? Number.MIN_SAFE_INTEGER : pb);
        if (ra !== rb) return rb - ra;                // 十日涨幅降序
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      });
      groups.push({
        streak: s,
        label: getStreakLabel(s),
        count: members.length,
        rows: members.map(function(m, i) {
          const openKind = getAucOpenKind(m.aucPct);
          const promote = judgePromotion({
            isYiZi: !!m.isYiZi,
            closeLimit: m.closeLimit || null,
            closeReady: closeReady
          });
          return {
            seq: i + 1,
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
        })
      });
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
