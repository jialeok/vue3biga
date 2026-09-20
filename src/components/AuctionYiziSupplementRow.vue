<!--
  AuctionYiziSupplementRow.vue — 「补竞价一字」补入的一行（含展开后的 4 张趋势图）

  ★ 2026-09-20 修正：本行不再出现在底部一块「补充区」里，而是【按题材并入早盘竞价对应题材组的组内末尾】，
    因此列宽与早盘竞价行对齐（序号 0.4 / 股票名 1.2 / 其余 2.5 —— 与 .auction-number / .auction-stock-name /
    .auction-topic-cell 同值），让「同一题材组」在视觉上仍是一整段；并用「补」小标记标明它是补进来的。

  对应关系（「竞价一字」看板的行 → 本组件）：
    .yizi-row                → .auction-yizi-sup-row
    .yizi-seq (点它展开)      → .auction-yizi-sup-seq
    .yizi-name-block / -name → .auction-yizi-sup-name-block / -name
    .yizi-time-tag           → .auction-yizi-sup-time-tag
    .yizi-leader-badge       → .auction-yizi-sup-leader-badge
    .yizi-continue-tag       → .auction-yizi-sup-continue-tag
    .yizi-topics             → .auction-yizi-sup-topics
    .yizi-metric / -seal / -range → .auction-yizi-sup-metric / -seal / -range
    .yizi-trend-panel 一族    → .auction-yizi-sup-trend-* 一族

  ⚠️ 为什么整行都换前缀、不复用 .yizi-* ：
     `auction-yizi.css` 头注写得很清楚 —— CSS 是全局的，一字板的类名一旦被两个看板共用，
     将来改任何一个都会串改另一个（早盘竞价板历史上就被通用类名串改过）。
     本组件属于【早盘竞价看板】，因此用自己的 `auction-yizi-sup-` 前缀，与两边都隔离。

  §3 纯展示组件：只读 props.stock（Logic 纯函数搬运好的展示字段）+ inject('auctionYiziSupplement')
  的状态与回调；⛔ 不计算任何业务口径（十日涨幅 / 龙头 / 封单额全部直接渲染既有文本）。
