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

import {
  formatRangePct, RULE_NO, finishBuyBlock, buildSellPlan,
  SELL_OUT_TAG, SELL_ACTION_TONE_OUT, HOLD_TAG
} from '../decision/decision-rules.js';
// [EBB 2026-10-13] 占比达标判据 + 展示文案（§6 唯一实现，⛔ 不手写 `share >= 门槛`）
import {
  passesAuctionShare, formatAuctionShare, auctionShareThresholdOf
} from '../decision/auction-share.js';
import { getDragonLabel } from '../auction/dragon-rank.js';

// ══ 档位常量（§6 唯一实现：本看板的「取几只」只由这里决定）════════════════════════════════
// 用户口径：< 4 只不入选；4 ~ 8 只入选 1 只；> 8 只入选 2 只（早盘竞价股票少，只有这三档）。
// ⛔ 别自行改成 ≥ 8 / > 10 之类：三个边界与用户原话「小于4」「大于等于4小于等于8」「大于8」逐字对应。
/** 不入选门槛：题材股票数量 < 本值 ⇒ 该题材排除（顺延到下一题材） */
export const TVRB_MIN_COUNT = 4;
/** 中档上界：TVRB_MIN_COUNT ~ 本值 ⇒ 取 1 只 */
export const TVRB_MID_MAX = 8;
/** 中档取几只 */
export const TVRB_PICK_MID = 1;
/** 大档（> TVRB_MID_MAX）取几只 */
export const TVRB_PICK_BIG = 2;
/** 只取排名最靠前的【几个】入选题材（用户口径「排名第一和排名第二」，不足则顺延） */
export const TVRB_TOPIC_LIMIT = 2;

/**
 * ══ 【空仓提醒】门槛（第四轮 · 2026-10-13 用户口径）═══════════════════════════════════════
 *
 * 用户原话：「题材量比买点侧那里，帮我添加一个条件，数量筛选后，排名第一题材平均量比小于 25 的，
 *   题材，在买点侧要提示醒目的空仓……比如今天，题材最高的电力新能源平均竞价量比是 45.92，
 *   题材显示只有 3 只（排除创业板后，数量显示对的），这个题材排除入选，看排名第二的 AI 应用，
 *   数量 14 只，（按照现有规则正常入选），题材平均竞价量比 21.51，相当于现在 AI 应用平均竞价量比
 *   排名第一（能入选的），但是排名第一的 AI 应用平均竞价量比太低了，相当于题材退潮了，什么票都
 *   跌得很厉害。（排名第二更不用说，因为是按题材的平均竞价量比排名第二，只有更低，所以看被选中的
 *   题材排名第一的就可以了）……我的需求是，还是按照原来的正常方式选出排名第一，第二的题材的股票，
 *   只是在这个低量比的节点，排名第一的题材平均竞价量比小于 25 时，需要文字提示空仓。……
 *   记住就是按照正常流程选出股票，只是多添加了空仓提醒文字。其它不变。」
 *
 * ⇒ 判据（★ 只看【能入选的】题材里排名第一的那一个，也就是买点侧第一个题材块）：
 *     avgVolRatio(blocks[0]) < TVRB_CASH_ALERT_AVG_VR  ⇒  买点侧顶部显示大字【建议空仓】。
 *   ⛔ 不看排名第二：它按定义只会更低（排名就是按平均竞价量比降的），拿它判等于判了个更松的条件。
 *   ⛔ 【不改变选股】：命中时股票照常按规则列出（用户原话「还是按照原来的正常方式选出……的股票」），
 *      所以本判据只产出一条【提醒文案】，绝不删块 / 删票 / 改档位。
 *   ⛔ 缺数据（该题材一行量比都没拿到 ⇒ avgVolRatio === null）⇒ 【不提示】（§10：未知 ≠ 低）。
 *   ⛔ 一个题材都没入选（blocks 为空）⇒ 【不提示】—— 那属于「没有合格题材」，看板已有自己的说明，
 *      与「入选了但量比太低」是两件事（⛔ 不拿这条去冒充）。
 *
 * ★ 25 这个数来自用户原话，是一个【经验阈值】而不是从数据推导出来的物理量 —— 原样写死在这里，
 *   ⛔ 别自行调成 20 / 30：它决定「今天到底开不开仓」，只能用户改。
 */
export const TVRB_CASH_ALERT_AVG_VR = 25;

/**
 * ══ 【退潮首日】卖点动作标签（第五轮 · 2026-10-13 用户口径）════════════════════════════════
 *
 * 用户原话：「市场上十日涨幅最高的那只股票所在的题材，在题材退潮首日（龙一停牌或者占比不达标），
 *   卖点侧同题材龙二可以看分笔卖出，进行卖出，不看占比卖出，还有不同题材的龙一也可以这样，
 *   但要有条件，不同题材的龙一必须是总市场的龙二……相当于选出两只可以等开盘卖出的。……
 *   其它普通股票都可以竞价卖，降低风险。」
 *
 * ⇒ 退潮首日时，卖点侧只有【两类票】标这枚标签（= 允许「等开盘看分笔再卖」、不看占比）：
 *     ① 同题材可用龙位（总龙所在题材里龙位最靠前、且非一字 / 非停牌的那只，可顺延）；
 *     ② 市场总龙二（昨日十日涨幅第二、且是它自己题材的龙一、且与总龙不同题材、非一字 / 非停牌）。
 *   其余（含原本标【持有】的）一律改【竞价卖】（SELL_OUT_TAG）—— 用户拍板「全部改竞价卖」。
 *
 * ⛔ 只在本看板用：决策看板 / 分笔看板零改动（用户「注意我说的题材量比看板的卖点侧」）。
 */
export const EBB_PICK_TAG = '看分笔卖';
/** 退潮标的配色档（本看板独有：洋红 #c026d3 + 虚线边 —— 与 竞价卖 的绿 / 持有 的蓝都不同） */
export const EBB_PICK_TONE = 'pen';
/** 悬停说明（文案唯一出处；组件只渲染 Logic 给的值，§21） */
export const EBB_PICK_TITLE =
  '退潮首日专用：市场总龙（昨日十日涨幅第一）今日停牌 / 竞价占比不达标 ⇒ 题材退潮。' +
  '本股是【同题材可用龙位】或【市场总龙二】⇒ 允许【看分笔卖】（不看占比）：' +
  '9:25 不竞价卖，等 9:30~9:31 点开分笔成交看结论 ——【冲高卖】等冲高再清、【立刻卖】直接止损。';

/**
 * ══ 【退潮首日】买点动作标签（第六轮 · 2026-10-13 用户口径补正）══════════════════════════
 *
 * 用户原话（2026-10-13 第二轮反馈）：
 *   「退潮当天，只有卖没有买吗？新华文轩买点侧还标有 持有 竞价买，应该标的是，"退潮不买"，
 *     ……还是我说的规则，标签改变下。其它不变。」
 *
 * ⇒ 退潮首日，买点侧【每一只票】的动作标签一律换成这一枚 ——
 *   原本由 finishBuyBlock 给出的【持有】/【竞价买】/【尾盘买】/【先卖后买】… 全部作废
 *   （用户口径「退潮当天，只有卖没有买」）。
 *
 * ⛔ 只在本看板用：决策看板 / 分笔看板零改动（用户「其它不变」）。
 * ⚠️ 它是【覆盖式后处理】，与卖点的 _applyEbbSellRules 同一范式 —— ⛔ 绝不去改 finishBuyBlock 内部
 *   （那是决策看板与本看板共用的同一份实现，在里面加本看板专有分支等于给决策看板也加了规则）。
 */
export const EBB_NO_BUY_TAG = '退潮不买';
/**
 * 配色档（本看板独有）：深墨底 + 近白字。
 *
 * ⚠️ 为什么【不用红 / 绿】：行内所有红色系胶囊（#dc2626 竞价买 / #be123c 下杀买 / #f43f5e 补涨）
 *   都是「今天要买」的动作标签，用红底会被一眼读成买点信号，正好帮倒忙（与 .tvrb-risk 同一取舍）。
 * ⚠️ 为什么用【深底 + 亮字】而不是中性灰：买点侧整体挂着 `filter: grayscale(1)`（退潮空仓视觉），
 *   grayscale 只去色相 / 饱和度、【保留明度】⇒ 深底亮字在灰化后仍是整行对比最强的元素，
 *   中性灰标签反而会被灰化吞掉、读不出来。
 */
export const EBB_NO_BUY_TONE = 'ebb-nobuy';

/**
 * ══ 【退潮首日】买点侧唯一那只【市场龙二】的专属标签（第八轮 · 2026-10-14 用户拍板）══════
 *
 * 用户原话：
 *   「买点只有一个，那就是市场的龙二（不是同题材的），是整个早盘竞价看板的股票列表中的
 *     十日涨幅排名第二的龙二，就像今天的九阳股份（市场排名十日涨幅 86%，总列表排名第二），
 *     把它入选到买点侧……注意我说的的时间点，是市场总龙头出现首日停牌或者占比不达标的情况下，
 *     买点侧只有一个，那就是市场的龙二（十日涨幅排名第二），其它都是卖点侧不变。」
 *   （口径追问时用户拍板：标签做成【单独一枚「总龙二买」】，并【保留原有题材块（灰化 + 退潮不买）】）
 *
 * ⇒ 退潮首日，买点侧**唯一可买的那一行** = 当日十日涨幅「总列表排名第二」的那只，
 *   它挂这一枚标签（⛔ 不是 finishBuyBlock 的 竞价买 / 尾盘买 —— 用户明确要专属标签），
 *   原始买点信号（占比达标与否）写进行内说明，信息一枚不丢。
 * ⛔ 与 EBB_NO_BUY_TAG 是两枚不同的标签：那枚是「今天不买」，这枚是「今天唯一买点」。
 */
export const EBB_SECOND_BUY_TAG = '总龙二买';
/**
 * 配色档（本看板独有）：琥珀金底 + 近白字。
 *
 * ⚠️ 为什么不用红 / 也不用深墨：
 *   · 红系（#dc2626 竞价买）是常规买点色，但它旁边就是【退潮不买】的深墨 —— 两枚都「买」字辈，
 *     要有明显区分度才能一眼认出「这条是今天唯一能下手的那条」；
 *   · 本行【不参与整体灰化】（它在 .tvrb-ebb 灰化容器之外）⇒ 琥珀金在灰化块旁边最跳。
 *   ⛔ 涨=红是行情数字的口径，不是「标签底色」的口径：本看板的 竞价买 本身就是红底，
 *     这里刻意用金，避免与「退潮不买」混读。
 */
export const EBB_SECOND_BUY_TONE = 'ebb-second';
/** 这一行引用的规则编号（= 规则手册第二十一条「退潮首日 · 买点侧唯一那只」） */
export const EBB_SECOND_RULE_NO = '二十一';
/** 悬停说明（文案唯一出处；组件只渲染 Logic 给的值，§21） */
export const EBB_SECOND_BUY_TITLE =
  '退潮首日【唯一买点】：市场龙二 = 当日十日涨幅在【早盘竞价全列表】里排名第二（有龙位）的那只。' +
  '市场总龙（昨日十日涨幅第一）今日停牌 / 占比不达标 ⇒ 题材退潮，买点侧只留这一只；' +
  '其余入选票一律【退潮不买】（灰色）。';

