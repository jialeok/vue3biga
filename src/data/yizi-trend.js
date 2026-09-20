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
    if (t.indexOf('请求 /trend 失败') >= 0 || t.indexOf('functions/v1/auction-yizi-fetch') >= 0 ||
        t.indexOf('fetch failed') >= 0) {
        // 🔴 浏览器里 fetch 抛错是【没有原因信息】的（跨域被拦、断网、超时长得一模一样），
        //    所以这里不能只写「请确认已部署」—— 2026-09-19 的事故就是这么把用户带偏的：
        //    他明明部署成功了，却只看到「请确认已部署」，而真因是「函数没回 CORS 头 + 表没建」。
        return new Error('趋势接口不可达：' + msg +
            '。三种可能（按概率）：' +
            '① 【跨域被拦】函数对 OPTIONS 预检必须回 Access-Control-Allow-Origin（2026-09-19 已修，需重新部署该函数）；' +
            '② Edge Function 未部署 / 部署到了别的项目；' +
            '③ 网络或代理不通、请求超时');
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
 * PostgREST 单次响应最多回多少行 = Supabase 的 `db-max-rows` 硬上限。
 *
 * 🔴 这是一个【静默截断】：HTTP 200、没有任何 error 字段，你写 limit=20000 也照样只回 1000 行。
 *    而本表的读取形态天生超大 —— 「存储窗口 10 个交易日 × 池内上百只」实测 **1725 行**
 *    （2026-09-20 现场：09-07~09-18 共 1725 行）⇒ 不分页必然丢掉一批。
 *
 * 🔴 更要命的是「丢哪一批」：前端按 `date asc` 排序读，被截掉的正好是**最后几天**
 *    ——也就是趋势图真正要画的那 5 天。于是库里一行不少，用户看到的却是「趋势图有很多断点（数据不全）」。
 *    2026-09-20 定位结论：**这不是上游没抓到，是读的时候被截断了**。
 *
 * ⛔ 结论：任何「多日 × 多股票」的读都必须分页（或按股票/代码收窄，
 *    见 opts.stocks / opts.codes —— 两个更省的收窄手段）。⛔ 不要再相信 limit。
 */
const REST_PAGE_SIZE = 1000;
/** 分页安全上限（1000 × 30 = 3 万行，远超本表业务量；防异常数据把循环拖死） */
const REST_MAX_PAGES = 30;

/**
 * 读一批交易日的趋势缓存行。
 *
 * @param {string[]} dates 交易日 YYYY-MM-DD（一般 = 近 N 个交易日窗口）
 * @param {{stocks?:string[]|undefined, codes?:string[]|undefined}} [opts]
 *        stocks 传入时只读这几只（股票名，与 auction_yizi.stock 同键）；
 *        codes  传入时只读这几个 6 位代码（与 yizi_trend.code 同键）—— 十日涨幅通道用这个，
 *       因为它手里只有代码，按代码收窄能把一次读从上千行降到几十行（见 fetchYiziDailyPctRange）。
 *        两个都不传 = 读该窗口全部行（⚠️ 必须分页，见 REST_PAGE_SIZE）。
 * @returns {Promise<Array<object>>} 行数组（可能为空 = 云端确实还没有这些日期的趋势缓存）
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readYiziTrendForDates(dates, opts) {
    const list = (dates || []).map(function(d) { return String(d).trim(); }).filter(Boolean);
    if (list.length === 0) return [];
    const sb = getSupabase();
    const names = (opts && opts.stocks) ? opts.stocks.map(function(s) { return String(s).trim(); }).filter(Boolean) : [];
    const codes = (opts && opts.codes) ? opts.codes.map(function(c) { return String(c).trim(); }).filter(Boolean) : [];
    const out = [];
    // 🔴 必须分页：见 REST_PAGE_SIZE 的说明（不分页 = 静默丢行 = 趋势图断点）。
    for (let page = 0; page < REST_MAX_PAGES; page++) {
        const from = page * REST_PAGE_SIZE;
        let q = sb.from(TABLE)
            .select(SELECT_COLUMNS.join(','))
            .in('date', list)
            // ⚠️ 必须带【确定性排序】：PostgREST 无 ORDER BY 时不保证行序，分页会重复/漏行。
            //    (date, stock) 是本表主键 ⇒ 是一个全序，翻页不会错位。
            .order('date', { ascending: true })
            .order('stock', { ascending: true })
            .range(from, from + REST_PAGE_SIZE - 1);
        if (names.length > 0) q = q.in('stock', names);
        if (codes.length > 0) q = q.in('code', codes);
        const { data, error } = await q;
        if (error) throw _explainTrendError(error);
        const rows = data || [];
        out.push.apply(out, rows
            .filter(function(r) { return r && r.date && r.stock; })
            .map(mapTrendRow));
        // 本页不满 = 已经是最后一页（不再多发一次「空页」请求）
        if (rows.length < REST_PAGE_SIZE) break;
    }
    return out;
}

/**
 * 调 Edge Function 的趋势路由（补腿 / 读缓存）。
 *
 * ⚠️ 本路由【不校验 token】（与 /health 同级）：它是浏览器端的只读缓存入口，
 *    额度由 Edge 侧的 6 道闸门保护（缺口驱动 / 09:20~09:30 保护窗口 / 90 秒冷却 /
 *    每日请求预算 / 整窗口 1 次请求 / 上游额度止损），且它【从不删除】任何数据。
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
    // 🔴 超时闸门（§R2 红线：所有上游调用都必须有超时）：接口挂死时绝不能让面板永久「加载中」。
    //    （Edge 侧补腿最坏要等上游 2×?s，给它 15s 已经足够宽松；超时按失败处理，UI 用已有缓存渲染。）
    const timeoutMs = (opts && Number(opts.timeoutMs) > 0) ? Number(opts.timeoutMs) : 15000;
    const url = new URL(EDGE_TREND_URL);
    if (date) url.searchParams.set('date', date);
    if (win > 0 && isFinite(win)) url.searchParams.set('window', String(win));

    let resp;
    const ctl = new AbortController();
    const timer = setTimeout(function() { ctl.abort(); }, timeoutMs);
    try {
        resp = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            signal: ctl.signal
        });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        _dbgLog('[YIZI-TREND] 趋势接口请求失败: ' + msg);
        throw _explainTrendError('请求 /trend 失败（' + msg + '）；functions/v1/auction-yizi-fetch');
    } finally {
        clearTimeout(timer);
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

// ============================================================================
// 【竞价一字专用 · 十日涨幅的数据通道】（2026-09-19 新增）
// ============================================================================
//
// 🔴 为什么必须单独有一条通道（用户 2026-09-19 明确要求）：
//   「如果竞价一字看板的额度用完了，就不要用早盘竞价的那个主账号额度，因为早盘竞价那个额度是主要的
//     功能，如果占用就会影响到我买卖股票效果，这两个自动获取的账户要不影响额度。」
//
//   原先「十日涨幅」缺票补算复用的是 `range-fill.js` 的通道一
//   → `stock-range-pct.js#fetchNumcatDailyPctRange` → `numcat-proxy`
//   → **主账号 NUMCAT_API_KEY** ⇒ 竞价一字缺票时烧的正是早盘竞价的额度。**这就是违规点。**
//
//   本函数把竞价一字的通道一整体搬回【本看板自己的小号】：
//     ① 先读库 `yizi_trend.change_pct`（= 小号 `daily` 的 pct_chg 落库值）⇒ **0 上游请求**；
//     ② 只有确有缺口时，才调 `/trend` 补一次 —— 同一个 Edge Function、同一把小号，
//        自带 5 道额度闸门（缺口驱动 / 09:20~09:30 保护窗口 / 90 秒冷却 / 每日预算 / 整窗口 1 请求），
//        补完再读库。
//   ⇒ 两个看板【额度彻底隔离】：小号打光了也只是「这次补不齐」（显示 '-'），
//     ⛔ 绝不会偷偷去烧主账号。
//
// 返回形状与 `fetchNumcatDailyPctRange` **逐字一致**（code -> (YYYYMMDD -> pct)），
// 因此 `range-fill.js` 只需换数据源 —— 窗口 / 复利 / T 腿 / 落库四道口径【一行都不用改】。

/** 'YYYYMMDD' 或 'YYYY-MM-DD' → 'YYYY-MM-DD'；非法 → '' */
function _toIsoDate(ymd) {
    const s = String(ymd || '').replace(/-/g, '').trim();
    if (s.length !== 8 || !/^\d{8}$/.test(s)) return '';
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/**
 * 涨幅文本 → number|null。
 * ⛔ 绝不把「没有数据」当成 0 —— 0 是一个真实涨幅（停牌日上游真的会回 auc_vol=0）。
 * ⚠️ 刻意在本层自己实现而不是 import logic/auction/range-window.js#parsePct：
 *    Data 层不得依赖 Logic 层（§2 依赖方向 UI → Logic → Data → Backend）。
 *    口径与 range-window.js#parsePct 保持一致，改一处必须同步另一处。
 */
function _parsePctText(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    const n = Number(String(raw).replace('%', '').replace('+', ''));
    return isFinite(n) ? n : null;
}

/**
 * 闭区间内的自然日列表（含首尾）。
 * ⚠️ 只用来「把交易日窗口翻译成 PostgREST 的日期区间」，不承担交易日历职责 ——
 *    非交易日查不到行是正常的（库里本来就没有那些天）。
 */
function _calendarDays(startIso, endIso) {
    const out = [];
    const s = Date.parse(startIso + 'T00:00:00Z');
    const e = Date.parse(endIso + 'T00:00:00Z');
    if (!isFinite(s) || !isFinite(e) || e < s) return out;
    for (let ms = s; ms <= e && out.length < 40; ms += 86400000) {
        out.push(new Date(ms).toISOString().slice(0, 10));
    }
    return out;
}

/**
 * 【竞价一字专用 · 十日涨幅通道】用本看板小号的 `yizi_trend` 组装「逐日涨幅」。
 *
 * 与 `fetchNumcatDailyPctRange` 的唯一区别 = 数据来源（小号 vs 主账号）；
 * 返回的 Map 形状、键（6 位代码）、值（日涨幅 %，YYYYMMDD 键）完全一致。
 *
 * @param {string} symbols 逗号分隔的 6 位代码
 * @param {string} startYmd 窗口起始（含）YYYYMMDD
 * @param {string} endYmd 窗口结束（含 = T）YYYYMMDD
 * @param {{date?:string, window?:number, allowEdge?:boolean}} [opts]
 *        date = 区间结束日 T（透传给 /trend）；window = 需要的交易日数（默认 10）；
 *        allowEdge === false 时【只读库、绝不触发上游】（排查 / 验证用）。
 * @returns {Promise<Map<string, Map<string, number>>>} code -> (YYYYMMDD -> pct)
 * @throws 读库失败时抛错（§10：读取失败必须 throw，绝不返回空 Map 伪装成「没有数据」）
 */
export async function fetchYiziDailyPctRange(symbols, startYmd, endYmd, opts) {
    const o = opts || {};
    const codes = String(symbols || '')
        .split(',')
        .map(function(s) { return String(s).trim(); })
        .filter(Boolean);
    const startIso = _toIsoDate(startYmd);
    const endIso = _toIsoDate(endYmd);
    const byCode = new Map();
    if (codes.length === 0 || !startIso || !endIso) return byCode;

    const dates = _calendarDays(startIso, endIso);
    if (dates.length === 0) return byCode;
    const dateSet = new Set(codes);

    const accumulate = function(rows) {
        (rows || []).forEach(function(r) {
            const code = String((r && r.code) || '').trim();
            if (!code || !dateSet.has(code)) return;
            const pct = _parsePctText(r.changePct);
            if (pct === null) return;
            const ymd = String((r && r.date) || '').replace(/-/g, '');
            if (!ymd) return;
            if (!byCode.has(code)) byCode.set(code, new Map());
            byCode.get(code).set(ymd, pct);
        });
    };

    // ① 先读库（0 上游请求）—— 这是常态路径：每天 09:35 的 cron 已经把窗口铺好了
    //    ⚠️ 按【代码】收窄：本通道手里只有 code（没有股票名），
    //       不收窄的话「14 个自然日 × 全池上百只」会一次读上千行 ⇒ 必须翻好几页（见 REST_PAGE_SIZE）。
    accumulate(await readYiziTrendForDates(dates, { codes: codes }));

    // ② 仍有缺口 → 调 /trend 补一次（小号，自带全部额度闸门），再读库。
    //    允许少 1 天：T 腿由 range-fill 的 aucPctOf（快照竞价涨幅）负责，不依赖本通道。
    const wantDays = Math.max(1, Number(o.window) || 10);
    const complete = codes.every(function(c) {
        const m = byCode.get(c);
        return !!m && m.size >= wantDays - 1;
    });
    if (!complete && o.allowEdge !== false) {
        try {
            await fetchYiziTrendFromEdge({ date: o.date || endIso, window: wantDays });
            accumulate(await readYiziTrendForDates(dates, { codes: codes }));
        } catch (e) {
            // fail-soft：补腿失败只是「这次补不齐」——range-fill 会按缺腿处理（⛔ 不阻断看板）。
            // §10：这里吞掉异常是【刻意的】，因为调用方 range-fill 已经对「拿不到腿」有完整兜底；
            //      但必须留日志，否则又会变成「静默失效」。
            _dbgLog('[YIZI-TREND] 十日涨幅补腿失败（不影响看板）: ' + ((e && e.message) || e));
        }
    }
    return byCode;
}
