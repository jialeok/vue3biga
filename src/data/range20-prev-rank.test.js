// range20-prev-rank.test.js — 「昨日名次变化」的原始行读取（零网络：mock fetch 记录请求）
//
// 为什么单独钉这一组：这一列在【收盘前】走的是竞价口径（另一条路径），
// 收盘后才走本模块（收盘口径）。若本模块的取数、分页、§10 语义有错，
// 早上永远测不出来 —— 只有收盘那一刻才暴雷。所以用 mock 把它钉死。
import { describe, it, expect, beforeEach } from 'vitest';
import { readRange20PctRowsForDate, clearRange20PrevRankCache } from './range20-prev-rank.js';

const reqs = [];
let mode = 'rows';          // 'rows' | 'empty' | 'error'
let pageRows = [];          // mode='rows' 时按页返回的二维数组

globalThis.fetch = async (url, init) => {
  const u = typeof url === 'string' ? url : (url && url.url) || String(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  reqs.push({ method, url: u });

  const json = (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  if (mode === 'error') return json(500, { code: 'XX000', message: 'mock boom' });
  if (mode === 'empty') return json(200, []);
  // 分页：按请求里的 offset 取对应页（⛔ 不靠调用顺序猜）
  const m = /[?&]offset=(\d+)/.exec(u);
  const offset = m ? Number(m[1]) : 0;
  if (offset === 0) return json(200, pageRows[0] || []);
  return json(200, pageRows[1] || []);
};

beforeEach(function() {
  reqs.length = 0;
  mode = 'rows';
  pageRows = [];
  clearRange20PrevRankCache();
});

describe('range20-prev-rank · readRange20PctRowsForDate', function() {
  it('原样返回该日全部行（含两腿，由上层挑口径）', async function() {
    pageRows = [[
      { stock: '甲', pct: '12.5', leg: 'close' },
      { stock: '甲', pct: '11.0', leg: 'auc' }
    ]];
    const rows = await readRange20PctRowsForDate('2026-10-27');
    expect(rows).toHaveLength(2);
    expect(rows[0].leg).toBe('close');
    expect(reqs[0].url).toContain('date=eq.2026-10-27');
    expect(reqs[0].url).toContain('select=stock%2Cpct%2Cleg');
  });

  it('满页（1000 行）⇒ 自动翻页，直到不满页为止', async function() {
    const full = [];
    for (let i = 0; i < 1000; i++) full.push({ stock: 'S' + i, pct: String(i), leg: 'close' });
    pageRows = [full, [{ stock: '尾巴', pct: '1', leg: 'close' }]];
    const rows = await readRange20PctRowsForDate('2026-10-27');
    expect(rows).toHaveLength(1001);
    expect(reqs.length).toBe(2);                 // 第二次请求 offset=1000
    expect(reqs[1].url).toContain('offset=1000');
  });

  it('§10：该日一行都没有 ⇒ null（= 数据未到，⛔ 不是「谁都没名次」）', async function() {
    mode = 'empty';
    expect(await readRange20PctRowsForDate('2026-10-27')).toBeNull();
  });

  it('§10：读取失败 ⇒ throw（调用方据此判「判不出」，⛔ 不许吞成空）', async function() {
    mode = 'error';
    await expect(readRange20PctRowsForDate('2026-10-27')).rejects.toBeTruthy();
  });

  it('会话缓存：同一天第二次读不再发请求（§32）', async function() {
    pageRows = [[{ stock: '甲', pct: '9', leg: 'close' }]];
    await readRange20PctRowsForDate('2026-10-27');
    await readRange20PctRowsForDate('2026-10-27');
    expect(reqs.length).toBe(1);
  });

  it('空日期 ⇒ null，且一条请求都不发（§11 默认零行为）', async function() {
    expect(await readRange20PctRowsForDate('')).toBeNull();
    expect(reqs.length).toBe(0);
  });
});
