import { state } from '../../logic/app-state.js';
// fuyao-proxy.js — 同花顺 fuyao 行情接口代理（data/api/ 层）
// 从 app-core.js 抽离，纯数据层：不碰 DOM，只负责 HTTP 请求和错误处理

import { SUPABASE_ANON_KEY } from '../supabase-client.js';
import { _dbgLog } from '../debug-log.js';

const FUYAO_PROXY_BASE = 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy';
const FUYAO_DIRECT_BASE = 'https://fuyao.aicubes.cn';
export const LADDER_THSCODE = '883410.TI';

// 调用同花顺 fuyao-proxy（GET），返回 data 字段
export async function fuyaoApiGet(path, params) {
    const url = new URL(FUYAO_PROXY_BASE);
    url.searchParams.set('path', path);
    for (const k in params) {
        if (params[k] !== undefined && params[k] !== null) {
            url.searchParams.set(k, params[k]);
        }
    }
    let resp;
    try {
        resp = await fetch(url.toString(), {
            headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
    } catch (netErr) {
        _dbgLog('[FUYAO-NET-ERR] ' + path + ': ' + (netErr && netErr.message || netErr));
        throw new Error('代理请求失败（网络层）：' + (netErr && netErr.message || '未知错误') + '。请确认 fuyao-proxy Edge Function 已部署到 Supabase');
    }
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
    if (t.charAt(0) === '8' || t.charAt(0) === '4') return t + '.BJ';
    return t + '.SZ';
}