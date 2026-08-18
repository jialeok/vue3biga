import { loadAllData } from '../../data/supabase-client.js';
let _getLocalTodayStrFn = null;
export function _setGetLocalTodayStr(fn) { _getLocalTodayStrFn = fn; }

const _prevTdMemo = new Map();

// [FIX 2026-08-16] §33 性能：getHolidays/getTradingDays 原来每次都调 loadAllData()，
// 而 loadAllData 是 500ms 短路热路径。第二页每个题材组渲染 → getRankAppearText →
// getTopicRankCountThisWeek → getLast5TradingDays → isTradingDay（内部调 getHolidays +
// getTradingDays）→ 一次渲染数百次 loadAllData 调用，是 RANK-CACHE 刷屏与主线程卡死主因。
// 改为按 allData 引用缓存：引用未变（未重建）时直接返回缓存数组，零重复开销；
// 重建（引用变化）时自动取新数组。与 §6 allData=内存缓存、重建换引用的语义一致。
let _holidaysRef = null;
let _holidaysCache = null;
let _tradingDaysRef = null;
let _tradingDaysCache = null;

export function getHolidays() {
  const data = loadAllData();
  if (data !== _holidaysRef) {
    _holidaysRef = data;
    if (!data.holidays) data.holidays = [];
    _holidaysCache = data.holidays;
  }
  return _holidaysCache;
}

export function getTradingDays() {
  const data = loadAllData();
  if (data !== _tradingDaysRef) {
    _tradingDaysRef = data;
    if (!data.tradingDays) data.tradingDays = [];
    _tradingDaysCache = data.tradingDays;
  }
  return _tradingDaysCache;
}

export function isAutoHoliday(dateStr) {
  const tradingDays = getTradingDays();
  if (tradingDays.includes(dateStr)) return false;
  if (tradingDays.length === 0) return false;
  const today = _getLocalTodayStrFn();
  const oneYearAgo = (function() {
    const d = new Date(today + 'T00:00:00');
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  // [FIX 2026-08-18] autoHoliday 仅用于「回顾性」兜底——过去一年里用户未记录的休市日。
  // 不含今天及未来：今天数据尚未录入，未记录≠休市，否则早上打开应用会把当天误判为
  // 假期 → isWeekend(今天)=true → useStatsView.boardView='weekly' → 显示周末统计看板。
  // 与 DashboardView.vue 行 353 日历着色逻辑（dateStr < todayLocal）保持一致。
  return dateStr >= oneYearAgo && dateStr < today;
}

export function isTradingDay(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const holidays = getHolidays();
  if (holidays.includes(dateStr)) return false;
  const tradingDays = getTradingDays();
  if (tradingDays.includes(dateStr)) return true;
  if (isAutoHoliday(dateStr)) return false;
  return true;
}

export function getPreviousTradingDay(dateStr) {
  if (!dateStr) return null;
  const hol = getHolidays();
  const cached = _prevTdMemo.get(dateStr);
  if (cached && cached.hol === hol) return cached.v;
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() - 1);
  let result = null;
  for (let i = 0; i < 60; i++) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const checkDateStr = `${year}-${month}-${day}`;
    if (checkDateStr < '2025-01-01') { result = null; break; }
    if (isTradingDay(checkDateStr)) {
      result = checkDateStr;
      break;
    }
    date.setDate(date.getDate() - 1);
  }
  _prevTdMemo.set(dateStr, { hol: hol, v: result });
  return result;
}

const _nextTdMemo = new Map();

export function getNextTradingDay(dateStr) {
  if (!dateStr) return null;
  const hol = getHolidays();
  const cached = _nextTdMemo.get(dateStr);
  if (cached && cached.hol === hol) return cached.v;
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + 1);
  let result = null;
  for (let i = 0; i < 60; i++) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const checkDateStr = `${year}-${month}-${day}`;
    if (isTradingDay(checkDateStr)) {
      result = checkDateStr;
      break;
    }
    date.setDate(date.getDate() + 1);
  }
  _nextTdMemo.set(dateStr, { hol: hol, v: result });
  return result;
}

export function getPreviousCalendarDay(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const ds = `${year}-${month}-${day}`;
  if (ds < '2025-01-01') return null;
  return ds;
}

export function getNextCalendarDay(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isWeekend(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const day = date.getDay();
  if (day === 0 || day === 6) return true;
  return !isTradingDay(dateStr);
}

/**
 * 切换某日期的「假期 / 交易日」状态（旧版日期选择器仅有"标记假期"、取消要靠清数据，本次做成真正的双向切换）。
 * - 当前是假期 -> 切为交易日：从 holidays 移除，并显式加入 tradingDays 以覆盖自动识别（autoHoliday）。
 * - 当前是交易日 -> 切为假期：从 tradingDays 移除，加入 holidays。
 * 返回 'holiday' | 'trading' 表示切换后的状态。
 * 注意：holidays / tradingDays 是 localStorage 配置模块（与旧版一致，无云端同步），saveData() 负责落盘。
 */
export function toggleHoliday(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const data = loadAllData();
  if (!data.holidays) data.holidays = [];
  if (!data.tradingDays) data.tradingDays = [];
  const hol = data.holidays;
  const td = data.tradingDays;
  const isHol = !isTradingDay(dateStr);
  if (isHol) {
    const hi = hol.indexOf(dateStr);
    if (hi > -1) hol.splice(hi, 1);
    if (!td.includes(dateStr)) td.push(dateStr);
  } else {
    const ti = td.indexOf(dateStr);
    if (ti > -1) td.splice(ti, 1);
    if (!hol.includes(dateStr)) hol.push(dateStr);
  }
  // 上一/下一交易日计算有记忆缓存，状态翻转后必须清空，否则结果过期
  _prevTdMemo.clear();
  _nextTdMemo.clear();
  return isHol ? 'trading' : 'holiday';
}

export function getMostRecentTradingDay() {
  const todayStr = _getLocalTodayStrFn();
  if (isTradingDay(todayStr)) return todayStr;
  let d = new Date(todayStr + 'T00:00:00');
  for (let i = 0; i < 60; i++) {
    d.setDate(d.getDate() - 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const ds = `${year}-${month}-${day}`;
    if (isTradingDay(ds)) return ds;
  }
  return todayStr;
}