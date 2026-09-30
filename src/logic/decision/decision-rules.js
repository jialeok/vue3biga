// decision-rules.js — 「决策」看板的核心规则（Logic 层纯函数，§15 独立业务模块 / §21 模板零计算）
//
// 本文件【只有纯函数】：不读 state、不发请求、不碰 DOM、不 import 任何 store。
// 所有输入输出都是普通对象/数组 → 既方便单测，也保证后期加规则时只动这一个文件。
//
// ── 产品口径（2026-09-24 用户原话整理；后期还会继续完善，此处刻意做成可配置的常量）──
//
// 【买点】只看「排名第一 / 第二」两个题材（题材排名 = 早盘竞价「题材 toggle」的组序，同源）：
//   · 第 1 名题材【竞价一字 ≥ 2 个】⇒ 题材最强，按题材内龙头排名（龙一→龙二→…）取
//     【最靠前的两只非一字涨停】的股票（一字涨停买不进，必须跳过），两只都【重仓】；
//   · 第 1 名题材【竞价一字只有 1 个】⇒ 题材强度打折，改打法：
//       重仓【1 只】——按龙头顺序跳过一字取最靠前的那只（正常情况下就是龙一）；
//       轻仓【龙二～龙五】里「非一字 且 竞价涨幅 > 0」的股票（高开才买）。
//       ⚠️ 竞价涨幅缺失的行不算 > 0（§10：缺数据 ≠ 高开），会单独说明「几只缺竞价涨幅未纳入」；
//   · 第 1 名题材【竞价一字 0 个】⇒ 未达门槛，不给买入建议；
//   · 第 2 名题材：取【一只】最强的（同样按龙头顺序跳过一字），建议【轻仓】。
//   · 【无一字兜底（2026-09-25 用户口径）】当日【所有题材】的竞价一字都是 0 个 ⇒ 弱市，
//     改看【连板天梯 · 题材连扳】：取【股票数量最多】的题材（数量并列时并列的都取），
//     只在它的【龙一 / 龙二】里挑，最终只留【竞价高开】的票：
//       龙一低开 + 龙二高开 → 只买龙二；两只都高开 → 两只都买；两只都低开 → 只买龙一。
//     全部记【轻仓】（没有一字，强度打折）。
//     题材连扳里股票最多的题材【不足 NO_YIZI_MIN_TOPIC_COUNT 只】⇒ 【空仓】（太弱，不参与）。
//     ⚠️ 这条只在「全部题材一字 = 0」时生效；只要有任何一个题材有一字，就仍走上面的 ①～④。
//
// 【亏钱效应 / 弱势题材 / 买入只数 / 持有标记（2026-09-27 用户口径）】四条【后置收口】规则，
//   ⛔ 全部只用【9:25 竞价】那一瞬的数据 —— 用户是【早上做决策】的，收盘数据当时还不存在。
//   统一在 _finishBuyBlock 里按固定顺序执行（先砍票 → 再限制只数 → 最后标持有）：
//   ⑦ 亏钱效应：入选题材里只要有【≥ 1 只竞价一字跌停】（9:25 竞价就打在跌停价上；
//      早盘竞价看板上 = 股票名下方那条【绿色实线】）⇒ 【只买龙一】且【只轻仓】
//      （题材 > 10 只 / < 10 只都一样处理）。例：9/11 农业 12 只（中粮科技竞价 -10.00%）。
//      ⛔ 曾短暂加过【收盘跌停】判据，被用户明确否掉：那是收盘才知道的事，早上看不到。
//   ⑧ 弱势题材：入选题材【股票总数 > 10 只】且【竞价高开的占比 < 35%】⇒ 题材虚胖
//      ⇒ 【只买龙一】且【只轻仓】。锚点：10 只里 3 只高开（30%）、12 只里 3 只高开（25%）都触发。
//      ⛔ ≤ 10 只交给下面的「买入只数」管，两条刻意不重叠。
//   ⑩ 买入只数（只看【第 1 名题材】在早盘竞价里的股票数）：
//        ≤ 6 只  → 最多买 1 只（9/18 AI应用 6 只）；
//        ≤ 10 只 → 最多买 2 只（9/21 电子/通信/算力）；
//        > 10 只 → 按原规则（≥2 一字可取 2~3 只；1 一字可重仓 + 龙二~龙五高开轻仓）。
//      ⛔ 只砍后面的票，龙一 / 最靠前的那只一定保留。
//   ⑪ 持有 / 加仓：上一交易日在【买点】里、今天又在买点里 ⇒ 强势股 ⇒ 行尾标【持有 / 加仓】。
//      §10：昨天的买点没算出来（null）⇒ 一律【不标】，绝不当成「昨天没选中」。
//
// 【⑨ 双主线竞争（2026-09-27 用户口径）】第 1 / 第 2 名题材【都 ≥ 10 只】时（大盘缩量、
//   两个大容量题材在抢主线，【只有一个能活下来】）⇒ 不看 ①~④，改比两个题材的【竞价高开率】：
//   高者龙一【重仓】、低者龙一【轻仓】，【各只选 1 只】。
//   例（9/10）：农业 11 只 / 高开 5 只 = 45% ＜ 大消费 10 只 / 高开 8 只 = 80%
//     ⇒ 大消费龙一国芳集团重仓、农业龙一敦煌种业轻仓。
//
// 【规则编号（2026-09-27 用户口径）】买点说明文字必须标【规则N】，像法律条文一样能查出处：
//   ①~⑥ = 选题材 / 选票档位；⑦~⑪ = 对已入选买点的后置收口（⑨ 是档位级的「选谁重仓」）。
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
//     ⚠️【买点】也挂同一枚徽标（同一个款式、同两个函数），由 _decorateAucBadge 在两处收口统一派生
//       （_finishBuyBlock / _finishPlanBlocks）—— 如果哪天买点的行样式又改，记得两边一起看。
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

import { sortByTopicGroups } from '../auction/topic-sort.js';
import { computeDragonRankMap, getDragonLabel } from '../auction/dragon-rank.js';
// 竞价开平（高开 / 低开 / 平开）复用连板天梯的唯一实现，⛔ 不在本文件另写一套阈值与文案（§6）
import { getAucOpenKind, getAucOpenText, AUC_OPEN_HIGH } from '../ladder/ladder-rules.js';
// 板块（创业板 / 科创板 / 北交所 = 20% / 30% 涨跌幅板）判定复用早盘竞价的唯一实现（§6）：
// 早盘竞价给这类票画浅灰删除线用的就是 isHighLimitBoard，⛔ 本文件不另写 /^(30|68)/ 这类正则。
// 竞价【跌停】同样复用 limit-up.js#getAuctionLimitState（涨跌停看板用的就是它），不另写阈值。
import { isHighLimitBoard, getAuctionLimitState, formatAucPct } from '../auction/limit-up.js';

/** 题材成组门槛：与早盘竞价统计条（topic-stats.js#TOPIC_STATS_MIN_GROUP）同源 —— 不足 2 只不成题材 */
export const DECISION_MIN_GROUP = 2;
/** 第 1 名题材触发「双票重仓」所需的最少竞价一字数量（用户口径：两个或两个以上一字） */
export const MIN_YIZI_HEAVY = 2;
/** 第 1 名题材触发「龙一重仓 + 龙二～龙五轻仓」所需的最少竞价一字数量（用户口径：只有一个竞价一字） */
export const MIN_YIZI_SINGLE = 1;
/** 第 1 名题材取几只；第 2 名题材取几只 */
export const PICK_COUNT_HEAVY = 2;
export const PICK_COUNT_SINGLE = 1;
export const PICK_COUNT_LIGHT = 1;
/** 「龙二～龙五」的档位区间（用户口径：龙一到龙五里，龙一做重仓，龙二到龙五找高开的做轻仓） */
export const LADDER_MIN_RANK = 2;
export const LADDER_MAX_RANK = 5;
/** 【无一字兜底】题材连扳里「股票数量最多」的题材至少要有这么多只；不足 ⇒ 太弱，空仓（用户口径） */
export const NO_YIZI_MIN_TOPIC_COUNT = 3;
/** 【无一字兜底】每个入选题材只看最靠前的两只（龙一 / 龙二） */
export const NO_YIZI_PICK_COUNT = 2;
/**
 * 【无一字 · 大题材兜底（2026-09-26 用户口径）】全部题材竞价一字 = 0 时：
 * 早盘竞价里【股票数量 ≥ 10 只】的题材（只看第 1 / 第 2 名）⇒ 选它的【龙一】轻仓。
 * 用户原话：9/4 电子/通信/算力 17 只、AI应用 10 只 → 各选这两个题材的龙一（哪个超过就选哪个）。
 * ⛔ 与 NO_YIZI_MIN_TOPIC_COUNT（题材连扳不足 3 只 → 空仓）是两条【并列】的规则：
 *    先判大题材，不满足才回到原来的「题材连扳」兜底 / 空仓。
 */
export const BIG_TOPIC_MIN_COUNT = 10;

// ===== [LOSS-EFFECT 2026-09-27]「题材里有竞价一字跌停」= 亏钱效应 =====
// 用户口径（9/11 农业 12 只、9/10 农业 11 只）：看入选题材在【早盘竞价】里的那些票，
//   只要有【≥1 只竞价一字跌停】（竞价就跌停，没开盘就跌停）⇒ 题材内部有亏钱效应，
//   【只买龙一】，而且【只轻仓】（题材总数量 > 10 只 或 < 10 只都一样处理）。
/** 触发「亏钱效应」所需的【竞价一字跌停】只数 */
export const LOSS_EFFECT_MIN_DIAN_TING = 1;

// ===== [BUY-COUNT 2026-09-27] 第 1 名题材的【买入只数】按题材股票数决定 =====
// 用户口径（9/18 AI应用 6 只 → 只买 1 只；9/21 电子/通信/算力 ≤10 只 → 最多 2 只；> 10 只 → 原规则）
/** 题材股票数 ≤ 这么多 → 最多买 1 只 */
export const BUY_COUNT_MAX_SMALL = 6;
/** 题材股票数 ≤ 这么多（且 > BUY_COUNT_MAX_SMALL）→ 最多买 2 只 */
export const BUY_COUNT_MAX_MID = 10;
/** 【持有 / 加仓】标记文案：上一个交易日也在买点里、今天又被选中 = 强势股 */
export const HOLD_TAG = '持有 / 加仓';

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
// 口径（AskUserQuestion 已确认）：
//   · 窗口 = 【含今日】的最近 5 个交易日；
//   · 只数【重仓 / 轻仓】两个主买点块出现的题材（弱市兜底方案 ⑤⑥ 里的题材不计）；
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

// ===== [WEAK-OPEN 2026-09-27] 大题材却没人高开 ⇒ 题材虚胖 → 只买龙一轻仓 =====
// 用户口径（原话换算）：入选题材【股票总数 > 10 只】时，看里面【竞价高开】的有几只，
//   占比【< 35%】⇒ 题材是虚胖的（票多但没人跟风），【只选龙一、轻仓】。
//   锚点：10 只里只有 3 只高开（30%）→ 触发；12 只里只有 3 只高开（25%）→ 触发（9/11 农业的情形）。
// ⛔ 刻意只在【> 10 只】生效：≤ 10 只由上面的「买入只数」（最多 1 / 2 只）管，两条不重叠。
/** 触发「弱势题材」判定的题材股票数门槛：总数【大于】这么多才看高开率 */
export const WEAK_OPEN_MIN_COUNT = 10;
/** 竞价高开占比【小于】这个比例 ⇒ 题材虚胖，只买龙一轻仓 */
export const WEAK_OPEN_RATE = 0.35;

// ===== [RULE-NO 2026-09-27] 规则编号（用户口径：说明文字要标「规则几」，像法律条文一样可追溯）=====
// ⛔ 唯一真相：买点说明里出现的每一个规则编号都取自这里（§6），⛔ 不在 UI / 各处手写字面量
//    —— 否则改了规则内容却漏改说明，用户照着旧编号提修改意见就对不上。
// 编号体系（买点 ①~⑥ = 选题材 / 选票档位；⑦~⑬ = 对已入选买点的后置收口）：
export const RULE_NO = {
  HEAVY_DOUBLE: '①',   // 第 1 名题材 · 竞价一字 ≥ 2 → 卡位选票（含创业板 / 科创板顺延）
  HEAVY_SINGLE: '②',   // 第 1 名题材 · 竞价一字 = 1 → 龙一重仓 + 龙二~龙五高开轻仓
  HEAVY_NONE: '③',     // 第 1 名题材 · 竞价一字 = 0 → 不达买入条件（等价于全部题材无一字 → ⑤）
  SECOND: '④',         // 第 2 名题材（含「题材替换」与「同题材不重复入选」）
  NO_YIZI: '⑤',        // 全部题材无一字 → 大题材龙一 / 连板天梯题材连扳
  SMALL_TOPIC: '⑥',    // 小题材（≤4 只）+ 1~2 个一字 = 高风险 → 改看题材连扳
  LOSS_EFFECT: '⑦',    // 亏钱效应：入选题材有 ≥1 只竞价一字跌停
  WEAK_OPEN: '⑧',      // 弱势题材：> 10 只 且 竞价高开率 < 35%
  DUAL_MAIN: '⑨',      // 【2026-09-27 新增】双主线竞争：第 1 / 第 2 名题材都 ≥ 10 只 → 比竞价高开率
  BUY_COUNT: '⑩',      // 买入只数（只看第 1 名题材的早盘竞价股票数）
  HOLD: '⑪',           // 持有 / 加仓标记
  PREV_BOUGHT: '⑫',    // 【昨有买入 / 加仓】标记（题材级聚合 + 股票级仓位改写）
  TOPIC_STREAK: '⑬'    // 【入选次数】题材行标记（近 5 个交易日内进过买点几次）
};

/** 规则编号 → 「【规则N】」前缀（说明文字统一从这里取，⛔ 不各处手写） */
export function ruleTag(no) {
  return '【规则' + no + '】';
}

/** 给一条说明加上规则出处前缀（§6：出处与规则实现同处一处，改规则不会漏改说明） */
function _note(no, text) {
  return ruleTag(no) + text;
}

// ===== [DUAL-MAIN 2026-09-27] 两个【大容量题材并存】→ 比竞价高开率，谁高谁重仓 =====
// 用户口径（9/10）：大盘缩量时第 1 / 第 2 名题材【都 ≥ 10 只】，两个题材在抢主线，
//   【只有一个能活下来】⇒ 不看常规档位，直接比两个题材的【竞价高开率】：
//     农业 11 只、5 只高开（45%）＜ 大消费 10 只、8 只高开（80%）
//     ⇒ 大消费的龙一国芳集团【重仓】，农业的龙一敦煌种业【轻仓】，【各只选 1 只】。
// ⛔ 高开率口径与 ⑧ 完全同一份实现（_calcOpenRate，§6）：分母 = 题材股票总数，
//    缺竞价涨幅的行按【未高开】计入分母（§10 不猜它是高开）。
/** 触发「双主线竞争」的题材股票数门槛（第 1 / 第 2 名题材【都】要 ≥ 这么多只） */
export const DUAL_MAIN_MIN_COUNT = 10;

// ===== [SMALL-TOPIC 2026-09-25]「题材太少 + 有 1~2 个一字」的高风险兜底 =====
// 用户口径：早盘竞价题材 toggle 下，排名第 1 / 第 2 的题材如果【股票数量 ≤ 4 只】却【有 1~2 个竞价一字】，
//   大概率是量化资金做出来的假强度（票太少、一字撑起来的排名），按常规规则选票【准确率很低】
//   ⇒ 这种情况下【不用常规规则】，改看连板天梯晋级看板「题材连扳」的题材股票数量来定题材。
/** 触发「高风险小题材」的题材股票数上限（≤ 4 只） */
export const SMALL_TOPIC_MAX_COUNT = 4;
/** 触发所需的一字数量区间（1 ~ 2 个） */
export const SMALL_TOPIC_MIN_YIZI = 1;
export const SMALL_TOPIC_MAX_YIZI = 2;
/** 改用题材连扳后，该题材在【早盘竞价】里的股票总数至少要这么多只才入选（< 4 只 → 排除） */
export const SMALL_TOPIC_MIN_AUCTION_COUNT = 4;
/** 数量最多的题材：在【龙一 ~ 龙五】这个区间里挑 */
export const SMALL_TOPIC_MAX_RANK = 5;
/** 数量最多的题材挑几只（第 1 只重仓，其余轻仓） */
export const SMALL_TOPIC_PICK_COUNT = 2;

