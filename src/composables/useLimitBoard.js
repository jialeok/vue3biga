// useLimitBoard.js — 「涨跌停」看板的 UI 组合式（§14 UI 瘦身：view 只留模板与调用）
//
// 本 composable 是「涨跌停」看板唯一的 UI 侧入口：
//   · 读 logic/limitpool/limit-pool.js 的响应式状态（limitBoardState）；
//   · 把「日期切换 / 看板刷新事件 / Realtime 通知」统一收敛为一次 loadLimitBoard；
//   · 手动粘贴导入题材 → 调 logic 的 importTopicsFromPaste（写共享题材库，两看板互通）。
//
// ⛔ 本文件不含任何业务判定（不判交易日、不算涨幅、不选龙头、不拼 SortKey）——
//    所有规则都在 logic 层；UI 只负责「展示 + 触发」。
// ⛔ 不做任何数据兜底：状态为空就渲染空，读失败就渲染失败（§10 读失败 ≠ 空）。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { showToast, showWarningToast } from './useToast.js';
import {
    limitBoardState,
    loadLimitBoard,
    isPoolFetchTimeReached,
    importTopicsFromPaste
} from '../logic/limitpool/limit-pool.js';
// ★ 需求 1（§6 单一真相）：题材自动回填只数从 topic-sync 的响应式计数直接读，
//    ⛔ 不再经看板 state 转抄一份（副本会在「本板回填中止、另一板随后补上」时陈旧）。
import { getAutoFilledForDate } from '../logic/topics/topic-sync.js';
import { formatRangePct, rangeTone, filterNoTopicBlocks } from '../logic/limitpool/model.js';

