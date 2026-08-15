import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _multiMemCache, _lastPushed } from './board-state.js';

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
    const hasData = data && Array.isArray(data.data);
    const val = hasData ? data.data : (_multiMemCache[date] || []);
    _multiMemCache[date] = val;
    _lastPushed.multi[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadMultiForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveMultiForDate(date) {
  if (!date) return;
  const data = _multiMemCache[date] || [];
  try {
    const sb = getSupabase();
    await sb.from('multi_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.multi[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveMultiForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadMultiForDate, saveMultiForDate };
