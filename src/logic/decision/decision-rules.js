// decision-rules.js — 「决策」看板的核心规则（Logic 层纯函数，§15 独立业务模块 / §21 模板零计算）
//
// 本文件【只有纯函数】：不读 state、不发请求、不碰 DOM、不 import 任何 store。
// 所有输入输出都是普通对象/数组 → 既方便单测，也保证后期加规则时只动这一个文件。
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [QUANT-PICK 2026-10-01 用户口径 · 买点整体重写] ★★
// ★★ [TWO-MODES 2026-10-02 用户口径 · 两套买点并存，见下方 MODE_* 常量] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「决策看板的规则你重新改造下……先看早盘竞价看板的题材按照竞价量比排序，
//   选出排在第一和第二的题材，然后决策看板选票，也是按照竞价量比选。先不分龙一、龙二了
//   （后面再做调整，现在先以竞价量比为主），还有不看连板天梯晋级看板了，也不分弱势题材，量化了。」
//
// ── 新买点规则（唯一口径，代码与本段文字必须一致）──
//
//   第 0 步【题材排名】：早盘竞价「题材 toggle」的题材组序 —— 2026-10-01 起
//     按【该题材的平均竞价量比】降序（原来的「一字数量降序」已作废，见 topic-sort.js#sortByTopicGroups）。
//     ⛔ 决策看板【不另写一套排名】：rankDecisionTopics 直接复用 sortByTopicGroups（§6 单一真相），
//        所以「屏幕上的题材顺序 == 决策排名 == 趋势图名次」三处必然同源。
//
//   第 1 步【选题材】：先【剔除数量不达标（1~3 只）的题材】—— 它们不进入决策范围，
//     ⛔ 而且【不占名次】：后面的题材【递补】上来（用户 2026-10-02 口径，9/30 实例：
//     农业量比 71.22 排第 1 但只有 2 只 ⇒ 排除 ⇒ 新能源汽车递补成第 1、AI应用第 2、房地产第 3）。
//     取递补后的【第 1】与【第 2】两个题材（也就是用户说的「排在第一和第二的题材」）。
//     一个合格题材都拿不到 → 没有买点（如实呈现，不给建议）。
//
//   第 2 步【看题材股票数量分档】—— 数量 = 该题材在早盘竞价里的股票只数（block.count，
//     与早盘竞价统计条「数量：n」同一个数，§6 同源）：
//       · ≥ 10 只        → 取 3 只：竞价量比前 2 只【重仓】+ 第 3 只【轻仓】
//       · 7 ~ 9 只       → 取 2 只：竞价量比第 1 只【重仓】+ 第 2 只【轻仓】
//       · 4 ~ 6 只       → 取 1 只：竞价量比最高那只【重仓】
//       · 1 ~ 3 只       → 【不进入决策范围】（第 1 步就被剔除，不占名次）
//
//   第 3 步【题材内选票】：一律按【竞价量比】降序取前 N 只（N = 上面档位给的只数）。
//       · 竞价一字【买不进】→ 一律跳过（不占名额、不参与排序）；
//       · 创业板 / 科创板 / 北交所（20% / 30% 涨跌幅板）→ 【照选】，不因板块跳过；
//       · 【不分龙一 / 龙二】—— 龙头名次只在「量比相同」或「全体缺量比」时作稳定次序用；
//         行内的「龙几」标签照旧显示（标签不变）。
//
//   第 4 步【保底 3 只 + 候选题材】（★ 2026-10-02 用户口径补完，见 buildBuyPlan 的 9/30 实例）：
//       · 一天至少要选出【DAILY_MIN_PICKS = 3】只票；第 1、2 名加起来不够 ⇒
//         按题材排名【往下推】候选题材（第 3、4… 名），直到选够 3 只为止；
//       · 候选题材 = 主线档位【降一档】（candidatePickCount：大档 3→2、中档 2→1、小档 1→1），
//         且【全部轻仓】，只取该题材里竞价量比最高的那几只；
//       · 第 1 名题材【已经选出 3 只】⇒ 第 2 名【降级为候选题材】
//         （用户原话「这种也相当于双主线。只选最强的，也就是题材平均竞价量比最大的」）；
//       · 候选题材的题材行标【候选题材】（用户原话「你可以这样写：候选题材：房地产」）。
//
//   ⛔ 从此作废、并且【已从本文件删除】的旧规则（§16 不留死代码）：
//        ① 一字 ≥ 2 / ② 一字 = 1 / ③ 一字 = 0 的档位门槛；
//        ④ 第 2 名题材的「直接买龙一 / 取名次最靠前的高开票」与「题材替换」；
//        ⑤ 全部题材无一字 → 连板天梯「题材连扳」兜底；
//        ⑥ 高风险小题材兜底（票少 + 1~2 个一字）；
//        ⑦ 亏钱效应（竞价一字跌停 → 只买龙一轻仓）；
//        ⑧ 弱势题材（> 10 只且竞价高开率 < 35% → 只买龙一轻仓）；
//        ⑨ 双主线竞争（第 1 / 第 2 名都 ≥ 10 只 → 比竞价高开率定重仓）；
//        ⑩ 买入只数限制（≤ 6 只最多 1 只 / ≤ 10 只最多 2 只）；
//        龙一特例（低开 + 量比 > 60 追加龙一重仓）与卡位补偿（龙二被挤掉补轻仓）。
//      ⇒ 这些口径【都不再影响选票结果】。要恢复任意一条 ⇒ `git revert` 本次提交即可（历史实现原样在旧提交里）。
//
//   §10 红线（贯穿全程）：缺数据【绝不补 0 / 绝不当 0 参与比较】——
//     缺竞价量比 → 不参与量比大小、一律排在有量比的票后面；整个题材都没量比 → 退回按龙头名次取，
//     并在说明文字里写明这是退路。缺十日涨幅 → 排不进龙位（但照样能被量比选中）。
//
// ── 保留不变的部分 ──
//
//   ①【选票依据 = 竞价量比】数据来源 market_metrics(scope='auction').auc_vol_ratio，
//      与早盘竞价看板展开面板那行「竞价量比」、以及买点行内徽标【同一个字段】。
//   ②【后置标记】全部保留，语义不变（用户口径「标签不变」）：
//        ③ 持有（上一交易日也在买点里 ⇒ 强势股）
//        ④ 昨有买入（题材级，标在题材行）+ 持有（股票级，改行尾仓位）
//      ⚠️ [HOLD-UNIFY 2026-10-03 用户口径] ③ 与 ④ 的文案都统一成【持有】（原来是
//         「持有 / 加仓」与「加仓」两种写法）。同一行只会出现一次【持有】，见 _markPrevBought。
//        ⑤ 入选次数（近 5 个交易日进过买点几次）
//   ③【低开龙一提醒】龙一竞价低开时提示自行看竞价图形（跌停 L 形 → 尾盘买），纯文字提醒。
//   ④【卖点】整体不变（用户口径「卖点先不变」）：候选 = 昨日打过「买」标签的股票，
//      第一层按今日竞价高低开细分节奏，第二层按今日题材排名兜底。详见下方 _decideSellHint。
//
// 【规则编号】买点说明文字必须标【规则N】，像法律条文一样能查出处。
//   ⛔ 编号只从本文件顶部的 RULE_NO 取（§6 单一真相），说明文字用 _note() / ruleTag() 生成。
//
// 【卖点】候选 = 【昨日】打过「买」标签的股票。卖点分【两层】，先后关系如下：
//
//   第一层 · 按【今日竞价高低开】细分节奏（[SELL-OPEN 2026-09-29] 用户口径，优先）：
//     竞价涨幅 ≤ -3%（深低开）        ⇒ 盯盘：10:00 前看有没有反弹，冲高就出；反弹不起来也出；
//     -3% < 竞价涨幅 < 0（小低开）    ⇒ 开盘【立刻出】，行内打「❗危」警示；
//     0 < 竞价涨幅 < +3%（小幅高开）  ⇒ 10:00 前看分时整体曲线：向上拿到 11:20 卖，走弱立刻卖。
//     ⚠️ 未命中三档（≥ +3% / 恰好平开 / 缺竞价涨幅）⇒ 不提示，回落到第二层的题材排名时点。
//     实现：_decideSellHint（⛔ 唯一实现；改细分档位只改这里 + 顶部常量）。
//   · 每行在「十日涨幅」后面再加一个【竞价涨幅】标签（[AUC-BADGE 2026-09-29] 用户口径）：
//     文本 = formatAucPct（与早盘竞价同一函数，2 位小数、正数补 '+'）；
//     配色 = getAucOpenKind（竞价涨幅 > 0 红底 / < 0 绿底 / = 0 灰底，与全站「涨红跌绿」一致）；
//     缺竞价涨幅（null）⇒ 不产标签，⛔ 绝不用灰色伪装成「平开」（§10）。
//
//   第二层 · 按【今日题材排名】的兜底时点（原规则，未被第一层覆盖时才显示在行尾）：
//     · 今日题材排【第 1 或 第 2】名 ⇒ 14:50 卖（拿满一天）；
//     · 今日题材排名【不在前二】⇒ 11:20 卖（排名靠后，弱了就早走）；
//     · 例外（2026-09-24 用户口径）：今日题材【排第 2】且该题材【只有 1 个竞价一字】⇒ 题材强度打折，
//       【只有龙一】能拿到尾盘（14:50 卖），【其余非龙一】11:20 卖。
//     这一条会让同一个题材组里同时出现两种时点，所以时点是【逐行】算的，不是整组一个值。
//     其中「昨日是龙头（十日涨幅最高）」是用户明确点出的典型情形，写在卖出理由里。
//     ⚠️ 未覆盖的组合一律回落到上面的通用规则，不会给出互相矛盾的建议。要改只改 _decideSellTime 一处。
//
// 【§10 红线】任何一段数据缺失 → 该段【不产出】（返回空/不给出建议），
//   绝不用 0 / '-' / 空字符串伪装成「有数据」。

import { sortByTopicGroups, TOPIC_ORDER_VOL_RATIO, TOPIC_ORDER_YIZI } from '../auction/topic-sort.js';
import { computeDragonRankMap, getDragonLabel } from '../auction/dragon-rank.js';
// 竞价开平（高开 / 低开 / 平开）复用连板天梯的唯一实现，⛔ 不在本文件另写一套阈值与文案（§6）
import { getAucOpenKind } from '../ladder/ladder-rules.js';
// 竞价涨幅格式化复用早盘竞价的唯一实现（§6）。
import { formatAucPct } from '../auction/limit-up.js';
// [VR-COMPARE 2026-10-02 用户口径] 「今日 vs 上交易日」竞价量比方向的【唯一口径】在 vol-ratio-trend.js
//   （compareVolRatioDirection 的四舍五入整数差）。⛔ 本文件只 import 常量做比较，绝不另写一套阈值 ——
//   否则「量比算不算下降」在徽标与规则两处会出现两个答案（§6 破）。
import { VR_DIR_UP, VR_DIR_FLAT, VR_DIR_DOWN } from './vol-ratio-trend.js';
// [SELL-SURGE 2026-10-03 用户口径] 「今日 ÷ 上交易日」竞价量比【倍数】的唯一口径也在 vol-ratio-trend.js。
//   ⛔ 与上面那份方向常量是【两个不同口径】：方向 = 整数差（强/弱），倍数 = 除法（放大了多少）。
//   阈值 VR_SURGE_TIMES 只在那边定义，本文件只 import 判定函数（§6 单一真相）。
import { VR_SURGE_TIMES, isVolRatioSurge } from './vol-ratio-trend.js';
// [SHARE-RULE 2026-10-03 用户口径] 竞价占比（竞价量 ÷ 昨日成交量）= 买卖点的【主判据】。
//   ⛔ 公式 / 门槛 / 展示精度 / 取数的【唯一实现】都在 auction-share.js，
//      本文件只 import 常量与判定函数 —— 绝不在这里写第二份算法（§6 单一真相）。
import {
  AUCTION_SHARE_FRONT_STD, AUCTION_SHARE_TOLERANCE, AUCTION_SHARE_FRONT_MIN, AUCTION_SHARE_BACK_STD,
  formatAuctionShare, auctionShareThresholdOf, passesAuctionShare, auctionShareZoneOf
} from './auction-share.js';

/** 题材成组门槛：与早盘竞价统计条（topic-stats.js#TOPIC_STATS_MIN_GROUP）同源 —— 不足 2 只不成题材 */
export const DECISION_MIN_GROUP = 2;

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [TWO-MODES 2026-10-02 用户口径 · 两套买点并存，由早盘竞价的 toggle 切换] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：「把早盘竞价看板的平行 toggle 改成一字……打开一字 toggle 后，显示也和单独打开题材
//   toggle 一样，只是排序变了（一字数量多的排前面）。我想两个版本我都要，这样能对比哪个功能
//   比较好……现在的决策看板 UI 不变。只是逻辑要跟随早盘竞价看板的 toggle 变化，相当于两种方式。」
//
// ⇒ 两套【完全独立】的买点规则，同一个决策看板 UI 渲染哪一套，取决于早盘竞价的题材口径：
//   · MODE_VOL_RATIO（题材 toggle）→ 本文件的规则（题材按平均竞价量比排名 + 按竞价量比选票）；
//   · MODE_YIZI（一字 toggle）     → decision-rules-legacy.js 的【老版完整规则】
//     （题材按竞价一字数量排名 + 一字门槛 / 题材替换 / 无一字兜底 / 小题材兜底 / 大题材 /
//      双主线 / 亏钱效应 / 弱势题材 / 买入只数 等一整套）。
//
// ⛔ 本文件【不 import】legacy（否则成环）—— 分派统一在 decision-mode.js 一处（§6 单一真相）。
// ⛔ 两套规则只在【买点】分叉：卖点、后置标记（持有 / 昨有买入 / 入选次数）、
//    行内徽标、规则面板的卖点段，全部【共用同一份实现】，改一处两模式一起变。
/** 买点模式①：题材 toggle —— 题材按【平均竞价量比】排名 + 按竞价量比选票（2026-10-01 起的现行规则） */
export const MODE_VOL_RATIO = TOPIC_ORDER_VOL_RATIO;
/** 买点模式②：一字 toggle —— 题材按【竞价一字数量】排名 + 老版完整规则（decision-rules-legacy.js） */
export const MODE_YIZI = TOPIC_ORDER_YIZI;
/** 模式合法值（§10：非法 / 缺失一律按 MODE_VOL_RATIO 处理，⛔ 绝不抛错） */
export function normalizeDecisionMode(mode) {
  return mode === MODE_YIZI ? MODE_YIZI : MODE_VOL_RATIO;
}

// ===== [QUANT-PICK 2026-10-01 用户口径] 买点：题材股票数量 → 取几只 =====
// 用户原话：「看数量，如果数量大于等于 10 买 3 只，竞价量比高的两只重仓，竞价量比较低的轻仓；
//   同题材 7-9 只数量，可以买两只，竞价量比高的那只重仓，剩下那只轻仓；
//   同题材 4-6 只数量，只买一只竞价量比高的，重仓。数量只有 1-3 只的不进入决策范围，空仓。」
/** 题材股票数 ≥ 此值 ⇒ 取 3 只（量比前二重仓 + 第三轻仓） */
export const PICK_TIER_BIG_MIN = 10;
/** 题材股票数 ≥ 此值（且 < PICK_TIER_BIG_MIN）⇒ 取 2 只（第 1 只重仓 + 第 2 只轻仓） */
export const PICK_TIER_MID_MIN = 7;
/** 题材股票数 ≥ 此值（且 < PICK_TIER_MID_MIN）⇒ 取 1 只（重仓）；不足 ⇒ 该题材不出票 */
export const PICK_TIER_MIN_COUNT = 4;
/** 各档取几只 */
export const PICK_COUNT_BIG = 3;
export const PICK_COUNT_MID = 2;
export const PICK_COUNT_MIN = 1;
/** 各档里【重仓】几只（剩下的按量比顺序记轻仓） */
export const PICK_HEAVY_BIG = 2;
export const PICK_HEAVY_MID = 1;
export const PICK_HEAVY_MIN = 1;

// ===== [MIN-3-PICKS 2026-10-02 用户口径] 一天至少要选出 3 只；不够就按题材排名往下推【候选题材】=====
// 用户原话：「我要求一天至少要选三只入决策看板，如果没选够，就往下推（就像选那个房地产一样
//   本来它计算出来是排第三的，按理来说只选排第一和第二的题材，但是按数量选不够票，
//   只能按照题材排名往下找题材，直到选后三只票为止，但是除了排名第一和第二的题材在，
//   其它排名都是候选题材）」。
/** 一天至少要选出几只票（主线题材不足 ⇒ 往下推候选题材补齐，见 buildBuyPlan） */
export const DAILY_MIN_PICKS = 3;
/** 候选题材的题材行标记文案（用户原话「你可以这样写：候选题材：房地产」） */
export const CANDIDATE_TAG = '候选题材';

// ===== [TOPIC-ORDER 2026-10-01 用户口径] 题材排名依据 = 平均竞价量比（早盘竞价题材 toggle 同源）=====
// 用户原话：「以前单独打开题材 toggle，题材是按一字数量排序，我希望现在是按题材的平均竞价量比排序，
//   平均竞价量比高的题材排在前面。这样能分出排在第一和第二的题材」。
// ⛔ 排名实现【不在本文件】—— 就是 topic-sort.js#sortByTopicGroups 的 topicOrder 档，
//    rankDecisionTopics 与早盘竞价 view-helpers 传的是【同一个函数 + 同一个参数】（§6 单一真相）。
// 量比取值 = market_metrics(scope='auction').auc_vol_ratio（云端存字符串如 "2.18"，规则层统一 _num 解析）。

/**
 * 【持有】标记文案：上一个交易日也在买点里、今天又被选中 = 强势股。
 *
 * 🔴 [HOLD-UNIFY 2026-10-03 用户口径] 文案由「持有 / 加仓」统一为【持有】——
 *   用户原话：「1.要统一改成持有」。
 *   ⚠️ 与 POSITION_HOLD（规则④ / ⑫ 的行尾仓位）现在是【同一个词】：
 *      · HOLD_TAG      = 上一交易日的【买点方案】里也有它（系统【建议】买过）；
 *      · POSITION_HOLD = 上一交易日用户【实际】打了「买」标签（用户【真的】买了）。
 *      两者语义不同、判据不同，但文案统一 ⇒ 为避免同一行出现两枚「持有」，
 *      _markPrevBought 在把行尾仓位改成【持有】之后会清掉这一枚标记（见该函数注释）。
 */
export const HOLD_TAG = '持有';

// ===== [VR-ACTION 2026-10-02 用户口径] 竞价量比「减弱 → 该股当天节奏」的两个动作徽标 =====
// 用户原话（9/3 案例）：
//   · 「捷荣技术 竞价涨幅小于0，竞价量比当天比昨日下降，预测当天优势不是很好，所以应该【尾盘买】」
//   · 「楚天龙 昨有买入，竞价涨幅小于0，竞价量比当天比昨日下降…应该是先卖后尾盘买。打上标签【先卖后买】」
//   · 「现在打的是持有/加仓太笼统，如果这只股票是竞价涨幅大于0，竞价量比也增加，持有/加仓标签没问题」
//
// 判据（两处共用同一个「弱票」定义，见 decision-rules#isWeakAucDay）：
//   弱票 = 今日竞价涨幅 < 0 【且】今日 vs 上交易日竞价量比【下降】（四舍五入整数差 ≤ -1）。
//
// ⛔ 两个徽标【是新增的独立标记】，不替换行尾仓位（重仓 / 轻仓 / 加仓）——
//   用户 AskUserQuestion 明确选「新增「尾盘买」徽标（不替换仓位）」。
// ⛔ 只在【一字模式】的买点块上出现（本次改动限定「一字的买点规则」，其它模式不变）。
/** 【尾盘买】徽标：竞价量比比上一交易日【下降】→ 当天优势不好，等尾盘再买（不追开盘） */
export const BUY_LATE_TAG = '尾盘买';
/** 【先卖后买】徽标：量比下降 + 手上已有仓位（昨天买过）→ 开盘先卖掉，尾盘再买回来 */
export const SELL_FIRST_BUY_LATER_TAG = '先卖后买';
/**
 * 【尾盘买（先卖后买）】复合徽标 —— [SHARE-PRIORITY 2026-10-04 用户口径] 新增。
 *
 * 场景（用户给的 9/3 楚天龙案例）：占比【不达标】＋ 这一只【昨天真买过】
 *   ⇒ 它同一天既在【卖点】又在【买点】。两边的动作合起来就是「先卖后买」：
 *     · 卖点：占比不达标 ⇒ 【竞价卖】（开盘先把昨天的仓卖掉）；
 *     · 买点：占比不达标 ⇒ 【尾盘买】（尾盘再买回来）。
 * 用户原话：「买点方面，提示尾盘买（已有，把持有去掉就可以），改成只有「尾盘买（先卖后买）」」
 *   ⇒ 买点这一行【只留这一枚徽标】：⛔ 不再叠行尾仓位【持有】（它会被读成「不用卖」，
 *     而这一只今天恰恰要【先卖】）。文案由两枚既有常量拼出来，⛔ 不再手抄一遍（§6）。
 */
export const BUY_LATE_SWAP_TAG = BUY_LATE_TAG + '（' + SELL_FIRST_BUY_LATER_TAG + '）';
/**
 * 【竞价买】徽标 —— [BUY-NOW 2026-10-03 用户口径] 新增。
 *   用户原话（9/30 案例）：「如果是竞价涨幅大于 0，竞价量比上升，这类股票应该打标签【竞价买】」
 *   ⇒ 竞价量比比上一交易日【增强】= 有人抢筹 ⇒ 竞价就得买，等尾盘反而买不到 / 更贵。
 */
