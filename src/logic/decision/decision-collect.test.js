// decision-collect.test.js — 「停牌判定的名单出口」suspendEntriesOf 的单测
// （§15 独立业务模块 / §6 单一真相：三个选股看板都从这里拿名单，⛔ 谁都不许自己再遍历一遍）
//
// 为什么要单测：这个函数是「看板上到底会不会出现停牌标」的第一道闸门 ——
//   买点票漏收 ⇒ 那只停牌票不标；形态认错（只读 .picks、不认数组）⇒ 整侧不标。
//   两种都不会报错，只会静默少一枚标签，所以必须钉死。

import { describe, it, expect } from 'vitest';
import { suspendEntriesOf } from './decision-collect.js';

describe('decision-collect · suspendEntriesOf（停牌名单出口，三个选股看板共用）', () => {
  it('买点（buildBuyPlan 形状）+ 卖点分组：两侧都收，并按名字去重', () => {
    const buy = {
      heavy: { block: { topic: 'AI应用' }, picks: [{ name: '三六零', code: '601360' }] },
      light: { block: { topic: '文化传媒' }, picks: [{ name: '新华传媒', code: '600825' }] },
      candidates: [], noYizi: null, smallTopic: null, bigTopic: null
    };
    const sell = [{
      topic: '文化传媒',
      items: [{ name: '新华传媒', code: '600825' }, { name: '东方明珠', code: '600637' }]
    }];
    // 顺序 = heavy → light → … → 卖点；新华传媒在卖点侧是重复项，只出一次
    expect(suspendEntriesOf(buy, sell)).toEqual([
      { stock: '三六零', code: '601360' },
      { stock: '新华传媒', code: '600825' },
      { stock: '东方明珠', code: '600637' }
    ]);
  });

  it('★ 兜底方案外壳（.blocks）里的票也要收到 —— ⛔ 不能只读 .picks', () => {
    const buy = {
      heavy: null, light: null, candidates: [],
      // 三个兜底槽位是【方案外壳】：没有 .block / .picks，真正的块在 .blocks 里
      noYizi: {
        mode: 'noYizi', qualified: true,
        blocks: [{ block: { topic: 'T' }, picks: [{ name: '大亚圣象', code: '000910' }] }]
      },
      smallTopic: null, bigTopic: null
    };
    expect(suspendEntriesOf(buy, null).map(function(e) { return e.stock; })).toEqual(['大亚圣象']);
  });

  it('★ 分笔看板形态：直接传【已摊平的块数组】也认（两种形状都收，不让调用方自己转换）', () => {
    const buyBlocks = [{ topic: 'T', picks: [{ name: '新华传媒', code: '600825' }] }];
    expect(suspendEntriesOf(buyBlocks, [])).toEqual([{ stock: '新华传媒', code: '600825' }]);
  });

  it('§10：拿不到代码的行不参与判定（⛔ 不塞空 code、不猜）', () => {
    const buy = {
      heavy: { block: {}, picks: [{ name: '某票' }] },   // 无 code，名册也没有它
      light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null
    };
    expect(suspendEntriesOf(buy, null)).toEqual([]);
  });

  it('空计划 / null / undefined ⇒ 空数组，不抛错', () => {
    expect(suspendEntriesOf(null, null)).toEqual([]);
    expect(suspendEntriesOf(undefined, [])).toEqual([]);
    expect(suspendEntriesOf([], null)).toEqual([]);
    expect(suspendEntriesOf(null, [{ topic: 'T' }])).toEqual([]);   // 组里没有 items 也不炸
  });

  it('只有名字没有代码的行在【买卖两侧】都被跳过（卖点侧同一口径）', () => {
    const sell = [{ topic: 'T', items: [{ name: '只有名字' }, { name: '有代码', code: '600637' }] }];
    expect(suspendEntriesOf(null, sell)).toEqual([{ stock: '有代码', code: '600637' }]);
  });
});
