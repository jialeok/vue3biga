// deviation-overlay.test.js — 「官方偏离值」显示层叠加的回归锁
//
// 锁三件事：
//   ① ⛔ 绝不改写传入的 plan（§11 只读）：存档对象一个字段都不许动；
//   ② ⛔ 绝不动选股结论（buyActionTag / position / holdTag / pickCount / buyNames）；
//   ③ §10：判不出的票【不加徽标、不写 0%】，但**必须出现在 deviation 的覆盖统计里**。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachDeviationFacts, hasDeviationAlert, devToneOf } from './deviation-overlay.js';
import {
  computeDeviation, buildDeviationMap, DEV_STAGE_SEVERE, DEV_STAGE_NEAR
} from '../auction/abnormal-deviation.js';
import fx from '../auction/abnormal-dev-cases.json';

const norm = function (arr) { return (arr || []).map(function (x) { return { date: x.d, pct: x.p }; }); };
const legsOf = function (code) { return norm(fx.stocks[code].legs); };
const idxOf = function (code) { return norm(fx.idx[fx.stocks[code].idx]); };

/** 一份最小可用的 plan（形状与真实 plan 一致：blocks + buy 八槽 + 独立通道） */
function makePlan() {
  const built = function (names) {
    return {
      topic: '测试题材',
      picks: names.map(function (n) {
        return { name: n, pctText: '+10.0%', buyActionTag: '竞价买', position: '轻仓', holdTag: '—' };
      })
    };
  };
  const heavy = built(['九阳股份', '闽发铝业']);
  const plan = {
    blocks: [heavy],
    buy: { heavy: heavy, light: built(['九阳股份']), candidates: [] },
    newDragon: built(['闽发铝业']),
    cashAlert: { show: false },
    notes: ['原有说明'],
    pickCount: 2,
    buyNames: new Set(['九阳股份', '闽发铝业'])
  };
  return plan;
}

function devMapOf() {
  const m = new Map();
  m.set('九阳股份', computeDeviation({
    code: '002242', stockLegs: legsOf('002242'), indexLegs: idxOf('002242')
  }));
  m.set('闽发铝业', computeDeviation({
    code: '002578', stockLegs: legsOf('002578'), indexLegs: idxOf('002578')
  }));
  return m;
}

