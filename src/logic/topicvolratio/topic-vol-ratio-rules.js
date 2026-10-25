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
// [TVRB-926 2026-10-14 用户口径] 「取某只票在某个区间涨幅 Map 里的数值」的唯一实现
//   （缺值 → null，§10 不补 0；与 range-pct-sort.js 的排序共用同一份读取口径，§6）
import { readRangePct } from '../auction/range-pct-sort.js';
// ★ [EBB-R20 2026-10-20 用户口径] 20日涨幅总龙一~五的展示名（总龙N）——
//   与「20日涨幅」toggle 的专属显示层用【同一份实现】（§6：替补选股的「总龙N」标签不许另写一份）。
import { totalDragonLabel } from '../auction/range20-top5-label.js';
// ★ [DIVERGE 2026-10-20] 总龙首次分歧判定 + 跟随高标选股（§15 独立业务模块，纯函数）
import { pickDivergeFollowers } from '../auction/leader-divergence.js';
// ★★ [CORE-CAT 2026-10-22 用户口径] 「题材 → 大类（核心词）」归一的唯一实现（纯函数，零依赖）。
//   用户原话：「AI应用是大类，我在核心管理里把文化传媒放到那个大类了，那个大类就是我说的题材。」
//   ⛔ 规则层不自己去读 core_topics（§5 Data 层职责）：归一函数由组合式用 getCoreTopics() 造好注入。
import { makeCoreTopicResolver } from '../topic/core-category.js';
// ★★ [R10-BACKUP 2026-10-24 用户口径] 「十日涨幅 · 在列次数候补」的判定（§15 独立纯函数模块）。
//   用户原话：「排名第二的题材如果量比太小就用 10 日涨幅首次在列进行候补……因为 20 日老周期结束，
//   现在轮到十日周期」⇒ 判定（排名 / 首次在列 / 同题材闸门）全在 range10-backup.js，
//   ⛔ 本文件只负责「什么时候要用候补」+ 把它组装成买点块（§6 判据唯一）。
import { pickRange10Backup, buildRange10Ranked, RANGE10_BACKUP_RULE_NO } from './range10-backup.js';
// [R10-BACKUP] 「前十名」的只数常量与 presence-label 共用（§6：同一个数字只有一处真相）
import { PRESENCE_TOP_N } from '../auction/presence-label.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [EBB-TOPIC-FIX 2026-10-22] 题材串归一（§6 唯一实现，⛔ 别在三个消费点各写一遍）
//
// 用户报障：「今天10月22日……提示板说【主线16950新华传媒首次退潮】，这个不是首次了」。
// 根因链（实测站库确认，完整过程见 data/watchlist-helpers.js 的 topics 分支注释）：
//   ① 新华传媒 10-21 / 10-22 都是【停牌补位票】（不在当天 watchlist 里）⇒ 题材走「昨日题材」退路；
//   ② 那条退路取 'topics' 时命中了读取器的 yest_volume 兜底 ⇒ 退潮行里 leader_topic = '16950'；
//   ③ 事件计数按题材认亲 ⇒ '16950' 在近 10 天里 0 次 ⇒ 误判【首次退潮】。
// 修好 ② 之后，【历史行】里仍留着 '26728' / '16950' 这两条脏数据（不能靠改库解决：
//   历史判定是审计留痕，而且用户明确不让动 worker 相关的表）⇒ 计数这一层必须【认得出脏值】：
//   · 题材名不可能是纯数字 ⇒ 纯数字一律视作【未知】（清洗成空串）；
//   · 任一侧题材未知 ⇒ 退回「同一只总龙」认亲（从紧，不乱认亲 —— 与既有认亲退路同一条口径）；
//   · 两侧都有题材 ⇒ 按题材比较，且支持「AI应用,数据中心」这种分段串。
// ⇒ 10-22 实测效果：今天的题材解析出 'AI应用'（题材库补位），历史 10-14/10-15 事件（1 次）
//   + 10-20 事件（1 次）= 2 次 ⇒ 第二十七条「无第三次」生效 ⇒ 不再误报首次退潮。
// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * 题材串清洗 + 大类归一：trim；**纯数字一律置空**（那是错值：题材名不可能是 '16950'）；
 * 再按核心词表把细分题材归到【大类】（用户口径：判定用的「题材」= 核心管理里的大类）。
 *
 * ★★ [CORE-CAT 2026-10-22 用户口径] 「文化传媒」⇒「AI应用」这一步是【必须】的：
 *   新华传媒行上的细分题材是「文化传媒」，而老周期在落库表里写的是「AI应用」——
 *   不归一 ⇒ 近 20 个交易日的退潮事件数从 2 掉到 0 ⇒ 误报【首次退潮】（10-22 用户报障）。
 *
 * @param {*} raw 原始题材串
 * @param {(raw:string)=>string} [coreRes] 大类归一函数（makeCoreTopicResolver 的返回）
 *        缺省 / null ⇒ 只做清洗，不做归一（= 本参数引入前的行为，§11 零行为变化）
 * @returns {string}
 */
function _normTopic(raw, coreRes) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return '';
  if (typeof coreRes === 'function') {
    const t = String(coreRes(s) || '').trim();
    if (t) return t;
  }
  return s;
}

/**
 * 两个题材串是否同一题材（支持 'AI应用,数据中心' 分段串；任一侧为空 ⇒ false）。
 * ★ 两侧都先过 `_normTopic`（清洗 + 大类归一）再比 —— 归一后相等即同一题材。
 * ★ 分段串认亲是【双向】的：'AI应用' 与 'AI应用,数据中心' 必须认成同一题材
 *   （旧实现只看前者的分段，后者反过来就认不上；两段串同时出现时更会互相漏认）。
 */
function _sameTopicLoose(a, b, coreRes) {
  const x = _normTopic(a, coreRes);
  const y = _normTopic(b, coreRes);
  if (!x || !y) return false;
  if (x === y) return true;
  const split = function(s) {
    return s.split(/[,，/、+;；|]/).map(function(seg) { return seg.trim(); }).filter(Boolean);
  };
  const xs = split(x);
  const ys = split(y);
  return xs.some(function(sx) { return ys.some(function(sy) { return sy === sx; }); });
}

/**
 * ★ [EBB-20D 2026-10-22 用户口径] 「退潮事件计数」的窗口 = 近【20 个交易日】。
 *
 * 用户原话：「时间太短没有检查到10月13日那天？」—— 旧窗口是 10 个交易日，跨不过一个完整的老周期：
 *   老周期的首次退潮在 10-13，到 10-22 已隔 7 个交易日（还在窗口内），但要判「无第三次」必须
 *   同时看见 10-14/10-15（首次事件）与 10-20（二次事件）—— 10 天窗口在节假日错位时会漏。
 * ⇒ 窗口口径定为 20 个交易日（与「20日涨幅」的 20 日同量级，用户口径一致）。
 *
 * ⚠️ 组合式注入的 ebbHistory 必须【多给 2 天】（= 22 行）：连续退潮日要合并成一次事件，
 *   最早那天如果正好是窗口第一天，需要它前一天那一行来证明「它不是延续」。
 */
export const EBB_EVENT_WINDOW_DAYS = 20;

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
 * ══【小题材收紧 · 排名第一且数量 4~6 只】════════════════════════════════════════════════════
 *
 * 用户原话（2026-10-24，逐字）：
 *   「9月30日，入选排名第一的是新能源汽车，总数4只，平均量比32.55达到门槛。题材量比买点侧今天
 *     选了江淮汽车，不够准确。原因就是因为总数太少，没有启动性，所以次日导致a杀。所以遇到入选排名
 *     第一的题材数量在4-6只时（不是4-8只，那只是入选股票数量1只条件，我说的这个是选票范围），
 *     条件要苛刻些。如果排名第一的题材数量4-6只，要看10日涨幅，看有没有同题材票进入前10，
 *     如果有就选最靠前那一只，如果没有，就弃掉了。」
 *   「因为这种数量少的，次日能存活下来的顶多有一只。所以就买最强的。要收紧下。」
 *
 * ⛔ 与 `TVRB_MID_MAX`（= 8）是【两个完全不同的东西】，绝不能互相替代（用户当场纠正过一字）：
 *   · `TVRB_MID_MAX` = 8   ⇒ **取几只**：4~8 只这一档只取 1 只 —— 这是【只数】口径；
 *   · 本常量 = 6           ⇒ **选票范围收紧**：4~6 只这一段的题材，票还必须进【当天十日涨幅前十】
 *                            —— 这是【选票范围】口径。
 *   ⇒ 7~8 只的题材【不受】本规则约束，照旧按龙位取票（用户：「不是4-8只」）。
 *
 * 口径（§6：两把尺子都与屏幕同源，⛔ 不另写一份）：
 *   · 「当天十日涨幅前十」= `PRESENCE_TOP_N`（与「10日涨幅」toggle 那十枚标签同一个常量），
 *     名次来自 `range10-backup.js#buildRange10Ranked`（与第二十九条候补、与屏幕同一个实现）；
 *   · 「〔竞价口径〕」= 买点侧固定用的 9:26 那一份（`_withAuctionLegPct` 覆盖后的池子），
 *     与龙位名册（`rankDragonsWithPctMap`）同源 —— 早上选出来，收盘翻回来还是同一批。
 */
export const TVRB_SMALL_TOPIC_MAX = 6;

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
 *   【旧口径 · 2026-10-14】「买点只有一个，那就是市场的龙二（不是同题材的），是整个早盘竞价看板的股票列表中的
 *     十日涨幅排名第二的龙二……」（标签拍板为【单独一枚「总龙二买」】）
 *   【新口径 · 2026-10-20】「把原来按照10日涨幅改成20日涨幅选股……从20日涨幅中的总龙一到总龙五
 *     选出两只排名靠前的。而且是不同总龙一题材的股票……也就是从这五只中，要判断是不是创业板，
 *     科创板，北交所等非主板的股票，如果是先排除，剩下的看是不是和总龙一是同题材，是也排除，
 *     剩下的就选排名靠前的那两只。只选好两只，已经完成任务，后面不选了。」
 *
 * ⇒ 退潮日，买点侧**可买的那几行** = 20日涨幅总龙一~五里选出的【替补 · 最多两只】，
 *   每行挂这一枚标签（⛔ 不是 finishBuyBlock 的 竞价买 / 尾盘买 —— 用户明确要专属标签），
 *   原始买点信号（占比达标与否）写进行内说明，信息一枚不丢。
 * ⛔ 与 EBB_NO_BUY_TAG 是两枚不同的标签：那枚是「今天不买」，这枚是「今天唯一买点」。
 */
export const EBB_SECOND_BUY_TAG = '退潮替补买';
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
 * ══ 【空仓提醒】买点动作标签（第十六轮 · 2026-10-16 用户口径）══════════════════════════════
 *
 * 用户原话：
 *   「题材量比有这个提示时：⚠️ 今日建议空仓 · 不开仓……这个提示下的买点侧，全部变成灰色
 *     （卖点侧不变），买点侧股票标签改成"分歧日不买"。那个灰色的样式类似 10月13日的退潮首日
 *     那个买点侧整版灰色，你可以参考下。其它不变。」
 *
 * ⇒ 命中【空仓提醒】（能入选的排名第一题材 平均竞价量比 < TVRB_CASH_ALERT_AVG_VR）时，
 *   买点侧【每一只票】的动作标签一律换成这一枚 —— 原本由 finishBuyBlock 给出的
 *   【持有】/【竞价买】/【尾盘买】/【先卖后买】… 全部作废（用户口径「分歧日不买」）。
 *
 * ⛔ 只在本看板用（决策看板 / 分笔看板零改动，用户「其它不变」）。
 * ⛔ 与 EBB_NO_BUY_TAG 是两枚【不同成因】的标签，同处一套灰化视觉：
 *   · 【退潮不买】= 市场总龙停牌 / 占比不达标 ⇒ 退潮【首日】；
 *   · 【分歧日不买】= 最强题材的平均量比 < 25 ⇒ 分歧日（题材退潮）但不是退潮首日。
 *   用户本轮只讲「空仓提醒」这一种情形 ⇒ 退潮首日优先走它自己那一枚（见 buildTopicVolRatioPlan）。
 */
export const CASH_NO_BUY_TAG = '分歧日不买';
/**
 * 配色档（本看板独有）：★ 与 EBB_NO_BUY_TONE【同一个值】—— 灰化容器下两枚「不买」标签共用同一配色档。
 *
 * ⚠️ 为什么必须是别名而不是新值：`.tvrb-buy-list.tvrb-ebb` 挂着 `filter: grayscale(1)`，
 *   深底亮字是灰化后唯一还读得出来的档（见 EBB_NO_BUY_TONE 的长注释）。
 *   新造一个同名值 = 同一条 CSS 规则写两处（§6 禁止的第二份真相）。
 */
export const CASH_NO_BUY_TONE = EBB_NO_BUY_TONE;

/**
 * ══ 【总龙首次分歧 · 买点】标签组（第十九轮补丁⑧ · 2026-10-20 用户口径）══════════════════
 *
 * 用户原话：「市场总龙一，第一次出现分歧的时候，是买点。像新华传媒10月19日出现分歧，一般开盘
 *   它会下杀，然后反弹，所以标签应该是下杀买。也就是题材量比买点侧只有市场总龙一，还有其它
 *   不同题材的两只高标股票（20日涨幅前五的），同题材的不要……最多三只。」
 *
 * 三个概念（★ 全部定义在 leader-divergence.js 的文件头注释里，这里是展示口径）：
 *   · 【首板】= 20 日窗口内第一个收盘涨停日 —— 分歧计数从首板日起算，之前的小阴小阳一概不算；
 *   · 【首次分歧】= 首板后第一个【竞价涨幅 < 0】的日子（新华传媒 11 连板后 10-19 低开 -1.06%）；
 *   · 【分歧转一致】= 分歧日后出现的涨停日（九阳股份 10-16）；转一致后再低开 = 二次分歧，依次类推。
 *
 * 三枚标签：
 *   · DIVERGE_DIP_TAG（下杀买）= 总龙一自己在分歧日的买点（开盘下杀然后反弹，别追竞价）。
 *     ⛔ 与 decision-rules 的「下杀买（竞价异常）」是【两条不同的规则、两个不同的文案】——
 *     那条是中军三项指标正面异常的下杀买；这条是总龙首次分歧日的下杀买。文案按用户本轮原话取三字。
 *   · DIVERGE_FOLLOW_TAG（高标跟随买）= 与总龙不同题材的主板高标（20日涨幅前五，≤2 只）。
 *   · DIVERGE_NO_BUY_TAG（总龙分歧不买）= 分歧日其余入选票（照常列出、整段灰化，用户口径
 *     「买点侧只有总龙一 + 高标」⇒ 其余票今天不开新仓）。
 */
export const DIVERGE_DIP_TAG = '下杀买';
export const DIVERGE_FOLLOW_TAG = '高标跟随买';
export const DIVERGE_NO_BUY_TAG = '总龙分歧不买';
/** 配色档：三枚全部复用既有档（§6 不新造 CSS）——「买」字辈用琥珀金（与替补同语义：今天真要买），
 *  「不买」用深墨亮字（灰化后唯一读得出的档）。 */
export const DIVERGE_BUY_TONE = EBB_SECOND_BUY_TONE;
export const DIVERGE_NO_BUY_TONE = EBB_NO_BUY_TONE;
/** 本行引用的规则编号（= 规则手册第二十五条「总龙首次分歧 · 买点」） */
export const DIVERGE_RULE_NO = '二十五';

/**
 * 【退潮日】判据（纯函数，可单测）。
 *
 * 数据来源 = decision-collect#_ebbCtxOf 采好的「事实」（市场总龙 / 今日停牌 / 今日占比 /
 *   同题材龙位成员 / 市场总龙二 / 买点侧替补与五只去留留痕），⛔ 本函数不读 state、不发请求（§4）。
 *
 * ── 退潮是什么（★ 2026-10-20 用户口径的【定义澄清】）──────────────────────────────────
 *   「退潮是指总龙一在某个题材停牌或者占比不符，导致是整个题材的股票预期走势很差，
 *     叫题材退潮，不是个股退潮。」⇒ 退潮的主体是【总龙所在的题材】，不是总龙那只票本身。
 *
 * ── 判据（★ 用户口径：「龙一停牌或者占比不达标……两种情况，有一种存在就算退潮」）──────────
 *   ① 市场总龙【今日停牌】⇒ 退潮（停牌 = 最强的那只都停了）；
 *   ② 市场总龙【今日竞价占比不达标】⇒ 退潮。
 *   ⛔ ② 的占比【缺数据】⇒【不判】（§10：未知 ≠ 不达标）；门槛走 auction-share 的唯一实现。
 *   ⛔ 两条都不成立 ⇒ 返回 null（= 不是退潮日，⛔ 不回落到「没有总龙」）。
 *
 * ── ★★【首次 / 二次确认】（2026-10-20 用户口径，本轮新增）─────────────────────────────
 *   用户原话：「判断是不是首日要看它最近10天的表现，如果十天内出现首日退潮，那今天就不能算是
 *     首日了，而是确认主线退潮……提示语改下首日退潮，改成具体的题材名称，比如，主线AI应用
 *     首次退潮。第二次的时候，改成比如，AI应用二次确认退潮。注意没有第三次了，退潮后基本不看了
 *     这个题材了。」
 *   ⇒ 判定 = 【近 10 个交易日】里、同题材的【退潮事件】次数（ebbHistory 注入）：
 *     · 0 次 ⇒ 本次为【首次退潮】（提示语 = 主线{题材}首次退潮）；
 *     · 1 次 ⇒ 本次为【二次确认退潮】（提示语 = {题材}二次确认退潮）；
 *     · ≥ 2 次 ⇒【无第三次】：本规则不再触发，返回 null（按平常日子选股）。
 *   ⚠️ 【事件】≠【天数】：总龙连续多日停牌 / 不达标只算【一次】事件（第二天起是延续，
 *     由下面的「昨日闸门」拦住不触发；历史计数时也把连续退潮日合并，⛔ 别数成多次）。
 *   ⚠️ 计数按【题材】认（leaderTopic）；题材取不到时退回按【同一只总龙】认（§10 从紧，不乱认亲）。
 *
 * ── ★★【昨日闸门】（第八轮 · 2026-10-14 用户口径，保留）─────────────────────────────
 *   用户原话：「我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
 *     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
 *   ⇒ 上面①/② 成立【且】上一交易日【同一只总龙】还没处在坏状态 ⇒ 才触发本规则；
 *     昨天就已经停牌 / 占比不达标 ⇒ 今天算延续 ⇒ 返回 null（本规则不生效）。
 *
 *   「昨日状态」的两条来源（按优先级，见 _prevLeaderDayState）：
 *     ① 【落库的昨日判定】—— verdict 来自 tvrb_ebb_days 表 ⇒ 最权威；
 *     ② 退路：库里昨日那一行的【竞价量 / 占比】推断；
 *     ③ 两处都取不到 ⇒ 按【可触发】处理（继续提醒）—— 用户拍板「取不到就按首日处理，别漏掉风险」。
 *   ⚠️ 只认「同一只总龙」：昨日那只总龙与今日不是同一只 ⇒ 对今天这只而言本来就是新事件。
 *
 * ── 涨幅口径（★ 2026-10-20 改定）────────────────────────────────────────────────────
 *   总龙 = 【当日 20日涨幅】全市场第一（getRange20Leaders，与「20日涨幅」toggle 的总龙一同一只）。
 *   20日按每票自己的交易日回溯、停牌票靠补位照样进榜 —— 这正是改用 20日的原因：
 *   十日口径在总龙停牌那天根本排不出它（当日快照没它的行）。
 *   卖点侧的【市场总龙二】仍用【昨日十日涨幅第二】的旧口径（用户「其它规则不变」）。
 *
 * @param {{ready:boolean, leader:object|null, leaderSuspended:boolean, leaderShare:number|null,
 *          siblingDragons:Array, secondInfo:object|null, prevLeader:object|null,
 *          buyPicks:Array, buyTrail:Array}|null} ebbCtx
 *        见 decision-collect#_ebbCtxOf（[EBB-R20] buyPicks / buyTrail 为本轮新增的两个事实）
 * @param {{leader_stock?:string, ebb?:boolean}|null} [prevEbbDay]
 *        ★ [EBB-R8] 上一交易日在 tvrb_ebb_days 里落库的判定行（缺省 = 表里还没有 / 表不存在）
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string,
 *          ebb:boolean}>|null} [ebbHistory]
 *        ★ [EBB-R20] 近 22 个交易日的退潮判定落库行（组合式读 tvrb_ebb_days 注入；
 *        前 20 天是「事件窗口」，多取的 2 天只用来判「连续退潮日合并成一次事件」）。
 *        缺省 / 空 ⇒ 按 0 次事件处理（= 首次退潮；与「取不到就按首日处理」同一拍板）。
 *        ★ [EBB-20D 2026-10-22 用户口径] 窗口由 10 天扩到【20 个交易日】：
 *          「时间太短没有检查到10月13日那天」—— 10 天窗口跨不过一个完整的老周期。
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（= 第 20 个交易日的日期）
 * @returns {null|object} null = 不是退潮日（或事实未就绪 / 是延续 / 无第三次）；否则见下方返回结构
 */
export function detectEbbDay(ebbCtx, prevEbbDay, ebbHistory, coreRes, windowFrom) {
  // §10：事实未就绪（昨日涨幅还没读回来 / 全列表一只票都排不出）⇒ 不判退潮
  if (!ebbCtx || !ebbCtx.ready || !ebbCtx.leader) return null;
  const leader = ebbCtx.leader;
  const leaderName = String(leader.name || '').trim();
  // ★ [EBB-TOPIC-FIX 2026-10-22] 题材串归一：纯数字（= 脏值，实测 '16950' / '26728'）视作未知，
  //   否则标题会渲染成「主线16950首次退潮」，且按题材认亲会全部落空（见文件头 [EBB-TOPIC-FIX]）。
  // ★★ [CORE-CAT 2026-10-22] 再归到【大类】：'文化传媒' ⇒ 'AI应用'（用户口径，见 _normTopic）。
  const leaderTopic = _normTopic(leader.topic, coreRes);
  const leaderPct = _num(leader.pct);
  if (!leaderName || leaderPct === null) return null;      // §10：涨幅读不到 ⇒ 不判

  // ── 判据 ①/② ──
  // ★★ [EBB-R20 2026-10-20] 判据②的占比门槛【恒按龙头档】：总龙一 = 20日涨幅全市场第一，
  //   它本身就是市场龙头。旧实现「按它今日十日龙位取档（龙一 3.5% / 其余 2%）」是总龙还选
  //   「昨日十日涨幅第一」时代的写法 —— 那时的总龙几乎总是今日龙一，两档等价；
  //   改成 20日选总龙后，总龙完全可能是当日十日口径的龙三（10-20 实测：新华传媒 20日 202.59%
  //   全市场第一，但十日口径里它是 AI应用 的龙三、占比 2.7%）⇒ 若仍按十日龙位落到 2% 档，
  //   2.7% 会被误判「达标」，用户拍板的「今天新华传媒占比不达标 ⇒ 二次确认退潮」整条静默失效
  //   （🔴 这正是「改了选法、忘了改门槛取档」的伴生缺陷，§38 同类根因）。
  //   判据②的本意 = 「全市场最强的那只票竞价占比塌了」，龙头门槛（3.5%，含容错 4%）才是本意。
  const leaderIsDragonOne = true;
  const sh = _num(ebbCtx.leaderShare);
  let reason = '';
  if (ebbCtx.leaderSuspended) {
    reason = 'suspend';
  } else if (sh !== null && !passesAuctionShare(sh, leaderIsDragonOne)) {
    // 门槛恒为龙头档（3.5%）：总龙一的竞价占比塌了才算「占比不符」（用户 10-20 口径）。
    reason = 'share';
  }
  if (!reason) return null;

  // ── ★★【昨日闸门】（第八轮，保留）──
  const prev = _prevLeaderDayState(ebbCtx, prevEbbDay, leaderName);
  if (prev.bad) return null;   // 昨日同一只总龙已在坏状态 ⇒ 今天是延续 ⇒ 本规则不触发

  // ── ★★【首次 / 二次确认】（[EBB-R20 2026-10-20 用户口径]）──
  //   近 20 个交易日里同题材的【退潮事件】次数（连续退潮日合并为一次）：0 ⇒ 首次、1 ⇒ 二次确认、
  //   ≥2 ⇒ 无第三次 ⇒ 本规则不再触发（返回 null，按平常日子选股 —— 用户「退潮后基本不看了这个题材了」）。
  //   ★ [EBB-20D 2026-10-22 用户口径] 窗口 10 → 20 个交易日；且题材按【大类】认亲（coreRes）。
  const phase = _ebbPhaseOf(leaderTopic, leaderName, ebbHistory, coreRes, windowFrom);
  if (phase.count >= 2) return null;
  const isFirst = (phase.count === 0);
  // 提示语（用户给的原样示例）：首日 = 「主线AI应用首次退潮」；第二次 = 「AI应用二次确认退潮」
  const topicText0 = leaderTopic || '总龙题材';
  const phaseTitle = isFirst
    ? ('主线' + topicText0 + '首次退潮')
    : (topicText0 + '二次确认退潮');
  const phaseNote = isFirst
    ? ('（近 ' + EBB_EVENT_WINDOW_DAYS + ' 个交易日内【' + topicText0 + '】没有退潮事件 ⇒ 本次为【首次退潮】' +
       (prev.source === 'unknown' ? '；昨日状态两处都取不到 ⇒ 按【可触发】处理，宁可多提醒一次' : '') + '）')
    : ('（近 ' + EBB_EVENT_WINDOW_DAYS + ' 个交易日内【' + topicText0 + '】已出现过 ' + phase.count + ' 次退潮事件' +
       (phase.lastDate ? ('，最近一次 ' + phase.lastDate) : '') + ' ⇒ 本次为【二次确认退潮】）');

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

  // ── ★★ 买点侧替补【≤2 只】（[EBB-R20 2026-10-20 用户口径]）────────────────────────────
  //   从 20日涨幅总龙一~五里：排非主板 → 排与总龙同题材 → 取排名最靠前的前两只（采集层已选好，
  //   本层只把每只的 20日涨幅 / 总龙N 标签 / 停牌·一字麻烦如实格式化）。
  const rawPicks = Array.isArray(ebbCtx.buyPicks) ? ebbCtx.buyPicks : [];
  const buyPicksOut = rawPicks.map(function(p) {
    const pPct = _num(p.pct);
    const pRank20 = Number(p.rank20) || 0;
    return {
      name: String(p.name || ''),
      code: String(p.code || ''),
      topic: String(p.topic || '').trim(),
      pct: pPct,
      pctText: formatRangePct(pPct),
      days: Number(p.days) || 0,
      rank20: pRank20,
      // 总龙N 标签：与「20日涨幅」toggle 同一份实现（§6），配不上名次的给 ''（§10 不硬造）
      label: totalDragonLabel(pRank20),
      isYizi: !!p.isYizi,
      suspended: !!p.suspended,
      trouble: p.suspended ? '⚠️ 但它今日【停牌】，买不进。'
        : (p.isYizi ? '⚠️ 但它今日【竞价一字涨停】，竞价买不进（要不要打板由你自己定）。' : '')
    };
  }).filter(function(p) { return !!p.name; });
  const bsOn = buyPicksOut.length > 0;
  const bs = bsOn ? buyPicksOut[0] : null;
  // 兼容别名（旧字段还有两处只读消费：落库行的 buySecond / 卖点侧放行）—— 语义 = 第一只替补
  const bsTrouble = bsOn
    ? buyPicksOut.map(function(p) { return p.trouble; }).filter(function(t) { return !!t; }).join('')
    : '（20日涨幅前五还没算出来 / 五只里选不出符合条件的替补 ⇒ 买点侧暂不给出替补）';
  // 五只去留留痕（规则层写进行内说明，判定可追溯，§10）
  const trailText = (function() {
    const arr = (Array.isArray(ebbCtx.buyTrail) ? ebbCtx.buyTrail : []).map(function(t) {
      const lb = totalDragonLabel(Number(t.rank20) || 0);
      return '【' + (lb || '总龙?') + t.name + '】' + String(t.reason || '');
    });
    return arr.join('；');
  })();
  // 「首日 / 二次确认」判定的依据来自哪里 —— 如实写进说明（§10 判定可追溯；⛔ 不静默）
  const firstDayNote = (prev.source === 'table')
    ? ('（昨日状态取自落库判定：' + prev.detail + '）')
    : (prev.source === 'inferred'
      ? ('（昨日落库判定缺失 ⇒ 按行情行推断：' + prev.detail + '）')
      : ('（昨日状态两处都取不到 ⇒ 本次按【可触发】处理，宁可多提醒一次）'));

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
    // ★ [EBB-R20] 阶段：'first' 首次退潮 / 'second' 二次确认退潮（≥2 次事件 ⇒ 本函数返回 null）
    phase: isFirst ? 'first' : 'second',
    phaseTitle: phaseTitle,
    phaseCount: phase.count,
    phaseNote: phaseNote,
    // ★ [EBB-R8] 昨日判定的来源与依据（'table' 落库判定 / 'inferred' 昨日行情行推断 / 'unknown' 取不到）
    firstDay: isFirst,
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
    // ── ★ 买点侧替补【≤2 只】（[EBB-R20] 当日 20日涨幅口径）──
    buyPicks: buyPicksOut,
    buyPicksOn: bsOn,
    buyPickNames: buyPicksOut.map(function(p) { return p.name; }),
    // 五只去留留痕的展示文案（替补块行内说明用，判定可追溯 §10）
    buyTrailText: trailText,
    // 兼容别名（= 第一只替补；落库行 / 卖点放行等旧消费方只读）
    buySecondOn: bsOn,
    buySecondName: bs ? bs.name : '',
    buySecondTopic: bs ? bs.topic : '',
    buySecondPct: bs ? bs.pct : null,
    buySecondPctText: bs ? bs.pctText : '',
    buySecondLabel: bs ? bs.label : '',
    buySecondCode: bs ? bs.code : '',
    buySecondTrouble: bsTrouble,
    // 标题上直接列出那两只是谁（没有则如实说「一只都没有」）
    picksText: picksText.length > 0 ? picksText.join('、') : '（本日无符合条件的票）',
    // ── 文案（§21：模板零计算）──
    headline: '⚠️ ' + phaseTitle + ' · 卖点收紧',
    detail: '市场总龙【' + leaderName + '】（' + topicText + '，20日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 判定为【' + phaseTitle + '】（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。' +
      firstDayNote + phaseNote + '卖点侧：' +
      (picksText.length > 0
        ? ('只有 ' + picksText.join('、') + ' 可以【' + EBB_PICK_TAG + '】（等开盘看分笔，不看占比）；')
        : '今天没有符合条件的【同题材可用龙位】【市场总龙二】；') +
      '其余股票一律【' + SELL_OUT_TAG + '】（含原本标【' + HOLD_TAG + '】的）—— 开盘就走，降低风险。',
    buyHeadline: bsOn
      ? ('⚠️ ' + phaseTitle + ' · 买点替补只有这 ' + buyPicksOut.length + ' 只（' + EBB_SECOND_BUY_TAG + '）')
      : ('⚠️ ' + phaseTitle + ' · 建议空仓 · 不开仓'),
    buyOnlyLabelText: bsOn
      ? ('退潮替补 · 买点只有这 ' + buyPicksOut.length + ' 只（' + phaseTitle + '）')
      : '',
    buyDetail: '市场总龙【' + leaderName + '】（' + topicText + '，20日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ ' + phaseTitle + '，风险高。' + firstDayNote + phaseNote +
      (bsOn
        ? ('买点侧今天【只买替补】（从 20日涨幅总龙一~五里选：先排非主板（创业板/科创板/北交所），' +
           '再排与总龙一同题材，剩下取排名最靠前的前两只）：' +
           buyPicksOut.map(function(p) {
             return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' + p.pctText + '）';
           }).join('、') + '。' + (trailText ? ('五只去留：' + trailText + '。') : '') +
           (bsTrouble ? bsTrouble + ' ' : '') +
           '下方其余入选票一律【' + EBB_NO_BUY_TAG + '】（整段灰化），除替补外没有买点。')
        : ('当天【选不出替补】（' + bsTrouble + '）' + (trailText ? ('五只去留：' + trailText + '。') : '') +
           '下方选股【整体变灰】仅为参考，建议今天不开仓（空仓）。'))
  };
}

/**
 * 【退潮事件计数】—— 「首次 / 二次确认 / 无第三次」的判定（§6：只此一份，⛔ 别在视图或组合式再数一遍）。
 *
 * 用户口径（2026-10-20）：「判断是不是首日要看它最近10天的表现，如果十天内出现首日退潮，
 *   那今天就不能算是首日了，而是确认主线退潮……注意没有第三次了。」
 *
 * ⚠️ 【事件】≠【天数】：总龙连续多日停牌 / 不达标只算一次事件 ——
 *   一条历史记录算「新事件」当且仅当它的【前一交易日】没有同题材的退潮记录
 *   （ebbHistory 的每行都带 prevDate，由组合式用 getPreviousTradingDay 链好；§6 日期口径不进本纯函数）。
 * ⚠️ 计数按【题材】认；题材取不到时退回按【同一只总龙】认（§10 从紧，不乱认亲）。
 * ⚠️ ebbHistory 缺省 / 空 ⇒ 计 0 次（= 首次退潮）—— 与用户拍板「取不到就按首日处理」同一口径。
 *
 * @param {string} topic 今日总龙的题材（可空）
 * @param {string} name 今日总龙名（题材为空时的认亲退路）
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string, ebb:boolean}>|null} history
 * @returns {{count:number, lastDate:string}} count = 近 10 个交易日内的退潮事件数；lastDate = 最近一次的日期
 */
