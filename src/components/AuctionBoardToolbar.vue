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
      <span class="auction-toggle-label">数据</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byData"
          @change="toggleSort('byData')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">环比</span>
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
  </div>
  <div
    class="auction-highratio-stat"
    style="position:relative;"
  >
    <span style="font-weight:700;color:#dc2626;">竞昨数：{{ jingYestCountText }}</span>
    <span style="display:inline-block;width:28px;" />竞放量数：<span style="font-weight:700;">{{ highRatioCountText }}</span>
    <span
      class="auction-listinfo-q"
      style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:10px;border-radius:50%;background:#e2e8f0;color:#475569;font-size:11px;font-weight:700;cursor:pointer;user-select:none;"
      title="查看列表组成说明"
      @click="toggleListInfo"
    >?</span>
    <div
      v-if="showListInfo"
      class="auction-listinfo-pop"
      style="position:absolute;top:26px;left:0;z-index:60;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:12px;color:#334155;box-shadow:0 6px 20px rgba(0,0,0,0.12);min-width:232px;line-height:1.9;"
    >
      <div>今日正式成员：<b>{{ listInfo.formalCount }}</b> 只</div>
      <div>当日观察组：<b>{{ listInfo.obsCount }}</b> 只</div>
      <div>交集（既是观察组又是正式）：<b>{{ listInfo.overlapCount }}</b> 只</div>
      <div style="color:#94a3b8;font-size:11px;margin-top:6px;border-top:1px solid #f1f5f9;padding-top:6px;">
        列表总数 = 正式 + 观察组非交集 = <b>{{ listInfo.totalDisplay }}</b> 只
      </div>
    </div>
  </div>
  <div
    class="auction-header-row"
    style="cursor:pointer"
    @click="onHeaderClick"
  >
    <div class="auction-header-item auction-header-number">
      序号
    </div>
    <div class="auction-header-item auction-header-stock">
      股票名称
    </div>
    <div class="auction-header-item auction-header-volume">
      竞价量(万)
    </div>
    <div class="auction-header-item auction-header-yest">
      昨成交量(万)
    </div>
    <div class="auction-header-item auction-header-ratio">
      占比
    </div>
  </div>
  <div
    v-if="searchActive"
    class="auction-search-container"
  >
    <input
      v-model="searchKeyword"
      type="text"
      class="auction-search-input"
      placeholder="输入股票名称搜索..."
      @click.stop
    >
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
import { inject, computed, ref } from 'vue';
import { apiStatusMap } from '../logic/ui-bridge.js';
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

// § 模板重构：内联条件链 / 状态访问抽取（渲染结果 100% 不变）
const jingYestCountText = computed(() => (viewData.value.stats && viewData.value.stats.jingYestCount) || '-');
const highRatioCountText = computed(() => (viewData.value.stats && viewData.value.stats.highRatioCount) || '-');

// [THREE-DAY 2026-08-17] 列表组成"?"说明浮层：正式成员 / 观察组 / 交集，点击展开再点收起。
const showListInfo = ref(false);
function toggleListInfo() { showListInfo.value = !showListInfo.value; }
const listInfo = computed(() => {
  const s = (viewData.value && viewData.value.stats) || {};
  const formal = s.formalCount || 0;
  const obs = s.obsCount || 0;
  const overlap = s.overlapCount || 0;
  return { formalCount: formal, obsCount: obs, overlapCount: overlap, totalDisplay: formal + (obs - overlap) };
});
const thsStatus = computed(() => apiStatusMap['thsApiStatus'] || {});
const numcatStatus = computed(() => apiStatusMap['numcatApiStatus'] || {});
function onExpandAllChange(e) {
  if (e.target.checked) expandAll();
  else collapseAll();
}
</script>
