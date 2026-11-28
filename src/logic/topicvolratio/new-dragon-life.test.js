import { describe, it, expect } from 'vitest';
import {
  buildNewDragonLifeBlock,
  applyNewDragonLifeSellNote,
  NEW_DRAGON_LIFE_NOTE
} from './new-dragon-life.js';
import { NEW_DRAGON_LIFE_TAG, NEW_DRAGON_LIFE_RULE_NO } from './tvrb-constants.js';
import { AUCTION_YIZI_WAIT_TAG } from './auction-yizi-tag.js';
import { buildTopicVolRatioPlan } from './topic-vol-ratio-rules.js';

/** 今日题材清单样本（成员行与真实 collectDecisionTopics 同形的最小集） */
function _list(topic, members) {
  return [{ topic: topic, members: members }];
}

function _dm(entries) {
  const m = new Map();
  entries.forEach(function (e) { m.set(e.name, e); });
  return m;
}

describe('第三十七条【新龙续命】buildNewDragonLifeBlock', function () {
  it('非空仓提醒日 ⇒ 整块不出现（零副作用）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: false,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99 }])
    });
    expect(r.block).toBeNull();
    expect(r.reason).toBe('no-cash-alert');
  });

  it('上一交易日买点侧存档未读到 ⇒ 判不出（no-prev，⛔ 不当成「昨天没买」）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: null,
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99 }])
    });
    expect(r.block).toBeNull();
    expect(r.reason).toBe('no-prev');
  });

  it('命中：昨日买过 + 今日仍是龙一 ⇒ 出票并打【新龙续命】标签', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1, pct: 9.99 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99, code: '601086' }]),
      date: '2026-09-07'
    });
    expect(r.reason).toBe('hit');
    expect(r.block.picks).toHaveLength(1);
    expect(r.block.picks[0].name).toBe('国芳集团');
    expect(r.block.picks[0].buyActionTag).toBe(NEW_DRAGON_LIFE_TAG);
    expect(r.block.picks[0].dragonRank).toBe(1);
    expect(r.block.picks[0].actionNote).toContain(NEW_DRAGON_LIFE_TAG);
    expect(r.block.ruleNo).toBe(NEW_DRAGON_LIFE_RULE_NO);
    expect(r.block.notes.join('')).toContain(NEW_DRAGON_LIFE_NOTE);
  });

  it('今日不是龙一 ⇒ 不续命', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 2 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 3.2 }])
    });
    expect(r.block).toBeNull();
    expect(r.reason).toBe('no-hit');
  });

  it('连续停牌 ⇒ 不选（停牌不选）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99 }]),
      skipBuyNames: new Set(['国芳集团'])
    });
    expect(r.block).toBeNull();
    expect(r.reason).toBe('no-hit');
  });

  it('昨日二次确认退潮的题材 ⇒ 第二十六条让路（优先级 26 > 37）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99 }]),
      prevBannedTopics: ['零售']
    });
    expect(r.block).toBeNull();
    expect(r.reason).toBe('no-hit');
  });

  it('竞价一字涨停 ⇒ 照常选进，并挂统一「等下杀买」标签（⛔ 无跳过 / 顺延）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['国芳集团'],
      buyDragonMap: _dm([{ name: '国芳集团', rank: 1 }]),
      list: _list('零售', [{ name: '国芳集团', pct: 9.99, isYizi: true }])
    });
    expect(r.block.picks).toHaveLength(1);
    expect(r.block.picks[0].waitBuyTag).toBe(AUCTION_YIZI_WAIT_TAG);
    expect(r.block.picks[0].aucLimitUp).toBe(true);
  });

  it('同日多票 + 昨日名单去重 ⇒ 各占一行（原版分开，票重复不要紧）', function () {
    const r = buildNewDragonLifeBlock({
      cashAlertShow: true,
      prevBuyNames: ['上海九百', '上海九百', '九阳股份'],
      buyDragonMap: _dm([
        { name: '上海九百', rank: 1 },
        { name: '九阳股份', rank: 1 }
      ]),
      list: [
        { topic: '商业百货', members: [{ name: '上海九百', pct: 5.1 }] },
        { topic: '家电', members: [{ name: '九阳股份', pct: 4.2 }] }
      ]
    });
    expect(r.block.picks.map(function (p) { return p.name; })).toEqual(['上海九百', '九阳股份']);
    expect(r.names).toEqual(['上海九百', '九阳股份']);
  });
});