describe('[ABN-DEV-UI] attachDeviationFacts · 只加显示字段', () => {
  it('给每一行贴上 devBadge / devGap / devTone / devTitle', () => {
    const plan = makePlan();
    const out = attachDeviationFacts(plan, devMapOf(), { asOf: '2026-11-13', ready: 2, total: 2 });
    const p = out.buy.heavy.picks[0];
    expect(p.devBadge).toMatch(/偏离/);
    expect(typeof p.devGap).toBe('string');
    expect(p.devGap.length).toBeGreaterThan(0);
    expect(p.devTone).toBe('near');                 // 九阳 199.9 ⇒ near
    expect(p.devTitle).toContain('偏离');
    expect(p.devStage).toBe(DEV_STAGE_NEAR);
  });

  it('🔴 行上只印【点差】短版，「股价再涨」那句进 title（⛔ 行内塞长句会折行挤乱整行）', () => {
    const plan = makePlan();
    const out = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    const p = out.buy.heavy.picks[1];               // 闽发铝业 10日 +72.7 ⇒ 差 27.3 点
    expect(p.devGap).toBe('距 100% 差 27.3 点');
    expect(p.devGap).not.toContain('股价再涨');
    expect(p.devTitle).toContain('股价再涨约');
    // 行上的「徽标 + 点差」必须能相加等于阈值（用户就是照这行做加法的）
    const dev = Number(String(p.devBadge).match(/([+-]?\d+(?:\.\d+)?)%$/)[1]);
    const gap = Number(String(p.devGap).match(/差 (\d+(?:\.\d+)?) 点/)[1]);
    expect(dev + gap).toBeCloseTo(100, 6);
  });

  it('⛔ 不改选股结论与客观数据（标签 / 仓位 / 涨幅 / 数量）', () => {
    const plan = makePlan();
    const out = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    const p = out.buy.heavy.picks[0];
    expect(p.buyActionTag).toBe('竞价买');
    expect(p.position).toBe('轻仓');
    expect(p.holdTag).toBe('—');
    expect(p.pctText).toBe('+10.0%');
    expect(out.pickCount).toBe(2);
    expect(out.buyNames.size).toBe(2);
    expect(out.notes).toEqual(['原有说明']);
  });

  it('⛔ 不改写传入的 plan（§11）：原对象的 picks 一个字段都没多', () => {
    const plan = makePlan();
    attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    expect(plan.blocks[0].picks[0].devBadge).toBeUndefined();
    expect(plan.blocks[0].picks[0].devStage).toBeUndefined();
    expect(plan.deviation).toBeUndefined();
  });

  it('保持对象同一性：blocks[0] 与 buy.heavy 克隆后仍是同一个对象', () => {
    const plan = makePlan();
    const out = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    expect(out.blocks[0]).toBe(out.buy.heavy);
  });

  it('§10：devMap 里没有这只票 ⇒ 不加任何徽标（⛔ 不写 0% / 不写「—」）', () => {
    const plan = makePlan();
    const m = devMapOf();
    m.delete('闽发铝业');
    const out = attachDeviationFacts(plan, m, { ready: 1, total: 2 });
    const p = out.buy.heavy.picks[1];
    expect(p.name).toBe('闽发铝业');
    expect(p.devBadge).toBeUndefined();
    expect(p.devStage).toBeUndefined();
    // 但统计要如实反映命中行数（九阳股份在 heavy + light 两处都渲染 ⇒ 2 行）
    expect(out.deviation.matched).toBe(2);
    expect(out.deviation.matchedStocks).toBe(1);
  });

  it('§10：fact.ok=false（北交所 / 数据缺）⇒ 不加徽标，且不造空 deviation', () => {
    const plan = makePlan();
    const m = new Map();
    m.set('九阳股份', computeDeviation({ code: '830799' }));
    const out = attachDeviationFacts(plan, m, { ready: 0, total: 1 });
    expect(out.buy.heavy.picks[0].devBadge).toBeUndefined();
    // 一行都没命中 ⇒ 原样返回（⛔ 不挂一个「0 只命中」的空壳，那会被读成「没有异动」）
    expect(out).toBe(plan);
    expect(out.deviation).toBeUndefined();
  });

  it('一行都没命中 ⇒ 原样返回同一引用（不造空壳 deviation）', () => {
    const plan = makePlan();
    const m = new Map([['完全不相干的票', computeDeviation({ code: '830799' })]]);
    const out = attachDeviationFacts(plan, m, {});
    expect(out).toBe(plan);
    expect(out.deviation).toBeUndefined();
  });

  it('devMap 缺失 / 空 ⇒ 原样返回（§10 不拿空值当「没有异动」）', () => {
    const plan = makePlan();
    expect(attachDeviationFacts(plan, null, {})).toBe(plan);
    expect(attachDeviationFacts(plan, new Map(), {})).toBe(plan);
    expect(attachDeviationFacts(null, devMapOf(), {})).toBe(null);
  });

  it('幂等：同一份入参跑两遍结果一致（不残留上一轮字段）', () => {
    const plan = makePlan();
    const a = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    const b = attachDeviationFacts(a, devMapOf(), { ready: 2, total: 2 });
    expect(b.buy.heavy.picks[0].devBadge).toBe(a.buy.heavy.picks[0].devBadge);
  });

  it('devMap 变小（某只票数据没了）⇒ 旧徽标必须被抹掉，⛔ 不许残留', () => {
    const plan = makePlan();
    const first = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2 });
    expect(first.buy.heavy.picks[0].devBadge).toBeTruthy();
    const m = devMapOf();
    m.delete('九阳股份');
    const second = attachDeviationFacts(first, m, { ready: 1, total: 2 });
    expect(second.buy.heavy.picks[0].devBadge).toBeUndefined();
  });

  it('说明 note 会点名 severe / near 的票，并写明口径', () => {
    const plan = makePlan();
    const out = attachDeviationFacts(plan, devMapOf(), { ready: 2, total: 2, asOf: '2026-11-13' });
    expect(out.deviation.note).toContain('逼近偏离红线');
    expect(out.deviation.note).toContain('九阳股份');
    expect(out.deviation.note).toContain('对应指数按板块取');
    expect(out.deviation.alertNames).toContain('九阳股份');
  });
});

