// view-sort-order.test.js — 主排序矩阵 + 档位判定单测（§15 纯函数优先）
//
// 为什么值得单独测：这段以前挤在 computeAuctionViewData（1090 行）里，只能靠真机看板验证。
// 抽成纯函数后，四条主排序分支 + 档位判定可以逐条锁死：
//   ① 默认（所有 toggle 关闭）⇒ 顺序必须**原样不动**（§11 零行为变化）
//   ② 十日 / 20日涨幅 ⇒ 走同一个比较器，缺数据置底
//   ③ 竞/昨（分层）⇒ tier0 高光 → tier1 平行 → tier2 其它，同档按竞价涨幅降序
//   ④ 竞/昨占比（分层）⇒ tier0 高光 → tier1 其它，同档按量比降序
//   ⑤ 档位判定 resolveTopicTierOf 必须与 ③④ 逐字一致（否则题材块内高光票会跑到下面）
//   ⑥ 惰性：关掉的 toggle 绝不去读那一份 Map（§32 不做无用功）

import { describe, it, expect, vi } from 'vitest';
import { buildRenderOrder, resolveTopicTierOf } from './view-sort-order.js';

/** 造几行最简单的数据：name + volume/yestVolume + auc 涨幅 */
function rows(list) {
  return list.map(function(x) {
    return { stock: x.n, volume: x.v == null ? '' : String(x.v), yestVolume: x.y == null ? '' : String(x.y), auc_pct_chg: x.a == null ? '' : String(x.a) };
  });
}
function idx(n) { return Array.from({ length: n }, function(_, i) { return i; }); }
function names(list, order) { return order.map(function(i) { return list[i].stock; }); }

const noToggle = { byJingYest: false, byJingYestRatio: false, byRangePct: false, byRangePct20: false, byAuctionLeg: false };

describe('[SORT-ORDER] 默认：没有任何 toggle ⇒ 顺序原样不动（§11）', () => {
  it('返回的索引数组与输入逐项相等', () => {
    const list = rows([{ n: 'A' }, { n: 'B' }, { n: 'C' }]);
    const up10 = vi.fn();
    const up20 = vi.fn();
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list, sortState: noToggle,
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: up10, rangeMapOf20: up20,
      auctionPctOf: function() { return null; }
    });
    expect(out).toEqual([0, 1, 2]);
    // ⑥ 惰性：两个 Map 读取函数一次都不该被调用
    expect(up10).not.toHaveBeenCalled();
    expect(up20).not.toHaveBeenCalled();
  });
});

describe('[SORT-ORDER] 区间涨幅（十日 / 20日）⇒ 同一个比较器，缺数据置底', () => {
  const list = rows([{ n: 'A' }, { n: 'B' }, { n: 'C' }]);
  // A=-5% / C=+30% / B 缺数据 ⇒ C, A, B（B 置底，⛔ 不当 0）
  const map = new Map([['A', { pct: -5, days: 10 }], ['C', { pct: 30, days: 10 }]]);

  it('★ 十日涨幅：按 pct 降序，缺数据的那只排最后', () => {
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list,
      sortState: Object.assign({}, noToggle, { byRangePct: true }),
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: function() { return map; },
      rangeMapOf20: function() { throw new Error('不该读 20 日'); },
      auctionPctOf: function() { return null; }
    });
    expect(names(list, out)).toEqual(['C', 'A', 'B']);
  });

  it('★ 20日涨幅：读的是另一份 Map（两个 map 各自独立）', () => {
    const map20 = new Map([['A', { pct: 88, days: 20 }], ['B', { pct: 1, days: 20 }], ['C', { pct: -9, days: 20 }]]);
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list,
      sortState: Object.assign({}, noToggle, { byRangePct20: true }),
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: function() { throw new Error('不该读 10 日'); },
      rangeMapOf20: function() { return map20; },
      auctionPctOf: function() { return null; }
    });
    expect(names(list, out)).toEqual(['A', 'B', 'C']);
  });

  it('★ Map 为 null（还没加载）⇒ 全部置底但保持原顺序（⛔ 不抛错、不补 0）', () => {
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list,
      sortState: Object.assign({}, noToggle, { byRangePct: true }),
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: function() { return null; },
      rangeMapOf20: function() { return null; },
      auctionPctOf: function() { return null; }
    });
    expect(out).toEqual([0, 1, 2]);
  });
});

