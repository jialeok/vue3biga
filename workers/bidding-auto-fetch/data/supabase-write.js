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

/**
 * [TIMEOUT 2026-09-30] 所有 Supabase REST 调用统一加硬超时。
 *
 * P0（今天的数据）落库链路上，读（stockcodemap / 名单 / 标签 / 龙头）与写
 * （auction_watchlist / market_metrics）都在 9:25~9:26 这 60 秒里，任何一次调用挂起
 * 都等于当天看板空白。健康时这些调用实测 100~500ms，15s 的上限是 30 倍余量，
 * 正常情况永远不会触发；一旦触发，宁可当次失败（已有降级/重试路径），也不无限等。
 */
const SB_REST_TIMEOUT_MS = 15000;
function sbFetch(url, opts, timeoutMs) {
  const ms = timeoutMs > 0 ? timeoutMs : SB_REST_TIMEOUT_MS;
  const base = opts || {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, base, { signal: AbortSignal.timeout(ms) }));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, Object.assign({}, base, { signal: ctrl.signal }))
    .finally(function () { clearTimeout(timer); });
}

/**
 * [RUNLOG 2026-09-30] 把一轮 worker 运行的完整日志（含 ⏱ 埋点 / elapsedMs / P0 是否达标）
 * 写入 bidding_fetch_log，供事后复盘。
 *
 * 为什么必须落库：2026-09-30 早盘竞价看板 9:26 无数据、9:30 才出现，
 *   而 `bidding_fetch_log` 里 **一条 CF worker 记录都没有**（只有 auction-yizi-* 的
 *   Edge Function 记录）—— 因为 runMorning 的埋点此前只 `console.log` 到 Cloudflare
 *   Dashboard 日志，沙箱侧看不到。最后只能靠 auction_watchlist / market_metrics 的
 *   created_at 反推「P0-① 花了 284 秒」，代价是几轮排查。
 *   落库后，下次直接 `select detail->'logs' ... where job='bidding-auto-fetch'` 即可。
 *
 * ⚠️ 永不抛错：日志写入失败绝不能影响主流程（更不允许它拖慢 9:25 落库）。
 * @param {object} env
 * @param {{time_point:string, run_date?:string, ok?:boolean, detail:object}} entry
 */
