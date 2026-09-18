// useAuctionYizi.js — 「竞价一字」看板的 UI 组合式（§14 UI 瘦身：view 只留模板与调用）
//
// 本 composable 是「竞价一字」看板唯一的 UI 侧入口：
//   · 读 logic/yizi/yizi-board.js 的响应式状态（yiziBoardState）；
//   · 把「日期切换 / 看板刷新事件 / Realtime 通知」统一收敛为一次 loadYiziBoard；
//   · 手动粘贴导入题材 → 调 logic 的 importYiziTopicsFromPaste（写共享题材库，三看板互通）。
//
// ⛔ 本文件不含任何业务判定（不判交易日、不选龙头、不解析题材优先级、不拼 SortKey）——
//    所有规则都在 logic 层；UI 只负责「展示 + 触发」。
// ⛔ 不做任何数据兜底：状态为空就渲染空，读失败就渲染失败（§10 读失败 ≠ 空）。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { showToast, showWarningToast } from './useToast.js';
import {
    yiziBoardState,
    loadYiziBoard,
    isYiziFetchTimeReached,
    importYiziTopicsFromPaste
} from '../logic/yizi/yizi-board.js';
import { filterYiziNoTopicBlocks, formatAucPct, isBoardDateAligned } from '../logic/yizi/model.js';

export function useAuctionYizi() {
    const uiStore = useUiStore();
    const state = yiziBoardState;

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

    // ===== §26 日期切换：状态必须「属于当前选中日」才可渲染 =====
    // 切换日期后新日期的云端读取需要时间。在这个窗口里 state.blocks/count 仍是上一天的内容
    // （编排层只在加载成功后才整体改写），而页头日期已经变了 —— 此时按 count>0 渲染，
    // 就会把【上一天的一字池】当成【这一天的一字池】展示（实测出现「页头 09-14、正文 09-17 的 129 只」）。
    // 因此：日期不对齐 ⇒ 一律按「还没准备好」处理（显示加载中），⛔ 绝不显示另一天的行。
    // 注意这不是 §10 的「读取失败当空」：读失败仍走 state.error 分支并原样抛错。
    const stateDateAligned = computed(() => isBoardDateAligned(state.date, currentDate.value));
    const hasAnyData = computed(() => state.count > 0 && stateDateAligned.value);

    const summaryText = computed(() => {
        if (state.error && !hasAnyData.value) return '加载失败';
        // 日期未对齐 = 这一天的数据还没到（与「这一天没有」是两回事，不能写成暂无数据）
        if (!hasAnyData.value) return (state.loading || !stateDateAligned.value) ? '加载中…' : '暂无数据';
        return '一字 ' + state.count + ' 只';
    });

    // 当日尚未到 9:25 抓取时刻 → 明确告知用户「等待自动抓取」，而不是让人误以为没数据
    const fetchTimeHint = computed(() => {
        const d = currentDate.value;
        if (!d || hasAnyData.value || state.error) return '';
        // 日期还没对齐 = 这一天的数据尚在加载，不适用「等 9:25」提示
        if (!stateDateAligned.value) return '';
        return isYiziFetchTimeReached(d) ? '' : '当日一字数据将在 9:25 自动抓取';
    });

    // 空态文案（唯一的空态出口）：区分「正在加载这一天」/「等到 9:25」/「这一天确实没有」
    const emptyText = computed(() => {
        if (state.loading || !stateDateAligned.value) return '加载中…';
        return fetchTimeHint.value || '暂无竞价一字数据';
    });

    // 题材来源提示（可解释性）：只在「有票靠库兜底」或「完全没题材」时才提示 —— 这两种情况
    // 正是用户需要动手补题材的信号；接口自带题材正常时不打扰。
    const themeHints = computed(() => {
        if (!hasAnyData.value) return [];
        const out = [];
        if (state.themeNone > 0) out.push('有 ' + state.themeNone + ' 只暂无题材（开「无题材」可筛出来，截图后手动导入）');
        if (state.themeFromLib > 0) out.push('其中 ' + state.themeFromLib + ' 只题材取自共享题材库（接口未返回题材）');
        return out;
    });

    // 分屏结构：一字池只有一块 —— 用与涨跌停看板同形的 sections 数组承载，
    // 使两个看板的模板结构一致（后续要给一字池再分档时不必改模板）。
    // 「无题材」开关打开时，仅对分块行做一次过滤（filterYiziNoTopicBlocks 为纯函数，不改 state）：
    // 总数（count）保持「当日真实一字只数」不变 —— 那是关于这一天的事实，不随视图变。
    // 过滤后一行都不剩时，用 emptyText 如实说明「一字池股票都有题材」（而不是伪装成「当日无一字」）。
    const sections = computed(() => {
        const filtering = noTopicView.value;
        const shown = filtering ? filterYiziNoTopicBlocks(state.blocks) : state.blocks;
        return [{
            key: 'yizi',
            title: '一字板',
            count: state.count,
            blocks: shown,
            emptyText: filtering && shown.length === 0 ? '一字池股票均有题材' : ''
        }];
    });

    function toggleExpand() {
        expanded.value = !expanded.value;
        if (expanded.value) refresh();
    }

    function refresh() {
        const d = currentDate.value;
        if (!d) return;
        loadYiziBoard(d, { force: true }).catch(function(e) {
            showWarningToast('竞价一字加载失败：' + (e && e.message || e));
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
            const res = await importYiziTopicsFromPaste(text);
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

    // ===== 展示辅助（全部转发 logic 纯函数，UI 不自造口径）=====
    function aucText(row) {
        return formatAucPct(row && row.aucPct);
    }
    /** 封单额展示文本（logic 已算好）；无值时显示 '-' 而不是空白，便于对齐阅读 */
    function sealText(row) {
        const t = (row && row.sealText) || '';
        return t || '-';
    }

    function onRealtimeUpdate(payload) {
        if (!payload || !payload.boards || payload.boards === 'all' || payload.boards === 'yizi') refresh();
    }

    onMounted(() => {
        refresh();
        _on('yizi-refresh', refresh);
        _on('data:realtime-update', onRealtimeUpdate);
    });
    onUnmounted(() => {
        _off('yizi-refresh', refresh);
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
        emptyText,
        themeHints,
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
        aucText,
        sealText
    };
}
