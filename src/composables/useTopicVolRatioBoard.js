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

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import {
  collectDecisionTopics,
  decorateDecisionRows,
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
// ★ 买点侧专用龙位（= 同一把尺子 computeDragonRankMap，只把十日涨幅换成 9:26 口径那份）
import { rankDragonsWithPctMap } from '../logic/decision/decision-rules.js';
// ★★ [EBB-R8 2026-10-14 用户口径] 退潮判定【落库表】的读写入口（§5 唯一出处）。
//   用户原话：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断
//     没有竞价量等判断出来的，是缓存吧？你要完善这点」
//   ⇒ 读 = 拿【上一交易日那一行】判「今天是不是首日」；写 = 把今天的判定存下来（只存今天，见下）。
import { readEbbDays, upsertEbbDay } from '../data/ebb-days.js';
// §6：「今天」的唯一口径（与 suspend.js 的 ensureSuspendSet 同一个函数，⛔ 别自己 new Date 拼一遍）。
//   停牌判定只对今天可信 ⇒ 落库也只对今天做（历史日的 suspend verdict 恒 false，写进去会污染次日判定）。
import { _getLocalTodayStr } from '../logic/tagTitles/rules.js';
// §6：题材组序口径的常量只有一处定义（decision-mode.js），⛔ 别在本文件写字面量 'volRatio'。
import { MODE_VOL_RATIO } from '../logic/decision/decision-mode.js';
import {
  buildTopicVolRatioPlan,
  buildTvrbRulesLines,
  TVRB_CASH_ALERT_NONE
} from '../logic/topicvolratio/topic-vol-ratio-rules.js';
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
      ebbDayRow: null
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
   * ★ [EBB-R8 2026-10-14] 上一交易日在 tvrb_ebb_days 里【落库的退潮判定】那一行。
   *
   * 作用：detectEbbDay 的【首日】闸门读它 —— 昨天同一只总龙已经退潮 ⇒ 今天不算首日、规则不生效。
   * 缺省（表不存在 / 那天没打开过看板）⇒ 规则层自动退化为「用昨日行情行推断」，再取不到按首日处理。
   * ⚠️ 读失败也保持 null（走退路），但必须留痕（§10 失败可见）；⛔ 绝不因此把 ebb 关掉。
   */
  const prevEbbDay = ref(null);
  const prevEbbDayDate = ref('');

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
    if (!pd) {
      prevRangeMap.value = null; prevRangeDate.value = '';
      prevEbbDay.value = null; prevEbbDayDate.value = '';
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
      }).catch(function(e) {
        console.warn('[TVRB] 上一交易日十日涨幅读取失败，退潮首日规则本次不生效:', e && e.message);
      });
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
  }, { immediate: true });

  const data = computed(function() {
    void version.value;                 // 显式声明对刷新信号的依赖
    // ★ [EBB] 昨日十日涨幅（异步读回）⇒ 读到之后重算一次，退潮首日规则才生效
    void prevRangeMap.value;
    // ★ [EBB-R8] 上一交易日落库的退潮判定（异步读回）⇒ 读到之后重算一次，首日闸门才生效
    void prevEbbDay.value;
    // ★★ [EBB-R8] 展示日当天的十日涨幅（异步读回）⇒ 读到之后重算一次：
    //   ① 买点侧那只【市场龙二】才算得出；② 更重要的是【消除切日期后的空白期】
    //      （dragonState 还没跟上新日期时，先用这份渲染，见 curRangeMap 的注释）
    void curRangeMap.value;
    // ★★ [TVRB-926] 展示日【9:26 口径】的区间涨幅（异步读回）⇒ 买点侧选股与行上数值的输入：
    //   读到之后重算一次 —— 选股从「当前口径」切到「早上 9:26 那一刻选中的那批」。
    void buyRangeMap.value;
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
        rangeMap: (curRangeMap.value && curRangeDate.value === d) ? curRangeMap.value : null
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
        //   —— 首日闸门的输入；缺省 ⇒ 规则层退化为「用昨日行情行推断」，再取不到按首日处理。
        prevEbbDay: prevEbbDay.value,
        // ★★ [TVRB-926] 买点侧专用的 9:26 口径（缺 ⇒ 规则层退回原口径 = 旧行为，§11）
        buyDragonMap: buyMap ? rankDragonsWithPctMap(rec.topics, buyMap) : null,
        pctMap: buyMap
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
      const buyBlockLists = [plan.blocks, plan.ebbBuy ? [plan.ebbBuy] : []];
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

      return { ready: true, reason: '', plan: plan };
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有入选股票」
      errorText.value = '题材量比计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[TVRB] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
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
  /** 卖点股票数（头部摘要用） */
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + ((g.items || []).length); }, 0);
  });
  /** 读库 / 抓取的失败原文（§10 失败必须可见；与计算错误分开，含义不同） */
  const fetchError = computed(() => tickMinuteError.value);
  const loading = computed(() => tickMinuteLoading.value);

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
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
    [blocks.value, ebbBuy.value ? [ebbBuy.value] : []].forEach(function(arr) {
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
    summaryText,
    toggleExpand,
    toggleCompact,
    setRulesOpen,
    togglePens,
    refresh
  };
}
