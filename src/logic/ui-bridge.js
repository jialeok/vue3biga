import { _setCoreTopicsFns } from './topic-rules.js';
import { _emit } from '../stores/eventBus.js';
import { getPreviousTradingDay } from './trading-day-helpers.js';
import { state } from './app-state.js';
import { getAuctionData, getGroupData } from './app-core-api.js';
import { getTopicGroups } from './topic-rules.js';
import { getSupabase } from '../data/supabase-client.js';
import { _getAuctionWatchlistSet } from '../data/watchlist-and-metrics.js';
import { saveRecentMultiRow } from '../data/duiban-sync.js';
import { saveEtfBoardRow } from '../data/etf-board-data.js';
import { renderConsecutiveUp as _renderConsecutiveUp, autoCalculateRecentMultiScore as _autoCalcRecentMultiScore, getTodayTagTitles, getYesterdayDate, getTagTitlesByDate, getPreviousTradingDayWithData, getTodayBidding } from './tag-titles-helpers.js';
import { reactive } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionTagStore } from '../stores/auctionTagStore.js';

function _noop() {}

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
  return useAuctionTagStore().getTagState(date, stockName);
}

export const apiStatusMap = reactive({});

export function setApiStatus(elId, msg, isOk) {
  if (!elId) return;
  apiStatusMap[elId] = { msg: String(msg || ''), ok: !!isOk, ts: Date.now() };
}
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
// 覆盖/补全 选择弹窗（Vue 化）：取代原 window.confirm 系统 UI。
// 调用方（同花顺/猫抓各补全类按钮）依赖它拿到 overwrite 开关才继续执行。
// 这里只把选择状态写入响应式 numcatChoice，由 <NumcatChoiceModal> 渲染美观弹窗，
// 用户点击后通过 resolveNumcatChoice 回调 overwrite（true=覆盖 / false=补全）。
export const numcatChoice = reactive({ visible: false, title: '', cb: null, cancelSignal: 0 });

export function showNumcatChoiceModal(title, cb) {
  numcatChoice.title = title || '操作模式';
  numcatChoice.cb = typeof cb === 'function' ? cb : null;
  numcatChoice.visible = true;
}

export function resolveNumcatChoice(overwrite) {
  const cb = numcatChoice.cb;
  numcatChoice.visible = false;
  numcatChoice.cb = null;
  // overwrite 为 null/undefined 表示用户点击「取消」→ 中止本次操作，不执行回调
  if (cb && overwrite !== null && overwrite !== undefined) {
    try { cb(!!overwrite); }
    catch (e) { console.error('补全/覆盖选择回调失败:', e); }
  } else {
    // 取消：递增取消信号，供调用方（后台编辑框）解除「处理中」按钮锁定，
    // 否则因不执行回调、无 ✅/❌ 终止消息，busyKey 会永久卡在「处理中...」
    numcatChoice.cancelSignal++;
  }
}
export function updateCloudSyncUI() {}

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
export async function pullCoreTopicsFromCloud() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from('core_topics').select('name,synonyms,updated_at').order('name', { ascending: true });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data.map(row => {
    let syns = row.synonyms;
    if (typeof syns === 'string') { try { syns = JSON.parse(syns); } catch { syns = syns.split(','); } }
    return { name: row.name, synonyms: Array.isArray(syns) ? syns : [] };
  });
}
export async function pushCoreTopicsToCloud(topics) {
  const sb = getSupabase();
  if (!sb) return;
  const { error: delErr } = await sb.from('core_topics').delete().neq('name', '___never___');
  if (delErr) throw delErr;
  if (!topics || topics.length === 0) return;
  const rows = topics.map(t => ({ name: t.name, synonyms: JSON.stringify(t.synonyms || []), updated_at: new Date().toISOString() }));
  const { error: insErr } = await sb.from('core_topics').insert(rows);
  if (insErr) throw insErr;
}
_setCoreTopicsFns(pullCoreTopicsFromCloud, pushCoreTopicsToCloud);
export function toggleAuctionBoard() {}
export function toggleStrengthSort() {}

