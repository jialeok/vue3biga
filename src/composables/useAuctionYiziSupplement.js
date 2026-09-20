// useAuctionYiziSupplement.js — 「早盘竞价看板 · 补竞价一字（按题材融入）」的 UI 组合式（§14 UI 瘦身）
//
// 需求（2026-09-20 修正后的口径）：
//   在早盘竞价看板【单独开题材 toggle】后，表头 X 位出现「补竞价一字」开关（默认关）；
//   打开 → 把竞价一字看板的一字板股票【按题材融入】下方列表【已经分好类的题材组】里
//   （同组原有股票之后，带「补」小标记；同名的直接跳过，因为列表本身就有）；
//   关闭 → 恢复成「只开题材 toggle」的原样。
//
// 🔴 本文件的三条红线：
//   ① 只是显示层：⛔ 不碰早盘竞价的数据层 / 排序 / 高光 / 列表。`viewData` / `filteredRegularItems`
//      只被「读」：前者用来知道「哪些股票已经在列表里」（避免同一只票重复补），后者是融入的落点序列；
//   ② 数据只用竞价一字看板自己的真相（logic/yizi/yizi-board.js#yiziBoardState）+ 它自己的
//      趋势通道（logic/yizi/yizi-trend.js，走竞价一字小号），⛔ 与早盘竞价的 numcat 主账号无关；
//   ③ 全程【零写入、零新抓取】：一字池是 9:25 Edge 已落库的当日快照，这里只读它
//      （`loadYiziBoard(date)` 不带 force = 廉价读库 + 单飞去重）；趋势图沿用一字看板的懒加载
//      （点序号才取，额度闸门在逻辑层）。
//
// 架构位置（§2 UI → Logic → Data）：
//   components/AuctionBoardTable.vue（融入序列渲染）+ AuctionYiziSupplement{Status,Row,Toggle}.vue
//     → 本文件（UI/VM 状态：开关态 / 展开态 / 曲线装配 / 文案）
//     → logic/auction/yizi-supplement.js（纯函数：按题材融入 → 分段序列）
//     → logic/yizi/{yizi-board,yizi-trend,trend-model}.js（既有单一真相）
//
// §34 UI 状态分离：`on` 与 `trendExpanded` 都是本功能区自己的纯展示态，⛔ 不落 localStorage（§8）、
//   不进全局 store（§6）、不进 Logic 的响应式状态；题材 toggle 关掉 / 日期切换 → 自动归位（无记忆），
//   天然满足「关闭即恢复原样」。
// §10 读失败可见：一字池读失败 → errorText 原样呈现 + 可重试，⛔ 绝不显示成「当天没有一字」。

import { ref, computed, watch } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _dbgLog } from '../data/debug-log.js';
import { yiziBoardState, loadYiziBoard, isYiziFetchTimeReached } from '../logic/yizi/yizi-board.js';
import { isBoardDateAligned } from '../logic/yizi/model.js';
import { loadYiziTrend, yiziTrendState } from '../logic/yizi/yizi-trend.js';
import { buildYiziTrendSeries, trendMetricItems } from '../logic/yizi/trend-model.js';
import { getGroupableCoreTopics } from '../logic/topic/rules.js';
// [YIZI-SUP v3 2026-09-20] 组内「合并排名」的**同一把尺子**：原有行的十日涨幅取自早盘竞价看板
// 自己那份云端缓存（dragon-rank.js，worker 用 range-window 复利口径算出的近 10 交易日区间涨幅）。
// ⚠️ 只读、不触发任何请求（该缓存由早盘竞价看板自己加载）→ §32 不新增网络开销；
//    云端还没到 → 返回 null → 本功能区退化为「补入行接在组内末尾」（⛔ 不假装排过，§10）。
import { getDragonRangePct } from '../logic/auction/dragon-rank.js';
import { mergeYiziIntoAuctionRows, formatMergeSummary } from '../logic/auction/yizi-supplement.js';

