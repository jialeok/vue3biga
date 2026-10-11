<!--
  TvrbSellBlock.vue — 「题材量比」看板【卖点】的一个题材分组

  用户口径（2026-10-11 第二轮原话）：
    「要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙等
      所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。」

  ⇒ 「卖出」这一段的逻辑【就是决策看板卖点段那一个函数】（decision-rules#buildSellPlan）：
      候选 = 上一交易日打过「买」标签的股票（与决策看板同一份数据源）；
      动作 = 竞价涨停卖 / 竞价卖 / 竞价卖（先卖后买）/ 尾盘卖 / 10分钟时卖 / 跟龙竞价卖 / 持有。
    唯一的差别（本看板内部自洽所需）：「今天又进买点 ⇒ 持有」用的是
      【本看板自己选出来的买点名单】，而不是决策看板的买点名单。

  行内标签（与 DecisionSellBlock 逐枚对齐）：
    序号 股票名称 （龙几 ±n） 十日涨幅 竞价涨幅 竞价量比 连板 封单额 占比
    [卖点动作标签] / [先卖后买] / [持有] / 行尾时点（11:20卖 / 14:50卖 …）
    + 逐行说明文字 + 卖出节奏提示

  ⛔ 刻意【没有】的东西（与决策看板卖点段一致 / 与本看板定位一致）：
    · 竞价图形判断选择器（ChartJudgeSelect）—— 那是决策看板的手动覆盖入口（要写库），
      本看板不引入任何写库行为；
    · 题材行的【昨有买入 / N 次入选】标记 —— 卖点候选本来就是「昨天买过的票」，标了没有信息量
      （与 DecisionSellBlock 的口径一致）。

  展开面板：分笔明细（与买点侧、与分笔买卖看板都是同一个组件、同一段文字）。

  §21：本组件零业务计算，全部读 Logic 层预计算好的字段。
