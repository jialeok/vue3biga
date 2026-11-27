<!--
  TvrbNextDayCarryBlock.vue — 第二十八条【次日承接 · 新龙】的独立小买点块（昨天选、今天买）

  ★★ 来由（2026-11-27 用户口径 · 规则手册八修，逐字）：
    「还有第二十八条选票是对的，但是买点不对，应该是在次日买……次日要继承下第二十八条次日买的票，
      重要的是注意下灰色行的股票不要继承……只继承一天啊，不要无限继承，不要乱继承。
      继承时也要有说明文字，大概意思是切换题材的新龙延迟一天（今天）买更加准确，刚好第三天，
      老龙已经彻底杀完，新龙就开始吹响反攻号角。」

  ── 为什么单独一个组件（⛔ 不要并回 TvrbBuyBlock.vue）────────────────────────
    TvrbBuyBlock 是「**今天**按题材选出来的票」，行内要塞十几列客观数据（龙位 / 占比 / 量比 /
    封单 / 分笔展开面板）；本块是「**昨天**选出来、今天兑现」的跨日语义，只关心
    「是哪几只 + 为什么是今天买」。两者混在一起，以后改任一条规则都会互相污染
    （用户明确要求「避免搞混以前逻辑」）。

  ── 边界（§21 模板零计算）──────────────────────────────────────────────────
    票名 / 代码 / 涨幅 / 标签 / 说明文字 **全部** 由 Logic 层 `logic/topicvolratio/nextday-buy.js`
    预先算好；本组件只负责把字段摆出来，⛔ 不判定「哪只该买」「灰不灰」「继承几天」。

  ── 数据形状（`out.nextDayCarry`，来源见 nextday-buy.js#buildNextDayCarryBlock）──────
    block : { topic }                     本块标题（含选票日）
    reason: string                        选择理由（含「为什么延迟一天」）
    picks : [{ seq, name, code, pctText, buyActionTag, actionNote }]
    notes : string[]                      块级说明（继承来源 / 灰行已剔除 / 叠加确认）
-->
<template>
  <div class="tvrb-ndc-block">
    <!-- 第一行：块标题（本块不是题材排名 ⇒ 没有排名圆点 / 数量 / 平均量比） -->
    <div class="tvrb-ndc-head">
      <span class="tvrb-ndc-title tvrb-selectable">{{ block.block.topic }}</span>
      <span class="tvrb-ndc-badge">次日承接</span>
    </div>
    <!-- 第二行：选择理由（明细到「为什么延迟一天买」） -->
    <div class="tvrb-ndc-reason tvrb-selectable">
      选择理由：{{ block.reason }}<span
        v-if="block.ruleNo"
        class="tvrb-rule-no"
      >（规则{{ block.ruleNo }}）</span>
    </div>
    <!-- 第三行起：今天真正要买的票 -->
    <div
      v-for="p in block.picks"
      :key="p.name"
      class="tvrb-ndc-row"
    >
      <span class="tvrb-ndc-seq">{{ p.seq }}</span>
      <span
        class="tvrb-ndc-name tvrb-selectable"
        :title="p.actionNote || ''"
      >{{ p.name }}</span>
      <span
        v-if="p.code"
        class="tvrb-ndc-code"
      >{{ p.code }}</span>
      <span
        v-if="p.pctText"
        class="tvrb-ndc-pct"
      >{{ p.pctText }}</span>
      <span
        v-if="p.buyActionTag"
        class="tvrb-ndc-tag"
      >{{ p.buyActionTag }}</span>
    </div>
    <!-- 块级说明（继承来源 / 灰行已剔除 / 为什么不算重复选错） -->
    <div
      v-for="(n, i) in (block.notes || [])"
      :key="'ndc-note-' + i"
      class="tvrb-ndc-note tvrb-selectable"
    >
      {{ n }}
    </div>
  </div>
</template>

<script setup>
// §21：本组件零业务计算 —— 标题 / 理由 / 票名 / 代码 / 涨幅 / 标签 / 说明全由 Logic 层给。
// ⚠️ 刻意【不】引入分笔面板 / 龙标 / 占比：本块是跨日的「兑现」语义，不参与今天的题材竞争。
defineProps({
  block: { type: Object, required: true }
});
</script>

<style scoped>
/* 视觉沿用本看板既有的「独立买点块」语言（白底 + 左侧琥珀金竖条），⛔ 不新造一套观感。
   与第二十八「新龙」那一块同色系：同一条规则，只是执行日不同。 */
.tvrb-ndc-block {
    margin: 8px 0;
    padding: 8px 10px;
    border-left: 4px solid #d97706;
    border-radius: 6px;
    background: #fffbeb;
}

.tvrb-ndc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: #92400e;
}

.tvrb-ndc-badge {
    padding: 0 6px;
    border: 1px solid #d97706;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    color: #b45309;
}

.tvrb-ndc-reason {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.6;
    color: #7c2d12;
}

.tvrb-ndc-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 13px;
}

.tvrb-ndc-seq {
    width: 18px;
    color: #92400e;
    text-align: right;
}

.tvrb-ndc-name {
    font-weight: 600;
    color: #1f2937;
}

.tvrb-ndc-code,
.tvrb-ndc-pct {
    font-size: 12px;
    color: #6b7280;
}

.tvrb-ndc-tag {
    padding: 0 6px;
    border-radius: 4px;
    background: #fde68a;
    font-size: 11px;
    color: #92400e;
}

.tvrb-ndc-note {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.6;
    color: #78350f;
}
</style>
