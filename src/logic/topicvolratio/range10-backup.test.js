// range10-backup.test.js — 十日涨幅 · 在列次数候补（§15 纯函数单测）
//
// 用户口径（2026-10-24 逐字，见 range10-backup.js 文件头）。
//
// 本文件锁住八件事：
//   ① 排名口径 = 主板名次（非主板 / 缺涨幅【不占名次】），排序复用 sortIndicesByRangePct；
//   ② 只从「主板名次 ≤ 10」的十只里挑；
//   ③ 优先级：首次在列（cnt=1）> 二次在列（cnt=2）；且【只选一只】；
//   ④ 必须与「总龙一 / 已作废题材」不同题材（大类归一由调用方注入，本处用严格相等桩）；
//   ⑤ 已在今日买点侧的票不重复选；
//   ⑥ §10：次数未到 / 池子为空 ⇒ 判不出（ready=false、pick=null），⛔ 绝不当 0 次；
//   ⑦ 10-20 真实快照（海洋王 第 8 行 / 主板第 7 名、首次在列）必须能复现；
//   ⑧ 🔴 10-23 真实快照 + 【事故回归】：池子必须含「20天」补位行，否则名次整体前移一位
//      ⇒ 第 11 名的上海九百会被当成第 10 名选中（用户 2026-10-24 报的那个 bug）。

import { describe, it, expect } from 'vitest';
import {
  buildRange10Ranked,
  pickRange10Backup,
  RANGE10_BACKUP_WINDOW_DAYS,
  RANGE10_CNT_FIRST,
  RANGE10_CNT_SECOND
} from './range10-backup.js';
// ★ 标签文案复用生产实现（§6：⛔ 别在测试里另写一份「1 次 = 首次在列」）
import { presenceLabelOf } from '../auction/presence-label.js';

/** 2026-10-20 真实快照：当日名单 ∩ 十日涨幅（按涨幅降序），cnt 来自 auction_presence(w10) */
const POOL_1020 = [
  { name: '九阳股份', code: '002242', topic: '家电', pct: 80.99 },
  { name: '慈文传媒', code: '002343', topic: 'AI视频', pct: 79.20 },
  { name: '新华传媒', code: '600825', topic: '文化传媒', pct: 61.43 },
  { name: '冰山冷热', code: '000530', topic: '冰雪产业', pct: 56.81 },
  { name: '吉大正元', code: '003029', topic: 'AI应用', pct: 48.00 },
  { name: '莱美药业', code: '300006', topic: '医药', pct: 46.23 },   // 创业板 ⇒ 不占名次
  { name: '百洋股份', code: '002696', topic: '水产品', pct: 45.07 },
  { name: '海洋王', code: '002724', topic: 'LED', pct: 29.51 },
  { name: '京城股份', code: '600860', topic: '机器人概念', pct: 27.26 },
  { name: '东安动力', code: '600178', topic: '飞行汽车', pct: 25.10 },
  { name: '金奥博', code: '002917', topic: '并购重组', pct: 23.96 },
  { name: '长春一东', code: '600148', topic: '军工', pct: 23.74 }
];

const CNT_1020 = {
  九阳股份: 9, 慈文传媒: 6, 新华传媒: 8, 冰山冷热: 4, 吉大正元: 2, 莱美药业: 4,
  百洋股份: 6, 海洋王: 1, 京城股份: 1, 东安动力: 1, 金奥博: 4, 长春一东: 1
};

/** counts 构造器：{ 股票名: 次数 } */
function countsOf(obj) {
  const m = new Map();
  Object.keys(obj).forEach(function(k) { m.set(k, { cnt: obj[k] }); });
  return m;
}

/** 10-20 的默认入参：总龙一 = 新华传媒（文化传媒 / AI应用 大类） */
function opts1020(extra) {
  return Object.assign({
    counts: countsOf(CNT_1020),
    coveredDays: 10,
    excludeTopics: ['文化传媒']
  }, extra || {});
}

