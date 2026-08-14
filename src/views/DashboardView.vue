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

    <!-- 统计导航栏（模式看板上方） -->
    <div class="stats-nav-bar">
      <button class="stats-nav-btn weekly" @click="showWeekly">本周统计</button>
      <button class="stats-nav-btn monthly" @click="showMonthly">本月统计</button>
      <button class="stats-nav-btn back-current" @click="goToday">返回当前</button>
    </div>

    <PatternBoard />

    <template v-if="!statsMode">
      <BiddingBoard />
      <JiwangBoard />
      <StatsBoard />
      <StarStatsBoard />
      <EmotionBoard />
      <AuctionBoard />
      <DuibanBoard />
      <EtfBoard />
      <HomeStocksView ref="stocksRef" />
    </template>

    <WeekendStatsBoard v-if="statsMode === 'weekly'" />
    <MonthlyStatsBoard v-if="statsMode === 'monthly'" />

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
          <span class="picker-month-title">{{ pickerYear }}年{{ pickerMonth + 1 }}月</span>
          <button @click="nextPickerMonth">›</button>
        </div>
        <!-- 旧版 7 列日历：星期表头 + 圆形日期格（normal-day/weekend/holiday/selected/empty） -->
        <div class="date-picker-calendar">
          <template v-for="cell in pickerDays" :key="cell.key">
            <div v-if="cell.type === 'header'" class="calendar-header">{{ cell.label }}</div>
            <div v-else-if="cell.type === 'empty'" class="calendar-day empty"></div>
            <div v-else class="calendar-day" :class="cell.cls" @click="selectPickerDate(cell.key)">{{ cell.label }}</div>
          </template>
        </div>
        <div class="date-picker-actions">
          <button @click="pickerGoToday">今天</button>
          <button class="holiday-toggle-btn" :class="{ 'is-holiday': pickerHolidayLabel === '取消假期' }" @click="togglePickerHoliday">{{ pickerHolidayLabel }}</button>
          <button @click="datePickerActive = false">取消</button>
        </div>
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { setCurrentDate, saveData } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay, getMostRecentTradingDay, getHolidays, getTradingDays, isTradingDay, toggleHoliday } from '../logic/trading-day-helpers.js';
import { _emit } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';
import { showToast } from '../composables/useToast.js';
import EditModal from '../components/EditModal.vue';
import HomeStocksView from './HomeStocksView.vue';
import AuctionBoard from './AuctionBoard.vue';
import BiddingBoard from './BiddingBoard.vue';
import PatternBoard from './PatternBoard.vue';
import DuibanBoard from './DuibanBoard.vue';
import EtfBoard from './EtfBoard.vue';
import JiwangBoard from './JiwangBoard.vue';
import EmotionBoard from './EmotionBoard.vue';
import StatsBoard from './StatsBoard.vue';
import StarStatsBoard from './StarStatsBoard.vue';
import WeekendStatsBoard from './WeekendStatsBoard.vue';
import MonthlyStatsBoard from './MonthlyStatsBoard.vue';
import { useScoreCalculation } from '../composables/useScoreCalculation.js';

const { showWeekly: _showWeekly, showMonthly: _showMonthly } = useScoreCalculation();

const statsMode = ref(null);

function showWeekly() { statsMode.value = 'weekly'; _showWeekly(); }
function showMonthly() { statsMode.value = 'monthly'; _showMonthly(); }

watch(statsMode, (mode) => {
  if (mode) document.body.classList.add('weekend-mode');
  else document.body.classList.remove('weekend-mode');
});

// [A4-02] Dashboard 卸载时清理 weekend-mode 类，避免 document.body 残留样式（原只在 watch 内增删，缺卸载清理）。
onUnmounted(() => {
  document.body.classList.remove('weekend-mode');
});

const stocksRef = ref(null);
const uiStore = useUiStore();
// [A4-04] 移除冗余 currentDate：getCurrentDate() 仅是 useUiStore().currentDate 的包装，
// uiStore.currentDate || getCurrentDate() 恒等于 uiStore.currentDate，统一走响应式 uiStore。
const currentDate = computed(() => uiStore.currentDate);

