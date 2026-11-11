// range20-board-auc.test.js — 「早盘竞价看板 20日补位」成员恒竞价口径（§6 / §10 / §11）
//
// ===== 这个测试锁的是什么（用户 2026-11-11 P0 原话）=====
//   「我打开早盘竞价看板20日toggle，还是没有看到青岛食品显示出来啊，sql我执行了，也没有用。
//    你是不是改错地方了，你要验证啊，没有竞价量比但有竞价涨幅也要显示啊，而不是删除」
//
// ===== 事故机理（用真实库数据复现，⛔ 不要改成「看起来合理」的假数）=====
//   11-11 青岛食品(001219) **不在** `auction_watchlist`（`[]`）⇒ 唯一进入通道 = 20 日补位注入。
//   补位成员原先由 `pickUsableRows(readRange20Rows(d), legMode)` 评选，而
//   `legMode = (tIsToday && !afterClose) ? 'auc' : 'close'` ⇒ 15:00 后切 close：
//     · auc  口径：福莱新材 123.84 / 东方海洋 115.03 / 襄阳轴承 98.18 / **青岛食品 93.57(第4)** / 海洋王 81.95
//     · close 口径：福莱新材 135.15 / 东方海洋 120.21 / 襄阳轴承 102.19 / 阳光照明 91.11 / 光洋股份 80.52
//                    （青岛食品 75.14 掉到**第 8**）
//   ⇒ 盘后前五不含它 ⇒ 不注入 ⇒ 不在 renderList ⇒ 「20日涨幅 toggle」里彻底消失。
//   ⇒ 用户看到的「早上有、晚上没」= 竞价期间定下的补位名单被收盘口径重排了一遍。
//
// ★ 本测试同时是「反证」：第二段用**同一批真实 close 数据**跑同一函数，
//   结果青岛食品必须**不在**前五 —— 证明事故确由口径重排引起，而非代码里另有一处过滤。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAuctionBoardMembers,
  getRange20LeadersForAuctionBoard,
  RANGE20_BOARD_AUC_MIN_COVER,
  RANGE20_LEADER_TOP_N,
  RANGE20_LEADER_MIN_LEGS
} from './range20-leaders.js';

// ── 11-11 真实库数据（`.tmpdiag/verify-r20-inject-1111.cjs` 复现输出，逐字抄录）──
const R_AUC = [
  ['福莱新材', '605488', 123.84],
  ['东方海洋', '002086', 115.03],
  ['襄阳轴承', '000678', 98.18],
  ['青岛食品', '001219', 93.57],
  ['海洋王', '002724', 81.95],
  ['阳光照明', '600261', 80.40],
  ['冰山冷热', '000530', 77.62],
  ['光洋股份', '002708', 76.52],
  ['大千生态', '603955', 72.16],
  ['大东方', '600327', 69.60]
];
const R_CLOSE = [
  ['福莱新材', '605488', 135.15],
  ['东方海洋', '002086', 120.21],
  ['襄阳轴承', '000678', 102.19],
  ['阳光照明', '600261', 91.11],
  ['光洋股份', '002708', 80.52],
  ['海洋王', '002724', 80.00],
  ['冰山冷热', '000530', 79.04],
  ['青岛食品', '001219', 75.14],
  ['大东方', '600327', 69.60],
  ['文投控股', '600715', 67.03]
];

function mkRows(arr, days) {
  const m = new Map();
  arr.forEach(function(r) { m.set(r[0], { pct: r[2], days: days || 20 }); });
  return m;
}
function mkNames(arr) {
  const s = new Set();
  arr.forEach(function(r) { s.add(r[0]); });
  // 候选池是「近 20 日名单并集」，必然包含这些票；再加两只不在排名里的（证明池 ≠ 榜）
  s.add('万向德农');
  s.add('不在榜的票');
  return s;
}
function mkCode(arr) {
  const m = new Map();
  arr.forEach(function(r) { m.set(r[0], r[1]); });
  return m;
}
const POOL_AUC = mkNames(R_AUC);
const POOL_CLOSE = mkNames(R_CLOSE);

