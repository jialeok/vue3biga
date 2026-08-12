// ===== bidding-board-worker-b — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-08-13 02:43:12
// 注意: 此文件由 _bundle-workers.ps1 自动生成，请勿手动编辑

// ────── bidding-board-worker-b/config.js ──────
// config.js — bidding-board-worker-b 配置
const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  ROW_SEAL: '封单家数',

  NUMCAT_URL: 'https://numcat.net/api/reference-proxy/market/emoindic-daily',
  NUMCAT_APINAME: 'emoindic_daily',
  NUMCAT_RECENT_DAYS: 10,
  SEAL_FIELD_CANDIDATES: ['owfd_0925_count', 'owfd_0925', 'seal_count_0925', 'fengdan_0925', 'fdjs_0925', 's_seal', 'seal_count'],

  EMOTION_FIELDS: {
    amount:        ['am', 'amount', 's_amount', 'total_amount', 's7', 's_amt'],
    predictVol:    ['am_pred', 'am_prednumber', 'predict_vol', 'predict_volume', 's_pv'],
    amountDiff:    ['am_diff', 'amount_diff'],
    limitUp:       ['u5', 'limit_up', 'zhangting', 'zt_count', 's1', 's4'],
    limitDown:     ['d3', 'limit_down', 'dieting', 'dt_count', 's5'],
    onceLimit:     ['u6', 'once_limit', 'yiziban', 'yzb_count', 's9'],
    highestLb:     ['l17', 'highest_lb', 'max_lb', 'highest_limit', 's10'],
    zhaban:        ['u12', 'zhaban', 'bomb', 'zhb_count', 's11'],
    zhabanRate:    ['fp108', 'zhaban_rate', 'bomb_rate', 'zhb_rate', 's12'],
  },

  JIWANG_TABLE: 'jiwang_data',
  EMOTION_TABLE: 'emotion_data',
};

const CRON_TO_POINT = {
  '25 1 * * 2-6': 't0925-seal',
  '26 1 * * 2-6': 't0926',
  '40 1 * * 2-6': 't0926',
  '0 8 * * 2-6': 'close',
  '25 1 * * 1-5': 't0925-seal',
  '26 1 * * 1-5': 't0926',
  '40 1 * * 1-5': 't0926',
  '0 8 * * 1-5': 'close',
};

const SEAL_COLUMN = 'time925';

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

// ────── bidding-board-worker-b/data/fuyao-api.js ──────
// data/fuyao-api.js — fuyao 行情接口 + 交易日历

async function fuyaoGet(env, path, params) {
  const url = new URL(CONFIG.FUYAO_BASE + path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  }
  const resp = await fetch(url.toString(), { headers: { 'X-api-key': env.FUYAO_API_KEY } });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('fuyao ' + path + ' 错误: code=' + data.code + ' ' + (data.message || ''));
  return data.data;
}

async function isTradingDay(env) {
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const today = beijingTodayCompact();
    return items.some(function (it) { return String(it.date) === today; });
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退到本地日历:', e.message);
    return localIsTradingDay(beijingToday());
  }
}

async function getNextTradingDay(env, today) {
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const dates = items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
    for (const d of dates) if (d > today) return d;
    console.warn('fuyao calendar 未找到下一交易日，回退到本地计算');
  } catch (e) {
    console.warn('fuyao calendar 错误，回退到本地计算:', e.message);
  }
  return localGetNextTradingDay(today);
}

function localGetNextTradingDay(dateStr) {
  let d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  while (true) {
    const s = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !KNOWN_HOLIDAYS.has(s)) return s;
    d.setDate(d.getDate() + 1);
  }
}

// ────── bidding-board-worker-b/data/numcat-api.js ──────
// data/numcat-api.js — NumCat 情绪周期接口

