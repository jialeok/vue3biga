// range20-leaders.test.js — 「20日涨幅前五 · 龙头补位」单测（§15 纯函数优先，§42 验收清单）
//
// 覆盖用户 2026-10-19 明确的口径：
//   ① 候选池 = 近 20 个交易日【每天正式列表】的并集（不是当天列表）；
//   ② 只取前 5；②' 只算主板（创业板/科创板/北交所/代码未知 全部不算）；
//   ③ 门槛：窗口内至少 6 天在名单里（少于 6 天不参与，⛔ 不补 0 凑数）；
//   ④ 降序 + 稳定 tie-break（同涨幅按天数多者优先，再按名字）。
// 外加 §10 红线：pct 为 null / 非数 ⇒ 不参与排名，⛔ 不当 0 参与。

import { describe, it, expect } from 'vitest';
import {
  RANGE20_LEADER_TOP_N,
  RANGE20_LEADER_MIN_LEGS,
  RANGE20_LEADER_COARSE_MIN_LEGS,
  RANGE20_LEADER_PRESELECT,
  RANGE20_LEADER_WIDE_N,
  RANGE20_LEADER_TEN_N,
  isMainBoardOnly,
  rankLeaders,
  unionPoolFromDates,
  buildLeaderRankPool,
  pickLeaderFromUsableRows,
  getRange20LeadersTop10,
  decideWarmRetry
} from './range20-leaders.js';

describe('常量口径', () => {
  it('只取前 5 只（用户口径「只选出5只」）', () => {
    expect(RANGE20_LEADER_TOP_N).toBe(5);
  });
  it('候选门槛 = 6 天；粗筛余量 = 25 只（必须 >= 前五，且明显小于全市场）', () => {
    expect(RANGE20_LEADER_MIN_LEGS).toBe(6);
    expect(RANGE20_LEADER_PRESELECT).toBeGreaterThan(RANGE20_LEADER_TOP_N * 3);
  });
});

describe('isMainBoardOnly —— 只主板（用户：科创板/创业板/北交所不要算进去）', () => {
  it('沪主板 60 / 深主板 00 / 01 ⇒ true', () => {
    expect(isMainBoardOnly('600000')).toBe(true);
    expect(isMainBoardOnly('601398')).toBe(true);
    expect(isMainBoardOnly('000001')).toBe(true);
    expect(isMainBoardOnly('001979')).toBe(true);
    expect(isMainBoardOnly('002594')).toBe(true);
  });
  it('创业板 30 / 科创板 68 / 北交所 43·83·87·88·92 ⇒ false', () => {
    expect(isMainBoardOnly('300750')).toBe(false);
    expect(isMainBoardOnly('301190')).toBe(false);
    expect(isMainBoardOnly('688981')).toBe(false);
    expect(isMainBoardOnly('689009')).toBe(false);
    expect(isMainBoardOnly('430047')).toBe(false);
    expect(isMainBoardOnly('830799')).toBe(false);
    expect(isMainBoardOnly('871981')).toBe(false);
    expect(isMainBoardOnly('920819')).toBe(false);
  });
  it('§10：代码缺失 / 空串 ⇒ false（主动加票宁可少加也不加错）', () => {
    expect(isMainBoardOnly('')).toBe(false);
    expect(isMainBoardOnly(null)).toBe(false);
    expect(isMainBoardOnly('abc')).toBe(false);
  });
});

