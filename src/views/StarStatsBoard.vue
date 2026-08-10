<!--
  StarStatsBoard.vue — 星标签统计看板（题材星标签统计）
  结构对照原始 HTML index没拆分的整体UI设计.html 第6011-6015行
  数据: 从竞价数据中提取题材分组统计
-->
<template>
  <div class="star-stats-board trading-day-element">
    <div class="star-stats-title">
      <span class="star-stats-title-icon">★</span>
      <span>题材星标签统计</span>
    </div>
    <div v-if="hasData">
      <div class="star-stats-donut-wrap">
        <svg class="star-stats-donut-svg" :viewBox="`0 0 ${size} ${size}`">
          <circle v-for="(arc, i) in arcs" :key="i"
                  :cx="cx" :cy="cy" :r="radius"
                  fill="none"
                  :stroke="arc.color"
                  :stroke-width="strokeWidth"
                  :stroke-dasharray="arc.dashArray"
                  :stroke-dashoffset="arc.dashOffset"
                  :transform="`rotate(${-90 + arc.startAngle} ${cx} ${cy})`" />
          <text :x="cx" :y="cy - 4" text-anchor="middle" class="star-stats-donut-center-value" :style="{ fill: centerColor }">{{ strengthText }}</text>
          <text :x="cx" :y="cy + 16" text-anchor="middle" class="star-stats-donut-center-label" :style="{ fill: centerColor }">{{ centerLabel }}</text>
        </svg>
        <div class="star-stats-legend">
          <div v-for="c in categories" :key="c.key" class="star-stats-legend-item">
            <span class="star-stats-legend-dot" :style="{ background: c.color }"></span>
            <span>{{ c.label }}</span>
            <span class="star-stats-legend-value">{{ c.count }}（{{ c.percent }}%）</span>
          </div>
        </div>
      </div>
      <div class="star-stats-summary">
        <div class="star-stats-summary-item">
          <div class="star-stats-summary-label">题材数量</div>
          <div class="star-stats-summary-value">{{ topicCount }}</div>
        </div>
        <div class="star-stats-summary-item">
          <div class="star-stats-summary-label">个股数量</div>
          <div class="star-stats-summary-value">{{ stockCount }}</div>
        </div>
        <div class="star-stats-summary-item">
          <div class="star-stats-summary-label">个股总数最多题材</div>
          <div class="star-stats-summary-value topic-name">{{ maxStockTopic || '-' }}</div>
        </div>
      </div>
      <div class="star-stats-divider"></div>
      <div class="star-stats-bars">
        <div v-for="c in categories" :key="c.key" class="star-stats-bar-row">
          <div class="star-stats-bar-label">{{ c.label }}</div>
          <div class="star-stats-bar-track">
            <div class="star-stats-bar-fill" :style="{ width: c.barWidth + '%', background: c.color }"></div>
          </div>
          <div class="star-stats-bar-value">{{ c.count }}</div>
        </div>
      </div>
    </div>
    <div v-else class="star-stats-empty">暂无题材数据</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getTodayGroupList, getCurrentDate } from '../logic/app-core.js';
import { getTopicGroups } from '../logic/topic-rules.js';

const topicCount = ref(0);
const stockCount = ref(0);
const maxStockTopic = ref('');
const categories = ref([]);
const strengthText = ref('-');
const centerLabel = ref('强度');
const centerColor = ref('#6b7280');

const size = 120;
const cx = size / 2;
const cy = size / 2;
const radius = 45;
const strokeWidth = 18;

const hasData = computed(() => categories.value.length > 0);

const arcs = computed(() => {
  const total = categories.value.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return [];
  const circumference = 2 * Math.PI * radius;
  let startAngle = 0;
  return categories.value.map(c => {
    const fraction = c.count / total;
    const dashLength = fraction * circumference;
    const dashArray = `${dashLength} ${circumference - dashLength}`;
    const dashOffset = 0;
    const arc = { color: c.color, dashArray, dashOffset, startAngle };
    startAngle += fraction * 360;
    return arc;
  });
});

const colorMap = {
  rise: { color: '#ef4444', label: '涨停' },
  highRatio: { color: '#f97316', label: '高开' },
  flat: { color: '#3b82f6', label: '平开' },
  fall: { color: '#10b981', label: '下跌' },
  other: { color: '#6b7280', label: '其他' },
};

function render() {
  const auctionList = getTodayGroupList('auction');
  if (!auctionList || auctionList.length === 0) {
    categories.value = [];
    return;
  }
  const groups = getTopicGroups(auctionList);
  topicCount.value = groups.length;
  stockCount.value = auctionList.length;

  let maxCount = 0;
  groups.forEach(g => {
    if (g.stocks.length > maxCount) {
      maxCount = g.stocks.length;
      maxStockTopic.value = `${g.topic}（${maxCount}）`;
    }
  });

  const counts = { rise: 0, highRatio: 0, flat: 0, fall: 0, other: 0 };
  auctionList.forEach(item => {
    const pct = parseFloat(item.changePct || item.percent || 0);
    if (pct >= 9.5) counts.rise++;
    else if (pct > 0) counts.highRatio++;
    else if (pct === 0) counts.flat++;
    else if (pct < 0) counts.fall++;
    else counts.other++;
  });

  const total = auctionList.length;
  const order = ['rise', 'highRatio', 'flat', 'fall', 'other'];
  categories.value = order
    .filter(k => counts[k] > 0)
    .map(k => ({
      key: k,
      color: colorMap[k].color,
      label: colorMap[k].label,
      count: counts[k],
      percent: Math.round((counts[k] / total) * 100),
      barWidth: Math.round((counts[k] / total) * 100),
    }));

  const riseCount = counts.rise;
  strengthText.value = riseCount > 0 ? riseCount + '%' : '-';
  centerColor.value = riseCount > 0 ? '#ef4444' : '#6b7280';
}

onMounted(render);

defineExpose({ render });
</script>