async function fetchNumCatEmotionFull(env) {
  const resp = await fetch(CONFIG.NUMCAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiname: CONFIG.NUMCAT_APINAME,
      apikey: env.NUMCAT_API_KEY,
      params: { recentdays: CONFIG.NUMCAT_RECENT_DAYS }
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('NumCat API HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('NumCat API 错误: ' + (json.message || JSON.stringify(json)));
  const fields = json.data.fields;
  const items = json.data.items;
  if (!Array.isArray(fields) || !Array.isArray(items) || items.length === 0) {
    throw new Error('NumCat API 返回数据格式异常');
  }
  return { fields, items };
}

async function numcatEmoindic(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  const latest = findTodayItem(fields, items);
  if (!latest) {
    throw new Error('NumCat 情绪周期接口未找到今日数据，可用日期字段: ' + fields.join(', '));
  }
  const sealCount = pickEmotionValue(fields, latest, CONFIG.SEAL_FIELD_CANDIDATES);
  if (sealCount === null) {
    throw new Error('NumCat 封单家数字段全部缺失，候选: ' + CONFIG.SEAL_FIELD_CANDIDATES.join(', ') + '，可用字段: ' + fields.join(', '));
  }
  return { sealCount: sealCount, availableFields: fields };
}

function pickEmotionValue(fields, item, candidates) {
  for (const name of candidates) {
    const idx = fields.indexOf(name);
    if (idx >= 0) {
      const v = item[idx];
      if (v !== null && v !== undefined && v !== '') return Number(v);
    }
  }
  return null;
}

function findDateField(fields) {
  return ['tradedate', 'trade_date', 'trading_day', 'date'].find(name => fields.indexOf(name) >= 0);
}

function sortItemsByDate(fields, items) {
  const dateField = findDateField(fields);
  if (!dateField) return items.slice();
  const idx = fields.indexOf(dateField);
  return items.slice().sort(function (a, b) {
    const da = String(a[idx] || '').replace(/-/g, '');
    const db = String(b[idx] || '').replace(/-/g, '');
    return Number(da) - Number(db);
  });
}

function findLatestItemIndex(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  return { sorted, index: sorted.length - 1 };
}

function findTodayItem(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  if (sorted.length === 0) return null;
  const dateField = findDateField(fields);
  if (!dateField) return sorted[sorted.length - 1];
  const idx = fields.indexOf(dateField);
  const today = beijingToday();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const itemDate = normalizeDate(sorted[i][idx]);
    if (itemDate === today) return sorted[i];
  }
  return null;
}

function buildJiwangStats(fields, items) {
  const latest = findTodayItem(fields, items);
  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (upIdx < 0 || downIdx < 0) throw new Error('NumCat API 响应缺少 s2/s6 字段，可用字段: ' + fields.join(', '));
  return { up: Number(latest[upIdx]), down: Number(latest[downIdx]) };
}

async function fetchNumCatMarketStats(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  return buildJiwangStats(fields, items);
}

// ────── bidding-board-worker-b/data/supabase-write.js ──────
// data/supabase-write.js — Supabase 读写

function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

async function upsertBiddingRows(env, rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert bidding_data 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
  }
}

async function writeLog(env, entry) {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
    });
  } catch (e) { console.error('写 bidding_fetch_log 失败（已忽略）:', e.message); }
}

async function updateJiwangShouguJieguo(env, date, stats) {
  const shouguJieguo = stats.down + ':' + stats.up;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.JIWANG_TABLE;
  const body = { date: date, shouguJieguo: shouguJieguo, updated_at: new Date().toISOString() };
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), {
      'Prefer': 'resolution=merge-duplicates, return=minimal'
    }),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Supabase upsert 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

// ────── bidding-board-worker-b/logic/seal-workflow.js ──────
// logic/seal-workflow.js — 封单家数

async function runSeal(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0925', source: source || 'cron', job: 'seal', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let sealResult;
  try {
    const numcat = await numcatEmoindic(env);
    const seal = numcat.sealCount;
    if (seal === null || isNaN(seal)) {
      sealResult = { value: null, error: 'NumCat 封单家数字段全部缺失，候选: ' + CONFIG.SEAL_FIELD_CANDIDATES.join(', ') + '，可用字段: ' + numcat.availableFields.join(', ') };
    } else {
      sealResult = { value: String(Math.round(seal)) };
    }
  } catch (e) {
    sealResult = { value: null, error: e.message };
  }

  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_SEAL, updated_at: now };
  row[SEAL_COLUMN] = sealResult.value;

  let ok = true, writeError = null;
  if (sealResult.value !== null && sealResult.value !== undefined) {
    try { await upsertBiddingRows(env, [row]); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: sealResult.value !== null ? [row] : [], row: sealResult, writeError } }));
  return { ok, date, point: 't0925-seal', column: SEAL_COLUMN, written: sealResult.value !== null ? [row] : [], row: sealResult, writeError };
}

// ────── bidding-board-worker-b/logic/emotion-workflow.js ──────
// logic/emotion-workflow.js — 情绪看板逻辑

