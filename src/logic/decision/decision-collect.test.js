// decision-collect.test.js — 「停牌判定的名单出口」suspendEntriesOf 的单测
// （§15 独立业务模块 / §6 单一真相：三个选股看板都从这里拿名单，⛔ 谁都不许自己再遍历一遍）
//
// 为什么要单测：这个函数是「看板上到底会不会出现停牌标」的第一道闸门 ——
//   买点票漏收 ⇒ 那只停牌票不标；形态认错（只读 .picks、不认数组）⇒ 整侧不标。
//   两种都不会报错，只会静默少一枚标签，所以必须钉死。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { suspendEntriesOf, ebbCtxOf, nonFirstDaySuspendNames } from './decision-collect.js';
import { ensureSuspendSet, suspendState } from '../auction/suspend.js';
import { state } from '../app-state.js';

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

  // ── ★ [EBB-R8 第八轮 2026-10-14] 两个新事实 ────────────────────────────────────────────
  //   用户口径（首日闸门）：「市场总龙头【首日】出现停牌或者占比不达标……才有效，
  //     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
  //   用户口径（买点侧唯一那只）：「买点只有一个，那就是市场的龙二……是整个早盘竞价看板的
  //     股票列表中的十日涨幅排名第二的龙二，就像今天的九阳股份（市场排名十日涨幅 86%，
  //     总列表排名第二）」。
  it('★ [事实③ 首日腿] 不传 prevDate ⇒ prevLeader = null（未知）—— ⛔ 绝不拼一个「假坏状态」', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap);
    expect(c.ready).toBe(true);
    expect(c.prevLeader).toBe(null);
  });

  it('★ [事实③ 首日腿] 传了 prevDate 但库里查不到那只票 ⇒ bad=false（§10：未知 ≠ 昨天停牌）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, '2026-10-10');
    expect(c.ready).toBe(true);
    expect(c.prevLeader).not.toBe(null);
    // 单测环境没有行情缓存 ⇒ 量 / 占比都取不到 ⇒ 两处都【不判】（而不是判成坏状态）
    expect(c.prevLeader.volume).toBe(null);
    expect(c.prevLeader.suspendedLike).toBe(false);
    expect(c.prevLeader.shareFail).toBe(false);
    expect(c.prevLeader.bad).toBe(false);
  });

  it('★ [事实④ 买点侧那只] 当日十日涨幅排名【第二】= 跳过总龙自己后最靠前的那只', () => {
    // 当日（rangeMap）口径与昨日（prevRangeMap）是两份不同的 map：
    //   新华传媒 135.96（总龙自己，第一）/ 时代万恒 76.16 / 新华文轩 38.26
    const today = prev({ 新华传媒: 135.96, 时代万恒: 76.16, 新华文轩: 38.26, 创票: 200 });
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, today);
    expect(c.buySecond).not.toBe(null);
    // ⛔ 不是新华传媒（它自己就是被判定退潮的那只总龙，本来不买）⇒ 顺位到 76.16
    expect(c.buySecond.name).toBe('时代万恒');
    expect(c.buySecond.pct).toBe(76.16);
    expect(c.buySecond.code).toBe('600241');
    expect(c.buySecond.rank).toBe(1);            // 新能源汽车的龙一
    // ⛔ 创票 200 更高，但创业板无龙位 ⇒ 不参排（与总龙同一把尺子）
    expect(c.buySecond.name).not.toBe('创票');
  });

  it('§10：[事实④] 当日涨幅 map 没注入 / 空 ⇒ buySecond = null（⛔ 绝不拿昨日口径顶替）', () => {
    [null, undefined, new Map()].forEach(function(t) {
      const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, t);
      expect(c.ready).toBe(true);       // 退潮事实本身仍成立
      expect(c.buySecond).toBe(null);
    });
  });
});