export async function writeRunLog(env, entry) {
  const e = entry || {};
  const row = {
    job: 'bidding-auto-fetch',
    run_date: e.run_date || '',
    time_point: e.time_point || '',
    source: 'cf-worker',
    ok: e.ok === true,
    detail: e.detail || {}
  };
  try {
    const resp = await sbFetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(row)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('写 bidding_fetch_log 失败（已忽略）: HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
  } catch (err) {
    console.error('写 bidding_fetch_log 失败（已忽略）:', err && err.message);
  }
}

// ============================================================================
// [PGRST102 2026-11-05] 批量 upsert 必须按「键集」分桶 —— 否则整批一行都不写
//
// 🔴 事故现场（2026-11-05 16:00 收盘 worker，`bidding_fetch_log` 原始日志）：
//      [extras] 窗口 9 天，库内缺「四要素/竞价涨幅」的行 27 行
//      [extras] numcat 返回 1314 行
//      [extras] ❌ 第 1 批写入失败: HTTP 400 {"code":"PGRST102","message":"All object keys must match"}
//      [extras] ✅ 补写 0/27 行
//    ⇒ 猫抓数据明明拿到了、库里 27 行明明等着补，**一整批全部丢失**。
//    ⇒ 直接后果：当天 `auc_vol_ratio` 只有 58/78（20 只永远空白），
//      11-04 的 70.7% 也是同一个原因；而 10-27~11-03 一直是 100%。
//
// 为什么会出现键集不一致：`extras-workflow.js` 组的 patch 是「哪个字段缺就带哪个」
//   （`patch.code` 只在库内该行有 code 时才带，五个要素各自按需带）
//   ⇒ 同一批里不同行的键**本来就不一样**。
//
// ⛔ 两个常见但**错的**修法（都试过 / 都别再用）：
//   ① 加 `Prefer: missing=default` —— 它是请求体校验【之后】才生效的偏好，
//      PGRST102 在解析阶段就 400 了，根本轮不到它。
//      而且它的语义是「缺的键取该列的 DEFAULT（通常是 NULL）」，配合
//      `resolution=merge-duplicates` 就是 `SET col = EXCLUDED.col` ⇒ **把现有值抹成 NULL**。
//      本文件原来那句注释「某一行没带某个字段时保留云端原值」是错的（2026-11-05 更正）。
//   ② `?columns=a,b,c` 固定列清单 —— 同样会按 missing 语义把没写的列写成 NULL。
//
// ✅ 唯一正确修法：一批 = 一条 `INSERT ... ON CONFLICT DO UPDATE`，所以**只让同键集的行同批**。
//    分桶后每个桶内部键集完全一致 ⇒ 不存在「缺列」⇒ 既不会 400，也不会抹值（§10/§11）。
// ============================================================================

/**
 * 按「键集签名」把行分桶（键顺序无关）。
 * @param {Array<Object>} rows
 * @returns {Array<{keys:string[], rows:Array<Object>}>} 每个桶内所有行的键集完全相同
 */
export function bucketRowsByKeySet(rows) {
  const map = new Map();
  (rows || []).forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    const keys = Object.keys(r).sort();
    const sig = keys.join('\u0001');
    let b = map.get(sig);
    if (!b) { b = { keys: keys, rows: [] }; map.set(sig, b); }
    b.rows.push(r);
  });
  return Array.from(map.values());
}

/**
 * 分桶写入（三个批量 upsert 共用，§6 只允许一份实现）。
 *
 * @param {object} env
 * @param {string} table 表名（仅用于报错文案，⛔ 不参与拼 URL —— URL 由调用方给，含 on_conflict）
 * @param {string} url 完整 URL（含 ?on_conflict=...）
 * @param {Array<Object>} rows
 * @param {object} [extraHeaders] 额外 Prefer 等
 */
async function upsertBucketed(env, table, url, rows, extraHeaders) {
  const buckets = bucketRowsByKeySet(rows);
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const resp = await sbFetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, return=minimal' }, extraHeaders || {}),
      body: JSON.stringify(b.rows)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // §10 报错必须能定位：带上桶大小与键集，否则下次又只能猜「是不是上游没数据」
      throw new Error('upsert ' + table + ' 失败（第 ' + (i + 1) + '/' + buckets.length
        + ' 桶，' + b.rows.length + ' 行，键集 [' + b.keys.join(',') + ']）: HTTP '
        + resp.status + ': ' + text.slice(0, 300));
    }
  }
}

export async function upsertAuctionWatchlist(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'auction_watchlist',
    CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?on_conflict=date,stock', rows);
}

