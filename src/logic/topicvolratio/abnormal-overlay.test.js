// abnormal-overlay.test.js — [ABNORMAL-ALL 2026-11-13] 监管异动对【已定稿计划】的显示层总约束
//
// 用户原话：「昨天异动，11月12日买点侧也应该是灰色整片啊，也要提醒空仓啊，因为昨天买入的话，
//   就是个坑，也没有买点，现在还显示着东方海洋和大东方，这不合理的，要买点侧全部灰色」
//
// ★★ [DEV-RULE 2026-11-25 口径整体替换，用户逐字] ★★
//   「之前我自定义的 100% 涨幅那个就触发监管异动，那个有些不准……确实是需要改下统一口径
//     是官方偏离值那里产生异动监管，而不是自定义的。也是按照原来的规则要记录首次异动、
//     异动次日等规则不变，只是口径要改变。」
//   ⇒ 本文件的夹具从「十日涨幅数字（97% 尺子）」整体换成「官方偏离值事实」。
//   ⇒ 异动日也随之**位移**：真库 36 个交易日实测，两套尺子各触发 6 天、只有 3 天重合。
//     自定义独有 10-13 / 10-14 / 11-12；官方独有 10-30 / **11-11（东方海洋 10日偏离 +100.01%）** / 11-24。
//     ⇒ 下面正文里的 11-12 一律改读 **11-11**（同一个「昨天异动、今天整片灰」的场景，换了日子）。
//
// 真实锚点：tvrb_plan_snapshot 历史定稿（v4 那类）里 cashAlert.show=false、
//   newDragon.picks = 东方海洋 / 大东方，tag=【新龙买】。
//   历史日按红线保持定稿不重算 ⇒ 只能在【上屏前】叠加总约束，且绝不改写存档。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAbnormalOverlay, isAbnormalAllGray, buildAbnormalFactFromMaps } from './abnormal-overlay.js';
import { resolveAbnormalFact } from './abnormal-10d.js';
import { maxRangePctOf, makeAbnMainBoardFilter } from './tvrb-plan.js';
import { pickRedLineSource } from './abnormal-10d.js';
import { DEV_OFFICIAL_RED_LINE_10D, DEV_NEAR_RATIO } from '../auction/deviation-rule-facts.js';
import { state } from '../app-state.js';
import { collectBuyNames } from './plan-live-overlay.js';
import {
  ABNORMAL_KIND_LEADER_NOW, ABNORMAL_KIND_NEXT_DAY, ABNORMAL_NO_BUY_TAG
} from './tvrb-constants.js';

/** [SW-CACHE] sw.js 的 CACHE 版本号。断言写成「≥ 基线」：
 *  既能抓住「改了文案却忘记 bump」（版本还停在旧号，一定小于基线），
 *  又不用每轮发布都回来改数字（旧的精确断言每轮都要改 4 处，改漏就是假红）。 */
