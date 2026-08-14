// legacy-migration.js
//
// 一次性数据迁移（历史兼容层），从 app-core.js 抽离（见架构规范 §13 Migration / §16 纯 Vue3 红线）。
//
// 这些函数只在"旧架构 → 新架构"拆表过渡期起作用，属于历史兼容层，不应该留在核心业务模块里：
//   - migrateAuctionToTable：把本地 localStorage 旧 allData.auction 按 in_watchlist 拆到
//     auction_watchlist 与 market_metrics(scope='auction')。
//   - migrateAuctionDataToNewTables：从旧 Supabase 表 auction_data 读取并按 in_watchlist 拆分。
//
// 重要（数据安全红线 §11）：这两个函数读取的是【旧表/旧结构】的 in_watchlist 列，用于一次性拆表，
// 与早盘竞价"成员身份单判定"活路径（_auctionWatchlistIndex）无关，不构成双标准 bug。
// 它们全部由 localStorage 标记 + "旧表/列不存在则 no-op" 双重保护，迁移完成后天然空转，
// 但不可删除——否则尚未完成迁移的用户/设备会失去最后一道数据保护。
//
// 本文件是唯一允许出现 in_watchlist 字段读取的地方（历史兼容层），活路径已零引用。

import { state } from '../logic/app-state.js';
import { getSupabase } from './supabase-client.js';
// getAuctionData 是 app-core 内定义的本地函数（return getGroupData('auction')），仅此处历史迁移需要，故从 app-core 引入。
import { getAuctionData } from '../logic/app-core.js';

// 一次性迁移：将本地 allData.auction 按 in_watchlist 拆到 auction_watchlist 与 market_metrics(scope='auction')。
// 拆表后：in_watchlist===true 的行进入 auction_watchlist；in_watchlist!==true 的行进入 market_metrics(scope='auction')。
export async function migrateAuctionToTable() {
    if (localStorage.getItem('_auction_table_migrated') === '1') { // 合规：一次性迁移标记（§8 允许）
        state._auctionTableAvailable = true; // 已迁移过，标记表可用
        state._marketMetricsTableAvailable = true;
        return;
    }
    const auctionData = getAuctionData();
    const dates = Object.keys(auctionData).filter(function(d) {
        return Array.isArray(auctionData[d]) && auctionData[d].length > 0;
    });
    if (dates.length === 0) {
        // 本地无数据，检查新表是否可用（尝试读一行）
        try {
            const sb = getSupabase();
            let watchlistOk = false;
            let metricsOk = false;
            try {
                const { error } = await sb.from('auction_watchlist').select('date').limit(1);
                if (!error) watchlistOk = true;
            } catch(e) {}
            try {
                const { error } = await sb.from('market_metrics').select('date').eq('scope', 'auction').limit(1);
                if (!error) metricsOk = true;
            } catch(e) {}
            if (watchlistOk || metricsOk) {
                state._auctionTableAvailable = watchlistOk;
                state._marketMetricsTableAvailable = metricsOk;
                localStorage.setItem('_auction_table_migrated', '1'); // 合规：一次性迁移标记（§8 允许）
                console.log('[迁移] 本地无 auction 数据，auction_watchlist/market_metrics 表已就绪');
            }
        } catch(e) { console.warn('[迁移] 表不可用:', e.message); }
        return;
    }
    const sb = getSupabase();
    const scMap = state._scMapCache || {};
    const now = new Date().toISOString();
    let watchlistRows = 0;
    let metricsRows = 0;
    let hadError = false;
    for (let di = 0; di < dates.length; di++) {
        var date = dates[di];
        var watchlistBatch = [];
        var metricsBatch = [];
        auctionData[date].forEach(function(item) {
            if (!item || !item.stock) return;
            var nameTrim = item.stock.trim();
            var baseRow = {
                date: date, stock: nameTrim,
                code: scMap[nameTrim] || item.code || '',
                volume: item.volume || '', yest_volume: item.yestVolume || '',
                change_pct: item.changePct || '',
                updated_at: now, updated_by: 'main'
            };
            if (item.in_watchlist !== false) {
                watchlistBatch.push(Object.assign({}, baseRow, {
                    note: item.note || '',
                    topics: item.topics || '',
                    source: item.source || 'manual',
                    selected: item.selected || false, bought: item.bought || false,
                    sold: item.sold || false, fixed: item.fixed || false,
                    obs_auto_added: !!item.obsAutoAdded
                }));
            } else {
                metricsBatch.push(Object.assign({}, baseRow, {
                    scope: 'auction',
                    source: item.source || 'manual'
                }));
            }
        });
        try {
            if (watchlistBatch.length > 0) {
                var { error } = await sb.from('auction_watchlist')
                    .upsert(watchlistBatch, { onConflict: 'date,stock', ignoreDuplicates: true });
                if (error) {
                    console.warn('[迁移] 日期', date, 'auction_watchlist 失败:', error.message);
                    hadError = true;
                    if (error.message && error.message.indexOf('relation') >= 0) return;
                } else {
                    watchlistRows += watchlistBatch.length;
                }
            }
            if (metricsBatch.length > 0) {
                var { error } = await sb.from('market_metrics')
                    .upsert(metricsBatch, { onConflict: 'date,stock,scope', ignoreDuplicates: true });
                if (error) {
                    console.warn('[迁移] 日期', date, 'market_metrics 失败:', error.message);
                    hadError = true;
                    if (error.message && error.message.indexOf('relation') >= 0) return;
                } else {
                    metricsRows += metricsBatch.length;
                }
            }
        } catch(e) {
            console.warn('[迁移] 日期', date, '异常:', e.message);
            hadError = true;
            return; // 表可能不存在，中止迁移
        }
    }
    // 只有迁移成功（无错误）或表确实可用时才标记
    if (!hadError || watchlistRows > 0 || metricsRows > 0) {
        state._auctionTableAvailable = true;
        state._marketMetricsTableAvailable = true;
        localStorage.setItem('_auction_table_migrated', '1'); // 合规：一次性迁移标记（§8 允许）
        console.log('[迁移] auction_watchlist 已灌入 ' + watchlistRows + ' 条，market_metrics(scope=auction) 已灌入 ' + metricsRows + ' 条');
    } else {
        console.warn('[迁移] 迁移失败，auction 表标记为不可用，保留本地数据');
    }
}

