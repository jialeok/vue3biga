// useTopicVolRatioBoard.js — 「题材量比」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/TopicVolRatioBoard.vue（模板）→ 本文件（UI 状态 + 触发重算 / 触发取数的时机）
//     → logic/decision/decision-collect.js#collectDecisionTopics(actionContext)
//       （读内存真相：题材块 + 龙位名册 + 买卖点标签上下文 + 卖点候选行）
//     → logic/topicvolratio/topic-vol-ratio-rules.js（本看板的选股 + 标签收口，纯规则，可单测）
//     → logic/decision/decision-collect.js#decorateDecisionRows（量比趋势 / 名次变化 / 封单额）
//     → logic/tick/tick-minute-store.js（分笔取数编排，与「分笔买卖」看板共用同一份内存真相）
//     → logic/tick/tick-minute.js#decorateTickRow（展开面板的每一行 / 每一段文案）
//
// ★ [EBB 2026-10-13 第五轮 用户口径] 退潮首日：
//   用户原话「市场上十日涨幅最高的那只股票所在的题材，在题材退潮首日（龙一停牌或者占比不达标），
//     卖点侧同题材龙二可以看分笔卖出……相当于选出两只可以等开盘卖出的。……其它普通股票都可以竞价卖，
//     降低风险。注意我说的题材量比看板的卖点侧，买点侧是提示空仓的……把买点侧的文字或者 UI
//     全部变成灰色，这样空仓效果更加强烈些」。
//   ⇒ 本文件的职责只有一件事：【按 prevDate 把「昨日十日涨幅」读回来】并注入采集层
//     （readRangePctForDate，纯只读、不耗额度）；判定 / 标签改写全在
//     topic-vol-ratio-rules.js（检测 detectEbbDay + _applyEbbSellRules）。
//
// ★★ [TVRB-926 2026-10-14 用户口径] 买点侧选股固定用【9:26 口径】的十日涨幅。
//   用户原话「题材量比看板选股买点侧，为什么早上的，和收盘的不一样，我只想要早上 9 点 26 分的……
//     因为我对照历史日期的时候就对不上，比如今天我明明买了某只股票，过些时间我再翻开那个时期，
//     又成另外一只股票，非常不合理。」
//   根因 = 区间涨幅的 T 腿在 15:00 后被换成【收盘涨幅】⇒ 组内十日涨幅重排 ⇒ 龙一换人。
//   ⇒ 本文件的职责 = 【按展示日读回 9:26 口径那份】并注入买点侧（readAuctionLegRangeMap，
//     纯只读、0 额度、可回溯历史）；判定 / 选股全在
//     topic-vol-ratio-rules.js（_buildBlock）+ decision-rules.js（rankDragonsWithPctMap）。
//   ⚠️ 只影响【买点侧选股 + 行上十日涨幅】：退潮判定 / 市场总龙 / 卖点一律仍用收盘口径
//     （用户拍板「只改买点侧」，见 range-auction-leg.js 的文件头）。
//
// ★ [2026-10-11 第二轮 用户口径] 本看板只替换【选股】，标签与展开面板全部复用别人的同一份实现：
//   用户原话「要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙
//     等所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。把股票下方点击展开的
//     量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，包括图上文字）」。
//   ⇒ 「不复用其它看板」这条以前的原则，现在只适用于【组件类名前缀】（Tvrb* / tvrb-）；
//     **业务实现一律复用**（§6 单一真相）：标签走 decision-rules，分笔走 tick-minute。
//
// ⛔ 本文件【不抓早盘竞价 / 决策的数据、不落库、不消费猫抓额度】：那些数据全在内存里。
//   ⚠️ 唯一的例外是【分笔明细】：它与「分笔买卖」看板共用 tick-minute-store 这份单例，
//      同一只票同一天只会抓一次（§32 相同数据不得重复请求），额度不会因为本看板翻倍。
//
// §34：expanded / rulesOpen / compactOpen / penOpenSet 都是纯展示态 ——
//      不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。
//      ⚠️ collectDecisionTopics 读的 getTodayGroupList 是【非响应式内存缓存】⇒
//         必须靠下面的 version 手动信号驱动重算（与决策看板 useDecisionBoard 同一套路）；
//         分笔那份是【响应式单例】⇒ 直接 void 它的 ref 即可自动重算。

import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import {
  collectDecisionTopics,
  decorateDecisionRows,
  // ★★ [BUY-SETTLE-2 2026-10-31] 买点行「唯一」的统一遍历（§6）——
  //   选股指纹要覆盖全部买点行（含退潮替补 / 分歧 / 新龙 / 候补 / 抱团 / 补涨），
  //   ⛔ 组合式里别手写 heavy/light/candidates/兜底槽位的摊平（历史上新增档位就被漏掉过）。
  eachDecisionRow,
  suspendEntriesOf
} from '../logic/decision/decision-collect.js';
// [BOARD-SUSPEND 2026-10-13 用户口径] 本看板逐票「当日停牌」标记：判定唯一实现在 suspend.js
//   （同花顺 fuyao，免费/不限量）；本层只负责【触发加载】，展示字段由 decorateDecisionRows 收口挂好。
import { ensureSuspendSet } from '../logic/auction/suspend.js';
// ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日要用【上一交易日】的十日涨幅（市场总龙 = 昨日涨幅第一）：
//   当日早上还没收盘算不出今天的涨幅，停牌票当天更是读不到 ⇒ 只有昨日口径才排得出总龙。
//   ⚠️ readRangePctForDate 是【纯只读】（stock_range_pct 表，带 date 列）⇒ 不消耗猫抓额度。
//   ⚠️ 它必须【异步提前读】，因为下面 data 是【同步 computed】（computed 里不能 await）。
import { readRangePctForDate } from '../data/stock-range-pct.js';
import { getPreviousTradingDay } from '../logic/date/trading-day-helpers.js';
// ★★ [TVRB-926 2026-10-14 用户口径] 【9:26 口径】的区间涨幅（买点侧专用）：
//   区间涨幅的 T 腿在 15:00 后被由竞价涨幅换成收盘涨幅 ⇒ 组内十日涨幅重排 ⇒ 龙一换人 ⇒
//   买点侧选出来的票跟早上 9:26 看到的不一样。本读取器用已落库的
//   `change_pct`（收盘腿）+ `auc_pct_chg`（竞价腿）把那根腿【反解回竞价口径】
//   ⇒ 任何时候翻回那一天，都是当天 9:26 选出来的同一批票。
//   ⛔ 纯只读：`stock_range_pct` + `market_metrics` 各一次（都走会话缓存 + 单飞，§32），
//     不发任何上游请求、不消耗猫抓额度。
import { readAuctionLegRangeMap } from '../logic/auction/range-auction-leg.js';
// ★★ [R20-926 2026-10-24 用户口径] 买点侧【20日涨幅 · 9:26 竞价口径】的名次：
//   用户原话「买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径……
//     在上面说明时间他们的涨幅是多少排名第几就行了」。
//   实现 = 复用十日涨幅那套【T 腿反解】(range-window.js#recoverAuctionLeg)，把
//   `stock_range20_pct`（收盘口径的 20 日复利）换成「前 19 根收盘 + 今天竞价」那一刻的值，再排主板名次。
//   ⛔ 纯只读、不落库、不改 getRange20Leaders 的发布结果（退潮 / 总龙 / 展示仍走收盘口径）；
//   ⛔ 只用于【说明文案】，不参与任何选股（选股口径由用户此前锁定，⛔ 不许在这里动）。
import { readAuctionLegRange20Rank } from '../logic/auction/range20-auction-leg.js';
// ★ [EBB-R20 2026-10-20 用户口径] 20日涨幅前五（总龙一~五）—— 退潮判定的总龙与买点侧替补的【唯一】来源：
//   ensureRange20Leaders 触发计算（幂等 + 会话缓存 + 单飞，与「20日涨幅」toggle 共享同一份）；
//   getRange20Leaders 读发布结果（null = 该日还没结论，⛔ 不等于「没有总龙」）；
//   getRange20LeadersFingerprintToken = 响应式指纹（发布后 data computed 自动重算）。
import {
  ensureRange20Leaders,
  getRange20Leaders,
  // ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 宽榜（20日涨幅前八）—— 第二十八条挑新龙的候选池；
  //   ⛔ 不进展示（「20日涨幅」toggle / 总龙一~五 仍只用前五）。
  getRange20LeadersWide,
  // ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 前十（20日涨幅前 10）—— 只给退潮判定的
  //   「主线题材 ≥3 只同题材」计数；⛔ 不上屏、不参与展示。
  getRange20LeadersTop10,
  getRange20LeadersFingerprintToken,
  // ★★ [BUY-SETTLE-2 2026-10-31] 该日「20 日涨幅前五」的【结论到了没有】（按日期记，日期维度稳定）——
  //   买点侧门控的输入之一：前五没到 ⇒ 退潮判定不生效 ⇒ 选股结果稍后必变（用户看到的换票）。
  //   ⛔ 别用 hasRange20LeadersVerdict（它要求 _state.date === date，多日期交替发布时会翻成 false）。
  hasRange20LeadersVerdictForDate,
  // ★★ [DIVERGE-GUESS 2026-10-24] 预热通道挑「总龙一候选」（纯函数，§15 可单测）；
  //   ⛔ 只在预热里用，正式判定仍以精算出的真·总龙一为准。
  pickLeaderFromUsableRows
} from '../logic/auction/range20-leaders.js';
// ★★ [DIVERGE-GUESS 2026-10-24] 预热通道读【上一交易日】已落库的 20 日涨幅（stock_range20_pct）：
//   readRange20Rows = 一次 REST + 会话缓存 + 单飞（§32）；pickUsableRows = 按口径过滤（同一把尺子，§6）。
//   ⛔ 纯只读、0 K 线、0 猫抓额度 —— 它只用来「猜谁是总龙一」，不产出任何结论。
import { readRange20Rows, pickUsableRows } from '../data/stock-range20-cache.js';
// 名册兜底取代码（云表行里没有 code，K 线请求必须有 6 位代码）——与采集层同一个入口（§6）
import { getStockCode } from '../data/stock-code-map.js';
// ★ [DIVERGE 2026-10-20 用户口径] 市场总龙一【首次分歧】判定：
//   buildLeaderDivergence = 纯函数判定（首板 / 首次分歧 / 分歧转一致，§15 唯一实现）；
//   shouldGateBuySide    = 买点侧「该不该先挂占位」的唯一判据（纯函数，见其 JSDoc）；
//   getRange20WindowDates / RANGE20_PROBE_DAYS = 与「20日涨幅」同一个窗口口径（§6 同一把尺子）。
import { buildLeaderDivergence, shouldGateBuySide } from '../logic/auction/leader-divergence.js';
//   isAfterCloseOf = 「口径阶段」的唯一判据（§6）—— 预热拿到的 K 线能否被正式链路复用，就看它。
import { getRange20WindowDates, RANGE20_PROBE_DAYS, isAfterCloseOf } from '../logic/auction/range20.js';
//   K 线（同花顺，免费 0 额度）取总龙的每天收盘涨幅 + 开盘涨幅（竞价涨幅 = open/昨收-1）。
import { fetchFuyaoDailyPctRange } from '../data/stock-range-pct.js';
// ★ 买点侧专用龙位（= 同一把尺子 computeDragonRankMap，只把十日涨幅换成 9:26 口径那份）
import { rankDragonsWithPctMap } from '../logic/decision/decision-rules.js';
// ★★ [EBB-R8 2026-10-14 用户口径] 退潮判定【落库表】的读写入口（§5 唯一出处）。
//   用户原话：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断
//     没有竞价量等判断出来的，是缓存吧？你要完善这点」
//   ⇒ 读 = 拿【上一交易日那一行】判「今天是不是首日」；写 = 把今天的判定存下来（只存今天，见下）。
import { readEbbDays, upsertEbbDay } from '../data/ebb-days.js';
// ★★ [SWITCH 2026-10-22 用户口径] 第二十八条「切换日 · 新龙」的取数：
//   readTop5History / everInTop5Set = 近 20 个交易日的【每日 20日涨幅前五榜】（回库读 stock_range20_pct，
//   一次 in 查询 + 会话缓存；⛔ 不新增表、不改表结构）。
import { readTop5History, everInTop5Set } from '../data/range20-top5-history.js';
// ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条「十日涨幅 · 在列次数候补」的次数来源：
//   预计算表 auction_presence（data/auction-presence.js，会话缓存 + 单飞 + 30s 失败冷却）。
//   getPresenceForDate = 同步读（不发请求）；ensurePresence = 触发加载；getPresenceFingerprintToken
//   = 响应式指纹（到货 ⇒ data computed 自动重算）。
//   ⚠️ 10 日窗口（PRESENCE_WINDOW_10）：候补看的是「十日周期」，与「20日老周期」刻意不同。
import {
  ensurePresence,
  getPresenceForDate,
  getPresenceFingerprintToken
} from '../data/auction-presence.js';
import { PRESENCE_WINDOW_10 } from '../logic/auction/presence-label.js';
// ★ [DIVERGE-DAYS 2026-10-21] 总龙分歧判定落库：切换日期时读回即用（一次到位渲染分歧板，不用再等 K 线）
import { readDivergeDay, upsertDivergeDay } from '../data/diverge-days.js';
import { _dbgLog } from '../data/debug-log.js';
// §6：「今天」的唯一口径（与 suspend.js 的 ensureSuspendSet 同一个函数，⛔ 别自己 new Date 拼一遍）。
//   停牌判定只对今天可信 ⇒ 落库也只对今天做（历史日的 suspend verdict 恒 false，写进去会污染次日判定）。
import { _getLocalTodayStr } from '../logic/tagTitles/rules.js';
// §6：题材组序口径的常量只有一处定义（decision-mode.js），⛔ 别在本文件写字面量 'volRatio'。
import { MODE_VOL_RATIO } from '../logic/decision/decision-mode.js';
import {
  buildTopicVolRatioPlan,
  buildTvrbRulesLines,
  TVRB_CASH_ALERT_NONE,
  // ★★ [SWITCH 2026-10-22] 切换日判据 + 回看窗口长度：与规则层【同一把尺子】（§6），
  //   ⛔ 组合式不另写「前两个交易日是否为二次确认」的计数。
  detectSwitchDay,
  NEW_DRAGON_LOOKBACK_DAYS,
  // ★ [EBB-20D 2026-10-22 用户口径] 退潮事件计数窗口 = 近 20 个交易日（§6 同一把尺子：
  //   「读几天的历史」必须与规则层「数几天的窗口」用同一个常量，⛔ 别在这儿写死 12 / 22）。
  EBB_EVENT_WINDOW_DAYS
} from '../logic/topicvolratio/topic-vol-ratio-rules.js';
// ★★ [BUY-SETTLE 2026-10-31 用户口径] 买点侧「选股输入是否齐了」的唯一判据
//   （纯函数，见其 JSDoc / 单测）—— ⛔ 别在 data computed 里另写一串行内比较。
import { resolveBuySettle } from '../logic/topicvolratio/buy-settle.js';
// ★★ [BUY-SETTLE-2 2026-10-31 用户口径 · 第三版] 买点侧「选股结果稳定期」判据：
//   白名单式枚举（第一版挡 1 项、第二版挡 8 项）**注定会漏** —— 买点侧还吃全局内存里的
//   题材库 / 竞价行 / 量比缓存 / 昨日名册 / 灰行来源 / 20 日涨幅前五 …… 每一项到货都可能换票。
//   ⇒ 改为【结果侧】：选股指纹连续 BUY_QUIET_MS 不被推翻才放行；之后再被推翻就重新挂占位。
//   @see logic/topicvolratio/buy-quiesce.js（为什么这样做、三条红线都在那里）
import { createBuyQuiesce, buildBuySelectionSig, BUY_QUIET_MS } from '../logic/topicvolratio/buy-quiesce.js';
// ★★ [NET-QUIET 2026-10-31 用户口径 · 第四版] 买点侧「上游还在读吗」的唯一判据：
//   `netIdle` = 在途归零 **且持续 NET_IDLE_MS 没有新请求** ⇒ 这一整批真的读完了 ⇒ 结论已定。
//   前三版都在赌「等一段时间就齐了」（6s 宽限 / 1.5s 稳定期），实测 10-30 的
//   auction_watchlist 到 +17.9s、market_metrics 到 +23.7s —— 赌注必然输。
//   ⚠️ 不许退回「只看瞬时在途数」：数据是分批起跑的，波与波之间会瞬时归零，
//     瞬时判据会在中途放行（实测放行后一波到货就换票）。
//   @see data/net-activity.js（为什么用排除列表、为什么不算 auth/realtime、为什么必须持续）
import { netInflight, netIdle, netStalled, NET_STALL_MS, markNetLoadWindow } from '../data/net-activity.js';
// ★★ [CORE-CAT 2026-10-22 用户口径] 题材【大类】归一：
//   getCoreTopics() = 核心管理里那张表（用户「我在核心管理里把文化传媒放到 AI应用 那个大类了」）；
//   getCoreTopicsVersion() = 响应式版本号（云端加载完成 / 用户改完核心词 ⇒ computed 自动重算）。
//   ⛔ 规则层拿到的永远是「数组」而不是「自己去读表」（§5 Data 层职责）。
import { getCoreTopics, getCoreTopicsVersion, isCoreTopicsCloudLoaded } from '../logic/topic/rules.js';
import { makeCoreTopicResolver } from '../logic/topic/core-category.js';
// ★★ [BUY-SETTLE-2 2026-10-31 用户口径] 题材库（stock_topics）「就绪了吗」——
//   买点侧门控的输入之一。判据语义见其 JSDoc：**为空即「题材分类结果不可信」**（§10 读取失败 ≠ 空）。
//   ⛔ 别用 isCloudTopicsLoaded（那个回答的是「现在写回云端安全吗」，两个判据用途不同）。
import { isTopicLibraryReady } from '../data/stock-topics.js';
// ★ 分笔：与「分笔买卖」看板【同一份取数编排 + 同一份逐行实现】（§6 单一真相，⛔ 不另写一份）
import { decorateTickRow } from '../logic/tick/tick-minute.js';
import {
  tickMinuteDate,
  tickMinuteMap,
  tickMinuteAttempted,
  tickMinuteSkipMap,
  tickMinuteError,
  tickMinuteLoading,
  loadTickMinute,
  ensureTickMinute,
  refreshTickMinute,
  resetTickMinuteTransient,
  isTickMinuteReadable
} from '../logic/tick/tick-minute-store.js';
// ⛔ 刻意【不引入】tick-minute-store#stopTickMinuteRetry：那是整份 store 的定时重试，
//    「分笔买卖」看板也持有同一份 ⇒ 本看板卸载时调它会误伤那个看板（见下面 onUnmounted 的注释）。

