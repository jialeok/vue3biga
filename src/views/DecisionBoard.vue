<!--
  DecisionBoard.vue — 「决策」看板（独立看板，§15 独立业务模块）

  定位：放在【早盘竞价看板下面】。它自己不抓数据、不落库，只是把早盘竞价已有的
  题材分组 / 竞价一字 / 十日涨幅 / 昨日龙头名册 / 昨日买卖标签，按用户定的规则
  推演出「今天买什么、昨天买的什么时候卖」。

  分层（§2）：本文件只有模板与调用 ——
      views/DecisionBoard.vue
        → composables/useDecisionBoard.js        （UI 状态 + 重算时机）
        → logic/decision/decision-collect.js     （读内存真相）
        → logic/decision/decision-rules.js       （纯规则，可单测）
        → 复用 logic/auction/* 的既有单一真相（题材分组 / 一字 / 龙头 / 继承剔除）

  ⛔ 本看板【不复用任何其它看板的组件】：DecisionRulesHint / DecisionBuyBlock /
     DecisionSellBlock 都是为它新建的，样式前缀 dcb- 也是独立的（不蹭 auction- 前缀），
     这样任何一边改版都不会悄悄影响另一边。

  后期要加规则：只改 logic/decision/decision-rules.js（规则 + 文案同一处），
  本文件与组件基本不用动。
-->
<template>
  <div
    class="decision-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <div
      class="decision-header"
      @click="toggleExpand"
    >
      <span class="decision-title">决策</span>
      <DecisionRulesHint :lines="rulesLines" />
      <span class="decision-summary">{{ summaryText }}</span>
      <span class="decision-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="decision-body"
    >
      <!-- §10：未就绪 / 失败必须可见，绝不显示成「今天没有信号」的空看板 -->
      <div
        v-if="errorText"
        class="decision-error"
      >
        {{ errorText }}
      </div>
      <div
        v-if="!ready"
        class="decision-empty"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <!-- 上：买点 -->
        <div class="decision-section">
          <div class="decision-section-title buy">
            买点
          </div>
          <DecisionBuyBlock
            v-if="buyHeavy"
            :block="buyHeavy"
          />
          <DecisionBuyBlock
            v-if="buyLight"
            :block="buyLight"
          />
          <div
            v-if="!buyHeavy && !buyLight"
            class="decision-empty"
          >
            当日没有成组的题材，无法给出买点
          </div>
        </div>

        <!-- 蚂蚁线分隔（与早盘竞价观察组同款视觉语言） -->
        <div class="decision-sep" />

        <!-- 下：卖点 -->
        <div class="decision-section">
          <div class="decision-section-title sell">
            卖点
          </div>
          <DecisionSellBlock
            v-for="g in sellGroups"
            :key="g.groupKey"
            :group="g"
          />
          <div
            v-if="sellGroups.length === 0"
            class="decision-empty"
          >
            昨日没有打「买」标签的股票，无需卖出
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import DecisionRulesHint from '../components/decision/DecisionRulesHint.vue';
import DecisionBuyBlock from '../components/decision/DecisionBuyBlock.vue';
import DecisionSellBlock from '../components/decision/DecisionSellBlock.vue';
import { useDecisionBoard } from '../composables/useDecisionBoard.js';
import { buildRulesLines } from '../logic/decision/decision-rules.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例上
const board = useDecisionBoard();
const {
  expanded,
  errorText,
  ready,
  reasonText,
  buyHeavy,
  buyLight,
  sellGroups,
  summaryText,
  toggleExpand
} = board;

// 规则文案由 Logic 层产出（规则实现与规则说明同处一处，改规则不会只改一半）
const rulesLines = buildRulesLines();
// 与早盘竞价 / 涨跌停 / 竞价一字同款三角（实心 ▲/▼），别再各写一套
const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));

// 与其它看板同款契约（AuctionBoard / LimitBoard 都是 defineExpose({ refresh })）
defineExpose({ refresh: board.refresh });
</script>
