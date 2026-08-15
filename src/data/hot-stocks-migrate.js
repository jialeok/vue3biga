// hot-stocks 物理拆分子模块：一次性迁移（热门股票共享数据层）
// 本文件承接 hot-stocks.js 的「一次性迁移」职责。函数体逻辑与原始实现完全一致，仅移动位置。
// 这些迁移函数被 LoginOverlay.vue 调用，删之会让历史影子/趋势数据无法搬迁。详见 MIGRATION_TASKLIST.md 第十四章。
// ============================================================

import { state } from '../logic/app-state.js';
import { getSupabase } from './supabase-client.js';

// 一次性迁移：把旧 hot_stocks 表中 in_watchlist=false 的影子记录迁移到 market_metrics(scope='hot')，
// 并在原表物理删除。新 hot_stocks 表不再保留 in_watchlist 列，每行天然是正式成员。
export async function migrateHotStocksShadowToMetrics() {
    const key = '_hot_stocks_shadow_migrated_to_metrics';
    if (localStorage.getItem(key) === '1') return; // 合规：一次性迁移标记（§8 允许）
    try {
        const sb = getSupabase();
        const shadowRows = [];
        let offset = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await sb.from('hot_stocks')
                .select('date,stock,code,volume,yest_volume,change_pct,in_watchlist')
                .eq('in_watchlist', false)
                .range(offset, offset + pageSize - 1);
            if (error) {
                // 新表已无 in_watchlist 列，查询会报错，视为无需迁移
                if (error.message && (error.message.indexOf('in_watchlist') >= 0 || error.message.indexOf('column') >= 0 || error.message.indexOf('does not exist') >= 0)) {
                localStorage.setItem(key, '1'); // 合规：一次性迁移标记（§8 允许）
                return;
                }
                throw error;
            }
            if (!data || data.length === 0) break;
            shadowRows.push(...data);
            if (data.length < pageSize) break;
            offset += pageSize;
        }
        if (shadowRows.length === 0) {
            localStorage.setItem(key, '1'); // 合规：一次性迁移标记（§8 允许）
            console.log('[迁移] hot_stocks 无影子记录，无需迁移到 market_metrics(scope=hot)');
            return;
        }
        const now = new Date().toISOString();
        const batchSize = 500;
        let migrated = 0;
        for (let i = 0; i < shadowRows.length; i += batchSize) {
            const chunk = shadowRows.slice(i, i + batchSize).map(function(r) {
                return {
                    date: r.date,
                    stock: r.stock.trim(),
                    code: r.code || '',
                    volume: r.volume || '',
                    yest_volume: r.yest_volume || '',
                    change_pct: r.change_pct || '',
                    scope: 'hot',
                    source: 'main_migrate_shadow',
                    updated_at: now,
                    updated_by: 'main_migrate_shadow'
                };
            });
            const { error: upErr } = await sb.from('market_metrics')
                .upsert(chunk, { onConflict: 'date,stock,scope', ignoreDuplicates: true });
            if (upErr) {
                console.warn('[迁移] 影子记录写入 market_metrics 批次失败:', upErr.message);
                if (upErr.message && upErr.message.indexOf('relation') >= 0) return;
            } else {
                migrated += chunk.length;
            }
        }
        // 物理删除原表中的影子记录
        const datesMap = {};
        shadowRows.forEach(function(r) {
            if (!datesMap[r.date]) datesMap[r.date] = [];
            datesMap[r.date].push(r.stock.trim());
        });
        // 逐条删除 + 错误收集：避免单条失败被 Promise.all 静默吞掉，留下不一致迁移状态
        const failedDeletes = [];
        for (const d of Object.keys(datesMap)) {
            try {
                const { error } = await sb.from('hot_stocks')
                    .delete()
                    .eq('date', d)
                    .in('stock', datesMap[d]);
                if (error) failedDeletes.push({ date: d, reason: error.message });
            } catch (e) {
                failedDeletes.push({ date: d, reason: e && e.message });
            }
        }
        if (failedDeletes.length > 0) {
            failedDeletes.forEach(function(f) {
                console.error('[迁移] 影子记录物理删除失败 (date=' + f.date + '):', f.reason);
            });
        }
        localStorage.setItem(key, '1'); // 合规：一次性迁移标记（§8 允许）
        console.log('[迁移] hot_stocks 影子记录已迁移', migrated, '行到 market_metrics(scope=hot)');
    } catch (e) {
        console.warn('[迁移] hot_stocks 影子记录迁移失败:', e.message);
    }
}

