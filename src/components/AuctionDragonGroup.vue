<!--
  AuctionDragonGroup.vue — 第一页【最上方】的「龙头组」独立小组件（观察组之上，用蚂蚁线与观察组隔开）。

  §3 纯展示组件：只接收 Logic 层已算好的行对象（view-helpers 注入的龙头壳行 / 正式行），
  不做任何评选、不改数据、不发请求 —— 名册的唯一真相在 logic/auction/dragon-group.js（§6）。

  口径（用户需求）：
    · 龙头 = 某日「题材成员 >= 3 只」的题材中，近 10 个交易日区间涨幅最高的那一只；
    · 「每天的龙头放到次日」→ 本区块展示的其实是【前一交易日】评选出的龙头名册；
    · 与观察组去重：既属观察组又属龙头组的票只出现在这里（龙头组排最前）；
    · 龙头同时位于今日正式列表 → 名字后打 *（与观察组 `*` 同一套「双身份」语义）。

  设计目标：节省空间 —— 横向流式「胶囊」排布，序号/名称/龙·题材/十日涨幅四项一线，
  不再占用整行（避免与观察组、常规组混成一片看不清）。
-->
<template>
  <template v-if="items.length > 0">
    <div class="auction-group-label auction-dragon-group-label">
      龙头组
    </div>
    <div class="dragon-group-strip">
      <span
        v-for="(item, idx) in items"
        :key="item.index"
        class="dragon-chip"
        :data-stock="item.stock || ''"
        :title="chipTitle(item)"
      >
        <span class="dragon-chip-seq">{{ idx + 1 }}</span>
        <span class="dragon-chip-name">{{ item.stock }}<b
          v-if="item.dragonGroupFormalStar"
          class="dragon-chip-star"
        >*</b></span>
        <span
          v-if="item.dragonGroupTopic"
          class="dragon-chip-topic"
        >龙·{{ item.dragonGroupTopic }}</span>
        <span
          v-if="item.dragonGroupPct !== null && item.dragonGroupPct !== undefined"
          class="dragon-chip-pct"
          :class="pctClass(item.dragonGroupPct)"
        >{{ fmtPct(item.dragonGroupPct) }}</span>
      </span>
    </div>
  </template>
</template>

<script setup>
const props = defineProps({
  // 龙头组行对象数组（来自 composable 的 filteredDragonItems）。
  // 每项含 stock / dragonGroupTopic / dragonGroupPct / dragonGroupFormalStar / dragonGroupSize。
  // ⚠️ 用 dragonGroup* 前缀而非 dragonPct：后者是另一套「题材内龙头排名」的字段（会被重写）。
  items: { type: Array, default: () => [] }
});

// 十日区间涨幅：>0 红 / <0 绿 / 0 灰（涨红跌绿，国内看板惯例）。
// 文本格式化在组件内联（纯展示格式化，非业务口径），数值本身来自 Logic 层名册。
function fmtPct(v) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function pctClass(v) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return 'dragon-pct-flat';
  if (n > 0) return 'dragon-pct-up';
  if (n < 0) return 'dragon-pct-down';
  return 'dragon-pct-flat';
}
function chipTitle(item) {
  if (!item) return '';
  const bits = [];
  if (item.dragonGroupTopic) bits.push('题材：' + item.dragonGroupTopic + (item.dragonGroupSize ? '（成员 ' + item.dragonGroupSize + ' 只）' : ''));
  bits.push('10日涨幅：' + (fmtPct(item.dragonGroupPct) || '-'));
  if (item.obsFormalStar || item.dragonGroupFormalStar) bits.push('* 该龙头同时位于今日正式列表');
  bits.push('（前一日评选，今日进入龙头组）');
  return bits.join('｜');
}
</script>

<style scoped>
/* 龙头组：横向流式胶囊，一行可放多只，尽量不额外占高度 */
.dragon-group-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  padding: 3px 12px 5px;
}
.dragon-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border: 1px solid #ddd6fe;
  background: #f5f3ff;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  cursor: default;
}
.dragon-chip-seq {
  color: #7c3aed;
  font-weight: 700;
  font-size: 10px;
  min-width: 9px;
  text-align: center;
}
.dragon-chip-name {
  color: #111827;
  font-weight: 600;
}
.dragon-chip-star {
  color: #dc2626;
  font-weight: 700;
  margin-left: 1px;
}
.dragon-chip-topic {
  color: #6d28d9;
  font-size: 10px;
  padding: 0 3px;
  border-radius: 2px;
  background: #ede9fe;
}
.dragon-chip-pct {
  font-weight: 600;
}
.dragon-pct-up {
  color: #dc2626;
}
.dragon-pct-down {
  color: #059669;
}
.dragon-pct-flat {
  color: #64748b;
}
/* 表头搜索高光（AuctionBoardTable#applyHighlight 动态加类）：龙头胶囊同样可被命中定位。
   与 .auction-item.auction-row-highlight 同款视觉（内描边），保证「搜索命中的都在发光」。 */
.dragon-chip.auction-row-highlight {
  box-shadow: inset 0 0 0 2px #64748b;
}
</style>
