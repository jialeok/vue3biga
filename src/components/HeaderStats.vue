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

</style>