/**
 * 【退潮事件计数】—— 见上方长注释（_ebbPhaseOf 的既有实现）。
 *
 * ★ [EBB-TOPIC-FIX 2026-10-22] 认亲规则改成三段：
 *   ① 今日题材【有效】且该行题材【有效】⇒ 按题材比较（支持 'AI应用,数据中心' 分段串）；
 *   ② 任一侧题材【无效】（空 / 纯数字脏值）⇒ 退回「同一只总龙」认亲；
 *   ③ 都认不上 ⇒ 不算同一事件。
 *   ⛔ 与旧实现的差别只有「脏值时不再直接判不命中」这一条 —— 正是它导致 10-22 误报首次退潮。
 * ★★ [CORE-CAT 2026-10-22] 认亲前两侧都归到【大类】：「文化传媒」与「AI应用」= 同一题材
 *   （⛔ 不归一 ⇒ 10-22 的近 20 日事件数从 2 掉成 0 ⇒ 又变成「首次退潮」）。
 * ★ [EBB-20D 2026-10-22] 窗口 = 近 EBB_EVENT_WINDOW_DAYS（20）个交易日。
 *   ★ 窗口口径由组合式注入 `windowFrom`（= 第 20 个交易日的日期）—— ⛔ 不用「history 里最后 20 条」
 *     来近似：退潮落库表是【按天写】的，没开看板的日子没有行（实测 20 个交易日只有 7 行）
 *     ⇒ 「最后 20 行」可能横跨 40 多个交易日，那样数出来的事件数会偏多（误判「无第三次」）。
 *   `windowFrom` 缺省 ⇒ 退回「按已有日期取最新 20 个」（§11 老调用方零行为变化）。
 */
function _ebbPhaseOf(topic, name, history, coreRes, windowFrom) {
  const t0 = _normTopic(topic, coreRes);
  const n0 = String(name || '').trim();
  const all = (Array.isArray(history) ? history : []).filter(function(r) {
    return r && r.date && !!r.ebb;
  });
  // ── 窗口闸门 ──
  const from = String(windowFrom || '').trim();
  let rows;
  if (from) {
    rows = all.filter(function(r) { return String(r.date) >= from; });
  } else {
    const dateSet = new Set();
    all.forEach(function(r) { dateSet.add(String(r.date)); });
    const winSet = new Set(Array.from(dateSet).sort().slice(-EBB_EVENT_WINDOW_DAYS));
    rows = all.filter(function(r) { return winSet.has(String(r.date)); });
  }
  const hit = function(r) {
    const rt = _normTopic(r.leaderTopic, coreRes);
    if (t0 && rt) return _sameTopicLoose(rt, t0, coreRes);
    return String(r.leaderStock || '').trim() === n0 && !!n0;
  };
  // ⚠️ byDate 必须用【未截断】的 all：窗口第一天那行要看它的 prevDate 是否也在退潮（否则会把
  //   延续日误算成新事件）。prevDate 不在 rows 里 ⇒ 视作「不在退潮」⇒ 该行算新事件 —— 正确。
  const byDate = new Map();
  all.forEach(function(r) { byDate.set(String(r.date), r); });
  let count = 0;
  let lastDate = '';
  rows.forEach(function(r) {
    if (!hit(r)) return;
    const p = r.prevDate ? byDate.get(String(r.prevDate)) : null;
    if (p && hit(p)) return;   // 前一交易日同题材也在退潮 ⇒ 本次是延续，不是新事件
    count++;
    lastDate = String(r.date);
  });
  return { count: count, lastDate: lastDate };
}

/**
 * ★★ [EBB-D1 2026-10-21 用户口径] 【昨日二次确认退潮的题材】—— 次日禁入买点侧（第二十六条）。
 *
 * 用户原话：「主线题材如果昨天已经二次确认退潮了，次日就不要进入买点侧了，也就是说次日即使
 *   这个题材符合平均量比的条件，题材平均量比排名第二，也不应该买了，因为风险很高。其它题材可以。
 *   ……你把买点侧的主线题材入选的票的区域，变成灰色，不用去掉，其它题材不变。」
 * （10-21 实例：AI应用 10-20 二次确认退潮，10-21 它平均量比排第二、慈文传媒进了买点侧 ⇒ 不合理。）
 *
 * 为什么 detectEbbDay 自己答不了这道题：它带「首日闸门 + 无第三次」，昨日已是第二次退潮事件 ⇒
 *   今天必返 null（按平常日子选股）—— 这正是本规则的空档：题材退潮后的第二天，它以「平常题材」
 *   的身份混进买点侧。本函数补上这道闸。
 *
 * 「昨日那笔退潮是不是二次确认」怎么数（⛔ 与 _ebbPhaseOf 同一把尺子，§6 绝不另写一套）：
 *   ① 取【上一交易日】（prevDate，由组合式注入，规则层不碰日期工具）那一行：ebb=false / 无行 ⇒ null；
 *   ② 从昨日往回走【连续同题材退潮日】（事件 ≠ 天数：连续退潮合并成一次事件），找到事件起点 S；
 *   ③ 数 S 之前、同题材的退潮事件次数（_ebbPhaseOf）：恰好 1 次 ⇒ 昨日那笔 = 二次确认 ⇒ 返回题材；
 *     0 次（首次退潮）⇒ 不在本规则内（首次退潮次日本来就由首日闸门/当日判定处理，用户未要求禁入）；
 *     ≥2 次 ⇒ 无第三次 ⇒ 同样不适用。
 *
 * ⛔ 纯函数：只读 ebbHistory（组合式按展示日读回的 tvrb_ebb_days 近 12 行，已带 prevDate 链）。
 * ⛔ ebbHistory 缺省 / 没读到昨日行 ⇒ null（§10：判不出来 ≠ 昨天没退潮，绝不拿「没数据」当「没退潮」
 *    —— 反过来也不行：没有落库行就不禁入，宁可漏禁也不误禁，§11 与既有判定同一取舍）。
 *
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string,
 *          ebb:boolean}>|null} history 近 12 个交易日的退潮判定落库行
 * @param {string} prevDate 展示日的上一交易日（YYYY-MM-DD；组合式注入，⛔ 规则层不自算）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（与 detectEbbDay 同一把尺子）
 * @returns {{topic:string, leaderName:string, since:string}|null}
 *          topic = 昨日二次确认退潮的题材；since = 该次事件的起点日（留痕用）；判不出 ⇒ null
 */
export function secondEbbTopicOfPrevDay(history, prevDate, coreRes, windowFrom) {
  const pd = String(prevDate || '').trim();
  if (!pd || !Array.isArray(history)) return null;
  const rows = history.filter(function(r) { return r && r.date && !!r.ebb; });
  const byDate = new Map();
  rows.forEach(function(r) { byDate.set(String(r.date), r); });
  const y = byDate.get(pd);
  if (!y) return null;                       // 昨天没有退潮判定（或未退潮）⇒ 不禁
  // ★ [EBB-TOPIC-FIX 2026-10-22] 与 _ebbPhaseOf 同一把清洗尺子（纯数字 = 脏值 ⇒ 未知）
  // ★★ [CORE-CAT 2026-10-22] 再归到【大类】（文化传媒 ⇒ AI应用），否则「连续退潮日」在这里断链
  const topic = _normTopic(y.leaderTopic, coreRes);
  const name = String(y.leaderStock || '').trim();
  const hit = function(r) {
    const rt = _normTopic(r.leaderTopic, coreRes);
    if (topic && rt) return _sameTopicLoose(rt, topic, coreRes);
    return String(r.leaderStock || '').trim() === name && !!name;   // 与 _ebbPhaseOf 同一认亲退路
  };
  // ② 从昨日往回走连续同题材退潮日 ⇒ 事件起点（连续退潮日合并为一次事件）
  let start = y;
  for (;;) {
    const p = start.prevDate ? byDate.get(String(start.prevDate)) : null;
    if (p && hit(p)) { start = p; continue; }
    break;
  }
  // ③ 起点之前、同题材的退潮事件次数：恰好 1 ⇒ 昨日这笔是【二次确认】
  const earlier = rows.filter(function(r) { return String(r.date) < String(start.date); });
  const phase = _ebbPhaseOf(topic, name, earlier, coreRes, windowFrom);
  if (phase.count !== 1) return null;
  return { topic: topic, leaderName: name, since: String(start.date) };
}

/**
 * 【昨日二次确认退潮题材 · 买点侧覆盖式改写】（[EBB-D1] 第二十六条的后处理，范式与
 * _applyEbbBuyRules / _applyCashAlertBuyRules 完全同一套 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径：题材【不删、照常列出】（「不用去掉，其它题材不变」），但：
 *   · 动作标签一律换成【退潮不买】（与退潮日同一枚标签 —— 语义同源：题材在退潮，不买）；
 *   · 行尾【持有】/ 仓位槽清空（同一天不可能既「禁入」又「持有」）；
 *   · 逐行说明写明原因（判定可追溯，§10）；
 *   · ⛔ 客观数据一行不动；卖点侧一行不动（用户本轮只说买点侧）。
 *
 * 视觉：整块灰化【不在本函数里做】—— 本函数只在块上挂 `prevEbbGray = true` 旗子，
 *   视图层给该块挂 `.tvrb-prev-ebb-gray`（与 .tvrb-buy-list.tvrb-ebb 同一套灰化值，
 *   ⛔ 不新造第二套灰化视觉；只灰这一个题材块，其它题材块不灰 —— 与整段灰化刻意不同）。
 *
 * ★ 它必须排在退潮 / 分歧 / 空仓提醒三条改写【之后】（调用方保证）：本规则是「按题材」的
 *   覆盖式后处理，优先级解释写进行内说明（它比前三条更具体 —— 针对的是昨日已二次确认的题材）。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks / notes）
 * @param {{topic:string, leaderName:string, since:string}|null} prevSecondEbb
 *        secondEbbTopicOfPrevDay 的返回；null ⇒ 零副作用（§11）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数 ——
 *        块上是细分串（「文化传媒」）、prevSecondEbb.topic 是大类（「AI应用」）⇒ 必须按大类认亲，
 *        ⛔ 不能逐字比较（否则第二十六条在题材名漂移那天静默失效）。
 */
function _applyPrevEbbSecondNoBuy(blocks, prevSecondEbb, coreRes) {
  if (!prevSecondEbb || !prevSecondEbb.topic) return;
  const topic = String(prevSecondEbb.topic).trim();
  const lead = '【' + topic + '】昨日已【二次确认退潮】' +
    (prevSecondEbb.since ? ('（该次退潮事件自 ' + prevSecondEbb.since + ' 起）') : '') +
    ' ⇒ 第二十六条：题材退潮次日禁止买入。';
  (blocks || []).forEach(function(b) {
    if (!b) return;
    const bt = String((b.block && b.block.topic) || b.topic || '').trim();
    if (!_sameTopicLoose(bt, topic, coreRes)) return;
    b.prevEbbGray = true;                   // ★ 视图层据此给该块挂灰化类（只灰这一个题材块）
    if (!Array.isArray(b.notes)) b.notes = [];
    (b.notes).push('⚠️ ' + lead + '本题材今天【不参与买入】—— 即使它平均竞价量比排名靠前' +
      '（风险很高）；股票照常列出供参考（灰化显示），原本的买点信号一律作废，其它题材不变。');
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = EBB_NO_BUY_TAG;      // ★ 覆盖式：与退潮日同一枚标签（语义同源）
      p.buyActionTone = EBB_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号' +
        '一律作废。（等题材重新走强 —— 总龙复牌 / 竞价占比回升 / 平均量比回来 —— 再看买点。）';
    });
  });
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

  // ★★ [EBB-REC-FIX 2026-10-22] 门槛取档必须与 detectEbbDay 的判据②【逐字同源】：那边是
  //   `const leaderIsDragonOne = true`（总龙一 = 20日涨幅全市场第一 ⇒ 恒按龙头档 3.5% 判）。
  //   旧实现这里写的是「按它今日十日龙位取档」⇒ 总龙今日不是龙一（10-22 新华传媒十日口径是龙三）
  //   就落到 2% 档 ⇒ 落库行出现「share=2.0 但 share_fail=false」这种自相矛盾：
  //   同一天 detectEbbDay 判它占比不达标（真实意图），落库却说达标 ⇒ 次日读回判首日直接判错。
  //   🔴 这正是「同一件事两处取档不一致」的伴生缺陷（§6 同一把尺子）。
  const isDragonOne = true;
  const sh = _num(ebbCtx.leaderShare);
  const suspended = !!ebbCtx.leaderSuspended;
  // 与 detectEbbDay 的判据 ② 逐字同源：缺数据（sh === null）⇒ 不判不达标（§10：未知 ≠ 不达标）
  const shareFail = (sh !== null && !passesAuctionShare(sh, isDragonOne));

  return {
    date: d,
    leaderStock: name,
    // ★ [EBB-TOPIC-FIX 2026-10-22] 落库前同样清洗：⛔ 绝不再把「纯数字」（= 误取的成交量）当题材写进表，
    //   否则明天读回来又要靠 _normTopic 兜一次（错值不进库才是根治）。
    leaderTopic: _normTopic(leader.topic),
    leaderPct: _num(leader.pct),
    leaderRank: _num(leader.rank),
    suspended: suspended,
    share: sh,
    shareFail: shareFail,
    // ★ 原始结论（不带首日闸门）—— 次日判「昨天这只票是不是已经在坏状态」就读它
    ebb: !!(suspended || shareFail),
    // ⚠️ 买点侧替补只在【今天确实触发退潮规则】时才有意义（ebb === null ⇒ 不放）
    //   [EBB-R20] 起为 ≤2 只，落库格式 = 名字「、」连接（buy_second_pct = 第一只的 20日涨幅）
    buySecond: (ebb && Array.isArray(ebb.buyPickNames) && ebb.buyPickNames.length > 0)
      ? ebb.buyPickNames.join('、')
      : ((ebb && ebb.buySecondName) ? String(ebb.buySecondName) : ''),
    buySecondPct: (ebb && _num(ebb.buySecondPct) !== null) ? _num(ebb.buySecondPct) : null,
    source: 'tvrb-board'
  };
}

/** 退潮日【允许看分笔卖】的股票名集合（§6：唯一的取名实现，判定与改写共用） */
function _ebbEligibleNames(ebb) {
  const set = new Set();
  if (!ebb) return set;
  if (ebb.siblingName) set.add(ebb.siblingName);
  if (ebb.secondName) set.add(ebb.secondName);
  return set;
}

/** 退潮日【买点侧替补】的股票名集合（卖点侧放行用：今天要买的票不能同时被要求竞价清仓） */
function _ebbBuyPickNames(ebb) {
  const set = new Set();
  if (!ebb) return set;
  (ebb.buyPickNames || []).forEach(function(n) { if (n) set.add(String(n)); });
  // 兼容旧消费方：buySecondName 恒在 buyPickNames 里（§6 同一来源，这里再兜一次不亏）
  if (ebb.buySecondName) set.add(String(ebb.buySecondName));
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
 * @param {Set<string>|null} [keepNames] [EBB-R20b] 额外放行集（二次确认 + 常规选股时 = 今日买点名单；
 *        缺省 null ⇒ 行为逐字不变）—— 与「卖点候选放行」同一不变式：今天要买的票不清仓
 */
function _applyEbbSellRules(sell, ebb, keepNames) {
  if (!ebb) return;
  const elig = _ebbEligibleNames(ebb);
  const buyPicks = _ebbBuyPickNames(ebb);
  // ★ [EBB-R20b 2026-10-20] 可选放行集（缺省 null ⇒ 行为逐字不变，§11）：
  //   二次确认退潮 + 常规选出了补涨题材时 = 【今日买点名单】—— 这些票今天真要买，
  //   若昨天买过（在卖点候选里），保持 buildSellPlan 自己的结论（持有 / 先卖后买），
  //   ⛔ 不改写成【竞价卖】（同一天不可能既「今天要买」又「竞价清仓」—— 与替补放行同一不变式）。
  if (keepNames) keepNames.forEach(function(n) { buyPicks.add(n); });
  const topicText = ebb.leaderTopic || '—';
  const lead = '【' + ebb.phaseTitle + '】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，20日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText + ' ⇒ 题材退潮：';

  (sell || []).forEach(function(g) {
    (g.items || []).forEach(function(it) {
      if (!it || !it.name) return;
      const name = String(it.name);
      // ★ [EBB-R8 2026-10-14] 放行【今天的替补买点】（[EBB-R20] 起为 ≤2 只）：
      //   它们如果同时在卖点侧（昨天买过），按本文件退潮口径本来会被改成【竞价卖】——
      //   那就与买点侧的【退潮替补买】正面矛盾（同一天不可能既「今天要买」又「竞价清仓」）。
      //   ⇒ 它们保持 buildSellPlan 自己的结论（今天又进买点 ⇒ 持有）：留着，并在开盘买点加仓。
      if (buyPicks.has(name)) return;
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
          '】—— 退潮日只按「是不是那两只有资格等开盘卖的票」二分。）';
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
           '（退潮日【不看占比】、也不因它原本标【' + HOLD_TAG + '】而留下。）');
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
 * 涨幅 → 「+35.21%」两位小数文案（★ 只用于【说明文字】，⛔ 不参与任何判定，§21 文案在 Logic 层拼好）。
 *
 * ⚠️ 为什么不复用 `formatRangePct`：那个是行上「十日涨幅」列的展示口径（**取整**，+35%），
 *   而说明区要跟用户核对「9:26 那一刻到底是多少」—— 取整会让 +35.21 与 +36.40 都显示成 +35%/+36%，
 *   看着像同一档，反而更难核对。缺值 ⇒ '—'（§10 不补 0）。
 * @param {number|string|null} v
 * @returns {string}
 */
function _pct2(v) {
  const n = _num(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/**
 * 【退潮日 · 买点侧替补（≤2 只）】构造（第八轮建立 · [EBB-R20 2026-10-20 用户口径] 本轮升级）。
 *
 * 用户口径（本轮原话）：「从20日涨幅中的总龙一到总龙五选出两只排名靠前的。而且是不同总龙一题材的
 *   股票……也就是从这五只中，要判断是不是创业板，科创板，北交所等非主板的股票，如果是先排除，
 *   剩下的看是不是和总龙一是同题材，是也排除，剩下的就选排名靠前的那两只。」
 * （替补名单与五只去留由采集层 _ebbCtxOf 选好 / 留痕，本函数只负责【组装成可渲染的买点块】。）
 *
 * 产出 = 一个【常规买点块】（形状与 _buildBlock 完全一致）里放替补的 1~2 只票 ——
 *   ⇒ 它可以直接喂给 TvrbBuyBlock 渲染，也可以进 `buy.ebbSecond` 槽位让四个装饰器统一挂客观数据
 *   （量比趋势 / 名次变化 / 封单额 / 停牌标记，见 decision-collect#_buyBlocksOf）。
 *
 * ⚠️ 顺序（决定了本函数里那两次「覆盖」的必要性）：
 *   ① 先 `finishBuyBlock` —— 它不是用来给动作标签的，而是为了把【客观数据 + 原始买点信号】
 *      （竞价涨幅徽标 / 占比 + 门槛 / 量比方向 / 仓位 / 持有 / 逐行说明）一次算齐；
 *   ② 再【覆盖】动作标签为【退潮替补买】（用户明确要专属标签）并把原始信号写进行内说明
 *      —— 覆盖而不改写逻辑：占比达标与否这条结论一枚不丢，只是换了标签的外观。
 *   ⛔ 绝不改 finishBuyBlock 内部（那是决策看板与本看板共用的实现，§6 红线）。
 *
 * ⚠️ 为什么 `block.block` 用【合成的题材头】而不是替补票所在的真实题材块：
 *   真实题材块的 `rank` 是「题材排名圆点」，挂在这一行上会被读成本行的名次；
 *   而且本行第一行标题要写清楚它是什么（退潮替补 / 20日涨幅总龙一~五里选出来的），不是某个题材。
 *   ⚠️ `members` 放【真实成员行】—— `finishBuyBlock` 的徽标反查（_decorateAucBadge）
 *     要按名字从 members 里取 aucPct / aucShare / volRatioDelta / code。
 *   ⚠️ 替补票【不在今日列表】（20日补位票 / 停牌票）时拿不到成员行 ⇒ 该行照样给出
 *     （名字 / 代码 / 20日涨幅 / 总龙N 都是采集层的事实），只是少几个竞价徽标，并在说明里如实标注。
 *
 * @param {object} ebb detectEbbDay 的返回（必须 buyPicksOn=true）
 * @param {Array} list rankDecisionTopics 的返回 —— 用来找替补票的【真实成员行】（含代码 / 占比 / 量比）
 * @param {object} fOpts finishBuyBlock 的入参（与正常题材块同一份，保证标记口径一致）
 * @returns {object|null} 常规买点块；一只替补都没有 ⇒ null（§10 不猜）
 */
function _buildEbbPicksBlock(ebb, list, fOpts) {
  if (!ebb || !ebb.buyPicksOn || !Array.isArray(ebb.buyPicks) || ebb.buyPicks.length === 0) return null;
  const picks = [];

  // 真实成员行：先按【它所属题材块】找（同名的其它题材成员不存在），找不到再全题材按名字兜一次
  const _memberOf = function(name, topic) {
    let member = null;
    (list || []).forEach(function(b) {
      if (member) return;
      if (topic && String(b && b.topic || '').trim() !== topic) return;
      (b.members || []).forEach(function(m) {
        if (!member && m && String(m.name || '').trim() === name) member = m;
      });
    });
    if (!member) {
      (list || []).forEach(function(b) {
        if (member) return;
        (b.members || []).forEach(function(m) {
          if (!member && m && String(m.name || '').trim() === name) member = m;
        });
      });
    }
    return member;
  };

  const members = [];
  ebb.buyPicks.forEach(function(p, idx) {
    const member = _memberOf(p.name, p.topic);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    picks.push({
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      // 代码优先取采集层给的（与 members 同一个值，§6 只搬运）
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      // ⚠️ 预置：_decorateAucBadge 之前 _markHold 要读它（与 _buildBlock 同一做法）；
      //    替补票不在今日列表 ⇒ member 为 null ⇒ 只能按缺数据处理（§10 不猜）
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    });
  });

  const namesText = ebb.buyPicks.map(function(p) {
    return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' + p.pctText + '）';
  }).join('、');

  const notes = [
    '⚠️ 本行【不是】题材选股的结果，而是【' + ebb.phaseTitle + '的退潮替补】：市场总龙【' + ebb.leaderName + '】' +
      ebb.whyText + ' ⇒ 买点侧只留替补（总龙自己今天不买）。',
    '【替补怎么选】= 从【20日涨幅】的总龙一到总龙五里：先排非主板（创业板/科创板/北交所），' +
      '再排与总龙一同题材，剩下的取排名最靠前的前两只 —— 本日 = ' + namesText + '。',
    (ebb.buyTrailText ? ('五只去留（判定可追溯）：' + ebb.buyTrailText + '。') : ''),
    '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）——' +
      '停牌票按它自己的交易日回溯、靠补位照样进榜，这正是总龙用 20日口径的原因。'
  ].filter(function(s) { return !!s; });
  if (ebb.buySecondTrouble) notes.push(ebb.buySecondTrouble);

  const block = {
    // ── ① 决策看板形状的字段（finishBuyBlock / 装饰器要读的）──
    block: {
      topic: '退潮替补 · ' + (ebb.leaderTopic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      // ★ 真实成员行 —— 徽标 / 占比 / 量比方向 / 代码都从它反查（见函数头注释）
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: ebb.phaseTitle + '【退潮替补】：' + namesText +
      ' —— 总龙【' + ebb.leaderName + '】' + ebb.whyText +
      ' ⇒ 今天只买这 ' + ebb.buyPicks.length + ' 只替补（其余入选票一律【' + EBB_NO_BUY_TAG + '】）',
    mode: 'ebb',
    ruleNo: EBB_SECOND_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: notes,

    // ── ② 本看板自己的平铺字段（组件直接读）──
    topic: '退潮替补 · ' + (ebb.leaderTopic || '—'),
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'ebb',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    // ★ 供视图判断「这是退潮替补那一行」（避免模板靠 tier 字符串比较，§21）
    isEbbSecond: true
  };

  // ① 让它按决策看板的同一份实现把【客观数据 + 原始买点信号】算齐
  finishBuyBlock(block, fOpts);
  // ② 再覆盖动作标签为专属的【退潮替补买】（用户拍板），并原始信号原文留进行内说明
  const lead = '【' + ebb.phaseTitle + ' · 退潮替补】市场总龙【' + ebb.leaderName + '】' + ebb.whyText +
    ' ⇒ 今天买点侧只有替补这几只（【' + EBB_SECOND_BUY_TAG + '】）：';
  (block.picks || []).forEach(function(p) {
    const me = ebb.buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = EBB_SECOND_BUY_TAG;      // ★ 覆盖式：本行唯一那枚标签
    p.buyActionTone = EBB_SECOND_BUY_TONE;
    p.holdTag = '';                           // 与「今天要买」互斥（原本的持有 / 先卖后买让路）
    p.position = '';
    p.actionNote = lead + '它是【' + ((me && me.label) || '') + p.name + '】= 20日涨幅全市场排名第 ' +
      ((me && me.rank20) || '—') + ' 的替补（' + ((me && me.pctText) || '') +
      '，' + ((me && me.topic) || '—') + '）。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      (me && me.trouble ? (' ' + me.trouble) : '') +
      ' 退潮日不按常规买点罗列：只留替补这几只，其余入选票一律【' + EBB_NO_BUY_TAG + '】（灰色）。';
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
  const lead = '【' + ebb.phaseTitle + '】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，20日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText +
    ' ⇒ 判定为【' + ebb.phaseTitle + '】（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。' +
    '题材退潮【今天不买】：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';                      // 仓位槽（本看板此处只会是【持有】）
      p.holdTag = '';                       // 行尾【持有】
      p.buyActionTag = EBB_NO_BUY_TAG;      // ★ 覆盖式：买点行上唯一那枚「买」的标签
      p.buyActionTone = EBB_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 退潮日除【' + EBB_SECOND_BUY_TAG + '】替补外没有其它买点，' +
        '原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废。' +
        '（等题材重新走强 —— 总龙复牌 / 竞价占比回升 / 平均量比回来 —— 再看买点。）';
    });
  });
}

/**
 * 【空仓提醒 · 买点改写】（覆盖式后处理 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径（2026-10-16 第十六轮原话）：
 *   「题材量比有这个提示时：⚠️ 今日建议空仓 · 不开仓……这个提示下的买点侧，全部变成灰色
 *     （卖点侧不变），买点侧股票标签改成"分歧日不买"。那个灰色的样式类似 10月13日的退潮首日
 *     那个买点侧整版灰色，你可以参考下。其它不变。」
 *
 * 判据 = `cashAlert.show`（= 能入选的排名第一题材 平均竞价量比 < TVRB_CASH_ALERT_AVG_VR）。
 *   ⛔ 本函数【只读】cashAlert 那个已算好的对象，⛔ 绝不自己去重算一遍量比门槛（§6 判据唯一）。
 *
 * 与 _applyEbbBuyRules 同一范式（先按原口径算完，再【覆盖】买点行上那几枚「买」的字段）：
 *   · `p.buyActionTag` / `p.buyActionTone` —— 竞价买 / 尾盘买 / 先卖后买 / 下杀买 / 补涨 / 龙一字持有
 *     ⇒ 一律换成【分歧日不买】；
 *   · `p.holdTag` —— 行尾【持有】（今天又进买点）
 *   · `p.position` —— 仓位槽（本看板只有「昨天真买过 ⇒ 持有」会落在这里）
 * ⛔ 只动这三处；题材级的【昨有买入】/【N 次入选】是【历史统计标记】而不是「今天的买点动作」，保留不动。
 * ⛔ 一切【客观数据】照旧：十日涨幅 / 竞价涨幅 / 竞价量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 空仓提醒只改「今天买不买」，不篡改行情事实。
 * ⛔ 【卖点侧】一行不动（用户「卖点侧不变」）。
 * ⛔ 【整段灰化】不在本函数里做：视觉由视图层挂同一个 `.tvrb-ebb` 类表达
 *   （与退潮首日【完全同一套】灰化视觉，用户「你可以参考下」，⛔ 不新造第二套 CSS）。
 * ⛔ 停牌票【照旧改写】：停牌事实由【停牌】小标 + 去色 CSS 表达（判定只有 suspend.js 一处，§6），
 *   本纯函数不重复判一遍。
 *
 * ★ 优先级（★ 调用方保证，见 buildTopicVolRatioPlan）：退潮首日 > 空仓提醒。
 *   两者【可能同时成立】（退潮日的空仓标语本来就是走退潮口径）⇒ 退潮首日走【退潮不买】，
 *   本函数只在【非退潮日】命中空仓提醒时才介入。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks）
 * @param {object|null} cashAlert buildCashAlert 的返回（show=false ⇒ 直接返回，⛔ 零副作用）
 */
function _applyCashAlertBuyRules(blocks, cashAlert) {
  if (!cashAlert || !cashAlert.show) return;
  const lead = '【空仓提醒】能入选的排名第一题材【' + cashAlert.topic + '】平均竞价量比 ' +
    cashAlert.avgVolRatioText + ' ＜ ' + cashAlert.threshold +
    ' ⇒ 题材退潮（最强的题材量比都这么低，当天什么票都容易走弱）· 分歧日：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';                        // 仓位槽（本看板此处只会是【持有】）
      p.holdTag = '';                         // 行尾【持有】
      p.buyActionTag = CASH_NO_BUY_TAG;       // ★ 覆盖式：买点行上唯一那枚「买」的标签
      p.buyActionTone = CASH_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 分歧日的买点信号一律作废，原本的【' + HOLD_TAG + '】/ 竞价买 / ' +
        '尾盘买 / 先卖后买 等买点信号不再作数。' +
        '（等题材重新走强 —— 平均竞价量比回到 ' + TVRB_CASH_ALERT_AVG_VR + ' 以上 —— 再看买点。）' +
        '⚠️ 下方股票仍按原规则【照常列出】，供你参考。';
    });
  });
}

/**
 * ══ [DIVERGE 2026-10-20 用户口径] 总龙首次分歧日 · 买点侧改写（覆盖式后处理）══════════════
 *
 * 用户原话：「题材量比买点侧只有市场总龙一，还有其它不同题材的两只高标股票（20日涨幅前五的），
 *   同题材的不要……最多三只。」⇒ 分歧日的【其余入选票】今天不开新仓：动作标签一律换成
 *   【总龙分歧不买】（照常列出 + 整段灰化 —— 视觉走 cashAlert.show 那一条既有通道）。
 *
 * ⛔ 与 _applyEbbBuyRules / _applyCashAlertBuyRules 同一范式：先按原口径算完，再覆盖那三处
 *   （buyActionTag / holdTag / position），⛔ 绝不改 finishBuyBlock 内部（决策看板共用，§6）。
 * ⛔ 客观数据一行不动；卖点侧一行不动（用户本轮未提卖点）。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组
 * @param {object} ld leaderDiverge（todayFirst=true 才会被调用方传入）
 */
function _applyDivergeNoBuyRules(blocks, ld) {
  if (!ld) return;
  const lead = '【总龙首次分歧】市场总龙一【' + (ld.leaderName || '—') + '】' +
    (ld.firstBoardYmd ? ('自首板 ' + ld.firstBoardYmd + ' 以来') : '') +
    '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = DIVERGE_NO_BUY_TAG;
      p.buyActionTone = DIVERGE_NO_BUY_TONE;
      p.actionNote = lead +
        '分歧日的买点侧【只有总龙一（下杀买）+ 不同题材的主板高标（≤2 只）】，本股今天【不开新仓】——' +
        '原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废。' +
        '⚠️ 下方股票仍按原规则【照常列出】，供你参考。';
    });
  });
}

/**
 * ══ [DIVERGE 2026-10-20 用户口径] 总龙首次分歧日 · 买点块（总龙一 + 跟随高标 ≤2 只）════════
 *
 * 用户原话：「市场总龙一，第一次出现分歧的时候，是买点……一般开盘它会下杀，然后反弹，
 *   所以标签应该是下杀买。也就是题材量比买点侧只有市场总龙一，还有其它不同题材的两只高标股票
 *   （20日涨幅前五的），同题材的不要……最多三只。」
 *
 * 结构与 _buildEbbPicksBlock 同款（§6 两步走）：
 *   ① 真实成员行（今日题材成员）反查客观数据，凑不齐的按缺数据渲染（§10）；
 *   ② finishBuyBlock 按决策看板同一份实现算齐客观数据与原始买点信号，
 *      然后【覆盖式】把动作标签换成 总龙一【下杀买】/ 高标【高标跟随买】，原文留进行内说明。
 *
 * @param {object} ld 组合式下发的 leaderDiverge（todayFirst=true；含 top5 / firstBoardYmd 等）
 * @param {Array} list 今日题材块（rankDecisionTopics 的返回，成员行 = 客观数据来源）
 * @param {object} fOpts finishBuyBlock 的选项（与常规块共用同一份，§6）
 * @returns {object|null} null = 不渲染（调用方保证 todayFirst 才调）
 */