export const BUY_NOW_TAG = '竞价买';
/** 徽标配色档（§21：由 Logic 层给，模板只拼 `'dcb-action-' + tone`，⛔ 不自己判断是哪个徽标） */
export const BUY_ACTION_TONE_LATE = 'late';   // 尾盘买 → 琥珀（提醒：别追开盘）
export const BUY_ACTION_TONE_SWAP = 'swap';   // 先卖后买 → 紫（两段动作，比单纯尾盘买更重）
export const BUY_ACTION_TONE_NOW = 'now';     // [BUY-NOW 2026-10-03] 竞价买 → 红（增强 = 抢筹，立刻买）

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [SHARE-RULE 2026-10-03 用户口径 · 买卖点改以【竞价占比】为唯一主判据] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户给了 8/31、9/1、9/2 三天共 11 个【已标注】案例（原文见 auction-share.js 文件头），
// 结论是：**占比说了算，竞价涨幅 / 竞价量比只作辅助**。用户原话：
//   「所以最主要看占比，前面那两个都涨，有时也没有用……如果是竞价买，像当天就一路下跌，
//     即使明天涨，也得不偿失。只是说前面两个指标作为辅助，让占比更有确定性。」
//   「占比占重要决策，只要占比完全符合条件，就可以大胆持有。」
//   「以前那些买点或者卖点如果遇到冲突可以让路」⇒ 旧的量比方向口径【让路】，只当占比缺数据时的退路。
//
// ── 判定（买点与卖点【对称】，只差一个「动作词」────────────────────────────────────
//   前排 = 今日龙一 / 龙二，【或】昨日在龙头名册里（用户口径「昨日和今日龙一和龙二」）
//   后排 = 其余（含今日未成组的票）
//
//   买点：占比 ≥ 门槛 → 【竞价买】；否则 → 【尾盘买】
//   卖点：占比 ≥ 门槛 → 【尾盘卖】（还没走弱，拿到尾盘）；否则 → 【竞价卖】（开盘就走）
//   卖点 · 该股今天又在买点里 → 【持有】（今天是要买 / 加，不是卖）
//
//   🔴 [SHARE-PRIORITY 2026-10-04 用户口径 · 楚天龙 9/3] 上一条有个【例外】，也是本次新增：
//     该股今天又在买点里，【但占比不达标】⇒ 卖点标【竞价卖】、买点标【尾盘买（先卖后买）】，
//     ⛔ 两边都【不再标】持有类标签（含买点行尾仓位【持有】）。
//     判据 = 占比不达标 且 这一只昨天真被打过「买」标签（prevBought ⇒ 它必然同时在卖点里）。
//     用户原话：「占比2.5不达标。所以应该是竞价卖。同时它有进了买点那里。那就尾盘买。」
//     为什么：占比不达标 = 它今天【走弱了】，不能因为"又进买点"就当成强势股拿住 ——
//     正确动作是开盘先把昨天的仓卖掉、尾盘看情况再买回来（先卖后买）。
//     ⛔ 占比【达标】时仍然是【持有】（用户案例：花溪科技 9/2 3.6% 达标 → 持有）。
//
//   门槛见 auction-share.js：前排 4% 容错 0.5% ⇒ 3.5%；后排 2%。
//   §10：占比缺数据（缺竞价量 / 缺昨日成交量 / 除不出来）⇒ 【回落旧口径】（量比方向那套），
//        并在说明文字里如实写明「占比缺数据」，⛔ 绝不把「没抓到」当成「占比很低」。
/**
 * 【竞价卖】卖点动作：占比不到门槛 ⇒ 开盘就走（用户案例：华阳国际 1.8%、楚天龙 9/3 2.5%）。
 * 🔴 [SHARE-PRIORITY 2026-10-04 用户口径] 文案由【竞价出】统一为【竞价卖】——
 *   用户原话「应该是这个标签，'竞价卖'」。同一个动作只留一个词，⛔ 不许两处各叫一个名（§6）。
 *   ⚠️ 术语来源：用户同一条消息里也用过「竞价出」（华阳国际那条）—— 二者同义，已统一为【竞价卖】。
 */
export const SELL_OUT_TAG = '竞价卖';
/** 【尾盘卖】卖点动作：占比达标 ⇒ 当天还有走强趋势，不必开盘慌着走，拿到尾盘 */
export const SELL_LATE_TAG = '尾盘卖';
/** 卖点动作配色档（§21：由 Logic 层给，模板只拼 `'dcb-action-' + tone`） */
export const SELL_ACTION_TONE_OUT = 'out';    // 竞价卖 → 绿（走弱，尽早出）
export const SELL_ACTION_TONE_LATE = 'selllate'; // 尾盘卖 → 琥珀（还有机会，别急）

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [FOLLOW-DRAGON 2026-10-05 用户口径 · 同题材龙一限制] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话（9/9 大消费：国芳集团 = 龙一，安记食品 = 龙九）：
//   「如果同个题材前排倒下，后排是避免不了下跌的。因为他们是同类的。相当于将军倒下了，
//     士兵不会幸免。所以当同个题材中前排龙一国芳集团提示竞价卖（根据规则）的时候，
//     后排的龙九安记食品不应该提示尾盘卖，即使它符合现在的规则，应该和龙一绑定在一起，
//     标签是'跟龙竞价卖'，这样好区分点，也符合逻辑。也就是说要有同题材的龙一限制，
//     如果不是同题材，和原来一样……只是在原来规则⑦的基础上，加上这条优先规则，规则⑦要让路。」
//
// 判据（纯派生，⛔ 不新增取数）：
//   同一题材里，只要【今日龙一】（dragonRank === 1）的占比【有数据且不达标】⇒ 它已判【竞价卖】
//   ⇒ 该题材【其余所有票】一律改判【跟龙竞价卖】，⛔ 不再看它自己的占比（规则⑦让路）。
//
// §10 不猜（三种情况【不跟】，后排仍按规则⑦各自判定）：
//   ① 龙一占比【缺数据】⇒ 不知道它倒没倒，不替它下结论；
//   ② 龙一占比【达标】⇒ 它给的是【尾盘卖】（没倒），后排各判各的；
//   ③ 该题材的【龙一不在今天的卖点候选里】⇒ 看不到它的结论，就不跟。
//
// ⛔ 非同一题材的行【完全不变】（用户原话「如果不是同题材，和原来一样」）。
/**
 * 【跟龙竞价卖】卖点动作：同题材【今日龙一】已判【竞价卖】⇒ 同题材其余票跟着一起卖。
 * 用户原话「标签是'跟龙竞价卖'，这样好区分点」⇒ 独立文案 + 独立配色档（青蓝），
 * ⛔ 与「自己走弱」的【竞价卖】（绿）在视觉上分开：这一只不是自己走弱，是被同题材龙一带下去的。
 */
export const SELL_FOLLOW_DRAGON_TAG = '跟龙竞价卖';
/** 卖点动作配色档：跟龙竞价卖 → 青蓝（与竞价卖的绿、尾盘卖的琥珀三档分明） */
export const SELL_ACTION_TONE_FOLLOW = 'follow';

/**
 * 【前排 / 后排】判定（唯一实现，§6）—— 买点与卖点共用同一份判据。
 *
 * 用户口径：「昨日和今日龙一和龙二有容错率 0.5%」「龙三或者以下就不可以了太弱了，容错率很低」。
 *   · 今日龙一 / 龙二（行内「龙几」标签 = dragonRank）→ 前排；
 *   · 昨日在龙头名册里（previous trading day 的龙头组，见 getDragonLeadersForDisplay）→ 前排；
 *     用户案例「花溪科技 昨有买入，昨日龙一……用昨日龙一容错率高的规则」「金健米业……
 *     但是它昨天是龙一，龙一多条命」讲的正是这一条。
 *   · 其余 → 后排。
 *
 * §10：isPrevDragon === null（昨日龙头名册尚未加载）⇒ **不能**当成「昨日不是前排」，
 *   否则「还没拉到」会被伪装成「已经判定过后排」。此时只按今日龙位判，并返回
 *   frontUnknown=true，让调用方在说明文字里写明「昨日名册未加载」。
 *
 * @param {number|null} dragonRank 今日题材内龙位（1 起；null = 未知）
 * @param {boolean|null} isPrevDragon 昨日是否在龙头名册里（null = 名册未加载）
 * @returns {{isFront:boolean, frontUnknown:boolean, byToday:boolean, byPrev:boolean}}
 */
export function resolveDragonScope(dragonRank, isPrevDragon) {
  const byToday = (Number(dragonRank) === 1 || Number(dragonRank) === 2);
  const byPrev = (isPrevDragon === true);
  return {
    isFront: byToday || byPrev,
    frontUnknown: (isPrevDragon === null || isPrevDragon === undefined),
    byToday: byToday,
    byPrev: byPrev
  };
}

/** 前 / 后排 + 门槛 → 人话（说明文字用；⛔ 只在 Logic 层拼一次，别在组件里拼） */
function _scopeText(scope, isFront) {
  const base = isFront ? '前排（龙一 / 龙二）' : '后排（非龙一 / 龙二）';
  if (scope && scope.frontUnknown) return base + '〔昨日龙头名册未加载，只按今日龙位判定〕';
  return base;
}

/** 门槛 → 人话（含容错来源，用户要求说明文字能查出处）。
 *  ⛔ 门槛数值一律走 auctionShareThresholdOf（§6），不在这里自己写 3.5 / 2。 */
function _thresholdText(isFront) {
  const min = auctionShareThresholdOf(isFront);
  if (isFront) {
    return AUCTION_SHARE_FRONT_STD + '%（龙一 / 龙二容错 ' + AUCTION_SHARE_TOLERANCE +
      '% ⇒ 门槛 ' + min + '%）';
  }
  return min + '%';
}

// ===== [PREV-BOUGHT 2026-09-30 用户口径，同日修正为【股票级】] 「昨天已买」标记 =====
// 语义：这一只【股票】在上一交易日被打了「买」标签（= 用户手上已经有仓位）。
//   ⛔ 与 HOLD_TAG 是两件事，别混：
//      · HOLD_TAG  = 上一交易日的【买点方案】里也有它（系统【建议】买过）；
//      · PREV_BOUGHT_TAG = 上一交易日用户【实际】打了「买」标签（用户【真的】买了）。
//   两者可以同时出现；都不出现 = 没买过。
//
// 🔴 2026-09-30 事故与修正（用户反馈，真实数据：2026-09-29 的 buy 标签只有【世联行、新华文轩】2 只）：
//   第一版把这个标记做成了【题材级】（block.prevBoughtTopic / group.prevBoughtTopic，
//   在题材行「竞价一字：n」右边显示）。而它的判据是「卖出分组的题材」，于是：
//     世联行（题材 地产链）昨天买过 → 买点里【整个地产链块】都被标「昨天已买」，
//     可用户昨天并没有买这块里的大亚圣象 → 标签读起来像「大亚圣象昨天已买」= 错的；
//     只有同样昨天买过的新华文轩（在块里）读起来是对的。
//   ⇒ 用户口径修正：**改为【股票级】**，只标昨天真的打过「买」标签的那几只股票；
//     并且【卖点一律不标】——卖点候选本来就是「昨天打过买标签的股票」，标了等于全标，没信息量。
//
//   ⛔ 用的人别再用「题材」去筛：题材里只要有一只买过，整块都会被误解成「都买过」。
/** 【昨天已买】标记文案：该股票上一交易日被打过「买」标签（股票级，用户实际买入） */
export const PREV_BOUGHT_TAG = '昨天已买';

// ===== [TOPIC-PREV-BOUGHT 2026-09-30 第二次修正 · 用户口径] 标记【回到题材行】=====
// 🔴 口径演进（两次方向相反的反馈，务必看清，别再来回改）：
//   ① 第一版：题材级，判据 = 「卖出分组的题材」，文案「昨天已买」。
//      ⇒ 用户 9/30 反馈「大亚圣象昨天没买也被标」= 题材级读起来像【个股】结论 ⇒ 错。
//   ② 第二版（同日）：改成【股票级】，标在【股票行】股票名右边。
//   ③ 第三版（本条，同日稍后）：用户明确「昨天已买应该是标注在题材名称旁（竞价一字右边）」，
//      并已经在 AskUserQuestion 里确认选【只标题材行】。
//      ⇒ 于是【拆成两个不同语义的标记】，各就各位、互不混淆：
//         · 题材行 TOPIC_PREV_BOUGHT_TAG（本条）=「这个题材昨天有票被打过「买」标签」
//           —— 说的是【题材延续】，⛔ 不是「这块里每一只都买过」。
//         · 股票行【加仓】= 这一只昨天买过（见 _markPrevBought），仍按【逐只股票】判。
//      ⛔ 二者判据同一份数据源（上一交易日打过「买」标签的股票名），只是一处聚合到题材、一处落到个股。
//
// ⚠️ 事故复盘的教训：题材级的标记【必须换一个说法】，否则用户又会读成个股结论 ——
//    所以这里刻意不叫「昨天已买」，叫【昨有买入】。
/** 【昨有买入】标记文案：该题材上一交易日有股票被打过「买」标签（题材级，标在题材行） */
export const TOPIC_PREV_BOUGHT_TAG = '昨有买入';

// ===== [TOPIC-STREAK 2026-09-30 用户口径] 题材入选次数（近 N 个交易日）=====
// 用户原话：「如果题材在五天内，第一次入选进入买点，题材行（竞价一字旁边）应该标上，
//            一次入选，二次入选，三次入选……，这样我就知道频率」。
// 口径（AskUserQuestion 已确认，2026-09-30 二次修正）：
//   · 窗口 = 【含今日】的最近 5 个交易日；
//   · 数【全部买点块】出现的题材：重仓 / 轻仓。
//     🔴 上一版是「只数重仓/轻仓」，9/30 实测暴露：当天买点全在兜底方案里 ⇒ 整块看板无次数，
//        而计数范围与展示范围不一致必然产生这种「看不见的标记」。详见 _markTopicStreak 注释。
//     ⓘ 2026-10-01 起兜底方案已整体删除，买点只剩「第 1 / 第 2 名题材」两个块 ——
//        计数范围与展示范围依旧一致（都是全部买点块），所以本口径不用再改。
//   · 与【昨有买入】并存、互不冲突。
/** 题材入选次数统计窗口：含【今日】的最近几个交易日 */
export const TOPIC_STREAK_WINDOW = 5;
/** 中文序数（1~5 次；超过窗口用阿拉伯数字兜底，避免生造汉字） */
const STREAK_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/**
 * 入选次数 → 行内标签文案（§21：格式化在 Logic 层做完，模板只渲染）。
 * ⛔ 0 / 非法一律返回 ''（不显示），绝不显示成「零次入选」。
 * @param {number} n 含今日在内的入选次数
 * @returns {string} 如「三次入选」
 */
export function topicStreakText(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 1) return '';
  const cn = (v <= 10) ? STREAK_CN[v] : String(v);
  return cn + '次入选';
}

// ===== [RULE-NO 2026-09-27 用户口径，2026-10-01 重排] 规则编号 =====
// 用户原话：说明文字要标「规则几」，像法律条文一样可追溯。
// ⛔ 唯一真相：买点说明里出现的每一个规则编号都取自这里（§6），⛔ 不在 UI / 各处手写字面量
//    —— 否则改了规则内容却漏改说明，用户照着旧编号提修改意见就对不上。
// 2026-10-01 重排说明：旧编号 ⑤~⑩（连板天梯兜底 / 小题材 / 亏钱效应 / 弱势题材 / 双主线 / 买入只数）
//   对应的规则已整体删除，编号随之收起；保留的三条后置标记从 ⑪⑫⑬ 顺移到 ③④⑤。
export const RULE_NO = {
  FIRST: '①',          // 题材排名第 1 → 按【题材股票数量】分档、按【竞价量比】降序选票
  SECOND: '②',         // 题材排名第 2 → 与 ① 完全同一套分档规则
  HOLD: '③',           // 持有标记（上一交易日也在买点里）
  PREV_BOUGHT: '④',    // 【昨有买入】题材行标记 + 【持有】股票行仓位改写
  TOPIC_STREAK: '⑤',   // 【入选次数】题材行标记（近 5 个交易日内进过买点几次）
  // [MIN-3-PICKS 2026-10-02] 候选题材：① 主线票数不足 3 只 ⇒ 按排名往下推；
  //                          ② 第 1 名题材已够 3 只 ⇒ 第 2 名降级（双主线：只选最强的）
  CANDIDATE: '⑥',
  // [SHARE-RULE 2026-10-03 用户口径] 买卖【时机】以竞价占比为准（竞价买 / 尾盘买 / 尾盘卖 / 竞价卖）。
  //   买点与卖点共用这一条 —— 用户给的三天案例里，买卖两侧用的是同一个占比判据。
  SHARE: '⑦'
};

/** 规则编号 → 「【规则N】」前缀（说明文字统一从这里取，⛔ 不各处手写） */
export function ruleTag(no) {
  return '【规则' + no + '】';
}

/** 给一条说明加上规则出处前缀（§6：出处与规则实现同处一处，改规则不会漏改说明） */
function _note(no, text) {
  return ruleTag(no) + text;
}

/** 卖出时点 */
export const SELL_TIME_MIDDAY = '11:20';
export const SELL_TIME_CLOSE = '14:50';
/**
 * 【卖点例外】第 2 名题材【只有 1 个竞价一字】时，题材强度打折 ⇒ 只有龙一能拿到尾盘。
 * ⚠️ 2026-10-01 起这个常数【只服务于卖点】（买点的「一字门槛」已整体删除），
 *    所以刻意不再叫 MIN_YIZI_SINGLE，免得后来人以为买点还在看一字数。
 */
export const SECOND_TOPIC_SINGLE_YIZI = 1;

// ===== [SELL-OPEN 2026-09-29] 卖点按【今日竞价高低开】细分（用户口径）=====
// 背景：用户反馈原来的「题材前二 → 14:50 / 否则 11:20」太模糊 —— 卖点其实取决于
//   【今天这只票竞价怎么开】，而不是昨天它题材排第几。因此改成按今日竞价涨幅细分三档：
//   ① 深低开（竞价涨幅 ≤ SELL_DEEP_LOW）→ 【盯盘】：10:00 前看有没有反弹，冲高就出；
//        反弹不起来，10:00 也出（时点跟着时间走，不是一开盘就砸）。
//   ② 小低开（SELL_DEEP_LOW < 竞价涨幅 < 0）→ 【开盘立刻出】，行内打「❗危」警示，别等反弹。
//   ③ 小幅高开（0 < 竞价涨幅 < SELL_MILD_HIGH）→ 10:00 前看分时整体曲线：
//        向上 → 拿到 SELL_TIME_MIDDAY 卖；走弱向下 → 立刻卖。
//   ⚠️ 三档【未覆盖】的情形（竞价涨幅 ≥ SELL_MILD_HIGH / 恰好平开 / 缺竞价涨幅）⇒ 不产出提示，
//     行尾仍按上面的题材排名规则显示 SELL_TIME_MIDDAY / SELL_TIME_CLOSE。
//   ⚠️ §10：缺竞价涨幅 = 未知，⛔ 绝不退化成「平开」去套档，一律回落原规则。
//   ⚠️ 用户原话里的「-5%」经确认与「-3% ~ -5%」合并为同一档（都走「深低开 · 盯盘」），
//     因此深低开的唯一阈值就是 SELL_DEEP_LOW = -3。
//
// ===== [VR-ACTION 2026-10-02 用户口径] 在高低开之上，再叠加【竞价量比 vs 上一交易日】=====
// 用户原话（9/3 案例）：
//   · 楚天龙「竞价涨幅低开小于0，竞价量比当天比昨日下降，开盘立刻卖（打上危标签）」
//   · 香江控股「1. 竞价涨幅是负的（小于0），2. 竞价量比减少，从上交易日的 4.86 到当天的 2.78，
//     四舍五入整数后相差…两个指标，说明要立刻出」 —— 且该股是【深低开档】，
//     用户 AskUserQuestion 明确选「覆盖：低开+量比下降一律立刻出」
//   · 龙版传媒「竞价涨幅大于0，竞价量比基本是平的，看好，尾盘卖」；
//     并补充「如果当天的是 30，…而且是竞价量比下降，那就按原来的（立刻/看分时）不变」
//   ⇒ 新增两条叠加规则：
//     ⓐ 【低开 + 量比下降】→ 一律【开盘立刻出】（危），⛔ 【覆盖】原本的「深低开 → 盯盘」档。
//        理由：原本深低开还留一线「等 10:00 反弹」的指望，但量比同步下降说明承接也没了，
//        等反弹只是把亏损做大（香江控股就是这个组合）。
//     ⓑ 【小幅高开 + 量比没走弱（基本平 / 增强）】→ 【尾盘卖】（看好）。
//        理由：原规则对该档统一「看分时，向上 11:20 卖」，但量比没走弱就说明还没走弱
//        （用户原话「差距不到…四舍五入基本是平的，说明还没走弱」）⇒ 不必盘中盯，直接拿到尾盘。
//        ⛔ 量比【下降】时该档保持原样（看分时），用户原话「那就按原来的…不变」。
//   ⚠️ 量比方向未知（''）⇒ 两条叠加规则都不生效，完全回落上面 ① ② ③ 的原逻辑（§10 不猜）。
/** 深低开阈值：今日竞价涨幅【≤ 此值】⇒ 盯盘等反弹（10:00 前定夺） */
export const SELL_DEEP_LOW = -3;
/** 小幅高开上限：今日竞价涨幅在 (0, 此值) 之间 ⇒ 看分时决定（11:20 / 立刻） */
export const SELL_MILD_HIGH = 3;
/** 卖点提示语气（UI 只按 tone 做视觉映射，⛔ 不自己判断档位，§21） */
export const SELL_TONE_DANGER = 'danger';   // 小低开 → 开盘立刻出（危）
export const SELL_TONE_WATCH = 'watch';     // 深低开 → 盯盘等反弹（10:00 前定夺）
export const SELL_TONE_PLAN = 'plan';       // 小幅高开 → 看分时（向上 11:20 / 走弱立刻）
// [VR-ACTION 2026-10-02 用户口径] 小幅高开 + 竞价量比【没走弱】（平 / 增强）→ 看好，尾盘卖。
//   ⛔ 刻意与 plan（看分时）分开：plan 要求盘中盯分时，本档不用盯，是更确定的「拿满一天」。
export const SELL_TONE_HOLD = 'hold';       // 小幅高开 + 量比平/增强 → 尾盘卖（看好）
// [SELL-SURGE 2026-10-03 用户口径] 深低开 + 竞价量比【暴增】（今日 ÷ 上交易日 ≥ VR_SURGE_TIMES）→ 冲高就卖。
//   用户原话（9/30 案例）：「房地产的新世联（世联行），竞价跌幅 -9.97%，竞价量比增加 5 倍以上，
//   这类就要耐心等待冲高，概率非常高，打标签【冲高就卖】」
//   实测核对：世联行 9-29 量比 3.95 → 9-30 24.45 = 6.19 倍 ≥ 5 ⇒ 命中。
//   ⛔ 刻意与 watch（盯盘等反弹）分开：watch 是「反弹不起来 10:00 也出」，
//     本档是量能爆发的深低开（抢筹明显）⇒ 更该耐心等冲高，不是急着割。
export const SELL_TONE_SURGE = 'surge';
/** [SELL-SURGE 2026-10-03 用户口径] 深低开 + 量比暴增档的行尾时点文案（用户原话「打标签【冲高就卖】」） */
export const SELL_SURGE_LABEL = '冲高就卖';
/** 仓位建议文案 */
export const POSITION_HEAVY = '重仓';
export const POSITION_LIGHT = '轻仓';
/**
 * 【④ 昨天已买 · 股票级效果（2026-09-30 用户口径；2026-10-03 文案改【持有】）】
 *   该股票昨天已经被打过「买」标签（用户手上已有仓位）⇒
 *   仓位不再写「重仓 / 轻仓」，改写「持有」。
 *
 *   ⚠️ 「重仓 / 轻仓」是【买多少】的建仓建议；「持有」是【已有仓位继续拿】的动作，两者不同层，
 *      所以对已持有的票直接换文案，而不是并列显示。
 *
 *   🔴 [POSITION-HOLD 2026-10-03 用户口径] 文案由【加仓】改为【持有】：
 *     用户原话：「【规则⑫】【新华文轩】昨天已买…→ 行尾仓位改标【加仓】…应该把加仓变成持有，
 *     其它不变。」（9/30 实测：新华文轩 9-29 被打过「买」标签）
 *     ⚠️ 只改【文案】这一个词，判据（昨天打过「买」标签）与触发位置（买点行尾仓位）一律不动。
 *   ⛔ 只在【买点】生效；卖点本来就没有仓位列，不受影响。
 */
