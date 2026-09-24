<!--
  DecisionBuyBlock.vue — 「决策」看板【买点】的一个题材块（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版）：
    第一行：题材名称  ●1（实心红圆点 = 题材排名）  数量：n  竞价一字：n   ← 一行挤完，省空间
    第二行：选择理由：题材排第一，股票数量n只，m个竞价一字
    第三行起：序号  股票名称（龙几）  十日涨幅  建议重仓 / 建议轻仓
            重仓与轻仓【混排在同一块里】，序号连续，仓位写在行尾（不再拆两块重复题材名）。

  §21：本组件零业务计算 —— 排名 / 数量 / 一字数 / 理由 / 序号 / 龙几 / 涨幅 / 仓位
  全部由 logic/decision/decision-rules.js 预先算好，模板只做 v-for 渲染。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字 -->
    <DecisionTopicHead
      :topic="block.block.topic"
      :rank="block.block.rank"
      :count="block.block.count"
      :yizi="block.block.yiziCount"
    />
    <!-- 第二行：选择理由 -->
    <div class="dcb-reason-line">
      选择理由：{{ block.reason }}
    </div>
    <!-- 第三行起：选中的股票（重仓 / 轻仓混排，序号连续） -->
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
      <span
        class="dcb-position"
        :class="{ light: isLight(p.position) }"
      >建议{{ p.position }}</span>
    </div>
    <!-- 辅助说明：本档无轻仓票 / 有股票因缺竞价涨幅未纳入（§10 缺失必须可见，不能静默丢掉） -->
    <div
      v-for="(n, i) in block.notes"
      :key="'note-' + i"
      class="dcb-block-note"
    >
      {{ n }}
    </div>
    <!-- 未达门槛：如实说明（§10 不拿不够格的数据冒充有效信号） -->
    <div
      v-if="!block.qualified"
      class="dcb-block-note unqualified"
    >
      {{ block.notQualifiedText }}
    </div>
    <div
      v-else-if="block.picks.length === 0"
      class="dcb-block-note"
    >
      该题材没有可买的非一字股票
    </div>
  </div>
</template>

<script setup>
import DecisionTopicHead from './DecisionTopicHead.vue';
import { formatRangePct, POSITION_LIGHT } from '../../logic/decision/decision-rules.js';

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
// 仓位判定走 Logic 层的常量，组件里不另复制一份文案做比较（§6）
function isLight(position) {
  return position === POSITION_LIGHT;
}
</script>
