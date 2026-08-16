<template>
  <EditModal
    v-model="trackEditModalActive"
    :title="trackEditTitle"
    @save="saveTrackEditModal"
  >
    <div class="track-edit-list">
      <div
        v-for="(row, idx) in editingTrackRows"
        :key="idx"
        class="track-edit-row"
      >
        <div class="track-edit-date">
          <input
            v-model="row.date"
            class="track-date-input"
            placeholder="自动填充"
            readonly
            style="background:#f8fafc;cursor:default"
          >
        </div>
        <div class="track-edit-content">
          <textarea
            v-model="row.content"
            class="track-content-input"
            placeholder="追踪内容..."
            @input="onTrackContentInput(idx)"
          />
        </div>
        <div class="track-edit-delete">
          <button
            type="button"
            class="remove-track-btn"
            @click="removeTrackRow(idx)"
          >
            ×
          </button>
        </div>
      </div>
    </div>
    <button
      type="button"
      class="add-track-row-btn"
      style="margin-top:10px"
      @click="addTrackRow"
    >
      + 添加行
    </button>
  </EditModal>
</template>

<script setup>
import { computed } from 'vue';
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

const trackEditTitle = computed(() => '📌 编辑追踪记录 - ' + trackEditStockName.value);
</script>
