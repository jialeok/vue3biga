<!--
  TopicVolRatioBoard.vue — 「题材量比」看板（独立看板，§15 独立业务模块）

  定位：挂在【决策看板附近】。它自己不抓数据、不落库，只是把早盘竞价已有的
  题材分组 / 竞价一字 / 十日涨幅 / 竞价量比，按用户定的规则选出「今天买什么」，
  并按决策看板的同一套规则给出【买点标签 + 卖点段】。

  用户口径（2026-10-11 两轮原话）：
    【第一轮】「帮我再做一个看板，名称是题材量比……要独立组件，有规则文字说明和决策看板一样。
      按照规范实现。不要动其它看板和功能。只新增这个题材量比看板。」
    【第二轮】「你完善下，题材量比看板，把标题栏的渐变色改下，颜色变成渐变粉色（股市忌讳绿色），
      要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙等
      所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。
      把股票下方点击展开的量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，包括图上文字），
      当然我说的标签你要模仿决策看板的，不是模仿分笔买卖看板的（只是模仿它那个展开后的分笔成交图）。」

  用户口径（2026-10-13 第四轮）：空仓提醒 —— 「题材量比买点侧那里，帮我添加一个条件，数量筛选后，
    排名第一题材平均量比小于 25 的，题材，在买点侧要提示醒目的空仓……还是按照原来的正常方式选出
    排名第一，第二的题材的股票，只是在这个低量比的节点，排名第一的题材平均竞价量比小于 25 时，
    需要文字提示空仓。有空仓提醒。文字大些，醒目些，看到这些文字，我就不开仓了。……
    其它不变。」
    ⇒ 只在选股段【顶部】多一个 TvrbCashAlert（大字标语），选股 / 标签 / 卖点一行未改。

  分层（§2）：本文件只有模板与调用 ——
      views/TopicVolRatioBoard.vue
        → composables/useTopicVolRatioBoard.js   （UI 状态 + 重算 / 取数时机）
        → logic/decision/decision-collect.js     （读内存真相：题材块 + 龙位名册 + 买卖点标签上下文）
        → logic/topicvolratio/topic-vol-ratio-rules.js（本看板的选股 + 标签收口，纯规则，可单测）
        → logic/tick/tick-minute-store.js / tick-minute.js（分笔明细取数与逐行组装）

  ★ 关于「独立」（2026-10-11 第二轮的口径修正）：
    · 【组件】本看板有自己的 TvrbRulesHint / TvrbTopicHead / TvrbBuyBlock / TvrbSellBlock，
      样式前缀 tvrb- 也是独立的（⛔ 不蹭 decision- / dcb- / tick- / tbb-），UI 改版互不影响。
    · 【业务实现】一律复用别人的同一份（§6 单一真相）——用户要的就是「标签逻辑基本一样」：
      买点标签 = decision-rules#finishBuyBlock、卖点 = decision-rules#buildSellPlan、
      展开面板 = components/tick/TbbPenPanel.vue + logic/tick/tick-minute.js。
      ⛔ 各写一份「看起来一样」的实现是**最坏**的选择：第一次能对上，第一次改规则就分叉。
    · 唯一的例外是那个分笔面板组件：它是纯展示组件（零业务 / 零状态 / 零请求），
      复用才【保证】两处逐字一致（用户原话「包括图上文字」）。
