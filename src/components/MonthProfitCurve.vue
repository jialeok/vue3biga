<template>
  <div class="month-profit-curve">
    <div
      ref="scrollEl"
      class="profit-chart-scroll"
    >
      <TrendChart
        :points="profitPoints"
        color="#dc2626"
        :point-spacing="pointSpacing"
        :height="chartHeight"
        :dot-radius="dotRadius"
      />
    </div>
  </div>
</template>

<script setup>
// [FEAT 2026-08-17] 本月统计「每日盈亏曲线」独立组件。
// 从 MonthlyStatsBoard 内联 TrendChart 抽出，便于后期单独扩展（如盈亏标注、阈值线等）。
// 数据源与 MonthlyStatsBoard 同源：buildProfitPoints（逻辑层 stats-calc），
// 本组件仅持有自己的 computed，不与其他曲线共用状态（§15 职责隔离、§18 响应式边界）。
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { getMonthDates } from '../logic/stats/monthly-logic.js';
import { buildProfitPoints } from '../logic/stats/stats-calc.js';
import TrendChart from './TrendChart.vue';

const uiStore = useUiStore();

// [FEAT 2026-08-17] 月统计曲线放大 + 横向滑动：
// - POINT_SPACING 大 → 每点更宽，可见窗口约一周（~5 交易日），其余向左滑看历史；
// - chartHeight/dotRadius 大 → 曲线更高、点更醒目，解决「太小看不清」；
// - 默认滚到最右显示最近日期（scrollToLatest）。
const POINT_SPACING = 60;
const chartHeight = 120;
const dotRadius = 4;

const profitPoints = computed(() => {
  try {
    return buildProfitPoints(() => getMonthDates(uiStore.currentDate || '')).profitPoints;
  } catch (e) {
    console.error('[MonthProfitCurve] buildProfitPoints 失败:', e);
    return [];
  }
});

const pointSpacing = computed(() => (profitPoints.value.length > 0 ? POINT_SPACING : 0));

// [FEAT 2026-08-17] 默认定位到最右（最近日期）：面板经 v-show 切换可见时才需要重新定位，
// 故用 IntersectionObserver 在其变为可见时触发；切换月份时也重新定位（仍可见时）。
const scrollEl = ref(null);
function scrollToLatest() {
  const el = scrollEl.value;
  if (!el) return;
  // 等布局完成（SVG 真实宽度已渲染）再定位，用 rAF 保证 scrollWidth 准确。
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

// 月份变化（首日期 YYYY-MM 变化）时重新滚到最新；同月内切日不跳回，避免打断历史浏览。
const monthKey = computed(() => {
  const p = profitPoints.value;
  return p.length ? p[0].date.slice(0, 7) : '';
});
watch(monthKey, () => nextTick(scrollToLatest));
</script>
