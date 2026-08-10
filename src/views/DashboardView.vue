<template>
  <div class="container" id="gestureArea">
    <!-- 日期导航 -->
    <div class="date-nav">
      <button class="nav-btn" @click="goToPrevTradingDay">‹</button>
      <div class="date-selector" @click="openDatePicker">
        <div class="date-text">{{ currentDate }}</div>
        <div style="font-size:11px;margin-top:4px">
          <span>{{ weekdayText }}</span>
          <span class="market-status market-open">市</span>
        </div>
      </div>
      <button class="nav-btn" @click="goToNextTradingDay">›</button>
      <button class="today-btn" @click="goToday">今天</button>
    </div>

    <PatternBoard />
    <BiddingBoard />
    <JiwangBoard />
    <StatsBoard />
    <EmotionBoard />
    <TagTitlesBoard />
    <AuctionBoard />
    <DuibanBoard />
    <EtfBoard />
    <RankBoard />
    <HotspotBoard />
    <HomeStocksView ref="stocksRef" />

    <!-- 底部操作栏 -->
    <div class="bottom-bar">
      <div style="display:flex;align-items:center">
        <button class="icon-btn" @click="onExport">📤</button>
        <span style="font-size:16px;margin-left:10px;cursor:pointer;" @click="onPullCloud">☁️</span>
        <button class="icon-btn" style="margin-left:20px" @click="onImport">📥</button>
        <button class="date-nav-btn" style="margin-left:30px" @click="goToPrevTradingDay">◀</button>
        <button class="date-nav-btn" style="margin-left:18px" @click="goToNextTradingDay">▶</button>
      </div>
      <button class="fab" style="margin-left:auto" @click="onAddStock">+</button>
    </div>

    <EditModal v-model="datePickerActive" title="选择日期" :show-actions="false">
      <div class="date-picker-section">
        <div class="date-picker-nav">
          <button @click="prevPickerMonth">‹</button>
          <span>{{ pickerYear }}-{{ String(pickerMonth + 1).padStart(2, '0') }}</span>
          <button @click="nextPickerMonth">›</button>
        </div>
        <div class="date-picker-grid">
          <button v-for="day in pickerDays" :key="day.key"
                  :class="{ 'date-selected': day.key === pickerSelected, 'date-today': day.isToday, 'date-disabled': !day.valid }"
                  :disabled="!day.valid"
                  @click="selectPickerDate(day.key)">
            {{ day.label }}
          </button>
        </div>
        <div class="date-picker-actions">
          <button @click="pickerGoToday">今天</button>
          <button @click="datePickerActive = false">取消</button>
        </div>
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getCurrentDate, setCurrentDate } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay, getMostRecentTradingDay } from '../logic/trading-day-helpers.js';
import { _emit } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';
import EditModal from '../components/EditModal.vue';
import HomeStocksView from './HomeStocksView.vue';
import AuctionBoard from './AuctionBoard.vue';
import BiddingBoard from './BiddingBoard.vue';
import HotspotBoard from './HotspotBoard.vue';
import PatternBoard from './PatternBoard.vue';
import RankBoard from './RankBoard.vue';
import DuibanBoard from './DuibanBoard.vue';
import EtfBoard from './EtfBoard.vue';
import JiwangBoard from './JiwangBoard.vue';
import EmotionBoard from './EmotionBoard.vue';
import StatsBoard from './StatsBoard.vue';
import TagTitlesBoard from './TagTitlesBoard.vue';

const stocksRef = ref(null);
const uiStore = useUiStore();
const currentDate = computed(() => uiStore.currentDate || getCurrentDate());

const weekdayText = computed(() => {
  const d = uiStore.currentDate || getCurrentDate();
  if (!d) return '';
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[new Date(d + 'T00:00:00').getDay()];
});

function emitAllRefresh() {
  _emit('stocks-refresh');
  _emit('auction-refresh');
  _emit('bidding-refresh');
  _emit('board-refresh');
  _emit('jiwang-refresh');
  _emit('rank-refresh');
  _emit('duiban-refresh');
  _emit('emotion-refresh');
  _emit('etf-refresh');
}

function goToPrevTradingDay() {
  const prev = getPreviousTradingDay(getCurrentDate());
  if (prev) { uiStore.setDate(prev); setCurrentDate(prev); emitAllRefresh(); }
}
function goToNextTradingDay() {
  const next = getNextTradingDay(getCurrentDate());
  if (next) { uiStore.setDate(next); setCurrentDate(next); emitAllRefresh(); }
}
function goToday() {
  const today = getMostRecentTradingDay();
  if (today) { uiStore.setDate(today); setCurrentDate(today); emitAllRefresh(); }
}

function onAddStock() {
  if (stocksRef.value && stocksRef.value.openModal) {
    stocksRef.value.openModal();
  }
}
function onExport() {
  if (stocksRef.value && stocksRef.value.exportData) {
    stocksRef.value.exportData();
  }
}
function onImport() {
  _emit('show-import-modal');
}
function onPullCloud() {
  _emit('data:cloud-changed');
}

const datePickerActive = ref(false);
const pickerYear = ref(2026);
const pickerMonth = ref(0);
const pickerSelected = ref('');

const pickerDays = computed(() => {
  const days = [];
  const firstDay = new Date(pickerYear.value, pickerMonth.value, 1);
  const startWeekday = firstDay.getDay();
  const lastDate = new Date(pickerYear.value, pickerMonth.value + 1, 0).getDate();
  const todayStr = getMostRecentTradingDay();
  for (let i = 0; i < startWeekday; i++) {
    days.push({ key: 'pad-' + i, label: '', valid: false, isToday: false });
  }
  for (let d = 1; d <= lastDate; d++) {
    const dateStr = pickerYear.value + '-' + String(pickerMonth.value + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    days.push({
      key: dateStr,
      label: d,
      valid: true,
      isToday: dateStr === todayStr,
    });
  }
  return days;
});

function openDatePicker() {
  const cur = getCurrentDate();
  if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur)) {
    pickerYear.value = parseInt(cur.slice(0, 4));
    pickerMonth.value = parseInt(cur.slice(5, 7)) - 1;
    pickerSelected.value = cur;
  }
  datePickerActive.value = true;
}
function selectPickerDate(dateStr) {
  pickerSelected.value = dateStr;
  datePickerActive.value = false;
  uiStore.setDate(dateStr);
  setCurrentDate(dateStr);
  emitAllRefresh();
}
function prevPickerMonth() {
  if (pickerMonth.value === 0) { pickerMonth.value = 11; pickerYear.value--; }
  else pickerMonth.value--;
}
function nextPickerMonth() {
  if (pickerMonth.value === 11) { pickerMonth.value = 0; pickerYear.value++; }
  else pickerMonth.value++;
}
function pickerGoToday() {
  const today = getMostRecentTradingDay();
  selectPickerDate(today);
}
</script>
