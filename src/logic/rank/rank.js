// §16 域拆分：rank 域（纯 getter，原 app-core.js getRankData）
import { state } from '../app-state.js';
import { loadAllData } from '../../data/supabase-client.js';

export function getRankData() {
    return state._rankMemCache || loadAllData().rank;
}
