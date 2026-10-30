import { state } from '../../logic/app-state.js';
// fuyao-proxy.js — 同花顺 fuyao 行情接口代理（data/api/ 层）
// 从 app-core.js 抽离，纯数据层：不碰 DOM，只负责 HTTP 请求和错误处理

import { SUPABASE_ANON_KEY } from '../supabase-client.js';
import { _dbgLog } from '../debug-log.js';

const FUYAO_PROXY_BASE = 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy';
const FUYAO_DIRECT_BASE = 'https://fuyao.aicubes.cn';
export const LADDER_THSCODE = '883410.TI';

/**
 * ★★ [FUYAO-OFF 2026-10-30] 同花顺通道【临时总开关】。true = 整个前端不再请求 fuyao-proxy。
 *
 * 为什么要有它（用户 2026-10-30 20:45 原话：「太卡了，根本点不了应用，切换日期也不可以，就是卡顿。
 *   你先把同花顺撤掉，然后临时用腾讯的补 20 日数据」）：
 *
 *   当晚实测 fuyao-proxy 到上游**整条断掉**（给足 150s 仍不返回，一次 HTTP 546
 *   WORKER_RESOURCE_LIMIT、一次 502 `error sending request for url`；连交易日历这种 2 秒接口
 *   也 20s 超时）⇒ 本函数的**每一个**调用点都在挂死，而其中 6 处调用
 *   `fetchFuyaoDailyPctRange` 时**没传 timeoutMs** ⇒ 单请求无超时（= 挂到边缘函数自己死为止，
 *   约 120 秒），`range-fill` 一批最多 20 只 × 3 次重试、并发 3 ⇒ 同时有几十个永久 pending 请求，
 *   标签页网络被占满 ⇒ 表现为「点不动、切日期没反应」。
 *
 * 两个层次一起收口（§5 Data 是唯一入口，只改一处，⛔ 不去改 18 个业务调用点）：
 *   ① 本函数：直接**立刻**抛错（毫秒级），让各调用点既有的降级分支接管
 *      —— 它们本来就会在 120 秒后收到同样类型的错误，这里只是把「等 120 秒」变成「立刻」；
 *   ② `data/stock-range-pct.js#fetchFuyaoDailyPctRange`：见那边的 FUYAO-OFF 分支，
 *      **返回空 Map 而不是抛错** —— 因为 `range20.js` 用的是 `try { ... } finally { ... }`，
 *      抛出去会跳过最终发布（20 日涨幅整列不出数）。返回空 ⇒ 走「只用原料表的腿」这条正路。
 *
 * 历史腿从哪来：`stock_daily_pct`（已用腾讯前复权日线补齐，口径与同花顺 524 条真值 100% 一致）。
 * 恢复同花顺：把本常量改回 false 即可，其余代码零改动。
 */
const FUYAO_OFF = true;

/** 同花顺通道当前是否已停用（供 Logic 层判断「还要不要排 K 线补算」） */
export function isFuyaoOff() {
    return FUYAO_OFF;
}

