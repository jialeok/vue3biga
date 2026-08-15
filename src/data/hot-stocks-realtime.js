// hot-stocks 物理拆分子模块：Realtime 订阅 + 统一防抖池（热门股票共享数据层）
// 本文件承接 hot-stocks.js 的「Realtime 订阅」职责。函数体逻辑与原始实现完全一致，仅移动位置。
// 受保护共享符号（startHotStocksRealtime / startHotHighlightsRealtime / startHotTrendsRealtime）
// 保留于此，未作任何改写。详见 MIGRATION_TASKLIST.md 第十四章。
// ============================================================

import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
import { getSupabase } from './supabase-client.js';
import { loadHotStocksFromCloud, pullHotStocksHighlights, loadHotTrendsFromCloud } from './hot-stocks-cloud.js';

// 热门股票tap：三张表（hot_stocks / hot_stocks_highlights / hot_stock_trends）的
// Realtime 订阅共用同一个"统一防抖池"。
// 背景：这三张表各自有独立订阅，一次补数据操作（如"两全昨日成交量"）常常同时
// 触发 hot_stocks 和 hot_stock_trends 两张表的变化，若各自独立 800ms 防抖、各自独立
// 调用 renderHotStocks()，会导致极短时间内热门股票列表的 DOM 被连续整体重建 2~3 次。
// 用户点击"序号"展开趋势图的瞬间，若恰好撞上这类连锁重渲染，点击的目标节点已被替换，
// 事件效果丢失，表现为"卡顿、有时点不出来"。而早盘竞价 tap 也已拆成 auction_watchlist +
// market_metrics 两张表、统一一个防抖池，不会有这个问题，所以体验更流畅。
// 统一后：不论哪张表先收到变化通知，都汇入同一个定时器，到点后按需重新拉取各自数据，
// 最后只调用一次 renderHotStocks()。
state._hotAuctionRealtimeTimer = null;
state._pendingHotRealtimeDates = new Set();
state._pendingHotReload = { stocks: false, highlights: false, trends: false };
export function _scheduleHotRealtimeReload() {
    if (state._hotAuctionRealtimeTimer) clearTimeout(state._hotAuctionRealtimeTimer);
    state._hotAuctionRealtimeTimer = setTimeout(function() {
        var need = state._pendingHotReload;
        state._pendingHotReload = { stocks: false, highlights: false, trends: false };
        state._hotAuctionRealtimeTimer = null;
        var tasks = [];
        if (need.stocks) {
            tasks.push(loadHotStocksFromCloud().catch(function(e) {
                console.warn('Realtime loadHotStocksFromCloud 失败:', e);
            }));
        }
        if (need.highlights) {
            tasks.push(pullHotStocksHighlights().catch(function(e) {
                console.warn('hot_stocks_highlights Realtime 重载失败:', e);
            }));
        }
        if (need.trends) {
            tasks.push(loadHotTrendsFromCloud().catch(function(e) {
                console.warn('hot_stock_trends Realtime 重载失败:', e);
            }));
        }
        Promise.all(tasks).then(function() {
            _emit('data:realtime-update', { boards: 'hot' }); // 三张表变化只触发这一次整体重渲染
        });
    }, 800);
}
export function _debounceHotAuctionRealtime(date) {
    state._pendingHotRealtimeDates.add(date);
    state._pendingHotReload.stocks = true;
    _scheduleHotRealtimeReload();
}

export function startHotStocksRealtime() {
    stopHotStocksRealtime();
    try {
        const sb = getSupabase();
        state._hotAuctionRealtimeChannel = sb
            .channel('hot_stocks_changes')
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'hot_stocks'
            }, function(payload) {
                if (state._justPushedHotAuction) return; // 自己刚推的，忽略
                const row = payload.new || payload.old;
                if (!row || !row.date) return;
                _debounceHotAuctionRealtime(row.date);
            })
            .subscribe();
        console.log('Hot Stocks Realtime 订阅已启动');
    } catch (e) {
        console.error('Hot Stocks Realtime 订阅失败:', e);
    }
}

