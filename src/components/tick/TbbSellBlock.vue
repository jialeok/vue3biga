<!--
  TbbSellBlock.vue — 「分笔买卖」看板【卖点】的一个题材分组（独立组件，⛔ 不复用 DecisionSellBlock）

  用户口径（2026-10-10）：与买点同款布局、同款列，只是数据来自卖点分组。
    「买点和卖点看板都要标」——本看板卖点侧与买点侧显示【完全相同的列】：
      题材名称 ●排名 数量：n 竞价一字：n ／ 序号 股票名称 龙几(±n) 十日涨幅 [17红4绿] [盘中冲高卖/立刻卖/均衡]

  ★ [ACTION-LABEL 2026-10-10] 末尾那个结论胶囊是【动作名】，且买卖两侧不同名
    （用户口径「分笔买卖就是买入和卖出信号，所以标注清晰些」）：
      卖点 红（走强）→「盘中冲高卖」   卖点 绿（走弱）→「立刻卖」
      买点 红（走强）→「立刻买」       买点 绿（走弱）→「盘中下杀买」
    ⇒ 名字由 logic/tick/tick-minute.js#tickStrengthOf 按 side 给出，本组件只渲染。

  ⛔ 刻意【没有】决策看板卖点的这些东西（用户「其它不要放」）：
      卖出理由 / 卖出时点（11:20卖 / 14:50卖 / 看分时定 / 即刻出…）/ 竞价涨幅 / 竞价量比 /
      竞价占比 / 尾盘卖·竞价卖·跟龙竞价卖·10分钟时卖 / 持有 / 逐行说明 / 竞价图形判断选择器。
  ⛔ 卖点块【不显示】题材行的两个标记（卖点候选本来就是「昨天买过的票」，挨个标没有信息量）——
     与决策看板卖点的口径一致（DecisionTopicHead 在卖点侧同样不传这两个标记）。

  §21：本组件零业务计算，全部读 Logic 层预计算好的字段。
-->
<template>
  <div class="tbb-block">
    <TbbTopicHead
      :topic="group.topic"
      :rank="group.topicRank"
      :count="group.count"
      :yizi="group.yiziCount"
    />
    <template
      v-for="it in group.items"
      :key="it.name"
    >
      <div class="tbb-row">
        <span
          class="tbb-seq tbb-trigger"
          :title="penTip"
          @click.stop="togglePens(it.name)"
        >{{ it.seq }}</span>
        <span
          class="tbb-name tbb-trigger"
          :title="penTip"
          @click.stop="togglePens(it.name)"
        >{{ it.name }}</span>
        <span
          v-if="it.dragonLabel"
          class="tbb-dragon"
        >{{ it.dragonLabel }}</span>
        <span
          v-if="it.dragonDeltaText"
          class="tbb-dragon-delta"
          :class="'tbb-dragon-delta-' + it.dragonDeltaTone"
          :title="it.dragonDeltaTitle"
        >{{ it.dragonDeltaText }}</span>
        <span
          v-if="it.pctText"
          class="tbb-pct"
          title="十日涨幅"
        >{{ it.pctText }}</span>
        <span
          v-if="it.redText"
          class="tbb-stat"
          :title="it.statTitle"
        ><span class="tbb-stat-red">{{ it.redText }}</span><span class="tbb-stat-green">{{ it.greenText }}</span></span>
        <span
          v-if="it.strengthText"
          class="tbb-verdict"
          :class="'tbb-verdict-' + it.strengthTone"
          :title="it.strengthTitle"
        >{{ it.strengthText }}</span>
        <span
          v-if="it.emptyText"
          class="tbb-stat tbb-stat-empty"
          :title="it.emptyTitle"
        >{{ it.emptyText }}</span>
      </div>
      <TbbPenPanel
        v-if="penOpenSet.has(it.name)"
        :title="it.panelTitle"
        :note="it.panelNote"
        :pens="it.pens"
      />
    </template>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import TbbTopicHead from './TbbTopicHead.vue';
import TbbPenPanel from './TbbPenPanel.vue';

defineProps({
  group: {
    type: Object,
    required: true
  }
});

// 与【买点】共用同一份展开态（同一只票两处是同一个开关）——同 TickBoard.vue 的一份 board 实例（§6 / §34）
const board = inject('tickBoard');
const { penOpenSet, togglePens } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const penTip = '点击展开 / 收起这一分钟（09:30~09:31）的分笔明细';
</script>
