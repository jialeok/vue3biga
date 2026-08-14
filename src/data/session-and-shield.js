import { useAuctionStore } from '../stores/auctionStore.js';
import { state } from '../logic/app-state.js';
let _getStocksDataFn = null;
export function _setGetStocksDataFn(fn) { _getStocksDataFn = fn; }
        // Session Token + Realtime 订阅（互踢 + 云端变更自动同步）
        // ============================================================
        state._sessionToken = null;
        state._realtimeChannel = null;
        state._justPushed = false; // 刚推送完，忽略自己触发的 Realtime 通知
        state._justPushedAuction = false; // 刚推送 auction_watchlist / market_metrics，忽略自己触发的 Realtime 通知
        state._auctionRealtimeChannel = null;
        // ── 阶段二 D 新增：批量并发屏蔽窗口计数器 ─────────────────────────────
        // 旧实现里每个 push 函数各自 _justPushedAuction = true / setTimeout(false, 2000)，
        // 多个批量并发时（比如猫抓 today + yesterday 两批同时跑），先完成那批的 2 秒计时
        // 可能在后完成那批的网络请求还在空中就到点，把屏蔽关掉，导致后完成那批的
        // Realtime 回显被误判为"外部通知"而触发刷新，UI 出现闪烁。
        // 改为计数器：每次开屏蔽 +1，每次关屏蔽 -1，归零时再延后 2 秒清空 boolean。
        // 这样并发批量整体闭合，最后一次关闭的 2 秒内仍能屏蔽所有自身回显。
        state._justPushedAuctionCounter = 0;
        state._justPushedAuctionTimer = null;
        function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }
export function _openAuctionShield() {
            state._justPushedAuctionCounter++;
            state._justPushedAuction = true;
            if (state._justPushedAuctionTimer) {
                clearTimeout(state._justPushedAuctionTimer);
                state._justPushedAuctionTimer = null;
            }
        }
        export function _closeAuctionShield(delayMs) {
            state._justPushedAuctionCounter = Math.max(0, state._justPushedAuctionCounter - 1);
            if (state._justPushedAuctionCounter === 0) {
                if (state._justPushedAuctionTimer) clearTimeout(state._justPushedAuctionTimer);
                state._justPushedAuctionTimer = setTimeout(function() {
                    state._justPushedAuction = false;
                    state._justPushedAuctionTimer = null;
                }, delayMs || 2000);
            }
        }
        // ============================================================
        // Vue 3 响应式 store（早盘竞价看板 Vue 化 Phase 1）
        // ------------------------------------------------------------
        // 设计要点（与《迁移方案》第一步一致）：
        //  - auctionData / hotAuctionData 是响应式代理对象，结构与原
        //    _auctionMemCache / _hotAuctionData 完全一致（按日期独立数组）。
        //  - 紧接着的全局 `let _auctionMemCache` / `let _hotAuctionData`
        //    直接初始化为这两个代理，从而现有内核函数（deriveAuctionTagState、
        //    ensureObservationStocks、ensureBoughtStocksForDate、
        //    fetchLadderConstituentsMain、fetchAuctionFromNumcat 等）的「就地写」
        //    行为天然进入 Vue 响应式轨道，函数逻辑一字不改。
        //  - stocksData 是标签唯一权威源镜像：loadAllData() 构建后同步指向，
        //    改标签只写 _getStocksDataFn()（allData.stocks）。
        //    方案 B：标签不再写入 auctionData 行（bought/sold/fixed 不存储），
        //    渲染时由 deriveAuctionTagState 实时派生。selected 保留为手动点选。
        //  - currentDate / currentGroup / currentPage 等 UI 状态（Phase 5 已迁 useUiStore()，见 src/stores/uiStore.js）
        //    先入 schema，具体字段的「全局变量 ↔ store」双向绑定为后续阶段接入。
        // ============================================================
        // auctionStore 由 stores/auctionStore.js 创建（Vue 响应式）；
        // Pinia 保证 store 始终可用，无需兜底。
        state.__auctionStoreFallback = false;
        // 同步 stocksData 镜像到 store（在 loadAllData() 构建后、以及任何 stocks 写入后调用）
        export function syncStocksDataToStore() {
            const _store = _getAuctionStore();
            if (!_store) return;
            try { _store.stocksData = _getStocksDataFn(); } catch (e) {}
        }
        state._auctionFullRowCache_DELETED = null; // 阶段三 E：已删除，保留占位避免其它处误引用导致 ReferenceError；查询统一改走 _auctionMemCache
        // ── 独立化改造 阶段一 新增 ──────────────────────────────────────────
        // _auctionMemCache：早盘竞价模块级独立内存缓存，做法与 _jiwangMemCache/_biddingMemCache 一致：
        // 不挂在全局 allData 下，不受任何模块触发的 allData=null 重置连坐。
        // 结构 {date: [items]}，与旧 getAuctionData() 返回值结构保持一致，供现有渲染代码平滑过渡。
        // 【阶段三 E 起】_auctionFullRowCache 已退场，本缓存兼任"全量快照"职责：
        //   - 存当天所有行（正式列表成员 in_watchlist=true + 影子记录 in_watchlist=false）
        //   - 趋势图查询直接读全部行（getStockHistoryValue / getAuctionStockHistory）
        //   - tap 主列表渲染时由调用方过滤 in_watchlist===true
        state._auctionMemCache = {}; // 延迟到 _initAuctionMemCache() 中与 store 同步，避免模块初始化时 TDZ
        export function _initAuctionMemCache() {
            const _store = _getAuctionStore();
            if (_store) state._auctionMemCache = _store.auctionData;
        }
        state._dailyHighlightsCache = {}; // {date: Set(stockNames)} 预计算的竞/昨高光
        state._highlightsTableAvailable = false;
        state._highlightsPushTimer = null;
        state._hotHighlightsPushTimer = null; // 热门股票高光推送 debounce timer
        state._highlightsChannel = null; // daily_highlights 表的 Realtime 订阅
        state._stockTopicsChannel = null; // stock_topics 表的 Realtime 订阅
        state._cloudTopicsCache = null; // 从 stock_topics 表加载的题材缓存 {stock: Set(topics)}
        state._scMapChannel = null; // stockcodemap 表的 Realtime 订阅
        state._scMapCache = null; // 从 stockcodemap 表加载的代码映射内存缓存 {stock: code}（唯一真相源=云端 stockcodemap 表）
        state._biddingTableAvailable = false; // bidding_data 表是否可用
        state._biddingRealtimeChannel = null; // bidding_data 表的 Realtime 订阅
        state._marketMetricsRealtimeChannel = null; // market_metrics 表的 Realtime 订阅
        state._justPushedBidding = false; // 刚推送 bidding_data，忽略自己触发的 Realtime 通知
        state._justPushedHighlights = false; // 刚推送 daily_highlights，忽略自己触发的 Realtime 通知（防自循环）
        state._justPushedHotHighlights = false; // 刚推送 hot_stocks_highlights，忽略自己触发的 Realtime 通知（防自循环）

        // jiwang（记忘看板/昨日复盘）持久内存缓存，做法与 _biddingMemCache 一致：
        // 不随 allData=null 重置而清空，只由 pullJiwangFromTable()/本地编辑保存来更新。
        state._jiwangMemCache = null;
