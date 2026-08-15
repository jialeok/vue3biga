import { getSupabase } from './supabase-client.js';

export const ETF_BOARD_TABLE = 'early_etf_data'; // 权威源（实测40行；auction_etf/auction_etf_comment 均0行已废弃）
let _etfBoardCache = {};        // { [date]: row }
let _etfBoardHydrated = false;

export async function hydrateEtfBoardData() {
  try {
    const sb = getSupabase(); if (!sb) return;
    const { data, error } = await sb.from(ETF_BOARD_TABLE).select('*');
    if (error) { console.error('[etf-board-data] hydrate 失败:', error.message); return; }
    const map = {};
    (data || []).forEach(r => { if (r && r.date) map[r.date] = r; });
    _etfBoardCache = map; _etfBoardHydrated = true;
  } catch (e) { console.error('[etf-board-data] hydrate 异常:', e && e.message); }
}

// 同步 getter，兼容旧 getEtfData() 形状：{ [date]: [row] }（数组包裹）。未 hydrate 前返回 {}（§8 纯云端，无 localStorage 业务回退）。
export function getEtfBoardData() {
  const out = {};
  Object.keys(_etfBoardCache).forEach(d => { out[d] = [_etfBoardCache[d]]; });
  return out;
}

export async function loadEtfBoardByDate(date) {
  try {
    const sb = getSupabase(); if (!sb) return null;
    const { data, error } = await sb.from(ETF_BOARD_TABLE).select('*').eq('date', date).maybeSingle();
    if (error) { console.error('[etf-board-data] 读取失败:', error.message); return null; }
    if (data && data.date) _etfBoardCache[data.date] = data;
    return data || null;
  } catch (e) { console.error('[etf-board-data] 读取异常:', e && e.message); return null; }
}

// 保存一行；返回 { ok, error, data? }（§10 禁止静默失败）。更新缓存。
// ⚠️ Supabase upsert 是「整行替换」：若只传部分字段（如 bidding-helpers 只传 shuliang/die_zhangbi/jingtu/tushi，
// 或 saveEtfBoardComment 只传 comment），会把同日期行的其他列清空 → 数据丢失。
// 故先读取已有行合并后再 upsert 完整行（§6 数据保全）。
export async function saveEtfBoardRow(row) {
  if (!row || !row.date) return { ok: false, error: new Error('row.date required') };
  try {
    const sb = getSupabase(); if (!sb) return { ok: false, error: new Error('no supabase') };
    let merged = { ...row };
    const { data: existing } = await sb.from(ETF_BOARD_TABLE).select('*').eq('date', row.date).maybeSingle();
    if (existing) merged = { ...existing, ...row, date: row.date };
    merged.updated_at = new Date().toISOString();
    const { data, error } = await sb.from(ETF_BOARD_TABLE).upsert(merged, { onConflict: 'date' }).select().single();
    if (error) return { ok: false, error };
    if (data && data.date) _etfBoardCache[data.date] = data;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e }; }
}

export async function saveEtfBoardComment(date, comment) {
  return saveEtfBoardRow({ date, comment });
}

/**
 * 模块级 Realtime 订阅（§31）：统一持有 early_etf_data 的 channel，引用计数管理，
 * 当最后一个订阅者离开时 unsubscribe，避免重复订阅。
 * 镜像 duiban-sync.js 的 subscribeRecentMulti 模式，channel 名 'early_etf_data_rt'。
 *
 * 在 postgres_changes 回调内同步更新本地 _etfBoardCache[changedDate]，
 * 使 getEtfBoardData() 保持最新（惠及 Weekend/Monthly ETF 列表等读取方）。
 *
 * @param {(payload: Object) => void} cb Realtime 事件回调
 * @returns {() => void} 取消订阅函数
 */
let _etfBoardChannel = null;
const _etfBoardListeners = new Set();

function _ensureEtfBoardChannel() {
  if (_etfBoardChannel) return _etfBoardChannel;
  const sb = getSupabase();
  if (!sb || typeof sb.channel !== 'function') return null;
  _etfBoardChannel = sb
    .channel('early_etf_data_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: ETF_BOARD_TABLE }, (payload) => {
      // 同步本地缓存，保持 getEtfBoardData() 一致（§15 单一数据源）
      if (payload.eventType === 'DELETE') {
        const d = payload.old && payload.old.date;
        if (d) delete _etfBoardCache[d];
      } else if (payload.new && payload.new.date) {
        _etfBoardCache[payload.new.date] = payload.new;
      }
      _etfBoardListeners.forEach((fn) => {
        try { fn(payload); } catch (e) {
          console.error('[etf-board-data] realtime listener error:', e && e.message);
        }
      });
    })
    .subscribe((status) => {
      // §31 Realtime 生命周期自愈：channel 进入错误/超时态时，移除坏 channel 并在仍有
      // 订阅者时重建，避免事件静默丢失（表现为只有手动刷新/切日期才更新）。
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        try { getSupabase()?.removeChannel(_etfBoardChannel); } catch (e) {}
        _etfBoardChannel = null;
        if (_etfBoardListeners.size > 0) _ensureEtfBoardChannel();
      }
    });
  return _etfBoardChannel;
}

export function subscribeEtfBoard(cb) {
  if (typeof cb !== 'function') return () => {};
  _etfBoardListeners.add(cb);
  _ensureEtfBoardChannel();
  return () => {
    _etfBoardListeners.delete(cb);
    if (_etfBoardListeners.size === 0 && _etfBoardChannel) {
      try { getSupabase()?.removeChannel(_etfBoardChannel); } catch (e) {}
      _etfBoardChannel = null;
    }
  };
}
