import { state } from '../logic/app-state.js';
        // ===== daily_highlights 表操作（预计算竞/昨高光，加速加载）=====

        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';


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
