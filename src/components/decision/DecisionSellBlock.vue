<!--
  DecisionSellBlock.vue — 「决策」看板【卖点】的一个题材分组（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版）：
    第一行：题材名称  ●n（实心红圆点 = 今日题材排名）  数量：n  竞价一字：n  ← 与买点同一行口径
    第二行：卖出理由：题材排…第n名，股票数量n只，该题材…一字涨停，…14:50 / 11:20 卖
    第三行起：序号  股票名称（龙几）  十日涨幅  竞价涨幅  竞价量比  11:20卖 / 14:50卖
    行下方：  [VRATIO-TREND 2026-10-01 用户口径] 点【序号】或【股票名】展开 / 收起
              「竞价量比 近 5 日」趋势面板（默认收起，样式与早盘竞价看板的趋势图一致）
            ⚠️ [AUC-BADGE 2026-09-29] 「竞价涨幅」是紧跟在十日涨幅后面的小标签：
               涨（> 0）红底 / 跌（< 0）绿底 / 平（= 0）灰底；该股缺竞价涨幅则【不渲染】（§10）；
               文本与配色档全部来自 Logic 层（aucPctText / aucTone），模板零计算（§21）。
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
    <!-- ⚠️ [PREV-BOUGHT 2026-09-30 用户口径] 这一块【不显示】「昨天已买」标记 ——
         卖点候选本来就是「昨天打过买标签的股票」，挨个标等于全标，没有信息量（用户明确要求去掉）。 -->
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
    <!-- [VRATIO-TREND 2026-10-01 用户口径] 点【序号】或【股票名】展开 / 收起该股的
         「竞价量比 近 5 日」趋势面板（面板紧跟在本行下方，样式与早盘竞价看板的趋势图一致）。
         展开态与【买点】共用同一份 trendOpenSet（同一只票两处是同一个开关，见 useDecisionBoard）。 -->
    <template
      v-for="it in group.items"
      :key="it.name"
    >
      <div class="dcb-row">
        <span
          class="dcb-seq dcb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(it.name)"
        >{{ it.seq }}</span>
        <span
          class="dcb-name dcb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(it.name)"
        >{{ it.name }}</span>
        <span
          v-if="it.dragonLabel"
          class="dcb-dragon"
        >{{ it.dragonLabel }}</span>
        <span class="dcb-pct">{{ pctText(it.pct) }}</span>
        <!-- [AUC-BADGE 2026-09-29 用户口径] 竞价涨幅标签：紧跟在十日涨幅后面。
             文本 / 配色档全部由 Logic 层给（aucPctText / aucTone，§21 模板零计算）：
             竞价涨幅 > 0 红底、< 0 绿底、= 0 灰底；缺竞价涨幅时 Logic 给空串 ⇒ 这里不渲染（§10）。
             ⛔ 类名必须带 dcb-auc- 前缀：CSS 是全局的，tone-up / tone-flat 这类通用名会串改其它看板。 -->
        <span
          v-if="it.aucPctText"
          class="dcb-auc"
          :class="'dcb-auc-' + it.aucTone"
        >{{ it.aucPctText }}</span>
        <!-- [VRATIO-TREND 2026-10-01 用户口径] 竞价量比数值：紧跟在【竞价涨幅】右边（与买点同款同位置）。
             文案由 Logic 层给（volRatioText）；缺当日量比 ⇒ 空串 ⇒ 整个徽标不渲染（§10 不补 0.00）。 -->
        <span
          v-if="it.volRatioText"
          class="dcb-vratio"
          title="竞价量比（当日值；与早盘竞价看板趋势图里那行小字同一字段）"
        >{{ it.volRatioText }}</span>
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
      <!-- [VRATIO-TREND 2026-10-01] 竞价量比 近 5 个交易日趋势（默认收起，点序号 / 股票名才展开）。
           曲线组件复用 TrendChart（与早盘竞价趋势图同一套视觉）；
           ⛔ 整条都没有有效点时不画满屏「--」，改画一行说明（§10 缺失要如实可见）。 -->
      <div
        v-if="trendOpenSet.has(it.name)"
        class="dcb-trend-panel"
      >
        <div class="dcb-trend-label">
          竞价量比 近5日
        </div>
        <TrendChart
          v-if="it.volRatioHasData"
          :points="it.volRatioTrend"
          color="#6366f1"
          :decimals="2"
        />
        <div
          v-else
          class="dcb-trend-empty"
        >
          竞价量比：近 5 个交易日均无数据
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import DecisionTopicHead from './DecisionTopicHead.vue';
// [VRATIO-TREND 2026-10-01] 曲线组件复用既有 TrendChart（纯声明式 SVG：无图表实例、无 dispose 问题）。
import TrendChart from '../TrendChart.vue';
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  group: {
    type: Object,
    required: true
  }
});

// [VRATIO-TREND 2026-10-01] 与 DecisionBoard.vue 共用同一个 board 实例（provide / inject）：
//   展开态只有一份、且与【买点】共用 —— 同一只票在两处是同一个开关，本组件不新建状态（§6 / §34）。
const board = inject('decisionBoard');
const { trendOpenSet, toggleTrend } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const trendTip = '点击展开 / 收起「竞价量比」近 5 日走势';

function pctText(pct) {
  return formatRangePct(pct);
}
</script>
