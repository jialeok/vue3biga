// data/fuyao-api.js — fuyao 行情接口 + 交易日历
import { beijingToday, beijingTodayCompact, normalizeDate } from '../../_shared-source/date-utils.js';
import { localIsTradingDay, KNOWN_HOLIDAYS } from '../../_shared-source/holidays.js';
import { CONFIG } from '../config.js';

export async function fuyaoGet(env, path, params) {
  const url = new URL(CONFIG.FUYAO_BASE + path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  }
  const resp = await fetch(url.toString(), { headers: { 'X-api-key': env.FUYAO_API_KEY } });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('fuyao ' + path + ' 错误: code=' + data.code + ' ' + (data.message || ''));
  return data.data;
}

export async function isTradingDay(env) {
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

export async function getNextTradingDay(env, today) {
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

export function localGetNextTradingDay(dateStr) {
  let d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  while (true) {
    const s = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !KNOWN_HOLIDAYS.has(s)) return s;
    d.setDate(d.getDate() + 1);
  }
}