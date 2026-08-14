import { state } from '../app-state.js';
import { _bindApi } from '../app-core-api.js';
import { showToast } from '../../composables/useToast.js';
import { fuyaoApiGet, tickerToThscode, LADDER_THSCODE } from '../../data/api/fuyao-proxy.js';
import { numcatApiPost } from '../../data/api/numcat-proxy.js';
import { normalizeAuctionNotes, pullAuctionFromTable, setAuctionDateData, _setInvalidateTopicCacheFn } from '../../data/auction-data.js';
import { _dbgLog, _dbgLogVerbose } from '../../data/debug-log.js';
import { pushHotTrendsToCloud } from '../../data/hot-stocks.js';
import { pushJiwangNow, scheduleJiwangPush } from '../../data/jiwang-data.js';
import { _closeAuctionShield, _openAuctionShield, _initAuctionMemCache } from '../../data/session-and-shield.js';
import { loadCloudStockCodeMap, upsertStockCodeMap } from '../../data/stock-code-map.js';
import { buildTopicCache, invalidateTopicCache, loadCloudTopics, pushStockTopicsToCloud, scanDataSourceForTopics } from '../../data/stock-topics.js';
import { _moduleKey, getJiwangData, getNumericVolume, getStocksData, getSupabase, loadAllData } from '../../data/supabase-client.js';
import { remainingBoards } from '../../data/remaining-boards.js';
import { _addAuctionWatchlistMember, _extractWatchlistNamesFromRows, _getAuctionWatchlistSet, _setAuctionWatchlistForDate, getStockHistoryValue } from '../../data/watchlist-and-metrics.js';
import { getJingYestHighlightSetForDate, getJingYestStocksForDate } from '../auction-sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../auction-stock-sync.js';
import { getStats } from '../jiwang-helpers.js';
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from '../note-helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from '../scope-helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from '../tag-rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from '../trading-day-helpers.js';
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from '../date/date-helpers.js';
import { _domGet, _domQuery, _domSetColor, _domSetText, _domSetValue, _getCommentInputValue, _readTrackEditFormData, _restoreStockCardExpand, closeCommentModal, closeHotEditModal, closeTrackEditModal, copyAllTopicStocks, copyTopicStocks, expandAllAuctionTrendPanels, expandAllAuctionTrendPanelsP2, getNthPreviousTradingDay, handleFileImport, jumpToAuctionPage1, jumpToAuctionPage2, openAuctionEdit, openAuctionNoteEditFromPage2, openCoreTopicModal, openHotEdit, recalcDuibanFromAuction, renderAuction, renderAuctionForm, renderBidding, renderComment, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, resetExpansionStateOnDateSwitch, restoreExpandedAuctionTrendPanels, restoreExpandedTopicGroupsP2, saveAuction, setApiStatus, setStockCodeMapStatus, setStockCodeMapStatusHot, showAuctionBuyPrompt, showAuctionDiagReport, showAuctionNoteInput, showAuctionNotePopup, showHint, showHotDiagReport, showNumcatChoiceModal, toggleAuctionBoard, toggleAuctionRowSelect, toggleAuctionSortHelp, toggleStrengthSort, toggleTopicGroupTrendPanels, updateCloudSyncUI } from '../ui-bridge.js';
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore, _bindUiFns } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';

// §16 域拆分：jiwang 域（原 app-core.js 迁出）
export function markJiwangDirty(date) {
    if (date) state._jiwangDirtyDates.add(date);
}

export function getTodayJiwang() {
    const jiwangData = getJiwangData();
    return jiwangData[useUiStore().currentDate] || null;
}

