// ===== bidding-auto-fetch — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-09-10 15:13:58
// 注意: 此文件自动生成，请勿手动编辑

// ────── _shared-source/date-utils.js ──────
// date-utils.js — 北京时间日期工具（源文件，各 Worker 复制使用）

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function beijingToday() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function beijingTodayCompact() {
  return beijingToday().replace(/-/g, '');
}

function normalizeDate(value) {
  if (!value) return '';
  const s = String(value).trim().replace(/-/g, '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return '';
}

function compactToDateStr(compact) {
  if (!compact) return '';
  const s = String(compact).replace(/-/g, '');
  if (s.length === 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return normalizeDate(compact);
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function msToDateStr(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function dateStrToMs(dateStr) {
  return Date.parse(dateStr + 'T00:00:00+08:00');
}


// ────── _shared-source/holidays.js ──────
// holidays.js — 节假日表 + 本地交易日判断（源文件，各 Worker 复制使用）
const KNOWN_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-04-04', '2025-04-05',
  '2025-04-06', '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04',
  '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02', '2025-10-03',
  '2025-10-06', '2025-10-07', '2025-10-08',
  '2026-01-01', '2026-01-02', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', '2026-04-05',
  '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04',
  '2026-05-05', '2026-06-19', '2026-10-01', '2026-10-02', '2026-10-03',
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'
]);

function localIsTradingDay(dateStr) {
  if (isWeekend(dateStr)) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

// ────── bidding-auto-fetch/config.js ──────
// config.js — bidding-auto-fetch 配置
const CONFIG = {
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',
  FUYAO_PROXY_BASE: 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy',

  // fuyao 直连（历史K线用新账号 key，避免拖慢主账号）
  FUYAO_DIRECT_BASE: 'https://fuyao.aicubes.cn',

  // 最近多板指数
  LADDER_THSCODE: '883410.TI',

  // numcat daily_auc 接口
  NUMCAT_DAILY_AUC_URL: 'https://numcat.net/api/reference-proxy/stock/daily_auc',
  // numcat daily 接口（收盘涨幅 pct_chg）
  NUMCAT_DAILY_URL: 'https://numcat.net/api/reference-proxy/stock/daily',
  NUMCAT_RECENT_DAYS: 5,
  // 说明：「近 10 个交易日区间涨幅」的窗口天数不在这里配置 ——
  // 直接复用 src/logic/auction/range-window.js 的 RANGE_WINDOW_DAYS（前后端单一真相），
  // 避免出现「前端窗口 10 天 / worker 窗口 5 天」的静默失配。见 logic/morning-workflow.js 步骤5。

  // fuyao snapshot 批量大小
  SNAPSHOT_BATCH_SIZE: 40,

  // fuyao historical 并发数（同时发起的请求数，避免被限流）
  HISTORICAL_CONCURRENCY: 10,
};

// ────── bidding-auto-fetch/data/fuyao-api.js ──────
// fuyao-api.js — 同花顺 fuyao 接口（proxy + 直连历史K线）
async function fuyaoProxyGet(env, path, params) {
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  }
  const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao-proxy ' + path + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao ' + path + ' 错误: ' + (json.message || 'code=' + json.code));
  return json.data;
}

// 调 fuyao 交易日历，返回最近 N 天交易日列表（升序）
async function fuyaoCalendarTradingDays(env) {
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', '/api/a-share/calendar/trading-days');
  const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao calendar HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao calendar 错误: ' + (json.message || 'code=' + json.code));
  const items = (json.data && json.data.item) || [];
  return items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
}

// 获取最近多板成分股 → [{ name, code }]
async function fetchLadderConstituents(env) {
  const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: CONFIG.LADDER_THSCODE });
  const items = (data && data.item) || [];
  return items.map(it => {
    const name = (it.name || '').trim();
    let code = '';
    if (it.ticker) code = String(it.ticker).trim();
    else if (it.thscode) {
      const c = String(it.thscode).trim().replace(/\..*$/, '');
      if (/^\d{6}$/.test(c)) code = c;
    }
    return { name, code };
  }).filter(s => s.name && s.code);
}

function tickerToThscode(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return '';
  if (c.startsWith('6') || c.startsWith('9')) return c + '.SH';
  if (c.startsWith('4') || c.startsWith('8')) return c + '.BJ';
  return c + '.SZ';
}

// 【FIX 2026-08-03】增加 stats 参数，空值不再静默 return，而是累计 emptyField 计数
function applySnapshotItem(it, code, result, stats) {
  const pct = it.price_change_ratio_pct;
  if (pct === null || pct === undefined || pct === '') {
    if (stats) stats.emptyField++;
    return;
  }
  const n = Number(pct);
  if (isNaN(n)) {
    if (stats) stats.emptyField++;
    return;
  }
  let ratio = n;
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && ratio > 0) ratio = -ratio;
  result[code] = (ratio >= 0 ? '+' : '') + ratio.toFixed(2) + '%';
}

// fuyao snapshot 批量获取收盘涨幅 → { pctMap: { code: pctStr }, stats: {...} }
async function fetchSnapshotChangePct(env, codes) {
  const result = {};
  const stats = {
    totalInput: codes.length,
    batchOk: 0,
    batchFail: 0,
    singleOk: 0,
    singleFail: 0,
    itemsReturned: 0,
    emptyField: 0,
    notMatched: 0,
    success: 0
  };
  const batchSize = CONFIG.SNAPSHOT_BATCH_SIZE;
  for (let i = 0; i < codes.length; i += batchSize) {
    const chunk = codes.slice(i, i + batchSize);
    const thscodes = chunk.map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    let data;
    try {
      data = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscodes });
      stats.batchOk++;
    } catch (batchErr) {
      stats.batchFail++;
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscode });
          stats.singleOk++;
          const items1 = (d1 && d1.item) || [];
          stats.itemsReturned += items1.length;
          items1.forEach(it => applySnapshotItem(it, code, result, stats));
        } catch (e1) {
          stats.singleFail++;
        }
      }
      continue;
    }
    const items = (data && data.item) || [];
    stats.itemsReturned += items.length;
    const codeSet = new Set(chunk);
    items.forEach(it => {
      const tcode = String(it.thscode || '').replace(/\..*$/, '');
      if (tcode && codeSet.has(tcode)) {
        applySnapshotItem(it, tcode, result, stats);
      } else {
        stats.notMatched++;
      }
    });
  }
  stats.success = Object.keys(result).length;
  return { pctMap: result, stats };
}

// 直连 fuyao（用新账号 key，绕过 supabase proxy）
async function fuyaoDirectHistorical(env, thscode, startMs, endMs) {
  const apiKey = env.FUYAO_API_KEY_HISTORY || env.FUYAO_API_KEY;
  if (!apiKey) {
    return { thscode, error: '缺少 FUYAO_API_KEY_HISTORY' };
  }
  const url = new URL(CONFIG.FUYAO_DIRECT_BASE + '/api/a-share/prices/historical');
  url.searchParams.set('thscode', thscode);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('start', String(startMs));
  url.searchParams.set('end', String(endMs));
  url.searchParams.set('adjust', 'none');
  try {
    const resp = await fetch(url.toString(), { headers: { 'X-api-key': apiKey } });
    const json = await resp.json();
    if (json.code !== 0) {
      return { thscode, error: 'fuyao historical code=' + json.code + ' ' + (json.message || '') };
    }
    const items = ((json.data && json.data.item) || []).map(it => ({
      dateStr: msToDateStr(it.date_ms),
      close: Number(it.close_price)
    })).filter(it => !isNaN(it.close));
    items.sort((a, b) => a.dateStr < b.dateStr ? -1 : (a.dateStr > b.dateStr ? 1 : 0));
    return { thscode, items };
  } catch (e) {
    return { thscode, error: e.message };
  }
}

// 并发抓取所有成分股的历史K线，计算历史交易日的收盘涨幅
// 返回 { byDate: { dateStr: { code: "+X.XX%" } }, successCount, failCount }
async function fetchHistoricalPctChg(env, constituents, historicalDates) {
  if (!constituents.length || !historicalDates.length) return { byDate: {}, successCount: 0, failCount: 0 };
  const result = {};
  historicalDates.forEach(d => { result[d] = {}; });

  const earliest = historicalDates.slice().sort()[0];
  const startMs = dateStrToMs(earliest) - 7 * 24 * 3600 * 1000;
  const endMs = Date.now();

  const targetSet = new Set(historicalDates);
  let successCount = 0, failCount = 0;

  const concurrency = CONFIG.HISTORICAL_CONCURRENCY;
  for (let i = 0; i < constituents.length; i += concurrency) {
    const chunk = constituents.slice(i, i + concurrency);
    const promises = chunk.map(c => {
      const thscode = tickerToThscode(c.code);
      if (!thscode) return Promise.resolve(null);
      return fuyaoDirectHistorical(env, thscode, startMs, endMs);
    });
    const results = await Promise.all(promises);
    results.forEach((r, idx) => {
      if (!r) return;
      const code = chunk[idx].code;
      if (r.error) {
        failCount++;
        return;
      }
      for (let j = 1; j < r.items.length; j++) {
        const dateStr = r.items[j].dateStr;
        if (!targetSet.has(dateStr)) continue;
        const prevClose = r.items[j - 1].close;
        const currClose = r.items[j].close;
        if (!prevClose || isNaN(prevClose) || prevClose === 0) continue;
        const pct = (currClose - prevClose) / prevClose * 100;
        if (isNaN(pct)) continue;
        result[dateStr][code] = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      }
      successCount++;
    });
  }

  return { byDate: result, successCount, failCount };
}

