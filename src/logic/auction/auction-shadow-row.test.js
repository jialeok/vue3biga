// auction-shadow-row.test.js —— 【§6 影子行红线 回归】
//
// 2026-09-30 事故：决策看板首屏把「会稽山 / 内蒙新华」推给用户，用户据错买入；
// 稍后自愈成正确的「大亚圣象 / 新华文轩」。
//
// 根因（证据链见 memory/2026-09-30）：
//   market_metrics(scope='auction') 里有一批「不在 auction_watchlist」的影子行
//   （9/30 实测：metrics 60 行 / watchlist 42 行，差集 18 只，含会稽山）。
//   影子行在内存对象上原本没有任何身份字段，只有 `obsAutoAdded` 一个可被外部改写的布尔量；
//   tagTitles/rules.js#_addOne 落到「该票已在当日列表里」分支时会给它打上 obsAutoAdded=true
//   ⇒ 影子行冒充「观察组继承行」被 getTodayGroupList 放行 ⇒ 计入「大消费」只数（4→5）
//   ⇒ 题材只数被多算一只 ⇒ 当天买点整块翻转
//      （当时翻转的机关是 ⑥小题材兜底 isSmallRiskyTopic，上限恰为 4；该规则已于 2026-10-01 删除，
//        但「题材只数」现在直接决定买几只：≥10 → 3 只 / 7~9 → 2 只 / 4~6 → 1 只 / ≤3 → 不出票，
//        多算一只照样会跨档多买 ⇒ 本不变量【继续成立，不可放宽】）
//   ⇒ 输出 [AI应用]新华文轩+内蒙新华 / [大消费]会稽山（= 用户看到的错票组合）。
//   又因为 patchAuctionFieldBatch 只对正式成员写 watchlistPatch，这个标记**写不进云端**
//   ⇒ 刷新后丢失 ⇒ 同一只票「时有时无」，表现为「先错后自动恢复正常」。
//
// 本用例把不变量固化：**影子行永远不进 auction 分组列表**，且不得误杀真正的观察组行。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// localStorage 垫片：本模块链路会读 '..._migrated' 标记
const _lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => { const key = String(k); if (key.indexOf('_migrated') >= 0) return '1'; return _lsMap.has(key) ? _lsMap.get(key) : null; },
  setItem: (k, v) => { _lsMap.set(String(k), String(v)); },
  removeItem: (k) => { _lsMap.delete(String(k)); },
  clear: () => _lsMap.clear(),
  key: (i) => Array.from(_lsMap.keys())[i] || null,
  get length() { return _lsMap.size; }
};

setActivePinia(createPinia());

vi.mock('../auction/dragon-rank.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDragonRangePct: () => null };
});
vi.mock('../auction/dragon-group.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDragonLeadersForDisplay: () => null };
});

import { state } from '../app-state.js';
import { getTodayGroupList } from './auction-helpers.js';
import { _getAuctionFormalRowsForDate, _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';

const DATE = '2026-09-30';

/** 正式成员行（来自 auction_watchlist，obs_auto_added=false） */
const formalRow = (stock) => ({ stock, code: '', volume: '100', yestVolume: '200', changePct: '+1.00%', topics: '', obsAutoAdded: false, shadowRow: false });
/** 观察组继承行（来自 auction_watchlist，obs_auto_added=true） */
const obsRow = (stock) => ({ stock, code: '', volume: '', yestVolume: '', note: '', obsAutoAdded: true, shadowRow: false });
/** market_metrics 影子行（不在 auction_watchlist）；可显式模拟「被误打 obs 标记」 */
const shadowRow = (stock, polluted) => ({ stock, code: '', volume: '50', yestVolume: '80', change_pct: '-0.50%', auc_pct_chg: '+0.00%', open_bid_pct: '0.00', um_vol: '0', shadowRow: true, ...(polluted ? { obsAutoAdded: true } : {}) });

beforeEach(() => {
  state._auctionMemCache = {};
  state._auctionWatchlistIndex = {};
});

describe('§6 影子行红线：market_metrics 影子行不得进入 auction 分组列表', () => {
  it('关键回归：影子行即使被误打 obsAutoAdded=true，也不进列表（9/30 会稽山场景）', () => {
    state._auctionMemCache[DATE] = [
      formalRow('大亚圣象'),
      obsRow('新华文轩'),
      shadowRow('会稽山', true),        // ← 事故主角：metrics 影子行 + 误打的 obs 标记
      shadowRow('电科思仪', true),
      shadowRow('南华生物', false)
    ];
    state._auctionWatchlistIndex[DATE] = new Set(['大亚圣象']);   // 索引只含正式成员（§6）

    const list = getTodayGroupList('auction', DATE);
    const names = list.map((r) => r.stock);

    expect(names).toContain('大亚圣象');      // 正式成员：保留
    expect(names).toContain('新华文轩');      // 真观察组行：保留（不误杀）
    expect(names).not.toContain('会稽山');    // 影子行：剔除（无论有没有 obs 标记）
    expect(names).not.toContain('电科思仪');
    expect(names).not.toContain('南华生物');
    expect(list.length).toBe(2);
  });

  it('_getAuctionFormalRowsForDate 同口径：影子行不算「当日正式名单行」', () => {
    state._auctionMemCache[DATE] = [formalRow('大亚圣象'), obsRow('新华文轩'), shadowRow('会稽山', true)];
    state._auctionWatchlistIndex[DATE] = new Set(['大亚圣象']);

    const rows = _getAuctionFormalRowsForDate(DATE).map((r) => r.stock);
    expect(rows).toContain('大亚圣象');
    expect(rows).toContain('新华文轩');
    expect(rows).not.toContain('会稽山');
  });

  it('显式行身份不被误判：shadowRow=false 的正式/观察行全部保留', () => {
    state._auctionMemCache[DATE] = [formalRow('A股'), formalRow('B股'), obsRow('C股')];
    state._auctionWatchlistIndex[DATE] = new Set(['A股', 'B股']);

    const names = getTodayGroupList('auction', DATE).map((r) => r.stock);
    expect(names.sort()).toEqual(['A股', 'B股', 'C股']);
  });

  it('§10 不回归：索引未就绪时仍退化为原始列表（不按名单过滤、不静默清空）', () => {
    state._auctionMemCache[DATE] = [formalRow('大亚圣象'), shadowRow('会稽山', true)];
    delete state._auctionWatchlistIndex[DATE];      // 索引未就绪

    expect(_isAuctionWatchlistIndexReady(DATE)).toBe(false);
    // 索引未就绪 = 「还没拉到」，此时按原始列表兜底显示，避免看板整块空白
    expect(getTodayGroupList('auction', DATE).map((r) => r.stock)).toEqual(['大亚圣象', '会稽山']);
  });

  it('hot 分组不受本规则影响（hot_stocks 表天然只有正式成员）', () => {
    state._hotAuctionData = { [DATE]: [{ stock: '热门一' }, { stock: '热门二' }] };
    expect(getTodayGroupList('hot', DATE).map((r) => r.stock)).toEqual(['热门一', '热门二']);
  });
});
