// row-groups.test.js — 四组行（常规 / 观察 / 龙头 / 20日补）装配的回归护栏
//
// 为什么现在才补：这四组的「成员判定 + 壳行注入 + 去重」以前全挤在
// `view-helpers.js#computeAuctionViewData` 那一个 1170 行的函数里，**没有任何直接单测**
// —— 只有 4 个测试文件间接 import 它。2026-11-05 按用户要求拆成四个文件后，
// 装配口 `collectRowGroups` 成了唯一真相，必须在这里锁住。
//
// 锁住的判据（每一条对应一次真实事故）：
//   ① 已在当日正式列表 ⇒ 不注入（否则同一只票出现两次，四组相加 ≠ 行数）
//   ② 一组只认领一次 ⇒ 一只票只能出现在一个组（龙头组别把观察组的票再造一行）
//   ③ 影子行的 `obsAutoAdded !== true` 才复用（否则拿空壳顶别的组，行情永远空）
//   ④ 名册 null ≠ 空数组（§10：读失败不能伪装成「今天没有」）
//   ⑤ renderList = list + injectedRows，且 list 本身不被改动（§6 不产生影子记录）
//   ⑥ 20日补位的 meta（pct / days）只对「真补进来的」那只记录

import { describe, it, expect, vi, beforeEach } from 'vitest';

const src = vi.hoisted(() => ({
  jingYest: null,       // Set | null
  dragon: null,         // Map | null
  range20: null,        // Array | null
  throwJing: false,
  throwDragon: false,
  throwRange20: false,
}));

vi.mock('../sort-rules.js', () => ({
  getJingYestHighlightSetForDate: () => {
    if (src.throwJing) throw new Error('mock boom');
    return src.jingYest;
  },
}));
vi.mock('../dragon-group.js', () => ({
  getDragonLeadersForDisplay: () => {
    if (src.throwDragon) throw new Error('mock boom');
    return src.dragon;
  },
}));
vi.mock('../range20-leaders.js', () => ({
  getRange20Leaders: () => {
    if (src.throwRange20) throw new Error('mock boom');
    return src.range20;
  },
}));

import { collectRowGroups } from './index.js';

// 本仓库的单测跑在 node 环境（没有 localStorage）。观察组的「继承票」标记读的是
// localStorage，这里给一个内存桩；同时它也顺带证明：**没有 localStorage 时不应抛错**
// （resolveObsGroup 内部 try/catch 已兜住，生产 SSR/无痕模式下同样安全）。
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

/** 造一条当日正式列表行 */
const L = (stock) => ({ stock: stock, volume: '10', yestVolume: '100' });

beforeEach(() => {
  src.jingYest = null;
  src.dragon = null;
  src.range20 = null;
  src.throwJing = false;
  src.throwDragon = false;
  src.throwRange20 = false;
  try { localStorage.clear(); } catch (e) {}
});

describe('① 已在正式列表 ⇒ 不注入', () => {
  it('观察组/龙头组/20日补 都含同一只正式成员 ⇒ 一行都不注入', () => {
    src.jingYest = new Set(['甲']);
    src.dragon = new Map([['甲', { code: '600001' }]]);
    src.range20 = [{ stock: '甲', pct: 12.3, days: 20 }];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows).toEqual([]);
    expect(g.renderList.length).toBe(1);
  });
});

describe('② 一只票只能归属一个组（去重）', () => {
  it('同时在前日竞昨高光与龙头名册 ⇒ 只注入 1 行，flag 为 obsAutoAdded（先认领）', () => {
    src.jingYest = new Set(['乙']);
    src.dragon = new Map([['乙', { code: '600002' }]]);
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows.length).toBe(1);
    const r = g.injectedRows[0];
    expect(r.stock).toBe('乙');
    expect(r.obsAutoAdded).toBe(true);
    expect(r.dragonAutoAdded).toBeUndefined();   // ⛔ 两个 flag 不许同时出现
  });

  it('三组各来一只互不重叠 ⇒ 三行，flag 各自一个', () => {
    src.jingYest = new Set(['观']);
    src.dragon = new Map([['龙', { code: '600002' }]]);
    src.range20 = [{ stock: '补', pct: 30, days: 20 }];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    const flags = g.injectedRows.map((r) => (r.obsAutoAdded ? 'obs' : r.dragonAutoAdded ? 'dragon' : r.range20AutoAdded ? 'r20' : '?')).sort();
    expect(flags).toEqual(['dragon', 'obs', 'r20']);
  });

  it('20日补位不与已被龙头组认领的票重复', () => {
    src.dragon = new Map([['龙', { code: '600002' }]]);
    src.range20 = [{ stock: '龙', pct: 30, days: 20 }];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows.length).toBe(1);
    expect(g.injectedRows[0].dragonAutoAdded).toBe(true);
    // 没真补进来 ⇒ meta 里也不该有它
    expect(g.range20Meta.has('龙')).toBe(false);
  });
});

