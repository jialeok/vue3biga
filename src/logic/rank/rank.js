// §16 域拆分：rank 域（纯 getter，原 app-core.js getRankData）
import { state } from '../app-state.js';
if (!state._rankMemCache) state._rankMemCache = {}; // §6.1：域缓存下沉，rank 域拥有 _rankMemCache
import { loadAllData } from '../../data/supabase-client.js';

export function getRankData() {
    return state._rankMemCache || loadAllData().rank;
}
