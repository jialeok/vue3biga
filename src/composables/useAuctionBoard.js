// §P1-7 组合式逻辑抽取（源自 src/views/AuctionBoard.vue 的 <script setup>）。
// 纯物理重组：状态/计算属性/方法/生命周期原样搬移，行为完全等价。
// 组件模板通过 useAuctionBoard() 取得同一实例，并 provide/inject 给子组件共享。
// 受保护契约 refresh / toggleSort / expandAll / collapseAll 由根组件 defineExpose 透传。
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { saveData, getTodayGroupList, getGroupData, patchAuctionField, patchAuctionFieldBatch, getAuctionData, saveModule,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs,
  fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat,
  fetchThreeDaysAuctionFromNumcat,
  fillTopicsFromNumcat, getStockHistoryTopics,
  importAuctionFromPaste, importAuctionHistoryFill, replaceConceptFromPaste
} from '../logic/app-core.js';
import { getAuctionStockHistory, deriveAuctionTagState } from '../logic/tagTitles/rules.js';
import { hydrateStockHistoryRow } from '../data/watchlist-and-metrics.js';
import { getStockHistoryValue } from '../data/watchlist-and-metrics.js';
import { getTopicGroups, getTopicRankCountThisWeek, isPseudoTopic } from '../logic/topic/rules.js';
import { getDisplayNote, parseNoteToFields, extractTopics } from '../logic/note/helpers.js';
import { getPreviousTradingDay, isTradingDay } from '../logic/date/trading-day-helpers.js';
import { getHighRatioStocksForDate, getJingYestHighlightSetForDate, getParallelStocksForDate } from '../logic/auction/sort-rules.js';
// ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」toggle 的取数入口。
//   打开且叠加了十日 / 20日涨幅时才取；两张 Map 都由 Data 层按日期缓存 + 单飞 ⇒ 0 新增额度。
//   ⛔ 原「弱转强」toggle（loadWeakStrongSet / weakStrongSetRef）已随该功能整体删除。
import { ensureAuctionLegRanges } from '../logic/auction/auction-leg-ranges.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../logic/auction/stock-sync.js';
import { getStockCode } from '../data/stock-code-map.js';
// [HIGH-LIMIT-BOARD 2026-09-21] 第二页题材列表的浅灰删除线：板块判定只用 Logic 层这一份（§6）
import { isHighLimitBoard } from '../logic/auction/limit-up.js';
import { pushStockTopicsToCloud } from '../data/stock-topics.js';
import { prepareAuctionData } from '../logic/auction/view-helpers.js';
// [TWO-MODES 2026-10-02 用户口径] 题材 / 一字两个 toggle 的排序口径词表（§6 唯一真相）
import { TOPIC_ORDER_VOL_RATIO, TOPIC_ORDER_YIZI } from '../logic/auction/topic-sort.js';
import { computeAuctionViewDataIncremental } from '../logic/auction/incremental-view.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { apiStatusMap, setApiStatus } from '../logic/ui-bridge.js';
import { setBtnLoading } from '../logic/shared/core-shared.js';
// [DRAGON 2026-09-09] 题材龙头：10 日区间涨幅异步加载 + 龙头排名（Logic 层模块）
import { ensureDragonRangePct, getDragonRangePct, getStockRangePct, DRAGON_RANGE_DAYS, invalidateDragonRange } from '../logic/auction/dragon-rank.js';
// [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle 的取数入口（开关位由原「量比抢筹」改造）。
//   与十日涨幅不同：云端没有 20 日行 ⇒ 由 range20.js 按 20 个交易日复利现算（库内腿 + 同花顺补缺），
//   只放会话内存。⚠️ 只在 toggle 打开时触发，⛔ 不消耗猫抓额度（同花顺 K 线免费额度）。
import { ensureRange20, getRange20FingerprintToken, getRange20BatchStat, getRange20DailyStat } from '../logic/auction/range20.js';
// [RANGE20-TOP5 2026-10-19 用户口径] 「20日涨幅前五 · 龙头补位」的取数入口。
//   ★ 与上面的 20日涨幅 toggle 【完全独立】：那个是「打开开关才排一次序」的排序功能；
//     这个是把「近 20 个交易日每天正式列表」并起来、取 20 日涨幅前五、把今天看不见的补进看板
//     —— 用户要求「每天都要检索」，所以与开关状态无关，进看板/切日期就跑一次（幂等 + 会话缓存）。
//   ⛔ 零猫抓额度（用户特别强调）：只用库内正式列表 + 同花顺 K 线（免费），见 range20-leaders.js。
import { ensureRange20Leaders } from '../logic/auction/range20-leaders.js';
// [PRESENCE 2026-10-23 用户口径] 「涨幅前十 · 在列次数」预计算表的取数入口（Data 层）。
//   ⛔ 零上游请求：只读 Supabase 表 auction_presence（由 pg_cron 在 09:30 / 15:05 算好）。
//   为什么走表而不是现场算：现场算要回读 10~20 天的历史名单；落表后前端只读 ≤400 行结论，
//   而且这张表本身还能被用户直接拿去做分析（用户原话「我会用这个出现次数做分析」）。
import { ensurePresence } from '../data/auction-presence.js';
// [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」toggle 的占比列改成【名次变化】：
//   需要【上一交易日】那一份名次表；基准腿【恒为昨日收盘口径】（收盘=昨天定稿的强度），
//   ⛔ 不随「竞价口径」toggle 变 —— 今天竞价也比昨收，今天收盘也比昨收（见 prev-rank-table.js 头注释）。
//   装配在 Logic 层 prev-rank-table.js（读 stock_range20_pct 的 close 腿 → buildRankTable）。
//   ⛔ 只在 20日涨幅开关打开时才读（关着时一条请求都不发，§11 默认零行为）。
import { ensurePrevRankTable, getPrevRankTable, resolvePrevRankLeg } from '../logic/auction/prev-rank-table.js';
// [TREND-PATCH-STORE 2026-10-23] 趋势「同花顺补缺值」的合并语义（纯函数，Logic 层，§3/§4）。
//   抽到 Logic 层是为了用测试锁死三条语义：只填 null 位 / 今天整天替换 / 四腿任一缺即补。
//   背景见 trend-patch-merge.js 头注释（新华传媒 600825 当天五条线全空 = paint 互相覆盖）。
import { mergeTrendPatch, putTrendPatch, trendNeedsPatch, beijingTodayYmd } from '../logic/auction/trend-patch-merge.js';
// [DRAGON-GROUP 2026-09-14] 龙头组：名册异步加载（展示日读 D-1 名册；条件满足时评选并落库当日名册）。
// 唯一入口 ensureDragonGroup 内含单飞 + 会话幂等 + 收盘口径闸门，重复调用零副作用。
import { ensureDragonGroup } from '../logic/auction/dragon-group.js';
// [SUSPEND 2026-10-13] 当日停牌判定（同花顺 fuyao，免费/不限量，0 猫抓额度）。
// 目的：让看板明确显示「停牌」，而不是把上游缺席留成空白被人当成「没抓到数据」。
// ⛔ 只读上游 + 只写该模块内存 ref：不写 Supabase、不碰 numcat/worker。
import { ensureSuspendSet } from '../logic/auction/suspend.js';
// [TREND-PATCH 2026-10-21] 趋势图「缺数据日」的同花顺兜底补缺（0 猫抓额度）。
//   补位票（range20 前五注入行）不在当日 worker 抓取名单 ⇒ market_metrics 没有那一天的行
//   ⇒ 既有水合（hydrateStockHistoryRow 只认云端表）永远补不到 ⇒ 趋势该日空白（时代万恒 10-20 实证）。
//   K 线补 竞价涨幅/涨幅/昨日成交量 + 当日快照补竞价量；⛔ 只改趋势面板展示数据，不写任何表。
import { ensureTrendPatch } from '../logic/auction/trend-patch.js';
// [CLOSE-COVER 2026-09-10] 收盘后自动用【收盘涨幅】覆盖 9:25 竞价涨幅（此前该闭环只存在于
// 从未执行过的 pg_cron，导致当天 change_pct 全天停留在竞价值）。
import { ensureClosePctCovered, isCloseCoverWindow } from '../logic/auction/close-pct-cover.js';
// [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）的 5 日趋势腿 + limit_pool 只读窗口。
//   ⛔ 不消费任何猫抓额度：limit_pool 由 Edge Function 15:40 用同花顺 fuyao 免费抓取落库，本端只读库。
import { sealLotsPointsOfHistory, sealWindowPending, ensureSealWindow } from '../logic/auction/seal-volume.js';
import { hasLimitPoolDay, ensureLimitPoolDays } from '../data/limit-pool.js';
import { _dbgLog } from '../data/debug-log.js';
// §P1-6：展示层纯函数已抽取到 ../composables/auction-board-helpers.js（行为等价）。
import {
    getStarSymbols,
    extractChangeFromNote,
    getChangePctDisplay,
    canGroupExpand,
    getTopicNameStyle,
    getChangeClass,
    getTopicsDisplay,
    formatDateShort,
    getHistoryArrow,
    getRankAppearText,
    _normalizeNotePunct,
    _buildFullNoteWithTopics
} from '../composables/auction-board-helpers.js';

// ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」取数 watch 仅挂载一次
//   （useAuctionBoard 可能被多组件调用）。⛔ 原 `_wsWatchBound`（弱转强）已随该功能删除。
let _alegWatchBound = false;
// [DRAGON 2026-09-09] 龙头区间涨幅 watch 同理只挂载一次。
let _dragonWatchBound = false;
// [CLOSE-COVER 2026-09-10] 收盘覆盖 watch 与跨门槛轮询同样只挂载一次。
let _closeCoverBound = false;
let _closeCoverTimer = null;
// [SUSPEND 2026-10-13] 停牌判定 watch 同样只挂载一次（useAuctionBoard 可能被多组件调用）。
let _suspendWatchBound = false;
// [RANGE20 2026-10-19] 「20日涨幅」取数 watch 同样只挂载一次。
let _r20WatchBound = false;
// [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」取数 watch 同样只挂载一次。
let _r20Top5WatchBound = false;
// [PRESENCE 2026-10-23] 「涨幅前十 · 在列次数」预计算表取数 watch 同样只挂载一次。
let _presenceWatchBound = false;
// [R20-DELTA 2026-10-28] 「昨日 20日涨幅名次」取数 watch 同样只挂载一次。
let _r20DeltaWatchBound = false;
/** 收盘覆盖轮询间隔：5 分钟（页面长时间开着时，跨过 15:00 能自动触发一次，无需手动刷新） */
const CLOSE_COVER_POLL_MS = 5 * 60 * 1000;

