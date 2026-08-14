// §16 域拆分：tagTitles 域（纯 getter，原 app-core.js getTagTitlesData）
import { state } from '../app-state.js';
if (!state._tagTitlesMemCache) state._tagTitlesMemCache = {}; // §6.1：域缓存下沉，tagTitles 域拥有 _tagTitlesMemCache
import { loadAllData } from '../../data/supabase-client.js';

export function getTagTitlesData() {
    return state._tagTitlesMemCache || loadAllData().tagTitles;
}