/**
 * 【退潮首日】判据（纯函数，可单测）。
 *
 * 数据来源 = decision-collect#_ebbCtxOf 采好的「事实」（市场总龙 / 今日停牌 / 今日占比 /
 *   同题材龙位成员 / 市场总龙二），⛔ 本函数不读 state、不发请求（§4）。
 *
 * ── 判据（★ 用户口径：「龙一停牌或者占比不达标……两种情况，有一种存在就算退潮」）──────────
 *   ① 市场总龙【今日停牌】⇒ 退潮（停牌 = 最强的那只都停了）；
 *   ② 市场总龙【今日竞价占比不达标】⇒ 退潮。
 *   ⛔ ② 的占比【缺数据】⇒【不判】（§10：未知 ≠ 不达标）；门槛走 auction-share 的唯一实现。
 *   ⛔ 两条都不成立 ⇒ 返回 null（= 不是退潮日，⛔ 不回落到「没有总龙」）。
 *
 * ── ★★【首日】闸门（第八轮 · 2026-10-14 用户口径，本轮新增）─────────────────────────────
 *   用户原话：「我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
 *     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
 *   ⇒ 上面①/② 成立【且】上一交易日【同一只总龙】还没处在坏状态 ⇒ 才是「退潮首日」。
 *     昨天就已经停牌 / 占比不达标 ⇒ 今天算第 2 天 ⇒ 返回 null（本规则不生效）。
 *
 *   「昨日状态」的两条来源（按优先级，见 _prevLeaderDayState）：
 *     ① 【落库的昨日判定】—— verdict 来自 tvrb_ebb_days 表（用户口径「你应该把数据存起来啊，
 *        做一个表也行，不然很难判断出来」）⇒ 最权威：那一天到底算不算退潮，是当天亲眼判定后存下来的；
 *     ② 退路：库里昨日那一行的【竞价量 / 占比】推断（量 0 ⇒ 无竞价 ⇒ 停牌语义；占比走唯一实现）；
 *     ③ 两处都取不到 ⇒ 按【首日】处理（继续提醒）—— 用户拍板「取不到就按首日处理，别漏掉风险」。
 *   ⚠️ 只认「同一只总龙」：昨日那只总龙与今日不是同一只 ⇒ 对今天这只而言本来就是首日。
 *
 * ── 涨幅口径（用户原话「我说的时间点是昨日，因为当天早上还没收盘计算出来」）──────────────
 *   总龙一律用【上一交易日】的十日涨幅 —— 由调用方按 prevDate 从 stock_range_pct 读回后注入。
 *   ⚠️ 当日口径在停牌票上【必然读不到】（当天没交易就没有当天涨幅）⇒ 最典型的场景恰恰算不出来。
 *   ⚠️ 但【买点侧唯一那只 · 市场龙二】用的是【当日】涨幅（用户举的例子 = 九阳股份 当日 86%，
 *      「是整个早盘竞价看板的股票列表中的十日涨幅排名第二」= 屏幕上那一列）——
 *      两者用途不同（总龙要在停牌时也排得出；龙二只看今天强不强），⛔ 别混用。
 *
 * @param {{ready:boolean, leader:object|null, leaderSuspended:boolean, leaderShare:number|null,
 *          siblingDragons:Array, secondInfo:object|null, prevLeader:object|null,
 *          buySecond:object|null}|null} ebbCtx
 *        prevLeader / buySecond 见 decision-collect#_ebbCtxOf（第八轮新增的两个事实）
 * @param {{leader_stock?:string, ebb?:boolean}|null} [prevEbbDay]
 *        ★ [EBB-R8] 上一交易日在 tvrb_ebb_days 里落库的判定行（缺省 = 表里还没有 / 表不存在）
 * @returns {null|object} null = 不是退潮日（或事实未就绪 / 不是首日）；否则见下方返回结构
 */
export function detectEbbDay(ebbCtx, prevEbbDay) {
  // §10：事实未就绪（昨日涨幅还没读回来 / 全列表一只票都排不出）⇒ 不判退潮
  if (!ebbCtx || !ebbCtx.ready || !ebbCtx.leader) return null;
  const leader = ebbCtx.leader;
  const leaderName = String(leader.name || '').trim();
  const leaderTopic = String(leader.topic || '').trim();
  const leaderPct = _num(leader.pct);
  if (!leaderName || leaderPct === null) return null;      // §10：涨幅读不到 ⇒ 不判

  // ── 判据 ①/② ──
  const leaderIsDragonOne = (Number(leader.rank) === 1);
  const sh = _num(ebbCtx.leaderShare);
  let reason = '';
  if (ebbCtx.leaderSuspended) {
    reason = 'suspend';
  } else if (sh !== null && !passesAuctionShare(sh, leaderIsDragonOne)) {
    // ⛔ 门槛按「总龙 = 它的题材的龙一」取龙头档（3.5%）；它不是龙一（创业板 / 未成组）时回落 2% 档 ——
    //    后者更宽松 ⇒ 更不容易误判成退潮（宁可漏判，也不要在平常日子把全市场都改成竞价卖）。
    reason = 'share';
  }
  if (!reason) return null;

  // ── ★★【首日】闸门（第八轮）──
  const prev = _prevLeaderDayState(ebbCtx, prevEbbDay, leaderName);
  if (prev.bad) return null;   // 昨日同一只总龙已在坏状态 ⇒ 今天不是首日 ⇒ 本规则不生效

  // ── 【看分笔卖】的两只（用户口径逐条对应；用户拍板：龙位可顺延、总龙二不顺延）──
  //   ① 同题材可用龙位 = 总龙所在题材内 rank ≥ 2 的成员，按龙位升序取第一个【非竞价一字 + 非停牌】的
  //      （龙二不可用 ⇒ 顺延龙三、龙四……）；
  //   ② 市场总龙二 = 昨日涨幅第二那只，且必须是【它自己题材的龙一】、与总龙【不同题材】、
  //      非竞价一字、非停牌（⛔ 不回落到涨幅第三 —— 用户明确「它必须正好是涨幅第二」）。
  const sib = (ebbCtx.siblingDragons || []).filter(function(s) {
    return _num(s.rank) !== null && Number(s.rank) >= 2 && !s.isYizi && !s.suspended;
  })[0] || null;
  const si = ebbCtx.secondInfo;
  const secondOk = !!(si &&
    Number(si.rank) === 1 && !si.isYizi && !si.suspended &&
    String(si.topic || '').trim() !== leaderTopic &&
    String(si.name || '').trim() !== leaderName);

  const leaderPctText = formatRangePct(leaderPct);
  const shareText = formatAuctionShare(sh);
  const thresholdText = formatAuctionShare(auctionShareThresholdOf(leaderIsDragonOne));
  const topicText = leaderTopic || '—';
  const whyText = (reason === 'suspend')
    ? '今日【停牌】'
    : ('今日竞价占比 ' + shareText + ' ＜ ' + (leaderIsDragonOne ? '龙头门槛' : '门槛') + ' ' + thresholdText);
  const sibLabel = sib ? getDragonLabel(Number(sib.rank)) : '';

  const picksText = (function() {
    const arr = [];
    if (sib) {
      arr.push('【' + sibLabel + sib.name + '】（同题材 ' + topicText + ' 的可用龙位' +
        (Number(sib.rank) === 2 ? '' : ' · 龙二不可用已顺延') + '）');
    }
    if (secondOk) {
      arr.push('【' + si.name + '】（市场总龙二：昨日十日涨幅第二 ' + formatRangePct(_num(si.pct)) +
        '，' + (String(si.topic || '').trim() || '—') + ' 的龙一）');
    }
    return arr;
  })();

  // ── ★★ 买点侧唯一那只【市场龙二】（第八轮）───────────────────────────────────────────
  //   ⛔ 它是【当日】口径（用户例子 = 九阳股份 当日 86%），与上面的 secondInfo（昨日口径）不同源。
  const bs = ebbCtx.buySecond;
  const bsOn = !!bs;
  const bsPct = bs ? _num(bs.pct) : null;
  const bsLabel = bs ? getDragonLabel(Number(bs.rank)) : '';
  const bsTopic = bs ? String(bs.topic || '').trim() : '';
  const bsTrouble = !bs ? '（当日十日涨幅还没加载出来 ⇒ 今天算不出市场龙二，买点侧暂不给出这一只）'
    : (bs.suspended ? '⚠️ 但它今日【停牌】，买不进。'
      : (bs.isYizi ? '⚠️ 但它今日【竞价一字涨停】，竞价买不进（要不要打板由你自己定）。' : ''));
  // 「首日」这一判定的依据来自哪里 —— 如实写进说明（§10 判定可追溯；⛔ 不静默）
  const firstDayNote = (prev.source === 'table')
    ? ('（昨日状态取自落库判定：' + prev.detail + '）')
    : (prev.source === 'inferred'
      ? ('（昨日落库判定缺失 ⇒ 按行情行推断：' + prev.detail + '）')
      : ('（昨日状态两处都取不到 ⇒ 本次按【首日】处理，宁可多提醒一次）'));

  return {
    // ── 判据 / 事实 ──
    reason: reason,                                  // 'suspend' | 'share'
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderPct: leaderPct,
    leaderPctText: leaderPctText,
    leaderSuspended: !!ebbCtx.leaderSuspended,
    leaderShare: sh,
    leaderShareText: shareText,
    leaderThresholdText: thresholdText,
    leaderIsDragonOne: leaderIsDragonOne,
    whyText: whyText,
    // ★ [EBB-R8] 首日判定的来源与依据（'table' 落库判定 / 'inferred' 昨日行情行推断 / 'unknown' 取不到）
    firstDay: true,
    firstDaySource: prev.source,
    firstDayPrevLeader: prev.prevLeaderName,
    // ── 允许【看分笔卖】的两只（空串 = 该只今天不成立）──
    siblingName: sib ? String(sib.name) : '',
    siblingRank: sib ? Number(sib.rank) : null,
    siblingLabel: sibLabel,
    secondName: secondOk ? String(si.name) : '',
    secondTopic: secondOk ? String(si.topic || '') : '',
    secondPct: secondOk ? _num(si.pct) : null,
    secondPctText: secondOk ? formatRangePct(_num(si.pct)) : '',
    // ── ★ 买点侧唯一那只【市场龙二】（第八轮 · 当日十日涨幅排名第二）──
    buySecondOn: bsOn,
    buySecondName: bs ? String(bs.name) : '',
    buySecondTopic: bsTopic,
    buySecondPct: bsPct,
    buySecondPctText: bs ? formatRangePct(bsPct) : '',
    buySecondRank: bs ? Number(bs.rank) : null,
    buySecondLabel: bsLabel,
    // 股票代码（分笔抓取 + 停牌判定的目标；§6 只透传采集层给的值，⛔ 不在这里反查）
    buySecondCode: bs && bs.code ? String(bs.code) : '',
    buySecondTrouble: bsTrouble,
    // 标题上直接列出那两只是谁（没有则如实说「一只都没有」）
    picksText: picksText.length > 0 ? picksText.join('、') : '（本日无符合条件的票）',
    // ── 文案（§21：模板零计算）──
    headline: '⚠️ 退潮首日 · 卖点收紧',
    detail: '市场总龙【' + leaderName + '】（' + topicText + '，昨日十日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 判定为【题材退潮首日】。' + firstDayNote + '卖点侧：' +
      (picksText.length > 0
        ? ('只有 ' + picksText.join('、') + ' 可以【' + EBB_PICK_TAG + '】（等开盘看分笔，不看占比）；')
        : '今天没有符合条件的【同题材可用龙位】【市场总龙二】；') +
      '其余股票一律【' + SELL_OUT_TAG + '】（含原本标【' + HOLD_TAG + '】的）—— 开盘就走，降低风险。',
    buyHeadline: bsOn
      ? ('⚠️ 退潮首日 · 买点只有一只：' + EBB_SECOND_BUY_TAG)
      : '⚠️ 退潮首日 · 建议空仓 · 不开仓',
    buyDetail: '市场总龙【' + leaderName + '】（' + topicText + '，昨日十日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 题材退潮首日，风险高。' + firstDayNote +
      (bsOn
        ? ('买点侧今天【只有一只】：【' + bsLabel + bs.name + '】（' + (bsTopic || '—') +
           '，当日十日涨幅 ' + formatRangePct(bsPct) + '）= 全列表十日涨幅排名第二的【市场龙二】' +
           '（总龙自己正是被判定退潮的那一只，今天不买）。' + bsTrouble +
           ' 下方其余入选票一律【' + EBB_NO_BUY_TAG + '】（整段灰化），只有卖出、没有买点。')
        : ('当天【算不出市场龙二】' + bsTrouble + '下方选股【整体变灰】仅为参考，建议今天不开仓（空仓）。'))
  };
}

