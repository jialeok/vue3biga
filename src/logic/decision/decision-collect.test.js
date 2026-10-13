// decision-collect.test.js — 「停牌判定的名单出口」suspendEntriesOf 的单测
// （§15 独立业务模块 / §6 单一真相：三个选股看板都从这里拿名单，⛔ 谁都不许自己再遍历一遍）
//
// 为什么要单测：这个函数是「看板上到底会不会出现停牌标」的第一道闸门 ——
//   买点票漏收 ⇒ 那只停牌票不标；形态认错（只读 .picks、不认数组）⇒ 整侧不标。
//   两种都不会报错，只会静默少一枚标签，所以必须钉死。

import { describe, it, expect } from 'vitest';
import { suspendEntriesOf, ebbCtxOf } from './decision-collect.js';

describe('decision-collect · suspendEntriesOf（停牌名单出口，三个选股看板共用）', () => {
  it('买点（buildBuyPlan 形状）+ 卖点分组：两侧都收，并按名字去重', () => {
    const buy = {
      heavy: { block: { topic: 'AI应用' }, picks: [{ name: '三六零', code: '601360' }] },
      light: { block: { topic: '文化传媒' }, picks: [{ name: '新华传媒', code: '600825' }] },
      candidates: [], noYizi: null, smallTopic: null, bigTopic: null
    };
    const sell = [{
      topic: '文化传媒',
      items: [{ name: '新华传媒', code: '600825' }, { name: '东方明珠', code: '600637' }]
    }];
    // 顺序 = heavy → light → … → 卖点；新华传媒在卖点侧是重复项，只出一次
    expect(suspendEntriesOf(buy, sell)).toEqual([
      { stock: '三六零', code: '601360' },
      { stock: '新华传媒', code: '600825' },
      { stock: '东方明珠', code: '600637' }
    ]);
  });

  it('★ 兜底方案外壳（.blocks）里的票也要收到 —— ⛔ 不能只读 .picks', () => {
    const buy = {
      heavy: null, light: null, candidates: [],
      // 三个兜底槽位是【方案外壳】：没有 .block / .picks，真正的块在 .blocks 里
      noYizi: {
        mode: 'noYizi', qualified: true,
        blocks: [{ block: { topic: 'T' }, picks: [{ name: '大亚圣象', code: '000910' }] }]
      },
      smallTopic: null, bigTopic: null
    };
    expect(suspendEntriesOf(buy, null).map(function(e) { return e.stock; })).toEqual(['大亚圣象']);
  });

  it('★ 分笔看板形态：直接传【已摊平的块数组】也认（两种形状都收，不让调用方自己转换）', () => {
    const buyBlocks = [{ topic: 'T', picks: [{ name: '新华传媒', code: '600825' }] }];
    expect(suspendEntriesOf(buyBlocks, [])).toEqual([{ stock: '新华传媒', code: '600825' }]);
  });

  it('§10：拿不到代码的行不参与判定（⛔ 不塞空 code、不猜）', () => {
    const buy = {
      heavy: { block: {}, picks: [{ name: '某票' }] },   // 无 code，名册也没有它
      light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null
    };
    expect(suspendEntriesOf(buy, null)).toEqual([]);
  });

  it('空计划 / null / undefined ⇒ 空数组，不抛错', () => {
    expect(suspendEntriesOf(null, null)).toEqual([]);
    expect(suspendEntriesOf(undefined, [])).toEqual([]);
    expect(suspendEntriesOf([], null)).toEqual([]);
    expect(suspendEntriesOf(null, [{ topic: 'T' }])).toEqual([]);   // 组里没有 items 也不炸
  });

  it('只有名字没有代码的行在【买卖两侧】都被跳过（卖点侧同一口径）', () => {
    const sell = [{ topic: 'T', items: [{ name: '只有名字' }, { name: '有代码', code: '600637' }] }];
    expect(suspendEntriesOf(null, sell)).toEqual([{ stock: '有代码', code: '600637' }]);
  });
});