// ────── bidding-auto-fetch/data/numcat-api.js ──────
// numcat-api.js — 猫抓 numcat daily_auc + daily 接口
async function numcatDailyAuc(env, symbols, startDateYMD, endDateYMD) {
  // 【FIX 2026-08-03】改用显式 startdate/enddate（YYYYMMDD），不再用 recentdays
  const body = {
    apiname: 'daily_auc',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover',
    params: {
      symbols: symbols,
      startdate: startDateYMD,
      enddate: endDateYMD
    }
  };
  const resp = await fetch(CONFIG.NUMCAT_DAILY_AUC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('numcat daily_auc HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('numcat daily_auc 错误: ' + (json.message || JSON.stringify(json)));
  return json.data;
}

async function numcatDaily(env, symbols, startDateYMD, endDateYMD) {
  const body = {
    apiname: 'daily',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,tradedate,pct_chg',
    params: {
      symbols: symbols,
      startdate: startDateYMD,
      enddate: endDateYMD
    }
  };
  const resp = await fetch(CONFIG.NUMCAT_DAILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('numcat daily HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('numcat daily 错误: ' + (json.message || JSON.stringify(json)));
  return json.data;
}

// ────── bidding-auto-fetch/data/supabase-write.js ──────
// supabase-write.js — Supabase 写入接口
function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

async function upsertAuctionWatchlist(env, rows) {
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

async function upsertMarketMetrics(env, rows) {
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

async function updateStockCodeMap(env, pairs) {
  // stockCodeMap 存在 localStorage，前端从 auction_watchlist 读取 code 回填
}

/**
 * [PLAN-A 2026-09-10] 写入「近 10 个交易日区间涨幅」缓存（stock_range_pct，主键 date+stock）。
 * 由 9:25 morning 那一次 numcat daily 请求算好后落库，前端只读云端、不再自行抓取。
 * @param {Array<{date:string, stock:string, range_pct:string|null, days:number, updated_at:string}>} rows
 */
async function upsertStockRangePct(env, rows) {
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
async function readMarketMetricsForDate(env, date, scope) {
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
async function readStockRangePctForDate(env, date) {
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
async function readAuctionWatchlistForDate(env, date) {
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
async function readAuctionTagsForDate(env, date) {
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
async function readStockCodeMap(env) {
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

// ────── bidding-auto-fetch/logic/holiday-check.js ──────
// holiday-check.js — 交易日判断（优先 fuyao 交易日历，失败回退本地）
async function isTradingDay(env, dateStr) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    return dates.includes(dateStr);
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退本地日历:', e.message);
    return localIsTradingDay(dateStr);
  }
}

// 取"截止到 todayStr（含）"最近 n 个真实交易日，升序返回 ["YYYY-MM-DD", ...]
// 【FIX 2026-08-03】优先走 fuyao 交易日历，失败时回退本地节假日表推算
async function getRecentTradingDays(env, todayStr, n) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    const upToToday = dates.filter(d => d <= todayStr);
    if (upToToday.length > 0) {
      return upToToday.slice(-n);
    }
  } catch (e) {
    console.warn('[RECENT-TD] fuyao 交易日历失败，回退本地日历: ' + e.message);
  }
  const result = [];
  let ms = Date.parse(todayStr + 'T00:00:00+08:00');
  for (let i = 0; i < 60 && result.length < n; i++) {
    const d = new Date(ms);
    const s = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    if (localIsTradingDay(s)) result.unshift(s);
    ms -= 24 * 3600 * 1000;
  }
  return result;
}

// ────── ../src/logic/auction/range-window.js ──────
// range-window.js — 「近 N 个交易日区间涨幅」的窗口口径纯函数（Logic 层 §15 独立业务模块）
//
// 为什么单独成模块：
//   区间涨幅是「龙一/龙二排名」的唯一排序依据，口径一旦混用就会系统性失真（不是个别股票问题）。
//   以下三条规则 + 「组装成行」必须只有一份实现，所有计算路径共用：
//     · worker 早盘 9:25 首算（T 腿=竞价涨幅）→ buildRangeRows
//     · worker 收盘 16:00 重算（T 腿=收盘涨幅）→ buildRangeRows
//     · 前端兜底抓取 / 收盘 T 腿换算 → buildRangeRows / replaceTDayLeg
//
//   ① 窗口 = [T-9, T] 共 10 个交易日（含当天 T）；
//   ② 区间涨幅 = 窗口内各日涨幅【复利累乘】∏(1+r) - 1（不是简单相加）；
//   ③ 当天(T)腿口径：
//        - 仅当「看板日期 = 系统今天」且「未到 15:00 收盘」→ 用 9:25 竞价涨幅占位（当日尚未走完）；
//        - 其余情况（今天已收盘 / 历史日期）→ 一律用当日【收盘涨幅】。
//      ⚠️ 历史日期若误用竞价涨幅，等于把「已经完整走完的一天」当成只走了竞价，区间涨幅与龙一
//         排名会系统性偏低；而且 stock_range_pct 是按【日期级】复用的——同一天不同股票的腿口径
//         混杂后，排名就不可比了。
//
// 纯函数红线：不读 state、不发请求、不碰 DOM、不写库。

const RANGE_WINDOW_DAYS = 10;

/**
 * 标准化涨幅值：接受 number / '2.34%' / '+2.34%' / '-7.71%' / '' / null。
 * 无法解析时返回 null（绝不返回 0 —— 0 是一个真实涨幅，不能拿来表示「没有数据」）。
 * @param {*} raw
 * @returns {number|null}
 */
function parsePct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isFinite(n) ? n : null;
}

/**
 * 复利累乘：日涨幅数组 → 区间涨幅(%)。
 * @param {number[]} pctList
 * @returns {number|null} 空数组返回 null（不伪造 0）
 */
function compoundPct(pctList) {
  if (!pctList || pctList.length === 0) return null;
  let acc = 1;
  for (const p of pctList) {
    if (p === null || p === undefined || isNaN(p)) continue;
    acc *= (1 + p / 100);
  }
  return (acc - 1) * 100;
}

/**
 * 当天(T)腿是否为「竞价占位」口径。
 * @param {string} date - 看板日期 YYYY-MM-DD
 * @param {string} sysToday - 系统今天 YYYY-MM-DD
 * @param {boolean} afterClose - 是否已过 15:00（北京）
 * @returns {boolean}
 */
function isAuctionLegActive(date, sysToday, afterClose) {
  return !!date && date === sysToday && !afterClose;
}

/**
 * 解析「当天(T)腿」涨幅 —— 口径单一真相。
 * @param {boolean} isToday - 看板日期是否就是系统今天
 * @param {boolean} afterClose - 是否已过 15:00（北京）
 * @param {*} closePct - 当日收盘涨幅（日线源 / 行内常规涨幅）
 * @param {*} aucPct - 当日 9:25 竞价涨幅
 * @returns {number|null}
 */
function resolveTDayPct(isToday, afterClose, closePct, aucPct) {
  const c = parsePct(closePct);
  const a = parsePct(aucPct);
  if (isToday && !afterClose) return a; // 今天未收盘：只有竞价涨幅可用
  return c !== null ? c : a;            // 已收盘/历史：收盘优先，取不到才退回竞价
}

/**
 * 【组装区间涨幅行】「窗口 + 复利 + T 腿」三条规则的唯一实现（worker 早盘 / worker 收盘共用）。
 *
 * 调用方只负责「准备数据」：
 *   · rangeDates  —— 升序交易日 [T-9 ... T]；
 *   · dailyByCode —— code -> { YYYYMMDD: 日涨幅 }，历史日数据（当天由 tLegByCode 覆盖，此处可有可无）；
 *   · tLegByCode  —— code -> 当天(T)腿涨跌幅（9:25 竞价涨幅 / 收盘涨幅，由调用方决定口径）。
 * 本函数只做：逐日取腿 → 复利累乘 → 输出 { stock, code, pct, days }，不读写 state / 不发请求。
 *
 * ⚠️ tLegByCode 缺该股票时，当天那根腿【不参与】累乘（days 会少 1）——调用方应先按
 *    「当天腿是否可得」筛掉目标，否则会算出「不含当天」的残缺区间涨幅。
 *
 * @param {Array<{name:string, code:string}>} targets 参与计算的股票（按 name 去重，先到先得）
 * @param {string[]} rangeDates 升序交易日 ['YYYY-MM-DD', ...]
 * @param {Object} dailyByCode code -> { YYYYMMDD: number }
 * @param {Object} tLegByCode code -> number 当天(T)腿涨跌幅
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>}
 */
function buildRangeRows(targets, rangeDates, dailyByCode, tLegByCode) {
  const rows = [];
  if (!targets || targets.length === 0 || !rangeDates || rangeDates.length === 0) return rows;
  const tYmd = String(rangeDates[rangeDates.length - 1]).replace(/-/g, '');
  const seen = new Set();
  targets.forEach(function(t) {
    if (!t || !t.code || !t.name) return;
    const name = String(t.name).trim();
    if (!name || seen.has(name)) return;
    const dm = (dailyByCode && dailyByCode[t.code]) || null;
    const legs = [];
    rangeDates.forEach(function(d) {
      const ymd = String(d).replace(/-/g, '');
      let v;
      if (ymd === tYmd) {
        v = tLegByCode ? tLegByCode[t.code] : undefined;
      } else {
        v = dm && Object.prototype.hasOwnProperty.call(dm, ymd) ? dm[ymd] : null;
      }
      if (v === null || v === undefined || !isFinite(v)) return;
      legs.push(Number(v));
    });
    const pct = compoundPct(legs);
    if (pct === null) return; // 一个交易日都没有 → 不写空行（避免前端反复兜底抓取）
    seen.add(name);
    rows.push({ stock: name, code: t.code, pct: pct, days: legs.length });
  });
  return rows;
}

/**
 * 【替换当天(T)腿】已知「用旧 T 腿算出的区间涨幅」，求「换成新 T 腿后的区间涨幅」。
 *
 * 用途（方案A）：9:25 worker 用【竞价涨幅】做 T 腿把区间涨幅算好并落库；
 * 收盘后 T 腿应改成【收盘涨幅】—— 区间涨幅是复利累乘，只需把 T 腿那一项换掉，
 * 无需重新拉 9 天历史日线（0 额外请求）。
 *
 *   区间涨幅 = ∏(1+r) - 1 = prevAcc × (1 + tLeg) - 1
 *   prevAcc        = (1 + rangePct) ÷ (1 + oldLeg)     ← 去掉旧 T 腿（oldLeg=0 时因数即 1）
 *   新区间涨幅      = prevAcc × (1 + newLeg) - 1
 *
 * @param {*} rangePct 已存的区间涨幅（%）
 * @param {*} oldLeg 旧的 T 腿涨幅（%）；null/0 表示当时不含 T 腿（等价于因数 1）
 * @param {*} newLeg 新的 T 腿涨幅（%）
 * @returns {number|null} 新区间涨幅（%）；任一必需入参不可用 → null（绝不伪造 0）
 */
function replaceTDayLeg(rangePct, oldLeg, newLeg) {
  const r = parsePct(rangePct);
  const n = parsePct(newLeg);
  if (r === null || n === null) return null;
  const o = parsePct(oldLeg);
  const oldFactor = 1 + (o === null ? 0 : o) / 100;
  if (oldFactor === 0) return null; // 旧腿 -100%（理论不可能）→ 无法反解，放弃而不是给错值
  const prevAcc = (1 + r / 100) / oldFactor;
  const next = (prevAcc * (1 + n / 100) - 1) * 100;
  return isFinite(next) ? next : null;
}


// ────── bidding-auto-fetch/logic/morning-workflow.js ──────
// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为 7 个子函数）
// [PLAN-A 2026-09-10] 区间涨幅口径复用前端同一份纯函数（单一真相 §6）：
// 窗口天数 / 复利累乘 / T 腿竞价占位判定 全部只此一份，前后端不会算出两个结果。
// ⚠️ 跨目录引用会让 workers/_bundle.mjs 把该文件一并打进单文件产物（Cloudflare 复制粘贴部署），
//    因此 src/logic/auction/range-window.js 必须保持「零 import 的纯函数」，不得引入 Vue / DOM 依赖。
/** 与 range-window.RANGE_WINDOW_DAYS 同源；显式断言避免有人改动窗口天数后 worker 静默失配 */
const RANGE_DAYS = RANGE_WINDOW_DAYS;

// 1. 检查是否交易日
function checkTradingDay(today, logs) {
  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }
  return null;
}

// 2. 获取最近多板成分股 + 写入 auction_watchlist
async function fetchAndWriteWatchlist(env, today, logs) {
  logs.push('步骤1：获取最近多板成分股...');
  let ladderConstituents;
  try {
    ladderConstituents = await fetchLadderConstituents(env);
  } catch (e) {
    logs.push('获取成分股失败: ' + e.message);
    return { error: '获取成分股失败: ' + e.message };
  }
  logs.push('成分股数量: ' + ladderConstituents.length);
  if (ladderConstituents.length === 0) {
    return { error: '883410 成分股为空' };
  }

  // [BUG-FIX] 合并前一日 auction_watchlist 表里的额外股票（打标签/观察组），
  // 确保 worker 也为它们抓取竞价数据，否则观察组股票早上没有数据
  let constituents = ladderConstituents;
  try {
    // [FIX 2026-08-15] 观察组/打标签股票在 watchlist 表里 code 常为空（worker 从不写 code 到这些行），
    // 用 stockcodemap 表按名称补 code，否则 numcat 按 code 抓取时这些股票会被跳过 → 观察组当天无数据。
    const codeMap = await readStockCodeMap(env);
    const recentDays = await getRecentTradingDays(env, today, 2);
    const prevDay = recentDays.length >= 2 ? recentDays[recentDays.length - 2] : null;
    if (prevDay) {
      const prevStocks = await readAuctionWatchlistForDate(env, prevDay);
      const existingCodes = new Set(ladderConstituents.map(c => c.code));
      const extraStocks = prevStocks.filter(s => {
        const code = s.code || codeMap[s.name] || '';
        return code && !existingCodes.has(code);
      }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
      if (extraStocks.length > 0) {
        logs.push('前一日额外股票(打标签/观察组): ' + extraStocks.length + ' 只（stockcodemap 补 code ' +
          extraStocks.filter(s => s.code).length + ' 只），合并到抓取名单');
        constituents = ladderConstituents.concat(extraStocks);
      }
    }
  } catch (e) { logs.push('读取前一日 watchlist 失败(非致命): ' + e.message); }

  // [BUG-FIX] 也读今日 auction_watchlist，合并用户在前端提前打开页面时已加入的股票
  // （ensureBoughtStocksForDate / ensureObservationStocks 从前日 stocksData 继承的打标签/观察组票，
  // 已推送到云端今日 watchlist，但不在前一日 watchlist 里，worker 只读前一日会漏掉）
  try {
    const codeMap = await readStockCodeMap(env);
    const todayStocks = await readAuctionWatchlistForDate(env, today);
    const existingCodes = new Set(constituents.map(c => c.code));
    const todayExtra = todayStocks.filter(s => {
      const code = s.code || codeMap[s.name] || '';
      return code && !existingCodes.has(code);
    }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
    if (todayExtra.length > 0) {
      logs.push('今日 watchlist 额外股票(前端提前继承): ' + todayExtra.length + ' 只，合并到抓取名单');
      constituents = constituents.concat(todayExtra);
    }
  } catch (e) { logs.push('读取今日 watchlist 失败(非致命): ' + e.message); }

  // [FEAT 2026-09-08] 合并「上一交易日打过标签（买/卖/持有）」的股票到抓取名单。
  // 用户靠标签复盘买卖对错，这些票次日必须在列表里且有数据。watchlist 合并覆盖不到两种情况：
  //   ① 用户是在「观察组空壳行」上打的标签——空壳只存在于前端视图层，不落库，
  //      因此前一日/今日 auction_watchlist 里都没有它（9/8 实测：赤天化、沃华医药全天无数据）；
  //   ② 前端尚未打开过次日页面，继承行还没推送到今日 watchlist。
  // 直接读 auction_board_tags 是最稳的补齐方式。只并入 constituents（market_metrics 抓取名单），
  // 不写 auction_watchlist → 不破坏「当日名单 = 9:25 快照」的锁定口径（§6）。
  try {
    const codeMap = await readStockCodeMap(env);
    const recentDays2 = await getRecentTradingDays(env, today, 2);
    const prevTagDay = recentDays2.length >= 2 ? recentDays2[recentDays2.length - 2] : null;
    if (prevTagDay) {
      const tagRows = await readAuctionTagsForDate(env, prevTagDay);
      if (tagRows.length > 0) {
        const existingNames = new Set(constituents.map(c => c.name));
        const existingCodes = new Set(constituents.map(c => c.code));
        const tagExtra = [];
        tagRows.forEach(function(t) {
          if (existingNames.has(t.name)) return;
          const code = codeMap[t.name] || '';
          if (!code || existingCodes.has(code)) return;
          existingNames.add(t.name);
          existingCodes.add(code);
          tagExtra.push({ name: t.name, code: code });
        });
        if (tagExtra.length > 0) {
          logs.push('前一日(' + prevTagDay + ')打标签股票(买/卖/持有): ' + tagExtra.length +
            ' 只，合并到抓取名单（不写 watchlist）');
          constituents = constituents.concat(tagExtra);
        }
      }
    }
  } catch (e) { logs.push('读取前一日打标签股票失败(非致命): ' + e.message); }

  // 【BUG-FIX】不写 volume/yest_volume/change_pct/note/topics 字段：
  // 这些字段的真实值由步骤4写入 market_metrics 表。如果这里把空串写进 watchlist，
  // 后续每个交易日的 morning 都会用空串覆盖用户在前端手动编辑过的值。
  // 只为 883410 成分股写入 auction_watchlist（额外股票已在表里，不覆盖 obs_auto_added 等字段）
  logs.push('步骤2：写入 auction_watchlist...');
  const nowIso = new Date().toISOString();
  const watchlistRows = ladderConstituents.map(c => ({
    date: today,
    stock: c.name,
    code: c.code,
    source: 'worker',
    obs_auto_added: false,
    updated_at: nowIso,
    updated_by: 'auto-fetch-worker'
  }));
  // 【9:25 名单锁定 2026-09-07】当日名单只允许由 9:25 那一轮抓取确定，窗口外绝不新增。
  // 背景：最近多板成分股在盘中/收盘后会持续变多（更多票涨停晋级）。此前只要重复触发 morning
  // （cron 重试或手动 /fetch?point=morning），就会用最新成分股再 upsert 一次，新股票被不断补进
  // 当日名单 → 9/7 实测：09:25 写入 45 只，13:14 又补进 28 只，当日总数从 55 膨胀到 83。
  // 用户口径：只要「9:25 拉取的最近多板个股列表」。因此：
  //   · 9:25~9:40 窗口内 → 正常写入（新增 + 更新）；
  //   · 窗口外          → 只更新已存在的行，跳过新出现的成分股（不改写当日名单）。
  const nowBj = beijingNow();
  const bjMinutes = nowBj.getUTCHours() * 60 + nowBj.getUTCMinutes();
  const inMorningWindow = bjMinutes >= 9 * 60 + 25 && bjMinutes <= 9 * 60 + 40;
  let rowsToWrite = watchlistRows;
  if (!inMorningWindow) {
    let existingNames = new Set();
    try {
      const existing = await readAuctionWatchlistForDate(env, today);
      existingNames = new Set(existing.map(s => s.name));
    } catch (e) {
      logs.push('读取当日 watchlist 失败(非致命): ' + e.message);
    }
    if (existingNames.size === 0) {
      // 兜底：当日名单为空说明 9:25 那轮根本没写成（没有"快照"可锁），此时允许全量写入，
      // 否则当天会一直拿不到名单（§10：读取失败 / 空数据不能当成"今天没有股票"）。
      logs.push('非 9:25 抓取窗口，但当日名单为空 → 视为 9:25 那轮未成功，允许全量写入 ' +
        rowsToWrite.length + ' 行');
    } else {
      const before = rowsToWrite.length;
      rowsToWrite = rowsToWrite.filter(r => existingNames.has(r.stock));
      logs.push('非 9:25 抓取窗口（当前北京 ' + String(nowBj.getUTCHours()).padStart(2, '0') + ':' +
        String(nowBj.getUTCMinutes()).padStart(2, '0') + '）：当日名单锁定为 9:25 快照，只更新已存在的 ' +
        rowsToWrite.length + ' 行，跳过 ' + (before - rowsToWrite.length) + ' 只新成分股');
    }
  }
  try {
    await upsertAuctionWatchlist(env, rowsToWrite);
    logs.push('auction_watchlist 写入 ' + rowsToWrite.length + ' 行');
  } catch (e) {
    logs.push('写入 auction_watchlist 失败: ' + e.message);
    return { error: '写入 auction_watchlist 失败: ' + e.message };
  }
  return { constituents, watchlistRows, nowIso };
}

// 3. 调 numcat daily_auc 获取竞价数据（含"今天缺失"延迟重试）
async function fetchNumcatWithRetry(env, constituents, today, logs) {
  // 【FIX 2026-08-03】先算出"预期要拿到数据的 N 个交易日"（含今天），再用显式 startdate/enddate 请求
  const expectedDates = await getRecentTradingDays(env, today, CONFIG.NUMCAT_RECENT_DAYS);
  logs.push('步骤3：预期交易日=' + JSON.stringify(expectedDates));
  if (expectedDates.length === 0 || expectedDates[expectedDates.length - 1] !== today) {
    logs.push('⚠️ 预期交易日列表不包含今天(' + today + ')，交易日历可能有问题，仍继续尝试');
  }
  const startYMD = expectedDates.length > 0 ? expectedDates[0].replace(/-/g, '') : today.replace(/-/g, '');
  const endYMD = today.replace(/-/g, '');
  logs.push('步骤3：调用 numcat daily_auc (startdate=' + startYMD + ' enddate=' + endYMD + ')...');
  const symbols = constituents.map(c => c.code).join(',');
  let numcatData;
  try {
    numcatData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
  } catch (e) {
    logs.push('numcat 调用失败: ' + e.message);
    return { error: 'numcat 调用失败: ' + e.message };
  }

  const fields = numcatData.fields || [];
  let items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  // 【FIX 2026-08-03】按预期交易日统计实际返回的行数，缺口清清楚楚打在日志里
  const dateIdxPre = fields.indexOf('tradedate');
  const computeGotDates = (rows) => new Set(rows.map(row => compactToDateStr(String(row[dateIdxPre] || '').trim())).filter(Boolean));
  let missingDatesAfterNumcat = [];
  if (dateIdxPre >= 0) {
    let gotDates = computeGotDates(items);
    let missingDates = expectedDates.filter(d => !gotDates.has(d));
    if (missingDates.length > 0) {
      logs.push('⚠️ numcat 缺失交易日: ' + JSON.stringify(missingDates) + '（预期 ' + JSON.stringify(expectedDates) + '，实际含 ' + JSON.stringify(Array.from(gotDates).sort()) + '）');
    } else {
      logs.push('numcat 覆盖了全部 ' + expectedDates.length + ' 个预期交易日');
    }

    // 【FIX 2026-08-03】若"今天"缺失，做 2 次延迟重试（20秒/40秒）
    if (missingDates.includes(today)) {
      const retryDelaysSec = [20, 40];
      for (let attempt = 0; attempt < retryDelaysSec.length && missingDates.includes(today); attempt++) {
        const waitSec = retryDelaysSec[attempt];
        logs.push('⏳ 今天(' + today + ')数据缺失，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
          const retryItems = retryData.items || [];
          const retryGotDates = computeGotDates(retryItems);
          if (retryGotDates.has(today)) {
            items = retryItems;
            gotDates = retryGotDates;
            missingDates = expectedDates.filter(d => !gotDates.has(d));
            logs.push('✅ 重试第' + (attempt + 1) + '次成功拿到今天数据，items=' + items.length + '行');
          } else {
            logs.push('第' + (attempt + 1) + '次重试仍未拿到今天数据（items=' + retryItems.length + '行）');
          }
        } catch (e) {
          logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message);
        }
      }
      if (missingDates.includes(today)) {
        logs.push('❌ 重试后今天(' + today + ')数据仍缺失，本次不会写入今天的 market_metrics，需要手动补抓');
      }
    }
    missingDatesAfterNumcat = missingDates;
  }

  const symIdx = fields.indexOf('symbol');
  const nameIdx = fields.indexOf('name');
  const dateIdx = fields.indexOf('tradedate');
  const volIdx = fields.indexOf('auc_vol');
  const pctIdx = fields.indexOf('auc_pct_chg');
  const ratioIdx = fields.indexOf('auc_to_pre_vol_pct');

  if (symIdx < 0 || dateIdx < 0 || volIdx < 0) {
    return { error: 'numcat 返回字段不完整: ' + JSON.stringify(fields) };
  }

  return { expectedDates, items, fields, symIdx, nameIdx, dateIdx, volIdx, pctIdx, ratioIdx, missingDatesAfterNumcat };
}

// 4. 解析 numcat 数据 → 按 date 分组 → metricsByDate
function parseNumcatToMetrics(items, fields, constituents, logs) {
  const symIdx = fields.indexOf('symbol');
  const nameIdx = fields.indexOf('name');
  const dateIdx = fields.indexOf('tradedate');
  const volIdx = fields.indexOf('auc_vol');
  const pctIdx = fields.indexOf('auc_pct_chg');
  const ratioIdx = fields.indexOf('auc_to_pre_vol_pct');
  const umIdx = fields.indexOf('um_vol');
  const obpIdx = fields.indexOf('open_bid_pct');
  const avrIdx = fields.indexOf('auc_vol_ratio');
  const atrIdx = fields.indexOf('auc_turnover');

  logs.push('步骤4：解析数据并写入 market_metrics...');
  const codeToName = {};
  constituents.forEach(c => { codeToName[c.code] = c.name; });

  const metricsByDate = {};
  let parsedCount = 0;
  let yestVolDerivedCount = 0;

  items.forEach(row => {
    const code = String(row[symIdx] || '').trim();
    const tradedate = String(row[dateIdx] || '').trim();
    const aucVol = row[volIdx];
    const apiName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;

    const dateStr = compactToDateStr(tradedate);
    if (!dateStr) return;

    const stockName = codeToName[code] || apiName || '';
    if (!stockName) return;

    // volume(万) = auc_vol(手) / 100
    const volNum = Number(aucVol);
    const volumeStr = isNaN(volNum) ? '' : String(Math.round(volNum / 100));

    // changePct = "+X.XX%"
    let changePctStr = '';
    if (pctIdx >= 0) {
      const pct = row[pctIdx];
      if (pct !== null && pct !== undefined && pct !== '') {
        const n = Number(pct);
        if (!isNaN(n)) {
          changePctStr = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
        }
      }
    }

    // yestVolume(万) = auc_vol(手) / auc_to_pre_vol_pct
    let yestVolumeStr = '';
    if (ratioIdx >= 0) {
      const ratio = row[ratioIdx];
      if (ratio !== null && ratio !== undefined && ratio !== '') {
        const r = Number(ratio);
        if (!isNaN(r) && r > 0 && volNum > 0) {
          yestVolumeStr = String(Math.round(volNum / r));
          yestVolDerivedCount++;
        }
      }
    }

    // auc_pct_chg（竞价涨幅）：与 change_pct 同源（均取自 auc_pct_chg 字段），
    // 但后续 step5 会用 numcat daily 的收盘涨幅覆盖 change_pct，
    // 这里单独保存纯竞价涨幅，供「五日竞价涨幅」趋势图使用（不被覆盖）。
    const aucPctChgStr = changePctStr;

    // um_vol（未匹配量，手）→ 万手（与 volume 同口径 ÷100），展示 "251w"
    let umVolStr = '';
    if (umIdx >= 0) {
      const um = row[umIdx];
      if (um !== null && um !== undefined && um !== '') {
        const n = Number(um);
        if (!isNaN(n)) umVolStr = String(Math.round(n / 100));
      }
    }

    // open_bid_pct（抢筹幅度 %）
    let openBidPctStr = '';
    if (obpIdx >= 0) {
      const v = row[obpIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) openBidPctStr = n.toFixed(2);
      }
    }

    // auc_vol_ratio（竞价量比）
    let aucVolRatioStr = '';
    if (avrIdx >= 0) {
      const v = row[avrIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) aucVolRatioStr = n.toFixed(2);
      }
    }

    // auc_turnover（真换手率 %）
    let aucTurnoverStr = '';
    if (atrIdx >= 0) {
      const v = row[atrIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) aucTurnoverStr = n.toFixed(2);
      }
    }

    if (!metricsByDate[dateStr]) metricsByDate[dateStr] = [];
    metricsByDate[dateStr].push({
      stock: stockName,
      code: code,
      volume: volumeStr,
      change_pct: changePctStr,
      yest_volume: yestVolumeStr,
      auc_pct_chg: aucPctChgStr,
      um_vol: umVolStr,
      open_bid_pct: openBidPctStr,
      auc_vol_ratio: aucVolRatioStr,
      auc_turnover: aucTurnoverStr
    });
    parsedCount++;
  });

  logs.push('解析完成: ' + parsedCount + '条, 涉及 ' + Object.keys(metricsByDate).length + ' 个交易日, 反推昨日成交量 ' + yestVolDerivedCount + ' 条');
  return { metricsByDate, parsedCount, yestVolDerivedCount };
}

// 5. numcat daily：① 历史日收盘涨幅（覆盖/补齐 daily_auc 的竞价涨幅）
//                ② [PLAN-A 2026-09-10] 计算「近 10 个交易日区间涨幅」并落库 stock_range_pct
//
// [PLAN-A 背景] 10 日区间涨幅是「龙一/龙二」排名的唯一依据。改造前由前端在打开看板时现拉：
//   · 猫抓额度用尽 → 逐只退回同花顺 K 线（实测 4.7 秒/只，64 只 ≈ 5 分钟）→ 用户等待一分钟以上；
//   · 为了兜住「名单逐步到达」还叠了缺口补齐/重试/熔断等一大堆补偿逻辑。
// 现在把「取数 + 计算 + 落库」全部前移到 9:25 这一次抓取：
//   · 与历史涨幅合并共用【同一次】numcat daily 请求（窗口 5 天 → 10 天，请求数不变）；
//   · 区间涨幅口径复用 src/logic/auction/range-window.js（纯函数，前后端单一真相）；
//   · 前端只读 stock_range_pct，收盘后由 close-pct-cover 用收盘涨幅替换 T 腿（0 额外请求）。
async function fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs) {
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d));
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat daily_auc 完全未返回以下历史交易日（volume/yest_volume 本次无法补齐，change_pct 会尝试用 numcat daily 兜底）: ' + JSON.stringify(phantomDates));
  }

  // [PLAN-A] 区间涨幅窗口 [T-9, T]（升序）。天数直接取 range-window 的 RANGE_WINDOW_DAYS，
  // 不在 config 里另设一份，避免「改了前端窗口天数、worker 还在用旧的」这种静默失配。
  let rangeDates = [];
  try {
    rangeDates = await getRecentTradingDays(env, today, RANGE_DAYS);
  } catch (e) {
    logs.push('区间涨幅窗口交易日获取失败: ' + e.message);
  }
  if (rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('⚠️ 区间涨幅窗口交易日历异常(' + JSON.stringify(rangeDates) + ')，回退为竞价窗口 ' + JSON.stringify(expectedDates));
    rangeDates = expectedDates.slice();
  }
  rangeDates.sort();

  // 一次请求覆盖「竞价窗口 ∪ 区间涨幅窗口」
  const fetchDates = rangeDates.length > 0 ? rangeDates : historicalDates;
  if (fetchDates.length === 0) {
    logs.push('步骤5：无可用交易日，跳过 numcat daily 涨幅获取');
    return { phantomDates, rangeRows: [] };
  }

  logs.push('步骤5：numcat daily 获取 ' + fetchDates.length + ' 个交易日收盘涨幅（区间涨幅窗口 ' +
    rangeDates.length + ' 天，历史日 change_pct 合并 ' + historicalDates.length + ' 天）...');
  const startYMD = fetchDates[0].replace(/-/g, '');
  const endYMD = fetchDates[fetchDates.length - 1].replace(/-/g, '');
  const symbols = constituents.map(c => c.code).join(',');

  // code -> (YYYYMMDD -> 日涨幅 number)
  const dailyByCode = {};

  try {
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD);
    const dailyFields = dailyData.fields || [];
    const dailyItems = dailyData.items || [];
    const dSymIdx = dailyFields.indexOf('symbol');
    const dDateIdx = dailyFields.indexOf('tradedate');
    const dPctIdx = dailyFields.indexOf('pct_chg');

    if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
      logs.push('numcat daily 返回字段不完整: ' + JSON.stringify(dailyFields) + '，保留 daily_auc 竞价涨幅');
      return { phantomDates, rangeRows: [] };
    }

    const pctByDate = {};
    let totalPctCount = 0;
    dailyItems.forEach(row => {
      const code = String(row[dSymIdx] || '').trim();
      const tradedate = String(row[dDateIdx] || '').trim();
      const rawPct = row[dPctIdx];
      if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
      const dateStr = compactToDateStr(tradedate);
      if (!dateStr) return;
      const n = Number(rawPct);
      if (isNaN(n)) return;
      if (!pctByDate[dateStr]) pctByDate[dateStr] = {};
      pctByDate[dateStr][code] = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
      if (!dailyByCode[code]) dailyByCode[code] = {};
      dailyByCode[code][dateStr.replace(/-/g, '')] = n;
      totalPctCount++;
    });

    logs.push('numcat daily 返回 ' + totalPctCount + ' 条涨幅数据，涉及 ' + Object.keys(pctByDate).length + ' 个交易日');

    // ① 历史日 change_pct 合并（口径保持改造前不变：仍只用原竞价 5 日窗口的历史日）
    let mergedCount = 0;
    let phantomFilledCount = 0;
    historicalDates.forEach(d => {
      const pctMap = pctByDate[d] || {};
      if (metricsByDate[d]) {
        metricsByDate[d].forEach(m => {
          if (pctMap[m.code]) {
            m.change_pct = pctMap[m.code];
            mergedCount++;
          }
        });
      } else if (Object.keys(pctMap).length > 0) {
        metricsByDate[d] = constituents
          .filter(c => pctMap[c.code])
          .map(c => ({ stock: c.name, code: c.code, volume: '', yest_volume: '', change_pct: pctMap[c.code] }));
        phantomFilledCount += metricsByDate[d].length;
      }
    });
    logs.push('历史涨幅合并 ' + mergedCount + ' 条' + (phantomFilledCount > 0 ? '，另外用 numcat daily 补齐了 daily_auc 完全缺失日期的涨幅 ' + phantomFilledCount + ' 条（这些行没有 volume/yest_volume）' : ''));
  } catch (e) {
    logs.push('numcat daily 失败(保留 daily_auc 竞价涨幅，区间涨幅本次不落库): ' + e.message);
    return { phantomDates, rangeRows: [] };
  }

  // ② [PLAN-A] 计算区间涨幅 → stock_range_pct
  const rangeRows = buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs);
  return { phantomDates, rangeRows };
}

