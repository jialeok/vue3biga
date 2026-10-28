// range20-prev-rank.js — `stock_range20_pct` 单日【原始行】的读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用途（用户 2026-10-28 口径，原话）：
//   「还有20日涨幅，你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，
//     比如+6，排名下降就用绿色，比如-7，也就是按照20日涨幅的排序，对比昨日排名情况进行标注，
//     其它不变。这个数值变化，也很重要，可以看出个股突破。」
//   「早上可以用竞价口径，收盘时，用收盘口径，因为竞价时和收盘时会不同，不要搞混了。」
// ⇒ 需要【昨日那一份 20日涨幅榜单】，才能算出「今天第几名 → 昨天第几名」；
//   而且【竞价口径要和竞价口径比、收盘口径要和收盘口径比】（⛔ 不许今天竞价 vs 昨天收盘）。
//
// 职责边界（★ 2026-10-28 口径统一时收窄）：
//   · 本模块【只负责取原始行】：`readRange20PctRowsForDate(date)`。
//   · ⛔ 不在这里排队次 / 不选腿 / 不判口径 —— 那些全在 `logic/auction/prev-rank-table.js`
//     （「竞价口径」那一侧要绕道 `range20-auction-leg.js` 反解，属 Logic 层；
//      排队次的口径必须与它【同一个函数】，⛔ 不能 Data 一份、Logic 一份）。
//
// 数据源 = `stock_range20_pct`（既有结果表，⛔ 不新增任何表 / 不改任何表结构）。
//   该表每个 (date, stock) 一行，同一交易日可能同时有 leg='auc'（9:26 口径）与 leg='close'
//   （收盘口径）⇒ 原样交给上层，由上层按目标口径挑腿（⛔ 这里不替上层决定）。
//
// §10 读取失败 ≠ 空数据：失败一律 throw（上层据此「判不出」，⛔ 不显示成「都没名次」）；
//   该日一行都没有 ⇒ 返回 null（= 数据未到），⛔ 不返回空数组冒充「这天谁都没名次」。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 单页行数（该日一般 ≤ 300 行；分页拉取避免被 1000 行截断） */
const PAGE = 1000;
/** date -> { rows: Array<{stock,pct,leg}>|null, expiresAt: number } */
const _cache = new Map();
/** 单飞：date -> Promise（同一天并发读只发一次请求，§32） */
const _inflight = new Map();
/** 表不存在 / 无权限的冷却（30s）：避免每次切 toggle 都白打一次注定失败的 REST */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;
/** 缓存上限（切日期一般只在几天内来回走） */
const CACHE_MAX = 12;
/**
 * 缓存存活时间（5 分钟）。
 * 为什么要 TTL（与其它缓存模块的差异）：这张表是【当天还在长】的 —— 收盘后 worker 会把
 * leg='close' 那批写进来。若一条记录永久缓存，「早上先看一次、收盘后再看」就会一直拿到
 * 只有 auc 腿的旧快照。5 分钟足够便宜（一次 REST），又不会让用户等到手动刷新。
 */
const TTL_MS = 5 * 60 * 1000;

function _put(d, rows) {
  _cache.set(d, { rows: rows, expiresAt: Date.now() + TTL_MS });
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/**
 * 取某日的【全部原始行】（两腿原样返回，由上层按口径挑）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<{stock:string, pct:string|number|null, leg:string}>|null>}
 *          null = 该日没有任何落库行（数据未到）
 * @throws 读取失败（表不存在 / 无权限 / 网络）—— 调用方按 §10「判不出」处理，⛔ 不要吞成空
 */
export async function readRange20PctRowsForDate(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  const hit = _cache.get(d);
  if (hit && Date.now() <= hit.expiresAt) return hit.rows;
  if (_inflight.has(d)) return _inflight.get(d);
  if (Date.now() < _cooldownUntil) return null;

  const task = (async function() {
    try {
      const sb = getSupabase();
      const rows = [];
      let from = 0;
      for (;;) {
        const { data, error } = await sb
          .from('stock_range20_pct')
          .select('stock,pct,leg')
          .eq('date', d)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const batch = data || [];
        for (let i = 0; i < batch.length; i++) rows.push(batch[i]);
        if (batch.length < PAGE) break;
        from += PAGE;
        if (from > 20000) break;            // 防御性上限（正常远达不到）
      }
      if (rows.length === 0) {
        _put(d, null);                      // 「这天还没有行」也是短时状态，TTL 后再问
        return null;
      }
      _put(d, rows);
      return rows;
    } catch (e) {
      const code = (e && e.code) ? String(e.code) : '';
      const missing = code === '42P01' || /stock_range20_pct/i.test(String((e && e.message) || ''));
      if (missing) _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
      _dbgLog('[R20-PREV] 读 ' + d + ' 的 20日涨幅行失败: ' + ((e && e.message) || e));
      throw e;                              // §10：⛔ 不缓存、⛔ 不吞成「没有数据」
    } finally {
      _inflight.delete(d);
    }
  })();
  _inflight.set(d, task);
  return task;
}

/** 清空会话缓存（仅供测试 / 换账户 / 换数据源） */
export function clearRange20PrevRankCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
}
