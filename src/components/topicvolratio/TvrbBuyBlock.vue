<!--
  TvrbBuyBlock.vue — 「题材量比」看板【选股（买点）】的一个题材块

  用户口径（2026-10-11 第二轮原话）：
    「要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙等
      所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。
      把股票下方点击展开的量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，包括图上文字），
      当然我说的标签你要模仿决策看板的，不是模仿分笔买卖看板的（只是模仿它那个展开后的分笔成交图）。」

  ⇒ 本块的行内标签【与 DecisionBuyBlock 逐枚对齐】（同一个逻辑层字段、同一套配色档）：
      序号  股票名称  [板块风险] （龙几 ±n）  十日涨幅  竞价涨幅  竞价量比  连板  封单额
      占比  仓位（重仓/轻仓/持有）  [动作标签：竞价买 / 尾盘买 / 尾盘买（先卖后买）/
      下杀买（竞价异常）/ 补涨竞价买 / 龙一字持有]  [持有]  + 逐行说明文字
     ⛔ 【不】放分笔看板在行内加的那些东西（20 笔红绿统计 / 立刻买·下杀买胶囊）——
        用户明确说那些不学，只学分笔看板【展开后的那一块面板】。
     ⛔ 仓位槽：本看板没有仓位口径（不标重仓 / 轻仓），只有「昨天买过 ⇒ 持有」。

  展开面板（点【序号】或【股票名】）：
    分笔明细 —— 直接复用分笔买卖看板的 TbbPenPanel（同一个组件的同一段图上文字）。
    ⚠️ 为什么敢复用别的看板的组件：用户要的就是「一样，包括图上文字」。
       那是纯展示组件（4 个 props、零业务、零状态、零请求），复用才【保证】两处逐字一致；
       自己复刻一份反而必然随时间分叉。业务实现（取数 / 红绿统计 / 动作名）也全是同一份
       logic/tick/tick-minute.js，⛔ 没有任何第二份实现。

  §21：本组件零业务计算 —— 排名 / 数量 / 平均量比 / 取几只 / 理由 / 序号 / 龙几 / 涨幅 / 占比 /
       仓位 / 动作标签 / 逐行说明 / 分笔每一行的价格与手数，全部由 Logic 层预先算好。
