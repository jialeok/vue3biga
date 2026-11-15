// leader-divergence.test.js — 「市场总龙一 · 首次分歧」判定的纯函数单测
//
// 口径锚点（2026-10-20 用户原话）：
//   · 首板 = 20 日窗口内第一个收盘涨停日；首板之前的小阴小阳不算分歧；
//   · 首次分歧 = 首板后第一个竞价涨幅 < 0 的日子（新华传媒 11 连板后 10-19 低开 -1.06%）；
//   · 分歧转一致 = 分歧日后的涨停日（九阳 10-13 低开 → 10-16 涨停）；再低开 = 二次分歧，依次类推。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildLeaderDivergence, pickDivergeFollowers, shouldGateBuySide } from './leader-divergence.js';
import { makeCoreTopicResolver } from '../topic/core-category.js';
import { sameTopicText } from '../decision/decision-collect.js';

/** 便捷构造：{ 'YYYY-MM-DD': [closePct, openPct] } → 两份 Map（键 = YYYYMMDD） */
function mkBars(spec) {
  const pct = new Map();
  const open = new Map();
  Object.keys(spec).forEach(function(d) {
    const ymd = d.replace(/-/g, '');
    const c = spec[d][0];
    const o = spec[d][1];
    pct.set(ymd, c);
    open.set(ymd, (o === null || o === undefined) ? null : o);
  });
  return { pct: pct, open: open };
}
const DATES = [
  '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22',
  '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30',
  '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
  '2026-10-19', '2026-10-20'
];

