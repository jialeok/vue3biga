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
 * ── 涨幅口径（用户原话「我说的时间点是昨日，因为当天早上还没收盘计算出来」）──────────────
 *   一律用【上一交易日】的十日涨幅 —— 由调用方按 prevDate 从 stock_range_pct 读回后注入。
 *   ⚠️ 当日口径在停牌票上【必然读不到】（当天没交易就没有当天涨幅）⇒ 最典型的场景恰恰算不出来。
 *
 * @param {{ready:boolean, leader:object|null, leaderSuspended:boolean, leaderShare:number|null,
 *          siblingDragons:Array, secondInfo:object|null}|null} ebbCtx
 * @returns {null|object} null = 不是退潮日（或事实未就绪）；否则见下方返回结构
 */
export function detectEbbDay(ebbCtx) {
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
    // ── 允许【看分笔卖】的两只（空串 = 该只今天不成立）──
    siblingName: sib ? String(sib.name) : '',
    siblingRank: sib ? Number(sib.rank) : null,
    siblingLabel: sibLabel,
    secondName: secondOk ? String(si.name) : '',
    secondTopic: secondOk ? String(si.topic || '') : '',
    secondPct: secondOk ? _num(si.pct) : null,
    secondPctText: secondOk ? formatRangePct(_num(si.pct)) : '',
    // 标题上直接列出那两只是谁（没有则如实说「一只都没有」）
    picksText: picksText.length > 0 ? picksText.join('、') : '（本日无符合条件的票）',
    // ── 文案（§21：模板零计算）──
    headline: '⚠️ 退潮首日 · 卖点收紧',
    detail: '市场总龙【' + leaderName + '】（' + topicText + '，昨日十日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 判定为【题材退潮首日】。卖点侧：' +
      (picksText.length > 0
        ? ('只有 ' + picksText.join('、') + ' 可以【' + EBB_PICK_TAG + '】（等开盘看分笔，不看占比）；')
        : '今天没有符合条件的【同题材可用龙位】【市场总龙二】；') +
      '其余股票一律【' + SELL_OUT_TAG + '】（含原本标【' + HOLD_TAG + '】的）—— 开盘就走，降低风险。',
    buyHeadline: '⚠️ 退潮首日 · 建议空仓 · 不开仓',
    buyDetail: '市场总龙【' + leaderName + '】（' + topicText + '，昨日十日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 题材退潮首日，风险高。下方选股【整体变灰】仅为参考，建议今天不开仓（空仓）。'
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
    buy: { heavy: null, light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null },
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
    ebb: null
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
  out.ebb = detectEbbDay(o.ebbCtx || null);

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

  // 买点名单（喂给卖点判「今天又进买点 ⇒ 持有」）
  out.blocks.forEach(function(b) {
    (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  });

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
    '二十、【退潮首日 · 卖点收紧】市场总龙 = 当日早盘竞价【全列表】里【昨日十日涨幅】最高的那只。' +
      '它今日【停牌】或【竞价占比不达标】（二者有一即算）⇒ 判定为【题材退潮首日】。' +
      '⚠️ 涨幅口径是【昨日】的：当天早上还没收盘算不出今天的十日涨幅，停牌票当天更是读不到。',
    '　　退潮首日，卖点侧只有两类票标【' + EBB_PICK_TAG + '】（= 允许等开盘看【分笔成交】再卖，' +
      '⛔ 不看占比）：' +
      '①【同题材可用龙位】= 总龙所在题材里龙位最靠前、且【非竞价一字 / 非停牌】的那只' +
      '（龙二不可用就顺延龙三、龙四……）；' +
      '②【市场总龙二】= 昨日十日涨幅【第二】的那只，且必须是【它自己题材的龙一】、与总龙【不同题材】、' +
      '且非竞价一字 / 非停牌（⛔ 这一只【不顺延】：它必须正好是涨幅第二，不递补涨幅第三）。',
    '　　其余股票（含原本标【' + HOLD_TAG + '】的）一律改【' + SELL_OUT_TAG + '】：开盘就走，降低风险。' +
      '⚠️ 同时买点侧【整体变灰 + 大字空仓标语】：退潮首日不开仓。'
  ];
}
