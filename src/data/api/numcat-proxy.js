import { state } from '../../logic/app-state.js';
// numcat-proxy.js — 猫抓 numcat �5 接口代理（data/api/ 层）
// 从 app-core.js 抽离，纯数据层：不碰 DOM，只负责 HTTP 请求和错误处理

import { SUPABASE_ANON_KEY } from '../supabase-client.js';
import { _dbgLog } from '../debug-log.js';

const NUMCAT_PROXY_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/numcat-proxy';


// 调用猫抓 numcat-proxy（POST），返回 data 字段
export async function numcatApiPost(apiname, fields, params, pathOverride) {
    const body = { apiname: apiname, fields: fields, params: params || {} };
    if (pathOverride) body.path = pathOverride;
    let resp;
    try {
        resp = await fetch(NUMCAT_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify(body)
        });
    } catch (netErr) {
        _dbgLog('[NUMCAT-NET-ERR] ' + apiname + ': ' + (netErr && netErr.message || netErr));
        throw new Error('代理请求失败（网络层）：' + (netErr && netErr.message || '未知错误') + '。请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置');
    }
    if (!resp.ok) {
        let errBody = '';
        try { errBody = await resp.text(); } catch (e) {}
        _dbgLog('[NUMCAT-HTTP-ERR] ' + apiname + ': HTTP ' + resp.status + ' ' + resp.statusText + ' body=' + errBody.slice(0, 200));
        if (resp.status === 404) {
            throw new Error('numcat-proxy Edge Function 未部署（HTTP 404）。请在 Supabase Dashboard 部署 numcat-proxy 并设置 NUMCAT_API_KEY');
        }
        if (resp.status === 401 || resp.status === 403) {
            throw new Error('numcat-proxy 鉴权失败（HTTP ' + resp.status + '）。请检查 state.SUPABASE_ANON_KEY 配置');
        }
        if (resp.status === 500) {
            throw new Error('numcat-proxy 内部错误（HTTP 500）：' + errBody.slice(0, 150) + '。请检查 NUMCAT_API_KEY 是否设置');
        }
        throw new Error('numcat-proxy HTTP ' + resp.status + '：' + errBody.slice(0, 100));
    }
    let data;
    try {
        data = await resp.json();
    } catch (jsonErr) {
        let rawBody = '';
        try { rawBody = await resp.text(); } catch (e) {}
        _dbgLog('[NUMCAT-JSON-ERR] ' + apiname + ': 响应非 JSON，body=' + rawBody.slice(0, 200));
        throw new Error('numcat-proxy 返回非 JSON 响应：' + rawBody.slice(0, 100));
    }
    if (data.code !== 200) {
        // [FIX 2026-09-09] 猫抓免费额度每天仅 10 次，用尽后所有猫抓类按钮都会失败。
        // 此前只抛原始 message（"今日调用额度已用完"），用户无法判断是「代码坏了」还是「额度没了」，
        // 也不知道替代方案 → 这里补上可执行的处置建议。
        if (data.code === 403 || (data.message || '').indexOf('额度') >= 0) {
            throw new Error('猫抓今日额度已用完（免费额度每天 10 次，北京时间 0 点重置）：' +
                (data.message || '') + '。请改用「同花顺接口」组按钮，或明天再试。');
        }
        throw new Error(data.message || ('numcat 接口错误 code=' + data.code));
    }
    return data.data;
}