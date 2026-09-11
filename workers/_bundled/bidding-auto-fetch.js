// ===== bidding-auto-fetch — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-09-11 12:49:18
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
  // [FIX 2026-09-11] 北交所 2024 起启用 920 号段。必须【先于】`9 → .SH` 判断，
  // 否则 920xxx 会被当成沪市 B 股 → K 线/快照恒空 → 该股区间涨幅与当日收盘涨幅全天缺失
  // （与前端 src/data/api/fuyao-proxy.js 同口径修复）。
  if (c.slice(0, 2) === '92') return c + '.BJ';
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

/**
 * [KLINE-FALLBACK 2026-09-11] 同花顺 K 线窗口涨幅（前复权）——供收盘区间涨幅「缺腿行」重算。
 *
 * 为什么需要：猫抓 daily 每天只有 10 次额度，收盘（16:00）时经常已被白天用尽 →
 * 区间涨幅的「整段重算」拿不到 10 天窗口 → 只能退化为「只换 T 腿」，而
 * 缺腿行（days < 窗口）根本无法修复（2026-09-11 实测 7 只错值，国芳集团 91.11%）。
 * 同花顺 K 线【没有每日额度限制】（当日收盘涨幅兜底一直用它），因此这里提供窗口级
 * K 线涨幅，让缺腿行重算完全不依赖猫抓额度。
 *
 * 口径与前端 src/data/stock-range-pct.js#fetchFuyaoDailyPctRange 完全一致：
 *   · 前复权（不复权在除权除息日会出现假暴跌，与交易所涨跌幅不可比）；
 *   · date_ms 是北京时间午夜 → 加 8h 取 UTC 日期才是正确交易日；
 *   · 起点前移 20 自然日（窗口首日涨幅需要「上一交易日收盘价」，长假也够）；
 *   · 并发固定 3（实测并发 4~6 会返回被截断的少数 K 线）+ 覆盖不足重试 + 熔断。
 *
 * @param {object} env
 * @param {Array<{name:string, code:string}>} items
 * @param {string[]} dates 需要的交易日（YYYY-MM-DD，顺序任意）
 * @param {{concurrency?:number}} [opts]
 * @returns {Promise<Map<string, Map<string, number>>>} name -> (YYYYMMDD -> 日涨幅%)
 */
async function fetchFuyaoKlineWindowPct(env, items, dates, opts) {
  const out = new Map();
  const list = (items || []).filter(it => it && it.name && it.code);
  const ymdList = (dates || []).map(d => String(d).replace(/-/g, '')).filter(Boolean);
  if (list.length === 0 || ymdList.length === 0) return out;

  const sorted = ymdList.slice().sort();
  const toDash = y => y.slice(0, 4) + '-' + y.slice(4, 6) + '-' + y.slice(6, 8);
  // 起点前移 20 个自然日：首日涨幅需要「上一个交易日收盘价」作为基准（抗长假）。
  const startMs = dateStrToMs(toDash(sorted[0])) - 20 * 86400000;
  const endMs = dateStrToMs(toDash(sorted[sorted.length - 1])) + 2 * 86400000;
  const wantSet = new Set(ymdList);

  // 并发度固定 3：该上游在并发 4~6 时会返回被截断的少数几根 K 线。
  const conc = (opts && opts.concurrency) || 3;
  // 熔断阈值：连续这么多只都取不到完整窗口 → 判定上游整体不可用，放弃剩余（避免跑满重试）。
  const CIRCUIT_LIMIT = 6;
  let consecutiveShort = 0;
  let circuitOpen = false;

  async function fetchOnce(code) {
    const data = await fuyaoProxyGet(env, '/api/a-share/prices/historical', {
      thscode: tickerToThscode(code),
      interval: '1d',
      start: String(startMs),
      end: String(endMs),
      adjust: 'forward'
    });
    const rows = (data && data.item) || [];
    const series = [];
    rows.forEach(r => {
      if (!r || r.date_ms === null || r.date_ms === undefined || r.close_price === null || r.close_price === undefined) return;
      const close = Number(r.close_price);
      if (!isFinite(close) || close <= 0) return;
      series.push({ ymd: msToDateStr(Number(r.date_ms)).replace(/-/g, ''), close: close });
    });
    series.sort((a, b) => (a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0)));
    const keep = new Map();
    for (let k = 1; k < series.length; k++) {
      if (!wantSet.has(series[k].ymd)) continue;
      const prev = series[k - 1].close;
      if (!prev) continue;
      keep.set(series[k].ymd, (series[k].close / prev - 1) * 100);
    }
    return keep;
  }

  for (let i = 0; i < list.length; i += conc) {
    if (circuitOpen) break;
    const batch = list.slice(i, i + conc);
    await Promise.all(batch.map(async it => {
      if (circuitOpen) return;
      let best = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const keep = await fetchOnce(it.code);
          if (!best || keep.size > best.size) best = keep;
          if (best.size >= wantSet.size) break; // 已覆盖整个窗口
          if (best.size === 0) break;           // 代码错 / 长期停牌，重试无意义
          if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      } catch (e) {
        console.warn('K线窗口失败 ' + it.name + '(' + it.code + '): ' + e.message);
      }
      if (best && best.size > 0) out.set(String(it.name).trim(), best);
      if (!best || best.size < wantSet.size) {
        consecutiveShort++;
        if (consecutiveShort >= CIRCUIT_LIMIT) circuitOpen = true;
      } else {
        consecutiveShort = 0;
      }
    }));
  }

  return out;
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
 * [EXTRAS-PATCH 2026-09-11] 读取某日 market_metrics 竞价行的「竞价四要素」现状。
 * 供 runAuctionExtrasPatch 判断哪些行还缺字段 —— 只补缺失的，不重复写已有值（幂等）。
 * ⚠️ 读取失败必须抛错（§10：读取失败 ≠ 空数据）：否则会把「读不到」误判成「全都缺」，
 *    进而用一次 numcat 的结果把历史值整体覆盖一遍。
 */
