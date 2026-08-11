import { getTodayGroupList, getGroupData, getAuctionData } from './app-core-api.js';
import { getPreviousTradingDay } from './trading-day-helpers.js';
import { getHighRatioStocksForDate, getParallelStocksForDate, getJingYestHighlightSetForDate, getDigitCount, getRatioDiffInfoForDate } from './auction-sort-rules.js';
import { getAuctionStockHistory, ensureBoughtStocksForDate, deriveAuctionTagState } from './tag-rules.js';
import { getThreeDayJingDieSet } from './sort-rules-extra.js';
import { getNumericVolume, getStocksData } from '../data/supabase-client.js';
import { state } from './app-state.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { getAuctionTagState } from './ui-bridge.js';
import { getDisplayNote } from './note-helpers.js';

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  try {
    const tags = JSON.parse(localStorage.getItem('auctionBoardTags') || '{}');
    return (tags[date] && tags[date][stockName.trim()]) || null;
  } catch { return null; }
}

function _enrichAuctionItem(rawItem, index, ctx) {
  if (!rawItem) return null;
  const stockName = rawItem.stock ? rawItem.stock.trim() : '';
  const volume = parseFloat(rawItem.volume) || 0;
  const yestVolume = parseFloat(rawItem.yestVolume) || 0;
  const note = getDisplayNote(rawItem);

  let ratioValue = 0;
  let ratioDisplay = '-';
  if (yestVolume > 0) {
    ratioValue = (volume / yestVolume) * 100;
    ratioDisplay = Math.round(ratioValue) + '%';
  }

  let ratioArrow = '';
  if (ctx.prevAuctionList && ctx.prevAuctionList.length > 0 && stockName) {
    const prevItem = ctx.prevAuctionList.find(p => p.stock && p.stock.trim() === stockName);
    if (prevItem && prevItem.yestVolume) {
      const prevVolume = parseFloat(prevItem.volume) || 0;
      const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
      if (prevYestVolume > 0) {
        const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
        const currRatio = Math.round(ratioValue);
        if (currRatio > prevRatio) ratioArrow = '⬆';
        else if (currRatio < prevRatio) ratioArrow = '⬇';
      }
    }
  }

  const _solidState = getAuctionTagState(stockName, ctx.date);
  const isSold = _solidState.sold;
  const isSelected = !isSold && (_solidState.selected || _solidState.bought);
  const isBought = false;
  const isConfirmedSold = isSold || (stockName && ctx.confirmedSoldSet && ctx.confirmedSoldSet.has(stockName));
  const isFixed = isSold || isSelected;
  const isObsInheritedBought = false;
  const isGray = !isSelected && !isSold && ratioValue < 4.5;

  let itemClass = 'auction-item';
  if (isSold) {
    itemClass += ' sold';
  } else if (isConfirmedSold && !isSold) {
    // 已确认卖出但非当天手动卖出：常规展示
  } else if (isBought && !isObsInheritedBought) {
    itemClass += ' bought';
  } else if (isSelected && isFixed) {
    itemClass += ' selected';
  } else if (isSelected && !isFixed) {
    itemClass += ' manual-selected';
  }

  const isJingYestMatch = ctx.jingYestToggleChecked && ctx.jingYestHighlightSet && stockName && ctx.jingYestHighlightSet.has(stockName);
  const isParallelMatch = ctx.sortByParallelEnabled && !ctx.jingYestToggleChecked && stockName && ctx.parallelStocksToday && ctx.parallelStocksToday.has(stockName);
  const isHighRatioMatch = ctx.sortByRatioEnabled && stockName && ctx.highRatioToday && ctx.highRatioToday.stockNames && ctx.highRatioToday.stockNames.has(stockName);
  const isThreeDayJingDieMatch = ctx.sortByThreeDayJingDieEnabled && ctx.threeDayJingDieSet && stockName && (ctx.threeDayJingDieSet.get(stockName) || 0) >= 2;
  if (isJingYestMatch) {
    itemClass += ' jing-yest-match';
  } else if (isParallelMatch) {
    itemClass += ' parallel-match';
  } else if (isThreeDayJingDieMatch) {
    itemClass += ' three-day-jing-die';
  } else if (isHighRatioMatch) {
    itemClass += ' high-ratio';
  }

  let numberClass = 'auction-number auction-trend-trigger';
  if (isGray) numberClass += ' gray-text';

  let stockClass = 'auction-stock-name auction-note-trigger';


  let ratioClass = 'auction-ratio auction-ratio-clickable';
  if (ratioValue >= 10) {
    ratioClass += ' highlight';
  } else if (ratioValue >= 4.5 && ratioValue < 10) {
    ratioClass += ' highlight-light';
  }

  let yestColorClass = 'auction-yest auction-yest-note';
  if (note) {
    if (note.includes('涨停')) {
      yestColorClass += ' auction-yest-red';
    } else if (note.includes('跌停')) {
      yestColorClass += ' auction-yest-green';
    } else {
      const numMatches = note.match(/-?\d+\.?\d*/g);
      if (numMatches && numMatches.length > 0) {
        const lastNum = parseFloat(numMatches[numMatches.length - 1]);
        if (lastNum > 0) yestColorClass += ' auction-yest-red';
        else if (lastNum < 0) yestColorClass += ' auction-yest-green';
      }
    }
  }

  const volumeDisplay = rawItem.volume ? Math.round(parseFloat(rawItem.volume)) : '-';
  const yestVolumeDisplay = rawItem.yestVolume ? Math.round(parseFloat(rawItem.yestVolume)) : '-';

  return {
    index,
    stock: stockName,
    volume: rawItem.volume || '',
    yestVolume: rawItem.yestVolume || '',
    volumeDisplay,
    yestVolumeDisplay,
    ratio: ratioDisplay,
    ratioArrow,
    ratioClass,
    numberClass,
    stockClass,
    itemClass,
    yestColorClass,
    note,
    bought: isBought,
    sold: isSold,
    selected: isSelected,
    confirmedSold: isConfirmedSold,
    todayChoice: _getAuctionTag(ctx.date, stockName),
    isGray
  };
}

