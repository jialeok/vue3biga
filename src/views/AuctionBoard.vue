<!--
  AuctionBoard.vue — 早盘竞价看板主组件
  迁移自: auction-pages.js + auction-render.js + auction-vue-mount.js + auction-components.js + auction-trend.js
  已迁移: _syncSortStateToStore(reactive直写)、expandAll/collapseAll(expandedSet)、getAuctionStockHistory(import)、toggleAuctionRowSelect(inline)、showAuctionNoteInput(inline)
  保持委托: computeAuctionViewData(18个window依赖)
-->
<template>
  <div class="auction-board trading-day-element" :class="{ collapsed: !expanded }" :data-source="dataSource">
    <div class="auction-header" @click="toggleBoard" style="cursor:pointer">
      <div>
        <div class="group-tab-bar" @click.stop>
          <span class="group-tab" :class="{ active: dataSource === 'auction' }" @click.stop="$emit('switch-group', 'auction')">早盘竞价</span>
          <span class="group-tab" :class="{ active: dataSource === 'hot' }" @click.stop="$emit('switch-group', 'hot')">热门股票</span>
        </div>
        <div class="auction-title">
          <span>{{ dataSource === 'hot' ? '热门股票' : '早盘竞价' }}</span>
          <span style="margin-left: 8px; font-weight: 600;">强度：<span style="color: #ffffff;">{{ viewData.stats && viewData.stats.todayStrength != null ? viewData.stats.todayStrength + '%' : '-' }}</span></span>
        </div>
        <div class="auction-subtitle"></div>
      </div>
      <div class="auction-header-right">
        <div class="auction-page-indicator">
          <span v-for="p in 4" :key="p" class="page-dot" :class="{ active: currentPage === p - 1 }" @click.stop="switchPage(p - 1)"></span>
        </div>
        <div class="auction-toggle-btn">{{ expanded ? '▲' : '▼' }}</div>
      </div>
    </div>
    <div v-show="expanded" class="auction-swipe-container"
         @touchstart.passive="onSwipeStart"
         @touchend.passive="onSwipeEnd">
      <div v-if="currentPage === 0" class="auction-scroll-container" @dblclick.self="openBackend">
        <div class="auction-toolbar">
          <div class="auction-toggle-item">
            <span class="auction-toggle-label">全部展开</span>
            <label class="auction-toggle-switch">
              <input type="checkbox" @change="($event.target.checked ? expandAll : collapseAll)()" />
              <span class="auction-toggle-slider"></span>
            </label>
          </div>
          <div class="auction-toggle-item">
            <span class="auction-toggle-label">数据</span>
            <label class="auction-toggle-switch">
              <input type="checkbox" :checked="sortState.byData" @change="toggleSort('byData')" />
              <span class="auction-toggle-slider"></span>
            </label>
          </div>
          <div class="auction-toggle-item">
            <span class="auction-toggle-label">环比</span>
            <label class="auction-toggle-switch">
              <input type="checkbox" :checked="sortState.byRatio" @change="toggleSort('byRatio')" />
              <span class="auction-toggle-slider"></span>
            </label>
          </div>
          <div class="auction-toggle-item">
            <span class="auction-toggle-label">平行</span>
            <label class="auction-toggle-switch">
              <input type="checkbox" :checked="sortState.byParallel" @change="toggleSort('byParallel')" />
              <span class="auction-toggle-slider"></span>
            </label>
          </div>
          <div class="auction-toggle-item">
            <span class="auction-toggle-label">竞/昨</span>
            <label class="auction-toggle-switch">
              <input type="checkbox" :checked="sortState.byJingYest" @change="toggleSort('byJingYest')" />
              <span class="auction-toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="auction-highratio-stat">
          <span style="font-weight:700;color:#dc2626;">竞/昨数：{{ viewData.stats && viewData.stats.jingYestCount || '-' }}</span>
          <span style="display:inline-block;width:28px;"></span>竞放量数：<span style="font-weight:700;">{{ viewData.stats && viewData.stats.highRatioCount || '-' }}</span>
        </div>
        <div class="auction-header-row" @click="onHeaderClick" style="cursor:pointer">
          <div class="auction-header-item auction-header-number">序号</div>
          <div class="auction-header-item auction-header-stock">股票名称</div>
          <div class="auction-header-item auction-header-volume">竞价量(万)</div>
          <div class="auction-header-item auction-header-yest">昨成交量(万)</div>
          <div class="auction-header-item auction-header-ratio">占比</div>
        </div>
        <div v-if="searchActive" class="auction-search-container">
          <input type="text" class="auction-search-input" v-model="searchKeyword" placeholder="输入股票名称搜索..." @click.stop />
        </div>
        <div v-if="showBackend" class="auction-backend-panel">
          <div class="backend-section">
            <span class="backend-label">同花顺:</span>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotLimitUpLadderFromThs : fetchLadderConstituentsMain)">梯子成分</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayVolumeFromThs : fillYesterdayVolumeFromThs)">昨量填充</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTodayYesterdayVolumeFromThs : fillTodayYesterdayVolumeFromThs)">今昨量</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayYesterdayVolumeFromThs : fillYesterdayYesterdayVolumeFromThs)">昨昨量</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotChangePctFromThs : fetchChangePctFromThs)">涨幅抓取</button>
          </div>
          <div class="backend-section">
            <span class="backend-label">猫抓:</span>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotTodayAuctionFromNumcat : fetchTodayAuctionFromNumcat)">今日竞价</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchAllHotAuctionFromNumcat : fetchAllAuctionFromNumcat)">全部竞价</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchThreeDaysHotAuctionFromNumcat : fetchThreeDaysAuctionFromNumcat)">三日竞价</button>
            <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTopicsFromNumcat : fillTopicsFromNumcat)">题材填充</button>
          </div>
          <div class="backend-section">
            <span class="backend-label">导入:</span>
            <button class="backend-btn" @click="onImportPaste">粘贴导入</button>
            <button class="backend-btn" @click="onHistoryFill">历史填充</button>
            <button class="backend-btn" @click="onReplaceConcept">题材替换</button>
          </div>
        </div>
        <div v-if="!viewData.items || viewData.items.length === 0" class="auction-empty" @dblclick="openBackend">
          暂无数据，双击打开后台
        </div>

        <div v-for="(item, idx) in filteredItems" :key="item.index" :class="item.itemClass" @click="onToggleSelect(item.index)">
          <span class="auction-number" @click.stop="onExpandTrend(item.index)">{{ idx + 1 }}</span>
          <span :class="item.stockClass"
                :data-stock="item.stock"
                @dblclick.stop="onShowNote(item.index)"
                @contextmenu.prevent="onLongPress(item.stock)"
                @touchstart.passive="startLongPress(item.stock)"
                @touchend="cancelLongPress"
                @touchmove="cancelLongPress"
                @mousedown="startLongPress(item.stock)"
                @mouseup="cancelLongPress"
                @mouseleave="cancelLongPress">
            <span class="auction-stock-text">{{ item.stock }}</span>
            <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
          </span>
          <span :class="item.numberClass">{{ item.volumeDisplay }}</span>
          <span class="auction-yest" :class="item.yestColorClass">{{ item.yestVolumeDisplay }}</span>
          <span :class="item.ratioClass">{{ item.ratio }} <span>{{ item.ratioArrow }}</span></span>
          <div v-if="expandedSet.has(item.index)" class="auction-trend-panel">
            <template v-if="trendHistory[item.index]">
              <div class="trend-chart-item">
                <div class="trend-chart-label">竞价量(万) 近5日</div>
                <TrendChart :points="trendHistory[item.index].volume" color="#6366f1" />
              </div>
              <div class="trend-chart-item">
                <div class="trend-chart-label">昨日成交量(万) 近5日</div>
                <TrendChart :points="trendHistory[item.index].yestVolume" color="#10b981" />
              </div>
              <div class="trend-chart-item" v-if="trendHistory[item.index].changePct.some(p => p.value !== null)">
                <div class="trend-chart-label">涨幅(%) 近5日</div>
                <TrendChart :points="trendHistory[item.index].changePct" color="#64748b" />
              </div>
            </template>
          </div>
        </div>
      </div>

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
        </div>
        <div class="auction-highratio-stat">
          <span style="font-weight:700;color:#dc2626;">竞/昨数：{{ p2JingYestCount }}</span><span style="display:inline-block;width:28px;"></span>竞放量数：<span style="font-weight:700;">{{ p2HighRatioCount }}</span>
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
                  <div class="trend-chart-item">
                    <div class="trend-chart-label">竞价量(万) 近5日</div>
                    <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].volume" color="#6366f1" />
                  </div>
                  <div class="trend-chart-item">
                    <div class="trend-chart-label">昨日成交量(万) 近5日</div>
                    <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].yestVolume" color="#10b981" />
                  </div>
                  <div class="trend-chart-item" v-if="p2TrendHistory[group.topic + '|' + stock.stock].changePct.some(p => p.value !== null)">
                    <div class="trend-chart-label">涨幅(%) 近5日</div>
                    <TrendChart :points="p2TrendHistory[group.topic + '|' + stock.stock].changePct" color="#64748b" />
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-if="currentPage === 2" class="auction-scroll-container">
        <div v-if="page3Data.topics.length === 0" class="auction-empty">暂无符合条件的题材（需5日内出现2次以上）</div>
        <div v-for="topicItem in page3Data.topics" :key="topicItem.topic" class="auction-topic-history-group">
          <div class="auction-topic-history-title">
            <span>{{ topicItem.topic }}</span>
            <span class="auction-topic-copy-btns" v-if="topicItem.data.some(d => d.date === uiStore.currentDate && d.hasData)">
              <span class="auction-topic-copy-btn" @click.stop="copyAllTopicStocks(topicItem.topic)">全复制</span>
              <span class="auction-topic-copy-btn" @click.stop="copyTopicStocks(topicItem.topic, 5)">复制5%</span>
              <span class="auction-topic-copy-btn" @click.stop="copyTopicStocks(topicItem.topic, 2)">复制2%</span>
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
          <div v-for="(dayData, idx) in [...topicItem.data].sort((a,b) => b.date.localeCompare(a.date))"
               :key="topicItem.topic + '-' + dayData.date"
               :class="['auction-topic-history-row', { today: dayData.date === uiStore.currentDate }]">
            <span class="auction-history-col auction-history-date">{{ formatDateShort(dayData.date) }}</span>
            <span class="auction-history-col auction-history-rank" :style="{ color: dayData.rankCount === 0 ? '#9ca3af' : '#9333ea' }">上榜{{ dayData.rankCount }}次</span>
            <template v-if="dayData.hasData">
              <template v-if="dayData.hasChangeData">
                <span class="auction-history-col auction-history-star" :style="{ color: dayData.isUp ? '#ef4444' : '#10b981', fontSize: dayData.starCount >= 6 ? '13px' : '12px', fontWeight: dayData.starCount >= 6 ? 600 : 'normal' }">{{ dayData.starText }}</span>
                <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span :style="{ color: dayData.isUp ? '#ef4444' : '#10b981' }">{{ dayData.strength }}%</span></span>
                <span class="auction-history-col auction-history-count" :style="{ fontSize: '12px', fontWeight: 500, color: dayData.isUp ? '#ef4444' : '#10b981' }">{{ dayData.stockCount }}</span>
                <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span :style="{ color: dayData.isUp ? '#ef4444' : '#10b981' }">{{ dayData.isUp ? '涨' : '跌' }}</span><span v-html="getArrowDisplay(dayData, [...topicItem.data].sort((a,b) => b.date.localeCompare(a.date))[idx + 1])"></span></span>
              </template>
              <template v-else>
                <span class="auction-history-col auction-history-star" :style="{ color: dayData.starCount > 0 ? '#f97316' : '#333', fontSize: dayData.starCount >= 6 ? '13px' : '12px', fontWeight: dayData.starCount >= 6 ? 600 : 'normal' }">{{ dayData.starText }}</span>
                <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span :style="{ color: dayData.starCount > 0 ? '#f97316' : '#333' }">{{ dayData.strength }}%</span></span>
                <span class="auction-history-col auction-history-count" :style="{ fontSize: '12px', fontWeight: 500, color: dayData.starCount > 0 ? '#f97316' : '#333' }">{{ dayData.stockCount }}</span>
                <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span v-html="getArrowDisplay(dayData, [...topicItem.data].sort((a,b) => b.date.localeCompare(a.date))[idx + 1])"></span></span>
              </template>
            </template>
            <template v-else>
              <span class="auction-history-col auction-history-star">-</span>
              <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span style="color:#333;">0%</span></span>
              <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;color:#333;">0</span>
              <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span v-html="getArrowDisplay(dayData, [...topicItem.data].sort((a,b) => b.date.localeCompare(a.date))[idx + 1])"></span></span>
            </template>
          </div>
        </div>
      </div>

      <div v-if="currentPage === 3" class="auction-scroll-container auction-page-4">
        <div v-if="page4DisplayStocks.length === 0" class="auction-copied-placeholder">暂无复制的股票<br>请从第三页复制题材股票</div>
        <div v-else>
          <div v-for="(stock, idx) in page4DisplayStocks" :key="stock.name + '-' + idx" class="auction-copied-row">
            <span class="auction-copied-stock">{{ stock.name }}</span>
            <span class="auction-copied-topic">{{ stock.topic }}</span>
            <span :class="['auction-copied-ratio', { highlight: stock.ratio >= 10, 'highlight-light': stock.ratio >= 4.5 && stock.ratio < 10 }]">{{ stock.ratio }}%<span v-if="stock.arrow === '⬆'" style="color:#ef4444;">⬆</span><span v-if="stock.arrow === '⬇'" style="color:#10b981;">⬇</span></span>
            <span class="auction-copied-delete" @click.stop="deleteCopiedStock(stock.originalIndex)">✕</span>
          </div>
          <div class="auction-clear-all-btn" @click="clearAllCopiedStocks">全部清除</div>
        </div>
      </div>
    </div>

    <LongPressTagMenu ref="longPressMenuRef" :data-source="dataSource" />
    <CoreTopicModal ref="coreTopicModalRef" />
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue';
import AuctionBadge from '../components/AuctionBadge.vue';
import TrendChart from '../components/TrendChart.vue';
import LongPressTagMenu from '../components/LongPressTagMenu.vue';
import CoreTopicModal from '../components/CoreTopicModal.vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { saveData, getTodayGroupList, getGroupData, patchHotField, patchAuctionField, saveModule,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs,
  fillAuctionHistoryGapPctFromThs, fillAuctionHistoryGapYestVolumeFromThs,
  fetchAuctionFromNumcat, fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat,
  fetchThreeDaysAuctionFromNumcat, fetchFiveDaysAuctionFromNumcat,
  fillTopicsFromNumcat, fetchMonitorWarningFromNumcat,
  importAuctionFromPaste, importAuctionHistoryFill, replaceConceptFromPaste,
  fetchHotLimitUpLadderFromThs, fillHotYesterdayVolumeFromThs,
  fillHotTodayYesterdayVolumeFromThs, fillHotYesterdayYesterdayVolumeFromThs,
  fetchHotChangePctFromThs, fillHotHistoryGapPctFromThs, fillHotHistoryGapYestVolumeFromThs,
  fetchHotAuctionFromNumcat, fetchHotTodayAuctionFromNumcat, fetchAllHotAuctionFromNumcat,
  fetchThreeDaysHotAuctionFromNumcat, fetchFiveDaysHotAuctionFromNumcat,
  fillHotTopicsFromNumcat, fetchHotMonitorWarningFromNumcat,
  importHotFromPaste, importHotHistoryFill, replaceHotConceptFromPaste
} from '../logic/app-core.js';
import { getAuctionStockHistory, deriveAuctionTagState } from '../logic/tag-rules.js';
import { getTopicGroups, getTopicRankCountThisWeek } from '../logic/topic-rules.js';
import { getDisplayNote, parseNoteToFields, extractTopics } from '../logic/note-helpers.js';
import { getPreviousTradingDay, isTradingDay } from '../logic/trading-day-helpers.js';
import { getHighRatioStocksForDate, getJingYestHighlightSetForDate, getParallelStocksForDate } from '../logic/auction-sort-rules.js';
import { getNumericVolume } from '../data/supabase-client.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../logic/auction-stock-sync.js';
import { getStockCode } from '../data/stock-code-map.js';
import { pushStockTopicsToCloud } from '../data/stock-topics.js';
import { computeAuctionViewData } from '../logic/auction-view-helpers.js';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();
const auctionStore = useAuctionStore();

