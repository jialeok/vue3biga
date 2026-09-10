<!--
  AuctionDragonBadge.vue — 题材龙头徽章（龙一/龙二/龙三…）
  纯展示组件（§3）：只接收 Logic 层算好的 rank / pct / pctChg，不做任何业务计算与请求。
  空间优先：9px 字号、2px 内边距，紧贴股票名右侧，不额外占行高。

  [DRAGON-COLOR 2026-09-11] 徽章底色改为「跟随当天竞价涨幅」：
    竞价涨幅 > 0 → 红 / < 0 → 绿 / = 0 → 灰（涨红跌绿，符合国内看板惯例）。
    底色只表达涨跌方向；「龙几」的档位信息由徽章文字（龙一/龙二…）承担。
    入参 pctChg 由 view-helpers 从内存行的 auc_pct_chg 派生（无请求、不落库）；
    null 表示当日无竞价涨幅数据 → 中性灰（不当作 0）。
-->
<template>
  <span
    v-if="label"
    class="dragon-badge"
    :class="colorClass"
    :title="title"
  >{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { getDragonLabel } from '../logic/auction/dragon-rank.js';

const props = defineProps({
  rank: { type: Number, default: 0 },
  pct: { type: Number, default: null },
  // 当天竞价涨幅（%）。null/undefined/NaN = 未取到 → 中性灰
  pctChg: { type: Number, default: null }
});

const label = computed(() => getDragonLabel(props.rank));
const colorClass = computed(() => {
  const v = props.pctChg;
  if (v === null || v === undefined || isNaN(v)) return 'dragon-flat';
  if (v > 0) return 'dragon-up';
  if (v < 0) return 'dragon-down';
  return 'dragon-flat';
});
const _fmtPct = (v) => (
  (v === null || v === undefined || isNaN(v)) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
);
const title = computed(() => (
  '题材内10日区间涨幅 ' + _fmtPct(props.pct)
  + '（' + label.value + '）'
  + '｜当日竞价涨幅 ' + _fmtPct(props.pctChg)
));
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
/* 底色 = 当天竞价涨幅方向（涨红 / 跌绿 / 平或缺失灰） */
.dragon-up {
  background: #dc2626;
}
.dragon-down {
  background: #059669;
}
.dragon-flat {
  background: #94a3b8;
}
</style>
