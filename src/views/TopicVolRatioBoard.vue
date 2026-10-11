<!--
  TopicVolRatioBoard.vue — 「题材量比」看板（独立看板，§15 独立业务模块）

  定位：挂在【决策看板附近】。它自己不抓数据、不落库，只是把早盘竞价已有的
  题材分组 / 竞价一字 / 十日涨幅 / 竞价量比，按用户定的规则选出「今天买什么」。

  用户口径（2026-10-11 原话）：
    「帮我再做一个看板，名称是题材量比，这个看板也是用来选股的，功能和布局设计和决策看板差不多。
     只是选股逻辑不一样。……要独立组件，有规则文字说明和决策看板一样。按照规范实现。
     不要动其它看板和功能。只新增这个题材量比看板。」

  分层（§2）：本文件只有模板与调用 ——
      views/TopicVolRatioBoard.vue
        → composables/useTopicVolRatioBoard.js   （UI 状态 + 重算时机）
        → logic/decision/decision-collect.js     （读内存真相：题材块 + 龙位名册，与决策看板同一函数）
        → logic/topicvolratio/topic-vol-ratio-rules.js（纯规则，可单测）
        → 复用 logic/decision/decision-rules.js 的题材排名 / 龙位 / 候选序列（§6 单一真相）

  ⛔ 本看板【不复用任何其它看板的组件】：TvrbRulesHint / TvrbTopicHead / TvrbBuyBlock 都是为它新建的，
     样式前缀 tvrb- 也是独立的（⛔ 不蹭 decision- / dcb- / tick- / tbb-），
     这样任何一边改版都不会悄悄影响另一边。

  ⚠️ 本看板【只有选股】，没有卖点段：用户本轮只描述了「选什么股」。
     买卖时机（竞价买 / 尾盘买 / 竞价卖 / 尾盘卖 …）请看【决策】看板（规则面板最后一条已写明）。

  后期要加规则：只改 logic/topicvolratio/topic-vol-ratio-rules.js（规则 + 文案同一处），
  本文件与组件基本不用动。
-->
<template>
  <div
    class="tvrb-board trading-day-element"
    :class="{ minimized: !expanded, 'tvrb-compact': compactOpen }"
  >
    <div
      class="tvrb-header"
      @click="toggleExpand"
    >
      <span class="tvrb-title">题材量比</span>
      <TvrbRulesHint
        :lines="rulesLines"
        :open="rulesOpen"
        @update:open="setRulesOpen"
      />
      <span class="tvrb-summary">{{ summaryText }}</span>
      <span class="tvrb-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="tvrb-body"
    >
      <!-- 「简洁」开关：置内容区顶部（与决策看板同一位置口径）。
           打开后只留【题材行 + 股票行 + 行内标签】，隐藏解释性文字 —— 实际隐藏全在
           topic-vol-ratio-board.css 的 .tvrb-compact 里，模板不加 v-if 分支。默认打开。 -->
      <div class="tvrb-compact-bar">
        <span
          class="tvrb-compact-toggle"
          :class="{ on: compactOpen }"
          @click="toggleCompact"
        >简洁</span>
      </div>
      <!-- §10：未就绪 / 失败必须可见，绝不显示成「今天没有入选股票」的空看板 -->
      <div
        v-if="errorText"
        class="tvrb-error tvrb-selectable"
      >
        {{ errorText }}
      </div>
      <div
        v-if="!ready"
        class="tvrb-empty tvrb-selectable"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <div class="tvrb-section">
          <div class="tvrb-section-title buy">
            选股
          </div>
          <TvrbBuyBlock
            v-for="b in blocks"
            :key="'tvrb-' + b.topic"
            :block="b"
          />
          <div
            v-if="blocks.length === 0"
            class="tvrb-empty tvrb-selectable"
          >
            当日没有满足条件的题材（题材数量 ≥ 4 只）
          </div>
        </div>
        <!-- 看板级说明：被排除的题材（数量不足 / 不足两个题材）—— 圈起来 + 浅底色 -->
        <div
          v-for="(n, i) in notes"
          :key="'g-note-' + i"
          class="tvrb-block-note tvrb-note-box tvrb-selectable"
        >
          {{ n }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, provide } from 'vue';
import TvrbRulesHint from '../components/topicvolratio/TvrbRulesHint.vue';
import TvrbBuyBlock from '../components/topicvolratio/TvrbBuyBlock.vue';
import { useTopicVolRatioBoard } from '../composables/useTopicVolRatioBoard.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例上
const board = useTopicVolRatioBoard();

// 把同一份 board 实例下发给【选股块】组件（它用 inject('topicVolRatioBoard') 取 trendOpenSet /
//   toggleTrend）——与决策看板 provide('decisionBoard') 同一范式：
//   展开态只有一份（§6 单一真相），子组件不新建状态、不复制一份 board。
provide('topicVolRatioBoard', board);

const {
  expanded,
  rulesOpen,
  compactOpen,
  errorText,
  ready,
  reasonText,
  blocks,
  notes,
  summaryText,
  rulesLines,
  toggleExpand,
  toggleCompact,
  setRulesOpen
} = board;

// 与早盘竞价 / 涨跌停 / 决策 / 分笔同款三角（实心 ▲/▼），别再各写一套
const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));

// 与其它看板同款契约（AuctionBoard / LimitBoard / DecisionBoard 都是 defineExpose({ refresh })）
defineExpose({ refresh: board.refresh });
</script>