function _buildDivergeBuyBlock(ld, list, fOpts) {
  if (!ld || !ld.todayFirst || !ld.leaderName) return null;
  const sel = pickDivergeFollowers(ld.top5 || [], ld.leaderName, ld.leaderTopic || '');
  const buyPicks = [{ name: ld.leaderName, label: '总龙一', topic: ld.leaderTopic || '',
    code: ld.leaderCode || '', pct: ld.leaderPct, pctText: ld.leaderPctText || '',
    rank20: 1, isDip: true }].concat(sel.followers.map(function(c) {
      return { name: c.name, label: '总龙' + (c.rank20 || '—'), topic: c.topic || '',
        code: c.code || '', pct: c.pct, pctText: (isFinite(Number(c.pct)) ? Number(c.pct).toFixed(2) + '%' : ''),
        rank20: c.rank20, isDip: false };
    }));

  // 真实成员行：先按【它所属题材块】找，找不到再全题材按名字兜一次（与替补块同一份查找，§6 同法）
  const _memberOf = function(name) {
    let member = null;
    (list || []).forEach(function(b) {
      if (member) return;
      (b.members || []).forEach(function(m) {
        if (!member && m && String(m.name || '').trim() === name) member = m;
      });
    });
    return member;
  };

  const members = [];
  const picks = buyPicks.map(function(p, idx) {
    const member = _memberOf(p.name);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    return {
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    };
  });

  const namesText = buyPicks.map(function(p) {
    return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' +
      (p.pctText || '—') + '）';
  }).join('、');
  const trailText = sel.trail.map(function(t) {
    return t.name + '（' + t.reason + '）';
  }).join('；');

  const block = {
    block: {
      topic: '总龙首次分歧 · 买点',
      rank: null,
      count: null,
      yiziCount: null,
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: '【总龙首次分歧】市场总龙一【' + ld.leaderName + '】' +
      (ld.firstBoardYmd ? '自首板 ' + ld.firstBoardYmd + ' 以来' : '') +
      '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日买点 = 总龙一（下杀买）+ 不同题材主板高标 ≤2 只：' +
      namesText,
    mode: 'diverge',
    ruleNo: DIVERGE_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '⚠️ 本行【不是】题材选股的结果，而是【总龙首次分歧】的买点：总龙一连续上涨后首次竞价低开，' +
        '一般开盘下杀然后反弹 ⇒【下杀买】（别在竞价追）；同时它只会带动【不同题材】的主板高标' +
        '（20日涨幅前五里选，同题材的今天跌得厉害），最多两只。',
      '【高标怎么选】= 从【20日涨幅】总龙二~总龙五里：先排非主板（创业板/科创板/北交所），' +
        '再排与总龙一同题材，剩下的取排名最靠前的前两只 —— 本日 = ' + namesText + '。',
      (trailText ? '五只去留（判定可追溯）：' + trailText + '。' : ''),
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）。' +
        '题材退潮日（如有）优先走退潮规则，本规则不叠加。',
      '★ 术语对照：首板 = 20 日内第一个涨停日（分歧计数从它起算）；首次分歧 = 首板后首次竞价涨幅 < 0；' +
        '分歧转一致 = 分歧日后再度涨停（本轮仅记录，暂不参与买点）。'
    ].filter(function(s) { return !!s; }),

    topic: '总龙首次分歧 · 买点',
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'diverge',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    isDiverge: true
  };

  // ① 客观数据 + 原始买点信号算齐（决策看板同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖式：动作标签换成分歧专属（下杀买 / 高标跟随买），原文留行内说明
  (block.picks || []).forEach(function(p) {
    const me = buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = (me && me.isDip) ? DIVERGE_DIP_TAG : DIVERGE_FOLLOW_TAG;
    p.buyActionTone = DIVERGE_BUY_TONE;
    p.holdTag = '';
    p.position = '';
    p.actionNote = (me && me.isDip)
      ? ('【总龙首次分歧 · 下杀买】市场总龙一【' + p.name + '】自首板 ' + (ld.firstBoardYmd || '—') +
        ' 以来首次竞价低开（' + (ld.aucPctText || '—') + '）—— 一般开盘下杀然后反弹，等下杀再买、别在竞价追。' +
        (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : ''))
      : ('【总龙首次分歧 · 高标跟随买】它是【' + ((me && me.label) || '') + p.name + '】= 20日涨幅全市场第 ' +
        ((me && me.rank20) || '—') + '（' + ((me && me.pctText) || '—') + '，' + ((me && me.topic) || '—') +
        '），与总龙一不同题材 ⇒ 分歧日跟着总龙一走。' +
        (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : ''));
  });
  return block;
}

/**
 * [DIVERGE] 分歧日的大字标语（接管 cashAlert 的顶栏 —— 与退潮接管同一形状，§6 同一消费通道）。
 * @param {object} ld leaderDiverge
 * @param {number} n 分歧买点只数（总龙一 + 跟随高标）
 */
function _buildDivergeCashAlert(ld, n) {
  return {
    show: true,
    topic: ld.leaderTopic || '',
    rank: null,
    avgVolRatio: null,
    avgVolRatioText: '—',
    threshold: TVRB_CASH_ALERT_AVG_VR,
    headline: '⚠️ 市场总龙一【' + ld.leaderName + '】首次分歧 · 分歧买点只有这 ' + n + ' 只（下杀买）',
    detail: '市场总龙一【' + ld.leaderName + '】' + (ld.leaderTopic ? '（' + ld.leaderTopic + '）' : '') +
      '自首板 ' + (ld.firstBoardYmd || '—') + ' 以来首次竞价低开（' + (ld.aucPctText || '—') +
      '）⇒ 首次分歧。分歧日买点侧只有：总龙一（下杀买）+ 不同题材的主板高标（20日涨幅前五，≤2 只）。' +
      '其余入选票照常列出但今天不开新仓（总龙分歧不买）；卖点侧不变。' +
      '⚠️ 若当天同时命中【题材退潮】，退潮规则优先，本规则让位。'
  };
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
 * @param {Map} dragonMap 龙位名册（rankDragons / rankDragonsWithPctMap 的返回）
 * @param {Map<string,{pct:number|null}>} [pctMap] ★ [TVRB-926] 【9:26 口径】的区间涨幅
 *        （readAuctionLegRangeMap 的返回）—— 有它时，行上的十日涨幅取它（与龙位同源），
 *        ⛔ 缺这只票 ⇒ 退回成员自带的 pct（§10 不补 0，理由见 decision-rules#rankDragonsWithPctMap）。
 * @returns {Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                  aucVolRatio:number|null, aucShare:number|null, rank:number}>}
 */
function _dragonCandidates(block, dragonMap, pctMap) {
  const dm = dragonMap || new Map();
  const out = [];
  ((block && block.members) || []).forEach(function(m) {
    if (!m || !m.name) return;
    const d = dm.get(m.name);
    const rank = (d && d.rank) ? d.rank : null;
    if (rank === null) return;   // 无龙位（创业板 / 科创板）⇒ 不参与本看板选股（与决策看板同口径）
    // ★ [TVRB-926 2026-10-14] 十日涨幅 = 【9:26 口径】那份（与上面算龙位用的是同一份，§6）：
    //   ⛔ 绝不让「龙一」的标签配着收盘口径的数值 —— 那是最难查的一种内部不一致。
    const p926 = pctMap ? readRangePct(pctMap, m.name) : null;
    out.push({
      name: m.name,
      isYizi: !!m.isYizi,
      pct: (p926 === null) ? _num(m.pct) : p926,
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
 * ★★ [TVRB-926-FACT 2026-10-24 用户口径 · 第二次修正] 买点侧说明区：只写【口径时间 + 涨幅 + 第几名】，⛔ 不解释。
 *
 * 用户原话（对上一版说明的直接反馈，逐字）：
 *   「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，因为一般都是早上
 *     选出来，收盘看的时候就不一样的，所以你在说明文字那里说明，它排名第几名（我说有入选的时候）
 *     你不要解释，在上面说明时间他们的涨幅是多少排名第几就行了」
 *
 * ⇒ 本函数与上一版的差别【只在于文案】，判据一行没改：
 *   · 删掉「原因：十日涨幅的今天那根腿 15:00 后被换成收盘涨幅（第二十三条）」这类解释；
 *   · 删掉「⛔ 选股只认龙位 / ⛔ 不是按竞价量比高低」这类辩解；
 *   · 只留事实：`〔9:26 竞价口径〕X +35.21% 第 2 名（选入）`、`〔收盘口径〕Y +36.40% 第 2 名`。
 *
 * 根因（实测 9-24 房地产组，6 只 ⇒ 中档只取 1 只）：
 *   · 买点侧按【早上 9:26 竞价口径】的龙位选股（[TVRB-926] rankDragonsWithPctMap）——
 *     大亚圣象 龙一（竞价 +10.03% 一字，买不进已顺延）、**华远控股 龙二**、我爱我家 龙三、
 *     世联行 龙四、三峡新材 龙五、绿地控股 龙六 ⇒ 取龙二 = 华远控股；
 *   · 收盘后组内重排成：大亚圣象 龙一、**世联行 龙二**、…、华远控股 龙五。
 *   ⇒ 说明区把两个口径的【数值 + 名次】并列摆出来，用户自己一眼核对（⛔ 不再替用户下结论）。
 *
 * 发声条件（§11 零行为变化）：只有【真正出现差异】时才追加一条说明 ——
 *   9:26 口径与收盘口径的龙位完全一致时，本函数一个字都不写。
 *
 * @param {object} blk _buildBlock 的返回（含 block.members / picks / notes）；
 *        picks[].pct 已是【9:26 口径】（见 _dragonCandidates），picks[].dragonRank = 9:26 名次
 * @param {Map} closeDragonMap 收盘口径的龙位名册（= rankDragons 的返回，项含 pct）；
 *        缺省 / 空 ⇒ 无可比 ⇒ 不发声（§10 不猜「它收盘是龙几」）
 */
function _appendDragonDriftNote(blk, closeDragonMap, byOrder) {
  if (!blk || !blk.block || !Array.isArray(blk.picks) || blk.picks.length === 0) return;
  if (!closeDragonMap || typeof closeDragonMap.get !== 'function' || closeDragonMap.size === 0) return;
  const topic = String(blk.block.topic || '').trim();
  const pickedNames = new Set();
  const aucFacts = [];        // 〔9:26 竞价口径〕被选中的那只/那几只：涨幅 + 名次
  const closeFacts = [];      // 〔收盘口径〕被选中的 + 收盘排得更前却没轮到的
  let drift = false;
  let bestPickedClose = Infinity;

  blk.picks.forEach(function(p) {
    const nm = String((p && p.name) || '').trim();
    if (!nm) return;
    pickedNames.add(nm);
    const buyRank = Number(p && p.dragonRank);
    if (isFinite(buyRank) && buyRank > 0) {
      aucFacts.push({ name: nm, pct: p.pct, rank: buyRank, picked: true });
    }
    const c = closeDragonMap.get(nm);
    if (!c || !c.rank) return;
    if (String(c.topic || '').trim() !== topic) return;   // 换题材的龙位不可比（§10）
    const closeRank = Number(c.rank);
    if (!isFinite(closeRank) || closeRank <= 0) return;
    if (closeRank < bestPickedClose) bestPickedClose = closeRank;
    closeFacts.push({ name: nm, pct: c.pct, rank: closeRank, picked: true });
    if (isFinite(buyRank) && buyRank > 0 && closeRank !== buyRank) drift = true;
  });
  if (!drift) return;   // §11：两个口径完全一致 ⇒ 一个字都不多写

  // 收盘口径下排在「被选中的那只」前面、却没被选中的同题材成员（= 用户会追问的那几只）
  (blk.block.members || []).forEach(function(m) {
    const nm = String((m && m.name) || '').trim();
    if (!nm || pickedNames.has(nm)) return;
    const c = closeDragonMap.get(nm);
    if (!c || !c.rank) return;
    if (String(c.topic || '').trim() !== topic) return;
    const closeRank = Number(c.rank);
    if (!isFinite(closeRank) || closeRank >= bestPickedClose) return;
    closeFacts.push({ name: nm, pct: c.pct, rank: closeRank, picked: false });
  });

  const _fact = function(f) {
    return f.name + ' ' + _pct2(f.pct) + ' 第 ' + f.rank + ' 名' + (f.picked ? '（选入）' : '');
  };
  closeFacts.sort(function(a, b) { return a.rank - b.rank; });

  blk.notes = Array.isArray(blk.notes) ? blk.notes : [];
  // ★ [SMALL-TOPIC 2026-10-24] 收紧档【不是】按龙位选股（按十日涨幅前十选）⇒ 括号里那句必须换：
  //   ⛔ 照抄「并按它选股」会与该块的实际情况相反（用户对文案与实际不一致特别敏感）。
  const leadLabel = byOrder
    ? 'ℹ️ 本题材龙位（买点侧按【9:26 竞价口径】排；本块按「十日涨幅前十」取票，见上一条）：'
    : 'ℹ️ 本题材龙位（买点侧按【9:26 竞价口径】排、并按它选股）：';
  blk.notes.push(leadLabel +
    '〔9:26 竞价口径〕' + aucFacts.map(_fact).join('；') + '。' +
    '〔收盘口径〕' + (closeFacts.length > 0 ? closeFacts.map(_fact).join('；') : '—') + '。');
}

/**
 * ★★ [R20-926 2026-10-24 用户口径] 买点侧【20日涨幅通道】的入选票：把「9:26 那一刻的涨幅 + 名次」写出来。
 *
 * 用户原话（逐字）：
 *   「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，因为一般都是
 *     早上选出来，收盘看的时候就不一样的，所以你在说明文字那里说明，它排名第几名（我说有入选的时候）
 *     你不要解释，在上面说明时间他们的涨幅是多少排名第几就行了」
 *
 * 覆盖范围（= 买点侧全部走 20日涨幅 的票，别漏）：
 *   · `out.ebbBuy`   —— 退潮首日的替补（总龙二~五，第二十六条）；
 *   · `out.newDragon`—— 切换日的新龙（前八里挑，第二十八条）。
 *   ⛔ 不含十日涨幅通道（那是第二十九条，口径已在 `_buildRange10BackupBlock` 里标好）。
 *
 * 文案纪律（★ 用户明确要求「你不要解释」）：
 *   · 只写「〔口径时间〕名称 涨幅 第几名」，⛔ 不写原因、⛔ 不写「这是正常的」这类辩解；
 *   · 两个口径并列摆出来（9:26 竞价 / 收盘），用户自己核对；
 *   · §10：`aucMap` 里没有这只票（该日 20 日涨幅的 9:26 口径判不出）⇒ **一行都不写**，
 *     ⛔ 绝不拿收盘口径冒充、⛔ 不猜一个名次；
 *   · §11：`aucMap` 缺省（组合式没注入 / 没读到）⇒ 本函数直接返回，一个字都不多写。
 *
 * @param {object} out buildTopicVolRatioPlan 的产出（读 ebbBuy / newDragon / notes）
 * @param {Map|null} aucMap range20-auction-leg#readAuctionLegRange20Rank 的返回（name -> {pct, days, rank}）
 * @param {object|null} ebbCtx 采集层的事实（用来取那只票的【收盘口径】名次 rank20）
 */
function _appendRange20AucNote(out, aucMap, ebbCtx) {
  if (!out || !aucMap || typeof aucMap.get !== 'function' || aucMap.size === 0) return;
  // 收盘口径的名次：top5 / newDragonPool 的每一项都带 rank20（= 20日涨幅名次，§6 同一份事实）
  const closeInfo = new Map();
  const _put = function(arr) {
    (Array.isArray(arr) ? arr : []).forEach(function(t) {
      const nm = String((t && (t.name || t.stock)) || '').trim();
      if (!nm || closeInfo.has(nm)) return;
      closeInfo.set(nm, { pct: _num(t.pct), rank: Number(t.rank20) || null });
    });
  };
  if (ebbCtx) { _put(ebbCtx.newDragonPool); _put(ebbCtx.top5); }

  const rows = [];
  const seen = new Set();
  [out.ebbBuy, out.newDragon].forEach(function(blk) {
    (blk && Array.isArray(blk.picks) ? blk.picks : []).forEach(function(p) {
      const nm = String((p && p.name) || '').trim();
      if (!nm || seen.has(nm)) return;
      const a = aucMap.get(nm);
      if (!a) return;                     // §10：这只票 9:26 口径判不出 ⇒ 不写（⛔ 不猜名次）
      const aucRank = Number(a.rank) || null;
      if (aucRank === null) return;       // 非主板 / 天数不足 ⇒ 没有名次，不写
      seen.add(nm);
      const ci = closeInfo.get(nm) || null;
      rows.push({
        name: nm,
        aucPct: _num(a.pct), aucRank: aucRank,
        closePct: ci ? ci.pct : _num(p && p.pct),
        closeRank: ci ? ci.rank : null
      });
    });
  });
  if (rows.length === 0) return;

  const _a = rows.map(function(r) { return r.name + ' ' + _pct2(r.aucPct) + ' 第 ' + r.aucRank + ' 名'; }).join('；');
  const _c = rows.map(function(r) {
    return r.name + ' ' + _pct2(r.closePct) + ' 第 ' + (r.closeRank === null ? '—' : r.closeRank) + ' 名';
  }).join('；');
  out.notes = Array.isArray(out.notes) ? out.notes : [];
  out.notes.push('ℹ️ 买点侧【20日涨幅通道】入选票的涨幅与名次：' +
    '〔9:26 竞价口径〕' + _a + '。〔收盘口径〕' + _c + '。');
}

/**
 * ★★ [SECOND-LEADER-10 2026-10-24 用户口径] 排名第二的入选题材：它的【龙一】必须进入当天
 * 十日涨幅前十（9:26 竞价口径）—— 用户本轮新增的第二个入选条件。
 *
 * 用户原话（逐字）：
 *   「排名第二的题材规则，还需要完善下，添加规则，这个题材的龙一是否进入当天的10日涨幅前十？
 *     如果没进入，也不能选，只选排名第一的那个题材股票」
 *   「龙一是大亚圣象在十日涨幅排名11名（我按照当天收盘口径看到的，实际上是按照9点26分的竞价口径，
 *     你核查下……），没有进入前十，说明这个题材还是很弱。连它的龙一都没有进入当天的十日涨幅，
 *     说明没有带动性，后续基本上涨概率不大，风险很高。」
 *   「排名第二题材入选规则是，平均量比符合，题材龙一进入当天十日涨幅前十（竞价口径），
 *     只有满足这个条件。才能入选买点侧。」
 *
 * 口径（§6：两把尺子都必须与屏幕同源，⛔ 不许另写一份）：
 *   · 「龙一」= 组内【龙位 = 1】的那只。名册用 `buyDragonMap`（9:26 竞价口径的
 *     `rankDragonsWithPctMap`），与买点侧选股同一个名册；非主板不占龙位 ⇒ 不会出现「龙一是创业板」。
 *   · 「当天十日涨幅前十」= `PRESENCE_TOP_N`（与「10日涨幅」toggle 那十枚标签同一个常量），
 *     名次来自 `range10-backup.js#buildRange10Ranked`（与候补选股、与屏幕排序同一个实现）。
 *
 * ⚠️ 「排不出名次」分两种情况，⛔ 绝不能混（§10 的方向在这里是关键）：
 *   · 龙一【在池子里、但没有十日涨幅 / 非主板】⇒ 屏幕上它本来就没有名次、也不在那十枚标签里
 *     ⇒ 结论是确定的「没进前十」（judge = ''，rank = null）；
 *   · 龙一【根本不在池子里】/ 池子不可用 ⇒ 我们没看到它这一行 ⇒ **判不出**（judge = 'no-row' / 'no-pool'）
 *     ⇒ ⛔ 不许当成「没进」去否掉题材（判不出 ≠ 判出 false）。
 *
 * @param {object} blk 题材块（rankDecisionTopics 的一项：含 topic / members）
 * @param {Map} dragonMap 9:26 口径龙位名册
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap 十日涨幅名次（见 _range10RankMapOf）
 * @returns {{ok:boolean, judge:string, dragonName:string, rank:number|null, pct:number|null}}
 *          judge：'' = 判出来了；'no-dragon' / 'no-row' / 'no-pool' = 判不出（各自原因不同，文案要分开说）
 */
function _secondTopicLeaderInTop10(blk, dragonMap, rankMap) {
  const topN = PRESENCE_TOP_N;
  const dm = dragonMap || new Map();
  let lead = null;
  ((blk && blk.members) || []).forEach(function(m) {
    if (lead || !m || !m.name) return;
    const d = dm.get(m.name);
    if (d && Number(d.rank) === 1) lead = m;
  });
  if (!lead) {
    return { ok: false, judge: 'no-dragon', dragonName: '', rank: null, pct: null };
  }
  const nm = String(lead.name).trim();
  if (!(rankMap instanceof Map) || rankMap.size === 0) {
    return { ok: false, judge: 'no-pool', dragonName: nm, rank: null, pct: null };
  }
  if (!rankMap.has(nm)) {
    // 池子里根本没有这只票 ⇒ 我们没看到它的十日涨幅 ⇒ 判不出（⛔ 不当成「没进」）
    return { ok: false, judge: 'no-row', dragonName: nm, rank: null, pct: null };
  }
  const hit = rankMap.get(nm) || null;
  const pct = hit ? _num(hit.pct) : null;
  const rawRank = hit ? Number(hit.rank) : NaN;
  const rank = (isFinite(rawRank) && rawRank > 0) ? rawRank : null;
  // rank === null ⇒ 它在池子里但排不出名次（没有十日涨幅 / 非主板）⇒ 不在那十枚标签里
  return { ok: rank !== null && rank <= topN, judge: '', dragonName: nm, rank: rank, pct: pct };
}

/**
 * 【纯函数】把十日涨幅池排成「主板名次」索引：`Map<股票名, {rank, pct}>`。
 * ⛔ 排序 / 名次 / 只主板 全部复用 range10-backup.js#buildRange10Ranked（§6 同一个实现），
 *   本函数只负责「换成按名字查」。
 */
function _range10RankMapOf(rows) {
  const m = new Map();
  if (!Array.isArray(rows) || rows.length === 0) return m;
  buildRange10Ranked(rows).forEach(function(it) {
    if (it && it.name) m.set(it.name, { rank: it.rank, pct: it.pct });
  });
  return m;
}

/**
 * ★★ [DUAL-RANK 2026-10-24 用户口径] 一只票在【收盘口径】下的名次（复盘对照用）。
 *
 * 用户原话：「我明白了，就是按照竞价口径，上海九百就是排名前十首次在列的那只，但是收盘口径，
 *   兆威机电排在前十且出现首次在列。而上海九百，却排在 11，所以看起来产生错觉。复盘时出现困惑。
 *   你有没有办法让我复盘时，只看竞价口径的排名结果，但是收盘时我也想看，竞价口径我也想看
 *   原始的是怎么排名的。」
 *   ⇒ 屏幕上【继续以竞价口径（9:26）为准】（名字前面那个「第 N 名」永远是选股用的那一份），
 *     同时把【收盘口径】的名次并列写出来，让复盘时能直接对照，⛔ 不用去两个看板来回比对。
 *
 * ⛔ 本函数只产出事实，绝不参与任何判定（§6：选股口径一旦分叉就等于换了一套规则）。
 *
 * 三态返回（§10：判不出 ≠ 判出「没有名次」）：
 *   · `null`             ⇒ 收盘口径名次表不可用 / 这只票不在原始池里 ⇒ **判不出** ⇒ 文案一个字都不写；
 *   · `{rank:null,...}`  ⇒ 它在原始池里，但收盘口径下排不出名次（非主板 / 缺涨幅）⇒ 屏幕上本来就没名次；
 *   · `{rank:N,...}`     ⇒ 判出来了；`same=true` 表示与竞价口径名次相同（⇒ 文案可省，零噪声）。
 *
 * @param {Map|null} closeRankMap 收盘口径名次表（`_range10RankMapOf(o.range10Rows)`）
 * @param {string} name 股票名
 * @param {number|null} rank926 竞价口径名次（用来判「两套是否相同」）
 * @returns {{rank:number|null, pct:number|null, same:boolean}|null}
 */
function _closeRankOf(closeRankMap, name, rank926) {
  if (!(closeRankMap instanceof Map) || closeRankMap.size === 0) return null;
  const nm = String(name || '').trim();
  if (!nm || !closeRankMap.has(nm)) return null;
  const it = closeRankMap.get(nm) || null;
  const r = it ? Number(it.rank) : NaN;
  const cur = Number(rank926);
  if (!isFinite(r) || r <= 0) return { rank: null, pct: it ? _num(it.pct) : null, same: false };
  return { rank: r, pct: it ? _num(it.pct) : null, same: isFinite(cur) && cur === r };
}

/**
 * 【纯函数】把一份名次表里「第 1 ~ topN 名」的票按名次取出来（供两套口径对照文案用）。
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap
 * @param {number} topN
 * @returns {Array<{name:string, rank:number, pct:number|null}>}
 */
function _rankTopEntries(rankMap, topN) {
  const out = [];
  if (!(rankMap instanceof Map) || rankMap.size === 0) return out;
  rankMap.forEach(function(v, k) {
    const r = v ? Number(v.rank) : NaN;
    if (!isFinite(r) || r <= 0 || r > topN) return;
    out.push({ name: k, rank: r, pct: v ? _num(v.pct) : null });
  });
  out.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

/**
 * ★★ [DUAL-RANK 2026-10-24 用户口径] 「两套口径的前十名单」对照文案（复盘专用）。
 *
 * 为什么要有这一段：单看一只票的「收盘口径第 N 名」还不够 —— 用户复盘时的困惑是
 *   「为什么竞价口径是上海九百、收盘回看却是兆威机电」这种【整批名单换了】的现象。
 *   逐只给名次能对上号，但看不到「这一批到底进了谁、出了谁」。
 *
 * §10 / §11 两条安全降级：
 *   · 任一套名次表为空 ⇒ 判不出 ⇒ 返回 ''（⛔ 不写半段、不猜）；
 *   · 两套前十【名单与顺序完全一致】⇒ 没有可对照的差异 ⇒ 返回 ''（零噪声；
 *     调用方没传 9:26 口径（pctMap）时 rows 原样返回，两套必然一致 ⇒ 自动不出现）。
 *
 * ⛔ 只列事实，不下结论（选股永远用竞价口径那一份）。
 *
 * @param {Map} rank926 竞价口径名次表
 * @param {Map} rankClose 收盘口径名次表
 * @param {number} topN 「前十」的 N
 * @returns {string}
 */
function _range10DualTopText(rank926, rankClose, topN) {
  const n = (isFinite(Number(topN)) && Number(topN) > 0) ? Math.floor(Number(topN)) : PRESENCE_TOP_N;
  const a = _rankTopEntries(rank926, n);
  const b = _rankTopEntries(rankClose, n);
  if (a.length === 0 || b.length === 0) return '';
  const same = a.length === b.length && a.every(function(x, i) { return x.name === b[i].name; });
  if (same) return '';

  const fmt = function(list) {
    return list.map(function(x) { return x.rank + '.' + x.name; }).join(' ');
  };
  const closeRankOf = new Map();
  b.forEach(function(x) { closeRankOf.set(x.name, x.rank); });
  const aNames = new Set(a.map(function(x) { return x.name; }));
  const moves = [];
  a.forEach(function(x) {
    if (!closeRankOf.has(x.name)) {
      moves.push(x.name + ' 竞价第 ' + x.rank + ' 名 → 收盘掉出前十');
    } else if (closeRankOf.get(x.name) !== x.rank) {
      moves.push(x.name + ' 竞价第 ' + x.rank + ' 名 → 收盘第 ' + closeRankOf.get(x.name) + ' 名');
    }
  });
  b.forEach(function(x) {
    if (aNames.has(x.name)) return;
    moves.push(x.name + ' 竞价没进前十 → 收盘第 ' + x.rank + ' 名');
  });
  return '📊【两套口径前十对照 · 复盘专用】⛔ 只作对照，选股与行上的名次仍固定为【竞价口径（9:26）】。' +
    '竞价口径（9:26，本看板选股用的那一份）前十：' + fmt(a) + '｜' +
    '收盘口径（现价，即早盘竞价「10日涨幅」toggle 上看到的原始排名）前十：' + fmt(b) + '｜' +
    '差异：' + (moves.length ? moves.join('；') : '名次相同') + '。';
}

/**
 * 【纯函数】★ [SMALL-TOPIC 2026-10-24 用户口径] 一个题材里，有哪些票进了【当天十日涨幅前十】。
 *
 * 用途：排名第一的入选题材、【数量 4~6 只】时（`TVRB_SMALL_TOPIC_MAX`），只许在这几只里选
 *       「名次最靠前的那一只」；一只都没有 ⇒ 该题材【弃掉】（见 buildTopicVolRatioPlan 里的收紧段）。
 *
 * ⚠️ 「判不出」与「判出 = 一只都没进」必须分开（§10 的方向在这里是关键，与
 *    `_secondTopicLeaderInTop10` 的解码方式刻意保持一致，两处是同一把尺子）：
 *   · `judge = 'no-pool'` ⇒ 名次表本身不可用（池子没读到 / 20 天补位行未就绪）⇒ **判不出**；
 *   · `judge = 'no-row'`  ⇒ 这个题材的成员【一只都不在池子里】⇒ 我们根本没看见它们 ⇒ **判不出**
 *                            （⛔ 不许当成「一只都没进前十」去弃掉题材）；
 *   · `judge = ''`        ⇒ 判出来了：`hits` = 池内成员里名次 ≤ PRESENCE_TOP_N 的（按名次升序），
 *                            `hits.length === 0` 就是确定的「一只都没进前十」。
 *
 * ⚠️ 残留缺口（如实记下，⛔ 不装作没有）：`judge = ''` 时若该题材【有成员不在池子里】，
 *    理论上那只缺行成员可能正躺在前十里 ⇒ 严格说结论带一点假设。实际池子 = 当日名单 + 20 天
 *    补位行 = 屏幕上全部有十日涨幅的行，缺行的都是灰行 / 注入壳（本来就无十日涨幅、屏幕上也没有
 *    名次标签）⇒ 与本看板其它判定（第二十九条候补、第二题材闸门）同一口径。要收紧的只有
 *    「一只都看不见」这一种，已单列为 `no-row`。
 *
 * @param {object} blk 题材块（rankDecisionTopics 的一项：含 topic / members）
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap 十日涨幅名次（见 _range10RankMapOf）
 * @returns {{judge:string, hits:Array<{name:string,rank:number,pct:number|null}>, seen:number}}
 */
function _topicTop10Hits(blk, rankMap) {
  const topN = PRESENCE_TOP_N;
  if (!(rankMap instanceof Map) || rankMap.size === 0) {
    return { judge: 'no-pool', hits: [], seen: 0 };
  }
  const hits = [];
  let seen = 0;
  ((blk && blk.members) || []).forEach(function(mm) {
    const nm = String((mm && mm.name) || '').trim();
    if (!nm || !rankMap.has(nm)) return;
    seen++;
    const it = rankMap.get(nm) || null;
    // rank === null ⇒ 它在池子里但排不出名次（没有十日涨幅 / 非主板）⇒ 屏幕上它本来就没有名次标签
    const r = it ? Number(it.rank) : NaN;
    if (isFinite(r) && r > 0 && r <= topN) {
      hits.push({ name: nm, rank: r, pct: it ? _num(it.pct) : null });
    }
  });
  if (seen === 0) return { judge: 'no-row', hits: [], seen: 0 };
  hits.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return { judge: '', hits: hits, seen: seen };
}

/**
 * 把「第 2 个入选题材块」整块摘掉，并重建 heavy / light / candidates 三个槽位（§6 唯一实现）。
 *
 * ⚠️ 为什么必须重建槽位：`buy.light` 若还挂着已删除的块，四个装饰器会遍历到幽灵块 ——
 *    那是「静默多渲染一段」的最短路径（第二十九条量比作废那次踩过）。
 * @param {object} out buildTopicVolRatioPlan 的产出
 * @returns {boolean} 真的摘掉了 ⇒ true（不足两块 ⇒ false，调用方据此决定要不要写说明）
 */
function _dropSecondBlockSlot(out) {
  if (!out || !Array.isArray(out.blocks) || out.blocks.length < 2) return false;
  out.blocks.splice(1, 1);
  out.buy.heavy = null;
  out.buy.light = null;
  out.buy.candidates = [];
  out.blocks.forEach(function(b, i) {
    if (i === 0) out.buy.heavy = b;
    else if (i === 1) out.buy.light = b;
    else out.buy.candidates.push(b);
  });
  return true;
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
 *   ① 候选序列 = _dragonCandidates(block, dragonMap, pctMap) —— 已剔除无龙位票（创业板 / 科创板）、
 *      已按【龙位升序】排好（龙一 → 龙二 → …）；
 *   ② 从高到低依次取票，直到【名额】用满（本档只数 1 或 2 个名额）；
 *   ③ 【竞价涨停（竞价一字）】买不进 ⇒ 跳过、**不占名额**（顺延补位）；
 *      【连续停牌】买不进 ⇒ 跳过、**占掉一个名额**（不补位，题材跟着少取）。
 *      ⛔ 与决策看板的「占名次不递补」不同：本看板用户明确要求往下顺延（一字）／名额作废（停牌）。
 *
 * ⛔ 本看板【没有仓位口径】：picks 的 position 一律留空（用户第二轮点名的标签里没有重仓 / 轻仓，
 *    而本看板按龙位取票、本来就没有「前 N 只重仓」这回事 —— ⛔ 不凭空造一条仓位规则）。
 *    昨天真买过的票仍会被 finishBuyBlock 内部的 _markPrevBought 改写成【持有】（那是决策看板的口径）。
 *
 * ★ [TVRB-926 2026-10-14 用户口径] `dragonMap` / `pctMap` 都是【9:26 口径】那一套
 *   （rankDragonsWithPctMap + readAuctionLegRangeMap 的产物，由组合式注入）：
 *   用户要的是「早上 9:26 那一刻选中的股票，任何时候翻回来都是同一批」——
 *   收盘后 T 腿换腿会把组内十日涨幅重排、进而换掉龙一，必须用竞价腿那一份才稳定。
 *
 * ★★ [SMALL-TOPIC 2026-10-24 用户口径] `opt.order` / `opt.smallTopic` —— 小题材收紧专用：
 *   · `order`      = 指定【候选序列】（只含「当天十日涨幅前十」里的同题材票，顺序 = 龙位升序）。
 *                    给了就用它，⛔ 不再走 `_dragonCandidates` 的全量龙位序列。只用于
 *                    【排名第一 + 数量 4~6 只】那一段（见 TVRB_SMALL_TOPIC_MAX）；
 *                    ⚠️ 序列里的元素仍是 `_dragonCandidates` 的产物（同一形状、同一字段），
 *                    所以下面「竞价一字顺延 / 连续停牌占档」那一套逻辑【一行都不用改】。
 *   · `smallTopic` = 说明文案标记：本块走的是收紧口径（`reason` 里讲清「只在十日涨幅前十的同题材票里
 *                    取组内最强的那一只」），⛔ 不传 ⇒ 文案与加规则之前逐字相同（§11 零行为变化）。
 *   · `baseText`   = 十日涨幅池的口径时间文案（'9:26 竞价口径' / '收盘口径（…未读到）'），只进文案。
 *
 * @param {object} block   题材块（含 rank / topic / count / yiziCount / members）
 * @param {Map} dragonMap  龙位名册（rankDragons / rankDragonsWithPctMap 的返回）
 * @param {object} tier    resolveTvrbTier 的返回
 * @param {Map} [pctMap]   ★ [TVRB-926] 9:26 口径区间涨幅（行上十日涨幅取它；缺 ⇒ 退回成员自带值）
 * @param {Set} [skipBuyNames] 连续停牌第 2 天及以上的票（买不进 ⇒ 占档不补位）
 * @param {object} [opt]   ★★ [SMALL-TOPIC 2026-10-24] 收紧可选开关：{order, smallTopic, baseText}
 * @returns {object} 决策看板形状的买点块（+ 本看板自己的几个平铺别名，见返回值末尾）
 */
function _buildBlock(block, dragonMap, tier, pctMap, skipBuyNames, opt) {
  const o = opt || {};
  const avg = avgVolRatioOf(block);
  const cands = (Array.isArray(o.order) && o.order.length > 0)
    ? o.order
    : _dragonCandidates(block, dragonMap, pctMap);
  const picked = [];
  const skipped = [];
  const skippedSuspend = [];
  // ★★ [SUSPEND-OCCUPY 2026-10-15 用户口径] 「档位」计数（= 已经用掉几只的名额）。
  //
  // 用户原话（逐字）：
  //   「比如龙一停牌占位，龙二是一字，那就顺位取龙三，只取一只，如果龙一没停牌，也不是一字，
  //     买龙一或者顺位下一只，买两只，相当于有龙一可以买两只，如果龙一是一字，那就可以买龙二和龙三，
  //     因为龙一比较强。停牌看不出来，舍掉龙一，只买一只靠前的」
  //
  // ⇒ 两种「买不进」的语义【不同】，必须分开算：
  //   · 【竞价一字】买不进 ⇒ **不占档位**（顺延补位）：龙一是一字 ⇒ 照样买满 N 只（龙二 + 龙三）。
  //     理由：一字是「很强」的票，用户口径明确要「看龙二、龙三」把名额买满。
  //   · 【连续停牌】买不进 ⇒ **占档位**（不补位）：龙一停牌 ⇒ 该档作废 ⇒ 只剩 1 个名额。
  //     理由：停牌票连竞价都没有，占着龙位也买不到，名额跟着作废才符合「实际能买到的票」。
  //     实测（2026-10-14 AI应用，13 只 ⇒ 取 2 只）：龙一 新华传媒【连续停牌】占掉 1 档
  //     ⇒ 只选龙二 慈文传媒 1 只（用户口径：「AI应用题材当天只选一只更加合理」）。
  let slotsUsed = 0;
  for (let i = 0; i < cands.length && slotsUsed < tier.pickCount; i++) {
    const c = cands[i];
    if (c.isYizi) { skipped.push(c); continue; }   // 竞价涨停 → 买不进 ⇒ 顺延下一龙位（⛔ 不占档位）
    // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 连续停牌（第 2 天及以上）⇒ 买不进 ⇒ 占档位、不补位。
    //   用户原话：「停牌的股票根本不能买，也买不进……停牌首日可选入（已实现），
    //   次日还是停牌（没有竞价涨幅，竞价量，昨日成交量等），就不要选进去了……
    //   相当于一字买不进」（[SUSPEND-OCCUPY 2026-10-15] 名额语义已按用户口径区分，见上）。
    //   ⛔ 这里只【跳过 + 占一档】，不改 tier（题材只数照旧按全部成员算，用户：「当天有 14 只，选 2 只」）。
    if (skipBuyNames && skipBuyNames.has(c.name)) { skippedSuspend.push(c); slotsUsed++; continue; }
    picked.push(c);
    slotsUsed++;
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
  // ★ [SUSPEND-NOBUY 2026-10-14] 被【连续停牌】跳过的那几只（与一字分开列，文案不同、理由不同）
  const skippedSuspendNames = skippedSuspend.map(function(c) {
    return (c.rank ? getDragonLabel(c.rank) : '') + c.name;
  });

  // ★★ [SMALL-TOPIC 2026-10-24 用户口径] 收紧档的 reason 必须换口径说明：
  //   用户原话「如果排名第一的题材数量4-6只，要看10日涨幅，看有没有同题材票进入前10，
  //   如果有就选最靠前那一只」⇒ 这一档【不是】按龙一 → 龙二 顺序取票，而是按【当天十日涨幅名次】取。
  //   ⛔ 文案与判定同处一处（§6）：改取票口径时这两句必须一起改。
  const reason = o.smallTopic
    ? ('按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
       '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
       ' 只；★ 本题材数量落在【' + TVRB_MIN_COUNT + '~' + TVRB_SMALL_TOPIC_MAX +
       ' 只】且是排名第一 ⇒ 收紧：只在【当天十日涨幅〔' + (o.baseText || '9:26 竞价口径') +
       '〕前十】的同题材票里取【组内最强（龙位最前）】的那一只（数量少的题材次日顶多活一只，' +
       '只买最强的）；买不进照旧：竞价一字顺延、连续停牌作废。')
    : ('按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
       '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
       ' 只；按【龙一 → 龙二 → …】从高到低依次取票：遇到【竞价涨停（竞价一字）】买不进 ⇒ ' +
       '顺延到下一个龙位；遇到【连续停牌】买不进 ⇒ 该龙位【不再补位】（本题材实际少取相应只数）。');

  const notes = [];
  notes.push(o.smallTopic
    ? ('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
       '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
       ' 只；★【小题材收紧】数量落在 ' + TVRB_MIN_COUNT + '~' + TVRB_SMALL_TOPIC_MAX +
       ' 只且是排名第一 ⇒ 不按全部龙位取票，只在【当天十日涨幅〔' + (o.baseText || '9:26 竞价口径') +
       '〕前十】的同题材票里取【组内最强（龙位最前）】的那一只（用户口径：这种数量少的，' +
       '次日能存活下来的顶多有一只，所以就买最强的）。买不进照旧：竞价一字顺延下一只、连续停牌该名额作废。')
    : ('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
       '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
       ' 只；入选股票按龙位从高到低依次取：' +
       '【竞价涨停（竞价一字）】买不进 ⇒ 顺延到下一个龙位（名额照买满）；' +
       '【连续停牌】买不进 ⇒ 该龙位【不再补位】（停牌票连竞价都没有，占着龙位也买不到，名额跟着作废）。'));
  if (skippedNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedNames.join('、') +
      ' 竞价涨停（买不进）⇒ 已顺延到下一个龙位（用户口径：龙一涨停看龙二，龙二涨停看龙三……）。');
  }
  if (skippedSuspendNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedSuspendNames.join('、') +
      ' 【连续停牌】（今天停牌、昨天也停牌：没有竞价涨幅 / 竞价量 / 昨日成交量）⇒ 买不进，' +
      '该龙位【不再补位】（⛔ 与「竞价一字」不同：一字是顺延补位把那一名额买满，' +
      '停牌是该名额直接作废、本题材少取 ' + skippedSuspendNames.length + ' 只）。' +
      '⚠️ 停牌【首日】不跳（用户口径：昨天首日停牌还可以入选）——' +
      '只有连着第 2 天及以上停牌才按「买不进」处理。');
  }
  if (picks.length < tier.pickCount) {
    notes.push(o.smallTopic
      ? ('⚠️ 本题材【当天十日涨幅前十】里可买入（非竞价涨停、非连续停牌）的票不足 ' +
         tier.pickCount + ' 只 ⇒ 实际取 ' + picks.length +
         ' 只（⛔ 不从第十名之外补位 —— 收紧口径就是【只买最强的】）。')
      : ('⚠️ 本题材有龙位、且可买入（非竞价涨停、非连续停牌）的票不足 ' + tier.pickCount +
         ' 只 ⇒ 实际取 ' + picks.length + ' 只（⛔ 不从其它题材补位）。'));
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
 * ══【第二十八条 · 新龙 / 新题材切换日】══════════════════════════════════════════════════
 *
 * 用户口径（2026-10-22 原话，逐字）：
 *   「二次退潮次日后一天，也就是10月22日，就要切换新题材或者寻找新题材了（这是核心思想）」
 *   「20个交易日内，上述的时间点这只股票名称有没有上榜？今天是不是首次20日涨幅上榜前五？
 *     如果是，看下一个条件，是不是和和老龙一是不是同个题材，如果不是，说明这是个新龙，
 *     是要入选题材量比买点侧的。相当于又找新的周期或者题材的票。」
 *   「规则要添加下：只选20日涨幅排名前五题材，没有出现过的新龙。」
 *   「从常规中寻找新的题材，这个节点要收紧，和常规不同，这个节点只选一个题材，
 *     只找排名靠前的一个符合条件题材的股票……（排名第一的房地产按照常规不符合选入条件，排除）」
 *   「如果看20日涨幅没有符合条件（比如五只都是同题材的，5只20天都出现过的），
 *     接下来就是常规班选股了，不做限制。」
 *
 * ── 时间轴（用户给的三段式，⛔ 别把 D+1 与 D+2 搞混）────────────────────────────────
 *   D      = 总龙一【二次确认退潮】日（10-20）
 *   D+1    = 退潮次日 ⇒ 主轴题材【禁止买入】（第二十六条，已实现；10-21）
 *   D+2    = 【切换日】= 今天（10-22）⇒ 老周期结束，找【新龙】/【新题材】
 *   ⇒ 判据 = 「二次确认退潮事件」正好发生在【前两个交易日】（prevPrevDate）。
 *     复用 secondEbbTopicOfPrevDay（§6 同一把尺子：连它那套「事件 ≠ 天数」的合并口径一起复用），
 *     ⛔ 绝不另写一份「昨天是不是二次确认」的计数。
 *
 * ── 新龙怎么选（用户逐条对应）──────────────────────────────────────────────────────
 *   ① 候选 = 今日【20日涨幅前五】（与「20日涨幅」toggle 的总龙一~五同一份，§6）；
 *   ② 自上而下逐只过闸：
 *        · 老龙一自己 ⇒ 跳过（它是被交接的那一方，不是新龙）；
 *        · 近 20 个交易日【已上过前五】⇒ 跳过（「20个交易日内……有没有上榜」）；
 *        · 与老龙一【同题材】⇒ 跳过（老周期的票，退潮后基本不看）；
 *        · 剩下第一只 = 【新龙】（= 老龙向新龙的交接）。
 *   ③ 一只都不剩 ⇒ 本规则【不生效】，买点侧回落常规选股。
 *      ★ [CYCLE 2026-10-22] 但「切换日只选一个题材、只取一只」这条收紧【仍然生效】：
 *        用户原话「10月22日 = 选新龙头 + 常规只选排名第一的入选题材（只选最前面那个）」。
 *
 * ── 常规侧怎么收紧（切换日专属，⛔ 只在有【新龙】时才收紧）──────────────────────────
 *   · 只选【一个】题材（排名最前、且数量达标的那一个 —— 数量不足照旧顺延，用户举例：房地产被排除）；
 *   · 该题材只取【一只】票（龙位最前、非竞价一字、非连续停牌）；
 *   · 跳过【退潮的那个老题材】与【新龙自己的题材】（老周期不买 / 避免同一题材出两只）。
 *
 * ⚠️ 为什么「收紧」必须依赖「新龙成立」：用户把两者写在同一个节点里 ——
 *   「如果看20日涨幅没有符合条件……接下来就是常规班选股了，不做限制」。
 *   ⇒ 判不出新龙（五只都不合格 / 历史榜读不到）⇒ 不收紧，且必须在说明里写清原因（§10）。
 */
/** 本行引用的规则编号（= 规则手册第二十八条「新龙 / 新题材切换日」） */
export const SWITCH_RULE_NO = '二十八';
/** 新龙那一行的动作标签（⛔ 不复用「退潮替补买」：那是退潮日的语义，与「新周期开启」不同） */
export const NEW_DRAGON_TAG = '新龙买';
/** 配色档：复用【退潮替补买】的琥珀金（本看板「今天真要买的例外」同一套语义色，⛔ 不新造一档） */
export const NEW_DRAGON_TONE = EBB_SECOND_BUY_TONE;
/** 候选榜只数（用户口径：「如果前五找不到，你就找前八的，不用前五的，改用排名前八的」） */
export const NEW_DRAGON_TOP_N = 8;
/** 「有没有上过榜」的回看窗口（用户口径「20个交易日内」） */
export const NEW_DRAGON_LOOKBACK_DAYS = 20;

// ══ ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条：十日涨幅 · 在列次数候补 ═══════════════
//
// 用户原话（逐字，三段合起来才是完整口径）：
//   ①「10月20日，主线题材二次确认退潮当天，龙头首次分歧次日，按照题材平均量比排名第二的题材，
//      比如松霖科技在的房地产，题材量比太小，只有 7.47，小于空仓门槛量比 25，题材量比太小禁止选入，
//      应该选十日涨幅首次在列龙头而且是排名前十的，进行替换，而且排名靠前的，首次在列，
//      排名靠前的是海洋王，排名第八。所以选它。」
//   ②「排名第二的题材如果量比太小就用 10 日涨幅，首次在列进行候补，如果排名前十没有首次在列标签，
//      就用二次在列排名靠前候补……这样可以选出有潜质的新龙，因为 20 日老周期结束，现在轮到十日周期。」
//   ③「常规的是排名第一的题材如果平均量比小于标准 25，也一率作废。进入候选的是十日涨幅题材新股票的
//      排名靠前的新股票（首次在列或者二次在列），新面孔。有首次在列的只选一只，没有首次在列的，
//      选二次在列的。如果都没有，依旧空仓。」
//
// AskUserQuestion 四答（2026-10-24，逐条拍板）：
//   · 常规侧（第一题材 < 25）→「空仓标语保留 + 另给候补」（灰化与「建议空仓」照旧，另外多出一只可买）
//   · 触发范围 →「任何一天都生效」（不再限定二次确认退潮日）
//   · 被作废的第二题材 →「整块删除，只出候补」
//   · 「排名前十」→「与在列次数标签同口径」（主板名次 ≤ PRESENCE_TOP_N）
//
// ⛔ 与第二十一条【退潮替补】的分工（别混）：
//   · 退潮替补（20日涨幅总龙二~五）= 退潮【兜底】通道，只在「首次退潮」或「二次确认但常规选不出」时出来；
//   · 本候补（十日涨幅前十 · 在列次数）= 常规通道【题材作废后的替换】，走的是「十日周期的新面孔」。
//   两者不会同时出现：退潮兜底那一路（out.ebb && !ebbSecondRegular）与切换日（第二十八条）都排除本规则。
/** 本行引用的规则编号（= 规则手册第二十九条）—— 定义在 range10-backup.js，这里转出给视图 / 单测用 */
export { RANGE10_BACKUP_RULE_NO };
/** 配色档（视图 CSS 类名 tvrb-action-r10backup 的 tone 值） */
export const RANGE10_BACKUP_TONE = 'r10backup';
/** 候补那一行的动作标签（⛔ 不复用「退潮替补买」/「新龙买」：它是「常规题材作废后的替换」，语义不同） */
export const RANGE10_BACKUP_TAG = '十日涨幅候补买';
/** 全称文案（买点侧容器标题 / 行内说明用；§21 模板零计算） */
export const RANGE10_BACKUP_LABEL = '第十日周期候补 · 买点（第' + RANGE10_BACKUP_RULE_NO + '条）';


/**
 * 【纯函数】文案：历史榜窗口的描述 —— **必须如实暴露覆盖度**。
 *
 * 🔴 2026-10-22 用户当场质问「这个不是算20个交易日吗？为什么说是8个交易日？」：
 *   判定窗口确实是 20 个交易日（`NEW_DRAGON_LOOKBACK_DAYS = 20`，组合式按交易日历往前取 20 天），
 *   但落库表 `stock_range20_pct` 当时**只有 8 天有行**（该能力 2026-10-12 才上线）⇒
 *   `readTop5History` 的 `days` = 8，文案如实写 8。
 *   ⛔ 绝不能为了"看起来对"改写成 20 —— 那是把「没查过」伪装成「查过且没上榜」（§10 红线）。
 *   ⇒ 正解 = 把【窗口 20 / 实际 8】两个数同时写出来，用户一眼就能看出是数据缺口而不是算错。
 *
 * ✅ 2026-10-22 已用 `db/scripts/backfill-range20.mjs` 把表补齐到 20/20（09-16~10-21 + 10-22，
 *   共 252 只票；09-25 是中秋休市不算，停牌票按 §10 不写）。此时 `days` = 20 ⇒ 本函数返回
 *   「20 个交易日」，括号里的覆盖度自然消失 —— 文案自适应，不需要改判定逻辑。
 *   ⚠️ 分支仍必须保留：以后换设备 / 换库 / 新窗口刚上线时，覆盖度照样会不足，仍要如实暴露。
 *
 * @param {number} windowDays 历史榜实际覆盖天数
 * @returns {string}
 */
function _windowTextOf(windowDays) {
  const n = Math.floor(Number(windowDays) || 0);
  if (n <= 0) return '（历史榜未读到）';
  if (n >= NEW_DRAGON_LOOKBACK_DAYS) return n + ' 个交易日';
  return n + ' 个交易日（实际覆盖 ' + n + '/' + NEW_DRAGON_LOOKBACK_DAYS + ' 天）';
}

/**
 * 【纯函数】文案：这只票【今天】在 20日涨幅榜上的名次。
 *
 * 🔴 2026-10-22 用户当场质问「你不是说按照当天竞价冰山冷热排在第六吗？现在怎么是排在前五？」
 *   根因 = 旧文案**硬编码**「【首次】上到前五」，而判定允许从【前八】里挑（用户口径「改用排名前八的」）
 *   ⇒ 只要选中的是新龙榜第 6/7/8 名，那句「上到前五」就是**假话**。
 *   ⚠️ 另一个诱因是口径随时钟切换：同一只票 9:25 竞价口径可能第 6 名、收盘口径第 3 名
 *     （`resolveT20LegMode`：<15:00 走 auc，≥15:00 走 close）⇒ 同一个屏幕早晚看到的"名次"本来就会变。
 *   ⇒ 文案一律写【今日排名第 K 名】，把名次交给数据说话，⛔ 不再出现任何"上到前五"的断言。
 *
 * @param {number} rank20 今日名次（1 起）
 * @returns {string}
 */
function _todayRankPhrase(rank20) {
  const r = Math.floor(Number(rank20) || 0);
  return r > 0 ? ('今日排名第 ' + r + ' 名') : '今日排名未定';
}

/**
 * 【纯函数】文案：名次标签。
 *
 * 🔴 为什么需要：`totalDragonLabel` 只定义了 1~5（第 6 名及以后返回 `''`），而本规则的候选池是
 *   【前八】⇒ 选中的是新龙榜第 6/7/8 名时，旧文案会把标签渲染成 **`总龙?`**（2026-10-22 实测）。
 *   ⇒ 前五照旧用「总龙一~五」；第 6~8 名如实写「20日涨幅第 K 名」；再往后写「榜外」。
 *
 * @param {number} rank20
 * @returns {string}
 */
function _rankLabelOf(rank20) {
  const r = Math.floor(Number(rank20) || 0);
  if (r <= 0) return '20日涨幅榜外';
  const lb = totalDragonLabel(r);
  return lb || ('20日涨幅第 ' + r + ' 名');
}

/**
 * 【纯函数】切换日判定：二次确认退潮是否正好发生在前两个交易日。
 *
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string, ebb:boolean}>|null} ebbHistory
 * @param {string} prevPrevDate 展示日的【前两个交易日】（组合式注入，⛔ 规则层不自算日期）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（与 detectEbbDay 同一把尺子）
 * @returns {{ebbDate:string, topic:string, leaderName:string, since:string}|null}
 */
export function detectSwitchDay(ebbHistory, prevPrevDate, coreRes, windowFrom) {
  const ppd = String(prevPrevDate || '').trim();
  if (!ppd || !Array.isArray(ebbHistory)) return null;
  const hit = secondEbbTopicOfPrevDay(ebbHistory, ppd, coreRes, windowFrom);
  if (!hit) return null;
  return {
    ebbDate: ppd,
    topic: _normTopic(hit.topic, coreRes),
    leaderName: String(hit.leaderName || '').trim(),
    since: String(hit.since || '')
  };
}

/**
 * 【纯函数】从今日 20日涨幅【前八】里挑出【新龙】。
 *
 * 「前五 → 前八」（用户 2026-10-22 原话）：「如果前五找到你就找前八的，不用前五的，改用排名前八的。
 *   注意竞价涨停一字涨停板是买不进的，所以前八的，在这个节点上，你只能挑选非竞价一字涨停的主板」。
 * ⇒ 候选 = 20日涨幅第 1~8 名（已按「只主板」在上游 rankLeaders(mainBoardOnly) 排过），
 *   本函数再逐只过【非竞价一字 / 非停牌 / 非主板】三道闸，然后在剩下的里挑第一只。
 *
 * @param {Array<{name:string, code:string, topic:string, pct:number, pctText:string, rank20:number,
 *          isYizi:boolean, suspended:boolean, mainBoard?:boolean}>} top5
 *        采集层富化过的前八（decision-collect#_ebbCtxOf 的 newDragonPool，已带题材/代码/停牌/一字/主板）
 * @param {Set<string>} everInTop5 近 20 个交易日【上过前五】的股票名集合（data/range20-top5-history.js）
 *        ⚠️ 历史榜口径仍是【前五】（用户原话「20个交易日内……有没有上榜前五？」）——
 *           前八只是【今天】的候选放宽，⛔ 别把历史口径也放宽（会把 10-22 的冰山冷热误杀）。
 * @param {{oldTopic?:string, oldLeaderName?:string, windowDays?:number, coreRes?:Function}} info
 *        oldTopic / oldLeaderName = 老龙一（= 二次确认退潮那只总龙）
 *        windowDays = 实际覆盖的天数（写进说明，§10 覆盖度如实上报）
 *        coreRes    = ★ [CORE-CAT 2026-10-22] 题材大类归一（同题材判定必须走大类）
 * @returns {{pick:object|null, trail:Array<{name:string, rank20:number, picked:boolean, reason:string}>, oldTopic:string}}
 */
export function pickNewDragon(top5, everInTop5, info) {
  const o = info || {};
  const top = Array.isArray(top5) ? top5 : [];
  const ever = (everInTop5 instanceof Set) ? everInTop5 : new Set();
  const coreRes = (typeof o.coreRes === 'function') ? o.coreRes : null;
  const ln = String(o.oldLeaderName || '').trim();
  // 老龙题材：优先用落库的退潮行（老龙一自己的题材）；缺失 ⇒ 退回「今天榜第一名的题材」
  //   （今天的第一名就是老龙一 —— 停牌也被 20日口径排上榜，所以这条退路语义等价）。
  const lt = _normTopic(o.oldTopic, coreRes) || _normTopic(top[0] && top[0].topic, coreRes);
  const windowDays = Number(o.windowDays) || NEW_DRAGON_LOOKBACK_DAYS;
  const trail = [];
  let pick = null;
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    if (!c || !c.name) continue;
    const name = String(c.name).trim();
    const rank20 = Number(c.rank20) || (i + 1);
    // ★ 已选出新龙 ⇒ 后面的【照样留痕】但不再评估：说明文案写的是「八只去留（判定可追溯）」，
    //   提早 break 会让后面几只凭空消失（用户无法复核「为什么不是它」）。
    //   ⛔ 切换日只买一只新龙 ⇒ 后面这些本来也不可能被选中，写明原因即可（不假装评估过）。
    if (pick) {
      trail.push({ name: name, rank20: rank20, picked: false,
        reason: '前面已选出更靠前的新龙【' + String(pick.name).trim() + '】⇒ 切换日只买一只新龙，本只不再考虑' });
      continue;
    }
    if (ln && name === ln) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '它就是老龙一【' + ln + '】（被交接的一方，不算新龙）' });
      continue;
    }
    // ★ [NEW-DRAGON-08 2026-10-22] 只主板：创业板 / 科创板 / 北交所一律排除（用户「只挑主板」）。
    //   主板判定由采集层用 isMainBoardOnly 算好并带过来（§6 单一实现，本层不另写一套代码段规则）。
    //   ⚠️ mainBoard 缺省（undefined）⇒ 不据此排除（老调用方 / 单测不传时零行为变化，§11）。
    if (c.mainBoard === false) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '非主板（创业板/科创板/北交所）⇒ 排除' });
      continue;
    }
    // ★ [NEW-DRAGON-08 2026-10-22] 竞价一字涨停 ⇒ 买不进，不能当新龙（用户原话）。
    if (c.isYizi) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '今日竞价一字涨停 ⇒ 买不进，不能作新龙' });
      continue;
    }
    // ★ 停牌 ⇒ 买不进（与买点侧「连续停牌顺延」同一取舍）
    if (c.suspended) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '今日停牌 ⇒ 买不进，不能作新龙' });
      continue;
    }
    const tp = _normTopic(c.topic, coreRes);
    if (!tp) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '题材解析不到 ⇒ 无法证明是「新题材」，保守排除' });
      continue;
    }
    if (ever.has(name)) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '近 ' + _windowTextOf(windowDays) + '已上过前五 ⇒ 不是首次上榜' });
      continue;
    }
    if (lt && _sameTopicLoose(tp, lt, coreRes)) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '与老龙一同题材（' + lt + '）⇒ 老周期，退潮后不买' });
      continue;
    }
    trail.push({ name: name, rank20: rank20, picked: true,
      reason: '近 ' + _windowTextOf(windowDays) + '【首次】进入 20日涨幅前列（此前未进前五）+ '
        + _todayRankPhrase(rank20) + ' + 与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）' });
    pick = c;
  }
  return { pick: pick, trail: trail, oldTopic: lt };
}

