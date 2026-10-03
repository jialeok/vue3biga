<!--
  DecisionBuyBlock.vue — 「决策」看板【买点】的一个题材块（独立组件，⛔ 不复用其它看板组件）

  排版（用户口径 2026-09-24 改版 / 2026-09-30 标记改版）：
    第一行：题材名称  ●1（实心红圆点 = 题材排名）  数量：n  竞价一字：n  [昨有买入] [N 次入选]
            ← 一行挤完，省空间；末两个标记见 DecisionTopicHead 的注释（题材级，买点侧专有）
    第二行：选择理由：题材排第一，股票数量n只，m个竞价一字
    第三行起：序号  股票名称 （龙几）  十日涨幅  竞价涨幅（红底/绿底/灰底小徽标）
              竞价量比（小徽标，紧跟在竞价涨幅右边；标签内右侧带 ↑/↓ 箭头 = 与上一交易日相比的方向，
                        增强红底 / 下降绿底 / 基本平或数据不全 = 靛蓝底不带箭头，[VR-COMPARE 2026-10-02]）
              重仓 / 轻仓 / 持有   [竞价买] [尾盘买] [先卖后买]（[BUY-NOW 2026-10-03] 规则⑭：
                判据只看【竞价量比 vs 上一交易日】的方向 → 增强标【竞价买】、
                下降标【尾盘买】、下降且手上已有（行尾是【持有】）标【先卖后买】；
                三个徽标都是【新增】的，⛔ 不替换仓位）
    行下方：  [VRATIO-TREND 2026-10-01 用户口径] 点【序号】或【股票名】展开 / 收起
              「竞价量比 近 5 日」趋势面板（默认收起，样式与早盘竞价看板的趋势图一致）
            ⚠️ [TOPIC-PREV-BOUGHT 2026-09-30 用户口径] 股票行【不再】出现任何「昨天已买」徽标 ——
               它会紧跟股票名，被读成【这一只】的结论，而题材级的标记只能表达题材在延续。
               个股级的信息改由【行尾仓位】表达：这一只昨天真被打过「买」标签 ⇒ 显示【持有】。
            ⚠️ [POSITION-HOLD 2026-09-30 用户口径，2026-10-03 改文案] 重仓 / 轻仓【都】改标【持有】
               （判据与 2026-09-30 一致：昨天已经有仓位了；文案由【加仓】改为【持有】）：
               昨天已经有仓位了，今天继续持有，不再重新建仓。
            重仓与轻仓【混排在同一块里】，序号连续，仓位写在行尾（不再拆两块重复题材名）。

  §21：本组件零业务计算 —— 排名 / 数量 / 一字数 / 理由 / 序号 / 龙几 / 涨幅 / 仓位 / 题材标记
  全部由 logic/decision/decision-rules.js 预先算好，模板只做 v-for 渲染。
