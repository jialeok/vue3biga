// leader-first-topic.test.js — 第二十八条【老题材 = 老龙一第一次霸榜总龙一那天的题材大类】
// （2026-11-12 用户口径，夹具 = 东方海洋 11-02 ~ 11-12 的真值）
//
// 用户原话（本文件唯一需求来源，逐字）：
//   「提到题材的时候要说大类，你说农业（老龙一 东方海洋），要考究东方海洋的大类，首先要确定它
//    老龙一霸榜的题材是什么，从第一次霸榜总龙一开始，你检索下历史20个交易日，它第一次霸榜总龙一
//    是不是在11月4日，当时20日涨幅竞价口径，羊字辈就有5只，东方海洋总龙一，排名是，
//    3百洋股份，4九阳股份，5海洋王，7阳光照明，已经是超过标准了，确定是羊字辈的题材。
//    你在11月12日看来，这个就是作为老题材……而不是你说的农业」

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  boardOfDay,
  detectLeaderFirstDay,
  pickOldTopicFamily,
  detectLeaderFirstTopic
} from './leader-first-topic.js';
import { makeCoreTopicResolver } from '../topic/core-category.js';
import { _oldTopicNameOf, _oldTopicBasisOf } from './tvrb-utils.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// 夹具：一律 leg='auc'（原值即竞价口径，不走反解）⇒ 断言的是【分组 / 选日】逻辑本身
// ══════════════════════════════════════════════════════════════════════════════════════
const CODE = {
  东方海洋: '002086', 皇台酒业: '000995', 百洋股份: '002696', 九阳股份: '002242',
  海洋王: '002724', 青岛食品: '001215', 阳光照明: '600261', 新华传媒: '600825',
  七匹狼: '002029', 冰山冷热: '000530', 福莱新材: '605488', 大东方: '600327',
  日出东方: '603366', 襄阳轴承: '000678', 光洋股份: '002708'
};
const TOPIC = {
  东方海洋: '水产品,农业,东方,羊字辈',
  百洋股份: '水产品,农业,羊字辈',
  九阳股份: '家电,电子商务,羊字辈',
  海洋王: 'LED,军工,羊字辈',
  阳光照明: '外贸,氢能源,羊字辈',
  皇台酒业: '白酒,酿酒',
  青岛食品: '食品饮料,业绩增长',
  新华传媒: '文化传媒,AI应用',
  七匹狼: '纺织服装',
  冰山冷热: '核电,冷链物流',
  福莱新材: '工业4.0',
  大东方: '商业百货,东方',
  日出东方: '光伏,东方',
  襄阳轴承: '机器人概念,工业4.0',
  光洋股份: '机器人概念,工业4.0'
};
const topicOf = function (name) { return TOPIC[name] || ''; };

/** 造一天的原始行：rows = [{name, pct, leg?, days?}] */
function day(rows) {
  const rangeRows = new Map();
  const metricRows = [];
  rows.forEach(function (r) {
    rangeRows.set(r.name, { pct: r.pct, days: r.days === undefined ? 19 : r.days, leg: r.leg || 'auc' });
    metricRows.push({
      stock: r.name,
      code: CODE[r.name] || '',
      // 名单白名单要求 auc_pct_chg 非空（与 buildTvrbAuctionBoard 同一道闸门）
      auc_pct_chg: String(r.auc === undefined ? 1 : r.auc),
      change_pct: String(r.close === undefined ? 1 : r.close)
    });
  });
  return { rangeRows: rangeRows, metricRows: metricRows };
}

/** 11-04 真值榜（用户口述的 1 / 3 / 4 / 5 / 7 = 羊字辈 5 只） */
function day1104() {
  return day([
    { name: '东方海洋', pct: 92.48 },
    { name: '皇台酒业', pct: 82.53 },
    { name: '百洋股份', pct: 80.74 },
    { name: '九阳股份', pct: 78.37 },
    { name: '海洋王', pct: 73.18 },
    { name: '青岛食品', pct: 70.17 },
    { name: '阳光照明', pct: 66.97 },
    { name: '新华传媒', pct: 61.20 },
    { name: '七匹狼', pct: 58.10 },
    { name: '冰山冷热', pct: 55.30 }
  ]);
}

