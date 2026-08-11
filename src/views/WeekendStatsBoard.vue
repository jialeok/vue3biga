<template>
  <div v-if="visible" class="weekend-stats-board">
    <div class="weekend-header">
      <div class="weekend-title">{{ isMonthly ? '本月交易统计' : '本周交易统计' }}</div>
      <div class="weekend-subtitle">{{ dateRange }}</div>
    </div>
    <div class="weekend-content">
      <div class="weekend-section">
        <div class="weekend-section-title">{{ isMonthly ? '本月盈亏' : '本周盈亏' }}</div>
        <div class="weekend-profit-section">
          <div class="weekend-profit-item profit">
            <div class="weekend-profit-label">赚</div>
            <div class="weekend-profit-value">{{ stats.totalProfit }}</div>
          </div>
          <div class="weekend-profit-item loss">
            <div class="weekend-profit-label">亏</div>
            <div class="weekend-profit-value">{{ stats.totalLoss }}</div>
          </div>
          <div class="weekend-profit-item balance">
            <div class="weekend-profit-label">余额</div>
            <div class="weekend-profit-value">{{ stats.balance }}</div>
          </div>
        </div>
      </div>
      <div class="weekend-section">
        <div class="weekend-section-title">出手情况统计</div>
        <div class="weekend-stat-grid">
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">空仓次数</div>
            <div class="weekend-stat-value">{{ stats.emptyCount }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">出手次数</div>
            <div class="weekend-stat-value">{{ stats.chushouCount }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">出手对了</div>
            <div class="weekend-stat-value">{{ stats.chushouRight }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">出手错了</div>
            <div class="weekend-stat-value">{{ stats.chushouWrong }}</div>
          </div>
        </div>
      </div>
      <div class="weekend-section">
        <div class="weekend-section-title">记录统计</div>
        <div class="weekend-stat-grid">
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">总记录</div>
            <div class="weekend-stat-value">{{ stats.totalRecords }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">已买</div>
            <div class="weekend-stat-value">{{ stats.boughtCount }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">已卖</div>
            <div class="weekend-stat-value">{{ stats.soldCount }}</div>
          </div>
          <div class="weekend-stat-item">
            <div class="weekend-stat-label">持有</div>
            <div class="weekend-stat-value">{{ stats.holdCount }}</div>
          </div>
        </div>
      </div>
      <div class="weekend-section">
        <div class="weekend-section-title">{{ isMonthly ? '本月上榜最多' : '本周上榜最多' }}</div>
        <div class="weekend-stock-list">
          <div v-for="item in topStocks" :key="item.name" class="weekend-stock-item">
            <span class="weekend-stock-name">{{ item.name }}</span>
            <span style="color:#64748b;font-size:12px">{{ item.count }}次</span>
          </div>
          <div v-if="topStocks.length === 0" class="weekend-stock-item">
            <span class="weekend-stock-name">暂无数据</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { getCurrentDate } from '../logic/app-core.js';
import { getStocksData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  isMonthly: { type: Boolean, default: false },
});

const uiStore = useUiStore();

const dateRange = computed(() => {
  return uiStore.currentDate || getCurrentDate() || '--';
});

function getWeekDates() {
  const dates = [];
  const baseDate = uiStore.currentDate || getCurrentDate();
  if (!baseDate) return dates;
  const d = new Date(baseDate + 'T00:00:00');
  const dayOfWeek = d.getDay();
  const saturday = new Date(d);
  saturday.setDate(d.getDate() + (6 - dayOfWeek + 7) % 7);
  for (let i = 0; i < 7; i++) {
    const date = new Date(saturday);
    date.setDate(saturday.getDate() - i);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

const stats = computed(() => {
  const result = {
    totalProfit: 0, totalLoss: 0, balance: 0,
    emptyCount: 0, chushouCount: 0,
    chushouRight: 0, chushouWrong: 0,
    totalRecords: 0, boughtCount: 0, soldCount: 0, holdCount: 0,
  };
  const stocksData = getStocksData();
  const dates = getWeekDates();
  dates.forEach(d => {
    const list = stocksData[d] || [];
    result.totalRecords += list.length;
    list.forEach(s => {
      if (s.bought) result.boughtCount++;
      if (s.sold) result.soldCount++;
      if (s.hold) result.holdCount++;
      if (s.soldRecords) {
        s.soldRecords.forEach(r => {
          const p = parseFloat(r.profit) || 0;
          if (p >= 0) result.totalProfit += p;
          else result.totalLoss += Math.abs(p);
        });
      }
    });
  });
  result.balance = result.totalProfit - result.totalLoss;
  return result;
});

const topStocks = computed(() => {
  const stocksData = getStocksData();
  const dates = getWeekDates();
  const stockNameCount = {};
  dates.forEach(d => {
    const list = stocksData[d] || [];
    list.forEach(s => {
      if (s.name) stockNameCount[s.name] = (stockNameCount[s.name] || 0) + 1;
    });
  });
  return Object.entries(stockNameCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
});
</script>