/**
 * [PLAN-A] 计算「近 N 个交易日区间涨幅」行（供写入 stock_range_pct）。
 * 口径与前端完全一致（复用 src/logic/auction/range-window.js）：
 *   · 每天涨幅复利累乘 ∏(1+r)-1；
 *   · 当天(T)腿：9:25 正常抓取时用【竞价涨幅】占位（收盘涨幅此刻物理上不存在）；
 *     若本函数在北京 15:00 后被手动触发（补抓），则用当日收盘涨幅 —— 与前端 resolveTDayPct 同口径。
 * @param {Array<{name:string, code:string}>} constituents
 * @param {string[]} rangeDates 升序 [T-9 ... T]
 * @param {Object} dailyByCode code -> (YYYYMMDD -> 日涨幅 number)
 * @param {Object} metricsByDate 当日竞价解析结果（含 auc_pct_chg / change_pct）
 * @param {string} today
 * @param {string[]} logs
 */
function buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs) {
  if (!rangeDates || rangeDates.length === 0) return [];

  // 当天(T)腿的两个候选：竞价涨幅（9:25 口径）与当日收盘涨幅（15:00 后手动补抓口径，缺失回退行内涨幅）
  const auctionPctByCode = {};
  const changePctByCode = {};
  (metricsByDate[today] || []).forEach(m => {
    if (!m || !m.code) return;
    const a = parsePct(m.auc_pct_chg);
    if (a !== null) auctionPctByCode[m.code] = a;
    const c = parsePct(m.change_pct);
    if (c !== null) changePctByCode[m.code] = c;
  });

  const afterClose = beijingNow().getUTCHours() >= 15;
  const useAuctionLeg = isAuctionLegActive(today, today, afterClose);
  const tYmd = today.replace(/-/g, '');

  // 只做「取 T 腿」这一步（口径由 useAuctionLeg 决定）；窗口/复利/组装全部交给 range-window.buildRangeRows
  const tLegByCode = {};
  constituents.forEach(c => {
    if (!c || !c.code) return;
    let v;
    if (useAuctionLeg) {
      v = auctionPctByCode[c.code];
    } else {
      const dm = dailyByCode[c.code];
      v = dm && Object.prototype.hasOwnProperty.call(dm, tYmd) ? dm[tYmd] : changePctByCode[c.code];
    }
    if (v !== null && v !== undefined && isFinite(v)) tLegByCode[c.code] = Number(v);
  });

  const built = buildRangeRows(constituents, rangeDates, dailyByCode, tLegByCode);
  const nowIso = new Date().toISOString();
  const rows = built.map(r => ({
    date: today,
    stock: r.stock,
    range_pct: Number(r.pct).toFixed(2),
    days: r.days,
    updated_at: nowIso
  }));
  logs.push('步骤5b：区间涨幅计算完成 ' + rows.length + '/' + constituents.length + ' 只（T 腿口径=' +
    (useAuctionLeg ? '9:25 竞价涨幅' : '当日收盘涨幅') + '）');
  return rows;
}