describe('buildAuctionBoardMembers —— 竞价口径成员榜（用户 P0 核心回归）', () => {
  it('★ 11-11 真实 auc 数据：前五 = 福莱新材/东方海洋/襄阳轴承/青岛食品/海洋王，青岛食品第 4', () => {
    const res = buildAuctionBoardMembers({
      aucRows: mkRows(R_AUC),
      closeCount: R_AUC.length,
      poolNames: POOL_AUC,
      poolCode: mkCode(R_AUC),
      coarseTop: []
    });
    expect(res.reason).toBe('ok');
    expect(res.members.map(function(m) { return m.stock; }))
      .toEqual(['福莱新材', '东方海洋', '襄阳轴承', '青岛食品', '海洋王']);
    const qd = res.members[3];
    expect(qd.stock).toBe('青岛食品');
    expect(qd.pct).toBeCloseTo(93.57, 2);
    expect(qd.days).toBe(20);
    expect(qd.code).toBe('001219');
  });

  it('★ 反证：同一批真实数据换成 close 口径 ⇒ 青岛食品掉到第 8、前五不含它（事故机理成立）', () => {
    const res = buildAuctionBoardMembers({
      aucRows: mkRows(R_CLOSE),        // 故意把 close 行当 auc 行传 ⇒ 复现「按收盘口径评选」
      closeCount: R_CLOSE.length,
      poolNames: POOL_CLOSE,
      poolCode: mkCode(R_CLOSE),
      coarseTop: []
    });
    const names = res.members.map(function(m) { return m.stock; });
    expect(names).toEqual(['福莱新材', '东方海洋', '襄阳轴承', '阳光照明', '光洋股份']);
    expect(names).not.toContain('青岛食品');
    // 完整 10 名里它是第 8 —— 与库内的实际排名一致
    const all = buildAuctionBoardMembers({
      aucRows: mkRows(R_CLOSE),
      closeCount: R_CLOSE.length,
      poolNames: POOL_CLOSE,
      poolCode: mkCode(R_CLOSE),
      coarseTop: [],
      topN: 10
    });
    expect(all.members.findIndex(function(m) { return m.stock === '青岛食品'; })).toBe(7);
  });

  it('§10：auc 腿一行都没有 ⇒ no-auc-rows（⛔ 不拿空榜冒充「今天没有补位票」）', () => {
    expect(buildAuctionBoardMembers({ aucRows: new Map(), closeCount: 69 }).reason).toBe('no-auc-rows');
    expect(buildAuctionBoardMembers({ aucRows: null, closeCount: 69 }).reason).toBe('no-auc-rows');
    expect(buildAuctionBoardMembers({}).reason).toBe('no-auc-rows');
    expect(buildAuctionBoardMembers({ aucRows: new Map(), closeCount: 69 }).members).toEqual([]);
  });

  it('§10：auc 腿覆盖率不足（< 0.8）⇒ cover-low，整份不认', () => {
    const few = new Map();
    ['福莱新材', '东方海洋', '襄阳轴承', '青岛食品', '海洋王'].forEach(function(n, i) {
      few.set(n, { pct: 100 - i, days: 20 });
    });
    // 5/69 ≈ 7% ⇒ 明显不够
    const res = buildAuctionBoardMembers({ aucRows: few, closeCount: 69 });
    expect(res.reason).toBe('cover-low');
    expect(res.members).toEqual([]);
    // 阈值边界：刚好 0.8 要通过（5/6.25 → ceil=5；用 4/5 = 0.8 精确验证）
    const four = new Map([['A', { pct: 90, days: 20 }], ['B', { pct: 80, days: 20 }],
      ['C', { pct: 70, days: 20 }], ['D', { pct: 60, days: 20 }]]);
    const pool = new Set(['A', 'B', 'C', 'D']);
    const codes = new Map([['A', '600001'], ['B', '600002'], ['C', '600003'], ['D', '600004']]);
    const ok = buildAuctionBoardMembers({ aucRows: four, closeCount: 5, poolNames: pool, poolCode: codes });
    expect(Math.ceil(5 * RANGE20_BOARD_AUC_MIN_COVER)).toBe(4);
    expect(ok.reason).toBe('ok');
    expect(ok.members.length).toBe(4);
  });

  it('只主板闸门：auc 第一是创业板/科创板/北交所 ⇒ 被剔除，顺位由主板补上', () => {
    const rows = new Map([
      ['创业票', { pct: 300, days: 20 }],
      ['科创票', { pct: 250, days: 20 }],
      ['北交票', { pct: 200, days: 20 }],
      ['主板甲', { pct: 90, days: 20 }],
      ['主板乙', { pct: 80, days: 20 }]
    ]);
    const pool = new Set(['创业票', '科创票', '北交票', '主板甲', '主板乙']);
    const codes = new Map([['创业票', '300001'], ['科创票', '688001'],
      ['北交票', '830001'], ['主板甲', '600001'], ['主板乙', '000001']]);
    const res = buildAuctionBoardMembers({ aucRows: rows, closeCount: 5, poolNames: pool, poolCode: codes });
    expect(res.members.map(function(m) { return m.stock; })).toEqual(['主板甲', '主板乙']);
  });

  it('腿数门槛：days < 6 一律不参与（停牌/中途入名单的残腿不许冒充 20 日涨幅）', () => {
    const rows = new Map([
      ['腿少票', { pct: 999, days: 3 }],
      ['足量票', { pct: 50, days: 20 }]
    ]);
    const pool = new Set(['腿少票', '足量票']);
    const codes = new Map([['腿少票', '600001'], ['足量票', '600002']]);
    const res = buildAuctionBoardMembers({ aucRows: rows, closeCount: 2, poolNames: pool, poolCode: codes });
    expect(res.members.map(function(m) { return m.stock; })).toEqual(['足量票']);
  });

  it('候选池闸门：不在近 20 日名单并集里的票不参与（与主榜同一条闸门）', () => {
    const rows = new Map([
      ['池外强票', { pct: 500, days: 20 }],
      ['池内票', { pct: 10, days: 20 }]
    ]);
    const pool = new Set(['池内票']);
    const codes = new Map([['池外强票', '600001'], ['池内票', '600002']]);
    const res = buildAuctionBoardMembers({ aucRows: rows, closeCount: 2, poolNames: pool, poolCode: codes });
    expect(res.members.map(function(m) { return m.stock; })).toEqual(['池内票']);
  });

  it('§10：pct 非数不参与排名（⛔ 不当 0 参与）', () => {
    const rows = new Map([
      ['坏值票', { pct: null, days: 20 }],
      ['好值票', { pct: 5, days: 20 }]
    ]);
    const pool = new Set(['坏值票', '好值票']);
    const codes = new Map([['坏值票', '600001'], ['好值票', '600002']]);
    const res = buildAuctionBoardMembers({ aucRows: rows, closeCount: 2, poolNames: pool, poolCode: codes });
    expect(res.members.map(function(m) { return m.stock; })).toEqual(['好值票']);
  });

  it('算出 0 只（全被筛光）⇒ reason = empty（⛔ 与 no-auc-rows 混为一谈）', () => {
    const rows = new Map([['创业票', { pct: 300, days: 20 }]]);
    const res = buildAuctionBoardMembers({
      aucRows: rows, closeCount: 1, poolNames: new Set(['创业票']),
      poolCode: new Map([['创业票', '300001']])
    });
    expect(res.reason).toBe('empty');
    expect(res.members).toEqual([]);
  });

  it('粗筛近似可作底座（保证强票不消失），但 code 必须回填（否则只主板闸门把它切光）', () => {
    const rows = new Map([['已在云端', { pct: 10, days: 20 }]]);
    const pool = new Set(['已在云端', '只有近似']);
    const res = buildAuctionBoardMembers({
      aucRows: rows,
      // ⚠️ 覆盖率分母必须是「当前口径行数」；这里 auc 只有 1 行 ⇒ 分母也得是 1，
      //   否则先被 cover-low 拦下，测不到粗筛层（真实场景两腿行数通常相同：69/69）。
      closeCount: 1,
      poolNames: pool,
      poolCode: new Map([['已在云端', '600001']]),
      // 粗筛层自带 code ⇒ 可以参与，且 pct 更高 ⇒ 排在前面
      coarseTop: [{ stock: '只有近似', code: '600002', pct: 200, days: 20 }]
    });
    expect(res.members.map(function(m) { return m.stock; })).toEqual(['只有近似', '已在云端']);
    expect(res.members[0].code).toBe('600002');
  });
});

