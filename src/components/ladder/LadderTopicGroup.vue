<!--
  LadderTopicGroup.vue — 「连板天梯晋级」看板【题材连扳】模式下的一个【题材梯队】分组（独立组件）

  与 LadderGroup（按连板档位切）是【同一批 rows 的两种切法】，不是两份数据：
      连板档位模式：三板 8 / 二板 12 …
      题材连扳模式：AI应用 3层 梯队完整 6只
                      四板 新华文轩
                      三板 新华传媒
                      二板 天威视讯

  完整性（用户口径 2026-09-24）：一个题材里出现几个【不同的连板层级】就是几层，
      二板 + 三板 = 2 层、二板 + 三板 + 四板 = 3 层，都算成梯队；只有二板 = 1 层 = 单层。

  §21：本组件零业务计算 —— 题材名 / 层数 / 是否成梯队 / 行数据全部由 logic/ladder/ladder-rules.js 算好。
-->
<template>
  <div class="lad-group">
    <div class="lad-topic-bar">
      <span class="lad-topic-label">{{ group.topic }}</span>
      <span
        class="lad-topic-levels"
        :class="{ complete: group.isComplete }"
        :title="levelTitle"
      >{{ group.levelText }}</span>
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
import { computed } from 'vue';
import LadderRow from './LadderRow.vue';

const props = defineProps({
  group: { type: Object, required: true },
  expandedSet: { type: Object, required: true },   // Set<股票名>
  trendHistory: { type: Object, required: true }   // { 股票名: series }
});

defineEmits(['toggle']);

const levelTitle = computed(function() {
  const g = props.group;
  if (!g.levelDetail) return '';
  return g.topic + ' 出现 ' + g.levelCount + ' 个连板层级（' + g.levelDetail + '）';
});
</script>
