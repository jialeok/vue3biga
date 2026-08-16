<!--
  BiddingBoard.vue — 竞价变化看板（根组件）
  物理重组自原 653 行单文件：组合式逻辑迁至 composables/useBiddingBoard.js，
  模板区块拆分为 components/BiddingBoard{Header,List,EditModal,ClearConfirm}.vue。
  逻辑/样式表现保持与迁移前完全一致。defineExpose 契约（render/openEdit/closeModal/
  save/clearData/fetchSnapshot/runDiagnostics）对外保留不变。
-->
<template>
  <div
    class="bidding-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <BiddingBoardHeader />
    <div
      class="bidding-content"
      @dblclick="openEdit"
    >
      <BiddingBoardList />
    </div>
    <BiddingBoardEditModal />
    <BiddingBoardClearConfirm />
  </div>
</template>

<script setup>
import { provide } from 'vue';
import BiddingBoardHeader from '../components/BiddingBoardHeader.vue';
import BiddingBoardList from '../components/BiddingBoardList.vue';
import BiddingBoardEditModal from '../components/BiddingBoardEditModal.vue';
import BiddingBoardClearConfirm from '../components/BiddingBoardClearConfirm.vue';
import { useBiddingBoard, BIDDING_BOARD_KEY } from '../composables/useBiddingBoard.js';

const board = useBiddingBoard();
provide(BIDDING_BOARD_KEY, board);

// 根模板直接引用
const { expanded, openEdit } = board;

// 对外契约（受保护）：保留原 defineExpose 暴露的全部方法签名
defineExpose({
  render: board.render,
  openEdit: board.openEdit,
  closeModal: board.closeModal,
  save: board.save,
  clearData: board.clearData,
  fetchSnapshot: board.fetchSnapshot,
  runDiagnostics: board.runDiagnostics
});
</script>
