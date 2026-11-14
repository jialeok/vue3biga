<!--
  TvrbDeviationBoard.vue — 「官方偏离值」参考面板（题材量比 · 买点侧上方）

  ★★ [ABN-DEV 2026-11-14 用户口径]
    用户原话：「这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，我看一遍股票或者
      市场前十，就知道怎么参考了」「九阳股份 002242 30日偏离 199.9 ⇒ 距 200% 只差 0.1 个点，
      周一只要不跌就构成严重异常波动」。

    这张表就是为了「扫一眼就知道怎么参考」：市场前十（20日涨幅主板口径）+ 买点侧的票，
    逐行给出 10 日 / 30 日偏离值，以及「离交易所红线还有多远」。

  ── 红线 ────────────────────────────────────────────────────────────────────────
    · §21 模板零计算：所有文本（含「还需 +16%」「距 200% 仅 0.1 点」）都由
      `logic/auction/abnormal-deviation.js` 与 `useAbnormalDeviation.js` 拼好，
      本组件只做 v-for + 类名映射，⛔ 不在这里算任何百分比；
    · §10：判不出的票【仍然出行】、数值写「—」、gapText 写「未就绪」——
      ⛔ 绝不隐藏、⛔ 绝不补 0（缺数据必须看得见）；
    · ⛔ 纯只读：本面板不参与选股、不写库、不影响任何买点结论。
-->
<template>
  <div
    v-if="meta && meta.visible && rows.length"
    class="tvrb-dev-board tvrb-selectable"
  >
    <div class="tvrb-dev-board-head">
      <span>{{ meta.title }}</span>
      <span class="tvrb-dev-board-sub">{{ meta.subText }}</span>
    </div>
    <table class="tvrb-dev-table">
      <thead>
        <tr>
          <th>票</th>
          <th>10日偏离</th>
          <th>30日偏离</th>
          <th>距红线</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.name"
          :class="r.tone ? ('tvrb-dev-row-' + r.tone) : ''"
          :title="r.title"
        >
          <td>{{ r.name }}</td>
          <td>{{ r.dev10Text }}</td>
          <td>{{ r.dev30Text }}</td>
          <td>{{ r.gapText }}</td>
        </tr>
      </tbody>
    </table>
    <!-- §10：覆盖不全 / 口径不是竞价 / 读取失败 —— 一律如实写出来，⛔ 不静默 -->
    <div
      v-if="meta.warnText"
      class="tvrb-dev-warn"
    >
      {{ meta.warnText }}
    </div>
    <div
      v-if="meta.ready < meta.total"
      class="tvrb-dev-warn"
    >
      覆盖 {{ meta.ready }}/{{ meta.total }} 只（缺的票在表里显示「—」，不是「没有异动」）。
    </div>
  </div>
</template>

<script setup>
defineProps({
  /** 有序行：[{ name, dev10Text, dev30Text, gapText, tone, ok, title }]，文案已拼好 */
  rows: { type: Array, default: () => [] },
  /** { visible, title, subText, warnText, ready, total, basisText } —— 全部由 Logic 层算好 */
  meta: { type: Object, default: () => ({}) }
});
</script>
