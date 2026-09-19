// yizi-trend.js — 「竞价一字 · 趋势图」缓存表 yizi_trend 的唯一读写入口（Data 层，§5）
//
// 职责（只有两件事，都【只读上游之外的库】）：
//   1. 读：按一批交易日读趋势缓存行（竞价量 / 昨日成交量 / 竞价涨幅 / 涨幅）；
//   2. 触发补腿：调 Supabase Edge Function auction-yizi-fetch 的 /trend 路由
//      —— 那是**唯一**的 yizi_trend 写入者（与 9:25 写 auction_yizi 的 /fetch 同函数、不同路由）。
//
// ⚠️ 本模块【不直连上游、不持任何 apikey】：
//   · 猫抓小号的 key 只在 Edge Function 的 Secrets 里；前端连 URL 都拿不到；
//   · 补腿走的是【竞价一字那只小号】（NUMCAT_API_KEY_YIZI），⛔ 与早盘竞价看板的
//     numcat-proxy（主账号 NUMCAT_API_KEY）完全是两条通道，绝不混用。
//
// 红线（§10）：读取失败必须 throw，绝不能返回空数组伪装成「这只股票没有历史」——
//   趋势图少一条腿与「库里没数据」是两回事，前者必须让用户看见原因。
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。
// 红线（§11）：本模块【没有任何 delete】（趋势缓存只补不删；唯一删除是 SQL 里的 60 天滚动清理）。

import { getSupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（改这里即全模块生效） */
const TABLE = 'yizi_trend';

/** Edge Function 的趋势路由（与 /fetch 同函数；⛔ 前端只用这一个入口，不自造上游请求） */
const EDGE_TREND_URL = SUPABASE_URL + '/functions/v1/auction-yizi-fetch/trend';

// 读取列清单（显式列出：不猜列、不 select *，§40）
const SELECT_COLUMNS = [
    'date', 'stock', 'code',
    'auc_vol', 'auc_pct_chg', 'yest_volume', 'change_pct',
    'source', 'updated_at'
];

/**
 * 把 PostgREST / Edge Function 的「找不到表」原文翻译成「该干什么」。
 * 现场两个长相：
 *   · 前端读库 → `Could not find the table 'public.yizi_trend' in the schema cache`（PGRST205）
 *   · Edge /trend → 响应里的 tableError 字段（同一句话，包在 JSON 里）
 * —— 都不是「调用方法不对」，就是【表还没建】。
 * ⚠️ 翻译后仍然 throw（§10），只是把原因说清楚。
 *
 * @param {*} raw 原始错误文本
 * @returns {Error}
 */
function _explainTrendError(raw) {
    const msg = String((raw && raw.message) || raw || '');
    const t = msg.toLowerCase();
    if (t.indexOf('could not find the table') >= 0 || t.indexOf('in the schema cache') >= 0 ||
        t.indexOf('does not exist') >= 0 || t.indexOf('pgrst205') >= 0 || t.indexOf('42p01') >= 0) {
        return new Error('yizi_trend 表不存在：请在 Supabase Dashboard → SQL Editor 执行 db/create_yizi_trend.sql 建表（原文：' + msg + '）');
    }
    if (t.indexOf('functions/v1/auction-yizi-fetch') >= 0 || t.indexOf('fetch failed') >= 0) {
        return new Error('趋势接口请求失败（网络层）：' + msg + '。请确认 auction-yizi-fetch Edge Function 已部署');
    }
    return raw instanceof Error ? raw : new Error(msg);
}

/** 数值字段归一：非有限值 → null（不伪造 0；0 是真实成交量/涨幅） */
function _numOrNull(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) ? n : null;
}

/** 文本字段归一：空串/空白 → '' */
function _textOrEmpty(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim();
}

/**
 * 库行 / Edge 返回行 → 前端行（snake_case → camelCase）。
 * ⚠️ 唯一一份映射：`readYiziTrendForDates`（直读库）与 Logic 层解析 Edge 响应（也回原样的库行）
 *    都调它 —— 两处各写一份映射迟早会分叉（§6 不要第二套口径）。
 * @param {object} r
 * @returns {object}
 */
