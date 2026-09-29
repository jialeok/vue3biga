// holiday-check.js — 交易日判断（用户设置 > 周末 > fuyao 交易日历 > 本地硬编码表）
//
// [TRADING-DAY 2026-09-29] 这里原来是「fuyao 优先，失败回退本地硬编码表」的两源实现，
//   而「用户在前端顶栏标的假期」完全不在判据里 —— 后果是休市日被算进「最近交易日窗口」，
//   让 prevDay 错位，同时把整轮早盘抓取跑在了一个根本不开市的日子上（9/28 事故的一环）。
//   现在统一走 _shared-source/trading-day.js 的三源合并（唯一实现 §6）。
import { fetchTradingDayOverrides, mergeTradingDay } from '../../_shared-source/trading-day.js';
import { msToDateStr, dateStrToMs } from '../../_shared-source/date-utils.js';
import { fuyaoCalendarTradingDays } from '../data/fuyao-api.js';
import { CONFIG } from '../config.js';

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

export async function isTradingDay(env, dateStr) {
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
export async function getRecentTradingDays(env, todayStr, n) {
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
