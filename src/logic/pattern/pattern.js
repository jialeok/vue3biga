// §16 域拆分：pattern 域（纯 getter，原 app-core.js getPatternData）
import { state } from '../app-state.js';
if (!state._patternMemCache) state._patternMemCache = {}; // §6.1：域缓存下沉，pattern 域拥有 _patternMemCache
import { loadAllData, getSupabase } from '../../data/supabase-client.js';

export function getPatternData() {
    return state._patternMemCache || loadAllData().pattern;
}

// §10：提供可 await 的真实持久化入口，返回成功/失败，禁用静默成功。
// 列名对齐 remaining-boards.savePatternForDate（pattern_data: update_flag / keep_flag），onConflict='date' 幂等。
export async function savePatternData(date, { content, update, keep }) {
    const sb = getSupabase();
    if (!sb) {
        const err = new Error('Supabase 客户端不可用');
        console.error('[pattern] savePatternData 失败：', err.message);
        throw err;
    }
    try {
        const { error } = await sb
            .from('pattern_data')
            .upsert({
                date,
                content: content || '',
                update_flag: !!update,
                keep_flag: !!keep,
            }, { onConflict: 'date' });
        if (error) {
            console.error('[pattern] savePatternData 失败：', error.message || error);
            throw error;
        }
        return { success: true };
    } catch (e) {
        console.error('[pattern] savePatternData 异常：', e && e.message);
        throw e;
    }
}
