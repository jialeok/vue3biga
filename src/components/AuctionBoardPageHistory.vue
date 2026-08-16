<!--
  AuctionBoardPageHistory.vue — 早盘竞价第三页：题材历史强度排行。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div
    v-if="currentPage === 2"
    class="auction-scroll-container"
  >
    <div
      v-if="page3Data.topics.length === 0"
      class="auction-empty"
    >
      暂无符合条件的题材（需5日内出现2次以上）
    </div>
    <div
      v-for="topicItem in page3Data.topics"
      :key="topicItem.topic"
      class="auction-topic-history-group"
    >
      <div class="auction-topic-history-title">
        <span>{{ topicItem.topic }}</span>
        <span
          v-if="topicHasTodayData(topicItem)"
          class="auction-topic-copy-btns"
        >
          <span
            class="auction-topic-copy-btn"
            @click.stop="copyAllTopicStocks(topicItem.topic)"
          >全复制</span>
          <span
            class="auction-topic-copy-btn"
            @click.stop="copyTopicStocks(topicItem.topic, 5)"
          >复制5%</span>
          <span
            class="auction-topic-copy-btn"
            @click.stop="copyTopicStocks(topicItem.topic, 2)"
          >复制2%</span>
        </span>
      </div>
      <div class="auction-topic-history-header">
        <span class="auction-history-col auction-history-date">日期</span>
        <span class="auction-history-col auction-history-rank">上榜次数</span>
        <span class="auction-history-col auction-history-star">星评</span>
        <span class="auction-history-col auction-history-strength">强度</span>
        <span class="auction-history-col auction-history-count">总数</span>
        <span class="auction-history-col auction-history-arrow">变化</span>
      </div>
      <div
        v-for="(dayData, idx) in topicItem.sortedData"
        :key="topicItem.topic + '-' + dayData.date"
        :class="['auction-topic-history-row', { today: dayData.date === uiStore.currentDate }]"
      >
        <span class="auction-history-col auction-history-date">{{ formatDateShort(dayData.date) }}</span>
        <span
          class="auction-history-col auction-history-rank"
          :style="{ color: dayData.rankCount === 0 ? '#9ca3af' : '#9333ea' }"
        >上榜{{ dayData.rankCount }}次</span>
        <template v-if="dayData.hasData">
          <template v-if="dayData.hasChangeData">
            <span
              class="auction-history-col auction-history-star"
              :style="{ color: dayData.isUp ? '#ef4444' : '#10b981', fontSize: dayData.starCount >= 6 ? '13px' : '12px', fontWeight: dayData.starCount >= 6 ? 600 : 'normal' }"
            >{{ dayData.starText }}</span>
            <span
              class="auction-history-col auction-history-strength"
              style="font-size:12px;font-weight:500;"
            ><span :style="{ color: dayData.isUp ? '#ef4444' : '#10b981' }">{{ dayData.strength }}%</span></span>
            <span
              class="auction-history-col auction-history-count"
              :style="{ fontSize: '12px', fontWeight: 500, color: dayData.isUp ? '#ef4444' : '#10b981' }"
            >{{ dayData.stockCount }}</span>
            <span
              class="auction-history-col auction-history-arrow"
              style="font-size:12px;font-weight:500;"
            ><span :style="{ color: dayData.isUp ? '#ef4444' : '#10b981' }">{{ dayData.isUp ? '涨' : '跌' }}</span><span
              v-if="dayData.arrow.text"
              :style="{ color: dayData.arrow.color }"
            >{{ dayData.arrow.text }}</span></span>
          </template>
          <template v-else>
            <span
              class="auction-history-col auction-history-star"
              :style="{ color: dayData.starCount > 0 ? '#f97316' : '#333', fontSize: dayData.starCount >= 6 ? '13px' : '12px', fontWeight: dayData.starCount >= 6 ? 600 : 'normal' }"
            >{{ dayData.starText }}</span>
            <span
              class="auction-history-col auction-history-strength"
              style="font-size:12px;font-weight:500;"
            ><span :style="{ color: dayData.starCount > 0 ? '#f97316' : '#333' }">{{ dayData.strength }}%</span></span>
            <span
              class="auction-history-col auction-history-count"
              :style="{ fontSize: '12px', fontWeight: 500, color: dayData.starCount > 0 ? '#f97316' : '#333' }"
            >{{ dayData.stockCount }}</span>
            <span
              class="auction-history-col auction-history-arrow"
              style="font-size:12px;font-weight:500;"
            ><span
              v-if="dayData.arrow.text"
              :style="{ color: dayData.arrow.color }"
            >{{ dayData.arrow.text }}</span></span>
          </template>
        </template>
        <template v-else>
          <span class="auction-history-col auction-history-star">-</span>
          <span
            class="auction-history-col auction-history-strength"
            style="font-size:12px;font-weight:500;"
          ><span style="color:#333;">0%</span></span>
          <span
            class="auction-history-col auction-history-count"
            style="font-size:12px;font-weight:500;color:#333;"
          >0</span>
          <span
            class="auction-history-col auction-history-arrow"
            style="font-size:12px;font-weight:500;"
          ><span
            v-if="dayData.arrow.text"
            :style="{ color: dayData.arrow.color }"
          >{{ dayData.arrow.text }}</span></span>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import { formatDateShort, getStarSymbols, getHistoryArrow } from '../composables/auction-board-helpers.js';
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
  fetchAllAuctionFromNumcat,   fetchThreeDaysAuctionFromNumcat, fillTopicsFromNumcat
} = board;

// § 模板重构：复制按钮可见性内联箭头函数抽取为方法（渲染结果 100% 不变）
function topicHasTodayData(topicItem) {
  return topicItem.data.some(d => d.date === uiStore.currentDate && d.hasData);
}
</script>
