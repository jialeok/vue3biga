// board-pattern.test.js — 模式看板（pattern_data）Data 层回归测试
//
// 覆盖的是 2026-10-14 的线上事故「模式看板写入的内容显示了、之后就消失」（PATTERN-LOST）：
//   根因 = 一次【发起于保存之前】的在途旧读回，落地时把刚保存的内容覆盖成空；
//          随后 saveData() 的脏推送再把空内容写回云端 ⇒ 内容永久丢失。
//   详见 src/data/board-pattern.js 头部注释。
//
// 全部为【纯函数 / 零网络】测试：用 mock fetch 拦下所有请求并记录请求体，
// 靠「人为延迟读接口 + 在读接口发起时对云端内容取快照」来精确复刻那次竞态。
import { describe, it, expect, beforeEach } from 'vitest';

const reqs = [];
let readDelayMs = 0;
let cloudContent = '';

function installFetch() {
  globalThis.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : (url && url.url) || String(url);
    const body = init && init.body ? String(init.body) : '';
    const method = (init && init.method) || 'GET';
    const headers = (init && init.headers) || {};
    const accept = headers.Accept || headers.accept || '';
    reqs.push({ method, url: u, body });
    const isRead = method === 'GET' || method === 'HEAD';
    if (isRead) {
      // ★ 关键：快照在【发起读那一刻】取 —— 真实数据库的旧读回带的就是发起时的旧值
      const snapshot = cloudContent;
      if (readDelayMs) await new Promise((r) => setTimeout(r, readDelayMs));
      const row = { date: '2000-01-01', content: snapshot, update_flag: false, keep_flag: false };
      const single = String(accept).indexOf('pgrst.object') >= 0;
      return new Response(JSON.stringify(single ? row : [row]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    let written = null;
    try {
      const b = JSON.parse(body);
      written = Array.isArray(b) ? b[0] : b;
    } catch (e) { /* ignore */ }
    if (written && written.content !== undefined) cloudContent = written.content || '';
    return new Response(JSON.stringify([written]), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}
installFetch();

const LONG = '长文本'.repeat(50); // 150 字，代表「很长的文字」

/** 只保留写请求的请求体内容长度，便于断言 */
function writes() {
  return reqs
    .filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
    .map((r) => {
      try {
        const b = JSON.parse(r.body);
        const c = Array.isArray(b) ? b[0] : b;
        return { date: c && c.date, len: String((c && c.content) || '').length };
      } catch (e) {
        return { date: '?', len: -1 };
      }
    });
}

describe('board-pattern · PATTERN-LOST 回归（模式看板的内容不能被旧读回抹掉）', () => {
  beforeEach(() => {
    reqs.length = 0;
    readDelayMs = 0;
    cloudContent = '';
  });

  it('★ 回归钉：保存期间有一次在途的旧读回 ⇒ 云端内容绝不被抹成空', async () => {
    const D = '2001-01-01';
    const { savePatternData, getPatternData } = await import('../logic/pattern/pattern.js');
    const { loadPatternForDate } = await import('./board-pattern.js');
    const { pushRemainingNow, markRemainingDirty } = await import('./remaining-boards.js');
    const { _patternMemCache } = await import('./board-state.js');

    // ① 云端此刻是空的（与线上一致），先按空加载一次
    await loadPatternForDate(D);
    expect(String((_patternMemCache[D] || {}).content || '')).toBe('');

    // ② 一次「在途」的读回（Realtime 回显 / 日期切换触发）—— 慢 400ms，带的是旧值（空）
    readDelayMs = 400;
    const inflight = loadPatternForDate(D);

    // ③ 在它返回之前，用户点了保存（语句顺序与 PatternBoard.save 完全一致）
    await new Promise((r) => setTimeout(r, 120));
    getPatternData()[D] = { content: LONG, update: false, keep: false };
    markRemainingDirty('pattern', D); // = saveData() 里的 markAllDirty
    await savePatternData(D, { content: LONG, update: false, keep: false });
    expect(cloudContent).toBe(LONG); // 直连保存：云端已是新内容

    // ④ 那次在途旧读回落地 —— 修好之前这里会把缓存覆盖成空
    await inflight;
    expect(String((_patternMemCache[D] || {}).content || '')).toBe(LONG);

    // ⑤ 紧随其后的脏推送（saveData() 的 1.2s 防抖）
    await pushRemainingNow();
    expect(cloudContent).toBe(LONG); // ★ 核心断言：内容没被抹掉
    expect(writes().some((w) => w.date === D && w.len === 0)).toBe(false); // 从未推过空内容
  }, 20000);

  it('§10：缓存里【没有】这一天 ⇒ 不推（不把「没加载过」写成「空内容」）', async () => {
    const D = '2002-02-02';
    const { pushRemainingNow, markRemainingDirty } = await import('./remaining-boards.js');
    const { _patternMemCache } = await import('./board-state.js');

    delete _patternMemCache[D];            // 这一天从未加载过（未知）
    markRemainingDirty('pattern', D);
    await pushRemainingNow();

    expect(writes().some((w) => w.date === D)).toBe(false); // 未知 ≠ 空 ⇒ 一个字节都不写
  });

  it('§11：没有本地写入时，云端读回照常落地（护栏不误伤正常刷新 / 跨设备同步）', async () => {
    const D = '2003-03-03';
    const { loadPatternForDate } = await import('./board-pattern.js');
    const { _patternMemCache } = await import('./board-state.js');

    delete _patternMemCache[D];
    cloudContent = '云端另一台设备写的内容';
    await loadPatternForDate(D);

    expect(String((_patternMemCache[D] || {}).content || '')).toBe('云端另一台设备写的内容');
  });
});
