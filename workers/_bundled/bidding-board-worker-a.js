// ===== bidding-board-worker-a — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-09-29 10:03:15
// 注意: 此文件自动生成，请勿手动编辑
//
// ⚠️ 部署自检（粘贴前务必做完这三步）:
//   1) 编辑器【先全选 (Ctrl+A) 再删除】清空后，再粘贴本文件 ——
//      若把本文件粘在旧代码下面，会报 Identifier 'beijingNow' has already been declared
//      （实测行号 = 旧文件行数 + 8）。
//   2) 粘贴后核对编辑器总行数 = 730（少了=没粘全，约翻倍=粘重了）。
//   3) Ctrl+F 搜「function beijingNow」→ 正常命中 2 处（本行说明 1 处 + 真函数定义 1 处）；>2 处 = 粘重。

// ────── bidding-board-worker-a/config.js ──────
// config.js — bidding-board-worker-a 配置
const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  ROW_LADDER: '最近多板%',
  ROW_SECTOR_ETF: '板块ETF(48)',
  ROW_TOP10: '昨日资金前十',
  ROW_BIG_ETF: '大盘ETF',
  ROW_MAIN_INDEX: '大盘（%）',

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

const CRON_TO_POINT = {
  '15 1 * * 2-6': 't0915',
  '20 1 * * 2-6': 't0920',
  '25 1 * * 2-6': 't0925',
  '26 1 * * 2-6': 't0926',
  '0 8 * * 2-6': 'close',
  '15 1 * * 1-5': 't0915',
  '20 1 * * 1-5': 't0920',
  '25 1 * * 1-5': 't0925',
  '26 1 * * 1-5': 't0926',
  '0 8 * * 1-5': 'close',
};

const POINT_TO_COLUMN = { t0915: 'time915', t0920: 'time920', t0925: 'time925', t0926: 'time925', close: 'close' };

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
  const resp = await fetch(url, {
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
  });
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


// ────── bidding-board-worker-a/data/fuyao-api.js ──────
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

async function getConstituentThscodes(env, indexThscode) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return ((data && data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
}

async function getStockSnapshotPcts(env, thscodes) {
  const result = {};
  for (let i = 0; i < thscodes.length; i += 40) {
    const chunk = thscodes.slice(i, i + 40);
    const data = await fuyaoGet(env, '/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((data && data.item) || []).forEach(function (it) {
      if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        result[it.thscode] = Number(it.price_change_ratio_pct);
      }
    });
  }
  return result;
}

async function getIndexSnapshotPcts(env, thscodes) {
  const result = {};
  const data = await fuyaoGet(env, '/api/a-share-index/prices/snapshot', { thscodes: thscodes.join(',') });
  ((data && data.item) || []).forEach(function (it) {
    if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
      result[it.thscode] = Number(it.price_change_ratio_pct);
    }
  });
  return result;
}

// ────── bidding-board-worker-a/data/supabase-write.js ──────
// data/supabase-write.js — Supabase 读写
function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

async function readTodayBiddingRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,time915,time920,time925,close';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  return await resp.json();
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

// ────── bidding-board-worker-a/data/tencent-api.js ──────
// data/tencent-api.js — 腾讯行情接口（板块ETF 实时涨幅）

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

// ────── bidding-board-worker-a/logic/bidding-calc.js ──────
// logic/bidding-calc.js — 竞价变化计算
function avgOf(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce(function (a, b) { return a + b; }, 0) / numbers.length;
}

function fmtPct(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function computeBiddingRows(env, point) {
  const rows = {};

  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_LADDER] = { value: null, error: '883410 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
      const vals = codes.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
      const avg = avgOf(vals);
      rows[CONFIG.ROW_LADDER] = avg === null
        ? { value: null, error: '成分股快照全部缺失(' + codes.length + '只)' }
        : { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_LADDER] = { value: null, error: e.message }; }

  try {
    const stockCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'stock').map(e => e.code);
    const indexCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'index').map(e => e.code);
    const stockPcts = await getTencentSnapshotPcts(stockCodes);
    const indexPcts = await getIndexSnapshotPcts(env, indexCodes);
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
    const codes = await getConstituentThscodes(env, CONFIG.TOP10_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_TOP10] = { value: '0', error: '883901 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
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
    const pcts = await getIndexSnapshotPcts(env, [CONFIG.MAIN_INDEX]);
    const v = pcts[CONFIG.MAIN_INDEX];
    rows[CONFIG.ROW_MAIN_INDEX] = (typeof v === 'number' && !isNaN(v)) ? { value: fmtPct(v) } : { value: '0.00', error: '上证指数快照缺失' };
  } catch (e) { rows[CONFIG.ROW_MAIN_INDEX] = { value: '0.00', error: e.message }; }

  return rows;
}

