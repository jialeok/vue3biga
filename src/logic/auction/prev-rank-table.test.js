// prev-rank-table.test.js — 「昨日 20日涨幅名次表」的口径与排队次（纯函数部分）
//
// 锁死三件事（用户 2026-10-28 口径）：
//   ① 竞价口径与收盘口径【各自配各自的昨天】，⛔ 不许混（「不要搞混了，这样才能分辨出来」）；
//   ② 名次只有一套算法（两种口径共用，⛔ 不许分叉）；
//   ③ 收盘口径只认 leg='close' 的行：只有 auc 行的票【不收】—— 那是另一把尺子量出来的数。
import { describe, it, expect } from 'vitest';
import { buildRankTable, pickCloseLegRows, resolvePrevRankLeg, resolveTodayLeg, PREV_LEG_AUC, PREV_LEG_CLOSE } from './prev-rank-table.js';
import { resolveT20LegMode, isAfterCloseOf } from './range20.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';

describe('prev-rank-table · buildRankTable（两种口径共用的唯一排队次实现）', function() {
  it('按涨幅降序编名次（1 起），并带回每只票的涨幅', function() {
    const t = buildRankTable([
      { stock: '甲', pct: 30 },
      { stock: '乙', pct: 90 },
      { stock: '丙', pct: 60 }
    ]);
    expect(t.count).toBe(3);
    expect(t.ranks.get('乙')).toBe(1);
    expect(t.ranks.get('丙')).toBe(2);
    expect(t.ranks.get('甲')).toBe(3);
    expect(t.pcts.get('乙')).toBe(90);
  });

  it('同值按股票名定序（结果稳定、可复现，⛔ 不靠数组顺序）', function() {
    const names = ['丙', '甲', '乙'];
    const t = buildRankTable(names.map(function(n) { return { stock: n, pct: 50 }; }));
    // 期望顺序 = 与实现同一个比较器（localeCompare 'zh'），⛔ 不在这里硬编码一套「我以为的中文序」
    const expectOrder = names.slice().sort(function(a, b) { return String(a).localeCompare(String(b), 'zh'); });
    expect(Array.from(t.ranks.keys())).toEqual(expectOrder);
    // 同一批输入换个数组顺序 ⇒ 名次完全一致（证明不依赖入参顺序）
    const t2 = buildRankTable(names.slice().reverse().map(function(n) { return { stock: n, pct: 50 }; }));
    expect(Array.from(t2.ranks.entries())).toEqual(Array.from(t.ranks.entries()));
  });

  it('§10：算不出涨幅的行不进榜（⛔ 不拿 0 冒充），名字留空的同样丢弃', function() {
    const t = buildRankTable([
      { stock: '甲', pct: 10 },
      { stock: '乙', pct: null },
      { stock: '丙', pct: '' },
      { stock: '', pct: 99 },
      null
    ]);
    expect(t.count).toBe(1);
    expect(Array.from(t.ranks.keys())).toEqual(['甲']);
  });

  it('§10：一只都排不出来 ⇒ null（判不出，⛔ 不返回空表冒充「都没名次」）', function() {
    expect(buildRankTable([])).toBeNull();
    expect(buildRankTable(null)).toBeNull();
    expect(buildRankTable([{ stock: '甲', pct: null }])).toBeNull();
  });

  it('兼容带 % / + 的字符串（表里 pct 是数值列，但历史行可能是文本）', function() {
    const t = buildRankTable([{ stock: '甲', pct: '+12.5%' }, { stock: '乙', pct: '7.25' }]);
    expect(t.pcts.get('甲')).toBe(12.5);
    expect(t.ranks.get('甲')).toBe(1);
  });
});

