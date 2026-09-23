// inherited-sold.js — 「昨日打过『卖』标签 → 继承到今天的复盘行」判定（§15 独立业务模块）
//
// 为什么单开一个模块：
//   早盘竞价看板里有一类行，它们【不在当天 9:25 正式成员索引】里，是标签继承机制
//   （tagTitles/rules.js#ensureBoughtStocksForDate，worker / Edge Function 共用同一套口径的
//   tag-carryover）把「前一天打过买卖标签」的股票带进当天列表的。
//   正式成员索引刻意排除 obs_auto_added 行（watchlist-and-metrics.js：newWatchlistSet 只对
//   !row.obs_auto_added 添加），所以这类行在数据层就明确不是「当天正式成员」。
//
// 用户口径（2026-09-23）：其中【昨天打的是「卖」】的那些 —— 已经卖掉、只剩复盘价值 ——
//     · 股票名 + 题材画灰；
//     · 不计入任何题材统计（组大小 / 一字数 / 统计条数量 / 五日趋势名次）。
//   昨天打的是「买」的（还在跟踪）保持原样：常规黑色、照常计入。
//
//   实测 2026-09-23：双星新材 / 通鼎互联 / 启明信息 = 09-22 卖 → 灰、不计数；
//                    会稽山 / 澳弘电子 / 国芳集团 = 09-22 买 → 不变。
//   （电子/通信/算力 组因此由 7 只回到实际的 5 只。）
//
// ⛔ 判据收在这里（§6 单一真相）：view-helpers（当天统计 + 着色）与 topic-trend（五日趋势）
//   两处都必须调它，绝不各写一份 —— 一旦分叉，「统计条数字」与「趋势名次」立刻错位
//   （这正是 2026-09-23 之前连续两轮返工的根因）。

import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
import { _getAuctionWatchlistSet, _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';

/**
 * 取某日「由昨日『卖』标签继承而来、且不是当天正式成员」的股票名集合。
 *
 * ⛔ 两道闸门，缺一不可：
 *   ① 标签必须是【前一日】的 sell ——  Inheritance 只继承一天，「昨天之前卖过」不算；
 *   ② 该股必须【不是】当天正式成员 —— 既在 9:25 名单里、昨天又卖过，它就是当天正式的一只，
 *      ⛔ 绝不能因为昨天的卖标签把它抹灰 / 踢出统计（否则正式成员会凭空消失）。
 *
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {string|null} prevDate 前一个交易日；null/空 = 无前一日 → 返回空集
 * @returns {Set<string>} 需要遮灰 + 不计入统计的股票名（trim 后）
 */
export function getPrevSoldInheritedSet(date, prevDate) {
  const out = new Set();
  if (!date || !prevDate) return out;

  // §10：正式成员索引未就绪 = 「还没拉到」，此时 watchSet 是空集，
  //      会让所有「昨天卖过」的行都被误判成继承行 ⇒ 宁可不遮，也绝不整片刷灰。
  if (!_isAuctionWatchlistIndexReady(date)) return out;

  const watchSet = _getAuctionWatchlistSet(date);

  let dayTags = {};
  try {
    const tags = useAuctionTagStore().tags || {};
    dayTags = tags[prevDate] || {};
  } catch (e) {
    return out; // 标签库尚未加载 ⇒ 同上（§10 不凭空判定）
  }

  Object.keys(dayTags).forEach(function(name) {
    if (dayTags[name] !== 'sell') return;
    const nm = String(name === null || name === undefined ? '' : name).trim();
    if (!nm) return;
    if (watchSet.has(nm)) return; // 当天正式成员 → 不受昨日卖标签影响
    out.add(nm);
  });
  return out;
}
