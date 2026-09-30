// ===== bidding-board-worker-b — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-09-30 03:09:28
// 注意: 此文件自动生成，请勿手动编辑
//
// ⚠️ 部署自检（粘贴前务必做完这三步）:
//   1) 编辑器【先全选 (Ctrl+A) 再删除】清空后，再粘贴本文件 ——
//      若把本文件粘在旧代码下面，会报 Identifier 'beijingNow' has already been declared
//      （实测行号 = 旧文件行数 + 8）。
//   2) 粘贴后核对编辑器总行数 = 1040（少了=没粘全，约翻倍=粘重了）。
//   3) Ctrl+F 搜「function beijingNow」→ 正常命中 2 处（本行说明 1 处 + 真函数定义 1 处）；>2 处 = 粘重。

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
  '2026-05-05', '2026-06-19',
  // [FIX 2026-09-29] 2026 年这一段原来有两个错，都会直接毁掉一整个交易日：
  //   ① 漏了中秋 '2026-09-25'（2026 年中秋是 9/25 周五，9/26~27 周末，9/28 周一开市）
  //      ⇒ Worker 把休市日当交易日跑整轮：写一份当天的 auction_watchlist 脏名单，
  //        并且（若 fuyao 日历不可用）把 9/25 算进「最近交易日」窗口，
  //        导致 9/28 的 prevDay 错位成 9/25（与前端按 localStorage 算出的 9/24 不一致）。
  //   ② 多了 '2026-10-08'（疑似从 2025 年那段复制后没清理 —— 2025 年国庆中秋连休 8 天、
  //      10/09 才开市，所以 2025 段里的 '2025-10-08' 是对的；而 2026 年中秋在 9/25 不和
  //      国庆连休，国庆只放 10/01~10/07，10/08 就该开市）
  //      ⇒ 开市日被判「非交易日」→ 早盘与收盘两轮【整轮 skip】，当天四个趋势图与十日涨幅全空。
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-03',
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
]);

function localIsTradingDay(dateStr) {
  if (isWeekend(dateStr)) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

// ────── _shared-source/trading-day.js ──────
// trading-day.js — 交易日判定的【唯一实现】：三源合并（源文件，各 Worker 复制使用）
//
// ============================================================================
// 为什么需要它（2026-09-29 事故）
// ----------------------------------------------------------------------------
// 原来 worker 判「今天是交易日吗」各写各的，且都以 _shared-source/holidays.js 的
// **硬编码表**为准：
//   · bidding-auto-fetch#checkTradingDay → localIsTradingDay（纯本地表，连 fuyao 都不看）
//   · worker-a / worker-b 的 isTradingDay → fuyao 优先，但**失败即回退本地表**
//
// 而「用户在顶栏日期栏手动标的假期」只存在浏览器 localStorage 里，worker 读不到。
// 后果（两个方向都会翻车）：
//   ① 硬编码表【漏】了 2026-09-25（中秋）→ worker 把休市日当交易日跑整轮，
//      写了脏名单，还会把 9/25 算进「最近交易日」→ 下一交易日 prevDay 错位；
//   ② 硬编码表【多】了 2026-10-08 → 开市日被判「非交易日」→ 早盘 + 收盘两轮整轮 skip，
//      当天四个趋势图与十日涨幅全空。
//
// 另一个方向的坑：fuyao 交易日历**看不到未来的假期**（用户口径：最多只能判到次日），
// 所以「国庆 10/01~10/07 连休」这种必须靠人提前在前端标出来 —— 这正是本模块
// 把「用户设置」放在【最高优先级】的原因。fuyao 不能替代它，只做兜底。
// ============================================================================
//
// 【三源优先级（从高到低）——三个来源各司其职，不冲突】
//   ① 用户覆盖表 trading_day_overrides（Supabase）
//        人在前端标红 / 取消的假期。能提前表达未来的假期（fuyao 做不到），
//        也能【压过】硬编码表（取消假期靠 is_holiday=false，不是删行）。
//   ② 周末
//   ③ fuyao 交易日历 —— 仅在【它自己声明的覆盖区间 [first, last] 内】才用它下结论：
//        区间内命中 = 交易日；区间内不命中 = 假期（真实日历最权威，能覆盖调休）。
//        区间外（更早的历史 / 更晚的未来）一律不下结论，交给 ④
//        —— 因为日历可能被上游截断，「日历里没有」不能一律当成「不是交易日」。
//   ④ _shared-source/holidays.js 硬编码表兜底（已修正 2026 年 09/10 月两条错误）
//
// ⛔ 任何一层都不能「读取失败 → 当成空数据下结论」（§10 / §40）：
//    读表失败 = 该层弃权，交给下一层；绝不当成「用户没设置过」直接判假期/交易日。


/** 用户覆盖表（与 db/create_trading_day_overrides.sql 同名） */
const TRADING_DAY_OVERRIDES_TABLE = 'trading_day_overrides';

/**
 * [TIMEOUT 2026-09-30] 带超时的 fetch（本模块专用，避免与 fuyao-api.js 的同名 helper 顶层冲突）。
 * 见 fetchTradingDayOverrides 处的说明：本层在最前面被 await，绝不允许无限挂起。
 */
function fetchWithTimeoutMs(url, opts, timeoutMs) {
  const base = opts || {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, base, { signal: AbortSignal.timeout(timeoutMs) }));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, base, { signal: ctrl.signal }))
    .finally(function () { clearTimeout(timer); });
}

