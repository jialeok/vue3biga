<!--
  TvrbDataGate.vue — 「题材量比」看板【买点侧】的【数据缺失 · 不能选股】提示板

  用户口径（2026-11-04 第七轮原话）：
    「题材没有平均量比的时候，题材量比看板选股就不能选票了，应该空仓或者提醒用户修复程序数据，
      那里应该有一个专门的提示板，写出不能选票的理由。我上次问题不是交代了，还交代了选股条件的
      数据缺失，也不能选票，比如竞价量比，20日涨幅，10日涨幅缺失等，数据缺失都不要选股，要有提示，
      如果竞价量比缺失选出的票本身就是错误的，只会误导，要有提示行。不要把股票放进去了，这是个常识」

  ⇒ 定位：一个【纯展示】组件（§21 模板零计算 / §11 可安全删除）——
      · 判据、缺项清单、逐条「为什么不能选 / 怎么修」的文案，全在
        `logic/topicvolratio/buy-data-gate.js#resolveBuyDataGate` 拼好（§6 单一真相）；
      · 本组件只负责摆放与配色，⛔ 不判断、不取数、不发请求；
      · 它出现时，买点侧【一只票都不渲染】（清空发生在规则层 `_clearBuySideForDataGate`，
        ⛔ 不是靠这里隐藏行 —— 隐藏行只是视觉，票还在数据里就还会从别的通道漏出去）。

  ⚠️ 与「占位」（.tvrb-diverge-pending / .tvrb-buysettle-pending）的视觉分工：
     占位 = 虚线框 + 灰蓝/靛蓝 = 「在算、等结论」；
     本板 = **实线框 + 深红** = 「这是结论：今天不能选股」。两者必须一眼能分开，
     ⛔ 绝不用虚线（虚线在本项目里专指「还在等」，用错会让人以为再等等就有票）。

  ⚠️ 为什么不用 .tvrb-block-note 那套类名：那类被【简洁模式】隐藏（.tvrb-compact 选择器），
     而这条提示是用户明确要求「看到就不开仓」的 —— 它在任何模式下都必须可见。

  §10：`gate.blocked` 为假 ⇒ 整个组件不渲染，⛔ 绝不显示一块空白的「不能选股」。
-->
<template>
  <div
    v-if="gate && gate.blocked"
    class="tvrb-datagate tvrb-selectable"
  >
    <div class="tvrb-datagate-head">
      {{ gate.headline }}
    </div>
    <div class="tvrb-datagate-sub">
      买点侧今天<span class="tvrb-datagate-strong">不显示任何候选票</span>——
      缺数据时选出来的票本身就是错的（下面的规则全是阈值判据，缺了就只能靠「当 0」或「跳过规则」编一个结论）。
    </div>

    <!-- 逐条缺项：缺什么 → 现状（几只里有几只）→ 为什么不能选 → 怎么修 -->
    <div
      v-for="(it, i) in gate.items"
      :key="'tvrb-dg-' + it.key"
      class="tvrb-datagate-item"
    >
      <div class="tvrb-datagate-item-head">
        <span class="tvrb-datagate-idx">{{ i + 1 }}</span>
        <span class="tvrb-datagate-label">{{ it.label }}</span>
        <span class="tvrb-datagate-stat">{{ it.stat }}</span>
      </div>
      <div class="tvrb-datagate-why">
        <span class="tvrb-datagate-k">为什么不能选：</span>{{ it.why }}
      </div>
      <div class="tvrb-datagate-fix">
        <span class="tvrb-datagate-k">怎么修：</span>{{ it.fix }}
      </div>
    </div>

    <div class="tvrb-datagate-detail">
      {{ gate.detail }}
    </div>
  </div>
</template>

<script setup>
// ⛔ 零业务计算：只接一个由 Logic 层算好的对象（§21 / §34）
defineProps({
  gate: {
    type: Object,
    required: true
  }
});
</script>