describe('第三十七条【新龙续命】卖点侧说明同步（铁律 4）', function () {
  it('续命票在卖点侧补写「续命持有」说明（不覆盖更高优先级已改写的行）', function () {
    const out = {
      newDragonLife: { picks: [{ name: '国芳集团' }, { name: '上海九百' }] },
      sell: [
        { items: [
          { name: '国芳集团', actionNote: '原说明' },
          { name: '上海九百', actionNote: '', devRuleStage: 'near' },
          { name: '无关票', actionNote: '不动' }
        ] }
      ]
    };
    const n = applyNewDragonLifeSellNote(out);
    expect(n).toBe(1);
    expect(out.sell[0].items[0].actionNote).toContain(NEW_DRAGON_LIFE_TAG);
    expect(out.sell[0].items[0].actionNote).toContain('原说明');
    // 三十六已改写的行不追加（优先级 36 > 37）
    expect(out.sell[0].items[1].actionNote).toBe('');
    // 不相干的票一个字不动
    expect(out.sell[0].items[2].actionNote).toBe('不动');
  });
});

describe('第三十七条【新龙续命】计划接线（buildTopicVolRatioPlan）', function () {
  function _m(name) {
    return { name: name, isYizi: false, pct: 20, aucPct: 5, aucVolRatio: 10, aucShare: null, code: '000001' };
  }
  function _topic() {
    // 4 只 + 平均竞价量比 10（< 25）⇒ 命中第十九条【空仓提醒】；mid 档取 1 只 = 龙一
    return {
      topic: '测试题材',
      rank: 1,
      count: 4,
      yiziCount: 0,
      members: [_m('甲'), _m('乙'), _m('丙'), _m('丁')]
    };
  }
  function _dm() {
    const mp = new Map();
    mp.set('甲', { rank: 1, topic: '测试题材', pct: 20 });
    mp.set('乙', { rank: 2, topic: '测试题材', pct: 19 });
    mp.set('丙', { rank: 3, topic: '测试题材', pct: 18 });
    mp.set('丁', { rank: 4, topic: '测试题材', pct: 17 });
    return mp;
  }

  it('空仓提醒日 + 昨日买过 + 今日仍是龙一 ⇒ 挂 out.newDragonLife / out.buy.newDragonLife，并进 buyNames', function () {
    const dm = _dm();
    const plan = buildTopicVolRatioPlan([_topic()], dm, {
      prevTvrbBuyNames: new Set(['甲']),
      buyDragonMap: dm
    });
    expect(plan.cashAlert && plan.cashAlert.show).toBe(true);
    expect(plan.newDragonLife).toBeTruthy();
    expect(plan.buy.newDragonLife).toBe(plan.newDragonLife);
    expect(plan.newDragonLife.picks.map(function (p) { return p.name; })).toEqual(['甲']);
    expect(plan.buyNames.has('甲')).toBe(true);
  });

  it('调用方没接跨日输入（undefined）⇒ 第三条静默不参与，不改动原有 notes / 结论', function () {
    const dm = _dm();
    const plan = buildTopicVolRatioPlan([_topic()], dm, { buyDragonMap: dm });
    expect(plan.newDragonLife).toBeNull();
    expect(plan.buy.newDragonLife).toBeNull();
    expect(plan.notes.join('')).not.toContain('新龙续命');
  });

  it('接入但上一日存档未读到（null）⇒ 判不出，写说明但不乱选', function () {
    const dm = _dm();
    const plan = buildTopicVolRatioPlan([_topic()], dm, {
      prevTvrbBuyNames: null,
      buyDragonMap: dm
    });
    expect(plan.newDragonLife).toBeNull();
    expect(plan.notes.join('')).toContain('新龙续命');
  });
});
