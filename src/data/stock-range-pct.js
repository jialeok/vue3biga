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
import { fuyaoApiGet, tickerToThscode } from './api/fuyao-proxy.js';
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

/**
 * 【兜底通道】同花顺 historical：按【收盘价】自己算窗口内每个交易日的涨幅。
 *
 * 为什么需要：猫抓 daily 免费额度每天只有 10 次，用尽后返回
 * `{code:403, message:'今日调用额度已用完'}` —— 此时「10 日涨幅 / 龙头徽章」全线失效。
 * 同花顺 fuyao 无每日额度限制，可作为等价替代（日涨幅 = 今日收盘 / 上一交易日收盘 - 1）。
 *
 * @param {Array<{stock:string, code:string}>} items 股票名 + 6 位代码
 * @param {string[]} dates 需要的交易日（YYYY-MM-DD，顺序任意）
 * @param {{concurrency?:number}} [opts]
 * @returns {Promise<Map<string, Map<string, number>>>} 股票名 -> (YYYYMMDD -> 日涨幅%)
 */
export async function fetchFuyaoDailyPctRange(items, dates, opts) {
    const list = (items || []).filter(function(it) { return it && it.stock && it.code; });
    const ymdList = (dates || []).map(function(d) { return String(d).replace(/-/g, ''); }).filter(Boolean);
    const out = new Map();
    if (list.length === 0 || ymdList.length === 0) return out;

    const sorted = ymdList.slice().sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const _ymdToMs = function(ymd) {
        return Date.parse(ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8) + 'T00:00:00+08:00');
    };
    // 起点前移 8 个自然日：窗口首日的涨幅需要「上一个交易日收盘价」作为基准
    const startMs = _ymdToMs(first) - 8 * 86400000;
    const endMs = _ymdToMs(last) + 2 * 86400000;
    const wantSet = new Set(ymdList);
    const conc = (opts && opts.concurrency) || 6;

    for (let i = 0; i < list.length; i += conc) {
        const batch = list.slice(i, i + conc);
        await Promise.all(batch.map(async function(it) {
            const name = String(it.stock).trim();
            try {
                const data = await fuyaoApiGet('/api/a-share/prices/historical', {
                    thscode: tickerToThscode(it.code),
                    interval: '1d',
                    start: String(startMs),
                    end: String(endMs),
                    adjust: 'none'
                });
                const rows = (data && data.item) || [];
                const series = [];
                rows.forEach(function(r) {
                    if (!r || r.date_ms == null || r.close_price == null) return;
                    const ms = Number(r.date_ms);
                    const close = Number(r.close_price);
                    if (!isFinite(ms) || !isFinite(close) || close <= 0) return;
                    // date_ms 是【北京时间午夜】→ 加 8h 后取 UTC 日期才是正确的交易日
                    const ymd = new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
                    series.push({ ymd: ymd, close: close });
                });
                series.sort(function(a, b) { return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0); });
                const keep = new Map();
                for (let k = 1; k < series.length; k++) {
                    const prev = series[k - 1];
                    const cur = series[k];
                    if (!wantSet.has(cur.ymd)) continue;
                    keep.set(cur.ymd, (cur.close / prev.close - 1) * 100);
                }
                if (keep.size > 0) out.set(name, keep);
            } catch (e) {
                _dbgLog('[DRAGON-FUYAO] ' + name + '(' + it.code + ') 历史K线失败: ' + (e && e.message || e));
            }
        }));
    }
    return out;
}
