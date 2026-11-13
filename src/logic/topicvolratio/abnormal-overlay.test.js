// abnormal-overlay.test.js — [ABNORMAL-ALL 2026-11-13] 监管异动对【已定稿计划】的显示层总约束
//
// 用户原话：「昨天异动，11月12日买点侧也应该是灰色整片啊，也要提醒空仓啊，因为昨天买入的话，
//   就是个坑，也没有买点，现在还显示着东方海洋和大东方，这不合理的，要买点侧全部灰色」
//
// 真实锚点：`tvrb_plan_snapshot(2026-11-12)` = v4 定稿，cashAlert.show=false、
//   newDragon.picks = 东方海洋(146.92) / 大东方(72.75)，tag=【新龙买】。
//   历史日按红线保持定稿不重算 ⇒ 只能在【上屏前】叠加总约束，且绝不改写存档。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAbnormalOverlay, isAbnormalAllGray, buildAbnormalFactFromMaps } from './abnormal-overlay.js';
import { resolveAbnormalFact } from './abnormal-10d.js';
import { maxRangePctOf } from './tvrb-plan.js';
import { collectBuyNames } from './plan-live-overlay.js';
import {
  ABNORMAL_KIND_LEADER_NOW, ABNORMAL_KIND_NEXT_DAY, ABNORMAL_NO_BUY_TAG, TVRB_RANGE10_CAP
} from './tvrb-constants.js';

function abnormalFact() {
  return resolveAbnormalFact({
    leaderName: '东方海洋', leaderTopic: '东方',
    leaderPctToday: 100.78, leaderPctPrev: 95.71,
    leaderPctPrevBasis: 'auction', rows: []
  });
}

/** 与 11-12 存档同形状：blocks[0] 与 buy.heavy 是【同一个对象】，newDragon 是独立通道 */
function frozenPlan() {
  const heavy = {
    topic: '电力新能源',
    picks: [{ name: '阳光照明', pct: 44, buyActionTag: '竞价买', holdTag: '持有', position: '底仓' }]
  };
  const nd = {
    topic: '新题材 · 东方',
    picks: [
      { name: '东方海洋', pct: 146.92, buyActionTag: '新龙买', holdTag: '', position: '半仓' },
      { name: '大东方', pct: 72.75, buyActionTag: '新龙买', holdTag: '', position: '半仓' }
    ]
  };
  return {
    blocks: [heavy],
    buy: { heavy: heavy, newDragon: nd },
    newDragon: nd,
    cashAlert: { show: false, headline: '', detail: '' },
    buyNames: new Set(['阳光照明', '东方海洋', '大东方']),
    pickCount: 3,
    notes: ['当日只有 1 个题材满足条件'],
    sell: [{ topic: '电力新能源', items: [] }]
  };
}

