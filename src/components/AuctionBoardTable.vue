<!--
  AuctionBoardTable.vue — 早盘竞价第一页：观察组/正式组行列表 + 趋势展开面板。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div v-if="!viewData.items || viewData.items.length === 0" class="auction-empty" @dblclick="openBackend">
    暂无数据，双击打开后台
  </div>

  <div v-if="filteredObsItems.length > 0" class="auction-group-label auction-obs-group-label">观察组</div>
  <template v-for="(item, idx) in filteredObsItems" :key="item.index" v-memo="[item.itemClass, item.numberClass, item.stockClass, item.ratio, item.ratioArrow, item.volumeDisplay, item.yestVolumeDisplay, item.yestColorClass, item.ratioClass, expandedSet.has(item.stock)]">
    <div :class="item.itemClass" :data-index="item.index" :data-stock="item.stock || ''" @click="onToggleSelect(item.index)">
      <div :class="item.numberClass" @click.stop="onExpandTrend(item.stock)" @dblclick.stop>{{ idx + 1 }}</div>
      <div :class="item.stockClass"
           :data-stock="item.stock"
           :data-note="item.note || ''"
           @dblclick.stop
           @contextmenu.prevent="onLongPress(item.stock)"
           @touchstart.passive="startLongPress(item.stock)"
           @touchend="cancelLongPress"
           @touchmove="cancelLongPress"
           @mousedown="startLongPress(item.stock)"
           @mouseup="cancelLongPress"
           @mouseleave="cancelLongPress">
        <span class="auction-stock-text">{{ item.stock }}<span v-if="item.obsFormalStar" class="auction-obs-formal-star">*</span></span>
        <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
      </div>
      <div class="auction-volume" @dblclick.stop="onEditVolumeNote(item.index)">{{ item.volumeDisplay }}</div>
      <div :class="item.yestColorClass" :data-index="item.index" :data-note="item.note || ''"
           @click.stop="onYestClick(item, $event)"
           @dblclick.stop="openEditModal()"
           @contextmenu.prevent>{{ item.yestVolumeDisplay }}</div>
      <div :class="item.ratioClass" :data-index="item.index" @dblclick.stop>{{ item.ratio }}<span v-if="item.ratioArrow" :style="{ color: item.ratioArrow === '⬆' ? '#ef4444' : '#10b981' }">{{ item.ratioArrow }}</span></div>
    </div>
    <div v-if="expandedSet.has(item.stock)" class="auction-trend-panel" @dblclick.stop>
      <template v-if="trendHistory[item.stock]">
        <div class="auction-daily-metrics">
          <template v-for="m in dailyMetricsList(item.stock)" :key="m.label">
            <span class="adm-item"><b>{{ m.label }}</b>：{{ m.value }}</span>
          </template>
        </div>
        <div class="trend-chart-item">
          <div class="trend-chart-label trend-chart-label-with-stats">
            <span>竞价量(万) 近5日</span>
            <span v-if="trendHistory[item.stock].diff != null" style="color:#2563eb; font-weight:600;">差值 {{ trendHistory[item.stock].diff }}</span>
            <span v-if="trendHistory[item.stock].jingRatio != null" style="color:#6366f1; font-weight:600;">今/昨比 {{ trendHistory[item.stock].jingRatio }}</span>
          </div>
          <TrendChart :points="trendHistory[item.stock].volume" color="#6366f1" />
        </div>
        <div class="trend-chart-item">
          <div class="trend-chart-label trend-chart-label-with-stats">
            <span>昨日成交量(万) 近5日</span>
            <span v-if="trendHistory[item.stock].yestRatio != null" style="color:#10b981; font-weight:600;">昨/前比 {{ trendHistory[item.stock].yestRatio }}</span>
          </div>
          <TrendChart :points="trendHistory[item.stock].yestVolume" color="#10b981" />
        </div>
        <div class="trend-chart-item" v-if="aucPctHasData(item.stock)">
          <div class="trend-chart-label">竞价涨幅(%) 近5日</div>
          <TrendChart :points="trendHistory[item.stock].aucPctChg" color="#f59e0b" :percent="true" />
        </div>
        <div class="trend-chart-item" v-if="changePctHasData(item.stock)">
          <div class="trend-chart-label">涨幅(%) 近5日</div>
          <TrendChart :points="trendHistory[item.stock].changePct" color="#64748b" :percent="true" />
        </div>
      </template>
    </div>
  </template>
  <div v-if="showObsSeparator" class="auction-obs-separator"></div>
  <template v-for="(item, idx) in filteredRegularItems" :key="item.index" v-memo="[item.itemClass, item.numberClass, item.stockClass, item.ratio, item.ratioArrow, item.volumeDisplay, item.yestVolumeDisplay, item.yestColorClass, item.ratioClass, expandedSet.has(item.stock)]">
    <div :class="item.itemClass" :data-index="item.index" :data-stock="item.stock || ''" @click="onToggleSelect(item.index)">
      <div :class="item.numberClass" @click.stop="onExpandTrend(item.stock)" @dblclick.stop>{{ filteredObsItems.length + idx + 1 }}</div>
      <div :class="item.stockClass"
           :data-stock="item.stock"
           :data-note="item.note || ''"
           @dblclick.stop
           @contextmenu.prevent="onLongPress(item.stock)"
           @touchstart.passive="startLongPress(item.stock)"
           @touchend="cancelLongPress"
           @touchmove="cancelLongPress"
           @mousedown="startLongPress(item.stock)"
           @mouseup="cancelLongPress"
           @mouseleave="cancelLongPress">
        <span class="auction-stock-text">{{ item.stock }}<span v-if="item.obsFormalStar" class="auction-obs-formal-star">*</span></span>
        <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
      </div>
      <div class="auction-volume" @dblclick.stop="onEditVolumeNote(item.index)">{{ item.volumeDisplay }}</div>
      <div :class="item.yestColorClass" :data-index="item.index" :data-note="item.note || ''"
           @click.stop="onYestClick(item, $event)"
           @dblclick.stop="openEditModal()"
           @contextmenu.prevent>{{ item.yestVolumeDisplay }}</div>
      <div :class="item.ratioClass" :data-index="item.index" @dblclick.stop>{{ item.ratio }}<span v-if="item.ratioArrow" :style="{ color: item.ratioArrow === '⬆' ? '#ef4444' : '#10b981' }">{{ item.ratioArrow }}</span></div>
    </div>
    <div v-if="expandedSet.has(item.stock)" class="auction-trend-panel" @dblclick.stop>
      <template v-if="trendHistory[item.stock]">
        <div class="auction-daily-metrics">
          <template v-for="m in dailyMetricsList(item.stock)" :key="m.label">
            <span class="adm-item"><b>{{ m.label }}</b>：{{ m.value }}</span>
          </template>
        </div>
        <div class="trend-chart-item">
          <div class="trend-chart-label trend-chart-label-with-stats">
            <span>竞价量(万) 近5日</span>
            <span v-if="trendHistory[item.stock].diff != null" style="color:#2563eb; font-weight:600;">差值 {{ trendHistory[item.stock].diff }}</span>
            <span v-if="trendHistory[item.stock].jingRatio != null" style="color:#6366f1; font-weight:600;">今/昨比 {{ trendHistory[item.stock].jingRatio }}</span>
          </div>
          <TrendChart :points="trendHistory[item.stock].volume" color="#6366f1" />
        </div>
        <div class="trend-chart-item">
          <div class="trend-chart-label trend-chart-label-with-stats">
            <span>昨日成交量(万) 近5日</span>
            <span v-if="trendHistory[item.stock].yestRatio != null" style="color:#10b981; font-weight:600;">昨/前比 {{ trendHistory[item.stock].yestRatio }}</span>
          </div>
          <TrendChart :points="trendHistory[item.stock].yestVolume" color="#10b981" />
        </div>
        <div class="trend-chart-item" v-if="aucPctHasData(item.stock)">
          <div class="trend-chart-label">竞价涨幅(%) 近5日</div>
          <TrendChart :points="trendHistory[item.stock].aucPctChg" color="#f59e0b" :percent="true" />
        </div>
        <div class="trend-chart-item" v-if="changePctHasData(item.stock)">
          <div class="trend-chart-label">涨幅(%) 近5日</div>
          <TrendChart :points="trendHistory[item.stock].changePct" color="#64748b" :percent="true" />
        </div>
      </template>
    </div>
  </template>
</template>

<script setup>
import { inject } from 'vue';
import AuctionBadge from './AuctionBadge.vue';
import TrendChart from './TrendChart.vue';
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

// § 模板重构：趋势图显示判定内联箭头函数抽取为方法（渲染结果 100% 不变）
function aucPctHasData(stock) {
  return trendHistory.value[stock].aucPctChg.some(p => p.value !== null);
}
function changePctHasData(stock) {
  return trendHistory.value[stock].changePct.some(p => p.value !== null);
}
</script>
