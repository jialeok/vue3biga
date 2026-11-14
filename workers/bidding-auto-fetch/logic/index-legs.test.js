// index-legs.test.js — 云端「官方对应指数逐日腿」的纯函数回归锁
//
// 锁四件事：
//   ① 腿的换算（收盘价 → 当日涨幅）不能差一根、不能把第一根当腿；
//   ② 行形状必须与 market_metrics 的 scope='index' 约定逐字一致（date/stock/code/change_pct/scope）；
//   ③ §10：取不到的指数 ⇒ 一行都不写（⛔ 不补 0、⛔ 不拿别的指数顶替）；
//   ④ 四个指数代码与前端 `DEV_INDEX` 必须完全一致（⛔ 不许一边写 sh000002 一边读 sz399107）。
import { describe, it, expect } from 'vitest';
import { barsToLegs, buildIndexLegRows, fmtPct, INDEX_LEG_TARGETS } from './index-legs.js';
import { DEV_INDEX_CODES, DEV_INDEX } from '../../../src/logic/auction/abnormal-deviation.js';

function bars(pairs) {
  return pairs.map(function (p) { return { date: p[0], close: p[1] }; });
}

describe('[ABN-DEV-WORKER] 指数代码必须与前端同一份', () => {
  it('四个官方指数逐字一致', () => {
    const workerCodes = INDEX_LEG_TARGETS.map(function (t) { return t.code; }).sort();
    expect(workerCodes).toEqual(DEV_INDEX_CODES.slice().sort());
  });

  it('中文名也一致（上屏 / 落库都用它，⛔ 两边写岔就不是同一行）', () => {
    const byCode = {};
    INDEX_LEG_TARGETS.forEach(function (t) { byCode[t.code] = t.name; });
    Object.keys(DEV_INDEX).forEach(function (k) {
      expect(byCode[DEV_INDEX[k].code]).toBe(DEV_INDEX[k].name);
    });
  });
});

describe('[ABN-DEV-WORKER] barsToLegs · 收盘价 → 逐日涨幅', () => {
  it('第一根不出腿（没有前收），之后每根一根', () => {
    const legs = barsToLegs(bars([['2026-11-10', 100], ['2026-11-11', 110], ['2026-11-12', 99]]));
    expect(legs.length).toBe(2);
    expect(legs[0].date).toBe('2026-11-11');
    expect(legs[0].pct).toBeCloseTo(10, 6);
    expect(legs[1].date).toBe('2026-11-12');
    expect(legs[1].pct).toBeCloseTo(-10, 6);
  });

  it('非法 / 缺失收盘价 ⇒ 跳过那一段（⛔ 不补 0）', () => {
    const legs = barsToLegs([
      { date: '2026-11-10', close: 100 },
      { date: '2026-11-11', close: 0 },
      { date: '2026-11-12', close: 105 }
    ]);
    expect(legs.length).toBe(0);
  });

  it('空 / null ⇒ 空数组', () => {
    expect(barsToLegs(null)).toEqual([]);
    expect(barsToLegs([])).toEqual([]);
  });
});

describe('[ABN-DEV-WORKER] buildIndexLegRows · 行形状与 §10', () => {
  const map = new Map([
    ['sh000002', bars([['2026-11-12', 3000], ['2026-11-13', 3030]])],
    ['sz399107', bars([['2026-11-12', 2000], ['2026-11-13', 1980]])]
  ]);

  it('字段与 scope 必须逐字符合 market_metrics 约定', () => {
    const rows = buildIndexLegRows(map, '2026-11-12', '2026-11-14T00:00:00Z');
    expect(rows.length).toBe(2);
    const r = rows[0];
    expect(r.date).toBe('2026-11-13');
    expect(r.stock).toBe('上证A股指数');
    expect(r.code).toBe('sh000002');
    expect(r.change_pct).toBe('+1.00%');
    expect(r.scope).toBe('index');            // ⛔ 绝不能是 auction / hot
    expect(r.updated_at).toBe('2026-11-14T00:00:00Z');
  });

  it('跌的写成带负号（与 auction 域同一文本约定）', () => {
    const rows = buildIndexLegRows(map, '2026-11-12', '2026-11-14T00:00:00Z');
    const sz = rows.filter(function (r) { return r.code === 'sz399107'; })[0];
    expect(sz.change_pct).toBe('-1.00%');
  });

  it('§10：取不到的指数一行都不写（⛔ 不补 0、⛔ 不顶替）', () => {
    const rows = buildIndexLegRows(new Map([['sh000002', bars([['2026-11-12', 1], ['2026-11-13', 2]])]]),
      '', 'now');
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe('sh000002');
    // 另外三个指数完全没有行 —— 不是 0.00%
    expect(rows.some(function (r) { return r.code === 'sz399107'; })).toBe(false);
  });

  it('fromDate 截断（只写最近的回看窗口）', () => {
    const m = new Map([['sh000002', bars([
      ['2026-10-30', 2900], ['2026-11-02', 2950], ['2026-11-03', 2960]
    ])]]);
    const all = buildIndexLegRows(m, '', 'now');
    const cut = buildIndexLegRows(m, '2026-11-02', 'now');
    expect(all.length).toBe(2);
    expect(cut.length).toBe(2);              // 11-02 那根的 date 是 11-02，保留
    expect(cut[0].date).toBe('2026-11-02');
    const cut2 = buildIndexLegRows(m, '2026-11-03', 'now');
    expect(cut2.length).toBe(1);
  });

  it('空 Map ⇒ 空数组（调用方据此不写库）', () => {
    expect(buildIndexLegRows(new Map(), '', 'now')).toEqual([]);
    expect(buildIndexLegRows(null, '', 'now')).toEqual([]);
  });
});

describe('[ABN-DEV-WORKER] fmtPct', () => {
  it('两位小数 + 正数带加号', () => {
    expect(fmtPct(0.5512)).toBe('+0.55%');
    expect(fmtPct(-1.2)).toBe('-1.20%');
    expect(fmtPct(0)).toBe('+0.00%');
    expect(fmtPct(null)).toBe(null);
    expect(fmtPct('abc')).toBe(null);
  });
});
