<!-- BiddingBoardList.vue — 竞价变化看板表格（表头 + 可见行），行内联渲染 -->
<template>
  <div class="bidding-table">
    <div class="bidding-row bidding-row-header">
      <span class="col-name">名称</span>
      <span class="col-time915">9:15</span>
      <span class="col-time920">9:20</span>
      <span class="col-time925">9:25</span>
      <span class="col-change">增减</span>
      <span class="col-close">收盘</span>
    </div>
    <div
      v-for="(row, idx) in visibleBiddingRows"
      :key="idx"
      class="bidding-row"
      :class="row.rowClass"
    >
      <span class="col-name">{{ row.name }}</span>
      <span class="col-time915">{{ row.time915 || '-' }}</span>
      <span class="col-time920">{{ row.time920 || '-' }}</span>
      <span
        class="col-time925"
        :class="duibanTime925Class(row)"
      >{{ row.time925 || '-' }}</span>
      <span
        class="col-change"
        :class="changeTagClass(row.change)"
      >{{ row.change || '-' }}</span>
      <span
        class="col-close"
        :class="changeClass(row.close)"
      >{{ formatClose(row.close, row.name) }}</span>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import { BIDDING_BOARD_KEY } from '../composables/useBiddingBoard.js';

const board = inject(BIDDING_BOARD_KEY);
const { visibleBiddingRows, duibanTime925Class, changeTagClass, changeClass, formatClose } = board;
</script>

<style scoped>
.bidding-row {
  display: grid;
  /* 用 fr 替代 %：fr 会像旧版 table-layout:fixed 那样把 32/17/17/17/17/17 归一化到 100% 容器内，
     避免 117% 溢出被 .bidding-content{overflow:hidden} 裁掉最右侧「收盘」列（之前右边被容器遮住的根因） */
  grid-template-columns: 32fr 17fr 17fr 17fr 17fr 17fr;
  gap: 2px;
  padding: 6px 8px;
  font-size: 11px;
  border-bottom: 1px solid #f9fafb;
  align-items: center;
}
.bidding-row-header {
  font-weight: 600;
  color: #6b7280;
  background: #f9fafb;
  font-size: 10px;
}
.bidding-row .col-name {
  text-align: left;
  font-weight: 500;
  color: #1f2937;
  white-space: normal;
  word-wrap: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bidding-row .up { color: #dc2626; }
.bidding-row .down { color: #059669; }
/* 增减列样式（迁移自老版 boards-bidding.js:614-621）：增=红加粗、减=绿、平=深灰加粗；
   同时服务于前台展示列(.col-change)与后台只读输入框(.bidding-row-change) */
.tag-up { color: #ef4444; font-weight: bold; font-size: 11px; }
.tag-down { color: #059669; font-size: 12px; }
.tag-flat { color: #1f2937; font-weight: 600; }
</style>