/** 卖出时点 */
export const SELL_TIME_MIDDAY = '11:20';
export const SELL_TIME_CLOSE = '14:50';

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
/** 深低开阈值：今日竞价涨幅【≤ 此值】⇒ 盯盘等反弹（10:00 前定夺） */
export const SELL_DEEP_LOW = -3;
/** 小幅高开上限：今日竞价涨幅在 (0, 此值) 之间 ⇒ 看分时决定（11:20 / 立刻） */
export const SELL_MILD_HIGH = 3;
/** 卖点提示语气（UI 只按 tone 做视觉映射，⛔ 不自己判断档位，§21） */
export const SELL_TONE_DANGER = 'danger';   // 小低开 → 开盘立刻出（危）
export const SELL_TONE_WATCH = 'watch';     // 深低开 → 盯盘等反弹（10:00 前定夺）
export const SELL_TONE_PLAN = 'plan';       // 小幅高开 → 看分时（向上 11:20 / 走弱立刻）
/** 仓位建议文案 */
export const POSITION_HEAVY = '重仓';
export const POSITION_LIGHT = '轻仓';
/**
 * 【⑫ 加仓（2026-09-30 用户口径）】该股票昨天已经被打过「买」标签（用户手上已有仓位）⇒
 *   仓位不再写「重仓 / 轻仓」，改写「加仓」—— 用户原话：「旁边那个（仓位）应该变成加仓，
 *   这样更加知道那是昨天的票延续走强」。
 *   ⚠️ 「重仓 / 轻仓」是【买多少】的建仓建议；「加仓」是【已有仓位再买】的动作，两者不同层，
 *      所以对已持有的票直接换文案，而不是并列显示。
 *   ⛔ 只在【买点】生效；卖点本来就没有仓位列，不受影响。
 */
export const POSITION_ADD = '加仓';
/** 仓位配色档（§21：由 Logic 层给 tone，模板只做 `'dcb-pos-' + tone` 拼接，⛔ 不做比较） */
export const POSITION_TONE_HEAVY = 'heavy';
export const POSITION_TONE_LIGHT = 'light';
export const POSITION_TONE_ADD = 'add';

/** 仓位文案 → 配色档（模板零判断的唯一出口） */
export function positionToneOf(position) {
  if (position === POSITION_LIGHT) return POSITION_TONE_LIGHT;
  if (position === POSITION_ADD) return POSITION_TONE_ADD;
  return POSITION_TONE_HEAVY;
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
 * 题材排名 —— 与早盘竞价「题材 toggle」【完全同一套组序口径】。
 * 刻意复用 sortByTopicGroups（早盘竞价就在用它），而不是在本文件另写一遍比较器：
 * 另写必然分叉，分叉就会出现「决策看板说第一、早盘竞价显示第二」的错位（§6 单一真相）。
 *
 * @param {Array<{name:string, topic:string, isYizi?:boolean, countable?:boolean,
 *                inheritSold?:boolean, code?:string, pct?:number|null, aucPct?:number|null}>} entries
 *        countable=false 的行（早盘竞价里「灰色名称 + 灰色题材」= 不在当日正式列表）
 *          不计入数量与一字数 —— 与早盘竞价统计条同口径；
 *          ⛔ 但【2026-09-26 用户口径】它们照常参与龙位与选票（同时期龙头有参考价值），
 *             inheritSold=true = 「昨日卖标签继承」的行（早盘竞价里是灰色实心卖标签）：
 *             ⛔ 2026-09-27 起【也照常参与】龙位与选票（9/8 国芳集团就是这种行，用户点名要它入选）。
 *        code = 股票代码（判 20%/30% 涨跌幅板用；缺失 → 不猜，§40）。
 *        aucPct = 当日竞价涨幅（%）；null = 缺数据（§10：不能当 0，也就不能当「高开」）。
 * @returns {Array<{rank:number, topic:string, count:number, yiziCount:number,
 *                  members:Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                                 code:string, countable:boolean, inheritSold:boolean}>}>}
 *          已剔除「其它」与不足 DECISION_MIN_GROUP 的题材；按组序（一字多 → 人多 → 题材名）升序。
 */
export function rankDecisionTopics(entries) {
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
    function(i) { return list[i].countable !== false; }
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
 * 候选集口径（2026-09-26 修订）：
 *   · m.pct === null → 缺十日涨幅，排不进龙位（§10：绝不当 0 参与比较）；
 *   · ⛔ m.countable === false【不再排除】—— 那是早盘竞价里「灰色名称 + 灰色题材」的行
 *     （不在当日正式列表，但确实是同时期龙头，9/8 大消费龙一国芳集团就是这种行）。
 *     用户 2026-09-26 明确要求这类灰行【也要参与龙位与买点决策】，
 *     只是仍【不计入】题材数量 / 一字数（统计口径与早盘竞价统计条保持一致）。
 *   · ⛔ m.inheritSold === true【同样不排除】（2026-09-27 修正）：「昨日卖标签继承」的行
 *     在早盘竞价里也是画灰的（灰色实心卖标签），用户点名要它入选 ——
 *     9/8 大消费龙一国芳集团正是「灰名 + 灰题材 + 灰色实心卖标签」，上一版把它过滤掉 ⇒ 没选进来。
 *     ⛔ 结论：本看板【只用 countable 区分统计】，龙位与选票【不因任何灰行身份而排除】。
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
 * 题材块 → 可买候选（按龙头名次升序）。三处选票共用这一份候选（§6 单一真相）：
 *   · 竞价一字       → 买不进，剔除；
 *   · ⛔ 灰行【一律不剔除】：不在当日正式列表（countable=false）、昨日卖标签继承（inheritSold）
 *     都照常参与 —— 用户 2026-09-26 / 09-27 两次点名要它们能入选（9/8 国芳集团、万向德农）。
 *     灰行只影响【统计口径】（数量 / 一字数由 countable 决定），不影响龙位与选票。
 *   · 非龙一 + 20%/30% 涨跌幅板（创业板 / 科创板 / 北交所）→ 剔除，顺延下一位
 *     [GROWTH-BOARD 2026-09-26 用户口径]：9/2 AI应用 3 个一字，按名次取到龙五芒果超媒（创业板），
 *     它在后排且是 20% 板 ⇒ 往下移一位改选龙六（龙版传媒）。
 *     ⛔ 龙一本身是 20% 板也照选（龙一是最强票，不因板块被跳过）。
 *     板块判定复用 limit-up.js#isHighLimitBoard（早盘竞价给这类票画删除线的就是它，§6 不另写正则）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {Array<{name:string, pct:number|null, aucPct:number|null, rank:number|null, code:string}>}
 */
function _buyCandidates(block, dragonMap) {
  if (!block) return [];
  const dragon = dragonMap || new Map();
  return (block.members || [])
    .filter(function(m) { return !m.isYizi; })          // 一字买不进；灰行一律保留
    .map(function(m) {
      const d = dragon.get(m.name);
      return {
        name: m.name,
        pct: _num(m.pct),
        aucPct: _num(m.aucPct),
        code: m.code || '',
        rank: (d && d.rank) ? d.rank : null
      };
    })
    .filter(function(c) {                                  // [GROWTH-BOARD] 非龙一的 20%/30% 板顺延
      return !(c.rank !== 1 && isHighLimitBoard(c.code));
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
    position: position
  };
}

/**
 * 【① 第 1 名题材 · 竞价一字 ≥ 2 个】重仓选票（2026-09-26 用户口径，替代「按名次取前两只」）
 *
 *   ① 龙一（龙头顺序最靠前的那只非一字）必选，重仓；
 *   ② 第二只不再按名次取龙二，改【按竞价涨幅最高】选（卡位概率大的人气票）；
 *   ③ 若「涨幅最高」那只【不是】名次第二的龙二（= 发生卡位/跳位）：
 *        → 涨幅最高那只【重仓】 + 【龙二】【轻仓】 ⇒ 一共选【3 只】；
 *      否则（涨幅最高的就是龙二）⇒ 维持原来的 2 只（都重仓）。
 *      例（9/1 农业 2 个一字）：龙二金健米业 +0.1%、龙三万向德农 +7.3%
 *        → 选 龙一（重仓）+ 万向德农（重仓）+ 金健米业（轻仓）＝ 3 只。
 *   §10：缺竞价涨幅的票不参与「涨幅最高」的竞争（≠ 0，也不等于最高）；全都缺 → 退回按名次取。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {{picks:Array, notes:string[], jumped:boolean}}
 */
export function pickHeavyTwo(block, dragonMap) {
  const cands = _buyCandidates(block, dragonMap);
  const notes = [];
  if (cands.length === 0) return { picks: [], notes: notes, jumped: false };

  const head = cands[0];
  const rest = cands.slice(1);
  // 名次第二的那只（无论涨幅）
  const second = rest.length > 0 ? rest[0] : null;
  // 涨幅最高的那只（缺涨幅不参与；全部缺 → 退回名次第二）
  const withAuc = rest.filter(function(c) { return c.aucPct !== null; });
  const best = withAuc.length > 0
    ? withAuc.slice().sort(function(a, b) {
      if (b.aucPct !== a.aucPct) return b.aucPct - a.aucPct;
      const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
      const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    })[0]
    : second;

  const picks = [_toPick(head, POSITION_HEAVY)];
  let jumped = false;
  if (best) {
    picks.push(_toPick(best, POSITION_HEAVY));
    if (second && best.name !== second.name) {
      jumped = true;
      picks.push(_toPick(second, POSITION_LIGHT));
      notes.push(_note(RULE_NO.HEAVY_DOUBLE, '第二只按【竞价涨幅最高】选（' + best.name + ' ' +
        best.aucPct + '% ＞ ' + second.name + ' ' + second.aucPct + '%）→ 比名次第二的票更强（卡位概率大），' +
        best.name + POSITION_HEAVY + '、' + second.name + POSITION_LIGHT + '（共 3 只）'));
    }
  }
  if (withAuc.length === 0 && rest.length > 0) {
    notes.push(_note(RULE_NO.HEAVY_DOUBLE,
      '其余票都缺竞价涨幅 → 第二只按【龙头名次】取（§10 不猜涨幅）'));
  }
  return { picks: _reseq(picks), notes: notes, jumped: jumped };
}

/**
 * 在一个题材块里挑「能买的」：按龙头排名升序，跳过【竞价一字】（一字买不进），取前 maxCount 只。
 * @returns {Array<{seq:number, name:string, dragonLabel:string, dragonRank:number|null,
 *                  pct:number|null, position:string}>}
 */
export function pickBuyable(block, dragonMap, maxCount, position) {
  const candidates = _buyCandidates(block, dragonMap).slice(0, maxCount || 1);
  return _reseq(candidates.map(function(c) { return _toPick(c, position); }));
}

/**
 * 【第 2 名题材 · 取「排名最靠前的那只竞价高开」】
 *
 * 口径（2026-09-26 用户）：第 2 名题材不再「按龙头顺序取第一名」（那样会选到低开的票，
 *   实测 9/24 大消费 9 只里按名次取到了奥康国际（龙二、低开）），改为 ——
 *   【按龙头顺序跳过一字，取排名最靠前的那只「竞价高开」的股票，只选 1 只，轻仓】。
 *   例：龙一~龙八都低开、只有龙九高开 → 选龙九；
 *       龙一~龙三低开、龙四高开、龙八也高开 → 选龙四（名次更靠前的那个）。
 *
 * 判据与早盘竞价「龙标红色 = 竞价涨幅 > 0」同源（aucPct > 0），不另写阈值（§6）；
 * §10：竞价涨幅缺失 ≠ 高开，单独记 unknownCount 如实报出来，不静默丢掉。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number, highOpenCount:number}}
 */
export function pickFirstHighOpen(block, dragonMap, position) {
  if (!block) return { picks: [], unknownCount: 0, highOpenCount: 0 };
  const dragon = dragonMap || new Map();
  const cand = [];
  let unknownCount = 0;

  (block.members || []).forEach(function(m) {
    // ⛔ 不再因「灰行 / 昨日卖标签继承」而剔除：它们照常参与龙位与选票（09-27 用户口径）
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                               // 没有十日涨幅 → 排不进龙头顺序
    if (m.isYizi) return;                                    // 一字买不进
    const auc = _num(m.aucPct);
    if (auc === null) { unknownCount++; return; }            // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (auc <= 0) return;                                    // 只要高开
    cand.push({ name: m.name, pct: _num(m.pct), rank: rank });
  });

  cand.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;           // 龙头名次最靠前的优先
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return {
    picks: _reseq(cand.slice(0, PICK_COUNT_LIGHT).map(function(c) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: position
      };
    })),
    unknownCount: unknownCount,
    highOpenCount: cand.length
  };
}

/**
 * 【第 2 名题材 · 选票总入口】（2026-09-26 用户口径，两条规则有先后）
 *
 *   ①【优先】龙一【不是】竞价一字（一字买不进，所以才看龙一）→ 【直接买龙一】，
 *      不看竞价涨跌幅（高开 / 低开 / 平开都买）。
 *   ② 龙一【是】竞价一字（或题材里根本没有可判定的龙一）→ 退回【pickFirstHighOpen】：
 *      按龙头顺序跳过一字，取【名次最靠前的那只竞价高开】的股票 1 只。
 *      例：龙一是字 → 龙一~龙三低开、龙四高开、龙八也高开 → 选龙四（名次优先，不是涨幅优先）。
 *
 * ⛔ 两条规则只覆盖【第 2 名题材】，① / ② / ③（第 1 名题材）不受影响（用户只对第 2 名提了这条）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number, highOpenCount:number,
 *            viaDragonOne:boolean, dragonOneYizi:boolean}}
 */
export function pickSecondTopicBuy(block, dragonMap, position) {
  if (!block) {
    return { picks: [], unknownCount: 0, highOpenCount: 0, viaDragonOne: false, dragonOneYizi: false };
  }
  const dragon = dragonMap || new Map();

  // 龙一 = 本题材块里龙头名次为 1 的成员（⛔ 灰行 / 昨日卖标签继承的行也照常算，09-27 用户口径）
  const dragonOne = (block.members || []).find(function(m) {
    const d = dragon.get(m.name);
    return !!(d && d.rank === 1);
  }) || null;

  // ① 龙一存在 且 不是一字 → 直接买龙一（不看竞价涨跌幅）
  if (dragonOne && !dragonOne.isYizi) {
    return {
      picks: _reseq([{
        name: dragonOne.name,
        dragonLabel: getDragonLabel(1),
        dragonRank: 1,
        pct: _num(dragonOne.pct),
        position: position
      }]),
      unknownCount: 0,
      highOpenCount: 0,
      viaDragonOne: true,
      dragonOneYizi: false
    };
  }

  // ② 龙一买不进（是一字）或排不出龙一 → 老规则：名次最靠前的那只高开票
  const r = pickFirstHighOpen(block, dragonMap, position);
  r.viaDragonOne = false;
  r.dragonOneYizi = !!dragonOne;                 // true = 龙一是字才走的回退；false = 根本没有龙一
  return r;
}

/**
 * 【龙二～龙五补票】第 1 名题材只有 1 个竞价一字时的【轻仓】候选。
 *
 * 口径（2026-09-24 用户）：”看龙二到龙五，除了竞价一字买不到外，买竞价涨幅大于 0 的
 * （早盘竞价看板的龙标是红色的龙二到龙五的股票）”。
 * 所谓「龙标是红色」= 早盘竞价 AuctionDragonBadge 的底色口径：竞价涨幅 > 0 → 红。
 * 因此这里的判据就是 aucPct > 0，与那枚徽章同源，不再另写一个阈值（§6）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {Set<string>} excludeNames 已被重仓挑走的股票（避免同一只既重仓又轻仓）
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number}} unknownCount = 因【缺竞价涨幅】而无法判定的只数
 *          （§10：它们不是「不高开」，如实报出来，不静默丢掉）
 */
