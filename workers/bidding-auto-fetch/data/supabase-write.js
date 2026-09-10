// supabase-write.js — Supabase 写入接口
import { CONFIG } from '../config.js';

export function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

export async function upsertAuctionWatchlist(env, rows) {
  if (!rows || rows.length === 0) return;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?on_conflict=date,stock';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('upsert auction_watchlist 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

export async function upsertMarketMetrics(env, rows) {
  if (!rows || rows.length === 0) return;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date,stock,scope';
  // 【FIX 2026-08-03】加 missing=default：批次里某一行没带某个字段时保留云端原值
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, missing=default, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('upsert market_metrics 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

export async function updateStockCodeMap(env, pairs) {
  // stockCodeMap 存在 localStorage，前端从 auction_watchlist 读取 code 回填
}

/**
 * [PLAN-A 2026-09-10] 写入「近 10 个交易日区间涨幅」缓存（stock_range_pct，主键 date+stock）。
 * 由 9:25 morning 那一次 numcat daily 请求算好后落库，前端只读云端、不再自行抓取。
 * @param {Array<{date:string, stock:string, range_pct:string|null, days:number, updated_at:string}>} rows
 */
export async function upsertStockRangePct(env, rows) {
  if (!rows || rows.length === 0) return;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range_pct?on_conflict=date,stock';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('upsert stock_range_pct 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

/**
 * [CLOSE-COVER 2026-09-10] 读取某日 market_metrics 竞价行（收盘覆盖 + 区间涨幅 T 腿校正共用）。
 * 返回 name + code + change_pct + auc_pct_chg，供：
 *   ① 覆盖 change_pct 前判断是否已是收盘口径（updated_at >= 当日 15:00）；
 *   ② T 腿校正反解旧腿（旧的 T 腿 = worker 早盘写入的 auc_pct_chg）。
 * ⚠️ 读取失败必须抛错（§10：读取失败 ≠ 空数据），绝不能让收盘覆盖误判为「今天没有股票」。
 */
export async function readMarketMetricsForDate(env, date, scope) {
  const sc = scope || 'auction';
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?date=eq.' + encodeURIComponent(date) +
    '&scope=eq.' + encodeURIComponent(sc) +
    '&select=stock,code,change_pct,auc_pct_chg,updated_at&limit=2000';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 market_metrics 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data || []).map(r => ({
    name: (r.stock || '').trim(),
    code: (r.code || '').trim(),
    change_pct: r.change_pct === undefined ? '' : r.change_pct,
    auc_pct_chg: r.auc_pct_chg === undefined ? '' : r.auc_pct_chg,
    updated_at: r.updated_at || ''
  })).filter(r => r.name);
}

/**
 * [CLOSE-COVER 2026-09-10] 读取某日 stock_range_pct（近 10 个交易日区间涨幅缓存）。
 * 收盘后需要把「当天(T)腿」从竞价口径换成收盘口径 —— 见 close-workflow.js 步骤 4。
 */
export async function readStockRangePctForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range_pct?date=eq.' + encodeURIComponent(date) +
    '&select=stock,range_pct,days,updated_at&limit=2000';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 stock_range_pct 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data || []).map(r => ({
    stock: (r.stock || '').trim(),
    range_pct: r.range_pct === undefined ? null : r.range_pct,
    days: Number(r.days) || 0,
    updated_at: r.updated_at || ''
  })).filter(r => r.stock);
}

// [BUG-FIX] 读取指定日期的 auction_watchlist 股票列表，用于合并打标签/观察组股票到 worker 抓取名单
export async function readAuctionWatchlistForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + date + '&select=stock,code';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
  // 【FIX 2026-08-15】不再过滤 code 为空的行：观察组/打标签股票在前一日 watchlist 里可能没有 code
  // （worker 从不写 code 到这些行，code 只在 stockcodemap 表），过滤掉会导致观察组股票不被抓取、
  // 当天 market_metrics 无数据 → 观察组显示空白。code 由调用方（fetchAndWriteWatchlist）查 stockcodemap 补充。
  return (data || []).map(r => ({ name: (r.stock || '').trim(), code: r.code || '' })).filter(s => s.name);
}

// [FEAT 2026-09-08] 读取指定日期的「打标签」股票（auction_board_tags：buy / sell / hold）。
// 用户靠标签复盘买卖对错，这些股票次日必须出现在列表里且**有数据**。其中有一部分：
//   · 不在最近多板成分股里；
//   · 也不在前一日 auction_watchlist 里（例如用户是在「观察组空壳行」上打的标签，
//     观察组空壳只存在于前端视图层、不落库）；
// 只靠 watchlist 合并会漏掉它们（2026-09-08 实测：赤天化、沃华医药当天完全无数据）。
// 因此直接读标签表补齐抓取名单。只并入「抓取名单（market_metrics）」，
// 不写 auction_watchlist，不破坏「当日名单 = 9:25 快照」的锁定口径。
export async function readAuctionTagsForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_board_tags?date=eq.' + date +
    '&select=stock,tag&limit=1000';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
  const out = [];
  const seen = new Set();
  (data || []).forEach(r => {
    const name = (r.stock || '').trim();
    if (!name || !r.tag || seen.has(name)) return;
    seen.add(name);
    out.push({ name: name, tag: r.tag });
  });
  return out;
}

// [FIX 2026-08-15] 读取股票名称→代码映射表（stockcodemap），为 watchlist 里 code 为空的
// 观察组/打标签股票补充 code（worker 的 numcat 抓取按 code 查询，无 code 无法抓数据）。
export async function readStockCodeMap(env) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?select=stock,code';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return {};
  const data = await resp.json();
  const map = {};
  (data || []).forEach(r => {
    const name = (r.stock || '').trim();
    const code = (r.code || '').trim();
    if (name && code && !map[name]) map[name] = code;
  });
  return map;
}