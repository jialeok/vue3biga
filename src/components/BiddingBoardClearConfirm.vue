<!-- BiddingBoardClearConfirm.vue — 清除确认弹层（Teleport 到 body） -->
<template>
  <Teleport to="body">
    <div
      v-if="clearConfirmActive"
      class="clear-confirm-overlay"
      @click="clearConfirmActive = false"
    >
      <div
        class="clear-confirm-panel"
        @click.stop
      >
        <div class="clear-confirm-title">
          确定要清除所有数据吗？
        </div>
        <div class="clear-confirm-desc">
          将保留第一列（要盯项目）的内容，清除其他所有列的数据。
        </div>
        <div class="clear-confirm-actions">
          <button
            class="btn-confirm-clear"
            :disabled="clearing"
            @click="confirmClearData"
          >
            {{ clearing ? '清除中...' : '确定清除' }}
          </button>
          <button
            class="btn-cancel-clear"
            @click="clearConfirmActive = false"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { inject } from 'vue';
import { BIDDING_BOARD_KEY } from '../composables/useBiddingBoard.js';

const board = inject(BIDDING_BOARD_KEY);
const { clearConfirmActive, confirmClearData, clearing } = board;
</script>

<style scoped>
.clear-confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; }
.clear-confirm-panel { background: #fff; border-radius: 12px; padding: 24px; min-width: 320px; }
.clear-confirm-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.clear-confirm-desc { font-size: 13px; color: #6b7280; margin-bottom: 16px; }
.clear-confirm-actions { display: flex; gap: 8px; }
.btn-confirm-clear { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; background: #dc2626; color: #fff; cursor: pointer; font-size: 13px; }
.btn-cancel-clear { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; background: #e5e7eb; color: #374151; cursor: pointer; font-size: 13px; }
</style>