describe('getRange20LeadersForAuctionBoard —— 回落语义（§10 / §11）', () => {
  it('该日从无结论 ⇒ null（⛔ 不返回 []，那会被当成「今天没有补位票」）', () => {
    expect(getRange20LeadersForAuctionBoard('2099-01-01')).toBe(null);
    expect(getRange20LeadersForAuctionBoard('')).toBe(null);
    expect(getRange20LeadersForAuctionBoard(null)).toBe(null);
  });
});

describe('接线静态锁 —— ⛔ 不许偷偷改回收盘口径', () => {
  const ROWS_SRC = fs.readFileSync(
    path.join(process.cwd(), 'src/logic/auction/row-groups/range20-group-rows.js'), 'utf8');

  it('补位名册必须读 getRange20LeadersForAuctionBoard', () => {
    expect(ROWS_SRC).toContain('getRange20LeadersForAuctionBoard');
    // ⛔ 只允许出现在 import 的「旧入口说明」里，调用处必须是 ForAuctionBoard
    const callLines = ROWS_SRC.split('\n').filter(function(l) {
      return l.indexOf('getRange20Leaders(') >= 0 && l.trim().charAt(0) !== '/';
    });
    expect(callLines).toEqual([]);
  });

  it('constants：三份榜的只数不许互相顶替（5 展示 / 8 挑新龙 / 10 主线题材）', () => {
    expect(RANGE20_LEADER_TOP_N).toBe(5);
    expect(RANGE20_LEADER_MIN_LEGS).toBe(6);
  });
});

