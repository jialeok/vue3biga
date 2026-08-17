// ============================================================================
// auction-close-fetch — Supabase Edge Function (Deno)
// 收盘（16:00）自动抓取当天「最近多板」成分股涨幅并覆盖 market_metrics.change_pct。
//
// 由来：原功能在 Cloudflare bidding-auto-fetch worker 的 close-workflow（未在运行，
// 日志显示 8 月起 close cron 未触发）。按用户要求迁移到 Supabase Edge Function，
// 由 pg_cron 北京时间 16:00（UTC 08:00）触发，不再依赖 Cloudflare。
//
// 与 Cloudflare 版一致的行为：
//   1) 读当日 auction_watchlist（正式名单，9:25 已写入）拿 stock+code；
//   2) 同花顺 fuyao /api/a-share/prices/snapshot 批量拉收盘涨幅；
//   3) 只覆盖 market_metrics(scope='auction').change_pct，不碰名单/其它字段；
//   4) 覆盖率 <50% 自动重试 60s / 120s；
//   5) 结果写 bidding_fetch_log 供排查。
//
// 部署（二选一）：
//   A. Dashboard：Functions → 新建 auction-close-fetch → 粘贴本文件全部内容。
//   B. CLI：supabase functions deploy auction-close-fetch
// 部署后务必在函数设置里【关闭 Verify JWT】（函数自身用 FETCH_TOKEN 鉴权）；
// 并在 Secrets 里设置：FUYAO_API_KEY、FETCH_TOKEN
//   （SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 由平台自动注入）。
// 定时触发：在 Dashboard → SQL Editor 执行 db/supabase_auction_close_cron.sql
//   （pg_cron：北京时间 16:00 = UTC 08:00，工作日 周一至周五 1-5）。
// ============================================================================

const CONFIG = {
  SUPABASE_URL: (Deno.env.get('SUPABASE_URL') || 'https://tonqfgeyxnnwicjopshn.supabase.co').replace(/\/$/, ''),
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SNAPSHOT_BATCH_SIZE: 40,
  COVERAGE_THRESHOLD: 0.5,
  RETRY_DELAYS_SEC: [60, 120],
};

// --------------------------- 日期 / 节假日 ---------------------------
function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function beijingToday() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function isWeekend(dateStr) { const d = new Date(dateStr + 'T00:00:00'); const day = d.getDay(); return day === 0 || day === 6; }
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
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
]);
function localIsTradingDay(dateStr) { if (isWeekend(dateStr)) return false; return !KNOWN_HOLIDAYS.has(dateStr); }

// ----------------------------- 同花顺(fuyao)接口 -----------------------------
async function fuyaoGet(path, params) {
  const url = new URL(CONFIG.FUYAO_BASE + path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  }
  const resp = await fetch(url.toString(), { headers: { 'X-api-key': Deno.env.get('FUYAO_API_KEY') || '' } });
  if (!resp.ok) throw new Error('fuyao ' + path + ' HTTP ' + resp.status);
  const data = await resp.json();
  if (data.code !== 0) throw new Error('fuyao ' + path + ' 错误: code=' + data.code + ' ' + (data.message || ''));
  return data.data;
}

async function isTradingDay() {
  try {
    const data = await fuyaoGet('/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const today = beijingToday().replace(/-/g, '');
    return items.some(function (it) { return String(it.date) === today; });
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退到本地日历:', e.message);
    return localIsTradingDay(beijingToday());
  }
}

function tickerToThscode(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return '';
  if (c.startsWith('6') || c.startsWith('9')) return c + '.SH';
  if (c.startsWith('4') || c.startsWith('8')) return c + '.BJ';
  return c + '.SZ';
}

function applySnapshotItem(it, code, result, stats) {
  const pct = it.price_change_ratio_pct;
  if (pct === null || pct === undefined || pct === '') { stats.emptyField++; return; }
  const n = Number(pct);
  if (isNaN(n)) { stats.emptyField++; return; }
  let ratio = n;
  // 符号校正：接口偶尔返回正数但实际下跌（price_change<0 或 当前<昨收）
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && ratio > 0) ratio = -ratio;
  result[code] = (ratio >= 0 ? '+' : '') + ratio.toFixed(2) + '%';
}

