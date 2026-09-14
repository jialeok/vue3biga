<!--
  AuctionBoardTable.vue — 早盘竞价第一页：龙头组 / 观察组 / 正式组行列表。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。

  [DRAGON-GROUP 2026-09-14] 三个区块（龙头组 / 观察组 / 常规组）的行【全部由 AuctionEntityRow 渲染】，
  保证行布局、列（竞价量 / 昨成交量 / 占比）、展开收起、四要素面板在三种分组下完全一致。
  本组件只决定「每个区块有哪些 item、区块之间怎么分隔」。
-->
<template>
  <div
    v-if="!viewData.items || viewData.items.length === 0"
    class="auction-empty"
    @dblclick="openBackend"
  >
    暂无数据，双击打开后台
  </div>

  <!-- [DRAGON-GROUP 2026-09-14] 龙头组：第一页最上方独立区块（观察组之上），用蚂蚁线与观察组隔开。
       数据/索引全部来自 Logic 层（viewData.dragonIndices）；题材模式下 dragonIndices=[] →
       本区块自动不渲染，改用行内「龙」标记辨认。 -->
  <AuctionDragonGroup :items="filteredDragonItems" />
  <div
    v-if="showDragonSeparator"
    class="auction-dragon-separator"
  />

  <div
    v-if="filteredObsItems.length > 0"
    class="auction-group-label auction-obs-group-label"
  >
    观察组
  </div>
  <template
    v-for="(item, idx) in filteredObsItems"
    :key="item.index"
    v-memo="[item.itemClass, item.numberClass, item.stockClass, item.ratio, item.ratioArrow, item.volumeDisplay, item.yestVolumeDisplay, item.yestColorClass, item.ratioClass, item.topicsDisplay, item.topicBg, expandedSet.has(item.stock), sortState.byTopic, item.dragonRank, item.dragonPct, item.aucPctNum, item.isYiZi, item.topicStats, item.seqNo, item.closeLimit, item.closePct, item.closeNameTone, item.streakLabel, item.isDragonGroupMember, item.dragonGroupTopic, item.dragonGroupFormalStar, item.dragonGroupPct, item.obsFormalStar]"
  >
    <AuctionEntityRow
      :item="item"
      :idx="idx"
    />
  </template>
  <div
    v-if="showObsSeparator"
    class="auction-obs-separator"
  />
  <template
    v-for="(item, idx) in filteredRegularItems"
    :key="item.index"
    v-memo="[item.itemClass, item.numberClass, item.stockClass, item.ratio, item.ratioArrow, item.volumeDisplay, item.yestVolumeDisplay, item.yestColorClass, item.ratioClass, item.topicsDisplay, item.topicBg, expandedSet.has(item.stock), sortState.byTopic, item.dragonRank, item.dragonPct, item.aucPctNum, item.isYiZi, item.topicStats, item.seqNo, item.closeLimit, item.closePct, item.closeNameTone, item.streakLabel, item.isDragonGroupMember, item.dragonGroupTopic, item.dragonGroupFormalStar, item.dragonGroupPct, item.obsFormalStar]"
  >
    <AuctionEntityRow
      :item="item"
      :idx="idx"
    />
  </template>
</template>

<script setup>
import { inject, watch, nextTick } from 'vue';
import AuctionDragonGroup from './AuctionDragonGroup.vue';
import AuctionEntityRow from './AuctionEntityRow.vue';
const board = inject('auctionBoard');
// 只解构本组件真正用到的东西：行本体（含展开面板、所有列、所有点击交互）已全部下沉到
// AuctionEntityRow，三个区块在这里只决定「哪些 item、怎么分隔」。
// 之前那份 90 项的大解构是「模板与行内联」时代的产物，行搬走后即为死代码（§42 不留 dead code）。
const {
  sortState, expandedSet, viewData,
  filteredObsItems, filteredRegularItems, filteredDragonItems,
  showObsSeparator, showDragonSeparator,
  highlightStockSet, openBackend
} = board;


// [FEAT 2026-08-18] 表头搜索高光：watch highlightStockSet 直接操作行 DOM 加/移除高光类 + 滚动定位。
// 不走 :class 响应式（v-memo 对 ref(Set).has() 追踪不可靠），改用 watch + DOM 确定生效。
// §17 UI 操作自己渲染的 DOM（行由本组件渲染），非业务逻辑；数据变化后重新加高光避免 v-memo 重渲染覆盖。
// [DRAGON-GROUP 2026-09-14] 龙头组的行已改为与观察组同款标准行（.auction-item），不再是独立胶囊，
// 因此选择器只需扫 .auction-item[data-stock] 即可覆盖三个区块（原先额外扫 .dragon-chip 的说法已作废）。
function applyHighlight() {
  nextTick(() => {
    const s = highlightStockSet.value;
    const rows = document.querySelectorAll('.auction-item[data-stock]');
    rows.forEach(row => {
      const stock = row.getAttribute('data-stock') || '';
      if (s.has(stock)) row.classList.add('auction-row-highlight');
      else row.classList.remove('auction-row-highlight');
    });
    if (s.size > 0) {
      const first = document.querySelector('.auction-item.auction-row-highlight');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}
watch(highlightStockSet, applyHighlight);
watch(viewData, () => { if (highlightStockSet.value.size > 0) applyHighlight(); });
</script>