/**
 * 11-02 ~ 11-12 的历史窗口（真值顺序）：
 *   11-02 海洋王 #1；11-03 青岛食品 #1（东方海洋第 2）；11-04 东方海洋 #1（首霸）；
 *   11-06 / 11-09 / 11-10 都是东方海洋 #1；11-12 福莱新材 #1（老周期已换人）。
 */
function historyWindow() {
  return new Map([
    ['2026-11-02', day([{ name: '海洋王', pct: 89.25 }, { name: '东方海洋', pct: 80.10 }, { name: '百洋股份', pct: 70 }])],
    ['2026-11-03', day([{ name: '青岛食品', pct: 75.55 }, { name: '东方海洋', pct: 74.20 }, { name: '百洋股份', pct: 68 }])],
    ['2026-11-04', day1104()],
    ['2026-11-06', day([{ name: '东方海洋', pct: 95.10 }, { name: '百洋股份', pct: 79 }])],
    ['2026-11-09', day([{ name: '东方海洋', pct: 98.40 }, { name: '百洋股份', pct: 81 }])],
    ['2026-11-10', day([{ name: '东方海洋', pct: 99.90 }, { name: '百洋股份', pct: 76 }])],
    ['2026-11-12', day([{ name: '福莱新材', pct: 120.4 }, { name: '东方海洋', pct: 101 }, { name: '大东方', pct: 88 }])]
  ]);
}

describe('leader-first-topic · boardOfDay（单日榜口径复用既有实现）', function () {
  it('auc 腿原值即竞价口径（⛔ 不再反解一次）', function () {
    const b = boardOfDay(day([{ name: '东方海洋', pct: 92.48 }]));
    expect(b.ready !== false).toBe(true);
    expect(b.rank[0].stock).toBe('东方海洋');
    expect(b.rank[0].pct).toBeCloseTo(92.48, 2);
  });

  it('close 腿 ⇒ 按 (1+close20)/(1+closePct)×(1+aucPct)-1 反解回竞价口径', function () {
    // close20=90% / 收盘涨幅 10% / 竞价涨幅 5% ⇒ 1.9 / 1.1 × 1.05 - 1 = 0.813636…
    const b = boardOfDay(day([{ name: '东方海洋', pct: 90, leg: 'close', auc: 5, close: 10 }]));
    expect(b.rank[0].pct).toBeCloseTo(81.36, 2);
  });

  it('§10：没有 range20 行 ⇒ null（判不出，⛔ 不返回空榜冒充「这天没有龙头」）', function () {
    expect(boardOfDay(null)).toBeNull();
    expect(boardOfDay({ rangeRows: null, metricRows: [] })).toBeNull();
  });

  it('§10：腿数不够 / 不在 9:25 名单 ⇒ 不进榜（与选股榜同一把尺子）', function () {
    const d = day([
      { name: '东方海洋', pct: 92.48, days: 3 },          // 腿数 < 6
      { name: '百洋股份', pct: 80, days: 19 }
    ]);
    const b = boardOfDay(d);
    expect(b.rank.map(function (r) { return r.stock; })).toEqual(['百洋股份']);
  });
});

