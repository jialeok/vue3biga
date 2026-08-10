import { state } from '../logic/app-state.js';
        // ===== daily_highlights 表操作（预计算竞/昨高光，加速加载）=====

        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';
        import { pushHotStocksHighlights } from './hot-stocks.js';

        // 从 daily_highlights 表加载所有预计算高光（小表，快）
        export async function pullDailyHighlights() {
            const sb = getSupabase();
            const result = {};
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('daily_highlights')
                    .select('date,stock,jing_yest_highlight')
                    .eq('jing_yest_highlight', true)
                    .range(offset, offset + pageSize - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                data.forEach(function(row) {
                    if (!row.date || !row.stock) return;
                    if (!result[row.date]) result[row.date] = new Set();
                    result[row.date].add(row.stock.trim());
                });
                if (data.length < pageSize) break;
                offset += pageSize;
            }
            state._dailyHighlightsCache = result;
            state._highlightsTableAvailable = true;
            console.log('daily_highlights 加载完成:', Object.keys(result).length, '个日期');
        }

        // 推送某日期的高光到 daily_highlights 表（debounced）
        export function schedulePushDailyHighlights(date, highlightSet, dataSource) {
            if (dataSource === 'hot') {
                if (!state._hotHighlightsTableAvailable) return;
                if (state._hotHighlightsPushTimer) clearTimeout(state._hotHighlightsPushTimer);
                state._hotHighlightsPushTimer = setTimeout(function() {
                    state._hotHighlightsPushTimer = null;
                    pushHotStocksHighlights(date, highlightSet);
                }, 2000);
                return;
            }
            if (!state._highlightsTableAvailable) return;
            if (state._highlightsPushTimer) clearTimeout(state._highlightsPushTimer);
            state._highlightsPushTimer = setTimeout(function() {
                state._highlightsPushTimer = null;
                    pushDailyHighlights(date, highlightSet);
            }, 2000);
        }

        export async function pushDailyHighlights(date, highlightSet) {
            const sb = getSupabase();
            const now = new Date().toISOString();
            const stockNames = highlightSet ? [...highlightSet] : [];

            // [FIX 2026-07-24 自循环根治] 写入前与本地缓存比对，集合未变化时直接跳过。
            // 原实现每次 renderAuction 都无条件"全置false + 重新upsert"重写当日全部行；
            // daily_highlights 的 Realtime 订阅原先没有自推送屏蔽，收到自己刚写的变更后
            // 又触发 _scheduleAuctionRealtimeReload → renderAuction → 再次推送 → 无限自循环。
            // 实测线上每 4~5 秒重写一次当日全部行并整体重渲染看板（卡顿/耗电主因）。
            const cached = state._dailyHighlightsCache[date];
            if (cached && cached.size === stockNames.length &&
                stockNames.every(function(n) { return cached.has(n); })) {
                return; // 内容未变化：不写库、不触发 Realtime、不打断用户交互
            }

            // 自推送屏蔽：本次写入触发的 Realtime 通知直接忽略，避免自己卷自己
            state._justPushedHighlights = true;
            setTimeout(function() { state._justPushedHighlights = false; }, 5000);

            // 1. 先把该日期所有行标记为 false（清除旧高光）
            const { error: updErr } = await sb.from('daily_highlights')
                .update({ jing_yest_highlight: false, updated_at: now })
                .eq('date', date);
            if (updErr) console.warn('daily_highlights 清除旧高光失败:', updErr.message);

            // 2. 再把达标股票标记为 true（upsert）
            if (stockNames.length > 0) {
                const rows = stockNames.map(function(name) {
                    return { date: date, stock: name, jing_yest_highlight: true, updated_at: now };
                });
                const batchSize = 25;
                for (let i = 0; i < rows.length; i += batchSize) {
                    const { error: upErr } = await sb.from('daily_highlights')
                        .upsert(rows.slice(i, i + batchSize), { onConflict: 'date,stock' });
                    if (upErr) console.warn('daily_highlights upsert 失败:', upErr.message);
                }
            }

            // 更新本地缓存
            state._dailyHighlightsCache[date] = new Set(stockNames);
        }

        // 从缓存获取某日期的高光集合（无缓存返回 null，触发回退计算）
        // 'hot' 读 _hotHighlightsCache（hot_stocks_highlights 表），否则读 _dailyHighlightsCache（daily_highlights 表）
        export function getDailyHighlightsForDate(date, dataSource='auction') {
            if (dataSource === 'hot') {
                if (!state._hotHighlightsTableAvailable) return null;
                return state._hotHighlightsCache[date] || null;
            }
            if (!state._highlightsTableAvailable) return null;
            return state._dailyHighlightsCache[date] || null;
        }

        // daily_highlights 表 Realtime 订阅
        export function startHighlightsRealtime() {
            stopHighlightsRealtime();
            try {
                const sb = getSupabase();
                state._highlightsChannel = sb
                    .channel('daily_highlights_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'daily_highlights'
                    }, function(payload) {
                        if (state._justPushedHighlights) return; // 自己刚推的，忽略（防自循环）
                        var row = payload.new || payload.old;
                        if (!row || !row.date) return;
                        // 汇入与 auction_watchlist + market_metrics 共用的统一防抖池，避免两张表几乎同时变更时
                        // 各自独立触发 renderAuction 导致短时间内连续两次整体重渲染（见上方注释）
                        state._pendingAuctionReload.highlights = true;
                        state._scheduleAuctionRealtimeReload();
                    })
                    .subscribe();
                console.log('daily_highlights Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] highlights Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopHighlightsRealtime() {
            if (state._highlightsChannel) {
                try { state._highlightsChannel.unsubscribe(); } catch(e) {}
                state._highlightsChannel = null;
            }
        }
