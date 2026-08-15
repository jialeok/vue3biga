import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _rankMemCache, _lastPushed } from './board-state.js';

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
    const hasData = data && Array.isArray(data.data);
    const val = hasData ? data.data : (_rankMemCache[date] || []);
    _rankMemCache[date] = val;
    _lastPushed.rank[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadRankForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveRankForDate(date) {
  if (!date) return;
  const data = _rankMemCache[date] || [];
  try {
    const sb = getSupabase();
    await sb.from('rank_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.rank[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveRankForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadRankForDate, saveRankForDate };
