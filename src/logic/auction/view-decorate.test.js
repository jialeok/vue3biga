// view-decorate.test.js — items 后置标注单测（20日名次 / 题材统计条+序号 / 主板名次）
//
// 这段以前在 computeAuctionViewData 里只能靠真机看，抽出来后锁三件事：
//   ① 20日名次变化：只在 byRangePct20 且非题材单独模式时赋；判不出 ⇒ '—'（§10 ⛔ 不用 0 冒充）
//   ② 题材统计条落点必须是**块的第一行**，序号按题材重置（2026-09-23 会稽山事故的老坑）
//   ③ 非题材模式：topicStats 清空、seqNo 走 board-seq（其它 toggle 下零行为变化，§11）

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  statsCalls: [],
  seqCalls: [],
  statsResult: new Map(),
  seqResult: [],
  deltaMap: new Map(),
}));

vi.mock('../date/trading-day-helpers.js', () => ({
  getPreviousTradingDay: () => '2026-11-04',
}));
vi.mock('../../data/watchlist-helpers.js', () => ({
  // 量比：只有 'A' 有值，其它 ⇒ null（§10 缺失不补 0）
  getAucVolRatio: (date, name) => (name === 'A' ? 12.5 : null),
}));
vi.mock('./seal-volume.js', () => ({
  sealLotsOf: () => null,
}));
vi.mock('./topic-stats.js', () => ({
  buildTopicStatsMap: (entries) => {
    h.statsCalls.push(entries);
    return h.statsResult;
  },
}));
vi.mock('./board-seq.js', () => ({
  buildMainBoardSeq: (items, sortState) => {
    h.seqCalls.push({ items: items.length, sortState });
    return h.seqResult;
  },
}));
vi.mock('./prev-rank-table.js', () => ({
  getPrevRankTable: () => ({ rows: [] }),
  resolvePrevRankLeg: () => 'close',
  resolveTodayLeg: () => 'auc',
  PREV_LEG_AUC: 'auc',
}));
vi.mock('./range20-rank-delta.js', () => ({
  buildRange20RankDelta: () => h.deltaMap,
  RANGE20_DELTA_UNKNOWN_TEXT: '—',
}));

const { applyRange20RankDelta, applyTopicStatsAndSeqNo } = await import('./view-decorate.js');

beforeEach(() => {
  h.statsCalls = [];
  h.seqCalls = [];
  h.statsResult = new Map();
  h.seqResult = [];
  h.deltaMap = new Map();
});

function mkItems(names) {
  return names.map(function(n, i) { return { stock: n, index: i }; });
}

describe('[DECORATE] 20日名次变化', () => {
  const on = { byRangePct20: true, byAuctionLeg: true };

  it('★ toggle 关闭 ⇒ 一行都不赋，且⛔ 不读那一份 Map（惰性）', () => {
    const items = mkItems(['A', 'B']);
    const mapOf = vi.fn();
    const ran = applyRange20RankDelta(items, {
      sortState: { byRangePct20: false }, topicOnlyMode: false, currentDate: '2026-11-05', range20MapOf: mapOf
    });
    expect(ran).toBe(false);
    expect(mapOf).not.toHaveBeenCalled();
    expect(items[0].range20RankDeltaText).toBeUndefined();
  });

  it('★ 题材单独模式 ⇒ 不赋（顺序不是涨幅降序，名次没有意义，§10 宁可没有）', () => {
    const items = mkItems(['A']);
    const ran = applyRange20RankDelta(items, {
      sortState: on, topicOnlyMode: true, currentDate: '2026-11-05', range20MapOf: () => new Map()
    });
    expect(ran).toBe(false);
    expect(items[0].range20RankDeltaTitle).toBeUndefined();
  });

  it('★ 打开 ⇒ 有变化的写文案，判不出的写「—」并在 title 里说明原因', () => {
    h.deltaMap = new Map([['A', { text: '+6', tone: 'up' }]]);
    const items = mkItems(['A', 'B']);
    const ran = applyRange20RankDelta(items, {
      sortState: on, topicOnlyMode: false, currentDate: '2026-11-05', range20MapOf: () => new Map()
    });
    expect(ran).toBe(true);
    expect(items[0].range20RankDeltaText).toBe('+6');
    expect(items[0].range20RankDeltaTone).toBe('up');
    // §21 模板零计算：文案在逻辑层拼好，且两把尺子写清楚
    expect(items[0].range20RankDeltaTitle).toContain('今·9:26竞价口径');
    expect(items[0].range20RankDeltaTitle).toContain('昨·收盘口径');
    // 判不出：⛔ 不是 0，是 '—' + 可解释的 title
    expect(items[1].range20RankDeltaText).toBe('—');
    expect(items[1].range20RankDeltaTitle).toContain('未判出');
  });

  it('★ 空股票名的行跳过（不写半套字段）', () => {
    const items = [{ stock: '', index: 0 }];
    applyRange20RankDelta(items, { sortState: on, topicOnlyMode: false, currentDate: '2026-11-05', range20MapOf: () => new Map() });
    expect(items[0].range20RankDeltaText).toBeUndefined();
  });
});

