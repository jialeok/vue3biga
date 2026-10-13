<!--
  TvrbCashAlert.vue — 「题材量比」看板【买点侧顶部】的【空仓提醒】标语

  用户口径（2026-10-13 第四轮原话）：
    「题材量比买点侧那里，帮我添加一个条件，数量筛选后，排名第一题材平均量比小于 25 的，题材，
      在买点侧要提示醒目的空仓。……还是按照原来的正常方式选出排名第一，第二的题材的股票，
      只是在这个低量比的节点，排名第一的题材平均竞价量比小于 25 时，需要文字提示空仓。
      有空仓提醒。文字大些，醒目些，看到这些文字，我就不开仓了。记住就是按照正常流程选出股票，
      只是多添加了空仓提醒文字。其它不变。」

  ⇒ 定位：一个【纯展示】组件（§21 模板零计算 / §11 可安全删除）——
      · 判据（< 25）在 logic/topicvolratio/topic-vol-ratio-rules.js#buildCashAlert；
      · 文案（大字标语 + 说明）也在那一份 Logic 里拼好，本组件只负责摆放与配色；
      · ⛔ 它不删票、不改档位、不隐藏任何股票行：命中时股票照常在下方按原规则列出。

  ⚠️ 为什么不用 .tvrb-block-note 那套类名：那类被【简洁模式】隐藏（.tvrb-compact 的选择器），
     而这条标语是用户明确要求「醒目、看到就不开仓」的 —— 它在任何模式下都必须可见，
     所以这里用独立的 .tvrb-cash-alert（不在任何隐藏选择器里）。
  ⚠️ 配色：走本看板既有的「风险 / 告警」色系（深红字 + 浅红底 + 红边框，
     与 .tvrb-error / .tvrb-note-box.unqualified 同一套语义色），
     ⛔ 与「涨红跌绿」那条股价语义色无关（这里红 = 风险，不是「涨」）。

  §10：alert.show 为假（缺数据 / 没入选题材 / 量比达标）⇒ 整个组件不渲染，
       ⛔ 绝不显示一个「空仓 0.00」之类的假标语。
-->
<template>
  <div
    v-if="alert && alert.show"
    class="tvrb-cash-alert tvrb-selectable"
  >
    <div class="tvrb-cash-alert-head">
      {{ alert.headline }}
    </div>
    <div class="tvrb-cash-alert-detail">
      {{ alert.detail }}
    </div>
  </div>
</template>

<script setup>
// ⛔ 零业务计算：只接一个由 Logic 层算好的对象（§21 / §34）
defineProps({
  alert: {
    type: Object,
    required: true
  }
});
</script>