describe('③ 影子行复用规则', () => {
  it('当日云端有同名行且不是观察组身份 ⇒ 复用它的行情字段', () => {
    src.dragon = new Map([['龙', { code: '600002' }]]);
    const dayRowMap = new Map([['龙', { stock: '龙', volume: '88', yestVolume: '999', note: 'x' }]]);
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')], dayRowMap: dayRowMap });
    const r = g.injectedRows[0];
    expect(r.volume).toBe('88');
    expect(r.dragonAutoAdded).toBe(true);
  });

  it('影子行本身就是观察组空壳（obsAutoAdded=true）⇒ ⛔ 不复用，另造空壳', () => {
    src.dragon = new Map([['龙', { code: '600002' }]]);
    const dayRowMap = new Map([['龙', { stock: '龙', volume: '', obsAutoAdded: true }]]);
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')], dayRowMap: dayRowMap });
    const r = g.injectedRows[0];
    expect(r.volume).toBe('');
    expect(r.code).toBe('600002');       // 代码来自名册 meta，不是影子行
  });
});

describe('④ 名册 null ≠ 空集合（§10）', () => {
  it('三组名册都 null ⇒ 不注入，renderList 就是原列表', () => {
    const list = [L('甲'), L('乙')];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: list });
    expect(g.injectedRows).toEqual([]);
    expect(g.renderList.length).toBe(2);
    expect(g.obs.set).toBe(null);        // ⛔ 不许变成 new Set()
    expect(g.dragon).toBe(null);
    expect(g.range20).toBe(null);
  });

  it('名册读取抛错 ⇒ 降级为 null，不把整块看板拖挂', () => {
    src.throwJing = true;
    src.throwDragon = true;
    src.throwRange20 = true;
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows).toEqual([]);
    expect(g.obs.set).toBe(null);
  });

  it('名册是空数组（确实没有）⇒ 与 null 一样不注入，但原件是 []', () => {
    src.range20 = [];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows).toEqual([]);
    expect(g.range20).toEqual([]);
  });
});

describe('⑤ renderList 与 list 的关系（§6 不产生影子记录）', () => {
  it('renderList = list + injectedRows，且原 list 数组未被改动', () => {
    src.jingYest = new Set(['观']);
    const list = [L('甲')];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: list });
    expect(list.length).toBe(1);                 // ⛔ 原数组不动
    expect(g.renderList.length).toBe(2);
    expect(g.renderList[0]).toBe(list[0]);       // 正式行原样在前
    expect(g.renderList[1].stock).toBe('观');
  });

  it('没有注入时 renderList 与 list 是同一个引用（不白拷一份）', () => {
    const list = [L('甲')];
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: list });
    expect(g.renderList).toBe(list);
  });
});

describe('⑥ 20日补位 meta 只记录真补进来的', () => {
  it('名单 3 只，2 只在正式列表 ⇒ meta 只有 1 只', () => {
    src.range20 = [
      { stock: '甲', pct: 50, days: 20 },     // 已在正式列表
      { stock: '乙', pct: 40, days: 20 },     // 已被观察组认领
      { stock: '丙', pct: 30, days: 20 },     // 真补进来
    ];
    src.jingYest = new Set(['乙']);
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.range20Meta.size).toBe(1);
    expect(g.range20Meta.get('丙')).toEqual({ pct: 30, days: 20 });
    expect(g.range20Meta.has('甲')).toBe(false);
    expect(g.range20Meta.has('乙')).toBe(false);
  });
});

describe('⑦ obsBought 继承票（localStorage 标记）', () => {
  it('obsBought_<date> 里的票也算观察组成员，且同样被注入', () => {
    localStorage.setItem('obsBought_d', JSON.stringify(['买过的']));
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.obs.isMember('买过的')).toBe(true);
    expect(g.injectedRows.map((r) => r.stock)).toEqual(['买过的']);
  });

  it('localStorage 脏数据不炸（非数组 / 非法 JSON）', () => {
    localStorage.setItem('obsBought_d', '{"不是":"数组"}');
    const g = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g.injectedRows).toEqual([]);
    localStorage.setItem('obsBought_d', '不是 JSON');
    const g2 = collectRowGroups({ date: 'd', prevDate: 'p', list: [L('甲')] });
    expect(g2.injectedRows).toEqual([]);
  });
});