// 6. 分桶写入 market_metrics（按字段形状分桶，配合 missing=default 保留云端原值）
async function writeMarketMetricsBatched(env, metricsByDate, nowIso, logs) {
  // 【FIX 2026-08-03】字段算不出来就不放进 payload，配合 missing=default 让 Supabase 保留原值
  let totalMetricsWritten = 0;
  let metricsWriteFailures = 0;
  const dateKeys = Object.keys(metricsByDate);
  for (const dateStr of dateKeys) {
    const shapeBuckets = {};
    metricsByDate[dateStr].forEach(m => {
      const hasVolume = m.volume !== '';
      const hasYestVolume = m.yest_volume !== '';
      const hasChangePct = m.change_pct !== '';
      const hasAucPctChg = m.auc_pct_chg !== '';
      const hasUmVol = m.um_vol !== '';
      const hasOpenBidPct = m.open_bid_pct !== '';
      const hasAucVolRatio = m.auc_vol_ratio !== '';
      const hasAucTurnover = m.auc_turnover !== '';
      const shapeKey = (hasVolume ? 'v' : '') + (hasYestVolume ? 'y' : '') + (hasChangePct ? 'p' : '')
        + (hasAucPctChg ? 'a' : '') + (hasUmVol ? 'u' : '') + (hasOpenBidPct ? 'o' : '')
        + (hasAucVolRatio ? 'r' : '') + (hasAucTurnover ? 't' : '');
      const row = {
        date: dateStr,
        stock: m.stock,
        code: m.code,
        scope: 'auction',
        source: 'worker',
        updated_at: nowIso,
        updated_by: 'auto-fetch-worker'
      };
      if (hasVolume) row.volume = m.volume;
      if (hasYestVolume) row.yest_volume = m.yest_volume;
      if (hasChangePct) row.change_pct = m.change_pct;
      if (hasAucPctChg) row.auc_pct_chg = m.auc_pct_chg;
      if (hasUmVol) row.um_vol = m.um_vol;
      if (hasOpenBidPct) row.open_bid_pct = m.open_bid_pct;
      if (hasAucVolRatio) row.auc_vol_ratio = m.auc_vol_ratio;
      if (hasAucTurnover) row.auc_turnover = m.auc_turnover;
      if (!shapeBuckets[shapeKey]) shapeBuckets[shapeKey] = [];
      shapeBuckets[shapeKey].push(row);
    });
    try {
      let dateWritten = 0;
      for (const shapeKey of Object.keys(shapeBuckets)) {
        await upsertMarketMetrics(env, shapeBuckets[shapeKey]);
        dateWritten += shapeBuckets[shapeKey].length;
      }
      totalMetricsWritten += dateWritten;
      logs.push('  market_metrics ' + dateStr + ': ' + dateWritten + ' 行 (' + Object.keys(shapeBuckets).length + ' 个字段组合批次)');
    } catch (e) {
      metricsWriteFailures++;
      logs.push('  market_metrics ' + dateStr + ' 写入失败: ' + e.message);
    }
  }
  return { totalMetricsWritten, metricsWriteFailures, dateKeys };
}