describe('tvrb · [DIVERGE] buildLeaderDivergence（首板 / 首次分歧 / 分歧转一致）', function() {
  it('★ 新华传媒场景：9-21 首板起 11 连板（竞价全高开）⇒ 10-19 低开 = 首次分歧', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });           // 首板前：小阳线
    spec['2026-09-21'] = [10.02, 5.10];                             // 首板（主板 10% 涨停）
    for (const d of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28',
      '2026-09-29', '2026-09-30', '2026-10-09', '2026-10-12', '2026-10-13',
      '2026-10-14', '2026-10-15', '2026-10-16']) {
      spec[d] = [10.01, 6.00];                                      // 连板（竞价全 > 0）
    }
    spec['2026-10-19'] = [-3.2, -1.06];                             // 低开 -1.06% = 首次分歧
    spec['2026-10-20'] = [2.0, 1.0];
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '新华传媒', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.ready).toBe(true);
    expect(v.canJudge).toBe(true);
    expect(v.firstBoardYmd).toBe('20260921');
    expect(v.firstDivergenceYmd).toBe('20261019');
    expect(v.todayFirstDivergence).toBe(true);
    expect(v.todayAucPct).toBeCloseTo(-1.06, 5);
    const ev = v.events.filter(function(e) { return e.ymd === '20261019'; })[0];
    expect(ev.kind).toBe('diverge');
  });

  it('★ 九阳股份场景（非一字龙头）：9-28 首板、10-13 首次低开、10-16 涨停=分歧转一致、再低开=二次分歧', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.2, 0.6]; });           // 首板前：小阴小阳（不算分歧）
    spec['2026-09-28'] = [10.01, 3.20];                             // 首板
    spec['2026-09-29'] = [10.02, 6.00];                             // 二板
    spec['2026-09-30'] = [3.00, 1.00];
    spec['2026-10-09'] = [2.00, 1.10];
    spec['2026-10-12'] = [1.50, 0.80];
    spec['2026-10-13'] = [-2.00, -0.50];                            // 首次分歧（低开）
    spec['2026-10-14'] = [-1.00, 0.30];
    spec['2026-10-15'] = [0.50, 0.20];
    spec['2026-10-16'] = [10.01, 1.00];                             // 分歧转一致（涨停）
    spec['2026-10-19'] = [-1.50, -0.96];                            // 二次分歧（转一致后再低开）
    spec['2026-10-20'] = [10.02, 1.00];                             // 二次分歧转一致
    const bars = mkBars(spec);
    const v13 = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '002242', name: '九阳股份', viewDate: '2026-10-13', todayAucPct: null
    });
    expect(v13.canJudge).toBe(true);
    expect(v13.firstBoardYmd).toBe('20260928');
    expect(v13.firstDivergenceYmd).toBe('20261013');
    expect(v13.todayFirstDivergence).toBe(true);                    // 首板前的小阴小阳一概不算 ⇒ 10-13 就是「首次」
    // 换个展示日：10-19 = 二次分歧（⛔ 不是「首次」）
    const v19 = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '002242', name: '九阳股份', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v19.todayFirstDivergence).toBe(false);
    expect(v19.firstDivergenceYmd).toBe('20261013');
    // 事件流留痕：分歧 → 转一致 → 二次分歧 → 二次转一致
    const kinds = v19.events.map(function(e) { return e.kind; });
    expect(kinds).toContain('diverge');
    expect(kinds).toContain('consensus');
    expect(v19.events.filter(function(e) { return e.kind === 'diverge'; }).map(function(e) { return e.ymd; }))
      .toEqual(['20261013', '20261019']);
    expect(v19.events.filter(function(e) { return e.kind === 'consensus'; }).map(function(e) { return e.ymd; }))
      .toEqual(['20260928', '20260929', '20261016', '20261020']);
  });

  it('★ 窗口内没有涨停 ⇒ 没有锚点，判不出（⛔ 不把小阴小阳的低开当分歧）', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, -0.5]; });          // 天天低开但从未涨停
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '某票', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.ready).toBe(true);
    expect(v.canJudge).toBe(false);
    expect(v.todayFirstDivergence).toBe(false);
  });

  it('★ 展示日竞价涨幅取不到（无行情行 + K线缺 open）⇒ 判不出（§10）', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });
    spec['2026-09-21'] = [10.02, 5.10];
    spec['2026-10-19'] = [-3.2, null];                              // K 线有 bar 但没 open_price
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '某票', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.canJudge).toBe(false);
  });

  it('★ 中间日缺 open（无法证明「那天没有低开」）⇒ 「首次」链路判不出（§10 宁缺勿错）', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });
    spec['2026-09-21'] = [10.02, 5.10];
    spec['2026-10-12'] = [10.01, null];                             // 连板中段一根没 open
    spec['2026-10-19'] = [-3.2, -1.06];
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '某票', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.canJudge).toBe(false);
  });

  it('★ 停牌日（K线缺 bar）不算分歧日，不影响「首次」判定', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });
    spec['2026-09-21'] = [10.02, 5.10];
    DATES.forEach(function(d) {
      if (d >= '2026-09-22' && d <= '2026-10-16') spec[d] = [10.01, 6.00];
    });
    delete spec['2026-10-12'];                                      // 停牌一天（无 bar）
    spec['2026-10-19'] = [-3.2, -1.06];
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '某票', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.canJudge).toBe(true);
    expect(v.todayFirstDivergence).toBe(true);
  });

  it('★ 展示日行情行的竞价涨幅优先于 K 线 open（todayAucPct 入参）', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });
    spec['2026-09-21'] = [10.02, 5.10];
    spec['2026-10-19'] = [-3.2, -1.50];
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '600825', name: '某票', viewDate: '2026-10-19', todayAucPct: -1.06
    });
    expect(v.todayAucPct).toBeCloseTo(-1.06, 5);
    expect(v.todayFirstDivergence).toBe(true);
  });

  it('★ 创业板 20% 涨停也能识别首板（涨停幅度按板块，与连板同一把尺子）', function() {
    const spec = {};
    DATES.forEach(function(d) { spec[d] = [1.5, 0.8]; });
    spec['2026-09-25'] = [19.92, 8.00];                             // 创业板涨停（20% 档）
    spec['2026-10-19'] = [-3.2, -1.06];
    const bars = mkBars(spec);
    const v = buildLeaderDivergence({
      pctByYmd: bars.pct, openPctByYmd: bars.open, dates: DATES,
      code: '300001', name: '某创', viewDate: '2026-10-19', todayAucPct: null
    });
    expect(v.firstBoardYmd).toBe('20260925');
    expect(v.todayFirstDivergence).toBe(true);
  });
});