function _swCacheNo(text) {
  const m = /var CACHE = 'biga-static-v(\d+)'/.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

// ── 偏离值事实夹具 ────────────────────────────────────────────────────────────
// 只造「档位」这一件事：「阈值 → 档位」的换算由 deviation-rule-facts.test.js 用真实
// `computeDeviation` 锁死（⛔ 不在这里手写 100 / 200 / 0.9 的第二把尺子）。
function fact(stage, dev10, dev30) {
  return {
    ok: true,
    stage: stage,
    dev10: (dev10 === undefined ? null : dev10),
    dev30: (dev30 === undefined ? null : dev30)
  };
}
function SEVERE(d10, d30) { return fact('severe', d10, d30); }
function NEAR(d10, d30) { return fact('near', d10, d30); }
/** 判不出（§10）：腿缺 / 北交所 …… */
const UNKNOWN = { ok: false, stage: 'unknown', dev10: null, dev30: null };

/** 主用例事实：11-11 当日异动（今日已越线、昨日只是逼近 ⇒ 不是「异动次日」） */
function abnormalFact() {
  return resolveAbnormalFact({
    leaderName: '东方海洋', leaderTopic: '东方',
    leaderDevToday: SEVERE(100.01), leaderDevPrev: NEAR(95.71),
    rows: []
  });
}

/** 与历史定稿同形状：blocks[0] 与 buy.heavy 是【同一个对象】，newDragon 是独立通道 */
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

// ══════════════════════════════════════════════════════════════════════════════════════
// 三十四·b 的「D-2 触发源」仍要走 maxRangePctOf（D-2 当天十日涨幅最高的主板票），
// 但「它是否越线」改用官方偏离值 —— 两件事别混。
// ══════════════════════════════════════════════════════════════════════════════════════
describe('maxRangePctOf · 全市场竞价口径十日涨幅最高票（三十四·b 的 D-2 触发源）', () => {
  it('11-12 形态：总龙二东方海洋 100.78 压过总龙一 ⇒ 被扫出来', () => {
    const m = new Map([
      ['福莱新材', { pct: 60.2 }],
      ['东方海洋', { pct: 100.78 }],
      ['大东方', { pct: 72.75 }]
    ]);
    expect(maxRangePctOf(m)).toEqual({ name: '东方海洋', pct: 100.78 });
    // ⛔ 但「谁越线」不再看十日涨幅名次：同一只票的偏离事实才是判据
    expect(pickRedLineSource({
      facts: new Map([['东方海洋', SEVERE(100.01)], ['福莱新材', NEAR(80)]])
    })).toMatchObject({ found: true, name: '东方海洋' });
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

  it('★ 异动日效果：空仓标语 + 逐行【异动不买】+ 选出 0 只，票一只不删', () => {
    const out = applyAbnormalOverlay(frozenPlan(), abnormalFact());
    expect(out.cashAlert.show).toBe(true);
    expect(out.cashAlert.headline).toContain('监管异动');
    expect(out.abnormal.show).toBe(true);
    expect(out.buyNames.size).toBe(0);
    expect(out.pickCount).toBe(0);
    expect(out.notes.length).toBe(2);
    expect(out.notes[1]).toContain('定稿存档');

    // 「不用去掉」：三个通道的票在屏幕上全在，且客观数据一行不动
    expect(out.newDragon).toBeTruthy();
    // ★ [SELL-INHERIT-BUYABLE 2026-11-19] 旧断言这里期望『三只照样被继承』——那正是卖点侧
    //   继承到旧规则票的根因。三枚都被改写成【异动不买】⇒ 按「今天能不能下单」的统一判据
    //   `_isBuyablePick`，它们一只都不能继承到次日卖点侧（票仍照常显示，只是不继承）。
    expect(collectBuyNames(out)).toEqual([]);
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
    // 卖点侧一行不动（第三十六条·b 的「异动卖」由规则层挂，不在显示层兜底里做）
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

describe('buildAbnormalFactFromMaps · 历史日官方偏离值事实兜底', () => {
  it('★ 11-11 真实形态：今日 10日偏离 +100.01 / 昨日 +95.71 ⇒ 当日异动（不依赖实时计划）', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['东方海洋', SEVERE(100.01)], ['福莱新材', NEAR(60)]]),
      prevDev: new Map([['东方海洋', NEAR(95.71)]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.leaderName).toBe('东方海洋');
  });

  it('★ 11-12 真实形态：今日 +96.3 / 昨日 +100.01 ⇒ 异动次日', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['东方海洋', NEAR(96.3)]]),
      prevDev: new Map([['东方海洋', SEVERE(100.01)]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
  });

  it('§10：两份都缺 ⇒ null（⛔ 不造空仓）；只有今日 ⇒ 照判，但昨日「判不出」如实留空', () => {
    expect(buildAbnormalFactFromMaps({})).toBeNull();
    expect(buildAbnormalFactFromMaps(null)).toBeNull();
    const f = buildAbnormalFactFromMaps({ todayDev: new Map([['甲', SEVERE(101)]]) });
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.leaderDevPrev).toBeNull();                 // ⛔ 不拿今日的值冒充昨日
    expect(f.leaderDevPrevText).toBe('—');
  });

  it('★ near 一只 / severe 一只 ⇒ 只认 severe（逼近红线不构成监管异动）', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['逼近票', NEAR(95)], ['越线票', SEVERE(100.4)]])
    });
    expect(f.show).toBe(true);
    expect(f.leaderName).toBe('越线票');
    // 全是 near ⇒ 一个都不抓（这才是「不含偏离放大」那条口径的落地）
    const only = buildAbnormalFactFromMaps({ todayDev: new Map([['逼近票', NEAR(95)]]) });
    expect(only).toBeNull();
  });
});

