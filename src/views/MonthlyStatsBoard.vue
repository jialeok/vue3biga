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
          <canvas ref="profitChartRef" width="350" height="150"></canvas>
        </div>
      </div>

      <!-- 8. 账户余额曲线图 -->
      <div class="weekend-section">
        <div class="weekend-section-title">💳 账户余额曲线</div>
        <div class="profit-chart-container">
          <canvas ref="balanceChartRef" width="350" height="150"></canvas>
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
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { getStocksData, getJiwangData, getEtfData } from '../data/supabase-client.js';
import { getRankData } from '../logic/app-core.js';
import { useUiStore } from '../stores/uiStore.js';
import { isWeekend, isTradingDay } from '../logic/trading-day-helpers.js';

const uiStore = useUiStore();

const topStocksExpanded = ref(false);
const profitChartRef = ref(null);
const balanceChartRef = ref(null);
const summaryText = ref('');

const currentDate = computed(() => uiStore.currentDate || '');

function getMonthDates() {
  const base = currentDate.value;
  if (!base) return [];
  const d = new Date(base + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth();
  const dates = [];
  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let i = 1; i <= lastDay; i++) {
    dates.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
  }
  return dates;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateRange = computed(() => {
  const dates = getMonthDates();
  if (dates.length === 0) return '--';
  return `${dates[0]} ~ ${dates[dates.length - 1]}`;
});

function computeStats(dates) {
  const r = {
    totalProfit: 0, totalLoss: 0, balance: 0,
    tradingDays: 0, emptyCount: 0, chushouCount: 0,
    emptyRight: 0, emptyWrong: 0, chushouRight: 0, chushouWrong: 0,
    emptyWinRate: 0, chushouWinRate: 0,
  };
  const stocksData = getStocksData();
  const jiwangData = getJiwangData();
  dates.forEach(d => {
    if (isTradingDay(d)) {
      r.tradingDays++;
      const dayJiwang = jiwangData[d];
      if (dayJiwang) {
        if (dayJiwang.jielun === '空仓') r.emptyCount++;
        else if (dayJiwang.jielun === '出手') r.chushouCount++;
        if (dayJiwang.chushou === '空仓对了') r.emptyRight++;
        else if (dayJiwang.chushou === '空仓错了') r.emptyWrong++;
        else if (dayJiwang.chushou === '出手对了') r.chushouRight++;
        else if (dayJiwang.chushou === '出手错了') r.chushouWrong++;
      }
    }
    const list = stocksData[d] || [];
    list.forEach(s => {
      if (s.soldRecords) {
        s.soldRecords.forEach(rec => {
          const p = parseFloat(rec.profit) || 0;
          if (p >= 0) r.totalProfit += p;
          else r.totalLoss += Math.abs(p);
        });
      }
    });
  });
  r.balance = r.totalProfit - r.totalLoss;
  r.emptyWinRate = r.emptyRight + r.emptyWrong > 0 ? Math.round(r.emptyRight / (r.emptyRight + r.emptyWrong) * 100) : 0;
  r.chushouWinRate = r.chushouRight + r.chushouWrong > 0 ? Math.round(r.chushouRight / (r.chushouRight + r.chushouWrong) * 100) : 0;
  return r;
}

const stats = computed(() => computeStats(getMonthDates()));

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

function computeTopStocks(dates) {
  const rankData = getRankData() || {};
  const counts = {};
  dates.forEach(d => {
    const dayRank = rankData[d];
    if (dayRank && Array.isArray(dayRank)) {
      dayRank.forEach(item => {
        if (item.stock) counts[item.stock] = (counts[item.stock] || 0) + 1;
      });
    }
  });
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}

function computeTopEtfs(dates) {
  const etfData = getEtfData() || {};
  const counts = {};
  dates.forEach(d => {
    const dayEtf = etfData[d];
    if (dayEtf && Array.isArray(dayEtf)) {
      dayEtf.forEach(item => {
        if (item.name) counts[item.name] = (counts[item.name] || 0) + 1;
      });
    }
  });
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}

const topStocks = computed(() => computeTopStocks(getMonthDates()));
const topEtfs = computed(() => computeTopEtfs(getMonthDates()));
const duibanPerformance = computed(() => []);

const recordStats = computed(() => {
  const dates = getMonthDates();
  const jiwangData = getJiwangData();
  let duibanCount = 0, topicCount = 0, etfCount = 0;
  let duibanRight = 0, topicRight = 0, etfRight = 0;
  dates.forEach(d => {
    const dayJiwang = jiwangData[d];
    if (!dayJiwang) return;
    const st = dayJiwang.stats || {};
    const isRight = dayJiwang.chushou === '空仓对了' || dayJiwang.chushou === '出手对了';
    if (st.recentMulti === true) { duibanCount++; if (isRight) duibanRight++; }
    if (st.topicDirection === true) { topicCount++; if (isRight) topicRight++; }
    if (st.sectorEtf === true) { etfCount++; if (isRight) etfRight++; }
  });
  return {
    duibanCount, topicCount, etfCount,
    duibanWinRate: duibanCount > 0 ? Math.round(duibanRight / duibanCount * 100) : 0,
    topicWinRate: topicCount > 0 ? Math.round(topicRight / topicCount * 100) : 0,
    etfWinRate: etfCount > 0 ? Math.round(etfRight / etfCount * 100) : 0,
  };
});

function toggleTopStocks() { topStocksExpanded.value = !topStocksExpanded.value; }
function openSummaryEdit() { const t = prompt('编辑本月总结心得', summaryText.value); if (t !== null) summaryText.value = t; }

function drawChart(canvas, data, color) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (data.length === 0) return;
  const w = canvas.width, h = canvas.height;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

watch([() => stats.value, profitChartRef, balanceChartRef], () => {
  nextTick(() => {
    const dates = getMonthDates();
    const stocksData = getStocksData();
    const dailyProfits = [];
    const balances = [];
    let cumBalance = 0;
    dates.forEach(d => {
      let dayProfit = 0;
      (stocksData[d] || []).forEach(s => {
        (s.soldRecords || []).forEach(r => { dayProfit += parseFloat(r.profit) || 0; });
      });
      dailyProfits.push(dayProfit);
      cumBalance += dayProfit;
      balances.push(cumBalance);
    });
    drawChart(profitChartRef.value, dailyProfits, '#dc2626');
    drawChart(balanceChartRef.value, balances, '#2563eb');
  });
}, { immediate: true });
</script>