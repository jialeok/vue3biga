<!--
  AuctionBoardPageTopics.vue — 早盘竞价第二页：题材分组（强度/占比/趋势）。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div v-if="currentPage === 1" class="auction-scroll-container">
    <div class="auction-toolbar">
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">全部展开</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="p2ExpandAll" @change="p2ToggleExpandAll" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">环比</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="sortState2.byRatio" @change="toggleSort2('byRatio')" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">平行</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="sortState2.byParallel" @change="toggleSort2('byParallel')" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="auction-toolbar-row2">
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">竞/昨</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="sortState2.byJingYest" @change="toggleSort2('byJingYest')" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">竞/昨占比</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="sortState2.byJingYestRatio" @change="toggleSort2('byJingYestRatio')" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
      <div class="auction-toggle-item">
        <span class="auction-toggle-label">三天竞跌</span>
        <label class="auction-toggle-switch">
          <input type="checkbox" :checked="sortState2.byThreeDayJingDie" @change="toggleSort2('byThreeDayJingDie')" />
          <span class="auction-toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="auction-highratio-stat">
      <span style="font-weight:700;color:#dc2626;">竞昨数：{{ p2JingYestCount }}</span><span style="display:inline-block;width:28px;"></span>竞放量数：<span style="font-weight:700;">{{ p2HighRatioCount }}</span>
    </div>
    <div v-if="sortedTopicGroups.length === 0" class="auction-empty">暂无题材分组数据</div>
    <div v-else>
      <div class="auction-header-row">
        <div class="auction-header-item auction-header-stock" style="flex:0 0 75px;padding-left:10px;">股票名称</div>
        <div class="auction-header-item auction-header-change" style="flex:0 0 55px;">涨幅</div>
        <div class="auction-header-item auction-header-volume" style="flex:1;text-align:left;padding-left:8px;">题材</div>
        <div class="auction-header-item" style="flex:0 0 70px;cursor:pointer;" @click="toggleStrengthSort">
          <span :class="{ 'strength-sort-active': isStrengthSortEnabled }">{{ isStrengthSortEnabled ? '▼强度' : '强度' }}</span>
        </div>
        <div class="auction-header-item auction-header-ratio" style="flex:0 0 50px;">占比</div>
      </div>
      <div v-for="group in sortedTopicGroups" :key="group.topic" class="auction-topic-group" :data-topic-group="group.topic">
        <div v-if="canGroupExpand(group.topic)" class="auction-topic-expand-row" @click="toggleGroupExpand(group.topic)">
          <span class="auction-topic-expand-arrow" :class="{ expanded: p2ExpandedTopics.has(group.topic) }">▼</span>
        </div>
        <div class="auction-topic-header">
          <span class="auction-topic-left">【{{ group.topic }}】{{ getRankAppearText(group.topic) }}</span>
          <span class="auction-topic-stars" v-if="group.topic !== '其它'">{{ getStarSymbols(group.starCount) }}</span>
          <span class="auction-topic-strength" v-if="group.topic !== '其它' && group.strength !== null"> 强度<span style="color:#ef4444;">{{ group.strength }}%</span></span>
          <span class="auction-topic-count">{{ group.stocks.length }}只</span>
        </div>
        <template v-for="stock in group.stocks" :key="group.topic + '-' + stock.stock">
          <div :class="getTopicRowClass(group, stock)"
               :data-stock="stock.stock || ''"
               @click="canGroupExpand(group.topic) && toggleP2Trend(group.topic, stock.stock)">
            <div class="auction-topic-stock" :style="getStockStyle(stock.stock)">{{ stock.stock || '-' }}</div>
            <div :class="getChangeClass(stock)">{{ getChangePctDisplay(stock) }}</div>
            <div class="auction-topic-name" :style="getTopicNameStyle()" @click.stop="openCoreTopicModal">{{ getTopicsDisplay(stock) }}</div>
            <div class="auction-topic-ratio">{{ stock.ratio }}</div>
          </div>
          <div v-if="canGroupExpand(group.topic) && p2ExpandedSet.has(group.topic + '|' + stock.stock)"
               class="auction-trend-panel">
            <template v-if="p2TrendHistory[group.topic + '|' + stock.stock]">
              <div class="auction-daily-metrics">
                <template v-for="m in dailyMetricsList(stock.stock)" :key="m.label">
                  <span class="adm-item"><b>{{ m.label }}</b>：{{ m.value }}</span>
                </template>
              </div>
              <div class="trend-chart-item">
                <div class="trend-chart-label trend-chart-label-with-stats">
                  <span>竞价量(万) 近5日</span>
                  <span v-if="p2TrendHistory[group.topic + '|' + stock.stock].diff != null" style="color:#2563eb; font-weight:600;">差值 {{ p2TrendHistory[group.topic + '|' + stock.stock].diff }}</span>
                  <span v-if="p2TrendHistory[group.topic + '|' + stock.stock].jingRatio != null" style="color:#6366f1; font-weight:600;">今/昨比 {{ p2TrendHistory[group.topic + '|' + stock.stock].jingRatio }}</span>
                </div>
                <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].volume" color="#6366f1" />
              </div>
              <div class="trend-chart-item">
                <div class="trend-chart-label trend-chart-label-with-stats">
                  <span>昨日成交量(万) 近5日</span>
                  <span v-if="p2TrendHistory[group.topic + '|' + stock.stock].yestRatio != null" style="color:#10b981; font-weight:600;">昨/前比 {{ p2TrendHistory[group.topic + '|' + stock.stock].yestRatio }}</span>
                </div>
                <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].yestVolume" color="#10b981" />
              </div>
              <div class="trend-chart-item" v-if="p2AucPctHasData(group.topic, stock.stock)">
                <div class="trend-chart-label">竞价涨幅(%) 近5日</div>
                <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].aucPctChg" color="#f59e0b" :percent="true" />
              </div>
              <div class="trend-chart-item" v-if="p2ChangePctHasData(group.topic, stock.stock)">
                <div class="trend-chart-label">涨幅(%) 近5日</div>
                <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].changePct" color="#64748b" :percent="true" />
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import TrendChart from './TrendChart.vue';
import {
  getStarSymbols, getRankAppearText,
  getChangeClass, getChangePctDisplay, getTopicsDisplay, getTopicNameStyle, canGroupExpand
} from '../composables/auction-board-helpers.js';
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
function p2AucPctHasData(topic, stockName) {
  return p2TrendHistory.value[topic + '|' + stockName].aucPctChg.some(p => p.value !== null);
}
function p2ChangePctHasData(topic, stockName) {
  return p2TrendHistory.value[topic + '|' + stockName].changePct.some(p => p.value !== null);
}
</script>