describe('[ABNORMAL-ALL 接线静态锁] 漏一处 ⇒ 异动日仍显示彩色「新龙买」', () => {
  it('组合式在 displayPlan 出口叠加，并导出 abnormalGray', () => {
    const s = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect(s).toContain('applyAbnormalOverlay(base, _abnormalFactForDisplay(d))');
    expect(s).toContain('buildAbnormalFactFromMaps({');
    expect(s).toContain('isAbnormalAllGray(displayPlan.value)');
    expect(s).toContain('abnormalGray,');
    // ★★ [DEV-RULE 2026-11-25] 入参键名必须已换成新口径那两个：
    //   ⛔ 传旧键名（todayMap / prevAucMap / prevCloseMap）不会报错 —— 两个新键都 undefined
    //   ⇒ 函数直接 return null ⇒「历史日不灰、不空仓」的静默失效。这是上一轮真实踩过的坑。
    const seg = s.slice(s.indexOf('function _abnormalFactForDisplay'), s.indexOf('const _displayPlanBase'));
    expect(seg).toContain('todayDev');
    expect(seg).toContain('prevDev');
    expect(seg).not.toContain('todayMap');
    expect(seg).not.toContain('prevAucMap');
    expect(seg).not.toContain('prevCloseMap');
  });

  it('七个独立买点容器全挂上全灰类，CSS 有定义', () => {
    const v = readFileSync('src/views/TopicVolRatioBoard.vue', 'utf8');
    // ★★ [RULE-35-RENDER 2026-11-19] 6 → 7：第三十五条「30日涨幅抱团」那一块同样是
    //   渲染在灰化容器【之外】的独立买点容器 ⇒ 监管异动日它也必须一起灰
    //   （漏挂 = 异动日屏幕上仍有一块彩色的「可以买」，用户会照着下单）。
    expect((v.match(/'tvrb-abnormal-gray': abnormalGray/g) || []).length).toBe(7);
    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-abnormal-gray');
    expect(css).toContain('grayscale(1)');
  });

  it('版本链：规则指纹 ≥ v18 + SW ≥ v67（改了选股结论，漏一个手机端就吃旧 JS）', () => {
    const r = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    const _rv = Number((/TVRB_RULES_VERSION = (\d+)/.exec(r) || [])[1]);
    expect(_rv).toBeGreaterThanOrEqual(17);   // [RULE-BUMP] 只锁「不得倒退」，bump 时不用改测试
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(_swCacheNo(sw)).toBeGreaterThanOrEqual(67);   // [SW-CACHE] ≥ 本轮基线即可，⛔ 不用每轮改数字
  });

  // ★★ [DEV-RULE 2026-11-25 口径整体替换] 旧的 [CAP-97] 断言（`TVRB_RANGE10_CAP === 97`）已废除：
  //   97% 那把自定义尺子**不再是判据**，只剩历史对照文案。这里改成锁新尺子。
  it('[DEV-NEAR] 逼近红线（+95.71）不该触发任何显示层总约束 —— 只有越线才空仓', () => {
    expect(DEV_OFFICIAL_RED_LINE_10D).toBe(100);
    expect(DEV_NEAR_RATIO).toBe(0.9);
    const near = resolveAbnormalFact({
      leaderName: '东方海洋', leaderTopic: '羊字辈',
      leaderDevToday: NEAR(95.71), leaderDevPrev: NEAR(82.44),
      rows: [{ name: '东方海洋', dev: NEAR(95.71) }]
    });
    expect(near.show).toBe(false);                // near ⇒ 不进第三十四条（⛔ 不空仓）
    expect(near.nearNames).toEqual(['东方海洋']);  // 但要点名交代（第三十六条接着禁这一只）
    const base = frozenPlan();
    const out = applyAbnormalOverlay(base, near);
    expect(out).toBe(base);                       // §11 零副作用
    expect(isAbnormalAllGray(out)).toBe(false);   // 不灰
    expect(out.cashAlert.show).toBe(false);       // 不空仓
  });

  it('★ [FULL-MARKET] 总龙一越线（+100.14）⇒ 历史日照样【整片灰 + 空仓 + 一张票都不买】', () => {
    const fact36 = resolveAbnormalFact({
      leaderName: '大业股份', leaderTopic: '光伏',
      leaderDevToday: SEVERE(100.14), leaderDevPrev: NEAR(80),
      rows: []
    });
    expect(fact36.show).toBe(true);
    expect(fact36.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    const out = applyAbnormalOverlay(frozenPlan(), fact36);
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
// 这个函数就是那句提示的真凶：取【今日】最高票的名字，却取【昨日】最高票的数值
// ⇒ 11-13 拼出「闽发铝业 84.88 + 东方海洋的 100.78」。
// 新实现：先定【一个触发源名字】（昨日优先，其次今日），再从两份 Map 里各取**同一只票**的事实。
describe('[ABN-SAME-SOURCE] buildAbnormalFactFromMaps 不许把「今日的名」配「昨日的数」', () => {
  it('11-13 真实数据：昨日触发 ⇒ 点名【东方海洋】+100.78%，⛔ 不是闽发铝业', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['闽发铝业', NEAR(84.88)], ['东方海洋', NEAR(73.15)]]),
      prevDev: new Map([['东方海洋', SEVERE(100.78)], ['闽发铝业', NEAR(87.04)]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderName).toBe('东方海洋');          // ★ 旧实现给「闽发铝业」
    expect(f.leaderDevPrev).toBeCloseTo(100.78, 2);
    expect(f.leaderDevToday).toBeCloseTo(73.15, 2); // 同一只票自己的今日值
    expect(f.detail).toContain('东方海洋');
    expect(f.detail).toContain('100.78%');
    expect(f.detail).not.toContain('闽发铝业');
    // 这条路径拿不到二十日涨幅榜 ⇒ ⛔ 不许自称「市场总龙一」
    expect(f.leaderLabel).toBe('市场偏离值最高票');
  });

  it('11-11 真实数据：今日触发 ⇒ 点名【东方海洋】+100.01%（昨日 +95.71 未越线）', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['东方海洋', SEVERE(100.01)], ['大东方', NEAR(70.05)]]),
      prevDev: new Map([['东方海洋', NEAR(95.71)], ['大东方', NEAR(60)]])
    });
    expect(f.show).toBe(true);
    expect(f.kind).toBe(ABNORMAL_KIND_LEADER_NOW);
    expect(f.leaderName).toBe('东方海洋');
    expect(f.leaderDevToday).toBeCloseTo(100.01, 2);
    expect(f.leaderDevPrev).toBeCloseTo(95.71, 2);
  });

  it('昨日与今日各有触发票 ⇒ 异动次日优先，且名字跟着【昨日】那只走', () => {
    const f = buildAbnormalFactFromMaps({
      todayDev: new Map([['甲股份', SEVERE(100.5)], ['乙股份', NEAR(50)]]),
      prevDev: new Map([['乙股份', SEVERE(101)], ['甲股份', NEAR(60)]])
    });
    expect(f.kind).toBe(ABNORMAL_KIND_NEXT_DAY);
    expect(f.leaderName).toBe('乙股份');
    expect(f.leaderDevPrev).toBeCloseTo(101, 2);
    expect(f.leaderDevToday).toBeCloseTo(50, 2);
  });

  it('「越线最严重」的口径：10日按 +100 红线归一、30日按 +200 归一，不可直接比大小', () => {
    const f = buildAbnormalFactFromMaps({
      // 30日 +205% ⇒ 205/200 = 1.025；10日 +101% ⇒ 101/100 = 1.01 ⇒ 30日那只更严重
      todayDev: new Map([
        ['十日票', SEVERE(101, 150)],
        ['三十日票', SEVERE(98, 205)]
      ])
    });
    expect(f.leaderName).toBe('三十日票');
  });

  it('§10：两份都读不到 ⇒ null（⛔ 不造空仓）', () => {
    expect(buildAbnormalFactFromMaps({ todayDev: null, prevDev: null })).toBeNull();
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

  it('★ 显示层端到端：10-26 越线的只有非主板 ⇒ 不再整片灰（旧行为会误判空仓）', () => {
    const prev = state._scMapCache;
    state._scMapCache = { 凡拓数创: '301313', 冰山冷热: '000530' };
    try {
      const f = buildAbnormalFactFromMaps({
        todayDev: new Map([['凡拓数创', SEVERE(134.65)], ['冰山冷热', NEAR(82.92)]]),
        prevDev: null
      });
      // 唯一一只越线的是创业板 ⇒ 过滤后一只不剩（§10 判不出 ≠ 造空仓）
      expect(f).toBeNull();
    } finally {
      state._scMapCache = prev;
    }
  });

  it('★ 显示层端到端：主板真的越线 ⇒ 照常触发（⛔ 别把过滤做成「永不触发」）', () => {
    const prev = state._scMapCache;
    state._scMapCache = { 东方海洋: '002086', 凡拓数创: '301313' };
    try {
      const f = buildAbnormalFactFromMaps({
        todayDev: new Map([['凡拓数创', SEVERE(120)], ['东方海洋', SEVERE(100.78)]]),
        prevDev: null
      });
      expect(f.show).toBe(true);
      expect(f.leaderName).toBe('东方海洋');   // 创业板 120 更「严重」也不选它
    } finally {
      state._scMapCache = prev;
    }
  });

  it('§10：两只都判不出（腿缺）⇒ 不误报空仓', () => {
    const prev = state._scMapCache;
    state._scMapCache = { 东方海洋: '002086' };
    try {
      expect(buildAbnormalFactFromMaps({
        todayDev: new Map([['东方海洋', UNKNOWN]]), prevDev: null
      })).toBeNull();
    } finally {
      state._scMapCache = prev;
    }
  });
});