async function readMarketMetricsExtrasForDate(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?date=eq.' + encodeURIComponent(date) +
    '&scope=eq.auction' +
    '&select=stock,code,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover&limit=2000';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 market_metrics 四要素失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data || []).map(r => ({
    name: (r.stock || '').trim(),
    code: (r.code || '').trim(),
    um_vol: r.um_vol === undefined || r.um_vol === null ? '' : String(r.um_vol),
    open_bid_pct: r.open_bid_pct === undefined || r.open_bid_pct === null ? '' : String(r.open_bid_pct),
    auc_vol_ratio: r.auc_vol_ratio === undefined || r.auc_vol_ratio === null ? '' : String(r.auc_vol_ratio),
    auc_turnover: r.auc_turnover === undefined || r.auc_turnover === null ? '' : String(r.auc_turnover)
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

/**
 * [LATENCY 2026-09-11] 按【股票名】精确查代码映射。
 * 存在的理由：readStockCodeMap 全表读受 Supabase 单次 1000 行上限截断（实测表共 1005 行、
 * 只回 1000 行），少部分名字会查不到 code；而全表分页读又要 6 次请求，放在 9:25 的关键路径上不划算。
 * 因此主路径用一次全表读（覆盖绝大多数），剩余缺 code 的名字再用本函数按名精确补一次（1 次小请求）。
 */
async function readStockCodeMapByNames(env, names) {
  const clean = (names || []).map(n => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return {};
  const uniq = Array.from(new Set(clean)).slice(0, 400);
  const inList = uniq.map(n => '%22' + encodeURIComponent(n) + '%22').join(',');
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?select=stock,code&stock=in.(' + inList + ')';
  try {
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
  } catch (e) {
    return {};
  }
}

// [FIX 2026-08-15] 读取股票名称→代码映射表（stockcodemap），为 watchlist 里 code 为空的
// 观察组/打标签股票补充 code（worker 的 numcat 抓取按 code 查询，无 code 无法抓数据）。
// ⚠️ 受 Supabase 单次 1000 行上限截断；缺漏由 readStockCodeMapByNames 按名补齐。
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
 * 【按日取腿】把「每个交易日一整行数据」映射成组装区间涨幅所需的两张表。
 *
 * 用途（[LOCAL-RECOMPUTE 2026-09-11]）：区间涨幅的历史日数据其实【已经存在库里】
 * （每天一行 market_metrics.change_pct，前端首屏就把最近 30 个自然日拉进内存了）。
 * 所以当云端 stock_range_pct 出现「缺腿行」（days < 窗口长度）时，完全可以用内存里
 * 已存的逐日涨幅【本地重新组装】出完整区间涨幅 —— **0 次猫抓请求**，不消耗额度，
 * 也不受「猫抓当日不给数据 / 额度用尽」的影响。
 *
 * 纯函数：不读 state、不发请求、不碰 DOM（调用方负责把内存数据准备好传进来）。
 *
 * @param {Array<{name:string, code?:string}>} targets 参与计算的股票（按 name 去重，先到先得）
 * @param {string[]} ascDates 升序交易日 ['YYYY-MM-DD', ...]，最后一项必须是 T
 * @param {Map<string, Map<string, object>>} rowsByDate date -> (股票名 -> 当日行)
 * @param {function(object, string): (number|null)} legOf (当日行, 日期) => 该日腿涨幅（%）
 *        口径由调用方决定（单一真相仍是 resolveTDayPct / isAuctionLegActive）
 * @returns {{targets:Array<{name:string, code:string}>, dailyByCode:Object, tLegByCode:Object}}
 *          可直接喂给 buildRangeRows（组装成行的唯一实现）
 */
function collectDailyLegs(targets, ascDates, rowsByDate, legOf) {
  const dailyByCode = Object.create(null);
  const tLegByCode = Object.create(null);
  const out = [];
  if (!targets || targets.length === 0 || !ascDates || ascDates.length === 0) {
    return { targets: out, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
  }
  const tDate = ascDates[ascDates.length - 1];
  const seen = new Set();
  targets.forEach(function(t) {
    if (!t || !t.name) return;
    const name = String(t.name).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    // 缺 code 的票用「名字键」占位：buildRangeRows 只要求 key 稳定唯一，
    // 有 code 时用 code（与 worker 同键），没 code 也不至于整只票被丢掉。
    const key = t.code ? String(t.code) : ('n:' + name);
    const dm = Object.create(null);
    ascDates.forEach(function(d) {
      const row = rowsByDate && rowsByDate.get(d) ? rowsByDate.get(d).get(name) : null;
      if (!row) return;
      const v = legOf ? legOf(row, d) : null;
      if (v === null || v === undefined || !isFinite(v)) return;
      if (d === tDate) tLegByCode[key] = Number(v);
      else dm[String(d).replace(/-/g, '')] = Number(v);
    });
    dailyByCode[key] = dm;
    out.push({ name: name, code: key });
  });
  return { targets: out, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
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


// ────── bidding-auto-fetch/logic/extras-workflow.js ──────
// extras-workflow.js — 「竞价四要素」补漏（runAuctionExtrasPatch）
//
// 【为什么要单独一个补漏任务 / 2026-09-11 取证结论】
//   竞价四要素 = 未匹配量(um_vol) / 抢筹幅度(open_bid_pct) / 竞价量比(auc_vol_ratio) /
//               真换手率(auc_turnover)，是趋势图右侧与「量比抢筹高光」的核心判据。
//
//   猫抓 daily_auc 对【当日】这一行**不返回**这四个字段的值，只返回
//   auc_vol / auc_pct_chg / auc_to_pre_vol_pct；四要素要等这一天结算后才出现。
//   取证（.tmpdiag/diag_last_write.mjs，全表 3692 行，只读）：
//     · 9/11 同一轮写入（01:29:56~01:30:03）里：9/10 = 60/67 有四要素，9/11 = 0/67 全空；
//     · 全表唯一「最后一个写入时刻 = 当天」的日期就是 9/11，它四要素为 0；
//     · 8/07 起的每个历史日，四要素都是被【后续几天的窗口重刷】时才带上的。
//   ⇒ 9:25 早盘永远拿不到「当天」的四要素，重试只是白等（还会顶穿 9:26 硬指标），
//     必须有一个「结算后补写」的任务 —— 就是本文件。
//
// 【触发点】
//   ① 北京 16:00 close 主流程末尾自动跑（复用既有 cron，不需要新增触发器）；
//   ② 手动 /fetch?point=extras（想当天立刻看到 / 补历史缺口时用）。
//
// [QUOTA 2026-09-11] 自动跑时【排除当前交易日】：猫抓「当天不给四要素」是既定行为，
//   把今天算进待补集合的唯一效果 = 每天都白烧 1 次额度。实测：9/11 16:00 的补漏 patched=0，
//   而当天 9/11 的四要素依旧是 0/67（查询 market_metrics 证实 updated_by=*-close 48 行全空）。
//   现在只有「确实存在可补的历史缺口」才发 numcat 请求；窗口内全完整 → 零请求直接返回。
//   手动调用传 includeToday:true 可保留「含今天」的旧行为（用于排查）。
//
// 【安全约束（§11 删除安全 / §10 静默失败）】
//   · 只写这四个字段。upsert 用 resolution=merge-duplicates + missing=default，
//     绝不会抹掉 volume / change_pct / auc_pct_chg / yest_volume；
//   · 只有「库内该行四要素有缺失」且「numcat 本次给了非空值」才写 → 天然幂等，重复跑零副作用；
//   · 读取失败必须抛错，绝不能被当成「全都缺」而整体覆盖；
//   · 整体失败不致命，调用方 try/catch 后继续。





// ⚠️ 单文件打包（workers/_bundle.mjs）会把所有模块拼进同一个作用域，
//    顶层标识符必须全局唯一 —— 这里一律加 extras 前缀，避免与其它文件重名导致重复声明。
const EXTRAS_FIELDS = ['um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];
/** 单次 upsert 的行数（Supabase 单次请求不宜过大） */
const EXTRAS_CHUNK = 400;

function extrasIsEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** 未匹配量：numcat 给的是「手」，库内存「万手」（与 volume 同口径，÷100 取整） */
function extrasFmtUmVol(v) {
  const n = Number(v);
  return isNaN(n) ? '' : String(Math.round(n / 100));
}

/** 其余三项都是百分数 / 倍数，统一保留 2 位小数 */
function extrasFmt2(v) {
  const n = Number(v);
  return isNaN(n) ? '' : n.toFixed(2);
}

/**
 * 补写竞价四要素。
 * @param {object} env      worker env（需要 SUPABASE_* 与 NUMCAT_API_KEY）
 * @param {object} [opts]   { days?: number, logs?: string[], dates?: string[], includeToday?: boolean }
 *        includeToday=false（默认）：自动跑时排除当前交易日 —— 当天四要素猫抓不给，
 *        把它算进待补只会每天白烧一次额度（实测 9/11 16:00 patched=0 且当天仍 0/67）。
 * @returns {Promise<{ok:boolean, today:string, patched:number, dates:string[], logs:string[]}>}
 */
async function runAuctionExtrasPatch(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = beijingToday();
  const days = Number(o.days) || RANGE_WINDOW_DAYS;
  const includeToday = !!o.includeToday;
  logs.push('[extras] 竞价四要素补漏开始 today=' + today + (includeToday ? '（含今天）' : '（自动排除今天）'));

  // 1. 交易日窗口（默认 [T-9, T]，与早盘/收盘同一份交易日历）
  let dates = Array.isArray(o.dates) && o.dates.length > 0 ? o.dates.slice() : [];
  if (dates.length === 0) {
    try {
      dates = await getRecentTradingDays(env, today, days);
    } catch (e) {
      logs.push('[extras] 交易日历获取失败: ' + e.message);
    }
  }
  if (dates.length === 0) {
    logs.push('[extras] ⚠️ 无可用交易日，跳过');
    return { ok: false, today, patched: 0, dates: [], logs, reason: '无可用交易日' };
  }
  dates.sort();
  // [QUOTA 2026-09-11] 自动跑排除「今天」：当天四要素永远拿不到，见文件头说明。
  if (!includeToday) dates = dates.filter(d => d !== today);
  if (dates.length === 0) {
    logs.push('[extras] ✅ 待补窗口内只剩当天（当天四要素猫抓不提供）→ 零请求直接返回');
    return { ok: true, today, patched: 0, dates: [], logs, reason: '只剩当天' };
  }
  const startYMD = dates[0].replace(/-/g, '');
  const endYMD = dates[dates.length - 1].replace(/-/g, '');

  // 2. 读库内现状：只补「有缺失」的行（§10：读取失败必须抛错，不能当成全缺）
  const existing = {};   // date -> Map(name -> row)
  let missingTotal = 0;
  for (const d of dates) {
    let rows;
    try {
      rows = await readMarketMetricsExtrasForDate(env, d);
    } catch (e) {
      logs.push('[extras] ❌ 读取 ' + d + ' 失败（中断，避免误覆盖）: ' + e.message);
      return { ok: false, today, patched: 0, dates: dates, logs, error: e.message };
    }
    const m = new Map();
    rows.forEach(r => {
      if (!m.has(r.name)) m.set(r.name, r);
      if (EXTRAS_FIELDS.some(f => extrasIsEmpty(r[f]))) missingTotal++;
    });
    existing[d] = m;
  }
  logs.push('[extras] 窗口 ' + dates.length + ' 天，库内缺四要素的行 ' + missingTotal + ' 行');
  if (missingTotal === 0) {
    logs.push('[extras] ✅ 窗口内四要素已完整，无需补写');
    return { ok: true, today, patched: 0, dates: dates, logs };
  }

  // 3. 一次 numcat daily_auc 拿整个窗口（请求数与「只拉今天」相同）
  const codeSet = new Set();
  dates.forEach(d => existing[d].forEach(r => { if (r.code) codeSet.add(r.code); }));
  const codes = Array.from(codeSet);
  if (codes.length === 0) {
    logs.push('[extras] ⚠️ 库内无可用的股票代码，跳过');
    return { ok: false, today, patched: 0, dates: dates, logs, reason: '无可用代码' };
  }

  let data;
  try {
    data = await numcatDailyAuc(env, codes.join(','), startYMD, endYMD);
  } catch (e) {
    logs.push('[extras] ❌ numcat daily_auc 失败: ' + e.message);
    return { ok: false, today, patched: 0, dates: dates, logs, error: e.message };
  }
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  const symI = fields.indexOf('symbol');
  const dateI = fields.indexOf('tradedate');
  const idx = {
    um_vol: fields.indexOf('um_vol'),
    open_bid_pct: fields.indexOf('open_bid_pct'),
    auc_vol_ratio: fields.indexOf('auc_vol_ratio'),
    auc_turnover: fields.indexOf('auc_turnover')
  };
  if (symI < 0 || dateI < 0) {
    logs.push('[extras] ❌ numcat 返回字段不完整: ' + JSON.stringify(fields));
    return { ok: false, today, patched: 0, dates: dates, logs, error: '字段不完整' };
  }
  if (EXTRAS_FIELDS.some(f => idx[f] < 0)) {
    logs.push('[extras] ⚠️ numcat 本次未返回全部四要素字段: ' + JSON.stringify(idx));
  }
  logs.push('[extras] numcat 返回 ' + items.length + ' 行');

  // 4. 只补「库内缺 + 本次有值」的行
  const nowIso = new Date().toISOString();
  const rows = [];
  items.forEach(row => {
    const code = String(row[symI] || '').trim();
    const dateStr = compactToDateStr(String(row[dateI] || '').trim());
    if (!code || !dateStr || !existing[dateStr]) return;

    const byName = existing[dateStr];
    // 同一 code 可能对应库内多行（理论上不会），这里全补
    byName.forEach(cur => {
      if (cur.code && cur.code !== code) return;
      const patch = { date: dateStr, stock: cur.name, scope: 'auction' };
      if (cur.code) patch.code = cur.code;
      let any = false;
      if (extrasIsEmpty(cur.um_vol) && idx.um_vol >= 0) {
        const v = extrasFmtUmVol(row[idx.um_vol]);
        if (v !== '') { patch.um_vol = v; any = true; }
      }
      if (extrasIsEmpty(cur.open_bid_pct) && idx.open_bid_pct >= 0) {
        const v = extrasFmt2(row[idx.open_bid_pct]);
        if (v !== '') { patch.open_bid_pct = v; any = true; }
      }
      if (extrasIsEmpty(cur.auc_vol_ratio) && idx.auc_vol_ratio >= 0) {
        const v = extrasFmt2(row[idx.auc_vol_ratio]);
        if (v !== '') { patch.auc_vol_ratio = v; any = true; }
      }
      if (extrasIsEmpty(cur.auc_turnover) && idx.auc_turnover >= 0) {
        const v = extrasFmt2(row[idx.auc_turnover]);
        if (v !== '') { patch.auc_turnover = v; any = true; }
      }
      if (!any) return;
      patch.source = 'worker';
      patch.updated_at = nowIso;
      patch.updated_by = 'auto-fetch-worker-extras';
      rows.push(patch);
      // 补过之后就地标记，避免同一行被重复写入
      EXTRAS_FIELDS.forEach(f => { if (patch[f] !== undefined) cur[f] = patch[f]; });
    });
  });

  if (rows.length === 0) {
    logs.push('[extras] ⚠️ numcat 本次未给出任何可补的四要素值（当日未结算时属正常，次日窗口重刷会自动补上）');
    return { ok: true, today, patched: 0, dates: dates, logs };
  }

  // 5. 分批写入
  let patched = 0;
  for (let i = 0; i < rows.length; i += EXTRAS_CHUNK) {
    const chunk = rows.slice(i, i + EXTRAS_CHUNK);
    try {
      await upsertMarketMetrics(env, chunk);
      patched += chunk.length;
    } catch (e) {
      logs.push('[extras] ❌ 第 ' + (Math.floor(i / EXTRAS_CHUNK) + 1) + ' 批写入失败: ' + e.message);
    }
  }
  logs.push('[extras] ✅ 补写 ' + patched + '/' + rows.length + ' 行竞价四要素');
  return { ok: patched > 0, today, patched: patched, dates: dates, logs };
}


// ────── bidding-auto-fetch/logic/morning-workflow.js ──────
// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为若干子函数）
// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏。早盘放在【最后】跑一次（不阻塞 P0/P1/P2）：
// 猫抓对当日行通常不给四要素，但若为单日请求/结算较快而给了，就能在 9:26 前顺手落库；
// 没给也零副作用（只补缺失值，写 0 行）。真正的兜底是 16:00 close 与次日窗口重刷。
// [PLAN-A 2026-09-10] 区间涨幅口径复用前端同一份纯函数（单一真相 §6）：
// 窗口天数 / 复利累乘 / T 腿竞价占位判定 全部只此一份，前后端不会算出两个结果。
// ⚠️ 跨目录引用会让 workers/_bundle.mjs 把该文件一并打进单文件产物（Cloudflare 复制粘贴部署），
//    因此 src/logic/auction/range-window.js 必须保持「零 import 的纯函数」，不得引入 Vue / DOM 依赖。
/** 与 range-window.RANGE_WINDOW_DAYS 同源；显式断言避免有人改动窗口天数后 worker 静默失配 */
const RANGE_DAYS = RANGE_WINDOW_DAYS;

// ============================================================================
// [LATENCY 2026-09-11] 9:25 必须「尽早落库」，不是「最终一致」
// ----------------------------------------------------------------------------
// 用户操作节奏要求：9:26 之前必须能在看板上看到当天的竞价数据，晚一分钟就乱了。
// 但实测 market_metrics 的 created_at（= 当天首批行的落库时刻，北京时间）在持续退化：
//     2026-09-09 → 09:25:19   ✅
//     2026-09-10 → 09:26:18   ⚠️
//     2026-09-11 → 09:29:56   ❌（第二批甚至到 09:30:03）
// 本地逐段实测（.tmpdiag/probe_morning_latency.mjs，只读）显示旧链路是【纯串行】的：
//   步骤1  成分股 2.8s → 代码表 1.2s → 交易日历 1.4s → 前日名单 0.5s → 代码表 1.2s
//          → 今日名单 0.5s → 代码表 1.2s → 交易日历 1.4s → 前日标签 0.8s → 写名单 0.6s ≈ 11.6s
//          （其中交易日历接口实测返回空、每次都要回退本地日历，白耗 1.4s × 4 次）
//   步骤3  交易日历 1.4s → numcat daily_auc 2.0s →【今天缺失时 sleep 20s + 40s = 60s】
//   步骤5  交易日历 1.4s → numcat daily 1.2s
//   步骤6  market_metrics 按「日期 × 字段形状桶」串行 upsert，实测单次 ≈7s，十几批就是 1~2 分钟
// 结论：慢的不是某一个接口，而是「串行 + 重复请求 + 无关步骤挡在 P0 前面」。
//
// 改造原则：**今天的数据（名单 + 竞价指标）是 P0，必须在最早的时间点写下去**；
//           历史日 change_pct、10 日区间涨幅是 P1/P2，允许晚几十秒，绝不能挡在 P0 前面。
// ============================================================================

/** 今天数据缺失时的重试等待（秒）。原 [20, 40] 最坏 60s —— 单这一项就能把落库推到 09:26 之后。
 *  猫抓 daily_auc 当日数据实测 9:25:10 前后就绪，25 秒窗口足够，且保证最后一次请求
 *  不晚于 09:25:30 发出，给写入留出时间。 */
const TODAY_RETRY_DELAYS_SEC = [5, 8, 12];

// ---------------------------------------------------------------------------
// 单次 runMorning 内的轻量 memo：消除「同一份数据被串行请求 3~4 次」
// ---------------------------------------------------------------------------
function createRunCache() {
  return { _tdAll: null, _tdPending: null };
}

/** 取截止 today（含）最近 n 个交易日。整轮只发一次交易日历请求（失败抛错时返回 []） */
async function recentTradingDays(cache, env, today, n) {
  if (!cache._tdPending) {
    cache._tdPending = getRecentTradingDays(env, today, RANGE_DAYS)
      .catch(function (e) {
        console.warn('[MORNING] getRecentTradingDays 失败:', e && e.message);
        return [];
      });
  }
  const all = await cache._tdPending;
  if (!all || all.length === 0) return [];
  return n >= all.length ? all.slice() : all.slice(-n);
}

function settled(p) {
  return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; });
}

// ---------------------------------------------------------------------------
// [2026-09-11] 「竞价四要素」= 未匹配量 / 抢筹幅度 / 竞价量比 / 真换手率
//   这四个是趋势图右侧展示的核心指标，也是「量比抢筹高光」的判据。
//   ⚠️ 取证结论（.tmpdiag/diag_last_write.mjs）：猫抓 daily_auc 对【当日】这一行
//      **不返回**这四个字段的值，只有 auc_vol / auc_pct_chg / auc_to_pre_vol_pct；
//      四要素要等这一天结算后才出现（实际观测：次日早盘窗口重刷时自动补上）。
//   因此 9:25 早盘**不能**等它们（等也等不到，还会顶穿 9:26 硬指标），
//   改由 runAuctionExtrasPatch 在结算后补写（16:00 close 自动跑 / 手动 /fetch?point=extras）。
// ---------------------------------------------------------------------------
const AUCTION_EXTRA_FIELDS = ['um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];

/**
 * 判断某批 daily_auc 响应里「今天」的行是否已带竞价四要素。
 * @returns {{ok:boolean, hasFields:boolean, filled:number, total:number}}
 *   ok        = 今天至少有行，且至少 60% 的行带上了四要素（剩余少数可能是停牌/无竞价）
 *   hasFields = numcat 本次响应里是否存在这四个字段（false 说明接口层就没给）
 */
function todayAuctionExtras(rows, flds, today) {
  const list = rows || [];
  const fs = flds || [];
  const dateI = fs.indexOf('tradedate');
  const idxs = AUCTION_EXTRA_FIELDS.map(f => fs.indexOf(f));
  const hasFields = idxs.some(i => i >= 0);
  const out = { ok: false, hasFields: hasFields, filled: 0, total: 0 };
  if (dateI < 0) return out;
  list.forEach(row => {
    if (compactToDateStr(String(row[dateI] || '').trim()) !== today) return;
    out.total++;
    const filled = idxs.some(i => i >= 0 && row[i] !== null && row[i] !== undefined && String(row[i]).trim() !== '');
    if (filled) out.filled++;
  });
  // 门槛 60%：允许少量停牌 / 无竞价成交的票天然为空，但绝不允许「整批为空」被当成正常
  out.ok = out.total > 0 && hasFields && (out.filled / out.total) >= 0.6;
  return out;
}

// 1. 检查是否交易日
function checkTradingDay(today, logs) {
  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }
  return null;
}

// 2. 获取最近多板成分股 + 写入 auction_watchlist
// [LATENCY 2026-09-11] 原来这一步是 9 次串行网络调用（≈11.6s），现改为 3 组并行（≈3s）：
//   组A：成分股 ∥ 代码表 ∥ 交易日历       ← 三者互不依赖
//   组B：前日名单 ∥ 今日名单 ∥ 前日标签    ← 只依赖组A的交易日历
//   组C：仅对「仍缺 code 的名字」做一次按名精确补码（通常 0 次或 1 次小请求）
async function fetchAndWriteWatchlist(env, today, cache, logs) {
  logs.push('步骤1：并行获取 成分股 / 代码表 / 交易日历...');
  const [ladderRes, codeMapRes, tdRes] = await Promise.all([
    settled(fetchLadderConstituents(env)),
    settled(readStockCodeMap(env)),
    settled(recentTradingDays(cache, env, today, 2))
  ]);

  if (!ladderRes.ok) {
    logs.push('获取成分股失败: ' + ladderRes.e.message);
    return { error: '获取成分股失败: ' + ladderRes.e.message };
  }
  const ladderConstituents = ladderRes.v || [];
  logs.push('成分股数量: ' + ladderConstituents.length);
  if (ladderConstituents.length === 0) {
    return { error: '883410 成分股为空' };
  }

  const codeMap = (codeMapRes.ok && codeMapRes.v) || {};
  if (!codeMapRes.ok) logs.push('读取 stockcodemap 失败(非致命): ' + codeMapRes.e.message);
  const recentDays = (tdRes.ok && tdRes.v) || [];
  const prevDay = recentDays.length >= 2 ? recentDays[recentDays.length - 2] : null;

  // 组B：三个名单来源并行（原来串行 3 次 + 中间夹着 2 次重复的代码表读取）
  logs.push('步骤1b：并行读取 前日名单 / 今日名单 / 前日标签...');
  const [prevWlRes, todayWlRes, tagRes] = await Promise.all([
    settled(prevDay ? readAuctionWatchlistForDate(env, prevDay) : Promise.resolve([])),
    settled(readAuctionWatchlistForDate(env, today)),
    settled(prevDay ? readAuctionTagsForDate(env, prevDay) : Promise.resolve([]))
  ]);

  let constituents = ladderConstituents;

  // [BUG-FIX] 合并前一日 auction_watchlist 表里的额外股票（打标签/观察组），
  // 确保 worker 也为它们抓取竞价数据，否则观察组股票早上没有数据
  if (prevWlRes.ok && prevWlRes.v && prevWlRes.v.length > 0) {
    const prevStocks = prevWlRes.v;
    const existingCodes = new Set(constituents.map(c => c.code));
    const extraStocks = prevStocks.filter(s => {
      const code = s.code || codeMap[s.name] || '';
      return code && !existingCodes.has(code);
    }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
    if (extraStocks.length > 0) {
      logs.push('前一日额外股票(打标签/观察组): ' + extraStocks.length + ' 只，合并到抓取名单');
      constituents = constituents.concat(extraStocks);
    }
  } else if (prevWlRes.e) {
    logs.push('读取前一日 watchlist 失败(非致命): ' + prevWlRes.e.message);
  }

  // [BUG-FIX] 也读今日 auction_watchlist，合并用户在前端提前打开页面时已加入的股票
  const todayStocks = (todayWlRes.ok && todayWlRes.v) || [];
  if (todayWlRes.e) logs.push('读取今日 watchlist 失败(非致命): ' + todayWlRes.e.message);
  if (todayStocks.length > 0) {
    const existingCodes = new Set(constituents.map(c => c.code));
    const todayExtra = todayStocks.filter(s => {
      const code = s.code || codeMap[s.name] || '';
      return code && !existingCodes.has(code);
    }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
    if (todayExtra.length > 0) {
      logs.push('今日 watchlist 额外股票(前端提前继承): ' + todayExtra.length + ' 只，合并到抓取名单');
      constituents = constituents.concat(todayExtra);
    }
  }

  // [FEAT 2026-09-08] 合并「上一交易日打过标签（买/卖/持有）」的股票到抓取名单。
  // 只并入 constituents（抓取名单），不写 auction_watchlist → 不破坏「当日名单 = 9:25 快照」的锁定口径（§6）。
  if (tagRes.ok && tagRes.v && tagRes.v.length > 0) {
    const existingNames = new Set(constituents.map(c => c.name));
    const existingCodes = new Set(constituents.map(c => c.code));
    const tagExtra = [];
    tagRes.v.forEach(function (t) {
      if (existingNames.has(t.name)) return;
      const code = codeMap[t.name] || '';
      if (!code || existingCodes.has(code)) return;
      existingNames.add(t.name);
      existingCodes.add(code);
      tagExtra.push({ name: t.name, code: code });
    });
    if (tagExtra.length > 0) {
      logs.push('前一日(' + prevDay + ')打标签股票(买/卖/持有): ' + tagExtra.length +
        ' 只，合并到抓取名单（不写 watchlist）');
      constituents = constituents.concat(tagExtra);
    }
  } else if (tagRes.e) {
    logs.push('读取前一日打标签股票失败(非致命): ' + tagRes.e.message);
  }

  // 组C：仍缺 code 的名字，按名精确补一次（全表读被 1000 行上限截断的兜底）
  // 注意：这里只补「名单里已经确定要抓」的名字，不补 watchlist 行本身的 code。
  const nameless = todayStocks.concat(prevWlRes.ok && prevWlRes.v ? prevWlRes.v : [])
    .map(s => s.name)
    .filter(n => n && !codeMap[n]);
  if (nameless.length > 0) {
    const extra = await readStockCodeMapByNames(env, Array.from(new Set(nameless)));
    const added = Object.keys(extra).length;
    if (added > 0) {
      Object.keys(extra).forEach(n => { codeMap[n] = extra[n]; });
      logs.push('按名精确补 code: ' + added + ' 只（全表读被 1000 行上限截断的兜底）');
      // 用补到的 code 再并入一次名单
      const existingCodes = new Set(constituents.map(c => c.code));
      const existingNames = new Set(constituents.map(c => c.name));
      const more = [];
      todayStocks.forEach(s => {
        if (existingNames.has(s.name)) return;
        const code = s.code || codeMap[s.name] || '';
        if (!code || existingCodes.has(code)) return;
        existingNames.add(s.name); existingCodes.add(code);
        more.push({ name: s.name, code: code });
      });
      if (more.length > 0) {
        constituents = constituents.concat(more);
        logs.push('补码后新增抓取标的: ' + more.length + ' 只');
      }
    }
  }

  // 【BUG-FIX】不写 volume/yest_volume/change_pct/note/topics 字段：
  // 这些字段的真实值由步骤4写入 market_metrics 表。
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
  const nowBj = beijingNow();
  const bjMinutes = nowBj.getUTCHours() * 60 + nowBj.getUTCMinutes();
  const inMorningWindow = bjMinutes >= 9 * 60 + 25 && bjMinutes <= 9 * 60 + 40;
  let rowsToWrite = watchlistRows;
  if (!inMorningWindow) {
    // 今日名单在组B里已经读过，直接复用，不再多打一次请求
    let existingNames = new Set(todayStocks.map(s => s.name));
    if (existingNames.size === 0) {
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
async function fetchNumcatWithRetry(env, constituents, today, cache, logs) {
  const expectedDates = await recentTradingDays(cache, env, today, CONFIG.NUMCAT_RECENT_DAYS);
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

  // ⚠️ 必须 let：重试可能返回更完整的 fields（四要素后到），要整体替换
  let fields = numcatData.fields || [];
  let items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  const dateIdxPre = fields.indexOf('tradedate');
  const computeGotDates = (rows, flds) => {
    const di = flds ? flds.indexOf('tradedate') : dateIdxPre;
    if (di < 0) return new Set();
    return new Set(rows.map(row => compactToDateStr(String(row[di] || '').trim())).filter(Boolean));
  };
  let missingDatesAfterNumcat = [];
  let curExtras = { ok: false, hasFields: false, filled: 0, total: 0 };
  if (dateIdxPre >= 0) {
    let gotDates = computeGotDates(items, fields);
    let missingDates = expectedDates.filter(d => !gotDates.has(d));
    if (missingDates.length > 0) {
      logs.push('⚠️ numcat 缺失交易日: ' + JSON.stringify(missingDates));
    } else {
      logs.push('numcat 覆盖了全部 ' + expectedDates.length + ' 个预期交易日');
    }

    // 【LATENCY 2026-09-11】重试等待 20s+40s → 5s+8s+12s。9:26 硬指标。
    //
    // ⚠️ 判据【只能】是「今天这个日期出现没」，绝不要把「竞价四要素是否就绪」塞进阻塞条件。
    //    取证（2026-09-11，.tmpdiag/diag_last_write.mjs）：
    //      · 同一轮写入（9/11 01:30:03）里 9/10 = 60/67 有四要素，9/11 = 0/67 全空；
    //      · 全表唯一「最后一个写入时刻 = 当天」的日期就是 9/11，它四要素为 0；
    //      · 8/07 起的每个历史日，四要素都是在【后续几天的窗口重刷】时才出现的。
    //    ⇒ 猫抓 daily_auc 对【当日】这一行不返回 um_vol/open_bid_pct/auc_vol_ratio/auc_turnover，
    //      它们要等这一天结算后才有。拿它当阻塞条件 = 每天白等 25s 且永远等不到，
    //      反而把 P0 落库顶穿 9:26。四要素改由 P3 补漏任务负责（runAuctionExtrasPatch）。
    if (missingDates.includes(today)) {
      for (let attempt = 0; attempt < TODAY_RETRY_DELAYS_SEC.length && missingDates.includes(today); attempt++) {
        const waitSec = TODAY_RETRY_DELAYS_SEC[attempt];
        logs.push('⏳ 今天(' + today + ')数据缺失，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
          const retryItems = retryData.items || [];
          const retryFields = retryData.fields && retryData.fields.length ? retryData.fields : fields;
          const retryGotDates = computeGotDates(retryItems, retryFields);
          if (retryGotDates.has(today)) {
            items = retryItems;
            fields = retryFields;
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
    // 四要素【只统计、不阻塞】。当日为空是猫抓的既定行为，不是故障；
    // 补漏交给 runAuctionExtrasPatch（16:00 close 跑 / 手动 /fetch?point=extras）。
    curExtras = todayAuctionExtras(items, fields, today);
    if (!curExtras.ok) {
      logs.push('ℹ️ 今天(' + today + ')的「竞价四要素」当日不可用（' + curExtras.filled + '/' + curExtras.total +
        ' 只非空' + (curExtras.hasFields ? '' : '，且 numcat 本次未返回这些字段') +
        '）——这是猫抓 daily_auc 对当日行的既定行为，P0 落库不受影响；' +
        '四要素将在当天结算后由补漏任务写回（最迟次日早盘窗口重刷时自动补上）。');
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

  return { expectedDates, items, fields, symIdx, nameIdx, dateIdx, volIdx, pctIdx, ratioIdx, missingDatesAfterNumcat, extras: curExtras };
}

// 3b. [LATENCY 2026-09-11] numcat daily（收盘涨幅）独立成一步，与 daily_auc 并发发出。
//     原来它串在 daily_auc 之后，白白多等 1.2s；而且它只服务 P1/P2（区间涨幅 / 历史日涨幅），
//     绝不能挡在「今天的竞价指标落库」前面。
async function fetchDailyWindow(env, constituents, today, expectedDates, cache, logs) {
  let rangeDates = await recentTradingDays(cache, env, today, RANGE_DAYS);
  if (rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('⚠️ 区间涨幅窗口交易日历异常(' + JSON.stringify(rangeDates) + ')，回退为竞价窗口 ' + JSON.stringify(expectedDates));
    rangeDates = expectedDates.slice();
  }
  rangeDates.sort();

  if (rangeDates.length === 0) {
    logs.push('步骤5：无可用交易日，跳过 numcat daily');
    return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: [] };
  }

  const startYMD = rangeDates[0].replace(/-/g, '');
  const endYMD = rangeDates[rangeDates.length - 1].replace(/-/g, '');
  const symbols = constituents.map(c => c.code).join(',');
  logs.push('步骤5：numcat daily ' + rangeDates.length + ' 天窗口（与 daily_auc 并发）...');

  try {
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD);
    const dailyFields = dailyData.fields || [];
    const dailyItems = dailyData.items || [];
    const dSymIdx = dailyFields.indexOf('symbol');
    const dDateIdx = dailyFields.indexOf('tradedate');
    const dPctIdx = dailyFields.indexOf('pct_chg');
    if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
      logs.push('numcat daily 返回字段不完整: ' + JSON.stringify(dailyFields));
      return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: rangeDates };
    }
    const pctByDate = {};
    const dailyByCode = {};
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
    logs.push('numcat daily 返回 ' + totalPctCount + ' 条，涉及 ' + Object.keys(pctByDate).length + ' 个交易日');
    return { ok: true, dailyByCode: dailyByCode, pctByDate: pctByDate, rangeDates: rangeDates };
  } catch (e) {
    logs.push('numcat daily 失败（今天的竞价数据不受影响，仅区间涨幅/历史涨幅本次不更新）: ' + e.message);
    return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: rangeDates };
  }
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

  logs.push('步骤4：解析数据...');
  // [2026-09-11] numcat 若未返回竞价四要素字段，这里必须显式报警：
  // 否则界面表现为「趋势图只有涨幅、四项竞价指标全空」，且日志里毫无痕迹，极难定位。
  if (umIdx < 0 || obpIdx < 0 || avrIdx < 0 || atrIdx < 0) {
    logs.push('⚠️ numcat daily_auc 未返回全部竞价四要素字段: ' + JSON.stringify({
      um_vol: umIdx, open_bid_pct: obpIdx, auc_vol_ratio: avrIdx, auc_turnover: atrIdx
    }) + '（idx=-1 表示该字段本次不存在）→ 这些字段本次留空');
  }
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
    // 但后续会用 numcat daily 的收盘涨幅覆盖【历史日】的 change_pct，
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

// 5. 历史日收盘涨幅合并（纯内存）+ 计算区间涨幅行
//    原 fetchAndMergeHistoricalPct 的网络部分已拆到 fetchDailyWindow（与 daily_auc 并发）。
function mergeHistoricalAndBuildRange(constituents, expectedDates, today, metricsByDate, daily, logs) {
  const { dailyByCode, pctByDate, rangeDates, ok } = daily;
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d));
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat daily_auc 完全未返回以下历史交易日: ' + JSON.stringify(phantomDates));
  }
  if (!ok) return { phantomDates: phantomDates, rangeRows: [] };

  // ① 历史日 change_pct 合并（口径保持改造前不变：只覆盖历史日，今天不动）
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
  logs.push('历史涨幅合并 ' + mergedCount + ' 条' + (phantomFilledCount > 0 ? '，补齐 daily_auc 完全缺失日期 ' + phantomFilledCount + ' 条' : ''));

  // ② 区间涨幅（T 腿 = 9:25 竞价涨幅；15:00 后手动补抓时为收盘涨幅）
  const rangeRows = buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs);
  return { phantomDates: phantomDates, rangeRows: rangeRows };
}

/**
 * [PLAN-A] 计算「近 N 个交易日区间涨幅」行（供写入 stock_range_pct）。
 * 口径与前端完全一致（复用 src/logic/auction/range-window.js）。
 */
function buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs) {
  if (!rangeDates || rangeDates.length === 0) return [];

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

  // [RANGE-FULL-LEG 2026-09-11 / 次日继承票「十日涨幅不更新」根因修复]
  //   拿不到【当天 T 腿】的票一律【不写行】，而不是让 buildRangeRows 把它跳过 T 腿继续算。
  //   原因：跳过 T 腿会产出一条 days=窗口-1 的「残缺行」，它看起来有涨幅却系统性偏低；
  //   更糟的是前端 close-pct-cover 的 T 腿代数换腿会假定「已存值含竞价腿」而把它算得更错，
  //   并刷新 updated_at 使 worker 16:00 的降级通道认定「已是收盘口径」→ 错值被永久冻结。
  //   实测（2026-09-11）：国芳集团 只累乘历史 9 天 = 81.17%，换腿后 91.11%，正确应为 96.04%。
  //   不写行是安全的：前端 dragon-rank「云端没有该行」的兜底会重算，worker 16:00 整段重算也会补上。
  const eligibleTargets = [];
  let noTLegCount = 0;
  constituents.forEach(c => {
    if (!c || !c.code) return;
    if (tLegByCode[c.code] === undefined) { noTLegCount++; return; }
    eligibleTargets.push(c);
  });

  const built = buildRangeRows(eligibleTargets, rangeDates, dailyByCode, tLegByCode);
  const nowIso = new Date().toISOString();
  const rows = built.map(r => ({
    date: today,
    stock: r.stock,
    range_pct: Number(r.pct).toFixed(2),
    days: r.days,
    updated_at: nowIso
  }));
  logs.push('步骤5b：区间涨幅计算完成 ' + rows.length + '/' + eligibleTargets.length + ' 只（T 腿口径=' +
    (useAuctionLeg ? '9:25 竞价涨幅' : '当日收盘涨幅') + '）' +
    (noTLegCount > 0 ? '；' + noTLegCount + ' 只无当天 T 腿 → 本次不写行（交由权威整段重算补齐）' : ''));
  return rows;
}

// 6. 写入 market_metrics
// [LATENCY 2026-09-11] 原来是「for 日期 { for 字段形状桶 { await upsert } }」全串行，
//   实测单次 upsert ≈7s、十几批就是 1~2 分钟 —— 这是 9/11 拖到 09:29:56 的主因之一。
//   现在：① 形状桶跨【日期】合并（冲突键是 date,stock,scope，不同日期可以同批），
//        批次数从「日期数 × 桶数」降到「桶数」；② 同一批内并发写出；
//        ③ 调用方按 P0(今天) / P2(历史日) 分两次调用，保证今天先落库。
async function writeMetricsForDates(env, metricsByDate, dateFilter, nowIso, logs) {
  const buckets = {};
  let totalMetricsWritten = 0;
  let metricsWriteFailures = 0;
  const dateKeys = Object.keys(metricsByDate).filter(dateFilter);
  if (dateKeys.length === 0) return { totalMetricsWritten: 0, metricsWriteFailures: 0, dateKeys: [] };

  dateKeys.forEach(dateStr => {
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
      if (!buckets[shapeKey]) buckets[shapeKey] = [];
      buckets[shapeKey].push(row);
    });
  });

  const jobs = Object.keys(buckets).map(shapeKey => {
    const rows = buckets[shapeKey];
    return upsertMarketMetrics(env, rows)
      .then(function () { return { ok: true, n: rows.length }; })
      .catch(function (e) {
        logs.push('  market_metrics 形状桶 ' + shapeKey + ' 写入失败: ' + e.message);
        return { ok: false, n: 0, err: e.message };
      });
  });
  const results = await Promise.all(jobs);
  results.forEach(function (r) {
    if (r.ok) totalMetricsWritten += r.n;
    else metricsWriteFailures++;
  });
  logs.push('  market_metrics 写入 ' + totalMetricsWritten + ' 行（' + dateKeys.length + ' 个日期 / ' +
    Object.keys(buckets).length + ' 个字段形状批，并发）');
  return { totalMetricsWritten, metricsWriteFailures, dateKeys };
}

// 7. 构建数据完整性汇总
function buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs) {
  const todayMissing = missingDatesAfterNumcat.includes(today);
  const summaryParts = [];
  if (todayMissing) summaryParts.push('❌ 今天(' + today + ')竞价数据缺失，需手动补抓');
  if (phantomDates.length > 0) summaryParts.push('⚠️ 历史日 volume/yest_volume 缺失: ' + phantomDates.join(', '));
  if (metricsWriteFailures > 0) summaryParts.push('❌ market_metrics 写入失败 ' + metricsWriteFailures + ' 个批次');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 本次 ' + expectedDates.length + ' 个交易日数据完整';
  logs.push('数据完整性汇总: ' + completenessSummary);
  return { completenessSummary, todayMissing };
}

// 主流程
async function runMorning(env) {
  const logs = [];
  const _t0 = Date.now();
  const mark = (label) => { logs.push('⏱ ' + label + ' +' + (Date.now() - _t0) + 'ms'); };
  const today = beijingToday();
  const cache = createRunCache();
  logs.push('today=' + today);

  const skipResult = checkTradingDay(today, logs);
  if (skipResult) return skipResult;

  // ---- P0-① 名单（并行取数，写完即可让前端看到当天的票）----
  const watchlistResult = await fetchAndWriteWatchlist(env, today, cache, logs);
  if (watchlistResult.error) {
    return { ok: false, today, error: watchlistResult.error, logs };
  }
  const { constituents, watchlistRows, nowIso } = watchlistResult;
  mark('名单落库');

  // ---- P0-② 竞价 daily_auc 与 收盘 daily【并发】（两者互不依赖）----
  const [numcatResult, dailyResult] = await Promise.all([
    fetchNumcatWithRetry(env, constituents, today, cache, logs),
    // 预期交易日在这里也要用到，先拿一次（memo 后几乎零成本）
    recentTradingDays(cache, env, today, CONFIG.NUMCAT_RECENT_DAYS)
      .then(expected => fetchDailyWindow(env, constituents, today, expected, cache, logs))
  ]);
  mark('numcat 取数完成');

  if (numcatResult.error) {
    return { ok: false, today, error: numcatResult.error, logs };
  }
  const { expectedDates, items, fields, missingDatesAfterNumcat, extras } = numcatResult;

  const { metricsByDate, yestVolDerivedCount } = parseNumcatToMetrics(items, fields, constituents, logs);

  // ---- P0-③ 【今天】的 market_metrics 立刻落库 —— 不等区间涨幅、不等历史日 ----
  // 正确性：历史日合并只改 d < today 的行，今天的行在此刻已是最终值
  // （change_pct = auc_pct_chg 的 9:25 竞价副本，正是早盘口径）。
  const todayWrite = await writeMetricsForDates(env, metricsByDate, d => d === today, nowIso, logs);
  mark('今天 market_metrics 落库 ' + todayWrite.totalMetricsWritten + ' 行');

  // ---- P1 历史日合并 + 10 日区间涨幅（纯内存计算后落库）----
  const { phantomDates, rangeRows } = mergeHistoricalAndBuildRange(constituents, expectedDates, today, metricsByDate, dailyResult, logs);

  let rangeWritten = 0;
  let rangeWriteFailed = false;
  if (rangeRows.length > 0) {
    try {
      await upsertStockRangePct(env, rangeRows);
      rangeWritten = rangeRows.length;
      logs.push('步骤6：stock_range_pct 写入 ' + rangeWritten + ' 行');
    } catch (e) {
      rangeWriteFailed = true;
      logs.push('❌ stock_range_pct 写入失败: ' + e.message);
    }
  } else {
    logs.push('⚠️ 区间涨幅无结果可写（numcat daily 不可用或名单为空），本次 stock_range_pct 未更新');
  }
  mark('区间涨幅落库');

  // ---- P2 历史日 market_metrics（允许晚一点，不阻塞今天的可用性）----
  const histWrite = await writeMetricsForDates(env, metricsByDate, d => d !== today, nowIso, logs);
  mark('历史日 market_metrics 落库 ' + histWrite.totalMetricsWritten + ' 行');

  // ---- P3 竞价四要素补漏（保留为「零请求」安全网，最后跑，绝不挡在 P0 前面）----
  // [QUOTA 2026-09-11] 这一步以前带 dates:[today] 会真发一次猫抓请求，但猫抓对【当日】行
  // 永远不返回四要素（取证结论见 extras-workflow.js 文件头）→ 100% 白烧 1 次额度/天
  // （占日额度 1/10）。现在 runAuctionExtrasPatch 默认 includeToday=false：dates 只剩今天
  // → 立即零请求返回，只留一条日志。今天能拿到的四要素在 P0 写入时就已经落库；
  // 结算后的缺口由 16:00 close（自动排除今天）与次日早盘窗口重刷补齐。
  // 保留这个调用点是刻意的：万一将来猫抓改了当日返回行为，这里会自动恢复补写能力。
  let extrasPatched = 0;
  if (extras && !extras.ok) {
    try {
      const ex = await runAuctionExtrasPatch(env, { logs: logs, dates: [today] });
      extrasPatched = ex.patched || 0;
    } catch (e) {
      logs.push('竞价四要素补漏失败（非致命）: ' + e.message);
    }
    mark('竞价四要素补漏 ' + extrasPatched + ' 行');
  }

  const metricsWriteFailures = todayWrite.metricsWriteFailures + histWrite.metricsWriteFailures;
  const totalMetricsWritten = todayWrite.totalMetricsWritten + histWrite.totalMetricsWritten;
  const dateKeys = todayWrite.dateKeys.concat(histWrite.dateKeys);

  const { completenessSummary, todayMissing } = buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行, stock_range_pct ' + rangeWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    todayMetricsWritten: todayWrite.totalMetricsWritten,
    elapsedMs: Date.now() - _t0,
    rangeWritten: rangeWritten,
    rangeWriteFailed: rangeWriteFailed,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    // 竞价四要素在「当日」拿不到是猫抓的既定行为，这里只做可观测性上报，不影响 ok
    auctionExtrasToday: (extras && extras.filled + '/' + extras.total) || '0/0',
    extrasPatched: extrasPatched,
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
// 【KLINE-FALLBACK 2026-09-11】猫抓额度（每天 10 次）在 16:00 常已用尽 → 整段重算拿不到窗口，
//   于是「缺腿行」（days < 窗口，例：次日继承票当时没有 T 腿）永远修不好（实测 7 只错值，
//   国芳集团 91.11%）。现在补一条【同花顺 K 线】通道（无额度限制）专门重算缺腿行，
//   让区间涨幅的修复完全不依赖猫抓额度。缺腿行【绝不】做代数换腿。
//
// 【幂等】re-run 安全：change_pct 值相同不写；区间涨幅值/天数相同不写。






// [EXTRAS-PATCH 2026-09-11] 竞价四要素（未匹配量/抢筹幅度/竞价量比/真换手率）补漏：
// 猫抓 daily_auc 对【当日】行不返回这四个字段，必须等结算后补写 —— 16:00 正是最合适的时机。

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

/**
 * @param {object} env
 * @param {{date?:string}} [opts] date='YYYY-MM-DD' 可指定要覆盖的交易日（默认=北京今天）。
 *        用途：[REPAIR-DATE 2026-09-11] 手动修复历史某天（例如 9:25 写出过缺腿区间涨幅、
 *        或当天收盘覆盖没跑成）。交易日闸门校验的是【该参数日期】而非当前时刻，
 *        因此周末/盘后也能补修过去某一天。不传则完全保持原行为（= 补抓当天）。
 */
async function runClose(env, opts) {
  const logs = [];
  const today = (opts && opts.date) || beijingToday();
  logs.push('today=' + today + (opts && opts.date ? '（手动指定日期）' : ''));

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

  // 6. [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏。
  //    放在最后：① 16:00 当日已结算，猫抓这时才给四要素；② 它只写四个字段（merge 语义），
  //    不影响前面的 change_pct 覆盖；③ 失败不致命 —— 最迟次日早盘窗口重刷也会自动补上。
  logs.push('步骤5：补写竞价四要素（未匹配量/抢筹幅度/竞价量比/真换手率）...');
  let extrasPatched = 0;
  try {
    // [QUOTA 2026-09-11] 只传窗口、不传 [today] 兜底：四要素补漏默认【排除当天】
    // （猫抓对当日行不给这四个字段，算进待补集合只是白烧 1 次额度）。
    // rangeDates 为空时交给函数自取默认窗口（同样是 [T-9,T] 再去掉今天）。
    const ex = await runAuctionExtrasPatch(env, { logs: logs, dates: rangeDates });
    extrasPatched = ex.patched || 0;
  } catch (e) {
    logs.push('竞价四要素补漏失败（非致命）: ' + e.message);
  }

  const completenessSummary = '✅ 收盘覆盖 ' + written + '/' + metrics.length + ' 只（来源=' + source +
    '），区间涨幅更新 ' + rangeFixed + ' 只，竞价四要素补写 ' + extrasPatched + ' 行';
  logs.push('数据完整性汇总: ' + completenessSummary);
  logs.push('完成: 收盘涨幅覆盖 ' + written + ' 只, 区间涨幅更新 ' + rangeFixed + ' 只, 四要素补写 ' + extrasPatched + ' 行');
  return {
    ok: true,
    today,
    stocksCount: metrics.length,
    pctUpdated: written,
    rangeFixed: rangeFixed,
    extrasPatched: extrasPatched,
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
 * ①b [KLINE-FALLBACK 2026-09-11] 缺腿行专修（猫抓额度用尽时的唯一出路）：对库内
 *    `days < 窗口` 的行，用同花顺 K 线（无额度限制）重新组装 [T-9, T] 整段 → 同样
 *    「不劣化才覆盖」。没有它时这类行既不会被 ① 覆盖（猫抓拿不到窗口），也会被 ② 跳过。
 * ② 降级（猫抓不可用、当日涨幅来自同花顺 snapshot，没有历史窗口）：对库内仍是竞价口径
 *    （updated_at < 当日 15:00）且未在 ①/①b 覆盖的【完整行】，用 replaceTDayLeg 换掉 T 腿。
 *    缺腿行（days < 窗口）绝不换腿（代数反解必然更错，见 RANGE-FULL-LEG）。
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

  // ①b [KLINE-FALLBACK 2026-09-11] 缺腿行专修：猫抓窗口不可用时改用同花顺 K 线整段重算。
  //   为什么必须单列这一步：① 依赖猫抓 daily（每天仅 10 次额度，16:00 常已用尽）；
  //   ②（换腿）对缺腿行【主动跳过】（代数反解必然更错）。两者叠加 → 缺腿行永远修不好
  //   （2026-09-11 实测 7 只：国芳集团 91.11% / 百大集团 43.67% …全部是昨日错值）。
  //   同花顺 K 线无额度限制 → 用它对「库内 days < 窗口」的行重新组装，让修复不依赖猫抓。
  //   只处理缺腿行（通常个位数），并发 3 + 重试 + 熔断在 fetchFuyaoKlineWindowPct 内部。
  if (rangeDates.length > 0) {
    const incomplete = [];
    storedRows.forEach(r => {
      if (touched.has(r.stock)) return;
      const d = Number(r.days) || 0;
      if (d <= 0 || d >= rangeDates.length) return; // 只修缺腿行（完整行已由 ①/② 负责）
      const m = byName.get(r.stock);
      if (!m || !m.code) return;
      incomplete.push({ name: r.stock, code: m.code });
    });
    if (incomplete.length > 0) {
      try {
        const kByCode = await fetchFuyaoKlineWindowPct(env, incomplete, rangeDates, { concurrency: 3 });
        const dailyByCode2 = {};
        const tLegByCode2 = {};
        const targets2 = [];
        const tDash = today;
        incomplete.forEach(t => {
          const dm = kByCode.get(t.name);
          if (!dm) return;
          const hist = {};
          rangeDates.forEach(d => {
            if (d === tDash) return;
            const ymd = String(d).replace(/-/g, '');
            const v = dm.get(ymd);
            if (v !== undefined && isFinite(v)) hist[ymd] = v;
          });
          dailyByCode2[t.code] = hist;
          const tv = dm.get(String(tDash).replace(/-/g, ''));
          if (tv !== undefined && isFinite(tv)) tLegByCode2[t.code] = tv;
          targets2.push({ name: t.name, code: t.code });
        });
        let klineFixed = 0;
        if (targets2.length > 0) {
          const built2 = buildRangeRows(targets2, rangeDates, dailyByCode2, tLegByCode2);
          built2.forEach(r => {
            const old = stored.get(r.stock);
            const newPct = Number(Number(r.pct).toFixed(2));
            if (old) {
              const oldPct = parsePct(old.range_pct);
              const oldDays = Number(old.days) || 0;
              if (oldDays > r.days) return; // 不劣化覆盖（K 线窗口也不全时宁可不写）
              if (newPct !== null && oldPct !== null && Math.abs(oldPct - newPct) < PCT_EPS && oldDays === r.days) return;
            }
            out.push({
              date: today,
              stock: r.stock,
              range_pct: newPct.toFixed(2),
              days: r.days,
              updated_at: nowIso
            });
            touched.add(r.stock);
            klineFixed++;
          });
        }
        logs.push('区间涨幅缺腿行 K 线重算：' + incomplete.length + ' 只缺腿，K 线返回 ' +
          targets2.length + ' 只，修正 ' + klineFixed + ' 只');
      } catch (e) {
        logs.push('区间涨幅缺腿行 K 线重算失败（非致命）: ' + e.message);
      }
    }
  }

  // ② 降级：只换 T 腿（仅处理 ① 未覆盖、且仍是竞价口径的行）
  let skippedIncomplete = 0;
  storedRows.forEach(r => {
    if (touched.has(r.stock)) return;
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    if (Number.isNaN(t) || !t || t >= closeMs) return; // 已是收盘口径 → 不动
    const old = parsePct(r.range_pct);
    if (old === null) return;
    // [RANGE-FULL-LEG 2026-09-11] 缺腿行不做代数换算：replaceTDayLeg 假定「已存值含竞价 T 腿」，
    // 而缺腿行当时根本没进来 T 腿（days < 窗口）→ 换算只会算得更错（国芳 81.17% → 91.11%）。
    // 这类行只能靠整段重算：① 猫抓窗口 / ①b 同花顺 K 线窗口；两者都不可用时宁可不写（§10）。
    if (Number(r.days) < RANGE_WINDOW_DAYS) { skippedIncomplete++; return; }
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
    logs.push('区间涨幅无需更新（已是收盘口径）' +
      (skippedIncomplete > 0 ? '；另有 ' + skippedIncomplete + ' 个缺腿行未做换腿（不写错值，待下次整段重算）' : ''));
    return 0;
  }
  if (skippedIncomplete > 0) {
    logs.push('⚠️ 有 ' + skippedIncomplete + ' 个缺腿行（days < ' + RANGE_WINDOW_DAYS +
      '）不做换腿换算：只能靠整段重算（猫抓窗口 / 同花顺 K 线）修好');
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
// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏（可手动 /fetch?point=extras；16:00 close 也会自动跑）
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

async function dispatch(point, env, logs, opts) {
  if (point === 'morning') {
    const result = await runMorning(env);
    console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  if (point === 'close') {
    // [REPAIR-DATE 2026-09-11] 支持 ?date=YYYY-MM-DD 指定要覆盖/修复的交易日（默认北京今天）。
    const result = await runClose(env, { date: opts && opts.date });
    console.log('[auto-fetch] runClose 完成 ok=' + result.ok + ' today=' + (result.today || '') +
      ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runClose 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  if (point === 'extras') {
    // [QUOTA 2026-09-11] 默认排除当天（猫抓对当日行不给四要素，算进去只是白烧额度）。
    // 想坚持「含当天」的旧行为用于排查时，手动加 &today=1。
    const result = await runAuctionExtrasPatch(env, { includeToday: !!(opts && opts.includeToday) });
    console.log('[auto-fetch] runAuctionExtrasPatch 完成 ok=' + result.ok + ' patched=' + (result.patched || 0) +
      ' dates=' + JSON.stringify(result.dates || []));
    console.log('[auto-fetch] runAuctionExtrasPatch 完整日志:', JSON.stringify(result.logs || []));
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
      if (!['morning', 'close', 'extras'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|extras|auto（close 可附 &date=YYYY-MM-DD 指定修复的历史交易日；extras 可附 &today=1 含当天）' });
      }
      try {
        const result = await dispatch(point, env, [], {
          date: url.searchParams.get('date') || '',
          includeToday: url.searchParams.get('today') === '1'
        });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};