const weekdayText = computed(() => {
  const d = uiStore.currentDate;
  if (!d) return '';
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[new Date(d + 'T00:00:00').getDay()];
});

// [FEATURE] 假期双向切换：holidayTick 用于在非响应式的 allData.holidays/tradingDays（§6：allData 为内存 cache，非真相源）变更后强制重算
const holidayTick = ref(0);

// 日期选择器内选中日期的假期切换按钮文案（描述"将要执行的动作"）
const pickerHolidayLabel = computed(() => {
  void holidayTick.value;
  const d = pickerSelected.value || uiStore.currentDate;
  if (!d) return '设为假期';
  return isTradingDay(d) ? '设为假期' : '取消假期';
});

function togglePickerHoliday() {
  const d = pickerSelected.value || uiStore.currentDate;
  if (!d) return;
  const result = toggleHoliday(d);
  if (!result) return;
  saveData();
  holidayTick.value++;
  showToast(result === 'holiday' ? '已设为假期' : '已取消假期（设为交易日）');
}

// [A4-01] 移除日期切换的「8 路全量重算广播」。
// 各看板（Auction/Jiwang/Stats/Bidding/HomeStocks/Emotion/StarStats）均自行
// watch(() => uiStore.currentDate) 响应日期切换；ETF/Duiban 经 useBoardData 内部
// watch(uiStore.currentDate) 重新拉取云端。日期变化已由 setCurrentDate 经响应式
// uiStore.currentDate 统一驱动，无需 Dashboard 主动广播触发无目的全量重算/重复请求。
function goToPrevTradingDay() {
  const prev = getPreviousTradingDay(uiStore.currentDate);
  if (prev) setCurrentDate(prev);
}
function goToNextTradingDay() {
  const next = getNextTradingDay(uiStore.currentDate);
  if (next) setCurrentDate(next);
}
function goToday() {
  statsMode.value = null;
  const today = getMostRecentTradingDay();
  if (today) setCurrentDate(today);
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

// [PERF] 本地今日，仅用于自动识别非交易日（与旧 isAutoHoliday 一致）
function _localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pickerDays = computed(() => {
  void holidayTick.value; // 假期状态切换后强制重算日历着色
  const year = pickerYear.value;
  const month = pickerMonth.value;
  const selected = pickerSelected.value || uiStore.currentDate;

  // [PERF] 一次性取值并转 Set，逐日 O(1) 查询。
  // 旧版 getHolidays()/isAutoHoliday() 逐日调用 loadAllData()，一个月约 32 次数据读取，是卡顿根因。
  // [A4-03/§8] holidays / tradingDays 是非业务的「交易日历参考缓存」（localStorage 配置模块，
  // 无云端同步，见 trading-day-helpers.toggleHoliday 注释），不属于用户业务数据，按 §8 允许保留本地，
  // 仅用于日历着色与交易日推算，不可当作业务真相源。
  const holSet = new Set(getHolidays());
  const tdSet = new Set(getTradingDays());
  const todayLocal = _localTodayStr();
  const oneYearAgo = (() => {
    const d = new Date(todayLocal + 'T00:00:00');
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const cells = [];
  weekDays.forEach((w) => cells.push({ key: 'h-' + w, type: 'header', label: w }));

  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < startWeekday; i++) cells.push({ key: 'pad-' + i, type: 'empty' });

  for (let day = 1; day <= lastDate; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holSet.has(dateStr);
    // 自动识别非交易日：非假期、非周末、不在交易日列表、且落在最近一年内（与旧 isAutoHoliday 等价）
    const autoHoliday = !isHoliday && !isWeekend && !tdSet.has(dateStr) && dateStr >= oneYearAgo && dateStr <= todayLocal;
    let cls = 'normal-day';
    if (dateStr === selected) cls = 'selected';
    else if (isHoliday || autoHoliday) cls = 'holiday';
    else if (isWeekend) cls = 'weekend';
    cells.push({ key: dateStr, type: 'day', label: day, cls });
  }
  return cells;
});

function openDatePicker() {
  const cur = uiStore.currentDate;
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