/**
 * 【昨日同一只总龙的坏状态】—— 「首日」判据的取数收口（§6：判定与取数同处一处，只有这一份）。
 *
 * 用户口径（2026-10-14）：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，
 *   因为现在的逻辑是通过判断没有竞价量等判断出来的，是缓存吧？你要完善这点」
 * ⇒ 优先用【落库的判定】（tvrb_ebb_days 表里昨日那一行），行情行推断只作退路。
 *
 * @param {object} ebbCtx decision-collect#_ebbCtxOf 的返回（含 prevLeader 事实）
 * @param {object|null} prevEbbDay tvrb_ebb_days 里【上一交易日】那一行（{leader_stock, ebb}）
 * @param {string} leaderName 今日总龙名
 * @returns {{source:'table'|'inferred'|'unknown', bad:boolean, prevLeaderName:string, detail:string}}
 *          bad=true ⇒ 昨日同一只总龙已在坏状态 ⇒ 今天不是首日
 */
function _prevLeaderDayState(ebbCtx, prevEbbDay, leaderName) {
  const rowName = prevEbbDay ? String(prevEbbDay.leader_stock || '').trim() : '';
  if (prevEbbDay && rowName) {
    // ① 落库判定：只认【同一只总龙】（昨天是别的票当总龙 ⇒ 对今天这只而言本来就是首日）
    if (rowName === leaderName) {
      return {
        source: 'table', bad: !!prevEbbDay.ebb, prevLeaderName: rowName,
        detail: '昨日（同一只总龙 ' + rowName + '）落库判定 = ' + (prevEbbDay.ebb ? '退潮' : '未退潮')
      };
    }
    return {
      source: 'table', bad: false, prevLeaderName: rowName,
      detail: '昨日总龙是【' + rowName + '】，与今日【' + leaderName + '】不是同一只 ⇒ 今日为首日'
    };
  }
  // ② 退路：用【库里昨日那一行】的竞价量 / 占比推断（量 0 ⇒ 无竞价 ⇒ 停牌语义）
  const pl = ebbCtx && ebbCtx.prevLeader;
  if (pl) {
    return {
      source: 'inferred', bad: !!pl.bad, prevLeaderName: leaderName,
      detail: '昨日落库判定缺失 ⇒ 用昨日行情行推断：竞价量 ' +
        (pl.volume === null ? '—' : pl.volume) + '、占比 ' + formatAuctionShare(_num(pl.share)) +
        ' ⇒ ' + (pl.bad ? '已在坏状态' : '状态正常')
    };
  }
  // ③ 两处都取不到 ⇒ 无法确认 ⇒ 按首日处理（用户拍板：取不到就按首日处理，继续提醒）
  return {
    source: 'unknown', bad: false, prevLeaderName: '',
    detail: '昨日状态两处都取不到 ⇒ 按【首日】处理（宁可多提醒一次）'
  };
}

/**
 * 【落库行】—— tvrb_ebb_days 一天一行的那份数据（§6：形状收口在这里，⛔ 写表的那一端不自己拼）。
 *
 * 为什么要落库（用户原话 2026-10-14）：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，
 *   因为现在的逻辑是通过判断没有竞价量等判断出来的，是缓存吧？你要完善这点」
 * ⇒ 把每天算出的退潮【判定】存下来，次日判「是不是首日」直接读那一行（见 _prevLeaderDayState ①）。
 *
 * ⚠️ 它与 detectEbbDay 的返回值【不是一回事】：
 *   · detectEbbDay 返回的是【今天要不要按退潮处理】—— 带「首日闸门」，昨天已退潮 ⇒ 今天返回 null；
 *   · 本函数返回的是【今天这只总龙到底算不算处在坏状态】—— ❗不带首日闸门（那正是次日判首日的输入）。
 *   ⇒ 所以 `ebb = suspended || shareFail` 用的是判据 ①/② 的【原始结论】，
 *     与 detectEbbDay 里 `reason` 的算法逐字同源（§6 同一把尺子，⛔ 别写成两个条件）。
 *
 * ⚠️ 调用方必须在【当前展示日 = 今天】时才写（suspend 判定只对今天可信，见 suspend.js 红线）；
 *   历史日写进去会把「今天没停牌」当成「那天没停牌」⇒ 次日读回来直接判错首日。
 *
 * @param {object|null} ebb detectEbbDay 的返回（可为 null = 今天不退潮 / 不是首日）
 * @param {object|null} ebbCtx 采集层的【事实】（必须有 ready + leader）
 * @param {string} date 判定日 YYYY-MM-DD
 * @returns {object|null} 业务形状的行（键见 data/ebb-days.js 的 _normalize）；事实未就绪 ⇒ null（§10 不猜）
 */
export function buildEbbDayRecord(ebb, ebbCtx, date) {
  const d = String(date || '').trim();
  if (!d) return null;
  // §10：事实未就绪（昨涨幅未读回 / 一只票都排不出）⇒ ⛔ 绝不落一行「猜的」判定，明天会拿它判首日
  if (!ebbCtx || !ebbCtx.ready || !ebbCtx.leader) return null;
  const leader = ebbCtx.leader;
  const name = String(leader.name || '').trim();
  if (!name) return null;

  const isDragonOne = (Number(leader.rank) === 1);
  const sh = _num(ebbCtx.leaderShare);
  const suspended = !!ebbCtx.leaderSuspended;
  // 与 detectEbbDay 的判据 ② 逐字同源：缺数据（sh === null）⇒ 不判不达标（§10：未知 ≠ 不达标）
  const shareFail = (sh !== null && !passesAuctionShare(sh, isDragonOne));

  return {
    date: d,
    leaderStock: name,
    leaderTopic: String(leader.topic || ''),
    leaderPct: _num(leader.pct),
    leaderRank: _num(leader.rank),
    suspended: suspended,
    share: sh,
    shareFail: shareFail,
    // ★ 原始结论（不带首日闸门）—— 次日判「昨天这只票是不是已经在坏状态」就读它
    ebb: !!(suspended || shareFail),
    // ⚠️ 买点侧那只只在【今天确实是退潮首日】时才有意义（ebb === null ⇒ 不放）
    buySecond: (ebb && ebb.buySecondName) ? String(ebb.buySecondName) : '',
    buySecondPct: (ebb && _num(ebb.buySecondPct) !== null) ? _num(ebb.buySecondPct) : null,
    source: 'tvrb-board'
  };
}

/** 退潮首日【允许看分笔卖】的股票名集合（§6：唯一的取名实现，判定与改写共用） */
function _ebbEligibleNames(ebb) {
  const set = new Set();
  if (!ebb) return set;
  if (ebb.siblingName) set.add(ebb.siblingName);
  if (ebb.secondName) set.add(ebb.secondName);
  return set;
}

/**
 * 【退潮首日 · 卖点改写】（覆盖式后处理 —— ⛔ 绝不去改 buildSellPlan 内部）。
 *
 * 为什么是「后处理」而不是「改 buildSellPlan」：那个函数是【决策看板与本看板共用的同一份实现】
 * （§6 红线），在它里面加本看板专有的分支，等于给决策看板也加了一条它不该有的规则。
 * 于是：先让它按原口径算完，再由本函数【覆盖】本看板需要改的那两枚字段
 * （`sellActionTag` / `sellActionTone` —— 它们在本看板卖点行的标签优先级里最高，见 TvrbSellBlock.vue）。
 *
 * ⛔ 保留一切【客观数据】：十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 退潮只改「今天怎么卖」，不篡改行情事实。
 * ⛔ 停牌票【照旧改写】：本文件是纯函数、读不到停牌事实（判定只有 suspend.js 一处，§6），
 *   而「它卖不掉」这件事由【停牌】小标 + 第十九轮的去色 CSS 表达，不在这里再判一遍。
 *
 * @param {Array} sell buildSellPlan 的返回（题材分组数组，每组含 items）
 * @param {object|null} ebb detectEbbDay 的返回
 */
