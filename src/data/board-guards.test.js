// board-guards.test.js —— 「刷新页面不能把云端数据写坏」的回归钉（§10 读取失败 ≠ 空数据 / §11 删除安全）
//
// 【为什么需要这组用例】2026-10-28 实测（.tmpdiag/audit-boot-writes.cjs，生产包 + 无头 Chrome）：
//   打开/刷新一次页面，首屏就发出 **9~11 条写请求**，其中：
//     POST rank_data        {"date":"今天","data":[]}
//     POST multi_data       {"date":"今天","data":[]}
//     POST hotspot_data     {"date":"今天","content":""}
//     POST tag_titles_data  {"date":"今天","data":{全空结构}}
//   根因链：saveData() → markAllRemainingDirty(今天) → 1.2s 防抖 → saveXxxForDate 里
//   `_xxxMemCache[date] || 空值` 再 upsert ⇒ 「这一天根本没从云端读到」被当成「用户清空了」写回云端整行。
//   当时云端这几张表恰好本来就是空的，所以没暴雷；一旦有真实内容，一次刷新就会清空。
//
// 修法（本次）：load 记两条【事实】——「云端有没有这一行」「这次读有没有失败」；save 据此拒绝推送。
// 这组用例把三种行为钉死：
//   ① 读失败 ⇒ 一个字都不写（§10，最重要：禁止用「读不到」覆盖「读到了」）
//   ② 云端本来没这行 + 要写的也是空 ⇒ 不写（不建垃圾空行、不 White 花写请求）
//   ③ 云端【有】这行 + 用户真的清空 ⇒ 照常写（不许把正常删除也挡掉，§11 反向保护）
// 全部零网络：mock fetch 记录请求并按 mode 返回「有行 / 无行 / 报错」。
import { describe, it, expect, beforeEach } from 'vitest';

const reqs = [];
let mode = 'missing';       // 'missing' | 'hasRow' | 'error'
let rowPayload = null;      // hasRow 时 maybeSingle 返回的行
let listPayload = [];       // 非 maybeSingle（stocks 的 select('name')）返回的数组

