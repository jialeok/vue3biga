<!--
  AuctionRange30Leaders.vue — 第一页【20日补位之后、观察组之前】的「30日强势补位」区块（第五组）。

  为什么有它（用户 2026-11-18 原话）：
    「还有要最近多板看板的30日所有的股票，取前五进行补位，标签是30天，这个和20天补的逻辑差不多，
      你看下怎么实现，可以参考20日补的。」

  口径（唯一真相在 logic/auction/range30-leaders.js，本组件只渲染）：
    · 候选池 = 近 30 个交易日【每一天的早盘竞价正式列表】的并集 = 同花顺「最近多板」883410
      每天被 worker 拉进来的那批成分股逐日累积（⛔ 不是当天列表）；
    · 只主板（创业板 300/301、科创板 688/689、北交所 43/83/87/92 全部不算）；
    · 30 日涨幅 = 期末收盘价 / 期初前收盘价 − 1（一次比值，与逐日累乘等价）；
    · 窗口内至少 10 天有成交才算得出来（次新股 / 长期停牌判不出，⛔ 不补 0 凑数）；
    · 按 30 个交易日区间涨幅降序取前 5；当天列表里已经有的【不重复补】；
    · 补进来的票行上带「30天」标签（青色，与「20天」的中性蓝区分），其余行为与别的行完全一致。

  §3 纯展示：只接收 Logic 层算好的行对象（view-helpers 注入的第五组行），
  不做筛选、不改数据、不发请求。区块为空则整体不渲染（没得补 = 不出现，⛔ 不留空标题）。
-->
<template>
  <template v-if="items.length > 0">
    <div class="auction-group-label auction-r30-group-label">
      <span class="auction-r30-group-title">30日强势补位</span>
      <!-- 数量 = 本区块实际行数（items 就是 Logic 层 range30LeaderIndices 取出的行），⛔ 不从别处再数一遍（§6）。 -->
      <span class="auction-r30-group-count">{{ items.length }} 只</span>
      <span class="auction-r30-group-hint">近 30 个交易日竞价名单中，30 日涨幅前五 · 当天列表里没有的才补（只主板）</span>
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

// 补位行对象数组（来自 composable 的 filteredRange30LeaderItems）：
// 与龙头组/观察组/常规组/20日补位是同一种行对象（同一套 _enrichAuctionItem 产出），因此可直接交给标准行组件渲染。
// ⚠️ 行上的「30天」标签与 30 日区间涨幅走 range30Leader* 前缀字段，
//   与 rangePct30（30日涨幅 toggle 打开时才有的排序键）不是一回事。
defineProps({
  items: { type: Array, default: () => [] }
});
</script>