function _applyEbbSellRules(sell, ebb) {
  if (!ebb) return;
  const elig = _ebbEligibleNames(ebb);
  const topicText = ebb.leaderTopic || '—';
  const lead = '【退潮首日】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，昨日十日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText + ' ⇒ 题材退潮：';

  (sell || []).forEach(function(g) {
    (g.items || []).forEach(function(it) {
      if (!it || !it.name) return;
      const name = String(it.name);
      // ★ [EBB-R8 2026-10-14] 放行【今天唯一那只买点】：
      //   它如果同时在卖点侧（昨天买过），按本文件退潮口径本来会被改成【竞价卖】——
      //   那就与买点侧的【总龙二买】正面矛盾（同一天不可能既「唯一要买」又「竞价清仓」）。
      //   ⇒ 它保持 buildSellPlan 自己的结论（今天又进买点 ⇒ 持有）：留着，并在开盘买点加仓。
      if (ebb.buySecondName && name === String(ebb.buySecondName)) return;
      if (elig.has(name)) {
        const isSib = (name === ebb.siblingName);
        it.sellActionTag = EBB_PICK_TAG;      // ★ 覆盖式：优先级最高的那一枚
        it.sellActionTone = EBB_PICK_TONE;
        it.holdTag = '';                      // 与「看分笔卖」互斥（原口径的持有 / 先卖后买让路）
        it.buyActionTag = '';
        it.buyActionTone = '';
        // 卖点节奏提示（深低开盯盘 / 立刻出…）以【占比】为前提，与「看分笔卖」是两套口径 ⇒ 撤掉
        it.sellHint = null;
        it.actionNote = lead +
          (isSib
            ? ('本股是【' + (ebb.siblingLabel || '') + '同题材可用龙位】（' + topicText +
               ' 里龙位最靠前、且非竞价一字 / 非停牌的票）')
            : ('本股是【市场总龙二】（昨日十日涨幅第二 ' + ebb.secondPctText + '，' +
               (ebb.secondTopic || '—') + ' 的龙一）')) +
          ' ⇒ 允许【' + EBB_PICK_TAG + '】：9:25 不竞价卖，等 9:30~9:31 点开【分笔成交】看结论 —— ' +
          '提示【冲高卖】就等冲高再清、提示【立刻卖】就直接止损。' +
          '（本档【不看本股自己的占比】，也不看它原本是【' + HOLD_TAG + '】还是【' + SELL_OUT_TAG +
          '】—— 退潮首日只按「是不是那两只有资格等开盘卖的票」二分。）';
      } else {
        it.sellActionTag = SELL_OUT_TAG;      // ★ 其余一律竞价卖（用户拍板：连【持有】也一起改）
        it.sellActionTone = SELL_ACTION_TONE_OUT;
        it.holdTag = '';
        it.buyActionTag = '';
        it.buyActionTone = '';
        it.sellHint = null;
        it.actionNote = lead +
          ('本股不是【同题材可用龙位】、也不是【市场总龙二】 ⇒ 一律【' + SELL_OUT_TAG +
           '】：开盘就走，降低风险。' +
           '（退潮首日【不看占比】、也不因它原本标【' + HOLD_TAG + '】而留下。）');
      }
    });
  });
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 【退潮首日 · 买点侧唯一那只「市场龙二」】构造（第八轮 · 2026-10-14 用户口径）。
 *
 * 用户口径：「买点只有一个，那就是市场的龙二（不是同题材的），是整个早盘竞价看板的股票列表中的
 *   十日涨幅排名第二的龙二，就像今天的九阳股份（市场排名十日涨幅 86%，总列表排名第二），
 *   把它入选到买点侧」（口径追问时拍板：标签用【单独一枚「总龙二买」】）。
 *
 * 产出 = 一个【常规买点块】（形状与 _buildBlock 完全一致）里只放一只票 ——
 *   ⇒ 它可以直接喂给 TvrbBuyBlock 渲染，也可以进 `buy.ebbSecond` 槽位让四个装饰器统一挂客观数据
 *   （量比趋势 / 名次变化 / 封单额 / 停牌标记，见 decision-collect#_buyBlocksOf）。
 *
 * ⚠️ 顺序（决定了本函数里那两次「覆盖」的必要性）：
 *   ① 先 `finishBuyBlock` —— 它不是用来给动作标签的，而是为了把【客观数据 + 原始买点信号】
 *      （竞价涨幅徽标 / 占比 + 门槛 / 量比方向 / 仓位 / 持有 / 逐行说明）一次算齐；
 *   ② 再【覆盖】动作标签为【总龙二买】（用户明确要专属标签）并把原始信号写进行内说明
 *      —— 覆盖而不改写逻辑：占比达标与否这条结论一枚不丢，只是换了标签的外观。
 *   ⛔ 绝不改 finishBuyBlock 内部（那是决策看板与本看板共用的实现，§6 红线）。
 *
 * ⚠️ 为什么 `block.block` 用【合成的题材头】而不是它在早盘竞价里的真实题材块：
 *   真实题材块的 `rank` 是「题材排名圆点」，挂在这一行上会被读成本行的名次；
 *   而且本行的第一行标题要写清楚它是什么（市场龙二 / 全列表排名第二），不是某个题材。
 *   ⚠️ 但 `members` 必须放【真实成员行】—— `finishBuyBlock` 的徽标反查（_decorateAucBadge）
 *     要按名字从 members 里取 aucPct / aucShare / volRatioDelta / code，放空数组就会静默少几个徽标。
 *
 * @param {object} ebb detectEbbDay 的返回（必须 buySecondOn=true）
 * @param {Array} list rankDecisionTopics 的返回 —— 用来找这只票的【真实成员行】（含代码 / 占比 / 量比）
 * @param {object} fOpts finishBuyBlock 的入参（与正常题材块同一份，保证标记口径一致）
 * @returns {object|null} 常规买点块；拿不到成员行 / 没有龙二 ⇒ null（§10 不猜）
 */
function _buildEbbSecondBlock(ebb, list, fOpts) {
  if (!ebb || !ebb.buySecondOn || !ebb.buySecondName) return null;
  const name = String(ebb.buySecondName);
  const topic = String(ebb.buySecondTopic || '').trim();

  // 真实成员行：只在【该票所属题材块】里找（同名的其它题材成员不存在，找不到就返回 null 不硬造）
  let member = null;
  (list || []).forEach(function(b) {
    if (member) return;
    if (String(b && b.topic || '').trim() !== topic) return;
    (b.members || []).forEach(function(m) {
      if (!member && m && String(m.name || '').trim() === name) member = m;
    });
  });
  if (!member) return null;

  const head = topic ? ('市场龙二 · ' + topic) : '市场龙二';
  const pick = {
    seq: 1,
    name: name,
    dragonLabel: ebb.buySecondLabel,
    dragonRank: ebb.buySecondRank,
    pct: ebb.buySecondPct,
    // 代码优先取采集层给的（与 members 同一个值，§6 只搬运）
    code: ebb.buySecondCode || String(member.code || '').trim(),
    pctText: ebb.buySecondPctText,
    // ⚠️ 预置：_decorateAucBadge 之前 _markHold 要读它（与 _buildBlock 同一做法）
    aucShare: _num(member.aucShare),
    position: ''
  };

  const notes = [
    '⚠️ 本行【不是】题材选股的结果，而是【退潮首日的唯一买点】：市场总龙【' + ebb.leaderName + '】' +
      ebb.whyText + ' ⇒ 买点侧只留【市场龙二】（总龙自己今天不买）。',
    '【市场龙二】= 当日十日涨幅在【早盘竞价全列表】里排名第二、且【有龙位】的那一只' +
      '（本日 = ' + name + '，当日十日涨幅 ' + ebb.buySecondPctText +
      (topic ? '，' + topic : '') + '）。' +
      '⚠️ 全列表第一是【市场总龙】自己（' + ebb.leaderName + '）——它今天正是被判定退潮的那一只，不买。',
    '为什么只用【当日】十日涨幅排：这是屏幕上「十日涨幅」那一列的口径（与市场总龙的「昨日」口径不同）' +
      '——总龙停牌时当日读不到涨幅，只能用昨日；而龙二只看今天谁最强，所以看今天那一列。',
    '⚠️ 与卖点侧的【市场总龙二】不是同一只：那边用的是【昨日】十日涨幅第二' +
      '（昨日口径，因为要判「它昨天就是强龙」），这边用的是【当日】十日涨幅第二（今天最强的那只）。'
  ];
  if (ebb.buySecondTrouble) notes.push(ebb.buySecondTrouble);

  const block = {
    // ── ① 决策看板形状的字段（finishBuyBlock / 装饰器要读的）──
    block: {
      topic: head,
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      // ★ 真实成员行 —— 徽标 / 占比 / 量比方向 / 代码都从它反查（见函数头注释）
      members: [member]
    },
    rankWord: '',
    pickRank: null,
    reason: '退潮首日【唯一买点】：【市场龙二】= 当日十日涨幅全列表排名第二（' +
      ebb.buySecondPctText + '，' + (topic || '—') + '）—— 总龙【' + ebb.leaderName + '】' +
      ebb.whyText + ' ⇒ 今天只买这一只（其余入选票一律【' + EBB_NO_BUY_TAG + '】）',
    mode: 'ebb',
    ruleNo: EBB_SECOND_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: [pick],
    notes: notes,

    // ── ② 本看板自己的平铺字段（组件直接读）──
    topic: head,
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'ebb',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    // ★ 供视图判断「这是退潮首日那一行」（避免模板靠 tier 字符串比较，§21）
    isEbbSecond: true
  };

  // ① 让它按决策看板的同一份实现把【客观数据 + 原始买点信号】算齐
  finishBuyBlock(block, fOpts);
  // ② 再覆盖动作标签为专属的【总龙二买】（用户拍板），并原始信号原文留进行内说明
  const lead = '【退潮首日 · 唯一买点】市场总龙【' + ebb.leaderName + '】' + ebb.whyText +
    ' ⇒ 今天买点侧只有这一只（【' + EBB_SECOND_BUY_TAG + '】）：';
  (block.picks || []).forEach(function(p) {
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = EBB_SECOND_BUY_TAG;      // ★ 覆盖式：本行唯一那枚标签
    p.buyActionTone = EBB_SECOND_BUY_TONE;
    p.holdTag = '';                           // 与「今天要买」互斥（原本的持有 / 先卖后买让路）
    p.position = '';
    p.actionNote = lead + '它是【市场龙二】= 当日十日涨幅全列表排名第二（' + ebb.buySecondPctText +
      '，' + (topic || '—') + '，' + (ebb.buySecondLabel || '') + '）。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      ' 退潮首日不按常规买点罗列：只留这一只，其余入选票一律【' + EBB_NO_BUY_TAG + '】（灰色）。';
  });
  return block;
}

/**
 * 【退潮首日 · 买点改写】（覆盖式后处理 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径（2026-10-13 第六轮）：「退潮当天，只有卖没有买」「新华文轩买点侧还标有 持有 竞价买，
 *   应该标的是，『退潮不买』」。
 *
 * 为什么是「后处理」：finishBuyBlock 是【决策看板与本看板共用的同一份实现】（§6 红线），
 *   在它里面加本看板专有的分支，等于给决策看板也加了一条它不该有的规则。
 *   于是：先让它按原口径算完，再由本函数【覆盖】买点行上那几枚「买」的字段。
 *
 * 覆盖的三处（模板 TvrbBuyBlock.vue 里买点行上所有「买」的出口，一个不漏）：
 *   · `p.buyActionTag` / `p.buyActionTone` —— 竞价买 / 尾盘买 / 先卖后买 / 下杀买 / 补涨 / 龙一字持有
 *     ⇒ 一律换成【退潮不买】；
 *   · `p.holdTag` —— 行尾【持有】（今天又进买点）
 *   · `p.position` —— 仓位槽（本看板只有「昨天真买过 ⇒ 持有」会落在这里）
 * ⛔ 只动这三处；题材级的【昨有买入】/【N 次入选】是【历史统计标记】而不是「今天的买点动作」，
 *   保留不动（用户「其它不变」）。
 * ⛔ 一切【客观数据】照旧：十日涨幅 / 竞价涨幅 / 竞价量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 退潮只改「今天买不买」，不篡改行情事实。
 * ⛔ 停牌票【照旧改写】：停牌事实由【停牌】小标 + 去色 CSS 表达（判定只有 suspend.js 一处，§6），
 *   本纯函数不重复判一遍。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks）
 * @param {object|null} ebb detectEbbDay 的返回
 */
function _applyEbbBuyRules(blocks, ebb) {
  if (!ebb) return;
  const topicText = ebb.leaderTopic || '—';
  const lead = '【退潮首日】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，昨日十日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText +
    ' ⇒ 题材退潮首日【今天不买】：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';                      // 仓位槽（本看板此处只会是【持有】）
      p.holdTag = '';                       // 行尾【持有】
      p.buyActionTag = EBB_NO_BUY_TAG;      // ★ 覆盖式：买点行上唯一那枚「买」的标签
      p.buyActionTone = EBB_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 退潮首日只有卖点、没有买点，原本的【' + HOLD_TAG + '】/ 竞价买 / ' +
        '尾盘买 / 先卖后买 等买点信号一律作废。' +
        '（等题材重新走强 —— 总龙复牌 / 竞价占比回升 / 平均量比回来 —— 再看买点。）';
    });
  });
}

