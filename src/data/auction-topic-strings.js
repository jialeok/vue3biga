// auction-topic-strings.js — 「竞价名单里那些写着题材串的字段」的唯一读写入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么要这个模块（2026-11-17 · 用户口径）
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户原话：「我希望我删除核心词后，连同同义词一起删除，之前有过同义词的股票的题材窜中的
//     同义词也一起删除，也就是早盘竞价看板的股票双击竞价量出来的那个 note 字段和单击昨日成交量列
//     显示的那个 toast，也要把对应的同义词删除，其它题材窜要保留，这个特别注意，不要误删，也不要错删」
//
//   ⇒ 删除一个核心词时，除了 `stock_topics`（共享题材库，已有 core-word-purge.js 负责），
//     还必须同时清理 **`auction_watchlist` 上两列**：
//       · `note`   —— `10.02%(水产品,农业,东方,羊字辈)`（双击竞价量 / 单击昨成交量的 toast 都读它）
//       · `topics` —— `水产品,农业,东方,羊字辈`（行内题材列 / 题材 toggle 分组读它）
//     否则会出现用户看到的那种「核心词都删了，弹出来还是四个题材」。
//
// ── 口径（与 stock_topics 那套完全一致，⛔ 不另立一套）──────────────────────────────
//   · 只删【整段完全相等】的题材段（忽略首尾空白与大小写）；
//   · 其余题材段原样保留、顺序不变；
//   · ⛔ 绝不按子串连坐（删「稀土」不能把「稀土永磁」删掉）、⛔ 绝不整行清空（§11）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10：读取失败必须 throw（⛔ 不返回空数组冒充「没有行」）—— 否则上层会在「没读到」的基础上
//      宣布「已清理干净」，正是 §11 禁止的形态。
//   §11：本模块只做「按 (date,stock) 精确改写 note/topics 两列」，⛔ 不 delete、⛔ 不碰
//      `change_pct`（历史日的 change_pct 是当日真实竞价涨幅，写它会污染十日涨幅等派生指标）。
//   §32：按 token 服务端过滤（ilike）而不是整表拉 1.7 万行；同一 token 只查 note / topics 各一次。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';
import { fetchAllPages } from './paged-fetch.js';
import { upsertBucketed } from './upsert-buckets.js';
import { state } from '../logic/app-state.js';
import { _dbgLog } from './debug-log.js';

/** 只取这四列：够算出「哪一段要删」与「删完长什么样」，⛔ 不取 change_pct / volume（无关且易被误写） */
const COLS = 'date,stock,note,topics';

function _norm(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

function _keyOf(date, stock) {
  return String(date || '').trim() + '|' + _norm(stock);
}

/**
 * 按「核心词 / 同义词」把库里【可能含这些词】的行读回来（服务端 ilike 粗筛，精确等值判定留给 Logic 层）。
 *
 * ⚠️ 粗筛是「包含」⇒ 一定多读（例如删「东方」会把「东方通信」的行也读回来），
 *    这是刻意为之：多读只是多算几行，**漏读会让残留留在库里**（那正是用户抱怨的现象）。
 *
 * @param {string[]} tokens 核心词 + 同义词
 * @returns {Promise<Array<{date:string, stock:string, note:string, topics:string}>>}
 * @throws 任一次读取失败
 */
export async function readAuctionRowsByTopicTokens(tokens) {
  const list = Array.isArray(tokens) ? tokens.map(_norm).filter(Boolean) : [];
  if (list.length === 0) return [];
  const sb = getSupabase();
  const byKey = new Map();
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    const pattern = '%' + tok + '%';
    // note 与 topics 分两次查：单值过滤不需要 PostgREST 的 or=(...) 语法 ⇒ token 里带逗号/括号也不会把过滤串拼坏
    for (const col of ['note', 'topics']) {
      const rows = await fetchAllPages(function() {
        return sb.from('auction_watchlist')
          .select(COLS)
          .ilike(col, pattern)
          // ⚠️ 分页必须有稳定顺序（paged-fetch.js 顶部说明）：否则边界行可能重复/漏读
          .order('date', { ascending: true })
          .order('stock', { ascending: true });
      }, { concurrency: 4 });
      (rows || []).forEach(function(r) {
        if (!r || !r.stock || !r.date) return;
        const key = _keyOf(r.date, r.stock);
        if (byKey.has(key)) return;
        byKey.set(key, {
          date: String(r.date).trim(),
          stock: _norm(r.stock),
          note: _norm(r.note),
          topics: _norm(r.topics)
        });
      });
    }
  }
  return Array.from(byKey.values());
}

