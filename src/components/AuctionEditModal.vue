<template>
  <Teleport to="body">
    <div
      v-if="modal.visible"
      class="auction-edit-overlay"
      @click.self="modal.close"
    >
      <div class="auction-edit-modal">
        <!-- 头部（随内容一起滚动） -->
        <div class="modal-header">
          <div class="auction-edit-title">
            编辑最近多板早盘竞价
          </div>
          <button
            class="close-btn"
            @click="modal.close"
          >
            ×
          </button>
        </div>

        <!-- 各区块拆分到子组件，逻辑统一来自 useAuctionEditModal（provide/inject 共享） -->
        <AuctionEditPaste />
        <AuctionEditCodeMap />
        <AuctionEditHistory />
        <AuctionEditApis />
        <AuctionEditFormRows />
        <AuctionEditActions />
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { provide } from 'vue';
import { useAuctionEditModal } from '../composables/useAuctionEditModal.js';
import AuctionEditPaste from './AuctionEditPaste.vue';
import AuctionEditCodeMap from './AuctionEditCodeMap.vue';
import AuctionEditHistory from './AuctionEditHistory.vue';
import AuctionEditApis from './AuctionEditApis.vue';
import AuctionEditFormRows from './AuctionEditFormRows.vue';
import AuctionEditActions from './AuctionEditActions.vue';

// 本组件对外契约：仅 expose open / close（无 props / 无 emits），调用方经 ref 访问。
const modal = useAuctionEditModal();
provide('auctionEditModal', modal);
defineExpose({ open: modal.open, close: modal.close });
</script>

<style scoped>
/* ===== 模态框容器：原版 .modal + .modal-content + .modal-content-rank =====
   整个内容是一个滚动容器（底部抽屉形态），所有区块 + 底部按钮都在同一滚动流内 */
.auction-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9998;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.auction-edit-modal {
  background: #fff;
  width: 100%;
  max-width: 400px;
  border-radius: 24px 24px 0 0;
  max-height: 85vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 24px;
  box-sizing: border-box;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.1);
}

/* 头部（随内容一起滚动，与原版 modal-header 一致） */
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.auction-edit-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}
.close-btn {
  background: #f8fafc;
  border: none;
  color: #64748b;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
}
</style>
