import { _emit } from '../stores/eventBus.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { state } from '../logic/app-state.js';
        // ============================================================
        // ⚠️ 已弃用但保留（共享数据层）：本文件的 UI 渲染函数（renderHotStocks 等）已随
        //    早盘竞价重构于 2026-08-15 从 app-core.js 删除（纯死代码，Vue3 UI 无入口）。
        //    但本文件作为「热门股票共享数据层」必须保留：loadHotStocksFromCloud /
        //    pullHotStocksHighlights / loadHotTrendsFromCloud / Realtime 订阅 / pushHotTrendsToCloud
        //    等支撑「竞价看板第二页题材 + 题材星标签统计看板」的影子记录，删之会让题材统计变空。
        //    详见 MIGRATION_TASKLIST.md 第十四章。请勿删除本文件或其加载/订阅/推送逻辑。
        // ============================================================
        // hot_stocks / hot_stocks_highlights 表操作（热门股票分组，结构与早盘竞价对应函数一致）
        // 通过 dataSource='hot' 复用同一套算法函数，此处仅提供数据加载/订阅/推送
        // ============================================================

        import { getSupabase, getNumericVolume } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';

        // 从 hot_stocks 与 market_metrics(scope='hot') 双表读取并合并，
        // 组装成 {date: [items]} 结构返回，同时把全量快照写入 _hotFullRowCache。
        // 拆表后：
        //   - hot_stocks 每行天然是正式列表成员（无 in_watchlist 列）
        //   - market_metrics(scope='hot') 存影子/指标数据（volume/yest_volume/change_pct）

        // [BUG-FIX] 读侧字段级 merge：云端非空字段覆盖本地，云端空字段保留本地值。
        // 解决竞态场景：补全按钮 patchHotFieldBatch 刚把补全值写入本地 _hotFullRowCache，
        // 此时 Realtime 触发的 loadHotStocksFromCloud 恰好读到云端尚未 commit 的旧值（补全字段为空），
        // 整表重置会用空值覆盖本地补全值，导致趋势图刷新后丢失数据。
        // 改为字段级 merge 后，云端空字段不会覆盖本地已有值，趋势图能读到补全值。
        // 注意：不保留云端没有的行（避免另一台设备删除的行复活）；只对云端已有的行做字段级合并。
        state.HOT_MERGE_FIELDS = ['code', 'volume', 'yest_volume', 'note', 'change_pct', 'topics', 'selected', 'bought', 'sold', 'fixed'];
        function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }
