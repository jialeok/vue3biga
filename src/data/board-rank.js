import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _rankMemCache, _lastPushed, _cloudRowExists, _loadFailedDates } from './board-state.js';

async function loadRankForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('rank_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    if (data && Array.isArray(data.data)) {
      _rankMemCache[date] = data.data;
      _cloudRowExists.rank.add(date);       // 云端确实有这一天（保存时才允许写空值）
    } else {
      // 云端没有这一天：内存里若已有（本地编辑中 / 迁移来的旧值）就保留，否则给空数组当只读回退。
      if (!Object.prototype.hasOwnProperty.call(_rankMemCache, date)) _rankMemCache[date] = [];
      _cloudRowExists.rank.delete(date);    // 云端没有 ⇒ 之后不许凭「空值」去创建一条垃圾行
    }
    _loadFailedDates.rank.delete(date);     // 本次读到了 ⇒ 解除禁写
    _lastPushed.rank[date] = JSON.stringify(_rankMemCache[date]);
  } catch (e) {
    // ★ [BOARD-LOST-G3 2026-10-28 · §10 读取失败 ≠ 空数据] 记下「这一天没读到」，
    //   保存侧据此拒绝推送 —— 否则网络抖一下就会用空值覆盖云端有内容的整行。
    _loadFailedDates.rank.add(date);
    _warn('loadRankForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveRankForDate(date) {
  if (!date) return;
  // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11 宁缺勿错]
  //   ① 这一天【读取失败过】⇒ 禁止保存（§10：读取失败绝不当成「用户清空了」）；
  //   ② 云端本来【没有】这一天，且本次要写的也是空值 ⇒ 不推（否则每次刷新都白建一条 data: []，污染表 + 白花一个写请求）。
  //   ⚠️ 反向必须放行：云端有这一天（哪怕现在是空）+ 用户把它清空 ⇒ 照常推（§10 不把「已知为空」也挡掉）。
  //   背景与被挡掉的实测空写（rank_data / multi_data / hotspot_data / tag_titles_data 各一条）见 board-state.js 同一段注释。
  if (_loadFailedDates.rank.has(date)) {
    _warn('saveRankForDate ' + date + ' 跳过：该日期云端读取失败过（§10 读取失败 ≠ 空数据）');
    return;
  }
  const data = _rankMemCache[date] || [];
  if (Array.isArray(data) && data.length === 0 && !_cloudRowExists.rank.has(date)) return;
  try {
    const sb = getSupabase();
    await sb.from('rank_data').upsert({ date, data }, { onConflict: 'date' });
    _cloudRowExists.rank.add(date);
    _lastPushed.rank[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveRankForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadRankForDate, saveRankForDate };
