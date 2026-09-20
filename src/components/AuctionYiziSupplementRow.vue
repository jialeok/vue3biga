<!--
  AuctionYiziSupplementRow.vue — 「补竞价一字」补入的一行（+ 展开后的近 5 日趋势面板）

  ★ 2026-09-20 v3 修正（用户原话：「位置对了，但是显示还没对，你就按照早盘竞价的显示方式来就可以，
    序号，股票名称，标签，题材，只有这四个……字体字样也要和列表统一起来，包括显示的效果，
    比如收盘后股票名称颜色变化，涨停一字有下面的实线下滑线等，都要统一的。
    竞价一字的那些封单额在 UI 这里不要显示了，还有后面那个十日涨幅也要隐藏起来」）

  ⇒ 本行的实现方式就是【把早盘竞价行的 DOM 与类名原样搬过来】，只渲染四列：
      .auction-item    → 行本体（flex 布局、hover 底色、行内左侧标记位）
      .auction-number  → 序号（点它展开趋势；字号/颜色/内边距与原有行逐像素同源）
      .auction-stock-name + .auction-stock-text → 股票名称（**字体、字号、颜色、下划线全部继承**
                        早盘竞价的样式 → 竞价一字 red 实线下划线 = .auction-stock-text.yizi-limit）
      .auction-topic-cell → 题材（12px / 允许折行 / 同列宽 flex:2.5）
    「标签」= 名称后的小标：连板标(.auction-streak-tag) + 「补」标(.auction-yizi-sup-added)。

  ⚠️ 为什么【复用早盘竞价的类名】而不是继续用自己的一套前缀：
     CSS 是全局的，用户要的正是「字体字样/显示效果与列表统一」。字体、行高、下划线、hover
     这些东西如果在本组件里再抄一份，日后早盘竞价改一次字号这里就会悄悄不一致（正是本次返工的原因）。
     本组件因此只保留两个**自有**类名：
       · .auction-yizi-sup-item — 行左侧那道紫色竖条（「这行是补进来的」的唯一视觉差异，用 inset
         box-shadow 实现，不占列宽、不挤动对齐）；
       · .auction-yizi-sup-added — 「补」小标记。

  ⛔ 本行不显示：封单额（9:20/9:25/变化量）、十日涨幅列、9:20 时点标、首封时刻。
     需要看封单额请去「竞价一字」看板（那边口径更全）——本功能只是显示层借用它的股票。

  🌐 数据独立性（用户明确要求「两个看板互不干扰」）：
      本行的股票与趋势曲线全部来自竞价一字看板自己的库 / 自己的猫抓小号（Edge /trend），
      ⛔ 与早盘竞价的 numcat 主账号、与早盘竞价的趋势通道无关。
      因此点序号展开的是【竞价一字自己的 4 张趋势图】，不会去查早盘竞价的数据。

  §3 纯展示组件：只读 props.stock（Logic 纯函数已排好名次、赋好序号的显示对象）
  + inject('auctionYiziSupplement') 的状态与回调；⛔ 不计算任何业务口径。
