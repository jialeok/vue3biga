// tencent-snapshot.test.js — ETF 收盘涨幅「腾讯行情」腿的回归测试
//
// 【为什么必须有这个测试】
//   2026-11-12 / 11-13 竞价变化看板收盘列连缺两天，`大盘ETF` 长期为空、`板块ETF` 数字偏小。
//   根因不是前端、不是字段、也不是「Cloudflare 免费额度」，而是【数据源错配】：
//   Worker 把 49 只 ETF 混进同花顺 `/api/a-share/prices/snapshot` 批次，
//   而该接口对 ETF 恒定回 `code=3001 Target not found`（实测 .SH / .SZ 都一样），
//   混批时坏代码被静默丢弃 ⇒ 日志 `个股/ETF 快照可用 61/110`，61 = 883410(51) + 883901(10)，
//   110 − 61 = 49 正好是全部 ETF。
//
//   这个测试同时锁住三件事，防止有人「顺手优化」把 bug 改回来：
//     ① ETF 必须走腾讯（源码里 bidding-close-write.js 不许再把 etfCodes 拼进 stockCodes）；
//     ② 腾讯返回的 GBK 文本能正确解析出字段 32（涨幅%），且 key 是带后缀 thscode；
//     ③ 读失败 ≠ 0（§10）：拿不到的 ETF 不进 pctMap，绝不出现 0。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tencentSymOf, parseTencentSnapshot, fetchTencentSnapshotPcts } from './tencent-snapshot.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** 造一条腾讯行情记录：字段 32 = 涨幅%，字段 3/4 = 现价/昨收 */
function line(sym, pct, curr, prev) {
  const f = new Array(50).fill('');
  f[1] = 'xxx';
  f[3] = String(curr);
  f[4] = String(prev);
  f[32] = String(pct);
  return 'v_' + sym + '="' + f.join('~') + '";\n';
}

/** 腾讯响应是 GBK；本模块按 latin1 读字节，这里直接给 ASCII 桩即可验证解析 */
function stubFetch(body, opts) {
  const o = opts || {};
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(String(url));
    if (o.fail) return Promise.reject(new Error('ECONNRESET'));
    if (o.http500) return Promise.resolve({ ok: false, status: 500, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    const buf = Buffer.from(body, 'latin1');
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    });
  };
  return calls;
}

describe('tencentSymOf', () => {
  it('带后缀 thscode 直接映射（与前端 helpers.js 同口径）', () => {
    expect(tencentSymOf('510300.SH')).toBe('sh510300');
    expect(tencentSymOf('159995.SZ')).toBe('sz159995');
    expect(tencentSymOf('560780.SH')).toBe('sh560780');
    expect(tencentSymOf('167301.SZ')).toBe('sz167301');
  });

  it('不带后缀按板块推断：5/6/9 → sh，其余 → sz', () => {
    expect(tencentSymOf('510050')).toBe('sh510050');
    expect(tencentSymOf('600519')).toBe('sh600519');
    expect(tencentSymOf('000001')).toBe('sz000001');
    expect(tencentSymOf('300750')).toBe('sz300750');
  });

  it('北交所 / 非法代码返回空串（不硬凑，避免又造出一批假请求）', () => {
    expect(tencentSymOf('920001.BJ')).toBe('');
    expect(tencentSymOf('830799.BJ')).toBe('');
    expect(tencentSymOf('')).toBe('');
    expect(tencentSymOf('abc')).toBe('');
    expect(tencentSymOf('51030')).toBe('');
  });
});

describe('parseTencentSnapshot', () => {
  it('取字段 32 作涨幅，key 还原成带后缀 thscode', () => {
    const text = line('sh510300', -0.75, 4.083, 4.114) + line('sz159995', -2.04, 0.863, 0.881);
    const r = parseTencentSnapshot(text);
    expect(r.pctMap['510300.SH']).toBe(-0.75);
    expect(r.pctMap['159995.SZ']).toBe(-2.04);
    expect(r.stats.itemsReturned).toBe(2);
    expect(r.stats.emptyField).toBe(0);
  });

  it('字段 32 缺失时用 现价/昨收 反算（避免上游偶发空字段整批丢）', () => {
    const text = line('sh510500', '', 6.0, 6.12); // (6.0-6.12)/6.12 = -1.96%
    const r = parseTencentSnapshot(text);
    expect(r.pctMap['510500.SH']).toBeCloseTo(-1.96, 2);
  });

  it('⚠️ 认不出涨幅时【不入 map】（§10：读不到 ≠ 0）', () => {
    const bad = line('sh512480', '', '', '');
    const r = parseTencentSnapshot(bad);
    expect(r.pctMap['512480.SH']).toBeUndefined();
    expect(Object.keys(r.pctMap).length).toBe(0);
    expect(r.stats.emptyField).toBe(1);
    expect(Object.values(r.pctMap)).not.toContain(0);
  });

  it('中文名是 GBK 乱码也不影响解析（只依赖 ASCII 结构）', () => {
    // name 字段塞入 GBK 高位字节
    const f = new Array(50).fill('');
    f[1] = '\xb0\xeb\xb5\xbc\xcc\xe5'; // 「半导体」的 GBK 字节被当 latin1 读
    f[3] = '0.793'; f[4] = '0.813'; f[32] = '-2.46';
    const r = parseTencentSnapshot('v_sh512480="' + f.join('~') + '";');
    expect(r.pctMap['512480.SH']).toBe(-2.46);
  });
});