// fuyao snapshot 批量获取收盘涨幅 → { pctMap: { code: pctStr }, stats: {...} }
async function fetchSnapshotChangePct(codes) {
  const result = {};
  const stats = {
    totalInput: codes.length, batchOk: 0, batchFail: 0,
    singleOk: 0, singleFail: 0, itemsReturned: 0,
    emptyField: 0, notMatched: 0, success: 0,
  };
  for (let i = 0; i < codes.length; i += CONFIG.SNAPSHOT_BATCH_SIZE) {
    const chunk = codes.slice(i, i + CONFIG.SNAPSHOT_BATCH_SIZE);
    const thscodes = chunk.map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    let data;
    try {
      data = await fuyaoGet('/api/a-share/prices/snapshot', { thscodes: thscodes });
      stats.batchOk++;
    } catch (batchErr) {
      stats.batchFail++;
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoGet('/api/a-share/prices/snapshot', { thscodes: thscode });
          stats.singleOk++;
          const items1 = (d1 && d1.item) || [];
          stats.itemsReturned += items1.length;
          items1.forEach(it => applySnapshotItem(it, code, result, stats));
        } catch (e1) { stats.singleFail++; }
      }
      continue;
    }
    const items = (data && data.item) || [];
    stats.itemsReturned += items.length;
    const codeSet = new Set(chunk);
    items.forEach(it => {
      const tcode = String(it.thscode || '').replace(/\..*$/, '');
      if (tcode && codeSet.has(tcode)) applySnapshotItem(it, tcode, result, stats);
      else stats.notMatched++;
    });
  }
  stats.success = Object.keys(result).length;
  return { pctMap: result, stats };
}

// ----------------------------- Supabase 读写 -----------------------------
function sbHeaders() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

async function readWatchlist(date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + encodeURIComponent(date) +
    '&select=stock,code&limit=1000';
  const resp = await fetch(url, { headers: sbHeaders() });
  if (!resp.ok) throw new Error('读取 auction_watchlist 失败: HTTP ' + resp.status);
  return await resp.json();
}

async function upsertMarketMetrics(rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date%2Cstock%2Cscope';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(), { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert market_metrics 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
  }
}

async function writeLog(entry) {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: Object.assign(sbHeaders(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
    });
  } catch (e) { console.error('写 bidding_fetch_log 失败（已忽略）:', e.message); }
}