globalThis.fetch = async (url, init) => {
  const u = typeof url === 'string' ? url : (url && url.url) || String(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  const body = init && init.body ? String(init.body) : '';
  const headers = (init && init.headers) || {};
  void headers;
  reqs.push({ method, url: u, body });

  const json = (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  if (mode === 'error') {
    return json(500, { code: 'XX000', message: 'mock boom', details: null, hint: null });
  }
  if (method === 'GET' || method === 'HEAD') {
    // ⚠️ postgrest-js v2：`.maybeSingle()` 在 GET 时把 Accept 设成 application/json，
    //    由客户端自己取 `rows[0] ?? null`（见 PostgrestTransformBuilder#maybeSingle）。
    //    所以「有行」要返回【单元素数组】，「无行」返回空数组。
    const isStocksList = u.indexOf('/stocks_data') >= 0;
    if (mode === 'missing') return json(200, []);
    return json(200, isStocksList ? listPayload : [rowPayload]);
  }
  return json(201, []);
};

function writes() {
  return reqs.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
}

const D = '2030-05-05';

let boardState;
let rankMod;
let multiMod;
let hotspotMod;
let tagTitlesMod;
let stocksMod;

beforeEach(async () => {
  reqs.length = 0;
  mode = 'missing';
  rowPayload = null;
  listPayload = [];
  boardState = await import('./board-state.js');
  rankMod = await import('./board-rank.js');
  multiMod = await import('./board-multi.js');
  hotspotMod = await import('./board-hotspot.js');
  tagTitlesMod = await import('./board-tagtitles.js');
  stocksMod = await import('./board-stocks.js');
  // 每个用例都从「干净的事实记录」开始，避免上一个用例的云端正/负事实串味
  Object.keys(boardState._caches).forEach((k) => {
    delete boardState._caches[k][D];
    boardState._cloudRowExists[k].delete(D);
    boardState._loadFailedDates[k].delete(D);
  });
});

describe('board-rank / board-multi · 首屏空写回归（§10 读取失败 ≠ 空数据）', () => {
  it('① 读取失败 ⇒ 保存一个字都不写（这一条保住云端有内容的行）', async () => {
    mode = 'error';
    await rankMod.loadRankForDate(D);
    await rankMod.saveRankForDate(D);
    expect(writes().length).toBe(0);
  });

  it('② 云端本来没有这一天 + 要写的也是空 ⇒ 不写（不建 data: [] 垃圾行）', async () => {
    mode = 'missing';
    await rankMod.loadRankForDate(D);
    await rankMod.saveRankForDate(D);
    expect(writes().length).toBe(0);
  });

  it('②b 云端没有这一天、但本地有真实数据 ⇒ 照常写', async () => {
    mode = 'missing';
    await rankMod.loadRankForDate(D);
    boardState._rankMemCache[D] = [{ topic: '工业4.0', rank: 1 }];
    await rankMod.saveRankForDate(D);
    expect(writes().length).toBe(1);
    expect(writes()[0].method).toBe('POST');
  });

  it('③ 云端【有】这一天 + 用户清空 ⇒ 照常写（不许把正常删除挡掉）', async () => {
    mode = 'hasRow';
    rowPayload = { date: D, data: [{ topic: '工业4.0' }] };
    await rankMod.loadRankForDate(D);
    boardState._rankMemCache[D] = [];
    await rankMod.saveRankForDate(D);
    expect(writes().length).toBe(1);
  });

  it('读失败后如果又读成功一次 ⇒ 解除禁写（不能永久卡死保存）', async () => {
    mode = 'error';
    await rankMod.loadRankForDate(D);
    mode = 'hasRow';
    rowPayload = { date: D, data: [{ topic: 'x' }] };
    await rankMod.loadRankForDate(D);
    boardState._rankMemCache[D] = [];
    await rankMod.saveRankForDate(D);
    expect(writes().length).toBe(1);
  });

  it('multi 与 rank 同构：读取失败 ⇒ 不写', async () => {
    mode = 'error';
    await multiMod.loadMultiForDate(D);
    await multiMod.saveMultiForDate(D);
    expect(writes().length).toBe(0);
  });
});

describe('board-hotspot · 空字符串是合法内容，但「没加载过」不是', () => {
  it('读取失败 ⇒ 不写', async () => {
    mode = 'error';
    await hotspotMod.loadHotspotForDate(D);
    await hotspotMod.saveHotspotForDate(D);
    expect(writes().length).toBe(0);
  });

  it('云端没有这一天 + 内容为空串 ⇒ 不写', async () => {
    mode = 'missing';
    await hotspotMod.loadHotspotForDate(D);
    await hotspotMod.saveHotspotForDate(D);
    expect(writes().length).toBe(0);
  });

  it('云端【有】这一天 + 用户清成空串 ⇒ 照常写（空串是合法的「已清空」）', async () => {
    mode = 'hasRow';
    rowPayload = { date: D, content: '热点笔记' };
    await hotspotMod.loadHotspotForDate(D);
    boardState._hotspotMemCache[D] = '';
    await hotspotMod.saveHotspotForDate(D);
    expect(writes().length).toBe(1);
  });
});

describe('board-tagtitles · 最阴的一条：凭空造「结构合法但全空」的数据', () => {
  it('读取失败 ⇒ 不写', async () => {
    mode = 'error';
    await tagTitlesMod.loadTagTitlesForDate(D);
    await tagTitlesMod.saveTagTitlesForDate(D);
    expect(writes().length).toBe(0);
  });

  it('云端没有这一天 + 内存里只有默认空结构 ⇒ 不写', async () => {
    mode = 'missing';
    await tagTitlesMod.loadTagTitlesForDate(D);
    await tagTitlesMod.saveTagTitlesForDate(D);
    expect(writes().length).toBe(0);
  });

  it('「全空但结构合法」的判定本身', () => {
    const f = tagTitlesMod._isBlankTagTitles;
    expect(f(null)).toBe(true);
    expect(f({ recentMulti: { tags: [], active: {} }, sectorEtf: { tags: [], active: {} }, topicDirection: { tags: [], active: {} }, consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 } })).toBe(true);
    expect(f({ recentMulti: { tags: ['工业4.0'], active: {} }, sectorEtf: { tags: [], active: {} }, topicDirection: { tags: [], active: {} }, consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 } })).toBe(false);
    expect(f({ recentMulti: { tags: [], active: {} }, sectorEtf: { tags: [], active: {} }, topicDirection: { tags: [], active: {} }, consecutiveUp: { duoban: 3, bankuai: 0, ticai: 0 } })).toBe(false);
  });

  it('云端【有】这一天 + 用户把标签全清掉 ⇒ 照常写', async () => {
    mode = 'hasRow';
    rowPayload = { date: D, data: { recentMulti: { tags: ['工业4.0'], active: {} }, sectorEtf: { tags: [], active: {} }, topicDirection: { tags: [], active: {} }, consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 } } };
    await tagTitlesMod.loadTagTitlesForDate(D);
    boardState._tagTitlesMemCache[D] = { recentMulti: { tags: [], active: {} }, sectorEtf: { tags: [], active: {} }, topicDirection: { tags: [], active: {} }, consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 } };
    await tagTitlesMod.saveTagTitlesForDate(D);
    expect(writes().length).toBe(1);
  });
});

describe('board-stocks · 差集删除最危险：读失败后一推就是硬删', () => {
  it('① 读取失败 ⇒ 不写（否则差集会把云端这一天的名单整批 DELETE）', async () => {
    mode = 'error';
    await stocksMod.loadStocksForDate(D);
    await stocksMod.saveStocksForDate(D);
    expect(writes().length).toBe(0);
  });

  it('② 云端没有这一天 + 本地也空 ⇒ 不写（不白跑一次 select）', async () => {
    mode = 'missing';
    await stocksMod.loadStocksForDate(D);
    await stocksMod.saveStocksForDate(D);
    expect(writes().length).toBe(0);
  });

  it('③ 云端有名单 + 用户把股票全删了 ⇒ 照常发 upsert/DELETE', async () => {
    mode = 'hasRow';
    listPayload = [{ date: D, name: '大业股份', local_id: 1 }, { date: D, name: '上海九百', local_id: 2 }];
    await stocksMod.loadStocksForDate(D);
    expect(boardState._stocksMemCache[D].length).toBe(2);
    boardState._stocksMemCache[D] = [];
    await stocksMod.saveStocksForDate(D);
    expect(writes().some((w) => w.method === 'DELETE')).toBe(true);
  });
});
