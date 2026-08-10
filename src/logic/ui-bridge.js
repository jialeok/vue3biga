import { _emit } from '../stores/eventBus.js';
import { getPreviousTradingDay } from './trading-day-helpers.js';
import { state } from './app-state.js';
import { getAuctionData, getGroupData } from './app-core-api.js';
import { getTopicGroups } from './topic-rules.js';
import { renderConsecutiveUp as _renderConsecutiveUp, autoCalculateRecentMultiScore as _autoCalcRecentMultiScore, getTodayTagTitles, getYesterdayDate, getTagTitlesByDate, getPreviousTradingDayWithData, getTodayBidding } from './tag-titles-helpers.js';

function _noop() {}

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  try {
    const tags = JSON.parse(localStorage.getItem('auctionBoardTags') || '{}');
    return (tags[date] && tags[date][stockName.trim()]) || null;
  } catch { return null; }
}

export function setApiStatus() {}
export function _domGet() { return null; }
export function _domQuery() { return null; }
export function _domSetText() {}
export function _domSetColor() {}
export function _domSetValue() {}
export function _domSetDisplay() {}
export function _domValue() { return ''; }
export function _domCreate() { return null; }
export function _domAddEventListener() {}
export function _domAddEventListenerDoc() {}
export function _getCommentInputValue() { return ''; }
export function renderComment() {}
export function closeCommentModal() {}
export function _readTrackEditFormData() { return {}; }
export function renderHotForm() { _emit('auction-refresh'); }
export function showNumcatChoiceModal() {}
export function updateCloudSyncUI() {}
export function _switchGroupUI() {}
export function showHotDiagReport() {}
export function showAuctionDiagReport() {}
export function closeTrackEditModal() {}
export function closeHotEditModal() {}
export function _restoreStockCardExpand() {}
export function setStockCodeMapStatus() {}
export function setStockCodeMapStatusHot() {}
export function openAuctionEdit() {}
export function openHotEdit() {}
export function openTrackEdit() {}

export function renderAuction() { _emit('auction-refresh'); }
export function renderAuctionForm() {}
export async function saveAuction() {}
export function pullCoreTopicsFromCloud() { return Promise.resolve(); }
export function pushCoreTopicsToCloud() { return Promise.resolve(); }
export function toggleAuctionBoard() {}
export function toggleStrengthSort() {}

export function toggleAuctionTrendPanel() {}
export function toggleAuctionTrendPanelP2() {}
export function resetExpansionStateOnDateSwitch() {}
export function getAuctionTagState(stockName, date) {
  const d = date || state.currentDate;
  const prevDay = getPreviousTradingDay(d);
  const tag = prevDay ? _getAuctionTag(prevDay, stockName) : null;
  return { bought: tag === 'buy', sold: tag === 'sell', selected: tag === 'hold', source: tag ? 'inherited' : 'none' };
}
export function copyAllTopicStocks() {}
export function copyTopicStocks() {}
export function expandAllAuctionTrendPanels() {}
export function expandAllAuctionTrendPanelsP2() {}
export function jumpToAuctionPage1() {}
export function jumpToAuctionPage2() {}
export function openAuctionNoteEditFromPage2() {}
export function openCoreTopicModal() {}
export function restoreExpandedAuctionTrendPanels() {}
export function restoreExpandedTopicGroupsP2() {}
export function showAuctionBuyPrompt() {}
export function toggleAuctionSortHelp() {}
export function toggleTopicGroupTrendPanels() {}
export function getStarTagsForStock(stockName) {
  if (!stockName) return null;
  const auctionData = getAuctionData();
  const todayAuctionList = auctionData[state.currentDate] || [];
  const prevDate = getPreviousTradingDay(state.currentDate);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  if (todayAuctionList.length === 0) return null;

  const todayGroups = getTopicGroups(todayAuctionList);
  const prevGroups = prevDate ? getTopicGroups(prevAuctionList) : [];

  const stockTopics = [];
  todayGroups.forEach(group => {
    if (group.topic === '其它' || group.topic === '并购重组') return;
    const hasStock = group.stocks.some(s => s.stock && s.stock.trim() === stockName.trim());
    if (!hasStock) return;
    const todayStarCount = group.starCount || 0;
    const prevGroup = prevGroups.find(g => g.topic === group.topic);
    const prevStarCount = prevGroup ? (prevGroup.starCount || 0) : 0;
    stockTopics.push({ topic: group.topic, todayStarCount, prevStarCount, starChange: todayStarCount - prevStarCount });
  });
  if (stockTopics.length === 0) return null;

  let maxStarTopic = null, maxStarCount = 0;
  todayGroups.forEach(group => {
    if (group.topic === '其它' || group.topic === '并购重组') return;
    if ((group.starCount || 0) > maxStarCount) { maxStarCount = group.starCount || 0; maxStarTopic = group.topic; }
  });

  let bestTag = null, bestPriority = 0;
  stockTopics.forEach(st => {
    let tag = null, priority = 0;
    if (st.todayStarCount > st.prevStarCount && st.todayStarCount > 5) { tag = '星爆'; priority = 1; }
    else if (st.topic === maxStarTopic && maxStarCount > 0) { tag = '星最多'; priority = 2; }
    else if (st.todayStarCount > 0 && st.prevStarCount === 0) { tag = '星现'; priority = 3; }
    else if (st.todayStarCount > st.prevStarCount) { tag = '星增'; priority = 4; }
    else if (st.todayStarCount === st.prevStarCount && st.todayStarCount > 0) { tag = '星平'; priority = 5; }
    else if (st.todayStarCount < st.prevStarCount && st.todayStarCount > 0) { tag = '星减'; priority = 6; }
    else if (st.todayStarCount === 0 && st.prevStarCount > 0) { tag = '星无'; priority = 7; }
    if (tag && (priority < bestPriority || bestPriority === 0)) { bestTag = tag; bestPriority = priority; }
  });
  return bestTag;
}

