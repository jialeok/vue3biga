<!--
  AuctionBoardToolbar.vue — 早盘竞价第一页：排序开关 / 竞昨统计 / 表头 / 搜索 / 后台面板。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div class="auction-toolbar">
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">全部展开</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          @change="onExpandAllChange"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">弱转强</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byWeakStrong"
          @change="toggleSort('byWeakStrong')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">量比抢筹</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byRatio"
          @change="toggleSort('byRatio')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">平行</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byParallel"
          @change="toggleSort('byParallel')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
  </div>
  <div class="auction-toolbar-row2">
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">竞/昨</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byJingYest"
          @change="toggleSort('byJingYest')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">竞/昨占比</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byJingYestRatio"
          @change="toggleSort('byJingYestRatio')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">三天竞跌</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byThreeDayJingDie"
          @change="toggleSort('byThreeDayJingDie')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <AuctionBoardTopicToggle />
  </div>
  <div class="auction-highratio-stat">
    <span style="font-weight:700;color:#dc2626;">竞昨数：{{ jingYestCountText }}</span>
    <span style="display:inline-block;width:28px;" />竞放量数：<span style="font-weight:700;">{{ highRatioCountText }}</span>
  </div>
  <AuctionHeaderSearch />
  <div
    class="auction-header-row"
    style="cursor:pointer"
    @dblclick.stop="onHeaderDblClick"
  >
    <div class="auction-header-item auction-header-number">
      序号
    </div>
    <div class="auction-header-item auction-header-stock">
      股票名称
    </div>
    <template v-if="!sortState.byTopic">
      <div class="auction-header-item auction-header-volume">
        竞价量(万)
      </div>
      <div class="auction-header-item auction-header-yest">
        昨成交量(万)
      </div>
      <div class="auction-header-item auction-header-ratio">
        占比
      </div>
    </template>
    <div
      v-else
      class="auction-header-item auction-header-topic"
    >
      题材
    </div>
  </div>
  <div
    v-if="showBackend"
    class="auction-backend-panel"
    :class="{ 'is-loading': backendLoading }"
  >
    <div class="backend-block backend-block-ths">
      <div class="backend-block-header">
        <span class="backend-block-title">同花顺接口</span>
        <span class="backend-block-sub">fuyao-proxy</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fetchLadderConstituentsMain)"
        >
          梯子成分
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillYesterdayVolumeFromThs)"
        >
          昨量填充
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillTodayYesterdayVolumeFromThs)"
        >
          今昨量
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillYesterdayYesterdayVolumeFromThs)"
        >
          昨昨量
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fetchChangePctFromThs)"
        >
          涨幅抓取
        </button>
      </div>
      <div
        class="backend-status"
        :style="{ color: thsStatus.ok ? '#059669' : '#dc2626' }"
      >
        {{ thsStatus.msg || '' }}
      </div>
    </div>
    <div class="backend-block backend-block-numcat">
      <div class="backend-block-header">
        <span class="backend-block-title">猫抓数据接口</span>
        <span class="backend-block-sub">每日10次</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchTodayAuctionFromNumcat)"
        >
          今日竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchAllAuctionFromNumcat)"
        >
          全部竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchThreeDaysAuctionFromNumcat)"
        >
          三日竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fillTopicsFromNumcat)"
        >
          题材填充
        </button>
      </div>
      <div
        class="backend-status"
        :style="{ color: numcatStatus.ok ? '#059669' : '#dc2626' }"
      >
        {{ numcatStatus.msg || '' }}
      </div>
    </div>
    <div class="backend-block backend-block-import">
      <div class="backend-block-header">
        <span class="backend-block-title">数据导入</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-import"
          @click="onImportPaste"
        >
          粘贴导入
        </button>
        <button
          class="backend-btn backend-btn-import"
          @click="onHistoryFill"
        >
          历史填充
        </button>
        <button
          class="backend-btn backend-btn-import"
          @click="onReplaceConcept"
        >
          题材替换
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject, computed } from 'vue';
import { apiStatusMap } from '../logic/ui-bridge.js';
import AuctionHeaderSearch from './AuctionHeaderSearch.vue';
import AuctionBoardTopicToggle from './AuctionBoardTopicToggle.vue';
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
  openBackend, openEditModal, openCoreTopicModal, onHeaderClick, onHeaderDblClick, refresh, toggleSort, expandAll, collapseAll,
  _computeTrendStats, loadTrendHistory, dailyAuctionMetrics, dailyMetricsList, switchPage,
  onSwipeStart, onSwipeEnd, handleSwipe, runBackend, onImportPaste, onReplaceConcept, onHistoryFill,
  onToggleSelect, onEditVolumeNote, _persistVolumeNote, saveVolumeNote, clearVolumeNote,
  onYestClick, closeNotePopup, onExpandTrend, startLongPress, cancelLongPress, onLongPress, onAuctionRefresh,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fetchTodayAuctionFromNumcat,
  fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat, fillTopicsFromNumcat
} = board;

// § 模板重构：内联条件链 / 状态访问抽取（渲染结果 100% 不变）
const jingYestCountText = computed(() => (viewData.value.stats && viewData.value.stats.jingYestCount) || '-');
const highRatioCountText = computed(() => (viewData.value.stats && viewData.value.stats.highRatioCount) || '-');

const thsStatus = computed(() => apiStatusMap['thsApiStatus'] || {});
const numcatStatus = computed(() => apiStatusMap['numcatApiStatus'] || {});
function onExpandAllChange(e) {
  if (e.target.checked) expandAll();
  else collapseAll();
}
</script>
