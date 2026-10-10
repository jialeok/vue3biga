<!--
  TbbTopicHead.vue — 「分笔买卖」看板的题材行（独立组件，⛔ 不复用决策看板的 DecisionTopicHead）

  为什么另建一个而不是 import 决策看板那个（用户明确要求「新建一个独立组件给它和原来的决策看板
  相互独立」）：
    · 两个看板的题材行【显示内容不同】—— 本看板不放「候选题材」标记（用户口径「其它不要放」）；
    · 若共用同一个组件，日后任一边加标记都会悄悄影响另一边（决策看板必须保持一行不变）。

  排版（与决策看板的视觉语言一致，但类名 tbb- 前缀、互不影响）：
    第 1 行（.tbb-tags-row） ：[昨有买入]  [四次入选]
    第 2 行（.tbb-topic-row）：题材名称  ●1   数量：12   竞价一字：1
    └ 第 1 行一个标记都没有时【整行不渲染】（不留空行、不占高度）。
    └ 「竞价一字」后面的数字用红色 —— 一字 = 最强 / 买不到的那个信号（与决策看板同一套红）。

  §10：null/undefined 一律显示「—」，绝不退化成 0。
  §21：本组件零业务计算 —— 排名 / 数量 / 一字数全部由 Logic 层预计算好，这里只取值 + 占位。
-->
<template>
  <div class="tbb-block-head">
    <div
      v-if="hasTopicTags"
      class="tbb-tags-row"
    >
      <span
        v-if="prevBoughtTag"
        class="tbb-prev-bought"
        title="这个题材昨天有股票被打过「买」标签（题材在延续）"
      >{{ prevBoughtTag }}</span>
      <span
        v-if="streakTag"
        class="tbb-topic-streak"
        title="该题材在含今日的最近 5 个交易日里进入买点的次数"
      >{{ streakTag }}</span>
    </div>
    <div class="tbb-topic-row">
      <span class="tbb-topic">{{ topicText }}</span>
      <span
        v-if="rank"
        class="tbb-rank-dot"
        :title="'决策看板内排名第 ' + rank + '（与决策看板同源）'"
      >{{ rank }}</span>
      <span class="tbb-meta">数量：{{ text(count) }}</span>
      <span class="tbb-meta">竞价一字：<span class="tbb-meta-num">{{ text(yizi) }}</span></span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  topic: { type: String, default: '' },
  rank: { type: Number, default: null },
  count: { type: Number, default: null },
  yizi: { type: Number, default: null },
  // 用户点名的两个题材标记（买点侧专有；卖点侧不传 ⇒ 整行不渲染）
  prevBoughtTag: { type: String, default: '' },
  streakTag: { type: String, default: '' }
});

const topicText = computed(() => props.topic || '（今日未成组）');
const hasTopicTags = computed(() => !!(props.prevBoughtTag || props.streakTag));

/** §10：null/undefined 一律显示占位符「—」，绝不退化成 0 */
function text(v) {
  return (v === null || v === undefined) ? '—' : String(v);
}
</script>
