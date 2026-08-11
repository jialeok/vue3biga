        // ============================================================
        // 早盘竞价拆表操作：auction_watchlist + market_metrics(scope='auction')
        // 列归属：
        //   auction_watchlist：date/stock/code/volume/yest_volume/note/change_pct/topics
        //                      source/obs_auto_added/selected/bought/sold/fixed
        //   market_metrics：date/stock/code/volume/yest_volume/change_pct/time930/seal_count/scope/source
        // ============================================================
        window._auctionTableAvailable = false; // 运行时标记：auction_watchlist 表是否可用
        window._marketMetricsTableAvailable = false; // 运行时标记：market_metrics 表是否可用
        window._lastPushedAuctionStatus = '';  // 上次推送的 auction 状态签名（避免无变化时重复推送）

        // 从 auction_watchlist 与 market_metrics(scope='auction') 全量读取并合并，
        // 组装成 {date: [正式成员 rows]} 结构返回，同时把全量快照写入 _auctionMemCache。
        // 方案2：行对象不再携带 in_watchlist 字段；正式成员索引写入 _auctionWatchlistIndex。
        // 合并规则：
        //   - auction_watchlist 的行 → 登记到 _auctionWatchlistIndex[date]（正式成员）
        //   - market_metrics(scope='auction') 的行 → 影子记录（不登记到索引）
        //   - 公共字段以对应来源为准；watchlist 行额外带 source/obs_auto_added/selected/bought/sold/fixed；
        //     metrics 行额外带 time930/seal_count。
        export async function pullAuctionFromTable() {
            const sb = window.getSupabase();
            const result = {};
            // 阶段四 Bug 6 收尾修复：不能 _auctionMemCache = {} 重新赋值，否则会切断
            // allData.auction 与 _auctionMemCache 的引用关系（同 Bug 3 整体导入的坑）。
            // 阶段六 日期隔离修复：不再清空所有日期！改为按日期累积云端行，再通过 guard API 写入，
            // 避免单日期拉取/全表刷新清空其它日期的本地数据（日期隔离根因）。
            const cloudByDate = {};
            // 方案2：本次拉取的正式成员索引（{date: Set(stockName)}）；只覆盖云端返回的日期，
            // 未返回的本地日期保留原索引（与 _auctionMemCache 日期隔离语义一致）
            const newWatchlistIndex = {};
            let offset = 0;
            const pageSize = 1000;

            // 1) 读取 auction_watchlist（正式列表成员）
            let watchlistError = null;
            try {
                while (true) {
                    const { data, error } = await sb.from('auction_watchlist')
                        .select('date,stock,code,volume,yest_volume,note,change_pct,topics,source,obs_auto_added,selected,bought,sold,fixed,updated_at,updated_by')
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    data.forEach(function(row) {
                        if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
                        const key = (row.stock || '').trim();
                        if (!key) return;
                        cloudByDate[row.date][key] = {
                            stock: row.stock,
                            code: row.code || '',
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            yestVolume: row.yest_volume || '', // camelCase 别名，供渲染代码兼容
                            note: row.note || '',
                            change_pct: row.change_pct || '',
                            changePct: row.change_pct || '', // camelCase 别名，供渲染代码兼容
                            topics: row.topics || '',
                            source: row.source || 'manual',
                            obs_auto_added: row.obs_auto_added || false,
                            obsAutoAdded: row.obs_auto_added || false,
                            selected: row.selected || false,
                            bought: row.bought || false,
                            sold: row.sold || false,
                            fixed: row.fixed || false
                        };
                        if (!newWatchlistIndex[row.date]) newWatchlistIndex[row.date] = new Set();
                        newWatchlistIndex[row.date].add(key);
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
                window._auctionTableAvailable = true;
            } catch (e) {
                watchlistError = e;
                window._auctionTableAvailable = false;
            }

            // 2) 读取 market_metrics(scope='auction')（影子记录/指标数据）
            offset = 0;
            let metricsError = null;
            try {
                while (true) {
                    const { data, error } = await sb.from('market_metrics')
                        .select('date,stock,code,volume,yest_volume,change_pct,time930,seal_count,source')
                        .eq('scope', 'auction')
                        .range(offset, offset + pageSize - 1);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    data.forEach(function(row) {
                        if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
                        const key = (row.stock || '').trim();
                        if (!key) return;
                        const existing = cloudByDate[row.date][key];
                        if (existing) {
                            // 该股票同时在 watchlist 里：补充 metrics 特有字段（time930/seal_count），
                            // 并在 watchlist 行的 volume/yest_volume/change_pct 为空时回退取 metrics 的值。
                            // 【BUG-FIX】worker morning 把 watchlist 的 volume/yest_volume/change_pct 写成空串，
                            // 真实值只写到了 market_metrics；如果这里不回退，刷新后趋势图会读空值消失。
                            if (row.time930 !== undefined && row.time930 !== null && row.time930 !== '') existing.time930 = row.time930;
                            if (row.seal_count !== undefined && row.seal_count !== null && row.seal_count !== '') existing.seal_count = row.seal_count;
                            if (row.volume !== undefined && row.volume !== null && String(row.volume).trim() !== '' &&
                                (!existing.volume || String(existing.volume).trim() === '')) {
                                existing.volume = row.volume;
                            }
                            if (row.yest_volume !== undefined && row.yest_volume !== null && String(row.yest_volume).trim() !== '' &&
                                (!existing.yest_volume || String(existing.yest_volume).trim() === '')) {
                                existing.yest_volume = row.yest_volume;
                                existing.yestVolume = row.yest_volume; // camelCase 别名同步
                            }
                            if (row.change_pct !== undefined && row.change_pct !== null && String(row.change_pct).trim() !== '' &&
                                (!existing.change_pct || String(existing.change_pct).trim() === '')) {
                                existing.change_pct = row.change_pct;
                                existing.changePct = row.change_pct; // camelCase 别名同步
                            }
                            return;
                        }
                        cloudByDate[row.date][key] = {
                            stock: row.stock,
                            code: row.code || '',
                            volume: row.volume || '',
                            yest_volume: row.yest_volume || '',
                            yestVolume: row.yest_volume || '', // camelCase 别名
                            change_pct: row.change_pct || '',
                            changePct: row.change_pct || '', // camelCase 别名
                            time930: row.time930 || '',
                            seal_count: row.seal_count || '',
                            source: row.source || 'manual'
                        };
                        // 注意：影子记录不加入 newWatchlistIndex
                    });
                    if (data.length < pageSize) break;
                    offset += pageSize;
                }
                window._marketMetricsTableAvailable = true;
            } catch (e) {
                metricsError = e;
                window._marketMetricsTableAvailable = false;
            }

            // 3) 读取 market_metrics(scope='hot') 作为 yest_volume/volume/change_pct 的二级回退（全表）
            // 【BUG-FIX】auction scope 部分行 yest_volume 为空，但 hot scope 同一股票同一日有值——
            //   yest_volume 是市场客观值（前一日完整成交量），与 tab 归属无关，可安全回退。
            //   只给已存在的行补值，不新增行（hot 影子记录不进入 auction 列表）。
            try {
                offset = 0;
                while (true) {
                    const { data: hotData, error: hotError } = await sb.from('market_metrics')
                        .select('date,stock,volume,yest_volume,change_pct')
                        .eq('scope', 'hot')
                        .range(offset, offset + pageSize - 1);
                    if (hotError) throw hotError;
                    if (!hotData || hotData.length === 0) break;
                    hotData.forEach(function(row) {
                        const d = row.date;
                        if (!cloudByDate[d]) return;
                        const key = (row.stock || '').trim();
                        if (!key) return;
                        const existing = cloudByDate[d][key];
                        if (!existing) return;
                        if (row.volume != null && String(row.volume).trim() !== '' &&
                            (!existing.volume || String(existing.volume).trim() === '')) existing.volume = row.volume;
                        if (row.yest_volume != null && String(row.yest_volume).trim() !== '' &&
                            (!existing.yest_volume || String(existing.yest_volume).trim() === '')) {
                            existing.yest_volume = row.yest_volume;
                            existing.yestVolume = row.yest_volume;
                        }
                        if (row.change_pct != null && String(row.change_pct).trim() !== '' &&
                            (!existing.change_pct || String(existing.change_pct).trim() === '')) {
                            existing.change_pct = row.change_pct;
                            existing.changePct = row.change_pct;
                        }
                    });
                    if (hotData.length < pageSize) break;
                    offset += pageSize;
                }
            } catch (e) { window._dbgLog('[AUCTION-PULL] hot 二级回退失败（不影响主流程）' + (e && e.message || e)); }

            if (watchlistError && metricsError) {
                throw watchlistError;
            }

            // 通过 guard API 按日期写入，保留未在云端返回的本地日期（日期隔离）
            Object.keys(cloudByDate).forEach(function(d) {
                const rows = Object.values(cloudByDate[d]);
                window.setAuctionDateData(d, rows, 'window.pullAuctionFromTable');
                // 方案2：覆盖该日期的正式成员索引（未在云端返回的日期保留原索引）
                window._auctionWatchlistIndex[d] = newWatchlistIndex[d] || new Set();
                // 返回值只含正式成员行，供调用方做长度检查
                const watchlistSet = window._auctionWatchlistIndex[d];
                rows.forEach(function(r) {
                    if (r && r.stock && watchlistSet.has(r.stock.trim())) {
                        if (!result[d]) result[d] = [];
                        result[d].push({
                            stock: r.stock,
                            code: r.code || '',
                            volume: r.volume || '',
                            yestVolume: r.yest_volume || '',
                            note: r.note || '',
                            changePct: r.change_pct || '',
                            topics: r.topics || '',
                            selected: r.selected || false,
                            bought: r.bought || false,
                            sold: r.sold || false,
                            fixed: r.fixed || false
                        });
                    }
                });
            });
            window._dbgLog('[AUCTION-WRITE] window.pullAuctionFromTable cloudDates=' + Object.keys(cloudByDate).length + ' preservedLocalDates=' + (Object.keys(window._auctionMemCache).length - Object.keys(cloudByDate).length));
            return result;
        }


        // ===== setAuctionDateData（从 logic/app-core.js 移至 data 层）=====
        // 写入指定日期的竞价行数据到内存缓存，带 guard 日志
        export function setAuctionDateData(date, newList, source) {
            if (!date || typeof date !== 'string') { window._dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
            var normalizedList = newList || [];
            var before = (window._auctionMemCache[date] || []).length;
            window._auctionMemCache[date] = normalizedList;
            var after = (window._auctionMemCache[date] || []).length;
            window._dbgLog('[AUCTION-GUARD] set date=' + date + ' before=' + before + ' after=' + after + ' source=' + source + window._guardStack());
            if (window.auctionStore && date !== window.auctionStore.currentDate) {
                try { window._dbgLog('[AUCTION-GUARD] sample date=' + date + ' source=' + source + ' stocks=' + (normalizedList||[]).slice(0,3).map(function(r){return r&&r.stock||'?';}).join(',')); } catch(e){}
            }
            window._guardAssertDate(date, source);
        }
        // ===== normalizeAuctionNotes（从 logic/app-core.js 移至 data 层）=====
        export function normalizeAuctionNotes() {
            if (!window.allData || !window.allData.auction) return;
            let hasChanges = false;
            Object.keys(window.allData.auction).forEach(date => {
                const dayList = window.allData.auction[date];
                if (!dayList || !Array.isArray(dayList)) return;
                dayList.forEach(item => {
                    if (!item.note) return;
                    const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
                    if (bracketMatches.length === 0) return;
                    const allTopics = new Set();
                    bracketMatches.forEach(match => {
                        const content = match.replace(/[()（）]/g, '');
                        const topics = content.split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
                        topics.forEach(t => allTopics.add(t));
                    });
                    const percentMatches = item.note.match(/-?\d+\.?\d*%/g) || [];
                    const ztDtMatches = item.note.match(/涨停|跌停/g) || [];
                    const uniqueZtDt = [...new Set(ztDtMatches)];
                    const prefix = percentMatches.join('') + uniqueZtDt.join('');
                    const uniqueBracket = allTopics.size > 0 ? '(' + Array.from(allTopics).join(',') + ')' : '';
                    const newNote = prefix + uniqueBracket;
                    if (newNote !== item.note) {
                        item.note = newNote;
                        hasChanges = true;
                    }
                });
            });
            if (hasChanges) {
                window.invalidateTopicCache();
            }
        }