describe('leader-first-topic · detectLeaderFirstDay（第一次霸榜总龙一）', function () {
  it('★ 11-12 回看：东方海洋第一次霸榜 = 11-04，窗口内共霸榜 4 天', function () {
    const boards = new Map();
    historyWindow().forEach(function (input, d) {
      const b = boardOfDay(input);
      if (b) boards.set(d, b);
    });
    const r = detectLeaderFirstDay(boards, '东方海洋');
    expect(r.firstDate).toBe('2026-11-04');
    expect(r.leaderDays).toBe(4);            // 11-04 / 11-06 / 11-09 / 11-10
    expect(r.topPct).toBeCloseTo(92.48, 2);  // 首霸那天的竞价口径 20日涨幅
    expect(r.days).toBe(7);                  // 实际覆盖 7 天（窗口里能算出来的）
  });

  it('⛔ 取【最早】那一天，不是最近那一天', function () {
    const boards = new Map();
    historyWindow().forEach(function (input, d) {
      const b = boardOfDay(input);
      if (b) boards.set(d, b);
    });
    const r = detectLeaderFirstDay(boards, '东方海洋');
    expect(r.firstDate < '2026-11-06').toBe(true);
  });

  it('一次都没排第 1 ⇒ firstDate 空（= 判出「没有」，不是判不出）', function () {
    const boards = new Map([['2026-11-12', boardOfDay(day1104())]]);
    const r = detectLeaderFirstDay(boards, '福莱新材');
    expect(r.firstDate).toBe('');
    expect(r.leaderDays).toBe(0);
  });

  it('§10：没有榜 / 没有名字 ⇒ 不抛错、也不编一个日期', function () {
    expect(detectLeaderFirstDay(null, '东方海洋').firstDate).toBe('');
    expect(detectLeaderFirstDay(new Map(), '东方海洋').firstDate).toBe('');
    expect(detectLeaderFirstDay(new Map([['d', boardOfDay(day1104())]]), '').firstDate).toBe('');
  });
});

describe('leader-first-topic · pickOldTopicFamily（它所在组里成员最多的那一段）', function () {
  it('★ 11-04 前十：羊字辈 5 只 > 水产品 2 = 农业 2 > 东方 1 ⇒ 老题材 = 羊字辈', function () {
    const b = boardOfDay(day1104());
    const fam = pickOldTopicFamily(b.top10, '东方海洋', { topicOf: topicOf });
    expect(fam.topic).toBe('羊字辈');
    expect(fam.count).toBe(5);
    expect(fam.members.map(function (m) { return m.name; })).toEqual(
      ['东方海洋', '百洋股份', '九阳股份', '海洋王', '阳光照明']
    );
    // 名次与用户口述逐字一致：1 / 3 / 4 / 5 / 7
    expect(fam.members.map(function (m) { return m.rank20; })).toEqual([1, 3, 4, 5, 7]);
  });

  it('⛔ 不做核心词合并：把「水产品」归到「农业」后，农业组仍是 2 只，压不过羊字辈 5 只', function () {
    const coreRes = makeCoreTopicResolver([{ name: '农业', synonyms: ['水产品'] }]);
    const b = boardOfDay(day1104());
    const fam = pickOldTopicFamily(b.top10, '东方海洋', { topicOf: topicOf, coreRes: coreRes });
    expect(fam.topic).toBe('羊字辈');
    expect(fam.count).toBe(5);
  });

  it('★ R3 核心词（大类）：组名过一遍核心词归一（文化传媒 ⇒ AI应用）', function () {
    const coreRes = makeCoreTopicResolver([{ name: 'AI应用', synonyms: ['文化传媒'] }]);
    // ⚠️ 榜只收「拿得到主板代码」的票（与选股榜同一道闸门）⇒ 测试里两只都要给代码
    const codes = Object.assign({}, CODE, { 某某传媒: '600637' });
    const topics = Object.assign({}, TOPIC, { 某某传媒: '文化传媒' });
    const d = day([{ name: '新华传媒', pct: 92.0 }, { name: '某某传媒', pct: 80.0 }]);
    d.metricRows.forEach(function (r) { r.code = codes[r.stock] || ''; });
    const b = boardOfDay(d);
    const fam = pickOldTopicFamily(b.top10, '新华传媒', {
      topicOf: function (n) { return topics[n] || ''; }, coreRes: coreRes
    });
    // 两只都只在「文化传媒」组里 ⇒ 归一后印成 AI应用
    expect(fam.raw).toBe('文化传媒');
    expect(fam.topic).toBe('AI应用');
    expect(fam.count).toBe(2);
  });

  it('平局（成员数相同）⇒ 字辈线优先（那是老周期阵营的标记）', function () {
    const t = Object.assign({}, TOPIC, {
      某甲: '军工,羊字辈',
      某乙: '军工,羊字辈',
      某丙: '工业4.0',
      某丁: '工业4.0',
      龙头: '军工,羊字辈,工业4.0'
    });
    const codes = Object.assign({}, CODE, {
      某甲: '600001', 某乙: '600002', 某丙: '600003', 某丁: '600004', 龙头: '600005'
    });
    const d = day([
      { name: '龙头', pct: 99 },
      { name: '某甲', pct: 90 },
      { name: '某乙', pct: 85 },
      { name: '某丙', pct: 80 },
      { name: '某丁', pct: 75 }
    ]);
    d.metricRows.forEach(function (r) { r.code = codes[r.stock] || ''; });
    const b = boardOfDay(d);
    const fam = pickOldTopicFamily(b.top10, '龙头', {
      topicOf: function (n) { return t[n] || ''; }
    });
    expect(fam.topic).toBe('羊字辈');
  });

  it('§10：它所在的每一段都不足 2 只 ⇒ topic 空（调用方退回落库题材）', function () {
    const b = boardOfDay(day([
      { name: '东方海洋', pct: 92.48 },
      { name: '七匹狼', pct: 60.0 }
    ]));
    const fam = pickOldTopicFamily(b.top10, '东方海洋', { topicOf: topicOf });
    expect(fam.topic).toBe('');
  });
});

