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
import { maxRangePctOf, makeAbnMainBoardFilter } from './tvrb-plan.js';
import { state } from '../app-state.js';
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

  it('版本：规则指纹 v13 + SW v51（[AUTO-PICK-TOP20] big 档取票口径变了，漏一个手机端就吃旧 JS）', () => {
    const r = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    expect(r).toContain('TVRB_RULES_VERSION = 13');
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("var CACHE = 'biga-static-v51'");
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

// ── [ABN-SAME-SOURCE 2026-11-13] 显示层兜底判据：名字 / 数值必须同源 ──────────────
//
// 用户报错原话：「11月13日提示那个就有错误，上面说市场总龙一闵发铝业十日涨幅100.78%，
//   根本不是，不知道这些数据从哪里来，相差太大了」。
// 这个函数就是那句提示的真凶：`leaderName: (t || p).name` 取【今日】最高票，
// `leaderPctPrev: p.pct` 取【昨日】最高票 ⇒ 11-13 拼出「闽发铝业 84.88 + 东方海洋的 100.78」。
describe('[ABN-SAME-SOURCE] buildAbnormalFactFromMaps 不许把「今日的名」配「昨日的数」', () => {
  it('11-13 真实数据：昨日触发 ⇒ 点名【东方海洋】100.78%，⛔ 不是闽发铝业', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['闽发铝业', { pct: 84.88 }], ['东方海洋', { pct: 73.15 }]]),
      prevAucMap: new Map([['东方海洋', { pct: 100.78 }], ['闽发铝业', { pct: 87.04 }]]),
      prevCloseMap: null
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderName).toBe('东方海洋');          // ★ 旧实现给「闽发铝业」
    expect(f.leaderPctPrev).toBeCloseTo(100.78, 2);
    expect(f.leaderPctToday).toBeCloseTo(73.15, 2); // 同一只票自己的今日值
    expect(f.detail).toContain('东方海洋');
    expect(f.detail).toContain('100.78%');
    expect(f.detail).not.toContain('闽发铝业');
    // 这条路径拿不到二十日涨幅榜 ⇒ ⛔ 不许自称「市场总龙一」
    expect(f.leaderLabel).toBe('市场十日涨幅最高票');
  });

  it('11-12 真实数据：今日触发 ⇒ 点名【东方海洋】100.78%（昨日 95.71 未触发）', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['东方海洋', { pct: 100.78 }], ['大东方', { pct: 70.05 }]]),
      prevAucMap: new Map([['东方海洋', { pct: 95.71 }], ['大东方', { pct: 60 }]]),
      prevCloseMap: null
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.leaderName).toBe('东方海洋');
    expect(f.leaderPctToday).toBeCloseTo(100.78, 2);
    expect(f.leaderPctPrev).toBeCloseTo(95.71, 2);
  });

  it('昨日与今日各有触发票 ⇒ 异动次日优先，且名字跟着【昨日】那只走', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['甲股份', { pct: 99 }], ['乙股份', { pct: 50 }]]),
      prevAucMap: new Map([['乙股份', { pct: 98 }], ['甲股份', { pct: 60 }]]),
      prevCloseMap: null
    });
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderName).toBe('乙股份');
    expect(f.leaderPctPrev).toBeCloseTo(98, 2);
    expect(f.leaderPctToday).toBeCloseTo(50, 2);
  });

  it('竞价口径优先：昨日收盘 100.43 / 竞价 95.71 ⇒ 不许拿收盘判空仓（11-11 正常运行）', () => {
    const f = buildAbnormalFactFromMaps({
      todayMap: new Map([['东方海洋', { pct: 95.711445 }]]),
      prevAucMap: new Map([['东方海洋', { pct: 92.5 }]]),
      prevCloseMap: new Map([['东方海洋', { pct: 100.43 }]])
    });
    expect(f.show).toBe(false);
  });

  it('§10：三份都读不到 ⇒ null（⛔ 不造空仓）', () => {
    expect(buildAbnormalFactFromMaps({ todayMap: null, prevAucMap: null, prevCloseMap: null })).toBeNull();
    expect(buildAbnormalFactFromMaps(null)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// [ABN-MAINBOARD 2026-11-13] 第三十四条【只认主板】—— 非主板不参与异动判定
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「我要求的是主板的异动的有提醒，非主板就不要考虑在里面，像历史日期的10月28日，
//   为什么把非主板的也考虑在里面呢，这个不作为考虑，只考虑列表里的主板的，其它非主板不做考虑。
//   这个不做判断标准，只有主板的才有这个条件。」
//
// 全历史取证（`.tmpdiag/_abn-history-scan.mjs`，09-08 ~ 11-13）：
//   旧口径（全池扫描）触发 17 天，只主板口径只有 10 天 ⇒ 7 天完全是非主板在触发，
//   而【旧口径漏触发 0 天】⇒ 加过滤不会漏掉任何一次真正的主板异动。
describe('[ABN-MAINBOARD] 只认主板', () => {
  /** 只把「已知代码」当判据的桩：等价于 isMainBoardRankEligible 的语义（未知 ⇒ 有资格） */
  function stubEligible(code) {
    const c = String(code || '');
    if (!/^\d{6}$/.test(c)) return true;                       // 代码未知 ⇒ 保留
    return !/^(30|68|4|8|92)/.test(c);                         // 创业板/科创板/北交所 ⇒ 排除
  }
  const byTable = tbl => name => tbl[name] || '';

  it('maxRangePctOf 带过滤：10-26 凡拓数创(创业板 134.65) 让位给冰山冷热(主板 82.92)', () => {
    const m = new Map([
      ['凡拓数创', { pct: 134.65 }],
      ['冰山冷热', { pct: 82.92 }],
      ['大业股份', { pct: 71.10 }]
    ]);
    // 不过滤 = 旧行为（会误触发全场空仓）
    expect(maxRangePctOf(m)).toEqual({ name: '凡拓数创', pct: 134.65 });
    // 只主板 = 新行为
    const eligible = makeAbnMainBoardFilter(stubEligible, byTable({ 凡拓数创: '301313', 冰山冷热: '000530', 大业股份: '603278' }));
    expect(maxRangePctOf(m, eligible)).toEqual({ name: '冰山冷热', pct: 82.92 });
  });

  it('maxRangePctOf 带过滤：10-28 用户点名那天 —— 创业板 89.51 让位给主板 78.54', () => {
    const m = new Map([
      ['凡拓数创', { pct: 89.51 }],
      ['大业股份', { pct: 78.54 }],
      ['海洋王', { pct: 69.65 }]
    ]);
    const eligible = makeAbnMainBoardFilter(stubEligible, byTable({ 凡拓数创: '301313', 大业股份: '603278', 海洋王: '002724' }));
    expect(maxRangePctOf(m, eligible)).toEqual({ name: '大业股份', pct: 78.54 });
  });

  it('maxRangePctOf 带过滤：09-08 北交所花溪科技 121.70（920895）被排除', () => {
    const m = new Map([
      ['花溪科技', { pct: 121.70 }],
      ['国芳集团', { pct: 84.23 }]
    ]);
    const eligible = makeAbnMainBoardFilter(stubEligible, byTable({ 花溪科技: '920895', 国芳集团: '601086' }));
    expect(maxRangePctOf(m, eligible)).toEqual({ name: '国芳集团', pct: 84.23 });
  });

  it('★ §10 方向性：名册查不到代码 ⇒ 保留（判不出≠非主板，宁可多算也不漏主板异动）', () => {
    const eligible = makeAbnMainBoardFilter(stubEligible, () => '');
    expect(eligible('某只查不到的票')).toBe(true);
    const m = new Map([['某只查不到的票', { pct: 99 }], ['主板票', { pct: 60 }]]);
    expect(maxRangePctOf(m, eligible)).toEqual({ name: '某只查不到的票', pct: 99 });
  });

  it('makeAbnMainBoardFilter：空名 ⇒ false（无名字不参与评选，避免把空键当最高票）', () => {
    const eligible = makeAbnMainBoardFilter(stubEligible, byTable({}));
    expect(eligible('')).toBe(false);
    expect(eligible('   ')).toBe(false);
    expect(eligible(null)).toBe(false);
  });

  it('makeAbnMainBoardFilter：注入函数抛错 ⇒ 按「保留」处理（⛔ 不许因查代码失败就全场放开/收紧）', () => {
    const eligible = makeAbnMainBoardFilter(stubEligible, () => { throw new Error('boom'); });
    expect(eligible('任意票')).toBe(true);
  });

  it('★ 显示层端到端：10-26 全池最高是非主板 ⇒ 不再整片灰（旧行为会误判空仓）', () => {
    const prev = state._scMapCache;
    state._scMapCache = { 凡拓数创: '301313', 冰山冷热: '000530' };
    try {
      const f = buildAbnormalFactFromMaps({
        todayMap: new Map([['凡拓数创', { pct: 134.65 }], ['冰山冷热', { pct: 82.92 }]]),
        prevAucMap: null,
        prevCloseMap: null
      });
      expect(f).not.toBeNull();
      expect(f.show).toBe(false);            // 主板最高 82.92 < 97 ⇒ 不是异动日
      expect(f.leaderName).toBe('冰山冷热'); // 触发源只能是主板那只
    } finally {
      state._scMapCache = prev;
    }
  });

  it('★ 显示层端到端：主板真的超线 ⇒ 照常触发（⛔ 别把过滤做成「永不触发」）', () => {
    const prev = state._scMapCache;
    state._scMapCache = { 东方海洋: '002086', 凡拓数创: '301313' };
    try {
      const f = buildAbnormalFactFromMaps({
        todayMap: new Map([['凡拓数创', { pct: 120 }], ['东方海洋', { pct: 100.78 }]]),
        prevAucMap: null,
        prevCloseMap: null
      });
      expect(f.show).toBe(true);
      expect(f.leaderName).toBe('东方海洋');
    } finally {
      state._scMapCache = prev;
    }
  });
});
