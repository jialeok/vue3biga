// leader-rank-history.js — 「近 N 个交易日 · 每日竞价口径 20日涨幅榜」的原始行读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-11-12 原话，逐字保留）：
//   「要考究东方海洋的大类，首先要确定它老龙一霸榜的题材是什么，从第一次霸榜总龙一开始，
//     你检索下历史20个交易日，它第一次霸榜总龙一是不是在11月4日……」
//   「你在11月12日看来，这个就是作为老题材，你要检索下它20日涨幅，20个交易日第一次霸榜
//     总龙一的题材是什么，这个称为老题材，也就是羊字辈。」
// ⇒ 必须能回答「某一历史日期那天，谁排第 1」—— 这是【历史每日榜】的问题，前端内存里
//   只有当天那一份（切日期就换掉）⇒ 只能回库读近 20 个交易日的原始行。
//
// ── 为什么需要这个模块（不能只靠每次现读单日）──────────────────────────────────
//   单日读取器（`stock-range20-cache.js#readRange20Rows` / `market-metrics.js#readMarketMetricsForDate`）
//   每次只覆盖【一天】⇒ 回看 20 个交易日要发 20×2 = 40 个请求。本模块改成
//   **一次 `.in('date', dates)` 分页拉取** ⇒ 20 天只要 2~4 个请求（§32 禁止重复请求）。
//
// ── 职责边界 ─────────────────────────────────────────────────────────────────
//   · 本模块【只负责取原始行】：`stock_range20_pct` 的行 + `market_metrics(scope='auction')` 的行。
//   · ⛔ 不在这里挑腿 / 不在这里反解竞价口径 / 不在这里排队次 —— 那些全在
//     `logic/auction/range20-auction-leg.js#buildAuctionLegPctMap`（§6 唯一实现）
//     与 `logic/topicvolratio/tvrb-auction-board.js#buildTvrbAuctionBoard`（§6 唯一的榜口径）。
//   · ⛔ 不建表、不改表结构、不改 worker（§11）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────
//   §10 读取失败必须抛（⛔ 绝不返回空 Map 冒充「这些天都没有榜」）；
//       某天一行都没有 ⇒ 该天不出现在返回的 Map 里（上层据此算「实际覆盖了多少天」）。
//   §32 按【单日】缓存 + 单飞：同一天被两次窗口请求覆盖时只发一次；换展示日只补没读过的日期。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 单页行数（20 天 × ~120 只 ≈ 2400 行 ⇒ 分页拉，避免被 1000 行截断） */
const PAGE = 1000;
/** 防御性上限（正常远达不到） */
const MAX_ROWS = 40000;

/** date -> { rangeRows: Map<name,{pct,days,leg}>, metricRows: Array } */
const _cache = new Map();
/** 单飞：'d1,d2,...' -> Promise（同一批缺失日期并发只发一次请求） */
const _inflight = new Map();
/** 表不存在 / 无权限的冷却（30s）：避免每次切日期都白打一次注定失败的 REST */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;
/** 缓存上限（切日期一般只在几天内来回走；20 天窗口 × 十几天的来回足够） */
const CACHE_MAX = 120;

/** 清空会话缓存（仅供测试 / 换账户 / 切数据源） */
export function clearLeaderRankHistoryCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
}

/**
 * 读一批日期的「20日涨幅」原始行（两腿原样返回，挑腿交给上层）。
 * @param {string[]} dates
 * @returns {Promise<Map<string, Map<string,{pct:number,days:number,leg:string}>>>}
 */
