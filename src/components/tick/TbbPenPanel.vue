<!--
  TbbPenPanel.vue — 「分笔买卖」看板展开后的【那一分钟的明细】面板（独立组件）

  用户口径（2026-10-10）：
    「点击股票名称和序号，展开那一分钟的 20 笔明细」
    「东财的：箭头向上表示价格上涨（对比上一笔交易），箭头向下表示价格下跌，没有箭头，价格相平的」

  面板内容：
    · 标题行：股票名 + 09:30~09:31 + 共 N 笔 + ↑a ↓b 平c + 上游成交笔数
    · 明细表：序号 / 时间 / 价格 / 手数 / 涨跌箭头
      - 上涨 → 红 + ↑；下跌 → 绿 + ↓；平盘 → 绿 + 无箭头（与东财口径一致）
      - 第一笔没有上一笔可比 ⇒ 手数显示「—」（⛔ 绝不拿累计量冒充单笔量）
    · 底部注释：把「上游快照数 ≠ 成交笔数」以及第一笔的基准讲清楚（§10 不糊弄）
    · ★ 最下方：分析过程 + 买卖点逻辑（用户 2026-10-10 要求「写到股票展开分笔订单最下那里
      说明下…相当于一个分析过程，和买卖点逻辑，简洁」，逐行文案由 Logic 层给）

  ⚠️ 单位：明细里的「手数」就是【手】（与东财/同花顺同口径）。
     2026-10-10 实测更正：上游 vol 的差分值本身就是手，⛔ 不要再 ÷100。

  §21：本组件零计算 —— 标题 / 注释 / 分析提示 / 每行的价格文案 / 手数文案 / 箭头 / 配色档
       全部由 logic/tick/tick-minute.js 预先算好（title / note / hint[] / pens[]）。
-->
<template>
  <div class="tbb-panel">
    <div class="tbb-panel-title">
      {{ title }}
    </div>
    <div
      v-if="pens.length > 0"
      class="tbb-pen-table"
    >
      <div class="tbb-pen-row tbb-pen-head">
        <span class="tbb-pen-seq">#</span>
        <span class="tbb-pen-time">时间</span>
        <span class="tbb-pen-price">价格</span>
        <span class="tbb-pen-vol">手数</span>
        <span class="tbb-pen-dir">涨跌</span>
      </div>
      <div
        v-for="p in pens"
        :key="p.seq"
        class="tbb-pen-row"
        :class="p.tone ? ('tbb-pen-' + p.tone) : ''"
      >
        <span class="tbb-pen-seq">{{ p.seq }}</span>
        <span class="tbb-pen-time">{{ p.time }}</span>
        <span class="tbb-pen-price">{{ p.priceText }}</span>
        <span class="tbb-pen-vol">{{ p.volText }}</span>
        <span
          class="tbb-pen-dir"
          :title="p.title"
        >{{ p.arrow ? p.arrow : '—' }}</span>
      </div>
    </div>
    <div
      v-else
      class="tbb-pen-empty"
    >
      这一分钟没有可用的成交明细
    </div>
    <div
      v-if="note"
      class="tbb-panel-note"
    >
      {{ note }}
    </div>
    <!-- ★ 最下方：分析过程 + 买卖点逻辑（用户 2026-10-10：「写到股票展开分笔订单最下那里
         说明下…相当于一个分析过程，和买卖点逻辑，简洁」）—— 逐行文案由 Logic 层给，模板零计算 -->
    <div
      v-if="hint && hint.length"
      class="tbb-panel-hint"
    >
      <div
        v-for="(line, i) in hint"
        :key="i"
        class="tbb-panel-hint-line"
      >
        {{ line }}
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  /** 标题行整段文案（Logic 层拼好，§21 模板零计算） */
  title: { type: String, default: '' },
  /** 底部口径注释（同上） */
  note: { type: String, default: '' },
  /** ★ 最下方的「分析过程 + 买卖点逻辑」逐行文案（同上；空数组 ⇒ 整块不渲染） */
  hint: { type: Array, default: () => [] },
  /** 明细行（已含 seq / time / priceText / volText / arrow / tone / title） */
  pens: { type: Array, default: () => [] }
});
</script>