/** 稳定的空集合 / 空 Map（避免每次 computed 都 new 一个 → 白白触发下游重算） */
const EMPTY_SET = new Set();
const EMPTY_MAP = new Map();

/**
 * ★★ [BUY-PCT-GATE 2026-10-31] 「9:26 竞价口径未就绪 ⇒ 买点侧先不出票」这条门控的日志去重标记
 * （记最近一次打过的日期）。
 * ⚠️ data computed 在等待期间会因其它依赖变化重算多次 ⇒ 每帧打一条会把 `_dbgLog` 那 200 条
 *    环形缓冲冲掉、把真正有用的现场挤出去（排查时就抓瞎了）。⛔ 别去掉这个去重。
 */
let _settleLogged = '';

/**
 * 分笔取数失败后的一次性重试延迟（ms）。
 *
 * ⚠️ 为什么本看板要自己排一次重试：tick-minute-store 与「分笔买卖」看板共用，
 *    而那次抓取有 20s 的最小间隔闸门（MIN_INTERVAL_MS）。两个看板的【目标票不同】时，
 *    先跑的那个会把闸门占掉 ⇒ 后跑的这个当场抓不到。
 *    ⇒ 这里等闸门过了（25s）再试一次，把本看板自己的票补上。
 *    ⛔ 不会因此多烧额度：store 里同一日最多抓 5 次、且同一日同一票抓过就跳过（§32/§36）。
 */
const TVRB_TICK_RETRY_MS = 25000;
/** 最多重试几次（够跨过闸门即可；再多就是异常，交给用户点刷新 / 红字提示） */
const TVRB_TICK_RETRY_MAX = 3;

/** §10：任何一次「未就绪 / 失败」都要【可见】，绝不静默成「今天没有入选股票」 */
function _empty(reason) {
  return {
    ready: false,
    reason: reason,
    plan: {
      topics: [], blocks: [], buy: null, sell: [], excludedTopics: [], notes: [],
      pickCount: 0, buyNames: new Set(),
      // ⛔ 未就绪 / 计算失败时【绝不给空仓结论】：那会拿「没数据」当「量比太低」用（§10）。
      //    形状仍保留，值 = 冻结的「不提示」，引用稳定（§19）。
      cashAlert: TVRB_CASH_ALERT_NONE,
      // ★ [EBB 2026-10-13] 未就绪时【不是退潮日】（null）—— ⛔ 绝不因为「没算出来」就说今天退潮（§10）
      ebb: null,
      // ★ [EBB-R8 2026-10-14] 形状与真实 plan 一致（§10 未就绪时不给「唯一买点」、也不给落库行）
      ebbBuy: null,
      ebbDayRow: null,
      // ★★ [WEAK-HUDDLE 2026-10-27] 未就绪时同样不给「弱势切抱团」买点（§10 未就绪 ≠ 今天没有抱团票）
      weakHuddle: null,
      // ★★ [CATCH-UP 2026-10-27] 第三十一条同理（§10 未就绪 ≠ 今天没有补涨题材）
      catchUp: null,
      // ★★ [BUY-PCT-GATE 2026-10-31] 形状与真实 plan 一致（未就绪时不是「口径确认中」，
      //   而是整张计划都没算出来 —— 那两种状态的文案不能混，§10）
      buyPending: false
    }
  };
}

/** 分笔抓不了的原因 → 只取【本日】的那些（store 里的 key 形如 `${date}|${name}`，与 useTickBoard 同款） */
function _skipMapOf(date) {
  const out = new Map();
  tickMinuteSkipMap.value.forEach(function(v, k) {
    const i = k.indexOf('|');
    if (i === date.length && k.slice(0, i) === date) out.set(k.slice(i + 1), v);
  });
  return out;
}

