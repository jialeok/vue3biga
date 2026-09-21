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
import { loadWeakStrongSet, weakStrongSetRef } from '../logic/auction/sort-rules-extra.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../logic/auction/stock-sync.js';
import { getStockCode } from '../data/stock-code-map.js';
// [HIGH-LIMIT-BOARD 2026-09-21] 第二页题材列表的浅灰删除线：板块判定只用 Logic 层这一份（§6）
import { isHighLimitBoard } from '../logic/auction/limit-up.js';
import { pushStockTopicsToCloud } from '../data/stock-topics.js';
import { prepareAuctionData } from '../logic/auction/view-helpers.js';
import { computeAuctionViewDataIncremental } from '../logic/auction/incremental-view.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { apiStatusMap, setApiStatus } from '../logic/ui-bridge.js';
import { setBtnLoading } from '../logic/shared/core-shared.js';
// [DRAGON 2026-09-09] 题材龙头：10 日区间涨幅异步加载 + 龙头排名（Logic 层模块）
import { ensureDragonRangePct, getDragonRangePct, getStockRangePct, DRAGON_RANGE_DAYS, invalidateDragonRange } from '../logic/auction/dragon-rank.js';
// [DRAGON-GROUP 2026-09-14] 龙头组：名册异步加载（展示日读 D-1 名册；条件满足时评选并落库当日名册）。
// 唯一入口 ensureDragonGroup 内含单飞 + 会话幂等 + 收盘口径闸门，重复调用零副作用。
import { ensureDragonGroup } from '../logic/auction/dragon-group.js';
// [CLOSE-COVER 2026-09-10] 收盘后自动用【收盘涨幅】覆盖 9:25 竞价涨幅（此前该闭环只存在于
// 从未执行过的 pg_cron，导致当天 change_pct 全天停留在竞价值）。
import { ensureClosePctCovered, isCloseCoverWindow } from '../logic/auction/close-pct-cover.js';
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

// [WEAK-STRONG 2026-09-01] 弱转强集合异步加载 watch 仅挂载一次（useAuctionBoard 可能被多组件调用）。
let _wsWatchBound = false;
// [DRAGON 2026-09-09] 龙头区间涨幅 watch 同理只挂载一次。
let _dragonWatchBound = false;
// [CLOSE-COVER 2026-09-10] 收盘覆盖 watch 与跨门槛轮询同样只挂载一次。
let _closeCoverBound = false;
let _closeCoverTimer = null;
/** 收盘覆盖轮询间隔：5 分钟（页面长时间开着时，跨过 15:00 能自动触发一次，无需手动刷新） */
const CLOSE_COVER_POLL_MS = 5 * 60 * 1000;

