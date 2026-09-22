<!--
  AuctionTopicTrendPanel.vue — 题材统计条【展开后】的五日趋势面板（§3 纯展示组件 / §29 Row-Cell 边界）

  点题材统计条 → 本组件出现在统计条下方；再点统计条 → 收起（默认收起，省空间）。
  两张图（与股票的五日趋势图同一套 TrendChart，§30 图表复用）：
    · 上图【题材名次】—— 该题材在这五个交易日里、题材 toggle 单独开启时的名次（1 = 最强）。
      名次由【一字数量】决定（与 sortByTopicGroups 同一把尺子：一字降序 → 组大小降序 → 题材名升序）。
      纵轴已反转（TrendChart 的 invert）：第 1 名画在最上面，「线往上走 = 名次变强」。
    · 下图【一字数量】—— 该题材每天的一字只数，越往上越强。

  ⛔ 不含「补竞价一字」补进来的股票：那部分一字涨停数量不算。
     这不是运行时过滤，而是结构性排除 —— 序列的输入只有当日早盘竞价自己的列表
     （见 logic/auction/topic-trend.js 文件头），补入行根本不在输入里。

  §10 红线：某日无数据 → 该日画成 '--' 断点，绝不补 0（0 与「没数据」是两回事）；
     整个窗口都没有该题材 → 给一句说明，⛔ 不画两张空图凑数。

  本组件不做任何计算：序列由 Logic 层算好，经 inject('auctionTopicTrend') 取用（§21 模板零计算）。
-->
<template>
  <div
    class="att-panel"
    @dblclick.stop
  >
    <div
      v-if="errorText"
      class="att-error"
    >
      {{ errorText }}
    </div>
    <template v-else-if="series">
      <div
        v-if="!series.hasRank && !series.hasYizi"
        class="att-empty"
      >
        近{{ series.dayCount }}个交易日没有该题材的成组数据
      </div>
      <template v-else>
        <div
          v-if="series.hasRank"
          class="att-chart"
        >
          <div class="att-label">
            <span>题材名次 近{{ series.dayCount }}日</span>
            <span class="att-hint">1=最强</span>
          </div>
          <TrendChart
            :points="series.rankPoints"
            color="#f59e0b"
            :height="46"
            :dot-radius="2.5"
            invert
          />
        </div>
        <div
          v-if="series.hasYizi"
          class="att-chart"
        >
          <div class="att-label">
            <span>一字数量 近{{ series.dayCount }}日</span>
            <span class="att-hint">不含补一字</span>
          </div>
          <TrendChart
            :points="series.yiziPoints"
            color="#dc2626"
            :height="46"
            :dot-radius="2.5"
          />
        </div>
      </template>
    </template>
    <div
      v-else
      class="att-empty"
    >
      暂无趋势数据
    </div>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue';
import TrendChart from './TrendChart.vue';

const props = defineProps({
  // 题材名（与统计条 layout.topic 同源）
  topic: { type: String, default: '' }
});

// 与统计条 / 早盘竞价看板共用同一个组合式实例（§6 单一真相），本组件不新建任何状态。
const topicTrend = inject('auctionTopicTrend');
const { seriesOf, errorText } = topicTrend;

const series = computed(() => seriesOf(props.topic));
</script>

<style scoped>
/* 省空间：紧贴统计条下方，浅灰底与统计条同一色系，两张图上下堆叠。 */
.att-panel {
  width: 100%;
  flex-basis: 100%;
  padding: 2px 6px 5px;
  margin: 0 0 2px;
  background: #f8fafc;
  border-radius: 0 0 2px 2px;
  box-sizing: border-box;
}

.att-chart + .att-chart {
  margin-top: 2px;
}

.att-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  line-height: 1.3;
  color: #64748b;
}

.att-hint {
  font-size: 9px;
  color: #94a3b8;
}

.att-empty,
.att-error {
  font-size: 10px;
  line-height: 1.5;
  padding: 3px 0;
}

.att-empty {
  color: #94a3b8;
}

/* §10：计算失败必须看得见，⛔ 不静默成「没有数据」 */
.att-error {
  color: #b91c1c;
}
</style>
