import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _tagTitlesMemCache, _lastPushed, _cloudRowExists, _loadFailedDates } from './board-state.js';

function _defaultTagTitles() {
  return {
    recentMulti: { tags: [], active: {}, score: 0 },
    sectorEtf: { tags: [], active: {}, score: 0 },
    topicDirection: { tags: [], active: {}, score: 0 },
    consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
  };
}

// 「全空但结构合法」判定：只用于【保存侧】决定要不要为云端不存在的一天新建一条空行。
// ⚠️ 结构合法 ≠ 有内容 —— 旧代码正是把这种对象当真实数据推上云，核对时完全看不出被清空。
function _isBlankTagTitles(v) {
  if (!v || typeof v !== 'object') return true;
  const groupBlank = (k) => {
    const t = v[k];
    if (!t || typeof t !== 'object') return true;
    const tags = Array.isArray(t.tags) ? t.tags.length : 0;
    const active = t.active && typeof t.active === 'object' ? Object.keys(t.active).length : 0;
    return tags === 0 && active === 0;
  };
  const c = v.consecutiveUp;
  const cBlank = !c || typeof c !== 'object'
    || ((Number(c.duoban) || 0) === 0 && (Number(c.bankuai) || 0) === 0 && (Number(c.ticai) || 0) === 0);
  return groupBlank('recentMulti') && groupBlank('sectorEtf') && groupBlank('topicDirection') && cBlank;
}

async function loadTagTitlesForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('tag_titles_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    if (data && data.data && typeof data.data === 'object') {
      _tagTitlesMemCache[date] = data.data;
      _cloudRowExists.tagTitles.add(date);   // 云端确实有这一天（保存时才允许写全空结构）
    } else {
      // 云端没有这一天：内存里若已有（本地正在编辑）就保留，否则给默认结构当只读回退。
      if (!Object.prototype.hasOwnProperty.call(_tagTitlesMemCache, date)) {
        _tagTitlesMemCache[date] = _defaultTagTitles();
      }
      _cloudRowExists.tagTitles.delete(date);
    }
    _loadFailedDates.tagTitles.delete(date); // 本次读到了 ⇒ 解除禁写
    _lastPushed.tagTitles[date] = JSON.stringify(_tagTitlesMemCache[date]);
  } catch (e) {
    // ★ [BOARD-LOST-G3 2026-10-28 · §10 读取失败 ≠ 空数据]
    _loadFailedDates.tagTitles.add(date);
    _warn('loadTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveTagTitlesForDate(date) {
  if (!date) return;
  // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11 宁缺勿错]
  //   ① 这一天【读取失败过】⇒ 禁止保存（§10：读取失败绝不当成「用户清空了」）；
  //   ② 云端本来【没有】这一天，且本次要写的还是「全空但结构合法」⇒ 不推。
  //      这条最要紧：旧写法 `_tagTitlesMemCache[date] || {recentMulti:{tags:[]…}}` 会凭空造一份
  //      看起来像真实数据的空结构写进云端，用户核对时完全看不出这一天被清空了。
  //   ⚠️ 反向必须放行：云端有这一天 + 用户真的清空标签 ⇒ 照常推。
  if (_loadFailedDates.tagTitles.has(date)) {
    _warn('saveTagTitlesForDate ' + date + ' 跳过：该日期云端读取失败过（§10 读取失败 ≠ 空数据）');
    return;
  }
  const data = _tagTitlesMemCache[date];
  if (!data) return;
  if (_isBlankTagTitles(data) && !_cloudRowExists.tagTitles.has(date)) return;
  try {
    const sb = getSupabase();
    await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
    _cloudRowExists.tagTitles.add(date);
    _lastPushed.tagTitles[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadTagTitlesForDate, saveTagTitlesForDate, _isBlankTagTitles };