export async function upsertMarketMetrics(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'market_metrics',
    CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date,stock,scope', rows);
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
  // [PGRST102 2026-11-05] 同 upsertMarketMetrics：走分桶，⛔ 不要再单批塞异键集的行
  await upsertBucketed(env, 'stock_range_pct',
    CONFIG.SUPABASE_URL + '/rest/v1/stock_range_pct?on_conflict=date,stock', rows);
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
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
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
 * [EXTRAS-PATCH 2026-09-11] 读取某日 market_metrics 竞价行的「竞价四要素 + 竞价涨幅」现状。
 * 供 runAuctionExtrasPatch 判断哪些行还缺字段 —— 只补缺失的，不重复写已有值（幂等）。
 * ⚠️ 读取失败必须抛错（§10：读取失败 ≠ 空数据）：否则会把「读不到」误判成「全都缺」，
 *    进而用一次 numcat 的结果把历史值整体覆盖一遍。
 * [AUCPCT-BACKFILL 2026-09-14] select 从四要素扩到含 auc_pct_chg：追溯创建的历史日行
 *    会永久缺这一项（前端不在白名单、次日只覆盖 change_pct），导致趋势图五日竞价涨幅曲线空白。
 */
export async function readMarketMetricsExtrasForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?date=eq.' + encodeURIComponent(date) +
    '&scope=eq.auction' +
    '&select=stock,code,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover,auc_pct_chg&limit=2000';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 market_metrics 四要素失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  const s = v => (v === undefined || v === null ? '' : String(v));
  return (data || []).map(r => ({
    name: (r.stock || '').trim(),
    code: (r.code || '').trim(),
    um_vol: s(r.um_vol),
    open_bid_pct: s(r.open_bid_pct),
    auc_vol_ratio: s(r.auc_vol_ratio),
    auc_turnover: s(r.auc_turnover),
    auc_pct_chg: s(r.auc_pct_chg)
  })).filter(r => r.name);
}

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 读取某日竞价行「同花顺快照可补字段」的现状：
 *   auc_pct_chg / auc_vol_ratio / auc_turnover / volume。
 * 供 runTodaySnapshotPatch 判断哪些行还缺字段 —— 只补缺失、不覆盖已有（幂等）。
 * ⚠️ 读取失败必须抛错（§10：读取失败 ≠ 空数据）：否则会把「读不到」误判成「全都缺」。
 */
export async function readMarketMetricsSnapshotFieldsForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?date=eq.' + encodeURIComponent(date) +
    '&scope=eq.auction' +
    '&select=stock,code,auc_pct_chg,auc_vol_ratio,auc_turnover,volume&limit=2000';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 market_metrics 快照字段失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  const pick = (v) => (v === undefined || v === null ? '' : String(v));
  return (data || []).map(r => ({
    name: (r.stock || '').trim(),
    code: (r.code || '').trim(),
    auc_pct_chg: pick(r.auc_pct_chg),
    auc_vol_ratio: pick(r.auc_vol_ratio),
    auc_turnover: pick(r.auc_turnover),
    volume: pick(r.volume)
  })).filter(r => r.name);
}

/**
 * [CLOSE-COVER 2026-09-10] 读取某日 stock_range_pct（近 10 个交易日区间涨幅缓存）。
 * 收盘后需要把「当天(T)腿」从竞价口径换成收盘口径 —— 见 close-workflow.js 步骤 4。
 */
export async function readStockRangePctForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range_pct?date=eq.' + encodeURIComponent(date) +
    '&select=stock,range_pct,days,updated_at&limit=2000';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
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