describe('range10-backup · 排名口径', () => {
  it('窗口 = 10 日（十日周期）', () => {
    expect(RANGE10_BACKUP_WINDOW_DAYS).toBe(10);
    expect(RANGE10_CNT_FIRST).toBe(1);
    expect(RANGE10_CNT_SECOND).toBe(2);
  });

  it('按涨幅降序，且非主板不占名次（莱美药业名次为 null）', () => {
    const ranked = buildRange10Ranked(POOL_1020);
    expect(ranked[0].name).toBe('九阳股份');
    const lmg = ranked.filter(function(r) { return r.name === '莱美药业'; })[0];
    expect(lmg.mainBoard).toBe(false);
    expect(lmg.rank).toBe(null);
    // 海洋王排在莱美药业之后（第 8 行），主板名次 7
    const hyw = ranked.filter(function(r) { return r.name === '海洋王'; })[0];
    expect(hyw.rank).toBe(7);
    expect(ranked.indexOf(hyw)).toBe(7); // 屏幕行号 8 ⇒ 下标 7
  });

  it('缺涨幅的行置底且不占名次', () => {
    const ranked = buildRange10Ranked([
      { name: 'A', code: '600000', topic: 'x', pct: 5 },
      { name: 'B', code: '600001', topic: 'x', pct: null },
      { name: 'C', code: '600002', topic: 'x', pct: 9 }
    ]);
    expect(ranked.map(function(r) { return r.name; })).toEqual(['C', 'A', 'B']);
    expect(ranked[2].rank).toBe(null);
  });

  it('重名只保留第一行（不重复占名次）', () => {
    const ranked = buildRange10Ranked([
      { name: 'A', code: '600000', topic: 'x', pct: 5 },
      { name: 'A', code: '600000', topic: 'x', pct: 99 }
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].pct).toBe(5);
  });
});

