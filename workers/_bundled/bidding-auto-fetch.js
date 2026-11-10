// ===== bidding-auto-fetch — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====
// 生成时间: 2026-11-10 03:51:44
// 注意: 此文件自动生成，请勿手动编辑
//
// ⚠️ 部署自检（粘贴前务必做完这三步）:
//   1) 编辑器【先全选 (Ctrl+A) 再删除】清空后，再粘贴本文件 ——
//      若把本文件粘在旧代码下面，会报 Identifier 'beijingNow' has already been declared
//      （实测行号 = 旧文件行数 + 8）。
//   2) 粘贴后核对编辑器总行数 = 6831（少了=没粘全，约翻倍=粘重了）。
//   3) Ctrl+F 搜「function beijingNow」→ 正常命中 2 处（本行说明 1 处 + 真函数定义 1 处）；>2 处 = 粘重。

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


/**
 * ============================================================================
 * [TIMEOUT 2026-09-30] 上游请求一律带【硬超时】—— 没有超时的 fetch 会吊死整轮早盘
 * ----------------------------------------------------------------------------
 * 事故（2026-09-30）：早盘竞价看板 9:26 打开时【正式成员 + 当日竞价数据全空】，
 * 直到 9:30 才出现。取证（Supabase 落库时间戳，北京时间）：
 *     · auction_watchlist 当日 39 行 created_at = 09:29:44.090（== 本轮 nowIso）
 *     · market_metrics  当日 60 行 created_at = 09:29:46.022（== P0-③ 落库）
 *   ⇒ 从 cron（09:25:00）到 P0-① 结束共 **284 秒**，而 P0-②③/P1/P2 全部写库动作
 *     加起来只用了 **2.08 秒**。也就是说：不是算得慢，是 P0-① 被【一个上游吊住了】。
 *
 * P0-① 里唯一的两个网络依赖就是本文件的两次 fuyao-proxy 调用
 *   （fetchLadderConstituents 取 883410 成分股 / fuyaoCalendarTradingDays 取交易日历），
 * 健康时实测各 ≈2~2.5s，但 `fetch` **没有 timeout**：上游连接一旦挂起（限流排队 /
 * TCP 半开 / 边缘函数冷启动叠加），单次请求可以吊几十秒；再乘 retryFuyao 的 4 次尝试
 * 就是分钟级 —— 正好把 9:26 顶穿到 9:30。
 *
 * 同类事件并非孤例（market_metrics 当日首行落库时刻，北京时间）：
 *   9/10 09:26:18 ❌ ｜ 9/11 09:29:56 ❌ ｜ 9/17 09:26:08 ❌
 *   9/28 09:30:24 ❌ ｜ 9/30 09:29:46 ❌   ← 21 个交易日里 5 次顶穿 9:26
 *
 * 因此：① 每次 fetch 都有超时；② 重试有【总预算】，预算耗尽立刻放弃（照常走降级分支），
 *       绝不允许「重试」把落库时间无限往后推。
 * ============================================================================
 */
const FUYAO_CALL_TIMEOUT_MS = 4500;      // 单次请求超时（健康值 ≈2~2.5s 的 ~1.8 倍）
const FUYAO_SLOW_CALL_TIMEOUT_MS = 10000; // 批量/历史类调用（快照、K线）——不在 9:26 关键路径上，给宽一点
const FUYAO_RETRY_BUDGET_MS = 12000;     // 名册类调用总预算（含退避）
const FUYAO_CALENDAR_TIMEOUT_MS = 3000;  // 交易日历单次超时（更紧，它本就有本地兜底）
const FUYAO_CALENDAR_BUDGET_MS = 5000;   // 交易日历总预算

/**
 * 带超时的 fetch。Cloudflare Workers / Node18+ 都支持 AbortSignal.timeout；
 * 老 runtime 退回 AbortController 手写计时器，保证「一定有超时」。
 */
function fetchWithTimeout(url, opts, timeoutMs) {
  const ms = timeoutMs > 0 ? timeoutMs : FUYAO_CALL_TIMEOUT_MS;
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
 * [RETRY 2026-09-15] 上游「全局请求限流」重试。
 *
 * 事故背景（2026-09-15 P0）：9:25 早盘那一轮，P0-① 的第一个请求（883410 成分股）撞上
 * fuyao 的 `code=429 Global request rate limit exceeded`，**没有任何重试** →
 * fetchAndWriteWatchlist 直接 `return { error }` → runMorning 整轮 return：
 * auction_watchlist / market_metrics / stock_range_pct **一张表都没写**，
 * 用户 9:25~9:39 打开看板「第一页全空、无法操作」。
 *
 * 实测该限流是**突发性**的：同一接口相邻两次调用一次 200、一次 429，
 * 退避 1~2 秒后即可恢复。因此对「可重试错误」做短退避重试，硬指标（9:26 落库）内可承受。
 *
 * [TIMEOUT 2026-09-30] 追加【总预算】与【动态单次超时】：
 *   · `budgetMs` 用完后不再发起新尝试（含退避时间也计入预算）；
 *   · 每次尝试的超时 = min(perCallMs, 预算剩余)，保证最坏耗时 ≤ budgetMs 量级。
 *   这两条是 9/30 事故的正面修复：原来的「4 次尝试」在请求挂起时会变成 4 × 几十秒。
 *
 * [RETRY-CLASSIFY 2026-11-06] 11-06 09:25 的 P0 事故暴露第二个 bug：
 *   上游返回 `fuyao ... 错误: Data source unavailable`（code!=0，但 HTTP 200），
 *   旧正则只认 429/5xx/timeout/network ⇒ 判成「业务性错误」⇒ **第 1 次就 break**，
 *   而 morning-workflow 的日志却写「（已重试）」，把「没重试」伪装成「重试过还失败」。
 *   实测该错误是突发的：09:25 失败，09:4x 手工拨测同一个接口 HTTP 200 / 2790ms / 57 只。
 *   ⇒ 把「上游数据源临时不可用」类文案纳入可重试，同时把判定抽成纯函数 + 单测锁住。
 *   ⛔ 总预算 12s 不变，重试不会顶穿 9:26 硬指标。
 *
 * @param {(ms:number)=>Promise<any>} fn 真正发请求的函数，接收「本次可用超时」
 * @param {number} attempts 最多尝试次数
 * @param {string} label 日志标签
 * @param {number} budgetMs 总预算（毫秒）；0/未传 = 只按次数限制（老行为）
 * @param {number} perCallMs 单次超时（毫秒）
 */
/**
 * [RETRY-CLASSIFY 2026-11-06] 纯函数：这条错误值不值得重试？
 *
 * 只覆盖「上游瞬时不可用」：限流、5xx、超时、网络、数据源临时不可用。
 * ⛔ 业务性错误（thscode 不存在、参数非法、鉴权失败、非交易日）一律不重试 ——
 *    重试它们不会改变结果，只会白烧 12s 预算并把 9:26 硬指标顶穿（§32）。
 * 导出仅为单测：这是 11-06 P0 的根因判据，必须有回归锁。
 */
function isRetriableFuyaoError(msg) {
  const s = String(msg || '');
  if (!s) return false;
  return /429|rate limit|5\d\d|timeout|timed out|abort|network|fetch failed|ECONN/i.test(s)
    || /data source (?:unavailable|not available|error)|service unavailable|temporarily unavailable/i.test(s)
    || /upstream (?:error|unavailable|busy)|bad gateway|gateway timeout|please (?:try again|retry)/i.test(s);
}

async function retryFuyao(fn, attempts, label, budgetMs, perCallMs) {
  const n = attempts || 4;
  const budget = budgetMs > 0 ? budgetMs : 0;
  const perCall = perCallMs > 0 ? perCallMs : FUYAO_CALL_TIMEOUT_MS;
  const t0 = Date.now();
  let lastErr;
  for (let i = 0; i < n; i++) {
    const used = Date.now() - t0;
    if (budget > 0 && i > 0 && used >= budget) {
      console.warn('[FUYAO-RETRY] ' + (label || '') + ' 重试总预算 ' + budget + 'ms 已用尽（已用 ' + used +
        'ms，第' + i + '次尝试前放弃）→ 立即走降级');
      break;
    }
    const callMs = budget > 0 ? Math.min(perCall, Math.max(300, budget - used)) : perCall;
    try {
      return await fn(callMs);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      // 只重试「上游瞬时」类错误；业务性错误（如 thscode 不存在）重试无意义
      // [RETRY-CLASSIFY 2026-11-06] 判据统一走纯函数（含 Data source unavailable），⛔ 不在这里另写一份
      const retriable = isRetriableFuyaoError(msg);
      if (!retriable || i === n - 1) {
        if (!retriable) {
          console.warn('[FUYAO-RETRY] ' + (label || '') + ' 判为【不可重试错误】→ 立即走降级（未重试）: ' + msg.slice(0, 120));
        }
        break;
      }
      const wait = 900 * Math.pow(2, i);
      if (budget > 0 && (Date.now() - t0) + wait >= budget) {
        console.warn('[FUYAO-RETRY] ' + (label || '') + ' 第' + (i + 1) + '次失败：' + msg.slice(0, 120) +
          ' → 退避 ' + wait + 'ms 会超出总预算，放弃重试');
        break;
      }
      console.warn('[FUYAO-RETRY] ' + (label || '') + ' 第' + (i + 1) + '次失败：' + msg.slice(0, 120) +
        ' → ' + wait + 'ms 后重试');
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// [BIDDING-CLOSE-CLOUD 2026-11-07] 导出给 16:00 收盘列云端落库复用（883901 名单 / 指数快照）。
// ⛔ 不要在别的模块复制一份 fuyao-proxy 请求逻辑（§6 单一数据入口）。
async function fuyaoProxyGet(env, path, params, timeoutMs) {
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  }
  // [TIMEOUT 2026-09-30] 每个上游调用都必须有上限，否则连接挂起会吊死整轮早盘
  const resp = await fetchWithTimeout(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } }, timeoutMs);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao-proxy ' + path + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao ' + path + ' 错误: ' + (json.message || 'code=' + json.code));
  return json.data;
}

// 调 fuyao 交易日历，返回最近 N 天交易日列表（升序）
// [RETRY 2026-09-15] 交易日历是 P0-①/P1/P2 的公共前置，429 会让窗口算不出来 → 必须重试。
// [TIMEOUT 2026-09-30] 但它是【可降级】前置：getRecentTradingDays / mergeTradingDay 都有
//   本地硬编码表兜底，拿不到日历不会让任何一天数据变错，只会让「预期交易日窗口」粗一点。
//   因此给它最小的预算（5s / 单次 3s）—— 它是 9/30 事故里最可能吊死整轮的那一个。
async function fuyaoCalendarTradingDays(env) {
  return retryFuyao(async (callMs) => {
    const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
    const url = new URL(CONFIG.FUYAO_PROXY_BASE);
    url.searchParams.set('path', '/api/a-share/calendar/trading-days');
    const resp = await fetchWithTimeout(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } }, callMs);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('fuyao calendar HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    const json = await resp.json();
    if (json.code !== 0) throw new Error('fuyao calendar 错误 code=' + json.code + ': ' + (json.message || ''));
    const items = (json.data && json.data.item) || [];
    return items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
  }, 4, 'calendar/trading-days', FUYAO_CALENDAR_BUDGET_MS, FUYAO_CALENDAR_TIMEOUT_MS);
}

// 获取最近多板成分股 → [{ name, code }]
// [RETRY 2026-09-15] ★ 这是 9:25 早盘 P0-① 的【第一个】请求，也是本次 P0 事故的引爆点：
//   它 429 一次就会让整轮早盘抓取中断（一张表都不写）。这里必须重试。
// [TIMEOUT 2026-09-30] 名册是 P0-① 的**不可降级**前置（拿不到就没有「正式成员」），
//   所以给足 12s 总预算 / 单次 4.5s：既覆盖健康时的 2~2.5s，也保证最坏情况 ≤ 12s，
//   让 P0-②③ 一定能在 9:26 前写完（见 morning-workflow.js 的 P0 硬截止）。
async function fetchLadderConstituents(env) {
  return retryFuyao(async (callMs) => {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list',
      { thscode: CONFIG.LADDER_THSCODE }, callMs);
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
  }, 4, 'constituents/ths-stock-list(883410)', FUYAO_RETRY_BUDGET_MS, FUYAO_CALL_TIMEOUT_MS);
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
      data = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscodes }, FUYAO_SLOW_CALL_TIMEOUT_MS);
      stats.batchOk++;
    } catch (batchErr) {
      stats.batchFail++;
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscode }, FUYAO_SLOW_CALL_TIMEOUT_MS);
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

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 同花顺「集合竞价快照」（免费、不限累计次数、单次 ≤100 个代码、stage=final）。
 *
 * ✅ [AUC-TRUTH 2026-11-05] 旧注释说「猫抓 daily_auc 对【当日】行不返回 auc_pct_chg /
 *    auc_vol_ratio / auc_turnover，要等结算后才出现」——**已被生产实证推翻**，不要拿它当结论：
 *    11-05 09:25 那轮 `numcat 返回 fields=[..., "auc_vol_ratio","auc_turnover"] items=290 行`，
 *    写入的 58 只 58/58 全带 auc_vol_ratio。猫抓 9:25 就给竞价量比，和竞价字段同一个接口。
 *
 * 本接口真实用途（分工，不是「猫抓拿不到」）：9:25 主流程写入后，个别票可能因为
 *   「不在 9:25 抓取名单里」或「上游当次 auc_vol 还是占位 0」而缺 volume / auc_pct_chg /
 *   auc_turnover；用本接口（免费、0 猫抓额度）把这些**同花顺可提供的字段**补齐。
 *
 * ⚠️ 只返回「最近一个交易日」（滚动窗口：当天收盘后 → 下一交易日开盘前）；周末/节假日调用返回上一交易日终态。
 *    因此调用方必须先用 timestamp 校验「服务端日期 == 目标日」，否则拒绝写入（避免把上一日数据写到今天）。
 * ⚠️ um_vol / open_bid_pct 不在此接口能力内：snapshot.auction_unmatched 带符号，与库内 um_vol
 *    （从不出现负值）语义不同源 → 按 §40「不凭猜测改数据库」留空，仍由次日 numcat 补漏负责。
 *    量纲换算已交叉验证（见 backups/同花顺官方接口竞价能力核查_2026-09-13.md）：
 *      volume ← round(auction_volume/100)（手→万股）｜auc_pct_chg ← auction_pct
 *      auc_turnover ← auction_turnover_pct
 * ⛔⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04 / 用户 2026-11-06 再次强调]
 *    **auction_volume_ratio 禁止映射到库内 auc_vol_ratio，任何时段、任何路径、兜底也不行**。
 *    同花顺的「竞价量比」是开盘后口径，与猫抓 auc_vol_ratio（9:25 竞价时间段）不同源；
 *    掺进库里就是错数据，而下游拿它当选票依据（logic/decision/decision-rules.js）⇒ 直接选错股。
 *    用户原话：「题材量比一定要用猫爪数据的竞价时间段的，不要用同花顺的」「兜底也不行」。
 *    唯一合法来源 = 猫抓 numcat daily_auc.auc_vol_ratio（9:25 主流程 / 9:26 名单补抓 / 16:30 历史回填）。
 *    前端 src/logic/auction/ths-today-patch.js 早已合规；worker 的 runTodaySnapshotPatch 曾漏掉，已删。
 *
 * @param {object} env
 * @param {string[]} codes 6 位股票代码
 * @returns {Promise<{items:object[], batches:Array<{timestamp:number, auction_phase:string, data_status:string}>}>}
 */
async function fetchAuctionSnapshot(env, codes) {
  const items = [];
  const batches = [];
  const list = Array.from(new Set((codes || []).map(c => String(c).trim()).filter(c => /^\d{6}$/.test(c))));
  for (let i = 0; i < list.length; i += 100) {
    const thscodes = list.slice(i, i + 100).map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    const data = await fuyaoProxyGet(env, '/api/a-share/auction/snapshot', { thscodes: thscodes, stage: 'final' }, FUYAO_SLOW_CALL_TIMEOUT_MS);
    batches.push({
      timestamp: data && data.timestamp,
      auction_phase: data && data.auction_phase,
      data_status: data && data.data_status
    });
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) items.push(arr[k]);
  }
  return { items: items, batches: batches };
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
    // [TIMEOUT 2026-09-30] 直连 fuyao 的历史 K 线原本没有超时，连接挂起会一直吊着
    const resp = await fetchWithTimeout(url.toString(), { headers: { 'X-api-key': apiKey } }, FUYAO_SLOW_CALL_TIMEOUT_MS);
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
    }, FUYAO_SLOW_CALL_TIMEOUT_MS);
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
//
// ============================================================================
// [KEY-FALLBACK 2026-09-28] 主账号额度用尽 → **自动退回小号**，保证 9:25 早盘竞价数据不缺席
// ----------------------------------------------------------------------------
// 用户硬指标：每个交易日 **9:25~9:26 早盘竞价看板数据必须完整**（盘前下单要看它，
// 决策看板也依赖它）。而猫抓免费档**每天只有 10 次调用**，额度一旦被别人（前端抢跑 /
// 其他看板兜底 / 手动按钮）花光，worker 9:25 的 daily_auc 就会拿到
// `code=403 今日调用额度已用完` → 当天的 竞价量 / 昨成交量 / 竞价涨幅 整片为空、事后难补救。
//
// 因此构建【key 候选链】：NUMCAT_API_KEY（主账号）→ NUMCAT_API_KEY_YIZI（小号）。
//   · 只有「额度类错误」才换 key（403 / 429 / 额度用尽 / 限流）——
//     网络 / DNS / 超时这类错误换 key 也一样失败，只会白烧小号额度（§32 禁止无意义请求）。
//   · 小号没配置（Cloudflare Secret 未设）→ 候选链只剩主账号，行为与改造前完全一致（零风险）。
//   · 全部 key 都额度用尽 → 抛出的错误带 `quotaExhausted=true`，
//     调用方据此【立即停止重试】（重试同样拿不到，白等 25s 只会顶穿 9:26 硬指标）。
// ⚠️ 代价（刻意取舍）：退回小号会占用小号当天的额度（小号 = 竞价一字看板那把，10 次/天）。
//    但小号只在「主账号已废」时才被动用，而用户口径是早盘竞价优先级最高。
// ============================================================================

/** 上游「额度用尽 / 限流」判定（HTTP 或业务码 403、429，或文案里明确说额度/限流） */
function isQuotaError(msg) {
  const s = String(msg || '');
  if (!s) return false;
  if (/code=403|code=429|HTTP 403|HTTP 429/.test(s)) return true;
  if (s.indexOf('额度') >= 0) return true;
  if (/RATE_LIMIT|rate limit/i.test(s)) return true;
  return false;
}

/** 上游 key 候选链（按优先级）。缺哪个跳哪个；两把都没配 → 空数组 */
function configuredKeys(env) {
  const list = [];
  const main = String((env && env.NUMCAT_API_KEY) || '').trim();
  if (main) list.push({ name: 'NUMCAT_API_KEY', key: main });
  const small = String((env && env.NUMCAT_API_KEY_YIZI) || '').trim();
  if (small && small !== main) list.push({ name: 'NUMCAT_API_KEY_YIZI', key: small });
  return list;
}

/** 掩码回显（排查用）：只用于确认「到底用的哪把 key」，绝不回显全量 */
function maskKey(k) {
  const s = String(k || '');
  return s.length <= 8 ? '***' : s.slice(0, 4) + '***' + s.slice(-4);
}

/** 单次上游请求（单把 key）。额度类失败抛出的错误带 quotaExhausted 标记 */
// [TIMEOUT 2026-09-30] 加硬超时：猫抓网络抖动时裸 fetch 会一直挂着，
//   而本调用位于 9:25 P0 关键路径上（P0-②），挂一次就把落库顶穿 9:26。
//   12s 对健康调用（实测 1~2s）绰绰有余；超时错误里带 timeout 关键字，
//   会让 morning-workflow 的「今天数据缺失」重试逻辑正常接管。
const NUMCAT_TIMEOUT_MS = 12000;
/**
 * ★ [NUMCAT-RETRY 2026-11-04 用户报障「9:48 才出票，关机就不出票」]
 * 重试用的超时。为什么要单独给一个更短的值：9:25 那次调用在 P0 硬截止（09:25:45）内，
 * 首次 12s + 重试 12s = 24s 还能塞进去；但如果首次就吃满 12s，重试再吃 12s 会逼近上限。
 * 8s 对健康调用（实测 1~2s）依然宽松，且能把「重试也失败」的最坏耗时压到 20s。
 */
const NUMCAT_RETRY_TIMEOUT_MS = 8000;
async function postOnce(url, key, apiname, fields, params, timeoutMs) {
  const body = { apiname: apiname, apikey: key, fields: fields, params: params };
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(timeoutMs || NUMCAT_TIMEOUT_MS);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error('numcat ' + apiname + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
    if (resp.status === 403 || resp.status === 429) e.quotaExhausted = true;
    throw e;
  }
  const json = await resp.json();
  if (json.code !== 200) {
    const e = new Error('numcat ' + apiname + ' 错误: ' + (json.message || JSON.stringify(json)) +
      '（上游 code=' + json.code + '）');
    e.upstreamCode = json.code;
    if (json.code === 403 || json.code === 429) e.quotaExhausted = true;
    throw e;
  }
  return json.data;
}

/** 超时 / 网络类「瞬态」错误：换 key 无意义，但【同 key 立刻重试一次】常常就好了 */
function isTransientError(e) {
  if (!e) return false;
  if (e.quotaExhausted) return false;                 // 额度类不在此列（换 key 才有用）
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const s = String(e.message || '');
  if (/HTTP 4\d\d/.test(s)) return false;             // 客户端错误，重试也不会变
  return /timeout|timed out|aborted|network|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(s);
}

/**
 * 按候选链请求上游：额度类错误自动换下一把 key。
 * @param {object} env worker env（NUMCAT_API_KEY / NUMCAT_API_KEY_YIZI）
 * @param {object} opt { apiname, url, fields, params, logs }
 * @returns {Promise<{data:object, keyName:string}>}
 * @throws 最后一把 key 的错误；若最后一次失败是额度类，错误会带 quotaExhausted=true
 */
async function postNumcat(env, opt) {
  const o = opt || {};
  const logs = Array.isArray(o.logs) ? o.logs : [];
  const keys = configuredKeys(env);
  if (keys.length === 0) {
    throw new Error('numcat ' + o.apiname + ' 未配置 key（请设置 Secret NUMCAT_API_KEY）');
  }
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    try {
      const data = await requestWithRetry(o, k, logs);
      if (i > 0) {
        logs.push('✅ numcat ' + o.apiname + ' 已退回【小号 ' + k.name + '（' + maskKey(k.key) + '）】取数成功');
      }
      return { data: data, keyName: k.name };
    } catch (e) {
      lastErr = e;
      logs.push('⚠️ numcat ' + o.apiname + ' key=' + k.name + '（' + maskKey(k.key) + '）失败: ' + e.message);
      const hasNext = i + 1 < keys.length;
      if (hasNext && e.quotaExhausted) {
        logs.push('→ 主账号额度用尽，退回下一把 key（' + keys[i + 1].name + '）继续取数');
        continue;
      }
      if (hasNext && !e.quotaExhausted) {
        logs.push('→ 非额度类错误，不换 key（换 key 同样失败，只会白烧小号额度 §32）');
      }
      break;
    }
  }
  throw lastErr;
}

/**
 * ★ [NUMCAT-RETRY 2026-11-04] 同 key 一次请求 + 瞬态失败重试一次。
 *
 * 【为什么必须有这个重试】2026-11-04 的真实事故链：
 *   9:25 daily 接口 `The operation was aborted due to timeout`（纯网络抖动）
 *   → 旧逻辑把它当"非额度错误"直接 break 放弃
 *   → 云端 `stock_range_pct` 当天 0 行（区间涨幅完全没落库）
 *   → 题材量比在浏览器里只能自己逐只拉 K 线补算
 *   → 用户 9:40 开电脑，9:46 才算完写库，9:48 才出票；不开电脑就永远不出票。
 * 一次 12s 超时不该让整天的区间涨幅消失 —— 重试一次的成本（最坏 +8s）远小于代价。
 * ⚠️ 只重试「瞬态」错误；额度类仍走换 key（§32 不白烧小号额度），4xx 也不重试。
 * @returns {Promise<object>} json.data
 */
async function requestWithRetry(o, k, logs) {
  try {
    return await postOnce(o.url, k.key, o.apiname, o.fields, o.params);
  } catch (e1) {
    if (!isTransientError(e1)) throw e1;
    logs.push('↻ numcat ' + o.apiname + ' 首次失败（' + e1.message + '）⇒ 同 key 立刻重试一次（瞬态错误，不是额度问题）');
    try {
      const data = await postOnce(o.url, k.key, o.apiname, o.fields, o.params, NUMCAT_RETRY_TIMEOUT_MS);
      logs.push('✅ numcat ' + o.apiname + ' 重试成功（第一次是瞬态超时/网络抖动）');
      return data;
    } catch (e2) {
      logs.push('✖ numcat ' + o.apiname + ' 重试仍失败: ' + e2.message);
      throw e2;
    }
  }
}

/** 竞价数据（含当天）：竞价量 auc_vol / 竞价涨幅 auc_pct_chg / 反推昨成交量用的 auc_to_pre_vol_pct */
async function numcatDailyAuc(env, symbols, startDateYMD, endDateYMD, logs) {
  // 【FIX 2026-08-03】改用显式 startdate/enddate（YYYYMMDD），不再用 recentdays
  const res = await postNumcat(env, {
    apiname: 'daily_auc',
    url: CONFIG.NUMCAT_DAILY_AUC_URL,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover',
    params: { symbols: symbols, startdate: startDateYMD, enddate: endDateYMD },
    logs: logs
  });
  return res.data;
}

