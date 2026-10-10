<!--
  TbbBuyBlock.vue — 「分笔买卖」看板【买点】的一个题材块（独立组件，⛔ 不复用 DecisionBuyBlock）

  用户口径（2026-10-10）：「把决策看板的布局，股票名称，放进去，其它数据不要放」
    「要放的例如，买点，昨有买入，四次入选，题材名称，排名，数量，竞价一字（数量），
      股票名称，龙几（+2），十日涨幅。还有添加下 20 笔交易的统计，比如 17红4绿」
    「点击股票名称和序号，展开那一分钟的 20 笔明细」

  本块【只有】：
    题材行   ：[昨有买入] [四次入选] / 题材名称 ●排名 数量：n 竞价一字：n
    股票行   ：序号  股票名称  （龙几 ±n）  十日涨幅  [17红4绿] [立刻买/下杀买]

  ★ [ACTION-LABEL 2026-10-10 用户口径]「分笔买卖就是买入和卖出信号，所以标注清晰些。
    早上就靠这个来判断」⇒ 末尾的结论胶囊是【动作名】，**买卖两侧不同名**：
      买点 红（走强）→「立刻买」     买点 绿（走弱）→「下杀买」
      卖点 红（走强）→「冲高卖」     卖点 绿（走弱）→「立刻卖」
    ★ 红 = 绿【打平】也按【弱】：买点侧同样标「下杀买」（⛔ 不再有「均衡」/「不下结论」）——
      用户 2026-10-10：「买点侧都是每天要买的票，只是要选择买入时机」。
    ⇒ 名字由 logic/tick/tick-minute.js#tickStrengthOf(s, side) 给出，本组件只渲染（§21）。
    展开面板 ：点【序号】或【股票名】→ 这一分钟的明细（TbbPenPanel）

  ⛔ 刻意【没有】决策看板的这些东西（用户「其它不要放」）：
      选择理由 / 规则编号 / 竞价涨幅 / 竞价量比 / 竞价占比 / 重仓轻仓持有 /
      竞价买·尾盘买·先卖后买·下杀买 / 持有 / 逐行说明文字 / 规则提示 / 竞价图形判断选择器 /
      辅助说明与不出票原因。

  §21：本组件零业务计算 —— 序号 / 龙标 / 名次变化 / 十日涨幅文案 / 红绿统计 / 强弱结论 /
       明细每一行的价格与手数，全部由 logic/tick/tick-minute.js 预计算好，模板只渲染。
-->
<template>
  <div class="tbb-block">
    <TbbTopicHead
      :topic="block.topic"
      :rank="block.rank"
      :count="block.count"
      :yizi="block.yiziCount"
      :prev-bought-tag="block.prevBoughtTag"
      :streak-tag="block.streakTag"
    />
    <template
      v-for="p in block.picks"
      :key="p.name"
    >
      <div class="tbb-row">
        <span
          class="tbb-seq tbb-trigger"
          :title="penTip"
          @click.stop="togglePens(p.name)"
        >{{ p.seq }}</span>
        <span
          class="tbb-name tbb-trigger"
          :title="penTip"
          @click.stop="togglePens(p.name)"
        >{{ p.name }}</span>
        <span
          v-if="p.dragonLabel"
          class="tbb-dragon"
        >{{ p.dragonLabel }}</span>
        <!-- 龙标旁边的名次变化（'+3' 上升红 / '-2' 下降绿；无可比时为 '' ⇒ 整个不渲染，§10） -->
        <span
          v-if="p.dragonDeltaText"
          class="tbb-dragon-delta"
          :class="'tbb-dragon-delta-' + p.dragonDeltaTone"
          :title="p.dragonDeltaTitle"
        >{{ p.dragonDeltaText }}</span>
        <span
          v-if="p.pctText"
          class="tbb-pct"
          title="十日涨幅"
        >{{ p.pctText }}</span>
        <!-- ══ [DRAGON-REF 2026-10-11 用户口径] 从【决策看板】继承的「跟龙」参考标签 ═══════════════
             用户原话：「分笔买卖看板，我希望继承决策看板的龙一字持有标签，跟龙竞价卖等标签，
               就是跟龙有关的，继承下，因为龙一会影响中军或者后排的走势，技术再好也没用，
               有时还要看题材或者龙一的眼色。当然你把标签放到分笔买卖看板时，原来的那些标签保持不变，
               只是作为参考。」
             ⇒ 只继承三枚（龙一字持有 / 跟龙竞价卖 / 补涨竞价买），文案由 Logic 层从决策行原样取用
               （§6 ⛔ 不在这里写 '龙一字持有' 字面量），配色档由 Logic 层给（§21 模板零判断）。
             ★ 空心描边样式（.tbb-ref-*）与【实心】的结论胶囊刻意不同 —— 一眼分清
               「哪个是本分钟自己算的结论、哪个是从决策看板借来的参考」。
             §10：没命中 ⇒ 空数组 ⇒ 一枚都不渲染（⛔ 不显示占位符）。 -->
        <span
          v-for="t in p.dragonRefTags"
          :key="'ref-' + t.text"
          class="tbb-ref"
          :class="'tbb-ref-' + t.tone"
          :title="t.title"
        >{{ t.text }}</span>
        <!-- 20 笔统计：红 = 上涨笔数 / 绿 = 下跌 + 平盘笔数（用户口径「下跌和平的用绿色」） -->
        <span
          v-if="p.redText"
          class="tbb-stat"
          :title="p.statTitle"
        ><span class="tbb-stat-red">{{ p.redText }}</span><span class="tbb-stat-green">{{ p.greenText }}</span></span>
        <!-- 买卖结论胶囊（动作名，由红绿笔数直接得出；翻车点提示：它不参与决策看板的任何规则） -->
        <span
          v-if="p.strengthText"
          class="tbb-verdict"
          :class="'tbb-verdict-' + p.strengthTone"
          :title="p.strengthTitle"
        >{{ p.strengthText }}</span>
        <!-- 抓不到时的可见状态：未抓取 / 无数据 / 缺代码（§10 ⛔ 绝不显示「0红0绿」） -->
        <span
          v-if="p.emptyText"
          class="tbb-stat tbb-stat-empty"
          :title="p.emptyTitle"
        >{{ p.emptyText }}</span>
      </div>
      <TbbPenPanel
        v-if="penOpenSet.has(p.name)"
        :title="p.panelTitle"
        :note="p.panelNote"
        :hint="p.panelHint"
        :pens="p.pens"
      />
    </template>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import TbbTopicHead from './TbbTopicHead.vue';
import TbbPenPanel from './TbbPenPanel.vue';

defineProps({
  block: {
    type: Object,
    required: true
  }
});

// 与 TickBoard.vue 共用同一份 board 实例（provide / inject）：
//   展开态只有一份（同一只票在买点与卖点是同一个开关），本组件不新建状态（§6 / §34）。
const board = inject('tickBoard');
const { penOpenSet, togglePens } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const penTip = '点击展开 / 收起这一分钟（09:30~09:31）的分笔明细';
</script>
