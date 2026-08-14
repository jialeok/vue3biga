// §16 域拆分：multi 域（纯 getter，原 app-core.js getMultiData）
import { state } from '../app-state.js';
import { loadAllData } from '../../data/supabase-client.js';

export function getMultiData() {
    return state._multiMemCache || loadAllData().multi;
}
