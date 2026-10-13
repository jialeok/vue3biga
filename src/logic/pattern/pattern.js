// §16 域拆分：pattern 域（纯 getter，原 app-core.js getPatternData）
import { state } from '../app-state.js';
if (!state._patternMemCache) state._patternMemCache = {}; // §6.1：域缓存下沉，pattern 域拥有 _patternMemCache
import { loadAllData, getSupabase } from '../../data/supabase-client.js';
import { notePatternLocalWrite } from '../../data/board-state.js';

export function getPatternData() {
    return state._patternMemCache || loadAllData().pattern;
}

// §10：提供可 await 的真实持久化入口，返回成功/失败，禁用静默成功。
// 列名对齐 remaining-boards.savePatternForDate（pattern_data: update_flag / keep_flag），onConflict='date' 幂等。
//
// ★★ [PATTERN-LOST 2026-10-14 事故修] 这里是【用户保存】的唯一入口 ⇒ 必须第一件事就登记
//    「本地写过」（notePatternLocalWrite）。原因见 data/board-pattern.js 头部：
//    一次「发起于本次保存之前」的在途旧读回，落地时会把刚保存的内容覆盖成空，
//    随后脏推送再把空写回云端 ⇒ 内容永久丢失（线上所有日期 content 全空即此）。
//    ⛔ 必须放在 getSupabase() 判空【之前】：即便客户端不可用也要挡住旧读回覆盖本地内容。
export async function savePatternData(date, { content, update, keep }) {
    notePatternLocalWrite(date);
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
