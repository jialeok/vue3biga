import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _multiMemCache, _lastPushed, _cloudRowExists, _loadFailedDates } from './board-state.js';

async function loadMultiForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('multi_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    if (data && Array.isArray(data.data)) {
      _multiMemCache[date] = data.data;
      _cloudRowExists.multi.add(date);
    } else {
      if (!Object.prototype.hasOwnProperty.call(_multiMemCache, date)) _multiMemCache[date] = [];
      _cloudRowExists.multi.delete(date);
    }
    _loadFailedDates.multi.delete(date);
    _lastPushed.multi[date] = JSON.stringify(_multiMemCache[date]);
  } catch (e) {
    // §10 读取失败 ≠ 空数据：保存侧据此拒绝推送（说明见 board-rank.js#loadRankForDate 同一段）
    _loadFailedDates.multi.add(date);
    _warn('loadMultiForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveMultiForDate(date) {
  if (!date) return;
  // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11 宁缺勿错] 判据与说明同 board-rank.js#saveRankForDate：
  //   读失败过 ⇒ 不推；云端本来没这一天且要写的也是空值 ⇒ 不推（不建垃圾空行）；
  //   云端有这一天 + 用户清空 ⇒ 照常推。
  if (_loadFailedDates.multi.has(date)) {
    _warn('saveMultiForDate ' + date + ' 跳过：该日期云端读取失败过（§10 读取失败 ≠ 空数据）');
    return;
  }
  const data = _multiMemCache[date] || [];
  if (Array.isArray(data) && data.length === 0 && !_cloudRowExists.multi.has(date)) return;
  try {
    const sb = getSupabase();
    await sb.from('multi_data').upsert({ date, data }, { onConflict: 'date' });
    _cloudRowExists.multi.add(date);
    _lastPushed.multi[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveMultiForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadMultiForDate, saveMultiForDate };
