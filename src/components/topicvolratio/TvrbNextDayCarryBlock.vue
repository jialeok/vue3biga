<!--
  TvrbNextDayCarryBlock.vue — 第二十八条【次日承接 · 新龙】的独立小买点块（昨天选、今天买）

  ★★ 来由（2026-11-27 用户口径 · 规则手册八修 / 九修，逐字）：
    「第二十八条选票是对的，但是买点不对，应该是在次日买……次日要继承下第二十八条次日买的票……
      灰色行的股票不要继承……只继承一天啊，不要无限继承。继承时也要有说明文字，大概意思是
      切换题材的新龙延迟一天（今天）买更加准确，刚好第三天，老龙已经彻底杀完，新龙就开始吹响反攻号角。」
    「华东重机如果是继承11月19日的，买点侧那里应该再打上标签继承买，不然我不知道是不是继承的票，
      还是其它规则选出的票……简洁版。」

  ── 视觉口径（2026-11-28 用户：「样式需要美化下，要简洁美观」）───────────────
    ① **一屏只占三行**：标题一行 + 票一行 + 「为什么今天买？」一行（默认收起）；
       大段说明收进可展开面板 ⛔ 不再铺在卡片里（原来那块光理由就占半屏，和别的卡片完全不搭）。
    ② 标题固定写「次日承接 · 新龙」，日期拆成右侧小字（⛔ 不再拼进标题导致换行 + 徽标被挤下去）。
    ③ 票名 + 【继承买】小徽标 + 代码/涨幅，与看板其它行的字号对齐（13px 级别）。
    ④ 琥珀色左竖条 = 跨日承接通道（与「今天现选」的卡片区隔），其余留白保持干净。

  ── 为什么单独一个组件（⛔ 不要并回 TvrbBuyBlock.vue）────────────────────────
    TvrbBuyBlock 是「**今天**按题材选出来的票」，行内要塞十几列客观数据（龙位 / 占比 / 量比 /
    封单 / 分笔展开面板）；本块是「**昨天**选出来、今天兑现」的跨日语义，只关心
    「是哪几只 + 为什么是今天买」。混在一起以后改任一条规则都会互相污染（用户「避免搞混以前逻辑」）。

  ── 边界（§21 模板零计算）──────────────────────────────────────────────────
    票名 / 代码 / 涨幅 / 标签 / 说明文字 **全部** 由 Logic 层 `logic/topicvolratio/nextday-buy.js`
    预先算好；本组件只负责摆字段 + 一个纯 UI 的「展开说明」开关（§34：展开态属于 UI State）。

  ── 数据形状（`out.nextDayCarry`，来源见 nextday-buy.js#buildNextDayCarryBlock）──────
    nextDayCarrySrcDate : string   选票日（= 上一交易日）
    reason              : string   一句话理由（展开面板首行）
    picks : [{ seq, name, code, pctText, buyActionTag, actionNote }]
    notes : string[]               展开面板的说明条目（含「延迟一天更准」原话口径）
-->
<template>
  <section class="tvrb-ndc">
    <!-- ① 标题行：固定文案 + 选票日小字 + 通道徽标（都压在一行内，⛔ 不换行） -->
    <header class="tvrb-ndc-hd">
      <span
        class="tvrb-ndc-dot"
        aria-hidden="true"
      />
      <span class="tvrb-ndc-title tvrb-selectable">次日承接 · 新龙</span>
      <span class="tvrb-ndc-date">{{ block.nextDayCarrySrcDate }} 选出</span>
    </header>

    <!-- ② 票行：票名 + 【继承买】+ 代码/涨幅（数据拿不到就只留票名，§10 不猜） -->
    <div
      v-for="p in block.picks"
      :key="p.name"
      class="tvrb-ndc-item"
      :title="p.actionNote || ''"
    >
      <span class="tvrb-ndc-name tvrb-selectable">{{ p.name }}</span>
      <span class="tvrb-ndc-tag">{{ p.buyActionTag || '继承买' }}</span>
      <span
        v-if="p.code"
        class="tvrb-ndc-meta"
      >{{ p.code }}</span>
      <span
        v-if="p.pctText"
        class="tvrb-ndc-meta"
      >{{ p.pctText }}</span>
    </div>

    <!-- ③ 说明：默认收起（纯 UI 状态，⛔ 不参与任何业务判定） -->
    <button
      class="tvrb-ndc-more"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <span class="tvrb-ndc-caret">{{ open ? '▾' : '▸' }}</span>
      {{ open ? '收起说明' : '为什么是今天买？' }}
    </button>
    <div
      v-if="open"
      class="tvrb-ndc-why"
    >
      <p class="tvrb-ndc-why-lead tvrb-selectable">
        {{ block.reason }}
      </p>
      <p
        v-for="(n, i) in (block.notes || [])"
        :key="'ndc-note-' + i"
        class="tvrb-ndc-why-item tvrb-selectable"
      >
        {{ n }}
      </p>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue';