/** 覆盖表内存缓存有效期：一轮 worker 执行只读一次，跨请求也不会长期不刷新 */
const OVERRIDE_CACHE_TTL_MS = 60 * 1000;
let _overrideCache = null;
let _overrideCacheAt = 0;

/** 仅供测试：清空覆盖表缓存 */
function _resetTradingDayOverrideCache() {
  _overrideCache = null;
  _overrideCacheAt = 0;
}

/**
 * 读云端「交易日覆盖」表。
 * @param {string} baseUrl Supabase URL（各 worker 的 CONFIG.SUPABASE_URL）
 * @param {string} key SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
 * @returns {Promise<Map<string, boolean>|null>} Map<date, isHoliday>；
 *          **null = 读取失败**（调用方据此知道「不是用户没设置，而是读不到」，§10）
 */
async function fetchTradingDayOverrides(baseUrl, key) {
  if (!baseUrl || !key) return null;
  const now = Date.now();
  if (_overrideCache && (now - _overrideCacheAt) < OVERRIDE_CACHE_TTL_MS) return _overrideCache;
  const url = baseUrl + '/rest/v1/' + TRADING_DAY_OVERRIDES_TABLE + '?select=date,is_holiday';
  // [TIMEOUT 2026-09-30] 本模块在 9:25 早盘 P0 的【最前面】被 await（checkTradingDay），
  //   没有超时的话一次挂起就会把整轮早盘推到 9:26 之后（§35 P1）。健康时实测 <300ms。
  const resp = await fetchWithTimeoutMs(url, {
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
  }, 8000);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('读取 ' + TRADING_DAY_OVERRIDES_TABLE + ' 失败: HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const rows = await resp.json();
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (r && r.date) map.set(String(r.date), r.is_holiday === true);
  });
  _overrideCache = map;
  _overrideCacheAt = now;
  return map;
}

/**
 * 【纯函数·唯一判据】三源合并。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {Map<string, boolean>|null} overrideMap 用户覆盖（true=假期）；null/空 = 该层弃权
 * @param {Array<string>|null} fuyaoDates fuyao 日历（升序 'YYYY-MM-DD' 数组）；null/空 = 该层不可用
 * @returns {boolean} 是否交易日
 */
function mergeTradingDay(dateStr, overrideMap, fuyaoDates) {
  if (!dateStr) return false;

  // ① 用户显式设置（最高优先；这是唯一能表达「未来假期」的来源）
  if (overrideMap && typeof overrideMap.has === 'function' && overrideMap.has(dateStr)) {
    return !overrideMap.get(dateStr);
  }

  // ② 周末
  if (isWeekend(dateStr)) return false;

  // ③ fuyao 日历：只信它自己声明覆盖区间内的事
  if (fuyaoDates && fuyaoDates.length > 0) {
    const first = fuyaoDates[0];
    const last = fuyaoDates[fuyaoDates.length - 1];
    if (dateStr >= first && dateStr <= last) {
      return fuyaoDates.indexOf(dateStr) >= 0;
    }
    // 区间外（更早/更晚）→ 弃权，交给 ④（日历可能被截断，不能据「没有」判非交易日）
  }

  // ④ 硬编码表兜底
  return !KNOWN_HOLIDAYS.has(dateStr);
}

