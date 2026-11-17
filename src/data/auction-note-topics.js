// auction-note-topics.js — 「竞价名单某一天的题材串」的唯一读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么要这个模块（2026-11-17 · 第三十四条延伸 ABN-TB 的取数需求）
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户口径：「记住总龙一第一次监管异动……第三天不能买它题材的股票，比如东方海洋，
//     细分题材有(水产品,农业,东方,羊字辈)」。
//
//   这【四个】题材段从哪来？真实库里只有一处写全了它们：
//     `auction_watchlist.note`（2026-11-12）= `10.02%(水产品,农业,东方,羊字辈)`
//   ⛔ 不是共享题材库：`stock_topics` 里 东方海洋 = `水产品,农业`（缺 `东方 / 羊字辈`）——
//     而 `东方` 正是临时核心词（规则〇·a），只查库会漏掉它 ⇒ 日出东方被放行。
//   ⛔ 也不是 `auction_watchlist.topics`：11-12 那批行里该列是空串（库里实测）。
//
// ⇒ 本模块负责「按日期读回那一天每一行的 note / topics」，纯只读、零上游请求、不消耗猫抓额度。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   · §10：读取失败必须 throw（⛔ 不返回空 Map 冒充「这一天没有题材」）——
//     否则「第三天同题材监控」会静默变成「今天没有同题材」而放行，那正是本条要防的错。
//   · §32：按日期【会话内缓存 + 单飞】，同一天最多一次请求；失败不缓存。
//   · §26：只被「当前展示日的前 2 个交易日」用到，一次一读；切回同一日期直接命中缓存。
//   · ⚠️ 只取两列（note / topics）：这张表历史上被 worker 在盘后整行重写，
//     但 note 里的题材串是该日 9:25 写下的【当日事实】，不作为实时事实使用。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';

/** 会话内按日期缓存：date -> Map<股票名, {note:string, topics:string}>（引用稳定，§19） */
const _cache = new Map();
/** 单飞：date -> Promise<Map> */
const _inflight = new Map();
/** 缓存上限（只保最近若干个日期，与 stock-range-pct 同量级就够） */
const CACHE_MAX = 12;

function _putCache(date, map) {
  _cache.set(date, map);
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/**
 * 真正发请求那一段（成功才写缓存；失败原样抛出，§10 口径不变）。
 * @param {string} date
 * @returns {Promise<Map<string, {note:string, topics:string}>>}
 */
async function _fetch(date) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('auction_watchlist')
    .select('stock,note,topics')
    .eq('date', date);
  if (error) throw error;
  const map = new Map();
  (data || []).forEach(function(r) {
    if (!r || !r.stock) return;
    const nm = String(r.stock).trim();
    if (!nm) return;
    map.set(nm, {
      note: String(r.note === null || r.note === undefined ? '' : r.note).trim(),
      topics: String(r.topics === null || r.topics === undefined ? '' : r.topics).trim()
    });
  });
  return map;
}

/**
 * 读取某日【竞价名单】每行的 note / topics。
 *
 * ⚠️ 库内【没有这一天的行】⇒ 返回空 Map（那是「当天没有名单」这一确定事实）；
 *    【读失败】⇒ throw（由调用方降级并把缺口写进提示板，§10）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Map<string, {note:string, topics:string}>>}
 * @throws 读取失败
 */
export function readAuctionNoteTopicsForDate(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(new Map());
  const hit = _cache.get(d);
  if (hit) return Promise.resolve(hit);
  const fly = _inflight.get(d);
  if (fly) return fly;
  const p = _fetch(d).then(function(map) {
    _putCache(d, map);
    return map;
  }).finally(function() {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用） */
export function clearAuctionNoteTopicsCache() {
  _cache.clear();
  _inflight.clear();
}
