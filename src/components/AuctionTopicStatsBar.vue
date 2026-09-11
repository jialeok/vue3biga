<!--
  AuctionTopicStatsBar.vue — 题材分组统计条（纯展示组件，§3 / §29 Row-Cell 组件边界）

  放在【每个题材块的第一行上方】。所有统计与格式化都在 Logic 层 topic-stats.js 算好，
  本组件只做 v-for 渲染（§21 模板不做重型计算）。

  排版契约（2026-09-10）：整条【隐形】分左右两格，中间与行间均无分隔线
    左格（窄）：题材名，字号更大更显眼
    右格（宽）：两行 —— 上行「数量 / 一字 / 竞价高开 / 收盘 / 停板」，下行「龙头 / 竞价 / 十日」
  [TOPIC-STATS-COLOR 2026-09-11] 下行「竞价」数值按【当天竞价涨幅】符号着色
    （>0 红 / <0 绿 / =0 灰）；下行其余两段（龙头名、十日）保持统一红色加粗不变。
  [CLOSE-COUNT 2026-09-11] 上行「收盘」= 同题材收盘涨跌家数（2红9绿，红字红、绿字绿）；
    「停板」= 同题材收盘涨停/跌停家数。两者都只在收盘口径日期产出，且由 Logic 层决定是否产出。
    多段拼接段由 Logic 层给出 parts（[{text,tone}]），本组件只做 v-for（§21 零计算）。

  ⚠️ 不要加左侧竖条 / 配色高光：与「卖」标签的灰黑色块视觉冲突，会看乱（用户明确要求去掉）。
  数据缺失的段（如次新股没有 10 日区间涨幅）在 Logic 层就不会产出，这里不补 0 / '-'（§10）。
  单只股票的题材在 Logic 层就不产出统计对象 → 父级 v-if 直接不渲染。
-->
<template>
  <div
    v-if="layout"
    class="auction-topic-stats"
  >
    <div class="ats-left">
      {{ layout.topic }}
    </div>
    <div class="ats-right">
      <div class="ats-line">
        <span
          v-for="s in layout.row1"
          :key="s.key"
          class="ats-item"
        ><b>{{ s.label }}</b><i
          v-if="s.parts"
          class="ats-parts"
        ><span
          v-for="p in s.parts"
          :key="p.text"
          :class="'ats-tone-' + p.tone"
        >{{ p.text }}</span></i><i v-else>{{ s.value }}</i></span>
      </div>
      <div
        v-if="layout.row2.length"
        class="ats-line ats-line2"
      >
        <span
          v-for="s in layout.row2"
          :key="s.key"
          class="ats-item"
        ><b>{{ s.label }}</b><i :class="[s.strong ? 'ats-strong' : null, s.tone ? 'ats-' + s.tone : null]">{{ s.value }}</i></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatTopicStatsLayout } from '../logic/auction/topic-stats.js';

const props = defineProps({
  stats: { type: Object, default: null }
});

const layout = computed(() => formatTopicStatsLayout(props.stats));
</script>

<style scoped>
/* 统一浅灰底 + 上下留白，用于把相邻题材块分开；刻意【不做】左侧竖条/色块高光，
   避免与「卖」等灰黑标签色块混淆。左右两格是隐形划分，不画任何分隔线。 */
.auction-topic-stats {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  flex-basis: 100%;
  padding: 3px 6px;
  margin: 2px 0 1px;
  background: #f1f5f9;
  border-radius: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: #475569;
}

/* 左格窄：题材名，字号更大更显眼 */
.ats-left {
  flex: 0 0 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  display: flex;
  align-items: center;
}

/* 右格宽：上下两行 */
.ats-right {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}

.ats-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  min-width: 0;
}

.ats-item {
  white-space: nowrap;
}

.ats-item > b {
  color: #64748b;
  font-weight: 400;
  margin-right: 3px;
}

.ats-item > i {
  font-style: normal;
  font-weight: 600;
  color: #334155;
}

/* [CLOSE-COUNT 2026-09-11] 多段拼接值（如「2红9绿」/「1涨停2跌停」）：
   每段自带 tone，颜色由 Logic 层给出，这里只做 class 映射（§21）。
   与「卖」标签的灰黑色块无关；不引入任何底纹/色块，仅改文字颜色。 */
.ats-item > i.ats-parts {
  display: inline-flex;
  gap: 3px;
}
.ats-item > i.ats-parts > .ats-tone-up {
  color: #dc2626;
}
.ats-item > i.ats-parts > .ats-tone-down {
  color: #059669;
}
.ats-item > i.ats-parts > .ats-tone-flat {
  color: #94a3b8;
}

/* 第二行（龙头）：股票名 / 竞价 / 十日三个数值统一红色加粗强调。
   [2026-09-10] 用户明确要求：第二行数值一律红色，不再按涨跌分红绿（ats-up/ats-down 已删）。 */
.ats-item > i.ats-strong {
  color: #dc2626;
  font-weight: 700;
}

/* [TOPIC-STATS-COLOR 2026-09-11] 第二行「竞价」数值改为跟随【当天竞价涨幅】符号着色：
   >0 红 / <0 绿 / =0 灰（与龙头徽章同口径，涨红跌绿）。
   只覆盖颜色、加粗强调不变；tone 由 Logic 层 topic-stats.js 给出，这里只做 class 映射（§21）。
   ⚠️ 必须写在 .ats-strong 之后：两者特异性相同（0,2,1），靠书写顺序让 tone 覆盖红色。
   龙头名与「十日」不带 tone，仍是上面的统一红色（用户 2026-09-10 口径未变）。 */
.ats-item > i.ats-up {
  color: #dc2626;
}
.ats-item > i.ats-down {
  color: #059669;
}
.ats-item > i.ats-flat {
  color: #94a3b8;
}
</style>
