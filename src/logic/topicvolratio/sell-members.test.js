/**
 * [SELL-AUTO 2026-11-12 用户口径] 「次日卖点侧成员」口径的契约单测。
 *
 * 用户原话：「卖点侧那里，要不你把昨日的买点侧，统一放到次日的卖点侧，这样就不要我手动添加，
 *   因为我早上也是按照买点侧那里买的，这样就不会每次点击买入，才进去次日的题材量比的卖点侧，
 *   让它自动进去就可以了。帮我实现下，包括打标签的逻辑，也要标清楚。那些持有，卖出的标签
 *   你看怎么不冲突，要区分开来。还有手动的添加买入也不要冲突。」
 *
 * 本测试锁五条整类红线：
 *   ① 昨日【买点侧】的票**不需要任何标签**就进次日卖点侧（这就是本次需求的全部意义）；
 *   ② 手动「买入」与自动继承**去重合并**，且手动优先（⛔ 同一只票不出现两次、不被覆盖成 auto）；
 *   ③ 昨日「持有」保留（还拿着）；④ 昨日「卖出」**一票否决**（连 auto 也让路）；
 *   ⑤ 「昨日买点侧未知」≠「昨日买点侧为空」（§10：⛔ 不折成空集，也不假装全都知道）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildSellMembers,
  sellSourceLabel,
  sellSourceTitle,
  SELL_SOURCE_AUTO,
  SELL_SOURCE_BUY,
  SELL_SOURCE_HOLD
} from './sell-members.js';

function byName(members) {
  const m = new Map();
  members.forEach(function (x) { m.set(x.name, x.source); });
  return m;
}

describe('buildSellMembers — 三个来源 + 一道否决', () => {
  it('① 昨日买点侧的票，一只标签都没打，也要全部自动进次日卖点侧', () => {
    const r = buildSellMembers({}, ['大东方', '阳光照明']);
    expect(r.members.map(function (m) { return m.name; })).toEqual(['大东方', '阳光照明']);
    expect(r.members.every(function (m) { return m.source === SELL_SOURCE_AUTO; })).toBe(true);
    expect(r.stats).toMatchObject({ total: 2, auto: 2, buy: 0, hold: 0, excludedSell: 0, planKnown: true });
  });

  it('② 手动「买入」与自动继承去重合并，且手动优先（不冲突、不重复）', () => {
    const r = buildSellMembers({ '大东方': 'buy' }, ['大东方', '阳光照明']);
    const map = byName(r.members);
    expect(r.members.filter(function (m) { return m.name === '大东方'; })).toHaveLength(1);
    expect(map.get('大东方')).toBe(SELL_SOURCE_BUY);      // 手动优先，⛔ 不被 auto 覆盖
    expect(map.get('阳光照明')).toBe(SELL_SOURCE_AUTO);
    expect(r.stats).toMatchObject({ total: 2, auto: 1, buy: 1 });
  });

  it('③ 昨日「持有」的票留在卖点侧（还拿着，要继续看卖点）', () => {
    const r = buildSellMembers({ '光洋股份': 'hold' }, ['大东方']);
    const map = byName(r.members);
    expect(map.get('光洋股份')).toBe(SELL_SOURCE_HOLD);
    expect(map.get('大东方')).toBe(SELL_SOURCE_AUTO);
    expect(r.stats.hold).toBe(1);
  });

  it('④ 昨日「卖出」一票否决：即使它在昨日买点侧，也不许再自动推回来', () => {
    const r = buildSellMembers({ '大东方': 'sell' }, ['大东方', '阳光照明']);
    const names = r.members.map(function (m) { return m.name; });
    expect(names).toEqual(['阳光照明']);
    expect(r.stats.excludedSell).toBe(1);
  });

  it('④b 「卖出」也不会被当成「持有/买入」混进来（三种标签互斥）', () => {
    const r = buildSellMembers({ 'A': 'sell', 'B': 'hold', 'C': 'buy' }, []);
    const map = byName(r.members);
    expect(map.has('A')).toBe(false);
    expect(map.get('B')).toBe(SELL_SOURCE_HOLD);
    expect(map.get('C')).toBe(SELL_SOURCE_BUY);
  });

  it('⑤ 昨日买点侧「未知」(null) ≠ 空：只出标签成员，且 planKnown=false（§10 不许假装全知道）', () => {
    const r = buildSellMembers({ '大东方': 'buy' }, null);
    expect(r.members).toHaveLength(1);
    expect(r.stats.planKnown).toBe(false);
    expect(r.stats.planCount).toBe(0);
  });

  it('⑤b 昨日买点侧「确实是空数组」⇒ planKnown=true（这是有效答案，不是缺数据）', () => {
    const r = buildSellMembers({ '大东方': 'buy' }, []);
    expect(r.stats).toMatchObject({ planKnown: true, planCount: 0, total: 1 });
  });

  it('三种输入都受支持：Set / 数组 / 带空白的名字（trim 后去重）', () => {
    const r1 = buildSellMembers({}, new Set(['大东方']));
    const r2 = buildSellMembers({}, [' 大东方 ', '大东方']);
    expect(r1.members).toHaveLength(1);
    expect(r2.members).toHaveLength(1);
    expect(r2.members[0].name).toBe('大东方');
  });

  it('空输入 ⇒ 空成员（不抛）', () => {
    expect(buildSellMembers(null, null).members).toEqual([]);
    expect(buildSellMembers(undefined, undefined).members).toEqual([]);
    expect(buildSellMembers({}, null).stats.total).toBe(0);
  });

  it('输出确定性：按名字升序（便于存档比对 / 单测稳定）', () => {
    const r = buildSellMembers({ 'C': 'buy', 'A': 'hold' }, ['B']);
    expect(r.members.map(function (m) { return m.name; })).toEqual(['A', 'B', 'C']);
  });

  it('标签值非法（不是 buy/hold/sell）⇒ 忽略，不当作成员', () => {
    const r = buildSellMembers({ '大东方': '', '阳光照明': 'weird' }, []);
    expect(r.members).toEqual([]);
  });
});

describe('来源文案（§21 模板零计算）', () => {
  it('三种来源都有独立小标，且互不相同', () => {
    const a = sellSourceLabel(SELL_SOURCE_AUTO);
    const b = sellSourceLabel(SELL_SOURCE_BUY);
    const c = sellSourceLabel(SELL_SOURCE_HOLD);
    expect(a).toBe('自动');
    expect(b).toBe('手动买');
    expect(c).toBe('持有');
    expect(new Set([a, b, c]).size).toBe(3);
    // 每一条都必须有悬停说明（把「为什么它在这里」讲清楚，省得用户以为打过标签）
    expect(sellSourceTitle(SELL_SOURCE_AUTO)).toContain('昨日');
    expect(sellSourceTitle(SELL_SOURCE_BUY)).toContain('买入');
    expect(sellSourceTitle(SELL_SOURCE_HOLD)).toContain('持有');
  });

  it('未知来源 ⇒ 空串（组件整个不渲染，§10 不显示占位符）', () => {
    expect(sellSourceLabel('')).toBe('');
    expect(sellSourceLabel('whatever')).toBe('');
    expect(sellSourceTitle('')).toBe('');
  });
});

describe('静态锁 — 买点侧绝不被卖点侧的新来源污染', () => {
  const src = readFileSync(new URL('../decision/decision-collect.js', import.meta.url), 'utf8');

  it('卖点候选行必须走 _sellMembersOf（带来源），⛔ 不许再直接把标签集合塞进 _buildSellRows', () => {
    expect(src).toContain('_buildSellRows(_smMain.members, byName, date)');
    expect(src).toContain('_buildSellRows(sm.members, byName, date)');
    expect(src).not.toContain('_buildSellRows(act.prevBought');
    // 两个出口（题材量比 actionContext / 主流程）都必须经 _sellMembersOf 取成员
    // （函数定义形如 `_sellMembersOf(prevDate, prevBuyPlanNames)`，故用带 opts 的调用形态计数）
    const n = (src.match(/_sellMembersOf\(prevDate, opts/g) || []).length;
    expect(n).toBe(2);
  });

  it('买点侧入参必须仍是 prevBought（自动继承的票 ⛔ 不进买入侧的持有 / 加仓判定）', () => {
    expect(src).toContain('prevBoughtNames: prevBought,');
    expect(src).toContain('const prevBought = act.prevBought;');
  });

  it('成员判据只此一处：⛔ 不许在本文件里另写一份 buy/hold/sell 的取舍', () => {
    expect(src).toContain("import { buildSellMembers } from '../topicvolratio/sell-members.js';");
  });
});
