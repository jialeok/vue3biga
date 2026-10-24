// decision-collect.js — 「决策」看板的数据采集（Logic 层，§15 独立业务模块）
//
// 职责边界（§4）：本文件只做「读内存真相 → 组装成规则层要的 entries」，
//   ⛔ 不发请求、不写库、不消费猫抓额度、不做任何业务判断（判断全在 decision-rules.js）。
//
// 数据来源（§6 单一真相，全部复用早盘竞价既有口径，绝不另起一套）：
//   · 当日列表 + 题材        → getTodayGroupList / getPrimaryTopicMap / classifyStockPrimaryTopic
//   · 竞价一字               → isAuctionYiZi（limit-up.js，与早盘竞价行内红线同一判定）
//   · 十日涨幅 + 今日龙头排名 → getDragonRangePct / computeDragonRankMap（dragon-rank.js）
//   · 昨日龙头名册           → getDragonLeadersForDisplay（dragon-group.js，= 前一交易日评选出的龙头）
//   · 昨日「买」标签         → auctionTagStore（云端 auction_board_tags 的响应式镜像）
//   · 「昨日卖标签继承」剔除  → getPrevSoldInheritedSet（与早盘竞价统计/着色同一口径）
//
// §10 红线：数据没加载完 = 「还没拉到」，绝不等于「今天没有」。
//   未就绪时返回 ready=false + 明确的 reason，由 UI 如实展示（⛔ 不许显示成「空看板」）。

import { getTodayGroupList, getAuctionData } from '../app-core-api.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap } from '../auction/topic-sort.js';
import { isAuctionYiZi, parseAucPct } from '../auction/limit-up.js';
import { getDragonRangePct } from '../auction/dragon-rank.js';
import { getDragonLeadersForDisplay } from '../auction/dragon-group.js';
import { getPrevSoldInheritedSet } from '../auction/inherited-sold.js';
// [GRAY-DRAGON 2026-09-26] 灰行（不在当日正式列表的继承票）的观察组来源，与早盘竞价同款（§6）
import { getJingYestHighlightSetForDate } from '../auction/sort-rules.js';
// [SEAL 2026-10-11 用户口径] 决策看板逐票「封单额 + 变化 + 连板」：口径与读取全在 seal-volume.js
//   （§6 单一真相，与早盘竞价看板的封单量共用同一份 limit_pool 内存缓存）。
//   ⛔ 不消费猫抓额度：limit_pool 由 Edge Function 15:40 用同花顺 fuyao 免费抓取落库，本层只读。
import { decorateSealFields } from '../auction/seal-volume.js';
// [BOARD-SUSPEND 2026-10-13 用户口径] 「三个选股看板都要标哪只股票停牌」——
//   判定与展示收口全在 suspend.js（§6 单一真相，与早盘竞价看板同一条判据）。
//   ⛔ 不消费猫抓额度：同花顺 fuyao 免费/不限量；本层只做【同步读】，加载由各看板组合式触发。
//   ⚠️ [SUSPEND-PENDING 2026-10-14] 除了「能不能判」（canJudgeSuspended）还要看「判出来没有」
//      （hasSuspendVerdict）—— 见 nonFirstDaySuspendNames 的注释（§10：没结论 ≠ 否定结论）。
import { decorateSuspendField, isSuspended, canJudgeSuspended, hasSuspendVerdict } from '../auction/suspend.js';
// ★ [EBB-R20 2026-10-20 用户口径] 主板闸门（替补选股用）：创业板 / 科创板 / 北交所一律排除。
//   唯一实现在 range20-leaders.js（20日涨幅前五的「仅主板」过滤就是它）⇒ 按 §6 复用同一把尺子。
import { isMainBoardOnly } from '../auction/range20-leaders.js';
// ★ [EBB-R20] 总龙【题材】的退路（今日停牌 / 不在今日列表时）：读上一交易日行情行的 topics 串。
import { getStockHistoryValue } from '../../data/watchlist-helpers.js';
// ★ [EBB-TOPIC-FIX 2026-10-22] 补位票（今天不在列表里）的题材退路：题材库按股票名反查。
//   为什么必须有：10-22 新华传媒（停牌补位，20日涨幅第一）在当天列表里【没有行】，
//   老退路 `getStockHistoryValue(prevDate, name, 'topics')` 原本因缺分支返回了【昨日成交量】
//   （'16950'）⇒ 退潮提示写成「主线16950首次退潮」（已修，见 watchlist-helpers）。
//   但修好之后它只会返回 null（该票 watchlist.topics 一直是空串）⇒ 题材仍是空的，
//   而「按题材认亲数退潮事件」正需要这个题材名 ⇒ 再往下一层：查题材库（权威来源 §6）。
import { lookupTopicsByName } from '../../data/stock-topics.js';
import { _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
// [TWO-MODES 2026-10-02 用户口径] 买点分两套模式，由早盘竞价的题材 / 一字 toggle 决定
//   （判据与分派都在 decision-mode.js，§6 单一真相）。两套模式对【本文件】的差别只有两处：
//     ① 题材排名口径（rankDecisionTopics 的第 2 参 mode）—— 一字模式按一字数量排、量比模式按量比排；
//     ② 买点规则（buildBuyPlan 的第 4 参 mode）—— 一字模式走老版完整规则，它要连板天梯数据。
//   ⇒ 所以这里要按需把连板天梯「题材连扳」分组采集出来（[NO-YIZI 2026-09-25] 的老口径恢复）。
//     与天梯看板显示的是【同一份采集结果】（0 请求、纯内存），⛔ 不在这里另写一遍分组：
//     另写必然与天梯看板分叉 —— 用户是照着天梯看板的题材数去数的（§6 单一真相）。
import { collectLadderData } from '../ladder/ladder-collect.js';
import {
  rankDragons,
  buildSellPlan,
  TOPIC_STREAK_WINDOW,
  SELL_TIME_MIDDAY,
  SELL_TIME_CLOSE,
  normalizeDecisionMode
} from './decision-rules.js';
// ⛔ 分模式的两件事【只从 decision-mode.js 取】（它再往下分派到 rules / rules-legacy）——
//    本文件不许自己写 `mode === 'yizi' ? A : B`，否则就出现了第三处模式判定。
import { rankDecisionTopics, buildBuyPlan, needsLadderData } from './decision-mode.js';
// [VRATIO-TREND 2026-10-01 用户口径] 「竞价量比（auc_vol_ratio）近 5 日」的取数与展示视图。
//   为什么挂在这一层而不是 decision-rules：规则文件是【纯函数】（不读 state），
//   而竞价量比要读内存真相（Data 层只读选择器）—— 本文件正是「读内存真相」的地方（§4）。
//   ⛔ 只是把已算好的字段挂到 pick / item 上，不做任何业务判断（判断仍全在 decision-rules）。
import {
  VOL_RATIO_TREND_DAYS,
  decorateVolRatioFields,
  // [VR-COMPARE 2026-10-02 用户口径] 「今日 vs 上交易日」竞价量比方向：买点 / 卖点新档位的唯一依据。
  getVolRatioDir,
  // [SELL-SURGE 2026-10-03 用户口径] 「今日 ÷ 上交易日」竞价量比倍数：卖点【冲高就卖】档的唯一依据。
  getVolRatioTimes,
  // [DIVE-BUY 2026-10-07 用户口径 · 爱仕达 9/7] 「今日 － 上交易日」竞价量比【整数差】：
  //   买点【下杀买（竞价异常）】档的硬指标之一（用户口径「比上个交易日多 30」）。
  //   ⛔ 与 volRatioDir（方向）/ volRatioTimes（倍数）是【三个不同口径】，别互相替代（§6）。
  getVolRatioDelta
} from './vol-ratio-trend.js';
// [SHARE-RULE 2026-10-03 用户口径] 竞价占比（当日竞价量 ÷ 昨日成交量）= 买卖时机的【主判据】。
//   ⛔ 公式 / 门槛 / 展示精度 / 取数的唯一实现在 auction-share.js；本文件只负责【调一次并挂到行上】（§6）。
//   §10：取不到（缺数据 / 昨日成交量为 0）→ null ⇒ 规则层回落旧口径，绝不补 0。
// [EBB-R8 2026-10-14] passesAuctionShare = 占比达标判据的唯一实现（§6）：
//   首日判据要判「昨日占比是否达标」，门槛口径必须与今日那条腿同一个函数，⛔ 不手写 `share >= 门槛`。
import { getAuctionShare, getAuctionVolume, passesAuctionShare } from './auction-share.js';
// [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 龙标旁边的【名次变化】徽标（昨日龙几 → 今日龙几）。
//   本文件只负责【把字段挂到每一行上】（与竞价量比同一处遍历收口，§6）；名次差怎么算、
//   前一交易日的名次从哪来，全在 dragon-rank-change.js（纯映射）/ dragon-rank-change-store.js（取数）。
//   ⛔ 依赖方向是单向的：collect → dragon-rank-change；反向 import 会构成 ESM 循环依赖
//      （dragon-rank-change-store 要 import 本文件的 collectDragonRankMap），所以状态与纯映射
//      必须单独一个文件，见 dragon-rank-change.js 文件头。
//   ⚠️ 本文件同时要读【前一交易日龙位表】这个状态单例（st.date / st.map），一并 import。
import { applyDragonRankChange, dragonRankChangeState } from './dragon-rank-change.js';

function _notReady(reason) {
  return {
    ready: false,
    reason: reason,
    topics: [],
    // ⚠️ 结构契约：六个键必须齐全（heavy / light / candidates / noYizi / smallTopic / bigTopic）。
    //    candidates 是 2026-10-02 新增的候选题材槽位；一字模式恒为 []
    //    （老版没有候选题材概念，但 UI 用 `buy.candidates || []` 兜底，给齐了更不容易踩空）。
    buy: { heavy: null, light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null },
    sell: [],
    sellTimes: []
  };
}

// [NO-YIZI 2026-09-25] 「全部题材竞价一字 0 个」的弱市兜底要读【连板天梯 · 题材连扳】的分组。
// [TWO-MODES 2026-10-02] 这条兜底只在【一字模式】的老版规则里存在（见 decision-mode.js#
//   needsLadderData）⇒ 本函数只在一字模式 + 命中触发条件时才被调用，量比模式【完全不调用】
//   （每天少跑一次全量行归堆，§36 性能红线）。
// §10：采集失败 / 未就绪必须原样上报，绝不能退化成「今天没有连板梯队」。
function _ladderTopicGroups(date) {
  try {
    const d = collectLadderData(date);
    return { ready: !!d.ready, groups: d.topicGroups || [], reason: d.ready ? '' : (d.reason || '') };
  } catch (e) {
    return { ready: false, groups: [], reason: (e && e.message) ? e.message : '连板天梯计算失败' };
  }
}

/** 昨日打过「买」标签的股票名集合（标签只继承一天，所以只看【前一日】） */
function _prevBoughtNames(prevDate) {
  const out = new Set();
  if (!prevDate) return out;
  try {
    const tags = useAuctionTagStore().tags || {};
    const dayTags = tags[prevDate] || {};
    Object.keys(dayTags).forEach(function(n) {
      if (dayTags[n] !== 'buy') return;
      const nm = String(n || '').trim();
      if (nm) out.add(nm);
    });
  } catch (e) {
    // 标签库没加载 → 返回空集（由上层 ready 判定处理，绝不抛给渲染层）
  }
  return out;
}

/** 从买点方案里抽出全部股票名（heavy / light / 各兜底方案的 blocks 都算「买点列表」） */
/**
 * 【买点块清单 · 唯一实现（§6）】把一个买点计划里【所有】买点块摊平成一维数组。
 *
 * 覆盖：heavy（第 1 名）/ light（第 2 名）/ candidates[]（候选题材，2026-10-02 新增）/
 *       noYizi / smallTopic / bigTopic（三个兜底槽位，新规下恒为 null，⛔ 键保留）。
 *
 * ⚠️ 为什么按【槽位列表 + 数组 + blocks 兜底】的写法遍历，而不是写死「heavy / light」：
 *    口径一致性靠【结构】保证，而不是靠人记得改这里 —— 加回带 blocks 的方案、或新增候选数组时，
 *    计数 / 派生范围不会【悄悄】变窄（2026-09-30 「入选次数整块看板不显示」的事故就是这么来的）。
 *
 * @param {object} buy buildBuyPlan 的返回值
 * @returns {Array<object>} 买点块数组（已过滤 null）
 */
function _buyBlocksOf(buy) {
  const out = [];
  if (!buy) return out;
  // ★ [EBB-R8 2026-10-14] 新增槽位 `ebbSecond` = 退潮首日买点侧唯一那只【市场龙二】。
  //   为什么挂在买点对象里（而不是另起一个顶层字段）：本函数是「遍历一个买点块」的【唯一实现】，
  //   量比趋势 / 封单额 / 名次变化 / 停牌标记四个装饰器全部经它取块（§6）。
  //   ⇒ 龙二那一行必须从这里过一遍，否则它会缺掉这些客观数据（与「不另写一份遍历」同一理由）。
  //   ⚠️ 它仍然只是【一个槽位】：本看板自己去渲染它，决策看板的模板换不到这个键（该看板不传）。
  // ★★ [SWITCH 2026-10-22] 新增槽位 `newDragon` = 第二十八条【切换日的新龙】那一行。
  //   与 ebbSecond 同一理由：四个装饰器只经本函数取块，不进这里它就会缺客观数据（§6 不另写遍历）。
  // ★★ [R10-BACKUP 2026-10-24] 新增槽位 `range10Backup` = 第二十九条【十日涨幅 · 在列次数候补】那一只，
  //   同样是「今天真要买、渲染在灰化容器之外」的行 ⇒ 必须进这里，否则它缺量比趋势 / 名次 / 封单 / 停牌（§6）。
  ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic', 'ebbSecond', 'newDragon', 'range10Backup']
    .forEach(function(k) {
      if (buy[k]) out.push(buy[k]);
    });
  // [MIN-3-PICKS 2026-10-02] 候选题材块 = 常规块结构（有 picks），只是标了 isCandidate
  (buy.candidates || []).forEach(function(b) { if (b) out.push(b); });
  return out;
}

/**
 * [BUY-BLOCKS-FLAT 2026-10-11] 【买点块 · 摊平清单】的对外出口 —— 遍历「一个买点块」的唯一实现（§6）。
 *
 * 与 _buyBlocksOf 的区别（这就是上面那段注释里说的「槽位列表 + 数组 + blocks 兜底」的落地）：
 *   · _buyBlocksOf         = 【原始槽位清单】：原样吐出 heavy / light / candidates[] /
 *                            noYizi / smallTopic / bigTopic —— 其中后三个是【方案外壳】，
 *                            形状是 `{mode, qualified, emptyText, hintText, blocks:[...], notes:[...]}`，
 *                            ⛔ 它们【没有 .block、也没有 .picks】，真正的块在 .blocks 里。
 *   · buyBlocksFlat（本函数）= 【摊平后的块清单】：保证每一项都是【常规块】（都有 .block / .picks），
 *                            可以直接 `b.block.topic` / `b.picks.forEach(...)`。
 *
 * 🔴 为什么需要它（2026-09-30 现场，用户 2026-10-11 报障）：
 *   「分笔买卖」看板最初只看 `b.picks`，遇到 heavy / light / candidates 都正常，
 *   但只要当天的买点【全部落在兜底方案里】（⑥ 小题材 / ⑤ 无一字 / 大题材），
 *   拿到的就是三个【外壳】⇒ `b.picks` 恒空 ⇒ **整侧买点空白**，而决策看板照常显示
 *   （它走的是 buySpecial.blocks）。9/30 实测就是这一天：决策看板有 大亚圣象 / 新华文轩 两只，
 *   分笔看板买点侧一个块都没有。同一个坑，引擎侧 `_finishPlanBlocks` 的注释里也记过一次
 *   （「当天买点全在兜底方案里的日子整块看板没有次数（9/30 实测）」）。
 *
 * ⛔ 为什么遍历必须收口在这里：每多写一份「b.picks / b.blocks」的手写遍历，
 *    就多一次「新增一个档位后，那边的票静默漏掉」的机会（candidates 是 2026-10-02 才加的、
 *    兜底槽位改过三回）。_buyPlanNames / _eachRow / 分笔看板三处现在共用本函数。
 *
 * ⚠️ 行为与旧的「先 b.picks、再 b.blocks[].picks」逐字等价（顺序一致）；
 *    按【对象标识】去重（同一个块同时出现在 light 与 candidates 里时只出一次）。
 *
 * @param {object} buy buildBuyPlan 的返回值（可为 null）
 * @returns {Array<object>} 常规买点块数组（每项都有 .block / .picks）
 */
export function buyBlocksFlat(buy) {
  const out = [];
  _buyBlocksOf(buy).forEach(function(b) {
    if (!b) return;
    // ① 常规块（heavy / light / candidates）：它自己就是块
    //    ⚠️ 也要去重：被降级成候选题材的第 2 名【同时】出现在 light 与 candidates 里
    //       （是同一个对象引用）—— 决策看板用「引用相等」排除它，这里同一口径。
    if ((b.block || (b.picks && !b.blocks)) && out.indexOf(b) < 0) out.push(b);
    // ② 兜底方案外壳：把 .blocks 里真正的块摊平出来（按对象标识去重）
    (b.blocks || []).forEach(function(bb) {
      if (bb && out.indexOf(bb) < 0) out.push(bb);
    });
  });
  return out;
}

function _buyPlanNames(buy) {
  const out = new Set();
  buyBlocksFlat(buy).forEach(function(b) {
    (b.picks || []).forEach(function(p) { if (p && p.name) out.add(p.name); });
  });
  return out;
}

/**
 * 【买点 / 卖点 · 全部行遍历的唯一实现（§6）】
 *
 * 覆盖：买点的 heavy（第 1 名）/ light（第 2 名）/ candidates[]（候选题材）/ 三个兜底槽位
 *       （noYizi / smallTopic / bigTopic —— 它们是 `{blocks:[...]}` 形状，见 _buyBlocksOf 注释）
 *       ＋ 卖点的每一组 items。
 *
 * 🔴 [DRAGON-RANK-CHANGE 2026-10-09] 为什么要把遍历抽出来（而不是各自写一遍 forEach）：
 *   在这之前只有「竞价量比装饰」一处需要逐行挂字段，所以遍历内联在它里面没问题。
 *   现在「龙标名次变化」是第二处 —— 若各自写一份遍历，日后【新增一个买点档位】（历史上发生过：
 *   candidates 是 2026-10-02 才加的、兜底槽位改过三回）就必然漏掉其中一处，
 *   表现为「行照常显示，但某个新档位的票没有量比 / 没有名次变化」这种极难自查的隐性缺项。
 *   ⇒ 遍历只此一份，两个装饰器共用（口径一致性靠结构保证，而不是靠人记得改两处）。
 *
 * ⛔ 只做遍历，不做任何业务判断、不挂任何字段 —— 挂什么由各装饰器自己决定。
 *
 * @param {object} buy  buildBuyPlan 的返回（可为 null）
 * @param {Array} sell  buildSellPlan 的返回（可为 null）
 * @param {(row:object)=>void} fn 逐行回调（行 = 买点 pick / 卖点 item）
 */
function _eachRow(buy, sell, fn) {
  // ⛔ 摊平（含三个兜底方案的 .blocks）由 buyBlocksFlat 负责 —— 遍历只此一份，见它的长注释。
  buyBlocksFlat(buy).forEach(function(b) {
    (b.picks || []).forEach(fn);
  });
  (sell || []).forEach(function(g) {
    (g.items || []).forEach(fn);
  });
}

/**
 * [VRATIO-TREND 2026-10-01 用户口径] 给买点 / 卖点的每一行挂上「竞价量比（auc_vol_ratio）」：
 *   · `volRatioText`     行内徽标文案（如「量比 2.18」；缺值 → 空串 ⇒ 模板不渲染，§10）
 *   · `volRatioTrend`    近 5 个交易日的点集（喂 TrendChart，点开行才画）
 *   · `volRatioHasData`  有无有效点（false ⇒ 模板画一行「暂无数据」，⛔ 不画满屏 '--'）
 *
 * 为什么在这里收口（而不是在 decision-rules 里逐处构造）：
 *   · 规则文件是纯函数、不许读 state；竞价量比必须读内存真相（Data 层只读选择器）；
 *   · 买点有 5 个档、卖点有 N 组，若在每个构造点各补一次，日后加档位必漏 —— 这里【一处遍历收口】。
 *
 * ⛔ 只挂展示字段，不改任何选票结论；⛔ 不发请求（近 30 自然日已在内存缓存里，§32）。
 *
 * @param {object} buy  buildBuyPlan 的返回
 * @param {Array} sell  buildSellPlan 的返回
 * @param {string} date 展示日（= 决策看板当前日期）
 */
function _decorateVolRatioTrend(buy, sell, date) {
  if (!date) return;
  _eachRow(buy, sell, function(row) {
    decorateVolRatioFields(row, date, VOL_RATIO_TREND_DAYS);
  });
}

/**
 * [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 给买点 / 卖点的每一行挂上【龙标名次变化】：
 *   · `dragonDeltaText`  徽标文案（'+3' / '-2'；无可比 → 空串 ⇒ 模板不渲染，§10）
 *   · `dragonDeltaTone`  配色档（'up' 上升红 / 'down' 下降绿；空串 = 不渲染）
 *   · `dragonDeltaTitle` 悬停说明（写清「昨日龙三 → 今日龙一（上升 2 个名次）」）
 *
 * 数据来自【前一交易日】的龙位表（dragon-rank-change-state，由 dragon-rank-change-store 异步备好）。
 * §10：它还没备好 / 对不上日期 ⇒ 传 null ⇒ 全行空串 ⇒ 一枚徽标都不显示（⛔ 绝不猜）。
 * ⚠️ prevDate 由本函数自己算（与主流程同一个 getPreviousTradingDay），并【比对表上的日期】——
 *    只有 date 正好等于「今天的上一交易日」才用它，否则会拿更早一天的名次算出一个假的变化值。
 *
 * @param {object} buy  buildBuyPlan 的返回
 * @param {Array} sell  buildSellPlan 的返回
 * @param {string} prevDate 上一交易日 YYYY-MM-DD
 * @param {Map} todayRankMap 今日龙位表（= rankDragons 的返回）
 */
function _decorateDragonRankChange(buy, sell, prevDate, todayRankMap) {
  const st = dragonRankChangeState;
  const prevRankMap = (prevDate && st.date === prevDate && st.map.size > 0) ? st.map : null;
  _eachRow(buy, sell, function(row) {
    applyDragonRankChange(row, prevRankMap, todayRankMap);
  });
}

/**
 * [SEAL 2026-10-11 用户口径] 给买点 / 卖点的每一行挂上【封单额 + 变化 + 连板】：
 *   · `sealMoneyText`  今日封单额（'3.20亿'；无值 / 0 → 空串 ⇒ 徽标不渲染）
 *   · `sealDeltaText`  与上一交易日的变化量（'+1.10亿' / '-8500万'；算不出 → 空串）
 *   · `sealDeltaTone`  变化配色档（'up' 增加红 / 'down' 减少绿）
 *   · `sealDeltaArrow` '↑' / '↓'
 *   · `sealContinueTag` 连板文案（'2连板'…；首板 → 空串）
 *   · `sealDeltaTitle` 悬停说明
 *
 * 用户原话（2026-10-11）：「决策看板那里我希望你也要添加，这样同步也方便知道哪些股票是连板，
 *   封单数量是多少」；拍板口径 =【只加封单额 + 变化】（封单量（手）只放早盘竞价看板）。
 *
 * 数据来自 limit_pool（同花顺 fuyao 15:40 收盘快照 ⇒ 0 猫抓额度）；§10：当天没涨停
 * （不在涨停池）⇒ 全行空串 ⇒ 一枚徽标都不显示，⛔ 绝不猜。
 * ⛔ skipPrevBuy（内部递归算历史日买点、结果不进 UI）不挂：挂了纯属白算（§36）。
 *
 * @param {object} buy  buildBuyPlan 的返回
 * @param {Array} sell  buildSellPlan 的返回
 * @param {string} date 展示日（= 决策看板当前日期）
 */
function _decorateSeal(buy, sell, date) {
  if (!date) return;
  _eachRow(buy, sell, function(row) {
    decorateSealFields(row, date);
  });
}

/**
 * [BOARD-SUSPEND 2026-10-13 用户口径] 给买点 / 卖点的每一行挂上【当日停牌】标记：
 *   · `suspendTag`  '停牌'；未停牌 / 判不出来 ⇒ 空串 ⇒ 模板不渲染（§10）
 *
 * 用户原话：「选股那里也要添加停牌标签，题材量比看板、决策看板、分笔买卖，这些选股看板，
 *   都需要标记哪一个股票停牌，打上标签」。
 *
 * 为什么收口在这里：判定要读 suspend.js 的模块级 ref（业务真相），规则层是纯函数读不到；
 *   而买点有多个档、卖点有 N 组，在各自构造点各补一遍必然漏（§6）—— 与 _decorateVolRatioTrend 同一取舍。
 *
 * ⚠️ 本函数对【买点 + 卖点两侧】都挂：一只票停牌时，它在买点侧（今天想买却买不进）与
 *   卖点侧（想卖卖不掉）都必须看得见，这正是用户要的「一眼知道是哪一只」。
 * ⛔ skipPrevBuy 的内部重算不进 UI，不挂（§36）；调用点因此在 collectDecisionData 里加了闸门。
 *
 * @param {object} buy  buildBuyPlan 的返回
 * @param {Array} sell  buildSellPlan 的返回
 * @param {string} date 展示日（= 看板当前日期）
 */
function _decorateSuspend(buy, sell, date) {
  if (!date) return;
  _eachRow(buy, sell, function(row) {
    decorateSuspendField(row, date);
  });
}

/**
 * [BOARD-SUSPEND 2026-10-13] 把买点 / 卖点里出现过的股票收成「停牌判定」要用的名单（**唯一实现**，§6）。
 *
 * 为什么需要它：suspend.js 判停牌要拿【股票代码】去问同花顺，而三个看板的组合式手上只有
 *   「买点 / 卖点计划对象」—— 与其让每个看板各自再遍历一遍（§6 必然分叉），不如在这里收口。
 *
 * 代码解析顺序（与 decorateTickRow 的 _resolveCode 同一取舍）：
 *   ① 行上的 `code`（题材量比看板 / 卖点行 / 分笔看板都自带）；② 名册 `getStockCode(name)`
 *   （决策看板买点 pick 不带 code，由 pickByVolRatio → _toPick 构造，只透传 name）。
 *   ⚠️ 缺代码 ⇒ 该行【不参与判定】（也就不打标），§10 不猜。
 *
 * @param {object|Array} buy 买点计划（buildBuyPlan / buildTopicVolRatioPlan 的 buy）
 *        或【已摊平的块数组】（分笔看板拿到的就是 buyBlocks）—— 两种形状都收，⛔ 别让调用方自己转换。
 * @param {Array} sell 卖点分组数组（每项含 .items）
 * @returns {Array<{stock:string, code:string}>} 已按名字去重
 */
export function suspendEntriesOf(buy, sell) {
  const out = [];
  const seen = new Set();
  function push(name, code) {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) return;
    const c = String(code || '').trim() || String(getStockCode(n) || '').trim();
    if (!c) return;               // 拿不到代码 ⇒ 这一行不参与判定（§10）
    seen.add(n);
    out.push({ stock: n, code: c });
  }
  // ⚠️ 买点遍历仍走 buyBlocksFlat（它负责摊平兜底方案的 .blocks）——唯一一份遍历，见它的长注释；
  //    分笔看板传进来的已经是摊平后的块数组，直接用。
  const blocks = Array.isArray(buy) ? buy : buyBlocksFlat(buy);
  blocks.forEach(function(b) {
    if (!b) return;
    (b.picks || []).forEach(function(p) { if (p) push(p.name, p.code); });
  });
  (sell || []).forEach(function(g) {
    if (!g) return;
    (g.items || []).forEach(function(it) { if (it) push(it.name, it.code); });
  });
  return out;
}

