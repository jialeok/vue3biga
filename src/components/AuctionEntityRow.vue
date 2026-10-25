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
      <!-- [RANK-BOX 2026-10-24 用户口径] 「10日/20日涨幅前十（主板、带在列次数标签）的票，前面的序号
           换成有颜色的小方框」。class 由 Logic 层 presence-label.js#rankBoxClassOf 下发
           （item.presenceRankClass），与右边那枚「n次在列」标签【同一个判据、同一份次数】⇒ 不会分叉；
           没命中的行该字段恒为 '' ⇒ 渲染与改动前逐字一致（§11 默认无行为）。
           [BOARD-SEQ 2026-10-25 用户口径] 序号本身也换口径了：区间涨幅模式（十日 / 20日）下 seqNo 是
           【主板名次】，非主板 seqBlank=true ⇒ 这里渲染【空】（位置不变、只是不占号），
           这样屏幕上的号与规则文案的「第 N 名」一致（口径唯一实现在 logic/auction/board-seq.js）。
           ⚠️ 这层 span 是【恒渲染】的（不用 v-if）：序号列 DOM 结构在两种状态下保持一致，
              否则切 toggle 时 .auction-number 里的文本节点被整体替换 ⇒ 行高抖一下。 -->
      <span :class="item.presenceRankClass">{{ item.seqBlank ? '' : (item.seqNo || (idx + 1)) }}</span>
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
      <!-- [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「总龙一…总龙五」：只在「20日涨幅」toggle 下出现，
           由 Logic 层 range20-top5-label.js 按 20 日涨幅降序给前五只赋值（item.totalDragonRank/Label），
           其它模式该字段恒为 0/'' ⇒ 本标签不渲染（用户「其它 toggle 要保留原样、其它票不标」）。
           ⚠️ 纯展示：本组件不做任何排名/取值判定（§3/§21）。 -->
      <span
        v-if="item.totalDragonRank > 0"
        class="auction-totaldragon-tag"
        :title="totalDragonTagTitle(item)"
      >{{ item.totalDragonLabel }}</span>
      <!-- [SUSPEND 2026-10-13] 当日停牌小标：上游（猫抓/同花顺）都拿不到该票的竞价与成交，
           于是本行竞价量/占比会显示 '-' —— 外观与「上游没抓到数据」完全一致，极易误读
           （2026-10-13 新华传媒 600825.SH 实例）。命中即明示「停牌」，一眼区分
           「今天这只票没有行情」与「抓取故障」。判定唯一实现在 logic/auction/suspend.js，
           本组件只读 item.suspended，不做任何判定、不发请求。 -->
      <span
        v-if="item.suspended"
        class="auction-suspend-tag"
        :title="SUSPEND_TAG_TITLE"
      >停牌</span>
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
      <!-- [RANGE20-TOP5 2026-10-19 用户口径] 「20天」标签：该行是「近 20 个交易日竞价名单里
           20 日涨幅前五、但今天不在正式列表」的补位票，由 Logic 层（range20-leaders.js）检索出来。
           用户要求：「要区分，就在后面添加标签"20天"，这样我就清楚了。」
           ⚠️ 身份提示，不是警示：颜色用中性蓝，压不过「停牌」「龙」这些既有标签；
           判定只读 item.range20Leader，本组件不做任何检索/请求（§3）。 -->
      <span
        v-if="item.range20Leader"
        class="auction-r20-tag"
        :title="range20LeaderTagTitle(item)"
      >20天</span>
      <!-- [DRAGON-GROUP 2026-09-15 → RANGE-PCT 2026-10-14] 股票名旁的「十日区间涨幅」数值。
           两种模式共用这一处渲染（样式 / 配色 / 位置一字未变，⛔ 不新增 CSS）：
             · 默认模式      → 龙头组行的名册十日涨幅（= 龙头组区块的排序键）；
             · 十日涨幅 toggle → 每一行的当日十日区间涨幅（= 该 toggle 的排序键，用户要求「标上数据」）。
           取值分支收敛在下方 rangePctValue（模板只做展示，§21 零计算）。 -->
      <span
        v-if="rangePctText(item)"
        class="auction-dragon-pct"
        :class="rangePctClass(item)"
        :title="rangePctTitle(item)"
      >{{ rangePctText(item) }}</span>
      <!-- [PRESENCE 2026-10-23 用户口径] 「在列次数」小标签（「5次在列」「首次在列」「未在列」）。
           出现条件：10日涨幅 / 20日涨幅 toggle 打开，且本行属于该排序下的【前十名】。
           次数 = 这 10（20）个交易日里，该票在早盘竞价看板每日列表中出现过几次（含今天）。
           判定 + 文案全在 Logic 层 presence-label.js；次数来自预计算表 auction_presence
           （Data 层 auction-presence.js 同步读缓存）。⚠️ 纯展示：本组件不做任何判定/请求（§3/§21）。 -->
      <span
        v-if="item.presenceLabel"
        class="auction-presence-tag"
        :class="presenceTagClass(item)"
        :title="presenceTagTitle(item)"
      >{{ item.presenceLabel }}</span>
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
      <!-- [RANGE-COLS 2026-10-24 用户口径] 「十日涨幅」与「20日涨幅」共用同一套列结构：
           【只】隐藏「竞价量(万)」与「昨成交量(万)」两列，占比前面插入「题材」列，占比列保留。
           用户原话：「十日涨幅独立 toggle 设计 UI 要和 20 日涨幅一样，不要那个竞价量和昨日成交量，
           要换成题材，其它不变，你可以参考 20 日涨幅单独打开时的布局设计，节省空间为准。」
           ⚠️ 判据 = rangeColsMode（below，script 里算好的 computed）：
              byRangePct（十日）|| byRangePct20（二十日）。
           ⚠️ 表头（AuctionBoardToolbar）必须用【同一个判据】隐藏同样的两列、插同样的题材列
              ⇒ 两边同增同减，剩下的 序号/股票名/占比 三段 flex 比例不变 ⇒ 列不会错位。
           ⚠️ 其它 toggle（含默认模式 / 题材模式）本判据恒 false ⇒ 行为一字不动（§11）。 -->
      <div
        v-if="!rangeColsMode"
        class="auction-volume"
        @dblclick.stop="onEditVolumeNote(item.index)"
      >
        {{ item.volumeDisplay }}
      </div>
      <div
        v-if="!rangeColsMode"
        :class="item.yestColorClass"
        :data-index="item.index"
        :data-note="item.note || ''"
        @click.stop="onYestClick(item, $event)"
        @dblclick.stop="openEditModal()"
        @contextmenu.prevent
      >
        {{ item.yestVolumeDisplay }}
      </div>
      <!-- [RANGE-TOPIC 2026-10-24 用户口径] 区间涨幅模式（十日 / 二十日）在占比前面加一列题材文本。
           · 文案 = item.topicsDisplay（与「题材」toggle 的题材列【同一个字段同一个来源】，
             getStockTopicsDisplay(rawItem)，§6 单一真相 ⇒ 用户「题材要和题材 toggle 一样」是结构保证）；
           · 不分组、不上题材背景色（topicBg 在非题材模式恒为 ''，§11 默认无行为）——
             就是每行按区间涨幅降序排着的纯文本，省空间（小字号 + 超长省略 + 悬停看全文）。 -->
      <div
        v-if="rangeColsMode"
        class="auction-topic-cell-range"
        :class="{ 'not-formal-member': !item.isFormalMember }"
        :title="item.topicsDisplay"
      >
        {{ item.topicsDisplay }}
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
      :class="{ 'not-formal-member': !item.isFormalMember }"
      :title="item.isFormalMember ? null : '不在今日正式列表（观察组/龙头继承行）：不计入数量/一字/高开/收盘/龙头；平均竞价量比照常计入'"
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
      <!-- [VRATIO-TREND 2026-10-01 用户口径] 竞价量比（倍数）近 5 日趋势：
           位置 = 【昨日成交量】与【竞价涨幅】之间（用户指定「竞价涨幅趋势图上方」）。
           与上面四张图同一套结构（.trend-chart-item + .trend-chart-label + TrendChart），
           ⇒ 观感自然统一，⛔ 不新增任何 CSS。
           🔴 颜色刻意取【玫红 #ec4899】：上面四张已占用 靛蓝#6366f1 / 绿#10b981 / 橙#f59e0b / 灰#64748b，
              再复用任一色都会与已有一张图混淆（量比是独立指标，不能看起来像「竞价量」的第二份）。
           🔴 decimals=2：量比是【倍数】，有效信息在小数上（2.18 被取整成 2 就没法比强弱了）。
           整条序列一个有效点都没有 ⇒ 不渲染整块（judge 在下方 volRatioHasData，§10 缺失不伪装）。 -->
      <div
        v-if="volRatioHasData(item.stock)"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
          竞价量比 近5日
        </div>
        <TrendChart
          :points="trendHistory[item.stock].aucVolRatio"
          color="#ec4899"
          :decimals="2"
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
      <!-- [SEAL-VOLUME 2026-10-11 用户口径] 「封单量（手）近 5 日」趋势：位置 = 【涨幅(%) 近5日】图【下方】
           （用户原话「在，股票下方的五日趋势图下面的涨幅图下方，增加封单数量五日趋势变化图，
             有涨停的才有数值」）。
           口径：数据来自 limit_pool（同花顺 fuyao 15:40 收盘快照，⛔ 0 猫抓额度），
                **只有当天涨停的股票才有数值**（非涨停 = 当日不在涨停池 ⇒ 该点画「--」，
                §10 ⛔ 不用 0 冒充「封单为 0」）；整条一个有效点都没有 ⇒ 整块不渲染
                （judge 在下方 sealLotsHasData，与上面几张图同一套 §10 处理）。
           🔴 颜色取【紫 #a855f7】：上面五张已占用 靛蓝#6366f1 / 绿#10b981 / 玫红#ec4899 /
              橙#f59e0b / 灰#64748b —— 再复用任一色都会与已有一张图混淆（封单量是独立指标）。
           ⛔ decimals 用默认 0（整数手）：封单量是【手数】，不像量比那样靠小数表意；
              若按「万手」缩到 2 位小数，小额封单会显示成 `0.00` —— 那正是 §10 禁止的
              「把没数据画成 0」。宁可标签长一点，也不能让数值与事实打脸。 -->
      <div
        v-if="sealLotsHasData(item.stock)"
        class="trend-chart-item"
      >
        <div class="trend-chart-label">
          封单量(手) 近5日
        </div>
        <TrendChart
          :points="trendHistory[item.stock].sealLots"
          color="#a855f7"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
// 与 AuctionBoardTable 共用同一个 composable 实例（inject('auctionBoard')）：
// 状态与回调只有一份，本组件不新建任何状态、不复制 board（§6 单一真相）。
import { inject, computed } from 'vue';
// [SUSPEND 2026-10-13] 「停牌」小标的文案 / 悬停说明都从 suspend.js 取（唯一出处）——
//   三个选股看板（决策 / 题材量比 / 分笔买卖）与本组件共用同一个常量，⛔ 不各写一份中文字面量。
import { SUSPEND_TAG_TITLE } from '../logic/auction/suspend.js';
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

// [RANGE-COLS 2026-10-24 用户口径] 列结构开关（隐两列 / 加题材列）的唯一判据：
//   「十日涨幅」与「20日涨幅」共用同一套列结构（用户：「十日涨幅独立 toggle 设计 UI 要和 20 日涨幅一样，
//   不要那个竞价量和昨日成交量，要换成题材」）。两者互斥，`||` 即可。
//   ⛔ AuctionBoardToolbar 的表头必须用【同一个表达式】，否则表头与数据列错位
//      （列少了一格，后面的列整体左移 —— 2026-10-20 已踩过一次）。
//   ⚠️ 其它 toggle / 默认模式恒 false ⇒ 渲染与改动前逐字一致（§11 默认无行为）。
const rangeColsMode = computed(() => !!(sortState.byRangePct20 || sortState.byRangePct));

// 趋势图显示判定：整条序列是否有任一有效点（渲染结果与原先内联写法 100% 一致）。
function aucPctHasData(stock) {
  return trendHistory.value[stock].aucPctChg.some(p => p.value !== null);
}
function changePctHasData(stock) {
  return trendHistory.value[stock].changePct.some(p => p.value !== null);
}
// [VRATIO-TREND 2026-10-01] 竞价量比序列同上：整条都没有有效点 → 整块不渲染。
// 多一层 Array.isArray 防御：该字段是本轮新加的，若某条 trendHistory 快照来自旧结构则按「无数据」处理，
// 绝不让一个缺失字段把整行渲染打断（§10 缺值可见，但不许崩）。
function volRatioHasData(stock) {
  const leg = trendHistory.value[stock].aucVolRatio;
  return Array.isArray(leg) && leg.some(p => p.value !== null);
}
// [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）序列同上：整条都没有有效点 → 整块不渲染。
// ⚠️ 多一层 Array.isArray 防御：该字段是本轮新加的，若某条 trendHistory 快照来自旧结构（或
//    limit_pool 窗口还没读回来）就按「无数据」处理，绝不让一个缺失字段把整行渲染打断（§10）。
function sealLotsHasData(stock) {
  const leg = trendHistory.value[stock].sealLots;
  return Array.isArray(leg) && leg.some(p => p.value !== null);
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

// [DRAGON-GROUP 2026-09-15 / RANGE-PCT 2026-10-14 / RANGE20 2026-10-19] 股票名旁「区间涨幅」数值的取值分支。
// 为什么三套来源必须分开（⛔ 不能合并成一个字段）：
//   · 默认模式的龙头组行 → item.dragonGroupPct：来自【前一交易日评选出的名册】（名册里存着当时的
//     十日涨幅 + 题材），它是龙头组区块的排序键，语义 = 「按昨日口径给这批龙头排名」；
//   · 十日涨幅 toggle  → item.rangePct：【当日】十日区间涨幅（云端 stock_range_pct），
//     语义 = 「今天全市场谁更强」，与题材龙位徽章 / 决策看板排名同源（§6）。
//   · 20日涨幅 toggle  → item.rangePct20：【含今天在内 20 个交易日】的区间涨幅（range20.js 现算），
//     语义同样是「今天全市场谁更强」，只是时间段比十日涨幅长一倍（用户用来判「市场总龙是否分歧」）。
// 用后者去渲染前者会与区块排序键不一致（用户实测过「排序对不上数字」），反之亦然。
// 「无值」绝不当 0 显示（否则会与「涨幅为 0」混淆，§40 不猜数据）→ 返回空串 ⇒ 模板不渲染。
// [RANGE20-TOP5 2026-10-19] 「20天」标签的悬停说明：讲清它是什么、为什么在这里、口径是什么。
//   §21 模板零计算：文案在这里拼好，模板只渲染。
// [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「总龙N」标签的悬停说明。
//   说清三件事：这是哪个 toggle 的标签、名次口径是什么、为什么只有五只。
//   §21 模板零计算：文案在这里拼好，模板只渲染。
function totalDragonTagTitle(item) {
  if (!item) return '';
  // [MAIN-BOARD-RANK 2026-10-24] 名次口径已改为「只算主板」⇒ 文案必须跟着改，
  //   ⛔ 不能还写「全市场第 N 名」（否则用户会拿它去跟全市场榜单对账，对不上）。
  const bits = ['「20日涨幅」排序下【主板】第 ' + item.totalDragonRank + ' 名（创业板/科创板/北交所不占名次）'];
  const v = item.rangePct20;
  if (v !== null && v !== undefined && !isNaN(Number(v))) {
    const n = Number(v);
    const days = item.rangePct20Days || 0;
    bits.push('20日区间涨幅 ' + (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
      + (days > 0 && days < 20 ? '（' + days + '/20日）' : '（20个交易日）'));
  }
  bits.push('只给前五只打标（总龙一…总龙五），其它票不标');
  return bits.join('｜');
}

// [PRESENCE 2026-10-23 用户口径] 「在列次数」标签的悬停说明。
//   说清四件事：这是哪个窗口的次数、次数具体是几、窗口数据覆盖了多少天（§10 如实例外）、
//   以及「只给前十名标」这条口径 —— 免得用户以为「别的票为什么没标」。
//   §21 模板零计算：文案在这里拼好，模板只渲染。
function presenceTagTitle(item) {
  if (!item) return '';
  const w = Number(item.presenceWindowDays) || 10;
  const cov = Number(item.presenceCoveredDays) || 0;
  const cnt = (item.presenceCnt === null || item.presenceCnt === undefined) ? null : Number(item.presenceCnt);
  const bits = ['近 ' + w + ' 个交易日（含今天）在早盘竞价看板列表里出现 '
    + (cnt === null ? '-' : cnt) + ' 次'];
  if (cnt === 0) bits.push('窗口内一次都没进过名单（新龙头 / 补位票常见）');
  else if (cnt === 1) bits.push('只有今天在列 ⇒ 首次出现');
  if (cov > 0 && cov < w) bits.push('⚠️ 窗口内只有 ' + cov + '/' + w + ' 天有名单数据，次数按实际覆盖天数统计');
  else if (cov >= w) bits.push('窗口数据完整（' + w + '/' + w + ' 天）');
  bits.push('前十名只算主板（创业板/科创板/北交所不占名次），其它票不标');
  return bits.join('｜');
}

// [PRESENCE 2026-10-24 用户口径] 标签配色分三档（用户原话：「首次在列标志明显一些，用红色显示」）：
//   · 1 次（首次在列）→ 红（最深的一档）：它意味着「这只票是窗口内新冒出来的强势票」，
//     是这张标签要传达的最强信号，必须一眼看到（与全站「涨=红」同一套语义）；
//   · 0 次（未在列）→ 灰：一条「没上过榜」的信息，不该和「5次在列」抢视觉权重；
//   · 其余（n次在列）→ 青灰：纯统计值，既不是身份（龙/20天=蓝）、也不是名次（总龙=红）。
// ⚠️ 三档互斥，判定收敛在这里，模板只挂 class（§21 零计算）。
function presenceTagClass(item) {
  if (!item) return {};
  const n = Number(item.presenceCnt);
  if (!isFinite(n)) return {};
  if (n === 0) return { 'auction-presence-tag-none': true };
  if (n === 1) return { 'auction-presence-tag-first': true };
  return {};
}

function range20LeaderTagTitle(item) {
  if (!item) return '';
  const bits = ['近 20 个交易日（含今天）竞价名单中的 20 日涨幅前五'];
  const v = item.range20LeaderPct;
  if (v !== null && v !== undefined && !isNaN(Number(v))) {
    const n = Number(v);
    const days = item.range20LeaderDays || 0;
    bits.push('20日区间涨幅 ' + (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
      + (days > 0 && days < 20 ? '（' + days + '/20日）' : '（20个交易日）'));
  }
  bits.push('今天不在正式列表 ⇒ 自动补位显示（否则这只票在看板上会消失）');
  return bits.join('｜');
}

function rangePctValue(item) {
  if (!item) return null;
  // [RANGE20 2026-10-19] 两个 toggle 互斥，判断顺序不影响结果；20 日放前面便于阅读。
  if (sortState.byRangePct20) return item.rangePct20;
  if (sortState.byRangePct) return item.rangePct;
  // [RANGE20-TOP5 2026-10-19] 补位行：**恒**显示它的 20 个交易日区间涨幅（不需要打开任何 toggle）。
  //   它是这只票被补进看板的唯一理由，藏在开关后面等于没补 —— 用户要的是「一眼看到它涨了多少」。
  if (item.range20Leader) return item.range20LeaderPct;
  if (item.isDragonGroupMember && !sortState.byTopic) return item.dragonGroupPct;
  return null;
}
function rangePctText(item) {
  const v = rangePctValue(item);
  if (v === null || v === undefined || isNaN(Number(v))) return '';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
// 涨红 / 跌绿 / 平灰（与 .dragon-badge / 全站口径一致：涨=红、跌=绿，⛔ 与欧美相反）。
function rangePctClass(item) {
  const v = rangePctValue(item);
  if (v === null || v === undefined || isNaN(Number(v))) return {};
  const n = Number(v);
  return { 'dragon-pct-up': n > 0, 'dragon-pct-down': n < 0, 'dragon-pct-flat': n === 0 };
}
function rangePctTitle(item) {
  const txt = rangePctText(item);
  // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」开关打开时，这两列的数值与顺序全部换成
  //   9:26 那一刻的那一份（把今天那一根腿反解回 9:25 竞价）。这个事实【必须写在悬停里】——
  //   否则用户在收盘后看到一个与炒股软件对不上的数，第一反应是「算错了」。
  //   ⚠️ 只影响「十日涨幅 / 20日涨幅」两种模式；默认模式（龙头组行）与「20天」补位行各有自己的来源，
  //      ⛔ 不受这个开关影响，所以下面那两个分支不加口径标注（§6：标了才是错的）。
  const legText = sortState.byAuctionLeg
    ? '【竞价口径（9:26）】把今天那一根腿用 market_metrics 的竞价涨幅反解回 9:25 ⇒ 就是早上 9:26 那一刻看到的数（关掉「竞价口径」即回到收盘口径）'
    : '【收盘口径】区间涨幅原值（与早盘竞价 / 炒股软件的收盘口径一致）';
  // [R20-CLOSE-LEG 2026-10-19] 20 日模式下【还没有数值】时也要有说明：
  //   历史日的库内涨幅不可靠（早盘写入的竞价涨幅 / 缺行），所以这一列在 K 线补算完成前
  //   一律显示 `—`（§10 宁缺勿错）—— 这里告诉用户「是在补算」，而不是「涨了 0%」。
  if (!txt) {
    if (sortState.byRangePct20) {
      // §10：竞价口径那份还没读到 / 判不出时同样要说清「是在读」，⛔ 不许拿收盘口径顶替
      if (sortState.byAuctionLeg) {
        return '20日区间涨幅：正在读取该日【竞价口径（9:26）】的数值（读不到就不显示，绝不拿收盘口径冒充）。'
          + '若一直没有，多半是这一天的 20 日腿还没算完（同花顺日线补算需要 1~2 分钟）。';
      }
      return '20日区间涨幅：正在用同花顺日线补算历史日的收盘涨幅。补算完成前不显示估值，以免数字对不上。';
    }
    if (sortState.byAuctionLeg) {
      return '十日区间涨幅：正在读取该日【竞价口径（9:26）】的数值（读不到就不显示，绝不拿收盘口径冒充）。';
    }
    return '';
  }
  // [RANGE20 2026-10-19] 20 日模式：口径文案换成 20 日，并如实标出「实际参与累乘的天数」——
  //   停牌日没有日涨幅腿（复利里 ×(1+0%) 是恒等变换，数值不受影响），所以停过牌的票会是 17/20 日；
  //   用户口径是「停牌也算进去」，这里用 n/20 让它一眼可核对，而不是悄悄当作满窗。
  // [R20-TSWITCH 2026-10-19] 口径一句写清（用户要拿它跟炒股软件逐票对账）：
  //   前 19 天收盘 + 今日「盘中竞价 / 收盘后收盘」—— 两种时刻都说出来，省掉视图层判断时刻的计算。
  // ★ [AUCTION-LEG-TOGGLE] 打开「竞价口径」时，今日那一根腿被【钉死】在 9:25 竞价（不再随 15:00 换腿）
  //   ⇒ 此时口径文案必须换掉，⛔ 不能还写着「收盘后取收盘涨幅」（那是关闭时的口径）。
  if (sortState.byRangePct20) {
    const days = item.rangePct20Days || 0;
    const tail = (days > 0 && days < 20) ? '（' + days + '/20日，停牌日按 0% 计）' : '（20个交易日）';
    return '20日区间涨幅 ' + txt + tail + '｜口径：' + (sortState.byAuctionLeg
      ? '【竞价口径（9:26）】前19个交易日取收盘涨幅 + 今日取 9:25 竞价涨幅 ⇒ 早上 9:26 那一刻看到的数'
      : '【收盘口径】前19个交易日取收盘涨幅，今日盘中取竞价涨幅、收盘后取收盘涨幅（与炒股软件一致）');
  }
  // [RANGE20-TOP5 2026-10-19] 补位行：口径 + 为什么它在这里（用户需要知道「这不是今天 9:25 的票」）。
  if (item.range20Leader) {
    const days = item.range20LeaderDays || 0;
    const tail = (days > 0 && days < 20) ? '（' + days + '/20日）' : '（20个交易日）';
    return '20日区间涨幅 ' + txt + tail + '｜近20个交易日竞价名单里涨幅前五、但今天不在正式列表 ⇒ 补位显示';
  }
  // 龙头组行沿用原口径（附题材，方便核对它是哪个题材的龙头）；
  // 十日涨幅模式是【全市场】排序，题材在行内另有列展示，不在这里重复附（避免提示过长）。
  // ⚠️ 这个分支是【默认模式】用的（来源 = 龙头组名册里存的当日十日涨幅），⛔ 不受「竞价口径」开关影响。
  if (!sortState.byRangePct && item.isDragonGroupMember && item.dragonGroupTopic) {
    return '十日区间涨幅 ' + txt + '（' + item.dragonGroupTopic + '）';
  }
  return '十日区间涨幅 ' + txt + '｜口径：' + legText;
}

// [CLOSE-LIMIT 2026-09-11] 股票名下划线标记的 class（优先级在 Logic 层之外只保留「谁盖住谁」这一件事）：
//   竞价一字 = 9:25 竞价就打在涨停价（实线红线，盘中信号）；
//   收盘涨停/跌停 = 全天走完收在板价（红色/绿色蚂蚁线=虚线，收盘结果）。
//   二者都作用在同一个 span 的 border-bottom 上，同时命中会互相覆盖 →
//   这里做【显式互斥】：竞价一字优先（实线），不是一字时才画收盘停板蚂蚁线，绝不出现两条叠加。
// [CLOSE-NAME-COLOR 2026-09-11] 另外叠加「股票名字体颜色」：收盘涨幅 >0 红 / <0 绿（=0 或无数据不加类）。
//   它作用于 color，与上面两个 border-bottom 类互不干扰，因此不参与互斥（可同时出现：
//   例如收盘涨停 + 涨幅为正 → 红字 + 红蚂蚁线）。
// [NOT-FORMAL 2026-09-23] 不在今日 9:25 正式名单（观察组继承壳 / 影子行）→ 股票名画灰。
//   这是「今天到底抓没抓到它」的身份提示，优先级【最高】：压过卖标签的灰、创业板的浅灰、收盘红绿字色。
//   在正式名单里 → 名字一律回到常规黑（卖标签行与创业板行都按用户要求恢复黑色），
//   创业板的【删除线】保留（防误买是安全提示，不能因为改颜色就丢了）。
//   下方的一字实线 / 停板蚂蚁线是 border-bottom，与 color 属性不冲突，照常保留。
function stockTextClass(item) {
  const cls = {};
  if (item.isYiZi) {
    cls['yizi-limit'] = true;
  } else {
    cls['close-limit-up'] = item.closeLimit === 'up';
    cls['close-limit-down'] = item.closeLimit === 'down';
  }
  // ① 不在正式名单 → 灰（含创业板也灰），删除线照旧
  if (!item.isFormalMember) {
    cls['not-formal-member'] = true;
    if (item.isHighLimitBoard) cls['high-limit-board'] = true;
    return cls;
  }
  // ② 在正式名单 → 常规黑；创业板保留删除线；其余按收盘涨跌上色（既有口径不变）。
  //    ⚠️ formal-member 只在「没有收盘红绿」时才上：它与 .close-name-* 同权重，
  //    无条件加会把收盘红绿字色一并压成黑（CSS 顺序在后面）。
  if (item.isHighLimitBoard) {
    cls['high-limit-board'] = true; // 删除线保留（防误买），浅灰由下方 formal-member 压成黑
    cls['formal-member'] = true;
    return cls;
  }
  if (item.closeNameTone === 'up') { cls['close-name-up'] = true; return cls; }
  if (item.closeNameTone === 'down') { cls['close-name-down'] = true; return cls; }
  // 常规黑：压过「卖」行父级 .auction-item.sold .auction-stock-name 的灰（用户口径：卖也恢复黑色）
  cls['formal-member'] = true;
  return cls;
}
</script>
