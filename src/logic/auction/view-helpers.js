import { getTodayGroupList, getGroupData, getAuctionData } from '../app-core-api.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getHighRatioStocksForDate, getParallelStocksForDate, getJingYestHighlightSetForDate, getDigitCount, getRatioDiffInfoForDate } from './sort-rules.js';
import { getAuctionStockHistory, ensureBoughtStocksForDate, ensureObservationStocks, deriveAuctionTagState, _buildTagStateCache } from '../tagTitles/rules.js';
import { getThreeDayJingDieSet } from './sort-rules-extra.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { _getAuctionWatchlistSet } from '../../data/watchlist-and-metrics.js';
import { getNumericVolume, getStocksData } from '../../data/supabase-client.js';
import { state } from '../app-state.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
import { getAuctionTagState } from '../ui-bridge.js';
import { getDisplayNote } from '../note/helpers.js';
import { useUiStore } from '../../stores/uiStore.js';

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
  return useAuctionTagStore().getTagState(date, stockName);
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
  if (ctx.prevAuctionMap && stockName) {
    const prevItem = ctx.prevAuctionMap.get(stockName);
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

  // [REFACTOR 2026-08-14] 用 deriveAuctionTagState(inheritOnly=true) 获取继承标签
  // 当天的标签通过 todayChoice（_getAuctionTag）显示虚线箭头
  const _inheritState = deriveAuctionTagState(stockName, ctx.date, ctx.tagStateCache, true);
  const isSold = _inheritState.sold;
  const isBought = _inheritState.bought;
  const isSelected = _inheritState.selected;
  const isConfirmedSold = isSold || (stockName && ctx.confirmedSoldSet && ctx.confirmedSoldSet.has(stockName));
  const isGray = !isSelected && !isSold && !isBought && ratioValue < 4.5;

  let itemClass = 'auction-item';
  if (isSold) {
    itemClass += ' sold';
  } else if (isConfirmedSold && !isSold) {
    // 已确认卖出但非当天手动卖出：常规展示
  } else if (isBought) {
    itemClass += ' bought';
  } else if (isSelected) {
    itemClass += ' selected';
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

  // §6/双身份标记：该股票既是「前一日竞昨高光（次日观察组）」，又同时位于今日正式列表
  // （今日 worker 自动获取的最近多板成分股）。用户需求：正式名单中这类股票旁加 * 号，
  // 以便分辨「它是观察组来源，但今天确实在正式列表里」——统计总数时它正常计入正式成员。
  const isFormalToday = ctx.isFormalToday ? ctx.isFormalToday(stockName) : false;
  const isObsFromPrev = ctx.isObsMember ? ctx.isObsMember(stockName) : false;

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
    isGray,
    // 双身份：昨日观察组来源 ∩ 今日正式列表 → 股票名旁加 *（用户可分辨）
    obsFormalStar: isObsFromPrev && isFormalToday,
    // 观察组来源（无论今日是否正式，供视图分组/样式使用）
    isObsFromPrev
  };
}

export function prepareAuctionData(currentDate) {
  try { ensureBoughtStocksForDate(currentDate); } catch (e) { console.warn('ensureBoughtStocksForDate failed:', e); }
  try { ensureObservationStocks(currentDate); } catch (e) { console.warn('ensureObservationStocks failed:', e); }
}