/**
 * 【新龙 · 买点块】—— 与退潮替补（_buildEbbPicksBlock）/ 分歧买点同一形态：
 * 单只票、独立容器、渲染在灰化容器【之外】（今天真要买的票不能被 grayscale 吞掉）。
 *
 * ⛔ 仍然要过 finishBuyBlock：客观数据（十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）
 *   全部由它算齐（§6 同一实现），本函数只在【算完之后】把动作标签覆盖成【新龙买】。
 *
 * @param {object} nd pickNewDragon 的返回（pick 必须非空）
 * @param {Array} list 当日题材块列表（反查成员行，拿量比 / 占比 / 代码）
 * @param {object} fOpts finishBuyBlock 的入参（与常规块同一份）
 * @param {{topic:string, leaderName:string, ebbDate:string}} switchDay
 * @param {number} windowDays 历史榜实际覆盖天数
 * @returns {object} 决策看板形状的买点块（+ 本看板平铺字段）
 */
function _buildNewDragonBlock(nd, list, fOpts, switchDay, windowDays, tierPick) {
  const p = nd && nd.pick;
  if (!p || !p.name) return null;
  const name = String(p.name).trim();
  const topic = String(p.topic || '').trim();
  const oldTopic = String(nd.oldTopic || '').trim() || '老龙题材';

  // 真实成员行（与退潮替补同一取法：先按题材块找，再全表按名字兜一次）
  let member = null;
  (list || []).forEach(function(b) {
    if (member) return;
    (b.members || []).forEach(function(m) {
      if (!member && m && String(m.name || '').trim() === name) member = m;
    });
  });

  const picks = [{
    seq: 1,
    name: name,
    dragonLabel: totalDragonLabel(Number(p.rank20) || 0),
    dragonRank: null,
    pct: _num(p.pct),
    code: String(p.code || (member && member.code) || '').trim(),
    pctText: formatRangePct(_num(p.pct)),
    // ⚠️ 预置：finishBuyBlock 内部 _markHold 要读它（§6 与 _buildBlock 同一做法）
    aucShare: member ? _num(member.aucShare) : null,
    position: ''
  }];

  const windowText = _windowTextOf(windowDays);
  const trailText = (nd.trail || []).map(function(t) {
    return '【' + _rankLabelOf(t.rank20) + t.name + '】' + t.reason;
  }).join('；');

  const block = {
    block: {
      topic: '新龙 · ' + (topic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      members: member ? [member] : []
    },
    rankWord: '',
    pickRank: null,
    reason: '【' + SWITCH_RULE_NO + '】切换日新龙：' + (oldTopic) + '（老龙一 ' + (switchDay.leaderName || '—') +
      '）二次确认退潮后的第 2 个交易日 ⇒ 老周期结束。' + name + '（' + (topic || '—') +
      '，20日涨幅 ' + formatRangePct(_num(p.pct)) + '，' + _rankLabelOf(p.rank20) +
      '）近 ' + windowText + '【首次】进入前列（此前未进前五），' + _todayRankPhrase(p.rank20) +
      '，且与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）。',
    mode: 'newdragon',
    ruleNo: SWITCH_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '【新龙怎么选】= 今日 20日涨幅前八（前五不够就顺延到前八）自上而下：跳过老龙一自己 → ' +
        '跳过非主板 / 竞价一字 / 停牌（买不进）→ 跳过近 ' + windowText +
        ' 已上过前五的（不是首次上榜）→ 跳过与老龙一同题材的（老周期）⇒ 剩下第一只即新龙。'
        + '⚠️ 名次按【当前时点】口径：15:00 前 = 前 19 日收盘 × 今日竞价（auc），15:00 后 = 20 日全收盘（close）'
        + '—— 同一只票早晚名次会不一样，属正常。',
      (trailText ? ('八只去留（判定可追溯）：' + trailText + '。') : ''),
      '⚠️ 常规侧同日【收紧】：切换日只选一个题材、只取一只（排名最前且数量达标，退潮题材与新龙题材跳过）'
        + (tierPick ? ('——本日常规那只 = ' + tierPick + '。') : '。')
    ].filter(function(s) { return !!s; })
  };

  // ① 客观数据 + 原始买点信号（同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖动作标签为【新龙买】
  (block.picks || []).forEach(function(row) {
    const rawTag = row.buyActionTag || '';
    const rawNote = row.actionNote || '';
    row.buyActionTag = NEW_DRAGON_TAG;
    row.buyActionTone = NEW_DRAGON_TONE;
    row.holdTag = '';       // 与「今天要买」互斥
    row.position = '';
    row.actionNote = '【第二十八条 · 新龙】' + oldTopic + '（老龙一 ' + (switchDay.leaderName || '—') +
      '）二次确认退潮后第 2 个交易日 = 切换日：老周期结束、新周期开启。它近 ' + windowText +
      '【首次】进入前列（此前未进前五），' + _todayRankPhrase(p.rank20) + '，且与老龙一【不同题材】（' + (topic || '—') + '）⇒ 判定为新龙。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      ' 切换日买点侧只有【新龙】+ 常规收紧后的那【一只】（第二十八条）。';
  });

  // 本看板平铺字段
  block.topic = '新龙 · ' + (topic || '—');
  block.rank = null;
  block.count = null;
  block.yiziCount = null;
  block.avgVolRatio = null;
  block.avgVolRatioText = '';
  block.tier = 'newdragon';
  block.pickCount = 1;
  block.rangeText = '';
  block.skippedNames = [];
  block.isNewDragon = true;
  return block;
}

/**
 * ★★ [R10-926 2026-10-24 用户口径] 把十日涨幅候选池的 `pct` 换成【9:26 竞价口径】那一份。
 *
 * 用户原话：「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，
 *   因为一般都是早上选出来，收盘看的时候就不一样的」。
 *
 * 为什么能直接换（而不是另算一遍）：
 *   · `o.range10Rows`（decision-collect#range10Rows）与 `pctMap`（range-auction-leg#readAuctionLegRangeMap）
 *     **同源** —— 都是 `stock_range_pct` 那一天的行，前者取原值（收盘口径），后者用
 *     `market_metrics.auc_pct_chg / change_pct` 把 T 腿反解回竞价口径（§6 同一把尺子）。
 *     ⇒ 键集合一致，只需逐行覆盖 `pct`，⛔ 不需要补票、也不会漏票。
 *   · 覆盖后排序 / 主板名次 / 「前十」判定全部自动走 9:26 口径 —— 因为 `range10-backup.js`
 *     只认 `pct` 一个输入（sortIndicesByRangePct 与 presence-label 同一把尺子）。
 *
 * §10 / §11 两条安全降级：
 *   · `pctMap` 缺失 / 为空（该日 9:26 口径还没读到、或反解前提不满足）⇒ **原样返回**，
 *     一个字都不改（= 退回收盘口径，行为与加本函数之前逐字节相同）；
 *   · 某只票在 `pctMap` 里没有 / 值为空 ⇒ 保留该行原 `pct`（⛔ 不补 0、不当 0%）。
 *
 * @param {Array|null} rows decision-collect#range10Rows（含「20天」补位行）
 * @param {Map|null} pctMap 9:26 口径区间涨幅（readAuctionLegRangeMap 的返回）
 * @returns {{rows:Array|null, used:boolean}} used=true 表示本次真的用了 9:26 口径（文案据此标注）
 */
