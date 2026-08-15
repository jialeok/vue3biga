import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { useUiStore } from '../stores/uiStore.js';

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
import { startHotStocksRealtime, stopHotStocksRealtime, startHotHighlightsRealtime, stopHotHighlightsRealtime, startHotTrendsRealtime, stopHotTrendsRealtime, triggerHotMetricsRealtimeReload } from './hot-stocks.js';
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
        // 从导入/备份的行数据中提取正式成员名单。
        // 重构（Phase 2）：正式/影子身份的唯一权威是 _auctionWatchlistIndex[date]（Set），
        // 行对象不再携带 in_watchlist 字段，禁止用行字段推断身份（消除“双标准 → 凭空冒股”）。
        // 新备份恢复优先走 backupPayload.watchlist（序列化索引，见 app-core 恢复逻辑）；
        // 此处仅作“无索引旧备份”的最后兜底：新 schema 下传入的行本就来自 auction_watchlist（均正式），
        // 故直接取全部股票名，不再读 in_watchlist。
        export function _extractWatchlistNamesFromRows(rows) {
            const names = [];
            (rows || []).forEach(function(r) {
                if (!r || !r.stock) return;
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
                console.error('writeSessionToken 失败:', e);
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
                console.warn('readSessionToken 失败（不阻断登录）:', e && e.message);
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
                                _dbgLog('[AUCTION-ERR] realtime pullAuctionMarketDataForDate ' + (e && e.message));
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
                        const row = payload.new || payload.old;
                        // 处理 scope='auction' 的变更；也处理 scope='hot'——
                        // auction 合并仍以 hot 作为 yest_volume/volume 的二级回退（change_pct 自 Phase 3 起
                        // 不再从 hot 回退，权威源是 market_metrics(scope='auction')），
                        // hot 写入新值时 auction 看板也需重拉刷新（统一防抖池，不会与 hot 分组互相循环）。
                        // [FIX P1-9] market_metrics 双 channel 去重：本订阅为唯一权威订阅。scope='hot' 行
                        // 除触发 auction 看板重拉外，还需刷热门股票看板（原 hot-stocks 重复订阅的逻辑），
                        // 故复用 triggerHotMetricsRealtimeReload() 触发热门看板刷新，避免重复订阅且更新不丢失。
                        if (!row || !row.date || (row.scope !== 'auction' && row.scope !== 'hot')) return;
                        if (row.scope === 'auction') {
                            if (state._justPushedAuction) return; // 自己刚推的，忽略
                            _debounceAuctionRealtime(row.date);
                        } else if (row.scope === 'hot') {
                            _debounceAuctionRealtime(row.date); // auction 以 hot 作 volume/yest_volume 二级回退，需重拉
                            triggerHotMetricsRealtimeReload(row.date); // 热门股票看板刷新（替代原重复订阅）
                        }
                    })
                    .subscribe();
                console.log('Auction Realtime 订阅已启动（auction_watchlist + market_metrics）');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] startAuctionRealtime 订阅失败 ' + (e && e.message || e));
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

        // 【Phase 4 病灶 D 根因修复】不再用导入锁打补丁。整段覆盖式回拉才是"冲掉本地未上云
        // 数据"的真正根因——已改为按股票 union 合并（见 pullAuctionMarketDataForDate）：
        // 云端字段覆盖本地同名段、本地独有字段与本地独有股票保留，Realtime 回拉不再清空/打乱
        // 刚导入的列表。故 _auctionImportLockedDates 锁已删除（多余的并发安全网）。

        // 拉取某日期的行情数据并合并到本地（只更新行情列，保留本地状态标记）
        // 拆表后：同时读取 auction_watchlist 与 market_metrics(scope='auction')，合并后整段替换 _auctionMemCache[date]。
        // 方案2：行对象不再携带 in_watchlist 字段；正式/影子身份由 _auctionWatchlistIndex[date] Set 独立维护。
        export async function pullAuctionMarketDataForDate(date, opts) {
            if (!state._auctionTableAvailable && !state._marketMetricsTableAvailable) return;
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
                    // §6：obs_auto_added 观察股不计入正式成员索引（根因：87≠76）。索引只含正式成员。
                    if (!row.obs_auto_added) newWatchlistSet.add(key);
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
                        // 并仅在 watchlist 行的 volume/yest_volume 为空时回退取 metrics 的值。
                        // 【BUG-FIX】worker morning 把 watchlist 的 volume/yest_volume 写成空串，
                        // 真实值只写到了 market_metrics；如果这里不回退，刷新后趋势图会读空值消失。
                        // 注意：change_pct 不再走回退——它已改为以 market_metrics 为唯一权威（见下方权威模型块）。
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
                        // 【权威模型 / Phase 3】当天涨幅以 market_metrics(scope='auction').change_pct 为唯一权威。
                        // worker 与「获取涨幅」按钮都写它（patchAuctionFieldBatch→metricsPatch），后写者胜。
                        // market_metrics 非空即覆盖合并行，不再 only-if-empty 回退到 watchlist 行
                        // （watchlist 行的 change_pct 由 worker 写成空串，仅为兼容保留其旧手动值兜底）。
                        // 竞价指标字段（auc_pct_chg 等）仅 market_metrics 有，按「有则补」填充，与涨幅权威无关。
                        if (row.change_pct !== undefined && row.change_pct !== null && String(row.change_pct).trim() !== '') {
                            cloudByStock[key].change_pct = row.change_pct;
                            cloudByStock[key].changePct = row.change_pct; // camelCase 别名同步
                        }
                        if (row.auc_pct_chg !== undefined && row.auc_pct_chg !== null && String(row.auc_pct_chg).trim() !== '') cloudByStock[key].auc_pct_chg = row.auc_pct_chg;
                        if (row.um_vol !== undefined && row.um_vol !== null && String(row.um_vol).trim() !== '') cloudByStock[key].um_vol = row.um_vol;
                        if (row.open_bid_pct !== undefined && row.open_bid_pct !== null && String(row.open_bid_pct).trim() !== '') cloudByStock[key].open_bid_pct = row.open_bid_pct;
                        if (row.auc_vol_ratio !== undefined && row.auc_vol_ratio !== null && String(row.auc_vol_ratio).trim() !== '') cloudByStock[key].auc_vol_ratio = row.auc_vol_ratio;
                        if (row.auc_turnover !== undefined && row.auc_turnover !== null && String(row.auc_turnover).trim() !== '') cloudByStock[key].auc_turnover = row.auc_turnover;
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
                        // 【Phase 3】不再从 hot scope 回退 change_pct：当天涨幅的唯一权威是
                        // market_metrics(scope='auction').change_pct，hot 的 change_pct 属于另一个 tab，
                        // 混入会污染早盘竞价板的涨幅显示。
                    });
                }
            } catch (e) { /* hot 回退失败不影响主流程 */ }

            if (Object.keys(cloudByStock).length === 0) return;

            // 【Phase 4 病灶 D 根因修复】不再整段覆盖 _auctionMemCache[date]，改为按股票 union 合并：
            //  1) 以本地现有行打底（保留本地状态标记 / 本地独有股票 / 观察组继承股）；
            //  2) 云端行 upsert——同名段以云端为准覆盖，本地独有字段保留；
            //  3) 本地独有股票（如刚导入尚未推送上云的股票）不会被冲掉，也不会凭空新增/重复。
            // 这样 Realtime 回拉与「获取最近多板」导入并发时不再互相覆盖，导入锁因此可删。
            // 每张行同时携带 snake_case 与 camelCase 别名，供渲染代码兼容。
            const prePullList = state._auctionMemCache[date] || [];
            const preByStock = {};
            prePullList.forEach(function(r) { if (r && r.stock) preByStock[r.stock.trim()] = r; });

            const resultByStock = {};
            // 1) 本地现有行打底（保留本地独有字段与本地独有股票）
            prePullList.forEach(function(r) { if (r && r.stock) resultByStock[r.stock.trim()] = Object.assign({}, r); });
            // 2) 云端行 upsert：同名段覆盖，本地独有字段保留
            Object.keys(cloudByStock).forEach(function(key) {
                const cloudRow = cloudByStock[key];
                const existing = resultByStock[key];
                if (existing) {
                    Object.keys(cloudRow).forEach(function(k) { existing[k] = cloudRow[k]; });
                    resultByStock[key] = existing;
                } else {
                    resultByStock[key] = Object.assign({}, cloudRow);
                }
            });

            // §6：观察组(obsAutoAdded)绝不进入正式成员索引——索引只含 auction_watchlist 的正式成员。
            // 观察组行仍保留在 auctionData（prePullList）中，由 getTodayGroupList 按 obsAutoAdded 标记放行显示，
            // 既保持观察组可见/参与次日继承，又不污染「总数量」计数（87≠76 根因）。

            const normalizedRows = Object.values(resultByStock);
            // 方案2：用 _auctionWatchlistIndex 判断本地正式成员数量（旧索引，本函数末尾才更新）
            var _localFormal = prePullList.filter(function(s) { return s && s.stock && _isAuctionWatchlistStock(date, s.stock.trim()); }).length;
            var _cloudN = (normalizedRows || []).length;
            if (opts && opts.realtime && _localFormal > 0 && _cloudN < _localFormal) {
                _dbgLog('[AUCTION-GUARD] ⚠️ refuse merge date=' + date + ' local=' + _localFormal + ' cloud=' + _cloudN + ' (realtime)');
                return;
            }
            setAuctionDateData(date, normalizedRows, 'pullAuctionMarketDataForDate' + (opts && opts.realtime ? '(realtime)' : ''));
            // 方案2：替换该日期的正式成员索引（auction_watchlist 行 + 本地保留的观察组继承股票）
            state._auctionWatchlistIndex[date] = newWatchlistSet;

            // 更新状态签名，避免 pull 后立即触发无意义的 push
            if (date === useUiStore().currentDate) {
                const watchlistSet = state._auctionWatchlistIndex[date] || new Set();
                const watchlistRows = normalizedRows.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); });
                state._lastPushedAuctionStatus = JSON.stringify(watchlistRows.map(function(s) {
                    return { s: s.stock, sel: s.selected || false, b: s.bought || false,
                             so: s.sold || false, f: s.fixed || false };
                }));
            }
        }

        // ===== 历史趋势只读选择器已物理拆分至 watchlist-helpers.js =====
        // 原导出通过 barrel re-export 保留，外部 import 路径不变（零破坏，§16）。
        export { _histRowMapFor, _readHistoryValueFrom, getStockHistoryValue } from './watchlist-helpers.js';

        // 趋势图历史按需补水：某日行情缓存未命中（典型为「非当前交易日」的历史日，
        // pullAuctionMarketDataForDate 只拉当前日期）时，直接从 market_metrics 云端拉该 (date,stock)
        // 并合并进内存缓存，使 getStockHistoryValue 后续能命中，趋势图显示真实 5 日数据。
        // 这是 §6 根治（缓存未 hydration 导致趋势空白），不是兼容补丁：只补缺失行，不动既有真相源。
        export async function hydrateStockHistoryRow(date, stockName, dataSource = 'auction') {
            if (!date || !stockName) return null;
            const cache = dataSource === 'hot' ? state._hotFullRowCache : state._auctionMemCache;
            const rows = cache[date] || [];
            const found = _histRowMapFor(rows).get(stockName.trim());
            // 缓存已有该股票的关键指标则无需再拉（volume / change_pct 任一非空即视为已 hydrated）
            if (found && ((found.volume != null && String(found.volume).trim() !== '') ||
                (found.change_pct != null && String(found.change_pct).trim() !== ''))) {
                return found;
            }
            const sb = getSupabase();
            if (!sb) return null;
            try {
                const { data, error } = await sb.from('market_metrics')
                    .select('stock,code,volume,yest_volume,change_pct,time930,seal_count,auc_pct_chg,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover,source')
                    .eq('date', date)
                    .eq('scope', dataSource)
                    .eq('stock', stockName.trim())
                    .maybeSingle();
                if (error) return null;
                if (!data) return null;
                const mapped = {
                    stock: data.stock,
                    code: data.code || '',
                    volume: data.volume || '',
                    yest_volume: data.yest_volume || '',
                    yestVolume: data.yest_volume || '',
                    change_pct: data.change_pct || '',
                    changePct: data.change_pct || '',
                    auc_pct_chg: data.auc_pct_chg || '',
                    time930: data.time930,
                    seal_count: data.seal_count,
                    um_vol: data.um_vol,
                    open_bid_pct: data.open_bid_pct,
                    auc_vol_ratio: data.auc_vol_ratio,
                    auc_turnover: data.auc_turnover,
                    source: data.source || 'manual'
                };
                if (!cache[date]) cache[date] = [];
                const idx = cache[date].findIndex(r => r.stock && r.stock.trim() === stockName.trim());
                if (idx >= 0) cache[date][idx] = Object.assign({}, cache[date][idx], mapped);
                else cache[date].push(mapped);
                return mapped;
            } catch (e) {
                return null;
            }
        }