describe('leader-first-topic · detectLeaderFirstTopic（端到端）', function () {
  const opts = { topicOf: topicOf };

  it('★★ 11-12 端到端：老题材 = 羊字辈，判定日 = 11-04，成员 5 只，霸榜 4 天', function () {
    const r = detectLeaderFirstTopic(historyWindow(), '东方海洋', opts);
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('first-leader-day');
    expect(r.topic).toBe('羊字辈');
    expect(r.rawTopic).toBe('羊字辈');
    expect(r.firstDate).toBe('2026-11-04');
    expect(r.count).toBe(5);
    expect(r.leaderDays).toBe(4);
    expect(r.days).toBe(7);
    expect(r.members.map(function (m) { return m.name; })).toEqual(
      ['东方海洋', '百洋股份', '九阳股份', '海洋王', '阳光照明']
    );
    // ⛔ 不能是「农业」（那是用户当场指出的错）
    expect(r.topic).not.toBe('农业');
  });

  it('★ 核心词改了 ⇒ 印出来的大类跟着变（§6 一份实现）', function () {
    const coreRes = makeCoreTopicResolver([{ name: '羊年概念', synonyms: ['羊字辈'] }]);
    const r = detectLeaderFirstTopic(historyWindow(), '东方海洋', { topicOf: topicOf, coreRes: coreRes });
    expect(r.ready).toBe(true);
    expect(r.topic).toBe('羊年概念');
    expect(r.rawTopic).toBe('羊字辈');
  });

  it('§10：原始行整批没读到 ⇒ ready=false / no-board（⛔ 不编一个题材）', function () {
    const r = detectLeaderFirstTopic(new Map(), '东方海洋', opts);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no-board');
    expect(r.topic).toBe('');
  });

  it('§10：没传老龙一 ⇒ no-leader', function () {
    expect(detectLeaderFirstTopic(historyWindow(), '', opts).reason).toBe('no-leader');
    expect(detectLeaderFirstTopic(historyWindow(), '   ', opts).reason).toBe('no-leader');
  });

  it('一次都没霸榜 ⇒ never-top1（判出「没有」，调用方回落）', function () {
    const r = detectLeaderFirstTopic(historyWindow(), '百洋股份', opts);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('never-top1');
    expect(r.firstDate).toBe('');
  });

  it('找到首霸日但题材不足 2 只 ⇒ no-family（仍带回首霸日，便于文案交代）', function () {
    const only = new Map([['2026-11-04', day([{ name: '东方海洋', pct: 92.48 }, { name: '七匹狼', pct: 60 }])]]);
    const r = detectLeaderFirstTopic(only, '东方海洋', opts);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no-family');
    expect(r.firstDate).toBe('2026-11-04');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 文案（用户第二项要求：把判断的日期 / 逻辑写进选股提示）
// ══════════════════════════════════════════════════════════════════════════════════════
describe('leader-first-topic · 提示文案（判定日 + 成员 + 霸榜天数）', function () {
  const SW = {
    leaderName: '东方海洋',
    topic: '农业',
    oldTopic: '羊字辈',
    oldTopicSource: 'first-leader-day',
    oldTopicDate: '2026-11-04',
    oldTopicCount: 5,
    oldTopicMembers: [
      { name: '东方海洋', rank20: 1 }, { name: '百洋股份', rank20: 3 },
      { name: '九阳股份', rank20: 4 }, { name: '海洋王', rank20: 5 },
      { name: '阳光照明', rank20: 7 }
    ],
    oldTopicLeaderDays: 4,
    oldTopicTopPct: 92.48,
    oldTopicDays: 20
  };

  it('_oldTopicNameOf：优先 oldTopic（大类），⛔ 不是落库的那一段', function () {
    expect(_oldTopicNameOf(SW)).toBe('羊字辈');
    expect(_oldTopicNameOf({ topic: '农业' })).toBe('农业');   // 老调用方（没有 oldTopic）零变化
    expect(_oldTopicNameOf(null)).toBe('');
  });

  it('_oldTopicBasisOf：判定日 + 当天几只 + 成员名次 + 霸榜天数全都在里面', function () {
    const s = _oldTopicBasisOf(SW);
    expect(s).toContain('第一次霸榜总龙一 = 2026-11-04');
    expect(s).toContain('92.48%');
    expect(s).toContain('5 只【羊字辈】');
    expect(s).toContain('百洋股份');
    expect(s).toContain('阳光照明');
    expect(s).toContain('霸榜 4 天');
    expect(s).toContain('老题材（大类）= 羊字辈');
  });

  it('判不出首霸日 ⇒ 依据为空串（⛔ 不硬编一句话）', function () {
    expect(_oldTopicBasisOf({ oldTopicSource: 'fallback-never-top1', oldTopic: '农业' })).toBe('');
    expect(_oldTopicBasisOf({ oldTopic: '农业' })).toBe('');
    expect(_oldTopicBasisOf(null)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 接线静态锁：纯函数写完却忘了接线，是这套项目里最贵的失误（屏幕上一动不动）。
// ══════════════════════════════════════════════════════════════════════════════════════
describe('leader-first-topic · 接线（组合式 → 规则层 → 展示）', function () {
  it('组合式：切换日去读「老题材」，并把结果作为 oldLeaderTopic 注入规则层', function () {
    const src = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect(src).toContain('readLeaderRankInputsForDates(');
    expect(src).toContain('detectLeaderFirstTopic(');
    expect(src).toMatch(/ensureLeaderFirstTopic\(d, _sw\.leaderName\)/);
    expect(src).toContain('oldLeaderTopic: (leaderFirstTopicDate.value === d) ? leaderFirstTopic.value : null');
  });

  it('规则层：oldTopic 取「首霸日的题材大类」，⛔ 不再直接用 switchDay.topic', function () {
    const src = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    expect(src).toContain('const lft = o.oldLeaderTopic || null;');
    expect(src).toContain("out.switchDay.oldTopic = lftReady ? _normTopic(lft.topic, coreRes) : ebbTopic;");
    // 「正在退潮的老题材」清单必须用老题材（不是落库那段）
    expect(src).toContain('push(_oldTopicNameOf(out.switchDay));');
    expect(src).toContain('oldTopic: _oldTopicNameOf(out.switchDay),');
  });

  it('展示层：说明里带「老题材怎么定」（判定日 + 成员 + 霸榜天数）', function () {
    const src = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    expect(src).toContain('_oldTopicBasisOf(switchDay)');
    expect(src).toContain('【老题材怎么定】');
    // 提示板与行内说明都要带依据
    expect((src.match(/老题材怎么定：/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('规则手册（第二十八条）写清「老题材」的取法与 11-04 实例', function () {
    const src = readFileSync('src/logic/topicvolratio/tvrb-rules-lines.js', 'utf8');
    expect(src).toContain('【「老题材」取哪一段题材】');
    expect(src).toContain('11-04');
    expect(src).toContain('羊字辈');
  });
});
