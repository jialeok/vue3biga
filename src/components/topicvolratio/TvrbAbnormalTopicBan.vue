<!--
  TvrbAbnormalTopicBan.vue — 「题材量比」看板买点侧顶部的【异动第三天 · 同题材不买】提示板

  ★★ 用户口径（2026-11-17 原话，逐字）★★
    「1.记住总龙一第一次监管异动，之后两天，次日本来现在的规则不能买，不变，在第三天都不能买
      它题材的股票……临时题材包括在内。……也就是重点监控第三天，第四天按照正常流程走，
      你添加下这个规则并在提示板上标明。」

  ⇒ 定位：一个【纯展示】组件（§21 模板零计算 / §11 可安全删除）——
     · 判据（今天是不是异动日 + 2 个交易日、禁令题材集合）在 `logic/topicvolratio/abnormal-topic-ban.js`；
     · 文案（大字标题 + 说明 + 本次剔除名单）也在那一份 Logic 里拼好
       （`buildAbnormalTopicBanNotice`），本组件只负责摆放；
     · ⛔ 它不删票、不改档位、不隐藏任何股票行：被剔除的票照常在下方灰化列出。

  ⛔ 为什么不复用 TvrbCashAlert（空仓标语）：
    那个组件的 `alert.show` 同时驱动买点侧【整段灰化】（`.tvrb-ebb`），那是「全场空仓」的语义。
     本条只禁【同题材】，其它题材今天该买照买 —— 借那块板会把今天真要买的票一起灰掉。
     ⇒ 独立类名 `.tvrb-abn-tb-*`，视觉与空仓标语同色系（风险告警）但字号小一档：
       它是【局部禁令】，不是「今天别开仓」。

  §10：notice 为空 / 没有 headline ⇒ 整块不渲染，⛔ 绝不显示一条空标语。
-->
<template>
  <div
    v-if="notice && notice.headline"
    class="tvrb-abn-tb tvrb-selectable"
  >
    <div class="tvrb-abn-tb-head">
      {{ notice.headline }}
    </div>
    <div class="tvrb-abn-tb-detail">
      {{ notice.detail }}
    </div>
  </div>
</template>

<script setup>
// ⛔ 零业务计算：只接一个由 Logic 层算好的对象（§21 / §34）。
defineProps({
  notice: {
    type: Object,
    default: null
  }
});
</script>
