<template>
  <div class="header-stats">
    <div class="circle-card" :class="profitCardClass">
      <div class="circle-label">今日盈亏</div>
      <div class="circle-value">{{ profitDisplay }}</div>
    </div>
    <div class="circle-card" :class="gainCardClass">
      <div class="circle-label">账户涨幅</div>
      <div class="circle-value">{{ gainDisplay }}</div>
    </div>
    <button v-if="editable" class="circle-edit-btn" @click="$emit('edit')">编辑</button>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  profit: { type: [String, Number], default: '' },
  gain: { type: [String, Number], default: '' },
  editable: { type: Boolean, default: false }
});

defineEmits(['edit']);

function formatAmount(v) {
  if (v === undefined || v === '' || isNaN(parseFloat(v))) return '-';
  return parseFloat(v).toLocaleString('zh-CN');
}

const profitDisplay = computed(() => {
  if (props.profit === '' || props.profit === undefined || isNaN(parseFloat(props.profit))) return '-';
  const f = formatAmount(props.profit);
  return parseFloat(props.profit) > 0 ? '+' + f : f;
});
const gainDisplay = computed(() => {
  if (props.gain === '' || props.gain === undefined || isNaN(parseFloat(props.gain))) return '-';
  return (parseFloat(props.gain) > 0 ? '+' : '') + props.gain + '%';
});
const profitCardClass = computed(() => {
  const n = parseFloat(props.profit);
  if (isNaN(n)) return '';
  return n > 0 ? 'positive' : (n < 0 ? 'negative' : '');
});
const gainCardClass = computed(() => {
  const n = parseFloat(props.gain);
  if (isNaN(n)) return '';
  return n > 0 ? 'positive' : (n < 0 ? 'negative' : '');
});
</script>

<style scoped>
.header-stats { display: flex; gap: 12px; align-items: center; }
.circle-card {
  display: flex; flex-direction: column; align-items: center;
  padding: 12px 20px; border-radius: 50%; border: 2px solid #e5e7eb;
  background: #fff; min-width: 100px;
}
.circle-card.positive { border-color: #dc2626; background: #fef2f2; }
.circle-card.negative { border-color: #059669; background: #f0fdf4; }
.circle-label { font-size: 11px; color: #6b7280; }
.circle-value { font-size: 18px; font-weight: 600; color: #1f2937; }
.circle-edit-btn {
  padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px;
  background: #fff; font-size: 12px; cursor: pointer;
}
</style>