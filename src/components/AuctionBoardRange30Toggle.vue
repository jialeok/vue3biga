<!--
  AuctionBoardRange30Toggle.vue — 「30日涨幅」排序 toggle（独立组件，§15 / §29）

  ★ [RANGE30 2026-11-18 用户口径 · 原话]
    「把早盘竞价看板的竞/昨占比 toggle UI 和功能去掉，不要残留，因为这个功能现在用不到了，
      换成30日涨幅 toggle，新建一个组件给 30日涨幅 toggle，不要和其它搞混在一起。」
    「30日涨幅和20日涨幅功能差不多，有竞价口径和收盘口径，要注意下。」

  为什么单独成组件（而不是继续内联在 AuctionBoardToolbar 里）：
    · 用户明确要求「新建一个组件，不要和其它搞混在一起」；
    · 20日/十日涨幅的开关仍内联在 toolbar 里，本开关【不参与】那一堆内联结构，
      以后改 30 日的文案 / 交互只动这一个文件，不会碰到别的 toggle。

  口径（唯一真相在 Logic 层，本组件只负责「翻开关」）：
    · 主排序 = `sortState.byRangePct30`（单层：全部股票一条列表，按 30 日区间涨幅降序）；
    · 与 十日 / 20日 / 竞/昨 三条主排序【互斥】—— 互斥由 useAuctionBoard#toggleSort 维护（§6）；
    · 「竞价口径」`sortState.byAuctionLeg` 是【口径修饰开关】，可与本开关同时打开
      （打开 = 用 9:26 竞价腿替换今天的收盘腿，见 logic/auction/range30.js）。

  §21：模板只读一个布尔值，⛔ 不做任何计算。
  经 inject('auctionBoard') 共享同一 composable 实例（与 AuctionBoardTopicToggle 同款）。
-->
<template>
  <div class="auction-toggle-item">
    <span class="auction-toggle-label">30日涨幅</span>
    <label class="auction-toggle-switch">
      <input
        type="checkbox"
        :checked="sortState.byRangePct30"
        @change="toggleSort('byRangePct30')"
      >
      <span class="auction-toggle-slider" />
    </label>
  </div>
</template>

<script setup>
import { inject } from 'vue';

const board = inject('auctionBoard');
const { sortState, toggleSort } = board;
</script>
