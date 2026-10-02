// decision-mode.js — 「决策」看板【两套买点模式】的唯一分派点（Logic 层，§15 独立业务模块）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [TWO-MODES 2026-10-02 用户口径] 为什么需要这个文件 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「把早盘竞价看板的平行 toggle 改成一字……我想两个版本我都要，这样能对比哪个功能
//   比较好，可以看出哪个效果更好，把利益最大化……现在的决策看板 UI 不变，比较完整了。
//   只是逻辑要跟随早盘竞价看板的 toggle 变化，相当于两种方式。其它看板不变。」
//
// ⇒ 决策看板有【两套完全独立的买点规则】，由早盘竞价第一页那两个题材 toggle 决定用哪一套：
//     · 题材 toggle（题 材 = 按平均竞价量比排名）→ MODE_VOL_RATIO → decision-rules.js
//     · 一字 toggle（一 字 = 按竞价一字数量排名）→ MODE_YIZI      → decision-rules-legacy.js
//
// ── 为什么把分派放在【第三个文件】而不是塞进 decision-rules.js ─────────────────────────
//   legacy 要复用 decision-rules.js 的共享件（领域词表 / 标记工具 / 卖点条文），
//   所以依赖方向必然是 `legacy → rules`。若把分派写进 rules，rules 就得反过来 import legacy
//   ⇒ **ESM 循环依赖**（本项目把「循环依赖 16」当构建基线，多一条就会污染这条红线，且
//      Vite 的循环解析在 .vue 异步边界上表现为「偶发 undefined」而非常规报错，极难查）。
//   ⇒ 分派只能放在【两个模块的上层】：本文件是唯一的出口，⛔ 组件 / composable / collect
//     一律从这里取 buildBuyPlan / rankDecisionTopics / buildRulesLines，不许各自判模式。
//
// ⚠️ 卖点、后置标记（持有 / 昨有买入 / 加仓 / 入选次数）、行内徽标【不分模式】——
//    两套模式共用 decision-rules.js 那一份实现，本文件【不重导出】它们（⛔ 免得看起来像"分模式"）。

import {
  MODE_VOL_RATIO,
  MODE_YIZI,
  normalizeDecisionMode,
  rankDecisionTopics as rankTopicsOfMode,
  buildBuyPlan as buildBuyPlanVolRatio,
  buildVolRatioRulesLines
} from './decision-rules.js';
import {
  buildBuyPlan as buildBuyPlanLegacy,
  buildRulesLines as buildLegacyRulesLines,
  isSmallRiskyTopic
} from './decision-rules-legacy.js';

export { MODE_VOL_RATIO, MODE_YIZI, normalizeDecisionMode };

/**
 * 早盘竞价的排序状态 → 决策看板的买点模式（§6 单一真相：模式只由这一处判定）。
 *
 * 判据 = 早盘竞价第一页那两个题材 toggle 的口径字段（见 topic-sort.js#TOPIC_ORDER_*）：
 *   · 一字 toggle 打开（byTopic + topicOrderBy === 'yizi'）→ MODE_YIZI；
 *   · 其余一切情况（题材 toggle 打开 / 两个都关）→ MODE_VOL_RATIO。
 *
 * ⓘ 为什么「两个都关」也算量比模式：决策看板必须【永远给一个确定的口径】，
 *   不能因为用户没开 toggle 就空着（§10：不产出 = 用户以为今天没信号）。
 *   2026-10-02 之前决策看板本来就是这个口径，所以「没开任何题材 toggle」时保持现行行为，
 *   是唯一不会让老用户觉得「功能坏了」的选择（用户口径「其它看板不变」的同一精神）。
 *
 * §10：入参缺失 / 形状不对 → 一律按 MODE_VOL_RATIO，⛔ 绝不抛错（本函数在 computed 里跑）。
 *
 * @param {{byTopic?:boolean, topicOrderBy?:string}|null} auctionSortState
 *        早盘竞价 store 的 sortState['auction']（useAuctionStore().sortState.auction）
 * @returns {string} MODE_VOL_RATIO | MODE_YIZI
 */
export function resolveDecisionMode(auctionSortState) {
  const s = auctionSortState || {};
  if (s.byTopic && normalizeDecisionMode(s.topicOrderBy) === MODE_YIZI) return MODE_YIZI;
  return MODE_VOL_RATIO;
}

/**
 * 题材排名（分模式）—— **必须与早盘竞价当前那个 toggle 的组序完全同参**，
 * 否则会出现「早盘竞价按一字排、决策看板按量比排」的错位（用户拿屏幕顺序核对决策结果）。
 * @param {Array} entries 见 decision-rules.js#rankDecisionTopics
 * @param {string} mode MODE_VOL_RATIO | MODE_YIZI
 * @returns {Array} 题材块（rank 从 1 起）
 */
