// numcat-api.test.js — 「主账号额度用尽 → 自动退回小号」回归测试
//
// 【为什么必须有这个测试】
//   用户硬指标：每个交易日 9:25~9:26 早盘竞价看板数据必须完整（盘前下单 + 决策看板都依赖它）。
//   猫抓免费档每天只有 10 次额度、谁先花光谁让别人全废。2026-09-28 实发：
//   前端 9:24 抢跑烧光主账号 → worker 9:25 的 daily_auc 拿到 code=403
//   → 当天 竞价量 / 昨成交量 / 竞价涨幅 整片为空，只能事后手工补。
//   兜底链路一旦被写坏（换 key 条件放宽、错误吞掉、重试不停），当天就会再瞎一次，
//   所以这里把四条不变量钉死：
//     ① 主账号成功时【绝不】打小号（小号额度必须省着）；
//     ② 只有额度类错误才换 key —— 网络错误换 key 等于白烧小号（§32）；
//     ③ 两把都额度用尽 → 抛出的错误必须带 quotaExhausted（否则 worker 会白等 25s 顶穿 9:26）；
//     ④ 小号没配 Secret → 行为与改造前完全一致（只用主账号），不能报错。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { numcatDailyAuc, numcatDaily, postNumcat, configuredKeys, maskKey, isQuotaError } from './numcat-api.js';
import { CONFIG } from '../config.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ENV = { NUMCAT_API_KEY: 'main-key-0001', NUMCAT_API_KEY_YIZI: 'small-key-0002' };

/** 构造上游响应：{ ok, status, json|text } */
function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}
const okBody = { code: 200, data: { fields: ['tradedate'], items: [] } };
const quotaBody = { code: 403, message: '今日调用额度已用完' };

/** 按 key 路由的 fetch 桩：byKey = { 'main-key-0001': resp, 'small-key-0002': resp } */
function stubFetch(byKey, calls) {
  globalThis.fetch = vi.fn((url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: url, apikey: body.apikey, apiname: body.apiname });
    const hit = byKey[body.apikey];
    if (!hit) throw new Error('unexpected key ' + body.apikey);
    if (typeof hit === 'function') return hit();
    return Promise.resolve(hit);
  });
}

describe('configuredKeys / maskKey / isQuotaError', () => {
  it('候选链 = 主账号 → 小号', () => {
    const ks = configuredKeys(ENV);
    expect(ks.map(k => k.name)).toEqual(['NUMCAT_API_KEY', 'NUMCAT_API_KEY_YIZI']);
  });

  it('只配主账号时候选链只有 1 把（小号未配 = 兜底静默关闭，但不报错）', () => {
    const ks = configuredKeys({ NUMCAT_API_KEY: 'm' });
    expect(ks.length).toBe(1);
    expect(ks[0].name).toBe('NUMCAT_API_KEY');
  });

  it('两把 key 相同 → 去重，只留 1 把', () => {
    const ks = configuredKeys({ NUMCAT_API_KEY: 'same', NUMCAT_API_KEY_YIZI: 'same' });
    expect(ks.length).toBe(1);
  });

  it('maskKey 不回显全量', () => {
    const m = maskKey('abcdefghijkl');
    expect(m).toBe('abcd***ijkl');
    expect(m.indexOf('efgh')).toBe(-1);
  });

  it('isQuotaError 只认额度/限流类', () => {
    expect(isQuotaError('numcat daily_auc 错误: 今日调用额度已用完（上游 code=403）')).toBe(true);
    expect(isQuotaError('numcat daily_auc HTTP 429: too many')).toBe(true);
    expect(isQuotaError('RATE_LIMIT_EXCEEDED')).toBe(true);
    expect(isQuotaError('fetch failed')).toBe(false);
    expect(isQuotaError('numcat daily 返回字段不完整')).toBe(false);
  });
});