describe('maxRangePctOf · 全市场竞价口径十日涨幅最高票', () => {
  it('11-12 形态：总龙二东方海洋 100.78 压过总龙一 ⇒ 被扫出来', () => {
    const m = new Map([
      ['福莱新材', { pct: 60.2 }],
      ['东方海洋', { pct: 100.78 }],
      ['大东方', { pct: 72.75 }]
    ]);
    expect(maxRangePctOf(m)).toEqual({ name: '东方海洋', pct: 100.78 });
    const f = resolveAbnormalFact({
      leaderName: '东方海洋', leaderPctToday: maxRangePctOf(m).pct,
      leaderPctPrev: 50, leaderPctPrevBasis: 'auction', rows: []
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
  });

  it('[NUM-TEXT] 文本型涨幅同样按数值取最大', () => {
    const m = new Map([['甲', { pct: '+95.71%' }], ['乙', { pct: '+100.78%' }]]);
    expect(maxRangePctOf(m)).toEqual({ name: '乙', pct: 100.78 });
  });

  it('§10：空 Map / 全脏值 ⇒ null，⛔ 不补 0', () => {
    expect(maxRangePctOf(null)).toBeNull();
    expect(maxRangePctOf(new Map())).toBeNull();
    expect(maxRangePctOf(new Map([['甲', { pct: '—' }], ['乙', { pct: null }]]))).toBeNull();
  });
});

describe('applyAbnormalOverlay · 定稿计划上屏前的总约束叠加', () => {
  it('§10 / §11：fact 不 show ⇒ 原样返回同一个引用，零副作用', () => {
    const p = frozenPlan();
    expect(applyAbnormalOverlay(p, null)).toBe(p);
    expect(applyAbnormalOverlay(p, { show: false })).toBe(p);
    expect(p.cashAlert.show).toBe(false);
  });

  it('⛔ 绝不改写传入的定稿存档（存档要能反复使用）', () => {
    const p = frozenPlan();
    const out = applyAbnormalOverlay(p, abnormalFact());
    expect(out).not.toBe(p);
    expect(p.cashAlert.show).toBe(false);
    expect(p.buyNames.size).toBe(3);
    expect(p.pickCount).toBe(3);
    expect(p.notes.length).toBe(1);
    expect(p.newDragon.picks[0].buyActionTag).toBe('新龙买');
    expect(p.blocks[0].picks[0].holdTag).toBe('持有');
  });

  it('★ 11-12 效果：空仓标语 + 逐行【异动不买】+ 选出 0 只，票一只不删', () => {
    const out = applyAbnormalOverlay(frozenPlan(), abnormalFact());
    expect(out.cashAlert.show).toBe(true);
    expect(out.cashAlert.headline).toContain('监管异动');
    expect(out.abnormal.show).toBe(true);
    expect(out.buyNames.size).toBe(0);
    expect(out.pickCount).toBe(0);
    expect(out.notes.length).toBe(2);
    expect(out.notes[1]).toContain('定稿存档');

    // 「不用去掉」：三个通道的票全在，且客观数据一行不动
    expect(out.newDragon).toBeTruthy();
    expect(collectBuyNames(out)).toEqual(['东方海洋', '大东方', '阳光照明']);
    expect(out.newDragon.picks[0].pct).toBe(146.92);
    expect(out.blocks[0].picks[0].pct).toBe(44);

    // 常规块 + 独立通道都改成【异动不买】
    [out.blocks[0], out.newDragon].forEach(function (b) {
      b.picks.forEach(function (p) {
        expect(p.buyActionTag).toBe(ABNORMAL_NO_BUY_TAG);
        expect(p.holdTag).toBe('');
        expect(p.position).toBe('');
      });
    });
    // 卖点侧一行不动
    expect(out.sell.length).toBe(1);
  });

  it('引用一致性：blocks[0] 与 buy.heavy 仍是同一个对象（分笔装饰依赖）', () => {
    const out = applyAbnormalOverlay(frozenPlan(), abnormalFact());
    expect(out.blocks[0]).toBe(out.buy.heavy);
    expect(out.buy.newDragon).toBe(out.newDragon);
  });

  it('幂等：实时路径已收口过一次 ⇒ 不叠第二遍', () => {
    const once = applyAbnormalOverlay(frozenPlan(), abnormalFact());
    expect(applyAbnormalOverlay(once, abnormalFact())).toBe(once);
    expect(once.notes.length).toBe(2);
  });

  it('isAbnormalAllGray：只看 abnormal.show，退潮 / 量比低不误灰独立买点块', () => {
    expect(isAbnormalAllGray(null)).toBe(false);
    expect(isAbnormalAllGray({ cashAlert: { show: true } })).toBe(false);
    expect(isAbnormalAllGray({ abnormal: { show: false } })).toBe(false);
    expect(isAbnormalAllGray(applyAbnormalOverlay(frozenPlan(), abnormalFact()))).toBe(true);
  });
});

describe('buildAbnormalFactFromMaps · 历史日云端 Map 兜底', () => {
  it('★ 11-12 真实形态：今日 100.78 / 昨日 95.71 ⇒ 当日异动（不依赖实时计划）', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['东方海洋', { pct: 100.78 }], ['福莱新材', { pct: 60 }]]),
      prevAucMap: new Map([['东方海洋', { pct: 95.71 }]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.leaderName).toBe('东方海洋');
  });

  it('★ 11-13 真实形态：今日 73.14 / 昨日 100.78 ⇒ 异动次日', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['东方海洋', { pct: 73.14 }]]),
      prevAucMap: new Map([['东方海洋', { pct: 100.78 }]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
  });

  it('§10：三份 Map 都缺 ⇒ null；竞价口径优先于收盘口径', () => {
    expect(buildAbnormalFactFromMaps({})).toBeNull();
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['甲', { pct: 50 }]]),
      prevAucMap: new Map([['甲', { pct: 73 }]]),
      prevCloseMap: new Map([['甲', { pct: 110 }]])
    });
    // 竞价口径 73 < 收盘口径 110 ⇒ 按竞价那份判，⛔ 拿收盘口径冒充会误报空仓
    expect(f.show).toBe(false);
  });
});

