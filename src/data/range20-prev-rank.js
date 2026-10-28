// range20-prev-rank.js — 「昨日 20日涨幅名次」的唯一读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用途（用户 2026-10-28 口径，原话）：
//   「还有20日涨幅，你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，
//     比如+6，排名下降就用绿色，比如-7，也就是按照20日涨幅的排序，对比昨日排名情况进行标注，
//     其它不变。这个数值变化，也很重要，可以看出个股突破。」
// ⇒ 需要【昨日那一份 20日涨幅榜单】，才能算出「今天第几名 → 昨天第几名」。
//
// 数据源 = `stock_range20_pct`（既有结果表，⛔ 不新增任何表 / 不改任何表结构）。
//   该表每个 (date, stock) 一行，同一交易日可能同时有 leg='auc'（9:26 口径）与 leg='close'
//   （收盘口径）两行 ⇒ 同一天只认一腿（优先 'close'），否则同一只票会出现两次、名次重复计。
//   ⚠️ 与 range20-top5-history.js 读的是同一张表，但那个模块只回答「进没进前五」，
//      本模块要的是【完整名次】⇒ 各自独立缓存（key 不同、用途不同，⛔ 不互相借道）。
//
// §10 读取失败 ≠ 空数据：失败一律 throw，⛔ 绝不返回空 Map 冒充「昨天谁都没名次」。
//   表可能还没建 / 该历史日没有落库行 ⇒ 返回 null（= 数据未到），调用方按「判不出」显示 '—'。
// ══════════════════════════════════════════════════════════════════════════════════════

import { ref } from 'vue';
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 单日行数上限保护（当日名单一般 ≤ 200 行；分页拉取避免被 1000 行截断） */
const PAGE = 1000;
/** date -> { ranks: Map<stock, number>, pcts: Map<stock, number>, count: number, expiresAt: number } */
const _cache = new Map();
/** 单飞：date -> Promise（同一天并发读只发一次请求，§32） */
const _inflight = new Map();
/** 表不存在 / 无权限的冷却（30s）：避免每次切 toggle 都白打一次注定失败的 REST */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;
/** 缓存上限（切日期一般只在几天内来回走） */
const CACHE_MAX = 12;

/**
 * 数据版本号：每次成功加载 / 清空都 +1。
 * 用途 = incremental-view 的全局指纹 ⇒ 数据到货 ⇒ 行缓存失效 ⇒ 表格重算、名次变化显示出来。
 * ⚠️ 别改成「按日期拼指纹」：那样来回切日期会命中旧指纹，名次停在上一个日期的结果。
 * 🔴 必须用 Vue 的 `ref`（⛔ 不是裸 `let`）：全局指纹是在 `viewData` 这个 computed 里读的，
 *   裸变量不建立依赖 ⇒ 名次表到货后 computed 根本不会重跑 ⇒ 整列永远挂着 '—'
 *   （2026-10-28 实测踩到：请求发了、数据也进了缓存，屏幕上 50 行全是 '—'）。
 *   与 `logic/auction/range20.js` 的 `_state = ref({...})` 同一个道理（那边能实时刷数值就是靠这个）。
 *   ⚠️ 只让【版本号】响应式，⛔ 不要把 `_cache` 也摊成响应式 —— 那是一张上百条的表，
 *     深度追踪会让每次到货都付一次全表代理化的代价，而视图只需要「变了，重算」这一条信息。
 */
const _version = ref(0);

/** 清空会话缓存（仅供测试 / 换账户 / 切数据源） */
export function clearRange20PrevRankCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
  _version.value += 1;
}

/** 当前数据版本（进 incremental-view 的全局指纹） */
export function getRange20PrevRankFingerprintToken() {
  return String(_version.value);
}

/** 数值解析：'%' / '+' 兼容；空 / 非法 ⇒ null（⛔ 不返回 0） */
function _num(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isNaN(n) ? null : n;
}