export function useLimitBoard() {
    const uiStore = useUiStore();
    const state = limitBoardState;

    const expanded = ref(true);
    const importOpen = ref(false);
    const importText = ref('');
    const importSaving = ref(false);
    const importResult = ref('');

    // ===== 「无题材」过滤开关（§34 UI 状态分离：纯展示态，默认关、无记忆）=====
    // 只改「看到哪些行」，不改任何数据、不发请求、不写库。
    // ⛔ 不落 localStorage（§8：localStorage 禁存业务/UI 配置）、不进全局 store（§6 单一真相）；
    //    随日期切换自动归位 false（见文件末尾 watch(currentDate)）→ 天然满足「翻页/切日即重置」。
    const showNoTopic = ref(false);
    // 题材库就绪才可信：未就绪时所有股票都会显示 '-'，此时把「读不到题材」当成「没有题材」
    // 会引导用户去给【已有题材】的股票重复补题材（§10 未就绪 ≠ 空）→ 未就绪时开关不可用。
    const noTopicAvailable = computed(() => state.topicLibraryReady === true);
    const noTopicView = computed(() => showNoTopic.value && noTopicAvailable.value);
    function toggleNoTopic() {
        showNoTopic.value = !showNoTopic.value;
    }

    const currentDate = computed(() => uiStore.currentDate);
    const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));
    const hasAnyData = computed(() => state.upCount > 0 || state.downCount > 0);

    const summaryText = computed(() => {
        if (state.error && !hasAnyData.value) return '加载失败';
        if (!hasAnyData.value) return state.loading ? '加载中…' : '暂无数据';
        return '跌停 ' + state.downCount + ' / 涨停 ' + state.upCount;
    });

    // 当日尚未到 15:40 抓取时刻 → 明确告知用户「等待自动抓取」，而不是让人误以为没数据
    const fetchTimeHint = computed(() => {
        const d = currentDate.value;
        if (!d || hasAnyData.value || state.error) return '';
        return isPoolFetchTimeReached(d) ? '' : '当日数据将在收盘后 15:40 自动抓取';
    });

    // ★ 2026-09-22 需求 1【次日继承】：屏幕上摆的是「上一个交易日」那一池时，必须说清楚。
    //   ⛔ 这不是装饰性提示：把昨天收盘后的名单当成今天的去用，比显示「暂无数据」危险得多。
    //   只继承一天（不会链式），且继承结果不落库 → 15:40 自动抓取一落地，这里自然消失。
    const inheritHint = computed(() => {
        const from = state.inheritedFrom;
        if (!from || !hasAnyData.value) return '';
        return '当日数据尚未抓取，当前显示【' + from + '】收盘后的涨跌停名单（原封不动照搬，只继承最近一个交易日；' +
            '当日 15:40 自动抓取完成后立即换成最新名单）';
    });

    // ★ 2026-09-22 需求 2：竞价就涨停 / 跌停 → 股票名下方实心红 / 绿线的悬停说明。
    //   无值（null）→ 不提示：那是「没打到板价」或「没有竞价涨幅数据」，两种情况都不该编一句话。
    function aucLimitTitle(stock) {
        const v = stock && stock.aucLimit;
        if (v === 'up') return '竞价涨停：9:25 竞价涨幅已打在涨停价';
        if (v === 'down') return '竞价跌停：9:25 竞价涨幅已打在跌停价';
        return null;
    }

    // ★ 2026-09-18 需求 1：题材自动回填提示。
    // 「竞价一字」接口自带题材 → 加载时「只补空缺」写进共享题材库 → 本看板自动拿到，
    // 不必再手动粘贴导入。只在真的补了才提示（=0 时静默）。
    // ⚠️ 只数取 state.date（= 当前**已发布**的那一天，与屏上行数据同一天），
    //    从 topic-sync 读（响应式单一真相）→ 另一个看板先补上时本板也会立刻显示，
    //    与「谁先加载」无关。⛔ 不读 state 里的副本（曾经的陈旧根因）。
    const topicAutoFillHint = computed(() => {
        if (!hasAnyData.value) return '';
        const n = getAutoFilledForDate(state.date) || 0;
        if (n <= 0) return '';
        return '已自动为 ' + n + ' 只股票补全题材（取自一字接口 → 写入共享题材库，三个看板共享；只补空缺、不覆盖已有题材）';
    });

    // 十日涨幅覆盖提示（有池子但覆盖不全时，让用户知道涨幅列可能显示 '-'）
    const rangeHint = computed(() => {
        if (!hasAnyData.value) return '';
        const total = state.upCount + state.downCount;
        if (state.rangeCovered < total) return '十日涨幅覆盖 ' + state.rangeCovered + '/' + total + ' 只';
        return '';
    });

    // 分屏结构：跌停板在上、涨停板在下（顺序即需求，UI 不参与业务判断）
    // 「无题材」开关打开时，仅对分块行做一次过滤（filterNoTopicBlocks 为纯函数，不改 state）：
    // 分板总只数（count）保持「当日真实涨跌停只数」不变 —— 那是关于这一天的事实，不随视图变。
    // 过滤后本板一行都不剩时，用 emptyText 如实说明「本板股票都有题材」（而不是伪装成「当日无涨停」）。
    const sections = computed(() => {
        const filtering = noTopicView.value;
        const build = function(key, title, count, blocks) {
            const shown = filtering ? filterNoTopicBlocks(blocks) : blocks;
            return {
                key: key,
                title: title,
                count: count,
                blocks: shown,
                emptyText: filtering && shown.length === 0 ? '本板股票均有题材' : ''
            };
        };
        return [
            build('down', '跌停板', state.downCount, state.downBlocks),
            build('up', '涨停板', state.upCount, state.upBlocks)
        ];
    });

    function toggleExpand() {
        expanded.value = !expanded.value;
        if (expanded.value) refresh();
    }

    function refresh() {
        const d = currentDate.value;
        if (!d) return;
        loadLimitBoard(d, { force: true }).catch(function(e) {
            showWarningToast('涨跌停加载失败：' + (e && e.message || e));
        });
    }

    function openImport() {
        importResult.value = '';
        importOpen.value = true;
    }

    async function doImport() {
        const text = importText.value;
        if (!text || !text.trim()) {
            showWarningToast('请先粘贴「股票 + 题材」数据');
            return;
        }
        importSaving.value = true;
        importResult.value = '';
        try {
            const res = await importTopicsFromPaste(text);
            importResult.value = res.message;
            if (res.ok) {
                showToast('✅ ' + res.message);
                importText.value = '';
            } else {
                showWarningToast('❌ ' + res.message);
            }
        } catch (e) {
            const msg = '导入失败：' + (e && e.message || e);
            importResult.value = msg;
            showWarningToast('❌ ' + msg);
        } finally {
            importSaving.value = false;
        }
    }

    // ===== 题材/涨幅展示辅助（全部转发 logic 纯函数，UI 不自造口径）=====
    function rangeText(row) {
        return formatRangePct(row && row.rangePct, row && row.rangeDays);
    }
    function rangeClass(row) {
        return 'tone-' + rangeTone(row && row.rangePct);
    }
    // 连板 / 跌停时间的行内小标文案：无值返回空串（模板据空串决定不渲染该标，绝不显示 '-' 占位）
    function continueText(row) {
        if (!row) return '';
        return row.continueText || row.limitTime || '';
    }

    function onRealtimeUpdate(payload) {
        if (!payload || !payload.boards || payload.boards === 'all' || payload.boards === 'limitpool') refresh();
    }

    onMounted(() => {
        refresh();
        _on('limit-refresh', refresh);
        _on('data:realtime-update', onRealtimeUpdate);
    });
    onUnmounted(() => {
        _off('limit-refresh', refresh);
        _off('data:realtime-update', onRealtimeUpdate);
    });

    // §6 单源：日期切换一律由 uiStore.currentDate 驱动（不额外维护本地日期副本）
    // 「无题材」开关随日期切换归位（无记忆）—— 新的一天是全新的一池股票，旧筛选态会误导。
    watch(currentDate, function() {
        showNoTopic.value = false;
        refresh();
    });

    return {
        state,
        expanded,
        toggleArrow,
        hasAnyData,
        summaryText,
        fetchTimeHint,
        inheritHint,
        topicAutoFillHint,
        rangeHint,
        sections,
        noTopicAvailable,
        noTopicView,
        toggleNoTopic,
        importOpen,
        importText,
        importSaving,
        importResult,
        toggleExpand,
        refresh,
        openImport,
        doImport,
        rangeText,
        rangeClass,
        continueText,
        aucLimitTitle
    };
}
