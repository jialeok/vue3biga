// dragon-leaders.js — 龙头组名册表 dragon_leaders 的唯一读写入口（Data 层，§5）
//
// 职责：按【评选日 date】读写「题材龙头」名册。
//   · 写：由 Logic 层（logic/auction/dragon-group.js）在「该日收盘数据已权威」后评选并 upsert；
//   · 读：① 前端看某日 D → 读 date = prevTradingDay(D) 的名册（「每天的龙头放到次日」）；
//         ② worker 9:25 → 读 date = 前一交易日的名册，把龙头并入抓取名单（保证数据完整获取）。
//
// 主键 = (date, topic)：一个题材在一个评选日只有一只龙头 → 重算只覆盖、不追加（天然幂等）。
// 红线（§10）：读取失败必须 throw，绝不能返回空数组伪装成「今天没有龙头」。
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。

import { getSupabase } from './supabase-client.js';

/**
 * 解析形如 "+12.34" / "12.34%" / "-3.2" 的涨幅文本 → number；无法解析 → null（绝不用 0 顶替）。
 * （与 stock-range-pct.js 同一口径，Data 层内联，避免 Data → Logic 的反向依赖）
 */
function _parsePct(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const n = Number(String(raw).replace('%', '').replace(/\+/g, ''));
    return isNaN(n) ? null : n;
}

/**
 * 读取某【评选日】的龙头名册。
 * @param {string} date - 评选日 T（该日选出龙头）的 YYYY-MM-DD
 * @returns {Promise<Array<{date:string, topic:string, stock:string, code:string, rangePct:number|null, groupSize:number, updatedAt:string}>>}
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readDragonLeadersForDate(date) {
    if (!date) return [];
    const sb = getSupabase();
    const { data, error } = await sb
        .from('dragon_leaders')
        .select('date,topic,stock,code,range_pct,group_size,updated_at')
        .eq('date', date);
    if (error) throw error;
    return (data || [])
        .filter(function(r) { return r && r.stock && r.topic; })
        .map(function(r) {
            return {
                date: r.date,
                topic: String(r.topic).trim(),
                stock: String(r.stock).trim(),
                code: r.code || '',
                rangePct: _parsePct(r.range_pct),
                groupSize: Number(r.group_size) || 0,
                updatedAt: r.updated_at || ''
            };
        });
}

/**
 * 写入（upsert）某评选日的龙头名册。
 * @param {string} date
 * @param {Array<{topic:string, stock:string, code?:string, pct?:number|null, groupSize?:number}>} rows
 * @returns {Promise<number>} 写入行数
 */
export async function upsertDragonLeaders(date, rows) {
    if (!date || !rows || rows.length === 0) return 0;
    const nowIso = new Date().toISOString();
    const payload = rows
        .filter(function(r) { return r && r.topic && r.stock; })
        .map(function(r) {
            return {
                date: date,
                topic: String(r.topic).trim(),
                stock: String(r.stock).trim(),
                code: r.code || null,
                range_pct: (r.pct === null || r.pct === undefined || isNaN(r.pct)) ? null : Number(r.pct).toFixed(2),
                group_size: Number(r.groupSize) || 0,
                updated_at: nowIso
            };
        });
    if (payload.length === 0) return 0;
    const sb = getSupabase();
    const { error } = await sb
        .from('dragon_leaders')
        .upsert(payload, { onConflict: 'date,topic' });
    if (error) throw error;
    return payload.length;
}
