/**
 * [SELL-LIVE / TICK-LIVE 2026-11-12] 「冻结结论 × 实时事实」合流的契约单测。
 *
 * 用户原话：「我打开昨天的最近多板的股票列表长按股票名称，点击买入（显示虚线的买），
 *   再切换到今天题材量比卖点列表中，却没有显示股票名称，之前就可以显示，为什么现在不可以呢？
 *   之前还显示分笔成交。现在连卖点的票都没有，怎么回事？是不是从历史日期长按点击买入不行？
 *   要今天买入才行？这不合理啊，之前的却可以，现在却不能。你要修复下。」
 *
 * 本测试锁四条整类红线：
 *   ① 卖点段（成员 = 上一交易日的「买」标签）**恒取实时** —— 定稿之后补打的标签必须能进列表；
 *   ② 用户取消标签 ⇒ 卖点段必须跟着清空（⛔ 不能因为「冻结」把已经取消的票留在屏幕上）；
 *   ③ 分笔装饰**单调升级** —— 定稿时没抓到、之后抓到了必须补上；⛔ 绝不把已抓到的降级成「未抓取」；
 *   ④ 买点选股结论**一个字段都不许被实时值改写**，且传入的冻结对象**绝不被修改**（存档要能反复用）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  eachBuyBlock,
  shouldReplaceTick,
  mergeTickRow,
  overlayLiveOnFrozen,
  collectBuyNames
} from './plan-live-overlay.js';

/** 造一份「冻结的买点结论」——刻意带上 11-12 真实存档的形状：sell=[]、hasTick=false */
function frozenPlan() {
  const heavy = {
    topic: 'AI应用',
    picks: [{ name: '大东方', code: '600327', buyActionTag: '竞价买', hasTick: false, emptyText: '未抓取' }]
  };
  const newDragonBlk = {
    topic: '通信',
    picks: [{ name: '光洋股份', code: '002708', buyActionTag: '切换日新龙', hasTick: false, emptyText: '未抓取' }]
  };
  return {
    blocks: [heavy],
    buy: {
      heavy: heavy,
      newDragon: newDragonBlk,
      candidates: [{ topic: '机器人', picks: [{ name: '惠发食品', code: '603536', hasTick: false, emptyText: '未抓取' }] }]
    },
    newDragon: newDragonBlk,
    ebbBuy: { topic: 'AI应用', picks: [{ name: '南侨食品', code: '605339', hasTick: false, emptyText: '未抓取' }] },
    sell: [],
    notes: ['本日结论已定稿冻结'],
    pickCount: 1
  };
}

/** 造一份「实时算出来的 plan」——11-12 真实场景：用户在 11-11 补打了 buy（大东方 / 阳光照明） */
function livePlan() {
  return {
    blocks: [{ topic: 'AI应用', picks: [{ name: '大东方', code: '600327', buyActionTag: '竞价买', hasTick: true, redText: '买 60%' }] }],
    sell: [
      { topic: 'AI应用', items: [{ name: '大东方', code: '600327', sellActionTag: '竞价卖', hasTick: true, redText: '卖 40%' }] },
      { topic: '昨日已散题材', items: [{ name: '阳光照明', code: '600261', sellActionTag: '竞价卖', hasTick: false, emptyText: '未抓取' }] }
    ]
  };
}

