// fuyao-api.js — 同花顺 fuyao 接口（proxy + 直连历史K线）
import { msToDateStr, dateStrToMs, normalizeDate } from '../../_shared-source/date-utils.js';
import { CONFIG } from '../config.js';

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
export async function fuyaoCalendarTradingDays(env) {
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
export async function fetchLadderConstituents(env) {
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
export async function fetchSnapshotChangePct(env, codes) {
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
export async function fetchHistoricalPctChg(env, constituents, historicalDates) {
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
export async function fetchFuyaoKlineWindowPct(env, items, dates, opts) {
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