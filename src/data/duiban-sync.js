/**
 * duiban-sync.js — 对标/对板块业务数据云端同步（§8 合规）
 *
 * 双写（dual-write）+ 失败降级：
 *   - 写：saveDuibanData() 将内存 duibanData（按 date 为 key 的对象）upsert 到 Supabase 表 auction_duiban；
 *        失败仅 console.error 并返回 false，绝不 throw、绝不碰 localStorage（localStorage 由 auction-sync 兜底）。
 *   - 读：loadDuibanData() 从 auction_duiban 重建 { [date]: data }；失败返回 null，调用方回退到 localStorage。
 *
 * 全部操作 fail-soft：Supabase 表未建 / 网络异常时，localStorage 读取路径不受影响，数据不丢。
 */
import { getSupabase } from './supabase-client.js';

const TABLE = 'auction_duiban';

/**
 * 将 duibanData（{ [date]: [...] }）双写到 Supabase。
 * 每个 date 一行 upsert（onConflict: date）。
 * @param {Object} data
 * @returns {Promise<boolean>} 成功 true / 失败 false（不抛异常）
 */
export async function saveDuibanData(data) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    if (data && typeof data === 'object') {
      for (const date of Object.keys(data)) {
        const { error } = await sb
          .from(TABLE)
          .upsert(
            { date, data: data[date], updated_at: new Date().toISOString() },
            { onConflict: 'date' }
          );
        if (error) console.error('[duiban-sync] 上云失败：', error && error.message);
      }
    }
    return true;
  } catch (e) {
    console.error('[duiban-sync] 上云失败：', e && e.message);
    return false;
  }
}

/**
 * 从 Supabase 重建 duibanData 对象。
 * @returns {Promise<Object|null>} 成功返回 { [date]: data }，失败返回 null（调用方回退 localStorage）。
 */
export async function loadDuibanData() {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from(TABLE).select('date, data');
    if (error) {
      console.error('[duiban-sync] 云端读取失败：', error && error.message);
      return null;
    }
    const result = {};
    (data || []).forEach((r) => {
      if (r && r.date) result[r.date] = r.data;
    });
    return result;
  } catch (e) {
    console.error('[duiban-sync] 云端读取异常：', e && e.message);
    return null;
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
    .subscribe();
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