/**
 * 带日志的便捷封装：读覆盖表（失败只留痕不中断）→ 三源合并。
 *
 * @param {object} env worker env
 * @param {string} baseUrl Supabase URL
 * @param {string} key SUPABASE key
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {Array<string>|null} fuyaoDates 调用方已取到的 fuyao 日历（可为 null）
 * @param {Array<string>} [logs] 日志数组（worker 的 logs）
 * @returns {Promise<boolean>}
 */
async function resolveIsTradingDay(env, baseUrl, key, dateStr, fuyaoDates, logs) {
  const log = Array.isArray(logs) ? function (m) { logs.push(m); } : function () {};
  let overrideMap = null;
  try {
    overrideMap = await fetchTradingDayOverrides(baseUrl, key);
  } catch (e) {
    // §10：读取失败 ≠ 用户没设置。如实记录后交由下一层判断，绝不静默吞掉。
    log('⚠️ 交易日覆盖表读取失败（已回退为「无用户设置」，继续用后续判据）: ' + (e && e.message));
  }
  const hit = overrideMap && overrideMap.has(dateStr);
  const ok = mergeTradingDay(dateStr, overrideMap, fuyaoDates);
  log('交易日判定 ' + dateStr + ' → ' + (ok ? '交易日' : '非交易日') +
    '（来源=' + (hit ? '用户前端设置:' + (overrideMap.get(dateStr) ? '假期' : '显式取消假期') : 'fuyao日历/硬编码表') + '）');
  return ok;
}


// ────── bidding-board-worker-b/data/fuyao-api.js ──────
// data/fuyao-api.js — fuyao 行情接口 + 交易日历
// [TRADING-DAY 2026-09-29] 交易日判定统一走 _shared-source/trading-day.js
//   （用户在前端顶栏标的假期 > 周末 > fuyao 日历 > 硬编码表），不再各写各的。
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
  // [TRADING-DAY 2026-09-29] 原来是「fuyao 优先、失败回退硬编码表」，用户在前端标红的假期
  //   完全不在判据里 → 国庆连休这类「未来假期」判不出来。现在统一走三源合并。
  const today = beijingToday();
  let fuyaoDates = null;
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    fuyaoDates = items.map(function (it) { return normalizeDate(it.date); }).filter(Boolean).sort();
  } catch (e) {
    // §10：日历拿不到 ≠ 今天不是交易日 —— 该层弃权，继续用「用户设置 / 硬编码表」判。
    console.warn('fuyao 交易日历失败（该层弃权，改用用户设置 / 硬编码表）:', e.message);
  }
  return resolveIsTradingDay(
    env,
    CONFIG.SUPABASE_URL,
    env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    today,
    fuyaoDates,
    null
  );
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

// [FIX 2026-08-15] 获取最近多板（883410）成分股 thscode 列表
async function getLadderConstituents(env) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: '883410.TI' });
  return ((data && data.item) || []).filter(function (it) { return it && it.thscode; });
}

// [FIX 2026-08-15] 快照接口获取一批股票的 {thscode, price_change_ratio_pct}（涨停/一字板判定用）
async function getStockSnapshots(env, thscodes) {
  const result = {};
  const BATCH = 40;
  for (let i = 0; i < thscodes.length; i += BATCH) {
    const chunk = thscodes.slice(i, i + BATCH);
    const data = await fuyaoGet(env, '/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((data && data.item) || []).forEach(function (it) {
      if (it && it.thscode && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        result[it.thscode] = Number(it.price_change_ratio_pct);
      }
    });
  }
  return result;
}