describe('rankLeaders —— 排名与截断', () => {
  const rows = [
    { stock: 'A', code: '600001', pct: 80, days: 20 },
    { stock: 'B', code: '600002', pct: 180, days: 20 },
    { stock: 'C', code: '600003', pct: 120, days: 20 },
    { stock: 'D', code: '600004', pct: 60, days: 20 },
    { stock: 'E', code: '600005', pct: 50, days: 20 },
    { stock: 'F', code: '600006', pct: 40, days: 20 }
  ];

  it('默认降序取前 5（第 6 名被截掉）', () => {
    const out = rankLeaders(rows);
    expect(out.length).toBe(5);
    expect(out.map(r => r.stock)).toEqual(['B', 'C', 'A', 'D', 'E']);
  });

  it('limit 可调；rankLeaders 不回传入参（纯函数）', () => {
    const before = rows.map(r => r.stock).join(',');
    const out = rankLeaders(rows, { limit: 2 });
    expect(out.map(r => r.stock)).toEqual(['B', 'C']);
    expect(rows.map(r => r.stock).join(',')).toBe(before);
  });

  it('mainBoardOnly ⇒ 创业板/科创板/北交所被剔除，名次由后面的主板票补上', () => {
    const mixed = [
      { stock: '创A', code: '300001', pct: 300, days: 20 },
      { stock: '科B', code: '688001', pct: 200, days: 20 },
      { stock: '北C', code: '830001', pct: 150, days: 20 },
      { stock: '主D', code: '600001', pct: 100, days: 20 },
      { stock: '主E', code: '000001', pct: 90, days: 20 },
      { stock: '主F', code: '002001', pct: 80, days: 20 },
      { stock: '主G', code: '600002', pct: 70, days: 20 },
      { stock: '主H', code: '600003', pct: 60, days: 20 },
      { stock: '主I', code: '600004', pct: 50, days: 20 }
    ];
    const out = rankLeaders(mixed, { mainBoardOnly: true });
    expect(out.map(r => r.stock)).toEqual(['主D', '主E', '主F', '主G', '主H']);
  });

  it(`门槛 minDays=${RANGE20_LEADER_MIN_LEGS}：天数不足的票不参与（⛔ 不补 0 凑数）`, () => {
    const out = rankLeaders([
      { stock: '缺腿王', code: '600009', pct: 999, days: 5 },
      { stock: '够腿', code: '600010', pct: 10, days: 6 }
    ], { minDays: RANGE20_LEADER_MIN_LEGS });
    expect(out.map(r => r.stock)).toEqual(['够腿']);
  });

  it('§10：pct 为 null / undefined / NaN ⇒ 不参与排名，绝不当 0 参与', () => {
    const out = rankLeaders([
      { stock: '没数据', code: '600011', pct: null, days: 20 },
      { stock: '没字段', code: '600012', days: 20 },
      { stock: 'NaN', code: '600013', pct: NaN, days: 20 },
      { stock: '只有0', code: '600014', pct: 0, days: 20 }
    ], { mainBoardOnly: true });
    // 真 0% 是合法值（停牌 20 天 = 0%），必须留下；null/NaN 全部剔除
    expect(out.map(r => r.stock)).toEqual(['只有0']);
  });

  it('稳定 tie-break：同涨幅 → 天数多者优先 → 名字升序', () => {
    const out = rankLeaders([
      { stock: '乙', code: '600021', pct: 50, days: 18 },
      { stock: '甲', code: '600022', pct: 50, days: 20 },
      { stock: '丙', code: '600023', pct: 50, days: 20 }
    ]);
    expect(out.map(r => r.stock)).toEqual(['丙', '甲', '乙']);
  });

  it('空输入 / 非数组 ⇒ 空数组（不抛错）', () => {
    expect(rankLeaders([])).toEqual([]);
    expect(rankLeaders(null)).toEqual([]);
  });
});

describe('unionPoolFromDates —— 候选池 = 每天正式列表的并集', () => {
  it('跨日期去重；同名只出现一次（先到先得）', () => {
    const rowsByDate = new Map([
      ['2026-10-16', new Map([['九阳股份', { stock: '九阳股份', code: '002242' }], ['甲', { stock: '甲' }]])],
      ['2026-10-19', new Map([['九阳股份', { stock: '九阳股份', code: '002242' }], ['乙', { stock: '乙' }]])]
    ]);
    const pool = unionPoolFromDates(rowsByDate);
    expect(pool.map(t => t.stock).sort()).toEqual(['乙', '九阳股份', '甲'].sort());
  });

  it('★ 关键语义：候选池与「当天列表」无关 —— 昨天在、今天不在的票也必须进池', () => {
    const rowsByDate = new Map([
      ['2026-10-16', new Map([['已消失的龙头', { stock: '已消失的龙头', code: '600123' }]])],
      ['2026-10-19', new Map([['今天上榜', { stock: '今天上榜', code: '600124' }]])]
    ]);
    const names = unionPoolFromDates(rowsByDate).map(t => t.stock);
    expect(names).toContain('已消失的龙头');
    expect(names).toContain('今天上榜');
  });

  it('空输入 ⇒ 空数组', () => {
    expect(unionPoolFromDates(null)).toEqual([]);
    expect(unionPoolFromDates(new Map())).toEqual([]);
  });
});