describe('[ABNORMAL-ALL 接线静态锁] 漏一处 ⇒ 11-12 仍显示彩色「新龙买」', () => {
  it('组合式在 displayPlan 出口叠加，并导出 abnormalGray', () => {
    const s = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect(s).toContain('applyAbnormalOverlay(base, _abnormalFactForDisplay(d))');
    expect(s).toContain('buildAbnormalFactFromMaps({');
    expect(s).toContain('isAbnormalAllGray(displayPlan.value)');
    expect(s).toContain('abnormalGray,');
  });

  it('六个独立买点容器全挂上全灰类，CSS 有定义', () => {
    const v = readFileSync('src/views/TopicVolRatioBoard.vue', 'utf8');
    expect((v.match(/'tvrb-abnormal-gray': abnormalGray/g) || []).length).toBe(6);
    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-abnormal-gray');
    expect(css).toContain('grayscale(1)');
  });

  it('版本：规则指纹 v10 + SW v45（[FULL-MARKET] 改了选股结论，漏一个手机端就吃旧 JS）', () => {
    const r = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    expect(r).toContain('TVRB_RULES_VERSION = 10');
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("var CACHE = 'biga-static-v45'");
  });

  it('[CAP-97] 11-11 真实 95.711445% 不该触发任何显示层总约束', () => {
    expect(TVRB_RANGE10_CAP).toBe(97);
    const fact = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '羊字辈',
      leaderPctToday: 95.71144503546094, leaderPctPrev: 82.44,
      leaderPctPrevBasis: 'auction',
      rows: [{ name: '东方海洋', pct: 95.71144503546094 }]
    });
    expect(fact.show).toBe(false);
    const base = frozenPlan();
    const out = applyAbnormalOverlay(base, fact);
    expect(out).toBe(base);                       // §11 零副作用
    expect(isAbnormalAllGray(out)).toBe(false);   // 不灰
    expect(out.cashAlert.show).toBe(false);       // 不空仓
  });

  it('★ [FULL-MARKET] 总龙一 98%（未到 100）⇒ 历史日照样【整片灰 + 空仓 + 一张票都不买】', () => {
    const fact = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '东方',
      leaderPctToday: 98, leaderPctPrev: 80,
      leaderPctPrevBasis: 'auction', rows: []
    });
    expect(fact.show).toBe(true);
    expect(fact.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    const out = applyAbnormalOverlay(frozenPlan(), fact);
    expect(isAbnormalAllGray(out)).toBe(true);
    expect(out.cashAlert.show).toBe(true);
    expect(out.pickCount).toBe(0);
    expect(out.buyNames.size).toBe(0);
    // ⛔ 票不删（用户「不用去掉」），只是标签一律【异动不买】
    expect(out.newDragon.picks.map(function(p) { return p.name; })).toEqual(['东方海洋', '大东方']);
    out.newDragon.picks.forEach(function(p) {
      expect(p.buyActionTag).toBe(ABNORMAL_NO_BUY_TAG);
    });
  });
});
