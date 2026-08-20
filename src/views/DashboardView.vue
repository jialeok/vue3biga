<template>
  <div
    id="gestureArea"
    class="container"
  >
    <!-- 日期导航 -->
    <div class="date-nav">
      <button
        class="nav-btn"
        @click="goToPrevDay"
      >
        ‹
      </button>
      <div
        class="date-selector"
        @click="openDatePicker"
      >
        <div class="date-text">
          {{ currentDate }}
        </div>
        <div style="font-size:11px;margin-top:4px">
          <span>{{ weekdayText }}</span>
          <span class="market-status market-open">市</span>
        </div>
      </div>
      <button
        class="nav-btn"
        @click="goToNextDay"
      >
        ›
      </button>
      <button
        class="today-btn"
        @click="goToday"
      >
        今天
      </button>
    </div>

    <!-- 统计导航栏（模式看板上方） -->
    <div class="stats-nav-bar">
      <button
        class="stats-nav-btn weekly"
        :class="{ active: boardView === 'weekly' }"
        @click="statsView.setMode('weekly')"
      >
        本周统计
      </button>
      <button
        class="stats-nav-btn monthly"
        :class="{ active: boardView === 'monthly' }"
        @click="statsView.setMode('monthly')"
      >
        本月统计
      </button>
      <button
        class="stats-nav-btn back-current"
        @click="goToday"
      >
        返回当前
      </button>
    </div>

    <PatternBoard />

    <!-- [P1-8] trading 态 9 看板由 v-if 改 v-show：跨周末/切 tab 不再 destroy→重建→重查→重算→重订阅。
         组件仅挂载一次（display 切换），日期刷新仍由各看板内部 watch(uiStore.currentDate) 驱动。 -->
    <BiddingBoard v-show="boardView === 'trading'" />
    <JiwangBoard v-show="boardView === 'trading'" />
    <StatsBoard v-show="boardView === 'trading'" />
    <StarStatsBoard v-show="boardView === 'trading'" />
    <EmotionBoard v-show="boardView === 'trading'" />
    <AuctionBoard v-show="boardView === 'trading'" />
    <DuibanBoard v-show="boardView === 'trading'" />
    <EtfBoard v-show="boardView === 'trading'" />
    <HomeStocksView
      v-show="boardView === 'trading'"
      ref="stocksRef"
    />

    <WeekendStatsBoard v-show="boardView === 'weekly'" />
    <MonthlyStatsBoard v-show="boardView === 'monthly'" />

    <!-- 底部操作栏 -->
    <div class="bottom-bar">
      <div style="display:flex;align-items:center">
        <button
          class="icon-btn"
          @click="onExport"
        >
          📤
        </button>
        <span
          style="font-size:16px;margin-left:10px;cursor:pointer;"
          @click="onPullCloud"
        >☁️</span>
        <button
          class="icon-btn"
          style="margin-left:20px"
          @click="onImport"
        >
          📥
        </button>
        <button
          class="date-nav-btn"
          style="margin-left:30px"
          @click="goToPrevTradingDay"
        >
          ◀
        </button>
        <button
          class="date-nav-btn"
          style="margin-left:18px"
          @click="goToNextTradingDay"
        >
          ▶
        </button>
      </div>
      <button
        class="fab"
        style="margin-left:auto"
        @click="onAddStock"
      >
        +
      </button>
    </div>

    <EditModal
      v-model="datePickerActive"
      title="选择日期"
      :show-actions="false"
    >
      <div class="date-picker-section">
        <div class="date-picker-nav">
          <button @click="prevPickerMonth">
            ‹
          </button>
          <span class="picker-month-title">{{ pickerYear }}年{{ pickerMonth + 1 }}月</span>
          <button @click="nextPickerMonth">
            ›
          </button>
        </div>
        <!-- 旧版 7 列日历：星期表头 + 圆形日期格（normal-day/weekend/holiday/selected/empty） -->
        <div class="date-picker-calendar">
          <template
            v-for="cell in pickerDays"
            :key="cell.key"
          >
            <div
              v-if="cell.type === 'header'"
              class="calendar-header"
            >
              {{ cell.label }}
            </div>
            <div
              v-else-if="cell.type === 'empty'"
              class="calendar-day empty"
            />
            <div
              v-else
              class="calendar-day"
              :class="cell.cls"
              @click="selectPickerDate(cell.key)"
            >
              {{ cell.label }}
            </div>
          </template>
        </div>
        <div class="date-picker-actions">
          <button @click="pickerGoToday">
            今天
          </button>
          <button
            class="holiday-toggle-btn"
            :class="{ 'is-holiday': pickerHolidayLabel === '取消假期' }"
            @click="togglePickerHoliday"
          >
            {{ pickerHolidayLabel }}
          </button>
          <button @click="datePickerActive = false">
            取消
          </button>
        </div>
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { setCurrentDate, saveData } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay, getPreviousCalendarDay, getNextCalendarDay, getMostRecentTradingDay, getHolidays, isTradingDay, toggleHoliday } from '../logic/date/trading-day-helpers.js';
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
import { useStatsView } from '../composables/useStatsView.js';

// [STATS-VIEW] 模板由当前日期派生（单一真相源在 useStatsView），手动按钮仅作覆盖。
const statsView = useStatsView();
const boardView = statsView.boardView;

watch(boardView, (mode) => {
  if (mode && mode !== 'trading') document.body.classList.add('weekend-mode');
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
  if (prev) { setCurrentDate(prev); statsView.onDateChanged(); }
}
function goToNextTradingDay() {
  const next = getNextTradingDay(uiStore.currentDate);
  if (next) { setCurrentDate(next); statsView.onDateChanged(); }
}
// 顶部日期导航：按真实日历日 ±1（含周末），用于落在周六/周日展示周末看板。
function goToPrevDay() {
  const prev = getPreviousCalendarDay(uiStore.currentDate);
  if (prev) { setCurrentDate(prev); statsView.onDateChanged(); }
}
function goToNextDay() {
  const next = getNextCalendarDay(uiStore.currentDate);
  if (next) { setCurrentDate(next); statsView.onDateChanged(); }
}
function goToday() {
  statsView.resetToAuto();
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

  const pickerDays = computed(() => {
    void holidayTick.value; // 假期状态切换后强制重算日历着色
    const year = pickerYear.value;
    const month = pickerMonth.value;
    const selected = pickerSelected.value || uiStore.currentDate;

    // [PERF] 一次性取值并转 Set，逐日 O(1) 查询。
    // [A4-03/§8] holidays / tradingDays 是非业务的「交易日历参考缓存」（localStorage 配置模块，
    // 无云端同步，见 trading-day-helpers.toggleHoliday 注释），不属于用户业务数据，按 §8 允许保留本地，
    // 仅用于日历着色与交易日推算，不可当作业务真相源。
    // [FIX 2026-08-21] 日历着色不再做 autoHoliday 推断：未在 tradingDays 登记的 weekday 一律当假期标红是错的
    // （tradingDays 仅手动写入）。规则简化为：显式 holidays=红(假期)，周末=灰，其余 weekday=普通(白)。
    const holSet = new Set(getHolidays());

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
    let cls = 'normal-day';
    if (dateStr === selected) cls = 'selected';
    else if (isHoliday) cls = 'holiday';
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
  statsView.onDateChanged();
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