// 7. 构建数据完整性汇总
function buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs) {
  const todayMissing = missingDatesAfterNumcat.includes(today);
  const summaryParts = [];
  if (todayMissing) summaryParts.push('❌ 今天(' + today + ')竞价数据缺失，需手动补抓');
  if (phantomDates.length > 0) summaryParts.push('⚠️ 历史日 volume/yest_volume 缺失: ' + phantomDates.join(', '));
  if (metricsWriteFailures > 0) summaryParts.push('❌ market_metrics 写入失败 ' + metricsWriteFailures + ' 个日期批次(可能表未就绪/RLS 阻止/字段不符),数据未落库');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 本次 ' + expectedDates.length + ' 个交易日数据完整';
  logs.push('数据完整性汇总: ' + completenessSummary);
  return { completenessSummary, todayMissing };
}

// 主流程
async function runMorning(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  const skipResult = checkTradingDay(today, logs);
  if (skipResult) return skipResult;

  const watchlistResult = await fetchAndWriteWatchlist(env, today, logs);
  if (watchlistResult.error) {
    return { ok: false, today, error: watchlistResult.error, logs };
  }
  const { constituents, watchlistRows, nowIso } = watchlistResult;

  const numcatResult = await fetchNumcatWithRetry(env, constituents, today, logs);
  if (numcatResult.error) {
    return { ok: false, today, error: numcatResult.error, logs };
  }
  const { expectedDates, items, fields, missingDatesAfterNumcat } = numcatResult;

  const { metricsByDate, yestVolDerivedCount } = parseNumcatToMetrics(items, fields, constituents, logs);

  const { phantomDates, rangeRows } = await fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs);

  const { totalMetricsWritten, metricsWriteFailures, dateKeys } = await writeMarketMetricsBatched(env, metricsByDate, nowIso, logs);

  // [PLAN-A 2026-09-10] 10 日区间涨幅落库（前端只读这张表，不再自行抓取）
  let rangeWritten = 0;
  let rangeWriteFailed = false;
  if (rangeRows.length > 0) {
    try {
      await upsertStockRangePct(env, rangeRows);
      rangeWritten = rangeRows.length;
      logs.push('步骤6：stock_range_pct 写入 ' + rangeWritten + ' 行（近 ' + RANGE_DAYS + ' 个交易日区间涨幅）');
    } catch (e) {
      rangeWriteFailed = true;
      logs.push('❌ stock_range_pct 写入失败(表未就绪/RLS 阻止/字段不符): ' + e.message);
    }
  } else {
    logs.push('⚠️ 区间涨幅无结果可写（numcat daily 不可用或名单为空），本次 stock_range_pct 未更新');
  }

  const { completenessSummary, todayMissing } = buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行, stock_range_pct ' + rangeWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    rangeWritten: rangeWritten,
    rangeWriteFailed: rangeWriteFailed,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    completenessSummary: completenessSummary,
    logs
  };
}