/**
 * 把改好的 note / topics 写回云端（按 (date,stock) upsert，只带这两列 + 审计两列）。
 *
 * ⚠️ 用 upsert 而不是逐行 PATCH：一个核心词可能命中上百行，逐行发请求会变成上百次 HTTP；
 *    `upsertBucketed` 已按「字段集分桶」保证整批键集一致（见 data/upsert-buckets.js 的事故记录）。
 * ⚠️ 行是刚刚从库里读回来的 ⇒ 冲突路径必然命中，只更新 note/topics，其它列一个字不动。
 *
 * @param {Array<{date:string, stock:string, note:string, topics:string}>} rows
 * @returns {Promise<{count:number, batches:number}>}
 * @throws 任一批失败
 */
export async function writeAuctionTopicStringsBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { count: 0, batches: 0 };
  const now = new Date().toISOString();
  const payload = list.map(function(r) {
    return {
      date: r.date,
      stock: r.stock,
      note: r.note,
      topics: r.topics,
      updated_at: now,
      updated_by: 'main'
    };
  });
  const res = await upsertBucketed(getSupabase(), 'auction_watchlist', payload, { onConflict: 'date,stock' });
  _dbgLog('[CORE-PURGE] 已回写 ' + res.count + ' 行 note/topics（' + res.batches + ' 批）');
  return res;
}

/**
 * 回读校验用：把「刚写过的这些 (date,stock)」重新读一遍，返回 `date|stock -> {note, topics}`。
 *
 * 按日期分组的 `.in('stock', [...])`：一天通常只有几十~上百只，URL 长度可控。
 *
 * @param {Array<{date:string, stock:string}>} rows
 * @returns {Promise<Map<string, {note:string, topics:string}>>}
 * @throws 读取失败
 */
export async function readAuctionTopicStringsForRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Map();
  if (list.length === 0) return out;
  const byDate = new Map();
  list.forEach(function(r) {
    const d = String(r.date || '').trim();
    const s = _norm(r.stock);
    if (!d || !s) return;
    if (!byDate.has(d)) byDate.set(d, []);
    const arr = byDate.get(d);
    if (arr.indexOf(s) < 0) arr.push(s);
  });
  const sb = getSupabase();
  const dates = Array.from(byDate.keys());
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const stocks = byDate.get(d);
    const data = await fetchAllPages(function() {
      return sb.from('auction_watchlist')
        .select(COLS)
        .eq('date', d)
        .in('stock', stocks)
        .order('stock', { ascending: true });
    }, { concurrency: 4 });
    (data || []).forEach(function(r) {
      if (!r || !r.stock || !r.date) return;
      out.set(_keyOf(r.date, r.stock), { note: _norm(r.note), topics: _norm(r.topics) });
    });
  }
  return out;
}

/**
 * 把云端已改好的 note / topics 同步进内存缓存（`state._auctionMemCache`）。
 *
 * ★ 为什么必须做：看板读的是内存行（`getGroupData('auction')`），不刷新内存的话
 *   用户删完核心词再看，弹出来的还是旧题材 —— 也就是「云端对了、屏幕没变」。
 *   本函数只改 `note` / `topics` 两个字段，⛔ 不动 changePct / volume 等任何展示字段。
 *
 * @param {Array<{date:string, stock:string, note:string, topics:string}>} rows
 * @returns {number} 实际改动的内存行数
 */
export function applyAuctionTopicStringsToMemory(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return 0;
  const mem = state._auctionMemCache || {};
  let changed = 0;
  list.forEach(function(r) {
    const dayList = mem[r.date];
    if (!Array.isArray(dayList)) return;
    const stock = _norm(r.stock);
    const hit = dayList.find(function(x) { return x && _norm(x.stock) === stock; });
    if (!hit) return;
    if (hit.note === r.note && hit.topics === r.topics) return;
    hit.note = r.note;
    hit.topics = r.topics;
    changed++;
  });
  return changed;
}
