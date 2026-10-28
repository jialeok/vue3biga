// auction-presence.js — 「在列次数」预计算表 auction_presence 的唯一读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用途（用户 2026-10-23 口径）：
//   「10 日涨幅 toggle 前十 / 20 日涨幅 toggle 前十，在这 10（20）个交易日里在早盘竞价看板的
//     每日列表中出现过几次 —— 打上'5次在列''首次在列'，状态存表里，这样响应才快，
//     我会用这个出现次数做分析。」
//
// ⚠️ 为什么必须落表、⛔ 不能在前端现算：
//   现算要回读「窗口内每一天的 auction_watchlist」，那是 10~20 天的历史名单（一次几百到上千行），
//   每次切 toggle / 切日期都要再拉一遍；落表后前端只读**一行一票的结论**（≤ 400 行），
//   并且这张表还能被用户直接拿去做 SQL 分析（这正是他说的用途）。
//
// 表结构（db/create_auction_presence.sql）：
//   (date, window_days, stock) 主键，一行 = 「某日在某窗口下的某只票」；
//   cnt = 窗口内（含当天）该票在 watchlist 里出现的天数；covered_days = 窗口内实际有名单的天数。
//   写入方 = Postgres 函数 recompute_auction_presence（pg_cron 09:30 / 15:05 各跑一次）。
//   ⚠️ 表里【只存 cnt >= 1 的票】：某只票在窗口内从没进过名单就根本没有行 ——
//      「查不到」≠「缺数据」，调用方按 cnt = 0 处理（见 presence-label.js 的注释）。
//
// §10 读取失败 ≠ 空数据：本模块失败一律 throw（绝不返回空 Map 冒充「这些票都没在列」）。
//   表可能还没建（用户尚未执行建表 SQL）⇒ 冷却 30s，避免每次切日期都白打一次注定失败的 REST。
// ══════════════════════════════════════════════════════════════════════════════════════

import { ref } from 'vue';
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** key = `${date}|${windowDays}` -> { counts: Map<stock,{cnt,dates}>, coveredDays, windowDays } */
const _cache = new Map();
/** 单飞：key -> Promise（同一天同一窗口并发读只发一次请求，§32） */
const _inflight = new Map();
/** 表不存在 / 无权限的冷却（30s） */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;

/**
 * 数据版本号：每次成功加载（或清空）都 +1。
 * incremental-view 用它做全局指纹 —— 数据到货 ⇒ 指纹变化 ⇒ 行缓存失效 ⇒ 标签显示出来。
 * 🔴 必须是 Vue `ref`：全局指纹在 `viewData` computed 里读它，裸 `let` 不建立依赖 ⇒
 *   数据到货后 computed 不重跑、标签永远不出现（2026-10-28 同款坑在 prev-rank-table 踩过）。
 */
const _version = ref(0);

/** 缓存上限（只保最近若干个 (日期,窗口)；切日期一般只会来回走几天） */
const CACHE_MAX = 12;

/** 清空会话缓存（仅供测试 / 换账户 / 切数据源） */
export function clearPresenceCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
  _version.value += 1;
}

/** 当前数据版本（进 incremental-view 的全局指纹；每次到货/清空都会变） */
export function getPresenceFingerprintToken() {
  return String(_version.value);
}

/**
 * 【同步读】取某日某窗口的「在列次数」结果（未加载 ⇒ null）。
 * ⛔ 本函数【不发请求】：取数由 ensurePresence 负责（语义与 getDragonRangePct / getRange20Pct 一致）。
 *
 * @param {string} date YYYY-MM-DD（= 看板当前日期 T）
 * @param {number} windowDays 10 / 20
 * @returns {{counts: Map<string,{cnt:number,dates:string}>, coveredDays:number, windowDays:number}|null}
 */