// ────── bidding-auto-fetch/logic/close-workflow.js ──────
// close-workflow.js — 收盘涨幅覆盖 + 区间涨幅重算主流程（runClose）
//
// 【为什么恢复这个流程 / 2026-09-10 审查结论】
//   2026-08-17 把收盘覆盖从本 worker 挪到了 Supabase Edge Function（bidding-a?point=auction-close，
//   pg_cron 16:00 触发），index.js 因此移除了 runClose 路由，本文件退化为「不再被调用的历史参考」。
//   但实测该 pg_cron 链路【从未成功执行过】：
//     · bidding_fetch_log 里 time_point='auction-close' 的记录数为 0；
//     · 手工触发 bidding-a?point=auction-close 返回 546（WORKER_RESOURCE_LIMIT）。
//   结果：当天 market_metrics.change_pct 全天停留在 9:25 竞价涨幅，龙头排位也按竞价口径排
//   —— 这正是用户反复反馈的「收盘后还是只显示早盘竞价涨幅」。
//   本 worker 的早盘 cron（北京 9:25）一直稳定运行，说明 Cloudflare 触发链路是可靠的，
//   因此把收盘覆盖收回这里（与早盘同一个 worker、同一套凭据、同一条部署链路）。
//
// 【两个职责】
//   ① 把 market_metrics.change_pct 从 9:25 竞价涨幅覆盖为真实收盘涨幅；
//   ② 把 stock_range_pct 的「当天(T)腿」从竞价口径换成收盘口径。
//
// 【为什么 ② 用「整段重算」而不是「反解换腿」/ 2026-09-10 二次加固】
//   原先实现是代数反解：prevAcc = (1+已存区间涨幅)÷(1+竞价腿)，新区间 = prevAcc×(1+收盘腿)。
//   它有两个硬伤：
//     · 幂等靠【时间戳】（updated_at >= 当日 15:00 就跳过）→ 前端在 15:00~16:00 之间抢跑写入的
//       任何值都会被本流程永久跳过（前端自愈与 worker 打架，错值冻结、与 change_pct 口径分叉）；
//     · 依赖「旧 T 腿确实等于 auc_pct_chg」这一假设，无法自证。
//   现在改成【用同一次猫抓 daily 请求的 10 天窗口整段重算】（请求数不变：1 次，只是窗口从
//   1 天扩到 10 天），幂等改为【值比较】，因此：
//     · 天然幂等：重算结果与库内一致 → 不写；不一致 → 覆盖（可自动修复任何被冻结的错值）；
//     · 与 change_pct 严格同源：两者都来自同一份猫抓 daily 数据，不会口径分叉；
//     · 「仅不劣化才覆盖」：重算出的天数少于库内天数时不覆盖（防上游返回被截断的窗口污染数据）。
//   猫抓不可用、只剩同花顺 snapshot 兜底当日涨幅时，退化为「只换 T 腿」（保留旧的 replaceTDayLeg 路径）。
//
// 【幂等】re-run 安全：change_pct 值相同不写；区间涨幅值/天数相同不写。






