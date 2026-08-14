// §16 域拆分：multi 域（纯 getter，原 app-core.js getMultiData）
import { state } from '../app-state.js';
if (!state._multiMemCache) state._multiMemCache = {}; // §6.1：域缓存下沉，multi 域拥有 _multiMemCache
import { loadAllData } from '../../data/supabase-client.js';

export function getMultiData() {
    return state._multiMemCache || loadAllData().multi;
}
