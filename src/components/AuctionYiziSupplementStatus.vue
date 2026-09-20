<!--
  AuctionYiziSupplementStatus.vue — 「补竞价一字」状态 / 汇总一行（独立组件，§15）

  位置：AuctionBoardTable.vue 列表最上方（紧贴 sticky 表头之下，滚动时始终可见）。
  为什么要有它：
    · §10 读失败必须可见 —— 一字池读失败时给红字 + 可重试，⛔ 不能默默什么都不显示；
    · 「还没到 9:25 / 当天没有一字」也必须说清，⛔ 不能让人误以为「当天一只一字都没有」；
    · 正常时用一行汇总交代「一字 N 只 / 已并入 N 只 / 已在列表中 N 只 / 未并入 N 只」，
      带「补」标的行数因此可核对（多题材的一字会在多个题材组里各出现一次，行数 ≠ 只数）。

  §3 纯展示组件：只读 inject('auctionYiziSupplement') 的状态与文案；
    ⛔ 不新建状态、不复制一份 board、不读早盘竞价的任何业务数据。
  ⛔ @dblclick.stop：列表容器上挂着「双击打开后台」的处理器，本行的双击不应触发它。
-->
<template>
  <div
    v-if="active"
    class="auction-yizi-sup-status-wrap"
    @dblclick.stop
  >
    <div
      v-if="errorText"
      class="auction-yizi-sup-error"
    >
      {{ errorText }}（<span
        class="auction-yizi-sup-retry"
        @click.stop="retry"
      >重试</span>）
    </div>
    <div
      v-else-if="emptyText"
      class="auction-yizi-sup-empty"
      :class="{ 'is-loading': loading }"
    >
      {{ emptyText }}
    </div>
    <div
      v-else
      class="auction-yizi-sup-status"
    >
      <span class="auction-yizi-sup-status-title">补竞价一字</span>
      <span
        class="auction-yizi-sup-status-text"
        :title="hint"
      >{{ summaryText }}</span>
      <span
        v-if="trendErrorText"
        class="auction-yizi-sup-status-trend"
      >{{ trendErrorText }}</span>
      <span
        v-else-if="trendNoteText"
        class="auction-yizi-sup-status-trend"
      >{{ trendNoteText }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue';

const sup = inject('auctionYiziSupplement');
const {
  active, loading, errorText, emptyText, retry, summaryText, currentDate,
  trendErrorText, trendNoteText
} = sup;

// 悬停说明：把「数据从哪来」「为什么会有多行」「列表里已有的去哪了」一次讲清，不占屏幕空间。
// ⚠️ 必须 computed（组件是常驻实例，只在 active 时显隐）：写成普通字符串会在切换日期后仍显示旧日期。
const hint = computed(() => '把「竞价一字」看板的一字板股票按题材并入下面各题材组（组内原有股票之后），'
  + '带「补」标的行就是补进来的；股票名已在早盘竞价列表里的不再重复列出。'
  + '题材在当日列表里没有对应分组的，收在最下方「未并入」里。'
  + '数据取自竞价一字看板自己的库（' + (currentDate.value || '-') + '），'
  + '与早盘竞价的列表 / 排序互不影响；关掉开关立即恢复原样。');
</script>
