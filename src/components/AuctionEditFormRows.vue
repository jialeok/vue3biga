<template>
  <!-- 表单行 -->
  <div class="rank-form-scroll-container">
    <div v-for="(row, idx) in modal.editRows" :key="idx" class="auction-form-row">
      <span class="rank-form-number">{{ idx + 1 }}</span>
      <input v-model="row.stock" placeholder="股票名称" class="form-input auction-form-stock-input">
      <input v-model="row.volume" placeholder="竞价量(万股)" class="form-input auction-form-volume-input">
      <input v-model="row.yestVolume" placeholder="昨日成交量(万股)" class="form-input auction-form-yest-input">
      <button @click="modal.removeRow(idx)" class="remove-rank-btn">×</button>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');
</script>

<style scoped>
/* 表单行（原版 .auction-form-row / .rank-form-number / .auction-form-*-input / .remove-rank-btn） */
.rank-form-scroll-container {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  padding-right: 10px;
}
.rank-form-scroll-container::-webkit-scrollbar { height: 4px; }
.rank-form-scroll-container::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
.rank-form-scroll-container::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 2px; }

.auction-form-row {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  align-items: center;
  height: 44px;
  flex-shrink: 0;
}
.rank-form-number {
  flex: 0 0 28px;
  width: 28px;
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  text-align: center;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 2px;
  background: #f8fafc;
  border-radius: 4px;
}
.form-input {
  height: 40px;
  font-size: 13px;
  padding: 0 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-sizing: border-box;
  background: #fff;
  color: #1f2937;
  outline: none;
}
.auction-form-stock-input { flex: 1.5; min-width: 100px; }
.auction-form-volume-input,
.auction-form-yest-input { flex: 1; min-width: 80px; }
.remove-rank-btn {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  margin-left: 6px;
  background: #fee2e2;
  border: 1px solid #fecaca;
  color: #dc2626;
  border-radius: 6px;
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