// §21：本组件零业务计算 —— 标题 / 日期 / 票名 / 代码 / 涨幅 / 标签 / 说明全由 Logic 层给。
// ⚠️ 刻意【不】引入分笔面板 / 龙标 / 占比：本块是跨日的「兑现」语义，不参与今天的题材竞争。
defineProps({
  block: { type: Object, required: true }
});

// 说明默认收起：卡片保持三行高度（§17 只让用户点开的局部展开，不影响其它块重算）
const open = ref(false);
</script>

<style scoped>
/* 与看板其余卡片的观感对齐：白底 / 10px 圆角 / 极淡描边；琥珀竖条只用来标注「跨日通道」 */
.tvrb-ndc {
    margin: 8px 0;
    padding: 9px 11px;
    border: 1px solid #f3e6cf;
    border-left: 3px solid #d97706;
    border-radius: 10px;
    background: #fffdf8;
}

/* 标题行：不换行，日期与标题同一基线；长文案走省略（⛔ 不许把徽标挤到下一行） */
.tvrb-ndc-hd {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.tvrb-ndc-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #d97706;
}

.tvrb-ndc-title {
    font-size: 13px;
    font-weight: 600;
    color: #92400e;
    white-space: nowrap;
}

.tvrb-ndc-date {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 400;
    color: #a8a29e;
}

/* 票行：票名 13px 加粗，徽标 10px，代码/涨幅 11px 灰 —— 与看板行同层级 */
.tvrb-ndc-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
}

.tvrb-ndc-name {
    font-size: 13.5px;
    font-weight: 600;
    color: #1f2937;
}

.tvrb-ndc-tag {
    padding: 1px 6px;
    border-radius: 5px;
    background: #fde68a;
    font-size: 10px;
    font-weight: 500;
    line-height: 1.5;
    color: #92400e;
    white-space: nowrap;
}

.tvrb-ndc-meta {
    font-size: 11px;
    color: #9ca3af;
}

/* 说明开关：一行纯文字，不带边框，像链接但更轻 */
.tvrb-ndc-more {
    margin-top: 8px;
    padding: 0;
    border: 0;
    background: none;
    font-size: 11px;
    line-height: 1.6;
    color: #b45309;
    cursor: pointer;
}

.tvrb-ndc-more:hover {
    color: #92400e;
    text-decoration: underline;
}

.tvrb-ndc-caret {
    margin-right: 2px;
    font-size: 10px;
}

/* 展开面板：浅色底把长文本和票行分开，行高放宽便于阅读 */
.tvrb-ndc-why {
    margin-top: 6px;
    padding: 7px 9px;
    border-radius: 7px;
    background: #fffbeb;
}

.tvrb-ndc-why-lead {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.65;
    color: #7c2d12;
}

.tvrb-ndc-why-item {
    position: relative;
    margin: 5px 0 0;
    padding-left: 9px;
    font-size: 11.5px;
    line-height: 1.65;
    color: #78716c;
}

.tvrb-ndc-why-item::before {
    content: '·';
    position: absolute;
    left: 0;
    color: #d97706;
}
</style>