// [FIX 2026-08-15] 一字板判定：竞价/开盘涨幅达到涨停（主板 10%、创业板/科创板 20%）。
// thscode 形如 '300xxx.SZ'/'688xxx.SH' → 20% 涨停；其余 10%。涨停阈值略低于理论值容错（9.9/19.9）。
function isLimitUpBoard(thscode, pct) {
  if (!thscode || pct === null || pct === undefined || isNaN(pct)) return false;
  const code = String(thscode).split('.')[0];
  const isChiNext = /^30\d{4}$/.test(code);   // 创业板 300xxx
  const isSTAR = /^688\d{4}$/.test(code);     // 科创板 688xxx
  return isChiNext || isSTAR ? pct >= 19.9 : pct >= 9.9;
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
// logic/seal-workflow.js — 封单家数（9:25 竞价一字板）
// [FIX 2026-08-15] 数据源从 NumCat 改为同花顺接口：
//   需求：9:25 用同花顺接口快照抓取「早盘竞价看板的最近多板（883410）」成分股，
//         判断哪些是一字板（竞价/开盘涨幅达到涨停），计算数量填入 bidding_data 封单家数行 time925 列。
//   原实现：NumCat emoindic-daily 的 owfd_0925_count 字段 — 不稳定（8/14 等日期接口计数类字段缺失，
//         且 emoindic 是日级指标，9:25 时往往还没有当天数据 → findTodayItem 找不到 → 空白）。
async function runSeal(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0925', source: source || 'cron', job: 'seal', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let sealResult;
  try {
    // 1. 取 883410 最近多板成分股
    const constituents = await getLadderConstituents(env);
    if (!constituents || constituents.length === 0) {
      sealResult = { value: null, error: '883410 最近多板成分股为空' };
    } else {
      // 2. 快照抓取涨幅
      const thscodes = constituents.map(c => c.thscode).filter(Boolean);
      const pcts = await getStockSnapshots(env, thscodes);
      // 3. 统计一字板家数（竞价/开盘涨幅 ≥ 涨停阈值）
      let limitUpCount = 0;
      const limitUpNames = [];
      let haveCount = 0;
      constituents.forEach(function (c) {
        const pct = pcts[c.thscode];
        if (typeof pct === 'number' && !isNaN(pct)) {
          haveCount++;
          if (isLimitUpBoard(c.thscode, pct)) {
            limitUpCount++;
            limitUpNames.push((c.name || c.thscode));
          }
        }
      });
      sealResult = {
        value: String(limitUpCount),
        detail: {
          constituents: constituents.length,
          haveSnapshot: haveCount,
          limitUp: limitUpCount,
          names: limitUpNames.slice(0, 50),
          threshold: '主板10%/创业板科创板20%'
        }
      };
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

  // [FIX 2026-08-15] 数据完整性校验：numcat 情绪接口有时对"昨日"只返回金额类字段
  // （am/am_diff/am_pred 有值），但计数类字段（涨停/跌停/一字板/最高连板/炸板）全部为 0/null
  // （8/14 抓取时 8/13 的数据即如此：amountDiff 正常、limitUp/limitDown/onceLimit/highestLb/zhaban 全 0）。
  // 这种"金额正常但计数全缺"是接口数据不完整，不是真实市场状态（涨停家数不可能 0 而成交额正常）。
  // 处理：把这些计数指标置 null（前端显示「待更新」而不是误导性的 0），并在日志中标记，等待下次重试补全。
  const _countKeys = ['limitUp', 'limitDown', 'onceLimit', 'highestLb', 'zhaban'];
  const _hasAmount = metrics.amount !== null && metrics.amount !== undefined && metrics.amount !== 0;
  const _countsAllMissing = _countKeys.every(function(k) {
    const v = metrics[k];
    return v === null || v === undefined || Number(v) === 0;
  });
  if (_hasAmount && _countsAllMissing) {
    const _savedCounts = {};
    _countKeys.forEach(function(k) { _savedCounts[k] = metrics[k]; metrics[k] = null; });
    // [FIX 2026-08-15] 原 logs.push 引用了不存在的 logs 变量 → ReferenceError 导致整个情绪写入崩溃；
    // 改用 console.warn（worker 环境日志可见），不影响数据落库流程。
    console.warn('⚠️ 数据完整性校验：昨日金额=' + metrics.amount + ' 正常，但计数类字段全缺（涨停/跌停/一字板/最高连板/炸板 原值 ' +
      JSON.stringify(_savedCounts) + '），判定为接口数据不完整，计数置 null 等待补全（§11 不把缺失伪装成 0）');
    missingFields.push('counts-all-missing(接口数据不完整)');
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
    // [FIX 2026-08-15] 与 metrics 同口径：金额正常但计数全缺的天（接口数据不完整），计数置 null，
    // 避免趋势图显示误导性的 0（8/14 抓取时 8/13 一行即如此）。
    const _rowHasAmount = row.amount !== null && row.amount !== undefined && row.amount !== 0;
    const _rowCountsAllMissing = _countKeys.every(function(k) {
      const v = row[k];
      return v === null || v === undefined || Number(v) === 0;
    });
    if (_rowHasAmount && _rowCountsAllMissing) {
      _countKeys.forEach(function(k) { row[k] = null; });
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
