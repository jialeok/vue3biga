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
import { getThreeDayJingDieSet } from './sort-rules-extra.js';
import { deriveAuctionTagState } from '../tagTitles/rules.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';

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

function computeGlobalFingerprint(dataSource, date, sortState) {
  let high = '';
  let jing = '';
  let par = '';
  let three = '';
  let confirmed = '';
  try { high = setToSortedStr(getHighRatioStocksForDate(date, dataSource).stockNames); } catch (e) { high = ''; }
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
    'byData=' + (s.byData ? 1 : 0),
    'byRatio=' + (s.byRatio ? 1 : 0),
    'byParallel=' + (s.byParallel ? 1 : 0),
    'byJingYest=' + (s.byJingYest ? 1 : 0),
    'byJingYestRatio=' + (s.byJingYestRatio ? 1 : 0),
    'byThreeDayJingDie=' + (s.byThreeDayJingDie ? 1 : 0),
    'high=' + high,
    'jing=' + jing,
    'par=' + par,
    'three=' + three,
    'confirmed=' + confirmed
  ].join('|');
}

function computeRowSig(item, sortState, date, prevVolume, prevYestVolume) {
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
    item.todayChoice, // AuctionBadge 渲染「买→/卖→」等当日选项，必须纳入签名避免陈旧
    date,
    s.byData ? 1 : 0, s.byRatio ? 1 : 0, s.byParallel ? 1 : 0,
    s.byJingYest ? 1 : 0, s.byJingYestRatio ? 1 : 0, s.byThreeDayJingDie ? 1 : 0,
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
  const next = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stockName = (item.stock || '').trim();
    const prev = stockName ? prevMap.get(stockName) : null;
    const sig = computeRowSig(item, sortState, date, prev ? prev.volume : '', prev ? prev.yestVolume : '');
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