describe('tvrb · [DIVERGE] pickDivergeFollowers（分歧日跟随高标 ≤2 只）', function() {
  // 复刻用户 10-19 实例：总龙三同题材淘汰、总龙五非主板淘汰 ⇒ 总龙二 + 总龙四 入选
  const top5 = [
    { name: '新华传媒', code: '600825', topic: 'AI应用', rank20: 1, pct: 210.98 },
    { name: '澳弘电子', code: '605733', topic: '电子/通信/算力', rank20: 2, pct: 117.38 },
    { name: '新华文轩', code: '601811', topic: 'AI应用', rank20: 3, pct: 116.68 },
    { name: '九阳股份', code: '002242', topic: '大消费', rank20: 4, pct: 91.89 },
    { name: '莱美药业', code: '300006', topic: '医药', rank20: 5, pct: 79.10 }
  ];
  it('★ 同题材淘汰 + 非主板淘汰 + 取前二（10-19 实例：澳弘电子 + 九阳股份）', function() {
    const r = pickDivergeFollowers(top5, '新华传媒', 'AI应用');
    expect(r.followers.map(function(c) { return c.name; })).toEqual(['澳弘电子', '九阳股份']);
    const trail = {};
    r.trail.forEach(function(t) { trail[t.name] = t; });
    expect(trail['新华文轩'].picked).toBe(false);
    expect(trail['新华文轩'].reason).toContain('同题材');
    expect(trail['莱美药业'].picked).toBe(false);
    expect(trail['莱美药业'].reason).toContain('非主板');
  });
  it('★ 前二到五都同题材 ⇒ 只剩总龙一（followers 空）；题材解析不到 ⇒ 保守排除并留痕', function() {
    const sameTopic5 = [
      { name: '甲一', code: '600001', topic: 'AI应用', rank20: 1, pct: 200 },
      { name: '乙一', code: '600002', topic: 'AI应用', rank20: 2, pct: 100 },
      { name: '丙一', code: '600003', topic: 'AI应用', rank20: 3, pct: 90 }
    ];
    const r1 = pickDivergeFollowers(sameTopic5, '甲一', 'AI应用');
    expect(r1.followers.length).toBe(0);
    const noTopic5 = [
      { name: '甲一', code: '600001', topic: '', rank20: 1, pct: 200 },
      { name: '乙一', code: '600002', topic: '', rank20: 2, pct: 100 }
    ];
    const r2 = pickDivergeFollowers(noTopic5, '甲一', '');
    expect(r2.followers.length).toBe(0);
    expect(r2.trail[0].reason).toContain('题材解析不到');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ★★ [DIVERGE-TOPIC 2026-11-15 用户「10-19 新华文轩不该选，它也是 AI应用 大类」]
//   真实库形态（.tmpdiag/_xhw-1019.mjs 只读实测，⛔ 不用夹具臆造）：
//     stock_topics.新华传媒 = 「文化传媒」
//     stock_topics.新华文轩 = 「文化传媒,人工智能,平台经济,体育产业」
//     core_topics.AI应用.synonyms 含「人工智能」「文化传媒」「传媒」
//   🔴 上面那组 10-19 夹具把两只票都写成【已归一的 'AI应用'】⇒ 与真实细分串形态不符
//      ⇒ 假绿，锁不住「单向切分 + 分歧块漏传 coreRes」这两个真 bug。
//   ⇒ 本组一律用【细分题材串】，并显式注入 coreRes 复刻线上调用链。
// ════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [DIVERGE-TOPIC] 细分题材串 + 大类归一（10-19 新华文轩误选回归）', function() {
  const CORES = [
    { name: 'AI应用', synonyms: ['人工智能', '文化传媒', '传媒', '游戏'] },
    { name: '大消费', synonyms: ['平台经济', '零售'] }
  ];
  const coreRes = makeCoreTopicResolver(CORES);
  const realTop5 = [
    { name: '新华传媒', code: '600825', topic: '文化传媒', rank20: 1, pct: 210.98 },
    { name: '善水科技', code: '301190', topic: '化工', rank20: 2, pct: 208.31 },
    { name: '澳弘电子', code: '605058', topic: '电子/通信/算力', rank20: 3, pct: 117.38 },
    { name: '新华文轩', code: '601811', topic: '文化传媒,人工智能,平台经济,体育产业', rank20: 4, pct: 116.68 },
    { name: '九阳股份', code: '002242', topic: '大消费', rank20: 5, pct: 91.89 }
  ];
  const trailOf = function (r) {
    const m = {};
    r.trail.forEach(function (t) { m[t.name] = t; });
    return m;
  };

  it('① 双向分段：不传 coreRes 时，共有「文化传媒」也必须判同题材 ⇒ 排除', function() {
    const r = pickDivergeFollowers(realTop5, '新华传媒', '文化传媒');
    expect(trailOf(r)['新华文轩'].picked).toBe(false);
    expect(trailOf(r)['新华文轩'].reason).toContain('同题材');
  });

  it('② 大类归一：留痕印【AI应用】而不是细分串，用户能自核「为什么算同题材」', function() {
    const r = pickDivergeFollowers(realTop5, '新华传媒', '文化传媒', coreRes);
    expect(trailOf(r)['新华文轩'].picked).toBe(false);
    expect(trailOf(r)['新华文轩'].reason).toContain('AI应用');
  });

  it('③ 细分写法不同但大类相同 ⇒ 仍判同题材（用户「按题材数量也该归 AI应用」）', function() {
    const one = [
      { name: '总龙', code: '600001', topic: 'AI应用', rank20: 1, pct: 200 },
      { name: '文化票', code: '600002', topic: '文化传媒,游戏', rank20: 2, pct: 100 }
    ];
    // 不归一 ⇒ 只能判「不同题材」⇒ 入选；传了 coreRes ⇒ 同属 AI应用 ⇒ 排除
    expect(pickDivergeFollowers(one, '总龙', 'AI应用').followers.map(function(c) { return c.name; }))
      .toEqual(['文化票']);
    expect(pickDivergeFollowers(one, '总龙', 'AI应用', coreRes).followers.length).toBe(0);
  });

  it('④ 10-19 真实形态：新华文轩不再入选，不同题材主板票照常入选', function() {
    const r = pickDivergeFollowers(realTop5, '新华传媒', '文化传媒', coreRes);
    expect(r.followers.map(function(c) { return c.name; })).toEqual(['澳弘电子', '九阳股份']);
    expect(trailOf(r)['善水科技'].reason).toContain('非主板');
  });

  it('⑤ sameTopicText：双向、空串（§10）、可选大类归一', function() {
    expect(sameTopicText('文化传媒', '文化传媒,人工智能')).toBe(true);
    expect(sameTopicText('文化传媒,人工智能', '文化传媒')).toBe(true);   // 旧实现恒 false
    expect(sameTopicText('文化传媒', '大消费')).toBe(false);
    expect(sameTopicText('', '文化传媒')).toBe(false);
    expect(sameTopicText('文化传媒', '')).toBe(false);
    expect(sameTopicText('文化传媒', 'AI应用')).toBe(false);             // 不归一 ⇒ 不同
    expect(sameTopicText('文化传媒', 'AI应用', coreRes)).toBe(true);     // 归一 ⇒ 同
    // 🔴 光接大类归一也修不好：第二串仍是多段 ⇒ 必须同时双向分段
    expect(sameTopicText('AI应用', 'AI应用,体育产业,大消费', coreRes)).toBe(true);
  });

  it('⑥ 静态锁：分歧块必须把 coreRes 传下去（10-22 给别处接了，唯独这里漏了）', function() {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    const blocks = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    expect(plan).toContain('_buildDivergeBuyBlock(ld, list, fOpts, coreRes)');
    expect(blocks).toContain("pickDivergeFollowers(ld.top5 || [], ld.leaderName, ld.leaderTopic || '', coreRes)");
  });
});

// ============================================================================
// ★★ [DIVERGE-GATE 2026-10-24] shouldGateBuySide —— 买点侧「该不该先挂占位」的唯一判据
//   用户 2026-10-21 原话：「刚开始显示的是以前旧规则的票，后面停顿了几秒钟，才出现那个提示词
//     分歧的信息板……我做决定很快，万一哪天它没跳转，我不就买错股票了？所以要修复下。」
//   用户 2026-10-24 追问：「为什么这个提示总是过很久才显示出来，有时显示出来了结果，之后又变成
//     这样了，不是很稳定……计算判断有那么久吗？要再优化下」
//   ⇒ 判据必须可回放：结论落地必放行 / 事实就绪按竞价涨幅判 / 今天只认预热猜测。
// ============================================================================
describe('tvrb · [DIVERGE-GATE] shouldGateBuySide（占位门控）', function() {
  const base = {
    verdictReady: false, ebbCtxReady: true, ebb: false,
    leaderSuspended: false, leaderAucPct: -1.06, isToday: true, guessFirst: false
  };
  const q = function(patch) { return Object.assign({}, base, patch || {}); };

  it('① 判定已落地 ⇒ 永不挂占位（哪怕结论是「判不出」）', function() {
    expect(shouldGateBuySide(q({ verdictReady: true }))).toBe(false);
    expect(shouldGateBuySide(q({ verdictReady: true, ebbCtxReady: false, isToday: true }))).toBe(false);
  });

  it('② 事实就绪：总龙低开 ⇒ 挂', function() {
    expect(shouldGateBuySide(q({ leaderAucPct: -0.01 }))).toBe(true);
  });

  it('② 事实就绪：总龙高开 / 平开 ⇒ 不挂（绝大多数日子，零体验损失）', function() {
    expect(shouldGateBuySide(q({ leaderAucPct: 3.2 }))).toBe(false);
    expect(shouldGateBuySide(q({ leaderAucPct: 0 }))).toBe(false);
  });

  it('② §10：总龙竞价涨幅取不到（null / NaN）⇒ 保守挂（未知 ≠ 没分歧）', function() {
    expect(shouldGateBuySide(q({ leaderAucPct: null }))).toBe(true);
    expect(shouldGateBuySide(q({ leaderAucPct: undefined }))).toBe(true);
    expect(shouldGateBuySide(q({ leaderAucPct: NaN }))).toBe(true);
  });

  it('② 退潮日 / 总龙停牌 ⇒ 走不到分歧买点 ⇒ 不挂', function() {
    expect(shouldGateBuySide(q({ ebb: true }))).toBe(false);
    expect(shouldGateBuySide(q({ leaderSuspended: true }))).toBe(false);
  });

  it('③ 历史日 + 事实未就绪 ⇒ 保守挂（证据都在库里，秒级到齐）', function() {
    expect(shouldGateBuySide(q({ ebbCtxReady: false, isToday: false }))).toBe(true);
  });

  it('③ 今天 + 事实未就绪：预热猜「是分歧日」⇒ 挂（这就是「秒显示」的来源）', function() {
    expect(shouldGateBuySide(q({ ebbCtxReady: false, isToday: true, guessFirst: true }))).toBe(true);
  });

  it('③ 今天 + 事实未就绪：猜不出来 / 猜「不是」⇒ 不挂（§11：与加预热之前零行为差异）', function() {
    expect(shouldGateBuySide(q({ ebbCtxReady: false, isToday: true, guessFirst: false }))).toBe(false);
    expect(shouldGateBuySide(q({ ebbCtxReady: false, isToday: true }))).toBe(false);
  });

  it('③ 缺省输入 ⇒ 按【历史日】保守挂（§10 宁可多等不错显，⛔ 不静默放行）', function() {
    expect(shouldGateBuySide({})).toBe(true);
    expect(shouldGateBuySide(null)).toBe(true);
  });
});
