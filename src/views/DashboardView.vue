<template>
  <div class="container">
    <div class="date-nav">
      <button class="date-nav-btn" @click="goToPrevTradingDay">‹</button>
      <span class="date-nav-date" @click="openDatePicker">{{ currentDate }}</span>
      <button class="date-nav-btn" @click="goToNextTradingDay">›</button>
      <button class="date-nav-today" @click="goToday">今天</button>
    </div>

    <HomeStocksView ref="stocksRef" />
    <AuctionBoard />
    <BiddingBoard />
    <HotspotBoard />
    <PatternBoard />
    <RankBoard />
    <DuibanBoard />
    <EtfBoard />
    <JiwangBoard />
    <EmotionBoard />
    <StatsBoard />
    <TagTitlesBoard />

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
import { ref, computed, onMounted } from 'vue';
import { getCurrentDate, setCurrentDate } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay, getMostRecentTradingDay, isTradingDay } from '../logic/trading-day-helpers.js';
import { _emit } from '../stores/eventBus.js';
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
const currentDate = computed(() => getCurrentDate());

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
  if (prev) { setCurrentDate(prev); emitAllRefresh(); }
}
function goToNextTradingDay() {
  const next = getNextTradingDay(getCurrentDate());
  if (next) { setCurrentDate(next); emitAllRefresh(); }
}
function goToday() {
  const today = getMostRecentTradingDay();
  if (today) { setCurrentDate(today); emitAllRefresh(); }
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

<style scoped>
.container {
  max-width: 400px;
  margin: 0 auto;
  background: #ffffff;
  min-height: 100vh;
  padding-bottom: 100px;
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.05);
}
.date-nav {
  background: rgba(255, 255, 255, 0.95);
  padding: 12px 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 99;
  backdrop-filter: blur(10px);
  border-bottom: 1px solid #e2e8f0;
}
.date-nav-btn {
  background: none;
  border: none;
  font-size: 20px;
  color: #475569;
  cursor: pointer;
  padding: 4px 12px;
}
.date-nav-date {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  cursor: pointer;
}
.date-nav-today {
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.date-picker-section {
  padding: 10px;
}
.date-picker-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.date-picker-nav button {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 12px;
}
.date-picker-nav span {
  font-weight: 600;
}
.date-picker-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.date-picker-grid button {
  padding: 8px 4px;
  border: 1px solid #e2e8f0;
  background: white;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.date-picker-grid button.date-selected {
  background: #3b82f6;
  color: white;
  border-color: #3b82f6;
}
.date-picker-grid button.date-today {
  border-color: #3b82f6;
  color: #3b82f6;
}
.date-picker-grid button:disabled {
  background: #f1f5f9;
  color: #cbd5e1;
  cursor: default;
}
.date-picker-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
}
.date-picker-actions button {
  padding: 6px 16px;
  border: 1px solid #e2e8f0;
  background: white;
  border-radius: 6px;
  cursor: pointer;
}
</style>