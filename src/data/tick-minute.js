// tick-minute.js — 分笔买卖表 tick_minute_open 的唯一读写入口（Data 层，§5）
//
// 职责（只有两件事，与 src/data/yizi-trend.js 同一分工）：
//   1. 读：按【交易日 date】读该日全部分笔行（「分笔买卖」看板唯一数据来源）；
//   2. 触发抓取：调 Supabase Edge Function tick-minute-fetch 的 /minute 路由
//      —— 那是**唯一**的 tick_minute_open 写入者。
//
// ⚠️ 本模块【不直连上游、不持任何 apikey】：
//   · 猫头鹰（t.meoz.cn）的 key 只在 Edge Function 的 Secrets 里，前端连 URL 都拿不到；
//   · ⛔ 与「早盘竞价看板」的 numcat-proxy、「竞价一字」的 auction-yizi-fetch
//     是【三条互不相干的通道】，绝不混用（各自的表 / 各自的 job / 各自的 key 变量）。
//   · ⛔ 本功能的唯一数据源是猫头鹰 tick_history。东方财富逐笔非常不稳定，
//     【不做任何东财兜底】（用户明确禁止）。
//
// 红线（§10）：读取失败必须 throw，绝不能返回空数组伪装成「这天没有分笔」。
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。
// 红线（§11）：本模块【没有任何 delete】（本表是「点名抓取」的产物，
//   不产生 stale 语义；重跑同一日同一票是 upsert 覆盖）。

import { getSupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（改这里即全模块生效） */
const TABLE = 'tick_minute_open';

/** Edge Function 的抓取路由（前端只用这一个入口，不自造上游请求） */
const EDGE_MINUTE_URL = SUPABASE_URL + '/functions/v1/tick-minute-fetch/minute';

// 读取列清单（显式列出：不猜列、不 select *，§40）
const SELECT_COLUMNS = [
    'date', 'name', 'code', 'open_price', 'pens', 'trade_count',
    'start_time', 'end_time', 'source', 'updated_at'
];

/**
 * 把 PostgREST / Edge Function 的「找不到表」原文翻译成「该干什么」。
 * 现场两个长相：
 *   · 前端读库 → `Could not find the table 'public.tick_minute_open' in the schema cache`（PGRST205）
 *   · Edge /minute → 响应里的 table 字段 + 400/500（同一句话）
 * —— 都不是「调用方法不对」，就是【表还没建】。翻译后仍然 throw（§10）。
 *
 * @param {*} raw 原始错误文本
 * @returns {Error}
 */
function _explainDbError(raw) {
    const msg = String((raw && raw.message) || raw || '');
    const t = msg.toLowerCase();
    if (t.indexOf('could not find the table') >= 0 || t.indexOf('in the schema cache') >= 0 ||
        t.indexOf('does not exist') >= 0 || t.indexOf('pgrst205') >= 0 || t.indexOf('42p01') >= 0) {
        return new Error('tick_minute_open 表不存在：请在 Supabase Dashboard → SQL Editor 执行 db/create_tick_minute_open.sql 建表（原文：' + msg + '）');
    }
    return raw instanceof Error ? raw : new Error(msg);
}

/**
 * Edge /minute 不可达时的报错（浏览器里 fetch 抛错【没有原因信息】：
 * 跨域被拦、断网、超时长得一模一样，所以必须把三种可能都列出来，
 * 否则「请确认已部署」会把排查方向带偏 —— 见 yizi-trend.js 的同类注释）。
 */
function _explainEdgeError(raw) {
    const msg = String((raw && raw.message) || raw || '');
    const t = msg.toLowerCase();
    if (t.indexOf('请求 /minute 失败') >= 0 || t.indexOf('functions/v1/tick-minute-fetch') >= 0 ||
        t.indexOf('fetch failed') >= 0 || t.indexOf('failed to fetch') >= 0 || t.indexOf('load failed') >= 0) {
        return new Error('分笔抓取接口不可达：' + msg +
            '。三种可能（按概率）：' +
            '① 【跨域被拦】Edge Function tick-minute-fetch 对 OPTIONS 预检必须回 Access-Control-Allow-Origin（本文件对应的函数已带 CORS，需重新部署该函数）；' +
            '② 该 Edge Function 未部署 / 部署到了别的项目；' +
            '③ 网络或代理不通、请求超时（该函数要打上游专线，最坏比普通请求慢）');
    }
    return _explainDbError(raw);
}

/** 数值字段归一：非有限值 → null（不伪造 0；0 是真实成交量） */
function _numOrNull(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) ? n : null;
}

/** 整数归一 */
function _intOrNull(raw) {
    const n = _numOrNull(raw);
    return n === null ? null : Math.round(n);
}

/**
 * pens 归一：只保留 {t: string, p: number|null, v: number|null} 三个键。
 * ⛔ 不在这里做任何业务判断（红/绿/平、要不要丢掉 v=0 的快照）——
 *    那些唯一实现在 src/logic/tick/tick-minute.js（§6：本层只搬事实）。
 */