-->
<template>
  <div
    class="tvrb-block"
    :class="{ 'tvrb-prev-ebb-gray': gray }"
  >
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字 + 平均量比 + 选几只 + [昨有买入] [N次入选] -->
    <TvrbTopicHead
      v-if="!headText"
      :topic="block.block.topic"
      :rank="block.pickRank || block.block.rank"
      :count="block.block.count"
      :yizi="block.block.yiziCount"
      :avg-vol-ratio="block.avgVolRatioText"
      :pick-count="block.pickCount"
      :prev-bought-tag="block.prevBoughtTag"
      :streak-tag="block.streakTag"
    />
    <!-- ★ [EBB-R8 2026-10-14] 退潮首日的【唯一买点】那一行不是题材块，没有「数量 / 竞价一字 / 平均量比」
         这些【题材级】统计（§10 不能拿 '—' 或 0 冒充）⇒ 传了 headText 就只渲染一行标题、跳过题材统计头。
         头文案由 Logic 层给（§21 模板零计算）。⚠️ headText 缺省为空串 ⇒ 常规块行为【一字不变】（§11）。 -->
    <div
      v-else
      class="tvrb-block-head"
    >
      <div class="tvrb-topic-row">
        <span class="tvrb-topic">{{ headText }}</span>
      </div>
    </div>
    <!-- 第二行：选择理由（本看板的选股口径）+ 规则编号（与决策看板买点段同一枚 ①） -->
    <div class="tvrb-reason-line tvrb-selectable">
      选择理由：{{ block.reason }}<span
        v-if="block.ruleNo"
        class="tvrb-rule-no"
      >（规则{{ block.ruleNo }}）</span>
    </div>
    <!-- 第三行起：入选的股票（已按龙位从高到低、已剔除竞价涨停的龙位）
         点【序号】或【股票名】展开 / 收起该股的【分笔明细】面板（纯 UI 态）。 -->
    <template
      v-for="p in block.picks"
      :key="p.name"
    >
      <div class="tvrb-row">
        <span
          class="tvrb-seq tvrb-pen-trigger"
          :title="penTip"
          @click.stop="togglePens(p.name)"
        >{{ p.seq }}</span>
        <span
          class="tvrb-name tvrb-pen-trigger"
          :title="penTip"
          @click.stop="togglePens(p.name)"
        >{{ p.name }}</span>
        <!-- [BOARD-SUSPEND 2026-10-13 用户口径] 当日停牌小标 —— 紧跟股票名（与决策看板同款）。
             停牌票当日无竞价、无分笔，本看板的量比 / 分笔明细都会是空的；
             贴名字放才能一眼分清「这一只今天停牌」与「数据没抓到」（§10 缺数据要说清原因）。 -->
        <span
          v-if="p.suspendTag"
          class="tvrb-suspend"
          :title="SUSPEND_TAG_TITLE"
        >{{ p.suspendTag }}</span>
        <!-- 板块风险（创业板 / 科创板）—— 与决策看板同款，由 Logic 层给（§21）。
             本看板只选主板（有龙位）⇒ 一般不会出现；保留是为了「万一板块闸门变了」也能如实显示。 -->
        <span
          v-if="p.riskTag"
          class="tvrb-risk"
          title="20% 涨跌幅板（创业板 300/301、科创板 688/689）：这类票多为短线套利、波动大最容易吃亏 —— 风险极高，谨慎买入"
        >{{ p.riskTag }}</span>
        <span
          v-if="p.dragonLabel"
          class="tvrb-dragon"
        >{{ p.dragonLabel }}</span>
        <!-- ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条候补行的专属徽标
             （「十日涨幅第 N 名 · 首次在列」，文案全在 Logic 层拼好 §21）。
             ⛔ 它【不是】龙标：那只票来自十日涨幅榜，与题材内的龙位无关 —— 两枚徽标互斥显示
             （候补行的 dragonLabel 恒为空串，见 _buildRange10BackupBlock）。 -->
        <span
          v-if="p.range10Label"
          class="tvrb-r10-label"
          :title="p.range10Title || '十日涨幅名次（只算主板名次，与早盘竞价「10日涨幅」toggle 的在列次数标签同一口径）｜首次在列 = 这 10 个交易日里它只在今天的名单出现过 1 次'"
        >{{ p.range10Label }}</span>
        <!-- 龙标旁边的名次变化（'+3' 上升红 / '-2' 下降绿；无可比 ⇒ 空串 ⇒ 不渲染，§10） -->
        <span
          v-if="p.dragonDeltaText"
          class="tvrb-dragon-delta"
          :class="'tvrb-dragon-delta-' + p.dragonDeltaTone"
          :title="p.dragonDeltaTitle"
        >{{ p.dragonDeltaText }}</span>
        <span class="tvrb-pct">{{ p.pctText }}</span>
        <!-- 竞价涨幅徽标：与决策看板完全同款（同一个 formatAucPct + getAucOpenKind，§6）。
             缺竞价涨幅 ⇒ aucPctText 为空串 ⇒ 整个徽标不渲染（§10 绝不用灰底伪装成「平开」）。 -->
        <span
          v-if="p.aucPctText"
          class="tvrb-auc"
          :class="'tvrb-auc-' + p.aucTone"
        >{{ p.aucPctText }}</span>
        <!-- 竞价量比徽标：紧跟在【竞价涨幅】右边；带 ↑/↓ 表示与上一交易日相比的方向。
             缺当日量比 ⇒ 空串 ⇒ 整个徽标不渲染（§10 绝不用 0.00 冒充「量比很小」）。 -->
        <span
          v-if="p.volRatioText"
          class="tvrb-vratio"
          :class="p.volRatioTone ? ('tvrb-vratio-' + p.volRatioTone) : ''"
          title="竞价量比（当日值）｜箭头 = 与上一交易日相比的方向"
        >{{ p.volRatioText }}<span
          v-if="p.volRatioArrow"
          class="tvrb-vratio-arrow"
        >{{ p.volRatioArrow }}</span></span>
        <!-- 连板 + 封单额（+ 与上一交易日的变化）——与决策看板同款：只有当天涨停的票才有值 -->
        <span
          v-if="p.sealContinueTag"
          class="tvrb-continue"
          title="连板天数（来自涨停池 continue_day_cnt；首板不显示本标签）"
        >{{ p.sealContinueTag }}</span>
        <span
          v-if="p.sealMoneyText"
          class="tvrb-seal"
          :class="p.sealDeltaTone ? ('tvrb-seal-' + p.sealDeltaTone) : ''"
          :title="p.sealDeltaTitle"
        >封单 {{ p.sealMoneyText }}<span
          v-if="p.sealDeltaText"
          class="tvrb-seal-delta"
        >{{ p.sealDeltaArrow }}{{ p.sealDeltaText }}</span></span>
        <!-- 竞价占比标签（与决策看板同款同位置）：文案 / 配色档全在 Logic 层算好。
             缺数据 ⇒ 空串 ⇒ 徽标不渲染（§10 绝不显示 0.0%）。 -->
        <span
          v-if="p.aucShareText"
          class="tvrb-share"
          :class="p.aucShareTone ? ('tvrb-share-' + p.aucShareTone) : ''"
          title="竞价占比 = 当日竞价量 ÷ 昨日成交量（保留 1 位小数）｜买卖时机的主判据：龙头（今日龙一/昨日龙头）门槛 3.5%、其余 2%"
        >占比 {{ p.aucShareText }}</span>
        <!-- 仓位槽：本看板【没有仓位口径】⇒ 正常为空；只有「昨天真买过」时被标成【持有】。
             v-if 必须有：空串渲染出一个没有文字的空胶囊会很难看（§10）。 -->
        <span
          v-if="p.position"
          class="tvrb-position"
          :class="'tvrb-pos-' + p.positionTone"
        >{{ p.position }}</span>
        <!-- 买点动作标签（与决策看板买点段同一份实现）：
             竞价买 / 尾盘买 / 尾盘买（先卖后买）/ 下杀买（竞价异常）/ 补涨竞价买 / 龙一字持有。 -->
        <span
          v-if="p.buyActionTag"
          class="tvrb-action"
          :class="'tvrb-action-' + p.buyActionTone"
        >{{ p.buyActionTag }}</span>
        <!-- 【持有】= 上交易日也在买点里 → 强势股（Logic 层已与仓位槽去重，同一行不会两个【持有】） -->
        <span
          v-if="p.holdTag"
          class="tvrb-hold"
        >{{ p.holdTag }}</span>
        <!-- 逐行说明文字（为什么是竞价买 / 尾盘买…）；【简洁】模式下由 CSS 隐藏 -->
        <div
          v-if="p.actionNote"
          class="tvrb-row-note tvrb-selectable"
        >
          {{ p.actionNote }}
        </div>
      </div>
      <!-- 分笔明细面板（与「分笔买卖」看板的股票展开图【同一个组件、同一段文字】）。
           §10：还没抓 / 没数据时，不假装面板是空的 —— 如实显示状态（⛔ 不留一片空白）。 -->
      <div
        v-if="penOpenSet.has(p.name)"
        class="tvrb-pen-panel"
      >
        <TbbPenPanel
          v-if="p.hasTick"
          :title="p.panelTitle"
          :note="p.panelNote"
          :hint="p.panelHint"
          :pens="p.pens"
          :badges="p.strengthBadges"
        />
        <div
          v-else
          class="tvrb-pen-empty"
          :title="p.emptyTitle"
        >
          {{ p.emptyText || '分笔明细暂不可用' }}
        </div>
      </div>
    </template>
    <!-- 本题材的说明（顺延 / 少取 / 持有 / 昨有买入）—— 圈起来 + 浅底色，与决策看板同款（§10 缺失必须可见）。 -->
    <div
      v-for="(n, i) in block.notes"
      :key="'note-' + i"
      class="tvrb-block-note tvrb-note-box tvrb-selectable"
    >
      {{ n }}
    </div>
    <!-- 未选出任何票：如实说明（§10 不拿空壳冒充结论）
         tvrb-note-empty = 【简洁】模式下仍保留（它说明「这一块为什么没有股票」）。 -->
    <div
      v-if="!block.qualified"
      class="tvrb-block-note tvrb-note-box unqualified tvrb-note-empty tvrb-selectable"
    >
      该题材没有可买入（非竞价涨停）的股票
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
// [BOARD-SUSPEND 2026-10-13 用户口径] 「停牌」小标的悬停文案（唯一出处：suspend.js）；
//   ⛔ 本组件不做判定，只读 Logic 层挂好的 p.suspendTag（§21 模板零计算）。
import { SUSPEND_TAG_TITLE } from '../../logic/auction/suspend.js';
import TvrbTopicHead from './TvrbTopicHead.vue';
// ★ 分笔明细面板：直接复用分笔买卖看板的那一个组件（用户口径「设计和分笔买卖看板的股票展开图
//   一样，包括图上文字」）。它是纯展示组件（4 个 props、零业务、零状态、零请求），
//   复用才【保证】两处逐字一致；⛔ 本组件不为它传任何本看板自己的字段。
import TbbPenPanel from '../tick/TbbPenPanel.vue';

