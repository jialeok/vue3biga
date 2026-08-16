<template>
  <span class="auction-badge-group">
    <span
      v-if="item.monitorWarning"
      class="auction-badge badge-warn"
      title="严重异常波动"
    >⚠</span>
    <span
      v-if="tagState.sold"
      class="auction-badge badge-sell"
    >卖</span>
    <span
      v-else-if="tagState.bought"
      class="auction-badge badge-buy"
    >买</span>
    <span
      v-else-if="tagState.selected"
      class="auction-badge badge-hold"
    >持</span>
    <span
      v-if="tagState.todayChoice === 'buy'"
      class="auction-badge badge-today-buy"
      title="今天选：买入→明天继承"
    >买→</span>
    <span
      v-else-if="tagState.todayChoice === 'sell'"
      class="auction-badge badge-today-sell"
      title="今天选：卖出→明天继承"
    >卖→</span>
    <span
      v-else-if="tagState.todayChoice === 'hold'"
      class="auction-badge badge-today-hold"
      title="今天选：持有→明天继承"
    >持→</span>
    <span
      v-else-if="tagState.todayChoice === 'cancel'"
      class="auction-badge badge-today-cancel"
      title="今天选：取消次日观察"
    >×</span>
  </span>
</template>

<script setup>
const props = defineProps({
  item: { type: Object, required: true },
  ctx: { type: Object, default: () => ({}) },
  tagState: { type: Object, default: () => ({}) }
});
</script>

<style scoped>
.auction-badge-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 3px;
  pointer-events: none;
  vertical-align: middle;
}
.auction-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 2px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
}
.badge-warn {
  background: #fef3c7;
  color: #b45309;
  border: 1px solid #fcd34d;
}
.badge-buy {
  background: #dc2626;
  color: #fff;
}
.badge-hold {
  background: #2563eb;
  color: #fff;
}
</style>