describe('fetchTencentSnapshotPcts', () => {
  it('正常批次：49 只全中，统计口径正确', async () => {
    const codes = ['510300.SH', '159995.SZ', '512480.SH'];
    stubFetch(codes.map((c, i) => line(tencentSymOf(c), -(i + 1), 1, 1)).join(''));
    const r = await fetchTencentSnapshotPcts(codes);
    expect(Object.keys(r.pctMap).length).toBe(3);
    expect(r.stats.totalInput).toBe(3);
    expect(r.stats.symbolOk).toBe(3);
    expect(r.stats.batchOk).toBe(1);
    expect(r.stats.batchFail).toBe(0);
    expect(r.stats.success).toBe(3);
  });

  it('整批失败不抛错、不写 0，只累计 batchFail（失败不连坐）', async () => {
    stubFetch('', { fail: true });
    const r = await fetchTencentSnapshotPcts(['510300.SH', '512480.SH']);
    expect(r.stats.batchFail).toBe(1);
    expect(r.stats.batchOk).toBe(0);
    expect(Object.keys(r.pctMap).length).toBe(0);
    expect(r.pctMap['510300.SH']).toBeUndefined();
  });

  it('HTTP 500 同样只记 batchFail', async () => {
    stubFetch('', { http500: true });
    const r = await fetchTencentSnapshotPcts(['510300.SH']);
    expect(r.stats.batchFail).toBe(1);
    expect(r.stats.success).toBe(0);
  });

  it('北交所代码被跳过但不影响其它代码取数', async () => {
    stubFetch(line('sh510300', 1.5, 1, 1));
    const r = await fetchTencentSnapshotPcts(['920001.BJ', '510300.SH']);
    expect(r.stats.totalInput).toBe(2);
    expect(r.stats.symbolOk).toBe(1);
    expect(r.pctMap['510300.SH']).toBe(1.5);
  });

  it('去重 + 一次请求装完整批（49 只不进两次请求，省 subrequest）', async () => {
    const codes = Array.from({ length: 49 }, (_, i) => String(500000 + i) + '.SH');
    const calls = stubFetch(line('sh500000', 1, 1, 1));
    await fetchTencentSnapshotPcts(codes.concat(codes)); // 故意重复
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('https://qt.gtimg.cn/q=');
    expect(calls[0].split(',').length).toBe(49);
  });
});

describe('[ETF-TENCENT] 源码静态锁 —— 防止改回同花顺', () => {
  const read = p => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

  it('bidding-close-write.js：ETF 不许再拼进同花顺 stockCodes', () => {
    const s = read('workers/bidding-auto-fetch/logic/bidding-close-write.js');
    expect(s).toContain('fetchTencentSnapshotPcts');
    expect(s).toContain('etfCodes');
    // 旧实现（会把 49 只 ETF 混进同花顺批次）—— 必须彻底消失
    expect(s).not.toContain('concat(ladderCodes, top10Codes, etfBare, BIDDING_BIG_ETFS)');
    expect(s).not.toContain('etfBare');
    // ETF 与个股必须分两条腿各自打点，混在一起就没法定位「谁缺了」
    expect(s).toContain('个股快照可用');
    expect(s).toContain('ETF 快照可用（腾讯）');
  });

  it('tencent-snapshot.js：命中/失败都要有 stats，且不写 0 的语义有注释锁', () => {
    const s = read('workers/bidding-auto-fetch/data/tencent-snapshot.js');
    expect(s).toContain('qt.gtimg.cn');
    expect(s).toContain('读失败 ≠ 0');
    expect(s).toContain('batchFail');
  });
});
