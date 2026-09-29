// trading-day-overrides.js — 「交易日覆盖表」前端读写（Data 层）
//
// ============================================================================
// 为什么需要这张表（2026-09-29）
// ----------------------------------------------------------------------------
// 「用户在顶栏日期栏标的假期」原来只存在浏览器 localStorage 里（模块键 holidays/tradingDays），
// 通过 saveData() → scheduleCloudPush() 只推到一个前端自用的 blob，**worker 完全读不到**。
// 于是用户标得再认真，worker 那边照样按自己的硬编码表跑 → 两次真实翻车：
//   · 2026-09-25（中秋）标了假期，但硬编码表漏了这天 → worker 把休市日当交易日跑整轮；
//   · 2026-10-08 硬编码表多写了这天 → 开市日被判非交易日 → 早盘/收盘两轮整轮 skip。
//
// 所以这里新建一张**极窄**的表 `trading_day_overrides`（只有 date + is_holiday），作为
// 「用户意志」在云端的唯一真相源（§6），前端写、worker 读，两边用同一份判据。
//
// 【为什么是 (date, is_holiday) 布尔，而不是「假期日期列表」】
//   取消假期必须能被表达。若用「列表里有 = 假期」，取消就只能删行 —— 而删行之后
//   worker 会回退到硬编码表，假期又被「复活」（用户明明取消过）。用布尔行则可以下一条
//   is_holiday=false 的记录，显式压过硬编码表（见 workers/_shared-source/trading-day.js 的优先级）。
//
// 【优先级】用户设置 > 周末 > fuyao 日历 > 硬编码表（三源合一的唯一实现在 worker 侧）
//
// 【分层】本文件是 Data 层，只负责「读写云端表 + 计算合并结果」，**不碰 Logic 层的缓存**。
//   合并结果由调用方（UI/编排层）交给 logic/date/trading-day-helpers.js#replaceHolidayCaches 落缓存。
import { getSupabase, loadAllData } from './supabase-client.js';

export const TRADING_DAY_OVERRIDES_TABLE = 'trading_day_overrides';

/**
 * 读全表。
 * ⚠️ §10：读取失败**必须抛错**，由调用方决定降级 —— 绝不能把「读不到」当成「用户没设置」，
 *    否则一次网络抖动就会让用户标好的假期在本机被抹掉。
 * @returns {Promise<Array<{date:string, is_holiday:boolean}>>}
 */
export async function fetchTradingDayOverrides() {
  const sb = getSupabase();
  const { data, error } = await sb.from(TRADING_DAY_OVERRIDES_TABLE).select('date,is_holiday');
  if (error) throw new Error('读取交易日覆盖表失败: ' + error.message);
  return (Array.isArray(data) ? data : []).filter(r => r && r.date);
}

/**
 * 写入（或覆盖）某一天的设置。
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {boolean} isHoliday true=假期；false=显式取消假期
 * @param {string} [updatedBy]
 */
export async function saveTradingDayOverride(dateStr, isHoliday, updatedBy) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const sb = getSupabase();
  const { error } = await sb.from(TRADING_DAY_OVERRIDES_TABLE).upsert({
    date: dateStr,
    is_holiday: !!isHoliday,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy || 'frontend'
  }, { onConflict: 'date' });
  if (error) throw new Error('保存交易日覆盖失败: ' + error.message);
  return true;
}

/**
 * 启动同步：以云端覆盖表为准，算出该应用的 holidays / tradingDays 全量。
 *
 * 【迁移保护 / §10 宁缺勿错】本地 localStorage 里可能存在「云端表还没有」的标注
 *   （用户在本功能上线前就标过，例如 9/25 中秋）。这时**绝不能**用云端空表覆盖本地 ——
 *   那会把用户已经标好的假期静默抹掉。因此：本地有、云端没有的日期先补传一次，再返回合并结果。
 *   已经被用户取消过的日期不会因此复活：取消会写一条 is_holiday=false 的记录，云端并非「没有该日期」。
 *
 * @returns {Promise<{ok:boolean, holidays?:string[], tradingDays?:string[], error?:string}>}
 *          调用方拿到 holidays/tradingDays 后应交给 replaceHolidayCaches() 落缓存。
 */
export async function pullTradingDayOverrides() {
  const data = loadAllData();
  const localHol = (Array.isArray(data.holidays) ? data.holidays : []).filter(Boolean).map(String);
  const localTd = (Array.isArray(data.tradingDays) ? data.tradingDays : []).filter(Boolean).map(String);

  let rows;
  try {
    rows = await fetchTradingDayOverrides();
  } catch (e) {
    // 读失败：不返回任何结果，调用方保持本地缓存不动（本地至少不比现状差），如实记日志（§10）
    console.warn('[TRADING-DAY] ' + (e && e.message) + ' → 保留本地假期缓存不变');
    return { ok: false, error: (e && e.message) || '读取失败' };
  }

  const cloudDates = new Set(rows.map(r => String(r.date)));
  const missing = [];
  localHol.forEach(d => { if (!cloudDates.has(d)) missing.push({ date: d, is_holiday: true, updated_by: 'frontend-migrate' }); });
  localTd.forEach(d => { if (!cloudDates.has(d)) missing.push({ date: d, is_holiday: false, updated_by: 'frontend-migrate' }); });

  if (missing.length > 0) {
    try {
      const sb = getSupabase();
      const { error } = await sb.from(TRADING_DAY_OVERRIDES_TABLE).upsert(missing, { onConflict: 'date' });
      if (error) throw new Error(error.message);
      console.info('[TRADING-DAY] 已把本地独有的 ' + missing.length + ' 条假期标注补传到云端覆盖表（迁移）');
    } catch (e) {
      // 补传失败不阻断：继续用「云端 ∪ 本地」返回，本机行为与迁移前一致
      console.warn('[TRADING-DAY] 本地假期补传云端失败（继续用「云端 ∪ 本地」合并）: ' + (e && e.message));
    }
    rows = rows.concat(missing.map(m => ({ date: m.date, is_holiday: m.is_holiday })));
  }

  const holidays = rows.filter(r => r.is_holiday === true).map(r => String(r.date));
  const tradingDays = rows.filter(r => r.is_holiday !== true).map(r => String(r.date));
  return { ok: true, holidays, tradingDays };
}
