<!--
  TvrbDeviationBoard.vue — 「官方偏离值」参考面板（题材量比 · 买点侧上方）

  ★★ [ABN-DEV 2026-11-14 用户口径]
    用户原话：「这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，我看一遍股票或者
      市场前十，就知道怎么参考了」「九阳股份 002242 30日偏离 199.9 ⇒ 距 200% 只差 0.1 个点，
      周一只要不跌就构成严重异常波动」。

    这张表就是为了「扫一眼就知道怎么参考」：市场前十（20日涨幅主板口径）+ 买点侧的票，
    逐行给出 10 日 / 30 日偏离值，以及「离交易所红线还有多远」。

  ★★ [ABN-DEV-UX 2026-11-14 用户当场定的版式]
    用户原话：「你在UI设计上把『距 200% 差 130.8 点（股价再涨约 +80%）』单独一行，
      相当于一只股票有两行，横排文字，这样更美观简洁，还有把计算公式具体的也一起标注在上头，
      我自己也要验证下。」
    第三轮补充：「对应指数指的是什么？大盘指数？还是沪市指数，还是深市指数？
      你在股票名称后面标注下，顺便在提示板上面说明下」。
    ⇒ 面板顶部加「对应指数是什么？」四行说明（板块 → 指数名 + 代码，明确排除三大误用指数）；
      第一行票名后加一枚「深证A股指数」式小标签，悬停给代码与板块，判不出 ⇒ 不渲染（§10）。

    ⇒ 版式固定成【一只票两行】：
        第 1 行：票（含档位小标签） | 10日偏离 | 30日偏离
        第 2 行：股价再涨约 +5.2%（数值条件标红 + 灰字「同期指数不动 · 条件估算」）
                 → 灰字「自核 30日：…」→ 灰字「距 200% 差 14.5 点」→ 灰字「指数 ±1% ⇒ …（β…）」
      顶部「计算公式（可自核）」五条：三条等式 + 指数敏感度 β 通式与窗口滚动声明 + ±1%/±2% 具体算例。

    ★ [DEV-LAYOUT 2026-11-15 用户「排版出现问题，右边文字超出了看板边界」]
      手机窄屏上第一列「票名 + 指数标签 + 档位 chip」把整张表撑破父容器，10日/30日两列被裁。
      ⇒ 【DOM 与文案一行不改】，只在 topic-vol-ratio-board.css 把表格收成 table-layout:fixed +
        三列定宽，票名列与整行横排文案允许自动折行，两枚 chip 作为整体换行。
      ⛔ 红线：「一只票两行 + 横排文字」的版式不变；⛔ 不许用 overflow:hidden 裁字来「修」；
        ⛔ 不许退回 auto 表格布局（回归锁见 deviation-overlay.test.js 的 [DEV-LAYOUT] 三条）。

  ── 红线 ────────────────────────────────────────────────────────────────────────
    · §21 模板零计算：所有文本（含「距 200% 差 0.1 点（股价再涨约 +0.02%）」「自核 30日：
      +178.9% − (-6.6%) = +185.5%」「计算公式三行」）都由
      `logic/auction/abnormal-deviation.js` 与 `useAbnormalDeviation.js` 拼好，
      本组件只做 v-for + 类名映射，⛔ 不在这里算任何百分比；
    · §10：判不出的票【仍然出行】、数值写「—」、第二行写「未就绪」——
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
    <!-- ★★ [IDX-LABEL 2026-11-14 用户「对应指数指的是什么？顺便在提示板上面说明下」]：
         这块回答「减的是谁」，下面公式块回答「怎么减」。四行映射由 Logic 层给
         （DEV_INDEX_NOTE_LINES，源表 DEV_INDEX），⛔ 视图里不手写指数名或代码（§6）。 -->
    <div
      v-if="meta.indexNoteLines && meta.indexNoteLines.length"
      class="tvrb-dev-index-note tvrb-selectable"
    >
      <div class="tvrb-dev-index-note-head">
        对应指数是什么？
      </div>
      <div
        v-for="(line, i) in meta.indexNoteLines"
        :key="i"
        class="tvrb-dev-index-note-line"
      >
        {{ line }}
      </div>
    </div>
    <!-- ★ [ABN-DEV-UX 2026-11-14] 计算公式（用户「我自己也要验证下」）：
         三行公式 + 一个真实算例，由 Logic 层给（DEV_FORMULA_LINES），模板只 v-for。 -->
    <div
      v-if="meta.formulaLines && meta.formulaLines.length"
      class="tvrb-dev-formula tvrb-selectable"
    >
      <div class="tvrb-dev-formula-head">
        计算公式（可自核）
      </div>
      <div
        v-for="(line, i) in meta.formulaLines"
        :key="i"
        class="tvrb-dev-formula-line"
      >
        {{ line }}
      </div>
    </div>
    <table class="tvrb-dev-table">
      <thead>
        <tr>
          <th>票</th>
          <th>10日偏离</th>
          <th>30日偏离</th>
        </tr>
      </thead>
      <tbody>
        <!-- 一只票两行：上面是三个短数字，下面是整行横排的「距红线 + 自核算式」 -->
        <template
          v-for="r in rows"
          :key="r.name"
        >
          <tr
            class="tvrb-dev-row-main"
            :class="r.tone ? ('tvrb-dev-tone-' + r.tone) : ''"
          >
            <td class="tvrb-dev-cell-name">
              <span class="tvrb-dev-name">{{ r.name }}</span><span
                v-if="r.indexLabelText"
                class="tvrb-dev-index-tag"
                :title="r.indexLabelTitle"
              >{{ r.indexLabelText }}</span><span
                v-if="r.stageText"
                class="tvrb-dev-stage"
                :class="'tvrb-dev-stage-' + (r.tone || 'muted')"
              >{{ r.stageText }}</span>
            </td>
            <td>{{ r.dev10Text }}</td>
            <td>{{ r.dev30Text }}</td>
          </tr>
          <tr
            class="tvrb-dev-row-gap"
            :class="r.tone ? ('tvrb-dev-tone-' + r.tone) : ''"
            :title="r.title"
          >
            <td colspan="3">
              <!-- ★ [IDX-MOVE 2026-11-14 用户定的第二行] 主段只留「股价再涨约 +5.2%」，
                   数值接近警示（near / severe / 需涨 ≤10%）标红；后面三段全灰：
                   自核算式 → 距红线点差 → 指数 ±1% 的具体影响。 -->
              <span
                v-if="r.needValueText"
                class="tvrb-dev-need-main"
              >股价再涨约 <span
                class="tvrb-dev-need-value"
                :class="r.needTone === 'alert' ? 'tvrb-dev-need-alert' : ''"
              >{{ r.needValueText }}</span><span class="tvrb-dev-need-hint">{{ r.needHintText }}</span></span>
              <span
                v-else
                class="tvrb-dev-need-main"
              >{{ r.gapText }}</span>
              <span
                v-if="r.calcText"
                class="tvrb-dev-gap-calc"
              >{{ r.calcText }}</span>
              <span
                v-if="r.gapTailText"
                class="tvrb-dev-gap-calc"
              >{{ r.gapTailText }}</span>
              <span
                v-if="r.indexMoveText"
                class="tvrb-dev-gap-calc"
              >{{ r.indexMoveText }}</span>
            </td>
          </tr>
        </template>
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
  /**
   * 有序行，一只票一个元素（视图负责展开成两行）：
   * [{ name, indexLabelText, indexLabelTitle, dev10Text, dev30Text, gapText, calcText,
   *    needValueText, needHintText, needTone, gapTailText, indexMoveText,
   *    stageText, stage, tone, ok, title }]
   * 文案已拼好（§21）
   */
  rows: { type: Array, default: () => [] },
  /** { visible, title, subText, warnText, ready, total, basisText,
   *    indexNoteLines, formulaLines } —— 全部由 Logic 层算好 */
  meta: { type: Object, default: () => ({}) }
});
</script>
