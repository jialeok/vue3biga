// §16 域拆分：pattern 域（纯 getter，原 app-core.js getPatternData）
import { state } from '../app-state.js';
if (!state._patternMemCache) state._patternMemCache = {}; // §6.1：域缓存下沉，pattern 域拥有 _patternMemCache
import { loadAllData } from '../../data/supabase-client.js';

export function getPatternData() {
    return state._patternMemCache || loadAllData().pattern;
}
