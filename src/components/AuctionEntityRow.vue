<!--
  AuctionEntityRow.vue — 早盘竞价第一页的【标准行】渲染单元（行本体 + 展开后的趋势面板/四要素）。

  为什么抽成组件（§15 业务模块标准结构）：
    龙头组 / 观察组 / 常规组 三处的行必须【视觉与交互完全一致】（用户明确要求龙头组
    「和观察组布局基本一样：有竞价量、昨成交量、占比、能展开收起、有四要素」）。
    若各自复制一份模板，日后改一列必漏改其一（正是本次返工的原因）。
    因此统一由本组件渲染，三个区块只负责「把哪些 item 交给它」。

  §3 纯展示组件：
    · 只读 props.item（Logic 层 _enrichAuctionItem 已 enrich 好的展示字段）；
    · 交互回调从 inject('auctionBoard') 取（与 AuctionBoardTable 同源，不新建状态、不复制一份 board）；
    · 不做业务计算、不改数据、不发请求、不写数据库。

  根节点是 Fragment（统计条 + 行 + 趋势面板），与原先内联在 AuctionBoardTable 的
  <template v-for> 里的结构逐一对应，DOM 层级与 class 完全不变（样式来自全局 auction-board.css）。
-->
<template>
  <AuctionTopicStatsBar
    v-if="item.topicStats"
    :stats="item.topicStats"
  />
  <div
    :class="item.itemClass"
    :style="item.topicBg ? { background: item.topicBg } : null"
    :data-index="item.index"
    :data-stock="item.stock || ''"
    @click="onToggleSelect(item.index)"
  >
    <div
      :class="item.numberClass"
      @click.stop="onExpandTrend(item.stock)"
      @dblclick.stop
    >
      {{ item.seqNo || (idx + 1) }}
    </div>
    <div
      :class="item.stockClass"
      :data-stock="item.stock"
      :data-note="item.note || ''"
      @dblclick.stop
      @contextmenu.prevent="onLongPress(item.stock)"
      @touchstart.passive="startLongPress(item.stock)"
      @touchend="cancelLongPress"
      @touchmove="cancelLongPress"
      @mousedown="startLongPress(item.stock)"
      @mouseup="cancelLongPress"
      @mouseleave="cancelLongPress"
    >
      <span
        class="auction-stock-text"
        :class="stockTextClass(item)"
        :title="item.isYiZi ? ('竞价一字（竞价涨幅 ' + (item.aucPctText || '-') + '）') : (item.closeLimit ? (item.closeLimit === 'up' ? '收盘涨停' : '收盘跌停') : null)"
      >{{ item.stock }}<span
        v-if="item.obsFormalStar || item.dragonGroupFormalStar"
        class="auction-obs-formal-star"
      >*</span></span>
      <!-- [LIMIT-STREAK 2026-09-11] 趋势/连板标记（趋势 / 首板 / 二板 / 三板…）：紧贴股票名后的灰色小标。
           口径 = 前 9 个历史交易日（不含当天）的连续收盘涨停天数，Logic 层（view-helpers）算好文案。 -->
      <span
        v-if="item.streakLabel"
        class="auction-streak-tag"
        :title="'前9个交易日连板状态：' + item.streakLabel"
      >{{ item.streakLabel }}</span>
      <!-- [DRAGON-GROUP 2026-09-14] 龙头「组内标记」：紧随股票名的一个小「龙」标（与连板标同一位）。
           出现条件 = 该行属于龙头组（isDragonGroupMember，即在前一交易日评选出的龙头名册里）：
             · 题材 toggle 开启 → 列表按题材重排、无独立龙头区块，靠它就地辨认（需求 4）；
             · 默认模式 → 该行本身就在顶部龙头组区块里，此标同样出现，保证两种视图一致。
           悬停显示题材 + 十日涨幅（数值来自 Logic 层名册字段，见 dragonGroup* 前缀）。 -->
      <span
        v-if="item.isDragonGroupMember"
        class="auction-dragon-tag"
        :title="dragonTagTitle(item)"
      >龙</span>
      <!-- [DRAGON-GROUP 2026-09-15] 十日区间涨幅数值（= 龙头组区块的排序键）。
           为什么要显示出来：默认模式下标准行只有 竞价量/昨成交量/占比 三列，十日涨幅原本只在
           悬停提示里 → 「按十日涨幅由高到低」这件事无从核对（用户实测「排序不对」）。
           故把排序键直接摆在行上：涨红 / 跌绿 / 平灰（与全站 dragon-badge 同一套国内看板惯例）。
           只在默认模式显示；题材模式下那里已有龙一/龙二徽章带同一数值，避免重复。 -->
      <span
        v-if="item.isDragonGroupMember && !sortState.byTopic && dragonPctText(item)"
        class="auction-dragon-pct"
        :class="dragonPctClass(item)"
        :title="'十日区间涨幅 ' + dragonPctText(item) + (item.dragonGroupTopic ? '（' + item.dragonGroupTopic + '）' : '')"
      >{{ dragonPctText(item) }}</span>
      <AuctionDragonBadge
        v-if="item.dragonRank > 0"
        :rank="item.dragonRank"
        :pct="item.dragonPct"
        :pct-chg="item.aucPctNum"
      />
      <AuctionBadge
        :item="item"
        :ctx="{}"
        :tag-state="item"
      />
    </div>
    <template v-if="!sortState.byTopic">
      <div
        class="auction-volume"
        @dblclick.stop="onEditVolumeNote(item.index)"
      >
        {{ item.volumeDisplay }}
      </div>
      <div
        :class="item.yestColorClass"
        :data-index="item.index"
        :data-note="item.note || ''"
        @click.stop="onYestClick(item, $event)"
        @dblclick.stop="openEditModal()"
        @contextmenu.prevent
      >
        {{ item.yestVolumeDisplay }}
      </div>
      <div
        :class="item.ratioClass"
        :data-index="item.index"
        @dblclick.stop
      >
        {{ item.ratio }}<span
          v-if="item.ratioArrow"
          :style="{ color: item.ratioArrow === '⬆' ? '#ef4444' : '#10b981' }"
        >{{ item.ratioArrow }}</span>
      </div>
    </template>
    <div
      v-else
      class="auction-topic-cell"
    >
      {{ item.topicsDisplay }}
    </div>
  </div>
  <div
    v-if="expandedSet.has(item.stock)"
    class="auction-trend-panel"
    @dblclick.stop
  >
    <template v-if="trendHistory[item.stock]">
      <div class="auction-daily-metrics">
        <template
          v-for="m in dailyMetricsList(item.stock)"
          :key="m.label"
        >
          <span class="adm-item"><b>{{ m.label }}</b>：{{ m.value }}</span>
        </template>
      </div>
      <div class="trend-chart-item">
        <div class="trend-chart-label trend-chart-label-with-stats">
          <span>竞价量(万) 近5日</span>
          <span
            v-if="trendHistory[item.stock].diff != null"
            style="color:#2563eb; font-weight:600;"
          >差值 {{ trendHistory[item.stock].diff }}</span>
          <span
            v-if="trendHistory[item.stock].jingRatio != null"
            style="color:#6366f1; font-weight:600;"
          >今/昨比 {{ trendHistory[item.stock].jingRatio }}</span>
        </div>
        <TrendChart
          :points="trendHistory[item.stock].volume"
          color="#6366f1"
        />
      </div>
      <div class="trend-chart-item">
        <div class="trend-chart-label trend-chart-label-with-stats">
          <span>昨日成交量(万) 近5日</span>
          <span
            v-if="trendHistory[item.stock].yestRatio != null"
            style="color:#10b981; font-weight:600;"
          >昨/前比 {{ trendHistory[item.stock].yestRatio }}</span>
        </div>
        <TrendChart
          :points="trendHistory[item.stock].yestVolume"
          color="#10b981"
        />
      </div>
      <div
        v-if="aucPctHasData(item.stock)"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
          竞价涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trendHistory[item.stock].aucPctChg"
          color="#f59e0b"
          :percent="true"
        />
      </div>
      <div
        v-if="changePctHasData(item.stock)"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
          涨幅(%) 近5日
        </div>
        <TrendChart
          :points="trendHistory[item.stock].changePct"
          color="#64748b"
          :percent="true"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