const props = defineProps({
  dataSource: { type: String, default: 'auction' }
});

const sortState = reactive({
  byData: false,
  byRatio: false,
  byParallel: false,
  byJingYest: false,
  byJingYestRatio: false,
  byThreeDayJingDie: false
});
const highlightKeyword = ref('');
const expandedSet = ref(new Set());
const trendHistory = ref({});
const longPressMenuRef = ref(null);
const coreTopicModalRef = ref(null);
let longPressTimer = null;
const viewData = ref({ items: [], obsIndices: [], regularIndices: [], stats: {}, rawCount: 0 });

const currentPage = ref(0);
const showBackend = ref(false);
const expanded = ref(false);
let swipeStartX = 0;
let swipeEndX = 0;
let swipeStartY = 0;
let swipeEndY = 0;

function toggleBoard(e) {
  if (e) e.stopPropagation();
  expanded.value = !expanded.value;
}

const topicGroups = computed(() => {
  void viewData.value;
  void uiStore.currentDate;
  const auctionList = getTodayGroupList(props.dataSource);
  if (!auctionList || auctionList.length === 0) return [];
  return getTopicGroups(auctionList);
});

const itemsByIndex = computed(() => {
  const map = new Map();
  (viewData.value.items || []).forEach(it => map.set(it.index, it));
  return map;
});
const obsItems = computed(() => {
  if (!viewData.value.obsIndices) return [];
  const m = itemsByIndex.value;
  return viewData.value.obsIndices.map(i => m.get(i)).filter(Boolean);
});
const regularItems = computed(() => {
  if (!viewData.value.regularIndices) return [];
  const m = itemsByIndex.value;
  return viewData.value.regularIndices.map(i => m.get(i)).filter(Boolean);
});
const allItems = computed(() => {
  return [...obsItems.value, ...regularItems.value];
});

