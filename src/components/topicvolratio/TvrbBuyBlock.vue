<!--
  TvrbBuyBlock.vue — 「题材量比」看板【选股】的一个题材块（独立组件，⛔ 不复用其它看板组件）

  排版：
    第一行：题材名称 ●排名  数量：n  竞价一字：n  平均量比：x.xx  [选 n 只]
    第二行：选择理由：按【平均竞价量比 x】排第 k，股票数量 n 只（4~8 只）⇒ 取 1 只；按【龙一 → 龙二 → …】……
    第三行起：序号  股票名称  （龙几）  十日涨幅  竞价涨幅（红底/绿底/灰底小徽标）
              竞价量比（小徽标，右侧 ↑/↓ = 与上一交易日相比的方向，增强红底 / 下降绿底）
    行下方：  点【序号】或【股票名】展开 / 收起「竞价量比 近 5 日」趋势面板
    块末尾：  本题材的说明（为什么顺延 / 为什么少取）—— 圈起来 + 浅底色，与决策看板同款

  §21：本组件零业务计算 —— 排名 / 数量 / 平均量比 / 选几只 / 理由 / 序号 / 龙几 / 涨幅 / 量比
  全部由 logic/topicvolratio/topic-vol-ratio-rules.js 预先算好，模板只做 v-for 渲染。
-->
<template>
  <div class="tvrb-block">
    <!-- 第一行：题材头 -->
    <TvrbTopicHead
      :topic="block.topic"
      :rank="block.rank"
      :count="block.count"
      :yizi="block.yiziCount"
      :avg-vol-ratio="block.avgVolRatioText"
      :pick-count="block.pickCount"
    />
    <!-- 第二行：选择理由（文案由 Logic 层给，§21 模板零计算） -->
    <div class="tvrb-reason-line tvrb-selectable">
      选择理由：{{ block.reason }}
    </div>
    <!-- 第三行起：入选的股票（已按龙位从高到低、已剔除竞价涨停的龙位）
         点【序号】或【股票名】展开 / 收起该股的「竞价量比 近 5 日」趋势面板（纯 UI 态）。 -->
    <template
      v-for="p in block.picks"
      :key="p.name"
    >
      <div class="tvrb-row">
        <span
          class="tvrb-seq tvrb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(p.name)"
        >{{ p.seq }}</span>
        <span
          class="tvrb-name tvrb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(p.name)"
        >{{ p.name }}</span>
        <span
          v-if="p.dragonLabel"
          class="tvrb-dragon"
        >{{ p.dragonLabel }}</span>
        <span class="tvrb-pct">{{ p.pctText }}</span>
        <!-- 竞价涨幅徽标：与决策看板完全同款（同一个 formatAucPct + getAucOpenKind，§6）。
             缺竞价涨幅 ⇒ aucPctText 为空串 ⇒ 整个徽标不渲染（§10 绝不用灰底伪装成「平开」）。 -->
        <span
          v-if="p.aucPctText"
          class="tvrb-auc"
          :class="'tvrb-auc-' + p.aucTone"
        >{{ p.aucPctText }}</span>
        <!-- 竞价量比徽标：紧跟在【竞价涨幅】右边；带 ↑/↓ 表示与上一交易日相比的方向。
             缺当日量比 ⇒ 空串 ⇒ 整个徽标不渲染（§10 绝不用 0.00 冒充「量比很小」）。 -->
        <span
          v-if="p.volRatioText"
          class="tvrb-vratio"
          :class="p.volRatioTone ? ('tvrb-vratio-' + p.volRatioTone) : ''"
          title="竞价量比（当日值）｜箭头 = 与上一交易日相比的方向"
        >{{ p.volRatioText }}<span
          v-if="p.volRatioArrow"
          class="tvrb-vratio-arrow"
        >{{ p.volRatioArrow }}</span></span>
      </div>
      <!-- 竞价量比 近 5 个交易日趋势（收起态不挂载；点序号 / 股票名才展开）。
           曲线复用 TrendChart（纯声明式 SVG，与早盘竞价趋势图同一套视觉）；
           ⛔ 一整条都没有有效点时不画满屏「--」，改画一行说明（§10 缺失要如实可见）。 -->
      <div
        v-if="trendOpenSet.has(p.name)"
        class="tvrb-trend-panel"
      >
        <div class="tvrb-trend-label">
          竞价量比 近5日
        </div>
        <TrendChart
          v-if="p.volRatioHasData"
          :points="p.volRatioTrend"
          color="#6366f1"
          :decimals="2"
        />
        <div
          v-else
          class="tvrb-trend-empty"
        >
          竞价量比：近 5 个交易日均无数据
        </div>
      </div>
    </template>
    <!-- 本题材的说明（顺延 / 少取 / 档位）—— 圈起来 + 浅底色，与决策看板同款（§10 缺失必须可见）。 -->
    <div
      v-for="(n, i) in block.notes"
      :key="'note-' + i"
      class="tvrb-block-note tvrb-note-box tvrb-selectable"
    >
      {{ n }}
    </div>
    <!-- 未选出任何票：如实说明（§10 不拿空壳冒充结论）
         tvrb-note-empty = 【简洁】模式下仍保留（它说明「这一块为什么没有股票」）。 -->
    <div
      v-if="!block.qualified"
      class="tvrb-block-note tvrb-note-box unqualified tvrb-note-empty tvrb-selectable"
    >
      该题材没有可买入（非竞价涨停）的股票
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import TvrbTopicHead from './TvrbTopicHead.vue';
// 曲线组件复用既有 TrendChart（纯声明式 SVG：无图表实例、无 dispose 生命周期问题）。
import TrendChart from '../TrendChart.vue';

defineProps({
  block: {
    type: Object,
    required: true
  }
});

// 与 TopicVolRatioBoard.vue 共用同一个 board 实例（provide / inject）：
//   展开态只有一份，本组件不新建状态、不复制一份 board（§6 单一真相 / §34）。
const board = inject('topicVolRatioBoard');
const { trendOpenSet, toggleTrend } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const trendTip = '点击展开 / 收起「竞价量比」近 5 日走势';
</script>
