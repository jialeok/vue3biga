<template>
  <EditModal v-model="trackEditModalActive" :title="'📌 编辑追踪记录 - ' + trackEditStockName" @save="saveTrackEditModal">
    <div class="track-edit-list">
      <div v-for="(row, idx) in editingTrackRows" :key="idx" class="track-edit-row">
        <div class="track-edit-date">
          <input class="track-date-input" v-model="row.date" placeholder="自动填充" readonly style="background:#f8fafc;cursor:default" />
        </div>
        <div class="track-edit-content">
          <textarea class="track-content-input" v-model="row.content" placeholder="追踪内容..." @input="onTrackContentInput(idx)"></textarea>
        </div>
        <div class="track-edit-delete">
          <button type="button" class="remove-track-btn" @click="removeTrackRow(idx)">×</button>
        </div>
      </div>
    </div>
    <button type="button" class="add-track-row-btn" @click="addTrackRow" style="margin-top:10px">+ 添加行</button>
  </EditModal>
</template>

<script setup>
import EditModal from './EditModal.vue';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const {
  trackEditModalActive,
  trackEditStockName,
  editingTrackRows,
  addTrackRow,
  removeTrackRow,
  onTrackContentInput,
  saveTrackEditModal
} = useHomeStocksState();
</script>