function _withAuctionLegPct(rows, pctMap) {
  if (!Array.isArray(rows) || rows.length === 0) return { rows: rows || null, used: false };
  if (!pctMap || typeof pctMap.get !== 'function' || pctMap.size === 0) return { rows: rows, used: false };
  let used = false;
  const out = rows.map(function(r) {
    const nm = String((r && r.name) || '').trim();
    if (!nm) return r;
    const v = pctMap.get(nm);
    const p = v ? _num(v.pct) : null;
    if (p === null) return r;
    if (_num(r.pct) === p) return r;          // 值没变 ⇒ 保持原对象（§19 引用稳定，不白触发下游重算）
    used = true;
    return Object.assign({}, r, { pct: p });
  });
  return { rows: out, used: used };
}

/**
 * ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条：把 range10-backup#pickRange10Backup 选出的
 * 【那一只候补】组装成买点块（形状与 _buildNewDragonBlock / 退潮替补【完全一致】）。
 *
 * ⛔ 为什么必须同形状：块要交给 decision-rules#finishBuyBlock 收口（占比 / 动作标签 / 持有 /
 *   题材标记），少一个字段就是【静默】少一枚标签（不报错、不显示，最难查的那种）。
 *
 * ⛔ 顺序（与另外三段同一条铁律）：
 *   ① 先 finishBuyBlock（拿到客观数据 + 原始买点信号）；
 *   ② 再【覆盖】动作标签为【十日涨幅候补买】—— 它是「常规题材作废后的替换买点」，
 *      不是竞价买 / 尾盘买，也不是退潮替补（用户拍板：单独一枚标签）。
 *
 * §10：票的十日涨幅读不到 ⇒ pctText 显示 '—'，⛔ 不补 0；龙标【留空】
 *   （它不是本题材的龙N，冒充「龙一」会让人以为它是题材龙头）。
 *
 * @param {object} bk   pickRange10Backup 的返回
 * @param {Array} list  当日题材块（取 member 拿 aucShare / code，与另外三段同一取法）
 * @param {object} fOpts finishBuyBlock 的入参
 * @param {{weakTopics?:Array<{topic:string,avgText:string,reasonText:string}>,
 *          top1Topic?:string, top1Name?:string,
 *          grayed?:{topic:string,tag:string}|null, overlap?:{topic:string,tag:string}|null}} [info]
 *        说明文案用的事实（谁作废了 / 总龙一是谁 / 同一只票在上方是什么身份）：
 *        · grayed  = 上方那一块已被改成「不开新仓」并灰化（10-23 兆威机电）；
 *        · overlap = 上方那一块里它是【今天要买】的买点（10-20 海洋王 ⇒ 两条通道叠加确认）。
 * @returns {object|null}
 */
