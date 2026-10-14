import { describe, it, expect } from 'vitest';
import { readRangePct, sortIndicesByRangePct } from './range-pct-sort.js';

// 「十日涨幅」toggle（2026-10-14 取代原「三天竞跌」）的核心验收：
//   全部股票（龙头组 / 观察组 / 常规组）按近 10 日区间涨幅【由高到低】排成一条列表。
// 数据源 = dragon-rank.js#getDragonRangePct(date) 的 Map<名,{pct,days}>。

/** 便捷构造：按「名 → pct」造出 rows（含 index 语义的顺序）+ rangeMap */
function build(pairs, missing) {
  const rows = pairs.map(function(p, i) { return { index: i, stock: p[0] }; });
  const map = new Map();
  pairs.forEach(function(p) {
    if (missing && missing.indexOf(p[0]) >= 0) return;              // 构造「云端没有这一行」
    map.set(p[0], { pct: p[1], days: 10 });
  });
  return { rows, map, order: rows.map(function(_r, i) { return i; }) };
}

function namesOf(rows, order) {
  return order.map(function(i) { return rows[i].stock; });
}

describe('range-pct-sort · readRangePct', () => {
  it('从 Map 里取出数值（含负数）', () => {
    const m = new Map([['九阳股份', { pct: 86, days: 10 }], ['新华传媒', { pct: -12.5, days: 10 }]]);
    expect(readRangePct(m, '九阳股份')).toBe(86);
    expect(readRangePct(m, '新华传媒')).toBe(-12.5);
  });
  it('§10：Map 未加载 / 没有这只票 / pct 为 null 或非法 → null（⛔ 绝不退化成 0）', () => {
    expect(readRangePct(null, '九阳股份')).toBeNull();
    expect(readRangePct(new Map(), '九阳股份')).toBeNull();
    expect(readRangePct(new Map([['A', { pct: null, days: 10 }]]), 'A')).toBeNull();
    expect(readRangePct(new Map([['A', { pct: 'abc', days: 10 }]]), 'A')).toBeNull();
    expect(readRangePct(new Map([['A', { pct: 0, days: 10 }]]), 'A')).toBe(0); // 0 是真实值
  });
});

describe('range-pct-sort · sortIndicesByRangePct（十日涨幅由高到低）', () => {
  it('★ 全部股票一起排：龙头组 / 观察组 / 常规组的票都参与，由高到低', () => {
    // 模拟三个区块混在同一条 renderList 里（龙头组在前、观察组居中、常规组在后）
    const { rows, map, order } = build([
      ['甲龙', 12.3],        // 龙头组
      ['乙龙', -4.5],        // 龙头组
      ['丙观', 45.6],        // 观察组
      ['丁观', 3.2],         // 观察组
      ['戊常', 88.8],        // 常规组
      ['己常', -20.1]        // 常规组
    ]);
    expect(namesOf(rows, sortIndicesByRangePct(order, rows, map)))
      .toEqual(['戊常', '丙观', '甲龙', '丁观', '乙龙', '己常']);
  });

  it('★ 缺数据的票一律置底，且不参与 pct 比较（§10 不作 0）', () => {
    const { rows, map, order } = build([
      ['有数据低', -30],
      ['缺A', null],
      ['有数据高', 50],
      ['缺B', null]
    ], ['缺A', '缺B']);
    expect(namesOf(rows, sortIndicesByRangePct(order, rows, map)))
      .toEqual(['有数据高', '有数据低', '缺A', '缺B']);
  });

  it('Map 未加载（null）→ 顺序原样不变（不假装按 0 排）', () => {
    const { rows, order } = build([['A', 10], ['B', 20], ['C', 30]]);
    expect(namesOf(rows, sortIndicesByRangePct(order, rows, null))).toEqual(['A', 'B', 'C']);
  });

  it('pct 相同 / 都缺数据 → 保持原有相对顺序（稳定）', () => {
    const { rows, map, order } = build([['A', 5], ['B', 5], ['C', 5]]);
    expect(namesOf(rows, sortIndicesByRangePct(order, rows, map))).toEqual(['A', 'B', 'C']);
    const miss = build([['A', 1], ['B', 1], ['C', 1]], ['A', 'B', 'C']);
    expect(namesOf(miss.rows, sortIndicesByRangePct(miss.order, miss.rows, miss.map)))
      .toEqual(['A', 'B', 'C']);
  });

  it('0 与负数正常参与比较（0 高于 -1）', () => {
    const { rows, map, order } = build([['跌', -1], ['平', 0], ['涨', 2]]);
    expect(namesOf(rows, sortIndicesByRangePct(order, rows, map))).toEqual(['涨', '平', '跌']);
  });

  it('空输入 → 空数组（不抛）', () => {
    expect(sortIndicesByRangePct([], [], new Map())).toEqual([]);
    expect(sortIndicesByRangePct(null, null, null)).toEqual([]);
  });
});
