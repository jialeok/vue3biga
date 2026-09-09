// stock-range-pct.js — 题材龙头判定缓存表 stock_range_pct 的唯一读写入口（Data 层，§5）
//
// 职责：
//   1. 云端读写「近 10 个交易日区间涨幅」（按 date+stock 缓存，跨设备共享，避免重复消耗猫抓额度）；
//   2. 调猫抓 daily 接口一次性批量拉取 [startYmd, endYmd] 区间内全部股票的每日涨幅 pct_chg。
//
// 红线（§10）：读取失败必须 throw，绝不能返回空 Map 伪装成「没有数据」——
// 否则上层会误判为「需要重新调接口」，白白消耗额度。

import { getSupabase } from './supabase-client.js';
import { numcatApiPost } from './api/numcat-proxy.js';
import { _dbgLog } from './debug-log.js';

/**
 * 读取某日的区间涨幅缓存。
 * @param {string} date - 区间结束日 T
 * @returns {Promise<Map<string, {pct:number|null, days:number, updatedAt:string}>>} stock -> 区间涨幅
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readRangePctForDate(date) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('stock_range_pct')
        .select('stock,range_pct,days,updated_at')
        .eq('date', date);
    if (error) throw error;
    const map = new Map();
    (data || []).forEach(function(r) {
        if (!r || !r.stock) return;
        const raw = r.range_pct;
        let pct = null;
        if (raw !== null && raw !== undefined && raw !== '') {
            const n = Number(String(raw).replace('%', '').replace('+', ''));
            if (!isNaN(n)) pct = n;
        }
        map.set(String(r.stock).trim(), {
            pct: pct,
            days: Number(r.days) || 0,
            updatedAt: r.updated_at || ''
        });
    });
    return map;
}

/**
 * 批量写入（upsert）某日的区间涨幅。
 * @param {string} date
 * @param {Array<{stock:string, pct:number|null, days:number}>} rows
 * @returns {Promise<number>} 写入行数
 */
export async function upsertRangePctRows(date, rows) {
    if (!date || !rows || rows.length === 0) return 0;
    const nowIso = new Date().toISOString();
    const payload = rows.map(function(r) {
        return {
            date: date,
            stock: r.stock,
            range_pct: (r.pct === null || r.pct === undefined || isNaN(r.pct)) ? null : Number(r.pct).toFixed(2),
            days: Number(r.days) || 0,
            updated_at: nowIso
        };
    });
    const sb = getSupabase();
    const { error } = await sb
        .from('stock_range_pct')
        .upsert(payload, { onConflict: 'date,stock' });
    if (error) throw error;
    return payload.length;
}

/**
 * 猫抓 daily 接口：一次请求批量拉「多只股票 × 一个日期区间」的每日涨幅。
 * 额度极省：1 次请求即可覆盖全部股票 × 10 个交易日（接口每日仅 10 次）。
 *
 * @param {string} symbols - 逗号分隔的股票代码串
 * @param {string} startYmd - 起始日 YYYYMMDD（含）
 * @param {string} endYmd - 结束日 YYYYMMDD（含）
 * @returns {Promise<Map<string, Map<string, number>>>} code -> (tradedate YYYYMMDD -> pct_chg)
 */
export async function fetchNumcatDailyPctRange(symbols, startYmd, endYmd) {
    const result = await numcatApiPost('daily', 'symbol,tradedate,pct_chg', {
        symbols: symbols,
        startdate: startYmd,
        enddate: endYmd
    });
    const fieldList = (result && result.fields) || [];
    const items = (result && result.items) || [];
    const sIdx = fieldList.indexOf('symbol');
    const dIdx = fieldList.indexOf('tradedate');
    const pIdx = fieldList.indexOf('pct_chg');
    const byCode = new Map();
    if (sIdx < 0 || dIdx < 0 || pIdx < 0) {
        _dbgLog('[DRAGON-DATA] daily 返回字段不完整: ' + JSON.stringify(fieldList));
        return byCode;
    }
    items.forEach(function(row) {
        const code = String(row[sIdx] || '').trim();
        const ymd = String(row[dIdx] || '').trim().replace(/-/g, '');
        const raw = row[pIdx];
        if (!code || !ymd || raw === null || raw === undefined || raw === '') return;
        const n = Number(raw);
        if (isNaN(n)) return;
        if (!byCode.has(code)) byCode.set(code, new Map());
        byCode.get(code).set(ymd, n);
    });
    return byCode;
}
