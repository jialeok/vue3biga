<!--
  TvrbTopicHead.vue — 「题材量比」看板题材块的第一行（题材名 + 排名圆点 + 数量 + 竞价一字 + 平均量比 + 取几只）

  排版（与决策看板 DecisionTopicHead 同款视觉语言，但前缀 tvrb-，组件独立）：
    第 1 行：[昨有买入]  [N 次入选]        ← 一个标记都没有时整行不渲染（不留空行、不占高度）
    第 2 行：[题材名称] ●排名  数量：n  竞价一字：n  平均量比：x.xx  [选 n 只]

  · 排名圆点里的数字 = 本看板内按【平均竞价量比】的排名（数量 < 4 只的题材已剔除、不占名次，
    后面的题材递补上来；与早盘竞价「题材 toggle」同一套组序）。
  · 「竞价一字」后面的数字用红色（一字 = 最强 / 买不到的信号），与决策看板同款。
  · 「平均量比」= 该题材组内所有拿到量比的行的均值（缺失 → '—'，§10 不补 0.00）。
  · 「选 n 只」= 本题材按数量档位应取的只数（4~8 只 → 1 只、> 8 只 → 2 只）。
  · 两个题材标记与决策看板【同一份数据、同一份判定】（decision-rules 的 _markTopicPrevBought /
    _markTopicStreak），⛔ 本组件只取值 + 占位：
      [昨有买入] = 这个题材昨天有票被打过「买」标签（题材在延续）；
      [N 次入选] = 含今日的最近 5 个交易日里该题材进入买点的次数。
    ⚠️ 卖点段的题材行【不传】这两个标记（候选本来就是昨天买过的票，标了没信息量 ——
       与决策看板卖点的口径一致，见 TvrbSellBlock）。
    §10：昨日标签 / 历史窗口没读到 ⇒ 两个 prop 都是空串 ⇒ 整行不渲染（⛔ 不留空行）。

  §10：任何一项数据缺失都显示「—」而不是 0 —— 没数据 ≠ 没有。
  §21：本组件零业务计算，只做取值与占位符。
-->
<template>
  <div class="tvrb-block-head">
    <div
      v-if="hasTopicTags"
      class="tvrb-tags-row"
    >
      <span
        v-if="prevBoughtTag"
        class="tvrb-prev-bought"
        title="这个题材昨天有股票被打过「买」标签（题材在延续）"
      >{{ prevBoughtTag }}</span>
      <span
        v-if="streakTag"
        class="tvrb-topic-streak"
        title="该题材在含今日的最近 5 个交易日里进入买点的次数"
      >{{ streakTag }}</span>
    </div>
    <div class="tvrb-topic-row">
      <span class="tvrb-topic">{{ topicText }}</span>
      <span
        v-if="rank"
        class="tvrb-rank-dot"
        :title="'本看板内排名第 ' + rank + '（按题材平均竞价量比降序；数量不足 4 只的题材已剔除、不占名次）'"
      >{{ rank }}</span>
      <span class="tvrb-meta">数量：{{ text(count) }}</span>
      <span class="tvrb-meta">竞价一字：<span class="tvrb-meta-num">{{ text(yizi) }}</span></span>
      <span
        class="tvrb-meta"
        title="该题材组内所有拿到竞价量比的行，其竞价量比的算术平均（与排名口径一致）"
      >平均量比：<span class="tvrb-meta-vr">{{ vrText }}</span></span>
      <span
        v-if="pickCount"
        class="tvrb-pick-tag"
        title="本题材按股票数量档位应取的只数（4~8 只 → 1 只；> 8 只 → 2 只）"
      >选 {{ pickCount }} 只</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  topic: { type: String, default: '' },
  rank: { type: Number, default: null },
  count: { type: Number, default: null },
  yizi: { type: Number, default: null },
  /** 平均竞价量比的展示文案（由 Logic 层 formatAvgVolRatio 给；缺失 → '—'） */
  avgVolRatio: { type: String, default: '' },
  /** 本题材应取的只数（0 / null ⇒ 不显示「选 n 只」） */
  pickCount: { type: Number, default: 0 },
  // 买点侧专有的两个题材标记（卖点侧不传 ⇒ 整行不渲染，与决策看板卖点同口径）
  prevBoughtTag: { type: String, default: '' },
  streakTag: { type: String, default: '' }
});

const topicText = computed(() => props.topic || '（今日未成组）');
const vrText = computed(() => props.avgVolRatio || '—');
const hasTopicTags = computed(() => !!(props.prevBoughtTag || props.streakTag));

/** §10：null/undefined 一律显示占位符「—」，绝不退化成 0 */
function text(v) {
  return (v === null || v === undefined) ? '—' : String(v);
}
</script>
