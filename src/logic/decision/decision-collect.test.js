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
// ★★ [EBB-R20 2026-10-20 用户口径] 总龙与买点侧替补【已换 20日涨幅口径】：
//   用户原话「把原来按照10日涨幅改成20日涨幅选股……从20日涨幅中的总龙一到总龙五选出两只排名靠前的。
//   而且是不同总龙一题材的股票……要判断是不是创业板，科创板，北交所等非主板的股票，如果是先排除，
//   剩下的看是不是和总龙一是同题材，是也排除，剩下的就选排名靠前的那两只。只选好两只，后面不选了」。
// 为什么单测：这个函数决定「谁是市场总龙」—— 排错一位，退潮日就会把【另一只票】当成总龙，
// 进而选出错误的替补 / 可等开盘卖名单。它不报错、只会静默给错名单，所以必须钉死。
// ⚠️ 它读不到的东西（停牌 / 今日占比）在本测试环境里是「未加载」⇒ 恒为 false / null，
//    正是 §10 想要的行为（未知 ⇒ 不判），下面的用例也顺带钉住这一点。
describe('decision-collect · ebbCtxOf（退潮日的事实采集 · 20日涨幅口径）', () => {
  const D = '2026-10-20';

  function row(name, topic, extra) {
    return Object.assign({ name: name, topic: topic, code: '600000' }, extra || {});
  }
  /** prevRangeMap：股票名 → { pct }（昨日十日涨幅；卖点侧总龙二用） */
  function prev(map) {
    const m = new Map();
    Object.keys(map).forEach(function(k) { m.set(k, { pct: map[k], days: 10, updatedAt: '' }); });
    return m;
  }
  /** range20Top：20日涨幅前五（getRange20Leaders 的发布结果形状） */
  function top20(list) {
    return list.map(function(t) {
      return { stock: t[0], code: t[1], pct: t[2], days: t[3] === undefined ? 20 : t[3] };
    });
  }
  function dm(map) {
    const m = new Map();
    Object.keys(map).forEach(function(k) { m.set(k, { rank: map[k], topic: '', groupSize: 0, pct: 20 }); });
    return m;
  }

  // 用户 2026-10-20 的例子（20日涨幅前五）：
  //   总龙一 新华传媒（AI应用）197.82 / 总龙二 九阳股份（大消费）106.51 /
  //   总龙三 新华文轩（AI应用）101.90 / 总龙四 澳弘电子（电子/通信/算力）90.73 /
  //   总龙五 慈文传媒（AI应用）79.41 —— 五只全主板；龙一同题材 = 新华文轩 / 慈文传媒
  const AI = 'AI应用';
  const rows = [
    row('新华传媒', AI, { code: '600825' }),
    row('九阳股份', '大消费', { code: '002242' }),
    row('新华文轩', AI, { code: '601811' }),
    row('澳弘电子', '电子/通信/算力', { code: '605733' }),
    row('慈文传媒', AI, { code: '002343' }),
    row('时代万恒', '新能源汽车', { code: '600241' })
  ];
  const topics = [
    {
      topic: AI, rank: 1, count: 3, yiziCount: 0,
      members: [
        { name: '新华传媒', isYizi: false },
        { name: '新华文轩', isYizi: false },
        { name: '慈文传媒', isYizi: true }
      ]
    },
    { topic: '大消费', rank: 2, count: 1, yiziCount: 0, members: [{ name: '九阳股份', isYizi: false }] },
    { topic: '电子/通信/算力', rank: 3, count: 1, yiziCount: 0, members: [{ name: '澳弘电子', isYizi: false }] },
    { topic: '新能源汽车', rank: 4, count: 1, yiziCount: 0, members: [{ name: '时代万恒', isYizi: false }] }
  ];
  const rankMap = dm({ 新华传媒: 1, 九阳股份: 1, 新华文轩: 2, 澳弘电子: 1, 慈文传媒: 3, 时代万恒: 1 });
  const TOP5 = top20([
    ['新华传媒', '600825', 197.82],
    ['九阳股份', '002242', 106.51],
    ['新华文轩', '601811', 101.90],
    ['澳弘电子', '605733', 90.73],
    ['慈文传媒', '002343', 79.41]
  ]);
  const rangeMap = prev({ 新华传媒: 159.51, 新华文轩: 40, 慈文传媒: 30, 时代万恒: 80.98 });

  it('§10：20日前五没注入 / 空 ⇒ ready=false（⛔ 绝不返回「今天没有总龙」）', () => {
    [null, undefined, []].forEach(function(t) {
      const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, t);
      expect(c.ready).toBe(false);
      expect(c.leader).toBe(null);
      expect(c.second).toBe(null);
      expect(c.siblingDragons).toEqual([]);
      expect(c.secondInfo).toBe(null);
      expect(c.buyPicks).toEqual([]);
    });
  });

  it('★ 市场总龙 = 20日涨幅第一（全市场；topic / 龙位 / 一字都是【今日】的）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5);
    expect(c.ready).toBe(true);
    expect(c.leader.name).toBe('新华传媒');
    expect(c.leader.pct).toBe(197.82);
    expect(c.leader.topic).toBe(AI);
    expect(c.leader.rank).toBe(1);               // 它今日是 AI应用 的龙一
    expect(c.leader.code).toBe('600825');
  });

  it('★★ [EBB-R20] 替补 = 前五里【主板 ∧ 非总龙本人 ∧ 非总龙同题材】取前两只 —— 10-20 用户例子的回归钉', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5);
    // 新华传媒 = 总龙本人（不买）；新华文轩 / 慈文传媒 = 与总龙同题材（排除）⇒ 剩九阳 + 澳弘
    expect(c.buyPicks.map(function(p) { return p.name; })).toEqual(['九阳股份', '澳弘电子']);
    expect(c.buyPicks[0].rank20).toBe(2);
    expect(c.buyPicks[0].pct).toBe(106.51);
    expect(c.buyPicks[0].topic).toBe('大消费');
    expect(c.buyPicks[1].rank20).toBe(4);
    // 五只去留留痕：每一只都有理由，被排除的 picked=false
    expect(c.buyTrail.length).toBe(5);
    const byName = {};
    c.buyTrail.forEach(function(t) { byName[t.name] = t; });
    expect(byName['新华传媒'].picked).toBe(false);
    expect(byName['新华传媒'].reason).toContain('总龙一');
    expect(byName['新华文轩'].picked).toBe(false);
    expect(byName['新华文轩'].reason).toContain('同题材');
    expect(byName['慈文传媒'].picked).toBe(false);
    expect(byName['慈文传媒'].reason).toContain('同题材');
    expect(byName['九阳股份'].picked).toBe(true);
    expect(byName['澳弘电子'].picked).toBe(true);
  });

  it('★★ [EBB-R20] 非主板（创业板 / 科创板 / 北交所）先排除 —— 挤掉的名额【不往下递补出第 3 只】', () => {
    // 用户 10-13 的例子：龙二是创业板 ⇒ 排除；能凑的只剩龙三龙四里符合条件的 —— 只选两只封顶
    const TOP5B = top20([
      ['新华传媒', '600825', 197.82],
      ['创票', '300001', 180.00],
      ['澳弘电子', '605733', 90.73],
      ['时代万恒', '600241', 85.00],
      ['另一票', '688001', 80.00]
    ]);
    const r2 = rows.concat([row('创票', AI, { code: '300001' }), row('另一票', '芯片', { code: '688001' })]);
    const c = ebbCtxOf(r2, topics, rankMap, D, rangeMap, rangeMap, null, TOP5B);
    // 创票（创业板）/ 另一票（科创板）都排除 ⇒ 替补 = 澳弘电子 + 时代万恒（恰好两只）
    expect(c.buyPicks.map(function(p) { return p.name; })).toEqual(['澳弘电子', '时代万恒']);
    // 五只全被排除 / 选满 ⇒ 不超过 2 只（「只选两只，后面不选了」）
    const t2 = {};
    c.buyTrail.forEach(function(t) { t2[t.name] = t; });
    expect(t2['创票'].reason).toContain('非主板');
    expect(t2['另一票'].reason).toContain('非主板');
  });

  it('★★ [EBB-R20] 同题材排除后凑不满两只 ⇒ 就给算得出的（⛔ 不从五只之外乱补）', () => {
    const TOP5C = top20([
      ['新华传媒', '600825', 197.82],
      ['新华文轩', '601811', 101.90],
      ['慈文传媒', '002343', 79.41],
      ['九阳股份', '002242', 60],
      ['创票', '300001', 55.00]
    ]);
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5C);
    expect(c.buyPicks.map(function(p) { return p.name; })).toEqual(['九阳股份']);   // 只有一只
    expect(c.buyPicks.length).toBe(1);
  });

  it('★ 卖点侧总龙二口径【不变】：仍是【昨日十日涨幅第二、有龙位】（prevRangeMap）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5);
    expect(c.second.name).toBe('时代万恒');       // 昨日十日：新华传媒 159.51 → 时代万恒 80.98
    expect(c.secondInfo.name).toBe('时代万恒');
    expect(c.secondInfo.rank).toBe(1);            // 新能源汽车 的龙一
    expect(c.secondInfo.isYizi).toBe(false);
  });

  it('§11：prevRangeMap 没注入 ⇒ 只有 second/secondInfo 为 null，退潮事实本身仍成立（总龙来自20日前五）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, null, null, null, TOP5);
    expect(c.ready).toBe(true);
    expect(c.leader.name).toBe('新华传媒');
    expect(c.second).toBe(null);
    expect(c.secondInfo).toBe(null);
    expect(c.buyPicks.length).toBe(2);            // 替补不依赖 prevRangeMap
  });

  it('★ 同题材龙位成员：按龙位升序、排除总龙自己、无龙位（创业板）不收（口径不变）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5);
    expect(c.siblingDragons.map(function(s) { return s.name + '/' + s.rank + '/' + s.isYizi; }))
      .toEqual(['新华文轩/2/false', '慈文传媒/3/true']);   // 总龙自己与未成组的都不在里面（口径不变）
  });

  it('§10：前五里【一只票的 20日涨幅】都读不到 ⇒ 那只不参排（⛔ 不当 0、更不当没有）', () => {
    const TOP5D = top20([
      ['新华传媒', '600825', null],
      ['九阳股份', '002242', 106.51],
      ['澳弘电子', '605733', 90.73],
      ['时代万恒', '600241', 85.00],
      ['慈文传媒', '002343', 79.41]
    ]);
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5D);
    // 新华传媒无值 ⇒ 总龙顺位到九阳股份（前五里第一个有值的）
    expect(c.leader.name).toBe('九阳股份');
    expect(c.leader.pct).toBe(106.51);
  });

  it('★ [事实③ 首日腿] 不传 prevDate ⇒ prevLeader = null（未知）—— ⛔ 绝不拼一个「假坏状态」', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, null, TOP5);
    expect(c.ready).toBe(true);
    expect(c.prevLeader).toBe(null);
  });

  it('★ [事实③ 首日腿] 传了 prevDate 但库里查不到那只票 ⇒ bad=false（§10：未知 ≠ 昨天停牌）', () => {
    const c = ebbCtxOf(rows, topics, rankMap, D, rangeMap, rangeMap, '2026-10-17', TOP5);
    expect(c.ready).toBe(true);
    expect(c.prevLeader).not.toBe(null);
    // 单测环境没有行情缓存 ⇒ 量 / 占比都取不到 ⇒ 两处都【不判】（而不是判成坏状态）
    expect(c.prevLeader.volume).toBe(null);
    expect(c.prevLeader.suspendedLike).toBe(false);
    expect(c.prevLeader.shareFail).toBe(false);
    expect(c.prevLeader.bad).toBe(false);
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
  // [EBB-R20] 总龙来自 20日前五（本 describe 只钉停牌判据 ⇒ 前五随便给一份让 ebbCtx ready 即可）
  const TOP5 = [{ stock: '新华传媒', code: '600825', pct: 197.82, days: 20 },
    { stock: '新华文轩', code: '601811', pct: 101.90, days: 20 }];
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
    const c = ebbCtxOf(rows, topics, rankMap, HIST, YEST, null, null, TOP5);
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
    expect(ebbCtxOf(rows, topics, rankMap, HIST, YEST, null, null, TOP5).leaderSuspended).toBe(false);
    // ② 有行、量写着非 0
    state._auctionMemCache = { [HIST]: [{ stock: '新华传媒', volume: '1635' }, { stock: '新华文轩', volume: '288' }] };
    expect(ebbCtxOf(rows, topics, rankMap, HIST, YEST, null, null, TOP5).leaderSuspended).toBe(false);
  });

  it('§11：【今天】不走回退腿 —— 上游答不了、量又写着 0 ⇒ 仍判 false（今日路径行为零变化）', () => {
    state._auctionMemCache = {
      [TODAY]: [{ stock: '新华传媒', volume: '0' }, { stock: '新华文轩', volume: '288' }]
    };
    const c = ebbCtxOf(rows, topics, rankMap, TODAY, YEST, null, null, TOP5);
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
    // [SUSPEND-PENDING 2026-10-14 用户实测修] 本用例的**标题**一直是这句原则，修前断言却把
    //   「判不出来」当成了「没停」（返空集）—— 那正是用户报的那个 bug（见下方 SUSPEND-PENDING describe）。
    //   现在按原则断言：今天判定还没到 + 昨天停牌 + 今天库里没有它的行（停牌票上游不返回）
    //   ⇒ 没有「今天在竞价」的正面证据 ⇒ **保守进名单**（宁可少选一只，也不要让买不进的票占龙位）。
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };
    state._auctionMemCache[HIST] = [{ stock: '新华传媒', volume: '0' }];
    expect(nonFirstDaySuspendNames(rows, TODAY, HIST).has('新华传媒')).toBe(true);
  });
});

