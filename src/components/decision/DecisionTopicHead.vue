<!--
  DecisionTopicHead.vue — 「决策」看板题材块的第一行（题材名 + 排名圆点 + 数量 + 竞价一字 + 题材标记）

  为什么单独成一个组件：买点块与卖点块【都要】这一行，口径与样式一模一样。
  只写一份才能保证两边永远同步（§6 单一真相）；它是【本看板的组件】，
  不构成「复用其它看板组件」——决策看板对外仍然零依赖。

  排版（用户口径 2026-09-24 / 09-30，节约空间，全部挤在一行）：
      题材名称  ●1   数量：12   竞价一字：1  [候选题材]  [昨有买入]  [三次入选]
      └ 实心红色圆点里的数字 = 决策看板【内】的排名（数量不达标的题材已剔除、不占名次，
        后面的题材递补上来；与早盘竞价「题材 toggle」同一套组序）
      └ 「竞价一字」后面的数字用红色（2026-09-24 用户要求）：一字 = 最强 / 买不到的那个信号
      └ 末尾两个标记是【买点侧专有】，由 DecisionBuyBlock 传入；卖点侧不传 ⇒ 都不显示。

  ⚠️ [TOPIC-TAGS 2026-09-30 用户口径] 题材行只允许出现这两个标记，措辞是刻意选的：
      · 昨有买入（prevBoughtTag）—— 【题材级】：这个题材昨天【有票】被打过「买」标签 = 题材在延续。
        🔴 事故（2026-09-30）：第一版这一行写的是「昨天已买」，用户把它读成【个股】结论
        （「大亚圣象昨天已买」——可他昨天并没有买大亚圣象）⇒ 已把个股结论从这一行彻底撤掉
        （撤到行尾的【加仓】），并把题材级的说法改成措辞不同的【昨有买入】。
        ⛔ 不要再把「昨天已买」这四个字放回这一行。
      · N 次入选（streakTag）—— 该题材在【含今日的最近 5 个交易日】里进过买点几次（规则⑤）。
        与【昨有买入】并存、互不冲突。

  §10：任何一项数据缺失都显示「—」而不是 0 —— 没数据 ≠ 没有。
      两个标记为 null / undefined 时【整个不渲染】（而不是显示空壳）。
  §21：本组件零业务计算，只做取值与占位符。
-->
<template>
  <div class="dcb-block-head">
    <span class="dcb-topic">{{ topicText }}</span>
    <span
      v-if="rank"
      class="dcb-rank-dot"
      :title="'决策看板内排名第 ' + rank + '（数量不达标的题材已剔除、不占名次；与早盘竞价题材组序同源）'"
    >{{ rank }}</span>
    <span class="dcb-meta">数量：{{ text(count) }}</span>
    <span class="dcb-meta">竞价一字：<span class="dcb-meta-num">{{ text(yizi) }}</span></span>
    <!-- [⑥ 候选题材 2026-10-02 用户口径] 用户原话「你可以这样写：候选题材：房地产」——
         它在「竞价一字」右边，紧跟题材级标记之前；由 Logic 层给 candidateTag（⛔ 模板零计算）。 -->
    <span
      v-if="candidateTag"
      class="dcb-candidate"
      title="候选题材：用来补位 / 陪跑的题材（主线不足 3 只时往下推，或第 1 名已够 3 只时第 2 名降级）→ 降一档取票、一律轻仓"
    >{{ candidateTag }}</span>
    <!-- [④ 题材级] 昨有买入：这个题材昨天有票被打过「买」标签（⛔ 不是「这一块都买过」） -->
    <span
      v-if="prevBoughtTag"
      class="dcb-prev-bought"
      title="这个题材昨天有股票被打过「买」标签（题材在延续；哪一只昨天买过看行尾的加仓）"
    >{{ prevBoughtTag }}</span>
    <!-- [⑤ 入选次数] 该题材在含今日的最近 5 个交易日里进过买点几次 -->
    <span
      v-if="streakTag"
      class="dcb-topic-streak"
      :title="'该题材在含今日的最近 5 个交易日里进入买点的次数（只数重仓 / 轻仓两个主买点块）'"
    >{{ streakTag }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  topic: { type: String, default: '' },
  rank: { type: Number, default: null },
  count: { type: Number, default: null },
  yizi: { type: Number, default: null },
  // [⑥ MIN-3-PICKS 2026-10-02] 候选题材标记（买点侧专有，Logic 层算好；卖点侧不传 ⇒ 不显示）
  candidateTag: { type: String, default: '' },
  // [④/⑤] 题材级标记（买点侧专有，全部由 Logic 层算好；卖点侧不传 ⇒ 不显示）
  prevBoughtTag: { type: String, default: '' },
  streakTag: { type: String, default: '' }
});

const topicText = computed(() => props.topic || '（今日未成组）');

/** §10：null/undefined 一律显示占位符「—」，绝不退化成 0 */
function text(v) {
  return (v === null || v === undefined) ? '—' : String(v);
}
</script>