export function computeAuctionViewData(dataSource, sortStateOverride) {
  dataSource = dataSource || 'auction';
  const _p = dataSource === 'hot' ? 'hot' : 'auction';
  const currentDate = useUiStore().currentDate;

  const auctionList = getTodayGroupList(dataSource);
  if (!auctionList || auctionList.length === 0) {
    return { items: [], obsIndices: [], regularIndices: [], hiddenObsIndices: [], stats: { todayStrength: null, yesterdayStrength: null, strongCount: 0, totalCount: 0, highRatioCount: 0, jingYestCount: 0 }, rawCount: 0, date: currentDate, dataSource };
  }

  const prevDate = getPreviousTradingDay(currentDate);

  // [OBS-FIX 2026-08-17] 观察组 = 前一日「竞昨高光全集」直接继承，与当天 9:25 名单无关。
  // getJingYestHighlightSetForDate 本身已修（sort-rules.js）：只算当日正式名单内（9:25 拉取的
  // watchlist 成员），排除 market_metrics 影子行 → 8/14 竞昨=16 只、8/17 观察组=16 只，
  // 竞昨数/蓝色高光/观察组三者一致（§17/§23 单一真相）。
  const _obsStocks = getJingYestHighlightSetForDate(prevDate, dataSource);
  const _obsBoughtSet = new Set(JSON.parse(localStorage.getItem('obsBought_' + currentDate) || '[]')); // 合规：防重复/调试标记（§8 允许）
  const _isObsMember = function(name) {
    if (!name) return false;
    if (_obsBoughtSet.has(name)) return true;
    return (_obsStocks && _obsStocks.has(name));
  };
  // 凡应属观察组但不在当日列表的股票，构造渲染用空壳行（与 ensureObservationStocks 形状一致，便于 _enrichAuctionItem 统一处理）。
  const _existingNames = new Set(auctionList.map(function(s) { return s && s.stock ? s.stock.trim() : ''; }));
  const _injectNames = new Set();
  const _injectedRows = [];
  // [OBS-DATA 2026-08-15] 观察组空壳行回填当天真实数据：worker 9:25 已把观察组股票
  // （前一日 watchlist 合并进抓取名单）的数据写入 market_metrics，pullAuctionFromTable
  // 会把 market_metrics 的影子行合并进 _auctionMemCache[date]。注入观察组行时若缓存里有
  // 同名行（非 obsAutoAdded），复用其 volume/yestVolume/note/changePct，避免观察组显示空白。
  const _auctionDayRows = (getAuctionData()[currentDate] || []);
  const _auctionDayRowMap = new Map();
  _auctionDayRows.forEach(function(r) {
    if (r && r.stock) {
      const k = r.stock.trim();
      if (!_auctionDayRowMap.has(k)) _auctionDayRowMap.set(k, r);
    }
  });
  function _maybeInject(n) {
    if (!n) return;
    if (_existingNames.has(n) || _injectNames.has(n)) return;
    _injectNames.add(n);
    const dayRow = _auctionDayRowMap.get(n);
    if (dayRow && dayRow.obsAutoAdded !== true) {
      // worker/手动已抓到该股票当天数据：保留真实数据，仅补观察组身份标记（视图层不落库）
      _injectedRows.push(Object.assign({}, dayRow, { obsAutoAdded: true }));
    } else {
      _injectedRows.push({ stock: n, code: getStockCode(n), volume: '', yestVolume: '', note: '', obsAutoAdded: true });
    }
  }
  // [OBS-FIX 2026-08-15 v3] 观察组完整继承恢复：无论当天是否已抓取真实数据，都把
  // 「前一日竞昨高光 + obsBought」中不在当日列表的股票注入为观察组预览空壳行（蚂蚁线上观察组分栏）。
  //  - 修复全局少股：8/10 观察组 16≠18、8/11 观察组 26≠28（8/14 v2 禁止已抓取日注入导致观察组只剩交集）；
  //    观察组语义 = 前日竞昨高光完整集合，与"当日是否已抓取"无关。
  //  - 注入行仅用于视图渲染（renderList），不写入 auctionData、不推送云端（§6：观察组不落库、不产生影子记录）；
  //    历史锁定仍由 ensureObservationStocks（数据层）承担，视图层只如实呈现继承结果。
  //  - 注入行 obsAutoAdded=true，经 _isObsMember 判定进入观察组分栏（蚂蚁线上），绝不混入常规组（蚂蚁线下）。
  //  - 统计口径仍基于 auctionList + 正式成员索引（getAuctionBoardList 已过滤），注入壳不影响总数/涨跌比。
  if (_obsStocks) _obsStocks.forEach(_maybeInject);
  _obsBoughtSet.forEach(_maybeInject);
  // renderList 仅服务于视图渲染；真实业务数据(auctionList)保持不变，统计口径仍基于 auctionList。
  const renderList = _injectedRows.length ? auctionList.concat(_injectedRows) : auctionList;

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

  const _prevMap = new Map();
  if (prevAuctionList.length > 0) {
    for (const p of prevAuctionList) {
      if (p && p.stock) _prevMap.set(p.stock.trim(), p);
    }
  }
  const _prevPrevMap = new Map();
  if (prevPrevAuctionList.length > 0) {
    for (const p of prevPrevAuctionList) {
      if (p && p.stock) _prevPrevMap.set(p.stock.trim(), p);
    }
  }

  let strongCount = 0;
  auctionList.forEach(item => {
    let hasDown = false;
    if (item.stock) {
      const prevItem = _prevMap.get(item.stock.trim());
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
      if (item.stock) {
        const pp = _prevPrevMap.get(item.stock.trim());
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

  let renderOrder = renderList.map((_, idx) => idx);

  if (sortState.byData) {
    const dataCountCache = renderOrder.map(idx => {
      const it = renderList[idx];
      if (!it || !it.stock) return 0;
      const history = getAuctionStockHistory(it.stock.trim(), currentDate, 5, dataSource);
      return history.filter(h => h.volume !== null || h.yestVolume !== null).length;
    });
    renderOrder = renderOrder.map((idx, pos) => ({ idx, count: dataCountCache[pos] })).sort((a, b) => b.count - a.count).map(x => x.idx);
  } else if (sortState.byRatio) {
    const highRatioStocksForSort = getHighRatioStocksForDate(currentDate, dataSource);
    const prevDayList = prevDate ? (getGroupData(dataSource)[prevDate] || []) : [];
    const _prevDayMap = new Map();
    for (const p of prevDayList) { if (p && p.stock) _prevDayMap.set(p.stock.trim(), p); }
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const todayVolume = it ? getNumericVolume(it.volume) : null;
      const yestVolume = it ? getNumericVolume(it.yestVolume) : null;
      let ratio = null;
      if (todayVolume !== null && todayVolume !== 0) {
        const prevItem = _prevDayMap.get(stockName);
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
      const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
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
      const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : 1;
      const vol = renderList[idx] ? (parseFloat(renderList[idx].volume) || 0) : 0;
      const yvol = renderList[idx] ? (parseFloat(renderList[idx].yestVolume) || 0) : 0;
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
    // [THREE-DAY 2026-08-17] 排序规则：
    //   1) 符合条件（连续竞跌天数 dd≥2）整体排在前面；
    //   2) 同档内按「当天竞价涨幅 changePct」由高到低（之前是竞价量比值 jr，已废弃）。
    const threeDayJingDieSet = getThreeDayJingDieSet(currentDate, dataSource);
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const dd = stockName && threeDayJingDieSet ? (threeDayJingDieSet.get(stockName) || 0) : 0;
      const pctRaw = it ? (it.changePct || '') : '';
      const pctNum = parseFloat(String(pctRaw).replace('%', ''));
      const pctVal = isFinite(pctNum) ? pctNum : null;
      const isQualified = dd >= 2;
      return { idx, pos, isQualified, pctVal };
    }).sort((a, b) => {
      if (a.isQualified !== b.isQualified) return a.isQualified ? -1 : 1;
      if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
      if (a.pctVal === null) return 1;
      if (b.pctVal === null) return -1;
      return b.pctVal - a.pctVal;
    }).map(x => x.idx);
  } else if (sortState.byParallel) {
    if (sortState.byJingYest) {
      const parallelStockNamesForSort = getParallelStocksForDate(currentDate, dataSource);
      const allRatioDiffInfo = getRatioDiffInfoForDate(currentDate, dataSource);
      renderOrder = renderOrder.map((idx, pos) => {
        const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
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
        const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
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

  // [REFACTOR 2026-08-15] 从 auctionTagStore（云端标签真相）读已卖出集合，不读 stocksData
  const _confirmedSoldSet = (function() {
    const result = new Set();
    try {
      // §6/§8：标签唯一真相 = auctionTagStore（云端）
      const tags = useAuctionTagStore().tags;
      Object.keys(tags).forEach(function(d) {
        if (d > currentDate) return;
        const dayTags = tags[d] || {};
        Object.keys(dayTags).forEach(function(name) {
          if (dayTags[name] === 'sell') result.add(name.trim());
        });
      });
    } catch (e) {}
    return result;
  })();

  // [OBS-FIX 2026-08-14] _obsStocks / _obsBoughtSet / _isObsMember 已在函数顶部「视图注入」段统一定义，
  // 此处直接复用，确保「观察组归属口径」与「视图注入空壳行」完全一致（单一真相，杜绝两套定义分叉）。
  const _obsIndicesRaw = renderOrder.filter(i => renderList[i] && renderList[i].stock && _isObsMember(renderList[i].stock.trim()));

  // [THREE-DAY 2026-08-17] 三天竞跌模式下，分组口径改为「达标(dd≥2)置顶 / 未达标在后」，
  // 不再按观察组/常规组分隔（解决"观察组永远排在前面"的问题）。真实 obs 身份仍由每行 itemClass/obsFormalStar 标记。
  const _threeDayJingDieSet = sortState.byThreeDayJingDie ? getThreeDayJingDieSet(currentDate, dataSource) : null;

  let obsIndices, regularIndices, hiddenObsIndices;
  if (sortState.byThreeDayJingDie) {
    // [THREE-DAY 2026-08-17] 镜像「竞昨」观察组处理：
    // ① 折叠观察组（obsIndices=[]）→ 模板不再渲染观察组区块与蚂蚁线；
    // ② 隐藏「不在今日正式列表(9:25 官方抓取)」的观察组票（只显示当天正式列表），其余进单一列表；
    // ③ 由上方 three-day 排序分支把 dd≥2 达标股排前、同档按 changePct 降序。
    // 注意：今日命中判定用正式列表集 _getAuctionWatchlistSet，不能用 jingYestHighlightSet（那是竞昨专属高亮集）。
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const isOfficialToday = _getAuctionWatchlistSet(currentDate).has(stockName);
      if (!isOfficialToday) hiddenObsIndices.push(i);
    });
    obsIndices = [];
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
  } else if (jingYestToggleChecked) {
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const item = renderList[i];
      const hasTodayData = item && ((item.volume || '').toString().trim() !== '' || (item.yestVolume || '').toString().trim() !== '');
      const isBoughtInherited = _obsBoughtSet.has(stockName) && hasTodayData;
      if (!matchesToday && !isBoughtInherited) hiddenObsIndices.push(i);
    });
    obsIndices = [];
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
  } else {
    obsIndices = _obsIndicesRaw;
    regularIndices = renderOrder.filter(i => obsIndices.indexOf(i) < 0);
    hiddenObsIndices = [];
  }

  const ctx = {
    dataSource, date: currentDate, confirmedSoldSet: _confirmedSoldSet,
    isObsMember: _isObsMember,
    // 今日正式列表判定（worker 自动获取的最近多板成分股，含代码映射/手动新增的正式成员）。
    // 与统计口径 getAuctionBoardList（_auctionWatchlistIndex 过滤）保持一致，避免「显示星号」与「计入总数」两套标准。
    isFormalToday: function(name) {
      if (!name) return false;
      return _getAuctionWatchlistSet(currentDate).has(name.trim());
    },
    prevAuctionList,
    prevAuctionMap: _prevMap,
    tagStateCache: _buildTagStateCache(currentDate),
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
  const items = fullOrder.map((i, pos) => _enrichAuctionItem(renderList[i], i, ctx)).filter(Boolean);

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
      // [FIX 2026-08-17] 竞/昨数口径统一为「渲染列表 ∩ 当日竞昨全集」（与蓝色高光完全一致）。
      // 原先只统计 auctionList（正式列表）→ 8/14 显示 16，而蓝色高光（含观察组注入壳）显示 18，
      // 两者对不上（用户反馈）。渲染列表 = 正式列表 + 观察组注入壳，二者同源判定，数字必然一致。
      jingYestCount: renderList.filter(it => it && it.stock && jingYestHighlightSet && jingYestHighlightSet.has(it.stock.trim())).length
    }
  };
}