describe('会话缓存早退闸门 —— ⛔ 不许在算竞价榜之前就 return（静态锁）', () => {
  const SRC = fs.readFileSync(
    path.join(process.cwd(), 'src/logic/auction/range20-leaders.js'), 'utf8');

  it('★ 早退必须同时问「该日的竞价口径成员榜试过了没有」', () => {
    // 缺口：`_boardCache` 在精算段【末尾】才算，而开头有一条 `if (_cache.has(date)) return`
    //   ⇒ 只要这一天先前算过一次，后续调用永远到不了算竞价榜那段 ⇒ 盘后一直回落收盘口径
    //   ⇒ 「有时显示、有时不显示」—— 比完全不修更难排查。
    expect(SRC).toContain('_needBoard');
    expect(SRC).toContain('_boardTried');
    // 判据必须是「盘后」才生效：早上 legMode==='auc' 时行为一字不变（§11）
    expect(SRC).toContain("(legMode === 'close') && !_boardTried.has(date)");
    // ⛔ 不许退化成「按 _boardCache 有没有判断」—— auc 腿一直不齐时会每次重算精算段（§32）
    expect(SRC).not.toContain("(legMode === 'close') && !_boardCache.has(date)");
  });

  it('_boardTried 与 _cache 同生命周期：口径切换 + POOLGROW 都要清，clear 要全清', () => {
    const dels = (SRC.match(/_boardTried\.delete\(date\)/g) || []).length;
    expect(dels).toBeGreaterThanOrEqual(2);   // TSWITCH + POOLGROW
    expect(SRC).toContain('_boardTried.clear()');
  });

  it('算完必须记「已尝试」（成功或回落都要记，否则每个 tick 都重算）', () => {
    expect(SRC).toContain('_boardTried.add(date)');
  });
});
