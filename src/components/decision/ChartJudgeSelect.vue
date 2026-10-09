<!--
  ChartJudgeSelect.vue — 「决策」看板的手动【竞价图形判断】三档小选择器（独立组件，⛔ 不复用其它看板组件）

  [CHART-JUDGE 2026-10-09 用户口径] 用户原话：
    「添加一个组件，这个组件有三个选项供我选择，一个是默认请选择，一个是竞图符合（预判当天走势会好），
      一个是竞图不符合（预判当天走势不好）……以我看到当天股票的竞价图形然后做判断为准。」
    「颜色显著些，可能这是我作为买卖点的最终判断。原来规则作为辅助……设计美观，简洁，节省空间为主。」

  排版（省空间口径）：
    · 一枚小胶囊，紧跟在该行【动作徽标 / 持有】之后：`[竞价图 默认｜符合｜不符]`
    · 渲染范围由 Logic 层的 chartJudgeTarget 决定（⛔ 组件不判）：
      🔴 [CHART-JUDGE-SELL-ALL 2026-10-09 用户口径]【卖点】每一行都渲染 —— 原标签是特殊标签
        （持有 / 跟龙竞价卖 / 10分钟时卖 / 竞价卖（先卖后买）/ 竞价涨停卖 / 龙一字持有）、
        甚至为空串（占比缺数据、只回落题材排名时点）时也一样，否则卖点整列都看不到选择器
        （用户原话「我要求的是卖点的股票也显示」）。
      【买点】只对 竞价买 / 尾盘买 两档渲染；特殊标签（先卖后买 / 下杀买 / 补涨竞价买 / 龙一字持有）
        【不渲染】—— 显示一枚点了也不生效的选择器，比不显示更误导（§10）。
    · 颜色显著：整枚胶囊的底 / 描边 / 外发光随当前档位变（默认 = 中性灰｜符合 = 红｜不符 = 绿），
      扫一眼就能看出「这一行我下过判断」，而不是只高亮里面那一小块。

  §6 单一真相：三个选项的文案 / 顺序 / 取值全部来自 logic/decision/decision-chart-judge.js
    （CHART_JUDGE_OPTIONS），⛔ 组件里不写一遍 label、不写 'ok'/'bad' 字面量。
  §21 模板零计算：胶囊文案与悬停说明由 Logic 层给常量，模板只渲染；本组件不做任何业务判断
    （连「点了之后标签会变成什么」都不知道 —— 那是 Logic 层的事，这里只 emit 一个值）。
  §34：本组件【无内部状态】—— 当前选中档位完全由 props（父级传的行数据）决定，
    开合真相只有一处（用户选择的判断存在 Logic 层的 chartJudgeState + 云端表）。
-->

<template>
  <span
    class="dcb-judge"
    :class="'dcb-judge-' + cur"
    :title="title"
  >
    <span class="dcb-judge-cap">{{ caption }}</span>
    <span
      v-for="o in options"
      :key="o.value"
      class="dcb-judge-opt"
      :class="['dcb-judge-opt-' + o.value, { on: cur === o.value }]"
      :title="o.title"
      @click.stop="pick(o.value)"
    >{{ o.label }}</span>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import {
  CHART_JUDGE_OPTIONS,
  CHART_JUDGE_CAPTION,
  CHART_JUDGE_TITLE,
  JUDGE_DEFAULT,
  normalizeChartJudge
} from '../../logic/decision/decision-chart-judge.js';

const props = defineProps({
  /** 当前判断：'default' | 'ok' | 'bad'（由 Logic 层算好放在行数据上，§21 组件不判） */
  judge: {
    type: String,
    default: JUDGE_DEFAULT
  }
});

const emit = defineEmits(['change']);

/** §6：选项只有一个来源（Logic 层），⛔ 不在这里另写一份 labels / 顺序 */
const options = CHART_JUDGE_OPTIONS;
const caption = CHART_JUDGE_CAPTION;
const title = CHART_JUDGE_TITLE;

/** §10：传来不认识的档位 ⇒ 显示成「默认」（绝不显示一个不存在的档位） */
const cur = computed(() => normalizeChartJudge(props.judge));

/**
 * 点某一档 → 交给父级去落库（§21：组件不写库、不判映射）。
 * ⛔ 重复点当前档位【不 emit】：白跑一次请求，还会因为乐观更新把同一天的数据无谓改写一次。
 */
function pick(v) {
  if (v === cur.value) return;
  emit('change', v);
}
</script>
