﻿﻿﻿import { getTodayDuiban, getAuctionTagState } from '../logic/ui-bridge.js';
/**
 * useAuctionData.js
 * 早盘竞价看板数据获取 composable（Vue 3）
 *
 * 职责：封装当前/前序交易日列表、标签状态缓存、信号集合等纯数据获取。
 * 从 src/ui/composables/auction-composables.js 拆分而来，去 window 化为 ES module。
 */
import { ref, computed } from 'vue';
import { getTodayGroupList, getGroupData, getAuctionData } from '../logic/app-core-api.js';
import { getNumericVolume, getStocksData } from '../data/supabase-client.js';
import {
    getHighRatioStocksForDate,
    getParallelStocksForDate,
    getJingYestHighlightSetForDate,
    getRatioDiffInfoForDate
} from '../logic/auction-sort-rules.js';
import { _buildTagStateCache } from '../logic/tag-rules.js';
import { buildTopicCache } from '../data/stock-topics.js';
import { _dbgLog } from '../data/debug-log.js';
import { getPreviousTradingDay } from '../logic/trading-day-helpers.js';

// ============================================================
// Composable: useAuctionData
// ------------------------------------------------------------
// 封装当前/前序交易日列表、标签状态缓存、信号集合等纯数据获取。
// ============================================================
export function useAuctionData() {
    function getTodayList(dataSource) {
        return getTodayGroupList(dataSource);
    }

    function getPrevDate(date) {
        return getPreviousTradingDay(date);
    }

    function getPrevList(dataSource, date) {
        const prevDate = getPreviousTradingDay(date);
        return prevDate ? (getGroupData(dataSource)[prevDate] || []) : [];
    }

    function getPrevPrevList(dataSource, date) {
        const prevDate = getPreviousTradingDay(date);
        const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
        return prevPrevDate ? (getGroupData(dataSource)[prevPrevDate] || []) : [];
    }

    function ensureTopicCache(auctionList) {
        const needs = auctionList.some(function (it) {
            if (!it || !it.stock) return false;
            const note = getDisplayNote(it);
            return !note || extractTopics(note).length === 0;
        });
        if (needs) buildTopicCache();
    }

    function getTagStateCache(date) {
        return _buildTagStateCache(date);
    }

    function getHistRowMap(list) {
        const map = new Map();
        if (!list || !list.length) return map;
        for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (it && it.stock) map.set(it.stock.trim(), it);
        }
        return map;
    }

    function getHistoryCountMap(dataSource, date) {
        const auctionData = getGroupData(dataSource);
        const map = new Map();
        let d = date;
        for (let i = 0; i < 5 && d; i++) {
            const list = auctionData[d] || [];
            list.forEach(function (it) {
                if (!it || !it.stock) return;
                const name = it.stock.trim();
                if (!map.has(name)) map.set(name, 0);
                const v = getNumericVolume(it.volume);
                const yv = getNumericVolume(it.yestVolume);
                if (v !== null || yv !== null) map.set(name, map.get(name) + 1);
            });
            d = getPreviousTradingDay(d);
        }
        return map;
    }

    function getConfirmedSoldSet(auctionList, date) {
        const res = new Set();
        const sd = getStocksData();
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

    function getHighRatio(date, dataSource) {
        return getHighRatioStocksForDate(date, dataSource);
    }

    function getParallel(date, dataSource) {
        return getParallelStocksForDate(date, dataSource);
    }

    function getJingYest(date, dataSource) {
        return getJingYestHighlightSetForDate(date, dataSource);
    }

    function getRatioDiff(date, dataSource) {
        return getRatioDiffInfoForDate(date, dataSource);
    }

    function getSignalSets(date, dataSource, options) {
        const opts = options || {};
        return {
            highRatio: getHighRatio(date, dataSource),
            parallel: opts.parallel ? getParallel(date, dataSource) : null,
            jingYest: getJingYest(date, dataSource),
            ratioDiff: opts.ratioDiff ? getRatioDiff(date, dataSource) : null
        };
    }

    function getDuibanTushiLink() {
        const duibanList = getTodayDuiban();
        for (let i = 0; i < duibanList.length; i++) {
            const tushi = (duibanList[i] && duibanList[i].tushi) || '';
            if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
        }
        return '';
    }

    function getObsContext(date, dataSource) {
        const prevDate = getPreviousTradingDay(date);
        // 从 auctionBoardTags 派生 obsBoughtSet（当前生效的标签继承机制）。
        // 股票在前一交易日有 tag（buy/sell/hold）→ getAuctionTagState().source === 'inherited' → 进入观察组。
        // 旧机制写 obsBought_<date> 已废弃（ensureBoughtStocksForDate 无调用点）。
        const obsBoughtSet = new Set();
            if (getAuctionTagState && getAuctionData) {
            const auctionData = getAuctionData();
            const dayList = (auctionData && auctionData[date]) || [];
            dayList.forEach(function(item) {
                if (item && item.stock) {
                    const nm = item.stock.trim();
                    if (nm && getAuctionTagState(nm, date).source === 'inherited') {
                        obsBoughtSet.add(nm);
                    }
                }
            });
        }
        return {
            obsStocks: getJingYestHighlightSetForDate(prevDate, dataSource),
            autoAddedSet: new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]')), // 合规：防重复/调试标记（§8 允许）
            obsBoughtSet: obsBoughtSet
        };
    }

    return {
        getTodayList, getPrevDate, getPrevList, getPrevPrevList,
        ensureTopicCache, getTagStateCache, getHistRowMap, getHistoryCountMap,
        getConfirmedSoldSet,
        getHighRatio, getParallel, getJingYest, getRatioDiff, getSignalSets,
        getDuibanTushiLink, getObsContext
    };
}

_dbgLog('[USE-AUCTION-DATA] composable 已就绪');