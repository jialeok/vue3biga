<!--
  AuctionBoardTable.vue — 早盘竞价第一页：龙头组 / 观察组 / 正式组行列表。
  纯物理重组：模板与逻辑来自 src/views/AuctionBoard.vue，经 inject('auctionBoard') 共享同一 composable 实例。

  [DRAGON-GROUP 2026-09-14] 三个区块（龙头组 / 观察组 / 常规组）的行【全部由 AuctionEntityRow 渲染】，
  保证行布局、列（竞价量 / 昨成交量 / 占比）、展开收起、四要素面板在三种分组下完全一致。
  本组件只决定「每个区块有哪些 item、区块之间怎么分隔」。

  [YIZI-SUP 2026-09-20] 「补竞价一字」：把竞价一字看板的一字股【按题材融入】常规组的题材组内末尾。
    改动只发生在【渲染序列】这一层，且只在「题材单独开启 + 开关打开」时生效（displayRows !== null）：
      · 原有循环（v-else 分支）一个字节都没动；
      · viewData / filteredRegularItems 本身不被改写（只是被读），排序、高光、增量缓存、统计数据全不受影响；
      · 关闭开关 → displayRows 变 null → 立刻回到原样。
-->
<template>
  <div
    v-if="!viewData.items || viewData.items.length === 0"
    class="auction-empty"
    @dblclick="openBackend"
  >
    暂无数据，双击打开后台
  </div>

  <!-- [DRAGON-GROUP 2026-09-14] 龙头组：第一页最上方独立区块（观察组之上），用蚂蚁线与观察组隔开。
       数据/索引全部来自 Logic 层（viewData.dragonIndices）；题材模式下 dragonIndices=[] →
       本区块自动不渲染，改用行内「龙」标记辨认。 -->
  <AuctionDragonGroup :items="filteredDragonItems" />
  <div
    v-if="showDragonSeparator"
    class="auction-dragon-separator"
  />

  <!-- [RANGE20-TOP5 2026-10-19 用户口径] 「20日强势补位」独立小组件（紧跟龙头组之后、观察组之前）。
       数据/索引全部来自 Logic 层（viewData.range20LeaderIndices，由 range20-leaders.js 检索）。
       ⚠️ 与龙头组区块【分开渲染】：用户要求「新建一个小组件给它们，这样就不会乱，以后改的时候也方便」
       —— 补位票在行上另有「20天」标签，两者身份不混。空数组时本组件整体不渲染。 -->
  <AuctionRange20Leaders :items="filteredRange20LeaderItems" />

  <div
    v-if="filteredObsItems.length > 0"
    class="auction-group-label auction-obs-group-label"
  >
    观察组
  </div>
  <template
    v-for="(item, idx) in filteredObsItems"
    :key="item.index"
    v-memo="rowMemo(item)"
  >
    <AuctionEntityRow
      :item="item"
      :idx="idx"
    />
  </template>
  <div
    v-if="showObsSeparator"
    class="auction-obs-separator"
  />

  <!-- ★ 2026-09-20「补竞价一字」状态 / 汇总一行（独立组件，§15）：
       紧贴 sticky 表头之下（滚动时始终可见）→ §10 读失败 / 未到 9:25 / 当日无字 都看得见，⛔ 不静默。
       开关关着时本组件自己什么都不渲染（v-if="active"）。 -->
  <AuctionYiziSupplementStatus />

  <!-- ★【题材单独开启 + 补竞价一字打开】→ 渲染「按题材融入」后的序列：
       每个题材组 = 该组原有行（原样渲染）+ 按十日涨幅合并排名插位的补入行（带「补」标）。
       组与组之间不插任何东西 → 视觉上就是「原列表每个题材组里多了几行带标行」。
       组【间】顺序已由 logic/auction/yizi-topic-order.js 按「一字权重（含补入的）降序」重排
       （⚠️ 只在开关打开时生效；开关一关本分支整体不渲染 → 组序与序号立刻回到既有原样）。 -->
  <template v-if="displayRows">
    <template
      v-for="row in displayRows"
      :key="row.key"
      v-memo="row.memo"
    >
      <!-- 「未并入」尾段的说明行：题材不在当日列表里，无处可融（⛔ 不静默丢弃） -->
      <div
        v-if="row.kind === 'tail'"
        class="auction-yizi-sup-tail-head"
        @dblclick.stop
      >
        <span class="auction-yizi-sup-tail-title">未并入</span>
        <span class="auction-yizi-sup-tail-count">{{ row.count }}只</span>
        <span class="auction-yizi-sup-tail-hint">题材不在当日早盘竞价列表里，无对应题材组可并入（仅作参考）</span>
      </div>
      <AuctionEntityRow
        v-else-if="row.kind === 'row'"
        :item="row.item"
        :idx="row.idx"
      />
      <AuctionYiziSupplementRow
        v-else
        :stock="row.stock"
      />
    </template>
  </template>

  <!-- 常规路径：题材未开 / 补竞价一字未开 → 原有循环（与改动前完全一致） -->
  <template v-else>
    <template
      v-for="(item, idx) in filteredRegularItems"
      :key="item.index"
      v-memo="rowMemo(item)"
    >
      <AuctionEntityRow
        :item="item"
        :idx="idx"
      />
    </template>
  </template>
