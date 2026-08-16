<!-- BiddingBoardHeader.vue — 竞价变化看板头部（标题 + 折叠按钮） -->
<template>
  <div
    class="bidding-header"
    @click="toggleExpand"
  >
    <div class="bidding-title">
      竞价变化
    </div>
    <div class="bidding-toggle-btn">
      {{ expanded ? '▲' : '▼' }}
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import { BIDDING_BOARD_KEY } from '../composables/useBiddingBoard.js';

const board = inject(BIDDING_BOARD_KEY);
const { expanded, toggleExpand } = board;
</script>

<style scoped>
.bidding-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}
.bidding-title { font-size: 14px; font-weight: 600; color: #ffffff; }
.bidding-toggle-btn { font-size: 12px; color: #ffffff; }
</style>
