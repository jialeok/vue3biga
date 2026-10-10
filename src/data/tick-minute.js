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
 * 前端等 Edge Function 的上限。
 *
 * ★ 不变式（2026-10-10 事故后立的红线）：
 *     后端上游最坏耗时（Edge 侧 TOTAL_BUDGET_MS，默认 15s）
 *     <  本值（60s）
 *   旧值 25s 时，后端最坏 40s（20s×2 端点）⇒ 上游一抽风前端就先 abort，
 *   抛出无信息的 `signal is aborted without reason`，被误报成「接口不可达 / 跨域被拦」。
 *   ⛔ 以后调小本值前，先确认 Edge 侧 supabase/functions/tick-minute-fetch/index.ts
 *      的 TOTAL_BUDGET_MS 仍然明显更小。
 */
const EDGE_TIMEOUT_MS = 60000;

/** Edge 自检路由（排障用；不含任何密钥） */
const EDGE_PROBE_URL = SUPABASE_URL + '/functions/v1/tick-minute-fetch/probe';

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
 * 浏览器 fetch 失败时，把错误翻成【有证据】的人话。
 *
 * ⚠️ 为什么不能只列「三种可能」：fetch 抛错是【不带原因】的 —— 跨域被拦、DNS 不通、
 *    本机代理挂了、我们自己 AbortController 掐断，四种在 JS 里几乎长得一样。
 *    2026-10-10 的教训：当时把四种全列出来并让用户按概率猜，结果三条猜测全错
 *    （真正的原因是「我们自己超时了」），排查方向被彻底带偏。
 * ⇒ 现在改成【按证据分支】：只有我们自己的 timedOut 标记才报「超时」，
 *    其余网络类错误才提示跨域/未部署，且每条都给下一步动作。
 *
 * @param {*} raw 原始错误
 * @param {{timedOut?:boolean, elapsedMs?:number}} info 我们自己掌握的现场证据
 * @returns {Error}
 */
function _explainEdgeError(raw, info) {
    const msg = String((raw && raw.message) || raw || '');
    const t = msg.toLowerCase();
    const secs = Math.max(1, Math.round(((info && info.elapsedMs) || 0) / 1000));
    const probeHint = '自查顺序：打开 ' + EDGE_PROBE_URL + '（从 Edge 机房实测上游专线），'
        + '再看 /functions/v1/tick-minute-fetch/health（配置与 key 来源）。';

    // ① 我们自己掐断的（唯一能确定的一条）—— 必须先判，否则会误报成「不可达」
    if (info && info.timedOut) {
        return new Error('分笔抓取请求超时：已等 ' + secs + ' 秒仍未收到 Edge Function 的回应（正常 3~6 秒）。'
            + '注意：这【不是】跨域、也【不是】函数没部署 —— 那些都会在 1~2 秒内以明确错误返回。'
            + '多半是上游专线 sz/sh.meoz.cn:6688 临时限流，或本机 → supabase.co 这一段卡顿。'
            + '处理：隔 1~2 分钟点【重试】；连续多次如此再打开 /probe 看上游到底通不通。');
    }
    // ② 网关明确回 404/401/非 JSON 的情形（调用方已另判，这里兜底）
    if (t.indexOf('请求 /minute 失败') >= 0 || t.indexOf('functions/v1/tick-minute-fetch') >= 0 ||
        t.indexOf('fetch failed') >= 0 || t.indexOf('failed to fetch') >= 0 || t.indexOf('load failed') >= 0 ||
        t.indexOf('networkerror') >= 0) {
        return new Error('分笔抓取接口不可达（' + secs + ' 秒内失败）：' + msg + '。'
            + '既然后端超时已被排除（后端预算 ≤15 秒），剩下两种可能：'
            + '① 本机网络 / 代理拦了这一条（浏览器走的是系统代理，先在浏览器里直接打开 /health 试）'
            + '② Edge Function tick-minute-fetch 未部署或部署在别的项目（本文件对应函数已带 CORS，无需担心跨域）。'
            + probeHint);
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
    // 超时闸门（§R2 红线：所有上游调用都必须有超时）。
    // ★ 本值必须 > Edge 侧 TOTAL_BUDGET_MS（默认 15s）—— 见文件头 EDGE_TIMEOUT_MS 的不变式说明。
    //   Edge 侧还有冷启动 + 写库 + 回读，正常总耗时 3~6s，60s 是给足余量的上限，不是预期值。
    const timeoutMs = (opts && Number(opts.timeoutMs) > 0) ? Number(opts.timeoutMs) : EDGE_TIMEOUT_MS;

    let resp;
    const t0 = Date.now();
    let timedOut = false;
    const ctl = new AbortController();
    const timer = setTimeout(function() { timedOut = true; ctl.abort(); }, timeoutMs);
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
        const elapsedMs = Date.now() - t0;
        const msg = (e && e.message) || String(e);
        _dbgLog('[TICK-MINUTE] /minute 请求失败（' + elapsedMs + 'ms, timedOut=' + timedOut + '）: ' + msg);
        // ⚠️ 必须把 elapsedMs 与 timedOut 一起传下去：单看 msg 无法区分
        //    「我们自己掐断」与「浏览器把请求拦了」—— 那正是 2026-10-10 误判的根因。
        throw _explainEdgeError('请求 /minute 失败（' + msg + '）；functions/v1/tick-minute-fetch',
            { timedOut: timedOut, elapsedMs: elapsedMs });
    } finally {
        clearTimeout(timer);
    }

    const elapsedMs = Date.now() - t0;
    const text = await resp.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // 404 常见于「函数没部署」；5xx 常见于函数内部异常（返回错误页而不是 JSON）
        throw _explainEdgeError('分笔抓取接口返回非 JSON（HTTP ' + resp.status + '，' + elapsedMs + 'ms）：' + text.slice(0, 200),
            { timedOut: false, elapsedMs: elapsedMs });
    }
    if (resp.status === 404) {
        throw _explainEdgeError('分笔抓取接口不存在（HTTP 404）：Edge Function tick-minute-fetch 未部署'
            + '（supabase/functions/tick-minute-fetch/index.ts）', { timedOut: false, elapsedMs: elapsedMs });
    }
    if (resp.status === 401 || resp.status === 403) {
        throw _explainEdgeError('分笔抓取接口鉴权失败（HTTP ' + resp.status + '）：请确认该函数的 Verify JWT 已关闭'
            + '（详见该函数文件头的部署说明）', { timedOut: false, elapsedMs: elapsedMs });
    }
    if (data && data.table && data.ok === false && !data.skipped) {
        // Edge 侧回显了表名 + 失败 → 大概率是表没建，把提示说清楚
        throw _explainDbError(data.hint || data.error || '');
    }
    return data || {};
}

/** 供排查用：本模块持有的表 / 路由 / 超时（⛔ 不含任何密钥） */
export const TICK_MINUTE_META = {
    table: TABLE,
    edgeUrl: EDGE_MINUTE_URL,
    probeUrl: EDGE_PROBE_URL,
    timeoutMs: EDGE_TIMEOUT_MS,
    columns: SELECT_COLUMNS.slice()
};