export function toggleAuctionTrendPanel() {}
export function toggleAuctionTrendPanelP2() {}
export function resetExpansionStateOnDateSwitch() {}
export function getAuctionTagState(stockName, date) {
  const d = date || useUiStore().currentDate;
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
const _starTagCache = new Map();
export function clearStarTagCache() { _starTagCache.clear(); }
export function getStarTagsForStock(stockName) {
  if (!stockName) return null;
  const cacheKey = useUiStore().currentDate + '|' + stockName.trim();
  if (_starTagCache.has(cacheKey)) return _starTagCache.get(cacheKey);
  const auctionData = getAuctionData();
  const todayAuctionList = auctionData[useUiStore().currentDate] || [];
  const prevDate = getPreviousTradingDay(useUiStore().currentDate);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  if (todayAuctionList.length === 0) { _starTagCache.set(cacheKey, null); return null; }

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
  if (stockTopics.length === 0) { _starTagCache.set(cacheKey, null); return null; }

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
  _starTagCache.set(cacheKey, bestTag);
  return bestTag;
}

const _profitStatusCache = new Map();
export function clearProfitStatusCache() { _profitStatusCache.clear(); }
export function getStockProfitStatus(stockName, stocksData) {
  if (!stockName || !stocksData) return null;
  const cacheKey = useUiStore().currentDate + '|' + stockName.trim();
  if (_profitStatusCache.has(cacheKey)) return _profitStatusCache.get(cacheKey);
  const todayStocks = stocksData[useUiStore().currentDate] || [];
  const stock = todayStocks.find(s => s.name && s.name.trim() === stockName.trim());
  if (!stock || !stock.soldRecords || stock.soldRecords.length === 0) { _profitStatusCache.set(cacheKey, null); return null; }
  const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latestRecord = sortedRecords[0];
  if (!latestRecord || latestRecord.profit === undefined || latestRecord.profit === null) { _profitStatusCache.set(cacheKey, null); return null; }
  const profitStr = String(latestRecord.profit).replace(/[^\d.-]/g, '');
  const profitValue = parseFloat(profitStr);
  if (isNaN(profitValue)) { _profitStatusCache.set(cacheKey, null); return null; }
  const result = profitValue >= 0 ? '赚' : '亏';
  _profitStatusCache.set(cacheKey, result);
  return result;
}

export function showAuctionNoteInput() {}
export function showAuctionNotePopup() {}
export function toggleAuctionRowSelect() {}

export function renderBidding() { _emit('bidding-refresh'); }
export function getTodayDuiban() {
  const auctionData = getAuctionData();
  return (auctionData && auctionData[useUiStore().currentDate]) || [];
}
export function renderDuiban() { _emit('board-refresh'); }
/**
 * 从「早盘竞价股票列表」自动推导 最近多板 / 早盘板块ETF 的总数量与跌涨比，写回各自唯一真相表。
 * - 最近多板 → recent_multi_data（saveRecentMultiRow，合并 upsert）
 * - 早盘板块ETF → early_etf_data（saveEtfBoardRow，合并 upsert）
 * 看板只读 boardState（由 Realtime 自愈更新），本函数只负责「推导 + 写回」，不引入第二真相源（§6）。
 *
 * 计数口径（对齐旧系统 recalcDuibanFromAuction）：
 *   总数量 = 当日正式竞价股票支数（按 _auctionWatchlistIndex 过滤后的列表长度）
 *   涨数   = note 含「涨停」，或 note 中首个百分比 > 0 的支数
 *   跌数   = 总数量 − 涨数
 *   跌涨比 = `${跌数}:${涨数}`
 *
 * @param {string} [date] 目标日期，默认当前日期。列表为空时直接返回（不覆盖已有统计，§11 不把空当删除）。
 * @returns {Promise<{recentMulti:*, earlyEtf:*}|null>}
 */
function computeAuctionCounts(date) {
  const list = getAuctionData()[date] || [];
  const watchlistSet = _getAuctionWatchlistSet(date);
  const formal = list.filter(function (r) {
    return r && r.stock && watchlistSet.has(r.stock.trim());
  });
  const total = formal.length;
  if (total === 0) return null;
  let rise = 0;
  formal.forEach(function (item) {
    const note = item.note || '';
    if (note.includes('涨停')) { rise++; return; }
    if (note.includes('跌停')) return;
    const m = note.match(/-?\d+\.?\d*%/);
    if (m) {
      const v = parseFloat(m[0]);
      if (v > 0) rise++;
    }
  });
  const fall = total - rise;
  return { total, rise, fall, die_zhangbi: fall + ':' + rise };
}

export async function recalcDuibanFromAuction(date) {
  const targetDate = date || useUiStore().currentDate;
  if (!targetDate) return null;
  const counts = computeAuctionCounts(targetDate);
  if (!counts) return null; // 列表为空：不覆盖、不删除已有统计
  const row = {
    date: targetDate,
    shuliang: String(counts.total),
    die_count: counts.fall,
    zhang_count: counts.rise,
    die_zhangbi: counts.die_zhangbi
  };
  let recentMulti = null;
  let earlyEtf = null;
  try {
    const r1 = await saveRecentMultiRow(row);
    if (r1 && r1.ok && r1.data) recentMulti = r1.data;
  } catch (e) {
    console.warn('[recalc] 最近多板写回失败:', e && e.message);
  }
  try {
    const r2 = await saveEtfBoardRow(row);
    if (r2 && r2.ok && r2.data) earlyEtf = r2.data;
  } catch (e) {
    console.warn('[recalc] 早盘ETF写回失败:', e && e.message);
  }
  return { recentMulti, earlyEtf };
}

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