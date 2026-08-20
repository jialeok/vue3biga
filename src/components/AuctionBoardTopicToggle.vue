<!--
  AuctionBoardTopicToggle.vue — 题材排序 toggle（独立组件，§15）
  联动辅助 toggle：配合竞昨/竞昨占比/三天竞跌等主排序 toggle 使用，
  开启后在主排序基础上按题材数量做稳定叠加排序。
  放在「三天竞跌」toggle 之后，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div class="auction-toggle-item">
    <span class="auction-toggle-label">题材</span>
    <label class="auction-toggle-switch">
      <input
        type="checkbox"
        :checked="sortState.byTopic"
        @change="toggleSort('byTopic')"
      >
      <span class="auction-toggle-slider" />
    </label>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const board = inject('auctionBoard');
const { sortState, toggleSort } = board;
</script>