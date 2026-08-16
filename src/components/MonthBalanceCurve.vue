<template>
  <div class="month-balance-curve">
    <div class="profit-chart-scroll">
      <TrendChart
        :points="balancePoints"
        color="#2563eb"
        :point-spacing="pointSpacing"
      />
    </div>
  </div>
</template>

<script setup>
// [FEAT 2026-08-17] 本月统计「账户余额曲线」独立组件。
// 与 MonthProfitCurve 平行拆分：两条曲线各自独立数据源与组件，后期可分别加功能/显示，
// 互不干扰（用户明确要求拆分，避免后期改动互相影响）。
import { computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { getMonthDates } from '../logic/stats/monthly-logic.js';
import { buildProfitPoints } from '../logic/stats/stats-calc.js';
import TrendChart from './TrendChart.vue';

const uiStore = useUiStore();

const POINT_SPACING = 44;

const balancePoints = computed(() => {
  try {
    return buildProfitPoints(() => getMonthDates(uiStore.currentDate || '')).balancePoints;
  } catch (e) {
    console.error('[MonthBalanceCurve] buildProfitPoints 失败:', e);
    return [];
  }
});

const pointSpacing = computed(() => (balancePoints.value.length > 0 ? POINT_SPACING : 0));
</script>