const searchActive = ref(false);
const searchKeyword = ref('');

const filteredItems = computed(() => {
  if (!searchKeyword.value.trim()) return allItems.value;
  const kw = searchKeyword.value.trim().toLowerCase();
  return allItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
});

// ===== 第二页（题材分组）状态与逻辑 =====
const sortState2 = reactive({ byRatio: false, byParallel: false, byJingYest: false });
const isStrengthSortEnabled = ref(false);
const p2ExpandedSet = ref(new Set());
const p2TrendHistory = ref({});
const p2ExpandedTopics = ref(new Set());
const p2ExpandAll = ref(false);

function getStarSymbols(starCount) {
  if (starCount <= 0) return '-';
  if (starCount >= 6) return starCount + '★';
  return '★'.repeat(starCount);
}
function extractChangeFromNote(note) {
  if (!note) return '-';
  const m = note.match(/([+-]?\d+\.?\d*%)/);
  return m ? m[1] : '-';
}
function getChangePctDisplay(item) {
  if (item && item.changePct) {
    if (/^[+-]?\d+\.?\d*%$/.test(item.changePct)) {
      const num = parseFloat(item.changePct);
      if (!isNaN(num) && Math.abs(num) <= 20) return item.changePct;
      return '-';
    }
    return item.changePct;
  }
  return extractChangeFromNote(item ? item.note : '');
}
function canGroupExpand(topic) {
  return topic !== '其它' && topic !== '并购重组';
}
function getRankAppearText(topic) {
  try {
    const cnt = getTopicRankCountThisWeek(topic);
    return cnt > 0 ? ` 上榜${cnt}次` : '';
  } catch (e) { return ''; }
}
function getTopicsDisplay(stock) {
  return stock.topics ? stock.topics.join(',').replace(/[，、;；]/g, ',') : '-';
}
function getStockStyle(stockName) {
  const cnt = p2StockTopicCount.value[stockName] || 1;
  if (cnt >= 3) return 'color:#ef4444;font-weight:500;';
  if (cnt === 2) return 'color:#1f2937;font-weight:500;';
  return 'color:rgba(0,0,0,0.6);font-weight:500;';
}
function getTopicNameStyle() {
  return 'color:#6b7280;font-weight:400;';
}
function getChangeClass(stock) {
  const v = getChangePctDisplay(stock);
  if (v.includes('涨停') || (v.startsWith('-') === false && v !== '-')) return 'auction-topic-change auction-change-red';
  if (v.startsWith('-')) return 'auction-topic-change auction-change-green';
  return 'auction-topic-change';
}
function getTopicRowClass(group, stock) {
  const auctionList = getTodayGroupList(props.dataSource);
  const auctionItem = auctionList.find(it => it.stock && it.stock.trim() === (stock.stock || '').trim());
  let cls = 'auction-topic-row';
  if (auctionItem) {
    const ts2 = deriveAuctionTagState(auctionItem.stock.trim(), uiStore.currentDate);
    if (ts2.sold) cls += ' sold';
    else if (ts2.bought) cls += ' bought';
    else if (ts2.selected) cls += ' selected';
    else if (auctionItem.selected === true) cls += ' manual-selected';
  }
  if (canGroupExpand(group.topic)) cls += ' auction-trend-trigger-p2';
  return cls;
}

