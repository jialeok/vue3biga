import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
        // ===== stock_topics 表操作（题材库独立表）=====
        // 从 stock_topics 表全量读取，返回 {stockName: Set(topics)}
        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';

        export async function pullStockTopicsFromCloud() {
            const sb = getSupabase();
            const allRows = [];
            let from = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('stock_topics')
                    .select('stock,topics,code')
                    .range(from, from + pageSize - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                allRows.push(...data);
                if (data.length < pageSize) break;
                from += pageSize;
            }
            const result = {};
            allRows.forEach(function(row) {
                if (!row || !row.stock) return;
                const name = row.stock.trim();
                if (!row.topics) { result[name] = new Set(); return; }
                const topics = row.topics.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
                result[name] = new Set(topics);
            });
            return result;
        }

        // 把单只股票的题材写入云端 stock_topics 表（按 stock 维度，跨日期共享）
        // 用户在主程序编辑题材后调用，确保下次打开主程序时能从 stock_topics 表读到
        // 规则确认：新旧题材合并累加，同名去重，全部保留，不设数量上限——
        // 一只股票完全可能同时归属好几个题材分类（第二页题材分类要看全部），
        // 不能用"这次传入的"直接替换掉之前已经攒下的题材。
        export async function pushStockTopicsToCloud(stockName, topicsArray, code) {
            if (!stockName) return;
            const sb = getSupabase();
            const trimmedName = stockName.trim();
            const newTopics = (topicsArray || []).filter(t => t && t.trim()).map(t => t.trim());

            // 先取云端/本地缓存里该股票已有的题材，与本次新题材合并去重
            const existingSet = (state._cloudTopicsCache && state._cloudTopicsCache[trimmedName])
                ? new Set(state._cloudTopicsCache[trimmedName])
                : new Set();
            newTopics.forEach(function(t) { existingSet.add(t); });
            const mergedTopics = Array.from(existingSet);
            const topicsStr = mergedTopics.join(',');

            const row = {
                stock: trimmedName,
                topics: topicsStr,
                code: code || '',
                updated_at: new Date().toISOString()
            };
            const { error } = await sb.from('stock_topics')
                .upsert(row, { onConflict: 'stock' });
            if (error) throw error;

            // 同步更新本地缓存，避免下次 buildTopicCache 时丢失
            if (!state._cloudTopicsCache) state._cloudTopicsCache = {};
            state._cloudTopicsCache[trimmedName] = new Set(mergedTopics);
            if (state._topicCacheBuilt && state._topicCache) {
                state._topicCache[trimmedName] = new Set(mergedTopics);
            }
        }

        // 从云端加载题材库到内存缓存（非阻塞，失败只打日志）
        export async function loadCloudTopics() {
            try {
                state._cloudTopicsCache = await pullStockTopicsFromCloud();
                console.log('题材库加载完成:', Object.keys(state._cloudTopicsCache).length, '只股票');
            } catch (e) {
                console.warn('loadCloudTopics 失败，回退到本地扫描:', e.message);
                state._cloudTopicsCache = null;
            }
        }

        // 启动 stock_topics 表的 Realtime 订阅
        export function startStockTopicsRealtime() {
            stopStockTopicsRealtime();
            try {
                const sb = getSupabase();
                state._stockTopicsChannel = sb
                    .channel('stock_topics_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'stock_topics'
                    }, function(payload) {
                        // 题材库变更，重新拉取云端题材并刷新第二页
                        loadCloudTopics().then(function() {
                            invalidateTopicCache();
                            buildTopicCache();
                            _emit('data:realtime-update', { boards: 'auction' });
                        }).catch(function(e) { _dbgLog('[AUCTION-ERR] Stock topics Realtime 重建缓存 ' + (e && e.message || e)); });
                    })
                    .subscribe();
                console.log('Stock topics Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] Stock topics Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopStockTopicsRealtime() {
            if (state._stockTopicsChannel) {
                try { getSupabase().removeChannel(state._stockTopicsChannel); } catch(e) {}
                state._stockTopicsChannel = null;
            }
        }

        // ===== 题材缓存管理（从 logic/app-core.js 移至 data 层）=====
        export function scanDataSourceForTopics(dataSource) {
            const TOPIC_CACHE_DAYS = 66;
            const allDates = Object.keys(dataSource).sort();
            const recentDates = allDates.length > TOPIC_CACHE_DAYS
                ? allDates.slice(-TOPIC_CACHE_DAYS)
                : allDates;
            recentDates.forEach(date => {
                const dayList = dataSource[date] || [];
                dayList.forEach(item => {
                    if (!item.stock) return;
                    const name = item.stock.trim();
                    if (!state._topicCache[name]) state._topicCache[name] = new Set();
                    if (item.topics) {
                        item.topics.split(/[+，,，、;；]/).forEach(t => {
                            t = t.trim(); if (t) state._topicCache[name].add(t);
                        });
                    }
                    if (item.note) {
                        const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
                        bracketMatches.forEach(match => {
                            const topics = match.replace(/[()（）]/g, '').split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
                            topics.forEach(t => state._topicCache[name].add(t));
                        });
                    }
                });
            });
        }

        export function buildTopicCache() {
            if (state._topicCacheBuilt && state._topicCache) return state._topicCache;
            state._topicCache = {};

            if (state._cloudTopicsCache) {
                Object.keys(state._cloudTopicsCache).forEach(function(name) {
                    const topics = state._cloudTopicsCache[name];
                    if (topics && topics.size > 0) {
                        state._topicCache[name] = new Set(topics);
                    }
                });
            }

            const TOPIC_CACHE_DAYS = 66;
            scanDataSourceForTopics(state._auctionMemCache || {});
            scanDataSourceForTopics(state._hotAuctionData || {});
            state._topicCacheBuilt = true;
            return state._topicCache;
        }

        export function invalidateTopicCache() {
            state._topicCache = null;
            state._topicCacheBuilt = false;
            state._topicCacheVersion = (state._topicCacheVersion || 0) + 1;
            state._topicCacheInvalidateCount = (state._topicCacheInvalidateCount || 0) + 1;
            const __now = performance.now();
            if (state._topicCacheLastInvalidateTs && (__now - state._topicCacheLastInvalidateTs) < 2000) {
                _dbgLog('[PERF-DEBUG] 题材缓存失效过于频繁：距上次失效仅 ' + (__now - state._topicCacheLastInvalidateTs).toFixed(0) + 'ms（累计失效 ' + state._topicCacheInvalidateCount + ' 次）来源: ' + ((new Error()).stack ? (new Error()).stack.split('\n')[2] : '?'));
            }
            state._topicCacheLastInvalidateTs = __now;
        }