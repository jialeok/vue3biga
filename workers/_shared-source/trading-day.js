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
import { isWeekend } from './date-utils.js';
import { KNOWN_HOLIDAYS } from './holidays.js';

/** 用户覆盖表（与 db/create_trading_day_overrides.sql 同名） */
export const TRADING_DAY_OVERRIDES_TABLE = 'trading_day_overrides';

/** 覆盖表内存缓存有效期：一轮 worker 执行只读一次，跨请求也不会长期不刷新 */
const OVERRIDE_CACHE_TTL_MS = 60 * 1000;
let _overrideCache = null;
let _overrideCacheAt = 0;

/** 仅供测试：清空覆盖表缓存 */
export function _resetTradingDayOverrideCache() {
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
export async function fetchTradingDayOverrides(baseUrl, key) {
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
export function mergeTradingDay(dateStr, overrideMap, fuyaoDates) {
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
export async function resolveIsTradingDay(env, baseUrl, key, dateStr, fuyaoDates, logs) {
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
