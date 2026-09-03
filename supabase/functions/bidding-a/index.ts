// ============================================================================
// bidding-a — Supabase Edge Function (Deno)
// 由 Cloudflare Worker A 整体移植而来（逻辑 1:1）。
//
// 与原 Worker 的区别：
//   1) 去掉「写入非 null 行 + 45 秒仅重试一次」的结构，改为【幂等补全】：
//      - 每趟只读 DB 中该快照列仍为 null 的行，算出非空才回填；已非 null 不覆盖。
//      - 9:25 这一趟由 pg_cron「每 5 秒」job 持续触发（9:25→9:30），天然实现
//        "每隔 5 秒检测一次，null 就再试，直到有数据 / 到 9:30"。

//   2) 入参不再依赖 Cloudflare 注入的 env/ctx，改为 Deno.env.get 读取密钥。
//
// 部署（二选一）：
//   A. Dashboard：Functions → 新建 bidding-a → 粘贴本文件全部内容。
//   B. CLI：supabase functions deploy bidding-a  （本文件位置即 supabase/functions/bidding-a/index.ts）
// 部署后务必在函数设置里【关闭 Verify JWT】（函数自身用 FETCH_TOKEN 鉴权）；
// 并在 Secrets 里设置：FUYAO_API_KEY、FETCH_TOKEN（SUPABASE_URL / SUPABASE_ANON_KEY 由平台自动注入）。
// ============================================================================

// ----------------------------- 配置 -----------------------------
const CONFIG = {
  SUPABASE_URL: (Deno.env.get('SUPABASE_URL') || 'https://tonqfgeyxnnwicjopshn.supabase.co').replace(/\/$/, ''),

  ROW_LADDER: '最近多板%',
  ROW_SECTOR_ETF: '板块ETF(48)',
  ROW_TOP10: '昨日资金前十',
  ROW_BIG_ETF: '大盘ETF',
  ROW_MAIN_INDEX: '大盘（%）',
  ROW_SEAL: '封单家数',

  LADDER_INDEX: '883410.TI',
  TOP10_INDEX: '883901.TI',
  MAIN_INDEX: '000001.SH',
  BIG_ETFS: ['510500.SH', '512100.SH', '510300.SH', '510050.SH'],

  SECTOR_ETFS: [
    { code: '560780.SH', name: '半导体设备ETF', type: 'stock' },
    { code: '159995.SZ', name: '芯片ETF华夏', type: 'stock' },
    { code: '512480.SH', name: '半导体ETF国', type: 'stock' },
    { code: '159732.SZ', name: '消费电子ETF', type: 'stock' },
    { code: '515880.SH', name: '通信ETF国泰', type: 'stock' },
    { code: '560800.SH', name: '数字经济ETF', type: 'stock' },
    { code: '159819.SZ', name: '人工智能ETF', type: 'stock' },
    { code: '159206.SZ', name: '卫星ETF永赢', type: 'stock' },
    { code: '515750.SH', name: '科技50ETF', type: 'stock' },
    { code: '159608.SZ', name: '稀有金属ETF', type: 'stock' },
    { code: '159998.SZ', name: '计算机ETF天弘', type: 'stock' },
    { code: '561160.SH', name: '电池ETF富国', type: 'stock' },
    { code: '159857.SZ', name: '光伏ETF天弘', type: 'stock' },
    { code: '516780.SH', name: '稀土ETF华泰', type: 'stock' },
    { code: '562500.SH', name: '机器人ETF华夏', type: 'stock' },
    { code: '515400.SH', name: '大数据ETF富国', type: 'stock' },
    { code: '560860.SH', name: '工业有色ETF', type: 'stock' },
    { code: '516510.SH', name: '云计算ETF易', type: 'stock' },
    { code: '516390.SH', name: '新能源车ETF', type: 'stock' },
    { code: '563010.SH', name: '电信ETF易方达', type: 'stock' },
    { code: '159875.SZ', name: '新能源ETF嘉实', type: 'stock' },
    { code: '516100.SH', name: '金融科技ETF', type: 'stock' },
    { code: '886078.TI', name: '商业航天', type: 'index' },
    { code: '512660.SH', name: '军工ETF国泰', type: 'stock' },
    { code: '560280.SH', name: '工程机械ETF', type: 'stock' },
    { code: '515230.SH', name: '软件ETF国泰', type: 'stock' },
    { code: '159996.SZ', name: '家电ETF国泰', type: 'stock' },
    { code: '885939.TI', name: '海峡两岸', type: 'index' },
    { code: '159227.SZ', name: '航空航天ETF', type: 'stock' },
    { code: '518880.SH', name: '黄金ETF华安', type: 'stock' },
    { code: '000001.SH', name: '上证指数', type: 'index' },
    { code: '159869.SZ', name: '游戏ETF华夏', type: 'stock' },
    { code: '515150.SH', name: '一带一路ETF', type: 'stock' },
    { code: '516620.SH', name: '影视ETF国泰', type: 'stock' },
    { code: '515120.SH', name: '创新药ETF广发', type: 'stock' },
    { code: '516910.SH', name: '物流ETF富国', type: 'stock' },
    { code: '159842.SZ', name: '券商ETF银华', type: 'stock' },
    { code: '159666.SZ', name: '交通运输ETF', type: 'stock' },
    { code: '512200.SH', name: '房地产ETF南方', type: 'stock' },
    { code: '159766.SZ', name: '旅游ETF富国', type: 'stock' },
    { code: '562600.SH', name: '医疗器械ETF', type: 'stock' },
    { code: '159611.SH', name: '电力ETF广发', type: 'stock' },
    { code: '167301.SZ', name: '保险主题LOF', type: 'stock' },
    { code: '159825.SZ', name: '农业ETF富国', type: 'stock' },
    { code: '159309.SZ', name: '油气ETF汇添富', type: 'stock' },
    { code: '512690.SH', name: '酒ETF鹏华', type: 'stock' },
    { code: '515220.SH', name: '煤炭ETF国泰', type: 'stock' },
    { code: '159887.SZ', name: '银行ETF富国', type: 'stock' },
  ],
};

