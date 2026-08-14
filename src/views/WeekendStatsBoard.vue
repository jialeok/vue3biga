<template>
  <div class="weekend-stats-board">
    <div class="weekend-header">
      <div class="weekend-title">📊 本周交易统计</div>
      <div class="weekend-subtitle">{{ dateRange }}</div>
    </div>
    <div class="weekend-content">
      <!-- 周六内容：周统计 -->
      <div class="saturday-content" v-show="isSaturday">
        <!-- 1. 盈亏统计 -->
        <div class="weekend-section">
          <div class="weekend-section-title">💰 本周盈亏</div>
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

        <!-- 3. 本周ETF板块表现 -->
        <div class="weekend-section">
          <div class="weekend-section-title">📊 本周ETF板块表现</div>
          <div class="weekend-stock-list">
            <div v-for="item in topEtfs" :key="item.name" class="weekend-stock-item">
              <span class="weekend-stock-name">{{ item.name }}</span>
              <span class="weekend-stock-count">{{ item.count }}次</span>
            </div>
            <div v-if="topEtfs.length === 0" class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>
          </div>
        </div>

        <!-- 4. 本周最近多板表现 -->
        <div class="weekend-section">
          <div class="weekend-section-title">📈 本周最近多板表现</div>
          <div class="weekend-stock-list">
            <div v-for="item in duibanPerformance" :key="item.name" class="weekend-stock-item">
              <span class="weekend-stock-name">{{ item.name }}</span>
              <span class="weekend-stock-count">{{ item.count }}次</span>
            </div>
            <div v-if="duibanPerformance.length === 0" class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>
          </div>
        </div>

        <!-- 5. 本周上榜最多 -->
        <div class="weekend-section">
          <div class="weekend-section-title" @click="toggleTopStocks">
            🏆 本周上榜最多
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

        <!-- 9. 本周总结心得 -->
        <div class="weekend-section">
          <div class="weekend-section-title">💡 本周总结心得</div>
          <div class="weekend-summary-content" @click="openSummaryEdit">
            <div v-if="!summaryText" class="weekend-summary-placeholder">暂无总结心得，点击输入</div>
            <div v-else>{{ summaryText }}</div>
          </div>
        </div>
      </div>

      <!-- 周日内容：周末总结 -->
      <div class="sunday-content" v-show="!isSaturday">
        <div class="weekend-section">
          <div class="weekend-section-title">📝 本周回顾</div>
          <div class="weekend-summary-content" @click="openReviewEdit">
            <div v-if="!reviewText" class="weekend-summary-placeholder">暂无内容，点击输入</div>
            <div v-else>{{ reviewText }}</div>
          </div>
        </div>
        <div class="weekend-section">
          <div class="weekend-section-title">💡 经验总结</div>
          <div class="weekend-summary-content" @click="openExperienceEdit">
            <div v-if="!experienceText" class="weekend-summary-placeholder">暂无内容，点击输入</div>
            <div v-else>{{ experienceText }}</div>
          </div>
        </div>
        <div class="weekend-section">
          <div class="weekend-section-title">🎯 下周计划</div>
          <div class="weekend-summary-content" @click="openPlanEdit">
            <div v-if="!planText" class="weekend-summary-placeholder">暂无内容，点击输入</div>
            <div v-else>{{ planText }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getJiwangData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';
import { isTradingDay } from '../logic/trading-day-helpers.js';
import { useScoreCalculation } from '../composables/useScoreCalculation.js';
import {
  computeStats,
  computeTopStocks,
  computeTopEtfs,
  computeRecordStats,
  buildProfitPoints,
} from '../logic/stats/stats-calc.js';
import TrendChart from '../components/TrendChart.vue';

const uiStore = useUiStore();
const { openWeekendSummary, openWeekendReview } = useScoreCalculation();

const topStocksExpanded = ref(false);
const summaryText = ref('');
const reviewText = ref('');
const experienceText = ref('');
const planText = ref('');

const currentDate = computed(() => uiStore.currentDate || '');

const isSaturday = computed(() => {
  if (!currentDate.value) return true;
  const d = new Date(currentDate.value + 'T00:00:00');
  return d.getDay() === 6;
});

function getWeekDates() {
  const dates = [];
  const base = currentDate.value;
  if (!base) return dates;
  const d = new Date(base + 'T00:00:00');
  const dow = d.getDay();
  const saturday = new Date(d);
  saturday.setDate(d.getDate() + (6 - dow + 7) % 7);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(saturday);
    dt.setDate(saturday.getDate() - i);
    dates.push(formatDate(dt));
  }
  return dates;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateRange = computed(() => {
  const dates = getWeekDates();
  if (dates.length === 0) return '--';
  return `${dates[dates.length - 1]} 至 ${dates[0]}`;
});

const stats = computed(() => computeStats(getWeekDates()));

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
  const r = computeStats(dates);
  r.dateRange = `${startDate} 至 ${end}`;
  let unrecorded = 0;
  dates.forEach(dt => {
    if (isTradingDay(dt)) {
      const jiwangData = getJiwangData();
      const dayJiwang = jiwangData[dt];
      if (!dayJiwang || !dayJiwang.jielun) unrecorded++;
    }
  });
  r.unrecordedCount = unrecorded;
  return r;
});

const topStocks = computed(() => computeTopStocks(getWeekDates()));
const topEtfs = computed(() => computeTopEtfs(getWeekDates()));
const duibanPerformance = computed(() => []);

const recordStats = computed(() => computeRecordStats(getWeekDates()));

function toggleTopStocks() { topStocksExpanded.value = !topStocksExpanded.value; }
// WX-02：复用既有 modal 链路（useScoreCalculation.openWeekendSummary / openWeekendReview），
// 移除 window.prompt()；总结经 modal → Logic → Data 持久化（遵循架构规范 §8 / §10）。
function openSummaryEdit() { openWeekendSummary(); }
function openReviewEdit() { openWeekendReview(); }
function openExperienceEdit() { openWeekendReview(); }
function openPlanEdit() { openWeekendReview(); }

// W-03：复用 <TrendChart> 组件替代自绘 canvas（遵循 §30 图表性能规范）。
const profitPoints = computed(() => buildProfitPoints(getWeekDates).profitPoints);
const balancePoints = computed(() => buildProfitPoints(getWeekDates).balancePoints);
</script>
