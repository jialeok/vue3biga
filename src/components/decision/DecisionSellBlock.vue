<!--
  DecisionSellBlock.vue — 「决策」看板【卖点】的一个题材分组（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版）：
    第一行：题材名称  ●n（实心红圆点 = 今日题材排名）  数量：n  竞价一字：n  ← 与买点同一行口径
    第二行：卖出理由：题材排…第n名，股票数量n只，该题材…一字涨停，…14:50 / 11:20 卖
    第三行起：序号  股票名称（龙几）  十日涨幅  11:20卖 / 14:50卖
            ⚠️ 题材排第 2 且只有 1 个竞价一字时，同一组里会出现两种时点（龙一 14:50、其余 11:20），
               因此时点是【逐行】渲染的，不是整组一个值。

  [SELL-OPEN 2026-09-29] 卖点再按【今日竞价高低开】细分（用户口径：题材排名太模糊，竞价开得怎么样更准）：
    行尾时点 与 行下方一行提示 都由 Logic 层按该股【今日竞价涨幅】给出：
      · ≤ -3%（深低开）  → 行尾「盯盘 · 10:00 前」 + 提示「10:00 前看反弹，冲高就出、不反弹也出」；
      · -3% ~ 0（小低开）→ 行尾「开盘立刻出」     + 「❗危」警示 + 提示「立刻出，不等反弹」；
      · 0 ~ +3%（小幅高开）→ 行尾「看分时定」     + 提示「10:00 前看分时：向上 11:20 卖，走弱立刻卖」；
      · 其余（≥+3% / 平开 / 缺竞价涨幅）→ 不产提示，行尾回落题材排名时点（11:20卖 / 14:50卖，原规则不变）。
    ⚠️ 命中三档且今天又进买点（【持有 / 加仓】）的行不产提示 —— 它本来就不卖。

  §21：本组件零业务计算 —— 分组 / 排名 / 数量 / 一字数 / 时点 / 理由全部由
  logic/decision/decision-rules.js 算好。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字（今日数据；今日未成组时显示为「—」） -->
    <DecisionTopicHead
      :topic="group.topic"
      :rank="group.topicRank"
      :count="group.count"
      :yizi="group.yiziCount"
    />
    <!-- [COPY 2026-09-29] dcb-selectable：卖出说明文字允许长按选中复制 -->
    <div class="dcb-reason-line dcb-selectable">
      卖出理由：{{ group.reason }}
    </div>
    <div
      v-for="it in group.items"
      :key="it.name"
      class="dcb-row"
    >
      <span class="dcb-seq">{{ it.seq }}</span>
      <span class="dcb-name">{{ it.name }}</span>
      <span
        v-if="it.dragonLabel"
        class="dcb-dragon"
      >{{ it.dragonLabel }}</span>
      <span class="dcb-pct">{{ pctText(it.pct) }}</span>
      <!-- 【三 · 持有 / 加仓】今天又在买点里 → 强势股，不按上面的时点卖（由 Logic 层标记，§21） -->
      <span
        v-if="it.holdTag"
        class="dcb-hold"
      >{{ it.holdTag }}</span>
      <!-- [SELL-OPEN 2026-09-29] 行尾时点：命中竞价高低开三档 → 用 sellHint.timeLabel
           （盯盘 · 10:00 前 / 开盘立刻出 / 看分时定）；未命中 → 仍是题材排名时点（11:20卖 / 14:50卖）。
           tone 只做配色，判断全在 Logic 层（§21）。 -->
      <span
        v-else
        class="dcb-sell-at"
        :class="it.sellHint ? ('tone-' + it.sellHint.tone) : ''"
      >{{ it.sellHint ? it.sellHint.timeLabel : (it.sellAt + '卖') }}</span>
      <!-- [SELL-OPEN 2026-09-29] 卖出节奏提示（按今日竞价高低开细分）：
           深低开 → 盯盘 10:00 前看反弹；小低开 → 开盘立刻出（❗危）；小幅高开 → 看分时。
           文案 / 徽标 / tone 全部由 Logic 层给出，模板零计算（§21）；
           dcb-selectable = 允许长按选中复制（与买点说明同一口径）。 -->
      <div
        v-if="it.sellHint"
        class="dcb-sell-hint dcb-selectable"
        :class="'tone-' + it.sellHint.tone"
      >
        <span
          v-if="it.sellHint.badge"
          class="dcb-sell-badge"
        >{{ it.sellHint.badge }}</span>
        <span class="dcb-sell-hint-text">{{ it.sellHint.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import DecisionTopicHead from './DecisionTopicHead.vue';
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  group: {
    type: Object,
    required: true
  }
});

function pctText(pct) {
  return formatRangePct(pct);
}
</script>
