import { useAuctionStore } from '../stores/auctionStore.js';
import { state } from '../logic/app-state.js';
let _invalidateTopicCacheFn = null;
export function _setInvalidateTopicCacheFn(fn) { _invalidateTopicCacheFn = fn; }
        // ============================================================
        // 早盘竞价拆表操作：auction_watchlist + market_metrics(scope='auction')
        // 列归属：
        //   auction_watchlist：date/stock/code/volume/yest_volume/note/change_pct/topics
        //                      source/obs_auto_added/selected/bought/sold/fixed
        //   market_metrics：date/stock/code/volume/yest_volume/change_pct/time930/seal_count/scope/source
        // ============================================================
        let _getSupabaseFn = null;
export function _setGetSupabaseFn(fn) { _getSupabaseFn = fn; }
        import { _dbgLog } from './debug-log.js';

        state._auctionTableAvailable = false; // 运行时标记：auction_watchlist 表是否可用
        state._marketMetricsTableAvailable = false; // 运行时标记：market_metrics 表是否可用
        state._lastPushedAuctionStatus = '';  // 上次推送的 auction 状态签名（避免无变化时重复推送）

        /**
         * 分页拉取工具（§32/§33 性能红线）。
         *
         * 【改造前】调用方各自写 `while(true) { query.range(offset, offset+999) }` 的顺序分页，
         *   auction_watchlist(11600 行) + market_metrics(scope=auction, 7225 行) + market_metrics(scope=hot, 2317 行)
         *   = 23 次【串行】HTTP，实测单次 0.7~2.0s → 首屏冻结 25~40 秒。
         *   Supabase 单次响应上限 1000 行（实测 limit=12000 也只回 1000），页数无法消灭；
         *   真正的问题是「串行」。
         *
         * 【改造后】先发一次 head+count 请求拿到总行数，再把各页用有限并发（默认 6，匹配浏览器
         *   单域名连接上限）一次性并行取回。页数不变但墙钟时间从 Σ 降到 ~1 波。
         *   若运行环境不支持 head+count（或不支持并发 range），自动降级为原串行分页——
         *   §10 红线：降级只允许变慢，绝不返回空数据伪装成功。
         *
         * @param {Function} buildQuery - () => Supabase query builder（已带 select 与过滤条件）
         * @param {Object} [opts] - { pageSize, concurrency, onError }
         * @returns {Promise<Array>} 全部行
         */
        const _PAGE_SIZE = 1000;
        const _PAGE_CONCURRENCY = 6;
        async function _fetchAllPages(buildQuery, opts) {
            const pageSize = (opts && opts.pageSize) || _PAGE_SIZE;
            const concurrency = (opts && opts.concurrency) || _PAGE_CONCURRENCY;

            // 1) 先探总数（head 请求不回行体，成本远低于拉 1000 行）
            let total = -1;
            try {
                const probe = await buildQuery().select('*', { count: 'exact', head: true });
                if (!probe.error && typeof probe.count === 'number') total = probe.count;
            } catch (e) {
                total = -1; // 不支持 → 走串行兜底
            }
            if (total === 0) return [];
            if (total > 0) {
                const pages = Math.max(1, Math.ceil(total / pageSize));
                const rows = [];
                for (let i = 0; i < pages; i += concurrency) {
                    const batch = [];
                    for (let j = i; j < Math.min(i + concurrency, pages); j++) {
                        batch.push(buildQuery().range(j * pageSize, (j + 1) * pageSize - 1));
                    }
                    const settled = await Promise.all(batch);
                    for (const r of settled) {
                        if (r.error) throw r.error;
                        if (r.data && r.data.length) rows.push.apply(rows, r.data);
                    }
                }
                return rows;
            }

            // 2) 降级：顺序分页（与原行为等价）
            const fallback = [];
            for (let offset = 0; ; offset += pageSize) {
                const res = await buildQuery().range(offset, offset + pageSize - 1);
                if (res.error) throw res.error;
                if (!res.data || res.data.length === 0) break;
                fallback.push.apply(fallback, res.data);
                if (res.data.length < pageSize) break;
            }
            return fallback;
        }

        function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }

        /**
         * 从 auction_watchlist 与 market_metrics(scope='auction') 读取并合并，
         * 组装成 {date: [正式成员 rows]} 结构返回，同时把全量快照写入 _auctionMemCache。
         *
         * @param {Object} [opts]
         *   · opts.sinceDate  —— 只拉 date >= sinceDate（首屏快加载：近 30 天窗口）
         *   · opts.untilDate  —— 只拉 date <  untilDate（后台补齐：更早的历史）
         *   两者都不传 = 全表拉取（行为同改造前）。组合使用即「窗口 + 后台」两阶段。
         *   ⚠️ §11 删除安全：本函数只做「读 + 按日期灌内存」，日期窗口变小绝不会
         *      导致云端任何一行被删除——写路径全部是按日期 patch / upsert。
         */
