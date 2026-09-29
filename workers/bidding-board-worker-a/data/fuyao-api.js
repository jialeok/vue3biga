// data/fuyao-api.js — fuyao 行情接口 + 交易日历
import { beijingToday, normalizeDate } from '../../_shared-source/date-utils.js';
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

export async function getConstituentThscodes(env, indexThscode) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return ((data && data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
}

export async function getStockSnapshotPcts(env, thscodes) {
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

export async function getIndexSnapshotPcts(env, thscodes) {
  const result = {};
  const data = await fuyaoGet(env, '/api/a-share-index/prices/snapshot', { thscodes: thscodes.join(',') });
  ((data && data.item) || []).forEach(function (it) {
    if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
      result[it.thscode] = Number(it.price_change_ratio_pct);
    }
  });
  return result;
}