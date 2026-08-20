// §P1-7 组合式逻辑抽取（源自 src/views/AuctionBoard.vue 的 <script setup>）。
// 纯物理重组：状态/计算属性/方法/生命周期原样搬移，行为完全等价。
// 组件模板通过 useAuctionBoard() 取得同一实例，并 provide/inject 给子组件共享。
// 受保护契约 refresh / toggleSort / expandAll / collapseAll 由根组件 defineExpose 透传。
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { saveData, getTodayGroupList, getGroupData, patchAuctionField, saveModule,
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
import { getTopicGroups, getTopicRankCountThisWeek } from '../logic/topic/rules.js';
import { getDisplayNote, parseNoteToFields, extractTopics } from '../logic/note/helpers.js';
import { getPreviousTradingDay, isTradingDay } from '../logic/date/trading-day-helpers.js';
import { getHighRatioStocksForDate, getJingYestHighlightSetForDate, getParallelStocksForDate } from '../logic/auction/sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../logic/auction/stock-sync.js';
import { getStockCode } from '../data/stock-code-map.js';
import { pushStockTopicsToCloud } from '../data/stock-topics.js';
import { prepareAuctionData } from '../logic/auction/view-helpers.js';
import { computeAuctionViewDataIncremental } from '../logic/auction/incremental-view.js';
import { showToast } from '../composables/useToast.js';
import { apiStatusMap } from '../logic/ui-bridge.js';
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

export function useAuctionBoard() {
  const uiStore = useUiStore();
  const auctionStore = useAuctionStore();


  const sortState = reactive({
    byData: false,
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
    void sortState.byData; void sortState.byRatio; void sortState.byParallel;
    void sortState.byJingYest; void sortState.byJingYestRatio; void sortState.byThreeDayJingDie; void sortState.byTopic;
    // A3-01：经增量行缓存层，单格编辑只重新派生变化的行（logic/auction/incremental-view.js）
    return computeAuctionViewDataIncremental('auction', sortState);
  });

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
  const regularItems = computed(() => {
    if (!viewData.value.regularIndices) return [];
    const m = itemsByIndex.value;
    return viewData.value.regularIndices.map(i => m.get(i)).filter(Boolean);
  });
  const allItems = computed(() => {
    return [...obsItems.value, ...regularItems.value];
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
        if (group.topic === '其它' || group.topic === '并购重组') return;
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
      if (key === 'byData') {
        sortState.byRatio = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byRatio') {
        sortState.byData = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byParallel') {
        sortState.byData = false; sortState.byRatio = false;
        sortState.byThreeDayJingDie = false;
      } else if (key === 'byJingYest') {
        sortState.byData = false; sortState.byRatio = false;
        sortState.byJingYestRatio = false; sortState.byThreeDayJingDie = false;
        sortState.byParallel = true;
      } else if (key === 'byJingYestRatio') {
        sortState.byData = false; sortState.byRatio = false; sortState.byParallel = false;
        sortState.byJingYest = false; sortState.byThreeDayJingDie = false;
      } else if (key === 'byThreeDayJingDie') {
        sortState.byData = false; sortState.byRatio = false; sortState.byParallel = false;
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
      s.byData = sortState.byData;
      s.byRatio = sortState.byRatio;
      s.byParallel = sortState.byParallel;
      s.byJingYest = sortState.byJingYest;
      s.byJingYestRatio = sortState.byJingYestRatio;
      s.byThreeDayJingDie = sortState.byThreeDayJingDie;
      s.byTopic = sortState.byTopic;
    }
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
    // 再按需补齐缺失的历史交易日（market_metrics 云端），补齐后重算刷新趋势图，使 5 日数据完整
    let hydrated = false;
    for (const h of history) {
      const ok = await hydrateStockHistoryRow(h.date, name, 'auction');
      if (ok) hydrated = true;
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

  function dailyMetricsList(stockName) {
    if (!stockName) return [];
    const m = dailyAuctionMetrics(stockName.trim());
    const list = [];
    if (m.umVol != null) list.push({ label: '未匹配量', value: m.umVol });
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

  function _persistVolumeNote(normalizedNote) {
    if (volumeNoteIndex < 0) return;
    const auctionList = getTodayGroupList('auction');
    const item = auctionList[volumeNoteIndex];
    if (!item) return;
    item.note = normalizedNote;
    const parsed = parseNoteToFields(normalizedNote);
    item.changePct = parsed.changePct;
    item.topics = parsed.topics;
    saveData();
    refresh();

    patchAuctionField(uiStore.currentDate, item.stock, {
      note: normalizedNote,
      change_pct: parsed.changePct,
      topics: parsed.topics
    }).catch(e => console.warn('patchAuctionField note 失败:', e));

    const stockName = item.stock;
    syncStockCloseFromAuction(stockName, normalizedNote, uiStore.currentDate);

    const topicsArr = extractTopics(normalizedNote);
    const stockCode = getStockCode(stockName) || item.code || '';
    pushStockTopicsToCloud(stockName, topicsArr, stockCode).catch(e => console.warn('pushStockTopicsToCloud 失败:', e));

    syncStockTopicsFromAuction(uiStore.currentDate);
    saveModule('stocks');
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
    }
    expandedSet.value = newSet;
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
    allItems,
    searchActive,
    searchKeyword,
    headerSearchActive,
    highlightStockSet,
    filteredItems,
    filteredObsItems,
    filteredRegularItems,
    showObsSeparator,
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
    fillTopicsFromNumcat
  };
}
