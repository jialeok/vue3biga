<!--
  DecisionBuyBlock.vue — 「决策」看板【买点】的一个题材块（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版 / 2026-09-30 标记改版）：
    第一行：题材名称  ●1（实心红圆点 = 题材排名）  数量：n  竞价一字：n  [昨有买入] [N 次入选]
            ← 一行挤完，省空间；末两个标记见 DecisionTopicHead 的注释（题材级，买点侧专有）
    第二行：选择理由：题材排第一，股票数量n只，m个竞价一字
    第三行起：序号  股票名称 （龙几）  十日涨幅  竞价涨幅（红底/绿底/灰底小徽标）  重仓 / 轻仓 / 加仓
            ⚠️ [TOPIC-PREV-BOUGHT 2026-09-30 用户口径] 股票行【不再】出现任何「昨天已买」徽标 ——
               它会紧跟股票名，被读成【这一只】的结论，而题材级的标记只能表达题材在延续。
               个股级的信息改由【行尾仓位】表达：这一只昨天真被打过「买」标签 ⇒ 显示【加仓】。
            ⚠️ [POSITION-ADD 2026-09-30 用户口径] 重仓 / 轻仓【都】改标【加仓】（用户已确认）：
               昨天已经有仓位了，今天这一笔的动作是往上加，不再重新建仓。
            重仓与轻仓【混排在同一块里】，序号连续，仓位写在行尾（不再拆两块重复题材名）。

  §21：本组件零业务计算 —— 排名 / 数量 / 一字数 / 理由 / 序号 / 龙几 / 涨幅 / 仓位 / 题材标记
  全部由 logic/decision/decision-rules.js 预先算好，模板只做 v-for 渲染。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字 + 题材标记（⑫ 昨有买入 / ⑬ 入选次数） -->
    <DecisionTopicHead
      :topic="block.block.topic"
      :rank="block.block.rank"
      :count="block.block.count"
      :yizi="block.block.yiziCount"
      :prev-bought-tag="block.prevBoughtTag"
      :streak-tag="block.streakTag"
    />
    <!-- 第二行：选择理由（理由里已含「根据规则N」；规则编号由 Logic 层给出，⛔ 模板零计算 §21） -->
    <!-- [COPY 2026-09-29] dcb-selectable：选票说明文字允许长按选中复制（见 decision-board.css） -->
    <div class="dcb-reason-line dcb-selectable">
      选择理由：{{ block.reason }}<span
        v-if="block.ruleNo"
        class="dcb-rule-no"
      >（规则{{ block.ruleNo }}）</span>
    </div>
    <!-- 第三行起：选中的股票（重仓 / 轻仓 / 加仓混排，序号连续） -->
    <div
      v-for="p in block.picks"
      :key="p.name"
      class="dcb-row"
    >
      <span class="dcb-seq">{{ p.seq }}</span>
      <span class="dcb-name">{{ p.name }}</span>
      <!-- [TOPIC-PREV-BOUGHT 2026-09-30 用户口径] ⛔ 这里【故意】没有「昨天已买」徽标：
           它紧跟股票名会被读成【这一只】的结论（用户 9/30 反馈「大亚圣象昨天没买也被标」）。
           题材在延续 → 看上面的题材行【昨有买入】；这一只昨天真买过 → 看行尾的【加仓】。 -->
      <span
        v-if="p.dragonLabel"
        class="dcb-dragon"
      >{{ p.dragonLabel }}</span>
      <span class="dcb-pct">{{ pctText(p.pct) }}</span>
      <!-- [AUC-BADGE 2026-09-29] 竞价涨幅徽标：与【卖点】完全同款（同一个 .dcb-auc 类、同一份
           formatAucPct + getAucOpenKind），金额与配色都在 Logic 层算好（§21 模板零计算）。
           缺竞价涨幅 ⇒ aucPctText 为空串 ⇒ 整个徽标不渲染（§10 绝不用灰底伪装成「平开」）。 -->
      <span
        v-if="p.aucPctText"
        class="dcb-auc"
        :class="'dcb-auc-' + p.aucTone"
      >{{ p.aucPctText }}</span>
      <!-- [POSITION-TONE 2026-09-30] 仓位（重仓 / 轻仓 / 加仓）：文案 + 配色档全部由 Logic 层给
           （p.position / p.positionTone，§21 模板零计算、⛔ 不做 `=== '轻仓'` 这类比较）。
           【加仓】= 这一只昨天已经被打过「买」标签（规则⑫ 股票级效果）。 -->
      <span
        class="dcb-position"
        :class="'dcb-pos-' + p.positionTone"
      >{{ p.position }}</span>
      <!-- 【三 · 持有 / 加仓】上交易日也在买点里 → 强势股（由 Logic 层标记，模板零计算 §21） -->
      <span
        v-if="p.holdTag"
        class="dcb-hold"
      >{{ p.holdTag }}</span>
    </div>
    <!-- 辅助说明：本档无轻仓票 / 有股票因缺竞价涨幅未纳入（§10 缺失必须可见，不能静默丢掉）
         [COPY 2026-09-29] dcb-selectable：这几条说明同样允许长按选中复制 -->
    <div
      v-for="(n, i) in block.notes"
      :key="'note-' + i"
      class="dcb-block-note dcb-selectable"
    >
      {{ n }}
    </div>
    <!-- 未达门槛：如实说明（§10 不拿不够格的数据冒充有效信号）
         [COMPACT 2026-09-30] dcb-note-empty = 【简洁】模式下仍保留：
         这类文字说明的是「这一块为什么没有股票」，全部隐藏会剩下一行光秃秃的题材名，
         反而让人以为「没算出来」（§10）。其余说明性文字在简洁模式下隐藏。 -->
    <div
      v-if="!block.qualified"
      class="dcb-block-note unqualified dcb-note-empty dcb-selectable"
    >
      {{ block.notQualifiedText }}
    </div>
    <div
      v-else-if="block.picks.length === 0"
      class="dcb-block-note dcb-note-empty dcb-selectable"
    >
      该题材没有可买的非一字股票
    </div>
  </div>
</template>

<script setup>
import DecisionTopicHead from './DecisionTopicHead.vue';
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  block: {
    type: Object,
    required: true
  }
});

// 涨幅格式化走 Logic 层（§21 模板不做格式化）；缺失 → 空串（§10 绝不补 0）
function pctText(pct) {
  return formatRangePct(pct);
}
// ⛔ 此处【不再】做 `position === '轻仓'` 这类比较：配色档由 Logic 层的 p.positionTone 直接给出
//    （§21 模板零判断）。新增「加仓」档时组件无需改动 —— 这正是上一版 isLight() 做不到的。
// ⛔ 也不做 `block.block.topic === ...` 之类的题材判断：⑫ / ⑬ 两个题材标记直接读 Logic 给的字符串。
</script>