// ── ★★ [EBB-R8b 2026-10-14 实测修] 停牌判据的【历史日回退腿】──────────────────────────────
//   实测事故（浏览器端到端：真实 10-13 云端数据 + 本地构建产物 + 无头 Chrome/CDP，2026-10-14 跑）：
//     回看 10-13 时总龙【新华传媒】当天确实停牌（库里 10-13 那一行竞价量 = 0），
//     但 `isSuspended('2026-10-13', …)` 恒 false —— 上游两个快照接口【只有当日数据】
//     （见 suspend.js#canJudgeSuspended）。于是判据①不成立、占比又缺 ⇒ ebb = null
//     ⇒ 退潮首日整套（买点灰化 / 退潮不买 / 唯一买点龙二 / 退潮横幅）全部静默失效。
//     ⚠️ 这正是用户反复报的「没生效」同一类事故；而它在**当天**看不出来（当天 leg① 有效）。
//   修法：停牌判据两腿 —— ① 上游快照（仅当 `canJudgeSuspended(date)` 为真，即 date 就是今天）；
//     ② 回退【该日该票自己的竞价行】：竞价量 = 0 ⇒ 那天没参与集合竞价（停牌语义）。
describe('decision-collect · ebbCtxOf · 停牌判据（上游只有当日 ⇒ 历史日回退库内竞价行）', () => {
  const HIST = '2026-10-13';   // 历史日：它 ≠ 本地「今天」⇒ 上游快照对这一天无效
  function row(name, topic, extra) {
    return Object.assign({ name: name, topic: topic, code: '600000' }, extra || {});
  }
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
  const AI = 'AI应用';
  const rows = [row('新华传媒', AI, { code: '600825' }), row('新华文轩', AI, { code: '601811' })];
  const topics = [{
    topic: AI, rank: 1, count: 2, yiziCount: 0,
    members: [{ name: '新华传媒', isYizi: false }, { name: '新华文轩', isYizi: false }]
  }];
  const rankMap = dm({ 新华传媒: 1, 新华文轩: 2 });
  const YEST = prev({ 新华传媒: 159.51, 新华文轩: 65.47 });
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();

  // 行情缓存的桩：本用例只碰这两格，用完原样还原（⛔ 不污染其它用例）
  let savedAuction = null;
  let savedHot = null;
  beforeEach(() => {
    savedAuction = state._auctionMemCache;
    savedHot = state._hotFullRowCache;
    state._auctionMemCache = {};
    state._hotFullRowCache = {};
  });
  afterEach(() => {
    state._auctionMemCache = savedAuction;
    state._hotFullRowCache = savedHot;
  });

  it('★ 历史日：库里该票当日竞价量 = 0 ⇒ leaderSuspended = true（10-13 新华传媒事故的回归钉）', () => {
    state._auctionMemCache = {
      [HIST]: [{ stock: '新华传媒', volume: '0' }, { stock: '新华文轩', volume: '288' }]
    };
    const c = ebbCtxOf(rows, topics, rankMap, HIST, YEST);
    expect(c.ready).toBe(true);
    expect(c.leader.name).toBe('新华传媒');
    expect(c.leaderSuspended).toBe(true);                    // ★ 修好之前这里恒 false ⇒ 退潮整体失效
    // 同题材龙位（新华文轩）那一天有竞价量 ⇒ 不算停牌（⛔ 别把「有量」也判成停牌）
    expect(c.siblingDragons[0].name).toBe('新华文轩');
    expect(c.siblingDragons[0].suspended).toBe(false);
  });

  it('§10：历史日【取不到】该票那一行 ⇒ 不判停牌（未知 ≠ 停牌）；写的是非 0 ⇒ 同样不判', () => {
    // ① 库里根本没这一天这只票的行
    state._auctionMemCache = { [HIST]: [{ stock: '新华文轩', volume: '288' }] };
    expect(ebbCtxOf(rows, topics, rankMap, HIST, YEST).leaderSuspended).toBe(false);
    // ② 有行、量写着非 0
    state._auctionMemCache = { [HIST]: [{ stock: '新华传媒', volume: '1635' }, { stock: '新华文轩', volume: '288' }] };
    expect(ebbCtxOf(rows, topics, rankMap, HIST, YEST).leaderSuspended).toBe(false);
  });

  it('§11：【今天】不走回退腿 —— 上游答不了、量又写着 0 ⇒ 仍判 false（今日路径行为零变化）', () => {
    state._auctionMemCache = {
      [TODAY]: [{ stock: '新华传媒', volume: '0' }, { stock: '新华文轩', volume: '288' }]
    };
    const c = ebbCtxOf(rows, topics, rankMap, TODAY, YEST);
    expect(c.leaderSuspended).toBe(false);
  });
});

// ── ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「连续停牌 ⇒ 买不进」的名单出口 ─────────────
//   用户原话：「10月14日的新华传媒是停牌（非首日），不应该选进买点侧……停牌首日可选入（已实现），
//     次日还是停牌……就不要选进去了，相当于一字买不进……退到龙二，龙三」。
//   口径：今天停 ∧ 昨天停 ⇒ 进名单（买点侧跳过并顺延）；只停一天（首日）/ 今天复牌 ⇒ 不进名单。
//   ⛔ 判据不新建：两腿都用本文件唯一的 _suspendedOn（§6），与退潮判定同一把尺子。
describe('decision-collect · nonFirstDaySuspendNames（连续停牌第 2 天及以上的「买不进」名单）', () => {
  // ⚠️ 两个日期都必须是【非本地今天】的历史日，才会走 _suspendedOn 的第②腿（库内竞价行）；
  //    沿用本文件既有的「历史日」约定（HIST = 2026-10-13 ≠ 本地今天，见上一 describe）。
  const D = '2026-10-13';   // 展示日（模拟「今天」）
  const P = '2026-10-10';   // 上一交易日（模拟「昨天」）

  let savedAuction = null;
  let savedHot = null;
  beforeEach(() => {
    savedAuction = state._auctionMemCache;
    savedHot = state._hotFullRowCache;
    state._auctionMemCache = {};
    state._hotFullRowCache = {};
  });
  afterEach(() => {
    state._auctionMemCache = savedAuction;
    state._hotFullRowCache = savedHot;
  });

  const rows = [{ name: '新华传媒' }, { name: '新华文轩' }, { name: '东方明珠' }];
  // 构库内竞价行缓存：值 '' / undefined ⇒ 该日该票【没有行】（§10 场景）
  function cache(today, prev) {
    const mk = function(m) {
      return Object.keys(m).filter(function(k) { return m[k] !== '' && m[k] != null; })
        .map(function(k) { return { stock: k, volume: m[k] }; });
    };
    const c = {};
    if (today) c[D] = mk(today);
    if (prev) c[P] = mk(prev);
    return c;
  }

  it('★ 连续停牌（今天停 ∧ 昨天停）⇒ 进名单（10-14 新华传媒事故的回归钉）', () => {
    state._auctionMemCache = cache(
      { 新华传媒: '0', 新华文轩: '288', 东方明珠: '512' },
      { 新华传媒: '0', 新华文轩: '333', 东方明珠: '470' }
    );
    expect(nonFirstDaySuspendNames(rows, D, P)).toEqual(new Set(['新华传媒']));
  });

  it('★ 首日停牌（今天停 ∧ 昨天有量）⇒ ⛔ 不进名单（用户：「昨日还可以入选因为是首日停牌」）', () => {
    state._auctionMemCache = cache(
      { 新华传媒: '0', 新华文轩: '288' },
      { 新华传媒: '1635', 新华文轩: '333' }
    );
    expect(nonFirstDaySuspendNames(rows, D, P).size).toBe(0);
  });

  it('★ 复牌（今天有竞价量）⇒ ⛔ 不进名单（用户：「有成交量、占比，选进去理所当然」）', () => {
    state._auctionMemCache = cache(
      { 新华传媒: '1200', 新华文轩: '288' },
      { 新华传媒: '0', 新华文轩: '333' }
    );
    expect(nonFirstDaySuspendNames(rows, D, P).size).toBe(0);
  });

  it('§10：昨天那一行【取不到】⇒ 不算「昨天停牌」⇒ 不进名单（未知 ≠ 停牌）', () => {
    // 今天量 0，但昨天根本没有这只票的行（停牌票上游不返回 ⇒ 常见形态）
    state._auctionMemCache = cache({ 新华传媒: '0', 新华文轩: '288' }, { 新华文轩: '333' });
    expect(nonFirstDaySuspendNames(rows, D, P).size).toBe(0);
  });

  it('§10：prevDate / date 任一缺失 ⇒ 返空集（安全降级，⛔ 绝不猜到「连续停牌」）', () => {
    state._auctionMemCache = cache({ 新华传媒: '0' }, { 新华传媒: '0' });
    expect(nonFirstDaySuspendNames(rows, D, null).size).toBe(0);
    expect(nonFirstDaySuspendNames(rows, null, P).size).toBe(0);
    expect(nonFirstDaySuspendNames(rows, '', '').size).toBe(0);
    expect(nonFirstDaySuspendNames(rows, undefined, undefined).size).toBe(0);
  });

  it('rows 为 null / 空 / 无 name 的行：不抛错，返空集', () => {
    state._auctionMemCache = cache({ 新华传媒: '0' }, { 新华传媒: '0' });
    expect(nonFirstDaySuspendNames(null, D, P).size).toBe(0);
    expect(nonFirstDaySuspendNames([], D, P).size).toBe(0);
    expect(nonFirstDaySuspendNames([{ code: '600825' }, null], D, P).size).toBe(0);
  });

  it('多只混合：只有「两天都停」的那只进名单（首日 / 复牌 一律不进）', () => {
    state._auctionMemCache = cache(
      { 新华传媒: '0', 新华文轩: '0', 东方明珠: '512' },
      { 新华传媒: '0', 新华文轩: '333', 东方明珠: '0' }
    );
    // 新华传媒 = 两天都停 ⇒ 进；新华文轩 = 昨天有量（首日）⇒ 不进；东方明珠 = 今天有量（复牌）⇒ 不进
    expect(nonFirstDaySuspendNames(rows, D, P)).toEqual(new Set(['新华传媒']));
  });

  it('§6 单一真相：昨天 leg 与退潮判定同一把尺子 —— 量写着非数字（'-'）⇒ 判不出 ⇒ 不算停', () => {
    state._auctionMemCache = cache({ 新华传媒: '0' }, { 新华传媒: '-' });
    expect(nonFirstDaySuspendNames(rows, D, P).size).toBe(0);
  });
});

