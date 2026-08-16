<!--
  AuctionBoardPageCopied.vue — 早盘竞价第四页：已复制题材股票清单。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div
    v-if="currentPage === 3"
    class="auction-scroll-container auction-page-4"
  >
    <div
      v-if="page4DisplayStocks.length === 0"
      class="auction-copied-placeholder"
    >
      暂无复制的股票<br>请从第三页复制题材股票
    </div>
    <div v-else>
      <div
        v-for="(stock, idx) in page4DisplayStocks"
        :key="stock.name + '-' + idx"
        class="auction-copied-row"
      >
        <span class="auction-copied-stock">{{ stock.name }}</span>
        <span class="auction-copied-topic">{{ stock.topic }}</span>
        <span :class="['auction-copied-ratio', { highlight: stock.ratio >= 10, 'highlight-light': stock.ratio >= 4.5 && stock.ratio < 10 }]">{{ stock.ratio }}%<span
          v-if="stock.arrow === '⬆'"
          style="color:#ef4444;"
        >⬆</span><span
          v-if="stock.arrow === '⬇'"
          style="color:#10b981;"
        >⬇</span></span>
        <span
          class="auction-copied-delete"
          @click.stop="deleteCopiedStock(stock.originalIndex)"
        >✕</span>
      </div>
      <div
        class="auction-clear-all-btn"
        @click="clearAllCopiedStocks"
      >
        全部清除
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const board = inject('auctionBoard');
const {
  uiStore, auctionStore, sortState, expandedSet, trendHistory, longPressMenuRef, coreTopicModalRef, editModalRef,
  viewData, currentPage, showBackend, expanded, topicGroups, itemsByIndex, obsItems, regularItems, allItems,
  searchActive, searchKeyword, filteredItems, filteredObsItems, filteredRegularItems, showObsSeparator,
  sortState2, isStrengthSortEnabled, p2ExpandedSet, p2TrendHistory, p2ExpandedTopics, p2ExpandAll,
  p2StockTopicCount, p2HighRatioInfo, p2JingYestSet, p2ParallelSet, p2JingYestCount, p2HighRatioCount,
  sortedTopicGroups, page3Data, copiedStocks, page4DisplayStocks, backendLoading,
  volumeNoteModalActive, volumeNoteDraft, notePopup, notePopupText, notePopupStyle,
  toggleBoard, getStockStyle, getTopicRowClass, toggleSort2, toggleStrengthSort, toggleGroupExpand,
  p2ToggleExpandAll, loadP2TrendHistory, loadP2TrendHistoryChunked, toggleP2Trend, getLastNTradingDays,
  loadCopiedStocks, saveCopiedStocks, copyAllTopicStocks, copyTopicStocks, deleteCopiedStock, clearAllCopiedStocks,
  openBackend, openEditModal, openCoreTopicModal, onHeaderClick, refresh, toggleSort, expandAll, collapseAll,
  _computeTrendStats, loadTrendHistory, dailyAuctionMetrics, dailyMetricsList, switchPage,
  onSwipeStart, onSwipeEnd, handleSwipe, runBackend, onImportPaste, onReplaceConcept, onHistoryFill,
  onToggleSelect, onEditVolumeNote, _persistVolumeNote, saveVolumeNote, clearVolumeNote,
  onYestClick, closeNotePopup, onExpandTrend, startLongPress, cancelLongPress, onLongPress, onAuctionRefresh,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fetchTodayAuctionFromNumcat,
  fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat, fillTopicsFromNumcat
} = board;
</script>
