// topic-vol-ratio-rules.js — 「题材量比」看板 · 纯规则（Logic 层，§15 独立业务模块，可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-10-11 原话 · 分两轮）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   【第一轮 · 选股】
//   「帮我再做一个看板，名称是题材量比……功能和布局设计和决策看板差不多。只是选股逻辑不一样。
//     选股逻辑按照早盘竞价看板题材的平均竞价量比由高到低选排名第一和排名第二的题材，
//     有题材中的个股数量有条件限制，小于4只的不入选，大于等于4小于等于8的入选1只，
//     大于8只的入选2只，因为早盘竞价看板股票数量就少，所以只有这三档，
//     入选的股票按龙一龙二……，龙一竞价涨停的，看龙二，龙二竞价涨停的看龙三……依次类推。
//     看题材数量选出股票。布局设计和决策看板差不多。这个看板选股逻辑比较简单。
//     举个例子，比如机器人有3只票，题材平均竞价量比78，排第一。AI应用有5只票，题材平均竞价量比68，
//     排第二，大消费10只票，题材平均竞价量比45排三，机器人数量不够4只，所以排除，
//     选排第二和第三的题材，第二的题材ai应用选出一只，首选龙一（非竞价涨停），
//     如果龙一竞价涨停没法买，那就选龙二，如果龙二还是竞价涨停就选龙三，依次类推。
//     排第三的大消费选两只。还是按照上面方法。也就是按要求规则选出两个平均竞价量比高的题材，
//     然后按照题材股票数量，选出股票，股票选龙排位高的，能买的。按照这个逻辑，帮我做一个独立看板。
//     要独立组件，有规则文字说明和决策看板一样。按照规范实现。不要动其它看板和功能。
//     只新增这个题材量比看板。」
//
//   【第二轮 · 完善（本次）】
//     「你完善下，题材量比看板，把标题栏的渐变色改下，颜色变成渐变粉色（股市忌讳绿色），
//       要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙等
//       所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。
//       把股票下方点击展开的量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，
//       包括图上文字），当然我说的标签你要模仿决策看板的，不是模仿分笔买卖看板的
//       （只是模仿它那个展开后的分笔成交图）。」
//
//   【第四轮 · 空仓提醒（2026-10-13，本次）】
//     「题材量比买点侧那里，帮我添加一个条件，数量筛选后，排名第一题材平均量比小于 25 的，题材，
//       在买点侧要提示醒目的空仓……我的需求是，还是按照原来的正常方式选出排名第一，第二的题材的
//       股票，只是在这个低量比的节点，排名第一的题材平均竞价量比小于 25 时，需要文字提示空仓。
//       有空仓提醒。文字大些，醒目些，看到这些文字，我就不开仓了。记住就是按照正常流程选出股票，
//       只是多添加了空仓提醒文字。其它不变。」
//     ⇒ 实现 = TVRB_CASH_ALERT_AVG_VR + buildCashAlert + out.cashAlert + 买点侧顶部的大字标语；
//       ★ 只多一条提醒文案，【选股 / 标签 / 卖点一行未改】（用户「其它不变」）。
//
//   ⇒ 【第二轮的关键设计（就是本文件最重要的一件事）】：
//     本看板【只替换选股】，其余【一律复用决策看板的同一份实现】——
//       · 买点标签：把本文件选出来的块组装成【决策看板买点块的形状】，交给
//         decision-rules.js#finishBuyBlock（= 决策看板买点段自己的收口函数，⑦/⑭、③、④、⑤ 全在里面）
//         ⇒ 占比 / 竞价买 / 尾盘买 / 尾盘买（先卖后买）/ 下杀买（竞价异常）/ 补涨竞价买 /
//           龙一字持有 / 持有 / 昨有买入 / N 次入选 —— **逐字一致，不存在第二份实现**（§6 红线）；
//       · 卖点段：直接调 decision-rules.js#buildSellPlan（同一个函数、同一批判据），
//         只把「今天又进买点」的名单换成【本看板自己选出来的票】（本看板内部自洽）；
//       · 展开面板：分笔明细由 logic/tick/tick-minute.js#decorateTickRow 给出（与分笔买卖看板同一个函数），
//         渲染复用同一个面板组件 ⇒ 图上文字逐字一致（用户明确要求「包括图上文字」）。
//
// 职责边界（§4 / §2）：本文件是【纯函数】—— 不读 state、不发请求、不写库、不消费猫抓额度、
//   只接受「已排好序的题材块 + 龙位名册 + 决策看板的标记上下文」三个入参，
//   产出 UI 可直接渲染的结构。
//
// 数据口径（§6 单一真相，⛔ 本文件绝不另写一套排名 / 分组）：
//   · 题材排名（平均竞价量比降序）→ 复用 decision-rules.js#rankDecisionTopics(entries, MODE_VOL_RATIO)
//     （由 decision-collect.js#collectDecisionTopics 调用 —— 与早盘竞价「题材 toggle」同一套组序口径）；
//   · 题材内龙位（龙一 / 龙二 …） → 复用 decision-rules.js#rankDragons（= computeDragonRankMap）——
//     ⭐【只发主板龙标签】这条闸门就在 computeDragonRankMap 里（创业板 / 科创板 rank 恒为 null），
//     所以「有没有龙位」不需要本文件再判一次板块：rank === null 就是它的结论（§6 不重复实现）。
//   · 买卖动作标签 → 复用 decision-rules.js#finishBuyBlock / buildSellPlan（见上）。
//
// §10 红线：任何缺数据（十日涨幅未加载、竞价量比缺失、龙位算不出、昨日标签没读到）都【不猜】：
//   · 缺量比 → 该题材平均量比显示「—」，且排在最后（由 sortByTopicGroups 的置底口径保证）；
//   · 无龙位（创业板 / 科创板）→ 不进候选（由下面 _dragonCandidates 的 rank 过滤保证）；
//   · 昨日标签 / 历史窗口没读到（ctx 里为 null）→ 对应的持有 / 昨有买入 / 入选次数标记
//     【一枚都不打】（由 finishBuyBlock 内部的 _mark* 各自把关），⛔ 绝不退化成「昨天没买」；
//   · 未就绪 → 由 decision-collect#collectDecisionTopics 给 ready=false + 明确 reason，UI 如实展示。


// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [SPLIT 2026-11-05] 本文件已拆分为 6 个子模块，这里只做 **re-export**（门面）★★
//
// 拆分前 5793 行 / 52 个函数 / 58 个常量，全部挤在一个文件里；改一条规则要在里面翻很久。
// 现在按「依赖方向」分层（上层依赖下层，⛔ 无循环依赖）：
//   tvrb-constants.js    全部常量与文案（纯数据，零逻辑）
//   tvrb-utils.js        纯工具（_normTopic / _sameTopicLoose / _num / _pct2 / 文案词 / 排名小件）
//   tvrb-ebb.js          退潮判定（classifyMainTopic / detectEbbDay / secondEbbTopicOfPrevDay）
//   tvrb-blocks.js       买点块 / 卖点块组装（各条规则的"手"）
//   tvrb-plan.js         主计划 buildTopicVolRatioPlan + 切换日 / 新龙 + 数据缺失清空
//   tvrb-rules-lines.js  规则手册文案
//
// ⚠️ **对外 API 一行都没变** —— 外部 3 处 import 不需要改，测试不需要改。
//   ⛔ 不要往这个文件里再加业务逻辑；要加就加到对应子模块，然后在这里补一行 export。
// ══════════════════════════════════════════════════════════════════════════════════════

export {
  EBB_EVENT_WINDOW_DAYS, EBB_MAIN_TOPIC_TOP_N, EBB_MAIN_TOPIC_MIN_COUNT,
  EBB_DIVERGE_MIN_STREAK, TVRB_MIN_COUNT, TVRB_MID_MAX, TVRB_PICK_MID, TVRB_PICK_BIG,
  TVRB_TOPIC_LIMIT, TVRB_SMALL_TOPIC_MAX, TVRB_CASH_ALERT_AVG_VR, EBB_PICK_TAG,
  EBB_PICK_TONE, EBB_PICK_TITLE, EBB_NO_BUY_TAG, EBB_NO_BUY_TONE, EBB_SECOND_BUY_TAG,
  EBB_SECOND_BUY_TONE, EBB_SECOND_RULE_NO, EBB_SECOND_BUY_TITLE, CASH_NO_BUY_TAG,
  CASH_NO_BUY_TONE, WEAK_HUDDLE_RULE_NO, WEAK_HUDDLE_TAG, WEAK_HUDDLE_BLOCK_TOPIC,
  WEAK_HUDDLE_TOP_N, WEAK_HUDDLE_TONE, WEAK_HUDDLE_TITLE, CATCH_UP_RULE_NO, CATCH_UP_TAG,
  CATCH_UP_BLOCK_TOPIC, CATCH_UP_RANK_FROM, CATCH_UP_RANK_TO, CATCH_UP_MIN_COUNT,
  CATCH_UP_MAX_COUNT, CATCH_UP_MIN_STREAK, CATCH_UP_TONE, CATCH_UP_TITLE,
  TOPIC_LEADER_LIMITDOWN_RULE_NO, TOPIC_LEADER_LIMITDOWN_TAG,
  TOPIC_LEADER_LIMITDOWN_BLOCK_TOPIC, TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG,
  TOPIC_LEADER_LIMITDOWN_NO_BUY_TONE, DIVERGE_DIP_TAG, DIVERGE_FOLLOW_TAG,
  DIVERGE_NO_BUY_TAG, DIVERGE_BUY_TONE, DIVERGE_NO_BUY_TONE, DIVERGE_RULE_NO,
  TVRB_CASH_ALERT_NONE, SWITCH_RULE_NO, NEW_DRAGON_TAG, NEW_DRAGON_TONE, NEW_DRAGON_TOP_N,
  NEW_DRAGON_LOOKBACK_DAYS, NEW_DRAGON_CERTIFY_TOP_N, RANGE10_BACKUP_TONE, RANGE10_BACKUP_TAG, RANGE10_BACKUP_LABEL,
} from './tvrb-constants.js';

export {
  classifyMainTopic, detectEbbDay, secondEbbTopicOfPrevDay, buildEbbDayRecord,
} from './tvrb-ebb.js';

export {
  resolveTvrbTier, avgVolRatioOf, formatAvgVolRatio, buildCashAlert,
} from './tvrb-blocks.js';

export {
  detectSwitchDay, pickNewDragon, buildTopicVolRatioPlan,
} from './tvrb-plan.js';

export {
  buildTvrbRulesLines,
} from './tvrb-rules-lines.js';

// 原文件里的「纯转出」语句（`export { X };`）—— 符号本就不定义在本模块，这里从来源原样转出。
export { RANGE10_BACKUP_RULE_NO } from './range10-backup.js';