export function computeAuctionViewData(dataSource, sortStateOverride) {
  dataSource = dataSource || 'auction';
  const _p = dataSource === 'hot' ? 'hot' : 'auction';
  const currentDate = state.currentDate;

  if (dataSource !== 'hot') {
    try { ensureBoughtStocksForDate(currentDate); } catch (e) { console.warn('ensureBoughtStocksForDate failed:', e); }
  }

  const auctionList = getTodayGroupList(dataSource);
  if (!auctionList || auctionList.length === 0) {
    return { items: [], obsIndices: [], regularIndices: [], hiddenObsIndices: [], stats: { todayStrength: null, yesterdayStrength: null, strongCount: 0, totalCount: 0, highRatioCount: 0, jingYestCount: 0 }, rawCount: 0, date: currentDate, dataSource };
  }

  const prevDate = getPreviousTradingDay(currentDate);
  const auctionData = getGroupData(dataSource);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
  const prevPrevAuctionList = prevPrevDate ? (auctionData[prevPrevDate] || []) : [];

  let sortState;
  if (sortStateOverride) {
    sortState = sortStateOverride;
  } else {
    try {
      const store = useAuctionStore();
      sortState = store && store.sortState ? store.sortState[_p] : { byData: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false };
    } catch {
      sortState = { byData: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false };
    }
  }

  const highRatioToday = getHighRatioStocksForDate(currentDate, dataSource);
  const jingYestHighlightSet = getJingYestHighlightSetForDate(currentDate, dataSource);
  const parallelStocksToday = getParallelStocksForDate(currentDate, dataSource);
  const jingYestToggleChecked = sortState.byJingYest || sortState.byJingYestRatio;

  let strongCount = 0;
  auctionList.forEach(item => {
    let hasDown = false;
    if (prevAuctionList.length > 0 && item.stock) {
      const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
      if (prevItem && prevItem.yestVolume) {
        const prevVolume = parseFloat(prevItem.volume) || 0;
        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
        if (prevYestVolume > 0) {
          const prevRatioValue = (prevVolume / prevYestVolume) * 100;
          const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
          if (currRatioValue < prevRatioValue) hasDown = true;
        }
      }
    }
    if (!hasDown) strongCount++;
  });
  const totalCount = auctionList.length;
  const todayStrength = totalCount > 0 ? Math.round((strongCount / totalCount) * 100) : null;

  let yStrongCount = 0;
  const yTotal = prevAuctionList.length;
  if (yTotal > 0) {
    prevAuctionList.forEach(item => {
      let hasDown = false;
      if (prevPrevAuctionList.length > 0 && item.stock) {
        const pp = prevPrevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
        if (pp && pp.yestVolume) {
          const ppv = parseFloat(pp.volume) || 0;
          const ppy = parseFloat(pp.yestVolume) || 0;
          if (ppy > 0) {
            const pprr = (ppv / ppy) * 100;
            const prr = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
            if (prr < pprr) hasDown = true;
          }
        }
      }
      if (!hasDown) yStrongCount++;
    });
  }
  const yesterdayStrength = yTotal > 0 ? Math.round((yStrongCount / yTotal) * 100) : null;

  let renderOrder = auctionList.map((_, idx) => idx);

  if (sortState.byData) {
    const dataCountCache = renderOrder.map(idx => {
      const it = auctionList[idx];
      if (!it || !it.stock) return 0;
      const history = getAuctionStockHistory(it.stock.trim(), currentDate, 5, dataSource);
      return history.filter(h => h.volume !== null || h.yestVolume !== null).length;
    });
    renderOrder = renderOrder.map((idx, pos) => ({ idx, count: dataCountCache[pos] })).sort((a, b) => b.count - a.count).map(x => x.idx);
  } else if (sortState.byRatio) {
    const highRatioStocksForSort = getHighRatioStocksForDate(currentDate, dataSource);
    const prevDayList = prevDate ? (getGroupData(dataSource)[prevDate] || []) : [];
    renderOrder = renderOrder.map((idx, pos) => {
      const it = auctionList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const todayVolume = it ? getNumericVolume(it.volume) : null;
      const yestVolume = it ? getNumericVolume(it.yestVolume) : null;
      let ratio = null;
      if (todayVolume !== null && todayVolume !== 0) {
        const prevItem = prevDayList.find(p => p.stock && p.stock.trim() === stockName);
        const prevVolume = prevItem ? getNumericVolume(prevItem.volume) : null;
        if (prevVolume !== null && prevVolume !== 0) ratio = todayVolume / prevVolume;
      }
      const digitGap = (todayVolume !== null && yestVolume !== null) ? Math.abs(getDigitCount(todayVolume) - getDigitCount(yestVolume)) : null;
      const isHighRatio = stockName && highRatioStocksForSort.stockNames.has(stockName);
      const tier = isHighRatio ? 0 : (ratio !== null ? 1 : 2);
      return { idx, pos, ratio, digitGap, tier };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0 || a.tier === 1) {
        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
        if (a.digitGap === null) return 1;
        if (b.digitGap === null) return -1;
        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
        return b.ratio - a.ratio;
      }
      return a.pos - b.pos;
    }).map(x => x.idx);

  } else if (sortState.byJingYest) {
    const parallelStockNamesForSort = getParallelStocksForDate(currentDate, dataSource);
    const allRatioDiffInfo = getRatioDiffInfoForDate(currentDate, dataSource);
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
      const isParallel = parallelStockNamesForSort.has(stockName);
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
      const fallbackInfo = (tier === 0 || tier === 1) ? allRatioDiffInfo.get(stockName) : null;
      const diff = fallbackInfo ? fallbackInfo.diff : null;
      const digitGap = fallbackInfo ? fallbackInfo.digitGap : null;
      return { idx, pos, diff, digitGap, tier };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0 || a.tier === 1) {
        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
        if (a.digitGap === null) return 1;
        if (b.digitGap === null) return -1;
        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
        return b.diff - a.diff;
      }
      return a.pos - b.pos;
    }).map(x => x.idx);

  } else if (sortState.byJingYestRatio) {
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : 1;
      const vol = auctionList[idx] ? (parseFloat(auctionList[idx].volume) || 0) : 0;
      const yvol = auctionList[idx] ? (parseFloat(auctionList[idx].yestVolume) || 0) : 0;
      const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
      return { idx, pos, jr, tier };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.jr === null && b.jr === null) return a.pos - b.pos;
      if (a.jr === null) return 1;
      if (b.jr === null) return -1;
      return b.jr - a.jr;
    }).map(x => x.idx);
  } else if (sortState.byThreeDayJingDie) {
    const threeDayJingDieSet = getThreeDayJingDieSet(currentDate, dataSource);
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
      const dd = stockName && threeDayJingDieSet ? (threeDayJingDieSet.get(stockName) || 0) : 0;
      const vol = auctionList[idx] ? (parseFloat(auctionList[idx].volume) || 0) : 0;
      const yvol = auctionList[idx] ? (parseFloat(auctionList[idx].yestVolume) || 0) : 0;
      const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
      return { idx, pos, dd, jr };
    }).sort((a, b) => {
      if (a.dd !== b.dd) return b.dd - a.dd;
      if (a.jr === null && b.jr === null) return a.pos - b.pos;
      if (a.jr === null) return 1;
      if (b.jr === null) return -1;
      return a.jr - b.jr;
    }).map(x => x.idx);
  } else if (sortState.byParallel) {
    if (sortState.byJingYest) {
      const parallelStockNamesForSort = getParallelStocksForDate(currentDate, dataSource);
      const allRatioDiffInfo = getRatioDiffInfoForDate(currentDate, dataSource);
      renderOrder = renderOrder.map((idx, pos) => {
        const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
        const isParallel = parallelStockNamesForSort.has(stockName);
        const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
        const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
        const fallbackInfo = (tier === 0 || tier === 1) ? allRatioDiffInfo.get(stockName) : null;
        const diff = fallbackInfo ? fallbackInfo.diff : null;
        const digitGap = fallbackInfo ? fallbackInfo.digitGap : null;
        return { idx, pos, diff, digitGap, tier };
      }).sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.tier === 0 || a.tier === 1) {
          if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
          if (a.digitGap === null) return 1;
          if (b.digitGap === null) return -1;
          if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
          return b.diff - a.diff;
        }
        return a.pos - b.pos;
      }).map(x => x.idx);
    } else {
      const parallelStockNames = getParallelStocksForDate(currentDate, dataSource);
      const allRatioDiffInfoForParallel = getRatioDiffInfoForDate(currentDate, dataSource);
      renderOrder = renderOrder.map((idx, pos) => {
        const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
        const qualifies = stockName && parallelStockNames.has(stockName);
        const info = qualifies ? allRatioDiffInfoForParallel.get(stockName) : null;
        return { idx, pos, qualifies, diff: info ? info.diff : null, digitGap: info ? info.digitGap : null };
      }).sort((a, b) => {
        if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
        if (a.qualifies) {
          if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
          if (a.digitGap === null) return 1;
          if (b.digitGap === null) return -1;
          if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
          return b.diff - a.diff;
        }
        return a.pos - b.pos;
      }).map(x => x.idx);
    }
  }

  const _obsStocks = getJingYestHighlightSetForDate(prevDate, dataSource);
  const _obsBoughtSet = new Set();
  auctionList.forEach(function(item) {
    if (item && item.stock) {
      var ts = getAuctionTagState(item.stock.trim(), currentDate);
      if (ts.source === 'inherited') _obsBoughtSet.add(item.stock.trim());
    }
  });

  const _confirmedSoldSet = (function() {
    const result = new Set();
    const stocksData = getStocksData();
    const namesToCheck = new Set(auctionList.map(function(it) { return it.stock ? it.stock.trim() : ''; }).filter(Boolean));
    if (namesToCheck.size === 0) return result;
    const allDates = Object.keys(stocksData).filter(function(d) { return d <= currentDate; }).sort().reverse();
    const seen = new Set();
    for (const d of allDates) {
      if (seen.size >= namesToCheck.size) break;
      const dayList = stocksData[d];
      if (!dayList) continue;
      for (const s of dayList) {
        if (!s || !s.name) continue;
        const n = s.name.trim();
        if (namesToCheck.has(n) && !seen.has(n)) {
          seen.add(n);
          if (s.sold === true) result.add(n);
        }
      }
    }
    return result;
  })();

  const _obsBoughtVisibleSet = new Set([..._obsBoughtSet].filter(n => !_confirmedSoldSet.has(n)));
  const _isObsMember = function(name) {
    return (_obsStocks && _obsStocks.has(name)) || _obsBoughtVisibleSet.has(name);
  };
  const _obsIndicesRaw = renderOrder.filter(i => auctionList[i] && auctionList[i].stock && _isObsMember(auctionList[i].stock.trim()));

  let obsIndices, regularIndices, hiddenObsIndices;
  if (jingYestToggleChecked) {
    hiddenObsIndices = [];
    const merged = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = auctionList[i].stock.trim();
      const matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const isBoughtInherited = _obsBoughtVisibleSet.has(stockName);
      if (!matchesToday && !isBoughtInherited) hiddenObsIndices.push(i);
      else merged.push(i);
    });
    obsIndices = merged;
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0 && merged.indexOf(i) < 0);
  } else {
    obsIndices = _obsIndicesRaw;
    regularIndices = renderOrder.filter(i => obsIndices.indexOf(i) < 0);
    hiddenObsIndices = [];
  }

  const _threeDayJingDieSet = sortState.byThreeDayJingDie ? getThreeDayJingDieSet(currentDate, dataSource) : null;

  const ctx = {
    dataSource, date: currentDate, confirmedSoldSet: _confirmedSoldSet,
    isObsMember: _isObsMember,
    prevAuctionList,
    jingYestToggleChecked,
    jingYestHighlightSet,
    sortByParallelEnabled: sortState.byParallel,
    parallelStocksToday,
    sortByRatioEnabled: sortState.byRatio,
    highRatioToday,
    sortByThreeDayJingDieEnabled: sortState.byThreeDayJingDie,
    threeDayJingDieSet: _threeDayJingDieSet
  };
  const fullOrder = obsIndices.concat(regularIndices);
  const items = fullOrder.map((i, pos) => _enrichAuctionItem(auctionList[i], i, ctx)).filter(Boolean);

  return {
    date: currentDate,
    dataSource,
    rawCount: auctionList.length,
    items,
    obsIndices,
    regularIndices,
    hiddenObsIndices,
    stats: {
      todayStrength,
      yesterdayStrength,
      strongCount,
      totalCount,
      highRatioCount: highRatioToday.count,
      jingYestCount: jingYestHighlightSet ? jingYestHighlightSet.size : 0
    }
  };
}