export function _mergeHotCloudToLocal(oldList, cloudRows) {
            if (!oldList || oldList.length === 0) return cloudRows.slice();
            const oldMap = {};
            oldList.forEach(function(r) {
                if (r && r.stock) oldMap[r.stock.trim()] = r;
            });
            return cloudRows.map(function(cr) {
                if (!cr || !cr.stock) return cr;
                const local = oldMap[cr.stock.trim()];
                if (!local) return cr; // 本地没有，用云端
                const row = Object.assign({}, local); // 以本地为基础，保留本地已有字段
                state.HOT_MERGE_FIELDS.forEach(function(f) {
                    // 云端字段非空（非 undefined/null/''）才覆盖本地
                    if (cr[f] !== undefined && cr[f] !== null && cr[f] !== '') {
                        row[f] = cr[f];
                    }
                });
                return row;
            });
        }

        export async function loadHotStocksFromCloud() {
            // 若刚推送了本地修改（saveAuction 的 hot 分支），跳过重新加载，防止云端空数据覆盖本地修改
            if (state._justPushedHotAuction) return;
            const sb = getSupabase();
            const result = {};
            const cloudByDate = {};
            // 保存旧的本地数据，用于合并 note/changePct/topics（云端有值才覆盖，避免抓取程序空字段覆盖主程序编辑）
            const oldLocalData = state._hotAuctionData || {};
            // [BUG-FIX] 从 stockcodemap 云端表拿 name→code 映射，云端 code 为空时做回填。
            const scMap = state._scMapCache || {};
            let offset = 0;
            const pageSize = 1000;

            // 正式成员索引（方案2：行对象不再携带 in_watchlist，用独立 Set 维护）
            const newWatchlistIndex = {};

            // 1) 读取 hot_stocks（正式列表成员）
            let stocksError = null;
            try {
                while (true) {
                    const { data, error } = await sb.from('hot_stocks')
                        .select('date,stock,code,volume,yest_volume,note,change_pct,topics,selected,bought,sold,fixed')
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    data.forEach(function(row) {
                        if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
                        const nameTrim = (row.stock || '').trim();
                        if (!nameTrim) return;
                        const mapCode = (scMap[nameTrim] || '').trim();
                        const cloudCode = (row.code || '').trim();
                        const finalCode = cloudCode || mapCode;
                        cloudByDate[row.date][nameTrim] = {
                            stock: row.stock,
                            code: finalCode,
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            note: row.note || '',
                            change_pct: row.change_pct || '',
                            topics: row.topics || '',
                            selected: row.selected || false,
                            bought: row.bought || false,
                            sold: row.sold || false,
                            fixed: row.fixed || false
                        };
                        // 登记到正式成员索引
                        if (!newWatchlistIndex[row.date]) newWatchlistIndex[row.date] = new Set();
                        newWatchlistIndex[row.date].add(nameTrim);
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
                state._hotAuctionTableAvailable = true;
            } catch (e) {
                stocksError = e;
                state._hotAuctionTableAvailable = false;
            }

            // 2) 读取 market_metrics(scope='hot')（影子记录/指标数据）
            offset = 0;
            let metricsError = null;
            let metricsRowsRead = 0;
            try {
                while (true) {
                    const { data, error } = await sb.from('market_metrics')
                        .select('date,stock,code,volume,yest_volume,change_pct')
                        .eq('scope', 'hot')
                        .order('date', { ascending: true })
                        .order('stock', { ascending: true })
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    metricsRowsRead += data.length;
                    data.forEach(function(row) {
                        if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
                        const nameTrim = (row.stock || '').trim();
                        if (!nameTrim) return;
                        const existing = cloudByDate[row.date][nameTrim];
                        if (existing) {
                            if (row.volume !== undefined && row.volume !== null && row.volume !== '') existing.volume = row.volume;
                            if (row.yest_volume !== undefined && row.yest_volume !== null && row.yest_volume !== '') existing.yest_volume = row.yest_volume;
                            if (row.change_pct !== undefined && row.change_pct !== null && row.change_pct !== '') existing.change_pct = row.change_pct;
                            if (row.code) existing.code = row.code;
                            return;
                        }
                        const mapCode = (scMap[nameTrim] || '').trim();
                        const cloudCode = (row.code || '').trim();
                        cloudByDate[row.date][nameTrim] = {
                            stock: row.stock,
                            code: cloudCode || mapCode,
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            change_pct: row.change_pct || ''
                        };
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
                state._marketMetricsTableAvailable = true;
            } catch (e) {
                metricsError = e;
                state._marketMetricsTableAvailable = false;
            }

            if (stocksError && metricsError) {
                throw stocksError;
            }

            // 合并写入全量快照缓存，并提取正式列表成员到 result
            // [BUG-FIX] 不再整表清空 _hotFullRowCache，改为字段级 merge：
            // 保留旧对象引用，逐 date 用 _mergeHotCloudToLocal 字段级合并（云端非空才覆盖本地）。
            // 这样竞态期间本地刚写入的补全值不会被云端旧值（空字段）覆盖，趋势图能读到补全值。
            state._hotWatchlistIndex = newWatchlistIndex; // 替换为本次加载的正式成员索引
            Object.keys(cloudByDate).forEach(function(d) {
                const rows = _mergeHotCloudToLocal(state._hotFullRowCache[d], Object.values(cloudByDate[d]));
                state._hotFullRowCache[d] = rows;
                const watchlistSet = state._hotWatchlistIndex[d] || new Set();
                rows.forEach(function(r) {
                    if (watchlistSet.has((r.stock || '').trim())) {
                        if (!result[d]) result[d] = [];
                        // 查找本地旧数据，合并 volume/yestVolume/note/changePct/topics（云端有值才覆盖）
                        const localList = oldLocalData[d] || [];
                        const local = localList.find(s => s && s.stock && s.stock.trim() === (r.stock || '').trim());
                        result[d].push({
                            stock: r.stock,
                            code: r.code || (local ? (local.code || '') : ''),
                            volume: getNumericVolume(r.volume) !== null ? r.volume : (local ? (local.volume || '') : ''),
                            yestVolume: getNumericVolume(r.yest_volume) !== null ? r.yest_volume : (local ? (local.yestVolume || '') : ''),
                            note: (r.note && r.note.trim()) ? r.note : (local ? (local.note || '') : ''),
                            changePct: (r.change_pct && String(r.change_pct).trim()) ? r.change_pct : (local ? (local.changePct || '') : ''),
                            topics: (r.topics && r.topics.trim()) ? r.topics : (local ? (local.topics || '') : ''),
                            selected: local ? (local.selected || false) : (r.selected || false),
                            bought: local ? (local.bought || false) : (r.bought || false),
                            sold: local ? (local.sold || false) : (r.sold || false),
                            fixed: local ? (local.fixed || false) : (r.fixed || false)
                        });
                    }
                });
            });

            // [PERF-FIX 2026-07-24] 原实现对响应式代理逐 key delete 再逐 key 赋值
            // （211 个日期 = 400+ 次独立响应式 trigger），每次 trigger 都可能让
            // 依赖它的 Vue computed（hot 分组的 AuctionBoard/Page2Board 等）判定为脏
            // 并在读取时重算，形成"改一点、算一次，算的过程又读到刚变脏的其它日期"
            // 的连锁反应，实测单帧内计算耗时可达 3000ms+，导致页面卡到无法点击。
            // 修复：先在普通对象上做完整个 diff（哪些日期要删、哪些要加/更新、哪些
            // 内容未变可以跳过），只对真正变化的 key 做响应式写入，且只在最后
            // bump 一次 stocksDataVersion 作为统一失效信号，而不是让每次单独的
            // 属性增删各自触发一轮依赖失效判定。
            if (_getAuctionStore() && state._hotAuctionData === _getAuctionStore().hotAuctionData) {
                const _t0 = performance.now();
                const oldKeys = Object.keys(state._hotAuctionData);
                const newKeys = Object.keys(result);
                const newKeySet = new Set(newKeys);
                let _removed = 0, _changed = 0, _unchanged = 0;
                // 1) 删除云端已不存在的日期
                oldKeys.forEach(function (d) {
                    if (!newKeySet.has(d)) { delete state._hotAuctionData[d]; _removed++; }
                });
                // 2) 只有内容真正变化（JSON 不同）才写入，内容相同的日期跳过，
                //    避免给没有变化的日期也触发一次响应式 set
                newKeys.forEach(function (d) {
                    const oldVal = state._hotAuctionData[d];
                    const newVal = result[d];
                    if (oldVal === undefined || JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                        state._hotAuctionData[d] = newVal;
                        _changed++;
                    } else {
                        _unchanged++;
                    }
                });
                _dbgLog('[PERF-FIX] window.loadHotStocksFromCloud 响应式写入：删除' + _removed + '/变化' + _changed + '/未变跳过' + _unchanged + '，diff+写入耗时=' + (performance.now() - _t0).toFixed(1) + 'ms');
            } else {
                state._hotAuctionData = result;
            }
            // [DEBUG] 输出 _hotFullRowCache 中各日期的影子/正式记录数，帮助排查"刷新后消失"
            const _fullCacheSummary = {};
            Object.keys(state._hotFullRowCache).forEach(function(d) {
                const rows = state._hotFullRowCache[d] || [];
                const watchlistSet = state._hotWatchlistIndex[d] || new Set();
                const watchlistCount = rows.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); }).length;
                _fullCacheSummary[d] = { total: rows.length, watchlist: watchlistCount };
            });
            console.log('hot_stocks 加载完成:', Object.keys(result).length, '个日期' +
                ' | market_metrics读取=' + metricsRowsRead + '行' +
                ' | _hotFullRowCache日期=' + Object.keys(state._hotFullRowCache).length,
                _fullCacheSummary);
        }

        // 从 hot_stocks_highlights 表加载所有预计算高光（小表，快）
        export async function pullHotStocksHighlights() {
            const sb = getSupabase();
            const result = {};
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('hot_stocks_highlights')
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
            state._hotHighlightsCache = result;
            state._hotHighlightsTableAvailable = true;
            console.log('hot_stocks_highlights 加载完成:', Object.keys(result).length, '个日期');
        }

        // 推送某日期的高光到 hot_stocks_highlights 表
        export async function pushHotStocksHighlights(date, highlightSet) {
            const sb = getSupabase();
            const now = new Date().toISOString();
            const stockNames = highlightSet ? [...highlightSet] : [];

            // [FIX 2026-07-24 自循环根治] 与 pushDailyHighlights 同款：集合未变化时跳过写库，
            // 否则"renderHotStocks → 写 highlights → Realtime 回显 → renderHotStocks"无限自循环。
            const cached = state._hotHighlightsCache[date];
            if (cached && cached.size === stockNames.length &&
                stockNames.every(function(n) { return cached.has(n); })) {
                return;
            }

            // 自推送屏蔽：本次写入触发的 Realtime 通知直接忽略
            state._justPushedHotHighlights = true;
            setTimeout(function() { state._justPushedHotHighlights = false; }, 5000);

            // 1. 先把该日期所有行标记为 false（清除旧高光）
            const { error: updErr } = await sb.from('hot_stocks_highlights')
                .update({ jing_yest_highlight: false, updated_at: now })
                .eq('date', date);
            if (updErr) console.warn('hot_stocks_highlights 清除旧高光失败:', updErr.message);

            // 2. 再把达标股票标记为 true（upsert）
            if (stockNames.length > 0) {
                const rows = stockNames.map(function(name) {
                    return { date: date, stock: name, jing_yest_highlight: true, updated_at: now };
                });
                const batchSize = 25;
                for (let i = 0; i < rows.length; i += batchSize) {
                    const { error: upErr } = await sb.from('hot_stocks_highlights')
                        .upsert(rows.slice(i, i + batchSize), { onConflict: 'date,stock' });
                    if (upErr) console.warn('hot_stocks_highlights upsert 失败:', upErr.message);
                }
            }

            // 更新本地缓存
            state._hotHighlightsCache[date] = new Set(stockNames);
        }

        // ===== 热门股票tap：三张表（hot_stocks / hot_stocks_highlights / hot_stock_trends）的
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
                        console.warn('Realtime window.loadHotStocksFromCloud 失败:', e);
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

        // ============================================================
        // hot_stock_trends 独立表操作（热门股票趋势图数据：volume/yest_volume/change_pct）
        // 与 hot_stocks 大表解耦，专供趋势图读取；接口按钮抓取数据时同步写入此表
        // ============================================================

        // 从 market_metrics(scope='hot') 全量读取，构建 _hotTrendsCache = {date: [items]}
        // 拆表后统一：热门股票趋势数据也落到 market_metrics，与早盘竞价影子数据共用同一张表。
        export async function loadHotTrendsFromCloud() {
            if (state._justPushedHotTrends) return;
            const sb = getSupabase();
            const result = {};
            let offset = 0;
            const pageSize = 1000;

            // 优先读取 market_metrics(scope='hot')
            let usedMarketMetrics = false;
            try {
                while (true) {
                    const { data, error } = await sb.from('market_metrics')
                        .select('date,stock,code,volume,yest_volume,change_pct')
                        .eq('scope', 'hot')
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    data.forEach(function(row) {
                        if (!row || !row.date || !row.stock) return;
                        if (!result[row.date]) result[row.date] = [];
                        result[row.date].push({
                            stock: row.stock,
                            code: row.code || '',
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            change_pct: row.change_pct || ''
                        });
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
                usedMarketMetrics = true;
                state._marketMetricsTableAvailable = true;
            } catch (e) {
                console.warn('[HOT-TRENDS] 从 market_metrics 读取失败，回退到 hot_stock_trends:', e.message);
            }

            // 若 market_metrics 无数据或失败，回退读取旧 hot_stock_trends 表
            if (!usedMarketMetrics || Object.keys(result).length === 0) {
                offset = 0;
                while (true) {
                    const { data, error } = await sb.from('hot_stock_trends')
                        .select('date,stock,code,volume,yest_volume,change_pct')
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    data.forEach(function(row) {
                        if (!row || !row.date || !row.stock) return;
                        if (!result[row.date]) result[row.date] = [];
                        result[row.date].push({
                            stock: row.stock,
                            code: row.code || '',
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            change_pct: row.change_pct || ''
                        });
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
            }

            state._hotTrendsTableAvailable = true;
            state._hotTrendsCache = result;
            console.log('hot trends 加载完成:', Object.keys(result).length + ' 个日期' + (usedMarketMetrics ? '（来源：market_metrics）' : '（来源：hot_stock_trends 回退）'));
        }

        // 批量 upsert 趋势数据到 hot_stock_trends 表（每批 500 行）
        // items 是热门股票数组，字段结构与 _hotAuctionData 一致：{stock, code, volume, yestVolume, changePct, ...}
        export async function pushHotTrendsToCloud(date, items) {
            // [BUG-FIX-20260731] 核心修复：
            // 1. 停止写入 market_metrics 表！业务数据更新完全由 patchHotFieldBatch 负责（字段级PATCH，安全），
            //    此处重复写入 market_metrics 会用空字符串覆盖已有有效值，导致"抓竞价量后成交量消失"的互斥bug。
            // 2. 本函数职责单一化：只负责①更新本地 _hotTrendsCache（趋势图立即可见）②同步到旧表 hot_stock_trends（兼容回退逻辑）。
            // 3. market_metrics 是主数据源，由 patchHotFieldBatch 写入，Realtime 会自动触发 _hotTrendsCache 刷新。
            state._justPushedHotTrends = true;
            try {
                const scMap = state._scMapCache || {};
                const now = new Date().toISOString();
                if (!state._hotTrendsCache[date]) state._hotTrendsCache[date] = [];

                // 从两个来源构建完整的 existing 数据：
                // - _hotTrendsCache: 趋势缓存本身（历史影子数据）
                // - _hotFullRowCache: 全量业务缓存（patchHotFieldBatch刚写入的最新数据在这）
                var existingMap = {};
                state._hotTrendsCache[date].forEach(function(r) {
                    if (r && r.stock) existingMap[r.stock] = Object.assign({}, r);
                });
                // 合并 _hotFullRowCache 中的最新数据（业务字段权威来源）
                if (state._hotFullRowCache[date]) {
                    state._hotFullRowCache[date].forEach(function(r) {
                        if (r && r.stock) {
                            var name = r.stock.trim();
                            var merged = existingMap[name] || { stock: name };
                            if (r.volume) merged.volume = r.volume;
                            if (r.yest_volume || r.yestVolume) merged.yest_volume = r.yest_volume || r.yestVolume || '';
                            if (r.change_pct || r.changePct) merged.change_pct = r.change_pct || r.changePct || '';
                            if (r.code) merged.code = r.code;
                            existingMap[name] = merged;
                        }
                    });
                }

                // 合并本次传入的新数据（只覆盖非空字段）
                items.filter(function(s) { return s && s.stock; }).forEach(function(item) {
                    var name = item.stock.trim();
                    var merged = existingMap[name] || { stock: name };
                    var newVolume = item.volume || '';
                    var newYestVol = item.yestVolume || item.yest_volume || '';
                    var newChangePct = item.changePct || item.change_pct || '';
                    var newCode = scMap[name] || item.code || merged.code || '';
                    if (newVolume) merged.volume = newVolume;
                    if (newYestVol) merged.yest_volume = newYestVol;
                    if (newChangePct) merged.change_pct = newChangePct;
                    if (newCode) merged.code = newCode;
                    existingMap[name] = merged;
                });

                // 构造 hot_stock_trends 旧表写入行（只写有数据的股票，避免空行）
                const rows = [];
                Object.keys(existingMap).forEach(function(name) {
                    var r = existingMap[name];
                    if (r.volume || r.yest_volume || r.change_pct) {
                        rows.push({
                            date: date,
                            stock: name,
                            code: r.code || '',
                            volume: r.volume || '',
                            yest_volume: r.yest_volume || '',
                            change_pct: r.change_pct || '',
                            updated_at: now,
                            updated_by: 'main'
                        });
                    }
                });
                if (rows.length === 0) return;

                // 先更新本地 _hotTrendsCache（无条件，趋势图立即可见）
                // 重建缓存，确保和 existingMap 一致
                state._hotTrendsCache[date] = rows.map(function(r) {
                    return {
                        stock: r.stock,
                        code: r.code,
                        volume: r.volume,
                        yest_volume: r.yest_volume,
                        change_pct: r.change_pct
                    };
                });

                // 云端同步到旧表 hot_stock_trends（market_metrics 由 patchHotFieldBatch 负责，此处不再写入）
                const sb = getSupabase();
                const batchSize = 500;
                // [BUG-FIX] 不再依赖 _hotTrendsTableAvailable 标记静默跳过：初始化完成前该标记可能为 false，
                // 导致抓取数据只进本地缓存、不进云端，刷新后丢失。改为直接尝试写入，表不存在时再报错。
                for (let i = 0; i < rows.length; i += batchSize) {
                    const { error } = await sb.from('hot_stock_trends')
                        .upsert(rows.slice(i, i + batchSize), { onConflict: 'date,stock' });
                    if (error) {
                        if (error.message && error.message.indexOf('relation') >= 0) {
                            state._hotTrendsTableAvailable = false;
                        }
                        // [BUG-FIX] hot_stock_trends 是旧表（已被 market_metrics scope=hot 替代），
                        // RLS 策略可能不允许前端 anon key 写入。数据已通过 patchHotFieldBatch 写入 market_metrics，
                        // 本地 _hotTrendsCache 也已更新，此处 RLS 失败不影响功能，静默跳过即可。
                        if (error.message && error.message.indexOf('row-level security policy') >= 0) {
                            console.warn('[HOT-TRENDS] hot_stock_trends RLS 策略拒绝写入（旧表已废弃，market_metrics 为主数据源），已跳过');
                            state._hotTrendsTableAvailable = false;
                            break;
                        }
                        throw error;
                    }
                }
                state._hotTrendsTableAvailable = true;
            } finally {
                setTimeout(function() { state._justPushedHotTrends = false; }, 2000);
            }
        }

        // 删除单行：从 hot_stock_trends 与 market_metrics(scope='hot') 删除 (date, stock)
        export async function deleteHotTrendFromCloud(date, stock) {
            if (!state._hotTrendsTableAvailable && !state._marketMetricsTableAvailable) return;
            state._justPushedHotTrends = true;
            try {
                const sb = getSupabase();
                if (state._hotTrendsTableAvailable) {
                    const { error } = await sb.from('hot_stock_trends')
                        .delete()
                        .eq('date', date)
                        .eq('stock', stock);
                    if (error) throw error;
                }
                if (state._marketMetricsTableAvailable) {
                    const { error } = await sb.from('market_metrics')
                        .delete()
                        .eq('date', date)
                        .eq('stock', stock)
                        .eq('scope', 'hot');
                    if (error) throw error;
                }
                if (state._hotTrendsCache[date]) {
                    state._hotTrendsCache[date] = state._hotTrendsCache[date].filter(function(r) {
                        return r && r.stock !== stock;
                    });
                }
            } finally {
                setTimeout(function() { state._justPushedHotTrends = false; }, 2000);
            }
        }

        // 按日期清空：从 hot_stock_trends 与 market_metrics(scope='hot') 删除该 date 下所有行
        export async function deleteHotTrendsForDateFromCloud(date) {
            if (!state._hotTrendsTableAvailable && !state._marketMetricsTableAvailable) return;
            state._justPushedHotTrends = true;
            try {
                const sb = getSupabase();
                if (state._hotTrendsTableAvailable) {
                    const { error } = await sb.from('hot_stock_trends')
                        .delete()
                        .eq('date', date);
                    if (error) throw error;
                }
                if (state._marketMetricsTableAvailable) {
                    const { error } = await sb.from('market_metrics')
                        .delete()
                        .eq('date', date)
                        .eq('scope', 'hot');
                    if (error) throw error;
                }
                state._hotTrendsCache[date] = [];
            } finally {
                setTimeout(function() { state._justPushedHotTrends = false; }, 2000);
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
                state._marketMetricsHotRealtimeChannel = sb
                    .channel('market_metrics_hot_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'market_metrics'
                    }, function(payload) {
                        if (state._justPushedHotAuction || state._justPushedHotTrends) return; // 自己刚推的，忽略
                        var row = payload.new || payload.old;
                        if (!row || !row.date || row.scope !== 'hot') return;
                        state._pendingHotReload.stocks = true; // market_metrics变化影响_hotFullRowCache，需触发loadHotStocksFromCloud
                        _scheduleHotRealtimeReload();
                    })
                    .subscribe();
                console.log('hot trends Realtime 订阅已启动（hot_stock_trends + market_metrics scope=hot）');
            } catch (e) {
                console.error('hot trends Realtime 订阅失败:', e);
            }
        }

        export function stopHotTrendsRealtime() {
            if (state._hotTrendsRealtimeChannel) {
                try { getSupabase().removeChannel(state._hotTrendsRealtimeChannel); } catch(e) {}
                state._hotTrendsRealtimeChannel = null;
            }
            if (state._marketMetricsHotRealtimeChannel) {
                try { getSupabase().removeChannel(state._marketMetricsHotRealtimeChannel); } catch(e) {}
                state._marketMetricsHotRealtimeChannel = null;
            }
        }

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
                await Promise.all(Object.keys(datesMap).map(function(d) {
                    return sb.from('hot_stocks')
                        .delete()
                        .eq('date', d)
                        .in('stock', datesMap[d]);
                }));
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

