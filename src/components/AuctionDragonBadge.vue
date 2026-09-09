<!--
  AuctionDragonBadge.vue — 题材龙头徽章（龙一/龙二/龙三…）
  纯展示组件（§3）：只接收 Logic 层算好的 rank / pct，不做任何业务计算与请求。
  空间优先：9px 字号、2px 内边距，紧贴股票名右侧，不额外占行高。
-->
<template>
  <span
    v-if="label"
    class="dragon-badge"
    :class="rankClass"
    :title="title"
  >{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { getDragonLabel } from '../logic/auction/dragon-rank.js';

const props = defineProps({
  rank: { type: Number, default: 0 },
  pct: { type: Number, default: null }
});

const label = computed(() => getDragonLabel(props.rank));
const rankClass = computed(() => {
  if (props.rank === 1) return 'dragon-r1';
  if (props.rank === 2) return 'dragon-r2';
  if (props.rank === 3) return 'dragon-r3';
  return 'dragon-rn';
});
const title = computed(() => {
  const pctText = (props.pct === null || props.pct === undefined || isNaN(props.pct))
    ? '-'
    : (props.pct >= 0 ? '+' : '') + props.pct.toFixed(2) + '%';
  return '题材内10日区间涨幅 ' + pctText + '（' + label.value + '）';
});
</script>

<style scoped>
.dragon-badge {
  display: inline-block;
  margin-left: 2px;
  padding: 0 2px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 600;
  line-height: 11px;
  vertical-align: 1px;
  white-space: nowrap;
  color: #fff;
  pointer-events: auto;
}
.dragon-r1 {
  background: #dc2626;
}
.dragon-r2 {
  background: #f97316;
}
.dragon-r3 {
  background: #f59e0b;
}
.dragon-rn {
  background: #94a3b8;
}
</style>
