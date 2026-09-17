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
import { formatRangePct, rangeTone, formatSealMoney } from '../logic/limitpool/model.js';

export function useLimitBoard() {
    const uiStore = useUiStore();
    const state = limitBoardState;

    const expanded = ref(true);
    const importOpen = ref(false);
    const importText = ref('');
    const importSaving = ref(false);
    const importResult = ref('');

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

    // 十日涨幅覆盖提示（有池子但覆盖不全时，让用户知道涨幅列可能显示 '-'）
    const rangeHint = computed(() => {
        if (!hasAnyData.value) return '';
        const total = state.upCount + state.downCount;
        if (state.rangeCovered < total) return '十日涨幅覆盖 ' + state.rangeCovered + '/' + total + ' 只';
        return '';
    });

    // 分屏结构：跌停板在上、涨停板在下（顺序即需求，UI 不参与业务判断）
    const sections = computed(() => ([
        { key: 'down', title: '跌停板', count: state.downCount, blocks: state.downBlocks },
        { key: 'up', title: '涨停板', count: state.upCount, blocks: state.upBlocks }
    ]));

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
    function toneClass(pct) {
        return 'tone-' + rangeTone(pct);
    }
    function sealText(row) {
        return formatSealMoney(row && row.sealMoney);
    }
    function continueText(row) {
        if (!row) return '-';
        return row.continueText || row.limitTime || '-';
    }
    function topicsText(row) {
        return (row && row.topicsText) || '-';
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
    watch(currentDate, function() { refresh(); });

    return {
        state,
        expanded,
        toggleArrow,
        hasAnyData,
        summaryText,
        fetchTimeHint,
        rangeHint,
        sections,
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
        toneClass,
        sealText,
        continueText,
        topicsText
    };
}