// ============================================================================
// [R20-TOP5-POOL 2026-10-20] 用户投诉：「今天补的这些 20 日涨幅都是负数，不是强势股啊，
//   是代码乱补、兜底？我说的是补强势股，就是 20 日涨幅前五的……让我能看到真正排名前五的龙头。
//   其它后排的不要乱补，会污染数据。」
//
// 根因（实测 10-20 数据复现）：精算只覆盖粗筛前 25 只，上游限流时大部分请求失败 ⇒
//   这些票在 fresh 里只剩一根 T 腿 ⇒ 被 minDays=6 全部筛掉 ⇒ 前五只能从「侥幸精算成功的
//   少数弱势票」里出（金健米业 -2.88% / 捷荣技术 -16.09% / 海正新材 -18.00% …）。
//   而全池真实近似前五是 新华传媒 111.70 / 九阳股份 62.30 / 时代万恒 60.04 / 新华文轩 58.85。
//
// 这组用例锁住「精算失败不许把强票踢出排名」这条红线。
// ============================================================================

describe('RANGE20_LEADER_COARSE_MIN_LEGS —— 粗筛门槛必须与可信门槛分开', () => {
  it('粗筛门槛 2 < 可信门槛 6（粗筛宁滥勿缺，只排除「只有 1 天数据」的噪声）', () => {
    expect(RANGE20_LEADER_COARSE_MIN_LEGS).toBe(2);
    expect(RANGE20_LEADER_COARSE_MIN_LEGS).toBeLessThan(RANGE20_LEADER_MIN_LEGS);
  });
});

describe('buildLeaderRankPool —— 排名池四层合并（★ 本轮修复的核心）', () => {
  it('★★ 精算全部失败时，粗筛近似值必须兜底 ⇒ 强票不会消失（这正是用户看到的 bug）', () => {
    const coarseTop = [
      { stock: '新华传媒', code: '600825', pct: 111.70, days: 12 },
      { stock: '九阳股份', code: '002242', pct: 62.30, days: 9 },
      { stock: '时代万恒', code: '600241', pct: 60.04, days: 8 },
      { stock: '新华文轩', code: '601811', pct: 58.85, days: 15 },
      { stock: '澳弘电子', code: '605058', pct: 53.74, days: 17 },
      { stock: '金健米业', code: '600127', pct: 38.77, days: 12 }
    ];
    // K 线一个都没拿到 ⇒ fresh 只有「T 腿一根」的残缺值（days=1）
    const fresh = [{ stock: '金健米业', pct: -2.88, days: 1 }];
    const pool = buildLeaderRankPool({ coarseTop: coarseTop, fresh: fresh });
    const top = rankLeaders(pool, { limit: 5, minDays: RANGE20_LEADER_MIN_LEGS, mainBoardOnly: true });
    expect(top.map(r => r.stock)).toEqual(['新华传媒', '九阳股份', '时代万恒', '新华文轩', '澳弘电子']);
    // 且全部标记为「近似」（不是真值，视图/title 可以据此说明）
    expect(pool.filter(r => r.approx).length).toBe(6);
  });

  it('★★ 残缺的精算值（days=1）⛔ 不许覆盖粗筛近似（否则强票被拉成「T 日当天涨幅」）', () => {
    const pool = buildLeaderRankPool({
      coarseTop: [{ stock: '新华传媒', code: '600825', pct: 111.70, days: 12 }],
      fresh: [{ stock: '新华传媒', pct: 2.77, days: 1 }]
    });
    expect(pool.length).toBe(1);
    expect(pool[0].pct).toBe(111.70);
    expect(pool[0].approx).toBe(true);
  });

  it('精算拿到完整腿（days>=6）⇒ 用真值覆盖近似值', () => {
    const pool = buildLeaderRankPool({
      coarseTop: [{ stock: '新华传媒', code: '600825', pct: 111.70, days: 12 }],
      fresh: [{ stock: '新华传媒', pct: 197.82, days: 20 }]
    });
    expect(pool[0].pct).toBe(197.82);
    expect(pool[0].approx).toBe(false);
  });

  it('优先级：精算 > 主看板 > 云端 > 粗筛（后者依次被覆盖）', () => {
    const cloud = new Map([['甲', { pct: 50, days: 20 }]]);
    const live = new Map([['甲', { pct: 60, days: 20 }]]);
    const fresh = [{ stock: '甲', pct: 70, days: 20 }];
    const coarseTop = [{ stock: '甲', code: '600001', pct: 999, days: 20 }];
    const a = buildLeaderRankPool({ coarseTop: coarseTop, cloudMap: cloud });
    expect(a[0].pct).toBe(50);
    const b = buildLeaderRankPool({ coarseTop: coarseTop, cloudMap: cloud, liveMap: live });
    expect(b[0].pct).toBe(60);
    const c = buildLeaderRankPool({ coarseTop: coarseTop, cloudMap: cloud, liveMap: live, fresh: fresh });
    expect(c[0].pct).toBe(70);
  });

  it('主看板 map 按候选池过滤（池外的票不许混进排名）', () => {
    const pool = buildLeaderRankPool({
      coarseTop: [{ stock: '甲', code: '600001', pct: 10, days: 20 }],
      liveMap: new Map([['池外票', { pct: 999, days: 20 }]]),
      poolNames: new Set(['甲'])
    });
    expect(pool.map(r => r.stock)).toEqual(['甲']);
  });

  it('§10：pct 为 null / NaN 的云端/主看板行 ⛔ 不覆盖已有值', () => {
    const pool = buildLeaderRankPool({
      coarseTop: [{ stock: '甲', code: '600001', pct: 10, days: 20 }],
      cloudMap: new Map([['甲', { pct: null, days: 20 }]]),
      liveMap: new Map([['甲', { pct: NaN, days: 20 }]])
    });
    expect(pool[0].pct).toBe(10);
  });

  it('空输入 ⇒ 空数组（不抛错）', () => {
    expect(buildLeaderRankPool({})).toEqual([]);
    expect(buildLeaderRankPool(null)).toEqual([]);
  });
});