// ────── bidding-board-worker-a/logic/bidding-workflow.js ──────
// logic/bidding-workflow.js — 竞价主流程
async function runBidding(env, point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'cron', job: 'bidding', worker: 'A' };
  if (!column) return { ok: false, error: '未知 time_point: ' + point };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let existingByName = {};
  if (point === 't0925') {
    try { (await readTodayBiddingRows(env, date)).forEach(r => existingByName[(r.name || '').trim()] = r); }
    catch (e) { console.error('读今日行失败:', e.message); }
  }

  function buildUpsertPayload(computed, now) {
    const payload = [];
    const results = {};
    Object.keys(computed).forEach(rowName => {
      const r = computed[rowName];
      results[rowName] = r;
      if (r.value === null || r.value === undefined) return;
      const row = { date: date, name: rowName, updated_at: now };
      row[column] = r.value;
      if (point === 't0925') {
        const prev = existingByName[rowName];
        const v920 = prev ? parseFloat(prev.time920) : NaN;
        const v925 = parseFloat(r.value);
        if (!isNaN(v920) && !isNaN(v925)) row.change = v925 > v920 ? '增' : (v925 < v920 ? '减' : '平');

      }
      payload.push(row);
    });
    return { payload, results };
  }

  const computed = await computeBiddingRows(env, point);

  // 先写入所有非 null 行（不等重试），防止 Worker 超时导致全部丢失
  const now1 = new Date().toISOString();
  const { payload: payload1, results: results1 } = buildUpsertPayload(computed, now1);
  let ok = true, writeError = null;
  if (payload1.length > 0) {
    try { await upsertBiddingRows(env, payload1); }
    catch (e) { ok = false; writeError = e.message; }
  }

  // 重试失败的行（先写入成功行后再等重试，超时也不影响已写入的数据）
  const failedRowNames = Object.keys(computed).filter(k => computed[k].value === null || computed[k].value === undefined);
  if (failedRowNames.length > 0) {
    console.log('本趟有 ' + failedRowNames.length + ' 行未抓到(' + failedRowNames.join(',') + ')，45 秒后重试...');
    await new Promise(r => setTimeout(r, 45000));
    try {
      const retry = await computeBiddingRows(env, point);
      const retryComputed = {};
      failedRowNames.forEach(k => { if (retry[k] && retry[k].value !== null && retry[k].value !== undefined) { computed[k] = retry[k]; retryComputed[k] = retry[k]; } });
      const now2 = new Date().toISOString();
      const { payload: payload2 } = buildUpsertPayload(retryComputed, now2);
      if (payload2.length > 0) {
        try { await upsertBiddingRows(env, payload2); }
        catch (e) { console.warn('重试写入失败:', e.message); }
      }
    } catch (e) { console.warn('45 秒重试失败:', e.message); }
  }

  await writeLog(env, Object.assign(logBase, { ok, detail: { written: payload1, rows: results1, writeError } }));
  return { ok, date, point, column, written: payload1, rows: results1, writeError };
}

async function runDuobanSecond(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'duoban-second', worker: 'A' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  // 9:26 补写：不仅补"最近多板%"，也补其它4行（板块ETF/昨日资金前十/大盘ETF/大盘（%））
  // 防止 9:25 整趟 runBidding 超时失败时，只有最近多板%有补救
  const computed = await computeBiddingRows(env, 't0926');
  const duobanResult = computed[CONFIG.ROW_LADDER] || { value: null, error: '未计算' };

  let existingByName = {};
  try {
    const rows = await readTodayBiddingRows(env, date);
    rows.forEach(r => existingByName[(r.name || '').trim()] = r);
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
    try { await upsertBiddingRows(env, upsertPayload); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: upsertPayload, row: duobanResult, writeError } }));
  return { ok, date, point: 't0926', written: upsertPayload, row: duobanResult, writeError };
}

// ────── bidding-board-worker-a/index.js ──────
// index.js — bidding-board-worker-a 入口
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

function cronToPoint(cronExpr) {
  if (CRON_TO_POINT[cronExpr]) return CRON_TO_POINT[cronExpr];
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  const MIN_HOUR_TO_POINT = {
    '15 1': 't0915', '20 1': 't0920', '25 1': 't0925', '26 1': 't0926', '0 8': 'close',
  };
  return MIN_HOUR_TO_POINT[key] || null;
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[bidding-A] 无法识别 cron 表达式:', event.cron);
      return;
    }
    if (point === 't0926') ctx.waitUntil(runDuobanSecond(env, 'cron'));
    else ctx.waitUntil(runBidding(env, point, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-a', worker: 'A' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!POINT_TO_COLUMN[point]) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0926') result = await runDuobanSecond(env, 'http');
      else result = await runBidding(env, point, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('bidding-board-worker-a', { status: 200 });
  },
};
