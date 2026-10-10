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
          <!-- [MARKET-STATUS 2026-10-01] 原来是硬编码的绿色「市」，假期（含周末）也照显示，
               与日历上标红的假期自相矛盾（用户反馈：日期标红了下边还写绿色的「市」）。
               改为按 isTradingDay(currentDate) 派生：交易日 → 绿「市」；非交易日 → 红「休」。
               红色样式复用 base.css 里早已存在的 .market-closed（红底红字），⛔ 不新增 CSS。 -->
          <span
            class="market-status"
            :class="isTradingDayNow ? 'market-open' : 'market-closed'"
          >{{ isTradingDayNow ? '市' : '休' }}</span>
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
    <!-- 「涨跌停」看板：独立看板组件（在情绪看板之下、早盘竞价看板之上） -->
    <LimitBoard v-show="boardView === 'trading'" />
    <!-- 「连板天梯晋级」看板：独立看板组件（在涨跌停看板【下面】、竞价一字看板【上面】）。
         数据 100% 照搬早盘竞价（同一份内存数据，连板/竞价涨幅/一字/收盘停板/十日涨幅/题材
         全部复用既有单一真相），不发请求、不落库 —— 收盘覆盖涨幅后晋级成败自动跟着翻。 -->
    <LadderBoard v-show="boardView === 'trading'" />
    <!-- 「竞价一字」看板：独立看板组件（在涨跌停看板之下、早盘竞价看板之上；
         数据来自猫抓数据【另一只小号】的 daily_auc_fd，独立 Edge Function auction-yizi-fetch
         每交易日北京 09:25 抓取，与早盘竞价看板彻底解耦） -->
    <AuctionYiziBoard v-show="boardView === 'trading'" />
    <AuctionBoard v-show="boardView === 'trading'" />
    <!-- 「决策」看板：独立看板组件（紧跟在早盘竞价看板【下面】）
         它不抓数据、不落库，只是把早盘竞价已有的题材分组 / 竞价一字 / 十日涨幅 /
         昨日龙头名册 / 昨日买卖标签，按用户定的规则推演出「今天买什么、昨天买的什么时候卖」。
         组件与样式全部独立（decision- / dcb- 前缀），⛔ 不复用任何其它看板的组件，
         因此挂载在这里不会影响任何既有看板。 -->
    <DecisionBoard v-show="boardView === 'trading'" />
    <!-- 「分笔买卖」看板：独立看板组件（紧跟在「决策」看板【下面】）。
         它只把决策看板选中的买点 / 卖点股票，拿去查 9:30~9:31 这一分钟的分笔，
         按红/绿笔数判开盘强弱（用来复核 竞价买 / 竞价卖 / 尾盘买 / 尾盘卖）。
         组件与样式全部独立（tick- / tbb- 前缀），数据源是猫头鹰 tick_history
         （独立 Edge Function tick-minute-fetch + 独立表 tick_minute_open），
         ⛔ 不改决策看板一行、也不改任何其它看板。 -->
    <TickBoard v-show="boardView === 'trading'" />
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { setCurrentDate, saveData } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay, getPreviousCalendarDay, getNextCalendarDay, getMostRecentTradingDay, getHolidays, isTradingDay, toggleHoliday, replaceHolidayCaches } from '../logic/date/trading-day-helpers.js';
// [TRADING-DAY 2026-09-29] 假期设置必须落云端表 —— worker 只认 trading_day_overrides，
// localStorage 里的 holidays 它读不到（这正是 9/25 中秋标了假期却照跑、10/08 开市日被整轮 skip 的根因）。
import { pullTradingDayOverrides, saveTradingDayOverride } from '../data/trading-day-overrides.js';
import { _emit } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';
import { showToast } from '../composables/useToast.js';
import EditModal from '../components/EditModal.vue';
import HomeStocksView from './HomeStocksView.vue';
import AuctionBoard from './AuctionBoard.vue';
import DecisionBoard from './DecisionBoard.vue';
import TickBoard from './TickBoard.vue';
import BiddingBoard from './BiddingBoard.vue';
import PatternBoard from './PatternBoard.vue';
import DuibanBoard from './DuibanBoard.vue';
import EtfBoard from './EtfBoard.vue';
import JiwangBoard from './JiwangBoard.vue';
import EmotionBoard from './EmotionBoard.vue';
import LimitBoard from './LimitBoard.vue';
import LadderBoard from './LadderBoard.vue';
import AuctionYiziBoard from './AuctionYiziBoard.vue';
import StatsBoard from './StatsBoard.vue';
import StarStatsBoard from './StarStatsBoard.vue';
import WeekendStatsBoard from './WeekendStatsBoard.vue';
import MonthlyStatsBoard from './MonthlyStatsBoard.vue';
import { useStatsView } from '../composables/useStatsView.js';