export function stopHotStocksRealtime() {
    if (state._hotAuctionRealtimeChannel) {
        try { getSupabase().removeChannel(state._hotAuctionRealtimeChannel); } catch(e) {}
        state._hotAuctionRealtimeChannel = null;
    }
}

// hot_stocks_highlights 表 Realtime 订阅
state._hotHighlightsReloadTimer = null;
export function startHotHighlightsRealtime() {
    stopHotHighlightsRealtime();
    try {
        const sb = getSupabase();
        state._hotHighlightsChannel = sb
            .channel('hot_stocks_highlights_changes')
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'hot_stocks_highlights'
            }, function(payload) {
                if (state._justPushedHotHighlights) return; // 自己刚推的，忽略（防自循环）
                var row = payload.new || payload.old;
                if (!row || !row.date) return;
                // 汇入统一防抖池，避免和 hot_stocks / hot_stock_trends 各自独立触发重渲染
                state._pendingHotReload.highlights = true;
                _scheduleHotRealtimeReload();
            })
            .subscribe();
        console.log('hot_stocks_highlights Realtime 订阅已启动');
    } catch (e) { console.error('hot_stocks_highlights Realtime 订阅失败:', e); }
}

export function stopHotHighlightsRealtime() {
    if (state._hotHighlightsChannel) {
        try { state._hotHighlightsChannel.unsubscribe(); } catch(e) {}
        state._hotHighlightsChannel = null;
    }
}

// hot 趋势 Realtime 订阅：同时监听 market_metrics(scope='hot') 与旧 hot_stock_trends
// 拆表后统一写 market_metrics，但保留对旧表的监听以兼容未升级客户端。
export function startHotTrendsRealtime() {
    stopHotTrendsRealtime();
    try {
        const sb = getSupabase();
        state._hotTrendsRealtimeChannel = sb
            .channel('hot_stock_trends_changes')
            .on('postgres_changes', {
                event: '*', schema: 'public', table: 'hot_stock_trends'
            }, function(payload) {
                if (state._justPushedHotTrends) return;
                var row = payload.new || payload.old;
                if (!row || !row.date) return;
                state._pendingHotReload.trends = true;
                _scheduleHotRealtimeReload();
            })
            .subscribe();
        // [FIX P1-9] market_metrics(scope='hot') 的订阅已去重：不再由本模块重复订阅同一张表，
        // 统一交由 watchlist-and-metrics.js 的 market_metrics 权威订阅处理，并在其回调中
        // 调用下方 triggerHotMetricsRealtimeReload() 触发热门股票看板刷新（详见 watchlist-and-metrics.js）。
        // 这样既消除双 channel 重复订阅（§31/§39），又保证 hot 看板的更新不丢失。
        console.log('hot trends Realtime 订阅已启动（hot_stock_trends；market_metrics 由 watchlist-and-metrics 统一订阅）');
    } catch (e) {
        console.error('hot trends Realtime 订阅失败:', e);
    }
}

export function stopHotTrendsRealtime() {
    if (state._hotTrendsRealtimeChannel) {
        try { getSupabase().removeChannel(state._hotTrendsRealtimeChannel); } catch(e) {}
        state._hotTrendsRealtimeChannel = null;
    }
    // [FIX P1-9] market_metrics(scope='hot') 订阅已移至 watchlist-and-metrics.js，此处不再持有该 channel
}

// [FIX P1-9] market_metrics(scope='hot') 变化的统一刷新入口（由 watchlist-and-metrics.js 的
// 权威 market_metrics 订阅回调调用）。保留原 hot-stocks 订阅回调的全部本地逻辑：
// 自推送屏蔽 + 置位 _pendingHotReload.stocks + 走统一防抖池触发 loadHotStocksFromCloud 刷新热门看板。
// 这样把"重复订阅"改为"复用共享刷新函数"，确保 hot 看板更新不丢失（§39 不破坏同步/不造重复订阅）。
export function triggerHotMetricsRealtimeReload(date) {
    if (state._justPushedHotAuction || state._justPushedHotTrends) return; // 自己刚推的，忽略
    if (!date) return;
    state._pendingHotReload.stocks = true; // market_metrics变化影响_hotFullRowCache，需触发loadHotStocksFromCloud
    _scheduleHotRealtimeReload();
}
