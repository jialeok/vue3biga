import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
import { useAuctionStore } from '../stores/auctionStore.js';

// 与 session-and-shield.js / hot-stocks.js 等模块一致的 Pinia store 安全访问器：
// 模块顶层求值时若 Pinia 尚未激活，useAuctionStore() 会抛错，这里兜底返回 null，避免 ReferenceError。
function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }
        import { getSupabase, getNumericVolume } from './supabase-client.js';
        import { _dbgLog, _dbgLogVerbose } from './debug-log.js';
import { startStockTopicsRealtime, stopStockTopicsRealtime } from './stock-topics.js';
import { startStockCodeMapRealtime, stopStockCodeMapRealtime } from './stock-code-map.js';
import { startBiddingRealtime, stopBiddingRealtime } from './bidding-data.js';
import { startJiwangRealtime, stopJiwangRealtime } from './jiwang-data.js';
import { startHighlightsRealtime, stopHighlightsRealtime, pullDailyHighlights } from './daily-highlights.js';
import { startHotStocksRealtime, stopHotStocksRealtime, startHotHighlightsRealtime, stopHotHighlightsRealtime, startHotTrendsRealtime, stopHotTrendsRealtime } from './hot-stocks.js';
import { setAuctionDateData } from './auction-data.js';

        state._jiwangTableAvailable = false; // jiwang_data 表是否可用
        state._jiwangRealtimeChannel = null; // jiwang_data 表的 Realtime 订阅
        state._justPushedJiwang = false; // 刚推送 jiwang_data，忽略自己触发的 Realtime 通知
        state._jiwangPushTimers = {}; // jiwang 按日期各自防抖推送计时器（独立于全量 blob 的 _pushDebounceTimer）

        // ===== 热门股票分组（hot_stocks / hot_stocks_highlights）全局变量 =====
        // 与早盘竞价侧对应变量完全独立，通过 dataSource 参数切换
        state.hotStockList = [];        // 热门股票当前渲染中的股票数组，与 auctionList 平行
        state._hotFullRowCache = {};    // 热门股票全量快照缓存，与 _auctionFullRowCache 平行
        state._hotHighlightsCache = {}; // 热门股票预计算竞/昨高光缓存，与 _dailyHighlightsCache 平行
        state._hotHighlightsTableAvailable = false; // hot_stocks_highlights 表是否可用（运行时标记）
        state._hotHighlightsChannel = null; // hot_stocks_highlights 表的 Realtime 订阅
        state.currentGroup = 'auction'; // 'auction' | 'hot'，当前 Tab 选中的分组
        state._justPushedHotAuction = false; // 刚推送 hot_stocks，忽略自己触发的 Realtime 通知
        // ── 热门股票独立化改造：对齐早盘竞价 8344-8345 行的计数器式屏蔽窗口状态 ──
        // 原裸布尔值 + 各自 setTimeout 2 秒复位的写法无法正确处理并发批量操作
        // （猫抓+同花顺快速连点时，先完成的那个会提前把标志复位，导致后完成的这次
        //  Realtime 回显把本地刚写入的数据冲乱）。改为计数器：每开一个批量操作 +1，
        //  收尾 -1，归零后才启动 2 秒复位定时器。
        state._justPushedHotAuctionCounter = 0;
        state._justPushedHotAuctionTimer = null;
        state._hotAuctionData = _getAuctionStore() ? _getAuctionStore().hotAuctionData : {}; // Vue 化：持有 store 响应式代理；热门股票本地缓存 {date: [items]}，结构与 getAuctionData() 返回一致
        state._hotAuctionTableAvailable = false; // 运行时标记：hot_stocks 表是否可用
        state._hotAuctionRealtimeChannel = null; // hot_stocks 表的 Realtime 订阅
        state._hotTrendsRealtimeChannel = null; // hot_stock_trends 表的 Realtime 订阅（兼容旧表）
        state._marketMetricsHotRealtimeChannel = null; // market_metrics(scope='hot') 表的 Realtime 订阅
        state._hotTrendsTableAvailable = false; // 运行时标记：hot_stock_trends 表是否可用
        state._hotTrendsCache = {}; // hot_stock_trends 表本地缓存 {date: [items]}（原缺失声明）
        state._hotTrendsReloadTimer = null; // hot_stock_trends Realtime 收到变更后的防抖重载定时器（原缺失声明）
        state._justPushedHotTrends = false; // 标记刚推送过 hot_stock_trends，忽略自己触发的 Realtime 通知（原缺失声明，loadHotTrendsFromCloud 第一行就读取它，若在赋值前被调用会 ReferenceError）
        state._hotNumcatDebugSnapshots = {}; // 猫抓补全调试快照（内存，不落 localStorage），key=日期字符串，value=快照对象
        state._hotWatchlistIndex = {}; // 正式成员索引：{ date: Set(stockName) }，来源为 hot_stocks 表（该表天然只有正式成员）。行对象不再携带 in_watchlist 字段。
        // 方案2（对齐 hot tab）：auction tab 正式成员索引。来源为 auction_watchlist 表（天然只有正式成员）
        // + 本地新增的正式成员。行对象不再携带 in_watchlist 字段，正式/影子身份由本索引独立判断。
        state._auctionWatchlistIndex = {};
        export function _getAuctionWatchlistSet(date) {
            return state._auctionWatchlistIndex[date] || new Set();
        }
        export function _isAuctionWatchlistStock(date, stockName) {
            if (!date || !stockName) return false;
            const set = state._auctionWatchlistIndex[date];
            return !!(set && set.has(stockName.trim()));
        }
        // 整日期替换正式成员索引
        export function _setAuctionWatchlistForDate(date, stockNames) {
            if (!date) return;
            state._auctionWatchlistIndex[date] = new Set((stockNames || []).map(function(n) { return (n || '').trim(); }).filter(Boolean));
        }
        // 方案2：序列化正式成员索引为 {date:[stock,...]}，供导出备份携带。
        // 行对象不携带 in_watchlist 字段，索引是正式/影子身份的唯一权威来源，
        // 备份必须把索引一起导出，否则恢复时无法区分正式成员和影子记录。
        export function _serializeAuctionWatchlistIndex() {
            const out = {};
            Object.keys(state._auctionWatchlistIndex).forEach(function(date) {
                const set = state._auctionWatchlistIndex[date];
                if (set && set.size > 0) {
                    out[date] = Array.from(set).map(function(n) { return (n || '').trim(); }).filter(Boolean);
                }
            });
            return out;
        }
        export function _addAuctionWatchlistMember(date, stockName) {
            if (!date || !stockName) return;
            if (!state._auctionWatchlistIndex[date]) state._auctionWatchlistIndex[date] = new Set();
            state._auctionWatchlistIndex[date].add(stockName.trim());
        }
        export function _removeAuctionWatchlistMember(date, stockName) {
            if (!date || !stockName) return;
            const set = state._auctionWatchlistIndex[date];
            if (set) set.delete(stockName.trim());
        }
        // 从导入/备份的行数据中提取正式成员名单（兼容旧数据可能携带的 in_watchlist 字段）
        export function _extractWatchlistNamesFromRows(rows) {
            const names = [];
            (rows || []).forEach(function(r) {
                if (!r || !r.stock) return;
                // 兼容旧数据：in_watchlist === false 为影子记录；其余（true/undefined/null）视为正式成员
                if (r.in_watchlist === false) return;
                names.push(r.stock.trim());
            });
            return names;
        }

        export function generateToken() {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        export async function writeSessionToken(token) {
            try {
                const sb = getSupabase();
                const { error } = await sb
                    .from('user_data')
                    .upsert({ id: 'session', data: { _session_token: token }, updated_at: new Date().toISOString() });
                if (error) throw error;
            } catch (e) {
                console.error('window.writeSessionToken 失败:', e);
            }
        }

        // 读取云端当前 session token（刷新恢复登录时用来校验本地 token 是否仍然有效）
        export async function readSessionToken() {
            try {
                const sb = getSupabase();
                const { data, error } = await sb
                    .from('user_data')
                    .select('data')
                    .eq('id', 'session')
                    .single();
                if (error) throw error; // 包括"session 行不存在"的情况，走 catch 返回 undefined，不阻断登录
                return (data && data.data && data.data._session_token) || null;
            } catch (e) {
                console.warn('window.readSessionToken 失败（不阻断登录）:', e && e.message);
                return undefined; // undefined 表示读取失败/无该行，区别于 null（云端 token 字段为空）
            }
        }

        // 启动 Realtime 订阅：同时监听互踢 (session行) 和数据变更 (owner行)
        export function startSessionPoll() {
            stopSessionPoll();
            startAuctionRealtime(); // 同时启动 auction_watchlist / market_metrics 表的 Realtime 订阅
            startStockTopicsRealtime(); // 同时启动 stock_topics 表的 Realtime 订阅（题材库）
            startStockCodeMapRealtime(); // 同时启动 stockcodemap 表的 Realtime 订阅（股票代码映射唯一真相源）
            startBiddingRealtime(); // 同时启动 bidding_data 表的 Realtime 订阅（竞价变化看板）
            startJiwangRealtime(); // 同时启动 jiwang_data 表的 Realtime 订阅（记忘看板）
            startHighlightsRealtime(); // 同时启动 daily_highlights 表的 Realtime 订阅（竞/昨高光）
            startHotStocksRealtime(); // 同时启动 hot_stocks / market_metrics(scope=hot) 的 Realtime 订阅（共享影子记录：喂题材缓存与趋势二级市场回退）
            startHotHighlightsRealtime(); // 同时启动 hot_stocks_highlights 的 Realtime 订阅（共享竞/昨高光影子数据）
            startHotTrendsRealtime(); // 同时启动 hot_stock_trends / market_metrics(scope=hot) 的 Realtime 订阅（共享趋势图影子记录）
            try {
                const sb = getSupabase();
                state._realtimeChannel = sb
                    .channel('user_data_changes')
                    .on('postgres_changes', {
                        event: 'UPDATE', schema: 'public', table: 'user_data'
                    }, function(payload) {
                        if (!payload || !payload.new) return;
                        const rowId = payload.new.id;

                        // session 行变化 → 检查是否被踢
                        if (rowId === 'session') {
                            const remoteToken = payload.new.data && payload.new.data._session_token;
                            if (remoteToken && remoteToken !== state._sessionToken) _emit('auth:force-logout');
                            return;
                        }

                        // owner 行变化 → 自动拉取最新数据并刷新
                        if (rowId === 'owner') {
                            if (state._justPushed) { _dbgLog('Realtime: owner 行变化，但是自己刚推送的，忽略'); return; } // 自己刚推的，忽略
                            _dbgLog('Realtime: owner 行变化（他端推送），触发 data:cloud-changed');
                            // 取消待推送，防止拉取过程中旧数据被推回云端
                            if (state._pushDebounceTimer) { clearTimeout(state._pushDebounceTimer); state._pushDebounceTimer = null; }
                            _emit('data:cloud-changed');
                        }
                    })
                    .subscribe();
                console.log('Realtime 订阅已启动');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] Realtime 订阅失败 ' + (e && e.message || e));
            }
        }

        export function stopSessionPoll() {
            if (state._realtimeChannel) {
                try { getSupabase().removeChannel(state._realtimeChannel); } catch(e) {}
                state._realtimeChannel = null;
            }
            stopAuctionRealtime();
            stopStockTopicsRealtime();
            stopStockCodeMapRealtime();
            stopBiddingRealtime();
            stopJiwangRealtime();
            stopHighlightsRealtime();
            stopHotStocksRealtime();
            stopHotHighlightsRealtime();
            stopHotTrendsRealtime();
        }

        // ===== 早盘竞价tap：两张表（auction_watchlist / market_metrics / daily_highlights）的
        // Realtime 订阅共用同一个"统一防抖池"。
        // 背景：与 hot 分组同理（见下方 hot 分组的 _scheduleHotRealtimeReload 注释）——
        // 抓取程序一次同步操作常常同时触发 auction_watchlist、market_metrics 和 daily_highlights 三张表的变化，
        // 若各自独立 800ms 防抖、各自独立调用 renderAuction()，会导致极短时间内（100~200ms）
        // 早盘竞价列表的 DOM 被连续整体重建 2 次。用户点击"序号"展开趋势图的瞬间，若恰好
        // 撞上这类连锁重渲染，点击目标节点可能已被替换或状态被下一轮渲染的自动展开覆盖，
        // 表现为"卡顿、有时点不出来、点开又像被自动收起"。
        // 统一后：不论哪张表先收到变化通知，都汇入同一个定时器，到点后按需重新拉取各自数据，
        // 最后只调用一次 renderAuction()。
        state._auctionRealtimeTimer = null;
        state._pendingRealtimeDates = new Set();
        state._pendingAuctionReload = { marketData: false, highlights: false };
        export function _scheduleAuctionRealtimeReload() {
            if (state._auctionRealtimeTimer) clearTimeout(state._auctionRealtimeTimer);
            state._auctionRealtimeTimer = setTimeout(function() {
                var need = state._pendingAuctionReload;
                state._pendingAuctionReload = { marketData: false, highlights: false };
                var dates = Array.from(state._pendingRealtimeDates);
                state._pendingRealtimeDates.clear();
                state._auctionRealtimeTimer = null;
                var tasks = [];
                if (need.marketData) {
                    tasks = tasks.concat(dates.map(function(d) {
                        if (typeof pullAuctionMarketDataForDate === 'function') {
                            return pullAuctionMarketDataForDate(d, {realtime:true}).catch(function(e) {
                                _dbgLog('[AUCTION-ERR] realtime window.pullAuctionMarketDataForDate ' + (e && e.message));
                            });
                        }
                        return Promise.resolve();
                    }));
                }
                if (need.highlights) {
                    tasks.push(pullDailyHighlights().catch(function(e) {
                        _dbgLog('[AUCTION-ERR] state._scheduleAuctionRealtimeReload highlights ' + (e && e.message || e));
                    }));
                }
                Promise.all(tasks).then(function() {
                    _emit('data:realtime-update', { boards: 'auction' });
                });
            }, 800);
        }
        export function _debounceAuctionRealtime(date) {
            state._pendingRealtimeDates.add(date);
            state._pendingAuctionReload.marketData = true;
            _scheduleAuctionRealtimeReload();
        }

        export function startAuctionRealtime() {
            stopAuctionRealtime();
            try {
                const sb = getSupabase();
                state._auctionRealtimeChannel = sb
                    .channel('auction_watchlist_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'auction_watchlist'
                    }, function(payload) {
                        if (state._justPushedAuction) return; // 自己刚推的，忽略
                        const row = payload.new || payload.old;
                        if (!row || !row.date) return;
                        _debounceAuctionRealtime(row.date);
                    })
                    .subscribe();
                state._marketMetricsRealtimeChannel = sb
                    .channel('market_metrics_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'market_metrics'
                    }, function(payload) {
                        if (state._justPushedAuction) return; // 自己刚推的，忽略
                        const row = payload.new || payload.old;
                        // 处理 scope='auction' 的变更；也处理 scope='hot'——
                        // auction 合并以 hot 作为 yest_volume/volume/change_pct 的二级回退，
                        // hot 写入新值时 auction 看板也需重拉刷新（统一防抖池，不会与 hot 分组互相循环）。
                        if (!row || !row.date || (row.scope !== 'auction' && row.scope !== 'hot')) return;
                        _debounceAuctionRealtime(row.date);
                    })
                    .subscribe();
                console.log('Auction Realtime 订阅已启动（auction_watchlist + market_metrics）');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] window.startAuctionRealtime 订阅失败 ' + (e && e.message || e));
            }
        }

        export function stopAuctionRealtime() {
            if (state._auctionRealtimeChannel) {
                try { getSupabase().removeChannel(state._auctionRealtimeChannel); } catch(e) {}
                state._auctionRealtimeChannel = null;
            }
            if (state._marketMetricsRealtimeChannel) {
                try { getSupabase().removeChannel(state._marketMetricsRealtimeChannel); } catch(e) {}
                state._marketMetricsRealtimeChannel = null;
            }
        }

        // 正在执行"获取最近多板"等整表覆盖式导入操作的日期集合。
        // 修复：导入函数（如 fetchLadderConstituentsMain）本地写入 _auctionMemCache 到
        // 云端推送完成之间有一段异步窗口（网络耗时 + 2 秒推送防抖）。若这期间 Realtime
        // 收到任何其它变更通知（哪怕是同一次导入自己触发的、或另一台设备的无关操作），
        // pullAuctionMarketDataForDate 会用云端"旧数据"整段替换 _auctionMemCache[date]，
        // 把刚导入还没来得及推送上云的新列表整个冲掉——表现为"导入最近多板，页面自动
        // 刷新后列表被清空/变乱、出现重复股票"。用这个锁在导入期间让 Realtime 拉取直接跳过
        // 该日期，导入完成后解锁，之后的 Realtime 通知才正常生效。
        if (!state._auctionImportLockedDates) state._auctionImportLockedDates = new Set();
        export function lockAuctionDateForImport(date) { if (date) state._auctionImportLockedDates.add(date); }
        export function unlockAuctionDateForImport(date) { if (date) state._auctionImportLockedDates.delete(date); }

        // 拉取某日期的行情数据并合并到本地（只更新行情列，保留本地状态标记）
        // 拆表后：同时读取 auction_watchlist 与 market_metrics(scope='auction')，合并后整段替换 _auctionMemCache[date]。
        // 方案2：行对象不再携带 in_watchlist 字段；正式/影子身份由 _auctionWatchlistIndex[date] Set 独立维护。
        export async function pullAuctionMarketDataForDate(date, opts) {
            if (!state._auctionTableAvailable && !state._marketMetricsTableAvailable) return;
            if (state._auctionImportLockedDates && state._auctionImportLockedDates.has(date)) {
                _dbgLog && _dbgLog('[AUCTION-PULL] ' + date + ' 正在导入中（锁定），跳过本次 Realtime 回拉，避免冲掉刚写入的数据');
                return;
            }
            const sb = getSupabase();
            const cloudByStock = {};
            // 方案2：本次拉取该日期的正式成员索引（auction_watchlist 表天然只有正式成员）
            const newWatchlistSet = new Set();

            // 1) 读取 auction_watchlist（正式列表成员）
            try {
                const { data, error } = await sb.from('auction_watchlist')
                    .select('stock,code,volume,yest_volume,note,change_pct,topics,source,obs_auto_added,selected,bought,sold,fixed,updated_at,updated_by')
                    .eq('date', date);
                if (error) throw error;
                (data || []).forEach(function(row) {
                    const key = (row.stock || '').trim();
                    if (!key) return;
                    cloudByStock[key] = {
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
                    newWatchlistSet.add(key);
                });
                state._auctionTableAvailable = true;
            } catch (e) {
                state._auctionTableAvailable = false;
            }

            // 2) 读取 market_metrics(scope='auction')（影子记录/指标数据）
            try {
                const { data, error } = await sb.from('market_metrics')
                    .select('stock,code,volume,yest_volume,change_pct,time930,seal_count,auc_pct_chg,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover,source')
                    .eq('date', date)
                    .eq('scope', 'auction');
                if (error) throw error;
                (data || []).forEach(function(row) {
                    const key = (row.stock || '').trim();
                    if (!key) return;
                    if (cloudByStock[key]) {
                        // 该股票同时在 watchlist 里：补充 metrics 特有字段（time930/seal_count），
                        // 并在 watchlist 行的 volume/yest_volume/change_pct 为空时回退取 metrics 的值。
                        // 【BUG-FIX】worker morning 把 watchlist 的 volume/yest_volume/change_pct 写成空串，
                        // 真实值只写到了 market_metrics；如果这里不回退，刷新后趋势图会读空值消失。
                        if (row.time930 !== undefined && row.time930 !== null && row.time930 !== '') cloudByStock[key].time930 = row.time930;
                        if (row.seal_count !== undefined && row.seal_count !== null && row.seal_count !== '') cloudByStock[key].seal_count = row.seal_count;
                        if (row.volume !== undefined && row.volume !== null && String(row.volume).trim() !== '' &&
                            (!cloudByStock[key].volume || String(cloudByStock[key].volume).trim() === '')) {
                            cloudByStock[key].volume = row.volume;
                        }
                        if (row.yest_volume !== undefined && row.yest_volume !== null && String(row.yest_volume).trim() !== '' &&
                            (!cloudByStock[key].yest_volume || String(cloudByStock[key].yest_volume).trim() === '')) {
                            cloudByStock[key].yest_volume = row.yest_volume;
                            cloudByStock[key].yestVolume = row.yest_volume; // camelCase 别名同步
                        }
                        if (row.change_pct !== undefined && row.change_pct !== null && String(row.change_pct).trim() !== '' &&
                            (!cloudByStock[key].change_pct || String(cloudByStock[key].change_pct).trim() === '')) {
                            cloudByStock[key].change_pct = row.change_pct;
                            cloudByStock[key].changePct = row.change_pct; // camelCase 别名同步
                            // 竞价指标字段（仅 market_metrics 有，watchlist 行无这些列，直接补值）
                            if (row.auc_pct_chg !== undefined && row.auc_pct_chg !== null && String(row.auc_pct_chg).trim() !== '') cloudByStock[key].auc_pct_chg = row.auc_pct_chg;
                            if (row.um_vol !== undefined && row.um_vol !== null && String(row.um_vol).trim() !== '') cloudByStock[key].um_vol = row.um_vol;
                            if (row.open_bid_pct !== undefined && row.open_bid_pct !== null && String(row.open_bid_pct).trim() !== '') cloudByStock[key].open_bid_pct = row.open_bid_pct;
                            if (row.auc_vol_ratio !== undefined && row.auc_vol_ratio !== null && String(row.auc_vol_ratio).trim() !== '') cloudByStock[key].auc_vol_ratio = row.auc_vol_ratio;
                            if (row.auc_turnover !== undefined && row.auc_turnover !== null && String(row.auc_turnover).trim() !== '') cloudByStock[key].auc_turnover = row.auc_turnover;
                        }
                        return;
                    }
                    cloudByStock[key] = {
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
                    // 注意：影子记录不加入 newWatchlistSet
                });
                state._marketMetricsTableAvailable = true;
            } catch (e) {
                state._marketMetricsTableAvailable = false;
            }

            // 3) 读取 market_metrics(scope='hot') 作为 yest_volume/volume/change_pct 的二级回退
            // 【BUG-FIX】auction scope 部分行 yest_volume 为空，但 hot scope 同一股票同一日有值——
            //   yest_volume 是市场客观值（前一日完整成交量），与 tab 归属无关，可安全回退。
            //   只给已存在的行补值，不新增行（hot 影子记录不进入 auction 列表）。
            try {
                const { data: hotData, error: hotError } = await sb.from('market_metrics')
                    .select('stock,volume,yest_volume,change_pct')
                    .eq('date', date)
                    .eq('scope', 'hot');
                if (!hotError && hotData) {
                    hotData.forEach(function(row) {
                        const key = (row.stock || '').trim();
                        if (!key) return;
                        const existing = cloudByStock[key];
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
                }
            } catch (e) { /* hot 回退失败不影响主流程 */ }

            if (Object.keys(cloudByStock).length === 0) return;

            // 全量快照缓存：包含该日期所有行（正式成员 + 影子记录），供历史行情查询
            // 阶段四 Bug 6 修复：改为整段替换 _auctionMemCache（对齐 bidding 模式 pullBiddingForDate）。
            // 同时为兼容现有渲染代码（读 camelCase 字段），每行同时携带 snake_case 和 camelCase 别名。
            const cloudNames = new Set(Object.keys(cloudByStock));
            // 保留本地 obsAutoAdded=true 的观察组继承股票（云端没有的），追加到云端列表末尾
            const prePullList = state._auctionMemCache[date] || [];
            const localObsStocks = prePullList.filter(function(s) {
                return s && s.stock && s.obsAutoAdded && !cloudNames.has(s.stock.trim());
            });
            // 观察组继承股票属于正式成员，需登记到索引
            localObsStocks.forEach(function(s) { newWatchlistSet.add(s.stock.trim()); });
            const normalizedRows = Object.values(cloudByStock).concat(localObsStocks);
            // 方案2：用 _auctionWatchlistIndex 判断本地正式成员数量
            var _localFormal = (state._auctionMemCache[date] || []).filter(function(s) { return s && s.stock && _isAuctionWatchlistStock(date, s.stock.trim()); }).length;
            var _cloudN = (normalizedRows || []).length;
            if (opts && opts.realtime && _localFormal > 0 && _cloudN < _localFormal) {
                _dbgLog('[AUCTION-GUARD] ⚠️ refuse replace date=' + date + ' local=' + _localFormal + ' cloud=' + _cloudN + ' (realtime)');
                return;
            }
            setAuctionDateData(date, normalizedRows, 'pullAuctionMarketDataForDate' + (opts && opts.realtime ? '(realtime)' : ''));
            // 方案2：替换该日期的正式成员索引（auction_watchlist 行 + 本地保留的观察组继承股票）
            state._auctionWatchlistIndex[date] = newWatchlistSet;

            // 更新状态签名，避免 pull 后立即触发无意义的 push
            if (date === state.currentDate) {
                const watchlistSet = state._auctionWatchlistIndex[date] || new Set();
                const watchlistRows = normalizedRows.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); });
                state._lastPushedAuctionStatus = JSON.stringify(watchlistRows.map(function(s) {
                    return { s: s.stock, sel: s.selected || false, b: s.bought || false,
                             so: s.sold || false, f: s.fixed || false };
                }));
            }
        }

        // 查询某只股票在某日期的曲线数据
        // 阶段三 E：auction 数据源改读 _auctionMemCache（含 in_watchlist true/false 全部行，供趋势图历史查询）
        // 从指定缓存里读某股票某日的字段值（供 getStockHistoryValue 主读+回退复用）
        // [PERF-CORE] 按数组引用缓存 股票名→行 映射（含长度校验，行增删自动重建），
        // 把 getStockHistoryValue 的每次 O(n) 线性 find 降为 O(1)。
        // 信号集合函数（平行/竞昨/差值）每只股票要查 2 个字段 × 2 个缓存，
        // 原来一次看板计算要执行上万次 trim 比较，是"分组后处理"耗时主因之一。
        state._histRowMapCache = new WeakMap(); // rows数组 -> { len, map }
        export function _histRowMapFor(rows) {
            let e = state._histRowMapCache.get(rows);
            if (!e || e.len !== rows.length) {
                const map = new Map();
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (r && r.stock) {
                        const k = r.stock.trim();
                        if (!map.has(k)) map.set(k, r);
                    }
                }
                e = { len: rows.length, map: map };
                state._histRowMapCache.set(rows, e);
            }
            return e.map;
        }
        export function _readHistoryValueFrom(rows, stockName, field) {
            if (!rows) return null;
            const found = _histRowMapFor(rows).get(stockName);
            if (!found) return null;
            if (field === 'changePct') {
                // change_pct 存的是字符串，如 "+3.25%" / "-1.08%"，解析成数字（百分比数值本身，不除以100）
                const raw = found.change_pct || found.changePct || '';
                if (!raw) return null;
                const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
                return isNaN(num) ? null : num;
            }
            if (field === 'aucPctChg') {
                // auc_pct_chg（五日竞价涨幅）：与 change_pct 同源，存的是字符串如 "+3.25%"，解析成数字
                const raw = found.auc_pct_chg || found.aucPctChg || '';
                if (!raw) return null;
                const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
                return isNaN(num) ? null : num;
            }
            // 当日竞价指标（仅 market_metrics 有，不进历史趋势，只取当日值）
            if (field === 'umVol') {
                const raw = found.um_vol != null ? String(found.um_vol) : '';
                return raw.trim() !== '' ? raw : null;
            }
            if (field === 'openBidPct') {
                const raw = found.open_bid_pct != null ? String(found.open_bid_pct) : '';
                return raw.trim() !== '' ? raw : null;
            }
            if (field === 'aucVolRatio') {
                const raw = found.auc_vol_ratio != null ? String(found.auc_vol_ratio) : '';
                return raw.trim() !== '' ? raw : null;
            }
            if (field === 'aucTurnover') {
                const raw = found.auc_turnover != null ? String(found.auc_turnover) : '';
                return raw.trim() !== '' ? raw : null;
            }
            if (field === 'volume') {
                return getNumericVolume(found.volume);
            }
            // 本地内存行常用 camelCase yestVolume，云端/历史表用 snake_case yest_volume，两者都要兼容
            return getNumericVolume(found.yest_volume || found.yestVolume);
        }

        // 趋势图历史取数（含两个 tab 影子数据共享）：
        // 本 tab 缓存优先；本 tab"该日没有这只股票的行"或"行里该字段为空"时，
        // 回退读另一个 tab 的全量缓存（auction ↔ hot 互为影子数据源）。
        // 【纯读取共享】不写任何一个表、不复制任何数据——两个 tab 第一页的股票数量、
        // in_watchlist 归属、sync 逻辑完全不受影响；哈药股份这类只在热门股票 tab
        // 存在的股票，永远不会因此出现在早盘竞价第一页（第一页渲染不经过本函数）。
        // 两边都有数据但值不同时，本 tab 的值优先（只有本 tab 缺失才用对方的）。
        export function getStockHistoryValue(date, stockName, field, dataSource='auction') {
            const primaryCache = dataSource === 'hot' ? state._hotFullRowCache : state._auctionMemCache;
            const fallbackCache = dataSource === 'hot' ? state._auctionMemCache : state._hotFullRowCache;
            const primaryVal = _readHistoryValueFrom(primaryCache[date], stockName, field);
            if (primaryVal !== null) return primaryVal;
            // 本 tab 缺失 → 回退另一个 tab 的影子数据
            const fallbackVal = _readHistoryValueFrom(fallbackCache[date], stockName, field);
            if (fallbackVal !== null) return fallbackVal;
            // 热门股票：再回退 hot_stock_trends 独立缓存（抓取程序/Worker 写入的历史趋势数据）
            if (dataSource === 'hot' && state._hotTrendsCache && state._hotTrendsCache[date]) {
                return _readHistoryValueFrom(state._hotTrendsCache[date], stockName, field);
            }
            // [DEBUG] 三处缓存均未命中，记录关键信息帮助定位"刷新后消失"
            _dbgLogVerbose('[HIST-MISS] date=' + date + ' stock=' + stockName + ' field=' + field +
                ' dataSource=' + dataSource +
                ' primaryRows=' + (primaryCache[date] ? primaryCache[date].length : 'null') +
                ' fallbackRows=' + (fallbackCache[date] ? fallbackCache[date].length : 'null') +
                ' hotTrendsRows=' + ((state._hotTrendsCache && state._hotTrendsCache[date]) ? state._hotTrendsCache[date].length : 'null'));
            return null;
        }