// ============================================================================
// ★★ [DIVERGE-GUESS 2026-10-24] pickLeaderFromUsableRows —— 分歧判定【预热通道】挑候选
//   背景（用户原话）：「为什么这个提示总是过很久才显示出来……计算判断有那么久吗？要再优化下」
//   ⇒ 用【上一交易日已落库的 20 日涨幅】先猜「今天的总龙一是谁」，好让分歧判定提前跑起来。
//   ⚠️ 它只产出【猜测】(门控 + 预热 K 线)，⛔ 绝不当结论用 ⇒ 判据必须可单测。
// ============================================================================
describe('tvrb · [DIVERGE-GUESS] pickLeaderFromUsableRows（预热挑总龙一候选）', function() {
  const CODES = {
    '甲一': '600001',      // 主板
    '乙一': '000002',      // 主板（深市）
    '创一': '300003',      // 创业板 ⇒ 非主板
    '科一': '688004',      // 科创板 ⇒ 非主板
    '北一': '830005',      // 北交所 ⇒ 非主板
    '无名': ''             // 名册里没有 ⇒ 拿不到代码
  };
  const codeOf = function(n) { return CODES[String(n || '').trim()] || ''; };
  const mk = function(obj) {
    const m = new Map();
    Object.keys(obj).forEach(function(k) { m.set(k, { pct: obj[k], days: 20 }); });
    return m;
  };

  it('取涨幅最大的那只（含 code / pct / days）', () => {
    const r = pickLeaderFromUsableRows(mk({ '甲一': 101.2, '乙一': 210.98 }), codeOf);
    expect(r).toEqual({ stock: '乙一', code: '000002', pct: 210.98, days: 20 });
  });

  it('§10：非主板一律不参与（创业板 / 科创板 / 北交所）', () => {
    const r = pickLeaderFromUsableRows(mk({ '甲一': 50, '创一': 300, '科一': 280, '北一': 260 }), codeOf);
    expect(r.stock).toBe('甲一');
  });

  it('§10：拿不到代码的票⛔ 不参与（K 线请求发不出去，⛔ 不用名字硬试）', () => {
    const r = pickLeaderFromUsableRows(mk({ '甲一': 50, '无名': 999 }), codeOf);
    expect(r.stock).toBe('甲一');
  });

  it('§10：pct 为 null / NaN ⇒ 跳过（未知 ≠ 0，⛔ 不补 0 参与比较）', () => {
    const r = pickLeaderFromUsableRows(mk({ '甲一': 10, '乙一': null }), codeOf);
    expect(r.stock).toBe('甲一');
    const r2 = pickLeaderFromUsableRows(mk({ '甲一': 10, '乙一': NaN }), codeOf);
    expect(r2.stock).toBe('甲一');
  });

  it('全都不合格 / 空输入 ⇒ null（调用方据此降级为「不预热」，§10 不猜）', () => {
    expect(pickLeaderFromUsableRows(mk({ '创一': 300, '无名': 999 }), codeOf)).toBe(null);
    expect(pickLeaderFromUsableRows(new Map(), codeOf)).toBe(null);
    expect(pickLeaderFromUsableRows(null, codeOf)).toBe(null);
    expect(pickLeaderFromUsableRows(undefined, codeOf)).toBe(null);
  });

  it('没传 codeOf ⇒ 全部拿不到代码 ⇒ null（⛔ 不猜代码）', () => {
    expect(pickLeaderFromUsableRows(mk({ '甲一': 100 }), null)).toBe(null);
  });
});

// ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 第三份裁剪 = 20日涨幅【前十】。
//   用户原话：「20日涨幅中排名前10的……必须至少有3只排在前10（才算主线题材）」。
//   用途隔离：5 = 展示 / 8 = 挑新龙 / 10 = 主线题材成组计数，⛔ 三者别互相顶替。
describe('[EBB-MAIN-TOPIC] 前十榜单（主线题材计数用）', () => {
  it('常量：前五 5 / 宽榜 8 / 题材榜 10，且逐级包含', () => {
    expect(RANGE20_LEADER_TOP_N).toBe(5);
    expect(RANGE20_LEADER_WIDE_N).toBe(8);
    expect(RANGE20_LEADER_TEN_N).toBe(10);
    expect(RANGE20_LEADER_WIDE_N).toBeGreaterThan(RANGE20_LEADER_TOP_N);
    expect(RANGE20_LEADER_TEN_N).toBeGreaterThan(RANGE20_LEADER_WIDE_N);
  });

  it('★ §11 零行为变化：前五 / 前八 与「直接按 limit=5/8 各裁一次」逐只相同（裁一次前十再切）', () => {
    const rows = [];
    for (let i = 0; i < 14; i++) {
      rows.push({ stock: '票' + String(i).padStart(2, '0'), code: '6000' + String(i).padStart(2, '0'), pct: 200 - i * 7, days: 20 });
    }
    const ten = rankLeaders(rows, { limit: RANGE20_LEADER_TEN_N, minDays: RANGE20_LEADER_MIN_LEGS, mainBoardOnly: true });
    const wideBySlice = ten.slice(0, RANGE20_LEADER_WIDE_N);
    const topBySlice = ten.slice(0, RANGE20_LEADER_TOP_N);
    const wideDirect = rankLeaders(rows, { limit: RANGE20_LEADER_WIDE_N, minDays: RANGE20_LEADER_MIN_LEGS, mainBoardOnly: true });
    const topDirect = rankLeaders(rows, { limit: RANGE20_LEADER_TOP_N, minDays: RANGE20_LEADER_MIN_LEGS, mainBoardOnly: true });
    expect(wideBySlice).toEqual(wideDirect);
    expect(topBySlice).toEqual(topDirect);
    expect(ten).toHaveLength(10);
  });

  it('该日还没有结论 ⇒ getRange20LeadersTop10 返 null（§10：能不能 ≠ 有没有，⛔ 不拿空数组冒充）', () => {
    expect(getRange20LeadersTop10('2026-01-01')).toBe(null);
    expect(getRange20LeadersTop10('')).toBe(null);
    expect(getRange20LeadersTop10(null)).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// [R20-WARM-GROW 2026-10-26] 预热退避的「封顶后裁决」—— 用户报障「题材量比一直不产出」的回归护栏
//
// 用户原话：「题材量比还是没有加载完成，只加载了早盘竞价……半个钟都没有加载完成」。
// 根因：候选池来自按日异步补齐的「正式列表索引」，而旧实现 4 次（3s/10s/30s/60s = 103s）后
//   **永久放弃**；历史补齐要到「首屏 10s + 空闲 + 拉取」之后才完成，必然错过这 103 秒
//   ⇒ range20 再也不算 ⇒ 题材量比永久停在「候选池为空 ⇒ 本次不产出」。
// 这组用例锁住三条红线：① 索引还在长就必须继续算（否则永久卡死）
//                      ② 索引不长了必须停（否则 §32 无限轮询）
//                      ③ 已经烧过 K 线的场景到上限必须停（否则 §32 重复请求）
// ══════════════════════════════════════════════════════════════════════════════════
describe('[R20-WARM-GROW] 预热退避封顶后的裁决（题材量比不产出的回归护栏）', () => {
  it('未到次数上限 ⇒ continue（不论池空还是已精算，都按正常退避走）', () => {
    expect(decideWarmRetry({ n: 0, readyDays: -1 }, 5, true)).toBe('continue');
    expect(decideWarmRetry({ n: 3, readyDays: 10 }, 12, true)).toBe('continue');
    expect(decideWarmRetry({ n: 0, readyDays: -1 }, 5, false)).toBe('continue');
    expect(decideWarmRetry({ n: 3, readyDays: 10 }, 12, false)).toBe('continue');
  });

  it('★ 到达上限 + 池空（0 请求）+ 索引仍在长 ⇒ reset（这是「不再永久放弃」的核心）', () => {
    expect(decideWarmRetry({ n: 4, readyDays: 0 }, 1, true)).toBe('reset');
    expect(decideWarmRetry({ n: 4, readyDays: 20 }, 45, true)).toBe('reset');
    // 索引一次补齐 jumps 很大（按日批量补）⇒ 同样要续命
    expect(decideWarmRetry({ n: 4, readyDays: 1 }, 45, true)).toBe('reset');
  });

  it('到达上限 + 池空 + 索引停在原地 ⇒ stop（§32：⛔ 不许无限轮询）', () => {
    expect(decideWarmRetry({ n: 4, readyDays: 45 }, 45, true)).toBe('stop');
    expect(decideWarmRetry({ n: 4, readyDays: 0 }, 0, true)).toBe('stop');
    // 索引异常回退（理论上不会，但绝不能因此无限重试）
    expect(decideWarmRetry({ n: 4, readyDays: 45 }, 40, true)).toBe('stop');
  });

  it('到达上限 + 已精算（要烧 K 线）⇒ 一律 stop，索引再长也不续（§32 重复请求红线）', () => {
    expect(decideWarmRetry({ n: 4, readyDays: 0 }, 45, false)).toBe('stop');
    expect(decideWarmRetry({ n: 4, readyDays: 20 }, 45, false)).toBe('stop');
  });

  it('首次进入（readyDays 未记录，隐式 -1）且池空 ⇒ 0 > -1 成立，允许一次续命', () => {
    expect(decideWarmRetry({ n: 4 }, 0, true)).toBe('reset');
    expect(decideWarmRetry({ n: 4, readyDays: undefined }, 0, true)).toBe('reset');
  });

  it('收敛性：readyDays 单调涨到上界后就只能 stop（保证不会永远重算）', () => {
    const total = 45;
    let st = { n: 4, readyDays: -1 };
    let rounds = 0;
    for (let d = 0; d <= total; d++) {
      const v = decideWarmRetry(st, d, true);
      if (v === 'stop') break;
      if (v === 'reset') { st = { n: 4, readyDays: d }; rounds++; }
    }
    // 涨到 45 之后 d 不再增加 ⇒ 必然 stop；续命轮数受上界约束，不会无限
    expect(decideWarmRetry({ n: 4, readyDays: total }, total, true)).toBe('stop');
    expect(rounds).toBeLessThanOrEqual(total + 1);
  });

  it('非数 / 空值不炸：readyDays 传脏值按「不增长」处理 ⇒ stop', () => {
    expect(decideWarmRetry({ n: 4, readyDays: 10 }, NaN, true)).toBe('stop');
    expect(decideWarmRetry({ n: 4, readyDays: 10 }, null, true)).toBe('stop');
    expect(decideWarmRetry(null, 5, true)).toBe('continue');   // st 缺失 ⇒ n=0 ⇒ 未到上限
  });
});