const p2StockTopicCount = computed(() => {
  const counts = {};
  topicGroups.value.forEach(g => {
    if (g.topic === '其它') return;
    g.stocks.forEach(s => { if (s.stock) counts[s.stock] = (counts[s.stock] || 0) + 1; });
  });
  return counts;
});

const p2HighRatioInfo = computed(() => {
  try { return getHighRatioStocksForDate(uiStore.currentDate, props.dataSource); }
  catch (e) { return { count: '-', stockNames: new Set() }; }
});
const p2JingYestSet = computed(() => {
  try { return getJingYestHighlightSetForDate(uiStore.currentDate, props.dataSource); }
  catch (e) { return new Set(); }
});
const p2ParallelSet = computed(() => {
  try { return getParallelStocksForDate(uiStore.currentDate, props.dataSource); }
  catch (e) { return new Set(); }
});
const p2JingYestCount = computed(() => p2JingYestSet.value ? p2JingYestSet.value.size : '-');
const p2HighRatioCount = computed(() => p2HighRatioInfo.value ? p2HighRatioInfo.value.count : '-');

const sortedTopicGroups = computed(() => {
  const groups = topicGroups.value;
  if (!groups || groups.length === 0) return [];
  const auctionData = getGroupData(props.dataSource);
  const prevDate = getPreviousTradingDay(uiStore.currentDate);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  const auctionList = getTodayGroupList(props.dataSource);

  const enriched = groups.map(g => {
    if (g.topic === '其它') return { ...g, strength: null };
    let strongCount = 0;
    g.stocks.forEach(stock => {
      let hasDownArrow = false;
      if (prevAuctionList.length > 0 && stock.stock) {
        const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
        if (prevItem && prevItem.yestVolume) {
          const prevVolume = parseFloat(prevItem.volume) || 0;
          const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
          if (prevYestVolume > 0) {
            const prevRatioValue = (prevVolume / prevYestVolume) * 100;
            if (Math.round(stock.ratioValue) < Math.round(prevRatioValue)) hasDownArrow = true;
          }
        }
      }
      if (!hasDownArrow) strongCount++;
    });
    return { ...g, strength: g.stocks.length > 0 ? Math.round((strongCount / g.stocks.length) * 100) : 0 };
  });

  const otherGroup = enriched.find(g => g.topic === '其它');
  let sorted;
  if (isStrengthSortEnabled.value) {
    sorted = enriched.filter(g => g.topic !== '其它').sort((a, b) => (b.strength || 0) - (a.strength || 0));
  } else {
    sorted = enriched.filter(g => g.topic !== '其它').sort((a, b) => (b.strength || 0) - (a.strength || 0));
  }
  if (otherGroup) sorted.push(otherGroup);
  return sorted;
});

function toggleSort2(key) {
  sortState2[key] = !sortState2[key];
}
function toggleStrengthSort() {
  isStrengthSortEnabled.value = !isStrengthSortEnabled.value;
}
function toggleGroupExpand(topic) {
  const topicSet = new Set(p2ExpandedTopics.value);
  const expandSet = new Set(p2ExpandedSet.value);
  const trendHistory = { ...p2TrendHistory.value };
  const group = sortedTopicGroups.value.find(g => g.topic === topic);
  if (!group) return;
  if (topicSet.has(topic)) {
    topicSet.delete(topic);
    group.stocks.forEach(stock => {
      const key = topic + '|' + stock.stock;
      expandSet.delete(key);
      delete trendHistory[key];
    });
  } else {
    topicSet.add(topic);
    group.stocks.forEach(stock => {
      const key = topic + '|' + stock.stock;
      expandSet.add(key);
      if (!trendHistory[key] && stock.stock) {
        trendHistory[key] = loadP2TrendHistory(stock.stock);
      }
    });
  }
  p2ExpandedTopics.value = topicSet;
  p2ExpandedSet.value = expandSet;
  p2TrendHistory.value = trendHistory;
}
function p2ToggleExpandAll() {
  p2ExpandAll.value = !p2ExpandAll.value;
  if (p2ExpandAll.value) {
    const s = new Set();
    sortedTopicGroups.value.forEach(g => { if (canGroupExpand(g.topic)) s.add(g.topic); });
    p2ExpandedTopics.value = s;
  } else {
    p2ExpandedTopics.value = new Set();
  }
}
function loadP2TrendHistory(stockName) {
  const history = getAuctionStockHistory(stockName.trim(), uiStore.currentDate, 5, props.dataSource);
  return {
    volume: history.map(h => ({ date: h.date, value: h.volume })),
    yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
    changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
  };
}
function toggleP2Trend(topic, stockName) {
  if (!canGroupExpand(topic)) return;
  const key = topic + '|' + stockName;
  const s = new Set(p2ExpandedSet.value);
  if (s.has(key)) {
    s.delete(key);
    const h = { ...p2TrendHistory.value };
    delete h[key];
    p2TrendHistory.value = h;
  } else {
    s.add(key);
    p2TrendHistory.value = { ...p2TrendHistory.value, [key]: loadP2TrendHistory(stockName) };
  }
  p2ExpandedSet.value = s;
}

