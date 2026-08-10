<!--
  AuctionBoard.vue — 早盘竞价看板主组件
  迁移自: auction-pages.js + auction-render.js + auction-vue-mount.js + auction-components.js + auction-trend.js
  已迁移: _syncSortStateToStore(reactive直写)、expandAll/collapseAll(expandedSet)、getAuctionStockHistory(import)、toggleAuctionRowSelect(inline)、showAuctionNoteInput(inline)
  保持委托: computeAuctionViewData(18个window依赖)
-->
<template>
  <div class="auction-board" :data-source="dataSource">
    <div class="auction-toolbar">
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byJingYest" @change="toggleSort('byJingYest')" />
        <span>竞/昨</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byRatio" @change="toggleSort('byRatio')" />
        <span>环比</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byParallel" @change="toggleSort('byParallel')" />
        <span>平行</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byJingYestRatio" @change="toggleSort('byJingYestRatio')" />
        <span>竞/昨比</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" :checked="sortState.byThreeDayJingDie" @change="toggleSort('byThreeDayJingDie')" />
        <span>三日竞跌</span>
      </label>
      <button class="toolbar-btn" @click="expandAll">全部展开</button>
      <button class="toolbar-btn" @click="collapseAll">全部收起</button>
      <input
        class="toolbar-search"
        v-model="highlightKeyword"
        placeholder="搜索股票名"
        @input="onSearch"
      />
    </div>

    <div class="auction-stats-bar">
      <span class="stat-item">总数: {{ viewData.rawCount || 0 }}</span>
      <span class="stat-item">强度: {{ viewData.stats && viewData.stats.todayStrength != null ? viewData.stats.todayStrength + '%' : '-' }}</span>
      <span class="stat-item">高比: {{ viewData.stats && viewData.stats.highRatioCount || 0 }}</span>
      <span class="stat-item">竞/昨: {{ viewData.stats && viewData.stats.jingYestCount || 0 }}</span>
      <span class="stat-item page-indicator">
        <button v-for="p in 4" :key="p" class="page-dot" :class="{ active: currentPage === p - 1 }" @click="switchPage(p - 1)">{{ p }}</button>
      </span>
      <button class="toolbar-btn backend-toggle" @click="showBackend = !showBackend">后台</button>
    </div>

    <div v-if="showBackend" class="auction-backend-panel">
      <div class="backend-section">
        <span class="backend-label">同花顺:</span>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotLimitUpLadderFromThs : fetchLadderConstituentsMain)">梯子成分</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayVolumeFromThs : fillYesterdayVolumeFromThs)">昨量填充</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTodayYesterdayVolumeFromThs : fillTodayYesterdayVolumeFromThs)">今昨量</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotYesterdayYesterdayVolumeFromThs : fillYesterdayYesterdayVolumeFromThs)">昨昨量</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotChangePctFromThs : fetchChangePctFromThs)">涨幅抓取</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotHistoryGapPctFromThs : fillAuctionHistoryGapPctFromThs)">历史缺口涨幅</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotHistoryGapYestVolumeFromThs : fillAuctionHistoryGapYestVolumeFromThs)">历史缺口昨量</button>
      </div>
      <div class="backend-section">
        <span class="backend-label">猫抓:</span>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotTodayAuctionFromNumcat : fetchTodayAuctionFromNumcat)">今日竞价</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchAllHotAuctionFromNumcat : fetchAllAuctionFromNumcat)">全部竞价</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchThreeDaysHotAuctionFromNumcat : fetchThreeDaysAuctionFromNumcat)">三日竞价</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchFiveDaysHotAuctionFromNumcat : fetchFiveDaysAuctionFromNumcat)">五日竞价</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fillHotTopicsFromNumcat : fillTopicsFromNumcat)">题材填充</button>
        <button class="backend-btn" @click="runBackend(dataSource === 'hot' ? fetchHotMonitorWarningFromNumcat : fetchMonitorWarningFromNumcat)">监控预警</button>
      </div>
      <div class="backend-section">
        <span class="backend-label">导入:</span>
        <button class="backend-btn" @click="onImportPaste">粘贴导入</button>
        <button class="backend-btn" @click="onHistoryFill">历史填充</button>
        <button class="backend-btn" @click="onReplaceConcept">题材替换</button>
      </div>
    </div>

    <div class="auction-swipe-container"
         @touchstart.passive="onSwipeStart"
         @touchend="onSwipeEnd"
         @mousedown="onSwipeStart"
         @mouseup="onSwipeEnd">
      <div v-show="currentPage === 0" class="auction-scroll-container">
        <div v-if="!viewData.items || viewData.items.length === 0" class="auction-empty">
          暂无数据
        </div>

        <div v-if="viewData.obsIndices && viewData.obsIndices.length" class="auction-obs-group">
          <div class="auction-group-label">观察</div>
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

