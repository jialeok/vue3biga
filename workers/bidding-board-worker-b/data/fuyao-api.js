// data/fuyao-api.js — fuyao 行情接口 + 交易日历
import { beijingToday, normalizeDate } from '../../_shared-source/date-utils.js';
import { KNOWN_HOLIDAYS } from '../../_shared-source/holidays.js';
// [TRADING-DAY 2026-09-29] 交易日判定统一走 _shared-source/trading-day.js
//   （用户在前端顶栏标的假期 > 周末 > fuyao 日历 > 硬编码表），不再各写各的。
import { resolveIsTradingDay } from '../../_shared-source/trading-day.js';
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

// [FIX 2026-08-15] 获取最近多板（883410）成分股 thscode 列表
export async function getLadderConstituents(env) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: '883410.TI' });
  return ((data && data.item) || []).filter(function (it) { return it && it.thscode; });
}

// [FIX 2026-08-15] 快照接口获取一批股票的 {thscode, price_change_ratio_pct}（涨停/一字板判定用）
export async function getStockSnapshots(env, thscodes) {
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
export function isLimitUpBoard(thscode, pct) {
  if (!thscode || pct === null || pct === undefined || isNaN(pct)) return false;
  const code = String(thscode).split('.')[0];
  const isChiNext = /^30\d{4}$/.test(code);   // 创业板 300xxx
  const isSTAR = /^688\d{4}$/.test(code);     // 科创板 688xxx
  return isChiNext || isSTAR ? pct >= 19.9 : pct >= 9.9;
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