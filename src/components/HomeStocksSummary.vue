<template>
  <!-- 紧凑型统计卡片 -->
  <div class="compact-stats-bar trading-day-element">
    <div
      class="compact-stat-card"
      :class="{ 'active-filter-all': currentFilter === 'all' }"
      @click="setFilter('all')"
    >
      <div class="compact-stat-label">
        今日记录
      </div>
      <div class="compact-stat-value">
        {{ stockStats.todayCount }}
      </div>
    </div>
    <div
      class="compact-stat-card"
      :class="{ 'active-filter-bought': currentFilter === '已买' }"
      @click="setFilter('已买')"
    >
      <div
        class="compact-stat-label"
        style="color:#d97706"
      >
        已买
      </div>
      <div
        class="compact-stat-value"
        style="color:#d97706"
      >
        {{ stockStats.boughtCount }}
      </div>
    </div>
    <div
      class="compact-stat-card"
      :class="{ 'active-filter-sold': currentFilter === '已卖' }"
      @click="setFilter('已卖')"
    >
      <div
        class="compact-stat-label"
        style="color:#dc2626"
      >
        已卖
      </div>
      <div
        class="compact-stat-value"
        style="color:#dc2626"
      >
        {{ stockStats.soldCount }}
      </div>
    </div>
    <div
      class="compact-stat-card"
      :class="{ 'active-filter-hold': currentFilter === '持有' }"
      @click="setFilter('持有')"
    >
      <div
        class="compact-stat-label"
        style="color:#2563eb"
      >
        持有
      </div>
      <div
        class="compact-stat-value"
        style="color:#2563eb"
      >
        {{ stockStats.holdCount }}
      </div>
    </div>
  </div>

  <!-- 股票列表折叠开关 -->
  <div class="stock-list-toggle-bar trading-day-element">
    <button
      class="stock-list-toggle-btn"
      @click="toggleCollapse"
    >
      <span>{{ toggleIcon }}</span>
      <span>{{ toggleText }}</span>
      <span class="stock-list-count">({{ sortedList.length }})</span>
    </button>
  </div>
</template>

<script setup>
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const {
  stockStats,
  currentFilter,
  setFilter,
  toggleCollapse,
  toggleText,
  toggleIcon,
  sortedList
} = useHomeStocksState();
</script>