/**
 * 【三 · 持有 / 加仓】上一交易日的【买点】股票名集合。
 *
 * ⛔ 复用本文件自己的采集再算一遍前一天的决策，而不是另写一套「昨天买了什么」的规则（§6 单一真相）：
 *    另写必然与买点规则分叉，分叉就会出现「昨天明明选了它，今天却没标持有」。
 * ⛔ 只往回追【一层】（skipPrevBuy=true）：否则每天都要顺着交易日往前追整条链（§36 性能红线）。
 *
 * [TWO-MODES 2026-10-02] ⚠️ 必须【带上 mode】：昨天是用哪套规则选的票，要用同一套重算 ——
 *   否则一字模式下会拿「量比模式选出来的昨天」去标【持有 / 加仓】，两边菜谱不同、标的必然错位。
 *
 * @param {string} prevDate 上一交易日
 * @param {string} mode 当前买点模式（MODE_VOL_RATIO / MODE_YIZI）
 * @returns {Set<string>|null} null = 昨天的买点没算出来（§10：未知 ≠ 昨天一只都没选）
 */
function _prevBuyNames(prevDate, mode) {
  if (!prevDate) return null;
  try {
    const d = collectDecisionData(prevDate, { skipPrevBuy: true, mode: mode });
    if (!d || !d.ready || !d.buy) return null;
    return _buyPlanNames(d.buy);
  } catch (e) {
    // §10：算不出来 = 未知（null），⛔ 绝不退化成空 Set（那会被理解成「昨天一只都没选」）
    console.warn('[DECISION] 上一交易日买点计算失败，【持有 / 加仓】标记按未知处理', e);
    return null;
  }
}

/**
 * 【④ 题材级 · 昨有买入】昨天买过的票【今天】落在哪些题材里。
 *
 * ⚠️ 用【今日的题材归属】（byName 里的 topic）而不是昨天的题材名：看板显示的是今天的题材块，
 *    标签表达的是「今天这个题材在延续」，用同一份映射才不会出现「标签挂在一个今天不存在的题材上」。
 *    与 _mkRow 的题材口径完全同源（§6）。
 * §10：byName 缺人（今天不在任何池里）→ 该股不参与聚合；这不影响其它股票。
 *
 * @param {Set<string>} prevBought 上一交易日打过「买」标签的股票名集合
 * @param {Map<string,object>} byName 今日 股票名 → 行（含 topic）
 * @returns {Set<string>} 含「昨天有票买过」的题材名集合
 */
function _prevBoughtTopics(prevBought, byName) {
  const out = new Set();
  if (!prevBought || !byName) return out;
  prevBought.forEach(function(nm) {
    const row = byName.get(nm);
    const t = row ? String(row.topic || '').trim() : '';
    if (t) out.add(t);
  });
  return out;
}