const POINT_TO_COLUMN = { t0915: 'time915', t0920: 'time920', t0925: 'time925', t0926: 'time925', close: 'close' };

// --------------------------- 日期 / 节假日 ---------------------------
function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function beijingToday() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}
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
function localIsTradingDay(dateStr) {
  if (isWeekend(dateStr)) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

// ----------------------------- 同花顺(fuyao)接口 -----------------------------
async function fuyaoGet(path, params) {
  const url = new URL('https://fuyao.aicubes.cn' + path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  }
  const resp = await fetch(url.toString(), { headers: { 'X-api-key': Deno.env.get('FUYAO_API_KEY') || '' } });
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

async function getConstituentThscodes(indexThscode) {
  const data = await fuyaoGet('/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return ((data && data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
}

async function getStockSnapshotPcts(thscodes) {
  const result = {};
  for (let i = 0; i < thscodes.length; i += 40) {
    const chunk = thscodes.slice(i, i + 40);
    const data = await fuyaoGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((data && data.item) || []).forEach(function (it) {
      if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        result[it.thscode] = Number(it.price_change_ratio_pct);
      }
    });
  }
  return result;
}

// [FIX 2026-08-15] 一字板判定：9:25 竞价/开盘涨幅达到涨停（主板 10%、创业板/科创板 20%）。
// thscode 形如 '300xxx.SZ'/'688xxx.SH' → 20% 涨停；其余 10%。阈值略低于理论值容错（9.9/19.9）。
function isLimitUpBoard(thscode, pct) {
  if (!thscode || pct === null || pct === undefined || isNaN(pct)) return false;
  const code = String(thscode).split('.')[0];
  const isChiNext = /^30\d{4}$/.test(code); // 创业板 300xxx
  const isSTAR = /^688\d{4}$/.test(code);   // 科创板 688xxx
  return isChiNext || isSTAR ? pct >= 19.9 : pct >= 9.9;
}

async function getIndexSnapshotPcts(thscodes) {
  const result = {};
  const data = await fuyaoGet('/api/a-share-index/prices/snapshot', { thscodes: thscodes.join(',') });
  ((data && data.item) || []).forEach(function (it) {
    if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
      result[it.thscode] = Number(it.price_change_ratio_pct);
    }
  });
  return result;
}

// ----------------------------- 腾讯行情接口 -----------------------------
async function _tencentFetchOnce(thscodes) {
  const tqCodes = thscodes.map(function (c) {
    const num = c.split('.')[0];
    return (c.slice(-2) === 'SZ' ? 'sz' : 'sh') + num;
  });
  const resp = await fetch('https://qt.gtimg.cn/q=' + tqCodes.join(','));
  const text = await resp.text();
  const result = {};
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fields = m[2].split('~');
    const pct = parseFloat(fields[32]);
    if (!isNaN(pct)) {
      const num = m[1].slice(2);
      result[num + (m[1].slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
    }
  }
  return result;
}

async function getTencentSnapshotPcts(thscodes) {
  const result = await _tencentFetchOnce(thscodes);
  const missing = thscodes.filter(function (c) { return result[c] === undefined; });
  if (missing.length > 0) {
    try {
      const retry = await _tencentFetchOnce(missing);
      Object.assign(result, retry);
    } catch (e) {
      console.warn('腾讯行情缺失补单失败（保留原结果）:', e.message);
    }
  }
  return result;
}

// ----------------------------- Supabase 读写 -----------------------------
function sbHeaders() {
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  return {
    'apikey': anon,
    'Authorization': 'Bearer ' + anon,
    'Content-Type': 'application/json',
  };
}

async function readTodayBiddingRows(date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,time915,time920,time925,close';
  const resp = await fetch(url, { headers: sbHeaders() });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  return await resp.json();
}

async function upsertBiddingRows(rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(), { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert bidding_data 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
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

// 数据已全部填充时，停止 5 秒轮询 job（避免反复打第三方接口被封号）。
// 通过 DB 里的 RPC（public.stop_bidding_t0925_fill，security definer）调用 cron.unschedule。
async function stopT0925Fill() {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/rpc/stop_bidding_t0925_fill', {
      method: 'POST',
      headers: Object.assign(sbHeaders(), { 'Content-Type': 'application/json' }),
      body: '{}',
    });
  } catch (e) { console.warn('停止 bidding-t0925-fill 失败（已忽略，早退已避免接口调用）:', e.message); }
}

// 竞价变化看板的 6 个固定行是否都已写入 time925（非 null；封单家数允许 '0'，是有效值）
function allRowsFilled(existingByName) {
  const REQUIRED = [CONFIG.ROW_LADDER, CONFIG.ROW_SECTOR_ETF, CONFIG.ROW_TOP10, CONFIG.ROW_BIG_ETF, CONFIG.ROW_MAIN_INDEX, CONFIG.ROW_SEAL];
  return REQUIRED.every(function (name) {
    const r = existingByName[name];
    return !!(r && r.time925 !== undefined && r.time925 !== null && String(r.time925).trim() !== '');
  });
}

// ----------------------------- 竞价计算 -----------------------------
function avgOf(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce(function (a, b) { return a + b; }, 0) / numbers.length;
}
function fmtPct(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function computeBiddingRows(point) {
  const rows = {};

  // [FIX 2026-08-15] 最近多板（883410）成分股快照：供「最近多板%」平均涨幅与「封单家数」一字板统计共用，
  // 避免重复请求同花顺接口（9:25 封单家数 = 最近多板成分股中竞价/开盘一字涨停的家数，用户指定口径）。
  let ladderCodes = [];
  let ladderPcts = {};
  try {
    ladderCodes = await getConstituentThscodes(CONFIG.LADDER_INDEX);
    if (ladderCodes.length > 0) ladderPcts = await getStockSnapshotPcts(ladderCodes);
  } catch (e) { /* 交由各行的错误处理兜底 */ }

  try {
    if (ladderCodes.length === 0) rows[CONFIG.ROW_LADDER] = { value: null, error: '883410 成分股为空' };
    else {
      const vals = ladderCodes.map(c => ladderPcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
      const avg = avgOf(vals);
      rows[CONFIG.ROW_LADDER] = avg === null
        ? { value: null, error: '成分股快照全部缺失(' + ladderCodes.length + '只)' }
        : { value: fmtPct(avg), missing: ladderCodes.length - vals.length > 0 ? [String(ladderCodes.length - vals.length) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_LADDER] = { value: null, error: e.message }; }

  // [FIX 2026-08-15] 封单家数：9:25 最近多板成分股中一字板（竞价/开盘涨停）家数。
  // 替代原 NumCat owfd_0925_count（不稳定：emoindic 日级指标 9:25 常无当天数据 → 空白）。
  try {
    if (ladderCodes.length === 0) {
      rows[CONFIG.ROW_SEAL] = { value: null, error: '883410 成分股为空' };
    } else {
      let limitUpCount = 0, haveCount = 0;
      ladderCodes.forEach(c => {
        const pct = ladderPcts[c];
        if (typeof pct === 'number' && !isNaN(pct)) {
          haveCount++;
          if (isLimitUpBoard(c, pct)) limitUpCount++;
        }
      });
      rows[CONFIG.ROW_SEAL] = haveCount === 0
        ? { value: null, error: '成分股快照全部缺失(' + ladderCodes.length + '只)' }
        : { value: String(limitUpCount), missing: ladderCodes.length - haveCount > 0 ? [String(ladderCodes.length - haveCount) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_SEAL] = { value: null, error: e.message }; }

  try {
    const stockCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'stock').map(e => e.code);
    const indexCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'index').map(e => e.code);
    const stockPcts = await getTencentSnapshotPcts(stockCodes);
    const indexPcts = await getIndexSnapshotPcts(indexCodes);
    let red = 0;
    const missing = [];
    CONFIG.SECTOR_ETFS.forEach(e => {
      const pct = e.type === 'stock' ? stockPcts[e.code] : indexPcts[e.code];
      if (typeof pct === 'number' && !isNaN(pct)) { if (pct > 0) red++; }
      else missing.push(e.name);
    });
    rows[CONFIG.ROW_SECTOR_ETF] = { value: String(red), missing: missing.length ? missing : undefined };
  } catch (e) { rows[CONFIG.ROW_SECTOR_ETF] = { value: '0', error: e.message }; }

  try {
    const codes = await getConstituentThscodes(CONFIG.TOP10_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_TOP10] = { value: '0', error: '883901 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(codes);
      let red = 0, have = 0;
      codes.forEach(c => { const v = pcts[c]; if (typeof v === 'number' && !isNaN(v)) { have++; if (v > 0) red++; } });
      rows[CONFIG.ROW_TOP10] = have === 0
        ? { value: '0', error: '883901 成分股快照全部缺失(' + codes.length + '只)' }
        : { value: String(red), missing: codes.length - have > 0 ? [String(codes.length - have) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_TOP10] = { value: '0', error: e.message }; }

  try {
    const pcts = await getTencentSnapshotPcts(CONFIG.BIG_ETFS);
    const vals = CONFIG.BIG_ETFS.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
    const avg = avgOf(vals);
    rows[CONFIG.ROW_BIG_ETF] = avg === null
      ? { value: '0.00', error: '大盘ETF快照全部缺失' }
      : { value: fmtPct(avg), missing: CONFIG.BIG_ETFS.length - vals.length > 0 ? [String(CONFIG.BIG_ETFS.length - vals.length) + '只无快照'] : undefined };
  } catch (e) { rows[CONFIG.ROW_BIG_ETF] = { value: '0.00', error: e.message }; }

  try {
    const pcts = await getIndexSnapshotPcts([CONFIG.MAIN_INDEX]);
    const v = pcts[CONFIG.MAIN_INDEX];
    rows[CONFIG.ROW_MAIN_INDEX] = (typeof v === 'number' && !isNaN(v)) ? { value: fmtPct(v) } : { value: '0.00', error: '上证指数快照缺失' };
  } catch (e) { rows[CONFIG.ROW_MAIN_INDEX] = { value: '0.00', error: e.message }; }

  return rows;
}

// ----------------------------- 主流程（幂等补全） -----------------------------
function buildUpsertPayload(computed, existingByName, column, point, date, now) {
  const payload = [];
  const results = {};
  Object.keys(computed).forEach(rowName => {
    const r = computed[rowName];
    results[rowName] = r;
    if (r.value === null || r.value === undefined) return; // 没抓到，跳过（等下一趟 5 秒重试）
    const prev = existingByName[rowName];
    const dbColVal = prev ? prev[column] : undefined;
    // 幂等：该快照列已有值则不覆盖（保留首次写入，避免重复/回退写入）
    if (dbColVal !== undefined && dbColVal !== null && String(dbColVal).trim() !== '') return;
    const row = { date: date, name: rowName, updated_at: now };
    row[column] = r.value;
    if (point === 't0925') {
      const v920 = prev ? parseFloat(prev.time920) : NaN;
      const v925 = parseFloat(r.value);
      if (!isNaN(v920) && !isNaN(v925)) row.change = v925 > v920 ? '增' : (v925 < v920 ? '减' : '平');

    }
    payload.push(row);
  });
  return { payload, results };
}

async function runBidding(point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'http', job: 'bidding', worker: 'A' };
  if (!column) return { ok: false, error: '未知 time_point: ' + point };

  if (!(await isTradingDay())) {
    await writeLog(Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  // 每次都读今日已存行 → 幂等补全（只写 DB 为 null 且本次非空 的行）
  let existingByName = {};
  try {
    (await readTodayBiddingRows(date)).forEach(r => { existingByName[(r.name || '').trim()] = r; });
  } catch (e) { console.error('读今日行失败:', e.message); }

  // t0925 轮询：若 5 行已全部填充，立即停止 5 秒 job 并早退（不打第三方接口，防封号）
  if (point === 't0925' && allRowsFilled(existingByName)) {
    await stopT0925Fill();
    await writeLog(Object.assign(logBase, { ok: true, detail: { skipped: '已全部填充，停止轮询' } }));
    return { ok: true, date, point, skipped: true };
  }

  const computed = await computeBiddingRows(point);
  const now = new Date().toISOString();
  const { payload, results } = buildUpsertPayload(computed, existingByName, column, point, date, now);
  let ok = true, writeError = null;
  if (payload.length > 0) {
    try { await upsertBiddingRows(payload); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(Object.assign(logBase, { ok, detail: { written: payload, rows: results, writeError } }));
  return { ok, date, point, column, written: payload, rows: results, writeError };
}

async function runDuobanSecond(source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'http', job: 'duoban-second', worker: 'A' };

  if (!(await isTradingDay())) {
    await writeLog(Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  const computed = await computeBiddingRows('t0926');
  const duobanResult = computed[CONFIG.ROW_LADDER] || { value: null, error: '未计算' };

  let existingByName = {};
  try {
    const rows = await readTodayBiddingRows(date);
    rows.forEach(r => { existingByName[(r.name || '').trim()] = r; });
  } catch (e) { console.error('读今日行失败:', e.message); }

  const now = new Date().toISOString();
  const upsertPayload = [];

  // 最近多板%time26 行：写 9:26 抓取值，change 与"最近多板%"行 time925 比较
  if (duobanResult.value !== null && duobanResult.value !== undefined) {
    const time26Row = { date: date, name: '最近多板%time26', time925: duobanResult.value, updated_at: now };
    const duibanExisting = existingByName[CONFIG.ROW_LADDER];
    if (duibanExisting && duibanExisting.time925 !== undefined && duibanExisting.time925 !== null && String(duibanExisting.time925).trim() !== '') {
      const v925 = parseFloat(duibanExisting.time925);
      const v926 = parseFloat(duobanResult.value);
      if (!isNaN(v925) && !isNaN(v926)) time26Row.change = v926 > v925 ? '增' : (v926 < v925 ? '减' : '平');
    }
    upsertPayload.push(time26Row);
  }

  // 其它4行：只写非 null 值到 time925 列（补写 9:25 缺失的数据）
  const otherRows = [CONFIG.ROW_SECTOR_ETF, CONFIG.ROW_TOP10, CONFIG.ROW_BIG_ETF, CONFIG.ROW_MAIN_INDEX];
  otherRows.forEach(rowName => {
    const r = computed[rowName];
    if (!r || r.value === null || r.value === undefined) return;
    const otherRow = { date: date, name: rowName, time925: r.value, updated_at: now };
    const prev = existingByName[rowName];
    if (prev && prev.time920 !== undefined && prev.time920 !== null && String(prev.time920).trim() !== '') {
      const v926 = parseFloat(r.value);
      const v920 = parseFloat(prev.time920);
      if (!isNaN(v926) && !isNaN(v920)) otherRow.change = v926 > v920 ? '增' : (v926 < v920 ? '减' : '平');
    }
    upsertPayload.push(otherRow);
  });

  let ok = true, writeError = null;
  if (upsertPayload.length > 0) {
    try { await upsertBiddingRows(upsertPayload); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(Object.assign(logBase, { ok, detail: { written: upsertPayload, row: duobanResult, writeError } }));
  return { ok, date, point: 't0926', written: upsertPayload, row: duobanResult, writeError };
}

// ----------------------------- 收盘涨幅覆盖（合并自 auction-close-fetch） -----------------------------
// [FIX 2026-08-17] 收盘（16:00）自动抓取当天「最近多板」成分股涨幅并覆盖 market_metrics.change_pct。
// 原为独立 Edge Function auction-close-fetch，用户要求合并进 bidding-a（不新建函数/不重复设 Secrets）。
// 由 pg_cron 北京时间 16:00 触发 point=auction-close；逻辑与原 close-workflow.js 1:1：
//   读当日 auction_watchlist → fuyao snapshot 批量拉收盘涨幅 → 只覆盖 market_metrics change_pct。
// 注意：与 point=close（竞价变化看板 bidding_data 收盘）是两回事，路由独立。

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
  const batchSize = 40;
  for (let i = 0; i < codes.length; i += batchSize) {
    const chunk = codes.slice(i, i + batchSize);
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

async function readAuctionWatchlist(date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + encodeURIComponent(date) +
    '&select=stock,code&limit=1000';
  const resp = await fetch(url, { headers: sbHeaders() });
  if (!resp.ok) throw new Error('读取 auction_watchlist 失败: HTTP ' + resp.status);
  const rows = await resp.json();
  // [OBS-FIX 2026-09-03] 观察组行可能 code 为空（本地 stockcodemap 未覆盖该名），收盘快照需按 code 调 fuyao，
  // 故从 stockcodemap 补全缺码行，确保观察组也能被收盘涨幅覆盖（与常规组一致）。
  const missingCode = (rows || []).filter(function(r) { return r && r.stock && (!r.code || String(r.code).trim() === ''); });
  if (missingCode.length > 0) {
    try {
      const names = missingCode.map(function(r) { return r.stock.trim(); });
      const mapUrl = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?stock=in.(' +
        encodeURIComponent(JSON.stringify(names)) + ')&select=stock,code';
      const mapResp = await fetch(mapUrl, { headers: sbHeaders() });
      if (mapResp.ok) {
        const mapRows = await mapResp.json();
        const codeByStock = {};
        (mapRows || []).forEach(function(m) { if (m && m.stock && m.code) codeByStock[String(m.stock).trim()] = String(m.code).trim(); });
        rows.forEach(function(r) {
          if (r && r.stock && (!r.code || String(r.code).trim() === '') && codeByStock[String(r.stock).trim()]) {
            r.code = codeByStock[String(r.stock).trim()];
          }
        });
      }
    } catch (e) { console.warn('stockcodemap 补码失败（保留空码）:', e.message); }
  }
  return rows;
}

async function upsertMarketMetricsRows(rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date%2Cstock%2Cscope';
  // 优先 service role（写权限最稳），回退 anon（与 bidding-a 现有写 bidding_data 同路径）
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert market_metrics 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
  }
}

async function runAuctionCloseFetch(source) {
  const logs = [];
  const today = beijingToday();
  const logBase = { run_date: today, time_point: 'auction-close', source: source || 'cron', job: 'auction-close-fetch', worker: 'edge' };
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
    watchlist = await readAuctionWatchlist(today);
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
  const COVERAGE_THRESHOLD = 0.5;
  const RETRY_DELAYS_SEC = [60, 120];
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

  for (let attempt = 0; attempt < RETRY_DELAYS_SEC.length && coverage < COVERAGE_THRESHOLD; attempt++) {
    const waitSec = RETRY_DELAYS_SEC[attempt];
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
    updated_by: 'bidding-a-auction-close',
  }));

  let writeError = null;
  try {
    await upsertMarketMetricsRows(metricsRows);
    logs.push('market_metrics 写入 ' + metricsRows.length + ' 行 change_pct');
  } catch (e) {
    writeError = e.message;
    logs.push('写入 market_metrics 失败: ' + e.message);
    await writeLog(Object.assign(logBase, { ok: false, detail: { error: writeError } }));
    return { ok: false, today, error: '写入 market_metrics 失败: ' + writeError, logs };
  }

  const uncoveredCount = watchlist.length - metricsRows.length;
  if (coverage < COVERAGE_THRESHOLD) logs.push('⚠️ 覆盖率低 ' + (coverage * 100).toFixed(1) + '%');
  if (uncoveredCount > 0) logs.push('未覆盖 ' + uncoveredCount + ' 只（可能停牌/接口未返回）');
  const completenessSummary = uncoveredCount === 0 ? '✅ 涨幅覆盖完整 ' + metricsRows.length + '/' + watchlist.length
    : '⚠️ 覆盖 ' + metricsRows.length + '/' + watchlist.length + '（未覆盖 ' + uncoveredCount + ' 只）';
  logs.push('数据完整性汇总: ' + completenessSummary);

  await writeLog(Object.assign(logBase, { ok: true, detail: { pctUpdated: metricsRows.length, coverage, stats, completenessSummary } }));
  logs.push('完成: 收盘涨幅覆盖 ' + metricsRows.length + ' 只');
  return { ok: true, today, stocksCount: watchlist.length, pctUpdated: metricsRows.length, coverage, snapshotStats: stats, completenessSummary, logs };
}

// ----------------------------- 入口路由 -----------------------------
function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return 't0915';
  if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return 't0920';
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925';
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 't0926';
  if (mins >= 15 * 60) return 'close';
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  // [FIX 2026-08-17] Supabase Edge Function 的 pathname 带前缀 /functions/v1/bidding-a，
  // 用 endsWith 兼容（本地 Deno 直接跑则是 /health、/fetch、/），否则路由分支永远命不中。
  if (p.endsWith('/health')) {
    return new Response(JSON.stringify({ ok: true, service: 'bidding-a', worker: 'A' }), { headers: { 'Content-Type': 'application/json' } });
  }

  // 处理函数入口：/fetch 或根路径都接受（兼容有无前缀）
  const isFetch = p === '/' || p === '' || p.endsWith('/fetch') || p.endsWith('/bidding-a') || p.endsWith('/bidding-a/');
  if (isFetch) {
    const token = url.searchParams.get('token') || '';
    const expected = Deno.env.get('FETCH_TOKEN');
    if (!expected || token !== expected) {
      return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    let point = url.searchParams.get('point') || 'auto';
    if (point === 'auto') {
      point = autoPoint();
      if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
    }
    // [FIX 2026-08-17] 收盘涨幅覆盖（market_metrics）路由：与竞价看板 close（bidding_data）独立。
    if (point === 'auction-close') {
      const result = await runAuctionCloseFetch('http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!POINT_TO_COLUMN[point]) {
      return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|auction-close|auto' }), { headers: { 'Content-Type': 'application/json' } });
    }
    let result;
    if (point === 't0926') result = await runDuobanSecond('http');
    else result = await runBidding(point, 'http');
    return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('bidding-a', { status: 200 });
});