describe('prev-rank-table · pickCloseLegRows（收盘口径只认 close 腿）', function() {
  it('同一只票两腿并存 ⇒ 取 close（当天 20 日复利的权威值）', function() {
    const out = pickCloseLegRows([
      { stock: '甲', pct: 10, leg: 'auc' },
      { stock: '甲', pct: 12, leg: 'close' }
    ]);
    expect(out).toEqual([{ stock: '甲', pct: 12 }]);
  });

  it('顺序反过来也一样（先 close 后 auc ⇒ close 不被顶掉）', function() {
    const out = pickCloseLegRows([
      { stock: '甲', pct: 12, leg: 'close' },
      { stock: '甲', pct: 10, leg: 'auc' }
    ]);
    expect(out).toEqual([{ stock: '甲', pct: 12 }]);
  });

  it('★ 只有 auc 行的票【不收】——那是另一把尺子，混进来就是「搞混了」', function() {
    const out = pickCloseLegRows([
      { stock: '甲', pct: 12, leg: 'close' },
      { stock: '乙', pct: 30, leg: 'auc' }
    ]);
    expect(out.map(function(x) { return x.stock; })).toEqual(['甲']);
  });

  it('leg 为空（历史脏数据）按 close 对待（旧行本来就是收盘口径）', function() {
    const out = pickCloseLegRows([{ stock: '甲', pct: 12, leg: '' }, { stock: '乙', pct: 8 }]);
    expect(out.map(function(x) { return x.stock; }).sort()).toEqual(['乙', '甲']);
  });

  it('空输入 / 异常行 ⇒ 空数组（由 buildRankTable 判 null）', function() {
    expect(pickCloseLegRows(null)).toEqual([]);
    expect(pickCloseLegRows([null, { pct: 5 }])).toEqual([]);
  });
});

describe('prev-rank-table · resolvePrevRankLeg（基准腿恒为昨日收盘 —— 2026-10-28 用户口述定死）', function() {
  // 用户原话：「注意我说的20日涨幅的当天竞价口径对比昨天的收盘口径的……就是早上我打开时看到
  //   襄阳轴承是竞价口径排名比10月26日的襄阳轴承收盘口径的排名增减变化（不是比10月26日的
  //   襄阳轴承竞价口径，这点你注意）」
  // ⇒ 基准腿【恒 close】，与今天那列是竞价还是收盘无关。

  it('★ 恒返回 close（今天竞价也比昨收，今天收盘也比昨收）', function() {
    expect(resolvePrevRankLeg()).toBe(PREV_LEG_CLOSE);
  });

  it('★ 签名里没有参数 —— ⛔ 别再有人把 toggle / 日期接回来', function() {
    // 早先那版是 resolvePrevRankLeg(date, byAuctionLeg)，用户已明确否掉「竞价配竞价」
    expect(resolvePrevRankLeg.length).toBe(0);
    // 就算调用方硬塞实参也不影响结果（多余实参被忽略）
    expect(resolvePrevRankLeg('2026-10-28', true)).toBe(PREV_LEG_CLOSE);
    expect(resolvePrevRankLeg('2026-01-05', false)).toBe(PREV_LEG_CLOSE);
    expect(resolvePrevRankLeg(null, true)).toBe(PREV_LEG_CLOSE);
  });

  it('resolveTodayLeg：只服务文案 —— toggle 打开即 auc，否则与 range20 的 T 腿【同一个函数】', function() {
    expect(resolveTodayLeg('2026-10-28', true)).toBe(PREV_LEG_AUC);
    expect(resolveTodayLeg('2026-01-05', false)).toBe(PREV_LEG_CLOSE);
    const today = _getLocalTodayStr();
    const expected = resolveT20LegMode(true, isAfterCloseOf(today)) === 'auc' ? PREV_LEG_AUC : PREV_LEG_CLOSE;
    expect(resolveTodayLeg(today, false)).toBe(expected);
  });

  it('resolveTodayLeg 空日期 ⇒ 保守按 close（§10 不猜；调用方会因「没有上一交易日」跳过）', function() {
    expect(resolveTodayLeg('', false)).toBe(PREV_LEG_CLOSE);
    expect(resolveTodayLeg(null, false)).toBe(PREV_LEG_CLOSE);
  });

  it('两条腿的语义不可互换：基准永远 close，今天腿可能 auc', function() {
    // 即便「今天的口径」是竞价，基准也不会跟着变 —— 这正是用户要求的「分辨出来」
    const todayLeg = resolveTodayLeg(_getLocalTodayStr(), true);
    expect(todayLeg).toBe(PREV_LEG_AUC);
    expect(resolvePrevRankLeg()).toBe(PREV_LEG_CLOSE);
  });
});