export const POSITION_HOLD = '持有';
/** 仓位配色档（§21：由 Logic 层给 tone，模板只做 `'dcb-pos-' + tone` 拼接，⛔ 不做比较） */
export const POSITION_TONE_HEAVY = 'heavy';
export const POSITION_TONE_LIGHT = 'light';
/** 昨天已买 → 紫色（与「重仓红 / 轻仓橙」区分；沿用 2026-09-30 加仓档的紫色，视觉连续） */
export const POSITION_TONE_HOLD = 'hold';

/** 仓位文案 → 配色档（模板零判断的唯一出口） */
export function positionToneOf(position) {
  if (position === POSITION_LIGHT) return POSITION_TONE_LIGHT;
  if (position === POSITION_HOLD) return POSITION_TONE_HOLD;
  return POSITION_TONE_HEAVY;
}

/**
 * 【弱票】判据 —— [VR-ACTION 2026-10-02 用户口径] ★唯一实现（§6）★。
 *
 * 定义：今日竞价涨幅 < 0 【且】今日 vs 上一交易日竞价量比【下降】（四舍五入整数差 ≤ -1）。
 *
 * 用户原话（9/3 案例）：
 *   · 「捷荣技术 竞价涨幅小于0，竞价量比当天比昨日（上个交易日）下降，预测当天优势不是很好，所以应该尾盘买」
 *   · 「楚天龙 竞价涨幅小于0，竞价量比当天比昨日下降…所以早上立刻卖，到尾盘再买回来」
 *   · 「香江控股…1. 竞价涨幅是负的（小于0），2. 竞价量比减少…两个指标，说明要立刻出」
 *   ⇒ 两个指标【同时】走弱才算弱票；只看其中一个都不算（用户原话「两个指标」）。
 *
 * ⚠️ 量比方向 ''（未知，§10）⇒【不算】下降 ⇒ 不是弱票（⛔ 未知不退化成「下降」，
 *   否则缺一天数据的票会被一律劝「立刻卖」，那是最贵的误判）。
 * ⚠️ 竞价涨幅 0（平开）⇒ 不是弱票（用户口径是「小于 0」）。
 *
 * @param {*} aucPct 今日竞价涨幅（%），null / 非数 = 缺数据
 * @param {'up'|'flat'|'down'|''} volRatioDir 今日 vs 上交易日竞价量比方向
 * @returns {boolean}
 */
export function isWeakAucDay(aucPct, volRatioDir) {
  const n = _num(aucPct);
  if (n === null || n >= 0) return false;
  return volRatioDir === VR_DIR_DOWN;
}

const OTHER = '其它';

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 题材名 → 今日排名（1 起）。不在榜（未成组 / 是「其它」/ 不成题材）→ null */
function _topicRankMap(blocks) {
  const m = new Map();
  blocks.forEach(function(b) { m.set(b.topic, b.rank); });
  return m;
}

/**
 * 【题材股票数量 → 档位】（§6 唯一实现：买点的「取几只」只由这里决定）。
 *
 * 用户口径（2026-10-01）：
 *   ≥ 10 只     → 3 只（量比前二重仓 + 第 3 只轻仓）
 *   7 ~ 9 只    → 2 只（第 1 只重仓 + 第 2 只轻仓）
 *   4 ~ 6 只    → 1 只（重仓）
 *   1 ~ 3 只    → 不出票（空仓）
 *
 * ⚠️ 边界刻意不重叠：7~9 与 4~6 各自成档，10 是「大档」的闭区间下界 ——
 *    与用户原话「大于等于 10」「7-9」「4-6」「1-3」逐字对应，⛔ 别自行改成 > 10 / ≥ 8 之类。
 * §10：count 缺失 / 非法 → 按 0 处理 ⇒ 落到 'none' 档（不出票），
 *      ⛔ 绝不因为「数字没读到」就假装它是一只大题材去铺票。
 *
 * @param {number|string|null} count 题材在早盘竞价里的股票只数（block.count）
 * @returns {{tier:string, min:number, max:number, heavyCount:number, count:number, rangeText:string}}
 *          tier = 'big' | 'mid' | 'small' | 'none'；max = 取几只；heavyCount = 其中几只重仓
 */
export function resolvePickTier(count) {
  const n = _num(count);
  const c = (n === null || n < 0) ? 0 : Math.floor(n);
  if (c >= PICK_TIER_BIG_MIN) {
    return {
      tier: 'big', count: c, max: PICK_COUNT_BIG, heavyCount: PICK_HEAVY_BIG,
      min: PICK_TIER_BIG_MIN,
      rangeText: '≥ ' + PICK_TIER_BIG_MIN + ' 只'
    };
  }
  if (c >= PICK_TIER_MID_MIN) {
    return {
      tier: 'mid', count: c, max: PICK_COUNT_MID, heavyCount: PICK_HEAVY_MID,
      min: PICK_TIER_MID_MIN,
      rangeText: PICK_TIER_MID_MIN + ' ~ ' + (PICK_TIER_BIG_MIN - 1) + ' 只'
    };
  }
  if (c >= PICK_TIER_MIN_COUNT) {
    return {
      tier: 'small', count: c, max: PICK_COUNT_MIN, heavyCount: PICK_HEAVY_MIN,
      min: PICK_TIER_MIN_COUNT,
      rangeText: PICK_TIER_MIN_COUNT + ' ~ ' + (PICK_TIER_MID_MIN - 1) + ' 只'
    };
  }
  return {
    tier: 'none', count: c, max: 0, heavyCount: 0, min: 0,
    rangeText: '不足 ' + PICK_TIER_MIN_COUNT + ' 只'
  };
}

/**
 * 【候选题材取几只】（§6 唯一实现）= 该题材主线档位【降一档】，且一律【轻仓】。
 *
 * 用户 2026-10-02 给出的两个实例（这是本函数的口径来源，⛔ 改之前先拿这两个数对一遍）：
 *   · 大题材（≥10 只）作候选 → 主线本可取 3 只 ⇒ 候选取 **2 只**（轻仓）；
 *   · 中档（7~9 只）作候选   → 主线本可取 2 只 ⇒ 候选取 **1 只**（轻仓）
 *     —— 9/30 的房地产（9 只）正是这一档：只选竞价量比最高的深物业A，深华发A 被排除在外。
 *
 * ⚠️ 小档（4~6 只）本来就是 1 只，再降就是 0 ⇒ **保底 1 只**
 *    （⛔ 候选题材选出 0 只会让「往下推」这一步白跑，用户要的是补足票数）。
 *
 * @param {{tier:string, max:number}} tier resolvePickTier 的返回
 * @returns {number} 候选题材取几只（≥1）
 */
export function candidatePickCount(tier) {
  const max = Number(tier && tier.max) || 0;
  return Math.max(1, max - 1);
}

/**
 * 题材排名 —— 与早盘竞价「题材 toggle」【完全同一套组序口径】。
 * 刻意复用 sortByTopicGroups（早盘竞价就在用它），而不是在本文件另写一遍比较器：
 * 另写必然分叉，分叉就会出现「决策看板说第一、早盘竞价显示第二」的错位（§6 单一真相）。
 *
 * ⭐ [TOPIC-ORDER 2026-10-01] 组序口径 = 【该题材的平均竞价量比】降序
 *   （传 topicOrder={by:'volRatio', volRatioOf}），与早盘竞价 view-helpers 的调用点【同一个参数】
 *   —— 这样「屏幕上的题材顺序 == 决策看板的题材排名 == 趋势图名次」三处必然一致。
 *
 * ⭐ [TWO-MODES 2026-10-02] 新增第 2 参 mode：**排名口径必须与早盘竞价当前那个 toggle 一模一样**，
 *   否则会出现「早盘竞价按一字排、决策看板按量比排」的错位（用户正是拿屏幕顺序核对决策结果的）：
 *     · MODE_VOL_RATIO（题材 toggle）→ 第 8 参 {by:'volRatio', volRatioOf}（默认，现行行为）；
 *     · MODE_YIZI（一字 toggle）    → 第 8 参【不传】⇒ sortByTopicGroups 的默认口径 = 一字数量降序。
 *   ⛔ 两种口径都【复用 sortByTopicGroups 这一个函数】，本文件绝不另写比较器（§6 单一真相）。
 *
 * @param {Array<{name:string, topic:string, isYizi?:boolean, countable?:boolean,
 *                inheritSold?:boolean, code?:string, pct?:number|null, aucPct?:number|null,
 *                aucVolRatio?:string|number|null}>} entries
 *        countable=false 的行（早盘竞价里「灰色名称 + 灰色题材」= 不在当日正式列表）
 *          不计入数量与一字数 —— 与早盘竞价统计条同口径；
 *          ⛔ 但它们照常参与【量比均值】与【选票】（§6 与统计条同一个分母：
 *             「数量不分灰色和常规，只要显示在上面的都要算进去」）。
 *          inheritSold=true = 「昨日卖标签继承」的行，同样照常参与。
 *        code = 股票代码（判 20%/30% 涨跌幅板用；本文件现已不据此跳过，仅作数据留痕，§40）。
 *        aucPct = 当日竞价涨幅（%）；null = 缺数据（§10：不能当 0，也就不能当「高开」）。
 *        aucVolRatio = 当日【竞价量比】原始值（云端字符串如 "2.18"）；缺值 → null（§10）。
 * @returns {Array<{rank:number, topic:string, count:number, yiziCount:number,
 *                  members:Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                                 aucVolRatio:number|null, code:string, countable:boolean,
 *                                 inheritSold:boolean}>}>}
 *          已剔除「其它」与不足 DECISION_MIN_GROUP 的题材；
 *          按组序（平均竞价量比 → 组大小 → 题材名）升序。
 */
export function rankDecisionTopics(entries, mode) {
  const list = (entries || []).filter(function(e) { return e && e.name; });
  if (list.length === 0) return [];

  const topicOf = function(i) {
    const t = String(list[i].topic || '').trim();
    return t || OTHER;
  };
  const order = sortByTopicGroups(
    list.map(function(_, i) { return i; }),
    list.map(function(e) { return { stock: e.name }; }),
    function() { return 0; },                                  // 单一档位：决策看板不分层
    topicOf,
    null,                                                      // 组内顺序在此不关心，下面按龙头重排
    function(i) { return !!list[i].isYizi; },
    function(i) { return list[i].countable !== false; },
    // ⭐ [TOPIC-ORDER 2026-10-01 用户口径] 第 8 参 = 题材组【组间排序口径】= 平均竞价量比降序。
    //   ⛔ 这里的取值函数必须与早盘竞价 view-helpers 那份【语义完全一致】：
    //      分子 = 该题材组内【所有拿到量比的行】的量比之和，分母 = 拿到量比的行数（含灰行），
    //      一行都拿不到 ⇒ null（§10 置底，⛔ 不当 0）。sortByTopicGroups 内部就是这样累加的，
    //      所以这里只需原样给出每行的量比原始值即可。
    // ⭐ [TWO-MODES 2026-10-02] 一字模式【不传】第 8 参 ⇒ 回到 sortByTopicGroups 的默认口径
    //   （一字数量降序 → 组大小降序 → 题材名），与早盘竞价「一字 toggle」的调用点完全同参。
    normalizeDecisionMode(mode) === MODE_YIZI
      ? undefined
      : { by: 'volRatio', volRatioOf: function(i) { return list[i].aucVolRatio; } }
  );

  const blocks = [];
  let cur = null;
  order.forEach(function(i) {
    const tp = topicOf(i);
    if (!cur || cur.topic !== tp) {
      cur = { topic: tp, count: 0, yiziCount: 0, members: [] };
      blocks.push(cur);
    }
    const countable = list[i].countable !== false;
    cur.members.push({
      name: list[i].name,
      isYizi: !!list[i].isYizi,
      pct: _num(list[i].pct),
      aucPct: _num(list[i].aucPct),
      // 当日【竞价量比】（倍数）—— 买点选票的唯一依据。
      //   由 decision-collect#_mkRow 从 market_metrics.auc_vol_ratio 原始值搬过来
      //   （云端存字符串如 "2.18"），这里统一用 _num 解析：缺值 / 空串 / 非数字 → null（§10）。
      aucVolRatio: _num(list[i].aucVolRatio),
      // [VR-COMPARE 2026-10-02 用户口径] 今日 vs 上交易日的竞价量比方向（up / flat / down / ''）。
      //   ⛔ 原样透传 decision-collect#_mkRow 算好的值（口径在 vol-ratio-trend，§6 单一真相），
      //      本文件是纯函数、不读 state ⇒ 这里【只搬运】，不重新计算。
      //   用途：买点量比标签的箭头/配色，以及「弱票 → 尾盘买 / 先卖后买」的判据。
      volRatioDir: list[i].volRatioDir || '',
      // [SHARE-RULE 2026-10-03 用户口径] 竞价占比（%）：买卖【时机】的唯一主判据。
      //   由 decision-collect#_mkRow 用 auction-share#computeAuctionShare 算好（公式唯一实现，§6），
      //   本文件是纯函数、不读 state ⇒ 这里【只搬运】。缺值 → null（§10，⛔ 绝不当 0）。
      aucShare: _num(list[i].aucShare),
      code: String(list[i].code || '').trim(),
      countable: countable,
      inheritSold: list[i].inheritSold === true
    });
    if (countable) {
      cur.count++;
      if (list[i].isYizi) cur.yiziCount++;
    }
  });

  return blocks
    .filter(function(b) { return b.topic !== OTHER && b.count >= DECISION_MIN_GROUP; })
    .map(function(b, i) { return Object.assign({ rank: i + 1 }, b); });
}

/**
 * 题材内龙头排名（龙一 / 龙二 / …）—— 与早盘竞价龙一徽章同源（computeDragonRankMap）。
 *
 * ⚠️ [QUANT-PICK 2026-10-01] 参数说明：新买点规则【不再按龙位选票】（一律按竞价量比），
 *    这里的排名只剩两个用途：
 *      ① 行内「龙几」标签（用户口径「标签不变」）；
 *      ② 竞价量比相同（或全体缺量比）时的【稳定次序】兜底，保证结果可复现、不随机。
 *
 * 候选集口径（2026-09-26 修订）：
 *   · m.pct === null → 缺十日涨幅，排不进龙位（§10：绝不当 0 参与比较）；
 *   · ⛔ m.countable === false【不再排除】—— 那是早盘竞价里「灰色名称 + 灰色题材」的行
 *     （不在当日正式列表，但确实是同时期龙头，9/8 大消费龙一国芳集团就是这种行）。
 *   · ⛔ m.inheritSold === true【同样不排除】（2026-09-27 修正）：「昨日卖标签继承」的行
 *     在早盘竞价里也是画灰的（灰色实心卖标签），9/8 大消费龙一国芳集团正是这种。
 *     ⛔ 结论：本看板【只用 countable 区分统计】，龙位【不因任何灰行身份而排除】。
 *
 * @param {Array<object>} blocks rankDecisionTopics 的返回
 * @returns {Map<string,{rank:number, pct:number, topic:string, groupSize:number}>}
 */
export function rankDragons(blocks) {
  const entries = [];
  const colored = new Set();
  (blocks || []).forEach(function(b) {
    colored.add(b.topic);
    b.members.forEach(function(m) {
      if (m.pct === null) return;             // §10：缺十日涨幅 → 排不进龙位
      entries.push({ name: m.name, topic: b.topic, pct: m.pct });
    });
  });
  return computeDragonRankMap(entries, { coloredTopics: colored, minGroupSize: DECISION_MIN_GROUP });
}

/**
 * 题材块 → 可买候选（按龙头名次升序）。买点选票【唯一】的候选来源（§6 单一真相）：
 *   · 竞价一字 → 买不进，剔除（用户 2026-10-01 口径：仍跳过）；
 *   · ⛔ 灰行【一律不剔除】：不在当日正式列表（countable=false）、昨日卖标签继承（inheritSold）
 *     都照常参与 —— 用户两次点名要它们能入选（9/8 国芳集团、万向德农）。
 *     灰行只影响【统计口径】（数量 / 一字数由 countable 决定），不影响选票。
 *   · ⭐ [2026-10-01] ⛔ 不再因「非龙一 + 20%/30% 涨跌幅板」顺延 ——
 *     用户口径「创业板 / 科创板 / 北交所【照选】，完全按量比」（AskUserQuestion 确认）。
 *     因此本函数相对旧版【删掉了 isHighLimitBoard 过滤】。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {Array<{name:string, pct:number|null, aucPct:number|null,
 *                  aucVolRatio:number|null, rank:number|null}>}
 */
