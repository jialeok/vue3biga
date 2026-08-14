/**
 * §2/§5 合规：emotion 数据 CRUD 唯一入口，UI 不得直连 Supabase。
 *
 * 本模块是 emotion_data 表在 Data 层的唯一可信访问点。
 * 视图层（EmotionBoard.vue）与 Logic 层（emotion-workflow.js）都必须
 * 经由这些导出函数读写，禁止在组件里直接 `getSupabase().from('emotion_data')`。
 *
 * 约定（参考 auctionTagStore / *-sync.js）：
 *  - 读取失败 / 云端异常一律 throw，由上层（Logic）决定 UI 表现；
 *    绝不吞成 null / []，避免「读取失败伪装成空数据」（§10/§11）。
 *  - 写入失败一律 throw，禁止静默成功（§10）。
 */
import { getSupabase } from './supabase-client.js';

const TABLE = 'emotion_data';

function _requireSupabase() {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 客户端未初始化');
  return sb;
}

/**
 * 按日期读取单日情绪数据。
 * @returns {Promise<Array>} 行数组（可能为空数组，表示「查无此日」）；
 *          网络/云端错误时 throw（不会返回 [] 伪装成功）。
 */
export async function loadEmotion(date) {
  const sb = _requireSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select('date, metrics, five_days, updated_at')
    .eq('date', date)
    .limit(1);
  if (error) throw error;
  return data || [];
}

/**
 * 读取按日期倒序的最近一行（用于「今天数据未就绪时回退到最近可用」）。
 * @returns {Promise<Array>}
 */
export async function loadLatestEmotion() {
  const sb = _requireSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select('date, metrics, five_days, updated_at')
    .order('date', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data || [];
}

/**
 * 批量 upsert（按 date 冲突更新）。
 * @param {Array} rows 行数组，每行应含 date 及 metrics/five_days。
 * @returns {Promise<true>} 成功；失败 throw。
 */
export async function saveEmotion(rows) {
  const sb = _requireSupabase();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('saveEmotion 需要非空行数组');
  }
  const { error } = await sb
    .from(TABLE)
    .upsert(rows, { onConflict: 'date' });
  if (error) throw error;
  return true;
}

/**
 * 单日 upsert（按 date 冲突更新）。
 * @param {string} date
 * @param {object} payload 除 date 外的字段（如 metrics / five_days）。
 * @returns {Promise<true>} 成功；失败 throw。
 */
export async function upsertEmotion(date, payload) {
  const sb = _requireSupabase();
  if (!date) throw new Error('upsertEmotion 需要 date');
  const { error } = await sb
    .from(TABLE)
    .upsert(
      { date, ...payload, updated_at: new Date().toISOString() },
      { onConflict: 'date' }
    );
  if (error) throw error;
  return true;
}

/**
 * 按日期删除。
 * @param {string} date
 * @returns {Promise<true>} 成功（即使该行不存在也视为成功）；失败 throw。
 */
export async function deleteEmotion(date) {
  const sb = _requireSupabase();
  if (!date) throw new Error('deleteEmotion 需要 date');
  const { error } = await sb
    .from(TABLE)
    .delete()
    .eq('date', date);
  if (error) throw error;
  return true;
}