describe('range10-backup · 选票', () => {
  it('10-20 真实快照：选中海洋王（首次在列 · 主板第 7 名）', () => {
    const r = pickRange10Backup(POOL_1020, opts1020());
    expect(r.ready).toBe(true);
    expect(r.tier).toBe('first');
    expect(r.pick && r.pick.name).toBe('海洋王');
    expect(r.pick.label).toBe('首次在列');
    expect(r.pick.cnt).toBe(1);
    expect(r.pick.rank).toBe(7);
  });

  it('只从前十名里挑：第 11 名（长春一东）即使首次在列也不选', () => {
    // 前十名（主板第 1~10 = 九阳…金奥博）全部 cnt ≥ 3 ⇒ 既非首次也非二次
    // 长春一东 = 主板第 11 名、cnt = 1（首次在列）⇒ 不该出现在 trail 里
    const cnt = {
      九阳股份: 9, 慈文传媒: 6, 新华传媒: 8, 冰山冷热: 4, 吉大正元: 3, 莱美药业: 4,
      百洋股份: 6, 海洋王: 3, 京城股份: 5, 东安动力: 4, 金奥博: 7, 长春一东: 1
    };
    const r = pickRange10Backup(POOL_1020, opts1020({ counts: countsOf(cnt) }));
    expect(r.trail.length).toBe(10);
    expect(r.trail.some(function(t) { return t.name === '长春一东'; })).toBe(false);
    expect(r.pick).toBe(null);
  });

  it('没有首次在列 ⇒ 退到二次在列；两档都空 ⇒ 空仓（pick=null）', () => {
    const noFirst = {
      九阳股份: 9, 慈文传媒: 6, 新华传媒: 8, 冰山冷热: 4, 吉大正元: 3, 莱美药业: 4,
      百洋股份: 6, 海洋王: 2, 京城股份: 3, 东安动力: 0, 金奥博: 4, 长春一东: 1
    };
    const r = pickRange10Backup(POOL_1020, opts1020({ counts: countsOf(noFirst) }));
    // 长春一东 cnt=1 但名次 11（超出前十）⇒ 不算；海洋王 cnt=2 ⇒ 二次在列
    expect(r.tier).toBe('second');
    expect(r.pick && r.pick.name).toBe('海洋王');

    const none = {};
    Object.keys(CNT_1020).forEach(function(k) { none[k] = 5; });
    const r2 = pickRange10Backup(POOL_1020, opts1020({ counts: countsOf(none) }));
    expect(r2.ready).toBe(true);
    expect(r2.pick).toBe(null);
    expect(r2.reason).toContain('空仓');
  });

  it('与总龙一同题材的一律剔除（题词按注入的比较函数认亲）', () => {
    // 把海洋王认成「文化传媒」（大类归一的傀儡）⇒ 不能被选
    const same = function(a, b) { return String(a) === String(b) || (a === 'LED' && b === '文化传媒'); };
    const r = pickRange10Backup(POOL_1020, opts1020({ sameTopic: same }));
    expect(r.pick && r.pick.name).toBe('京城股份');
    const hyw = r.trail.filter(function(t) { return t.name === '海洋王'; })[0];
    expect(hyw.reason).toContain('同题材');
  });

  it('已在今日买点侧的票不重复选', () => {
    const r = pickRange10Backup(POOL_1020, opts1020({
      excludeName: new Set(['海洋王'])
    }));
    expect(r.pick && r.pick.name).toBe('京城股份');
    const hyw = r.trail.filter(function(t) { return t.name === '海洋王'; })[0];
    expect(hyw.reason).toContain('已在今日买点侧');
  });

  it('题材未知 ⇒ 判不出是否同题材，跳过（§10 不猜）', () => {
    const pool = POOL_1020.map(function(p) {
      return p.name === '海洋王' ? Object.assign({}, p, { topic: '' }) : p;
    });
    const r = pickRange10Backup(pool, opts1020());
    expect(r.pick && r.pick.name).toBe('京城股份');
    const hyw = r.trail.filter(function(t) { return t.name === '海洋王'; })[0];
    expect(hyw.reason).toContain('题材未知');
  });

  it('§10：次数未到 / 窗口无数据 ⇒ ready=false 且不选票', () => {
    const a = pickRange10Backup(POOL_1020, { counts: null, coveredDays: 10 });
    expect(a.ready).toBe(false);
    expect(a.pick).toBe(null);
    expect(a.reason).toContain('在列次数');

    const b = pickRange10Backup(POOL_1020, { counts: countsOf(CNT_1020), coveredDays: 0 });
    expect(b.ready).toBe(false);
    expect(b.pick).toBe(null);
  });

  it('§10：池子为空 ⇒ ready=false（⛔ 不冒充「今天没有」）', () => {
    const r = pickRange10Backup([], opts1020());
    expect(r.ready).toBe(false);
    expect(r.pick).toBe(null);
    expect(r.reason).toContain('未就绪');
  });

  it('前十名里没有主板票 ⇒ 空仓', () => {
    const pool = [
      { name: '创A', code: '300001', topic: 'x', pct: 50 },
      { name: '创B', code: '301001', topic: 'y', pct: 40 }
    ];
    const r = pickRange10Backup(pool, { counts: countsOf({ 创A: 1 }), coveredDays: 10 });
    expect(r.pick).toBe(null);
    expect(r.reason).toContain('没有主板票');
  });

  it('trail 每一只都带名次 / 次数 / 标签 / 原因（可追溯）', () => {
    const r = pickRange10Backup(POOL_1020, opts1020());
    expect(r.trail.length).toBe(10);           // 主板第 1~10 名
    r.trail.forEach(function(t) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.rank).toBe('number');
      expect(typeof t.cnt).toBe('number');
      expect(typeof t.label).toBe('string');
      expect(typeof t.reason).toBe('string');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ 2026-10-23 真实快照 + 事故回归（2026-10-24 用户报：
//    「十日涨幅标有首次在列的是兆威机电……你怎么又选上海九百了呢？这只票也没进前十啊」）
//
// 事故根因：屏幕上的十日涨幅榜【含「20天」补位行】（慈文传媒 = 20日涨幅补位票，不在 auction_watchlist 里），
//   而候选池只按当日名单建 ⇒ 少了慈文传媒这一行 ⇒ 后面每只票名次【整体前移一位】⇒
//   主板第 11 名的上海九百（屏幕上根本没标签）被当成第 10 名，在兆威机电被别的条件剔除后顶上来。
// ⇒ 本组用例：池子必须与屏幕同一批行（含补位行），并把「漏补位行会选错谁」这件事【反向钉死】。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('range10-backup · 2026-10-23 真实快照（含「20天」补位行）', () => {
  /** 屏幕顺序（十日涨幅降序）。慈文传媒 = 20日涨幅补位行 ⇒ 第十行缺失的错误由下面的回归用例复现 */
  const POOL_1023 = [
    { name: '凡拓数创', code: '301313', topic: '物理AI', pct: 115.05 },   // 创业板 ⇒ 不占名次
    { name: '海洋王', code: '002724', topic: 'LED', pct: 80.53 },
    { name: '慈文传媒', code: '002343', topic: 'AI视频', pct: 79.11 },    // ★「20天」补位行
    { name: '冰山冷热', code: '000530', topic: '冰雪产业', pct: 78.80 },
    { name: '大业股份', code: '603278', topic: '机器人概念', pct: 58.02 },
    { name: '九阳股份', code: '002242', topic: '家电', pct: 42.30 },
    { name: '百洋股份', code: '002696', topic: '水产品', pct: 40.03 },
    { name: '福莱新材', code: '605488', topic: '灵巧手', pct: 36.79 },
    { name: '兆威机电', code: '003021', topic: '灵巧手', pct: 32.79 },
    { name: '宁波东力', code: '002164', topic: '机器人概念', pct: 30.93 },
    { name: '吉大正元', code: '003029', topic: 'AI应用', pct: 28.63 },
    { name: '上海九百', code: '600838', topic: '零售', pct: 26.44 },
    { name: '润建股份', code: '002929', topic: '算力租赁', pct: 25.66 },
    { name: '三峡新材', code: '600293', topic: '玻璃', pct: 24.94 }
  ];
  /** auction_presence(2026-10-23, w=10) 的真实次数 */
  const CNT_1023 = {
    凡拓数创: 3, 海洋王: 3, 慈文传媒: 8, 冰山冷热: 7, 大业股份: 4, 九阳股份: 8,
    百洋股份: 9, 福莱新材: 3, 兆威机电: 1, 宁波东力: 3, 吉大正元: 5, 上海九百: 1,
    润建股份: 3, 三峡新材: 2
  };
  /** 20日涨幅总龙一 = 新华传媒（文化传媒）；与「灵巧手」互不相干 */
  const OPTS = function(extra) {
    return Object.assign({
      counts: countsOf(CNT_1023),
      coveredDays: 10,
      excludeTopics: ['文化传媒']
    }, extra || {});
  };

  it('前十名逐只（含标签）与用户屏幕完全一致 —— 与「在列次数」标签同一把尺子', () => {
    const ranked = buildRange10Ranked(POOL_1023);
    const labeled = ranked
      .filter(function(r) { return r.rank !== null && r.rank <= 10; })
      .map(function(r) { return r.name + ':' + presenceLabelOf(CNT_1023[r.name]); });
    expect(labeled).toEqual([
      '海洋王:3次在列',
      '慈文传媒:8次在列',
      '冰山冷热:7次在列',
      '大业股份:4次在列',
      '九阳股份:8次在列',
      '百洋股份:9次在列',
      '福莱新材:3次在列',
      '兆威机电:首次在列',
      '宁波东力:3次在列',
      '吉大正元:5次在列'
    ]);
  });

  it('上海九百 = 主板第 11 名（屏幕上没有标签）⇒ 不进候选；兆威机电 = 第 8 名 / 屏幕第 9 行', () => {
    const ranked = buildRange10Ranked(POOL_1023);
    const byName = new Map();
    ranked.forEach(function(r) { byName.set(r.name, r); });
    expect(byName.get('上海九百').rank).toBe(11);
    expect(byName.get('上海九百').rowNo).toBe(12);
    expect(byName.get('兆威机电').rank).toBe(8);
    expect(byName.get('兆威机电').rowNo).toBe(9);   // 名次 ≠ 行号：凡拓数创（创业板）占了第 1 行
    // 前十的名次里绝不含上海九百
    const top = ranked.filter(function(r) { return r.rank !== null && r.rank <= 10; });
    expect(top.some(function(r) { return r.name === '上海九百'; })).toBe(false);
  });

  it('★ 选中兆威机电（首次在列 · 主板第 8 名 · 灵巧手 ≠ 文化传媒）', () => {
    const r = pickRange10Backup(POOL_1023, OPTS());
    expect(r.ready).toBe(true);
    expect(r.tier).toBe('first');
    expect(r.pick && r.pick.name).toBe('兆威机电');
    expect(r.pick.rank).toBe(8);
    expect(r.pick.rowNo).toBe(9);
    expect(r.pick.label).toBe('首次在列');
    expect(r.pick.cnt).toBe(1);
    expect(r.pick.topic).toBe('灵巧手');
  });

  it('🔴 事故回归：兆威机电被剔除时【必须空仓】，⛔ 不许把第 11 名的上海九百顶上来', function() {
    const opts = OPTS({ excludeName: new Set(['兆威机电']) });
    // ① 正确的池子（含补位行慈文传媒）：前十只剩兆威机电一只「首次在列」，它被剔除 ⇒ 两档全空 ⇒ 空仓
    const ok = pickRange10Backup(POOL_1023, opts);
    expect(ok.ready).toBe(true);
    expect(ok.pick).toBeNull();
    expect(ok.reason).toContain('空仓');
    expect(ok.trail.some(function(t) { return t.name === '上海九百'; })).toBe(false);

    // ② 复现旧 bug：把补位行（慈文传媒）从池子里拿掉 = 名次整体前移一位
    //    ⇒ 上海九百 变成「第 10 名 · 首次在列」⇒ 被选中（用户实际看到的错票）
    const buggyPool = POOL_1023.filter(function(p) { return p.name !== '慈文传媒'; });
    const buggy = pickRange10Backup(buggyPool, opts);
    expect(buggy.pick && buggy.pick.name).toBe('上海九百');
    expect(buggy.pick.rank).toBe(10);   // ← 错就错在这个 10（真实名次是 11）
  });
});