async function _fetchRange20(dates) {
  const sb = getSupabase();
  const out = new Map();
  let from = 0;
  let guard = 0;
  for (;;) {
    const { data, error } = await sb
      .from('stock_range20_pct')
      .select('date,stock,pct,days,leg')
      .in('date', dates)
      .order('date', { ascending: true })
      .order('stock', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(function(r) {
      if (!r || !r.date || !r.stock) return;
      const d = String(r.date);
      const name = String(r.stock).trim();
      if (!name) return;
      const pct = Number(String(r.pct === null || r.pct === undefined ? '' : r.pct).replace('%', '').replace('+', ''));
      if (!isFinite(pct)) return;                 // §10 算不出的行不进榜（⛔ 不拿 0 冒充）
      if (!out.has(d)) out.set(d, new Map());
      const day = out.get(d);
      // 同一天两腿并存 ⇒ 都留着（上层按口径挑：`buildAuctionLegPctMap` 认 leg 字段）；
      // ⚠️ 这里【不做 close 优先】—— 那是「历史前五榜」的口径（range20-top5-history.js），
      //   本模块的消费者要的是【竞价口径】，必须看得到 leg='auc' 那一行。
      const prev = day.get(name);
      if (!prev || String(r.leg || '') === 'auc') {
        day.set(name, {
          pct: pct,
          days: Number(r.days) || 0,
          leg: String(r.leg || '')
        });
      }
    });
    if (rows.length < PAGE) break;
    from += PAGE;
    guard += rows.length;
    if (guard > MAX_ROWS) break;
  }
  return out;
}

/**
 * 读一批日期的 `market_metrics(scope='auction')` 行（竞价涨幅 / 收盘涨幅的【T 腿】来源）。
 * @param {string[]} dates
 * @returns {Promise<Map<string, Array<object>>>}
 */
async function _fetchMetrics(dates) {
  const sb = getSupabase();
  const out = new Map();
  let from = 0;
  let guard = 0;
  for (;;) {
    const { data, error } = await sb
      .from('market_metrics')
      .select('date,stock,code,change_pct,auc_pct_chg')
      .in('date', dates)
      .eq('scope', 'auction')
      .order('date', { ascending: true })
      .order('stock', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(function(r) {
      if (!r || !r.date || !r.stock) return;
      const d = String(r.date);
      if (!out.has(d)) out.set(d, []);
      out.get(d).push(r);
    });
    if (rows.length < PAGE) break;
    from += PAGE;
    guard += rows.length;
    if (guard > MAX_ROWS) break;
  }
  return out;
}

/**
 * ★ 读「近 N 个交易日 · 每日竞价口径榜」的【原始输入】（两表各一次分页拉取）。
 *
 * @param {string[]} dates YYYY-MM-DD（调用方只传交易日）
 * @returns {Promise<Map<string, {rangeRows: Map<string,{pct:number,days:number,leg:string}>,
 *                                metricRows: Array<object>}>>}
 *          只包含「真的读到了行」的日期（§10：某天没行 ⇒ 不出现在 Map 里，不伪造空结论）
 * @throws 读取失败时抛错（调用方据此【判不出】，⛔ 绝不返回空 Map 冒充「这些天都没有榜」）
 */
export async function readLeaderRankInputsForDates(dates) {
  const list = Array.from(new Set((dates || [])
    .map(function(d) { return String(d || '').trim(); })
    .filter(Boolean)));
  const out = new Map();
  if (list.length === 0) return out;

  // ① 会话缓存命中（缺什么才去读什么）
  const missing = [];
  list.forEach(function(d) {
    const hit = _cache.get(d);
    if (hit) out.set(d, hit);
    else missing.push(d);
  });
  if (missing.length === 0) return out;

  if (Date.now() < _cooldownUntil) {
    // 冷却期内确实缺数据 ⇒ 如实抛错（调用方判不出，⛔ 不拿「缓存里那几天」凑一个假结论）
    throw new Error('竞价口径历史榜读取冷却中（表可能尚未创建）');
  }

  const key = missing.slice().sort().join(',');
  let p = _inflight.get(key);
  if (!p) {
    p = Promise.all([_fetchRange20(missing), _fetchMetrics(missing)])
      .then(function(pair) {
        const rangeByDate = pair[0];
        const metricByDate = pair[1];
        const merged = new Map();
        // 以「有 20日涨幅行」的日期为骨架（没有 range20 行 ⇒ 这天算不出 20 日涨幅，
        // 与 rankMainBoardByPct 的「无值不参与排名」同口径）
        rangeByDate.forEach(function(rangeRows, d) {
          merged.set(d, { rangeRows: rangeRows, metricRows: metricByDate.get(d) || [] });
        });
        merged.forEach(function(v, d) { _cache.set(d, v); });
        while (_cache.size > CACHE_MAX) {
          const oldest = _cache.keys().next().value;
          if (oldest === undefined) break;
          _cache.delete(oldest);
        }
        _dbgLog('[LEADER-FIRST-TOPIC] 读到 ' + merged.size + '/' + missing.length +
          ' 天的原始行（' + (missing.length ? (missing[0] + '~' + missing[missing.length - 1]) : '-') + '）');
        return merged;
      })
      .catch(function(e) {
        // §10：失败必须抛；并进入冷却，避免切日期时反复白打
        _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
        throw e;
      })
      .finally(function() {
        if (_inflight.get(key) === p) _inflight.delete(key);
      });
    _inflight.set(key, p);
  }
  const got = await p;
  got.forEach(function(v, d) { out.set(d, v); });
  return out;
}
