// 第四·d · 大题材第二只「十日涨幅主板前十」卡 —— 单测
//
// 口径（2026-11-29 用户逐字）：
//   大题材（数量 > 8、取 2 只）的第二只票必须进【10 日涨幅·主板前十（9:26 竞价口径，含第 10）】；
//   `rank > 10` ⇒ 灰掉、不能买、不延顺、只留第一只；判不出（名次缺 / 整表没读到）同样灰，但必须写提醒。
//   第一只不受影响；题材平均量比不达标整块灰的优先级更高（本文件不重复测那条既有规则）。

import { describe, it, expect } from 'vitest';
import { _buildBlock, _applyBigSecondR10NoBuy, _applyBigSecondR10SellNote } from './tvrb-blocks.js';
import { BIG_SECOND_R10_NO_BUY_TAG } from './tvrb-constants.js';

function fixture(secondRank) {
  const members = [
    { name: '楚天龙', pct: 10, aucPct: 2, aucVolRatio: 5, aucShare: 3, code: '003040', isYizi: false },
    { name: '竞业达', pct: 9, aucPct: 1, aucVolRatio: 4, aucShare: 2, code: '003005', isYizi: false }
  ];
  const dragonMap = new Map([
    ['楚天龙', { rank: 1, pct: 10 }],
    ['竞业达', { rank: 2, pct: 9 }]
  ]);
  const topicPool = [
    { name: '楚天龙', pct: 120, rank20: 1, rank: 1, code: '003040', topic: 'AI应用' },
    { name: '竞业达', pct: 110, rank20: 2, rank: 2, code: '003005', topic: 'AI应用' }
  ];
  const block = { rank: 1, topic: 'AI应用', count: 11, yiziCount: 0, members: members };
  const tier = { tier: 'big', count: 11, pickCount: 2, rangeText: '> 8 只' };
  const r10Rank926 = new Map();
  r10Rank926.set('楚天龙', { rank: 3, pct: 50 });
  if (secondRank !== undefined && secondRank !== null) {
    r10Rank926.set('竞业达', { rank: secondRank, pct: 40 });
  }
  return {
    block: block,
    dragonMap: dragonMap,
    tier: tier,
    opt: {
      topicPool: topicPool,
      coreRes: function (s) { return String(s || ''); },
      top20Text: '9:25 竞价口径',
      r10Rank926: r10Rank926,
      r10TopText: '9:26 竞价口径'
    }
  };
}

function build(secondRank) {
  const f = fixture(secondRank);
  return _buildBlock(f.block, f.dragonMap, f.tier, undefined, new Set(), f.opt);
}

describe('第四·d · 大题材第二只十日涨幅卡', () => {
  it('第二只排第 10 名（含第 10）⇒ 不灰', () => {
    const blk = build(10);
    expect(blk.picks).toHaveLength(2);
    expect(blk.picks[1].bigSecondR10NoBuy).toBeUndefined();
    expect(blk.r10SecondNoBuyNames).toEqual([]);
    const names = _applyBigSecondR10NoBuy([blk]);
    expect(names).toEqual([]);
    expect(blk.picks[1].noBuyRowGray).toBeUndefined();
  });

  it('第二只排第 11 名 ⇒ 只灰这一行、标签正确、块内说明含名次', () => {
    const blk = build(11);
    expect(blk.picks[1].bigSecondR10NoBuy).toEqual(
      expect.objectContaining({ name: '竞业达', rank: 11, judge: 'out' })
    );
    expect(blk.r10SecondNoBuyNames).toEqual(['竞业达']);

    const names = _applyBigSecondR10NoBuy([blk]);
    expect(names).toEqual(['竞业达']);
    expect(blk.picks[1].noBuyRowGray).toBe(true);
    expect(blk.picks[1].buyActionTag).toBe(BIG_SECOND_R10_NO_BUY_TAG);
    expect(blk.picks[1].actionNote).toContain('第 11 名');
    expect(blk.picks[1].actionNote).toContain('不延顺');
    // 第一只完全不受影响
    expect(blk.picks[0].noBuyRowGray).toBeUndefined();
    expect(blk.picks[0].buyActionTag || '').not.toBe(BIG_SECOND_R10_NO_BUY_TAG);
    // 块头 / 块内文案都写了第四·d（三处文案之二）
    expect(blk.reason).toContain('第四·d');
    expect(blk.notes.join(' ')).toContain('第四·d');
    expect(blk.notes.join(' ')).toContain('第 11 名');
  });

  it('第二只不在名次表 ⇒ 判不出也算灰，且必须写提醒', () => {
    const blk = build(undefined);
    expect(blk.picks[1].bigSecondR10NoBuy.judge).toBe('unknown');
    _applyBigSecondR10NoBuy([blk]);
    expect(blk.picks[1].noBuyRowGray).toBe(true);
    expect(blk.picks[1].buyActionTag).toBe(BIG_SECOND_R10_NO_BUY_TAG);
    expect(blk.picks[1].actionNote).toContain('判不出');
    expect(blk.notes.join(' ')).toContain('判不出');
  });

  it('名次表为空 Map ⇒ 同样判不出、灰 + 提醒', () => {
    const f = fixture(11);
    f.opt.r10Rank926 = new Map();
    const blk = _buildBlock(f.block, f.dragonMap, f.tier, undefined, new Set(), f.opt);
    expect(blk.picks[1].bigSecondR10NoBuy.judge).toBe('unknown');
  });

  it('不注入 r10Rank926（老调用方 / 单测）⇒ 本条不生效（§11 零行为变化）', () => {
    const f = fixture(11);
    delete f.opt.r10Rank926;
    delete f.opt.r10TopText;
    const blk = _buildBlock(f.block, f.dragonMap, f.tier, undefined, new Set(), f.opt);
    expect(blk.picks[1].bigSecondR10NoBuy).toBeUndefined();
    expect(blk.r10SecondNoBuyNames).toEqual([]);
    expect(blk.picks[1].noBuyRowGray).toBeUndefined();
    expect(blk.reason).not.toContain('第四·d');
  });

  it('卖点侧：追加「不标持有」说明；已被更高优先级改写（devRuleStage）的行跳过', () => {
    const blk = build(11);
    const out = {
      blocks: [blk],
      sell: [{
        items: [
          { name: '竞业达', sellActionTag: '竞价卖', actionNote: '原本的卖点说明' },
          { name: '竞业达', sellActionTag: '异动卖', actionNote: '异动原因', devRuleStage: 'severe' }
        ]
      }]
    };
    const n = _applyBigSecondR10SellNote(out);
    expect(n).toBe(1);
    expect(out.sell[0].items[0].actionNote).toContain('第四·d');
    expect(out.sell[0].items[0].actionNote).toContain('不标【持有】');
    expect(out.sell[0].items[0].actionNote).toContain('原本的卖点说明');
    // 高优先级行原样
    expect(out.sell[0].items[1].actionNote).toBe('异动原因');
  });
});