// ── 第五轮 · 退潮首日的事实采集（2026-10-13 用户口径）────────────────────────────────────────
// 为什么单测：这个函数决定「谁是市场总龙」—— 排错一位，退潮首日就会把【另一只票】当成总龙，
// 进而选出错误的「可等开盘卖」名单。它不报错、只会静默给错名单，所以必须钉死。
// ⚠️ 它读不到的三样东西（停牌 / 今日占比）在本测试环境里是「未加载」⇒ 恒为 false / null，
//    正是 §10 想要的行为（未知 ⇒ 不判），下面的用例也顺带钉住这一点。
describe('decision-collect · ebbCtxOf（退潮首日的事实采集）', () => {
  const D = '2026-10-13';

  function row(name, topic, extra) {
    return Object.assign({ name: name, topic: topic, code: '600000' }, extra || {});
  }
  /** prevRangeMap：股票名 → { pct }（null 值表示「这只票昨日涨幅读不到」） */
  function prev(map) {
    const m = new Map();
    Object.keys(map).forEach(function(k) { m.set(k, { pct: map[k], days: 10, updatedAt: '' }); });
    return m;
  }
  function dm(map) {
    const m = new Map();
    Object.keys(map).forEach(function(k) { m.set(k, { rank: map[k], topic: '', groupSize: 0, pct: 20 }); });
    return m;
  }

  // 用户 2026-10-13 的例子：新华传媒（AI应用）159.51 停牌；时代万恒（新能源汽车）80.98
  const AI = 'AI应用';
  const rows = [
    row('新华传媒', AI, { code: '600825' }),
    row('新华文轩', AI, { code: '601811' }),
    row('皖新传媒', AI, { code: '601801' }),
    row('创票', AI, { code: '300001' }),                 // 创业板 ⇒ 无龙位
    row('时代万恒', '新能源汽车', { code: '600241' })
  ];
  const topics = [
    {
      topic: AI, rank: 1, count: 4, yiziCount: 0,
      members: [
        { name: '新华传媒', isYizi: false },
        { name: '新华文轩', isYizi: false },
        { name: '皖新传媒', isYizi: true },
        { name: '创票', isYizi: false }
      ]
    },
    { topic: '新能源汽车', rank: 2, count: 1, yiziCount: 0, members: [{ name: '时代万恒', isYizi: false }] }
  ];
  const rankMap = dm({ 新华传媒: 1, 新华文轩: 2, 皖新传媒: 3, 时代万恒: 1 });
  const rangeMap = prev({ 新华传媒: 159.51, 新华文轩: 40, 皖新传媒: 30, 创票: 120, 时代万恒: 80.98 });

  it('§10：昨日涨幅没注入 / 空 Map ⇒ ready=false（⛔ 绝不返回「今天没有总龙」）', () => {
    [null, undefined, new Map()].forEach(function(m) {
      const c = ebbCtxOf(rows, topics, rankMap, D, m);
      expect(c.ready).toBe(false);
      expect(c.leader).toBe(null);
      expect(c.second).toBe(null);
      expect(c.siblingDragons).toEqual([]);
      expect(c.secondInfo).toBe(null);
    });
  });

  it('★ 市场总龙 = 【有龙位】的票里昨日十日涨幅最高的那只（候选池 = 当日前列表，含不成组的票）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap);
    expect(c.ready).toBe(true);
    expect(c.leader.name).toBe('新华传媒');     // 159.51 是【有龙位】票里的最高
    expect(c.leader.pct).toBe(159.51);
    expect(c.leader.topic).toBe(AI);
    expect(c.leader.rank).toBe(1);               // 它今日是 AI应用 的龙一
    // ★ [EBB-FIX] 第二高 = 时代万恒 80.98 —— ⛔ 不是涨幅更高的「创票」120：创业板无龙标 ⇒ 不参排
    expect(c.second.name).toBe('时代万恒');
  });

  it('★★ [EBB-FIX 第七轮] 无龙位的票（创业板 / 未成组）【不参与】总龙排名 —— 10-13 善水科技事故的回归钉', () => {
    // 实测事故：10-13 全列表十日涨幅第一是【善水科技 301190 创业板 160.2%】，它没有龙标
    //   ⇒ 旧口径把总龙算成它 ⇒ 它既不停牌、占比也不看龙头门槛 ⇒「退潮」永不成立
    //   ⇒ 整个退潮规则静默失效（用户报「10-13 买点/卖点/灰化 全都没变化」）。
    const r2 = [
      row('善水科技', '', { code: '301190' }),      // 创业板、未成组 ⇒ 无龙位，但昨日涨幅最高
      row('新华传媒', AI, { code: '600825' })
    ];
    const c = ebbCtxOf(r2, topics, rankMap, D, prev({ 善水科技: 160.2, 新华传媒: 159.51 }));
    expect(c.ready).toBe(true);
    expect(c.leader.name).toBe('新华传媒');   // ⛔ 不是善水科技
    expect(c.leader.pct).toBe(159.51);
    expect(c.second).toBe(null);              // 善水被排除 ⇒ 候选池只剩一只
  });

  it('§10：候选池里【一只龙位票】都排不出（全是无龙位）⇒ ready=false（⛔ 不猜成「今天没有总龙」）', () => {
    const r3 = [row('善水科技', '', { code: '301190' })];
    const c = ebbCtxOf(r3, topics, rankMap, D, prev({ 善水科技: 160.2 }));
    expect(c.ready).toBe(false);
    expect(c.leader).toBe(null);
    expect(c.second).toBe(null);
  });

  it('§10：昨日涨幅【读不到】的票不参与排名（⛔ 不当 0 排到最后、更不当没有）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, prev({ 新华传媒: 159.51, 时代万恒: 80.98 }));
    expect(c.leader.name).toBe('新华传媒');
    expect(c.second.name).toBe('时代万恒');     // 其余三只读不到 ⇒ 不参与，第二就是 80.98
  });

  it('★ 同题材龙位成员：按龙位升序、排除总龙自己、无龙位（创业板）不收', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap);
    expect(c.siblingDragons.map(function(s) { return s.name + '/' + s.rank + '/' + s.isYizi; }))
      .toEqual(['新华文轩/2/false', '皖新传媒/3/true']);   // 总龙自己与「创票」都不在里面
  });

  it('★ 市场总龙二：带上它【今日】的龙位 / 一字（判据由规则层做，采集层只给事实）', () => {
    // [EBB-FIX 第七轮] 候选池已过滤掉无龙位的票 ⇒ 总龙二【必然】有龙位（rank 是数字，不再是 null）
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap);
    expect(c.secondInfo.name).toBe('时代万恒');   // 创票（120）被 [EBB-FIX] 闸门排除
    expect(c.secondInfo.rank).toBe(1);           // 新能源汽车 的龙一
    expect(c.secondInfo.isYizi).toBe(false);
    const c2 = ebbCtxOf(rows, topics, rankMap, D, prev({ 新华传媒: 159.51, 时代万恒: 80.98 }));
    expect(c2.secondInfo.name).toBe('时代万恒');
    expect(c2.secondInfo.rank).toBe(1);          // 新能源汽车 的龙一
  });

  it('全列表一只票都排不出（涨幅全缺）⇒ ready=false（§10 不猜）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, prev({ 某票: 10 }));
    expect(c.ready).toBe(false);
    expect(c.leader).toBe(null);
  });
});
