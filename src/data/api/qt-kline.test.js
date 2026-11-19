import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// debug-log 会连带拉日志落库链路，单测里桩掉（本文件只验传输层选择逻辑，与日志无关）
vi.mock('../debug-log.js', function() {
  return { _dbgLog: vi.fn() };
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 2026-11-18 线上事故回归：`web.ifzq.gtimg.cn` 整站开始返回 **501 + WAF 挑战页（HTML）**
//
//   现场：早盘竞价看板「30日涨幅」打开后行上一直空白、也不按涨幅排序
//        （排序键就是这列数值，全部取不到 ⇒ 全部 null ⇒ 保持原序）。
//   实测：同路径把 host 换成 `ifzq.gtimg.cn`（去掉 `web.`）⇒ 200 + JSON，
//        且响应头带 `access-control-allow-origin: *`（浏览器可直连）。
//   ⇒ 契约：本模块必须在多个 host 之间【失败切换】，并且**必须按 content-type / 首字符
//     判 JSON**（WAF 的软拦截可能是 200 + HTML，光看 `resp.ok` 挡不住）。
//   下面几条把这个行为钉死，⛔ 别再改回「写死一个 host + resp.json()」。
// ══════════════════════════════════════════════════════════════════════════════════════

const WAF_HTML = '<!DOCTYPE html><html><head><script>var i=location.href;</script></head></html>';

/** 造一个 fetch 的假响应 */
function resp(body, opts) {
  const o = opts || {};
  const ctype = o.ctype || (String(body).charAt(0) === '{' ? 'application/json' : 'text/html; charset=UTF-8');
  return {
    ok: o.ok === undefined ? true : o.ok,
    status: o.status || 200,
    headers: { get: function(k) { return String(k).toLowerCase() === 'content-type' ? ctype : null; } },
    text: async function() { return body; }
  };
}

function qfqJson(sym, n) {
  const rows = [];
  for (let i = 0; i < (n || 3); i++) {
    rows.push(['2026-10-' + String(10 + i).padStart(2, '0'), '10.0', String(11 + i), '11.5', '9.8', '1000']);
  }
  const data = {};
  data[sym] = { qfqday: rows };
  return JSON.stringify({ code: 0, msg: '', data: data });
}

/** 东财 qfq 日线样例（fields2=f51..f57：日期,开,收,高,低,成交量(手),成交额） */
function emJson(n) {
  const lines = [];
  for (let i = 0; i < (n || 3); i++) {
    lines.push('2026-10-' + String(10 + i).padStart(2, '0') + ',10.0,' + String(11 + i) + ',11.5,9.8,246258,319663354.30');
  }
  return JSON.stringify({ rc: 0, data: { klines: lines } });
}

let mod;

beforeEach(async function() {
  vi.resetModules();                       // `_hostIdx` 是模块级状态，每个用例都要从头开始
  global.fetch = vi.fn();
  mod = await import('./qt-kline.js');
});

afterEach(function() {
  delete global.fetch;
});

describe('fetchQtDailyBars 的 host 失败切换（2026-11-18 WAF 事故）', () => {
  it('首个 host 返回 501 挑战页 ⇒ 自动换下一个 host 并正常出 bar', async function() {
    // 优先 host（ifzq）第一次 501，之后可用；web 一直可用 ⇒ 必须回落并拿到 bar
    let aFailed = false;
    global.fetch.mockImplementation(async function(url) {
      if (url.indexOf('https://ifzq.gtimg.cn') !== -1 && !aFailed) {
        aFailed = true;
        return resp(WAF_HTML, { ok: false, status: 501 });
      }
      return resp(qfqJson('sh600519'));
    });
    const out = await mod.fetchQtDailyBars(['600519'], '2026-10-01', '2026-11-18', { timeoutMs: 500, concurrency: 1 });
    expect(out.has('600519')).toBe(true);
    expect(out.get('600519').length).toBe(3);
    // 两次请求：第一次打 A（501）→ 第二次打 B（200）
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0].indexOf('https://ifzq.gtimg.cn')).toBe(0);
    expect(global.fetch.mock.calls[1][0].indexOf('https://web.ifzq.gtimg.cn')).toBe(0);
  });

  it('首个 host 返回 200 但内容是 HTML 挑战页（软拦截）⇒ 也必须换 host，⛔ 不当成数据', async function() {
    global.fetch.mockImplementation(async function(url) {
      if (url.indexOf('https://ifzq.gtimg.cn') !== -1 && !globalThis.__softFailed) {
        globalThis.__softFailed = true;
        return resp(WAF_HTML, { ok: true, status: 200 });   // ← 关键：HTTP 200
      }
      return resp(qfqJson('sh600519'));
    });
    const out = await mod.fetchQtDailyBars(['600519'], '2026-10-01', '2026-11-18', { timeoutMs: 500, concurrency: 1 });
    delete globalThis.__softFailed;
    expect(out.has('600519')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('两个 host 全挂 ⇒ 该票不在返回 Map 里（⛔ 不伪造空数组、⛔ 不抛断整批）', async function() {
    global.fetch.mockImplementation(async function() {
      return resp(WAF_HTML, { ok: false, status: 501 });
    });
    const out = await mod.fetchQtDailyBars(['600519', '000001'], '2026-10-01', '2026-11-18', { timeoutMs: 500, concurrency: 1 });
    expect(out.size).toBe(0);
  });

  it('腾讯两 host 全挂 ⇒ 切东财 qfq 日线兜底（2026-11-19 WAF 双杀）', async function() {
    global.fetch.mockImplementation(async function(url) {
      if (url.indexOf('ifzq.gtimg.cn') !== -1) return resp(WAF_HTML, { ok: false, status: 501 });
      if (url.indexOf('48.push2his.eastmoney.com') !== -1) return resp(emJson(4));
      return resp(WAF_HTML, { ok: false, status: 501 });
    });
    const out = await mod.fetchQtDailyBars(['002748'], '2026-10-30', '2026-11-21', { timeoutMs: 500, concurrency: 1 });
    expect(out.has('002748')).toBe(true);
    expect(out.get('002748').length).toBe(4);
    expect(out.get('002748')[0].volHand).toBe(246258);
    expect(global.fetch.mock.calls.some(function(c) { return c[0].indexOf('48.push2his.eastmoney.com') !== -1; })).toBe(true);
    // 东财请求必须是 fqt=1（前复权）+ klt=101（日线），否则昨量口径会变
    const emCall = global.fetch.mock.calls.find(function(c) { return c[0].indexOf('eastmoney.com') !== -1; });
    expect(emCall[0]).toContain('fqt=1');
    expect(emCall[0]).toContain('klt=101');
    expect(mod.emSecidOf('002748')).toBe('0.002748');
    expect(mod.emSecidOf('600519')).toBe('1.600519');
  });

  it('东财也返回 HTML 挑战页 ⇒ 该票仍不进 Map（⛔ 不把挑战页当数据）', async function() {
    global.fetch.mockImplementation(async function() {
      return resp(WAF_HTML, { ok: true, status: 200, ctype: 'text/html' });
    });
    const out = await mod.fetchQtDailyBars(['002748'], '2026-10-30', '2026-11-21', { timeoutMs: 500, concurrency: 1 });
    expect(out.size).toBe(0);
  });

  it('一旦某个 host 成功 ⇒ 后续只打它（锁定，不每次先撞一遍坏 host）', async function() {
    let aFailed = false;
    global.fetch.mockImplementation(async function(url) {
      if (url.indexOf('https://ifzq.gtimg.cn') !== -1 && !aFailed) {
        aFailed = true;
        return resp(WAF_HTML, { ok: false, status: 501 });
      }
      return resp(qfqJson('x'));
    });
    await mod.fetchQtDailyBars(['600519'], '2026-10-01', '2026-11-18', { timeoutMs: 500, concurrency: 1 });
    const afterFirst = global.fetch.mock.calls.length;   // 2 次：A 挂 + B 成
    global.fetch.mockClear();
    // 第二次调用：应直接打 B（1 次请求），不再先撞 A
    global.fetch.mockImplementation(async function() { return resp(qfqJson('x')); });
    await mod.fetchQtDailyBars(['600519'], '2026-10-01', '2026-11-18', { timeoutMs: 500, concurrency: 1 });
    expect(afterFirst).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0].indexOf('https://web.ifzq.gtimg.cn')).toBe(0);
  });
});

describe('qtSymOf 市场前缀规则（与 db/edge 同一条规则）', () => {
  it('6/9 开头 → sh；4/8 开头 → bj；其余 → sz；非 6 位 → 空', function() {
    expect(mod.qtSymOf('600519')).toBe('sh600519');
    expect(mod.qtSymOf('900901')).toBe('sh900901');
    expect(mod.qtSymOf('830799')).toBe('bj830799');
    // ⚠️ 现有实现 `/^(6|9)/` 先命中 9 ⇒ 920001 归 sh。这是既有行为（本文件不改它），
    //   锁成断言只为「日后有人动这段正则时能被这条测试拦住」。
    expect(mod.qtSymOf('920001')).toBe('sh920001');
    expect(mod.qtSymOf('000001')).toBe('sz000001');
    expect(mod.qtSymOf('60051')).toBe('');
    expect(mod.qtSymOf('')).toBe('');
  });
});
