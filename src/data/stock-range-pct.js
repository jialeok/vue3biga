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
    // 起点前移 20 个自然日：窗口首日的涨幅需要「上一个交易日收盘价」作为基准。
    // [FIX 2026-09-10] 原来只前移 8 个自然日，遇到长假（春节/国庆连休 8~9 天 + 周末）时
    // 上一个交易日会落在窗口外 → 首日涨幅取不到 → 窗口只有 9 天（区间涨幅系统性偏低）。
    // 同一次请求，多取几根 K 线不增加成本。
    const startMs = _ymdToMs(first) - 20 * 86400000;
    const endMs = _ymdToMs(last) + 2 * 86400000;
    const wantSet = new Set(ymdList);
    // [PERF 2026-09-10] 并发度 6 → 3。
    // 实测：该上游在【并发 4~6 时会返回被截断的少数几根 K 线】（单只串行探测始终正常）。
    // 截断会触发下面的重试 → 每只跑满 3 次 → 请求量变成 3 倍、耗时反而更长。
    // 降到 3 能大幅提高单次完整率，实测总耗时显著低于「高并发 + 反复重试」。
    // §36：禁止用「不断重试」掩盖上游并发缺陷。
    const conc = (opts && opts.concurrency) || 3;
    // 熔断阈值：连续这么多只都取不到完整窗口 → 判定上游整体不可用，直接放弃剩余。
    // 否则 24 只残缺票会各自跑满 3 次重试（= 72 次请求），页面卡死数分钟。
    const CIRCUIT_LIMIT = 6;

    /**
     * 取一次 K 线并换算窗口内日涨幅。
     * [FIX 2026-09-10] 上游 historical 在并发下偶发【返回被截断的少数几根 K 线】，
     * 若直接采信，会算出「只有 1~3 天」的残缺区间涨幅并写进 stock_range_pct
     * （仍是日期级复用 → 长期污染，且同一屏内各票天数不同 → 龙一/龙二排名不可比）。
     * 因此这里做「覆盖不足即重试」：直到取到覆盖整个窗口，或重试次数用尽（新票本身
     * 交易日就少，重试仍会返回同样短的序列 → 不受影响，只是多 1~2 次请求）。
     */
    const fetchOnce = async function(code) {
        const data = await fuyaoApiGet('/api/a-share/prices/historical', {
            thscode: tickerToThscode(code),
            interval: '1d',
            start: String(startMs),
            end: String(endMs),
            // [FIX 2026-09-10] 必须用【前复权】：不复权收盘价在除权除息日会出现
            // 「假暴跌」（送转/派息导致价格向下跳空），算出来的区间涨幅与交易所涨跌幅
            // （猫抓 daily 的 pct_chg）不可比 → 同一题材内用不同通道算出的票排名会错乱。
            // 前复权价按同一复权因子缩放，日间比值 = 真实涨幅（含分红送转），与涨跌幅口径一致。
            adjust: 'forward'
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
        return keep;
    };

    // 熔断计数器（跨批次累计）
    let consecutiveShort = 0;
    let circuitOpen = false;

    for (let i = 0; i < list.length; i += conc) {
        if (circuitOpen) break;
        const batch = list.slice(i, i + conc);
        await Promise.all(batch.map(async function(it) {
            if (circuitOpen) return;
            const name = String(it.stock).trim();
            let best = null;
            try {
                for (let attempt = 0; attempt < 3; attempt++) {
                    const keep = await fetchOnce(it.code);
                    if (!best || keep.size > best.size) best = keep;
                    if (best.size >= wantSet.size) break; // 已覆盖整个窗口，无需再试
                    // [PERF 2026-09-10] 0 根 = 代码错 / 长期停牌，重试不会有不同结果 → 立刻放弃。
                    // 次新股 / 停牌股本就不足 10 天，这类票原本必然跑满 3 次，是主要的耗时来源。
                    if (best.size === 0) break;
                    // 退避：给上游喘息时间，避免并发重试再次触发截断（原来完全无间隔）。
                    if (attempt < 2) await new Promise(function(r) { setTimeout(r, 300 * (attempt + 1)); });
                }
            } catch (e) {
                _dbgLog('[DRAGON-FUYAO] ' + name + '(' + it.code + ') 历史K线失败: ' + (e && e.message || e));
            }
            if (best && best.size > 0) out.set(name, best);

            if (!best || best.size < wantSet.size) {
                consecutiveShort++;
                if (consecutiveShort >= CIRCUIT_LIMIT) {
                    circuitOpen = true;
                    _dbgLog('[DRAGON-FUYAO] 连续 ' + consecutiveShort + ' 只取不到完整窗口，判定上游不可用，熔断剩余请求');
                }
            } else {
                consecutiveShort = 0;
            }
        }));
    }
    return out;
}