/** 同一天两腿并存时取哪一行：'close'（当天最终值）优先，其次 'auc' */
function _preferLeg(prev, next) {
  if (!prev) return next;
  const rank = function(leg) { return String(leg || '') === 'close' ? 2 : (String(leg || '') === 'auc' ? 1 : 0); };
  return rank(next.leg) > rank(prev.leg) ? next : prev;
}

/**
 * 【同步读】取某个日期的 20日涨幅【完整名次表】（未加载 ⇒ null）。
 * ⛔ 本函数【不发请求】：取数由 ensureRange20PrevRank 负责。
 *
 * @param {string} date YYYY-MM-DD（= 上一交易日）
 * @returns {{ranks: Map<string, number>, pcts: Map<string, number>, count: number}|null}
 */
export function getRange20PrevRankForDate(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  const rec = _cache.get(d) || null;
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  return rec;
}

function _putCache(date, rec) {
  _cache.set(date, rec);
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
  _version.value += 1;
}

/**
 * 真正发请求那一段：读某日的全部 20日涨幅行 → 按 pct 降序编号（1 起）。
 * @throws 读取失败时抛错（§10）
 */
async function _fetch(date) {
  const sb = getSupabase();
  const byName = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('stock_range20_pct')
      .select('stock,pct,leg')
      .eq('date', date)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(function(r) {
      if (!r || !r.stock) return;
      const name = String(r.stock).trim();
      if (!name) return;
      const pct = _num(r.pct);
      if (pct === null) return;        // 算不出的行不进榜（§10 不拿 0 冒充）
      byName.set(name, _preferLeg(byName.get(name), { pct: pct, leg: String(r.leg || '') }));
    });
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 20000) break;           // 防御性上限（正常远达不到）
  }
  if (byName.size === 0) return null;  // 该日没有落库行 ⇒ 数据未到（⛔ 不是「都没名次」）

  // 名次 = 该日全部已落库股票按 pct 降序的位置；同值按股票名定序（与屏幕上排序的兜底一致）
  const list = Array.from(byName.entries())
    .map(function(e) { return { stock: e[0], pct: e[1].pct }; })
    .sort(function(a, b) { return (b.pct - a.pct) || String(a.stock).localeCompare(String(b.stock), 'zh'); });
  const ranks = new Map();
  const pcts = new Map();
  list.forEach(function(it, i) {
    ranks.set(it.stock, i + 1);
    pcts.set(it.stock, it.pct);
  });
  return { ranks: ranks, pcts: pcts, count: list.length };
}

/**
 * 【异步读】确保某个日期的 20日涨幅名次表已加载（会话缓存 + 单飞 + 失败冷却）。
 *
 * @param {string} date YYYY-MM-DD（= 上一交易日；由 Logic 层用交易日历算出后传入）
 * @returns {Promise<{ranks: Map<string,number>, pcts: Map<string,number>, count:number}|null>}
 *          null = 该日还没有落库行（数据未到）—— 调用方按「判不出」处理，⛔ 不当作「没名次」
 * @throws 读取失败（含表不存在）时抛错
 */
export async function ensureRange20PrevRank(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  const hit = _cache.get(d);
  if (hit && !(hit.expiresAt && Date.now() > hit.expiresAt)) return hit;
  if (_inflight.has(d)) return _inflight.get(d);
  if (Date.now() < _cooldownUntil) return null;

  const task = (async function() {
    try {
      const rec = await _fetch(d);
      if (rec) {
        _putCache(d, rec);
        return rec;
      }
      // 「该日没有行」是【临时状态】（补算 / worker 稍后会写入）⇒ 缓存 60s 后再问一次
      _putCache(d, { ranks: new Map(), pcts: new Map(), count: 0, expiresAt: Date.now() + 60000 });
      return null;
    } catch (e) {
      const code = (e && e.code) ? String(e.code) : '';
      const missing = code === '42P01' || /stock_range20_pct/i.test(String((e && e.message) || ''));
      if (missing) _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
      _dbgLog('[R20-DELTA] 读 ' + d + ' 的名次表失败: ' + ((e && e.message) || e));
      throw e;
    } finally {
      _inflight.delete(d);
    }
  })();
  _inflight.set(d, task);
  return task;
}