/** 融入结果为空时的占位（模板只读 segments/stats，不区分「没开」与「没数据」） */
const EMPTY_MERGE = {
    segments: [],
    stats: { yiziTotal: 0, mergedStocks: 0, mergedRows: 0, inListCount: 0, orphanCount: 0 }
};

/**
 * @param {object} board useAuctionBoard() 的返回值（早盘竞价看板的 composable 实例）
 *   ⚠️ 必须显式传入而不是 `inject('auctionBoard')`：Vue 的 inject 只看**父级** provides，
 *   本组合式在 AuctionBoard.vue（即 provide 的那一层）里被调用，自己 provide 的东西 inject 不到。
 * @returns {object} 供 AuctionBoardTable / AuctionYiziSupplement{Status,Row,Toggle} 使用的状态与回调
 */
export function useAuctionYiziSupplement(board) {
    const uiStore = useUiStore();
    const viewData = board.viewData;
    const filteredRegularItems = board.filteredRegularItems;

    // ===== 开关态（§34 纯展示态：默认关、无记忆）=====
    const on = ref(false);
    const currentDate = computed(() => uiStore.currentDate);

    // 本功能区只在【题材 toggle 单独开启】时才有意义（需求原话：「单独题材 toggle 后…添加一个」）。
    // ⚠️ 判据刻意【不重算】topicOnlyMode（那是 view-helpers 的口径，这里再写一份必然分叉）：
    //    直接看既成事实 —— Logic 层只在「题材单独开启」时给每行标 `groupTopic`（其余模式恒为 ''），
    //    行上有组名 ⇒ 分组已成立 ⇒ 融入有落点。叠加主排序 / 未开题材 → 开关与补入行一起消失。
    const visible = computed(() => {
        const items = (viewData && viewData.value && viewData.value.items) || [];
        return items.length > 0 && !!items[0].groupTopic;
    });
    const active = computed(() => visible.value && on.value);

    // ===== 一字池的日期对齐 / 状态（§26 与 §10）=====
    // 一字看板与早盘竞价看板同屏（都在 DashboardView 里挂载），所以 yiziBoardState 通常已经是
    // 当前日的数据；但「还没加载完 / 读失败」这两个中间态必须如实体现在本功能区里。
    const yiziAligned = computed(() => isBoardDateAligned(yiziBoardState.date, currentDate.value));
    const hasRows = computed(() => yiziAligned.value && yiziBoardState.count > 0);
    const loading = computed(() => !yiziAligned.value && !yiziBoardState.error);
    const errorText = computed(() => (yiziBoardState.error ? String(yiziBoardState.error) : ''));
    const loadHint = computed(() => (yiziBoardState.phase === 'range'
        ? '加载中…（正在补算十日涨幅，首次稍慢）'
        : '加载中…'));
    const emptyText = computed(() => {
        if (!yiziAligned.value) return loadHint.value;
        if (yiziBoardState.count > 0) return '';
        const d = currentDate.value;
        // 当日尚未到 9:25 抓取时刻 → 说清「什么时候会有」，⛔ 不让人误以为当天没有一字
        if (d && !isYiziFetchTimeReached(d)) return '当日一字数据将在 9:25 自动抓取后出现';
        return '当日无可参考的竞价一字（非交易日，或该日尚未抓取）';
    });

    // ===== 早盘竞价当前列表的股票名（只读一次，仅用于去重）=====
    // 用途：用户要求「补充的竞价一字股票不是列表中的股票」（重复的不用融进去）。
    // 这里排除的是**该日完整列表**（不跟随搜索框变化）→ 融入结果稳定，不会在输入搜索时忽增忽减。
    // ⚠️ 只读、不写、不影响早盘竞价的任何展示（§34：视图互不干扰）。
    const listStockNames = computed(() => {
        const set = new Set();
        const items = (viewData && viewData.value && viewData.value.items) || [];
        items.forEach(function(it) {
            const n = it && it.stock ? String(it.stock).trim() : '';
            if (n) set.add(n);
        });
        return set;
    });

    // ===== 融入结果（纯函数产物，模板只做直出）=====
    // 落点序列 = filteredRegularItems（= 早盘竞价题材模式下【实际渲染的常规组行序】，含搜索过滤），
    // 因此补入行的位置与屏幕上的题材组完全对应；搜索时补入行会跟着可见的组走。
    //
    // [YIZI-SUP v3 2026-09-20] 合并排名的基准 = 原有行的十日涨幅（同一个数、同一张 stock_range_pct 表）：
    //   补入行自带 rangePct；原有行这里从 dragon-rank 的云端缓存取。
    //   ⚠️ 缓存未就绪 → pctOf = null → 不做合并排名（补入行接在组内末尾），序号不伪造（§10）。
    const merge = computed(() => {
        if (!active.value || !hasRows.value) return EMPTY_MERGE;
        const pctMap = getDragonRangePct(currentDate.value);
        const pctOf = pctMap
            ? function(name) {
                const v = pctMap.get(String(name === null || name === undefined ? '' : name).trim());
                return v ? v.pct : null;
            }
            : null;
        return mergeYiziIntoAuctionRows(
            (filteredRegularItems && filteredRegularItems.value) || [],
            yiziBoardState.blocks,
            { excludeNames: listStockNames.value, coreTopics: getGroupableCoreTopics(), pctOf: pctOf }
        );
    });
    const segments = computed(() => merge.value.segments);
    const summaryText = computed(() => formatMergeSummary(merge.value.stats));

    // ===== 趋势面板（与竞价一字看板同一通道、同一纯函数）=====
    // ⚠️ 取数通道完全独立于早盘竞价：Edge /trend（竞价一字小号）+ yizi_trend 表。
    // §22 懒加载：只有点开某只股票时才去取；额度闸门在 logic/yizi/yizi-trend.js 里。
    const trendExpanded = ref(new Set());
    const trendExpandedCount = computed(() => trendExpanded.value.size);
    // §26 趋势行也必须属于「当前选中的那一天」才可渲染（否则会把上一天的曲线画在今天的面板上）
    const trendAligned = computed(() => isBoardDateAligned(yiziTrendState.date, currentDate.value));
    const trendMap = computed(() => {
        const out = {};
        if (!trendAligned.value) return out;
        const names = {};
        (yiziTrendState.rows || []).forEach(function(r) { if (r && r.stock) names[r.stock] = true; });
        (yiziBoardState.blocks || []).forEach(function(b) {
            (b.stocks || []).forEach(function(s) { if (s && s.stock) names[s.stock] = true; });
        });
        Object.keys(names).forEach(function(n) {
            out[n] = buildYiziTrendSeries(yiziTrendState.rows, yiziTrendState.windowDates, n);
        });
        return out;
    });
    /** 面板顶部当前值汇总（与曲线同源；无数据 → 空数组 → 模板不渲染该行） */
    function trendMetrics(stockName) {
        const s = trendMap.value[String(stockName || '').trim()];
        return s ? trendMetricItems(s) : [];
    }
    /** 该腿是否有任一点 → 决定是否渲染那张图（全是 '--' 的图是纯噪声） */
    function trendHasLeg(stockName, leg) {
        const s = trendMap.value[String(stockName || '').trim()];
        if (!s || !s[leg]) return false;
        return s[leg].some(function(p) { return p.value !== null; });
    }
    /** 这只股票近 5 日一条数据都没有（面板里给一句话，⛔ 不画 4 张空图） */
    function trendEmpty(stockName) {
        return !trendHasLeg(stockName, 'volume') && !trendHasLeg(stockName, 'yestVolume') &&
            !trendHasLeg(stockName, 'aucPctChg') && !trendHasLeg(stockName, 'changePct');
    }
    const trendLoading = computed(() => yiziTrendState.loading);
    const trendErrorText = computed(() => (yiziTrendState.error ? '趋势：' + yiziTrendState.error : ''));
    const trendNoteText = computed(() => {
        if (yiziTrendState.error) return '';
        if (trendExpandedCount.value === 0) return '';
        return yiziTrendState.note ? ('趋势：' + yiziTrendState.note) : '';
    });

    /** 本日一字池的全部股票名（只传名字、不发请求）—— 趋势缺口判据 (b) 的入参，与一字看板同口径 */
    function _poolNames() {
        const out = [];
        (yiziBoardState.blocks || []).forEach(function(b) {
            (b.stocks || []).forEach(function(s) { if (s && s.stock) out.push(String(s.stock).trim()); });
        });
        return out;
    }

    /** 展开 / 收起某只股票的补入行趋势面板（点序号触发） */
    function toggleTrend(stockName) {
        const name = String(stockName || '').trim();
        if (!name) return;
        const set = new Set(trendExpanded.value);
        if (set.has(name)) {
            set.delete(name);
            trendExpanded.value = set;
            return;
        }
        set.add(name);
        trendExpanded.value = set;
        const d = currentDate.value;
        if (!d) return;
        // 已经为这一天取过（且没出错）→ 不再打接口（Logic 内部也有会话缓存，这里省一次 await）
        if (yiziTrendState.date === d && !yiziTrendState.error) return;
        loadYiziTrend(d, { stocks: _poolNames() }).catch(function(e) {
            // 失败已由 Logic 写进 yiziTrendState.error（§10 可见），这里只兜未预期异常
            _dbgLog('[AUCTION-YIZI-SUP] 趋势加载异常: ' + (e && e.message || e));
        });
    }

    // ===== 数据兜底：开关打开时确保「这一天的池子」已经读到 =====
    // 只读库、不带 force：与一字看板自身的加载共用单飞 + 内容指纹，重复调用不会重复劳动、
    // ⛔ 也不会触发任何上游抓取（9:25 的快照由 Edge 落库，本功能区只消费）。
    function ensureLoaded() {
        const d = currentDate.value;
        if (!d) return;
        if (yiziBoardState.date === d && !yiziBoardState.error) return;
        loadYiziBoard(d).catch(function(e) {
            _dbgLog('[AUCTION-YIZI-SUP] 一字池加载异常: ' + (e && e.message || e));
        });
    }

    function toggle() {
        on.value = !on.value;
        if (on.value) ensureLoaded();
    }

    function retry() {
        const d = currentDate.value;
        if (!d) return;
        loadYiziBoard(d, { force: true }).catch(function(e) {
            _dbgLog('[AUCTION-YIZI-SUP] 一字池重试失败: ' + (e && e.message || e));
        });
    }

    // §34 题材 toggle 关掉（或切进叠加模式）→ 本功能区整体归位（用户要的「关闭后恢复原样」）
    watch(visible, function(v) {
        if (!v) {
            on.value = false;
            trendExpanded.value = new Set();
        }
    });
    // §26 日期切换 → 开关与展开态归位（新的一天是全新的一池一字，旧展开态会误导）。
    // 池子本身由一字看板自己的 watch(currentDate) 刷新；本功能区不重复发起。
    watch(currentDate, function() {
        on.value = false;
        trendExpanded.value = new Set();
    });

    return {
        // 开关
        on,
        visible,
        active,
        toggle,
        // 状态文案
        loading,
        errorText,
        emptyText,
        retry,
        summaryText,
        currentDate,
        // 融入结果（模板逐字段直出）
        segments,
        // 趋势面板
        trendExpanded,
        trendMap,
        trendLoading,
        trendErrorText,
        trendNoteText,
        trendMetrics,
        trendHasLeg,
        trendEmpty,
        toggleTrend
    };
}
