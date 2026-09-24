<!--
  LadderGroup.vue — 「连板天梯晋级」看板的一个【连板档位】分组（独立组件）

  档位条（分类条，上方标数量）：
      三板  8
  下面是该档位的股票行（LadderRow）。

  §21：本组件零业务计算 —— 档位名 / 数量 / 行数据全部由 logic/ladder/ladder-rules.js 算好。
-->
<template>
  <div class="lad-group">
    <div class="lad-group-bar">
      <span class="lad-group-label">{{ group.label }}</span>
      <span class="lad-group-count">{{ group.count }}</span>
    </div>
    <LadderRow
      v-for="r in group.rows"
      :key="r.name"
      :row="r"
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