describe('eachBuyBlock — 买点块清单的唯一遍历', () => {
  it('覆盖 plan.blocks、buy 的 8 个槽位、candidates、以及 6 个渲染在灰化容器之外的独立行', () => {
    const plan = frozenPlan();
    plan.buy.light = { topic: '通信', picks: [] };
    plan.buy.ebbSecond = { topic: 'AI应用', picks: [] };
    plan.divergeBuy = { topic: 'AI应用', picks: [] };
    plan.range10Backup = { topic: '机器人', picks: [] };
    plan.weakHuddle = { topic: '大消费', picks: [] };
    plan.catchUp = { topic: '机器人', picks: [] };
    const hit = [];
    eachBuyBlock(plan, function (b) { hit.push(b); });
    // blocks[0] 与 buy.heavy 是【同一个对象】⇒ 只能算一次
    expect(hit.filter(function (b) { return b === plan.buy.heavy; })).toHaveLength(1);
    // 6 个独立行必须全部命中（⛔ 漏一个 ⇒ 那一行点开永远「分笔明细暂不可用」）
    [plan.ebbBuy, plan.divergeBuy, plan.newDragon, plan.range10Backup, plan.weakHuddle, plan.catchUp]
      .forEach(function (b) {
        expect(hit.indexOf(b)).toBeGreaterThanOrEqual(0);
      });
    expect(hit.indexOf(plan.buy.candidates[0])).toBeGreaterThanOrEqual(0);
  });

  it('plan 为空 / fn 不是函数 ⇒ 静默不炸（看板首帧经常是空 plan）', () => {
    expect(function () { eachBuyBlock(null, function () {}); }).not.toThrow();
    expect(function () { eachBuyBlock(frozenPlan(), null); }).not.toThrow();
  });
});

describe('shouldReplaceTick — 分笔单调升级', () => {
  it('冻结「未抓取」+ 实时抓到了 ⇒ 覆盖（这就是本次报障的修复点）', () => {
    expect(shouldReplaceTick({ hasTick: false }, { hasTick: true, redText: '买 60%' })).toBe(true);
  });

  it('冻结已抓到 + 实时这一份是空的（切日期时分笔 store 还留着别的日子）⇒ ⛔ 保留冻结值', () => {
    expect(shouldReplaceTick({ hasTick: true }, { hasTick: false, emptyText: '未抓取' })).toBe(false);
  });

  it('两边都没抓到 ⇒ 用实时那份说明（「未抓取」→「已抓过但上游无该批次」更准）', () => {
    expect(shouldReplaceTick({ hasTick: false }, { hasTick: false, emptyText: '已抓过，无数据' })).toBe(true);
  });

  it('实时装饰结果缺省 ⇒ 不动', () => {
    expect(shouldReplaceTick({ hasTick: false }, null)).toBe(false);
  });

  it('mergeTickRow 不改冻结行（返回新对象）', () => {
    const frozenRow = { name: '大东方', hasTick: false, emptyText: '未抓取' };
    const merged = mergeTickRow(frozenRow, { name: '大东方', hasTick: true, redText: '买 60%' });
    expect(merged.hasTick).toBe(true);
    expect(frozenRow.hasTick).toBe(false);
    expect(frozenRow.emptyText).toBe('未抓取');
  });
});

