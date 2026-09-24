<!--
  LadderRow.vue — 「连板天梯晋级」看板的一行（独立组件，⛔ 不复用任何其它看板的行组件）

  排版（用户口径 2026-09-24）：
      序号  股票名称 [高开/低开/平开]  十日涨幅  题材（主角列，完整展示可折行）  晋级成功/失败/待定
  点击【序号】或【股票名称】→ 展开/收起该股近 5 日趋势图（与早盘竞价同一份数据，只读内存）。

  布局对齐「早盘竞价单独打开题材 toggle」：题材是主角列，吃满剩余宽度、不省略号截断。

  §21：本组件零业务计算 —— 序号 / 开平 / 涨幅 / 题材 / 晋级 全部由 logic/ladder 预先算好。
  唯一复用的 TrendChart 是全站通用图表基元（src/components/TrendChart.vue，不属于任何看板），
  不看板组件：AuctionEntityRow / LimitBoard 那些行组件一个都没用。
-->
<template>
  <div class="lad-row-wrap">
    <div class="lad-row">
      <span
        class="lad-seq"
        @click.stop="$emit('toggle', row.name)"
      >{{ row.seq }}</span>
      <span
        class="lad-name-box"
        @click.stop="$emit('toggle', row.name)"
      >
        <span class="lad-name">{{ row.name }}</span>
        <span
          v-if="row.aucOpenText"
          class="lad-open-tag"
          :class="'open-' + row.aucOpen"
          :title="openTitle"
        >{{ row.aucOpenText }}</span>
        <span
          v-if="row.isYiZi"
          class="lad-yizi-tag"
          title="竞价一字：9:25 竞价涨幅已打在涨停价"
        >一字</span>
      </span>
      <span class="lad-pct">{{ pctText }}</span>
      <span class="lad-topic">{{ row.topic || '—' }}</span>
      <span
        class="lad-promote"
        :class="'promote-' + row.promote"
      >{{ row.promoteText }}</span>
    </div>

    <div
      v-if="expanded && trend"
      class="lad-trend-panel"
    >
      <div
        v-if="hasSeriesData(trend.volume)"
        class="lad-chart-item"
      >
        <div class="lad-chart-label">
          竞价量(万) 近5日
        </div>
        <TrendChart
          :points="trend.volume"
          color="#6366f1"
        />
      </div>
      <div
        v-if="hasSeriesData(trend.yestVolume)"
        class="lad-chart-item"
      >
        <div class="lad-chart-label">
          昨日成交量(万) 近5日
        </div>
        <TrendChart
          :points="trend.yestVolume"
          color="#10b981"
        />
      </div>
      <div
        v-if="hasSeriesData(trend.aucPctChg)"
        class="lad-chart-item"
      >
        <div class="lad-chart-label">
          竞价涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trend.aucPctChg"
          color="#f59e0b"
          :percent="true"
        />
      </div>
      <div
        v-if="hasSeriesData(trend.changePct)"
        class="lad-chart-item"
      >
        <div class="lad-chart-label">
          涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trend.changePct"
          color="#64748b"
          :percent="true"
        />
      </div>
      <div
        v-if="!hasAnyTrend"
        class="lad-trend-empty"
      >
        该股近 5 日无历史数据（趋势图不显示，绝不画一条空线充数）
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import TrendChart from '../TrendChart.vue';
import { formatRangePct, hasSeriesData } from '../../logic/ladder/ladder-rules.js';

const props = defineProps({
  row: { type: Object, required: true },
  expanded: { type: Boolean, default: false },
  trend: { type: Object, default: null }
});

defineEmits(['toggle']);

const pctText = computed(() => formatRangePct(props.row.pct));

const openTitle = computed(function() {
  const v = props.row.aucPct;
  if (v === null || v === undefined) return '当日竞价涨幅缺失';
  return '当日竞价涨幅 ' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
});

// §10：四条腿全空 → 出一句说明，而不是渲染四张空图
const hasAnyTrend = computed(function() {
  const t = props.trend;
  if (!t) return false;
  return hasSeriesData(t.volume) || hasSeriesData(t.yestVolume) ||
         hasSeriesData(t.aucPctChg) || hasSeriesData(t.changePct);
});
</script>
