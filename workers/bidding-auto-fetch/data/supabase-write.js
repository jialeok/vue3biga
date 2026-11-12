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

/**
 * [LADDER26 2026-11-06] 9:26 真实 883410 名单写成功后，清掉当天 9:25 的兜底行。
 *
 * §11 删除安全：这是**范围最窄**的删除 —— 只能删 `date=今天 AND source='worker-fallback'`，
 *   绝不碰观察组壳行 / 手动行 / 20 日补位行 / 其它日期。调用方还必须先完成
 *   「真实名单写入成功 + 重读复核达标」，删除后再复核一次（见 ladder-recheck.js ⑤）。
 *
 * `Prefer: return=representation` 让 PostgREST 把真正删掉的行返回 ⇒ 用返回行数做结果确认，
 *   ⛔ 不看「HTTP 204 就算成功」那种无法核对影响行数的做法（§11 删除结果验证）。
 * 读取/删除失败一律抛错（§10），由调用方记日志并保留兜底行，绝不静默吞掉。
 */
export async function deleteLadderFallbackRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + encodeURIComponent(date) +
    '&source=eq.worker-fallback';
  const resp = await sbFetch(url, {
    method: 'DELETE',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=representation' })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('删除当日 worker-fallback 行失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
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

// ============================================================================
// [R20-PREFILL 2026-11-06] 9:26 云端「20 日涨幅补缺」所需的三个只读 / 一个写入口。
//   与 Edge `backfillRange20FromLegs` 同源，但跑在 Cloudflare Worker（wrangler CI 自动部署），
//   ⛔ 不需要用户在 Supabase Dashboard 手工重贴 Edge Function。
//   §10：以下读取失败【一律抛错】，绝不返回 []（否则会把「读不到」误判成「云端没有值」而覆盖写）。
// ============================================================================

/** 当日 stock_range20_pct 已有行（按 stock 去重；不区分 leg —— 有任何一行就不写，避免覆盖口径） */
export async function readRange20StocksForDate(env, date) {
  // [R20-LEGS-PAGED 2026-11-10] 同 readDailyLegsForStocks：改 Range 分页，⛔ 不再写死 limit=2000。
  //   这个 set 是「已有行不覆盖」的唯一判据，漏一行就会把云端真值当成缺失重算一遍。
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?date=eq.' + encodeURIComponent(date) +
    '&select=stock&order=stock.asc';
  const data = await sbGetPaged(env, url);
  const set = new Set();
  (data || []).forEach(function (r) {
    const s = String((r && r.stock) || '').trim();
    if (s) set.add(s);
  });
  return set;
}

/**
 * 读「逐日腿表」的历史腿（⛔ 不含目标日本身：T 腿由 market_metrics 提供）。
 * 按股票名分批 in 过滤，避免把 60 天 × 400 只 = 1.5 万行整表拉回来（§32 不做无意义请求）。
 * 实测 PostgREST `stock=in.("中文名","中文名")` 在中国股票名下可用（2026-11-06 生产验证 39 行）。
 *
 * 🔴🔴 [R20-LEGS-PAGED 2026-11-10 P0] 原实现每批写死 `limit=1000` 且【不分页】。
 *   11-10 生产事故：75 只票 × 每只 44 根腿 ≈ 3300 行，分 2 批（40+35）各自被砍到 1000 行
 *   ⇒ worker 日志「读腿 2000 行 / 腿不足 21」⇒ 21 只票（含【冰山冷热】）被误判「腿不足 19 根」
 *   而拒写 stock_range20_pct。它们直到 10:00 才由浏览器 K 线精算补进榜单
 *   （库内 updated_at 分两批：01:26 云端 19 行 / 02:00 浏览器 52 行）。
 *   ⇒ 题材量比第三十条「弱势切抱团」的池子（20 日涨幅主板前三）里当时根本没有这只票
 *   ⇒ 首屏只显示空仓 + 灰色题材；数据补齐后又被「定稿冻结」挡住，必须切日期才看得到。
 *   用户看到的「很久才出现 / 换来换去」根因就在这里，⛔ 不是竞价涨停被过滤。
 * ✅ 修法：改用本文件已有的 `sbGetPaged`（Range 头分页，0 截断）+ 确定性 order。
 *   单批仍按股票名分片控制 URL 长度，但片内不再有行数上限（§10 读全 ≠ 读失败）。
 * @returns {Promise<Array<{stock:string,date:string,pct:string}>>}
 */
export async function readDailyLegsForStocks(env, fromDate, beforeDate, stocks, chunkSize) {
  const names = Array.from(new Set((stocks || []).map(s => String(s || '').trim()).filter(Boolean)));
  if (names.length === 0) return [];
  const size = chunkSize > 0 ? chunkSize : 40;
  const out = [];
  for (let i = 0; i < names.length; i += size) {
    const chunk = names.slice(i, i + size);
    // ⚠️ 不要用 /"/g：_check_bundle.mjs 的字符串状态机不识别正则里的引号，
    //    会失步并把整个产物误判成「缺必需标识符」而拒绝出包（见该文件「已知局限」）。
    const inVal = '(' + chunk.map(n => '"' + n.split('"').join('') + '"').join(',') + ')';
    const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_daily_pct?select=stock,date,pct' +
      '&date=gte.' + encodeURIComponent(fromDate) +
      '&date=lt.' + encodeURIComponent(beforeDate) +
      '&stock=in.' + inVal +
      // Range 分页必须有确定性顺序，否则跨页可能重复 / 漏行（§32）。
      '&order=stock.asc,date.asc';
    let data;
    try {
      data = await sbGetPaged(env, url);
    } catch (e) {
      // [R20-LEGS-PAGED] 是本轮上线的【可验证标记】：字符串字面量，打包 / 压缩都不会丢。
      //   workers/verify-deploy.mjs 部署后直接在线上脚本里断言它 ⇒ 防「CI 假绿」重演
      //   （2026-11-06 那次是 wrangler 没真部署、CI 却全绿）。⛔ 别把它挪进注释。
      throw new Error('[R20-LEGS-PAGED] 读取 stock_daily_pct 逐日腿失败（第 ' + (i / size + 1) + ' 批）: ' +
        (e && e.message ? e.message : String(e)));
    }
    (data || []).forEach(function (r) {
      const s = String((r && r.stock) || '').trim();
      const d = String((r && r.date) || '').slice(0, 10);
      if (s && d) out.push({ stock: s, date: d, pct: r.pct });
    });
  }
  return out;
}

/** 写 stock_range20_pct（与 Edge backfillRange20FromLegs 完全相同的 on_conflict / 列集合） */
export async function upsertRange20Rows(env, rows) {
  if (!rows || rows.length === 0) return;
  // ★ [DDL-LEG 2026-11-11] 线上主键已升级为 (date,stock,leg)。
  //   11-11 9:26 / 9:27 两趟 r20-prefill 都因 `on_conflict=date,stock` 撞 400/42P10
  //   （"there is no unique or exclusion constraint matching the ON CONFLICT specification"）
  //   整批写不进去 ⇒ 当天 stock_range20_pct 0 行 ⇒ 前端退回浏览器现算 40+ 次 K 线（慢）。
  //   ⚠️ DDL 已执行，此处必须带 leg；⛔ 别改回两列。
  await upsertBucketed(env, 'stock_range20_pct',
    CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?on_conflict=date,stock,leg', rows);
}

// ============================================================================
// [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐（替代本机 08:00 定时任务）
//   §10：读取失败一律抛错；§32：按 Range 分页，不整表拉爆网关。
// ============================================================================

/** 分页 GET（PostgREST Range 头）；返回扁平数组，任何一页失败都抛错 */
async function sbGetPaged(env, url) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; from <= 30000; from += PAGE) {
    const resp = await sbFetch(url, {
      headers: Object.assign(sbHeaders(env), {
        'Range': from + '-' + (from + PAGE - 1),
        'Range-Unit': 'items'
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('分页读取失败 (from=' + from + '): HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    const page = await resp.json();
    if (!Array.isArray(page) || page.length === 0) break;
    page.forEach(r => out.push(r));
    if (page.length < PAGE) break;
  }
  return out;
}

/** 读窗口内 market_metrics 的「收盘腿原料」（change_pct / auc_pct_chg 用于判是否已被收盘覆盖） */
export async function readMetricsLegsWindow(env, fromDate, throughDate) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?select=stock,date,change_pct,auc_pct_chg' +
    '&scope=eq.auction&date=gte.' + encodeURIComponent(fromDate) +
    '&date=lte.' + encodeURIComponent(throughDate) + '&order=date.asc';
  return sbGetPaged(env, url);
}

/** 读某日 stock_daily_pct 已有股票（⛔ 已有的一律不碰：纯新增、幂等） */
export async function readDailyPctStocksForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_daily_pct?select=stock' +
    '&date=eq.' + encodeURIComponent(date);
  const rows = await sbGetPaged(env, url);
  const set = new Set();
  rows.forEach(r => {
    const s = String((r && r.stock) || '').trim();
    if (s) set.add(s);
  });
  return set;
}

/** 写逐日腿（与本机脚本 / Edge heal 同一张表、同一 on_conflict） */
export async function upsertDailyPctRows(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'stock_daily_pct',
    CONFIG.SUPABASE_URL + '/rest/v1/stock_daily_pct?on_conflict=date,stock', rows);
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
  // ★ [DDL-LEG 2026-11-11] 主键升级为 (date,stock,leg) 后，同一天可能出现 auc / close
  //   两行 ⇒ 行数翻倍。原来 `limit=2000` 写死无分页正好踩 §2 Range 分页红线（11-10 P0 根因
  //   `readDailyLegsForStocks` 就是这么静默截断的）⇒ 改 sbGetPaged + 确定性 order。
  //   ⚠️ 口径不变：下面 byName 去重仍是「close 优先」，9:25 读的是【前一交易日完整榜】
  //      （收盘口径），两腿并存时自然取到 close 行，⛔ 不改用竞价腿。
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?date=eq.' +
    encodeURIComponent(date) + '&select=stock,pct,days,leg&order=stock.asc,leg.asc';
  // [CLOUD-0927-HEAL 2026-11-11 §10] 读失败必须抛错，由 9:25 组B 的 settled() 降级并计入汇总，
  //   ⛔ 不伪装成「前一日 20 日榜为空」（空榜会让 9:25 继续跑出一份残缺名单）。
  //   ⚠️ sbGetPaged 的原始消息带分页 from，缺少「哪张表 / 哪一天」的定位信息 ⇒
  //      统一包回业务语义，保持既有日志与告警文案可被正则检索（§10 报错必须能定位）。
  let data;
  try {
    data = await sbGetPaged(env, url);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const http = /HTTP \d+[\s\S]*/.exec(msg);
    throw new Error('读取 stock_range20_pct(' + date + ') 失败: ' + (http ? http[0] : msg));
  }
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
  // 🔴 [CLOUD-0927-HEAL 2026-11-11 §10] 原来 `if (!resp.ok) return []`：
  //   9:26 的 runRange20Prefill / runLadderRecheck 都是【基于这份名单再写库】的，
  //   一次网络抖动被吞成「今天没有名单」⇒ 拿残缺数据补位、甚至触发降级兜底覆盖。
  //   ⇒ 读取失败必须抛错，由各调用方的 try/catch 或 settled() 显式降级（失败≠空数据）。
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 auction_watchlist(' + date + ') 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
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

/**
 * [CLOUD-0927-HEAL 2026-11-11] 读取 today 之前【最近一个有名单】的交易日及其正式成员。
 *
 * 用途：9:26 `runLadderRecheck` 的深度降级路径（9:25 整轮没写名单 + 883410 仍不可用）
 *       需要用前一日正式成员写兜底名单；此前 index.js 从未传 `prevRows` ⇒ 这条救援实际永远失效。
 * 为什么不走 `getRecentTradingDays`：那条会读用户假期设置 + fuyao 交易日历（上游请求），
 *   9:26 的兜底路径不该再引一条外部依赖；直接问库里「最近一个有名单的日期」最准、0 上游。
 * §10：读取失败必须抛错，由调用方 try/catch 记日志降级为「无兜底」，⛔ 不能吞成空名单。
 *
 * @returns {Promise<{date:string, rows:Array<{name,code,obs_auto_added,source}>}>}
 */
export async function readPreviousAuctionWatchlist(env, today) {
  const base = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist';
  const dUrl = base + '?date=lt.' + encodeURIComponent(today) +
    '&select=date&order=date.desc&limit=1';
  const dResp = await sbFetch(dUrl, { headers: sbHeaders(env) });
  if (!dResp.ok) {
    const text = await dResp.text().catch(() => '');
    throw new Error('读取前一交易日失败: HTTP ' + dResp.status + ': ' + text.slice(0, 200));
  }
  const dRows = await dResp.json();
  if (!Array.isArray(dRows) || dRows.length === 0 || !dRows[0].date) return { date: '', rows: [] };
  const date = String(dRows[0].date).slice(0, 10);
  return { date: date, rows: await readAuctionWatchlistForDate(env, date) };
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
  // [CLOUD-0927-HEAL 2026-11-11 §10] 原 `return []` 把「读失败」伪装成「没有标签」：
  //   9:25 组B 用 settled() 接住（降级不中断），但汇总会把它计成一路失败 ⇒ 失败可见。
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 auction_board_tags(' + date + ') 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
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
 * [CLOUD-0927-HEAL 2026-11-11 §10] 原实现「HTTP 非 2xx / 网络异常一律 return []」，
 *   与「前一交易日本来就没有名册」完全无法区分 ⇒ 9:25 抓取名单静默少一批龙头，
 *   而 `bidding_fetch_log` 仍打 ✅。现改为抛错：9:25 组B 由 settled() 接住并计入
 *   `groupBReadFailures`（降级不中断、但汇总留痕）；⛔ 绝不把读失败当空名册。
 */
export async function readDragonLeadersForDate(env, date) {
  if (!date) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/dragon_leaders?date=eq.' + encodeURIComponent(date) +
    '&select=stock,code,topic&limit=500';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 dragon_leaders(' + date + ') 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
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

/**
 * [RANGE20-CODE-FALLBACK 2026-11-11] 按股票名从 `market_metrics` 补 code（二级兜底）。
 *
 *   取证（11-11）：`stockcodemap` 全表 1142 行里**没有**「青岛食品」，但有「海洋王」；
 *   而 `market_metrics(scope=auction)` 近 10 天里两只票都带 code（001219 / 002724）。
 *   9:25 合并「20日涨幅补位票」时 `codeMap[r.name] || ''` 取不到 ⇒ `if (!code) return`
 *   把票整批丢掉 ⇒ 它不在猫抓 `daily_auc` 的 symbols 里 ⇒ 当天整行都不存在，
 *   前端 9:27 只补得出 `ths-patch` 壳行（量比按红线禁用同花顺 ⇒ 永远空）。
 *   ⇒ 同为 20 日补位票，海洋王量比 1.94 齐全、青岛食品空，就是这一处差异。
 *
 *   `market_metrics` 自带 `code` 列，且这些票历史上都在 9:25 名单里出现过 ⇒ 用它兜底
 *   比让补位票「等下次进榜再说」更准确，且 0 上游请求 / 0 猫抓额度。
 *
 * §10：这是兜底层，读失败返回 {}（不抛错、不阻断 9:25）；调用方必须把「仍缺 code」
 *      的只数写进日志，⛔ 不许静默丢票。
 */
export async function readCodesFromMetricsByNames(env, names) {
  const clean = (names || []).map(n => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return {};
  const uniq = Array.from(new Set(clean)).slice(0, 400);
  const map = {};
  // ★ [RANGE20-CODE-FALLBACK 2026-11-11] 按股票名分批 + 「日期降序优先」两点都很关键：
  //   ① 单批 100 只，避免 URL 过长 / 单批行数超 PostgREST 1000 行上限（§2 Range 分页红线）。
  //   ② order 必须是 `date.desc` 在前：code 与日期无关，最近的行情行先返回 ⇒ 即使某批
  //      真的撞到 1000 行上限，被截掉的也只是更老的历史行，不会把「青 / 奥」这类
  //      按 UTF-8 字节序排在后面的票整只丢掉（旧写法 stock.asc 在第一位正是这个隐患）。
  //   ⚠️ 这是兜底层：任一批读取失败只记空，⛔ 不抛错、不阻断 9:25 主链路（§10）。
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const inList = chunk.map(n => '%22' + encodeURIComponent(n) + '%22').join(',');
    const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?select=stock,code' +
      '&scope=eq.auction&stock=in.(' + inList + ')&code=not.is.null' +
      '&order=date.desc,stock.asc&limit=1000';
    try {
      const resp = await sbFetch(url, { headers: sbHeaders(env) });
      if (!resp.ok) continue;
      const data = await resp.json();
      (data || []).forEach(function (r) {
        const name = String((r && r.stock) || '').trim();
        const code = String((r && r.code) || '').replace(/\D/g, '');
        if (name && /^\d{6}$/.test(code) && !map[name]) map[name] = code;
      });
    } catch (e) {
      // 单批失败不影响其它批，也不影响 9:25 主流程
    }
  }
  return map;
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
// ============================================================================
// [LD-CLOUD 2026-11-13] 第二十五条「总龙分歧」云端预计算要读的四张表 + 写的一张表
// ----------------------------------------------------------------------------
// 为什么这些读取单独写在这里、而不是复用「按日」的那几个读取器：
//   分歧判定是【窗口级】的 —— 一次要 20 个交易日 × 4 张表。按日循环会变成 80 个请求，
//   在 9:27 那一轮（本身还有补量比 / 自愈）里不可接受。⇒ 统一按 `date=in.(...)` 批量取，
//   每个表 1~6 页（`sbGetPaged` 带确定性 order，§2 红线：⛔ 不许写死无分页的 limit）。
//
// ★ 为什么「日期列表」也从 auction_watchlist 取：
//   本仓没有一份「云端权威交易日历」，而 auction_watchlist 是每天 9:25 必写的表
//   ⇒ 它上面出现过的日期就是「有过早盘竞价的日子」。⛔ 不用 fuyao / 用户假期设置
//   （那要多一条外部依赖，而且 9:27 / 16:00 这两个时点不该再引上游请求）。
// ============================================================================

/** PostgREST 的 in 列表（中文/文本值统一加双引号；⛔ 不用正则去引号，见 readDailyLegsForStocks 注） */
function _sbInList(values) {
  const arr = (values || []).map(function (v) { return '"' + String(v).split('"').join('') + '"'; });
  return '(' + arr.join(',') + ')';
}

/** 按 Range 分页读，直到 enough(rows) 为真或页数用尽（用于「够了就停」的低成本读取） */
async function sbGetUntil(env, url, enough, maxPages) {
  const PAGE = 1000;
  const cap = maxPages > 0 ? maxPages : 8;
  const out = [];
  for (let p = 0; p < cap; p++) {
    const from = p * PAGE;
    const resp = await sbFetch(url, {
      headers: Object.assign(sbHeaders(env), {
        'Range': from + '-' + (from + PAGE - 1),
        'Range-Unit': 'items'
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('分页读取失败 (from=' + from + '): HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    const page = await resp.json();
    if (!Array.isArray(page) || page.length === 0) break;
    page.forEach(function (r) { out.push(r); });
    if (typeof enough === 'function' && enough(out)) break;
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * 取 throughDate（**不含**）往前的最近 wantDays 个交易日（升序返回）。
 *
 * 数据源：`auction_watchlist.date`（每天 9:25 必写）。实测每天 ~77~200 行
 * ⇒ 1000 行约 10~13 天，wantDays=20 时通常 2 页即够。
 *
 * §10：读失败抛错（调用方据此报 ok=false，⛔ 不当「没有交易日」）；
 *      返回的日期数不足 wantDays ⇒ 原样返回并由调用方如实记录（不猜、不补）。
 *
 * @param {object} env
 * @param {string} throughDate YYYY-MM-DD（不含）
 * @param {number} wantDays
 * @returns {Promise<string[]>} 升序 YYYY-MM-DD
 */
export async function readRecentTradeDates(env, throughDate, wantDays) {
  const want = Number(wantDays) > 0 ? Math.floor(Number(wantDays)) : 20;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?select=date' +
    '&date=lt.' + encodeURIComponent(String(throughDate || '')) +
    '&order=date.desc&limit=1000';
  const dates = [];
  const set = new Set();
  const rows = await sbGetUntil(env, url, function (acc) {
    const s = new Set();
    acc.forEach(function (r) {
      const d = String((r && r.date) || '').slice(0, 10);
      if (d) s.add(d);
    });
    return s.size >= want;
  }, 8);
  rows.forEach(function (r) {
    const d = String((r && r.date) || '').slice(0, 10);
    if (d && !set.has(d)) { set.add(d); dates.push(d); }
  });
  // 降序收集 ⇒ 反转成升序（判定窗口按时间正序才有意义）
  return dates.slice(0, want).reverse();
}

/**
 * 读若干日的 auction_watchlist（只取分歧判定要的两列：当日竞价量 / 昨日成交量）。
 * @returns {Promise<Array<{date:string,stock:string,volume:*,yest_volume:*}>>}
 */
export async function readAuctionRowsForDates(env, dates) {
  const list = Array.from(new Set((dates || []).filter(Boolean)));
  if (list.length === 0) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist' +
    '?select=date,stock,volume,yest_volume&date=in.' + _sbInList(list) +
    '&order=date.asc,stock.asc';
  const rows = await sbGetPaged(env, url);
  return (rows || []).map(function (r) {
    return {
      date: String((r && r.date) || '').slice(0, 10),
      stock: String((r && r.stock) || '').trim(),
      volume: r && r.volume,
      yest_volume: r && r.yest_volume
    };
  }).filter(function (r) { return r.date && r.stock; });
}

/**
 * 读若干日的 market_metrics(scope='auction')：竞价涨幅（判 D1 低开）+ 收盘涨幅（反解 20 日涨幅的 T 腿）。
 * ⚠️ `change_pct` 在 9:27 那一刻**还不是收盘值**（收盘覆盖的 pg_cron 从未真正生效，见
 *    db/supabase_auction_close_cron.sql 注释）⇒ 反解 T 腿时它是「当时的 T 腿」，
 *    与 `stock_range20_pct` 里那一行的 leg 是同一时点的，所以反解自洽；
 *    **判「涨停 / 收绿」一律不用它**，用 `stock_daily_pct.pct`（见 leader-diverge.js 文件头）。
 * @returns {Promise<Array<{date,stock,code,auc_pct_chg,change_pct}>>}
 */
export async function readMetricsForDates(env, dates) {
  const list = Array.from(new Set((dates || []).filter(Boolean)));
  if (list.length === 0) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics' +
    '?select=date,stock,code,auc_pct_chg,change_pct&scope=eq.auction&date=in.' + _sbInList(list) +
    '&order=date.asc,stock.asc';
  const rows = await sbGetPaged(env, url);
  return (rows || []).map(function (r) {
    return {
      date: String((r && r.date) || '').slice(0, 10),
      stock: String((r && r.stock) || '').trim(),
      code: String((r && r.code) || '').trim(),
      auc_pct_chg: r && r.auc_pct_chg,
      change_pct: r && r.change_pct
    };
  }).filter(function (r) { return r.date && r.stock; });
}

/**
 * 读若干日的 stock_range20_pct（原始行：pct / days / leg）。
 * ⚠️ 主键是 (date,stock,leg) ⇒ 同一天同股可能有两行，去重交给调用方（见 leader-diverge-days.js：
 *    **有 auc 腿就优先用它**，原值即 9:25 竞价口径，无需反解）。
 * @returns {Promise<Array<{date,stock,pct,days,leg}>>}
 */
export async function readRange20ForDates(env, dates) {
  const list = Array.from(new Set((dates || []).filter(Boolean)));
  if (list.length === 0) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct' +
    '?select=date,stock,pct,days,leg&date=in.' + _sbInList(list) +
    '&order=date.asc,stock.asc,leg.asc';
  const rows = await sbGetPaged(env, url);
  return (rows || []).map(function (r) {
    return {
      date: String((r && r.date) || '').slice(0, 10),
      stock: String((r && r.stock) || '').trim(),
      pct: r && r.pct,
      days: r && r.days,
      leg: String((r && r.leg) || '').trim()
    };
  }).filter(function (r) { return r.date && r.stock; });
}

/**
 * 读若干日的 stock_daily_pct（收盘涨幅真值 —— 判涨停 / 判「高开低走收绿」的唯一来源）。
 * @returns {Promise<Array<{date,stock,pct}>>}
 */
export async function readDailyPctForDates(env, dates) {
  const list = Array.from(new Set((dates || []).filter(Boolean)));
  if (list.length === 0) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_daily_pct' +
    '?select=date,stock,pct&date=in.' + _sbInList(list) +
    '&order=date.asc,stock.asc';
  const rows = await sbGetPaged(env, url);
  return (rows || []).map(function (r) {
    return {
      date: String((r && r.date) || '').slice(0, 10),
      stock: String((r && r.stock) || '').trim(),
      pct: r && r.pct
    };
  }).filter(function (r) { return r.date && r.stock; });
}

/**
 * 写 tvrb_leader_diverge（主键 date,stock；幂等覆盖）。
 * §10：失败抛错，由调用方记日志（⛔ 不许静默）。
 */
export async function upsertLeaderDivergeRows(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'tvrb_leader_diverge',
    CONFIG.SUPABASE_URL + '/rest/v1/tvrb_leader_diverge?on_conflict=date,stock', rows);
}
