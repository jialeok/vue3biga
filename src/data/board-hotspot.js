import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _hotspotMemCache, _lastPushed, _cloudRowExists, _loadFailedDates } from './board-state.js';

async function loadHotspotForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('hotspot_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    if (data && typeof data.content === 'string') {
      _hotspotMemCache[date] = data.content;
      _cloudRowExists.hotspot.add(date);     // 云端确实有这一天（保存时才允许写空字符串）
    } else {
      // 云端没有这一天：内存里若已有（本地正在编辑）就保留，否则给空串当只读回退。
      if (!Object.prototype.hasOwnProperty.call(_hotspotMemCache, date)) _hotspotMemCache[date] = '';
      _cloudRowExists.hotspot.delete(date);  // 云端没有 ⇒ 之后不许凭「空值」去创建一条垃圾行
    }
    _loadFailedDates.hotspot.delete(date);   // 本次读到了 ⇒ 解除禁写
    _lastPushed.hotspot[date] = _hotspotMemCache[date];
  } catch (e) {
    // ★ [BOARD-LOST-G3 2026-10-28 · §10 读取失败 ≠ 空数据] 记下「这一天没读到」，
    //   保存侧据此拒绝推送 —— 否则网络抖一下就会用空值覆盖云端有内容的整行。
    _loadFailedDates.hotspot.add(date);
    _warn('loadHotspotForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveHotspotForDate(date) {
  if (!date) return;
  // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11 宁缺勿错]
  //   ① 这一天【读取失败过】⇒ 禁止保存（§10：读取失败绝不当成「用户清空了」）；
  //   ② 云端本来【没有】这一天，且本次要写的也是空串 ⇒ 不推（否则每次刷新都白建一条空行）。
  //   ⚠️ 反向必须放行：云端有这一天 + 用户把它清空 ⇒ 照常推（`''` 是合法的「用户清空」）。
  //   背景与被挡掉的实测空写见 board-state.js 同一段注释 / .tmpdiag/audit-boot-writes.cjs。
  if (_loadFailedDates.hotspot.has(date)) {
    _warn('saveHotspotForDate ' + date + ' 跳过：该日期云端读取失败过（§10 读取失败 ≠ 空数据）');
    return;
  }
  const content = _hotspotMemCache[date];
  if (content === undefined || content === null) return;
  if (content === '' && !_cloudRowExists.hotspot.has(date)) return;
  try {
    const sb = getSupabase();
    await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
    _cloudRowExists.hotspot.add(date);
    _lastPushed.hotspot[date] = content;
  } catch (e) {
    _warn('saveHotspotForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadHotspotForDate, saveHotspotForDate };
