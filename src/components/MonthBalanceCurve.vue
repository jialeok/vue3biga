<template>
  <div class="month-balance-curve">
    <div
      ref="scrollEl"
      class="profit-chart-scroll"
    >
      <TrendChart
        :points="balancePoints"
        color="#2563eb"
        :point-spacing="pointSpacing"
        :height="chartHeight"
        :dot-radius="dotRadius"
      />
    </div>
  </div>
</template>

<script setup>
// [FEAT 2026-08-17] 本月统计「账户余额曲线」独立组件。
// 与 MonthProfitCurve 平行拆分：两条曲线各自独立数据源与组件，后期可分别加功能/显示，
// 互不干扰（用户明确要求拆分，避免后期改动互相影响）。
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { getMonthDates } from '../logic/stats/monthly-logic.js';
import { buildProfitPoints } from '../logic/stats/stats-calc.js';
import TrendChart from './TrendChart.vue';

const uiStore = useUiStore();

// [FEAT 2026-08-17] 与 MonthProfitCurve 同套放大 + 横向滑动参数，保持一致体验。
const POINT_SPACING = 60;
const chartHeight = 120;
const dotRadius = 4;

const balancePoints = computed(() => {
  try {
    return buildProfitPoints(() => getMonthDates(uiStore.currentDate || '')).balancePoints;
  } catch (e) {
    console.error('[MonthBalanceCurve] buildProfitPoints 失败:', e);
    return [];
  }
});

const pointSpacing = computed(() => (balancePoints.value.length > 0 ? POINT_SPACING : 0));

const scrollEl = ref(null);
function scrollToLatest() {
  const el = scrollEl.value;
  if (!el) return;
  requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
}

let io = null;
onMounted(() => {
  const el = scrollEl.value;
  if (!el || typeof IntersectionObserver === 'undefined') {
    nextTick(scrollToLatest);
    return;
  }
  io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) scrollToLatest(); });
  });
  io.observe(el);
});
onBeforeUnmount(() => { if (io) io.disconnect(); });

const monthKey = computed(() => {
  const p = balancePoints.value;
  return p.length ? p[0].date.slice(0, 7) : '';
});
watch(monthKey, () => nextTick(scrollToLatest));
</script>