async function runEmotion(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'emotion', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let full;
  try {
    full = sharedFull || await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);
  const items = sortItemsByDate(fields, full.items);

  const todayStr = beijingToday();
  const todayCompact = beijingTodayCompact();
  let todayIdx = -1;
  let yesterdayIdx = -1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    todayIdx = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });

    if (todayIdx >= 0) {
      yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          yesterdayIdx = i;
          break;
        }
      }
      if (yesterdayIdx < 0) yesterdayIdx = items.length - 1;
    }
  }

  if (todayIdx < 0) todayIdx = items.length - 1;
  if (yesterdayIdx < 0) yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;

  const todayItem = items[todayIdx];
  const yesterdayItem = items[yesterdayIdx];

  const metrics = {};
  const missingFields = [];
  for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
    const item = key === 'predictVol' ? todayItem : yesterdayItem;
    const val = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    metrics[key] = val;
    if (val === null) missingFields.push(key + '(' + CONFIG.EMOTION_FIELDS[key].join('/') + ')');
  }

  let predictVolFallback = false;
  if (metrics.predictVol === null && yesterdayItem) {
    const yPred = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      metrics.predictVol = yPred;
      predictVolFallback = true;
    }
  }
  metrics.predictVolFallback = predictVolFallback;

  let amountDiff = null;
  const rawAmDiff = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amountDiff);
  if (rawAmDiff !== null) {
    amountDiff = rawAmDiff / 1e8;
  } else if (yesterdayIdx > 0) {
    const prevItem = items[yesterdayIdx - 1];
    const yestAmount = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amount);
    const prevAmount = pickEmotionValue(fields, prevItem, CONFIG.EMOTION_FIELDS.amount);
    if (yestAmount !== null && prevAmount !== null) {
      amountDiff = (yestAmount - prevAmount) / 1e8;
    }
  }
  metrics.amountDiff = amountDiff !== null ? Number(amountDiff.toFixed(2)) : null;

  const fiveDays = items.slice(Math.max(0, yesterdayIdx - 4), yesterdayIdx + 1).map(function (item) {
    const row = {};
    for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
      row[key] = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    }
    if (dateField) {
      const dIdx = fields.indexOf(dateField);
      row._date = normalizeDate(item[dIdx]);
    } else {
      row._date = '';
    }
    return row;
  });

  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE;
  const body = {
    date: date,
    metrics: metrics,
    five_days: fiveDays,
    api_fields: fields,
    updated_at: new Date().toISOString()
  };

  let writeError = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: {
      todayIdx,
      yesterdayIdx,
      metrics,
      amountDiff,
      missingFields,
      availableFields: fields,
      fiveDaysCount: fiveDays.length,
      writeError
    }
  }));

  return {
    ok: !writeError,
    date,
    metrics,
    amountDiff,
    missingFields,
    availableFields: fields,
    todayDate: todayItem && dateField ? normalizeDate(todayItem[fields.indexOf(dateField)]) : '',
    yesterdayDate: yesterdayItem && dateField ? normalizeDate(yesterdayItem[fields.indexOf(dateField)]) : '',
    fiveDaysCount: fiveDays.length,
    fiveDaysPreview: fiveDays.map(function (d) { return { date: d._date, limitUp: d.limitUp }; }),
    writeError
  };
}

async function refreshEmotionPredictVol(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'http', job: 'emotion-refresh', worker: 'B' };

  let full;
  try {
    full = await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);
  const items = sortItemsByDate(fields, full.items);

  const todayStr = beijingToday();
  const todayCompact = beijingTodayCompact();
  let todayIdx = items.length - 1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    const found = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });
    if (found >= 0) {
      todayIdx = found;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          todayIdx = i;
          break;
        }
      }
    }
  }

  let predictVol = pickEmotionValue(fields, items[todayIdx], CONFIG.EMOTION_FIELDS.predictVol);
  let predictVolFallback = false;
  if (predictVol === null) {
    const fbItem = items[Math.max(0, todayIdx - 1)];
    const yPred = pickEmotionValue(fields, fbItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      predictVol = yPred;
      predictVolFallback = true;
    } else {
      await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: '未找到 am_pred 字段' } }));
      return { ok: false, error: 'NumCat 返回中未找到 am_pred 预测量能字段' };
    }
  }

  const readUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date) + '&select=metrics';
  let metrics = {};
  try {
    const readResp = await fetch(readUrl, { headers: sbHeaders(env) });
    if (readResp.ok) {
      const rows = await readResp.json();
      if (rows && rows[0] && rows[0].metrics) metrics = rows[0].metrics;
    }
  } catch (e) {
    console.warn('读取 emotion_data 失败:', e.message);
  }
  metrics.predictVol = predictVol;
  metrics.predictVolFallback = predictVolFallback;

  const updateUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date);
  let writeError = null;
  try {
    const resp = await fetch(updateUrl, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify({ date: date, metrics: metrics, updated_at: new Date().toISOString() })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: { todayIdx, predictVol, predictYi: predictVol / 1e8, writeError }
  }));

  return {
    ok: !writeError,
    date,
    predictVol,
    predictYi: predictVol / 1e8,
    writeError
  };
}