function _normalizePens(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach(function(e) {
        if (!e || typeof e !== 'object') return;
        out.push({
            t: String(e.t === null || e.t === undefined ? '' : e.t),
            p: _numOrNull(e.p),
            v: _numOrNull(e.v)
        });
    });
    return out;
}

/**
 * 读取某交易日的全部分笔行。
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<object>>} 行数组（可能为空 = 云端确实还没有该日数据）
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readTickMinuteForDate(date) {
    if (!date) return [];
    const sb = getSupabase();
    const all = [];
    const pageSize = 1000;
    // 分页安全上限（单日目标票来来回回就那几只；10000 行上限仅用于防游标异常导致死循环）
    const maxPages = 10;
    let from = 0;
    for (let page = 0; page < maxPages; page++) {
        const { data, error } = await sb
            .from(TABLE)
            .select(SELECT_COLUMNS.join(','))
            .eq('date', date)
            // ⚠️ 分页必须带【确定性排序】（PostgREST 无 ORDER BY 时不保证翻页行序稳定）；
            //    同日 name 唯一（表主键 date+name）⇒ 按 name 排序即可。
            .order('name', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw _explainDbError(error);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all
        .filter(function(r) { return r && r.name; })
        .map(function(r) {
            return {
                date: r.date,
                name: String(r.name).trim(),
                code: r.code ? String(r.code).trim() : '',
                openPrice: _numOrNull(r.open_price),
                pens: _normalizePens(r.pens),
                tradeCount: _intOrNull(r.trade_count),
                startTime: r.start_time || '',
                endTime: r.end_time || '',
                source: r.source || '',
                updatedAt: r.updated_at || ''
            };
        });
}

/**
 * 触发一次分笔抓取（Edge Function tick-minute-fetch 的 /minute）。
 *
 * ⚠️ Edge 侧负责：上游请求、累计量差分、窗口闸门（今天 9:31 前拒抓）、落库、回读校验。
 *    本层只负责「发请求 + 把失败原因说人话」，⛔ 不解析上游信封、不碰 apikey。
 *
 * @param {{date:string, items:Array<{name:string, code:string}>, timeoutMs?:number}} opts
 * @returns {Promise<object>} Edge 返回的 JSON（ok:false 也算正常返回，调用方按 skipped/error 处理）
 * @throws 网络 / 非 JSON 时抛错（§10：调用失败 ≠ 上游没有数据）
 */
export async function requestTickMinuteFromEdge(opts) {
    const date = (opts && opts.date) ? String(opts.date).trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('分笔抓取：date 必须是 YYYY-MM-DD，收到「' + date + '」');
    const items = ((opts && opts.items) || []).filter(function(x) { return x && x.name; });
    if (items.length === 0) throw new Error('分笔抓取：没有目标股票');
    // 超时闸门（§R2 红线：所有上游调用都必须有超时）；
    // Edge 侧要打上游专线（可能试两个端点），给它 25s 已经足够宽松。
    const timeoutMs = (opts && Number(opts.timeoutMs) > 0) ? Number(opts.timeoutMs) : 25000;

    let resp;
    const ctl = new AbortController();
    const timer = setTimeout(function() { ctl.abort(); }, timeoutMs);
    try {
        resp = await fetch(EDGE_MINUTE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ date: date, items: items }),
            signal: ctl.signal
        });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        _dbgLog('[TICK-MINUTE] /minute 请求失败: ' + msg);
        throw _explainEdgeError('请求 /minute 失败（' + msg + '）；functions/v1/tick-minute-fetch');
    } finally {
        clearTimeout(timer);
    }

    const text = await resp.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // 404 常见于「函数没部署」；5xx 常见于函数内部异常（返回错误页而不是 JSON）
        throw _explainEdgeError('分笔抓取接口返回非 JSON（HTTP ' + resp.status + '）：' + text.slice(0, 200));
    }
    if (resp.status === 404) {
        throw _explainEdgeError('分笔抓取接口不存在（HTTP 404）：Edge Function tick-minute-fetch 未部署'
            + '（supabase/functions/tick-minute-fetch/index.ts）');
    }
    if (resp.status === 401 || resp.status === 403) {
        throw _explainEdgeError('分笔抓取接口鉴权失败（HTTP ' + resp.status + '）：请确认该函数的 Verify JWT 已关闭'
            + '（详见该函数文件头的部署说明）');
    }
    if (data && data.table && data.ok === false && !data.skipped) {
        // Edge 侧回显了表名 + 失败 → 大概率是表没建，把提示说清楚
        throw _explainDbError(data.hint || data.error || '');
    }
    return data || {};
}

/** 供排查用：本模块持有的表 / 路由（⛔ 不含任何密钥） */
export const TICK_MINUTE_META = {
    table: TABLE,
    edgeUrl: EDGE_MINUTE_URL,
    columns: SELECT_COLUMNS.slice()
};