describe('postNumcat 候选链', () => {
  it('① 主账号成功 → 只打 1 次，且用的就是主账号 key', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, okBody) }, calls);
    const logs = [];
    const res = await postNumcat(ENV, {
      apiname: 'daily_auc', url: CONFIG.NUMCAT_DAILY_AUC_URL, fields: ['a'], params: {}, logs
    });
    expect(calls.length).toBe(1);
    expect(calls[0].apikey).toBe('main-key-0001');
    expect(res.keyName).toBe('NUMCAT_API_KEY');
    expect(logs.join('|').indexOf('退回') >= 0).toBe(false);   // 没退回就不该出现「退回」字样
  });

  it('② 主账号 403 → 自动退回小号并成功（2 次请求）', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, quotaBody), 'small-key-0002': resp(200, okBody) }, calls);
    const logs = [];
    const res = await postNumcat(ENV, {
      apiname: 'daily_auc', url: CONFIG.NUMCAT_DAILY_AUC_URL, fields: ['a'], params: {}, logs
    });
    expect(calls.length).toBe(2);
    expect(calls[0].apikey).toBe('main-key-0001');
    expect(calls[1].apikey).toBe('small-key-0002');            // ★ 兜底真的用上了小号
    expect(res.keyName).toBe('NUMCAT_API_KEY_YIZI');
    const s = logs.join('|');
    expect(s.indexOf('主账号额度用尽，退回下一把 key') >= 0).toBe(true);
    expect(s.indexOf('已退回【小号 NUMCAT_API_KEY_YIZI') >= 0).toBe(true);
  });

  it('③ 两把都 403 → 抛错且带 quotaExhausted（调用方据此立刻停止重试，不白等 25s）', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, quotaBody), 'small-key-0002': resp(200, quotaBody) }, calls);
    let err = null;
    try {
      await postNumcat(ENV, { apiname: 'daily', url: CONFIG.NUMCAT_DAILY_URL, fields: ['a'], params: {}, logs: [] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.quotaExhausted).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('④ 非额度错误（网络/DNS）→ 不换 key，只打 1 次（§32 不白烧小号额度）', async () => {
    const calls = [];
    globalThis.fetch = vi.fn((url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ apikey: body.apikey });
      return Promise.reject(new Error('fetch failed'));
    });
    let err = null;
    try {
      await postNumcat(ENV, { apiname: 'daily', url: CONFIG.NUMCAT_DAILY_URL, fields: ['a'], params: {}, logs: [] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.quotaExhausted).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].apikey).toBe('main-key-0001');
  });

  it('⑤ 上游 HTTP 403（非 JSON code）同样触发退回', async () => {
    const calls = [];
    globalThis.fetch = vi.fn((url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ apikey: body.apikey });
      return Promise.resolve(body.apikey === 'main-key-0001'
        ? resp(403, { message: 'forbidden' })
        : resp(200, okBody));
    });
    const res = await postNumcat(ENV, {
      apiname: 'daily_auc', url: CONFIG.NUMCAT_DAILY_AUC_URL, fields: ['a'], params: {}, logs: []
    });
    expect(calls.length).toBe(2);
    expect(res.keyName).toBe('NUMCAT_API_KEY_YIZI');
  });

  it('⑥ 只配小号（主账号没配）→ 直接用小号，不报错', async () => {
    const calls = [];
    stubFetch({ 'small-key-0002': resp(200, okBody) }, calls);
    const res = await postNumcat({ NUMCAT_API_KEY_YIZI: 'small-key-0002' }, {
      apiname: 'daily_auc', url: CONFIG.NUMCAT_DAILY_AUC_URL, fields: ['a'], params: {}, logs: []
    });
    expect(calls.length).toBe(1);
    expect(res.keyName).toBe('NUMCAT_API_KEY_YIZI');
  });

  it('⑦ 一把 key 都没配 → 明确报错（不静默）', async () => {
    let err = null;
    try {
      await postNumcat({}, { apiname: 'daily_auc', url: 'x', fields: [], params: {}, logs: [] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message.indexOf('未配置 key') >= 0).toBe(true);
  });
});

describe('numcatDailyAuc / numcatDaily 走同一条候选链', () => {
  it('daily_auc：主账号 403 → 小号成功，且 apiname 与 params 原样传递', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, quotaBody), 'small-key-0002': resp(200, okBody) }, calls);
    await numcatDailyAuc(ENV, '000001,600000', '20260922', '20260928', []);
    expect(calls.length).toBe(2);
    expect(calls[1].apiname).toBe('daily_auc');
    expect(calls[1].url).toBe(CONFIG.NUMCAT_DAILY_AUC_URL);
  });

  it('daily：主账号 403 → 小号成功', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, quotaBody), 'small-key-0002': resp(200, okBody) }, calls);
    await numcatDaily(ENV, '000001', '20260915', '20260928', []);
    expect(calls.length).toBe(2);
    expect(calls[1].apiname).toBe('daily');
    expect(calls[1].url).toBe(CONFIG.NUMCAT_DAILY_URL);
  });

  it('logs 可选（不传也不报错）——close/extras 等调用点不受影响', async () => {
    const calls = [];
    stubFetch({ 'main-key-0001': resp(200, okBody) }, calls);
    const d = await numcatDailyAuc(ENV, '000001', '20260922', '20260928');
    expect(d).toBeTruthy();
    expect(calls.length).toBe(1);
  });
});