// 与 AuctionBoardTable 共用同一个 composable 实例（inject('auctionBoard')）：
// 状态与回调只有一份，本组件不新建任何状态、不复制 board（§6 单一真相）。
import { inject } from 'vue';
import AuctionBadge from './AuctionBadge.vue';
import AuctionDragonBadge from './AuctionDragonBadge.vue';
import AuctionTopicStatsBar from './AuctionTopicStatsBar.vue';
import TrendChart from './TrendChart.vue';

// props 只供模板使用（模板里直接写 item / idx），脚本内不再引用，故不做赋值。
defineProps({
  // Logic 层 enrich 好的行对象（含 itemClass / volumeDisplay / yestVolumeDisplay / ratio / seqNo / dragonGroup* 等）。
  item: { type: Object, required: true },
  // 该行在当前区块内的显示序号（0 起，用于 item.seqNo 为空时的回退显示）。
  idx: { type: Number, default: 0 }
});

const board = inject('auctionBoard');
const {
  sortState, expandedSet, trendHistory,
  onToggleSelect, onExpandTrend, onEditVolumeNote, onYestClick, openEditModal,
  onLongPress, startLongPress, cancelLongPress, dailyMetricsList
} = board;

// 趋势图显示判定：整条序列是否有任一有效点（渲染结果与原先内联写法 100% 一致）。
function aucPctHasData(stock) {
  return trendHistory.value[stock].aucPctChg.some(p => p.value !== null);
}
function changePctHasData(stock) {
  return trendHistory.value[stock].changePct.some(p => p.value !== null);
}