export function useAuctionBoard() {
  const uiStore = useUiStore();
  const auctionStore = useAuctionStore();


  // [TWO-MODES 2026-10-02 用户口径] 第一页排序状态：`byParallel` 已删除（「平行」toggle 的开关位
  //   被新的「一字」toggle 占用，平行并入「竞/昨」）；新增 `topicOrderBy` = 题材 / 一字两个 toggle
  //   的排序口径（二者共用 byTopic，互斥是结构性的）。取值词表见 logic/auction/topic-sort.js。
  //   [SWITCH-PICK 2026-10-02] 默认口径 = 一字；初值必须与 auctionStore#createSortState 一致
  //     （下面的 watch 会让它始终跟随 store，这里只是首帧对齐，免得首帧口径与 store 相反）。
  const sortState = reactive({
    // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 原 `byWeakStrong`（弱转强）→ 改为 `byAuctionLeg`（竞价口径）。
    //   ⛔ 不是改名游戏：「弱转强」是主排序（三档：连跌+转向 / 仅转向 / 其余），
    //      「竞价口径」是【口径修饰开关】（只换十日 / 20日涨幅两列的数值来源，不产生任何档位与高光）。
    //   ★ 结构上最重要的差别：它【不进】主排序的互斥组 —— 用户明确要求
    //      「10日涨幅和竞价口径toggle可以同时打开」，参与互斥就变成二选一了。
    //   ⚠️ 键名与初值必须与 auctionStore#createSortState 逐字一致（§6）。
    byAuctionLeg: false,
    // [RANGE20 2026-10-19 用户口径] 原 `byRatio`（量比抢筹）→ 改为 `byRangePct20`（20日涨幅）。
    //   ⛔ 不是改名游戏：「量比抢筹」是行级达标高光（竞价量比≥10 且 抢筹幅度>1），
    //      「20日涨幅」是【全列表按 20 个交易日区间涨幅降序 + 逐行标数值】，两者数据源与口径完全不同。
    //   ⚠️ 键名与初值必须与 auctionStore#createSortState 逐字一致（§6）。
    byRangePct20: false,
    byJingYest: false,
    byJingYestRatio: false,
    // [RANGE-PCT 2026-10-14 用户口径] 原 `byThreeDayJingDie`（三天竞跌）→ 改为 `byRangePct`（十日涨幅）。
    //   ⚠️ 键名与初值必须与 auctionStore#createSortState 逐字一致（§6：两处默认值不同会让
    //      「store 读不到」那一瞬间的口径跳变）。
    byRangePct: false,
    byTopic: false,
    topicOrderBy: TOPIC_ORDER_YIZI
  });
  // [TWO-MODES 2026-10-02 用户口径] 两个题材 toggle 的勾选态。
  //   两个 toggle 共用 byTopic，靠 topicOrderBy 区分 ⇒ 勾选态必须在这里算好，
  //   ⛔ 模板里不许出现 `sortState.byTopic && sortState.topicOrderBy === 'yizi'` 这类比较（§21 模板零计算）。
  const yiziToggleOn = computed(() => !!sortState.byTopic && sortState.topicOrderBy === TOPIC_ORDER_YIZI);
  const topicToggleOn = computed(() => !!sortState.byTopic && sortState.topicOrderBy !== TOPIC_ORDER_YIZI);
  const expandedSet = ref(new Set());
  const trendHistory = ref({});
  /**
   * [TREND-PATCH-STORE 2026-10-23 用户报障] 趋势补缺值的【持久层】：股票名 -> { 'YYYY-MM-DD' -> 补缺值 }。
   *
   * 🔴 为什么必须单独存一层（而不能再「就地 merge 进 trendHistory 就完事」）：
   *   展开一只票时，面板会被【多腿异步】重画，最后的 paint 谁后到谁生效：
   *     ① 主腿（hydrate stock_history）              → paint(原始 history)
   *     ② 补缺腿（ensureTrendPatch，同花顺 K 线+快照）→ paint(merged)
   *     ③ 封单量腿（ensureLimitPoolDays）             → paint(原始 history)  ← ⛔ 会把 ② 的结果整片擦掉
   *   ③ 与 ② 谁先谁后纯看网络，于是出现「有时当天有数、有时又没了」，
   *   用户 10-23 报障：「新华传媒…当天还是没有数据…昨天都说过了」测的就是这个。
   *   ⇒ 补缺结果落进本 store 后，任何一次 paint 都会自动带上它（见 _mergeTrendPatch），
   *     腿的先后顺序不再影响结果。⛔ 仍然只影响展示，不写库（§6 不产生影子真相）。
   */
  const trendPatchStore = ref({});
  // [FIX 2026-08-17] 展开状态 key 用股票名而非位置 index：翻页/刷新后 viewData 重算会导致
  // index 漂移，v-memo 复用的旧闭包携带旧 index 会 find 落空 → 序号点击"展不开"。
  // 股票名是稳定标识，永不漂移。expandedSet = Set<股票名>，trendHistory = { 股票名: {...} }
  const longPressMenuRef = ref(null);
  const coreTopicModalRef = ref(null);
  const editModalRef = ref(null);
  let longPressTimer = null;
  const viewData = computed(() => {
    void auctionStore.dataVersions['auction'];
    void uiStore.currentDate;
    void sortState.byAuctionLeg; void sortState.byRangePct20;
    void sortState.byJingYest; void sortState.byJingYestRatio; void sortState.byRangePct; void sortState.byTopic;
    // [TWO-MODES 2026-10-02] 题材排序口径也进依赖：切「题材 / 一字」必须重算视图（顺序不同）
    void sortState.topicOrderBy;
    // A3-01：经增量行缓存层，单格编辑只重新派生变化的行（logic/auction/incremental-view.js）
    return computeAuctionViewDataIncremental('auction', sortState);
  });

  // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」取数：开关打开 + 叠加了十日/20日涨幅 才发请求。
  //   ⛔ 原 [WEAK-STRONG] 那段（拉前 4 个交易日 change_pct 算弱转强）已整段删除。
  //   依赖里带上两个涨幅主排序与日期：点开「十日涨幅 / 20日涨幅」时若口径开关已经开着，
  //   必须立刻补一次取数（否则用户会看到「打开了却没有任何数值」的空窗）。
  //   ⚠️ §11：口径开关关着 ⇒ 一个请求都不发（本 watch 直接 return）。
  if (!_alegWatchBound) {
    _alegWatchBound = true;
    watch(
      () => [sortState.byAuctionLeg, sortState.byRangePct, sortState.byRangePct20, uiStore.currentDate],
      () => {
        if (!sortState.byAuctionLeg) return;
        if (!sortState.byRangePct && !sortState.byRangePct20) return;
        ensureAuctionLegRanges(uiStore.currentDate).catch(function(e) {
          // §10：读失败必须留痕（视图层表现为「这两列暂时没有数值」，绝不拿收盘口径顶替）
          console.warn('[AUCTION-LEG] 竞价口径区间涨幅读取失败:', (e && e.message) || e);
        });
      },
      { immediate: true }
    );
  }

  // [DRAGON 2026-09-09] 龙头（龙一/龙二…）= 同题材组内按「近10个交易日区间涨幅」降序。
  // 只要题材 toggle 开着就加载（叠加其它 toggle 也一样，需求：标志常驻）；
  // 关闭题材时清空，避免陈旧数据留在内存。加载失败必须可见（§10 禁止静默失败）。
  if (!_dragonWatchBound) {
    _dragonWatchBound = true;
    watch(
      // [FIX 2026-09-10] 额外监听「当日渲染行数」：9:25 名单是逐步到达的，
      // 只在 toggle/日期变化时加载会让后到的股票永远缺 10 日涨幅（实测 9/10 60 行只有 11 行有数据）。
      // [RANGE-PCT 2026-10-14] 把「十日涨幅」toggle 也纳入依赖：它是该模式的【唯一数据源】
      //   （云端 stock_range_pct → getDragonRangePct）。不列进来的话，用户点开开关时若数据还没
      //   加载过，屏幕会停在一片「没有涨幅数值、顺序也没变」的状态等下一次触发 —— 那正是
      //   「打开 toggle 响应慢」的观感来源。列进来后：点开即 ensureDragonRangePct
      //   （已缓存 → 同步级返回；未缓存 → 一次云端读），数据一到 dragon= 指纹变化 → 自动重排。
      () => [sortState.byTopic, sortState.byRangePct, uiStore.currentDate, (viewData.value && viewData.value.items ? viewData.value.items.length : 0)],
      async () => {
        // ⚠️ 不再因「关闭题材」而跳过加载：展开面板的「10日涨幅」同样依赖这份数据
        // （与题材 toggle 是否开启无关）。数据按 date 键控，切日期时会被新日期覆盖。
        // [FIX 2026-09-10] 原先这里 `if (!sortState.byTopic) return;` 会让「关闭题材 + 15:00 前
        // 打开页面」的用户展开某只票看不到 10 日涨幅（要等 5 分钟轮询才补上），与下面的注释自相矛盾。
        try {
          // [CLOSE-COVER] 先确保收盘涨幅已覆盖，再算龙头：否则 T 腿会读回 9:25 竞价副本，
          // 龙头排位等于白算（仍是早上的顺序）。覆盖内部幂等，不会重复烧额度。
          await runCloseCover(uiStore.currentDate);
          await ensureDragonRangePct(uiStore.currentDate);
          // [DRAGON-GROUP 2026-09-14] 龙头组：读「展示日 D 的龙头名册」（= D-1 评选结果），
          // 并在收盘口径权威后【评选 + 落库 D 自己的名册】（供 D+1 展示）。
          // 必须排在 ensureDragonRangePct 之后：评选依赖「近10日区间涨幅」，否则池子为空不评选。
          ensureDragonGroupForDate(uiStore.currentDate);
        } catch (e) {
          console.warn('[DRAGON] 龙头区间涨幅加载失败:', e && e.message);
          setApiStatus('numcatApiStatus', '❌ 龙头涨幅加载失败：' + (e && e.message || e), false);
        }
      },
      { immediate: true }
    );
  }

  // [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle 的取数入口（只挂载一次，幂等/单飞在 range20.js 内）。
  //
  // 为什么用 watch 而不是点 toggle 时直接 await：
  //   ① 数据是【两阶段】到货的（库内逐日行 → 同花顺补缺），range20.js 每次发布都会 bump 版本 →
  //      incremental-view 的 `range20=` 指纹变化 → 本视图自动重排。watch 是这条链的触发器；
  //   ② 目标清单必须 = 【看板真正渲染的行】（含观察组/龙头继承壳），只有 viewData.items 是这份真相
  //      （§6：⛔ 别另取一份名单，否则会出现「有的行有 20 日涨幅、有的没有」）；
  //   ③ 9:25 名单是逐步到达的 ⇒ 把「渲染行数」纳入依赖，后到的票才会被补算（与十日涨幅同款教训）。
  //
  // ⚠️ 只在 toggle 打开时触发：关着时一行不动（§11 默认零行为变化）。
  // ⚠️ 失败必须可见（§10 禁止静默失败）：走 setApiStatus，不把「取不到」显示成「涨幅 0」。
  if (!_r20WatchBound) {
    _r20WatchBound = true;
    // 🔴 [PERF 2026-10-19 第十九轮] 依赖从 `items.length` 换成【名单签名】。
    //   原写法两个毛病：① 行数不变但换了一批票（如观察组换人、龙头组继承壳替换）⇒ 不触发 ⇒ 新票没有 20 日涨幅；
    //   ② 行数抖动（加载中 6 → 41 → 41）⇒ 反复触发同一个计算。
    //   签名 = 股票名升序拼接，和「谁在屏幕上」一一对应：名单没变就一次都不跑（§20 watch 必须有明确触发条件）。
    const _r20RowsSig = function(rows) {
      const names = [];
      for (let i = 0; i < rows.length; i++) {
        const n = rows[i] && rows[i].stock ? String(rows[i].stock).trim() : '';
        if (n) names.push(n);
      }
      names.sort();
      return names.join(',');
    };
    watch(
      () => [sortState.byRangePct20, uiStore.currentDate,
        _r20RowsSig((viewData.value && viewData.value.items) || [])],
      async () => {
        if (!sortState.byRangePct20) return;
        const _date = uiStore.currentDate;
        const _rows = (viewData.value && viewData.value.items) || [];
        if (!_date || _rows.length === 0) return;
        // 只有【真的报过进度】才在结束时清状态条，否则会把别的操作（龙头/停牌…）的状态文案误清掉
        let _progressed = false;
        // 🔴 [PERF 2026-10-19 第十九轮] 进度提示必须【节流】。
        //   实测：20 日补缺会算完 41 只（含重试最多 79 个请求），原先每完成一只就 setApiStatus 一次
        //   ⇒ 一两分钟内 41~79 次全局状态变更，每次都驱动状态条乃至看板重渲染 ——
        //   用户逛别的看板/切日期时会明显觉得「改完之后变卡了」。
        //   §22「短时间内变化很多 ⇒ 批量合并 ⇒ 一次 UI 更新」：改成最多每 600ms 刷一次，
        //   且强制在「首帧 / 每 10 只 / 收尾」刷新，保证既不卡又不丢反馈（⛔ 不是用延迟掩盖问题）。
        let _lastProgAt = 0;
        // ★★ [R20-FAILVIS 2026-10-30 用户报障「43 只里只有 23 只有涨幅，是没写入吗？还是没有抓取？」]
        //   旧写法：只要报过进度，结束时就把状态条清空 ⇒ **失败的票一声不响**，
        //   用户看到一列 `—` 却分不清「正在补 / 补失败了 / 压根没数据」（违反 §10）。
        //   现在：跑完读 `getRange20BatchStat()`，还差就明说「还差 N/M 只」，并给出下一步动作。
        const _afterRun = function(progressed) {
          const _bs = getRange20BatchStat();
          if (_bs && _bs.date === _date) {
            const _miss = Number(_bs.missing) || 0;
            if (_miss > 0) {
              const _ds = getRange20DailyStat();
              const _noLegs = (_ds && _ds.date === _date && !(_ds.hit > 0))
                ? '（逐日腿表里这批票一根腿都没有 ⇒ 回填脚本 db/scripts/backfill-daily-pct.mjs 未跑成功）'
                : '';
              setApiStatus('numcatApiStatus',
                '⚠️ 20日涨幅还差 ' + _miss + '/' + _bs.total + ' 只没取到' + _noLegs
                + '。重开 toggle 或切走再切回会自动重试', false);
              return;
            }
          }
          if (progressed) setApiStatus('numcatApiStatus', '', true);
        };
        try {
          await ensureRange20(_date, _rows, {
            onProgress: function(done, total) {
              // 同花顺补缺可能跑几十秒：必须有进度反馈，否则用户会以为看板卡死
              _progressed = true;
              const _now = Date.now();
              const _isFirst = (done <= 1);
              const _isStep = (done % 10 === 0);
              const _isLast = (done >= total);
              if (!_isFirst && !_isStep && !_isLast && (_now - _lastProgAt) < 600) return;
              _lastProgAt = _now;
              setApiStatus('numcatApiStatus', '⏳ 20日涨幅补算中 ' + done + '/' + total + '（同花顺K线）', false);
            }
          });
          _afterRun(_progressed);
        } catch (e) {
          console.warn('[RANGE20] 20日涨幅取数失败:', e && e.message);
          setApiStatus('numcatApiStatus', '❌ 20日涨幅取数失败：' + (e && e.message || e), false);
        }
      },
      { immediate: true }
    );
  }
  // [PRESENCE 2026-10-23 用户口径] 「涨幅前十 · 在列次数」标签的取数入口（只挂载一次，幂等/单飞在 Data 层）。
  //
  // 用户原话：「10日涨幅 toggle 单独打开后，把排名前十的股票，在这 10 个交易日中出现过几次标记起来……
  //   打上小标签比如"5次在列"，"首次在列"，单独打开 20 日涨幅 toggle 时也要。」
  //
  // 依赖 = 【两个涨幅 toggle + 当前日期】：
  //   · 只在 10日/20日涨幅开关打开时才去读表 —— 关着时一条标签都不显示，⛔ 不白打 REST（§11 默认零行为）；
  //   · 窗口由「哪个开关开着」决定（10 / 20），两者互斥（点开一个会自动关掉另一个）。
  //   · 数据到货 ⇒ Data 层 version + 1 ⇒ incremental-view 的 `presence=` 指纹变化 ⇒ 视图重算 ⇒ 标签出现。
  //
  // ⚠️ 失败必须可见（§10 禁止静默失败）。表还没建时（用户尚未执行 db/create_auction_presence.sql）
  //   给一句能指导下一步的提示，⛔ 不能把「没算出来」显示成「所有票都未在列」。
  if (!_presenceWatchBound) {
    _presenceWatchBound = true;
    watch(
      () => [sortState.byRangePct, sortState.byRangePct20, uiStore.currentDate],
      async () => {
        // 20 日优先（两个开关互斥；万一同时为真，按 20 日口径走，与 view-helpers 的取值顺序一致）
        const _pw = sortState.byRangePct20 ? 20 : (sortState.byRangePct ? 10 : 0);
        if (!_pw) return;
        const _date = uiStore.currentDate;
        if (!_date) return;
        try {
          await ensurePresence(_date, _pw);
        } catch (e) {
          const _code = (e && e.code) ? String(e.code) : '';
          const _missingTable = _code === '42P01' || /auction_presence/i.test(String(e && e.message || ''));
          const _msg = _missingTable
            ? '⚠️ 在列次数表未建（执行 db/create_auction_presence.sql 后自动生效）'
            : '❌ 在列次数加载失败：' + ((e && e.message) || e);
          console.warn('[PRESENCE] 在列次数加载失败:', (e && e.message) || e);
          setApiStatus('numcatApiStatus', _msg, false);
        }
      },
      { immediate: true }
    );
  }
  // [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」toggle 占比列 → 【名次变化（对比昨日）】的取数入口。
  //
  // 用户原话：「你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，比如+6，
  //   排名下降就用绿色，比如-7，也就是按照20日涨幅的排序，对比昨日排名情况进行标注，其它不变。
  //   这个数值变化，也很重要，可以看出个股突破。」
  //   「排名变化列那里，收盘是否重新算过一次，我希望重新算过一次，早上可以用竞价口径，收盘时，
  //     用收盘口径，因为竞价时和收盘时会不同，不要搞混了，这样才能分辨出来。」
  //
  // 依赖 = 【20日涨幅开关 + 当前日期 + range20 的换腿信号】：
  //   · 只在 20日涨幅开关打开时才读（关着时一条请求都不发，§11 默认零行为）；
  //   · 基准腿【恒为昨日收盘】⇒ 「竞价口径」toggle 不再影响这里要读哪张表，故不入依赖；
  //   · range20 指纹仍要进：15:00 后今天那列换腿 ⇒ 名次差要重算（本 watch 幂等短路，不会白打请求）。
  // 数据到货 ⇒ version + 1 ⇒ incremental-view 的 `r20delta=` 指纹变化 ⇒ 视图重算 ⇒ 数值出现。
  // ⚠️ 失败必须可见（§10 禁止静默失败）：⛔ 不能把「没读到」显示成「所有票都没变化」。
  if (!_r20DeltaWatchBound) {
    _r20DeltaWatchBound = true;
    watch(
      () => [sortState.byRangePct20, uiStore.currentDate, getRange20FingerprintToken()],
      async () => {
        if (!sortState.byRangePct20) return;
        const _date = uiStore.currentDate;
        if (!_date) return;
        const _prev = getPreviousTradingDay(_date);
        if (!_prev) return;
        const _leg = resolvePrevRankLeg();   // 恒 'close'（昨日收盘口径）
        // 幂等短路：同一口径已经装好了就不再发请求（令牌频繁变化时这条是必需的）
        if (getPrevRankTable(_prev, _leg)) return;
        try {
          await ensurePrevRankTable(_prev, _leg);
        } catch (e) {
          const _code = (e && e.code) ? String(e.code) : '';
          const _missingTable = _code === '42P01' || /stock_range20_pct/i.test(String((e && e.message) || ''));
          const _msg = _missingTable
            ? '⚠️ 名次变化：20日涨幅表不可用（stock_range20_pct 未建/无权限）'
            : '❌ 名次变化加载失败：' + ((e && e.message) || e);
          console.warn('[R20-DELTA] 昨日名次加载失败:', (e && e.message) || e);
          setApiStatus('numcatApiStatus', _msg, false);
        }
      },
      { immediate: true }
    );
  }
  //
  // 用户原话：「每天都要检索，用20天涨幅先找到前五的票，看列表有没有，如果没有就补，如果都有了，就不用补」
  //   「比如今天的九阳股份，如果它不是继承上交易的龙头组，就消失了，我就看不见了」
  // ⇒ 与 20日涨幅 toggle **无关**，进看板/切日期就跑（幂等、单飞、会话缓存都在 range20-leaders.js 内）。
  //
  // ⚠️ §10 禁止静默失败：取数失败走 setApiStatus 让用户看见，⛔ 不能把「没算出来」显示成「今天没有补位」。
  //
  // 🔴 依赖 = 【日期 + 当日渲染行数】，与上/下方的停牌 watch 完全同构（已是验证过的成熟写法，§11）。
  //   为什么必须带上行数（实测踩坑）：immediate 首跑发生在数据到达【之前】——那一刻正式列表索引还是空的
  //   ⇒ 候选池为空 ⇒ 本次不产出。若只依赖 currentDate，之后数据到了也不会再跑，区块永远不出现。
  //   ★ 重复触发完全安全：模块内有单飞（_inflight）+ 会话缓存（只缓存非空结果）；
  //     候选池来自历史列表、与屏幕上有哪些行无关 ⇒ 早跑晚跑结果一致，早跑那次只是没数据。
  function ensureRange20LeadersForCurrentBoard() {
    const date = uiStore.currentDate;
    if (!date) return;
    let _progressed = false;
    // 进度节流（<=25 只票，最多刷几次就够，⛔ 别每只都改一次全局状态，§22）
    let _lastAt = 0;
    ensureRange20Leaders(date, {
      onProgress: function(done, total) {
        _progressed = true;
        const _now = Date.now();
        if (done < total && (done % 5 !== 0) && (_now - _lastAt) < 600) return;
        _lastAt = _now;
        setApiStatus('numcatApiStatus', '⏳ 20日涨幅前五检索中 ' + done + '/' + total + '（同花顺K线）', false);
      }
    }).then(function() {
      if (_progressed) setApiStatus('numcatApiStatus', '', true);
    }).catch(function(e) {
      console.warn('[RANGE20-TOP5] 20日涨幅前五检索失败:', e && e.message);
      setApiStatus('numcatApiStatus', '❌ 20日涨幅前五检索失败：' + (e && e.message || e), false);
    });
  }
  if (!_r20Top5WatchBound) {
    _r20Top5WatchBound = true;
    watch(
      () => [uiStore.currentDate,
        (viewData.value && viewData.value.items ? viewData.value.items.length : 0)],
      () => { ensureRange20LeadersForCurrentBoard(); },
      { immediate: true }
    );
  }
  // [DRAGON-GROUP 2026-09-14] 龙头组加载/评选的唯一入口（幂等、单飞，见 logic/auction/dragon-group.js）。
  // 读名册失败必须让用户看见（§10 禁止静默失败：不能把「读失败」显示成「今天没有龙头」）。
  function ensureDragonGroupForDate(date) {
    if (!date) return;
    ensureDragonGroup(date).catch(function(e) {
      console.warn('[DRAGON-GROUP] 龙头组加载/评选失败:', e && e.message);
      setApiStatus('numcatApiStatus', '❌ 龙头组加载失败：' + (e && e.message || e), false);
    });
  }

  // [SUSPEND 2026-10-13] 当日停牌判定的统一入口（幂等、单飞、有界重试都在 suspend.js 内）。
  // 名单取自【已 enrich 的 items】：它包含观察组/龙头组注入的空壳行，最贴近「屏幕上真正出现的票」；
  // 每行已带 code（view-helpers 解析好），此处不重复查映射（§32）。
  // 触发点：① 进入看板 / 切日期 / 当日行数变化（下方 watch）；② auction-refresh 事件（onAuctionRefresh）。
  function ensureSuspendForCurrentBoard() {
    if (!uiStore.currentDate) return;
    const items = (viewData.value && viewData.value.items) || [];
    const entries = items.map(function(it) { return { stock: it.stock, code: it.code }; });
    ensureSuspendSet(uiStore.currentDate, entries).catch(function(e) {
      // 停牌标记是纯展示增益，失败不阻断看板；但必须留痕（§10 禁止静默失败）
      console.warn('[SUSPEND] 停牌判定加载失败:', e && e.message);
    });
  }

  // [SUSPEND 2026-10-13] 与龙头 watch 同款：多依赖并列触发，immediate 保证首屏也判一次。
  // ⚠️ 结果只改 suspend.js 的内存 ref（指纹不变时连版本都不升）→ 不会反向触发本 watch（无循环）。
  if (!_suspendWatchBound) {
    _suspendWatchBound = true;
    watch(
      // 额外监听「当日渲染行数」：9:25 名单是逐步到达的，只在日期变化时加载会让后到的票永远没有停牌标记。
      () => [uiStore.currentDate, (viewData.value && viewData.value.items ? viewData.value.items.length : 0)],
      () => { ensureSuspendForCurrentBoard(); },
      { immediate: true }
    );
  }

  // [CLOSE-COVER 2026-09-10] 收盘涨幅自动覆盖 + 龙头排位重算。
  // 触发时机：① 进入看板 / 切换日期 / 当日名单行数变化；② 每 5 分钟轮询一次，
  // 让「页面一直开着」的用户跨过 15:00 后也能自动拿到收盘涨幅（§17 禁止靠手动刷新碰巧生效）。
  async function runCloseCover(date) {
    if (!date || !isCloseCoverWindow(date)) return { ok: false, skipped: true };
    try {
      const res = await ensureClosePctCovered(date);
      if (res && res.ok && !res.skipped) {
        // 覆盖成功 → 强制重算一次 10 日涨幅/龙头排位（T 腿从竞价口径换成收盘口径）
        invalidateDragonRange(date);
        // 内存行的 changePct 已就地更新，bump 版本号让 viewData 重算（界面涨幅列/趋势图同步）
        refresh();
        const bits = [];
        if (res.updated) bits.push('收盘涨幅覆盖 ' + res.updated + ' 只（来源=' + (res.source || '-') + '）');
        if (res.rangeFixed) bits.push('区间涨幅 T 腿校正 ' + res.rangeFixed + ' 只');
        setApiStatus('numcatApiStatus', '✅ ' + bits.join('，') + '，龙头排位重算中…', true);
        // 无条件重算：展开面板的「10日涨幅」同样依赖这份数据（与题材 toggle 是否开启无关）
        await ensureDragonRangePct(date);
      }
      return res || { ok: false, skipped: true };
    } catch (e) {
      // §10 禁止静默失败：覆盖失败要让用户看见（数据仍是竞价涨幅，不能假装已更新）
      console.warn('[CLOSE-COVER] 收盘涨幅覆盖失败:', e && e.message);
      setApiStatus('numcatApiStatus', '❌ 收盘涨幅覆盖失败：' + (e && e.message || e), false);
      return { ok: false, skipped: false, reason: e && e.message };
    }
  }

  if (!_closeCoverBound) {
    _closeCoverBound = true;
    watch(
      () => [uiStore.currentDate, (viewData.value && viewData.value.items ? viewData.value.items.length : 0)],
      async () => { await runCloseCover(uiStore.currentDate); },
      { immediate: true }
    );
    if (_closeCoverTimer) clearInterval(_closeCoverTimer);
    _closeCoverTimer = setInterval(function() {
      runCloseCover(uiStore.currentDate);
      // 顺带自愈：页面早于 9:25 打开时云端还没有区间涨幅，定时重读一次（已加载则直接返回，无请求）
      ensureDragonRangePct(uiStore.currentDate).catch(function(e) {
        console.warn('[DRAGON] 定时重读 10 日涨幅失败:', e && e.message);
      });
      // [DRAGON-GROUP 2026-09-14] 同步自愈：页面早上打开时（未到收盘口径）只读了名册、没评选；
      // 跨过 15:00 后定时器到这里就会补评选 + 落库（幂等：同一评选日每会话只写一次）。
      ensureDragonGroupForDate(uiStore.currentDate);
    }, CLOSE_COVER_POLL_MS);
  }

  // 后台「龙头涨幅」按钮：强制重算一次（消耗 1 次猫抓额度），用于收盘后手动刷新。
  async function fetchDragonRangeFromNumcat(btn) {
    setBtnLoading(btn, true);
    try {
      const map = await ensureDragonRangePct(uiStore.currentDate, { force: true });
      let withData = 0;
      if (map) map.forEach(v => { if (v && v.pct !== null && v.pct !== undefined) withData++; });
      setApiStatus('numcatApiStatus', '✅ 龙头涨幅（近' + DRAGON_RANGE_DAYS + '个交易日区间）已刷新：' + withData + ' 只有数据', true);
    } catch (e) {
      setApiStatus('numcatApiStatus', '❌ ' + (e && e.message || e), false);
    } finally {
      setBtnLoading(btn, false);
    }
  }

  const currentPage = ref(0);
  const showBackend = ref(false);
  // [DEFAULT-COLLAPSED 2026-09-28] 看板默认【收起】（用户口径：打开 / 刷新页面不用再手动一个个关）。
  //   纯 UI 展示态（§34）；内容区是 v-show ⇒ 收起不影响 9:25 抓取 / 刷新 / 重算；⛔ 不要改成 true。
  const expanded = ref(false);
  let swipeStartX = 0;
  let swipeEndX = 0;
  let swipeStartY = 0;
  let swipeEndY = 0;

  function toggleBoard(e) {
    if (e) e.stopPropagation();
    expanded.value = !expanded.value;
  }

  const topicGroups = computed(() => {
    void viewData.value;
    void uiStore.currentDate;
    const auctionList = getTodayGroupList('auction');
    if (!auctionList || auctionList.length === 0) return [];
    return getTopicGroups(auctionList);
  });

  const itemsByIndex = computed(() => {
    const map = new Map();
    (viewData.value.items || []).forEach(it => map.set(it.index, it));
    return map;
  });
  const obsItems = computed(() => {
    if (!viewData.value.obsIndices) return [];
    const m = itemsByIndex.value;
    return viewData.value.obsIndices.map(i => m.get(i)).filter(Boolean);
  });
  // [DRAGON-GROUP 2026-09-14] 龙头组 → 独立小组件（AuctionDragonGroup）渲染在第一页最上方。
  // 与 obsItems 同款：只按 Logic 层给出的索引取行对象，组件不做任何业务判断。
  const dragonItems = computed(() => {
    if (!viewData.value.dragonIndices) return [];
    const m = itemsByIndex.value;
    return viewData.value.dragonIndices.map(i => m.get(i)).filter(Boolean);
  });
  // [RANGE20-TOP5 2026-10-19 用户口径] 「20日涨幅前五补位」→ 独立小组件（AuctionRange20Leaders）。
  // 与 dragonItems 同款：只按 Logic 层给的索引取行对象，组件不做任何业务判断（§3）。
  // 顺序 = viewData.range20LeaderIndices 的顺序 = 20 日涨幅降序（Logic 层已排好，⛔ 不在视图层再排）。
  const range20LeaderItems = computed(() => {
    if (!viewData.value.range20LeaderIndices) return [];
    const m = itemsByIndex.value;
    return viewData.value.range20LeaderIndices.map(i => m.get(i)).filter(Boolean);
  });
  const regularItems = computed(() => {
    if (!viewData.value.regularIndices) return [];
    const m = itemsByIndex.value;
    return viewData.value.regularIndices.map(i => m.get(i)).filter(Boolean);
  });
  const allItems = computed(() => {
    return [...dragonItems.value, ...obsItems.value, ...regularItems.value];
  });

  const searchActive = ref(false);
  const searchKeyword = ref('');

  // [FEAT 2026-08-18] §3/§6 双击表头 → 表头上方搜索框，输入股票名称 → 匹配行整行黄色高光。
  // headerSearchActive 控制搜索框显隐；highlightStockSet 存匹配的股票名集合（行高光唯一真相源）。
  // 与旧 searchActive/searchKeyword 过滤搜索解耦，互不影响（§18 状态隔离）。
  const headerSearchActive = ref(false);
  const highlightStockSet = ref(new Set());

  const filteredItems = computed(() => {
    if (!searchKeyword.value.trim()) return allItems.value;
    const kw = searchKeyword.value.trim().toLowerCase();
    return allItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
  });
  const filteredDragonItems = computed(() => {
    if (!searchKeyword.value.trim()) return dragonItems.value;
    const kw = searchKeyword.value.trim().toLowerCase();
    return dragonItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
  });
  const filteredObsItems = computed(() => {
    if (!searchKeyword.value.trim()) return obsItems.value;
    const kw = searchKeyword.value.trim().toLowerCase();
    return obsItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
  });
  // [RANGE20-TOP5 2026-10-19] 与龙头组/观察组同一套搜索过滤（搜索时区块跟着一起筛）。
  const filteredRange20LeaderItems = computed(() => {
    if (!searchKeyword.value.trim()) return range20LeaderItems.value;
    const kw = searchKeyword.value.trim().toLowerCase();
    return range20LeaderItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
  });
  const filteredRegularItems = computed(() => {
    if (!searchKeyword.value.trim()) return regularItems.value;
    const kw = searchKeyword.value.trim().toLowerCase();
    return regularItems.value.filter(item => item.stock && item.stock.toLowerCase().includes(kw));
  });
  const showObsSeparator = computed(() => filteredObsItems.value.length > 0 && filteredRegularItems.value.length > 0);
  // [DRAGON-GROUP 2026-09-14] 龙头组与下方（观察组/常规组）之间的蚂蚁线分隔：龙头区块非空且下方有内容时显示。
  const showDragonSeparator = computed(() => {
    return filteredDragonItems.value.length > 0
      && (filteredObsItems.value.length + filteredRegularItems.value.length) > 0;
  });

  // ===== 第二页（题材分组）状态与逻辑 =====
  // [RANGE-PCT 2026-10-14] ⛔ 已移除 `byThreeDayJingDie`：本页从来没有任何消费方
  //   （sortedTopicGroups 只按强度排），是个「点了没反应」的死开关（§16）；
  //   用户口径「三天竞跌功能去掉」⇒ 连同 UI 开关一并删除，而不是换成一个同样不工作的新开关。
  // [RANGE20 2026-10-19 用户口径] ⛔ 已移除 `byRatio`：本页的「量比抢筹」开关与 2026-10-14 删掉的
  //   「三天竞跌」同性质 —— sortedTopicGroups 只按强度排，它在本页【没有任何消费方】（死开关，§16）。
  //   用户本轮明确「顺手删掉」，故连状态位一并移除。
  const sortState2 = reactive({ byParallel: false, byJingYest: false, byJingYestRatio: false });
  const isStrengthSortEnabled = ref(false);
  const p2ExpandedSet = ref(new Set());
  const p2TrendHistory = ref({});
  const p2ExpandedTopics = ref(new Set());
  const p2ExpandAll = ref(false);

  // §P1-6：getStarSymbols / extractChangeFromNote / getChangePctDisplay / canGroupExpand /
  // getRankAppearText / getTopicsDisplay 已迁至 ../composables/auction-board-helpers.js（同名 import）。
  function getStockStyle(stockName) {
    // [HIGH-LIMIT-BOARD 2026-09-21] 科创板(688/689) / 创业板(300/301) / 北交所(43/83/87/88/92)
    //   → 第二页题材列表同样画【浅灰色 + 删除线】，与第一页口径完全一致（同一份 Logic 判定）。
    //   ⚠️ 必须 return 在题材数配色【之前】：安全提示压过「题材数 ≥3 标红」这类装饰色。
    //   这里是内联 style（本来就是字符串），只能靠提前 return 实现「覆盖」，没有 CSS 权重可借。
    //   代码缺失 → isHighLimitBoard=false → 不标（§40 不猜），照常走下面的题材数配色。
    if (isHighLimitBoard(getStockCode(stockName) || '')) {
      return 'color:#9ca3af;font-weight:500;text-decoration:line-through;';
    }
    const cnt = p2StockTopicCount.value[stockName] || 1;
    if (cnt >= 3) return 'color:#ef4444;font-weight:500;';
    if (cnt === 2) return 'color:#1f2937;font-weight:500;';
    return 'color:rgba(0,0,0,0.6);font-weight:500;';
  }
  // [PERF-ROWCLASS 2026-10-14 · §19/§21] 题材页「行 class」的股票名 → 当日竞价行 预索引。
  //   原实现 getTopicRowClass 被模板【逐行】调用，内部每次都 getTodayGroupList('auction')
  //   （= 全量 filter，且条数变化时会打一条 _dbgLog）+ list.find()（线性扫）
  //   ⇒ 行数 N 时为 O(N²) 重复功 + N 条日志刷屏（真实剖析：getTopicRowClass inclusive 491ms，
  //   其中 _dbgLog 自耗时 133~160ms 全来自这里）。
  //   改为「每（日期 × 数据代）建一次 Map<trim(股票名), 当日竞价行>」，getTopicRowClass 退化为 O(1) 查表。
  //   依赖声明与 topicGroups 对齐（同一份 getTodayGroupList('auction') 输入）。
  //   ⚠️ 语义与 .find() 完全一致：重复股票名取【首个】（Map.has 守卫），缺失 ⇒ undefined（原样）。
  const p2AuctionItemIndex = computed(() => {
    void viewData.value;
    void uiStore.currentDate;
    const auctionList = getTodayGroupList('auction');
    const map = new Map();
    if (auctionList && auctionList.length) {
      for (let i = 0; i < auctionList.length; i++) {
        const it = auctionList[i];
        if (!it || !it.stock) continue;
        const key = it.stock.trim();
        if (!map.has(key)) map.set(key, it);
      }
    }
    return map;
  });

  // §P1-6：getTopicNameStyle / getChangeClass 已迁至 ../composables/auction-board-helpers.js（同名 import）。
  function getTopicRowClass(group, stock) {
    const auctionItem = p2AuctionItemIndex.value.get((stock.stock || '').trim());
    let cls = 'auction-topic-row';
    if (auctionItem) {
      const ts2 = deriveAuctionTagState(auctionItem.stock.trim(), uiStore.currentDate);
      if (ts2.sold) cls += ' sold';
      else if (ts2.bought) cls += ' bought';
      else if (ts2.selected) cls += ' selected';
      else if (auctionItem.selected === true) cls += ' manual-selected';
    }
    if (canGroupExpand(group.topic)) cls += ' auction-trend-trigger-p2';
    return cls;
  }

  const p2StockTopicCount = computed(() => {
    const counts = {};
    topicGroups.value.forEach(g => {
      if (g.topic === '其它') return;
      g.stocks.forEach(s => { if (s.stock) counts[s.stock] = (counts[s.stock] || 0) + 1; });
    });
    return counts;
  });

  const p2HighRatioInfo = computed(() => {
    void auctionStore.dataVersions['auction'];
    try { return getHighRatioStocksForDate(uiStore.currentDate, 'auction'); }
    catch (e) { return { count: '-', stockNames: new Set() }; }
  });
  const p2JingYestSet = computed(() => {
    void auctionStore.dataVersions['auction'];
    try { return getJingYestHighlightSetForDate(uiStore.currentDate, 'auction'); }
    catch (e) { return new Set(); }
  });
  const p2ParallelSet = computed(() => {
    void auctionStore.dataVersions['auction'];
    try { return getParallelStocksForDate(uiStore.currentDate, 'auction'); }
    catch (e) { return new Set(); }
  });
  const p2JingYestCount = computed(() => {
    // 与首页一致：统计「当前列表（题材分组）里实际符合竞昨条件的股票数」，而非全市场竞昨全集，
    // 避免黄色条数字与页面蓝色高光对不上。
    if (!p2JingYestSet.value) return '-';
    let cnt = 0;
    topicGroups.value.forEach(g => {
      if (!g.stocks) return;
      g.stocks.forEach(s => { if (s.stock && p2JingYestSet.value.has(s.stock.trim())) cnt++; });
    });
    return cnt;
  });
  const p2HighRatioCount = computed(() => p2HighRatioInfo.value ? p2HighRatioInfo.value.count : '-');

  const sortedTopicGroups = computed(() => {
    const groups = topicGroups.value;
    if (!groups || groups.length === 0) return [];
    const auctionData = getGroupData('auction');
    const prevDate = getPreviousTradingDay(uiStore.currentDate);
    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
    const auctionList = getTodayGroupList('auction');

    const enriched = groups.map(g => {
      if (g.topic === '其它') return { ...g, strength: null };
      let strongCount = 0;
      g.stocks.forEach(stock => {
        let hasDownArrow = false;
        if (prevAuctionList.length > 0 && stock.stock) {
          const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
          if (prevItem && prevItem.yestVolume) {
            const prevVolume = parseFloat(prevItem.volume) || 0;
            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
            if (prevYestVolume > 0) {
              const prevRatioValue = (prevVolume / prevYestVolume) * 100;
              if (Math.round(stock.ratioValue) < Math.round(prevRatioValue)) hasDownArrow = true;
            }
          }
        }
        if (!hasDownArrow) strongCount++;
      });
      return { ...g, strength: g.stocks.length > 0 ? Math.round((strongCount / g.stocks.length) * 100) : 0 };
    });

    const otherGroup = enriched.find(g => g.topic === '其它');
    let sorted;
    if (isStrengthSortEnabled.value) {
      sorted = enriched.filter(g => g.topic !== '其它').sort((a, b) => (b.strength || 0) - (a.strength || 0));
    } else {
      sorted = enriched.filter(g => g.topic !== '其它').sort((a, b) => (b.strength || 0) - (a.strength || 0));
    }
    if (otherGroup) sorted.push(otherGroup);
    return sorted;
  });

  function toggleSort2(key) {
    sortState2[key] = !sortState2[key];
    if (sortState2[key]) {
      // [RANGE20 2026-10-19] ⛔ `byRatio` 与 `byParallel` 两个分支都已删除：
      //   前者是本页「量比抢筹」死开关（本轮移除）；后者原本只是在 byRatio 打开时把它置 false，
      //   没有可联动的对象后就只剩一个空块（§16 不留死分支）。
      if (key === 'byJingYest') {
        sortState2.byJingYestRatio = false;
        sortState2.byParallel = true;
      } else if (key === 'byJingYestRatio') {
        sortState2.byParallel = false;
        sortState2.byJingYest = false;
      }
    } else {
      if (key === 'byParallel') {
        sortState2.byJingYest = false; sortState2.byJingYestRatio = false;
      } else if (key === 'byJingYest') {
        sortState2.byParallel = false;
      }
    }
    // [FIX 2026-09-06] 同第一页 toggleSort：任何第二页排序 toggle 的开/关动作都把展开态重置为收起
    // （分组展开 + 个股趋势面板 + 趋势缓存）。p2ExpandAll 必须一并置 false——该复选框在模板里有
    // :checked 回显（AuctionBoardPageTopics.vue），不同步会出现「勾选着全部展开但内容已收起」的错位。
    p2ExpandedSet.value = new Set();
    p2TrendHistory.value = {};
    p2ExpandedTopics.value = new Set();
    p2ExpandAll.value = false;
  }
  function toggleStrengthSort() {
    isStrengthSortEnabled.value = !isStrengthSortEnabled.value;
  }
  function toggleGroupExpand(topic) {
    const topicSet = new Set(p2ExpandedTopics.value);
    const expandSet = new Set(p2ExpandedSet.value);
    const trendHistory = { ...p2TrendHistory.value };
    const group = sortedTopicGroups.value.find(g => g.topic === topic);
    if (!group) return;
    if (topicSet.has(topic)) {
      topicSet.delete(topic);
      group.stocks.forEach(stock => {
        const key = topic + '|' + stock.stock;
        expandSet.delete(key);
        delete trendHistory[key];
      });
      p2ExpandedTopics.value = topicSet;
      p2ExpandedSet.value = expandSet;
      p2TrendHistory.value = trendHistory;
      return;
    }
    // [FIX 2026-08-16] 展开整组不再一次性同步加载全部股票历史（§33 性能：N只股票×5日×4字段会阻塞主线程，体验卡顿）。
    // 先即时展开全部行（仅集合操作，秒开），历史数据分批异步补齐（每帧一批，图表逐批出现）。
    topicSet.add(topic);
    const pending = [];
    const loadDate = uiStore.currentDate;
    group.stocks.forEach(stock => {
      const key = topic + '|' + stock.stock;
      expandSet.add(key);
      if (!trendHistory[key] && stock.stock) pending.push({ key, name: stock.stock });
    });
    p2ExpandedTopics.value = topicSet;
    p2ExpandedSet.value = expandSet;
    p2TrendHistory.value = trendHistory;
    loadP2TrendHistoryChunked(pending, loadDate);
  }
  function p2ToggleExpandAll() {
    p2ExpandAll.value = !p2ExpandAll.value;
    if (p2ExpandAll.value) {
      const s = new Set();
      sortedTopicGroups.value.forEach(g => { if (canGroupExpand(g.topic)) s.add(g.topic); });
      p2ExpandedTopics.value = s;
    } else {
      p2ExpandedTopics.value = new Set();
    }
  }
  function loadP2TrendHistory(stockName) {
    const name = stockName.trim();
    const history = getAuctionStockHistory(name, uiStore.currentDate, 5, 'auction');
    // [TREND-PATCH-STORE 2026-10-23] 第二页整组展开也套补缺仓库。
    //   ⛔ 漏这一处就是 _trendEntryOf 注释里警告的那类缺项：同一只票「第一页展开有当天数据、
    //   第二页展开没有」。仓库里没有该票时 mergeTrendPatch 原样返回入参，零开销。
    return _trendEntryOf(_mergeTrendPatch(history, name), name);
  }

  // [FIX 2026-08-16] 整组展开分批异步加载趋势历史（§33 性能）：每帧一批（默认 4 只），
  // 行先即时展开、图表逐批出现，避免一次性同步加载 N 只股票历史阻塞主线程（第二页三角展开卡顿根因）。
  // 每批自链定时器独立运行：连开多个组互不取消；已收起/日期已变的行自动跳过，不残留脏数据。
  function loadP2TrendHistoryChunked(pending, loadDate) {
    if (!pending || pending.length === 0) return;
    let i = 0;
    const CHUNK = 4;
    const step = () => {
      // 日期已切换 → 中止剩余加载，避免把旧日期数据写进新日期
      if (loadDate !== uiStore.currentDate) return;
      const end = Math.min(i + CHUNK, pending.length);
      const next = { ...p2TrendHistory.value };
      for (; i < end; i++) {
        const p = pending[i];
        if (!p || !p.name) continue;
        // 行可能已被用户收起 → 跳过，避免残留数据
        if (!p2ExpandedSet.value.has(p.key)) continue;
        next[p.key] = loadP2TrendHistory(p.name);
      }
      p2TrendHistory.value = next;
      if (i < pending.length) setTimeout(step, 16);
    };
    step();
  }
  function toggleP2Trend(topic, stockName) {
    if (!canGroupExpand(topic)) return;
    const key = topic + '|' + stockName;
    const s = new Set(p2ExpandedSet.value);
    if (s.has(key)) {
      s.delete(key);
      const h = { ...p2TrendHistory.value };
      delete h[key];
      p2TrendHistory.value = h;
    } else {
      s.add(key);
      p2TrendHistory.value = { ...p2TrendHistory.value, [key]: loadP2TrendHistory(stockName) };
    }
    p2ExpandedSet.value = s;
  }

  function getLastNTradingDays(n) {
    const days = [];
    let date = uiStore.currentDate;
    while (days.length < n && date) {
      if (typeof isTradingDay === 'function' ? isTradingDay(date) : true) days.push(date);
      date = getPreviousTradingDay(date);
      if (!date) break;
    }
    return days;
  }

  const page3Data = computed(() => {
    const allTradingDays = getLastNTradingDays(6);
    if (allTradingDays.length === 0) return { topics: [], tradingDays: [] };
    const tradingDays = allTradingDays.slice(0, 5);
    const auctionData = getGroupData('auction');
    const allTopicData = {};

    allTradingDays.forEach(dateStr => {
      const dayAuctionList = auctionData[dateStr] || [];
      if (dayAuctionList.length === 0) return;
      const groups = getTopicGroups(dayAuctionList);
      groups.forEach(group => {
        // [ARCH-V3 §6] 单一真相：伪题材黑名单统一走 rules.js#isPseudoTopic
        if (group.topic === '其它' || isPseudoTopic(group.topic)) return;
        if (!allTopicData[group.topic]) allTopicData[group.topic] = [];
        let strongCount = 0, upCount = 0, downCount = 0;
        const prevDate = getPreviousTradingDay(dateStr);
        const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
        group.stocks.forEach(stock => {
          let hasDownArrow = false;
          if (prevAuctionList.length > 0 && stock.stock) {
            const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
            if (prevItem && prevItem.yestVolume) {
              const prevVolume = parseFloat(prevItem.volume) || 0;
              const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
              if (prevYestVolume > 0 && Math.round(stock.ratioValue) < Math.round((prevVolume / prevYestVolume) * 100)) hasDownArrow = true;
            }
          }
          if (!hasDownArrow) strongCount++;
          const changeValue = getChangePctDisplay(stock);
          if (changeValue && changeValue !== '-') {
            if (changeValue.includes('涨停') || (!changeValue.startsWith('-') && !changeValue.includes('跌停'))) upCount++;
            else if (changeValue.startsWith('-') || changeValue.includes('跌停')) downCount++;
          }
        });
        allTopicData[group.topic].push({
          date: dateStr, rankCount: 0, starCount: group.starCount,
          starText: getStarSymbols(group.starCount),
          strength: group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0,
          stockCount: group.stocks.length, isUp: upCount >= downCount,
          hasData: true, hasChangeData: upCount > 0 || downCount > 0
        });
      });
    });

    const topicData = {};
    Object.keys(allTopicData).forEach(topic => {
      topicData[topic] = allTopicData[topic].filter(d => tradingDays.includes(d.date));
    });
    Object.keys(topicData).forEach(topic => {
      const existingDates = topicData[topic].map(d => d.date);
      tradingDays.forEach(dateStr => {
        if (!existingDates.includes(dateStr)) {
          topicData[topic].push({ date: dateStr, rankCount: 0, starCount: 0, starText: '-', strength: 0, stockCount: 0, isUp: null, hasData: false, hasChangeData: false });
        }
      });
    });

    const validTopics = Object.entries(topicData)
      .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
      .map(([topic, data]) => ({ topic, data }));

    validTopics.sort((a, b) => {
      const todayDate = tradingDays[0];
      const aToday = a.data.find(d => d.date === todayDate);
      const bToday = b.data.find(d => d.date === todayDate);
      const aHasData = aToday?.hasData || false;
      const bHasData = bToday?.hasData || false;
      if (aHasData !== bHasData) return bHasData ? 1 : -1;
      const aHasStar = aToday?.hasData && (aToday.starCount || 0) > 0;
      const bHasStar = bToday?.hasData && (bToday.starCount || 0) > 0;
      if (aHasStar !== bHasStar) return bHasStar ? 1 : -1;
      const aUpDays = a.data.filter(d => d.hasChangeData && d.isUp).length;
      const bUpDays = b.data.filter(d => d.hasChangeData && d.isUp).length;
      if (aUpDays !== bUpDays) return bUpDays - aUpDays;
      const aStars = a.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
      const bStars = b.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
      return bStars - aStars;
    });

    const topics = validTopics.map(({ topic, data }) => ({
      topic,
      data,
      // A3-02：每个题材的历史数据按日期倒序只排一次，箭头（getHistoryArrow）也在此处预计算，
      // 模板不再重复 .sort(...) 与 v-html（A2-06）。
      sortedData: data.slice().sort((a, b) => b.date.localeCompare(a.date)).map((d, i, arr) => ({
        ...d,
        arrow: getHistoryArrow(d, arr[i + 1])
      }))
    }));
    return { topics, tradingDays };
  });

  // §P1-6：formatDateShort / getHistoryArrow 已迁至 ../composables/auction-board-helpers.js（同名 import）。
  // A2-06：不再返回 v-html 字符串，改为安全的 { text, color } 对象，模板用 {{ }} + :style 渲染。

  const copiedStocks = ref([]);
  function loadCopiedStocks() {
    try {
      const all = JSON.parse(localStorage.getItem('copiedStocksData') || '{}'); // 合规：临时剪贴板/输入缓存（§8 允许）
      copiedStocks.value = all[uiStore.currentDate] || [];
    } catch (e) {
      console.warn('[剪贴板] 读取已复制股票失败:', e && e.message);
      copiedStocks.value = [];
    }
  }
  function saveCopiedStocks() {
    try {
      const all = JSON.parse(localStorage.getItem('copiedStocksData') || '{}'); // 合规：临时剪贴板/输入缓存（§8 允许）
      all[uiStore.currentDate] = copiedStocks.value;
      localStorage.setItem('copiedStocksData', JSON.stringify(all)); // 合规：临时剪贴板/输入缓存（§8 允许）
    } catch (e) {
      console.warn('[剪贴板] 保存已复制股票失败:', e && e.message);
    }
  }
  function copyAllTopicStocks(topic) {
    const auctionList = getTodayGroupList('auction');
    if (!auctionList || auctionList.length === 0) return;
    const prevDate = getPreviousTradingDay(uiStore.currentDate);
    const auctionData = getGroupData('auction');
    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
    const groups = getTopicGroups(auctionList);
    const topicGroup = groups.find(g => g.topic === topic);
    if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) return;
    const stocksToCopy = topicGroup.stocks.sort((a, b) => b.ratioValue - a.ratioValue);
    stocksToCopy.forEach(stock => {
      let arrow = '';
      if (prevAuctionList.length > 0 && stock.stock) {
        const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
        if (prevItem && prevItem.yestVolume) {
          const prevVolume = parseFloat(prevItem.volume) || 0;
          const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
          if (prevYestVolume > 0) {
            const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
            const currRatio = Math.round(stock.ratioValue);
            if (currRatio > prevRatio) arrow = '⬆';
            else if (currRatio < prevRatio) arrow = '⬇';
          }
        }
      }
      copiedStocks.value.push({ name: stock.stock, topic, ratio: Math.round(stock.ratioValue), arrow });
    });
    saveCopiedStocks();
    switchPage(3);
  }
  function copyTopicStocks(topic, minRatio) {
    const auctionList = getTodayGroupList('auction');
    if (!auctionList || auctionList.length === 0) return;
    const prevDate = getPreviousTradingDay(uiStore.currentDate);
    const auctionData = getGroupData('auction');
    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
    const groups = getTopicGroups(auctionList);
    const topicGroup = groups.find(g => g.topic === topic);
    if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) return;
    const stocksToCopy = topicGroup.stocks.filter(s => Math.round(s.ratioValue) >= minRatio).sort((a, b) => b.ratioValue - a.ratioValue);
    stocksToCopy.forEach(stock => {
      let arrow = '';
      if (prevAuctionList.length > 0 && stock.stock) {
        const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
        if (prevItem && prevItem.yestVolume) {
          const prevVolume = parseFloat(prevItem.volume) || 0;
          const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
          if (prevYestVolume > 0) {
            const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
            const currRatio = Math.round(stock.ratioValue);
            if (currRatio > prevRatio) arrow = '⬆';
            else if (currRatio < prevRatio) arrow = '⬇';
          }
        }
      }
      copiedStocks.value.push({ name: stock.stock, topic, ratio: Math.round(stock.ratioValue), arrow });
    });
    saveCopiedStocks();
    switchPage(3);
  }
  function deleteCopiedStock(index) {
    copiedStocks.value.splice(index, 1);
    saveCopiedStocks();
  }
  function clearAllCopiedStocks() {
    copiedStocks.value = [];
    saveCopiedStocks();
  }

  const page4DisplayStocks = computed(() => {
    const stockTopics = {};
    copiedStocks.value.forEach((stock, index) => {
      if (!stockTopics[stock.name]) stockTopics[stock.name] = { stocks: [], topics: new Set() };
      stockTopics[stock.name].stocks.push({ ...stock, originalIndex: index });
      stockTopics[stock.name].topics.add(stock.topic);
    });
    const duplicateStocks = [], uniqueStocks = [];
    Object.keys(stockTopics).forEach(stockName => {
      const data = stockTopics[stockName];
      if (data.topics.size > 1) {
        duplicateStocks.push({
          name: stockName, topic: Array.from(data.topics).join(','),
          ratio: data.stocks[0].ratio, arrow: data.stocks[0].arrow,
          originalIndex: data.stocks[0].originalIndex,
          allOriginalIndexes: data.stocks.map(s => s.originalIndex), isDuplicate: true
        });
      } else {
        uniqueStocks.push({ ...data.stocks[0], allOriginalIndexes: [data.stocks[0].originalIndex], isDuplicate: false });
      }
    });
    return [...duplicateStocks, ...uniqueStocks];
  });

  function openBackend() {
    showBackend.value = !showBackend.value;
  }
  function openEditModal() {
    if (editModalRef.value) editModalRef.value.open();
  }
  function openCoreTopicModal() {
    if (coreTopicModalRef.value) coreTopicModalRef.value.open();
  }

  function onHeaderClick() {
    searchActive.value = !searchActive.value;
    if (!searchActive.value) searchKeyword.value = '';
  }

  // [FEAT 2026-08-18] 双击表头切换高光搜索框；关闭时清空高光集合（§17 响应式驱动 UI）。
  function onHeaderDblClick() {
    headerSearchActive.value = !headerSearchActive.value;
    if (!headerSearchActive.value) highlightStockSet.value = new Set();
  }

  /** 封单量窗口的读取单飞标志：同一时刻只允许一次「读 limit_pool 窗口」（§32） */
  let _sealEnsuring = false;

  /**
   * [SEAL-VOLUME 2026-10-11 用户口径] 确保封单量窗口已在 Data 层内存缓存里
   * （供 Logic 层纯函数同步取值；窗口日期口径见 seal-volume.js#sealWindowDates）。
   *
   * ⛔ 不消费猫抓额度：limit_pool 是 Edge Function 15:40 用同花顺 fuyao 免费抓的。
   * §32：窗口已缓存 ⇒ 一个请求都不发、也不重算视图，直接返回。
   * 读完 → 再 bump 一次版本号 → 统计条 / 趋势图重算，封单段才会出现。
   * §10：读失败只记日志 —— 封单段自然不出现（⛔ 不污染看板、不假装成「没有封单」）。
   */
  function _ensureSealWindow() {
    const d = uiStore.currentDate;
    if (!d || _sealEnsuring) return;
    if (!sealWindowPending(d)) return;
    _sealEnsuring = true;
    ensureSealWindow(d)
      .then(function() {
        // 日期已切走 ⇒ 不要用旧窗口的到货去触发新日期的重算（新日期那次自己会再 ensure）
        if (uiStore.currentDate !== d) return;
        auctionStore.bumpDataVersion('auction');
      })
      .catch(function(e) {
        _dbgLog('[SEAL-VOLUME] limit_pool 窗口读取失败：' + ((e && e.message) || e));
      })
      .finally(function() { _sealEnsuring = false; });
  }

  function refresh() {
    auctionStore.bumpDataVersion('auction');
    // [SEAL-VOLUME 2026-10-11] 顺带确保封单量窗口已就绪（已缓存 = 立刻返回，零请求零重算）。
    _ensureSealWindow();
  }

  /**
   * 把当前排序状态同步进 Pinia store（§6 单一真相：早盘竞价 / 决策看板 / 增量指纹都读这一份）。
   * [TWO-MODES 2026-10-02] 提取成函数：现在有两个入口要写它（toggleSort 与 toggleTopicOrder），
   *   ⛔ 别在两处各抄一遍 —— 漏同步一个键就会让「早盘竞价显示的顺序」与「决策看板算出的排名」分叉。
   */
  function _syncSortStateToStore() {
    if (auctionStore.sortState && auctionStore.sortState['auction']) {
      const s = auctionStore.sortState['auction'];
      s.byAuctionLeg = sortState.byAuctionLeg;
      s.byRangePct20 = sortState.byRangePct20;
      s.byJingYest = sortState.byJingYest;
      s.byJingYestRatio = sortState.byJingYestRatio;
      s.byRangePct = sortState.byRangePct;
      s.byTopic = sortState.byTopic;
      // [TWO-MODES 2026-10-02] 题材排序口径（决策看板据它选买点模式，见 decision-mode.js）
      s.topicOrderBy = sortState.topicOrderBy;
    }
  }

  /** 任何排序动作后统一收尾：清展开态 + 清趋势缓存 + 重算视图（原有行为，一次收口） */
  function _afterSortChange() {
    // [FIX 2026-09-06] 展开态不跨 toggle 保留：任何排序 toggle 的「开」或「关」动作，都把展开面板
    // 重置为收起。需求——关闭 toggle 时收起；再次打开时也必须是收起，而不是恢复上一次的展开集合。
    // 展开态是纯 UI 状态（§34），不落库、不记忆；用户手动点股票名/序号仍可随时展开（onExpandTrend），
    // 但下一次 toggle 动作又会回到默认收起。trendHistory 同步清空，避免留存已收起股票的趋势缓存。
    expandedSet.value = new Set();
    trendHistory.value = {};
    trendPatchStore.value = {};   // [TREND-PATCH-STORE 2026-10-23] 补缺仓库与趋势缓存同生命周期
    refresh();
  }

  /**
   * [SWITCH-PICK 2026-10-02 用户口径] ⭐决策看板「切换选股」→ 早盘竞价的【反向同步通道】。
   *
   * 用户原话：「在决策看板切『切换选股』会同步改早盘竞价的题材 / 一字 toggle（早盘竞价的
   *   排序显示也会跟着变），反之亦然。只有一个开关状态。」
   *
   * ⓘ 为什么需要这个 watch：`sortState` 是本 composable 的【局部 reactive】，而它的两个消费者
   *   在【兄弟组件】里（AuctionBoard / DecisionBoard 并列挂在 DashboardView 下，都是 v-show，
   *   始终挂载）—— 兄弟之间 inject 不到对方的实例，所以只有 app 级 store 能当通信总线（§6）。
   *   正向（早盘竞价 → store）已由 _syncSortStateToStore 完成；这里补上【反向】（store → 早盘竞价）。
   *
   * ⓘ 为什么不会打环：
   *   · 早盘竞价自己点 toggle → 先改局部 → 写 store → 本 watch 触发 → 值【已经相等】⇒ 立刻 return；
   *   · 决策看板改口径     → store 变  → 本 watch 触发 → 值不同 ⇒ 回写局部 + _afterSortChange()。
   *
   * ⚠️ 回写后走 _afterSortChange()（清展开态 + 重算视图）：口径变了，已展开行的位置会漂移，
   *   ⛔ 别在这里另写一份收尾动作（与早盘竞价点 toggle 共用同一套，§6）。
   * ⚠️ 只同步【口径】（topicOrderBy）。决策看板那个「切换选股」开关【不】动 byTopic ——
   *   用户口径「早盘竞价保持不变」：早盘竞价的分组排序是否开启，只由用户点它自己的 toggle 决定。
   */
  watch(
    function() {
      return (auctionStore && auctionStore.sortState && auctionStore.sortState.auction)
        ? auctionStore.sortState.auction.topicOrderBy
        : null;
    },
    function(nv) {
      const want = (nv === TOPIC_ORDER_YIZI) ? TOPIC_ORDER_YIZI : TOPIC_ORDER_VOL_RATIO;
      if (sortState.topicOrderBy === want) return;   // 早盘竞价自己写的 → 已一致，⛔ 不再回头改 store
      sortState.topicOrderBy = want;
      _afterSortChange();
    }
  );

  /**
   * [TWO-MODES 2026-10-02 用户口径]⭐题材 / 一字两个 toggle 的唯一入口（互斥由结构保证）。
   *
   * 用户原话：「把早盘竞价看板的『平行』toggle 改成『一字』……打开一字 toggle 后，显示也和单独
   *   打开题材 toggle 一样，只是排序变了（一字数量多的排在前面）……这样两个 toggle 并存，互斥。」
   *
   * 实现：两个 toggle **共用同一个 `byTopic` 开关**，只用 `topicOrderBy` 区分口径 ——
   *   所以「同时打开」在结构上不可能（⛔ 不需要手写互斥矩阵，也不会出现两个开关都亮的状态）。
   *   显示行为（分组 / 表头 / 底色 / 龙头徽章 / 观察组合并）两边完全一致 ⇒ 正好满足
   *   「显示也和单独打开题材 toggle 一样，只是排序变了」。
   *
   * 交互语义（与普通 toggle 一致）：
   *   · 点当前【已生效】的那个 → 关闭（byTopic = false；topicOrderBy 保留，下次打开还是它）；
   *   · 点另一个 / 当前是关 → 打开并切到该口径（另一个自然就关了）。
   *
   * @param {string} mode TOPIC_ORDER_VOL_RATIO（题材）| TOPIC_ORDER_YIZI（一字）
   *
   * ⓘ [SWITCH-PICK 2026-10-02] 本函数与决策看板的 toggleSwitchPick 改的是 store 里的【同一格】
   *   （auctionStore.sortState.auction.topicOrderBy）⇒ 两处开关同源（§6 单一真相，不是两份状态互同步）。
   *   ⚠️ 唯一差别：本函数会【开 / 关】早盘竞价的分组排序（byTopic），决策看板那个不动 byTopic。
   */
  function toggleTopicOrder(mode) {
    const want = (mode === TOPIC_ORDER_YIZI) ? TOPIC_ORDER_YIZI : TOPIC_ORDER_VOL_RATIO;
    const isOn = !!sortState.byTopic && sortState.topicOrderBy === want;
    if (isOn) {
      sortState.byTopic = false;
    } else {
      sortState.byTopic = true;
      sortState.topicOrderBy = want;
    }
    _syncSortStateToStore();
    _afterSortChange();
  }

  function toggleSort(key) {
    // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」是【口径修饰开关】，⛔ 不进主排序互斥组：
    //   它只翻转自己，⛔ 不关掉十日 / 20日涨幅（用户明确要求「这两个开关可以同时打开」），
    //   也⛔ 不被它们关掉。关闭 ⇒ 十日 / 20日涨幅立刻退回原来的收盘口径（数值与排序一起变）。
    //   ⚠️ 取数由上方 _alegWatchBound 那个 watch 负责（它已把 byRangePct / byRangePct20 纳入依赖）。
    if (key === 'byAuctionLeg') {
      sortState.byAuctionLeg = !sortState.byAuctionLeg;
      _syncSortStateToStore();
      _afterSortChange();
      return;
    }
    sortState[key] = !sortState[key];
    if (sortState[key]) {
      if (key === 'byRangePct20') {
        // [RANGE20 2026-10-19 用户口径] 20日涨幅：与其它主排序 toggle 互斥（与十日涨幅同款）。
        //   本模式的取数由下方 watch 驱动（sortState.byRangePct20 已在依赖里）⇒ 点开即
        //   ensureRange20：阶段①读库内逐日行（同步可算，立刻出版）、阶段②同花顺补缺（无额度限制）。
        //   ⚠️ 这里【不 await】—— 取数慢不该阻塞 toggle 的视觉反馈（列表先按已有数据重排）。
        sortState.byJingYest = false; sortState.byJingYestRatio = false; sortState.byRangePct = false;
      } else if (key === 'byJingYest') {
        sortState.byRangePct20 = false;
        sortState.byJingYestRatio = false; sortState.byRangePct = false;
      } else if (key === 'byJingYestRatio') {
        sortState.byRangePct20 = false;
        sortState.byJingYest = false; sortState.byRangePct = false;
      } else if (key === 'byRangePct') {
        // [RANGE-PCT 2026-10-14] 十日涨幅：与其它主排序 toggle 互斥。
        //   本模式的数据源是云端 stock_range_pct（异步到货），下面的龙头 watch 已把
        //   `sortState.byRangePct` 纳入依赖 ⇒ 一打开就会 ensureDragonRangePct（数据在就秒回、
        //   不在才发一次请求），所以点开不会出现「空白等数据」的空窗。
        sortState.byRangePct20 = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false;
      }
      // [TWO-MODES 2026-10-02] ⛔ 原 `byParallel` 的互斥分支（toogle 时强置 byParallel=true）已删除：
      //   平行 toggle 不存在了，「平行」语义现在是「竞/昨」的一个 tier（见 view-helpers 的 tier 解析），
      //   不再需要任何状态位跟着联动。
      //   ⚠️ `byTopic` 也不走本函数 —— 两个题材 toggle 一律走 toggleTopicOrder（上面），
      //      否则「题材 / 一字」的互斥与口径切换就没人维护了。
    }
    _syncSortStateToStore();
    _afterSortChange();
    // ★★ [R20-FORCE 2026-10-30 用户报障「关闭再打开 toggle 也没见刷新」]
    //   点开 20日涨幅 = 用户**手动重试**，必须真的把那批没出值的票再请求一次：
    //   上游截断（只回 12 根）的票在 `_klineTried` 里登记着（`extra.has()` 为真 ⇒ 不解登记），
    //   不显式 force 就永远不会再试 ⇒ 屏幕上的 `—` 看起来「点了也没反应」。
    //   ⚠️ 语义仍是「只补没有值的票」，⛔ 不是全量重拉（§32）；单飞在 range20.js 内部，
    //      与 watch 那次调用共用同一个 Promise，不会打两份请求。
    //   ⚠️ 这里【不 await】：重试要几十秒，⛔ 不能卡住 toggle 的视觉反馈（与下方 watch 同款）。
    if (key === 'byRangePct20' && sortState.byRangePct20) {
      const _fd = uiStore.currentDate;
      const _frows = (viewData.value && viewData.value.items) || [];
      if (_fd && _frows.length > 0) {
        Promise.resolve(ensureRange20(_fd, _frows, { force: true })).catch(function(e) {
          console.warn('[RANGE20] 强制重试失败:', (e && e.message) || e);
        });
      }
    }
  }

  function expandAll() {
    const allItems = viewData.value.items || [];
    const newSet = new Set();
    const newHistory = {};
    allItems.forEach(item => {
      if (item && item.stock) {
        const name = item.stock.trim();
        newSet.add(name);
        const history = getAuctionStockHistory(name, uiStore.currentDate, 5, 'auction');
        // [TREND-PATCH-STORE 2026-10-23] 「全部展开」同样要套补缺仓库，否则补位票整组展开时当天仍是空
        newHistory[name] = _trendEntryOf(_mergeTrendPatch(history, name), name);
      }
    });
    expandedSet.value = newSet;
    trendHistory.value = newHistory;
  }

  function collapseAll() {
    expandedSet.value = new Set();
    trendHistory.value = {};
    trendPatchStore.value = {};   // [TREND-PATCH-STORE 2026-10-23] 补缺仓库与趋势缓存同生命周期
  }

  function _computeTrendStats(history) {
    let jingRatio = null, yestRatio = null, diff = null;
    if (history.length >= 2) {
      const todayVol = history[history.length - 1].volume;
      const yestVol = history[history.length - 2].volume;
      if (todayVol != null && yestVol != null && yestVol !== 0) {
        jingRatio = (todayVol / yestVol).toFixed(1);
      }
      const yestVolumeVal = history[history.length - 1].yestVolume;
      const prevVolumeVal = history[history.length - 2].yestVolume;
      if (yestVolumeVal != null && prevVolumeVal != null && prevVolumeVal !== 0) {
        yestRatio = (yestVolumeVal / prevVolumeVal).toFixed(1);
      }
      if (jingRatio != null && yestRatio != null) {
        diff = (parseFloat(jingRatio) - parseFloat(yestRatio)).toFixed(1);
      }
    }
    return { jingRatio, yestRatio, diff };
  }

  /**
   * [TREND-PATCH-STORE 2026-10-23] 把补缺仓库里的值合并进 history（**只填 null 位**）。
   *
   * 合并语义本身在 Logic 层（trend-patch-merge.js#mergeTrendPatch，纯函数、有单测）；
   * 这里只负责把 ref 里的仓库取出来喂进去。库里已有值的字段一律不覆盖（§6）。
   */
  function _mergeTrendPatch(history, name) {
    return mergeTrendPatch(history, trendPatchStore.value[name]);
  }

  /** 补缺仓库写入（今天整天替换 / 历史日浅合并 —— 语义见 Logic 层 putTrendPatch） */
  function _putTrendPatch(name, byYmd) {
    if (!name || !byYmd) return;
    const next = putTrendPatch(trendPatchStore.value[name], byYmd, beijingTodayYmd());
    trendPatchStore.value = Object.assign({}, trendPatchStore.value, { [name]: next });
  }

  /** 该日是否需要走同花顺补缺（四腿任一缺即补，语义见 Logic 层 trendNeedsPatch） */
  function _trendNeedsPatch(h) {
    return trendNeedsPatch(h);
  }

  /**
   * [SEAL-VOLUME 2026-10-11] 【趋势面板行对象的唯一构造实现（§6）】
   *
   * 把一份 getAuctionStockHistory 的结果转成趋势面板要的「一条腿一天一个点」结构。
   *
   * 🔴 为什么要收口成一个函数（而不是三个调用点各写一份 history.map）：
   *   同一个对象在【三处】被构造 —— 第二页整组展开（loadP2TrendHistory）、第一页「全部展开」
   *   （expandAll）、点序号展开（loadTrendHistory 的 paint）。
   *   三处逐字节相同的 6 行 map，加一条腿（本轮的封单量）就要改三遍 —— 漏一处就会出现
   *   「这一页有封单量图、那一页没有」这种极难自查的缺项（§6 / 与 decision-collect 的
   *   _eachRow 注释同一条教训：口径一致性靠结构保证，不靠人记得改三处）。
   *
   * @param {Array<object>} history getAuctionStockHistory(stockName, date, 5) 的返回（正序）
   * @param {string} name 股票名（封单量腿要从 limit_pool 缓存按名字取，⛔ 不能从 history 里猜）
   * @returns {object} 趋势面板的一行（volume / yestVolume / changePct / aucPctChg / aucVolRatio /
   *                   sealLots / 以及 jingRatio、yestRatio、diff 三个派生比）
   */
  function _trendEntryOf(history, name) {
    const stats = _computeTrendStats(history);
    return {
      volume: history.map(h => ({ date: h.date, value: h.volume })),
      yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
      changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
      aucPctChg: history.map(h => ({ date: h.date, value: h.aucPctChg !== undefined ? h.aucPctChg : null })),
      // [VRATIO-TREND 2026-10-01] 竞价量比（倍数）
      aucVolRatio: history.map(h => ({ date: h.date, value: h.aucVolRatio !== undefined ? h.aucVolRatio : null })),
      // [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）近 5 日：**只有当天涨停的才有数值**
      //   （非涨停 = 不在 limit_pool ⇒ null ⇒ 图上画「--」，§10 ⛔ 不补 0）。
      //   横轴日期【只认 history 给的】（见 sealLotsPointsOfHistory 的注释：必须与上面几张图逐日对齐）。
      sealLots: sealLotsPointsOfHistory(history, name),
      ...stats
    };
  }

  async function loadTrendHistory(stockName) {
    const name = (stockName || '').trim();
    if (!name) return;
    // 先用内存缓存即时出图：保证点击序号后面板立即展开（不依赖网络，根治"展开空白/像没展开"）
    const paint = (history) => {
      // [TREND-PATCH-STORE 2026-10-23] 出图前统一套上补缺仓库 ⇒ 任何一腿重画都不会丢掉
      //   同花顺补到的当天数据（封单量腿 / 水合腿的 paint 同样受益）。
      const merged = _mergeTrendPatch(history, name);
      trendHistory.value = {
        ...trendHistory.value,
        [name]: _trendEntryOf(merged, name)
      };
    };
    const history = getAuctionStockHistory(name, uiStore.currentDate, 5, 'auction');
    paint(history);
    // §33：先用内存缓存即时出图（点击序号后面板立即展开，不依赖网络）
    paint(history);
    // 再补齐缺失的历史交易日（market_metrics 云端）。
    // ⚠️ [PERF 2026-09-11] 原实现用 for..await 逐日【串行】hydrate —— 展开一只股票最多 5 次
    // 串行请求 ≈ 7.5s，用户感觉「点开要等半天」。改为：
    //   ① 只补【缺数据】的日期（已有 volume/change_pct 的日直接跳过，hydrate 自身也会短路，
    //      这里提前过滤是为了不再为它建立一个 await 位置）；
    //   ② 剩下的并发补齐（Promise.all），墙钟时间从 Σ 降到 ~1 次请求；
    //   ③ 补完统一重算一次（一次 paint 而不是每个 await 各 paint 一次，避免 5 次全量重渲染）。
    let hydrated = false;
    // 只补真正缺数据的交易日：hydrateStockHistoryRow 自身的短路条件是
    // 「该行 volume 【且】 change_pct 都在才算齐」（见 data/watchlist-and-metrics.js#_isTrendRowHydrated），
    // 所以预筛必须是「任一缺」才与之同口径。
    // 🔴 [TREND-PATCH-STORE 2026-10-23] 原写法是 `!hasVolume && !hasPct`（**两样都缺**才算缺），
    //   与短路条件正好相反 ⇒ 「当天只有 change_pct、没有 volume」的半残行被预筛挡掉，
    //   永远不会去云端补量；同时注释把它写成了「任一非空」，读代码的人会以为已经对上了。
    //   改成「任一缺」后：完整行仍被短路（零请求），半残行才会真正补一次（同 key 只试一次，§32）。
    const pending = history
        .filter(h => {
            const hasVolume = h.volume != null && String(h.volume).trim() !== '';
            const hasPct = h.changePct != null && String(h.changePct).trim() !== '';
            return !hasVolume || !hasPct;
        })
        .map(h => h.date);
    if (pending.length > 0) {
        const results = await Promise.all(
            pending.map(d => hydrateStockHistoryRow(d, name, 'auction').catch(() => false))
        );
        hydrated = results.some(Boolean);
    }
    if (hydrated) {
        paint(getAuctionStockHistory(name, uiStore.currentDate, 5, 'auction'));
    }
    // [TREND-PATCH 2026-10-21] 同花顺兜底补缺（补位票不在当日抓取名单 ⇒ 库里根本没有那一天的行）：
    //   上面 hydrateStockHistoryRow 只认 market_metrics 云端表，缺行 = 永远补不到（时代万恒 10-20 实证）。
    //   这里把水合后【仍双缺】的日子交给 Logic 层：K 线补 竞价涨幅/涨幅/昨日成交量 + 当日快照补竞价量。
    //   ⛔ 只把补缺值合并进 trendHistory（展示层），不写 _auctionMemCache、不写云端（§6 不产生影子真相）。
    //   ⚠️ 库里已有值的字段一律不覆盖（合并时只填 null 位，§6 不用同花顺冒充库内真相）。
    {
        const reqDate2 = uiStore.currentDate;
        const hist2 = getAuctionStockHistory(name, reqDate2, 5, 'auction');
        // [TREND-PATCH-STORE 2026-10-23] 判据改为「四腿任一缺」（见 _trendNeedsPatch 注释），
        //   否则「当天行只有涨幅、没有量/竞价涨幅」的半残行永远不会走补缺。
        const missing = hist2.filter(_trendNeedsPatch).map(h => h.date);
        // [TREND-PATCH-STORE 2026-10-23] 代码兜底：行对象自带 code 优先，其次云端股票代码表。
        //   补位行是注入壳（不在 auction_watchlist 里），只认 getStockCode 时一旦代码表未加载完成
        //   就会拿到空串 ⇒ 整个补缺被 if 静默跳过 ⇒ 当天全空且没有任何报错（§10 禁止静默）。
        const rowItem = (viewData.value.items || []).find(it => it && it.stock && String(it.stock).trim() === name);
        const code = (rowItem && rowItem.code ? String(rowItem.code).trim() : '') || getStockCode(name);
        if (missing.length > 0 && !code) {
            _dbgLog('[TREND-PATCH] ' + name + ' 取不到股票代码（stockcodemap 未命中）⇒ 当天趋势无法补缺，请补代码');
        }
        if (missing.length > 0 && code) {
            const m = new Map();
            m.set(name, missing);
            ensureTrendPatch([{ stock: name, code: code }], m, {})
                .then(function(patchByYmd) {
                    const byYmd = patchByYmd && patchByYmd.get(name);
                    if (!byYmd) return;
                    // 日期已切走 ⇒ 补缺结果作废（竞态保护，与上方 seal 腿同款）
                    if (uiStore.currentDate !== reqDate2) return;
                    // [TREND-PATCH-STORE 2026-10-23] 先落补缺仓库，再重画：
                    //   ⛔ 不能像以前那样只把 merge 结果交给一次 paint —— 后面封单量腿还会
                    //   paint 一次【原始 history】，会把这里的结果整片擦掉（今天的报障就是这个）。
                    _putTrendPatch(name, byYmd);
                    paint(getAuctionStockHistory(name, reqDate2, 5, 'auction'));
                })
                .catch(function(e) {
                    // §10：补缺失败只留痕（趋势图保持原样 = 该日「--」），⛔ 不连坐主流程
                    _dbgLog('[TREND-PATCH] ' + name + ' 趋势兜底补缺失败: ' + (e && e.message || e));
                });
        }
    }
    // [SEAL-VOLUME 2026-10-11] 封单量腿：先把这几天读进 limit_pool 内存缓存，再补画一次。
    //   ⚠️ 只在【确实缺这一天】时才打库并重画 —— 窗口缓存命中的常见情形 = 完全不做事（§32）。
    //   ⚠️ 读失败只记日志：封单量那张图自然不出现，⛔ 不连坐上面五张图（辅助指标失败不打断主流程，§10）。
    const sealDates = history.map(h => h.date);
    if (sealDates.length > 0 && sealDates.some(d => !hasLimitPoolDay(d))) {
        const reqDate = uiStore.currentDate;
        ensureLimitPoolDays(sealDates)
            .then(function() {
                // 日期已切走 ⇒ 不要拿旧窗口的数据画到新日期的面板上
                if (uiStore.currentDate !== reqDate) return;
                paint(getAuctionStockHistory(name, uiStore.currentDate, 5, 'auction'));
            })
            .catch(function(e) {
                _dbgLog('[SEAL-VOLUME] 展开趋势时读 limit_pool 失败：' + ((e && e.message) || e));
            });
    }
  }

  // 当日竞价指标（仅市场客观值，不进历史趋势）：未匹配量/抢筹幅度/竞价量比/真换手率
  function dailyAuctionMetrics(stockName) {
    const date = uiStore.currentDate;
    const umVol = getStockHistoryValue(date, stockName, 'umVol');          // 万手，显示如 251w
    const openBidPct = getStockHistoryValue(date, stockName, 'openBidPct'); // 百分比数值，如 0.57
    const aucVolRatio = getStockHistoryValue(date, stockName, 'aucVolRatio'); // 量比，如 2.18
    const aucTurnover = getStockHistoryValue(date, stockName, 'aucTurnover'); // 百分比数值，如 3.21
    return {
      umVol: umVol != null && umVol !== '' ? (umVol + 'w') : null,
      openBidPct: openBidPct != null && openBidPct !== '' ? (openBidPct + '%') : null,
      aucVolRatio: aucVolRatio != null && aucVolRatio !== '' ? String(aucVolRatio) : null,
      aucTurnover: aucTurnover != null && aucTurnover !== '' ? (aucTurnover + '%') : null
    };
  }

  // 10 日区间涨幅展示文案：带符号两位小数；有效交易日不足 10 天时补 (n/10日)，便于核对数据准确性。
  function formatRangePct(range) {
    if (!range || range.pct === null || range.pct === undefined || isNaN(range.pct)) return '';
    const txt = (range.pct >= 0 ? '+' : '') + Number(range.pct).toFixed(2) + '%';
    const days = Number(range.days);
    if (days > 0 && days < DRAGON_RANGE_DAYS) return txt + '(' + days + '/' + DRAGON_RANGE_DAYS + '日)';
    return txt;
  }

  function dailyMetricsList(stockName) {
    if (!stockName) return [];
    const m = dailyAuctionMetrics(stockName.trim());
    const list = [];
    if (m.umVol != null) list.push({ label: '未匹配量', value: m.umVol });
    // [DRAGON 2026-09-09] 展开面板「第二行第二个」= 近 10 个交易日区间涨幅，用于核对龙头排名的原始数据。
    // 读 Logic 层异步缓存（模块级 ref → 数据到位后自动驱动该行重渲染）；
    // 未加载/无数据 → 该项直接不出现，绝不显示 0 或 '-' 伪装成"涨幅为 0"（§10 禁止静默误导）。
    const rangePctText = formatRangePct(getStockRangePct(uiStore.currentDate, stockName));
    if (rangePctText) list.push({ label: '10日涨幅', value: rangePctText });
    if (m.openBidPct != null) list.push({ label: '抢筹幅度', value: m.openBidPct });
    if (m.aucVolRatio != null) list.push({ label: '竞价量比', value: m.aucVolRatio });
    if (m.aucTurnover != null) list.push({ label: '真换手率', value: m.aucTurnover });
    return list;
  }

  function switchPage(page) {
    if (page < 0 || page > 3) return;
    currentPage.value = page;
    // [FIX 2026-08-16] 页面切换即重置序号双击防抖与收起悬浮 toast：
    //  - 防抖：切页后立刻点序号不应被上一次点击的 300ms 窗口误吞（§24/§25 页面生命周期整洁）
    //  - toast：position:fixed 悬浮在页面根，切页后若不收起会盖住第一页序号列，点击序号变成点 toast（"展不开"）
    _lastExpandClickTs = 0;
    _lastExpandStock = '';
    closeNotePopup();
  }
  function onSwipeStart(e) {
    if (e.touches) { swipeStartX = e.touches[0].clientX; swipeStartY = e.touches[0].clientY; }
    else { swipeStartX = e.clientX; swipeStartY = e.clientY; }
  }
  function onSwipeEnd(e) {
    if (e.changedTouches) { swipeEndX = e.changedTouches[0].clientX; swipeEndY = e.changedTouches[0].clientY; }
    else { swipeEndX = e.clientX; swipeEndY = e.clientY; }
    handleSwipe();
  }
  function handleSwipe() {
    const dx = Math.abs(swipeStartX - swipeEndX);
    const dy = Math.abs(swipeStartY - swipeEndY);
    const threshold = 50;
    // 仅当水平位移明显大于垂直位移时才视为左右滑动翻页,
    // 避免用户上下滑动时因手抖水平偏移而误切到空白页。
    if (dx < threshold || dx <= dy) return;
    const diff = swipeStartX - swipeEndX;
    if (diff > threshold && currentPage.value < 3) switchPage(currentPage.value + 1);
    else if (diff < -threshold && currentPage.value > 0) switchPage(currentPage.value - 1);
  }

  const backendLoading = ref(false);
  function runBackend(fn, ...args) {
    if (backendLoading.value) return;
    const task = typeof fn === 'function' ? fn : null;
    if (!task) return;
    backendLoading.value = true;
    const statusKey = 'thsApiStatus';
    try {
      const result = task(...args);
      if (result && typeof result.then === 'function') {
        result
          .then((msg) => { refresh(); showToast(msg || '后台操作完成'); })
          .catch(e => { console.error('后台操作失败:', e); showToast('操作失败: ' + (e && e.message)); })
          .finally(() => { backendLoading.value = false; });
      } else {
        refresh();
        backendLoading.value = false;
      }
    } catch (e) {
      console.error('后台操作失败:', e);
      showToast('操作失败: ' + (e && e.message));
      backendLoading.value = false;
    }
  }
  function onImportPaste() {
    const text = prompt('粘贴竞价数据（CSV/JSON格式）：');
    if (!text) return;
    runBackend(importAuctionFromPaste, text);
  }
  function onReplaceConcept() {
    const text = prompt('粘贴题材替换数据：');
    if (!text) return;
    runBackend(replaceConceptFromPaste, text);
  }
  function onHistoryFill() {
    const text = prompt('粘贴历史填充数据：');
    if (!text) return;
    const date = prompt('目标日期（YYYY-MM-DD）：', uiStore.currentDate);
    if (!date) return;
    runBackend(importAuctionHistoryFill, text, date);
  }


  function onToggleSelect(index) {
    const auctionList = getTodayGroupList('auction');
    if (auctionList[index]) {
      const _stockName = auctionList[index].stock ? auctionList[index].stock.trim() : '';
      const _ts = deriveAuctionTagState(_stockName, uiStore.currentDate);
      if (_ts.sold || _ts.bought || _ts.selected) {
        return;
      }
      auctionList[index].selected = !auctionList[index].selected;
      saveData();
      refresh();
    }
  }

  // [FIX 2026-08-16] 交互重构：竞价量双击编辑涨幅题材 / 昨成交量单击黑色toast / 双击后台。
  // 原 onShowNote（双击股票名 prompt）已移除——改为竞价量列双击弹 Vue EditModal（§4 不用原生 prompt）。
  const volumeNoteModalActive = ref(false);
  const volumeNoteDraft = ref('');
  let volumeNoteIndex = -1;

  // [FIX 2026-08-16] 题材补全（toast 与编辑框共用）：行内 topics 为空时（早盘竞价行只存涨幅、
  // §P1-6：_normalizeNotePunct / _buildFullNoteWithTopics 已迁至 ../composables/auction-board-helpers.js（同名 import）。
  // 题材在共享题材库 stock_topics），回退查 getStockHistoryTopics——与第二页题材分组 getTopicsDisplay 同口径。
  // 输出统一英文标点：-2.6%(机器人,人工智能,AI应用)

  function onEditVolumeNote(index) {
    volumeNoteIndex = index;
    const auctionList = getTodayGroupList('auction');
    const rawNote = auctionList[index] ? getDisplayNote(auctionList[index]) : '';
    // 编辑框内容与黑色 toast 同步：补全题材、统一英文标点（双向同步：保存后 toast 也显示同一格式）
    volumeNoteDraft.value = _buildFullNoteWithTopics(auctionList[index], rawNote);
    volumeNoteModalActive.value = true;
  }

  // [FIX 2026-09-18] 题材编辑写入口径重构（修「删了又恢复 / 涨跌停不同步 / 历史未来日期不生效」）。
  //
  // 唯一真相：跨看板共享题材库 stock_topics（§6）。三条读取路径都汇到这里：
  //   · 早盘竞价看板第二页        → item.topics，缺省回退 getStockHistoryTopics
  //   · 涨跌停看板 limit-pool.js  → getStockHistoryTopics(121 行)
  //   · 竞价一字看板 yizi-board.js → getStockHistoryTopics(134 行)
  // ⇒ 只要共享库写对了，三个看板同时正确；共享库没写对，改本地怎么改都是白改。
  //
  // 三步（顺序不许颠倒）：
  //   ① 写共享库（replace 语义，可真删）—— 失败即整体失败：回滚本地显示 + toast 报错（§10）。
  //      旧实现是 merge 语义（物理上删不掉，见 stock-topics.js 顶部事故说明）＋ .catch(console.warn)
  //      静默吞错，双重致命：删了等于没删，且失败时界面还显示成功。
  //   ② 把新题材铺到【所有出现过该股票的日期】的 topics 列（历史 + 当前 + 未来），
  //      满足「不管历史日期还是未来日期都按最终修改显示」——
  //      历史日期的 note 里可能内嵌旧题材，但 getDisplayNote 在 topics 非空时优先用 topics 字段，
  //      所以只覆盖 topics 列即可让显示与分组同步跟上。
  //      ⚠️ 这些日期【只写 topics 列】：绝不写 note / change_pct。
  //      历史日期的 change_pct 是当日真实竞价涨幅，写它会直接污染十日涨幅等派生指标（§M 红线）。
  //   ③ 当前日期额外写 note/change_pct（用户编辑的就是这一天的显示内容）。
  async function _persistVolumeNote(normalizedNote) {
    if (volumeNoteIndex < 0) return;
    const auctionList = getTodayGroupList('auction');
    const item = auctionList[volumeNoteIndex];
    if (!item) return;
    const stockName = item.stock;
    const parsed = parseNoteToFields(normalizedNote);
    const topicsArr = extractTopics(normalizedNote);
    const topicsStr = topicsArr.join(',');

    // 旧值快照：云端写失败时回滚本地显示，避免留下「界面已改、云端没改」的假成功（§10）
    const prev = { note: item.note, changePct: item.changePct, topics: item.topics };

    // 先落本地：即时反馈（云端确认后再定稿；失败则回滚）
    item.note = normalizedNote;
    item.changePct = parsed.changePct;
    item.topics = parsed.topics;
    saveData();
    refresh();

    // ── ① 写共享题材库（replace：本次传入即最终结果，可真删题材）──────────────────
    const stockCode = getStockCode(stockName) || item.code || '';
    try {
      const res = await pushStockTopicsToCloud(stockName, topicsArr, stockCode, { mode: 'replace' });
      if (res && res.skipped === 'empty-topics-guard') {
        showWarningToast('⚠️ 题材已清空，但未写入共享题材库：共享库不允许整只清空（会影响三个看板与全部历史日期）。', 6000);
      }
    } catch (e) {
      item.note = prev.note;
      item.changePct = prev.changePct;
      item.topics = prev.topics;
      saveData();
      refresh();
      console.error('[TOPIC-SAVE] 共享题材库写入失败:', e);
      showWarningToast('❌ 题材保存失败，已回滚显示：' + (e && e.message ? e.message : '未知错误'), 8000);
      return;
    }

    // ── ② 铺到所有「行内自带题材」的日期（只写 topics 列）────────────────────────
    // 题材被清空时不铺（避免把其它日期的题材一起抹掉；共享库也有同样的空值护栏）
    if (topicsArr.length > 0) {
      await _syncTopicsAcrossDates(stockName, topicsStr);
    }

    // ── ③ 当前日期额外写 note + change_pct ────────────────────────────────
    try {
      const r = await patchAuctionField(uiStore.currentDate, stockName, {
        note: normalizedNote,
        change_pct: parsed.changePct,
        topics: parsed.topics
      });
      if (r && r.ok === false) throw (r.error || new Error('patch 返回失败'));
    } catch (e) {
      console.error('[TOPIC-SAVE] 当日备注同步云端失败:', e);
      showWarningToast('⚠️ 当日备注同步云端失败：' + (e && e.message ? e.message : '未知错误'), 6000);
    }

    syncStockCloseFromAuction(stockName, normalizedNote, uiStore.currentDate);
    syncStockTopicsFromAuction(uiStore.currentDate);
    saveModule('stocks');
    showToast('✅ 题材已保存并同步到三个看板');
  }

  // 把某只股票的题材写进【其它日期】的 topics 列（跨日期单一真相的落地动作）。
  //
  // 只挑「该日期该行本来就带题材」且「题材内容确实不同」的日期，理由三条：
  //   ① 显示口径：行内 topics 非空时 getDisplayNote 优先用它（不回退共享库）⇒ 不覆盖就显示旧题材；
  //      行内 topics 为空的行（影子行 / 无题材行）显示本就会回退共享库，
  //      而共享库已在第 ① 步改好 ⇒ 无需、也不该再给这些行发写请求。
  //      实测依据：09-18 的「桂林旅游」就是影子行（`[AUCTION-DEBUG] …桂林旅游[shadow]`），
  //      而 patchAuctionFieldBatch 对非正式成员【不写 watchlist 字段】，发了也是空转。
  //   ② 性能：不筛的话要对内存里 20~30 个日期各发一次请求；筛完通常只剩个位数。
  //   ③ 安全：只写 topics 列，绝不触碰 note / change_pct ——
  //      历史日期的 change_pct 是当日真实竞价涨幅，写它会污染十日涨幅等派生指标（§M 红线）。
  //
  // @param {string} stockName
  // @param {string} topicsStr 目标题材（英文逗号分隔）
  async function _syncTopicsAcrossDates(stockName, topicsStr) {
    const nameTrim = stockName ? String(stockName).trim() : '';
    if (!nameTrim) return;
    const curDate = uiStore.currentDate;
    // 归一化成「去重 + 排序」再比较，避免仅顺序不同就误判为需要改写
    const normKey = function (s) {
      return Array.from(new Set(String(s || '').split(/[+，,，、;；]/).map(function (t) { return t.trim(); }).filter(function (t) { return t; })))
        .sort().join('|');
    };
    const targetKey = normKey(topicsStr);
    if (!targetKey) return;
    const allData = getAuctionData() || {};
    const dates = Object.keys(allData).filter(function (d) {
      if (d === curDate) return false;   // 当前日期由第 ③ 步一并写 note/change_pct，不重复发
      const row = (allData[d] || []).find(function (r) {
        return r && r.stock && r.stock.trim() === nameTrim;
      });
      if (!row) return false;
      const curKey = normKey(row.topics);
      return curKey !== '' && curKey !== targetKey;
    });
    if (dates.length === 0) return;
    // patchAuctionFieldBatch 内部把错误收成 {ok:false,error} 而不抛出，两条路都要接住
    const results = await Promise.all(dates.map(function (d) {
      return patchAuctionFieldBatch(d, [{ stock: nameTrim, topics: topicsStr }])
        .then(function (r) { return { date: d, ok: !(r && r.ok === false), error: r && r.error }; })
        .catch(function (e) { return { date: d, ok: false, error: e }; });
    }));
    const failed = results.filter(function (r) { return !r.ok; });
    if (failed.length > 0) {
      console.error('[TOPIC-SAVE] 部分日期题材同步失败:', failed);
      showWarningToast('⚠️ ' + failed.length + '/' + dates.length + ' 个日期的题材同步失败（当前日期已保存）', 6000);
    }
  }


  async function saveVolumeNote() {
    // [FIX 2026-08-16] 保存统一英文标点（与 toast/第二页格式一致：-2.6%(机器人,人工智能,AI应用)）
    const normalizedNote = _normalizeNotePunct(volumeNoteDraft.value || '');
    _persistVolumeNote(normalizedNote);
    volumeNoteModalActive.value = false;
    volumeNoteIndex = -1;
  }

  async function clearVolumeNote() {
    _persistVolumeNote('');
    volumeNoteModalActive.value = false;
    volumeNoteIndex = -1;
  }

  // 昨成交量单击 → 黑色小 toast（贴数值下方，点击/滚动关闭）
  const notePopup = ref(false);
  const notePopupText = ref('');
  const notePopupStyle = ref({});
  let notePopupScrollCleanup = null;

  function onYestClick(item, event) {
    if (!item) return;
    // [FIX 2026-08-16] 与编辑框同一口径：统一英文标点 + 题材补全（共享 _buildFullNoteWithTopics）
    const note = _buildFullNoteWithTopics(item, getDisplayNote(item));
    if (!note.trim()) return;
    // 已显示同一行 → 点击关闭（切换）
    if (notePopup.value && notePopupText.value === note) { closeNotePopup(); return; }
    const el = event && event.currentTarget;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    notePopupText.value = note;
    // [FIX 2026-08-16] 居中：left 指向元素水平中心 + translateX(-50%) 自动按内容宽度居中，无需先量宽
    notePopupStyle.value = {
      left: (rect.left + rect.width / 2) + 'px',
      top: (rect.bottom + 6) + 'px',
      position: 'fixed',
      transform: 'translateX(-50%)',
      maxWidth: '240px'
    };
    notePopup.value = true;
    // 滚动关闭（捕获阶段，看板滚动即收起）
    if (!notePopupScrollCleanup) {
      const handler = function() { closeNotePopup(); };
      document.addEventListener('scroll', handler, true);
      notePopupScrollCleanup = function() { document.removeEventListener('scroll', handler, true); notePopupScrollCleanup = null; };
    }
  }

  function closeNotePopup() {
    notePopup.value = false;
    notePopupText.value = '';
    if (notePopupScrollCleanup) { notePopupScrollCleanup(); }
  }

  // [FIX 2026-08-16] 序号双击防抖：双击会触发两次 click（展开→收起），用户误以为"被冻住"。
  // 300ms 内的「同一只股票」第二次点击忽略（浏览器 dblclick 的两击间隔 ~250ms），保证双击序号稳定展开趋势图；
  // 不同股票快速点击互不影响（按股票名分别防抖，杜绝"点A行后300ms内点B行没反应"）。
  // [FIX 2026-08-17] key 从位置 index 改为股票名：viewData 重算导致 index 漂移时，
  // 旧闭包携带旧 index 会 find 落空 → 序号"展不开"；股票名稳定，点击即命中（§17/§23 稳定渲染）。
  let _lastExpandClickTs = 0;
  let _lastExpandStock = '';
  function onExpandTrend(stockName) {
    const name = (stockName || '').trim();
    if (!name) return;
    const now = Date.now();
    if (name === _lastExpandStock && now - _lastExpandClickTs < 300) return;
    _lastExpandClickTs = now;
    _lastExpandStock = name;
    const newSet = new Set(expandedSet.value);
    if (newSet.has(name)) {
      newSet.delete(name);
      const newHistory = { ...trendHistory.value };
      delete newHistory[name];
      trendHistory.value = newHistory;
    } else {
      newSet.add(name);
      const item = viewData.value.items.find(it => it.stock && it.stock.trim() === name);
      if (item && item.stock) loadTrendHistory(name);
      // 展开即按需补齐「10日涨幅」（云端 stock_range_pct 命中 → 0 猫抓额度）。
      // 失败不阻塞展开，只提示（§10 禁止静默失败）。
      ensureDragonOnExpand();
    }
    expandedSet.value = newSet;
  }

  // 展开面板要显示 10 日涨幅，故无论题材 toggle 是否开启都按需加载一次；
  // 已加载（同日期）直接返回，不产生任何请求；单飞保证并发只发一次。
  function ensureDragonOnExpand() {
    const d = uiStore.currentDate;
    if (!d || getDragonRangePct(d)) return;
    ensureDragonRangePct(d).catch(function(e) {
      console.warn('[DRAGON] 展开加载 10 日涨幅失败:', e && e.message);
    });
  }

  function startLongPress(stockName) {
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      onLongPress(stockName);
    }, 500);
  }
  function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }
  function onLongPress(stockName) {
    cancelLongPress();
    if (stockName && longPressMenuRef.value) {
      longPressMenuRef.value.open(stockName);
    }
  }

  // A3-03：日期切换只用一个 watch 统一处理（清空展开/趋势缓存 + 准备数据 + 刷新），避免重复触发
  watch(() => uiStore.currentDate, (v) => {
    expandedSet.value = new Set();
    trendHistory.value = {};
    trendPatchStore.value = {};   // [TREND-PATCH-STORE 2026-10-23] 补缺仓库与趋势缓存同生命周期
    if (v) prepareAuctionData(v);
    refresh();
  });

  onMounted(() => {
    if (uiStore.currentDate) prepareAuctionData(uiStore.currentDate);
    refresh();
    loadCopiedStocks();
    _on('auction-refresh', onAuctionRefresh);
    // [SEAL-VOLUME 2026-10-11] limit_pool 变化（15:40 抓取端写入 / 他端写库）→ 重新确保封单量窗口。
    _on('data:realtime-update', _onLimitPoolRealtime);
  });
  onUnmounted(() => {
    cancelLongPress();
    _off('auction-refresh', onAuctionRefresh);
    // [SEAL-VOLUME 2026-10-11] 与 _on 成对注销（§31 生命周期，⛔ 不留给下一个页面）
    _off('data:realtime-update', _onLimitPoolRealtime);
    // [CLOSE-COVER] 清理跨门槛轮询，避免组件卸载后定时器泄漏（§31 生命周期）
    if (_closeCoverTimer) {
      clearInterval(_closeCoverTimer);
      _closeCoverTimer = null;
      _closeCoverBound = false;
    }
  });

  /**
   * [SEAL-VOLUME 2026-10-11] limit_pool 实时变化 → 重新确保封单量窗口。
   * ⚠️ 严格按 boards === 'limitpool' 过滤：别的看板的实时事件与本看板无关，
   *    ⛔ 不能让它们触发本看板的读库（§32）。
   * （Data 层在 emit 之前已作废该日的内存缓存，所以这里的 ensure 会真的重读那一天。）
   */
  function _onLimitPoolRealtime(ev) {
    if (!ev || ev.boards !== 'limitpool') return;
    _ensureSealWindow();
  }

  function onAuctionRefresh() {
    if (uiStore.currentDate) prepareAuctionData(uiStore.currentDate);
    refresh();
    // [SUSPEND 2026-10-13] 刷新事件顺带重判一次停牌：行数没变时上面的 watch 不会触发，
    // 但上游可能刚补出竞价终态（页面在 9:25 前打开的场景）→ 这里补一次
    // （suspend.js 内部有 3 分钟 TTL 节流 + 单飞，重复调用代价可控）。
    ensureSuspendForCurrentBoard();
    // [FIX 2026-08-17] 数据刷新后重算「已展开」的趋势图：获取涨幅/导入等操作后
    // renderAuction() 只刷新表格，trendHistory 是独立缓存，已展开的图会停留在旧快照
    // （表现为"提示成功但趋势图当天没更新"）。这里只重算当前已展开的股票，不重置展开状态。
    const expandedStocks = Array.from(expandedSet.value || []);
    expandedStocks.forEach(function(name) {
      if (name && trendHistory.value[name]) loadTrendHistory(name);
    });
  }

  return {
    uiStore,
    auctionStore,
    sortState,
    expandedSet,
    trendHistory,
    longPressMenuRef,
    coreTopicModalRef,
    editModalRef,
    viewData,
    currentPage,
    showBackend,
    expanded,
    topicGroups,
    itemsByIndex,
    obsItems,
    regularItems,
    dragonItems,
    allItems,
    searchActive,
    searchKeyword,
    headerSearchActive,
    highlightStockSet,
    filteredItems,
    filteredObsItems,
    filteredRegularItems,
    filteredDragonItems,
    filteredRange20LeaderItems,
    showObsSeparator,
    showDragonSeparator,
    sortState2,
    isStrengthSortEnabled,
    p2ExpandedSet,
    p2TrendHistory,
    p2ExpandedTopics,
    p2ExpandAll,
    p2StockTopicCount,
    p2HighRatioInfo,
    p2JingYestSet,
    p2ParallelSet,
    p2JingYestCount,
    p2HighRatioCount,
    sortedTopicGroups,
    page3Data,
    copiedStocks,
    page4DisplayStocks,
    backendLoading,
    volumeNoteModalActive,
    volumeNoteDraft,
    notePopup,
    notePopupText,
    notePopupStyle,
    toggleBoard,
    getStockStyle,
    getTopicRowClass,
    toggleSort2,
    toggleStrengthSort,
    toggleGroupExpand,
    p2ToggleExpandAll,
    loadP2TrendHistory,
    loadP2TrendHistoryChunked,
    toggleP2Trend,
    getLastNTradingDays,
    loadCopiedStocks,
    saveCopiedStocks,
    copyAllTopicStocks,
    copyTopicStocks,
    deleteCopiedStock,
    clearAllCopiedStocks,
    openBackend,
    openEditModal,
    openCoreTopicModal,
    onHeaderClick,
    onHeaderDblClick,
    refresh,
    toggleSort,
    // [TWO-MODES 2026-10-02] 题材 / 一字两个 toggle 的唯一入口（互斥；口径见 topic-sort.js）
    toggleTopicOrder,
    // 两个题材 toggle 的勾选态（§21：模板只读，不做比较）
    yiziToggleOn,
    topicToggleOn,
    expandAll,
    collapseAll,
    _computeTrendStats,
    loadTrendHistory,
    dailyAuctionMetrics,
    dailyMetricsList,
    switchPage,
    onSwipeStart,
    onSwipeEnd,
    handleSwipe,
    runBackend,
    onImportPaste,
    onReplaceConcept,
    onHistoryFill,
    onToggleSelect,
    onEditVolumeNote,
    _persistVolumeNote,
    saveVolumeNote,
    clearVolumeNote,
    onYestClick,
    closeNotePopup,
    onExpandTrend,
    startLongPress,
    cancelLongPress,
    onLongPress,
    onAuctionRefresh,
    // 后台按钮直接调用的数据拉取函数（模板通过 runBackend 透传）
    fetchLadderConstituentsMain,
    fillYesterdayVolumeFromThs,
    fillTodayYesterdayVolumeFromThs,
    fillYesterdayYesterdayVolumeFromThs,
    fetchChangePctFromThs,
    fetchTodayAuctionFromNumcat,
    fetchAllAuctionFromNumcat,
    fetchThreeDaysAuctionFromNumcat,
    fillTopicsFromNumcat,
    fetchDragonRangeFromNumcat
  };
}
