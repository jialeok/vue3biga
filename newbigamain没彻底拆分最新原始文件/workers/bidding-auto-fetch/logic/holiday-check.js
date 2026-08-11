// holiday-check.js — 交易日判断（优先 fuyao 交易日历，失败回退本地）
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { fuyaoCalendarTradingDays } from '../data/fuyao-api.js';

export async function isTradingDay(env, dateStr) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    return dates.includes(dateStr);
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退本地日历:', e.message);
    return localIsTradingDay(dateStr);
  }
}

// 取"截止到 todayStr（含）"最近 n 个真实交易日，升序返回 ["YYYY-MM-DD", ...]
// 【FIX 2026-08-03】优先走 fuyao 交易日历，失败时回退本地节假日表推算
export async function getRecentTradingDays(env, todayStr, n) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    const upToToday = dates.filter(d => d <= todayStr);
    if (upToToday.length > 0) {
      return upToToday.slice(-n);
    }
  } catch (e) {
    console.warn('[RECENT-TD] fuyao 交易日历失败，回退本地日历: ' + e.message);
  }
  const result = [];
  let ms = Date.parse(todayStr + 'T00:00:00+08:00');
  for (let i = 0; i < 60 && result.length < n; i++) {
    const d = new Date(ms);
    const s = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    if (localIsTradingDay(s)) result.unshift(s);
    ms -= 24 * 3600 * 1000;
  }
  return result;
}