describe('overlayLiveOnFrozen — 冻结买点结论 × 实时事实', () => {
  it('① 卖点段恒取实时：定稿时没有标签、之后补打 ⇒ 列表必须出现这两只', () => {
    const frozen = frozenPlan();
    const out = overlayLiveOnFrozen(frozen, livePlan(), null);
    expect(out.sell).toHaveLength(2);
    expect(out.sell[0].items[0].name).toBe('大东方');
    expect(out.sell[1].items[0].name).toBe('阳光照明');
  });

  it('② 用户取消标签 ⇒ 实时卖点段为空 ⇒ 屏幕必须跟着清空（⛔ 不能留冻结那版）', () => {
    const frozen = frozenPlan();
    frozen.sell = [{ topic: 'AI应用', items: [{ name: '大东方' }] }];
    const live = livePlan();
    live.sell = [];
    const out = overlayLiveOnFrozen(frozen, live, null);
    expect(out.sell).toEqual([]);
  });

  it('③ 买点选股结论一个字段都不许被实时值改写（用户红线：竞价期间结论不许变）', () => {
    const frozen = frozenPlan();
    const out = overlayLiveOnFrozen(frozen, livePlan(), null);
    expect(out.blocks[0].picks[0].name).toBe('大东方');
    expect(out.blocks[0].picks[0].buyActionTag).toBe('竞价买');
    // 实时那份只有 1 个块、实时票名也不全 —— 冻结侧的结构必须原封不动
    expect(out.blocks).toHaveLength(1);
    expect(out.buy.candidates[0].picks[0].name).toBe('惠发食品');
    expect(out.ebbBuy.picks[0].name).toBe('南侨食品');
    expect(out.pickCount).toBe(1);
    expect(out.notes).toEqual(['本日结论已定稿冻结']);
  });

  it('④ 分笔单调升级：买点行的「未抓取」被实时分笔补上', () => {
    const frozen = frozenPlan();
    const decorate = function (row) {
      return { name: row.name, hasTick: row.name === '大东方', redText: '买 60%', emptyText: '' };
    };
    const out = overlayLiveOnFrozen(frozen, livePlan(), decorate);
    // 大东方：实时抓到了 ⇒ 升级
    expect(out.blocks[0].picks[0].hasTick).toBe(true);
    expect(out.blocks[0].picks[0].redText).toBe('买 60%');
    // 惠发食品：实时也没有 ⇒ 保留冻结那一份（两边都是缺数据，不制造跳变）
    expect(out.buy.candidates[0].picks[0].hasTick).toBe(false);
  });

  it('⑤ 传入的冻结对象绝不被修改（存档解码那份要能反复用，§11）', () => {
    const frozen = frozenPlan();
    const before = JSON.stringify(frozen);
    overlayLiveOnFrozen(frozen, livePlan(), function (row) {
      return { name: row.name, hasTick: true, redText: '买 60%' };
    });
    expect(JSON.stringify(frozen)).toBe(before);
    expect(frozen.sell).toEqual([]);
    expect(frozen.blocks[0].picks[0].hasTick).toBe(false);
  });

  it('⑥ 克隆保持对象同一性：blocks[0] 与 buy.heavy 克隆后仍是同一个对象', () => {
    const frozen = frozenPlan();
    const out = overlayLiveOnFrozen(frozen, livePlan(), null);
    expect(out.blocks[0]).toBe(out.buy.heavy);
    expect(out.newDragon).toBe(out.buy.newDragon);
  });

  it('⑦ 实时那份还没算出来（live=null）⇒ 原样返回冻结结论，⛔ 不拿空值顶替（§10）', () => {
    const frozen = frozenPlan();
    expect(overlayLiveOnFrozen(frozen, null, null)).toBe(frozen);
    expect(overlayLiveOnFrozen(null, livePlan(), null)).toBe(null);
  });

  it('⑧ 实时 sell 不是数组（异常形状）⇒ 不动冻结的 sell（§10 不拿脏数据顶替）', () => {
    const frozen = frozenPlan();
    frozen.sell = [{ topic: 'AI应用', items: [{ name: '大东方' }] }];
    const out = overlayLiveOnFrozen(frozen, { sell: null }, null);
    expect(out.sell).toHaveLength(1);
  });
});

describe('collectBuyNames — 昨日买点侧的股票名（次日卖点侧自动继承的来源）', () => {
  it('收全 plan.blocks / buy 槽位 / candidates / 灰化容器外的独立行，并去重排序', () => {
    const plan = frozenPlan();
    plan.divergeBuy = { topic: 'AI应用', picks: [{ name: '日出东方' }] };
    plan.weakHuddle = { topic: '大消费', picks: [{ name: '惠发食品' }] };   // 与 candidates 重名 ⇒ 去重
    expect(collectBuyNames(plan)).toEqual(
      ['南侨食品', '大东方', '惠发食品', '日出东方', '光洋股份'].sort()
    );
  });

  it('⛔ 只收 picks，不收 members（题材成员池 ≠ 买点）', () => {
    const names = collectBuyNames({
      blocks: [{ topic: 'AI应用', picks: [{ name: '大东方' }], members: [{ name: '不该出现' }] }]
    });
    expect(names).toEqual(['大东方']);
  });

  it('空 plan / 空 picks ⇒ 空数组（不抛）', () => {
    expect(collectBuyNames(null)).toEqual([]);
    expect(collectBuyNames({})).toEqual([]);
    expect(collectBuyNames({ blocks: [{ picks: null }] })).toEqual([]);
  });
});