// [STATS-VIEW] 模板由当前日期派生（单一真相源在 useStatsView），手动按钮仅作覆盖。
const statsView = useStatsView();
const boardView = statsView.boardView;

// [WEEKEND-FIX 2026-10-01] 必须 immediate —— 否则「假期页面混着交易日看板」：
//   直接落在周末/假期（App 打开时当前日期就是非交易日；或午夜自然翻页后重新加载）时，
//   boardView 一上来就是 'weekly'，watch 不触发 ⇒ body 上永远没有 weekend-mode
//   ⇒ weekend.css 的 `body.weekend-mode .trading-day-element { display:none !important }` 失效
//   ⇒ 模式看板 / 最近多板 / 添加股票（HomeStocks）等整片照常显示；而「周末统计页」走的是
//   v-show，反倒正常显示 —— 正是用户看到的「假期页面不标准、混着交易日看板」。
//   ⚠️ 另有一层原因记录在此（本轮不动，仅备查）：DuibanBoard / HomeStocksView 的模板有【多个根节点】，
//   加在它们身上的 v-show 会被 Vue 静默忽略（非元素根节点），只能靠 weekend-mode 这个 body class 隐藏。
watch(boardView, (mode) => {
  if (mode && mode !== 'trading') document.body.classList.add('weekend-mode');
  else document.body.classList.remove('weekend-mode');
}, { immediate: true });

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

// [MARKET-STATUS 2026-10-01] 日期下方「市 / 休」徽标的判据：当前日期是不是交易日。
//   交易日 → 绿「市」；非交易日（显式假期 或 周六/周日）→ 红「休」。
//   ⚠️ isTradingDay 读的是【非响应式】的 allData.holidays（§6：它只是内存 cache，真相源在
//      Supabase 的 trading_day_overrides 表）⇒ 必须依赖 holidayTick，才能在「设为/取消假期」
//      与挂载时云端覆盖表同步（replaceHolidayCaches）之后重算 —— 与 pickerHolidayLabel / pickerDays
//      同一套 ref-driven 范式，⛔ 不要改成读某处 state。
const isTradingDayNow = computed(() => {
  void holidayTick.value;
  const d = uiStore.currentDate;
  if (!d) return true; // 日期未就绪的安全默认：按交易日显示（与 boardView 同一兜底取向）
  return isTradingDay(d);
});

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
  // 本地先翻转：UI 零延迟（云端写入是异步的，绝不能挡住交互）
  const result = toggleHoliday(d);
  if (!result) return;
  saveData();
  holidayTick.value++;
  showToast(result === 'holiday' ? '已设为假期' : '已取消假期（设为交易日）');

  // [TRADING-DAY 2026-09-29] 同步落云端覆盖表 —— worker 只认这张表（localStorage 它读不到）。
  //   失败必须显式提示：否则用户以为标好了，实际 9:25 那轮 worker 照跑 / 照跳（§10 禁止静默失败）。
  saveTradingDayOverride(d, result === 'holiday', 'frontend')
    .catch((e) => {
      const msg = (e && e.message) || '未知错误';
      console.error('[TRADING-DAY] 假期设置落云端失败:', msg);
      showToast('⚠️ 已在本机生效，但没能同步到云端：worker 可能读不到这个假期设置（' + msg + '）');
    });
}

// [TRADING-DAY 2026-09-29] 启动时用云端覆盖表重建本地假期缓存：
//   · 跨设备一致（换台电脑也能看到自己标过的假期，不再只活在这台机器的 localStorage 里）；
//   · 把本功能上线前只存在 localStorage 的旧标注一次性迁移上云（见 pullTradingDayOverrides 的迁移保护）。
// 失败时保留本地缓存不动（函数内部已记日志），不打扰用户。
onMounted(async () => {
  try {
    const r = await pullTradingDayOverrides();
    if (r.ok) {
      replaceHolidayCaches(r.holidays, r.tradingDays);
      saveData();
      holidayTick.value++;
    }
  } catch (e) {
    console.warn('[TRADING-DAY] 假期覆盖表同步失败（保留本地缓存）:', (e && e.message) || e);
  }
});

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
    // [A4-03/§8] holidays / tradingDays 是非业务的「交易日历参考缓存」，不属于用户业务数据，
    // 按 §8 允许保留本地，仅用于日历着色与交易日推算，不可当作业务真相源。
    // [TRADING-DAY 2026-09-29] 真相源已上移到 Supabase 的 trading_day_overrides 表 ——
    // worker 只认那张表（localStorage 它读不到），本地这份是它的缓存副本，
    // 由本组件挂载时的 pullTradingDayOverrides() → replaceHolidayCaches() 重建。
    // 若某天看到「日历标红了但 worker 照跑」，先查云端表里有没有对应行。
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