function _buildRange10BackupBlock(bk, list, fOpts, info) {
  const p = bk && bk.pick;
  if (!p || !p.name) return null;
  const name = String(p.name).trim();
  const topic = String(p.topic || '').trim();
  const inf = info || {};
  // ★★ [R10-926 2026-10-24] 本次「十日涨幅 / 名次」用的口径时间（'9:26 竞价口径' / '收盘口径（…未读到）'）。
  //   ⛔ 只在文案里出现，不参与任何判定（§21：模板零计算，文案在 Logic 层拼好）。
  const baseText = String(inf.baseText || '');
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 同一只票在【收盘口径】下的名次（复盘对照，⛔ 不参与选股）。
  //   名次表缺失 / 这只票不在原始池里 ⇒ null ⇒ 下面三处文案一个字都不加（§10 判不出就不猜）。
  const closeInfo = _closeRankOf(inf.closeRankMap, name, p.rank);

  // 真实成员行（与退潮替补 / 新龙同一取法：先按题材块找，再全表按名字兜一次）
  let member = null;
  (list || []).forEach(function(b) {
    if (member) return;
    (b.members || []).forEach(function(m) {
      if (!member && m && String(m.name || '').trim() === name) member = m;
    });
  });

  const pct = _num(p.pct);
  const picks = [{
    seq: 1,
    name: name,
    // ⛔ 龙标留空：它来自十日涨幅榜，与题材内的龙位无关（§10 不冒充「龙一」）
    dragonLabel: '',
    dragonRank: null,
    pct: pct,
    code: String(p.code || (member && member.code) || '').trim(),
    pctText: formatRangePct(pct),
    // ★ 本行专属徽标（Logic 层拼好，模板零计算 §21）：
    //   「9:26 竞价口径 · 十日涨幅第 N 名 · 首次在列」—— ★ [R10-926 2026-10-24] 必须写明【口径时间】：
    //   名次是按早上 9:26 那一刻算的，收盘回看时数值会变，⛔ 不能让人以为那一列是收盘口径。
    range10Label: (baseText ? ('〔' + baseText + '〕') : '') + '十日涨幅第 ' +
      (p.rank === null || p.rank === undefined ? '—' : p.rank) +
      ' 名 · ' + (p.label || '在列次数未知') +
      // ★★ [DUAL-RANK 2026-10-24 用户口径] 收盘口径名次【并列】写在后面（只在两套不同时写，
      //   §11 零噪声）—— 复盘时一眼能看出「早上第 8 名、收盘回看是第 11 名」这种错觉的来源。
      //   ⛔ 前半段（竞价口径）永远是选股用的那一份，顺序不许颠倒。
      (closeInfo && closeInfo.rank !== null && !closeInfo.same
        ? (' · 收盘口径第 ' + closeInfo.rank + ' 名')
        : '') +
      // ★ [R10-NOEXCLUDE 2026-10-24] 与题材买点重叠时把「叠加确认」直接写进徽标 ——
      //   用户要的是「一眼看见确定性」，⛔ 不能只藏在点开后的说明里。
      (inf.overlap ? ' · 叠加确认' : ''),
    // ★ [R10-TRAIL 2026-10-24] 徽标的悬停说明：把「名次」与「屏幕行号」两个数一次讲清，
    //   ⛔ 免得用户看到「第 8 名」却在第 9 行找不到对不上的感觉（两种数法都没错，是口径不同）。
    range10Title: (baseText ? ('涨幅与名次都按【' + baseText + '】算（' + _pct2(pct) +
      '）；收盘后这个数会变，但选股与名次固定为早上那一刻。') : '') +
      '十日涨幅第 ' + (p.rank === null || p.rank === undefined ? '—' : p.rank) +
      ' 名（只算主板名次：创业板 / 科创板 / 北交所不占名次，所以它在屏幕上是第 ' +
      (p.rowNo === undefined || p.rowNo === null ? '—' : p.rowNo) + ' 行）｜' +
      (p.label || '在列次数未知') + ' = 这 10 个交易日里它出现在当日名单的次数' +
      '（含今天；1 次 = 首次在列，2 次 = 二次在列）' +
      // ★★ [DUAL-RANK 2026-10-24 用户口径] 悬停里把两套口径一次讲清。
      //   ⚠️ 只在【确实不同】时才写（§11 零噪声）：老调用方不传 pctMap ⇒ 两张名次表逐项相同
      //      ⇒ 悬停逐字回到加本功能之前的样子（⛔ 不拿一句「两套相同」去污染一条旧文案）；
      //      而且此时 baseText 本身就是「收盘口径（9:26 口径未读到）」，再写一段「收盘口径是第 N 名」
      //      等于同一句话说了两遍。
      //   §10：收盘口径下它【不占名次】这种情况必须写（那是一句新信息，不是重复）。
      (closeInfo && !closeInfo.same
        ? (closeInfo.rank === null
          ? '｜【复盘对照】同一只票在【收盘口径（现价）】下不占名次（非主板 / 缺十日涨幅）—— 屏幕上那一份也没有它。'
          : ('｜【复盘对照】同一只票在【收盘口径（现价）】是第 ' + closeInfo.rank + ' 名（' +
             _pct2(closeInfo.pct) + '） ⇒ 名次与竞价口径不同：这是同一批票在两个时刻' +
             '（早上 9:26 与现价）的排序差异，不是算错了。' +
             '选股永远用【竞价口径】那一份，这里的收盘名次只用于复盘对照。'))
        : '') +
      (inf.overlap
        ? ('｜叠加确认：它同时是上方【' + (inf.overlap.topic || '—') + '】题材块的买点 —— ' +
           '题材通道与市场通道选中同一只票，确定性更高，两处各显示一行')
        : ''),
    // ⚠️ 预置：finishBuyBlock 内部 _markHold 要读它（§6 与 _buildBlock 同一做法）
    aucShare: member ? _num(member.aucShare) : null,
    position: ''
  }];

  const weakText = (inf.weakTopics || []).map(function(w) {
    return '【' + w.topic + '】平均竞价量比 ' + w.avgText + ' ＜ ' + TVRB_CASH_ALERT_AVG_VR +
      '（' + (w.reasonText || '题材量比太小') + '）';
  }).join('；');
  // ★ [R10-926 2026-10-24] 每一只都带【涨幅 + 名次】（只列事实，便于用户逐只核对，⛔ 不下结论）
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 括号里再并一个【收盘口径名次】（两套不同才写）——
  //   复盘时逐只对上号，⛔ 不用再去早盘竞价看板比对一遍。
  let closeDiffN = 0;
  const trailParts = (bk.trail || []).map(function(t) {
    const cs = _closeRankOf(inf.closeRankMap, t.name, t.rank);
    const csText = (cs && cs.rank !== null && !cs.same) ? ('（收盘口径第 ' + cs.rank + ' 名）') : '';
    if (csText) closeDiffN += 1;
    return '【第 ' + t.rank + ' 名 ' + t.name + ' ' + _pct2(t.pct) + csText + '】' +
      (t.reason ? t.reason : (t.label || '') + (t.cnt === 1 || t.cnt === 2 ? ' ⇒ 候选' : '（不是首次 / 二次在列）'));
  });
  const trailText = trailParts.join('；');
  const tierText = (bk.tier === 'first')
    ? '前十名里【有首次在列】⇒ 只选这一只（首次在列优先）'
    : '前十名里【没有可用的首次在列】⇒ 退到【二次在列】里取排名最靠前的这一只';
  const top1Text = inf.top1Name
    ? ('20日涨幅总龙一【' + inf.top1Name + '】（' + (inf.top1Topic || '—') + '）')
    : '20日涨幅总龙一';
  // ★★ [R10-STOCK-LEVEL 2026-10-24 用户口径] 同一只票在上方以「不开新仓」身份出现过
  //   （10-23 兆威机电 属工业4.0，题材平均量比 15.18 ＜ 25 ⇒ 整块灰化空仓）⇒ 必须讲清为什么还选它：
  //   本规则是【股票级】通道（从总市场选股），题材块灰化是【题材级】结论，两者互不否决
  //   ⇒ 同一只票会重复出现一次，这是设计如此（用户原话「上面是重复出现的兆威机电也是逻辑」）。
  const grayed = inf.grayed || null;
  // ★★ [R10-NOEXCLUDE 2026-10-24 第三次修正] 同一只票是上方某题材块的【买点】（10-20 海洋王 / 商业航天）
  //   ⇒ 两条通道叠加确认，⛔ 这不是「重复选错」，也⛔ 不许因为它已被选中就顺延到下一名。
  const overlap = inf.overlap || null;
  const dupText = grayed
    ? ('本股同时也在上方【' + (grayed.topic || '—') + '】题材块里（那一块已被改成【' +
       (grayed.tag || '不开新仓') + '】并灰化，照旧展示、不恢复）—— ' +
       '但本行不是按题材选的，是按【十日涨幅前十 + 在列次数 + 与总龙一不同题材】从全市场选的，' +
       '所以同一只票会重复出现一次。')
    : '';
  const overlapText = overlap
    ? ('本股同时是上方【' + (overlap.topic || '—') + '】题材块里的买点（' +
       (overlap.tag || '买') + '）—— 【题材通道】和【市场通道】同时选中了同一只票：' +
       '这是叠加确认（确定性更高），不是重复选错，也不用分成两只。' +
       '两处照旧各显示一行，看到两次不必担心。')
    : '';

  const block = {
    block: {
      topic: '十日周期候补 · ' + (topic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      members: member ? [member] : []
    },
    rankWord: '',
    pickRank: null,
    reason: '【第' + RANGE10_BACKUP_RULE_NO + '条】十日涨幅候补（★ 股票级通道：从全市场选股，不是选题材）：' +
      (weakText ? (weakText + ' ⇒ 该题材作废；') : '') +
      dupText + overlapText +
      '按「十日涨幅前十 + ' + (bk.tier === 'first' ? '首次在列' : '二次在列') + ' + 与' + top1Text +
      '不同题材」选出 ' + name + '（' + (topic || '—') + '，〔' + (baseText || '当日口径') +
      '〕十日涨幅 ' + _pct2(pct) +
      '，第 ' + p.rank + ' 名，' + (p.label || '') + '）—— 十日周期的新面孔。',
    mode: 'r10backup',
    ruleNo: RANGE10_BACKUP_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '【本规则的性质】科目【股票级】——从【总市场】选股，不参与题材排名、也不受题材量比门槛约束。' +
        '和「题材量比买点」是两条线：那条线先选题材再在题材里选股，这条线只认股票自己的三个条件' +
        '（十日涨幅前十 + 首次/二次在列 + 与 20日涨幅总龙一不同题材）。',
      '【候补怎么选】十日涨幅前 ' + (bk.topN || 10) + ' 名（只算主板名次，非主板不占名次）自上而下：' +
        '跳过题材未知的（判不出是否与总龙一同题材）→ 跳过与' + top1Text + '同类的 ⇒ ' + tierText + '。' +
        '⛔ 不会因为某只票【已经在题材块里当选】就跳过它 —— 那会把最强的票换成更弱的票' +
        '（10-20 事故：海洋王 29.51% 被跳过、换成京城股份 27.26%）。',
      grayed ? ('⚠️ ' + dupText) : '',
      overlap ? ('✅ ' + overlapText) : '',
      '⚠️ 为什么用十日涨幅而不是 20日涨幅：20 日老周期已经结束（总龙二次确认退潮），现在轮到【十日周期】 ——' +
        '龙头的量比都比题材大，十日周期的新面孔才是接下来的核心。20日涨幅列表里的老票会逐渐换成新票，' +
        '本看板 20日涨幅榜上的老面孔也会一天天被十日周期的新票替换掉（这是正常的周期切换，不是数据错乱）。',
      '十个名次去留（' + (baseText || '当日口径') + '，判定可追溯）：' + (trailText || '—') + '。' +
        // ★★ [DUAL-RANK 2026-10-24 用户口径] 括号里的收盘口径名次是什么，一句话交代清楚
        //   （§10：有差异就必须能解释，⛔ 不能让两个数字并排摆着却没人说明）。
        (closeDiffN > 0
          ? ('（括号里的「收盘口径第 N 名」= 同一只票在【收盘口径（现价）】下排第 N 名，' +
             '仅用于复盘对照；【选股与前面的名次一律用竞价口径（9:26）】。' +
             '两套对不上不是算错，是同一批票在早上 9:26 与现价两个时刻的排序差异。）')
          : ''),
      '⚠️ 窗口覆盖：' + (bk.coveredDays || 0) + ' / ' + (bk.windowDays || 10) +
        ' 个交易日有名单数据（在列次数 = 这 ' + (bk.coveredDays || 0) + ' 天里它出现在早盘竞价名单的几次）。'
    ].filter(function(s) { return !!s; })
  };

  // ① 客观数据 + 原始买点信号（同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖动作标签为【十日涨幅候补买】
  (block.picks || []).forEach(function(row) {
    const rawTag = row.buyActionTag || '';
    const rawNote = row.actionNote || '';
    row.buyActionTag = RANGE10_BACKUP_TAG;
    row.buyActionTone = RANGE10_BACKUP_TONE;
    row.holdTag = '';       // 与「今天要买」互斥
    row.position = '';
    row.actionNote = '【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】' +
      (weakText ? (weakText + ' ⇒ 该题材【作废】；') : '') +
      (grayed ? ('⚠️ 本股在上方【' + (grayed.topic || '—') + '】题材块里已被改成【' +
        (grayed.tag || '不开新仓') + '】（题材量比不达标 ⇒ 那一块照旧灰化、不恢复）；' +
        '但本行是【股票级】通道另选出来的，不是那个题材块要买它 —— ') : '') +
      // ★ [R10-NOEXCLUDE 2026-10-24] 与题材通道叠加时也要在行内讲一句（用户会点开行看说明）
      (overlap ? ('✅ 本股同时是上方【' + (overlap.topic || '—') + '】题材块的买点 —— ' +
        '两条通道叠加确认（确定性更高），不是重复选错 —— ') : '') +
      '按「十日涨幅前十 + ' + (bk.tier === 'first' ? '首次在列' : '二次在列') + ' + 与' + top1Text +
      '不同题材」选出本股（〔' + (baseText || '当日口径') + '〕十日涨幅 ' + _pct2(pct) +
      '，第 ' + p.rank + ' 名，' + (p.label || '') + '）。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      ' 这是十日周期的新面孔买点（20日老周期已结束），不是题材量比买点。';
  });

  // 本看板平铺字段
  block.topic = '十日周期候补 · ' + (topic || '—');
  block.rank = null;
  block.count = null;
  block.yiziCount = null;
  block.avgVolRatio = null;
  block.avgVolRatioText = '';
  block.tier = 'r10backup';
  block.pickCount = 1;
  block.rangeText = '';
  block.skippedNames = [];
  block.isRange10Backup = true;
  return block;
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
 * @param {Map} dragonMap  rankDragons(topics) 的返回【卖点侧用】（= 收盘口径，退潮 / 卖点逐字不变）
 * @param {{date?:string, ctx?:object, sellRows?:Array, ebbCtx?:object,
 *          buyDragonMap?:Map, pctMap?:Map, buySkipNames?:Set, prevEbbDay?:object,
 *          ebbHistory?:Array}} [opts]
 *        date     = 展示日（当前已由组合式调 decorateDecisionRows 统一装饰，这里只留作扩展位）
 *        ctx      = decision-collect#collectDecisionTopics(actionContext) 给的标记上下文
 *                   {prevDragonNames, prevBuyNames, prevBought, prevBoughtTopics, topicStreakPast}；
 *                   ⛔ 缺省 = 全部为 null ⇒ 持有 / 昨有买入 / N 次入选 / 先卖后买 / 补涨
 *                   一枚都不打（§10：未知 ≠ 没有），⛔ 绝不在这里用空集合顶替。
 *        sellRows = decision-collect 给的卖点候选行（缺省 ⇒ 不产卖点段）
 *        ebbCtx   = decision-collect#_ebbCtxOf 采好的【退潮日事实】（市场总龙 / 今日停牌 / 今日占比 /
 *                   同题材龙位成员 / 市场总龙二 / 买点侧替补与五只去留）；缺省 / ready=false ⇒ 退潮规则不生效（§10 不猜）
 *        ebbHistory = ★ [EBB-R20] 近 22 个交易日的退潮判定落库行（tvrb_ebb_days，组合式读回注入）——
 *                   「首次 / 二次确认 / 无第三次」的事件计数用；缺省 ⇒ 按 0 次事件（= 首次退潮）。
 *        ebbWindowFrom = ★ [EBB-20D 2026-10-22] 事件窗口起点（= 第 EBB_EVENT_WINDOW_DAYS 个交易日的日期）。
 *                   ⛔ 不能让规则层自己从 ebbHistory 里「取最后 20 行」来近似窗口：落库表按天写，
 *                   没开看板的日子没有行（实测 20 个交易日只有 7 行）⇒ 会数错事件数。
 *                   缺省 ⇒ 退回「按已有日期取最新 20 个」（§11 老调用方零行为变化）。
 *        coreTopics = ★★ [CORE-CAT 2026-10-22 用户口径] 核心词表（getCoreTopics() 的返回）——
 *                   规则层据此把细分题材归到【大类】（「文化传媒」⇒「AI应用」）。
 *                   缺省 / 空 ⇒ 归一是恒等（§11 零行为变化）。
 *        buyDragonMap = ★ [TVRB-926 2026-10-14 用户口径]【买点侧专用】的龙位名册（9:26 口径，
 *                   decision-rules#rankDragonsWithPctMap 的返回）；缺省 ⇒ 退回上面的 dragonMap
 *                   = 旧行为（§11 默认零行为变化）。
 *        pctMap   = ★ [TVRB-926]【买点侧专用】的 9:26 口径区间涨幅（readAuctionLegRangeMap 的返回），
 *                   行上「十日涨幅」取它；缺省 ⇒ 退回成员自带值 = 旧行为。
 *        buySkipNames = ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧的【买不进名单】
 *                   （= 连续停牌第 2 天及以上的票，decision-collect#nonFirstDaySuspendNames 的返回）；
 *                   命中者【买不进 ⇒ 占掉一个名额、不再补位】（与「竞价一字」的顺延补位刻意不同，
 *                   见 _buildBlock 的 [SUSPEND-OCCUPY 2026-10-15] 注释）。
 *                   ⛔ 缺省 / 空集 ⇒ 与旧行为逐字一致（§11）；停牌【首日】不在本名单里（仍可入选）。
 *        prevDate = ★ [EBB-D1 2026-10-21] 展示日的【上一交易日】（组合式用 getPreviousTradingDay
 *                   算好注入，§6 日期口径不进纯函数）—— 「昨日二次确认退潮 ⇒ 次日禁入买点侧」
 *                   （第二十六条）用它去 ebbHistory 里找昨日那一行；缺省 ⇒ 判不出 ⇒ 本规则不生效。
 *        prevPrevDate = ★ [SWITCH 2026-10-22] 展示日的【前两个交易日】—— 第二十八条「切换日」判据
 *                   （二次确认退潮正好发生在 D，今天 = D+2）；缺省 ⇒ 不判切换日。
 *        top5HistoryEver = ★ [SWITCH] 近 20 个交易日【上过 20日涨幅前五】的股票名集合
 *                   （data/range20-top5-history.js#everInTop5Set）；缺省 / null ⇒ 判不出「是否首次上榜」
 *                   ⇒ 切换日不收紧（并在说明里写明原因，§10）。
 *        top5HistoryDays = ★ [SWITCH] 历史榜实际覆盖的天数（只用于说明文案，⛔ 不参与判定）。
 *        range10Rows = ★★ [R10-BACKUP 2026-10-24 用户口径] 当日名单的十日涨幅池
 *                   （decision-collect#collectDecisionTopics 出口的 range10Rows：
 *                    `[{name, code, topic, pct, isYizi, aucPct}]`，pct = 该票当日十日涨幅，
 *                    isYizi = 该票【今日】是否竞价一字涨停 —— true/false/null(补位行判不出)）；
 *                    「十日涨幅前十 / 首次在列 / 与总龙一不同题材」的判定全在 range10-backup.js，
 *                    本文件只用它挑候补。缺省 ⇒ 判不出 ⇒ 候补不生效（§10，⛔ 不猜）。
 *        range10Presence = ★★ [R10-BACKUP] 十日窗口的在列次数 `{counts:Map<name,{cnt}>, coveredDays}`、
 *                   （data/auction-presence.js#getPresenceForDate(date, 10) 的返回）；
 *                   缺省 / coveredDays=0 ⇒ 判不出「首次 / 二次在列」⇒ 候补不生效（§10）。
 *        range20Auc = ★★ [R20-926 2026-10-24 用户口径] 该日【20日涨幅 · 9:26 竞价口径】的主板名次
 *                   （logic/auction/range20-auction-leg.js#readAuctionLegRange20Rank 的返回：
 *                    `Map<股票名, {pct, days, rank}>`，pct 已把 T 腿反解回竞价口径）。
 *                   用途【只有一个】：买点侧【20日涨幅通道】的入选票（退潮替补 / 切换日新龙）
 *                   在说明区写出「9:26 那一刻的涨幅 + 第几名」（只列事实，⛔ 不解释）。
 *                   ⛔ 不参与选股、⛔ 不影响 getRange20Leaders 的发布结果（退潮 / 总龙 / 展示仍走收盘口径）。
 *                   缺省 / 判不出 ⇒ 一条说明都不写（§10 不猜名次；§11 零行为变化）。
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
  // ★ [TVRB-926 2026-10-14] 买点侧专用的 9:26 口径输入（缺省 ⇒ 与卖点共用同一份 = 旧行为，§11）
  const buyDragonMap = (o.buyDragonMap instanceof Map && o.buyDragonMap.size > 0) ? o.buyDragonMap : dragonMap;
  const buyPctMap = (o.pctMap instanceof Map && o.pctMap.size > 0) ? o.pctMap : null;
  // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「买不进名单」= 【连续停牌第 2 天及以上】的票
  //   （= decision-collect#nonFirstDaySuspendNames(rows, date, prevDate) 的返回）。
  //   ⛔ 缺省 / 空集 ⇒ 与旧行为逐字一致（§11）；只影响买点侧选股（退潮 / 卖点不看它）。
  const buySkipNames = (o.buySkipNames instanceof Set && o.buySkipNames.size > 0) ? o.buySkipNames : null;
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
      noYizi: null, smallTopic: null, bigTopic: null, ebbSecond: null,
      // ★ [SWITCH 2026-10-22] 第二十八条：切换日的【新龙】那一行。与 ebbSecond 同一理由挂在
      //   买点对象里 —— decision-collect#_buyBlocksOf 是「遍历一个买点块」的唯一实现，
      //   四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）都经它取块（§6）。
      newDragon: null,
      // ★★ [R10-BACKUP 2026-10-24] 第二十九条：十日涨幅 · 在列次数候补（题材量比太小 ⇒ 作废后替换的那一只）。
      //   同一理由挂在买点对象里（四个装饰器要遍历到它）。
      range10Backup: null
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
    // ★ [EBB-R20c 2026-10-20] 二次确认退潮 + 常规选出补涨题材 ⇒ 买点侧顶部的【节点说明】横幅。
    //   纯文案（判据与 ebbSecondRegular 同一把尺子，§6），只在「二次确认 ∧ blocks 非空」时非 null
    //   （首次退潮 / 二次走兜底 ⇒ null —— 那两种场景卖点横幅 + 灰化已经把状态说满了，不再叠一条）。
    ebbNodeNote: null,
    // ★ [DIVERGE 2026-10-20] 市场总龙一【首次分歧】日的分歧买点块（总龙一 + 跟随高标 ≤2 只）。
    //   只在「总龙首次分歧 ∧ 非退潮日」时非 null（其余场景 null ⇒ 视图 v-if 不渲染）。
    divergeBuy: null,
    // ★★ [SWITCH 2026-10-22] 第二十八条【新龙 / 新题材切换日】：
    //   switchDay = 今天是不是「二次确认退潮」后的第 2 个交易日（判据见 detectSwitchDay）；
    //   newDragon = 那一行新龙的买点块（独立容器、渲染在灰化容器之外）；不是切换日 / 选不出 ⇒ null。
    switchDay: null,
    newDragon: null,
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条【十日涨幅 · 在列次数候补】那一行
    //   （独立容器、渲染在灰化容器之外：今天真要买的那一只不能被 grayscale 吞掉）；
    //   不需要候补 / 选不出 ⇒ null（视图 v-if 不渲染，§10 不拿空壳冒充结论）。
    range10Backup: null,
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

  // ★★ [CORE-CAT 2026-10-22 用户口径] 题材【大类】归一函数 —— 只造一次，下面所有「同题材」判定共用。
  //   用户原话：「AI应用是大类，我在核心管理里把文化传媒放到那个大类了，那个大类就是我说的题材。」
  //   ⛔ 规则层不读 core_topics（§5）：o.coreTopics 由组合式用 getCoreTopics() 注入；
  //      缺省 ⇒ 归一函数退化为恒等 ⇒ 与本参数引入前逐字同行为（§11）。
  const coreRes = makeCoreTopicResolver(o.coreTopics);

  // ★ [EBB 2026-10-13 第五轮用户口径] 退潮日判定 —— 必须排在【题材入选扫描】之前：
  //   [EBB-R20b 2026-10-20 用户口径] 二次确认退潮的买点侧【先按常规选股、排除退潮题材本身】
  //   ⇒ 题材入选扫描需要先知道「退潮的是哪个题材」。它只读【事实】（谁是总龙 / 今天停不停牌 /
  //     占比多少 + 近 20 个交易日的退潮事件），不读 state、不发请求（事实由采集层 / 组合式注入）。
  // ★ [EBB-R8 2026-10-14] 第二个入参 = 【上一交易日落库的退潮判定】（tvrb_ebb_days 表里那一行）
  //   —— 昨日闸门用它；缺省（表不存在 / 那天没记录）⇒ 退化为「用昨日行情行推断」，再取不到按可触发。
  // ★ [EBB-R20 2026-10-20] 第三个入参 = 【近 22 个交易日的退潮判定落库行】——
  //   「首次 / 二次确认 / 无第三次」的事件计数用它；缺省 ⇒ 按 0 次事件（= 首次退潮）处理。
  // ★★ [CORE-CAT 2026-10-22 用户口径] 第四个入参 = 题材【大类】归一函数：
  //   判定说的「题材」= 核心管理里的【大类】（如「AI应用」），不是每日行上的细分串（如「文化传媒」）。

  // ── ①② 先判【切换日】，再决定「今天还判不判退潮」（★ 顺序不能反，见下）──────────────
  // ★★ [CYCLE 2026-10-22 用户口径] 【周期状态】—— 用户明确「引入周期状态：这天是切换日，不再判退潮」：
  //   D      = 二次确认退潮日（10-20）
  //   D+1    = 退潮次日 ⇒ 主轴题材禁买（第二十六条，10-21）
  //   D+2    = 【切换日】（10-22）⇒ 老周期结束、选新龙；**这一天不再判退潮**：
  //            · 总龙占比再不达标 / 再停牌也不重开退潮（否则老周期会被反复「续命」）；
  //            · 买点侧只走第二十八条（新龙 + 常规收紧一只），⛔ 不再走「退潮替补」。
  //   ⛔ 因此 detectEbbDay 必须在【已知今天是不是切换日】之后才决定要不要跑。
  out.switchDay = detectSwitchDay(o.ebbHistory || null, o.prevPrevDate || '', coreRes, o.ebbWindowFrom || '');
  out.ebb = out.switchDay
    ? null
    : detectEbbDay(o.ebbCtx || null, o.prevEbbDay || null, o.ebbHistory || null, coreRes, o.ebbWindowFrom || '');
  if (out.switchDay && o.ebbCtx && o.ebbCtx.ready) {
    // §10：把「今天为什么没有退潮判定」写清楚，⛔ 不能让人误以为「今天没退潮」
    out.notes.push('ℹ️【第二十八条 · 周期状态】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (out.switchDay.topic || '—') + '）已于 ' + out.switchDay.ebbDate +
      ' 【二次确认退潮】⇒ 老周期结束；今天（第 2 个交易日）=【切换日】，按第二十八条选新龙，' +
      '今天【不再判退潮】（占比 / 停牌不再重开退潮事件）。');
  }
  // ★ [EBB-R20b 2026-10-20 用户口径] 二次确认退潮 ⇒ 买点侧【先按常规选股】（排除退潮题材本身）：
  //   用户原话：「二次确认退潮的时候，应该先看常规选股，就是按题材平均量比选股（注意是新题材，
  //   不是退潮那个题材，即使是退潮时这个题材还符合常规选股，但是毕竟它退潮了，所以不选这个题材），
  //   如果符合平均量比的新题材……就按照常规选股就行了。如果排名前二的新题材都没有符合条件，
  //   兜底就是选总市场的排名前面的龙，所以才回到20日涨幅选股法。」
  //   ⇒ 只有【二次确认】走这条路；【首次退潮】维持旧口径（主线第一次坏 ⇒ 整段灰化 + 退潮不买 + 替补）。
  const ebbSecondTopic = (out.ebb && out.ebb.phase === 'second')
    ? String(out.ebb.leaderTopic || '').trim() : '';

  // ── ★★ [R10-BACKUP 2026-10-24] 第二十九条的【前置判据】—— 必须在【选股扫描之前】就知道 ──
  //   为什么提前：扫描完成后要立刻决定「排名第二的题材是不是要整块作废」（用户拍板：整块删除、
  //   只出候补），而 `out.buy.heavy / light` 的槽位赋值就在扫描之后 —— 晚一步就会留下一个
  //   指向已删除块的悬空槽位（那会让四个装饰器遍历到幽灵块）。
  //   `ld` / `divergeActive` 原本在下面（空仓提醒之后），这里只是【读 opts】+ 一步判断，无副作用；
  //   原处改为复用这两个局部常量（值一模一样，§11 零行为变化）。
  const ld = o.leaderDiverge || null;
  const divergeActive = !!(ld && ld.todayFirst && !out.ebb);
  // 本规则【不生效】的三种场景（每一种都有更具体的规则接管，⛔ 不许两条规则同时输出买点）：
  //   ① 首次退潮 / 二次确认但常规选不出（blocks 为空）= 退潮兜底通道（第二十一条退潮替补接管）；
  //   ② 切换日（第二十八条：新龙 + 常规收紧一只）；
  //   ③ 总龙首次分歧日（第二十五条：总龙一 + 高标 ≤2 只）。
  const r10Blocked = !!(out.switchDay) || divergeActive || !!(out.ebb && out.ebb.phase !== 'second');
  // ★ 用户拍板「任何一天都生效」：不再限定二次确认退潮日 ⇒ 只要不落在上面三种场景里就算。
  const r10Enabled = !r10Blocked;
  // ★★ [R10-BACKUP] 候补的【两个输入】是否就绪（§10：缺一 ⇒ 判不出 ⇒ ⛔ 既不出候补、也不作废题材）。
  //   故意写成「同步可判的纯前置检查」（不看结果、不跑判定）：上面的题材作废要在扫描后立刻决定，
  //   而 pickRange10Backup 要等买点名单定型（排除重复票）才能跑 —— 两件事必须解耦。
  //   ⚠️ `r10PoolGiven` 单独留一格：调用方【根本没传】十日涨幅池（老调用方 / 单测）⇒ 一条说明都不加
  //      （§11 零行为变化）；传了但次数没到 ⇒ 才按「数据缺口」如实说明（§10 缺口必须可见）。
  const r10PoolGiven = Array.isArray(o.range10Rows);
  // 🔴🔴 [R10-POOL 2026-10-24 事故修复] 「池子是否与屏幕同一批行」。
  //   事故现场（10-23）：候选池只含当日名单、漏了「20天」补位票（屏幕第 3 行慈文传媒），
  //   ⇒ 名次整体前移一位 ⇒ 主板第 11 名的【上海九百】（屏幕上没有标签）被当成第 10 名顶了上来。
  //   ⇒ 采集层现在会把补位行并进池子，并用 range10PoolComplete 报告「补位数据到了没有」。
  //   ⚠️ 缺省（调用方没给这个键 = 老调用方 / 单测自己造的池子）⇒ 按【完整】处理，
  //      保证 §11 零行为变化；只有采集层明确说 false（补位数据未就绪）才拦。
  const r10PoolComplete = (o.range10Complete !== false);
  const r10DataReady = !!(r10PoolGiven && r10PoolComplete && o.range10Rows.length > 0 &&
    o.range10Presence && o.range10Presence.counts &&
    Number(o.range10Presence.coveredDays) > 0);
  // 被作废的题材（供候补的「不同题材」闸门 + 说明文案用）
  const r10WeakTopics = [];
  // 「整块作废」那一块里的票（名字 -> {topic, tag}）：块被删掉了，但它们仍可能是股票级候补的候选，
  // 说明文案要能交代「它来自刚被作废的那块」（⛔ 不代表它被禁买，只是要让判定可追溯）。
  const r10RemovedPicks = new Map();
  let r10RemovedSecond = null;   // 记录「第二题材因量比太小被整块删除」，供尾部的说明文案使用
  let r10SecondWeak = null;      // 记录「第二题材量比太小」这个事实（即使因数据缺口没删）
  let r10GapNoted = false;       // 「数据缺口已说明」旗子：同一件事只说一次（⛔ 不叠两条告警）
  // ★ [SMALL-TOPIC 2026-10-24 用户口径] 被【小题材收紧】弃掉的题材（排名第一、数量 4~6 只、
  //   当天十日涨幅前十一只都没有）⇒ 尾部不再报「当日只有 N 个题材满足条件」：
  //   那是「今天本来就没这个题材」的读法，与事实（有、但一只都没进前十）相反（§10 不许含糊）。
  //   ⚠️ 必须声明在【扫描循环之前】：循环里 `continue` 之前要给它赋值（下面那段是 TDZ 陷阱高发区）。
  let r10SmallDropped = null;
  // ★★ [R10-926 2026-10-24 用户口径] 十日涨幅池 → 【9:26 竞价口径】（★ 只算一次，三处共用：
  //   ① 本文后面「排名第二题材的龙一是否进前十」这道新闸门；② 第二十九条十日涨幅候补的选股；
  //   ③ 候补 / 闸门的说明文案里的「口径时间」）。
  //   ⚠️ §11：9:26 口径没读到（老调用方 / 单测不传 pctMap）⇒ _withAuctionLegPct 原样返回，
  //     等于退回收盘口径，行为与加这一段之前逐字节相同；文案会如实标注口径时间。
  const r10Rows926Res = _withAuctionLegPct(o.range10Rows || null, buyPctMap);
  const r10Base926 = r10Rows926Res.used;
  const r10BaseText = r10Base926 ? '9:26 竞价口径' : '收盘口径（9:26 口径未读到）';
  const r10Rank926 = _range10RankMapOf(r10Rows926Res.rows);
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 同一份池子的【收盘口径】名次表 —— ⛔ 只喂文案，绝不参与判定。
  //   用途：① 候补行徽标 / 悬停 / 前十去留里并列「收盘口径第 N 名」；② 看板级「两套前十对照」。
  //   §11：调用方没传 9:26 口径（buyPctMap 缺省）⇒ 上面那份 = 原样池子 ⇒ 两张表逐项相同
  //        ⇒ _range10DualTopText 判「没有差异」⇒ 一个字都不出现（零噪声）。
  const r10RankClose = _range10RankMapOf(o.range10Rows || null);


  // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条【新龙 / 新题材切换日】—— 必须排在【选股扫描之前】：
  //   它决定本次扫描是否【收紧】（只选一个题材、只取一只）。
  //   时间轴：D = 二次确认退潮日（10-20）→ D+1 禁买主轴（第二十六条，10-21）→ D+2 = 切换日（10-22）。
  //   ⇒ 判据 = 「二次确认事件」正好落在【前两个交易日】（o.prevPrevDate）。
  //   ⛔ 复用 secondEbbTopicOfPrevDay（同一把尺子），⛔ 不另写一份「昨天是不是二次确认」的计数。
  //   ★ 切换日本身已在上面算过（out.switchDay），这里只负责「从候选里挑新龙」。
  let ndResult = null;          // pickNewDragon 的返回
  let ndJudgeFail = '';         // 判不出的原因（§10 必须可见）
  if (out.switchDay) {
    // ★ [NEW-DRAGON-08 2026-10-22] 候选 = 20日涨幅【前八】（用户「改用排名前八的」）；
    //   采集层把它算在 ebbCtx.newDragonPool 上（与 top5 同一份富化结果，只是多取 3 只）。
    //   ⚠️ 老调用方 / 单测只有 top5 ⇒ 退回 top5（§11 零行为变化，只是候选少几只）。
    const pool = (o.ebbCtx && Array.isArray(o.ebbCtx.newDragonPool) && o.ebbCtx.newDragonPool.length > 0)
      ? o.ebbCtx.newDragonPool
      : ((o.ebbCtx && Array.isArray(o.ebbCtx.top5)) ? o.ebbCtx.top5 : []);
    const ever = (o.top5HistoryEver instanceof Set) ? o.top5HistoryEver : null;
    const winDays = Number(o.top5HistoryDays) || 0;
    if (pool.length === 0) {
      ndJudgeFail = '20日涨幅前八未就绪（数据未到）⇒ 新龙判定不生效';
    } else if (!ever) {
      // ⛔ 历史榜读不到 ⇒ 无法回答「今天是不是首次上榜」⇒ 判不出（⛔ 绝不把「没数据」当「首次」）
      ndJudgeFail = '20日涨幅历史榜未读到 ⇒ 无法判定「今天是否首次上榜」⇒ 新龙判定不生效';
    } else {
      ndResult = pickNewDragon(pool, ever, {
        oldTopic: out.switchDay.topic,
        oldLeaderName: out.switchDay.leaderName,
        windowDays: winDays,
        coreRes: coreRes
      });
    }
  }
  const switchNewDragon = !!(ndResult && ndResult.pick);
  // 收紧只在【新龙成立】时生效（用户口径「如果看20日涨幅没有符合条件……接下来就是常规班选股了，不做限制」）
  // ★ [CYCLE 2026-10-22] 切换日【本身】也收紧：用户原话「10月22日 = 选新龙头 + 常规只选排名第一的
  //   入选题材（只选最前面那个）」。判不出新龙时老周期也已结束 ⇒ 不能退回到「取两个题材」。
  const topicLimit = (switchNewDragon || out.switchDay) ? 1 : TVRB_TOPIC_LIMIT;
  const ndTopic = switchNewDragon ? _normTopic(ndResult.pick.topic, coreRes) : '';
  const ndName = switchNewDragon ? String(ndResult.pick.name || '').trim() : '';

  // 沿题材排名（平均竞价量比降序）往下扫：数量不足的排除并顺延，直到选够 topicLimit 个。
  for (let i = 0; i < list.length; i++) {
    if (out.blocks.length >= topicLimit) break;
    const b = list[i];
    // ★ [EBB-R20b] 二次确认退潮 ⇒ 退潮那个题材【不参与买点入选】—— 题材排名照旧（它还在
    //   out.topics 排名里），只是入选扫描在这里跳过它并顺延到下一个题材（与「数量不足顺延」同路径）。
    //   ⛔ 用户原话「即使是退潮时这个题材还符合常规选股，但是毕竟它退潮了，所以不选这个题材」。
    //   ★ [CORE-CAT 2026-10-22] 改走 _sameTopicLoose（大类归一）：块上是细分串「文化传媒」，
    //     退潮行上是大类「AI应用」⇒ 逐字相等判不出来，必须按大类认亲。
    if (ebbSecondTopic && _sameTopicLoose(b.topic, ebbSecondTopic, coreRes)) {
      out.notes.push('⚠️【' + out.ebb.phaseTitle + '】题材【' + b.topic +
        '】今天【不参与买点选股】（退潮题材不买），买点侧从其余题材按常规（平均竞价量比）顺延选股。');
      continue;
    }
    // ★★ [SWITCH 2026-10-22] 切换日：退潮的【老题材】与新龙自己的题材都不进常规扫描
    //   （老周期已结束不买；新龙题材避免同一题材出两只 —— 今日买点侧 = 新龙 + 另一个新题材各一只）。
    //   ★ [CYCLE 2026-10-22] 判不出新龙时（switchNewDragon=false）这条【老题材排除】也必须生效：
    //     老周期已结束，⛔ 不能因为「新龙没选出来」就把退潮题材重新放进买点侧。
    if (out.switchDay) {
      const bt = String(b.topic || '').trim();
      const oldTopic = _normTopic(out.switchDay.topic, coreRes);
      if (oldTopic && _sameTopicLoose(bt, oldTopic, coreRes)) {
        out.notes.push('⚠️【第二十八条 · 切换日】题材【' + b.topic +
          '】= 老周期（' + oldTopic + ' 二次确认退潮）⇒ 今天不参与常规选股。');
        continue;
      }
      if (ndTopic && _sameTopicLoose(bt, ndTopic, coreRes)) {
        out.notes.push('⚠️【第二十八条 · 切换日】题材【' + b.topic +
          '】= 新龙【' + ndName + '】所在题材 ⇒ 已由新龙那一行买入，常规侧不再重复选。');
        continue;
      }
    }
    let tier = resolveTvrbTier(b.count);
    if (tier.tier === 'none') {
      out.excludedTopics.push({
        rank: b.rank, topic: b.topic, count: b.count, avgVolRatio: avgVolRatioOf(b)
      });
      continue;
    }
    // ★ [SWITCH] 切换日收紧：本题材只取【一只】（龙位最前、非一字、非连续停牌 —— 取票逻辑不变）
    if (out.switchDay) {
      tier = Object.assign({}, tier, { pickCount: 1 });
    }
    // ══ ★★ [SMALL-TOPIC 2026-10-24 用户口径] 排名第一 + 数量 4~6 只 ⇒ 收紧：只买【最强的】 ══
    //
    // 用户原话（逐字，见 TVRB_SMALL_TOPIC_MAX 的注释）：
    //   「遇到入选排名第一的题材数量在4-6只时（不是4-8只，那只是入选股票数量1只条件，我说的这个是
    //     选票范围），条件要苛刻些。如果排名第一的题材数量4-6只，要看10日涨幅，看有没有同题材票
    //     进入前10，如果有就选最靠前那一只，如果没有，就弃掉了。」
    //   「因为这种数量少的，次日能存活下来的顶多有一只。所以就买最强的。要收紧下。」
    //
    // 三个前置（缺一 ⇒ 本条不生效，⛔ 绝不「拿没数据当没进前十」去弃题材）：
    //   ① `out.blocks.length === 0` ⇒ 只在【排名第一】这个块上生效（用户口径点明「排名第一」）；
    //   ② `r10Enabled`              ⇒ 退潮日 / 切换日 / 总龙首次分歧日各有专属规则接管（§6 不叠加）；
    //   ③ `r10PoolGiven`            ⇒ 调用方没传十日涨幅池（老调用方 / 单测）⇒ 整段跳过（§11 零行为变化）。
    //   另：`r10PoolComplete === false`（20 天补位行未就绪 ⇒ 名次会整体错位）⇒ 判不出 ⇒ 只写「未校验」。
    //
    // 三种结果（与第二十九条 / 第二道闸门同一把尺子）：
    //   · 判不出（no-pool / no-row）⇒ 【不弃题材】，照旧按龙位取票 + 说明「未校验」；
    //   · 一只都没进前十（judge='' 且 hits 为空）⇒ **弃掉该题材**（不入选、扫描继续往下顺延），
    //     并把「为什么弃」写成一条看板级说明（§10 缺口 / 否定都必须可见）；
    //   · 有票进前十 ⇒ 只在这几只里取票（前十之外的龙位⛔ 不再补位），顺序仍是【龙位升序】。
    //
    // ★★ 为什么「顺序仍用龙位」而不是「市场名次升序」（这是本条最容易做错的地方）：
    //   用户说的「最靠前」，比较的是【同题材那两只之间】（原话：「新能源汽车有两只入选襄阳轴承和
    //   江淮汽车，前者十日涨幅更加靠前，所以选襄阳轴承」）⇒ 「最靠前」= 组内十日涨幅最高 = 龙位第一，
    //   ⛔ 不是「全市场名次更小」。
    //   两者在数据自洽时【完全等价】（龙位就是按十日涨幅降序发的）；只有龙位名册与十日涨幅池
    //   来自不同口径（某只票 9:26 值缺 ⇒ 各自退回不同数值）时才会出现分歧 ——
    //   那一刻以【买点侧官方龙位名册】为准（§6：买点侧只有这一份名册），⛔ 不让同一只票在
    //   「题材通道」与「龙位」两处得出相反的「谁更强」。
    //   附带好处：10-23 工业4.0（4 只、兆威机电）这个用户已认可的线上结果【一个字节都没变】。
    let smallOpt = null;
    let smallTrace = null;
    if (out.blocks.length === 0 && r10Enabled && r10PoolGiven &&
        tier.tier === 'mid' && b.count >= TVRB_MIN_COUNT && b.count <= TVRB_SMALL_TOPIC_MAX) {
      const smallCountText = '本题材数量 ' + b.count + ' 只（落在 ' + TVRB_MIN_COUNT + '~' +
        TVRB_SMALL_TOPIC_MAX + ' 只的收紧档）';
      // §10：否掉一个题材必须点名（屏幕上有好几个题材时，不带名字的告警等于没说）
      const smallTopicText = '题材【' + String(b.topic || '—') + '】' + smallCountText;
      const probe = r10PoolComplete
        ? _topicTop10Hits(b, r10Rank926)
        : { judge: 'no-pool', hits: [], seen: 0 };
      if (probe.judge === 'no-pool' || probe.judge === 'no-row') {
        out.notes.push('⚠️【小题材收紧 · 未校验】' + smallTopicText +
          '，本该核对「当天十日涨幅〔' + r10BaseText + '〕前十里有没有本题材的票」，但' +
          (probe.judge === 'no-pool'
            ? ('十日涨幅名单' + (r10PoolComplete ? '为空' : '的 20 天补位行还没就绪（名次会整体错位）'))
            : '本题材的票一只都不在十日涨幅名单里') +
          ' ⇒ 判不出 ⇒ 本条【本次不生效】，照旧按龙位取票；数据到货后自动重判。');
      } else if (probe.hits.length === 0) {
        // ★ 弃掉：用户口径「如果没有，就弃掉了」
        r10SmallDropped = { topic: String(b.topic || ''), count: b.count };
        out.notes.push('⛔【小题材收紧 · 本题材不入选】' + smallTopicText +
          '，且【当天十日涨幅〔' + r10BaseText + '〕前十没有一只本题材的票】⇒ 放弃该题材' +
          '（连前十都进不去 = 没有启动性；这种数量少的题材次日能存活下来的顶多有一只，' +
          '不是最强的那只就不买）。买点侧从其余题材按平均竞价量比继续顺延选股。');
        continue;
      } else {
        // ★ 有票进前十 ⇒ 候选序列只保留【前十里的那几只】，顺序照旧（龙位升序 = 组内十日涨幅降序）
        const hitRank = new Map();
        probe.hits.forEach(function(h) { hitRank.set(h.name, h.rank); });
        const order = _dragonCandidates(b, buyDragonMap, buyPctMap).filter(function(c) {
          return hitRank.has(String(c.name).trim());
        });
        if (order.length === 0) {
          // 池子里有名次、龙位名册里却没有（pct 缺值 / 非主板）⇒ 数据对不上 ⇒ 判不出，退回原顺序
          out.notes.push('⚠️【小题材收紧 · 未校验】' + smallTopicText +
            '，十日涨幅名单里本题材有票进了前十，但【龙位名册里没有它们】（十日涨幅缺值）⇒ ' +
            '本次退回按龙位取票；数据补齐后自动重判。');
        } else {
          smallOpt = { order: order, smallTopic: true, baseText: r10BaseText };
          smallTrace = order.map(function(c) {
            return { name: c.name, pct: c.pct, rank: hitRank.get(String(c.name).trim()) };
          });
        }
      }
    }
    const blk = _buildBlock(b, buyDragonMap, tier, buyPctMap, buySkipNames, smallOpt);
    out.blocks.push(blk);
    // ★ 收紧档：把「本题材有哪几只进了前十、最后买了最强的那只」写成事实（用户要能逐只核对）
    if (smallTrace) {
      const hitText = smallTrace.map(function(h) {
        return '第 ' + h.rank + ' 名 ' + h.name + ' ' + _pct2(h.pct);
      }).join('；');
      const got = (blk.picks || []).map(function(p) { return String(p.name || '').trim(); })
        .filter(Boolean).join('、');
      blk.notes.push('★【小题材收紧 · 判定可追溯】当日十日涨幅〔' + r10BaseText + '〕前十里有本题材的票 ' +
        smallTrace.length + ' 只：' + hitText + '（按龙位从高到低）⇒ 只在这个范围里取【最强】的那一只' +
        (got ? '：' + got : '（都在竞价一字 / 连续停牌，实际 0 只 —— 不从前十之外补位）') + '。');
    }
    // ★★ [TVRB-926-DRIFT 2026-10-24 用户口径] 「早上 9:26 龙位」与「收盘龙位」不一致时，
    //   在本题材的说明区讲清「为什么收盘回看时不选那只看似更靠前的票」——
    //   只在【真的不一致】时追加一条，口径一致时一个字都不写（§11 零行为变化）。
    _appendDragonDriftNote(out.blocks[out.blocks.length - 1], dragonMap, !!smallOpt);
  }

  // 决策看板形状的买点计划：第 1 块 → heavy、第 2 块 → light（本看板最多两块，candidates 恒空）
  out.blocks.forEach(function(b, i) {
    if (i === 0) out.buy.heavy = b;
    else if (i === 1) out.buy.light = b;
    else out.buy.candidates.push(b);
  });

  // ── ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条 · 第一段：排名【第二】的题材量比太小 ⇒ 整块作废 ──
  //   用户原话：「排名第二的题材如果量比太小就用十日涨幅首次在列进行候补……题材量比太小禁止选入」
  //           + AskUserQuestion「整块删除，只出候补」。
  //   判据 = 该题材平均竞价量比 < TVRB_CASH_ALERT_AVG_VR（与空仓提醒【同一个门槛常量】，§6 不另立数字）。
  //   §10 两条硬约束（缺一不可，⛔ 否则会「拿没数据当成量比低」把整个题材误作废）：
  //     ① 平均量比读不出来（null）⇒ 【不作废】（未知 ≠ 量比低）；
  //     ② 候补的两个输入（十日涨幅池 + 在列次数）没就绪 ⇒ 【不作废】—— 作废了却给不出替换票，
  //        等于因为一次数据缺口白扔掉一个题材还宣布空仓；此时保持原规则并在说明区写明「判不出」。
  //   ⚠️ 删除后必须重建 heavy / light 槽位：否则 buy.light 还挂着一个已删除的块，
  //      四个装饰器会遍历到幽灵块（那是「静默多渲染一段」的最短路径）。
  if (!r10Blocked && out.blocks.length >= 2) {
    const secondBlk = out.blocks[1];
    const secondAvg = avgVolRatioOf(secondBlk && secondBlk.block);
    if (secondAvg !== null && secondAvg < TVRB_CASH_ALERT_AVG_VR) {
      const weakInfo = {
        topic: String((secondBlk && secondBlk.block && secondBlk.block.topic) || ''),
        avgVolRatio: secondAvg,
        avgText: formatAvgVolRatio(secondAvg)
      };
      r10SecondWeak = weakInfo;
      if (!r10DataReady) {
        // §10：数据缺口必须可见 —— 但只在「调用方确实给了池子」时提示（老调用方 / 单测不传 ⇒ 零打扰）
        if (r10PoolGiven) {
          r10GapNoted = true;
          // ★ [R10-POOL 2026-10-24] 缺口有两种，文案必须分开说：
          //   · 补位行没到 ⇒ 名次这把尺子整体错位（10-23 上海九百 事故的直接原因）；
          //   · 在列次数没到 ⇒ 分不出「首次 / 二次在列」。
          //   ⛔ 合写成一句「十日涨幅池 / 在列次数还没读到」等于把根因藏起来，用户没法判断要不要等。
          const r10GapWhy = !r10PoolComplete
            ? '十日涨幅榜的【20 天补位行】还没就绪（候选池与屏幕上那十行对不上，名次会整体错位）'
            : '【十日窗口在列次数】还没读到';
          out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 题材量比太小】排名第二的入选题材【' +
            weakInfo.topic + '】平均竞价量比 ' + weakInfo.avgText + ' ＜ ' + TVRB_CASH_ALERT_AVG_VR +
            '，本该禁止选入；但' + r10GapWhy + ' ⇒ 判不出候补票，' +
            '本次【暂不作废】该题材（保持原规则照常列出）。数据到货后会自动重判（§10：判不出 ≠ 作废）。');
        }
      } else {
        r10RemovedSecond = weakInfo;
        r10WeakTopics.push({
          topic: weakInfo.topic,
          avgText: weakInfo.avgText,
          reasonText: '排名第二的入选题材，题材量比太小 ⇒ 禁止选入（整块作废）'
        });
        // ★ [R10-STOCK-LEVEL 2026-10-24] 记下这一块里的票：块会被整块删除，但【股票级通道】的候补
        //   有可能正好选中其中一只（题材不选 ≠ 这只票不能被选）⇒ 说明文案要能讲清它的来历。
        (secondBlk.picks || []).forEach(function(p) {
          if (p && p.name) {
            const nm = String(p.name).trim();
            if (!r10RemovedPicks.has(nm)) {
              r10RemovedPicks.set(nm, { topic: weakInfo.topic, tag: '整块作废' });
            }
          }
        });
        // ⚠️ 槽位必须一起重建（§6 唯一实现：_dropSecondBlockSlot）
        _dropSecondBlockSlot(out);
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 题材量比太小】排名第二的入选题材【' +
          weakInfo.topic + '】平均竞价量比 ' + weakInfo.avgText + ' ＜ ' +
          TVRB_CASH_ALERT_AVG_VR + ' ⇒ 该题材【禁止选入】（已整块作废，不列股票），' +
          '改用【十日涨幅前十 + 首次在列】的主板新面孔候补。');
      }
    }
  }

  // ── ★★ [SECOND-LEADER-10 2026-10-24 用户口径] 第二道闸门：排名第二的入选题材，
  //    它的【龙一】必须进入当天十日涨幅前十（9:26 竞价口径）──────────────────────────────
  //   用户原话：「排名第二的题材规则，还需要完善下，添加规则，这个题材的龙一是否进入当天的
  //     10日涨幅前十？如果没进入，也不能选，只选排名第一的那个题材股票」
  //   「排名第二题材入选规则是，平均量比符合，题材龙一进入当天十日涨幅前十（竞价口径），
  //     只有满足这个条件。才能入选买点侧。」
  //   「连它的龙一都没有进入当天的十日涨幅，说明没有带动性，后续基本上涨概率不大，风险很高。」
  //
  //   为什么是【必要条件】（⛔ 不许有人改成「判不出就放行」）：用户给的判据是「没有带动性 ⇒
  //     上涨概率不大、风险很高」—— 没被验证过的带动性，按用户口径就是不能买。
  //
  //   ⚠️ 顺序铁律（⛔ 别把这段挪到上面）：必须排在【题材量比太小 ⇒ 整块作废 + 走十日涨幅候补】之后。
  //     那一档要留 `r10RemovedSecond` 给候补当扳机；本段若抢先摘块，候补就永远不会被触发。
  //   ⚠️ 用户明说「只选排名第一的那个题材股票」⇒ 被否后【不顺延到排名第三】：
  //     ⛔ 不补位、不 continue，第 2 个槽位直接空着（更弱的题材更不可能过这道闸）。
  //   ⚠️ §11：调用方【根本没传十日涨幅池】（老调用方 / 单测）⇒ 整段跳过，行为与加本规则之前逐字节相同。
  //   ⚠️ §10：池子不可用（传了但补位行没就绪 / 池子为空）或龙一没出现在池子里 ⇒ **判不出** ⇒
  //     本次【不启用】这道闸（保持原规则），并如实说明 —— ⛔ 绝不把「没数据」当成「没进前十」去否题材
  //     （那与第二十九条「数据缺口 ⇒ 暂不作废」是同一把尺子，两处口径必须一致）。
  //   ✅ 只有【真的算出了名次】**且名次 > 前十**（或龙一在池子里却排不出名次）时，才否掉该题材。
  let r10SecondNoLead = null;      // 本轮被这道闸否掉的第二题材（供尾部说明避免自相矛盾）
  if (r10Enabled && out.blocks.length >= 2 && r10PoolGiven) {
    const secondBlk = out.blocks[1];
    const secondTopic = String((secondBlk && secondBlk.block && secondBlk.block.topic) || '').trim();
    const firstTopic = String((out.blocks[0] && out.blocks[0].block && out.blocks[0].block.topic) || '').trim();
    const gate = r10PoolComplete
      ? _secondTopicLeaderInTop10(secondBlk.block, buyDragonMap, r10Rank926)
      : { ok: false, judge: 'no-pool', dragonName: '', rank: null, pct: null };
    // 判不出的三种情形（⛔ 不否题材，只说清楚「没校验」——§10 判不出 ≠ 判出 false）
    const undecidable = (gate.judge === 'no-pool' || gate.judge === 'no-row' || gate.judge === 'no-dragon');
    if (gate.ok) {
      // 达标也要留一行事实：用户回看时能核对「这道闸是怎么过的」（§10 判定可追溯）
      out.notes.push('ℹ️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic + '】通过：' +
        '它的龙一【' + gate.dragonName + '】当日十日涨幅〔' + r10BaseText + '〕' +
        _pct2(gate.pct) + ' 第 ' + gate.rank + ' 名（前十名内 ⇒ 有带动性）。');
    } else if (undecidable) {
      // ⛔ 同一件数据缺口只说一次（避免与第二十九条「暂不作废」那条叠成两句）
      if (!r10GapNoted) {
        r10GapNoted = true;
        const gapWhy = (gate.judge === 'no-dragon')
          ? '该题材【没有龙一】（组内没有可占龙位的主板票）'
          : (gate.judge === 'no-row'
            ? ('它的龙一【' + gate.dragonName + '】不在当天的十日涨幅名单里')
            : ('【十日涨幅名单】' + (r10PoolComplete ? '为空' : '的 20 天补位行还没就绪（名次会整体错位）')));
        out.notes.push('⚠️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic + '】本次' +
          '【未校验】（保持原规则照常列出）：' + gapWhy + ' ⇒ 判不出它的龙一进没进前十。' +
          '数据到货后会自动重判（§10：判不出 ≠ 没进前十）。');
      }
    } else {
      const rankText = (gate.rank === null)
        ? '排不出名次（没有十日涨幅 / 非主板 ⇒ 不在那十枚标签里）'
        : ('第 ' + gate.rank + ' 名');
      r10SecondNoLead = { topic: secondTopic, judge: gate.judge };
      // ⚠️ 槽位必须一起重建（§6 唯一实现：_dropSecondBlockSlot）
      _dropSecondBlockSlot(out);
      out.notes.push('⚠️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic +
        '】本次【不入选】：它的龙一【' + gate.dragonName + '】当日十日涨幅〔' + r10BaseText + '〕' +
        _pct2(gate.pct) + ' ' + rankText + '，没有进入前十（第 ' + PRESENCE_TOP_N + ' 名以内才达标）。' +
        '连它的龙一都没有进入当天的十日涨幅，说明没有带动性，后续基本上涨概率不大，风险很高。' +
        '⇒ 本日买点侧只选排名第一的题材【' + firstTopic + '】的股票' +
        '（⛔ 不顺延到排名第三的题材）。');
    }
  }

  // ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒：只看【能入选的】排名第一题材（blocks[0]）。
  //   ⛔ 放在选股【之后】、且只读不写 —— 命中时股票照常列在下面（用户原话「还是按照原来的正常方式
  //      选出排名第一，第二的题材的股票，只是……多添加了空仓提醒文字」）。
  // ★ [EBB-R20b 2026-10-20] 标语接管口径：
  //   · 首次退潮 / 二次确认但【常规选不出补涨题材】（blocks 为空 = 排名前二的新题材都不符合条件）
  //     ⇒ 退潮口径接管 cashAlert（整段灰化 + 买点侧替补/空仓标语）—— 这就是用户说的「兜底」；
  //   · 二次确认且常规选出了补涨题材 ⇒ cashAlert 走【常规判据】（买点侧正常显示；
  //     退潮信息走行内说明 + 卖点横幅，⛔ 不再拿「建议空仓」标语顶掉常规选股的结果）。
  const ebbSecondRegular = !!(ebbSecondTopic && out.blocks.length > 0);
  out.cashAlert = buildCashAlert(out.blocks[0], (out.ebb && !ebbSecondRegular) ? out.ebb : null);

  // ★ [DIVERGE 2026-10-20 用户口径] 市场总龙一【首次分歧】日：
  //   「市场总龙一，第一次出现分歧的时候，是买点……标签应该是下杀买。题材量比买点侧只有市场总龙一，
  //    还有其它不同题材的两只高标股票（20日涨幅前五的），同题材的不要……最多三只。」
  //   ld 由组合式下发（K 线 bars + 行情竞价涨幅算出的判定，§10 判不出 ⇒ null）。
  //   ⛔ 优先级：【退潮 > 总龙首次分歧 > 空仓提醒】—— 退潮日（题材预期差）不谈分歧买点；
  //     分歧日若同时量比低，分歧接管（本日买点侧就是那 ≤3 只）。
  //   ★ [R10-BACKUP 2026-10-24] `ld` / `divergeActive` 已上移到【选股扫描之前】（见那里的长注释）。

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

  // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条：把【新龙】那一行构造出来（独立容器渲染）。
  //   ① 必须先有 fOpts（finishBuyBlock 要它算客观数据与原始买点信号）；
  //   ② 它的标签随后被覆盖成【新龙买】—— 与退潮替补 / 分歧买点同一范式（⛔ 不改 finishBuyBlock 内部）。
  if (switchNewDragon) {
    out.newDragon = _buildNewDragonBlock(
      ndResult, list, fOpts, out.switchDay, Number(o.top5HistoryDays) || 0,
      (out.blocks[0] && out.blocks[0].picks && out.blocks[0].picks[0])
        ? ((out.blocks[0].picks[0].dragonLabel || '') + out.blocks[0].picks[0].name)
        : ''
    );
    if (out.newDragon) out.buy.newDragon = out.newDragon;
    out.notes.push('⚠️【第二十八条 · 切换日】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (out.switchDay.topic || '—') + '）二次确认退潮（' + out.switchDay.ebbDate +
      '）后第 2 个交易日 ⇒ 老周期结束、找新龙：买点侧 = 【新龙】' + ndName + '（' + (ndResult.pick.topic || '—') +
      '）+ 常规收紧后的【一只】（只选一个题材、只取一只）。');
  } else if (out.switchDay) {
    // §10：切换日到了但判不出新龙 ⇒ 必须说清原因，并明确「回落常规（但仍只取排名第一的那一个题材）」
    // ★ [CYCLE 2026-10-22] 收紧不因「判不出新龙」而取消：用户原话「10月22日……常规只选排名第一的
    //   入选题材（只选最前面那个）」—— 老周期已在昨天结束，今天不可能再买两个题材。
    out.notes.push('⚠️【第二十八条 · 切换日】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (out.switchDay.topic || '—') + '）二次确认退潮后第 2 个交易日 = 切换日，' +
      (ndJudgeFail ? (ndJudgeFail + '。') : '但 20日涨幅前八里【没有】符合「首次上榜 + 不同题材」的新龙。') +
      ' ⇒ 买点侧【回落常规选股：只选排名第一的入选题材、只取一只】（第二十八条）。' +
      ((ndResult && ndResult.trail && ndResult.trail.length > 0)
        ? (' 八只去留：' + ndResult.trail.map(function(t) {
          return '【' + (totalDragonLabel(Number(t.rank20) || 0) || '总龙?') + t.name + '】' + t.reason;
        }).join('；') + '。')
        : ''));
  }

  // ★ [EBB 2026-10-13 第六轮用户口径] 退潮首日 ⇒ 买点动作【覆盖式】重写：
  //   「退潮当天，只有卖没有买」「买点侧还标有 持有 竞价买，应该标的是『退潮不买』」。
  //   把每行的【持有】/【竞价买】/【尾盘买】…一律换成【退潮不买】（含仓位槽）。
  //   ⛔ 必须排在 finishBuyBlock【之后】（要覆盖它刚算出来的标签）；
  //   ⛔ 客观数据（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）一行不动。
  // ★ [CASH-ALERT-NOBUY 2026-10-16 用户口径] 空仓提醒（★ 非退潮日）⇒ 买点动作同样【覆盖式】重写：
  //   「这个提示下的买点侧，全部变成灰色（卖点侧不变），买点侧股票标签改成"分歧日不买"」。
  //   ★ 优先级：退潮（首次 / 二次确认走兜底）⇒ 【退潮不买】；其余命中空仓提醒 ⇒ 【分歧日不买】。
  //   ★ [EBB-R20b] 二次确认 + 常规选出了补涨题材 ⇒ 买点侧【按常规规则走】：
  //     常规的空仓提醒（第一新题材量比 < 25）照常生效（分歧日不买），退潮只写进行内说明 ——
  //     用户本轮口径「如果符合平均量比的新题材……就按照常规选股就行了」。
  if (out.ebb && !ebbSecondRegular) {
    _applyEbbBuyRules(out.blocks, out.ebb);
  } else if (divergeActive) {
    // ★ [DIVERGE] 分歧日：其余入选票【总龙分歧不买】（照常列出 + 灰化），
    //   大字标语接管 cashAlert（同一消费通道，视图灰化判据 = cashAlert.show 不变）。
    out.divergeBuy = _buildDivergeBuyBlock(ld, list, fOpts);
    out.cashAlert = _buildDivergeCashAlert(ld, out.divergeBuy ? (out.divergeBuy.picks || []).length : 1);
    _applyDivergeNoBuyRules(out.blocks, ld);
    out.notes.push('⚠️【总龙首次分歧】市场总龙一【' + (ld.leaderName || '—') + '】' +
      (ld.firstBoardYmd ? '自首板 ' + ld.firstBoardYmd + ' 以来' : '') +
      '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日：买点侧只有 总龙一（下杀买）+ ' +
      '不同题材的主板高标 ≤2 只（第二十五条），其余入选票今天不开新仓。');
  } else if (out.cashAlert.show) {
    _applyCashAlertBuyRules(out.blocks, out.cashAlert);
  }

  // ★★ [EBB-D1 2026-10-21 用户口径] 昨日【二次确认退潮】的题材 ⇒ 次日禁入买点侧（第二十六条）。
  //   用户原话：「主线题材如果昨天已经二次确认退潮了，次日就不要进入买点侧了，也就是说次日即使
  //     这个题材符合平均量比的条件，题材平均量比排名第二，也不应该买了，因为风险很高。其它题材可以。
  //     ……你把买点侧的主线题材入选的票的区域，变成灰色，不用去掉，其它题材不变。」
  //   ⛔ 为什么必须排在上面三条改写【之后】：本规则是【按题材】的覆盖式后处理（更具体的理由
  //     要写进行内说明）。
  //   ★ 优先级关系：今日若是退潮日（out.ebb 生效）⇒ 全段已被 _applyEbbBuyRules 灰化改写，本规则
  //     只是再叠一层【更具体的题材级说明】（同一枚标签，幂等）；分歧日同理（该题材块从
  //     【总龙分歧不买】细化为【退潮不买】，理由更准）。prevDate / ebbHistory 缺省 ⇒ 判不出 ⇒ 零行为（§11）。
  //   ⛔ 题材块【不删】：用户明确「不用去掉，其它题材不变」⇒ 照常入选占位 + 整块灰化 + 标签改【退潮不买】。
  //   ⚠️ 买点名单（buyNames）在本函数后段组装 ⇒ 组装完后要把禁入题材的票【剔除】（见下方
  //      [EBB-D1] 剔除段）—— 禁入的票今天不买 ⇒ 卖点侧不因它标【持有】，与退潮题材被 R20b
  //      排除出选股 ⇒ 同样不进名单，是同一不变式。
  const prevSecondEbb = secondEbbTopicOfPrevDay(o.ebbHistory || null, o.prevDate || '', coreRes, o.ebbWindowFrom || '');
  if (prevSecondEbb) {
    _applyPrevEbbSecondNoBuy(out.blocks, prevSecondEbb, coreRes);
    out.notes.push('⚠️【' + prevSecondEbb.topic + '】昨日已二次确认退潮（第二十六条）：该题材今天【禁止买入】，' +
      '入选票照常列出但整块灰化、动作标签一律【' + EBB_NO_BUY_TAG + '】；其它题材不变。');
  }

  // ── ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条 · 第二段：造出那【一只】十日涨幅候补 ──────
  //   触发条件（用户两段原话合起来）：
  //     ① 排名【第一】的入选题材平均量比 < 25（= 空仓提醒已命中）——「也一率作废，进入候选的是
  //        十日涨幅题目新股票排名靠前的新股票」；AskUserQuestion「空仓标语保留 + 另给候补」；
  //     ② 排名【第二】的题材已被上面整块作废 —— 用户：「进行替换」。
  //   ⛔ 只造【一只】（用户：「有首次在列的只选一只」），造不出 ⇒ 依说明「依旧空仓」。
  //   ⛔ 必须排在【所有买点改写之后】：
  //     · `_applyCashAlertBuyRules` 会把常规块打成【分歧日不买】+ 整段灰化 —— 候补若先造出来就会被一起灰掉，
  //       而它是今天【唯一还能买】的那一只（视图把它渲染在灰化容器之外，语义必须一致）；
  //     · `_applyPrevEbbSecondNoBuy` 同理（题材级灰化）。
  //   ⛔ 也不许先于 `fOpts` / `out.newDragon`：候补块要走 finishBuyBlock，且要避开已被选走的票。
  const r10LeadWeak = !!(out.cashAlert && out.cashAlert.show && out.cashAlert.avgVolRatio !== null);
  const r10Need = r10Enabled && r10DataReady && (r10LeadWeak || !!r10RemovedSecond);
  // §10：该给候补却因为次数没读到而给不出 ⇒ 如实说一句（⛔ 沉默会让人以为「今天本来就没有候补」）。
  //   只在「调用方确实给了池子」时提示；弱题材那条已经说过（r10GapNoted）就不重复。
  if (r10Enabled && r10PoolGiven && !r10DataReady && !r10GapNoted && (r10LeadWeak || !!r10SecondWeak)) {
    // ★ [R10-POOL 2026-10-24] 缺口有两种，文案必须分开说（口径不同、用户要采取的动作也不同）：
    //   · 补位行没到 ⇒ 名次这把尺子整体错位（10-23 上海九百 事故就是这个）；
    //   · 在列次数没到 ⇒ 分不出「首次 / 二次」。
    const r10GapWhy = !r10PoolComplete
      ? '十日涨幅榜的【20 天补位行】还没就绪 ⇒ 候选池与屏幕上那十行对不上（名次会整体错位）'
      : '十日窗口的在列次数（auction_presence）还没读到 ⇒ 无法判断「首次 / 二次在列」';
    out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【判不出候补】：' +
      r10GapWhy + '。数据到货后会自动补算（§10：判不出 ≠ 今天没有候补）。');
  }
  if (r10Need) {
    // 20日涨幅总龙一（不同题材闸门的对照物）：由采集层富化在 ebbCtx.top5[0]（§6 同一份事实）；
    //   取不到 ⇒ 判不出「是否同题材」⇒ ⛔ 不选票（§10 不猜）。
    //   🔴 [R10-GATE 2026-10-24] 从「传空就放行」改成【硬闸门】：用户口径是
    //   「和 20日涨幅的总龙一不同题材 + 排名前十，这几个条件同时满足，不然都要空仓」——
    //   总龙一题材未知时，这条「不同题材」根本没被验证过，选出来的票就是没依据的。
    const r10Top1 = (o.ebbCtx && Array.isArray(o.ebbCtx.top5) && o.ebbCtx.top5[0]) ? o.ebbCtx.top5[0] : null;
    const r10Top1Topic = r10Top1 ? String(r10Top1.topic || '').trim() : '';
    const r10Top1Name = r10Top1 ? String(r10Top1.name || '').trim() : '';
    const r10Top1Missing = !r10Top1Topic;
    // ── 上方每一只票的【身份】（只用于说明文案，⛔ 不参与选票）─────────────────────
    // 🔴🔴 [R10-STOCK-LEVEL 2026-10-24 用户口径 · 第三次修正（10-20 事故）]
    //   第一次修正：题材灰化/作废不能否决这只票（10-23 兆威机电）。
    //   第二次修正：本通道是【选股票】不是【选题材】，同一只票可以在灰化块里重复出现。
    //   ★ 第三次修正（本次）：「10月20日，十日候补题材你选了京城股份，实际上是海洋王，因为
    //     海洋王已经选在了下面题材商业航天题材中，所以你选排在后一名的京城股份？这是不对的。」
    //     「出现多只首次在列只选一只最强的，也就是十日涨幅最高的，那就是海洋王。」
    //     「这种情况是题材和市场选票叠加的效果，这是好事啊，因为两边都选了海洋王，两个提示板
    //       整合成一个叠加在一起就可以了，这是确定性啊。意思是它即是题材选出来的，也是市场
    //       选出来的。两者叠加一起，也不用分开了。」
    //   ⇒ 两条铁律：
    //     ① ⛔ 绝不因为「它已在某个题材块里当选买点」就把候补【顺延到下一名】——
    //        那等于用更弱的票顶掉最强的票（10-20：海洋王 29.51% 被顶掉，换成京城股份 27.26%）；
    //     ② 同一只票被两条通道同时选中 = 【叠加确认】，两处各展示一行 + 说明区讲清「确定性」。
    //   于是这两张 Map 只收集「它在上方是什么身份」，用来写文案：
    //     · r10NoBuyInfo    = 灰化 / 整块作废（不开新仓）⇒ 要解释「那一块照旧灰化、不恢复」；
    //     · r10RealPickInfo = 今天【确实要买】的买点 ⇒ 要解释「两条通道叠加确认」。
    //   判据用【色调】而不是标签文案：三处「不开新仓」的改写（退潮 / 分歧 / 空仓）都统一 tone = nobuy
    //   （CASH_NO_BUY_TONE = DIVERGE_NO_BUY_TONE = EBB_NO_BUY_TONE），§6 一处真相。
    const r10NoBuyInfo = new Map();      // 股票名 -> { topic, tag }：上方以「不开新仓 / 整块作废」身份出现过
    const r10RealPickInfo = new Map();   // 股票名 -> { topic, tag }：上方以【今天确实要买】身份出现过
    // 先把「被整块作废的那块」里的票铺进去（它们的块已经不在 out.blocks 里了）
    r10RemovedPicks.forEach(function(v, k) { r10NoBuyInfo.set(k, v); });
    const _r10IsNoBuyPick = function(p) {
      return !!(p && p.buyActionTone === EBB_NO_BUY_TONE);
    };
    out.blocks.forEach(function(b) {
      const bt = String((b && b.block && b.block.topic) || '').trim();
      (b.picks || []).forEach(function(p) {
        if (!p || !p.name) return;
        const nm = String(p.name).trim();
        if (_r10IsNoBuyPick(p)) {
          if (!r10NoBuyInfo.has(nm)) r10NoBuyInfo.set(nm, { topic: bt, tag: String(p.buyActionTag || '') });
          return;                        // 灰化 / 整块作废 ⇒ 只记身份，不参与排除
        }
        // ⚠️ [R10-NOEXCLUDE 2026-10-24] 今天【确实要买】的票同样只记身份，⛔ 不再排除
        //   （10-20 事故：海洋王 商业航天 已当选 ⇒ 被排除 ⇒ 顺延成京城股份，用更弱的票顶掉最强）
        if (!r10RealPickInfo.has(nm)) {
          r10RealPickInfo.set(nm, { topic: bt, tag: String(p.buyActionTag || '') });
        }
      });
    });
    [out.newDragon, out.ebbBuy].forEach(function(x) {
      if (!x) return;
      const xt = String((x.block && x.block.topic) || '').trim();
      (x.picks || []).forEach(function(p) {
        if (!p || !p.name || _r10IsNoBuyPick(p)) return;
        const nm = String(p.name).trim();
        if (!r10RealPickInfo.has(nm)) {
          r10RealPickInfo.set(nm, { topic: xt, tag: String(p.buyActionTag || '') });
        }
      });
    });
    // ── 必须避开的题材 ────────────────────────────────────────────────────────────
    // 🔴 [R10-STOCK-LEVEL] 只留【20日涨幅总龙一所在题材】这一条。
    //   用户口径里它是唯一的题材约束，而且它不是「题材筛选」而是【周期筛选】：
    //   「20 日老周期结束，现在轮到十日周期」⇒ 买老周期的同一题材 = 没换周期，等于白换。
    //   ⛔ 当日被作废的弱题材【不再】参与排除 —— 题材量比不达标是【题材块】的事（灰化/作废照旧），
    //     而本通道是「从总市场选股」，龙头自己的强度与题材平均量比本来就是两回事
    //      （用户原话：「龙头的量比都比题材大，那才是核心」）。
    const r10ExcludeTopics = [];
    if (r10Top1Topic) r10ExcludeTopics.push(r10Top1Topic);

    const r10Presence = o.range10Presence || null;
    // ★ [R10-926] 池子与口径在选股扫描之前已经算好（一次），这里直接复用（⛔ 不重算第二遍）
    const r10Rows926 = r10Rows926Res.rows;
    // ⛔ [R10-NOEXCLUDE 2026-10-24] 不传任何「已占用」名单：选票只认 涨幅名次 + 在列次数 + 总龙一题材。
    const r10Res = r10Top1Missing ? null : pickRange10Backup(r10Rows926, {
      counts: r10Presence ? r10Presence.counts : null,
      coveredDays: r10Presence ? r10Presence.coveredDays : 0,
      excludeTopics: r10ExcludeTopics,
      // 题材认亲走【大类归一】的同一把尺子（「文化传媒」与「AI应用」必须认成同一题材，§6）
      sameTopic: function(a, b) { return _sameTopicLoose(a, b, coreRes); }
    });
    if (r10Top1Missing) {
      out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【判不出候补】：' +
        '20日涨幅总龙一（及其题材）还没就绪 ⇒ 无法验证用户要求的「必须与总龙一不同题材」这道闸门 ⇒ ' +
        '不猜（§10：判不出 ≠ 今天没有候补）。');
    } else if (r10Res && r10Res.pick) {
      // ★ [R10-STOCK-LEVEL 2026-10-24] 这只票在上方题材块里是什么身份 —— 决定文案怎么讲「为什么会出现两次」：
      //   · grayed（灰化 / 整块作废）：那一块照旧灰化、不恢复（10-23 兆威机电 = 工业4.0 灰化块）；
      //   · overlap（今天【确实要买】的买点）：两条通道叠加确认 = 确定性（10-20 海洋王 = 商业航天买点）。
      const r10Grayed = r10NoBuyInfo.get(String(r10Res.pick.name).trim()) || null;
      const r10Overlap = r10RealPickInfo.get(String(r10Res.pick.name).trim()) || null;
      const r10Blk = _buildRange10BackupBlock(r10Res, list, fOpts, {
        weakTopics: r10WeakTopics,
        top1Topic: r10Top1Topic,
        top1Name: r10Top1Name,
        grayed: r10Grayed,
        overlap: r10Overlap,
        // ★★ [R10-926 2026-10-24] 本次名次是按哪套口径算的（只影响文案的「口径时间」标注，§21）
        baseText: r10BaseText,
        // ★★ [DUAL-RANK 2026-10-24 用户口径] 收盘口径名次表（复盘对照用，⛔ 不改选股）
        closeRankMap: r10RankClose
      });
      if (r10Blk) {
        out.range10Backup = r10Blk;
        out.buy.range10Backup = r10Blk;
        const r10Grayed = r10NoBuyInfo.get(String(r10Res.pick.name).trim()) || null;
        const r10Overlap = r10RealPickInfo.get(String(r10Res.pick.name).trim()) || null;
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】买点侧追加这一只：' +
          r10Res.pick.name + '（' + (r10Res.pick.topic || '—') + '，〔' + r10BaseText + '〕十日涨幅 ' +
          _pct2(r10Res.pick.pct) + ' 第 ' + r10Res.pick.rank +
          ' 名，' + (r10Res.pick.label || '') + '，与 20日涨幅总龙一' +
          (r10Top1Name ? ('【' + r10Top1Name + '】（' + (r10Top1Topic || '—') + '）') : '') +
          '不同题材）⇒ 十日周期的新面孔。' +
          // ★ [R10-STOCK-LEVEL 2026-10-24] 这条通道是【选股票】不是【选题材】：
          //   同一只票可能正在上方被灰化的题材块里（10-23 兆威机电 / 工业4.0）—— 题材块灰化不恢复，
          //   但它凭「十日涨幅前十 + 首次在列」独立成立，因此会重复出现一次。
          (r10Grayed
            ? ('（注：本股也在上方【' + (r10Grayed.topic || '—') + '】题材块里，那块是【' +
               (r10Grayed.tag || '不开新仓') + '】且照旧灰化、不恢复；' +
               '本行是按【股票级】通道另选的，所以同一只票会出现两次，这是设计如此。）')
            : '') +
          // ★★ [R10-NOEXCLUDE 2026-10-24 第三次修正] 与【题材通道选中同一只票】= 叠加确认：
          //   这不是重复选错，是两条独立的通道同时指向一只票 ⇒ 确定性更高（用户原话「这是好事啊」）。
          (r10Overlap
            ? ('（注：本股同时是上方【' + (r10Overlap.topic || '—') + '】题材块里的买点（' +
               (r10Overlap.tag || '买') + '）—— 【题材通道】和【市场通道】同时选中了同一只票，' +
               '这是叠加确认（确定性更高），不是重复选错；两处照旧各展示一行，不用合并也不用再选第二只。）')
            : ''));
        // ★★ [R10-YIZI 2026-10-24] §10：这只候补【今日竞价数据缺失】⇒ 判不出是否一字板。
        //   仍然选它（⛔ 不因为「不知道」就否掉一个合格候选），但必须把这个缺口如实说出来 ——
        //   「默默当成能买」正是 9-29 雪龙集团那次事故的同款风险（一字板买不进）。
        if (r10Res.yiziUnknown) {
          out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】注意：' +
            r10Res.pick.name + ' 今日不在竞价名单里（属于「20天」补位行）⇒ 拿不到它的竞价涨幅，' +
            '【无法确认是否竞价一字涨停】⇒ 下单前自己核一眼；若它已一字涨停，按本规则的口径' +
            '【不选入、也不替补】= 今天这只候补视为空仓。');
        }
        // ★ 用户拍板「空仓标语保留 + 另给候补」：标语【不撤】，只在 detail 里点明「另有 1 只可以买」
        //   （撤掉标语会让「第一题材量比 < 25」这个风险事实消失，那正是用户要看见的东西）。
        if (r10LeadWeak && out.cashAlert && out.cashAlert.show) {
          out.cashAlert = Object.assign({}, out.cashAlert, {
            detail: String(out.cashAlert.detail || '') +
              ' ⚠️ 不过今天【另有 1 只十日周期候补】可以买：' + r10Res.pick.name +
              '（' + (r10Res.pick.topic || '—') + '，十日涨幅第 ' + r10Res.pick.rank + ' 名，' +
              (r10Res.pick.label || '') + '，与 20日涨幅总龙一不同题材）—— 见下方【' +
              RANGE10_BACKUP_TAG + '】那一行。' +
              // ★ [R10-STOCK-LEVEL 2026-10-24] 这句原来写「第一题材的票照旧不开新仓」——
              //   当候补票本身就来自第一题材时（10-23 兆威机电 属工业4.0），那句话自相矛盾。
              '第一题材的票照旧不开新仓【这只候补除外】—— 它不是按题材选出来的，' +
              '是按「十日涨幅前十 + 在列次数」从全市场选出来的（股票级通道）。',
            hasRange10Backup: true
          });
        }
      }
    } else {
      // §10：判不出 / 没有合格票 ⇒ 必须可见（⛔ 绝不让它静默变成「今天什么都没有」）
      // ★ [R10-TRAIL 2026-10-24] 再附一句【前十逐只的去留】—— 用户两次问「为什么选了这一只 /
      //   为什么不是那一只」，光给结论没法核对；有了这一句，屏幕上点开就能逐只对上（判定可追溯）。
      const r10TrailText = (r10Res && Array.isArray(r10Res.trail) && r10Res.trail.length)
        ? ' 前十逐只看：' + r10Res.trail.map(function(t) {
            // ★★ [DUAL-RANK 2026-10-24 用户口径] 每只并一个收盘口径名次（两套不同才写）——
            //   复盘时能直接看出「竞价第 8 名的票，收盘回看是第 11 名」这类口径差。
            const cs = _closeRankOf(r10RankClose, t.name, t.rank);
            return '第' + t.rank + '名 ' + t.name + '（' + (t.label || '次数未知') +
              (cs && cs.rank !== null && !cs.same ? ('；收盘口径第 ' + cs.rank + ' 名') : '') + '）' +
              (t.reason ? '⇒ ' + t.reason : '');
          }).join('；') + '。'
        : '';
      // ★★ [R10-YIZI 2026-10-24 用户口径] 「不是选不出来，是选出来的那只买不进」——
      //   这两种空仓的原因完全不同，措辞必须分开（否则用户会以为规则又选错了票）。
      if (r10Res && r10Res.blockedBy === 'yizi') {
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】今天这只候补【空仓】：' +
          (r10Res.reason || '选出来的那只今日竞价一字涨停，买不进') + '。' + r10TrailText);
      } else {
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【没有候补】' +
          ((r10Res && r10Res.reason) ? ('：' + r10Res.reason) : '') + '。' + r10TrailText);
      }
    }
  }

  // ★★ [DUAL-RANK 2026-10-24 用户口径] 【两套口径前十对照 · 复盘专用】
  //   用户原话：「复盘时出现困惑。你有没有办法让我复盘时，只看竞价口径的排名结果，
  //     但是收盘时我也想看，竞价口径我也想看原始的是怎么排名的。」
  //   ⇒ 这一条【永远】给（不限于「今天要不要用候补」）：复盘时最想知道的是「这一批名单
  //     两套口径下差在哪」，而不是「今天恰好有没有候补」。
  //   ⚠️ 三条安全降级全在 _range10DualTopText 里：池子没给 / 名次表空 ⇒ 不写（§10）；
  //      两套名单完全一致 ⇒ 不写（§11 零噪声，老调用方不传 pctMap 时必然走这条）。
  if (r10PoolGiven) {
    const r10DualTopText = _range10DualTopText(r10Rank926, r10RankClose, PRESENCE_TOP_N);
    if (r10DualTopText) out.notes.push(r10DualTopText);
  }


  // ★ [EBB-R20b 2026-10-20] 二次确认 + 常规选出 ⇒ 这些票是【今天真要买的】：
  //   卖点侧放行（保持 buildSellPlan 自己的结论 —— 通常 = 今天又进买点 ⇒ 持有 / 先卖后买），
  //   与替补的放行同一不变式：同一天不可能既「今天要买」又「竞价清仓」。首次退潮不在此列
  //   （那些票今天不买 ⇒ 卖点照旧一律竞价卖）。
  const regularPickNames = new Set();
  if (ebbSecondRegular) {
    out.blocks.forEach(function(b) {
      (b.picks || []).forEach(function(p) { if (p && p.name) regularPickNames.add(p.name); });
    });
    // 每行说明加注（用户原话「说明文字那里该加一句，主线AI应用二次确认退潮，作为补涨题材选出的股票」）。
    //   ⛔ 必须排在所有 actionNote 覆盖（finishBuyBlock / 空仓提醒改写）之后 —— 追加，不覆盖任何信息。
    //   ★ [EBB-WHY 2026-10-22 用户口径] 追加【判定依据】事实句 —— 与卖点侧横幅完全同款句式：
    //   「市场总龙【X】（题材，20日涨幅 +N%）今日竞价占比 P% ＜ 龙头门槛 3.5% ⇒ 判定为【…二次确认退潮】
    //     （题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）」。
    //   用户原话：「买点侧的提示词你没写为什么退潮，怎么判定的，很困惑……就写得很清楚（指卖点侧），所以你补充下买点侧描述」。
    const ebbWhySentence = '判定依据：市场总龙【' + (out.ebb.leaderName || '—') + '】（' +
      (out.ebb.leaderTopic || '—') + '，20日涨幅 ' + (out.ebb.leaderPctText || '—') + '）' +
      (out.ebb.whyText || '—') + ' ⇒ 判定为【' + (out.ebb.phaseTitle || '题材退潮') + '】' +
      '（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。';
    const tail = '主线' + (out.ebb.leaderTopic || '总龙题材') + '二次确认退潮，作为补涨题材选出的股票' +
      '（本题材是排除退潮题材后、按题材平均竞价量比常规选出的补涨题材）。' + ebbWhySentence;
    out.blocks.forEach(function(b) {
      (b.picks || []).forEach(function(p) {
        if (p && p.name) p.actionNote = (p.actionNote ? p.actionNote + ' ' : '') + tail;
      });
    });
    // ★ [EBB-R20c 2026-10-20 用户口径] 买点侧顶部的【节点说明】：用户原话「这是个退潮节点大方向，
    //   主线题材出现退潮后，新的题材符合条件，这些题材叫做补涨题材，因为这是个节点很重要，
    //   可能接下来会出现轮动行情，也就是后期排名第一或者第二的题材不断变化，会进入了常规选股规则」。
    //   ⛔ 纯说明文字（不改任何选股 / 标签 / 灰化逻辑）；文案全在 Logic 层（§21 模板零计算）。
    //   ★ [EBB-WHY 2026-10-22] detail 句首补判定依据事实句（与卖点侧横幅同款，判定可追溯）。
    out.ebbNodeNote = {
      headline: '⚠️ 主线' + (out.ebb.leaderTopic || '总龙题材') + '二次确认退潮 · 退潮节点（新题材 = 补涨题材）',
      detail: ebbWhySentence +
        '主线题材【' + (out.ebb.leaderTopic || '总龙题材') + '】二次确认退潮，这是一个重要的【退潮节点】：' +
        '主线退潮后，今天符合常规（平均竞价量比）条件的新题材叫做【补涨题材】（买点侧已按常规选股规则排除退潮题材选出）。' +
        '接下来可能出现【轮动行情】—— 排名第一、第二的题材会不断变化，买点侧随之进入【常规选股规则】' +
        '（按题材平均竞价量比选股，退潮题材不再参与）。卖点侧照旧收紧。'
    };
  }

  // ★★ [EBB-R20 2026-10-20 用户口径] 退潮日【买点侧兜底替补 · ≤2 只】：
  //   「从20日涨幅中的总龙一到总龙五选出两只排名靠前的……只选好两只，已经完成任务，后面不选了」。
  //   ★ [EBB-R20b 2026-10-20 用户口径] 兜底语义（用户本轮原话「如果排名前二的新题材都没有符合条件，
  //     兜底就是选总市场的排名前面的龙，所以才回到20日涨幅选股法」）：
  //     · 【首次退潮】⇒ 替补照旧（主线第一次坏，买点侧除替补外没有别的买点）；
  //     · 【二次确认】⇒ 只当常规选不出（blocks 为空）才启用替补；常规选出了补涨题材 ⇒ ebbBuy 恒 null。
  //   ⛔ 顺序（三步都不能换）：
  //     ① `_applyEbbBuyRules` 先跑完（把【常规题材块】的每行改成【退潮不买】+ 整段灰化）
  //        —— 用户拍板：这些票【照旧列出来】（灰化空仓视觉保留），只是不再有买点；
  //     ② 再构造替补块（它走 finishBuyBlock，拿到客观数据与原始买点信号，然后换成专属标签）
  //        —— 若反过来，第 ① 步会把它也打成【退潮不买】（那这些替补买点就没了）；
  //     ③ 同时挂进 `buy.ebbSecond` 槽位，让四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）
  //        照常给它挂客观数据（§6 共用同一次遍历）。
  //   §10：20日前五未就绪 / 一只替补都选不出 ⇒ 构造返回 null ⇒ 买点侧不出现这一段
  //        （⛔ 绝不拿别的名次顶替），空仓标语会如实改口径（见 detectEbbDay）。
  // ★★ [CYCLE 2026-10-22 用户口径] 切换日【不得再走退潮替补】——
  //   用户 10-22 报障：「买点侧选的是九阳股份、冰山冷热，而冰山冷热下面还有重复的一次」。
  //   根因：误判成【首次退潮】⇒ 退潮替补那一路和切换日新龙那一路【同时】输出，
  //   于是九阳（20 日内多次进前五，本不该入选）+ 冰山（与新龙重复）一起冒了出来。
  //   ⇒ 一条硬闸：切换日 ⇒ 退潮替补恒为 null（当天买点侧只有「新龙 + 常规收紧那一只」）。
  out.ebbBuy = (out.ebb && !ebbSecondRegular && !out.switchDay)
    ? _buildEbbPicksBlock(out.ebb, list, fOpts)
    : null;
  if (out.ebbBuy) out.buy.ebbSecond = out.ebbBuy;

  // ★★ [SWITCH-DEDUPE 2026-10-22 用户口径] 买点侧【全局同名去重】：新龙那一行优先。
  //   用户原话：「下面还有重复的冰山冷热」——同一只票在买点侧只能出现一次。
  //   ⛔ 只删「常规块里与新龙重名的那一只」，块本身保留（用户口径是「不要重复」，不是「不要题材」）；
  //     块里被删空 ⇒ 该块整块移出（否则会渲染一个空题材）。客观数据一行不动。
  if (out.newDragon) {
    const ndNames = new Set();
    (out.newDragon.picks || []).forEach(function(p) { if (p && p.name) ndNames.add(String(p.name).trim()); });
    if (ndNames.size > 0) {
      const kept = [];
      out.blocks.forEach(function(b) {
        const before = (b.picks || []).length;
        b.picks = (b.picks || []).filter(function(p) { return !(p && ndNames.has(String(p.name || '').trim())); });
        const removed = before - b.picks.length;
        if (removed > 0) {
          if (!Array.isArray(b.notes)) b.notes = [];
          b.notes.push('本块有 ' + removed + ' 只已作为【' + NEW_DRAGON_TAG + '】列在上方 ⇒ 这里不重复显示。');
        }
        if ((b.picks || []).length > 0) kept.push(b);
      });
      out.blocks = kept;
      // 决策看板形状的三槽位要跟着重建（否则清空后的块还挂在 buy.heavy / buy.light 上）
      out.buy.heavy = null;
      out.buy.light = null;
      out.buy.candidates = [];
      out.blocks.forEach(function(b, i) {
        if (i === 0) out.buy.heavy = b;
        else if (i === 1) out.buy.light = b;
        else out.buy.candidates.push(b);
      });
    }
  }

  // ★★ [EBB-R8 2026-10-14 用户口径] 落库行：把今天的退潮【判定】存下来，供明天判「是不是首日」。
  //   ⛔ 与 out.ebb 的区别：out.ebb 带首日闸门（昨天已退潮 ⇒ 今天 null），本行不带 ——
  //      本行回答的是「今天这只总龙到底在不在坏状态」，这正是明天那个闸门的输入（§6 同一把尺子）。
  //   ⚠️ 只在【有事实】时产出（§10）；写不写（今天 / 历史日）由组合式把关，本层不做时间判断。
  out.ebbDayRow = buildEbbDayRecord(out.ebb, o.ebbCtx || null, o.date);

  // ★★ [R20-926 2026-10-24 用户口径] 买点侧【20日涨幅通道】的入选票：补一条「9:26 那一刻的涨幅 + 名次」。
  //   ⛔ 必须放在 ebbBuy / newDragon 都造好之后（它俩就是这条通道的全部产出）；
  //   ⛔ 只写事实（用户「你不要解释」）；9:26 口径判不出 ⇒ 一行都不写（§10，见函数注释）。
  _appendRange20AucNote(out, o.range20Auc || null, o.ebbCtx || null);

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
  // ★★ [SWITCH 2026-10-22] 切换日的【新龙】同样是「今天进买点」⇒ 进名单（同一不变式）：
  //   它若昨天已在卖点侧候选里，卖点侧要标【持有】而不是「竞价清仓」（同一天不可能既买又清）。
  if (out.newDragon) {
    (out.newDragon.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }
  // ★★ [R10-BACKUP 2026-10-24] 第二十九条的【十日涨幅候补】同样是「今天进买点」⇒ 进名单（同一不变式）：
  //   它若昨天已在卖点侧候选里，卖点侧要标【持有】而不是「竞价清仓」（同一天不可能既买又清）。
  if (out.range10Backup) {
    (out.range10Backup.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }
  // ★★ [EBB-D1 2026-10-21 用户口径] 第二十六条：禁入题材的票【不进买点名单】——
  //   它们今天不买（「不用去掉」只针对【展示】，不针对【买点名单】）：
  //   若留在名单里，卖点侧会因「今天又进买点」把它们标成【持有】，与「次日禁止买入」正面矛盾。
  //   （与退潮题材被 [EBB-R20b] 排除出选股 ⇒ 同样不进名单，是同一不变式。）
  if (prevSecondEbb) {
    out.blocks.forEach(function(b) {
      if (!b || !b.prevEbbGray) return;
      (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.delete(p.name); });
    });
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
    if (out.ebb) _applyEbbSellRules(out.sell, out.ebb, ebbSecondRegular ? regularPickNames : null);
  }

  // ★★ [R10-NOEXCLUDE 2026-10-24] 「选股 N 只」按【去重后的股票数】算：
  //   同一只票可能同时出现在「灰化题材块 + 十日涨幅候补」或「题材买点 + 十日涨幅候补」里
  //   （用户口径：两条通道叠加是确定性，两处都展示）⇒ 数行数会把它算成两只，与实际能下单的只数不符。
  const _pickSeen = new Set();
  const _countUnique = function(arr) {
    (arr || []).forEach(function(p) {
      const nm = String((p && p.name) || '').trim();
      if (nm) _pickSeen.add(nm);
    });
  };
  out.blocks.forEach(function(blk) { _countUnique(blk.picks); });
  // ★ [SWITCH 2026-10-22] 新龙那一只也要计入「实际选出几只」（summary 文案读它）
  if (out.newDragon) _countUnique(out.newDragon.picks);
  // ★★ [R10-BACKUP 2026-10-24] 十日涨幅候补那一只同理（它就是今天能不能下单的那一只）
  if (out.range10Backup) _countUnique(out.range10Backup.picks);
  out.pickCount = _pickSeen.size;

  if (out.excludedTopics.length > 0) {
    const names = out.excludedTopics.map(function(t) {
      return t.topic + '（' + t.count + ' 只，量比 ' + formatAvgVolRatio(t.avgVolRatio) + '）';
    }).join('、');
    out.notes.push('⚠️ 按平均竞价量比排名靠前、但股票数量不足 ' + TVRB_MIN_COUNT +
      ' 只 ⇒ 不入选并顺延到下一题材：' + names);
  }
  // ★ [R10-BACKUP] 第二题材因【量比太小】被整块作废时，不再报「只有 1 个题材满足条件」——
  //   那样读起来像「今天本来就没第二个题材」，与事实（有、但被作废）相反（§10 不许含糊）。
  // ★ [SECOND-LEADER-10 2026-10-24] 第二题材被【龙一没进前十】否掉时同理：不再报「只有 1 个题材
  //   满足条件」—— 那是「今天本来就没第二个题材」的读法，与事实（有、但没带动性）相反（§10 不许含糊）。
  // ★ [SMALL-TOPIC 2026-10-24] 第一题材被【小题材收紧】弃掉时同理（见 r10SmallDropped 的注释）。
  if (out.blocks.length < TVRB_TOPIC_LIMIT && list.length > 0 &&
      !r10RemovedSecond && !r10SecondNoLead && !r10SmallDropped) {
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
    //       让口诀与第二十一条【退潮替补买】互相指得着（§6：文案与口径同处一处）。
    '★【口诀 · 用户口径】买在分歧，卖在一致。弱势切抱团，分歧切核心。' +
      '市场总龙（龙一）分歧时，核心就是【市场总龙二】（今天正是这种情形：总市场龙一分歧' +
      ' ⇒ 核心就是总市场龙二）；龙一分歧时，就切到龙二 —— 即第二十一条那几只【' +
      EBB_SECOND_BUY_TAG + '】替补。',
    '一、题材排名：把早盘竞价看板的题材按【平均竞价量比】由高到低排序（与早盘竞价「题材 toggle」同一套组序）；' +
      '★ 只看平均竞价量比、【不管题材里股票有多少只】（量比相同才按题材名定序）——与早盘竞价题材 toggle 逐键一致。',
    '二、题材数量门槛：题材内股票数量 < ' + TVRB_MIN_COUNT + ' 只 ⇒ 该题材【不入选】；' +
      TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_MID + ' 只；' +
      '> ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_BIG + ' 只。',
    '三、取几个题材：按排名从高到低往下扫，跳过数量不足的题材，只保留最靠前的 ' +
      TVRB_TOPIC_LIMIT + ' 个入选题材（不足时顺延，直到取够或没有合格题材）。' +
      // ★★ [SECOND-LEADER-10 2026-10-24 用户口径] 排名第二题材的第二个入选条件（新规）。
      //    ⛔ 文案与判定必须同处一处（§6）：判定在 buildTopicVolRatioPlan 的
      //    「第二道闸门」那一段，改一处必须改另一处。
      '★【排名第二的题材 · 额外入选条件（新规，2026-10-24）】除平均竞价量比要符合外，' +
      '还必须满足一条：该题材的【龙一】进入了【当天十日涨幅前十】（第 ' + PRESENCE_TOP_N +
      ' 名以内，按 9:26 竞价口径）。' +
      '没进 ⇒ 该题材【不入选】，当天买点侧【只选排名第一的那个题材】的股票，⛔ 不顺延到排名第三。' +
      '理由（用户原话）：连它的龙一都没有进入当天的十日涨幅，说明没有带动性，' +
      '后续基本上涨概率不大，风险很高。',
    '四、选股顺序：入选题材内按【龙一 → 龙二 → 龙三 …】从高到低依次取票。' +
      // ★★ [SMALL-TOPIC 2026-10-24 用户口径] 排名第一 + 数量 4~6 只的收紧档（新规）。
      //    ⛔ 文案与判定必须同处一处（§6）：判定在 buildTopicVolRatioPlan 扫描循环里
      //    「SMALL-TOPIC」那一段，改一处必须改另一处。
      '★【小题材收紧 · 排名第一且数量 ' + TVRB_MIN_COUNT + '~' + TVRB_SMALL_TOPIC_MAX +
      ' 只（新规，2026-10-24）】这一档【不按龙位取票】，改成：先看当天十日涨幅（第 ' +
      PRESENCE_TOP_N + ' 名以内，按 9:26 竞价口径），本题材有没有票进前十 ——' +
      '有 ⇒ 只在这些票里选【组内最强（龙位最前）】的那一只；一只都没有 ⇒ 该题材【弃掉】（不入选，' +
      '买点侧从其余题材继续顺延）。理由（用户原话）：这种数量少的，次日能存活下来的顶多有一只，' +
      '所以就买最强的，要收紧下。' +
      '⚠️ 7~' + TVRB_MID_MAX + ' 只的题材【不受】本条约束（那是「取几只」那一档，不是选票范围）。',
    '五、竞价涨停剔除：某龙位股票【竞价涨停（竞价一字）】⇒ 当天买不进，跳过它并顺延到下一个龙位' +
      '（龙一涨停看龙二，龙二涨停看龙三……依次类推）；⚠️ 顺延【补位】—— 名额照买满' +
      '（例如取 2 只：龙一一字 ⇒ 买龙二 + 龙三）。',
    '六、只数上限：每个入选题材最多取到本档只数（' + TVRB_PICK_MID + ' 或 ' + TVRB_PICK_BIG +
      ' 只）；该题材可买（非竞价涨停、非连续停牌）的票不足时【少取】，⛔ 不从其它题材补位。' +
      '⚠️ 缺口可能来自【连续停牌】（见第二十四条：停牌占掉名额、不补位），也可能来自名额本身不够。',
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
      // ★ [CASH-ALERT-NOBUY 2026-10-16 用户口径] 命中提醒 ⇒ 买点侧整段灰 + 标签改【分歧日不买】
      '★ 命中本提醒时（且当日【不是】退潮首日）：买点侧【整段变灰】' +
      '（与退潮首日【同一套】灰化视觉）、每只票的动作标签一律改为【' + CASH_NO_BUY_TAG + '】' +
      '（原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废）。' +
      '⚠️ ⛔ 卖点侧一行不变、⛔ 客观数据（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 名次 / 连板 / 封单）照常显示。' +
      '★ 另外，当当日为【退潮首日】、或【二次确认退潮但常规选不出补涨题材】（第二十条）时也一律提示空仓，' +
      '并改用退潮口径的标语、买点侧标签走【' + EBB_NO_BUY_TAG +
      '】（退潮【优先】于本提醒，两枚标签同处一套灰化视觉）。' +
      '⚠️ 二次确认退潮但【常规选出了补涨题材】时，空仓提醒按常规判据照常运作' +
      '（第一新题材平均量比 < ' + TVRB_CASH_ALERT_AVG_VR + ' 才提示）—— 买点侧不再被「建议空仓」接管。',
    // ── ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日（用户原话见文件头，规则与判定同处一处，§6）
    //    ★★ [EBB-R20 2026-10-20 用户口径] 总龙改用 20日涨幅；替补选两只；首日/二次确认。
    '二十、【题材退潮 · 卖点收紧】市场总龙（总龙一）= 【20日涨幅】全市场第一的那只' +
      '（与「20日涨幅」toggle 的总龙一【同一只、同一列】：停牌票按它自己的交易日回溯、靠补位照样进榜，' +
      '这正是改用 20日口径的原因 —— 十日口径在总龙停牌那天恰恰排不出它；舍弃旧的「昨日十日涨幅第一」选法）。' +
      '⚠️ 退潮是【题材退潮】，不是个股退潮：总龙一在某个题材停牌或者占比不符，' +
      '导致整个题材的股票预期走势很差。' +
      '它今日【停牌】或【竞价占比不达标】（二者有一即算）⇒ 判定为【题材退潮】。' +
      '⚠️ 占比门槛【恒按龙头档】（3.5%，含容错 4%）—— 总龙一就是市场龙头，' +
      '⛔ 不因它今天在题材内的十日龙位不是龙一而降档到 2%' +
      '（10-20 例：总龙新华传媒 20日全市场第一，当日十日口径里只是 AI应用 的龙三，占比 2.7% ⇒ 按龙头档判【不达标】⇒ 退潮）。' +
      '提示语会写明题材与阶段：首次 =【主线{题材}首次退潮】，再次 =【{题材}二次确认退潮】。',
    '　　退潮日，卖点侧只有两类票标【' + EBB_PICK_TAG + '】（= 允许等开盘看【分笔成交】再卖，' +
      '⛔ 不看占比）：' +
      '①【同题材可用龙位】= 总龙所在题材里龙位最靠前、且【非竞价一字 / 非停牌】的那只' +
      '（龙二不可用就顺延龙三、龙四……）；' +
      '②【市场总龙二】= 昨日十日涨幅【第二】的那只，且必须是【它自己题材的龙一】、与总龙【不同题材】、' +
      '且非竞价一字 / 非停牌（⛔ 这一只【不顺延】：它必须正好是涨幅第二，不递补涨幅第三）。',
    '　　其余股票（含原本标【' + HOLD_TAG + '】的）一律改【' + SELL_OUT_TAG + '】：开盘就走，降低风险。',
    '　　买点侧（【首次退潮】）：除替补外没有买点 ——入选股票的买点动作标签一律改为【' + EBB_NO_BUY_TAG + '】' +
      '（原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废），' +
      '整段【变灰】+ 顶部大字【建议空仓】：今天不开新仓。' +
      '⚠️ 唯一的例外是第二十一条的那几只【' + EBB_SECOND_BUY_TAG + '】替补。',
    '　　买点侧（【二次确认退潮】）：【先按常规选股】—— 排除退潮题材本身（即使它还符合常规条件，' +
      '毕竟它退潮了）之后，按第一~七条的平均竞价量比规则照常选股（题材排名顺延）。' +
      '选出的票 = 【补涨题材】，动作标签与常规完全同一套，行内说明会注明' +
      '「主线{题材}二次确认退潮，作为补涨题材选出的股票」。' +
      '★【退潮节点】大方向：主线题材出现退潮后，符合条件的新题材叫【补涨题材】——这是个很重要的节点，' +
      '可能接下来出现【轮动行情】：排名第一 / 第二的题材会不断变化，买点侧随之进入【常规选股规则】' +
      '（买点顶部会有节点说明横幅提醒）。' +
      '⚠️ 只有当排名前二的新题材都不符合常规条件（一个都选不出）时，才【兜底】到第二十一条的替补' +
      '（整段灰化 + 退潮不买）。两条的【卖点侧收紧】完全一样。',
    // ── ★ [EBB-R20 2026-10-20 用户口径] 首次 / 二次确认（近 10 天历史）+ 无第三次 ──
    '　　⚠️【只在首次 / 二次确认生效】：这套退潮规则，只对题材【首次退潮】和【二次确认退潮】生效。' +
      '判据看【最近 10 个交易日】的表现：十天内出现过一次退潮 ⇒ 今天【不算首次】，而是【二次确认】；' +
      '十天内已出现过两次 ⇒【没有第三次】，本规则不再触发，按平常日子选股（用户口径「退潮后基本不看了' +
      '这个题材了」）。' +
      '⚠️ 【事件】≠【天数】：总龙连续多日停牌 / 不达标只算【一次】事件（第二天起是延续，不触发也不多计）。' +
      '判据 = ① 退潮判定每天落库（tvrb_ebb_days 表）；② 首日闸门先看【上一交易日】：同一只总龙昨天已在' +
      '坏状态 ⇒ 今天是延续 ⇒ 不触发；③ 再数【近 10 个交易日】里同题材的退潮事件次数定阶段；' +
      '④ 落库 / 行情行都取不到 ⇒ 按【可触发】处理（宁可多提醒一次，不漏掉风险）。' +
      '说明文字里会如实写出本次判定是从哪里来的（落库 / 推断 / 取不到）。',
    '二十一、【退潮日 · 买点侧【兜底】替补「' + EBB_SECOND_BUY_TAG + '」】' +
      '（触发时机 = 首次退潮；或二次确认退潮但【排名前二的新题材都不符合常规条件、一个都选不出】）' +
      '买点侧回到 20日涨幅选股法，【只买替补，最多两只】：' +
      '从【20日涨幅】的总龙一到总龙五里选 —— ' +
      '① 先排除【非主板】（创业板 300/301、科创板 688/689、北交所一律不要）；' +
      '② 再排除【与总龙一同题材】的（总龙自己正是被判定退潮的那只，本来就不买）；' +
      '③ 剩下的按 20日涨幅排名取【最靠前的前两只】—— 只选两只，后面不再选（不足两只就只给算得出的）。' +
      '（例 10-20：五只全主板，总龙三新华文轩 / 总龙五慈文传媒与龙一（AI应用）同题材先排除，' +
      '剩下九阳股份（总龙二）和澳弘电子（总龙四）入选。）' +
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）。' +
      '⚠️ 标签是【' + EBB_SECOND_BUY_TAG + '】这枚专属标签（不是竞价买 / 尾盘买），' +
      '但行内说明会把每只的【常规买点信号】（占比达标 ⇒ 竞价买 / 不达标 ⇒ 尾盘买）原样写出来，信息不丢，' +
      '并如实列出【五只去留】（谁为什么被排除）。' +
      '⚠️ 替补若今日停牌 / 竞价一字（买不进），照样列出来并如实标注。' +
      '⚠️ 替补若同时在卖点侧（昨天已经买过），卖点侧【不改写】它的标签（今天又进买点 ⇒ 持有）——' +
      '同一天不可能既「要买」又「竞价清仓」。',
    '二十二、本看板的退潮判定【不做预测、不改客观数据】：十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 /' +
      '名次变化 / 连板 / 封单额一律照常显示 —— 退潮只改「今天怎么买、怎么卖」。',
    // ── ★ [TVRB-926 2026-10-14 用户口径 · 原话] 「题材量比看板选股买点侧，为什么早上的，和收盘的
    //    不一样，我只想要早上 9 点 26 分的……因为我对照历史日期的时候就对不上，
    //    比如今天我明明买了某只股票，过些时间我再翻开那个时期，又成另外一只股票，非常不合理。」
    //    ⇒ 买点侧选股（含行上十日涨幅）固定用【9:26 口径】。规则与判定必须同处一处（§6）。
    '二十三、【选股用 9:26 口径的十日涨幅】（★ 本条专门解释「为什么早上看的和收盘后翻回来的不一样」）：' +
      '区间涨幅的【当天那一根腿】在 15:00 收盘后会被自动换成【收盘涨幅】' +
      '（早上 9:25 落库时用的是【竞价涨幅】）⇒ 每只票的十日涨幅会被按各自「收盘 − 竞价」的差重排，' +
      '题材组内的【龙一 / 龙二】名次随之换人 ⇒ 选出来的票就不是早上那一批了。' +
      '⚠️ 本看板的【买点侧选股】（含每行显示的十日涨幅）一律用【9:26 口径】那一份：' +
      '用库里已存的「收盘涨幅 / 竞价涨幅」把那一根腿反解回竞价口径 —— ' +
      '⛔ 不新建表、不改任何行情数据，且历史日期同样有效（翻回任何一天，看到的都是当天 9:26 选出的那批股票）。' +
      '⚠️ 只有【买点侧题材选股】用这一份：题材排名、平均量比、占比、卖点与早盘竞价看板、决策看板用' +
      '【同一份】收盘口径；退潮判定的总龙与替补【另有 20日涨幅口径】（见第二十 / 二十一条）—— 用户拍板「其它不变」。' +
      '⚠️ 反解的前提（那一行确实已换过腿、且两个涨幅都读得到）不满足时，如实保留原值并在' +
      '买点侧提示「9:26 口径未就绪」，⛔ 绝不静默拿收盘口径冒充早上那一份。' +
      // ★★ [DUAL-RANK 2026-10-24 用户口径] 复盘对照（⛔ 只加对照信息，不改选股口径）。
      '★【复盘对照 · 两套口径并列】为了复盘时不产生错觉（例：竞价口径前十是 A，收盘回看却是 B），' +
      '候补行的徽标 / 悬停 / 「十名去留」里会【并列】写出同一只票在【收盘口径】下是第几名，' +
      '看板底部另有一条「两套口径前十对照」（竞价口径前十 + 收盘口径前十 + 进出变化）。' +
      '⚠️ 名字前面那个「第 N 名」永远是【竞价口径】—— 它才是选股用的那一份；' +
      '收盘口径名次【只用于复盘对照】，两套对不上不是算错，是同一批票在 9:26 与现价两个时刻的排序差异。',
    // ── ★ [SUSPEND-NOBUY 2026-10-14 用户口径 · 原话]「10月14日的新华传媒是停牌（非首日），
    //    不应该选进买点侧，因为停牌的股票根本不能买，也买不进。昨日还可以入选因为是首日停牌……
    //    次日还是停牌（没有竞价涨幅，竞价量，昨日成交量等），就不要选进去了，相当于一字买不进，
    //    因为当天有 14 只，选 2 只，退到龙二，龙三，买点侧的这个题材应该是今天早上的龙二，龙三。」
    //    ⇒ 与上面第二十三条同一个落点（买点侧选股），规则与判定必须同处一处（§6）。
    '二十四、【连续停牌的票买不进 —— 买点侧跳过，且该名额不再补位】：停牌的股票根本不能买，也买不进。' +
      '所以【连续停牌第 2 天及以上】的票（今天停牌、昨天也停牌：当天没有竞价涨幅 / 竞价量 / 昨日成交量）' +
      '在买点侧一律【跳过】，并且它占掉的这个名额【直接作废、不再往下补位】' +
      '（例：题材龙一停牌、该档取 2 只 ⇒ 只剩 1 个名额 ⇒ 实际只买龙二 1 只）。' +
      '★ 与第五条【竞价一字】刻意不同：一字是「很强的票、买不进但要看下一只」⇒ 顺延补位、名额买满；' +
      '停牌是「连竞价都没有、占着龙位也买不到」⇒ 名额作废。' +
      '⚠️ 停牌【首日】不跳 —— 昨天首日停牌仍可入选；一旦复牌、有成交量与占比数据，就理所当然参与选股。' +
      '⚠️ 本规则只改「买点侧选谁」：⛔ 不改题材只数（档位照旧按全部成员算）、不改退潮判定、' +
      '不改市场总龙、不改卖点侧。',
    // ── ★ [DIVERGE 2026-10-20 用户口径] 市场总龙一首次分歧 ⇒ 分歧买点 ──
    '二十五、【市场总龙一【首次分歧】⇒ 分歧买点（下杀买 + 高标跟随 ≤2 只）】：' +
      '★ 三个概念（判定全在 leader-divergence 模块，K 线 + 竞价涨幅，0 额度）：' +
      '①【首板】= 20 日窗口内第一个【收盘涨停日】—— 分歧计数从首板日起算，' +
      '首板之前的小阴小阳、竞价忽高忽低【一概不算分歧】（用户口径「要找到这20个交易日的首板很关键」）；' +
      '②【首次分歧】= 首板后第一个【竞价涨幅 < 0】（低开）的日子' +
      '（例：新华传媒 9-21 首板起 11 连板，10-19 低开 -1.06% ⇒ 首次分歧）；' +
      '③【分歧转一致】= 分歧日之后出现的【涨停日】（例：九阳股份 9-28 首板、10-13 首次低开、' +
      '10-16 涨停 ⇒ 分歧转一致）；转一致后再低开 =【第二次分歧】，再涨停 = 二次分歧转一致，依次类推' +
      '（本轮只记录与说明，暂不参与买点 —— 用户「后期会用到这个术语」）。' +
      '★【买点规则】：市场总龙一出现【首次分歧】的当天是买点 —— ' +
      '一般开盘会下杀然后反弹 ⇒ 总龙一标【下杀买】（别在竞价追）；' +
      '同时分歧日总龙一只会带动【不同题材】的高标：从【20日涨幅】总龙二~总龙五里，' +
      '先排非主板（创业板/科创板/北交所），再排与总龙一同题材（同题材的下跌很厉害），' +
      '剩下的取排名最靠前的【前两只】，标【高标跟随买】—— 连总龙一在内【最多三只】；' +
      '若总龙二也是非主板就少一只，若总龙二~五都与总龙同题材则只有总龙一。' +
      '分歧日其余入选票【照常列出但标【总龙分歧不买】、整段灰化】（今天不开新仓）；卖点侧不变。' +
      '⚠️ 优先级：【退潮（第二十/二十一条）> 总龙首次分歧 > 空仓提醒】—— 退潮日不谈分歧买点。' +
      '⚠️ 判不出的情形（窗口内无首板 / K 线或竞价涨幅缺）⇒ 本规则静默不生效（宁缺勿错）。',
    // ── ★ [EBB-D1 2026-10-21 用户口径 · 原话] 主线题材二次确认退潮 ⇒ 次日禁入买点侧 ──
    '二十六、【主线题材二次确认退潮 ⇒ 次日禁入买点侧】：主线题材【昨天】已经【二次确认退潮】了' +
      '（昨天总龙停牌 / 竞价占比不达标、且近 10 个交易日内该题材已有过一次退潮事件），' +
      '【次日该题材不进入买点侧】—— 即使它今天符合平均竞价量比的条件、排名靠前也不应该买（风险很高），' +
      '其它题材不受影响照常选股。' +
      '★ 表现方式（用户口径「不用去掉，其它题材不变」）：该题材的入选票【照常列出】（占住它的题材名额），' +
      '但【整块变灰】、每只票的动作标签一律改为【' + EBB_NO_BUY_TAG + '】' +
      '（原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废），' +
      '行内说明注明「昨日已二次确认退潮，次日禁止买入」。' +
      '⚠️ 这类票今天【不进买点名单】：卖点侧不会因「今天又进买点」把它们标成【持有】。' +
      '⚠️ 判据 = 退潮判定落库表（tvrb_ebb_days）：昨日那一行退潮 ⇒ 往回合并连续退潮日找到事件起点 ⇒ ' +
      '起点之前同题材已有 1 次退潮事件 ⇒ 昨日这笔就是【二次确认】；' +
      '昨日【首次退潮】不在本条内（首日闸门 / 当日判定已覆盖），取不到昨日落库行 ⇒ 不禁（宁可漏禁不误禁）。' +
      '（例 10-21：AI应用 10-20 二次确认退潮，10-21 它平均量比排第二、慈文传媒照常入选 ⇒ 整块灰化 + 退潮不买。）',
    // ── ★ [2026-10-22 用户口径] 简洁模式隐藏行内说明 + 红/黄提示板（问号规则手册与 UI 同步更新）──
    '二十七、【简洁模式 · 说明与提示板只进原版】：点开「简洁」开关时，【一】每只股票下面的【行内说明文字】' +
      '（如「根据规则第几条判定…」「主线XX二次确认退潮，作为补涨题材选出的股票」及其判定依据句）【不显示】；' +
      '【二】红/黄色【提示板】也不显示 —— 退潮节点说明横幅、分歧板口诀、卖点侧退潮判定横幅、空仓大字标语。' +
      '看板只留题材行、股票行、动作标签、涨幅 / 量比 / 占比等客观数据与分笔图' +
      '（决策警示由行级【退潮不买】/【分歧日不买】标签承载，不丢信息）。' +
      '关掉「简洁」（= 原版）则全部说明与提示板照常显示。' +
      '（简洁模式同样隐藏：卖点「卖出理由」行、规则手册全文、题材块的档位说明框；' +
      '保留：「这一块为什么没有股票」提示、当天的买点票（退潮替补 / 分歧买点）、分笔面板。）',
    // ── ★★ [SWITCH 2026-10-22 用户口径 · 原话] 二次退潮次日的次日 ⇒ 新龙 / 新题材切换日 ──
    '二十八、【新龙 / 新题材切换日 · 买点侧】（★ 核心思想：二次退潮次日后一天，就要切换新题材或寻找新题材了）：' +
      '★ 时间轴（三段，别把 D+1 与 D+2 搞混）：' +
      'D = 总龙一【二次确认退潮】当天（例 10-20 AI应用）；' +
      'D+1 = 退潮次日 ⇒ 主轴题材【禁止买入】（第二十六条，例 10-21）；' +
      'D+2 = 【切换日】（例 10-22）⇒ 老周期结束，开始找【新龙】/【新题材】。' +
      '★【怎么找新龙】（判据 = 当日 20日涨幅【前八】，前五不够就顺延；与「20日涨幅」toggle 的总龙一~五同源）：' +
      '① 从总龙一往下一只一只看（最多看 8 只）；' +
      '② 跳过【老龙一】自己（它是被交接的一方，不是新龙）；' +
      '③ 跳过【非主板 / 竞价一字涨停 / 停牌】的（买不进：用户「竞价一字涨停板是买不进的，只能挑非竞价一字涨停的主板」）；' +
      '④ 跳过【近 20 个交易日内已经上过前五】的（= 不是首次上榜：`stock_range20_pct` 每日榜逐日重算后比对，' +
      '说明里会写出窗口实际覆盖了多少天）；' +
      '⑤ 跳过【与老龙一同题材】的（老周期的票，退潮后基本不看；题材按【核心词大类】认，' +
      '如「文化传媒」归到「AI应用」）；' +
      '⑥ 剩下第一只 = 【新龙】（= 老龙向新龙的交接），标【' + NEW_DRAGON_TAG + '】独立成行、' +
      '渲染在灰化容器之外（今天真要买的那一只不能被灰掉）。' +
      '（例 10-22：新华传媒 = 老龙一、九阳股份 20日内上过榜、慈文传媒 / 新华文轩 与老龙一同属「AI应用」大类 ' +
      '⇒ 剩下【冰山冷热】首次上榜且是另一个题材 ⇒ 新龙。）' +
      '★【常规侧同日收紧】（⛔ 切换日【始终】收紧，与常规的「前二题材」不同）：' +
      '① 只选【一个】题材 —— 排名最前、且数量达标的那一个（数量不足照旧顺延，例：10-22 排名第一的房地产' +
      '按常规不符合选入条件 ⇒ 顺延到工业4.0）；' +
      '② 该题材只取【一只】票（龙位最前、非竞价一字、非连续停牌 —— 取票顺序同第一~七条）；' +
      '③ 跳过【退潮的老题材】与【新龙自己的题材】（老周期不买；同一题材不出两只）。' +
      '（例 10-22：买点侧 = 新龙【冰山冷热】+ 常规收紧后的【宁波东力】（工业4.0）两只。）' +
      '★【判不出新龙 ⇒ 新龙行不出现，但收紧照旧】：若前八里【没有】符合条件的新龙（例如八只全是同一题材、' +
      '或八只近 20 日都上过榜），或 20日涨幅前八 / 历史榜还没读到 ⇒ 买点侧回落常规选股，' +
      '但仍然【只选排名第一的入选题材、只取一只】（老周期已结束，今天不可能再买两个题材）；' +
      '说明区会如实写出原因与【八只去留】（谁为什么被排除）。',
    // ── ★★ [R10-BACKUP 2026-10-24 用户口径 · 原话] 题材量比太小 ⇒ 用十日周期的新面孔替换 ──
    '二十九、【十日涨幅 · 在列次数候补】（第二十九条 · 题材量比太小的替换通道）' +
      '★ 核心思想（用户原话）：「因为 20 日老周期结束，现在轮到十日周期；20 日的新老周期替换成 10 日周期的票，' +
      '20 日涨幅中列表中的老票也逐渐换成新票」「龙头的量比都比题材大，那才是核心，' +
      '应该用 10 日涨幅候补，这样可以选出有潜质的新龙」。' +
      '★ 两个触发条件（任一命中即为该题材找替换）：' +
      '① 排名【第二】的入选题材，其平均竞价量比 < ' + TVRB_CASH_ALERT_AVG_VR +
      ' ⇒ 该题材【禁止选入】（整块作废、不列股票），用候补票替换它；' +
      '② 排名【第一】的入选题材平均量比也 < ' + TVRB_CASH_ALERT_AVG_VR +
      ' ⇒ 它照旧「建议空仓」+ 整段灰化（第十九条不变），但【另外给一只候补】可以买' +
      '（大字标语里会多一句「另有 1 只十日周期候补」，标语⛔ 不撤 —— 风险事实必须留着）。' +
      '★ 候补票怎么选（只选【一只】，⛔ 绝不多选）：' +
      '★ 性质（用户口径，2026-10-24 第二次修正）：「这个 10 日涨幅和 20 日涨幅排名，是【选股票】，' +
      '前者（题材量比）是【选题材】」—— 本规则是【股票级通道】：只认股票自己的三个条件，' +
      '⛔ 不参与题材排名、⛔ 不受题材量比门槛 / 题材灰化 / 题材作废的约束。' +
      '所以同一只票可以在上方灰化题材块里【重复出现】一次：那一块照旧灰化、不恢复，' +
      '这一行是另按股票条件选出来的（例 10-23：工业4.0 平均量比 15.18 ＜ 25 ⇒ 整块灰化空仓，' +
      '但【兆威机电】是十日涨幅第 8 名 + 首次在列 ⇒ 仍被选为候补）。' +
      '① 池子 = 【与早盘竞价「10日涨幅」toggle 屏幕同一批行】的十日涨幅前 ' + PRESENCE_TOP_N + ' 名' +
      '（只数主板名次，创业板 / 科创板 / 北交所不占名次 —— 与「在列次数」标签同一把尺子）；' +
      '⚠️ 这一批行【必须含「20天」补位行】：补位票（如 10-23 的慈文传媒）不在当日名单里，' +
      '若漏掉它，名次会整体前移一位，第 11 名就会被当成第 10 名（2026-10-24 选中上海九百 的事故根因）；' +
      '补位数据还没就绪 ⇒ 判不出（⛔ 不许按错位的名次选票）；' +
      '② 在列次数 = 该票在这 10 个交易日的早盘竞价名单里出现过几次（预计算表 auction_presence，window_days = 10）；' +
      '③ 【首次在列】（1 次）优先；前十名里没有可用的首次在列，才看【二次在列】（2 次）；两档都没有 ⇒ 今天空仓；' +
      '④ 硬条件（同时满足，缺一不可）：必须是主板、必须与【20日涨幅总龙一】不同题材' +
      '（题材按核心词大类认，如「文化传媒」归到「AI应用」；⛔ 这条是【周期】约束 —— 老周期的同一题材等于没换周期）；' +
      // ★★ [R10-YIZI 2026-10-24 用户口径 · 9-29 雪龙集团事故]
      '④-2【买得进】：选中的那只若【今日竞价一字涨停】（竞价涨幅 = 涨停幅度）⇒ 竞价买不进、' +
      '开盘也基本买不到 ⇒ 【不选入、也不替补】，本日候补【空仓】并写明原因。' +
      '⚠️ 这条与「题材块里龙一一字就顺延龙二」【刻意相反】：那边是买满名额的打板口径，' +
      '这边候补只有一只 —— 换成第二名就是用更弱的票顶掉最强的票，没有意义。' +
      '⚠️「20天」补位行不在当日竞价名单里 ⇒ 拿不到竞价涨幅 ⇒ 【无法确认是否一字】，' +
      '规则照样选它，但会在说明区提醒你自己核一眼（⛔ 不默默当成能买）。' +
      '（9-29 事故：十日涨幅候补选了【雪龙集团】（农业，十日涨幅 +49%，第 6 名，2次在列），' +
      '但它当天是竞价一字涨停板 ⇒ 选进去也买不到。）' +
      '★ 第三次修正（10-20 事故）：「出现多只首次在列只选一只最强的，也就是十日涨幅最高的，那就是海洋王」' +
      '—— ⛔ 【不再】因为某只票已被题材块选中就跳过它。那等于用更弱的票顶掉最强的票' +
      '（10-20：海洋王 29.51% 被跳过、换成京城股份 27.26%）。' +
      '⚠️ 同一只票被【题材通道】和【市场通道】同时选中 = 【叠加确认】（确定性更高），' +
      '不是重复选错：两处照旧各显示一行，候补那行徽标带「叠加确认」，说明区写明「不用合并、也不用再选第二只」。' +
      '⚠️ 被改成「不开新仓」的票（灰化 / 空仓不买 / 退潮不买 / 分歧不买）照样能当候补；' +
      '⚠️【20日涨幅总龙一】未就绪 ⇒ 这道「不同题材」闸门没被验证过 ⇒ 候补不出现（§10 不猜，⛔ 不放行）。' +
      '（例 10-20：房地产平均量比只有 7.47 < ' + TVRB_CASH_ALERT_AVG_VR + ' ⇒ 作废 ⇒ 十日涨幅第 8 行' +
      '【海洋王】（主板第 7 名，10 日内只在列 1 次 = 首次在列，LED ≠ 总龙一 文化传媒/AI应用）⇒ 选它；' +
      '即使它同时是【商业航天】题材块的买点，也照样选它 —— 那是叠加确认。）' +
      '★ 表现方式：候补那一行标【' + RANGE10_BACKUP_TAG + '】、独立渲染在灰化容器【之外】' +
      '（今天真要买的票不能被灰掉），行上带「十日涨幅第 N 名 · 首次在列」徽标，' +
      '行内说明写明它是十日周期的新面孔买点（⛔ 不是题材量比买点、⛔ 不是退潮替补）。' +
      '⚠️ 与其它规则的优先级（⛔ 不许两条同时输出买点）：' +
      '【退潮兜底（首次退潮 / 二次确认但常规选不出）】> 【切换日 第二十八条】> 【总龙首次分歧 第二十五条】' +
      '> 本规则。也就是说这三种场景里本规则一律不生效。' +
      '⚠️ 判不出就如实说明（§10）：十日涨幅池（含 20 天补位行）/ 在列次数 / 20日涨幅总龙一 没读到 ⇒ ' +
      '候补不出现，说明区写明是哪个缺口，' +
      '⛔ 绝不拿「没数据」当成「今天没有候补」更不当成「空仓」；' +
      '没有候补时，说明区会附上【前十名逐只的去留与理由】，方便逐只核对。'
  ];
}