export function pickLadder(block, dragonMap, excludeNames, position) {
  if (!block) return { picks: [], unknownCount: 0 };
  const dragon = dragonMap || new Map();
  const exclude = excludeNames || new Set();
  const hit = [];
  let unknownCount = 0;

  block.members.forEach(function(m) {
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                                            // 没有十日涨幅 → 排不进龙二~龙五
    if (rank < LADDER_MIN_RANK || rank > LADDER_MAX_RANK) return;         // 只看龙二到龙五
    if (exclude.has(m.name)) return;
    if (m.isYizi) return;                                                 // 一字买不进
    if (m.aucPct === null || !isFinite(m.aucPct)) { unknownCount++; return; } // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (m.aucPct <= 0) return;                                            // 只要高开
    hit.push({ name: m.name, pct: m.pct, rank: rank });
  });

  hit.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return {
    picks: _reseq(hit.map(function(c) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: position
      };
    })),
    unknownCount: unknownCount
  };
}

/**
 * 【高风险小题材判定 · 2026-09-25 用户口径】
 * 题材【股票数量 ≤ SMALL_TOPIC_MAX_COUNT 只】且【竞价一字 1~2 个】⇒ 疑似量化假强度，
 * 常规规则（按一字多少排题材、再买龙一/龙二）准确率很低 → 改用⑥的兜底规则。
 *
 * @param {object} block rankDecisionTopics 的题材块（rank 1 / 2 的那两个）
 * @returns {boolean}
 */
export function isSmallRiskyTopic(block) {
  if (!block) return false;
  const c = Number(block.count) || 0;
  const y = Number(block.yiziCount) || 0;
  return c > 0 && c <= SMALL_TOPIC_MAX_COUNT && y >= SMALL_TOPIC_MIN_YIZI && y <= SMALL_TOPIC_MAX_YIZI;
}

/**
 * 【⑥ 兜底 · 龙一～龙五里挑「竞价高开」的两只】
 *
 * 口径（2026-09-25 用户，两次口径合并）：题材股票数量最多的那个题材，在【龙一到龙五】里
 * 只挑【竞价高开】（竞价涨幅 > 0）的票，分两种情形：
 *
 *   ① 龙一【高开】→ 龙一占一个名额并【重仓】，另一个名额给【其余高开票里竞价涨幅最高】的那只【轻仓】。
 *      例：龙一 +1%、龙二 −2%、龙三 +3.6%、龙四 0%、龙五 +6.5%
 *          → 高开的 = 龙一 / 龙三 / 龙五 → 取 龙一（重仓）+ 龙五（涨幅最高，轻仓）。
 *
 *   ② 龙一【低开 / 平开 / 缺竞价涨幅】→ 【舍弃龙一】，只在【龙二 ~ 龙五】的高开票里选，
 *      有两只以上高开时只取【竞价涨幅最高的两只】，【两只都轻仓】（龙一走弱就不再重仓）。
 *      例：龙一 −6%、龙二 −2%、龙三 +3.6%、龙四 0%、龙五 +6.5%
 *          → 高开的 = 龙三 / 龙五 → 取 龙五、龙三，都轻仓。
 *
 * 排序规则刻意固定为「竞价涨幅降序 → 龙头名次 → 股票名」，保证结果稳定可复现（不随机）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {number} maxRank 只看龙一 ~ 第 maxRank 名
 * @param {number} maxCount 取几只（龙一高开时第 1 只重仓、其余轻仓；龙一不高开时【全部轻仓】）
 * @returns {{picks:Array, unknownCount:number, dragonOneHighOpen:boolean}}
 */
export function pickTopDragonsByAuc(block, dragonMap, maxRank, maxCount) {
  if (!block) return { picks: [], unknownCount: 0, dragonOneHighOpen: false };
  const dragon = dragonMap || new Map();
  const top = maxRank || SMALL_TOPIC_MAX_RANK;
  const hit = [];
  let unknownCount = 0;
  let dragonOneHighOpen = false;

  (block.members || []).forEach(function(m) {
    // ⛔ 不再因「灰行 / 昨日卖标签继承」而剔除：它们照常参与龙位与选票（09-27 用户口径）
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                               // 没有十日涨幅 → 排不进龙一~龙五
    if (rank < 1 || rank > top) return;
    if (m.isYizi) return;                                    // 一字买不进
    const auc = _num(m.aucPct);
    if (auc === null) { unknownCount++; return; }            // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (auc <= 0) return;                                    // 只要高开
    if (rank === 1) dragonOneHighOpen = true;
    hit.push({ name: m.name, pct: _num(m.pct), rank: rank, auc: auc });
  });

  hit.sort(function(a, b) {
    if (b.auc !== a.auc) return b.auc - a.auc;               // 先按【竞价涨幅】降序
    if (a.rank !== b.rank) return a.rank - b.rank;           // 同涨幅 → 龙头名次靠前的优先
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); // 仍相同 → 股票名，保证稳定
  });

  const limit = maxCount || SMALL_TOPIC_PICK_COUNT;
  // ① 龙一高开 → 龙一固定占第一个名额（重仓）+ 其余里涨幅最高的一只（轻仓）
  // ② 龙一不高开 → 舍弃龙一，只取【龙二~龙五】里涨幅最高的 maxCount 只，全部轻仓
  const dragonOne = hit.find(function(c) { return c.rank === 1; }) || null;
  const chosen = dragonOne
    ? [dragonOne].concat(hit.filter(function(c) { return c.rank !== 1; }).slice(0, limit - 1))
    : hit.slice(0, limit);

  return {
    picks: _reseq(chosen.map(function(c, i) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: (dragonOne && i === 0) ? POSITION_HEAVY : POSITION_LIGHT
      };
    })),
    unknownCount: unknownCount,
    dragonOneHighOpen: dragonOneHighOpen
  };
}

/** 重排序号（龙一在最前，序号从 1 连续；合并「重仓 + 轻仓」后必须重排，否则序号会重复） */
function _reseq(picks) {
  return picks.map(function(p, i) { p.seq = i + 1; return p; });
}

function _reasonBuy(block, rankWord) {
  if (!block) return '';
  return '题材排' + rankWord + '，股票数量' + block.count + '只，' + block.yiziCount + '个竞价一字';
}

/**
 * 第 1 名题材按【竞价一字数量】分三档给方案（唯一实现；后期改门槛只改这里）。
 *  ⛔ 重仓 / 轻仓混在同一个题材块里（picks 按龙头顺序排列），序号连续：
 *     用户要的格式是「序号｜名称（龙几）｜十日涨幅｜重仓/轻仓」，重仓轻仓在【行尾】区分，
 *     ⛔ 不再写「建议」二字（2026-09-24 用户要求：行尾直接就是结论）。
 *     没必要把同一题材拆成两个块、重复渲染一遍题材名和数据（不省空间反占空间）。
 * @param {object} first 【第 1 名】题材块（调用方保证非空）
 * @returns {{mode:string, qualified:boolean, picks:Array, notes:string[]}}
 */
