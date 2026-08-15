<template>
  <div class="monthly-stats-board">
    <div class="weekend-header" style="display: block; text-align: center;">
      <div class="weekend-title">📊 本月交易统计</div>
      <div class="weekend-subtitle">{{ dateRange }}</div>
    </div>
    <div class="weekend-content">
      <!-- 1. 盈亏统计 -->
      <div class="weekend-section">
        <div class="weekend-section-title">💰 本月盈亏</div>
        <div class="weekend-profit-section">
          <div class="weekend-profit-item profit">
            <div class="weekend-profit-label">赚</div>
            <div class="weekend-profit-value">{{ stats.totalProfit.toFixed(0) }}</div>
          </div>
          <div class="weekend-profit-item loss">
            <div class="weekend-profit-label">亏</div>
            <div class="weekend-profit-value">{{ stats.totalLoss.toFixed(0) }}</div>
          </div>
          <div class="weekend-profit-item balance">
            <div class="weekend-profit-label">余额</div>
            <div class="weekend-profit-value">{{ stats.balance.toFixed(0) }}</div>
          </div>
        </div>
      </div>

      <!-- 2. 出手情况统计 -->
      <div class="weekend-section">
        <div class="weekend-section-title" style="display: flex; align-items: center;">
          <span>🎯 出手情况统计</span>
          <span style="font-size: 13px; color: #64748b; font-weight: normal; margin-left: auto; margin-right: 50px;">成交天数 <span style="color: #dc2626; font-weight: 700;">{{ stats.tradingDays }}</span></span>
        </div>
        <div class="weekend-stat-grid">
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓次数</div><div class="weekend-stat-value">{{ stats.emptyCount }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手次数</div><div class="weekend-stat-value">{{ stats.chushouCount }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓对了</div><div class="weekend-stat-value">{{ stats.emptyRight }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓错了</div><div class="weekend-stat-value">{{ stats.emptyWrong }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手对了</div><div class="weekend-stat-value">{{ stats.chushouRight }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手错了</div><div class="weekend-stat-value">{{ stats.chushouWrong }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓胜率</div><div class="weekend-stat-value">{{ stats.emptyWinRate }}%</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手胜率</div><div class="weekend-stat-value">{{ stats.chushouWinRate }}%</div></div>
        </div>
      </div>

      <!-- 2.5 总计统计 -->
      <div class="weekend-section">
        <div class="weekend-section-title" style="display: flex; align-items: center;">
          <span>📌 总计统计</span>
          <span style="font-size: 13px; color: #64748b; font-weight: normal; margin-left: auto; margin-right: 50px;">成交天数 <span style="color: #dc2626; font-weight: 700;">{{ totalStats.tradingDays }}</span></span>
        </div>
        <div class="weekend-subtitle" style="text-align:center; color:#94a3b8; font-size:12px; margin: -4px 0 4px;">{{ totalStats.dateRange }}</div>
        <div style="text-align:center; font-size:12px; color:#f59e0b; margin-bottom:8px;">未记录/未填写天数 <span style="font-weight:700;">{{ totalStats.unrecordedCount }}</span></div>
        <div class="weekend-stat-grid">
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓次数</div><div class="weekend-stat-value">{{ totalStats.emptyCount }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手次数</div><div class="weekend-stat-value">{{ totalStats.chushouCount }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓对了</div><div class="weekend-stat-value">{{ totalStats.emptyRight }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓错了</div><div class="weekend-stat-value">{{ totalStats.emptyWrong }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手对了</div><div class="weekend-stat-value">{{ totalStats.chushouRight }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手错了</div><div class="weekend-stat-value">{{ totalStats.chushouWrong }}</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">空仓胜率</div><div class="weekend-stat-value">{{ totalStats.emptyWinRate }}%</div></div>
          <div class="weekend-stat-item"><div class="weekend-stat-label">出手胜率</div><div class="weekend-stat-value">{{ totalStats.chushouWinRate }}%</div></div>
        </div>
      </div>

      <!-- 3. 本月ETF板块表现 -->
      <div class="weekend-section">
        <div class="weekend-section-title">📊 本月ETF板块表现</div>
        <div class="weekend-stock-list">
          <div v-for="item in topEtfs" :key="item.name" class="weekend-stock-item">
            <span class="weekend-stock-name">{{ item.name }}</span>
            <span class="weekend-stock-count">{{ item.count }}次</span>
          </div>
          <div v-if="topEtfs.length === 0" class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>
        </div>
      </div>

      <!-- 4. 本月最近多板表现 -->
      <div class="weekend-section">
        <div class="weekend-section-title">📈 本月最近多板表现</div>
        <div class="weekend-stock-list">
          <div v-for="item in duibanPerformance" :key="item.name" class="weekend-stock-item">
            <span class="weekend-stock-name">{{ item.name }}</span>
            <span class="weekend-stock-count">{{ item.count }}次</span>
          </div>
          <div v-if="duibanPerformance.length === 0" class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>
        </div>
      </div>

      <!-- 5. 本月上榜最多 -->
      <div class="weekend-section">
        <div class="weekend-section-title" @click="toggleTopStocks">
          🏆 本月上榜最多
          <span class="toggle-icon" :class="{ expanded: topStocksExpanded }">▼</span>
        </div>
        <div class="weekend-stock-list" :class="{ collapsed: !topStocksExpanded, expanded: topStocksExpanded }">
          <div v-for="item in topStocks" :key="item.name" class="weekend-stock-item">
            <span class="weekend-stock-name">{{ item.name }}</span>
            <span class="weekend-stock-count">{{ item.count }}次</span>
          </div>
          <div v-if="topStocks.length === 0" class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>
        </div>
      </div>

      <!-- 6. 记录统计 -->
      <div class="weekend-section">
        <div class="weekend-section-title">📝 记录统计</div>
        <div class="record-stats-container">
          <div class="record-stats-row">
            <div class="record-stats-item"><div class="record-stats-label">最近多板记录</div><div class="record-stats-value">{{ recordStats.duibanCount }}</div></div>
            <div class="record-stats-item"><div class="record-stats-label">题材方向记录</div><div class="record-stats-value">{{ recordStats.topicCount }}</div></div>
            <div class="record-stats-item"><div class="record-stats-label">板块ETF记录</div><div class="record-stats-value">{{ recordStats.etfCount }}</div></div>
          </div>
          <div class="record-stats-row">
            <div class="record-stats-item"><div class="record-stats-label">最近多板胜率</div><div class="record-stats-value">{{ recordStats.duibanWinRate }}%</div></div>
            <div class="record-stats-item"><div class="record-stats-label">题材方向胜率</div><div class="record-stats-value">{{ recordStats.topicWinRate }}%</div></div>
            <div class="record-stats-item"><div class="record-stats-label">板块ETF胜率</div><div class="record-stats-value">{{ recordStats.etfWinRate }}%</div></div>
          </div>
        </div>
      </div>

      <!-- 7. 每日盈亏曲线图 -->
      <div class="weekend-section">
        <div class="weekend-section-title">📈 每日盈亏曲线</div>
        <div class="profit-chart-container">
          <TrendChart :points="profitPoints" color="#dc2626" />
        </div>
      </div>

      <!-- 8. 账户余额曲线图 -->
      <div class="weekend-section">
        <div class="weekend-section-title">💳 账户余额曲线</div>
        <div class="profit-chart-container">
          <TrendChart :points="balancePoints" color="#2563eb" />
        </div>
      </div>

      <!-- 9. 本月总结心得 -->
      <div class="weekend-section">
        <div class="weekend-section-title">💡 本月总结心得</div>
        <div class="weekend-summary-content" @click="openSummaryEdit">
          <div v-if="!summaryText" class="weekend-summary-placeholder">暂无总结心得，点击输入</div>
          <div v-else>{{ summaryText }}</div>
        </div>
      </div>
    </div>

    <!-- [FIX 2026-08-15] 月总结编辑：原 openMonthlySummaryModal 为空桩导致点击无反应，
         改为本地 Vue EditModal + stats-logic.writeStats 持久化（同 StatsBoard 评论模式，§4/§8/§10）。 -->
    <EditModal v-model="editModalActive" title="本月总结心得" show-clear clear-text="清空" @save="saveEdit" @clear="clearEdit">
      <textarea v-model="editDraft" style="width:100%;min-height:160px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;resize:vertical;box-sizing:border-box;" placeholder="输入内容..."></textarea>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { getJiwangData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';
import { isTradingDay } from '../logic/date/trading-day-helpers.js';
import { readStats, writeStats } from '../logic/stats/stats-logic.js';
import {
  computeStats,
  computeTopStocks,
  computeTopEtfs,
  computeRecordStats,
  buildProfitPoints,
} from '../logic/stats/stats-calc.js';
// §2/§4/§15：月日期与聚合纯函数下沉 Logic 层（monthly-logic.js）
import { getMonthDates, computeDuibanPerformance, formatDate } from '../logic/stats/monthly-logic.js';
import TrendChart from '../components/TrendChart.vue';
import EditModal from '../components/EditModal.vue';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();

const topStocksExpanded = ref(false);
// [FIX 2026-08-15] 月总结编辑本地化：summaryText 从 jiwang stats 读取，点击经本地 EditModal → writeStats 持久化。
// 字段约定：monthlySummary（月总结）。
const summaryStats = readStats(uiStore.currentDate || '');
const summaryText = ref(summaryStats.monthlySummary || '');
// [FIX 2026-08-15] 日期切换时重新从 stats 加载月总结文本（§17/§24）
watch(() => uiStore.currentDate, () => {
  const s = readStats(uiStore.currentDate || '');
  summaryText.value = s.monthlySummary || '';
});

const editModalActive = ref(false);
const editDraft = ref('');
function openSummaryEdit() {
  editDraft.value = summaryText.value;
  editModalActive.value = true;
}
async function saveEdit() {
  const val = editDraft.value.trim();
  try {
    await writeStats(uiStore.currentDate, { monthlySummary: val }, '✅ 已保存并同步到云端');
    summaryText.value = val;
    editModalActive.value = false;
  } catch (e) {
    showToast('保存失败：' + (e && e.message ? e.message : '未知错误'));
  }
}
async function clearEdit() {
  try {
    await writeStats(uiStore.currentDate, { monthlySummary: '' }, '✅ 已清空并同步到云端');
    summaryText.value = '';
    editModalActive.value = false;
  } catch (e) {
    showToast('清空失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

// 响应式根：依赖 uiStore.currentDate（Pinia 响应式），DashboardView 按日期切换挂载后随日期重算。
// 所有 computed 均以 currentDate 为依赖根，无需额外 watch（§17/§26 日期切换响应式边界）。
const currentDate = computed(() => uiStore.currentDate || '');

const dateRange = computed(() => {
  const dates = getMonthDates(currentDate.value);
  if (dates.length === 0) return '--';
  return `${dates[0]} ~ ${dates[dates.length - 1]}`;
});

// 以下均为共享统计 computed（与 WeekendStatsBoard 同源 stats-calc）。
// 防御性包裹（§10 不静默、§11 fail-soft）：任一共算内部 getter 抛错时降级为安全默认值，
// 避免「一个 getter 抛错 → 整个看板渲染失败 → 一片空白」。错误均 console.error 上报，
// 根因若落在 stats-calc 内部，交由 Agent 1 修复。
const EMPTY_STATS = {
  totalProfit: 0, totalLoss: 0, balance: 0, tradingDays: 0, emptyCount: 0,
  chushouCount: 0, emptyRight: 0, emptyWrong: 0, chushouRight: 0, chushouWrong: 0,
  emptyWinRate: 0, chushouWinRate: 0,
};

const stats = computed(() => {
  try { return computeStats(getMonthDates(currentDate.value)); }
  catch (e) { console.error('[MonthlyStats] computeStats 失败（已降级为全 0）:', e); return { ...EMPTY_STATS }; }
});

const totalStats = computed(() => {
  const startDate = '2026-02-01';
  const end = currentDate.value || formatDate(new Date());
  const dates = [];
  const d = new Date(startDate + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  while (d <= endD) {
    dates.push(formatDate(d));
    d.setDate(d.getDate() + 1);
  }
  let r;
  try { r = computeStats(dates); }
  catch (e) { console.error('[MonthlyStats] computeStats(total) 失败（已降级为全 0）:', e); r = { ...EMPTY_STATS }; }
  r.dateRange = `${startDate} 至 ${end}`;
  let unrecorded = 0;
  const jiwangData = getJiwangData() || {};   // §10 防御：getter 失败不抛错、不伪装成空去删除
  dates.forEach(dt => {
    if (isTradingDay(dt)) {
      const dayJiwang = jiwangData[dt];
      if (!dayJiwang || !dayJiwang.jielun) unrecorded++;
    }
  });
  r.unrecordedCount = unrecorded;
  return r;
});

const topStocks = computed(() => {
  try { return computeTopStocks(getMonthDates(currentDate.value)); }
  catch (e) { console.error('[MonthlyStats] computeTopStocks 失败:', e); return []; }
});
const topEtfs = computed(() => {
  try { return computeTopEtfs(getMonthDates(currentDate.value)); }
  catch (e) { console.error('[MonthlyStats] computeTopEtfs 失败:', e); return []; }
});

// §4 Logic 层下沉：聚合逻辑已收口到 monthly-logic.computeDuibanPerformance。
// 此处仅编排（读取 Data 层 getter → 委托 Logic 聚合），保持消除恒空 bug（§10/§11 fail-soft）。
const duibanPerformance = computed(() => {
  try { return computeDuibanPerformance(getJiwangData() || {}, getMonthDates(currentDate.value)); }
  catch (e) { console.error('[MonthlyStats] duibanPerformance 失败:', e); return []; }
});

const recordStats = computed(() => {
  try { return computeRecordStats(getMonthDates(currentDate.value)); }
  catch (e) {
    console.error('[MonthlyStats] computeRecordStats 失败:', e);
    return { duibanCount: 0, topicCount: 0, etfCount: 0, duibanWinRate: 0, topicWinRate: 0, etfWinRate: 0 };
  }
});

function toggleTopStocks() { topStocksExpanded.value = !topStocksExpanded.value; }

// W-03：复用 <TrendChart> 组件替代自绘 canvas（遵循 §30 图表性能规范）。
// 防御性包裹：buildProfitPoints 内部若抛错（B 类 getter 异常），降级为空数组，避免整块看板空白。
// buildProfitPoints 期望接收一个「返回日期数组的函数」(getDates())，故用 thunk 包裹，
// 在 computed 求值期读取 currentDate.value → 保持响应式依赖（§17）。
const profitPoints = computed(() => {
  try { return buildProfitPoints(() => getMonthDates(currentDate.value)).profitPoints; }
  catch (e) { console.error('[MonthlyStats] buildProfitPoints(profit) 失败:', e); return []; }
});
const balancePoints = computed(() => {
  try { return buildProfitPoints(() => getMonthDates(currentDate.value)).balancePoints; }
  catch (e) { console.error('[MonthlyStats] buildProfitPoints(balance) 失败:', e); return []; }
});
</script>