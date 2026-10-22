// range20-top5-history.js — 「20日涨幅前五」【历史每日榜单】的唯一读取入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-22 原话）：
//   「20个交易日内，上述的时间点这只股票名称有没有上榜？今天是不是首次20日涨幅上榜前五？
//     如果是，看下一个条件，是不是和和老龙一是不是同个题材，如果不是，说明这是个新龙……
//     规则要添加下：只选20日涨幅排名前五题材，没有出现过的新龙。」
// ⇒ 「首次上榜」只能拿【历史每天的榜】来比，所以这里要把近 N 个交易日的每日前五读回来。
//
// 数据源 = `stock_range20_pct`（既有结果表，⛔ 不新增任何表 / 不改任何表结构）。
//   该表每个 (date, stock) 一行，带 pct 与 leg；同一日期可能同时存在 leg='auc'（9:25 口径）
//   与 leg='close'（收盘口径）两行 ⇒ 本模块**同一天只认一腿**（优先 'close'，见 _preferLeg），
//   否则同一只票会出现两次、名次也会重复计算。
//
// ⚠️ 为什么不在前端内存里算：本判定要的是【过去 20 天】，而 range20.js 的内存缓存只保留
//   当前日的结果（切日期就换掉了）⇒ 必须回库读（一次 in 查询，§32 相同数据只请求一次）。
//
// ⚠️ 覆盖度如实上报：「近 20 个交易日」在系统里可能只有 n 天有落库行（该能力 2026-10-12 才上线）。
//   本模块返回 `days`（真正拿到榜的天数），规则层把它写进说明文案 ——
//   ⛔ 绝不假装「查过 20 天都没上榜」（§10：能不能 vs 有没有，必须分开说）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 前五（用户口径固定五只；与 range20-top5-label.js#RANGE20_TOTAL_DRAGON_TOP_N 同值） */
export const TOP5_HISTORY_N = 5;

/** date -> Map<stock, {pct:number, leg:string}>（会话缓存：历史日的榜不会再变，§32 不重复请求） */
const _cache = new Map();
/** 单飞：`date1,date2,...` -> Promise（同一批日期并发读只发一次请求） */
const _inflight = new Map();
/** 表不存在 / 无权限的冷却（30s）：避免每次切日期都白打一次注定失败的 REST */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;

/** 清空会话缓存（仅供测试 / 换账户 / 切数据源） */
export function clearTop5HistoryCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
}

/** 数值解析：'%' / '+' 兼容；空 / 非法 ⇒ null（⛔ 不返回 0） */
function _num(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isNaN(n) ? null : n;
}

/**
 * 同一天两腿并存时取哪一行：'close'（收盘口径 = 当天最终值）优先，其次 'auc'。
 * ⚠️ 只影响「历史榜」的取数，不影响任何展示口径（本模块只输出【名字清单】）。
 */
function _preferLeg(prev, next) {
  if (!prev) return next;
  const rank = function(leg) { return String(leg || '') === 'close' ? 2 : (String(leg || '') === 'auc' ? 1 : 0); };
  return rank(next.leg) > rank(prev.leg) ? next : prev;
}

/**
 * 读一批日期的「20日涨幅」原始行并整理成 date -> Map<stock, {pct, leg}>。
 *
 * @param {string[]} dates YYYY-MM-DD 列表（调用方只传交易日）
 * @returns {Promise<Map<string, Map<string, {pct:number, leg:string}>>>}
 * @throws 读取失败时抛错（§10：⛔ 绝不返回空 Map 冒充「这些天都没有榜」）
 */
