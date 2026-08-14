// §16 域拆分：tagTitles 域（纯 getter，原 app-core.js getTagTitlesData）
import { state } from '../app-state.js';
import { loadAllData } from '../../data/supabase-client.js';

export function getTagTitlesData() {
    return state._tagTitlesMemCache || loadAllData().tagTitles;
}
