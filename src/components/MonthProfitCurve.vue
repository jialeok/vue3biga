<template>
  <div class="month-profit-curve">
    <div class="profit-chart-scroll">
      <TrendChart
        :points="profitPoints"
        color="#dc2626"
        :point-spacing="pointSpacing"
      />
    </div>
  </div>
</template>

<script setup>
// [FEAT 2026-08-17] 本月统计「每日盈亏曲线」独立组件。
// 从 MonthlyStatsBoard 内联 TrendChart 抽出，便于后期单独扩展（如盈亏标注、阈值线等）。
// 数据源与 MonthlyStatsBoard 同源：buildProfitPoints（逻辑层 stats-calc），
// 本组件仅持有自己的 computed，不与其他曲线共用状态（§15 职责隔离、§18 响应式边界）。
import { computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { getMonthDates } from '../logic/stats/monthly-logic.js';
import { buildProfitPoints } from '../logic/stats/stats-calc.js';
import TrendChart from './TrendChart.vue';

const uiStore = useUiStore();

// 每点水平间距（px）：天数为 0 时回退默认；其余固定 44px，使曲线宽度为 天数*44，
// 外层 overflow-x:auto 可横向滑动查看完整一个月（与周统计 7 天用的固定宽区分）。
const POINT_SPACING = 44;

const profitPoints = computed(() => {
  try {
    return buildProfitPoints(() => getMonthDates(uiStore.currentDate || '')).profitPoints;
  } catch (e) {
    console.error('[MonthProfitCurve] buildProfitPoints 失败:', e);
    return [];
  }
});

const pointSpacing = computed(() => (profitPoints.value.length > 0 ? POINT_SPACING : 0));
</script>
