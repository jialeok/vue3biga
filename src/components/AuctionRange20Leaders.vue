<!--
  AuctionRange20Leaders.vue — 第一页【龙头组之后、观察组之前】的「20日强势补位」区块。

  为什么有它（用户 2026-10-19 原话）：
    「当天我怕错过一些不在正式列表的市场龙头……比如今天的九阳股份，如果它不是继承上交易的龙头组，
      就消失了，我就看不见了，买股票的信息就不准确。……如果消失了，我看这个20天涨幅就没多大意义。」
    「如果这五只也在当天列表中，那就不用重复补了……如果没有就要补，补到龙头组，要区分，就在后面添加
      标签"20天"……你可以新建一个小组件给它们，这样就不会乱，以后改的时候也方便。」

  口径（唯一真相在 logic/auction/range20-leaders.js，本组件只渲染）：
    · 候选池 = 近 20 个交易日【每一天的早盘竞价正式列表】的并集（⛔ 不是当天列表）；
    · 只主板（创业板 300/301、科创板 688/689、北交所 43/83/87/92 全部不算）；
    · 窗口内上榜 >= 6 天才有资格参与排名（天数不足算不出 20 日涨幅，⛔ 不补 0 凑数）；
    · 按 20 个交易日区间涨幅降序取前 5；当天列表里已经有的【不重复补】；
    · 补进来的票行上带「20天」标签，其余行布局/点击展开/数据获取与别的行完全一致。

  §3 纯展示：只接收 Logic 层算好的行对象（view-helpers 注入的补位行），
  不做筛选、不改数据、不发请求。区块为空则整体不渲染（没得补 = 不出现，⛔ 不留空标题）。
-->
<template>
  <template v-if="items.length > 0">
    <div class="auction-group-label auction-r20-group-label">
      <span class="auction-r20-group-title">20日强势补位</span>
      <span class="auction-r20-group-hint">近 20 个交易日竞价名单中，20 日涨幅前五 · 当天列表里没有的才补（只主板）</span>
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

// 补位行对象数组（来自 composable 的 filteredRange20LeaderItems）：
// 与龙头组/观察组/常规组是同一种行对象（同一套 _enrichAuctionItem 产出），因此可直接交给标准行组件渲染
// —— 这也是用户要求的「他们的功能进入列表后也是一样可以获取数据，和其它股票一样有数据」。
// ⚠️ 行上的「20天」标签与区间涨幅走 range20Leader* 前缀字段，
//   与 rangePct20（20日涨幅 toggle 打开时才有的排序键）不是一回事。
defineProps({
  items: { type: Array, default: () => [] }
});
</script>