// 区间涨幅口径单一真相（纯函数，worker 早盘/收盘与前端共用同一份实现）
// ⚠️ 单文件打包（_bundle.mjs）会把本文件与 range-window.js 拼进同一个作用域，
//    因此这里【复用】range-window 的 parsePct / RANGE_WINDOW_DAYS，不再自己定义一份
//    （同名会直接报重复声明）。

/** 北京时间 15:00 收盘（与前端 close-pct-cover / dragon-rank 同口径） */
const CLOSE_HOUR = 15;
/** 区间涨幅「值比较」的容差（range_pct 落库保留 2 位小数） */
const PCT_EPS = 0.005;

function _fmtClosePct(n) {
  if (!isFinite(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** 该日收盘覆盖时刻（北京 15:00）对应的 UTC 时间戳 */
function _closeCoverUtcMs(dateStr) {
  const base = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(base)) return NaN;
  return base + (CLOSE_HOUR - 8) * 3600000;
}

/**
 * 猫抓 daily 拉 [T-9, T] 窗口，一次请求同时得到两样东西：
 *   · dailyByCode —— code -> { YYYYMMDD: 日涨幅 }，供区间涨幅整段重算（历史 9 天）；
 *   · pctByCode   —— code -> 当日(T)收盘涨幅，供覆盖 change_pct。
 * 与早盘步骤5 同一个接口（symbol,tradedate,pct_chg），请求次数与「只拉当天」完全相同。
 * @param {string[]} rangeDates 升序交易日 [T-9 ... T]（为空时退化为只拉当天）
 */
async function fetchNumcatDailyWindow(env, codes, rangeDates, today) {
  const ymdToday = today.replace(/-/g, '');
  const startYmd = rangeDates.length > 0 ? rangeDates[0].replace(/-/g, '') : ymdToday;
  const data = await numcatDaily(env, codes.join(','), startYmd, ymdToday);
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  const sIdx = fields.indexOf('symbol');
  const dIdx = fields.indexOf('tradedate');
  const pIdx = fields.indexOf('pct_chg');
  const dailyByCode = {};
  const pctByCode = new Map();
  if (sIdx < 0 || dIdx < 0 || pIdx < 0) return { dailyByCode, pctByCode };
  items.forEach(row => {
    const code = String(row[sIdx] || '').trim();
    const rawDate = String(row[dIdx] || '').trim();
    const raw = row[pIdx];
    if (!code || !rawDate || raw === null || raw === undefined || raw === '') return;
    const n = Number(raw);
    if (!isFinite(n)) return;
    // tradedate 是紧凑格式 YYYYMMDD（或带横杠），统一成 YYYYMMDD 作为窗口键
    const ymd = rawDate.replace(/-/g, '');
    if (ymd.length !== 8) return;
    if (!dailyByCode[code]) dailyByCode[code] = {};
    dailyByCode[code][ymd] = n;
    if (ymd === ymdToday) pctByCode.set(code, n);
  });
  return { dailyByCode, pctByCode };
}

async function runClose(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 名单 + 旧值来源：market_metrics（早盘写入的行含 code / auc_pct_chg / change_pct）。
  //    用 market_metrics 而不是 auction_watchlist，天然覆盖观察组 / 打标签票（早盘同样为它们写了指标行）。
  logs.push('步骤1：读取当日 market_metrics...');
  let metrics;
  try {
    metrics = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    logs.push('读取 market_metrics 失败: ' + e.message);
    return { ok: false, today, error: '读取 market_metrics 失败: ' + e.message, logs };
  }
  logs.push('market_metrics 读取 ' + metrics.length + ' 只');
  if (metrics.length === 0) {
    logs.push('❌ 当日 market_metrics 为空（早盘 9:25 可能未成功），无法覆盖收盘涨幅');
    return { ok: false, today, skipped: true, reason: '当日指标行为空', logs };
  }

  const byName = new Map();
  metrics.forEach(m => { if (!byName.has(m.name)) byName.set(m.name, m); });
  const codes = Array.from(new Set(metrics.map(m => m.code).filter(Boolean)));

  // 2. 区间涨幅窗口 [T-9, T]（与早盘同一份交易日历 / 同一个 RANGE_WINDOW_DAYS）
  let rangeDates = [];
  try {
    rangeDates = await getRecentTradingDays(env, today, RANGE_WINDOW_DAYS);
  } catch (e) {
    logs.push('区间涨幅窗口交易日获取失败: ' + e.message);
  }
  if (rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('⚠️ 区间涨幅窗口交易日历异常(' + JSON.stringify(rangeDates) + ')，本次不整段重算（退化为只换 T 腿）');
    rangeDates = [];
  }
  rangeDates.sort();

  // 3. 收盘涨幅 + 区间涨幅窗口：猫抓 daily 一次请求 → 缺失的代码再用 fuyao snapshot 兜底当日涨幅
  //    ⚠️ 兜底必须按【缺失的代码】补，而不是「猫抓整体失败才兜底」：
  //    实测猫抓 daily 对少数票（停牌/次新/代码映射缺失）当日不返回行，若只做整体兜底，
  //    这些票的 change_pct 会永远停在 9:25 竞价涨幅（9/10 实测 8 只，其中 2 只停牌属正常）。
  const closeMs = _closeCoverUtcMs(today);
  let dailyByCode = {};
  const pctByCode = new Map();
  const sources = [];
  logs.push('步骤2：猫抓 daily 获取收盘涨幅（' + codes.length + ' 个代码，窗口 ' +
    (rangeDates.length || 1) + ' 天）...');
  try {
    const win = await fetchNumcatDailyWindow(env, codes, rangeDates, today);
    dailyByCode = win.dailyByCode;
    win.pctByCode.forEach((v, k) => pctByCode.set(k, v));
    if (pctByCode.size > 0) sources.push('numcat-daily');
    logs.push('猫抓 daily 返回当日收盘涨幅 ' + pctByCode.size + ' 只，窗口含历史数据 ' +
      Object.keys(dailyByCode).length + ' 只');
  } catch (e) {
    logs.push('猫抓 daily 不可用: ' + e.message);
  }

  const missingCodes = codes.filter(c => !pctByCode.has(c));
  if (missingCodes.length > 0) {
    try {
      const snap = await fetchSnapshotChangePct(env, missingCodes);
      let filled = 0;
      Object.keys(snap.pctMap || {}).forEach(code => {
        const n = parsePct(snap.pctMap[code]);
        if (n !== null && !pctByCode.has(code)) { pctByCode.set(code, n); filled++; }
      });
      if (filled > 0) sources.push('fuyao-snapshot');
      logs.push('fuyao snapshot 补齐缺失当日涨幅 ' + filled + '/' + missingCodes.length + ' 只');
    } catch (e) {
      logs.push('fuyao snapshot 兜底失败: ' + e.message);
    }
  }

  const source = sources.join('+');
  if (pctByCode.size === 0) {
    logs.push('❌ 未能取到任何收盘涨幅（猫抓与同花顺均不可用 / 行情尚未结算），本次不覆盖');
    return { ok: false, today, error: '未能取到任何收盘涨幅', source: source || '-', logs };
  }
  logs.push('收盘涨幅来源=' + source + '，可用 ' + pctByCode.size + '/' + codes.length + ' 只');

  // 4. 覆盖 market_metrics.change_pct（只带 change_pct + updated_*，不会抹掉 volume / auc_pct_chg 等竞价字段）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricRows = [];
  metrics.forEach(m => {
    if (!m.code) return;
    if (!pctByCode.has(m.code)) return;
    const pct = pctByCode.get(m.code);
    // 幂等：值未变（无论写于何时）→ 跳过，不产生无意义的 updated_at
    const prev = parsePct(m.change_pct);
    const t = m.updated_at ? Date.parse(m.updated_at) : NaN;
    if (prev !== null && Math.abs(prev - pct) < 1e-9 && !Number.isNaN(t) && t >= closeMs) return;
    metricRows.push({
      date: today,
      stock: m.name,
      code: m.code,
      change_pct: _fmtClosePct(pct),
      scope: 'auction',
      source: 'worker',
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker-close'
    });
  });

  let written = 0;
  if (metricRows.length > 0) {
    try {
      await upsertMarketMetrics(env, metricRows);
      written = metricRows.length;
      logs.push('market_metrics 写入 ' + written + ' 行 change_pct');
    } catch (e) {
      logs.push('写入 market_metrics 失败: ' + e.message);
      return { ok: false, today, error: '写入 market_metrics 失败: ' + e.message, logs };
    }
  } else {
    logs.push('market_metrics 无需更新（已是收盘口径）');
  }

  // 5. 区间涨幅：整段重算（主通道）→ 只换 T 腿（降级，猫抓窗口不可用时）
  logs.push('步骤4：重算 stock_range_pct 区间涨幅（T 腿=当日收盘涨幅）...');
  let rangeFixed = 0;
  try {
    rangeFixed = await syncRangePct(env, today, closeMs, rangeDates, dailyByCode, pctByCode, byName, nowIso, logs);
  } catch (e) {
    logs.push('区间涨幅重算失败（非致命）: ' + e.message);
  }

  const completenessSummary = '✅ 收盘覆盖 ' + written + '/' + metrics.length + ' 只（来源=' + source +
    '），区间涨幅更新 ' + rangeFixed + ' 只';
  logs.push('数据完整性汇总: ' + completenessSummary);
  logs.push('完成: 收盘涨幅覆盖 ' + written + ' 只, 区间涨幅更新 ' + rangeFixed + ' 只');
  return {
    ok: true,
    today,
    stocksCount: metrics.length,
    pctUpdated: written,
    rangeFixed: rangeFixed,
    source: source,
    completenessSummary: completenessSummary,
    logs
  };
}

/**
 * 【区间涨幅重算 / 整段重算优先，换腿降级】
 *
 * ① 主通道（有 10 天窗口数据）：用 range-window.buildRangeRows 按 [T-9, T] 整段重算，
 *    与库内值比较 → 值/天数不同才写；天数变少则【不覆盖】（防上游返回被截断的窗口污染数据）。
 *    天然幂等，且能修复任何被冻结的错值。
 * ② 降级（猫抓不可用、当日涨幅来自同花顺 snapshot，没有历史窗口）：对库内仍是竞价口径
 *    （updated_at < 当日 15:00）且未在 ① 覆盖的行，用 replaceTDayLeg 换掉 T 腿。
 *
 * @returns {Promise<number>} 实际写入的行数
 */
async function syncRangePct(env, today, closeMs, rangeDates, dailyByCode, pctByCode, byName, nowIso, logs) {
  let storedRows;
  try {
    storedRows = await readStockRangePctForDate(env, today);
  } catch (e) {
    logs.push('读取 stock_range_pct 失败: ' + e.message);
    return 0;
  }
  const stored = new Map();
  storedRows.forEach(r => stored.set(r.stock, r));

  const out = [];
  const touched = new Set();

  // ① 整段重算
  if (rangeDates.length > 0 && Object.keys(dailyByCode).length > 0) {
    const targets = [];
    byName.forEach((m, name) => {
      if (!m.code || !pctByCode.has(m.code)) return; // 取不到当日腿的票不重算（避免算出「不含当天」的残缺区间）
      targets.push({ name: name, code: m.code });
    });
    const tLegByCode = {};
    pctByCode.forEach((v, code) => { tLegByCode[code] = v; });

    const built = buildRangeRows(targets, rangeDates, dailyByCode, tLegByCode);
    let skippedDegrade = 0;
    built.forEach(r => {
      const old = stored.get(r.stock);
      const newPct = Number(Number(r.pct).toFixed(2));
      if (old) {
        const oldPct = parsePct(old.range_pct);
        const oldDays = Number(old.days) || 0;
        if (newPct !== null && oldPct !== null && Math.abs(oldPct - newPct) < PCT_EPS && oldDays === r.days) return;
        if (oldDays > r.days) { skippedDegrade++; return; } // 不劣化覆盖
      }
      out.push({
        date: today,
        stock: r.stock,
        range_pct: newPct.toFixed(2),
        days: r.days,
        updated_at: nowIso
      });
      touched.add(r.stock);
    });
    logs.push('区间涨幅整段重算：' + built.length + ' 只参与，需更新 ' + touched.size + ' 只' +
      (skippedDegrade > 0 ? '，' + skippedDegrade + ' 只因重算天数少于库内而跳过（不劣化覆盖）' : ''));
  } else {
    logs.push('⚠️ 无 10 天窗口数据 → 区间涨幅退化为「只换 T 腿」');
  }

  // ② 降级：只换 T 腿（仅处理 ① 未覆盖、且仍是竞价口径的行）
  storedRows.forEach(r => {
    if (touched.has(r.stock)) return;
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    if (Number.isNaN(t) || !t || t >= closeMs) return; // 已是收盘口径 → 不动
    const old = parsePct(r.range_pct);
    if (old === null) return;
    const m = byName.get(r.stock);
    if (!m || !m.code || !pctByCode.has(m.code)) return;
    const next = replaceTDayLeg(old, parsePct(m.auc_pct_chg), pctByCode.get(m.code));
    if (next === null || !isFinite(next)) return;
    out.push({
      date: today,
      stock: r.stock,
      range_pct: Number(next).toFixed(2),
      days: r.days,
      updated_at: nowIso
    });
  });

  if (out.length === 0) {
    logs.push('区间涨幅无需更新（已是收盘口径）');
    return 0;
  }
  await upsertStockRangePct(env, out);
  return out.length;
}


// ────── bidding-auto-fetch/index.js ──────
// index.js — bidding-auto-fetch Worker 入口
//
// 两个触发点（同一条 Cloudflare 部署链路）：
//   · 北京 9:25  → morning：抓竞价数据 + 计算 10 日区间涨幅落库；
//   · 北京 16:00  → close  ：用收盘涨幅覆盖 9:25 竞价涨幅 + 校正区间涨幅 T 腿。
//
// [FIX 2026-09-10] 收盘覆盖「回归本 worker」。
//   2026-08-17 曾把 close 挪到 Supabase Edge Function（bidding-a?point=auction-close，pg_cron 16:00），
//   但实测该 pg_cron 链路从未成功执行过（bidding_fetch_log 里 auction-close 记录数为 0，
//   手工触发返回 546），导致当天 change_pct 全天停留在竞价涨幅。
//   本 worker 的早盘 cron 一直稳定，因此收盘也交回这里，不再依赖任何外部 cron。
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 9:25 ~ 9:40 → morning
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 'morning';
  // 15:00 ~ 16:30 → close（收盘涨幅覆盖，跨过收盘门槛即可手动补抓）
  if (mins >= 15 * 60 && mins <= 16 * 60 + 30) return 'close';
  return null;
}

// 从 cron 表达式解析触发点
function cronToPoint(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  // 01:25 UTC = 09:25 北京时间 → morning
  // 08:00 UTC = 16:00 北京时间 → close（收盘涨幅覆盖）
  const MAP = {
    '25 1': 'morning',
    '0 8': 'close'
  };
  return MAP[key] || null;
}

async function dispatch(point, env, logs) {
  if (point === 'morning') {
    const result = await runMorning(env);
    console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  if (point === 'close') {
    const result = await runClose(env);
    console.log('[auto-fetch] runClose 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runClose 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  console.error('[auto-fetch] 未知触发点:', point);
  return { ok: false, error: '未知触发点: ' + point };
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[auto-fetch] 无法识别 cron:', event.cron);
      return;
    }
    // 【FIX 2026-08-04】不管成功/失败，都把完整 logs 数组 console.log 出来
    ctx.waitUntil(dispatch(point, env, []).catch(e => console.error('[auto-fetch] ' + point + ' error:', e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'bidding-auto-fetch' });
    }

    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return jsonResponse({ ok: false, error: 'token 无效' }, 403);
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) {
          return jsonResponse({ ok: false, error: '当前北京时间不在抓取时段（9:25~9:40=morning，15:00~16:30=close）' });
        }
      }
      if (!['morning', 'close'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|auto' });
      }
      try {
        const result = await dispatch(point, env, []);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};