describe('[SORT-ORDER] 竞/昨（分层）', () => {
  it('★ tier0 高光 → tier1 平行 → tier2 其它；同档按竞价涨幅降序', () => {
    // A 高光(+1) / B 平行(+5) / C 其它(+9) / D 其它(+3)
    const list = rows([{ n: 'A', a: 1 }, { n: 'B', a: 5 }, { n: 'C', a: 9 }, { n: 'D', a: 3 }]);
    const out = buildRenderOrder({
      renderOrder: idx(4), renderList: list,
      sortState: Object.assign({}, noToggle, { byJingYest: true }),
      jingYestHighlightSet: new Set(['A']),
      parallelStocksToday: new Set(['A', 'B']),
      rangeMapOf10: function() { return null; },
      rangeMapOf20: function() { return null; },
      auctionPctOf: function(r) { const v = parseFloat(r.auc_pct_chg); return isNaN(v) ? null : v; }
    });
    // 档位优先于数值：B(+5) 在 C(+9) 前面
    expect(names(list, out)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('★ 同档内竞价涨幅缺失 ⇒ 置底但保持相对顺序（§10 缺失不补 0）', () => {
    const list = rows([{ n: 'A', a: null }, { n: 'B', a: 2 }, { n: 'C', a: null }]);
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list,
      sortState: Object.assign({}, noToggle, { byJingYest: true }),
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: function() { return null; },
      rangeMapOf20: function() { return null; },
      auctionPctOf: function(r) { const v = parseFloat(r.auc_pct_chg); return isNaN(v) ? null : v; }
    });
    expect(names(list, out)).toEqual(['B', 'A', 'C']);
  });
});

describe('[SORT-ORDER] 竞/昨占比（分层）', () => {
  it('★ tier0 高光优先；同档按 volume/yestVolume 降序', () => {
    // A 高光 比 0.1 / B 其它 比 3 / C 其它 比 0.5
    const list = rows([{ n: 'A', v: 10, y: 100 }, { n: 'B', v: 30, y: 10 }, { n: 'C', v: 5, y: 10 }]);
    const out = buildRenderOrder({
      renderOrder: idx(3), renderList: list,
      sortState: Object.assign({}, noToggle, { byJingYestRatio: true }),
      jingYestHighlightSet: new Set(['A']), parallelStocksToday: new Set(),
      rangeMapOf10: function() { return null; },
      rangeMapOf20: function() { return null; },
      auctionPctOf: function() { return null; }
    });
    expect(names(list, out)).toEqual(['A', 'B', 'C']);
  });

  it('★ 量比算不出（yestVolume=0）⇒ 当缺失置底，⛔ 不当 0 参与比较', () => {
    const list = rows([{ n: 'A', v: 10, y: 0 }, { n: 'B', v: 1, y: 100 }]);
    const out = buildRenderOrder({
      renderOrder: idx(2), renderList: list,
      sortState: Object.assign({}, noToggle, { byJingYestRatio: true }),
      jingYestHighlightSet: new Set(), parallelStocksToday: new Set(),
      rangeMapOf10: function() { return null; },
      rangeMapOf20: function() { return null; },
      auctionPctOf: function() { return null; }
    });
    expect(names(list, out)).toEqual(['B', 'A']);
  });
});

describe('[SORT-ORDER] 档位判定必须与排序分支逐字一致', () => {
  const list = rows([{ n: 'A' }, { n: 'B' }, { n: 'C' }]);
  const sets = { jingYestHighlightSet: new Set(['A']), parallelStocksToday: new Set(['A', 'B']) };

  it('★ 竞/昨：高光 0 / 平行 1 / 其它 2 —— 与上面的 tier 完全同源', () => {
    const o = { sortState: Object.assign({}, noToggle, { byJingYest: true }), jingYestHighlightSet: sets.jingYestHighlightSet, parallelStocksToday: sets.parallelStocksToday };
    expect([0, 1, 2].map(function(i) { return resolveTopicTierOf(list, i, o); })).toEqual([0, 1, 2]);
  });

  it('★ 竞/昨占比：高光 0 / 其它 1（只有两档）', () => {
    const o = { sortState: Object.assign({}, noToggle, { byJingYestRatio: true }), jingYestHighlightSet: sets.jingYestHighlightSet, parallelStocksToday: sets.parallelStocksToday };
    expect([0, 1, 2].map(function(i) { return resolveTopicTierOf(list, i, o); })).toEqual([0, 1, 1]);
  });

  it('★ 默认 / 十日 / 20日：一律单档 0（⛔ 竞价口径不占档位）', () => {
    [noToggle,
      Object.assign({}, noToggle, { byRangePct: true }),
      Object.assign({}, noToggle, { byRangePct20: true }),
      Object.assign({}, noToggle, { byRangePct20: true, byAuctionLeg: true })
    ].forEach(function(st) {
      const o = { sortState: st, jingYestHighlightSet: sets.jingYestHighlightSet, parallelStocksToday: sets.parallelStocksToday };
      expect([0, 1, 2].map(function(i) { return resolveTopicTierOf(list, i, o); })).toEqual([0, 0, 0]);
    });
  });

  it('★ 高光集合为 null（数据未到）⇒ 竞/昨 全部落 tier2，⛔ 不抛错', () => {
    const o = { sortState: Object.assign({}, noToggle, { byJingYest: true }), jingYestHighlightSet: null, parallelStocksToday: null };
    expect([0, 1, 2].map(function(i) { return resolveTopicTierOf(list, i, o); })).toEqual([2, 2, 2]);
  });
});
