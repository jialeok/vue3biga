<!--
  AuctionYiziSupplementPanel.vue — 「补竞价一字」补充区容器（独立组件，§15）

  位置：AuctionBoardTable.vue 列表末尾（用户原话「补充到下面股票列表中」）。
  内容：题材条（【题材】N只）+ 行；行格式与「竞价一字」看板逐字段对齐（股票 / 时点 / 龙头 / 连板 / 题材 / 封单额 + 十日涨幅），
        点序号可展开 4 张趋势图。

  🔴 边界（用户明确要求）：
    · 只是显示层 —— 本组件 ⛔ 不改早盘竞价的任何行、排序、高光、数据；
    · 数据全部来自「竞价一字」看板自己的真相（含它自己的猫抓小号趋势通道），与早盘竞价相互独立；
    · 只在「题材 toggle 开着 + 补竞价一字开关打开」时渲染；关掉开关立刻消失（恢复原样）。

  ⚠️ 题材条上的只数是【该题材一字总只数】，不是「下面对了几行」：
     已在早盘竞价列表里的那一字不再重复列出（用户要求「补充的股票不是列表中的股票」），
     差额在题材条上如实标注 —— 否则用户会把「被排除掉的那几只」误读成「这个题材一字少」。
-->
<template>
  <div
    v-if="active"
    class="auction-yizi-sup"
  >
    <div class="auction-yizi-sup-head">
      <span class="auction-yizi-sup-title">竞价一字补充</span>
      <span class="auction-yizi-sup-summary">{{ summaryText }}</span>
    </div>
    <div class="auction-yizi-sup-note">
      取自「竞价一字」看板自己的库（{{ currentDate || '-' }}），与早盘竞价的列表 / 排序相互独立；
      题材条上的只数 = 该题材的<b>一字总只数</b>（已在早盘竞价列表里的不再重复列出）。
    </div>

    <!-- 状态优先级：读失败（§10 必须可见，可重试）→ 加载中 / 空态 → 内容 -->
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

    <template v-else>
      <!-- 列图例：与下面的行一一对应；「#」= 该题材内十日涨幅排名（跳号 = 中间几只已在早盘竞价列表里） -->
      <div class="auction-yizi-sup-legend">
        <span class="auction-yizi-sup-legend-seq">#</span>
        <span class="auction-yizi-sup-legend-name">股票 / 时点 / 连板</span>
        <span class="auction-yizi-sup-legend-topics">题材（全部，逗号分隔）</span>
        <span class="auction-yizi-sup-legend-metric">封单额(9:20) · 十日涨幅</span>
      </div>

      <div
        v-for="g in groups"
        :key="g.topic"
        class="auction-yizi-sup-group"
      >
        <div class="auction-yizi-sup-bar">
          <span class="auction-yizi-sup-topic-name">【{{ g.topic }}】</span>
          <span class="auction-yizi-sup-topic-count">{{ g.totalCount }}只</span>
          <span
            v-if="inListText(g)"
            class="auction-yizi-sup-topic-inlist"
          >{{ inListText(g) }}</span>
        </div>
        <AuctionYiziSupplementRow
          v-for="s in g.stocks"
          :key="g.topic + '-' + s.stock"
          :stock="s"
        />
        <div
          v-if="g.count === 0"
          class="auction-yizi-sup-empty-inline"
        >
          该题材的一字都已在早盘竞价列表中（不再重复列出）
        </div>
      </div>

      <div
        v-if="trendErrorText"
        class="auction-yizi-sup-error"
      >
        {{ trendErrorText }}
      </div>
      <div
        v-else-if="trendNoteText"
        class="auction-yizi-sup-trend-note"
      >
        {{ trendNoteText }}
      </div>
    </template>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import AuctionYiziSupplementRow from './AuctionYiziSupplementRow.vue';

const sup = inject('auctionYiziSupplement');
const {
  active, loading, errorText, emptyText, retry,
  summaryText, inListText, groups, currentDate,
  trendErrorText, trendNoteText
} = sup;
</script>
