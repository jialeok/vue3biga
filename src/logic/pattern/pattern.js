// §16 域拆分：pattern 域（纯 getter，原 app-core.js getPatternData）
import { state } from '../app-state.js';
import { loadAllData } from '../../data/supabase-client.js';

export function getPatternData() {
    return state._patternMemCache || loadAllData().pattern;
}
