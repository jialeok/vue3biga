// inherited-sold.test.js — 「昨日『卖』标签继承过来的复盘行」判定回归用例
//
// 背景：这个判据连续三轮返工（2026-09-23）。判据只有一条：**前一日**打了 sell 标签
//   **且** 该股不是当天正式成员。两道闸门缺一不可 —— 少任何一道都会误伤：
//   ① 不限「前一日」→ 一周前卖过、今天正式在列的股票被抹灰；
//   ② 不排除当天正式成员 → 9:25 名单里的票因为昨天的卖标签凭空消失。
// 所以把它钉死在测试里，防止后人（包括 AI）再改回去。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = {
  tags: {},
  watchlist: {},          // date → string[]
  indexReadyDates: []     // 「索引已就绪」的日期
};

vi.mock('../../stores/auctionTagStore.js', () => ({
  useAuctionTagStore: () => ({ tags: mockState.tags })
}));

vi.mock('../../data/watchlist-and-metrics.js', () => ({
  _getAuctionWatchlistSet: (date) => new Set(mockState.watchlist[date] || []),
  _isAuctionWatchlistIndexReady: (date) => mockState.indexReadyDates.includes(date)
}));

import { getPrevSoldInheritedSet } from './inherited-sold.js';

beforeEach(() => {
  mockState.tags = {};
  mockState.watchlist = {};
  mockState.indexReadyDates = [];
});

describe('getPrevSoldInheritedSet', () => {
  it('昨日 sell 标签 + 不在当天正式成员 → 判为继承行（应画灰、不计入统计）', () => {
    mockState.indexReadyDates = ['2026-09-23'];
    mockState.watchlist['2026-09-23'] = ['大会稽山', '澳弘电子'];
    mockState.tags['2026-09-22'] = { '通鼎互联': 'sell', '双星新材': 'sell' };

    const set = getPrevSoldInheritedSet('2026-09-23', '2026-09-22');
    expect([...set].sort()).toEqual(['双星新材', '通鼎互联']);
  });

  it('昨日 buy 标签继承的（仍在跟踪）不算继承行 —— 保持黑色、照常计入', () => {
    mockState.indexReadyDates = ['2026-09-23'];
    mockState.watchlist['2026-09-23'] = [];
    mockState.tags['2026-09-22'] = { '会稽山': 'buy', '澳弘电子': 'buy', '国芳集团': 'buy' };

    expect(getPrevSoldInheritedSet('2026-09-23', '2026-09-22').size).toBe(0);
  });

  it('⛔ 当天已经是正式成员 → 绝不能因为昨天的卖标签被抹灰（否则正式成员凭空消失）', () => {
    mockState.indexReadyDates = ['2026-09-23'];
    mockState.watchlist['2026-09-23'] = ['娅珍集团'];
    mockState.tags['2026-09-22'] = { '娅珍集团': 'sell', '别的票': 'sell' };

    const set = getPrevSoldInheritedSet('2026-09-23', '2026-09-22');
    expect(set.has('娅珍集团')).toBe(false);
    expect(set.has('别的票')).toBe(true);
  });

  it('§10 正式成员索引未就绪 → 返回空集（宁可不遮，也绝不整片刷灰）', () => {
    mockState.indexReadyDates = [];               // 未就绪
    mockState.watchlist['2026-09-23'] = [];       // 看起来「一只正式成员都没有」
    mockState.tags['2026-09-22'] = { '任意票': 'sell' };

    expect(getPrevSoldInheritedSet('2026-09-23', '2026-09-22').size).toBe(0);
  });

  it('无前一日 / 无当日 → 返回空集（不抛错）', () => {
    mockState.indexReadyDates = ['2026-09-23'];
    mockState.tags['2026-09-22'] = { '票A': 'sell' };
    expect(getPrevSoldInheritedSet('2026-09-23', null).size).toBe(0);
    expect(getPrevSoldInheritedSet(null, '2026-09-22').size).toBe(0);
  });

  it('只认 sell：hold / buy 都不算继承行', () => {
    mockState.indexReadyDates = ['2026-09-23'];
    mockState.watchlist['2026-09-23'] = [];
    mockState.tags['2026-09-22'] = { '甲': 'hold', '乙': 'buy', '丙': 'sell' };

    expect([...getPrevSoldInheritedSet('2026-09-23', '2026-09-22')]).toEqual(['丙']);
  });
});
