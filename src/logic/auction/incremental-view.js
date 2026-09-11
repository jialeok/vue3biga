// src/logic/auction/incremental-view.js
// A3-01（§17/§23/§29 增量更新）：单格编辑后只重新派生“变化的行”，未变化的行复用缓存的派生对象，
// 配合 AuctionBoard 模板的 v-memo，避免整表 DOM 重渲染与下游（obsItems/regularItems/filteredItems）无谓抖动。
//
// 正确性保证（fail-soft、绝不产生陈旧数据）：
//   派生对象的所有“行内输入”进入 rowSig；所有“全局输入”（高光集合 / 标签集合 / 日期 / 排序状态）进入 globalFingerprint。
//   - 任一全局集合变化 → globalFingerprint 改变 → 整缓存清空 → 所有行都重新派生（新鲜）。
//   - 仅某行“行内输入”变化 → 仅该行 rowSig 失配 → 仅该行重新派生；其余行复用缓存对象（输入完全相同，结果必然一致）。
//   任何失配都回退到 computeAuctionViewData 的新鲜结果，不存在“看起来更新了实际没更新”的风险。

import { computeAuctionViewData } from './view-helpers.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getGroupData } from '../app-core-api.js';
import {
  getHighRatioStocksForDate,
  getJingYestHighlightSetForDate,
  getParallelStocksForDate
} from './sort-rules.js';
import { getThreeDayJingDieSet, getVolGrabSet } from './sort-rules-extra.js';
import { deriveAuctionTagState } from '../tagTitles/rules.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
// [DRAGON 2026-09-09] 龙头徽章依赖异步加载的 10 日区间涨幅，必须进全局指纹，
// 否则数据到达后行缓存不失效 → 徽章不显示（或陈旧）。
import { getDragonFingerprintToken } from './dragon-rank.js';
// [TOPIC-STATS 2026-09-10] 题材块统计条签名（挂在组内首行上，需单独进 rowSig）
import { topicStatsSignature } from './topic-stats.js';

const rowCache = new Map(); // key: `${dataSource}|${index}` -> { sig, item }
let lastGlobalFingerprint = '';

function setToSortedStr(set) {
  if (!set) return '';
  const arr = [];
  set.forEach((v) => arr.push(v));
  return arr.sort().join(',');
}
function mapToStr(map) {
  if (!map) return '';
  const arr = [];
  map.forEach((v, k) => arr.push(k + ':' + v));
  return arr.sort().join(',');
}
// [VOL-GRAB 2026-09-05] 量比抢筹集合序列化为指纹串。
// 值为 { volRatio, bidPct } 对象，直接用 mapToStr 会退化成 [object Object]，导致量比/抢筹数值变化
// 无法被感知 → 行缓存不失效 → 高光 class 陈旧复用。必须把两个数值都写进指纹。
function volGrabMapToStr(map) {
  if (!map) return '';
  const arr = [];
  map.forEach((v, k) => arr.push(k + ':' + (v ? v.volRatio : '') + '/' + (v ? v.bidPct : '')));
  return arr.sort().join(',');
}

function computeGlobalFingerprint(dataSource, date, sortState) {
  let high = '';
  let jing = '';
  let par = '';
  let three = '';
  let vgrab = '';
  let confirmed = '';
  try { high = setToSortedStr(getHighRatioStocksForDate(date, dataSource).stockNames); } catch (e) { high = ''; }
  try { vgrab = volGrabMapToStr(getVolGrabSet(date, dataSource)); } catch (e) { vgrab = ''; }
  try { jing = setToSortedStr(getJingYestHighlightSetForDate(date, dataSource)); } catch (e) { jing = ''; }
  try { par = setToSortedStr(getParallelStocksForDate(date, dataSource)); } catch (e) { par = ''; }
  try { three = mapToStr(getThreeDayJingDieSet(date, dataSource)); } catch (e) { three = ''; }
  try {
    // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
    const tags = useAuctionTagStore().tags;
    const sold = [];
    Object.keys(tags).forEach((d) => {
      if (d > date) return;
      const dayTags = tags[d] || {};
      Object.keys(dayTags).forEach((n) => { if (dayTags[n] === 'sell') sold.push(n); });
    });
    confirmed = sold.sort().join(',');
  } catch (e) { confirmed = ''; }

  const s = sortState || {};
  return [
    'date=' + date,
    'byWeakStrong=' + (s.byWeakStrong ? 1 : 0),
    'byRatio=' + (s.byRatio ? 1 : 0),
    'byParallel=' + (s.byParallel ? 1 : 0),
    'byJingYest=' + (s.byJingYest ? 1 : 0),
    'byJingYestRatio=' + (s.byJingYestRatio ? 1 : 0),
    'byThreeDayJingDie=' + (s.byThreeDayJingDie ? 1 : 0),
    'byTopic=' + (s.byTopic ? 1 : 0),
    'high=' + high,
    'jing=' + jing,
    'par=' + par,
    'three=' + three,
    'vgrab=' + vgrab,
    'dragon=' + getDragonFingerprintToken(),
    'confirmed=' + confirmed
  ].join('|');
}