// ── ★★ [SUSPEND-STALE 2026-10-14 用户实测回归] 端到端钉住用户报的那条路径 ──────────────
//   用户原话：「为什么我从 10 月 13 日切到 10 月 14 日时，还是有新华传媒（停牌）进入买点？
//   你没修复彻底吧？刷新后才显示正常，只显示龙二，龙三。」
//   根因 = 看板切到【历史日】时，`ensureSuspendSet(历史日, …)` 会把「今天」那份上游判定整个清空
//     ⇒ 「今天停没停」这条腿塌成 false（而 `canJudgeSuspended(今天)` 恒 true ⇒ 被读成权威否定）
//     ⇒ 买不进名单变空集 ⇒ 停牌票又被选成龙一。修法见 suspend.js#ensureSuspendSet（历史日一律不碰状态）。
//   ⚠️ 本用例必须【真调】ensureSuspendSet（⛔ 不手写夹具替身）—— 上一轮的教训就是夹具替身漏掉了
//      「真实链路能不能产出该结论」。
describe('decision-collect · ★★ 回归：切历史日看一眼后，今天的「买不进名单」必须还在', () => {
  const HIST = '2020-01-01';   // 历史日（固定过去日；⛔ 别用 2026-10-13，免得哪天正好是今天）
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();
  const rows = [{ name: '新华传媒' }, { name: '新华文轩' }];

  let savedAuction = null;
  let savedHot = null;
  let savedSuspend = null;
  beforeEach(() => {
    savedAuction = state._auctionMemCache;
    savedHot = state._hotFullRowCache;
    savedSuspend = suspendState.value;
    state._auctionMemCache = {};
    state._hotFullRowCache = {};
  });
  afterEach(() => {
    state._auctionMemCache = savedAuction;
    state._hotFullRowCache = savedHot;
    suspendState.value = savedSuspend;
  });

  it('★★ 今天有上游判定（新华传媒停牌）+ 昨天竞价量 0 ⇒ 切到历史日再切回来，它仍在名单里', async () => {
    // ① 今天那份判定已加载（注入 = 上游 fuyao 快照的真值）
    suspendState.value = { date: TODAY, set: new Set(['新华传媒']), version: 1, loadedAt: Date.now() };
    // ② 昨天（= 名单里传的 prevDate）那一行竞价量写着 0（10-13 库内真值）
    state._auctionMemCache[HIST] = [{ stock: '新华传媒', volume: '0' }, { stock: '新华文轩', volume: '288' }];

    // ③ 用户切到历史日看一眼（看板会对【展示日】调 ensureSuspendSet）
    await ensureSuspendSet(HIST, [{ name: '新华传媒', code: '600825' }]);

    // ④ 再切回今天 ⇒ 名单必须仍然收它（修前：这里变空集 ⇒ 停牌票又进买点）
    const set = nonFirstDaySuspendNames(rows, TODAY, HIST);
    expect(set.has('新华传媒')).toBe(true);
    expect(set.has('新华文轩')).toBe(false);
    expect(suspendState.value.date).toBe(TODAY);   // ★ 今天的判定没被历史日顶掉
  });

  it('§6 机制说明：今天这条腿只能靠上游（该票当天不在 watchlist ⇒ 库内无行 ⇒ 判不出来也不该当「没停」）', () => {
    // 今天判定缺失（未加载）时：库里今天没有它的行（停牌票上游不返回）⇒ 两腿都取不到 ⇒ 不进名单（§10）
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };
    state._auctionMemCache[HIST] = [{ stock: '新华传媒', volume: '0' }];
    expect(nonFirstDaySuspendNames(rows, TODAY, HIST).size).toBe(0);
  });
});