export function getPresenceForDate(date, windowDays) {
  const d = String(date || '').trim();
  const w = Number(windowDays) === 20 ? 20 : 10;
  if (!d) return null;
  const rec = _cache.get(d + '|' + w) || null;
  if (!rec) return null;
  // 「暂无预计算行」是【临时状态】（cron 可能马上就会写）⇒ 到期即视为未加载，重新去问一次
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  return rec;
}

function _putCache(key, rec) {
  _cache.set(key, rec);
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
  _version.value += 1;
}

/**
 * 真正发请求那一段。
 * 表里每个 (date, window_days) 一组，最多 ~400 行（10/20 个交易日的名单并集）⇒ 单次 ≤ 1000 行上限，
 * 无需分页（PostgREST 默认单响 1000 行）。
 *
 * @throws 读取失败时抛错（§10）
 */
async function _fetch(date, windowDays) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('auction_presence')
    .select('stock,cnt,covered_days,listed_dates')
    .eq('date', date)
    .eq('window_days', windowDays);
  if (error) throw error;
  const rows = data || [];
  if (rows.length === 0) {
    // 没有行 = 这天/这个窗口还没算过（cron 未跑或表刚建）⇒ 返回 null，由调用方按「数据未到」处理。
    // ⚠️ 这【不是】「所有票都没在列」：那需要 covered_days > 0 且查得到别人才成立。
    return null;
  }
  const counts = new Map();
  let coveredDays = 0;
  rows.forEach(function(r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    const n = Number(r.cnt);
    counts.set(name, {
      cnt: isFinite(n) && n >= 0 ? Math.floor(n) : 0,
      dates: r.listed_dates || ''
    });
    const cd = Number(r.covered_days);
    if (isFinite(cd) && cd > coveredDays) coveredDays = Math.floor(cd);
  });
  return { counts: counts, coveredDays: coveredDays, windowDays: windowDays };
}

/**
 * 【异步读】确保某日某窗口的「在列次数」已加载（会话缓存 + 单飞 + 失败冷却）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {number} windowDays 10 / 20
 * @returns {Promise<{counts: Map<string,{cnt:number,dates:string}>, coveredDays:number, windowDays:number}|null>}
 *          null = 该日该窗口还没有预计算结果（表为空）—— 调用方按「数据未到」处理，⛔ 不当作 0 次
 * @throws 读取失败（含表不存在）时抛错
 */
export async function ensurePresence(date, windowDays) {
  const d = String(date || '').trim();
  const w = Number(windowDays) === 20 ? 20 : 10;
  if (!d) return null;
  const key = d + '|' + w;
  const hit = _cache.get(key);
  if (hit) {
    if (!hit.expiresAt || Date.now() <= hit.expiresAt) return hit;
    _cache.delete(key);   // 空结果过期 ⇒ 重新问一次（cron 可能已写入）
  }
  const fly = _inflight.get(key);
  if (fly) return fly;
  if (Date.now() < _cooldownUntil) {
    throw new Error('在列次数读取冷却中（auction_presence 表可能尚未创建）');
  }
  const p = _fetch(d, w).then(function(rec) {
    if (!rec) {
      _dbgLog('[PRESENCE] ' + d + ' 窗口 ' + w + ' 天：暂无预计算行（cron 未跑 / 表未建），本次不标');
      // 记一个 60s 的「暂无」占位：避免同一会话反复白打 REST，又不至于把「还没有」缓存成永久
      _cache.set(key, { counts: null, coveredDays: 0, windowDays: w, expiresAt: Date.now() + 60000 });
      return null;
    }
    _putCache(key, rec);
    _dbgLog('[PRESENCE] ' + d + ' 窗口 ' + w + ' 天：' + rec.counts.size + ' 只票，覆盖 ' +
      rec.coveredDays + '/' + w + ' 天');
    return rec;
  }).catch(function(e) {
    // §10：失败必须抛（⛔ 不返回空结果）；进入冷却，避免反复白打
    _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
    throw e;
  }).finally(function() {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}
