<template>
  <EditModal v-model="soldEditModalActive" :title="'💰 ' + soldEditStockName + ' - 卖出记录'" @save="saveSoldEditModal">
    <div class="track-edit-list">
      <div v-for="(row, idx) in editingSoldRows" :key="row.id" class="track-edit-row sold-edit-row">
        <div class="sold-row-head">
          <span class="sold-row-index">卖出 #{{ idx + 1 }}</span>
          <button type="button" class="remove-track-btn" @click="removeSoldRow(idx)">×</button>
        </div>
        <div class="sold-grid">
          <div class="sold-field">
            <label>日期</label>
            <input class="track-date-input sold-date-input" v-model="row.date" placeholder="YYYY-MM-DD HH:mm" />
          </div>
          <div class="sold-field">
            <label>盈利</label>
            <input class="track-content-input sold-profit-input" v-model="row.profit" placeholder="如：+1260" />
          </div>
          <div class="sold-field">
            <label>涨幅</label>
            <input class="track-content-input sold-percent-input" v-model="row.percent" placeholder="如：+4.5%" />
          </div>
          <div class="sold-field">
            <label>类型</label>
            <select class="track-content-input sold-type-input" v-model="row.type">
              <option value="">请选择</option>
              <option value="全清仓">全清仓</option>
              <option value="部分卖">部分卖</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <button type="button" class="add-track-row-btn" @click="addSoldRow" style="margin-top:10px">+ 添加一条</button>
  </EditModal>
</template>

<script setup>
import EditModal from './EditModal.vue';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const {
  soldEditModalActive,
  soldEditStockName,
  editingSoldRows,
  addSoldRow,
  removeSoldRow,
  saveSoldEditModal
} = useHomeStocksState();
</script>
