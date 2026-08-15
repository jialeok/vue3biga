import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import { _patternMemCache, _lastPushed } from './board-state.js';

async function loadPatternForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('pattern_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const defaultVal = { content: '', update: false, keep: false };
    const val = data
      ? { content: data.content || '', update: !!data.update_flag, keep: !!data.keep_flag }
      : (_patternMemCache[date] || defaultVal);
    _patternMemCache[date] = val;
    _lastPushed.pattern[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadPatternForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function savePatternForDate(date) {
  if (!date) return;
  const p = _patternMemCache[date] || { content: '', update: false, keep: false };
  try {
    const sb = getSupabase();
    await sb.from('pattern_data').upsert({
      date,
      content: p.content || '',
      update_flag: !!p.update,
      keep_flag: !!p.keep
    }, { onConflict: 'date' });
    _lastPushed.pattern[date] = JSON.stringify(p);
  } catch (e) {
    _warn('savePatternForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadPatternForDate, savePatternForDate };
