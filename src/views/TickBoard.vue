<!--
  TickBoard.vue — 「分笔买卖」看板（独立看板，§15 独立业务模块）

  用户口径（2026-10-10 原话）：
    「所以要添加一个独立的看板在决策看板下面给它，名称是，分笔买卖。」
    「新建一个独立组件给它和原来的决策看板相互独立…其它看板不要变。包括决策看板保持不变。」

  定位：挂在【决策看板下面】。它【不改决策看板一行】——只是把决策看板选中的买点 / 卖点股票，
  拿去查「9:30:00~9:31:00 这一分钟的分笔」，按红/绿笔数判开盘强弱，用来复核
  竞价买 / 竞价卖 / 尾盘买 / 尾盘卖 这四个判断。

  分层（§2）：本文件只有模板与调用 ——
      views/TickBoard.vue
        → composables/useTickBoard.js            （UI 状态 + 抓取时机）
        → logic/tick/tick-minute-store.js        （读库 / 抓取编排 / 闸门）
        → logic/tick/tick-minute.js              （快照→一笔一笔、决策行→看板行）
        → logic/decision/decision-collect.js     （买点 / 卖点行 —— 与决策看板同一函数、同一份真相）
        → data/tick-minute.js → Supabase 表 tick_minute_open
        → Edge Function tick-minute-fetch → 猫头鹰 tick_history

  ⛔ 本看板【不复用任何其它看板的组件】：TbbTopicHead / TbbBuyBlock / TbbSellBlock / TbbPenPanel
     都是为它新建的，样式前缀 tick- / tbb- 也是独立的（不蹭 decision- / dcb- 前缀），
     这样任何一边改版都不会悄悄影响另一边。
  ⛔ 数据源【只有】猫头鹰 tick_history；东财逐笔非常不稳定，不做任何兜底（用户明确禁止）。
-->
<template>
  <div
    class="tick-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <div
      class="tick-header"
      @click="toggleExpand"
    >
      <span class="tick-title">分笔买卖</span>
      <span
        v-if="updatedText"
        class="tick-updated"
        title="该日分笔最近一次落库时间"
      >{{ updatedText }}</span>
      <span class="tick-summary">{{ summaryText }}</span>
      <span class="tick-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="tick-body"
    >
      <!-- §10：未就绪 / 失败必须可见，绝不显示成「今天没有信号」的空看板 -->
      <div
        v-if="errorText"
        class="tick-error"
      >
        {{ errorText }}
      </div>
      <!-- 读库 / 抓取的失败原文（单独一块）：
           ① 两者可能同时存在（决策算得出来、但分笔表读不到）；
           ② 这条常带「去执行 db/create_tick_minute_open.sql」「去配 NUMCAT_TICK_API_KEY」
              这类【要用户动手】的指引，混进计算错误里会被淹掉。 -->
      <div
        v-if="fetchError"
        class="tick-error"
      >
        {{ fetchError }}
      </div>
      <div
        v-if="!ready"
        class="tick-empty"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <!-- 上：买点（与决策看板同款先后顺序） -->
        <div class="tick-section">
          <div class="tick-section-title buy">
            买点
          </div>
          <TbbBuyBlock
            v-for="b in buyBlocks"
            :key="'tb-' + (b.topic || '')"
            :block="b"
          />
          <div
            v-if="buyBlocks.length === 0"
            class="tick-empty"
          >
            当日没有成组的题材，无法给出买点
          </div>
        </div>

        <!-- 蚂蚁线分隔（与决策看板同款视觉语言） -->
        <div class="tick-sep" />

        <!-- 下：卖点 -->
        <div class="tick-section">
          <div class="tick-section-title sell">
            卖点
          </div>
          <TbbSellBlock
            v-for="g in sellGroups"
            :key="g.groupKey"
            :group="g"
          />
          <div
            v-if="sellGroups.length === 0"
            class="tick-empty"
          >
            昨日没有打「买」标签的股票，无需卖出
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, provide } from 'vue';
import TbbBuyBlock from '../components/tick/TbbBuyBlock.vue';
import TbbSellBlock from '../components/tick/TbbSellBlock.vue';
import { useTickBoard } from '../composables/useTickBoard.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例上
const board = useTickBoard();

// 把同一份 board 实例下发给【买点 / 卖点】两个块组件（它们用 inject('tickBoard') 取
// penOpenSet / togglePens）——与决策看板 provide('decisionBoard') 同一范式：
// 展开态只有一份（§6 单一真相），子组件不新建状态、不复制一份 board。
// ⚠️ key 名是 'tickBoard'，与决策看板的 'decisionBoard' 【刻意不同】：
//    两个看板同时挂在页面上，同名会互相覆盖（谁后 provide 谁赢）。
provide('tickBoard', board);

const {
  expanded,
  errorText,
  fetchError,
  ready,
  reasonText,
  buyBlocks,
  sellGroups,
  summaryText,
  updatedText,
  toggleExpand
} = board;

// 与早盘竞价 / 涨跌停 / 竞价一字 / 决策看板同款三角（实心 ▲/▼），别再各写一套
const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));

// 与其它看板同款契约（AuctionBoard / LimitBoard / DecisionBoard 都是 defineExpose({ refresh })）
defineExpose({ refresh: board.refresh });
</script>