describe('[ABN-DEV-UX] 面板版式（2026-11-14 用户定的「一只票两行 + 公式上头」）', () => {
  const BOARD = readFileSync('src/components/topicvolratio/TvrbDeviationBoard.vue', 'utf8');
  const CSS = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');

  it('一只票两行：第一行三个短数字，第二行整行横排「距红线 + 自核算式」', () => {
    expect(BOARD).toContain('class="tvrb-dev-row-main"');
    expect(BOARD).toContain('class="tvrb-dev-row-gap"');
    expect(BOARD).toContain('colspan="3"');                 // 「距红线」独占整行
    // 第一行只有票 / 10日 / 30日 三列，⛔ 「距红线」不许再当第 4 列挤在那里
    const th = BOARD.match(/<thead>[\s\S]*?<\/thead>/)[0];
    expect(th.match(/<th>/g).length).toBe(3);
    expect(th).not.toContain('距红线');
    // 两行都在同一个 <template v-for> 里 ⇒ 不会出现「某只票只有一行」
    const body = BOARD.match(/<tbody>[\s\S]*?<\/tbody>/)[0];
    expect(body.match(/<template[\s\S]*?<\/template>/)[0].match(/<tr/g).length).toBe(2);
  });

  it('🔴 第二行顺序（用户 11-14 定稿）：股价再涨数值 → 自核 → 距红线点差 → 指数 ±1% 影响', () => {
    expect(BOARD).toContain('tvrb-dev-need-main');
    expect(BOARD).toContain('tvrb-dev-need-alert');
    expect(BOARD).toContain('{{ r.needValueText }}');
    expect(BOARD).toContain('{{ r.needHintText }}');
    expect(BOARD).toContain('{{ r.calcText }}');
    expect(BOARD).toContain('{{ r.gapTailText }}');
    expect(BOARD).toContain('{{ r.indexMoveText }}');
    const posNeed = BOARD.indexOf('{{ r.needValueText }}');
    const posCalc = BOARD.indexOf('{{ r.calcText }}');
    const posTail = BOARD.indexOf('{{ r.gapTailText }}');
    const posMove = BOARD.indexOf('{{ r.indexMoveText }}');
    expect(posNeed).toBeLessThan(posCalc);
    expect(posCalc).toBeLessThan(posTail);          // 「距…差几个点」放在自核后面
    expect(posTail).toBeLessThan(posMove);
    // 点差与自核同属灰字段（用户「灰色」），⛔ 不许再回到粗黑主位
    expect(BOARD).not.toContain('tvrb-dev-gap-main');
    expect(BOARD.indexOf('{{ r.gapTailText }}')).toBeGreaterThan(0);
  });

  it('红色只由 Logic 给的 needTone 决定，模板不判数字（§21）', () => {
    expect(BOARD).toContain("r.needTone === 'alert' ? 'tvrb-dev-need-alert' : ''");
    expect(BOARD).not.toContain('need30');
    expect(BOARD).not.toContain('toFixed(');
  });

  it('计算公式印在表头上方（不是只放 title 里 —— 用户看不到 title）', () => {
    const formula = BOARD.indexOf('tvrb-dev-formula');
    const table = BOARD.indexOf('<table');
    expect(formula).toBeGreaterThan(0);
    expect(formula).toBeLessThan(table);
    expect(BOARD).toContain('v-for="(line, i) in meta.formulaLines"');
  });

  it('★ [IDX-LABEL] 「对应指数是什么」说明块在公式块之前；票名后带该行自己的指数标签', () => {
    const note = BOARD.indexOf('tvrb-dev-index-note');
    const formula = BOARD.indexOf('tvrb-dev-formula');
    const table = BOARD.indexOf('<table');
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(formula);          // 先回答「减的是谁」，再讲「怎么减」
    expect(formula).toBeLessThan(table);
    expect(BOARD).toContain('v-for="(line, i) in meta.indexNoteLines"');
    expect(BOARD).toContain('tvrb-dev-index-tag');
    expect(BOARD).toContain('{{ r.indexLabelText }}');
    expect(BOARD).toContain(':title="r.indexLabelTitle"');
    // 标签必须在票名后、档位 chip 前（⛔ 别飘到第二行去）
    expect(BOARD.indexOf('{{ r.indexLabelText }}')).toBeGreaterThan(BOARD.indexOf('tvrb-dev-name'));
    expect(BOARD.indexOf('{{ r.indexLabelText }}')).toBeLessThan(BOARD.indexOf('tvrb-dev-stage-'));
  });

  it('§21：模板里零计算（⛔ 不出现 toFixed / 减阈值 / 除汇率）', () => {
    const tpl = BOARD.slice(0, BOARD.indexOf('<script'));
    expect(tpl).not.toContain('toFixed(');
    expect(tpl).not.toContain('need30');
    expect(tpl).not.toContain('Math.');
  });

  it('简洁版（.tvrb-compact）隐藏整块面板，原版才显示', () => {
    expect(CSS).toContain('.tvrb-board.tvrb-compact .tvrb-dev-board');
  });
});