/**
 * 一个买点方案里【全部买点块】的题材名集合。
 *
 * [STREAK-ALL-BLOCKS 2026-09-30 用户口径修正] ⛔ 不要再收窄成「只取重仓 / 轻仓」：
 *   计数范围必须与【展示范围】一致。上一版只取重仓 / 轻仓，结果 9/30 当天第 1/第 2 名题材
 *   都是「票少 + 1 个一字」的高风险小题材 ⇒ 买点全部落在兜底方案里 ⇒
 *   Ⓒ 入选次数整块看板一个都不显示（用户实测反馈，已用真实数据 100% 复现）。
 *   ⓘ 2026-10-01 起兜底方案已整体删除，买点只剩 heavy（第 1 名题材）/ light（第 2 名题材）两块；
 *      本函数仍按【槽位列表 + blocks 兜底】的写法遍历 —— 这样万一日后重新加回带 blocks 的方案，
 *      计数范围不会【悄悄】变窄（口径一致性靠结构保证，而不是靠人记得改这里）。
 *   —— 卖点侧【不在口径内】（卖点候选本来就是「昨天买过的票」，计入会把所有题材刷满、无区分度）。
 *
 * @param {object} buy buildBuyPlan 的返回值
 * @returns {Set<string>} 该日买点里出现过的题材名（一天最多算一次，Set 天然去重）
 */
function _buyPointTopics(buy) {
  const out = new Set();
  if (!buy) return out;
  const _add = function(b) {
    if (!b) return;
    const t = b.block ? String(b.block.topic || '').trim() : '';
    if (t) out.add(t);
    (b.blocks || []).forEach(function(bb) {
      const tt = (bb && bb.block) ? String(bb.block.topic || '').trim() : '';
      if (tt) out.add(tt);
    });
  };
  _buyBlocksOf(buy).forEach(function(b) { _add(b); });
  return out;
}

/**
 * 【⑤ 题材入选次数】过去（不含今日）窗口内——含今日共 TOPIC_STREAK_WINDOW 天 ——
 * 每个题材进入【买点】的【天数】（同一题材一天最多算 1 次）。
 *
 * 实现口径（用户 2026-09-30 已确认）：窗口含今日；数【全部买点块】——
 * 见 _buyPointTopics 的口径修正注释（2026-10-01 起买点只剩 第 1 / 第 2 名题材两块）。
 *
 * ⚠️ 成本与 §36：这里要沿着交易日往回重算 4 天（今天的这一次由主流程自己算）。
 *    每次重算是【纯内存组装】（无请求、不写库、不消费额度），且：
 *    ① 只在【非 skipPrevBuy】的主流程里跑一次 ⇒ 内部递归不会再往下展开（否则指数爆炸）；
 *    ② 只在买点方案真有必要（下面直接挂在 buildBuyPlan 之前）时才跑。
 *    ⛔ 不要给它加「递归调用 collectDecisionData」的能力 —— 那正是 ① 要防的。
 *
 * §10 红线：窗口里【任意一天】算不出来（那天的列表 / 正式名单索引还没加载）⇒ 返回 null = 未知。
 *    ⛔ 绝不返回一个「偏低的次数」—— 用户是拿它判题材频率的，少算一次就会误判。
 *
 * @param {string} date 展示日
 * @param {string} mode 当前买点模式（MODE_VOL_RATIO / MODE_YIZI）
 *        [TWO-MODES 2026-10-02] ⚠️ 必须带上：次数是「这个题材进过几次买点」，
 *        而「进买点」本身是【分模式】的结论 —— 拿另一套规则重算会出现「一字模式里显示 3 次入选，
 *        可那 3 次都是量比模式选出来的」这种无法解释的数字（用户正是拿次数判题材频率的，§10 不糊弄）。
 * @returns {Map<string,number>|null} 题材名 → 过去窗口内入选天数（不含今日）；null = 未知
 */
function _topicStreakPast(date, mode) {
  if (!date) return null;
  const days = [];
  let d = date;
  for (let i = 0; i < TOPIC_STREAK_WINDOW - 1; i++) {
    d = getPreviousTradingDay(d);
    if (!d) break;
    days.push(d);
  }
  if (days.length < TOPIC_STREAK_WINDOW - 1) return null;   // 交易日历不完整 ⇒ 窗口不完整

  const counts = new Map();
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    let set = null;
    try {
      // rangeOptional：历史日拿不到十日涨幅，但题材归属不需要它（见 collectDecisionData 的闸门注释）
      const rec = collectDecisionData(day, { skipPrevBuy: true, rangeOptional: true, mode: mode });
      if (rec && rec.ready && rec.buy) set = _buyPointTopics(rec.buy);
    } catch (e) {
      console.warn('[DECISION] 题材入选次数：' + day + ' 重算失败 → 次数按未知处理', e);
      set = null;
    }
    if (!set) return null;                                  // §10：任一天未知 ⇒ 整体未知
    set.forEach(function(t) { counts.set(t, (counts.get(t) || 0) + 1); });
  }
  return counts;
}

/**
 * 【买卖点「标记用数据」的唯一采集入口（§6）】
 *
 * 一句话：这四项是 decision-rules 把标签挂到行上所需的【历史侧】输入 —— 它们不参与任何选票，
 * 只决定「持有 / 加仓 / 昨有买入 / N 次入选 / 先卖后买 / 补涨竞价买」这几枚标记打不打。
 *
 *   · prevBuyNames      = 上一交易日【买点方案】里的股票名（③ 持有：连续两天被选中 = 强势股）
 *   · prevBought        = 上一交易日【实际】打过「买」标签的股票名（④ 行尾改【持有】+ 先卖后买判据）
 *   · prevBoughtTopics  = 把上面这批票按【今日题材】聚合（题材行【昨有买入】）
 *   · topicStreakPast   = 过去（不含今日）窗口内每个题材进过买点几次（题材行【N 次入选】+ 补涨档判据）
 *
 * ⛔ 为什么必须收口成一处：主流程（collectDecisionData）与「题材量比」看板的出口
 *    （dragonRankOnly + topicActionContext）都要这四项。各写一遍的话，
 *    日后 `_prevBoughtNames` 换数据源、或 `_topicStreakPast` 窗口调整时必漏一处，
 *    表现为「某个看板的持有标签悄悄不对」这种极难自查的隐性缺项。
 *
 * §10：四项里任何一项算不出来 → 对应字段为 null（未知），⛔ 绝不退化成空 Set / 空 Map ——
 *      那会被规则层读成「昨天一只都没买 / 这题材从没入选过」。
 * §36：skipPrevBuy=true（内部递归重算历史日买点）⇒ 后两项恒 null，递归不会继续往下展开。
 *
 * @param {{date:string, prevDate:string|null, byName:Map<string,object>, prevDragonNames:Set<string>|null,
 *          mode:string, skipPrevBuy:boolean}} p
 * @returns {{prevBuyNames:Set<string>|null, prevBought:Set<string>, prevBoughtTopics:Set<string>,
 *            topicStreakPast:Map<string,number>|null, prevDragonNames:Set<string>|null}}
 */
function _actionContext(p) {
  const prevBuyNames = p.skipPrevBuy ? null : _prevBuyNames(p.prevDate, p.mode);
  const prevBought = _prevBoughtNames(p.prevDate);
  const prevBoughtTopics = _prevBoughtTopics(prevBought, p.byName);
  const topicStreakPast = p.skipPrevBuy ? null : _topicStreakPast(p.date, p.mode);
  return {
    prevBuyNames: prevBuyNames,
    prevBought: prevBought,
    prevBoughtTopics: prevBoughtTopics,
    topicStreakPast: topicStreakPast,
    prevDragonNames: p.prevDragonNames
  };
}

/**
 * 【卖点候选行】的唯一构造入口（§6）—— 由「昨日打过买标签的股票名」→ buildSellPlan 要的行。
 *
 * ⛔ 收口理由与 _actionContext 相同：主流程与「题材量比」看板的出口都用它，
 *    各写一遍必然在「今天不在任何池里的票（row 缺失）该回落什么」这件小事上分叉。
 *
 * §10：row 缺失（今天不在任何池里，典型 = 继承过来的观察组票）⇒ 各字段回落
 *      getStockCode / getVolRatioDir / getVolRatioTimes / getAuctionShare 现场取一次，
 *      仍取不到就是 null / ''（缺数据），⛔ 绝不补 0、绝不猜方向 —— 用户手上还拿着这只票，
 *      给一个「看着很像真的」的假方向比不给更坏。
 *
 * @param {Set<string>} prevBought 上一交易日打过「买」标签的股票名
 * @param {Map<string,object>} byName 今日 股票名 → 行（含 topic / pct / code / aucPct / aucShare …）
 * @param {string} date 展示日
 * @returns {Array<object>} buildSellPlan 的 rows 入参
 */
function _buildSellRows(prevBought, byName, date) {
  const out = [];
  (prevBought || new Set()).forEach(function(nm) {
    const row = byName ? byName.get(nm) : null;
    // 今日不在列表里（继承过来的观察组票）也要给出卖出建议 —— 用户手上还拿着它
    out.push({
      name: nm,
      topic: row ? row.topic : '',
      pct: row ? row.pct : null,
      // [SELL-LIMIT-UP 2026-10-07 用户口径] 股票代码 —— 判「竞价是不是一字涨停」要用它：
      //   涨停幅度【按板块分】（主板 10% / 创业板·科创板 20% / 北交所 30%），没有代码就只能按主板兜底，
      //   20% 板的票竞价 +10% 时根本不算涨停 ⇒ 会漏判。
      //   ⛔ 与买点 members【同源】（_mkRow 已经算好），这里只透传（§6 单一真相，绝不另查一份）；
      //     今天不在任何池里（row 缺失）⇒ 回落 getStockCode(nm) 查名册，查不到 = ''
      //     ⇒ 规则层按「代码缺失」处理，⛔ 不凭股票名猜板块（§10）。
      code: row ? String(row.code || '') : (getStockCode(nm) || ''),
      // [SELL-OPEN 2026-09-29] 今日竞价涨幅：卖点【细分提示】的唯一依据
      //   （深低开盯盘 / 小低开立刻出 / 小幅高开看分时）。row 不存在（今天不在任何池里）→ null，
      //   规则层按「缺数据」处理，回落原题材排名时点（§10 不猜方向）。
      aucPct: row ? row.aucPct : null,
      // [VR-COMPARE 2026-10-02 用户口径] 今日 vs 上交易日的竞价量比方向（up / flat / down / ''）；
      //   卖点新档位（低开+量比下降 → 立刻出；高开+量比平 → 尾盘卖）的唯一依据。
      //   ⛔ 与行内量比徽标同一个口径函数（vol-ratio-trend#compareVolRatioDirection，§6 单一真相）。
      volRatioDir: row ? row.volRatioDir : getVolRatioDir(nm, date),
      // [SELL-SURGE 2026-10-03 用户口径] 竞价量比倍数（今日 ÷ 上交易日）：
      //   卖点【冲高就卖】档（深低开 + 量比放大 ≥ 5 倍）的唯一依据。null = 未知 ⇒ 该档不生效（§10）。
      volRatioTimes: row ? row.volRatioTimes : getVolRatioTimes(nm, date),
      // [SHARE-RULE 2026-10-03 用户口径] 今日【竞价占比】（%）：卖点动作（尾盘卖 / 竞价卖 / 持有）的唯一主判据。
      //   与买点用的是【同一个函数、同一份数据】（§6）；row 不存在（今天不在任何池里）⇒ 现场取一次，
      //   取不到 → null ⇒ 规则层回落旧口径（§10 不猜）。
      aucShare: row ? row.aucShare : getAuctionShare(date, nm),
      inTodayList: !!row
    });
  });
  return out;
}

/**
 * 【退潮首日 · 市场总龙】采集（第五轮 · 2026-10-13 用户口径，题材量比看板专有）。
 *
 * 用户原话：「市场总龙就是早盘竞价看板股票列表中所有的股票，十日涨幅最高的。
 *   比如今天的新华传媒龙一 AI应用十日涨幅是 159.51%（今日停牌，代表退潮）……
 *   市场第二高的是时代万恒……我说的时间点是昨日，因为当天早上还没收盘计算出来。」
 *
 * ⇒ 口径（★ 全部按用户拍板，⛔ 别自行改）：
 *   · 候选池 = 当日早盘竞价【全列表】（rows，含观察组继承行 / 灰行 / 不成组的票）——
 *     用户明确说「列表中所有的股票」，⛔ 不是「已成题材分组的成员」；
 *   · ★★ [EBB-FIX 2026-10-13 第七轮] 候选池再收一道闸门：【只认有龙位（rank 非 null）的票】。
 *     为什么（实测事故）：10-13 全列表里十日涨幅第一是【善水科技 301190，160.2%】——
 *     它是【创业板】，本看板与早盘竞价都【不发龙标签】（「只发主板龙标签」闸门在 computeDragonRankMap 内）。
 *     用户口径里的「市场总龙」是能承载【题材退潮】语义的那个龙头（他举的例子 = 新华传媒 = AI应用龙一），
 *     一只没有龙标、不属于任何题材龙位的票坐上去 ⇒ 它既没停牌、占比也不看龙头门槛 ⇒ 退潮永不成立
 *     （实测现象：10-13 整个退潮规则静默失效，用户报「完全没变化」）。
 *     ⇒ 总龙 = 「有龙标的票」里昨日涨幅最高者（10-13 = 新华传媒 159.51，今日停牌 ⇒ 退潮成立）。
 *     ⚠️ 这条与「选股只选有龙位的票」「同题材龙位只认有龙位的成员」是【同一把尺子】（§6 同源）。
 *     ⚠️ 它 `rank` 分配【不依赖涨幅】（按题材组内顺序递增）⇒ 早盘 9:26（当日涨幅尚未算出）照样有龙位。
 *   · ★★ [EBB-R20 2026-10-20 用户口径] 涨幅口径【已换】：总龙与买点侧替补改用【20日涨幅前五】
 *     （range20Top = getRange20Leaders(date) 的发布结果，与「20日涨幅」toggle 的总龙一~五同源；
 *     停牌票按每票自己的交易日回溯、靠补位机制照样进榜 —— 十日口径在总龙停牌日恰恰排不出它）。
 *     用户原话「把原来按照10日涨幅改成20日涨幅选股……市场总龙一应该是新华传媒，而不是
 *     按照10日涨幅的慈文传媒」。
 *   · leader = 20日涨幅第一（全市场）；second（卖点侧总龙二）仍按【昨日十日涨幅第二、有龙位】
 *     的旧口径（用户「其它规则不变」）—— 两套口径用途不同，⛔ 别混。
 *
 * ★ 为什么把「事实」与「判定」拆开（§4）：本函数只【读数】（谁是总龙 / 今天停不停牌 /
 *   今天占比多少），是否算「退潮」由规则层 topic-vol-ratio-rules#detectEbbDay 判（纯函数、可单测）。
 *
 * §10：range20Top 没注入（20日前五还没算出来）⇒ ready=false，
 *   ⛔ 绝不返回「今天没有总龙」—— 那会把「还没读到」伪装成「判定过、结果是空」。
 * ⛔ 本函数【不读云】：20日前五与昨日涨幅都由调用方注入（与 dragonRankOnly 的 rangeMap 同一范式）。
 *
 * @param {Array} rows 当日【全列表】行（_mkRow 的产物，含 name / topic / code）—— 含灰行 / 不成组的票
 * @param {Array} topics rankDecisionTopics 的返回（取「总龙所在题材」的成员用）
 * @param {Map} dragonMap 龙位名册（rankDragons 的返回）
 * @param {string} date 展示日
 * @param {Map<string,{pct:number|null}>|null} prevRangeMap 上一交易日的十日涨幅（stock_range_pct）——
 *        只供【卖点侧总龙二】（second）用；缺省 ⇒ second/secondInfo 为 null（卖点侧第二只不出现）
 * @param {Map<string,{pct:number|null}>|null} [rangeMap] 【当日】的十日涨幅（= getDragonRangePct(date)）。
 *        ⚠️ [EBB-R20] 起原本「买点侧唯一那只龙二」的职责已由 range20Top 接管，本参保留只为兼容旧签名。
 * @param {string|null} [prevDate] 上一交易日（prevLeader 首日判据 + 题材退路读取用）
 * @param {Array<{stock:string,code:string,pct:number,days:number}>|null} [range20Top]
 *        ★ [EBB-R20] 20日涨幅前五（总龙一~五）。缺省 / 空 ⇒ ready=false（退潮规则不生效，§10 不猜）。
 * @returns {{ready:boolean, leader:object|null, second:object|null, leaderSuspended:boolean,
 *            leaderShare:number|null, leaderAucPct:number|null, siblingDragons:Array, secondInfo:object|null,
 *            prevLeader:object, buyPicks:Array, buyTrail:Array}}
 *   leader  = { name, pct(20日), topic, code, rank, isYizi }（rank / isYizi 都是【今日】的）
 *   second  = 昨日十日涨幅第二（卖点侧口径，不变）；secondInfo 是它【今日】的龙位 / 一字 / 停牌
 *   prevLeader = ★ [EBB-R8] 【昨日】同一只总龙的竞价状态（首日判据用）：
 *                { volume, share, suspendedLike, shareFail, bad }
 *                · suspendedLike = 昨日【竞价量为 0】（= 那天它没参与集合竞价，停牌语义）；
 *                  ⚠️ §10：量【取不到】（行不存在）⇒ 不算 —— 未知 ≠ 停牌。
 *                · 没传 prevDate（老调用方 / 单测）⇒ 整个 prevLeader = null（未知），
 *                  ⛔ 绝不拼一个「假坏状态」出来。
 *   buyPicks  = ★ [EBB-R20] 买点侧替补【≤2 只】—— 从 20日涨幅总龙一~五里，
 *               排非主板 → 排与总龙一同题材 → 取排名最靠前的前两只（每只含 rank20 / days）。
 *   buyTrail  = 五只每一只的 { name, rank20, topic, pct, picked, reason }（去留与理由，判定可追溯）
 */