async function _fetch(dates) {
  const list = Array.from(new Set((dates || []).map(function(d) { return String(d || '').trim(); }).filter(Boolean)));
  const out = new Map();
  if (list.length === 0) return out;
  const sb = getSupabase();
  // 一次 in 查询取全部日期（§32：同一天不会打两次；单次响应上限 1000 行，20 天 × ~80 只 ≈ 1600
  // ⇒ 分页拉取，避免「只拿到前 1000 行」把后面的日期截掉 —— 那会让「首次上榜」被判错）。
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('stock_range20_pct')
      .select('date,stock,pct,leg')
      .in('date', list)
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(function(r) {
      if (!r || !r.date || !r.stock) return;
      const d = String(r.date);
      const name = String(r.stock).trim();
      if (!name) return;
      const pct = _num(r.pct);
      if (pct === null) return;      // 算不出的行不进榜（§10 不拿 0 冒充）
      if (!out.has(d)) out.set(d, new Map());
      const day = out.get(d);
      day.set(name, _preferLeg(day.get(name), { pct: pct, leg: String(r.leg || '') }));
    });
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 20000) break;         // 防御性上限（正常远达不到）
  }
  return out;
}

/**
 * 读「近 N 个交易日的每日 20日涨幅前五」。
 *
 * @param {string[]} dates 需要覆盖的交易日（升序或乱序都行；调用方负责给出交易日口径）
 * @param {{topN?:number}} [opts]
 * @returns {Promise<{byDate: Map<string, string[]>, days: number, dates: string[]}>}
 *          byDate = 日期 -> 该日前五【股票名】（按 pct 降序，最多 topN 只）；
 *          days   = 真正拿到榜的天数（用于说明「窗口覆盖了多少天」）；
 *          dates  = 实际有榜的日期（升序）
 * @throws 读取失败时抛错（调用方据此【判不出】⇒ 规则不生效 + 说明可见）
 */
export async function readTop5History(dates, opts) {
  const o = opts || {};
  const topN = (Number(o.topN) > 0) ? Math.floor(Number(o.topN)) : TOP5_HISTORY_N;
  const key = (dates || []).slice().sort().join(',') + '|' + topN;
  const hit = _cache.get(key);
  if (hit) return hit;
  const fly = _inflight.get(key);
  if (fly) return fly;
  if (Date.now() < _cooldownUntil) {
    // 冷却期内直接如实报错（不返回空结论）—— 调用方按「判不出」处理
    throw new Error('20日涨幅历史榜读取冷却中（表可能尚未创建）');
  }
  const p = _fetch(dates).then(function(raw) {
    const byDate = new Map();
    const got = [];
    raw.forEach(function(day, d) {
      const arr = [];
      day.forEach(function(v, name) { arr.push({ name: name, pct: v.pct }); });
      arr.sort(function(a, b) {
        if (b.pct !== a.pct) return b.pct - a.pct;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);   // 并列时稳定（可复现）
      });
      byDate.set(d, arr.slice(0, topN).map(function(x) { return x.name; }));
      got.push(d);
    });
    got.sort();
    const res = { byDate: byDate, days: got.length, dates: got };
    _cache.set(key, res);
    _dbgLog('[RANGE20-TOP5-HIST] 读到 ' + got.length + '/' + (dates || []).length + ' 天的榜（' +
      (got.length ? (got[0] + '~' + got[got.length - 1]) : '-') + '）');
    return res;
  }).catch(function(e) {
    // §10：失败必须抛（⛔ 不返回空结论）；并进入冷却，避免切日期时反复白打
    _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
    throw e;
  }).finally(function() {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}

/**
 * 把 byDate 展开成「近窗口内上过前五的股票名集合」（判定「首次上榜」的输入）。
 * ⛔ 纯函数：不在规则层再遍历一遍 Map（§6 同一实现）。
 *
 * @param {{byDate: Map<string, string[]>}|null} hist readTop5History 的返回
 * @returns {Set<string>}
 */
export function everInTop5Set(hist) {
  const set = new Set();
  if (!hist || !hist.byDate) return set;
  hist.byDate.forEach(function(names) {
    (names || []).forEach(function(n) { if (n) set.add(String(n).trim()); });
  });
  return set;
}