function getLastNTradingDays(n) {
  const days = [];
  let date = uiStore.currentDate;
  while (days.length < n && date) {
    if (typeof isTradingDay === 'function' ? isTradingDay(date) : true) days.push(date);
    date = getPreviousTradingDay(date);
    if (!date) break;
  }
  return days;
}

const page3Data = computed(() => {
  const allTradingDays = getLastNTradingDays(6);
  if (allTradingDays.length === 0) return { topics: [], tradingDays: [] };
  const tradingDays = allTradingDays.slice(0, 5);
  const auctionData = getGroupData(props.dataSource);
  const allTopicData = {};

  allTradingDays.forEach(dateStr => {
    const dayAuctionList = auctionData[dateStr] || [];
    if (dayAuctionList.length === 0) return;
    const groups = getTopicGroups(dayAuctionList);
    groups.forEach(group => {
      if (group.topic === '其它' || group.topic === '并购重组') return;
      if (!allTopicData[group.topic]) allTopicData[group.topic] = [];
      let strongCount = 0, upCount = 0, downCount = 0;
      const prevDate = getPreviousTradingDay(dateStr);
      const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
      group.stocks.forEach(stock => {
        let hasDownArrow = false;
        if (prevAuctionList.length > 0 && stock.stock) {
          const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
          if (prevItem && prevItem.yestVolume) {
            const prevVolume = parseFloat(prevItem.volume) || 0;
            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
            if (prevYestVolume > 0 && Math.round(stock.ratioValue) < Math.round((prevVolume / prevYestVolume) * 100)) hasDownArrow = true;
          }
        }
        if (!hasDownArrow) strongCount++;
        const changeValue = getChangePctDisplay(stock);
        if (changeValue && changeValue !== '-') {
          if (changeValue.includes('涨停') || (!changeValue.startsWith('-') && !changeValue.includes('跌停'))) upCount++;
          else if (changeValue.startsWith('-') || changeValue.includes('跌停')) downCount++;
        }
      });
      allTopicData[group.topic].push({
        date: dateStr, rankCount: 0, starCount: group.starCount,
        starText: getStarSymbols(group.starCount),
        strength: group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0,
        stockCount: group.stocks.length, isUp: upCount >= downCount,
        hasData: true, hasChangeData: upCount > 0 || downCount > 0
      });
    });
  });

  const topicData = {};
  Object.keys(allTopicData).forEach(topic => {
    topicData[topic] = allTopicData[topic].filter(d => tradingDays.includes(d.date));
  });
  Object.keys(topicData).forEach(topic => {
    const existingDates = topicData[topic].map(d => d.date);
    tradingDays.forEach(dateStr => {
      if (!existingDates.includes(dateStr)) {
        topicData[topic].push({ date: dateStr, rankCount: 0, starCount: 0, starText: '-', strength: 0, stockCount: 0, isUp: null, hasData: false, hasChangeData: false });
      }
    });
  });

  const validTopics = Object.entries(topicData)
    .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
    .map(([topic, data]) => ({ topic, data }));

  validTopics.sort((a, b) => {
    const todayDate = tradingDays[0];
    const aToday = a.data.find(d => d.date === todayDate);
    const bToday = b.data.find(d => d.date === todayDate);
    const aHasData = aToday?.hasData || false;
    const bHasData = bToday?.hasData || false;
    if (aHasData !== bHasData) return bHasData ? 1 : -1;
    const aHasStar = aToday?.hasData && (aToday.starCount || 0) > 0;
    const bHasStar = bToday?.hasData && (bToday.starCount || 0) > 0;
    if (aHasStar !== bHasStar) return bHasStar ? 1 : -1;
    const aUpDays = a.data.filter(d => d.hasChangeData && d.isUp).length;
    const bUpDays = b.data.filter(d => d.hasChangeData && d.isUp).length;
    if (aUpDays !== bUpDays) return bUpDays - aUpDays;
    const aStars = a.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
    const bStars = b.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
    return bStars - aStars;
  });

  return { topics: validTopics, tradingDays };
});

function formatDateShort(dateStr) {
  const parts = dateStr.split('-');
  return `${parseInt(parts[1])}月${parseInt(parts[2])}`;
}
function getArrowDisplay(dayData, nextDayData) {
  if (!dayData.hasData) return '<span style="color:#9ca3af;">-</span>';
  if (!nextDayData) return '';
  const currS = dayData.strength || 0, prevS = nextDayData.strength || 0;
  const currStar = dayData.starCount || 0, prevStar = nextDayData.starCount || 0;
  if (currS > prevS) return '<span style="color:#ef4444;">⬆</span>';
  if (currS < prevS) {
    if (prevS > 70 && prevStar > 0) return '<span style="color:#ef4444;">≈</span>';
    if (prevStar === 0 && currStar > 0) return '<span style="color:#ef4444;">⬆</span>';
    return '<span style="color:#10b981;">⬇</span>';
  }
  return '<span style="color:#f97316;">平</span>';
}

const copiedStocks = ref([]);
function loadCopiedStocks() {
  try {
    const all = JSON.parse(localStorage.getItem('copiedStocksData') || '{}');
    copiedStocks.value = all[uiStore.currentDate] || [];
  } catch { copiedStocks.value = []; }
}
function saveCopiedStocks() {
  try {
    const all = JSON.parse(localStorage.getItem('copiedStocksData') || '{}');
    all[uiStore.currentDate] = copiedStocks.value;
    localStorage.setItem('copiedStocksData', JSON.stringify(all));
  } catch {}
}
function copyAllTopicStocks(topic) {
  const auctionList = getTodayGroupList(props.dataSource);
  if (!auctionList || auctionList.length === 0) return;
  const prevDate = getPreviousTradingDay(uiStore.currentDate);
  const auctionData = getGroupData(props.dataSource);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  const groups = getTopicGroups(auctionList);
  const topicGroup = groups.find(g => g.topic === topic);
  if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) return;
  const stocksToCopy = topicGroup.stocks.sort((a, b) => b.ratioValue - a.ratioValue);
  stocksToCopy.forEach(stock => {
    let arrow = '';
    if (prevAuctionList.length > 0 && stock.stock) {
      const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
      if (prevItem && prevItem.yestVolume) {
        const prevVolume = parseFloat(prevItem.volume) || 0;
        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
        if (prevYestVolume > 0) {
          const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
          const currRatio = Math.round(stock.ratioValue);
          if (currRatio > prevRatio) arrow = '⬆';
          else if (currRatio < prevRatio) arrow = '⬇';
        }
      }
    }
    copiedStocks.value.push({ name: stock.stock, topic, ratio: Math.round(stock.ratioValue), arrow });
  });
  saveCopiedStocks();
  switchPage(3);
}
function copyTopicStocks(topic, minRatio) {
  const auctionList = getTodayGroupList(props.dataSource);
  if (!auctionList || auctionList.length === 0) return;
  const prevDate = getPreviousTradingDay(uiStore.currentDate);
  const auctionData = getGroupData(props.dataSource);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  const groups = getTopicGroups(auctionList);
  const topicGroup = groups.find(g => g.topic === topic);
  if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) return;
  const stocksToCopy = topicGroup.stocks.filter(s => Math.round(s.ratioValue) >= minRatio).sort((a, b) => b.ratioValue - a.ratioValue);
  stocksToCopy.forEach(stock => {
    let arrow = '';
    if (prevAuctionList.length > 0 && stock.stock) {
      const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
      if (prevItem && prevItem.yestVolume) {
        const prevVolume = parseFloat(prevItem.volume) || 0;
        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
        if (prevYestVolume > 0) {
          const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
          const currRatio = Math.round(stock.ratioValue);
          if (currRatio > prevRatio) arrow = '⬆';
          else if (currRatio < prevRatio) arrow = '⬇';
        }
      }
    }
    copiedStocks.value.push({ name: stock.stock, topic, ratio: Math.round(stock.ratioValue), arrow });
  });
  saveCopiedStocks();
  switchPage(3);
}
function deleteCopiedStock(index) {
  copiedStocks.value.splice(index, 1);
  saveCopiedStocks();
}
function clearAllCopiedStocks() {
  copiedStocks.value = [];
  saveCopiedStocks();
}