-->
<template>
  <div
    class="auction-yizi-sup-row"
    :class="{ 'is-leader': stock.isLeader }"
  >
    <!-- 序号 = 趋势面板开关（与竞价一字看板、早盘竞价看板同一交互：点序号展开）
         ⚠️ 序号是「该题材内十日涨幅排名」，跳号表示中间那几只已在早盘竞价列表里（不重排，排名是真话）
         列宽 0.4 与早盘竞价行 .auction-number 同值 → 序号列与上方原有行严格对齐 -->
    <span
      class="auction-yizi-sup-seq is-clickable"
      title="点击展开该股近 5 日趋势（竞价量 / 昨日成交量 / 竞价涨幅 / 涨幅）"
      @click.stop="toggleTrend(stock.stock)"
    >{{ trendExpanded.has(stock.stock) ? '▼' : '▶' }}{{ stock.seq }}</span>
    <!-- 列宽 1.2 与 .auction-stock-name 同值 → 股票名列与上方原有行严格对齐 -->
    <span class="auction-yizi-sup-name-block">
      <span
        class="auction-yizi-sup-name"
        :class="{ leader: stock.isLeader }"
      >{{ stock.stock }}</span>
      <!-- ★ 补入小标记（用户要求「标注哪些是补进去的，有个小标记」）：
           悬停说清「从哪来、为什么在这一组」——被并入的组名由 Logic 层写在 mergedTopic 上 -->
      <span
        class="auction-yizi-sup-added"
        :title="addedTitle"
      >补</span>
      <!-- 封单额时点标：本补入行固定用「9:20 口径」（= 竞价一字看板的默认口径，切换开关在那边） -->
      <span
        class="auction-yizi-sup-time-tag"
        :title="'本行封单额口径：9:20（竞价一字看板默认口径）' +
          (stock.firstTimeText ? ('；该股首次封上涨停价 ' + stock.firstTimeText) : '')"
      >9:20</span>
      <span
        v-if="stock.isLeader"
        class="auction-yizi-sup-leader-badge"
        title="本题材内十日涨幅最高 → 该题材龙头"
      >龙头</span>
      <span
        v-if="stock.continueText"
        class="auction-yizi-sup-continue-tag"
        :title="'连板档位 ' + stock.continueText + '（按前一交易日连续涨停数递推）'"
      >{{ stock.continueText }}</span>
    </span>
    <!-- 其余列（题材 + 封单额 + 十日涨幅）合占 2.5，与 .auction-topic-cell 同值：
         补入行要展示的字段比原有行多，所以在这个宽度内再分成「题材(吃满) + 两个数值(定宽)」 -->
    <span class="auction-yizi-sup-rest">
      <!-- 题材（主角列）：完整展示、允许折行，⛔ 不做省略号截断 -->
      <span
        class="auction-yizi-sup-topics"
        :title="stock.topicsDisplay"
      >{{ stock.topicsDisplay }}</span>
      <!-- 度量列：封单额(9:20) + 十日涨幅（与竞价一字看板「未打开 9点25」时的形态一致） -->
      <span class="auction-yizi-sup-metric">
        <span
          class="auction-yizi-sup-seal"
          :class="sealClass"
          :title="sealTitle"
        >{{ stock.seal920Text || '-' }}</span>
        <span
          class="auction-yizi-sup-range"
          :class="rangeClass"
          title="近 10 个交易日区间涨幅（一字看板块内排序 / 龙头判据）"
        >{{ stock.rangeText || '-' }}</span>
      </span>
    </span>
  </div>

  <!-- ============ 趋势面板（与竞价一字看板同形、同数据通道）============
       🔴 数据来自竞价一字自己的库 / 自己的猫抓小号（Edge /trend），⛔ 与早盘竞价的 numcat 主账号无关。
       §22 懒加载：点序号第一次展开时才取；§26 日期不对齐时 trendMap 为空 → 这里显示「暂无」。 -->
  <div
    v-if="trendExpanded.has(stock.stock)"
    class="auction-yizi-sup-trend-panel"
    @dblclick.stop
    @click.stop
  >
    <div class="auction-yizi-sup-trend-metrics">
      <span class="auction-yizi-sup-trend-metric-item">
        <b>十日涨幅</b>：<span :class="rangeClass">{{ stock.rangeText || '-' }}</span>
      </span>
      <span
        v-for="m in trendMetrics(stock.stock)"
        :key="m.label"
        class="auction-yizi-sup-trend-metric-item"
      ><b>{{ m.label }}</b>：{{ m.value }}</span>
    </div>

    <div
      v-if="trendLoading && trendEmpty(stock.stock)"
      class="auction-yizi-sup-trend-loading"
    >
      加载中…（正在取近 5 日趋势）
    </div>
    <div
      v-else-if="trendEmpty(stock.stock)"
      class="auction-yizi-sup-trend-empty"
    >
      {{ trendLoading ? '加载中…' : '近 5 日暂无趋势数据（9:25 抓取完成后自动补）' }}
    </div>

    <template v-else>
      <div class="auction-yizi-sup-trend-chart-item">
        <div class="auction-yizi-sup-trend-chart-label">
          竞价量(万) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].volume"
          color="#6366f1"
        />
      </div>
      <div
        v-if="trendHasLeg(stock.stock, 'yestVolume')"
        class="auction-yizi-sup-trend-chart-item"
      >
        <div class="auction-yizi-sup-trend-chart-label">
          昨日成交量(万) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].yestVolume"
          color="#10b981"
        />
      </div>
      <div
        v-if="trendHasLeg(stock.stock, 'aucPctChg')"
        class="auction-yizi-sup-trend-chart-item"
      >
        <div class="auction-yizi-sup-trend-chart-label">
          竞价涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].aucPctChg"
          color="#f59e0b"
          :percent="true"
        />
      </div>
      <div
        v-if="trendHasLeg(stock.stock, 'changePct')"
        class="auction-yizi-sup-trend-chart-item"
      >
        <div class="auction-yizi-sup-trend-chart-label">
          涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].changePct"
          color="#64748b"
          :percent="true"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue';
import TrendChart from './TrendChart.vue';

const props = defineProps({
  // mergeYiziIntoAuctionRows 产出的显示行（字段已全部是可直出文本 + mergedTopic）
  stock: { type: Object, required: true }
});

const sup = inject('auctionYiziSupplement');
const {
  trendExpanded, trendMap, trendLoading,
  trendMetrics, trendHasLeg, trendEmpty, toggleTrend
} = sup;

// 色调档 → class 名（档位由一字看板算好，这里只做映射，§21 模板不做业务计算）
const sealClass = computed(() => 'auction-yizi-sup-seal-' + ((props.stock && props.stock.seal920Tone) || 'flat'));
const rangeClass = computed(() => 'auction-yizi-sup-range-' + ((props.stock && props.stock.rangeTone) || 'flat'));

// 悬停说明：把封单额口径与 9:25 的变化量都讲清楚（变化量不占列宽，但不丢信息）
const sealTitle = computed(() => {
  const s = props.stock || {};
  let t = '9:20 口径封单额';
  if (s.sealDeltaText) t += '；9:25 较 9:20 的变化量 ' + s.sealDeltaText;
  return t;
});

// 「补」标的悬停说明：讲清「从哪来、为什么在这一组」
//   · 融进某题材组 → 说出组名（用户可核对「按题材融入」这件事真的发生了）；
//   · 落在「未并入」尾段 → 说清是「当日列表里没有它的题材组」，⛔ 不含糊。
const addedTitle = computed(() => {
  const s = props.stock || {};
  if (s.mergedTopic) {
    return '本行由「竞价一字」看板按题材【' + s.mergedTopic + '】补入本组：'
      + '它不在早盘竞价列表里，数据取自竞价一字看板自己的库（与早盘竞价的列表 / 排序无关）';
  }
  return '本行来自「竞价一字」看板：它的题材不在当日早盘竞价列表里，因此没有对应题材组可并入；'
    + '列在这里供参考（数据同样来自竞价一字看板自己的库）';
});
</script>