/** 日线涨幅 pct_chg（10 日区间涨幅的历史腿） */
async function numcatDaily(env, symbols, startDateYMD, endDateYMD, logs) {
  const res = await postNumcat(env, {
    apiname: 'daily',
    url: CONFIG.NUMCAT_DAILY_URL,
    fields: 'symbol,tradedate,pct_chg',
    params: { symbols: symbols, startdate: startDateYMD, enddate: endDateYMD },
    logs: logs
  });
  return res.data;
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
async function writeRunLog(env, entry) {
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
function bucketRowsByKeySet(rows) {
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

async function upsertAuctionWatchlist(env, rows) {
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
async function deleteLadderFallbackRows(env, date) {
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

async function upsertMarketMetrics(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'market_metrics',
    CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date,stock,scope', rows);
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
async function readRange20StocksForDate(env, date) {
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
async function readDailyLegsForStocks(env, fromDate, beforeDate, stocks, chunkSize) {
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
async function upsertRange20Rows(env, rows) {
  if (!rows || rows.length === 0) return;
  await upsertBucketed(env, 'stock_range20_pct',
    CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?on_conflict=date,stock', rows);
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
async function readMetricsLegsWindow(env, fromDate, throughDate) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?select=stock,date,change_pct,auc_pct_chg' +
    '&scope=eq.auction&date=gte.' + encodeURIComponent(fromDate) +
    '&date=lte.' + encodeURIComponent(throughDate) + '&order=date.asc';
  return sbGetPaged(env, url);
}

/** 读某日 stock_daily_pct 已有股票（⛔ 已有的一律不碰：纯新增、幂等） */
async function readDailyPctStocksForDate(env, date) {
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
async function upsertDailyPctRows(env, rows) {
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
async function readMarketMetricsForDate(env, date, scope) {
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
async function readMarketMetricsExtrasForDate(env, date) {
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
async function readMarketMetricsSnapshotFieldsForDate(env, date) {
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
async function readStockRangePctForDate(env, date) {
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
async function readRange20TopForDate(env, date, limit) {
  const n = Number(limit) > 0 ? Math.floor(Number(limit)) : 20;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stock_range20_pct?date=eq.' +
    encodeURIComponent(date) + '&select=stock,pct,days,leg&limit=2000';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
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
async function readAuctionWatchlistForDate(env, date) {
  // [LADDER-FALLBACK 2026-11-06] 额外返回 source：降级时挑「前一日正式成员」做兜底名单，
  //   必须能把 source='range20'（前端 20 日补位票）/ 'manual'（观察组壳行）排除掉，
  //   否则会把补位票当成「最近多板成分股」写进今天的常规组。
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + date + '&select=stock,code,obs_auto_added,source';
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) return [];
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
  const resp = await sbFetch(url, { headers: sbHeaders(env) });
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
 * [DRAGON-GROUP 2026-09-14] 读取某【评选日】的龙头名册（dragon_leaders）。
 * 用途：9:25 抓取前，把「前一交易日评选出的龙头」并入抓取名单 → 保证龙头组数据的【完整获取】
 *      （需求 2：包括龙头组在内，所有数据和正式列表一样都要自动、完整获取）。
 * 口径：名册的评选/落库唯一实现在前端 Logic 层（logic/auction/dragon-group.js），worker 只读不选
 *      —— 避免「前端算一套、worker 算一套」的第二真相源（§6）。
 * 与 auction_watchlist / 打标签股票同款：只并入【抓取名单 constituents】，不写 auction_watchlist，
 *      不破坏「当日名单 = 9:25 快照」的锁定口径。
 * 失败返回 []（非致命：当次龙头数据缺失，但不该因此中断整轮早盘抓取）。
 */
async function readDragonLeadersForDate(env, date) {
  if (!date) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/dragon_leaders?date=eq.' + encodeURIComponent(date) +
    '&select=stock,code,topic&limit=500';
  try {
    const resp = await sbFetch(url, { headers: sbHeaders(env) });
    if (!resp.ok) return [];
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
  } catch (e) {
    return [];
  }
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

// [FIX 2026-08-15] 读取股票名称→代码映射表（stockcodemap），为 watchlist 里 code 为空的
// 观察组/打标签股票补充 code（worker 的 numcat 抓取按 code 查询，无 code 无法抓数据）。
// ⚠️ 受 Supabase 单次 1000 行上限截断；缺漏由 readStockCodeMapByNames 按名补齐。
async function readStockCodeMap(env) {
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

// ────── bidding-auto-fetch/logic/holiday-check.js ──────
// holiday-check.js — 交易日判断（用户设置 > 周末 > fuyao 交易日历 > 本地硬编码表）
//
// [TRADING-DAY 2026-09-29] 这里原来是「fuyao 优先，失败回退本地硬编码表」的两源实现，
//   而「用户在前端顶栏标的假期」完全不在判据里 —— 后果是休市日被算进「最近交易日窗口」，
//   让 prevDay 错位，同时把整轮早盘抓取跑在了一个根本不开市的日子上（9/28 事故的一环）。
//   现在统一走 _shared-source/trading-day.js 的三源合并（唯一实现 §6）。
/**
 * 读用户覆盖表。**失败返回 null**（= 该层弃权），绝不把「读不到」当成「用户没设置」（§10）。
 * @returns {Promise<Map<string, boolean>|null>}
 */
async function loadOverrideMap(env) {
  try {
    return await fetchTradingDayOverrides(
      CONFIG.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY
    );
  } catch (e) {
    console.warn('交易日覆盖表读取失败（回退为「无用户设置」，继续用后续判据）: ' + e.message);
    return null;
  }
}

/** 取 fuyao 日历。**失败返回 null**（= 该层弃权，交给硬编码表） */
async function loadFuyaoDates(env) {
  try {
    return await fuyaoCalendarTradingDays(env);
  } catch (e) {
    console.warn('fuyao 交易日历不可用（该层弃权，改用用户设置 / 硬编码表）: ' + e.message);
    return null;
  }
}

async function isTradingDay(env, dateStr) {
  const [overrideMap, fuyaoDates] = await Promise.all([loadOverrideMap(env), loadFuyaoDates(env)]);
  return mergeTradingDay(dateStr, overrideMap, fuyaoDates);
}

// 取"截止到 todayStr（含）"最近 n 个真实交易日，升序返回 ["YYYY-MM-DD", ...]
//
// [FIX 2026-08-03] 优先走 fuyao 交易日历，失败时回退本地节假日表推算。
// [FIX 2026-09-29] 原来两条路都不看【用户在前端标的假期】：fuyao 路线直接 slice(-n)，
//   本地路线只用硬编码表 —— 于是用户标红的休市日照样进窗口。
//   现在改为【逐日向前推算 + 三源合并】，每条判据与别处完全同源，不再有两套日历（§6）：
//     · 用户显式设置（标红假期 / 取消假期）任何情况下最高优先，且对【过去】的日期同样生效；
//     · 日期落在 fuyao 日历覆盖区间内 → 以 fuyao 为准（真实日历最权威，能覆盖调休）；
//     · 区间外 → 硬编码表兜底。
async function getRecentTradingDays(env, todayStr, n) {
  const [overrideMap, fuyaoDates] = await Promise.all([loadOverrideMap(env), loadFuyaoDates(env)]);
  const result = [];
  // [FIX 2026-09-29] 这里原来（含改造前的本地兜底分支）是「Date.parse(today+'+08:00') 后取 getUTC*」，
  //   两者相差 8 小时 → 第一个被检查的日期就整体偏移一天（today 变成 today-1），窗口因此少一天、
  //   且 prevDay 系统性错位。改用 date-utils 的 dateStrToMs/msToDateStr（§6 单一实现，自带 +8h 补偿）。
  let ms = dateStrToMs(todayStr);
  // 回看上限 90 天：最长窗口是 10 天（RANGE_WINDOW_DAYS），90 天足够跨过任何单次长假。
  for (let i = 0; i < 90 && result.length < n; i++) {
    const s = msToDateStr(ms);
    if (mergeTradingDay(s, overrideMap, fuyaoDates)) result.unshift(s);
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
//          ⚠️ [T-LEG-FALLBACK 2026-09-14] 当日【竞价涨幅字段缺失】时退回「当日行内涨幅」(change_pct)，
//             绝不因此把 T 腿整根丢掉。缘由：9:25 之后 change_pct 写的就是当天的竞价副本
//             （worker P0 写入的 auc_pct_chg 值），盘中/收盘后则是当日实时/收盘涨幅 —— 两种都
//             比「缺一根腿、days=窗口-1 的系统性偏低值」更接近真值；丢掉 T 腿才是真正的错。
//             （实测 2026-09-14：market_metrics 当日 auc_pct_chg 全空，导致 46 行区间涨幅
//               days=9 = 只累到昨天，看板把「旧窗口」当成今天的十日涨幅。）
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
  if (isToday && !afterClose) {
    // [T-LEG-FALLBACK 2026-09-14] 竞价腿优先；缺失时退回当日行内涨幅 —— 见文件头 ③ 的说明。
    // 区分「竞价腿确实缺失」与「竞价腿真的是 0%」：a===null 才算缺失，0 是合法涨幅且优先。
    return a !== null ? a : c;
  }
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

/**
 * ★★ [TVRB-926 2026-10-14 用户口径] 【反解 T 腿】—— 把「已换成收盘腿的区间涨幅」还原成
 *    「T 腿 = 竞价涨幅」那一份（= 9:26 口径，用户要的「早上那一份」）。
 *
 * 用户原话：
 *   「题材量比看板选股买点侧，为什么早上的，和收盘的不一样，我只想要早上 9 点 26 分的……
 *     可能收盘后，涨幅覆盖了，又重新计算……因为我对照历史日期的时候就对不上，
 *     比如今天我明明买了某只股票，过些时间我再翻开那个时期，又成另外一只股票，非常不合理。」
 *
 * 为什么能反解（与 replaceTDayLeg 是【一对互逆运算】，故两处必须放在同一模块，§6）：
 *   正向：stored = (1 + old926) ÷ (1 + auc) × (1 + close) − 1
 *   反解：old926 = (1 + stored) ÷ (1 + close) × (1 + auc) − 1
 *   两个因子（竞价涨幅 / 收盘涨幅）都由 `market_metrics(scope='auction')` 的
 *   `auc_pct_chg` / `change_pct` 提供 —— 都是已落库的客观数据，**0 额外上游请求、0 额度**。
 *
 * ⚠️ 与「换腿」对称的三个前提（缺一不可，缺则【原样返回】，⛔ 绝不猜 —— §10）：
 *   ① `closePct`（收盘腿）读不到 ⇒ 无法判断这一行到底换过腿没有 ⇒ 原样；
 *   ② `aucPct`（竞价腿）读不到 ⇒ 无法还原那根腿（典型 = 那天整批 `auc_pct_chg` 缺失、
 *      9:25 的 T 腿走的是 `change_pct` 回退通道）⇒ 原样（拿 0 顶替会把整根腿凭空抹掉，更错）；
 *   ③ `closePct === -100` ⇒ 复利因子为 0，反解无意义 ⇒ 原样。
 *   ⚠️ 调用方还须【先确认这一行已是收盘口径】再调本函数（时间判定见 closeCoverUtcMs）；
 *      不是收盘口径的行，其原值本来就是 9:26 口径，调进来也只是恒等变换（见下面 ②③ 的注释）。
 *
 * @param {*} rangePct 库里已存的区间涨幅（%，可能已是收盘腿口径）
 * @param {*} aucPct   该股【当日竞价涨幅】（%，= 9:25 那根 T 腿；null ⇒ 不换算）
 * @param {*} closePct 该股【当日收盘涨幅】（%，= 现在那根 T 腿；null ⇒ 不换算）
 * @returns {number|null} 9:26 口径的区间涨幅（%）；缺数据 ⇒ 原值 / null（⛔ 绝不伪造 0）
 */
function recoverAuctionLeg(rangePct, aucPct, closePct) {
  const r = parsePct(rangePct);
  if (r === null) return null;
  const c = parsePct(closePct);
  if (c === null) return r;                      // ① 不知道换没换腿 ⇒ 原样
  const a = parsePct(aucPct);
  if (a === null) return r;                      // ② 竞价腿读不到 ⇒ 原样（见函数头）
  const closeFactor = 1 + c / 100;
  if (closeFactor === 0) return r;               // ③ 无法反解 ⇒ 原样
  // 先退回「除当天以外的 9 天复利」，再乘上竞价那根腿 —— 与 replaceTDayLeg 逐字对称
  const prevAcc = (1 + r / 100) / closeFactor;
  const next = (prevAcc * (1 + a / 100) - 1) * 100;
  return isFinite(next) ? next : r;
}

/** 北京时间收盘时刻（用于判定某行是否已按收盘口径写入，与 close-pct-cover 同源） */
const CLOSE_COVER_HOUR_BJ = 15;

/**
 * 某个日期「收盘覆盖时刻」对应的 UTC 时间戳（北京 15:00）。
 *
 * ⚠️ 这是「这一行是竞价腿口径还是收盘腿口径」的**唯一时间尺子**，两个消费者共用：
 *   · `close-pct-cover.js#_runCover`（决定要不要把 T 腿换成收盘腿）；
 *   · `range-auction-leg.js`（决定要不要把 T 腿反解回竞价腿）。
 *   §6：⛔ 绝不各写一份 —— 两处若分叉就会出现「换了腿却不反解」的静默错值。
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {number} UTC 毫秒；日期非法 ⇒ NaN
 */
function closeCoverUtcMs(dateStr) {
  if (!dateStr) return NaN;
  const base = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(base)) return NaN;
  return base + (CLOSE_COVER_HOUR_BJ - 8) * 3600000;
}


// ────── bidding-auto-fetch/logic/extras-workflow.js ──────
// extras-workflow.js — 「竞价四要素」补漏（runAuctionExtrasPatch）
//
// 【为什么要单独一个补漏任务 / 2026-09-11 取证结论】
//   竞价四要素 = 未匹配量(um_vol) / 抢筹幅度(open_bid_pct) / 竞价量比(auc_vol_ratio) /
//               真换手率(auc_turnover)，是趋势图右侧与「量比抢筹高光」的核心判据。
//
//   ✅ [EXTRAS-TRUTH 2026-11-05 / 用户 2026-11-06 再次强调] 旧结论「猫抓对当日行
//      **永远不返回**四要素、必须等结算」**已被实证推翻**，⛔ 不要拿它当事实：
//      11-05 09:25 那轮 `numcat 返回 fields=[..., "auc_vol_ratio","auc_turnover"] items=290 行`，
//      写入的 58 只 58/58 全带竞价量比；11-06 复核 95/95 全带。
//      真实口径是「可能给、也可能不给」（9/11 那天确实 0/67），不是「必然不给」。
//      ⛔ 因此【绝不把四要素就绪当作 9:25 的阻塞条件】——重试只会顶穿 9:26 硬指标。
//
//   本文件仍需要存在，但理由换成【分工 + 历史缺口】，不是「猫抓拿不到」：
//     · 9:25 主流程按当次响应如实写入（有就写、没有就空），只统计不拦截；
//     · 本函数只负责【历史日】回填：那些当天没给四要素、或名单里没抓到的票，
//       由后续窗口的猫抓响应补写；16:00 close 会自动跑一次。
//     · 把「今天」塞进待补集合 = 与 9:25 主流程抢同一批字段 + 白烧 1 次额度，故自动跑排除。
//
// 【触发点】
//   ① 北京 16:00 close 主流程末尾自动跑（复用既有 cron，不需要新增触发器）；
//   ② 手动 /fetch?point=extras（想当天立刻看到 / 补历史缺口时用）。
//
// [QUOTA 2026-09-11 / EXTRAS-TRUTH 2026-11-05] 自动跑时【排除当前交易日】：
//   理由不是「猫抓当天不给四要素」（已推翻），而是 9:25 主流程已经写过一次、
//   两条腿抢同一批字段 + 每天都白烧 1 次额度。实测：9/11 16:00 的补漏 patched=0，
//   而当天 9/11 的四要素依旧是 0/67（查询 market_metrics 证实 updated_by=*-close 48 行全空）。
//   现在只有「确实存在可补的历史缺口」才发 numcat 请求；窗口内全完整 → 零请求直接返回。
//   手动调用传 includeToday:true 可保留「含今天」的旧行为（用于排查）。
//
// 【安全约束（§11 删除安全 / §10 静默失败）】
//   · 只写这几个缺失字段。抹不抹值**不靠 Prefer 偏好**，靠 Data 层按「键集」分桶：
//     同批只装键集完全一致的行 ⇒ 不存在「缺列」⇒ 不会把 volume / change_pct / yest_volume 写成 NULL。
//     ⛔ 别再退回「missing=default」：它的语义是「缺的列取 DEFAULT（通常 NULL）」= 抹值，
//        而 PGRST102 在请求体解析阶段就 400，那条偏好根本来不及生效（2026-11-05 事故）。
//   · 只有「库内该行四要素有缺失」且「numcat 本次给了非空值」才写 → 天然幂等，重复跑零副作用；
//   · 读取失败必须抛错，绝不能被当成「全都缺」而整体覆盖；
//   · 整体失败不致命，调用方 try/catch 后继续。






// ⚠️ 单文件打包（workers/_bundle.mjs）会把所有模块拼进同一个作用域，
//    顶层标识符必须全局唯一 —— 这里一律加 extras 前缀，避免与其它文件重名导致重复声明。
const EXTRAS_FIELDS = ['um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];
// [AUCPCT-BACKFILL 2026-09-14] 补漏字段 = 竞价四要素 + auc_pct_chg（竞价涨幅）。
//   为什么必须把 auc_pct_chg 也算进「缺口」：worker 的【窗口内历史日】行是追溯创建的
//   （新进正式成员当天，顺带回填前几日的影子行）。那一次响应里若 auc_pct_chg 为空，
//   这行就是【永久空洞】——① 前端写不了它（不在 AUCTION_METRICS_FIELDS 白名单）；
//   ② 次日窗口重刷只会用 numcat daily 覆盖 change_pct（收盘涨幅），永远不碰 auc_pct_chg；
//   ③ 结果就是趋势图「五日竞价涨幅」曲线前几腿永久空白（2026-09-14 实测：
//   中新赛克/博敏电子/崇达技术/三孚股份/铭普光磁/九鼎新材/凯盛新能 9/8~9/11 全空）。
//   猫抓对【已结算】的历史日是会返回 auc_pct_chg 的（同一次请求里就有），所以补漏成本为零。
const EXTRAS_PATCH_FIELDS = EXTRAS_FIELDS.concat(['auc_pct_chg']);
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

/** 严格数值化：null / undefined / 空串 → NaN（避免 Number(null)=0 被当成合法 0 值写库） */
function extrasNum(v) {
  if (v === null || v === undefined || String(v).trim() === '') return NaN;
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}

/** 带符号百分比字符串，如 +4.66% / -1.20% */
function extrasFmtSignedPct(v) {
  const n = extrasNum(v);
  return isNaN(n) ? '' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
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
  // [EXTRAS-TRUTH 2026-11-05] 自动跑排除「今天」的真实理由是【分工】，不是「猫抓拿不到」：
  //   猫抓 9:25 就可能给四要素（11-05 实测 58/58 全带 auc_vol_ratio），P0 主流程已经按当次响应
  //   如实写入；本函数只负责历史日回填。把今天塞进来只会两条腿抢同一批字段 + 白烧 1 次额度。
  if (!includeToday) dates = dates.filter(d => d !== today);
  if (dates.length === 0) {
    logs.push('[extras] ✅ 待补窗口内只剩当天（当天由 P0 主流程 / 同花顺快照腿负责）→ 零请求直接返回');
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
      if (EXTRAS_PATCH_FIELDS.some(f => extrasIsEmpty(r[f]))) missingTotal++;
    });
    existing[d] = m;
  }
  logs.push('[extras] 窗口 ' + dates.length + ' 天，库内缺「四要素/竞价涨幅」的行 ' + missingTotal + ' 行');
  if (missingTotal === 0) {
    logs.push('[extras] ✅ 窗口内四要素与竞价涨幅已完整，无需补写');
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
    auc_turnover: fields.indexOf('auc_turnover'),
    auc_pct_chg: fields.indexOf('auc_pct_chg')
  };
  if (symI < 0 || dateI < 0) {
    logs.push('[extras] ❌ numcat 返回字段不完整: ' + JSON.stringify(fields));
    return { ok: false, today, patched: 0, dates: dates, logs, error: '字段不完整' };
  }
  if (EXTRAS_PATCH_FIELDS.some(f => idx[f] < 0)) {
    logs.push('[extras] ⚠️ numcat 本次未返回全部「四要素/竞价涨幅」字段: ' + JSON.stringify(idx));
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
      // [AUCPCT-BACKFILL 2026-09-14] 竞价涨幅：趋势图五日曲线的关键腿，缺了就是永久空白。
      //   只补「库内为空 + 本次有值」；格式与 worker 早盘写入一致（带符号两位小数）。
      if (extrasIsEmpty(cur.auc_pct_chg) && idx.auc_pct_chg >= 0) {
        const v = extrasFmtSignedPct(row[idx.auc_pct_chg]);
        if (v !== '') { patch.auc_pct_chg = v; any = true; }
      }
      if (!any) return;
      patch.source = 'worker';
      patch.updated_at = nowIso;
      patch.updated_by = 'auto-fetch-worker-extras';
      rows.push(patch);
      // 补过之后就地标记，避免同一行被重复写入
      EXTRAS_PATCH_FIELDS.forEach(f => { if (patch[f] !== undefined) cur[f] = patch[f]; });
    });
  });

  if (rows.length === 0) {
    logs.push('[extras] ⚠️ numcat 本次未给出任何可补的「四要素/竞价涨幅」值（当日未结算时属正常，次日窗口重刷会自动补上）');
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
  logs.push('[extras] ✅ 补写 ' + patched + '/' + rows.length + ' 行「四要素/竞价涨幅」');
  return { ok: patched > 0, today, patched: patched, dates: dates, logs };
}

// ============================================================================
// [SNAPSHOT-EXTRAS 2026-09-14] 当日竞价字段补漏（同花顺快照，0 猫抓额度）
//
// 【为什么需要补这一条链路 / 2026-09-14 事故】
//   9:25 早盘 worker 从猫抓 daily_auc 写入 market_metrics 时，【当天】这一行的
//   auc_pct_chg / auc_vol_ratio / auc_turnover **可能**拿不到 —— 取决于那天猫抓接口给不给。
//   2026-09-14 当时是拿不到（当天三个字段整日为空）；2026-11-05 实测则是 58/58 全带量比。
//   但 runAuctionExtrasPatch 默认又【排除今天】⇒ 一旦那天真的没给，就两头一夹 →
//   当天这三个字段整天为空 → 看板「题材 toggle」里每只股票的趋势图竞价涨幅是空的、
//   展开面板的「竞价量比/真换手率」也没有、龙一/龙二徽章全部掉色、
//   竞价一字板判不出实心红线（用户 2026-09-14 反馈）。
//   同花顺 auction/snapshot 在 9:25 竞价结束后就能给【当天】终态值（免费、不限量）→ 用它补。
//   ⚠️ [EXTRAS-TRUTH 2026-11-05] 别再把「猫抓当日不给」当成必然；它只是「可能不给」。
//      这条链路的定位也从「每天都得靠它」降级为「猫抓那天没给时的兜底」。
//
// 【安全约束】
//   · 只补 3 个字段（auc_pct_chg / auc_turnover / volume），且只写「库内为空/0」的行；
//   · ⛔⛔ **auc_vol_ratio（竞价量比）永不补**：只认猫抓 daily_auc。同花顺的 auction_volume_ratio
//     与猫爪 auc_vol_ratio 不同源（口径/基准量不同），填进去就是错数据 ——
//     用户 2026-10-26 与 2026-11-04 两次明确口径：「永远不要用同花顺获取数据的竞价量比数据」。
//     前端 ths-today-patch.js 早已按此执行，worker 这条腿曾经漏掉，现已删除（见下方写入段）。
//   · um_vol / open_bid_pct 不在本接口能力内 → 不写（§40 不猜测）；
//   · 写入前必须校验「快照服务端日期 == 目标日」+ data_status=final，否则整体拒绝（避免把上一交易日写到今天）；
//   · 读取失败抛错中断，绝不把「读不到」当成「全都缺」（§10）；
//   · 幂等：重复跑只补仍为空的行，已有值永不覆盖。
// ============================================================================
// ⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04] 本清单里**刻意没有** `auc_vol_ratio`：
//   竞价量比只认猫抓 daily_auc，同花顺永远不许补（详见下方写入段的用户原话与口径说明）。
//   把它从「缺口判据」里也去掉是必需的 —— 否则「只缺量比」的行会被反复选中、每轮白跑一次
//   快照请求，却什么都补不上（静默浪费），日志还会显示「补写 N 行」但其实没写量比。
const SNAPSHOT_FIELDS = ['auc_pct_chg', 'auc_turnover', 'volume'];

/**
 * 用同花顺快照补「当天」竞价字段缺口。
 * @param {object} env
 * @param {{logs?:string[], date?:string}} [opts] date 缺省 = 北京今天（仅供排查时指定）
 * @returns {Promise<{ok:boolean, today:string, patched:number, logs:string[]}>}
 */
async function runTodaySnapshotPatch(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.date || beijingToday();
  logs.push('[snapshot] 当日竞价字段补漏开始 today=' + today);

  // 1) 读库内现状（§10：读取失败必须抛错，不能当成全缺）
  let rows;
  try {
    rows = await readMarketMetricsSnapshotFieldsForDate(env, today);
  } catch (e) {
    logs.push('[snapshot] ❌ 读取 ' + today + ' 失败（中断，避免误覆盖）: ' + e.message);
    return { ok: false, today, patched: 0, logs, error: e.message };
  }
  if (rows.length === 0) {
    logs.push('[snapshot] ⚠️ ' + today + ' 无竞价行（worker 尚未写入？）→ 跳过');
    return { ok: false, today, patched: 0, logs, reason: '无行' };
  }
  // ★ [AUC-VOL-GUARD 2026-11-04] 选行判据也要认「0」：库里 volume='0' 是上游当日未就绪的占位值，
  //   若只按 extrasIsEmpty（空串/null）筛，这些行根本进不了 need ⇒ 永远补不上（今天 25 只就是这样）。
  const volMissingOf = (r) => extrasIsEmpty(r.volume) || Number(r.volume) === 0;
  const need = rows.filter(r =>
    (SNAPSHOT_FIELDS.some(f => f !== 'volume' && extrasIsEmpty(r[f])) || volMissingOf(r)) &&
    /^\d{6}$/.test(r.code)
  );
  logs.push('[snapshot] 行数 ' + rows.length + '，其中缺字段 ' + need.length + ' 行');
  if (need.length === 0) {
    logs.push('[snapshot] ✅ 当日竞价字段已完整，无需补写');
    return { ok: true, today, patched: 0, logs };
  }

  // 2) 一次快照批量拉全（≤100/批）
  let snap;
  try {
    snap = await fetchAuctionSnapshot(env, need.map(r => r.code));
  } catch (e) {
    logs.push('[snapshot] ❌ 快照请求失败: ' + e.message);
    return { ok: false, today, patched: 0, logs, error: e.message };
  }

  // 3) 日期闸门：快照只给「最近一个交易日」，服务端日期 ≠ 目标日 → 整体拒绝写入
  for (let i = 0; i < snap.batches.length; i++) {
    const b = snap.batches[i];
    const ts = Number(b.timestamp);
    if (!isFinite(ts) || ts <= 0) {
      logs.push('[snapshot] ⚠️ 快照缺少可用 timestamp → 拒绝写入（无法确认是哪一天）');
      return { ok: false, today, patched: 0, logs, reason: '无 timestamp' };
    }
    const stampDate = new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
    if (stampDate !== today) {
      logs.push('[snapshot] ⚠️ 快照服务端日期 ' + stampDate + ' ≠ 目标日 ' + today + ' → 拒绝写入（避免写错日）');
      return { ok: false, today, patched: 0, logs, reason: '日期不符' };
    }
    if (b.data_status !== 'final') {
      logs.push('[snapshot] ⚠️ 快照 data_status=' + b.data_status + '（非终态）→ 本次跳过');
      return { ok: false, today, patched: 0, logs, reason: '非终态' };
    }
  }
  const byCode = new Map();
  snap.items.forEach(it => {
    const t = String(it && it.ticker || '').trim();
    if (t && !byCode.has(t)) byCode.set(t, it);
  });

  // 4) 只补「库内为空 + 本次有值」的行
  const nowIso = new Date().toISOString();
  const patchRows = [];
  const seen = new Set();
  for (let i = 0; i < need.length; i++) {
    const r = need[i];
    if (seen.has(r.name)) continue;
    const it = byCode.get(r.code);
    if (!it) continue;
    const patch = {
      date: today, stock: r.name, scope: 'auction', code: r.code,
      source: 'worker', updated_at: nowIso, updated_by: 'auto-fetch-worker-snapshot'
    };
    let any = false;
    if (extrasIsEmpty(r.auc_pct_chg)) {
      const v = extrasFmtSignedPct(it.auction_pct);
      if (v !== '') { patch.auc_pct_chg = v; any = true; }
    }
    // ⛔⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04 用户第 6 次报障] 这里原本有一条
    //   `auc_vol_ratio ← 同花顺 auction_volume_ratio` 的补写，**已删除，永远不许再加回来**。
    //   用户原话：「我都说竞价期间不用同花顺量比，收盘也不要用，我只要猫爪数据接口的竞价量比
    //   数据，这是最权威的…为什么把同花顺的竞价量比填上去呢？这会造成数据错误明白吗？
    //   永远不要用同花顺获取数据的竞价量比数据。」
    //   口径一致性：前端 src/logic/auction/ths-today-patch.js 早在 2026-10-26 就按同一口径
    //   **拒绝**用同花顺补 auc_vol_ratio（那里写着「⛔⛔ 绝对不许」），只有 worker 这条路漏了，
    //   于是一边前端不补、一边后端偷偷补 ⇒ 用户看到的就是「明明说了不要，还是同花顺的数」。
    //   ⇒ 竞价量比唯一来源 = 猫抓 daily_auc 的【9:25 竞价时间段】数据：
    //     9:25 主流程直接写、9:26 名单二次确认补新进票（ladder-recheck.js）、
    //     历史日缺口由 16:30 的 range20-precompute 回填（source='numcat'）。
    //     猫抓 9:25 就给这个字段（11-05 实测 58/58、11-06 复核 95/95），
    //     ⛔ 旧注释说「要等结算后才有」是错的。拿不到就留空，⛔ 绝不拿同花顺顶替。
    if (extrasIsEmpty(r.auc_turnover)) {
      const v = extrasFmt2(extrasNum(it.auction_turnover_pct));
      if (v !== '') { patch.auc_turnover = v; any = true; }
    }
    // ★★ [AUC-VOL-GUARD 2026-11-04 用户报障「竞价量/昨日成交量显示 0 或 -，数据明明有」]
    //   ① 旧判据只看「空」⇒ 库里已经被写成 '0' 的行永远补不上（今天 25 只就是这样卡死的）。
    //      ⇒ 从今以后 '0' 也视为「没有值」（竞价量为 0 万在早盘等同没成交，且必然伴随量比为 0）。
    //   ② 只写 >0 的真值：⛔ 绝不把 0 再写回去（那正是造出假 0 的来源）。
    //   ③ 保留 1 位小数：Math.round(手/100) 会把 <50 手抹成 0（一字板小票常见）。
    const volMissing = extrasIsEmpty(r.volume) || Number(r.volume) === 0;
    if (volMissing) {
      const n = extrasNum(it.auction_volume);
      if (!isNaN(n) && n > 0) {
        patch.volume = String(Math.round((n / 100) * 10) / 10);
        any = true;
      }
    }
    if (!any) continue;
    seen.add(r.name);
    patchRows.push(patch);
  }

  if (patchRows.length === 0) {
    logs.push('[snapshot] ⚠️ 快照未给出任何可补值（当日竞价尚未终态时属正常）');
    return { ok: true, today, patched: 0, logs };
  }

  // 5) 写入（Data 层按「键集」分桶 ⇒ 同批键集一致 ⇒ ⛔ 不会抹掉 change_pct / yest_volume 等）
  //    🔴 2026-11-05 事故：原来整批塞异键集的行 ⇒ PGRST102「All object keys must match」⇒ 27 行全部丢失。
  try {
    await upsertMarketMetrics(env, patchRows);
  } catch (e) {
    logs.push('[snapshot] ❌ 写入失败: ' + e.message);
    return { ok: false, today, patched: 0, logs, error: e.message };
  }
  logs.push('[snapshot] ✅ 补写 ' + patchRows.length + ' 行当日竞价字段（auc_pct_chg/auc_turnover/volume；'
    + '竞价量比按口径不补，只认猫抓）');
  return { ok: true, today, patched: patchRows.length, logs };
}


// ────── bidding-auto-fetch/logic/ladder-heal.js ──────
// ladder-heal.js — 「最近多板 / 883410 成分股」名单源失败时的补救（Logic 层）
//
// ============================================================================
// [P0 2026-11-06 事故] 用户报障「早盘竞价看板最重要的每天股票入口没有票，只有龙头组和观察组」。
//
//   取证（bidding_fetch_log 01:25:35Z / 北京 09:25:35）：
//     ⚠️ 883410 成分股获取失败（已重试）: fuyao ... 错误: Data source unavailable
//     成分股数量: 0（⬇️ 降级模式：名单源不可用）
//     步骤2：⬇️ 降级模式 → 跳过 auction_watchlist 名单落库（避免写入残缺名单）
//   ⇒ 当天 auction_watchlist 只剩 17 行前端观察组壳行（obs_auto_added=true，前端明确不算正式成员），
//     market_metrics 却有 78 行 ⇒ 「数据在库里、列表里一只票都没有」。
//
//   根因不是数据源冲突，也不是前一天的改动，而是 2026-09-15 那条降级保护：
//     当时为了修「名单源 429 → 整轮 return → 三张表全空」，改成「降级也继续抓行情」，
//     顺手加了「降级时绝不写 auction_watchlist」。它保住了竞价数据，却把【常规组】清空。
//     §10 的「读取失败 ≠ 空数据」在这里被反过来用成了「读取失败 ⇒ 名单干脆不写」。
//
//   本模块的口径（两句话）：
//     ① 名单源恢复 ⇒ 写【今天真实 883410 名单】；
//     ② 名单源仍不可用 ⇒ 写【前一交易日正式成员】的兜底名单，并明确标 source='worker-fallback'，
//        同时保留 ladderDegraded=true ⇒ 第一页「最近多板源条数」显示 `--`（可观测，不伪装成 0）。
//     ⛔ 无论哪条路都不写「空名单」，也不把观察组壳行 / 20日补位票 / 标签票当正式成员。
//
//   【成本】0 次猫抓请求；降级时最多 1 次名单源重试；兜底只读已经读过的 Supabase 结果。
//   【时点】runMorning 里的自愈排在 P0/P1/P2/P3 全部落库之后，绝不会顶穿 9:26 硬指标。
// ============================================================================



/** 883410 成分股正常在 55~95 只；少于这个数当成上游返回残缺，⛔ 绝不写进正式名单（§10） */
const MIN_LADDER_ROWS = 30;

/** 兜底名单至少要有这么多正式成员才值得写，否则宁可不写并报警 */
const MIN_FALLBACK_ROWS = 20;

/** 这些 source 不是「最近多板成分股」：20日补位票 / 前端观察组壳行 / 影子行 / 热点票 */
const NON_FORMAL_SOURCES = new Set(['range20', 'manual', 'shadow', 'hot']);

/** 9:25 名单锁定窗口（与 morning-workflow.js#fetchAndWriteWatchlist 同口径，唯一判据） */
function isMorningWindow(nowBj) {
  const mins = nowBj.getUTCHours() * 60 + nowBj.getUTCMinutes();
  return mins >= 9 * 60 + 25 && mins <= 9 * 60 + 40;
}

/**
 * 纯函数：上游名册 → auction_watchlist 行。
 * 过滤无名/非法 code、按 name 去重；source 由调用方给（真实名单 'worker' / 兜底 'worker-fallback'）。
 */
function buildLadderWatchlistRows(ladder, today, nowIso, source) {
  const out = [];
  const seen = new Set();
  (ladder || []).forEach(function (c) {
    if (!c) return;
    const name = String(c.name || '').trim();
    const code = String(c.code || '').trim();
    if (!name || !/^\d{6}$/.test(code) || seen.has(name)) return;
    seen.add(name);
    out.push({
      date: today,
      stock: name,
      code: code,
      source: source || 'worker',
      obs_auto_added: false,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker'
    });
  });
  return out;
}

/**
 * 纯函数：降级兜底名单 = 前一交易日的【正式成员】，排除观察组 / 补位票 / 影子行。
 * ⚠️ 只用已有读取结果（prevRows / todayRows），不额外发请求。
 * ⚠️ 达到 minRows 才返回，否则返回 [] —— 宁可不写，也不写一份残缺名单（§10 宁缺勿错）。
 */
function pickFallbackWatchlistRows(prevRows, today, nowIso, minRows) {
  const isFormal = function (r) {
    if (!r) return false;
    if (r.obs_auto_added) return false;                       // 观察组壳行
    if (NON_FORMAL_SOURCES.has(String(r.source || '').trim())) return false;
    return /^\d{6}$/.test(String(r.code || '').trim());      // 没 code 的行不能当正式成员
  };
  const out = [];
  const seen = new Set();
  (prevRows || []).forEach(function (r) {
    if (!isFormal(r)) return;
    const name = String(r.name || '').trim();
    const code = String(r.code || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      date: today,
      stock: name,
      code: code,
      source: 'worker-fallback',
      obs_auto_added: false,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker'
    });
  });
  const need = minRows === undefined ? MIN_FALLBACK_ROWS : minRows;
  return out.length >= need ? out : [];
}

/**
 * 补写当日正式名单。三种调用方：
 *   · runMorning 末尾（ladderDegraded=true）：先重试名单源，失败才 allowFallback；
 *   · 手动 /fetch?point=ladder：上游恢复后只补名单，⛔ 不重算行情、⛔ 不烧猫抓额度；
 *   · 不允许「读取当日名单失败」时往下写（§10 读取失败 ≠ 空）。
 *
 * @returns {Promise<{ok:boolean,today:string,written:number,recovered:boolean,fallback:boolean,ladderCount:number|null,logs:string[]}>}
 */
async function healLadderWatchlist(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const nowIso = new Date().toISOString();
  const out = {
    ok: false, today: today, written: 0, recovered: false,
    fallback: false, ladderCount: null, logs: logs
  };

  // 1) 当日名单现状（9:25 名单锁定的唯一依据）。读取失败必须停，不许当成空名单继续写。
  let todayRows;
  try {
    todayRows = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder-heal] ❌ 读取当日 auction_watchlist 失败 → 停止补写（避免误覆盖）: ' +
      (e && e.message ? e.message : String(e)));
    return out;
  }
  const officialNames = new Set(todayRows.filter(r => !r.obs_auto_added).map(r => r.name));

  // 2) 重试名单源（降级时这是第二次；手动入口是第一次）
  let ladder = null;
  try {
    const raw = await fetchLadderConstituents(env);
    if (Array.isArray(raw) && raw.length >= MIN_LADDER_ROWS) {
      ladder = raw;
      out.recovered = true;
      out.ladderCount = raw.length;
      logs.push('[ladder-heal] ✅ 883410 名单源恢复，拿到 ' + raw.length + ' 只 → 写入今天真实名单');
    } else {
      logs.push('[ladder-heal] ⚠️ 883410 只返回 ' + (Array.isArray(raw) ? raw.length : 0) +
        ' 只（<' + MIN_LADDER_ROWS + '），视为残缺，不写正式名单');
    }
  } catch (e) {
    logs.push('[ladder-heal] ⚠️ 883410 重试仍失败: ' + (e && e.message ? e.message : String(e)));
  }

  // 3) 真实名单优先；仍失败才用前一交易日正式成员兜底
  let rows;
  if (ladder) {
    rows = buildLadderWatchlistRows(ladder, today, nowIso, 'worker');
  } else if (o.allowFallback) {
    rows = pickFallbackWatchlistRows(o.prevRows, today, nowIso, MIN_FALLBACK_ROWS);
    if (rows.length === 0) {
      logs.push('[ladder-heal] ❌ 前一交易日也没有足量正式成员（<' + MIN_FALLBACK_ROWS +
        ' 只）→ 本次不写名单，保留可观测的降级状态');
      return out;
    }
    out.fallback = true;
    logs.push('[ladder-heal] ⬇️ 名单源仍不可用 → 写入前一交易日正式成员兜底名单 ' + rows.length +
      ' 行（source=worker-fallback，第一页源条数显示 `--`）');
  } else {
    logs.push('[ladder-heal] 名单源未恢复且本次不允许兜底 → 不写任何行（手动补名单请稍后重试）');
    return out;
  }

  // 4) 9:25 名单锁定：窗口外只允许更新已存在的正式成员；
  //    当日正式名单为空 ⇒ 说明 9:25 那轮根本没落库 ⇒ 允许全量补写（2026-09-15 既有口径）。
  const inWin = isMorningWindow(beijingNow());
  if (!inWin && officialNames.size > 0) {
    const before = rows.length;
    rows = rows.filter(r => officialNames.has(r.stock));
    logs.push('[ladder-heal] 非 9:25 窗口：当日名单锁定，只更新已存在的 ' + rows.length +
      ' 行，跳过 ' + (before - rows.length) + ' 只新成分股');
  } else if (!inWin) {
    logs.push('[ladder-heal] 非 9:25 窗口，但当日【正式名单】为空 ⇒ 视为 9:25 未成功，允许全量补写 ' +
      rows.length + ' 行');
  }

  if (rows.length === 0) {
    logs.push('[ladder-heal] 名单锁定后无行可写 → 不写');
    return out;
  }

  try {
    await upsertAuctionWatchlist(env, rows);
  } catch (e) {
    logs.push('[ladder-heal] ❌ 写入 auction_watchlist 失败: ' + (e && e.message ? e.message : String(e)));
    return out;
  }
  out.written = rows.length;
  out.ok = true;
  logs.push('[ladder-heal] ✅ auction_watchlist 写入 ' + rows.length + ' 行（' +
    (out.fallback ? '兜底名单' : '真实 883410 名单') + '）');
  return out;
}


// ────── ../src/logic/auction/limit-up.js ──────
// limit-up.js — 「竞价一字」（竞价涨停）判定（Logic 层，§15 独立业务模块，纯函数无副作用）
//
// 业务口径（2026-09-09 定）：
//   9:25 集合竞价结束时的竞价涨幅（auc_pct_chg）达到该股【涨停幅度】→ 视为「竞价一字」。
//   竞价一字意味着开盘竞价报价就是涨停价，是最强的一字板信号，需要在看板上用红线标出。
//
// 涨停幅度（按板块，A 股现行规则）：
//   - 主板（60 / 00 开头）：10%；ST / *ST 主板：5%
//   - 创业板（300 / 301）与 科创板（688 / 689）：20%（ST 同样 20%）
//   - 北交所（43 / 83 / 87 / 88 / 92 开头）：30%
//   - 代码缺失：按主板 10% 兜底（绝大多数标的所在板块），绝不因为缺代码而漏判/误判为 0。
//
// 容差：涨停价由「前收 × (1+幅度)」四舍五入到分，实际涨幅常见 9.98% / 10.02% / 10.05%，
//       因此判定用 EPS 容差，而不是严格 >= 幅度。

const LIMIT_MAIN = 10;    // 主板
const LIMIT_ST = 5;       // 主板 ST
const LIMIT_GROWTH = 20;  // 创业板 / 科创板
const LIMIT_BJ = 30;      // 北交所
// 四舍五入容差：10.02%、9.98% 都算一字；9.5% 不算
const EPS = 0.15;

/**
 * 竞价涨幅的【物理上界容差】（%）——「坏值闸门」的唯一口径（§6）。
 *
 * 【为什么必须有它 / 2026-10-12 事故】
 *   numcat daily_auc 对个别股票的「昨收」取错了（用了更早一个交易日的收盘价），
 *   算出的竞价涨幅被整体放大。实测 时代万恒（600241）真实竞价 +6.12%，却写成 **+16.74%**。
 *   主板涨停只有 10%，16.74% 物理上不可能；而 isAuctionYiZi 的判据是「pct ≥ 涨停幅度」
 *   ⇒ 16.74% ≥ 10% ⇒ 被误判成【竞价一字】⇒ 题材量比 / 决策看板都当它「买不进」跳过
 *   ⇒ **真龙一被漏选、龙二顶上**（用户 2026-10-12 报障）。
 *
 * 【上界是算出来的，不是拍的】
 *   涨停价 = round(前收 × (1+幅度), 2)，所以涨幅最多比幅度多出「半分钱」的舍入：
 *     超额 ≤ 0.005 / 前收。A 股最低价股约 1 元 ⇒ 超额上界 = 0.5 个百分点。
 *   · 10.03% / 10.04%（真实一字，实测）→ 不越界 ✅
 *   · 16.74% / 20.99%（numcat 坏值）    → 越界 ✅
 *
 * ⛔ 这不是「猜值」：越界只说明【这个数一定是错的】，而不是「我认为它应该是多少」，
 *    所以越界一律【丢弃 / 不用它下结论】，绝不用一个猜测值顶替（§10 宁缺勿错）。
 */
const AUCPCT_MAX_ROUND_OVER = 0.5;

// ── 板块识别（2026-09-21 新增）──────────────────────────────────────────────
// ⚠️ 唯一真相：代码前缀 → 板块。下面 getLimitUpPct 与 isHighLimitBoard 共用这一份表，
//    ⛔ 任何地方都不要再手写一遍 /^(30|68)/ 这类前缀（§6 两套口径必然分叉）。
// 前缀顺序与改造前 getLimitUpPct 里的判断顺序【逐条一致】，因此改造前后幅度判定 100% 等价。
const BOARD_BJ = 'bj';         // 北交所：43 / 83 / 87 / 88 / 92 → 30%
const BOARD_STAR = 'star';     // 科创板：688 / 689（68 段目前只有科创板）→ 20%
const BOARD_GROWTH = 'growth'; // 创业板：300 / 301（30 段目前只有创业板）→ 20%
const BOARD_MAIN = 'main';     // 沪主板 60 / 深主板 00 / 01 → 10%（ST 5%）
const BOARD_UNKNOWN = '';      // 代码缺失或不在以上任何段 → 不猜（§40）

/**
 * 股票代码 → 板块。只做纯字符串判定，不做任何请求。
 * @param {string} code 6 位股票代码（可为空 / 可带非数字）
 * @returns {string} BOARD_* 之一；代码缺失 → BOARD_UNKNOWN（⛔ 绝不猜成主板，§40）
 */
function getBoardKind(code) {
    const c = String(code || '').replace(/\D/g, '');
    if (!c) return BOARD_UNKNOWN;
    if (/^(43|83|87|88|92)/.test(c)) return BOARD_BJ;
    if (/^68/.test(c)) return BOARD_STAR;
    if (/^30/.test(c)) return BOARD_GROWTH;
    if (/^(60|00|01)/.test(c)) return BOARD_MAIN;
    return BOARD_UNKNOWN;
}

/**
 * 【涨跌幅放开板】判定：科创板（688/689）/ 创业板（300/301）/ 北交所（43/83/87/88/92）。
 *
 * 用途（2026-09-21 用户要求）：早盘竞价列表把这类股票的【名字画浅灰色删除线】，
 *   一眼看出「这不是普通 10% 主板的票」—— 这三档涨跌幅是 20% / 30%，且都需额外交易权限，
 *   没权限的买不了、有权限的也要按另一套涨跌幅判断，最容易误买。
 *
 * ⚠️ 判据是【板块】，不是「涨跌幅 ≠ 10%」：主板 ST（5%）同样是「≠10%」，但不在需求范围内，
 *    故刻意不含它 —— 用 getLimitUpPct 反推会把 ST 全标上，那是错的范围。
 * ⚠️ 代码缺失 → false（不标）。宁可漏标，也不在没代码时凭股票名猜（§40）。
 *
 * @param {string} code 6 位股票代码
 * @returns {boolean}
 */
function isHighLimitBoard(code) {
    const k = getBoardKind(code);
    return k === BOARD_STAR || k === BOARD_GROWTH || k === BOARD_BJ;
}

/**
 * 【纯函数】有没有资格拿「排名类标签」（总龙一~五 / 涨幅前十在列次数）—— 唯一实现（§6）。
 *
 * 用户口径（2026-10-24 逐字）：
 *   「10日涨幅和20日涨幅，非主板的票不做排名，只排主板的，就是我分别单独打开他们的时候，
 *    不要出现排在前十。」
 *   AskUserQuestion 选择：「排序不动，只不占名次」—— 涨幅排序仍是全市场由高到低，
 *   但名次名额只发给主板，创业板/科创板/北交所【跳过且不占位】（名次自动顺延给下一只主板）。
 *   这与 2026-10-07 龙标签的既有口径完全一致：「只排主板的，但是它们的十日涨幅排序不变」。
 *
 * ✅ 有资格：沪主板（60）/ 深主板（00、01）、**代码缺失**。
 * ❌ 无资格：创业板（30）、科创板（68）、北交所（43/83/87/88/92）—— 即 isHighLimitBoard 的全集。
 *
 * §10 红线：代码缺失 ⇒ getBoardKind 返回 BOARD_UNKNOWN ⇒ **算有资格**。
 *   理由（与 dragon-rank.js#isDragonBoardEligible 同一条）：判不出板块 ≠ 判出「不是主板」，
 *   把「没查到」当成「非主板」会静默把一只本该有名次的票踢出前十，那比「多给一次名次」危险得多。
 *
 * ⚠️ 判据只认代码前缀（getBoardKind），⛔ 绝不按股票名猜板块（§40）。
 *
 * @param {string} code 6 位股票代码（缺失 / 空串 = 未知 ⇒ 有资格）
 * @returns {boolean} true = 可以占名次
 */
function isMainBoardRankEligible(code) {
    // isHighLimitBoard 的补集：创业板 / 科创板 / 北交所 = 无资格；主板与「未知」= 有资格。
    return !isHighLimitBoard(code);
}

/** 股票名是否 ST（含 *ST / ST / S*ST 等写法） */
function isStStockName(stockName) {
    if (!stockName) return false;
    return /\*?\s*ST/i.test(String(stockName));
}

/**
 * 取涨停幅度（%）——只依赖代码与股票名，不做任何请求（Data 层职责外的纯计算）。
 * @param {string} code - 6 位股票代码（可为空）
 * @param {string} [stockName] - 股票名（用于 ST 判定）
 * @returns {number} 涨停幅度（%）
 */
function getLimitUpPct(code, stockName) {
    const c = String(code || '').replace(/\D/g, '');
    if (!c) return isStStockName(stockName) ? LIMIT_ST : LIMIT_MAIN;
    // 板块前缀表只在 getBoardKind 里存一份（§6）；这里只做「板块 → 幅度」映射。
    switch (getBoardKind(c)) {
        case BOARD_BJ: return LIMIT_BJ;
        case BOARD_STAR:
        case BOARD_GROWTH: return LIMIT_GROWTH;
        // 主板 + 未知段：改造前这两支完全同码（都是「ST 5% 否则 10%」），行为不变
        default: return isStStockName(stockName) ? LIMIT_ST : LIMIT_MAIN;
    }
}

/**
 * 竞价涨幅是否【物理越界】—— 即「这个数一定是错的」。
 *
 * 判据（唯一实现 §6）：|pct| > 该股涨停幅度 + AUCPCT_MAX_ROUND_OVER。
 * 用途有两处，共用这一份判据，⛔ 不许各写一遍：
 *   ① 前端 isAuctionYiZi —— 越界值【不判一字】（它是坏数据，不是一字）；
 *   ② worker 写库前 —— 越界值【丢弃】（不写进 market_metrics，避免污染趋势图与选股）。
 *
 * §10：缺数据（null / 空串 / 非数）→ **false**。「没读到」与「读到坏值」是两回事，
 *   混用会把「无数据」也当成「坏值」处理，静默丢掉合法数据。
 *
 * ⚠️ 已知的【唯一】假阳性类别（全库 54914 行实测，恰好 6 行，2026-03-06~10-12）：
 *   **新股 / 次新股【上市后前 5 个交易日不设涨跌幅限制】**（全面注册制后主板同样适用）——
 *   这些天生就该超出板块幅度，不是坏值：
 *     长裕集团 603407 05-12 −12.89% / 嘉德利 603435 05-22 +458.38%、05-25 −15.41%
 *     / 惠康科技 001237 05-22 +87.74%、05-25 −11.45% / 托伦斯 301583 07-10 +800.00%
 *   ⇒ 后果：这类票当日**不再被判「竞价一字」**（在此之前它们会被判成买不进而跳过龙位）。
 *   ⇒ 定调：这是**可接受的有界副作用**（7 个月 6 行，且「次新首日涨停」本身没有「一字买不进」
 *     的实盘含义）；换来的是「坏值 ⇒ 成片漏选真龙一」这个**系统性错误**被彻底掐断。
 *     本函数是纯函数、拿不到上市日期，故不做次新豁免（⛔ 不为此引入新的数据依赖，§32/§36）。
 *
 * ⚠️ 两个调用点对「下界」的敏感度不同（不影响正确性，但排查时要知道）：
 *   · isAuctionYiZi 只用【上界】—— 负的越界值本来就不会被判一字；
 *   · worker 写库闸门【上下界都丢】，因为趋势图/徽标展示任何方向的坏值都是错的。
 *
 * @param {number|string|null} pct 竞价涨幅（数字或 '+16.74%' 这类字符串）
 * @param {string} [code] 6 位股票代码（决定涨停幅度）
 * @param {string} [stockName] 股票名（ST 判定用）
 * @returns {boolean} true = 物理不可能，必为坏值
 */
function isAucPctOutOfRange(pct, code, stockName) {
    const n = parseAucPct(pct);
    if (n === null) return false;
    const hi = getLimitUpPct(code, stockName) + AUCPCT_MAX_ROUND_OVER;
    return n > hi || n < -hi;
}

/** 解析竞价涨幅字符串（'+10.02%' / '-7.71%' / 10.02 / null）→ number|null。解析不出来返回 null（绝不退化成 0）。 */
function parseAucPct(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(String(raw).replace('%', '').replace('+', '').trim());
    return isFinite(n) ? n : null;
}

/**
 * 竞价涨幅【展示文本】（与 parseAucPct 配对：一个解析、一个格式化，§6 单一实现）。
 * 口径与早盘竞价看板完全一致：正数补 '+'、固定 2 位小数（如 '+1.20%' / '-2.60%' / '0.00%'）。
 *
 * §10 红线：null / undefined / 非数（= 缺数据）一律返回【空串】，
 *   ⛔ 绝不当成 0 —— 那会把「没查到」画成「平开」。
 * @param {number|string|null} v 竞价涨幅（数字或已解析的字符串）
 * @returns {string} 可展示文本；缺数据 → ''
 */
function formatAucPct(v) {
    const n = parseAucPct(v);
    if (n === null) return '';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

/**
 * 竞价一字判定：竞价涨幅是否达到该股涨停幅度。
 * 无竞价涨幅字段 → false（不做任何猜测，避免把"没数据"显示成一字）。
 *
 * 🔴 [AUC-SANE 2026-10-12 用户口径] 越界值（物理不可能）**一律不判一字**。
 *   用户原话：「把那个时代万恒的竞价涨幅 16.7% 彻底从根源解决掉，这样就不会错误选择
 *   紫竹高科龙二了。导致真的龙一没有被选到。」
 *   背景：numcat 给 时代万恒(600241) 写了个 +16.74%（真实只有 +6.12%，主板涨停 10%），
 *   而旧判据「pct ≥ 涨停幅度」让它命中 ⇒ 被当成【竞价一字·买不进】跳过 ⇒ 真龙一漏选。
 *   ⇒ 现在只认「恰好落在涨停价上」（含四舍五入容差），越界的一律视为坏数据弃权。
 *   ⚠️ 与「缺数据 → false」是【两个不同的弃权理由】，但结论一致且都安全：
 *      它们都**不会**把一个坏值当成「一字」而把真龙一挤掉（§10 不拿坏数据下结论）。
 *   ⛔ 判据只有一处（isAucPctOutOfRange），worker 写库前用的是同一份（§6 单一真相）。
 *
 * @param {object} item - 竞价行（含 stock / auc_pct_chg / code 等）
 * @param {string} [code] - 股票代码；不传则用 item.code
 * @returns {boolean}
 */
function isAuctionYiZi(item, code) {
    if (!item || !item.stock) return false;
    const pct = parseAucPct(item.auc_pct_chg || item.aucPctChg || '');
    if (pct === null) return false;
    const name = String(item.stock).trim();
    const cd = code || item.code || '';
    if (isAucPctOutOfRange(pct, cd, name)) return false;
    return pct + EPS >= getLimitUpPct(cd, name);
}

/**
 * 批量构建「竞价一字」股票名集合（供题材分组排序使用）。
 * @param {object[]} list - 行列表
 * @param {(item:object)=>string} [codeOf] - 取代码函数（缺省用 item.code）
 * @returns {Set<string>} 一字股名称集合（trim）
 */
function buildYiZiSet(list, codeOf) {
    const set = new Set();
    if (!list || list.length === 0) return set;
    list.forEach(function(it) {
        if (!it || !it.stock) return;
        const name = String(it.stock).trim();
        if (!name) return;
        const cd = codeOf ? codeOf(it) : (it.code || '');
        if (isAuctionYiZi(it, cd)) set.add(name);
    });
    return set;
}

/**
 * 【核心】某个涨幅是否触及该股的涨停 / 跌停（与「这个涨幅是竞价的还是收盘的」无关）。
 *
 * ⚠️ 竞价口径与收盘口径【刻意共用这一个核心】：涨跌停幅度只有一份口径（§6），
 *    改一处两边同时生效；分成两份迟早会分叉（2026-09-22「涨跌停」看板要用竞价口径时验证过）。
 *
 * @param {*} pct 涨幅：number 或 '+9.98%' 这类字符串
 * @param {string} [code] 6 位股票代码（缺省兜底主板 10%）
 * @param {string} [stockName] 股票名（用于 ST 判定）
 * @returns {'up'|'down'|null}
 */
function getLimitStateByPct(pct, code, stockName) {
    const n = (typeof pct === 'number')
        ? (isFinite(pct) ? pct : null)
        : parseAucPct(pct);
    if (n === null) return null;
    const limit = getLimitUpPct(code, stockName);
    if (n + EPS >= limit) return 'up';
    if (n - EPS <= -limit) return 'down';
    return null;
}

/**
 * 【竞价】涨停 / 跌停判定（2026-09-22 新增，「涨跌停」看板用）。
 *
 * 判据 = 9:25 集合竞价的涨幅（auc_pct_chg）是否打在该股的涨跌停价上：
 *   · 'up'   → 竞价就涨停（含「竞价一字」这类一字板）
 *   · 'down' → 竞价就跌停
 *   · null   → 都没触及，**或没有竞价涨幅数据**（⛔ 绝不退化成 'up'/'down'，§10）
 *
 * @param {*} aucPct 竞价涨幅：number 或 '+10.02%' / '-9.97%' 这类字符串
 * @param {string} [code] 6 位股票代码
 * @param {string} [stockName] 股票名（用于 ST 判定）
 * @returns {'up'|'down'|null}
 */
function getAuctionLimitState(aucPct, code, stockName) {
    return getLimitStateByPct(aucPct, code, stockName);
}

/**
 * 【收盘】涨停 / 跌停判定（2026-09-11 新增，用于「收盘停板」蚂蚁线标记与同题材统计）。
 *
 * 与 isAuctionYiZi（竞价口径）严格区分：本函数只看【收盘涨幅】。
 *   · 竞价一字 = 9:25 竞价报价就打在涨停价上（实线红线，盘中信号）；
 *   · 收盘涨停 = 全天走完后收在涨停价（红色蚂蚁线，收盘结果）。
 * 两者可以同时成立（竞价一字往往收在涨停），视觉上由调用方决定优先级，本模块只出判定。
 *
 * 涨停幅度复用 getLimitUpPct（按板块/ST），容差同样复用 EPS：
 *   收盘涨停：pct + EPS >= +幅度（涨停价四舍五入到分 → 实测 +9.88% / +9.97% 都算涨停）
 *   收盘跌停：pct - EPS <= -幅度（跌停同理，实测 -9.97% 算跌停）
 *
 * @param {*} closePct - 收盘涨幅：number 或 '+9.98%' / '-9.97%' 这类字符串
 * @param {string} [code] - 6 位股票代码（缺省兜底主板 10%）
 * @param {string} [stockName] - 股票名（用于 ST 判定）
 * @returns {'up'|'down'|null} 'up'=收盘涨停 / 'down'=收盘跌停 / null=都不是或没有涨幅数据
 *          ⚠️ 无数据一律返回 null，绝不把「没数据」当成「没涨停」以外的任何东西（§10）。
 */
function getCloseLimitState(closePct, code, stockName) {
    return getLimitStateByPct(closePct, code, stockName);
}

/**
 * 【收盘】股票名字体颜色档位（2026-09-11 新增）。
 *
 * 需求：收盘涨幅 > 0 → 股票名红色；< 0 → 绿色；= 0 → 保持默认色（黑）；
 *      早盘一律默认色（此时 change_pct 只是 9:25 竞价副本，不是收盘结果）。
 * 与 getCloseLimitState（是否停板）是两件事：本函数只表「涨跌方向」，不看幅度阈值。
 *
 * ⚠️ 【闸门内置、缺省即不上色】—— 这是刻意的安全设计：
 *    闸门条件（题材模式 + 该日已是收盘口径）必须写在函数里，而不是靠每个调用方记得加 if。
 *    ctx 缺失 / byTopic=false / closeWindow=false 一律返回 null → 保持默认黑。
 *    这样「忘了传 ctx」的后果是「不上色」（安全方向），绝不会变成「用竞价副本冒充收盘结果」。
 *    closeWindow = isAuthoritativeCloseReached(date)（北京 16:05 起才为 true）。
 *
 * ⚠️ 无数据（null / '' / 非数）同样返回 null，绝不把「没数据」着色（§10）。
 *
 * @param {*} closePct - 收盘涨幅：number 或 '+1.23%' / '-2.34%' 这类字符串
 * @param {{byTopic?:boolean, closeWindow?:boolean}} ctx - 显示闸门；缺任一项 → null
 * @returns {'up'|'down'|null} 'up'=红（涨）/ 'down'=绿（跌）/ null=默认色（平盘 / 无数据 / 未到收盘口径）
 */
function getCloseNameTone(closePct, ctx) {
    if (!ctx || !ctx.byTopic || !ctx.closeWindow) return null;
    const pct = (typeof closePct === 'number')
        ? (isFinite(closePct) ? closePct : null)
        : parseAucPct(closePct);
    if (pct === null || pct === 0) return null;
    return pct > 0 ? 'up' : 'down';
}


// ────── bidding-auto-fetch/logic/morning-workflow.js ──────
// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为若干子函数）

// [TRADING-DAY 2026-09-29] 交易日判定不再各写各的：统一走 _shared-source/trading-day.js。
//   它把「用户在前端顶栏标的假期（Supabase 覆盖表）」放在最高优先级，其次才周末 / fuyao 日历 / 硬编码表。



// [KEY-FALLBACK 2026-09-28] configuredKeys/maskKey 只用于把「key 候选链」回显到日志：
//   小号 Secret 没配时兜底会静默失效，必须在日志里一眼看见（§10 禁止静默失败）。



// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏。早盘放在【最后】跑一次（不阻塞 P0/P1/P2）：
// 猫抓当日行给不给四要素由接口决定（09-11 那天没给，11-05 那天 58/58 全给）——
// P0 写入时已按当次响应如实落库，所以这里通常零请求返回；
// 真正的兜底是 16:00 close 与次日窗口重刷。

// [LADDER-FALLBACK 2026-11-06] 883410 名单源失败 ⇒ 常规组一只票都没有（P0）。
//   降级不再「干脆不写名单」，改为末尾自愈：重试拿真实名单 / 仍失败写前一日正式成员兜底。

// [PLAN-A 2026-09-10] 区间涨幅口径复用前端同一份纯函数（单一真相 §6）：
// 窗口天数 / 复利累乘 / T 腿竞价占位判定 全部只此一份，前后端不会算出两个结果。
// ⚠️ 跨目录引用会让 workers/_bundle.mjs 把该文件一并打进单文件产物（Cloudflare 复制粘贴部署），
//    因此 src/logic/auction/range-window.js 必须保持「零 import 的纯函数」，不得引入 Vue / DOM 依赖。

// [AUC-SANE 2026-10-12 用户口径] 竞价涨幅【物理越界】闸门 —— 唯一实现在 limit-up.js（§6），
//   前端 isAuctionYiZi 用的是同一份判据。本文件只负责「写入前丢了它」。
//   为什么必须放在 worker（用户原话：「直接改上游自动获取数据那里…彻底从根源解决掉」）：
//     numcat 偶尔把「昨收」取错一个交易日 ⇒ 竞价涨幅被整体放大（时代万恒 真值 +6.12% 被写成 +16.74%）
//     ⇒ 前端按「≥ 涨停幅度即一字」判成【竞价一字·买不进】⇒ 真龙一被跳过、龙二顶替。
//   闸门只管一件事：**物理不可能的值绝不落库**（丢弃 + 告警），值本身不猜（§10）。

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

// ============================================================================
// [LATENCY 2026-09-30] P0 硬截止 —— 「等到什么时候就必须收手」
// ----------------------------------------------------------------------------
// 事故：2026-09-30 早盘竞价看板 9:26 打开时当天数据全空，9:30 才出现。
// 取证（Supabase 落库时间戳，北京时间）：
//     · auction_watchlist 当日 39 行 created_at = 09:29:44.090（== 本轮 nowIso，即 P0-① 结束）
//     · market_metrics  当日 60 行 created_at = 09:29:46.022（== P0-③ 落库）
//   ⇒ cron 09:25:00 → P0-① 结束共 **284 秒**；而 P0-②③/P1/P2 的全部写库只用了 **2.08 秒**。
//   慢的不是计算，是 P0-① 里的上游请求挂起（两个 fuyao 调用原本没有超时，见 fuyao-api.js）。
//
// 同类顶穿并非孤例（market_metrics 当天首行落库时刻）：
//   9/10 09:26:18 ｜ 9/11 09:29:56 ｜ 9/17 09:26:08 ｜ 9/28 09:30:24 ｜ 9/30 09:29:46
//
// 结构性根因：整条链路**没有截止时间** —— 任何一步（含重试退避）都可以无限往后推。
// 因此这里给 P0（今天的数据）一个绝对上限：到点就用手上已有的数据落库，
// 宁可少等一轮重试，也不许看板空白到 9:30。
//
// 预算（09:25:00 触发）：checkTradingDay + P0-① 约 ≤21s，P0-② 受此截止约束，P0-③ ≤2s
//   ⇒ 最坏 09:25:45 前落库，给 9:26 留足余量。
// ============================================================================
const P0_DEADLINE_BJ_SEC = 9 * 3600 + 25 * 60 + 45;   // 09:25:45
const P0_DEADLINE_LABEL = '09:25:45';
/** 当前北京时间的「当日秒数」（0~86399）。beijingNow() 已做 +8h 位移，故取 UTC 分量 */
function bjSecondsOfDay() {
  const d = beijingNow();
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}
/** 距离 P0 截止还剩多少毫秒（负数 = 已超时） */
function p0DeadlineLeftMs() {
  return (P0_DEADLINE_BJ_SEC - bjSecondsOfDay()) * 1000;
}
/** 北京时钟 HH:MM:SS，仅用于把埋点写得可读（落库日志里不必再自己换算 UTC） */
function bjClock() {
  const d = beijingNow();
  return String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(d.getUTCMinutes()).padStart(2, '0') + ':' +
    String(d.getUTCSeconds()).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 单次 runMorning 内的轻量 memo：消除「同一份数据被串行请求 3~4 次」
// ---------------------------------------------------------------------------
function createRunCache() {
  return { _tdAll: null, _tdPending: null, _fuyaoDates: null };
}

/** 取截止 today（含）最近 n 个交易日。整轮只发一次交易日历请求（失败抛错时返回 []） */
async function recentTradingDays(cache, env, today, n) {
  if (!cache._tdPending) {
    cache._tdPending = (async function () {
      // [LATENCY 2026-09-30] checkTradingDay 已经取过一次 fuyao 日历 → 直接复用，
      //   不再重复请求（§32 禁止无意义请求；也把 P0-① 的最坏耗时砍掉一轮 5s）。
      //   ⚠️ 只在「确实拿到过日历」时复用；拿不到仍然回退 getRecentTradingDays 的本地推算。
      if (cache._fuyaoDates && cache._fuyaoDates.length > 0) {
        const upToToday = cache._fuyaoDates.filter(function (d) { return d <= today; });
        if (upToToday.length > 0) return upToToday;
      }
      return await getRecentTradingDays(env, today, RANGE_DAYS);
    })().catch(function (e) {
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
//
//   🔴 [EXTRAS-TRUTH 2026-11-05] 下面这条老结论已作废，别再照它推：
//      「猫抓 daily_auc 对当日这一行不返回这四个字段」 —— **不成立**。
//      2026-11-05 生产实测：`numcat 返回 fields=[..., "auc_vol_ratio","auc_turnover"] items=290 行`，
//      9:25 写入的 58 只 **58/58 全部带 auc_vol_ratio**。
//      2026-09-11 当时观测到的 0/67 是**那天的接口响应就没带这些字段**（`hasFields=false`），
//      属于接口侧当时的行为，不能推广成「猫抓对当日永远不给」。
//
//   ⚠️ 但有一条**永远成立**的约束，改代码时别推翻它：
//      ⛔ 不许把「四要素是否就绪」当成 9:25 的**阻塞条件**。
//         行为不可控（接口可能某天就不给），而等它必然顶穿 9:26 硬指标；
//         判据只能是「今天这个日期出现没」。见 fetchNumcatWithRetry 里那段注释。
//   ✅ 正确做法就是现在的写法：**有就写、没有就空着**。
//      写入路径直接用 `fields.indexOf('auc_vol_ratio')`（见下方 metric 组装），
//      与 todayAuctionExtras 的统计结果**无耦合**；后者只用于打日志和回报，从不参与拦截。
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
// [TRADING-DAY 2026-09-29] 原实现是 `isWeekend(today) || !localIsTradingDay(today)` —— 只看
//   workers/_shared-source/holidays.js 的硬编码表，连 fuyao 都不看。三个已发生的后果：
//     ① 用户在前端顶栏标红的假期（只存在浏览器 localStorage）对 worker 【零影响】；
//     ② 硬编码表漏了 9/25（中秋）→ 把休市日当交易日跑整轮，写出脏名单并把 9/25 算进
//        「最近交易日」窗口 → 9/28 的 prevDay 错位；
//     ③ 硬编码表多了 10/08 → 开市日被判「非交易日」→ 早盘 + 收盘两轮【整轮 skip】，
//        当天四个趋势图与十日涨幅全空。
//   现在改为三源合并（用户覆盖表 > 周末 > fuyao 日历 > 硬编码表），语义见 trading-day.js 文件头。
// [LATENCY 2026-09-30] 多接一个 cache 参数：把这里取到的 fuyao 日历顺手存进本轮 memo，
//   P0-① 的 recentTradingDays 直接复用，省掉一次上游请求（也少一次可能挂起的机会）。
async function checkTradingDay(env, today, cache, logs) {
  let fuyaoDates = null;
  try {
    fuyaoDates = await fuyaoCalendarTradingDays(env);
    if (cache && fuyaoDates && fuyaoDates.length > 0) cache._fuyaoDates = fuyaoDates;
  } catch (e) {
    // §10：拿不到日历 ≠ 今天不是交易日 —— 该层弃权，继续用「用户设置 / 硬编码表」判。
    logs.push('⚠️ fuyao 交易日历不可用（该层弃权，改用用户设置 / 硬编码表判定）: ' + (e && e.message));
  }
  const ok = await resolveIsTradingDay(
    env,
    CONFIG.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY,
    today,
    fuyaoDates,
    logs
  );
  if (!ok) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }
  return null;
}

/**
 * [RANGE20-FETCH 2026-11-05 用户口径] 「20日涨幅补位票」并入 9:25 抓取名单的只数。
 *
 * 用户原话（本轮）：「我不是让你把 20 日补票放进 worker 吗？这样不是更方便，怎么又没有竞价量比了呢？
 *   也就是和那些最近多板源一起用猫抓数据接口一起获取，也是消耗一个额度。但前提是先要算出 20 日涨幅，
 *   算出排名后，统一获取就可以了。这是逻辑和常识啊」。
 *
 * ⇒ 完全成立：猫抓 `daily_auc` 一次请求一批 symbols，**额度按请求次数算、不按股票数算**，
 *   所以名单里多这 25 只 → 0 额外额度（只是同一次请求里多 25 个 symbol）。
 *
 * 取 25 只（不是 5 只）的理由 —— 前端三处用量的最大值是 10，再留余量吸收「昨日榜 → 今日榜」的换血：
 *   · 展示用前五       `RANGE20_LEADER_TOP_N = 5`   （20日涨幅 toggle / 补位区块 / 总龙一~五）
 *   · 宽口径前八       `RANGE20_LEADER_WIDE_N = 8`  （退潮买点候补）
 *   · 题材榜前十       `RANGE20_MAIN_TOP_N = 10`    （题材量比「候补」规则）
 *   · 前端自己的粗筛池 `RANGE20_LEADER_PRESELECT = 25` ← 本常量取同一个数，口径对齐
 *   实测（11-05 回放）：取前 5 只覆盖缺量比 3/28，前 20 覆盖 10/28，前 25 覆盖 13/28。
 *
 * ⚠️ 口径：用【前一交易日】完整榜（当天榜要等收盘后才算出来 —— 11-05 实测 79 行全部 16:38 写入，
 *    9:25 时一行都没有）。这天然自愈，但要接受一个【结构性一天延迟】：
 *    今天才涨进前 N 的票，今天 9:25 不可能预知，明天 9:25 才落在「昨日完整榜」里被抓到。
 *    11-05 回放里 28 只缺量比中有 10 只属于这种「今日新进榜」，任何「截至昨收」的排名都算不出来。
 */
const RANGE20_FETCH_TOP_N = 25;

// 2. 获取最近多板成分股 + 写入 auction_watchlist
// [LATENCY 2026-09-11] 原来这一步是 9 次串行网络调用（≈11.6s），现改为 3 组并行（≈3s）：
//   组A：成分股 ∥ 代码表 ∥ 交易日历       ← 三者互不依赖
//   组B：前日名单 ∥ 今日名单 ∥ 前日标签 ∥ 前日龙头 ∥ 前日20日涨幅榜  ← 只依赖组A的交易日历
//   组C：仅对「仍缺 code 的名字」做一次按名精确补码（通常 0 次或 1 次小请求）
async function fetchAndWriteWatchlist(env, today, cache, logs) {
  logs.push('步骤1：并行获取 成分股 / 代码表 / 交易日历...');
  const [ladderRes, codeMapRes, tdRes] = await Promise.all([
    settled(fetchLadderConstituents(env)),
    settled(readStockCodeMap(env)),
    settled(recentTradingDays(cache, env, today, 2))
  ]);

  // [DEGRADE 2026-09-15] 名单源（883410 成分股）失败【绝不】中断整轮早盘抓取。
  //
  //   事故（2026-09-15）：9:25 那一轮，本请求撞上 fuyao `429 Global request rate limit exceeded`，
  //   旧代码 `return { error }` → runMorning 直接返回 → auction_watchlist / market_metrics /
  //   stock_range_pct **一张表都没写** → 用户 9:25~9:39 看板「第一页全空、无法买卖操作」。
  //
  //   新行为：降级为「前一日名单 ∪ 打标签股票 ∪ 龙头名册」（三者都来自 Supabase，不依赖 fuyao）
  //   继续跑完 P0-②③ / P1 / P2，保证【当天的竞价数据仍能落库】——看板不空白是最高优先级。
  //   ⚠️ [LADDER-FALLBACK 2026-11-06] 降级时本步不写 auction_watchlist（不伪造残缺名册），
  //      但【整轮末尾必须补名单】：重试真实 883410，仍失败则写明确标注的前一日正式成员兜底。
  //      旧实现「降级就整轮不写名单」会让常规组全空，是最重要数据入口的 P0 事故。
  let ladderDegraded = false;
  const ladderConstituents = ladderRes.ok ? (ladderRes.v || []) : [];
  if (!ladderRes.ok) {
    ladderDegraded = true;
    // [RETRY-CLASSIFY 2026-11-06] 旧文案写死「（已重试）」是**假日志**：11-06 的
    //   `Data source unavailable` 被旧正则判成不可重试，第 1 次就 break，根本没重试过。
    //   现在是否重试由 data/fuyao-api.js#isRetriableFuyaoError 决定，那里会打印真实结论；
    //   这里只如实记「失败」，⛔ 不替上游声明做过没做过的事（§10 可观测性）。
    logs.push('⚠️ 883410 成分股获取失败: ' + ladderRes.e.message +
      ' → 【降级】改用「前一日名单 ∪ 打标签 ∪ 龙头名册」继续抓取，不中断整轮早盘流程');
  }
  logs.push('成分股数量: ' + ladderConstituents.length + (ladderDegraded ? '（⬇️ 降级模式：名单源不可用）' : ''));
  // [LADDER-SRC 2026-11-03 用户口径] 把「同花顺最近多板(883410) 源数据条数」抽成【结构化字段】带走。
  //   用户要拿它对齐炒股软件（原话：「这个才是重点……这个是源数据」）。
  //   ⚠️ 与下方 constituents.length 不是一回事：那个是「前一日名单 ∪ 打标签 ∪ 龙头名册」并进来的
  //      【抓取名单】，会比源数据多；源数据只有 ladderConstituents.length 这一个数。
  //   ⚠️ 降级运行（名单源不可用）时它是 0，但那个 0 的含义是「没抓到」⇒ 由 ladderDegraded 表达，
  //      前端看到 ladderDegraded=true 就显示 `--` 而不是「0 只」（§10 读失败≠空数据）。
  const ladderCount = ladderConstituents.length;

  const codeMap = (codeMapRes.ok && codeMapRes.v) || {};
  if (!codeMapRes.ok) logs.push('读取 stockcodemap 失败(非致命): ' + codeMapRes.e.message);
  const recentDays = (tdRes.ok && tdRes.v) || [];
  const prevDay = recentDays.length >= 2 ? recentDays[recentDays.length - 2] : null;

  // 组B：名单来源并行（原来串行 3 次 + 中间夹着 2 次重复的代码表读取）
  logs.push('步骤1b：并行读取 前日名单 / 今日名单 / 前日标签 / 前日龙头 / 20日涨幅榜...');
  const [prevWlRes, todayWlRes, tagRes, dragonRes, range20Res] = await Promise.all([
    settled(prevDay ? readAuctionWatchlistForDate(env, prevDay) : Promise.resolve([])),
    settled(readAuctionWatchlistForDate(env, today)),
    settled(prevDay ? readAuctionTagsForDate(env, prevDay) : Promise.resolve([])),
    // [DRAGON-GROUP 2026-09-14] 前一交易日评选出的龙头名册（供「龙头组数据完整获取」，需求 2）
    settled(prevDay ? readDragonLeadersForDate(env, prevDay) : Promise.resolve([])),
    // [RANGE20-FETCH 2026-11-05] 前一交易日的 20 日涨幅榜（供「20日补位组」数据完整获取）。
    //   放进组B 并行，是为了【不增加任何额外延迟】—— 它和上面 4 个读互不依赖。
    settled(prevDay ? readRange20TopForDate(env, prevDay, RANGE20_FETCH_TOP_N) : Promise.resolve([]))
  ]);
  // 20日补位候选：只有名字+涨幅，code 由下方 codeMap / 按名补码 两路补（该表没有 code 列）
  const range20Stocks = (range20Res.ok && range20Res.v) || [];
  if (range20Res.e) logs.push('读取 20 日涨幅榜失败(非致命): ' + range20Res.e.message);

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
  const dragonStocks = (dragonRes.ok && dragonRes.v) || [];
  if (dragonRes.e) logs.push('读取前一交易日龙头名册失败(非致命): ' + dragonRes.e.message);
  const nameless = todayStocks.concat(prevWlRes.ok && prevWlRes.v ? prevWlRes.v : [])
    .concat(dragonStocks)
    // [RANGE20-FETCH 2026-11-05] 20日涨幅榜只有名字（表内无 code 列），且这些票
    //   **恰好最容易不在 stockcodemap 里**（它们多半不在 883410 成分股内）。
    //   不放进这里按名补码 ⇒ 下方 `if (!code) return` 会把它们整批丢掉，等于没做。
    .concat(range20Stocks)
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

  // [DRAGON-GROUP 2026-09-14] 合并「前一交易日评选出的龙头」到抓取名单（需求 2：龙头组数据要像正式列表一样
  // 自动、完整获取）。放在组C【之后】执行：此时 codeMap 已被按名补码增强，龙头最不容易因缺 code 被漏掉。
  // 与打标签股票同一处理：只并入 constituents（= market_metrics 抓取名单），不写 auction_watchlist
  // → 不破坏「当日名单 = 9:25 快照」的锁定口径（§6）。
  //
  // ⚠️ 为什么必须并入：龙头可能「昨日在正式列表、今日不在」（需求 4）—— 它不在今天的成分股里，
  //    若不并入，9:25 就不会为它抓当天行情 → 龙头组区块显示空白。名册由前端评选落库（逻辑唯一真相 §6）。
  if (dragonStocks.length > 0) {
    const existingNames = new Set(constituents.map(c => c.name));
    const existingCodes = new Set(constituents.map(c => c.code));
    const dragonExtra = [];
    dragonStocks.forEach(function (d) {
      if (!d || !d.name || existingNames.has(d.name)) return;
      const code = d.code || codeMap[d.name] || '';
      if (!code || existingCodes.has(code)) return;
      existingNames.add(d.name);
      existingCodes.add(code);
      dragonExtra.push({ name: d.name, code: code });
    });
    if (dragonExtra.length > 0) {
      logs.push('前一交易日(' + prevDay + ')龙头: ' + dragonExtra.length +
        ' 只，合并到抓取名单（不写 watchlist）');
      constituents = constituents.concat(dragonExtra);
    }
  }

  // [RANGE20-FETCH 2026-11-05 用户口径] 合并「20日涨幅补位票」到抓取名单。
  //
  //   为什么必须并入（用户本轮明确指出）：20日补位票是**视图注入壳行**（`*AutoAdded`，不写 watchlist），
  //   如果 9:25 不为它们抓当天行情，它们的 `market_metrics` 行就不存在 ⇒
  //   ① 第一页竞价量整列 `-`；② 竞价量比空 ⇒ 题材平均量比分母缺失；③ 收盘后才补进来的行只有收盘数据。
  //   2026-11-05 实测就是这个形状：86 行里 28 只没量比，28 只全部不是 9:25 那轮写的。
  //
  //   ⛔ 成本 = 0：猫抓 `daily_auc` 一次请求一批 symbols，额度按【请求次数】算。
  //   ⛔ 不写 auction_watchlist：与打标签/龙头同一处理，只并入 constituents，
  //      不破坏「当日名单 = 9:25 快照」的锁定口径（§6）。
  if (range20Stocks.length > 0) {
    const existingNames = new Set(constituents.map(c => c.name));
    const existingCodes = new Set(constituents.map(c => c.code));
    const range20Extra = [];
    range20Stocks.forEach(function (r) {
      if (!r || !r.name || existingNames.has(r.name)) return;
      const code = codeMap[r.name] || '';
      if (!code || existingCodes.has(code)) return;
      existingNames.add(r.name);
      existingCodes.add(code);
      range20Extra.push({ name: r.name, code: code });
    });
    if (range20Extra.length > 0) {
      logs.push('20日涨幅补位(基于 ' + prevDay + ' 完整榜, 前 ' + range20Stocks.length + ' 名): ' +
        range20Extra.length + ' 只，合并到抓取名单（不写 watchlist，0 猫抓额度）');
      constituents = constituents.concat(range20Extra);
    } else {
      logs.push('20日涨幅补位: 榜上前 ' + range20Stocks.length + ' 名均已在抓取名单内（或查不到 code）');
    }
  }

  // [DEGRADE 2026-09-15] 降级后仍要求「有可抓取的标的」，否则整轮无从下手（§10 读失败≠空）
  if (constituents.length === 0) {
    return { error: '抓取名单为空：883410 成分股不可用，且前一日名单/打标签/龙头名册/20日涨幅榜均无可用标的' };
  }

  // [DEGRADE 2026-09-15] 降级时【不在这里】写 auction_watchlist：绝不把残缺名册当 9:25 快照。
  // ⚠️ [LADDER-FALLBACK 2026-11-06] 旧注释在这里写「名单由后续重跑 morning 补写」——**已废弃**：
  //   ① 重跑整轮 morning 会再烧 1 次猫抓额度，还会在开盘后重算行情（口径风险）；
  //   ② 更重要的是：不重跑时，当天的 auction_watchlist 就一直只有观察组壳行 ⇒
  //      常规组【一只票都没有】（11-06 P0 事故，用户原话「这个应用最重要的数据都没有显示出来」）。
  //   ⇒ 现在把「前一日正式成员」作为兜底候选带出去，由 runMorning 末尾的 healLadderWatchlist
  //     先重试真实名单、失败才写兜底（⛔ 不写空名单、不伪造 source）。
  if (ladderDegraded) {
    logs.push('步骤2：⬇️ 降级模式 → 本步跳过名单落库；P0 行情照常落库，末尾统一做名单自愈');
    const fallbackCandidates = (prevWlRes.ok && prevWlRes.v) || [];
    return {
      constituents, watchlistRows: [], nowIso: new Date().toISOString(),
      ladderDegraded: true, ladderCount, fallbackCandidates
    };
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
    // [9:25-LOCK 2026-09-15] 只把【正式成员】当作「名单已存在」。
    //   观察组壳行（obs_auto_added=true，前端打开页面时自己写的 source=manual）必须排除，
    //   否则「9:25 那轮没成功」会被误判成「已成功」→ 重跑时 rowsToWrite 被过滤成 0 行，
    //   名单永远补不回来（2026-09-15 P0 修复现场实测：当日仅有 8 行观察组壳行）。
    let existingNames = new Set(todayStocks.filter(s => !s.obs_auto_added).map(s => s.name));
    if (existingNames.size === 0) {
      logs.push('非 9:25 抓取窗口，但当日【正式名单】为空（观察组壳行不算）→ 视为 9:25 那轮未成功，允许全量写入 ' +
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
  return { constituents, watchlistRows, nowIso, ladderCount };
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
    // [KEY-FALLBACK 2026-09-28] 主账号额度用尽会自动退回小号（见 data/numcat-api.js 文件头）
    numcatData = await numcatDailyAuc(env, symbols, startYMD, endYMD, logs);
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
    //    ⇒ 猫抓 daily_auc 对【当日】这一行的四要素**可能**不给（2026-09-11 那天就是 0/67），
    //      但 **也可能给**（2026-11-05 实测 58/58 全带 auc_vol_ratio）——接口行为不由我们决定。
    //      ⛔ 所以拿它当阻塞条件 = 每天白等 25s，撞上不给的那天还永远等不到，
    //      反而把 P0 落库顶穿 9:26。
    //      ✅ 现在的口径：**有就写、没有就空着**（写入路径与今日无关的字段索引，不做就绪判断）；
    //      缺的部分由 P3 补漏任务负责（runAuctionExtrasPatch）。
    if (missingDates.includes(today)) {
      for (let attempt = 0; attempt < TODAY_RETRY_DELAYS_SEC.length && missingDates.includes(today); attempt++) {
        // [LATENCY 2026-09-30] P0 硬截止：到点就用手上已有的数据落库，绝不再等。
        //   下面是 9/30 事故的正面修复 —— 原来的循环只按「次数」限制，没有时间上限。
        const leftMs = p0DeadlineLeftMs();
        if (leftMs < 1500) {
          logs.push('🛑 已到 P0 截止 ' + P0_DEADLINE_LABEL + '（剩余 ' + Math.round(leftMs) +
            'ms）→ 停止等待今天数据，立即用现有数据落库（不再重试，避免顶穿 9:26）');
          break;
        }
        const waitSec = TODAY_RETRY_DELAYS_SEC[attempt];
        // 退避也不能越过截止时间：宁可缩短等待，也不许把落库推到 9:26 之后
        const waitMs = Math.max(0, Math.min(waitSec * 1000, leftMs - 1500));
        logs.push('⏳ 今天(' + today + ')数据缺失，' + Math.round(waitMs / 1000) + '秒后重试第' + (attempt + 1) +
          '次...（P0 剩余 ' + Math.round(leftMs / 1000) + 's）');
        await new Promise(r => setTimeout(r, waitMs));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD, logs);
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
          // [KEY-FALLBACK 2026-09-28] 主账号 + 小号**都**额度用尽 → 立即停止重试。
          //   重试同样拿不到，而 TODAY_RETRY_DELAYS_SEC 加起来 25s，白等只会顶穿 9:26 硬指标。
          if (e && e.quotaExhausted) {
            logs.push('🛑 所有猫抓 key 当日额度均已用尽 → 不再重试（重试也拿不到，只会白等顶穿 9:26）');
            break;
          }
        }
      }
      if (missingDates.includes(today)) {
        logs.push('❌ 重试后今天(' + today + ')数据仍缺失，本次不会写入今天的 market_metrics，需要手动补抓');
      }
    }
    // 四要素【只统计、不阻塞】。当日为空**不是**猫抓的既定行为（11-05 实测 58/58 都带），
    // 而是「那天接口没给 / 个别票无竞价」，所以这里只如实打一行日志，不做任何拦截；
    // 缺的部分交给 runAuctionExtrasPatch（16:00 close 跑 / 手动 /fetch?point=extras）。
    curExtras = todayAuctionExtras(items, fields, today);
    if (!curExtras.ok) {
      logs.push('ℹ️ 今天(' + today + ')的「竞价四要素」不全（' + curExtras.filled + '/' + curExtras.total +
        ' 只非空' + (curExtras.hasFields ? '' : '，numcat 本次未返回这些字段') +
        '）——只统计不拦截，P0 落库不受影响；' +
        '缺的部分由补漏任务写回（runAuctionExtrasPatch / 次日早盘窗口重刷）。');
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
    // [KEY-FALLBACK 2026-09-28] 同上：主账号额度用尽会自动退回小号
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD, logs);
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
// [AUC-SANE 2026-10-12] 导出仅为单测（纯函数，零网络）：越界闸门必须有回归测试钉住，
//   否则「竞价涨幅越界」这类上游坏值又会被静默写进库（无测试 = 无防线）。
function parseNumcatToMetrics(items, fields, constituents, logs, today) {
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
  // [AUCPCT-GUARD 2026-09-14] auc_pct_chg 缺失以前是【完全静默】的：
  //   pctIdx<0 → changePctStr='' 且 aucPctChgStr='' → 当天 change_pct（=当日竞价副本）
  //   与 auc_pct_chg 一起留空，趋势图「五日竞价涨幅」曲线上出现永久空洞，
  //   而日志里连一行提示都没有（只有四要素那条 ⚠️，不含 auc_pct_chg）。
  //   2026-09-14 实测：新进正式成员 9/8~9/11 的追溯行 auc_pct_chg 全空 → 用户看到前 4 腿空白。
  //   这里必须显式报警（§10 禁止静默失败），补写交给 runAuctionExtrasPatch（已含 auc_pct_chg）。
  if (pctIdx < 0) {
    logs.push('❌ numcat daily_auc 未返回 auc_pct_chg 字段（idx=-1）→ 本次所有行的「竞价涨幅 / 当天 change_pct」' +
      '会一起留空（趋势图五日竞价涨幅曲线出现空洞）。请检查猫抓返回字段是否被上游裁剪；' +
      '缺口由 runAuctionExtrasPatch 在结算后补写（16:00 close 自动跑 / 手动 /fetch?point=extras）。');
  }
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
  // [AUC-VOL-GUARD 2026-11-04] 被判定为「竞价量 0 但量比>0（上游未就绪）」而留空的条数 —— 只用于日志留痕
  let suspiciousVolZero = 0;
  // [AUC-SANE 2026-10-12] 被闸门丢弃的越界竞价涨幅（只登记，真值由 repairOutOfRangeAucPct 补）
  const outOfRange = [];

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
    // ★★ [AUC-VOL-GUARD 2026-11-04 用户报障「竞价量全部显示 0，这是不可能的」]
    //   实测 2026-11-04：47 只名单里 25 只（53%）volume='0'，而同行的 auc_vol_ratio 却是
    //   5.43 / 15.29 / 144.88。**量比 = 竞价量 ÷ 基准量，分子为 0 则量比必为 0** ——
    //   两者同时出现说明上游 numcat 当日 auc_vol 还没结算，返回的是占位 0，
    //   旧代码原样写进库 ⇒ 前端趋势图/竞价量列全是 0，用户据此判断竞价强度会直接判错。
    //   ⇒ 判定为「自相矛盾的 0」时不写数字（留空），让前端显示 '-'/断点（§10 缺值必须可见）。
    //   ⛔ 不是把 0 一律抹掉：量比与占比也都是 0/空 时，0 就是事实，照常写。
    const volNum = Number(aucVol);
    let volumeStr = '';
    if (!isNaN(volNum)) {
      const _ratioPct = ratioIdx >= 0 ? Number(row[ratioIdx]) : NaN;      // auc_to_pre_vol_pct
      const _volRatio = avrIdx >= 0 ? Number(row[avrIdx]) : NaN;          // auc_vol_ratio
      const _contradicts = volNum <= 0
        && ((isFinite(_ratioPct) && _ratioPct > 0) || (isFinite(_volRatio) && _volRatio > 0));
      if (!_contradicts) {
        // 保留 1 位小数：旧写法 Math.round(手/100) 会把 <50 手（0.5 万）抹成 0，
        // 一字板/小盘股的竞价量本来就小，抹成 0 同样会造成「假 0」。
        volumeStr = String(Math.round((volNum / 100) * 10) / 10);
      } else {
        suspiciousVolZero++;
      }
    }

    // changePct = "+X.XX%"
    // [AUC-SANE 2026-10-12] aucRaw 单独留一份【数字】，供下面越界闸门判定；
    //   changePctStr 仍按原口径原样保留（今日 change_pct = 竞价副本，16:00 收盘覆盖）。
    let changePctStr = '';
    let aucRaw = null;
    if (pctIdx >= 0) {
      const pct = row[pctIdx];
      if (pct !== null && pct !== undefined && pct !== '') {
        const n = Number(pct);
        if (!isNaN(n)) {
          changePctStr = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
          aucRaw = n;
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
    //
    // 🔴 [AUC-SANE 2026-10-12] 越界闸门：|竞价涨幅| > 该股涨停幅度 + 0.5 ⇒ 物理不可能，必为坏值。
    //   处理 = **丢弃**（该字段留空，绝不写进库）：留空只让趋势图少一个点，
    //   写进去却会让前端判出【假一字】→ 真龙一被跳过（用户 2026-10-12 实际损失）。
    //   真值由紧随其后的「越界修复」用同花顺快照补（见 repairOutOfRangeAucPct）——
    //   所以这里的留空是【临时】的，不是永久丢数据。
    //   ⛔ 只丢 auc_pct_chg，**不动 change_pct**：那是今日收盘涨幅的占位（竞价副本），
    //     16:00 会被 close-workflow 用真收盘价覆盖，且今日 T 腿在 9:25 走的是竞价口径。
    let aucPctChgStr = changePctStr;
    if (aucRaw !== null && isAucPctOutOfRange(aucRaw, code, stockName)) {
      aucPctChgStr = '';
      outOfRange.push({
        date: dateStr,
        code: code,
        name: stockName,
        pct: aucRaw,
        limit: getLimitUpPct(code, stockName)
      });
    }

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
  // [AUC-VOL-GUARD 2026-11-04] 假 0 必须可见（§10）：上游当日 auc_vol 未结算时会出现
  //   「竞价量 0 但量比>0」的自相矛盾值，上面已留空不写 —— 这里把条数打出来，方便对数。
  if (suspiciousVolZero > 0) {
    logs.push('⚠️ 竞价量异常: ' + suspiciousVolZero + ' 条的 auc_vol=0 但量比>0（上游未就绪），已留空不写 0');
  }
  // [AUC-SANE 2026-10-12] 越界必须【可见】（§10 禁止静默丢弃）：把每只票的「坏值 / 该股涨停上界」都打出来，
  //   排障时一眼看出「是上游错了多少」，不用再去反推。
  if (outOfRange.length > 0) {
    const byDate = {};
    outOfRange.forEach(x => { (byDate[x.date] = byDate[x.date] || []).push(x); });
    Object.keys(byDate).sort().forEach(d => {
      const arr = byDate[d];
      logs.push('🚫 [AUC-SANE] ' + d + ' 有 ' + arr.length + ' 只票的竞价涨幅【物理越界】（超过该股涨停幅度），已丢弃坏值：' +
        arr.map(x => x.name + '(' + (x.pct >= 0 ? '+' : '') + x.pct.toFixed(2) + '%，该股涨停 ' + x.limit + '%)').join('、') +
        (d === today ? '；其中【今天】的会立刻用同花顺快照取真值补回' : '；历史日按 §10 留空（不猜）'));
    });
  }
  return { metricsByDate, parsedCount, yestVolDerivedCount, outOfRange };
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

/**
 * [AUC-SANE 2026-10-12 用户口径] 【越界竞价涨幅】的真值修复（只处理【今天】）。
 *
 * 用户原话：「你要么直接改上游自动获取数据那里，要谨慎改，把那个时代万恒的竞价涨幅 16.7%
 *   彻底从根源解决掉，这样就不会错误选择紫竹高科龙二了。导致真的龙一没有被选到。」
 *
 * 三条链路，复用既有实现、零新增数据源（§6 §32）：
 *   ① 解析时已把越界值【丢弃】（≈库内该字段留空）；
 *   ② 本函数调 runTodaySnapshotPatch —— 那是「同花顺竞价快照补当日字段」的既有唯一实现
 *      （免费、不限次数、自带「服务端日期 == 今天 + data_status=final」双重闸门）；
 *      它只补「库内为空」的字段 ⇒ 恰好只补上被我们丢空的那几个（幂等，绝不覆盖已有值）；
 *   ③ 从库里【重读】这几个字段回内存 metricsByDate ⇒ 紧随其后的区间涨幅(T 腿)用的是真值。
 *   ★ ③ 的入库口径 = **同花顺给什么就写什么**（权威源，即使仍超涨跌停幅度也照写 ——
 *     那只能是新股上市前 5 个交易日不设限，如实入库；详见本函数内 [AUC-SANE-FIX] 注释）。
 *     ⛔ 绝不对权威源的值二次丢弃：那会把【真数据】变成空数据（原实现如此，已纠正）。
 *
 * ⚠️ 为什么必须回内存（而不是只写库就完）：`stock_range_pct` 的 T 腿取自
 *   `metricsByDate[today]` 的 auc_pct_chg（见 buildRangePctRows）。只修库不回内存，
 *   今天的 T 腿依旧是「空」⇒ 该股今天没有十日涨幅 ⇒ 前端 dragon-rank 在早盘
 *   09:00~09:45 有 morningGuard（连本地重算都不跑）⇒ 龙位算不出来 ⇒ **真龙一照样选不到**。
 *
 * ⛔ 放在 P0（今天的 market_metrics）落库【之后】：P0 是 9:26 硬指标的关键路径，
 *    本函数要发一次同花顺请求（慢调用超时 10s），绝不能挡在它前面。
 * ⛔ 整段 try/catch：任何失败都只留日志，最坏结果 = 该字段本次留空
 *    （下一轮 / 16:00 close 的同花顺补漏会再试一次；§10 宁缺勿错），
 *    绝不让「修复失败」演变成「整轮早盘抓取失败」。
 *
 * @param {object} env worker env
 * @param {object} metricsByDate 内存解析结果（会被【就地修改】）
 * @param {string} today 北京今天 YYYY-MM-DD
 * @param {Array<{date:string,code:string,name:string,pct:number}>} outOfRange 越界登记表
 * @param {string[]} logs
 * @returns {Promise<{wanted:number, fixed:number}>} 仅用于结果上报
 */
async function repairOutOfRangeAucPct(env, metricsByDate, today, outOfRange, logs) {
  const list = (outOfRange || []).filter(x => x && x.date === today && /^\d{6}$/.test(String(x.code || '')));
  if (list.length === 0) return { wanted: 0, fixed: 0 };
  try {
    // ② 复用既有同花顺补漏（只补「空」字段 → 只补我们刚丢空的那几个）
    const snap = await runTodaySnapshotPatch(env, { logs: logs });
    if (!snap || !snap.ok || snap.patched === 0) {
      logs.push('[AUC-SANE] ⚠️ 越界真值补写未生效（patched=' + ((snap && snap.patched) || 0) + '）→ ' +
        list.map(x => x.name).join('、') + ' 的竞价涨幅本次留空（§10 不猜值）；' +
        '趋势图该点为空，选股按「无竞价涨幅」处理（不会被误判成一字）');
      return { wanted: list.length, fixed: 0 };
    }
    // ③ 从库重读 → 回内存（只认本次真补上的那些 code）
    const rows = await readMarketMetricsSnapshotFieldsForDate(env, today);
    const byCode = new Map();
    (rows || []).forEach(r => { if (r && r.code) byCode.set(String(r.code).trim(), r); });
    const todayRows = metricsByDate[today] || [];
    const rowByCode = new Map();
    todayRows.forEach(m => { if (m && m.code) rowByCode.set(String(m.code).trim(), m); });
    let fixed = 0;
    const fixedNames = [];
    const stillBad = [];
    const authoritativeOut = [];
    list.forEach(x => {
      const r = byCode.get(String(x.code));
      const v = r ? String(r.auc_pct_chg || '').trim() : '';
      if (!v) { stillBad.push(x.name); return; }
      // 🔴 [AUC-SANE-FIX 2026-10-12] 这里【故意不再】对同花顺的值重复过闸门（原实现见 git 历史）。
      //   理由（全库 54914 行实测）：本闸门唯一的「假阳性」类别 = 新股/次新股【上市后前 5 个交易日
      //   不设涨跌幅限制】（全面注册制后主板同样适用）—— 全库恰好 6 行，全部是真值：
      //     长裕集团 603407 05-12 −12.89%（05-11 首日 +562.63%）
      //     嘉德利   603435 05-22 +458.38% / 05-25 −15.41%（05-22 首日 +710.15%）
      //     惠康科技 001237 05-22 +87.74%  / 05-25 −11.45%（05-22 首日 +109.91%）
      //     托伦斯   301583 07-10 +800.00%（创业板首日 +858.85%）
      //   ★ 关键区分：numcat 与同花顺是【两条独立链路】。前者可疑 ⇒ 可以丢（随后由本次补写换真值）；
      //     后者是权威源 ⇒ 它写多少就是真值多少，**再越界也只能如实入库**（这不是「猜」，是照抄权威源，§10）。
      //   ⚠️ 与「不被误判成一字」解耦：那道闸门在前端 limit-up.js#isAucPctOutOfRange 单独把守，
      //     本处只负责「把库里的值修对」，绝不因为「怕误判」而丢真数据（原实现正是这么丢的，已纠正）。
      const m = rowByCode.get(String(x.code));
      if (m) {
        m.auc_pct_chg = v;
        fixed++;
        fixedNames.push(x.name + '→' + v);
        if (isAucPctOutOfRange(v, x.code, x.name)) authoritativeOut.push(x.name + '=' + v);
      }
    });
    logs.push('[AUC-SANE] ✅ 越界竞价涨幅已用同花顺快照取回真值 ' + fixed + '/' + list.length + ' 只：' +
      fixedNames.join('、') + (stillBad.length > 0 ? '；仍留空：' + stillBad.join('、') : ''));
    if (authoritativeOut.length > 0) {
      logs.push('[AUC-SANE] ℹ️ 其中 ' + authoritativeOut.length + ' 只按权威源如实采纳（仍超涨跌停幅度 ⇒ ' +
        '只可能是新股上市前 5 个交易日不设限，已入库、⛔ 未被误丢）：' + authoritativeOut.join('、'));
    }
    return { wanted: list.length, fixed: fixed };
  } catch (e) {
    logs.push('[AUC-SANE] ❌ 越界真值修复失败（不影响本轮其它数据）: ' + (e && e.message ? e.message : String(e)));
    return { wanted: list.length, fixed: 0 };
  }
}

// 主流程
async function runMorning(env) {
  const logs = [];
  const _t0 = Date.now();
  // [LATENCY 2026-09-30] 埋点带上北京时钟：这一步是给「落库日志」看的（见 index.js），
  //   以后排查「9:26 为什么没数据」不用再从 created_at 反推 UTC 偏移。
  const mark = (label) => { logs.push('⏱ ' + label + ' +' + (Date.now() - _t0) + 'ms @' + bjClock()); };
  const today = beijingToday();
  const cache = createRunCache();
  logs.push('today=' + today + ' 启动@' + bjClock() + '（P0 硬截止 ' + P0_DEADLINE_LABEL + '，剩余 ' +
    Math.round(p0DeadlineLeftMs() / 1000) + 's）');

  // [KEY-FALLBACK 2026-09-28] 回显 key 候选链：主账号 → 小号。
  //   小号 Secret 没配 = 兜底静默失效，必须在日志里一眼看见（§10 禁止静默失败）。
  const _keys = configuredKeys(env);
  logs.push('🔑 猫抓 key 候选链: ' + (_keys.length
    ? _keys.map(k => k.name + '(' + maskKey(k.key) + ')').join(' → ') +
      (_keys.length > 1 ? '｜主账号额度用尽会自动退回小号' : '｜⚠️ 只配了 1 把 key：主账号用尽则无兜底')
    : '（无！请设置 Secret NUMCAT_API_KEY）'));

  const skipResult = await checkTradingDay(env, today, cache, logs);
  if (skipResult) return skipResult;

  // ---- P0-① 名单（并行取数，写完即可让前端看到当天的票）----
  const watchlistResult = await fetchAndWriteWatchlist(env, today, cache, logs);
  if (watchlistResult.error) {
    return { ok: false, today, error: watchlistResult.error, logs };
  }
  const { constituents, watchlistRows, nowIso, ladderDegraded, ladderCount } = watchlistResult;
  mark('名单落库' + (ladderDegraded ? '（⬇️ 降级：名单源不可用）' : ''));

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

  const { metricsByDate, yestVolDerivedCount, outOfRange } = parseNumcatToMetrics(items, fields, constituents, logs, today);

  // ---- P0-③ 【今天】的 market_metrics 立刻落库 —— 不等区间涨幅、不等历史日 ----
  // 正确性：历史日合并只改 d < today 的行，今天的行在此刻已是最终值
  // （change_pct = auc_pct_chg 的 9:25 竞价副本，正是早盘口径）。
  const todayWrite = await writeMetricsForDates(env, metricsByDate, d => d === today, nowIso, logs);
  mark('今天 market_metrics 落库 ' + todayWrite.totalMetricsWritten + ' 行');
  // [AUC-SANE 2026-10-12] 「是否顶穿 9:26 硬指标」必须在【P0 落库这一刻】判定。
  //   原实现放在 return 前算（那时后面还跑过 P1/P2/P3 + 越界修复），会把「后续步骤慢」
  //   误报成「P0 顶穿」——那正是排障日志里最不能失真的一个字段。
  const p0Overrun = todayWrite.totalMetricsWritten > 0 && bjSecondsOfDay() > P0_DEADLINE_BJ_SEC;

  // ---- P0-④ [AUC-SANE 2026-10-12] 越界竞价涨幅的真值修复（只在检测到越界时才付代价）----
  //   必须在 P1（区间涨幅）之前：T 腿取自 metricsByDate[today].auc_pct_chg，
  //   修晚了该股今天就拿不到十日涨幅 ⇒ 龙位算不出 ⇒ 真龙一照样被漏选（见函数头长注释）。
  //   ⛔ 已落在 P0 落库之后，不占用 9:26 硬指标的关键路径。平时零请求、零耗时。
  const aucRepair = await repairOutOfRangeAucPct(env, metricsByDate, today, outOfRange, logs);
  if (aucRepair.wanted > 0) mark('越界竞价涨幅修复 ' + aucRepair.fixed + '/' + aucRepair.wanted);

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
  // [QUOTA 2026-09-11] 这一步以前带 dates:[today] 会真发一次猫抓请求，但**今天能拿到的四要素
  // 在 P0 写入时就已经落库了**（P0 按当次响应如实写：有就写、没有就空）⇒ 再补一次等于
  // 复写同样的值，最坏情况是白烧 1 次额度/天（占日额度 1/10）。
  // ⚠️ [EXTRAS-TRUTH 2026-11-05] 这里旧文案写的是「猫抓对当日行永远不返回四要素」——**不成立**
  // （11-05 实测 9:25 写入的 58 只 58/58 全带 auc_vol_ratio）。结论（默认不回补今天）不变，
  // 但理由要换成上面这句「P0 已经写过」，而不是「反正拿不到」。
  // 现在 runAuctionExtrasPatch 默认 includeToday=false：dates 只剩今天
  // → 立即零请求返回，只留一条日志。
  // 结算后的缺口由 16:00 close（自动排除今天）与次日早盘窗口重刷补齐。
  // 保留这个调用点是刻意的：万一哪天 P0 那轮没跑成，这里仍能按需补一次。
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

  // ---- P4 [LADDER-FALLBACK 2026-11-06] 名单自愈（只在降级轮执行）----
  // 放在 P0/P1/P2/P3 之后：竞价数据/区间涨幅已经全部落库，这一步再慢也不会顶穿 9:26 硬指标。
  // ① 名单源在这几十秒内恢复 ⇒ 写今天真实 883410 名单；
  // ② 仍不可用 ⇒ 写前一交易日正式成员兜底（source=worker-fallback），常规组绝不空着；
  // ③ 两条都不成立 ⇒ 保持 ladderDegraded=true，第一页源条数显示 `--`（§10 不伪装成 0）。
  let ladderHeal = null;
  if (ladderDegraded) {
    try {
      ladderHeal = await healLadderWatchlist(env, {
        today: today,
        logs: logs,
        prevRows: watchlistResult.fallbackCandidates || [],
        allowFallback: true
      });
      mark('名单自愈 ' + (ladderHeal.recovered ? '真实名单' : ladderHeal.fallback ? '兜底名单' : '未补'));
    } catch (e) {
      logs.push('❌ 名单自愈异常（非致命，竞价数据不受影响）: ' + (e && e.message ? e.message : String(e)));
    }
    if (!ladderHeal || !ladderHeal.ok) {
      logs.push('⬇️ 降级运行：883410 名单源不可用且本轮名单自愈未成功；竞价数据已正常落库。' +
        '上游恢复后可手动补跑 /fetch?point=ladder（只补名单，不重算行情、不烧猫抓额度）。');
    }
  }
  const finalLadderCount = ladderHeal && ladderHeal.recovered ? ladderHeal.ladderCount : ladderCount;
  const finalLadderDegraded = ladderDegraded && !(ladderHeal && ladderHeal.recovered);
  const finalWatchlistRows = watchlistRows.length + (ladderHeal ? ladderHeal.written : 0);
  const ladderNote = !ladderDegraded ? ''
    : (ladderHeal && ladderHeal.recovered)
      ? '✅ 名单源二次尝试已恢复（真实 883410 ' + finalLadderCount + ' 只）；'
      : (ladderHeal && ladderHeal.fallback)
        ? '⬇️ 降级运行（名单源不可用，已写前一日正式成员兜底名单）；'
        : '⬇️ 降级运行（名单源不可用，名单未落库）；';

  logs.push('完成: auction_watchlist ' + finalWatchlistRows + ' 行, market_metrics ' + totalMetricsWritten + ' 行, stock_range_pct ' + rangeWritten + ' 行');
  mark('全流程结束');
  // [LATENCY 2026-09-30] 把「是否顶穿 9:26」直接算成布尔值放进结果，
  //   由 index.js 落库到 bidding_fetch_log，排查时一眼可判（不用再换算 UTC）。
  // [LATENCY 2026-09-30] 「是否顶穿 9:26」已在 P0 落库那一刻算好（见 P0-③ 之后），
  //   这里不再重算 —— 否则会把 P1/P2/P3/越界修复耗时误报成「P0 顶穿」（排查时最不能失真的字段）。
  logs.push(p0Overrun
    ? '🔴 P0 落库时刻已晚于硬截止 ' + P0_DEADLINE_LABEL + '（9:26 硬指标未达成）'
    : '🟢 P0 落库时刻达标（硬截止 ' + P0_DEADLINE_LABEL + '）');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    // [LADDER-SRC 2026-11-03 用户口径] 同花顺「最近多板」(883410) 源数据条数 —— 前端第一页直接显示，
    //   用户拿它对齐炒股软件。⚠️ 与 constituentsCount（并入打标签/龙头后的抓取名单）是两个数。
    ladderCount: finalLadderCount,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    todayMetricsWritten: todayWrite.totalMetricsWritten,
    elapsedMs: Date.now() - _t0,
    p0Overrun: p0Overrun,
    finishedAtBj: bjClock(),
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
    // [AUC-SANE 2026-10-12] 竞价涨幅越界闸门的可观测性：0 = 本次上游数据干净（常态）
    aucPctOutOfRange: outOfRange.length,
    aucPctRepaired: aucRepair.fixed,
    ladderDegraded: !!finalLadderDegraded,
    // [LADDER-FALLBACK 2026-11-06] 名单自愈结果：排障时一眼看清「名单到底是真名单还是兜底名单」。
    ladderHealRecovered: !!(ladderHeal && ladderHeal.recovered),
    ladderHealFallback: !!(ladderHeal && ladderHeal.fallback),
    ladderHealWritten: ladderHeal ? ladderHeal.written : 0,
    watchlistRowsWritten: finalWatchlistRows,
    completenessSummary: ladderNote + completenessSummary,
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

// [TRADING-DAY 2026-09-29] 交易日判定统一走 _shared-source/trading-day.js ——
//   用户在前端顶栏标的假期最高优先，其次周末 / fuyao 日历 / 硬编码表。






// [EXTRAS-PATCH 2026-09-11] 竞价四要素（未匹配量/抢筹幅度/竞价量比/真换手率）补漏：
// ✅ [EXTRAS-TRUTH 2026-11-05] 旧理由「猫抓当日行不给四要素、必须等结算」已被实证推翻
//   （11-05 09:25 写入的 58 只 58/58 全带 auc_vol_ratio）。真实分工是：
//   9:25 主流程按当次响应如实写入（可能给也可能不给，绝不阻塞），16:00 这一趟只补
//   【历史日】仍缺的字段；把今天塞进来会与主流程抢同一批字段并白烧 1 次猫抓额度。
// ⛔ 本链路永不写同花顺 auction_volume_ratio（用户铁口径：量比只认猫抓竞价时间段）。

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

  // [TRADING-DAY 2026-09-29] 原来是 `isWeekend(today) || !localIsTradingDay(today)` ——
  //   只看硬编码表：用户在顶栏标的假期读不到，硬编码表多写一天就会把开市日整轮 skip。
  //   改为三源合并（用户覆盖表 > 周末 > fuyao 日历 > 硬编码表）。
  let fuyaoDates = null;
  try {
    fuyaoDates = await fuyaoCalendarTradingDays(env);
  } catch (e) {
    // §10：日历拿不到 ≠ 今天不是交易日 —— 该层弃权，继续用「用户设置 / 硬编码表」判。
    logs.push('⚠️ fuyao 交易日历不可用（该层弃权，改用用户设置 / 硬编码表判定）: ' + (e && e.message));
  }
  const isTrading = await resolveIsTradingDay(
    env,
    CONFIG.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY,
    today,
    fuyaoDates,
    logs
  );
  if (!isTrading) {
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
    // [QUOTA 2026-09-11] 只传窗口、不传 [today] 兜底：四要素补漏默认【排除当天】——
    // 不是「拿不到」，而是【分工】：当天的字段由同花顺快照腿补（`runTodaySnapshotPatch`，
    // 免费、0 猫抓额度、⛔ 不含量比），本函数只负责历史日的猫抓回填。
    // ⚠️ [EXTRAS-TRUTH 2026-11-05] 旧文案「猫抓对当日行不给这四个字段」已被推翻
    // （11-05 实测 9:25 写入的 58 只 58/58 全带 auc_vol_ratio）；结论不变、理由更正。
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


// ────── bidding-auto-fetch/logic/range-heal.js ──────
// range-heal.js — 云端「区间涨幅」自愈（runRangePctHeal）
//
// 【为什么需要这个文件 / 2026-11-04 用户报障】
//   用户原话：「今天体验非常差，到现在 9 点 48 分题材量比才出票。是不是出票还是要打开电脑，
//   如果关闭电脑关机就不可以出票吗？我一般是关掉电脑，直接在手机看的，不依赖电脑的。」
//   实测取证：2026-11-04 那天
//     · worker 9:25 跑了（bidding_fetch_log ok=true），但日志写着
//       「⚠️ 区间涨幅无结果可写（numcat daily 不可用）」；
//     · stock_range_pct 当天 47 行的 updated_at **全部落在 09:46:04~09:46:09（北京）**
//       —— 那是【浏览器】打开页面时补算并回写的，不是 worker 写的。
//   ⇒ 结论：区间涨幅在 9:25 没算出来 → 云端空 → 谁打开页面谁补算 → **不开电脑就没人算**
//     → 手机上看不到十日涨幅 → 题材量比没有排序依据 → 出不了票。这就是「关机不出票」的根因。
//
// 【本模块做什么】
//   9:27 那一趟（cron `27 1 * * 1-5`，用户拍板「最迟 9 点 27 分，9:35 开盘了没用了」）
//   在补竞价字段之后，再检查一次今天的 stock_range_pct：
//     · 覆盖率够（满窗行数 ≥ 当日竞价行数的 HEAL_MIN_COVERAGE）→ **零请求直接返回**（不烧额度）；
//     · 覆盖率不够 → 才发 1 次猫抓 daily（整个 [T-9, T] 窗口，请求数与只拉今天相同），
//       用与 9:25 早盘【完全同一份口径】（range-window.js 的窗口/复利/T 腿）算好落库。
//   ⇒ 正常日零成本，只有 9:25 那次真的失败时才多花 1 次额度把数据救回来。
//
// 【安全约束（§10 / §11 / NO-PARTIAL-WRITE）】
//   · 读库失败必须抛错中断 —— 绝不把「读不到」当成「全都缺」而整体重算覆盖；
//   · 只写【满窗】行（days === 窗口长度）。残缺行会按日期级复用地污染排序，
//     与 2026-09-15 龙头组事故同构 —— 残缺行只记日志、不落库；
//   · 只填【库内没有满窗值】的股票，已有的值永不覆盖 ⇒ 天然幂等，重复跑零副作用；
//   · 整体失败不致命（调用方 try/catch），绝不影响竞价字段补漏那条主链。





/**
 * 覆盖率闸门：满窗行数 / 当日竞价行数 ≥ 该值 ⇒ 判定「健康」，不发猫抓请求。
 *
 * 为什么不取 100%：总有票真的缺腿（停牌、次新、窗口内上市），它们永远凑不满窗。
 * 只要绝大多数票有值，「题材量比能排序、能出票」这个目的就达到了，
 * 不值得为最后几只每天多烧一次额度。
 */
const RANGE_HEAL_MIN_COVERAGE = 0.8;

/** 单次 upsert 行数 */
const RANGE_HEAL_CHUNK = 400;

/** 北京当前小时（0~23）—— 决定 T 腿口径（15:00 前 = 竞价涨幅） */
function rangeHealIsAfterClose() {
  return beijingNow().getUTCHours() >= 15;
}

/**
 * 云端补齐当日 stock_range_pct（区间涨幅）。
 * @param {object} env
 * @param {{logs?:string[], date?:string, force?:boolean, minCoverage?:number}} [opts]
 *        date   缺省 = 北京今天（仅供排查时指定历史日）
 *        force  true = 跳过覆盖率闸门，强制重算（排查用；会把缺的满窗行补齐）
 * @returns {Promise<{ok:boolean, today:string, written:number, coverage:number, healthy:boolean, logs:string[]}>}
 */
async function runRangePctHeal(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.date || beijingToday();
  const minCoverage = o.minCoverage === undefined ? RANGE_HEAL_MIN_COVERAGE : Number(o.minCoverage);
  logs.push('[range-heal] 区间涨幅自愈开始 today=' + today);

  // 1) 读当日竞价行（§10：读失败必须中断，不能当成「全都缺」）
  let metricsRows;
  try {
    metricsRows = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    logs.push('[range-heal] ❌ 读取 ' + today + ' market_metrics 失败（中断，避免误覆盖）: ' + e.message);
    return { ok: false, today, written: 0, coverage: 0, healthy: false, logs, error: e.message };
  }
  // ⚠️ readMarketMetricsForDate 返回的字段是 `name`（而 readStockRangePctForDate 返回 `stock`），
  //    两者形状不同 —— 这里统一映射成 { name, code, auc, chg }，别混用。
  const targets = (metricsRows || [])
    .filter(r => r && r.code && /^\d{6}$/.test(String(r.code).trim()))
    .map(r => ({ name: String(r.name || '').trim(), code: String(r.code).trim(), auc: r.auc_pct_chg, chg: r.change_pct }))
    .filter(r => r.name);
  if (targets.length === 0) {
    logs.push('[range-heal] ⚠️ ' + today + ' 无可用竞价行（名单未落库？）→ 跳过');
    return { ok: true, today, written: 0, coverage: 0, healthy: false, logs, reason: '无竞价行' };
  }

  // 2) 读库内已有区间涨幅，算「满窗覆盖率」
  let existing = [];
  try {
    existing = await readStockRangePctForDate(env, today);
  } catch (e) {
    logs.push('[range-heal] ❌ 读取 ' + today + ' stock_range_pct 失败（中断，避免误覆盖）: ' + e.message);
    return { ok: false, today, written: 0, coverage: 0, healthy: false, logs, error: e.message };
  }
  const fullNames = new Set();
  (existing || []).forEach(r => {
    if (!r || !r.stock) return;
    const pct = parsePct(r.range_pct);
    const days = Number(r.days);
    if (pct !== null && days === RANGE_WINDOW_DAYS) fullNames.add(String(r.stock).trim());
  });
  const coverage = fullNames.size / targets.length;
  logs.push('[range-heal] 竞价行 ' + targets.length + '，库内满窗 ' + fullNames.size +
    '（覆盖 ' + (coverage * 100).toFixed(0) + '%，闸门 ' + (minCoverage * 100).toFixed(0) + '%）');

  if (!o.force && coverage >= minCoverage) {
    logs.push('[range-heal] ✅ 覆盖率已达标 → 零请求直接返回（不烧猫抓额度）');
    return { ok: true, today, written: 0, coverage: coverage, healthy: true, logs };
  }

  // 3) 窗口交易日 [T-9, T]（与 9:25 早盘同一份交易日历 / 同一个 RANGE_WINDOW_DAYS）
  //    opts.dates 可显式指定窗口（手动修复历史日 / 单测注入，避免每次都去查交易日历）
  let rangeDates = (Array.isArray(o.dates) && o.dates.length > 0) ? o.dates.slice() : [];
  if (rangeDates.length === 0) {
    try {
      rangeDates = await getRecentTradingDays(env, today, RANGE_WINDOW_DAYS);
    } catch (e) {
      logs.push('[range-heal] ❌ 交易日历获取失败: ' + e.message);
      return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: e.message };
    }
  }
  if (!rangeDates || rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('[range-heal] ⚠️ 区间涨幅窗口异常(' + JSON.stringify(rangeDates || []) + ') → 放弃重算');
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, reason: '窗口异常' };
  }
  rangeDates.sort();

  // 4) 只对「库内还没有满窗值」的票重算 —— 请求的代码集也按这个裁剪（省上游压力）
  const need = targets.filter(t => !fullNames.has(t.name));
  if (need.length === 0) {
    logs.push('[range-heal] ✅ 待补票数为 0（剩余缺票属正常缺腿）→ 不请求');
    return { ok: true, today, written: 0, coverage: coverage, healthy: true, logs };
  }
  const symbols = need.map(t => t.code).join(',');
  const startYMD = rangeDates[0].replace(/-/g, '');
  const endYMD = rangeDates[rangeDates.length - 1].replace(/-/g, '');
  logs.push('[range-heal] 待补 ' + need.length + ' 只，请求猫抓 daily ' + rangeDates.length + ' 天窗口...');

  // 5) 一次猫抓 daily 拿整个窗口的逐日涨幅（1 次请求）
  let dailyData;
  try {
    dailyData = await numcatDaily(env, symbols, startYMD, endYMD, logs);
  } catch (e) {
    logs.push('[range-heal] ❌ 猫抓 daily 失败（区间涨幅本次仍未补上，等下次触发/收盘重算）: ' + e.message);
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: e.message };
  }
  const dFields = (dailyData && dailyData.fields) || [];
  const dItems = (dailyData && dailyData.items) || [];
  const dSymIdx = dFields.indexOf('symbol');
  const dDateIdx = dFields.indexOf('tradedate');
  const dPctIdx = dFields.indexOf('pct_chg');
  if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
    logs.push('[range-heal] ❌ 猫抓 daily 返回字段不完整: ' + JSON.stringify(dFields));
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: '字段不完整' };
  }
  // dailyByCode：code -> { YYYYMMDD: 日涨幅 }（与早盘 fetchDailyWindow 完全同构）
  const dailyByCode = {};
  let legCount = 0;
  dItems.forEach(row => {
    const code = String(row[dSymIdx] || '').trim();
    const tradedate = String(row[dDateIdx] || '').trim();
    const rawPct = row[dPctIdx];
    if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
    const dateStr = compactToDateStr(tradedate);
    const n = Number(rawPct);
    if (!dateStr || isNaN(n)) return;
    if (!dailyByCode[code]) dailyByCode[code] = {};
    dailyByCode[code][dateStr.replace(/-/g, '')] = n;
    legCount++;
  });
  logs.push('[range-heal] 猫抓 daily 返回 ' + legCount + ' 条腿，涉及 ' + Object.keys(dailyByCode).length + ' 只');
  if (legCount === 0) {
    logs.push('[range-heal] ⚠️ 猫抓本次一条腿都没给 → 放弃（不写任何行）');
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, reason: '无腿数据' };
  }

  // 6) T 腿：15:00 前用竞价涨幅（与 9:25 早盘口径一致），收盘后用当日收盘涨幅
  const afterClose = rangeHealIsAfterClose();
  const useAuctionLeg = isAuctionLegActive(today, today, afterClose);
  const tYmd = today.replace(/-/g, '');
  const tLegByCode = {};
  need.forEach(t => {
    let v;
    if (useAuctionLeg) {
      v = parsePct(t.auc);
    } else {
      const dm = dailyByCode[t.code];
      v = dm && Object.prototype.hasOwnProperty.call(dm, tYmd) ? dm[tYmd] : parsePct(t.chg);
    }
    if (v !== null && v !== undefined && isFinite(v)) tLegByCode[t.code] = Number(v);
  });

  // 只把「拿到当天 T 腿」的票交给 buildRangeRows（避免产出残缺行，见文件头 NO-PARTIAL-WRITE）
  const eligible = need.filter(t => tLegByCode[t.code] !== undefined);
  const noTLeg = need.length - eligible.length;
  const built = buildRangeRows(eligible, rangeDates, dailyByCode, tLegByCode);
  const nowIso = new Date().toISOString();
  const rows = built
    .filter(r => Number(r.days) === rangeDates.length)   // ⛔ 残缺行不落库
    .map(r => ({
      date: today,
      stock: r.stock,
      range_pct: Number(r.pct).toFixed(2),
      days: r.days,
      updated_at: nowIso
    }));
  logs.push('[range-heal] 计算完成：可写满窗行 ' + rows.length + ' / 待补 ' + need.length +
    (noTLeg > 0 ? '；' + noTLeg + ' 只无当天 T 腿（不写行）' : '') +
    (built.length > rows.length ? '；' + (built.length - rows.length) + ' 只缺历史腿（不写残缺行）' : ''));

  if (rows.length === 0) {
    logs.push('[range-heal] ⚠️ 没有可写的满窗行（等收盘整段重算或下次触发）');
    return { ok: true, today, written: 0, coverage: coverage, healthy: false, logs };
  }

  // 7) 分批写入（主键 date+stock，merge-duplicates；只含与本次重算相关的列，绝不抹 change_pct 等）
  let written = 0;
  for (let i = 0; i < rows.length; i += RANGE_HEAL_CHUNK) {
    const chunk = rows.slice(i, i + RANGE_HEAL_CHUNK);
    try {
      await upsertStockRangePct(env, chunk);
      written += chunk.length;
    } catch (e) {
      logs.push('[range-heal] ❌ 第 ' + (Math.floor(i / RANGE_HEAL_CHUNK) + 1) + ' 批写入失败: ' + e.message);
    }
  }
  const newCoverage = (fullNames.size + written) / targets.length;
  logs.push('[range-heal] ✅ 补写 ' + written + ' 行区间涨幅，覆盖率 ' +
    (coverage * 100).toFixed(0) + '% → ' + (Math.min(newCoverage, 1) * 100).toFixed(0) + '%');
  return { ok: written > 0, today, written: written, coverage: newCoverage, healthy: false, logs };
}


// ────── bidding-auto-fetch/logic/ladder-recheck.js ──────
// ladder-recheck.js — 北京 09:26 云端「最近多板 883410」二次确认 + 新进成分股竞价数据补抓
//
// ============================================================================
// [P0-2 2026-11-06 用户要求] 「最近多板源头也要修好」「全部改用云端的」「最迟 9 点 26 分」
// ----------------------------------------------------------------------------
// 事故回顾：11-06 09:25 上游 `Data source unavailable` ⇒ 9:25 那轮降级，
//   auction_watchlist 只剩 17 行观察组壳行 ⇒ 常规组全空（应用最重要的数据入口没了）。
//   09:4x 手工拨测同一个 883410 接口就恢复了（HTTP 200 / 2790ms / 57 只）。
//   ⇒ 单靠「9:25 内重试」不够：上游可能在 9:25:xx ~ 9:26 之间才恢复。
//
// 本模块 = 一条独立的云端 cron（wrangler `26 1 * * 2-6`，Cloudflare 免费额度 3/5），
//   在 09:26（开盘前 4 分钟）做三件事，全部幂等：
//     ① 9:25 已写入足量【真实 883410 名单】⇒ 直接跳过，0 网络请求、0 猫抓额度（§32）；
//     ② 否则再问一次真实名单源：恢复 ⇒ 写今天真实名单，并清掉 9:25 的 `worker-fallback` 行；
//     ③ 对「真实名单里有、但今天 market_metrics 还没数据 / 缺竞价量比」的票，
//        用【猫抓 daily_auc】一次性补上（1 次额度，按请求次数算不按股票数算）。
//
// ⛔⛔ 竞价量比唯一来源 = 猫抓 `daily_auc.auc_vol_ratio`（9:25 竞价时间段口径）。
//    同花顺 `auction_volume_ratio` 是开盘后口径，**任何时段、任何路径、兜底也不许用**。
//    本文件不 import 任何同花顺快照函数，就是为了从依赖上把这条路封死（用户 2026-11-06 原话）。
//
// 【成本上限】上游名单源 1 次（自带 12s 预算）+ 猫抓 1 次 + 少量 Supabase REST；
//  9:26:00 起跑，最坏 9:26:20 完成，仍在用户「最迟 9:26 获取完」的竞价窗口内。
// 【数据安全】§10 读取失败一律停止；§11 删除只针对当日 `source='worker-fallback'`，
//  且必须发生在「真实名单写入成功 + 重读复核达标」之后，删除后再复核一次。
// ============================================================================






/** 今日正式成员里「真实 883410 名单」的条数（⛔ 兜底名单不算达标） */
function countRealLadderRows(todayRows) {
  return (todayRows || []).filter(function (r) {
    return r && !r.obs_auto_added
      && String(r.source || '').trim() === 'worker'
      && /^\d{6}$/.test(String(r.code || '').trim());
  }).length;
}

/**
 * 纯函数：要不要在这一趟重查名单？
 * 只有「真实名单条数 < 门槛」才跑 —— 正常日 9:25 已写 55~95 行 ⇒ 恒跳过，零副作用。
 */
function needsLadderRecheck(todayRows, minRows) {
  const need = minRows === undefined ? MIN_LADDER_ROWS : minRows;
  return countRealLadderRows(todayRows) < need;
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * 纯函数：算出这一趟需要猫抓补哪些票。
 *   · 库里今天连行都没有 ⇒ 需要写【整行】；
 *   · 有行但 auc_vol_ratio 为空 ⇒ 只补这一列（⛔ 不覆盖其它已有值，§11）；
 *   · 已有量比 ⇒ 完全不碰（幂等，避免重复写库）。
 * 只认 6 位代码；按 code 去重；不会返回空 symbols 让调用方白烧额度。
 */
function pickNumcatTargets(ladder, metricsRows) {
  const byName = new Map();
  (metricsRows || []).forEach(function (r) {
    if (r && r.name) byName.set(String(r.name).trim(), r);
  });
  const seenCode = new Set();
  const fullRows = [];
  const ratioOnly = [];
  const symbols = [];
  (ladder || []).forEach(function (c) {
    if (!c) return;
    const name = String(c.name || '').trim();
    const code = String(c.code || '').trim();
    if (!name || !/^\d{6}$/.test(code) || seenCode.has(code)) return;
    const m = byName.get(name);
    if (m && hasValue(m.auc_vol_ratio)) return;
    seenCode.add(code);
    symbols.push(code);
    if (!m) fullRows.push({ name: name, code: code });
    else ratioOnly.push({ name: name, code: code });
  });
  return { symbols: symbols, fullRows: fullRows, ratioOnly: ratioOnly };
}

const FULL_FIELDS = [
  'volume', 'change_pct', 'yest_volume', 'auc_pct_chg',
  'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover',
];

/**
 * 纯函数：把 parseNumcatToMetrics 的当天结果转成写库行。
 * 复用主流程的解析器（假 0 守卫 / 越界闸门 / 量纲换算全一致，§6 单一真相），
 * 但按 pickNumcatTargets 的分类决定「整行」还是「只补量比一列」。
 */
function buildAucMetricsWriteRows(parsedToday, today, nowIso, targets) {
  const byName = new Map();
  (parsedToday || []).forEach(function (m) {
    if (m && m.stock) byName.set(String(m.stock).trim(), m);
  });
  const rows = [];
  (targets.fullRows || []).forEach(function (t) {
    const m = byName.get(t.name);
    if (!m) return;
    const row = {
      date: today,
      stock: t.name,
      code: t.code,
      scope: 'auction',
      source: 'worker',
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker',
    };
    let got = 0;
    FULL_FIELDS.forEach(function (k) {
      if (hasValue(m[k])) { row[k] = m[k]; got++; }
    });
    // ⛔ 一只字段都没拿到就别建空行：建了只会让「有行但全空」伪装成「已抓到」，
    //    题材量比闸门会把它算进分母却拿不到量比（§10 宁缺勿错，等 16:30 云端回填）。
    if (got > 0) rows.push(row);
  });
  (targets.ratioOnly || []).forEach(function (t) {
    const m = byName.get(t.name);
    if (!m || !hasValue(m.auc_vol_ratio)) return;
    // ⛔ 只带这一列：resolution=merge-duplicates 只更新 payload 里出现的列，
    //    绝不把 worker / 猫抓历史回填写好的其它字段抹掉（§11 覆盖即高风险）。
    rows.push({
      date: today,
      stock: t.name,
      scope: 'auction',
      auc_vol_ratio: m.auc_vol_ratio,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker',
    });
  });
  return rows;
}

/**
 * 用猫抓 daily_auc 补「真实名单里的新票 / 缺量比的票」。
 * ⛔ 整个函数最多 1 次 numcat 请求；额度用尽直接优雅退出，不重试（§32）。
 */
async function fillAucFromNumcat(env, today, ladder, logs) {
  const out = { attempted: false, symbols: 0, written: 0, skipped: '', error: '' };
  let metricsRows;
  try {
    metricsRows = await readMarketMetricsSnapshotFieldsForDate(env, today);
  } catch (e) {
    out.error = '读取当日 market_metrics 失败 → 停止补抓（§10 不把读失败当空表）: ' + (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ ' + out.error);
    return out;
  }
  const targets = pickNumcatTargets(ladder, metricsRows);
  out.symbols = targets.symbols.length;
  if (targets.symbols.length === 0) {
    out.skipped = '当日 market_metrics 已覆盖真实名单且竞价量比齐全 → 0 次猫抓请求';
    logs.push('[ladder26] ✅ ' + out.skipped);
    return out;
  }
  out.attempted = true;
  const ymd = String(today).replace(/-/g, '');
  let data;
  try {
    data = await numcatDailyAuc(env, targets.symbols.join(','), ymd, ymd, logs);
  } catch (e) {
    out.error = (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ 猫抓 daily_auc 补抓失败（本次不重试、不连坐名单写入）: ' + out.error);
    return out;
  }
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  if (fields.indexOf('symbol') < 0 || fields.indexOf('auc_vol_ratio') < 0 || items.length === 0) {
    out.skipped = '猫抓本次未返回 symbol/auc_vol_ratio（或 0 行）→ 不写任何行，量比留空待 16:30 云端回填';
    logs.push('[ladder26] ⚠️ ' + out.skipped);
    return out;
  }
  const parsed = parseNumcatToMetrics(items, fields, ladder, logs, today);
  const rows = buildAucMetricsWriteRows(parsed.metricsByDate[today] || [], today, new Date().toISOString(), targets);
  if (rows.length === 0) {
    out.skipped = '猫抓返回 ' + items.length + ' 行但无一行可写（名单/字段不匹配）→ 留空不猜';
    logs.push('[ladder26] ⚠️ ' + out.skipped);
    return out;
  }
  try {
    await upsertMarketMetrics(env, rows);   // 内部按「键集签名」分桶，⛔ 不会 PGRST102
  } catch (e) {
    out.error = 'market_metrics 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ ' + out.error);
    return out;
  }
  out.written = rows.length;
  logs.push('[ladder26] ✅ 猫抓 daily_auc 1 次请求 → 写入 market_metrics ' + rows.length +
    ' 行（新票整行 / 已有票只补 auc_vol_ratio，来源=猫抓竞价时间段）');
  return out;
}

/**
 * 9:26 云端二次确认主入口。
 * @returns {Promise<{ok:boolean,today:string,skipped:boolean,recovered:boolean,written:number,fallbackCleared:number,ladderCount:number|null,auc:object,logs:string[]}>}
 */
async function runLadderRecheck(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const nowIso = new Date().toISOString();
  const out = {
    ok: false, today: today, skipped: false, recovered: false,
    written: 0, fallbackCleared: 0, ladderCount: null,
    auc: { attempted: false, symbols: 0, written: 0, skipped: '', error: '' },
    logs: logs,
  };

  // ① 当日名单现状。读取失败必须停（§10），绝不把它当「空名单」往下写。
  let todayRows;
  try {
    todayRows = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder26] ❌ 读取当日 auction_watchlist 失败 → 停止: ' + (e && e.message ? e.message : String(e)));
    return out;
  }
  if (!needsLadderRecheck(todayRows, MIN_LADDER_ROWS)) {
    out.ok = true;
    out.skipped = true;
    logs.push('[ladder26] ✅ 9:25 已写入 ' + countRealLadderRows(todayRows) +
      ' 行真实 883410 名单（≥' + MIN_LADDER_ROWS + '）→ 本趟 0 上游请求、0 猫抓额度，直接返回');
    return out;
  }

  const officialNames = new Set(todayRows.filter(r => !r.obs_auto_added).map(r => r.name));
  const inWin = isMorningWindow(beijingNow());
  logs.push('[ladder26] 当日真实名单 ' + countRealLadderRows(todayRows) + ' 行（<' + MIN_LADDER_ROWS +
    '）⇒ 重查 883410；9:25 窗口=' + inWin);

  // ② 再问一次真实名单源（fetchLadderConstituents 自带 4 次 / 12s 预算，不会顶穿 9:26）
  let ladder = null;
  try {
    const raw = await fetchLadderConstituents(env);
    if (Array.isArray(raw) && raw.length >= MIN_LADDER_ROWS) {
      ladder = raw;
      out.recovered = true;
      out.ladderCount = raw.length;
      logs.push('[ladder26] ✅ 883410 恢复，拿到 ' + raw.length + ' 只');
    } else {
      logs.push('[ladder26] ⚠️ 883410 只返回 ' + (Array.isArray(raw) ? raw.length : 0) +
        ' 只（<' + MIN_LADDER_ROWS + '）→ 视为残缺，不写正式名单');
    }
  } catch (e) {
    logs.push('[ladder26] ⚠️ 883410 仍不可用: ' + (e && e.message ? e.message : String(e)));
  }

  // ③ 名单源仍挂 + 当日一个正式成员都没有 ⇒ 写前一日兜底（9:25 整轮可能压根没跑成）
  if (!ladder) {
    if (officialNames.size > 0) {
      logs.push('[ladder26] 名单源未恢复，但当日已有 ' + officialNames.size +
        ' 行正式成员（含 9:25 兜底）⇒ 保留现状，⛔ 不覆盖、不删除');
      out.ok = true;
      return out;
    }
    const fb = pickFallbackWatchlistRows(o.prevRows, today, nowIso, MIN_FALLBACK_ROWS);
    if (fb.length === 0) {
      logs.push('[ladder26] ❌ 名单源未恢复且无足量前一日正式成员 → 不写名单，保留可观测的降级状态');
      return out;
    }
    try {
      await upsertAuctionWatchlist(env, fb);
      out.written = fb.length;
      out.ok = true;
      logs.push('[ladder26] ⬇️ 写入前一日正式成员兜底 ' + fb.length + ' 行（source=worker-fallback）');
    } catch (e) {
      logs.push('[ladder26] ❌ 兜底名单写入失败: ' + (e && e.message ? e.message : String(e)));
    }
    return out;
  }

  // ④ 写真实名单。非 9:25 窗口且当日已有正式成员 ⇒ 名单锁定，只更新已存在的行。
  let rows = buildLadderWatchlistRows(ladder, today, nowIso, 'worker');
  if (!inWin && officialNames.size > 0) {
    const before = rows.length;
    rows = rows.filter(r => officialNames.has(r.stock));
    logs.push('[ladder26] 非 9:25 窗口：名单锁定，只更新已存在的 ' + rows.length +
      ' 行，跳过 ' + (before - rows.length) + ' 只新成分股');
  }
  if (rows.length === 0) {
    logs.push('[ladder26] 名单锁定后无行可写 → 不写');
    return out;
  }
  try {
    await upsertAuctionWatchlist(env, rows);
    out.written = rows.length;
    out.ok = true;
    logs.push('[ladder26] ✅ auction_watchlist 写入真实 883410 名单 ' + rows.length + ' 行');
  } catch (e) {
    logs.push('[ladder26] ❌ 真实名单写入失败 → 停止（⛔ 不清兜底、不补行情）: ' +
      (e && e.message ? e.message : String(e)));
    return out;
  }

  // ⑤ 清掉 9:25 写入的兜底行：必须「写入成功 + 重读复核达标」后才允许删（§11）
  let after;
  try {
    after = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder26] ⚠️ 写入后重读失败 → 不删除任何兜底行: ' + (e && e.message ? e.message : String(e)));
    after = [];
  }
  if (countRealLadderRows(after) >= MIN_LADDER_ROWS) {
    try {
      const deleted = await deleteLadderFallbackRows(env, today);
      out.fallbackCleared = deleted;
      logs.push('[ladder26] ✅ 清理当日 source=worker-fallback 兜底行 ' + deleted + ' 行（带结果确认）');
      const verify = await readAuctionWatchlistForDate(env, today);
      if (countRealLadderRows(verify) < MIN_LADDER_ROWS) {
        logs.push('[ladder26] ❌ 删除后复核：真实名单不足 ' + MIN_LADDER_ROWS + ' 行 → 报警，请人工检查');
        out.ok = false;
      }
    } catch (e) {
      logs.push('[ladder26] ⚠️ 清理兜底行失败（不影响刚写入的真实名单）: ' +
        (e && e.message ? e.message : String(e)));
    }
  } else {
    logs.push('[ladder26] ⚠️ 写入后复核未达标 → ⛔ 不删除任何兜底行（宁可多留几行，也不清空名单）');
  }

  // ⑥ 猫抓补新进票 / 缺量比票。失败只记日志，绝不影响已写好的真实名单。
  out.auc = await fillAucFromNumcat(env, today, ladder, logs);
  return out;
}


// ────── bidding-auto-fetch/logic/range20-prefill.js ──────
// range20-prefill.js — 北京 09:26 云端「20 日涨幅」补缺（0 上游 / 0 猫抓额度）
//
// ============================================================================
// [R20-CLOUD 2026-11-06 用户口径] 「老问题也要修好」「全部改用云端的」
// ----------------------------------------------------------------------------
// 根因（不是逻辑错，是**抢跑**）：
//   Supabase pg_cron `range20-auc-precompute` 与 Cloudflare worker 都在北京 09:25:00 起跑。
//   Edge 的快路径要用 `market_metrics.auc_pct_chg` 当 T 腿，可 worker 到 01:25:10Z
//   （09:25:10）才把竞价涨幅写进库 ⇒ Edge 09:25:0x 读到的 T 腿是空的 ⇒ 快路径 0 行，
//   剩下的 K 线主循环又常常吃满 190s 预算 ⇒ 当天 `stock_range20_pct` 整表 0 行。
//   于是只能靠浏览器打开看板时 `prefillRange20FromDailyLegs` 现算写库 ——
//   用户「换台电脑就出问题」的观感就是这么来的。
//
// 修法（本文件）：把「用逐日腿补缺」这一步挪到 **09:26 的 worker cron**（ladder26 同一趟）。
//   此时 worker 的 P0 已落库完（T 腿有了），且它比 Edge 的 K 线重算便宜得多：
//     · 只读 3 张 Supabase 表 + 写 1 张，**0 个 K 线 / 腾讯 / 同花顺 / 猫抓请求**；
//     · 只补「当天还没有行」的票，已有值一律不覆盖（§6/§11 纯加法、幂等）；
//     · 腿不够 19 根一律不写（§10 宁缺勿错，绝不拿半截复利当 20 日涨幅）。
//
// 单一真相：复利口径复用前端/Edge 同源的 `range-window.js#parsePct / compoundPct`，
//   与 `db/edge/range20-precompute/index.ts#rangeFromLegs` 逐字等价（19 根历史腿 + 1 根 T 腿）。
//   ⛔ 不在这里另写一份计算公式。
//
// 部署：worker 由 .github/workflows/deploy-worker.yml 自动 wrangler deploy，
//   ⛔ 不需要用户在 Supabase Dashboard 手工重贴 Edge Function（这是选 worker 而不是 Edge 的原因）。
// ============================================================================



/** 与 Edge WINDOW_DAYS-1 完全一致：19 根历史腿 + 1 根 T 腿 = 20 日 */
const RANGE20_LEG_DAYS = 19;

/** 腿表回看窗口（自然日）：足够跨过春节/国庆凑满 19 个交易日，与 Edge shiftYmd(-60) 一致 */
const RANGE20_LOOKBACK_DAYS = 60;

/**
 * 纯函数：与 Edge `rangeFromLegs` 逐字等价。
 * @param {number[]} hist 升序的历史腿（% 数值）
 * @param {number} tLeg 目标日 T 腿（竞价口径 = auc_pct_chg；收盘口径 = change_pct）
 * @returns {{pct:string, days:number}|null}
 */
function compoundRange20(hist, tLeg) {
  if (!Array.isArray(hist) || hist.length < RANGE20_LEG_DAYS) return null;
  if (!Number.isFinite(tLeg)) return null;
  const win = hist.slice(-RANGE20_LEG_DAYS);
  const v = compoundPct(win.concat([tLeg]));
  if (v === null || !isFinite(v)) return null;
  return { pct: v.toFixed(2), days: win.length + 1 };
}

/** 北京 15:00 前 = 竞价口径(auc)，之后 = 收盘口径(close)——与 Edge 选腿、前端 resolveT20LegMode 同源 */
function legModeOf(nowBj) {
  return nowBj.getUTCHours() < 15 ? 'auc' : 'close';
}

/** 纯函数：把腿表扁平行按股票归集成升序数值腿（坏值跳过，不折 0） */
function groupLegs(rows) {
  const byStock = new Map();
  (rows || []).forEach(function (r) {
    if (!r) return;
    const s = String(r.stock || '').trim();
    const d = String(r.date || '').slice(0, 10);
    const p = parsePct(r.pct);
    if (!s || !d || p === null) return;
    let arr = byStock.get(s);
    if (!arr) { arr = []; byStock.set(s, arr); }
    arr.push({ d: d, p: p });
  });
  const out = new Map();
  byStock.forEach(function (arr, s) {
    arr.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    out.set(s, arr.map(x => x.p));
  });
  return out;
}

/** 自然日回退（只用于拼腿表查询下界，不是交易日推算） */
// ⚠️ 单文件打包会把所有模块拼进同一作用域 ⇒ 顶层函数名必须全局唯一（_bundle.mjs 会体检拦截）
function r20ShiftDays(dateStr, delta) {
  const ms = Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 云端补缺主入口。
 * @returns {Promise<{ok:boolean,today:string,leg:string,targets:number,covered:number,need:number,written:number,shortLegs:number,noTLeg:number,skipped:string,error:string,logs:string[]}>}
 */
async function runRange20Prefill(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const leg = o.leg || legModeOf(beijingNow());
  const out = {
    ok: false, today: today, leg: leg, targets: 0, covered: 0, need: 0,
    written: 0, shortLegs: 0, noTLeg: 0, skipped: '', error: '', logs: logs
  };

  // ① 今日名单（正式成员 + 观察组）与今日行情（T 腿）。§10：任一读取失败立即停，不写任何行。
  let wl, metrics;
  try {
    wl = await readAuctionWatchlistForDate(env, today);
    metrics = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    out.error = '读取当日名单/行情失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  // T 腿：竞价口径优先纯竞价涨幅；收盘口径用收盘涨幅。两者同源（9:25 时 change_pct 是竞价副本）。
  const tByStock = new Map();
  metrics.forEach(function (r) {
    if (!r || !r.name) return;
    const raw = leg === 'close' ? r.change_pct : (r.auc_pct_chg || r.change_pct);
    const p = parsePct(raw);
    if (p !== null) tByStock.set(r.name, p);
  });
  const targets = Array.from(new Set(
    wl.map(r => r.name).concat(metrics.map(r => r.name)).filter(Boolean)
  ));
  out.targets = targets.length;
  if (targets.length === 0) {
    out.skipped = '当日名单与行情都为空 ⇒ 不写（§10 不把「读不到」当成「没有票」）';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ② 云端已有一律不碰（纯加法）。有任何 leg 的行都视作已覆盖，⛔ 不混口径覆盖。
  let have;
  try {
    have = await readRange20StocksForDate(env, today);
  } catch (e) {
    out.error = '读取 stock_range20_pct 失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  targets.forEach(function (s) { if (have.has(s)) out.covered++; });
  if (out.covered >= targets.length) {
    out.ok = true;
    out.skipped = '当天 ' + targets.length + ' 只票云端已全覆盖 ⇒ 0 写入';
    logs.push('[r20-prefill] ✅ ' + out.skipped);
    return out;
  }

  const need = targets.filter(function (s) {
    if (have.has(s)) return false;
    if (!tByStock.has(s)) { out.noTLeg++; return false; }
    return true;
  });
  out.need = need.length;
  if (need.length === 0) {
    out.ok = true;
    out.skipped = '缺 ' + (targets.length - out.covered) + ' 只但都没有 T 腿（竞价涨幅尚未落库）⇒ 一只都不写';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ③ 读历史腿（0 上游请求，按股票分批 in 过滤）
  let legRows;
  try {
    legRows = await readDailyLegsForStocks(
      env, r20ShiftDays(today, -RANGE20_LOOKBACK_DAYS), today, need
    );
  } catch (e) {
    out.error = '读取逐日腿失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  const legs = groupLegs(legRows);
  const nowIso = new Date().toISOString();
  const rows = [];
  need.forEach(function (s) {
    const hist = legs.get(s);
    if (!hist || hist.length < RANGE20_LEG_DAYS) { out.shortLegs++; return; }
    const r = compoundRange20(hist, tByStock.get(s));
    if (!r) { out.shortLegs++; return; }
    rows.push({
      date: today,
      stock: s,
      pct: r.pct,
      days: r.days,
      leg: leg,
      updated_at: nowIso
    });
  });
  if (rows.length === 0) {
    out.ok = true;
    out.skipped = '待补 ' + need.length + ' 只，但腿不足 ' + RANGE20_LEG_DAYS + ' 根的有 ' +
      out.shortLegs + ' 只 ⇒ 一只都不写（宁缺勿错）';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ④ 一次分桶 upsert（所有行键集相同，⛔ 不会 PGRST102）
  try {
    await upsertRange20Rows(env, rows);
  } catch (e) {
    out.error = 'stock_range20_pct 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  out.written = rows.length;
  out.ok = true;
  logs.push('[r20-prefill] ✅ ' + today + ' leg=' + leg + ' 云端补缺 ' + rows.length + ' 行' +
    '（目标 ' + out.targets + ' / 已有 ' + out.covered + ' / 缺T腿 ' + out.noTLeg +
    ' / 腿不足 ' + out.shortLegs + ' / 读腿 ' + legRows.length + ' 行；0 上游请求、0 猫抓额度）');
  return out;
}


// ────── bidding-auto-fetch/logic/daily-legs-heal.js ──────
// daily-legs-heal.js — 云端逐日腿补齐（替代本机 08:00 的 WorkBuddy 定时任务）
//
// ============================================================================
// [DAILY-LEGS-CLOUD 2026-11-06 用户口径] 「本机的那些一律迁移到云端」「换掉电脑就出问题」
// ----------------------------------------------------------------------------
// 为什么之前必须靠电脑：Supabase Edge `healDailyLegsFromMetrics` 的闸③ 要求
//   `market_metrics.updated_by` 含 'close' 且 `updated_at >= 当日 15:00`。
//   2026-11-06 生产实测：11-04 是 8/87 行、11-05 是 8/86 行满足（其余都是 9:25 写入的
//   `auto-fetch-worker`，收盘覆盖只补写了少数票）⇒ 云端 heal 每天最多补 8 根腿。
//   剩下 80 根全靠本机脚本 `db/scripts/backfill-daily-pct.mjs --recent`（工作日 08:00）
//   用另一条更准的判据补上 —— 换电脑 / 关机就断，用户看到「20 日涨幅又不全」。
//
// 本模块把本机那条判据原样搬到 Cloudflare Worker（wrangler CI 自动部署，⛔ 不用手工粘贴 Edge）：
//   ★ 收盘覆盖判据：`change_pct !== auc_pct_chg`（差 ≥0.011）才认这根是【收盘腿】。
//     两者相等 ⇒ 还停在 9:25 竞价副本，拿它当收盘腿会让整条 20 日复利静默算错。
//     本机脚本用腾讯前复权日线逐条比对 426 条：通过 383 条里 382 条完全一致（99.7%），
//     被拒的 43 条只有 62.8% 碰巧正确 ⇒ 拒掉是对的（见 backfill-daily-pct.mjs 注释）。
//   ⚠️ 代价：收盘价恰好等于竞价值的票会被误拒（假阴性）—— 宁可少补一根，⛔ 不接受错值。
//
// 时点：
//   · 16:00 close 之后跑 ⇒ 允许写【今天】这根腿（收盘已覆盖），明天 9:26 的 20 日涨幅快路径才齐；
//   · 09:26 ladder26 里再跑一次 ⇒ 只补【今天之前】漏掉的日期，兜住「昨天 16:00 没跑成」；
//   · 两个时点都幂等：只写 `stock_daily_pct` 里不存在的 (date,stock)，⛔ 从不覆盖已有腿。
//
// 【成本】0 个上游请求、0 猫抓额度；只有 Supabase REST 读写。
// 【数据安全】§10 任一步读取失败立即停、不写；§11 纯新增，不删不改。
// ============================================================================


/** 回看自然日（覆盖周末 + 小长假；与 Edge HEAL_LOOKBACK_DAYS=8 同量级，略放宽） */
const DAILY_LEGS_LOOKBACK_DAYS = 12;

/** 与本机脚本 numPct 完全一致：'%'/'+' 剥掉，缺失 ⇒ null（⛔ 绝不返回 0） */
function numPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', '').replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 纯函数：从 market_metrics 窗口挑出「可写的收盘腿」。
 * @param {Array} metricsRows [{stock,date,change_pct,auc_pct_chg}]
 * @param {Map<string,Set<string>>} existingByDate 每个日期已有的股票名
 * @param {string} today YYYY-MM-DD
 * @param {boolean} allowToday 是否允许写今天（只有 15:05 收盘后为 true）
 * @returns {{rows:Array, scanned:number, rejected:number, todaySkipped:number, already:number}}
 */
function pickCloudDailyLegs(metricsRows, existingByDate, today, allowToday, nowIso) {
  const rows = [];
  let scanned = 0, rejected = 0, todaySkipped = 0, already = 0;
  (metricsRows || []).forEach(function (r) {
    if (!r) return;
    scanned++;
    const stock = String(r.stock || '').trim();
    const d = String(r.date || '').slice(0, 10);
    if (!stock || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (d > today) return;
    if (d === today && !allowToday) { todaySkipped++; return; }
    const c = numPct(r.change_pct);
    if (c === null) return;                          // §10 缺值不写，⛔ 不当 0%
    const a = numPct(r.auc_pct_chg);
    if (a !== null && Math.abs(c - a) < 0.011) { rejected++; return; }  // 还停在竞价副本
    const set = existingByDate && existingByDate.get(d);
    if (set && set.has(stock)) { already++; return; }
    rows.push({
      date: d,
      stock: stock,
      pct: (c < 0 ? '' : '+') + c.toFixed(2),
      src: 'metrics_close',
      updated_at: nowIso || new Date().toISOString()
    });
  });
  return { rows: rows, scanned: scanned, rejected: rejected, todaySkipped: todaySkipped, already: already };
}

// ⚠️ 单文件打包共作用域 ⇒ 顶层名必须全局唯一（与 range20-prefill.js 的 r20ShiftDays 区分）
function dailyLegsShiftDays(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}

/** 北京 15:05 之后才允许把「今天」当收盘腿（与 Edge legFinal / healOnly 同源） */
function isAfterClose(nowBj) {
  return nowBj.getUTCHours() > 15 ||
    (nowBj.getUTCHours() === 15 && nowBj.getUTCMinutes() >= 5);
}

/**
 * 云端补齐主入口。
 * @returns {Promise<{ok:boolean,today:string,allowToday:boolean,scanned:number,written:number,rejected:number,already:number,error:string,logs:string[]}>}
 */
async function runDailyLegsHeal(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const allowToday = o.allowToday === undefined ? isAfterClose(beijingNow()) : !!o.allowToday;
  const out = {
    ok: false, today: today, allowToday: allowToday, scanned: 0, written: 0,
    rejected: 0, already: 0, error: '', logs: logs
  };
  const from = dailyLegsShiftDays(today, -DAILY_LEGS_LOOKBACK_DAYS);

  let metrics;
  try {
    metrics = await readMetricsLegsWindow(env, from, today);
  } catch (e) {
    out.error = '读取 market_metrics 窗口失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[daily-legs] ❌ ' + out.error);
    return out;
  }
  out.scanned = metrics.length;
  const dates = Array.from(new Set(metrics
    .map(r => String((r && r.date) || '').slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today)))
    .sort();

  // 只查真正可能出现的日期，⛔ 不扫空日子（§32）
  const existingByDate = new Map();
  for (let i = 0; i < dates.length; i++) {
    try {
      existingByDate.set(dates[i], await readDailyPctStocksForDate(env, dates[i]));
    } catch (e) {
      out.error = '读取 ' + dates[i] + ' 已有腿失败 → 停止补写（§10）: ' +
        (e && e.message ? e.message : String(e));
      logs.push('[daily-legs] ❌ ' + out.error);
      return out;
    }
  }

  const picked = pickCloudDailyLegs(metrics, existingByDate, today, allowToday);
  out.rejected = picked.rejected;
  out.already = picked.already;
  if (picked.rows.length === 0) {
    out.ok = true;
    logs.push('[daily-legs] ✅ 窗口 ' + from + '~' + today + ' 已齐（扫描 ' + out.scanned +
      ' 行 / 已有 ' + out.already + ' / 竞价未覆盖拒 ' + out.rejected +
      ' / 盘中跳过 ' + picked.todaySkipped + '）⇒ 0 写入');
    return out;
  }
  try {
    await upsertDailyPctRows(env, picked.rows);
  } catch (e) {
    out.error = 'stock_daily_pct 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[daily-legs] ❌ ' + out.error);
    return out;
  }
  out.written = picked.rows.length;
  out.ok = true;
  logs.push('[daily-legs] ✅ 云端补齐逐日腿 ' + out.written + ' 行（窗口 ' + from + '~' + today +
    '，扫描 ' + out.scanned + ' / 已有 ' + out.already + ' / 竞价未覆盖拒 ' + out.rejected +
    '，src=metrics_close，0 上游请求）');
  return out;
}


// ────── ../src/logic/bidding/snapshot-spec.js ──────
// snapshot-spec.js — 竞价变化看板「快照取值口径」唯一真相（§6）
//
// [BIDDING-CLOSE-CLOUD 2026-11-07] 为什么抽这个文件：
//   原来 BIDDING_SECTOR_ETFS / biddingEtfToSnapshotCode / 收盘列的计算规则
//   全部是 src/logic/bidding/helpers.js 里的私有常量，只有【浏览器】能用。
//   结果「收盘」列只能靠浏览器 fetchBiddingSnapshotToForm() 自动填表单 + 人工点保存，
//   一旦某天没点保存，bidding_data.close 就永久空白 ⇒ 次日 jiwang_data 的
//   「昨多板K线」推导不出来（2026-11-04 事故）。
//   现在把口径抽到纯模块，前端与 Cloudflare Worker 16:00 轮共用同一份实现：
//   Worker 直接把收盘值幂等 upsert 到 bidding_data.close，不再依赖人工点保存。
//
// ⛔ 本文件必须保持【零浏览器依赖 / 零 DOM / 零 Vue】，否则 Worker 打包会炸。

const LADDER_THSCODE = '883410.TI';
const TOP10_THSCODE = '883901.TI';
const MAIN_INDEX_THSCODE = '000001.SH';

/** 「板块ETF」行的 48 个观察标的（含 3 个指数） */
const BIDDING_SECTOR_ETFS = [
  { code: '560780', name: '半导体设备ETF' }, { code: '159995', name: '芯片ETF华夏' },
  { code: '512480', name: '半导体ETF国' }, { code: '159732', name: '消费电子ETF' },
  { code: '515880', name: '通信ETF国泰' }, { code: '560800', name: '数字经济ETF' },
  { code: '159819', name: '人工智能ETF' }, { code: '159206', name: '卫星ETF永赢' },
  { code: '515750', name: '科技50ETF' }, { code: '159608', name: '稀有金属ETF' },
  { code: '159998', name: '计算机ETF天弘' }, { code: '561160', name: '电池ETF富国' },
  { code: '159857', name: '光伏ETF天弘' }, { code: '516780', name: '稀土ETF华泰' },
  { code: '562500', name: '机器人ETF华夏' }, { code: '515400', name: '大数据ETF富国' },
  { code: '560860', name: '工业有色ETF' }, { code: '516510', name: '云计算ETF易' },
  { code: '516390', name: '新能源车ETF' }, { code: '563010', name: '电信ETF易方达' },
  { code: '159875', name: '新能源ETF嘉实' }, { code: '516100', name: '金融科技ETF' },
  { code: '886078', name: '商业航天' }, { code: '512660', name: '军工ETF国泰' },
  { code: '560280', name: '工程机械ETF' }, { code: '515230', name: '软件ETF国泰' },
  { code: '159996', name: '家电ETF国泰' }, { code: '885939', name: '海峡两岸' },
  { code: '159227', name: '航空航天ETF' }, { code: '518880', name: '黄金ETF华安' },
  { code: '1A0001', name: '上证指数' }, { code: '159869', name: '游戏ETF华夏' },
  { code: '515150', name: '一带一路ETF' }, { code: '516620', name: '影视ETF国泰' },
  { code: '515120', name: '创新药ETF广发' }, { code: '516910', name: '物流ETF富国' },
  { code: '159842', name: '券商ETF银华' }, { code: '159666', name: '交通运输ETF' },
  { code: '512200', name: '房地产ETF南方' }, { code: '159766', name: '旅游ETF富国' },
  { code: '562600', name: '医疗器械ETF' }, { code: '159611', name: '电力ETF广发' },
  { code: '167301', name: '保险主题LOF' }, { code: '159825', name: '农业ETF富国' },
  { code: '159309', name: '油气ETF汇添富' }, { code: '512690', name: '酒ETF鹏华' },
  { code: '515220', name: '煤炭ETF国泰' }, { code: '159887', name: '银行ETF富国' }
];

/** 「大盘ETF」行的 4 个宽基 ETF */
const BIDDING_BIG_ETFS = ['510500', '512100', '510300', '510050'];

/** 非 6 位数字代码 → 指数 thscode（其余按 5 开头=SH / 其它=SZ 走个股快照） */
const BIDDING_INDEX_CODES = {
  '886078': '886078.TI',
  '885939': '885939.TI',
  '1A0001': MAIN_INDEX_THSCODE
};

function biddingEtfToSnapshotCode(code) {
  const c = String(code || '').trim();
  if (BIDDING_INDEX_CODES[c]) return { thscode: BIDDING_INDEX_CODES[c], type: 'index' };
  if (c.charAt(0) === '5') return { thscode: c + '.SH', type: 'stock' };
  return { thscode: c + '.SZ', type: 'stock' };
}

/** 把 48 个观察标的拆成「个股/ETF 快照代码」与「指数快照代码」两组 */
function biddingSnapshotCodeGroups() {
  const etfCodes = [];
  const indexCodes = [];
  BIDDING_SECTOR_ETFS.forEach(function (e) {
    const c = biddingEtfToSnapshotCode(e.code);
    if (c.type === 'index') indexCodes.push(c.thscode);
    else etfCodes.push(c.thscode);
  });
  const allIndexCodes = Array.from(new Set(indexCodes.concat([MAIN_INDEX_THSCODE])));
  return { etfCodes, indexCodes, allIndexCodes };
}

/**
 * 同花顺快照一条 item 的涨跌幅（number）。
 * 上游偶发给成正的「跌」，用 price_change / current_price vs prev_close 纠符号。
 * 前端与 Worker 必须用同一份，否则同一时刻两端口径会分叉。
 */
function normalizeFuyaoSnapshotPct(it) {
  if (!it) return null;
  const raw = it.price_change_ratio_pct;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && n > 0) return -n;
  return n;
}

/** 快照值可能是 number（前端）或 '+1.23%'（worker fetchSnapshotChangePct），统一成 number */
function biddingNumOf(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/%/g, '').replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

/**
 * 快照 map 的 key 形态两端口径不同，这里统一兼容：
 *   · 前端 fuyao /api/a-share/prices/snapshot → item.thscode（'600519.SH'）
 *   · Worker fetchSnapshotChangePct → 6 位代码（'600519'）
 *   · 腾讯行情 → 'sh600519' 解析后前端转成 '600519.SH'
 * 先按完整 thscode 找，再退回去后缀的纯代码。
 */
function biddingPctLookup(map, thscode) {
  if (!map) return undefined;
  const k = String(thscode || '');
  if (map[k] !== undefined) return map[k];
  const bare = k.replace(/\..*$/, '');
  if (bare !== k && map[bare] !== undefined) return map[bare];
  return undefined;
}

/**
 * 由各路快照算出「收盘列」各行的值。
 * 返回 key 与 useBiddingBoard.fetchSnapshot() 的 values 完全同名（板块ETF 用短名，
 * 由 resolveBiddingRowTargets 负责映射到库里真实的 '板块ETF(48)' 行）。
 *
 * ⛔ 任何一路没数据就【不给该行赋值】（§10：读取失败 ≠ 0），调用方只填空不造值。
 */
function computeBiddingCloseValues(input) {
  const src = input || {};
  const ladderCodes = src.ladderCodes || [];
  const top10Codes = src.top10Codes || [];
  const stockPcts = src.stockPcts || {};
  const etfPcts = src.etfPcts || {};
  const indexPcts = src.indexPcts || {};
  const values = {};

  const ladderVals = ladderCodes
    .map(c => biddingNumOf(biddingPctLookup(stockPcts, c)))
    .filter(v => v !== null);
  if (ladderVals.length > 0) {
    values['最近多板%'] = (ladderVals.reduce((a, b) => a + b, 0) / ladderVals.length).toFixed(2);
  }

  let sectorRed = 0;
  let sectorSeen = 0;
  BIDDING_SECTOR_ETFS.forEach(function (e) {
    const c = biddingEtfToSnapshotCode(e.code);
    const raw = c.type === 'index'
      ? biddingPctLookup(indexPcts, c.thscode)
      : biddingPctLookup(etfPcts, c.thscode);
    const v = biddingNumOf(raw);
    if (v === null) return;
    sectorSeen++;
    if (v > 0) sectorRed++;
  });
  // 一只都没取到 ⇒ 不写 0（0 家上涨是合法值，但「没数据」不是）
  if (sectorSeen > 0) values['板块ETF'] = String(sectorRed);

  if (top10Codes.length > 0) {
    let top10Red = 0;
    let top10Seen = 0;
    top10Codes.forEach(function (c) {
      const v = biddingNumOf(biddingPctLookup(stockPcts, c));
      if (v === null) return;
      top10Seen++;
      if (v > 0) top10Red++;
    });
    if (top10Seen > 0) values['昨日资金前十'] = String(top10Red);
  }

  const bigVals = BIDDING_BIG_ETFS
    .map(c => biddingNumOf(biddingPctLookup(etfPcts, c + '.SH')))
    .filter(v => v !== null);
  if (bigVals.length > 0) {
    values['大盘ETF'] = (bigVals.reduce((a, b) => a + b, 0) / bigVals.length).toFixed(2);
  }

  const mainIdx = biddingNumOf(biddingPctLookup(indexPcts, MAIN_INDEX_THSCODE));
  if (mainIdx !== null) values['大盘（%）'] = mainIdx.toFixed(2);

  return values;
}

/**
 * 把 values 映射到【库中真实存在的行】，并只挑 close 仍为空的行。
 *
 * ★ 幂等 / 数据安全（§11）：已有非空 close 一律不覆盖 —— 用户手工修正优先于云端自动值。
 * ★ 不硬编码 '板块ETF(48)' 这种带数字后缀的行名，从 existingRows 里找前缀匹配。
 *
 * @param {Array<{name:string,close?:string|null}>} existingRows 当天 bidding_data 已有行
 * @param {Record<string,string>} values computeBiddingCloseValues 的结果
 * @returns {Array<{name:string,close:string,from:string}>}
 */
function resolveBiddingRowTargets(existingRows, values) {
  const v = values || {};
  const out = [];
  (existingRows || []).forEach(function (row) {
    const name = String((row && row.name) || '').trim();
    if (!name) return;
    const closed = row && row.close !== null && row.close !== undefined && String(row.close).trim() !== '';
    if (closed) return;
    let from = '';
    let value;
    if (v[name] !== undefined) { value = v[name]; from = name; }
    else if (name.indexOf('板块ETF') === 0 && v['板块ETF'] !== undefined) { value = v['板块ETF']; from = '板块ETF'; }
    if (value === undefined || value === null || String(value).trim() === '') return;
    out.push({ name: name, close: String(value).trim(), from: from });
  });
  return out;
}


// ────── bidding-auto-fetch/logic/bidding-close-write.js ──────
// bidding-close-write.js — 竞价变化看板「收盘」列【纯云端自动落库】
//
// [BIDDING-CLOSE-CLOUD 2026-11-07] 事故与根因
//   用户报障：2026-11-05 记忘看板「昨多板K线」没有三天数据。生产取证：
//     · 2026-11-04 bidding_data 7 行 close 全是 ''，其余 13 个交易日都有 5~6 行 close；
//     · bidding_fetch_log 近 30 天 352 条里 `http | bidding | close` = **0 条**
//       ⇒ db/supabase_bidding_t0925_cron.sql 里 point=close 的 pg_cron 从未成功执行过
//         （SQL 文件里 URL 还是 <PROJECT_REF>/<TOKEN> 占位符）；
//     · 前端 fetchBiddingSnapshotToForm() 只是把快照【填进编辑表单】，状态文案明确写
//       「请检查后点"保存"」，只有 useBiddingBoard.save() 才把 close 写进 bidding_data。
//   ⇒ 收盘列真实语义 = 「自动抓数 + 人工点保存」，不是无人值守。11-04 那天没点保存
//     （11-07 点开历史记录保存时反而把空字符串写进去了），于是
//     syncJiwangKxianFromBidding() / viewKxianSeries() 拿不到 11-04「最近多板%」收盘涨幅
//     ⇒ 11-05 的 K 线推导不出来。与「昨日跌涨 1:6 识别」完全无关。
//
// 【本模块做什么】
//   16:00 close 轮末尾，用与前端【同一份口径】(src/logic/bidding/snapshot-spec.js)
//   重算收盘列，幂等 upsert 到 bidding_data.close。之后即使没人开电脑、没人点保存，
//   收盘列与次日「昨多板K线」也能闭环。
//
// 【硬红线】
//   ⛔ 只允许【当天】：fuyao /api/a-share/prices/snapshot 是「最近一个交易日」滚动快照，
//      给历史日期 ?date= 会把今天的收盘涨幅错写到过去（§10/§11）。历史缺口不可无损回补，
//      只能人工补录，本模块绝不猜值、绝不用 market_metrics / 竞价涨幅冒充收盘。
//   ⛔ 只填空：已有非空 close 一律不覆盖（用户手工修正优先）。
//   ⛔ 读取失败 ≠ 0：任何一路快照拿不到就不给该行赋值，绝不写 0 家 / +0.00%。
//   ⛔ 失败不连坐：本模块任何异常都只记日志、返回 ok:false，不影响 runClose 主流程。
//   ⛔ 0 猫抓额度：全部走同花顺快照，与竞价量比（只认猫抓）无关。





const SB_TIMEOUT_MS = 12000;
const PROXY_TIMEOUT_MS = 9000;
const BCW_LADDER_ROW = '最近多板%';

function bcwFetch(url, opts) {
  const base = opts || {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, base, { signal: AbortSignal.timeout(SB_TIMEOUT_MS) }));
  }
  return fetch(url, base);
}

function bareCode(thscode) {
  const s = String(thscode || '').trim().replace(/\..*$/, '');
  return /^\d{6}$/.test(s) ? s : '';
}

async function readExistingRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,close';
  const resp = await bcwFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

/** 883901「昨日资金前十」成分股；失败返回空数组（该行留空，不写 0） */
async function fetchTop10Codes(env, logs) {
  try {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list',
      { thscode: TOP10_THSCODE }, PROXY_TIMEOUT_MS);
    const codes = ((data && data.item) || [])
      .map(it => bareCode(it && (it.ticker || it.thscode)))
      .filter(Boolean);
    logs.push('883901 成分股 ' + codes.length + ' 只');
    return Array.from(new Set(codes));
  } catch (e) {
    logs.push('⚠️ 883901 成分股获取失败（该行留空）: ' + (e && e.message));
    return [];
  }
}

/** 指数快照（886078.TI / 885939.TI / 000001.SH） */
async function fetchIndexPcts(env, allIndexCodes, logs) {
  const out = {};
  try {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/prices/snapshot',
      { thscodes: allIndexCodes.join(',') }, PROXY_TIMEOUT_MS);
    ((data && data.item) || []).forEach(it => {
      if (!it || !it.thscode) return;
      const v = normalizeFuyaoSnapshotPct(it);
      if (v !== null) out[String(it.thscode).trim()] = v;
    });
    logs.push('指数快照可用 ' + Object.keys(out).length + '/' + allIndexCodes.length);
  } catch (e) {
    logs.push('⚠️ 指数快照失败（大盘（%）/板块ETF 留空）: ' + (e && e.message));
  }
  return out;
}

/** 纯函数：组装最终要 upsert 的行（便于单测锁住幂等 / 只填当天 / 键集一致） */
function buildBiddingCloseWriteRows(existingRows, values, date, nowIso) {
  const targets = resolveBiddingRowTargets(existingRows, values);
  const names = {};
  (existingRows || []).forEach(r => { names[String((r && r.name) || '').trim()] = true; });
  // 当天已有别的行，但「最近多板%」这一行不存在（9:25 漏写）⇒ 允许补建该行。
  // 它是「昨多板K线」的唯一原料；其余行不自动新建，避免造出残缺行。
  if ((existingRows || []).length > 0 && !names[BCW_LADDER_ROW] &&
      values && values[BCW_LADDER_ROW] !== undefined &&
      String(values[BCW_LADDER_ROW]).trim() !== '') {
    targets.push({ name: BCW_LADDER_ROW, close: String(values[BCW_LADDER_ROW]).trim(), from: BCW_LADDER_ROW });
  }
  return targets.map(t => ({
    date: date,
    name: t.name,
    close: t.close,
    updated_at: nowIso || new Date().toISOString()
  }));
}

async function runBiddingCloseWrite(env, opts) {
  const logs = [];
  const today = beijingToday();
  const date = (opts && opts.date) || today;

  // ★ 硬闸：/api/a-share/prices/snapshot 只返回「最近一个交易日」，历史日期绝不写。
  if (date !== today) {
    logs.push('⛔ 跳过：目标日期 ' + date + ' ≠ 今天 ' + today + '（快照是滚动窗口，禁止回写历史）');
    return { ok: true, skipped: true, date, written: 0, values: {}, logs };
  }

  let existingRows;
  try {
    existingRows = await readExistingRows(env, date);
  } catch (e) {
    logs.push('❌ 读取 bidding_data 失败（本次不写任何值）: ' + (e && e.message));
    return { ok: false, date, written: 0, values: {}, logs };
  }
  logs.push('bidding_data 当日已有 ' + existingRows.length + ' 行');
  if (existingRows.length === 0) {
    logs.push('⛔ 当日无任何行（竞价链路未跑/非交易日）⇒ 不造行，跳过');
    return { ok: true, skipped: true, date, written: 0, values: {}, logs };
  }

  let ladderCodes = [];
  try {
    ladderCodes = (await fetchLadderConstituents(env)).map(s => bareCode(s.code)).filter(Boolean);
    logs.push('883410 成分股 ' + ladderCodes.length + ' 只');
  } catch (e) {
    logs.push('⚠️ 883410 成分股获取失败（最近多板% 留空）: ' + (e && e.message));
  }
  const top10Codes = await fetchTop10Codes(env, logs);
  const groups = biddingSnapshotCodeGroups();
  const etfBare = groups.etfCodes.map(bareCode).filter(Boolean);
  const stockCodes = Array.from(new Set([].concat(ladderCodes, top10Codes, etfBare, BIDDING_BIG_ETFS)));

  const stockPcts = {};
  if (ladderCodes.length === 0 && top10Codes.length === 0 && etfBare.length === 0) {
    logs.push('⛔ 三路名单全空 ⇒ 不发快照请求（§10：读取失败不造 0）');
  } else {
    try {
      const snap = await fetchSnapshotChangePct(env, stockCodes);
      Object.assign(stockPcts, (snap && snap.pctMap) || {});
      logs.push('个股/ETF 快照可用 ' + Object.keys(stockPcts).length + '/' + stockCodes.length);
    } catch (e) {
      logs.push('⚠️ 个股/ETF 快照失败（相关行留空）: ' + (e && e.message));
    }
  }

  // 前端用腾讯行情拿 ETF，Worker 统一用同花顺；computeBiddingCloseValues 的
  // biddingPctLookup 兼容「带后缀 thscode」与「6 位代码」两种 key，无需在这里改 key 形态。
  const etfPcts = stockPcts;
  const indexPcts = await fetchIndexPcts(env, groups.allIndexCodes, logs);

  const values = computeBiddingCloseValues({
    ladderCodes, top10Codes, stockPcts, etfPcts, indexPcts
  });
  logs.push('算出收盘列 ' + JSON.stringify(values));

  if (Object.keys(values).length === 0) {
    logs.push('⛔ 五路快照全没数据 ⇒ 一行不写（绝不写 0）');
    return { ok: false, date, written: 0, values, logs };
  }

  const rows = buildBiddingCloseWriteRows(existingRows, values, date, new Date().toISOString());
  if (rows.length === 0) {
    logs.push('✅ 收盘列已完整（或用户已手工填写）⇒ 幂等跳过，不覆盖');
    return { ok: true, date, written: 0, values, logs };
  }
  logs.push('待写 ' + rows.length + ' 行: ' + rows.map(r => r.name + '=' + r.close).join(' / '));

  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
    const resp = await bcwFetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(rows)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 240));
    }
    logs.push('✅ 云端已写入 bidding_data.close ' + rows.length + ' 行（无需人工点保存）');
    return { ok: true, date, written: rows.length, values, rows, logs };
  } catch (e) {
    logs.push('❌ 写 bidding_data.close 失败: ' + (e && e.message));
    return { ok: false, date, written: 0, values, rows, logs };
  }
}


// ────── bidding-auto-fetch/logic/jiwang-close-write.js ──────
// jiwang-close-write.js — 记忘看板「昨收盘结果(跌:涨)」纯云端落库 + 历史无损回补
//
// [JIWANG-SHOUGU-CLOUD 2026-11-08] 事故与根因
//   用户报障：2026-11-06 记忘看板「昨日跌涨 / 昨收盘结果 / 昨日情绪」三个一起不显示。
//   生产取证：
//     · JiwangBoard.vue:55「昨收盘结果」= display.shouguJieguo；
//       :16 / :27「昨日跌涨 / 昨日情绪」= deriveFromShougu(d.shouguJieguo)
//       ⇒ 三个字段【同源】于当天 jiwang_data[date].shouguJieguo。
//     · jiwang_data 有 10-28~11-05 和 11-09，**没有 2026-11-06 这一行** ⇒ 三个全空。
//     · 唯一云端写入源是 workers/bidding-board-worker-b/logic/jiwang-workflow.js#runJiwang
//       → updateJiwangShouguJieguo(env, nextTradingDay, stats)。
//       emotion_data['2026-11-05'] 只有 09:40 早盘记录、没有 16:00 收盘记录
//       ⇒ 11-05 16:00 那轮收盘主流程没跑 ⇒ 没写 11-06 行。
//       （11-06 16:00 那轮跑了：emotion_data['11-06'] 与 jiwang_data['11-09'] 同为 08:00:35Z。）
//     · 该 worker 在本 Cloudflare 账号下查不到（账号 workers 只有 bidding-auto-fetch），
//       且它的 writeLog 带 `worker:'B'`，而 bidding_fetch_log 没有 worker 列 ⇒ 日志 400 被吞，
//       「跑没跑」在库里完全不可观测。
//
// 【本模块做什么】挂到 16:00 close 轮（确定在跑 + CI 自动部署 + 线上复核）：
//   ① 调一次猫抓 emoindic_daily（recentdays=10）拿 10 个交易日的 s2(涨家数)/s6(跌家数)；
//   ② 对每个交易日 d，写 jiwang_data[nextTradingDay(d)].shouguJieguo = 跌:涨；
//   ③ 因为拿到的是【窗口】而不是单日，所以同时把过去 10 天所有缺口一次性无损回补
//      （11-05 的 next 就是 11-06 ⇒ 本次事故的那一行会被自动补回来，不需要猜值）。
//
// 【硬红线】
//   ⛔ 只填空：已有非空 shouguJieguo 一律不覆盖（用户手工修正优先，§11）。
//   ⛔ 读取失败 ≠ 空数据：接口失败/字段缺失 ⇒ 一行不写，日志必须可见（§10）。
//   ⛔ 失败不连坐：任何异常只记日志、返回 ok:false，不影响 runClose 主流程。
//   ⛔ 不造数：s2/s6 必须是有效正数；绝不用 market_metrics / 竞价涨幅 / 前一交易日值冒充。
//   ⛔ 交易日映射不靠猜：窗口内相邻两个交易日天然互为 next（0 请求，自动含节假日）；
//      只有窗口最后一天才用 isTradingDay 逐日推下一个交易日。




const NUMCAT_EMOINDIC_URL = 'https://numcat.net/api/reference-proxy/market/emoindic-daily';
const NUMCAT_APINAME = 'emoindic_daily';
const JW_RECENT_DAYS = 10;
const JW_HTTP_TIMEOUT_MS = 15000;
const JW_SB_TIMEOUT_MS = 12000;
const ROW_COLUMN = 'shouguJieguo';

function jiwangFetch(url, opts, ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, opts || {}, { signal: AbortSignal.timeout(ms) }));
  }
  return fetch(url, opts || {});
}

/** 猫抓 10 日情绪窗口 → [{ date, up, down }]（升序）。字段缺失绝不折 0。 */
function parseEmoindicRows(payload) {
  const data = payload && payload.data;
  const fields = data && data.fields;
  const items = data && data.items;
  if (!Array.isArray(fields) || !Array.isArray(items)) return [];
  const dateIdx = fields.indexOf('tradedate');
  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (dateIdx < 0 || upIdx < 0 || downIdx < 0) return [];
  const out = [];
  items.forEach(function (it) {
    if (!Array.isArray(it)) return;
    const date = normalizeDate(it[dateIdx]);
    const up = Number(it[upIdx]);
    const down = Number(it[downIdx]);
    if (!date || !isFinite(up) || !isFinite(down) || up <= 0 || down <= 0) return;
    out.push({ date: date, up: up, down: down });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

/**
 * 窗口给出「收盘日 → 下一交易日」的真实映射：
 *   · 相邻两项互为 next（0 请求，天然含周末/节假日）；
 *   · 最后一项的 next 不在窗口内 ⇒ 交给调用方用交易日历补。
 */
function alignWindowTargets(rows, lastNext) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const target = i + 1 < rows.length ? rows[i + 1].date : (lastNext || '');
    if (!target) continue;
    out.push({ from: rows[i].date, date: target, value: rows[i].down + ':' + rows[i].up });
  }
  return out;
}

/** 纯函数：只保留「库里该日期还没有 shouguJieguo」的目标（§11 幂等填空） */
function buildJiwangShouguWriteRows(targets, existingRows, nowIso) {
  const filled = {};
  (existingRows || []).forEach(function (r) {
    const d = String((r && r.date) || '').trim();
    const v = r && r[ROW_COLUMN];
    if (d && v !== null && v !== undefined && String(v).trim() !== '') filled[d] = true;
  });
  const seen = {};
  const rows = [];
  (targets || []).forEach(function (t) {
    if (!t || !t.date || !t.value || filled[t.date] || seen[t.date]) return;
    seen[t.date] = true;
    const row = { date: t.date, updated_at: nowIso || new Date().toISOString() };
    row[ROW_COLUMN] = t.value;
    rows.push(row);
  });
  return rows;
}

async function fetchEmoindicWindow(env) {
  const key = env.NUMCAT_API_KEY || env.NUMCAT_API_KEY_YIZI || '';
  if (!key) throw new Error('缺少 NUMCAT_API_KEY / NUMCAT_API_KEY_YIZI，无法取收盘跌涨家数');
  const resp = await jiwangFetch(NUMCAT_EMOINDIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiname: NUMCAT_APINAME, apikey: key, params: { recentdays: JW_RECENT_DAYS } })
  }, JW_HTTP_TIMEOUT_MS);
  if (!resp.ok) throw new Error('猫抓 emoindic_daily HTTP ' + resp.status);
  const json = await resp.json();
  if (json && json.code !== 200) throw new Error('猫抓 emoindic_daily 错误: ' + (json.message || 'code=' + json.code));
  return json;
}

async function readExistingJiwang(env, dates) {
  if (!dates.length) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/jiwang_data?select=date,' + ROW_COLUMN +
    '&date=in.(' + dates.map(encodeURIComponent).join(',') + ')';
  const resp = await jiwangFetch(url, { headers: sbHeaders(env) }, JW_SB_TIMEOUT_MS);
  if (!resp.ok) throw new Error('读取 jiwang_data 失败: HTTP ' + resp.status);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

/** 窗口最后一天的下一交易日（只用真实交易日历，不猜） */
async function nextTradingDayAfter(env, dateStr, maxDays) {
  let ms = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(ms)) return '';
  for (let i = 1; i <= (maxDays || 10); i++) {
    ms += 24 * 3600 * 1000;
    const d = new Date(ms).toISOString().slice(0, 10);
    if (await isTradingDay(env, d)) return d;
  }
  return '';
}

async function runJiwangCloseWrite(env) {
  const logs = [];
  const today = beijingToday();

  let payload;
  try {
    payload = await fetchEmoindicWindow(env);
  } catch (e) {
    logs.push('❌ 猫抓 emoindic_daily 失败（本次一行不写）: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets: [] };
  }
  const rows = parseEmoindicRows(payload);
  logs.push('猫抓窗口 ' + rows.length + ' 个交易日: ' + (rows.length ? rows[0].date + ' ~ ' + rows[rows.length - 1].date : '空'));
  if (rows.length < 2) {
    logs.push('❌ 窗口不足 2 天或 s2/s6 全缺 ⇒ 一行不写（读取失败不造 0）');
    return { ok: false, written: 0, logs, targets: [] };
  }

  let lastNext = '';
  try {
    lastNext = await nextTradingDayAfter(env, rows[rows.length - 1].date);
    logs.push('窗口最后一天 ' + rows[rows.length - 1].date + ' 的下一交易日 = ' + (lastNext || '未算出'));
  } catch (e) {
    logs.push('⚠️ 下一交易日推算失败（最后一天不写，其余照常回补）: ' + (e && e.message));
  }

  const targets = alignWindowTargets(rows, lastNext);
  logs.push('候选目标 ' + targets.length + ' 个: ' + targets.map(t => t.date + '=' + t.value).join(' / '));

  let existing;
  try {
    existing = await readExistingJiwang(env, targets.map(t => t.date));
  } catch (e) {
    logs.push('❌ 读取 jiwang_data 失败（本次一行不写）: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets };
  }

  const writeRows = buildJiwangShouguWriteRows(targets, existing, new Date().toISOString());
  if (!writeRows.length) {
    logs.push('✅ 目标日期均已有昨收盘结果 ⇒ 幂等跳过，不覆盖');
    return { ok: true, written: 0, logs, targets, today };
  }
  logs.push('待写 ' + writeRows.length + ' 行: ' + writeRows.map(r => r.date + '=' + r[ROW_COLUMN]).join(' / '));

  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/jiwang_data?on_conflict=date';
    const resp = await jiwangFetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(writeRows)
    }, JW_SB_TIMEOUT_MS);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 240));
    }
    logs.push('✅ 云端已写 jiwang_data.shouguJieguo ' + writeRows.length + ' 行（含历史缺口回补）');
    return { ok: true, written: writeRows.length, logs, targets, rows: writeRows, today };
  } catch (e) {
    logs.push('❌ 写 jiwang_data 失败: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets, rows: writeRows };
  }
}


// ────── bidding-auto-fetch/index.js ──────
// index.js — bidding-auto-fetch Worker 入口
//
// 触发点（同一条 Cloudflare 部署链路；免费账户 5 条 cron，当前用 3 条）：
//   · 北京 9:25  → morning ：抓竞价数据 + 计算 10 日区间涨幅落库；
//   · 北京 9:26  → ladder26：最近多板 883410 名单二次确认 + 新进票猫抓补竞价量比（P0-2 2026-11-06）；
//   · 北京 16:00 → close   ：用收盘涨幅覆盖 9:25 竞价涨幅 + 校正区间涨幅 T 腿。
//   · （9:27 / 9:35 保留映射，供手动或用户自建触发器做云端自愈；不占用 cron 额度）
//
// ★ 为什么是 9:27 这一趟（2026-11-04 用户报障「关机就不出票」）：
//   1) 猫抓对【当日】的 auc_vol 在 9:25 偶尔还没结算 → 写成占位 0（趋势图竞价量全 0）；
//   2) 猫抓 daily 一旦超时 → stock_range_pct 当天 0 行 → 区间涨幅只能由浏览器补算
//      （实测 11/04 那 47 行全是 09:46 由前端写的）⇒ 不开电脑当天就出不了票。
//   ★ 时间点由用户拍板（2026-11-04 原话）：「不是 9 点 35 分，最迟 9 点 27 分就可以了，
//   9 点 35 分开盘了，没用了，我一直要求的是竞价期间」。9:30 一开盘，竞价就结束了，
//   这时候再补出来的票对买卖已经没有意义 —— 所以自愈必须压在 9:27。
//   9:27 上游已结算完竞价（9:25 撮合、9:25:xx 出终态），用「同花顺快照（免费）+
//   猫抓 daily（仅失败时才请求）」把两样都补回来。
//
// [FIX 2026-09-10] 收盘覆盖「回归本 worker」。
//   2026-08-17 曾把 close 挪到 Supabase Edge Function（bidding-a?point=auction-close，pg_cron 16:00），
//   但实测该 pg_cron 链路从未成功执行过（bidding_fetch_log 里 auction-close 记录数为 0，
//   手工触发返回 546），导致当天 change_pct 全天停留在竞价涨幅。
//   本 worker 的早盘 cron 一直稳定，因此收盘也交回这里，不再依赖任何外部 cron。
// ★ [PATH-FIX 2026-11-05] 这里原来是 `../../_shared-source/`，是**错的**：
//   本文件在 workers/bidding-auto-fetch/ 下，`../` = workers/，`../../` = 项目根，
//   而 _shared-source 实际在 workers/_shared-source ⇒ 路径指向一个不存在的地方。
//   一直没暴露是因为：① logic/ 与 data/ 下的文件（深度 3，`../../` 正好对）会把 date-utils
//   一起带进 bundle，_bundle.mjs 又对解析不到的路径静默跳过 ⇒ 粘贴版一直是对的；
//   ② 但 wrangler 从源码打包是严格解析模块图的，直接报
//   `Could not resolve "../../_shared-source/date-utils.js"`（2026-11-05 首次尝试 wrangler 部署时踩到）。



// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏（可手动 /fetch?point=extras；16:00 close 也会自动跑）

// [RANGE-HEAL 2026-11-04] 区间涨幅云端自愈：9:25 那次猫抓 daily 失败时，
//   9:27 那一趟把 stock_range_pct 补回来 —— 用户关电脑/用手机也能出票（根因见文件头）。

// [LADDER-FALLBACK 2026-11-06] 只补「最近多板 883410 正式名单」，不碰行情/猫抓/区间涨幅。

// [LADDER26 2026-11-06] 北京 09:26 云端二次确认：真实名单 + 新进票猫抓竞价量比（1 次额度上限）。

// [R20-CLOUD 2026-11-06] 同一趟 9:26 顺带把 20 日涨幅用逐日腿补缺（0 上游、0 额度）。

// [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐，彻底替代本机 08:00 定时任务。

// [BIDDING-CLOSE-CLOUD 2026-11-07] 竞价变化看板「收盘」列纯云端幂等落库：
//   以前只能靠浏览器自动填表 + 人工点保存，漏点一天 ⇒ 次日「昨多板K线」断链。

// [JIWANG-SHOUGU-CLOUD 2026-11-08] 「昨收盘结果(跌:涨)」纯云端落库 + 10 日窗口历史回补。
//   原来只靠另一个账号/查不到的 worker-b 在 16:00 写下一交易日，且日志带不存在的 worker 列被吞，
//   11-05 16:00 那轮没跑 ⇒ jiwang_data 缺 11-06 整行 ⇒ 昨日跌涨/昨收盘结果/昨日情绪一起空。

// [RUNLOG 2026-09-30] 把每轮的完整日志（含 ⏱ 埋点）落库到 bidding_fetch_log，
//   否则 CF Worker 的埋点只进 Cloudflare Dashboard，事后无法复盘「9:26 为什么没数据」。

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
  // ★ [HEAL-0927 2026-11-04 用户口径「我不可能在电脑旁盯着，用手机打开就要看到结果」]
  //   01:27 UTC = 09:27 北京时间 → snapshot（自愈补写）。
  //   为什么需要这一趟：猫抓对【当日】的 auc_vol 在 9:25 偶尔还没结算，会返回占位 0
  //   ⇒ 9:25 那次写下去是空的；等到 9:27（竞价已结算、还没开盘）用同花顺快照
  //   （免费、不烧猫抓额度）把当日竞价量/量比/竞价涨幅补回来。
  //   **全程在云端跑，不需要用户开电脑。**
  //   注：9:35 仍然保留映射 —— 用户之前可能已加过这条触发器，且它现在只是「再兜一次」
  //   （内部幂等，覆盖率达标就零请求），对开盘后的复盘仍有用，删掉反而少一层保险。
  // [LADDER26 2026-11-06] 01:26 UTC = 北京 09:26：名单源二次确认。
  //   11-06 的 P0 里上游 9:25 挂、9:4x 就恢复，只靠 9:25 内重试救不回来；
  //   这条 cron 在开盘前 4 分钟再问一次，且「9:25 已成功」时 0 请求直接返回（幂等）。
  const MAP = {
    '25 1': 'morning',
    '26 1': 'ladder26',
    '27 1': 'snapshot',
    '35 1': 'snapshot',
    '0 8': 'close'
  };
  return MAP[key] || null;
}

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 9:25 早盘 / 16:00 收盘主流程末尾，用同花顺快照补【当天】
 * 的 auc_pct_chg / auc_turnover / volume（免费、0 猫抓额度）。
 * ⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04] **不含 auc_vol_ratio（竞价量比）** ——
 *    用户口径：竞价量比只认猫抓、同花顺永远不许补（详见 extras-workflow.js#runTodaySnapshotPatch）。
 * 失败不致命：整段 try/catch，只留日志，绝不影响主流程结果。
 */
async function runSnapshotPatchSafely(env, result, tag) {
  try {
    const snap = await runTodaySnapshotPatch(env, {});
    console.log('[auto-fetch] ' + tag + ' 快照补当日竞价字段: patched=' + snap.patched + ' 日志=' + JSON.stringify(snap.logs || []));
    if (result && typeof result === 'object') result.snapshotPatch = snap;
  } catch (e) {
    console.error('[auto-fetch] ' + tag + ' 快照补当日竞价字段失败:', e && e.message);
  }
}

/**
 * [RUNLOG 2026-09-30] 把这一轮的运行结果落库到 bidding_fetch_log（含 ⏱ 埋点断点）。
 * 只写日志表，失败静默（见 data/supabase-write.js#writeRunLog），绝不影响主流程。
 */
async function persistRunResult(env, point, result) {
  const r = result || {};
  await writeRunLog(env, {
    time_point: point,
    run_date: r.today || r.date || '',
    ok: r.ok === true,
    detail: {
      elapsedMs: r.elapsedMs === undefined ? null : r.elapsedMs,
      finishedAtBj: r.finishedAtBj || '',
      p0Overrun: !!r.p0Overrun,
      ladderDegraded: !!r.ladderDegraded,
      // [LADDER-SRC 2026-11-03 用户口径] 同花顺「最近多板」(883410) 源数据条数。
      //   前端 logic/auction/ladder-source.js 读这个字段显示在第一页（用户拿它对炒股软件）。
      //   ⚠️ null = 本轮没走到那一步（如名单落库失败提前返回）⇒ 前端显示 `--`，⛔ 不补 0。
      ladderCount: r.ladderCount === undefined ? null : r.ladderCount,
      // [LADDER-FALLBACK 2026-11-06] 名单自愈留痕：真名单恢复 / 兜底 / 写入行数
      ladderHealRecovered: !!r.ladderHealRecovered,
      ladderHealFallback: !!r.ladderHealFallback,
      ladderHealWritten: r.ladderHealWritten === undefined ? null : r.ladderHealWritten,
      watchlistRowsWritten: r.watchlistRowsWritten === undefined ? null : r.watchlistRowsWritten,
      // [LADDER26 2026-11-06] 09:26 二次确认留痕：是否跳过 / 名单恢复 / 兜底清理 / 猫抓补抓
      ladderRecheckSkipped: !!r.skipped,
      ladderRecheckRecovered: !!r.recovered,
      ladderRecheckFallbackCleared: r.fallbackCleared === undefined ? null : r.fallbackCleared,
      ladderRecheckAuc: r.auc || null,
      // [R20-CLOUD 2026-11-06] 同一趟 9:26 的 20 日涨幅云端补缺结果
      range20Written: r.range20Written === undefined ? null : r.range20Written,
      // [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐（替代本机 08:00 任务）
      dailyLegsWritten: r.dailyLegsWritten === undefined ? null : r.dailyLegsWritten,
      todayDataMissing: !!r.todayDataMissing,
      todayMetricsWritten: r.todayMetricsWritten === undefined ? null : r.todayMetricsWritten,
      metricsWritten: r.metricsWritten === undefined ? null : r.metricsWritten,
      rangeWritten: r.rangeWritten === undefined ? null : r.rangeWritten,
      // [AUC-SANE 2026-10-12] 竞价涨幅越界闸门：>0 说明上游 numcat 又给了物理不可能的坏值
      aucPctOutOfRange: r.aucPctOutOfRange === undefined ? null : r.aucPctOutOfRange,
      aucPctRepaired: r.aucPctRepaired === undefined ? null : r.aucPctRepaired,
      completenessSummary: r.completenessSummary || '',
      logs: Array.isArray(r.logs) ? r.logs : []
    }
  });
}

/**
 * ★ [HEAL-0927 2026-11-04] 9:27 这一趟必须在【9:30 开盘前】把数据补齐，所以不能「一看到
 *   非终态就放弃」——上游 data_status 从 pending 跳到 final 往往就差几秒。
 *   策略：非终态时等 3 秒再试，最多 4 次（最坏拖到约 9:27:15，仍远早于开盘）。
 *   · 除「非终态」以外的任何原因（日期不符 / 无行 / 无 timestamp / 读失败）都不重试
 *     —— 那些等多久都不会变，重试只是白等（§32 不做无意义请求）。
 *   · 不烧任何额度：快照接口免费，区间涨幅那一步才有额度成本。
 */
const HEAL_SNAP_RETRY = 4;
const HEAL_SNAP_WAIT_MS = 3000;

async function runSnapshotPatchUntilFinal(env, date) {
  let last = null;
  const allLogs = [];
  for (let i = 0; i < HEAL_SNAP_RETRY; i++) {
    last = await runTodaySnapshotPatch(env, { date: date });
    (last.logs || []).forEach(l => allLogs.push(i === 0 ? l : '(重试' + (i + 1) + ') ' + l));
    if (last.reason !== '非终态') break;
    if (i < HEAL_SNAP_RETRY - 1) {
      allLogs.push('[snapshot] 非终态（上游还没结算完）→ 等 ' + (HEAL_SNAP_WAIT_MS / 1000) + 's 后重试');
      await new Promise(r => setTimeout(r, HEAL_SNAP_WAIT_MS));
    }
  }
  return Object.assign({}, last, { logs: allLogs });
}

async function dispatch(point, env, logs, opts) {
  // [JIWANG-SHOUGU-CLOUD 2026-11-08] 手动入口：立即回补昨收盘结果（含历史缺口），
  //   不改变任何已有非空值；16:00 close 轮也会自动跑一次。
  if (point === 'jiwang') {
    const r = await runJiwangCloseWrite(env);
    console.log('[auto-fetch] jiwang 昨收盘结果云端落库: ok=' + r.ok + ' written=' + r.written +
      ' 日志=' + JSON.stringify(r.logs || []));
    return r;
  }
  if (point === 'morning') {
    const result = await runMorning(env);
    console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
    // [RUNLOG 2026-09-30] 先落库再跑快照补漏：P0 时延证据要第一时间写下去
    await persistRunResult(env, point, result);
    // [SNAPSHOT-EXTRAS 2026-09-14] 9:25 竞价刚结束 → 立刻补当天三个竞价字段（趋势图/龙徽章/一字红线依赖它们）
    await runSnapshotPatchSafely(env, result, 'morning');
    return result;
  }
  if (point === 'close') {
    // [REPAIR-DATE 2026-09-11] 支持 ?date=YYYY-MM-DD 指定要覆盖/修复的交易日（默认北京今天）。
    const result = await runClose(env, { date: opts && opts.date });
    console.log('[auto-fetch] runClose 完成 ok=' + result.ok + ' today=' + (result.today || '') +
      ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runClose 完整日志:', JSON.stringify(result.logs || []));
    // [DAILY-LEGS-CLOUD 2026-11-06] 运行日志改在本轮全部补写动作之后落库，
    //   这样 dailyLegsWritten 也会进 bidding_fetch_log，事后可核验「云端是否真的接管」。
    // [SNAPSHOT-EXTRAS 2026-09-14] 收盘后再兜一次（防止 9:25 那次快照未终态 / 漏掉新进名单的票）
    await runSnapshotPatchSafely(env, result, 'close');
    // [DAILY-LEGS-CLOUD 2026-11-06] 收盘覆盖完成后，把「今天这根收盘腿」写进 stock_daily_pct。
    //   这是明天 9:26 的 20 日涨幅快路径能否 0 上游请求算出真值的前提；
    //   以前靠本机 08:00 定时任务补，现在随 worker 自动跑（⛔ 关电脑不影响）。
    try {
      const legs = await runDailyLegsHeal(env, {});
      result.dailyLegs = legs;
      result.dailyLegsWritten = legs.written;
      console.log('[auto-fetch] close 逐日腿云端补齐: ok=' + legs.ok + ' written=' + legs.written +
        ' 日志=' + JSON.stringify(legs.logs || []));
    } catch (e) {
      console.error('[auto-fetch] close 逐日腿云端补齐异常（不影响收盘）:', e && e.message);
    }
    // [BIDDING-CLOSE-CLOUD 2026-11-07] 收盘列云端落库（幂等填空、只允许当天、失败不连坐）。
    //   放在所有行情/涨幅写入之后：这一轮已经把当天收盘涨幅算完，快照此时是终态。
    try {
      const bcw = await runBiddingCloseWrite(env, { date: (opts && opts.date) || '' });
      result.biddingCloseWritten = bcw.written;
      if (Array.isArray(result.logs)) result.logs.push.apply(result.logs, (bcw.logs || []).map(l => '[bidding-close] ' + l));
      console.log('[auto-fetch] close 竞价看板收盘列云端落库: ok=' + bcw.ok +
        ' written=' + bcw.written + ' skipped=' + !!bcw.skipped + ' 日志=' + JSON.stringify(bcw.logs || []));
    } catch (e) {
      // 失败必须可见（§10），但绝不拖垮已经成功的 runClose
      const msg = '[bidding-close] ❌ 云端落库异常（不影响收盘主流程）: ' + (e && e.message);
      if (Array.isArray(result.logs)) result.logs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    // [JIWANG-SHOUGU-CLOUD 2026-11-08] 昨收盘结果（跌:涨）云端落库 + 10 日窗口回补历史缺口。
    //   放在最后：与上面的竞价看板收盘列互不依赖，任一失败都不连坐。
    try {
      const jw = await runJiwangCloseWrite(env);
      result.jiwangShouguWritten = jw.written;
      if (Array.isArray(result.logs)) result.logs.push.apply(result.logs, (jw.logs || []).map(l => '[jiwang-shougu] ' + l));
      console.log('[auto-fetch] close 昨收盘结果云端落库: ok=' + jw.ok + ' written=' + jw.written +
        ' 日志=' + JSON.stringify(jw.logs || []));
    } catch (e) {
      const msg = '[jiwang-shougu] ❌ 云端落库异常（不影响收盘主流程）: ' + (e && e.message);
      if (Array.isArray(result.logs)) result.logs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'snapshot') {
    // ★ [HEAL-0927 2026-11-04] 9:27 这一趟承担两件事（都在云端跑，不需要用户开电脑）：
    //   ① 用同花顺快照补【当日】竞价量 / 竞价涨幅 / 换手 —— 免费、0 猫抓额度；
    //      ⛔⛔ **不含竞价量比**（旧注释写「量比」是错的，2026-11-06 更正）：
    //      auc_vol_ratio 只认猫抓 daily_auc 的 9:25 竞价时间段数据，同花顺永远不许兜底。
    //      SNAPSHOT_FIELDS 实际只有 ['auc_pct_chg','auc_turnover','volume']（有单测锁）。
    //   ② 用猫抓 daily 补【当日】stock_range_pct（区间涨幅）—— 只有 9:25 那次失败时才真正发请求。
    //   为什么 ② 必须在这里：区间涨幅是「题材量比排序 + 十日涨幅列」的唯一依据，
    //   9:25 猫抓一旦超时，云端就没数据，只能等浏览器补算 ⇒ 不开电脑当天永远出不了票。
    const date = (opts && opts.date) || '';
    const snap = await runSnapshotPatchUntilFinal(env, date);
    console.log('[auto-fetch] runTodaySnapshotPatch 完成 ok=' + snap.ok + ' patched=' + snap.patched +
      ' today=' + (snap.today || ''));
    console.log('[auto-fetch] runTodaySnapshotPatch 完整日志:', JSON.stringify(snap.logs || []));
    // 区间涨幅自愈：失败不致命（内部已 try/catch 到日志），绝不影响上面的竞价字段补漏
    let range = { ok: false, written: 0, logs: ['[range-heal] 未执行'] };
    try {
      range = await runRangePctHeal(env, { date: date });
      console.log('[auto-fetch] runRangePctHeal 完成 ok=' + range.ok + ' written=' + range.written +
        ' coverage=' + (range.coverage === undefined ? '-' : (range.coverage * 100).toFixed(0) + '%'));
      console.log('[auto-fetch] runRangePctHeal 完整日志:', JSON.stringify(range.logs || []));
    } catch (e) {
      console.error('[auto-fetch] runRangePctHeal 异常:', e && e.message);
      range = { ok: false, written: 0, logs: ['[range-heal] 异常: ' + ((e && e.message) || e)] };
    }
    const result = {
      ok: snap.ok || range.ok,
      today: snap.today || (date || ''),
      snapshot: snap,
      rangeHeal: range,
      rangeWritten: range.written === undefined ? null : range.written,
      logs: (snap.logs || []).concat(range.logs || [])
    };
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'extras') {
    // [QUOTA 2026-09-11] 默认排除当天 —— 理由不是「拿不到」，而是**分工**：
    //   当天的字段由同花顺快照腿负责（`runTodaySnapshotPatch`，免费、0 猫抓额度、
    //   ⛔ 不含量比）；本函数只负责【历史日】的猫抓回填。
    //   ⇒ 把今天塞进来只会让两条腿抢同一批字段，还白烧额度。
    // ⚠️ [EXTRAS-TRUTH 2026-11-05] 旧文案写的是「猫抓对当日行不给四要素」——**已被推翻**
    //   （11-05 实测 9:25 写入的 58 只 58/58 全带 auc_vol_ratio）。结论不变，理由换成上面这条。
    // 想坚持「含当天」的旧行为用于排查时，手动加 &today=1。
    const result = await runAuctionExtrasPatch(env, { includeToday: !!(opts && opts.includeToday) });
    console.log('[auto-fetch] runAuctionExtrasPatch 完成 ok=' + result.ok + ' patched=' + (result.patched || 0) +
      ' dates=' + JSON.stringify(result.dates || []));
    console.log('[auto-fetch] runAuctionExtrasPatch 完整日志:', JSON.stringify(result.logs || []));
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'ladder26') {
    // [LADDER26 2026-11-06] 北京 09:26 云端 cron。与 `ladder` 的区别：
    //   · ladder    = 人工恢复入口，只写名单、⛔ 不烧猫抓额度、⛔ 不删兜底行；
    //   · ladder26  = 开盘前自动二次确认，名单 + 新进票猫抓补竞价量比 + 清理兜底行，
    //                 且「9:25 已成功」时 0 请求直接返回（幂等，不重复烧额度）。
    const logs26 = [];
    const r26 = await runLadderRecheck(env, { date: (opts && opts.date) || '', logs: logs26 });
    // [DAILY-LEGS-CLOUD] 先补【今天之前】漏掉的逐日腿，再算 20 日涨幅：
    //   顺序不能反 —— 昨天那根腿缺了，下面的快路径会用更早的 19 根凑数，窗口整体错位一天。
    let legs26 = { ok: false, written: 0, logs: ['[daily-legs] 未执行'] };
    try {
      legs26 = await runDailyLegsHeal(env, { allowToday: false, logs: logs26 });
    } catch (e) {
      legs26 = { ok: false, written: 0, logs: ['[daily-legs] 异常: ' + ((e && e.message) || e)] };
      logs26.push(legs26.logs[0]);
    }
    // [R20-CLOUD] 名单/行情落库之后才是补 20 日涨幅的正确时点（T 腿此刻一定有）。
    // 失败不致命：这是补缺层，正确性不依赖它，⛔ 绝不影响已写好的名单与竞价量比。
    let r20 = { ok: false, written: 0, logs: ['[r20-prefill] 未执行'] };
    try {
      r20 = await runRange20Prefill(env, { today: (opts && opts.date) || '', logs: logs26 });
    } catch (e) {
      r20 = { ok: false, written: 0, logs: ['[r20-prefill] 异常: ' + ((e && e.message) || e)] };
      logs26.push(r20.logs[0]);
    }
    const result26 = {
      ok: r26.ok || r20.ok,
      today: r26.today,
      skipped: r26.skipped,
      recovered: r26.recovered,
      written: r26.written,
      fallbackCleared: r26.fallbackCleared,
      ladderCount: r26.ladderCount,
      auc: r26.auc,
      dailyLegs: legs26,
      dailyLegsWritten: legs26.written || 0,
      range20: r20,
      range20Written: r20.written || 0,
      logs: logs26
    };
    console.log('[auto-fetch] ladder26: ok=' + result26.ok + ' skipped=' + result26.skipped +
      ' recovered=' + result26.recovered + ' written=' + result26.written +
      ' 猫抓补写=' + (r26.auc && r26.auc.written) + ' 20日补缺=' + result26.range20Written +
      ' 日志=' + JSON.stringify(logs26));
    await persistRunResult(env, point, result26);
    return result26;
  }
  if (point === 'range20') {
    // [R20-CLOUD 2026-11-06] 手动补 20 日涨幅（0 上游请求），用于验收云端链路是否已接管。
    const logs20 = [];
    const r20 = await runRange20Prefill(env, { today: (opts && opts.date) || '', logs: logs20 });
    const result20 = Object.assign({}, r20, { logs: logs20 });
    console.log('[auto-fetch] range20 云端补缺: ok=' + r20.ok + ' written=' + r20.written +
      ' 日志=' + JSON.stringify(logs20));
    await persistRunResult(env, point, result20);
    return result20;
  }
  if (point === 'ladder') {
    // [LADDER-FALLBACK 2026-11-06] 上游名单源 9:25 临时挂了之后，【只补正式名单】的恢复入口。
    // ⛔ 绝不重跑 runMorning：那样会在开盘后重算行情、再烧 1 次猫抓额度（用户硬口径：额度最贵）。
    // ⛔ 不写兜底名单：手动补名单必须用「今天真实 883410」，拿不到就如实返回 ok=false。
    const logs = [];
    const heal = await healLadderWatchlist(env, {
      today: (opts && opts.date) || '',
      logs: logs,
      allowFallback: false
    });
    const result = {
      ok: heal.ok,
      today: heal.today,
      recovered: heal.recovered,
      written: heal.written,
      ladderCount: heal.ladderCount,
      ladderDegraded: !heal.recovered,
      logs: logs
    };
    console.log('[auto-fetch] ladder 名单补写: ok=' + result.ok + ' written=' + result.written +
      ' count=' + result.ladderCount + ' 日志=' + JSON.stringify(logs));
    await persistRunResult(env, point, result);
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
    // [RUNLOG 2026-09-30] 失败也要落库：整轮抛错（如 P0-① 直接 return error）是最该留证据的情况，
    //   以前只在 Cloudflare 控制台留一行 error，事后完全查不到。
    ctx.waitUntil(dispatch(point, env, []).catch(async e => {
      console.error('[auto-fetch] ' + point + ' error:', e.message);
      await writeRunLog(env, {
        time_point: point,
        run_date: '',
        ok: false,
        detail: { error: (e && e.message) || String(e), stack: (e && e.stack) || '' }
      });
    }));
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
      if (!['morning', 'close', 'extras', 'snapshot', 'ladder', 'ladder26', 'range20', 'jiwang'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|extras|snapshot|ladder|ladder26|range20|jiwang|auto（close 可附 &date=YYYY-MM-DD 指定修复的历史交易日；extras 可附 &today=1 含当天；snapshot / ladder / ladder26 / range20 可附 &date=YYYY-MM-DD；jiwang 立即回补昨收盘结果）' });
      }
      // [JIWANG-SHOUGU-CLOUD 2026-11-08] 回补不受「当前时间必须在 9:25~16:30」限制，
      //   否则周末/夜间出事故时无法立即修复历史缺口。
      if (point === 'jiwang') {
        try {
          const r = await dispatch('jiwang', env, [], {});
          return jsonResponse(r, r.ok ? 200 : 500);
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
        }
      }
      try {
        const result = await dispatch(point, env, [], {
          date: url.searchParams.get('date') || '',
          includeToday: url.searchParams.get('today') === '1'
        });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        // [RUNLOG 2026-09-30] 手动触发失败同样落库
        await writeRunLog(env, {
          time_point: point,
          run_date: url.searchParams.get('date') || '',
          ok: false,
          detail: { error: e.message, stack: e.stack, trigger: 'manual-fetch' }
        });
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};