export function mapTrendRow(r) {
    return {
        date: String((r && r.date) || ''),
        stock: String((r && r.stock) || '').trim(),
        code: _textOrEmpty(r && r.code),
        // 竞价量：单位【手】（猫抓 auc_vol 原样）；展示「万」时 /100（与早盘竞价看板同一换算）
        aucVol: _numOrNull(r && r.auc_vol),
        aucPctChg: _textOrEmpty(r && r.auc_pct_chg),
        // 昨日成交量：单位【万股】（由 auc_vol ÷ auc_to_pre_vol_pct 反推，见 Edge Function）
        yestVolume: _numOrNull(r && r.yest_volume),
        changePct: _textOrEmpty(r && r.change_pct),
        source: _textOrEmpty(r && r.source),
        updatedAt: _textOrEmpty(r && r.updated_at)
    };
}

/**
 * 读一批交易日的趋势缓存行。
 *
 * @param {string[]} dates 交易日 YYYY-MM-DD（一般 = 近 N 个交易日窗口）
 * @param {{stocks?:string[]}} [opts] stocks 传入时只读这几只（不传 = 读该窗口全部行）
 * @returns {Promise<Array<object>>} 行数组（可能为空 = 云端确实还没有这些日期的趋势缓存）
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readYiziTrendForDates(dates, opts) {
    const list = (dates || []).map(function(d) { return String(d).trim(); }).filter(Boolean);
    if (list.length === 0) return [];
    const sb = getSupabase();
    let q = sb.from(TABLE)
        .select(SELECT_COLUMNS.join(','))
        .in('date', list)
        // ⚠️ 必须带【确定性排序】：PostgREST 无 ORDER BY 时不保证行序，分页/增量比对都会错位
        .order('date', { ascending: true })
        .order('stock', { ascending: true });
    const names = (opts && opts.stocks) ? opts.stocks.map(function(s) { return String(s).trim(); }).filter(Boolean) : [];
    if (names.length > 0) q = q.in('stock', names);
    const { data, error } = await q;
    if (error) throw _explainTrendError(error);
    return (data || [])
        .filter(function(r) { return r && r.date && r.stock; })
        .map(mapTrendRow);
}

/**
 * 调 Edge Function 的趋势路由（补腿 / 读缓存）。
 *
 * ⚠️ 本路由【不校验 token】（与 /health 同级）：它是浏览器端的只读缓存入口，
 *    额度由 Edge 侧的 5 道闸门保护（缺口驱动 / 09:20~09:30 保护窗口 / 90 秒冷却 /
 *    每日请求预算 / 整窗口 1 次请求），且它【从不删除】任何数据。
 *    因此这里只带 Supabase 的 anon key（与 numcat-proxy / fuyao-proxy 同一做法）。
 *
 * @param {{date?:string, window?:number}} [opts]
 * @returns {Promise<object>} Edge 返回的原始 JSON：
 *   { ok, date, window:string[], rows:Array, requests, skipped, tableError, fetched, budget, guards, logs }
 *   —— skpped 非空表示「本轮没发上游请求」（缓存已齐 / 保护窗口 / 冷却 / 预算），rows 仍是有效缓存。
 * @throws 传输失败或 ok!==true 时抛错（绝不把「取不到」伪装成「没有历史」）
 */
export async function fetchYiziTrendFromEdge(opts) {
    const date = (opts && opts.date) ? String(opts.date).trim() : '';
    const win = (opts && opts.window) ? Number(opts.window) : 0;
    const url = new URL(EDGE_TREND_URL);
    if (date) url.searchParams.set('date', date);
    if (win > 0 && isFinite(win)) url.searchParams.set('window', String(win));

    let resp;
    try {
        resp = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            }
        });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        _dbgLog('[YIZI-TREND] 趋势接口网络失败: ' + msg);
        throw _explainTrendError('请求 /trend 失败（' + msg + '）；functions/v1/auction-yizi-fetch');
    }

    const text = await resp.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (e) {
        // 404 常见于「函数没部署」；5xx 常见于函数内部异常（返回的是错误页而不是 JSON）
        throw _explainTrendError('趋势接口返回非 JSON（HTTP ' + resp.status + '）：' + text.slice(0, 200));
    }
    if (!json || json.ok !== true) {
        const detail = (json && (json.tableError || json.error)) || ('HTTP ' + resp.status);
        throw _explainTrendError(detail);
    }
    return json;
}
