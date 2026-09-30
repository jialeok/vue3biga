<!--
  DecisionTopicHead.vue — 「决策」看板题材块的第一行（题材名 + 排名圆点 + 数量 + 竞价一字）

  为什么单独成一个组件：买点块与卖点块【都要】这一行，口径与样式一模一样。
  只写一份才能保证两边永远同步（§6 单一真相）；它是【本看板的组件】，
  不构成「复用其它看板组件」——决策看板对外仍然零依赖。

  排版（用户口径 2026-09-24，节约空间，全部挤在一行）：
      题材名称  ●1   数量：12   竞价一字：1   昨天已买
      └ 实心红色圆点里的数字 = 该题材今日排名（早盘竞价「题材 toggle」同一套组序）
      └ 「竞价一字」后面的数字用红色（2026-09-24 用户要求）：一字 = 最强 / 买不到的那个信号
      └ 「昨天已买」（2026-09-30 用户口径）：该题材昨日有打「买」标签的股票；
        紧跟竞价一字数量右边，【简洁】模式下也保留

  §10：任何一项数据缺失都显示「—」而不是 0 —— 没数据 ≠ 没有。
  §21：本组件零业务计算，只做取值与占位符。
-->
<template>
  <div class="dcb-block-head">
    <span class="dcb-topic">{{ topicText }}</span>
    <span
      v-if="rank"
      class="dcb-rank-dot"
      :title="'题材排名第 ' + rank + ' 名（与早盘竞价题材组序同源）'"
    >{{ rank }}</span>
    <span class="dcb-meta">数量：{{ text(count) }}</span>
    <span class="dcb-meta">竞价一字：<span class="dcb-meta-num">{{ text(yizi) }}</span></span>
    <!-- [PREV-BOUGHT 2026-09-30 用户口径] 「昨天已买」标记：紧跟在【竞价一字数量】右边。
         是否显示由 Logic 层算好（block.prevBoughtTopic / group.prevBoughtTopic），模板零计算（§21）；
         【简洁】模式下同样保留 —— 用户明确要求「标签保留」。 -->
    <span
      v-if="prevBought"
      class="dcb-prev-bought"
      title="该题材昨日有打「买」标签的股票"
    >昨天已买</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  topic: { type: String, default: '' },
  rank: { type: Number, default: null },
  count: { type: Number, default: null },
  yizi: { type: Number, default: null },
  /** [PREV-BOUGHT 2026-09-30] 该题材昨日是否有打「买」标签的股票（Logic 层算好，§21） */
  prevBought: { type: Boolean, default: false }
});

const topicText = computed(() => props.topic || '（今日未成组）');

/** §10：null/undefined 一律显示占位符「—」，绝不退化成 0 */
function text(v) {
  return (v === null || v === undefined) ? '—' : String(v);
}
</script>
