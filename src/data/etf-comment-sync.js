/**
 * etf-comment-sync.js — 板块ETF点评云端同步（§8 合规双写）
 *
 * 双写（dual-write）+ 失败降级：
 *   - 写：saveEtfComment() 将 stockEtfComment（{ [date]: comment } 对象）中的每个 date
 *        upsert 到 Supabase 表 auction_etf_comment（comment 可能是字符串或对象）；
 *        失败仅 console.error 并返回 false，绝不 throw、绝不碰 localStorage
 *        （localStorage 由 auction-sync.js 保留兜底）。
 *   - 读：loadEtfComment() 从 auction_etf_comment 重建 { [date]: comment }；失败返回 null。
 *
 * 全部操作 fail-soft：Supabase 表未建 / 网络异常时，localStorage 读取路径不受影响。
 */

import { getSupabase } from './supabase-client.js';

const TABLE = 'auction_etf_comment';

/**
 * 将 stockEtfComment（{ [date]: comment }）双写到 Supabase。
 * 每个 date 一行 upsert（onConflict: date）。
 * @param {Object} data
 * @returns {Promise<boolean>} 成功 true / 失败 false（不抛异常）
 */
export async function saveEtfComment(data) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    if (data && typeof data === 'object') {
      for (const date of Object.keys(data)) {
        const { error } = await sb
          .from(TABLE)
          .upsert(
            { date, comment: data[date], updated_at: new Date().toISOString() },
            { onConflict: 'date' }
          );
        if (error) console.error('[etf-comment-sync] 上云失败：', error && error.message);
      }
    }
    return true;
  } catch (e) {
    console.error('[etf-comment-sync] 上云失败：', e && e.message);
    return false;
  }
}

/**
 * 从 Supabase 重建 stockEtfComment 对象。
 * @returns {Promise<Object|null>} 成功返回 { [date]: comment }，失败返回 null（调用方回退 localStorage）。
 */
export async function loadEtfComment() {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from(TABLE).select('date, comment');
    if (error) {
      console.error('[etf-comment-sync] 云端读取失败：', error && error.message);
      return null;
    }
    const result = {};
    (data || []).forEach((r) => {
      if (r && r.date) result[r.date] = r.comment;
    });
    return result;
  } catch (e) {
    console.error('[etf-comment-sync] 云端读取异常：', e && e.message);
    return null;
  }
}
