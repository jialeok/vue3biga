<!-- BiddingBoardEditModal.vue — 竞价变化后台编辑弹窗（含抓取按钮 + 编辑行） -->
<template>
  <EditModal v-model="modalActive" title="编辑竞价变化" :show-clear="true" save-text="保存" :saving="saving" clear-class="btn-clear-gray" @save="save" @clear="clearData">
    <div class="bidding-edit-desc">记录竞价变化数据（固定 7 行，行名不可编辑）</div>
    <div class="bidding-fetch-row">
      <button type="button" class="btn-fetch-snapshot" @click="fetchSnapshot" :disabled="fetchLoading">{{ fetchLoading ? '⏳ 抓取中...' : '📡 抓取当前时段数据' }}</button>
      <span v-if="fetchStatus" class="bidding-fetch-status">{{ fetchStatus }}</span>
    </div>
    <div class="bidding-edit-rows">
      <div v-for="(row, idx) in editRows" :key="idx" class="bidding-edit-row" :class="{ 'bidding-edit-row-time26': row.name === '最近多板%time26' }">
        <template v-if="row.name === '最近多板%time26'">
          <div class="bidding-edit-row-time26-line">
            <input :value="row.name" readonly class="bidding-edit-name-readonly-line" />
            <input v-model="row.time925" placeholder="9:26" @input="onInputChange(row)" />
            <input :value="row.change" placeholder="增减" readonly class="bidding-row-change" :class="changeTagClass(row.change)" />
            <span class="bidding-edit-empty-cell"></span>
          </div>
        </template>
        <template v-else>
          <div class="bidding-edit-row-top">
            <input :value="row.name" readonly class="bidding-edit-name bidding-edit-name-readonly" />
          </div>
          <div class="bidding-edit-row-bottom">
            <input v-model="row.time915" placeholder="9:15" @input="onInputChange(row)" />
            <input v-model="row.time920" placeholder="9:20" @input="onInputChange(row)" />
            <input v-model="row.time925" placeholder="9:25" @input="onInputChange(row)" />
            <input :value="row.change" placeholder="增减" readonly class="bidding-row-change" :class="changeTagClass(row.change)" />
            <input v-model="row.close" placeholder="收盘" @input="onInputChange(row)" />
          </div>
        </template>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import { inject } from 'vue';
import EditModal from './EditModal.vue';
import { BIDDING_BOARD_KEY } from '../composables/useBiddingBoard.js';

const board = inject(BIDDING_BOARD_KEY);
const { modalActive, editRows, fetchStatus, fetchLoading, saving, fetchSnapshot, save, clearData, onInputChange, changeTagClass } = board;
</script>

<style scoped>
.bidding-edit-desc {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 12px;
}
.bidding-fetch-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.btn-fetch-snapshot {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #fff;
  padding: 8px 14px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.btn-fetch-snapshot:disabled { opacity: 0.6; cursor: not-allowed; }
.bidding-fetch-status { font-size: 11px; color: #6b7280; }

.bidding-edit-row {
  margin-bottom: 8px;
  padding: 8px;
  background: #f9fafb;
  border-radius: 8px;
}
.bidding-edit-row-top {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.bidding-edit-name {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.bidding-edit-row-bottom {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.bidding-edit-row-time26-line {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 4px;
  align-items: center;
}
.bidding-edit-name-readonly-line {
  padding: 6px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 13px;
  background: #f1f5f9;
  color: #334155;
  font-weight: 600;
  text-align: left;
}
.bidding-edit-row-time26-line input {
  padding: 6px 4px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
  background: #fff;
  min-width: 0;
}
.bidding-edit-empty-cell {}
.bidding-edit-row-time26 {
  background: #fff7ed;
  border: 1px dashed #fdba74;
}
.bidding-edit-row-bottom input {
  padding: 6px 4px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
  background: #fff;
  min-width: 0;
}
.bidding-edit-name-readonly {
  background: #f1f5f9;
  color: #334155;
  font-weight: 600;
  cursor: default;
}
.bidding-row-change { background: #f8fafc; font-weight: 600; cursor: default; }
</style>