function _buyCandidates(block, dragonMap) {
  if (!block) return [];
  const dragon = dragonMap || new Map();
  return (block.members || [])
    // 🔴 [YIZI-OCCUPY 2026-10-02 用户口径] 竞价一字【保留】在候选序列里，只打 isYizi 标记。
    //    ⛔ 别在这里 .filter 掉 —— 那会让后面的票【递补】进来，档位只数被填满，
    //       与用户 9/30 亲自算的那笔账对不上：
    //       「AI应用数量8，选2只；新华传媒竞价量比158.66，竞价一字买不到，
    //         新华文轩19.66（竞价量比第二名），非竞价一字可以买 ⇒ 实际上【只买】新华文轩。」
    //       即：一字【占名次】、【不递补】。若递补，AI应用 会出 2 只 ⇒ 主线已够 3 只
    //       ⇒ 就不会再往下推房地产作候选题材 —— 与用户「还差一只，排名第三作为候选」直接矛盾。
    //    灰行（不计数的继承壳等）一律保留，与一字同样处理（它们本来就不参与买入）。
    .map(function(m) {
      const d = dragon.get(m.name);
      return {
        name: m.name,
        pct: _num(m.pct),
        aucPct: _num(m.aucPct),
        // 竞价量比（倍数）：选票的唯一排序依据，只在这里透传一次（§6）
        aucVolRatio: _num(m.aucVolRatio),
        // [SHARE-RULE 2026-10-03] 竞价占比（%）：买卖【时机】的主判据，由 collect 算好挂在 members 上
        //   （公式唯一实现在 auction-share.js）。⛔ 这里只透传，不重算、也不补 0（§10）。
        aucShare: _num(m.aucShare),
        isYizi: !!m.isYizi,
        rank: (d && d.rank) ? d.rank : null
      };
    })
    .sort(function(a, b) {
      const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
      const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
}

function _toPick(c, position) {
  return {
    name: c.name,
    dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
    dragonRank: c.rank,
    pct: c.pct,
    // [SHARE-RULE 2026-10-03] 竞价占比透传到 pick 上，供 _decorateShareAction 判买卖时机（§10：缺值 null）
    aucShare: (c.aucShare === undefined ? null : c.aucShare),
    position: position
  };
}

// ===== [QUANT-PICK 2026-10-01 用户口径] 竞价量比选票（唯一实现，§6）=====

/** 竞价量比取值（§10：缺值 / 空串 / 非数字 → null，⛔ 绝不当 0 去比大小） */
function _volRatioOf(c) {
  return _num(c ? c.aucVolRatio : null);
}

/**
 * 【竞价量比】降序比较器 —— 买点选票的【唯一】排序实现（§6）。
 *
 * 优先级：
 *   ① 量比大者在前；
 *   ② §10：缺量比的票【不参与】「量比更大」的比较，一律排在有量比的票【后面】
 *      （⛔ 绝不当 0 —— 那会让「没抓到量比」变成「量比很小」，甚至把有数据的票顶下去）；
 *   ③ 量比相同（或都缺）→ 龙头名次靠前的优先（⛔ 只是稳定次序，不是选票依据）；
 *   ④ 仍相同 → 股票名，保证结果完全一致（不随机）。
 */
function _cmpVolRatioDesc(a, b) {
  const va = _volRatioOf(a);
  const vb = _volRatioOf(b);
  if (va === null && vb !== null) return 1;
  if (va !== null && vb === null) return -1;
  if (va !== null && vb !== null && vb !== va) return vb - va;
  const ra = (a.rank === null || a.rank === undefined) ? Number.MAX_SAFE_INTEGER : a.rank;
  const rb = (b.rank === null || b.rank === undefined) ? Number.MAX_SAFE_INTEGER : b.rank;
  if (ra !== rb) return ra - rb;
  return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
}

/** 量比 → 说明文字里的数值文案（缺值 → '—'，仅用于文案，⛔ 不参与比较） */
function _ratioText(r) {
  return (r === null || r === undefined) ? '—' : String(r);
}

/** 候选 → 量比文案（找不到该候选时返回 '—'，文案专用） */
function _ratioTextOfName(cands, name) {
  const c = (cands || []).filter(function(x) { return x.name === name; })[0];
  return _ratioText(c ? _volRatioOf(c) : null);
}

/**
 * 【按竞价量比取票 · 唯一实现（§6）】
 *
 * 口径（2026-10-01 用户口径）：
 *   · 在题材块里按【竞价量比】降序取前 maxCount 只；
 *   · 前 heavyCount 只记【重仓】，其余记【轻仓】；
 *   · ⛔ 不分龙一 / 龙二（用户原话「先不分龙一，龙二了，现在先以竞价量比为主」）——
 *     龙头名次只由 _cmpVolRatioDesc 在「量比并列」时当稳定次序用；
 *   · ⛔ 没有「龙一特例」也没有「卡位补偿」（旧版 ① 档的两条附加规则已随本次重写删除）。
 *
 * 🔴 [YIZI-OCCUPY 2026-10-02 用户口径] 【竞价一字：占名次、但不买入、也不递补】
 *   口径来源是用户 9/30 亲自算的那笔账（⛔ 改之前先拿这组数对一遍）：
 *     「AI应用数量8，选2只（7-9只数量买2只），新华传媒竞价量比158.66，竞价一字买不到，
 *       新华文轩19.66（竞价量比第二名），非竞价一字可以买 ⇒ 所以实际上【只买】新华文轩。重仓」
 *   即：档位说「取 2 只」= 取【量比排名前 2 名】；第 1 名是一字 ⇒ 买不进 ⇒ **少买一只**，
 *       ⛔ 绝不让第 3 名递补进来。反证：若递补，AI应用 当天会出 2 只，
 *       「新能源 1 只 + AI应用 2 只」就已够保底 3 只 ⇒ 根本不会推房地产作候选题材 ——
 *       这与用户「还差一只，排名第三作为候选」直接矛盾。
 *   仓位同理：重仓名额发给【实际买入的票】里的前 heavyCount 只，
 *       所以上面这笔账里新华文轩是第 2 名却是【重仓】（第 1 名的一字不占仓位名额）。
 *
 * §10 红线：
 *   · 缺量比的票排在有量比的票之后（由 _cmpVolRatioDesc 保证）；
 *   · 【全体候选都缺量比】⇒ 退回【按龙头名次】取前 maxCount 只，并如实写进说明
 *     （⛔ 绝不假装「量比都是 0」，也绝不再往下退回更弱的方案 —— 用户要的就是量化结果）。
 *
 * 🔴 [YIZI-ALL-CLEAR 2026-10-02 用户口径 v2] 上面 ③ 的例外（9/29 用户截图反馈）：
 *   小档（4~6 只）本档只取 1 只 ⇒ 若唯一名次被竞价一字占掉 ⇒ 整块题材「没有可买的票」。
 *   用户原话「ai应用和新能源汽车有票啊，但是决策看板那里为什么没选出来，提示没有票？」
 *   ⇒ 本档名次【全被一字占掉】时，继续往下取【可买的票】补位（最多 limit 只）；
 *     只要名次里还有一只可买的，就【不补位】（9/30 AI应用 只买新华文轩的口径保持不变）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {number} maxCount 取几只（由 resolvePickTier 给出）
 * @param {number} heavyCount 其中几只重仓
 * @param {string} [ruleNo] 说明文字里引用的规则编号
 * @returns {{picks:Array, notes:string[], byRankFallback:boolean,
 *            slotCount:number, skippedNames:string[], filledFromBelow:number}}
 *          byRankFallback = 全体候选缺量比 ⇒ 本条是「按龙头名次」的退路（§10 不猜）
 *          slotCount = 实际占掉的名额数（≤ maxCount）；skippedNames = 占名额但买不进的一字票名
 *          filledFromBelow = 名次全被一字占掉后往下补到的票数（0 = 未触发）
 */
export function pickByVolRatio(block, dragonMap, maxCount, heavyCount, ruleNo) {
  const notes = [];
  const no = ruleNo || RULE_NO.FIRST;
  const limit = Number(maxCount) > 0 ? Math.floor(Number(maxCount)) : 0;
  const heavyN = Math.max(0, Math.min(Number(heavyCount) || 0, limit));
  // ⚠️ 候选序列【含竞价一字】（一字占名次，见文件头 YIZI-OCCUPY 口径）
  const cands = _buyCandidates(block, dragonMap);
  if (cands.length === 0 || limit === 0) {
    return { picks: [], notes: notes, byRankFallback: false, slotCount: 0, skippedNames: [] };
  }

  const byRankFallback = cands.filter(function(c) { return _volRatioOf(c) !== null; }).length === 0;
  // ① 先排【全部成员】的顺序（一字也在里面按量比占位）
  const ordered = byRankFallback ? cands.slice() : cands.slice().sort(_cmpVolRatioDesc);
  // ② 取档位只数（limit）个名次
  const slots = ordered.slice(0, limit);
  // ③ 其中的竞价一字【买不进且不递补】⇒ 剔除出买入名单
  const skippedNames = slots.filter(function(c) { return c.isYizi; })
    .map(function(c) { return c.name; });
  let bought = slots.filter(function(c) { return !c.isYizi; });

  // 🔴 [YIZI-ALL-CLEAR 2026-10-02 用户口径 v2] 【本档名次被竞价一字占满】的例外。
  //
  // 用户 2026-10-02 截图反馈（9/29）：AI应用（数量 6 ⇒ 小档，本档只取 1 只）与
  //   新能源汽车（数量 4 ⇒ 小档）都提示「没有可买的票」，用户原话：
  //   「ai应用和新能源汽车有票啊，但是决策看板那里为什么没选出来，提示没有票？」
  //   根因：小档 limit=1 ⇒ slots 只有量比第一名；而那一名恰好是竞价一字 ⇒ bought 为空
  //   ⇒ 整个题材出 0 只。可该题材明明还有别的能买的票（6 只里只有 1 只是一字）。
  //
  // 口径（⭐ 与 9/30 那笔账【并存不冲突】，⛔ 改之前必须同时对上这两个案例）：
  //   ① 一字【照旧占名次、不递补】（9/30 口径不变）：AI应用 8 只取前 2 名 =
  //      新华传媒(一字) + 新华文轩 ⇒ 有 1 只可买 ⇒ 【不触发】下面的补位 ⇒ 仍只买新华文轩 1 只。
  //   ② 【本档一只可买的都没有】时（名次全被一字吃掉）⇒ 视为本档没有可用名次，
  //      继续往下找【可买的票】补位，最多补到 limit 只（9/29 的 AI应用 / 新能源汽车走这条）。
  //
  // ⛔ 别改成「只要名次里有字就往下补」—— 那会把 9/30 的 AI应用 从 1 只变成 2 只，
  //    与用户当时那笔账（仅买入新华文轩）直接矛盾。
  // ⛔ 也别把它当成「一字不占名次」—— 一字照旧吃掉名次，只是不吃掉【整块题材】。
  let filledFromBelow = 0;
  if (bought.length === 0 && skippedNames.length > 0) {
    const below = ordered.slice(limit).filter(function(c) { return !c.isYizi; }).slice(0, limit);
    filledFromBelow = below.length;
    bought = below;
  }
  // ④ 仓位按【实际买入的票】顺序分配：前 heavyN 只重仓，其余轻仓
  const picks = bought.map(function(c, i) {
    return _toPick(c, i < heavyN ? POSITION_HEAVY : POSITION_LIGHT);
  });

  const ratioText = picks.map(function(p) { return p.name + ' ' + _ratioTextOfName(cands, p.name); }).join(' ＞ ');
  const posText = heavyN > 0
    ? ('前 ' + heavyN + ' 只' + POSITION_HEAVY + (picks.length > heavyN
      ? '、其余 ' + (picks.length - heavyN) + ' 只' + POSITION_LIGHT
      : ''))
    : (picks.length + ' 只' + POSITION_LIGHT);
  notes.push(_note(no, '按【竞价量比】降序取前 ' + slots.length + ' 名（' + ratioText + '）→ ' + posText +
    (byRankFallback ? '；⚠️ 本题材全部缺竞价量比，本条是【按龙头名次】的退路（§10 不猜）' : '')));
  if (skippedNames.length > 0) {
    notes.push(_note(no, filledFromBelow > 0
      // [YIZI-ALL-CLEAR] 名次全被一字占掉 ⇒ 走补位，如实说明补了几只（§10 不静默）
      ? ('⚠️ 本档名次全被【竞价一字】占掉（' + skippedNames.join('、') +
        '）→ 本档没有可用名次 ⇒ 继续往下取【可买的票】补位 ' + filledFromBelow +
        ' 只（一字照旧占名次，但不会让整个题材一只都出不了）')
      : ('⚠️ 量比前 ' + slots.length + ' 名里有 ' + skippedNames.length +
        ' 只是【竞价一字】（' + skippedNames.join('、') + '）→ 买不进，且【占名次不递补】' +
        ' ⇒ 实际买入 ' + picks.length + ' 只')));
  }

  return {
    picks: _reseq(picks), notes: notes, byRankFallback: byRankFallback,
    slotCount: slots.length, skippedNames: skippedNames,
    // [YIZI-ALL-CLEAR 2026-10-02] 本档名次全被一字占掉后，往下补位取到的票数（0 = 没触发）
    filledFromBelow: filledFromBelow
  };
}

/** 重排序号（序号从 1 连续；合并「重仓 + 轻仓」后必须重排，否则序号会重复） */
function _reseq(picks) {
  return picks.map(function(p, i) { p.seq = i + 1; return p; });
}

function _reasonBuy(block, rankWord) {
  if (!block) return '';
  return '题材排' + rankWord + '，股票数量' + block.count + '只，' + block.yiziCount + '个竞价一字';
}

/**
 * 【买点块构造 · 唯一实现（§6）】题材排名第 1 / 第 2 都用它 ——
 * 差别只有「排名词」（第一 / 第二）与「规则编号」（① / ②），选票逻辑完全同一份。
 *
 * 流程：
 *   ① resolvePickTier(block.count) 定档（≥10 → 3 只 / 7~9 → 2 只 / 4~6 → 1 只 / ≤3 → 不出票）；
 *   ② 非 'none' 档 → pickByVolRatio 按竞价量比降序取票；
 *   ③ 'none' 档 ⇒ qualified=false + notQualifiedText（UI 显示「本题材不出票」），picks 恒为空。
 *
 * ⚠️ 不会出现「有档位却一只都取不到就静默空着」的情况：
 *    取不到（全是竞价一字 / 没有可买成员）会写进 notQualifiedText，如实说明原因（§10）。
 *
 * @param {object} block 题材块（rankDecisionTopics 的元素，含 count / yiziCount / members）
 * @param {Map} dragonMap rankDragons 的返回
 * @param {string} rankWord '第一' / '第二'
 * @param {string} ruleNo RULE_NO.FIRST / RULE_NO.SECOND
 * @returns {{block:object, rankWord:string, reason:string, mode:string, ruleNo:string,
 *            qualified:boolean, notQualifiedText:string, picks:Array, notes:string[]}}
 */
function _buildTopicBuyBlock(block, dragonMap, rankWord, ruleNo, opts) {
  const o = opts || {};
  // [MIN-3-PICKS 2026-10-02] candidate=true ⇒ 这是【候选题材】：主线档位【降一档】+【全部轻仓】
  const isCandidate = !!o.candidate;
  const tier = resolvePickTier(block.count);
  const head = _reasonBuy(block, rankWord) + (isCandidate ? '（' + CANDIDATE_TAG + '）' : '') +
    '　→ 根据规则' + ruleNo + '：';
  const base = {
    block: block,
    rankWord: rankWord,
    // ⓘ 决策看板【内部】的排名（= 合格题材里的序号，1 起）。
    //   它与 block.rank（= 全部题材里的排名）【不是一回事】：数量不达标的题材被跳过、不占名次，
    //   所以 9/30 的「新能源汽车」block.rank=2 但 pickRank=1（用户口径「变成了新能源汽车排第一」）。
    //   UI 的实心红圆点显示这个数（⛔ 别改成显示 block.rank，那会把被排除的农业算进去）。
    pickRank: Number(o.pickRank) > 0 ? Math.floor(Number(o.pickRank)) : null,
    reason: '',
    mode: tier.tier,
    ruleNo: ruleNo,
    // ⛔ isCandidate / candidateTag 由【本函数】给出，UI 只读不判（§21 模板零计算）
    isCandidate: isCandidate,
    candidateTag: isCandidate ? CANDIDATE_TAG : '',
    qualified: false,
    notQualifiedText: '',
    picks: [],
    notes: []
  };

  // ≤ 3 只：不进入决策范围（用户口径「数量只有 1-3 只的不进入决策范围，空仓」）
  // ⓘ 走到这里的只有「不被跳过」的题材：buildBuyPlan 已先把 ≤3 只的题材剔除、不占名次，
  //    本分支只是同一口径的第二道闸（例如直接单测本函数、或日后改动漏了筛选）。
  if (tier.tier === 'none') {
    base.notQualifiedText = _note(ruleNo, '该题材股票数量只有 ' + tier.count + ' 只（' +
      tier.rangeText + '）→ 不进入决策范围 → 【空仓】');
    base.reason = head + '股票数量只有 ' + tier.count + ' 只（' + tier.rangeText + '）→ 空仓';
    return base;
  }

  // 'none' 以外：档位文字（大档 / 中档 / 小档 —— 各自取几只、几只重仓）
  const tierWord = tier.tier === 'big' ? '大档' : (tier.tier === 'mid' ? '中档' : '小档');
  // 候选题材：取票数 = 主线档位降一档；保底补位时再与「还差几只」取小
  const candMax = candidatePickCount(tier);
  const wantMax = isCandidate ? candMax : tier.max;
  const max = (isCandidate && Number(o.pickMax) > 0)
    ? Math.min(candMax, Math.floor(Number(o.pickMax)))
    : wantMax;
  const heavyN = isCandidate ? 0 : tier.heavyCount;

  const tierText = '股票数量 ' + tier.count + ' 只（' + tier.rangeText + ' · ' + tierWord + '）→ 按【竞价量比】降序取前 ' +
    max + ' 只' + (isCandidate
      ? '（' + CANDIDATE_TAG + '：主线本档取 ' + tier.max + ' 只 → 降一档取 ' + candMax +
        ' 只，且全部' + POSITION_LIGHT + '）'
      : (heavyN > 0
        ? '（前 ' + heavyN + ' 只' + POSITION_HEAVY +
          (max > heavyN ? ' + 其余 ' + (max - heavyN) + ' 只' + POSITION_LIGHT : '')
        : ''));

  const r = pickByVolRatio(block, dragonMap, max, heavyN, ruleNo);
  base.notes = base.notes.concat(r.notes);
  base.qualified = r.picks.length > 0;
  base.picks = r.picks;

  if (base.qualified) {
    base.reason = head + tierText;
    // ⓘ 一字「占名次不递补」的说明由 pickByVolRatio 自己写好（更贴近选票那一刻的事实），
    //    这里只补「成员本身就不够」的那一种情况（§10 如实呈现，不静默少给）。
    if (!(r.skippedNames && r.skippedNames.length > 0) && r.picks.length < max) {
      base.notes.push(_note(ruleNo, '⚠️ 本档要求取 ' + max + ' 只，但该题材成员只有 ' +
        r.slotCount + ' 名 → 实际取 ' + r.picks.length + ' 只'));
    }
  } else {
    // [YIZI-ALL-CLEAR 2026-10-02] 走到这里 = 【连往下补位都补不到】：本档名次全被一字占掉，
    //   而且后面再没有非一字的成员（或本档可买只数本来就是 0）。
    //   ⛔ 旧文案「成员全部是竞价一字」在「本档只取 1 只、而 6 只成员里只有 1 只是一字」时是错的
    //      —— 9/29 用户正是被这句话误导（AI应用 6 只却提示「成员全部是竞价一字」）。
    //   §10：原因必须如实写出来，不能糊成一句笼统的「没有成员」。
    const yiziNames = (r.skippedNames || []);
    const why = yiziNames.length > 0
      ? ('本档名次全被【竞价一字】占掉（' + yiziNames.join('、') + '），后面再没有能买的成员')
      : '本档没有成员';
    base.notQualifiedText = _note(ruleNo, tierText +
      '，但该题材【没有可买的票】（' + why + '）→ 本题材不出票');
    base.reason = head + tierText + '，但没有可买的票（' + why + '）→ 不出票';
  }
  return base;
}

/**
 * 【④ 低开龙一 · 文字提醒（2026-09-26 用户口径）】
 *
 * 用户原话：龙一如果【低开】，要自己去观察它的【竞价图形】是不是【跌停 L 形】；
 *   是 L 形就【尾盘买】。（9/3 捷荣技术就是这种情形）
 * ⚠️ 竞价图形本看板拿不到（没有分时数据），所以这里【只加提醒文字】，⛔ 不改任何选票结果与仓位。
 * ⓘ 2026-10-01 起买点不再按龙位选票，但行内仍显示「龙几」标签 ——
 *   这里只对【恰好被选中、且名次为龙一】的票做提醒；没被选中就不提（没买就不需要这条）。
 *
 * @param {object} blockObj 买点块（block + picks + notes）
 */
function _appendLowOpenDragonOneNote(blockObj) {
  if (!blockObj || !blockObj.block || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const aucOf = new Map();
  (blockObj.block.members || []).forEach(function(m) { aucOf.set(m.name, _num(m.aucPct)); });
  blockObj.picks.forEach(function(p) {
    if (p.dragonRank !== 1) return;
    const auc = aucOf.get(p.name);
    if (auc === null || auc === undefined || auc >= 0) return;
    (blockObj.notes || (blockObj.notes = [])).push(
      '⚠️ 龙一「' + p.name + '」竞价低开（' + auc + '%）→ 请自行看它的竞价图形：' +
      '若出现【跌停 L 形】，改为【尾盘买】（本看板不判断图形，只做提醒）');
  });
  return blockObj;
}

/**
 * 【竞价涨幅徽标 2026-09-29 用户口径】买点行在「十日涨幅」后面也显示【竞价涨幅】标签，
 * 样式与卖点完全一致（复用 formatAucPct + getAucOpenKind，§6 不另写格式化与配色）。
 *
 * ⛔ 用 block.members 反查 aucPct —— 买点的 picks 全部是从 members 里筛出来的（name 一一对应），
 *   所以以后新增 / 调整选票规则时【不需要】在每个 picks 构造点补 aucPct 字段，只此一处收口
 *   （同样的反查范式见上面的 _appendLowOpenDragonOneNote）。
 * §10：members 里查不到该票 / 该票缺竞价涨幅 ⇒ 产空串，模板 v-if 直接不渲染，绝不补 0.00%。
 */
function _decorateAucBadge(blockObj) {
  if (!blockObj || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const aucOf = new Map();
  ((blockObj.block && blockObj.block.members) || []).forEach(function(m) {
    if (m && m.name) aucOf.set(m.name, m);
  });
  blockObj.picks.forEach(function(p) {
    const m = aucOf.get(p.name);
    const n = _num(m ? m.aucPct : null);
    p.aucPctText = formatAucPct(n);
    p.aucTone = getAucOpenKind(n) || '';
    // [VR-ACTION 2026-10-02] 顺手把【数值】也落到 pick 上：买点「弱票 → 尾盘买 / 先卖后买」的判据
    //   （isWeakAucDay）要读它。⛔ 不另写一遍 members 反查 —— 那份反查表只在这里建一次（§6）。
    p.aucPct = n;
    // [SHARE-RULE 2026-10-03] 同一次反查里把【占比】与【量比方向】也落到 pick 上：
    //   前者是买卖时机的新主判据，后者是它缺数据时的退路。⛔ 都只从 members 取一次（§6 单一真相）。
    p.aucShare = _num(m ? m.aucShare : null);
    p.volRatioDir = (m && m.volRatioDir) ? m.volRatioDir : '';
  });
  return blockObj;
}

/**
 * 【⑦ 买入时机：竞价买 / 尾盘买 —— [SHARE-RULE 2026-10-03 用户口径]】
 *
 * 判据 = 【竞价占比】（当日竞价量 ÷ 昨日成交量），门槛见 auction-share.js：
 *   · 前排（今日或昨日 龙一 / 龙二）→ 4%，容错 0.5% ⇒ 3.5%；
 *   · 后排（其余）→ 2%；
 *   · 占比 ≥ 门槛 ⇒ 行尾标【竞价买】（占比够强，竞价就得下手，等尾盘反而更贵 / 买不到）；
 *   · 占比 < 门槛 ⇒ 行尾标【尾盘买】（别追开盘，等尾盘再看）。
 *
 * 🔴 [SHARE-PRIORITY 2026-10-04 用户口径 · 楚天龙 9/3] 上面第 2 条有个【例外】：
 *   占比不达标【且】这一只【昨天真买过】（prevBought ⇒ 它必然同时在卖点里）
 *   ⇒ 只给【尾盘买（先卖后买）】一枚，并把行尾仓位【持有】和 ③ 的【持有】一起清掉。
 *   为什么：卖点那边同时会给【竞价卖】，两句合起来才是完整的「先卖后买」；
 *   留着【持有】会被读成「拿着别动」，与「今天要卖」直接矛盾。
 *   ⛔ 占比【达标】时不受影响（照常【竞价买】+ ③ 的【持有】）。
 *
 * 用户给的买点案例（本函数必须逐条对上，见 auction-share.test.js）：
 *   金健米业 4.4%(龙一) → 竞价买 ｜ 花溪科技 4.4%(龙一) → 竞价买 ｜ 捷荣技术 7.0%(龙一) → 竞价买
 *   楚天龙 5.5%(龙一) → 竞价买 ｜ 龙版传媒 6.9%(后排) → 竞价买 ｜ 花溪科技 3.6%(昨日龙一, 容错) → 竞价买
 *   海登种业 0.2%(原始 0.15%, 龙七, 后排, 远不到 2%) → 尾盘买
 *   楚天龙 9/3 2.5%(昨有买入, 不达标) → 尾盘买（先卖后买），且清掉行尾【持有】/ ③ 的【持有】
 *
 * ⚠️ 竞价涨幅 / 竞价量比【降级为辅助】：不再单独决定时机，只写进说明文字供人复核
 *   （用户原话「前面两个指标作为辅助，让占比更有确定性」）。
 *
 * §10 退路：占比缺数据（缺当日竞价量 / 缺昨日成交量）⇒ 回落【旧的量比方向口径】：
 *   量比增强 → 竞价买；量比下降 → 已持仓则【先卖后买】、未持仓则【尾盘买】；平 / 未知 → 不给动作标签。
 *   并在说明文字里如实写明「占比缺数据」——⛔ 绝不把「没抓到」当成「占比很低」。
 *
 * ⛔ 只改【动作标签】与说明文字，不碰选票结果（用户口径「选票没问题」）。
 *   ⚠️ 唯一例外：占比不达标 + 昨有买入时会把【仓位】清空（见上面那条新规）——
 *     这是用户明确要求的「把持有去掉就可以，改成只有「尾盘买（先卖后买）」」。
 *
 * @param {object} blockObj 买点块（须已跑过 _decorateAucBadge，picks 上有 aucShare / volRatioDir / aucPct）
 * @param {{prevDragonNames?:Set<string>|null, prevBoughtNames?:Set<string>|null}} [opts]
 *        prevDragonNames = 昨日龙头名册（判「前排」的第二条腿；null = 未加载 ⇒ §10 只按今日龙位）
 *        prevBoughtNames = 上一交易日打过「买」标签的股票名（判「先卖后买」；§10 退路也用它）
 */
function _decorateShareAction(blockObj, opts) {
  if (!blockObj || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const o = opts || {};
  const prevDragon = o.prevDragonNames || null;
  const prevBought = o.prevBoughtNames || null;
  // ⚠️ [TWO-MODES] 规则编号【分模式】：量比模式是 ⑦，一字模式（legacy）是 ⑭ —— 由调用方传进来，
  //   ⛔ 不许写死本模块那一份，否则一字模式的行内说明会显示「【规则⑦】」，与它的规则清单对不上
  //   （与 _markHold / _markPrevBought 的 ruleNo 参数同一套路）。
  const no = o.ruleNo || RULE_NO.SHARE;

  blockObj.picks.forEach(function(p) {
    const share = _num(p.aucShare);
    const isPrevDragon = prevDragon ? prevDragon.has(p.name) : null;
    const scope = resolveDragonScope(p.dragonRank, isPrevDragon);
    const isFront = scope.isFront;
    // ⛔ 达标判定走 auction-share 的唯一实现（§6）—— 别在这里自己写 `share >= 门槛`，
    //    否则「门槛是多少」会分裂成两处，第 4 步改门槛时必漏一处。
    const pass = passesAuctionShare(share, isFront);

    // §21：占比的展示字段全部在 Logic 层算好，模板只渲染
    p.aucShareText = formatAuctionShare(share);
    p.aucShareTone = auctionShareZoneOf(share);
    p.aucShareScopeText = _scopeText(scope, isFront);
    p.aucShareThresholdText = _thresholdText(isFront);
    p.aucSharePass = (share === null) ? null : pass;

    const dir = String(p.volRatioDir || '');
    const aucPct = _num(p.aucPct);
    const weak = isWeakAucDay(aucPct, dir);

    if (share !== null) {
      // ── 新规：占比说了算 ──
      // 🔴 [SHARE-PRIORITY 2026-10-04 用户口径 · 楚天龙 9/3] 先判「先卖后买」这一档：
      //   占比【不达标】＋ 这一只【昨天真买过】⇒ 它今天必然同时出现在【卖点】里，
      //   卖点那边给的是【竞价卖】（开盘先卖），买点这边就给【尾盘买（先卖后买）】（尾盘再接回）。
      //   ⛔ 这一档【不再标持有类标签】：行尾仓位【持有】与 ③ 的【持有】都清掉 ——
      //     用户原话「把持有去掉就可以，改成只有「尾盘买（先卖后买）」」。
      //     ⚠️ 为什么必须清仓位：留着【持有】会被读成「不用卖」，与今天的【竞价卖】直接矛盾。
      //   §10：prevBought 为 null（昨天标签没读到）⇒ 不判这一档，按普通【尾盘买】给（未知 ≠ 昨天没买）。
      //   ⛔ 判据走 _isLateSwapPick 这一个函数（与 _markHold 共用，§6）—— 别在这里再写一遍条件，
      //      否则「哪算先卖后买」会分裂成两处，改门槛时必漏一处。
      const swapCase = _isLateSwapPick(p, { prevBoughtNames: prevBought, prevDragonNames: prevDragon });
      if (pass) {
        p.buyActionTag = BUY_NOW_TAG;
        p.buyActionTone = BUY_ACTION_TONE_NOW;
      } else if (swapCase) {
        p.buyActionTag = BUY_LATE_SWAP_TAG;
        p.buyActionTone = BUY_ACTION_TONE_SWAP;
        p.holdTag = '';
        p.position = '';
        p.positionTone = '';
      } else {
        p.buyActionTag = BUY_LATE_TAG;
        p.buyActionTone = BUY_ACTION_TONE_LATE;
      }
      p.actionNote = _note(no,
        '竞价占比 ' + formatAuctionShare(share) + '（' + p.aucShareScopeText + '门槛 ' +
        p.aucShareThresholdText + '）⇒ 占比' + (pass ? '达标' : '不达标') + '，' +
        (pass
          ? '【' + BUY_NOW_TAG + '】：竞价就得下手，等尾盘反而更贵 / 买不到'
          : (swapCase
            ? '【' + BUY_LATE_SWAP_TAG + '】：这一只昨天已经买过（卖点里也有它）⇒ ' +
              '开盘先按卖点的【' + SELL_OUT_TAG + '】把昨天的仓卖掉，尾盘再接回来；' +
              '所以本行【不再标持有】（⛔ 留着会被读成「不用卖」）'
            : '【' + BUY_LATE_TAG + '】：别追开盘，等尾盘再看')) +
        '。辅助验证：竞价涨幅 ' + formatAucPct(aucPct) +
        '、竞价量比' + _dirWord(dir) + '（辅助，不单独决定时机）。');
      return;
    }

    // ── §10 退路：占比缺数据 → 回落旧的「量比方向」口径，并如实说明 ──
    if (dir === VR_DIR_UP) {
      p.buyActionTag = BUY_NOW_TAG;
      p.buyActionTone = BUY_ACTION_TONE_NOW;
    } else if (dir === VR_DIR_DOWN) {
      if (prevBought && prevBought.has(p.name)) {
        p.buyActionTag = SELL_FIRST_BUY_LATER_TAG;
        p.buyActionTone = BUY_ACTION_TONE_SWAP;
      } else {
        p.buyActionTag = BUY_LATE_TAG;
        p.buyActionTone = BUY_ACTION_TONE_LATE;
      }
    } else {
      p.buyActionTag = '';
      p.buyActionTone = '';
    }
    p.actionNote = _note(no,
      '⚠️ 竞价占比【缺数据】（缺当日竞价量 / 缺昨日成交量）⇒ 本行【回落旧的量比方向口径】：' +
      '竞价量比' + _dirWord(dir) + (weak ? '（弱票）' : '') + ' ⇒ ' +
      (p.buyActionTag ? ('【' + p.buyActionTag + '】') : '暂不给动作标签') +
      '。⛔ 这不是「占比很低」，是没抓到数据（§10）。');
  });
  // ⚠️ 刻意【不往 block.notes 写任何一条】：这些结论现在都落在【逐行的 actionNote】上
  //   （组件就渲染在该行正下方，用户一眼能看到「为什么是竞价买 / 尾盘买」）。
  //   ⛔ 别再往块级说明里罗列股票名 —— 那会把「④ 昨有买入只提真的买过的那只」
  //      这类可追溯性断言污染掉（9/30 事故的同型教训：说明文字提到的名字会被读成结论）。
  return blockObj;
}

/** 量比方向 → 人话（说明文字用；'' = 未知，⛔ 绝不写成「平」） */
function _dirWord(dir) {
  if (dir === VR_DIR_UP) return '比上一交易日【增强】';
  if (dir === VR_DIR_DOWN) return '比上一交易日【下降】';
  if (dir === VR_DIR_FLAT) return '与上一交易日【基本持平】';
  return '【方向未知】';
}

/**
 * 【③ 持有标记（2026-09-27 用户口径；2026-10-03 文案统一为【持有】）】
 *   上一交易日在【买点】里、今天又在买点里 ⇒ 强势股 ⇒ 标记【持有】。
 *   §10：前一天的数据没算出来（null）→ 不标记（绝不当成「昨天没选中」）。
 *
 * ⚠️ [TWO-MODES 2026-10-02] 第 3 参 ruleNo 是【分模式】的：两套模式的规则编号体系不同
 *    （量比模式 ③ / 一字模式 ⑪），⛔ 本函数不许写死 RULE_NO.HOLD 那一份 ——
 *    否则一字模式的说明文字会显示「【规则③】持有」，与它自己的规则清单（⑪）对不上。
 *    不传 → 用量比模式的编号（本模块内的调用点都不传）。
 *
 * 🔴 [SHARE-PRIORITY 2026-10-04 用户口径 · 楚天龙 9/3] 有一类票【不算】强势股：
 *    占比不达标 + 昨天真买过（= 先卖后买档）⇒ 本函数【不标】它的【持有】，
 *    也【不写】「可持有」那句块级说明（改成写明「为什么这里没有持有」）。
 *    ⛔ 否则会自相矛盾：行尾写着【尾盘买（先卖后买）】、卖点写着【竞价卖】，
 *       块级说明却说这一只是「强势股，可持有」—— 用户看板最忌讳的两句话打架。
 *    判据复用 _isLateSwapPick（与 _decorateShareAction 同一份，§6 不分裂）。
 *
 * @param {object} blockObj 买点块
 * @param {Set<string>|null} prevBuyNames 上一交易日【买点方案】里的股票名集合
 * @param {string} [ruleNo] 规则编号（一字模式传 legacy 的 RULE_NO.HOLD）
 * @param {{prevBoughtNames?:Set<string>|null, prevDragonNames?:Set<string>|null}} [opts]
 *        判「先卖后买档」需要（§10：任一为 null 时【不判】该档，照常标持有）
 */
function _markHold(blockObj, prevBuyNames, ruleNo, opts) {
  if (!blockObj || !prevBuyNames || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const o = opts || {};
  const no = ruleNo || RULE_NO.HOLD;
  const hits = [];
  const swapped = [];
  blockObj.picks.forEach(function(p) {
    if (!prevBuyNames.has(p.name)) return;
    if (_isLateSwapPick(p, o)) {
      // 让路给【尾盘买（先卖后买）】：⛔ 不标 holdTag（否则会被读成「拿着别动」）
      p.holdTag = '';
      swapped.push(p.name);
      return;
    }
    p.holdTag = HOLD_TAG;
    hits.push(p.name);
  });
  blockObj.notes = blockObj.notes || [];
  if (hits.length > 0) {
    blockObj.notes.push(_note(no,
      '【' + hits.join('、') + '】上一个交易日也在买点里 → 强势股，可【' + HOLD_TAG + '】'));
  }
  if (swapped.length > 0) {
    blockObj.notes.push(_note(no,
      '【' + swapped.join('、') + '】上一个交易日也在买点里，但今天【竞价占比不达标】⇒ 不算强势股，' +
      '本行【不标】' + HOLD_TAG + '，改标【' + BUY_LATE_SWAP_TAG + '】（原因见该行行内说明）'));
  }
  return blockObj;
}

/**
 * [SHARE-PRIORITY 2026-10-04 用户口径] 【先卖后买档】的【唯一判据】（§6 只此一份）：
 *   ① 该股今天的【竞价占比不达标】（按前排 / 后排门槛判，走 auction-share 的唯一实现）；
 *   ② 该股【昨天真被打过「买」标签】（prevBoughtNames）⇒ 它必然同时出现在【卖点】里。
 * 两条都命中 ⇒ 买点标【尾盘买（先卖后买）】、卖点标【竞价卖】、两边都不标持有类标签。
 *
 * ⛔ _decorateShareAction（动作标签）与 _markHold（③ 持有标记）都必须调它 ——
 *   否则会出现「行内写先卖后买、块级说明写可持有」的自相矛盾。
 * §10：占比缺数据 / 昨日标签没读到 ⇒ 一律 false（不判这一档，走各自的原口径）。
 *
 * @param {object} p pick（读 aucShare / dragonRank）
 * @param {{prevBoughtNames?:Set<string>|null, prevDragonNames?:Set<string>|null}} o
 * @returns {boolean}
 */
function _isLateSwapPick(p, o) {
  if (!p || !o) return false;
  const share = _num(p.aucShare);
  if (share === null) return false;
  if (!o.prevBoughtNames || !o.prevBoughtNames.has(p.name)) return false;
  const isPrevDragon = o.prevDragonNames ? o.prevDragonNames.has(p.name) : null;
  const scope = resolveDragonScope(p.dragonRank, isPrevDragon);
  return !passesAuctionShare(share, scope.isFront);
}

/**
 * 【④ 昨天已买 · 股票级效果（2026-09-30 用户口径，同日两次修正）】
 *   该【股票】在上一交易日被打过「买」标签 ⇒ 用户手上已经有仓位
 *   ⇒ 仓位文案由「重仓 / 轻仓」改写【持有】。
 *
 * ⛔ 只按【股票名】逐个判，绝不按题材判 —— 见 PREV_BOUGHT_TAG 上方的事故记录：
 *    按题材判会把「题材里有一只买过」误读成「这一整块都买过」（9/30 大亚圣象 vs 新华文轩）。
 * ⛔ 卖点侧【不标也不改仓位】：卖点候选本身就是「昨天打过买标签的股票」，标了等于全标。
 * §10：集合为 null（昨天的标签没读到）→ 一律不标、仓位也【不改】（未知 ≠ 昨天没买）。
 *
 * ⚠️ 仓位改写对【重仓 / 轻仓】一视同仁（2026-09-30 用户明确选择）：
 *    「重仓 / 轻仓」是【建多少仓】的口径；既然昨天已经买了，今天这一笔的动作就是【持有】，
 *    再写「重仓」会让人以为还要重新建仓。所以一律换文案，⛔ 不是并列追加。
 *    ⇒ 因此这个函数必须在所有会改仓位的收口之后调用（见 _finishBuyBlock 的顺序注释）。
 *
 * ⚠️ [TOPIC-PREV-BOUGHT 2026-09-30 第三版] 行内【昨天已买】徽标已经从【股票行】撤掉，
 *    改到【题材行】显示（文案改为【昨有买入】，见 _markTopicPrevBought）。
 *    这里保留 p.prevBoughtTag 只作为【持有仓位的判据留痕】（说明文字 / 回归测试要用），
 *    ⛔ 组件里【不再渲染】它 —— 想让用户看见个股级信息，看行尾的【持有】即可。
 *
 * 🔴 [HOLD-UNIFY 2026-10-03 用户口径] ③ 的标记（HOLD_TAG）与这里改出来的行尾仓位
 *    （POSITION_HOLD）现在都是【持有】这个同一枚词 ⇒ 同一行会渲染成「持有 持有」。
 *    本函数在把行尾仓位改成【持有】之后，顺手把 ③ 那枚标记清掉（信息不丢：③ 的说明文字仍在）。
 *    ⛔ 只在【行尾仓位确实改成持有】的这只股票上清，绝不整块清 ——
 *       昨天没买过的票照样保留 ③ 的【持有】标记。
 *
 * @param {object} blockObj 买点块（_finishBuyBlock 的收口对象）
 * @param {Set<string>|null} prevBoughtNames 上一交易日打过「买」标签的股票名集合
 * @param {string} [ruleNo] 规则编号 —— [TWO-MODES 2026-10-02] 分模式（量比 ④ / 一字 ⑫），
 *        理由同 _markHold：⛔ 不许写死本模块的 RULE_NO，否则一字模式的说明文字编号对不上。
 */
function _markPrevBought(blockObj, prevBoughtNames, ruleNo) {
  if (!blockObj || !prevBoughtNames || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const hits = [];
  blockObj.picks.forEach(function(p) {
    if (prevBoughtNames.has(p.name)) {
      p.prevBoughtTag = PREV_BOUGHT_TAG;      // 留痕（⛔ 不渲染）；持有仓位的判据
      p.position = POSITION_HOLD;
      p.holdTag = '';                         // [HOLD-UNIFY] 去重：行尾已是【持有】，不再重复渲染 ③
      hits.push(p.name);
    }
  });
  if (hits.length > 0) {
    blockObj.notes = blockObj.notes || [];
    blockObj.notes.push(_note(ruleNo || RULE_NO.PREV_BOUGHT,
      '【' + hits.join('、') + '】' + PREV_BOUGHT_TAG + '（被打过「买」标签）→ 行尾仓位改标【' +
      POSITION_HOLD + '】（昨天已有仓位，今天继续持有、不重新建仓）'));
  }
  return blockObj;
}

/**
 * 【④ 题材级 · 昨有买入（TOPIC-PREV-BOUGHT 2026-09-30 用户口径）】
 *   「这个题材昨天有票被打过「买」标签」⇒ 题材在延续 ⇒ 题材行（竞价一字右边）标【昨有买入】。
 *
 * ⚠️ 与 _markPrevBought 的区别（两个标记【并存】，语义不同，别合并）：
 *     · 本条 = 【题材级】聚合：题材里【只要有】一只昨天买过就标 —— 说的是题材延续；
 *     · _markPrevBought = 【股票级】：逐只判，落成行尾的【加仓】。
 *
 * ⚠️ 判据用【今日的题材归属】：传进来的 prevBoughtTopics 是「昨天买过的股票 → 今日落在哪个题材」
 *    的集合（由 decision-collect 用今日题材映射算出，§6 与看板显示的题材同一份）。
 * §10：集合为 null（昨天的标签没读到）→ 一律不标（未知 ≠ 昨天这个题材没人买）。
 *
 * @param {object} blockObj 买点块
 * @param {Set<string>|null} prevBoughtTopics 含「昨天有票买过」的题材名集合（今日题材口径）
 */
function _markTopicPrevBought(blockObj, prevBoughtTopics) {
  if (!blockObj || !blockObj.block || !prevBoughtTopics) return blockObj;
  const t = String(blockObj.block.topic || '').trim();
  if (!t || !prevBoughtTopics.has(t)) return blockObj;
  blockObj.prevBoughtTag = TOPIC_PREV_BOUGHT_TAG;
  return blockObj;
}

/**
 * 【⑤ 题材入选次数（TOPIC-STREAK 2026-09-30 用户口径）】
 *   题材行（竞价一字右边）标【一次入选 / 二次入选 / …】=「含今日在内的最近 5 个交易日」
 *   里该题材进过买点几次（用户口径：这样就知道频率）。
 *
 * 口径（[STREAK-ALL-BLOCKS 2026-09-30 用户口径修正] —— ⛔ 别再改回「只数重仓/轻仓」）：
 *   · 数【全部买点块】—— 计数范围必须与【展示范围】一致。
 *     🔴 旧版「只数重仓/轻仓」在「当天买点全落在兜底方案里」的日子会让整块看板没有次数（9/30 实测）。
 *     2026-10-01 起兜底方案已整体删除，买点只剩 第 1 / 第 2 名题材 两个块，范围天然一致。
 *   · 本块就是【今天的】那一次 ⇒ 次数 = 过去窗口内的次数 + 1（必然是 ≥ 1）；
 *   · 与【昨有买入】并存、互不冲突。
 * §10：pastCounts 为 null（窗口内有历史日算不出来）→ 一律【不标】，
 *       ⛔ 绝不拿「偏低但看起来正常」的数字冒充（那会让用户误判题材频率）。
 *
 * @param {object} blockObj 买点块
 * @param {Map<string,number>|null} pastCounts 题材名 → 过去（不含今日）窗口内入选次数
 */
function _markTopicStreak(blockObj, pastCounts) {
  if (!blockObj || !blockObj.block || !pastCounts) return blockObj;
  const t = String(blockObj.block.topic || '').trim();
  if (!t) return blockObj;
  const n = (Number(pastCounts.get(t)) || 0) + 1;   // +1 = 本块（今天）这一次
  const text = topicStreakText(n);
  if (text) blockObj.streakTag = text;
  return blockObj;
}

/**
 * 【④ 仓位配色档】逐只把 position 映射成 tone，供模板直接拼接类名（§21 模板零计算）。
 * ⛔ 必须排在 _markPrevBought 之后 —— 它会改写 position 文案，先派生会拿到旧的「轻仓」档。
 */
function _decoratePositionTone(blockObj) {
  if (!blockObj || !blockObj.picks) return blockObj;
  blockObj.picks.forEach(function(p) { p.positionTone = positionToneOf(p.position); });
  return blockObj;
}

/**
 * 买点块的统一收口（⛔ 顺序固定，互不干扰）：
 *   持有标记 ③ → 昨天已买 ④（会改 position）→ 题材行标记（昨有买入 ④ / 入选次数 ⑤）
 *   → 仓位配色档（必须在其后）→ 竞价涨幅徽标（必须最后）。
 *
 * ⚠️ [QUANT-PICK 2026-10-01] 旧版这里还会按顺序走「亏钱效应 ⑦ → 弱势题材 ⑧ → 只数限制 ⑩」，
 *    这三条已整体删除（用户口径「不分弱势题材，量化了」），所以收口现在只剩标记类动作，
 *    ⛔ 收口【不再改 picks、不再砍票】—— 选票结果 = _buildTopicBuyBlock 的产出，一步到位。
 */
function _finishBuyBlock(blockObj, opts) {
  // ⚠️ 第 4 参把 opts 透传进去：③ 要判「先卖后买档」——
  //   那一档【不算】强势股，既不标【持有】、也不写「可持有」的块级说明（2026-10-04 用户口径）。
  _markHold(blockObj, opts ? opts.prevBuyNames : null, undefined, opts);
  _markPrevBought(blockObj, opts ? opts.prevBoughtNames : null);
  // ⚠️ 题材行标记与上面的个股标记互不干扰（一个写 blockObj.*，一个写 pick.*），先后无所谓
  _markTopicPrevBought(blockObj, opts ? opts.prevBoughtTopics : null);
  _markTopicStreak(blockObj, opts ? opts.topicStreakPast : null);
  _decoratePositionTone(blockObj);
  // ⛔ 徽标必须【最后】派生：上面的改仓会重建 picks 里的 position 文案，先派生会被丢掉
  _decorateAucBadge(blockObj);
  // [SHARE-RULE 2026-10-03] 买卖【时机】标签（竞价买 / 尾盘买）必须排在 _decorateAucBadge【之后】——
  //   它要读徽标那一步从 members 反查出来的 aucShare / volRatioDir / aucPct（§10 退路要用方向与涨幅）。
  _decorateShareAction(blockObj, opts);
  return blockObj;
}

/** 买点块里已经选出的票数（⛔ 没有块 / 没有 picks 都算 0，绝不抛错） */
function _picksLen(b) {
  return (b && Array.isArray(b.picks)) ? b.picks.length : 0;
}

/**
 * 【买点唯一入口】生成买点计划。
 *
 * ⭐ [QUANT-PICK 2026-10-01 用户口径 · 重新改造] + [MIN-3-PICKS 2026-10-02 用户口径 · 补完]
 *
 * 完整流程：
 *   ⓪ 题材排名 = 早盘竞价「题材 toggle」的组序（rankDecisionTopics 复用 sortByTopicGroups，
 *      口径 = 该题材【平均竞价量比】降序）；⛔ 早盘竞价看板的排序与 UI 本身【不动】。
 *   ① 【合格题材】= 数量 ≥ PICK_TIER_MIN_COUNT(4) 的题材。数量 ≤3 只的题材
 *      【不进入决策范围，且不占名次】—— 后面的题材【递补】上来（见下方 9/30 实例）。
 *   ② 取合格题材的【第 1】【第 2】个 → heavy / light，各自按【题材股票数量】分档
 *      （resolvePickTier：≥10 → 3 只 / 7~9 → 2 只 / 4~6 → 1 只 / ≤3 → 不出票）；
 *   ③ 档内按【竞价量比】降序取票（pickByVolRatio）—— 前 N 只重仓、其余轻仓；竞价一字跳过。
 *   ④ 【双主线】若第 1 名题材已经选出 ≥ DAILY_MIN_PICKS(3) 只 ⇒ 第 2 名【降级为候选题材】
 *      （用户原话「因为已经在排名第一的题材已经选够三只了，剩下那些都是候选题材。
 *        这种也相当于双主线。只选最强的，也就是题材平均竞价量比最大的」）。
 *   ⑤ 【保底 3 只】主线票数不足 DAILY_MIN_PICKS ⇒ 按题材排名【继续往下推】候选题材（第 3、4… 名），
 *      候选题材取票 = 主线档位【降一档】（candidatePickCount）且【全部轻仓】，
 *      取到累计 ≥ DAILY_MIN_PICKS 只、或候选题材用尽为止。
 *
 * ⛔ 没有兜底方案、没有题材替换、没有一字门槛、没有风控砍票：给不出来就是「不出票」，
 *    如实写在 notQualifiedText 里（§10）。
 *
 * ── 9/30 实例（用户逐字给出，是本函数的验收基准，⛔ 改之前先拿它对一遍）──────────────
 *   农业（量比 71.22 / 2 只）排第 1 但数量不达标 ⇒ **排除**，后面的题材递补：
 *     新能源汽车（32.55 / 4 只）→ 第 1；AI应用（28 / 8 只）→ 第 2；房地产（23.62 / 9 只）→ 第 3。
 *   ① 新能源汽车 4 只 ⇒ 小档取 1 只：襄阳轴承（量比 69.36）**重仓**
 *   ② AI应用 8 只 ⇒ 中档取 2 只：新华传媒（158.66）是竞价一字买不到 ⇒ **实际只取新华文轩（19.66）重仓**
 *   ③ 主线共 2 只 < 3 ⇒ 往下推：房地产作**候选题材**，中档降一档 ⇒ 只取 1 只：深物业A（79.13）**轻仓**
 *      （深华发A 59.08 量比更低，被排除在外）
 *   合计 3 只。
 *
 * ⚠️ 返回值里的 noYizi / smallTopic / bigTopic 【恒为 null】——
 *    这是与 UI 的【结构契约】：DecisionBoard.vue 用 `buySpecial = noYizi || smallTopic || bigTopic`
 *    合并渲染兜底面板（useDecisionBoard.js）。三个兜底规则已删除，面板自然永不出现，
 *    ⛔ 但键必须留着，否则 composable / 模板要跟着改（用户口径「布局不变」）。
 *
 * @param {Array} blocks rankDecisionTopics 的返回（已按平均竞价量比降序）
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{prevBuyNames?:Set<string>|null, prevBoughtNames?:Set<string>|null,
 *          prevBoughtTopics?:Set<string>|null, topicStreakPast?:Map<string,number>|null}} [opts]
 *        ⓘ 纯标记用的数据（都不影响选票结论）。语义与 §10 口径见各 _mark* 函数：
 *        prevBuyNames      = 【上一个交易日】买点里的股票名集合；null = 未知 → 一律不标持有
 *        prevBoughtNames   = 【上一交易日】打过「买」标签的股票名集合（股票级 → 行尾【加仓】）
 *        prevBoughtTopics  = 【题材级】判据：昨天买过的票【今日】落在哪些题材里 → 题材行【昨有买入】
 *        topicStreakPast   = 题材名 → 过去（不含今日）窗口内进入买点的次数 → 题材行【N 次入选】
 * @returns {{heavy:object|null, light:object|null, candidates:Array,
 *            noYizi:null, smallTopic:null, bigTopic:null}}
 *          heavy = 合格题材第 1 名的买点块；light = 合格题材第 2 名的买点块
 *            （ⓘ 第 1 名已够 3 只时第 2 名降级为候选题材，此时它【同时】在 candidates 里）；
 *          candidates = 候选题材块数组（第 3 名及以后的补位块 + 被降级的第 2 名块）；
 *          qualified=false 表示「该题材不出票（数量 ≤ 3 / 没有可买的票）」—— 仍然展示题材与数字
 *          （§10 如实呈现），但 ⛔ 不给买入建议（picks 为空）。
 */
export function buildBuyPlan(blocks, dragonMap, opts) {
  const list = blocks || [];
  const o = opts || {};

  // ① 合格题材：数量 ≥ 4 只。⛔ 数量不达标的题材【直接跳过、不占名次】⇒ 后面的题材递补。
  const qualified = [];
  list.forEach(function(b) {
    if ((Number(b && b.count) || 0) >= PICK_TIER_MIN_COUNT) qualified.push(b);
  });

  const q1 = qualified[0] || null;
  const q2 = qualified[1] || null;

  let heavy = null;
  let light = null;
  const candidates = [];

  if (q1) {
    heavy = _finishBuyBlock(
      _buildTopicBuyBlock(q1, dragonMap, _rankWord(1), RULE_NO.FIRST, { pickRank: 1 }), o);
    _appendLowOpenDragonOneNote(heavy);
  }

  if (q2) {
    // ④ 双主线：第 1 名已选出 ≥ 3 只 ⇒ 第 2 名降级为候选题材（只选最强的那个题材为重仓主线）
    const asCandidate = _picksLen(heavy) >= DAILY_MIN_PICKS;
    light = _finishBuyBlock(
      _buildTopicBuyBlock(q2, dragonMap, _rankWord(2),
        asCandidate ? RULE_NO.CANDIDATE : RULE_NO.SECOND,
        { candidate: asCandidate, pickRank: 2 }), o);
    _appendLowOpenDragonOneNote(light);
    if (asCandidate) candidates.push(light);
  }

  // ⑤ 保底 3 只：主线不够 ⇒ 按题材排名继续往下推候选题材，直到选够 DAILY_MIN_PICKS 只
  let total = _picksLen(heavy) + _picksLen(light);
  for (let i = 2; i < qualified.length && total < DAILY_MIN_PICKS; i++) {
    const b = qualified[i];
    const candMax = candidatePickCount(resolvePickTier(b.count));
    // ⛔ 取「降一档」与「还差几只」的小者：降一档是候选题材的待遇，还差几只是补位的目的，
    //    两者取小才不会「一个候选题材就把 3 只全占了」（用户要的是往下推、逐个题材补）。
    const need = Math.min(candMax, DAILY_MIN_PICKS - total);
    const cb = _finishBuyBlock(
      _buildTopicBuyBlock(b, dragonMap, _rankWord(i + 1), RULE_NO.CANDIDATE,
        { candidate: true, pickMax: need, pickRank: i + 1 }), o);
    _appendLowOpenDragonOneNote(cb);
    // §10：这个候选一只可买的票都没有（全是一字）⇒ 不算数，继续看下一个题材
    if (cb.picks.length > 0) {
      candidates.push(cb);
      total += cb.picks.length;
    }
  }

  return {
    // ⛔ 没有合格题材时必须返回 null：UI 用 v-if="buyHeavy" 判空，
    //    返回空壳对象会让模板去读 block.block.topic 直接崩（当日题材全都不够 4 只时会走到这里）
    heavy: heavy,
    light: light,
    // [MIN-3-PICKS 2026-10-02] 候选题材块（补位用，一律降一档 + 轻仓，题材行标【候选题材】）
    candidates: candidates,
    // ⚠️ 兜底面板的结构契约（见函数头注释）：三个键必须保留，且新规下恒为 null
    noYizi: null,
    smallTopic: null,
    bigTopic: null
  };
}

function _yiziWord(n) {
  return n > 0 ? ('有' + n + '个竞价一字涨停') : '无竞价一字涨停';
}

// [MIN-3-PICKS 2026-10-02] 中文序数：1~10 写「第一 / 第二 / 第三…」，再往后退回「第 N 名」
const _CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function _rankWord(rank) {
  const n = Number(rank);
  if (!n || n < 1) return '';
  if (n <= 10) return '第' + _CN_NUM[n];
  return '第' + n + '名';
}

/**
 * 卖出时点决策（唯一实现；后期改规则只改这里）。
 *
 * [2026-09-24 用户口径 · 第 2 名题材的例外]
 *   题材【排名第 2】且该题材【只有 1 个竞价一字】⇒ 题材强度打折，只有【龙一】能拿到尾盘：
 *       龙一  → 14:50 卖；
 *       其余非龙一（含今日未排上龙头的）→ 11:20 卖。
 *   ⚠️ 只适用于「第 2 名 + 恰好 1 个一字」这一个组合；其它组合仍走下面的通用规则。
 *
 * @param {number|null} topicRank 今日题材排名（null = 今日未成组）
 * @param {{yiziCount?:number|null, isDragonOne?:boolean}} [opts]
 *        isDragonOne = 该股是不是【今日】这个题材里的龙一（dragonRank === 1）
 * @returns {string} 卖出时点
 */
function _decideSellTime(topicRank, opts) {
  const o = opts || {};
  if (topicRank === 2 && o.yiziCount === SECOND_TOPIC_SINGLE_YIZI) {
    return o.isDragonOne ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
  }
  return (topicRank === 1 || topicRank === 2) ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
}

/**
 * 卖点提示（唯一实现）—— 按【今日竞价涨幅】细分卖出节奏（[SELL-OPEN 2026-09-29] 用户口径），
 * 并叠加【今日 vs 上交易日竞价量比方向】（[VR-ACTION 2026-10-02] 用户口径，见上方常量块注释）。
 *
 * ⛔ 与 _decideSellTime（题材排名口径）【并存、不互相覆盖】：
 *    命中档位 → 行尾改用这里的 timeLabel，并用 text 说明节奏；
 *    未命中（≥ +SELL_MILD_HIGH / 恰好平开 / 缺竞价涨幅）→ 返回 null，行尾回落 11:20 / 14:50。
 *
 * 判定顺序（⛔ 顺序即优先级，别调）：
 *   ① 竞价涨幅缺失 → null（§10）
 *   ② 弱票（低开 + 量比下降，isWeakAucDay）→ 开盘立刻出（⛔ 覆盖下面的深低开 / 冲高就卖档）
 *   ③ 深低开（≤ SELL_DEEP_LOW）＋ 竞价量比【暴增】（≥ VR_SURGE_TIMES 倍）→ 冲高就卖（[SELL-SURGE 2026-10-03]）
 *   ④ 深低开（≤ SELL_DEEP_LOW）→ 盯盘 · 10:00 前
 *   ⑤ 小低开（SELL_DEEP_LOW ~ 0）→ 开盘立刻出
 *   ⑥ 小幅高开（0 ~ +SELL_MILD_HIGH）：
 *        量比【没走弱】（平 / 增强）→ 尾盘卖（看好）；否则（下降 / 未知）→ 看分时定
 *   ⑦ 其余 → null
 *
 * @param {number|null} aucPct 今日竞价涨幅（%）；null / 非数 = 缺数据（§10 不猜方向）
 * @param {'up'|'flat'|'down'|''} [volRatioDir] 今日 vs 上交易日竞价量比方向（缺省 = 未知）
 * @param {number|null} [volRatioTimes] 今日 ÷ 上交易日竞价量比【倍数】（缺省 = 未知 ⇒ 冲高就卖档不生效）
 * @returns {{tone:string, badge:string, timeLabel:string, text:string}|null}
 */
function _decideSellHint(aucPct, volRatioDir, volRatioTimes) {
  const n = _num(aucPct);
  if (n === null) return null;                    // §10：缺数据 ⇒ 不产出提示，回落原规则
  const dir = String(volRatioDir || '');
  // ② 弱票：低开 + 量比下降 ⇒ 两个指标同步走弱，一开盘就出（⛔ 覆盖下面的深低开 / 冲高就卖档）
  if (isWeakAucDay(n, dir)) {
    return {
      tone: SELL_TONE_DANGER,
      badge: '❗危',
      timeLabel: '开盘立刻出',
      text: '竞价低开（' + formatAucPct(n) + '）＋ 竞价量比比上一交易日【下降】→ 两个指标同步走弱，' +
        '开盘【立刻出】，不等反弹、不抱侥幸，别犹豫！'
    };
  }
  // ③ 深低开 + 竞价量比【暴增】（≥ VR_SURGE_TIMES 倍）→ 冲高就卖（[SELL-SURGE 2026-10-03 用户口径]）
  //    深低开却还有巨量在抢 ⇒ 不是「没人要」，是有人在低位接 ⇒ 冲高的概率非常高
  //    ⇒ 别按普通深低开那样急着 10:00 前割，【耐心等冲高】，冲高那一刻再出（行尾标【冲高就卖】）。
  //    §10：倍数未知（null）⇒ 本档【不生效】（不猜「放大了」），完整回落下面的深低开档。
  if (n <= SELL_DEEP_LOW && isVolRatioSurge(volRatioTimes)) {
    return {
      tone: SELL_TONE_SURGE,
      badge: '冲',
      timeLabel: SELL_SURGE_LABEL,
      text: '竞价深低开（' + formatAucPct(n) + '）＋ 竞价量比放大到上一交易日的 ' +
        Number(volRatioTimes).toFixed(2) + ' 倍（≥ ' + VR_SURGE_TIMES + ' 倍）→ 低位抢筹明显，' +
        '耐心等待冲高，【冲高就卖】，冲高的概率非常高。'
    };
  }
  if (n <= SELL_DEEP_LOW) {
    // ④ 深低开：别在竞价割，先盯盘 —— 卖点跟着时间走（10:00 前定夺）
    return {
      tone: SELL_TONE_WATCH,
      badge: '盯',
      timeLabel: '盯盘 · 10:00 前',
      text: '竞价深低开（≤ ' + SELL_DEEP_LOW + '%）：先盯盘别急着砸 —— 10:00 前看有没有反弹，' +
        '冲高就出；反弹不起来，10:00 也出。'
    };
  }
  if (n < 0) {
    // ⑤ 小低开：最弱的一档 —— 开盘就是最好的价，直接出
    return {
      tone: SELL_TONE_DANGER,
      badge: '❗危',
      timeLabel: '开盘立刻出',
      text: '竞价小幅低开（' + SELL_DEEP_LOW + '% ~ 0）：开盘【立刻出】，不等反弹、不抱侥幸，别犹豫！'
    };
  }
  if (n > 0 && n < SELL_MILD_HIGH) {
    // ⑥ 小幅高开：量比还没走弱（平 / 增强）⇒ 看好，直接拿到尾盘；
    //   量比同步下降 / 未知 ⇒ 保持原样「看分时」（用户口径「按原来的不变」）。
    if (dir === VR_DIR_FLAT || dir === VR_DIR_UP) {
      return {
        tone: SELL_TONE_HOLD,
        badge: '稳',
        timeLabel: '尾盘卖 · ' + SELL_TIME_CLOSE,
        text: '竞价小幅高开（0 ~ +' + SELL_MILD_HIGH + '%）＋ 竞价量比与上一交易日基本持平（未走弱）→ ' +
          '看好，不必盘中盯分时，直接拿到 ' + SELL_TIME_CLOSE + '【尾盘卖】。'
      };
    }
    // 小幅高开：看分时定 —— 向上拿住，走弱撒手
    return {
      tone: SELL_TONE_PLAN,
      badge: '观',
      timeLabel: '看分时定',
      text: '竞价小幅高开（0 ~ +' + SELL_MILD_HIGH + '%）：10:00 前看分时整体曲线 —— ' +
        '向上就拿到 ' + SELL_TIME_MIDDAY + ' 卖；走弱向下立刻卖。' +
        (dir === VR_DIR_DOWN ? '（本股竞价量比已比上一交易日下降，偏走弱，别恋战。）' : '')
    };
  }
  return null;                                    // ≥ 3% / 平开 ⇒ 回落原题材排名规则
}

/**
 * 生成卖点计划。
 * @param {Array<{name:string, topic:string, pct:number|null, inTodayList:boolean,
 *                aucPct:number|null, volRatioDir:'up'|'flat'|'down'|''}>} rows
 *        候选 = 昨日打过「买」标签的股票（topic 用【今日】的题材；不在今日列表时 topic 为空）
 *        · aucPct   = 今日竞价涨幅（卖点细分提示的第一依据）
 *        · volRatioDir = 今日 vs 上交易日竞价量比方向（[VR-ACTION 2026-10-02] 第二依据，
 *          '' = 缺一天数据 / 未知 ⇒ 两条叠加规则都不生效，回落原档位，§10 不猜方向）
 *        · volRatioTimes = 今日 ÷ 上交易日竞价量比【倍数】（[SELL-SURGE 2026-10-03] 第三依据，
 *          null = 缺一天数据 / 除不出来 ⇒ 「冲高就卖」档不生效，回落原档位，§10 不猜倍数）
 * @param {Array} blocks rankDecisionTopics 的返回（用于查今日题材排名 / 数量 / 一字）
 * @param {Map} dragonMap 今日龙头排名（用于显示「龙几」）
 * @param {Set<string>|Map<string,any>|null} prevDragonNames 昨日龙头名册里的股票名（昨日龙一）；
 *        【null = 名册尚未加载】→ 「昨日是不是龙头」是未知（§10），理由里如实写「未加载」，
 *        ⛔ 绝不退化成「非龙头」—— 那会把「还没拉到」伪装成「已经判定过」。
 *        （卖出【时点】只看今日题材排名，不受此项影响，所以名册未加载照样给时点建议。）
 * @param {Set<string>|null} [todayBuyNames] 【今日】买点列表里的股票名（buildBuyPlan 的结果）。
 *        null / 不传 = 今日买点没算出来（§10：未知 ≠ 今天没选中）→ 一律【不标持有】。
 *        ⓘ 能进卖点候选的股票【上交易日】必然在买点里（卖点候选 = 昨日打过「买」标签），
 *          所以「今天又出现在买点里」= 连续两天被选中 = 强势股 → 行尾标【持有】，不卖。
 * @returns {Array<{topic:string, topicRank:number|null, count:number|null, yiziCount:number|null,
 *                  ...}>} 按题材分组，组内按龙头排名升序
 */
export function buildSellPlan(rows, blocks, dragonMap, prevDragonNames, todayBuyNames) {
  if (!rows || rows.length === 0) return [];
  const rankMap = _topicRankMap(blocks || []);
  const infoMap = new Map();
  (blocks || []).forEach(function(b) { infoMap.set(b.topic, b); });
  const dragon = dragonMap || new Map();
  // §10：名册没加载 ⇒ 「昨日是否龙头」未知（null），不是 false
  const prevUnknown = !prevDragonNames;
  const prevSet = prevUnknown
    ? new Set()
    : (prevDragonNames instanceof Set ? prevDragonNames : new Set(Object.keys(prevDragonNames)));

  const groups = new Map();

  // ══ [FOLLOW-DRAGON 2026-10-05 用户口径 · 同题材龙一限制] 第 1 遍：找出「龙一已经倒下的题材」══
  //   「如果同个题材前排倒下，后排是避免不了下跌的……相当于将军倒下了，士兵不会幸免。」
  //   判据 = 该题材【今日龙一】占比有数据且不达标 ⇒ 它已判【竞价卖】。
  //   §10：龙一占比缺数据 / 龙一占比达标 / 该题材今天没有龙一 ⇒ 都不算「倒下」。
  //   ⛔ 只在【本函数内部】先用一遍 rows，不额外取数、不改 Data 层（§6 单一数据源）。
  const fallenDragon = new Map();   // 题材 tp → { name, share }（那只倒下的今日龙一）
  rows.forEach(function(r) {
    const tp = String(r.topic || '').trim();
    if (!tp || fallenDragon.has(tp)) return;          // 未成组 ⇒ 无「同题材龙一」可言
    const d = dragon.get(r.name);
    if (!d || Number(d.rank) !== 1) return;           // 只看【今日龙一】
    const share = _num(r.aucShare);
    if (share === null) return;                       // §10：龙一占比没抓到 ⇒ 不猜它倒没倒
    const isPrevDragon = prevUnknown ? null : prevSet.has(r.name);
    const scope = resolveDragonScope(1, isPrevDragon);
    if (passesAuctionShare(share, scope.isFront)) return;  // 龙一占比达标 ⇒ 没倒，后排各判各的
    fallenDragon.set(tp, { name: r.name, share: share });
  });

  rows.forEach(function(r) {
    const tp = String(r.topic || '').trim();
    const key = tp || '（今日未成组）';
    if (!groups.has(key)) groups.set(key, []);
    const rank = rankMap.has(tp) ? rankMap.get(tp) : null;
    const info = infoMap.get(tp);
    const d = dragon.get(r.name);
    const isPrevDragon = prevUnknown ? null : prevSet.has(r.name);
    const dragonRank = d ? d.rank : null;
    // 时点是【逐行】算的：第 2 名 + 只有 1 个一字时，龙一与非龙一时点不同，同一组里会同时出现两种
    const sellAt = _decideSellTime(rank, {
      yiziCount: info ? info.yiziCount : null,
      isDragonOne: dragonRank === 1
    });
    // 今日竞价涨幅（%）：卖点【细分提示】的唯一依据（[SELL-OPEN 2026-09-29]）；null = 缺数据
    const aucPct = _num(r.aucPct);
    // [VR-ACTION 2026-10-02] 今日 vs 上交易日竞价量比方向（口径唯一实现在 vol-ratio-trend，§6）。
    //   ⛔ 原样透传 decision-collect 在 sellRows 上挂好的值，本函数不重新计算、也不读 state。
    const volRatioDir = String(r.volRatioDir || '');
    // [SELL-SURGE 2026-10-03 用户口径] 竞价量比【倍数】（今日 ÷ 上交易日）—— 卖点「冲高就卖」档的依据。
    //   ⛔ 与 volRatioDir 是两个口径（方向 vs 倍数），别互相替代；null = 未知 ⇒ 该档不生效（§10 不猜）。
    const volRatioTimes = (r.volRatioTimes === undefined || r.volRatioTimes === null) ? null : _num(r.volRatioTimes);
    const todayInBuy = !!(todayBuyNames && todayBuyNames.has(r.name));
    // ══ [SHARE-RULE 2026-10-03 用户口径] 卖点动作以【竞价占比】为准（与买点同一份判据、同一套门槛）══
    //   占比达标 + 今天又进买点 → 【持有】；占比达标 → 【尾盘卖】（当天还有走强趋势，不必开盘慌着走）；
    //   占比不达标 → 【竞价卖】（开盘就走）—— 即使今天又进买点也是【竞价卖】，⛔ 不给【持有】。
    //   用户给的卖点案例（本段必须逐条对上）：
    //     金健米业 3.9%(昨日龙一, 容错) → 尾盘卖 ｜ 登海种业 2.6%(龙九) → 尾盘卖
    //     捷荣技术 9.4%(昨日龙一) → 尾盘卖 ｜ 浙江世宝 2.6%(今日无题材=后排) → 尾盘卖
    //     华阳国际 1.8%(龙三, 后排) → 竞价卖 ｜ 花溪科技 9/2 3.6%(今日又进买点, 达标) → 持有
    //     楚天龙 9/3 2.5%(不达标 + 今日又进买点) → 竞价卖（买点那边配【尾盘买（先卖后买）】）
    //   §10：占比缺数据 ⇒ 整段【回落旧口径】（持有 / 先卖后买 / 竞价高低开细分），并如实写进 actionNote。
    const share = _num(r.aucShare);
    const scope = resolveDragonScope(dragonRank, isPrevDragon);
    const isFront = scope.isFront;
    // ⛔ 达标判定走 auction-share 的唯一实现（§6）—— 别在这里自己写 `share >= 门槛`，
    //    否则门槛口径会分裂成两处（第 4 步换门槛时必漏一处）。
    const sharePass = (share === null) ? null : passesAuctionShare(share, isFront);

    let holdTag = '';
    let buyActionTag = '';
    let buyActionTone = '';
    let sellActionTag = '';
    let sellActionTone = '';
    let actionNote = '';
    // [FOLLOW-DRAGON 2026-10-05] 本行的卖点动作是不是「被同题材龙一带下去的」（不是自己走弱）
    let aucFollowDragon = false;

    if (share !== null) {
      // 🔴 [FOLLOW-DRAGON 2026-10-05 用户口径 · 9/9 国芳集团 + 安记食品] 【优先规则】同题材龙一限制：
      //   本条【优先】于下面的规则⑦（占比判定），规则⑦【让路】。
      //   同题材的今日龙一已判【竞价卖】（占比不达标）⇒ 该题材其余所有票一律【跟龙竞价卖】，
      //   ⛔ 不再看它自己的占比，也⛔ 不因为「今天又进买点」而给【持有】——
      //     前排都倒了，后排是同类、避免不了跟跌（将军倒下，士兵难幸免）。
      //   ⛔ 那只龙一自己不受这条约束（fallenDragon.name 是本行 ⇒ 走下面的规则⑦）。
      const fd = fallenDragon.get(tp);
      if (fd && fd.name !== r.name) {
        aucFollowDragon = true;
        sellActionTag = SELL_FOLLOW_DRAGON_TAG;
        sellActionTone = SELL_ACTION_TONE_FOLLOW;
        actionNote = _note(RULE_NO.SHARE,
          '同题材【今日龙一 ' + fd.name + '】竞价占比 ' + formatAuctionShare(fd.share) +
          '（前排门槛 ' + _thresholdText(true) + '）不达标 ⇒ 已判【' + SELL_OUT_TAG + '】。' +
          '同题材前排倒下，后排是同类、避免不了跟着跌（将军倒下，士兵难幸免）⇒ ' +
          '本股虽自身占比 ' + formatAuctionShare(share) + '（' + _scopeText(scope, isFront) +
          '门槛 ' + _thresholdText(isFront) + '）' + (sharePass ? '达标' : '不达标') +
          '，但不再单独给【' + (sharePass ? SELL_LATE_TAG : SELL_OUT_TAG) + '】，改标【' +
          SELL_FOLLOW_DRAGON_TAG + '】（本优先规则【优先】于规则' + RULE_NO.SHARE +
          '，规则' + RULE_NO.SHARE + '让路）。');
      } else if (todayInBuy && sharePass) {
        // ── 规则⑦（占比说了算，旧口径整体让路）────────────────────────────────────
        // 🔴 [SHARE-PRIORITY 2026-10-04 用户口径 · 楚天龙 9/3] 【持有】只在占比【达标】时才给：
        //   占比达标 + 今天又进买点 ⇒ 它是强势股，今天是要买 / 加，不是卖 ⇒ 【持有】；
        //   占比【不达标】+ 今天又进买点 ⇒ 它今天【走弱了】，不能当成强势股拿住 ⇒ 【竞价卖】
        //     （用户原话：「占比2.5不达标。所以应该是竞价卖……卖点方面，提示持有标签……
        //       应该去掉持有。应该是这个标签，'竞价卖'」）。
        //   ⛔ 之前是「只要今天又进买点就标持有」，会把「走弱要卖」错判成「拿着别动」——
        //     买点那一行同步给【尾盘买（先卖后买）】，两句合起来才是完整的「先卖后买」。
        // ⚠️ [FOLLOW-DRAGON 2026-10-05] 上面那条【优先规则】命中时，本节三条【都不走】。
        // 强势股：今天是要买 / 加，不是卖（用户案例：花溪科技 9/2 占比 3.6% 达标）
        sellActionTag = HOLD_TAG;
        sellActionTone = 'hold';
        actionNote = _note(RULE_NO.SHARE,
          '竞价占比 ' + formatAuctionShare(share) + '（' + _scopeText(scope, isFront) + '门槛 ' +
          _thresholdText(isFront) + '）⇒ 占比达标，且本股【今天又进了买点】→ 今天是要买 / 加，' +
          '不是卖 → 【' + HOLD_TAG + '】（而不是先卖后买）。辅助验证：竞价涨幅 ' +
          formatAucPct(aucPct) + '、竞价量比' + _dirWord(volRatioDir) + '。');
      } else {
        sellActionTag = sharePass ? SELL_LATE_TAG : SELL_OUT_TAG;
        sellActionTone = sharePass ? SELL_ACTION_TONE_LATE : SELL_ACTION_TONE_OUT;
        actionNote = _note(RULE_NO.SHARE,
          '竞价占比 ' + formatAuctionShare(share) + '（' + _scopeText(scope, isFront) + '门槛 ' +
          _thresholdText(isFront) + '）⇒ 占比' + (sharePass ? '达标' : '不达标') + '，' +
          (sharePass
            ? '【' + SELL_LATE_TAG + '】：说明还没走弱、当天还有走强趋势，不必开盘慌着走，拿到尾盘'
            : '【' + SELL_OUT_TAG + '】：占比不到门槛，开盘就走，别恋战' +
              (todayInBuy
                ? '；它今天同时也在【买点】里，但占比不达标 = 今天走弱了，' +
                  '⛔ 不按「强势股」标【' + HOLD_TAG + '】—— 买点那边给的是【' + BUY_LATE_SWAP_TAG +
                  '】，两句合起来就是先卖后买'
                : '')) +
          '。辅助验证：竞价涨幅 ' + formatAucPct(aucPct) + '、竞价量比' + _dirWord(volRatioDir) +
          '（辅助，不单独决定时机）。');
      }
    } else {
      // ── §10 退路：占比缺数据 ⇒ 完全回落旧口径（持有 / 先卖后买 / 竞价高低开细分）──
      // 【③ 持有】上交易日就在买点里（= 进得了卖点候选）+ 今天又在买点里 → 强势股
      // 🔴 [VR-ACTION 2026-10-02 用户口径] 但若今天已经是【弱票】（低开 + 量比下降）⇒ 就【不是】强势股了，
      //   改用【先卖后买】：开盘先把昨天的仓卖掉（立刻出），尾盘量比稳住了再买回来。
      const firstSellThenBuy = todayInBuy && isWeakAucDay(aucPct, volRatioDir);
      holdTag = (todayInBuy && !firstSellThenBuy) ? HOLD_TAG : '';
      buyActionTag = firstSellThenBuy ? SELL_FIRST_BUY_LATER_TAG : '';
      buyActionTone = firstSellThenBuy ? BUY_ACTION_TONE_SWAP : '';
      actionNote = _note(RULE_NO.SHARE,
        '⚠️ 竞价占比【缺数据】（缺当日竞价量 / 缺昨日成交量）⇒ 本行【回落旧口径】' +
        '（持有 / 先卖后买 / 竞价高低开细分）。⛔ 这不是「占比很低」，是没抓到数据（§10），' +
        '不代表本股就走弱了。');
    }

    groups.get(key).push({
      name: r.name,
      topic: tp,
      topicRank: rank,
      isPrevDragon: isPrevDragon,
      dragonLabel: dragonRank ? getDragonLabel(dragonRank) : '',
      dragonRank: dragonRank,
      pct: _num(r.pct),
      aucPct: aucPct,
      // [AUC-BADGE 2026-09-29 用户口径] 行内「竞价涨幅」标签：文本 + 配色档都由 Logic 层给（§21 模板零计算）。
      //   文本 = formatAucPct（与早盘竞价同一函数，2 位小数、正数补 '+'）；
      //   配色档复用连板天梯的 getAucOpenKind（high 红 / low 绿 / flat 灰），⛔ 不另写一套阈值（§6）；
      //   null（缺竞价涨幅）→ tone = '' ⇒ 组件【不渲染】徽标（§10：不能把「没查到」画成「平开灰」）。
      aucPctText: formatAucPct(aucPct),
      aucTone: getAucOpenKind(aucPct) || '',
      // [SHARE-RULE 2026-10-03] 竞价占比（%）：卖点的主判据。文案 / 配色档 / 门槛说明全在 Logic 层算好
      //   （§21 模板零计算），缺值 ⇒ 空串 ⇒ 徽标整个不渲染（§10 绝不显示 0.0%）。
      aucShare: share,
      aucShareText: formatAuctionShare(share),
      aucShareTone: auctionShareZoneOf(share),
      aucShareScopeText: _scopeText(scope, isFront),
      aucShareThresholdText: _thresholdText(isFront),
      aucSharePass: sharePass,
      inTodayList: !!r.inTodayList,
      holdTag: holdTag,
      // [SHARE-RULE 2026-10-03 用户口径] 卖点【动作】：持有 / 尾盘卖 / 竞价卖。
      //   ⛔ 占比缺数据时为空串 ⇒ 组件回落下面的 buyActionTag（先卖后买）/ sellHint / sellAt 旧口径。
      //   🔴 [FOLLOW-DRAGON 2026-10-05 用户口径] 新增第四档【跟龙竞价卖】：
      //     同题材今日龙一已判【竞价卖】⇒ 本行跟卖（本档【优先】于规则⑦）。见 aucFollowDragon。
      sellActionTag: sellActionTag,
      sellActionTone: sellActionTone,
      // [FOLLOW-DRAGON 2026-10-05] 本行是不是「跟龙竞价卖」（被同题材龙一带下去，不是自己走弱）。
      //   组件暂时只用于区分说明（视觉差异已由 sellActionTone = 'follow' 表达），留着给后续排查用。
      aucFollowDragon: aucFollowDragon,
      // [VR-ACTION 2026-10-02 用户口径] 【先卖后买】徽标（与 holdTag 互斥）：
      //   今天又是弱票、又在买点里 ⇒ 开盘先卖，尾盘再买回来。文案 + 配色档都由 Logic 层给，模板零判断（§21）。
      //   ⚠️ [SHARE-RULE 2026-10-03] 只在【占比缺数据】的退路里出现 —— 占比有数据时以占比结论为准。
      buyActionTag: buyActionTag,
      buyActionTone: buyActionTone,
      sellAt: sellAt,
      // [SHARE-RULE 2026-10-03] 该行「为什么这么买卖」的说明文字（用户口径「买点卖点说明文字要添加」）。
      actionNote: actionNote,
      // 今天要卖的【节奏提示】：深低开 → 盯盘 10:00 前定夺；小低开（或低开+量比下降）→ 开盘立刻出（危）；
      // 小幅高开 → 量比没走弱就拿尾盘，否则看分时（向上 11:20 / 走弱立刻）。
      // ⛔ 标了【持有】的行不提示卖点（它本来就不按上面的时点卖）；
      //   ⚠️ 但【先卖后买】的行【要】提示 —— 它的动作就是「先卖」，卖点提示正是它需要的那条。
      //   未命中各档 → null（行尾回落 sellAt）。
      // 🔴 [SHARE-RULE 2026-10-03 用户口径] 【占比有数据】时一律置 null —— 用户口径「以新规则为准，
      //   以前的买点卖点如果遇到冲突可以让路」：占比已经给出明确的「尾盘卖 / 竞价卖」，
      //   再叠一条「开盘立刻出 / 看分时」只会自相矛盾。旧的竞价高低开细分【只在占比缺数据时】生效。
      sellHint: share !== null ? null : (holdTag ? null : _decideSellHint(aucPct, volRatioDir, volRatioTimes))
    });
  });

  const out = [];
  groups.forEach(function(items, key) {
    const head = items[0];
    const info = infoMap.get(head.topic);
    const count = info ? info.count : null;
    const yizi = info ? info.yiziCount : null;
    const rankWord = _rankWord(head.topicRank);
    const yiziText = (yizi === null) ? '题材今日未成组' : _yiziWord(yizi);
    const countText = (count === null) ? '股票数量未知' : ('股票数量' + count + '只');

    const prevText = (head.isPrevDragon === null)
      ? '昨日龙头名册未加载'
      : (head.isPrevDragon ? '昨日是龙头（十日涨幅最高）' : '昨日非龙头');
    const prevTextElse = (head.isPrevDragon === null)
      ? '昨日龙头名册未加载'
      : (head.isPrevDragon ? '但昨日是龙头（十日涨幅最高）' : '昨日非龙头');

    let reason;
    if (head.topicRank === 2 && yizi === SECOND_TOPIC_SINGLE_YIZI) {
      // [2026-09-24] 第 2 名题材【只有 1 个竞价一字】→ 组内时点会分裂，理由必须把两种都说清
      reason = '题材排在第一，第二，题材排第二，' + countText + '，该题材只有' + yizi + '个竞价一字涨停，' +
        prevText + '，龙一' + SELL_TIME_CLOSE + '卖，其余非龙一' + SELL_TIME_MIDDAY + '卖';
    } else if (head.topicRank === 1 || head.topicRank === 2) {
      reason = '题材排在第一，第二，题材排' + rankWord + '，' + countText + '，该题材' + yiziText +
        '，' + prevText +
        '，' + SELL_TIME_CLOSE + '卖';
    } else {
      reason = '题材排不在第一，第二' + (rankWord ? ('，排' + rankWord) : '') + '，' + countText +
        '，该题材' + yiziText + '，' + prevTextElse +
        '，' + SELL_TIME_MIDDAY + '卖';
    }

    items.sort(function(a, b) {
      const ra = (a.dragonRank === null ? Number.MAX_SAFE_INTEGER : a.dragonRank);
      const rb = (b.dragonRank === null ? Number.MAX_SAFE_INTEGER : b.dragonRank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    items.forEach(function(it, i) { it.seq = i + 1; });

    out.push({
      topic: head.topic || '',
      groupKey: key,
      topicRank: head.topicRank,
      count: count,
      yiziCount: yizi,
      reason: reason,
      items: items
    });
  });

  // 题材间按「今日题材排名」升序（未成组的排最后），保证卖点顺序与买点口径一致
  out.sort(function(a, b) {
    const ra = (a.topicRank === null ? Number.MAX_SAFE_INTEGER : a.topicRank);
    const rb = (b.topicRank === null ? Number.MAX_SAFE_INTEGER : b.topicRank);
    if (ra !== rb) return ra - rb;
    return a.groupKey < b.groupKey ? -1 : 1;
  });
  return out;
}

/**
 * 规则说明文案（灰色小问号里显示的那些行）。
 * ⛔ 刻意放在 Logic 层：规则文案与规则实现必须同处一处，改规则时不会只改代码不改说明（§6）。
 *    后期要加规则 —— 加完实现就在下面加一行说明，UI 一行都不用动。
 * @returns {string[]}
 */
export function buildVolRatioRulesLines() {
  return _volRatioBuyRulesLines().concat(sellRulesLines());
}

/**
 * 【量比模式 · 买点段】规则文案。
 * ⛔ 与 legacy 模式的买点段【互不共用】（两套规则本来就不同），但【卖点段】必须共用
 *    —— 见 sellRulesLines 的注释（§6 单一真相：卖点只有一套规则）。
 */
function _volRatioBuyRulesLines() {
  return [
    '【买点】只看题材排名前二的题材（题材排名 = 早盘竞价「题材 toggle」的组序，见第 0 步）：',
    '　第 0 步【题材怎么排名】= 按题材的【平均竞价量比】降序（2026-10-01 新规，取代原来的「一字数量排序」）：',
    '　　平均竞价量比高的题材排在前面 —— 这样能分出排在第一和第二的题材（用户口径）。',
    '　　量比取自 market_metrics 的 auc_vol_ratio = 早盘竞价看板展开面板那行「竞价量比」，',
    '　　　以及题材统计条上的「平均竞价量比」，是同一个值。',
    '　　平均竞价量比 = 该题材里所有拿到量比的行（含灰行）的量比之和 ÷ 拿到量比的行数；',
    '　　　一行都拿不到量比的题材置底（§10 不把「没查到」当成「量比很小」）。',
    '　第 1 步【选题材】在按【平均竞价量比】排好的题材里，先【剔除数量不达标（1 ~ ' +
      (PICK_TIER_MIN_COUNT - 1) + ' 只）的题材】：',
    '　　它们不进入决策范围，而且⛔【不占名次】—— 后面的题材【递补】上来（不是「第 1 名空缺、全天空仓」）。',
    '　　实例（9/30）：农业量比 71.22 排第 1 但只有 2 只 ⇒ 排除 ⇒',
    '　　　新能源汽车（32.55 / 4 只）递补成第 1、AI应用（28 / 8 只）第 2、房地产（23.62 / 9 只）第 3。',
    '　　然后取递补后的【第 1】与【第 2】两个题材，各自按下面同一套规则选票。',
    '　第 2 步【选票的唯一依据 = 竞价量比】一律按【竞价量比】降序取票，量比越大 = 明天持续性越高（用户口径）。',
    '　　例：龙一 5.6 / 龙二 8.9 / 龙三 20.5 / 龙四 5.4 / 龙五 7.9',
    '　　　⇒ 量比降序 = 龙三 20.5 ＞ 龙二 8.9 ＞ 龙五 7.9 ＞ 龙一 5.6 ＞ 龙四 5.4 ⇒ 谁量大谁靠前。',
    '　　⚠️【不保底龙一】：谁量比小谁排在后面，龙一也一样 ——【先不分龙一 / 龙二了】，只看量比。',
    '　　⚠️【竞价一字买不进】→ 它【照常按量比占名次】，但【不买入、也不让后面的票递补】' +
      '（2026-10-02 口径）：',
    '　　　　即「取前 N 只」= 取量比排名前 N 名；这 N 名里有一字 ⇒ 就【少买一只】，⛔ 不补第 N+1 名。',
    '　　　　实例（9/30 AI应用 8 只 · 中档取 2 只）：量比第 1 名新华传媒 158.66 是一字 ⇒ 买不进；',
    '　　　　　第 2 名新华文轩 19.66 非一字 ⇒ 【只买入这一只】，且是重仓（重仓名额发给实际买入的票）。',
    '　　　　仓位同理：重仓名额按【实际买入的票】从前往后发，一字不占仓位名额。',
    '　　⚠️【例外 · 本档一只可买的都没有】→ 名次被一字【全部吃光】时，往下补位（2026-10-02 口径）：',
    '　　　　小档（4 ~ 6 只）本档只取 1 只 ⇒ 若这唯一的名次就是那只竞价一字 ⇒ 原先整块题材会',
    '　　　　「一只都买不到」（9/29 AI应用 / 新能源汽车就是这种形态）⇒ 现在改为继续往下找',
    '　　　　【量比最高的可买的票】把本档填满（最多补回本档应取的只数）。',
    '　　　　实例（9/29 AI应用）：量比第 1 名新华传媒是一字、第 2 名新华文轩可买 ⇒ 选出新华文轩。',
    '　　　　⛔ 只要名次里【还有一只可买的】，就照旧【不补位】（上面 9/30 那笔账保持不变）。',
    '　　⚠️【创业板 / 科创板 / 北交所】（20% / 30% 涨跌幅板）→【照选】，不因为板块而被顺延。',
    '　　⚠️ 缺竞价量比的票【不参与】量比大小的比较（§10 绝不当 0），一律排在有量比的票后面；',
    '　　　　整个题材都没有量比 ⇒ 退回【按龙头名次取前几只】，并在说明文字里写明为什么。',
    '　第 3 步【看题材股票数量定买几只】—— 数量 = 该题材在早盘竞价里的股票只数（= 题材行「数量：n」）：',
    '　① 排名第 1 的题材：',
    '　　　· ' + PICK_TIER_BIG_MIN + ' 只及以上 → 取【' + PICK_COUNT_BIG + ' 只】：竞价量比前 ' + PICK_HEAVY_BIG +
      ' 只【' + POSITION_HEAVY + '】、第 ' + PICK_COUNT_BIG + ' 只【' + POSITION_LIGHT + '】；',
    '　　　· ' + PICK_TIER_MID_MIN + ' ~ ' + (PICK_TIER_BIG_MIN - 1) + ' 只 → 取【' + PICK_COUNT_MID +
      ' 只】：竞价量比第 1 只【' + POSITION_HEAVY + '】、第 ' + PICK_COUNT_MID + ' 只【' + POSITION_LIGHT + '】；',
    '　　　· ' + PICK_TIER_MIN_COUNT + ' ~ ' + (PICK_TIER_MID_MIN - 1) + ' 只 → 取【' + PICK_COUNT_MIN +
      ' 只】：竞价量比最高那只【' + POSITION_HEAVY + '】；',
    '　　　· 1 ~ ' + (PICK_TIER_MIN_COUNT - 1) + ' 只 → 【不进入决策范围】：该题材在第 1 步就被剔除，不占名次。',
    '　② 排名第 2 的题材 → 与 ①【完全同一套】分档规则（同一个题材只出现一次，不会重复入选）；',
    '　　　⚠️ 例外：若第 1 名题材【已经选出 ' + DAILY_MIN_PICKS + ' 只】⇒ 第 2 名【降级为候选题材】（见 ⑥）。',
    '　第 4 步【保底 ' + DAILY_MIN_PICKS + ' 只】一天至少要选出【' + DAILY_MIN_PICKS + ' 只】票：',
    '　　第 1、2 名加起来不够 ⇒ 按题材排名【往下推】候选题材（第 3、4… 名），直到选够 ' +
      DAILY_MIN_PICKS + ' 只为止；',
    '　　候选题材也凑不出来（剩下的题材都是竞价一字 / 数量不达标）⇒ 如实少给，⛔ 不硬凑（§10）。',
    '　⑥ 【' + CANDIDATE_TAG + '】题材行标【' + CANDIDATE_TAG + '】，它是用来【补位 / 陪跑】的题材：',
    '　　　· 取票 = 主线档位【降一档】：大档 3 只 → 取 2 只、中档 2 只 → 取 1 只、小档 1 只 → 取 1 只；',
    '　　　· 仓位一律【' + POSITION_LIGHT + '】（⛔ 候选题材不出现重仓）；',
    '　　　· 只取该题材里【竞价量比最高】的那几只（竞价一字占名次但不买入、不递补，见第 2 步）；',
    '　　　· 触发它的两种情况：',
    '　　　　① 主线票数不足 ' + DAILY_MIN_PICKS + ' 只 ⇒ 往下推补位（9/30 的房地产正是这样进来的）；',
    '　　　　② 第 1 名题材已够 ' + DAILY_MIN_PICKS + ' 只 ⇒ 第 2 名降级（= 双主线：只选最强的那个题材）。',
    '　⛔ 已作废的旧规则（2026-10-01 起不再影响选票，代码已删除）：竞价一字门槛（原 ①②③）、',
    '　　题材替换、连板天梯兜底（原 ⑤）、小题材兜底（原 ⑥）、亏钱效应（原 ⑦）、弱势题材（原 ⑧）、',
    '　　双主线竞争（原 ⑨）、买入只数限制（原 ⑩）、龙一特例（低开 + 量比 > 60）、卡位补偿。',
    '　　要看旧的实现 ⇒ `git revert` 本次提交即可原样恢复。',
    '　【龙一 / 龙二】= 题材内【十日涨幅】从高到低，与早盘竞价龙一徽章同一口径；',
    '　　现在【只用于行内「龙几」标签】与「竞价量比并列时的稳定次序」，⛔ 不再是选票依据。',
    '　【灰行（灰色名称 / 灰色题材 = 不在当日正式列表）】照常参与量比均值与选票，也能被选中买点 ——',
    '　　它们代表的是【老龙 / 观察组继承票】，有参考价值',
    '　　（9/8 大消费龙一国芳集团、农业龙一万向德农都是灰行）；只是【不计入】题材数量 / 一字数',
    '　　（与早盘竞价统计条同口径）。灰行来源与早盘竞价的注入行完全同源：竞昨高光继承 + 昨日买标签',
    '　　继承 + 昨日龙头名册继承壳。',
    '　【「昨日卖标签继承」的行（灰色实心卖标签）】同样照常参与量比均值与选票 —— 9/8 大消费龙一国芳集团',
    '　　就是「灰名 + 灰题材 + 灰色实心卖标签」，它照样照样能被选中。',
    '　【低开龙一的提醒】被选中的票若正好是龙一、且竞价低开时，请自行看它的竞价图形：',
    '　　若出现【跌停 L 形】→ 尾盘买（本看板没有分时数据、不做图形判断，只给这段文字提醒）。',
    '　③ 【' + HOLD_TAG + '】上一交易日出现在【买点】里、今天又在买点里 → 强势股，行尾标【' +
      HOLD_TAG + '】（昨天的买点没算出来时【不标】，§10 不猜）。',
    '　　（若这一只同时命中 ④ —— 你昨天真的打过「买」标签 —— 行尾只写一次【' + HOLD_TAG +
      '】，不重复渲染。）',
    '　④ 【' + TOPIC_PREV_BOUGHT_TAG + '】= 【题材级】：题材行（竞价一字右边）出现它就表示',
    '　　【这个题材昨天有票被打过「买」标签】⇒ 题材在延续。',
    '　　⚠️ ⛔ 它【不是】「这一整块里的股票昨天都买过」——同一个题材里昨天没买过的票不会因此被标',
    '　　　（2026-09-30 事故：上一版用「' + PREV_BOUGHT_TAG + '」这个说法放在题材行，用户读成了',
    '　　　 个股结论「大亚圣象昨天已买」= 错的，所以题材级的说法改成【' + TOPIC_PREV_BOUGHT_TAG + '】）。',
    '　　⚠️ 逐只【股票级】的判断走行尾仓位：这一只昨天真的被打过「买」标签（' + PREV_BOUGHT_TAG + '）',
    '　　⇒ 仓位由「' + POSITION_HEAVY + ' / ' + POSITION_LIGHT + '」改标【' + POSITION_HOLD +
      '】（昨天已有仓位，今天继续持有、不重新建仓）。',
    '　　⚠️ 与 ③ 的区别：③ 看的是【上一个交易日的买点方案】里有没有它（系统选出来的），',
    '　　　④ 看的是【你昨天实际有没有打「买」标签】；两个是两回事，可以同时出现。',
    '　⑤ 【入选次数】题材行（竞价一字右边）标【一次入选 / 二次入选 / 三次入选…】=',
    '　　这个题材在【含今日在内的最近 ' + TOPIC_STREAK_WINDOW + ' 个交易日】里进过买点几次。',
    '　　次数越大 = 这个题材被反复选中、频率越高，越值得跟；与 ④ 的【' + TOPIC_PREV_BOUGHT_TAG +
      '】并存、互不冲突。',
    '　　（同一个题材一天最多算一次。）',
    '　　窗口里只要有一天算不出来（那天的行情还没加载）⇒ 次数就是未知，一律【不标】',
    '　　（§10 绝不拿偏低的数字冒充，那会让你误判题材频率）。',
    '　重仓与轻仓混在同一个题材块里，序号连续（按竞价量比从高到低），仓位写在每行行尾。',
    '　※ 每个题材块下面的「选择理由」与说明文字都会标【规则N】（如【规则②】），方便按条文逐条核对。',
    '【题材行的数据】题材名右边依次是：实心红圆点（里面的数字 = 题材排名）｜数量：n（股票只数）｜',
    '　　竞价一字：n｜【' + TOPIC_PREV_BOUGHT_TAG + '】（有才显示）｜【N 次入选】（有才显示）。',
    '【股票行的数据】股票名右边依次是：龙几（龙一 / 龙二）｜十日涨幅｜竞价涨幅小标签｜竞价量比；',
    '　　【竞价量比】小标签会显示与【上一交易日】相比的方向（两个值各自四舍五入到整数后作差）：',
    '　　　增强（差 ≥ +1）→ 整块【红底】带 ↑；下降（差 ≤ -1）→ 整块【绿底】带 ↓；基本平（差 = 0）或数据不全 → 靛蓝底不带箭头。',
    '　　行尾是仓位：' + POSITION_HEAVY + ' / ' + POSITION_LIGHT + ' = 今天新买建多少仓，' + POSITION_HOLD +
      ' = 昨天已买过、今天继续持有；',
    '　　　（③ 的【' + HOLD_TAG + '】标记与行尾仓位【' + POSITION_HOLD + '】是同一枚词，同一行只写一次。）',
    '────────────────────────────────────────',
    '════════ ' + ruleTag(RULE_NO.SHARE) + ' 【什么时候买 · 以竞价占比为准】' + ' ════════',
    '　【竞价占比】是本看板买入 / 卖出的【主判据】（2026-10-03 用户口径，新规优先，旧口径让路）：',
    '　　占比（%）= 【当日竞价量】÷【昨日成交量】×100，保留 1 位小数（如 0.0435 → 4.4%）。',
    '　　⚠️ 与早盘竞价第一页显示的那个占比【同一个公式、同一份数据】，但那一页是【四舍五入取整】显示；',
    '　　　本看板刻意更精确（保留 1 位小数），两处精度不同是【故意的】，⛔ 不要去对齐它们。',
    '　【两个标准值】（行内「占比 x.x%」标签就是它）：',
    '　　· 前排（今日或昨日【龙一 / 龙二】）→ 标准 ' + AUCTION_SHARE_FRONT_STD + '%，可容错 ' +
      AUCTION_SHARE_TOLERANCE + '% ⇒ 实际门槛 ' + AUCTION_SHARE_FRONT_MIN + '%；',
    '　　· 后排（其余，含今日没有题材归属的票）→ 标准 ' + AUCTION_SHARE_BACK_STD + '%。',
    '　　标签配色 = 这个数值本身有多强：≥ ' + AUCTION_SHARE_FRONT_STD + '% 红底 ｜ ≥ ' +
      AUCTION_SHARE_BACK_STD + '% 琥珀底 ｜ 其余绿底。',
    '　【动作】占比 ≥ 门槛 → 行内标【' + BUY_NOW_TAG + '】：占比够强，竞价就得下手，等尾盘反而更贵 / 买不到；',
    '　　　　　　占比 < 门槛 → 行内标【' + BUY_LATE_TAG + '】：别追开盘，等尾盘再看。',
    '　【例外 · 先卖后买】（2026-10-04 用户口径）：占比 < 门槛【且】这一只【昨天已经买过】（所以它同时也在卖点里）',
    '　　　⇒ 本行只留一枚【' + BUY_LATE_SWAP_TAG + '】，⛔ 行尾【不再写仓位「' + HOLD_TAG + '」】：',
    '　　　开盘先按卖点的【' + SELL_OUT_TAG + '】把昨天的仓卖掉，尾盘再接回来（两句合起来 = 先卖后买）。',
    '　　　⚠️ 留着【' + HOLD_TAG + '】会被读成「拿着别动」，与今天的【' + SELL_OUT_TAG + '】自相矛盾。',
    '　　　（占比【达标】时不受本例外影响，照常【' + BUY_NOW_TAG + '】+【' + HOLD_TAG + '】。）',
    '　【为什么用占比当主判据】竞价涨幅与竞价量比只是【辅助】：',
    '　　两个都涨的时候如果是「假强」，当天一路下跌，即使明天涨也得失相当；',
    '　　但配上占比就能确认（占比是实打实的水量），三者同向时确定性最高。',
    '　【例子（用户给的验收案例，逐条可对）】',
    '　　· 金健米业（昨日 / 今日龙一）涨幅 +0.17%、量比增强、占比 4.4% ≥ 3.5% → 【' + BUY_NOW_TAG + '】；',
    '　　· 楚天龙（昨日 / 今日龙一）涨幅 +0.1%、量比增强、占比 5.5% ≥ 3.5% → 【' + BUY_NOW_TAG +
      '】（三个指标全正向，确定性最高）；',
    '　　· 海登种业（龙七 = 后排）涨幅 +2.68%、量比持平、占比 0.2%（原始 0.15%）< 2% → 【' +
      BUY_LATE_TAG + '】；',
    '　　· 捷荣技术（龙一）涨幅 +8.07%、量比【下降】、占比 7.0% ≥ 3.5% → 【' + BUY_NOW_TAG +
      '】（量比下降不重要，占比说了算）；',
    '　　· 龙版传媒（龙六 = 后排）涨幅 +1.46%、量比下降、占比 6.9% ≥ 2% → 【' + BUY_NOW_TAG +
      '】（后排占比这么强，就该竞价买）；',
    '　　· 花溪科技（昨日龙一）涨幅 -5.02%、量比下降、占比 3.6% ≥ 3.5% → 【' + BUY_NOW_TAG + '】',
    '　　　（3.6% 不到前排标准 4%，但昨日龙一可用 0.5% 容错 ⇒ 门槛降到 3.5%）。',
    '　　· 楚天龙 9/3（昨有买入，同时进买点 + 卖点）涨幅 -3.36%、量比下降、占比 2.5% < 3.5%',
    '　　　⇒ 【' + BUY_LATE_SWAP_TAG + '】（只剩这一枚，不再标【' + HOLD_TAG + '】）。',
    '　【§10 缺失】占比算不出来（缺当日竞价量 / 缺昨日成交量）→ 本节【回落旧的量比方向口径】',
    '　　（量比增强 → 竞价买；下降 → 已持仓标【' + SELL_FIRST_BUY_LATER_TAG + '】、未持仓标【' +
      BUY_LATE_TAG + '】；平 / 未知 → 不给动作标签），',
    '　　并在行下方【如实写明「占比缺数据」】——⛔ 这不是「占比很低」，是没抓到数据。'
  ];
}

/**
 * 【卖点段】规则文案 —— ★两套买点模式【共用同一份】★（§6 单一真相）。
 *
 * 为什么单独抽出来：卖点在两种模式下【完全一样】（[TWO-MODES 2026-10-02] 用户口径
 *   「其它看板不变 / 只是逻辑要跟随 toggle 变化，相当于两种方式」—— 分叉的只有买点）。
 *   如果让 legacy 模块自己再写一遍这段文字，两边就会各自漂移：
 *   改了卖点档位只改一边 ⇒ 用户点开问号看到的条文与实际行为对不上，照着旧条文提意见。
 *   ⇒ 所以量比模式的 `buildVolRatioRulesLines()` 与 legacy 模式的 `buildRulesLines()`
 *     都必须【concat 本函数】，⛔ 不许各写一份。
 * @returns {string[]}
 */
export function sellRulesLines() {
  return [
    '【卖点】候选 = 昨日打过「买」标签的股票。',
    '────────────────────────────────────────',
    '════════ ' + ruleTag(RULE_NO.SHARE) + ' 【什么时候卖 · 以竞价占比为准】' + ' ════════',
    '　与【买点】用的是【同一个指标、同一套门槛】（2026-10-03 用户口径，新规优先，旧口径让路）：',
    '　　占比（%）= 【当日竞价量】÷【昨日成交量】×100，保留 1 位小数；',
    '　　前排（今日或昨日【龙一 / 龙二】）门槛 ' + AUCTION_SHARE_FRONT_MIN + '%（标准 ' +
      AUCTION_SHARE_FRONT_STD + '% 容错 ' + AUCTION_SHARE_TOLERANCE + '%）；后排门槛 ' +
      AUCTION_SHARE_BACK_STD + '%。',
    '　【动作】（行尾标签，共四种；第四种【' + SELL_FOLLOW_DRAGON_TAG + '】是下面的【优先规则】）：',
    '　　· 占比 ≥ 门槛【且】该股没进今天的买点 → 【' + SELL_LATE_TAG +
      '】：说明还没走弱、当天还有走强趋势，不必开盘慌着走，拿到尾盘；',
    '　　· 占比 ≥ 门槛【且】该股【今天又进了买点】→ 【' + HOLD_TAG + '】：它是强势股，今天是要买 / 加，不是卖；',
    '　　· 占比 < 门槛 → 【' + SELL_OUT_TAG + '】：占比不到门槛，开盘就走，别恋战。',
    '　　　🔴 2026-10-04 用户口径：这一档【不看】它今天有没有进买点 —— 进了也是【' + SELL_OUT_TAG + '】。',
    '　　　　用户原话（楚天龙 9/3）：「占比2.5不达标。所以应该是竞价卖……卖点方面，提示持有标签……应该去掉持有。」',
    '　　　　理由：占比不达标 = 今天走弱了，不能因为「又进买点」就当强势股拿住；',
    '　　　　此时买点那一行给的是【' + BUY_LATE_SWAP_TAG + '】，两边合起来 = 先卖后买。',
    '　🔴 【优先规则 · 同题材龙一限制】（2026-10-05 用户口径）—— ⛔ 本条【优先】于上面三种动作，',
    '　　命中时上面三种【全部让路】（用户原话「只是在原来规则' + RULE_NO.SHARE + '的基础上，加上这条优先规则，规则' +
      RULE_NO.SHARE + '要让路」）：',
    '　　· 同一题材里，只要【今日龙一】的占比不达标（⇒ 它已判【' + SELL_OUT_TAG + '】），',
    '　　　该题材【其余所有票】一律改判【' + SELL_FOLLOW_DRAGON_TAG + '】—— ⛔ 不再看它自己的占比，',
    '　　　⛔ 也不因为「今天又进买点」而给【' + HOLD_TAG + '】。',
    '　　· 理由（用户原话）：「如果同个题材前排倒下，后排是避免不了下跌的。因为他们是同类的。',
    '　　　相当于将军倒下了，士兵不会幸免。」—— 后排跟龙一绑定，好区分、也符合逻辑。',
    '　　· §10【不跟】的三种情形（后排仍按上面三种动作各自判定）：',
    '　　　① 龙一占比【算不出来】⇒ 不知道它倒没倒，不替它下结论；',
    '　　　② 龙一占比【达标】⇒ 它给的是【' + SELL_LATE_TAG + '】（没倒），后排各判各的；',
    '　　　③ 该题材的【龙一不在今天的卖点候选里】⇒ 看不到它的结论，就不跟。',
    '　　· 非同一题材的行【完全不变】（用户原话「如果不是同题材，和原来一样」）。',
    '　【例子（用户给的验收案例，逐条可对）】',
    '　　· 金健米业（昨日龙一）涨幅 +0.08%、量比下降、占比 3.9% → 不到 4% 但昨日龙一可容错 0.5%',
    '　　　⇒ 3.9% ≥ 3.5% → 【' + SELL_LATE_TAG + '】（当天还有走强趋势）；',
    '　　· 登海种业（龙九 = 后排）涨幅 -0.28%、量比增强、占比 2.6% ≥ 2% → 【' + SELL_LATE_TAG + '】；',
    '　　· 捷荣技术（昨日龙一）涨幅 -3.95%、量比下降、占比 9.4% ≥ 3.5% → 【' + SELL_LATE_TAG +
      '】（前两个指标弱没关系，占比完全符合条件就大胆拿）；',
    '　　· 浙江世宝（今日没有题材 = 后排）涨幅 -6.52%、量比增强、占比 2.6% ≥ 2% → 【' + SELL_LATE_TAG + '】；',
    '　　· 华阳国际（龙三，非前排）涨幅 -1.3%、量比下降、占比 1.8% < 2% → 【' + SELL_OUT_TAG + '】；',
    '　　· 花溪科技 9/2（今天又进买点，占比 3.6% 达标）→ 【' + HOLD_TAG + '】；',
    '　　· 楚天龙 9/3（昨有买入、同时进买点，占比 2.5% 不达标）→ 【' + SELL_OUT_TAG +
      '】（⛔ 不标【' + HOLD_TAG + '】）。',
    '　　· 9/9 大消费（优先规则）：国芳集团（龙一）占比不达标 → 【' + SELL_OUT_TAG + '】；',
    '　　　安记食品（龙九）自己的占比本来够【' + SELL_LATE_TAG + '】，但同题材龙一已倒 ⇒ 改判【' +
      SELL_FOLLOW_DRAGON_TAG + '】。',
    '　【§10 缺失】占比算不出来（缺当日竞价量 / 缺昨日成交量）→ 本节【整体回落下面的旧口径】',
    '　　（' + HOLD_TAG + ' / ' + SELL_FIRST_BUY_LATER_TAG + ' / 竞价高低开细分），并在行下方如实写明「占比缺数据」。',
    '　【行下方还有一行说明文字】写清这一只为什么给上面的动作：占比数值、前排 / 后排门槛来源、',
    '　　以及作为辅助的竞价涨幅与量比方向（辅助不单独决定时机）。',
    '────────────────────────────────────────',
    '──────── 以下为【旧口径】，只在【占比缺数据】时生效（占比有数据时新规优先，旧规则让路）────────',
    '　旧口径 = 先看【今天这只票竞价开得怎么样】＋【竞价量比有没有走弱】，再看题材排名：',
    '　每行在「十日涨幅」右侧带一个【竞价涨幅】小标签（如 -2.60%）：涨 = 红底、跌 = 绿底、平 = 灰底；',
    '　　该股今日没有竞价涨幅时不显示这个标签（§10 不把「没查到」画成「平开」）。',
    '　紧跟着是【竞价量比】小标签（如 量比 2.78）；它还会显示与【上一交易日】相比的方向：',
    '　　· 比上一交易日【增强】（两个值各自四舍五入到整数后，今天的更大）→ 标签整块【红底】、右边带 ↑；',
    '　　· 比上一交易日【下降】（四舍五入后今天的更小）→ 标签整块【绿底】、右边带 ↓；',
    '　　· 【基本平】（四舍五入后一样）或 数据不全 → 保持原来的靛蓝底、不带箭头（§10 不猜方向）。',
    '　　（判据 = 两个值各自四舍五入到整数后作差：差 ≥ +1 增强 / = 0 基本平 / ≤ -1 下降，与【买点】段同一口径。）',
    '　【第一层 · 按今日竞价涨幅 + 竞价量比方向细分节奏】（命中就把行尾时点换成下面这句）：',
    '　　· 【弱票】竞价涨幅 < 0 且 竞价量比比上一交易日【下降】→ 开盘【立刻出】，行内打「❗危」警示；',
    '　　　⚠️ 这一条【覆盖】下面的深低开档 —— 低开 + 量比同步下降说明承接也没了，等反弹只会把亏损做大；',
    '　　· ≤ ' + SELL_DEEP_LOW + '%（深低开）＋ 竞价量比【暴增】（今日 ÷ 上一交易日 ≥ ' + VR_SURGE_TIMES +
      ' 倍）→ 【' + SELL_SURGE_LABEL + '】：低位抢筹明显，耐心等冲高，冲高的概率非常高；',
    '　　· ≤ ' + SELL_DEEP_LOW + '%（深低开，且量比【没】下降、也没暴增）→ 【盯盘】：10:00 前看有没有反弹，冲高就出；反弹不起来，10:00 也出；',
    '　　· ' + SELL_DEEP_LOW + '% ~ 0（小低开，且量比【没】下降）→ 开盘【立刻出】，行内打「❗危」警示，不等反弹、别犹豫；',
    '　　· 0 ~ +' + SELL_MILD_HIGH + '%（小幅高开）＋ 竞价量比【基本平 / 增强】→ 看好，不必盯分时，直接拿到 ' +
      SELL_TIME_CLOSE + '【尾盘卖】；',
    '　　· 0 ~ +' + SELL_MILD_HIGH + '%（小幅高开）＋ 竞价量比【下降 / 未知】→ 10:00 前看分时整体曲线：向上就拿到 ' +
      SELL_TIME_MIDDAY + ' 卖，走弱向下立刻卖；',
    '　　· 其余（≥ +' + SELL_MILD_HIGH + '% / 平开 / 缺竞价涨幅）→ 不提示，按下面的题材排名时点（§10 缺数据不猜）。',
    '　【第二层 · 题材排名兜底时点】（第一层没命中时，行尾才显示这个）：',
    '　① 今日题材排第 1 或第 2 → ' + SELL_TIME_CLOSE + ' 卖（拿满一天）；',
    '　② 今日题材排名不在前二（含今日未成组）→ ' + SELL_TIME_MIDDAY + ' 卖（排名靠后，弱了早走）；',
    '　③ 例外：今日题材【排第 2】且该题材【只有 1 个竞价一字】→ 题材强度打折，',
    '　　 【只有龙一】' + SELL_TIME_CLOSE + ' 卖，【其余非龙一】' + SELL_TIME_MIDDAY + ' 卖（同一组里会同时出现两种时点）。',
    '　④ 【' + HOLD_TAG + '】上交易日就在买点里、今天又出现在买点里 → 强势股，行尾标【' + HOLD_TAG + '】，',
    '　　不按上面的时点卖出（继续持有、不重新建仓）。',
    '　　⚠️ 但若今天它已经是【弱票】（竞价涨幅 < 0 且 竞价量比下降）⇒ 就不算强势股了，改标【' +
      SELL_FIRST_BUY_LATER_TAG + '】：',
    '　　　开盘先把昨天的仓卖掉，尾盘量比稳住了再买回来（低开 + 量比下降时只标【' + HOLD_TAG +
      '】太笼统，所以改标【' + SELL_FIRST_BUY_LATER_TAG + '】）。',
    '　　⚠️ 反过来，竞价涨幅 > 0 且 竞价量比【增强】时，【' + HOLD_TAG + '】才是对的（继续拿住）。',
    '　「昨日是龙头（十日涨幅最高）」会写进卖出理由 —— 典型场景：昨日的龙一今天掉出前二 → ' + SELL_TIME_MIDDAY + ' 卖。',
    '说明：统计只数当日正式列表里的股票，「昨日卖标签继承」的复盘行不计入（与早盘竞价同一口径）；',
    '　　　缺竞价涨幅的行不会当成「高开」，会如实说明有几只未纳入。'
  ];
}

/**
 * [COPY-ALL 2026-10-01 用户要求] 规则面板「一键复制」用的纯文本 —— 一行一条，与面板里
 * 逐行显示的内容【完全一致】（面板 v-for 出的是同一个 lines 数组，§6 同一来源）。
 *
 * 为什么把它放在 Logic 层而不是组件里：
 *   ① 「怎么拼」是格式口径，只许定义一次；组件里再写一次 join 就是两处分叉的起点；
 *   ② §21：组件只管渲染与交互，格式化的活儿归 Logic；
 *   ③ 这里是纯函数，node 环境单测直接覆盖（本项目的测试不带 DOM）。
 *
 * ⛔ 绝不让 null / undefined / 空串混进结果：拼接规则一旦放松，复制出来的文本里就会出现
 *    字面量 "undefined"，用户拿去核对规则时反而更懵（§10 宁可少一行，不给假内容）。
 *     注意是【逐项过滤】而不是过滤整行里的空白 —— 规则正文里大量用全角空格（U+3000）做缩进，
 *     那是排版的一部分，必须原样保留。
 *     （注释里刻意不直接敲一个全角空格：会触发 eslint no-irregular-whitespace。）
 */
export function joinRulesLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const parts = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s === '') continue;
    parts.push(s);
  }
  return parts.join('\n');
}

/**
 * 数值 → 展示文本（§21：格式化在 Logic 层做完，模板只负责渲染）。
 * 缺失一律返回 ''（§10 绝不补 0 / '-'）。
 */
export function formatRangePct(pct) {
  const n = _num(pct);
  if (n === null) return '';
  return (n >= 0 ? '+' : '') + String(Math.round(n)) + '%';
}

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 跨模式共享的内部工具（[TWO-MODES 2026-10-02]）★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 下面这些函数【两种买点模式语义完全一致】（市值 / 仓位 / 标记 / 徽标 / 序号 / 龙头名字），
// 旧版文件 2546c82 里它们与本文件的实现【逐字节相同】—— 所以刻意【只保留这一份】，
// 由 decision-rules-legacy.js 原样 import 复用（§6 单一真相）。
//
// ⛔ 为什么必须共享而不是各写一份：
//    · `_markTopicPrevBought` / `_markTopicStreak` / `_decorateAucBadge` 这些是【题材行与股票行
//      的标记口径】—— 9/30 已经因为「计数范围与展示范围不一致」出过一次事故（整块看板不显示
//      入选次数）。两条链路各写一份 ⇒ 必然再犯一次，且只在其中一种模式下暴露，更难查。
//    · 卖点 / 徽标 / 加仓改写是与模式无关的，重复实现只会两边漂移。
//
// ⚠️ 这里的 export 只是为了让 legacy 模块 import；⛔ 业务代码（组件 / composable / collect）
//    不许直接 import 这些下划线开头的函数 —— 它们是实现细节，改签名不会再给你留兼容层。
export {
  _num, _topicRankMap, _note, _toPick, _reseq, _reasonBuy, _rankWord,
  _markHold, _markPrevBought, _markTopicPrevBought, _markTopicStreak,
  _decoratePositionTone, _decorateAucBadge, _appendLowOpenDragonOneNote,
  // [SHARE-RULE 2026-10-03 用户口径] 买卖【时机】（竞价买 / 尾盘买）的收口实现 ——
  //   一字模式（decision-rules-legacy.js）的买点块【共用同一份】，⛔ 不在那边再写一套
  //   （§6 单一真相：两套模式的「什么时候买」必须同一个答案）。
  _decorateShareAction
};