/**
 * 某日某票在库里【确实没参与竞价】—— 竞价量写着 0（§10：取不到 = null ⇒ 不算，未知 ≠ 没参与）。
 *
 * ★ [SUSPEND-NOBUY 2026-10-14] 由 _ebbCtxOf 内的私有实现【提升为模块级】：判停牌现在有两个消费方
 *   （退潮首日的 _ebbCtxOf ＋ 买点侧「连续停牌 ⇒ 买不进，顺延下一龙位」），按 §6 只允许一处实现。
 *
 * ⚠️ 数据源 = auction_watchlist 的内存缓存（getAuctionVolume → getStockHistoryValue）。
 * ⚠️ 该行【不存在】⇒ 返 null ⇒ 不算停牌（§10 未知 ≠ 停牌）——
 *    实测 2026-10-14 新华传媒就**不在**这天的 watchlist 里（停牌票上游根本不返回它），
 *    所以「今天停不停牌」不能只靠这条腿，必须走 _suspendedOn 的第①腿（上游快照）。
 *    但「昨天停没停」在历史日只能靠这条腿 —— 10-13 那一行在，且 volume 写着 "0"（实测）。
 */
function _noAuctionOn(d, name) {
  return getAuctionVolume(d, name) === 0;
}

/**
 * ★★ [EBB-R8b 2026-10-14 实测修] 某天某票是不是停牌 —— 本文件唯一的停牌判据（§6）。
 *
 * 为什么不能直接写 `isSuspended(date, name)`：上游两个快照接口【只有当日数据】，
 *   `isSuspended` 在**历史日**恒 false（见 suspend.js#canJudgeSuspended 的注释）。
 *   实测事故：2026-10-14 回看 10-13，总龙【新华传媒】当天停牌（库里 10-13 那一行竞价量 = 0），
 *   但 `isSuspended('2026-10-13', …)` 返 false ⇒ 判据①不成立 ⇒ **退潮首日整套静默失效**
 *   （买点不灰化 / 无退潮不买 / 无龙二 / 无横幅）—— 与用户反复报的「没生效」是同一类事故。
 *
 * 判据（两腿，先权威后回退）：
 *   ① 上游快照 —— `isSuspended`，**仅当它能为这一天作证时**（`canJudgeSuspended(d)`，
 *      即 d 就是今天）才算「权威的否定」；
 *   ② 库内该日该票自己的竞价行 —— 竞价量 = 0 ⇒ 那天没参与集合竞价（= 停牌语义，
 *      与 prevLeader.suspendedLike 逐字同一把尺子）。
 * ⛔ 今日路径行为【零变化】：`canJudgeSuspended(今天)` 恒 true ⇒ 第①腿返 false 时即返回 false，
 *   不会被较弱的「量为 0」改写（§11）。§10：两腿都取不到 ⇒ false（不猜成停牌）。
 *
 * @param {string} d 日期 YYYY-MM-DD（可以是历史日）
 * @param {string} name 股票名
 * @returns {boolean}
 */
function _suspendedOn(d, name) {
  if (isSuspended(d, name)) return true;
  if (canJudgeSuspended(d)) return false;
  return _noAuctionOn(d, name);
}

/**
 * ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 【买点侧】的「买不进名单」= **连续停牌第 2 天及以上**的票。
 *
 * 用户原话：
 *   「10月14日的新华传媒是停牌（非首日），不应该选进买点侧，因为停牌的股票根本不能买，也买不进。
 *     昨日还可以入选因为是首日停牌。新华传媒如果今天复牌，有成交量，有占比等数据，选进去理所当然，
 *     所以改变下规则，停牌首日可选入（已实现），次日还是停牌（没有竞价涨幅，竞价量，昨日成交量等），
 *     就不要选进去了，相当于一字买不进，因为当天有 14 只，选 2 只，退到龙二，龙三，
 *     买点侧的这个题材应该是今天早上的龙二，龙三（因为能买进）。」
 *
 * 口径：
 *   · **首日停牌**（今天停、昨天没停）⇒ ⛔ **不**进本名单 ⇒ 照旧可以入选（用户：「昨日还可以入选」）；
 *   · **连续停牌**（今天停、昨天也停）⇒ 进本名单 ⇒ 买点侧**跳过并顺延到下一龙位**
 *     （与「竞价一字买不进 ⇒ 顺延」同一条处理路径，见 topic-vol-ratio-rules#_buildBlock）；
 *   · 一旦**复牌**（今天有竞价）⇒ 今天不在名单里 ⇒ 理所当然参与选股。
 *
 * ⛔ 只影响【买点侧选股】：退潮判定 / 市场总龙 / 卖点段 / 停牌标记（客观数据）一律不动（§11）。
 * ⛔ 不新建判据：「今天停没停」「昨天停没停」都用本文件唯一的 _suspendedOn（§6）。
 * §10：prevDate 未知（老调用方 / 单测不传）⇒ 返**空集** ⇒ 不跳过任何票（安全降级，不猜）。
 *
 * @param {Array} rows 当日全列表行（含灰行），只需 name 字段
 * @param {string} date 展示日
 * @param {string|null} prevDate 上一交易日
 * @returns {Set<string>} 需要跳过的股票名集合（可能是空集）
 */
export function nonFirstDaySuspendNames(rows, date, prevDate) {
  const out = new Set();
  if (!date || !prevDate) return out;

  // ★★ [SUSPEND-PENDING 2026-10-14 用户实测修] 「今天能判、但还没判出来」这一小段时间，
  //   `_suspendedOn(今天, …)` 会走 `canJudgeSuspended` 分支返 **false** —— 那不是「今天没停牌」，
  //   而是「**还不知道**」（§10 的核心：没有结论 ≠ 否定结论）。
  //   实测事故（用户原话「从 10 月 13 日切到 10 月 14 日时，还是有新华传媒（停牌）进入买点，
  //   刷新后才正常」）：页面刚打开 / 判定还在路上时，昨天停牌的新华传媒被当普通票选进了买点
  //   （渲染出「龙一 新华传媒 +115% 占比 0.000」且没有「连续停牌 ⇒ 顺延」说明），
  //   等判定回来才自愈 —— 「时有时无、刷新一下就好了」就是这段竞态的产物。
  //
  //   ⇒ 保守口径：**昨天停牌 ∧（今天停牌 ∨ 今日判定未就绪且无「今天在竞价」的正面证据）**
  //     ⇒ 先按「买不进」处理。判定一落地 `todayPending` 立刻翻 false，本函数按真实结论重算
  //     （复牌票自然被放回来），⛔ 不会把票钉死；本函数读 `suspendState` ⇒ 判定返回时调用方
  //     的 computed 会自动重算（§17 ref-driven）。
  //   §10 宁缺勿错：宁可少选一只（顺延下一龙位），也不要让一只根本买不进的票占着龙位。
  //   ⛔ 只在**本消费方**做保守处理：退潮 `_ebbCtxOf` 走的还是原 `_suspendedOn`
  //      （把「假设停牌」喂给它会把普通日子误判成退潮日 —— 那是另一种错）。
  const todayPending = canJudgeSuspended(date) && !hasSuspendVerdict(date);

  // 「暂缓」不是「一律封杀」：库内该票【当日】的竞价行若写着成交量 > 0，
  //   就是「今天确实在竞价」的**正面证据**（复牌）⇒ 放行，避免把复牌票在判定未就绪这段时间
  //   里误伤成停牌（那会变成另一种静默少票，§10）。
  //   ⛔ 只认「数字 > 0」；行不存在 / 空值 ⇒ 返 null ⇒ 没有正面证据 ⇒ 保守跳过（新华传媒就是这种）。
  const _tradesToday = function(name) {
    const v = getAuctionVolume(date, name);
    return typeof v === 'number' && v > 0;
  };

  (rows || []).forEach(function(r) {
    const nm = r && r.name;
    if (!nm) return;
    if (!_suspendedOn(prevDate, nm)) return;
    if (_suspendedOn(date, nm)) { out.add(String(nm)); return; }
    if (todayPending && !_tradesToday(nm)) out.add(String(nm));
  });
  return out;
}

/**
 * [DIVERGE 2026-10-20] 题材串「是否同题材」的唯一判据（原 _ebbCtxOf 内私有闭包提升，§6）。
 * 退路题材可能来自上一交易日行情行的 topics 串（如「AI应用,数据中心」）⇒ 按分段匹配。
 * 消费方：ebb 替补选股（本文件）+ 总龙分歧跟随选股（leader-divergence.js）。
 * @param {string} a 题材串 A（可含分段分隔符）
 * @param {string} b 题材串 B
 * @returns {boolean}
 */
export function sameTopicText(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.split(/[,，/、+;；|]/).some(function(seg) { return seg.trim() === y; });
}

/**
 * ★★ [EBB-TOPIC-FIX 2026-10-22] 题材串清洗（§6 唯一实现）：过滤掉「看起来像数」的脏值。
 *
 * 为什么需要：2026-10-22 事故里 tvrb_ebb_days 的 leader_topic 被写成了 '16950' / '26728'
 *   （其实是昨日成交量 —— 根因见 data/watchlist-helpers.js 的 topics 分支注释）。
 *   题材名不可能是【纯数字】，纯数字一定是错值 ⇒ 一律清成空串（= 未知），
 *   ⛔ 绝不把一个数字当题材名去认亲、去和别的题材比较（那会一路静默错下去）。
 *
 * @param {*} raw
 * @returns {string} 清洗后的题材串（可能为空）
 */
export function _cleanTopicText(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return '';
  return s;
}