</template>

<script setup>
import { computed, inject, watch, nextTick } from 'vue';
import AuctionDragonGroup from './AuctionDragonGroup.vue';
// [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」独立小组件（用户：「新建一个小组件给它们」）。
import AuctionRange20Leaders from './AuctionRange20Leaders.vue';
import AuctionEntityRow from './AuctionEntityRow.vue';
import AuctionYiziSupplementRow from './AuctionYiziSupplementRow.vue';
import AuctionYiziSupplementStatus from './AuctionYiziSupplementStatus.vue';
const board = inject('auctionBoard');
// 只解构本组件真正用到的东西：行本体（含展开面板、所有列、所有点击交互）已全部下沉到
// AuctionEntityRow，三个区块在这里只决定「哪些 item、怎么分隔」。
// 之前那份 90 项的大解构是「模板与行内联」时代的产物，行搬走后即为死代码（§42 不留 dead code）。
const {
  sortState, expandedSet, viewData,
  filteredObsItems, filteredRegularItems, filteredDragonItems,
  // [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」区块的行（同样支持搜索过滤）。
  filteredRange20LeaderItems,
  showObsSeparator, showDragonSeparator,
  highlightStockSet, openBackend
} = board;

// [YIZI-SUP 2026-09-20] 「补竞价一字」的状态与融入序列（provide 在 AuctionBoard.vue，与表头开关同源）。
// ⚠️ 只读：本组件 ⛔ 不改 board 的任何东西，只是把常规组那一列的行序列换成「原有行 + 补入行」。
// 趋势相关的三个东西只在下面的 row.memo 里用到（补入行会随展开态 / 曲线到货重渲染）。
const {
  active: yiziSupActive, segments: yiziSegments,
  trendExpanded: yiziTrendExpanded, trendLoading: yiziTrendLoading, trendMap: yiziTrendMap
} = inject('auctionYiziSupplement');

// [TOPIC-TREND 2026-09-20] 题材统计条的五日趋势展开态（provide 在 AuctionBoard.vue）。
// ⚠️ 只读：这里唯一要做的事是把它【塞进行级 v-memo 指纹】—— 与既有 expandedSet.has() 完全同一个理由：
//    只变「展开态」而不变任何行内容时，v-memo 会跳过整行重渲染 → 点了统计条没反应。
const topicTrend = inject('auctionTopicTrend');
const topicTrendExpanded = topicTrend.expanded;