function computeRowSig(item, sortState, date, prevVolume, prevYestVolume, wsToken, vgToken) {
  const stockName = (item.stock || '').trim();
  let sold = false, bought = false, selected = false;
  try {
    const ts = deriveAuctionTagState(stockName, date, null, true);
    sold = !!ts.sold;
    bought = !!ts.bought;
    selected = !!ts.selected;
  } catch (e) {}
  const s = sortState || {};
  return [
    stockName,
    item.volume,
    item.yestVolume,
    item.note,
    item.topics,
    item.todayChoice, // AuctionBadge 渲染「买→/卖→」等当日选项，必须纳入签名避免陈旧
    date,
    s.byWeakStrong ? 1 : 0, s.byRatio ? 1 : 0, s.byParallel ? 1 : 0,
    s.byJingYest ? 1 : 0, s.byJingYestRatio ? 1 : 0, s.byThreeDayJingDie ? 1 : 0, s.byTopic ? 1 : 0,
    'ws=' + (wsToken || 0), // [WEAK-STRONG 2026-09-01] 弱转强达标档(连跌天数)变化需触发该行重派生，否则高光 class 被增量缓存陈旧复用
    'yizi=' + (item.isYiZi ? 1 : 0), // [YIZI 2026-09-09] 竞价一字状态（竞价涨幅达标）变化需触发重派生，否则红线标记陈旧
    // [DRAGON-COLOR 2026-09-11] 龙头徽章底色 = 当天竞价涨幅符号（红/绿/灰）→ 该数值必须入签名，
    // 否则增量缓存会复用旧行对象、徽章底色陈旧。注意不能用上方 yizi= 代替：yizi 只捕捉「跨过涨停线」
    // 的跳变，捕捉不到普通涨跌方向改变（如 +1.2% → -0.8% 两者都不是一字）。
    'auc=' + (item.aucPctNum === null || item.aucPctNum === undefined ? '' : item.aucPctNum),
    // [CLOSE-LIMIT / CLOSE-COUNT 2026-09-11] 收盘停板标记（红/绿蚂蚁线）与收盘涨幅数值：
    //   收盘覆盖会在 15:00~16:00 之间把 change_pct 从竞价副本改成收盘值，行内其它输入（volume/note…）
    //   完全没变 → 不把这些派生值入签名，行缓存会继续复用「没有蚂蚁线」的旧行对象。
    'cl=' + (item.closeLimit || ''),
    'cp=' + (item.closePct === null || item.closePct === undefined ? '' : item.closePct),
    // [CLOSE-NAME-COLOR 2026-09-11] 股票名字体颜色档位（收盘涨幅符号）。虽然它由上方 cp= 派生、
    //   且 byTopic 已在签名里，但模板会直接读它 → 按红线单独入签名，避免日后 tone 的来源/口径
    //   变化时被增量缓存陈旧复用（cp= 只保证数值一致，不保证「读取口径」一致）。
    'nt=' + (item.closeNameTone || ''),
    // [TOPIC-SEQ 2026-09-11] 同题材组内序号：组内任何一只票增删/换题材都会改变本行的序号，
    //   但本行自身的行内输入可以完全没变 → 必须单独入签名，否则序号陈旧。
    'seq=' + (item.seqNo || 0),
    // [TOPIC-STATS 2026-09-10] 题材块统计条挂在【该组第一行】上：组内任何一只票的一字/高开/龙头变化
    // 都会改变统计数字，但首行自身的行内输入可能没变 → 必须单独入签名，否则统计条数字陈旧。
    'ts=' + (item.topicStats ? topicStatsSignature(item.topicStats) : ''),
    'vg=' + (vgToken || 0), // [VOL-GRAB 2026-09-05] 量比抢筹达标状态(0/1)变化需触发该行重派生，否则高光 class 陈旧复用
    prevVolume, prevYestVolume,
    sold ? 1 : 0, bought ? 1 : 0, selected ? 1 : 0
  ].join('|');
}

export function computeAuctionViewDataIncremental(dataSource, sortState) {
  const result = computeAuctionViewData(dataSource, sortState);
  const date = result.date;
  const globalFingerprint = computeGlobalFingerprint(dataSource, date, sortState);
  if (globalFingerprint !== lastGlobalFingerprint) {
    rowCache.clear();
    lastGlobalFingerprint = globalFingerprint;
  }

  const prevDate = getPreviousTradingDay(date);
  const prevList = prevDate ? (getGroupData(dataSource)[prevDate] || []) : [];
  const prevMap = new Map();
  for (const p of prevList) {
    if (p && p.stock) prevMap.set(p.stock.trim(), p);
  }

  const items = result.items || [];
  const wsSet = result.weakStrongSet;
  const vgSet = result.volGrabSet;
  const next = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stockName = (item.stock || '').trim();
    const prev = stockName ? prevMap.get(stockName) : null;
    const wsTok = (sortState && sortState.byWeakStrong && wsSet && stockName) ? (wsSet.get(stockName) || 0) : 0;
    const vgTok = (sortState && sortState.byRatio && vgSet && stockName && vgSet.has(stockName)) ? 1 : 0;
    const sig = computeRowSig(item, sortState, date, prev ? prev.volume : '', prev ? prev.yestVolume : '', wsTok, vgTok);
    const key = dataSource + '|' + item.index;
    const cached = rowCache.get(key);
    if (cached && cached.sig === sig) {
      next[i] = cached.item;
    } else {
      rowCache.set(key, { sig, item });
      next[i] = item;
    }
  }
  result.items = next;

  // 清理本数据源下已不存在的行，避免内存泄漏
  const validKeys = new Set(items.map((it) => dataSource + '|' + it.index));
  rowCache.forEach((_v, k) => {
    if (k.indexOf(dataSource + '|') === 0 && !validKeys.has(k)) rowCache.delete(k);
  });

  return result;
}

// 日期切换 / 数据源卸载时调用，主动清空缓存
export function clearAuctionViewCache(dataSource) {
  if (!dataSource) {
    rowCache.clear();
    lastGlobalFingerprint = '';
    return;
  }
  rowCache.forEach((_v, k) => {
    if (k.indexOf(dataSource + '|') === 0) rowCache.delete(k);
  });
}