function _ebbCtxOf(rows, topics, dragonMap, date, prevRangeMap, rangeMap, prevDate, range20Top, range20Wide) {
  const none = {
    ready: false, leader: null, second: null,
    leaderSuspended: false, leaderShare: null, leaderAucPct: null,
    siblingDragons: [], secondInfo: null,
    prevLeader: null, buyPicks: [], buyTrail: [],
    top5: [],        // [DIVERGE 2026-10-20] 缺省空数组（前五没就绪 ⇒ 分歧规则同样不生效）
    newDragonPool: [] // [NEW-DRAGON-08 2026-10-22] 前八候选（切换日新龙判定用）
  };
  // ★★ [EBB-R20 2026-10-20 用户口径] 总龙改用【20日涨幅前五】—— 舍弃「昨日十日涨幅第一」的旧选法
  //   （用户原话「把原来按照10日涨幅改成20日涨幅选股，因为20日比较稳定而且准确，
  //     这样才能选出长期龙头」「市场总龙一应该是新华传媒，而不是按照10日涨幅的慈文传媒」）。
  //   range20Top = getRange20Leaders(date) 的发布结果（与「20日涨幅」toggle 的总龙一~五同源同口径）；
  //   停牌票靠补位机制照样进榜（20日按每票自己的交易日回溯，停牌日不丢腿）——
  //   这正是 20日口径优于十日的地方：总龙停牌那天，十日口径根本排不出它，20日口径排得出。
  //   ⛔ 缺省 / 未发布 ⇒ ready=false，退潮规则不生效（§10：没有总龙 ≠ 排不出总龙，不猜）。
  if (!Array.isArray(range20Top) || range20Top.length === 0) return none;
  const dm = dragonMap || new Map();
  const L = (topics || []);

  /** 某只票【今日】的龙位；无龙位（创业板 / 科创板 / 未成组）⇒ null（与选股同一闸门，§6） */
  const _rankOf = function(name) {
    const d = dm.get(name);
    return (d && d.rank) ? Number(d.rank) : null;
  };
  /** 某只票【今日】是不是竞价一字涨停（读题材成员上的 isYizi，⛔ 不在这里另判一遍，§6） */
  const _isYiziOf = function(name) {
    let y = false;
    L.forEach(function(b) {
      (b.members || []).forEach(function(m) { if (m && m.name === name) y = !!m.isYizi; });
    });
    return y;
  };

  // ⚠️ [SUSPEND-NOBUY 2026-10-14] `_noAuctionOn` / `_suspendOn` 原本是这里的私有闭包，
  //   现已【提升为模块级】（见本文件 `function _noAuctionOn` / `function _suspendedOn`）：
  //   停牌判定现在有两个消费方 —— 退潮首日的事实（本函数）＋ 买点侧「连续停牌 ⇒ 买不进」，
  //   按 §6 只能有一处实现；下面一律调 `_suspendedOn(date, name)`（行为逐字不变）。

  // ── [EBB-R20] 前五事实化：把 range20Top 的 5 只逐一补上【今日】的题材 / 龙位 / 一字 / 停牌 ──
  //   题材解析：今日行（含灰行继承壳 —— 停牌的昨日龙头仍会有壳行带题材）→
  //   退路 = 上一交易日行情行的 topics 串（今日彻底不在列表时；§10 如实，取不到 = ''）。
  const rowByName = new Map();
  (rows || []).forEach(function(r) {
    if (!r || !r.name || rowByName.has(r.name)) return;
    rowByName.set(String(r.name), r);
  });
  const _topicOf = function(name) {
    const r = rowByName.get(name);
    const rt = _cleanTopicText(r && r.topic);
    if (rt) return rt;
    if (prevDate) {
      const t = _cleanTopicText(getStockHistoryValue(prevDate, name, 'topics'));
      if (t) return t;
    }
    // ★ [EBB-TOPIC-FIX 2026-10-22] 第三层退路 = 题材库（停牌补位票在今日列表与昨日 watchlist 里
    //   都可能是空题材）。取法：优先取「今天真的成组」的那个题材名 —— 这样下面 siblings 的
    //   `b.topic === leaderTopic` 反查才能命中；否则按名字排序取第一个（可复现，不随 Set 插入序漂移）。
    try {
      const set = lookupTopicsByName(name);
      if (set && set.size > 0) {
        const all = [];
        set.forEach(function(t) {
          const c = _cleanTopicText(t);
          if (c && all.indexOf(c) < 0) all.push(c);
        });
        all.sort();
        for (let i = 0; i < all.length; i++) {
          for (let k = 0; k < L.length; k++) {
            if (String((L[k] && L[k].topic) || '').trim() === all[i]) return all[i];
          }
        }
        if (all.length > 0) return all[0];
      }
    } catch (e) { /* 题材库未构建 ⇒ 如实返回空串（§10 不猜） */ }
    return '';
  };
  // ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 候选池由「前五」放宽到「前八」：
  //   用户原话「如果前五找不到，你就找前八的，不用前五的，改用排名前八的」。
  //   ⚠️ top5 仍是【前五】（分歧买点 / 退潮替补 / 总龙一~五 标签都用它，⛔ 别一起放宽）；
  //      newDragonPool 才是前八 —— 两个数组共用下面【同一份富化实现】（§6：题材解析只有一处）。
  //   ★ 富化每一只：题材（今日行 → 昨日 topics → 题材库）、今日龙位、竞价一字、停牌、是否主板。
  //     `mainBoard` 的判据用 isMainBoardOnly（§6 唯一实现），规则层不另写代码段规则。
  const _enrich = function(t, i) {
    const name = String(t.stock).trim();
    const pct = Number(t.pct);
    const code = String(t.code || '').trim();
    return {
      name: name, pct: pct, days: Number(t.days) || 0,
      code: code,
      mainBoard: isMainBoardOnly(code),
      topic: _topicOf(name),
      rank: _rankOf(name),
      isYizi: _isYiziOf(name),
      suspended: _suspendedOn(date, name),
      rank20: i + 1
    };
  };
  const _buildPool = function(src, cap) {
    const arr = [];
    const seen = new Set();
    const src2 = (Array.isArray(src) && cap > 0) ? src.slice(0, cap) : src;
    (Array.isArray(src2) ? src2 : []).forEach(function(t, i) {
      if (!t || !t.stock) return;
      const name = String(t.stock).trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      const pct = Number(t.pct);
      if (t.pct === null || t.pct === undefined || !isFinite(pct)) return;   // §10 无值不参排
      arr.push(_enrich(t, i));
    });
    return arr;
  };
  const top = _buildPool(range20Top, 5);
  // 前八候选（同一份富化；rank20 = 20日涨幅名次，⛔ 与截断后的下标无关）
  //   cap=0 ⇒ 不截断：条数由上游 range20-leaders 的 RANGE20_LEADER_WIDE_N 决定（= 8），
  //   ⛔ 不在这里再写一个「8」，否则两处数字会各自漂移（§6 单一真相）。
  const newDragonPool = _buildPool(
    (Array.isArray(range20Wide) && range20Wide.length > 0) ? range20Wide : range20Top,
    0
  );
  if (top.length === 0) return none;
  const head = top[0];
  // 总龙 = 20日涨幅第一（全市场，含创业板 —— 与「20日涨幅」toggle 的总龙一同一只），
  //   并把【它今天】的龙位 / 一字一并带上：规则层判「占比不达标」要按龙头门槛（龙位=1 时）取档。
  //   ⛔ 它若没有龙位（创业板当总龙），门槛自动回落 2% 档（更宽松、更不容易误判退潮）—— 规则层既有逻辑。
  const leader = {
    name: head.name, pct: head.pct, topic: head.topic, code: head.code,
    rank: head.rank,
    isYizi: head.isYizi
  };
  const leaderTopic = String(leader.topic || '').trim();

  // ── 事实 ①：市场总龙【所在题材】内、有龙位的成员（按龙位升序，排除总龙自己）──
  //   规则层据此选「同题材龙二（不可用则顺延龙三…）」，⛔ 它不需要自己读停牌 / 一字。
  const siblings = [];
  if (leaderTopic) {
    const blk = L.filter(function(b) { return String(b.topic || '').trim() === leaderTopic; })[0];
    (blk ? (blk.members || []) : []).forEach(function(m) {
      if (!m || !m.name || m.name === leader.name) return;
      const rank = _rankOf(m.name);
      if (rank === null) return;   // 无龙位（创业板 / 科创板）⇒ 不参与（与选股同一闸门）
      siblings.push({
        name: m.name, rank: rank,
        isYizi: !!m.isYizi,
        suspended: _suspendedOn(date, m.name)
      });
    });
    siblings.sort(function(a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
  }

  // ── 事实 ②：市场总龙二（昨日涨幅第二）的今日龙位 / 一字 / 停牌 ──
  //   用户口径：「不同题材的龙一必须是总市场的龙二」⇒ 判据 = 它今日龙位必须是 1。
  //   ★ [EBB-R20] 卖点侧的【市场总龙二】口径不变（昨日十日涨幅第二、有龙位）—— 用户「其它规则不变」。
  //     买点侧的替补（事实⑤）才改用 20日涨幅前五。两套口径用途不同，⛔ 别混。
  let second = null;
  let secondInfo = null;
  if (prevRangeMap && prevRangeMap.size > 0) {
    const cand = [];
    const seen = new Set();
    (rows || []).forEach(function(r) {
      if (!r || !r.name || seen.has(r.name)) return;
      seen.add(r.name);
      // ★ [EBB-FIX 2026-10-13 第七轮] 闸门：无龙位（创业板 300/301、科创板 688/689、未成组）⇒ 不进候选。
      if (_rankOf(r.name) === null) return;
      const pr = prevRangeMap.get(r.name);
      const pct = (pr && pr.pct !== undefined && pr.pct !== null) ? Number(pr.pct) : null;
      if (pct === null || !isFinite(pct)) return;   // §10：这只票昨日涨幅读不到 ⇒ 不参与排名
      cand.push({ name: r.name, pct: pct, topic: String(r.topic || ''), code: String(r.code || '') });
    });
    cand.sort(function(a, b) {
      if (a.pct !== b.pct) return b.pct - a.pct;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    second = cand.length > 1 ? cand[1] : null;
    if (second) {
      secondInfo = {
        name: second.name, pct: second.pct, topic: String(second.topic || ''),
        rank: _rankOf(second.name),
        isYizi: _isYiziOf(second.name),
        suspended: _suspendedOn(date, second.name)
      };
    }
  }

  // ── 事实 ③：[EBB-R8 2026-10-14 用户口径] 【昨日】这只总龙的竞价状态 —— 「首日」判据的唯一依据 ─
  //   用户原话：「我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
  //     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
  //   ⇒ 今天成立、昨天也成立 ⇒ 不是首日 ⇒ 本规则不生效。
  //
  //   ⛔ 为什么不能用 suspend.js：它两条腿都读【当日】上游快照（无 date 参数），
  //      「昨日停没停牌」它答不了（见 suspend.js 红线）。
  //   ✅ 用【库里的昨日行】：auction_watchlist(prevDate) 那一行 —— 竞价量 0 / 取不到
  //      ⇒ 那天没有参与竞价（与 suspend.js 判据同一语义：无竞价 = 停牌）；
  //      占比走 auction-share 的唯一实现（volume ÷ yest_volume）。
  //   §10：两处都取不到 ⇒ 全部为 null ⇒ 规则层按【无法确认首日】处理（默认仍按首日，见 detectEbbDay）。
  //   ⚠️ prevDate 由【调用方注入】（不是在这里算）：它是「上一交易日」这个业务口径，
  //      主流程（collectDecisionData）与 _buildSellRows 都用同一个 getPreviousTradingDay 得到的一份。
  //      在这里再算一次会把这个纯函数拖进日期工具（连带 localStorage 依赖），也让单测无法独立构造。
  //   ⚠️ §10：prevDate 未知（老调用方 / 单测不传）⇒ prevLeader 必须是 **null**（未知），
  //      ⛔ 绝不能拼出一个 volume=null ⇒ suspendedLike=true ⇒ bad=true 的「假坏状态」——
  //         那等于用「没查」冒充「昨天停牌」，次日判首日会直接判错。
  const prevLeader = !prevDate ? null : (function() {
    const prevVolume = getAuctionVolume(prevDate, leader.name);
    const prevShare = getAuctionShare(prevDate, leader.name);
    const out = {
      volume: prevVolume,
      share: prevShare,
      // 昨日「没有竞价」：量为 0（确实有这一行且写着 0）。⚠️ 取不到（null）【不算】——
      // 取不到 = 库里没有那一天这只票的行（例如那天它还没被加入名单）⇒ 无从判断（§10）。
      // ⛔ 与上面的 _suspendOf 第②腿【同一把尺子】（_noAuctionOn 唯一实现）。
      suspendedLike: _noAuctionOn(prevDate, leader.name),
      // 昨日占比不达标（缺数据 ⇒ false ⇒ 不据此判断 · §10：未知 ≠ 不达标）
      //   ★ [EBB-R20] 取档与今日判据②同一步调：这只票是 20日总龙一 ⇒ 昨日状态也恒按龙头档判
      //     （与 detectEbbDay 的 leaderIsDragonOne=true 同一根因，⛔ 别两处取档不一致）。
      shareFail: (prevShare !== null && !passesAuctionShare(prevShare, true)),
      bad: false
    };
    out.bad = !!(out.suspendedLike || out.shareFail);
    return out;
  })();

  // ── 事实 ⑤：[EBB-R20 2026-10-20 用户口径] 买点侧替补【两只】（原「市场龙二唯一一只」的本轮升级）──
  //   用户原话：「从20日涨幅中的总龙一到总龙五选出两只排名靠前的。而且是不同总龙一题材的股票……
  //     也就是从这五只中，要判断是不是创业板，科创板，北交所等非主板的股票，如果是先排除，
  //     剩下的看是不是和总龙一是同题材，是也排除，剩下的就选排名靠前的那两只。
  //     只选好两只，已经完成任务，后面不选了。」
  //   ⇒ 口径（按用户给的 10-13 / 10-20 两个例子逐条对应）：
  //     · 池子 = 【20日涨幅总龙一~五】（= 上面 top，与「20日涨幅」toggle 的总龙标同源）；
  //     · 总龙一【自己不买】（它正是被判定退潮的那一只）；
  //     · 先排【非主板】（isMainBoardOnly：创业板 300/301、科创板 688/689、北交所一律排除）；
  //     · 再排【与总龙同题材】（题材未知 ⇒ 无法判同题材，⛔ 不猜 —— 该票按「题材未知」放行并留痕）；
  //     · 剩下的按 20日涨幅排名取【前两只】，后面不再选（不足两只就只给算得出的）。
  //   · buyTrail = 五只每一只的【去留与理由】（规则层把它写进行内说明，判定可追溯，§10）。
  const buyPicks = [];
  const buyTrail = [];
  const _sameTopic = sameTopicText;   // [DIVERGE 2026-10-20] 判据提升为模块级共享（分歧跟随选股同用，§6）
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    let reason;
    if (c.name === leader.name) {
      reason = '总龙一本人，正是被判定退潮的那只 ⇒ 不买';
    } else if (!isMainBoardOnly(c.code)) {
      reason = '非主板（创业板/科创板/北交所）⇒ 排除';
    } else if (_sameTopic(leaderTopic, c.topic)) {
      reason = '与总龙一同题材（' + leaderTopic + '）⇒ 排除';
    } else if (buyPicks.length < 2) {
      reason = '主板、与总龙一不同题材 ⇒ 入选';
      buyPicks.push({
        name: c.name, pct: c.pct, days: c.days, topic: c.topic, code: c.code,
        rank20: c.rank20, rank: c.rank, isYizi: c.isYizi, suspended: c.suspended
      });
    } else {
      reason = '两只替补已选满 ⇒ 不再选（用户口径「只选两只，后面不选了」）';
    }
    buyTrail.push({
      name: c.name, rank20: c.rank20, topic: c.topic, pct: c.pct,
      picked: (reason.indexOf('入选') >= 0), reason: reason
    });
  }

  return {
    ready: true,
    leader: leader,
    second: second,
    // ★ [DIVERGE 2026-10-20] 前五事实化结果原样透出（name/pct/days/code/topic/rank/isYizi/suspended/rank20）：
    //   「市场总龙一首次分歧」买点规则要用它挑【不同题材的主板高标】（20日涨幅前五）——
    //   题材解析（今日行 → 昨日 topics 退路）只有这一份实现（§6），⛔ 规则层绝不自己再解析一遍题材。
    top5: top,
    // ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 20日涨幅【前八】富化结果 —— 第二十八条切换日
    //   「挑新龙」的候选池（用户「如果前五找不到，你就找前八的」）。
    //   ⚠️ 与 top5 同一份富化（题材/龙位/一字/停牌/是否主板），只是多 3 只；⛔ 分歧买点仍只认 top5。
    newDragonPool: newDragonPool,
    // 停牌走 suspend.js 的唯一实现（§6），⛔ 不在这里另判一遍。
    //   [EBB-R8b] 走 _suspendOf：今日 = 上游快照；历史日回退库内该日竞价行（见 _suspendOf 的 JSDoc）。
    leaderSuspended: _suspendedOn(date, leader.name),
    // 今日竞价占比（%）：null = 缺数据（规则层据此【不判】不达标，§10：未知 ≠ 不达标）
    leaderShare: getAuctionShare(date, leader.name),
    // ★ [DIVERGE-GATE 2026-10-21] 总龙【今日竞价涨幅】（%）：null = 缺数据。
    //   消费方 = 题材量比组合式的【分歧判定门控】（同步预检）：分歧日的必要条件 = 总龙今日低开
    //   （竞价涨幅 < 0）—— 该值从【今日行】读（auc_pct_chg，parseAucPct 唯一实现，§6 不另写一份）。
    //   总龙不在今日行（20日补位壳行等）⇒ null ⇒ 组合式按【保守等待】处理（宁可多等不错显，§10）。
    leaderAucPct: (function() {
      const r = rowByName.get(head.name);
      return r ? parseAucPct(r.auc_pct_chg !== undefined && r.auc_pct_chg !== null
        ? r.auc_pct_chg : r.aucPctChg) : null;
    })(),
    siblingDragons: siblings,
    secondInfo: secondInfo,
    // ★ [EBB-R8] 首日判据（昨日同一只总龙的竞价状态）
    prevLeader: prevLeader,
    // ★ [EBB-R20] 买点侧替补两只 + 五只去留留痕（当日 20日涨幅口径，规则层据此渲染与写说明）
    buyPicks: buyPicks,
    buyTrail: buyTrail
  };
}

/**
 * 采集并计算某日的决策结论（同步：数据源全在内存里）。
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {{skipPrevBuy?:boolean, rangeOptional?:boolean, mode?:string,
 *          dragonRankOnly?:boolean, topicActionContext?:boolean, rangeMap?:Map,
 *          prevRangeMap?:Map, range20Top?:Array}} [opts]
 *        skipPrevBuy=true → 不往回算上一交易日的买点（内部递归用，防止无限往前追）
 *        rangeOptional=true → 【十日涨幅没加载也继续算】（§10 的例外，见下方闸门注释）。
 *          只给「近 5 个交易日题材入选次数」的历史日重算用；⛔ UI 展示日【绝不要】传它 ——
 *          那样会拿一份没有涨幅的数据去给出买卖点，等于 §10 红线。
 *        mode = 买点模式（MODE_VOL_RATIO / MODE_YIZI），默认 MODE_VOL_RATIO。
 *          [TWO-MODES 2026-10-02] 由 useDecisionBoard 从早盘竞价的题材 / 一字 toggle 判定后传进来
 *          （判定见 decision-mode.js#resolveDecisionMode）。⛔ 本文件不自己读 store ——
 *          collect 是纯数据组装，模式属于「上游口径」，只接受入参。
 *          ⚠️ 历史日重算（_prevBuyNames / _topicStreakPast）必须【原样转发同一个 mode】。
 *        [DRAGON-RANK-CHANGE 2026-10-09] 下面两个只有「算前一交易日龙位表」在用，
 *        ⛔ UI 展示日调用【绝不要】传（属于模块内部出口，见 collectDragonRankMap）：
 *          dragonRankOnly=true → 算到 rankDragons 就返回（只出龙位表，不排买卖点）。
 *          rangeMap = 十日涨幅的【注入来源】——历史日不在 dragon-rank 的单日期主状态里
 *            （getDragonRangePct(历史日) 恒为 null，见 dragon-rank.js 的逐日期闸门），
 *            由调用方把云端按日读回的那份传进来。⛔ 本文件【绝不自己去读云】。
 *        [TVRB 2026-10-11 用户口径] topicActionContext=true → 只在 dragonRankOnly 出口上生效：
 *          额外采回【买卖点标签上下文 + 卖点候选行】（见 _actionContext / _buildSellRows）。
 *          ⛔ 默认关（undefined = false）：算前一交易日龙位表的调用方不传它，
 *            因而不会白付「回溯 4 天题材入选次数 + 重算昨日买点」这份开销（§36）。
 *        [EBB 2026-10-13 第五轮用户口径] prevRangeMap = 上一交易日的十日涨幅（Map&lt;股票名,{pct}&gt;）——
 *          只在 topicActionContext 出口用，用来算「市场总龙 / 总龙二」（见 _ebbCtxOf）。
 *          ⛔ 必传「昨日」那份：停牌票当天没有十日涨幅，用当日口径恰恰排不出总龙。
 *          缺省（不传）= 该能力退化为「未就绪」，退潮规则不生效（§10，⛔ 不猜成「没有总龙」）。
 * @returns {{ready:boolean, reason:string, topics:Array, buy:object, sell:Array}
 *           |{ready:true, dragonRankOnly:true, topics:Array, dragonMap:Map, <topicActionContext 的附加字段>}}
 */
export function collectDecisionData(date, opts) {
  const skipPrevBuy = !!(opts && opts.skipPrevBuy);
  const rangeOptional = !!(opts && opts.rangeOptional);
  const dragonRankOnly = !!(opts && opts.dragonRankOnly);
  // [TVRB 2026-10-11] 只在 dragonRankOnly 出口上生效的附加开关（见下方出口注释）
  const topicActionContext = !!(opts && opts.topicActionContext);
  // ⛔ 非法 / 缺失一律回落 MODE_VOL_RATIO（§10：绝不因为参数没传就抛错）
  const mode = normalizeDecisionMode(opts && opts.mode);
  if (!date) return _notReady('未选择日期');

  const prevDate = getPreviousTradingDay(date);
  const list = getTodayGroupList('auction', date) || [];
  if (list.length === 0) return _notReady('当日早盘竞价列表为空（数据可能尚未抓取）');

  // §10 闸门：题材【只数】是买入建议的核心依据（「股票数量n只」直接写进理由）。
  // 正式名单索引未就绪时 getTodayGroupList 会退化成原始列表（含观察组/影子行）→ 只数偏多 →
  // 可能把第 1 名题材判错、把不该买的票推成龙二。宁可不给建议，也不给错的建议。
  if (!_isAuctionWatchlistIndexReady(date)) return _notReady('当日正式名单尚未加载完成，暂不给建议');

  // 十日涨幅是「龙一/龙二」的唯一依据：没加载 ⇒ 无法给出买卖建议（§10 不拿空数据冒充结论）
  //
  // [TOPIC-STREAK 2026-09-30] rangeOptional 的正当性（唯一的例外场景）：
  //   「近 5 个交易日题材入选次数」要对【历史日】重算买点，但 getDragonRangePct 只持有一个日期
  //   （dragonState.date === 当前展示日）⇒ 历史日必然拿不到涨幅 ⇒ 一律 _notReady ⇒ 功能没法做。
  //   而【题材归属 / 名次 / 一字数】完全不需要涨幅（rankDecisionTopics 只看 name/topic/isYizi/
  //   countable/aucVolRatio），涨幅只影响【题材内部的「龙几」标签】与「量比并列时的稳定次序」
  //   —— 都不改变「哪个题材进了买点」这个结论。因此只取 heavy / light 的题材名时，涨幅缺失不影响正确性。
  //   ⚠️ 代价：rangeOptional 下灰行（观察组继承票，需有十日涨幅才纳入）会被统一排除；
  //      灰行 countable=false，本来就不进题材只数，故对题材结论无影响（见 _mkRow / 灰行注释）。
  let rangeMap = getDragonRangePct(date);
  // [DRAGON-RANK-CHANGE 2026-10-09] 历史日（算前一交易日龙位表时）的涨幅由【调用方注入】：
  //   主状态只持有当前展示日 ⇒ 历史日必然为 null。⚠️ 只在显式传了 rangeMap 时才用它，
  //   ⛔ 且【绝不给现有调用路径】开这个口子（dragonRankOnly 才传，见 collectDragonRankMap）——
  //   否则「最近 5 日题材入选次数」等历史日重算会突然拿到一份涨幅、产出与以前不同的结论。
  if ((!rangeMap || rangeMap.size === 0) && opts && opts.rangeMap) {
    rangeMap = (opts.rangeMap instanceof Map && opts.rangeMap.size > 0) ? opts.rangeMap : null;
  }
  if (!rangeMap || rangeMap.size === 0) {
    if (!rangeOptional) return _notReady('十日涨幅 / 龙头数据尚未加载完成');
    rangeMap = new Map();
  }

  const inheritSold = getPrevSoldInheritedSet(date, prevDate);
  const pmap = getPrimaryTopicMap(list);
  // [MAJORITY-SIDE 2026-09-24] 兜底行（不在正式列表内的注入行）也遵守「站队到数量多的一边」
  const psize = buildTopicSizeMap(pmap);

  // 昨日龙头名册（= 前一交易日评选出的龙头）：Map<name,{topic,pct,groupSize,code}>
  // ⛔ 未加载时【传 null】而不是空 Set：空 Set 会让规则层把「还没拉到」判定成「昨日非龙头」（§10）。
  // [GRAY-DRAGON 2026-09-26] 提前到这里：它同时还是【灰行】的来源（见下方 _pushGrayRows）。
  const prevDragonMap = getDragonLeadersForDisplay(date);
  // [SHARE-RULE 2026-10-03 用户口径 / DRAGON-TIER 2026-10-06] 昨日龙头名册的【名字集合】——「龙头」判定的
  //   第二条腿（今日【龙一】是第一条腿）。⛔ 名册未加载时【传 null】而不是空 Set：
  //   空 Set 会让规则层把「还没拉到」判定成「昨日非龙头」（§10），从而给错门槛（3.5% 变 2%）。
  //   ⚠️ [BOOT-GATE 顺序] 提前到这里是因为【买点】也要用它（_decorateShareAction 判门槛），
  //      原来只在卖点前算一次，现在两处共用同一份（§6 一处采集、两处复用）。
  const prevDragonNames = prevDragonMap ? new Set(Array.from(prevDragonMap.keys())) : null;

  // [GRAY-DRAGON 2026-09-26] 当日已抓到数据的行（含 market_metrics 影子行）→ 给灰行回填真实竞价涨幅。
  // 与早盘竞价 view-helpers 的 _auctionDayRowMap 同一份数据来源（§6），⛔ 不另找一份。
  const _dayRowMap = new Map();
  try {
    (getAuctionData()[date] || []).forEach(function(r) {
      if (r && r.stock) {
        const k = String(r.stock).trim();
        if (k && !_dayRowMap.has(k)) _dayRowMap.set(k, r);
      }
    });
  } catch (e) {
    // §10：取不到就按「没有回填」处理（灰行竞价涨幅 = null），绝不抛给渲染层
  }

  const rows = [];
  const byName = new Map();
  const seen = new Set();

  /** 组装一行（正式列表行 / 灰行共用，保证口径一致） */
  const _mkRow = function(nm, raw, countable) {
    const code = (raw && (raw.code || raw.stockCode)) || getStockCode(nm) || '';
    const topic = pmap.has(nm) ? pmap.get(nm) : classifyStockPrimaryTopic(raw || { stock: nm }, psize);
    const rm = rangeMap.get(nm);
    return {
      name: nm,
      topic: String(topic || '').trim(),
      code: String(code || '').trim(),
      isYizi: isAuctionYiZi(raw || { stock: nm }, code),
      // 当日竞价涨幅（%）：null = 缺数据。解析器复用 limit-up.js#parseAucPct（§6 单一实现），
      // 与早盘竞价「龙标红底 = 竞价涨幅>0」完全是同一个值 —— 决策看板说的是「买红色的那几只」。
      aucPct: parseAucPct(raw ? (raw.auc_pct_chg || raw.aucPctChg) : null),
      // [VRATIO-PICK 2026-10-01 用户口径] 当日【竞价量比】（倍数）：买点选票的新依据。
      //   与早盘竞价看板展开面板那行「竞价量比」、以及本看板行内徽标完全是同一个字段
      //   （market_metrics(scope='auction').auc_vol_ratio，§6 单一真相），⛔ 不另取一份。
      //   ⛔ 这里只【搬运原始值】：云端存的是字符串（如 "2.18"），解析统一交给规则层的 _num
      //      （与成员 pct / aucPct 同一处口径），保证「缺值 → null」的 §10 语义只写一遍。
      aucVolRatio: raw
        ? (raw.auc_vol_ratio !== undefined ? raw.auc_vol_ratio : raw.aucVolRatio)
        : null,
      // [VR-COMPARE 2026-10-02 用户口径] 今日 vs 上交易日竞价量比方向（up / flat / down / ''）。
      //   ⚠️ 必须在【规则层之前】挂好：买点（尾盘买 / 先卖后买）与卖点（立刻出 / 尾盘卖）
      //      都要在 buildBuyPlan / buildSellPlan 里读它，晚了就只能事后补，业务判断会落到 collect 层（§4 破）。
      //   ⛔ 口径走 vol-ratio-trend#getVolRatioDir（与行内量比徽标同一函数，§6 单一真相）。
      volRatioDir: getVolRatioDir(nm, date),
      // [SELL-SURGE 2026-10-03 用户口径] 今日 ÷ 上交易日的竞价量比【倍数】（null = 缺数据 / 除不出来）。
      //   ⚠️ 与 volRatioDir 是【两个不同口径】：方向回答「强了还是弱了」（整数差），
      //      倍数回答「放大了多少」（除法）。⛔ 别互相替代 —— 「增加 5 倍以上」只能靠倍数判。
      volRatioTimes: getVolRatioTimes(nm, date),
      // [DIVE-BUY 2026-10-07 用户口径 · 爱仕达 9/7] 今日 vs 上交易日竞价量比的【整数差】（四舍五入后作差）。
      //   买点【下杀买（竞价异常）】的三项硬指标之一（用户口径「比上个交易日多 30」）。
      //   ⛔ 与 volRatioDir（方向）、volRatioTimes（倍数）是三个口径，谁都别替代谁；缺一天 → null（§10 不猜）。
      volRatioDelta: getVolRatioDelta(nm, date),
      // [SHARE-RULE 2026-10-03 用户口径] 当日【竞价占比】（%）= 当日竞价量 ÷ 昨日成交量。
      //   与早盘竞价第一页那个占比【同一个公式、同一份数据】（auction_watchlist 同一行的
      //   volume / yest_volume），只是【展示精度不同】：第一页 = 取整，本看板 = 保留 1 位小数。
      //   买卖【时机】的唯一主判据（占比达标 → 竞价买 / 尾盘卖；不达标 → 尾盘买 / 竞价卖）。
      //   ⛔ 只在这里算一次，规则层只搬运（§6 单一真相）；缺数据 → null（§10 绝不当 0）。
      aucShare: getAuctionShare(date, nm),
      pct: (rm && rm.pct !== undefined && rm.pct !== null) ? rm.pct : null,
      countable: countable,
      inheritSold: inheritSold.has(nm)
    };
  };

  list.forEach(function(r) {
    if (!r || !r.stock) return;
    const nm = String(r.stock).trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    const row = _mkRow(nm, r, !inheritSold.has(nm));
    rows.push(row);
    byName.set(nm, row);
  });

  // [GRAY-DRAGON 2026-09-26] 灰行 = 早盘竞价里「灰色名称 + 灰色题材」的行 = 【不在当日正式列表】。
  //   用户（两次）要求：灰行也要能进买点 —— 它们代表的是【老龙 / 观察组继承票】，有参考价值。
  //   事故现场：9/8 第 1 名题材大消费的龙一 = 国芳集团（灰），第 2 名题材农业的龙一 = 万向德农（灰）。
  //
  //   ⛔ 上一版只补了【昨日龙头名册】一个来源，覆盖不到观察组继承票（万向德农就属于这一类）→ 没修全。
  //      本次改成与 view-helpers#computeAuctionViewData 的注入行【三个来源完全同源】（§6 单一真相）：
  //        ① 前一日「竞昨高光」继承票（观察组主来源）  getJingYestHighlightSetForDate(prevDate)
  //        ② 前一日打标签买入继承票                    obsBought_<date>
  //        ③ 昨日龙头名册继承壳                        getDragonLeadersForDisplay(date)
  //      这与 dragon-group.js#_buildPool 的候选池口径也是同一套（只是它没导出，故在此按同一顺序复刻）。
  //
  //   countable=false ⇒ 不进题材数量 / 一字数统计（与早盘竞价统计条同口径）；
  //   龙位与选票【不因任何灰行身份而排除】—— 连「昨日卖标签继承」的行也照常参与
  //   （2026-09-27 修正：9/8 大消费龙一国芳集团就是「灰名 + 灰题材 + 灰色实心卖标签」，用户要它入选）。
  const _grayNames = new Set();
  try {
    const obs = prevDate ? getJingYestHighlightSetForDate(prevDate, 'auction') : null;
    if (obs && typeof obs.forEach === 'function') {
      obs.forEach(function(n) { if (n) _grayNames.add(String(n).trim()); });
    }
  } catch (e) {
    // §10：读失败 ≠ 空集合。这里只影响灰行的【补充来源】，主池仍可用，故如实记日志不静默吞掉。
    console.warn('[DECISION] 竞昨高光继承集读取失败，灰行来源缺失该部分', e);
  }
  try {
    // 合规（§8）：obsBought_<date> 是「防重复 / 调试标记」型本地缓存，与 view-helpers 同源；
    // 它不是业务真相源（业务真相 = auctionTagStore），仅用于还原观察组继承池。
    const bought = JSON.parse(localStorage.getItem('obsBought_' + date) || '[]');
    (bought || []).forEach(function(n) { if (n) _grayNames.add(String(n).trim()); });
  } catch (e) { /* 无 localStorage / 解析失败 → 忽略该来源，不影响主池 */ }
  if (prevDragonMap) {
    Array.from(prevDragonMap.keys()).forEach(function(n) {
      if (n) _grayNames.add(String(n).trim());
    });
  }

  _grayNames.forEach(function(n) {
    const nm = String(n || '').trim();
    if (!nm || seen.has(nm)) return;                // 已在正式列表里 → 不是灰行
    const rm = rangeMap.get(nm);
    // §10：没有十日涨幅就排不进龙位，补进来只是噪声 → 不补
    if (!rm || rm.pct === null || rm.pct === undefined) return;
    // ⛔ 不再因「昨日卖标签继承」跳过（09-27 用户口径：这类灰行也要能入选买点）
    seen.add(nm);
    const meta = prevDragonMap ? prevDragonMap.get(nm) : null;
    const raw = _dayRowMap.get(nm) || { stock: nm, code: (meta && meta.code) || '' };
    const row = _mkRow(nm, raw, false);
    rows.push(row);
    byName.set(nm, row);
  });
  if (rows.length === 0) return _notReady('当日列表没有可用于决策的股票名');

  const topics = rankDecisionTopics(rows, mode);
  if (topics.length === 0) return _notReady('当日没有成组的题材（题材至少 2 只才成组）');

  const dragonMap = rankDragons(topics);

  // [DRAGON-RANK-CHANGE 2026-10-09] 内部出口：只要「这一天的题材龙位表」。
  //   用途 = 算【前一交易日】的龙位（决策看板龙标旁边的名次变化徽标）。
  //   ⚠️ 为什么必须借用本函数（而不是另写一份「读名单 → 分题材 → rankDragons」）：
  //     昨今两个名次必须用【同一把尺子】量 —— 一样的行集合（含灰行）、一样的题材分组、
  //     一样的成组门槛。另写一份必然分叉，而分叉出来的差值会是一个看着很像真的假数字（§6 红线）。
  //   ⛔ 走到这里就返回：不排买卖点、不回溯历史，因此这个出口【天然不会递归】。
  //   ⛔ dragonRankOnly 归还的是【中间产物】（不是完整决策），调用方（store）自己知道怎么用。
  if (dragonRankOnly) {
    const out = {
      ready: true,
      reason: '',
      dragonRankOnly: true,
      date: date,
      prevDate: prevDate,
      topics: topics,
      dragonMap: dragonMap
    };
    // ── [TVRB 2026-10-11 用户口径] 「题材量比」看板要的【买卖点标签上下文】──────────────
    //   那个看板只替换【选股】，标签管线一律复用 decision-rules#finishBuyBlock / buildSellPlan
    //   （用户原话「买入和卖出基本逻辑一样，只是选股不同」）。为此它需要三样东西：
    //     ① 五个标记数据（prevDragonNames / prevBuyNames / prevBought / prevBoughtTopics /
    //        topicStreakPast）—— 没有它们，持有 / 昨有买入 / N 次入选 / 先卖后买 / 补涨 全打不出来；
    //     ② sellRows —— 卖点候选行（它自己调 buildSellPlan，今天的买点名单要用【它自己的选股】，
    //        所以卖点计划不能在这里替它算死）。
    //   ⛔ 缺一不可：少给一项，那边的标签就会【静默】缺一枚（最难查的那种）。
    //   ⛔ 必须由显式开关打开：本出口原来的唯一调用方是 dragon-rank-change-store
    //      （算前一交易日龙位表，每天调用多次），它不传 topicActionContext ⇒
    //      不会白付「回溯 4 天题材入选次数 + 重算昨日买点」这份开销（§36 性能红线）。
    if (topicActionContext) {
      const act = _actionContext({
        date: date, prevDate: prevDate, byName: byName,
        prevDragonNames: prevDragonNames, mode: mode, skipPrevBuy: false
      });
      out.prevDragonNames = prevDragonNames;
      out.prevBuyNames = act.prevBuyNames;
      out.prevBought = act.prevBought;
      out.prevBoughtTopics = act.prevBoughtTopics;
      out.topicStreakPast = act.topicStreakPast;
      out.sellRows = _buildSellRows(act.prevBought, byName, date);
      // ★ [EBB-R20 2026-10-20] 退潮判定所需的事实：市场总龙（20日涨幅第一）+ 买点侧替补两只
      //   （range20Top 注入）＋ 卖点侧总龙二（昨日十日涨幅第二，prevRangeMap 注入，口径不变）。
      //   + 它今天停不停牌 / 占比多少。涨幅必须用【昨日】那份（停牌票当天没有涨幅），
      //   由调用方读回后从 opts.prevRangeMap 注入 —— ⛔ 本文件不读云。
      // ★ [EBB-R8 2026-10-14 用户口径] 再注入【当日】rangeMap：买点侧唯一那只（市场龙二）
      //   用的是【当日】十日涨幅（用户举的例子 = 九阳股份 当日 86%）—— 与总龙的「昨日」口径
      //   是两个不同用途（总龙要在停牌时也排得出；龙二只看今天强不强），⛔ 别合并成一个参数。
      //   + 第 7 参 prevDate：算「昨日同一只总龙的竞价状态」（首日闸门用）—— 复用本函数已算好的那份，
      //     ⛔ 不让 _ebbCtxOf 自己再算一次（它会变成非纯函数，单测无法独立构造）。
      //   + 第 8 参 range20Top：[EBB-R20] 20日涨幅前五（总龙一~五）—— 总龙与买点侧替补的【唯一】来源，
      //     由调用方（组合式）ensureRange20Leaders 后注入；缺省 ⇒ ebbCtx.ready=false，退潮规则不生效（§10）。
      out.ebbCtx = _ebbCtxOf(rows, topics, dragonMap, date,
        opts && opts.prevRangeMap, rangeMap, prevDate, opts && opts.range20Top,
        opts && opts.range20Wide);
    }
    // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「买不进名单」= 连续停牌第 2 天及以上的票。
    //   放在本出口的【公共段】（⛔ 不在上面 topicActionContext 分支里）：这份名单只依赖
    //   rows + date + prevDate（本函数手上就有），与「要不要回溯历史买点」无关 ——
    //   分开放即可让它走最便宜的路径，不必替不关心它的调用方白付回溯开销（§36）。
    //   ⚠️ 成本 = O(n) 次 Set / Map 命中（n = 当日列表只数，通常 < 200）；无网络、无额度。
    //   ⛔ 消费方只有一个：topic-vol-ratio-rules#_buildBlock（买点侧选股顺延）。
    //      退潮判定 / 市场总龙 / 卖点段一律不看它（§11）。
    out.buySkipSuspend = nonFirstDaySuspendNames(rows, date, prevDate);
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 当日名单的【十日涨幅池】——
    //   topic-vol-ratio-rules 第二十九条（十日涨幅 · 在列次数候补）的候选来源：
    //   用户原话「排名第二的题材如果量比太小就用十日涨幅首次在列进行候补……排名前十」。
    //   ⛔ 为什么在这里给而不是让规则层从 topics 里翻：`topics` 是按题材分组的、且【成组门槛】
    //     与【空题材行】都会漏掉一些行 —— 那样排出来的「前十」就不是早盘竞价看板上
    //     10日涨幅 toggle 的那十行（用户数的是屏幕行号）。rows 才是与看板同一批行。
    //   ⚠️ 只搬运 name / code / topic / pct（pct = 该票当日十日涨幅，来自 rangeMap，§6 同一份真相）；
    //      排序 / 名次 / 板块判定一律交给 range10-backup.js（⛔ 本层不做业务判断，§4）。
    //   成本 = O(n) 一次 map（n = 当日列表只数，通常 < 200），无网络、无额度。
    //
    // 🔴🔴 [R10-POOL 2026-10-24 事故修复] 必须再并进【20日涨幅前五的补位行（「20天」票）】。
    //   事故现场（10-23）：屏幕第 3 行是【慈文传媒 +79.11% / 8次在列】——它是 20 日补位票，
    //   **不在 auction_watchlist 里**，所以只按 `rows` 建池时它缺席 ⇒ 后面每只票的名次整体【前移一位】，
    //   于是主板第 11 名的【上海九百】（屏幕上没有标签、根本不在前十）被当成第 10 名，
    //   在兆威机电（真正的「首次在列」、主板第 8 名）被别的条件剔除后顶了上来 ⇒ 用户报「怎么选了上海九百」。
    //   ⇒ 用户口径「排名前十」= 早盘竞价看板 10日涨幅 toggle 上【带在列次数标签的那十只】，
    //     而那十只是【含补位行】一起排序的（assignPresenceLabels 收到的是含补位行的 items）。
    //     §6：池子必须与屏幕同一批行，否则「名次」这把尺子就不是同一把。
    //   ⚠️ 补位行从 range20Top（= getRange20Leaders 的发布结果，与 view-helpers 的注入口同一个来源）来，
    //      ⛔ 本层不自己去算 20 日涨幅、也不发请求。
    //   ⚠️ 补位行恒有「20日涨幅」，但【十日涨幅】可能没有（§10 ⇒ pct=null ⇒ 不占名次，与屏幕一致）。
    //   ⚠️ 题材走 classifyStockPrimaryTopic（与 _mkRow 的兜底同一条路：它会回落到历史题材库），
    //      ⛔ 不给补位票编一个 '其它' 之外的假题材。
    const r10Pool = rows.map(function(r) {
      return { name: r.name, code: r.code, topic: r.topic, pct: r.pct };
    });
    const r10Seen = new Set();
    r10Pool.forEach(function(r) { r10Seen.add(String(r.name || '').trim()); });
    const r20ForPool = (opts && Array.isArray(opts.range20Top)) ? opts.range20Top : null;
    if (r20ForPool) {
      r20ForPool.forEach(function(m) {
        const nm = String((m && (m.stock || m.name)) || '').trim();
        if (!nm || r10Seen.has(nm)) return;
        r10Seen.add(nm);
        const rm = rangeMap.get(nm);
        r10Pool.push({
          name: nm,
          code: String((m && m.code) || getStockCode(nm) || '').trim(),
          topic: String(classifyStockPrimaryTopic({ stock: nm }, psize) || '').trim(),
          pct: (rm && rm.pct !== undefined && rm.pct !== null) ? rm.pct : null
        });
      });
    }
    out.range10Rows = r10Pool;
    // ★ [R10-POOL] 池子【是否与屏幕同一批行】：补位数据没就绪（range20Top = null）时无法确认，
    //   ⇒ 名次可能整体错位 ⇒ 规则层据此【不选候补】（§10 判不出 ≠ 随便选一只）。
    //   ⚠️ 空数组是有效答案（当天确实没有补位票）⇒ complete = true。
    out.range10PoolComplete = !!r20ForPool;
    return out;
  }

  // [TWO-MODES 2026-10-02 / NO-YIZI 2026-09-25 恢复] 一字模式的【老版规则】里有两条兜底
  //   （⑤ 全部题材无一字 / ⑥ 高风险小题材）以及第 2 名题材的「题材替换」，都要读
  //   【连板天梯 · 题材连扳】的分组；量比模式【一律不采】（§36 性能红线）。
  //   触发条件与老版 1:1（decision-mode.js#needsLadderData，§6 收口在一处）。
  //   ⚠️ 这里是【懒采集】：不触发就不跑那次全量行归堆。
  const needLadder = needsLadderData(topics, mode);
  const ladder = needLadder ? _ladderTopicGroups(date) : null;
  // 【③ 持有 / 加仓】【④ 昨天已买】【④ 题材级 · 昨有买入】【⑤ 题材入选次数】
  //   —— 四项「标记用数据」的唯一采集入口（§6：主流程与「题材量比」看板的出口共用同一份，
  //     见 _actionContext 的长注释；⛔ 别再在这里逐行展开一遍）。
  const act = _actionContext({
    date: date, prevDate: prevDate, byName: byName,
    prevDragonNames: prevDragonNames, mode: mode, skipPrevBuy: skipPrevBuy
  });
  const prevBuyNames = act.prevBuyNames;
  const prevBought = act.prevBought;
  const prevBoughtTopics = act.prevBoughtTopics;
  const topicStreakPast = act.topicStreakPast;
  const buy = buildBuyPlan(topics, dragonMap, {
    // 一字模式（老版规则）才需要的连板天梯分组；量比模式下是 [] / false
    ladderTopicGroups: ladder ? ladder.groups : [],
    ladderReady: ladder ? ladder.ready : false,
    ladderReason: ladder ? ladder.reason : '',
    prevBuyNames: prevBuyNames,
    prevBoughtNames: prevBought,
    prevBoughtTopics: prevBoughtTopics,
    topicStreakPast: topicStreakPast,
    // [SHARE-RULE 2026-10-03 用户口径 / DRAGON-TIER 2026-10-06] 判「龙头」的第二条腿：昨日是否在龙头名册里。
    //   null = 名册未加载 ⇒ 规则层只按今日龙位判，并在说明文字里写明「昨日名册未加载」（§10 不猜）。
    prevDragonNames: prevDragonNames
  }, mode);

  // 昨日龙头名册的名字集合已在【买点之前】算好（prevDragonNames）—— 买卖两侧共用同一份，⛔ 不重复取第二次。

  // 卖点候选行 = 昨日打过「买」标签的股票（构造收口在 _buildSellRows，§6）
  const sellRows = _buildSellRows(prevBought, byName, date);
  // 【三 · 持有 / 加仓（卖点侧）】今天又在买点里的卖点候选 = 连续两天被选中 = 强势股，标【持有 / 加仓】
  const todayBuyNames = _buyPlanNames(buy);
  const sell = buildSellPlan(sellRows, topics, dragonMap, prevDragonNames, todayBuyNames);

  // [VRATIO-TREND 2026-10-01 用户口径] 给买点 / 卖点的每一行挂【竞价量比】的当日数值 + 近 5 日走势。
  //   ⛔ skipPrevBuy（内部递归算历史日买点，只为了拿题材名 / 股票名）不挂：
  //      那些结果不进 UI，挂了纯属白算（§36 不做无意义的重复计算）。
  if (!skipPrevBuy) _decorateVolRatioTrend(buy, sell, date);

  // [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 龙标旁边的【名次变化】（'+3' / '-2'）。
  //   ⛔ 同样只在主流程挂：skipPrevBuy 的调用是内部重算（结果不进 UI），挂了纯属白算（§36）。
  //   ⚠️ 依赖 dragonRankChangeState（store 异步备好的前一交易日龙位表）：这里【读】它，
  //      于是 computed 会自动追踪这份 ref ⇒ 表备好之后看板自己重算、徽标自己出现（§17 不阻塞渲染）。
  _decorateDragonRankChange(buy, sell, prevDate, dragonMap);

  // [SEAL 2026-10-11 用户口径] 逐票【封单额 + 变化 + 连板】—— 只读 limit_pool 内存缓存（0 请求、
  //   0 猫抓额度）。⛔ 与上面两个装饰器同一取舍：skipPrevBuy 的内部重算结果不进 UI，不挂（§36）。
  if (!skipPrevBuy) _decorateSeal(buy, sell, date);

  // [BOARD-SUSPEND 2026-10-13 用户口径] 逐票【当日停牌】标记 —— 与上面几个装饰器同一取舍：
  //   skipPrevBuy 的内部重算结果不进 UI，不挂（§36）。同步读 suspend.js 的模块级 ref ⇒
  //   停牌集合到货后（组合式触发加载 → ref 变化）本 computed 自动重算、标签自己出现（§17）。
  if (!skipPrevBuy) _decorateSuspend(buy, sell, date);

  // [PREV-BOUGHT 2026-09-30 用户口径，同日两次修正] 「昨天买过」这件事现在有【两个】落点：
  //   · 题材行【昨有买入】(block.prevBoughtTag)：题材里【有】票昨天被打过「买」标签 ⇒ 题材在延续。
  //     判据 = prevBoughtTopics（本文件按【今日题材】把 prevBought 聚合出来，见 _prevBoughtTopics）。
  //   · 股票行【加仓】(pick.position)：这一只昨天真买过（判据 = prevBought，规则层逐只比名字）。
  //     ⛔ 股票行【不再】显示任何「昨天已买」徽标（上一版在这里，用户反馈会被读成个股结论）。
  //   · 卖点侧一律不标：卖点候选本来就是「昨天打过买标签的股票」，标了等于全标，没有信息量。
  //   三条都在规则层收口（§21 模板零计算），UI 直接读上述字段。

  const sellTimes = [];
  sell.forEach(function(g) {
    g.items.forEach(function(it) {
      // [SHARE-RULE 2026-10-03] 占比给出动作标签时（持有 / 尾盘卖 / 竞价卖），时点以它为准 ——
      //   它是用户口径里的最终结论；sellHint / sellAt 只在占比缺数据时才轮到（旧口径让路）。
      const t = (it.sellActionTag)
        ? it.sellActionTag
        : ((it.sellHint && it.sellHint.timeLabel) ? it.sellHint.timeLabel : it.sellAt);
      if (sellTimes.indexOf(t) < 0) sellTimes.push(t);
    });
  });
  sellTimes.sort();

  return {
    ready: true,
    reason: '',
    date: date,
    prevDate: prevDate,
    topics: topics,
    buy: buy,
    sell: sell,
    sellTimes: sellTimes,
    // 规则面板要用到的常量（UI 不硬编码时间点，避免与规则层分叉）
    times: { midday: SELL_TIME_MIDDAY, close: SELL_TIME_CLOSE }
  };
}

/**
 * 【某一天的题材龙位表】—— 唯一出口（§6）。
 *
 * 用途：[DRAGON-RANK-CHANGE 2026-10-09 用户口径] 决策看板龙标旁边的名次变化徽标，
 *   要用【前一交易日】的龙位表来跟今天比。今天的龙位表 = collectDecisionData 里的 dragonMap；
 *   昨天的龙位表由本函数按【完全同一套组装】算出来（见 collectDecisionData 里 dragonRankOnly 的注释）。
 *
 * ⛔ 本函数【不读云、不发请求】：历史日的十日涨幅必须由调用方（dragon-rank-change-store.js）
 *    用 data/stock-range-pct.js 的只读入口读回来、从 rangeMap 传进来。
 *    ——§4 分工：拿数据的一侧和用数据算结论的一侧不混在一起。
 *
 * §10：任一闸门不过（名单没加载完 / 区间涨幅没有 / 该日不成组）⇒ ready=false + 明确 reason，
 *   ⛔ 绝不返回一张空表冒充「那天没有龙位」（那会让所有行的名次变化静默消失，且无从发现）。
 *
 * @param {string} date 目标日（算前一交易日时传前一交易日）
 * @param {{mode?:string, rangeMap?:Map}} [opts] mode 必须与【今日】同一套；rangeMap 见上
 * @returns {{ready:boolean, reason:string, map:Map|null}} map = computeDragonRankMap 的输出
 */
export function collectDragonRankMap(date, opts) {
  const rec = collectDecisionData(date, {
    dragonRankOnly: true,
    mode: opts && opts.mode,
    rangeMap: opts && opts.rangeMap
  });
  // 命中内部出口 ⇒ 中间产物带 dragonRankOnly 标记（_notReady 的返回没有这个键）
  if (rec && rec.dragonRankOnly) {
    return { ready: true, reason: '', map: rec.dragonMap };
  }
  return { ready: false, reason: (rec && rec.reason) || '未就绪', map: null };
}

/**
 * 【某一天的「题材块 + 龙位名册」（+ 可选的买卖点标签上下文）】—— 唯一出口（§6）。
 *
 * 用途：[TVRB 2026-10-11 用户口径] 「题材量比」看板要自己按「平均竞价量比」选股，
 *   它需要的两样东西恰好就是 collectDecisionData 内部已经算好的【中间产物】：
 *     · topics   = rankDecisionTopics(rows, mode)（mode 传 MODE_VOL_RATIO 时 = 按平均竞价量比降序）
 *     · dragonMap = rankDragons(topics)（龙一 / 龙二 … 名册）
 *
 * ⛔ 为什么不让它自己去读「名单 → 分题材 → 排名」：那必然与决策看板分叉 ——
 *    同一批题材的排序 / 同一只票的龙位，两个看板必须用【同一把尺子】量
 *    （行集合含灰行、题材成组门槛、主板闸门都完全一致），否则屏幕上两处名次对不上。
 * ⛔ 本函数【不读云、不发请求、不消费额度】：全部是内存组装（与 collectDecisionData 同源）。
 *   ——它复用内部出口 dragonRankOnly（走到 rankDragons 就返回，不排买卖点、不回溯历史 ⇒ 天然不递归）。
 *
 * ★ [TVRB 2026-10-11 用户口径] opts.actionContext=true 时【额外】带回：
 *   `prevDragonNames / prevBuyNames / prevBought / prevBoughtTopics / topicStreakPast / sellRows`
 *   + [EBB 2026-10-13] `ebbCtx`（退潮首日的【事实】：市场总龙 / 总龙二 / 同题材龙位成员 ——
 *     是否算「退潮」由规则层判，见 topic-vol-ratio-rules#detectEbbDay）
 *   —— 用户原话「要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，
 *     跟龙等所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。」
 *   ⇒ 「题材量比」看板的做法 = 只替换【选股】（它自己的 buildTopicVolRatioPlan），
 *     买点标签交给 decision-rules#finishBuyBlock、卖点交给 decision-rules#buildSellPlan
 *     （两者都是决策看板的同一份实现）。
 *   ⚠️ 打开它会多付「回溯 4 天题材入选次数 + 重算昨日买点」这份开销（§36）——
 *     所以它是【显式开关】，且只有这个看板会传（见 collectDecisionData#topicActionContext）。
 *   ⚠️ 卖点计划【不在这里算】：「今天又进买点」要用【本看板自己的选股】，
 *     所以只把 sellRows 交出去，由调用方拿到自己的买点名单后再调 buildSellPlan。
 *
 * §10：任一闸门不过（名单没加载完 / 十日涨幅未加载 / 该日不成组）⇒ ready=false + 明确 reason，
 *   ⛔ 绝不返回空数组冒充「今天没有题材」。
 *
 * ★ [EBB 2026-10-13 第五轮用户口径] opts.prevRangeMap = 上一交易日的十日涨幅（Map&lt;股票名,{pct}&gt;）——
 *   卖点侧「市场总龙二」用它算「昨日十日涨幅第二」（口径不变）。
 *   ⛔ 本函数【不读云】：那份 Map 由调用方（组合式）按 prevDate 读回后注入。
 *
 * ★★ [EBB-R20 2026-10-20 用户口径] opts.range20Top = 【20日涨幅前五】（getRange20Leaders 的发布结果）——
 *   市场总龙（总龙一）与买点侧替补两【只】的【唯一】来源（见 _ebbCtxOf）。
 *   缺省 ⇒ ebbCtx.ready=false ⇒ 退潮规则不生效（§10：没算出来 ≠ 今天没有总龙）。
 *
 * ★★ [EBB-R8 2026-10-14] opts.rangeMap = 【展示日当天】的十日涨幅（Map&lt;股票名,{pct}&gt;），
 *   由调用方按展示日从 stock_range_pct 读回后注入（纯只读、不耗额度）。两个作用：
 *     ① 【买点侧唯一那只 · 市场龙二】用它排「当日全列表十日涨幅第二」（见 _ebbCtxOf 事实④）；
 *     ② 【消除切日期时的空白期】—— 内存 dragonState 还没跟上新日期时，先用这份渲染，
 *        否则会走到「十日涨幅 / 龙头数据尚未加载完成」那条 §10 闸门（= 用户报的「过好一会儿才显示」）。
 *   ⚠️ 注入只在 `getDragonRangePct(date)` 为【空】时被采纳；内存权威值一到就自动接管。
 *   ⛔ 缺省 ⇒ 只有「内存里已有当前日涨幅」的日期能算（历史日算不出龙二，§10 不猜）。
 *
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {{mode?:string, actionContext?:boolean, prevRangeMap?:Map, rangeMap?:Map, range20Top?:Array}} [opts] mode = 题材组序口径
 *        （「题材量比」看板传 MODE_VOL_RATIO；缺省回落 MODE_VOL_RATIO —— 见 normalizeDecisionMode）；
 *        actionContext 见上（缺省 false ⇒ 与原行为逐字一致）；
 *        prevRangeMap 见上（缺省 ⇒ 退潮首日规则不生效，§10 ⛔ 不退化成「今天没有总龙」）；
 *        rangeMap 见上（缺省 ⇒ 当日龙二算不出，且切日期的空白期照旧）
 * @returns {{ready:boolean, reason:string, date:string, prevDate:string|null,
 *            topics:Array, dragonMap:Map|null}}
 */
export function collectDecisionTopics(date, opts) {
  const rec = collectDecisionData(date, {
    dragonRankOnly: true,
    topicActionContext: !!(opts && opts.actionContext),
    mode: opts && opts.mode,
    // ★ [EBB 2026-10-13] 上一交易日的十日涨幅（算市场总龙用）—— ⛔ 必传【昨日】那份
    prevRangeMap: (opts && opts.prevRangeMap) || null,
    // ★★ [EBB-R8 2026-10-14] 【当日】十日涨幅的注入来源（算「买点侧唯一那只 · 市场龙二」用）。
    //
    // 🔴 为什么必须开这个口子（真实浏览器实测的「切日期要等好久」根因之一）：
    //   本看板的 data 是【同步 computed】，它在切日期的那一帧就会调本函数；而此刻
    //   `getDragonRangePct(新日期)` 必然返回 null —— 内存里的 dragonState 还挂在【上一个日期】上，
    //   要等 useAuctionBoard 那条【串行链】`runCloseCover → ensureDragonRangePct → _publish`
    //   跑完才会更新。于是这一帧走到 collectDecisionData 的 §10 闸门
    //   （`if (!rangeOptional && rangeMap 为空) return _notReady('十日涨幅 / 龙头数据尚未加载完成')`），
    //   看板就显示「十日涨幅 / 龙头数据尚未加载完成」—— 这正是用户报的**「过好一会儿才显示出来」**。
    //   ⇒ 由调用方按【展示日】从 stock_range_pct（带 date 列，纯只读）读回来注入：
    //     内存里还没有就先用手上这份渲染，dragonState 一发布就自动接管
    //     （collectDecisionData 里 `getDragonRangePct` 优先，注入只在它为【空】时生效）。
    //   ⚠️ 注入只在 `getDragonRangePct(date)` 为空时被采纳；权威值一到就被 override，
    //      ⇒ 不会用「旧的云端值」顶掉内存里更新的收盘校正值。
    //   ⛔ 本函数（collectDecisionTopics）【只被题材量比看板调用】（全项目唯一调用方），
    //      故不会给「最近 5 日题材入选次数」那条历史重算路径（_topicStreakPastOf 自己另开
    //      一次 collectDecisionData、不传 rangeMap）带去任何口径变化 —— 与 line 908 的告诫一致。
    rangeMap: (opts && opts.rangeMap) || null,
    // ★ [EBB-R20 2026-10-20 用户口径] 20日涨幅前五（总龙一~五，getRange20Leaders 的发布结果）——
    //   退潮判定（总龙是谁）与买点侧替补（两只）的【唯一】来源；缺省 ⇒ 退潮规则不生效（§10 不猜）。
    range20Top: (opts && opts.range20Top) || null,
    // ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 20日涨幅【前八】（getRange20LeadersWide 的发布结果）——
    //   仅第二十八条切换日的「新龙候选池」用它；缺省 ⇒ 退回 range20Top（= 只有前五候选，§11 零行为变化）。
    range20Wide: (opts && opts.range20Wide) || null
  });
  // 命中内部出口 ⇒ 中间产物带 dragonRankOnly 标记（_notReady 的返回没有这个键）
  if (rec && rec.dragonRankOnly) {
    const out = {
      ready: true,
      reason: '',
      date: rec.date,
      prevDate: rec.prevDate,
      topics: rec.topics || [],
      dragonMap: rec.dragonMap || null
    };
    // 附加上下文只在真的采到时才挂（避免调用方读到 undefined 时误判成「已采到、但为空」）
    if (rec.sellRows) {
      out.prevDragonNames = rec.prevDragonNames || null;
      out.prevBuyNames = rec.prevBuyNames || null;
      out.prevBought = rec.prevBought || null;
      out.prevBoughtTopics = rec.prevBoughtTopics || null;
      out.topicStreakPast = rec.topicStreakPast || null;
      out.sellRows = rec.sellRows;
      // ★ [EBB 2026-10-13] 退潮首日的事实（市场总龙 + 今日状态）；ready=false 表示昨日涨幅尚未注入
      if (rec.ebbCtx) out.ebbCtx = rec.ebbCtx;
    }
    // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「买不进名单」（= 连续停牌第 2 天及以上的票）。
    //   它与 sellRows 采没采到【无关】，故必须放在上面那个 if 之外。
    //   ⚠️ 空集【也是一份有效答案】（今天就没有连续停牌的票）⇒ 照样往下传；
    //      只有「这个键根本没算过」（未走到内部出口）才不挂 ⇒ 调用方读到 undefined = 不知道。
    if (rec.buySkipSuspend) out.buySkipSuspend = rec.buySkipSuspend;
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 当日名单的十日涨幅池（第二十九条候补的候选来源）。
    //   ⚠️ 与上面 buySkipSuspend 同一道理：它只依赖 rows，与「要不要回溯历史买点」无关 ⇒ 放在 if 之外。
    //      空数组也是一份有效答案（当天没有可排的行）⇒ 照样往下传，让规则层如实说「判不出」。
    if (rec.range10Rows) out.range10Rows = rec.range10Rows;
    // ★ [R10-POOL 2026-10-24] 池子是否与屏幕同一批行（补位行有没有并进来）。
    //   ⚠️ 与 range10Rows 必须【同时】透出：只给 rows 不给它，规则层就会拿一个错位的名次当真。
    if (rec.range10PoolComplete !== undefined) out.range10PoolComplete = rec.range10PoolComplete;
    return out;
  }
  return {
    ready: false,
    reason: (rec && rec.reason) || '未就绪',
    date: date || '',
    prevDate: null,
    topics: [],
    dragonMap: null
  };
}

/**
 * 【买点 / 卖点逐行字段的装饰器 · 对外出口（§6）】
 *
 * 把「要读内存真相才能算」的逐行展示字段一次性挂到行上：
 *   · [VRATIO-TREND 2026-10-01] 竞价量比（当日值 + 方向箭头 + 近 5 日趋势）
 *   · [DRAGON-RANK-CHANGE 2026-10-09] 龙标旁边的名次变化（'+3' / '-2'）
 *   · [SEAL 2026-10-11] 封单额 + 变化 + 连板
 *   · [BOARD-SUSPEND 2026-10-13] 当日停牌标记
 *
 * ⛔ 为什么必须收口在这里：这些都要读【本文件所在层】才知道的内存真相
 *    （vol-ratio 缓存 / dragonRankChangeState / limit_pool 缓存 / suspendState），
 *    decision-rules 是纯函数、读不到。另写一份 = 同一只票在两个看板显示不同的量比 / 名次（§6 红线）。
 *
 * ⚠️ buy / sell 可任传其一（另一方传 null）；⛔ 传进来的对象是【原地装饰】的。
 * §36：date 缺失 ⇒ 直接返回（⛔ 不白算一轮）。
 *
 * @param {object|null} buy 买点计划（buildBuyPlan 的返回；可为 null）
 * @param {Array|null} sell 卖点计划（buildSellPlan 的返回；可为 null）
 * @param {string} date 展示日
 * @param {string} prevDate 上一交易日（名次变化要跟它比）
 * @param {Map} todayRankMap 今日龙位表（rankDragons 的返回）
 */
export function decorateDecisionRows(buy, sell, date, prevDate, todayRankMap) {
  if (!date) return;
  _decorateVolRatioTrend(buy, sell, date);
  _decorateDragonRankChange(buy, sell, prevDate, todayRankMap);
  _decorateSeal(buy, sell, date);
  // [BOARD-SUSPEND 2026-10-13] 题材量比看板走这条（它自己建计划、不走 collectDecisionData）
  //   ⇒ 停牌标记必须在【这一份收口】里也挂一次，否则决策看板有、题材量比看板没有（§6 两处必修）。
  _decorateSuspend(buy, sell, date);
}

/**
 * [EBB 2026-10-13 第五轮] 退潮首日「事实」采集的【对外别名】—— 仅供单测（§15 纯函数可单测）。
 *
 * ⛔ 生产路径【只有】collectDecisionData 的 dragonRankOnly 出口在调它（见那里的 out.ebbCtx = …），
 *   别在别处再调一次：它的输入是「当日全列表 + 龙位名册 + 昨日涨幅」，多调一次就是多一份分叉风险。
 * ⚠️ 它是一个【纯函数】（不读 state、不发请求、不消费额度）—— 昨日涨幅按入参注入。
 */
export const ebbCtxOf = _ebbCtxOf;
