<!--
  StarStatsBoard.vue — 星标签统计看板（题材星标签统计）
  分类: 星无/星现/星平/星增/星减（对照原版 auction-pages.js renderStarStatsBoard）
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
          <div class="star-stats-summary-value">{{ stockCountText }}</div>
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
    <div v-else class="star-stats-empty">暂无星变化数据</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { getTodayGroupList, getGroupData, getTodayJiwang } from '../logic/app-core.js';
import { getTopicGroups } from '../logic/topic-rules.js';
import { getPreviousTradingDay } from '../logic/trading-day-helpers.js';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { computeAuctionViewData } from '../logic/auction-view-helpers.js';

const uiStore = useUiStore();
const auctionStore = useAuctionStore();

const topicCount = ref(0);
const stockCountText = ref('-');
const maxStockTopic = ref('');
const categories = ref([]);
const strengthText = ref('-');
const centerLabel = ref('强度');
const centerColor = ref('#6b7280');

const size = 220;
const cx = size / 2;
const cy = size / 2;
const radius = (size - 34) / 2;
const strokeWidth = 34;

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
  xianian: { color: '#94a3b8', label: '星无' },
  xingxian: { color: '#f43f5e', label: '星现' },
  xingping: { color: '#3b82f6', label: '星平' },
  xingzeng: { color: '#f59e0b', label: '星增' },
  xingjian: { color: '#10b981', label: '星减' },
};

function render() {
  const currentDate = uiStore.currentDate;
  const dataSource = 'auction';
  void auctionStore.dataVersions.auction;

  const todayAuction = getTodayGroupList(dataSource);
  if (!todayAuction || todayAuction.length === 0) {
    categories.value = [];
    topicCount.value = 0;
    stockCountText.value = '-';
    maxStockTopic.value = '';
    return;
  }

  const todayGroups = getTopicGroups(todayAuction);
  const prevDate = getPreviousTradingDay(currentDate);
  const auctionData = getGroupData(dataSource);
  const yesterdayAuction = prevDate ? (auctionData[prevDate] || []) : [];
  const yesterdayGroups = yesterdayAuction.length > 0 ? getTopicGroups(yesterdayAuction) : [];

  const cats = {
    xianian: 0, xingxian: 0, xingping: 0, xingzeng: 0, xingjian: 0
  };

  let maxStockCount = 0;
  let maxTopic = '';

  todayGroups.forEach(group => {
    if (!group.topic || group.topic === '---' || group.topic === '其它' || group.topic === '并购重组') return;
    const todayStar = group.starCount || 0;
    const yGroup = yesterdayGroups.find(g => g.topic === group.topic);
    const yesterdayStar = yGroup ? (yGroup.starCount || 0) : 0;

    if (todayStar === 0) cats.xianian++;
    else if (yesterdayStar === 0) cats.xingxian++;
    else if (todayStar === yesterdayStar) cats.xingping++;
    else if (todayStar > yesterdayStar) cats.xingzeng++;
    else if (todayStar < yesterdayStar) cats.xingjian++;

    const sc = group.stocks ? group.stocks.length : 0;
    if (sc > maxStockCount) { maxStockCount = sc; maxTopic = group.topic; }
  });

  const validTopicCount = todayGroups.filter(g => g.topic && g.topic !== '---' && g.topic !== '其它' && g.topic !== '并购重组').length;
  topicCount.value = validTopicCount;

  const todayStockCount = todayAuction.length;
  const yesterdayStockCount = yesterdayAuction.length;
  let arrow = '-';
  if (todayStockCount > yesterdayStockCount) arrow = '↑';
  else if (todayStockCount < yesterdayStockCount) arrow = '↓';
  stockCountText.value = `${todayStockCount}${arrow}`;
  maxStockTopic.value = maxTopic ? `${maxTopic}（${maxStockCount}）` : '';

  const total = cats.xianian + cats.xingxian + cats.xingping + cats.xingzeng + cats.xingjian;
  if (total === 0) {
    categories.value = [];
    return;
  }

  const order = ['xianian', 'xingxian', 'xingping', 'xingzeng', 'xingjian'];
  categories.value = order
    .filter(k => cats[k] > 0)
    .map(k => ({
      key: k,
      color: colorMap[k].color,
      label: colorMap[k].label,
      count: cats[k],
      percent: Math.round((cats[k] / total) * 100),
      barWidth: Math.round((cats[k] / total) * 100),
    }));

  const riseCount = cats.xingzeng + cats.xingxian;

  let todayStrength = null, yesterdayStrength = null;
  try {
    const todayView = computeAuctionViewData(dataSource, {});
    todayStrength = todayView.stats && todayView.stats.todayStrength != null ? todayView.stats.todayStrength : null;
    yesterdayStrength = todayView.stats && todayView.stats.yesterdayStrength != null ? todayView.stats.yesterdayStrength : null;
  } catch (e) {}

  let strengthArrow = '';
  if (todayStrength != null && yesterdayStrength != null) {
    if (todayStrength > yesterdayStrength) strengthArrow = '⬆';
    else if (todayStrength < yesterdayStrength) strengthArrow = '⬇';
  }

  let isKongcang = false;
  try {
    const todayJiwang = getTodayJiwang();
    isKongcang = todayJiwang && todayJiwang.jielun === '空仓';
  } catch (e) {}

  let displayArrow = '';
  if (isKongcang) {
    centerColor.value = '#10b981';
    displayArrow = strengthArrow === '⬇' ? '↓' : (strengthArrow === '⬆' ? '↑' : '');
    centerLabel.value = '空仓';
  } else if (strengthArrow === '⬇') {
    centerColor.value = '#10b981';
    displayArrow = '↓';
    centerLabel.value = '空仓';
  } else if (strengthArrow === '⬆') {
    centerColor.value = '#ef4444';
    displayArrow = '↑';
    centerLabel.value = '出手';
  } else {
    centerColor.value = '#1f2937';
    displayArrow = '';
    centerLabel.value = '强度';
  }
  strengthText.value = (todayStrength != null ? todayStrength + '%' : '-') + displayArrow;
}

watch(() => [uiStore.currentDate, auctionStore.dataVersions.auction], render, { immediate: false });
onMounted(render);

defineExpose({ render });
</script>