// [YIZI-SUP 2026-09-20] 把「分段序列」展平成一条渲染列表。
//
// ★ 为什么必须展平（不是偷懒）：分段序列天然是两层 v-for（组 → 行），而 Vue 的 v-memo **在嵌套
//   v-for 里不成立** —— 内层列表的 memo 缓存槽位由编译产物写成固定下标
//   （`_renderList(inner, fn, _cache, 0)`），每次外层迭代都复用同一个槽位，于是第二个题材组
//   会拿第一个题材组的缓存做比较 → 行被错误跳过或复用（DOM 与数据不一致）。
//   展平成一条 + 单层 v-for 后，每个元素各占一个缓存槽位，memo 语义与改动前逐项一致。
//   （ESLint 的 vue/valid-v-memo 也把嵌套写法判为 error，方向一致。）
//
// 每个元素只带「渲染要用的东西」：kind（尾段说明 / 原有行 / 补入行）+ key + 预先算好的 memo 数组，
// 模板因此零业务计算（§21），也不需要把 28 项指纹在模板里写两份。
//
// [YIZI-SUP v3 2026-09-20] 每段的 `entries` 已经是「原有行与补入行按题材内十日涨幅合并排名后的
// 最终序列、序号 1..N 也已重排」（见 logic/auction/yizi-supplement.js#_mergeSegmentEntries），
// 本组件只负责把它展平成一条渲染列表，⛔ 不再做任何排序/取号。
const displayRows = computed(() => {
  if (!yiziSupActive.value) return null;   // 开关关着 / 非题材单独模式 → 走原有循环
  const out = [];
  (yiziSegments.value || []).forEach(function(seg) {
    const segKey = seg.key;
    const entries = seg.entries || [];
    // 「未并入」尾段：主行为空，只有一行说明 + 补入行（题材不在当日列表里，无处可融）
    if (seg.isOrphan) {
      out.push({ kind: 'tail', key: 'tail:' + segKey, count: entries.length, memo: [segKey, entries.length] });
    }
    entries.forEach(function(entry, idx) {
      if (entry.kind === 'row') {
        // idx 只在 item.seqNo 缺失时作回退显示；题材单独模式下 seqNo 恒 ≥1（见 view-helpers），故不影响显示
        out.push({ kind: 'row', key: 'r' + entry.item.index, item: entry.item, idx: idx, memo: rowMemo(entry.item) });
        return;
      }
      const s = entry.sup;
      // 补入行的 memo：内容字段 + 本功能区自己的展示态（展开态 / 曲线到货）——
      // 与 AuctionEntityRow 把 expandedSet/trendHistory 放进 memo 完全同一个理由：
      // 漏掉它们 → 点序号展开趋势时整行不重渲染。
      out.push({
        kind: 'sup',
        key: 's' + segKey + '-' + s.stock + '-' + s.mergedTopic,
        stock: s,
        memo: [
          // [HIGH-LIMIT-BOARD 2026-09-21] s.code 决定浅灰删除线，漏进指纹 → 代码补上后行不重渲染
          s.stock, s.code, s.seq, s.mergedTopic, s.continueText, s.topicsDisplay, s.topicBg,
          yiziTrendExpanded.value.has(s.stock), yiziTrendLoading.value, yiziTrendMap.value
        ]
      });
    });
  });
  return out;
});