function _buildFirstBlock(first, dragonMap) {
  const base = {
    block: first,
    rankWord: '第一',
    reason: _reasonBuy(first, '第一'),
    mode: 'none',
    ruleNo: RULE_NO.HEAVY_NONE,
    qualified: false,
    notQualifiedText: '',
    picks: [],
    notes: []
  };
  const yz = first.yiziCount;
  if (yz >= MIN_YIZI_HEAVY) {
    // [HEAVY-TWO 2026-09-26] 不再是「按名次取前两只」：
    //   龙一必选重仓 + 第二只按【竞价涨幅最高】选；涨幅最高者不是龙二时再加龙二轻仓（共 3 只）。
    base.mode = 'double';
    base.ruleNo = RULE_NO.HEAVY_DOUBLE;
    base.qualified = true;
    const r = pickHeavyTwo(first, dragonMap);
    base.picks = r.picks;
    base.notes = base.notes.concat(r.notes);
    // 说明文字带规则出处（用户口径：像法律条文一样能查到是哪一条）
    base.reason = _reasonBuy(first, '第一') + '　→ 根据规则' + RULE_NO.HEAVY_DOUBLE +
      '：竞价一字 ≥ ' + MIN_YIZI_HEAVY + ' 个 → 龙一' + POSITION_HEAVY +
      ' + 竞价涨幅最高的那只' + POSITION_HEAVY + '（发生卡位时再加龙二' + POSITION_LIGHT + '）';
    return base;
  }
  if (yz >= MIN_YIZI_SINGLE) {
    base.mode = 'single';
    base.ruleNo = RULE_NO.HEAVY_SINGLE;
    base.qualified = true;
    // 重仓：龙头顺序里跳过一字取最靠前的 1 只（正常情况下就是龙一；龙一是一字时自动落到下一只）
    const head = pickBuyable(first, dragonMap, PICK_COUNT_SINGLE, POSITION_HEAVY);
    const exclude = new Set(head.map(function(p) { return p.name; }));
    const lad = pickLadder(first, dragonMap, exclude, POSITION_LIGHT);
    base.picks = _reseq(head.concat(lad.picks).sort(function(a, b) {
      const ra = (a.dragonRank === null ? Number.MAX_SAFE_INTEGER : a.dragonRank);
      const rb = (b.dragonRank === null ? Number.MAX_SAFE_INTEGER : b.dragonRank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }));
    if (lad.picks.length === 0) {
      base.notes.push(_note(RULE_NO.HEAVY_SINGLE,
        '龙二到龙五中没有「非一字 且 竞价涨幅>0」的股票，本档无轻仓票'));
    }
    if (lad.unknownCount > 0) {
      base.notes.push(_note(RULE_NO.HEAVY_SINGLE,
        '另有 ' + lad.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）'));
    }
    base.reason = _reasonBuy(first, '第一') + '　→ 根据规则' + RULE_NO.HEAVY_SINGLE +
      '：竞价一字只有 ' + MIN_YIZI_SINGLE + ' 个 → 龙一' + POSITION_HEAVY +
      ' + 龙二~龙五里「非一字 且 竞价高开」的票' + POSITION_LIGHT;
    return base;
  }

  // ⚠️ 正常走不到这里：题材排名是按【一字数】排的（topic-sort#sortByTopicGroups），
  //    所以「第 1 名题材一字 = 0」必然意味着【全部题材】都是 0 —— 那种日子 buildBuyPlan
  //    已经先拦下来改走 ⑤（弱市兜底）了。留着它是为了以后有人改了排序口径却没同步改规则：
  //    宁可显示「未达买入条件」，也绝不给出来路不明的建议。
  base.mode = 'none';
  base.ruleNo = RULE_NO.HEAVY_NONE;
  base.qualified = false;
  base.notQualifiedText = _note(RULE_NO.HEAVY_NONE, '该题材竞价一字为 0 个，未达买入条件');
  return base;
}

/** 开平文案；缺竞价涨幅（null）单列一类（§10：缺数据 ≠ 平开，不能混进「低开」） */
function _openWord(aucPct) {
  const kind = getAucOpenKind(aucPct);
  return kind ? getAucOpenText(kind) : '缺竞价涨幅';
}

/** 是否【竞价高开】：只有明确 > 0 才算；null（缺数据）不算（§10） */
function _isHighOpen(aucPct) {
  const n = _num(aucPct);
  return n !== null && n > 0;
}

/**
 * 【龙头候选排序 · 2026-09-25】把一组行整理成「龙一 / 龙二 / …」有序候选（纯函数，本文件私有）。
 *
 * 排序依据的优先级（与早盘竞价龙标同一份排名，§6 单一真相）：
 *   ① dragonMap 里的 rank（= computeDragonRankMap 的结果，早盘竞价行上那枚「龙一/龙二」徽章）；
 *   ② 没有 rank 的（少数未进早盘竞价题材组的行）按【十日涨幅】降序排在有 rank 的后面；
 *   ③ 仍相同 → 股票名，保证每次结果完全一致（不随机）。
 *
 * 剔除口径（与「题材数量 / 一字数」的计数口径同源）：
 *   · 竞价一字 → 买不进，不占龙位；
 *   · ⛔ inheritSold === true【不排除】：昨日卖标签继承的行也照常参与（09-27 用户口径）；
 *   · 十日涨幅缺失 → §10：绝不当 0 参与比较，直接排不进龙位。
 *
 * @param {Array<{name:string, pct:number|null, aucPct:number|null, isYiZi?:boolean,
 *                countable?:boolean}>} rows
 * @param {Map<string,{rank:number}>} dragon
 * @returns {Array<{name:string, rank:number, pct:number|null, aucPct:number|null}>}
 */
function _rankCandidates(rows, dragon) {
  const out = [];
  (rows || []).forEach(function(r) {
    if (!r || !r.name || r.isYiZi) return;                 // 一字买不进 → 不占龙位
    // ⛔ 不再因「灰行 / 昨日卖标签继承」而剔除（09-27 用户口径）
    const pct = _num(r.pct);
    if (pct === null) return;                              // §10：缺十日涨幅 → 排不进龙位
    const d = dragon.get(r.name);
    out.push({
      name: r.name,
      rank: (d && d.rank) ? d.rank : null,
      pct: pct,
      aucPct: _num(r.aucPct)
    });
  });
  out.sort(function(a, b) {
    const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
    const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
    if (ra !== rb) return ra - rb;
    if (a.pct !== b.pct) return b.pct - a.pct;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out.map(function(c, i) {
    return { name: c.name, rank: c.rank || (i + 1), pct: c.pct, aucPct: c.aucPct };
  });
}

/**
 * 按题材名在【早盘竞价题材块】里找同名块。
 * §6：龙一 / 龙二的排名人群必须与「早盘竞价龙标」完全一致 —— 题材连扳只负责决定
 * 【选哪个题材】（数量最多），龙头名次本身仍归早盘竞价口径（否则同一题材会出现两套龙一）。
 * @param {Array<object>} blocks rankDecisionTopics 的返回
 * @param {string} topic
 * @returns {object|null}
 */
function _findAuctionBlock(blocks, topic) {
  const key = String(topic || '').trim();
  if (!key || !blocks || blocks.length === 0) return null;
  for (let i = 0; i < blocks.length; i++) {
    if (String(blocks[i].topic || '').trim() === key) return blocks[i];
  }
  return null;
}

/**
 * 【无一字兜底买点 · 2026-09-25 用户口径】
 *
 * 触发条件（由 buildBuyPlan 判定）：当日【所有题材】的竞价一字都是 0 个 = 弱市。
 * 选票口径：
 *   ① 看【连板天梯 · 题材连扳】（ladder-rules#groupByTopicLadder 的同一份分组，§6 单一真相）；
 *   ② 取【股票数量最多】的题材 —— 数量并列时【并列的题材全都取】（用户举例：AI应用也是 3 只）；
 *   ③ 每个入选题材只看最靠前的两只（龙一 / 龙二），龙一 / 龙二 = 题材内【十日涨幅】排名
 *      （与早盘竞价龙一徽章同一口径 computeDragonRankMap）；
 *      ⚠️ 排名人群是【该题材在早盘竞价里的全量成员】（opts.auctionTopicBlocks），
 *         ⛔ 不是「题材连扳」那几只连板票的子集 —— 后者只是用来决定选哪个题材。
 *         旧实现拿子集 ∩ 全量排名 ⇒ 题材真龙一（当天没连板）被跳过、名次整体前移
 *         （2026-09-25 事故：9/16 电子/通信/算力 龙一被判成澳弘电子而非超声电子）；
 *   ④ 最终只留【竞价高开】的票：
 *        龙一低开 + 龙二高开 → 只买龙二；
 *        两只都高开           → 两只都买；
 *        两只都低开           → 只买龙一；
 *      ⚠️ 竞价涨幅缺失不算高开，会单独说明（§10 不猜）；
 *   ⑤ 全部记【轻仓】（没有一字，强度打折）；
 *   ⑥ 股票最多的题材【不足 NO_YIZI_MIN_TOPIC_COUNT 只】→ 【空仓】（太弱，不参与）。
 *
 * @param {Array<{topic:string, count:number,
 *                rows:Array<{name:string, pct:number|null, aucPct:number|null, isYiZi:boolean}>}>} topicGroups
 *        连板天梯「题材连扳」的分组（⛔ 直接由 ladder-collect 采集，与天梯看板显示完全一致）
 * @param {{dragonMap?:Map, ladderReady?:boolean, ladderReason?:string,
 *          auctionTopicBlocks?:Array}} [opts]
 *        ladderReady=false 表示连板数据没加载（§10：如实报「未就绪」，绝不退化成「今天没有连板股」）
 *        auctionTopicBlocks = 早盘竞价的题材块（rankDecisionTopics 的返回）—— 龙一 / 龙二的
 *        【排名人群】，⛔ 不传就只能退回「题材连扳」子集自排（会与早盘竞价龙标分叉）
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildNoYiziPlan(topicGroups, opts) {
  const o = opts || {};
  const dragon = o.dragonMap || new Map();

  const out = {
    mode: 'noYizi',
    qualified: false,
    emptyText: '',
    hintText: '当日全部题材【竞价一字 0 个】→ 改看连板天梯「题材连扳」：' +
      '取股票数量最多的题材的龙一 / 龙二，只留竞价高开的票，全部' + POSITION_LIGHT,
    blocks: [],
    notes: []
  };

  // §10：连板数据没加载 = 「还没拉到」，绝不等于「今天没有连板梯队」
  if (o.ladderReady === false) {
    out.emptyText = '连板天梯数据未就绪' + (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      '，无法按「无一字」规则选票';
    return out;
  }

  const groups = (topicGroups || []).filter(function(g) {
    return g && g.topic && g.topic !== OTHER && (Number(g.count) || 0) > 0;
  });
  if (groups.length === 0) {
    out.emptyText = '连板天梯「题材连扳」当日没有可用题材，无法按「无一字」规则选票 → 【空仓】';
    return out;
  }

  // ① 股票数量最多的那个数量（并列取全部）
  let maxCount = 0;
  groups.forEach(function(g) {
    const c = Number(g.count) || 0;
    if (c > maxCount) maxCount = c;
  });
  // ⑥ 太弱 → 空仓（用户口径：最多只有 2 只就不参与）
  if (maxCount < NO_YIZI_MIN_TOPIC_COUNT) {
    out.emptyText = '题材连扳里股票最多的题材【只有 ' + maxCount + ' 只】（不足 ' +
      NO_YIZI_MIN_TOPIC_COUNT + ' 只），强度太弱 → 【空仓】';
    return out;
  }

  const winners = groups.filter(function(g) { return (Number(g.count) || 0) === maxCount; });
  if (winners.length > 1) {
    out.notes.push(_note(RULE_NO.NO_YIZI, '有 ' + winners.length + ' 个题材并列最多（' +
      winners.map(function(g) { return g.topic; }).join('、') + '），每个都按同一规则选票'));
  }

  let totalPicks = 0;
  winners.forEach(function(g) {
    // ② 龙一 / 龙二 = 该题材【在早盘竞价口径下】的龙头前两名（与早盘竞价龙标同一份排名）。
    //    题材连扳只用来决定「选哪个题材」，不用来决定名次。找不到同名题材块才退回组内自排（§10 不猜）。
    const blk = _findAuctionBlock(o.auctionTopicBlocks, g.topic);
    const cand = _rankCandidates(blk ? blk.members : (g.rows || []), dragon);
    const top = cand.slice(0, NO_YIZI_PICK_COUNT);
    const d1 = top[0] || null;
    const d2 = top[1] || null;

    const notes = [];
    let picks = [];
    let unknownCount = 0;
    if (!blk) {
      notes.push(_note(RULE_NO.NO_YIZI,
        '该题材在早盘竞价题材分组里没有同名题材 → 龙一 / 龙二 暂按「题材连扳」成员排名（§10 不猜）'));
    }
    if (d1 && d1.aucPct === null) unknownCount++;
    if (d2 && d2.aucPct === null) unknownCount++;

    if (!d1) {
      notes.push(_note(RULE_NO.NO_YIZI,
        '该题材在连板梯队里没有能排进龙一 / 龙二的股票（缺十日涨幅 或 全是一字）→ 不选票（§10 不猜）'));
    } else {
      const h1 = _isHighOpen(d1.aucPct);
      const h2 = _isHighOpen(d2 ? d2.aucPct : null);
      if (h1 && h2) {
        picks = [d1, d2];
        notes.push(_note(RULE_NO.NO_YIZI, '龙一、龙二【都是竞价高开】→ 两只都买'));
      } else if (h1) {
        picks = [d1];
        notes.push(_note(RULE_NO.NO_YIZI, '龙一【竞价高开】' +
          (d2 ? ('，龙二' + _openWord(d2.aucPct)) : '，无龙二') + ' → 只买龙一'));
      } else if (h2) {
        picks = [d2];
        notes.push(_note(RULE_NO.NO_YIZI,
          '龙一' + _openWord(d1.aucPct) + '，龙二【竞价高开】→ 只买高开的龙二'));
      } else {
        picks = [d1];
        notes.push(_note(RULE_NO.NO_YIZI, '龙一 / 龙二【都不是竞价高开】（' + _openWord(d1.aucPct) +
          (d2 ? ('、' + _openWord(d2.aucPct)) : '、无龙二') + '）→ 按规则只买龙一'));
      }
    }
    if (unknownCount > 0) {
      notes.push(_note(RULE_NO.NO_YIZI,
        '另有 ' + unknownCount + ' 只缺竞价涨幅，无法判定是否高开（§10 不猜）'));
    }

    totalPicks += picks.length;
    out.blocks.push({
      // 复用买点块的数据结构，让 UI 直接复用 DecisionBuyBlock（⛔ 不另写一套渲染）
      // [WEAK-OPEN 2026-09-27] count / members 一律取【早盘竞价同名题材块】（§6 同源）：
      //   ⑦ 亏钱效应、⑧ 弱势题材都是「分母 = block.count、分子 = block.members 里数出来的」，
      //   两者必须来自同一份数据 —— 分母用连板天梯的只数、分子用早盘竞价的行，
      //   会把高开率算成一个两边都不认的假数字。早盘竞价没有同名题材块时才退回天梯口径。
      block: {
        topic: g.topic,
        rank: null,
        count: blk ? (Number(blk.count) || 0) : (Number(g.count) || 0),
        yiziCount: 0,
        members: blk ? blk.members : (g.rows || [])
      },
      rankWord: '',
      reason: '全部题材竞价一字 0 个；该题材在连板天梯「题材连扳」里股票数量最多（' +
        (Number(g.count) || 0) + ' 只）　→ 根据规则' + RULE_NO.NO_YIZI +
        '：只买龙一 / 龙二中【竞价高开】的票',
      mode: 'noYizi',
      ruleNo: RULE_NO.NO_YIZI,
      qualified: true,
      notQualifiedText: '',
      picks: _reseq(picks.map(function(c) {
        return {
          name: c.name,
          dragonLabel: getDragonLabel(c.rank),
          dragonRank: c.rank,
          pct: c.pct,
          position: POSITION_LIGHT
        };
      })),
      notes: notes
    });
  });

  out.qualified = totalPicks > 0;
  if (!out.qualified) {
    out.emptyText = '股票数量最多的题材里没有可买的龙一 / 龙二 → 【空仓】';
  }
  return out;
}

/**
 * 【⑥ 高风险小题材兜底 · 2026-09-25 用户口径】
 *
 * 触发条件（由 buildBuyPlan 判定）：早盘竞价题材 toggle 下，排名【第 1 或第 2】的题材
 * 【股票数量 ≤ SMALL_TOPIC_MAX_COUNT 只】且【竞价一字 1~2 个】—— 票太少却被一字撑起排名，
 * 多半是量化做出来的假强度，常规规则（按一字多少选题材 → 买龙一 / 龙二）准确率很低
 * ⇒ 【不用常规规则】，改按下面这套来选：
 *
 *   ① 取【连板天梯 · 题材连扳】的题材分组（ladder-collect 同一份 0 请求结果，§6）；
 *   ② 每个候选题材再看它在【早盘竞价】里的股票总数，
 *      < SMALL_TOPIC_MIN_AUCTION_COUNT 只的【排除】（用户举例：AI应用早盘竞价只有 3 只 → 排除）；
 *   ③ 剩下的题材按【早盘竞价股票总数】降序取前 2 个
 *      （用户举例：电子/通信/算力 10 只 → 第一；电力新能源 4 只 → 第二）；
 *   ④ 第 1 个题材（数量最多）：在【龙一 ~ 龙五】里挑【竞价高开】的两只 ——
 *      龙一【重仓】，另一只给【竞价涨幅最高】的那只【轻仓】（一字买不进，自动跳过）；
 *   ⑤ 第 2 个题材：只取【龙一】，【轻仓】（一字买不进时顺延到下一只）；
 *   ⑥ 一个题材都筛不出来 → 【空仓】并如实说明（§10）。
 *
 * @param {Array<object>} auctionBlocks 早盘竞价题材块（rankDecisionTopics 的返回）
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string,
 *          riskyTopics?:Array}} [opts]
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildSmallTopicPlan(auctionBlocks, dragonMap, opts) {
  const o = opts || {};
  const dragon = dragonMap || new Map();

  const out = {
    mode: 'smallTopic',
    qualified: false,
    emptyText: '',
    hintText: '题材股票数量过少（≤ ' + SMALL_TOPIC_MAX_COUNT + ' 只）却有 1~2 个竞价一字（疑似量化）→ ' +
      '不按常规规则选票，改看连板天梯「题材连扳」：只保留早盘竞价里股票数 ≥ ' +
      SMALL_TOPIC_MIN_AUCTION_COUNT + ' 只的题材，按股票数量取前二。',
    blocks: [],
    notes: []
  };

  const risky = o.riskyTopics || [];
  if (risky.length > 0) {
    out.notes.push(_note(RULE_NO.SMALL_TOPIC, '常规规则已跳过：' + risky.map(function(b) {
      return b.topic + '（' + b.count + '只 / ' + b.yiziCount + '个一字）';
    }).join('、') + ' —— 股票太少且有 1~2 个一字，疑似量化，准确率低'));
  }

  // §10：连板数据没加载 = 「还没拉到」，绝不等于「今天没有连板梯队」
  if (o.ladderReady === false) {
    out.emptyText = '连板天梯数据未就绪' + (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      '，无法按「小题材 + 一字」规则选票';
    return out;
  }

  // ① + ② 题材连扳候选 → 用早盘竞价股票总数过滤（< 4 只排除）
  const cands = [];
  (o.ladderTopicGroups || []).forEach(function(g) {
    if (!g || !g.topic || g.topic === OTHER) return;
    const blk = _findAuctionBlock(auctionBlocks, g.topic);
    if (!blk) return;
    const n = Number(blk.count) || 0;
    if (n < SMALL_TOPIC_MIN_AUCTION_COUNT) return;
    cands.push({ topic: g.topic, auctionCount: n, ladderCount: Number(g.count) || 0, block: blk });
  });
  if (cands.length === 0) {
    out.emptyText = '连板天梯「题材连扳」里没有「早盘竞价股票数 ≥ ' + SMALL_TOPIC_MIN_AUCTION_COUNT +
      ' 只」的题材，无法按「小题材 + 一字」规则选票 → 【空仓】';
    return out;
  }

  // ③ 按早盘竞价股票总数降序（同数 → 题材连扳数量降序 → 题材名），取前二
  cands.sort(function(a, b) {
    if (b.auctionCount !== a.auctionCount) return b.auctionCount - a.auctionCount;
    if (b.ladderCount !== a.ladderCount) return b.ladderCount - a.ladderCount;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });
  const winners = cands.slice(0, 2);
  if (winners.length > 1) {
    out.notes.push(_note(RULE_NO.SMALL_TOPIC, '题材连扳里按【早盘竞价股票数】排序：' + cands.map(function(c) {
      return c.topic + ' ' + c.auctionCount + '只';
    }).join('、')));
  }

  let totalPicks = 0;
  winners.forEach(function(w, idx) {
    const notes = [];
    let picks = [];
    if (idx === 0) {
      // ④ 数量最多的题材：龙一~龙五 里挑竞价高开的两只（龙一重仓 + 涨幅最高的一只轻仓）
      const r = pickTopDragonsByAuc(w.block, dragon, SMALL_TOPIC_MAX_RANK, SMALL_TOPIC_PICK_COUNT);
      picks = r.picks;
      if (picks.length === 0) {
        notes.push(_note(RULE_NO.SMALL_TOPIC,
          '龙一~龙五里没有「非一字 且 竞价高开」的股票 → 本题材不选票'));
      } else if (!r.dragonOneHighOpen) {
        notes.push(_note(RULE_NO.SMALL_TOPIC,
          '龙一未高开 → 【舍弃龙一】，只在龙二~龙五里按竞价涨幅取最高的 ' +
          picks.length + ' 只，都' + POSITION_LIGHT));
      }
      if (r.unknownCount > 0) {
        notes.push(_note(RULE_NO.SMALL_TOPIC,
          '另有 ' + r.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）'));
      }
    } else {
      // ⑤ 数量第二的题材：只取龙一，轻仓（一字买不进时由 pickBuyable 自动顺延）
      picks = pickBuyable(w.block, dragon, 1, POSITION_LIGHT);
      if (picks.length === 0) {
        notes.push(_note(RULE_NO.SMALL_TOPIC, '该题材没有可买的非一字股票 → 不选票'));
      }
    }

    totalPicks += picks.length;
    out.blocks.push({
      // [WEAK-OPEN 2026-09-27] members 必须带上：⑦⑧ 要在【早盘竞价题材块】的成员里数
      //   「竞价一字跌停 / 竞价高开」的只数。上一版这里只给了 count，members 缺失 ⇒
      //   `_applyWeakOpenRate` 走到 `members.length === 0` 直接 return ⇒ 弱势题材规则在
      //   兜底方案里【永远不生效】（9/11 农业 12 只 / 3 只高开 = 25% 却照常选出 2 只）。
      block: {
        topic: w.topic,
        rank: null,
        count: w.auctionCount,
        yiziCount: w.block.yiziCount || 0,
        members: w.block.members || []
      },
      rankWord: '',
      reason: idx === 0
        ? ('该题材在早盘竞价中股票数量最多（' + w.auctionCount + ' 只）　→ 根据规则' + RULE_NO.SMALL_TOPIC +
           '：在龙一~龙五里取竞价高开的两只 —— 龙一高开则龙一' + POSITION_HEAVY +
           ' + 竞价涨幅最高的一只' + POSITION_LIGHT +
           '；龙一不高开则舍弃龙一，取龙二~龙五里涨幅最高的两只，都' + POSITION_LIGHT)
        : ('该题材在早盘竞价中股票数量第二（' + w.auctionCount + ' 只）　→ 根据规则' + RULE_NO.SMALL_TOPIC +
           '：只取龙一，' + POSITION_LIGHT),
      mode: 'smallTopic',
      ruleNo: RULE_NO.SMALL_TOPIC,
      qualified: picks.length > 0,
      notQualifiedText: '',
      picks: picks,
      notes: notes
    });
  });

  out.qualified = totalPicks > 0;
  if (!out.qualified) {
    out.emptyText = '入选题材里没有可买的票 → 【空仓】';
  }
  return out;
}

/**
 * 【④ 低开龙一 · 文字提醒（2026-09-26 用户口径）】
 *
 * 用户原话：龙一如果【低开】，要自己去观察它的【竞价图形】是不是【跌停 L 形】；
 *   是 L 形就【尾盘买】。（9/3 捷荣技术就是这种情形）
 * ⚠️ 竞价图形本看板拿不到（没有分时数据），所以这里【只加提醒文字】，⛔ 不改任何选票结果与仓位。
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
    if (m && m.name) aucOf.set(m.name, m.aucPct);
  });
  blockObj.picks.forEach(function(p) {
    const n = _num(aucOf.get(p.name));
    p.aucPctText = formatAucPct(n);
    p.aucTone = getAucOpenKind(n) || '';
  });
  return blockObj;
}

/**
 * 【一 · 亏钱效应】本行是不是【竞价一字跌停】（9:25 集合竞价报价就打在跌停价上）。
 *
 * ══ 口径（2026-09-27 用户最终确认）══
 *   这是早盘竞价看板上【股票名下方那条绿色实线】的股票 —— 与「竞价一字（涨停）」的红线严格对应，
 *   都是 9:25 那一刻就能确定的事实，所以这条规则可以放心用于【早上做决策】。
 *
 * ⛔ 曾误加过【收盘跌停】判据并被用户否掉：2026-09-10 泸天化竞价 -7.69%（没到跌停）、收盘 -10.00%，
 *   加了收盘判据会让 9/10 触发；但用户是【早上看盘做决策】的，收盘数据当时根本不存在，
 *   而且这类规则一加就会让「复盘日」大面积误触发 ⇒ 最终只保留竞价这一档。
 *   （9/10 因此会回到选出 3 只的常规结果 —— 这是正确结果，不是 bug。）
 *
 * 判定复用 limit-up.js#getAuctionLimitState（涨跌停看板同一份，§6 不另写阈值）；
 * §10：竞价涨幅缺失 → false（不是跌停，也不是不跌停，只是不知道）。
 */
function _isAuctionDianTing(m) {
  const auc = _num(m && m.aucPct);
  if (auc === null) return false;
  return getAuctionLimitState(auc, (m && m.code) || '', (m && m.name) || '') === 'down';
}

/**
 * 两条「砍成龙一轻仓」规则的统一收口：只留龙一，仓位改成轻仓，理由写进 notes。
 * @param {object} blockObj 买点块
 * @param {string} reasonNote 为什么砍（含具体数字 / 股票名，用户能直接核对）
 */
function _collapseToDragonOneLight(blockObj, reasonNote) {
  const picks = blockObj.picks || [];
  blockObj.notes = blockObj.notes || [];
  if (picks.length === 0) {
    blockObj.notes.push(reasonNote + ' → 本档不买');
    return blockObj;
  }
  const keep = picks.find(function(p) { return p.dragonRank === 1; }) || picks[0];
  blockObj.picks = _reseq([Object.assign({}, keep, { position: POSITION_LIGHT })]);
  blockObj.notes.push(reasonNote + ' → 【只买龙一】，且' + POSITION_LIGHT);
  return blockObj;
}

/**
 * 【一 · 亏钱效应（2026-09-27 用户口径）】
 *   入选题材在【早盘竞价】里只要有【≥ LOSS_EFFECT_MIN_DIAN_TING 只竞价一字跌停】
 *   ⇒ 题材内部出现亏钱效应 ⇒ 【只买龙一】，且【只轻仓】（题材 > 10 只 / < 10 只都一样）。
 *   9/11 农业 12 只：中粮科技竞价 -10.00%（= 早盘竞价里的绿色实线）→ 只买敦煌种业（龙一、轻仓）。
 * ⛔ 只砍票、不改排名：龙一还是那个龙一，只是不重仓、不补第二只。
 */
function _applyLossEffect(blockObj) {
  if (!blockObj || !blockObj.block) return blockObj;
  const members = blockObj.block.members || [];
  const hits = [];
  members.forEach(function(m) { if (_isAuctionDianTing(m)) hits.push(m.name); });
  if (hits.length < LOSS_EFFECT_MIN_DIAN_TING) return blockObj;
  return _collapseToDragonOneLight(blockObj,
    _note(RULE_NO.LOSS_EFFECT, '该题材有 ' + hits.length + ' 只【竞价一字跌停】' + hits.join('、') +
      '（亏钱效应；题材共 ' + (Number(blockObj.block.count) || 0) + ' 只）'));
}

/**
 * 【竞价高开率 · 唯一实现（§6）】⑧ 弱势题材与 ⑨ 双主线竞争都用它，⛔ 不各写一份。
 *
 * 口径（2026-09-27 定稿）：
 *   · 分母 = 【题材股票总数 block.count】，⛔ 不是「有竞价涨幅数据的行数」；
 *   · 分子 = 成员里【竞价涨幅 > 0】的只数（判定复用 ladder-rules#getAucOpenKind，§6）；
 *   · 缺竞价涨幅的行【按未高开】计入分母 —— 9:25 看不到它高开，就不能把它算进题材强度（§10 不猜）。
 *
 * ⛔ 为什么分母必须是总数（事故复盘）：上一版用「有数据的行数」当分母，灰行（观察组 / 昨日龙头
 *    继承壳）在很多日期拿不到 auc_pct_chg ⇒ 12 只的题材分母被缩成 7 只，3 只高开算成 43%（≥35%）
 *    ⇒ 规则不触发。用户口径是「12 只里只有 3 只高开 = 25%」，看的正是题材总数那一档。
 *
 * @param {object} block 题材块（rankDecisionTopics 的元素：{count, members}）
 * @returns {{total:number, highCount:number, knownCount:number, unknownCount:number,
 *            rate:number|null}} rate = null ⇒ 高开率【未知】（一只都没有竞价涨幅，§10 不猜）
 */
function _calcOpenRate(block) {
  const total = Number(block && block.count) || 0;
  const members = (block && block.members) || [];
  let highCount = 0;
  let knownCount = 0;
  let unknownCount = 0;
  members.forEach(function(m) {
    const kind = getAucOpenKind(_num(m && m.aucPct));
    if (kind === null) { unknownCount++; return; }
    knownCount++;
    if (kind === AUC_OPEN_HIGH) highCount++;
  });
  return {
    total: total,
    highCount: highCount,
    knownCount: knownCount,
    unknownCount: unknownCount,
    rate: (knownCount === 0 || total <= 0) ? null : (highCount / total)
  };
}

/** 高开率 → 「n 只 = p%（x/y）」的可核对文案（⑧ ⑨ 共用，⛔ 不各处拼字符串） */
function _openRateText(r) {
  const base = '竞价高开 ' + r.highCount + '/' + r.total + ' 只 = ' + Math.round(r.rate * 100) + '%';
  return r.unknownCount > 0
    ? base + '（另 ' + r.unknownCount + ' 只缺竞价涨幅，按未高开计入分母，§10 不猜）'
    : base;
}

/**
 * 【⑧ 弱势题材（2026-09-27 用户口径）】题材越大却【没人高开】⇒ 题材是虚胖的，别重仓铺票：
 *   入选题材【股票总数 > WEAK_OPEN_MIN_COUNT(10) 只】且【竞价高开的股票占比 < WEAK_OPEN_RATE(35%)】
 *   ⇒ 【只买龙一】，且【只轻仓】。
 *
 *   用户原话换算的两个锚点：
 *     · 10 只里只有 3 只竞价高开（3/10 = 30% < 35%）→ 只买龙一轻仓；
 *     · 12 只里只有 3 只竞价高开（3/12 = 25% < 35%）→ 只买龙一轻仓（这就是 9/11 农业的情形）。
 *
 * ⛔ 只在【总数 > 10 只】时生效 —— ≤ 10 只由 ⑩「买入只数」（最多 1 / 2 只）管，
 *    两条规则刻意不重叠，避免同一题材被扣两次。
 * ⛔ 「高开」判定复用 ladder-rules#getAucOpenKind（连板天梯唯一的开平实现，§6）：> 0 = 高开，
 *    竞价涨幅缺失的行【不算高开】（§10 缺数据 ≠ 高开），但会在说明里如实报「几只缺竞价涨幅」。
 */
function _applyWeakOpenRate(blockObj) {
  if (!blockObj || !blockObj.block) return blockObj;
  const block = blockObj.block;
  const total = Number(block.count) || 0;
  // ⛔ 只在【总数 > WEAK_OPEN_MIN_COUNT】时生效 —— ≤ 10 只由「买入只数」管，两条不重叠
  if (total <= WEAK_OPEN_MIN_COUNT || (block.members || []).length === 0) return blockObj;

  const r = _calcOpenRate(block);

  // §10 红线：一只都没有竞价涨幅 ⇒ 「高开率」是未知，既不能算高也不能算低 ⇒ 不触发，如实说明
  if (r.rate === null) {
    blockObj.notes = blockObj.notes || [];
    blockObj.notes.push(_note(RULE_NO.WEAK_OPEN,
      '题材共 ' + total + ' 只，但全部缺竞价涨幅 → 无法判定竞价高开率，本条【不生效】（§10 不猜）'));
    return blockObj;
  }

  const base = '题材共 ' + total + ' 只，' + _openRateText(r);
  // 没触发也把高开率写出来 —— 用户能直接核对「为什么还是常规档位」，不用猜
  if (r.rate >= WEAK_OPEN_RATE) {
    blockObj.notes = blockObj.notes || [];
    blockObj.notes.push(_note(RULE_NO.WEAK_OPEN,
      base + ' ≥ ' + Math.round(WEAK_OPEN_RATE * 100) + '% → 高开率正常，本条不生效'));
    return blockObj;
  }
  return _collapseToDragonOneLight(blockObj,
    _note(RULE_NO.WEAK_OPEN, base + ' < ' + Math.round(WEAK_OPEN_RATE * 100) +
      '% → 题材虚胖（大部分票都不高开）'));
}

/**
 * 【⑨ 双主线竞争（2026-09-27 用户口径）】
 *
 * 场景：当日【第 1 名】与【第 2 名】题材【都 ≥ DUAL_MAIN_MIN_COUNT(10) 只】—— 两个大容量题材并存，
 *   在大盘缩量的日子里它们是在【抢同一条主线】，用户的判断是【只有一个能活下来】。
 *   ⇒ ⛔ 不按 ① / ②（按一字数选题材）走，改为直接比两个题材的【竞价高开率】：
 *        · 高开率【高】的那个题材 → 它的【龙一】【重仓】，只选 1 只；
 *        · 高开率【低】的那个题材 → 它的【龙一】【轻仓】，只选 1 只。
 *
 * 用户给的锚点（9/10）：
 *   农业 11 只、竞价高开 5 只 = 45% < 大消费 10 只、竞价高开 8 只 = 80%
 *   ⇒ 大消费龙一国芳集团【重仓】，农业龙一敦煌种业【轻仓】。
 *
 * ⛔ 只选【龙一】各 1 只，不再补第二只（大容量题材并存时铺票等于两边下注，违背「只有一个能活下来」）。
 * ⛔ 高开率口径复用 _calcOpenRate（与 ⑧ 同一份实现，§6）：分母 = 题材股票总数，
 *    缺竞价涨幅的行按【未高开】计入分母（§10 不猜）。
 * ⛔ 龙一是一字（买不进）时按龙头顺序顺延 —— 复用 pickBuyable，⛔ 不另写一遍跳过逻辑。
 *
 * §10 红线：任一个题材【一只都没有竞价涨幅】⇒ 高开率未知 ⇒ 【无从比较】⇒ 本条不触发
 *   （返回 null，由调用方退回 ①~④ 的常规档位），绝不拿 0% 去和其它题材比。
 *   高开率【完全相同】时维持原排名（第 1 名胜出），并在说明里如实写「两者相同」。
 *
 * @param {object} first 第 1 名题材块
 * @param {object} second 第 2 名题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {{winner:object, loser:object, topNotes:string[]}|null} null = 本条不适用
 */
export function buildDualMainPlan(first, second, dragonMap) {
  if (!first || !second) return null;
  const ca = Number(first.count) || 0;
  const cb = Number(second.count) || 0;
  // ① 两个题材【都】要 ≥ DUAL_MAIN_MIN_COUNT 只才算「双主线并存」
  if (ca < DUAL_MAIN_MIN_COUNT || cb < DUAL_MAIN_MIN_COUNT) return null;

  const ra = _calcOpenRate(first);
  const rb = _calcOpenRate(second);
  // §10：高开率未知 ⇒ 无从比较 ⇒ 不适用（绝不拿 null 当 0% 去比）
  if (ra.rate === null || rb.rate === null) return null;

  const isSecondWin = rb.rate > ra.rate;                 // 严格大于才换手；相等 → 维持原排名
  const winner = isSecondWin ? second : first;
  const loser = isSecondWin ? first : second;
  const rw = isSecondWin ? rb : ra;
  const rl = isSecondWin ? ra : rb;

  const rateTextW = _openRateText(rw);
  const rateTextL = _openRateText(rl);
  const why = '两个题材都 ≥ ' + DUAL_MAIN_MIN_COUNT + ' 只（' + winner.topic + ' ' + winner.count +
    ' 只 / ' + loser.topic + ' ' + loser.count + ' 只）→ 只有一个能活下来，比【竞价高开率】：' +
    winner.topic + ' ' + rateTextW + '　＞　' + loser.topic + ' ' + rateTextL;
  const tieNote = (ra.rate === rb.rate)
    ? '（两者高开率【完全相同】，按题材排名维持第 1 名「' + winner.topic + '」为重仓）'
    : '';

  const mkBlock = function(block, position, isWinner) {
    const picks = pickBuyable(block, dragonMap, 1, position);
    const notes = [];
    if (picks.length === 0) notes.push(_note(RULE_NO.DUAL_MAIN, '该题材没有可买的非一字股票 → 本档不买'));
    return {
      block: block,
      rankWord: _rankWord(block.rank),
      // 说明文字【必须带规则编号】（2026-09-27 用户口径：像法律条文一样能查出处）
      reason: _reasonBuy(block, _rankWord(block.rank)) +
        '　→ 根据规则' + RULE_NO.DUAL_MAIN + '：' +
        (isWinner ? '竞价高开率更高（' + rateTextW + '）' : '竞价高开率更低（' + rateTextL + '）') +
        ' → 只选龙一 1 只，' + position,
      mode: 'dualMain',
      ruleNo: RULE_NO.DUAL_MAIN,
      qualified: picks.length > 0,
      notQualifiedText: '',
      picks: picks,
      notes: notes
    };
  };

  return {
    winner: mkBlock(winner, POSITION_HEAVY, true),
    loser: mkBlock(loser, POSITION_LIGHT, false),
    topNotes: [_note(RULE_NO.DUAL_MAIN, why + tieNote + ' ⇒ 高者龙一' + POSITION_HEAVY +
      '、低者龙一' + POSITION_LIGHT + '，各【只选 1 只】')]
  };
}

/**
 * 【二 · 买入只数（2026-09-27 用户口径）】第 1 名题材按【早盘竞价题材股票数】限制买几只：
 *   · ≤ BUY_COUNT_MAX_SMALL(6) 只 → 最多 1 只（9/18 AI应用 6 只）；
 *   · ≤ BUY_COUNT_MAX_MID(10) 只  → 最多 2 只（9/21 电子/通信/算力）；
 *   · > 10 只                     → 按原规则（≥2 一字可取 2~3 只；1 一字可重仓 + 龙二~龙五高开轻仓）。
 * ⛔ 只砍后面的票，龙一 / 最靠前的那只一定保留。
 */
function _capPicksByTopicCount(blockObj) {
  if (!blockObj || !blockObj.block || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const c = Number(blockObj.block.count) || 0;
  let max = 0;
  if (c > 0 && c <= BUY_COUNT_MAX_SMALL) max = 1;
  else if (c <= BUY_COUNT_MAX_MID) max = 2;
  if (max === 0 || blockObj.picks.length <= max) return blockObj;   // > 10 只 → 原规则
  const cut = blockObj.picks.length - max;
  blockObj.picks = _reseq(blockObj.picks.slice(0, max));
  blockObj.notes = blockObj.notes || [];
  blockObj.notes.push(_note(RULE_NO.BUY_COUNT, '题材股票数量 ' + c + ' 只（≤ ' + max +
    ' 只档）→ 最多买 ' + max + ' 只，砍掉后面 ' + cut + ' 只'));
  return blockObj;
}

/**
 * 【三 · 持有 / 加仓标记（2026-09-27 用户口径）】
 *   上一交易日在【买点】里、今天又在买点里 ⇒ 强势股 ⇒ 标记【持有 / 加仓】。
 *   §10：前一天的数据没算出来（null）→ 不标记（绝不当成「昨天没选中」）。
 */
function _markHold(blockObj, prevBuyNames) {
  if (!blockObj || !prevBuyNames || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const hits = [];
  blockObj.picks.forEach(function(p) {
    if (prevBuyNames.has(p.name)) {
      p.holdTag = HOLD_TAG;
      hits.push(p.name);
    }
  });
  if (hits.length > 0) {
    blockObj.notes = blockObj.notes || [];
    blockObj.notes.push(_note(RULE_NO.HOLD,
      '【' + hits.join('、') + '】上一个交易日也在买点里 → 强势股，可【' + HOLD_TAG + '】'));
  }
  return blockObj;
}

/**
 * 【⑫ 昨天已买 · 股票级效果（2026-09-30 用户口径，同日两次修正）】
 *   该【股票】在上一交易日被打过「买」标签 ⇒ 用户手上已经有仓位
 *   ⇒ 仓位文案由「重仓 / 轻仓」改写【加仓】。
 *
 * ⛔ 只按【股票名】逐个判，绝不按题材判 —— 见 PREV_BOUGHT_TAG 上方的事故记录：
 *    按题材判会把「题材里有一只买过」误读成「这一整块都买过」（9/30 大亚圣象 vs 新华文轩）。
 * ⛔ 卖点侧【不标也不改仓位】：卖点候选本身就是「昨天打过买标签的股票」，标了等于全标。
 * §10：集合为 null（昨天的标签没读到）→ 一律不标、仓位也【不改】（未知 ≠ 昨天没买）。
 *
 * ⚠️ 仓位改写对【重仓 / 轻仓】一视同仁（2026-09-30 用户明确选择）：
 *    「重仓 / 轻仓」是【建多少仓】的口径；既然昨天已经买了，今天这一笔的动作就是【加仓】，
 *    再写「重仓」会让人以为还要重新建仓。所以一律换文案，⛔ 不是并列追加。
 *    ⇒ 因此这个函数必须在所有会改仓位的收口之后调用（见 _finishBuyBlock 的顺序注释）。
 *
 * ⚠️ [TOPIC-PREV-BOUGHT 2026-09-30 第三版] 行内【昨天已买】徽标已经从【股票行】撤掉，
 *    改到【题材行】显示（文案改为【昨有买入】，见 _markTopicPrevBought）。
 *    这里保留 p.prevBoughtTag 只作为【加仓的判据留痕】（说明文字 / 回归测试要用），
 *    ⛔ 组件里【不再渲染】它 —— 想让用户看见个股级信息，看行尾的【加仓】即可。
 *
 * @param {object} blockObj 买点块（_finishBuyBlock / _finishPlanBlocks 的收口对象）
 * @param {Set<string>|null} prevBoughtNames 上一交易日打过「买」标签的股票名集合
 */
function _markPrevBought(blockObj, prevBoughtNames) {
  if (!blockObj || !prevBoughtNames || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const hits = [];
  blockObj.picks.forEach(function(p) {
    if (prevBoughtNames.has(p.name)) {
      p.prevBoughtTag = PREV_BOUGHT_TAG;      // 留痕（⛔ 不渲染）；加仓的判据
      p.position = POSITION_ADD;
      hits.push(p.name);
    }
  });
  if (hits.length > 0) {
    blockObj.notes = blockObj.notes || [];
    blockObj.notes.push(_note(RULE_NO.PREV_BOUGHT,
      '【' + hits.join('、') + '】' + PREV_BOUGHT_TAG + '（被打过「买」标签）→ 行尾仓位改标【' +
      POSITION_ADD + '】（昨天已有仓位，今天是往上加，不重新建仓）'));
  }
  return blockObj;
}

/**
 * 【⑫ 题材级 · 昨有买入（TOPIC-PREV-BOUGHT 2026-09-30 用户口径）】
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
 * 【⑬ 题材入选次数（TOPIC-STREAK 2026-09-30 用户口径）】
 *   题材行（竞价一字右边）标【一次入选 / 二次入选 / …】=「含今日在内的最近 5 个交易日」
 *   里该题材进过买点几次（用户口径：这样就知道频率）。
 *
 * 口径：
 *   · 只数【重仓 / 轻仓】两个主买点块 —— 所以本函数只在 _finishBuyBlock（heavy / light / 双主线）里调，
 *     ⛔ 不在 _finishPlanBlocks（弱市兜底方案 ⑤⑥）里调；
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
 * 【⑫ 仓位配色档】逐只把 position 映射成 tone，供模板直接拼接类名（§21 模板零计算）。
 * ⛔ 必须排在 _markPrevBought 之后 —— 它会改写 position 文案，先派生会拿到旧的「轻仓」档。
 */
function _decoratePositionTone(blockObj) {
  if (!blockObj || !blockObj.picks) return blockObj;
  blockObj.picks.forEach(function(p) { p.positionTone = positionToneOf(p.position); });
  return blockObj;
}

/**
 * 买点块的统一收口（⛔ 顺序固定，互不干扰）：
 *   亏钱效应 → 弱势题材（高开率）→ 只数限制 → 持有标记 → 昨天已买（会改 position）
 *   → 题材行标记（昨有买入 ⑫ / 入选次数 ⑬）→ 仓位配色档（必须在其后）→ 竞价涨幅徽标（必须最后）
 */
function _finishBuyBlock(blockObj, opts) {
  _applyLossEffect(blockObj);
  _applyWeakOpenRate(blockObj);
  _capPicksByTopicCount(blockObj);
  _markHold(blockObj, opts ? opts.prevBuyNames : null);
  _markPrevBought(blockObj, opts ? opts.prevBoughtNames : null);
  // ⚠️ 题材行标记与上面的个股标记互不干扰（一个写 blockObj.*，一个写 pick.*），先后无所谓
  _markTopicPrevBought(blockObj, opts ? opts.prevBoughtTopics : null);
  _markTopicStreak(blockObj, opts ? opts.topicStreakPast : null);
  _decoratePositionTone(blockObj);
  // ⛔ 徽标必须【最后】派生：上面的砍票 / 改仓会重建 picks 数组，先派生会被丢掉
  _decorateAucBadge(blockObj);
  return blockObj;
}

/**
 * 兜底方案（无一字 / 小题材 / 大题材）的统一收口：逐块走【亏钱效应 + 弱势题材 + 持有标记】。
 * ⛔ 这类方案【不走】_capPicksByTopicCount —— 用户口径「买入只数」只针对【第 1 名题材】
 *    （①②③④ 的常规档位），兜底方案本来就只取 1~2 只，再砍一次反而会空仓。
 *
 * [WEAK-OPEN 2026-09-27] ⑧ 弱势题材【必须在这里也走一遍】——
 *   事故：9/11 农业 12 只、只有 3 只竞价高开（25% < 35%），用户预期「只选龙一敦煌种业轻仓」，
 *   实际却选出了 2 只（敦煌种业 + 新农开发）。根因不是阈值、也不是分母：
 *     当天【第 1 名题材 = 电力新能源（4 只 / 1 个一字）】命中「小题材高风险」，
 *     buildBuyPlan 直接走 ⑥ 兜底方案（smallTopic），由「题材连扳里数量最多」挑中了农业，
 *     而兜底方案走的是 _finishPlanBlocks —— 上一版这里【只调 _applyLossEffect】，
 *     压根没调 _applyWeakOpenRate ⇒ ⑧ 在这条链路上从未生效过。
 *   ⛔ 规则是「入选题材」的筛选条件，与它是被哪条规则选中的无关 —— 必须对所有买点块一视同仁。
 */
function _finishPlanBlocks(planObj, opts) {
  if (!planObj || !planObj.blocks) return planObj;
  planObj.blocks.forEach(function(b) {
    _applyLossEffect(b);
    _applyWeakOpenRate(b);
    _markHold(b, opts ? opts.prevBuyNames : null);
    _markPrevBought(b, opts ? opts.prevBoughtNames : null);
    // [⑫ 题材级] 兜底方案的题材行同样标【昨有买入】—— 与「入选题材的筛选条件一视同仁」同一口径：
    //   它说的是「这个题材昨天有票买过」，跟这个题材是被哪条规则选中的无关。
    _markTopicPrevBought(b, opts ? opts.prevBoughtTopics : null);
    // ⛔ [⑬ 入选次数] 【刻意不在这里标】：用户口径是【只数重仓 / 轻仓两个主买点块】，
    //    兜底方案（⑤⑥）出现的题材不计入次数 —— 标了就会与次数的定义自相矛盾。
    _decoratePositionTone(b);      // ⛔ 必须在 _markPrevBought 之后（它会改写 position 文案）
    _decorateAucBadge(b);          // 同上：徽标放最后，避免被上面的砍票重建 picks 时丢掉
  });
  return planObj;
}

/**
 * 【⑤ 第 2 名题材 · 与「连板天梯数量第一题材」比早盘竞价股票数（2026-09-26 用户口径）】
 *
 * 第 2 名题材（只有 1 个竞价一字）选票前，先做一次【题材替换】：
 *   ① 取【连板天梯 · 题材连扳】里【股票数量最多】的题材；
 *   ② 拿它回【早盘竞价】找同名题材块，比较两者的【早盘竞价股票数量】；
 *   ③ 谁的数量多就选谁；天梯那边更多 → 改成选天梯第一那个题材，仍按原规则选票。
 *      例（9/3）：第 2 名 = 大消费 7 只；天梯第一 = AI应用 4 只 → 回早盘竞价比：
 *      大消费 7 ＜ AI应用 10 ⇒ 改选 AI应用（若 AI应用 更少则沿用原规则）。
 *   ⛔【同题材不重复入选（2026-09-26 用户口径）】若天梯第一的题材【已经】被前面的档位选中了
 *     （9/8：第 1 名是大消费，天梯第一也还是大消费），这次对比【没有价值】→ 不做替换，
 *     回到原来的第 2 名题材（农业）选龙一轻仓。
 * §10：连板天梯未就绪 → 如实说明「未做对比」，沿用原规则（绝不猜）。
 *
 * @param {Array} blocks 早盘竞价题材块（rankDecisionTopics 的返回）
 * @param {object} second 第 2 名题材块
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string}} opts
 * @param {Array<string>} [excludeTopics] 已经入选的题材名（⛔ 不允许重复出现在买点里）
 * @returns {{block:object|null, notes:string[], replaced:boolean}}
 */
export function resolveSecondTopicByLadder(blocks, second, opts, excludeTopics) {
  const o = opts || {};
  const notes = [];
  const used = new Set((excludeTopics || []).filter(Boolean).map(function(t) { return String(t).trim(); }));
  if (!second) return { block: null, notes: notes, replaced: false };
  if (o.ladderReady === false) {
    notes.push(_note(RULE_NO.SECOND, '连板天梯数据未就绪' +
      (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      ' → 未做「题材数量对比」，沿用第 2 名题材（§10 不猜）'));
    return { block: second, notes: notes, replaced: false };
  }
  const groups = (o.ladderTopicGroups || []).filter(function(g) {
    return g && g.topic && g.topic !== OTHER && (Number(g.count) || 0) > 0;
  });
  if (groups.length === 0) return { block: second, notes: notes, replaced: false };

  let top = null;
  groups.forEach(function(g) {
    if (!top || (Number(g.count) || 0) > (Number(top.count) || 0)) top = g;
    else if ((Number(g.count) || 0) === (Number(top.count) || 0) &&
             String(g.topic) < String(top.topic)) top = g;      // 并列 → 题材名稳定
  });
  if (!top || String(top.topic).trim() === String(second.topic).trim()) {
    return { block: second, notes: notes, replaced: false };
  }
  // ⛔ 同题材不重复入选：天梯第一的题材已经在买点里了 → 这次对比没有价值，不做替换
  if (used.has(String(top.topic).trim())) {
    notes.push(_note(RULE_NO.SECOND, '连板天梯里数量最多的题材「' + top.topic +
      '」【已经在买点里了】→ 同题材不重复入选，本次对比无意义，沿用第 2 名题材「' + second.topic + '」'));
    return { block: second, notes: notes, replaced: false };
  }
  const blk = _findAuctionBlock(blocks, top.topic);
  if (!blk) {
    notes.push(_note(RULE_NO.SECOND, '连板天梯里数量最多的题材「' + top.topic +
      '」在早盘竞价里没有同名题材 → 不做替换'));
    return { block: second, notes: notes, replaced: false };
  }
  if (blk.count <= second.count) {
    notes.push(_note(RULE_NO.SECOND, '已与连板天梯数量最多的题材「' + top.topic + '」对比早盘竞价股票数：' +
      '本题材 ' + second.count + ' 只 ≥ ' + top.topic + ' ' + blk.count + ' 只 → 沿用本题材'));
    return { block: second, notes: notes, replaced: false };
  }
  notes.push(_note(RULE_NO.SECOND, '连板天梯里数量最多的题材是「' + top.topic + '」（' + top.count + ' 只）；' +
    '回到早盘竞价比股票数：' + top.topic + ' ' + blk.count + ' 只 ＞ 本题材「' + second.topic +
    '」' + second.count + ' 只 → 改选【' + top.topic + '】'));
  return { block: blk, notes: notes, replaced: true };
}

/**
 * 【⑥ 无一字 · 大题材兜底（2026-09-26 用户口径）】
 *
 * 触发：当日【全部题材竞价一字 = 0】，且第 1 / 第 2 名题材里有【股票数量 ≥ BIG_TOPIC_MIN_COUNT 只】的。
 * 选票：每个满足的大题材只取【龙一】一只，【轻仓】（没有一字，强度打折）。
 * ⛔ 这是【新增】的一条并列规则：原来的「题材连扳不足 3 只 → 空仓」保持不变，
 *    只是当大题材条件成立时【优先】走这里（9/4：电子/通信/算力 17 只、AI应用 10 只 → 各取龙一）。
 *
 * @param {Array<object>} bigBlocks 满足数量门槛的题材块（第 1 / 第 2 名里筛出来的）
 * @param {Map} dragonMap 龙头排名
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildBigTopicPlan(bigBlocks, dragonMap) {
  const out = {
    mode: 'bigTopic',
    qualified: false,
    emptyText: '',
    hintText: '当日全部题材【竞价一字 0 个】，但第 1 / 第 2 名题材里有【股票数量 ≥ ' +
      BIG_TOPIC_MIN_COUNT + ' 只】的大题材 → 改选这些大题材的【龙一】（' + POSITION_LIGHT + '）',
    blocks: [],
    notes: []
  };
  let totalPicks = 0;
  (bigBlocks || []).forEach(function(b) {
    const picks = pickBuyable(b, dragonMap, 1, POSITION_LIGHT);
    const notes = [];
    if (picks.length === 0) notes.push(_note(RULE_NO.NO_YIZI, '该题材没有可买的非一字股票 → 不选票'));
    totalPicks += picks.length;
    const obj = {
      block: b,
      rankWord: '',
      reason: '该题材在早盘竞价里有 ' + b.count + ' 只（≥ ' + BIG_TOPIC_MIN_COUNT +
        ' 只），当日无竞价一字　→ 根据规则' + RULE_NO.NO_YIZI + '：只取龙一，' + POSITION_LIGHT,
      mode: 'bigTopic',
      ruleNo: RULE_NO.NO_YIZI,
      qualified: picks.length > 0,
      notQualifiedText: '',
      picks: picks,
      notes: notes
    };
    _appendLowOpenDragonOneNote(obj);
    out.blocks.push(obj);
  });
  out.qualified = totalPicks > 0;
  if (!out.qualified) out.emptyText = '大题材里没有可买的票 → 【空仓】';
  return out;
}

/**
 * 生成买点计划。
 * @param {Array} blocks rankDecisionTopics 的返回
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string,
 *          prevBuyNames?:Set<string>|null, prevBoughtNames?:Set<string>|null,
 *          prevBoughtTopics?:Set<string>|null, topicStreakPast?:Map<string,number>|null}} [opts]
 *        【无一字兜底】要用的连板天梯「题材连扳」分组（只有「全部题材一字 = 0」时才用得上；
 *        由 decision-collect 采集后传进来，本文件保持纯函数、不碰数据源）
 *        ⓘ 龙一 / 龙二的排名人群用的是 blocks 自身（早盘竞价题材组），无需额外传参
 *        prevBuyNames = 【上一个交易日】买点里的股票名集合；
 *          null / 不传 = 昨天的买点没算出来（§10：未知 ≠ 昨天没选中）→ 一律【不标持有】
 *        prevBoughtNames = 【上一个交易日】打过「买」标签的股票名集合（用户【实际】买了的）；
 *          null / 不传 = 昨天的标签没读到（§10：未知 ≠ 昨天没买）→ 一律【不标昨天已买】。
 *          ⛔ 它是【股票级】判据（逐只比名字），落成行尾的【加仓】。
 *        prevBoughtTopics = 【题材级】判据：昨天买过的票【今天】落在哪些题材里（§6：与看板显示的
 *          题材同一份映射）。命中 ⇒ 题材行标【昨有买入】。null / 不传 = 未知 → 不标。
 *        topicStreakPast = 题材名 → 过去（不含今日）窗口内进入买点的次数（只数重仓 / 轻仓块）；
 *          命中 ⇒ 题材行标【N 次入选】（次数 = 本值 + 1）。null / 不传 = 窗口内有历史日算不出来
 *          → 一律不标（§10：⛔ 不用偏低的次数冒充真实频率）。
 * @returns {{heavy:object|null, light:object|null, noYizi:object|null, smallTopic:object|null}}
 *          heavy = 第 1 名题材的方案；light = 第 2 名题材的方案；
 *          noYizi = 「全部题材竞价一字 = 0」时的弱市兜底方案；
 *          smallTopic = 「第 1 / 第 2 名题材票太少却有 1~2 个一字」时的兜底方案（⑥）。
 *          四者互斥：noYizi / smallTopic 任一非空时，heavy 与 light 必为 null。
 *          qualified=false 表示「未达一字门槛 / 太弱」——仍然展示题材与数字（§10 如实呈现），
 *          但 ⛔ 不给出买入建议（picks 为空），绝不拿不够格的数据冒充有效信号。
 */
export function buildBuyPlan(blocks, dragonMap, opts) {
  const list = blocks || [];
  const first = list.find(function(b) { return b.rank === 1; }) || null;
  const second = list.find(function(b) { return b.rank === 2; }) || null;
  const o = opts || {};

  // [SMALL-TOPIC 2026-09-25] 第 1 / 第 2 名题材是「票太少 + 有 1~2 个一字」的高风险小题材
  //   ⇒ 常规规则准确率低，【不用常规规则】，改走 ⑥（题材连扳 + 早盘竞价股票数 ≥ 4 只过滤）。
  //   ⛔ 即使连板天梯未就绪也【不退回】常规规则 —— 用户明确说这种情况下常规规则不符合，
  //      退回等于又给一次错误的建议；如实报「未就绪」（§10）。
  const risky = [];
  if (isSmallRiskyTopic(first)) risky.push(first);
  if (isSmallRiskyTopic(second)) risky.push(second);
  if (risky.length > 0) {
    return {
      heavy: null,
      light: null,
      noYizi: null,
      bigTopic: null,
      // 【一 亏钱效应 / 三 持有标记】兜底方案的每个子块同样收口（⛔ 不套用「只数」限制）
      smallTopic: _finishPlanBlocks(buildSmallTopicPlan(list, dragonMap, {
        ladderTopicGroups: o.ladderTopicGroups || [],
        ladderReady: o.ladderReady,
        ladderReason: o.ladderReason,
        riskyTopics: risky
      }), o)
    };
  }

  // [NO-YIZI 2026-09-25] 当日【所有题材】都没有竞价一字 → 弱市，改走「连板天梯 · 题材连扳」兜底规则。
  // ⛔ 判据是【全部题材的一字总数】，不是「第 1 名题材的一字数」：
  //    用户原话是「当天所有的题材都没有一字涨停的股票时」。
  const totalYizi = list.reduce(function(n, b) { return n + (Number(b.yiziCount) || 0); }, 0);
  if (list.length > 0 && totalYizi === 0) {
    // [BIG-TOPIC 2026-09-26] 新增的并列规则【优先】：第 1 / 第 2 名题材里有【股票数 ≥ 10 只】的
    //   大题材 → 选这些大题材的龙一（轻仓）。不满足才回到原来的「题材连扳 / 空仓」。
    const bigs = [first, second].filter(function(b) {
      return b && (Number(b.count) || 0) >= BIG_TOPIC_MIN_COUNT;
    });
    if (bigs.length > 0) {
      return {
        heavy: null,
        light: null,
        noYizi: null,
        smallTopic: null,
        bigTopic: _finishPlanBlocks(buildBigTopicPlan(bigs, dragonMap), o)
      };
    }
    return {
      heavy: null,
      light: null,
      smallTopic: null,
      bigTopic: null,
      noYizi: _finishPlanBlocks(buildNoYiziPlan(o.ladderTopicGroups || [], {
        dragonMap: dragonMap,
        ladderReady: o.ladderReady,
        ladderReason: o.ladderReason,
        // 龙一 / 龙二的排名人群 = 早盘竞价题材组（blocks 自身），⛔ 不是「题材连扳」的子集
        auctionTopicBlocks: list
      }), o)
    };
  }

  // [DUAL-MAIN 2026-09-27] ⑨【双主线竞争】第 1 / 第 2 名题材【都 ≥ 10 只】→ 两个大容量题材在抢主线，
  //   【只有一个能活下来】⇒ 不看 ①~④，改比【竞价高开率】：高者龙一重仓、低者龙一轻仓，各 1 只。
  //   ⛔ 放在「全部题材无一字」之后：0 一字 = 弱市，没有主线可争，那日子归 ⑤ 管。
  //   ⛔ 返回 null = 本条不适用（题材不够大 / 高开率未知）→ 继续走下面的常规档位。
  const dual = buildDualMainPlan(first, second, dragonMap);
  if (dual) {
    const winner = dual.winner;
    const loser = dual.loser;
    // 规则对比说明挂在【重仓】那一档的 notes 上（用户第一眼就能看到为什么是它重仓）
    winner.notes = (winner.notes || []).concat(dual.topNotes);
    _appendLowOpenDragonOneNote(winner);
    _appendLowOpenDragonOneNote(loser);
    // ⑦⑧⑨⑩⑪ 的后置收口照常走（⑨ 只决定「选谁 / 什么仓位」，不豁免后面的风控规则）
    _finishBuyBlock(winner, o);
    _finishBuyBlock(loser, o);
    return {
      heavy: winner,
      light: loser,
      noYizi: null,
      smallTopic: null,
      bigTopic: null,
      dualMainNotes: dual.topNotes
    };
  }

  // 第 2 名题材：[2026-09-26 用户口径] 两条规则有先后 ——
  //   ①【优先】龙一不是竞价一字 → 直接买龙一，不看竞价涨跌幅（一字才买不进，能买就买龙一）；
  //   ② 龙一是一字（或排不出龙一）→ 取【名次最靠前的那只竞价高开】，只 1 只、轻仓。
  //   没有高开票 / 有票缺竞价涨幅都要如实说明（§10）。
  const lightNotes = [];
  let lightPicks = [];
  // ⑤【题材替换（2026-09-26 用户口径）】第 2 名题材【只有 1 个竞价一字】时，
  //   先和「连板天梯 · 题材连扳」里数量最多的题材比【早盘竞价股票数】，谁多就选谁。
  let lightBlock = second;
  let replaced = false;
  if (second && second.yiziCount === 1) {
    // ⛔ 已入选的题材（第 1 名题材）传进去：天梯第一若是它 → 不做替换（同题材不重复入选）
    const rs = resolveSecondTopicByLadder(list, second, o, [first ? first.topic : null]);
    lightBlock = rs.block || second;
    replaced = rs.replaced;
    rs.notes.forEach(function(n) { lightNotes.push(n); });
  }
  if (lightBlock) {
    const r = pickSecondTopicBuy(lightBlock, dragonMap, POSITION_LIGHT);
    lightPicks = r.picks;
    if (r.viaDragonOne) {
      lightNotes.push(_note(RULE_NO.SECOND,
        '龙一「' + r.picks[0].name + '」不是竞价一字 → 直接买龙一（不看竞价涨跌幅）'));
    } else {
      if (r.dragonOneYizi) {
        lightNotes.push(_note(RULE_NO.SECOND,
          '龙一是一字涨停（买不进）→ 跳过一字，取名次最靠前的「竞价高开」票'));
      }
      if (r.picks.length === 0) {
        lightNotes.push(_note(RULE_NO.SECOND,
          '该题材没有「非一字 且 竞价高开」的股票 → 本档无轻仓票'));
      }
      if (r.unknownCount > 0) {
        lightNotes.push(_note(RULE_NO.SECOND,
          '另有 ' + r.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）'));
      }
    }
  }
  let light = lightBlock ? {
    block: lightBlock,
    rankWord: replaced ? '' : '第二',
    // 题材下面的小字说明带上 ④ 的两条先后规则 + 规则编号，用户对照看板时能直接看到「为什么选它」
    reason: _reasonBuy(lightBlock, replaced ? '' : '第二') +
      '　→ 根据规则' + RULE_NO.SECOND + '：龙一不是一字则直接买龙一；' +
      '龙一是一字则取名次最靠前的竞价高开票（都' + POSITION_LIGHT + '）',
    mode: 'light',
    ruleNo: RULE_NO.SECOND,
    qualified: true,
    notQualifiedText: '',
    picks: lightPicks,
    notes: lightNotes
  } : null;
  const heavy = first ? _buildFirstBlock(first, dragonMap) : null;
  _appendLowOpenDragonOneNote(heavy);
  // 【一 亏钱效应 / 二 只数 / 三 持有标记】统一收口（顺序固定：先砍票再标仓位）
  _finishBuyBlock(heavy, o);

  // ⛔【同题材不重复入选（2026-09-26 用户口径）】买点里同一个题材只能出现一次：
  //   若第 2 名题材（或替换后的题材）与第 1 名题材同名 → 这一档直接不出现（9/8 大消费重复出现的修复）。
  if (heavy && light && String(heavy.block.topic).trim() === String(light.block.topic).trim()) {
    lightNotes.push(_note(RULE_NO.SECOND,
      '与第 1 名题材同名为「' + light.block.topic + '」→ 同题材不重复入选，本档不出现'));
    light = null;
  } else {
    _appendLowOpenDragonOneNote(light);
    _finishBuyBlock(light, o);
  }

  return {
    // ⛔ first 为空时必须返回 null：UI 用 v-if="buyHeavy" 判空，
    //    返回空壳对象会让模板去读 block.block.topic 直接崩（当日没有成组题材时会走到这里）
    heavy: heavy,
    light: light,
    noYizi: null,
    smallTopic: null,
    bigTopic: null
  };
}

function _yiziWord(n) {
  return n > 0 ? ('有' + n + '个竞价一字涨停') : '无竞价一字涨停';
}

function _rankWord(rank) {
  if (rank === 1) return '第一';
  if (rank === 2) return '第二';
  return rank ? ('第' + rank + '名') : '';
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
  if (topicRank === 2 && o.yiziCount === MIN_YIZI_SINGLE) {
    return o.isDragonOne ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
  }
  return (topicRank === 1 || topicRank === 2) ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
}

/**
 * 卖点提示（唯一实现）—— 按【今日竞价涨幅】细分卖出节奏（[SELL-OPEN 2026-09-29] 用户口径）。
 *
 * ⛔ 与 _decideSellTime（题材排名口径）【并存、不互相覆盖】：
 *    命中三档 → 行尾改用这里的 timeLabel，并用 text 说明节奏；
 *    未命中（≥ +SELL_MILD_HIGH / 恰好平开 / 缺竞价涨幅）→ 返回 null，行尾回落 11:20 / 14:50。
 * @param {number|null} aucPct 今日竞价涨幅（%）；null / 非数 = 缺数据（§10 不猜方向）
 * @returns {{tone:string, badge:string, timeLabel:string, text:string}|null}
 */
function _decideSellHint(aucPct) {
  const n = _num(aucPct);
  if (n === null) return null;                    // §10：缺数据 ⇒ 不产出提示，回落原规则
  if (n <= SELL_DEEP_LOW) {
    // 深低开：别在竞价割，先盯盘 —— 卖点跟着时间走（10:00 前定夺）
    return {
      tone: SELL_TONE_WATCH,
      badge: '盯',
      timeLabel: '盯盘 · 10:00 前',
      text: '竞价深低开（≤ ' + SELL_DEEP_LOW + '%）：先盯盘别急着砸 —— 10:00 前看有没有反弹，' +
        '冲高就出；反弹不起来，10:00 也出。'
    };
  }
  if (n < 0) {
    // 小低开：最弱的一档 —— 开盘就是最好的价，直接出
    return {
      tone: SELL_TONE_DANGER,
      badge: '❗危',
      timeLabel: '开盘立刻出',
      text: '竞价小幅低开（' + SELL_DEEP_LOW + '% ~ 0）：开盘【立刻出】，不等反弹、不抱侥幸，别犹豫！'
    };
  }
  if (n > 0 && n < SELL_MILD_HIGH) {
    // 小幅高开：看分时定 —— 向上拿住，走弱撒手
    return {
      tone: SELL_TONE_PLAN,
      badge: '观',
      timeLabel: '看分时定',
      text: '竞价小幅高开（0 ~ +' + SELL_MILD_HIGH + '%）：10:00 前看分时整体曲线 —— ' +
        '向上就拿到 ' + SELL_TIME_MIDDAY + ' 卖；走弱向下立刻卖。'
    };
  }
  return null;                                    // ≥ 3% / 平开 ⇒ 回落原题材排名规则
}

/**
 * 生成卖点计划。
 * @param {Array<{name:string, topic:string, pct:number|null, inTodayList:boolean}>} rows
 *        候选 = 昨日打过「买」标签的股票（topic 用【今日】的题材；不在今日列表时 topic 为空）
 * @param {Array} blocks rankDecisionTopics 的返回（用于查今日题材排名 / 数量 / 一字）
 * @param {Map} dragonMap 今日龙头排名（用于显示「龙几」）
 * @param {Set<string>|Map<string,any>|null} prevDragonNames 昨日龙头名册里的股票名（昨日龙一）；
 *        【null = 名册尚未加载】→ 「昨日是不是龙头」是未知（§10），理由里如实写「未加载」，
 *        ⛔ 绝不退化成「非龙头」—— 那会把「还没拉到」伪装成「已经判定过」。
 *        （卖出【时点】只看今日题材排名，不受此项影响，所以名册未加载照样给时点建议。）
 * @param {Set<string>|null} [todayBuyNames] 【今日】买点列表里的股票名（buildBuyPlan 的结果）。
 *        null / 不传 = 今日买点没算出来（§10：未知 ≠ 今天没选中）→ 一律【不标持有】。
 *        ⓘ 能进卖点候选的股票【上交易日】必然在买点里（卖点候选 = 昨日打过「买」标签），
 *          所以「今天又出现在买点里」= 连续两天被选中 = 强势股 → 行尾标【持有 / 加仓】，不卖。
 * @returns {Array<{topic:string, topicRank:number|null, count:number|null, yiziCount:number|null,
 *                 卖点行... }>} 按题材分组，组内按龙头排名升序
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
    // 【三 · 持有 / 加仓】上交易日就在买点里（= 进得了卖点候选）+ 今天又在买点里 → 强势股
    const holdTag = (todayBuyNames && todayBuyNames.has(r.name)) ? HOLD_TAG : '';
    // 今日竞价涨幅（%）：卖点【细分提示】的唯一依据（[SELL-OPEN 2026-09-29]）；null = 缺数据
    const aucPct = _num(r.aucPct);
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
      inTodayList: !!r.inTodayList,
      holdTag: holdTag,
      sellAt: sellAt,
      // 今天要卖的【节奏提示】：深低开 → 盯盘 10:00 前定夺；小低开 → 开盘立刻出（危）；
      // 小幅高开 → 看分时（向上 11:20 / 走弱立刻）。⛔ 标了【持有 / 加仓】的行不提示卖点
      //（它本来就不按上面的时点卖）；未命中三档 → null（行尾回落 sellAt）。
      sellHint: holdTag ? null : _decideSellHint(aucPct)
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
    if (head.topicRank === 2 && yizi === MIN_YIZI_SINGLE) {
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
export function buildRulesLines() {
  return [
    '【买点】只看题材排名前二的题材（题材排名 = 早盘竞价「题材 toggle」的组序）：',
    '　① 排名第 1 的题材，竞价一字 ≥ ' + MIN_YIZI_HEAVY + ' 个 → 选【最靠前那只非一字】的票（正常是龙一）' +
      POSITION_HEAVY + '，',
    '　　第二只【不再按名次取龙二】，改取【其余票里竞价涨幅最高】的那只' + POSITION_HEAVY + '；',
    '　　若「涨幅最高」的【不是】龙二（发生卡位）→ 再加【龙二】' + POSITION_LIGHT +
      '，一共选【3 只】（9/1 农业：龙二 +0.1% ＜ 龙三 +7.3% → 龙三' + POSITION_HEAVY + '、龙二' + POSITION_LIGHT + '）；',
    '　　涨幅最高的恰好就是龙二 → 维持原来的 2 只，都' + POSITION_HEAVY + '。',
    '　　非龙一 且 是【创业板 / 科创板 / 北交所】（20% / 30% 涨跌幅板）→ 顺延下一位（9/2 芒果超媒 → 改选龙版传媒）。',
    '　② 排名第 1 的题材，竞价一字【只有 ' + MIN_YIZI_SINGLE + ' 个】→ ' + POSITION_HEAVY +
      '买 ' + PICK_COUNT_SINGLE + ' 只（龙头顺序跳过一字，正常就是龙一）；',
    '　　同时在【' + getDragonLabel(LADDER_MIN_RANK) + '～' + getDragonLabel(LADDER_MAX_RANK) +
      '】里挑「非一字 且 竞价涨幅 > 0」的高开票做' + POSITION_LIGHT + '（= 早盘竞价里龙标为红色的那几只）；',
    '　③ 排名第 1 的题材，竞价一字 0 个 → 不达买入条件（题材排名就是按一字数排的，所以这等价于',
    '　　【全部题材】都没有一字 → 直接改走下面的 ⑤，不再只展示数据）；',
    '　④ 排名第 2 的题材 → 先看【龙一】，两条规则有先后：',
    '　　　· 龙一【不是】竞价一字（一字才买不进）→ 【直接买龙一】' + PICK_COUNT_LIGHT + ' 只，' +
      POSITION_LIGHT + '，不看竞价涨跌幅；',
    '　　　· 龙一【是】竞价一字 → 按龙头顺序跳过一字，取【名次最靠前的那只竞价高开】的股票 ' +
      PICK_COUNT_LIGHT + ' 只，' + POSITION_LIGHT + '；',
    '　　　　（龙一~龙八全低开、只有龙九高开 → 就选龙九；龙四与龙八都高开 → 选名次更靠前的龙四）。',
    '　　　· 该题材【只有 1 个竞价一字】时先做【题材替换】：拿【连板天梯 · 题材连扳】里',
    '　　　　【股票数量最多】的题材，回到【早盘竞价】比两者股票数，谁多就选谁',
    '　　　　（9/3：第 2 名大消费 7 只 ＜ 天梯第一的 AI应用 10 只 → 改选 AI应用；否则沿用本题材）。',
    '　⛔【同题材不重复入选】买点里同一个题材只出现一次：天梯第一的题材若【已经】被前面的档位',
    '　　选中，这次对比没有价值 → 不做替换，回到原来的第 2 名题材（9/8 大消费重复出现的修复）。',
    '　⑤ 【无一字弱市】当日【全部题材】的竞价一字都是 0 个 → 先看【大题材】，再改看【题材连扳】：',
    '　　　· 第 1 / 第 2 名题材里有【股票数量 ≥ ' + BIG_TOPIC_MIN_COUNT + ' 只】的 → 每个都只取【龙一】' +
      POSITION_LIGHT + '（9/4：电子/通信/算力 17 只、AI应用 10 只 → 各取龙一）；',
    '　　　· 否则改看【连板天梯 · 题材连扳】：',
    '　　取【股票数量最多】的题材（数量并列时，并列的题材【全都取】，每个都按同一规则选票）；',
    '　　每个入选题材只看它最靠前的两只（龙一 / 龙二），最终【只留竞价高开】的票：',
    '　　　· 龙一低开 + 龙二高开 → 只买龙二；· 两只都高开 → 两只都买；· 两只都低开 → 只买龙一；',
    '　　全部记【' + POSITION_LIGHT + '】（没有一字，强度打折）。',
    '　　题材连扳里股票最多的题材【不足 ' + NO_YIZI_MIN_TOPIC_COUNT + ' 只】→ 【空仓】（太弱，不参与）。',
    '　　缺竞价涨幅的票【不算高开】，会如实说明有几只未纳入（§10 不猜）。',
    '　⑥ 【小题材 + 一字 = 高风险】排名【第 1 或第 2】的题材【股票数量 ≤ ' + SMALL_TOPIC_MAX_COUNT +
      ' 只】且【竞价一字 ' + SMALL_TOPIC_MIN_YIZI + '~' + SMALL_TOPIC_MAX_YIZI + ' 个】：',
    '　　票太少却被一字撑起排名，多半是量化假强度，①②③④【都不适用】，改看【连板天梯 · 题材连扳】；',
    '　　　· 该题材在【早盘竞价】里的股票数【< ' + SMALL_TOPIC_MIN_AUCTION_COUNT + ' 只】→ 排除；',
    '　　　· 剩下的题材按【早盘竞价股票数】降序取前二；',
    '　　　· 数量最多的题材：在【龙一~龙五】里只取【竞价高开】的票 ——',
    '　　　　龙一高开 → 龙一' + POSITION_HEAVY + ' + 竞价涨幅最高的那只' + POSITION_LIGHT + '；',
    '　　　　龙一低开 / 平开 → 【舍弃龙一】，只在【龙二~龙五】里取竞价涨幅最高的两只，都' + POSITION_LIGHT + '；',
    '　　　· 数量第二的题材：只取【龙一】，' + POSITION_LIGHT + '。',
    '　龙一 / 龙二 = 题材内【十日涨幅】从高到低，与早盘竞价龙一徽章同一口径。',
    '　【灰行（灰色名称 / 灰色题材 = 不在当日正式列表）】照常参与龙位与选票，也能被选中买点 ——',
    '　　它们代表的是【老龙 / 观察组继承票】，有参考价值',
    '　　（9/8 大消费龙一国芳集团、农业龙一万向德农都是灰行）；只是【不计入】题材数量 / 一字数',
    '　　（与早盘竞价统计条同口径）。灰行来源与早盘竞价的注入行完全同源：竞昨高光继承 + 昨日买标签',
    '　　继承 + 昨日龙头名册继承壳。',
    '　【「昨日卖标签继承」的行（灰色实心卖标签）】同样照常参与龙位与选票 —— 9/8 大消费龙一国芳集团',
    '　　就是「灰名 + 灰题材 + 灰色实心卖标签」，它照样是龙一、照样入选买点。',
    '　【低开龙一的提醒】龙一竞价低开时，请自行看它的竞价图形：若出现【跌停 L 形】→ 尾盘买',
    '　　（本看板没有分时数据、不做图形判断，只给这段文字提醒）。',
    '　⑦ 【亏钱效应】入选题材里只要有【≥ 1 只竞价一字跌停】：',
    '　　（9:25 竞价报价就打在跌停价上 = 早盘竞价里股票名下方那条【绿色实线】的股票）',
    '　　⇒ 题材内部有亏钱效应 ⇒ 【只买龙一】，而且【只' + POSITION_LIGHT + '】',
    '　　　（题材股票数 > 10 只 或 < 10 只，都一样处理）。',
    '　　例：9/11 农业 12 只（中粮科技竞价 -10.00%）→ 只买敦煌种业（龙一、' + POSITION_LIGHT + '）。',
    '　⑧ 【弱势题材】入选题材【股票总数 > ' + WEAK_OPEN_MIN_COUNT + ' 只】、且里头',
    '　　【竞价高开】的股票占比【< ' + Math.round(WEAK_OPEN_RATE * 100) + '%】⇒ 题材虚胖（票多但没人跟风）',
    '　　⇒ 【只买龙一】，而且【只' + POSITION_LIGHT + '】。',
    '　　例：10 只里只有 3 只高开（30%）、12 只里只有 3 只高开（25%）→ 都触发；',
    '　　　 ≤ ' + WEAK_OPEN_MIN_COUNT + ' 只不看这条，交给下面的「买入只数」管。',
    '　　缺竞价涨幅的行【不算高开】，会在说明里如实报「几只缺」(§10 不猜)。',
    '　⑨ 【双主线竞争】第 1 名与第 2 名题材【都 ≥ ' + DUAL_MAIN_MIN_COUNT + ' 只】时（大盘缩量、两个',
    '　　大容量题材在抢主线，【只有一个能活下来】）→ 不看 ①~④，改比两个题材的【竞价高开率】：',
    '　　　· 高开率【高】的那个题材 → 只选它的【龙一】' + POSITION_HEAVY + '；',
    '　　　· 高开率【低】的那个题材 → 只选它的【龙一】' + POSITION_LIGHT + '；两个题材【各只选 1 只】。',
    '　　例：9/10 农业 11 只 / 高开 5 只 = 45%　＜　大消费 10 只 / 高开 8 只 = 80%',
    '　　　 ⇒ 大消费龙一国芳集团' + POSITION_HEAVY + '、农业龙一敦煌种业' + POSITION_LIGHT + '。',
    '　　高开率口径 = 【竞价高开只数 ÷ 题材股票总数】（与 ⑧ 同一份算法）；',
    '　　某题材【一只都没有竞价涨幅】→ 高开率未知 → 本条不生效，退回 ①~④（§10 不猜）。',
    '　⑩ 【买入只数】第 1 名题材按它在早盘竞价里的【股票数量】限制买几只：',
    '　　　· ≤ ' + BUY_COUNT_MAX_SMALL + ' 只 → 最多买 1 只（9/18 AI应用 6 只）；',
    '　　　· ≤ ' + BUY_COUNT_MAX_MID + ' 只 → 最多买 2 只（9/21 电子/通信/算力）；',
    '　　　· > ' + BUY_COUNT_MAX_MID + ' 只 → 按 ①~⑥ 的原规则。',
    '　　只砍后面的票，【龙一 / 最靠前的那只一定保留】。',
    '　⑪ 【' + HOLD_TAG + '】上一交易日出现在【买点】里、今天又在买点里 → 强势股，行尾标【' +
      HOLD_TAG + '】（昨天的买点没算出来时【不标】，§10 不猜）。',
    '　⑫ 【' + TOPIC_PREV_BOUGHT_TAG + '】= 【题材级】：题材行（竞价一字右边）出现它就表示',
    '　　【这个题材昨天有票被打过「买」标签】⇒ 题材在延续。',
    '　　⚠️ ⛔ 它【不是】「这一整块里的股票昨天都买过」——同一个题材里昨天没买过的票不会因此被标',
    '　　　（2026-09-30 事故：上一版用「' + PREV_BOUGHT_TAG + '」这个说法放在题材行，用户读成了',
    '　　　 个股结论「大亚圣象昨天已买」= 错的，所以本题材级的说法改成【' + TOPIC_PREV_BOUGHT_TAG + '】）。',
    '　　⚠️ 逐只【股票级】的判断走行尾仓位：这一只昨天真的被打过「买」标签（' + PREV_BOUGHT_TAG + '）',
    '　　⇒ 仓位由「' + POSITION_HEAVY + ' / ' + POSITION_LIGHT + '」改标【' + POSITION_ADD +
      '】（昨天已有仓位，今天是往上加，不重新建仓）。',
    '　　⚠️ 与 ⑪ 的区别：⑪ 看的是【上一个交易日的买点方案】里有没有它（系统选出来的），',
    '　　　⑫ 看的是【你昨天实际有没有打「买」标签】；两个是两回事，可以同时出现。',
    '　⑬ 【入选次数】题材行（竞价一字右边）标【一次入选 / 二次入选 / 三次入选…】=',
    '　　这个题材在【含今日在内的最近 ' + TOPIC_STREAK_WINDOW + ' 个交易日】里进过买点几次。',
    '　　次数越大 = 这个题材被反复选中、频率越高，越值得跟；与 ⑫ 的【' + TOPIC_PREV_BOUGHT_TAG +
      '】并存、互不冲突。',
    '　　只数【' + POSITION_HEAVY + ' / ' + POSITION_LIGHT + '】两个主买点块里出现的题材',
    '　　（弱市兜底方案 ⑤⑥ 里出现的题材不计入）。',
    '　　窗口里只要有一天算不出来（那天的行情还没加载）⇒ 次数就是未知，一律【不标】',
    '　　（§10 绝不拿偏低的数字冒充，那会让你误判题材频率）。',
    '　重仓与轻仓混在同一个题材块里，序号连续，仓位写在每行行尾。',
    '　※ 每个题材块下面的「选择理由」与说明文字都会标【规则N】（如【规则⑨】），方便按条文逐条核对。',
    '【题材行的数据】题材名右边依次是：实心红圆点（里面的数字 = 题材排名）｜数量：n（股票只数）｜',
    '　　竞价一字：n｜【' + TOPIC_PREV_BOUGHT_TAG + '】（有才显示）｜【N 次入选】（有才显示）。',
    '【股票行的数据】股票名右边依次是：龙几（龙一 / 龙二）｜十日涨幅｜竞价涨幅小标签；',
    '　　行尾是仓位（' + POSITION_HEAVY + ' / ' + POSITION_LIGHT + ' / ' + POSITION_ADD + '），再往右是【' +
      HOLD_TAG + '】这类标记。',
    '【卖点】候选 = 昨日打过「买」标签的股票。卖点先看【今天这只票竞价开得怎么样】，再看题材排名：',
    '　每行在「十日涨幅」右侧带一个【竞价涨幅】小标签（如 -2.60%）：涨 = 红底、跌 = 绿底、平 = 灰底；',
    '　　该股今日没有竞价涨幅时不显示这个标签（§10 不把「没查到」画成「平开」）。',
    '　【第一层 · 按今日竞价高低开细分节奏】（命中就把行尾时点换成下面这句）：',
    '　　· 竞价涨幅 ≤ ' + SELL_DEEP_LOW + '%（深低开）→ 【盯盘】：10:00 前看有没有反弹，冲高就出；反弹不起来，10:00 也出；',
    '　　· ' + SELL_DEEP_LOW + '% ~ 0（小低开）→ 开盘【立刻出】，行内打「❗危」警示，不等反弹、别犹豫；',
    '　　· 0 ~ +' + SELL_MILD_HIGH + '%（小幅高开）→ 10:00 前看分时整体曲线：向上就拿到 ' + SELL_TIME_MIDDAY +
      ' 卖，走弱向下立刻卖；',
    '　　· 其余（≥ +' + SELL_MILD_HIGH + '% / 平开 / 缺竞价涨幅）→ 不提示，按下面的题材排名时点（§10 缺数据不猜）。',
    '　【第二层 · 题材排名兜底时点】（第一层没命中时，行尾才显示这个）：',
    '　① 今日题材排第 1 或第 2 → ' + SELL_TIME_CLOSE + ' 卖（拿满一天）；',
    '　② 今日题材排名不在前二（含今日未成组）→ ' + SELL_TIME_MIDDAY + ' 卖（排名靠后，弱了早走）；',
    '　③ 例外：今日题材【排第 2】且该题材【只有 1 个竞价一字】→ 题材强度打折，',
    '　　 【只有龙一】' + SELL_TIME_CLOSE + ' 卖，【其余非龙一】' + SELL_TIME_MIDDAY + ' 卖（同一组里会同时出现两种时点）。',
    '　④ 【' + HOLD_TAG + '】上交易日就在买点里、今天又出现在买点里 → 强势股，行尾标【' + HOLD_TAG + '】，',
    '　　不按上面的时点卖出（继续持有 / 加仓）。',
    '　「昨日是龙头（十日涨幅最高）」会写进卖出理由 —— 典型场景：昨日的龙一今天掉出前二 → ' + SELL_TIME_MIDDAY + ' 卖。',
    '说明：统计只数当日正式列表里的股票，「昨日卖标签继承」的复盘行不计入（与早盘竞价同一口径）；',
    '　　　缺竞价涨幅的行不会当成「高开」，会如实说明有几只未纳入。'
  ];
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
