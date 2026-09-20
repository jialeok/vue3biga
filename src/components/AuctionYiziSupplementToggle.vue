<!--
  AuctionYiziSupplementToggle.vue — 「补竞价一字」开关（独立组件，§15）

  位置（用户原话）：「在顶部表头（序号，股票名称，题材，X）添加一个，补竞价一字（X 的位置）」
    ⇒ 本组件挂在 AuctionBoardToolbar.vue 的 .auction-header-row 末尾（题材列右侧的 X 位），
      并且**只在题材 toggle 打开时出现**（本功能只服务题材模式）。

  ⚠️ 为什么要绝对定位（.auction-yizi-sup-toggle）：
     表头三列（序号 0.4 / 股票名称 1.2 / 题材 2.5）与数据行的三列是两套独立的 flex 容器，
     flex 值只在各自容器内换算。若把开关当成表头的第 4 个 flex 项，表头三列会被同步压窄
     → 表头文字与下面数据列**整体错位**。绝对定位让它脱离这段 flex 流：既不破坏列对齐，
     又真的落在表头这一行里（且表头是 sticky 的，滚动时始终可点）。

  §3 纯展示组件：只读 inject('auctionYiziSupplement') 的状态与回调；
    ⛔ 不新建状态、不复制一份 board、不读早盘竞价的任何业务数据。
  ⛔ @dblclick.stop：表头容器上挂着「双击打开后台」的处理器，开关上的双击不应触发它。
-->
<template>
  <div
    v-if="visible"
    class="auction-yizi-sup-toggle"
    :title="hint"
    @dblclick.stop
  >
    <span class="auction-yizi-sup-toggle-label">补竞价一字</span>
    <label class="auction-yizi-sup-toggle-switch">
      <input
        type="checkbox"
        :checked="on"
        @change="toggle"
      >
      <span class="auction-yizi-sup-toggle-slider" />
    </label>
  </div>
</template>

<script setup>
import { inject } from 'vue';

const sup = inject('auctionYiziSupplement');
const { on, visible, toggle } = sup;

const hint = '打开：把「竞价一字」看板的一字板股票【按题材并入下方对应的题材组】（组内原有股票之后，带「补」标；'
  + '股票名已在列表里的不再重复列出；题材在当日列表里没有对应分组的收在最下方「未并入」里）。'
  + '一字行可点序号展开近 5 日趋势。数据取自竞价一字看板自己的库，与早盘竞价的列表 / 排序互不影响；'
  + '关闭即恢复原样。';
</script>
