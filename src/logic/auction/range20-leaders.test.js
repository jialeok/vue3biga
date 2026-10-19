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
  RANGE20_LEADER_PRESELECT,
  isMainBoardOnly,
  rankLeaders,
  unionPoolFromDates
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