export async function pullAuctionFromTable(opts) {
            const sinceDate = (opts && opts.sinceDate) || '';
            const untilDate = (opts && opts.untilDate) || '';
            const sb = _getSupabaseFn();
            const result = {};
            // 阶段四 Bug 6 收尾修复：不能 _auctionMemCache = {} 重新赋值，否则会切断
            // allData.auction 与 _auctionMemCache 的引用关系（同 Bug 3 整体导入的坑）。
            // 阶段六 日期隔离修复：不再清空所有日期！改为按日期累积云端行，再通过 guard API 写入，
            // 避免单日期拉取/全表刷新清空其它日期的本地数据（日期隔离根因）。
            const cloudByDate = {};
            // 方案2：本次拉取的正式成员索引（{date: Set(stockName)}）；只覆盖云端返回的日期，
            // 未返回的本地日期保留原索引（与 _auctionMemCache 日期隔离语义一致）
            const newWatchlistIndex = {};

            // 1) 读取 auction_watchlist（正式列表成员）
            let watchlistError = null;
            const _watchlistCols = 'date,stock,code,volume,yest_volume,note,change_pct,topics,source,obs_auto_added,selected,bought,sold,fixed,updated_at,updated_by';
            const _buildWatchlistQuery = () => {
                let q = sb.from('auction_watchlist').select(_watchlistCols);
                if (sinceDate) q = q.gte('date', sinceDate);
                if (untilDate) q = q.lt('date', untilDate);
                return q;
            };
            // （指标数据 / 影子记录）
            const _metricsCols = 'date,stock,code,volume,yest_volume,change_pct,time930,seal_count,auc_pct_chg,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover,source';
            const _buildMetricsQuery = () => {
                let q = sb.from('market_metrics').select(_metricsCols).eq('scope', 'auction');
                if (sinceDate) q = q.gte('date', sinceDate);
                if (untilDate) q = q.lt('date', untilDate);
                return q;
            };
            const _buildHotQuery = () => {
                let q = sb.from('market_metrics')
                    .select('date,stock,volume,yest_volume,change_pct')
                    .eq('scope', 'hot');
                if (sinceDate) q = q.gte('date', sinceDate);
                if (untilDate) q = q.lt('date', untilDate);
                return q;
            };
            // ⚠️【取数与合并必须分离】三张表【并发】取回，但合并必须严格按
            // watchlist → metrics(auction) → metrics(hot) 顺序：
            // watchlist 建行是全量赋值，若它排在 metrics 之后会把已合并的竞价指标整行覆盖掉。
            let watchlistRows = [];
            let metricsRows = [];
            let hotRows = [];
            let metricsError = null;
            let hotError = null;
            await Promise.all([
                (async function() {
                    try {
                        watchlistRows = await _fetchAllPages(_buildWatchlistQuery);
                        state._auctionTableAvailable = true;
                    } catch (e) {
                        watchlistError = e;
                        state._auctionTableAvailable = false;
                    }
                })(),
                (async function() {
                    try {
                        metricsRows = await _fetchAllPages(_buildMetricsQuery);
                        state._marketMetricsTableAvailable = true;
                    } catch (e) {
                        metricsError = e;
                        state._marketMetricsTableAvailable = false;
                    }
                })(),
                (async function() {
                    try {
                        hotRows = await _fetchAllPages(_buildHotQuery);
                    } catch (e) {
                        hotError = e;
                    }
                })()
            ]);

            // ---- ① 合并 auction_watchlist（正式列表成员）----
            watchlistRows.forEach(function(row) {
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
                // §6：obs_auto_added 观察股不计入正式成员索引
                if (!row.obs_auto_added) newWatchlistIndex[row.date].add(key);
            });

            // ---- ② 合并 market_metrics(scope='auction')（影子记录/指标数据）----
            metricsRows.forEach(function(row) {
                    if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
                    const key = (row.stock || '').trim();
                    if (!key) return;
                    const existing = cloudByDate[row.date][key];
                    if (existing) {
                        // 该股票同时在 watchlist 里：补充 metrics 特有字段（time930/seal_count），
                        // 并仅在 watchlist 行的 volume/yest_volume 为空时回退取 metrics 的值。
                        // 【BUG-FIX】worker morning 把 watchlist 的 volume/yest_volume 写成空串，
                        // 真实值只写到了 market_metrics；如果这里不回退，刷新后趋势图会读空值消失。
                        // 注意：change_pct 不再走回退——它已改为以 market_metrics 为唯一权威（见下方权威模型块）。
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
                        // 【权威模型 / Phase 3】当天涨幅以 market_metrics(scope='auction').change_pct 为唯一权威。
                        // worker 与「获取涨幅」按钮都写它（patchAuctionFieldBatch→metricsPatch），后写者胜。
                        // market_metrics 非空即覆盖合并行，不再 only-if-empty 回退到 watchlist 行。
                        if (row.change_pct !== undefined && row.change_pct !== null && String(row.change_pct).trim() !== '') {
                            existing.change_pct = row.change_pct;
                            existing.changePct = row.change_pct; // camelCase 别名同步
                        }
                        // 竞价指标字段（仅 market_metrics 有，watchlist 行无这些列，直接补值）
                        if (row.auc_pct_chg !== undefined && row.auc_pct_chg !== null && String(row.auc_pct_chg).trim() !== '') existing.auc_pct_chg = row.auc_pct_chg;
                        if (row.um_vol !== undefined && row.um_vol !== null && String(row.um_vol).trim() !== '') existing.um_vol = row.um_vol;
                        if (row.open_bid_pct !== undefined && row.open_bid_pct !== null && String(row.open_bid_pct).trim() !== '') existing.open_bid_pct = row.open_bid_pct;
                        if (row.auc_vol_ratio !== undefined && row.auc_vol_ratio !== null && String(row.auc_vol_ratio).trim() !== '') existing.auc_vol_ratio = row.auc_vol_ratio;
                        if (row.auc_turnover !== undefined && row.auc_turnover !== null && String(row.auc_turnover).trim() !== '') existing.auc_turnover = row.auc_turnover;
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
                        auc_pct_chg: row.auc_pct_chg || '',
                        um_vol: row.um_vol || '',
                        open_bid_pct: row.open_bid_pct || '',
                        auc_vol_ratio: row.auc_vol_ratio || '',
                        auc_turnover: row.auc_turnover || '',
                        source: row.source || 'manual'
                    };
                    // 注意：影子记录不加入 newWatchlistIndex
            });

            // ---- ③ 合并 market_metrics(scope='hot')：yest_volume/volume 的二级回退 ----
            //    change_pct 自 Phase 3 起不再从 hot 回退，权威源是 market_metrics(scope='auction')。
            // 【BUG-FIX】auction scope 部分行 yest_volume 为空，但 hot scope 同一股票同一日有值——
            //   yest_volume 是市场客观值（前一日完整成交量），与 tab 归属无关，可安全回退。
            //   只给已存在的行补值，不新增行（hot 影子记录不进入 auction 列表）。
            hotRows.forEach(function(row) {
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
                // 【Phase 3】不再从 hot scope 回退 change_pct：当天涨幅的唯一权威是
                // market_metrics(scope='auction').change_pct，hot 的 change_pct 属于另一个 tab，
                // 混入会污染早盘竞价板的涨幅显示。
            });
            if (hotError) { _dbgLog('[AUCTION-PULL] hot 二级回退失败（不影响主流程）' + (hotError && hotError.message || hotError)); }

            if (watchlistError && metricsError) {
                throw watchlistError;
            }

            // 通过 guard API 按日期写入，保留未在云端返回的本地日期（日期隔离）
            Object.keys(cloudByDate).forEach(function(d) {
                const rows = Object.values(cloudByDate[d]);
                setAuctionDateData(d, rows, 'pullAuctionFromTable');
                // 方案2：覆盖该日期的正式成员索引（未在云端返回的日期保留原索引）
                state._auctionWatchlistIndex[d] = newWatchlistIndex[d] || new Set();
                // 返回值只含正式成员行，供调用方做长度检查
                const watchlistSet = state._auctionWatchlistIndex[d];
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
            _dbgLog('[AUCTION-WRITE] pullAuctionFromTable cloudDates=' + Object.keys(cloudByDate).length + ' preservedLocalDates=' + (Object.keys(state._auctionMemCache).length - Object.keys(cloudByDate).length));
            return result;
        }


        // ===== setAuctionDateData（从 logic/app-core.js 移至 data 层）=====
        // 写入指定日期的竞价行数据到内存缓存，带 guard 日志
        export function setAuctionDateData(date, newList, source) {
            if (!date || typeof date !== 'string') { _dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
            var normalizedList = newList || [];
            var before = (state._auctionMemCache[date] || []).length;
            state._auctionMemCache[date] = normalizedList;
            var after = (state._auctionMemCache[date] || []).length;
            _dbgLog('[AUCTION-GUARD] set date=' + date + ' before=' + before + ' after=' + after + ' source=' + source + state._guardStack());
            if (_getAuctionStore() && date !== _getAuctionStore().currentDate) {
                try { _dbgLog('[AUCTION-GUARD] sample date=' + date + ' source=' + source + ' stocks=' + (normalizedList||[]).slice(0,3).map(function(r){return r&&r.stock||'?';}).join(',')); } catch(e){}
            }
            state._guardAssertDate(date, source);
        }
        // ===== normalizeAuctionNotes（从 logic/app-core.js 移至 data 层）=====
        export function normalizeAuctionNotes() {
            // §6：直接读内存缓存 state._auctionMemCache（= allData.auction，但重置 allData=null 期间仍稳定），
            // 不再依赖 state.allData.auction 别名，收敛到 Data 层缓存引用。
            if (!state._auctionMemCache) return;
            let hasChanges = false;
            Object.keys(state._auctionMemCache).forEach(date => {
                const dayList = state._auctionMemCache[date];
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
                if (_invalidateTopicCacheFn) _invalidateTopicCacheFn();
            }
        }