describe('[ABN-DEV-UI] hasDeviationAlert / devToneOf', () => {
  it('near / severe 才算预警；watch / ok 不算', () => {
    expect(hasDeviationAlert({ deviation: { applied: true, alertNames: ['A'], severeNames: [] } })).toBe(true);
    expect(hasDeviationAlert({ deviation: { applied: true, alertNames: [], severeNames: ['B'] } })).toBe(true);
    expect(hasDeviationAlert({ deviation: { applied: true, alertNames: [], severeNames: [] } })).toBe(false);
    expect(hasDeviationAlert({})).toBe(false);
    expect(hasDeviationAlert(null)).toBe(false);
  });

  it('devToneOf 缺省返回空串（视图据此不渲染色调类）', () => {
    expect(devToneOf({ devTone: DEV_STAGE_SEVERE })).toBe(DEV_STAGE_SEVERE);
    expect(devToneOf({})).toBe('');
    expect(devToneOf(null)).toBe('');
  });
});

describe('[ABN-DEV] buildDeviationMap · 批量入口', () => {
  const codeOf = function (n) {
    return ({ '九阳股份': '002242', '闽发铝业': '002578', '北交票': '830799' })[n] || '';
  };
  const daily = new Map([
    ['九阳股份', new Map(legsOf('002242').map(function (l) { return [l.date, l.pct]; }))],
    ['闽发铝业', new Map(legsOf('002578').map(function (l) { return [l.date, l.pct]; }))]
  ]);
  const indexLegs = new Map([
    ['sz399107', idxOf('002242')],
    ['sh000002', []],
    ['sz399102', []],
    ['sh000688', []]
  ]);

  it('按票名批量算，ready 统计正确', () => {
    const r = buildDeviationMap({
      names: ['九阳股份', '闽发铝业', '北交票'], dailyByStock: daily,
      indexLegs: indexLegs, codeOf: codeOf, asOf: '2026-11-13'
    });
    expect(r.total).toBe(3);
    expect(r.ready).toBe(2);                       // 北交所不算
    expect(r.map.get('九阳股份').dev30).toBeCloseTo(199.9, 0);
    expect(r.map.get('北交票').ok).toBe(false);
  });

  it('asOf 截断：口径回不到未来（复盘历史日必须只看到那一天的腿）', () => {
    const r = buildDeviationMap({
      names: ['九阳股份'], dailyByStock: daily, indexLegs: indexLegs,
      codeOf: codeOf, asOf: '2026-10-31'
    });
    const f = r.map.get('九阳股份');
    expect(f.ok).toBe(true);
    expect(f.dev30).not.toBeCloseTo(199.9, 0);      // 10-31 那天不是 199.9
  });

  it('todayPctOf：竞价时点用今日竞价涨幅顶替末腿（收盘腿尚未生成也能算）', () => {
    const dayOnly = new Map([['九阳股份', new Map(
      legsOf('002242').filter(function (l) { return l.date < '2026-11-13'; })
        .map(function (l) { return [l.date, l.pct]; })
    )]]);
    // 不传 todayPctOf ⇒ 末腿缺失 ⇒ 判不出
    const noT = buildDeviationMap({
      names: ['九阳股份'], dailyByStock: dayOnly, indexLegs: indexLegs,
      codeOf: codeOf, asOf: '2026-11-13'
    });
    expect(noT.map.get('九阳股份').ok).toBe(false);
    // 传 todayPctOf ⇒ 末腿补上，判得出
    const withT = buildDeviationMap({
      names: ['九阳股份'], dailyByStock: dayOnly, indexLegs: indexLegs,
      codeOf: codeOf, asOf: '2026-11-13', basis: 'auction',
      todayPctOf: function () { return 1.2; }
    });
    const f = withT.map.get('九阳股份');
    expect(f.ok).toBe(true);
    expect(f.basis).toBe('auction');
  });

  it('指数腿整块缺失 ⇒ 全部 ok=false（§10 不补 0）', () => {
    const r = buildDeviationMap({
      names: ['九阳股份'], dailyByStock: daily,
      indexLegs: new Map(), codeOf: codeOf, asOf: '2026-11-13'
    });
    expect(r.ready).toBe(0);
    expect(r.map.get('九阳股份').dev10).toBe(null);
  });
});