-->
<template>
  <div
    class="auction-item auction-yizi-sup-item"
    :style="stock.topicBg ? { background: stock.topicBg } : null"
    :data-stock="stock.stock"
    @dblclick.stop
  >
    <!-- 序号 = **本题材组内按十日涨幅的排名**（与组内原有行合并排名后插到自己的排名位；
         序号变了说明它在组里的位次真的变了，不是「一字看板自己的块内序号」）
         点它展开该股近 5 日趋势（与早盘竞价、竞价一字看板同一交互：点序号展开） -->
    <div
      class="auction-number auction-trend-trigger"
      :title="seqTitle"
      @click.stop="toggleTrend(stock.stock)"
      @dblclick.stop
    >
      {{ stock.seq }}
    </div>
    <div
      class="auction-stock-name"
      :data-stock="stock.stock"
      :data-note="''"
      :title="nameTitle"
      @dblclick.stop
    >
      <!-- 字体/字号/颜色/下划线全部来自早盘竞价的样式：
           竞价一字 → .yizi-limit 的红色实线下划线（与列表里的一字股长得一模一样） -->
      <span class="auction-stock-text yizi-limit">{{ stock.stock }}</span>
      <!-- 连板标（首板/二板/三板…）：与早盘竞价行内那个连板标同款同源（limit-streak） -->
      <span
        v-if="stock.continueText"
        class="auction-streak-tag"
        :title="'前9个交易日连板状态：' + stock.continueText"
      >{{ stock.continueText }}</span>
      <!-- ★「补」小标记：标明这一行不是早盘竞价的股票，而是从竞价一字看板按题材补进来的 -->
      <span
        class="auction-yizi-sup-added"
        :title="addedTitle"
      >补</span>
    </div>
    <!-- 题材列：列宽与样式与 .auction-topic-cell 同源（完整展示、允许折行、不做省略号截断） -->
    <div
      class="auction-topic-cell"
      :title="stock.topicsDisplay"
    >
      {{ stock.topicsDisplay }}
    </div>
  </div>

  <!-- ============ 趋势面板（点序号展开；与早盘竞价的展开面板同一套类名 → 观感统一）============
       🔴 数据来自竞价一字自己的库 / 自己的猫抓小号（Edge /trend），⛔ 与早盘竞价的 numcat 主账号无关。
       §22 懒加载：点序号第一次展开时才取；§26 日期不对齐时 trendMap 为空 → 这里显示「暂无」。 -->
  <div
    v-if="expanded"
    class="auction-trend-panel"
    @dblclick.stop
    @click.stop
  >
    <div class="auction-daily-metrics">
      <span class="adm-item">
        <b>十日涨幅</b>：<span :class="rangeClass">{{ stock.rangeText || '-' }}</span>
      </span>
      <span
        v-for="m in trendMetrics(stock.stock)"
        :key="m.label"
        class="adm-item"
      ><b>{{ m.label }}</b>：{{ m.value }}</span>
    </div>

    <div
      v-if="trendLoading && trendEmpty(stock.stock)"
      class="auction-yizi-sup-trend-note"
    >
      加载中…（正在取近 5 日趋势）
    </div>
    <div
      v-else-if="trendEmpty(stock.stock)"
      class="auction-yizi-sup-trend-note"
    >
      近 5 日暂无趋势数据（9:25 抓取完成后自动补）
    </div>

    <template v-else>
      <div class="trend-chart-item">
        <div class="trend-chart-label">
          竞价量(万) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].volume"
          color="#6366f1"
        />
      </div>
      <div
        v-if="trendHasLeg(stock.stock, 'yestVolume')"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
          昨日成交量(万) 近5日
        </div>
        <TrendChart
          :points="trendMap[stock.stock].yestVolume"
          color="#10b981"
        />
      </div>
      <div
        v-if="trendHasLeg(stock.stock, 'aucPctChg')"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
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
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
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
  // mergeYiziIntoAuctionRows 产出的补入行：{ stock, seq, mergedTopic, topicsDisplay,
  // continueText, rankPct, rangeText, rangeTone, topicBg }
  stock: { type: Object, required: true }
});

const sup = inject('auctionYiziSupplement');
const {
  trendExpanded, trendMap, trendLoading,
  trendMetrics, trendHasLeg, trendEmpty, toggleTrend
} = sup;

const expanded = computed(() => trendExpanded.value.has(props.stock.stock));

// 十日涨幅方向的颜色档（涨红跌绿，项目约定）。档位由一字看板算好，这里只做「档位 → 类名」映射（§21）
const rangeClass = computed(() => 'auction-yizi-sup-' + ((props.stock && props.stock.rangeTone) || 'flat'));

const seqTitle = computed(function() {
  const s = props.stock || {};
  return '序号 = 本题材组内按十日涨幅的排名（第 ' + s.seq + ' 名）'
    + '；点击展开该股近 5 日趋势（数据来自竞价一字看板自己的库）';
});

const nameTitle = computed(function() {
  const s = props.stock || {};
  return '竞价一字（本行由「竞价一字」看板按题材【' + (s.mergedTopic || '无匹配题材组')
    + '】补入，不在早盘竞价列表里；数据取自竞价一字看板自己的库）';
});

// 「补」标的悬停说明：讲清「从哪来、为什么在这一组」
//   · 融进某题材组 → 说出组名（用户可核对「按题材融入」这件事真的发生了）；
//   · 落在「未并入」尾段 → 说清是「当日列表里没有它的题材组」，⛔ 不含糊。
const addedTitle = computed(function() {
  const s = props.stock || {};
  if (s.mergedTopic) {
    return '本行由「竞价一字」看板按题材【' + s.mergedTopic + '】补入本组：'
      + '它不在早盘竞价列表里，数据取自竞价一字看板自己的库（与早盘竞价的列表 / 排序无关）';
  }
  return '本行来自「竞价一字」看板：它的题材不在当日早盘竞价列表里，因此没有对应题材组可并入；'
    + '列在这里供参考（数据同样来自竞价一字看板自己的库）';
});
</script>