// ────── bidding-board-worker-b/logic/jiwang-workflow.js ──────
// logic/jiwang-workflow.js — 记忘看板 + 收盘主流程

async function runJiwang(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 'close', source: source || 'cron', job: 'jiwang', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  try {
    const stats = sharedFull
      ? buildJiwangStats(sharedFull.fields, sharedFull.items)
      : await fetchNumCatMarketStats(env);
    const nextTradingDay = await getNextTradingDay(env, date);
    await updateJiwangShouguJieguo(env, nextTradingDay, stats);
    await writeLog(env, Object.assign(logBase, { ok: true, detail: { today: date, nextTradingDay, stats } }));
    return { ok: true, today: date, nextTradingDay, stats };
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }
}

async function runClose(env, source) {
  let sharedFull = null;
  let sharedFullError = null;
  try {
    sharedFull = await fetchNumCatEmotionFull(env);
  } catch (e) {
    sharedFullError = e.message;
  }

  const jiwangPromise = sharedFull
    ? runJiwang(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const emotionPromise = sharedFull
    ? runEmotion(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const [jiwangResult, emotionResult] = await Promise.allSettled([
    jiwangPromise,
    emotionPromise
  ]);

  return {
    ok: (jiwangResult.status === 'fulfilled' && jiwangResult.value.ok) &&
        (emotionResult.status === 'fulfilled' && emotionResult.value.ok),
    jiwang: jiwangResult.status === 'fulfilled' ? jiwangResult.value : { ok: false, error: jiwangResult.reason?.message },
    emotion: emotionResult.status === 'fulfilled' ? emotionResult.value : { ok: false, error: emotionResult.reason?.message },
    sharedFullError
  };
}

// ────── bidding-board-worker-b/index.js ──────
// index.js — bidding-board-worker-b 入口

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925-seal';
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 't0926';
  if (mins >= 15 * 60) return 'close';
  return null;
}

function cronToPoint(cronExpr) {
  if (CRON_TO_POINT[cronExpr]) return CRON_TO_POINT[cronExpr];
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  const MIN_HOUR_TO_POINT = {
    '25 1': 't0925-seal', '26 1': 't0926', '40 1': 't0926', '0 8': 'close',
  };
  return MIN_HOUR_TO_POINT[key] || null;
}

const REFRESH_RATE_LIMIT = new Map();
function checkRefreshRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;
  const record = REFRESH_RATE_LIMIT.get(ip);
  if (!record || now > record.resetAt) {
    REFRESH_RATE_LIMIT.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (record.count >= maxRequests) {
    return { ok: false, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }
  record.count++;
  return { ok: true };
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[bidding-B] 无法识别 cron 表达式:', event.cron);
      return;
    }
    if (point === 't0925-seal') ctx.waitUntil(runSeal(env, 'cron'));
    else if (point === 't0926') ctx.waitUntil(runEmotion(env, 'cron'));
    else if (point === 'close') ctx.waitUntil(runClose(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-b', worker: 'B' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'jiwang') point = 'close';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      const validPoints = ['t0925-seal', 't0926', 'close'];
      if (!validPoints.includes(point)) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0925-seal|t0926|close|jiwang|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0925-seal') result = await runSeal(env, 'http');
      else if (point === 't0926') result = await runEmotion(env, 'http');
      else if (point === 'close') result = await runClose(env, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/refresh-emotion') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = checkRefreshRateLimit(clientIp);
      if (!limit.ok) {
        return new Response(JSON.stringify({ ok: false, error: '刷新太频繁，请 ' + limit.retryAfter + ' 秒后再试' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(limit.retryAfter) }
        });
      }
      const result = await refreshEmotionPredictVol(env, 'http');
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('bidding-board-worker-b', { status: 200 });
  },
};
