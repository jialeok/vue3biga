// ===== bidding-auto-fetch — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-08-17 13:53:28
// 注意: 此文件由 _bundle-workers.ps1 自动生成，请勿手动编辑

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

// ────── bidding-auto-fetch/logic/morning-workflow.js ──────
// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为 7 个子函数）

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
  try {
    await upsertAuctionWatchlist(env, watchlistRows);
    logs.push('auction_watchlist 写入 ' + watchlistRows.length + ' 行');
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

// 5. numcat daily 获取收盘涨幅（pct_chg），覆盖/补齐 daily_auc 的竞价涨幅
async function fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs) {
  // 【改为 numcat daily API】替代 fuyao historical，更稳定快速，与前端 fetchFiveDaysAuctionFromNumcat 一致
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d));
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat daily_auc 完全未返回以下历史交易日（volume/yest_volume 本次无法补齐，change_pct 会尝试用 numcat daily 兜底）: ' + JSON.stringify(phantomDates));
  }
  if (historicalDates.length === 0) {
    logs.push('步骤5：无历史交易日，跳过 numcat daily 涨幅获取');
    return { phantomDates };
  }

  logs.push('步骤5：numcat daily 获取 ' + historicalDates.length + ' 个历史交易日收盘涨幅...');
  const startYMD = historicalDates[0].replace(/-/g, '');
  const endYMD = historicalDates[historicalDates.length - 1].replace(/-/g, '');
  const symbols = constituents.map(c => c.code).join(',');

  try {
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD);
    const dailyFields = dailyData.fields || [];
    const dailyItems = dailyData.items || [];
    const dSymIdx = dailyFields.indexOf('symbol');
    const dDateIdx = dailyFields.indexOf('tradedate');
    const dPctIdx = dailyFields.indexOf('pct_chg');

    if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
      logs.push('numcat daily 返回字段不完整: ' + JSON.stringify(dailyFields) + '，保留 daily_auc 竞价涨幅');
      return { phantomDates };
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
      totalPctCount++;
    });

    logs.push('numcat daily 返回 ' + totalPctCount + ' 条涨幅数据，涉及 ' + Object.keys(pctByDate).length + ' 个交易日');

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
    logs.push('numcat daily 失败(保留 daily_auc 竞价涨幅): ' + e.message);
  }

  return { phantomDates };
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

  const { phantomDates } = await fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs);

  const { totalMetricsWritten, metricsWriteFailures, dateKeys } = await writeMarketMetricsBatched(env, metricsByDate, nowIso, logs);

  const { completenessSummary, todayMissing } = buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    completenessSummary: completenessSummary,
    logs
  };
}

// ────── bidding-auto-fetch/index.js ──────
// index.js — bidding-auto-fetch Worker 入口
// [FIX 2026-08-17] 收盘涨幅覆盖已迁移到 Supabase Edge Function auction-close-fetch
// （pg_cron 16:00 触发），本 worker 不再承担 close 涨幅覆盖，只保留 morning 抓取。
// 原 runClose 导入与调度已移除；close-workflow.js 保留为历史参考，不再被调用。

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
  return null;
}

// 从 cron 表达式解析触发点
function cronToPoint(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  // 01:25 UTC = 09:25 北京时间 → morning
  const MAP = {
    '25 1': 'morning',
  };
  return MAP[key] || null;
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[auto-fetch] 无法识别 cron:', event.cron);
      return;
    }
    // 【FIX 2026-08-04】不管成功/失败，都把完整 logs 数组 console.log 出来
    if (point === 'morning') {
      ctx.waitUntil(
        runMorning(env)
          .then(result => {
            console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
            console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
          })
          .catch(e => console.error('[auto-fetch] morning error:', e.message))
      );
    }
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
          return jsonResponse({ ok: false, error: '当前北京时间不在抓取时段（9:25~9:40=morning）' });
        }
      }
      if (!['morning'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|auto（close 已迁移到 Supabase auction-close-fetch）' });
      }
      try {
        const result = await runMorning(env);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};
