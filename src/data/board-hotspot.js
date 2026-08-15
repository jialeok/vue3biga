import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _hotspotMemCache, _lastPushed } from './board-state.js';

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
    const hasData = data && typeof data.content === 'string';
    const val = hasData ? data.content : (_hotspotMemCache[date] || '');
    _hotspotMemCache[date] = val;
    _lastPushed.hotspot[date] = val;
  } catch (e) {
    _warn('loadHotspotForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveHotspotForDate(date) {
  if (!date) return;
  const content = _hotspotMemCache[date] || '';
  try {
    const sb = getSupabase();
    await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
    _lastPushed.hotspot[date] = content;
  } catch (e) {
    _warn('saveHotspotForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadHotspotForDate, saveHotspotForDate };
