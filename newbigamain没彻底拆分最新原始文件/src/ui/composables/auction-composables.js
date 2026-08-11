/**
 * auction-composables.js
 * 早盘竞价看板可复用逻辑层（Vue 3 Composables）
 *
 * 设计原则：
 * 1. 完全信任 Vue 3 computed，移除手动记忆化层 useViewMemo。
 * 2. 每个 composable 职责单一：数据读取、排序、展开状态、手势、事件代理。
 * 3. 不直接操作 DOM，不写渲染副作用。
 * 4. 全局依赖按 window 注入，便于与遗留代码共存。
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // [TDZ-FIX] 避免 window.Vue 不存在时读取正在声明的 const Vue 触发 TDZ
    const Vue = window.Vue || null;
    window.auctionStore = window.auctionStore;
    if (!Vue || !window.auctionStore) {
        console.warn('[AUCTION-COMPOSABLES] Vue 或 window.auctionStore 未就绪，跳过初始化');
        return;
    }

    // ============================================================
    // Composable: useAuctionData
    // ------------------------------------------------------------
    // 封装当前/前序交易日列表、标签状态缓存、信号集合等纯数据获取。
    // ============================================================
    function useAuctionData() {
        function getTodayList(dataSource) {
            return window.getTodayGroupList(dataSource);
        }
        window.getTodayList = getTodayList;

        function getPrevDate(date) {
            return window.getPreviousTradingDay(date);
        }
        window.getPrevDate = getPrevDate;

        function getPrevList(dataSource, date) {
            const prevDate = window.getPreviousTradingDay(date);
            return prevDate ? (window.getGroupData(dataSource)[prevDate] || []) : [];
        }
        window.getPrevList = getPrevList;

        function getPrevPrevList(dataSource, date) {
            const prevDate = window.getPreviousTradingDay(date);
            const prevPrevDate = prevDate ? window.getPreviousTradingDay(prevDate) : null;
            return prevPrevDate ? (window.getGroupData(dataSource)[prevPrevDate] || []) : [];
        }
        window.getPrevPrevList = getPrevPrevList;

        function ensureTopicCache(auctionList) {
            const needs = auctionList.some(function (it) {
                if (!it || !it.stock) return false;
                const note = window.getDisplayNote(it);
                return !note || window.extractTopics(note).length === 0;
            });
            if (needs) window.buildTopicCache();
        }
        window.ensureTopicCache = ensureTopicCache;

        function getTagStateCache(date) {
            return window._buildTagStateCache(date);
        }
        window.getTagStateCache = getTagStateCache;

        function getHistRowMap(list) {
            const map = new Map();
            if (!list || !list.length) return map;
            for (let i = 0; i < list.length; i++) {
                const it = list[i];
                if (it && it.stock) map.set(it.stock.trim(), it);
            }
            return map;
        }
        window.getHistRowMap = getHistRowMap;

        function getHistoryCountMap(dataSource, date) {
            const auctionData = window.getGroupData(dataSource);
            const map = new Map();
            let d = date;
            for (let i = 0; i < 5 && d; i++) {
                const list = auctionData[d] || [];
                list.forEach(function (it) {
                    if (!it || !it.stock) return;
                    const name = it.stock.trim();
                    if (!map.has(name)) map.set(name, 0);
                    const v = window.getNumericVolume(it.volume);
                    const yv = window.getNumericVolume(it.yestVolume);
                    if (v !== null || yv !== null) map.set(name, map.get(name) + 1);
                });
                d = window.getPreviousTradingDay(d);
            }
            return map;
        }
        window.getHistoryCountMap = getHistoryCountMap;

        function getConfirmedSoldSet(auctionList, date) {
            const res = new Set();
            const sd = window.getStocksData();
            const dates = Object.keys(sd).filter(d => d <= date).sort();
            const names = new Set(auctionList.map(it => it.stock ? it.stock.trim() : '').filter(Boolean));
            if (names.size === 0) return res;
            const latest = {};
            dates.forEach(d => (sd[d] || []).forEach(s => {
                if (!s || !s.name) return;
                const n = s.name.trim();
                if (names.has(n)) latest[n] = s;
            }));
            Object.keys(latest).forEach(n => { if (latest[n].sold === true) res.add(n); });
            return res;
        }
        window.getConfirmedSoldSet = getConfirmedSoldSet;

        function getHighRatio(date, dataSource) {
            return window.getHighRatioStocksForDate(date, dataSource);
        }
        window.getHighRatio = getHighRatio;

        function getParallel(date, dataSource) {
            return window.getParallelStocksForDate(date, dataSource);
        }
        window.getParallel = getParallel;

        function getJingYest(date, dataSource) {
            return window.getJingYestHighlightSetForDate(date, dataSource);
        }
        window.getJingYest = getJingYest;

        function getRatioDiff(date, dataSource) {
            return window.getRatioDiffInfoForDate(date, dataSource);
        }
        window.getRatioDiff = getRatioDiff;

        function getSignalSets(date, dataSource, options) {
            const opts = options || {};
            return {
                highRatio: window.getHighRatio(date, dataSource),
                parallel: opts.parallel ? window.getParallel(date, dataSource) : null,
                jingYest: window.getJingYest(date, dataSource),
                ratioDiff: opts.ratioDiff ? window.getRatioDiff(date, dataSource) : null
            };
        }
        window.getSignalSets = getSignalSets;

        function getDuibanTushiLink() {
            const duibanList = window.getTodayDuiban();
            for (let i = 0; i < duibanList.length; i++) {
                const tushi = (duibanList[i] && duibanList[i].tushi) || '';
                if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
            }
            return '';
        }
        window.getDuibanTushiLink = getDuibanTushiLink;

        function getObsContext(date, dataSource) {
            const prevDate = window.getPreviousTradingDay(date);
            return {
                obsStocks: window.getJingYestHighlightSetForDate(prevDate, dataSource),
                autoAddedSet: new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]')),
                obsBoughtSet: new Set(JSON.parse(localStorage.getItem('obsBought_' + date) || '[]'))
            };
        }
        window.getObsContext = getObsContext;

        return {
            getTodayList, getPrevDate, getPrevList, getPrevPrevList,
            ensureTopicCache, getTagStateCache, getHistRowMap, getHistoryCountMap,
            getConfirmedSoldSet,
            getHighRatio, getParallel, getJingYest, getRatioDiff, getSignalSets,
            getDuibanTushiLink, getObsContext
        };
    }

    // ============================================================
    // Composable: useAuctionSort
    // ------------------------------------------------------------
    // 封装 page1/page2 的排序逻辑，纯函数无副作用。
    // ============================================================
    function useAuctionSort() {
        function getNumericVolumeSafe(v) {
            return window.getNumericVolume(v);
        }
        window.getNumericVolumeSafe = getNumericVolumeSafe;
        function getDigitCountSafe(v) {
            return window.getDigitCount(v);
        }
        window.getDigitCountSafe = getDigitCountSafe;

        function sortPage1RenderOrder(renderOrder, auctionList, ctx) {
            const { sortState, historyCountMap, prevDayMap, signalSets } = ctx;
            const { highRatio, parallel, jingYest, ratioDiff, threeDayJingDie } = signalSets || {};
            const jingYestHighlightSet = jingYest;
            const threeDayJingDieSet = threeDayJingDie;

            if (sortState.byData) {
                return renderOrder.map((idx) => ({
                    idx,
                    c: auctionList[idx] && auctionList[idx].stock
                        ? (historyCountMap.get(auctionList[idx].stock.trim()) || 0)
                        : 0
                })).sort((a, b) => b.c - a.c).map(x => x.idx);
            }

            if (sortState.byRatio) {
                return renderOrder.map((idx, pos) => {
                    const it = auctionList[idx];
                    const nm = it && it.stock ? it.stock.trim() : '';
                    const tv = it ? window.getNumericVolumeSafe(it.volume) : null;
                    const yv = it ? window.getNumericVolumeSafe(it.yestVolume) : null;
                    let r = null;
                    if (tv !== null && tv !== 0) {
                        const pi = prevDayMap.get(nm);
                        const pv = pi ? window.getNumericVolumeSafe(pi.volume) : null;
                        if (pv !== null && pv !== 0) r = tv / pv;
                    }
                    const dg = (tv !== null && yv !== null) ? Math.abs(window.getDigitCountSafe(tv) - window.getDigitCountSafe(yv)) : null;
                    const hr = nm && highRatio && highRatio.stockNames.has(nm);
                    const tier = hr ? 0 : (r !== null ? 1 : 2);
                    return { idx, pos, r, dg, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.dg === null && b.dg === null) return a.pos - b.pos;
                        if (a.dg === null) return 1;
                        if (b.dg === null) return -1;
                        if (a.dg !== b.dg) return a.dg - b.dg;
                        return b.r - a.r;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }

            if (sortState.byJingYestRatio) {
                const info = ratioDiff;
                return renderOrder.map((idx, pos) => {
                    const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                    const tier = ih ? 0 : 1;
                    const fi = ih ? (info ? info.get(nm) : null) : null;
                    return { idx, pos, jr: fi ? fi.jingRatio : null, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0) {
                        if (a.jr === null && b.jr === null) return a.pos - b.pos;
                        if (a.jr === null) return 1;
                        if (b.jr === null) return -1;
                        return b.jr - a.jr;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }

            if (sortState.byThreeDayJingDie) {
                return renderOrder.map((idx, pos) => {
                    const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                    const dd = nm && threeDayJingDieSet ? (threeDayJingDieSet.get(nm) || 0) : 0;
                    const vol = auctionList[idx] ? (parseFloat(auctionList[idx].volume) || 0) : 0;
                    const yvol = auctionList[idx] ? (parseFloat(auctionList[idx].yestVolume) || 0) : 0;
                    const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                    return { idx, pos, dd, jr };
                }).sort((a, b) => {
                    if (a.dd !== b.dd) return b.dd - a.dd;
                    if (a.jr === null && b.jr === null) return a.pos - b.pos;
                    if (a.jr === null) return 1;
                    if (b.jr === null) return -1;
                    return a.jr - b.jr;
                }).map(x => x.idx);
            }

            if (sortState.byParallel) {
                const ps = parallel;
                const info = ratioDiff;
                if (sortState.byJingYest) {
                    return renderOrder.map((idx, pos) => {
                        const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                        const ip = ps && ps.has(nm);
                        const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                        const tier = ih ? 0 : (ip ? 1 : 2);
                        const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                        return { idx, pos, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null, tier };
                    }).sort((a, b) => {
                        if (a.tier !== b.tier) return a.tier - b.tier;
                        if (a.tier === 0 || a.tier === 1) {
                            if (a.dg === null && b.dg === null) return a.pos - b.pos;
                            if (a.dg === null) return 1;
                            if (b.dg === null) return -1;
                            if (a.dg !== b.dg) return a.dg - b.dg;
                            return b.diff - a.diff;
                        }
                        return a.pos - b.pos;
                    }).map(x => x.idx);
                }
                return renderOrder.map((idx, pos) => {
                    const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                    const q = nm && ps && ps.has(nm);
                    const fi = q ? (info ? info.get(nm) : null) : null;
                    return { idx, pos, q, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null };
                }).sort((a, b) => {
                    if (a.q !== b.q) return a.q ? -1 : 1;
                    if (a.q) {
                        if (a.dg === null && b.dg === null) return a.pos - b.pos;
                        if (a.dg === null) return 1;
                        if (b.dg === null) return -1;
                        if (a.dg !== b.dg) return a.dg - b.dg;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }

            return renderOrder;
        }
        window.sortPage1RenderOrder = sortPage1RenderOrder;

        function sortPage2GroupStocks(stocks, ctx) {
            const { auctionByName, prevAuctionByName, sortState, signalSets, highRatioInfo } = ctx;
            const { parallel, jingYest, ratioDiff, threeDayJingDie } = signalSets || {};
            const jingYestHighlightSet = jingYest;
            const parallelStockNames = parallel;
            const threeDayJingDieSet = threeDayJingDie;

            if (sortState.byRatio) {
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    if (!nm) return { s, pos, ratio: null, digitGap: null, tier: 2 };
                    const ti = auctionByName.get(nm);
                    const tv = ti ? window.getNumericVolumeSafe(ti.volume) : null;
                    const yv = ti ? window.getNumericVolumeSafe(ti.yestVolume) : null;
                    let r = null;
                    if (tv !== null && tv !== 0) {
                        const pi = prevAuctionByName.get(nm);
                        const pv = pi ? window.getNumericVolumeSafe(pi.volume) : null;
                        if (pv !== null && pv !== 0) r = tv / pv;
                    }
                    const dg = (tv !== null && yv !== null) ? Math.abs(window.getDigitCountSafe(tv) - window.getDigitCountSafe(yv)) : null;
                    const hr = nm && highRatioInfo && highRatioInfo.stockNames.has(nm);
                    const tier = hr ? 0 : (r !== null ? 1 : 2);
                    return { s, pos, ratio: r, digitGap: dg, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                        if (a.digitGap === null) return 1;
                        if (b.digitGap === null) return -1;
                        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                        return b.ratio - a.ratio;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
            }

            if (sortState.byJingYestRatio) {
                const info = ratioDiff;
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                    const tier = ih ? 0 : 1;
                    const fi = ih ? (info ? info.get(nm) : null) : null;
                    return { s, pos, jr: fi ? fi.jingRatio : null, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0) {
                        if (a.jr === null && b.jr === null) return a.pos - b.pos;
                        if (a.jr === null) return 1;
                        if (b.jr === null) return -1;
                        return b.jr - a.jr;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
            }

            if (sortState.byThreeDayJingDie) {
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    const dd = nm && threeDayJingDieSet ? (threeDayJingDieSet.get(nm) || 0) : 0;
                    const vol = parseFloat(s.volume) || 0;
                    const yvol = parseFloat(s.yestVolume) || 0;
                    const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                    return { s, pos, dd, jr };
                }).sort((a, b) => {
                    if (a.dd !== b.dd) return b.dd - a.dd;
                    if (a.jr === null && b.jr === null) return a.pos - b.pos;
                    if (a.jr === null) return 1;
                    if (b.jr === null) return -1;
                    return a.jr - b.jr;
                }).map(x => x.s);
            }

            if (sortState.byParallel && parallelStockNames) {
                const info = ratioDiff;
                if (sortState.byJingYest) {
                    return stocks.map((s, pos) => {
                        const nm = s.stock ? s.stock.trim() : '';
                        const ip = parallelStockNames.has(nm);
                        const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                        const tier = ih ? 0 : (ip ? 1 : 2);
                        const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                        return { s, pos, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null, tier };
                    }).sort((a, b) => {
                        if (a.tier !== b.tier) return a.tier - b.tier;
                        if (a.tier === 0 || a.tier === 1) {
                            if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                            if (a.digitGap === null) return 1;
                            if (b.digitGap === null) return -1;
                            if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                            return b.diff - a.diff;
                        }
                        return a.pos - b.pos;
                    }).map(x => x.s);
                }
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    const q = nm && parallelStockNames.has(nm);
                    const fi = q ? (info ? info.get(nm) : null) : null;
                    return { s, pos, q, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null };
                }).sort((a, b) => {
                    if (a.q !== b.q) return a.q ? -1 : 1;
                    if (a.q) {
                        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                        if (a.digitGap === null) return 1;
                        if (b.digitGap === null) return -1;
                        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
    window.useAuctionSort = useAuctionSort;
            }

            return stocks;
        }
        window.sortPage2GroupStocks = sortPage2GroupStocks;

        return { sortPage1RenderOrder: window.sortPage1RenderOrder, sortPage2GroupStocks: window.sortPage2GroupStocks };
    }

    // ============================================================
    // Composable: useAuctionExpand
    // ------------------------------------------------------------
    // 封装股票趋势面板与题材分组的展开/收起状态计算（无副作用）。
    // 真实 DOM 展开/恢复由 useAuctionEvents / 遗留全局函数在组件事件后执行。
    // ============================================================
    function useAuctionExpand() {
        function isStockExpanded(stockName, dataSource) {
            if (!stockName) return false;
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            return window.auctionStore.currentGroup === tab && window.auctionStore.expandedStocks.has(stockName);
        }
        window.isStockExpanded = isStockExpanded;

        function isP2TopicExpanded(topic, dataSource) {
            if (!topic) return false;
            const key = (dataSource === 'hot' ? 'hot' : 'auction') + '|' + topic;
            return window.auctionStore.p2ExpandedTopics.has(key);
        }
        window.isP2TopicExpanded = isP2TopicExpanded;

        function isExpandAll(page, dataSource) {
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            if (page === 2) return window.auctionStore.expandAllP2;
            return window.auctionStore.expandAll;
        }
    window.useAuctionExpand = useAuctionExpand;
    window.isExpandAll = isExpandAll;

        return { isStockExpanded, isP2TopicExpanded, isExpandAll };
    }

    // ============================================================
    // Composable: useAuctionGesture
    // ------------------------------------------------------------
    // 封装滑动容器的手势处理逻辑。
    // ============================================================
    function useAuctionGesture() {
        function useSwipe(store) {
            let touchStartX = 0;
            let touchStartY = 0;

            function onTouchStart(e) {
                touchStartX = e.changedTouches[0].screenX;
                touchStartY = e.changedTouches[0].screenY;
            }
            window.onTouchStart = onTouchStart;

            function onTouchEnd(e) {
                const dx = e.changedTouches[0].screenX - touchStartX;
                const dy = e.changedTouches[0].screenY - touchStartY;
                if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
                if (!store || !store.actions) return;
                if (dx < 0 && store.currentPage < 3) store.actions.switchPage(store.currentPage + 1);
                else if (dx > 0 && store.currentPage > 0) store.actions.switchPage(store.currentPage - 1);
            }
            window.onTouchEnd = onTouchEnd;
            window.useSwipe = useSwipe;
        }

        
        window.useAuctionGesture = useAuctionGesture;
        return { onTouchStart: window.onTouchStart, onTouchEnd: window.onTouchEnd };
    }

    // ============================================================
    // Composable: useAuctionEvents
    // ------------------------------------------------------------
    // 统一包装全局交互函数，提供安全调用与清晰降级。
    // 组件中不再直接调用 window.xxx，而是通过此 composable 返回的 handlers。
    // ============================================================
    function useAuctionEvents() {
        const safeCall = window.safeCall;

        function createHandlers(dataSource) {
            const ds = dataSource === 'hot' ? 'hot' : 'auction';
            const actions = window.auctionStore.actions;

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
                    window.safeCall(window.toggleAuctionTrendPanel, index);
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
                        window.safeCall(window.toggleAuctionTrendPanelP2, row.rowKey, row.stock);
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
        window.createHandlers = createHandlers;

        return { createHandlers, safeCall };
    }

    window.useAuctionEvents = useAuctionEvents;

    // 暴露到 window
    window.useAuctionData = useAuctionData;
    window.useAuctionSort = useAuctionSort;
    window.useAuctionExpand = useAuctionExpand;
    window.useAuctionGesture = useAuctionGesture;
    window.useAuctionEvents = useAuctionEvents;

    if (typeof window._dbgLog === 'function') window._dbgLog('[AUCTION-COMPOSABLES] 可复用逻辑层已就绪');
})();