export function useTopicVolRatioBoard() {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // 规则面板文案（与判定同处一处：topic-vol-ratio-rules.js，§6）
  const rulesLines = computed(() => buildTvrbRulesLines());

  // 纯展示态（§34）
  // 看板默认【收起】（与决策看板 / 分笔看板一致：打开页面不用再手动一个个关）
  const expanded = ref(false);
  const rulesOpen = ref(false);
  // 「简洁」开关：打开后只留【题材行 + 股票行 + 行内标签】，隐藏解释性文字；
  // 默认【打开】（与决策看板一致，早盘快速浏览）。实际隐藏由 tvrb-compact 的 CSS 完成。
  const compactOpen = ref(true);

  // 「分笔明细」面板的展开态：Set<股票名>（买点 / 卖点两侧共用同一个开关 ——
  //   同一只票在两处是同一个开关，与分笔看板 penOpenSet 同一范式）。
  // 用名字而不是下标（翻页 / 刷新后下标会漂移）；换【引用】驱动重渲染（§20 不做 deep watch）。
  const penOpenSet = ref(new Set());

  // 手动版本号：auction 数据刷新后 bump，让下面的 computed 重跑一次（见文件头 §17 注释）。
  const version = ref(0);
  const errorText = ref('');

  /**
   * ★ [EBB 2026-10-13 第五轮] 上一交易日的十日涨幅（Map&lt;股票名,{pct}&gt;）。
   *
   * 为什么要有它：退潮首日规则要算【市场总龙 = 昨日十日涨幅第一】。当日涨幅算不出来
   *   （早上还没收盘），停牌票当天更是读不到 ⇒ 只能按 prevDate 从 stock_range_pct 读回昨日那份。
   *
   * ⚠️ 它是【异步】读回来的，而下面的 data 是【同步 computed】（computed 里不能 await）⇒
   *   这里先读好放进 ref，data 里 `void prevRangeMap.value` 显式声明依赖：读到之后 computed
   *   自动重跑一次，退潮规则这才生效。⛔ 在此之前 ebbCtx.ready=false ⇒ 退潮规则不生效（§10）。
   * ⚠️ 失败 ⇒ 保持 null（退潮规则本次不生效），⛔ 绝不退化成「今天没有总龙」（那是 §10 红线）。
   */
  const prevRangeMap = ref(null);
  const prevRangeDate = ref('');
  /**
   * ★★ [BUY-SETTLE 2026-10-31] 昨日十日涨幅「读过」的日期（**成功或失败都记**）。
   *
   * 🔴 为什么要单独一格：`prevRangeDate` 只在【成功且非空】时才写（见下面 watch 里的 then），
   *   失败分支连日期都不记 ⇒ 这条链既「永远不落地」（买点侧门控会永久挂起），
   *   又会因为 `if (!(prevRangeDate===pd && map))` 恒成立而在每次重算时**重复打接口**。
   *   ⛔ 不去改 `prevRangeDate` 的既有语义（那是「有没有可用数据」，退潮规则靠它判 §10），
   *      而是另加一格「有没有结论」—— 两者含义不同，§6 不合并。
   */
  const prevRangeTriedDate = ref('');
  /**
   * ★★ [BUY-SETTLE-2 2026-10-31] 「慢判据」等太久时的**宽限日期**（当前管：20 日涨幅前五结论 / 题材库）。
   *
   * 为什么需要宽限：20 日前五要跑 K 线精算（上游实测 50% 超时），历史日还可能因为正式列表索引
   *   未预热而**久久不出结论**；题材库是登录后的异步步骤，极端情况也可能拉不到。
   *   若把它们当硬门控，买点侧就会一直挂在「结果确认中」（比闪一下更糟，用户会以为看板坏了）。
   * ⇒ 判据：`就绪 || 宽限期已过` 才算落地。
   * ⚠️ 宽限到期只放「这一日」的口子（按日期记），切日期/刷新都要重新等 —— ⛔ 别做成全局一次性。
   */
  const gateGraceDate = ref('');
  /**
   * ★ [EBB-R8 2026-10-14] 上一交易日在 tvrb_ebb_days 里【落库的退潮判定】那一行。
   *
   * 作用：detectEbbDay 的【首日】闸门读它 —— 昨天同一只总龙已经退潮 ⇒ 今天不算首日、规则不生效。
   * 缺省（表不存在 / 那天没打开过看板）⇒ 规则层自动退化为「用昨日行情行推断」，再取不到按首日处理。
   * ⚠️ 读失败也保持 null（走退路），但必须留痕（§10 失败可见）；⛔ 绝不因此把 ebb 关掉。
   */
  const prevEbbDay = ref(null);
  const prevEbbDayDate = ref('');
  /**
   * ★ [EBB-R20 2026-10-20] 近 12 个交易日的退潮判定落库行（tvrb_ebb_days）。
   *
   * 作用：detectEbbDay 的【首次 / 二次确认 / 无第三次】事件计数 ——
   *   近 10 个交易日里同题材的退潮事件 0 次 ⇒ 首次、1 次 ⇒ 二次确认、≥2 次 ⇒ 不触发。
   *   多取 2 天只用来判「连续退潮日合并成一次事件」（每行带 prevDate，日期链在这里算好注入，
   *   ⛔ 不把 getPreviousTradingDay 拖进规则层的纯函数 —— 与 _ebbCtxOf 的 prevDate 同一范式）。
   * ⚠️ 读失败 ⇒ 置空数组（按 0 次事件 = 首次处理，与「取不到就按可触发」的用户拍板一致），但必须留痕。
   */
  const ebbHistory = ref([]);
  const ebbHistoryDate = ref('');
  /**
   * ★ [EBB-20D 2026-10-22 用户口径] 事件窗口起点 = 第 EBB_EVENT_WINDOW_DAYS 个交易日的日期。
   *
   * 为什么要单独传：落库表是【按天写】的（没开看板的日子没有行），所以规则层不能拿
   * 「ebbHistory 里最后 20 条」当窗口 —— 实测 20 个交易日只有 7 行，那样会横跨 40 多个交易日、
   * 把窗口外的事件也数进来。⇒ 由本处（手上有交易日历）算好日期下界注入。
   */
  const ebbHistoryFrom = ref('');
  /**
   * ★★ [SWITCH 2026-10-22 用户口径] 第二十八条「切换日」的两个输入（异步读回）：
   *   · top5HistEver     = 近 20 个交易日【上过 20日涨幅前五】的股票名集合（判「首次上榜」的唯一输入）；
   *   · top5HistDays     = 历史榜实际覆盖天数（只用于说明文案，⛔ 不参与判定）。
   *
   * 为什么要有它：用户口径「20个交易日内……这只股票名称有没有上榜？今天是不是首次上榜前五？」
   *   —— 这是【历史每日榜】的问题，前端内存里只有当天那份（切日期就换掉）⇒ 必须回库读
   *   `stock_range20_pct` 的过去 N 天（data/range20-top5-history.js，一次 in 查询 + 会话缓存）。
   *
   * ⚠️ 只在【真的可能是切换日】时才去读（判据复用 detectSwitchDay，与规则层同一把尺子 §6）——
   *   普通日子多一次 REST 请求纯属浪费（§32）。
   * ⚠️ 读失败 ⇒ top5HistEver=null ⇒ 规则层【判不出】⇒ 不收紧 + 说明区如实写原因（§10，绝不猜「首次」）。
   */
  const top5HistEver = ref(null);
  const top5HistDays = ref(0);
  const top5HistDate = ref('');
  /** 单飞：date -> Promise（切日期/重复触发不并发跑两遍，§32） */
  const _top5HistInflight = new Map();

  /**
   * 确保某展示日的「近 20 个交易日 20日涨幅前五榜」已读回（幂等 / 单飞 / 会话缓存）。
   * ⛔ 只读【今天之前】的交易日：今天的榜由 ebbCtx.top5 提供，混进来会把新龙自己也算成「上过榜」。
   * @param {string} d 展示日 YYYY-MM-DD
   */
  function ensureTop5History(d) {
    if (!d) return;
    if (top5HistDate.value === d) return;                 // 该日已读过（成功或失败都已定论）
    if (_top5HistInflight.has(d)) return;
    const dates = [];
    let cur = d;
    for (let i = 0; i < NEW_DRAGON_LOOKBACK_DAYS; i++) {
      cur = getPreviousTradingDay(cur);
      if (!cur) break;
      dates.push(cur);
    }
    if (dates.length === 0) {
      top5HistEver.value = null; top5HistDays.value = 0; top5HistDate.value = d;
      return;
    }
    const p = readTop5History(dates).then(function(hist) {
      if (currentDate.value !== d) return;                // 竞态保护：期间切了日期 ⇒ 丢弃
      top5HistEver.value = everInTop5Set(hist);
      top5HistDays.value = Number(hist && hist.days) || 0;
      top5HistDate.value = d;
    }).catch(function(e) {
      if (currentDate.value !== d) return;
      // §10：读失败 ⇒ 集合置 null（= 判不出「是否首次上榜」）⇒ 规则层不收紧，且说明可见
      console.warn('[TVRB] 20日涨幅历史榜读取失败，切换日新龙判定本次不生效:', e && e.message);
      top5HistEver.value = null;
      top5HistDays.value = 0;
      top5HistDate.value = d;
    }).finally(function() {
      if (_top5HistInflight.get(d) === p) _top5HistInflight.delete(d);
    });
    _top5HistInflight.set(d, p);
  }
  /**
   * ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条「十日涨幅候补」的【在列次数】（10 日窗口）。
   *
   * 为什么要它：候补优先级是「首次在列（1 次）> 二次在列（2 次）」，而「在列」= 该票在这 10 个
   *   交易日的早盘竞价名单里出现过几次 —— 这是【历史逐日名单】的问题，前端内存里只有当天那一份
   *   ⇒ 只能读预计算表 auction_presence（data/auction-presence.js，会话缓存 + 单飞 + 失败冷却）。
   *
   * ⚠️ 会话缓存 / 单飞 / 冷却都在 Data 层（§5），本文件只负责【什么时候去要】+ 竞态保护。
   * ⚠️ §10：读失败 / 表里没这一天 ⇒ range10Presence = null ⇒ 规则层【判不出】⇒ 候补不出现，
   *   说明区会写出原因（⛔ 绝不把「没数据」当成「0 次在列」更不当成「今天空仓」）。
   */
  const range10Presence = ref(null);
  const range10PresenceDate = ref('');
  function ensureRange10Presence(d) {
    if (!d) return;
    const hit = getPresenceForDate(d, PRESENCE_WINDOW_10);
    if (hit) {
      if (range10PresenceDate.value !== d) {
        range10Presence.value = hit;
        range10PresenceDate.value = d;
      }
      return;
    }
    if (range10PresenceDate.value === d) return;   // 这一天要过了（成功或失败都已定论）
    ensurePresence(d, PRESENCE_WINDOW_10).then(function(rec) {
      if (currentDate.value !== d) return;         // 竞态保护：期间切了日期 ⇒ 丢弃
      range10Presence.value = rec || null;
      range10PresenceDate.value = d;
    }).catch(function(e) {
      if (currentDate.value !== d) return;
      console.warn('[TVRB] 在列次数（auction_presence · 10日窗口）读取失败，十日涨幅候补本次不生效:',
        e && e.message);
      range10Presence.value = null;
      range10PresenceDate.value = d;
    });
  }
  // ★ [DIVERGE 2026-10-20] 市场总龙一【首次分歧】判定（异步算出后经 data computed 重算生效）。
  //   divergeVerdict = buildLeaderDivergence 的返回（ready/canJudge/todayFirstDivergence/事件流）；
  //   divergeDate = 判定属于哪一天（⛔ 日期核对红线与两份 rangeMap 同款：不匹配 ⇒ 传 null）。
  //   ⚠️ 判定输入 = 总龙一（20日涨幅第一）的 K 线腿（收盘涨幅）+ 开盘涨幅（竞价涨幅），
  //      全部同花顺免费通道，0 猫抓额度（用户红线）。
  const divergeVerdict = ref(null);
  const divergeDate = ref('');
  /** 单飞：date -> Promise（切日期/重复触发不并发跑两遍，§32） */
  const _divergeInflight = new Map();
  /** [DIVERGE-RETRY] 退避重算（K 线偶发慢/失败时 watch 不会再次触发 ⇒ 必须自带动钟，4 次封顶） */
  const _divergeRetry = new Map();
  const DIVERGE_RETRY_DELAYS = [5000, 15000, 40000, 80000];
  function _scheduleDivergeRetry(d, reason) {
    const st = _divergeRetry.get(d) || { n: 0, timer: 0 };
    if (st.n >= DIVERGE_RETRY_DELAYS.length) {
      // ★ [DIVERGE-GATE 2026-10-21] 重试额度用完 ⇒ 落一个【判不出】的终态结论（canJudge=false），
      //   门控据此放行（买点侧按平常日子渲染）—— ⛔ 否则 verdict 恒 null，占位会挂死整个会话。
      //   ⚠️ 只在该日仍是当前生效判定时落（用户可能已切到别的日期，别把旧日期的终态写到新日期上）。
      //   ⚠️ [DIVERGE-RACE 2026-10-24] 追加 `currentDate` 守卫：过期日期的终态也不许覆盖当前日的结论。
      if (divergeDate.value === d && currentDate.value === d &&
          !(divergeVerdict.value && divergeVerdict.value.ready)) {
        divergeVerdict.value = { ready: true, canJudge: false, firstBoardYmd: '',
          firstDivergenceYmd: '', todayFirstDivergence: false, todayAucPct: null, events: [] };
        console.warn('[TVRB] 总龙分歧判定重试额度用完（' + d + '）⇒ 本会话按「判不出」处理');
      }
      return;
    }
    const delay = DIVERGE_RETRY_DELAYS[st.n];
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(function() {
      _divergeRetry.set(d, { n: st.n + 1, timer: 0 });
      ensureLeaderDivergence(d);
    }, delay);
    _divergeRetry.set(d, st);
    console.warn('[TVRB] 总龙分歧判定未产出（' + reason + '），' + (delay / 1000) + 's 后第 ' + (st.n + 1) + ' 次重试');
  }
  /**
   * ★★ [DIVERGE-GUESS 2026-10-24 用户口径] 分歧判定的【预热通道】—— 解决三件事：
   *
   *   用户原话：「为什么这个提示总是过很久才显示出来，有时显示出来了结果，之后又变成这样了，
   *   不是很稳定，当时改的时候不是说秒显示吗？计算判断有那么久吗？要再优化下」
   *
   *   根因（§35 先定位再改）：
   *     ① 判定必须知道【今天的总龙一是谁】，而它来自 20 日涨幅前五的**精算**（<=25 只票 × K 线，
   *        并发 3 ⇒ 十几~几十秒）。判定本身只要 1 只票的 K 线（1~3 秒）⇒ 等待全在「等身份」；
   *     ② 今天的门控此前是 `!_isTodayD` = **恒 false**（见 shouldGateBuySide 的 ③），
   *        即「事实没就绪就当作不可能分歧」⇒ 占位只能等精算完才出现，而在这之前屏幕上
   *        已经是一批「按常规规则选出来的票」—— 那正是用户说的「过很久才显示」；
   *     ③ 预热把「昨日总龙一」的判定提前算好（昨日已经落库 ⇒ 0 K 线请求即可挑出候选），
   *        于是今天一进页面（1~3 秒）就能知道「是不是分歧日」⇒ 是 ⇒ 秒挂占位、不是 ⇒ 照常渲染。
   *
   *   ⚠️ 纪律（§10 宁缺勿错）：
   *     · 这里产出的只是【猜测】，绝不落到 plan / 不写库；买点侧结论 100% 来自 ensureLeaderDivergence；
   *     · 猜不出来（昨日云表没数据 / 拿不到代码 / 非主板）⇒ 保持 null ⇒ 门控回退到「与加预热之前一致」；
   *     · 今日 bar 还没出（9:25 之前）⇒ verdict.canJudge=false ⇒ 照样当「猜不出来」。
   */
  //   ⚠️ shallowRef：里面挂着两份 Map（K 线的收盘/开盘腿）—— 深响应会把它们整份代理一遍，
  //      纯浪费（它们只在整体替换时才需要触发重算，而本函数每次都是 `divergeGuess.value = {...}`）。
  const divergeGuess = shallowRef(null);
  const _divergeGuessInflight = new Map();
  /**
   * 20 日涨幅精算进度 `{ date, done, total }`（只在占位里显示一行小字，§10 缺省不改行为）。
   * ⚠️ 它【绝不进 data computed 的依赖】—— 每补完一只票就重算一遍整张买点计划是 §36 红线；
   *    模板在占位块里单独读它，只有那一小块重渲染。
   */
  const range20Progress = ref(null);
  /**
   * 【口径阶段】指纹：`是否今天|是否已收盘`。
   * 用途只有一处 —— 判断「预热拿到的 K 线能不能被正式链路复用」：
   *   同一阶段内 K 线的「今日腿」含义不变（竞价口径 / 收盘口径）⇒ 可复用；
   *   跨 15:00 就变（今日腿由竞价值换成收盘值）⇒ ⛔ 必须重取（§6 一把尺子，§10 不拿旧口径顶替）。
   * @param {string} d 展示日
   * @returns {string}
   */
  function _divergePhaseKey(d) {
    return (d === _getLocalTodayStr() ? 'T' : 'H') + '|' + (isAfterCloseOf(d) ? 'C' : 'I');
  }
  /**
   * 确保「该日的分歧日猜测」已算过（幂等 / 单飞 / 结论缓存）。
   * @param {string} d 展示日
   * @returns {Promise<void>}
   */
  function ensureDivergeGuess(d) {
    if (!d) return Promise.resolve();
    const cur = divergeGuess.value;
    // 已有【猜得出】的同一日结论 ⇒ 短路；猜不出来（canJudge=false）不缓存，允许下一次刷新事件重试
    if (cur && cur.date === d && cur.verdict && cur.verdict.canJudge) return Promise.resolve();
    const fly = _divergeGuessInflight.get(d);
    if (fly) return fly;
    const p = (async function() {
      const pd = getPreviousTradingDay(d);
      if (!pd) return;
      // ① 昨日 20 日涨幅（已落库）⇒ 挑一个「总龙一候选」（0 K 线请求，一次 REST 走会话缓存）
      const rows = await readRange20Rows(pd);
      if (currentDate.value !== d) return;                 // 竞态：期间切了日期 ⇒ 丢弃
      const cand = pickLeaderFromUsableRows(pickUsableRows(rows, 'close'), getStockCode);
      if (!cand) {
        _dbgLog('[DIVERGE-GUESS] ' + d + ' 昨日（' + pd + '）云表挑不出总龙一候选 ⇒ 不预热' +
          '（门控回退：今天按「不可能分歧」处理，与加预热之前一致）');
        return;
      }
      // ② 只拉这一只票的窗口 K 线（1 次请求）⇒ 跑同一份纯函数判定（§6 同一把尺子）
      const dates = getRange20WindowDates(d, RANGE20_PROBE_DAYS);
      const openOut = new Map();
      const pct = await fetchFuyaoDailyPctRange(
        [{ stock: cand.stock, code: cand.code }],
        dates,
        { retryShortWindow: true, requestTimeoutMs: 15000, openOut: openOut }
      );
      if (currentDate.value !== d) return;                 // 竞态：同上
      const legs = pct.get(cand.stock);
      if (!legs || legs.size === 0) {
        _dbgLog('[DIVERGE-GUESS] ' + d + ' 预热 K 线未取到（' + cand.stock + '）⇒ 不预热');
        return;
      }
      const verdict = buildLeaderDivergence({
        pctByYmd: legs,
        openPctByYmd: openOut.get(cand.stock) || new Map(),
        dates: dates,
        code: cand.code,
        name: cand.stock,
        viewDate: d,
        todayAucPct: null
      });
      divergeGuess.value = {
        date: d, stock: cand.stock, code: cand.code, verdict: verdict,
        // ★ [DIVERGE-GUESS 2026-10-24] 把 K 线一起带上 + 记「口径阶段」：
        //   正式链路若最终的总龙一【就是这只票、且阶段没变】⇒ 直接复用这份 K 线（0 请求、0 等待，
        //   §32 相同数据不重复请求）。阶段一变（9:26 → 15:00 后今日腿由竞价换成收盘）⇒ 必须重取，
        //   ⛔ 否则会拿早盘那根「今日腿」当收盘口径算（§6 一把尺子）。
        legs: legs,
        open: openOut.get(cand.stock) || new Map(),
        phase: _divergePhaseKey(d)
      };
      _dbgLog('[DIVERGE-GUESS] ' + d + ' 预热猜测: 总龙一≈' + cand.stock + '(昨日 ' + pd + ' 第一)' +
        ' canJudge=' + verdict.canJudge + ' todayFirst=' + verdict.todayFirstDivergence +
        ' todayAuc=' + verdict.todayAucPct);
    })().catch(function(e) {
      // §10：失败必须可见，但⛔ 绝不能连坐主链路（预热只是「快一点」，不是结论）
      _dbgLog('[DIVERGE-GUESS] ' + d + ' 预热失败（不影响正式判定）: ' + (e && e.message || e));
    }).finally(function() {
      if (_divergeGuessInflight.get(d) === p) _divergeGuessInflight.delete(d);
    });
    _divergeGuessInflight.set(d, p);
    return p;
  }
  /**
   * 确保某日的「总龙首次分歧」判定已就绪（幂等 / 单飞 / 结论缓存）。
   * ⛔ 判不出（窗口无首板 / K 线缺）⇒ verdict.canJudge=false ⇒ plan 的 divergeActive 恒 false
   *   （分歧买点静默不生效 —— 宁缺勿错，§10）。
   * @param {string} d 展示日
   * @returns {Promise<void>}
   */
  function ensureLeaderDivergence(d) {
    if (!d) return Promise.resolve();
    // [DIVERGE-DIAG] 入口留痕：确认调用链真的进来了（冷路径，每日一次，开销可忽略）
    _dbgLog('[DIVERGE] 进入: d=' + d +
      ' 已就绪短路=' + ((divergeDate.value === d && divergeVerdict.value && divergeVerdict.value.ready) ? 1 : 0) +
      ' 在途=' + (_divergeInflight.has(d) ? 1 : 0));
    if (divergeDate.value === d && divergeVerdict.value && divergeVerdict.value.ready) return Promise.resolve();
    const fly = _divergeInflight.get(d);
    if (fly) return fly;
    // ★★ [DIVERGE-GUESS 2026-10-24] 预热通道【与精算并行起跑】（fire-and-forget）：
    //   它只产出「门控用的猜测」，⛔ 不参与正式结论；失败/慢都不影响下面的链路。
    void ensureDivergeGuess(d);
    const p = (async function() {
      // ⓪ ★ [DIVERGE-DAYS 2026-10-21] 落库优先：该日的分歧判定【曾经算出来过】（canJudge=true）⇒
      //   直接读回当结论 —— 分歧判定对历史日是确定性的（K 线历史不可变 + 竞价涨幅 9:25 后不变），
      //   读回即用 ⇒ 切回该日【一次到位】渲染分歧板，K 线都不用等（用户「就不能直接显示正确的吗」）。
      //   ⛔ 读失败 / 表不存在 ⇒ 留痕后照走 K 线链路（§10 失败可见，不连坐）。
      //   ⛔ 与退潮落库不同，历史日也读也写：本判定不依赖「当日上游快照」，全输入来自不可变历史。
      // ⚠️ [DIVERGE-RACE 2026-10-24] 单飞是【按日】的 ⇒ 切日期时会有两条链路同时活在本会话里。
      //   本函数所有 ref 写入都必须先过 `currentDate.value === d`：
      //   ⛔ 否则一条【过期日期】的链路（退避重试 / 切回切走）会把【当前日】已经拿到的结论清成 null
      //      ⇒ 屏幕从「分歧板/常规板」退回「⏳ 计算中」—— 用户原话「显示出来了结果，之后又变成这样了」。
      //   这条守卫是「不稳定」的根因修复，改动任何一处都要保留。
      try {
        const row = await readDivergeDay(d);
        if (row && row.canJudge &&
            currentDate.value === d &&
            !(divergeDate.value === d && divergeVerdict.value && divergeVerdict.value.ready)) {
          divergeVerdict.value = {
            ready: true, canJudge: true,
            firstBoardYmd: row.firstBoardYmd || '',
            firstDivergenceYmd: row.firstDivergenceYmd || '',
            todayFirstDivergence: !!row.todayFirst,
            todayAucPct: (row.todayAucPct === null || row.todayAucPct === undefined)
              ? null : Number(row.todayAucPct),
            events: []
          };
          divergeDate.value = d;
          _dbgLog('[DIVERGE] ' + d + ' 命中落库判定（todayFirst=' + row.todayFirst +
            '）⇒ 直接采用，不再等 K 线');
          return;
        }
      } catch (e) {
        _dbgLog('[DIVERGE-DAYS] 落库判定读取失败（继续 K 线链路）: ' + (e && e.message));
      }
      // ① 前五就绪（幂等 + 会话缓存 + 单飞；warm-retry 的重算也走这一份）
      const leaders = await ensureRange20Leaders(d);
      // ⚠️ [DIVERGE-RACE] 只清【当前展示日】那格：过期链路不许把别人算好的结论抹掉（见上面守卫注释）
      if (currentDate.value === d) {
        divergeVerdict.value = null;
        divergeDate.value = d;
      }
      if (!leaders || leaders.length === 0) {
        // 前五还没发布（候选池/精算在后台跑）⇒ 起退避重试（ leaders 发布后本 watch 不会再次触发）
        _scheduleDivergeRetry(d, '20日前五未发布');
        return;
      }
      const l0 = leaders[0];
      if (!l0 || !l0.stock || !l0.code) {
        // ⛔ 缺代码 ⇒ K 线没法请求（§10 不猜）。必须留痕 —— 这里曾是静默 return，
        //   排障时「无任何日志」差点把定位带进死胡同（§10 失败可见）。
        _dbgLog('[DIVERGE] ' + d + ' 总龙缺 stock/code ⇒ 判不出: ' + JSON.stringify(l0 || null));
        // ★ [DIVERGE-GATE] 落「判不出」终态：门控据此放行（⛔ 不然 verdict 恒 null ⇒ 占位挂死）
        if (divergeDate.value === d && currentDate.value === d) {
          divergeVerdict.value = { ready: true, canJudge: false, firstBoardYmd: '',
            firstDivergenceYmd: '', todayFirstDivergence: false, todayAucPct: null, events: [] };
        }
        return;
      }
      // ② 总龙一的窗口 K 线：收盘涨幅（涨停判定）+ 开盘涨幅（竞价涨幅，分歧判定）
      const dates = getRange20WindowDates(d, RANGE20_PROBE_DAYS);
      const openOut = new Map();
      // ★★ [DIVERGE-GUESS 2026-10-24] 预热已经为【同一只票、同一口径阶段】拉过这份 K 线 ⇒ 直接复用：
      //   · 预热候选就是真·总龙一（绝大多数日子）⇒ 判定 0 请求 0 等待，占位一出现就能落地；
      //   · 名字对不上 / 阶段变了（跨 15:00）⇒ 照旧现取（1 只票，1~3 秒），⛔ 绝不复用错口径的腿。
      const _guess = divergeGuess.value;
      const _guessHit = !!(_guess && _guess.date === d && _guess.legs &&
        _guess.stock === l0.stock && _guess.phase === _divergePhaseKey(d));
      let pct = null;
      if (_guessHit) {
        pct = new Map();
        pct.set(l0.stock, _guess.legs);
        openOut.set(l0.stock, _guess.open || new Map());
        _dbgLog('[DIVERGE-GUESS] ' + d + ' 正式链路复用预热 K 线（总龙一=' + l0.stock + '，0 请求）');
      } else {
        pct = await fetchFuyaoDailyPctRange(
          [{ stock: l0.stock, code: l0.code }],
          dates,
          { retryShortWindow: true, requestTimeoutMs: 15000, openOut: openOut }
        );
      }
      if (!pct.get(l0.stock) || pct.get(l0.stock).size === 0) {
        // K 线一根都没拿到（上游偶发失败）⇒ 重试（§10：拿不到 ≠ 没有分歧）
        _scheduleDivergeRetry(d, '总龙K线未取到');
        return;
      }
      // [DIVERGE-DIAG] K 线取回规模留痕（keep=收盘涨幅腿 / open=竞价涨幅腿）
      _dbgLog('[DIVERGE] ' + d + ' K线取回: keep=' + pct.get(l0.stock).size +
        ' open=' + ((openOut.get(l0.stock) && openOut.get(l0.stock).size) || 0));
      // ③ 纯函数判定（首板 / 首次分歧 / 事件流）。竞价涨幅统一取 K 线 open/昨收：
      //    A 股开盘价 = 9:25 集合竞价成交价，两者同一价格；展示日行情行的竞价涨幅留作后续增强。
      const verdict = buildLeaderDivergence({
        pctByYmd: pct.get(l0.stock) || new Map(),
        openPctByYmd: openOut.get(l0.stock) || new Map(),
        dates: dates,
        code: l0.code,
        name: l0.stock,
        viewDate: d,
        todayAucPct: null
      });
      // ⚠️ [DIVERGE-RACE] 同上：只写【当前展示日】那格（过期链路写进来会让屏幕倒退回占位）
      if (currentDate.value === d) {
        divergeVerdict.value = verdict;
        divergeDate.value = d;
      }
      if (_divergeRetry.has(d)) { clearTimeout(_divergeRetry.get(d).timer); _divergeRetry.delete(d); }
      // ★ [DIVERGE-DAYS 2026-10-21] 判定算出（canJudge=true）⇒ 落库：下次切回该日读回即用（一次到位）。
      //   ⛔ 只写 canJudge=true（Data 层有第二道闸，§10 绝不落一行「猜的」判定）；
      //   ⛔ 幂等 upsert，失败不阻断看板（Data 层留痕）。历史日也写 —— 判定对历史日是确定性的。
      if (verdict.canJudge) {
        void upsertDivergeDay({
          date: d,
          // ★ [DIVERGE-DAYS-FIX 2026-10-22] ⛔ 此字段此前漏传 —— Data 层第二道闸
          //   `if (!row.canJudge) return false` 会把每一次写入都【静默拦截】（§10 无声失败），
          //   落库表恒 0 行 ⇒ 用户「每次切日期都重新计算」。外层 if (verdict.canJudge)
          //   已守卫，这里按同一结论传 true（以 Data 层闸为准，双保险）。
          canJudge: true,
          leaderStock: l0.stock,
          leaderTopic: '',
          todayFirst: verdict.todayFirstDivergence,
          firstBoardYmd: verdict.firstBoardYmd,
          firstDivergenceYmd: verdict.firstDivergenceYmd,
          todayAucPct: verdict.todayAucPct
        });
      }
      // [DIVERGE-DIAG] 判定结果留痕（排查「分歧块为什么不出现」的唯一证据链）
      _dbgLog('[DIVERGE] ' + d + ' 总龙=' + l0.stock + '(' + l0.code + ') ready=' + verdict.ready +
        ' canJudge=' + verdict.canJudge + ' firstBoard=' + verdict.firstBoardYmd +
        ' firstDiv=' + verdict.firstDivergenceYmd + ' todayFirst=' + verdict.todayFirstDivergence +
        ' todayAuc=' + verdict.todayAucPct + ' events=' + verdict.events.length);
    })().catch(function(e) {
      // §10：失败必须可见（控制台）+ 如实降级（分歧买点本次不生效），⛔ 不猜、不静默伪造
      console.warn('[TVRB] 总龙分歧判定失败，分歧买点本次不生效:', e && e.message);
      // ⚠️ [DIVERGE-RACE] 失败也只降级【自己的日期】：过期链路失败不能把当前日的好结论清空
      if (currentDate.value === d) {
        divergeVerdict.value = null;
        divergeDate.value = d;
      }
      _scheduleDivergeRetry(d, '判定失败: ' + (e && e.message || e));
    }).finally(function() {
      if (_divergeInflight.get(d) === p) _divergeInflight.delete(d);
    });
    _divergeInflight.set(d, p);
    return p;
  }

  /**
   * ★★ [EBB-R8 2026-10-14] 【展示日当天】的十日涨幅（Map&lt;股票名,{pct}&gt;）。
   *
   * 两个作用，缺一不可：
   *   ① 【买点侧唯一那只 · 市场龙二】要按【当日】十日涨幅排「全列表第二」（用户口径的「当日」口径）；
   *   ② 🔴 【消除切换日期后的空白期】：本看板的 data 是【同步 computed】，切日期那一帧就会问
   *      `getDragonRangePct(新日期)` —— 此刻内存 dragonState 还挂在【上一个日期】上，必然返回 null，
   *      于是走到 decision-collect 的 §10 闸门、显示「十日涨幅 / 龙头数据尚未加载完成」，
   *      要等 useAuctionBoard 那条【串行链】(runCloseCover → ensureDragonRangePct → _publish) 跑完才出数据。
   *      **这就是用户报的「切换日期时可能过好一会儿才显示出来」**。
   *      ⇒ 提前按日期把 stock_range_pct（带 date 列，纯只读）读回来注入：
   *        内存里还没有就先拿它渲染，dragonState 一发布就自动接管（注入只在内存为【空】时被采纳）。
   *
   * ⚠️ 与 prevRangeMap 是【两份不同的日期】：那个是上一交易日（算总龙），这个是展示日本身（算龙二）。
   * ⛔ 失败 ⇒ 保持 null（龙二算不出、空白期照旧），⛔ 绝不退化成用昨日涨幅顶替（§10）。
   */
  const curRangeMap = ref(null);
  const curRangeDate = ref('');
  /**
   * ★★ [TVRB-926 2026-10-14 用户口径] 【展示日】的 9:26 口径区间涨幅（Map&lt;股票名,{pct,days}&gt;）。
   *
   * 这是本看板买点侧选股（龙位 + 行上十日涨幅）【唯一】的口径输入：
   *   · 只读一次/天（readAuctionLegRangeMap 会话缓存 + 单飞，§32）；
   *   · 读到 ⇒ 选股与数值都按「早上 9:26 那一刻」算，翻回历史任何一天都是同一批股票；
   *   · ⛔ 读不到 / 读失败 ⇒ 【null】⇒ `buildTopicVolRatioPlan` 退回原口径（§11 默认零行为变化），
   *     并在看板说明区【如实标出来】（§10：⛔ 绝不静默拿收盘口径冒充早上那一份）。
   * ⚠️ buyRangeDate 记「这一天到底读没读过」（成功或失败都算读过）——
   *   没读过 ≠ 读到空：前者只是异步还没回来（不打标记，避免首帧闪一下），后者才是真的缺（要标记）。
   */
  const buyRangeMap = ref(null);
  const buyRangeDate = ref('');
  /**
   * ★★ [R20-926 2026-10-24 用户口径] 展示日【20日涨幅 · 9:26 竞价口径】的主板名次
   * （Map&lt;股票名, {pct, days, rank}&gt;，见 logic/auction/range20-auction-leg.js）。
   *
   * 用途【只有一个】：买点侧走【20日涨幅通道】的入选票（退潮替补 = 总龙二~五 / 切换日新龙），
   *   说明区要写出「9:26 那一刻它的 20日涨幅是多少、排第几」（用户原话「说明时间他们的涨幅是多少
   *   排名第几就行了……你不要解释」）。
   * ⛔ 不参与选股：那两条通道的判据（退潮 / 切换日 / 总龙身份）用户此前明确锁定为收盘口径
   *   （「收盘后这二十天全部是收盘涨幅，这样就和炒股软件对得上」）——这里只补一句事实，⛔ 不改结论。
   * ⚠️ §10：读不到 / 判不出 ⇒ null ⇒ 规则层一条说明都不写（⛔ 绝不拿收盘口径冒充 9:26）。
   * ⚠️ 日期核对红线（与下面两份 rangeMap 同一条）：只认【日期对得上】的那份。
   */
  const r20AucMap = ref(null);
  const r20AucDate = ref('');
  // ⛔ 用「日期 + version」字符串当键：plan / rec 每次重算都换引用，对象身份当键会无限重载。
  const prevRangeKey = computed(function() {
    return String(currentDate.value || '') + '|v' + version.value;
  });
  watch(prevRangeKey, function() {
    const d = currentDate.value;
    const pd = d ? getPreviousTradingDay(d) : '';
    // ①-a stock_range_pct【展示日】：买点侧唯一那只（当日口径）+ 消除切日期的空白期（见 curRangeMap 注释）。
    //   ⚠️ 它【与上一交易日无关】⇒ 必须排在下面那个 `!pd` 早退【之前】：
    //      没有「上一交易日」（极端配置 / 空日历）时，看板照样要能渲染出当天数据。
    if (d && curRangeDate.value !== d) {
      readRangePctForDate(d).then(function(m) {
        // ⚠️ 竞态保护：读回来的这段时间里用户可能切了日期 ⇒ 目标日期已变，丢弃本次结果
        if (currentDate.value !== d) return;
        curRangeMap.value = (m && m.size > 0) ? m : null;
        curRangeDate.value = d;
      }).catch(function(e) {
        console.warn('[TVRB] 当日十日涨幅读取失败，本次不给出「买点侧唯一那只」:', e && e.message);
        curRangeMap.value = null;
        curRangeDate.value = d;
      });
    }
    // ①-c ★★ [TVRB-926] 展示日的【9:26 口径】区间涨幅（买点侧选股唯一口径）
    //   §26：只随「日期 / 数据刷新版本」重读；同一天切回来命中会话缓存，不会重复打接口。
    //   ⚠️ 不做「今天 15:00 前跳过」这类日期级优化：正确性由 range-auction-leg 的
    //      【行级】前提（那一行确实已换过腿）保证 —— 早晨读进来也只是恒等变换，
    //      ⛔ 而靠日期判断会与 close-pct-cover 的口径分叉（§6 一把尺子）。
    if (d && buyRangeDate.value !== d) {
      readAuctionLegRangeMap(d).then(function(m) {
        if (currentDate.value !== d) return;
        buyRangeMap.value = (m && m.size > 0) ? m : null;
        buyRangeDate.value = d;
      }).catch(function(e) {
        // §10：失败必须可见（看板说明区会如实标出「9:26 口径未就绪」），⛔ 绝不静默降级
        console.warn('[TVRB] 9:26 口径（买点侧选股）读取失败，本次按当前口径选股:', e && e.message);
        buyRangeMap.value = null;
        buyRangeDate.value = d;
      });
    }
    // ①-c2 ★★ [R20-926 2026-10-24 用户口径] 展示日的【20日涨幅 · 9:26 竞价口径】主板名次。
    //   只服务一件事：买点侧走 20日涨幅通道的票（退潮替补 / 切换日新龙）在说明区写出
    //   「9:26 那一刻的涨幅 + 第几名」。⛔ 不参与选股（用户此前锁定退潮 / 总龙走收盘口径）。
    //   §26：一天只读一次（模块内会话缓存 + 单飞）；读不到 ⇒ null ⇒ 规则层一条说明都不写（§10）。
    if (d && r20AucDate.value !== d) {
      readAuctionLegRange20Rank(d).then(function(m) {
        if (currentDate.value !== d) return;      // 竞态：期间切了日期 ⇒ 丢弃
        r20AucMap.value = (m && m.size > 0) ? m : null;
        r20AucDate.value = d;
      }).catch(function(e) {
        // §10：失败必须可见（但这个值只影响一条说明，⛔ 不影响任何选股结论）
        console.warn('[TVRB] 20日涨幅 9:26 口径名次读取失败（只影响说明文案）:', e && e.message);
        r20AucMap.value = null;
        r20AucDate.value = d;
      });
    }
    // ①-d ★ [EBB-R20 2026-10-20] 20日涨幅前五（总龙一~五）：为退潮判定 / 替补选股预热。
    //   幂等 + 会话缓存 + 单飞（与「20日涨幅」toggle / 补位区块共享同一份，不会多烧请求）；
    //   发布结果经 getRange20Leaders(d) 在 data computed 里同步读（指纹令牌保证发布后自动重算）。
    //   ⚠️ fire-and-forget：失败只留痕，⛔ 绝不阻塞看板（退潮规则本次不生效，§10 如实降级）。
    if (d) {
      // ★★ [DIVERGE-GATE-2 2026-10-24] 精算进度回报：占位里要能看见「20日涨幅精算 12/25」——
      //   用户问「计算判断有那么久吗」，答案就在这个分母上（25 只票的 K 线，不是 1 只）。
      //   ⚠️ 只有【本次会话的第一条】ensureRange20Leaders 调用带的 onProgress 会生效（单飞共享），
      //      拿不到进度就只是少一行小字，⛔ 不影响任何判定（§10 缺省不改行为）。
      range20Progress.value = null;
      ensureRange20Leaders(d, {
        onProgress: function(done, total) {
          if (currentDate.value !== d) return;      // 竞态：期间切了日期 ⇒ 丢弃
          range20Progress.value = { date: d, done: Number(done) || 0, total: Number(total) || 0 };
        }
      }).catch(function(e) {
        console.warn('[TVRB] 20日涨幅前五计算失败，退潮判定（20日口径）本次不生效:', e && e.message);
      });
      // ★ [DIVERGE 2026-10-20] 总龙首次分歧判定预热（内部自带 ensureRange20Leaders 单飞，
      //   不会重复请求；K 线 = 同花顺免费通道 0 额度）。fire-and-forget，失败如实降级。
      ensureLeaderDivergence(d);
      // ★★ [DIVERGE-GUESS 2026-10-24] 猜测通道与上面两条【同帧起跑】（不等 rec 就绪）：
      //   它是「今天要不要先挂占位」的唯一输入，越早起跑越接近用户要的「秒显示」。
      void ensureDivergeGuess(d);
    }
    if (!pd) {
      prevRangeMap.value = null; prevRangeDate.value = '';
      // ★ [BUY-SETTLE] 没有上一交易日 ⇒ 与「昨日」相关的两项不参与门控（见门控调用处传的 prevDate）
      prevRangeTriedDate.value = '';
      prevEbbDay.value = null; prevEbbDayDate.value = '';
      ebbHistory.value = []; ebbHistoryFrom.value = ''; ebbHistoryDate.value = d || '';
      return;
    }
    // ⚠️ 下面两条链【各自独立】判缓存、各自异步（⛔ 别用一个 early-return 串起来：
    //    十日涨幅已缓存、退潮表还没读时，早退会把退潮表这条链整个跳过）。
    // ①-b stock_range_pct：同一天已经读回来了 ⇒ 直接复用（日期级缓存，一天不会变）
    if (!(prevRangeDate.value === pd && prevRangeMap.value && prevRangeMap.value.size > 0)) {
      readRangePctForDate(pd).then(function(m) {
        // ⚠️ 竞态保护：读回来的这段时间里用户可能切了日期 / 数据刷新了 ⇒ 目标日期已变，丢弃本次结果
        if (getPreviousTradingDay(currentDate.value) !== pd) return;
        prevRangeMap.value = (m && m.size > 0) ? m : null;
        prevRangeDate.value = pd;
        // ★ [BUY-SETTLE] 读过（成功）⇒ 落「结论日期」，买点侧门控据此放行（见 prevRangeTriedDate）
        prevRangeTriedDate.value = pd;
      }).catch(function(e) {
        console.warn('[TVRB] 上一交易日十日涨幅读取失败，退潮首日规则本次不生效:', e && e.message);
        // ★ [BUY-SETTLE] 读过（失败）也落「结论日期」：退潮规则照样不生效（§10 不猜），
        //   但门控不能再等它 —— ⛔ 否则一次读失败就把买点侧永久锁死。
        if (getPreviousTradingDay(currentDate.value) === pd) prevRangeTriedDate.value = pd;
      });
    } else if (prevRangeTriedDate.value !== pd) {
      // 已经是「有数据」的状态但还没记过结论日期（例如从缓存直接命中）⇒ 补记，避免门控白等
      prevRangeTriedDate.value = pd;
    }
    // ② tvrb_ebb_days：一次读【今天 + 上一交易日】两行（§32 一次 in 查询；
    //    今天那行用不着判首日，但读回来能让 upsert 前的判断看到「今天已经写过什么」——幂等且省一次往返）
    if (prevEbbDayDate.value !== pd) {
      readEbbDays([d, pd]).then(function(m) {
        if (getPreviousTradingDay(currentDate.value) !== pd) return;
        prevEbbDay.value = m.get(pd) || null;
        prevEbbDayDate.value = pd;
      }).catch(function(e) {
        // §10：读失败 ⇒ 按「没有落库判定」处理（规则层会用行情行推断）—— 但必须可见
        console.warn('[TVRB] 退潮判定表读取失败，本次按昨日行情行推断首日:', e && e.message);
        prevEbbDay.value = null;
        prevEbbDayDate.value = pd;
      });
    }
    // ③ ★ [EBB-R20 2026-10-20] 近 22 个交易日的退潮判定历史（「首次 / 二次确认 / 无第三次」的输入）。
    //   ★ [EBB-20D 2026-10-22 用户口径] 行数 = EBB_EVENT_WINDOW_DAYS + 2：
    //     前 20 天是事件窗口，多取的 2 天只用来证明「窗口第一天那笔不是延续日」
    //     （用户原话「时间太短没有检查到10月13日那天」⇒ 10 天窗口跨不过一个完整老周期）。
    //   一次 in 查询（§32）；每行带上自己的上一交易日（日期链在此算好，规则层保持纯函数）。
    if (ebbHistoryDate.value !== d) {
      const histDates = [];
      let cur = d;
      for (let i = 0; i < (EBB_EVENT_WINDOW_DAYS + 2); i++) {
        cur = getPreviousTradingDay(cur);
        if (!cur) break;
        histDates.push(cur);
      }
      if (histDates.length >= 2) {
        // ★ [EBB-20D] 窗口起点 = 第 EBB_EVENT_WINDOW_DAYS 个交易日（含 pd 那一格）
        const winFrom = histDates[EBB_EVENT_WINDOW_DAYS - 1] || histDates[histDates.length - 1] || '';
        readEbbDays(histDates).then(function(m) {
          if (currentDate.value !== d) return;   // 竞态保护：期间切了日期 ⇒ 丢弃
          const rows = [];
          for (let i = 0; i < histDates.length; i++) {
            const r = m.get(histDates[i]);
            if (!r) continue;
            rows.push({
              date: histDates[i],
              prevDate: histDates[i + 1] || '',
              leaderStock: r.leaderStock,
              leaderTopic: r.leaderTopic,
              ebb: r.ebb
            });
          }
          ebbHistory.value = rows;
          ebbHistoryFrom.value = winFrom;
          ebbHistoryDate.value = d;
          // ★★ [SWITCH 2026-10-22] 顺带判一下「今天是不是切换日」（第二十八条）：
          //   是 ⇒ 才去读近 20 个交易日的每日榜（普通日子多打一次 REST 纯属浪费，§32）。
          //   ⛔ 判据用规则层的 detectSwitchDay（同一把尺子），这里只做【要不要取数】的决策。
          //   ★ [CORE-CAT 2026-10-22] 第三个入参传大类归一函数：否则「文化传媒 vs AI应用」
          //     跨不过去，切换日会在题材名漂移的那天静默失效（与 10-22 误判同一根因）。
          const ppd = pd ? getPreviousTradingDay(pd) : '';
          if (ppd && detectSwitchDay(rows, ppd, makeCoreTopicResolver(getCoreTopics()), winFrom)) {
            ensureTop5History(d);
          }
        }).catch(function(e) {
          // §10：读失败 ⇒ 按「没有历史」处理（规则层按 0 次事件 = 首次退潮）—— 但必须可见
          console.warn('[TVRB] 退潮判定历史读取失败，本次按 0 次事件（首次退潮）处理:', e && e.message);
          ebbHistory.value = [];
          ebbHistoryFrom.value = '';
          ebbHistoryDate.value = d;
        });
      } else {
        ebbHistory.value = [];
        ebbHistoryFrom.value = '';
        ebbHistoryDate.value = d;
      }
    }
  }, { immediate: true });

  const data = computed(function() {
    void version.value;                 // 显式声明对刷新信号的依赖
    // ★ [EBB] 昨日十日涨幅（异步读回）⇒ 读到之后重算一次，退潮首日规则才生效
    void prevRangeMap.value;
    // ★★ [BUY-SETTLE 2026-10-31] 「昨日十日涨幅读过没有」—— 买点侧门控的输入之一
    //   （它和上面的 map 不是一回事：读失败时 map 恒 null 但这一格会落地，见其注释）
    void prevRangeTriedDate.value;
    // ★★ [BUY-SETTLE 2026-10-31] 核心词表（题材大类）是否已从云端读过 —— 到货前题材分组按
    //   「细分原文」算、到货后按「大类」算 ⇒ 只数 / 档位不同 ⇒ 选出来的票也不同。
    //   ⛔ 不能拿下面的 `getCoreTopicsVersion()` 顶替（那只是「变了就重算」的信号，见 rules.js）。
    void isCoreTopicsCloudLoaded();
    // ★ [EBB-R8] 上一交易日落库的退潮判定（异步读回）⇒ 读到之后重算一次，首日闸门才生效
    void prevEbbDay.value;
    // ★★ [EBB-R8] 展示日当天的十日涨幅（异步读回）⇒ 读到之后重算一次：
    //   ① 买点侧那只【市场龙二】才算得出；② 更重要的是【消除切日期后的空白期】
    //      （dragonState 还没跟上新日期时，先用这份渲染，见 curRangeMap 的注释）
    void curRangeMap.value;
    // ★★ [TVRB-926] 展示日【9:26 口径】的区间涨幅（异步读回）⇒ 买点侧选股与行上数值的输入：
    //   读到之后重算一次 —— 选股从「当前口径」切到「早上 9:26 那一刻选中的那批」。
    void buyRangeMap.value;
    // ★★ [R20-926 2026-10-24] 20日涨幅 9:26 口径名次（异步读回）⇒ 到货后重算一帧：
    //   买点侧那两条 20日涨幅通道的说明文案才会带上「9:26 那一刻的涨幅 + 第几名」。
    void r20AucMap.value;
    // ★ [EBB-R20] 20日涨幅前五（总龙一~五）：响应式指纹令牌 —— ensureRange20Leaders 发布后自动重算
    void getRange20LeadersFingerprintToken();
    // ★★ [CORE-CAT 2026-10-22] 核心词表（大类）变更信号：云端加载完成 / 用户改完核心词 ⇒ 本帧重算，
    //   否则「文化传媒 ⇒ AI应用」的归一结果会停在首帧那份默认核心词上（§10 不能静默用旧口径）。
    void getCoreTopicsVersion();
    // ★ [EBB-R20] 近 20 个交易日的退潮判定历史（异步读回）⇒「首次 / 二次确认」阶段判定才生效
    void ebbHistory.value;
    void ebbHistoryFrom.value;
    // ★★ [SWITCH 2026-10-22] 近 20 个交易日的每日前五榜（异步读回）⇒ 第二十八条「新龙」判定才生效
    void top5HistEver.value;
    void top5HistDays.value;
    // ★ [DIVERGE 2026-10-20] 总龙首次分歧判定（异步算出）⇒ 分歧买点才生效
    void divergeVerdict.value;
    // ★★ [DIVERGE-GUESS 2026-10-24] 预热猜测（异步算出）⇒ 门控据它决定「今天就挂不挂占位」，
    //   到货后必须重算一帧，否则依然要等精算才知道该不该挂（= 用户抱怨的「过很久才出现」）。
    void divergeGuess.value;
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 十日涨幅候补的两个异步输入：
    //   ① `range10Presence` —— 在列次数（首次 / 二次在列）到货后重算一次；
    //   ② `getPresenceFingerprintToken()` —— Data 层的到货令牌（缓存刷新 / 清空时版本号变化），
    //      保证「先算了一轮判不出、数据后到」时也会自动补算一次（与 range20 指纹同一套路）。
    void range10Presence.value;
    void getPresenceFingerprintToken();
    // 分笔那份是响应式单例 ⇒ 显式声明依赖，数据到了自动重算（§17 不阻塞渲染）
    void tickMinuteMap.value;
    void tickMinuteDate.value;
    void tickMinuteAttempted.value;
    void tickMinuteSkipMap.value;

    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // [TVRB] 题材排名恒为「平均竞价量比降序」⇒ 模式固定传 MODE_VOL_RATIO
      //   （⛔ 不跟早盘竞价的「题材 / 一字」toggle 联动：本看板的定义就是按量比排）。
      // actionContext=true → 额外取回买卖点标签上下文 + 卖点候选行（见 decision-collect 的出口注释）
      // ★ [EBB] prevRangeMap = 上一交易日的十日涨幅（算市场总龙用）；没读回来 ⇒ null ⇒ 退潮规则不生效
      //
      // ★★ [EBB-R8c 2026-10-14 端到端实测修 · 【日期串味】闸门] 两份 rangeMap 传入前【必须逐份核对日期】：
      //   它们都是【异步】读回的 ref。切日期那一帧，ref 里还挂着【上一个展示日】的 map，
      //   而 data 是【同步 computed】⇒ 会立刻拿旧日期的数据算一遍并渲染出去。实测（真实 10-13 数据）：
      //     切到 10-13 后的最初几秒，退潮横幅把总龙的「昨日十日涨幅」显示成 +136% —— 那是【10-13 当日】
      //     的值；昨日（10-12）真值是 159.51% ⇒ 静置约 12s 后才变回 +160%。
      //   把 A 日的数据当 B 日用是 §10 红线（口径注释自己就写着「⛔ 必传『昨日』那份」），
      //   故：日期不匹配 ⇒ 传 null（= 未知 ⇒ 退潮规则本次不生效），⛔ 绝不拿错日期的数据顶替。
      //   ⚠️ 与本看板「消除切日期空白期」不冲突，也不把性能退回去：
      //     · 空白期的闸门在 decision-collect 的「十日涨幅 / 龙头数据」那张网，解除它靠的是
      //       **注入这件事本身**（一次直读，快过 useAuctionBoard 那条串行链），而不是「注入错日期的数据」；
      //     · readRangePctForDate 有会话级缓存 ⇒ 常见切换路径（如 10-14 ↔ 10-13，两份互为对方的
      //       prev / cur）里被核对的那份【已经在缓存**，核对几乎零延迟。
      const pd = getPreviousTradingDay(d);
      const rec = collectDecisionTopics(d, {
        mode: MODE_VOL_RATIO,
        actionContext: true,
        // 上一交易日的十日涨幅（算市场总龙 = 昨日口径）—— 只认【日期对得上】的那份
        prevRangeMap: (prevRangeMap.value && prevRangeDate.value === pd) ? prevRangeMap.value : null,
        // ★★ [EBB-R8] 展示日【当天】的十日涨幅（算买点侧唯一那只 = 当日口径）
        //   + 🔴 消除「切日期后 dragonState 尚未跟上」造成的空白期（见 curRangeMap 的注释）
        rangeMap: (curRangeMap.value && curRangeDate.value === d) ? curRangeMap.value : null,
        // ★ [EBB-R20 2026-10-20] 20日涨幅前五（总龙一~五）—— 退潮判定的总龙与买点侧替补的【唯一】来源；
        //   null = 该日还没发布结论（20日前五在后台算）⇒ 退潮规则本次不生效（§10，不猜）
        range20Top: getRange20Leaders(d) || null,
        // ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 20日涨幅【前八】—— 只给第二十八条挑新龙当候选池
        //   （用户「如果前五找不到，你就找前八的」）；⛔ 展示 / 分歧买点 / 总龙标签仍只用前五。
        range20Wide: getRange20LeadersWide(d) || null,
        // ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 20日涨幅【前十】—— 只给退潮判定的
        //   「主线题材 ≥3 只同题材」计数（classifyMainTopic）。⛔ 不上屏（展示仍是前五）。
        range20Top10: getRange20LeadersTop10(d) || null
      });
      if (!rec || !rec.ready) return _empty((rec && rec.reason) || '暂无数据');

      // ① 本看板自己的选股 + 标签收口（标签管线 = 决策看板的同一份实现）
      //
      // ★★ [TVRB-926 2026-10-14 用户口径] 买点侧选股固定用【9:26 口径】：
      //   · `buyDragonMap` = 与 rec.dragonMap 【同一把尺子】（rankDragonsWithPctMap → 同一个
      //     computeDragonRankMap），只把「算龙位用的十日涨幅」换成 9:26 那一份；
      //   · `pctMap` 同时下发 ⇒ 买点行上的十日涨幅与龙位【同一口径】（§6 内部自洽，
      //     ⛔ 绝不让「龙一」的标签配着收盘口径的数值）。
      //   ⛔ 第 2 参仍是 rec.dragonMap（收盘口径）：卖点段 + finishBuyBlock 的题材统计走它，
      //      退潮判定（rec.ebbCtx）在采集层就已经用收盘口径算好 ⇒ 逐字不变（用户「只改买点侧」）。
      //   ⚠️ 日期核对（与上面两份 rangeMap 同一条红线）：异步读回的 ref 在切日期那一帧还挂着旧日期
      //      的数据 ⇒ 只认【日期对得上】的那份，⛔ 绝不拿 A 日的数据当 B 日选股。
      const buyMap = (buyRangeMap.value && buyRangeDate.value === d) ? buyRangeMap.value : null;
      // ★ [DIVERGE 2026-10-20] 组装「总龙首次分歧」的规则输入：
      //   判定（异步 K 线算出）+ 前五事实（rec.ebbCtx.top5 —— 题材/龙位/停牌已由采集层富化，§6）。
      //   ⛔ 日期核对红线（与两份 rangeMap 同款）：判定不是这一天的 ⇒ 传 null。
      //   ⛔ todayFirst=false（不是首次分歧日）⇒ 传 null（规则层零行为，§11）。
      const _ldVerdict = (divergeDate.value === d) ? divergeVerdict.value : null;
      const _ldTop5 = (rec.ebbCtx && Array.isArray(rec.ebbCtx.top5)) ? rec.ebbCtx.top5 : [];
      // [DIVERGE-DIAG] 组装证据链：判定到没到 / 前五事实有没有
      if (_ldVerdict || _ldTop5.length > 0) {
        _dbgLog('[DIVERGE-OPT] ' + d + ' verdictDate=' + divergeDate.value +
          ' canJudge=' + (_ldVerdict ? _ldVerdict.canJudge : '—') +
          ' todayFirst=' + (_ldVerdict ? _ldVerdict.todayFirstDivergence : '—') +
          ' top5=' + _ldTop5.length);
      }
      let leaderDivergeOpt = null;
      if (_ldVerdict && _ldVerdict.canJudge && _ldVerdict.todayFirstDivergence && _ldTop5.length > 0) {
        const _head = _ldTop5[0];
        const _l0 = (getRange20Leaders(d) || [])[0] || null;
        leaderDivergeOpt = {
          todayFirst: true,
          firstBoardYmd: _ldVerdict.firstBoardYmd || '',
          firstDivergenceYmd: _ldVerdict.firstDivergenceYmd || '',
          aucPctText: (_ldVerdict.todayAucPct !== null && _ldVerdict.todayAucPct !== undefined)
            ? Number(_ldVerdict.todayAucPct).toFixed(2) + '%' : '—',
          leaderName: (_head && _head.name) || (_l0 && _l0.stock) || '',
          leaderCode: (_head && _head.code) || (_l0 && _l0.code) || '',
          leaderPct: _l0 ? _l0.pct : null,
          leaderPctText: (_l0 && isFinite(Number(_l0.pct))) ? Number(_l0.pct).toFixed(2) + '%' : '—',
          leaderTopic: (_head && _head.topic) || '',
          top5: _ldTop5
        };
      }
      const plan = buildTopicVolRatioPlan(rec.topics, rec.dragonMap, {
        date: d,
        ctx: {
          prevDragonNames: rec.prevDragonNames,
          prevBuyNames: rec.prevBuyNames,
          prevBought: rec.prevBought,
          prevBoughtTopics: rec.prevBoughtTopics,
          topicStreakPast: rec.topicStreakPast
        },
        sellRows: rec.sellRows || [],
        // ★ [EBB 2026-10-13] 退潮首日的【事实】（市场总龙 / 今日停牌 / 今日占比 / 同题材龙位成员 /
        //   市场总龙二）；ready=false ⇒ 不是退潮日（⛔ 不猜）
        ebbCtx: rec.ebbCtx || null,
        // ★ [EBB-R8 2026-10-14] 上一交易日【落库的退潮判定】那一行（tvrb_ebb_days）
        //   —— 昨日闸门的输入；缺省 ⇒ 规则层退化为「用昨日行情行推断」，再取不到按可触发处理。
        prevEbbDay: prevEbbDay.value,
        // ★ [EBB-R20 2026-10-20] 近 12 个交易日的退潮判定历史（tvrb_ebb_days）
        //   —— 「首次 / 二次确认 / 无第三次」事件计数的输入；缺省 ⇒ 按 0 次事件（首次退潮）。
        //   ⚠️ 日期核对（与上面两份 rangeMap 同一条红线）：还没读到 / 读的是旧日期 ⇒ 传 null。
        ebbHistory: (ebbHistoryDate.value === d) ? ebbHistory.value : null,
        // ★ [EBB-20D 2026-10-22 用户口径] 事件窗口起点（第 20 个交易日的日期）——
        //   与上面 ebbHistory 同一条日期核对红线：不是这一天读的 ⇒ 传空（规则层退回按已有日期取 20 个）。
        ebbWindowFrom: (ebbHistoryDate.value === d) ? ebbHistoryFrom.value : '',
        // ★★ [TVRB-926] 买点侧专用的 9:26 口径（缺 ⇒ 规则层退回原口径 = 旧行为，§11）
        buyDragonMap: buyMap ? rankDragonsWithPctMap(rec.topics, buyMap) : null,
        pctMap: buyMap,
        // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「买不进名单」= 【连续停牌第 2 天及以上】的票
        //   （collectDecisionTopics 出口已用库里当日/昨日竞价行算好，见 decision-collect
        //    #nonFirstDaySuspendNames）。规则层把它与「竞价一字」走同一条【跳过并顺延下一龙位】。
        //   ⛔ 缺省 ⇒ 规则层退回旧行为（停牌票照旧可选，§11）；停牌【首日】不在名单里（仍可入选）。
        buySkipNames: rec.buySkipSuspend || null,
        // ★ [DIVERGE 2026-10-20] 总龙首次分歧判定（null = 判不出 / 不是首次分歧日 ⇒ 规则层零行为）
        leaderDiverge: leaderDivergeOpt,
        // ★ [EBB-D1 2026-10-21] 上一交易日（日期链在组合式算好注入，规则层保持纯函数）——
        //   「昨日二次确认退潮 ⇒ 次日禁入买点侧」（第二十六条）用它去 ebbHistory 里找昨日那一行。
        prevDate: pd || '',
        // ★★ [SWITCH 2026-10-22] 第二十八条「新龙 / 新题材切换日」的三个输入：
        //   prevPrevDate    = 前两个交易日（切换日判据：二次确认退潮正好发生在 D，今天 = D+2）；
        //   top5HistoryEver = 近 20 个交易日【上过前五】的票（判「首次上榜」）；null ⇒ 判不出 ⇒ 不收紧；
        //   top5HistoryDays = 历史榜实际覆盖天数（只写说明，⛔ 不参与判定）。
        //   ⚠️ 日期核对（与两份 rangeMap 同一条红线）：读的不是这一天 ⇒ 传 null（§10 不拿旧日期顶替）。
        prevPrevDate: pd ? (getPreviousTradingDay(pd) || '') : '',
        top5HistoryEver: (top5HistDate.value === d) ? top5HistEver.value : null,
        top5HistoryDays: (top5HistDate.value === d) ? top5HistDays.value : 0,
        // ★★ [CORE-CAT 2026-10-22 用户口径] 题材【大类】映射（核心管理那张表）——
        //   规则层据此把「文化传媒」认成「AI应用」。用户原话：「那个大类就是我说的题材」。
        //   ⛔ 规则层不自己读表（§5），这里注入；取不到 ⇒ 退化为恒等（§11 零行为变化）。
        coreTopics: getCoreTopics(),
        // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条「十日涨幅 · 在列次数候补」的输入：
        //   range10Rows     = 十日涨幅候选池（采集层出口）——**含「20天」补位行**。
        //                     🔴 10-23 事故：漏了补位行（屏幕第 3 行慈文传媒）⇒ 名次整体前移一位
        //                     ⇒ 主板第 11 名的上海九百被当成第 10 名顶上来。见 decision-collect#range10Rows。
        //   range10Presence = 十日窗口的在列次数（首次 / 二次在列的唯一依据）。
        //   range10Complete = 池子是否【与屏幕同一批行】（补位数据到没到）。false ⇒ 规则层判不出、不选（§10）。
        //   ⚠️ 日期核对红线（与两份 rangeMap 同款）：Presence 不是这一天的 ⇒ 传 null（§10 不拿旧日期顶替）。
        range10Rows: rec.range10Rows || null,
        range10Complete: rec.range10PoolComplete !== false,
        range10Presence: (range10PresenceDate.value === d && range10Presence.value)
          ? range10Presence.value
          : null,
        // ★★ [R20-926 2026-10-24 用户口径] 20日涨幅的【9:26 竞价口径】主板名次 ——
        //   只给说明区写事实（「9:26 那一刻 涨幅 + 第几名」），⛔ 不参与选股、⛔ 不影响退潮 / 总龙。
        //   ⚠️ 日期核对红线（与上面几份 rangeMap 同一条）：读的不是这一天 ⇒ 传 null（§10 不拿旧日期顶替）。
        range20Auc: (r20AucDate.value === d) ? r20AucMap.value : null
      });

      // §10 ★★ 失败 / 缺数据必须可见：这一天【确实读过】9:26 口径、但没拿到（失败或表里没有）
      //   ⇒ 在说明区如实标出来。⛔ 绝不静默拿当前（收盘）口径冒充「早上 9:26 那一份」。
      //   ⚠️ `buyRangeDate !== d`（还没读完）不打标记 —— 那只是异步没回来，首帧闪一条假告警更糟。
      if (buyRangeDate.value === d && !buyMap) {
        plan.notes.unshift('⚠️ 本日【9:26 口径】（= 竞价涨幅换腿前那一份）未读到 ⇒ 买点侧选股' +
          '暂按当前口径显示。这通常意味着该日缺少「收盘涨幅 / 竞价涨幅」中的一项，' +
          '无法把那根腿反解回竞价口径（第 二十三 条）。');
      }

      // ② 逐行装饰（竞价量比趋势 / 龙标名次变化 / 封单额 + 连板）——与决策看板同一份实现
      //   ⚠️ 传的仍是 rec.dragonMap：`_decorateDragonRankChange` 只读【今日龙位】与【昨日龙位】做
      //      名次变化徽标，它服务于决策看板的口径；本看板买点行的龙标由上面的 buyDragonMap 产出
      //      （用户只要「选股按 9:26」，「名次变化」属于客观数据，保持原口径，§11）。
      decorateDecisionRows(plan.buy, plan.sell, d, rec.prevDate, rec.dragonMap);

      // ③ 分笔明细（与「分笔买卖」看板同一份取数 + 同一份逐行实现）
      // ⚠️ 只认【属于这一天】的那份分笔（tickMinuteDate 单独一格：读库是异步的，
      //    切换日期的瞬间它还留着上一天的数据）。⛔ 用错日期会给出一个看着很像真的假统计。
      const map = (tickMinuteDate.value === d) ? tickMinuteMap.value : EMPTY_MAP;
      const attempted = tickMinuteAttempted.value.get(d) || EMPTY_SET;
      const skipMap = _skipMapOf(d);
      // ⛔ 买点 pick 自带 code（由本看板的候选构造透传）⇒ 不需要 memberMap 反查；
      //    卖点行同样自带 code ⇒ 两边都传 null（与分笔看板的 buy 侧传 memberMap 等价，
      //    只是本看板在建 pick 时已经带上 code，省掉一次反查）。
      // ⚠️ 退潮首日那只【唯一买点】(plan.ebbBuy) 【不在】plan.blocks 里 —— 它要渲染在灰化容器【之外】，
      //    所以这里必须单独带上它走一遍；否则它拿不到分笔行（§6：装饰只有这一处，⛔ 别在组件里再铺一次）。
      const buyBlockLists = [plan.blocks,
        plan.ebbBuy ? [plan.ebbBuy] : [],
        plan.divergeBuy ? [plan.divergeBuy] : [],
        // ★★ [SWITCH 2026-10-22] 第二十八条的新龙那一行同样要拿分笔（它也在灰化容器之外）
        plan.newDragon ? [plan.newDragon] : [],
        // ★★ [R10-BACKUP 2026-10-24] 第二十九条的十日涨幅候补同样要拿分笔（它也在灰化容器之外）——
        //   ⛔ 漏掉它，那只票点开就是「分笔明细暂不可用」（装饰只有这一处，§6）
        plan.range10Backup ? [plan.range10Backup] : [],
        // ★★ [WEAK-HUDDLE 2026-10-27] 第三十条的「弱势切抱团」同样要拿分笔（它也在灰化容器之外）——
        //   ⛔ 漏掉它，那只票点开就是「分笔明细暂不可用」（装饰只有这一处，§6）
        plan.weakHuddle ? [plan.weakHuddle] : [],
        // ★★ [CATCH-UP 2026-10-27] 第三十一条的「补涨题材」同样要拿分笔（它也在灰化容器之外）
        plan.catchUp ? [plan.catchUp] : []];
      buyBlockLists.forEach(function(arr) {
        arr.forEach(function(b) {
          (b.picks || []).forEach(function(p) {
            Object.assign(p, decorateTickRow(p, map, attempted, skipMap, null, 'buy'));
          });
        });
      });
      plan.sell.forEach(function(g) {
        (g.items || []).forEach(function(it) {
          Object.assign(it, decorateTickRow(it, map, attempted, skipMap, null, 'sell'));
        });
      });

      // ★★ [DIVERGE-GATE 2026-10-21 用户口径] 分歧判定未就绪 ⇒ 买点侧先挂「判定计算中」占位，
      //   ⛔ 绝不先把旧规则的选票渲染出去再换板。用户原话：「刚开始显示的是以前旧规则的票，
      //   后面停顿了几秒钟，才出现那个提示词分歧的信息板……我做决定很快，万一哪天它没跳转，
      //   我不就买错股票了？所以要修复下。」
      //   门控条件（全部【同步可判】，⛔ 无 setTimeout 掩盖；判定落地（落库读回 / K 线链路）⇒
      //   divergeVerdict 变更 → data 自动重算 → 本帧放行，一次成型）：
      //     ① 该日分歧判定还没落地（在途 / 退避重试中）—— divergeVerdict 尚无 ready 结论；
      //     ② 「今天还定不了是不是分歧日」，两条路（满足其一即视为定不了）：
      //        a. 前五与当日事实已就绪（rec.ebbCtx.ready）⇒ 同步预检：非退潮日 + 总龙今日未停牌 +
      //           总龙今日低开（竞价涨幅 < 0）或【取不到】（取不到 ⇒ 保守等待，宁可多等不错显 §10）；
      //        b. 事实还没就绪（range20 精算 / 昨日涨幅还在读）⇒
      //           · 历史日 ⇒ 保守等待（这些输入都在库里，秒级；多等一两秒换「一次到位」）；
      //           · 【今天】⇒ 只认【预热猜测】（DIVERGE-GUESS，昨日总龙一的判定，1 只票 K 线秒级）：
      //             猜「是分歧日」⇒ 秒挂占位；猜不出来 / 猜「不是」⇒ 不挂（= 加预热之前的零行为，§11）。
      //   ★ 判据本体已抽成纯函数 shouldGateBuySide（§15 可单测），⛔ 别再往这里堆行内 if。
      //   [DIVERGE-GATE-2 2026-10-24 用户口径] 修掉「占位总过很久才出现」：
      //     此前今天恒不挂（等精算十几秒 ⇒ 那段时间屏幕上是会变的常规票）—— 这正是用户抱怨的现象。
      const _isTodayD = (d === _getLocalTodayStr());
      const _ebbCtxReady = !!(rec.ebbCtx && rec.ebbCtx.ready);
      //   ⚠️ 日期核对（与两份 rangeMap 同一条红线）：猜测不是这一天的 ⇒ 当没有。
      const _dGuess = (divergeGuess.value && divergeGuess.value.date === d) ? divergeGuess.value : null;
      const _guessFirst = !!(_dGuess && _dGuess.verdict && _dGuess.verdict.canJudge &&
        _dGuess.verdict.todayFirstDivergence);
      const _gate = shouldGateBuySide({
        verdictReady: !!(_ldVerdict && _ldVerdict.ready),
        ebbCtxReady: _ebbCtxReady,
        ebb: !!plan.ebb,
        leaderSuspended: !!(_ebbCtxReady && rec.ebbCtx.leaderSuspended),
        //   ⚠️ 只在事实就绪时读它（未就绪时 rec.ebbCtx 里那个值是占位 null，⛔ 别当「取不到」用）
        leaderAucPct: _ebbCtxReady ? rec.ebbCtx.leaderAucPct : null,
        isToday: _isTodayD,
        guessFirst: _guessFirst
      });
      if (_gate && rec.ready) {
        plan.divergePending = true;
        _dbgLog('[DIVERGE-GATE] ' + d + ' 分歧判定未就绪 ⇒ 买点侧挂「判定计算中」占位' +
          '（ebbCtxReady=' + _ebbCtxReady + ' leaderAucPct=' +
          (_ebbCtxReady ? rec.ebbCtx.leaderAucPct : '—') +
          ' isToday=' + _isTodayD + ' 预热猜测=' +
          (_dGuess ? (_dGuess.stock + '→' + _guessFirst) : '无') + '）');
      }

      // ★★ [BUY-SETTLE 2026-10-31 用户口径 · 第二版] 选股输入没齐 ⇒ 买点侧先不出票。
      //
      // 🔴 用户报障（逐字，第二次）：「还是和原来一样，它最终显示正确的，但是要等几秒后……
      //   刚开始选的是上海九百和文投控股，几秒钟后，文投控股消失……文投控股从开始就不要显示，
      //   很容易误导，或者你在标题栏那里提示下，等最终结果，最终结果还没出来之类的提示语。」
      //
      // 🔴【上一版为什么不够】上一版只挡了「9:26 竞价口径」一项，但买点侧的选股**有七项异步输入**，
      //   每一项到货都会让本 computed 重算一次、都可能换一批票：
      //     ① 核心题材【大类】（`loadCoreTopicsFromCloud`）—— 归一结果变 ⇒ 题材分组合并/拆分
      //        ⇒ 只数 ⇒ 档位（pickCount 1/2/3）⇒ 选几只。⚠️ 它到货**最容易**造成「两只变一只」。
      //     ② 9:26 竞价口径 ⇒ 组内十日涨幅重排 ⇒ 龙位变 ⇒ 选哪只；
      //     ③ 当日十日涨幅；④ 昨日十日涨幅；⑤ 昨日退潮判定；⑥ 近 20 日退潮历史
      //        —— ④⑤⑥ 判错会**整段换板**（退潮替补 vs 常规选股）。切日期那一帧
      //        `ebbHistory` 为空 ⇒ 规则层按「0 次事件 = 首次退潮」处理 ⇒ 首帧很可能整个走退潮替补。
      //     ⑦ 十日涨幅在列次数（第二十九条候补 / 小题材收紧）+ 切换日才要的 20 日涨幅历史榜。
      //   ⇒ 「暂定值」这段时间里屏幕上那两只票，**跟最终结论没关系**。用户看到的就是误导。
      //
      // ✅ 判据抽在 `logic/topicvolratio/buy-settle.js#resolveBuySettle`（纯函数 + 单测）：
      //    七项全部「落地」（= 每项都有成功或失败的结论）才显示选票；未齐 ⇒ 买点侧只挂占位，
      //    并把**还差哪几项**同时写进占位横幅与头部标题栏（用户要的「提示语」）。
      //   · 只认【日期对得上】的那份（切日期那一帧 ref 里还是旧日期 ⇒ 继续挂占位，§10 红线）；
      //   · 「读过」就算落地（成功/失败都写日期）⇒ ⛔ 不会因为一次读失败把买点侧永久锁死；
      //   · 同步可判、⛔ 无 setTimeout；任一输入落地 ⇒ 本 computed 自动重算 ⇒ 齐了自动放行。
      const _settle = resolveBuySettle({
        date: d,
        prevDate: pd,
        coreTopicsLoaded: isCoreTopicsCloudLoaded(),
        buyRangeDate: buyRangeDate.value,
        curRangeDate: curRangeDate.value,
        prevRangeTriedDate: prevRangeTriedDate.value,
        prevEbbDayDate: prevEbbDayDate.value,
        ebbHistoryDate: ebbHistoryDate.value,
        range10PresenceDate: range10PresenceDate.value,
        switchDay: !!plan.switchDay,
        top5HistDate: top5HistDate.value,
        // ★★ [BUY-SETTLE-2 2026-10-31] 20 日涨幅前五的结论（退潮判定的总龙一就靠它）：
        //   未到 ⇒ 退潮规则不生效 ⇒ 按常规选股；到货后若判出退潮 ⇒ 整段换成退潮替补 ⇒ 屏幕上的票会变。
        //   宽限期（gateGraceDate）已过也算落地 —— ⛔ 绝不让买点侧因为上游算不出来而永久挂起。
        range20Settled: hasRange20LeadersVerdictForDate(d) || gateGraceDate.value === d,
        // ★★ [BUY-SETTLE-2 2026-10-31] 题材库（stock_topics）就绪。
        //   实测 10-30：正式名单 42 行里【两只票的 topics 字段都是 null】，题材完全靠题材库反查
        //   ⇒ 库没到之前它们全落「其它」⇒ 题材分组 / 组内只数 / 档位全错 ⇒ 选出来的是另一批票。
        //   同样带宽限（库拉不到时不能让买点侧永远空着）。
        topicLibraryReady: isTopicLibraryReady() || gateGraceDate.value === d
      });
      if (!_settle.settled) {
        plan.buyPending = true;
        plan.buyPendingText = _settle.text;
        // ⚠️ 只记一次（按「日期 + 缺项」去重）：data computed 在等待期间会因别的依赖变化重算多次，
        //    每帧打一条会把 `_dbgLog` 那 200 条环形缓冲冲掉、把真正有用的现场挤出去。
        const _settleKey = d + '|' + _settle.missing.join(',');
        if (_settleKey !== _settleLogged) {
          _settleLogged = _settleKey;
          _dbgLog('[TVRB-BUY-SETTLE] ' + d + ' 选股输入未齐 ⇒ 买点侧先不显示选票（' + _settle.text + '）');
        }
      } else if (_settleLogged) {
        // 齐了 ⇒ 清掉去重标记（同一天稍后又缺项时还能再记一次），并留一条「已放行」的痕迹
        _settleLogged = '';
        _dbgLog('[TVRB-BUY-SETTLE] ' + d + ' 选股输入已齐 ⇒ 买点侧放行（结果从此不再变）');
      }

      return { ready: true, reason: '', plan: plan };
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有入选股票」
      errorText.value = '题材量比计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[TVRB] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ★★ [BUY-SETTLE-2 2026-10-31 用户口径 · 第三版] 买点侧「结果确认」的两道闸门
  //
  // 用户第三次报障：「刷新后变成了一只，后面又跳转两只，最后又变成一只，还是没有彻底解决。」
  //
  // 🔴 前两版为什么没修好：都在做【输入侧白名单】枚举（第一版挡 1 项、第二版挡 8 项），
  //    而买点侧选股还吃 `collectDecisionTopics` 从**全局内存**里读的一大堆东西 ——
  //    当日正式名单索引 / `stock_topics` 题材库 / `auction_watchlist` 竞价行 /
  //    `market_metrics` 竞价量比（题材排名 = 平均量比！）/ 昨日龙头名册 / 竞昨高光继承集（灰行来源）/
  //    昨日卖标签继承集 / 竞价一字与停牌名单 / 20 日涨幅前五 ……
  //    每一项都是异步到货、每一项都可能改「选几只 / 选哪只 / 常规还是退潮替补」。
  //    ⇒ **枚举注定会漏**，用户每次都能看到换票。
  //
  // ✅ 第三版补两道（与原 ① 一起，共三道，⛔ 别再删掉任何一道）：
  //    ② 「20 日涨幅前五结论」到达（最慢的那一项，且能整段换板）—— 带 6s 宽限，⛔ 不永久挂起；
  //    ③ 【结果侧】选股指纹连续 BUY_QUIET_MS 不被推翻 —— 不枚举数据源，天然覆盖未来新增的输入。
  //    ⚠️ 三道闸门的 UI 表现是同一条占位横幅，文案由 `buyPendingText` 说明在等什么。
  // ════════════════════════════════════════════════════════════════════════════════════════

  /** 慢判据宽限期（毫秒）：超过它就放行（「判不出」≠「不能买」，但也不能让买点侧永远空着） */
  const GATE_GRACE_MS = 6000;
  let _gateGraceTimer = null;
  /** 还有哪些「慢判据」没就绪（就绪了就不该起表，用户不必白等那 6s） */
  function _slowGateMissing(date) {
    const d = String(date || '').trim();
    if (!d) return false;
    if (!hasRange20LeadersVerdictForDate(d)) return true;   // 20 日涨幅前五结论
    if (!isTopicLibraryReady()) return true;                // 题材库
    return false;
  }
  // ★★ [NET-QUIET 2026-10-31] 这里**只按【展示日】起一次表** ——
  //   ⛔ 绝不能把 `version` / 20 日涨幅指纹放进 watch 源：旧写法每次数据刷新都
  //   `clearTimeout` + 重新计时 ⇒ **刷新越频繁越不放行**（首屏十几条刷新接连进来时，
  //   这 6s 永远走不完 ⇒ 买点侧一直停在「结果确认中」，用户看到的就是「打不开」）。
  //   计时器只负责「判不出来也别永久挂起」，带宽限的日期粒度由 `gateGraceDate` 保证。
  watch(currentDate, function(dateVal) {
    const d = String(dateVal || '').trim();
    if (_gateGraceTimer) { clearTimeout(_gateGraceTimer); _gateGraceTimer = null; }
    // ★★ [NET-QUIET 2026-10-31] 换日 / 首次进入 ⇒ 开一个新的「装载窗口」：
    //   窗口内只要还有请求在途，买点侧就不放行（25s 仍在途 ⇒ 判上游挂住 ⇒ 放行 + 显示警示）。
    //   ⛔ 不要放在 version（数据刷新）上：轮询/刷新会让窗口永远重开，等于永久挂起。
    if (d) markNetLoadWindow();
    if (!d) return;
    if (!_slowGateMissing(d)) { gateGraceDate.value = ''; return; }
    if (gateGraceDate.value === d) return;          // 这一日已经宽限放行过 ⇒ 不重复计时
    _gateGraceTimer = setTimeout(function() {
      _gateGraceTimer = null;
      if (currentDate.value !== d) return;         // 期间切了日期 ⇒ 丢弃（⛔ 别把 A 日的宽限给 B 日）
      // 到点时若其实已经就绪 ⇒ 不必记「宽限」（放行靠真实判据，宽限只留痕）
      if (!_slowGateMissing(d)) { gateGraceDate.value = ''; return; }
      gateGraceDate.value = d;
      _dbgLog('[TVRB-BUY-SETTLE] ' + d + ' 慢判据（20 日涨幅前五 / 题材库）超过 ' + (GATE_GRACE_MS / 1000) +
        's 仍无结论 ⇒ 宽限放行（此后若结论到货导致换票，会重新挂占位）');
    }, GATE_GRACE_MS);
  }, { immediate: true });

  /**
   * 买点侧选股结果指纹（只含用户**能看见的选股结论**：票名 + 六个独立买点块 + 档位 + 灰化题材）。
   * ⛔ 不含涨幅 / 量比 / 封单额 / 名次变化 / 分笔 —— 高频抖动会把稳定期计时器永远重置（§35）。
   */
  const buySelSig = computed(function() {
    const r = data.value;
    if (!r || !r.ready) return '';
    return buildBuySelectionSig(r.plan, eachDecisionRow);
  });

  const _buyQuiesce = createBuyQuiesce({ quietMs: BUY_QUIET_MS });
  /**
   * ★★ [NET-QUIET 2026-10-31 · 第四版] 已经【正式放行】的那一份选股指纹（闩）。
   *
   * 为什么必须有它：`netIdle` 是会被打回的 —— 下一波请求（轮询 / 补拉 / 分笔之外的行情刷新）
   * 一在途就立刻变 false。若门控直接读 `netIdle`，那么**每次轮询起跑都会把买点侧重新挂回占位**，
   * 屏幕上就是一闪一闪的「结果确认中」，比换票更糟（用户会以为页面坏了）。
   * ⇒ 把「放行」按**指纹**记住：同一份指纹放行后不因网络抖动收回；
   *   指纹一变（= 上游真的改写了结论）闩自动失效，重新走「在途 + 稳定期」两道闸门。
   */
  const _buyRelease = ref('');
  /**
   * 放行闩的键 = **日期 + 指纹**。
   * ⚠️ 必须带日期：不同日期的「空仓」指纹是一样的（`n|b|p0|x`），
   *   只按指纹闩的话，切到另一天会「瞬间就放行」—— 那一天的数据其实还在读。
   */
  function _buyReleaseKey() {
    const sig = buySelSig.value;
    if (!sig) return '';
    return String(currentDate.value || '') + '\u0000' + sig;
  }
  watch([buySelSig, netIdle, _buyQuiesce.locked], function() {
    const key = _buyReleaseKey();
    if (!key) return;
    if (_buyRelease.value === key) return;
    if (!netIdle.value && !netStalled.value) return;      // 上游还在读（且没超时）⇒ 不许放行
    if (!_buyQuiesce.isStable(buySelSig.value)) return;   // 结果还没稳定
    _buyRelease.value = key;
    _dbgLog('[TVRB-BUY-SETTLE] ' + currentDate.value + ' 选股结果定稿 ⇒ 放行（放行时在途 ' +
      netInflight.value + '）');
  });
  let _sigDbgN = 0;
  watch(buySelSig, function(sig) {
    const wasLocked = _buyQuiesce.locked.value;
    if (_sigDbgN < 12) { _sigDbgN++; _dbgLog('[TVRB-SIG] #' + _sigDbgN + ' inflight=' + netInflight.value + ' idle=' + netIdle.value + ' sig=' + String(sig).slice(0, 160)); }
    _buyQuiesce.note(sig);
    // 只在「已经放行过、结果又被推翻」时留痕 —— 这是最值得警惕的一类现场
    if (wasLocked && wasLocked !== sig) {
      _dbgLog('[TVRB-BUY-SETTLE] ' + currentDate.value +
        ' 选股结果在显示后又变了 ⇒ 立刻挂回占位，等新的稳定版（旧票已不可信）');
    }
  }, { immediate: true });
  onUnmounted(function() {
    _buyQuiesce.dispose();
    if (_gateGraceTimer) { clearTimeout(_gateGraceTimer); _gateGraceTimer = null; }
  });

  /**
   * ★ [EBB-R8 2026-10-14] 落库：把【今天】算出的退潮判定写进 tvrb_ebb_days（幂等 upsert）。
   *
   * ⛔ 为什么必须放 watch（不能放 data computed）：computed 必须无副作用（§4 红线）。
   * ⛔ 为什么只写【今天】：suspend.js 的判定只对今天可信（历史日恒 false，见它的红线）——
   *    把历史日写进去 = 用「今天没停牌」冒充「那天没停牌」，明天读回来会直接判错首日。
   * ⚠️ 键用「日期 + 判定内容」而不是对象引用：plan 每次重算都换引用（§19/§20）。
   */
  const ebbDayRowKey = computed(function() {
    const p = data.value && data.value.plan;
    const r = p && p.ebbDayRow;
    if (!r || !r.date) return '';
    return [r.date, r.leaderStock, r.ebb ? 1 : 0, r.suspended ? 1 : 0,
      r.shareFail ? 1 : 0, r.buySecond, r.buySecondPct === null ? '' : r.buySecondPct].join('|');
  });
  watch(ebbDayRowKey, function() {
    const p = data.value && data.value.plan;
    const r = p && p.ebbDayRow;
    if (!r || !r.date) return;
    if (r.date !== _getLocalTodayStr()) return;   // 只落今天的判定（见上）
    upsertEbbDay(r).catch(function(e) {
      console.warn('[TVRB] 退潮判定落库失败（不影响看板）:', e && e.message);
    });
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));
  const blocks = computed(() => (data.value.plan ? data.value.plan.blocks : []));
  const sellGroups = computed(() => (data.value.plan ? (data.value.plan.sell || []) : []));
  const notes = computed(() => (data.value.plan ? data.value.plan.notes : []));
  const excludedTopics = computed(() => (data.value.plan ? data.value.plan.excludedTopics : []));
  const pickCount = computed(() => (data.value.plan ? data.value.plan.pickCount : 0));
  /**
   * ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒 —— 判据全在 Logic 层（buildCashAlert），
   *   本处只把它透给模板（§21：模板零计算；§34：UI 不判业务）。
   *   ⛔ 未就绪时是「不提示」（见 _empty）：绝不能因为「数据没算出来」就喊空仓。
   */
  const cashAlert = computed(function() {
    const a = data.value.plan && data.value.plan.cashAlert;
    return a || TVRB_CASH_ALERT_NONE;
  });
  /**
   * ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日 —— 判据全在 Logic 层（detectEbbDay），
   *   本处只把它透给模板（§21 模板零计算；§34 UI 不判业务）。
   *   ⛔ 未就绪 / 不是退潮日 ⇒ null（模板 v-if 不渲染），绝不会拿「没算出来」当「今天退潮」（§10）。
   */
  const ebb = computed(() => (data.value.plan && data.value.plan.ebb) || null);
  /**
   * ★ [EBB-R8 2026-10-14 用户口径] 退潮首日买点侧【唯一那只 · 市场龙二】的买点块（单只票）。
   *
   * 用户原话：「买点只有一个，那就是市场的龙二（不是同题材的）……把它入选到买点侧」。
   * ⚠️ 它【不在 blocks 里】：blocks 是那些要被整体灰化 + 标【退潮不买】的常规题材块；
   *   这一只要渲染在灰化容器【外面】才能一眼看见（见视图的 .tvrb-ebb-only-buy）。
   * ⛔ 不是退潮日 / 当日涨幅未就绪 ⇒ null（模板 v-if 不渲染），绝不退化成别的票（§10）。
   */
  const ebbBuy = computed(() => (data.value.plan && data.value.plan.ebbBuy) || null);
  /** [EBB-R20c 2026-10-20] 二次确认退潮 + 常规选出补涨题材 ⇒ 买点侧顶部的节点说明横幅
   *  （{ headline, detail }，文案全在 Logic 层 §21）；其它场景 null（v-if 不渲染）。
   *  ⛔ 不是退潮日 / 首次退潮 / 二次走兜底 ⇒ null，绝不退化成别的说明（§10）。 */
  const ebbNodeNote = computed(() => (data.value.plan && data.value.plan.ebbNodeNote) || null);
  /** [DIVERGE 2026-10-20] 总龙首次分歧日的分歧买点块（总龙一 + 跟随高标 ≤2 只）；其它场景 null。 */
  const divergeBuy = computed(() => (data.value.plan && data.value.plan.divergeBuy) || null);
  /**
   * ★★ [SWITCH 2026-10-22 用户口径] 第二十八条切换日：
   *   switchDay = { ebbDate, topic, leaderName, since }（今天是不是二次确认退潮后的第 2 个交易日）；
   *   newDragon = 那一行【新龙】的买点块（单只票）。
   * ⚠️ 与 ebbBuy / divergeBuy 同一约定：它【不在 blocks 里】，视图要渲染在灰化容器【之外】
   *   （今天真要买的票不能被父级 grayscale 吞掉）。不是切换日 / 选不出新龙 ⇒ null（v-if 不渲染）。
   */
  const switchDay = computed(() => (data.value.plan && data.value.plan.switchDay) || null);
  const newDragon = computed(() => (data.value.plan && data.value.plan.newDragon) || null);
  /**
   * ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条【十日涨幅 · 在列次数候补】那一只的买点块。
   * ⚠️ 与 ebbBuy / divergeBuy / newDragon 同一约定：它【不在 blocks 里】，
   *   视图必须渲染在灰化容器（.tvrb-buy-list.tvrb-ebb）【之外】——
   *   它是题材量比太小被作废之后【今天真正要买】的那一只，不能被父级 grayscale 吞掉。
   *   不需要候补 / 选不出（含数据未到）⇒ null ⇒ 视图 v-if 不渲染（§10 不拿空壳冒充结论）。
   */
  const range10Backup = computed(() => (data.value.plan && data.value.plan.range10Backup) || null);
  /**
   * ★★ [WEAK-HUDDLE 2026-10-27 用户口径] 第三十条【弱势切抱团】那一块（20日涨幅主板前三 ∧ 与退潮题材同题材）。
   * ⚠️ 与 ebbBuy / divergeBuy / newDragon / range10Backup 同一约定：它【不在 blocks 里】，
   *   视图必须渲染在灰化容器（.tvrb-buy-list.tvrb-ebb）【之外】—— 它是今天唯一还能买的那一只，
   *   不能被父级 grayscale 吞掉；而且用户要求放在【最前面】。
   *   没有票进前三 / 判不出 ⇒ null ⇒ 视图 v-if 不渲染 ⇒ 就是纯空仓（§10 不拿空壳冒充结论）。
   */
  const weakHuddle = computed(() => (data.value.plan && data.value.plan.weakHuddle) || null);
  /**
   * ★★ [CATCH-UP 2026-10-27 用户口径] 第三十一条【补涨题材】那一块
   * （20日涨幅主板第 6~10 名里，灰色题材恰好占 2~3 只，且其中有连板票）。
   * ⚠️ 与 weakHuddle 同一约定：它【不在 blocks 里】，视图必须渲染在灰化容器【之外】、
   *   并且排在【弱势切抱团之后】（两条看的是不同名次区间，同一天可能各出一只）。
   *   数量不达标 / 一只连板都没有 / 判不出 ⇒ null ⇒ 视图 v-if 不渲染（§10）。
   */
  const catchUp = computed(() => (data.value.plan && data.value.plan.catchUp) || null);
  /**
   * ★ [DIVERGE-GATE 2026-10-21] 分歧判定未就绪的门控旗（非 null ⇒ 买点侧渲染「判定计算中」占位、
   *   不渲染旧规则选票 —— 见 data computed 里门控条件的逐条注释）。判不出 / 已就绪 ⇒ null。
   */
  const divergePending = computed(function() {
    const p = data.value.plan;
    return (p && p.divergePending) || null;
  });
  /**
   * ★★ [BUY-SETTLE / BUY-SETTLE-2 2026-10-31 用户口径] 买点侧「最终结果还没出来」。
   *
   * true ⇒ 视图把买点侧的选票整体收起来，只渲染一条占位横幅，标题栏同步写「结果确认中…」。
   * 为什么必须这样（用户原话，先后三次）：
   *   ②「刚开始选的是上海九百和文投控股，几秒钟后，文投控股消失……
   *      文投控股从开始就不要显示，很容易误导，或者你在标题栏那里提示下，等最终结果」
   *   ③「刷新后变成了一只，后面又跳转两只，最后又变成一只，还是没有彻底解决。」
   *
   * 两道判据（缺一不可，⛔ 别再退回只留一道）：
   *   ① `plan.buyPending`  —— 八项**已知**异步输入没落地（buy-settle.js，快、不用等）；
   *   ② 选股指纹**还没稳定** —— 结果侧的通用兜底（buy-quiesce.js）：
   *      指纹连续 BUY_QUIET_MS 不被推翻才算定稿。这条不依赖「枚举数据源」，
   *      ⇒ 题材库 / 竞价行 / 量比缓存 / 昨日名册 / 灰行来源 / 20 日涨幅前五 …… 谁后到都挡得住。
   *
   * ⛔ 它不是「空仓」结论：占位只说【在等什么】，⛔ 不说「今天没票」（§10）。
   * ⛔ 只影响买点侧；卖点侧逐字不变（卖点不吃这些口径）。
   */
  const buyPending = computed(function() {
    const r = data.value;
    // 未就绪时视图走「未就绪 / 失败」那一路，不在这里插一脚（否则会出现两条占位）
    if (!r || !r.ready) return false;
    const p = r.plan;
    if (p && p.buyPending) return true;                    // ① 已知输入未齐（同步可判）
    const sig = buySelSig.value;
    if (!sig) return true;                                 // ② 还没有任何选股结论
    // ③ 这一份结论已经定稿放行（闩）⇒ 网络再怎么抖都不收回（否则每次轮询都会闪一下占位）
    if (_buyRelease.value && _buyRelease.value === _buyReleaseKey()) return false;
    // ④ ★★ [NET-QUIET 2026-10-31] 上游还有请求在途（且未超时）⇒ 一定还会有数据落地、结论必会变。
    //    实测（10-30 真数据）：auction_watchlist 到 +17.9s、market_metrics 到 +23.7s 才齐，
    //    而旧版 6s 宽限早就放行了 ⇒ 屏幕上那两只票是「名单没齐」时的错票。
    //    ⛔ 别改成「等 N 秒」——到货时刻由网络决定（§35）；也⛔ 别只盯已知表名（会漏新数据源）。
    //    ⛔ 也别退回「瞬时在途数」：数据分批起跑，波与波之间会瞬时归零，中途放行必换票。
    if (!netIdle.value && !netStalled.value) return true;
    return !_buyQuiesce.isStable(sig);                     // ⑤ 结果还没稳定 / 又被推翻了
  });
  /** ★ [BUY-SETTLE] 占位/标题栏里那串「还差：A · B · C」（文案在 Logic 层拼好，§21 模板零计算） */
  const buyPendingText = computed(function() {
    const r = data.value;
    const p = r && r.plan;
    if (p && p.buyPendingText) return p.buyPendingText;
    // ① 已齐、② 还在读 / 还没稳定 ⇒ 如实说明在等什么（⛔ 不说「空仓」）
    if (r && r.ready && buyPending.value) {
      if (!netIdle.value && !netStalled.value) {
        // ★ 把「还在算什么」摆出来：冷启动时上游最慢的那一项（20 日涨幅精算要拉几十只票的历史腿）
        //   可能要十几秒，只写「在途 N 个请求」会让人以为卡死了（§10 等待必须可见）。
        const pr = range20Progress.value;
        let extra = '';
        if (pr && pr.date === currentDate.value && pr.total && pr.done < pr.total) {
          extra = '（20日涨幅精算 ' + pr.done + '/' + pr.total + ' 只）';
        }
        if (netInflight.value > 0) {
          return '还差：上游数据仍在读取（在途 ' + netInflight.value + ' 个请求）' + extra;
        }
        // 在途已归零、正在等「静默确认」（NET_IDLE_MS）—— 别写成「在途 0 个请求」，那样像出错了
        return '还差：确认这一批数据已经读完（约 1~2 秒）';
      }
      return '还差：选股结果稳定（上游数据还在到货）';
    }
    return '';
  });
  /**
   * ★★ [NET-QUIET 2026-10-31] 读取超时警示（只在「上游挂了」时出现）。
   *
   * 语义：请求整体超过 25s 未归零 ⇒ 判定上游异常 ⇒ 放行已到的结果，但**必须让用户知道**
   * 这批票可能随后还会变（§10：失败/不确定必须可见，⛔ 不能假装是最终结论）。
   * 与 `buyPending` 互斥：挂着占位时不出这条（占位本身已经说明在等）。
   */
  const buyDataWarning = computed(function() {
    const r = data.value;
    if (!r || !r.ready) return '';
    if (buyPending.value) return '';
    if (!netStalled.value) return '';
    // 网络后来真的静下来了 ⇒ 数据已到齐 ⇒ 这条警示不再成立（§10 只报真的）。
    // ⚠️ 与「放行许可」分开：放行靠**粘性**的 netStalled（撤了会闪回），
    //    警示靠 `netStalled && !netIdle`（读完了就该收）。
    if (netIdle.value) return '';
    return '⚠️ 上游数据读取超时（' + (NET_STALL_MS / 1000) + 's 未完成）—— 下面这批票是按已到数据给的，稍后可能变化，可点刷新重试。';
  });
  /**
   * ★★ [DIVERGE-GATE-2 2026-10-24 用户口径] 占位里那行「20日涨幅精算 X/Y」小字。
   *
   * 用户原话：「计算判断有那么久吗？要再优化下」—— 长的不是判定（1 只票 K 线），
   * 而是它必须先知道【今天的总龙一是谁】，那要 20 日涨幅前五的精算（≤25 只票 K 线）。
   * 把分母摆出来，「为什么在等」就不再是黑箱（§10 失败/等待可见）。
   * ⚠️ 只读 `range20Progress`，⛔ 不让它进 data computed 依赖（否则每算完一只票就重算整张计划，§36）。
   * @returns {string} '' = 不显示（没进度 / 已算完 / 不是本日）
   */
  const divergeWaitText = computed(function() {
    const pr = range20Progress.value;
    if (!pr || pr.date !== currentDate.value) return '';
    if (!pr.total || pr.done >= pr.total) return '';
    return '20日涨幅精算中：' + pr.done + '/' + pr.total + ' 只（判定要先知道市场总龙一是谁）';
  });
  /** 卖点股票数（头部摘要用） */
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + ((g.items || []).length); }, 0);
  });
  /** 读库 / 抓取的失败原文（§10 失败必须可见；与计算错误分开，含义不同） */
  const fetchError = computed(() => tickMinuteError.value);
  const loading = computed(() => tickMinuteLoading.value);

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    // ★ [BUY-SETTLE 2026-10-31] 口径确认中 ⇒ 头部不能写「选股 2 只」（列表已经收起来了，
    //   写数字会让人以为那两只就是要买的票）。⛔ 也不写「0 只」——那是空仓结论（§10）。
    //   把「还差哪几项」摆出来，用户才知道为什么还没有结果（他自己要的那句提示语）。
    if (buyPending.value) {
      let s = '⏳ 结果确认中…' + (buyPendingText.value ? '（' + buyPendingText.value + '）' : '');
      if (sellCount.value > 0) s += ' · 卖点 ' + sellCount.value + ' 只（不受影响）';
      if (loading.value) s += ' · 分笔抓取中…';
      return s;
    }
    let s = '选股 ' + pickCount.value + ' 只';
    if (sellCount.value > 0) s += ' · 卖点 ' + sellCount.value + ' 只';
    if (loading.value) s += ' · 分笔抓取中…';
    return s;
  });

  /**
   * 点看板条（三角）展开 / 收起时，顺手把规则说明板收起（与决策看板同一口径）——
   * 说明文字要跟着一起消失，否则收起后还悬一块面板很难看。§34：只动展示态。
   */
  function toggleExpand() {
    expanded.value = !expanded.value;
    rulesOpen.value = false;
  }
  function toggleCompact() { compactOpen.value = !compactOpen.value; }
  /** 规则面板自己上报开合（子组件无内部状态，开合真相在本文件，§6） */
  function setRulesOpen(v) { rulesOpen.value = !!v; }

  /**
   * 点【序号 / 股票名】展开或收起该股的【分笔明细】面板。
   * §34：只动纯展示态，不碰业务数据、不发请求。
   * @param {string} name 股票名
   */
  function togglePens(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const next = new Set(penOpenSet.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    penOpenSet.value = next;   // 换引用 → 驱动重渲染
  }

  /** 只重算（供事件总线的高频刷新用；不碰任何展示态） */
  function bumpVersion() {
    version.value++;
    errorText.value = '';
  }

  // ── 分笔取数时机（只决定「什么时候」，取数本身在 store）────────────────────
  /** 本看板要抓的票 = 买点 + 卖点里出现过、且拿得到代码的股票（与分笔看板同一口径，§6） */
  const tickTargets = computed(function() {
    const seen = new Map();
    // ★ [EBB-R8] 退潮首日那只唯一买点也要抓分笔（它不在 blocks 里，见上面的 ebbBuy）
    // ★★ [WEAK-HUDDLE 2026-10-27] 「弱势切抱团」同理（第三十条，同样不在 blocks 里）
    [blocks.value,
      ebbBuy.value ? [ebbBuy.value] : [],
      weakHuddle.value ? [weakHuddle.value] : [],
      // ★★ [CATCH-UP 2026-10-27] 补涨题材同理（第三十一条，同样不在 blocks 里）
      catchUp.value ? [catchUp.value] : []].forEach(function(arr) {
      arr.forEach(function(b) {
        (b.picks || []).forEach(function(p) {
          if (p && p.name && !seen.has(p.name)) seen.set(p.name, String(p.code || ''));
        });
      });
    });
    sellGroups.value.forEach(function(g) {
      (g.items || []).forEach(function(it) {
        if (it && it.name && !seen.has(it.name)) seen.set(it.name, String(it.code || ''));
      });
    });
    return Array.from(seen.entries()).map(function(e) { return { name: e[0], code: e[1] }; });
  });

  let _tickRetryTimer = null;
  let _tickRetryCount = 0;

  function _clearTickRetry() {
    if (_tickRetryTimer) {
      clearTimeout(_tickRetryTimer);
      _tickRetryTimer = null;
    }
    _tickRetryCount = 0;
  }

  /**
   * 需要就去抓一只不落。
   * ⚠️ 必须先 `isTickMinuteReadable(date)`：读库失败（典型现场 = 表还没建）时
   *    store 的 tickMinuteDate 也已经等于该日，若不拦，就会去打一次必然失败的上游。
   */
  function _tryFetch() {
    const d = currentDate.value;
    if (!d) return;
    const targets = tickTargets.value;
    if (targets.length === 0) return;
    if (!isTickMinuteReadable(d)) return;
    // 还有「库里没有 + 本次会话没抓过」的票 ⇒ 过一会儿再试一次（见 TVRB_TICK_RETRY_MS 注释）
    ensureTickMinute(d, targets).then(function() {
      if (!tickTargets.value.some(function(t) { return _stillMissing(d, t.name); })) return;
      if (_tickRetryTimer || _tickRetryCount >= TVRB_TICK_RETRY_MAX) return;
      _tickRetryCount++;
      _tickRetryTimer = setTimeout(function() {
        _tickRetryTimer = null;
        loadTickMinute(d).then(function() { _tryFetch(); });
      }, TVRB_TICK_RETRY_MS);
    });
  }

  /** 这一只还没拿到（库里没有、也没标过「已抓过」）——只读判断，无副作用 */
  function _stillMissing(date, name) {
    const have = (tickMinuteDate.value === date) ? tickMinuteMap.value : EMPTY_MAP;
    if (have.has(name)) return false;
    const att = tickMinuteAttempted.value.get(date) || EMPTY_SET;
    return !att.has(name);
  }

  /** 读一次库 →（读成功的话）再考虑要不要抓 */
  function _loadThenMaybeFetch(date) {
    return loadTickMinute(date).then(function() { _tryFetch(); });
  }

  /** 供父级在「刷新」时调用（与其它看板同款契约：defineExpose({ refresh })） */
  function refresh() {
    bumpVersion();
    const d = currentDate.value;
    if (!d) return Promise.resolve();
    _clearTickRetry();
    return refreshTickMinute(d, tickTargets.value);
  }

  // 目标名单变化（首次算出发现在选谁、或结论变了）→ 补一次抓取。
  // ⛔ 用「名字串」而不是数组引用：数组每次 computed 都是新的，会导致无限循环。
  const targetSig = computed(function() {
    return tickTargets.value.map(function(t) { return t.name; }).join('|');
  });
  watch(targetSig, function() { _clearTickRetry(); _tryFetch(); });

  onMounted(function() {
    // §33 首次加载：读一次该日的分笔（读成功后才可能触发抓取）
    _loadThenMaybeFetch(currentDate.value);
  });

  // §26 日期切换 → 规则面板 / 分笔面板收起（新的一天是全新的结论，旧展开态会误导）+ 重新读分笔
  watch(currentDate, function(d) {
    rulesOpen.value = false;
    errorText.value = '';
    penOpenSet.value = new Set();
    _clearTickRetry();
    resetTickMinuteTransient();
    _loadThenMaybeFetch(d);
  });

  // ── [BOARD-SUSPEND 2026-10-13 用户口径] 本看板入选的票「今天是否停牌」────────────────────
  //   用户原话：「选股那里也要添加停牌标签，题材量比看板……都需要标记哪一个股票停牌，打上标签」。
  //   本看板自己建计划（不走 collectDecisionData）⇒ 在【上面 decorateDecisionRows 那一步】就已收口挂好
  //   suspendTag；这里只负责触发判定加载。名单口径与决策看板一致（买卖两侧全收）。
  //   ⚠️ 键 = 日期 + version + 名单：version 入键是为了在数据刷新后补一次（TTL 内仍是 no-op）；
  //      ⛔ 别用对象身份当键（plan 每次重算都换引用）。
  const suspendKey = computed(function() {
    const plan = data.value && data.value.plan;
    const ents = suspendEntriesOf(plan && plan.buy, plan && plan.sell);
    return currentDate.value + '|v' + version.value + '|' + ents.map(function(e) { return e.stock; }).join(',');
  });
  watch(suspendKey, function() {
    const d = currentDate.value;
    if (!d) return;
    const plan = data.value && data.value.plan;
    const ents = suspendEntriesOf(plan && plan.buy, plan && plan.sell);
    if (ents.length === 0) return;
    ensureSuspendSet(d, ents).catch(function(e) {
      console.warn('[SUSPEND] 题材量比看板停牌判定加载失败:', e && e.message);
    });
  }, { immediate: true });

  // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条的【在列次数】按展示日补齐（切日期就补一次）。
  //   幂等 + 会话缓存 + 单飞都在 Data 层（auction-presence.js）⇒ 这里重复触发也只是命中缓存（§32）。
  //   ⚠️ 用 immediate：首屏那一次也要读（否则第一帧永远判不出「首次在列」）。
  watch(currentDate, function(d) { ensureRange10Presence(d); }, { immediate: true });

  // §17 数据刷新（早盘竞价抓取 / 导入 / 收盘覆盖）→ 重算 + 补一次分笔读取。
  const _onRefresh = function() {
    bumpVersion();
    const d = currentDate.value;
    if (!d) return;
    _clearTickRetry();
    loadTickMinute(d).then(function() { _tryFetch(); });
  };
  _on('auction-refresh', _onRefresh);
  // §31 成对清理：本看板订阅的事件 / 自己的定时器由本看板清理
  onUnmounted(function() {
    _off('auction-refresh', _onRefresh);
    _clearTickRetry();
    // ⚠️ 这里【不】调 stopTickMinuteRetry()：「分笔买卖」看板也持有同一份 store 的定时重试，
    //    本看板卸载时把它掐掉会误伤那个看板（两个看板同页共存）。它自己的 onUnmounted 会收。
  });

  return {
    expanded,
    rulesOpen,
    compactOpen,
    rulesLines,
    penOpenSet,
    errorText,
    fetchError,
    loading,
    ready,
    reasonText,
    blocks,
    sellGroups,
    notes,
    excludedTopics,
    pickCount,
    sellCount,
    cashAlert,
    ebb,
    ebbBuy,
    ebbNodeNote,
    divergeBuy,
    // ★★ [WEAK-HUDDLE 2026-10-27 用户口径] 第三十条「弱势切抱团」买点块（渲染在灰化容器之外、最前面）
    weakHuddle,
    // ★★ [CATCH-UP 2026-10-27] 第三十一条「补涨题材」买点块
    catchUp,
    divergePending,
    divergeWaitText,
    // ★★ [BUY-SETTLE 2026-10-31] 买点侧 7 项异步输入未全部落地 ⇒ 视图收起选票、只挂占位
    buyPending,
    // 占位小字：把「还差哪几项」点名出来（空 ⇒ 不渲染，§21 模板零计算，文案在组合式）
    buyPendingText,
    // ★★ [NET-QUIET 2026-10-31] 上游读取超时警示（§10：不确定必须可见）
    buyDataWarning,
    // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条「新龙 / 新题材切换日」
    switchDay,
    newDragon,
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条「十日涨幅 · 在列次数候补」
    range10Backup,
    summaryText,
    toggleExpand,
    toggleCompact,
    setRulesOpen,
    togglePens,
    refresh
  };
}