const page4DisplayStocks = computed(() => {
  const stockTopics = {};
  copiedStocks.value.forEach((stock, index) => {
    if (!stockTopics[stock.name]) stockTopics[stock.name] = { stocks: [], topics: new Set() };
    stockTopics[stock.name].stocks.push({ ...stock, originalIndex: index });
    stockTopics[stock.name].topics.add(stock.topic);
  });
  const duplicateStocks = [], uniqueStocks = [];
  Object.keys(stockTopics).forEach(stockName => {
    const data = stockTopics[stockName];
    if (data.topics.size > 1) {
      duplicateStocks.push({
        name: stockName, topic: Array.from(data.topics).join(','),
        ratio: data.stocks[0].ratio, arrow: data.stocks[0].arrow,
        originalIndex: data.stocks[0].originalIndex,
        allOriginalIndexes: data.stocks.map(s => s.originalIndex), isDuplicate: true
      });
    } else {
      uniqueStocks.push({ ...data.stocks[0], allOriginalIndexes: [data.stocks[0].originalIndex], isDuplicate: false });
    }
  });
  return [...duplicateStocks, ...uniqueStocks];
});

function openBackend() {
  showBackend.value = !showBackend.value;
}
function openCoreTopicModal() {
  if (coreTopicModalRef.value) coreTopicModalRef.value.open();
}

function onHeaderClick() {
  searchActive.value = !searchActive.value;
  if (!searchActive.value) searchKeyword.value = '';
}

function refresh() {
  viewData.value = computeAuctionViewData(props.dataSource, sortState);
}

function toggleSort(key) {
  sortState[key] = !sortState[key];
  const _p = props.dataSource === 'hot' ? 'hot' : 'auction';
  if (auctionStore.sortState && auctionStore.sortState[_p]) {
    const s = auctionStore.sortState[_p];
    s.byData = sortState.byData;
    s.byRatio = sortState.byRatio;
    s.byParallel = sortState.byParallel;
    s.byJingYest = sortState.byJingYest;
    s.byJingYestRatio = sortState.byJingYestRatio;
    s.byThreeDayJingDie = sortState.byThreeDayJingDie;
  }
  refresh();
}

function expandAll() {
  const allItems = viewData.value.items || [];
  const newSet = new Set();
  const newHistory = {};
  allItems.forEach(item => {
    if (item && item.stock) {
      newSet.add(item.index);
      const history = getAuctionStockHistory(item.stock.trim(), uiStore.currentDate, 5, props.dataSource);
      newHistory[item.index] = {
        volume: history.map(h => ({ date: h.date, value: h.volume })),
        yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
        changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
      };
    }
  });
  expandedSet.value = newSet;
  trendHistory.value = newHistory;
}

function collapseAll() {
  expandedSet.value = new Set();
  trendHistory.value = {};
}

function loadTrendHistory(index, stockName) {
  const history = getAuctionStockHistory(stockName.trim(), uiStore.currentDate, 5, props.dataSource);
  trendHistory.value = {
    ...trendHistory.value,
    [index]: {
      volume: history.map(h => ({ date: h.date, value: h.volume })),
      yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
      changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
    }
  };
}

function onSearch() {
  if (auctionStore) auctionStore.highlightKeyword = highlightKeyword.value;
  refresh();
}

function switchPage(page) {
  if (page < 0 || page > 3) return;
  currentPage.value = page;
}
function onSwipeStart(e) {
  if (e.touches) { swipeStartX = e.touches[0].clientX; swipeStartY = e.touches[0].clientY; }
  else { swipeStartX = e.clientX; swipeStartY = e.clientY; }
}
function onSwipeEnd(e) {
  if (e.changedTouches) { swipeEndX = e.changedTouches[0].clientX; swipeEndY = e.changedTouches[0].clientY; }
  else { swipeEndX = e.clientX; swipeEndY = e.clientY; }
  handleSwipe();
}
function handleSwipe() {
  const dx = Math.abs(swipeStartX - swipeEndX);
  const dy = Math.abs(swipeStartY - swipeEndY);
  const threshold = 50;
  // 仅当水平位移明显大于垂直位移时才视为左右滑动翻页,
  // 避免用户上下滑动时因手抖水平偏移而误切到空白页。
  if (dx < threshold || dx <= dy) return;
  const diff = swipeStartX - swipeEndX;
  if (diff > threshold && currentPage.value < 3) switchPage(currentPage.value + 1);
  else if (diff < -threshold && currentPage.value > 0) switchPage(currentPage.value - 1);
}

function runBackend(fn, ...args) {
  const task = typeof fn === 'function' ? fn : null;
  if (!task) return;
  try {
    const result = task(...args);
    if (result && typeof result.then === 'function') {
      result
        .then(() => { refresh(); showToast('后台操作完成'); })
        .catch(e => { console.error('后台操作失败:', e); showToast('操作失败: ' + (e && e.message)); });
    } else {
      refresh();
    }
  } catch (e) {
    console.error('后台操作失败:', e);
    showToast('操作失败: ' + (e && e.message));
  }
}
function onImportPaste() {
  const text = prompt('粘贴竞价数据（CSV/JSON格式）：');
  if (!text) return;
  if (props.dataSource === 'hot') runBackend(importHotFromPaste, text);
  else runBackend(importAuctionFromPaste, text);
}
function onReplaceConcept() {
  const text = prompt('粘贴题材替换数据：');
  if (!text) return;
  if (props.dataSource === 'hot') runBackend(replaceHotConceptFromPaste, text);
  else runBackend(replaceConceptFromPaste, text);
}
function onHistoryFill() {
  const text = prompt('粘贴历史填充数据：');
  if (!text) return;
  const date = prompt('目标日期（YYYY-MM-DD）：', uiStore.currentDate);
  if (!date) return;
  if (props.dataSource === 'hot') runBackend(importHotHistoryFill, text, date);
  else runBackend(importAuctionHistoryFill, text, date);
}