-->
<template>
  <div class="dcb-block">
    <!-- 第一行：题材名 + 排名圆点 + 数量 + 竞价一字 + 题材标记（④ 昨有买入 / ⑤ 入选次数） -->
    <DecisionTopicHead
      :topic="block.block.topic"
      :rank="block.pickRank || block.block.rank"
      :count="block.block.count"
      :yizi="block.block.yiziCount"
      :candidate-tag="block.candidateTag"
      :prev-bought-tag="block.prevBoughtTag"
      :streak-tag="block.streakTag"
    />
    <!-- 第二行：选择理由（理由里已含「根据规则N」；规则编号由 Logic 层给出，⛔ 模板零计算 §21） -->
    <!-- [COPY 2026-09-29] dcb-selectable：选票说明文字允许长按选中复制（见 decision-board.css） -->
    <div class="dcb-reason-line dcb-selectable">
      选择理由：{{ block.reason }}<span
        v-if="block.ruleNo"
        class="dcb-rule-no"
      >（规则{{ block.ruleNo }}）</span>
    </div>
    <!-- 第三行起：选中的股票（重仓 / 轻仓 / 持有混排，序号连续）
         [VRATIO-TREND 2026-10-01 用户口径] 点【序号】或【股票名】即可展开 / 收起该股的
         「竞价量比 近 5 日」趋势面板（面板紧跟在本行下方，样式与早盘竞价看板的趋势图一致）。
         展开态是纯 UI 态，真相在 useDecisionBoard#trendOpenSet（§34 状态靠近使用它的模块）。 -->
    <template
      v-for="p in block.picks"
      :key="p.name"
    >
      <div class="dcb-row">
        <span
          class="dcb-seq dcb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(p.name)"
        >{{ p.seq }}</span>
        <span
          class="dcb-name dcb-trend-trigger"
          :title="trendTip"
          @click.stop="toggleTrend(p.name)"
        >{{ p.name }}</span>
        <!-- [TOPIC-PREV-BOUGHT 2026-09-30 用户口径] ⛔ 这里【故意】没有「昨天已买」徽标：
             它紧跟股票名会被读成【这一只】的结论（用户 9/30 反馈「大亚圣象昨天没买也被标」）。
             题材在延续 → 看上面的题材行【昨有买入】；这一只昨天真买过 → 看行尾的【持有】。 -->
        <span
          v-if="p.dragonLabel"
          class="dcb-dragon"
        >{{ p.dragonLabel }}</span>
        <span class="dcb-pct">{{ pctText(p.pct) }}</span>
        <!-- [AUC-BADGE 2026-09-29] 竞价涨幅徽标：与【卖点】完全同款（同一个 .dcb-auc 类、同一份
             formatAucPct + getAucOpenKind），金额与配色都在 Logic 层算好（§21 模板零计算）。
             缺竞价涨幅 ⇒ aucPctText 为空串 ⇒ 整个徽标不渲染（§10 绝不用灰底伪装成「平开」）。 -->
        <span
          v-if="p.aucPctText"
          class="dcb-auc"
          :class="'dcb-auc-' + p.aucTone"
        >{{ p.aucPctText }}</span>
        <!-- [VRATIO-TREND 2026-10-01 用户口径] 竞价量比数值：紧跟在【竞价涨幅】右边（用户指定位置）。
             文案由 Logic 层给（volRatioText，如「量比 2.18」），§21 模板零计算；
             缺当日量比 ⇒ 空串 ⇒ 整个徽标不渲染（§10 绝不用 0.00 冒充「量比很小」）。
             [VR-COMPARE 2026-10-02 用户口径] 与上一交易日相比的方向也画在这个标签里：
               增强 → 整块红底 + ↑；下降 → 整块绿底 + ↓；基本平 / 未知 → 靛蓝底、不带箭头。
               ⛔ 方向、箭头、配色档全部由 Logic 层给（volRatioArrow / volRatioTone），模板只拼接。 -->
        <span
          v-if="p.volRatioText"
          class="dcb-vratio"
          :class="p.volRatioTone ? ('dcb-vratio-' + p.volRatioTone) : ''"
          title="竞价量比（当日值；与早盘竞价看板趋势图里那行小字同一字段）｜箭头 = 与上一交易日相比的方向"
        >{{ p.volRatioText }}<span
          v-if="p.volRatioArrow"
          class="dcb-vratio-arrow"
        >{{ p.volRatioArrow }}</span></span>
        <!-- [POSITION-TONE 2026-09-30（2026-10-03 文案改【持有】）] 仓位（重仓 / 轻仓 / 持有）：
             文案 + 配色档全部由 Logic 层给（p.position / p.positionTone，§21 模板零计算、
             ⛔ 不做 `=== '轻仓'` 这类比较）。
             【持有】= 这一只昨天已经被打过「买」标签（规则④ / 一字模式 ⑫ 的股票级效果）。 -->
        <span
          class="dcb-position"
          :class="'dcb-pos-' + p.positionTone"
        >{{ p.position }}</span>
        <!-- [BUY-NOW 2026-10-03 用户口径 · 规则⑭] 按【竞价量比 vs 上一交易日】决定今天什么时候买：
             【竞价买】= 量比增强（有人抢筹，竞价就得买）；
             【尾盘买】= 量比下降（当天优势不好，别追开盘）；
             【先卖后买】= 量比下降且手上已有（行尾是【持有】），开盘先卖、尾盘再买回。
             ⛔ 文案与配色档都由 Logic 层给（buyActionTag / buyActionTone），模板零判断（§21）；
               算不出量比方向 ⇒ Logic 不给标签 ⇒ 不渲染（§10 不猜）。 -->
        <span
          v-if="p.buyActionTag"
          class="dcb-action"
          :class="'dcb-action-' + p.buyActionTone"
        >{{ p.buyActionTag }}</span>
        <!-- 【三 · 持有】上交易日也在买点里 → 强势股（由 Logic 层标记，模板零计算 §21）。
             [HOLD-UNIFY 2026-10-03] 它与行尾仓位【持有】是同一枚词 —— Logic 层已在
             _markPrevBought 里对「行尾已经是持有」的票清空本字段，同一行不会出现两个「持有」；
             ⛔ 组件不做这个判断（§21 模板零计算）。 -->
        <span
          v-if="p.holdTag"
          class="dcb-hold"
        >{{ p.holdTag }}</span>
      </div>
      <!-- [VRATIO-TREND 2026-10-01] 竞价量比 近 5 个交易日趋势（默认收起，点序号 / 股票名才展开）。
           曲线组件复用 TrendChart（白底 / 折线 / 数值标签 / 日期轴，与早盘竞价趋势图同一套视觉）；
           ⛔ 一整条都没有有效点时不画满屏「--」，改画一行说明（§10 缺失要如实可见）。 -->
      <div
        v-if="trendOpenSet.has(p.name)"
        class="dcb-trend-panel"
      >
        <div class="dcb-trend-label">
          竞价量比 近5日
        </div>
        <TrendChart
          v-if="p.volRatioHasData"
          :points="p.volRatioTrend"
          color="#6366f1"
          :decimals="2"
        />
        <div
          v-else
          class="dcb-trend-empty"
        >
          竞价量比：近 5 个交易日均无数据
        </div>
      </div>
    </template>
    <!-- 辅助说明：本档无轻仓票 / 有股票因缺竞价涨幅未纳入（§10 缺失必须可见，不能静默丢掉）
         [COPY 2026-09-29] dcb-selectable：这几条说明同样允许长按选中复制
         [RULE-BOX 2026-10-03 用户口径] dcb-note-box：股票行【下面的每一条规则】都圈起来 + 浅底色
           （用户原话「买点股票下面的每个规则都应该圈起来，加上浅底色，这样看着舒服些」）。
           ⛔ 只加类名，文案与判定仍全在 Logic 层（§21 模板零计算）。 -->
    <div
      v-for="(n, i) in block.notes"
      :key="'note-' + i"
      class="dcb-block-note dcb-note-box dcb-selectable"
    >
      {{ n }}
    </div>
    <!-- 未达门槛：如实说明（§10 不拿不够格的数据冒充有效信号）
         [COMPACT 2026-09-30] dcb-note-empty = 【简洁】模式下仍保留：
         这类文字说明的是「这一块为什么没有股票」，全部隐藏会剩下一行光秃秃的题材名，
         反而让人以为「没算出来」（§10）。其余说明性文字在简洁模式下隐藏。 -->
    <div
      v-if="!block.qualified"
      class="dcb-block-note dcb-note-box unqualified dcb-note-empty dcb-selectable"
    >
      {{ block.notQualifiedText }}
    </div>
    <div
      v-else-if="block.picks.length === 0"
      class="dcb-block-note dcb-note-box dcb-note-empty dcb-selectable"
    >
      该题材没有可买的非一字股票
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import DecisionTopicHead from './DecisionTopicHead.vue';
// [VRATIO-TREND 2026-10-01] 曲线组件复用既有 TrendChart（纯声明式 SVG：无图表实例、无 dispose 生命周期问题）。
import TrendChart from '../TrendChart.vue';
import { formatRangePct } from '../../logic/decision/decision-rules.js';

defineProps({
  block: {
    type: Object,
    required: true
  }
});

// [VRATIO-TREND 2026-10-01] 与 DecisionBoard.vue 共用同一个 board 实例（provide / inject）：
//   展开态只有一份，本组件不新建状态、不复制一份 board（§6 单一真相 / §34 状态靠近使用它的模块）。
const board = inject('decisionBoard');
const { trendOpenSet, toggleTrend } = board;

/** 序号 / 股票名的悬停提示（纯文案常量，避免模板里写死字符串两处不一致） */
const trendTip = '点击展开 / 收起「竞价量比」近 5 日走势';

// 涨幅格式化走 Logic 层（§21 模板不做格式化）；缺失 → 空串（§10 绝不补 0）
function pctText(pct) {
  return formatRangePct(pct);
}
// ⛔ 此处【不再】做 `position === '轻仓'` 这类比较：配色档由 Logic 层的 p.positionTone 直接给出
//    （§21 模板零判断）。新增「加仓」档时组件无需改动 —— 这正是上一版 isLight() 做不到的。
// ⛔ 也不做 `block.block.topic === ...` 之类的题材判断：④ / ⑤ 两个题材标记直接读 Logic 给的字符串。
</script>
