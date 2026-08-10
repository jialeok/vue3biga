<template>
  <!-- 竞价角标渲染组件：从 buildBadgeHtml 迁移，纯 VueC3 路径替代原 HTML 拼接 -->
  <span class="auction-badge-group">
    <span v-if="item.monitorWarning" class="auction-badge badge-warn" title="严重异常波动">⚠</span>
    <span v-if="tagState.sold" class="auction-badge badge-sell">卖</span>
    <span v-else-if="tagState.bought" class="auction-badge badge-buy">买</span>
    <span v-else-if="tagState.selected" class="auction-badge badge-hold">持</span>
    <span v-if="todayChoice === 'buy'" class="auction-badge badge-today-buy" title="今天选：买入→明天继承">买→</span>
    <span v-else-if="todayChoice === 'sell'" class="auction-badge badge-today-sell" title="今天选：卖出→明天继承">卖→</span>
    <span v-else-if="todayChoice === 'hold'" class="auction-badge badge-today-hold" title="今天选：持有→明天继承">持→</span>
    <span v-else-if="todayChoice === 'cancel'" class="auction-badge badge-today-cancel" title="今天选：取消次日观察">×</span>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import auctionTagStore from '../stores/auctionTagStore.js';

const uiStore = useUiStore();

const props = defineProps({
  item: { type: Object, required: true },
  ctx: { type: Object, default: () => ({}) },
  tagState: { type: Object, default: () => ({}) }
});

const todayChoice = computed(() => {
  const name = props.item.stock ? props.item.stock.trim() : '';
  const date = props.ctx.date || uiStore.currentDate;
  return auctionTagStore.getTagState(date, name);
});
</script>

<style scoped>
.auction-badge-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.auction-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}
.badge-warn {
  background: #fef3c7;
  color: #b45309;
  border: 1px solid #fcd34d;
}
.badge-sell {
  background: #6b7280;
  color: #fff;
}
.badge-buy {
  background: #dc2626;
  color: #fff;
}
.badge-hold {
  background: #2563eb;
  color: #fff;
}
.badge-today-buy {
  background: transparent;
  color: #dc2626;
  border: 1px dashed #dc2626;
}
.badge-today-sell {
  background: transparent;
  color: #6b7280;
  border: 1px dashed #6b7280;
}
.badge-today-hold {
  background: transparent;
  color: #2563eb;
  border: 1px dashed #2563eb;
}
.badge-today-cancel {
  background: transparent;
  color: #9ca3af;
  border: 1px dashed #9ca3af;
}
</style>