// 一次性迁移：把 hot_stocks 表中已有的 volume/yest_volume/change_pct 灌入 hot_stock_trends 表
export async function migrateHotStocksToTrendsTable() {
    if (localStorage.getItem('_hot_trends_table_migrated') === '1') { // 合规：一次性迁移标记（§8 允许）
        state._hotTrendsTableAvailable = true;
        return;
    }
    try {
        const sb = getSupabase();
        const allRows = [];
        let offset = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await sb.from('hot_stocks')
                .select('date,stock,code,volume,yest_volume,change_pct')
                .range(offset, offset + pageSize - 1);
            if (error) throw error;
            if (!data || data.length === 0) break;
            allRows.push(...data);
            if (data.length < pageSize) break;
            offset += pageSize;
        }
        const validRows = allRows.filter(function(r) {
            if (!r || !r.date || !r.stock) return false;
            return (r.volume && String(r.volume).trim()) ||
                   (r.yest_volume && String(r.yest_volume).trim()) ||
                   (r.change_pct && String(r.change_pct).trim());
        });
        if (validRows.length === 0) {
            state._hotTrendsTableAvailable = true;
            localStorage.setItem('_hot_trends_table_migrated', '1'); // 合规：一次性迁移标记（§8 允许）
            console.log('[迁移] hot_stocks 无可迁移的趋势数据，hot_stock_trends 表已就绪');
            return;
        }
        const now = new Date().toISOString();
        const batchSize = 500;
        let migrated = 0;
        for (let i = 0; i < validRows.length; i += batchSize) {
            const chunk = validRows.slice(i, i + batchSize).map(function(r) {
                return {
                    date: r.date,
                    stock: r.stock.trim(),
                    code: r.code || '',
                    volume: r.volume || '',
                    yest_volume: r.yest_volume || '',
                    change_pct: r.change_pct || '',
                    updated_at: now,
                    updated_by: 'main_migrate'
                };
            });
            const { error: upErr } = await sb.from('hot_stock_trends')
                .upsert(chunk, { onConflict: 'date,stock', ignoreDuplicates: true });
            if (upErr) {
                console.warn('[迁移] 批次失败:', upErr.message);
                if (upErr.message && upErr.message.indexOf('relation') >= 0) return;
            } else {
                migrated += chunk.length;
            }
        }
        state._hotTrendsTableAvailable = true;
        localStorage.setItem('_hot_trends_table_migrated', '1');
        console.log('[迁移] hot_stock_trends 已迁移', migrated, '行趋势数据');
    } catch (e) {
        console.warn('[迁移] hot_stock_trends 迁移失败:', e.message);
    }
}

// 一次性迁移：把 hot_stock_trends 表中已有的趋势数据灌入 market_metrics(scope='hot')
// 拆表后统一读 market_metrics，旧数据需要同步一份过去。
export async function migrateHotTrendsToMarketMetrics() {
    if (localStorage.getItem('_hot_trends_migrated_to_market_metrics') === '1') { // 合规：一次性迁移标记（§8 允许）
        state._marketMetricsTableAvailable = true;
        return;
    }
    try {
        const sb = getSupabase();
        const allRows = [];
        let offset = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await sb.from('hot_stock_trends')
                .select('date,stock,code,volume,yest_volume,change_pct')
                .range(offset, offset + pageSize - 1);
            if (error) {
                if (error.message && error.message.indexOf('relation') >= 0) {
                    console.log('[迁移] 旧 hot_stock_trends 表不存在，无需迁移到 market_metrics');
                    localStorage.setItem('_hot_trends_migrated_to_market_metrics', '1'); // 合规：一次性迁移标记（§8 允许）
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
            localStorage.setItem('_hot_trends_migrated_to_market_metrics', '1');
            state._marketMetricsTableAvailable = true;
            console.log('[迁移] hot_stock_trends 无数据，market_metrics(scope=hot) 无需迁移');
            return;
        }
        const now = new Date().toISOString();
        const batchSize = 500;
        let migrated = 0;
        for (let i = 0; i < allRows.length; i += batchSize) {
            const chunk = allRows.slice(i, i + batchSize).map(function(r) {
                return {
                    date: r.date,
                    stock: r.stock.trim(),
                    code: r.code || '',
                    volume: r.volume || '',
                    yest_volume: r.yest_volume || '',
                    change_pct: r.change_pct || '',
                    scope: 'hot',
                    source: 'main_migrate',
                    updated_at: now,
                    updated_by: 'main_migrate'
                };
            });
            const { error: upErr } = await sb.from('market_metrics')
                .upsert(chunk, { onConflict: 'date,stock,scope', ignoreDuplicates: true });
            if (upErr) {
                console.warn('[迁移] 批次写入 market_metrics 失败:', upErr.message);
                if (upErr.message && upErr.message.indexOf('relation') >= 0) return;
            } else {
                migrated += chunk.length;
            }
        }
        state._marketMetricsTableAvailable = true;
        localStorage.setItem('_hot_trends_migrated_to_market_metrics', '1');
        console.log('[迁移] hot_stock_trends → market_metrics(scope=hot) 已迁移', migrated, '行');
    } catch (e) {
        console.warn('[迁移] hot_stock_trends → market_metrics 迁移失败:', e.message);
    }
}