/**
 * 【题材股票数量 → 本看板档位】（§6 唯一实现）。
 *
 * 用户口径（2026-10-11）：
 *   < 4 只     → 'none'：该题材【不入选】（排除，顺延到下一题材）
 *   4 ~ 8 只   → 'mid' ：入选 1 只
 *   > 8 只     → 'big' ：入选 2 只
 *
 * §10：count 缺失 / 非法 → 按 0 处理 ⇒ 落到 'none'（不入选），
 *      ⛔ 绝不因为「数字没读到」就假装它是一只大题材去铺票。
 *
 * @param {number|string|null} count 题材在早盘竞价里的股票只数（block.count）
 * @returns {{tier:'none'|'mid'|'big', count:number, pickCount:number, rangeText:string}}
 */
export function resolveTvrbTier(count) {
  const n = _num(count);
  const c = (n === null || n < 0) ? 0 : Math.floor(n);
  if (c < TVRB_MIN_COUNT) {
    return { tier: 'none', count: c, pickCount: 0, rangeText: '不足 ' + TVRB_MIN_COUNT + ' 只' };
  }
  if (c <= TVRB_MID_MAX) {
    return {
      tier: 'mid', count: c, pickCount: TVRB_PICK_MID,
      rangeText: TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只'
    };
  }
  return {
    tier: 'big', count: c, pickCount: TVRB_PICK_BIG,
    rangeText: '> ' + TVRB_MID_MAX + ' 只'
  };
}

/**
 * 题材的【平均竞价量比】—— 与 rankDecisionTopics 用来排序的口径【完全一致】（§6 单一真相）。
 *
 * 口径 = 该题材组内【所有拿到量比的行】的量比之和 ÷ 拿到量比的行数。
 *   · 含灰行（不可计数的继承票）—— 与早盘竞价统计条同一个分母；
 *   · 一行都拿不到 ⇒ null（§10：绝不返回 0，那会被读成「量比极小」）。
 *
 * ⛔ 排序本身【不在这里做】：题材顺序由 rankDecisionTopics（= sortByTopicGroups）给出，
 *   本函数只负责把那个顺序背后的数值【显示出来】，两处若各写一份必然分叉。
 *
 * @param {object} block rankDecisionTopics 返回的题材块（members 里有 aucVolRatio）
 * @returns {number|null}
 */
export function avgVolRatioOf(block) {
  const ms = (block && block.members) || [];
  let sum = 0;
  let n = 0;
  ms.forEach(function(m) {
    const v = _num(m && m.aucVolRatio);
    if (v === null) return;
    sum += v;
    n++;
  });
  return n > 0 ? (sum / n) : null;
}

/** 平均竞价量比 → 展示文案（缺值 → '—'，§10 不补 0.00） */
export function formatAvgVolRatio(v) {
  const n = _num(v);
  return n === null ? '—' : n.toFixed(2);
}

/** 未触发时的稳定返回值（同一引用 ⇒ 不白白触发下游重算 / 重渲染，§19） */
export const TVRB_CASH_ALERT_NONE = Object.freeze({
  show: false,
  topic: '',
  rank: null,
  avgVolRatio: null,
  avgVolRatioText: '—',
  threshold: TVRB_CASH_ALERT_AVG_VR,
  headline: '',
  detail: ''
});

/**
 * 【空仓提醒】判据 —— 见 TVRB_CASH_ALERT_AVG_VR 的长注释（用户第四轮口径）。
 *
 * 入参必须是【入选题材里排名第一的那个块】（= blocks[0]，即 buy.heavy），
 * ⛔ 不是「全部题材排名第一」——量比最高的题材常常因为数量不足 4 只已经被排除了
 *    （用户举的例子：电力新能源 45.92 / 3 只被排除 ⇒ 看 AI应用 21.51 / 14 只）。
 *
 * 三种「不提示」都必须显式处理，⛔ 绝不退化成「提示」或「不提示」的默认值：
 *   ① 没有入选题材（leadBlock 为空）⇒ 不提示（那是「没有合格题材」，看板另有说明）；
 *   ② 该题材平均量比读不出来（null）⇒ 不提示（§10：未知 ≠ 低）；
 *   ③ 平均量比 ≥ 门槛 ⇒ 不提示。
 *
 * @param {object|null} leadBlock 入选题材里排名第一的块（buildTopicVolRatioPlan 里的 blocks[0]）
 * @param {object|null} [ebb] detectEbbDay 的返回 —— ★ [EBB 2026-10-13 第五轮] 退潮首日【优先】：
 *        退潮日直接给退潮口径的空仓标语（用户口径「买点侧是提示空仓的……把买点侧的文字或者 UI
 *        全部变成灰色，这样空仓效果更加强烈些」），⛔ 不再去算平均量比那条（退潮是更强、更具体的原因）。
 * @returns {{show:boolean, topic:string, rank:number|null, avgVolRatio:number|null,
 *            avgVolRatioText:string, threshold:number, headline:string, detail:string}}
 */
export function buildCashAlert(leadBlock, ebb) {
  // ★ [EBB 2026-10-13] 退潮首日 ⇒ 空仓（理由比「量比低」更硬：最强的那只都停了 / 占比不达标）
  if (ebb) {
    return {
      show: true,
      topic: ebb.leaderTopic || '',
      rank: null,
      avgVolRatio: null,
      avgVolRatioText: '—',
      threshold: TVRB_CASH_ALERT_AVG_VR,
      headline: ebb.buyHeadline,
      detail: ebb.buyDetail
    };
  }
  if (!leadBlock || !leadBlock.block) return TVRB_CASH_ALERT_NONE;
  const avg = avgVolRatioOf(leadBlock.block);
  if (avg === null) return TVRB_CASH_ALERT_NONE;           // §10：缺数据 ⇒ 不提示
  if (!(avg < TVRB_CASH_ALERT_AVG_VR)) return TVRB_CASH_ALERT_NONE;

  const topic = String(leadBlock.topic || '');
  const avgText = formatAvgVolRatio(avg);
  return {
    show: true,
    topic: topic,
    rank: leadBlock.rank === undefined ? null : leadBlock.rank,
    avgVolRatio: avg,
    avgVolRatioText: avgText,
    threshold: TVRB_CASH_ALERT_AVG_VR,
    // 大字标语（§21：文案在 Logic 层拼好，模板零计算）
    headline: '⚠️ 今日建议空仓 · 不开仓',
    // 小字说明：把「为什么」「股票照常列出」讲清楚 —— 用户原话「看到这些文字，我就不开仓了」
    detail: '能入选的排名第一题材【' + topic + '】平均竞价量比 ' + avgText + ' ＜ ' +
      TVRB_CASH_ALERT_AVG_VR + ' ⇒ 题材退潮（最强题材的量比都这么低，当天什么票都容易走弱）。' +
      '⚠️ 下方股票仍按原规则【照常列出】（供参考、不删不改），但看到本提示建议今天不开仓。'
  };
}

/**
 * 题材块 → 本看板的【可买候选序列】（按【龙位升序】：龙一 → 龙二 → …）。
 *
 * 成分（§6：只做「成员 × 龙位名册」的联结与排序，⛔ 不自己判板块）：
 *   · 龙位取自 dragonMap（= rankDragons 的返回）。⭐【只发主板龙标签】的闸门就在
 *     computeDragonRankMap 里：创业板 300/301、科创板 688/689 的 rank 恒为 null ⇒
 *     这里 `rank === null` 直接剔除，与早盘竞价「没有龙标签」的判定完全同源
 *     （⛔ 绝不在这里另写 getBoardKind / startsWith('30') 之类的板块判断 —— 那就是第二份规则）。
 *   · ⛔ 竞价一字的成员【保留】在序列里（由调用方跳过并顺延）——
 *     用户口径是「龙一竞价涨停的，看龙二」，所以它必须占在序列里才能被识别为「被跳过的那一档」。
 *   · 排序：龙位升序；同龙位（理论上不会出现）按股票名，保证结果可复现、不随机。
 *
 * ⚠️ 同时带上 `aucShare`（竞价占比）：它是【选票无关】的展示 / 判定输入 ——
 *    decision-rules#_markHold（跑在 _decorateAucBadge 之前）要靠它判【先卖后买】，
 *    所以必须在进 finishBuyBlock 之前就挂在 pick 上（与决策看板 _buyCandidates 同一做法，§6）。
 *
 * @param {object} block 题材块（含 members；members 里有 name / isYizi / pct / aucPct / aucVolRatio / aucShare）
 * @param {Map} dragonMap 龙位名册（rankDragons 的返回）
 * @returns {Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                  aucVolRatio:number|null, aucShare:number|null, rank:number}>}
 */
