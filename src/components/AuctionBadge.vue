<template>
  <!-- 竞价角标渲染组件：从 buildBadgeHtml 迁移，纯 VueC3 路径替代原 HTML 拼接。
       badge-group 由父容器 .auction-stock-name (position:relative) 定位到右上角,
       pointer-events:none 不阻挡股票名称的长按/双击/右键。 -->
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
  /* 绝对定位到父容器(.auction-stock-name)右上角外侧, 脱离文档流不占空间。
     不预留 padding, 名称列宽度不被撑开, 后面四列位置固定不动。
     right 取负值让角标浮在名称右侧的间隙里, 不压住名称文字。
     pointer-events:none 确保不阻挡父级股票名称的长按/双击/右键事件。 */
  position: absolute;
  top: -8px;
  right: -18px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  pointer-events: none;
  z-index: 2;
}
.auction-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
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