export function useAuctionBoard() {
  const uiStore = useUiStore();
  const auctionStore = useAuctionStore();


  const sortState = reactive({
    byWeakStrong: false,
    byRatio: false,
    byParallel: false,
    byJingYest: false,
    byJingYestRatio: false,
    byThreeDayJingDie: false,
    byTopic: false
  });
  const expandedSet = ref(new Set());
  const trendHistory = ref({});
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
    void sortState.byWeakStrong; void sortState.byRatio; void sortState.byParallel;
    void sortState.byJingYest; void sortState.byJingYestRatio; void sortState.byThreeDayJingDie; void sortState.byTopic;
    // A3-01：经增量行缓存层，单格编辑只重新派生变化的行（logic/auction/incremental-view.js）
    return computeAuctionViewDataIncremental('auction', sortState);
  });

  // [WEAK-STRONG 2026-09-01] 弱转强集合异步加载：toggle 开启或日期变化时，批量拉取前 4 个交易日(T-1..T-4，不含当日快照)
  // 的 change_pct 历史写入 weakStrongSetRef（reactive ref）；viewData 依赖该 ref，自动刷新排序与高光。
  // 关闭时清空，避免陈旧数据污染其它 toggle。显式异步加载（与 loadTrendHistory 一致）替代脆弱的
  // 同步 computed 内 fire-and-forget hydrate 模式。
  if (!_wsWatchBound) {
    _wsWatchBound = true;
    watch(
      () => [sortState.byWeakStrong, uiStore.currentDate],
      async () => {
        if (sortState.byWeakStrong) {
          await loadWeakStrongSet(uiStore.currentDate, 'auction');
        } else {
          weakStrongSetRef.value = null;
        }
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
      () => [sortState.byTopic, uiStore.currentDate, (viewData.value && viewData.value.items ? viewData.value.items.length : 0)],
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

  // [DRAGON-GROUP 2026-09-14] 龙头组加载/评选的唯一入口（幂等、单飞，见 logic/auction/dragon-group.js）。
  // 读名册失败必须让用户看见（§10 禁止静默失败：不能把「读失败」显示成「今天没有龙头」）。
  function ensureDragonGroupForDate(date) {
    if (!date) return;
    ensureDragonGroup(date).catch(function(e) {
      console.warn('[DRAGON-GROUP] 龙头组加载/评选失败:', e && e.message);
      setApiStatus('numcatApiStatus', '❌ 龙头组加载失败：' + (e && e.message || e), false);
    });
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
  const sortState2 = reactive({ byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false });
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
  // §P1-6：getTopicNameStyle / getChangeClass 已迁至 ../composables/auction-board-helpers.js（同名 import）。
  function getTopicRowClass(group, stock) {
    const auctionList = getTodayGroupList('auction');
    const auctionItem = auctionList.find(it => it.stock && it.stock.trim() === (stock.stock || '').trim());
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
      if (key === 'byRatio') {
        sortState2.byParallel = false; sortState2.byJingYest = false;
        sortState2.byJingYestRatio = false; sortState2.byThreeDayJingDie = false;
      } else if (key === 'byParallel') {
        sortState2.byRatio = false; sortState2.byThreeDayJingDie = false;
      } else if (key === 'byJingYest') {
        sortState2.byRatio = false; sortState2.byJingYestRatio = false; sortState2.byThreeDayJingDie = false;
        sortState2.byParallel = true;
      } else if (key === 'byJingYestRatio') {
        sortState2.byRatio = false; sortState2.byParallel = false;
        sortState2.byJingYest = false; sortState2.byThreeDayJingDie = false;
      } else if (key === 'byThreeDayJingDie') {
        sortState2.byRatio = false; sortState2.byParallel = false;
        sortState2.byJingYest = false; sortState2.byJingYestRatio = false;
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
    const history = getAuctionStockHistory(stockName.trim(), uiStore.currentDate, 5, 'auction');
    const stats = _computeTrendStats(history);
    return {
      volume: history.map(h => ({ date: h.date, value: h.volume })),
      yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
      changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
      aucPctChg: history.map(h => ({ date: h.date, value: h.aucPctChg !== undefined ? h.aucPctChg : null })),
      ...stats
    };
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

  function refresh() {
    auctionStore.bumpDataVersion('auction');
  }

  function toggleSort(key) {
    sortState[key] = !sortState[key];
    if (sortState[key]) {
      if (key === 'byWeakStrong') {
        sortState.byRatio = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byRatio') {
        sortState.byWeakStrong = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byParallel') {
        sortState.byWeakStrong = false; sortState.byRatio = false;
        sortState.byThreeDayJingDie = false;
      } else if (key === 'byJingYest') {
        sortState.byWeakStrong = false; sortState.byRatio = false;
        sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
        sortState.byParallel = true;
      } else if (key === 'byJingYestRatio') {
        sortState.byWeakStrong = false; sortState.byRatio = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byThreeDayJingDie') {
        sortState.byWeakStrong = false; sortState.byRatio = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false;
      }
    } else {
      if (key === 'byParallel') {
        sortState.byJingYest = false; sortState.byJingYestRatio = false;
      } else if (key === 'byJingYest') {
        sortState.byParallel = false;
      }
    }
    if (auctionStore.sortState && auctionStore.sortState['auction']) {
      const s = auctionStore.sortState['auction'];
      s.byWeakStrong = sortState.byWeakStrong;
      s.byRatio = sortState.byRatio;
      s.byParallel = sortState.byParallel;
      s.byJingYest = sortState.byJingYest;
      s.byJingYestRatio = sortState.byJingYestRatio;
      s.byThreeDayJingDie = sortState.byThreeDayJingDie;
      s.byTopic = sortState.byTopic;
    }
    // [FIX 2026-09-06] 展开态不跨 toggle 保留：任何排序 toggle 的「开」或「关」动作，都把展开面板
    // 重置为收起。需求——关闭 toggle 时收起；再次打开时也必须是收起，而不是恢复上一次的展开集合。
    // 展开态是纯 UI 状态（§34），不落库、不记忆；用户手动点股票名/序号仍可随时展开（onExpandTrend），
    // 但下一次 toggle 动作又会回到默认收起。trendHistory 同步清空，避免留存已收起股票的趋势缓存。
    expandedSet.value = new Set();
    trendHistory.value = {};
    refresh();
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
        const stats = _computeTrendStats(history);
        newHistory[name] = {
          volume: history.map(h => ({ date: h.date, value: h.volume })),
          yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
          changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
          aucPctChg: history.map(h => ({ date: h.date, value: h.aucPctChg !== undefined ? h.aucPctChg : null })),
          ...stats
        };
      }
    });
    expandedSet.value = newSet;
    trendHistory.value = newHistory;
  }

  function collapseAll() {
    expandedSet.value = new Set();
    trendHistory.value = {};
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

  async function loadTrendHistory(stockName) {
    const name = (stockName || '').trim();
    if (!name) return;
    // 先用内存缓存即时出图：保证点击序号后面板立即展开（不依赖网络，根治"展开空白/像没展开"）
    const paint = (history) => {
      const stats = _computeTrendStats(history);
      trendHistory.value = {
        ...trendHistory.value,
        [name]: {
          volume: history.map(h => ({ date: h.date, value: h.volume })),
          yestVolume: history.map(h => ({ date: h.date, value: h.yestVolume })),
          changePct: history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null })),
          aucPctChg: history.map(h => ({ date: h.date, value: h.aucPctChg !== undefined ? h.aucPctChg : null })),
          ...stats
        }
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
    // 「该行 volume / change_pct 任一非空」，这里用同一口径预筛，避免为已就绪的日白建 await。
    const pending = history
        .filter(h => {
            const hasVolume = h.volume != null && String(h.volume).trim() !== '';
            const hasPct = h.changePct != null && String(h.changePct).trim() !== '';
            return !hasVolume && !hasPct;
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
    if (v) prepareAuctionData(v);
    refresh();
  });

  onMounted(() => {
    if (uiStore.currentDate) prepareAuctionData(uiStore.currentDate);
    refresh();
    loadCopiedStocks();
    _on('auction-refresh', onAuctionRefresh);
  });
  onUnmounted(() => {
    cancelLongPress();
    _off('auction-refresh', onAuctionRefresh);
    // [CLOSE-COVER] 清理跨门槛轮询，避免组件卸载后定时器泄漏（§31 生命周期）
    if (_closeCoverTimer) {
      clearInterval(_closeCoverTimer);
      _closeCoverTimer = null;
      _closeCoverBound = false;
    }
  });

  function onAuctionRefresh() {
    if (uiStore.currentDate) prepareAuctionData(uiStore.currentDate);
    refresh();
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
