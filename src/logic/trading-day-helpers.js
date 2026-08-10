import { loadAllData } from '../data/supabase-client.js';
import { _getLocalTodayStr } from './tag-rules.js';

const _prevTdMemo = new Map();

export function getHolidays() {
  const data = loadAllData();
  if (!data.holidays) data.holidays = [];
  return data.holidays;
}

export function getTradingDays() {
  const data = loadAllData();
  if (!data.tradingDays) data.tradingDays = [];
  return data.tradingDays;
}

export function isAutoHoliday(dateStr) {
  const tradingDays = getTradingDays();
  if (tradingDays.includes(dateStr)) return false;
  if (tradingDays.length === 0) return false;
  const today = _getLocalTodayStr();
  const oneYearAgo = (function() {
    const d = new Date(today + 'T00:00:00');
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  return dateStr >= oneYearAgo && dateStr <= today;
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

export function isWeekend(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const day = date.getDay();
  if (day === 0 || day === 6) return true;
  return !isTradingDay(dateStr);
}

export function getMostRecentTradingDay() {
  const todayStr = _getLocalTodayStr();
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