<!--
  AuctionBoard.vue 鈥?鏃╃洏绔炰环鐪嬫澘涓荤粍浠?
  杩佺Щ鑷? auction-pages.js + auction-render.js + auction-vue-mount.js + auction-components.js + auction-trend.js
  宸茶縼绉? _syncSortStateToStore(reactive鐩村啓)銆乪xpandAll/collapseAll(expandedSet)銆乬etAuctionStockHistory(import)銆乼oggleAuctionRowSelect(inline)銆乻howAuctionNoteInput(inline)
  淇濇寔濮旀墭: computeAuctionViewData(18涓獁indow渚濊禆)
-->
<template>
  <div class="auction-board" :data-source="dataSource">
    <div class="auction-toolbar">
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byJingYest" @change="toggleSort('byJingYest')" />
        <span>绔?鏄?/span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byRatio" @change="toggleSort('byRatio')" />
        <span>鐜瘮</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byParallel" @change="toggleSort('byParallel')" />
        <span>骞宠</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byJingYestRatio" @change="toggleSort('byJingYestRatio')" />
        <span>绔?鏄ㄦ瘮</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byThreeDayJingDie" @change="toggleSort('byThreeDayJingDie')" />
        <span>涓夋棩绔炶穼</span>
      </label>
      <button class="toolbar-btn" @click="expandAll">鍏ㄩ儴灞曞紑</button>
      <button class="toolbar-btn" @click="collapseAll">鍏ㄩ儴鏀惰捣</button>
      <input
        class="toolbar-search"
        v-model="highlightKeyword"
        placeholder="鎼滅储鑲＄エ鍚?
        @input="onSearch"
      />
    </div>

    <div class="auction-stats-bar">
      <span class="stat-item">鎬绘暟: {{ viewData.rawCount || 0 }}</span>
      <span class="stat-item">寮哄害: {{ viewData.stats && viewData.stats.todayStrength != null ? viewData.stats.todayStrength + '%' : '-' }}</span>
      <span class="stat-item">楂樻瘮: {{ viewData.stats && viewData.stats.highRatioCount || 0 }}</span>
      <span class="stat-item">绔?鏄? {{ viewData.stats && viewData.stats.jingYestCount || 0 }}</span>
      <span class="stat-item page-indicator">
        <button v-for="p in 4" :key="p" class="page-dot" :class="{ active: currentPage === p - 1 }" @click="switchPage(p - 1)">{{ p }}</button>
      </span>
      <button class="toolbar-btn backend-toggle" @click="showBackend = !showBackend">鍚庡彴</button>
    </div>

    <div v-if="showBackend" class="auction-backend-panel">
      <div class="backend-section">
        <span class="backend-label">鍚岃姳椤?</span>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotLimitUpLadderFromThs : fetchLadderConstituentsMain)">姊瓙鎴愬垎</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayVolumeFromThs : fillYesterdayVolumeFromThs)">鏄ㄩ噺濉厖</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTodayYesterdayVolumeFromThs : fillTodayYesterdayVolumeFromThs)">浠婃槰閲?/button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayYesterdayVolumeFromThs : fillYesterdayYesterdayVolumeFromThs)">鏄ㄦ槰閲?/button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotChangePctFromThs : fetchChangePctFromThs)">娑ㄥ箙鎶撳彇</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotHistoryGapPctFromThs : fillAuctionHistoryGapPctFromThs)">鍘嗗彶缂哄彛娑ㄥ箙</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotHistoryGapYestVolumeFromThs : fillAuctionHistoryGapYestVolumeFromThs)">鍘嗗彶缂哄彛鏄ㄩ噺</button>
      </div>
      <div class="backend-section">
        <span class="backend-label">鐚姄:</span>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotTodayAuctionFromNumcat : fetchTodayAuctionFromNumcat)">浠婃棩绔炰环</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchAllHotAuctionFromNumcat : fetchAllAuctionFromNumcat)">鍏ㄩ儴绔炰环</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchThreeDaysHotAuctionFromNumcat : fetchThreeDaysAuctionFromNumcat)">涓夋棩绔炰环</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchFiveDaysHotAuctionFromNumcat : fetchFiveDaysAuctionFromNumcat)">浜旀棩绔炰环</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTopicsFromNumcat : fillTopicsFromNumcat)">棰樻潗濉厖</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotMonitorWarningFromNumcat : fetchMonitorWarningFromNumcat)">鐩戞帶棰勮</button>
      </div>
      <div class="backend-section">
        <span class="backend-label">瀵煎叆:</span>
        <button class="backend-btn" @click="onImportPaste">绮樿创瀵煎叆</button>
        <button class="backend-btn" @click="onHistoryFill">鍘嗗彶濉厖</button>
        <button class="backend-btn" @click="onReplaceConcept">棰樻潗鏇挎崲</button>
      </div>
    </div>

    <div class="auction-swipe-container"
         @touchstart.passive="onSwipeStart"
         @touchend="onSwipeEnd"
         @mousedown="onSwipeStart"
         @mouseup="onSwipeEnd">
      <div v-show="currentPage === 0" class="auction-scroll-container">
        <div v-if="!viewData.items || viewData.items.length === 0" class="auction-empty">
          鏆傛棤鏁版嵁
        </div>

        <div v-if="viewData.obsIndices && viewData.obsIndices.length" class="auction-obs-group">
          <div class="auction-group-label">瑙傚療</div>
          <div v-for="item in obsItems" :key="item.index" :class="item.itemClass" @click="onToggleSelect(item.index)">
            <span :class="item.stockClass"
                  @dblclick.stop="onShowNote(item.index)"
                  @contextmenu.prevent="onLongPress(item.stock)"
                  @touchstart.passive="startLongPress(item.stock)"
                  @touchend="cancelLongPress"
                  @touchmove="cancelLongPress"
                  @mousedown="startLongPress(item.stock)"
                  @mouseup="cancelLongPress"
                  @mouseleave="cancelLongPress">{{ item.stock }}</span>
            <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
            <span :class="item.ratioClass" @click.stop="onExpandTrend(item.index)">
              {{ item.ratio }} <span>{{ item.ratioArrow }}</span>
            </span>
            <span :class="item.numberClass">{{ item.volumeDisplay }}</span>
            <span class="auction-yest" :class="item.yestColorClass">{{ item.yestVolumeDisplay }}</span>
            <span class="auction-note">{{ item.note }}</span>
            <div v-if="expandedSet.has(item.index)" class="auction-trend-panel" style="display:block">
              <TrendChart v-if="trendHistory[item.index]" :points="trendHistory[item.index]" color="#6366f1" />
            </div>
          </div>
        </div>

        <div v-if="viewData.regularIndices && viewData.regularIndices.length" class="auction-regular-group">
          <div v-for="item in regularItems" :key="item.index" :class="item.itemClass" @click="onToggleSelect(item.index)">
            <span :class="item.stockClass"
                  @dblclick.stop="onShowNote(item.index)"
                  @contextmenu.prevent="onLongPress(item.stock)"
                  @touchstart.passive="startLongPress(item.stock)"
                  @touchend="cancelLongPress"
                  @touchmove="cancelLongPress"
                  @mousedown="startLongPress(item.stock)"
                  @mouseup="cancelLongPress"
                  @mouseleave="cancelLongPress">{{ item.stock }}</span>
            <AuctionBadge :item="item" :ctx="{}" :tag-state="item" />
            <span :class="item.ratioClass" @click.stop="onExpandTrend(item.index)">
              {{ item.ratio }} <span>{{ item.ratioArrow }}</span>
            </span>
            <span :class="item.numberClass">{{ item.volumeDisplay }}</span>
            <span class="auction-yest" :class="item.yestColorClass">{{ item.yestVolumeDisplay }}</span>
            <span class="auction-note">{{ item.note }}</span>
            <div v-if="expandedSet.has(item.index)" class="auction-trend-panel" style="display:block">
              <TrendChart v-if="trendHistory[item.index]" :points="trendHistory[item.index]" color="#6366f1" />
            </div>
          </div>
        </div>
      </div>

      <div v-show="currentPage === 1" class="auction-scroll-container">
        <div v-if="topicGroups.length === 0" class="auction-empty">鏆傛棤棰樻潗鍒嗙粍鏁版嵁</div>
        <div v-for="group in topicGroups" :key="group.topic" class="topic-group">
          <div class="topic-group-header">
            <span class="topic-name">{{ group.topic }}</span>
            <span class="topic-strength" v-if="group.strength !== null && group.strength !== undefined">寮哄害: {{ group.strength }}%</span>
            <span class="topic-count">{{ group.stocks.length }}鍙?/span>
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
        <div class="auction-empty">绗?椤?鈥?棰樻潗鍘嗗彶锛堝乏鍙虫粦鍔ㄧ炕椤碉級</div>
      </div>

      <div v-show="currentPage === 3" class="auction-scroll-container">
        <div class="auction-empty">绗?椤?鈥?澶嶅埗鑲＄エ瀹℃煡锛堝乏鍙虫粦鍔ㄧ炕椤碉級</div>
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
let swipeStartX = 0;
let swipeEndX = 0;

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
      newHistory[item.index] = history.map(h => ({ date: h.date, value: h.volume }));
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
  const points = history.map(h => ({ date: h.date, value: h.volume }));
  trendHistory.value = { ...trendHistory.value, [index]: points };
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
  if (e.touches) swipeStartX = e.touches[0].clientX;
  else swipeStartX = e.clientX;
}
function onSwipeEnd(e) {
  if (e.changedTouches) swipeEndX = e.changedTouches[0].clientX;
  else swipeEndX = e.clientX;
  handleSwipe();
}
function handleSwipe() {
  const diff = swipeStartX - swipeEndX;
  const threshold = 50;
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
        .then(() => { refresh(); showToast('鍚庡彴鎿嶄綔瀹屾垚'); })
        .catch(e => { console.error('鍚庡彴鎿嶄綔澶辫触:', e); showToast('鎿嶄綔澶辫触: ' + (e && e.message)); });
    } else {
      refresh();
    }
  } catch (e) {
    console.error('鍚庡彴鎿嶄綔澶辫触:', e);
    showToast('鎿嶄綔澶辫触: ' + (e && e.message));
  }
}
function onImportPaste() {
  const text = prompt('绮樿创绔炰环鏁版嵁锛圕SV/JSON鏍煎紡锛夛細');
  if (!text) return;
  if (props.dataSource === 'hot') runBackend(importHotFromPaste, text);
  else runBackend(importAuctionFromPaste, text);
}
function onReplaceConcept() {
  const text = prompt('绮樿创棰樻潗鏇挎崲鏁版嵁锛?);
  if (!text) return;
  if (props.dataSource === 'hot') runBackend(replaceHotConceptFromPaste, text);
  else runBackend(replaceConceptFromPaste, text);
}
function onHistoryFill() {
  const text = prompt('绮樿创鍘嗗彶濉厖鏁版嵁锛?);
  if (!text) return;
  const date = prompt('鐩爣鏃ユ湡锛圷YYY-MM-DD锛夛細', uiStore.currentDate);
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
  const note = prompt('璇疯緭鍏ユ敞閲婏紙濡傛定骞咃級锛?, currentNote);
  if (note !== null) {
    const normalizedNote = note.replace(/[锛屻€?锛沒/g, ',');
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
      }).catch(e => console.warn('patchHotField note 澶辫触:', e));
    } else {
      patchAuctionField(uiStore.currentDate, auctionList[index].stock, {
        note: normalizedNote,
        change_pct: parsed.changePct,
        topics: parsed.topics
      }).catch(e => console.warn('patchAuctionField note 澶辫触:', e));
    }

    const stockName = auctionList[index].stock;
    syncStockCloseFromAuction(stockName, normalizedNote, uiStore.currentDate);

    const topicsArr = extractTopics(normalizedNote);
    const stockCode = getStockCode(stockName) || auctionList[index].code || '';
    pushStockTopicsToCloud(stockName, topicsArr, stockCode).catch(e => console.warn('pushStockTopicsToCloud 澶辫触:', e));

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
.auction-scroll-container {
  height: 100%;
  overflow-y: auto;
  padding: 4px 0;
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
  width: 20px;
  height: 20px;
  border: 1px solid #d1d5db;
  border-radius: 50%;
  background: #fff;
  font-size: 10px;
  color: #6b7280;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.page-dot.active {
  background: #6366f1;
  color: #fff;
  border-color: #6366f1;
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
.auction-swipe-container {
  flex: 1;
  overflow: hidden;
  position: relative;
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