function _dragonCandidates(block, dragonMap) {
  const dm = dragonMap || new Map();
  const out = [];
  ((block && block.members) || []).forEach(function(m) {
    if (!m || !m.name) return;
    const d = dm.get(m.name);
    const rank = (d && d.rank) ? d.rank : null;
    if (rank === null) return;   // 无龙位（创业板 / 科创板）⇒ 不参与本看板选股（与决策看板同口径）
    out.push({
      name: m.name,
      isYizi: !!m.isYizi,
      pct: _num(m.pct),
      aucPct: _num(m.aucPct),
      aucVolRatio: _num(m.aucVolRatio),
      aucShare: _num(m.aucShare),
      // 股票代码：原样透传（§6 不另查一份）。用途 = 分笔抓取的目标代码
      //   （logic/tick/tick-minute.js#decorateTickRow 优先读行上的 code）。
      code: String(m.code || '').trim(),
      rank: rank
    });
  });
  out.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

/**
 * 构造一个入选题材的块 —— ★形状与 decision-rules#_buildTopicBuyBlock【完全一致】★。
 *
 * ⛔ 为什么必须同形状（这是本文件最容易踩的坑）：块要交给 decision-rules#finishBuyBlock
 *    做标签收口，而收口里的每一步都在读固定字段（block.block.topic / block.block.members /
 *    picks[].name / picks[].dragonRank / picks[].aucShare …）。少一个字段就是【静默】少一枚标签
 *    （不报错、不显示，最难查的那种）。
 *
 * 选股（用户口径「按龙一龙二……，龙一竞价涨停的看龙二……」）：
 *   ① 候选序列 = _dragonCandidates(block, dragonMap) —— 已剔除无龙位票（创业板 / 科创板）、
 *      已按【龙位升序】排好（龙一 → 龙二 → …）；
 *   ② 从高到低依次取【非竞价涨停】的票，直到取满本档只数（1 或 2 只）；
 *   ③ 竞价涨停（竞价一字）的龙位 ⇒ 买不进 ⇒【跳过并顺延到下一龙位】（⛔ 但与决策看板的
 *      「占名次不递补」不同：本看板用户明确要求【往下顺延】）。
 *
 * ⛔ 本看板【没有仓位口径】：picks 的 position 一律留空（用户第二轮点名的标签里没有重仓 / 轻仓，
 *    而本看板按龙位取票、本来就没有「前 N 只重仓」这回事 —— ⛔ 不凭空造一条仓位规则）。
 *    昨天真买过的票仍会被 finishBuyBlock 内部的 _markPrevBought 改写成【持有】（那是决策看板的口径）。
 *
 * @param {object} block   题材块（含 rank / topic / count / yiziCount / members）
 * @param {Map} dragonMap  龙位名册（rankDragons 的返回）
 * @param {object} tier    resolveTvrbTier 的返回
 * @returns {object} 决策看板形状的买点块（+ 本看板自己的几个平铺别名，见返回值末尾）
 */
function _buildBlock(block, dragonMap, tier) {
  const avg = avgVolRatioOf(block);
  const cands = _dragonCandidates(block, dragonMap);
  const picked = [];
  const skipped = [];
  for (let i = 0; i < cands.length && picked.length < tier.pickCount; i++) {
    const c = cands[i];
    if (c.isYizi) { skipped.push(c); continue; }   // 竞价涨停 → 买不进 ⇒ 顺延下一龙位
    picked.push(c);
  }

  const picks = picked.map(function(c, i) {
    return {
      seq: i + 1,
      name: c.name,
      dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
      dragonRank: c.rank,
      pct: c.pct,
      // 股票代码（分笔抓取目标用；与决策看板卖点行的 code 同一含义，§6 只透传）
      code: c.code || '',
      // 十日涨幅文案：与决策看板同一份格式化函数（§6），模板零计算（§21）
      pctText: formatRangePct(c.pct),
      // ⚠️ 必须【预置】：decision-rules#_markHold 跑在 _decorateAucBadge 之前，
      //   它要靠 p.aucShare 判「先卖后买档」（与决策看板 _buyCandidates → _toPick 同一口径，§6）。
      aucShare: c.aucShare,
      // ⛔ 见函数头：本看板无仓位口径，留空；昨天买过的会被 _markPrevBought 改写为【持有】
      position: ''
    };
  });

  const skippedNames = skipped.map(function(c) {
    return (c.rank ? getDragonLabel(c.rank) : '') + c.name;
  });

  const reason = '按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
    '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
    ' 只；按【龙一 → 龙二 → …】从高到低依次取其非【竞价涨停】的票';

  const notes = [];
  notes.push('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
    '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
    ' 只；入选股票按龙位从高到低依次取，遇到【竞价涨停（竞价一字）】的龙位则顺延到下一个龙位。');
  if (skippedNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedNames.join('、') +
      ' 竞价涨停（买不进）⇒ 已顺延到下一个龙位（用户口径：龙一涨停看龙二，龙二涨停看龙三……）。');
  }
  if (picks.length < tier.pickCount) {
    notes.push('⚠️ 本题材有龙位、且可买入（非竞价涨停）的票不足 ' + tier.pickCount +
      ' 只 ⇒ 实际取 ' + picks.length + ' 只（⛔ 不从其它题材补位）。');
  }

  return {
    // ── ① 决策看板形状的字段（finishBuyBlock / decorateDecisionRows / 通用装饰器要读的）──
    block: block,
    rankWord: '第 ' + block.rank + ' 名',
    // 圆点里的数字：本看板内按平均竞价量比的排名（数量不足 4 只的题材已剔除、不占名次）
    pickRank: block.rank,
    reason: reason,
    // mode = 档位（'mid' / 'big'）—— 与决策看板的 mode 同字段同含义（'small'/'mid'/'big'）
    mode: tier.tier,
    // 规则编号借决策看板买点段的 ①：本看板的选股口径就是「按题材数量分档、题材内取票」，
    // 说明文字里出现【规则①】时用户能对着决策看板的规则清单读（⛔ 不另立一套编号）。
    ruleNo: RULE_NO.FIRST,
    isCandidate: false,
    candidateTag: '',
    qualified: picks.length > 0,
    notQualifiedText: '',
    picks: picks,
    // 本看板自己的说明（顺延 / 少取）—— finishBuyBlock 会往同一个数组里追加 ③④⑤ 的说明
    notes: notes,

    // ── ② 本看板自己的平铺字段（组件直接读；⛔ 与决策看板字段名不冲突）──
    topic: block.topic,
    rank: block.rank,
    count: block.count,
    yiziCount: block.yiziCount,
    avgVolRatio: avg,
    avgVolRatioText: formatAvgVolRatio(avg),
    tier: tier.tier,
    pickCount: tier.pickCount,
    rangeText: tier.rangeText,
    skippedNames: skippedNames
  };
}

/**
 * 【本看板 · 买点 + 卖点的唯一实现（§6）】。
 *
 * 一次调用产出三块东西：
 *   ① 选股（本看板自己的规则）+ 买点标签（decision-rules#finishBuyBlock 收口）；
 *   ② 卖点计划（decision-rules#buildSellPlan，候选 = 昨日打过「买」标签的股票；
 *      「今天又进买点」用的是【本看板自己的买点名单】，保证本看板内部自洽）；
 *   ③ 说明文案（被排除的题材 / 不足两个题材）。
 *
 * ⛔ 卖点【不重新发明】：判据（占比门槛 / 跟龙 / 10分钟时卖 / 竞价涨停卖 / 持有）全在 buildSellPlan 里
 *    —— 用户原话「买入和卖出基本逻辑一样，只是选股不同」。
 *
 * @param {Array} topics   rankDecisionTopics(entries, MODE_VOL_RATIO) 的返回（已按平均竞价量比降序）
 * @param {Map} dragonMap  rankDragons(topics) 的返回
 * @param {{date?:string, ctx?:object, sellRows?:Array, ebbCtx?:object}} [opts]
 *        date     = 展示日（当前已由组合式调 decorateDecisionRows 统一装饰，这里只留作扩展位）
 *        ctx      = decision-collect#collectDecisionTopics(actionContext) 给的标记上下文
 *                   {prevDragonNames, prevBuyNames, prevBought, prevBoughtTopics, topicStreakPast}；
 *                   ⛔ 缺省 = 全部为 null ⇒ 持有 / 昨有买入 / N 次入选 / 先卖后买 / 补涨
 *                   一枚都不打（§10：未知 ≠ 没有），⛔ 绝不在这里用空集合顶替。
 *        sellRows = decision-collect 给的卖点候选行（缺省 ⇒ 不产卖点段）
 *        ebbCtx   = decision-collect#_ebbCtxOf 采好的【退潮首日事实】（市场总龙 / 今日停牌 / 今日占比 /
 *                   同题材龙位成员 / 市场总龙二）；缺省 / ready=false ⇒ 退潮规则不生效（§10 不猜）
 * @returns {{topics:Array, blocks:Array, buy:object, sell:Array, excludedTopics:Array,
 *            notes:Array, pickCount:number, buyNames:Set<string>, cashAlert:object, ebb:object|null}}
 *   topics        —— 全部参与排名的题材（含被排除的），按排名，供说明 / 复核
 *   blocks        —— 入选的题材块（≤ TVRB_TOPIC_LIMIT 个），每个含 picks
 *   buy           —— 决策看板形状的买点计划（heavy / light / candidates / 三个兜底槽位）
 *                    ⚠️ 形状必须一致：通用装饰器（量比趋势 / 名次变化 / 封单额）按它遍历
 *                    ⚠️ 退潮首日已被 _applyEbbBuyRules 覆盖动作标签 ⇒ 每行只留【退潮不买】
 *   sell          —— buildSellPlan 的返回（题材分组）；退潮首日已被 _applyEbbSellRules 改写动作标签
 *   excludedTopics—— 因数量 < 4 只被排除的题材（仅统计「选够两个之前」遇到的那些）
 *   notes         —— 看板级说明（被排除题材汇总等）
 *   pickCount     —— 实际选出的股票总数
 *   buyNames      —— 买点名单（喂给 buildSellPlan 判「今天又进买点 ⇒ 持有」）
 *   cashAlert     —— ★ 空仓提醒（见 TVRB_CASH_ALERT_AVG_VR / buildCashAlert）；
 *                    ⛔ 只是【提醒文案】，不改变 blocks / picks 的任何内容
 *   ebb           —— ★ [EBB 2026-10-13] 退潮首日（detectEbbDay 的返回）；不是退潮日 ⇒ null
 */
