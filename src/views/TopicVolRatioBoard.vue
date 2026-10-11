<!--
  TopicVolRatioBoard.vue — 「题材量比」看板（独立看板，§15 独立业务模块）

  定位：挂在【决策看板附近】。它自己不抓数据、不落库，只是把早盘竞价已有的
  题材分组 / 竞价一字 / 十日涨幅 / 竞价量比，按用户定的规则选出「今天买什么」，
  并按决策看板的同一套规则给出【买点标签 + 卖点段】。

  用户口径（2026-10-11 两轮原话）：
    【第一轮】「帮我再做一个看板，名称是题材量比……要独立组件，有规则文字说明和决策看板一样。
      按照规范实现。不要动其它看板和功能。只新增这个题材量比看板。」
    【第二轮】「你完善下，题材量比看板，把标题栏的渐变色改下，颜色变成渐变粉色（股市忌讳绿色），
      要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙等
      所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。
      把股票下方点击展开的量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，包括图上文字），
      当然我说的标签你要模仿决策看板的，不是模仿分笔买卖看板的（只是模仿它那个展开后的分笔成交图）。」

  分层（§2）：本文件只有模板与调用 ——
      views/TopicVolRatioBoard.vue
        → composables/useTopicVolRatioBoard.js   （UI 状态 + 重算 / 取数时机）
        → logic/decision/decision-collect.js     （读内存真相：题材块 + 龙位名册 + 买卖点标签上下文）
        → logic/topicvolratio/topic-vol-ratio-rules.js（本看板的选股 + 标签收口，纯规则，可单测）
        → logic/tick/tick-minute-store.js / tick-minute.js（分笔明细取数与逐行组装）

  ★ 关于「独立」（2026-10-11 第二轮的口径修正）：
    · 【组件】本看板有自己的 TvrbRulesHint / TvrbTopicHead / TvrbBuyBlock / TvrbSellBlock，
      样式前缀 tvrb- 也是独立的（⛔ 不蹭 decision- / dcb- / tick- / tbb-），UI 改版互不影响。
    · 【业务实现】一律复用别人的同一份（§6 单一真相）——用户要的就是「标签逻辑基本一样」：
      买点标签 = decision-rules#finishBuyBlock、卖点 = decision-rules#buildSellPlan、
      展开面板 = components/tick/TbbPenPanel.vue + logic/tick/tick-minute.js。
      ⛔ 各写一份「看起来一样」的实现是**最坏**的选择：第一次能对上，第一次改规则就分叉。
    · 唯一的例外是那个分笔面板组件：它是纯展示组件（零业务 / 零状态 / 零请求），
      复用才【保证】两处逐字一致（用户原话「包括图上文字」）。
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
      <!-- 分笔读库 / 抓取的失败原文（单独一块）：分笔只是【展开面板】的数据，
           拿不到不影响选股与标签 —— 所以它单独显示，不冒充「计算失败」。 -->
      <div
        v-if="fetchError"
        class="tvrb-error tvrb-selectable"
      >
        {{ fetchError }}
      </div>
      <div
        v-if="!ready"
        class="tvrb-empty tvrb-selectable"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <!-- 上：选股（本看板自己的选股口径）—— 行内标签与决策看板买点段完全同一套 -->
        <div class="tvrb-section">
          <div class="tvrb-section-title buy">
            选股
          </div>
          <TvrbBuyBlock
            v-for="b in blocks"
            :key="'tvrb-buy-' + b.topic"
            :block="b"
          />
          <div
            v-if="blocks.length === 0"
            class="tvrb-empty tvrb-selectable"
          >
            当日没有满足条件的题材（题材数量 ≥ 4 只）
          </div>
        </div>

        <!-- 蚂蚁线分隔（与决策看板同款视觉语言） -->
        <div class="tvrb-sep" />

        <!-- 下：卖点（与决策看板卖点段同一份实现；候选 = 昨日打过「买」标签的股票） -->
        <div class="tvrb-section">
          <div class="tvrb-section-title sell">
            卖点
          </div>
          <TvrbSellBlock
            v-for="g in sellGroups"
            :key="'tvrb-sell-' + g.groupKey"
            :group="g"
          />
          <div
            v-if="sellGroups.length === 0"
            class="tvrb-empty tvrb-selectable"
          >
            昨日没有打「买」标签的股票，无需卖出
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
import TvrbSellBlock from '../components/topicvolratio/TvrbSellBlock.vue';
import { useTopicVolRatioBoard } from '../composables/useTopicVolRatioBoard.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例上
const board = useTopicVolRatioBoard();

// 把同一份 board 实例下发给【选股块 / 卖点块】两个组件（它们用 inject('topicVolRatioBoard') 取
//   penOpenSet / togglePens）——与决策看板 provide('decisionBoard') 同一范式：
//   展开态只有一份（§6 单一真相），子组件不新建状态、不复制一份 board。
provide('topicVolRatioBoard', board);

const {
  expanded,
  rulesOpen,
  compactOpen,
  errorText,
  fetchError,
  ready,
  reasonText,
  blocks,
  sellGroups,
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
