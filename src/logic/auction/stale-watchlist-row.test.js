// stale-watchlist-row.test.js — [STALE-WATCHLIST 2026-11-20] 历史日期 300+ 脏行的全局判据回归锁
//
// 必须锁住「整类」而不是某几天：脏行来自 4 个批次、横跨 100+ 天、source 各不相同
// （worker / numcat / manual / sql_migrate / main_migrate）。任何按日期 / 按单个 source 的
// 修法都会留下另一批，用户换一天复盘就又看到一屏脏数据。
import { describe, it, expect } from 'vitest';
import {
  STALE_WATCHLIST_MAX_DAYS,
  isStaleWatchlistRow,
  filterStaleWatchlistRows
} from './stale-watchlist-row.js';

const row = (o) => Object.assign({
  stock: '测试票', source: 'worker', note: '', topics: '',
  selected: false, bought: false, sold: false, fixed: false, obs_auto_added: false
}, o || {});

describe('isStaleWatchlistRow — 与日期、source 均无关的通用判据', () => {
  it('阈值 = 7 自然日（⛔ 不许为了「少删点」调到 1~2 天，会误杀事后补记）', () => {
    expect(STALE_WATCHLIST_MAX_DAYS).toBe(7);
  });

  it('★ 7-23 的 10-31 批次（357 行 worker|main）判脏', () => {
    const r = row({ created_at: '2026-10-31T09:49:04+00:00', updated_at: '2026-10-31T09:48:50+00:00' });
    expect(isStaleWatchlistRow(r, '2026-07-23')).toBe(true);
  });

  it('★ 10-30 的 11-18 批次（292 行 numcat）判脏；跟 source 无关，换成 worker 也一样', () => {
    const base = { created_at: '2026-11-18T16:42:34+00:00', updated_at: '2026-11-18T16:42:27+00:00' };
    expect(isStaleWatchlistRow(row(Object.assign({}, base, { source: 'numcat' })), '2026-10-30')).toBe(true);
    expect(isStaleWatchlistRow(row(Object.assign({}, base, { source: 'worker' })), '2026-10-30')).toBe(true);
    expect(isStaleWatchlistRow(row(Object.assign({}, base, { source: 'manual' })), '2026-10-30')).toBe(true);
  });

  it('★ 真·当日 worker 行保留（11-10 起健康日的形态）', () => {
    const r = row({ created_at: '2026-11-18T04:34:23+00:00', updated_at: '2026-11-19T01:25:27+00:00' });
    expect(isStaleWatchlistRow(r, '2026-11-19')).toBe(false);
  });

  it('★ 事后第 6 天补的人工行保留（created_at 贴近目标日即留，哪怕 updated_at 很远）', () => {
    const r = row({
      created_at: '2026-07-29T23:49:43+00:00',
      updated_at: '2026-11-18T16:42:34+00:00'
    });
    expect(isStaleWatchlistRow(r, '2026-07-23')).toBe(false);
  });

  it('★ 有人工标记 / 笔记 / 题材的行一律保留（含观察组）', () => {
    const far = { created_at: '2026-11-18T16:42:34+00:00', updated_at: '2026-11-18T16:42:27+00:00' };
    [
      { note: '手动记一笔' },
      { topics: '半导体,国产芯片' },
      { selected: true },
      { bought: true },
      { sold: true },
      { fixed: true },
      { obs_auto_added: true }
    ].forEach(patch => {
      expect(isStaleWatchlistRow(row(Object.assign({}, far, patch)), '2026-10-30'), JSON.stringify(patch)).toBe(false);
    });
  });

  it('§10：无时间信息 / 目标日未知 ⇒ 不猜，保留', () => {
    expect(isStaleWatchlistRow(row({}), '2026-10-30')).toBe(false);
    expect(isStaleWatchlistRow(row({ created_at: 'garbage' }), '2026-10-30')).toBe(false);
    expect(isStaleWatchlistRow(row({ created_at: '2026-11-18T16:42:34+00:00' }), '')).toBe(false);
  });

  it('边界：正好 7 天保留，第 8 天判脏', () => {
    const base = { updated_at: '2026-10-30T00:00:00+00:00' };
    expect(isStaleWatchlistRow(row(base), '2026-10-23')).toBe(false); // 相差 7 天
    expect(isStaleWatchlistRow(row(base), '2026-10-22')).toBe(true);  // 相差 8 天
  });
});

describe('filterStaleWatchlistRows — Data 层两个入口共用的批量过滤', () => {
  it('只剔除迁移行，保留原行引用，且不修改入参数组', () => {
    // 默认形态从 row.date 取目标日；夹具必须带 date，否则 §10「目标日未知 ⇒ 保留」让两行都留下
    const dirty = row({ stock: '脏票', date: '2026-10-30', created_at: '2026-11-18T16:42:34+00:00' });
    const clean = row({ stock: '真票', date: '2026-10-30', created_at: '2026-10-29T17:03:15+00:00' });
    const input = [dirty, clean];
    const out = filterStaleWatchlistRows(input);
    expect(out).toEqual([clean]);
    expect(out[0]).toBe(clean);
    expect(input).toHaveLength(2);
  });

  it('按日查询时可用 getDate 覆盖 row.date（watchlist-and-metrics 的调用形态）', () => {
    const dirty = row({ stock: '脏票', created_at: '2026-11-18T16:42:34+00:00', date: undefined });
    const out = filterStaleWatchlistRows([dirty], function () { return '2026-10-30'; });
    expect(out).toHaveLength(0);
  });

  it('空 / null 输入返回空数组，不抛错（§10 空 ≠ 读失败，由调用方区分）', () => {
    expect(filterStaleWatchlistRows([])).toEqual([]);
    expect(filterStaleWatchlistRows(null)).toEqual([]);
  });
});