/**
 * [RANGE20-FETCH 2026-11-05 用户口径] 读取某日「20 日区间涨幅」排行，按数值降序取前 N。
 *
 * 用途：把「20 日补位票」并入 9:25 的抓取名单。用户原话：
 *   「我不是让你把 20 日补票放进 worker 吗？这样不是更方便……先要算出 20 日涨幅，算出排名后，
 *     统一获取就可以了。也就是和那些最近多板源一起用猫抓数据接口一起获取，也是消耗一个额度。」
 *   ⇒ 猫抓 `daily_auc` 是「一次请求一批 symbols」，额度按【请求次数】算、不按股票数算，
 *     所以名单里多这 20 只【0 额外额度】。
 *
 * ⚠️ 为什么取【前一交易日】的榜：当天（date=today）这张表要等收盘后才算出来 ——
 *   2026-11-05 实测 79 行全部 `updated_at=16:38`（收盘后 38 分钟），9:25 时一行都没有。
 *   而「截至昨日收盘」的 20 日涨幅昨天收盘后就已算好，是 9:25 唯一可及且完整的口径。
 *
 * 🔴 `pct` 是【文本列】，⛔ 绝不能用 `order=pct.desc`（那是字典序）：
 *   实测会把 '8.94' 排在 '78.46' 前面 ⇒ 前五变成一批弱势票。必须取回后按 Number() 排。
 *
 * ⚠️ 口径（用户铁律「早上用竞价口径，收盘用收盘口径，不要搞混」）：
 *   该表同一 (date, stock) 可能同时存在 `leg='auc'`（9:26 竞价口径，当天中间态）与
 *   `leg='close'`（收盘口径，该日 20 日复利的**权威值**）两行 —— 契约见前端
 *   `src/logic/auction/prev-rank-table.js#pickCloseLegRows`（那里也是 close 优先）。
 *   本函数【同股只取一行】，**优先 `leg='close'`**；只有 auc 行的票仍然收（不清空覆盖度）。
 *
 *   ⛔ 与前端 `pickCloseLegRows` 的唯一差别：前端拿它做「今日 vs 昨日」名次对比，
 *      混腿会让名次变化失真，所以那类票宁可判不出；本函数是【挑抓取候选】，
 *      多抓一只是 0 额度，少抓一只就缺数据 ⇒ 有 auc 行也收，只是排在 close 之后。
 *
 *   实测 11-03/11-04/11-05 三日均为 0 例同股双行（该表事实上 (date,stock) 唯一），
 *   所以这条规则今天是 no-op，但它是【未来出现双行时不混口径】的保险。
 *
 * @returns {Promise<Array<{name:string,pct:number,days:number,leg:string}>>} 失败返回 []（非致命）
 */
export async function readRange20TopForDate(env, date, limit) {
  const n = Number(limit) > 0 ? Math.floor(Number(limit)) : 20;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?date=eq.' +
    encodeURIComponent(date) + '&select=stock,pct,days,leg&limit=2000';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
  const num = function (v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace('%', '').replace(/,/g, '').trim();
    if (s === '') return null;
    const x = Number(s);
    return isNaN(x) ? null : x;
  };
  // 同股去重 + 按口径取舍（close 优先，见上方「口径」注记）
  const byName = new Map();
  (data || []).forEach(function (r) {
    const name = (r.stock || '').trim();
    if (!name) return;
    const pct = num(r.pct);
    if (pct === null) return;                       // §10 缺值不得当 0 参与排名
    // leg 为空按 close 对待（旧行缺省就是收盘口径），与前端 pickCloseLegRows 一致
    const leg = (String(r.leg || 'close').trim().toLowerCase() === 'auc') ? 'auc' : 'close';
    const cur = byName.get(name);
    if (!cur) { byName.set(name, { name: name, pct: pct, days: Number(r.days) || 0, leg: leg }); return; }
    // 已有 auc 行、这次来的是 close 行 ⇒ 用 close 覆盖（收盘口径是权威值）
    if (cur.leg !== 'close' && leg === 'close') {
      byName.set(name, { name: name, pct: pct, days: Number(r.days) || 0, leg: leg });
    }
  });
  return Array.from(byName.values())
    .sort(function (a, b) { return b.pct - a.pct; })
    .slice(0, n);
}