// 一次性迁移：从旧 auction_data 表读取全部数据，按 in_watchlist 拆到
// auction_watchlist 与 market_metrics(scope='auction')，并在 localStorage 标记已迁移。
export async function migrateAuctionDataToNewTables() {
    const sb = getSupabase();
    const alreadyMigrated = localStorage.getItem('_auction_data_migrated_to_new_tables') === '1'; // 合规：一次性迁移标记（§8 允许）

    // 兜底：即使标记已存在，如果 auction_watchlist 为空而 auction_data 仍有数据，说明 SQL/前次迁移未跑完，强制重迁
    let needForceMigrate = false;
    if (alreadyMigrated) {
        try {
            const { count: wlCount, error: wlErr } = await sb.from('auction_watchlist')
                .select('*', { count: 'exact', head: true });
            const { count: oldCount, error: oldErr } = await sb.from('auction_data')
                .select('*', { count: 'exact', head: true });
            if (!wlErr && !oldErr && (wlCount || 0) === 0 && (oldCount || 0) > 0) {
                needForceMigrate = true;
                console.warn('[迁移] 标记已存在但 auction_watchlist 为空、auction_data 仍有数据，强制重新迁移');
                localStorage.removeItem('_auction_data_migrated_to_new_tables');
            }
        } catch (e) {
            // 忽略兜底检查错误，继续走正常逻辑
        }
    }

    if (alreadyMigrated && !needForceMigrate) {
        state._auctionTableAvailable = true;
        state._marketMetricsTableAvailable = true;
        return;
    }
    try {
        const allRows = [];
        let offset = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await sb.from('auction_data')
                .select('date,stock,code,volume,yest_volume,note,change_pct,topics,in_watchlist,selected,bought,sold,fixed,obs_auto_added,source')
                .range(offset, offset + pageSize - 1);
            if (error) {
                if (error.message && error.message.indexOf('relation') >= 0) {
                    console.log('[迁移] 旧 auction_data 表不存在，无需迁移');
                    localStorage.setItem('_auction_data_migrated_to_new_tables', '1'); // 合规：一次性迁移标记（§8 允许）
                    state._auctionTableAvailable = true;
                    state._marketMetricsTableAvailable = true;
                    return;
                }
                throw error;
            }
            if (!data || data.length === 0) break;
            allRows.push(...data);
            if (data.length < pageSize) break;
            offset += pageSize;
        }
        if (allRows.length === 0) {
            localStorage.setItem('_auction_data_migrated_to_new_tables', '1'); // 合规：一次性迁移标记（§8 允许）
            state._auctionTableAvailable = true;
            state._marketMetricsTableAvailable = true;
            console.log('[迁移] 旧 auction_data 表无数据，已标记迁移完成');
            return;
        }
        const now = new Date().toISOString();
        const watchlistBatch = [];
        const metricsBatch = [];
        allRows.forEach(function(row) {
            if (!row || !row.date || !row.stock) return;
            const watchlistRow = {
                date: row.date, stock: row.stock.trim(),
                code: row.code || '',
                volume: row.volume || '', yest_volume: row.yest_volume || '', note: row.note || '',
                change_pct: row.change_pct || '', topics: row.topics || '',
                source: row.source || 'manual',
                selected: row.selected || false, bought: row.bought || false,
                sold: row.sold || false, fixed: row.fixed || false,
                obs_auto_added: row.obs_auto_added || false,
                updated_at: now, updated_by: 'main_migrate'
            };
            const metricsRow = {
                date: row.date, stock: row.stock.trim(), scope: 'auction',
                code: row.code || '',
                volume: row.volume || '', yest_volume: row.yest_volume || '',
                change_pct: row.change_pct || '',
                source: row.source || 'manual',
                updated_at: now, updated_by: 'main_migrate'
            };
            if (row.in_watchlist === true) {
                watchlistBatch.push(watchlistRow);
            } else {
                metricsBatch.push(metricsRow);
            }
        });
        if (watchlistBatch.length > 0) {
            const { error } = await sb.from('auction_watchlist')
                .upsert(watchlistBatch, { onConflict: 'date,stock', ignoreDuplicates: true });
            if (error) throw error;
        }
        if (metricsBatch.length > 0) {
            const { error } = await sb.from('market_metrics')
                .upsert(metricsBatch, { onConflict: 'date,stock,scope', ignoreDuplicates: true });
            if (error) throw error;
        }
        state._auctionTableAvailable = true;
        state._marketMetricsTableAvailable = true;
        localStorage.setItem('_auction_data_migrated_to_new_tables', '1'); // 合规：一次性迁移标记（§8 允许）
        console.log('[迁移] 旧 auction_data 已拆分：auction_watchlist ' + watchlistBatch.length + ' 条，market_metrics(scope=auction) ' + metricsBatch.length + ' 条');
    } catch (e) {
        console.warn('[迁移] 旧 auction_data 拆分失败:', e.message);
    }
}