-->
<template>
  <div
    class="tvrb-board trading-day-element"
    :class="{ minimized: !expanded, 'tvrb-compact': compactOpen }"
  >
    <div
      class="tvrb-header"
      @click="toggleExpand"
    >
      <span class="tvrb-title">题材量比</span>
      <TvrbRulesHint
        :lines="rulesLines"
        :open="rulesOpen"
        @update:open="setRulesOpen"
      />
      <span class="tvrb-summary">{{ summaryText }}</span>
      <span class="tvrb-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="tvrb-body"
    >
      <!-- 「简洁」开关：置内容区顶部（与决策看板同一位置口径）。
           打开后只留【题材行 + 股票行 + 行内标签】，隐藏解释性文字 —— 实际隐藏全在
           topic-vol-ratio-board.css 的 .tvrb-compact 里，模板不加 v-if 分支。默认打开。 -->
      <div class="tvrb-compact-bar">
        <span
          class="tvrb-compact-toggle"
          :class="{ on: compactOpen }"
          @click="toggleCompact"
        >简洁</span>
      </div>
      <!-- §10：未就绪 / 失败必须可见，绝不显示成「今天没有入选股票」的空看板 -->
      <div
        v-if="errorText"
        class="tvrb-error tvrb-selectable"
      >
        {{ errorText }}
      </div>
      <!-- 分笔读库 / 抓取的失败原文（单独一块）：分笔只是【展开面板】的数据，
           拿不到不影响选股与标签 —— 所以它单独显示，不冒充「计算失败」。 -->
      <div
        v-if="fetchError"
        class="tvrb-error tvrb-selectable"
      >
        {{ fetchError }}
      </div>
      <div
        v-if="!ready"
        class="tvrb-empty tvrb-selectable"
      >
        {{ reasonText }}
      </div>

      <template v-if="ready">
        <!-- 上：选股（本看板自己的选股口径）—— 行内标签与决策看板买点段完全同一套 -->
        <div class="tvrb-section">
          <!-- ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日 ⇒ 整段标题变灰（用户「把买点侧的文字或者
               UI 全部变成灰色，这样空仓效果更加强烈些」）。⛔ 只是视觉灰化，不改任何数据。 -->
          <!-- ★ [CASH-ALERT-NOBUY 2026-10-16 用户口径] 空仓提醒命中 ⇒ 同样整段变灰（用户「这个提示下的
               买点侧，全部变成灰色……那个灰色的样式类似 10月13日的退潮首日那个买点侧整版灰色，
               你可以参考下」）。⇒ 灰化条件 = `cashAlert.show`（它【已包含】退潮首日：
               buildCashAlert 在退潮日返回的也是 show=true，见那条长注释）
               ⇒ ⛔ 一处条件同时覆盖两种成因，⛔ 绝不新造第二套灰化类。 -->
          <!-- ★ [EBB 2026-10-13 第六轮用户口径] 退潮首日 ⇒ 每只票的买点标签已被 Logic 层
               （_applyEbbBuyRules）一律改写成深墨【退潮不买】，原本的【持有】/ 竞价买 / 尾盘买 /
               先卖后买 等买信号作废 —— 用户「退潮当天，只有卖没有买」。
               ★ [CASH-ALERT-NOBUY 2026-10-16] 非退潮日命中空仓提醒 ⇒ 同样的覆盖式改写出
               【分歧日不买】（_applyCashAlertBuyRules）。
               ⛔ 模板零改动：两枚标签走的都是 p.buyActionTag 那一个出口（§6 收口不变）。 -->
          <div
            class="tvrb-section-title buy"
            :class="{ 'tvrb-ebb': cashAlert.show }"
          >
            选股
          </div>
          <!-- ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒：买点侧【顶部】的大字标语。
               判据（能入选的排名第一题材平均竞价量比 < 25，或当日为【退潮首日】）与文案都在 Logic 层；
               ⛔ 它不改变选股 —— 命中时下面的题材块与股票行照常列出（用户「其它不变」）。
               ⛔ 不能挪到 v-if="ready" 之外：未就绪时给「空仓」结论等于拿没数据当量比低用（§10）。 -->
          <!-- ★ [EBB-R20c 2026-10-20 用户口径] 二次确认退潮 + 常规选出补涨题材 ⇒ 买点侧顶部的
               【节点说明】横幅：用户「这是个退潮节点大方向……新的题材符合条件，这些题材叫做补涨题材，
               因为这是个节点很重要，可能接下来会出现轮动行情……会进入了常规选股规则」。
               ⛔ 纯说明文字：文案与判据全在 Logic 层（out.ebbNodeNote，§21 模板零计算）；
               首次退潮 / 二次走兜底 ⇒ null 不渲染（那两种场景卖点横幅 + 灰化已把状态说满）。
               样式独立类 .tvrb-ebb-node-note（⛔ 不复用卖点 .tvrb-ebb-banner 类名 ——
               两处 head 文本不同，共用类名会让 DOM 查询/E2E 混淆）。 -->
          <!-- ★★ [DIVERGE-GATE 2026-10-21 用户口径] 分歧判定未就绪 ⇒ 买点侧只渲染「判定计算中」占位，
               ⛔ 绝不先把旧规则的选票渲染出去再换板（用户：「刚开始显示的是以前旧规则的票，后面停顿了
               几秒钟，才出现那个提示词分歧的信息板……我做决定很快，万一哪天它没跳转，我不就买错股票了」）。
               门控条件全在组合式 data computed（同步可判、无 setTimeout；判定落地自动重算放行一次成型）。
               ⛔ 未就绪时给「空仓 / 分歧」结论都是拿没数据当结论（§10）⇒ 占位只说【在算】，不说结论。 -->
          <div
            v-if="divergePending"
            class="tvrb-diverge-pending tvrb-selectable"
          >
            <div class="tvrb-diverge-pending-head">
              ⏳ 总龙分歧判定计算中……（比对总龙 K 线，约十几秒）
            </div>
            <div class="tvrb-diverge-pending-detail">
              今天可能是【总龙首次分歧】日（总龙竞价低开）⇒ 买点侧要等分歧判定落地才能给出结论：
              若确认分歧，买点侧将切换为「总龙一（下杀买）+ 不同题材主板高标 ≤2 只」的分歧板；
              若不是分歧日，则按常规规则渲染。为防止先看到旧规则选票再切换造成误判，
              判定落地前这里不显示选票。卖点侧不受影响。
            </div>
          </div>
          <template v-if="!divergePending">
            <div
              v-if="ebbNodeNote"
              class="tvrb-ebb-node-note tvrb-selectable"
            >
              <div class="tvrb-ebb-node-note-head">
                {{ ebbNodeNote.headline }}
              </div>
              <div class="tvrb-ebb-node-note-detail">
                {{ ebbNodeNote.detail }}
              </div>
            </div>
            <TvrbCashAlert :alert="cashAlert" />
            <!-- ★★ [EBB-R8 2026-10-14 → EBB-R20 2026-10-20 用户口径] 退潮日【买点侧替补（≤2 只）】：
               用户原话「从20日涨幅中的总龙一到总龙五选出两只排名靠前的……剩下的就选排名靠前的那两只」。
               ⛔ 它【必须】渲染在 .tvrb-buy-list【之外】—— 那个容器挂着父级 filter: grayscale(1)，
                  CSS 的 filter 无法被子元素撤销；放进去就等于把「今天能下手的替补」也灰掉了。
               ⛔ 它【不在】blocks 里（见组合式的 ebbBuy），是独立的一段；不是退潮日 / 选不出 ⇒ 整个容器不渲染。
               ⚠️ 容器标签由 Logic 下发（ebb.buyOnlyLabelText，§21 模板零计算）；head-text 传块的合成题材头。 -->
            <div
              v-if="ebbBuy"
              class="tvrb-ebb-only-buy"
            >
              <div class="tvrb-ebb-only-label tvrb-selectable">
                {{ ebb && ebb.buyOnlyLabelText ? ebb.buyOnlyLabelText : '退潮替补 · 买点' }}
              </div>
              <TvrbBuyBlock
                :block="ebbBuy"
                :head-text="ebbBuy.block.topic"
              />
            </div>
            <!-- ★★ [DIVERGE 2026-10-20 用户口径] 市场总龙一【首次分歧】日的分歧买点（总龙一下杀买 +
               不同题材主板高标 ≤2 只）。结构与退潮替补同一形态：渲染在灰化容器 .tvrb-buy-list【之外】
               （今天真要买的那几只不能被 grayscale 吞掉）；不是分歧日 / 退潮日接管 ⇒ 不渲染。
               ⛔ 类名独立（.tvrb-diverge-only-*）—— 与退潮替补是两条规则，DOM 查询不能混。 -->
            <div
              v-if="divergeBuy"
              class="tvrb-diverge-only-buy"
            >
              <div class="tvrb-diverge-only-label tvrb-selectable">
                总龙首次分歧 · 买点（第二十五条）
              </div>
              <!-- ★ [DIVERGE-MANTRA 2026-10-21 用户口径] 用户指定的口诀，要求「醒目些」——
                 纯展示文案（与上面 label 同一先例：静态标语放视图层），样式见 .tvrb-diverge-mantra。 -->
              <div class="tvrb-diverge-mantra tvrb-selectable">
                买在分歧，卖在一致，分歧切核心，弱势切抱团
              </div>
              <TvrbBuyBlock
                :block="divergeBuy"
                :head-text="divergeBuy.block.topic"
              />
            </div>
            <!-- ★★ [SWITCH 2026-10-22 用户口径] 第二十八条【新龙 / 新题材切换日】的新龙那一行。
               结构与退潮替补 / 分歧买点同一形态：渲染在灰化容器 .tvrb-buy-list【之外】
               （今天真要买的那一只不能被 grayscale 吞掉）；不是切换日 / 选不出新龙 ⇒ 不渲染。
               ⛔ 类名独立（.tvrb-newdragon-only-*）—— 三条规则各不相同，DOM 查询不能混。
               注：常规侧在同一天已被 Logic 层【收紧】成「一个题材、一只票」（第二十八条），
                   所以这里看到的就是今天的全部买点：新龙 + 常规那一只。 -->
            <div
              v-if="newDragon"
              class="tvrb-newdragon-only-buy"
            >
              <div class="tvrb-newdragon-only-label tvrb-selectable">
                新龙 / 新题材切换日 · 买点（第二十八条）
              </div>
              <TvrbBuyBlock
                :block="newDragon"
                :head-text="newDragon.block.topic"
              />
            </div>
            <!-- ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条【十日涨幅 · 在列次数候补】那一只。
               结构与退潮替补 / 分歧买点 / 新龙同一形态：渲染在灰化容器 .tvrb-buy-list【之外】
               （今天真要买的那一只不能被 grayscale 吞掉）；不需要候补 / 选不出 / 次数未到 ⇒ 不渲染。
               ⛔ 类名独立（.tvrb-r10backup-only-*）—— 四条规则各不相同，DOM 查询不能混。
               ★ [R10-STOCK-LEVEL 2026-10-24] 它是【股票级通道】（从全市场选股，不选题材）：
                 ① 第二题材被作废时这一块补上（被作废那块已由 Logic 层整块删除）；
                 ② 【第一题材量比不达标 ⇒ 整段灰化空仓】时也会出现在这里 —— 这一块【不灰】，
                    它与上方灰化块里的同一只票重复出现是设计如此（题材结论 ≠ 股票结论）。
                 所以本块的存在【不代表】上方一定被删掉了一个题材块。 -->
            <div
              v-if="range10Backup"
              class="tvrb-r10backup-only-buy"
            >
              <div class="tvrb-r10backup-only-label tvrb-selectable">
                十日涨幅候补 · 买点（第二十九条 · 全市场选股，不是选题材）
              </div>
              <TvrbBuyBlock
                :block="range10Backup"
                :head-text="range10Backup.block.topic"
              />
            </div>
            <!-- 退潮首日 / 空仓提醒：股票块整体灰化（⛔ 上面的空仓标语【不灰】—— 它正是要被看见的那一条）
               ⛔ 上面那只【唯一买点】也不灰（它在本次容器之外，见上）。
               ★ [CASH-ALERT-NOBUY 2026-10-16] 条件 = cashAlert.show（含退潮首日，同上面的标题一处口径）。 -->
            <div
              class="tvrb-buy-list"
              :class="{ 'tvrb-ebb': cashAlert.show }"
            >
              <!-- ★ [EBB-D1 2026-10-21] b.prevEbbGray（Logic 层旗子）⇒ 只给【昨日二次确认退潮】那一个
                 题材块挂灰化类（第二十六条：整块灰化 + 退潮不买，其它题材块不灰）。
                 ⛔ 走 TvrbBuyBlock 的可选 prop（§11 缺省 false = 其它消费方零行为），不新造灰化 CSS。 -->
              <TvrbBuyBlock
                v-for="b in blocks"
                :key="'tvrb-buy-' + b.topic"
                :block="b"
                :gray="!!b.prevEbbGray"
              />
            </div>
            <div
              v-if="blocks.length === 0"
              class="tvrb-empty tvrb-selectable"
            >
              当日没有满足条件的题材（题材数量 ≥ 4 只）
            </div>
          </template>
        </div>

        <!-- 蚂蚁线分隔（与决策看板同款视觉语言） -->
        <div class="tvrb-sep" />

        <!-- 下：卖点（与决策看板卖点段同一份实现；候选 = 昨日打过「买」标签的股票） -->
        <div class="tvrb-section">
          <div class="tvrb-section-title sell">
            卖点
          </div>
          <!-- ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日的【说明】—— 用户「你帮我完善下题材量比规则，
               并改下标签和说明」里的「说明」。文案全在 Logic 层（detectEbbDay，§21 模板零计算）。 -->
          <div
            v-if="ebb"
            class="tvrb-ebb-banner tvrb-selectable"
          >
            <div class="tvrb-ebb-banner-head">
              {{ ebb.headline }}
            </div>
            <div class="tvrb-ebb-banner-detail">
              {{ ebb.detail }}
            </div>
          </div>
          <TvrbSellBlock
            v-for="g in sellGroups"
            :key="'tvrb-sell-' + g.groupKey"
            :group="g"
          />
          <div
            v-if="sellGroups.length === 0"
            class="tvrb-empty tvrb-selectable"
          >
            昨日没有打「买」标签的股票，无需卖出
          </div>
        </div>

        <!-- 看板级说明：被排除的题材（数量不足 / 不足两个题材）—— 圈起来 + 浅底色 -->
        <div
          v-for="(n, i) in notes"
          :key="'g-note-' + i"
          class="tvrb-block-note tvrb-note-box tvrb-selectable"
        >
          {{ n }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, provide } from 'vue';
