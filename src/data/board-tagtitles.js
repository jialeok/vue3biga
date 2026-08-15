import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _tagTitlesMemCache, _lastPushed } from './board-state.js';

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
    const defaultVal = {
      recentMulti: { tags: [], active: {}, score: 0 },
      sectorEtf: { tags: [], active: {}, score: 0 },
      topicDirection: { tags: [], active: {}, score: 0 },
      consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
    };
    const hasData = data && data.data && typeof data.data === 'object';
    const val = hasData ? data.data : (_tagTitlesMemCache[date] || defaultVal);
    _tagTitlesMemCache[date] = val;
    _lastPushed.tagTitles[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveTagTitlesForDate(date) {
  if (!date) return;
  const data = _tagTitlesMemCache[date] || {
    recentMulti: { tags: [], active: {}, score: 0 },
    sectorEtf: { tags: [], active: {}, score: 0 },
    topicDirection: { tags: [], active: {}, score: 0 },
    consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
  };
  try {
    const sb = getSupabase();
    await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.tagTitles[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadTagTitlesForDate, saveTagTitlesForDate };