// [BUG-FIX] 读取指定日期的 auction_watchlist 股票列表，用于合并打标签/观察组股票到 worker 抓取名单
// [9:25-LOCK 2026-09-15] 额外返回 obs_auto_added：调用方判断「9:25 那轮是否已成功落库」时，
//   必须【排除观察组壳行】——壳行是前端打开页面时自己写的（source=manual），
//   若把它当成「名单已存在」，worker 重跑就会一行都不写（2026-09-15 P0 修复现场实测）。
export async function readAuctionWatchlistForDate(env, date) {
  // [LADDER-FALLBACK 2026-11-06] 额外返回 source：降级时挑「前一日正式成员」做兜底名单，
  //   必须能把 source='range20'（前端 20 日补位票）/ 'manual'（观察组壳行）排除掉，
  //   否则会把补位票当成「最近多板成分股」写进今天的常规组。
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + date + '&select=stock,code,obs_auto_added,source';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
  // 【FIX 2026-08-15】不再过滤 code 为空的行：观察组/打标签股票在前一日 watchlist 里可能没有 code
  // （worker 从不写 code 到这些行，code 只在 stockcodemap 表），过滤掉会导致观察组股票不被抓取、
  // 当天 market_metrics 无数据 → 观察组显示空白。code 由调用方（fetchAndWriteWatchlist）查 stockcodemap 补充。
  return (data || []).map(r => ({
    name: (r.stock || '').trim(),
    code: r.code || '',
    obs_auto_added: !!r.obs_auto_added,
    source: (r.source || '').trim()
  })).filter(s => s.name);
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
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
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

/**
 * [DRAGON-GROUP 2026-09-14] 读取某【评选日】的龙头名册（dragon_leaders）。
 * 用途：9:25 抓取前，把「前一交易日评选出的龙头」并入抓取名单 → 保证龙头组数据的【完整获取】
 *      （需求 2：包括龙头组在内，所有数据和正式列表一样都要自动、完整获取）。
 * 口径：名册的评选/落库唯一实现在前端 Logic 层（logic/auction/dragon-group.js），worker 只读不选
 *      —— 避免「前端算一套、worker 算一套」的第二真相源（§6）。
 * 与 auction_watchlist / 打标签股票同款：只并入【抓取名单 constituents】，不写 auction_watchlist，
 *      不破坏「当日名单 = 9:25 快照」的锁定口径。
 * 失败返回 []（非致命：当次龙头数据缺失，但不该因此中断整轮早盘抓取）。
 */
export async function readDragonLeadersForDate(env, date) {
  if (!date) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/dragon_leaders?date=eq.' + encodeURIComponent(date) +
    '&select=stock,code,topic&limit=500';
  try {
    const resp = await sbFetch(url, { headers: sbHeaders(env) });
    if (!resp.ok) return [];
    const data = await resp.json();
    const out = [];
    const seen = new Set();
    (data || []).forEach(r => {
      const name = (r.stock || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name: name, code: r.code || '', topic: (r.topic || '').trim() });
    });
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * [LATENCY 2026-09-11] 按【股票名】精确查代码映射。
 * 存在的理由：readStockCodeMap 全表读受 Supabase 单次 1000 行上限截断（实测表共 1005 行、
 * 只回 1000 行），少部分名字会查不到 code；而全表分页读又要 6 次请求，放在 9:25 的关键路径上不划算。
 * 因此主路径用一次全表读（覆盖绝大多数），剩余缺 code 的名字再用本函数按名精确补一次（1 次小请求）。
 */
export async function readStockCodeMapByNames(env, names) {
  const clean = (names || []).map(n => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return {};
  const uniq = Array.from(new Set(clean)).slice(0, 400);
  const inList = uniq.map(n => '%22' + encodeURIComponent(n) + '%22').join(',');
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?select=stock,code&stock=in.(' + inList + ')';
  try {
    const resp = await sbFetch(url, { headers: sbHeaders(env) });
    if (!resp.ok) return {};
    const data = await resp.json();
    const map = {};
    (data || []).forEach(r => {
      const name = (r.stock || '').trim();
      const code = (r.code || '').trim();
      if (name && code && !map[name]) map[name] = code;
    });
    return map;
  } catch (e) {
    return {};
  }
}

// [FIX 2026-08-15] 读取股票名称→代码映射表（stockcodemap），为 watchlist 里 code 为空的
// 观察组/打标签股票补充 code（worker 的 numcat 抓取按 code 查询，无 code 无法抓数据）。
// ⚠️ 受 Supabase 单次 1000 行上限截断；缺漏由 readStockCodeMapByNames 按名补齐。
export async function readStockCodeMap(env) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?select=stock,code';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
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