// ── ★★ [SUSPEND-PENDING 2026-10-14 用户实测修] 「判定还没回来」不得冒充「今天没停牌」 ──────────
//   用户原话：「为什么我从 10 月 13 日切到 10 月 14 日时，还是有新华传媒（停牌）进入买点？
//   你没修复彻底吧？刷新后才显示正常（没有显示新华传媒），只显示龙二，龙三」。
//
//   竞态（本节要钉住的东西）：页面刚打开 / 判定还在路上时，`suspendState` 还是空的。
//     · `isSuspended(今天, 新华传媒)` → false（没判定）
//     · `canJudgeSuspended(今天)` → **true**（上游确实能为今天作证，只是结果没到）
//     ⇒ 旧 `_suspendedOn` 走第②腿直接返 false，消费方读成「**今天没停牌**」的权威否定
//     ⇒ 买不进名单变空集 ⇒ 连续停牌的新华传媒又占了龙一（渲染出一行「龙一 新华传媒 +115%
//        占比 0.000」、而且没有「连续停牌 ⇒ 顺延」说明）；判定回来才自愈 ⇒ 用户看到「时有时无」。
//
//   修法：判据分开 —— 「能判」（canJudgeSuspended）+「判出来没有」（hasSuspendVerdict）；
//     后者为 false 且今天库里没有「成交量 > 0」的正面证据 ⇒ 保守按「买不进」处理（§10 宁缺勿错）。
//   ⚠️ 本 describe 必须用【本地今天】当展示日（pending 分支只在今天生效），历史日走原路径不受影响。
describe('decision-collect · ★★ SUSPEND-PENDING：今天判定未就绪时不得把停牌票放进买点', () => {
  const HIST = '2020-01-01';   // 昨天（= prevDate；固定过去日）
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();
  const rows = [{ name: '新华传媒' }, { name: '新华文轩' }, { name: '东方明珠' }];

  let savedAuction = null;
  let savedHot = null;
  let savedSuspend = null;
  beforeEach(() => {
    savedAuction = state._auctionMemCache;
    savedHot = state._hotFullRowCache;
    savedSuspend = suspendState.value;
    state._auctionMemCache = {};
    state._hotFullRowCache = {};
    // 昨天：新华传媒 / 新华文轩 竞价量 0（停牌），东方明珠 有量
    state._auctionMemCache[HIST] = [
      { stock: '新华传媒', volume: '0' },
      { stock: '新华文轩', volume: '0' },
      { stock: '东方明珠', volume: '470' }
    ];
  });
  afterEach(() => {
    state._auctionMemCache = savedAuction;
    state._hotFullRowCache = savedHot;
    suspendState.value = savedSuspend;
  });

  it('★★ 判定未加载 + 今天库里查不到它（停牌票上游不返回）⇒ 仍进名单（10-14 新华传媒竞态回归钉）', () => {
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };   // 判定还没到
    state._auctionMemCache[TODAY] = [{ stock: '东方明珠', volume: '512' }];        // 今天有行的是别的票

    const set = nonFirstDaySuspendNames(rows, TODAY, HIST);
    expect(set.has('新华传媒')).toBe(true);    // ★ 修前：返空集 ⇒ 它被当普通票选成龙一
    expect(set.has('新华文轩')).toBe(true);    // 同样「昨天停 + 今天无正面证据」⇒ 一起保守跳过
    expect(set.has('东方明珠')).toBe(false);   // 昨天有量 ⇒ 不是连续停牌，不受影响
  });

  it('★ 「暂缓」不是「一律封杀」：今天库里写着成交量 > 0（复牌正面证据）⇒ 放行，⛔ 不误伤复牌票', () => {
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };
    state._auctionMemCache[TODAY] = [{ stock: '新华传媒', volume: '1635' }];       // 今天确实在竞价

    const set = nonFirstDaySuspendNames(rows, TODAY, HIST);
    expect(set.has('新华传媒')).toBe(false);   // 有正面证据 ⇒ 按复牌处理
    expect(set.has('新华文轩')).toBe(true);    // 没有正面证据 ⇒ 保守跳过
  });

  it('★ 判定已就绪（loadedAt > 0）⇒ pending 分支不生效，完全按真实结论（复牌票自然被放回）', () => {
    // 上游判定说：今天只有 新华文轩 停牌（新华传媒已复牌）
    suspendState.value = { date: TODAY, set: new Set(['新华文轩']), version: 1, loadedAt: Date.now() };
    state._auctionMemCache[TODAY] = [{ stock: '新华传媒', volume: '1635' }, { stock: '新华文轩', volume: '0' }];

    const set = nonFirstDaySuspendNames(rows, TODAY, HIST);
    expect(set.has('新华传媒')).toBe(false);   // 复牌 ⇒ 理所当然参与选股（用户原话）
    expect(set.has('新华文轩')).toBe(true);
  });

  it('§11 历史展示日不受影响：canJudgeSuspended(历史日) 恒 false ⇒ pending 分支永不触发', () => {
    // 状态挂在【今天】上（说明确实「今天已有结论」），但展示日是历史日 ⇒ 行为与修前逐字一致
    suspendState.value = { date: TODAY, set: new Set([]), version: 1, loadedAt: Date.now() };
    state._auctionMemCache[HIST] = [{ stock: '新华传媒', volume: '0' }];
    // 历史日：新华传媒 昨天(=HIST 自己当 prevDate 时)在、今天(=HIST)量 0 ⇒ 两天都停 ⇒ 进名单（原路径）
    expect(nonFirstDaySuspendNames(rows, HIST, HIST).has('新华传媒')).toBe(true);
  });
});