function onToggleSelect(index) {
  const auctionList = getTodayGroupList(props.dataSource);
  if (auctionList[index]) {
    const _stockName = auctionList[index].stock ? auctionList[index].stock.trim() : '';
    const _ts = deriveAuctionTagState(_stockName, uiStore.currentDate);
    if (_ts.sold || _ts.bought || _ts.selected) {
      return;
    }
    auctionList[index].selected = !auctionList[index].selected;
    saveData();
    refresh();
  }
}

function onShowNote(index) {
  const auctionList = getTodayGroupList(props.dataSource);
  const currentNote = getDisplayNote(auctionList[index]);
  const note = prompt('请输入注释（如涨幅）：', currentNote);
  if (note !== null) {
    const normalizedNote = note.replace(/[，、;；]/g, ',');
    auctionList[index].note = normalizedNote;
    const parsed = parseNoteToFields(normalizedNote);
    auctionList[index].changePct = parsed.changePct;
    auctionList[index].topics = parsed.topics;
    saveData();
    refresh();

    if (props.dataSource === 'hot') {
      patchHotField(uiStore.currentDate, auctionList[index].stock, {
        note: normalizedNote,
        change_pct: parsed.changePct,
        topics: parsed.topics
      }).catch(e => console.warn('patchHotField note 失败:', e));
    } else {
      patchAuctionField(uiStore.currentDate, auctionList[index].stock, {
        note: normalizedNote,
        change_pct: parsed.changePct,
        topics: parsed.topics
      }).catch(e => console.warn('patchAuctionField note 失败:', e));
    }

    const stockName = auctionList[index].stock;
    syncStockCloseFromAuction(stockName, normalizedNote, uiStore.currentDate);

    const topicsArr = extractTopics(normalizedNote);
    const stockCode = getStockCode(stockName) || auctionList[index].code || '';
    pushStockTopicsToCloud(stockName, topicsArr, stockCode).catch(e => console.warn('pushStockTopicsToCloud 失败:', e));

    syncStockTopicsFromAuction(uiStore.currentDate);
    saveModule('stocks');
  }
}

function onExpandTrend(index) {
  const newSet = new Set(expandedSet.value);
  if (newSet.has(index)) {
    newSet.delete(index);
    const newHistory = { ...trendHistory.value };
    delete newHistory[index];
    trendHistory.value = newHistory;
  } else {
    newSet.add(index);
    const item = viewData.value.items.find(it => it.index === index);
    if (item && item.stock) loadTrendHistory(index, item.stock);
  }
  expandedSet.value = newSet;
}

function startLongPress(stockName) {
  cancelLongPress();
  longPressTimer = setTimeout(() => {
    onLongPress(stockName);
  }, 500);
}
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}
function onLongPress(stockName) {
  cancelLongPress();
  if (stockName && longPressMenuRef.value) {
    longPressMenuRef.value.open(stockName);
  }
}

watch(() => uiStore.currentDate, () => {
  expandedSet.value = new Set();
  trendHistory.value = {};
  refresh();
});

onMounted(() => {
  refresh();
  loadCopiedStocks();
  _on('auction-refresh', refresh);
});
onUnmounted(() => {
  cancelLongPress();
  _off('auction-refresh', refresh);
});

defineExpose({ refresh, toggleSort, expandAll, collapseAll });
</script>