import TvrbRulesHint from '../components/topicvolratio/TvrbRulesHint.vue';
import TvrbBuyBlock from '../components/topicvolratio/TvrbBuyBlock.vue';
import TvrbCashAlert from '../components/topicvolratio/TvrbCashAlert.vue';
import TvrbSellBlock from '../components/topicvolratio/TvrbSellBlock.vue';
import { useTopicVolRatioBoard } from '../composables/useTopicVolRatioBoard.js';

// ⛔ 只调用一次组合式：重复调用会拿到【另一套 ref】，expose 出去的 refresh 就刷新不到本实例上
const board = useTopicVolRatioBoard();

// 把同一份 board 实例下发给【选股块 / 卖点块】两个组件（它们用 inject('topicVolRatioBoard') 取
//   penOpenSet / togglePens）——与决策看板 provide('decisionBoard') 同一范式：
//   展开态只有一份（§6 单一真相），子组件不新建状态、不复制一份 board。
provide('topicVolRatioBoard', board);

const {
  expanded,
  rulesOpen,
  compactOpen,
  errorText,
  fetchError,
  ready,
  reasonText,
  blocks,
  sellGroups,
  notes,
  cashAlert,
  ebb,
  ebbBuy,
  ebbNodeNote,
  divergeBuy,
  divergePending,
  // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条新龙 / 切换日（switchDay 的文案已由 Logic 层写进
  //   block.reason / notes，模板不需要它 ⇒ ⛔ 不解构，免得留一个未使用变量）
  newDragon,
  // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条「十日涨幅 · 在列次数候补」那一只
  //   （同样渲染在灰化容器【之外】：题材量比太小被作废后，它才是今天真正要买的那一只）
  range10Backup,
  summaryText,
  rulesLines,
  toggleExpand,
  toggleCompact,
  setRulesOpen
} = board;

// 与早盘竞价 / 涨跌停 / 决策 / 分笔同款三角（实心 ▲/▼），别再各写一套
const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));

// 与其它看板同款契约（AuctionBoard / LimitBoard / DecisionBoard 都是 defineExpose({ refresh })）
defineExpose({ refresh: board.refresh });
</script>
