<!--
  AuctionTopicStatsBar.vue — 题材分组统计条（纯展示组件，§3 / §29 Row-Cell 组件边界）

  放在【每个题材块的第一行上方】，排版与展开面板「趋势图上方小字」一致，但背景色统一，
  用于视觉上把相邻题材分开。所有统计与格式化都在 Logic 层 topic-stats.js 算好，
  本组件只做 v-for 渲染（§21 模板不做重型计算）。

  数据缺失的段（如次新股没有 10 日区间涨幅）在 Logic 层就不会产出，这里不补 0 / '-'（§10）。
-->
<template>
  <div
    v-if="segments.length"
    class="auction-topic-stats"
  >
    <span
      v-for="s in segments"
      :key="s.key"
      class="ats-item"
      :class="s.key === 'topic' ? 'ats-topic' : null"
    >
      <template v-if="s.key === 'topic'">{{ s.value }}</template>
      <template v-else>
        <b>{{ s.label }}</b><i :class="s.tone ? 'ats-' + s.tone : null">{{ s.value }}</i>
      </template>
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatTopicStatsSegments } from '../logic/auction/topic-stats.js';

const props = defineProps({
  stats: { type: Object, default: null }
});

const segments = computed(() => formatTopicStatsSegments(props.stats));
</script>

<style scoped>
/* 与 .auction-daily-metrics 排版一致（font-size 11px / gap 4px 14px / 虚线分隔），
   额外给一层统一浅灰背景 + 左侧色条，让「题材块」与「题材块」一眼分开。 */
.auction-topic-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  width: 100%;
  flex-basis: 100%;
  padding: 3px 6px;
  margin: 2px 0 1px;
  background: #f1f5f9;
  border-left: 3px solid #64748b;
  border-radius: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: #475569;
}

.ats-item {
  white-space: nowrap;
}

.ats-item > b {
  color: #64748b;
  font-weight: 400;
  margin-right: 2px;
}

.ats-item > i {
  font-style: normal;
  font-weight: 600;
  color: #334155;
}

.ats-item.ats-topic {
  font-weight: 700;
  color: #0f172a;
  margin-right: 2px;
}

/* A 股口径：涨红跌绿 */
.ats-up {
  color: #dc2626;
}

.ats-down {
  color: #16a34a;
}
</style>