<style>
.auction-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.2s;
  position: relative;
  flex-wrap: wrap;
}
.auction-row:hover { background: #f8fafc; }
.auction-row.obs-row { background: #f0f9ff; }
/* 股票名称列作为 badge 的定位父级。
   - position:relative 让内部 absolute 的 badge-group 相对它定位。
   - 不再用 padding-right 预留角标空间(那会撑宽名称列、挤动后面四列)。
   - badge 改为 absolute 浮动角标, 完全脱离文档流, 五列位置固定不变。
   - overflow:visible 确保角标不被裁剪(父级容器已是 visible)。 */
.auction-stock-name {
  position: relative;
  overflow: visible;
}
.auction-trend-panel {
  width: 100%;
  flex-basis: 100%;
  padding: 8px;
  background: #f9fafb;
  border-top: 1px solid #e5e7eb;
}
.trend-chart-item {
  margin-bottom: 4px;
}
.trend-chart-label {
  font-size: 10px;
  color: #94a3b8;
  margin-bottom: 2px;
}
.auction-swipe-container {
  flex: 1;
  position: relative;
  overflow: visible !important;
  touch-action: auto !important;
  overscroll-behavior: auto !important;
}
.auction-scroll-container {
  overflow: visible !important;
  padding: 4px 0;
  touch-action: auto !important;
  overscroll-behavior: auto !important;
}
.auction-search-container {
  padding: 8px 12px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}
.auction-search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.auction-board-vue {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.auction-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.toolbar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
}
.toolbar-btn {
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.toolbar-search {
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
  width: 120px;
}
.auction-stats-bar {
  display: flex;
  gap: 16px;
  padding: 6px 12px;
  background: #f9fafb;
  font-size: 12px;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
}
.stat-item {
  font-weight: 500;
}
.auction-empty {
  text-align: center;
  color: #9ca3af;
  padding: 40px 0;
  font-size: 14px;
}
.auction-obs-group {
  border-bottom: 2px solid #fbbf24;
  margin-bottom: 4px;
}
.auction-group-label {
  padding: 4px 12px;
  font-size: 11px;
  color: #f59e0b;
  font-weight: 600;
}
.auction-trend-panel {
  padding: 6px 8px 8px;
  background: #f8fafc;
  margin-top: 4px;
}
.page-indicator {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
}
.page-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: all 0.3s;
}
.page-dot.active {
  background: #ffffff;
  transform: scale(1.2);
}
.backend-toggle {
  margin-left: 8px;
  background: #f3f4f6;
  font-weight: 600;
}
.auction-backend-panel {
  padding: 8px 12px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.backend-section {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.backend-label {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  min-width: 50px;
}
.backend-btn {
  padding: 3px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  font-size: 11px;
  cursor: pointer;
  color: #374151;
}
.backend-btn:hover {
  background: #e5e7eb;
}
.topic-group {
  border-bottom: 1px solid #e5e7eb;
  padding: 6px 12px;
}
.topic-group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.topic-name {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}
.topic-strength {
  font-size: 11px;
  color: #dc2626;
  font-weight: 500;
}
.topic-count {
  font-size: 11px;
  color: #6b7280;
  margin-left: auto;
}
.topic-group-body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.topic-stock-item {
  font-size: 12px;
  color: #374151;
  background: #f3f4f6;
  padding: 2px 6px;
  border-radius: 3px;
}
.topic-stock-item small {
  color: #6b7280;
  font-size: 10px;
}
/* ===== 第二页题材分组样式（复刻原始 HTML） ===== */
.auction-toolbar-row2 {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.auction-header-change { flex: 0.6; text-align: center; }
.auction-topic-group {
  margin-bottom: 12px;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 8px;
}
.auction-topic-group:last-child {
  margin-bottom: 0;
  border-bottom: none;
  padding-bottom: 0;
}
.auction-topic-header {
  background: linear-gradient(135deg, #f3e8ff, #ede9fe);
  padding: 6px 2px;
  font-size: 12px;
  font-weight: 600;
  color: #7c3aed;
  display: flex;
  align-items: center;
  border-radius: 6px;
  margin-bottom: 6px;
  user-select: none;
  -webkit-user-select: none;
}
.auction-topic-left {
  flex: 0 0 130px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.auction-topic-stars {
  flex: 0 0 80px;
  text-align: left;
  color: #dc2626;
  font-size: 13px;
  letter-spacing: 1px;
}
.auction-topic-strength {
  flex: 0 0 70px;
  font-size: 12px;
}
.auction-topic-count {
  font-size: 11px;
  color: #9333ea;
  background: rgba(147, 51, 234, 0.1);
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: auto;
}
.auction-topic-expand-row {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 9px 0;
  cursor: pointer;
}
.auction-topic-expand-arrow {
  font-size: 12px;
  color: #9333ea;
  background: rgba(147, 51, 234, 0.12);
  transition: transform 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}
.auction-topic-expand-arrow.expanded {
  transform: rotate(180deg);
}
.auction-topic-row {
  display: flex;
  border-bottom: 1px solid #f1f5f9;
  padding: 6px 0;
  user-select: none;
  -webkit-user-select: none;
}
.auction-topic-row:last-child {
  border-bottom: none;
}
.auction-topic-row.sold { background: #f3f4f6; }
.auction-topic-row.bought { background: #fee2e2; }
.auction-topic-row.selected { background: #f3e8ff; }
.auction-topic-row.high-ratio { box-shadow: inset 4px 0 0 #f59e0b; }
.auction-topic-row.parallel-match { box-shadow: inset 4px 0 0 #10b981; }
.auction-topic-row.jing-yest-match { box-shadow: inset 4px 0 0 #3b82f6; }
.auction-topic-stock {
  flex: 0 0 75px;
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
  padding-left: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-sizing: border-box;
}
.auction-topic-change {
  flex: 0 0 55px;
  font-size: 12px;
  color: #374151;
  text-align: center;
}
.auction-change-red { color: #dc2626; font-weight: 600; }
.auction-change-green { color: #16a34a; font-weight: 600; }
.auction-topic-name {
  flex: 1;
  font-size: 12px;
  color: #6b7280;
  text-align: left;
  padding-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.auction-topic-ratio {
  flex: 0 0 50px;
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  text-align: center;
  padding-right: 10px;
  box-sizing: border-box;
}
.strength-sort-active { color: #7c3aed; font-weight: 700; }
.auction-trend-trigger-p2 { cursor: pointer; }
/* ===== 第三页样式 ===== */
.auction-topic-history-group {
  margin-bottom: 0;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 8px;
}
.auction-topic-history-group:last-child {
  margin-bottom: 0;
  border-bottom: none;
  padding-bottom: 0;
}
.auction-topic-history-title {
  background: linear-gradient(135deg, #dbeafe, #e0e7ff);
  padding: 12px 10px;
  font-size: 14px;
  font-weight: 600;
  color: #3b82f6;
  border-radius: 6px;
  margin-bottom: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.auction-topic-copy-btn {
  font-size: 11px;
  padding: 2px 8px;
  background: #3b82f6;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.auction-topic-copy-btns {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.auction-topic-copy-btn:active { background: #2563eb; }
.auction-topic-history-header {
  display: flex;
  padding: 4px 10px;
  font-size: 11px;
  color: #64748b;
  background: #f8fafc;
  border-radius: 4px;
  margin-bottom: 4px;
}
.auction-topic-history-row {
  display: flex;
  padding: 5px 10px;
  font-size: 11px;
  border-bottom: 1px solid #f1f5f9;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
}
.auction-topic-history-row:last-child { border-bottom: none; }
.auction-topic-history-row.today { background: rgba(239, 68, 68, 0.1); }
.auction-history-col { text-align: center; }
.auction-history-date { flex: 0 0 50px; text-align: left; }
.auction-topic-history-row .auction-history-date { font-size: 12px; }
.auction-history-rank { flex: 0 0 60px; font-size: 11px; }
.auction-history-star { flex: 0 0 75px; letter-spacing: 1px; }
.auction-topic-history-row .auction-history-star { font-size: 12px; }
.auction-history-strength { flex: 0 0 50px; }
.auction-history-count { flex: 0 0 40px; }
.auction-history-arrow { flex: 0 0 35px; }
/* ===== 第四页样式 ===== */
.auction-page-4 { padding-top: 20px; padding-bottom: 100px; }
.auction-copied-row {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 12px;
}
.auction-copied-row:last-child { border-bottom: none; }
.auction-copied-stock { flex: 0 0 70px; font-size: 13px; font-weight: 500; }
.auction-copied-topic { flex: 1; color: #64748b; padding: 0 8px; text-align: center; }
.auction-copied-ratio { flex: 0 0 70px; text-align: right; font-weight: 500; padding-right: 5px; }
.auction-copied-ratio.highlight { color: #dc2626; font-weight: 600; }
.auction-copied-ratio.highlight-light { color: #f87171; font-weight: 600; }
.auction-copied-delete { flex: 0 0 30px; text-align: center; color: #ef4444; cursor: pointer; font-size: 14px; }
.auction-clear-all-btn {
  position: relative;
  margin: 20px auto 0;
  padding: 8px 20px;
  background: #ef4444;
  color: #fff;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
  display: inline-block;
  left: 50%;
  transform: translateX(-50%);
}
.auction-clear-all-btn:active { background: #dc2626; }
.auction-copied-placeholder { text-align: center; padding: 40px 20px; color: #9ca3af; font-size: 12px; }
</style>
