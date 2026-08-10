<template>
  <div class="circle-stats-bar">
    <div class="circle-card" :class="profitCardClass" @dblclick="$emit('edit')">
      <div class="circle-label">今日盈亏</div>
      <div class="circle-value">{{ profitDisplay }}</div>
    </div>
    <div class="circle-card" :class="gainCardClass" @dblclick="$emit('edit')">
      <div class="circle-label">账户涨幅</div>
      <div class="circle-value">{{ gainDisplay }}</div>
    </div>
    <div class="circle-card" :class="balanceCardClass" @dblclick="$emit('edit')">
      <div class="circle-label">账户余额</div>
      <div class="circle-value">{{ balanceDisplay }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  profit: { type: [String, Number], default: '' },
  gain: { type: [String, Number], default: '' },
  balance: { type: [String, Number], default: '' },
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
const balanceDisplay = computed(() => {
  if (props.balance === '' || props.balance === undefined || isNaN(parseFloat(props.balance))) return '-';
  return formatAmount(props.balance);
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
const balanceCardClass = computed(() => '');
</script>

<style scoped>
.circle-stats-bar { display: flex; gap: 12px; align-items: center; justify-content: center; }
.circle-card {
  display: flex; flex-direction: column; align-items: center;
  padding: 12px 20px; border-radius: 50%; border: 2px solid #e5e7eb;
  background: #fff; min-width: 100px;
}
.circle-card.positive { border-color: #dc2626; background: #fef2f2; }
.circle-card.negative { border-color: #059669; background: #f0fdf4; }
.circle-label { font-size: 11px; color: #6b7280; }
.circle-value { font-size: 18px; font-weight: 600; color: #1f2937; }
</style>