export function buildTopicVolRatioPlan(topics, dragonMap, opts) {
  const o = opts || {};
  const ctx = o.ctx || {};
  const list = (topics || []).filter(function(b) { return b && b.topic; });
  const out = {
    topics: [],
    blocks: [],
    // 与 buildBuyPlan 的返回【同形状】（见 §6 注释）；三个兜底槽位恒为 null —— 结构契约保留
    // ★ [EBB-R8 2026-10-14] 多加一个 `ebbSecond` 槽位 = 退潮首日买点侧唯一那只【市场龙二】。
    //   为什么要放进 buy 里（而不是只看 out.ebbBuy）：decision-collect#_buyBlocksOf 是
    //   「遍历一个买点块」的唯一实现，四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌标记）
    //   都经它取块 —— 挂进这里，龙二那一行才会和其它买点行一样带上这些客观数据（§6）。
    buy: {
      heavy: null, light: null, candidates: [],
      noYizi: null, smallTopic: null, bigTopic: null, ebbSecond: null
    },
    sell: [],
    excludedTopics: [],
    notes: [],
    pickCount: 0,
    buyNames: new Set(),
    // ★ [CASH-ALERT 2026-10-13] 空仓提醒（判据见 buildCashAlert / TVRB_CASH_ALERT_AVG_VR）。
    //   未触发时用【同一份冻结常量】⇒ 引用稳定、不触发下游重算（§19）。
    cashAlert: TVRB_CASH_ALERT_NONE,
    // ★ [EBB 2026-10-13 第五轮] 退潮首日（判据见 detectEbbDay）；
    //   不是退潮日 ⇒ null（一个稳定的 null ⇒ 视图的 v-if / class 绑定不会反复抖动，§19）
    ebb: null,
    // ★ [EBB-R8 2026-10-14] 退潮首日【买点侧唯一那只】的常规买点块（单只票）。
    //   ⚠️ 它与 out.ebb 同步：不是退潮日 / 算不出龙二 ⇒ null。
    ebbBuy: null,
    // ★ [EBB-R8 2026-10-14] 【落库行】= 今天这只总龙到底算不算处在坏状态（不带首日闸门）。
    //   组合式据此 upsert 到 tvrb_ebb_days（⛔ 写库放 watch，computed 必须无副作用 §4）；
    //   次日读回那一行判「是不是首日」。§10：事实未就绪 ⇒ null（⛔ 绝不落一行猜的判定）。
    ebbDayRow: null
  };

  list.forEach(function(b) {
    out.topics.push({
      rank: b.rank,
      topic: b.topic,
      count: b.count,
      yiziCount: b.yiziCount,
      avgVolRatio: avgVolRatioOf(b)
    });
  });

  // 沿题材排名（平均竞价量比降序）往下扫：数量不足的排除并顺延，直到选够 TVRB_TOPIC_LIMIT 个。
  for (let i = 0; i < list.length; i++) {
    if (out.blocks.length >= TVRB_TOPIC_LIMIT) break;
    const b = list[i];
    const tier = resolveTvrbTier(b.count);
    if (tier.tier === 'none') {
      out.excludedTopics.push({
        rank: b.rank, topic: b.topic, count: b.count, avgVolRatio: avgVolRatioOf(b)
      });
      continue;
    }
    out.blocks.push(_buildBlock(b, dragonMap, tier));
  }

  // 决策看板形状的买点计划：第 1 块 → heavy、第 2 块 → light（本看板最多两块，candidates 恒空）
  out.blocks.forEach(function(b, i) {
    if (i === 0) out.buy.heavy = b;
    else if (i === 1) out.buy.light = b;
    else out.buy.candidates.push(b);
  });

  // ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日判定 —— 排在空仓提醒【之前】：
  //   「空仓提醒」在退潮日走退潮口径（理由比「量比 < 25」更硬），见 buildCashAlert 的二参。
  //   ⛔ 它只读【事实】（谁是总龙 / 今天停不停牌 / 占比多少），不读 state、不发请求（事实由采集层给）。
  // ★ [EBB-R8 2026-10-14] 第二个入参 = 【上一交易日落库的退潮判定】（tvrb_ebb_days 表里那一行）
  //   —— 首日闸门用它；缺省（表不存在 / 那天没记录）⇒ 退化为「用昨日行情行推断」，再取不到按首日。
  out.ebb = detectEbbDay(o.ebbCtx || null, o.prevEbbDay || null);

  // ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒：只看【能入选的】排名第一题材（blocks[0]）。
  //   ⛔ 放在选股【之后】、且只读不写 —— 命中时股票照常列在下面（用户原话「还是按照原来的正常方式
  //      选出排名第一，第二的题材的股票，只是……多添加了空仓提醒文字」）。
  out.cashAlert = buildCashAlert(out.blocks[0], out.ebb);

  // ★ 买点标签收口 —— decision-rules 的【同一份实现】（占比 / 动作标签 / 持有 / 题材标记）
  const fOpts = {
    dragonMap: dragonMap,
    prevDragonNames: ctx.prevDragonNames || null,
    prevBoughtNames: ctx.prevBought || null,
    prevBoughtTopics: ctx.prevBoughtTopics || null,
    topicStreakPast: ctx.topicStreakPast || null,
    prevBuyNames: ctx.prevBuyNames || null,
    ruleNo: RULE_NO.FIRST
  };
  out.blocks.forEach(function(b) { finishBuyBlock(b, fOpts); });

  // ★ [EBB 2026-10-13 第六轮用户口径] 退潮首日 ⇒ 买点动作【覆盖式】重写：
  //   「退潮当天，只有卖没有买」「买点侧还标有 持有 竞价买，应该标的是『退潮不买』」。
  //   把每行的【持有】/【竞价买】/【尾盘买】…一律换成【退潮不买】（含仓位槽）。
  //   ⛔ 必须排在 finishBuyBlock【之后】（要覆盖它刚算出来的标签）；
  //   ⛔ 客观数据（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）一行不动。
  if (out.ebb) _applyEbbBuyRules(out.blocks, out.ebb);

  // ★★ [EBB-R8 2026-10-14 用户口径] 退潮首日【买点侧唯一那只 · 市场龙二】：
  //   「买点只有一个，那就是市场的龙二……把它入选到买点侧」。
  //   ⛔ 顺序（三步都不能换）：
  //     ① `_applyEbbBuyRules` 先跑完（把【常规题材块】的每行改成【退潮不买】+ 整段灰化）
  //        —— 用户拍板：这些票【照旧列出来】（灰化空仓视觉保留），只是不再有买点；
  //     ② 再构造龙二那一行（它走 finishBuyBlock，拿到客观数据与原始买点信号，然后换成专属标签）
  //        —— 若反过来，第 ① 步会把它也打成【退潮不买】（那这枚唯一买点就没了）；
  //     ③ 同时挂进 `buy.ebbSecond` 槽位，让四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）
  //        照常给它挂客观数据（§6 共用同一次遍历）。
  //   §10：当日涨幅未就绪 / 这一只找不到真实成员行 ⇒ 构造返回 null ⇒ 买点侧不出现这一行
  //        （⛔ 绝不拿昨日涨幅或另一个名次去顶替），空仓标语会如实改口径（见 detectEbbDay）。
  out.ebbBuy = _buildEbbSecondBlock(out.ebb, list, fOpts);
  if (out.ebbBuy) out.buy.ebbSecond = out.ebbBuy;

  // ★★ [EBB-R8 2026-10-14 用户口径] 落库行：把今天的退潮【判定】存下来，供明天判「是不是首日」。
  //   ⛔ 与 out.ebb 的区别：out.ebb 带首日闸门（昨天已退潮 ⇒ 今天 null），本行不带 ——
  //      本行回答的是「今天这只总龙到底在不在坏状态」，这正是明天那个闸门的输入（§6 同一把尺子）。
  //   ⚠️ 只在【有事实】时产出（§10）；写不写（今天 / 历史日）由组合式把关，本层不做时间判断。
  out.ebbDayRow = buildEbbDayRecord(out.ebb, o.ebbCtx || null, o.date);

  // 买点名单（喂给卖点判「今天又进买点 ⇒ 持有」）
  out.blocks.forEach(function(b) {
    (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  });
  // ★ [EBB-R8 2026-10-14] 退潮首日唯一那只【市场龙二】同样是「今天进买点」⇒ 进名单（§6 同一个集合）。
  //   作用：它若昨天已经买过（也在卖点侧），卖点侧会标【持有】而不是被要求清仓 ——
  //   「今天唯一要买的票」与「今天要竞价卖掉」不可能同时成立（见下方 _applyEbbSellRules 的放行）。
  if (out.ebbBuy) {
    (out.ebbBuy.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }

  // ★ 卖点段 —— decision-rules 的【同一份实现】；⛔ 候选池不依赖本看板选股（= 昨日打过买标签的票），
  //   只有「今天又进买点」这一条换成【本看板自己的名单】（本看板内部自洽）。
  const sellRows = o.sellRows || [];
  if (sellRows.length > 0 && list.length > 0) {
    out.sell = buildSellPlan(sellRows, list, dragonMap, ctx.prevDragonNames || null, out.buyNames);
    // ★ [SELL-AVG-VR 2026-10-11 用户报障] 卖点侧题材标题行也要显示【平均竞价量比】——
    //   用户原话：「题材量比看板的卖点侧，题材的平均量比数值没有显示出来，只出现 -，这个符号。修复下」。
    //   根因（两处叠加，缺一不可）：① 分组 g 是 buildSellPlan 产出的（那是决策看板的实现，
    //   它压根不知道「平均量比」这回事）⇒ g 上没有这个值；② 卖点标题行渲染的是 TvrbTopicHead，
    //   它读的 prop 叫 avg-vol-ratio ⇒ 调用点没传就回落到 '—'。
    //   口径：按 g.topic 从【本函数已经排好序的题材清单 list】里反查同一个题材块，
    //   用【同一个】avgVolRatioOf 算（§6 ⛔ 绝不在卖点通路里另写一份平均量比实现）。
    //   ⚠️ 卖点候选 = 昨天买过的票，它所在的题材【今天可能根本没成组】⇒ 查不到 ⇒ 如实给 '—'
    //      （§10：未知 ≠ 量比 0）。
    const topicByName = new Map();
    list.forEach(function(b) { topicByName.set(String(b.topic || ''), b); });
    const avgTextOf = function(topic) {
      const b = topicByName.get(String(topic || ''));
      return b ? formatAvgVolRatio(avgVolRatioOf(b)) : formatAvgVolRatio(null);
    };
    // 十日涨幅文案：buildSellPlan 只给数值（决策看板的卖点组件是在模板里自己 format 的），
    // 本文件按 §21「模板零计算」的口径统一在这里补上（⛔ 不在组件里再 format 一次）。
    out.sell.forEach(function(g) {
      if (!g.avgVolRatioText) g.avgVolRatioText = avgTextOf(g.topic);
      (g.items || []).forEach(function(it) {
        if (!it.pctText) it.pctText = formatRangePct(it.pct);
      });
    });
    // ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日 ⇒ 卖点动作【覆盖式】重写：
    //   只有【同题材可用龙位】【市场总龙二】两只标「看分笔卖」（等开盘看分笔、不看占比），
    //   其余（含原本标【持有】的）一律改【竞价卖】。
    //   ⛔ 排在平均量比 / 涨幅文案补全【之后】：那两项是客观数据，本改写一律不碰。
    if (out.ebb) _applyEbbSellRules(out.sell, out.ebb);
  }

  out.pickCount = out.blocks.reduce(function(n, blk) { return n + blk.picks.length; }, 0);

  if (out.excludedTopics.length > 0) {
    const names = out.excludedTopics.map(function(t) {
      return t.topic + '（' + t.count + ' 只，量比 ' + formatAvgVolRatio(t.avgVolRatio) + '）';
    }).join('、');
    out.notes.push('⚠️ 按平均竞价量比排名靠前、但股票数量不足 ' + TVRB_MIN_COUNT +
      ' 只 ⇒ 不入选并顺延到下一题材：' + names);
  }
  if (out.blocks.length < TVRB_TOPIC_LIMIT && list.length > 0) {
    out.notes.push('当日只有 ' + out.blocks.length + ' 个题材满足条件（数量 ≥ ' + TVRB_MIN_COUNT +
      ' 只），不足 ' + TVRB_TOPIC_LIMIT + ' 个。');
  }
  if (out.sell.length > 0) {
    out.notes.push('卖点候选 = 上一交易日打过「买」标签的股票（与决策看板同一份数据源）；' +
      '「今天又进买点 ⇒ 持有」用的是【本看板自己选出来的买点名单】。');
  }

  return out;
}

/**
 * 【规则面板文案】—— 与决策看板同款（灰色问号点开的说明）。
 *
 * ⛔ 文案与判定必须同处一处（§6）：改了 buildTopicVolRatioPlan 的口径，请顺手改这里，
 *   否则用户点开规则看到的条文与实际选股不一致（那是比没有说明更坏的情况）。
 * ⛔ 文案里的数字用常量拼接（⛔ 不要在字符串里写死 4 / 8 / 2）。
 * @returns {string[]} 一行一条
 */
export function buildTvrbRulesLines() {
  return [
    '【题材量比】看板 · 规则',
    // ── ★ [MANTRA 2026-10-14 用户口径 · 原话] 用户要求「在那个提示文字板上加上一句」：
    //    「买在分歧，卖在一致。弱势切抱团，分歧切核心。今天是总市场龙一分歧，核心就是总市场龙二。
    //      龙一分歧时，就切到龙二。」
    //    ⛔ 原文照录（含「今天」那一句 —— 它就是这条口诀的实例说明），只在句尾补一句「对应第几条」，
    //       让口诀与第二十一条【总龙二买】互相指得着（§6：文案与口径同处一处）。
    '★【口诀 · 用户口径】买在分歧，卖在一致。弱势切抱团，分歧切核心。' +
      '市场总龙（龙一）分歧时，核心就是【市场总龙二】（今天正是这种情形：总市场龙一分歧' +
      ' ⇒ 核心就是总市场龙二）；龙一分歧时，就切到龙二 —— 即第二十一条那只【' +
      EBB_SECOND_BUY_TAG + '】。',
    '一、题材排名：把早盘竞价看板的题材按【平均竞价量比】由高到低排序（与早盘竞价「题材 toggle」同一套组序）；' +
      '★ 只看平均竞价量比、【不管题材里股票有多少只】（量比相同才按题材名定序）——与早盘竞价题材 toggle 逐键一致。',
    '二、题材数量门槛：题材内股票数量 < ' + TVRB_MIN_COUNT + ' 只 ⇒ 该题材【不入选】；' +
      TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_MID + ' 只；' +
      '> ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_BIG + ' 只。',
    '三、取几个题材：按排名从高到低往下扫，跳过数量不足的题材，只保留最靠前的 ' +
      TVRB_TOPIC_LIMIT + ' 个入选题材（不足时顺延，直到取够或没有合格题材）。',
    '四、选股顺序：入选题材内按【龙一 → 龙二 → 龙三 …】从高到低依次取票。',
    '五、竞价涨停剔除：某龙位股票【竞价涨停（竞价一字）】⇒ 当天买不进，跳过它并顺延到下一个龙位' +
      '（龙一涨停看龙二，龙二涨停看龙三……依次类推）。',
    '六、只数上限：每个入选题材最多取到本档只数（' + TVRB_PICK_MID + ' 或 ' + TVRB_PICK_BIG +
      ' 只）；该题材可买（非竞价涨停）的票不足时【少取】，⛔ 不从其它题材补位。',
    '七、仅主板：没有龙标签的票（创业板 300/301、科创板 688/689）不参与本看板选股（与决策看板同口径）。',
    '八、【买入 / 卖出标签与决策看板完全同一套】：占比、竞价买、尾盘买、尾盘买（先卖后买）、' +
      '下杀买（竞价异常）、补涨竞价买、龙一字持有、持有、昨日已买 —— 由决策看板的同一份规则算出，' +
      '⛔ 本看板没有第二套判断。',
    '九、【卖点段】候选 = 上一交易日打过「买」标签的股票（与决策看板同一份数据源），' +
      '动作（竞价涨停卖 / 竞价卖 / 竞价卖（先卖后买）/ 尾盘卖 / 10分钟时卖 / 跟龙竞价卖 / 持有）' +
      '同样由决策看板的同一份规则给出；只有「今天又进买点 ⇒ 持有」用的是本看板自己的买点名单。',
    '十、【仓位】本看板不标重仓 / 轻仓 —— 它按龙位取票，本来就没有「前 N 只重仓」这个口径' +
      '（⛔ 不凭空造一条仓位规则）；昨天真买过的票仍标【持有】。',
    '十一、【分笔图】点【序号】或【股票名】展开该股的 9:30~9:31 分笔明细 —— ' +
      '与「分笔买卖」看板是同一个面板、同一段文字（含红绿笔数、立刻买 / 下杀买 / 冲高卖 / 立刻卖）。',
    '十二、数据来源：完全复用早盘竞价看板的题材分组 / 竞价一字 / 十日涨幅 / 竞价量比（与决策看板同一份真相）。',
    '十三、本看板【不抓数据、不落库】：早盘竞价与决策相关的数据一概不额外请求、不消耗猫抓额度；' +
      '只有分笔明细与「分笔买卖」看板共用同一份已抓数据（同一只票只抓一次）。',
    '十四、数据没加载完时如实提示「未就绪」，不给结论（§10：未就绪 ≠ 今天没有）。',
    // ── ★ 操作纪律（2026-10-11 用户原话交代的实盘流程，用户要求「写进规范…起到提醒作用，
    //    同时规范自己的交易行为」）—— ⛔ 这不是判定规则，只是把用户自己的纪律放在他看得到的地方。
    '十五、【操作纪律 · 买点】（用户自定的实盘流程，本看板只做提醒）：看到买点提示【竞价买】⇒ ' +
      '9:26 左右数据一出就先竞价买一笔；等到 9:31 左右点开该股【分笔成交】看结论 —— ' +
      '① 提示【下杀买】且真的下杀 ⇒ 再补一笔（两个买点出现矛盾时补，拉低持仓成本）；' +
      '② 提示【立刻买】⇒ 不再补（两个买点吻合，已经买够）。',
    '十六、【操作纪律 · 卖点】（用户自定的实盘流程，本看板只做提醒）：看到卖点提示【竞价卖】⇒ ' +
      '竞价期间先卖半仓；等到 9:31 左右点开该股【分笔成交】看结论 —— ' +
      '① 提示【冲高卖】⇒ 等冲高再清掉；② 提示【立刻卖】⇒ 止损离场。',
    '十七、【分笔结论（9:30~9:31）】只看红绿笔数：红 > 绿 ⇒ 强；红 ≤ 绿 ⇒ 弱（红绿打平也按弱处理）。' +
      '买点侧 强 = 立刻买 / 弱 = 下杀买；卖点侧 强 = 冲高卖 / 弱 = 立刻卖 —— 与「分笔买卖」看板是' +
      '同一份判定同一个面板；⛔ 它只作买卖时机的参考，不参与决策看板的任何规则。',
    '十八、【上游成交笔数】= 上游（东财）的【累计成交笔数】在这一分钟窗口内的差值' +
      '（不含窗口内第一条快照自身）⇒ 即这一分钟【真实成交的笔数】。' +
      '它与面板标题上的「共 N 笔」不是一回事：那是【我们保存的快照条数】（节奏由上游推送决定），' +
      '同一价格同一秒的多笔成交会被上游并进一个快照，所以快照条数通常远小于真实成交笔数。',
    // ── ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒（用户要求：要在买点侧醒目提示，看到就不开仓）
    '十九、【空仓提醒】当【能入选的题材里排名第一】的那个题材，其平均竞价量比 < ' +
      TVRB_CASH_ALERT_AVG_VR + ' ⇒ 买点侧顶部显示大字【建议空仓】标语，代表题材退潮' +
      '（最强的题材量比都这么低 ⇒ 当天什么票都容易走弱）。' +
      '⚠️ 判据只看【能入选的】排名第一者：量比更高的题材若因数量不足被排除，就顺位看下一个；' +
      '⛔ 不看排名第二 —— 排名就是按平均竞价量比降的，第二只会更低。' +
      '⚠️ 它只是【提醒】，⛔ 不改变选股：股票仍按上面第一~七条照常列出（供你参考），' +
      '只是看到这条提示建议今天不开仓。' +
      '★ 另外，当当日为【退潮首日】（第二十条）时也一律提示空仓，并改用退潮口径的标语。',
    // ── ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日（用户原话见文件头，规则与判定同处一处，§6）
    '二十、【退潮首日 · 卖点收紧】市场总龙 = 当日早盘竞价【全列表】里【昨日十日涨幅】最高、' +
      '且【有龙位（主板龙标）】的那只。' +
      '它今日【停牌】或【竞价占比不达标】（二者有一即算）⇒ 判定为【题材退潮首日】。' +
      '⚠️ 涨幅口径是【昨日】的：当天早上还没收盘算不出今天的十日涨幅，停牌票当天更是读不到。' +
      '⚠️ 【只认有龙位的票】：创业板 / 科创板不发龙标，不具备「某题材的龙头」语义，' +
      '也就不可能承载【题材退潮】—— 它们不参与总龙排名（否则一只没有龙标的高涨幅票会顶掉真总龙，' +
      '让退潮判定永不成立）。',
    '　　退潮首日，卖点侧只有两类票标【' + EBB_PICK_TAG + '】（= 允许等开盘看【分笔成交】再卖，' +
      '⛔ 不看占比）：' +
      '①【同题材可用龙位】= 总龙所在题材里龙位最靠前、且【非竞价一字 / 非停牌】的那只' +
      '（龙二不可用就顺延龙三、龙四……）；' +
      '②【市场总龙二】= 昨日十日涨幅【第二】的那只，且必须是【它自己题材的龙一】、与总龙【不同题材】、' +
      '且非竞价一字 / 非停牌（⛔ 这一只【不顺延】：它必须正好是涨幅第二，不递补涨幅第三）。',
    '　　其余股票（含原本标【' + HOLD_TAG + '】的）一律改【' + SELL_OUT_TAG + '】：开盘就走，降低风险。',
    '　　买点侧：退潮首日是【只有卖、没有买】——入选股票的买点动作标签一律改为【' + EBB_NO_BUY_TAG + '】' +
      '（原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废），' +
      '整段【变灰】+ 顶部大字【建议空仓】：今天不开新仓。' +
      '⚠️ 唯一的例外是第二十一条的那一只【总龙二买】。',
    // ── ★ [EBB-R8 2026-10-14 用户口径] 「首日」限定 + 买点侧唯一那只（用户要求写进规则手册）──
    '　　⚠️【只在首日生效】：上面这套退潮规则，只对市场总龙【首日】出现停牌 / 占比不达标的那一天生效。' +
      '如果总龙【连续第二天】还是停牌（或还是不达标），就【不算】了 —— 规则不生效，按平常的日子处理。' +
      '判据 = ① 先看【上一交易日那只总龙】落库的判定（存到 tvrb_ebb_days 表里：那天算不算退潮）；' +
      '② 表里没有那天（例如那天没打开过看板）⇒ 用上一交易日那一行的【竞价量 / 占比】推断' +
      '（竞价量 0 = 那天没有竞价 = 停牌语义）；' +
      '③ 两处都取不到 ⇒ 按【首日】处理（宁可多提醒一次，不漏掉风险）。' +
      '⚠️ 只认【同一只总龙】：昨天当总龙的是别的票 ⇒ 对今天这只而言本来就是首日。' +
      '说明文字里会如实写出本次这条判定是从哪里来的（落库 / 推断 / 按首日）。',
    '二十一、【退潮首日 · 买点侧唯一那只「' + EBB_SECOND_BUY_TAG + '」】退潮首日的买点侧' +
      '【只有一个买点】，就是【市场龙二】= 整个早盘竞价看板股票列表里【当日十日涨幅排名第二】的那只' +
      '（例如 10-13 = 九阳股份，当日十日涨幅 86%，全列表第二）。' +
      '⚠️ 排名用【当日】十日涨幅（= 屏幕上「十日涨幅」那一列）——与第二十条的市场总龙的【昨日】口径不同：' +
      '总龙停牌时当日读不到涨幅、只能用昨日；龙二只看今天谁最强，所以看今天那一列。' +
      '⚠️ 与市场总龙【同一把尺子】：只认【有龙位（主板龙标）】的票（创业板 / 科创板不参排）。' +
      '⚠️ 取【不是总龙本人】里最靠前的那一只：总龙当日有涨幅（排第 1）⇒ 取第 2 名；' +
      '总龙今日停牌 / 当日无涨幅 ⇒ 取第 1 名（榜单第二名换成了它，口径不变）。' +
      '⚠️ 它可以是同题材的，也可以不是 —— 只看「所有股票里的十日涨幅第二名」。' +
      '⚠️ 标签是【' + EBB_SECOND_BUY_TAG + '】这一枚专属标签（不是竞价买 / 尾盘买），' +
      '但行内说明会把它【常规的买点信号】（占比达标 ⇒ 竞价买 / 不达标 ⇒ 尾盘买）原样写出来，信息不丢。' +
      '⚠️ 这一行【不参与买点侧的整体灰化】：灰化只盖入选题材块那些【' + EBB_NO_BUY_TAG + '】的行 ——' +
      '它正是要一眼看见的那一只。' +
      '⚠️ 它若今日停牌 / 竞价一字（买不进），照样列出来并如实标注，⛔ 不顺延到第三名。' +
      '⚠️ 它若同时在卖点侧（昨天已经买过），卖点侧【不改写】它的标签（今天又进买点 ⇒ 持有）——' +
      '同一天不可能既「唯一要买」又「竞价清仓」。',
    '二十二、本看板的退潮判定【不做预测、不改客观数据】：十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 /' +
      '名次变化 / 连板 / 封单额一律照常显示 —— 退潮只改「今天怎么买、怎么卖」。'
  ];
}
