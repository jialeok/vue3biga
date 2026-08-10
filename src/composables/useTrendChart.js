﻿import { toggleAuctionTrendPanel, toggleAuctionTrendPanelP2 } from '../logic/ui-bridge.js';
import { useAuctionStore, safeCall } from '../stores/auctionStore.js';
/**
 * useTrendChart.js
 * 早盘竞价看板趋势图交互 composable（Vue 3）
 *
 * 职责：封装股票趋势面板展开/收起状态、滑动容器手势、统一事件代理。
 * 从 src/ui/composables/auction-composables.js 拆分而来，去 window 化为 ES module。
 * 保留 _getAuctionStore() / window.safeCall / toggleAuctionTrendPanel 等
 * 共享状态与 UI 层调用在 window 上。
 */
import { ref, computed } from 'vue';
import { _dbgLog } from '../data/debug-log.js';

// ============================================================
// Composable: useAuctionExpand
// ------------------------------------------------------------
// 封装股票趋势面板与题材分组的展开/收起状态计算（无副作用）。
// 真实 DOM 展开/恢复由 useAuctionEvents / 遗留全局函数在组件事件后执行。
// ============================================================
export function useAuctionExpand() {
    function isStockExpanded(stockName, dataSource) {
        if (!stockName) return false;
        const tab = dataSource === 'hot' ? 'hot' : 'auction';
        return _getAuctionStore().currentGroup === tab && _getAuctionStore().expandedStocks.has(stockName);
    }

    function isP2TopicExpanded(topic, dataSource) {
        if (!topic) return false;
        const key = (dataSource === 'hot' ? 'hot' : 'auction') + '|' + topic;
        return _getAuctionStore().p2ExpandedTopics.has(key);
    }

    function isExpandAll(page, dataSource) {
        const tab = dataSource === 'hot' ? 'hot' : 'auction';
        if (page === 2) return _getAuctionStore().expandAllP2;
        return _getAuctionStore().expandAll;
    }

    return { isStockExpanded, isP2TopicExpanded, isExpandAll };
}

// ============================================================
// Composable: useAuctionGesture
// ------------------------------------------------------------
// 封装滑动容器的手势处理逻辑。
// ============================================================
export function useAuctionGesture() {
    function useSwipe(store) {
        let touchStartX = 0;
        let touchStartY = 0;

        function onTouchStart(e) {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }

        function onTouchEnd(e) {
            const dx = e.changedTouches[0].screenX - touchStartX;
            const dy = e.changedTouches[0].screenY - touchStartY;
            if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
            if (!store || !store.actions) return;
            if (dx < 0 && store.currentPage < 3) store.actions.switchPage(store.currentPage + 1);
            else if (dx > 0 && store.currentPage > 0) store.actions.switchPage(store.currentPage - 1);
        }

        return { onTouchStart, onTouchEnd };
    }

    return { useSwipe };
}

// ============================================================
// Composable: useAuctionEvents
// ------------------------------------------------------------
// 统一包装全局交互函数，提供安全调用与清晰降级。
// 组件中不再直接调用 window.xxx，而是通过此 composable 返回的 handlers。
// ============================================================
export function useAuctionEvents() {


    function createHandlers(dataSource) {
        const ds = dataSource === 'hot' ? 'hot' : 'auction';
        const actions = _getAuctionStore().actions;

        return {
            // 头部
            toggleBoard: () => actions.toggleBoard(),
            switchGroup: (group) => actions.switchGroup(group),
            switchPage: (page) => actions.switchPage(page),

            // Page1 工具栏
            onExpandAllChange: (page, checked) => {
                actions.setExpandAll(checked, page);
                if (page === 2) {
                    if (checked) actions.expandAllTrendPanelsP2(ds);
                    else actions.restoreExpandedTopicGroupsP2(ds);
                } else {
                    if (checked) actions.expandAllTrendPanels(ds);
                    else actions.restoreExpandedTrendPanels(ds);
                }
            },
            onSortChange: (page, key, checked) => actions.setSortState(page, key, checked),
            toggleSortHelp: (panelId) => actions.toggleSortHelp(panelId),

            // Page1 行交互
            onNumberClick: (index, e) => {
                if (e) e.stopPropagation();
                // 直接调用原生的趋势图切换函数（store.toggleTrendPanel 只维护展开集合，
                // 没有代理到全局函数，导致点击序号无反应）。
                safeCall(toggleAuctionTrendPanel, index);
            },
            onRatioClick: (index, e) => {
                if (e) e.stopPropagation();
                actions.toggleRowSelect(index);
            },
            onYestClick: (el, note, lpState, e) => {
                if (lpState && (lpState.isLongPress || lpState.isMoved)) return;
                const now = Date.now();
                if (lpState && (now - lpState.lastTapTime < 300)) return;
                if (lpState) lpState.lastTapTime = now;
                if (note && el) {
                    if (e) { e.preventDefault(); e.stopPropagation(); }
                    actions.showNotePopup(el, note);
                }
            },
            onYestContext: (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                actions.openEdit(ds);
            },
            onYestLongPress: (index, el) => actions.showNoteInput(index, el),
            onNameClick: (stockName, lpState, e) => {
                if (lpState && (lpState.isLongPress || lpState.isMoved)) return;
                if (stockName && stockName !== '-') {
                    if (e) e.stopPropagation();
                    actions.jumpToPage2(stockName);
                }
            },
            onNameDblClick: (note, yestEl, e) => {
                if (e) e.stopPropagation();
                if (note && yestEl) actions.showNotePopup(yestEl, note);
            },
            onNameContext: (e) => { if (e) e.preventDefault(); },
            onNameLongPress: (stockName) => actions.showBuyPrompt(stockName),

            // Page2
            onStrengthSortClick: () => actions.toggleStrengthSort(),
            onPage2StockClick: (stockName, e) => {
                if (e) e.stopPropagation();
                if (stockName && stockName !== '-') actions.jumpToPage1(stockName);
            },
            onPage2RowClick: (row, e) => {
                if (e) e.stopPropagation();
                if (row.topicAllowsExpand && row.stock && row.stock !== '-' && row.rowKey) {
                    safeCall(toggleAuctionTrendPanelP2, row.rowKey, row.stock);
                }
            },
            onGroupExpandClick: (topic, e) => {
                if (e) e.stopPropagation();
                actions.toggleTopicGroupTrendPanels(topic);
            },
            onTopicLongPress: (el) => {
                const sn = el && el.getAttribute ? el.getAttribute('data-stock') : null;
                if (sn) actions.openAuctionNoteEditFromPage2(sn);
            },
            openCoreTopicModal: () => actions.openCoreTopicModal(),
            openEdit: () => actions.openEdit(ds),

            // Page3
            copyAll: (topic) => actions.copyAllTopicStocks(topic, ds),
            copy5: (topic) => actions.copyTopicStocks(topic, 5, ds),
            copy2: (topic) => actions.copyTopicStocks(topic, 2, ds)
        };
    }

    return { createHandlers, safeCall };
}

_dbgLog('[USE-TREND-CHART] composable 已就绪');