export function rankDecisionTopics(entries, mode) {
  return rankTopicsOfMode(entries, normalizeDecisionMode(mode));
}

/**
 * 买点计划（分模式）—— 决策看板 UI 的【唯一】买点来源。
 *
 * 返回值形状两种模式【完全一致】：{heavy, light, candidates, noYizi, smallTopic, bigTopic}
 *   · MODE_YIZI 模式下 candidates 恒为 []（老版没有候选题材概念），
 *     但 noYizi / smallTopic / bigTopic 可能非空（老版四类兜底方案）——
 *     ✅ DecisionBoard.vue 本来就为它们留了渲染分支（buySpecial），所以【UI 一行都不用改】。
 *
 * @param {Array} blocks rankDecisionTopics 的返回（已按当前模式排好序）
 * @param {Map} dragonMap rankDragons 的返回
 * @param {object} [opts] 见 decision-rules.js#buildBuyPlan（legacy 额外要 ladderTopicGroups 等）
 * @param {string} mode MODE_VOL_RATIO | MODE_YIZI
 * @returns {{heavy:object|null, light:object|null, candidates:Array,
 *            noYizi:object|null, smallTopic:object|null, bigTopic:object|null}}
 */
export function buildBuyPlan(blocks, dragonMap, opts, mode) {
  if (normalizeDecisionMode(mode) === MODE_YIZI) {
    // 老版返回结构里没有 candidates 键 ⇒ 补一个空数组，保持【结构契约】与量比模式一致
    // （UI 用 `buy.candidates || []` 兜底，这里显式给出更清晰，也省得 UI 依赖隐式默认）
    const plan = buildBuyPlanLegacy(blocks, dragonMap, opts);
    if (!plan.candidates) plan.candidates = [];
    return plan;
  }
  return buildBuyPlanVolRatio(blocks, dragonMap, opts);
}

/**
 * 规则面板文案（分模式）。两套模式的【卖点段】由 decision-rules.js#sellRulesLines 共用。
 * @param {string} mode MODE_VOL_RATIO | MODE_YIZI
 * @returns {string[]}
 */
export function buildRulesLines(mode) {
  return normalizeDecisionMode(mode) === MODE_YIZI
    ? buildLegacyRulesLines()
    : buildVolRatioRulesLines();
}

/**
 * 【本模式要不要采连板天梯「题材连扳」分组？】—— collect 层唯一的判定入口。
 *
 * 背景：老版规则里有两处【必须靠连板天梯】才能做的兜底，量比模式【完全用不上】：
 *   · ⑤ 全部题材无一字 → 取「题材连扳」里股票数量最多的题材；
 *   · ⑥ 第 1 / 第 2 名是「票 ≤4 只 + 1~2 个一字」的高风险小题材 → 改看题材连扳；
 *   · ④ 第 2 名题材【只有 1 个一字】→ 要和「题材连扳数量第一」比早盘竞价股票数（题材替换）。
 * 连板天梯的采集是【全量行归堆】（§36 性能红线），所以老版就是这么做的：**只在真需要时才采**。
 * 量比模式【任何情况下都不采】—— 它的买点只用「题材排名前二 + 题材数量 + 竞价量比」。
 *
 * ⛔ 采集是【懒】的：这里只回答「要不要」，真正的请求由 collect 层发出（本文件是纯函数，不碰数据源）。
 * §10：采集失败 / 未就绪由 collect 层原样上报（ladderReady / ladderReason），
 *      规则层如实报「数据未就绪」，⛔ 绝不退化成「今天没有连板梯队」。
 *
 * @param {Array<{rank:number, yiziCount:number, count:number}>} topics
 *        rankDecisionTopics 的返回（第 1 / 第 2 名看 rank 取）
 * @param {string} mode MODE_VOL_RATIO | MODE_YIZI
 * @returns {boolean}
 */
export function needsLadderData(topics, mode) {
  if (normalizeDecisionMode(mode) !== MODE_YIZI) return false;
  const list = topics || [];
  // ⛔ 没有题材 = 今天根本不出票（老版 buildBuyPlan 里三条兜底全被 `list.length > 0` 挡住）
  //   ⇒ 此时【不需要】连板天梯。少了这一句，空列表会因 `totalYizi === 0` 误判成「无一字弱市」
  //     而去多采一次天梯（虽说是纯内存 0 请求，但会让「为什么采了天梯」变得难以解释）。
  if (list.length === 0) return false;
  const first = list.find(function(b) { return b && b.rank === 1; }) || null;
  const second = list.find(function(b) { return b && b.rank === 2; }) || null;
  const totalYizi = list.reduce(function(n, b) { return n + (Number(b && b.yiziCount) || 0); }, 0);
  return totalYizi === 0
    || isSmallRiskyTopic(first) || isSmallRiskyTopic(second)
    || !!(second && Number(second.yiziCount) === 1);
}