describe('[DECORATE] 题材统计条 + 组内序号', () => {
  const primary = function(idx) { return ['科技', '科技', '医药', '医药'][idx]; };

  it('★ 统计条只挂在每个题材块的【第一行】，序号按题材从 1 重数', () => {
    h.statsResult = new Map([['科技', { count: 2 }], ['医药', { count: 2 }]]);
    const items = mkItems(['A', 'B', 'C', 'D']);
    items.forEach(function(it) { it.isYiZi = false; it.closePct = null; it.isFormalMember = true; });
    applyTopicStatsAndSeqNo(items, {
      currentDate: '2026-11-05', topicOnlyMode: true, primaryTopicOfForColor: primary,
      range10MapOf: () => new Map(), renderList: items, sortState: {}, auctionPctOf: () => null
    });
    expect(items.map(function(i) { return i.groupTopic; })).toEqual(['科技', '科技', '医药', '医药']);
    expect(items.map(function(i) { return i.seqNo; })).toEqual([1, 2, 1, 2]);
    // 落点 = 块首：科技挂在 A、医药挂在 C；B/D 为 null（不是「找不到就不挂」）
    expect(items[0].topicStats).toEqual({ count: 2 });
    expect(items[1].topicStats).toBe(null);
    expect(items[2].topicStats).toEqual({ count: 2 });
    expect(items[3].topicStats).toBe(null);
  });

  it('★ 灰行（非正式成员）也要作为「块首」拿到统计条 —— ⛔ 不许跳过它去找正式成员', () => {
    h.statsResult = new Map([['科技', { count: 1 }]]);
    const items = mkItems(['A', 'B']);
    items.forEach(function(it) { it.isFormalMember = false; });
    applyTopicStatsAndSeqNo(items, {
      currentDate: '2026-11-05', topicOnlyMode: true, primaryTopicOfForColor: function() { return '科技'; },
      range10MapOf: () => new Map(), renderList: items, sortState: {}, auctionPctOf: () => null
    });
    expect(items[0].topicStats).toEqual({ count: 1 });
  });

  it('★ 题材名为空 ⇒ 归「其它」（不能出现空组名）', () => {
    h.statsResult = new Map([['其它', { count: 1 }]]);
    const items = mkItems(['A']);
    applyTopicStatsAndSeqNo(items, {
      currentDate: '2026-11-05', topicOnlyMode: true, primaryTopicOfForColor: function() { return '   '; },
      range10MapOf: () => new Map(), renderList: items, sortState: {}, auctionPctOf: () => null
    });
    expect(items[0].groupTopic).toBe('其它');
  });

  it('★ 送进 buildTopicStatsMap 的 entries：计数看 formal、平均量比看全部行（两套分母）', () => {
    const items = mkItems(['A', 'B']);
    items[0].isFormalMember = true;
    items[1].isFormalMember = false;   // 灰行
    applyTopicStatsAndSeqNo(items, {
      currentDate: '2026-11-05', topicOnlyMode: true, primaryTopicOfForColor: function() { return '科技'; },
      range10MapOf: () => new Map([['A', { pct: 12 }]]), renderList: items, sortState: {}, auctionPctOf: () => 1.5
    });
    const entries = h.statsCalls[0];
    expect(entries).toHaveLength(2);                 // 灰行也送进去（平均量比分母要它）
    expect(entries[0].formal).toBe(true);
    expect(entries[1].formal).toBe(false);
    expect(entries[0].volRatio).toBe(12.5);          // 有值
    expect(entries[1].volRatio).toBe(null);          // 缺失 ⇒ null，⛔ 不是 0
    expect(entries[0].rangePct).toBe(12);
    expect(entries[1].rangePct).toBe(null);          // 不在 map 里 ⇒ null
  });
});

describe('[DECORATE] 非题材模式：清空统计条 + 主板名次', () => {
  it('★ topicStats 一律 null、groupTopic 清空，seqNo 来自 board-seq', () => {
    h.seqResult = [{ seqNo: 0, seqBlank: true }, { seqNo: 1, seqBlank: false }];
    const items = mkItems(['A', 'B']);
    items[0].topicStats = { stale: true };          // 模拟上一次算过的残留
    items[0].groupTopic = '旧题材';
    applyTopicStatsAndSeqNo(items, {
      currentDate: '2026-11-05', topicOnlyMode: false, primaryTopicOfForColor: null,
      range10MapOf: () => new Map(), renderList: items, sortState: { byRangePct: true }, auctionPctOf: () => null
    });
    expect(items[0].topicStats).toBe(null);
    expect(items[0].groupTopic).toBe('');
    expect(items.map(function(i) { return i.seqNo; })).toEqual([0, 1]);
    expect(items.map(function(i) { return i.seqBlank; })).toEqual([true, false]);
    // ⛔ 非题材模式不许构建统计条（那是白算一遍全表）
    expect(h.statsCalls).toHaveLength(0);
  });
});
