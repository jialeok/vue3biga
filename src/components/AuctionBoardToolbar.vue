<!--
  AuctionBoardToolbar.vue — 早盘竞价第一页：排序开关 / 竞昨统计 / 表头 / 搜索 / 后台面板。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。
-->
<template>
  <div class="auction-toolbar">
    <!-- [TOOLBAR-LAYOUT 2026-10-25 用户口径] 文案「全部展开」→「全开」（用户：「你把前面的全展开改成，
         全开，名称缩短，功能不变」）。⚠️ 只改文案，onExpandAllChange → expandAll / collapseAll 一字未动。
         缩短 2 个字是为了给这一行腾出宽度（同行还有 竞价口径 / 20日涨幅 / 一字）——
         但真正保证「两行不折行」的是 auction-board.css 里的 flex-wrap:nowrap，不是靠省字。 -->
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">全开</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          @change="onExpandAllChange"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <!-- ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 这个开关位原来是「弱转强」，现改为「竞价口径」。
         ⛔ 不是改名：原「弱转强」是【主排序】（三档：连跌+竞价转向 / 仅转向 / 其余，配行级绿色高光），
            已【整体删除】；新开关是【口径修饰】——只决定「十日涨幅」「20日涨幅」两列用哪一套数值：
              · 打开 = 9:26 竞价口径（把区间涨幅的今天那一根腿反解回 9:25 竞价）；
              · 关闭 = 收盘口径（云端原值，与原来逐字相同）。
         用户原话：「还不如早盘竞价把弱转强toggle换成竞价口径toggle影响20日和10排名，也就是打开后，
           按照竞价口径排序，关闭后恢复原样……这样在视觉上我一眼就能看出，也就是10日涨幅和竞价口径
           toggle可以同时打开，20日涨幅也是一样，关掉竞价toggle后，就变成收盘口径（和原来一样）。」
         ★ 关键结构差别：它【不进主排序互斥组】——可以和「十日涨幅」「20日涨幅」同时打开。
         ⚠️ 早上没开盘 / 当天还没被收盘涨幅覆盖时，两套口径数值本来就相同 ⇒ 这个开关用在
            历史日期与收盘后回看（对照「早上看到的那一批」）。 -->
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">竞价口径</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byAuctionLeg"
          @change="toggleSort('byAuctionLeg')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <!-- ★ [RANGE20 2026-10-19 用户口径] 这个开关位原来是「量比抢筹」，现改为「20日涨幅」：
         打开后 = **全部股票一条列表**（龙头组 + 观察组 + 常规组不再分块），按「含今天在内
         的 20 个交易日区间涨幅」由高到低排，并在每行股票名旁标出该数值。用户原话：
         「和十日涨幅toggle类似，只是时间段涨幅不一样，这样在市场总龙出现分歧的时候，
           我可能用这个toggle做参考。」
         ⛔ 原「量比抢筹」功能（竞价量比≥10 且 抢筹幅度>1 → 行级高光）已【整体删除】，
            不是改名：排序键与数据源都换了（量比抢筹 = 当日两个竞价字段现算；
            20日涨幅 = 20 个交易日逐日涨幅复利，见 logic/auction/range20.js）。
         默认关闭（与十日涨幅一致）。 -->
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">20日涨幅</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byRangePct20"
          @change="toggleSort('byRangePct20')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <!-- ★ [TWO-MODES 2026-10-02 用户口径] 这个开关位原来是「平行」，现改名为「一字」：
         打开后 = 题材视图（与「题材」toggle 显示完全一致）但题材【按竞价一字数量降序】排，
         也就是「早期版本那个一字多的题材排在前面」的口径。
         ⛔ 原来的「平行」已并入「竞/昨」（竞/昨 的 tier0 = 平行+diff>0 高光、tier1 = 仅平行），
            不再有独立开关；所以这里不是新增，是【复用旧开关位】。
         ⚠️ 与「题材」toggle 共用 sortState.byTopic，只以 topicOrderBy 区分 ⇒ 二者天然互斥。 -->
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">一字</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="yiziToggleOn"
          @change="toggleTopicOrder('yizi')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
  </div>
  <div class="auction-toolbar-row2">
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">竞/昨</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byJingYest"
          @change="toggleSort('byJingYest')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">竞/昨占比</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byJingYestRatio"
          @change="toggleSort('byJingYestRatio')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <!-- ★ [RANGE-PCT 2026-10-14 用户口径] 这个开关位原来是「三天竞跌」，现改为「十日涨幅」：
         打开后 = **全部股票一条列表**（龙头组 + 观察组 + 常规组不再分块），按「近 10 个交易日
         区间涨幅」由高到低排，并在每行股票名旁标出该数值 —— 用户要的是「一眼找到市场总龙头」。
         ⛔ 原「三天竞跌」功能（竞价量连续递减）已整体删除，不是改名：排序键与数据源都换了
            （三天竞跌 = 内存逐日 volume 现算；十日涨幅 = 云端 stock_range_pct，与题材龙位徽章同源）。
         ⚠️ 与其它主排序 toggle（20日涨幅 / 竞/昨 / 竞/昨占比）互斥，由 Logic 层保证；
            「竞价口径」是口径修饰开关，⛔ 不在互斥组里（可以和本开关同时打开）。 -->
    <div class="auction-toggle-item">
      <span class="auction-toggle-label">十日涨幅</span>
      <label class="auction-toggle-switch">
        <input
          type="checkbox"
          :checked="sortState.byRangePct"
          @change="toggleSort('byRangePct')"
        >
        <span class="auction-toggle-slider" />
      </label>
    </div>
    <AuctionBoardTopicToggle />
  </div>
  <div class="auction-highratio-stat">
    <span style="font-weight:700;color:#dc2626;">竞昨数：{{ jingYestCountText }}</span>
    <span style="display:inline-block;width:28px;" />竞放量数：<span style="font-weight:700;">{{ highRatioCountText }}</span>
  </div>
  <AuctionHeaderSearch />
  <div
    class="auction-header-row"
    style="cursor:pointer"
    @dblclick.stop="onHeaderDblClick"
  >
    <div class="auction-header-item auction-header-number">
      序号
    </div>
    <div class="auction-header-item auction-header-stock">
      股票名称
    </div>
    <template v-if="!sortState.byTopic">
      <!-- [RANGE-COLS 2026-10-24 用户口径] 区间涨幅模式（十日 / 二十日）的表头：
           只隐藏「竞价量(万)」「昨成交量(万)」两列表头（占比保留），并在占比前加「题材」列。
           与 AuctionEntityRow 用【同一个判据】rangeColsMode（byRangePct20 || byRangePct）
           ⇒ 表头与数据列同增同减、剩下的 序号/股票名/占比 按原 flex 比例同步变宽 ⇒ 不会错位。
           ⚠️ 其它 toggle 判据恒 false（§11 默认无行为），表头一字不动。 -->
      <div
        v-if="!rangeColsMode"
        class="auction-header-item auction-header-volume"
      >
        竞价量(万)
      </div>
      <div
        v-if="!rangeColsMode"
        class="auction-header-item auction-header-yest"
      >
        昨成交量(万)
      </div>
      <!-- [RANGE-TOPIC 2026-10-24 用户口径] 区间涨幅模式的「题材」列表头。
           文案来源与「题材」toggle 同一字段（item.topicsDisplay，§6）；
           判据与行组件同源 ⇒ 列同增同减、不错位。 -->
      <div
        v-if="rangeColsMode"
        class="auction-header-item auction-header-range-topic"
      >
        题材
      </div>
      <div class="auction-header-item auction-header-ratio">
        占比
      </div>
    </template>
    <div
      v-else
      class="auction-header-item auction-header-topic"
    >
      题材
    </div>
    <!-- ★ 2026-09-20「补竞价一字」开关（= 用户说的表头 X 位）：
         只在题材 toggle 打开时出现；打开后把「竞价一字」看板的一字板股票按题材补到列表末尾。
         ⚠️ 本组件用绝对定位（见 auction-yizi-supplement.css）：不参与表头这行的 flex 换算，
            否则表头三列会被同步压窄 → 表头文字与下面数据列整体错位。 -->
    <AuctionYiziSupplementToggle />
  </div>
  <div
    v-if="showBackend"
    class="auction-backend-panel"
    :class="{ 'is-loading': backendLoading }"
  >
    <div class="backend-block backend-block-ths">
      <div class="backend-block-header">
        <span class="backend-block-title">同花顺接口</span>
        <span class="backend-block-sub">fuyao-proxy</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fetchLadderConstituentsMain)"
        >
          梯子成分
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillYesterdayVolumeFromThs)"
        >
          昨量填充
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillTodayYesterdayVolumeFromThs)"
        >
          今昨量
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fillYesterdayYesterdayVolumeFromThs)"
        >
          昨昨量
        </button>
        <button
          class="backend-btn backend-btn-ths"
          @click="runBackend(fetchChangePctFromThs)"
        >
          涨幅抓取
        </button>
      </div>
      <div
        class="backend-status"
        :style="{ color: thsStatus.ok ? '#059669' : '#dc2626' }"
      >
        {{ thsStatus.msg || '' }}
      </div>
    </div>
    <div class="backend-block backend-block-numcat">
      <div class="backend-block-header">
        <span class="backend-block-title">猫抓数据接口</span>
        <span class="backend-block-sub">每日10次</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchTodayAuctionFromNumcat)"
        >
          今日竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchAllAuctionFromNumcat)"
        >
          全部竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchThreeDaysAuctionFromNumcat)"
        >
          三日竞价
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fillTopicsFromNumcat)"
        >
          题材填充
        </button>
        <button
          class="backend-btn backend-btn-numcat"
          @click="runBackend(fetchDragonRangeFromNumcat)"
        >
          龙头涨幅
        </button>
      </div>
      <div
        class="backend-status"
        :style="{ color: numcatStatus.ok ? '#059669' : '#dc2626' }"
      >
        {{ numcatStatus.msg || '' }}
      </div>
    </div>
    <div class="backend-block backend-block-import">
      <div class="backend-block-header">
        <span class="backend-block-title">数据导入</span>
      </div>
      <div class="backend-grid">
        <button
          class="backend-btn backend-btn-import"
          @click="onImportPaste"
        >
          粘贴导入
        </button>
        <button
          class="backend-btn backend-btn-import"
          @click="onHistoryFill"
        >
          历史填充
        </button>
        <button
          class="backend-btn backend-btn-import"
          @click="onReplaceConcept"
        >
          题材替换
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject, computed } from 'vue';
import { apiStatusMap } from '../logic/ui-bridge.js';
import AuctionHeaderSearch from './AuctionHeaderSearch.vue';
import AuctionBoardTopicToggle from './AuctionBoardTopicToggle.vue';
import AuctionYiziSupplementToggle from './AuctionYiziSupplementToggle.vue';
const board = inject('auctionBoard');
const {
  uiStore, auctionStore, sortState, expandedSet, trendHistory, longPressMenuRef, coreTopicModalRef, editModalRef,
  viewData, currentPage, showBackend, expanded, topicGroups, itemsByIndex, obsItems, regularItems, allItems,
  searchActive, searchKeyword, filteredItems, filteredObsItems, filteredRegularItems, showObsSeparator,
  sortState2, isStrengthSortEnabled, p2ExpandedSet, p2TrendHistory, p2ExpandedTopics, p2ExpandAll,
  p2StockTopicCount, p2HighRatioInfo, p2JingYestSet, p2ParallelSet, p2JingYestCount, p2HighRatioCount,
  sortedTopicGroups, page3Data, copiedStocks, page4DisplayStocks, backendLoading,
  volumeNoteModalActive, volumeNoteDraft, notePopup, notePopupText, notePopupStyle,
  toggleBoard, getStockStyle, getTopicRowClass, toggleSort2, toggleStrengthSort, toggleGroupExpand,
  p2ToggleExpandAll, loadP2TrendHistory, loadP2TrendHistoryChunked, toggleP2Trend, getLastNTradingDays,
  loadCopiedStocks, saveCopiedStocks, copyAllTopicStocks, copyTopicStocks, deleteCopiedStock, clearAllCopiedStocks,
  openBackend, openEditModal, openCoreTopicModal, onHeaderClick, onHeaderDblClick, refresh, toggleSort, expandAll, collapseAll,
  // [TWO-MODES 2026-10-02] 题材 / 一字两个 toggle 的口径切换入口 + 勾选态（互斥由 Logic 保证）
  toggleTopicOrder, yiziToggleOn,
  _computeTrendStats, loadTrendHistory, dailyAuctionMetrics, dailyMetricsList, switchPage,
  onSwipeStart, onSwipeEnd, handleSwipe, runBackend, onImportPaste, onReplaceConcept, onHistoryFill,
  onToggleSelect, onEditVolumeNote, _persistVolumeNote, saveVolumeNote, clearVolumeNote,
  onYestClick, closeNotePopup, onExpandTrend, startLongPress, cancelLongPress, onLongPress, onAuctionRefresh,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fetchTodayAuctionFromNumcat,
  fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat, fillTopicsFromNumcat,
  fetchDragonRangeFromNumcat
} = board;

// § 模板重构：内联条件链 / 状态访问抽取（渲染结果 100% 不变）
const jingYestCountText = computed(() => (viewData.value.stats && viewData.value.stats.jingYestCount) || '-');
const highRatioCountText = computed(() => (viewData.value.stats && viewData.value.stats.highRatioCount) || '-');

// [RANGE-COLS 2026-10-24 用户口径] 列结构开关（隐两列 / 加题材列）：
//   与 AuctionEntityRow.vue 里的同名 computed 【逐字相同】—— 表头与数据列必须同增同减，
//   任何一侧多/少渲染一格，剩下的列会整体平移 ⇒ 表头文字与数据错位。
//   ⛔ 改这里就要同步改那边（两处都写了交叉引用注释，别只改一边）。
const rangeColsMode = computed(() => !!(sortState.byRangePct20 || sortState.byRangePct));

const thsStatus = computed(() => apiStatusMap['thsApiStatus'] || {});
const numcatStatus = computed(() => apiStatusMap['numcatApiStatus'] || {});
function onExpandAllChange(e) {
  if (e.target.checked) expandAll();
  else collapseAll();
}
</script>
