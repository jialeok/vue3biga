<!--
  DecisionSellBlock.vue — 「决策」看板【卖点】的一个题材分组（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版）：
    第一行：题材名称  ●n（实心红圆点 = 今日题材排名）  数量：n  竞价一字：n  ← 与买点同一行口径
    第二行：卖出理由：题材排…第n名，股票数量n只，该题材…一字涨停，…14:50 / 11:20 卖
    第三行起：序号  股票名称（龙几）  十日涨幅  11:20卖 / 14:50卖
            ⚠️ 题材排第 2 且只有 1 个竞价一字时，同一组里会出现两种时点（龙一 14:50、其余 11:20），
               因此时点是【逐行】渲染的，不是整组一个值。

  §21：本组件零业务计算 —— 分组 / 排名 / 数量 / 一字数 / 时点 / 理由全部由
  logic/decision/decision-rules.js 算好。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字（今日数据；今日未成组时显示为「—」） -->
    <DecisionTopicHead
      :topic="group.topic"
      :rank="group.topicRank"
      :count="group.count"
      :yizi="group.yiziCount"
    />
    <div class="dcb-reason-line">
      卖出理由：{{ group.reason }}
    </div>
    <div
      v-for="it in group.items"
      :key="it.name"
      class="dcb-row"
    >
      <span class="dcb-seq">{{ it.seq }}</span>
      <span class="dcb-name">{{ it.name }}</span>
      <span
        v-if="it.dragonLabel"
        class="dcb-dragon"
      >{{ it.dragonLabel }}</span>
      <span class="dcb-pct">{{ pctText(it.pct) }}</span>
      <span class="dcb-sell-at">{{ it.sellAt }}卖</span>
    </div>
  </div>
</template>

<script setup>
import DecisionTopicHead from './DecisionTopicHead.vue';
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  group: {
    type: Object,
    required: true
  }
});

function pctText(pct) {
  return formatRangePct(pct);
}
</script>