describe('静态锁 — 接线不许被改回去', () => {
  const src = readFileSync(new URL('../../composables/useTopicVolRatioBoard.js', import.meta.url), 'utf8');

  it('displayPlan 的两条冻结出口都必须经过 `_frozenWithLive`（⛔ 不许直接 return 存档 plan）', () => {
    const start = src.indexOf('const displayPlan = computed(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('// ══', start));
    expect(body).toContain('return _frozenWithLive(snap.plan, d)');
    expect(body).toContain('return _frozenWithLive(pub.plan, d)');
    expect(body).not.toContain('return snap.plan;');
    expect(body).not.toContain('return pub.plan;');
  });

  it('合流必须「卖点段取实时 + 买点行补分笔」，且走 Logic 层唯一实现', () => {
    expect(src).toContain('overlayLiveOnFrozen(frozen, live');
    expect(src).toContain("decorateTickRow(row, map, attempted, skipMap, null, 'buy')");
    expect(src).toContain('eachBuyBlock, overlayLiveOnFrozen');
  });

  it('⛔ 不许再出现第二份「买点块清单」（历史事故：漏槽位 ⇒ 那一行永远分笔不可用）', () => {
    expect(src).not.toContain('buyBlockLists');
  });

  it('存档回写必须存入参 plan，⛔ 不许把已叠加实时的 displayPlan 塞回内存存档', () => {
    expect(src).toContain('date: key, status: \'hit\', plan: plan,');
    expect(src).not.toContain('plan: displayPlan.value || plan');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// [SELL-EMPTY-GUARD 2026-11-12] 实时那份「没算出来」时，⛔ 不许拿空把冻结卖点抹掉。
//
// §10 第 11 条红线：读取失败 ≠ 空数据 ≠ 0。
// `_empty()`（未就绪）返回的 plan 里 `sell: []` 只是【形状占位】，不是「今天没有卖点」；
// 原样覆盖 ⇒ 冻结段里本来有票也会被抹成空（用户看到的就是「连卖点的票都没有」）。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [SELL-EMPTY-GUARD] 未就绪的实时 plan 不许抹掉冻结卖点', () => {
  function frozenWithSell() {
    return { ready: true, sell: [{ groupKey: 'g1', topic: '工业4.0', items: [{ name: '光洋股份' }] }], blocks: [] };
  }

  it('live.ready=false 且 live.sell=[] ⇒ 保留冻结卖点（§10）', () => {
    const out = overlayLiveOnFrozen(frozenWithSell(), { ready: false, sell: [], blocks: [] }, null);
    expect(out.sell.length).toBe(1);
    expect(out.sell[0].items[0].name).toBe('光洋股份');
  });

  it('live.ready=true 且 live.sell=[] ⇒ 照旧取实时（用户取消标签后该行必须消失）', () => {
    const out = overlayLiveOnFrozen(frozenWithSell(), { ready: true, sell: [], blocks: [] }, null);
    expect(out.sell.length).toBe(0);
  });

  it('live.ready=false 但实时确实算出了卖点 ⇒ 取实时（不是「未就绪就一定保留」）', () => {
    const live = { ready: false, sell: [{ groupKey: 'g2', topic: '算力', items: [{ name: '某票' }] }], blocks: [] };
    const out = overlayLiveOnFrozen(frozenWithSell(), live, null);
    expect(out.sell[0].topic).toBe('算力');
  });

  it('冻结段本来就是空 ⇒ 未就绪时照常取实时（空对空，不制造假数据）', () => {
    const out = overlayLiveOnFrozen({ ready: true, sell: [], blocks: [] }, { ready: false, sell: [], blocks: [] }, null);
    expect(out.sell.length).toBe(0);
  });

  it('实时那份的卖点来源统计要跟着合流结果走（空态文案据此区分「没票」/「没读回」）', () => {
    const live = { ready: true, sell: [], blocks: [], sellMemberStats: { total: 0, tagsKnown: true } };
    const out = overlayLiveOnFrozen({ ready: true, sell: [], blocks: [] }, live, null);
    expect(out.sellMemberStats.tagsKnown).toBe(true);
  });

  it('⛔ 不许修改传入的 frozen（存档那份要能反复使用，§11 只读不覆盖）', () => {
    const frozen = frozenWithSell();
    overlayLiveOnFrozen(frozen, { ready: true, sell: [], blocks: [] }, null);
    expect(frozen.sell.length).toBe(1);
  });
});