-->
<template>
  <div class="tvrb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字 + 平均竞价量比（今日数据；今日未成组时显示「—」）
         ★ 平均量比：买点侧一直有（block.avgVolRatioText）；卖点侧原先漏传 ⇒ 只显示「—」（用户 2026-10-11
           报障「题材的平均量比数值没有显示出来，只出现 -」）。值由 buildTopicVolRatioPlan 按 g.topic
           反查同一个题材块算出（⛔ 不是第二份实现）；该题材今天没成组 ⇒ 如实给「—」（§10 不编数）。 -->
    <TvrbTopicHead
      :topic="group.topic"
      :rank="group.topicRank"
      :count="group.count"
      :yizi="group.yiziCount"
      :avg-vol-ratio="group.avgVolRatioText"
    />
    <!-- 第二行：卖出理由（决策看板同一份文案，由 buildSellPlan 生成） -->
    <div class="tvrb-reason-line tvrb-selectable">
      卖出理由：{{ group.reason }}
    </div>
    <template
      v-for="it in group.items"
      :key="it.name"
    >
      <div class="tvrb-row">
        <span
          class="tvrb-seq tvrb-pen-trigger"
          :title="penTip"
          @click.stop="togglePens(it.name)"
        >{{ it.seq }}</span>
        <span
          class="tvrb-name tvrb-pen-trigger"
          :title="penTip"
          @click.stop="togglePens(it.name)"
        >{{ it.name }}</span>
        <span
          v-if="it.riskTag"
          class="tvrb-risk"
          title="20% 涨跌幅板（创业板 300/301、科创板 688/689）：这类票多为短线套利、波动大最容易吃亏 —— 风险极高，谨慎买入"
        >{{ it.riskTag }}</span>
        <span
          v-if="it.dragonLabel"
          class="tvrb-dragon"
        >{{ it.dragonLabel }}</span>
        <!-- 龙标旁边的名次变化（'+3' 上升红 / '-2' 下降绿；无可比 ⇒ 不渲染，§10） -->
        <span
          v-if="it.dragonDeltaText"
          class="tvrb-dragon-delta"
          :class="'tvrb-dragon-delta-' + it.dragonDeltaTone"
          :title="it.dragonDeltaTitle"
        >{{ it.dragonDeltaText }}</span>
        <span class="tvrb-pct">{{ it.pctText }}</span>
        <span
          v-if="it.aucPctText"
          class="tvrb-auc"
          :class="'tvrb-auc-' + it.aucTone"
        >{{ it.aucPctText }}</span>
        <span
          v-if="it.volRatioText"
          class="tvrb-vratio"
          :class="it.volRatioTone ? ('tvrb-vratio-' + it.volRatioTone) : ''"
          title="竞价量比（当日值）｜箭头 = 与上一交易日相比的方向"
        >{{ it.volRatioText }}<span
          v-if="it.volRatioArrow"
          class="tvrb-vratio-arrow"
        >{{ it.volRatioArrow }}</span></span>
        <span
          v-if="it.sealContinueTag"
          class="tvrb-continue"
          title="连板天数（来自涨停池 continue_day_cnt；首板不显示本标签）"
        >{{ it.sealContinueTag }}</span>
        <span
          v-if="it.sealMoneyText"
          class="tvrb-seal"
          :class="it.sealDeltaTone ? ('tvrb-seal-' + it.sealDeltaTone) : ''"
          :title="it.sealDeltaTitle"
        >封单 {{ it.sealMoneyText }}<span
          v-if="it.sealDeltaText"
          class="tvrb-seal-delta"
        >{{ it.sealDeltaArrow }}{{ it.sealDeltaText }}</span></span>
        <span
          v-if="it.aucShareText"
          class="tvrb-share"
          :class="it.aucShareTone ? ('tvrb-share-' + it.aucShareTone) : ''"
          title="竞价占比 = 当日竞价量 ÷ 昨日成交量（卖点主判据：达标 → 尾盘卖；不达标 → 竞价卖；今天又进买点另算）"
        >占比 {{ it.aucShareText }}</span>
        <!-- 行尾【卖点动作】（优先级由 Logic 层定，⛔ 组件不做任何比较）：
             竞价涨停卖 / 竞价卖 / 竞价卖（先卖后买）/ 尾盘卖 / 10分钟时卖 / 跟龙竞价卖；
             占比缺数据时才轮到 buyActionTag（先卖后买）/ holdTag（持有）/ 题材排名时点。 -->
        <span
          v-if="it.sellActionTag"
          class="tvrb-action"
          :class="'tvrb-action-' + it.sellActionTone"
        >{{ it.sellActionTag }}</span>
        <span
          v-else-if="it.buyActionTag"
          class="tvrb-action"
          :class="'tvrb-action-' + it.buyActionTone"
        >{{ it.buyActionTag }}</span>
        <span
          v-else-if="it.holdTag"
          class="tvrb-hold"
        >{{ it.holdTag }}</span>
        <span
          v-else
          class="tvrb-sell-at"
          :class="it.sellHint ? ('tvrb-tone-' + it.sellHint.tone) : ''"
        >{{ it.sellHint ? it.sellHint.timeLabel : (it.sellAt + '卖') }}</span>
        <!-- 逐行说明文字（为什么是尾盘卖 / 竞价卖 / 持有 …）；【简洁】模式下由 CSS 隐藏 -->
        <div
          v-if="it.actionNote"
          class="tvrb-row-note tvrb-selectable"
        >
          {{ it.actionNote }}
        </div>
        <!-- 卖出节奏提示（按今日竞价高低开细分）：只在占比缺数据时出现（文案 / 徽标 / tone 全由 Logic 给） -->
        <div
          v-if="it.sellHint"
          class="tvrb-sell-hint tvrb-selectable"
          :class="'tvrb-tone-' + it.sellHint.tone"
        >
          <span
            v-if="it.sellHint.badge"
            class="tvrb-sell-badge"
          >{{ it.sellHint.badge }}</span>
          <span class="tvrb-sell-hint-text">{{ it.sellHint.text }}</span>
        </div>
      </div>
      <!-- 分笔明细面板（与买点侧、与分笔买卖看板同一组件、同一段文字） -->
      <div
        v-if="penOpenSet.has(it.name)"
        class="tvrb-pen-panel"
      >
        <TbbPenPanel
          v-if="it.hasTick"
          :title="it.panelTitle"
          :note="it.panelNote"
          :hint="it.panelHint"
          :pens="it.pens"
          :badges="it.strengthBadges"
        />
        <div
          v-else
          class="tvrb-pen-empty"
          :title="it.emptyTitle"
        >
          {{ it.emptyText || '分笔明细暂不可用' }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import TvrbTopicHead from './TvrbTopicHead.vue';
// 与买点侧共用同一个分笔面板组件（§6：一处实现，两处逐字一致）
import TbbPenPanel from '../tick/TbbPenPanel.vue';

defineProps({
  group: {
    type: Object,
    required: true
  }
});

// 与【买点】共用同一份展开态（同一只票两处是同一个开关）——同 TopicVolRatioBoard.vue 的一份 board 实例
const board = inject('topicVolRatioBoard');
const { penOpenSet, togglePens } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const penTip = '点击展开 / 收起这一分钟（09:30~09:31）的分笔明细';
</script>