// 行级 v-memo 指纹（原有行）：与改动前模板里那份 28 项内联表达式逐项一致（顺序、项数都没变）。
// 抽成函数的原因：现在有【三条】渲染路径要用它（观察组 / 融入序列 / 常规组），
// 在模板里写三份 = 改一处漏一处 → 高光 / 展开态 / 统计条陈旧的经典成因。
// ⚠️ expandedSet 是 ref，脚本里取 .value；sortState 是 reactive，直接读属性。
function rowMemo(item) {
  return [
    item.itemClass, item.numberClass, item.stockClass, item.ratio, item.ratioArrow,
    item.volumeDisplay, item.yestVolumeDisplay, item.yestColorClass, item.ratioClass,
    item.topicsDisplay, item.topicBg, expandedSet.value.has(item.stock), sortState.byTopic,
    // [RANGE-COLS 2026-10-24 用户口径] 区间涨幅模式（十日 / 二十日）的列结构开关
    //   （隐两列 / 加题材列）：⛔ 必须入指纹 —— 若 range20 数据未到、排序与所有字段都没变，
    //   切 toggle 时 v-memo 会因「内容全等」跳过整行 ⇒ 竞价量列该隐的没隐、题材列该出的没出
    //   （陈旧列结构）。两档合并成一个 0/1：它们【列结构完全相同】，区分它俩没有意义。
    (sortState.byRangePct20 || sortState.byRangePct) ? 1 : 0,
    item.dragonRank, item.dragonPct, item.aucPctNum, item.isYiZi, item.topicStats, item.seqNo,
    // [BOARD-SEQ 2026-10-25 用户口径] 序号列留空标记（区间涨幅模式下非主板 = true）。
    //   ⚠️ 必须单独入指纹：非主板那行 seqNo 恒为 0，只靠上面的 item.seqNo 判不出来，
    //   漏掉 ⇒ 代码补齐 / 切 toggle 后该行仍是旧号（陈旧序号）。
    item.seqBlank,
    item.closeLimit, item.closePct, item.closeNameTone, item.streakLabel,
    // [PRESENCE 2026-10-23 / RANK-BOX 2026-10-24] 「n次在列」标签 + 序号小方框的 class：
    //   两者都是 presence 数据【异步到货】后才有的（先没有 → 随后出现），
    //   漏进指纹 ⇒ 次数/颜色到了但行不重渲染（标签与方框都不出现）。
    item.presenceLabel, item.presenceRankClass,
    // [HIGH-LIMIT-BOARD 2026-09-21] 科创/创业/北交所的浅灰删除线：漏进指纹 → 代码补上后行不重渲染
    item.isHighLimitBoard,
    // [NOT-FORMAL 2026-09-23] 是否在今日 9:25 正式名单（决定股票名/题材是黑还是灰）：
    //   索引是异步到货的，行内输入（volume/note…）可能一个字都没变 → 不入指纹则整行颜色陈旧。
    item.isFormalMember ? 1 : 0,
    item.isDragonGroupMember, item.dragonGroupTopic, item.dragonGroupFormalStar,
    item.dragonGroupPct, item.obsFormalStar,
    // [RANGE-PCT 2026-10-14] 「十日涨幅」toggle 下行上直接显示的数值（= 该模式排序键）：
    //   漏进指纹 → 区间涨幅到货后整行不重渲染（数值不出现 / 顺序与数值对不上）。
    item.rangePct,
    // [RANGE20 2026-10-19] 「20日涨幅」toggle 下行上显示的数值 + 实际参与累乘的天数（悬停 n/20日）。
    //   同款理由必须入指纹：它是两阶段异步到货的（库内腿 → 同花顺补缺），漏掉则整行不重渲染。
    item.rangePct20, item.rangePct20Days,
    // [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「20日涨幅」toggle 下的「总龙一…总龙五」名次：
    //   名次是 rangePct20 到货后【异步】才有的（先没有值 → 置底无标，随后置顶打标），
    //   漏进指纹 ⇒ 数值到了、顺序也换了，但标签不出现（与 rangePct20 同款理由）。
    item.totalDragonRank,
    // [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」toggle 下占比列 → 【名次变化】的文案与配色档：
    //   它们由【异步到货】的昨日名次表派生，行内其它输入可以一个字都没变（先全是 '—'，
    //   名次表到货后才有 +6 / -7）⇒ 漏进指纹 ⇒ Vue 按「内容全等」跳过整行重渲染，
    //   表现为「数据算出来了、屏幕上还是 —」（2026-10-28 实测：50 行里只有 10 行跟着别的字段变化一起刷新）。
    //   ⚠️ tone 单独入指纹：它决定 CSS 类（红/绿/灰），文案相同但档位变化的可能性必须挡住。
    item.range20RankDeltaText, item.range20RankDeltaTone,
    // [TOPIC-TREND 2026-09-20] 题材统计条的五日趋势展开态：漏进指纹 → 点统计条整行不重渲染。
    //   只对本行【带有统计条】时才有意义（统计条只在题材块第一行出现），其余行恒为 false。
    item.topicStats ? topicTrendExpanded.value.has(item.topicStats.topic) : false
  ];
}

// [FEAT 2026-08-18] 表头搜索高光：watch highlightStockSet 直接操作行 DOM 加/移除高光类 + 滚动定位。
// 不走 :class 响应式（v-memo 对 ref(Set).has() 追踪不可靠），改用 watch + DOM 确定生效。
// §17 UI 操作自己渲染的 DOM（行由本组件渲染），非业务逻辑；数据变化后重新加高光避免 v-memo 重渲染覆盖。
// [DRAGON-GROUP 2026-09-14] 龙头组的行已改为与观察组同款标准行（.auction-item），不再是独立胶囊，
// 因此选择器只需扫 .auction-item[data-stock] 即可覆盖三个区块（原先额外扫 .dragon-chip 的说法已作废）。
function applyHighlight() {
  nextTick(() => {
    const s = highlightStockSet.value;
    const rows = document.querySelectorAll('.auction-item[data-stock]');
    rows.forEach(row => {
      const stock = row.getAttribute('data-stock') || '';
      if (s.has(stock)) row.classList.add('auction-row-highlight');
      else row.classList.remove('auction-row-highlight');
    });
    if (s.size > 0) {
      const first = document.querySelector('.auction-item.auction-row-highlight');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}
watch(highlightStockSet, applyHighlight);
watch(viewData, () => { if (highlightStockSet.value.size > 0) applyHighlight(); });
</script>
