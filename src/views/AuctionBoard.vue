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
         @touchend.passive="onSwipeEnd"
         @mousedown="onSwipeStart"
         @mouseup="onSwipeEnd">
      <div v-show="currentPage === 0" class="auction-scroll-container" @dblclick.self="openBackend">
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
          <div class="auction-header-item auction-header-yest">昨日成交量(万)</div>
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
                @dblclick.stop="onShowNote(item.index)"
                @contextmenu.prevent="onLongPress(item.stock)"
                @touchstart.passive="startLongPress(item.stock)"
                @touchend="cancelLongPress"
                @touchmove="cancelLongPress"
                @mousedown="startLongPress(item.stock)"
                @mouseup="cancelLongPress"
                @mouseleave="cancelLongPress">{{ item.stock }}</span>
          <span :class="item.numberClass">{{ item.volumeDisplay }}</span>
          <span class="auction-yest" :class="item.yestColorClass">{{ item.yestVolumeDisplay }}</span>
          <span :class="item.ratioClass">{{ item.ratio }} <span>{{ item.ratioArrow }}</span></span>
          <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
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

      <div v-show="currentPage === 1" class="auction-scroll-container">
        <div v-if="topicGroups.length === 0" class="auction-empty">暂无题材分组数据</div>
        <div v-for="group in topicGroups" :key="group.topic" class="topic-group">
          <div class="topic-group-header">
            <span class="topic-name">{{ group.topic }}</span>
            <span class="topic-strength" v-if="group.strength !== null && group.strength !== undefined">强度: {{ group.strength }}%</span>
            <span class="topic-count">{{ group.stocks.length }}只</span>
          </div>
          <div class="topic-group-body">
            <span v-for="stock in group.stocks" :key="stock.stock" class="topic-stock-item">
              {{ stock.stock }}
              <small v-if="stock.ratioValue">{{ Math.round(stock.ratioValue) }}%</small>
            </span>
          </div>
        </div>
      </div>

      <div v-show="currentPage === 2" class="auction-scroll-container">
        <div class="auction-empty">第3页 — 题材历史（左右滑动翻页）</div>
      </div>

      <div v-show="currentPage === 3" class="auction-scroll-container">
        <div class="auction-empty">第4页 — 复制股票审查（左右滑动翻页）</div>
      </div>
    </div>

    <LongPressTagMenu ref="longPressMenuRef" :data-source="dataSource" />
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue';
import AuctionBadge from '../components/AuctionBadge.vue';
import TrendChart from '../components/TrendChart.vue';
import LongPressTagMenu from '../components/LongPressTagMenu.vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { saveData, getTodayGroupList, patchHotField, patchAuctionField, saveModule,
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
import { getTopicGroups } from '../logic/topic-rules.js';
import { getDisplayNote, parseNoteToFields, extractTopics } from '../logic/note-helpers.js';
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

function openBackend() {
  showBackend.value = !showBackend.value;
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
  overflow-x: hidden !important;
  /* 注意: 不要设 touch-action: pan-y !important;
     该容器没有高度约束、自身不滚动, 若设 pan-y 浏览器会把垂直手势
     当作该容器自己处理而不冒泡到 body, 导致整页划不动。
     pan-x pan-y 表示允许浏览器默认的双向手势, 垂直方向冒泡到 body 滚动。 */
  touch-action: pan-x pan-y;
}
.auction-scroll-container {
  overflow-x: hidden !important;
  padding: 4px 0;
  touch-action: pan-x pan-y;
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
</style>