// [DRAGON-GROUP 2026-09-14] 龙头「龙」标的悬停说明（龙头题材 + 十日区间涨幅）。
// 纯展示格式化（非业务口径）：数值来自 Logic 层名册字段，统一用 dragonGroup* 前缀
//（与另一套「题材内龙头排名」的 dragonRank/dragonPct 区分开，避免互相覆盖）。
function dragonTagTitle(item) {
  if (!item) return '';
  const bits = ['龙头' + (item.dragonGroupTopic ? '（' + item.dragonGroupTopic + '）' : '')];
  const v = item.dragonGroupPct;
  if (v !== null && v !== undefined && !isNaN(Number(v))) {
    bits.push('10日涨幅 ' + (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2) + '%');
  }
  if (item.dragonGroupFormalStar) bits.push('* 该龙头同时位于今日正式列表');
  return bits.join('｜');
}

// [DRAGON-GROUP 2026-09-15] 十日区间涨幅的显示文本 / 颜色档（空白串 = 无值 → 模板不渲染）。
// 「无值」绝不当 0 显示（否则会与「涨幅为 0」混淆，§40 不猜数据）。
function dragonPctText(item) {
  const v = item ? item.dragonGroupPct : null;
  if (v === null || v === undefined || isNaN(Number(v))) return '';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function dragonPctClass(item) {
  const v = item ? item.dragonGroupPct : null;
  if (v === null || v === undefined || isNaN(Number(v))) return {};
  const n = Number(v);
  return { 'dragon-pct-up': n > 0, 'dragon-pct-down': n < 0, 'dragon-pct-flat': n === 0 };
}

// [CLOSE-LIMIT 2026-09-11] 股票名下划线标记的 class（优先级在 Logic 层之外只保留「谁盖住谁」这一件事）：
//   竞价一字 = 9:25 竞价就打在涨停价（实线红线，盘中信号）；
//   收盘涨停/跌停 = 全天走完收在板价（红色/绿色蚂蚁线=虚线，收盘结果）。
//   二者都作用在同一个 span 的 border-bottom 上，同时命中会互相覆盖 →
//   这里做【显式互斥】：竞价一字优先（实线），不是一字时才画收盘停板蚂蚁线，绝不出现两条叠加。
// [CLOSE-NAME-COLOR 2026-09-11] 另外叠加「股票名字体颜色」：收盘涨幅 >0 红 / <0 绿（=0 或无数据不加类）。
//   它作用于 color，与上面两个 border-bottom 类互不干扰，因此不参与互斥（可同时出现：
//   例如收盘涨停 + 涨幅为正 → 红字 + 红蚂蚁线）。
function stockTextClass(item) {
  const cls = {};
  if (item.isYiZi) {
    cls['yizi-limit'] = true;
  } else {
    cls['close-limit-up'] = item.closeLimit === 'up';
    cls['close-limit-down'] = item.closeLimit === 'down';
  }
  // [HIGH-LIMIT-BOARD 2026-09-21] 涨跌幅放开板（科创板 688/689、创业板 300/301、北交所 43/83/87/88/92）
  //   → 股票名【浅灰色 + 删除线】，避免误买。它是安全提示，因此【压过】收盘红绿字色（显式互斥）：
  //   否则「红字」会和「浅灰删除线」语义打架，用户反而看不清这是只 20%/30% 的票。
  //   下方的一字实线 / 停板蚂蚁线是 border-bottom，与本类的 color 属性不冲突，故照常保留。
  if (item.isHighLimitBoard) {
    cls['high-limit-board'] = true;
    return cls;
  }
  // 档位由 Logic 层算好（view-helpers closeNameTone），这里只做「档位 → class 名」映射
  if (item.closeNameTone === 'up') cls['close-name-up'] = true;
  else if (item.closeNameTone === 'down') cls['close-name-down'] = true;
  return cls;
}
</script>
