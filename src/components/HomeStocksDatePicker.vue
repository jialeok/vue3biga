<template>
  <EditModal v-model="datePickerActive" title="选择日期" :show-actions="false">
    <div class="date-picker-section">
      <div class="date-picker-nav">
        <button @click="prevPickerMonth">‹</button>
        <span>{{ pickerYear }}-{{ String(pickerMonth + 1).padStart(2, '0') }}</span>
        <button @click="nextPickerMonth">›</button>
      </div>
      <div class="date-picker-grid">
        <button v-for="day in pickerDays" :key="day.key"
                :class="{ 'date-selected': day.key === pickerSelected, 'date-today': day.isToday, 'date-disabled': !day.valid }"
                :disabled="!day.valid"
                @click="selectPickerDate(day.key)">
          {{ day.label }}
        </button>
      </div>
      <div class="date-picker-actions">
        <button @click="pickerGoToday">今天</button>
        <button @click="datePickerActive = false">取消</button>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import EditModal from './EditModal.vue';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const {
  datePickerActive,
  pickerYear,
  pickerMonth,
  pickerSelected,
  pickerDays,
  prevPickerMonth,
  nextPickerMonth,
  selectPickerDate,
  pickerGoToday
} = useHomeStocksState();
</script>
