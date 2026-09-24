<!--
  LadderBoard.vue — 「连板天梯晋级」看板（独立看板，§15 独立业务模块）

  位置：涨跌停看板【下面】、竞价一字看板【上面】（DashboardView 里挂载）。

  做什么：把早盘竞价 9:25 自动抓到的股票里【二板及以上】的挑出来，按连板数分档整理，
          每行给「高开/低开/平开 + 十日涨幅 + 题材 + 晋级成功/失败」，点序号或股票名展开趋势图。

  ⛔ 数据全部【照搬早盘竞价】，不发请求、不落库、不消费猫抓额度（用户明确要求）：
      早盘 9:25 那批数据 → 收盘覆盖涨幅后同一批数据自动变成真实收盘值 → 晋级成败随之翻转。
      因此本看板只是【显示层】：跟着早盘竞价走就能同步，不需要单独抓取任何东西。

  分层（§2）：本文件只有模板与调用 ——
      views/LadderBoard.vue
        → composables/useLadderBoard.js        （UI 状态 + 重算时机）
        → logic/ladder/ladder-collect.js       （读内存真相）
        → logic/ladder/ladder-rules.js         （纯规则，可单测）
        → 复用 logic/auction/* 的既有单一真相（连板 / 竞价涨幅 / 一字 / 收盘停板 / 十日涨幅 / 题材）

  ⛔ 本看板不复用任何其它看板的组件：LadderGroup / LadderRow 都是为它新建的，
     样式前缀 lad- 也是独立的。唯一复用的 TrendChart 是全站通用图表基元
     （src/components/TrendChart.vue，不属于任何看板），不重新造一个图表轮子。
-->
<template>
  <div
    class="ladder-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <div
      class="ladder-header"
      @click="toggleExpand"
    >
      <span class="ladder-title">连板天梯晋级</span>
      <span class="ladder-summary">{{ summaryText }}</span>
      <span class="ladder-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="ladder-body"
    >
      <!-- §10：未就绪 / 失败必须可见，绝不显示成「今天没有连板股」的空看板 -->
      <div
        v-if="errorText"
        class="ladder-error"
      >
        {{ errorText }}
      </div>
      <div
        v-if="!ready"
        class="ladder-empty"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <!-- 收盘口径未成立时的状态说明：否则用户会以为「待定」是坏掉了 -->
        <div
          v-if="!closeReady"
          class="ladder-note"
        >
          早盘阶段：竞价一字先算晋级成功，其余等收盘覆盖涨幅后再定成败（显示「待定」）
        </div>

        <LadderGroup
          v-for="g in groups"
          :key="g.streak"
          :group="g"
          :expanded-set="expandedSet"
          :trend-history="trendHistory"
          @toggle="toggleTrend"
        />

        <div
          v-if="groups.length === 0"
          class="ladder-empty"
        >
          当日没有二板及以上的股票
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import LadderGroup from '../components/ladder/LadderGroup.vue';
import { useLadderBoard } from '../composables/useLadderBoard.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例
const board = useLadderBoard();
const {
  expanded,
  expandedSet,
  trendHistory,
  errorText,
  ready,
  reasonText,
  groups,
  closeReady,
  summaryText,
  toggleExpand,
  toggleTrend
} = board;

const toggleArrow = computed(() => (expanded.value ? '▾' : '▸'));

// 与其它看板同款契约（AuctionBoard / LimitBoard / DecisionBoard 都是 defineExpose({ refresh })）
defineExpose({ refresh: board.refresh });
</script>
