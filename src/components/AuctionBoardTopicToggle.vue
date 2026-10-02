<!--
  AuctionBoardTopicToggle.vue — 「题材」排序 toggle（独立组件，§15）

  [TWO-MODES 2026-10-02 用户口径] 本 toggle 与「一字」toggle 是【互斥】的两个题材排序口径：
    · 题材（本组件）→ topicOrderBy = 'volRatio' → 题材按平均竞价量比降序；
    · 一字（AuctionBoardToolbar 里的那个）→ topicOrderBy = 'yizi' → 题材按竞价一字数量降序。
  二者【共用】sortState.byTopic 这一个开关位，靠 topicOrderBy 区分口径
  ⇒ 互斥是结构性的（不可能同时为 true），⛔ 这里不许再走 toggleSort('byTopic')，
     必须走 toggleTopicOrder('volRatio')，否则口径切换与互斥没人维护。

  勾选态一律读 board 的 computed（topicToggleOn / yiziToggleOn），
  ⛔ 模板里不许写 `sortState.byTopic && sortState.topicOrderBy === ...`（§21 模板零计算）。

  经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div class="auction-toggle-item">
    <span class="auction-toggle-label">题材</span>
    <label class="auction-toggle-switch">
      <input
        type="checkbox"
        :checked="topicToggleOn"
        @change="toggleTopicOrder('volRatio')"
      >
      <span class="auction-toggle-slider" />
    </label>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const board = inject('auctionBoard');
const { toggleTopicOrder, topicToggleOn } = board;
</script>