defineProps({
  block: {
    type: Object,
    required: true
  },
  /**
   * ★ [EBB-R8 2026-10-14] 可选：用【一行纯标题】替换题材统计头。
   *
   * 为什么需要：退潮首日买点侧那只【唯一买点】不是题材块 —— 它没有「数量 / 竞价一字 / 平均量比」
   *   这些题材级统计，套 TvrbTopicHead 会渲染出「数量：— 竞价一字：— 平均量比：—」，
   *   看着像数据缺失（§10 拿 '—' 冒充「统计项存在但为空」是误导）。
   * §11：默认空串 ⇒ 常规题材块的行为【一字不变】（走 TvrbTopicHead 原路）。
   * 文案由 Logic 层给（§21 模板零计算）。
   */
  headText: { type: String, default: '' },
  /**
   * ★ [EBB-D1 2026-10-21] 可选：整块灰化（昨日【二次确认退潮】题材 · 第二十六条）。
   *
   * 为什么是 prop 而不是视图层包一层 div：块头 / 行 / 说明都是本组件的内部结构，
   *   灰化必须罩住【整个块】；本组件根节点已有 .tvrb-block ⇒ 挂类最省、DOM 结构零变化。
   * §11：缺省 false ⇒ 其它消费方（退潮替补 / 分歧买点 / 常规块）行为【一字不变】。
   * 灰化视觉与 .tvrb-buy-list.tvrb-ebb 同一套值（grayscale + opacity），⛔ 不新造第二套观感。
   */
  gray: { type: Boolean, default: false }
});

// 与 TopicVolRatioBoard.vue 共用同一个 board 实例（provide / inject）：
//   展开态只有一份，本组件不新建状态、不复制一份 board（§6 单一真相 / §34）。
const board = inject('topicVolRatioBoard');
const { penOpenSet, togglePens } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const penTip = '点击展开 / 收起这一分钟（09:30~09:31）的分笔明细';
</script>