// 调用同花顺 fuyao-proxy（GET），返回 data 字段
// [RANGE20 2026-10-19] 新增可选第 3 参 `opts.timeoutMs`：超时即 abort 并抛错。
//   为什么必须可选：实测上游偶发【不返回也不断开】（挂住），批量拉取时 `Promise.all`
//   会因此永不结算 ⇒ 整批补算永远发布不出来（20日涨幅卡在库内那几天）。
//   ⛔ 默认 undefined = 不设超时 ⇒ 既有调用方（十日涨幅 / 一字 / 涨跌停池）行为逐字不变（§11）。
export async function fuyaoApiGet(path, params, opts) {
    // [FUYAO-OFF] 见文件头。⛔ 必须放在 new URL 之前 —— 连构造请求都不做，一点网络都不产生。
    if (FUYAO_OFF) {
        _dbgLog('[FUYAO-OFF] 已停用同花顺通道，跳过请求: ' + path);
        throw new Error('同花顺通道已临时停用（上游不可用，见 data/api/fuyao-proxy.js 的 FUYAO-OFF）');
    }
    const url = new URL(FUYAO_PROXY_BASE);
    url.searchParams.set('path', path);
    for (const k in params) {
        if (params[k] !== undefined && params[k] !== null) {
            url.searchParams.set(k, params[k]);
        }
    }
    const timeoutMs = (opts && opts.timeoutMs) || 0;
    const ctrl = (timeoutMs > 0 && typeof AbortController !== 'undefined') ? new AbortController() : null;
    let _timer = null;
    // abort() 按规范不抛错 ⇒ 不需要 try/catch（也免得新增 no-empty 告警）
    if (ctrl) _timer = setTimeout(function() { ctrl.abort(); }, timeoutMs);
    let resp;
    try {
        resp = await fetch(url.toString(), {
            headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
            signal: ctrl ? ctrl.signal : undefined
        });
    } catch (netErr) {
        if (_timer) clearTimeout(_timer);
        _dbgLog('[FUYAO-NET-ERR] ' + path + ': ' + (netErr && netErr.message || netErr));
        if (netErr && netErr.name === 'AbortError') {
            throw new Error('代理请求超时（>' + timeoutMs + 'ms）：' + path);
        }
        throw new Error('代理请求失败（网络层）：' + (netErr && netErr.message || '未知错误') + '。请确认 fuyao-proxy Edge Function 已部署到 Supabase');
    }
    if (_timer) clearTimeout(_timer);
    if (!resp.ok) {
        let errBody = '';
        try { errBody = await resp.text(); } catch (e) {}
        _dbgLog('[FUYAO-HTTP-ERR] ' + path + ': HTTP ' + resp.status + ' ' + resp.statusText + ' body=' + errBody.slice(0, 200));
        if (resp.status === 404) {
            throw new Error('fuyao-proxy Edge Function 未部署（HTTP 404）。请在 Supabase Dashboard 部署 fuyao-proxy');
        }
        if (resp.status === 401 || resp.status === 403) {
            throw new Error('fuyao-proxy 鉴权失败（HTTP ' + resp.status + '）。请检查 state.SUPABASE_ANON_KEY 配置');
        }
        throw new Error('fuyao-proxy HTTP ' + resp.status + '：' + errBody.slice(0, 100));
    }
    let data;
    try {
        data = await resp.json();
    } catch (jsonErr) {
        let rawBody = '';
        try { rawBody = await resp.text(); } catch (e) {}
        _dbgLog('[FUYAO-JSON-ERR] ' + path + ': 响应非 JSON，body=' + rawBody.slice(0, 200));
        throw new Error('fuyao-proxy 返回非 JSON 响应（可能是 Edge Function 错误页）：' + rawBody.slice(0, 100));
    }
    if (data.code !== 0) {
        throw new Error(data.message || ('fuyao 接口错误 code=' + data.code));
    }
    return data.data;
}

// 直连 fuyao（绕过 supabase proxy，用 X-api-key 认证）
export async function fuyaoDirectGet(path, params, apiKey) {
    const url = new URL(FUYAO_DIRECT_BASE + path);
    for (const k in params) {
        if (params[k] !== undefined && params[k] !== null) {
            url.searchParams.set(k, params[k]);
        }
    }
    const resp = await fetch(url.toString(), { headers: { 'X-api-key': apiKey } });
    return resp.json();
}

// 6位代码转 thscode（同花顺格式）
export function tickerToThscode(ticker) {
    if (!ticker) return '';
    const t = String(ticker).trim();
    if (t.indexOf('.') >= 0) return t;
    if (t.length !== 6) return t;
    if (t.charAt(0) === '6') return t + '.SH';
    if (t.charAt(0) === '0' || t.charAt(0) === '3') return t + '.SZ';
    if (t.charAt(0) === '8' || t.charAt(0) === '4') return t + '.BJ'; // 北交所 43/83/87/88 段
    // [FIX 2026-09-10] 北交所 2024 起启用 920 号段，原先落到 .SZ → K 线恒空 →
    // 该股 10 日涨幅/竞价指标全天缺失（花溪科技 920895 实测）。
    if (t.slice(0, 2) === '92') return t + '.BJ';
    if (t.charAt(0) === '9') return t + '.SH'; // 900xxx 沪市 B 股
    return t + '.SZ';
}