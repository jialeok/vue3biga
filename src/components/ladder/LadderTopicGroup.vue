<!--
  LadderTopicGroup.vue — 「连板天梯晋级」看板【题材连扳】模式下的一个【题材梯队】分组（独立组件）

  与 LadderGroup（按连板档位切）是【同一批 rows 的两种切法】，不是两份数据：
      连板档位模式：三板 8 / 二板 12 …
      题材连扳模式：AI应用  3档  连3档  梯队完整  6只
                      四板 新华文轩
                      三板 新华传媒
                      二板 天威视讯

  完整性（用户口径 2026-09-24 修正版）：必须【连续】的板数连在一起，且最长连续段 ≥ 3 档。
      · 二/三/四  ⇒ 连 3 档 ⇒ 梯队完整
      · 三/四      ⇒ 连 2 档 ⇒ ⛔ 不完整（只有两个连在一起也不行）
      · 二/四/五/六 ⇒ 最长连续 4-5-6 = 3 档 ⇒ 梯队完整
    判据唯一实现在 logic/ladder/ladder-rules.js#longestConsecutiveRun。

  §21：本组件零业务计算 —— 题材名 / 档数 / 连续档数 / 是否完整 / 行数据全部由 Logic 算好。
-->
<template>
  <div class="lad-group">
    <div class="lad-topic-bar">
      <span class="lad-topic-label">{{ group.topic }}</span>
      <span
        class="lad-topic-levels"
        :title="group.hintText"
      >{{ group.levelText }}</span>
      <span
        class="lad-topic-run"
        :class="{ complete: group.isComplete }"
        :title="group.hintText"
      >{{ group.runText }}</span>
      <span
        class="lad-topic-flag"
        :class="{ complete: group.isComplete }"
      >{{ group.completeText }}</span>
      <span class="lad-group-count">{{ group.count }}只</span>
    </div>
    <LadderRow
      v-for="r in group.rows"
      :key="r.name"
      :row="r"
      col-field="streak"
      :expanded="expandedSet.has(r.name)"
      :trend="trendHistory[r.name] || null"
      @toggle="$emit('toggle', r.name)"
    />
  </div>
</template>

<script setup>
import LadderRow from './LadderRow.vue';

defineProps({
  group: { type: Object, required: true },
  expandedSet: { type: Object, required: true },   // Set<股票名>
  trendHistory: { type: Object, required: true }   // { 股票名: series }
});

defineEmits(['toggle']);
</script>