export function getStockProfitStatus(stockName, stocksData) {
  if (!stockName || !stocksData) return null;
  const todayStocks = stocksData[state.currentDate] || [];
  const stock = todayStocks.find(s => s.name && s.name.trim() === stockName.trim());
  if (!stock || !stock.soldRecords || stock.soldRecords.length === 0) return null;
  const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latestRecord = sortedRecords[0];
  if (!latestRecord || latestRecord.profit === undefined || latestRecord.profit === null) return null;
  const profitStr = String(latestRecord.profit).replace(/[^\d.-]/g, '');
  const profitValue = parseFloat(profitStr);
  if (isNaN(profitValue)) return null;
  return profitValue >= 0 ? '赚' : '亏';
}

export function showAuctionNoteInput() {}
export function showAuctionNotePopup() {}
export function toggleAuctionRowSelect() {}

export function renderBidding() { _emit('bidding-refresh'); }
export function getTodayDuiban() {
  const auctionData = getAuctionData();
  return (auctionData && auctionData[state.currentDate]) || [];
}
export function renderDuiban() { _emit('board-refresh'); }
export function recalcDuibanFromAuction() {}

export function renderEmotionBoard() { _emit('board-refresh'); }
export function renderEtf() { _emit('board-refresh'); }
export function renderJiwang() { _emit('board-refresh'); }
export function getNthPreviousTradingDay(date, n) {
  let d = date;
  for (let i = 0; i < n; i++) d = getPreviousTradingDay(d);
  return d;
}
export function renderMulti() { _emit('board-refresh'); }
export function renderHotspot() { _emit('board-refresh'); }
export function renderPattern() { _emit('board-refresh'); }
export function renderRank() { _emit('board-refresh'); }

export function autoCalculateRecentMultiScore() { return _autoCalcRecentMultiScore(); }
export function autoCalculateSectorEtfScore() {}
export function autoCalculateTopicDirectionScore() {}
export function openMonthlySummaryModal() {}
export function openWeekendReviewModal() {}
export function openWeekendSummaryModal() {}
export function renderConsecutiveUp() { return _renderConsecutiveUp(); }
export function showLastWeekStats() {}
export function showMonthlyStats() {}
export function showWeeklyStats() {}
export { getTodayTagTitles, getYesterdayDate, getTagTitlesByDate, getPreviousTradingDayWithData, getTodayBidding };

export function renderList() { _emit('stocks-refresh'); }
export function showHint() {}
export function handleFileImport() {}
export function formatDate(d) { return d || ''; }
export function editStock() {}
export function copyToTomorrow() {}
export function copyToDate() {}
export function deleteStock() {}
export function openSoldEdit() {}