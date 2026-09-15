import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
        // ===== stock_topics 表操作（题材库独立表）=====
        // 从 stock_topics 表全量读取，返回 {stockName: Set(topics)}
        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';
        import { refreshCoreTopicsFromCloud } from '../logic/topic/rules.js';

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

        // ===== 题材库就绪判定（§10：读取失败 ≠ 空）=====
        // 供【产出结论型】业务在「题材分类结果不可信」时拒绝落库（见 logic/auction/dragon-group.js 的龙头评选）。
        //
        // 为什么必须有这道闸门（实测事故 2026-09-15 · 龙头组只剩 1 只）：
        //   `loadCloudTopics()` 是登录后的【异步】步骤；而题材分类的常规路径是
        //   「当日 note/topics 为空 → 回退共享题材库（getStockHistoryTopics）」——
        //   实测当天 39 只正式成员里有 33 只的 topics 字段为空，即绝大多数股票只能靠这份库分类。
        //   若评选发生在题材库到货【之前】，这些股票会全部落「其它」→ 每个题材都凑不够 3 只
        //   → 写出「只有 1 只龙头」的残缺名册；而主键 (date,topic) 让它被永久冻结。
        //   实测对比（同一份 9/15 数据）：题材库未就绪 → 39 只里 33 只落「其它」；
        //                              题材库就绪 → 只有 2 只落「其它」，4 个题材达到评选门槛。
        export function isTopicLibraryReady() {
            return !!(state._cloudTopicsCache && Object.keys(state._cloudTopicsCache).length > 0);
        }

        /**
         * 确保共享题材库已加载（仅在未就绪时发起一次全量拉取；幂等，已就绪则 0 请求）。
         * ⚠️ 重新加载后必须【立刻】重建题材缓存：invalidateTopicCache() 会把 _topicCacheBuilt 置 false，
         *    若不同步 buildTopicCache()，后续读取会落在「已失效但未重建」的中间态（§22 的同类坑）。
         * @returns {Promise<boolean>} 题材库是否可用
         */
        export async function ensureTopicLibraryLoaded() {
            if (isTopicLibraryReady()) return true;
            try {
                await loadCloudTopics();
            } catch (e) {
                _dbgLog('[TOPIC-LIB] 题材库加载失败: ' + (e && e.message || e));
            }
            invalidateTopicCache();
            buildTopicCache();
            return isTopicLibraryReady();
        }

        // [PERF-FIX 2026-09-13] 批量导入防抖合并（§22：Realtime 短时多次变化必须批量合并后一次更新）。
        // 原实现每条 postgres_changes 都立即「全量拉取整表 → invalidate → 全量重建 → emit 全局刷新」。
        // 后台粘贴导入 N 只股票 = N 条变更 = N 次全量往返，主线程被反复占满（导入后翻页卡死元凶之一）。
        // 改为 400ms 窗口内合并成一次，结果与逐条处理一致（终态相同）。
        const STOCK_TOPICS_RELOAD_DEBOUNCE_MS = 400;
        let _stockTopicsReloadTimer = null;

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
                        // 题材库变更，重新拉取云端题材并刷新第二页（同一批次合并为一次）
                        if (_stockTopicsReloadTimer) clearTimeout(_stockTopicsReloadTimer);
                        _stockTopicsReloadTimer = setTimeout(function() {
                            _stockTopicsReloadTimer = null;
                            loadCloudTopics().then(function() {
                                invalidateTopicCache();
                                buildTopicCache();
                                _emit('data:realtime-update', { boards: 'auction' });
                            }).catch(function(e) { _dbgLog('[AUCTION-ERR] Stock topics Realtime 重建缓存 ' + (e && e.message || e)); });
                        }, STOCK_TOPICS_RELOAD_DEBOUNCE_MS);
                    })
                    .subscribe();
                console.log('Stock topics Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] Stock topics Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopStockTopicsRealtime() {
            if (_stockTopicsReloadTimer) {
                clearTimeout(_stockTopicsReloadTimer);
                _stockTopicsReloadTimer = null;
            }
            if (state._stockTopicsChannel) {
                try { getSupabase().removeChannel(state._stockTopicsChannel); } catch(e) {}
                state._stockTopicsChannel = null;
            }
        }

        // core_topics 表的 Realtime 订阅（§31 合规：start 先 stop 幂等，stop 配对 removeChannel）。
        // 与 stock_topics 题材库订阅并列：核心词（core_topics）被多端编辑后，实时刷新第二页题材分组。
        export function startCoreTopicsRealtime() {
            stopCoreTopicsRealtime();
            try {
                const sb = getSupabase();
                if (!sb) return;
                state._coreTopicsChannel = sb
                    .channel('core_topics_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'core_topics'
                    }, function() {
                        refreshCoreTopicsFromCloud().catch(function(e) {
                            _dbgLog('[AUCTION-ERR] core_topics Realtime 回调失败 ' + (e && e.message || e));
                        });
                    })
                    .subscribe();
                console.log('core_topics Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] core_topics Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopCoreTopicsRealtime() {
            if (state._coreTopicsChannel) {
                try { getSupabase().removeChannel(state._coreTopicsChannel); } catch(e) {}
                state._coreTopicsChannel = null;
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
                        // [PERF-FIX 2026-09-13] 快路径：纯涨幅 note（如 "+3.2%"）无括号，
                        // 直接跳过，避免对全部 ~4.17 万个单元格逐个跑正则（原实现主要开销）。
                        if (item.note.indexOf('(') < 0) return;
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