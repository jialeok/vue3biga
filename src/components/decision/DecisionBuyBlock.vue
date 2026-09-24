<!--
  DecisionBuyBlock.vue — 「决策」看板【买点】的一个题材块（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24）：
    第一行：题材名称   选择理由：题材排第一，股票数量n只，m个竞价一字
    第二行起：序号  股票名称（龙几）  十日涨幅  建议重仓 / 轻仓

  §21：本组件零业务计算 —— 题材名 / 理由 / 序号 / 龙几 / 涨幅 / 仓位 全部由
  logic/decision/decision-rules.js 预先算好，模板只做 v-for 渲染。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 选择理由 -->
    <div class="dcb-block-head">
      <span class="dcb-topic">{{ block.block.topic }}</span>
      <span class="dcb-reason">选择理由：{{ block.reason }}</span>
    </div>
    <!-- 未达条件：如实说明（§10 不拿不够格的数据冒充有效信号） -->
    <div
      v-if="!block.qualified"
      class="dcb-block-note"
    >
      {{ block.notQualifiedText }}
    </div>
    <!-- 第二行起：选中的股票 -->
    <div
      v-for="p in block.picks"
      :key="p.name"
      class="dcb-row"
    >
      <span class="dcb-seq">{{ p.seq }}</span>
      <span class="dcb-name">{{ p.name }}</span>
      <span
        v-if="p.dragonLabel"
        class="dcb-dragon"
      >{{ p.dragonLabel }}</span>
      <span class="dcb-pct">{{ pctText(p.pct) }}</span>
      <span class="dcb-position">建议{{ p.position }}</span>
    </div>
    <div
      v-if="block.qualified && block.picks.length === 0"
      class="dcb-block-note"
    >
      该题材没有可买的非一字股票
    </div>
  </div>
</template>

<script setup>
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  block: {
    type: Object,
    required: true
  }
});

// 涨幅格式化走 Logic 层（§21 模板不做格式化）；缺失 → 空串（§10 绝不补 0）
function pctText(pct) {
  return formatRangePct(pct);
}
</script>