// ----------------------------- 主流程 -----------------------------
async function runClose(source) {
  const logs = [];
  const today = beijingToday();
  const logBase = { run_date: today, time_point: 'close', source: source || 'cron', job: 'auction-close-fetch', worker: 'edge' };
  logs.push('today=' + today);

  if (!(await isTradingDay())) {
    logs.push('非交易日，跳过');
    await writeLog(Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 读取当日 auction_watchlist
  logs.push('步骤1：读取当日 auction_watchlist...');
  let watchlist;
  try {
    watchlist = await readWatchlist(today);
  } catch (e) {
    logs.push('读取 auction_watchlist 失败: ' + e.message);
    await writeLog(Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, today, error: '读取 auction_watchlist 失败: ' + e.message, logs };
  }
  logs.push('auction_watchlist 读取 ' + watchlist.length + ' 只');
  if (watchlist.length === 0) {
    logs.push('❌ 当日 auction_watchlist 为空（9:25 morning 可能未成功写入），无法覆盖涨幅');
    await writeLog(Object.assign(logBase, { ok: false, detail: { error: '当日列表为空' } }));
    return { ok: false, today, error: '当日 auction_watchlist 为空', skipped: true, reason: '当日列表为空', logs };
  }

  // 2. fuyao snapshot 批量获取收盘涨幅 + 覆盖率不足重试
  const codes = watchlist.map(w => w.code).filter(Boolean);
  let snapshotResult = await fetchSnapshotChangePct(codes);
  let pctMap = snapshotResult.pctMap;
  let stats = snapshotResult.stats;
  let coverage = codes.length > 0 ? stats.success / codes.length : 0;
  logs.push('步骤2：调用 fuyao snapshot 获取收盘涨幅...');
  logs.push('snapshot 第1次: success=' + stats.success + '/' + codes.length +
    ' (覆盖率 ' + (coverage * 100).toFixed(1) + '%)' +
    ' batchOk=' + stats.batchOk + ' batchFail=' + stats.batchFail +
    ' singleOk=' + stats.singleOk + ' singleFail=' + stats.singleFail +
    ' itemsReturned=' + stats.itemsReturned + ' emptyField=' + stats.emptyField + ' notMatched=' + stats.notMatched);

  for (let attempt = 0; attempt < CONFIG.RETRY_DELAYS_SEC.length && coverage < CONFIG.COVERAGE_THRESHOLD; attempt++) {
    const waitSec = CONFIG.RETRY_DELAYS_SEC[attempt];
    logs.push('⏳ snapshot 覆盖率 ' + (coverage * 100).toFixed(1) + '% 低于阈值，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
    await new Promise(r => setTimeout(r, waitSec * 1000));
    try {
      const retryResult = await fetchSnapshotChangePct(codes);
      const retryCoverage = codes.length > 0 ? retryResult.stats.success / codes.length : 0;
      logs.push('snapshot 第' + (attempt + 2) + '次: success=' + retryResult.stats.success + '/' + codes.length +
        ' (覆盖率 ' + (retryCoverage * 100).toFixed(1) + '%)');
      if (retryResult.stats.success > stats.success) {
        pctMap = retryResult.pctMap;
        stats = retryResult.stats;
        coverage = retryCoverage;
        logs.push('✅ 重试结果更好，采用重试结果 (success=' + stats.success + ')');
      } else {
        logs.push('第' + (attempt + 1) + '次重试结果未改善 (success=' + retryResult.stats.success + ')');
      }
    } catch (e) { logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message); }
  }

  if (stats.success === 0) {
    logs.push('❌ snapshot 接口未返回任何涨幅（可能接口故障/限流/收盘数据未结算）');
    await writeLog(Object.assign(logBase, { ok: false, detail: { error: 'snapshot 无数据', stats } }));
    return { ok: false, today, error: 'snapshot 接口未返回任何涨幅数据', stocksCount: watchlist.length, snapshotStats: stats, logs };
  }

  // 3. 写入 market_metrics（只覆盖 change_pct）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricsRows = watchlist.filter(w => w.code && pctMap[w.code]).map(w => ({
    date: today,
    stock: w.stock,
    code: w.code,
    change_pct: pctMap[w.code],
    scope: 'auction',
    source: 'worker',
    updated_at: nowIso,
    updated_by: 'auction-close-fetch-edge',
  }));

  let writeError = null;
  try {
    await upsertMarketMetrics(metricsRows);
    logs.push('market_metrics 写入 ' + metricsRows.length + ' 行 change_pct');
  } catch (e) {
    writeError = e.message;
    logs.push('写入 market_metrics 失败: ' + e.message);
    await writeLog(Object.assign(logBase, { ok: false, detail: { error: writeError } }));
    return { ok: false, today, error: '写入 market_metrics 失败: ' + writeError, logs };
  }

  const uncoveredCount = watchlist.length - metricsRows.length;
  if (coverage < CONFIG.COVERAGE_THRESHOLD) logs.push('⚠️ 覆盖率低 ' + (coverage * 100).toFixed(1) + '%');
  if (uncoveredCount > 0) logs.push('未覆盖 ' + uncoveredCount + ' 只（可能停牌/接口未返回）');
  const completenessSummary = uncoveredCount === 0 ? '✅ 涨幅覆盖完整 ' + metricsRows.length + '/' + watchlist.length
    : '⚠️ 覆盖 ' + metricsRows.length + '/' + watchlist.length + '（未覆盖 ' + uncoveredCount + ' 只）';
  logs.push('数据完整性汇总: ' + completenessSummary);

  await writeLog(Object.assign(logBase, { ok: true, detail: { pctUpdated: metricsRows.length, coverage, stats, completenessSummary } }));
  logs.push('完成: 收盘涨幅覆盖 ' + metricsRows.length + ' 只');
  return { ok: true, today, stocksCount: watchlist.length, pctUpdated: metricsRows.length, coverage, snapshotStats: stats, completenessSummary, logs };
}

// ----------------------------- 入口路由 -----------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === '/health') {
    return new Response(JSON.stringify({ ok: true, service: 'auction-close-fetch' }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (p === '/fetch' || p === '/' || p === '') {
    const token = url.searchParams.get('token') || '';
    const expected = Deno.env.get('FETCH_TOKEN');
    if (!expected || token !== expected) {
      return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const result = await runClose('http');
    return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('auction-close-fetch', { status: 200 });
});
