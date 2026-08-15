/**
 * duiban-sync.js — 对标/对板块业务数据云端同步（§8 合规）
 *
 * 唯一真相源：recent_multi_data（DuibanBoard 实际订阅的表）。
 *   - saveRecentMultiRow() 合并 upsert 一行（先读后写，避免清空 tushi/jingtu/comment 等列，§6 数据保全）。
 *   - loadRecentMulti()/subscribeRecentMulti() 负责读取与 Realtime 订阅。
 *
 * 全部操作 fail-soft：Supabase 表未建 / 网络异常时降级，数据不丢。
 *
 * 注：auction_duiban 为迁移遗留孤儿表（loadDuibanData 全代码 0 调用方，且已无写入方），
 *   相关读写函数已收敛移除，不再维护；仅保留 Supabase 表结构（数据不丢）。
 */
import { getSupabase } from './supabase-client.js';

/**
 * 合并 upsert 一行到 recent_multi_data（按 date 冲突）。
 * 与 saveEtfBoardRow 对齐：先读已有行再合并，避免 upsert 整行替换把 tushi/jingtu/comment 等列清空（§6 数据保全）。
 * @param {Object} row 至少含 date；可只传 shuliang/die_count/zhang_count/die_zhangbi 等部分字段
 * @returns {Promise<{ok:boolean, error?:*, data?}>}
 */
export async function saveRecentMultiRow(row) {
  if (!row || !row.date) return { ok: false, error: new Error('row.date required') };
  try {
    const sb = getSupabase();
    if (!sb) return { ok: false, error: new Error('no supabase') };
    let merged = { ...row };
    const { data: existing } = await sb.from('recent_multi_data').select('*').eq('date', row.date).maybeSingle();
    if (existing) merged = { ...existing, ...row, date: row.date };
    merged.updated_at = new Date().toISOString();
    const { data, error } = await sb.from('recent_multi_data').upsert(merged, { onConflict: 'date' }).select().single();
    if (error) return { ok: false, error };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 模块级 Realtime 订阅（§31）：统一持有 recent_multi_data 的 channel，引用计数管理，
 * 当最后一个订阅者离开时 unsubscribe，避免重复订阅。
 * 注意：DuibanBoard 当前数据源为 recent_multi_data（未上云 auction_duiban），
 * 故在此为 recent_multi_data 建立订阅。若将来统一走 auction_duiban，可迁移订阅目标。
 *
 * @param {(payload: Object) => void} cb Realtime 事件回调
 * @returns {() => void} 取消订阅函数
 */
let _recentMultiChannel = null;
const _recentMultiListeners = new Set();

function _ensureRecentMultiChannel() {
  if (_recentMultiChannel) return _recentMultiChannel;
  const sb = getSupabase();
  if (!sb || typeof sb.channel !== 'function') return null;
  _recentMultiChannel = sb
    .channel('recent_multi_data_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'recent_multi_data' }, (payload) => {
      _recentMultiListeners.forEach((fn) => {
        try { fn(payload); } catch (e) {
          console.error('[duiban-sync] realtime listener error:', e && e.message);
        }
      });
    })
    .subscribe((status) => {
      // §31 Realtime 生命周期自愈：channel 进入错误/超时态时，移除坏 channel 并在仍有
      // 订阅者时重建，避免事件静默丢失（表现为只有手动刷新/切日期才更新）。
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        try { getSupabase()?.removeChannel(_recentMultiChannel); } catch (e) {}
        _recentMultiChannel = null;
        if (_recentMultiListeners.size > 0) _ensureRecentMultiChannel();
      }
    });
  return _recentMultiChannel;
}

export function subscribeRecentMulti(cb) {
  if (typeof cb !== 'function') return () => {};
  _recentMultiListeners.add(cb);
  _ensureRecentMultiChannel();
  return () => {
    _recentMultiListeners.delete(cb);
    if (_recentMultiListeners.size === 0 && _recentMultiChannel) {
      try { getSupabase()?.removeChannel(_recentMultiChannel); } catch (e) {}
      _recentMultiChannel = null;
    }
  };
}
