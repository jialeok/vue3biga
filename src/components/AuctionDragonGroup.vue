<!--
  AuctionDragonGroup.vue — 第一页【最上方】的「龙头组」区块（观察组之上，用蚂蚁线与观察组隔开）。

  渲染口径（用户需求）：
    · 行布局与【观察组完全一致】—— 复用同一个标准行组件 AuctionEntityRow
      （序号 / 股票名 / 竞价量 / 昨成交量 / 占比，点序号可展开趋势面板看四要素）；
    · 龙头 = 某日「题材成员 >= 3 只」的题材中，近 10 个交易日区间涨幅最高的那一只；
    · 「每天的龙头放到次日」→ 本区块展示的是【前一交易日】评选出的龙头名册；
    · 与观察组去重：既属观察组又属龙头组的票只出现在这里（龙头组排最前）；
    · 龙头同时位于今日正式列表 → 名字后打 *（与观察组 `*` 同一套「双身份」语义）。

  §3 纯展示：只接收 Logic 层已算好的行对象（view-helpers 注入的龙头壳行 / 正式行），
  不做任何评选、不改数据、不发请求 —— 名册的唯一真相在 logic/auction/dragon-group.js（§6）。
-->
<template>
  <template v-if="items.length > 0">
    <div class="auction-group-label auction-dragon-group-label">
      龙头组
    </div>
    <AuctionEntityRow
      v-for="(item, idx) in items"
      :key="item.index"
      :item="item"
      :idx="idx"
    />
  </template>
</template>

<script setup>
import AuctionEntityRow from './AuctionEntityRow.vue';

// 龙头组行对象数组（来自 composable 的 filteredDragonItems）：
// 与观察组/常规组是同一种行对象（同一套 _enrichAuctionItem 产出），因此可直接交给标准行组件渲染。
// ⚠️ 行内「龙」标与十日涨幅走 dragonGroup* 前缀字段：dragonPct/dragonRank 属另一套
//    「题材内龙头排名」，会在 items 组装末尾被重写（曾因此导致龙头组十日涨幅全为空）。
defineProps({
  items: { type: Array, default: () => [] }
});
</script>
