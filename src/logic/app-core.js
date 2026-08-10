import { state } from './app-state.js';
        export function switchGroup(g) {
            if (g !== 'auction' && g !== 'hot') return;
            window.currentGroup = g;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) window.auctionStore.currentGroup = g;

            window._switchGroupUI(g);

            window.auctionCurrentPage = 0;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) window.auctionStore.currentPage = 0;

            window.renderAuction(g);
        }

        // 热门股票渲染：复用 renderAuction 底层逻辑，dataSource='hot'
        export function renderHotStocks() {
            window.renderAuction('hot');
        }



        // ============================================================
        // 一次性数据恢复工具（2026-07-25 新增，2026-07-29 阶段八加固，拆表后改造）：
        // auction_watchlist 表没有 in_watchlist 列，每行天然是正式成员。本函数读取该表，
        // 修复本地 _auctionWatchlistIndex 中"云端在 watchlist 里、但本地索引缺失"的股票。
        // 方案2：不再修改行对象的 in_watchlist 字段，而是把云端 watchlist 名单合并进
        //   _auctionWatchlistIndex[date]（只增不删，影子记录不在这里移除）。
        // 用途：配合按钮"恢复本日数据"手动触发，日期固定为 currentDate（点击那一刻
        // 页面正在看的那一天）。
        // ============================================================
        export async function repairAuctionInWatchlistForDate(dateArg) {
            const date = dateArg || state.currentDate;
            if (!date) { throw new Error('无法确定要恢复的日期'); }

            const sb = window.getSupabase();
            try {
                window._dbgLog('[REPAIR] window.repairAuctionInWatchlistForDate 开始 date=' + date);
                const { data: cloudRows, error: readErr } = await sb.from('auction_watchlist')
                    .select('stock, selected, bought, sold, fixed, obs_auto_added').eq('date', date);
                if (readErr) throw readErr;

                if (!cloudRows || cloudRows.length === 0) {
                    window._dbgLog('[REPAIR] date=' + date + ' 云端 watchlist 无任何记录，无需恢复');
                    throw new Error(date + ' 云端 watchlist 没有任何记录，无法恢复（不是"被隐藏"，而是本来就没有数据）');
                }

                const cloudStocks = new Set((cloudRows || []).map(function(r) { return (r.stock || '').trim(); }));
                window._dbgLog('[REPAIR] date=' + date + ' 云端 watchlist 共' + cloudRows.length + '条：' +
                    Array.from(cloudStocks).join('、'));

                // 方案2：把云端 watchlist 名单合并进本地正式成员索引（只增不删，影子记录保持原样）
                if (!window._auctionWatchlistIndex[date]) window._auctionWatchlistIndex[date] = new Set();
                const localSet = window._auctionWatchlistIndex[date];
                let repairedCount = 0;
                cloudStocks.forEach(function(name) {
                    if (!localSet.has(name)) {
                        localSet.add(name);
                        repairedCount++;
                    }
                });

                window._dbgLog('[REPAIR] date=' + date + ' 恢复完成，云端 watchlist ' + cloudRows.length + '条，修复本地异常' + repairedCount + '条');
                console.log('✅ 已恢复 ' + date + '：云端 watchlist 共 ' + cloudRows.length + ' 条，' + repairedCount + ' 条本地显示异常已修复（影子记录未改动）');

                if (date === state.currentDate) {
                    window.renderAuction();
                    window.renderList();
                }
            } catch (e) {
                window._dbgLog('[REPAIR-ERR] window.repairAuctionInWatchlistForDate date=' + date + ' ' + (e && e.message || e));
                console.error('❌ 恢复失败：' + (e && e.message || e));
            }
        }

        // ============================================================
        // 阶段六 影子bug6 收尾：一次性对账——用 localStorage 旧正式列表纠正云端已提升的影子记录
        // 原因：之前的 sync/push 代码未过滤 in_watchlist，把影子记录（in_watchlist=false）当
        // 正式成员同步到云端（in_watchlist=true），导致回拉后混入第一页。本函数读取 localStorage
        // （迁移前的正式列表快照）作为权威名单，把 _auctionMemCache 中 in_watchlist=true 但不在
        // localStorage 名单里的行降级为 in_watchlist=false，并推送纠正结果到云端。
        // 仅在首次运行时执行一次（用 localStorage 标志位保证不重复执行）。
        // ============================================================
        // ⚠️ 2026-07-25 根因修复：本函数曾把云端 in_watchlist=true 的正式记录
        // 批量"降级"为影子记录（in_watchlist=false）并覆盖推送云端，判断基准是
        // localStorage['stockApp_v42_auction']。但 auction 模块早已改为纯云端表+
        // 内存缓存（见 saveModule/saveData 中 `if (name === 'auction') return;`），
        // 这个 key 从改造那一刻起就不再被写入、永远停留在改造前的旧快照上。
        // 结果：只要这个"一次性对账"跑过一次，之后任何一天新导入的正式列表
        // （不可能出现在那份不会再更新的旧名单里）都会被整批误判为"错误提升的
        // 影子记录"而被打回去，前台按 in_watchlist===true 过滤后自然就消失了。
        // Vue 化之后是响应式的，误伤结果会立刻体现在两个 tab 界面上，问题才被看见。
        // 现在把"降级并推云端"这一步禁用，只保留只读诊断日志：正常情况下命中数应
        // 该永远是 0；如果仍然 >0，说明还有别的写入路径在制造脏的 in_watchlist=true
        // 行，需要顺着日志里的股票名/日期另外定位那条写入路径。
        export async function reconcileAuctionWatchlistFromLocalStorage() {
            const RECONCILE_FLAG = 'stockApp_v42_auction_reconciled_v1';
            try {
                const raw = localStorage.getItem('stockApp_v42_auction');
                if (!raw) {
                    window._dbgLog('[RECONCILE-DEBUG] 跳过：localStorage[stockApp_v42_auction] 无数据（auction 已不再写入此 key，属正常现象）');
                    return { skipped: true, reason: 'localStorage 无数据', disabled: true };
                }
                const parsed = JSON.parse(raw);
                const wouldDemote = [];
                Object.keys(parsed).forEach(function(date) {
                    const lsStocks = new Set((parsed[date] || [])
                        .filter(function(s) { return s && (s.stock || s.name); })
                        .map(function(s) { return (s.stock || s.name).trim(); }));
                    if (lsStocks.size === 0) return;
                    const memRows = window._auctionMemCache[date] || [];
                    const wset = window._getAuctionWatchlistSet(date);
                    memRows.forEach(function(row) {
                        if (row && row.stock && wset.has(row.stock.trim()) && !lsStocks.has(row.stock.trim())) {
                            wouldDemote.push({ date: date, stock: row.stock.trim(), volume: row.volume || '' });
                        }
                    });
                });
                if (wouldDemote.length > 0) {
                    window._dbgLog('[RECONCILE-DEBUG] ⛔ 降级写入已禁用。若未禁用，本次会误将 ' + wouldDemote.length + ' 只正式记录打回影子记录（基准是过期的 localStorage 旧快照，不可信）：' + wouldDemote.map(function(d){ return d.date + ':' + d.stock; }).join(', '));
                    console.warn('[RECONCILE-DEBUG] 降级写入已禁用，命中详情：', wouldDemote);
                } else {
                    window._dbgLog('[RECONCILE-DEBUG] 本次对账无命中（0 只会被误伤），符合预期');
                }
                localStorage.setItem(RECONCILE_FLAG, '1');
                return { skipped: false, demoted: 0, wouldHaveDemoted: wouldDemote.length, detail: wouldDemote, disabled: true };
            } catch (e) {
                console.warn('[RECONCILE-DEBUG] 诊断执行失败:', e.message);
                return { skipped: true, reason: e.message, error: true };
            }
        }
        // 手动触发入口（控制台执行 reconcileAuctionWatchlist() 可重新跑一次诊断，忽略已执行标志）。
        // 注意：即使 force=true，也只会打印"本来会命中哪些股票"，不会再写云端。
        window.reconcileAuctionWatchlist = async function(force) {
            if (force) localStorage.removeItem('stockApp_v42_auction_reconciled_v1');
            return await window.reconcileAuctionWatchlistFromLocalStorage();
        };



        // ════════════════════════════════════════════════════════════════
        // 热门股票独立化改造 新增：字段级增量写入接口（对齐早盘竞价 10474-10571 行）
        // ════════════════════════════════════════════════════════════════
        // 设计原则与早盘竞价 PATCH 架构完全一致：
        //   1. 调用方只传"这次真正要改的字段"，不传的字段既不出现在云端 SET 子句里，
        //      也不覆盖 _hotFullRowCache 里该行的其它字段。
        //   2. 本地写入是"merge 指定字段到已有行"，不是整行替换。
        //   3. 拆表后云端 upsert 冲突键：
        //      - hot_stocks：date,stock
        //      - market_metrics(scope='hot')：date,stock,scope
        //   4. in_watchlist 不在 hot_stocks 表列里，由 syncHotStocksListForDate 通过增删维护。
        // 【独立性要求】以下函数/变量全部为热门股票专用（Hot 命名），与早盘竞价的
        //   patchAuctionFieldBatch / _openAuctionShield 等完全独立、不共用。
        //
        // ⚠️ 字段命名约定（本改造最易出错的点）：
        //   patch 对象一律使用 snake_case（与 hot_stocks 表列名一致）。
        //   hotAuctionData[date] 内存对象用的是驼峰字段（yestVolume/changePct），
        //   调用点构造 patch 时必须显式转换，例如：
        //     patches.push({ stock: s.stock, yest_volume: s.yestVolume });  // ✅
        //     patches.push({ stock: s.stock, yestVolume: s.yestVolume });   // ❌ 会被白名单过滤，静默丢失

        // ── 计数器式屏蔽窗口（对齐早盘竞价 _openAuctionShield/_closeAuctionShield）──
        export function _openHotAuctionShield() {
            window._justPushedHotAuctionCounter++;
            window._justPushedHotAuction = true;
            if (window._justPushedHotAuctionTimer) {
                clearTimeout(window._justPushedHotAuctionTimer);
                window._justPushedHotAuctionTimer = null;
            }
        }
        export function _closeHotAuctionShield(delayMs) {
            window._justPushedHotAuctionCounter = Math.max(0, window._justPushedHotAuctionCounter - 1);
            if (window._justPushedHotAuctionCounter === 0) {
                if (window._justPushedHotAuctionTimer) clearTimeout(window._justPushedHotAuctionTimer);
                window._justPushedHotAuctionTimer = setTimeout(function() {
                    window._justPushedHotAuction = false;
                    window._justPushedHotAuctionTimer = null;
                }, delayMs || 2000);
            }
        }

        // 拆表后字段归属：
        //   hot_stocks：note, topics, selected, bought, sold, fixed, code
        //   market_metrics(scope='hot')：volume, yest_volume, change_pct, code
        // 公共字段 code 同时写入两张表。
        const HOT_WATCHLIST_FIELDS = ['note', 'topics', 'selected', 'bought', 'sold', 'fixed', 'code'];
        const HOT_METRICS_FIELDS = ['volume', 'yest_volume', 'change_pct', 'code'];
        const HOT_PATCHABLE_FIELDS = HOT_WATCHLIST_FIELDS.concat(HOT_METRICS_FIELDS.filter(function(f) { return HOT_WATCHLIST_FIELDS.indexOf(f) < 0; }));

        export function _sanitizeHotPatch(patch) {
            return window._sanitizePatch(patch, HOT_PATCHABLE_FIELDS);
        }

        export function _splitHotPatch(cleanPatch) {
            return window._splitPatch(cleanPatch, HOT_WATCHLIST_FIELDS, HOT_METRICS_FIELDS);
        }

        // 只把 patch 里出现的字段 merge 进 _hotFullRowCache 对应行；不存在则新建
        // 方案2：新建行不设 in_watchlist，正式/影子身份由 _hotWatchlistIndex 独立判断
        export function _mergeHotPatchLocal(date, stock, cleanPatch) {
            return window._mergePatchLocal(date, stock, cleanPatch, window._hotFullRowCache, function(d) { window._hotFullRowCache[d] = []; });
        }

        // 单条字段级写入的语法糖
        export async function patchHotField(date, stock, patch) {
            return window._patchScopeField(date, stock, patch, window.patchHotFieldBatch);
        }

        // 核心函数：批量字段级 upsert，按字段归属拆分到 hot_stocks / market_metrics(scope='hot')。
        export async function patchHotFieldBatch(date, items) {
            if (!date || !Array.isArray(items) || items.length === 0) return { ok: true, rows: 0 };
            window._openHotAuctionShield();
            try {
                const now = new Date().toISOString();
                const watchlistRows = [];
                const metricsRows = [];
                const localOps = [];

                // 方案2：用 _hotWatchlistIndex 独立 Set 判断正式成员，不依赖行对象上的 in_watchlist 字段
                const watchlistSet = window._hotWatchlistIndex[date] || new Set();
                function isWatchlistStock(nameTrim) {
                    return watchlistSet.has(nameTrim);
                }
                window.isWatchlistStock = isWatchlistStock;

                items.forEach(function(item) {
                    if (!item || !item.stock) return;
                    const nameTrim = item.stock.trim();
                    if (!nameTrim) return;
                    const cleanPatch = window._sanitizeHotPatch(item);
                    if (Object.keys(cleanPatch).length === 0) return;
                    const split = window._splitHotPatch(cleanPatch);

                    // 只有正式成员才写hot_stocks表；影子记录只写market_metrics
                    const isInWatchlist = window.isWatchlistStock(nameTrim);
                    if (isInWatchlist && Object.keys(split.watchlistPatch).length > 0) {
                        watchlistRows.push(Object.assign(
                            { date: date, stock: nameTrim, updated_at: now, updated_by: 'main' },
                            split.watchlistPatch
                        ));
                    }
                    // market_metrics所有股票都写（正式成员+影子记录），确保行情数据持久化
                    if (Object.keys(split.metricsPatch).length > 0) {
                        metricsRows.push(Object.assign(
                            { date: date, stock: nameTrim, scope: 'hot', updated_at: now, updated_by: 'main' },
                            split.metricsPatch
                        ));
                    }
                    localOps.push({ stock: nameTrim, cleanPatch: cleanPatch, isInWatchlist: isInWatchlist });
                });
                if (watchlistRows.length === 0 && metricsRows.length === 0) return { ok: true, rows: 0 };

                // 本地缓存先更新（趋势图/当前页立即可读）
                // 注意：热门股票tab的影子记录由buildYesterdayListFromToday创建新对象，
                // fillVolume修改的是这些临时对象，只有_mergeHotPatchLocal能把它们写入_hotFullRowCache。
                // 这和早盘竞价tab不同（早盘竞价fillVolume直接修改_auctionMemCache引用），
                // 所以本地merge必须在网络请求前同步执行，否则趋势图立即渲染时读不到影子数据。
                localOps.forEach(function(op) {
                    window._mergeHotPatchLocal(date, op.stock, op.cleanPatch);
                });

                // [DEBUG] 记录进入云端同步前的表就绪状态，帮助定位"刷新后消失"问题
                window._dbgLog('[PATCH-HOT] date=' + date + ' 待写入 metrics=' + metricsRows.length +
                    ' watchlist=' + watchlistRows.length +
                    ' window._hotAuctionTableAvailable=' + window._hotAuctionTableAvailable +
                    ' window._marketMetricsTableAvailable=' + window._marketMetricsTableAvailable +
                    ' 样本=' + (metricsRows[0] && metricsRows[0].stock || 'N/A'));

                // 云端同步：等待表就绪最多 5 秒
                if (!window._hotAuctionTableAvailable && !window._marketMetricsTableAvailable) {
                    const waitStart = Date.now();
                    while (!window._hotAuctionTableAvailable && !window._marketMetricsTableAvailable && Date.now() - waitStart < 5000) {
                        await new Promise(function(r) { setTimeout(r, 100); });
                    }
                    if (!window._hotAuctionTableAvailable && !window._marketMetricsTableAvailable) {
                        // [BUG-FIX] 原 ok:true 会让调用方误以为云端写入成功，导致 UI 显示绿勾。
                        // 实际云端未写入，刷新后数据会丢失。改为 ok:false，让调用方走错误分支提示用户重试。
                        console.warn('window.patchHotFieldBatch：hot_stocks 与 market_metrics 表均未就绪，本地缓存已更新但云端未同步。日期:', date);
                        return { ok: false, rows: localOps.length, cloudSkipped: true, error: new Error('云端表未就绪，数据未上传（已暂存本地）') };
                    }
                }

                const sb = window.getSupabase();
                if (window._hotAuctionTableAvailable && watchlistRows.length > 0) {
                    const { error } = await sb.from('hot_stocks')
                        .upsert(watchlistRows, { onConflict: 'date,stock' });
                    if (error) throw error;
                }
                // [BUG-FIX] 即使 _marketMetricsTableAvailable 标记尚未就绪，也直接尝试写入：
                // 初始化完成前该标记可能为 false，导致历史断点补全等按钮的数据只进本地缓存、
                // 不进云端，刷新后丢失。直接尝试写入，失败时再根据错误类型更新标记。
                if (metricsRows.length > 0) {
                    const { error } = await sb.from('market_metrics')
                        .upsert(metricsRows, { onConflict: 'date,stock,scope' });
                    if (error) {
                        if (error.message && error.message.indexOf('relation') >= 0) {
                            window._marketMetricsTableAvailable = false;
                        }
                        throw error;
                    }
                    window._marketMetricsTableAvailable = true;
                    window._dbgLog('[PATCH-HOT] market_metrics 写入成功 date=' + date + ' rows=' + metricsRows.length);
                }

                return { ok: true, rows: localOps.length };
            } catch (e) {
                console.warn('window.patchHotFieldBatch 失败(本地缓存已更新，仅云端未同步):', date, e && e.message);
                return { ok: false, error: e };
            } finally {
                window._closeHotAuctionShield(2000);
            }
        }
        // 设计原则（对齐大厂标准思路：PATCH 而非 PUT，服务端字段级合并而非客户端整段覆盖）：
        //   1. 调用方只传"这次真正要改的字段"，不传的字段既不出现在云端 SQL 的 SET 子句里，
        //      也不覆盖 _auctionMemCache 里该行的其它字段。
        //   2. 本地写入是"merge 指定字段到已有行"，不是"整行/整个数组替换"——
        //      这是根治"旧快照覆盖新数据"竞态的关键。
        //   3. 拆表后云端 upsert 的冲突键：
        //      - auction_watchlist：date,stock
        //      - market_metrics：date,stock,scope
        //   4. in_watchlist 字段不属于这两个函数的管辖范围——它由"该股票是否在当前正式列表"
        //      这一业务规则决定，写入逻辑保留在 syncAuctionListForDate 等现有函数里，
        //      不要通过 patch 参数传入 in_watchlist，也不要在这两个函数内部推断它。
        //
        // 拆表后字段归属：
        //   auction_watchlist：note, topics, source, obs_auto_added, selected, bought, sold, fixed, code
        //   market_metrics(scope='auction')：volume, yest_volume, change_pct, time930, seal_count, code
        // 公共字段 code 同时写入两张表。
        const AUCTION_WATCHLIST_FIELDS = ['note', 'topics', 'source', 'obs_auto_added', 'selected', 'bought', 'sold', 'fixed', 'code'];
        const AUCTION_METRICS_FIELDS = ['volume', 'yest_volume', 'change_pct', 'time930', 'seal_count', 'code'];
        const AUCTION_PATCHABLE_FIELDS = AUCTION_WATCHLIST_FIELDS.concat(AUCTION_METRICS_FIELDS.filter(function(f) { return AUCTION_WATCHLIST_FIELDS.indexOf(f) < 0; }));

        // 从调用方传入的 patch 对象中，只挑出白名单内、且确实存在（!== undefined）的字段。
        // 之所以要求"确实存在"而不是"值为真"，是因为 false/''/0 都是合法的业务值
        // （比如 selected: false 也是一次有意义的字段更新，不能被过滤掉）。
        export function _sanitizeAuctionPatch(patch) {
            return window._sanitizePatch(patch, AUCTION_PATCHABLE_FIELDS);
        }

        // 把 clean patch 拆成两张表各自的 patch。
        export function _splitAuctionPatch(cleanPatch) {
            return window._splitPatch(cleanPatch, AUCTION_WATCHLIST_FIELDS, AUCTION_METRICS_FIELDS);
        }

        // 本地 merge：只把 clean patch 里出现的字段写进 _auctionMemCache 对应行，
        // 不存在的行则新建（方案2：新建行不携带 in_watchlist 字段，正式/影子身份由
        // _auctionWatchlistIndex 独立判断；"新建"只可能发生在单字段补数据场景——
        // 正式列表成员的创建/移除仍由 syncAuctionListForDate 负责）。
        // 不做整个数组替换、不做整个对象替换，只动被点名的字段。
        export function _mergeAuctionPatchLocal(date, stock, cleanPatch) {
            return window._mergePatchLocal(date, stock, cleanPatch, window._auctionMemCache, function(d) { window.setAuctionDateData(d, [], 'window.patchAuctionFieldBatch-init'); });
        }

        // 单条字段级写入：只上报/只覆盖 patch 里出现的字段。
        // date: 'YYYY-MM-DD'；stock: 股票名；patch: 形如 {volume: 'xxx'} 或 {yest_volume: 'xxx'}
        // 返回 {ok: true} 或 {ok: false, error}，调用方按需处理失败（沿用现有代码里
        // "推送失败仅 console.warn、不阻断主流程"的一贯风格，不在此函数内部强行抛出阻断 UI）。
        export async function patchAuctionField(date, stock, patch) {
            return window._patchScopeField(date, stock, patch, window.patchAuctionFieldBatch);
        }

        // 批量字段级写入：一次 upsert 多行，但每行仍然只写调用方指定的那几个字段，
        // 不会因为"批量"就退化回整行覆盖。用于猫抓/同花顺一次处理几十只股票的场景，
        // 避免拆成 N 次网络请求；_justPushedAuction 屏蔽窗口按"这一次批量调用"整体开合
        // （不是每行各开一个），避免批量过程中窗口提前过期、被自身触发的 Realtime 打断。
        //
        // items: [{stock, ...patch}, ...]，每个 item 里除 stock 外的其余字段会各自
        //   经过白名单过滤，并按字段归属分别写入 auction_watchlist / market_metrics(scope='auction')。
        //   不同 item 允许携带不同的字段组合（比如同一批里有的行只改 volume、有的行只改 note，互不影响）。
        // 方案2：用 _auctionWatchlistIndex 判断正式成员——只有正式成员的 watchlistPatch 才写 auction_watchlist；
        //   影子记录的 watchlistPatch 字段被跳过（auction_watchlist 没有对应行，写了会凭空创建正式成员）。
        //   所有股票（正式+影子）的 metricsPatch 都写 market_metrics，确保行情数据持久化。
        export async function patchAuctionFieldBatch(date, items) {
            if (!date || !Array.isArray(items) || items.length === 0) return { ok: true, rows: 0 };
            window._openAuctionShield();
            try {
                const now = new Date().toISOString();
                const watchlistRows = [];
                const metricsRows = [];
                const localOps = [];
                // 方案2：用 _auctionWatchlistIndex 独立 Set 判断正式成员，不依赖行对象上的 in_watchlist 字段
                const watchlistSet = window._getAuctionWatchlistSet(date);
                function isWatchlistStock(nameTrim) {
                    return watchlistSet.has(nameTrim);
                }
                window.isWatchlistStock = isWatchlistStock;
                items.forEach(function(item) {
                    if (!item || !item.stock) return;
                    const nameTrim = item.stock.trim();
                    if (!nameTrim) return;
                    const cleanPatch = window._sanitizeAuctionPatch(item);
                    if (Object.keys(cleanPatch).length === 0) return; // 没有合法字段可写，跳过
                    const split = window._splitAuctionPatch(cleanPatch);
                    const isInWatchlist = window.isWatchlistStock(nameTrim);
                    // 只有正式成员才写 auction_watchlist；影子记录跳过 watchlistPatch（避免凭空创建正式成员）
                    if (isInWatchlist && Object.keys(split.watchlistPatch).length > 0) {
                        watchlistRows.push(Object.assign(
                            { date: date, stock: nameTrim, updated_at: now, updated_by: 'main' },
                            split.watchlistPatch
                        ));
                    }
                    // market_metrics：所有股票都写（正式成员+影子记录），确保行情数据持久化
                    if (Object.keys(split.metricsPatch).length > 0) {
                        metricsRows.push(Object.assign(
                            { date: date, stock: nameTrim, scope: 'auction', updated_at: now, updated_by: 'main' },
                            split.metricsPatch
                        ));
                    }
                    localOps.push({ stock: nameTrim, cleanPatch: cleanPatch });
                });
                if (watchlistRows.length === 0 && metricsRows.length === 0) return { ok: true, rows: 0 };

                if (window._auctionTableAvailable && watchlistRows.length > 0) {
                    const sb = window.getSupabase();
                    const { error } = await sb.from('auction_watchlist')
                        .upsert(watchlistRows, { onConflict: 'date,stock' });
                    if (error) throw error;
                }
                if (window._marketMetricsTableAvailable && metricsRows.length > 0) {
                    const sb = window.getSupabase();
                    const { error } = await sb.from('market_metrics')
                        .upsert(metricsRows, { onConflict: 'date,stock,scope' });
                    if (error) throw error;
                }

                // 云端成功后再做本地 merge，避免云端失败时本地和云端出现"本地领先云端"的假象
                localOps.forEach(function(op) {
                    window._mergeAuctionPatchLocal(date, op.stock, op.cleanPatch);
                });

                return { ok: true, rows: localOps.length };
            } catch (e) {
                window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch ' + (e && e.message));
                return { ok: false, error: e };
            } finally {
                window._closeAuctionShield(2000);
            }
        }
        // ════════════════════════════════════════════════════════════════
        // 阶段一新增结束
        // ════════════════════════════════════════════════════════════════




        // 一次性迁移：将本地 allData.auction 按 in_watchlist 拆到 auction_watchlist 与 market_metrics(scope='auction')。
        // 拆表后：in_watchlist===true 的行进入 auction_watchlist；in_watchlist!==true 的行进入 market_metrics(scope='auction')。
        export async function migrateAuctionToTable() {
            if (localStorage.getItem('_auction_table_migrated') === '1') {
                window._auctionTableAvailable = true; // 已迁移过，标记表可用
                window._marketMetricsTableAvailable = true;
                return;
            }
            const auctionData = window.getAuctionData();
            const dates = Object.keys(auctionData).filter(function(d) {
                return Array.isArray(auctionData[d]) && auctionData[d].length > 0;
            });
            if (dates.length === 0) {
                // 本地无数据，检查新表是否可用（尝试读一行）
                try {
                    const sb = window.getSupabase();
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
                        window._auctionTableAvailable = watchlistOk;
                        window._marketMetricsTableAvailable = metricsOk;
                        localStorage.setItem('_auction_table_migrated', '1');
                        console.log('[迁移] 本地无 auction 数据，auction_watchlist/market_metrics 表已就绪');
                    }
                } catch(e) { console.warn('[迁移] 表不可用:', e.message); }
                return;
            }
            const sb = window.getSupabase();
            const scMap = window._scMapCache || {};
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
                window._auctionTableAvailable = true;
                window._marketMetricsTableAvailable = true;
                localStorage.setItem('_auction_table_migrated', '1');
                console.log('[迁移] auction_watchlist 已灌入 ' + watchlistRows + ' 条，market_metrics(scope=auction) 已灌入 ' + metricsRows + ' 条');
            } else {
                console.warn('[迁移] 迁移失败，auction 表标记为不可用，保留本地数据');
            }
        }

        // 一次性迁移：从旧 auction_data 表读取全部数据，按 in_watchlist 拆到
        // auction_watchlist 与 market_metrics(scope='auction')，并在 localStorage 标记已迁移。
        export async function migrateAuctionDataToNewTables() {
            const sb = window.getSupabase();
            const alreadyMigrated = localStorage.getItem('_auction_data_migrated_to_new_tables') === '1';

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
                window._auctionTableAvailable = true;
                window._marketMetricsTableAvailable = true;
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
                            localStorage.setItem('_auction_data_migrated_to_new_tables', '1');
                            window._auctionTableAvailable = true;
                            window._marketMetricsTableAvailable = true;
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
                    localStorage.setItem('_auction_data_migrated_to_new_tables', '1');
                    window._auctionTableAvailable = true;
                    window._marketMetricsTableAvailable = true;
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
                window._auctionTableAvailable = true;
                window._marketMetricsTableAvailable = true;
                localStorage.setItem('_auction_data_migrated_to_new_tables', '1');
                console.log('[迁移] 旧 auction_data 已拆分：auction_watchlist ' + watchlistBatch.length + ' 条，market_metrics(scope=auction) ' + metricsBatch.length + ' 条');
            } catch (e) {
                console.warn('[迁移] 旧 auction_data 拆分失败:', e.message);
            }
        }


        // 手动拉取云端数据（点击云朵图标触发）
        export async function manualPullCloud() {
            window.updateCloudSyncUI('syncing');
            try {
                await window.pullFromCloud();
                window.allData = null; window.loadAllData();
                window.renderList(); window.renderJiwang(); window.renderRank(); window.renderAuction();
                window.renderMulti(); window.renderHotspot(); window.renderPattern(); window.renderBidding();
                window.renderDuiban();
                window.renderEmotionBoard();
                if (typeof window.renderEtf === 'function') window.renderEtf();
                window.updateCloudSyncUI('synced');
            // 预加载云端题材库（非阻塞，完成后重建缓存并刷新第二页）
            window.loadCloudTopics().then(function() { window.invalidateTopicCache(); window.buildTopicCache(); window.renderAuction(); }).catch(function() {});
            // 重新加载云端股票代码映射
            window.loadCloudStockCodeMap().then(function() { if (typeof window.renderAuction === 'function') window.renderAuction(); }).catch(function() {});
            } catch (e) {
                window._dbgLog('[AUCTION-ERR] window.manualPullCloud ' + (e && e.message || e));
                window.updateCloudSyncUI('offline');
            }
        }

        // ============================================================
        // 云端数据推送（防抖，操作停止 2 秒后触发）
        // ============================================================
        export function scheduleCloudPush() {
            clearTimeout(window._pushDebounceTimer);
            window._pushDebounceTimer = setTimeout(window.pushToCloud, 2000);
            window.updateCloudSyncUI('syncing');
        }

        // 记录"确实发生过增删股票操作"的 auction 日期。
        // 只有被标记过的日期，在 pushToCloud 合并云端数据时才允许用本地名单覆盖云端，
        // 避免仅仅因为翻看某个历史日期（currentDate 指向它）就被误判为"允许增删"。
        if (!window._auctionDirtyDates) window._auctionDirtyDates = new Set();
        export function markAuctionDirty(date) {
            if (date) window._auctionDirtyDates.add(date);
        }

        // 记录"jiwang 数据确实被改动过"的日期，saveData() 据此判断是否需要
        // 推送该日期到 jiwang_data 表，避免每次 saveData()（可能因为改股票、改题材等
        // 与 jiwang 无关的操作触发）都无谓地 upsert 一次 jiwang_data。
        if (!window._jiwangDirtyDates) window._jiwangDirtyDates = new Set();
        export function markJiwangDirty(date) {
            if (date) window._jiwangDirtyDates.add(date);
        }

        // ============================================================
        // 集中写入守卫 API（harden-auction-date-isolation）
        // 所有对 _auctionMemCache[date] 的写入/删除/整段替换/合并一律走这里。
        // 统一记录 [AUCTION-GUARD] 日志（targetDate、before/after 行数、source、调用栈前5帧），
        // 校验 date 非空，对单日 source 断言 date === auctionStore.currentDate（不一致只警告不阻断）。
        // ============================================================
        export function _guardStack() {
            try { return ' stack=' + (new Error().stack || '').split('\n').slice(2, 7).join(' <- '); }
            catch (e) { return ''; }
        }
        export function _guardAssertDate(date, source) {
            try {
                if (!window.auctionStore) return;
                if (date === window.auctionStore.currentDate) return;
                var OK = ['window.pullAuctionFromTable','window.clearAllAuctionDates','restore','window.handleFileImport','window.importAuctionHistoryFill'];
                if (OK.indexOf(source) >= 0) {
                    window._dbgLog('[AUCTION-GUARD] cross-date-ok date=' + date + ' source=' + source);
                    return;
                }
                window._dbgLog('[AUCTION-GUARD] ⚠️ date=' + date + ' ≠ window.auctionStore.currentDate=' + window.auctionStore.currentDate + ' source=' + source);
            } catch(e){}
        }
        var _auctionFirstClearDumped = false;
        export function _dumpAuctionSnapshot(label) {
            try {
                var keys = Object.keys(window._auctionMemCache).sort();
                var parts = keys.map(function(d) {
                    var arr = window._auctionMemCache[d] || [];
                    // 方案2：用 _auctionWatchlistIndex 判断正式成员数量
                    var wset = window._auctionWatchlistIndex[d] || new Set();
                    var formal = arr.filter(function(s) { return s && s.stock && wset.has(s.stock.trim()); }).length;
                    return d + ':' + formal + '/' + arr.length;
                });
                window._dbgLog('[AUCTION-GUARD] snapshot ' + label + ' dates=' + keys.length + ' | ' + parts.join(', '));
            } catch (e) {}
        }
        const setAuctionDateData = window.setAuctionDateData;
        export function clearAuctionDateData(date, source) {
            if (!date || typeof date !== 'string') { window._dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
            if (!_auctionFirstClearDumped) { window._dumpAuctionSnapshot('before-first-clear'); }
            var before = (window._auctionMemCache[date] || []).length;
            window._auctionMemCache[date] = [];
            // 方案2：清空该日期的正式成员索引
            window._auctionWatchlistIndex[date] = new Set();
            window._dbgLog('[AUCTION-GUARD] clear date=' + date + ' before=' + before + ' after=0 source=' + source + window._guardStack());
            if (window.auctionStore && date !== window.auctionStore.currentDate) {
                try { window._dbgLog('[AUCTION-GUARD] sample-clear date=' + date + ' source=' + source); } catch(e){}
            }
            window._guardAssertDate(date, source);
            if (!_auctionFirstClearDumped) { _auctionFirstClearDumped = true; window._dumpAuctionSnapshot('after-first-clear'); }
        }
        export function deleteAuctionDateData(date, source) {
            if (!date || typeof date !== 'string') { window._dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
            var before = (window._auctionMemCache[date] || []).length;
            delete window._auctionMemCache[date];
            // 方案2：删除该日期的正式成员索引
            delete window._auctionWatchlistIndex[date];
            window._dbgLog('[AUCTION-GUARD] delete date=' + date + ' before=' + before + ' after=0 source=' + source + window._guardStack());
            window._guardAssertDate(date, source);
        }
        export function mergeAuctionDateRows(date, rows, source) {
            if (!date || typeof date !== 'string') { window._dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
            if (!window._auctionMemCache[date]) window._auctionMemCache[date] = [];
            var before = window._auctionMemCache[date].length;
            var list = window._auctionMemCache[date];
            // 方案2：行对象不再携带 in_watchlist，merge 时直接写入行数据；
            // 调用方若需要把这些行标记为正式成员，应另外调用 _addAuctionWatchlistMember / _setAuctionWatchlistForDate。
            (rows || []).forEach(function(row) {
                if (!row || !row.stock) return;
                var idx = list.findIndex(function(r) { return r && r.stock === row.stock; });
                if (idx >= 0) list[idx] = row; else list.push(row);
            });
            var after = list.length;
            window._dbgLog('[AUCTION-GUARD] merge date=' + date + ' before=' + before + ' after=' + after + ' source=' + source + window._guardStack());
            if (window.auctionStore && date !== window.auctionStore.currentDate) {
                try { window._dbgLog('[AUCTION-GUARD] sample date=' + date + ' source=' + source + ' stocks=' + (rows||[]).slice(0,3).map(function(r){return r&&r.stock||'?';}).join(',')); } catch(e){}
            }
            window._guardAssertDate(date, source);
        }
        export function clearAllAuctionDates(source) {
            var dates = Object.keys(window._auctionMemCache);
            window._dbgLog('[AUCTION-GUARD] ⚠️ clearAll dates=' + dates.length + ' source=' + source + window._guardStack());
            dates.forEach(function(d) { delete window._auctionMemCache[d]; });
            // 方案2：清空所有日期的正式成员索引
            window._auctionWatchlistIndex = {};
        }



        // ============================================================
        // 应用初始化入口（密码验证成功后调用）
        // ============================================================
        // 计算北京时间"今天"（按 UTC+8，不受浏览器本地时区影响）
        function _computeBeijingToday() {
            const now = new Date();
            const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
            const bj = new Date(utcMs + 8 * 3600000);
            const y = bj.getFullYear();
            const m = String(bj.getMonth() + 1).padStart(2, '0');
            const d = String(bj.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        // 暴露给其它模块（如 app-init.js 的 _appInit）复用，避免重复实现
        window._computeBeijingToday = _computeBeijingToday;

        export function initApp() {
            // [ISSUE#1 修复] 启动默认落到"今天"：pullFromCloud 可能更新过 currentDate，
            // 这里重新读取 localStorage，但只有"恰为今天"才沿用，否则一律以北京时间为准
            // 重置为今天，避免打开后停在 8/5 等旧日期、并向前串数据（"未来的日期也继承 8/5"）。
            const _bt = _computeBeijingToday();
            const savedDate = localStorage.getItem('lastEditedDate_' + state.DATA_VERSION);
            if (savedDate && savedDate === _bt) {
                window.setCurrentDate(savedDate);
            } else {
                window.setCurrentDate(_bt);
            }
            // 触发原有的 DOMContentLoaded 逻辑（已绑定在页面底部）
            window._appInit();
        }

        window.DATA_VERSION = 'v42';
        const MODULE_KEYS = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];

        // 一次性清理：早期测试阶段遗留的陈旧 lastEditedDate（如 2025-01-02）会导致
        // 应用一直卡在那个日期。这里清除"去年今日"之前的值，让它退回默认走"今天"。
        // 只做一次判断、直接清除 key，不做动态阈值计算（之前的动态阈值方案因为在
        // initApp()/_appInit() 等多处各自独立读取同一个 key，顺序上互相覆盖，没有真正生效）。
        (function _cleanupStaleLastEditedDate() {
            const v = localStorage.getItem('lastEditedDate_' + state.DATA_VERSION);
            const _minValidDate = (new Date().getFullYear() - 1) + '-01-01';
            if (v && v < _minValidDate) {
                localStorage.removeItem('lastEditedDate_' + state.DATA_VERSION);
            }
        })();

        // [ISSUE#1 修复] 启动默认落到"今天"：若持久化的 lastEditedDate 早于今天
        // （或无效/在未来），一律以北京时间为准重置为今天，避免打开后停在 8/5 等
        // 旧日期、并向前串数据（"未来的日期也继承 8/5"的根因就是 currentDate 卡在旧日期）。
        const _beijingToday = _computeBeijingToday();
        window.currentDate = localStorage.getItem('lastEditedDate_' + state.DATA_VERSION);
        const _dateValid = state.currentDate && /^\d{4}-\d{2}-\d{2}$/.test(state.currentDate) && state.currentDate >= '2025-01-01';
        if (!_dateValid || state.currentDate !== _beijingToday) {
            setCurrentDate(_beijingToday);
        }
        // 统一日期写入口：同时更新全局 currentDate 与响应式 auctionStore.currentDate，
        // 杜绝"全局已切、store 未跟"导致的跨日期写错位（fetchLadderConstituentsMain 等以
        // auctionStore.currentDate 为 targetDate，store 滞后会把今天的数据写到旧日期）。
        // 不在此处做 localStorage 持久化——persist 仍由 _persistCurrentDateAsLastEdited 负责，
        // 以保留 jumpFromPage3ToPage2 等"仅切内存不 persist"的语义。
        export function setCurrentDate(newDate) {
            // [DATE-SWITCH] 记录所有日期切换入口，便于排查跨日期写/渲染串数据问题
            if (typeof window._dbgLog === 'function') {
                const stack = (new Error().stack || '').split('\n').slice(2, 5).join(' <- ');
                window._dbgLog('[DATE-SWITCH] 切换到 ' + newDate + ' | 来源: ' + stack);
            }
            state.currentDate = newDate;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) {
                window.auctionStore.currentDate = newDate;
            }
            // [DATE-SWITCH] 切换日期时重置展开状态，避免上一日期的展开/全部展开开关带到新日期
            if (typeof window.resetExpansionStateOnDateSwitch === 'function') {
                window.resetExpansionStateOnDateSwitch();
            }
        }
        export function getCurrentDate() { return state.currentDate; }
        if (typeof window._dbgLog === 'function') {
            window._dbgLog('页面脚本加载: currentDate 初始化为 ' + state.currentDate + ' | 代码版本 v3-0804-RANKCACHE-FIX（找到真正瓶颈：getRankData每题材调用N次→改为每次渲染只调用1次，避免反复触发响应式store写入）');
            window._dbgLog('[AUCTION-GUARD] selfCheck active=true refIdentity=' + (window._auctionMemCache === (typeof window.auctionStore !== 'undefined' && window.auctionStore ? window.auctionStore.auctionData : null)) + ' dates=' + Object.keys(window._auctionMemCache || {}).length);
        }

        window.isStrengthSortEnabled = false;

        const _moduleKey = window._moduleKey;

        export function _migrateFromV41() {
            const oldData = localStorage.getItem('stockAppData_v41');
            if (!oldData) return false;
            try {
                const parsed = JSON.parse(oldData);
                MODULE_KEYS.forEach(key => {
                    const val = parsed[key];
                    if (val !== undefined) {
                        localStorage.setItem(window._moduleKey(key), JSON.stringify((key === 'holidays' || key === 'tradingDays') ? (val || []) : (val || {})));
                    }
                });
                localStorage.setItem(window._moduleKey('_migrated'), '1');
                localStorage.removeItem('stockAppData_v41');
                return true;
            } catch (e) {
                return false;
            }
        }

        const normalizeAuctionNotes = window.normalizeAuctionNotes;
        const getStocksData = window.getStocksData;
        const getJiwangData = window.getJiwangData;
        const getBiddingData = window.getBiddingData;
        export function getRankData() { return window._rankMemCache || window.loadAllData().rank; }
        export function getMultiData() { return window._multiMemCache || window.loadAllData().multi; }
        export function getHotspotData() { return window._hotspotMemCache || window.loadAllData().hotspot; }
        export function getPatternData() { return window._patternMemCache || window.loadAllData().pattern; }
        export function getTagTitlesData() { return window._tagTitlesMemCache || window.loadAllData().tagTitles; }
        
        window.currentFilter = 'all';
        window.isStockListCollapsed = false; // 股票列表收起状态
        window.editingId = null;
        window.topicAutoFilled = false;

        // 判断是否为休市日
        export function isMarketClosed(d) {
            return !window.isTradingDay(d);
        }

        // 获取下一个交易日
        export function getNextTradingDay(dateStr) {
            let date = new Date(dateStr);
            date.setDate(date.getDate() + 1);
            
            while (window.isMarketClosed(date.toISOString().split('T')[0])) {
                date.setDate(date.getDate() + 1);
            }
            
            return date.toISOString().split('T')[0];
        }

        // 获取星期几
        export function getWeekday(d) {
            return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(d).getDay()];
        }


        // 备份早盘竞价数据（用于撤回）
        // type: 'import' 导入时备份, 'save' 保存时备份
        // 备份早盘竞价数据（用于撤回）
        // 只备份"这次操作实际改动的那一天"，不再备份最近30天范围。
        // 这样撤回时只会精准恢复这一天，彻底不会影响其它任何日期的历史数据。
        // date 参数：这次操作影响的具体日期，不传则默认当天（currentDate）
        export function backupAuctionData(type, date) {
            return window._backupScopeData({
                type: type, date: date,
                getDataFn: window.getAuctionData,
                backupKeyPrefix: 'auctionData',
                watchlistIndex: window._auctionWatchlistIndex,
                label: '竞价'
            });
        }

        // 撤回早盘竞价数据
        // 只精准恢复被备份的那一天，不碰其它任何日期
        export function rollbackAuctionData() {
            const importDataStr = localStorage.getItem('auctionData_import_backup');
            const importTime = localStorage.getItem('auctionData_import_backup_time');
            const saveDataStr = localStorage.getItem('auctionData_save_backup');
            const saveTime = localStorage.getItem('auctionData_save_backup_time');

            // 选时间戳更新的那份备份（均无则报错）
            let backupDataStr = null;
            let backupTime = null;
            let backupType = '';

            if (importDataStr && saveDataStr) {
                // 两份都有，选较新的
                if (importTime && saveTime && new Date(importTime) >= new Date(saveTime)) {
                    backupDataStr = importDataStr;
                    backupTime = importTime;
                    backupType = '导入';
                } else {
                    backupDataStr = saveDataStr;
                    backupTime = saveTime;
                    backupType = '保存';
                }
            } else if (importDataStr) {
                backupDataStr = importDataStr;
                backupTime = importTime;
                backupType = '导入';
            } else if (saveDataStr) {
                backupDataStr = saveDataStr;
                backupTime = saveTime;
                backupType = '保存';
            }

            if (!backupDataStr) {
                throw new Error('没有可撤回的早盘竞价数据');
            }

            let backupPayload;
            try {
                backupPayload = JSON.parse(backupDataStr);
            } catch (e) {
                throw new Error('备份数据已损坏，无法撤回');
            }

            // 兼容旧版本备份格式（曾经是"最近30天"的整体对象，没有 date/data 结构）。
            // 旧格式一旦被恢复会牵连其它日期，为安全起见直接拒绝撤回并清除，而不是尝试恢复。
            if (!backupPayload || typeof backupPayload !== 'object' || !('date' in backupPayload)) {
                throw new Error('检测到旧版本的撤回备份（可能影响多天数据），为避免误覆盖历史数据，已自动清除，无法撤回。请重新操作后再试。');
                localStorage.removeItem('auctionData_import_backup');
                localStorage.removeItem('auctionData_import_backup_time');
                localStorage.removeItem('auctionData_save_backup');
                localStorage.removeItem('auctionData_save_backup_time');
                return false;
            }

            const backupDate = backupPayload.date;
            const backupDayData = backupPayload.data;

            // 显示备份时间和具体日期
            let timeInfo = '';
            if (backupTime) {
                const date = new Date(backupTime);
                timeInfo = `（${backupType}备份时间：${date.toLocaleString()}，仅恢复 ${backupDate} 这一天）`;
            }


            // 恢复备份数据：只精准覆盖被备份的那一天，其它日期完全不动
            // 阶段四 Bug 3 修复：allData.auction 即 _auctionMemCache（Bug 1+2 修好后），
            // 直接操作即可；同时走 patchAuctionFieldBatch 把数据字段同步到云端，
            // 不再依赖 saveData() 落 localStorage（auction 已不落地，见 Bug 4）
            if (backupDayData === null) {
                // 备份时这一天本来就没有数据，撤回即恢复为"没有"
                window.deleteAuctionDateData(backupDate, 'restore');
            } else {
                // 方案2：优先用备份时保存的 watchlist 索引恢复正式成员名单。
                // 行对象不携带 in_watchlist 字段，索引是正式/影子身份的唯一权威来源。
                // 旧备份无 watchlist 字段时，回退到 _extractWatchlistNamesFromRows（兼容旧数据可能携带的 in_watchlist 字段）。
                if (Array.isArray(backupDayData)) {
                    const backupWatchlist = backupPayload.watchlist;
                    if (Array.isArray(backupWatchlist) && backupWatchlist.length > 0) {
                        window._setAuctionWatchlistForDate(backupDate, backupWatchlist);
                    } else {
                        window._setAuctionWatchlistForDate(backupDate, window._extractWatchlistNamesFromRows(backupDayData));
                    }
                }
                window.setAuctionDateData(backupDate, backupDayData, 'restore');
                // 把这一天的所有数据字段 patch 到云端（camelCase → snake_case）
                const scMap = window._scMapCache || {};
                const patches = (Array.isArray(backupDayData) ? backupDayData : [])
                    .filter(function(s) { return s && s.stock; })
                    .map(function(item) {
                        const nameTrim = item.stock.trim();
                        return {
                            stock: nameTrim,
                            code: scMap[nameTrim] || item.code || '',
                            volume: item.volume || '',
                            yest_volume: item.yestVolume || '',
                            note: item.note || '',
                            change_pct: item.changePct || '',
                            topics: item.topics || '',
                            selected: item.selected || false,
                            bought: item.bought || false,
                            sold: item.sold || false,
                            fixed: item.fixed || false
                        };
                    });
                if (patches.length > 0) {
                    window.patchAuctionFieldBatch(backupDate, patches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch backup-revert ' + (e && e.message || e)); });
                }
            }
            // 用户主动确认"撤回"了 backupDate 这一天的数据，标记为脏日期，
            // 允许下次推送时用撤回后的本地状态覆盖云端该日期
            window.markAuctionDirty(backupDate);

            // 撤回后清除全部备份，避免下次撤回到错误状态
            localStorage.removeItem('auctionData_import_backup');
            localStorage.removeItem('auctionData_import_backup_time');
            localStorage.removeItem('auctionData_save_backup');
            localStorage.removeItem('auctionData_save_backup_time');

            // 刷新页面显示
            window.renderAuction();
            window.renderAuctionForm();
            window.showHint('已撤回早盘竞价数据');
            return true;
        }

        export function saveModule(name) {
            if (!window.allData || !window.allData[name]) return;
            // bidding 已改为纯云端表 + 内存缓存，不再落 localStorage
            if (name === 'bidding') return;
            // 阶段四 Bug 4 修复：auction 同样改为纯云端表（auction_watchlist + market_metrics）+ 内存缓存（_auctionMemCache），
            // 不再落 localStorage，避免本地旧/空快照在下次保存或导入时把云端数据覆盖掉，
            // 也避免与 _auctionMemCache 形成两份不同步的状态
            if (name === 'auction') return;
            // 阶段八：stocks / rank / multi / hotspot / pattern / tagTitles 已独立拆表，
            // 不落 localStorage，改为异步推送 Supabase
            if (name === 'stocks' || name === 'rank' || name === 'multi' ||
                name === 'hotspot' || name === 'pattern' || name === 'tagTitles') {
                if (typeof remainingBoards !== 'undefined' && remainingBoards.markDirty) {
                    remainingBoards.markDirty(name, state.currentDate);
                    remainingBoards.schedulePush();
                }
                return;
            }
            try {
                localStorage.setItem(window._moduleKey(name), JSON.stringify(window.allData[name]));
            } catch (e) {
                console.error('window.saveModule 失败 [' + name + ']:', e);
                if (e.name === 'QuotaExceededError' || e.code === 22) {
                    window.showToast('⚠️ 存储空间不足，数据可能未保存！请导出备份后清理旧数据。');
                }
            }
        }

        export function saveData() {
            MODULE_KEYS.forEach(key => {
                // bidding 已改为纯云端表（bidding_data）+ 内存缓存，不再落 localStorage，
                // 避免本地旧/空快照在下次保存或导入时把云端数据覆盖掉
                if (key === 'bidding') return;
                // jiwang 同理，已改为纯云端表（jiwang_data）+ 内存缓存
                if (key === 'jiwang') return;
                // 阶段四 Bug 4 修复：auction 同样不再落 localStorage
                if (key === 'auction') return;
                // 阶段八：stocks / rank / multi / hotspot / pattern / tagTitles 已独立拆表，
                // 不走 localStorage，改为标记脏数据并异步推送 Supabase
                if (key === 'stocks' || key === 'rank' || key === 'multi' ||
                    key === 'hotspot' || key === 'pattern' || key === 'tagTitles') {
                    return;
                }
                if (window.allData && window.allData[key] !== undefined) {
                    try {
                        localStorage.setItem(window._moduleKey(key), JSON.stringify(window.allData[key]));
                    } catch (e) {
                        console.error('window.saveData 失败 [' + key + ']:', e);
                        if (e.name === 'QuotaExceededError' || e.code === 22) {
                            window.showToast('⚠️ 存储空间不足，数据可能未保存！请导出备份后清理旧数据。');
                        }
                    }
                }
            });
            // 阶段八：触发剩余看板的云端同步
            if (typeof remainingBoards !== 'undefined' && remainingBoards.markAllDirty && state.currentDate) {
                remainingBoards.markAllDirty(state.currentDate);
                remainingBoards.schedulePush();
            }
            localStorage.setItem('lastEditedDate_' + state.DATA_VERSION, state.currentDate);
            // jiwang 数据独立防抖推送到 jiwang_data 表：遍历所有被标记为脏的日期
            // （不能只推 currentDate —— 例如"昨多板K线"回填是写 nextDate，
            // 若只看 currentDate 会漏推）
            if (window._jiwangDirtyDates && window._jiwangDirtyDates.size > 0) {
                Array.from(window._jiwangDirtyDates).forEach(function(d) {
                    window.scheduleJiwangPush(d);
                });
                window._jiwangDirtyDates.clear();
            }
            // 已解锁状态下，触发防抖云同步（2秒后推送）
            if (localStorage.getItem('unlocked') === '1') {
                window.scheduleCloudPush();
            }
        }



        // 保存评论
        export function saveComment() {
            const comment = window._getCommentInputValue();
            const stats = window.getStats();
            stats.comment = comment;
            window.markJiwangDirty(state.currentDate);
            window.saveData();
            window.renderComment();
            window.closeCommentModal();
            window.pushJiwangNow(state.currentDate, '✅ 评论已保存并同步到云端');
        }


        // 当前编辑追踪记录的股票标识
        window.currentTrackEditId = null;





        // 保存追踪记录编辑
        export function saveTrackEdit() {
            if (!state.currentTrackEditId) return;
            
            let stockIndex = -1;
            const data = window.getTodayData();
            
            stockIndex = data.findIndex(s => String(s.id) === String(state.currentTrackEditId));
            if (stockIndex === -1) {
                stockIndex = data.findIndex(s => s.name === state.currentTrackEditId);
            }
            
            if (stockIndex === -1) {
                window.showToast('❌ 未找到股票数据');
                return;
            }
            
            const trackData = window._readTrackEditFormData();
            const expandedStockId = state.currentTrackEditId;
            
            if (!window.allData.stocks[state.currentDate]) {
                window.allData.stocks[state.currentDate] = [];
            }
            window.allData.stocks[state.currentDate][stockIndex].track = trackData;
            
            window.saveData();
            window.renderList();
            
            window._restoreStockCardExpand(expandedStockId);
            window.closeTrackEditModal();
            window.showToast('✅ 追踪记录已保存！');
        }

        // 获取前一天日期
        export function getPreviousDate(date) {
            const d = new Date(date);
            d.setDate(d.getDate() - 1);
            return d.toISOString().split('T')[0];
        }

        // 获取后一天日期
        export function getNextDate(date) {
            const d = new Date(date);
            d.setDate(d.getDate() + 1);
            return d.toISOString().split('T')[0];
        }

        // 获取当日股票数据
        export function getTodayData() {
            return window.getStocksData()[state.currentDate] || [];
        }

        // 获取当日记忘数据
        export function getTodayJiwang() {
            const jiwangData = window.getJiwangData();
            return jiwangData[state.currentDate] || null;
        }

        // 获取当日排名数据
        export function getTodayRank() {
            return window.getRankData()[state.currentDate] || [];
        }

        // 获取分组数据（早盘竞价 / 热门股票），通过 dataSource 切换数据源
        // 'auction' 直接返回模块级独立内存缓存 _auctionMemCache（阶段四 Bug 1 修复），
        // 不再走 loadAllData().auction —— 后者虽然阶段四 Bug 2 修好后也指向 _auctionMemCache，
        // 但这里直接返回可以避开 loadAllData 的初始化副作用，并明确"渲染读的就是 patch 写的那份"。
        // 'hot' 读 _hotAuctionData 本地缓存
        export function getGroupData(dataSource='auction') {
            if (dataSource === 'hot') return window._hotAuctionData || {};
            return window._auctionMemCache;
        }

        // 获取早盘竞价数据（向后兼容：所有现有调用点不传参，行为不变）
        export function getAuctionData() {
            return window.getGroupData('auction');
        }

        // 获取今日早盘竞价数据
        // 返回数组的浅拷贝，防止外部修改意外影响原始数据，确保日期间数据隔离
        // 方案2：行对象不再携带 in_watchlist 字段；正式成员由 _auctionWatchlistIndex[date]
        //   独立 Set 判断。_auctionMemCache[date] 同时存正式成员和影子记录（仅供趋势图
        //   历史查询），渲染/统计/批量操作都只应看到正式列表。
        export function getTodayAuction() {
            const list = window.getAuctionData()[state.currentDate] || [];
            const watchlistSet = window._getAuctionWatchlistSet(state.currentDate);
            return list.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); });
        }

        // 获取今日指定分组（早盘竞价 / 热门股票）数据，供渲染函数按 dataSource 复用
        // 返回数组的浅拷贝，防止外部修改意外影响原始数据，确保日期间数据隔离
        // 方案2：auction 分组用 _auctionWatchlistIndex 判断正式成员；hot 分组天然只含正式成员。
        export function getTodayGroupList(dataSource='auction') {
            const list = window.getGroupData(dataSource)[state.currentDate] || [];
            if (dataSource === 'hot') {
                // 方案2：_hotAuctionData 只从 hot_stocks 表加载正式成员，无需过滤
                return list.filter(function(r) { return r && r.stock; });
            }
            // auction 分组：用 _auctionWatchlistIndex 独立 Set 判断正式成员
            const watchlistSet = window._getAuctionWatchlistSet(state.currentDate);
            const result = list.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); });
            // [DEBUG-VUE-FIX 2026-07-25] 暴露"后台有导入记录、前台不显示"这类问题的
            // 第一手证据：原始条数 vs 实际渲染条数 vs 被过滤掉的影子记录名单。
            // 只在条数发生变化（有过滤发生）时打印，避免刷屏。
            if (list.length > 0 && result.length !== list.length) {
                const filteredOut = list.filter(function(r) { return !r || !r.stock || !watchlistSet.has(r.stock.trim()); })
                    .map(function(r) { return (r && r.stock ? r.stock.trim() : '(无名)') + '[shadow]'; });
                window._dbgLog('[AUCTION-DEBUG] window.getTodayGroupList(' + dataSource + ') currentDate=' + state.currentDate +
                    ' 原始' + list.length + '条 → 正式列表' + result.length + '条，被过滤' + filteredOut.length + '条：' + filteredOut.join(', '));
            }
            return result;
        }

        const buildTopicCache = window.buildTopicCache;
        const scanDataSourceForTopics = window.scanDataSourceForTopics;
        const invalidateTopicCache = window.invalidateTopicCache;

        export function getStockHistoryTopics(stockName) {
            if (!stockName) return '';
            if (window._topicCacheBuilt && window._topicCache) {
                const topics = window._topicCache[stockName.trim()];
                if (!topics || topics.size === 0) return '';
                return '(' + Array.from(topics).join('，') + ')';
            }
            // 无缓存时只扫最近3个月
            const TOPIC_CACHE_DAYS = 66;
            const auctionData = window.getAuctionData();
            const allTopics = new Set();
            const allDates = Object.keys(auctionData).sort();
            const recentDates = allDates.length > TOPIC_CACHE_DAYS
                ? allDates.slice(-TOPIC_CACHE_DAYS)
                : allDates;
            recentDates.forEach(date => {
                // 不排除当天：与 buildTopicCache 保持一致
                const dayList = auctionData[date] || [];
                const stockItem = dayList.find(item => item.stock && item.stock.trim() === stockName.trim());
                if (stockItem && stockItem.note) {
                    const bracketMatches = stockItem.note.match(/\([^)]+\)/g) || [];
                    bracketMatches.forEach(match => {
                        const topics = match.replace(/[()]/g, '').split(/[,，、;；]/).map(t => t.trim()).filter(t => t);
                        topics.forEach(t => allTopics.add(t));
                    });
                }
            });
            if (allTopics.size === 0) return '';
            return '(' + Array.from(allTopics).join('，') + ')';
        }



        // ============================================================
        // 热门股票独立函数集合（与早盘竞价完全分离，只读写 _hotAuctionData + hot_stocks 表）
        // 方案 3.2：复制原函数 → 改名 → 改数据源 → 改云端同步
        // ============================================================

        // 热门股票专用数据源（不共用 getGroupData，避免任何耦合）
        export function getHotAuctionData() { return state._hotAuctionData || (state._hotAuctionData = {}); }







        // 备份热门股票数据（用于撤回，独立 localStorage key）
        export function backupHotStocksData(type, date) {
            return window._backupScopeData({
                type: type, date: date,
                getDataFn: window.getHotAuctionData,
                backupKeyPrefix: 'hotStocksData',
                label: '热门股票'
            });
        }

        // 撤回热门股票数据（独立 localStorage key，恢复到 _hotAuctionData，同步到 hot_stocks 表）
        export function rollbackHotStocksData() {
            const importDataStr = localStorage.getItem('hotStocksData_import_backup');
            const importTime = localStorage.getItem('hotStocksData_import_backup_time');
            const saveDataStr = localStorage.getItem('hotStocksData_save_backup');
            const saveTime = localStorage.getItem('hotStocksData_save_backup_time');
            let backupDataStr = null, backupTime = null, backupType = '';
            if (importDataStr && saveDataStr) {
                if (importTime && saveTime && new Date(importTime) >= new Date(saveTime)) {
                    backupDataStr = importDataStr; backupTime = importTime; backupType = '导入';
                } else {
                    backupDataStr = saveDataStr; backupTime = saveTime; backupType = '保存';
                }
            } else if (importDataStr) {
                backupDataStr = importDataStr; backupTime = importTime; backupType = '导入';
            } else if (saveDataStr) {
                backupDataStr = saveDataStr; backupTime = saveTime; backupType = '保存';
            }
            if (!backupDataStr) { throw new Error('没有可撤回的热门股票数据');  }
            let backupPayload;
            try { backupPayload = JSON.parse(backupDataStr); }
            catch (e) { throw new Error('备份数据已损坏，无法撤回');  }
            if (!backupPayload || typeof backupPayload !== 'object' || !('date' in backupPayload)) {
                throw new Error('检测到旧版本的撤回备份，已自动清除，无法撤回。');
                localStorage.removeItem('hotStocksData_import_backup');
                localStorage.removeItem('hotStocksData_import_backup_time');
                localStorage.removeItem('hotStocksData_save_backup');
                localStorage.removeItem('hotStocksData_save_backup_time');
                return false;
            }
            const backupDate = backupPayload.date;
            const backupDayData = backupPayload.data;
            let timeInfo = '';
            if (backupTime) {
                const dt = new Date(backupTime);
                timeInfo = `（${backupType}备份时间：${dt.toLocaleString()}，仅恢复 ${backupDate} 这一天）`;
            }
            // 恢复到 _hotAuctionData
            if (backupDayData === null) {
                delete window.getHotAuctionData()[backupDate];
            } else {
                window.getHotAuctionData()[backupDate] = backupDayData;
            }
            // 同步到 hot_stocks 表（全量 diff）
            window.syncHotStocksListForDate(backupDate).catch(function(err) {
                console.error('rollback window.syncHotStocksListForDate 失败:', err);
            });
            localStorage.removeItem('hotStocksData_import_backup');
            localStorage.removeItem('hotStocksData_import_backup_time');
            localStorage.removeItem('hotStocksData_save_backup');
            localStorage.removeItem('hotStocksData_save_backup_time');
            window.renderAuction('hot');
            window.renderHotForm();
            window.showHint('已撤回热门股票数据');
            return true;
        }

        // 保存热门股票（独立函数，不与 saveAuction 耦合）
        export function saveHotStocks(e) {
            e.preventDefault();
            window.backupHotStocksData('window.save');
            window.buildTopicCache();
            const formContainer = window._domGet('hotFormContainer');
            const rows = formContainer.querySelectorAll('.auction-form-row');
            const existingList = window.getHotAuctionData()[state.currentDate] || [];
            const scMap = window._scMapCache || {};
            const hotList = [];
            rows.forEach((row, index) => {
                const stockInput = row.querySelector(`[name="hot-stock-${index}"]`);
                const volumeInput = row.querySelector(`[name="hot-volume-${index}"]`);
                const yestInput = row.querySelector(`[name="hot-yest-${index}"]`);
                const stock = stockInput ? stockInput.value.trim() : '';
                const volume = volumeInput ? volumeInput.value.trim() : '';
                const yestVolume = yestInput ? yestInput.value.trim() : '';
                if (stock) {
                    const existingItem = existingList.find(item => item.stock && item.stock.trim() === stock);
                    var note = existingItem ? (existingItem.note || '') : '';
                    var changePct = existingItem ? (existingItem.changePct || '') : '';
                    var topics = existingItem ? (existingItem.topics || '') : '';
                    if (!note && !changePct && !topics) {
                        note = window.getStockHistoryTopics(stock);
                        var parsed = window.parseNoteToFields(note);
                        changePct = parsed.changePct;
                        topics = parsed.topics;
                    }
                    // [BUG-FIX] 保存表单时必须保留股票代码：优先取现有行的 code，再取 stockcodemap，
                    // 再取云端全量快照缓存里的 code，避免保存动作把同花顺/猫抓已回填的 code 冲掉。
                    let code = (existingItem ? (existingItem.code || '').trim() : '') || (scMap[stock] || '').trim();
                    if (!code) {
                        const cached = (window._hotFullRowCache[state.currentDate] || []).find(function(r) { return r && r.stock === stock; });
                        code = cached ? (cached.code || '').trim() : '';
                    }
                    hotList.push({
                        stock, volume, yestVolume,
                        code: code,
                        note: note, changePct: changePct, topics: topics,
                        selected: existingItem ? existingItem.selected : false,
                        bought: existingItem ? existingItem.bought : false,
                        sold: existingItem ? existingItem.sold : false,
                        fixed: existingItem ? existingItem.fixed : false
                    });
                }
            });
            hotList.sort((a, b) => {
                const ratioA = parseFloat(a.volume) / parseFloat(a.yestVolume) || 0;
                const ratioB = parseFloat(b.volume) / parseFloat(b.yestVolume) || 0;
                return ratioB - ratioA;
            });
            window.getHotAuctionData()[state.currentDate] = hotList;
            window.invalidateTopicCache();
            window.renderAuction('hot');
            const board = window._domGet('auctionBoard');
            if (board) board.classList.remove('collapsed');
            window.syncHotStocksListForDate(state.currentDate).catch(function(err) {
                console.error('window.saveHotStocks window.syncHotStocksListForDate 失败:', err);
            });
            // syncHotStocksListForDate 不会更新已有股票的 note/changePct/topics，这里补一次，
            // 避免新股票带出的历史题材（getStockHistoryTopics）只留在本地、刷新后丢失
            window.pushHotStocksDataToCloud(state.currentDate, hotList).catch(function(err) {
                console.error('window.saveHotStocks window.pushHotStocksDataToCloud 失败:', err);
            });
            window.closeHotEditModal();
        }

        // 从粘贴导入热门股票数据（本次问题的根因：原 importAuctionFromPaste 写死操作 auction）
        export function importHotFromPaste() {
            const textarea = window._domGet('hotPasteInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            if (!pasteText) {
                const status = window._domGet('hotImportStatus');
                status.textContent = '请先粘贴数据！';
                status.style.color = '#dc2626';
                textarea && textarea.focus();
                return;
            }
            window.backupHotStocksData('import');
            window.buildTopicCache();
            const scMap = window._scMapCache || {};
            const lines = pasteText.split(/\r?\n/);
            const hotData = window.getHotAuctionData();
            const existingList = hotData[state.currentDate] || [];
            let fullDataList = [];
            let noteList = [];
            let hasFullData = false;

            lines.forEach((line, index) => {
                if (!line.trim()) return;
                if (index === 0 && (line.includes('股票名称') || line.includes('竞价量') || line.includes('涨幅') || line.includes('概念'))) return;
                const cells = line.split('\t');
                if (cells.length >= 3) {
                    const stock = cells[0] ? cells[0].trim() : '';
                    const col2 = cells[1] ? cells[1].trim() : '';
                    const col3 = cells[2] ? cells[2].trim() : '';
                    if (!stock) return;
                    const col2IsNum = /^-?\d+\.?\d*$/.test(col2) || /^-?\d+\.?\d*%$/.test(col2);
                    const col3IsNum = /^-?\d+\.?\d*$/.test(col3) || /^-?\d+\.?\d*%$/.test(col3);
                    const col2HasPercent = col2.includes('%');
                    if (col2IsNum && !col2HasPercent && col3IsNum) {
                        hasFullData = true;
                        const existingItem = existingList.find(item => item.stock && item.stock.trim() === stock);
                        fullDataList.push({
                            stock, volume: col2, yestVolume: col3,
                            note: existingItem ? existingItem.note : '',
                            changePct: existingItem ? (existingItem.changePct || '') : '',
                            topics: existingItem ? (existingItem.topics || '') : '',
                            selected: existingItem ? existingItem.selected : false,
                            bought: existingItem ? existingItem.bought : false,
                            sold: existingItem ? existingItem.sold : false,
                            fixed: existingItem ? existingItem.fixed : false
                        });
                    } else {
                        let noteParts = [];
                        let conceptPart = '';
                        if (col2) {
                            if (col2HasPercent || col2IsNum) noteParts.push(col2);
                            else conceptPart = col2;
                        }
                        if (col3) {
                            if (conceptPart) conceptPart += col3;
                            else {
                                const col3HasPercent = col3.includes('%');
                                const col3IsNum2 = /^-?\d+\.?\d*$/.test(col3) || /^-?\d+\.?\d*%$/.test(col3);
                                if (col3HasPercent || col3IsNum2) noteParts.push(col3);
                                else conceptPart = col3;
                            }
                        }
                        var changePctStr = noteParts.join('');
                        var topicsStr = conceptPart ? conceptPart.replace(/[，、;；]/g, ',') : '';
                        var note = window.buildNoteFromFields(changePctStr, topicsStr);
                        noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                    }
                } else if (cells.length === 2) {
                    const stock = cells[0] ? cells[0].trim() : '';
                    const col2 = cells[1] ? cells[1].trim() : '';
                    if (!stock || !col2) return;
                    if (col2 === '-') return;
                    const col2HasPercent = col2.includes('%');
                    const col2IsNum = /^[+-]?\d+\.?\d*$/.test(col2) || /^[+-]?\d+\.?\d*%$/.test(col2);
                    var changePctStr = '';
                    var topicsStr = '';
                    if (col2HasPercent || col2IsNum) changePctStr = col2;
                    else topicsStr = col2.replace(/[，、;；]/g, ',');
                    var note = window.buildNoteFromFields(changePctStr, topicsStr);
                    noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                } else {
                    const trimmedLine = line.trim();
                    const percentMatch = trimmedLine.match(/^(.+?)\s+([+-]?\d+\.?\d*)%$/);
                    const spaceMatch = trimmedLine.match(/^(.+?)\s+([+-]?\d+\.?\d*)$/);
                    const conceptMatch = trimmedLine.match(/^(.+?)\s+([^\d].+)$/);
                    let stock = '';
                    var changePctStr = '';
                    var topicsStr = '';
                    if (percentMatch) { stock = percentMatch[1].trim(); changePctStr = percentMatch[2] + '%'; }
                    else if (spaceMatch) { stock = spaceMatch[1].trim(); changePctStr = spaceMatch[2] + '%'; }
                    else if (conceptMatch) { stock = conceptMatch[1].trim(); topicsStr = conceptMatch[2].trim().replace(/[，、;；]/g, ','); }
                    else return;
                    if (stock) {
                        var note = window.buildNoteFromFields(changePctStr, topicsStr);
                        noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                    }
                }
            });

            if (fullDataList.length === 0 && noteList.length === 0) {
                const status = window._domGet('hotImportStatus');
                status.textContent = '未能解析到有效数据！';
                status.style.color = '#dc2626';
                return;
            }

            let hotList = [...existingList];
            let fullDataCount = 0, fullDataUpdateCount = 0, noteUpdateCount = 0, noteNewCount = 0;

            fullDataList.forEach(dataItem => {
                const existingIndex = hotList.findIndex(item => item.stock && item.stock.trim() === dataItem.stock);
                if (existingIndex >= 0) {
                    var existingNote = hotList[existingIndex].note || '';
                    var existingChangePct = hotList[existingIndex].changePct || '';
                    var existingTopics = hotList[existingIndex].topics || '';
                    if (!existingNote && !existingChangePct && !existingTopics) {
                        const historyTopics = window.getStockHistoryTopics(dataItem.stock);
                        existingNote = historyTopics;
                        var parsed = window.parseNoteToFields(historyTopics);
                        existingChangePct = parsed.changePct;
                        existingTopics = parsed.topics;
                    }
                    const existingBought = hotList[existingIndex].bought;
                    const existingSelected = hotList[existingIndex].selected;
                    const existingSold = hotList[existingIndex].sold;
                    const existingFixed = hotList[existingIndex].fixed;
                    hotList[existingIndex] = {
                        ...hotList[existingIndex],
                        volume: dataItem.volume, yestVolume: dataItem.yestVolume,
                        note: existingNote, changePct: existingChangePct, topics: existingTopics,
                        bought: existingBought, selected: existingSelected, sold: existingSold, fixed: existingFixed
                    };
                    fullDataUpdateCount++;
                } else {
                    const historyTopics = window.getStockHistoryTopics(dataItem.stock);
                    var parsedHist = window.parseNoteToFields(historyTopics);
                    // [BUG-FIX] 新股票回填代码：优先 stockcodemap，再云端快照缓存。
                    const cached = (window._hotFullRowCache[state.currentDate] || []).find(function(r) { return r && r.stock === dataItem.stock; });
                    hotList.push({
                        ...dataItem,
                        code: dataItem.code || scMap[dataItem.stock] || (cached ? (cached.code || '') : '') || '',
                        note: historyTopics,
                        changePct: dataItem.changePct || parsedHist.changePct,
                        topics: dataItem.topics || parsedHist.topics
                    });
                    fullDataCount++;
                }
            });

            noteList.forEach(noteItem => {
                const existingIndex = hotList.findIndex(item => item.stock && item.stock.trim() === noteItem.stock);
                const historyTopics = window.getStockHistoryTopics(noteItem.stock);
                var historyParsed = window.parseNoteToFields(historyTopics);
                var newChangePct = noteItem.changePct || '';
                var newTopics = noteItem.topics || '';
                if (existingIndex >= 0) {
                    var existingChangePct = hotList[existingIndex].changePct || '';
                    var existingTopics = hotList[existingIndex].topics || '';
                    if (!existingChangePct && !existingTopics && hotList[existingIndex].note) {
                        var exParsed = window.parseNoteToFields(hotList[existingIndex].note);
                        existingChangePct = exParsed.changePct;
                        existingTopics = exParsed.topics;
                    }
                    if (newChangePct) {
                        hotList[existingIndex].changePct = newChangePct;
                        // 题材合并去重：现有题材 + 历史题材 + 本次粘贴题材
                        // （原逻辑只用现有/历史题材，粘贴的 newTopics 被整个丢弃——
                        //  导致"粘贴涨幅+题材后第二页题材分类空白"的 bug）
                        var allTopicsPct = new Set();
                        if (existingTopics) existingTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        if (historyParsed.topics) historyParsed.topics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        if (newTopics) newTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        hotList[existingIndex].topics = Array.from(allTopicsPct).join(',');
                    } else if (newTopics) {
                        var allTopics = new Set();
                        if (existingTopics) existingTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopics.add(t); });
                        if (historyParsed.topics) historyParsed.topics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopics.add(t); });
                        newTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopics.add(t); });
                        hotList[existingIndex].topics = Array.from(allTopics).join(',');
                        hotList[existingIndex].changePct = existingChangePct || historyParsed.changePct;
                    } else {
                        hotList[existingIndex].changePct = existingChangePct || historyParsed.changePct;
                        hotList[existingIndex].topics = existingTopics || historyParsed.topics;
                    }
                    hotList[existingIndex].note = window.buildNoteFromFields(hotList[existingIndex].changePct, hotList[existingIndex].topics);
                    noteUpdateCount++;
                } else {
                    var finalChangePct = newChangePct || historyParsed.changePct;
                    var finalTopics = noteItem.topics || '';
                    if (historyParsed.topics && !finalTopics) finalTopics = historyParsed.topics;
                    else if (historyParsed.topics && finalTopics) {
                        var allTopics2 = new Set();
                        finalTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopics2.add(t); });
                        historyParsed.topics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopics2.add(t); });
                        finalTopics = Array.from(allTopics2).join(',');
                    }
                    // [BUG-FIX] 新股票回填代码：优先 stockcodemap，再云端快照缓存。
                    const cached2 = (window._hotFullRowCache[state.currentDate] || []).find(function(r) { return r && r.stock === noteItem.stock; });
                    hotList.push({
                        stock: noteItem.stock, volume: '', yestVolume: '',
                        code: scMap[noteItem.stock] || (cached2 ? (cached2.code || '') : '') || '',
                        note: window.buildNoteFromFields(finalChangePct, finalTopics),
                        changePct: finalChangePct, topics: finalTopics, selected: false
                    });
                    noteNewCount++;
                }
            });

            if (fullDataList.length > 0) {
                hotList.sort((a, b) => {
                    const ratioA = parseFloat(a.volume) / parseFloat(a.yestVolume) || 0;
                    const ratioB = parseFloat(b.volume) / parseFloat(b.yestVolume) || 0;
                    return ratioB - ratioA;
                });
            }

            // 写入 _hotAuctionData（不写 localStorage，不调 saveModule/saveData）
            window.getHotAuctionData()[state.currentDate] = hotList;
            window.invalidateTopicCache();
            // 同步到 hot_stocks 表：增删/状态用 syncHotStocksListForDate，
            // 但它不会把已有股票的 note/changePct/topics/volume 写到云端（只处理增删和选中状态），
            // 所以这里必须再补一次 pushHotStocksDataToCloud，否则涨幅/题材/注释等更新只留在本地，刷新后消失
            window.syncHotStocksListForDate(state.currentDate).catch(function(err) {
                console.error('window.importHotFromPaste window.syncHotStocksListForDate 失败:', err);
            });
            window.pushHotStocksDataToCloud(state.currentDate, hotList).catch(function(err) {
                console.error('window.importHotFromPaste window.pushHotStocksDataToCloud 失败:', err);
            });
            // 阶段八修复：热门股票导入之前从未把题材同步进跨 tab 共享的 stock_topics 表，
            // 与早盘竞价的粘贴导入补齐同一逻辑，两个 tab 才能真正共享同一份题材库。
            // 规则：新旧题材合并去重，全部保留，不设数量上限（pushStockTopicsToCloud 内部已处理合并）。
            (function() {
                const scMap = window._scMapCache || {};
                hotList.forEach(function(item) {
                    if (!item || !item.stock || !item.topics) return;
                    const nameTrim = item.stock.trim();
                    const topicsArr = item.topics.split(/[,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) { return t; });
                    if (topicsArr.length === 0) return;
                    const code = scMap[nameTrim] || item.code || '';
                    window.pushStockTopicsToCloud(nameTrim, topicsArr, code).catch(function(e) {
                        console.warn('window.pushStockTopicsToCloud 失败（window.importHotFromPaste）:', nameTrim, e);
                    });
                });
            })();
            const pasteInput = window._domGet('hotPasteInput');
            if (pasteInput) pasteInput.value = '';
            const statusEl = window._domGet('hotImportStatus');
            let statusMsg = '✅ ';
            if (fullDataCount > 0) statusMsg += `新增${fullDataCount}条`;
            if (fullDataUpdateCount > 0) statusMsg += ` 更新${fullDataUpdateCount}条`;
            if (noteUpdateCount > 0) statusMsg += ` 更新注释${noteUpdateCount}条`;
            if (noteNewCount > 0) statusMsg += ` 新增注释${noteNewCount}条`;
            statusEl.textContent = statusMsg;
            statusEl.style.color = '#059669';
            // 刷新表单和前台（不调 renderList/recalcDuibanFromAuction/syncCloseChunk）
            setTimeout(() => window.renderHotForm(), 0);
            setTimeout(() => window.renderAuction('hot'), 20);
            const submitBtn = window._domQuery('#hotForm .submit-btn');
            if (submitBtn) submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // 替换概念（热门股票独立版本）
        export function replaceHotConceptFromPaste() {
            const textarea = window._domGet('hotPasteInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            if (!pasteText) {
                const status = window._domGet('hotImportStatus');
                status.textContent = '请先粘贴数据！';
                status.style.color = '#dc2626';
                textarea && textarea.focus();
                return;
            }
            const lines = pasteText.split(/\r?\n/);
            const hotData = window.getHotAuctionData();
            const existingList = hotData[state.currentDate] || [];
            let replaceCount = 0, notFoundCount = 0;
            const notFoundStocks = [];
            lines.forEach(line => {
                if (!line.trim()) return;
                const cells = line.split('\t');
                let stock = '', newConcept = '';
                if (cells.length >= 2) {
                    stock = cells[0] ? cells[0].trim() : '';
                    newConcept = cells[1] ? cells[1].trim() : '';
                } else if (cells.length === 1) {
                    const parts = cells[0].trim().split(/\s+/);
                    if (parts.length >= 2) { stock = parts[0]; newConcept = parts.slice(1).join(''); }
                }
                if (!stock || !newConcept) return;
                const existingIndex = existingList.findIndex(item => item.stock && item.stock.trim() === stock);
                if (existingIndex >= 0) {
                    const existingNote = existingList[existingIndex].note || '';
                    let newNote = '';
                    const bracketPattern = /(涨停|跌停|-?\d+\.?\d*%?)\(([^)]+)\)/g;
                    const matches = [...existingNote.matchAll(bracketPattern)];
                    if (matches.length > 0) {
                        const lastMatch = matches[matches.length - 1];
                        const fullMatch = lastMatch[0];
                        const prefix = lastMatch[1];
                        const beforeLastMatch = existingNote.substring(0, lastMatch.index);
                        const afterLastMatch = existingNote.substring(lastMatch.index + fullMatch.length);
                        newNote = beforeLastMatch + prefix + '(' + newConcept + ')' + afterLastMatch;
                    } else {
                        const percentPattern = /(-?\d+\.?\d*%)/g;
                        const percentMatches = [...existingNote.matchAll(percentPattern)];
                        if (percentMatches.length > 0) {
                            const lastPercentMatch = percentMatches[percentMatches.length - 1];
                            const beforeLastPercent = existingNote.substring(0, lastPercentMatch.index + lastPercentMatch[0].length);
                            const afterLastPercent = existingNote.substring(lastPercentMatch.index + lastPercentMatch[0].length);
                            newNote = beforeLastPercent + '(' + newConcept + ')' + afterLastPercent;
                        } else if (existingNote.includes('涨停')) {
                            newNote = existingNote.replace(/涨停/, '涨停(' + newConcept + ')');
                        } else if (existingNote.includes('跌停')) {
                            newNote = existingNote.replace(/跌停/, '跌停(' + newConcept + ')');
                        } else {
                            newNote = existingNote + '(' + newConcept + ')';
                        }
                    }
                    existingList[existingIndex].note = newNote;
                    var parsed = window.parseNoteToFields(newNote);
                    existingList[existingIndex].changePct = parsed.changePct;
                    existingList[existingIndex].topics = parsed.topics;
                    replaceCount++;
                } else {
                    notFoundCount++;
                    notFoundStocks.push(stock);
                }
            });
            if (replaceCount > 0) {
                window.getHotAuctionData()[state.currentDate] = existingList;
                window.invalidateTopicCache();
                window.syncHotStocksListForDate(state.currentDate).catch(function(err) {
                    console.error('window.replaceHotConceptFromPaste window.syncHotStocksListForDate 失败:', err);
                });
                // syncHotStocksListForDate 只同步增删/选中状态，不会把刚替换的 note/changePct/topics 写到云端
                // （这正是之前"粘贴导入题材、保存后刷新就消失"的原因）——这里补上真正写入这些字段的调用
                window.pushHotStocksDataToCloud(state.currentDate, existingList).catch(function(err) {
                    console.error('window.replaceHotConceptFromPaste window.pushHotStocksDataToCloud 失败:', err);
                });
                window.renderHotForm();
                window.renderAuction('hot');
            }
            const pasteInput = window._domGet('hotPasteInput');
            if (pasteInput) pasteInput.value = '';
            const statusEl = window._domGet('hotImportStatus');
            let statusMsg = '✅ 替换了 ' + replaceCount + ' 条概念';
            if (notFoundCount > 0) statusMsg += '，未找到: ' + notFoundStocks.slice(0, 3).join(', ') + (notFoundCount > 3 ? '...' : '');
            statusEl.textContent = statusMsg;
            statusEl.style.color = replaceCount > 0 ? '#059669' : '#dc2626';
            const submitBtn = window._domQuery('#hotForm .submit-btn');
            if (submitBtn) submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }


        // 历史数据补录（热门股票独立版本）
        export function importHotHistoryFill() {
            const textarea = window._domGet('hotHistoryFillInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            const statusEl = window._domGet('hotHistoryFillStatus');
            const dateInput = window._domGet('hotHistoryFillDate');
            const targetDate = dateInput ? dateInput.value : '';
            if (!targetDate) {
                if (statusEl) { statusEl.textContent = '请先选择目标日期！'; statusEl.style.color = '#dc2626'; }
                return;
            }
            if (!pasteText) {
                if (statusEl) { statusEl.textContent = '请先粘贴数据！'; statusEl.style.color = '#dc2626'; }
                textarea && textarea.focus();
                return;
            }
            const colTypeRadio = window._domQuery('input[name="hotHistoryFillColType"]:checked');
            const twoColField = colTypeRadio ? colTypeRadio.value : 'volume';
            window.backupHotStocksData('import', targetDate);
            const lines = pasteText.split(/\r?\n/);
            const hotData = window.getHotAuctionData();
            const targetList = [...(hotData[targetDate] || [])];
            const currentStockSet = new Set((hotData[state.currentDate] || []).map(item => item.stock && item.stock.trim()).filter(Boolean));
            let filledCount = 0, addedCount = 0, overwritedCount = 0, skippedNotInCurrent = 0, invalidCount = 0;

            lines.forEach((line, index) => {
                if (!line.trim()) return;
                if (index === 0 && (line.includes('股票名称') || line.includes('竞价量') || line.includes('昨日成交量'))) return;
                const rawCells = window.splitHistoryFillLine(line);
                const stock = rawCells[0] ? rawCells[0].trim() : '';
                if (!stock) { invalidCount++; return; }
                if (!currentStockSet.has(stock)) { skippedNotInCurrent++; return; }
                let existingIndex = targetList.findIndex(item => item.stock && item.stock.trim() === stock);
                let isNewRecord = false;
                if (existingIndex < 0) {
                    targetList.push({ stock, volume: '', yestVolume: '', note: '', changePct: '', topics: '', selected: false, bought: false, sold: false, fixed: false });
                    existingIndex = targetList.length - 1;
                    isNewRecord = true;
                }
                const nonEmptyCells = rawCells.slice(1).map(c => c.trim()).filter(c => c !== '');
                if (nonEmptyCells.length >= 2) {
                    const volumeText = rawCells[1] ? rawCells[1].trim() : '';
                    const yestText = rawCells[2] ? rawCells[2].trim() : '';
                    const parsedVolume = window.parseVolumeOnlyText(volumeText);
                    const parsedYest = window.parseVolumeOnlyText(yestText);
                    if (parsedVolume === null && parsedYest === null) {
                        invalidCount++;
                        if (isNewRecord) targetList.pop();
                        return;
                    }
                    const item = targetList[existingIndex];
                    let didFill = false;
                    if (parsedVolume !== null) {
                        const isEmpty = window.getNumericVolume(item.volume) === null;
                        item.volume = parsedVolume;
                        if (isEmpty) { filledCount++; } else { overwritedCount++; }
                        didFill = true;
                    }
                    if (parsedYest !== null) {
                        const isEmpty = window.getNumericVolume(item.yestVolume) === null;
                        item.yestVolume = parsedYest;
                        if (isEmpty) { filledCount++; } else { overwritedCount++; }
                        didFill = true;
                    }
                    if (didFill) { targetList[existingIndex] = { ...item }; if (isNewRecord) addedCount++; }
                    else if (isNewRecord) targetList.pop();
                } else if (nonEmptyCells.length === 1) {
                    const valueText = nonEmptyCells[0];
                    const parsedValue = window.parseVolumeOnlyText(valueText);
                    if (parsedValue === null) { invalidCount++; if (isNewRecord) targetList.pop(); return; }
                    const item = targetList[existingIndex];
                    const existingFieldValue = item[twoColField];
                    const isEmpty = window.getNumericVolume(existingFieldValue) === null;
                    targetList[existingIndex] = { ...item, [twoColField]: parsedValue };
                    if (isEmpty) { filledCount++; } else { overwritedCount++; }
                    if (isNewRecord) addedCount++;
                } else { invalidCount++; if (isNewRecord) targetList.pop(); }
            });

            if (filledCount === 0 && overwritedCount === 0) {
                if (statusEl) {
                    let msg = '未补录任何数据';
                    const parts = [];
                    if (skippedNotInCurrent > 0) parts.push(`${skippedNotInCurrent}条不在当前股票列表中`);
                    if (invalidCount > 0) parts.push(`${invalidCount}行无法识别`);
                    if (parts.length) msg += `（${parts.join('，')}）`;
                    statusEl.textContent = msg;
                    statusEl.style.color = '#dc2626';
                }
                return;
            }
            window.getHotAuctionData()[targetDate] = targetList;
            window.invalidateTopicCache();
            window.saveData();
            window.pushHotStocksDataToCloud(targetDate, targetList).catch(function(e) { console.warn('window.pushHotStocksDataToCloud ' + targetDate + ' 失败:', e); });
            window.pushHotTrendsToCloud(targetDate, targetList).catch(function(e) { console.warn('window.pushHotTrendsToCloud ' + targetDate + ' 失败:', e); });
            window.syncHotStocksListForDate(targetDate).catch(function(err) {
                console.error('window.importHotHistoryFill window.syncHotStocksListForDate 失败:', err);
            });
            if (textarea) textarea.value = '';
            let statusMsg = `✅ ${targetDate} 补齐${filledCount}个字段`;
            if (overwritedCount > 0) statusMsg += ` 覆盖${overwritedCount}个字段`;
            if (addedCount > 0) statusMsg += ` 新增${addedCount}条数据记录`;
            if (skippedNotInCurrent > 0) statusMsg += ` 跳过${skippedNotInCurrent}条(不在当前股票列表中)`;
            if (invalidCount > 0) statusMsg += ` 无法识别${invalidCount}行`;
            if (statusEl) { statusEl.textContent = statusMsg; statusEl.style.color = '#059669'; }
            if (targetDate === state.currentDate) {
                setTimeout(() => window.renderHotForm(), 0);
                setTimeout(() => window.renderAuction('hot'), 20);
            }
        }






        // 导入代码映射（热门股票独立版本：写入云端 stockcodemap + 把股票加到 _hotAuctionData[currentDate]）
        export async function importStockCodeMapHot() {
            const ta = window._domGet('stockCodeMapInput_hot');
            if (!ta) return;
            const raw = ta.value.trim();
            if (!raw) { window.setStockCodeMapStatusHot('请先粘贴数据', true); ta.focus(); return; }
            const map = Object.assign({}, window._scMapCache || {});
            const newNames = [];
            const scPairs = [];
            let count = 0;
            raw.split(/\r?\n/).forEach(line => {
                line = line.trim();
                if (!line) return;
                if (!/\d{6}/.test(line) && /股票名称|股票代码|名称|代码/.test(line)) return;
                let cells;
                if (line.includes('|')) cells = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
                else if (line.includes('\t')) cells = line.split('\t').map(s => s.trim()).filter(s => s.length > 0);
                else cells = line.split(/\s{2,}|\s+/).map(s => s.trim()).filter(Boolean);
                if (cells.length < 2) return;
                let name = '', code = '';
                const c0 = cells[0].replace(/^SH\.|^SZ\./i, '').trim();
                const c1 = cells[1].replace(/^SH\.|^SZ\./i, '').trim();
                if (/^\d{6}$/.test(c0)) { code = c0; name = cells[1].trim(); }
                else if (/^\d{6}$/.test(c1)) { name = cells[0].trim(); code = c1; }
                else { name = cells[0].trim(); code = cells[1].trim(); }
                if (!name) return;
                map[name] = code;
                if (code) scPairs.push({ stock: name, code: code });
                newNames.push(name);
                count++;
            });
            try {
                await window.upsertStockCodeMap(scPairs);
            } catch (e) {
                window._dbgLog('[AUCTION-ERR] window.importStockCodeMapHot window.upsertStockCodeMap ' + (e && e.message || e));
            }

            // 同步到今日热门股票列表：将导入的名称追加到 _hotAuctionData[currentDate]（已存在的不重复添加）
            let addedToHot = 0;
            // [BUG-FIX] 导入代码映射时，同步把 code 写回今日热门列表里已有的股票，
            // 避免列表里已有股票仍缺 code，后续同花顺/猫抓补全找不到代码。
            let codePatches = [];
            if (newNames.length > 0) {
                const hotList = (window.getHotAuctionData()[state.currentDate] || []).slice();
                newNames.forEach(name => {
                    const exists = hotList.some(item => item && item.stock && item.stock.trim() === name);
                    if (!exists) {
                        hotList.push({ stock: name, volume: '', yestVolume: '', note: '', changePct: '', topics: '', selected: false, bought: false, sold: false, fixed: false });
                        addedToHot++;
                    }
                });
                hotList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = map[name];
                    if (mappedCode && !((s.code || '').trim())) {
                        s.code = mappedCode;
                        codePatches.push({ stock: name, code: mappedCode });
                    }
                });
                window.getHotAuctionData()[state.currentDate] = hotList;
                window.invalidateTopicCache();
                window.syncHotStocksListForDate(state.currentDate).catch(function(err) {
                    console.error('window.importStockCodeMapHot window.syncHotStocksListForDate 失败:', err);
                });
                if (codePatches.length > 0) {
                    window.patchHotFieldBatch(state.currentDate, codePatches).catch(function(e) {
                        console.warn('window.importStockCodeMapHot window.patchHotFieldBatch code 失败:', e);
                    });
                }
                window.renderHotForm();
                window.renderAuction('hot');
            }

            ta.value = '';
            window.setStockCodeMapStatusHot(`✅ 已导入 ${count} 条映射，${addedToHot} 只已加入今日热门股票列表` +
                (codePatches && codePatches.length ? `，已回填 ${codePatches.length} 只股票的代码` : ''), false);
        }

        // 通过同花顺 fuyao 标的检索接口，按名称补全缺失的 6 位股票代码
        export async function searchTickerCodeByName(name) {
            if (!name) return '';
            try {
                const data = await window.fuyaoApiGet('/api/meta/tickers/search', {
                    q: name.trim(),
                    asset_type: 'a-share',
                    limit: 5
                });
                if (!data || !Array.isArray(data.item) || data.item.length === 0) return '';
                const target = name.trim();
                const match = data.item.find(function(it) {
                    return it && it.name && it.name.trim() === target;
                });
                const item = match || data.item[0];
                if (item && item.ticker) return String(item.ticker).trim();
            } catch (e) {
                window._dbgLog('[AUTO-CODE] 搜索 ' + name + ' 失败: ' + (e && e.message || e));
            }
            return '';
        }

        // 自动补全当前日期指定分组（auction/hot）下缺失代码的股票
        export async function autoCompleteMissingStockCodes(dataSource) {
            const ds = dataSource === 'hot' ? 'hot' : 'auction';
            const list = (window.getGroupData(ds)[state.currentDate] || []).filter(function(r) { return r && r.stock; });
            const scMap = window._scMapCache || {};
            const missing = list.filter(function(r) {
                const existing = (r.code || '').trim() || scMap[r.stock.trim()];
                return !existing;
            });
            if (missing.length === 0) {
                window.showToast('没有缺失代码的股票');
                return;
            }

            let completed = 0, failed = 0;
            const patches = [];
            const scPairs = [];
            for (let i = 0; i < missing.length; i++) {
                const item = missing[i];
                const name = item.stock.trim();
                const code = await window.searchTickerCodeByName(name);
                if (code) {
                    scMap[name] = code;
                    patches.push({ stock: name, code: code });
                    scPairs.push({ stock: name, code: code });
                    completed++;
                } else {
                    failed++;
                }
            }

            if (patches.length > 0) {
                try {
                    await window.upsertStockCodeMap(scPairs);
                } catch (e) {
                    window._dbgLog('[AUCTION-ERR] window.autoCompleteMissingStockCodes window.upsertStockCodeMap ' + (e && e.message || e));
                }
                if (ds === 'hot') {
                    await window.patchHotFieldBatch(state.currentDate, patches);
                } else {
                    await window.patchAuctionFieldBatch(state.currentDate, patches);
                }
            }

            window.showToast('代码补全：' + completed + ' 只成功，' + failed + ' 只失败');
            if (ds === 'hot') {
                if (typeof window.renderHotStocks === 'function') window.renderHotStocks();
            } else {
                if (typeof window.renderAuction === 'function') window.renderAuction();
            }
        }

        export async function importStockCodeMap() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : state.currentDate;
            const ta = window._domGet('stockCodeMapInput');
            if (!ta) return;
            const raw = ta.value.trim();
            if (!raw) { window.setStockCodeMapStatus('请先粘贴数据', true); ta.focus(); return; }
            const map = Object.assign({}, window._scMapCache || {});
            const newNames = []; // 本次导入的名称（用于同步到今日竞价列表）
            const scPairs = [];
            let count = 0;
            raw.split(/\r?\n/).forEach(line => {
                line = line.trim();
                if (!line) return;
                // 跳过表头
                if (!/\d{6}/.test(line) && /股票名称|股票代码|名称|代码/.test(line)) return;
                let cells;
                if (line.includes('|')) cells = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
                else if (line.includes('\t')) cells = line.split('\t').map(s => s.trim()).filter(s => s.length > 0);
                else cells = line.split(/\s{2,}|\s+/).map(s => s.trim()).filter(Boolean);
                if (cells.length < 2) return;
                // 识别哪列是代码（6位数字，去 SH./SZ. 前缀）
                let name = '', code = '';
                const c0 = cells[0].replace(/^SH\.|^SZ\./i, '').trim();
                const c1 = cells[1].replace(/^SH\.|^SZ\./i, '').trim();
                if (/^\d{6}$/.test(c0)) { code = c0; name = cells[1].trim(); }
                else if (/^\d{6}$/.test(c1)) { name = cells[0].trim(); code = c1; }
                else { name = cells[0].trim(); code = cells[1].trim(); }
                if (!name) return;
                map[name] = code;
                if (code) scPairs.push({ stock: name, code: code });
                newNames.push(name);
                count++;
            });
            try {
                await window.upsertStockCodeMap(scPairs);
            } catch (e) {
                window._dbgLog('[AUCTION-ERR] window.importStockCodeMap window.upsertStockCodeMap ' + (e && e.message || e));
            }

            // 同步到今日竞价列表：将导入的名称追加到 auction[targetDate]（已存在的不重复添加）
            let addedToAuction = 0;
            if (newNames.length > 0) {
                // 阶段四 Bug 3 修复：getAuctionData() 已直接返回 _auctionMemCache，
                // 直接操作它即可，不再需要 allData.auction = auctionData 这种重赋值（原本是为了触发 localStorage 落地，现已不落地）
                const auctionData = window.getAuctionData();
                if (!Array.isArray(auctionData[targetDate])) window.setAuctionDateData(targetDate, [], 'importAuctionCodeMap-init');
                const list = auctionData[targetDate];
                const newStocksAdded = [];
                const newRows = [];
                newNames.forEach(name => {
                    const exists = list.some(item => item && item.stock && item.stock.trim() === name);
                    if (!exists) {
                        // 方案2：行对象不携带 in_watchlist，通过 _addAuctionWatchlistMember 登记为正式成员
                        newRows.push({ stock: name, volume: '', yestVolume: '', note: '', selected: false, bought: false, sold: false, fixed: false });
                        window._addAuctionWatchlistMember(targetDate, name);
                        newStocksAdded.push(name);
                        addedToAuction++;
                    }
                });
                if (newRows.length > 0) window.mergeAuctionDateRows(targetDate, newRows, 'importAuctionCodeMap');
                // 主动往 auction[targetDate] 增加了股票，标记为脏日期，
                // 允许下次推送时用本地（含新增股票）的名单覆盖云端该日期
                window.markAuctionDirty(targetDate);
                // 阶段四 Bug 3 修复：新增的股票也走 patchAuctionFieldBatch 上报到云端（带 code 字段），
                // 不再依赖 saveModule('auction') 落 localStorage
                if (newStocksAdded.length > 0) {
                    const scMap = window._scMapCache || {};
                    const patches = newStocksAdded.map(function(name) {
                        return { stock: name, code: scMap[name] || '', volume: '', yest_volume: '', note: '', change_pct: '', topics: '', selected: false, bought: false, sold: false, fixed: false };
                    });
                    window.patchAuctionFieldBatch(targetDate, patches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch code-map-import ' + (e && e.message || e)); });
                }
                // 刷新后台编辑表单和前台看板
                window.renderAuctionForm();
                window.renderAuction();
            }

            window.scheduleCloudPush();
            // 同步代码到 auction_watchlist + market_metrics 的 code 列（拆表后新增）
            window.pushAuctionCodeToCloud(targetDate).catch(function(e) { window._dbgLog('[AUCTION-ERR] importAuctionCodeMap window.pushAuctionCodeToCloud ' + targetDate + ' ' + (e && e.message || e)); });
            ta.value = '';
            window.setStockCodeMapStatus(`✅ 已导入 ${count} 条映射，${addedToAuction} 只已加入今日竞价列表`, false);
        }




        // 从粘贴导入早盘竞价数据
        export function importAuctionFromPaste() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : state.currentDate;
            const sysToday = (typeof window._getLocalTodayStr === 'function') ? window._getLocalTodayStr() : '';
            if (sysToday && targetDate > sysToday) {
                window._dbgLog('[DATE-WARN] window.importAuctionFromPaste 写入未来日期 targetDate=' + targetDate + ' sysToday=' + sysToday + '，请确认这是预期行为');
            }
            window._dbgLog('[AUCTION-WRITE] window.importAuctionFromPaste targetDate=' + targetDate);
            const textarea = window._domGet('auctionPasteInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            if (!pasteText) {
                window._domSetText('auctionImportStatus', '请先粘贴数据！');
                window._domSetColor('auctionImportStatus', '#dc2626');
                textarea && textarea.focus();
                return;
            }

            // 备份早盘竞价数据（用于撤回）
            window.backupAuctionData('import');

            // 导入新数据后，观察组需重新计算：
            // - 已在导入列表中的观察组股票 → 加 * 标记
            // - 不在导入列表中的观察组股票 → 自动添加
            // 买入继承同样重新计算（boughtEnsured_/obsBought_ 一并清除）
            try {
                localStorage.removeItem('obsEnsured_' + targetDate);
                localStorage.removeItem('obsAutoAdded_' + targetDate);
                localStorage.removeItem('boughtEnsured_' + targetDate);
                localStorage.removeItem('obsBought_' + targetDate);
            } catch(e) {}

            window.buildTopicCache();

            // 兼容 \r\n（Excel/Windows换行）和 \n
            const lines = pasteText.split(/\r?\n/);
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];
            
            let fullDataList = [];
            let noteList = [];
            let hasFullData = false;

            lines.forEach((line, index) => {
                if (!line.trim()) return;
                if (index === 0 && (line.includes('股票名称') || line.includes('竞价量') || line.includes('涨幅') || line.includes('概念'))) return;

                const cells = line.split('\t');
                
                if (cells.length >= 3) {
                    const stock = cells[0] ? cells[0].trim() : '';
                    const col2 = cells[1] ? cells[1].trim() : '';
                    const col3 = cells[2] ? cells[2].trim() : '';

                    if (!stock) return;

                    const col2IsNum = /^-?\d+\.?\d*$/.test(col2) || /^-?\d+\.?\d*%$/.test(col2);
                    const col3IsNum = /^-?\d+\.?\d*$/.test(col3) || /^-?\d+\.?\d*%$/.test(col3);
                    const col2HasPercent = col2.includes('%');
                    const col3HasPercent = col3.includes('%');

                    if (col2IsNum && !col2HasPercent && col3IsNum) {
                        hasFullData = true;
                        const existingItem = existingList.find(item => item.stock && item.stock.trim() === stock);
                        fullDataList.push({
                            stock,
                            volume: col2,
                            yestVolume: col3,
                            note: existingItem ? existingItem.note : '',
                            changePct: existingItem ? (existingItem.changePct || '') : '',
                            topics: existingItem ? (existingItem.topics || '') : '',
                            selected: existingItem ? existingItem.selected : false,
                            // 方案 B：bought/sold/fixed 不从旧行拷贝（标签权威源是 stocksData），
                            // 避免陈旧标签位沉淀后被推送回云端
                            bought: false,
                            sold: false,
                            fixed: false
                        });
                    } else {
                        let noteParts = [];
                        let conceptPart = '';
                        if (col2) {
                            if (col2HasPercent || col2IsNum) {
                                noteParts.push(col2);
                            } else {
                                conceptPart = col2;
                            }
                        }
                        if (col3) {
                            if (conceptPart) {
                                conceptPart += col3;
                            } else {
                                const col3HasPercent = col3.includes('%');
                                const col3IsNum = /^-?\d+\.?\d*$/.test(col3) || /^-?\d+\.?\d*%$/.test(col3);
                                if (col3HasPercent || col3IsNum) {
                                    noteParts.push(col3);
                                } else {
                                    conceptPart = col3;
                                }
                            }
                        }
                        var changePctStr = noteParts.join('');
                        var topicsStr = conceptPart ? conceptPart.replace(/[，、;；]/g, ',') : '';
                        var note = window.buildNoteFromFields(changePctStr, topicsStr);
                        noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                    }
                } else if (cells.length === 2) {
                    const stock = cells[0] ? cells[0].trim() : '';
                    const col2 = cells[1] ? cells[1].trim() : '';

                    if (!stock || !col2) return;
                    if (col2 === '-') return; // 涨幅为横杠（停牌/未开市）跳过

                    const col2HasPercent = col2.includes('%');
                    const col2IsNum = /^[+-]?\d+\.?\d*$/.test(col2) || /^[+-]?\d+\.?\d*%$/.test(col2);
                    var changePctStr = '';
                    var topicsStr = '';
                    if (col2HasPercent || col2IsNum) {
                        changePctStr = col2;
                    } else {
                        topicsStr = col2.replace(/[，、;；]/g, ',');
                    }
                    var note = window.buildNoteFromFields(changePctStr, topicsStr);
                    noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                } else {
                    const trimmedLine = line.trim();
                    const percentMatch = trimmedLine.match(/^(.+?)\s+([+-]?\d+\.?\d*)%$/);
                    const spaceMatch = trimmedLine.match(/^(.+?)\s+([+-]?\d+\.?\d*)$/);
                    // 题材文字：股票名称 空格 非数字内容（如 大连友谊 零售、腾讯概念）
                    const conceptMatch = trimmedLine.match(/^(.+?)\s+([^\d].+)$/);
                    
                    let stock = '';
                    var changePctStr = '';
                    var topicsStr = '';
                    
                    if (percentMatch) {
                        stock = percentMatch[1].trim();
                        changePctStr = percentMatch[2] + '%';
                    } else if (spaceMatch) {
                        stock = spaceMatch[1].trim();
                        changePctStr = spaceMatch[2] + '%';
                    } else if (conceptMatch) {
                        stock = conceptMatch[1].trim();
                        topicsStr = conceptMatch[2].trim().replace(/[，、;；]/g, ',');
                    } else {
                        return;
                    }

                    if (stock) {
                        var note = window.buildNoteFromFields(changePctStr, topicsStr);
                        noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
                    }
                }
            });

            if (fullDataList.length === 0 && noteList.length === 0) {
                window._domSetText('auctionImportStatus', '未能解析到有效数据！');
                window._domSetColor('auctionImportStatus', '#dc2626');
                return;
            }

            let auctionList = [...existingList];
            let fullDataCount = 0;
            let fullDataUpdateCount = 0;
            let noteUpdateCount = 0;
            let noteNewCount = 0;

            fullDataList.forEach(dataItem => {
                const existingIndex = auctionList.findIndex(
                    item => item.stock && item.stock.trim() === dataItem.stock
                );
                if (existingIndex >= 0) {
                    var existingNote = auctionList[existingIndex].note || '';
                    var existingChangePct = auctionList[existingIndex].changePct || '';
                    var existingTopics = auctionList[existingIndex].topics || '';
                    if (!existingNote && !existingChangePct && !existingTopics) {
                        const historyTopics = window.getStockHistoryTopics(dataItem.stock);
                        existingNote = historyTopics;
                        var parsed = window.parseNoteToFields(historyTopics);
                        existingChangePct = parsed.changePct;
                        existingTopics = parsed.topics;
                    }
                    // 保留原有的 bought、selected、sold 和 fixed 状态
                    const existingBought = auctionList[existingIndex].bought;
                    const existingSelected = auctionList[existingIndex].selected;
                    const existingSold = auctionList[existingIndex].sold;
                    const existingFixed = auctionList[existingIndex].fixed;
                    auctionList[existingIndex] = {
                        ...auctionList[existingIndex],
                        volume: dataItem.volume,
                        yestVolume: dataItem.yestVolume,
                        note: existingNote,
                        changePct: existingChangePct,
                        topics: existingTopics,
                        bought: existingBought,
                        selected: existingSelected,
                        sold: existingSold,
                        fixed: existingFixed
                    };
                    fullDataUpdateCount++;
                } else {
                    const historyTopics = window.getStockHistoryTopics(dataItem.stock);
                    var parsedHist = window.parseNoteToFields(historyTopics);
                    auctionList.push({
                        ...dataItem,
                        note: historyTopics,
                        changePct: dataItem.changePct || parsedHist.changePct,
                        topics: dataItem.topics || parsedHist.topics
                    });
                    fullDataCount++;
                }
            });

            noteList.forEach(noteItem => {
                const existingIndex = auctionList.findIndex(
                    item => item.stock && item.stock.trim() === noteItem.stock
                );
                
                // 获取历史题材
                const historyTopics = window.getStockHistoryTopics(noteItem.stock);
                var historyParsed = window.parseNoteToFields(historyTopics);
                var newChangePct = noteItem.changePct || '';
                var newTopics = noteItem.topics || '';
                
                if (existingIndex >= 0) {
                    var existingChangePct = auctionList[existingIndex].changePct || '';
                    var existingTopics = auctionList[existingIndex].topics || '';
                    // 兼容：如果旧数据没有 changePct/topics 字段，从 note 解析
                    if (!existingChangePct && !existingTopics && auctionList[existingIndex].note) {
                        var exParsed = window.parseNoteToFields(auctionList[existingIndex].note);
                        existingChangePct = exParsed.changePct;
                        existingTopics = exParsed.topics;
                    }
                    
                    if (newChangePct) {
                        // 新导入带涨幅 → 替换旧涨幅；题材同时合并：现有 + 历史 + 本次粘贴，去重
                        // （原逻辑"保留旧题材"会丢弃粘贴的 newTopics，与热门股票版本是同一个 bug）
                        auctionList[existingIndex].changePct = newChangePct;
                        var allTopicsPct = new Set();
                        if (existingTopics) existingTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        if (historyParsed.topics) historyParsed.topics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        if (newTopics) newTopics.split(/[,，、;；]/).forEach(function(t) { t = t.trim(); if (t) allTopicsPct.add(t); });
                        auctionList[existingIndex].topics = Array.from(allTopicsPct).join(',');
                    } else if (newTopics) {
                        // 新导入的是题材 → 合并去重
                        var allTopics = new Set();
                        if (existingTopics) {
                            existingTopics.split(/[,，、;；]/).forEach(function(t) {
                                t = t.trim(); if (t) allTopics.add(t);
                            });
                        }
                        if (historyParsed.topics) {
                            historyParsed.topics.split(/[,，、;；]/).forEach(function(t) {
                                t = t.trim(); if (t) allTopics.add(t);
                            });
                        }
                        newTopics.split(/[,，、;；]/).forEach(function(t) {
                            t = t.trim(); if (t) allTopics.add(t);
                        });
                        auctionList[existingIndex].topics = Array.from(allTopics).join(',');
                        auctionList[existingIndex].changePct = existingChangePct || historyParsed.changePct;
                    } else {
                        // 无新数据，保留旧字段
                        auctionList[existingIndex].changePct = existingChangePct || historyParsed.changePct;
                        auctionList[existingIndex].topics = existingTopics || historyParsed.topics;
                    }
                    // 同步 note 字段（向后兼容）
                    auctionList[existingIndex].note = window.buildNoteFromFields(
                        auctionList[existingIndex].changePct,
                        auctionList[existingIndex].topics
                    );
                    noteUpdateCount++;
                } else {
                    // 新股票，使用导入的字段+历史题材
                    var finalChangePct = newChangePct || historyParsed.changePct;
                    var finalTopics = noteItem.topics || '';
                    // 合并历史题材
                    if (historyParsed.topics && !finalTopics) {
                        finalTopics = historyParsed.topics;
                    } else if (historyParsed.topics && finalTopics) {
                        var allTopics = new Set();
                        finalTopics.split(/[,，、;；]/).forEach(function(t) {
                            t = t.trim(); if (t) allTopics.add(t);
                        });
                        historyParsed.topics.split(/[,，、;；]/).forEach(function(t) {
                            t = t.trim(); if (t) allTopics.add(t);
                        });
                        finalTopics = Array.from(allTopics).join(',');
                    }
                    auctionList.push({
                        stock: noteItem.stock,
                        volume: '',
                        yestVolume: '',
                        note: window.buildNoteFromFields(finalChangePct, finalTopics),
                        changePct: finalChangePct,
                        topics: finalTopics,
                        selected: false
                    });
                    noteNewCount++;
                }
            });

            if (fullDataList.length > 0) {
                auctionList.sort((a, b) => {
                    const ratioA = parseFloat(a.volume) / parseFloat(a.yestVolume) || 0;
                    const ratioB = parseFloat(b.volume) / parseFloat(b.yestVolume) || 0;
                    return ratioB - ratioA;
                });
            }

            // 方案 B：标签不再写入 auctionData 行，渲染时由 deriveAuctionTagState 实时派生。

            window.setAuctionDateData(targetDate, auctionList, 'window.importAuctionFromPaste');
            // 方案2：粘贴导入是全量覆盖，所有导入的股票都是正式成员，整日期替换索引
            window._setAuctionWatchlistForDate(targetDate, auctionList.map(function(r) { return r && r.stock; }));
            window.saveModule('auction');
            window.invalidateTopicCache();
            // 同步到 auction_watchlist + market_metrics（阶段二 C：改为字段级 patch）
            // 粘贴导入是全量数据写入，覆盖所有业务字段；正式成员身份由 _auctionWatchlistIndex
            // 管理，syncAuctionListForDate 负责同步正式列表到云端 auction_watchlist
            (function() {
                const scMap = window._scMapCache || {};
                const patches = auctionList.filter(function(s) { return s && s.stock; }).map(function(item) {
                    const nameTrim = item.stock.trim();
                    return {
                        stock: nameTrim,
                        code: scMap[nameTrim] || item.code || '',
                        volume: item.volume || '',
                        yest_volume: item.yestVolume || '',
                        note: item.note || '',
                        change_pct: item.changePct || '',
                        topics: item.topics || '',
                        selected: item.selected || false,
                        bought: item.bought || false,
                        sold: item.sold || false,
                        fixed: item.fixed || false
                    };
                });
                if (patches.length > 0) {
                    // [RACE-FIX] 先等字段 patch 完成，再同步正式列表状态，避免两者并发读取同一份云端数据导致状态覆盖/缺失
                    (async function() {
                        try {
                            await window.patchAuctionFieldBatch(targetDate, patches);
                            // 同步正式列表到云端 auction_watchlist（索引已在 setAuctionDateData 后更新）
                            await window.syncAuctionListForDate(targetDate);
                        } catch (e) {
                            window._dbgLog('[AUCTION-ERR] window.importAuctionFromPaste 云端同步 ' + (e && e.message || e));
                        }
                    })();
                    // 阶段八修复：粘贴导入之前只把 topics 写进当天快照（auction_watchlist），
                    // 没有同步进跨日期共享的 stock_topics 题材库表，导致这批题材超过
                    // buildTopicCache 的 66 个交易日扫描窗口后就再也读不到了。
                    // 这里补上：只对本次「确实带了题材」的股票推送，避免用空字符串
                    // 覆盖题材库里该股票已经攒下的题材（pushStockTopicsToCloud 是整行覆盖式 upsert）。
                    patches.forEach(function(p) {
                        if (!p.topics) return; // 本次没有题材信息，不动题材库里已有的内容
                        // 注意：p.topics 是纯逗号/顿号分隔的题材文本（如"锂电池,机器人"），
                        // 不是 note 那种带括号的格式，不能用 extractTopics（它专门解析
                        // note 里 "(...)" 括号内的内容），直接按分隔符切分即可。
                        const topicsArr = p.topics.split(/[,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) { return t; });
                        if (topicsArr.length === 0) return;
                        window.pushStockTopicsToCloud(p.stock, topicsArr, p.code).catch(function(e) {
                            window._dbgLog('[AUCTION-ERR] window.importAuctionFromPaste window.pushStockTopicsToCloud ' + p.stock + ' ' + (e && e.message || e));
                        });
                    });
                }
            })();
            window._domSetValue('auctionPasteInput', '');
            let statusMsg = '✅ ';
            if (fullDataCount > 0) statusMsg += `新增${fullDataCount}条`;
            if (fullDataUpdateCount > 0) statusMsg += ` 更新${fullDataUpdateCount}条`;
            if (noteUpdateCount > 0) statusMsg += ` 更新注释${noteUpdateCount}条`;
            if (noteNewCount > 0) statusMsg += ` 新增注释${noteNewCount}条`;
            window._domSetText('auctionImportStatus', statusMsg);
            window._domSetColor('auctionImportStatus', '#059669');

            // 异步分批同步收盘涨幅（每帧30条），避免主线程卡死导致 localStorage 写入失败
            const itemsToSync = auctionList.filter(item => item.stock && item.note);
            let syncIdx = 0;

            setTimeout(() => window.renderAuctionForm(), 0);
            setTimeout(() => window.renderAuction(), 20);
            setTimeout(() => window.renderList(), 40);
            setTimeout(window.syncCloseChunk, 60);

            const submitBtn = window._domQuery('#auctionForm .submit-btn');
            if (submitBtn) {
                submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        // 解析"258.5万"或"3528"这类竞价量文本，统一返回数字字符串（不做单位换算）
        // 带"万"字：提取"万"字前面的数字；不带"万"字：直接使用这个数字
        // 统一的"竞价量/成交量取值"帮助函数：把字面量 0（无论是数字0还是字符串"0"）也当作"无数据"处理，
        // 和主列表里"0 显示为 - "的约定保持一致（外部抓取程序偶尔会在没抓到数据时写入0，而不是留空）。
        // 返回：有效数值时返回 Number，否则返回 null（用于图表断点、补录判断、比值计算等所有场景）。
        const getNumericVolume = window.getNumericVolume;

        export function parseVolumeOnlyText(text) {
            if (!text) return null;
            const trimmed = text.trim();
            if (trimmed.includes('万')) {
                const match = trimmed.match(/(-?\d+\.?\d*)\s*万/);
                return match ? match[1] : null;
            }
            const match = trimmed.match(/^-?\d+\.?\d*$/);
            return match ? trimmed : null;
        }

        // 历史数据补录：把一行文本切成单元格数组。
        // 优先按 TAB 分割（Excel 粘贴场景）；如果没有 TAB，则按"股票名称 + 空格分隔的数字"处理，
        // 方便手写录入：股票名称 竞价量 昨日成交量 / 股票名称 数字。
        // 按"从右往左，最多取2个纯数字/带万字的token"识别数值列，剩下的部分整体作为股票名称。
        export function splitHistoryFillLine(line) {
            if (line.indexOf('\t') !== -1) {
                return line.split('\t');
            }
            const tokens = line.trim().split(/\s+/).filter(Boolean);
            if (tokens.length <= 1) {
                return [line.trim()];
            }
            const isNumToken = (t) => window.parseVolumeOnlyText(t) !== null;
            let splitAt = tokens.length; // 数值列的起始下标
            for (let i = tokens.length - 1; i >= Math.max(1, tokens.length - 2); i--) {
                if (isNumToken(tokens[i])) {
                    splitAt = i;
                } else {
                    break;
                }
            }
            if (splitAt === tokens.length) {
                // 没有识别到末尾的数字 token，整行当作股票名称
                return [line.trim()];
            }
            const stockName = tokens.slice(0, splitAt).join(' ');
            const numCells = tokens.slice(splitAt);
            return [stockName, ...numCells];
        }


        // 历史数据补录：只补数值字段，不新增/删除股票。
        // 支持两种格式：
        //   三列（Tab分隔）：股票名称[TAB]竞价量[TAB]昨日成交量 —— 两个字段一起补
        //   两列（Tab分隔）：股票名称[TAB]数字 —— 按用户选择的单选（竞价量/昨日成交量）补对应字段
        // 规则：股票是否存在，以"当前正在查看的日期"（currentDate）的早盘竞价列表为准（这个列表是固定的，不能变）；
        //       只要该股票在当前列表里存在，就允许把数值补进"目标日期"（下拉框选的历史日期）对应的记录里；
        //       目标日期原本没有该股票的记录时，会新建一条只含数值的记录（不算新增股票，只是数据记录，因为该股票本身在当前列表里是存在的）；
        //       已有值不覆盖；当前列表里不存在的股票，直接跳过，不导入。
        export function importAuctionHistoryFill() {
            const textarea = window._domGet('auctionHistoryFillInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            const statusEl = window._domGet('auctionHistoryFillStatus');
            const dateInput = window._domGet('auctionHistoryFillDate');
            const targetDate = dateInput ? dateInput.value : '';
            const sysToday = (typeof window._getLocalTodayStr === 'function') ? window._getLocalTodayStr() : '';
            if (sysToday && targetDate > sysToday) {
                window._dbgLog('[DATE-WARN] window.importAuctionHistoryFill 写入未来日期 targetDate=' + targetDate + ' sysToday=' + sysToday + '，请确认这是预期行为');
            }

            if (!targetDate) {
                if (statusEl) {
                    statusEl.textContent = '请先选择目标日期！';
                    statusEl.style.color = '#dc2626';
                }
                return;
            }

            if (!pasteText) {
                if (statusEl) {
                    statusEl.textContent = '请先粘贴数据！';
                    statusEl.style.color = '#dc2626';
                }
                textarea && textarea.focus();
                return;
            }

            window._dbgLog('[AUCTION-WRITE] window.importAuctionHistoryFill targetDate=' + targetDate);

            const colTypeRadio = window._domQuery('input[name="auctionHistoryFillColType"]:checked');
            const twoColField = colTypeRadio ? colTypeRadio.value : 'volume'; // 两列格式时，数字要填入的字段名

            // 备份早盘竞价数据（用于撤回），与现有导入功能共用同一套备份/撤回机制
            // 注意：这里备份的是 targetDate（用户选择要补录的历史日期），而不是当天，
            // 因为这次操作实际改动的就是 targetDate 这一天
            window.backupAuctionData('import', targetDate);

            const lines = pasteText.split(/\r?\n/);
            const auctionData = window.getAuctionData();
            const targetList = [...(auctionData[targetDate] || [])];
            // 股票是否存在的判断依据：当前正在查看的日期的早盘竞价列表（固定的股票列表，不可新增/删除）
            const currentStockSet = new Set(window.getTodayAuction().map(item => item.stock && item.stock.trim()).filter(Boolean));

            let filledCount = 0;     // 成功补齐的字段数（三列格式里补两个字段算两次）
            let addedCount = 0;      // 目标日期记录里原本没有该股票的数据记录，新增了一条
            let overwritedCount = 0; // 股票存在且字段已有值，本次覆盖（用户要求手动粘贴可覆盖旧错误数据）
            let skippedNotInCurrent = 0; // 当前列表里不存在该股票，跳过（不允许导入无关股票）
            let invalidCount = 0;    // 无法解析的行数
            // 阶段二 C 改造：收集字段级 patch，结束时调用 patchAuctionFieldBatch 上报。
            // 本函数只改 volume / yest_volume 这两个字段，patch 里绝不携带 note/topics 等。
            const historyPatches = [];
            // twoColField 是 camelCase（'volume' | 'yestVolume'），patch 白名单用 snake_case，
            // 这里建一个映射，避免下面两列格式分支里临时转换。
            const twoColPatchKey = twoColField === 'yestVolume' ? 'yest_volume' : 'volume';

            lines.forEach((line, index) => {
                if (!line.trim()) return;
                if (index === 0 && (line.includes('股票名称') || line.includes('竞价量') || line.includes('昨日成交量'))) return;

                const rawCells = window.splitHistoryFillLine(line);
                const stock = rawCells[0] ? rawCells[0].trim() : '';

                if (!stock) {
                    invalidCount++;
                    return;
                }

                // 股票必须存在于当前列表（currentDate），否则视为无关股票，直接跳过
                if (!currentStockSet.has(stock)) {
                    skippedNotInCurrent++;
                    return;
                }

                // 查找目标日期的数据记录里是否已有该股票；没有的话新建一条只含数值的记录
                let existingIndex = targetList.findIndex(item => item.stock && item.stock.trim() === stock);
                let isNewRecord = false;
                if (existingIndex < 0) {
                    // 方案2：行对象不携带 in_watchlist，通过 _addAuctionWatchlistMember 登记为正式成员
                    targetList.push({ stock, volume: '', yestVolume: '', note: '', changePct: '', topics: '', selected: false, bought: false, sold: false, fixed: false });
                    window._addAuctionWatchlistMember(targetDate, stock);
                    existingIndex = targetList.length - 1;
                    isNewRecord = true;
                }

                const nonEmptyCells = rawCells.slice(1).map(c => c.trim()).filter(c => c !== '');

                if (nonEmptyCells.length >= 2) {
                    // 三列格式：股票名称[TAB]竞价量[TAB]昨日成交量，两个字段一起补
                    const volumeText = rawCells[1] ? rawCells[1].trim() : '';
                    const yestText = rawCells[2] ? rawCells[2].trim() : '';
                    const parsedVolume = window.parseVolumeOnlyText(volumeText);
                    const parsedYest = window.parseVolumeOnlyText(yestText);

                    if (parsedVolume === null && parsedYest === null) {
                        invalidCount++;
                        if (isNewRecord) targetList.pop(); // 无法解析，撤销刚才新增的空记录
                        return;
                    }

                    const item = targetList[existingIndex];
                    let didFill = false;
                    const patch = { stock: stock };

                    if (parsedVolume !== null) {
                        const isEmpty = window.getNumericVolume(item.volume) === null;
                        item.volume = parsedVolume;
                        patch.volume = parsedVolume;
                        if (isEmpty) { filledCount++; } else { overwritedCount++; }
                        didFill = true;
                    }
                    if (parsedYest !== null) {
                        const isEmpty = window.getNumericVolume(item.yestVolume) === null;
                        item.yestVolume = parsedYest;
                        patch.yest_volume = parsedYest;
                        if (isEmpty) { filledCount++; } else { overwritedCount++; }
                        didFill = true;
                    }
                    if (didFill) {
                        // 方案2：行对象不携带 in_watchlist，直接展开写入字段
                        targetList[existingIndex] = { ...item };
                        historyPatches.push(patch);
                        if (isNewRecord) addedCount++;
                    } else if (isNewRecord) {
                        targetList.pop(); // 新增的记录一个字段都没填上，撤销
                    }
                } else if (nonEmptyCells.length === 1) {
                    // 两列格式：股票名称[TAB]数字，按用户选择的字段类型补录
                    const valueText = nonEmptyCells[0];
                    const parsedValue = window.parseVolumeOnlyText(valueText);
                    if (parsedValue === null) {
                        invalidCount++;
                        if (isNewRecord) targetList.pop();
                        return;
                    }

                    const item = targetList[existingIndex];
                    const existingFieldValue = item[twoColField];
                    const isEmpty = window.getNumericVolume(existingFieldValue) === null;
                    // 方案2：行对象不携带 in_watchlist，直接写入字段值
                    targetList[existingIndex] = { ...item, [twoColField]: parsedValue };
                    historyPatches.push({ stock: stock, [twoColPatchKey]: parsedValue });
                    if (isEmpty) { filledCount++; } else { overwritedCount++; }
                    if (isNewRecord) addedCount++;
                } else {
                    invalidCount++;
                    if (isNewRecord) targetList.pop();
                }
            });

            if (filledCount === 0 && overwritedCount === 0) {

                if (statusEl) {
                    let msg = '未补录任何数据';
                    const parts = [];
                    if (skippedNotInCurrent > 0) parts.push(`${skippedNotInCurrent}条不在当前股票列表中`);
                    if (invalidCount > 0) parts.push(`${invalidCount}行无法识别`);
                    if (parts.length) msg += `（${parts.join('，')}）`;
                    statusEl.textContent = msg;
                    statusEl.style.color = '#dc2626';
                }
                return;
            }

            window.setAuctionDateData(targetDate, targetList, 'window.importAuctionHistoryFill');
            window.saveModule('auction');
            window.invalidateTopicCache();
            // 阶段二 C：改用字段级 patch 上报，只携带 volume/yest_volume，不再整段推送。
            if (historyPatches.length > 0) {
                window.patchAuctionFieldBatch(targetDate, historyPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.importAuctionHistoryFill window.patchAuctionFieldBatch ' + (e && e.message || e)); });
            }

            textarea.value = '';
            let statusMsg = `✅ ${targetDate} 补齐${filledCount}个字段`;
            if (overwritedCount > 0) statusMsg += ` 覆盖${overwritedCount}个字段`;
            if (addedCount > 0) statusMsg += ` 新增${addedCount}条数据记录`;
            if (skippedNotInCurrent > 0) statusMsg += ` 跳过${skippedNotInCurrent}条(不在当前股票列表中)`;
            if (invalidCount > 0) statusMsg += ` 无法识别${invalidCount}行`;
            if (statusEl) {
                statusEl.textContent = statusMsg;
                statusEl.style.color = '#059669';
            }

            // 若补录的正是当前正在查看的日期，刷新表单和看板显示
            if (targetDate === state.currentDate) {
                setTimeout(() => window.renderAuctionForm(), 0);
                setTimeout(() => window.renderAuction(), 20);
                setTimeout(() => window.renderList(), 40);
            }
        }

        // ============================================================
        // 股票接口数据拉取（同花顺 fuyao-proxy + 猫抓 numcat-proxy）
        // 仅新增功能，不改动任何已有函数与排序逻辑
        // ============================================================

        // 从同花顺接口返回项中提取 6 位股票代码：优先 ticker，缺失时从 thscode 截取
        export function extractCodeFromFuyaoItem(item) {
            if (!item) return '';
            if (item.ticker) return String(item.ticker).trim();
            if (item.thscode) {
                const code = String(item.thscode).trim().replace(/\..*$/, '');
                if (/^\d{6}$/.test(code)) return code;
            }
            return '';
        }


        // 按钮禁用/恢复（传入按钮元素和原始文本）
        export function setBtnLoading(btn, loading, originalText) {
            if (!btn) return;
            if (loading) {
                btn.disabled = true;
                btn.dataset.originalText = btn.textContent;
                btn.textContent = '处理中...';
            } else {
                btn.disabled = false;
                if (originalText) btn.textContent = originalText;
                else if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
            }
        }

        // ---------- 同花顺：获取最近多板 883410 成分股并导入当日竞价列表 ----------
        // 【竞态修复】点击这个按钮到接口真正返回之间有网络耗时，这段时间里如果用户切换了
        // 页面日期（比如从"未来某天"切回今天），原写法全程读全局 currentDate，写入时
        // 用的就已经是"切换之后"的日期，导致数据写到了错误的一天（例如：在 7-20 当天
        // 把页面切到 7-21 点击本按钮，接口返回前又切回了 7-20，数据就误写进了 7-20）。
        // 修复方式：进入函数第一行就把当时的 currentDate 锁存成局部常量 targetDate，
        // 后续所有写入（内存/本地/云端）一律用 targetDate，不再读可能已变化的全局 currentDate。
        export async function fetchLadderConstituentsMain(btn) {
            const statusEl = window._domGet('thsApiStatus');
            // 锁定"点击那一刻"的日期，全程只认这一个值，杜绝异步等待期间日期漂移
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : state.currentDate;
            window._dbgLog('[AUCTION-WRITE] window.fetchLadderConstituentsMain targetDate=' + targetDate);
            // 守卫：同花顺"最近多板"接口没有查询历史日期的能力，永远只返回"当前最近一个
            // 交易日"的实时成分股。只有当页面停留的日期恰好等于这个"最近交易日"才允许写入
            // （例如周六查看周五、交易日当天查看当天），否则接口返回的实时数据会被张冠李戴地
            // 覆盖写入一个不相关的历史日期，污染那天的数据（这正是之前多个历史日期出现同一批
            // 股票的根因）。
            const _mostRecentTD = window.getMostRecentTradingDay();
            if (targetDate !== _mostRecentTD) {
                window.setApiStatus('thsApiStatus', '⚠️ 已拒绝：最近多板接口只反映最近交易日（' + _mostRecentTD + '）的实时数据，不能写入 ' + targetDate + '，请切到 ' + _mostRecentTD + ' 再获取', false);
                window._dbgLog('[AUCTION-WRITE] window.fetchLadderConstituentsMain 拒绝：targetDate=' + targetDate + ' ≠ 最近交易日=' + _mostRecentTD);
                return;
            }
            window.setBtnLoading(btn, true);
            // 导入期间锁定该日期：期间任何 Realtime 触发的回拉都会跳过这一天，
            // 防止导入还没推送完成时被云端"旧数据"整段覆盖（见 lockAuctionDateForImport 注释）
            window.lockAuctionDateForImport(targetDate);
            try {
                const data = await window.fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: window.LADDER_THSCODE });
                const constituents = (data && data.item) || [];
                if (constituents.length === 0) {
                    window.setApiStatus('thsApiStatus', '最近多板当前无成分股数据', false);
                    return;
                }

                // 备份当日数据（用于撤回）—— 按锁存的 targetDate 备份，而非可能已变化的当前日期
                window.backupAuctionData('import', targetDate);

                const auctionData = window.getAuctionData();
                const existingList = auctionData[targetDate] || [];
                const existingMap = {};
                existingList.forEach(function(s) {
                    if (s && s.stock) existingMap[s.stock.trim()] = s;
                });

                // 标签口径：统一由 deriveAuctionTagState 派生（权威=股票卡片 stocksData，
                // 详见 ensureObservationStocks 上方注释），修正 existingMap/云端回灌残留的脏状态；
                // 无依据的标签位会被主动清除，不再"只设不清"。
                function applyLatestTag(name, row) {
                    // 标签统一走 deriveAuctionTagState 派生（权威=股票卡片 stocksData）：
                    // 方案 B：标签不再写入 auctionData 行，渲染时由 deriveAuctionTagState 实时派生。
                    // 保留日志输出用于调试。
                    const d = window.deriveAuctionTagState(name, targetDate);
                    if (d.source === 'today') {
                        window._dbgLogVerbose('[APPLY-TAG] ' + name + ' ← 当天=' + (d.sold ? 'sold' : d.bought ? 'bought' : 'hold'));
                    } else if (d.source === 'inherited') {
                        window._dbgLogVerbose('[APPLY-TAG] ' + name + ' ← 前日=bought/hold → 今日持');
                    }
                    return row;
                }
                window.applyLatestTag = applyLatestTag;

                // 合并：新成分股列表为准，保留已有股票的备注/点选状态/行情
                const newList = constituents.map(function(c) {
                    const name = (c.name || '').trim();
                    const existing = existingMap[name];
                    const code = window.extractCodeFromFuyaoItem(c) || (existing ? (existing.code || '') : '');
                    const row = {
                        stock: name,
                        code: code,
                        volume: existing ? (existing.volume || '') : '',
                        yestVolume: existing ? (existing.yestVolume || '') : '',
                        note: existing ? (existing.note || '') : '',
                        changePct: existing ? (existing.changePct || '') : '',
                        topics: existing ? (existing.topics || '') : '',
                        selected: existing ? existing.selected : false,
                        // 方案 B：bought/sold/fixed 不从旧行拷贝（标签唯一权威源是 stocksData，
                        // 行上的旧标签位已是废弃字段）。若继续拷贝，陈旧标签会随
                        // pushAuctionStatusForDate 沉淀回云端，形成"幽灵标签"数据源。
                        bought: false,
                        sold: false,
                        fixed: false
                    };
                    return window.applyLatestTag(name, row);
                });

                // 保留"观察组继承"进来、但不在本次最近多板新名单里的股票（例如汇得科技：
                // 昨日买入未卖，理应作为次日观察组继续展示，但它当天不在最近多板成分股里，
                // 之前"获取最近多板"整体覆盖会把这一行连带删掉）。
                // 条件：existing 行是 obsAutoAdded=true（观察组自动补入，非用户手动导入的正式成分股）
                // 且未被标记为已卖出，才补回；已卖出的不需要再观察，让它自然消失即可。
                const newListNames = new Set(newList.map(function(r) { return r.stock; }));
                window._dbgLogVerbose('[LADDER] 获取最近多板覆盖：新成分股 ' + newList.length + ' 只，保留观察组继承股中不在名单的');
                existingList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    if (newListNames.has(name)) return;
                    if (s.obsAutoAdded !== true) return; // 不是观察组继承来的，不额外保留
                    // 方案 B：标签不再写入行对象，用 deriveAuctionTagState 判断是否已卖出
                    const _ts3 = window.deriveAuctionTagState(name, targetDate);
                    const row = window.applyLatestTag(name, {
                        stock: name,
                        code: s.code || '',
                        volume: s.volume || '',
                        yestVolume: s.yestVolume || '',
                        note: s.note || '',
                        changePct: s.changePct || '',
                        topics: s.topics || '',
                        obsAutoAdded: true
                    });
                    if (_ts3.sold) {
                        window._dbgLogVerbose('[LADDER] 丢弃(已卖) ' + name);
                        return; // 已卖出：不再保留到次日观察组
                    }
                    window._dbgLogVerbose('[LADDER] 保留(观察组继承) ' + name);
                    newList.push(row);
                });
                window._dbgLogVerbose('[LADDER] 覆盖后 newList 共 ' + newList.length + ' 只，其中 obsAutoAdded=' + newList.filter(function(r){return r.obsAutoAdded===true;}).length + ' 只');

                // 更新 stockcodemap（name → code，云端唯一真相源）
                const scMap = window._scMapCache || {};
                let mapUpdated = false;
                const scPairs = [];
                constituents.forEach(function(c) {
                    const name = (c.name || '').trim();
                    const code = window.extractCodeFromFuyaoItem(c);
                    if (name && code && scMap[name] !== code) {
                        scMap[name] = code;
                        scPairs.push({ stock: name, code: code });
                        mapUpdated = true;
                    }
                });
                if (mapUpdated) {
                    window.upsertStockCodeMap(scPairs).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.fetchLadderConstituentsMain window.upsertStockCodeMap ' + (e && e.message || e)); });
                }

                window.setAuctionDateData(targetDate, newList, 'window.fetchLadderConstituentsMain');
                // 方案2：获取最近多板是全量覆盖，所有 newList 里的股票都是正式成员
                window._setAuctionWatchlistForDate(targetDate, newList.map(function(r) { return r && r.stock; }));
                window.saveModule('auction');
                window.invalidateTopicCache();

                // 关键修复：不管此前"观察组继承"（ensureObservationStocks）和"买入/持有进
                // 次日观察组"（ensureBoughtStocksForDate）有没有跑过、跑的时候数据是否齐全，
                // 这里整体覆盖了 auctionData[targetDate] 之后，必须清除两者的防重复标记，
                // 让下一次 renderAuction() 重新计算一遍——否则如果继承函数曾经在"最近多板
                // 覆盖之前"就先执行过一次（例如用户一进页面就直接点了"获取最近多板"），
                // 覆盖后即使继承来的股票（如汇得科技）已经丢失，也不会再补回来。
                try {
                    localStorage.removeItem('obsEnsured_' + targetDate);
                    localStorage.removeItem('boughtEnsured_' + targetDate);
                } catch (e) {}

                // 同步到云端：列表增删 + code 列 —— 全部按 targetDate，不受期间日期切换影响
                window.markAuctionDirty(targetDate);
                window.scheduleCloudPush();
                window.pushAuctionCodeToCloud(targetDate).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.fetchLadderConstituentsMain window.pushAuctionCodeToCloud ' + (e && e.message || e)); });

                // 刷新表单和看板：只有当"接口返回时页面仍停留在 targetDate"才刷新当前视图，
                // 否则说明用户已经切到别的日期在忙别的事，此时若仍用刚写入的这批数据刷新
                // 界面上正显示的另一天，等于用错误日期的内容覆盖了正确的渲染，容易造成
                // "看着是这天的数据、其实是那天的"的混淆——所以此时只提示、不刷新视图。
                if (state.currentDate === targetDate) {
                    window.renderAuctionForm();
                    window.renderAuction();
                    window.renderList();
                    window.setApiStatus('thsApiStatus', '✅ 已获取 ' + newList.length + ' 只最近多板股票', true);
                } else {
                    window.setApiStatus('thsApiStatus', '✅ 已获取 ' + newList.length + ' 只最近多板股票（写入 ' + targetDate + '，当前页面在 ' + state.currentDate + '，切回该日期即可看到）', true);
                }
            } catch (err) {
                window._dbgLog('[AUCTION-ERR] window.fetchLadderConstituentsMain ' + (err && err.message || err));
                let msg = err && err.message ? err.message : '拉取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
                // 延迟解锁：scheduleCloudPush 是 2 秒防抖，加上网络推送本身的耗时，
                // 提前解锁会让解锁后、真正推送完成前这段窗口内到达的 Realtime 通知
                // 仍然读到"推送前的云端旧数据"把刚导入的列表冲掉。延迟到留出安全余量
                // （3.5 秒）之后再解锁，确保这次导入自己的推送已经完成。
                setTimeout(function() { window.unlockAuctionDateForImport(targetDate); }, 3500);
            }
        }

        // 批量请求 fuyao historical 拿单天成交量
        // 返回 { ticker: volume(股) }，仅匹配 dayStr 当天的 K 线
        export async function fetchDayVolumes(codes, dayStr) {
            // [BUG-FIX] API 以北京时间(UTC+8)存储交易日，date_ms 是北京时间午夜。
            // 当浏览器不在 UTC+8 时区时，new Date(dayStr+'T00:00:00').getTime() 产生的
            // 查询区间可能与 API 的 date_ms 错开最多 ±12 小时，导致单日查询返回 0 条。
            // 修复：查询区间向前后各扩 1 天（±86400000ms），再用多策略日期匹配筛选正确交易日。
            const startMs = new Date(dayStr + 'T00:00:00').getTime() - 86400000; // 前1天
            const endMs = new Date(dayStr + 'T23:59:59').getTime() + 86400000;   // 后1天
            const result = {};
            const batchSize = 5;
            // [BUG-FIX] 时区安全日期匹配：date_ms 可能是 UTC 时间戳，不同服务器时区下
            // new Date(date_ms).getDate() 可能偏移一天。改用多策略匹配：
            // 1) 优先用 API 返回的 date 字符串（如有）
            // 2) 回退用本地时区解析
            // 3) 再回退用 UTC 解析
            // 4) 最后尝试 dayStr ± 1 天（容忍跨时区偏移）
            const dayStrPrev = window._shiftDateStr(dayStr, -1);
            const dayStrNext = window._shiftDateStr(dayStr, 1);
            const _acceptableDates = new Set([dayStr, dayStrPrev, dayStrNext]);
            let _debugLog = [];
            for (let i = 0; i < codes.length; i += batchSize) {
                const batch = codes.slice(i, i + batchSize);
                await Promise.all(batch.map(async function(code) {
                    try {
                        const thscode = window.tickerToThscode(code);
                        const data = await window.fuyaoApiGet('/api/a-share/prices/historical', {
                            thscode: thscode,
                            interval: '1d',
                            start: String(startMs),
                            end: String(endMs),
                            adjust: 'none'
                        });
                        const items = (data && data.item) || [];
                        let matched = false;
                        let _firstItemKeys = null;
                        // [BUG-FIX] 日期匹配策略重写：API 的 date_ms 是北京时间(UTC+8)午夜。
                        // 不同浏览器时区下 new Date(date_ms).getDate() 会偏移。
                        // 优先级：Beijing(UTC+8) 精确匹配 > 本地时区精确匹配 > UTC精确匹配 > ±1天容忍
                        // 不再用"先到先得"的 forEach 匹配，改为先收集所有候选再择优。
                        var _candidates = [];
                        items.forEach(function(item) {
                            if (!_firstItemKeys) _firstItemKeys = Object.keys(item).join(',');
                            // 策略1：API 返回了 date 字符串字段
                            var rawDate = item.date || item.time || item.datetime || '';
                            var dateStrApi = '';
                            if (rawDate && typeof rawDate === 'string') {
                                dateStrApi = rawDate.slice(0, 10);
                            }
                            // 策略2：Beijing time (UTC+8) — 加 8 小时后取 UTC 日期
                            var dateStrBeijing = '';
                            if (item.date_ms != null) {
                                var dBJ = new Date(item.date_ms + 8 * 3600 * 1000);
                                dateStrBeijing = dBJ.getUTCFullYear() + '-' + String(dBJ.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dBJ.getUTCDate()).padStart(2, '0');
                            }
                            // 策略3：本地时区
                            var dateStrLocal = '';
                            if (item.date_ms != null) {
                                var dLocal = new Date(item.date_ms);
                                dateStrLocal = dLocal.getFullYear() + '-' + String(dLocal.getMonth() + 1).padStart(2, '0') + '-' + String(dLocal.getDate()).padStart(2, '0');
                            }
                            // 策略4：UTC
                            var dateStrUtc = '';
                            if (item.date_ms != null) {
                                var dUtc = new Date(item.date_ms);
                                dateStrUtc = dUtc.getUTCFullYear() + '-' + String(dUtc.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dUtc.getUTCDate()).padStart(2, '0');
                            }
                            // 计算优先级分值：Beijing精确=4, API精确=3, 本地精确=2, UTC精确=1, ±1天容忍=0
                            var score = -1;
                            if (dateStrBeijing === dayStr) score = 4;
                            else if (dateStrApi === dayStr) score = 3;
                            else if (dateStrLocal === dayStr) score = 2;
                            else if (dateStrUtc === dayStr) score = 1;
                            else if (_acceptableDates.has(dateStrBeijing) || _acceptableDates.has(dateStrApi) || _acceptableDates.has(dateStrLocal) || _acceptableDates.has(dateStrUtc)) {
                                // ±1天容忍：优先用 Beijing 解析的日期判断接近度
                                var tolDate = dateStrBeijing || dateStrApi || dateStrLocal || dateStrUtc;
                                score = 0;
                                if (tolDate === dayStrPrev) score = 0; // 前一天容忍
                                else if (tolDate === dayStrNext) score = 0; // 后一天容忍
                            }
                            if (score >= 0 && item.volume != null) {
                                _candidates.push({ score: score, volume: item.volume, dateStrBeijing: dateStrBeijing });
                            }
                        });
                        // 择优：取分值最高的候选
                        if (_candidates.length > 0) {
                            _candidates.sort(function(a, b) { return b.score - a.score; });
                            result[code] = _candidates[0].volume;
                            matched = true;
                        }
                        if (!matched) {
                            _debugLog.push('[window.fetchDayVolumes] ' + code + '(' + thscode + ') dayStr=' + dayStr + ' items=' + items.length + ' candidates=' + _candidates.length + ' 未匹配到目标日期' + (_firstItemKeys ? ' itemKeys=' + _firstItemKeys : '') + (items.length > 0 ? ' firstItemDateMs=' + items[0].date_ms : ''));
                        }
                    } catch (e) {
                        _debugLog.push('[window.fetchDayVolumes] ' + code + ' dayStr=' + dayStr + ' 异常: ' + (e && e.message));
                        console.warn('获取 ' + code + ' 在 ' + dayStr + ' 的成交量失败:', e && e.message);
                    }
                }));
            }
            if (_debugLog.length > 0) {
                console.log('[window.fetchDayVolumes] dayStr=' + dayStr + ' 共' + codes.length + '只 成功' + Object.keys(result).length + '只 失败/未匹配' + _debugLog.length + '只:\n' + _debugLog.join('\n'));
            }
            return result;
        }

        // 日期字符串偏移辅助：dayStr 加/减 n 天，返回 YYYY-MM-DD
        export function _shiftDateStr(dayStr, n) {
            var d = new Date(dayStr + 'T00:00:00');
            d.setDate(d.getDate() + n);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        // 基于 todayList（当前显示的表格）构建 yesterdayList
        // 保留 auctionData[yesterday] 原有同名股票的业务字段（volume/yestVolume/note 等）
        // 这是用户的核心需求：不管股票怎么导入的，只要表格里显示了，就是获取数据的基础
        export function buildYesterdayListFromToday(todayList, auctionData, yesterday) {
            const existingYesterdayMap = {};
            (auctionData[yesterday] || []).forEach(function(s) {
                if (s && s.stock) existingYesterdayMap[s.stock.trim()] = s;
            });
            return todayList.map(function(s) {
                const name = (s.stock || '').trim();
                const existing = existingYesterdayMap[name];
                return {
                    stock: s.stock,
                    code: (s.code || (existing ? (existing.code || '') : '') || '').trim(),
                    volume: existing ? (existing.volume || '') : '',
                    yestVolume: existing ? (existing.yestVolume || '') : '',
                    note: existing ? (existing.note || '') : '',
                    changePct: existing ? (existing.changePct || '') : '',
                    topics: existing ? (existing.topics || '') : '',
                    selected: existing ? existing.selected : false,
                    bought: existing ? existing.bought : false,
                    sold: existing ? existing.sold : false,
                    fixed: existing ? existing.fixed : false
                };
            });
        }

        // ---------- 同花顺：补全昨日成交量（填两个交易日的 yestVolume，不动 volume） ----------
        export async function fillYesterdayVolumeFromThs(btn) {
            const statusEl = window._domGet('thsApiStatus');
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                if (!yesterday || !dayBefore) {
                    window.setApiStatus('thsApiStatus', '❌ 无法确定前两个交易日', false);
                    return;
                }

                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
                const yesterdayList = window.buildYesterdayListFromToday(todayList, auctionData, yesterday);
                const yesterdayListWasEmpty = (auctionData[yesterday] || []).length === 0;
                const scMap = window._scMapCache || {};

                // 收集需要查询的股票代码（today + yesterday 合并去重）
                const codeToName = {}; // ticker -> name
                const collectCodes = function(list) {
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (code) codeToName[code] = s.stock.trim();
                    });
                };
                collectCodes(todayList);
                collectCodes(yesterdayList);

                const allCodes = Object.keys(codeToName);
                if (allCodes.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺少代码映射，请先导入代码映射或获取最近多板）', false);
                    return;
                }

                // ===== 分两批调用 fuyao historical（每批用单天时间窗口，避免跨天窗口只返回最新一根 K 线）=====
                let todayFilled = 0, todaySkipped = 0;
                let yesterdayFilled = 0, yesterdaySkipped = 0;
                // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 yest_volume，
                // 不再像 pushAuctionDataToCloud 那样把整行（含 volume/change_pct/note/topics 等）一起带上——
                // 这是原 bug（先点同花顺再点猫抓互相覆盖）的触发点之一。
                const todayYestVolPatches = [];
                const yesterdayYestVolPatches = [];

                // ===== 第一批：调取当日的昨日成交量（today.yestVolume ← yesterday 的 volume）=====
                window.setApiStatus('thsApiStatus', '【1/2】正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
                const volYesterday = await window.fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)

                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    if (window.getNumericVolume(s.yestVolume) !== null) return; // 已有值，跳过
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && volYesterday[code] != null) {
                        s.yestVolume = String(Math.round(volYesterday[code] / 10000));
                        todayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        todayFilled++;
                    } else {
                        todaySkipped++;
                    }
                });
                auctionData[today] = todayList;
                window.saveModule('auction');
                if (todayYestVolPatches.length > 0) {
                    window.patchAuctionFieldBatch(today, todayYestVolPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch today yest_volume ' + (e && e.message || e)); });
                }

                // ===== 第二批：调取对比日的昨日成交量（yesterday.yestVolume ← dayBefore 的 volume）=====
                window.setApiStatus('thsApiStatus', '【2/2】正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
                const volDayBefore = await window.fetchDayVolumes(allCodes, dayBefore);

                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    if (window.getNumericVolume(s.yestVolume) !== null) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && volDayBefore[code] != null) {
                        s.yestVolume = String(Math.round(volDayBefore[code] / 10000));
                        // patch 只携带 yest_volume（正式列表成员和影子记录都走同一个 patches 数组，
                        // 对 patchAuctionFieldBatch 而言都是 upsert(date,stock) + 只写 yest_volume；
                        // in_watchlist 不通过 patch 上报，由 syncAuctionListForDate 单独管理）
                        yesterdayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        yesterdayFilled++;
                    } else {
                        yesterdaySkipped++;
                    }
                });

                // 关键修复：不能再用 buildYesterdayListFromToday 造出来的 yesterdayList（以 todayList 名单为模板）
                // 直接覆盖 auctionData[yesterday] —— 这会把本地内存里"对比日原有、但这次名单里没有的股票"
                // 整个丢掉，而后续只要触发一次 syncAuctionListForDate(yesterday)（脏日期同步），
                // 就会把云端那些"本地没有"的股票行标记 in_watchlist=false，导致对比日 tap 页面第一页
                // 原有股票被静默移除（表现为"股票变少了"）。
                // 正确做法：真正需要覆盖式更新的，只有"对比日原本就存在的股票"（合并 yestVolume 补全结果）；
                // 对比日原本没有的股票（本次为了凑对比而临时造出的影子行），不写回本地正式列表 auctionData[yesterday]，
                // 它们的 yest_volume 通过 patchAuctionFieldBatch 上报（in_watchlist 默认 false，仅供趋势图查询）。
                const existingYesterdayList = (auctionData[yesterday] || []).slice();
                const existingYesterdayNames = {};
                existingYesterdayList.forEach(function(s) {
                    if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                });
                // 用补全后的 yestVolume 更新"本来就存在于对比日列表"的那些股票（原地更新已有记录）
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    if (!existingYesterdayNames[name]) return; // 对比日本来没有的，跳过，不写回正式列表
                    const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                    if (target) target.yestVolume = s.yestVolume;
                });

                auctionData[yesterday] = existingYesterdayList; // 正式列表：只包含对比日原有股票，数量不变
                window.saveModule('auction');
                window.invalidateTopicCache();
                // 正式列表成员 + 影子记录统一走 patchAuctionFieldBatch（只写 yest_volume）
                if (yesterdayYestVolPatches.length > 0) {
                    window.patchAuctionFieldBatch(yesterday, yesterdayYestVolPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch yesterday yest_volume ' + (e && e.message || e)); });
                }

                // 刷新表单和看板
                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                const todayTotal = todayList.length;
                const yesterdayTotal = yesterdayList.length;
                const yesterdaySource = yesterdayListWasEmpty
                    ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                    : '';
                window.setApiStatus('thsApiStatus',
                    '✅ 今日填 ' + todayFilled + '/' + todayTotal + '，对比日填 ' + yesterdayFilled + '/' + yesterdayTotal + yesterdaySource +
                    '；跳过 今日' + todaySkipped + ' / 对比日' + yesterdaySkipped + '（无数据或缺代码）',
                    true);
            } catch (err) {
                console.error('window.fillYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺：当天昨日成交量（单独调 yesterday 单天，只填 today.yestVolume；弹窗选择补全/覆盖） ----------
        // 早盘竞价 tab 专属实现：只读写 auctionData / thsApiStatus，与热门股票 tab 的
        // fillHotTodayYesterdayVolumeFromThs 完全独立，不共用任何业务函数或状态。
        export function fillTodayYesterdayVolumeFromThs(btn) {
            window.showNumcatChoiceModal('当天昨日成交量模式', function(overwrite) {
                window._fillTodayYesterdayVolumeFromThsImpl(btn, overwrite);
            });
        }

        export async function _fillTodayYesterdayVolumeFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                if (!yesterday) {
                    window.setApiStatus('thsApiStatus', '❌ 无法确定上一交易日', false);
                    return;
                }
                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
                    return;
                }
                const scMap = window._scMapCache || {};
                const codeToName = {};
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) codeToName[code] = s.stock.trim();
                });
                const allCodes = Object.keys(codeToName);
                if (allCodes.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺代码映射，请先获取最近多板）', false);
                    return;
                }

                window.setApiStatus('thsApiStatus', '正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
                const volYesterday = await window.fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)

                let filled = 0, skipped = 0;
                // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 yest_volume
                const todayYestVolPatches = [];
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    if (!overwrite && window.getNumericVolume(s.yestVolume) !== null) return; // 补全模式：已有值跳过
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && volYesterday[code] != null) {
                        s.yestVolume = String(Math.round(volYesterday[code] / 10000));
                        todayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        filled++;
                    } else {
                        skipped++;
                    }
                });
                auctionData[today] = todayList;
                window.saveModule('auction');
                window.invalidateTopicCache();
                if (todayYestVolPatches.length > 0) {
                    window.patchAuctionFieldBatch(today, todayYestVolPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch today yest_volume ' + (e && e.message || e)); });
                }

                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                window.setApiStatus('thsApiStatus',
                    '✅ ' + (overwrite ? '覆盖' : '补全') + ' 当天昨日成交量 ' + filled + '/' + todayList.length + '，跳过 ' + skipped + '（无数据或缺代码）',
                    true);
            } catch (err) {
                console.error('window.fillTodayYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺：对比日昨成交量（单独调 dayBefore 单天，只填 yesterday.yestVolume；弹窗选择补全/覆盖） ----------
        // 早盘竞价 tab 专属实现：只读写 auctionData / thsApiStatus，与热门股票 tab 的
        // fillHotYesterdayYesterdayVolumeFromThs 完全独立，不共用任何业务函数或状态。
        export function fillYesterdayYesterdayVolumeFromThs(btn) {
            window.showNumcatChoiceModal('对比日昨成交量模式', function(overwrite) {
                window._fillYesterdayYesterdayVolumeFromThsImpl(btn, overwrite);
            });
        }

        export async function _fillYesterdayYesterdayVolumeFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                if (!yesterday || !dayBefore) {
                    window.setApiStatus('thsApiStatus', '❌ 无法确定前两个交易日', false);
                    return;
                }
                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
                const yesterdayList = window.buildYesterdayListFromToday(todayList, auctionData, yesterday);
                const yesterdayListWasEmpty = (auctionData[yesterday] || []).length === 0;
                const scMap = window._scMapCache || {};
                const codeToName = {};
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) codeToName[code] = s.stock.trim();
                });
                const allCodes = Object.keys(codeToName);
                if (allCodes.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺代码映射，请先获取最近多板）', false);
                    return;
                }

                window.setApiStatus('thsApiStatus', '正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
                const volDayBefore = await window.fetchDayVolumes(allCodes, dayBefore);

                let filled = 0, skipped = 0;
                // 阶段二 B 改造：收集字段级 patch，结束时调用 patchAuctionFieldBatch 上报。
                // 【重点自查项】patch 对象里只能出现 yest_volume，绝对不能顺手塞 volume——
                // 原实现 pushAuctionDataToCloud 会把当时内存里的 row.volume 旧值一起带上，
                // 这是原 bug（先点同花顺再点猫抓互相覆盖）的触发点之一。
                const yesterdayPatches = [];
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    if (!overwrite && window.getNumericVolume(s.yestVolume) !== null) return; // 补全模式：已有值跳过
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && volDayBefore[code] != null) {
                        s.yestVolume = String(Math.round(volDayBefore[code] / 10000));
                        // 只上报 yest_volume，不带 volume/change_pct/note 等其它字段
                        yesterdayPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        filled++;
                    } else {
                        skipped++;
                    }
                });

                // 同「两全昨日成交量」的修复：不能用 buildYesterdayListFromToday 造出的 yesterdayList
                // 直接覆盖 auctionData[yesterday]，否则会把对比日原有、但这次名单没覆盖到的股票冲掉，
                // 后续 syncAuctionListForDate 同步时会把这些股票误标记 in_watchlist=false 而从
                // tap 页面消失。只把补全的 yestVolume 合并回原有股票，不存在的股票不进正式列表。
                const existingYesterdayList = (auctionData[yesterday] || []).slice();
                const existingYesterdayNames = {};
                existingYesterdayList.forEach(function(s) {
                    if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                });
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    if (!existingYesterdayNames[name]) return;
                    const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                    if (target) target.yestVolume = s.yestVolume;
                });
                const shadowOnlyYesterdayStocks = yesterdayList.filter(function(s) {
                    return s && s.stock && !existingYesterdayNames[s.stock.trim()];
                });

                auctionData[yesterday] = existingYesterdayList;
                // 阶段四 Bug 5 修复：saveModule('auction') 已是 no-op（Bug 4），删除避免误导；
                // auctionData 即 _auctionMemCache（Bug 1+2），本地状态已由上面赋值更新
                window.invalidateTopicCache();
                // 阶段二 B：改用字段级 patch 上报，不再走整段 pushAuctionDataToCloud。
                // yesterdayPatches 同时包含正式列表成员和影子记录，对 patch 函数而言都是
                // upsert(date,stock) 定位 + 只写 yest_volume；in_watchlist 不通过 patch 上报。
                if (yesterdayPatches.length > 0) {
                    window.patchAuctionFieldBatch(yesterday, yesterdayPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch yesterday ' + (e && e.message || e)); });
                }

                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                const yesterdaySource = yesterdayListWasEmpty
                    ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                    : '';
                window.setApiStatus('thsApiStatus',
                    '✅ ' + (overwrite ? '覆盖' : '补全') + ' 对比日昨成交量 ' + filled + '/' + yesterdayList.length + yesterdaySource + '，跳过 ' + skipped + '（无数据或缺代码）',
                    true);
            } catch (err) {
                console.error('window.fillYesterdayYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺：获取涨幅（snapshot 接口，支持补全/覆盖弹窗） ----------
        export function fetchChangePctFromThs(btn) {
            window.showNumcatChoiceModal('获取涨幅模式', function(overwrite) {
                window._fetchChangePctFromThsImpl(btn, overwrite);
            });
        }

        export async function _fetchChangePctFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).filter(function(s) { return s && s.stock; });

                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                // 收集 thscode
                const scMap = window._scMapCache || {};
                const stockMap = {}; // thscode -> stock 对象
                const thscodes = [];
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) {
                        const thscode = window.tickerToThscode(code);
                        if (thscode && !stockMap[thscode]) {
                            thscodes.push(thscode);
                            stockMap[thscode] = s;
                        }
                    }
                });

                if (thscodes.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 没有可查询的股票（缺少代码映射，请先获取最近多板）', false);
                    return;
                }

                window.setApiStatus('thsApiStatus', '正在请求同花顺接口获取涨幅（' + thscodes.length + ' 只股票）...', true);

                // snapshot 接口支持批量查询（thscodes 逗号分隔，每批 ≤40 只）
                // 注意：fuyao 对批里任何一只不认识的代码（典型：北交所 .BJ）会【整批报错】，
                // 与热门股票版本同款对策：整批失败时降级为逐只请求，不认识的单只跳过。
                const batchSize = 40;
                let filledCount = 0;
                let skippedCount = 0;
                // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 change_pct + note，
                // 不再像 pushAuctionDataToCloud 那样把整行（含 volume/yest_volume/topics 等）一起带上——
                // 这是原 bug（先点同花顺再点猫抓互相覆盖）的触发点之一。
                const changePctPatches = [];

                for (let i = 0; i < thscodes.length; i += batchSize) {
                    const chunk = thscodes.slice(i, i + batchSize);
                    let data;
                    try {
                        data = await window.fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
                    } catch (batchErr) {
                        console.warn('snapshot 批量失败，降级逐只请求:', batchErr && batchErr.message);
                        const rescued = [];
                        for (let j = 0; j < chunk.length; j++) {
                            try {
                                const d1 = await window.fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk[j] });
                                if (d1 && d1.item) rescued.push.apply(rescued, d1.item);
                            } catch (e1) {
                                skippedCount++; // 该只代码 fuyao 不认识（北交所等），跳过
                            }
                        }
                        data = { item: rescued };
                    }
                    const items = (data && data.item) || [];
                    items.forEach(function(item) {
                        const thscode = item.thscode;
                        const pct = item.price_change_ratio_pct;
                        const stock = stockMap[thscode];
                        if (!stock) {
                            skippedCount++;
                            return;
                        }
                        if (pct === null || pct === undefined || pct === '') {
                            skippedCount++;
                            return;
                        }
                        const n = Number(pct);
                        if (isNaN(n)) {
                            skippedCount++;
                            return;
                        }
                        if (!overwrite && ((stock.changePct || '').trim())) {
                            skippedCount++; // 补全模式：已有值跳过
                            return;
                        }
                        stock.changePct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                        stock.note = window.buildNoteFromFields(stock.changePct, stock.topics);
                        // patch 只携带本次改动的字段：change_pct + note
                        changePctPatches.push({ stock: stock.stock, change_pct: stock.changePct, note: stock.note });
                        filledCount++;
                    });
                }

                auctionData[today] = todayList;
                window.saveModule('auction');
                window.invalidateTopicCache();
                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                // 同步到云端（字段级 patch，不再走整段 pushAuctionDataToCloud）
                if (changePctPatches.length > 0) {
                    window.patchAuctionFieldBatch(today, changePctPatches).catch(function(e) {
                        window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch changePct ' + (e && e.message || e));
                    });
                }

                const action = overwrite ? '覆盖' : '补全';
                window.setApiStatus('thsApiStatus',
                    '✅ ' + action + ' ' + filledCount + ' 只股票涨幅，跳过 ' + skippedCount + ' 只无数据或已有',
                    true);
            } catch (err) {
                console.error('window.fetchChangePctFromThs 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 fuyao-proxy Edge Function 已部署';
                }
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（早盘竞价）：历史断点涨幅补全 ----------
        // 与热门股票 tab 的 fillHotHistoryGapPctFromThs 完全独立的一套实现（不共用函数），
        // 写入走 patchAuctionFieldBatch（写 auction_watchlist + market_metrics / _auctionMemCache 缓存），
        // 三条红线相同：不读不写第一页正式列表语义、不调 syncAuctionListForDate、patch 只放 change_pct。
        // 早盘竞价的第一页列表由 getTodayAuction() 通过 _auctionWatchlistIndex 过滤正式成员得到，
        // 影子记录（不在索引里）不会出现在第一页，但趋势图能读到——正是本功能依赖的机制。
        // mode: 'fill'（补全，仅写 null 断点）| 'overwrite'（覆盖，重抓起点后所有交易日涨幅）
        export async function fillAuctionHistoryGapPctFromThs(btn, mode) {
            mode = (mode === 'overwrite') ? 'overwrite' : 'fill';
            const modeLabel = mode === 'overwrite' ? '覆盖' : '补全';
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                // 早盘竞价第一页正式列表（过滤影子记录）
                const todayList = window.getTodayAuction().filter(function(s) { return s && s.stock; });
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
                    return;
                }

                const scMap = window._scMapCache || {};
                const windowDates = [];
                let d = today;
                for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = window.getPreviousTradingDay(d); }
                if (windowDates.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 无法确定交易日序列', false);
                    return;
                }
                // 预检：当前窗口内各字段缺失概况
                let missingVolumeInWindow = 0, missingCode = 0;
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) { missingCode++; return; }
                    let hasVol = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        if (window.getStockHistoryValue(windowDates[i], name, 'volume', 'auction') !== null) { hasVol = true; break; }
                    }
                    if (!hasVol) missingVolumeInWindow++;
                });
                window._dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 点击 | currentDate=' + today + ' | 正式列表=' + todayList.length +
                    ' | 窗口交易日=' + windowDates.join(',') +
                    ' | 缺代码=' + missingCode + ' | 窗口内无竞价量=' + missingVolumeInWindow);

                const gapMap = {};
                let totalGapDays = 0;
                const noStartDateNames = [];
                const noGapNames = [];
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) return;
                    let startDate = null;
                    for (let i = 0; i < windowDates.length; i++) {
                        const vol = window.getStockHistoryValue(windowDates[i], name, 'volume', 'auction');
                        if (vol !== null) { startDate = windowDates[i]; break; }
                    }
                    if (!startDate) { noStartDateNames.push(name); return; }
                    const rawGapDates = [];
                    const hadValueDates = []; // 覆盖模式：记录已有涨幅的日期（用于区分"补"和"覆盖"）
                    let started = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        const dt = windowDates[i];
                        if (dt === startDate) started = true;
                        if (!started) continue;
                        const pct = window.getStockHistoryValue(dt, name, 'changePct', 'auction');
                        if (pct === null) {
                            rawGapDates.push(dt);
                        } else if (mode === 'overwrite') {
                            // 覆盖模式：已有涨幅的日期也要重抓，加入待处理列表
                            rawGapDates.push(dt);
                            hadValueDates.push(dt);
                        }
                    }
                    // 过滤非交易日：若 currentDate 是周末，窗口可能包含非交易日，
                    // API 不会返回这些日期的 K 线，避免把周末当断点日去抓空数据。
                    const gapDates = rawGapDates.filter(window.isTradingDay);
                    if (gapDates.length > 0) {
                        gapMap[name] = { code: code, gapDates: gapDates, hadValueDates: hadValueDates, nonTradingSkip: rawGapDates.length - gapDates.length };
                        totalGapDays += gapDates.length;
                    } else {
                        noGapNames.push(name);
                    }
                });

                const stockNames = Object.keys(gapMap);
                window._dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 目标汇总 | 有目标=' + stockNames.length + '（共' + totalGapDays + '天）' +
                    ' | 窗口内有竞价量但无目标=' + noGapNames.length +
                    ' | 窗口内无竞价量=' + noStartDateNames.length);
                if (stockNames.length === 0) {
                    if (noStartDateNames.length > 0) {
                        window.setApiStatus('thsApiStatus', '✅ 近5日涨幅无需' + modeLabel + '：' + noStartDateNames.length + ' 只股票窗口内无竞价量，无法定位起点；' + noGapNames.length + ' 只已有完整涨幅', true);
                    } else {
                        window.setApiStatus('thsApiStatus', '✅ 近5日涨幅无需' + modeLabel + '（所有股票已有完整涨幅）', true);
                    }
                    return;
                }

                window.setApiStatus('thsApiStatus',
                    modeLabel + '模式：发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个目标日，正在逐只拉取历史K线...', true);

                const patchesByDate = {};
                let filledStocks = 0, failedStocks = 0, noDataStocks = 0;
                let filledGapDays = 0, overwrittenDays = 0, noDataGapDays = 0, nonTradingSkipTotal = 0;

                for (let si = 0; si < stockNames.length; si++) {
                    const name = stockNames[si];
                    const info = gapMap[name];
                    nonTradingSkipTotal += (info.nonTradingSkip || 0);
                    const earliestGap = info.gapDates[0];
                    const baseDate = window.getPreviousTradingDay(earliestGap);
                    if (!baseDate) {
                        failedStocks++;
                        window._dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + ' 跳过：无法找到最早目标日 ' + earliestGap + ' 的前一交易日');
                        continue;
                    }
                    const startMs = new Date(baseDate + 'T00:00:00').getTime();
                    const endMs = new Date(today + 'T23:59:59').getTime();
                    try {
                        const data = await window.fuyaoApiGet('/api/a-share/prices/historical', {
                            thscode: window.tickerToThscode(info.code),
                            interval: '1d',
                            start: String(startMs),
                            end: String(endMs),
                            adjust: 'none'
                        });
                        const items = (data && data.item) || [];
                        const closeByDate = {};
                        items.forEach(function(it) {
                            const dt = new Date(it.date_ms);
                            const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                            if (typeof it.close_price === 'number') closeByDate[ds] = it.close_price;
                        });
                        const returnedDates = Object.keys(closeByDate).sort();
                        const missingDates = info.gapDates.filter(function(gd) {
                            const prev = window.getPreviousTradingDay(gd);
                            return !closeByDate[gd] || (prev && !closeByDate[prev]);
                        });
                        window._dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + '(' + info.code + ') 返回K线日期=' + returnedDates.join(',') +
                            ' | 目标日=' + info.gapDates.join(',') +
                            (missingDates.length > 0 ? ' | 缺失前收/当日收=' + missingDates.join(',') : ''));
                        let stockFilled = 0;
                        let stockOverwritten = 0;
                        let stockNoData = 0;
                        info.gapDates.forEach(function(gapDate) {
                            const prevDate = window.getPreviousTradingDay(gapDate);
                            const c0 = prevDate ? closeByDate[prevDate] : undefined;
                            const c1 = closeByDate[gapDate];
                            if (typeof c0 !== 'number' || typeof c1 !== 'number' || c0 === 0) {
                                stockNoData++;
                                return;
                            }
                            const pct = ((c1 - c0) / c0) * 100;
                            const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                            if (!patchesByDate[gapDate]) patchesByDate[gapDate] = [];
                            patchesByDate[gapDate].push({ stock: name, change_pct: pctStr });
                            // 区分：该日期之前是否有值（覆盖 vs 补全）
                            if (info.hadValueDates && info.hadValueDates.indexOf(gapDate) >= 0) {
                                stockOverwritten++;
                            } else {
                                stockFilled++;
                            }
                        });
                        if (stockFilled > 0 || stockOverwritten > 0) {
                            filledStocks++;
                            filledGapDays += stockFilled;
                            overwrittenDays += stockOverwritten;
                        }
                        if (stockNoData > 0) { noDataStocks++; noDataGapDays += stockNoData; }
                        if (si % 5 === 4 || si === stockNames.length - 1) {
                            window.setApiStatus('thsApiStatus',
                                modeLabel + '进度 ' + (si + 1) + '/' + stockNames.length + '，已处理 ' + (filledGapDays + overwrittenDays) + ' 个目标日...', true);
                        }
                    } catch (e) {
                        failedStocks++;
                        console.warn('拉取 ' + name + ' 历史K线失败:', e && e.message);
                    }
                }

                const gapDateKeys = Object.keys(patchesByDate);
                for (let di = 0; di < gapDateKeys.length; di++) {
                    const dt = gapDateKeys[di];
                    window.patchAuctionFieldBatch(dt, patchesByDate[dt]).catch(function(e) {
                        window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch 历史断点涨幅(' + modeLabel + ') ' + dt + ' ' + (e && e.message || e));
                    });
                }

                window.renderAuctionForm();
                window.renderAuction();

                window._dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 写入汇总 | 已写入股票=' + filledStocks +
                    ' | 补全断点=' + filledGapDays + ' | 覆盖已有=' + overwrittenDays +
                    ' | 无K线数据股票=' + noDataStocks + '（目标日=' + noDataGapDays + '）' +
                    ' | 拉取失败=' + failedStocks +
                    ' | 非交易日跳过=' + nonTradingSkipTotal);

                const statusParts = ['✅ ' + modeLabel + '完成：' + filledStocks + ' 只股票'];
                if (mode === 'overwrite') {
                    statusParts.push('覆盖 ' + overwrittenDays + ' 个已有涨幅');
                    if (filledGapDays > 0) statusParts.push('补全 ' + filledGapDays + ' 个断点');
                } else {
                    statusParts.push(filledGapDays + ' 个断点日涨幅已写入');
                }
                if (noDataStocks > 0) statusParts.push(noDataStocks + ' 只目标日无K线数据');
                if (failedStocks > 0) statusParts.push(failedStocks + ' 只拉取失败');
                if (nonTradingSkipTotal > 0) statusParts.push('跳过 ' + nonTradingSkipTotal + ' 个非交易日');
                window.setApiStatus('thsApiStatus', statusParts.join('，') + '（影子记录，不影响任何日期的最近多板池）', true);
            } catch (err) {
                console.error('window.fillAuctionHistoryGapPctFromThs(' + modeLabel + ') 失败:', err);
                let msg = err && err.message ? err.message : (modeLabel + '失败');
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（早盘竞价）：历史断点昨日成交量补全 ----------
        // 与上面 fillAuctionHistoryGapPctFromThs（历史断点涨幅）同一套定位逻辑，仅补全字段不同：
        // 以窗口内每只股票最早出现竞价量(volume)的日期为起点(startDate)，从该日起找出
        // yest_volume 缺失的断点日；为每只股票用 prices/historical 拉取
        // [最早断点日的前一交易日 ~ 今天] 整段日线，取每个断点日"前一交易日"的 volume
        // 作为该断点日的 yest_volume（与"当天/对比日昨成交量"按钮同样的 单位换算：股 ÷ 10000）。
        // 同样只经 patchAuctionFieldBatch 写 yest_volume 字段，不碰 in_watchlist / 第一页正式列表语义。
        export async function fillAuctionHistoryGapYestVolumeFromThs(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                // 早盘竞价第一页正式列表（过滤影子记录）
                const todayList = window.getTodayAuction().filter(function(s) { return s && s.stock; });
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
                    return;
                }

                const scMap = window._scMapCache || {};
                const windowDates = [];
                let d = today;
                for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = window.getPreviousTradingDay(d); }
                if (windowDates.length === 0) {
                    window.setApiStatus('thsApiStatus', '❌ 无法确定交易日序列', false);
                    return;
                }
                // 预检：当前窗口内各字段缺失概况
                let missingVolumeInWindow = 0, missingCode = 0;
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) { missingCode++; return; }
                    let hasVol = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        if (window.getStockHistoryValue(windowDates[i], name, 'volume', 'auction') !== null) { hasVol = true; break; }
                    }
                    if (!hasVol) missingVolumeInWindow++;
                });
                window._dbgLog('[AUCTION-BTN] 历史断点昨日成交量 点击 | currentDate=' + today + ' | 正式列表=' + todayList.length +
                    ' | 窗口交易日=' + windowDates.join(',') +
                    ' | 缺代码=' + missingCode + ' | 窗口内无竞价量=' + missingVolumeInWindow);

                const gapMap = {};
                let totalGapDays = 0;
                const noStartDateNames = [];
                const noGapNames = [];
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) return;
                    let startDate = null;
                    for (let i = 0; i < windowDates.length; i++) {
                        const vol = window.getStockHistoryValue(windowDates[i], name, 'volume', 'auction');
                        if (vol !== null) { startDate = windowDates[i]; break; }
                    }
                    if (!startDate) { noStartDateNames.push(name); return; }
                    const rawGapDates = [];
                    let started = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        const dt = windowDates[i];
                        if (dt === startDate) started = true;
                        if (!started) continue;
                        const yv = window.getStockHistoryValue(dt, name, 'yestVolume', 'auction');
                        if (yv === null) rawGapDates.push(dt);
                    }
                    const gapDates = rawGapDates.filter(window.isTradingDay);
                    if (gapDates.length > 0) {
                        gapMap[name] = { code: code, gapDates: gapDates, nonTradingSkip: rawGapDates.length - gapDates.length };
                        totalGapDays += gapDates.length;
                    } else {
                        noGapNames.push(name);
                    }
                });

                const stockNames = Object.keys(gapMap);
                window._dbgLog('[AUCTION-BTN] 历史断点昨日成交量 断点汇总 | 有断点=' + stockNames.length + '（共' + totalGapDays + '天）' +
                    ' | 窗口内有竞价量但无断点=' + noGapNames.length +
                    ' | 窗口内无竞价量=' + noStartDateNames.length);
                if (stockNames.length === 0) {
                    if (noStartDateNames.length > 0) {
                        window.setApiStatus('thsApiStatus', '✅ 近5日昨日成交量无断点：' + noStartDateNames.length + ' 只股票窗口内无竞价量，无法定位起点；' + noGapNames.length + ' 只已有完整昨日成交量', true);
                    } else {
                        window.setApiStatus('thsApiStatus', '✅ 近5日昨日成交量无断点（所有股票已有完整昨日成交量）', true);
                    }
                    return;
                }

                window.setApiStatus('thsApiStatus',
                    '发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个昨日成交量断点，正在逐只拉取历史日线...', true);

                const patchesByDate = {};
                let filledStocks = 0, failedStocks = 0, noDataStocks = 0;
                let filledGapDays = 0, noDataGapDays = 0, nonTradingSkipTotal = 0;

                for (let si = 0; si < stockNames.length; si++) {
                    const name = stockNames[si];
                    const info = gapMap[name];
                    nonTradingSkipTotal += (info.nonTradingSkip || 0);
                    const earliestGap = info.gapDates[0];
                    const baseDate = window.getPreviousTradingDay(earliestGap);
                    if (!baseDate) { failedStocks++; continue; }
                    const startMs = new Date(baseDate + 'T00:00:00').getTime();
                    const endMs = new Date(today + 'T23:59:59').getTime();
                    try {
                        const data = await window.fuyaoApiGet('/api/a-share/prices/historical', {
                            thscode: window.tickerToThscode(info.code),
                            interval: '1d',
                            start: String(startMs),
                            end: String(endMs),
                            adjust: 'none'
                        });
                        const items = (data && data.item) || [];
                        const volByDate = {};
                        items.forEach(function(it) {
                            const dt = new Date(it.date_ms);
                            const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                            if (typeof it.volume === 'number') volByDate[ds] = it.volume;
                        });
                        const returnedDates = Object.keys(volByDate).sort();
                        const missingDates = info.gapDates.filter(function(gd) {
                            const prev = window.getPreviousTradingDay(gd);
                            return !volByDate[prev];
                        });
                        window._dbgLog('[AUCTION-BTN] 历史断点昨日成交量 ' + name + '(' + info.code + ') 返回成交量日期=' + returnedDates.join(',') +
                            ' | 断点日=' + info.gapDates.join(',') +
                            (missingDates.length > 0 ? ' | 缺失前日成交量=' + missingDates.join(',') : ''));
                        let stockFilled = 0;
                        let stockNoData = 0;
                        info.gapDates.forEach(function(gapDate) {
                            const prevDate = window.getPreviousTradingDay(gapDate);
                            const vol = prevDate ? volByDate[prevDate] : undefined;
                            if (typeof vol !== 'number') {
                                stockNoData++;
                                return;
                            }
                            const yestVolumeStr = String(Math.round(vol / 10000));
                            if (!patchesByDate[gapDate]) patchesByDate[gapDate] = [];
                            patchesByDate[gapDate].push({ stock: name, yest_volume: yestVolumeStr });
                            stockFilled++;
                        });
                        if (stockFilled > 0) { filledStocks++; filledGapDays += stockFilled; }
                        if (stockNoData > 0) { noDataStocks++; noDataGapDays += stockNoData; }
                        if (si % 5 === 4 || si === stockNames.length - 1) {
                            window.setApiStatus('thsApiStatus',
                                '拉取进度 ' + (si + 1) + '/' + stockNames.length + '，已补 ' + filledGapDays + ' 个断点...', true);
                        }
                    } catch (e) {
                        failedStocks++;
                        console.warn('拉取 ' + name + ' 历史日线失败:', e && e.message);
                    }
                }

                const gapDateKeys = Object.keys(patchesByDate);
                for (let di = 0; di < gapDateKeys.length; di++) {
                    const dt = gapDateKeys[di];
                    window.patchAuctionFieldBatch(dt, patchesByDate[dt]).catch(function(e) {
                        window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch 历史断点昨日成交量 ' + dt + ' ' + (e && e.message || e));
                    });
                }

                window.renderAuctionForm();
                window.renderAuction();

                window._dbgLog('[AUCTION-BTN] 历史断点昨日成交量 写入汇总 | 已写入股票=' + filledStocks +
                    ' | 已写入断点=' + filledGapDays +
                    ' | 无成交量数据股票=' + noDataStocks + '（断点日=' + noDataGapDays + '）' +
                    ' | 拉取失败=' + failedStocks +
                    ' | 非交易日跳过=' + nonTradingSkipTotal);

                const statusParts2 = ['✅ 补全完成：' + filledStocks + ' 只股票、' + filledGapDays + ' 个断点日昨日成交量已写入'];
                if (noDataStocks > 0) statusParts2.push(noDataStocks + ' 只断点日无成交量数据');
                if (failedStocks > 0) statusParts2.push(failedStocks + ' 只拉取失败');
                if (nonTradingSkipTotal > 0) statusParts2.push('跳过 ' + nonTradingSkipTotal + ' 个非交易日断点');
                window.setApiStatus('thsApiStatus', statusParts2.join('，') + '（影子记录，不影响任何日期的最近多板池）', true);
            } catch (err) {
                console.error('window.fillAuctionHistoryGapYestVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 猫抓：补全昨日竞价量（弹窗选择补全/覆盖） ----------
        export function fillYesterdayAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('补全昨日竞价量', function(overwrite) {
                window.fetchAuctionFromNumcat(btn, {
                    fillYesterday: true, fillToday: false,
                    overwriteYesterday: overwrite, overwriteToday: false
                });
            });
        }

        // ---------- 猫抓：获取当天竞价量（弹窗选择补全/覆盖） ----------
        export function fetchTodayAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('获取当天竞价量', function(overwrite) {
                window.fetchAuctionFromNumcat(btn, {
                    fillYesterday: false, fillToday: true,
                    overwriteYesterday: false, overwriteToday: overwrite
                });
            });
        }

        // ---------- 猫抓：全竞价量（弹窗选择补全/覆盖，两天统一） ----------
        export function fetchAllAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('全竞价量（昨日+今日）', function(overwrite) {
                window.fetchAuctionFromNumcat(btn, {
                    fillYesterday: true, fillToday: true,
                    overwriteYesterday: overwrite, overwriteToday: overwrite
                });
            });
        }

        // ---------- 猫抓：连抓三天补全（今日+昨日+前日，一次请求，纯补全不覆盖，不弹窗） ----------
        export function fetchThreeDaysAuctionFromNumcat(btn) {
            window.fetchAuctionFromNumcat(btn, {
                fillToday: true, fillYesterday: true, fillDayBefore: true,
                overwriteToday: false, overwriteYesterday: false, overwriteDayBefore: false
            });
        }

        // ---------- 猫抓：连抓五天补全（竞价量+成交量反推，一次请求，纯补全不覆盖） ----------
        export async function fetchFiveDaysAuctionFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const dates = [today];
                let d = today;
                for (let i = 0; i < 4; i++) {
                    d = window.getPreviousTradingDay(d);
                    if (!d) break;
                    dates.push(d);
                }
                if (dates.length < 2) {
                    window.setApiStatus('numcatApiStatus', '❌ 无法确定足够的历史交易日', false);
                    return;
                }
                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                let scMap = window._scMapCache || {};
                if (Object.keys(scMap).length === 0 && typeof window.loadCloudStockCodeMap === 'function') {
                    try { await window.loadCloudStockCodeMap(); } catch (e) {}
                    scMap = window._scMapCache || {};
                }
                const allCodesSet = new Set();
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) allCodesSet.add(code);
                });
                if (allCodesSet.size === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 没有可补全的股票（缺代码映射，请先导入代码映射）', false);
                    return;
                }
                const symbols = Array.from(allCodesSet).join(',');
                const startYMD = dates[dates.length - 1].replace(/-/g, '');
                const endYMD = dates[0].replace(/-/g, '');
                const params = { symbols: symbols, startdate: startYMD, enddate: endYMD };
                window.setApiStatus('numcatApiStatus', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，连抓' + dates.length + '天，竞价量+昨成交量+涨幅）...', true);
                const fields = 'symbol,name,tradedate,auc_vol,auc_to_pre_vol_pct';
                const result = await window.numcatApiPost('daily_auc', fields, params);
                const fieldList = result.fields || [];
                const items = result.items || [];
                const symbolIdx = fieldList.indexOf('symbol');
                const tradedateIdx = fieldList.indexOf('tradedate');
                const aucVolIdx = fieldList.indexOf('auc_vol');
                const ratioIdx = fieldList.indexOf('auc_to_pre_vol_pct');
                if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
                    return;
                }
                const aucByDate = {};
                items.forEach(function(row) {
                    const code = String(row[symbolIdx] || '').trim();
                    const tradedate = String(row[tradedateIdx] || '').trim();
                    const aucVol = row[aucVolIdx];
                    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;
                    if (!aucByDate[tradedate]) aucByDate[tradedate] = {};
                    const volNum = Number(aucVol);
                    const entry = { vol: isNaN(volNum) ? '' : String(Math.round(volNum / 100)) };
                    if (ratioIdx >= 0) {
                        const ratio = row[ratioIdx];
                        if (ratio !== null && ratio !== undefined && ratio !== '') {
                            const r = Number(ratio);
                            if (!isNaN(r) && r > 0 && volNum > 0) {
                                entry.yestVol = String(Math.round(volNum / r));
                            }
                        }
                    }
                    aucByDate[tradedate][code] = entry;
                });
                const dailyResult = await window.numcatApiPost('daily', 'symbol,tradedate,pct_chg', params);
                const dailyFieldList = dailyResult.fields || [];
                const dailyItems = dailyResult.items || [];
                const dSymbolIdx = dailyFieldList.indexOf('symbol');
                const dTradeIdx = dailyFieldList.indexOf('tradedate');
                const dPctIdx = dailyFieldList.indexOf('pct_chg');
                const pctByDate = {};
                if (dSymbolIdx >= 0 && dTradeIdx >= 0 && dPctIdx >= 0) {
                    dailyItems.forEach(function(row) {
                        const code = String(row[dSymbolIdx] || '').trim();
                        const tradedate = String(row[dTradeIdx] || '').trim();
                        const rawPct = row[dPctIdx];
                        if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
                        if (!pctByDate[tradedate]) pctByDate[tradedate] = {};
                        const n = Number(rawPct);
                        if (!isNaN(n)) pctByDate[tradedate][code] = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                    });
                }
                let filledVolCount = 0, filledYestVolCount = 0, filledPctCount = 0, skippedCount = 0;
                const patchesByDate = {};
                dates.forEach(function(dateStr) {
                    const ymd = dateStr.replace(/-/g, '');
                    const dayData = aucByDate[ymd] || {};
                    const dayPct = pctByDate[ymd] || {};
                    let dayList = (auctionData[dateStr] || []).slice();
                    const existingNames = {};
                    dayList.forEach(function(s) { if (s && s.stock) existingNames[s.stock.trim()] = true; });
                    todayList.forEach(function(s) {
                        if (s && s.stock && !existingNames[s.stock.trim()]) {
                            dayList.push(Object.assign({}, s, { volume: '', yestVolume: '', changePct: '' }));
                        }
                    });
                    const patches = [];
                    dayList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (!code || !dayData[code]) { skippedCount++; return; }
                        const entry = dayData[code];
                        let changed = false;
                        const patch = { stock: s.stock };
                        if (entry.vol && window.getNumericVolume(s.volume) === null) {
                            s.volume = entry.vol;
                            patch.volume = s.volume;
                            filledVolCount++;
                            changed = true;
                        }
                        if (entry.yestVol) {
                            s.yestVolume = entry.yestVol;
                            patch.yest_volume = s.yestVolume;
                            filledYestVolCount++;
                            changed = true;
                        }
                        if (dayPct[code] && !((s.changePct || '').trim())) {
                            s.changePct = dayPct[code];
                            s.note = window.buildNoteFromFields(s.changePct, s.topics);
                            patch.change_pct = s.changePct;
                            patch.note = s.note;
                            filledPctCount++;
                            changed = true;
                        }
                        if (changed) patches.push(patch);
                    });
                    auctionData[dateStr] = dayList;
                    if (patches.length > 0) patchesByDate[dateStr] = patches;
                });
                window.invalidateTopicCache();
                Object.keys(patchesByDate).forEach(function(dateStr) {
                    window.patchAuctionFieldBatch(dateStr, patchesByDate[dateStr]).catch(function(e) {
                        window._dbgLog('[AUCTION-ERR] patchAuctionFieldBatch ' + dateStr + ' ' + (e && e.message || e));
                    });
                });
                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();
                const patchCounts = dates.map(function(d) { return (patchesByDate[d] || []).length; });
                const resultText = '✅ 连抓' + dates.length + '天完成：竞价量+' + filledVolCount + ' / 昨成交量(反推)+' + filledYestVolCount + ' / 涨幅+' + filledPctCount +
                    '（各日只数：' + patchCounts.join('/') + '），跳过 ' + skippedCount + ' 只无数据';
                window.setApiStatus('numcatApiStatus', resultText, true);
            } catch (err) {
                console.error('fetchFiveDaysAuctionFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署';
                window.setApiStatus('numcatApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 猫抓：补全题材（开盘啦，只填 topics 为空的股票） ----------
        export async function fillTopicsFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                // 方案2：用 _auctionWatchlistIndex 判断正式成员，只对正式成员补全题材
                const _ftWset = window._getAuctionWatchlistSet(today);
                const todayList = (window.getAuctionData()[today] || []).filter(function(s) {
                    return s && s.stock && _ftWset.has(s.stock.trim()) && !((s.topics || '').trim());
                });

                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 没有需要补全题材的股票（所有股票已有题材）', false);
                    return;
                }

                // 收集股票代码
                let scMap = window._scMapCache || {};
                // [FIX] 代码映射为空时按需从云端重新拉取一次（同 fetchAuctionFromNumcat）
                if (Object.keys(scMap).length === 0 && typeof window.loadCloudStockCodeMap === 'function') {
                    try { await window.loadCloudStockCodeMap(); } catch (e) { window._dbgLog('[NUMCAT-FIX] fillTopics 按需加载代码映射失败: ' + (e && e.message)); }
                    scMap = window._scMapCache || {};
                }
                const codes = [];
                const codeToStock = {};
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) {
                        codes.push(code);
                        codeToStock[code] = s;
                    }
                });

                if (codes.length === 0) {
                    const hasAnyCode = todayList.some(function(s) { return (s.code || '').trim(); });
                    window.setApiStatus('numcatApiStatus', hasAnyCode
                        ? '❌ 没有可补全的股票（代码映射缺失，请先「设置-导入代码映射」或重新登录后重试）'
                        : '❌ 没有可补全的股票（缺少代码映射）', false);
                    return;
                }

                window.setApiStatus('numcatApiStatus', '正在请求猫抓接口补全题材（' + codes.length + ' 只股票）...', true);

                // 不传 tradedate，让接口默认查最新交易日（题材是股票属性，不依赖日期；
                // 传非交易日会返回"未找到选股数据"）
                const data = await window.numcatApiPost('screening',
                    'symbol,theme_names_kpl',
                    { symbols: codes.join(',') }
                );

                const fields = data.fields || [];
                const items = data.items || [];
                const symIdx = fields.indexOf('symbol');
                const themeIdx = fields.indexOf('theme_names_kpl');

                if (symIdx < 0 || themeIdx < 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
                    return;
                }

                let filledCount = 0;
                let skippedCount = 0;
                // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 topics 字段
                const topicsPatches = [];
                items.forEach(function(row) {
                    const code = String(row[symIdx] || '').trim();
                    const themeNames = String(row[themeIdx] || '').trim();
                    const stock = codeToStock[code];
                    if (!stock) return;
                    if (!themeNames) {
                        skippedCount++;
                        return;
                    }
                    // 全部保留题材，不再截断为前3个（一只股票可能同时属于多个题材分类）
                    // [BUG-FIX 2026-07-26] 过滤掉开盘啦返回的"题材35/题材36"等编号条目
                    const topicList = themeNames.split(/[，、,;；]/).map(function(t) { return t.trim(); }).filter(function(t) {
                        if (!t) return false;
                        if (/^题材\d+$/.test(t)) return false;   // 题材35 / 题材36
                        if (/^\d+$/.test(t)) return false;     // 纯数字
                        if (t.length < 2) return false;        // 单字符
                        return true;
                    });
                    if (topicList.length === 0) {
                        skippedCount++;
                        return;
                    }
                    const allTopicsStr = topicList.join('，');
                    stock.topics = allTopicsStr;
                    topicsPatches.push({ stock: stock.stock, topics: allTopicsStr });
                    // 同步推送到跨 tab 共享的 stock_topics 表（合并去重，不覆盖丢失旧题材）
                    const stockCode = (stock.code || scMap[stock.stock.trim()] || '').trim();
                    window.pushStockTopicsToCloud(stock.stock, topicList, stockCode).catch(function(e) {
                        console.warn('window.pushStockTopicsToCloud 失败（window.fillTopicsFromNumcat）:', stock.stock, e);
                    });
                    filledCount++;
                });

                // 没有返回数据的股票也算跳过
                skippedCount += (codes.length - filledCount - skippedCount);

                window.saveModule('auction');
                window.invalidateTopicCache();
                window.renderAuction();
                window.renderList();

                // 同步到云端（字段级 patch，不再走整段 pushAuctionDataToCloud）
                if (topicsPatches.length > 0) {
                    window.patchAuctionFieldBatch(today, topicsPatches).catch(function(e) {
                        window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch topics ' + (e && e.message || e));
                    });
                }

                window.setApiStatus('numcatApiStatus',
                    '✅ 补全 ' + filledCount + ' 只股票题材，跳过 ' + skippedCount + ' 只无数据或已有题材',
                    true);
            } catch (err) {
                console.error('window.fillTopicsFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 猫抓：查询交易监管（严重异常波动，最近 5 个交易日） ----------
        export async function fetchMonitorWarningFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                // 方案2：用 _auctionWatchlistIndex 判断正式成员，只查询正式成员的监管记录
                const _mwWset = window._getAuctionWatchlistSet(today);
                const fullList = (window.getAuctionData()[today] || []).filter(function(s) { return s && s.stock && _mwWset.has(s.stock.trim()); });

                if (fullList.length === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                // 收集股票代码
                const scMap = window._scMapCache || {};
                const codes = [];
                fullList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) codes.push(code);
                });

                if (codes.length === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 没有可查询的股票（缺少代码映射）', false);
                    return;
                }

                // 先清除所有股票的监管标记（重新查询）
                fullList.forEach(function(s) { delete s.monitorWarning; });

                window.setApiStatus('numcatApiStatus', '正在请求猫抓接口查询监管记录（' + codes.length + ' 只股票）...', true);

                // 查最近 5 个交易日
                const startdate = window.getNthPreviousTradingDay(today, 5).replace(/-/g, '');
                const enddate = today.replace(/-/g, '');

                const data = await window.numcatApiPost('point_monitor',
                    'type,symbol,name,startdate,enddate,reason',
                    {
                        symbols: codes.join(','),
                        type: '严重异常波动',
                        startdate: startdate,
                        enddate: enddate
                    },
                    '/reference-proxy/stock/point-monitor'
                );

                const fields = data.fields || [];
                const items = data.items || [];
                const symIdx = fields.indexOf('symbol');

                if (symIdx < 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
                    return;
                }

                // 构建有监管记录的股票代码集合
                const warningCodes = new Set();
                items.forEach(function(row) {
                    const code = String(row[symIdx] || '').trim();
                    if (code) warningCodes.add(code);
                });

                // 标记股票
                let markedCount = 0;
                fullList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && warningCodes.has(code)) {
                        s.monitorWarning = true;
                        markedCount++;
                    }
                });

                window.saveModule('auction');
                window.renderAuction();
                window.renderList();
                // 阶段四 Bug 5 收尾：monitorWarning 是纯内存字段（不在 auction_watchlist / market_metrics 的列里，
                // 也不在 AUCTION_PATCHABLE_FIELDS 白名单里），无需同步到云端。
                // 原本的 pushAuctionDataToCloud(today, ...) 会把整行（含 volume/yest_volume 等）
                // 一起带上，反而会覆盖云端其它字段，属于副作用大于收益的残留代码，直接删除。

                window.setApiStatus('numcatApiStatus',
                    '✅ 查询到 ' + markedCount + ' 只股票有严重异常波动（最近 5 个交易日）',
                    true);
            } catch (err) {
                console.error('window.fetchMonitorWarningFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ============================================================
        // 热门股票独立接口函数（与早盘竞价对应函数完全独立，互不影响）
        // 数据源：getHotAuctionData()（_hotAuctionData 内存对象）
        // 云端同步：pushHotStocksDataToCloud（全量 upsert）/ syncHotStocksListForDate（增删）
        // 渲染：renderHotForm / renderHotStocks（不调 renderList）
        // ============================================================

        // ---------- 同花顺（热门股票）：获取飙升榜+A股热股榜单 ----------
        // 根据 currentDate 与系统今天的对比，智能选择 API：
        //   - 今天或未来日期：调用飙升榜 + 热股榜（实时榜单）。
        //     未来日期用于提前建仓位：先用当前最新榜单预置，次日再次点击时
        //     会按股票名称做增量合并——已存在的股票保留原有 volume/yestVolume/
        //     note/changePct/选中状态等字段（视为"补全"），新出现的股票才是全新插入。
        //   - 历史日期：调用历史热股榜（hot-stock-list-history，不支持飙升榜）
        // 【竞态修复】与 fetchLadderConstituentsMain 同一类问题：函数体内有多个 await
        // （尤其历史榜单分支还要多等一次网络请求），且分支判断（isFutureDate/今天/历史）
        // 本身也依赖 currentDate——如果只在最后写入时锁一次日期，等待期间日期被切走后，
        // 会出现"按切换前的日期分支去请求了接口，却因为分支判断本身没锁，产生分支与
        // 写入目标不一致"的更隐蔽错乱。所以这里在函数最开头、任何 currentDate 相关判断
        // 之前就立即锁存 targetDate，后续分支判断、接口参数、状态文案、数据读写、
        // 云端同步全部统一使用 targetDate，不再读取执行期间可能变化的全局 currentDate。
        export async function fetchSkyrocketHotStocksMain(btn) {
            window.setBtnLoading(btn, true);
            // 锁定"点击那一刻"的日期，全程只认这一个值，杜绝异步等待期间日期漂移
            const targetDate = state.currentDate;
            try {
                // 获取系统今天（Asia/Shanghai 时区，yyyy-MM-dd 格式）
                const now = new Date();
                const sysYear = now.getFullYear();
                const sysMonth = String(now.getMonth() + 1).padStart(2, '0');
                const sysDay = String(now.getDate()).padStart(2, '0');
                const sysToday = `${sysYear}-${sysMonth}-${sysDay}`;

                let constituents = [];
                let statusMsg = '';

                const isFutureDate = targetDate > sysToday;

                if (targetDate >= sysToday) {
                    // 今天：实时榜单即为当日数据；未来日期：用实时榜单预置仓位，等次日刷新覆盖
                    window.setApiStatus('thsApiStatusHot',
                        isFutureDate
                            ? '正在请求同花顺飙升榜 + A股热股榜单（预置到 ' + targetDate + '）...'
                            : '正在请求同花顺飙升榜 + A股热股榜单...',
                        true);
                    const [skyrocketData, hotStockData] = await Promise.all([
                        window.fuyaoApiGet('/api/a-share/special-data/skyrocket-list', { period: 'day' }),
                        window.fuyaoApiGet('/api/a-share/special-data/hot-stock-list', { period: 'day' })
                    ]);

                    const skyrocketItems = (skyrocketData && skyrocketData.item) || [];
                    const hotStockItems = (hotStockData && hotStockData.item) || [];

                    // 按 thscode 去重合并（飙升榜优先，热股榜补充）
                    const mergedMap = {};
                    skyrocketItems.forEach(function(c) {
                        if (c && c.thscode && !mergedMap[c.thscode]) mergedMap[c.thscode] = c;
                    });
                    hotStockItems.forEach(function(c) {
                        if (c && c.thscode && !mergedMap[c.thscode]) mergedMap[c.thscode] = c;
                    });
                    constituents = Object.values(mergedMap);

                    if (constituents.length === 0) {
                        window.setApiStatus('thsApiStatusHot', '飙升榜和热股榜单当前无数据', false);
                        return;
                    }
                    statusMsg = isFutureDate
                        ? ('✅ 已为 ' + targetDate + ' 预置 ' + constituents.length + ' 只股票（飙升榜 ' + skyrocketItems.length + ' + 热股榜 ' + hotStockItems.length + '，去重后 ' + constituents.length + '，明日刷新将增量合并覆盖）')
                        : ('✅ 已获取 ' + constituents.length + ' 只股票（飙升榜 ' + skyrocketItems.length + ' + 热股榜 ' + hotStockItems.length + '，去重后 ' + constituents.length + '）');
                } else {
                    // 历史日期：调用历史热股榜（hot-stock-list-history?date=targetDate）
                    window.setApiStatus('thsApiStatusHot', '正在请求历史热股榜单（' + targetDate + '）...', true);
                    const historyData = await window.fuyaoApiGet('/api/a-share/special-data/hot-stock-list-history', { date: targetDate });
                    const historyItems = (historyData && historyData.item) || [];

                    // 历史热股榜字段与实时热股榜一致（thscode/ticker/name/rank）
                    const mergedMap = {};
                    historyItems.forEach(function(c) {
                        if (c && c.thscode && !mergedMap[c.thscode]) mergedMap[c.thscode] = c;
                    });
                    constituents = Object.values(mergedMap);

                    if (constituents.length === 0) {
                        window.setApiStatus('thsApiStatusHot', '历史热股榜单（' + targetDate + '）无数据', false);
                        return;
                    }
                    statusMsg = '✅ 已获取 ' + constituents.length + ' 只股票（历史热股榜，不支持飙升榜）';
                }

                window._dbgLog('[HOT-SKYROCKET] targetDate=' + targetDate + ' 原始股票数=' + constituents.length);

                // 备份当日数据（用于撤回）—— 按锁存的 targetDate 备份，而非可能已变化的当前日期
                window.backupHotStocksData('import', targetDate);

                const hotAuctionData = window.getHotAuctionData();
                const existingList = hotAuctionData[targetDate] || [];
                const existingMap = {};
                existingList.forEach(function(s) {
                    if (s && s.stock) existingMap[s.stock.trim()] = s;
                });

                // 合并：新榜单列表为准，保留已有股票的备注/状态/行情
                const newList = constituents.map(function(c) {
                    const name = (c.name || '').trim();
                    const existing = existingMap[name];
                    const code = window.extractCodeFromFuyaoItem(c) || (existing ? (existing.code || '') : '');
                    return {
                        stock: name,
                        code: code,
                        volume: existing ? (existing.volume || '') : '',
                        yestVolume: existing ? (existing.yestVolume || '') : '',
                        note: existing ? (existing.note || '') : '',
                        changePct: existing ? (existing.changePct || '') : '',
                        topics: existing ? (existing.topics || '') : '',
                        selected: existing ? existing.selected : false,
                        bought: existing ? existing.bought : false,
                        sold: existing ? existing.sold : false,
                        fixed: existing ? existing.fixed : false
                    };
                });

                const withCodeCount = newList.filter(function(s) { return s && s.code; }).length;

                // 更新 stockcodemap（name → code，云端唯一真相源）
                const scMap = window._scMapCache || {};
                let mapUpdated = false;
                const scPairs = [];
                constituents.forEach(function(c) {
                    const name = (c.name || '').trim();
                    const code = window.extractCodeFromFuyaoItem(c);
                    if (name && code && scMap[name] !== code) {
                        scMap[name] = code;
                        scPairs.push({ stock: name, code: code });
                        mapUpdated = true;
                    }
                });
                window._dbgLog('[HOT-SKYROCKET] 合并后 newList=' + newList.length + ' 有代码=' + withCodeCount + ' stockcodemap更新=' + mapUpdated);
                if (mapUpdated) {
                    window.upsertStockCodeMap(scPairs).catch(function(e) { window._dbgLog('[AUCTION-ERR] HOT-SKYROCKET window.upsertStockCodeMap ' + (e && e.message || e)); });
                }

                window._dbgLog('[HOT-SKYROCKET] 写入 hotAuctionData[' + targetDate + '] 行数=' + newList.length + ' 有代码=' + withCodeCount);
                hotAuctionData[targetDate] = newList;
                window.invalidateTopicCache();

                // 同步到云端 hot_stocks 表（处理增删 + 新股票的完整字段插入）—— 按 targetDate
                window.syncHotStocksListForDate(targetDate).catch(function(e) {
                    console.warn('window.syncHotStocksListForDate 失败:', e);
                });

                // 刷新表单和看板：只有当"接口返回时页面仍停留在 targetDate"才刷新当前视图，
                // 避免用刚写入的这批数据去刷新界面上正显示的另一天，造成日期混淆。
                if (state.currentDate === targetDate) {
                    window.renderHotForm();
                    window.renderHotStocks();
                    window.setApiStatus('thsApiStatusHot', statusMsg, true);
                } else {
                    window.setApiStatus('thsApiStatusHot', statusMsg + '（写入 ' + targetDate + '，当前页面在 ' + state.currentDate + '，切回该日期即可看到）', true);
                }
            } catch (err) {
                console.error('window.fetchSkyrocketHotStocksMain 失败:', err);
                let msg = err && err.message ? err.message : '拉取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：昨日涨停连板 ----------
        // 以当前选中日期 targetDate 为基准，取 "昨日"（上一个交易日）的涨停股票池，
        // 过滤掉 ST 股票，保留所有非 ST 涨停股（含首板与连板），写入 targetDate 的热门股票列表。
        // 当天/历史日期统一逻辑：昨日 = getPreviousTradingDay(targetDate)。
        export async function fetchHotLimitUpLadderFromThs(btn) {
            // 锁定"点击那一刻"的日期，杜绝异步等待期间日期漂移导致写入目标错乱
            const targetDate = state.currentDate;
            const sysToday = window._getLocalTodayStr();
            window.setBtnLoading(btn, true);
            try {
                const fetchDate = window.getPreviousTradingDay(targetDate);
                if (!fetchDate) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定 ' + targetDate + ' 的上一交易日', false);
                    return;
                }

                window._dbgLog('[LADDER] targetDate=' + targetDate + ' fetchDate=' + fetchDate);

                const isFutureDate = targetDate > sysToday;
                window.setApiStatus('thsApiStatusHot',
                    (isFutureDate
                        ? '正在请求 ' + fetchDate + ' 的昨日涨停连板数据（预置到 ' + targetDate + '）...'
                        : '正在请求 ' + fetchDate + ' 的昨日涨停连板数据...'),
                    true);

                // date_ms 用 Asia/Shanghai 00:00:00 的毫秒戳
                const dateMs = new Date(fetchDate + 'T00:00:00+08:00').getTime();

                const data = await window.fuyaoApiGet('/api/a-share/special-data/limit-up-pool', {
                    date_ms: dateMs,
                    page: 1,
                    size: 200,
                    sort_field: 'limit_up_time',
                    sort_dir: 'desc'
                });
                const items = (data && data.item) || [];

                window._dbgLog('[LADDER] ' + fetchDate + ' 涨停池总数: ' + items.length);

                // 仅排除 ST 股票；保留首板、连板、新股等其它所有涨停股
                const constituents = items.filter(function(c) {
                    return c && c.thscode && c.is_st !== true;
                });

                const stCount = items.length - constituents.length;
                window._dbgLog('[LADDER] 过滤后保留 ' + constituents.length + ' 只，排除 ST ' + stCount + ' 只');

                if (constituents.length === 0) {
                    window.setApiStatus('thsApiStatusHot', fetchDate + ' 暂无非ST涨停数据', false);
                    return;
                }

                // 备份当日数据（按 targetDate）
                window.backupHotStocksData('import', targetDate);

                const hotAuctionData = window.getHotAuctionData();
                const existingList = hotAuctionData[targetDate] || [];
                const existingMap = {};
                existingList.forEach(function(s) {
                    if (s && s.stock) existingMap[s.stock.trim()] = s;
                });

                const missingCodeNames = [];
                const newList = constituents.map(function(c) {
                    const name = (c.name || '').trim();
                    const existing = existingMap[name];
                    const code = window.extractCodeFromFuyaoItem(c) || (existing ? (existing.code || '') : '');
                    if (!code && name) missingCodeNames.push(name);

                    // 涨幅：已乘 100，格式化为 +/-X.YY%
                    let changePct = '';
                    const pctVal = c.price_change_ratio_pct;
                    if (pctVal !== null && pctVal !== undefined && pctVal !== '') {
                        const n = Number(pctVal);
                        if (!isNaN(n)) {
                            changePct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                        }
                    }

                    // 题材：用涨停原因，并过滤无意义编号（API 可能返回 null/undefined/空字符串）
                    const rawTopics = (c.limit_up_reason && c.limit_up_reason !== 'null') ? String(c.limit_up_reason).trim() : '';
                    const topics = window.cleanTopicsForDisplay(rawTopics);
                    const note = window.buildNoteFromFields(changePct, topics);

                    return {
                        stock: name,
                        code: code,
                        volume: existing ? (existing.volume || '') : '',
                        yestVolume: existing ? (existing.yestVolume || '') : '',
                        note: note,
                        changePct: changePct,
                        topics: topics,
                        selected: existing ? existing.selected : false,
                        bought: existing ? existing.bought : false,
                        sold: existing ? existing.sold : false,
                        fixed: existing ? existing.fixed : false
                    };
                });

                if (missingCodeNames.length > 0) {
                    window._dbgLog('[LADDER] 以下股票无法提取代码: ' + missingCodeNames.join(','));
                }

                // 更新共享代码映射（云端 stockcodemap 唯一真相源）
                const scMap = window._scMapCache || {};
                let mapUpdated = false;
                const scPairs = [];
                constituents.forEach(function(c) {
                    const name = (c.name || '').trim();
                    const code = window.extractCodeFromFuyaoItem(c);
                    if (name && code && scMap[name] !== code) {
                        scMap[name] = code;
                        scPairs.push({ stock: name, code: code });
                        mapUpdated = true;
                    }
                });
                const withCodeCount2 = newList.filter(function(s) { return s && s.code; }).length;
                window._dbgLog('[LADDER] 合并后 newList=' + newList.length + ' 有代码=' + withCodeCount2 + ' stockcodemap更新=' + mapUpdated);
                if (mapUpdated) {
                    window.upsertStockCodeMap(scPairs).catch(function(e) { window._dbgLog('[AUCTION-ERR] LADDER window.upsertStockCodeMap ' + (e && e.message || e)); });
                }

                window._dbgLog('[LADDER] 写入 hotAuctionData[' + targetDate + '] 行数=' + newList.length + ' 有代码=' + withCodeCount2);
                hotAuctionData[targetDate] = newList;
                window.invalidateTopicCache();

                // 同步云端 hot_stocks 表（先同步列表结构，再推送涨幅/题材字段，确保已有股票也能更新）
                window.syncHotStocksListForDate(targetDate).then(function() {
                    return window.pushHotStocksDataToCloud(targetDate, newList);
                }).catch(function(e) {
                    console.warn('昨日涨停连板云端同步失败:', e);
                });

                const statusMsg = '✅ 已获取 ' + fetchDate + ' 的 ' + constituents.length + ' 只昨日涨停连板股票';
                if (state.currentDate === targetDate) {
                    window.renderHotForm();
                    window.renderHotStocks();
                    window.setApiStatus('thsApiStatusHot', statusMsg + (isFutureDate ? '（已预置到 ' + targetDate + '）' : ''), true);
                } else {
                    window.setApiStatus('thsApiStatusHot', statusMsg + '（写入 ' + targetDate + '，当前页面在 ' + state.currentDate + '，切回该日期即可看到）', true);
                }
            } catch (err) {
                console.error('window.fetchHotLimitUpLadderFromThs 失败:', err);
                let msg = err && err.message ? err.message : '拉取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：两全昨日成交量 ----------
        export async function fillHotYesterdayVolumeFromThs(btn) {
            window.setBtnLoading(btn, true);
            window._openHotAuctionShield(); // [BUG-FIX] 入口立即开 shield，覆盖 await window.fetchDayVolumes 期间的竞态窗口
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                if (!yesterday || !dayBefore) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定前两个交易日', false);
                    return;
                }

                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // yesterdayList 始终基于 todayList（当前显示的表格），保留 hotAuctionData[yesterday] 原有同名股票的业务字段
                const yesterdayList = window.buildYesterdayListFromToday(todayList, hotAuctionData, yesterday);
                const yesterdayListWasEmpty = (hotAuctionData[yesterday] || []).length === 0;
                const scMap = window._scMapCache || {};

                // [BUG-FIX] 收集所有云端写入Promise，统一await并收集错误
                const _cloudTasks = [];
                const _cloudErrors = [];
                function _safePatch(date, patches, label) {
                    if (patches.length === 0) return;
                    _cloudTasks.push(
                        window.patchHotFieldBatch(date, patches).then(function(res) {
                            if (res && res.ok === false) _cloudErrors.push(label + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                        }).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); })
                    );
                }
                window._safePatch = _safePatch;
                function _safeTrends(date, list, label) {
                    if (!list || list.length === 0) return;
                    _cloudTasks.push(window.pushHotTrendsToCloud(date, list).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); }));
                }
                window._safeTrends = _safeTrends;

                // [BUG-FIX/恢复] 从云端全量快照缓存恢复缺失的 code，避免保存/同步后内存 code 丢失。
                const recoverCodesFromCache = function(list, dateKey) {
                    const cacheList = window._hotFullRowCache[dateKey] || [];
                    const cacheMap = {};
                    cacheList.forEach(function(r) { if (r && r.stock) cacheMap[r.stock.trim()] = r; });
                    const patches = [];
                    list.forEach(function(s) {
                        if (!s || !s.stock || (s.code || '').trim()) return;
                        const cached = cacheMap[s.stock.trim()];
                        if (cached && (cached.code || '').trim()) {
                            s.code = cached.code.trim();
                            patches.push({ stock: s.stock, code: s.code });
                        }
                    });
                    return patches;
                };
                const todayRecovered = recoverCodesFromCache(todayList, today);
                const yesterdayRecovered = recoverCodesFromCache(yesterdayList, yesterday);
                if (todayRecovered.length > 0 || yesterdayRecovered.length > 0) {
                    console.log('[HotBothYestVol] 从缓存恢复 code: 今日' + todayRecovered.length + ' 对比日' + yesterdayRecovered.length);
                }

                // 收集需要查询的股票代码（today + yesterday 合并去重）
                const codeToName = {}; // ticker -> name
                const collectCodes = function(list) {
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (code) codeToName[code] = s.stock.trim();
                    });
                };
                collectCodes(todayList);
                collectCodes(yesterdayList);

                const allCodes = Object.keys(codeToName);
                if (allCodes.length === 0) {
                    console.log('[HotBothYestVol] 无可用代码：todayList=' + todayList.length + ' yesterdayList=' + yesterdayList.length + ' stockcodemap=' + Object.keys(scMap).length);
                    window.setApiStatus('thsApiStatusHot', '❌ 没有可补全的股票（缺少代码映射，请先通过「昨日涨停连板」「获取飙升+热股」导入股票，或导入代码映射）', false);
                    return;
                }

                // ===== 分两批调用 fuyao historical（每批用单天时间窗口，避免跨天窗口只返回最新一根 K 线）=====
                let todayFilled = 0, todaySkipped = 0;
                let yesterdayFilled = 0, yesterdaySkipped = 0;
                // 字段级 PATCH 改造：只上报本次真正改动的 yest_volume 字段
                const todayYestVolPatches = [];
                const yesterdayYestVolPatches = [];
                const todayCodePatches = todayRecovered.slice(); // [BUG-FIX] 把 scMap/缓存恢复的 code 写回 hot_stocks
                const yesterdayCodePatches = yesterdayRecovered.slice();

                // ===== 第一批：调取当日的昨日成交量（today.yestVolume ← yesterday 的 volume）=====
                window.setApiStatus('thsApiStatusHot', '【1/2】正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
                const volYesterday = await window.fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)
                console.log('[HotBothYestVol] 第一批 window.fetchDayVolumes(' + yesterday + ') 返回 ' + Object.keys(volYesterday).length + '/' + allCodes.length + ' 只有值');

                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = (scMap[name] || '').trim();
                    // 先回填 code（即使 yestVolume 已有也要回填）
                    if (!s.code && mappedCode) {
                        s.code = mappedCode;
                        todayCodePatches.push({ stock: name, code: mappedCode });
                    }
                    const code = (s.code || mappedCode || '').trim();
                    if (!code) { todaySkipped++; return; }
                    if (window.getNumericVolume(s.yestVolume) !== null) return; // 已有值，跳过
                    if (volYesterday[code] != null) {
                        s.yestVolume = String(Math.round(volYesterday[code] / 10000));
                        todayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        todayFilled++;
                    } else {
                        todaySkipped++;
                    }
                });
                hotAuctionData[today] = todayList;
                window._safePatch(today, todayCodePatches, '今日code');
                window._safePatch(today, todayYestVolPatches, '今日yest_volume');
                // [BUG-FIX] 只推送有 yestVolume 的股票到 hot_stock_trends，避免空 volume/change_pct 覆盖已有值
                var _trendsToday = todayList.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(today, _trendsToday, '今日趋势');

                // ===== 第二批：调取对比日的昨日成交量（yesterday.yestVolume ← dayBefore 的 volume）=====
                window.setApiStatus('thsApiStatusHot', '【2/2】正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
                const volDayBefore = await window.fetchDayVolumes(allCodes, dayBefore);
                console.log('[HotBothYestVol] 第二批 window.fetchDayVolumes(' + dayBefore + ') 返回 ' + Object.keys(volDayBefore).length + '/' + allCodes.length + ' 只有值');

                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = (scMap[name] || '').trim();
                    // 先回填 code（即使 yestVolume 已有也要回填）
                    if (!s.code && mappedCode) {
                        s.code = mappedCode;
                        yesterdayCodePatches.push({ stock: name, code: mappedCode });
                    }
                    const code = (s.code || mappedCode || '').trim();
                    if (!code) { yesterdaySkipped++; return; }
                    if (window.getNumericVolume(s.yestVolume) !== null) return;
                    if (volDayBefore[code] != null) {
                        s.yestVolume = String(Math.round(volDayBefore[code] / 10000));
                        // 正式列表成员 + 影子记录统一进 patch（影子记录 upsert 时 in_watchlist 默认 false，
                        // 仅供趋势图查询，正是预期行为）
                        yesterdayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        yesterdayFilled++;
                    } else {
                        yesterdaySkipped++;
                    }
                });
                // 关键修复：不能再用 buildYesterdayListFromToday 造出来的 yesterdayList（以 todayList 名单为模板）
                // 直接覆盖 hotAuctionData[yesterday] —— 这会把本地内存里"对比日原有、但这次名单里没有的股票"
                // 整个丢掉，而后续只要触发一次 syncHotStocksListForDate(yesterday)（脏日期同步），
                // 就会把云端那些"本地没有"的股票行标记 in_watchlist=false，导致对比日 tap 页面第一页
                // 原有股票被静默移除。正确做法：只把补全的 yestVolume 合并回"对比日原本就存在的股票"，
                // 对比日原本没有的股票（影子行）不写回正式列表，只单独推送并标记 in_watchlist=false。
                const existingYesterdayList = (hotAuctionData[yesterday] || []).slice();
                const existingYesterdayNames = {};
                existingYesterdayList.forEach(function(s) {
                    if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                });
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    if (!existingYesterdayNames[name]) return;
                    const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                    if (target) target.yestVolume = s.yestVolume;
                });
                const shadowOnlyYesterdayStocks = yesterdayList.filter(function(s) {
                    return s && s.stock && !existingYesterdayNames[s.stock.trim()];
                });

                hotAuctionData[yesterday] = existingYesterdayList; // 正式列表：只含对比日原有股票，数量不变
                window.invalidateTopicCache();
                window._safePatch(yesterday, yesterdayCodePatches, '昨日code');
                window._safePatch(yesterday, yesterdayYestVolPatches, '昨日yest_volume');
                // [BUG-FIX] 只推送有 yestVolume 的股票到 hot_stock_trends，避免空 volume/change_pct 覆盖已有值
                var _trendsYest = existingYesterdayList.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(yesterday, _trendsYest, '昨日趋势');
                var _trendsShadow = shadowOnlyYesterdayStocks.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(yesterday, _trendsShadow, '昨日趋势(影子)');

                // [BUG-FIX] 等待所有云端写入完成
                window.setApiStatus('thsApiStatusHot', '正在同步到云端...', true);
                await Promise.all(_cloudTasks);

                // 刷新表单和看板
                window.renderHotForm();
                window.renderHotStocks();

                const todayTotal = todayList.length;
                const yesterdayTotal = yesterdayList.length;
                const yesterdaySource = yesterdayListWasEmpty
                    ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                    : '';
                let _statusMsg = '✅ 今日填 ' + todayFilled + '/' + todayTotal + '，对比日填 ' + yesterdayFilled + '/' + yesterdayTotal + yesterdaySource +
                    '；跳过 今日' + todaySkipped + ' / 对比日' + yesterdaySkipped + '（无数据或缺代码）';
                if (_cloudErrors.length > 0) {
                    _statusMsg += ' ⚠️ 云端写入失败：' + _cloudErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', _statusMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', _statusMsg, true);
                }
            } catch (err) {
                console.error('window.fillHotYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window._closeHotAuctionShield(); // [BUG-FIX] 对应入口的 window._openHotAuctionShield
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：当天昨日成交量（单独调 yesterday 单天，只填 today.yestVolume） ----------
        export function fillHotTodayYesterdayVolumeFromThs(btn) {
            window.showNumcatChoiceModal('当天昨日成交量模式（热门股票）', function(overwrite) {
                window._fillHotTodayYesterdayVolumeFromThsImpl(btn, overwrite);
            });
        }

        export async function _fillHotTodayYesterdayVolumeFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            window._openHotAuctionShield(); // [BUG-FIX] 入口立即开 shield，覆盖 await window.fetchDayVolumes 期间的竞态窗口
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                if (!yesterday) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定上一交易日', false);
                    return;
                }
                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先通过「昨日涨停连板」或「获取飙升+热股」导入股票', false);
                    return;
                }
                const scMap = window._scMapCache || {};

                // [BUG-FIX] 收集所有云端写入Promise，统一await并收集错误
                const _cloudTasks = [];
                const _cloudErrors = [];
                function _safePatch(date, patches, label) {
                    if (patches.length === 0) return;
                    _cloudTasks.push(
                        window.patchHotFieldBatch(date, patches).then(function(res) {
                            if (res && res.ok === false) _cloudErrors.push(label + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                        }).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); })
                    );
                }
                window._safePatch = _safePatch;
                function _safeTrends(date, list, label) {
                    if (!list || list.length === 0) return;
                    _cloudTasks.push(window.pushHotTrendsToCloud(date, list).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); }));
                }
                window._safeTrends = _safeTrends;

                // [BUG-FIX/恢复] 若内存行缺 code，优先从本地全量快照缓存(_hotFullRowCache)找回，
                // 这样即使之前保存/同步把内存 code 冲掉，仍能从云端快照恢复，避免"没有可补全的股票"。
                const cacheList = window._hotFullRowCache[today] || [];
                const cacheMap = {};
                cacheList.forEach(function(r) { if (r && r.stock) cacheMap[r.stock.trim()] = r; });
                const recoveredCodePatches = [];
                todayList.forEach(function(s) {
                    if (!s || !s.stock || (s.code || '').trim()) return;
                    const cached = cacheMap[s.stock.trim()];
                    if (cached && (cached.code || '').trim()) {
                        s.code = cached.code.trim();
                        recoveredCodePatches.push({ stock: s.stock, code: s.code });
                    }
                });
                if (recoveredCodePatches.length > 0) {
                    console.log('[HotTodayYestVol] 从 window._hotFullRowCache 恢复 code: ' + recoveredCodePatches.map(function(p) { return p.stock + '=' + p.code; }).join(', '));
                }

                const codeToName = {};
                const _noCodeStocks = []; // 调试：记录缺代码映射的股票
                let _codeFromRow = 0, _codeFromMap = 0, _codeFromCache = recoveredCodePatches.length;
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const rowCode = (s.code || '').trim();
                    const mapCode = (scMap[s.stock.trim()] || '').trim();
                    const code = rowCode || mapCode;
                    if (code) {
                        codeToName[code] = s.stock.trim();
                        if (rowCode) _codeFromRow++;
                        else _codeFromMap++;
                    } else {
                        _noCodeStocks.push(s.stock.trim());
                    }
                });
                const allCodes = Object.keys(codeToName);
                // [增强调试] 预检：到底有多少只股票真正需要补 yestVolume
                const _needYest = todayList.filter(function(s) {
                    return s && s.stock && (overwrite || window.getNumericVolume(s.yestVolume) === null);
                });
                if (_needYest.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '✅ 今日列表 ' + todayList.length + ' 只股票的昨日成交量均已存在（非覆盖模式无需补全）', true);
                    return;
                }
                if (allCodes.length === 0) {
                    console.log('[HotTodayYestVol] 无可用代码：todayList=' + todayList.length +
                        ' 需补yest=' + _needYest.length + ' stockcodemap=' + Object.keys(scMap).length +
                        ' 无代码股票=' + _noCodeStocks.join(','));
                    window.setApiStatus('thsApiStatusHot',
                        '❌ 没有可补全的股票：' + _needYest.length + ' 只缺昨日成交量，但全部 ' + todayList.length +
                        ' 只都没有代码映射（' + _noCodeStocks.slice(0, 5).join('、') +
                        (_noCodeStocks.length > 5 ? ' 等' : '') +
                        '）。请先用「猫抓连抓三天补全」或「导入代码映射」获取代码',
                        false);
                    return;
                }
                console.log('[HotTodayYestVol] 开始 today=' + today + ' yesterday=' + yesterday + ' mode=' + (overwrite ? '覆盖' : '补全') +
                    ' todayList=' + todayList.length + ' 需补yest=' + _needYest.length +
                    ' 有代码=' + allCodes.length +
                    ' (行内=' + _codeFromRow + ' 映射=' + _codeFromMap + ' 缓存恢复=' + _codeFromCache + ')' +
                    ' 无代码=' + _noCodeStocks.length + (_noCodeStocks.length > 0 ? ' 无代码股票=' + _noCodeStocks.join(',') : ''));

                window.setApiStatus('thsApiStatusHot', '正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
                const volYesterday = await window.fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)
                console.log('[HotTodayYestVol] window.fetchDayVolumes 返回 ' + Object.keys(volYesterday).length + '/' + allCodes.length + ' 只有值，yesterday=' + yesterday);

                let filled = 0, skipped = 0;
                const _skipReasons = { noCode: 0, noVol: 0, alreadyHas: 0 };
                const todayYestVolPatches = [];
                const codePatches = recoveredCodePatches.slice(); // [BUG-FIX] 把 scMap/缓存恢复的 code 写回 hot_stocks，避免下次依赖映射
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = (scMap[name] || '').trim();
                    // 内存里没有 code 但映射里有：先回填到行里并准备上报（即使 yestVolume 已有也要回填）
                    if (!s.code && mappedCode) {
                        s.code = mappedCode;
                        codePatches.push({ stock: name, code: mappedCode });
                    }
                    if (!overwrite && window.getNumericVolume(s.yestVolume) !== null) { _skipReasons.alreadyHas++; return; } // 补全模式跳过已有值
                    const code = (s.code || mappedCode || '').trim();
                    if (!code) { _skipReasons.noCode++; skipped++; return; }
                    if (volYesterday[code] != null) {
                        s.yestVolume = String(Math.round(volYesterday[code] / 10000));
                        todayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        filled++;
                    } else {
                        _skipReasons.noVol++;
                        skipped++;
                    }
                });
                console.log('[HotTodayYestVol] 填充结果: filled=' + filled + ' skipped=' + skipped + ' (无代码=' + _skipReasons.noCode + ' 无量=' + _skipReasons.noVol + ' 已有值=' + _skipReasons.alreadyHas + ') yestPatches=' + todayYestVolPatches.length + ' codePatches=' + codePatches.length);
                if (todayYestVolPatches.length > 0) {
                    console.log('[HotTodayYestVol] patches详情: ' + todayYestVolPatches.map(function(p) { return p.stock + '=' + p.yest_volume; }).join(', '));
                }
                hotAuctionData[today] = todayList;
                window.invalidateTopicCache();
                window._safePatch(today, codePatches, '今日code');
                window._safePatch(today, todayYestVolPatches, '今日yest_volume');
                // [BUG-FIX] 只推送有 yestVolume 的股票到 hot_stock_trends，避免空 volume/change_pct 覆盖已有值
                var _trendsItems = todayList.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(today, _trendsItems, '今日趋势');

                // 调试：验证 _hotFullRowCache 是否已更新
                if (todayYestVolPatches.length > 0) {
                    var _cacheList = window._hotFullRowCache[today] || [];
                    var _cacheMap = {};
                    _cacheList.forEach(function(r) { if (r && r.stock) _cacheMap[r.stock.trim()] = r; });
                    var _verifyLog = [];
                    todayYestVolPatches.forEach(function(p) {
                        var name = (p.stock || '').trim();
                        var cached = _cacheMap[name];
                        var trendVal = window.getStockHistoryValue(today, name, 'yestVolume', 'hot');
                        _verifyLog.push(name + ': cache.yest_volume=' + (cached ? (cached.yest_volume || cached.yestVolume || '(空)') : '(无行)') + ' trendVal=' + (trendVal !== null ? trendVal : 'null'));
                    });
                    console.log('[HotTodayYestVol] 缓存验证(' + _verifyLog.length + '只):\n' + _verifyLog.join('\n'));
                }

                // [BUG-FIX] 等待所有云端写入完成
                window.setApiStatus('thsApiStatusHot', '正在同步到云端...', true);
                await Promise.all(_cloudTasks);

                window.renderHotForm();
                window.renderHotStocks();

                let _statusMsg = '✅ ' + (overwrite ? '覆盖' : '补全') + ' 当天昨日成交量 ' + filled + '/' + todayList.length + '，跳过 ' + skipped + '（无数据或缺代码）';
                if (_cloudErrors.length > 0) {
                    _statusMsg += ' ⚠️ 云端写入失败：' + _cloudErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', _statusMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', _statusMsg, true);
                }
            } catch (err) {
                console.error('window.fillHotTodayYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window._closeHotAuctionShield(); // [BUG-FIX] 对应入口的 window._openHotAuctionShield
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：对比日昨成交量（单独调 dayBefore 单天，只填 yesterday.yestVolume） ----------
        export function fillHotYesterdayYesterdayVolumeFromThs(btn) {
            window.showNumcatChoiceModal('对比日昨成交量模式（热门股票）', function(overwrite) {
                window._fillHotYesterdayYesterdayVolumeFromThsImpl(btn, overwrite);
            });
        }

        export async function _fillHotYesterdayYesterdayVolumeFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            window._openHotAuctionShield(); // [BUG-FIX] 入口立即开 shield，覆盖 await window.fetchDayVolumes 期间的竞态窗口
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                if (!yesterday || !dayBefore) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定前两个交易日', false);
                    return;
                }
                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // yesterdayList 始终基于 todayList（当前显示的表格），保留 hotAuctionData[yesterday] 原有同名股票的业务字段
                const yesterdayList = window.buildYesterdayListFromToday(todayList, hotAuctionData, yesterday);
                const yesterdayListWasEmpty = (hotAuctionData[yesterday] || []).length === 0;
                const scMap = window._scMapCache || {};

                // [BUG-FIX] 收集所有云端写入Promise，统一await并收集错误
                const _cloudTasks = [];
                const _cloudErrors = [];
                function _safePatch(date, patches, label) {
                    if (patches.length === 0) return;
                    _cloudTasks.push(
                        window.patchHotFieldBatch(date, patches).then(function(res) {
                            if (res && res.ok === false) _cloudErrors.push(label + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                        }).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); })
                    );
                }
                window._safePatch = _safePatch;
                function _safeTrends(date, list, label) {
                    if (!list || list.length === 0) return;
                    _cloudTasks.push(window.pushHotTrendsToCloud(date, list).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); }));
                }
                window._safeTrends = _safeTrends;

                // [BUG-FIX/恢复] 从云端全量快照缓存恢复缺失的 code。
                const cacheList = window._hotFullRowCache[yesterday] || [];
                const cacheMap = {};
                cacheList.forEach(function(r) { if (r && r.stock) cacheMap[r.stock.trim()] = r; });
                const recoveredCodePatches = [];
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock || (s.code || '').trim()) return;
                    const cached = cacheMap[s.stock.trim()];
                    if (cached && (cached.code || '').trim()) {
                        s.code = cached.code.trim();
                        recoveredCodePatches.push({ stock: s.stock, code: s.code });
                    }
                });
                if (recoveredCodePatches.length > 0) {
                    console.log('[HotYestYestVol] 从 window._hotFullRowCache 恢复 code: ' + recoveredCodePatches.map(function(p) { return p.stock + '=' + p.code; }).join(', '));
                }

                const codeToName = {};
                const _noCodeStocks = [];
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) codeToName[code] = s.stock.trim();
                    else _noCodeStocks.push(s.stock.trim());
                });
                const allCodes = Object.keys(codeToName);
                if (allCodes.length === 0) {
                    console.log('[HotYestYestVol] 无可用代码：yesterdayList=' + yesterdayList.length + ' stockcodemap=' + Object.keys(scMap).length);
                    window.setApiStatus('thsApiStatusHot', '❌ 没有可补全的股票（缺代码映射，请先通过「昨日涨停连板」「获取飙升+热股」导入股票，或导入代码映射）', false);
                    return;
                }
                console.log('[HotYestYestVol] 开始 today=' + today + ' yesterday=' + yesterday + ' dayBefore=' + dayBefore + ' mode=' + (overwrite ? '覆盖' : '补全') + ' yesterdayList=' + yesterdayList.length + ' 有代码=' + allCodes.length + ' 缓存恢复=' + recoveredCodePatches.length + ' 无代码=' + _noCodeStocks.length + (_noCodeStocks.length > 0 ? ' 无代码=' + _noCodeStocks.join(',') : ''));

                window.setApiStatus('thsApiStatusHot', '正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
                const volDayBefore = await window.fetchDayVolumes(allCodes, dayBefore);
                console.log('[HotYestYestVol] window.fetchDayVolumes 返回 ' + Object.keys(volDayBefore).length + '/' + allCodes.length + ' 只有值，dayBefore=' + dayBefore);

                let filled = 0, skipped = 0;
                const _skipReasons = { noCode: 0, noVol: 0, alreadyHas: 0 };
                const yesterdayYestVolPatches = [];
                const codePatches = recoveredCodePatches.slice(); // [BUG-FIX] 把 scMap/缓存恢复的 code 写回 hot_stocks
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = (scMap[name] || '').trim();
                    // 先回填 code（即使 yestVolume 已有也要回填）
                    if (!s.code && mappedCode) {
                        s.code = mappedCode;
                        codePatches.push({ stock: name, code: mappedCode });
                    }
                    const code = (s.code || mappedCode || '').trim();
                    if (!code) { _skipReasons.noCode++; skipped++; return; }
                    if (!overwrite && window.getNumericVolume(s.yestVolume) !== null) { _skipReasons.alreadyHas++; return; }
                    if (volDayBefore[code] != null) {
                        s.yestVolume = String(Math.round(volDayBefore[code] / 10000));
                        yesterdayYestVolPatches.push({ stock: s.stock, yest_volume: s.yestVolume });
                        filled++;
                    } else {
                        _skipReasons.noVol++;
                        skipped++;
                    }
                });
                console.log('[HotYestYestVol] 填充结果: filled=' + filled + ' skipped=' + skipped + ' (无代码=' + _skipReasons.noCode + ' 无量=' + _skipReasons.noVol + ' 已有值=' + _skipReasons.alreadyHas + ') yestPatches=' + yesterdayYestVolPatches.length + ' codePatches=' + codePatches.length);
                // 同「两全昨日成交量」的修复：不能用 buildYesterdayListFromToday 造出的 yesterdayList
                // 直接覆盖 hotAuctionData[yesterday]，否则会把对比日原有、这次名单没覆盖到的股票冲掉，
                // 后续 syncHotStocksListForDate 同步时会把这些股票误标记 in_watchlist=false 而从
                // tap 页面消失。只把补全的 yestVolume 合并回原有股票，不存在的股票不进正式列表。
                const existingYesterdayList = (hotAuctionData[yesterday] || []).slice();
                const existingYesterdayNames = {};
                existingYesterdayList.forEach(function(s) {
                    if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                });
                yesterdayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    if (!existingYesterdayNames[name]) return;
                    const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                    if (target) target.yestVolume = s.yestVolume;
                });
                const shadowOnlyYesterdayStocks = yesterdayList.filter(function(s) {
                    return s && s.stock && !existingYesterdayNames[s.stock.trim()];
                });

                hotAuctionData[yesterday] = existingYesterdayList;
                window.invalidateTopicCache();
                window._safePatch(yesterday, codePatches, '昨日code');
                window._safePatch(yesterday, yesterdayYestVolPatches, '昨日yest_volume');
                // [BUG-FIX] 只推送有 yestVolume 的股票到 hot_stock_trends，避免空 volume/change_pct 覆盖已有值
                var _trendsExist = existingYesterdayList.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(yesterday, _trendsExist, '昨日趋势');
                var _trendsShadow = shadowOnlyYesterdayStocks.filter(function(s) { return s && s.stock && s.yestVolume; });
                window._safeTrends(yesterday, _trendsShadow, '昨日趋势(影子)');

                // 调试：验证 _hotFullRowCache 是否已更新
                if (yesterdayYestVolPatches.length > 0) {
                    var _cacheList = window._hotFullRowCache[yesterday] || [];
                    var _cacheMap = {};
                    _cacheList.forEach(function(r) { if (r && r.stock) _cacheMap[r.stock.trim()] = r; });
                    var _verifyLog = [];
                    yesterdayYestVolPatches.forEach(function(p) {
                        var name = (p.stock || '').trim();
                        var cached = _cacheMap[name];
                        var trendVal = window.getStockHistoryValue(yesterday, name, 'yestVolume', 'hot');
                        _verifyLog.push(name + ': cache.yest_volume=' + (cached ? (cached.yest_volume || cached.yestVolume || '(空)') : '(无行)') + ' trendVal=' + (trendVal !== null ? trendVal : 'null'));
                    });
                    console.log('[HotYestYestVol] 缓存验证(' + _verifyLog.length + '只):\n' + _verifyLog.join('\n'));
                }

                // [BUG-FIX] 等待所有云端写入完成
                window.setApiStatus('thsApiStatusHot', '正在同步到云端...', true);
                await Promise.all(_cloudTasks);

                window.renderHotForm();
                window.renderHotStocks();

                const yesterdaySource = yesterdayListWasEmpty
                    ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                    : '';
                let _statusMsg = '✅ ' + (overwrite ? '覆盖' : '补全') + ' 对比日昨成交量 ' + filled + '/' + yesterdayList.length + yesterdaySource + '，跳过 ' + skipped + '（无数据或缺代码）';
                if (_cloudErrors.length > 0) {
                    _statusMsg += ' ⚠️ 云端写入失败：' + _cloudErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', _statusMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', _statusMsg, true);
                }
            } catch (err) {
                console.error('window.fillHotYesterdayYesterdayVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window._closeHotAuctionShield(); // [BUG-FIX] 对应入口的 window._openHotAuctionShield
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：获取涨幅（snapshot 接口，支持补全/覆盖弹窗） ----------
        export function fetchHotChangePctFromThs(btn) {
            window.showNumcatChoiceModal('获取涨幅模式（热门股票）', function(overwrite) {
                window._fetchHotChangePctFromThsImpl(btn, overwrite);
            });
        }

        export async function _fetchHotChangePctFromThsImpl(btn, overwrite) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).filter(function(s) { return s && s.stock; });

                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                // 收集 thscode
                const scMap = window._scMapCache || {};

                // [BUG-FIX] 收集所有云端写入Promise，统一await并收集错误
                const _cloudTasks = [];
                const _cloudErrors = [];
                function _safePatch(date, patches, label) {
                    if (patches.length === 0) return;
                    _cloudTasks.push(
                        window.patchHotFieldBatch(date, patches).then(function(res) {
                            if (res && res.ok === false) _cloudErrors.push(label + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                        }).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); })
                    );
                }
                window._safePatch = _safePatch;
                function _safeTrends(date, list, label) {
                    if (!list || list.length === 0) return;
                    _cloudTasks.push(window.pushHotTrendsToCloud(date, list).catch(function(e) { _cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e))); }));
                }
                window._safeTrends = _safeTrends;

                const stockMap = {}; // thscode -> stock 对象
                const thscodes = [];
                const codePatches = []; // [BUG-FIX] 把 scMap 里的 code 写回 hot_stocks
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const name = s.stock.trim();
                    const mappedCode = (scMap[name] || '').trim();
                    const code = (s.code || mappedCode || '').trim();
                    if (code) {
                        const thscode = window.tickerToThscode(code);
                        if (thscode && !stockMap[thscode]) {
                            thscodes.push(thscode);
                            stockMap[thscode] = s;
                        }
                    }
                    if (!s.code && mappedCode) {
                        s.code = mappedCode;
                        codePatches.push({ stock: name, code: mappedCode });
                    }
                });

                if (thscodes.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 没有可查询的股票（缺少代码映射，请先通过「昨日涨停连板」或「获取飙升+热股」导入股票，或导入代码映射）', false);
                    return;
                }

                window.setApiStatus('thsApiStatusHot', '正在请求同花顺接口获取涨幅（' + thscodes.length + ' 只股票）...', true);

                // snapshot 接口支持批量查询（thscodes 逗号分隔，每批 ≤40 只）
                // 注意：fuyao 对批里任何一只不认识的代码（典型：北交所 .BJ）会【整批报错】，
                // 一只害死一批——这正是"热门股票获取涨幅抓不到数据"的根因（飙升榜+热股榜常含
                // 北交所股票，而早盘竞价的 883410 成分股以主板为主所以没暴露）。
                // 对策：整批失败时降级为逐只请求，不认识的单只跳过记 skipped。
                const batchSize = 40;
                let filledCount = 0;
                let skippedCount = 0;
                const changePctPatches = [];

                for (let i = 0; i < thscodes.length; i += batchSize) {
                    const chunk = thscodes.slice(i, i + batchSize);
                    let data;
                    try {
                        data = await window.fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
                    } catch (batchErr) {
                        console.warn('snapshot 批量失败，降级逐只请求:', batchErr && batchErr.message);
                        const rescued = [];
                        for (let j = 0; j < chunk.length; j++) {
                            try {
                                const d1 = await window.fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk[j] });
                                if (d1 && d1.item) rescued.push.apply(rescued, d1.item);
                            } catch (e1) {
                                skippedCount++; // 该只代码 fuyao 不认识（北交所等），跳过
                            }
                        }
                        data = { item: rescued };
                    }
                    const items = (data && data.item) || [];
                    items.forEach(function(item) {
                        const thscode = item.thscode;
                        const pct = item.price_change_ratio_pct;
                        const stock = stockMap[thscode];
                        if (!stock) {
                            skippedCount++;
                            return;
                        }
                        // [BUG-FIX] 接口返回 thscode，如行内缺 code 则自动回填
                        if (!stock.code && thscode) {
                            const apiCode = String(thscode).replace(/\..*$/, '').trim();
                            if (/^\d{6}$/.test(apiCode)) {
                                stock.code = apiCode;
                                codePatches.push({ stock: stock.stock, code: apiCode });
                            }
                        }
                        if (pct === null || pct === undefined || pct === '') {
                            skippedCount++;
                            return;
                        }
                        const n = Number(pct);
                        if (isNaN(n)) {
                            skippedCount++;
                            return;
                        }
                        if (!overwrite && ((stock.changePct || '').trim())) {
                            skippedCount++; // 补全模式：已有值跳过
                            return;
                        }
                        stock.changePct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                        stock.note = window.buildNoteFromFields(stock.changePct, stock.topics);
                        // 字段级 PATCH：只上报本次改动的 change_pct/note
                        changePctPatches.push({ stock: stock.stock, change_pct: stock.changePct, note: stock.note });
                        filledCount++;
                    });
                }

                hotAuctionData[today] = todayList;
                window.invalidateTopicCache();

                // 同步到云端（字段级 PATCH：先写 code，再写本次改动的 change_pct/note，不再整行覆盖）
                // [BUG-FIX] await所有patch，收集错误反馈UI
                window._safePatch(today, codePatches, '今日code');
                window._safePatch(today, changePctPatches, '今日change_pct');
                window._safeTrends(today, todayList, '今日趋势');

                window.setApiStatus('thsApiStatusHot', '正在同步到云端...', true);
                await Promise.all(_cloudTasks);

                window.renderHotForm();
                window.renderHotStocks();

                const action = overwrite ? '覆盖' : '补全';
                let _statusMsg = '✅ ' + action + ' ' + filledCount + ' 只股票涨幅，跳过 ' + skippedCount + ' 只无数据或已有';
                if (_cloudErrors.length > 0) {
                    _statusMsg += ' ⚠️ 云端写入失败：' + _cloudErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', _statusMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', _statusMsg, true);
                }
            } catch (err) {
                console.error('window.fetchHotChangePctFromThs 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 fuyao-proxy Edge Function 已部署';
                }
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：历史断点涨幅补全/覆盖 ----------
        // 与"获取涨幅"的区别：那个只补今天一天的涨幅；这个针对每只股票近5日涨幅图里的断点日，
        // 把断点日的历史涨幅补进 _hotFullRowCache（影子记录方式），让五日涨幅图连起来。
        // 三条红线（对应历史踩坑）：
        //   1. 全程不读不写 hotAuctionData[date] —— 第一页"最近多板池"渲染数据源不变，
        //      补的日期里这只股票不会凭空出现在池子里；
        //   2. 绝不调 syncHotStocksListForDate —— 它会把影子记录扶正成 in_watchlist=true；
        //   3. 只用 patchHotFieldBatch 且 patch 里只放 change_pct —— 不碰其它任何字段。
        // 补哪天：5日窗口内"竞价量最早有值的那天"起到今天，缺涨幅的日期才补；
        //   竞价量还没有值更早的日期（股票还没入池）不补，符合"数据从竞价量最早那个点开始"的规则。
        // mode: 'fill'（补全，仅写 null 断点）| 'overwrite'（覆盖，重抓起点后所有交易日涨幅，含已有值）
        export async function fillHotHistoryGapPctFromThs(btn, mode) {
            mode = (mode === 'overwrite') ? 'overwrite' : 'fill';
            const modeLabel = mode === 'overwrite' ? '覆盖' : '补全';
            window.setBtnLoading(btn, true);
            window._openHotAuctionShield(); // [BUG-FIX] 入口立即开 shield，覆盖 await window.fetchDayVolumes 期间的竞态窗口
            try {
                const today = state.currentDate;
                const hotData = window.getHotAuctionData();
                const todayList = (hotData[today] || []).filter(function(s) { return s && s.stock; });
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                const scMap = window._scMapCache || {};
                // 近5个交易日（含今天），正序 [T-4 ... T]
                const windowDates = [];
                let d = today;
                for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = window.getPreviousTradingDay(d); }
                if (windowDates.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定交易日序列', false);
                    return;
                }

                window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') 点击 | currentDate=' + today + ' | 今日列表=' + todayList.length +
                    ' | 窗口交易日=' + windowDates.join(','));

                // 对每只股票：确定有效起始日（窗口内竞价量最早有值的那天），收集该日之后的涨幅断点日
                // gapMap: { stockName: { code, gapDates: [date,...], hadValueDates: [date,...] } }
                const gapMap = {};
                let totalGapDays = 0;
                const noStartDateNames = [];
                const noGapNames = [];
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) return;
                    // 有效起始日：窗口内最早有任意数据（volume/yestVolume/changePct）的日期
                    // 修复死锁：原逻辑只用 volume 作为起点，导致猫抓三天覆盖范围之外的日期永远无法补全
                    let startDate = null;
                    for (let i = 0; i < windowDates.length; i++) {
                        const vol = window.getStockHistoryValue(windowDates[i], name, 'volume', 'hot');
                        const yest = window.getStockHistoryValue(windowDates[i], name, 'yestVolume', 'hot');
                        const pct = window.getStockHistoryValue(windowDates[i], name, 'changePct', 'hot');
                        if (vol !== null || yest !== null || pct !== null) { startDate = windowDates[i]; break; }
                    }
                    if (!startDate) { noStartDateNames.push(name); return; }
                    // 起始日及之后、到今天为止
                    const rawGapDates = [];
                    const hadValueDates = []; // 覆盖模式：记录已有涨幅的日期
                    let started = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        const dt = windowDates[i];
                        if (dt === startDate) started = true;
                        if (!started) continue;
                        const pct = window.getStockHistoryValue(dt, name, 'changePct', 'hot');
                        if (pct === null) {
                            rawGapDates.push(dt);
                        } else if (mode === 'overwrite') {
                            rawGapDates.push(dt);
                            hadValueDates.push(dt);
                        }
                    }
                    // 【Bug修复】过滤非交易日：与早盘竞价版对齐，窗口可能包含周末/节假日，
                    // API 不返回这些日期的 K 线，不过滤会导致无意义的"无K线数据"计数。
                    const gapDates = rawGapDates.filter(window.isTradingDay);
                    if (gapDates.length > 0) {
                        gapMap[name] = { code: code, gapDates: gapDates, hadValueDates: hadValueDates, nonTradingSkip: rawGapDates.length - gapDates.length };
                        totalGapDays += gapDates.length;
                    } else {
                        noGapNames.push(name);
                    }
                });

                const stockNames = Object.keys(gapMap);
                window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') 目标汇总 | 有目标=' + stockNames.length + '（共' + totalGapDays + '天）' +
                    ' | 窗口内有竞价量但无目标=' + noGapNames.length +
                    ' | 窗口内无竞价量=' + noStartDateNames.length);
                if (stockNames.length === 0) {
                    if (noStartDateNames.length > 0) {
                        window.setApiStatus('thsApiStatusHot', '✅ 近5日涨幅无需' + modeLabel + '：' + noStartDateNames.length + ' 只股票窗口内无竞价量，无法定位起点；' + noGapNames.length + ' 只已有完整涨幅', true);
                    } else {
                        window.setApiStatus('thsApiStatusHot', '✅ 近5日涨幅无需' + modeLabel + '（所有股票已有完整涨幅）', true);
                    }
                    return;
                }

                window.setApiStatus('thsApiStatusHot',
                    modeLabel + '模式：发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个目标日，正在逐只拉取历史K线...', true);

                // 逐只股票：用一次 historical 请求拿"最早断点日前一天 ~ 今天"的日K，
                // 用相邻两日 close_price 自己算涨幅（接口不直接返回涨跌幅字段）。
                // 按日期分组收集 patch，逐日 patchHotFieldBatch 上报（影子记录语义，in_watchlist 默认 false）。
                const patchesByDate = {}; // { date: [ {stock, change_pct}, ... ] }
                let filledStocks = 0, failedStocks = 0, noDataStocks = 0;
                let filledGapDays = 0, overwrittenDays = 0, noDataGapDays = 0, nonTradingSkipTotal = 0;

                for (let si = 0; si < stockNames.length; si++) {
                    const name = stockNames[si];
                    const info = gapMap[name];
                    nonTradingSkipTotal += (info.nonTradingSkip || 0);
                    const earliestGap = info.gapDates[0];
                    // 基准日：最早断点日的前一交易日（算最早断点日涨幅需要它的收盘价）
                    const baseDate = window.getPreviousTradingDay(earliestGap);
                    if (!baseDate) {
                        failedStocks++;
                        window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + ' 跳过：无法找到最早目标日 ' + earliestGap + ' 的前一交易日');
                        continue;
                    }
                    const startMs = new Date(baseDate + 'T00:00:00').getTime();
                    const endMs = new Date(today + 'T23:59:59').getTime();
                    try {
                        const data = await window.fuyaoApiGet('/api/a-share/prices/historical', {
                            thscode: window.tickerToThscode(info.code),
                            interval: '1d',
                            start: String(startMs),
                            end: String(endMs),
                            adjust: 'none'
                        });
                        const items = (data && data.item) || [];
                        // dateStr -> close_price
                        const closeByDate = {};
                        items.forEach(function(it) {
                            const dt = new Date(it.date_ms);
                            const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                            if (typeof it.close_price === 'number') closeByDate[ds] = it.close_price;
                        });
                        const returnedDates = Object.keys(closeByDate).sort();
                        const missingDates = info.gapDates.filter(function(gd) {
                            const prev = window.getPreviousTradingDay(gd);
                            return !closeByDate[gd] || (prev && !closeByDate[prev]);
                        });
                        window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + '(' + info.code + ') 返回K线日期=' + returnedDates.join(',') +
                            ' | 目标日=' + info.gapDates.join(',') +
                            (missingDates.length > 0 ? ' | 缺失前收/当日收=' + missingDates.join(',') : ''));
                        let stockFilled = 0;
                        let stockOverwritten = 0;
                        let stockNoData = 0;
                        info.gapDates.forEach(function(gapDate) {
                            const prevDate = window.getPreviousTradingDay(gapDate);
                            const c0 = prevDate ? closeByDate[prevDate] : undefined;
                            const c1 = closeByDate[gapDate];
                            if (typeof c0 !== 'number' || typeof c1 !== 'number' || c0 === 0) {
                                stockNoData++;
                                return;
                            }
                            const pct = ((c1 - c0) / c0) * 100;
                            const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                            if (!patchesByDate[gapDate]) patchesByDate[gapDate] = [];
                            patchesByDate[gapDate].push({ stock: name, change_pct: pctStr });
                            // 区分：该日期之前是否有值（覆盖 vs 补全）
                            if (info.hadValueDates && info.hadValueDates.indexOf(gapDate) >= 0) {
                                stockOverwritten++;
                            } else {
                                stockFilled++;
                            }
                        });
                        if (stockFilled > 0 || stockOverwritten > 0) {
                            filledStocks++;
                            filledGapDays += stockFilled;
                            overwrittenDays += stockOverwritten;
                        }
                        if (stockNoData > 0) { noDataStocks++; noDataGapDays += stockNoData; }
                        if (si % 5 === 4 || si === stockNames.length - 1) {
                            window.setApiStatus('thsApiStatusHot',
                                modeLabel + '进度 ' + (si + 1) + '/' + stockNames.length + '，已处理 ' + (filledGapDays + overwrittenDays) + ' 个目标日...', true);
                        }
                    } catch (e) {
                        failedStocks++;
                        console.warn('拉取 ' + name + ' 历史K线失败:', e && e.message);
                    }
                }

                // 逐日上报（只写 change_pct，其它字段一律不碰）
                // [BUG-FIX] await所有patch，收集云端写入错误反馈到UI，不再fire-and-forget
                window.setApiStatus('thsApiStatusHot', modeLabel + '模式：K线拉取完成，正在同步到云端...', true);
                const patchErrors = [];
                const patchTasks = [];
                const gapDateKeys = Object.keys(patchesByDate);
                window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') 开始上报 | 目标日期=' + gapDateKeys.join(',') +
                    ' | patchesByDate=' + JSON.stringify(patchesByDate));
                for (let di = 0; di < gapDateKeys.length; di++) {
                    const dt = gapDateKeys[di];
                    patchTasks.push(
                        window.patchHotFieldBatch(dt, patchesByDate[dt]).then(function(res) {
                            window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') window.patchHotFieldBatch 返回 date=' + dt + ' res=' + JSON.stringify({ ok: res && res.ok, rows: res && res.rows, cloudSkipped: res && res.cloudSkipped, error: res && res.error && res.error.message }));
                            if (res && res.ok === false) {
                                patchErrors.push(dt + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                            }
                        }).catch(function(e) {
                            window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') window.patchHotFieldBatch 异常 date=' + dt + ' err=' + (e && e.message || e));
                            patchErrors.push(dt + ': ' + (e && e.message ? e.message : String(e)));
                        })
                    );
                }
                await Promise.all(patchTasks);

                // 刷新当前页渲染（趋势图会读到 _hotFullRowCache 里新补的 change_pct）
                window.renderHotForm();
                window.renderHotStocks();

                window._dbgLog('[HOT-BTN] 历史断点涨幅(' + modeLabel + ') 写入汇总 | 已写入股票=' + filledStocks +
                    ' | 补全断点=' + filledGapDays + ' | 覆盖已有=' + overwrittenDays +
                    ' | 无K线数据股票=' + noDataStocks + '（目标日=' + noDataGapDays + '）' +
                    ' | 拉取失败=' + failedStocks +
                    ' | 非交易日跳过=' + nonTradingSkipTotal +
                    ' | 云端写入错误=' + patchErrors.length);

                const statusParts = ['✅ ' + modeLabel + '完成：' + filledStocks + ' 只股票'];
                if (mode === 'overwrite') {
                    statusParts.push('覆盖 ' + overwrittenDays + ' 个已有涨幅');
                    if (filledGapDays > 0) statusParts.push('补全 ' + filledGapDays + ' 个断点');
                } else {
                    statusParts.push(filledGapDays + ' 个断点日涨幅已写入');
                }
                if (noDataStocks > 0) statusParts.push(noDataStocks + ' 只目标日无K线数据');
                if (failedStocks > 0) statusParts.push(failedStocks + ' 只拉取失败');
                if (nonTradingSkipTotal > 0) statusParts.push('跳过 ' + nonTradingSkipTotal + ' 个非交易日');
                let finalMsg = statusParts.join('，') + '（影子记录，不影响任何日期的最近多板池）';
                if (patchErrors.length > 0) {
                    finalMsg += ' ⚠️ 云端写入失败：' + patchErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', finalMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', finalMsg, true);
                }
            } catch (err) {
                console.error('window.fillHotHistoryGapPctFromThs(' + modeLabel + ') 失败:', err);
                let msg = err && err.message ? err.message : (modeLabel + '失败');
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window._closeHotAuctionShield(); // [BUG-FIX] 对应入口的 window._openHotAuctionShield
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 同花顺（热门股票）：历史断点昨日成交量补全 ----------
        // 与上面 fillHotHistoryGapPctFromThs（历史断点涨幅）同一套定位逻辑，仅补全字段不同：
        // 以窗口内每只股票最早出现竞价量(volume)的日期为起点(startDate)，从该日起找出
        // yest_volume 缺失的断点日；为每只股票用 prices/historical 拉取
        // [最早断点日的前一交易日 ~ 今天] 整段日线，取每个断点日"前一交易日"的 volume
        // 作为该断点日的 yest_volume（与"当天/对比日昨成交量"按钮同样的单位换算：股 ÷ 10000）。
        // 只经 patchHotFieldBatch 写 yest_volume 字段，不碰 hotAuctionData / 第一页正式列表语义，
        // 与早盘竞价 tab 的同名按钮完全独立（不共用函数）。
        export async function fillHotHistoryGapYestVolumeFromThs(btn) {
            window.setBtnLoading(btn, true);
            window._openHotAuctionShield(); // [BUG-FIX] 入口立即开 shield，覆盖 await window.fetchDayVolumes 期间的竞态窗口
            try {
                const today = state.currentDate;
                const hotData = window.getHotAuctionData();
                const todayList = (hotData[today] || []).filter(function(s) { return s && s.stock; });
                if (todayList.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                const scMap = window._scMapCache || {};
                const windowDates = [];
                let d = today;
                for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = window.getPreviousTradingDay(d); }
                if (windowDates.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '❌ 无法确定交易日序列', false);
                    return;
                }

                const gapMap = {};
                let totalGapDays = 0;
                todayList.forEach(function(s) {
                    const name = s.stock.trim();
                    const code = (s.code || scMap[name] || '').trim();
                    if (!code) return;
                    // 修复死锁：用任意数据作为起点，不只依赖 volume
                    let startDate = null;
                    for (let i = 0; i < windowDates.length; i++) {
                        const vol = window.getStockHistoryValue(windowDates[i], name, 'volume', 'hot');
                        const yest = window.getStockHistoryValue(windowDates[i], name, 'yestVolume', 'hot');
                        const pct = window.getStockHistoryValue(windowDates[i], name, 'changePct', 'hot');
                        if (vol !== null || yest !== null || pct !== null) { startDate = windowDates[i]; break; }
                    }
                    if (!startDate) return;
                    const gapDates = [];
                    let started = false;
                    for (let i = 0; i < windowDates.length; i++) {
                        const dt = windowDates[i];
                        if (dt === startDate) started = true;
                        if (!started) continue;
                        const yv = window.getStockHistoryValue(dt, name, 'yestVolume', 'hot');
                        if (yv === null) gapDates.push(dt);
                    }
                    if (gapDates.length > 0) {
                        gapMap[name] = { code: code, gapDates: gapDates };
                        totalGapDays += gapDates.length;
                    }
                });

                const stockNames = Object.keys(gapMap);
                if (stockNames.length === 0) {
                    window.setApiStatus('thsApiStatusHot', '✅ 近5日昨日成交量无断点（或竞价量数据不足，无需补全）', true);
                    return;
                }

                window.setApiStatus('thsApiStatusHot',
                    '发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个昨日成交量断点，正在逐只拉取历史日线...', true);

                const patchesByDate = {};
                let filledStocks = 0, failedStocks = 0;
                let filledGapDays = 0;

                for (let si = 0; si < stockNames.length; si++) {
                    const name = stockNames[si];
                    const info = gapMap[name];
                    const earliestGap = info.gapDates[0];
                    const baseDate = window.getPreviousTradingDay(earliestGap);
                    if (!baseDate) { failedStocks++; continue; }
                    const startMs = new Date(baseDate + 'T00:00:00').getTime();
                    const endMs = new Date(today + 'T23:59:59').getTime();
                    try {
                        const data = await window.fuyaoApiGet('/api/a-share/prices/historical', {
                            thscode: window.tickerToThscode(info.code),
                            interval: '1d',
                            start: String(startMs),
                            end: String(endMs),
                            adjust: 'none'
                        });
                        const items = (data && data.item) || [];
                        const volByDate = {};
                        items.forEach(function(it) {
                            const dt = new Date(it.date_ms);
                            const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                            if (typeof it.volume === 'number') volByDate[ds] = it.volume;
                        });
                        let stockFilled = 0;
                        info.gapDates.forEach(function(gapDate) {
                            const prevDate = window.getPreviousTradingDay(gapDate);
                            const vol = prevDate ? volByDate[prevDate] : undefined;
                            if (typeof vol !== 'number') return;
                            const yestVolumeStr = String(Math.round(vol / 10000));
                            if (!patchesByDate[gapDate]) patchesByDate[gapDate] = [];
                            patchesByDate[gapDate].push({ stock: name, yest_volume: yestVolumeStr });
                            stockFilled++;
                        });
                        if (stockFilled > 0) { filledStocks++; filledGapDays += stockFilled; }
                        if (si % 5 === 4 || si === stockNames.length - 1) {
                            window.setApiStatus('thsApiStatusHot',
                                '拉取进度 ' + (si + 1) + '/' + stockNames.length + '，已补 ' + filledGapDays + ' 个断点...', true);
                        }
                    } catch (e) {
                        failedStocks++;
                        console.warn('拉取 ' + name + ' 历史日线失败:', e && e.message);
                    }
                }

                // 逐日上报（只写 yest_volume，其它字段一律不碰；影子记录 in_watchlist 默认 false）
                // [BUG-FIX] await所有patch，收集云端写入错误反馈到UI，不再fire-and-forget
                window.setApiStatus('thsApiStatusHot', '历史断点昨日成交量：K线拉取完成，正在同步到云端...', true);
                const patchErrors = [];
                const patchTasks = [];
                const gapDateKeys = Object.keys(patchesByDate);
                window._dbgLog('[HOT-BTN] 历史断点昨日成交量 开始上报 | 目标日期=' + gapDateKeys.join(',') +
                    ' | patchesByDate=' + JSON.stringify(patchesByDate));
                for (let di = 0; di < gapDateKeys.length; di++) {
                    const dt = gapDateKeys[di];
                    patchTasks.push(
                        window.patchHotFieldBatch(dt, patchesByDate[dt]).then(function(res) {
                            window._dbgLog('[HOT-BTN] 历史断点昨日成交量 window.patchHotFieldBatch 返回 date=' + dt + ' res=' + JSON.stringify({ ok: res && res.ok, rows: res && res.rows, cloudSkipped: res && res.cloudSkipped, error: res && res.error && res.error.message }));
                            if (res && res.ok === false) {
                                patchErrors.push(dt + ': ' + (res.error && res.error.message ? res.error.message : '写入失败'));
                            }
                        }).catch(function(e) {
                            window._dbgLog('[HOT-BTN] 历史断点昨日成交量 window.patchHotFieldBatch 异常 date=' + dt + ' err=' + (e && e.message || e));
                            patchErrors.push(dt + ': ' + (e && e.message ? e.message : String(e)));
                        })
                    );
                }
                await Promise.all(patchTasks);

                window.renderHotForm();
                window.renderHotStocks();

                let finalMsg = '✅ 补全完成：' + filledStocks + ' 只股票、' + filledGapDays + ' 个断点日昨日成交量已写入（影子记录，不影响任何日期的最近多板池）' +
                    (failedStocks > 0 ? '，' + failedStocks + ' 只拉取失败' : '');
                if (patchErrors.length > 0) {
                    finalMsg += ' ⚠️ 云端写入失败：' + patchErrors.join('；');
                    window.setApiStatus('thsApiStatusHot', finalMsg, false);
                } else {
                    window.setApiStatus('thsApiStatusHot', finalMsg, true);
                }
            } catch (err) {
                console.error('window.fillHotHistoryGapYestVolumeFromThs 失败:', err);
                let msg = err && err.message ? err.message : '补全失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                window.setApiStatus('thsApiStatusHot', '❌ ' + msg, false);
            } finally {
                window._closeHotAuctionShield(); // [BUG-FIX] 对应入口的 window._openHotAuctionShield
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 猫抓（热门股票）：补全昨日竞价量（弹窗选择补全/覆盖） ----------
        export function fillHotYesterdayAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('补全昨日竞价量（热门股票）', function(overwrite) {
                window.fetchHotAuctionFromNumcat(btn, {
                    fillYesterday: true, fillToday: false,
                    overwriteYesterday: overwrite, overwriteToday: false
                });
            });
        }

        // ---------- 猫抓（热门股票）：获取当天竞价量（弹窗选择补全/覆盖） ----------
        export function fetchHotTodayAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('获取当天竞价量（热门股票）', function(overwrite) {
                window.fetchHotAuctionFromNumcat(btn, {
                    fillYesterday: false, fillToday: true,
                    overwriteYesterday: false, overwriteToday: overwrite
                });
            });
        }

        // ---------- 猫抓（热门股票）：全竞价量（弹窗选择补全/覆盖，两天统一） ----------
        export function fetchAllHotAuctionFromNumcat(btn) {
            window.showNumcatChoiceModal('全竞价量（热门股票，昨日+今日）', function(overwrite) {
                window.fetchHotAuctionFromNumcat(btn, {
                    fillYesterday: true, fillToday: true,
                    overwriteYesterday: overwrite, overwriteToday: overwrite
                });
            });
        }

        // ---------- 猫抓（热门股票）：连抓三天补全（今日+昨日+前日，一次请求，纯补全不覆盖，不弹窗） ----------
        export function fetchThreeDaysHotAuctionFromNumcat(btn) {
            window.fetchHotAuctionFromNumcat(btn, {
                fillToday: true, fillYesterday: true, fillDayBefore: true,
                overwriteToday: false, overwriteYesterday: false, overwriteDayBefore: false
            });
        }

        // ---------- 猫抓：连抓五天补全（热门股票版，竞价量+成交量反推，一次请求，纯补全不覆盖） ----------
        export async function fetchFiveDaysHotAuctionFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const dates = [today];
                let d = today;
                for (let i = 0; i < 4; i++) {
                    d = window.getPreviousTradingDay(d);
                    if (!d) break;
                    dates.push(d);
                }
                if (dates.length < 2) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 无法确定足够的历史交易日', false);
                    return;
                }
                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                let scMap = window._scMapCache || {};
                if (Object.keys(scMap).length === 0 && typeof window.loadCloudStockCodeMap === 'function') {
                    try { await window.loadCloudStockCodeMap(); } catch (e) {}
                    scMap = window._scMapCache || {};
                }
                const allCodesSet = new Set();
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) allCodesSet.add(code);
                });
                if (allCodesSet.size === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有可补全的股票（缺少代码映射，请先通过「昨日涨停连板」「获取飙升+热股」导入股票，或导入代码映射）', false);
                    return;
                }
                const symbols = Array.from(allCodesSet).join(',');
                const startYMD = dates[dates.length - 1].replace(/-/g, '');
                const endYMD = dates[0].replace(/-/g, '');
                const params = { symbols: symbols, startdate: startYMD, enddate: endYMD };
                window.setApiStatus('numcatApiStatusHot', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，连抓' + dates.length + '天，竞价量+昨成交量+涨幅）...', true);
                const fields = 'symbol,name,tradedate,auc_vol,auc_to_pre_vol_pct';
                const result = await window.numcatApiPost('daily_auc', fields, params);
                const fieldList = result.fields || [];
                const items = result.items || [];
                const symbolIdx = fieldList.indexOf('symbol');
                const tradedateIdx = fieldList.indexOf('tradedate');
                const aucVolIdx = fieldList.indexOf('auc_vol');
                const ratioIdx = fieldList.indexOf('auc_to_pre_vol_pct');
                if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 返回数据字段不完整', false);
                    return;
                }
                const aucByDate = {};
                items.forEach(function(row) {
                    const code = String(row[symbolIdx] || '').trim();
                    const tradedate = String(row[tradedateIdx] || '').trim();
                    const aucVol = row[aucVolIdx];
                    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;
                    if (!aucByDate[tradedate]) aucByDate[tradedate] = {};
                    const volNum = Number(aucVol);
                    const entry = { vol: isNaN(volNum) ? '' : String(Math.round(volNum / 100)) };
                    if (ratioIdx >= 0) {
                        const ratio = row[ratioIdx];
                        if (ratio !== null && ratio !== undefined && ratio !== '') {
                            const r = Number(ratio);
                            if (!isNaN(r) && r > 0 && volNum > 0) {
                                entry.yestVol = String(Math.round(volNum / r));
                            }
                        }
                    }
                    aucByDate[tradedate][code] = entry;
                });
                const dailyResult = await window.numcatApiPost('daily', 'symbol,tradedate,pct_chg', params);
                const dailyFieldList = dailyResult.fields || [];
                const dailyItems = dailyResult.items || [];
                const dSymbolIdx = dailyFieldList.indexOf('symbol');
                const dTradeIdx = dailyFieldList.indexOf('tradedate');
                const dPctIdx = dailyFieldList.indexOf('pct_chg');
                const pctByDate = {};
                if (dSymbolIdx >= 0 && dTradeIdx >= 0 && dPctIdx >= 0) {
                    dailyItems.forEach(function(row) {
                        const code = String(row[dSymbolIdx] || '').trim();
                        const tradedate = String(row[dTradeIdx] || '').trim();
                        const rawPct = row[dPctIdx];
                        if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
                        if (!pctByDate[tradedate]) pctByDate[tradedate] = {};
                        const n = Number(rawPct);
                        if (!isNaN(n)) pctByDate[tradedate][code] = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                    });
                }
                let filledVolCount = 0, filledYestVolCount = 0, filledPctCount = 0, skippedCount = 0;
                const patchesByDate = {};
                dates.forEach(function(dateStr) {
                    const ymd = dateStr.replace(/-/g, '');
                    const dayData = aucByDate[ymd] || {};
                    const dayPct = pctByDate[ymd] || {};
                    let dayList = (hotAuctionData[dateStr] || []).slice();
                    const existingNames = {};
                    dayList.forEach(function(s) { if (s && s.stock) existingNames[s.stock.trim()] = true; });
                    if (dayList.length === 0 && dateStr !== today) {
                        dayList = window.buildYesterdayListFromToday(todayList, hotAuctionData, dateStr);
                    } else {
                        todayList.forEach(function(s) {
                            if (s && s.stock && !existingNames[s.stock.trim()]) {
                                dayList.push(Object.assign({}, s, { volume: '', yestVolume: '', changePct: '' }));
                            }
                        });
                    }
                    const patches = [];
                    dayList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (!code || !dayData[code]) { skippedCount++; return; }
                        const entry = dayData[code];
                        let changed = false;
                        const patch = { stock: s.stock };
                        if (entry.vol && window.getNumericVolume(s.volume) === null) {
                            s.volume = entry.vol;
                            patch.volume = s.volume;
                            filledVolCount++;
                            changed = true;
                        }
                        if (entry.yestVol) {
                            s.yestVolume = entry.yestVol;
                            patch.yest_volume = s.yestVolume;
                            filledYestVolCount++;
                            changed = true;
                        }
                        if (dayPct[code] && !((s.changePct || '').trim())) {
                            s.changePct = dayPct[code];
                            s.note = window.buildNoteFromFields(s.changePct, s.topics);
                            patch.change_pct = s.changePct;
                            patch.note = s.note;
                            filledPctCount++;
                            changed = true;
                        }
                        if (changed) patches.push(patch);
                    });
                    hotAuctionData[dateStr] = dayList;
                    if (patches.length > 0) patchesByDate[dateStr] = patches;
                });
                window.invalidateTopicCache();
                window.renderHotForm();
                window.renderHotStocks();
                window.renderList();
                Object.keys(patchesByDate).forEach(function(dateStr) {
                    window.patchHotFieldBatch(dateStr, patchesByDate[dateStr]).catch(function(e) {
                        window._dbgLog('[HOT-ERR] patchHotFieldBatch ' + dateStr + ' ' + (e && e.message || e));
                    });
                });
                const patchCounts = dates.map(function(d) { return (patchesByDate[d] || []).length; });
                const resultText = '✅ 连抓' + dates.length + '天完成：竞价量+' + filledVolCount + ' / 昨成交量(反推)+' + filledYestVolCount + ' / 涨幅+' + filledPctCount +
                    '（各日只数：' + patchCounts.join('/') + '），跳过 ' + skippedCount + ' 只无数据';
                window.setApiStatus('numcatApiStatusHot', resultText, true);
            } catch (err) {
                console.error('fetchFiveDaysHotAuctionFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署';
                window.setApiStatus('numcatApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // 猫抓竞价量补全共用逻辑（热门股票独立版本）
        // opts: { fillYesterday: bool, fillToday: bool, overwriteYesterday: bool, overwriteToday: bool }
        export async function fetchHotAuctionFromNumcat(btn, opts) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                if (!yesterday) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 无法确定上一交易日', false);
                    return;
                }
                // 「连抓三天补全」：前天（T-2）也纳入补全范围
                const dayBefore = opts.fillDayBefore ? window.getPreviousTradingDay(yesterday) : null;
                if (opts.fillDayBefore && !dayBefore) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 无法确定前两个交易日', false);
                    return;
                }

                const hotAuctionData = window.getHotAuctionData();
                const todayList = (hotAuctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // 对比日列表体检：若 hotAuctionData[yesterday] 本来就是空的（对比日从未单独导入过），
                // 用 buildYesterdayListFromToday 以今日列表为基础现造一份"影子"对比日列表，
                // 与同花顺版本 _fillHotYesterdayYesterdayVolumeFromThsImpl（第15017行）保持同一套处理方式，
                // 否则会像之前那样直接判定"没有可补全的股票"而整段跳过，云端和本地缓存都不会被写入。
                const yesterdayListWasEmpty = opts.fillYesterday && (hotAuctionData[yesterday] || []).length === 0;
                const yesterdayList = opts.fillYesterday
                    ? window.buildYesterdayListFromToday(todayList, hotAuctionData, yesterday)
                    : [];
                // 前天列表同样处理：有正式列表就基于它保留字段，没有就造影子（落影子记录，不进前天第一页）
                const dayBeforeList = opts.fillDayBefore
                    ? window.buildYesterdayListFromToday(todayList, hotAuctionData, dayBefore)
                    : [];
                const dayBeforeListWasEmpty = opts.fillDayBefore && (hotAuctionData[dayBefore] || []).length === 0;
                const scMap = window._scMapCache || {};

                // [BUG-FIX/恢复] 从云端全量快照缓存恢复缺失的 code，再收集请求代码。
                // 返回patches数组以便持久化恢复的code到云端（对齐同花顺版本逻辑）
                const recoverCodesFromCache = function(list, dateKey) {
                    const cacheList = window._hotFullRowCache[dateKey] || [];
                    const cacheMap = {};
                    cacheList.forEach(function(r) { if (r && r.stock) cacheMap[r.stock.trim()] = r; });
                    const patches = [];
                    list.forEach(function(s) {
                        if (!s || !s.stock || (s.code || '').trim()) return;
                        const cached = cacheMap[s.stock.trim()];
                        if (cached && (cached.code || '').trim()) {
                            s.code = cached.code.trim();
                            patches.push({ stock: s.stock, code: s.code });
                        }
                    });
                    return patches;
                };
                const _todayRecoveredCodePatches = recoverCodesFromCache(todayList, today);
                const _yesterdayRecoveredCodePatches = recoverCodesFromCache(yesterdayList, yesterday);
                const _dayBeforeRecoveredCodePatches = recoverCodesFromCache(dayBeforeList, dayBefore);
                const recoveredToday = _todayRecoveredCodePatches.length;
                const recoveredYesterday = _yesterdayRecoveredCodePatches.length;
                const recoveredDayBefore = _dayBeforeRecoveredCodePatches.length;
                if (recoveredToday > 0 || recoveredYesterday > 0 || recoveredDayBefore > 0) {
                    console.log('[NUMCAT-DEBUG-HOT] 从缓存恢复 code: 今日' + recoveredToday + ' 昨日' + recoveredYesterday + ' 前日' + recoveredDayBefore);
                }

                const needToday = opts.fillToday && todayList.length > 0;
                const needYesterday = opts.fillYesterday && yesterdayList.length > 0;
                const needDayBefore = opts.fillDayBefore && dayBeforeList.length > 0;
                if (!needToday && !needYesterday && !needDayBefore) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有可补全的股票', false);
                    return;
                }

                // 合并去重股票代码
                const allCodesSet = new Set();
                const collectCodes = function(list) {
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (code) allCodesSet.add(code);
                    });
                };
                if (needToday) collectCodes(todayList);
                if (needYesterday) collectCodes(yesterdayList);
                if (needDayBefore) collectCodes(dayBeforeList);

                if (allCodesSet.size === 0) {
                    console.log('[NUMCAT-DEBUG-HOT] 无可用代码：todayList=' + todayList.length + ' stockcodemap=' + Object.keys(scMap).length);
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有可补全的股票（缺少代码映射，请先通过「昨日涨停连板」「获取飙升+热股」导入股票，或导入代码映射）', false);
                    return;
                }

                // 预检：各日列表缺失情况快照
                const countMissing = function(list, field) {
                    let missing = 0;
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        if (field === 'volume') {
                            if (window.getNumericVolume(s.volume) === null) missing++;
                        } else if (field === 'changePct') {
                            if (!((s.changePct || '').trim())) missing++;
                        }
                    });
                    return missing;
                };
                const preCheck = {
                    today: { total: todayList.length, missingVolume: countMissing(todayList, 'volume'), missingPct: countMissing(todayList, 'changePct') },
                    yesterday: needYesterday ? { total: yesterdayList.length, missingVolume: countMissing(yesterdayList, 'volume') } : undefined,
                    dayBefore: needDayBefore ? { total: dayBeforeList.length, missingVolume: countMissing(dayBeforeList, 'volume') } : undefined
                };
                window._dbgLog('[NUMCAT-DEBUG-HOT] 猫抓预检 | currentDate=' + today + ' | 缺失快照=' + JSON.stringify(preCheck));

                const symbols = Array.from(allCodesSet).join(',');
                const todayYMD = today.replace(/-/g, '');
                const yesterdayYMD = yesterday.replace(/-/g, '');
                const dayBeforeYMD = dayBefore ? dayBefore.replace(/-/g, '') : '';

                // 构造 params（一次请求拿需要的所有日期；多天用 startdate+enddate，1次请求省额度）
                const reqDates = [];
                if (needDayBefore) reqDates.push(dayBeforeYMD);
                if (needYesterday) reqDates.push(yesterdayYMD);
                if (needToday) reqDates.push(todayYMD);
                const params = reqDates.length > 1
                    ? { symbols: symbols, startdate: reqDates[0], enddate: reqDates[reqDates.length - 1] }
                    : { symbols: symbols, tradedate: reqDates[0] };
                window._dbgLog('[NUMCAT-DEBUG-HOT] 点击猫抓 | currentDate=' + today + ' | yesterday=' + yesterday +
                    ' | dayBefore=' + (dayBefore || '(无)') + ' | opts=' + JSON.stringify({ fillToday: opts.fillToday, fillYesterday: opts.fillYesterday, fillDayBefore: opts.fillDayBefore, overwriteToday: opts.overwriteToday, overwriteYesterday: opts.overwriteYesterday, overwriteDayBefore: opts.overwriteDayBefore }) +
                    ' | codes=' + allCodesSet.size + ' | params=' + JSON.stringify(params));

                const dayCountText = reqDates.length === 3 ? '三天' : (reqDates.length === 2 ? '两天' : '单日');
                const todayFieldHint = opts.fillToday ? '；今日同时补竞价量+涨幅' : '';
                window.setApiStatus('numcatApiStatusHot', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，' + dayCountText + todayFieldHint + '）...', true);

                const fields = 'symbol,name,tradedate,auc_vol,auc_pct_chg';
                const result = await window.numcatApiPost('daily_auc', fields, params);

                // 解析返回数据
                const fieldList = result.fields || [];
                const items = result.items || [];
                const dateRowCounts = {};
                const symbolIdx = fieldList.indexOf('symbol');
                const tradedateIdx = fieldList.indexOf('tradedate');
                const aucVolIdx = fieldList.indexOf('auc_vol');
                const aucPctIdx = fieldList.indexOf('auc_pct_chg');
                if (tradedateIdx >= 0) {
                    items.forEach(function(row) {
                        const td = String(row[tradedateIdx] || '').trim();
                        if (td) dateRowCounts[td] = (dateRowCounts[td] || 0) + 1;
                    });
                }
                window._dbgLog('[NUMCAT-DEBUG-HOT] 猫抓返回 rawItems=' + items.length + ' 各交易日行数=' + JSON.stringify(dateRowCounts) +
                    ' fields=' + JSON.stringify(fieldList));
                if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 返回数据字段不完整', false);
                    return;
                }

                // 按日期分组：YYYYMMDD -> { code: { vol: aucVol(万), pct: "+2.5%", rawPct } }
                const aucByDate = {};
                // [BUG-FIX] 同时构建接口返回的 name->symbol 映射，用于无 scMap 时自动回填 code
                const apiNameToCode = {};
                const nameIdx = fieldList.indexOf('name');
                items.forEach(function(row) {
                    const code = String(row[symbolIdx] || '').trim();
                    const tradedate = String(row[tradedateIdx] || '').trim();
                    const aucVol = row[aucVolIdx];
                    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;
                    if (!aucByDate[tradedate]) aucByDate[tradedate] = {};
                    const entry = { vol: Math.round(Number(aucVol) / 100), rawPct: row[aucPctIdx] };
                    if (aucPctIdx >= 0) {
                        const pct = row[aucPctIdx];
                        if (pct !== null && pct !== undefined && pct !== '') {
                            const n = Number(pct);
                            if (!isNaN(n)) {
                                entry.pct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                            }
                        }
                    }
                    aucByDate[tradedate][code] = entry;
                    if (nameIdx >= 0) {
                        const apiName = String(row[nameIdx] || '').trim();
                        if (apiName) apiNameToCode[apiName] = code;
                    }
                });
                window._dbgLog('[NUMCAT-DEBUG-HOT] 接口 name->symbol 映射条目=' + Object.keys(apiNameToCode).length);

                // [BUG-FIX] 把接口返回的 name->symbol 映射持久化到云端 stockcodemap（唯一真相源），
                // 这样即使云端 hot_stocks 行的 code 被冲掉，stockcodemap 仍有代码映射，
                // 同花顺/猫抓后续补全都能直接读到代码，不需要重新拉取。
                let _apiMapPersistCount = 0;
                if (Object.keys(apiNameToCode).length > 0) {
                    const scMap = window._scMapCache || {};
                    let _dirty = false;
                    const scPairs = [];
                    Object.keys(apiNameToCode).forEach(function(name) {
                        const code = apiNameToCode[name];
                        if (code && !((scMap[name] || '').trim())) {
                            scMap[name] = code;
                            scPairs.push({ stock: name, code: code });
                            _dirty = true;
                            _apiMapPersistCount++;
                        }
                    });
                    if (_dirty) {
                        window.upsertStockCodeMap(scPairs).catch(function(e) { window._dbgLog('[AUCTION-ERR] NUMCAT-DEBUG-HOT window.upsertStockCodeMap ' + (e && e.message || e)); });
                        window._dbgLog('[NUMCAT-DEBUG-HOT] 自动写入 stockcodemap ' + _apiMapPersistCount + ' 条');
                    }
                }

                // 填充 volume / changePct
                let filledVolumeCount = 0;
                let filledPctCount = 0;
                let skippedCount = 0;

                // 字段级 PATCH 改造（对齐早盘竞价 15914-15919 行）：收集 patch，结束时统一
                // 调 patchHotFieldBatch 上报，只携带本次猫抓真正改动的字段（volume，以及今天
                // 的 change_pct/note），不再整行 push——这正是"先点猫抓再点同花顺互相覆盖"
                // 原始 bug 的触发点。
                const todayPatches = [];
                const yesterdayPatches = [];
                const dayBeforePatches = []; // 「连抓三天补全」前天的 patch 收集
                const todayCodePatches = []; // [BUG-FIX] 自动回填 code
                const yesterdayCodePatches = [];
                const dayBeforeCodePatches = [];
                // 合并从_hotFullRowCache缓存恢复的code patches
                if (_todayRecoveredCodePatches.length > 0) {
                    _todayRecoveredCodePatches.forEach(function(p) { todayCodePatches.push(p); });
                }
                if (_yesterdayRecoveredCodePatches.length > 0) {
                    _yesterdayRecoveredCodePatches.forEach(function(p) { yesterdayCodePatches.push(p); });
                }
                if (_dayBeforeRecoveredCodePatches.length > 0) {
                    _dayBeforeRecoveredCodePatches.forEach(function(p) { dayBeforeCodePatches.push(p); });
                }
                // 🔍[调试-诊断报告用] 记录各日每只股票的命中/未命中情况，写入
                // lastNumcatFillDebugHot_<date>（加 Hot 前缀与早盘竞价 key 互相独立）。
                const todayFillLog = [];
                const yesterdayFillLog = [];
                const dayBeforeFillLog = [];

                const fillVolume = function(list, dateStr, overwrite, fillPct, patchesArr, codePatchesArr, fillLogArr) {
                    const ymd = dateStr.replace(/-/g, '');
                    const dayData = aucByDate[ymd] || {};
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const name = s.stock.trim();
                        const mappedCode = (scMap[name] || '').trim();
                        const apiCode = (apiNameToCode[name] || '').trim();
                        // [BUG-FIX] 内存缺 code 时，优先用 scMap，再尝试接口返回的 name->symbol 映射回填
                        if (!s.code && (mappedCode || apiCode)) {
                            s.code = mappedCode || apiCode;
                            if (codePatchesArr) codePatchesArr.push({ stock: name, code: s.code });
                        }
                        const code = (s.code || mappedCode || apiCode || '').trim();
                        const hasDayData = code && dayData[code] != null;
                        const dayEntry = hasDayData ? dayData[code] : null;
                        let volWritten = false;
                        let pctWritten = false;
                        let skipReason = '';

                        if (hasDayData) {
                            // volume：覆盖模式 或 当前缺失/为0 时写入（0 视为未抓取，允许覆盖）
                            const needVol = overwrite || window.getNumericVolume(s.volume) === null;
                            if (needVol) {
                                s.volume = String(dayEntry.vol);
                                volWritten = true;
                            }
                            // 涨幅：仅今天(fillPct=true)且接口返回了pct时处理
                            if (fillPct && dayEntry.pct) {
                                const needPct = overwrite || !((s.changePct || '').trim());
                                if (needPct) {
                                    s.changePct = dayEntry.pct;
                                    s.note = window.buildNoteFromFields(s.changePct, s.topics);
                                    pctWritten = true;
                                }
                            }
                        } else {
                            skipReason = code ? '接口返回结果里完全没有这只股票的数据(symbol未匹配)' : '缺代码映射，无法匹配';
                        }

                        // 只有真正发生改动时才生成 patch，避免字段级同步污染
                        if (volWritten || pctWritten) {
                            const patch = { stock: s.stock };
                            if (volWritten) patch.volume = s.volume;
                            if (pctWritten) {
                                patch.change_pct = s.changePct;
                                patch.note = s.note;
                            }
                            patchesArr.push(patch);
                            if (volWritten) filledVolumeCount++;
                            if (pctWritten) filledPctCount++;
                        } else if (!hasDayData) {
                            skippedCount++; // 接口无该股票数据，覆盖/补全模式下都跳过
                        }

                        // 🔍[调试] 记录所有天的处理结果（不仅是今天）
                        if (fillLogArr) {
                            fillLogArr.push({
                                stock: s.stock, code: code,
                                hadDayData: hasDayData,
                                apiReturnedPct: dayEntry ? (dayEntry.pct || null) : null,
                                apiReturnedVol: dayEntry ? dayEntry.vol : undefined,
                                apiReturnedRawPct: dayEntry ? dayEntry.rawPct : undefined,
                                volWrittenThisTime: volWritten,
                                pctWrittenThisTime: pctWritten,
                                changePctAfter: s.changePct || '',
                                volumeAfter: s.volume || '',
                                reasonNotWritten: skipReason || (
                                    !dayEntry ? '接口返回结果里无该股票' : (
                                        fillPct && !dayEntry.pct ? '接口未返回auc_pct_chg' : (
                                            !overwrite && fillPct && (s.changePct || '').trim() ? '已有涨幅且非覆盖模式，未覆盖' : (
                                                !overwrite && !fillPct && window.getNumericVolume(s.volume) !== null ? '已有竞价量且非覆盖模式，未覆盖' : '未知'
                                            )
                                        )
                                    )
                                )
                            });
                        }
                    });
                };

                if (needToday) {
                    fillVolume(todayList, today, !!opts.overwriteToday, true, todayPatches, todayCodePatches, todayFillLog);   // 今天：填 volume + 涨幅
                    hotAuctionData[today] = todayList;
                }
                let shadowOnlyYesterdayStocks = [];
                if (needYesterday) {
                    fillVolume(yesterdayList, yesterday, !!opts.overwriteYesterday, false, yesterdayPatches, yesterdayCodePatches, yesterdayFillLog); // 昨日：只填 volume
                    // 同「对比日昨成交量」(ths) 的修复：不能用 buildYesterdayListFromToday 造出的 yesterdayList
                    // 直接覆盖 hotAuctionData[yesterday]，否则会把对比日原有、这次名单没覆盖到的股票冲掉，
                    // 后续 syncHotStocksListForDate 同步时会把这些股票误标记 in_watchlist=false 而从
                    // tap 页面消失。只把补全的 volume 合并回原有正式列表股票；不存在的股票（影子记录）
                    // 单独落表，不进正式列表，但仍然持久化到云端供趋势图查询。
                    const existingYesterdayList = (hotAuctionData[yesterday] || []).slice();
                    const existingYesterdayNames = {};
                    existingYesterdayList.forEach(function(s) {
                        if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                    });
                    yesterdayList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const name = s.stock.trim();
                        if (!existingYesterdayNames[name]) return;
                        const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                        if (target) target.volume = s.volume;
                    });
                    shadowOnlyYesterdayStocks = yesterdayList.filter(function(s) {
                        return s && s.stock && !existingYesterdayNames[s.stock.trim()];
                    });
                    hotAuctionData[yesterday] = existingYesterdayList;
                }

                // 「连抓三天补全」前天：与昨日完全同一套影子逻辑——只把 volume 合并回前天
                // 原有正式列表成员，前天原本没有的股票落影子记录（in_watchlist=false），不进前天第一页。
                let shadowOnlyDayBeforeStocks = [];
                if (needDayBefore) {
                    fillVolume(dayBeforeList, dayBefore, !!opts.overwriteDayBefore, false, dayBeforePatches, dayBeforeCodePatches, dayBeforeFillLog); // 前天：只填 volume
                    const existingDayBeforeList = (hotAuctionData[dayBefore] || []).slice();
                    const existingDayBeforeNames = {};
                    existingDayBeforeList.forEach(function(s) {
                        if (s && s.stock) existingDayBeforeNames[s.stock.trim()] = true;
                    });
                    dayBeforeList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const name = s.stock.trim();
                        if (!existingDayBeforeNames[name]) return;
                        const target = existingDayBeforeList.find(function(e) { return e.stock && e.stock.trim() === name; });
                        if (target) target.volume = s.volume;
                    });
                    shadowOnlyDayBeforeStocks = dayBeforeList.filter(function(s) {
                        return s && s.stock && !existingDayBeforeNames[s.stock.trim()];
                    });
                    hotAuctionData[dayBefore] = existingDayBeforeList;
                }

                // 🔍[调试-诊断报告用] 快照写入内存变量（不落 localStorage），三天全部记录
                function saveDayDebug(dateStr, ymd, fillLog, overwrite, patchesLen) {
                    window._hotNumcatDebugSnapshots[dateStr] = {
                        requestedAt: new Date().toISOString(),
                        date: dateStr,
                        overwrite: !!overwrite,
                        requestedCodesCount: allCodesSet.size,
                        apiRawItemsCount: items.length,
                        apiRawItemsForDate: items.filter(function(row) {
                            return String(row[tradedateIdx] || '').trim() === ymd;
                        }).map(function(row) {
                            return { symbol: row[symbolIdx], name: row[1], tradedate: row[tradedateIdx],
                                auc_vol: row[aucVolIdx], auc_pct_chg: (aucPctIdx >= 0 ? row[aucPctIdx] : undefined) };
                        }),
                        patchesCount: patchesLen,
                        fillLog: fillLog
                    };
                }
                window.saveDayDebug = saveDayDebug;
                if (needToday) window.saveDayDebug(today, todayYMD, todayFillLog, opts.overwriteToday, todayPatches.length);
                if (needYesterday) window.saveDayDebug(yesterday, yesterdayYMD, yesterdayFillLog, opts.overwriteYesterday, yesterdayPatches.length);
                if (needDayBefore) window.saveDayDebug(dayBefore, dayBeforeYMD, dayBeforeFillLog, opts.overwriteDayBefore, dayBeforePatches.length);

                window.invalidateTopicCache();

                window.renderHotForm();
                window.renderHotStocks();

                // [BUG-FIX] 云端写入：不再fire-and-forget。所有patch和trends push并发执行，用Promise.all等全部完成。
                // 收集每个写入的成功/失败，错误在UI状态里明确提示，不再只打console.warn静默吞掉。
                window.setApiStatus('numcatApiStatusHot', '正在同步到云端...', true);
                const cloudTasks = [];
                const cloudErrors = [];
                function safePatch(date, patches, label) {
                    if (patches.length === 0) return;
                    cloudTasks.push(
                        window.patchHotFieldBatch(date, patches).then(function(res) {
                            if (res && res.ok === false) {
                                cloudErrors.push(label + ': ' + (res.error && res.error.message ? res.error.message : '未知错误'));
                            }
                        }).catch(function(e) {
                            cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e)));
                        })
                    );
                }
                window.safePatch = safePatch;
                function safeTrendsPush(date, list, label) {
                    if (!list || list.length === 0) return;
                    cloudTasks.push(
                        window.pushHotTrendsToCloud(date, list).catch(function(e) {
                            cloudErrors.push(label + ': ' + (e && e.message ? e.message : String(e)));
                        })
                    );
                }
                window.safeTrendsPush = safeTrendsPush;
                // 先code，再volume/pct
                window.safePatch(today, todayCodePatches, '今日code');
                window.safePatch(yesterday, yesterdayCodePatches, '昨日code');
                window.safePatch(dayBefore, dayBeforeCodePatches, '前日code');
                window.safePatch(today, todayPatches, '今日竞价量/涨幅');
                window.safePatch(yesterday, yesterdayPatches, '昨日竞价量');
                window.safePatch(dayBefore, dayBeforePatches, '前日竞价量');
                // 趋势缓存
                if (needYesterday) {
                    window.safeTrendsPush(yesterday, hotAuctionData[yesterday], '昨日趋势');
                    window.safeTrendsPush(yesterday, shadowOnlyYesterdayStocks, '昨日趋势(影子)');
                }
                if (needDayBefore) {
                    window.safeTrendsPush(dayBefore, hotAuctionData[dayBefore], '前日趋势');
                    window.safeTrendsPush(dayBefore, shadowOnlyDayBeforeStocks, '前日趋势(影子)');
                }
                if (needToday) window.safeTrendsPush(today, todayList, '今日趋势');

                await Promise.all(cloudTasks);
                window.renderHotForm();
                window.renderHotStocks();

                // 三天模式显示分天结果，两天/单日保持原文案
                let resultText;
                if (opts.fillDayBefore) {
                    resultText = '✅ 连抓三天完成：竞价量+' + filledVolumeCount + ' / 涨幅+' + filledPctCount +
                        '（今日' + todayPatches.length + ' / 昨日' + yesterdayPatches.length + ' / 前日' + dayBeforePatches.length + ' 只），跳过 ' + skippedCount + ' 只无数据';
                    if (dayBeforeListWasEmpty) resultText += '（前日列表已用今日列表作为基础，新股票落影子记录）';
                } else {
                    const mode = (needToday && needYesterday) ? '昨日+今日' : (needToday ? '今日' : '昨日');
                    const action = (opts.overwriteToday || opts.overwriteYesterday) ? '覆盖' : '补全';
                    const yesterdayNote = (needYesterday && yesterdayListWasEmpty)
                        ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                        : '';
                    resultText = '✅ ' + mode + action + '：竞价量 ' + filledVolumeCount + ' / 涨幅 ' + filledPctCount + '，跳过 ' + skippedCount + ' 只无数据' + yesterdayNote;
                }
                if (cloudErrors.length > 0) {
                    resultText += ' ⚠️ 部分云端写入失败：' + cloudErrors.join('；');
                    window.setApiStatus('numcatApiStatusHot', resultText, false);
                } else {
                    window.setApiStatus('numcatApiStatusHot', resultText, true);
                }
            } catch (err) {
                console.error('window.fetchHotAuctionFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ================================================================
        // 接口诊断（热门股票 tab 独立版本）
        // 只读检查，不修改任何数据。与早盘竞价 tab 的 runAuctionApiDiagnostics
        // 结构对称，但完全独立：只读写 hotAuctionData / _hotFullRowCache /
        // _hotTrendsCache 等热门股票专属状态，不调用早盘竞价的任何函数。
        // 额外体检 hot_stock_trends 独立表（热门股票 tab 特有，早盘竞价没有）。
        // ================================================================
        export function runHotApiDiagnostics() {
            const lines = [];
            const push = function(s) { lines.push(s); };
            const now = new Date();

            push('===== 热门股票 接口诊断报告 =====');
            push('生成时间：' + now.toLocaleString('zh-CN', { hour12: false }));
            push('');

            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                push('【交易日】当前日期(today)=' + today);
                push('　　　　  上一交易日(yesterday)=' + (yesterday || '（无法确定）'));
                push('　　　　  前两交易日(dayBefore)=' + (dayBefore || '（无法确定）'));
                push('');

                const hotAuctionData = window.getHotAuctionData();
                const scMap = window._scMapCache || {};
                const scMapSize = Object.keys(scMap).length;

                // ---- 今日列表体检 ----
                const todayList = (hotAuctionData[today] || []).filter(function(s) { return s && s.stock; });

                // ---- 代码映射体检 ----
                push('【代码映射】stockcodemap 条目数=' + scMapSize);
                let todayCodeInRow = 0, todayCodeInMap = 0, todayCodeMissing = 0;
                todayList.forEach(function(s) {
                    const hasRowCode = !!((s.code || '').trim());
                    const hasMapCode = !!((scMap[s.stock.trim()] || '').trim());
                    if (hasRowCode) todayCodeInRow++;
                    else if (hasMapCode) todayCodeInMap++;
                    else todayCodeMissing++;
                });
                push('　　行内已有 code：' + todayCodeInRow + ' 只 | 仅在 stockcodemap：' + todayCodeInMap + ' 只 | 完全无代码：' + todayCodeMissing + ' 只');
                // [增强诊断] 同时检查云端全量快照里的 code 状态，帮助定位"保存后 code 消失"类问题。
                const todayCache = window._hotFullRowCache[today] || [];
                let cloudHasCode = 0, cloudMissingCode = 0, memoryCloudCodeMismatch = 0;
                todayList.forEach(function(s) {
                    if (!s || !s.stock) return;
                    const cacheRow = todayCache.find(function(r) { return r && r.stock === s.stock.trim(); });
                    const rowCode = (s.code || '').trim();
                    const cacheCode = cacheRow ? (cacheRow.code || '').trim() : '';
                    if (cacheCode) cloudHasCode++;
                    else cloudMissingCode++;
                    if (rowCode && cacheCode && rowCode !== cacheCode) memoryCloudCodeMismatch++;
                });
                push('　　云端快照有 code：' + cloudHasCode + ' 只 | 云端快照缺 code：' + cloudMissingCode + ' 只 | 内存与云端 code 不一致：' + memoryCloudCodeMismatch + ' 只');
                if (scMapSize > 0) {
                    const sample = Object.keys(scMap).slice(0, 10).map(function(n) { return n + '=' + scMap[n]; }).join('、');
                    push('　　stockcodemap 前 10 条样例：' + sample + (scMapSize > 10 ? ' ...（共' + scMapSize + '条）' : ''));
                }
                if (todayCodeMissing > 0) {
                    push('　　💡 修复建议：');
                    if (todayCodeInMap > 0) push('　　　1) 点「保存」可把 stockcodemap 中的代码写回云端；');
                    push('　　　' + (todayCodeInMap > 0 ? '2' : '1') + ') 点「昨日涨停连板」「获取飙升+热股」或「导入代码映射」获取代码；');
                    push('　　　' + (todayCodeInMap > 0 ? '3' : '2') + ') 若仍缺代码，可先用猫抓「连抓三天补全」从接口返回中自动映射。');
                }
                push('');

                push('【今日列表 ' + today + '】共 ' + todayList.length + ' 只');
                let todayVolMiss = 0, todayYestMiss = 0, todayCodeMiss = 0, yestMissButHasCode = 0;
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (!code) todayCodeMiss++;
                    if (window.getNumericVolume(s.volume) === null) todayVolMiss++;
                    if (window.getNumericVolume(s.yestVolume) === null) {
                        todayYestMiss++;
                        if (code) yestMissButHasCode++;
                    }
                });
                push('　　缺代码映射：' + todayCodeMiss + ' 只');
                push('　　缺竞价量(volume)：' + todayVolMiss + ' 只');
                push('　　缺成交量(yestVolume)：' + todayYestMiss + ' 只（其中 ' + yestMissButHasCode + ' 只已有代码，可点「获取当天昨日成交量」补全）');
                push('　　逐只明细（股票 | 代码来源 | 代码 | volume竞价量 | yestVolume成交量 | 涨幅）：');
                todayList.forEach(function(s) {
                    const nameTrim = s.stock.trim();
                    const rowCode = (s.code || '').trim();
                    const mapCode = (scMap[nameTrim] || '').trim();
                    const cacheRow = todayCache.find(function(r) { return r && r.stock === nameTrim; });
                    const cacheCode = cacheRow ? (cacheRow.code || '').trim() : '';
                    let code = rowCode || mapCode || cacheCode || '(无)';
                    let source = rowCode ? '行内' : (mapCode ? '映射' : (cacheCode ? '缓存' : '无'));
                    push('　　  ' + s.stock + ' | ' + source + ' | ' + code + ' | vol=' + (s.volume || '(空)') +
                         ' | yest=' + (s.yestVolume || '(空)') + ' | pct=' + (s.changePct || '(空)'));
                });
                push('');

                // ---- 对比日列表体检 ----
                const yesterdayList = yesterday ? (hotAuctionData[yesterday] || []).filter(function(s) { return s && s.stock; }) : [];
                push('【对比日列表 ' + (yesterday || '') + '】共 ' + yesterdayList.length + ' 只');
                let yVolMiss = 0, yYestMiss = 0;
                yesterdayList.forEach(function(s) {
                    if (window.getNumericVolume(s.volume) === null) yVolMiss++;
                    if (window.getNumericVolume(s.yestVolume) === null) yYestMiss++;
                });
                push('　　缺竞价量(volume)：' + yVolMiss + ' 只');
                push('　　缺成交量(yestVolume)：' + yYestMiss + ' 只');
                push('　　逐只明细（股票 | volume竞价量 | yestVolume成交量）：');
                yesterdayList.forEach(function(s) {
                    push('　　  ' + s.stock + ' | vol=' + (s.volume || '(空)') + ' | yest=' + (s.yestVolume || '(空)'));
                });
                push('');

                // ---- 保存路径体检 ----
                push('【保存路径】');
                push('　　window.saveHotStocks 函数存在（表单提交绑定）：' + (typeof window.saveHotStocks === 'function'));
                const formEl = window._domGet('hotForm');
                push('　　#hotForm 表单元素存在：' + (!!formEl));
                push('　　#hotForm onsubmit 绑定：' + (formEl && formEl.getAttribute('onsubmit') || '（未找到）'));
                push('　　云端表 hot_stocks 可用(window._hotAuctionTableAvailable)：' + window._hotAuctionTableAvailable);
                push('　　云端表 market_metrics 可用(window._marketMetricsTableAvailable)：' + window._marketMetricsTableAvailable);
                push('　　云端表 hot_stock_trends 可用(window._hotTrendsTableAvailable)：' + window._hotTrendsTableAvailable);
                push('　　_syncState（云同步状态）：' + (window._syncState || '未知'));
                push('　　说明：热门股票数据不落 localStorage 的 auction 模块，直接以 hot_stocks /');
                push('　　　　 hot_stock_trends 两张云端表为准，故这里不检查 localStorage。');
                push('');

                // ---- 趋势图数据源体检（hot_stocks 全量快照 + hot_stock_trends 独立表） ----
                push('【趋势图数据源 1/2：window._hotFullRowCache（全量快照，含正式+影子记录）】');
                // todayCache 已在上方代码映射体检中声明，直接复用
                const yestCache = yesterday ? (window._hotFullRowCache[yesterday] || []) : [];
                const dayBeforeCache = dayBefore ? (window._hotFullRowCache[dayBefore] || []) : [];
                push('　　' + today + ' 快照行数：' + todayCache.length + '（正式列表=' + todayList.length + '）');
                push('　　' + (yesterday || '') + ' 快照行数：' + yestCache.length + '（正式列表=' + yesterdayList.length + '，影子记录=' + (yestCache.length - yesterdayList.length) + '）');
                if (dayBefore) {
                    const dayBeforeList = (hotAuctionData[dayBefore] || []).filter(function(s) { return s && s.stock; });
                    push('　　' + dayBefore + ' 快照行数：' + dayBeforeCache.length + '（正式列表=' + dayBeforeList.length + '，影子记录=' + (dayBeforeCache.length - dayBeforeList.length) + '）');
                }
                // 近5天快照行数概览
                push('　　近5交易日快照行数（含影子记录）：');
                var d5 = today;
                for (var i = 0; i < 5; i++) {
                    if (!d5) break;
                    var c5 = window._hotFullRowCache[d5] || [];
                    var w5 = (hotAuctionData[d5] || []).filter(function(s) { return s && s.stock; }).length;
                    push('　　　' + d5 + '：共' + c5.length + '行（正式' + w5 + '/影子' + (c5.length - w5) + '）');
                    d5 = window.getPreviousTradingDay(d5);
                }

                // 抽样核对今天列表第一只股票近5天的 trend 数据
                if (todayList.length > 0) {
                    const sample = todayList[0];
                    const sampleName = sample.stock.trim();
                    push('');
                    push('　　抽样核对「' + sampleName + '」近5天数据完整性（趋势图应该有5个数据点）：');
                    var ds = today;
                    for (var j = 0; j < 5; j++) {
                        if (!ds) break;
                        var vol = window.getStockHistoryValue(ds, sampleName, 'volume', 'hot');
                        var yvol = window.getStockHistoryValue(ds, sampleName, 'yestVolume', 'hot');
                        var pct = window.getStockHistoryValue(ds, sampleName, 'changePct', 'hot');
                        var status = (vol !== null || yvol !== null) ? '✓有数据' : '✗缺竞价量';
                        push('　　　' + ds + '：volume=' + (vol === null ? '(空)' : vol) + ' | yestVolume=' + (yvol === null ? '(空)' : yvol) + ' | changePct=' + (pct === null ? '(空)' : (pct + '%')) + ' | ' + status);
                        ds = window.getPreviousTradingDay(ds);
                    }
                }
                push('');

                push('【趋势图数据源 2/2：window._hotTrendsCache（来自 hot_stock_trends 独立表，已废弃，仅兼容）】');
                const todayTrend = window._hotTrendsCache[today] || [];
                const yestTrend = yesterday ? (window._hotTrendsCache[yesterday] || []) : [];
                push('　　' + today + ' 趋势行数：' + todayTrend.length);
                push('　　' + (yesterday || '') + ' 趋势行数：' + yestTrend.length);

                if (todayList.length > 0) {
                    const sample = todayList[0];
                    const cacheRow = todayCache.find(function(r) { return r.stock === sample.stock.trim(); });
                    const trendRow = todayTrend.find(function(r) { return r.stock === sample.stock; });
                    push('　　抽样核对「' + sample.stock + '」（内存 vs 快照 vs 趋势表）：');
                    push('　　　内存(hotAuctionData) volume=' + (sample.volume || '(空)') + ' / yestVolume=' + (sample.yestVolume || '(空)'));
                    push('　　　快照(window._hotFullRowCache) volume=' + (cacheRow ? (cacheRow.volume || '(空)') : '（无此股票）') +
                         ' / yest_volume=' + (cacheRow ? (cacheRow.yest_volume || '(空)') : '（无此股票）') +
                         ' / 正式成员=' + (cacheRow ? ((window._hotWatchlistIndex[today] && window._hotWatchlistIndex[today].has((cacheRow.stock || '').trim())) ? '是' : '否(影子)') : '（无此股票）'));
                    push('　　　趋势表(window._hotTrendsCache) volume=' + (trendRow ? (trendRow.volume || '(空)') : '（无此股票）') +
                         ' / yest_volume=' + (trendRow ? (trendRow.yest_volume || '(空)') : '（无此股票）'));
                    const mismatch = cacheRow && ((String(cacheRow.volume || '') !== String(sample.volume || '')) || (String(cacheRow.yest_volume || '') !== String(sample.yestVolume || '')));
                    const mismatch2 = trendRow && ((String(trendRow.volume || '') !== String(sample.volume || '')) || (String(trendRow.yest_volume || '') !== String(sample.yestVolume || '')));
                    if (mismatch) push('　　　⚠️ 内存与 window._hotFullRowCache 快照不一致，可能显示旧值');
                    if (mismatch2) push('　　　⚠️ 内存与 hot_stock_trends 趋势表不一致（趋势表已废弃，不影响）');
                }
                push('');

                // ---- Realtime / 防抖 / 推送屏蔽窗口 体检 ----
                push('【Realtime 与推送状态】');
                push('　　window._justPushedHotAuction（hot_stocks 刚推送屏蔽窗口）：' + window._justPushedHotAuction);
                push('　　window._justPushedHotTrends（hot_stock_trends 刚推送屏蔽窗口）：' + window._justPushedHotTrends);
                push('　　window._hotAuctionRealtimeTimer 是否有待执行的防抖拉取：' + (window._hotAuctionRealtimeTimer !== null));
                push('　　说明：热门股票 tab 有 hot_stocks / hot_stocks_highlights / hot_stock_trends');
                push('　　　　 三张表共用同一个防抖池，任一张表变化都会触发重新拉取。若两次点击');
                push('　　　　 补全按钮之间插入了一次拉取，云端当时若还没有另一字段的最新值，');
                push('　　　　 本次已修复为「云端有效值才覆盖，否则保留本地」，若仍复现请把本报告完整复制发出。');
                push('');

                // ---- 最近一次猫抓补全请求快照（内存变量 _hotNumcatDebugSnapshots，不落 localStorage） ----
                // 🔍[诊断增强] 显示今天/昨天/前天三天的处理快照
                function showDayDebug(label, dateKey, showPctCol) {
                    push('');
                    push('【最近一次猫抓补全 · ' + label + '（' + dateKey + '）】');
                    try {
                        const dbg = window._hotNumcatDebugSnapshots[dateKey];
                        if (!dbg) {
                            push('　　（无记录：本次页面加载后尚未点击过猫抓补全该日）');
                            return;
                        }
                        push('　　请求时间：' + dbg.requestedAt);
                        push('　　overwrite模式：' + dbg.overwrite);
                        push('　　接口返回中该交易日的原始记录 ' + (dbg.apiRawItemsForDate || []).length + ' 条');
                        push('　　生成patch数：' + (dbg.patchesCount || 0));
                        const log = dbg.fillLog || [];
                        const written = log.filter(function(f) { return f.volWrittenThisTime || f.pctWrittenThisTime; });
                        const notHit = log.filter(function(f) { return f.hadDayData === false; });
                        const alreadyHas = log.filter(function(f) { return f.hadDayData && !f.volWrittenThisTime && !f.pctWrittenThisTime; });
                        push('　　处理结果：共' + log.length + '只 | 本次写入=' + written.length + ' | 未命中接口=' + notHit.length + ' | 已有值跳过=' + alreadyHas.length);
                        if (notHit.length > 0 && notHit.length <= 10) {
                            push('　　未命中接口的股票：' + notHit.map(function(f) { return f.stock + '(' + (f.code || '无代码') + ')'; }).join('、'));
                        }
                        // 只展示有异常/未写入的，避免报告太长
                        const abnormal = log.filter(function(f) { return f.hadDayData === false || (!f.volWrittenThisTime && !f.pctWrittenThisTime && f.reasonNotWritten && f.reasonNotWritten !== '未知'); });
                        if (abnormal.length > 0 && abnormal.length <= 20) {
                            push('　　异常/未写入明细：');
                            abnormal.forEach(function(f) {
                                const mark = f.hadDayData === false ? '✗' : '△';
                                push('　　　' + mark + ' ' + f.stock + '(' + (f.code || '无代码') + ') | 接口auc_vol=' + (f.apiReturnedVol === undefined ? '(无)' : f.apiReturnedVol) +
                                     (showPctCol ? ' | 接口auc_pct_chg=' + (f.apiReturnedPct === null ? '(空)' : f.apiReturnedPct) : '') +
                                     ' | 写入后volume=' + (f.volumeAfter || '(空)') +
                                     (showPctCol ? ' | 写入后changePct=' + (f.changePctAfter || '(空)') : '') +
                                     (f.reasonNotWritten ? ' | 原因：' + f.reasonNotWritten : ''));
                            });
                        }
                    } catch (e) {
                        push('　　读取猫抓请求快照异常：' + (e && e.message ? e.message : String(e)));
                    }
                }
                window.showDayDebug = showDayDebug;
                window.showDayDebug('今天', today, true);
                if (yesterday) window.showDayDebug('昨天', yesterday, false);
                if (dayBefore) window.showDayDebug('前天', dayBefore, false);
                push('');

                push('===== 报告结束 =====');
            } catch (e) {
                push('');
                push('❌ 诊断过程出错：' + (e && e.message ? e.message : String(e)));
                if (e && e.stack) push(e.stack);
            }

            window.showHotDiagReport(lines.join('\n'));
            window.setApiStatus('hotDiagStatus', '✅ 诊断完成，请复制报告发给开发者', true);
        }


        // ---------- 猫抓（热门股票）：补全题材（开盘啦，只填 topics 为空的股票） ----------
        export async function fillHotTopicsFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const todayList = (window.getHotAuctionData()[today] || []).filter(function(s) {
                    return s && s.stock && !((s.topics || '').trim());
                });

                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有需要补全题材的股票（所有股票已有题材）', false);
                    return;
                }

                // 收集股票代码
                const scMap = window._scMapCache || {};
                const codes = [];
                const codeToStock = {};
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) {
                        codes.push(code);
                        codeToStock[code] = s;
                    }
                });

                if (codes.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有可补全的股票（缺少代码映射）', false);
                    return;
                }

                window.setApiStatus('numcatApiStatusHot', '正在请求猫抓接口补全题材（' + codes.length + ' 只股票）...', true);

                // 不传 tradedate，让接口默认查最新交易日
                const data = await window.numcatApiPost('screening',
                    'symbol,theme_names_kpl',
                    { symbols: codes.join(',') }
                );

                const fields = data.fields || [];
                const items = data.items || [];
                const symIdx = fields.indexOf('symbol');
                const themeIdx = fields.indexOf('theme_names_kpl');

                if (symIdx < 0 || themeIdx < 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 返回数据字段不完整', false);
                    return;
                }

                let filledCount = 0;
                let skippedCount = 0;
                const topicsPatches = [];
                items.forEach(function(row) {
                    const code = String(row[symIdx] || '').trim();
                    const themeNames = String(row[themeIdx] || '').trim();
                    const stock = codeToStock[code];
                    if (!stock) return;
                    if (!themeNames) {
                        skippedCount++;
                        return;
                    }
                    // 全部保留题材，不再截断为前3个（一只股票可能同时属于多个题材分类）
                    // [BUG-FIX 2026-07-26] 过滤掉开盘啦返回的"题材35/题材36"等编号条目
                    const topicList = themeNames.split(/[，、,;；]/).map(function(t) { return t.trim(); }).filter(function(t) {
                        if (!t) return false;
                        if (/^题材\d+$/.test(t)) return false;   // 题材35 / 题材36
                        if (/^\d+$/.test(t)) return false;     // 纯数字
                        if (t.length < 2) return false;        // 单字符
                        return true;
                    });
                    if (topicList.length === 0) {
                        skippedCount++;
                        return;
                    }
                    const allTopicsStr = topicList.join('，');
                    stock.topics = allTopicsStr;
                    // 字段级 PATCH：只上报 topics
                    topicsPatches.push({ stock: stock.stock, topics: allTopicsStr });
                    // 同步推送到跨 tab 共享的 stock_topics 表（合并去重，不覆盖丢失旧题材）
                    const stockCode = (stock.code || scMap[stock.stock.trim()] || '').trim();
                    window.pushStockTopicsToCloud(stock.stock, topicList, stockCode).catch(function(e) {
                        console.warn('window.pushStockTopicsToCloud 失败（window.fillHotTopicsFromNumcat）:', stock.stock, e);
                    });
                    filledCount++;
                });

                // 没有返回数据的股票也算跳过
                skippedCount += (codes.length - filledCount - skippedCount);

                window.invalidateTopicCache();
                window.renderHotStocks();

                // 同步到云端（字段级 PATCH：只写 topics，不再整行覆盖）
                if (topicsPatches.length > 0) {
                    window.patchHotFieldBatch(today, topicsPatches).catch(function(e) {
                        console.warn('window.patchHotFieldBatch topics 失败:', e);
                    });
                }

                window.setApiStatus('numcatApiStatusHot',
                    '✅ 补全 ' + filledCount + ' 只股票题材，跳过 ' + skippedCount + ' 只无数据或已有题材',
                    true);
            } catch (err) {
                console.error('window.fillHotTopicsFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ---------- 猫抓（热门股票）：查询交易监管（严重异常波动，最近 5 个交易日） ----------
        export async function fetchHotMonitorWarningFromNumcat(btn) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const fullList = (window.getHotAuctionData()[today] || []).filter(function(s) { return s && s.stock; });

                if (fullList.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }

                // 收集股票代码
                const scMap = window._scMapCache || {};
                const codes = [];
                fullList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code) codes.push(code);
                });

                if (codes.length === 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 没有可查询的股票（缺少代码映射）', false);
                    return;
                }

                // 先清除所有股票的监管标记（重新查询）
                fullList.forEach(function(s) { delete s.monitorWarning; });

                window.setApiStatus('numcatApiStatusHot', '正在请求猫抓接口查询监管记录（' + codes.length + ' 只股票）...', true);

                // 查最近 5 个交易日
                const startdate = window.getNthPreviousTradingDay(today, 5).replace(/-/g, '');
                const enddate = today.replace(/-/g, '');

                const data = await window.numcatApiPost('point_monitor',
                    'type,symbol,name,startdate,enddate,reason',
                    {
                        symbols: codes.join(','),
                        type: '严重异常波动',
                        startdate: startdate,
                        enddate: enddate
                    },
                    '/reference-proxy/stock/point-monitor'
                );

                const fields = data.fields || [];
                const items = data.items || [];
                const symIdx = fields.indexOf('symbol');

                if (symIdx < 0) {
                    window.setApiStatus('numcatApiStatusHot', '❌ 返回数据字段不完整', false);
                    return;
                }

                // 构建有监管记录的股票代码集合
                const warningCodes = new Set();
                items.forEach(function(row) {
                    const code = String(row[symIdx] || '').trim();
                    if (code) warningCodes.add(code);
                });

                // 标记股票
                let markedCount = 0;
                fullList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (code && warningCodes.has(code)) {
                        s.monitorWarning = true;
                        markedCount++;
                    }
                });

                window.renderHotStocks();

                // monitorWarning 是内存态标记，不入 hot_stocks 库（白名单里也没有这个字段）。
                // 原实现这里有一次整行 pushHotStocksDataToCloud"以保持云端一致"，但它携带的是
                // 触发那一刻的旧字段快照，会把猫抓/同花顺刚写入的 volume/yest_volume 冲掉——
                // 属于互斥问题的帮凶，本次改造直接删除（无字段需要上报，无需任何云端写入）。

                window.setApiStatus('numcatApiStatusHot',
                    '✅ 查询到 ' + markedCount + ' 只股票有严重异常波动（最近 5 个交易日）',
                    true);
            } catch (err) {
                console.error('window.fetchHotMonitorWarningFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatusHot', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }


        // 猫抓竞价量补全共用逻辑
        // opts: { fillYesterday: bool, fillToday: bool, overwriteYesterday: bool, overwriteToday: bool }
        export async function fetchAuctionFromNumcat(btn, opts) {
            window.setBtnLoading(btn, true);
            try {
                const today = state.currentDate;
                const yesterday = window.getPreviousTradingDay(today);
                if (!yesterday) {
                    window.setApiStatus('numcatApiStatus', '❌ 无法确定上一交易日', false);
                    return;
                }
                // 「连抓三天补全」：前天（T-2）也纳入补全范围
                const dayBefore = opts.fillDayBefore ? window.getPreviousTradingDay(yesterday) : null;
                if (opts.fillDayBefore && !dayBefore) {
                    window.setApiStatus('numcatApiStatus', '❌ 无法确定前两个交易日', false);
                    return;
                }

                const auctionData = window.getAuctionData();
                const todayList = (auctionData[today] || []).slice();
                if (todayList.length === 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
                    return;
                }
                // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
                const yesterdayList = opts.fillYesterday
                    ? window.buildYesterdayListFromToday(todayList, auctionData, yesterday)
                    : [];
                const yesterdayListWasEmpty = opts.fillYesterday && (auctionData[yesterday] || []).length === 0;
                // 前天列表同样处理：有正式列表就基于它保留字段，没有就造影子（落影子记录，不进前天第一页）
                const dayBeforeList = opts.fillDayBefore
                    ? window.buildYesterdayListFromToday(todayList, auctionData, dayBefore)
                    : [];
                const dayBeforeListWasEmpty = opts.fillDayBefore && (auctionData[dayBefore] || []).length === 0;
                let scMap = window._scMapCache || {};

                // [FIX] 代码映射为空时，先按需从云端重新拉取一次。
                // 启动期 loadCloudStockCodeMap 可能因登录时序 / 网络抖动失败，导致 _scMapCache 一直为空，
                // 后续猫抓直接报"缺少代码映射"。这里在真正抓取前兜底重试一次（失败不影响后续用 s.code 兜底）。
                if (Object.keys(scMap).length === 0 && typeof window.loadCloudStockCodeMap === 'function') {
                    try {
                        await window.loadCloudStockCodeMap();
                    } catch (e) {
                        window._dbgLog('[NUMCAT-FIX] 按需加载代码映射失败: ' + (e && e.message));
                    }
                    scMap = window._scMapCache || {};
                }

                const needToday = opts.fillToday && todayList.length > 0;
                const needYesterday = opts.fillYesterday && yesterdayList.length > 0;
                const needDayBefore = opts.fillDayBefore && dayBeforeList.length > 0;
                if (!needToday && !needYesterday && !needDayBefore) {
                    window.setApiStatus('numcatApiStatus', '❌ 没有可补全的股票', false);
                    return;
                }

                // 合并去重股票代码
                const allCodesSet = new Set();
                const collectCodes = function(list) {
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        if (code) allCodesSet.add(code);
                    });
                };
                if (needToday) collectCodes(todayList);
                if (needYesterday) collectCodes(yesterdayList);
                if (needDayBefore) collectCodes(dayBeforeList);

                if (allCodesSet.size === 0) {
                    // 二次兜底：仍无代码时，提示更明确（区分"列表本身无股票代码"与"代码映射未导入"）
                    const hasAnyCode = todayList.some(function(s) { return (s.code || '').trim(); })
                        || yesterdayList.some(function(s) { return (s.code || '').trim(); })
                        || dayBeforeList.some(function(s) { return (s.code || '').trim(); });
                    window.setApiStatus('numcatApiStatus', hasAnyCode
                        ? '❌ 没有可补全的股票（代码映射缺失，请先「设置-导入代码映射」或重新登录后重试）'
                        : '❌ 没有可补全的股票（股票列表无代码，且代码映射为空；请先导入股票代码映射）', false);
                    return;
                }

                // 预检：各日列表缺失情况快照
                const countMissing = function(list, field) {
                    let missing = 0;
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        if (field === 'volume') {
                            if (window.getNumericVolume(s.volume) === null) missing++;
                        } else if (field === 'changePct') {
                            if (!((s.changePct || '').trim())) missing++;
                        }
                    });
                    return missing;
                };
                const preCheck = {
                    today: { total: todayList.length, missingVolume: countMissing(todayList, 'volume'), missingPct: countMissing(todayList, 'changePct') },
                    yesterday: needYesterday ? { total: yesterdayList.length, missingVolume: countMissing(yesterdayList, 'volume') } : undefined,
                    dayBefore: needDayBefore ? { total: dayBeforeList.length, missingVolume: countMissing(dayBeforeList, 'volume') } : undefined
                };
                window._dbgLog('[NUMCAT-DEBUG] 猫抓预检 | currentDate=' + today + ' | 缺失快照=' + JSON.stringify(preCheck));

                const symbols = Array.from(allCodesSet).join(',');
                const todayYMD = today.replace(/-/g, '');
                const yesterdayYMD = yesterday.replace(/-/g, '');
                const dayBeforeYMD = dayBefore ? dayBefore.replace(/-/g, '') : '';

                // 构造 params（一次请求拿需要的所有日期；多天用 startdate+enddate，1次请求省额度）
                const reqDates = [];
                if (needDayBefore) reqDates.push(dayBeforeYMD);
                if (needYesterday) reqDates.push(yesterdayYMD);
                if (needToday) reqDates.push(todayYMD);
                const params = reqDates.length > 1
                    ? { symbols: symbols, startdate: reqDates[0], enddate: reqDates[reqDates.length - 1] }
                    : { symbols: symbols, tradedate: reqDates[0] };
                window._dbgLog('[NUMCAT-DEBUG] 点击猫抓 | currentDate=' + today + ' | yesterday=' + yesterday +
                    ' | dayBefore=' + (dayBefore || '(无)') + ' | opts=' + JSON.stringify({ fillToday: opts.fillToday, fillYesterday: opts.fillYesterday, fillDayBefore: opts.fillDayBefore, overwriteToday: opts.overwriteToday, overwriteYesterday: opts.overwriteYesterday, overwriteDayBefore: opts.overwriteDayBefore }) +
                    ' | codes=' + allCodesSet.size + ' | params=' + JSON.stringify(params));

                const dayCountText = reqDates.length === 3 ? '三天' : (reqDates.length === 2 ? '两天' : '单日');
                const todayFieldHint = opts.fillToday ? '；今日同时补竞价量+涨幅' : '';
                window.setApiStatus('numcatApiStatus', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，' + dayCountText + todayFieldHint + '）...', true);

                const fields = 'symbol,name,tradedate,auc_vol,auc_pct_chg';
                const result = await window.numcatApiPost('daily_auc', fields, params);

                // 解析返回数据
                // result.fields: ['symbol','name','tradedate','auc_vol','auc_pct_chg']
                // result.items: [['000001','平安银行','20260717', 12345, 2.5], ...]
                const fieldList = result.fields || [];
                const items = result.items || [];
                const dateRowCounts = {};
                const symbolIdx = fieldList.indexOf('symbol');
                const tradedateIdx = fieldList.indexOf('tradedate');
                const aucVolIdx = fieldList.indexOf('auc_vol');
                const aucPctIdx = fieldList.indexOf('auc_pct_chg');
                if (tradedateIdx >= 0) {
                    items.forEach(function(row) {
                        const td = String(row[tradedateIdx] || '').trim();
                        if (td) dateRowCounts[td] = (dateRowCounts[td] || 0) + 1;
                    });
                }
                window._dbgLog('[NUMCAT-DEBUG] 猫抓返回 rawItems=' + items.length + ' 各交易日行数=' + JSON.stringify(dateRowCounts) +
                    ' fields=' + JSON.stringify(fieldList));
                if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
                    window.setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
                    return;
                }

                // 按日期分组：YYYYMMDD -> { code: { vol: aucVol(万), pct: "+2.5%", rawPct } }
                const aucByDate = {};
                items.forEach(function(row) {
                    const code = String(row[symbolIdx] || '').trim();
                    const tradedate = String(row[tradedateIdx] || '').trim();
                    const aucVol = row[aucVolIdx];
                    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;
                    if (!aucByDate[tradedate]) aucByDate[tradedate] = {};
                    // auc_vol 单位是手，volume 字段单位是万（1万=100手），直接 ÷100 转万
                    const entry = { vol: Math.round(Number(aucVol) / 100) };
                    // auc_pct_chg 是数字（如 2.5 表示 +2.5%），转成 "+2.5%" 格式
                    if (aucPctIdx >= 0) {
                        const rawPct = row[aucPctIdx];
                        entry.rawPct = rawPct;
                        if (rawPct !== null && rawPct !== undefined && rawPct !== '') {
                            const n = Number(rawPct);
                            if (!isNaN(n)) {
                                entry.pct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
                            }
                        }
                    }
                    aucByDate[tradedate][code] = entry;
                });

                // 填充 volume / changePct
                // overwrite=true：有新数据就覆盖（无新数据保留原值，不清空）
                // overwrite=false：已有值就跳过（补全模式）
                let filledVolumeCount = 0;
                let filledPctCount = 0;
                let skippedCount = 0;
                // 阶段二 B 改造：收集字段级 patch，结束时调用 patchAuctionFieldBatch 上报，
                // 只携带本次猫抓真正改动的字段（volume，以及今天的 change_pct/note），
                // 不再像 pushAuctionDataToCloud 那样把当时内存里的 yest_volume 等其它字段
                // 一起带上——这正是原始 bug（先点猫抓再点同花顺互相覆盖）的触发点。
                const todayPatches = [];
                const yesterdayPatches = [];
                const dayBeforePatches = []; // 「连抓三天补全」前天的 patch 收集
                // 🔍[调试-诊断报告用] 记录本次猫抓请求，"今天"这个日期下，每只股票命中/未命中的原始情况，
                // 用于事后在诊断报告里还原"这次点击猫抓时，接口到底有没有给涨幅"，
                // 不必再靠翻云端历史记录推理。只记录 fillPct=true（即今天）那一轮。
                const todayFillLog = [];

                const fillVolume = function(list, dateStr, overwrite, fillPct, patchesArr) {
                    const ymd = dateStr.replace(/-/g, '');
                    const dayData = aucByDate[ymd] || {};
                    list.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const code = (s.code || scMap[s.stock.trim()] || '').trim();
                        const hasDayData = code && dayData[code] != null;
                        const dayEntry = hasDayData ? dayData[code] : null;
                        let volWritten = false;
                        let pctWritten = false;
                        let skipReason = '';

                        if (hasDayData) {
                            // volume：覆盖模式 或 当前缺失/为0 时写入（0 视为未抓取，允许覆盖）
                            const needVol = overwrite || window.getNumericVolume(s.volume) === null;
                            if (needVol) {
                                s.volume = String(dayEntry.vol);
                                volWritten = true;
                            }
                            // 涨幅：仅今天(fillPct=true)且接口返回了pct时处理
                            if (fillPct && dayEntry.pct) {
                                const needPct = overwrite || !((s.changePct || '').trim());
                                if (needPct) {
                                    s.changePct = dayEntry.pct;
                                    s.note = window.buildNoteFromFields(s.changePct, s.topics);
                                    pctWritten = true;
                                }
                            }
                        } else {
                            skipReason = code ? '接口返回结果里完全没有这只股票的数据(symbol未匹配)' : '缺代码映射，无法匹配';
                        }

                        // 只有真正发生改动时才生成 patch，避免字段级同步污染
                        if (volWritten || pctWritten) {
                            const patch = { stock: s.stock };
                            if (volWritten) patch.volume = s.volume;
                            if (pctWritten) {
                                patch.change_pct = s.changePct;
                                patch.note = s.note;
                            }
                            patchesArr.push(patch);
                            if (volWritten) filledVolumeCount++;
                            if (pctWritten) filledPctCount++;
                        } else if (!hasDayData) {
                            skippedCount++; // 接口无该股票数据，覆盖/补全模式下都跳过
                        }

                        if (fillPct) {
                            todayFillLog.push({
                                stock: s.stock, code: code,
                                hadDayData: hasDayData,
                                apiReturnedPct: dayEntry ? (dayEntry.pct || null) : null,
                                apiReturnedVol: dayEntry ? dayEntry.vol : undefined,
                                apiReturnedRawPct: dayEntry ? dayEntry.rawPct : undefined,
                                volWrittenThisTime: volWritten,
                                pctWrittenThisTime: pctWritten,
                                changePctAfter: s.changePct || '',
                                volumeAfter: s.volume || '',
                                reasonNotWritten: skipReason || (
                                    !dayEntry ? '接口返回结果里无该股票' : (
                                        !dayEntry.pct ? '接口未返回auc_pct_chg' : (
                                            !overwrite && (s.changePct || '').trim() ? '已有涨幅且非覆盖模式，未覆盖' : '未知'
                                        )
                                    )
                                )
                            });
                        }
                    });
                };

                if (needToday) {
                    fillVolume(todayList, today, !!opts.overwriteToday, true, todayPatches);   // 今天：填 volume + 涨幅
                    auctionData[today] = todayList;
                    // 🔍[调试-诊断报告用] 把本次猫抓请求的原始返回 + 逐只处理结果快照存入 localStorage，
                    // 供"运行诊断"读取展示。只保留最近一次，避免占用过多存储。
                    try {
                        localStorage.setItem('lastNumcatFillDebug_' + today, JSON.stringify({
                            requestedAt: new Date().toISOString(),
                            today: today,
                            overwrite: !!opts.overwriteToday,
                            requestedCodesCount: allCodesSet.size,
                            apiRawItemsCount: items.length,
                            apiRawItemsForToday: items.filter(function(row) {
                                return String(row[tradedateIdx] || '').trim() === todayYMD;
                            }).map(function(row) {
                                return { symbol: row[symbolIdx], name: row[1], tradedate: row[tradedateIdx],
                                    auc_vol: row[aucVolIdx], auc_pct_chg: (aucPctIdx >= 0 ? row[aucPctIdx] : undefined) };
                            }),
                            fillLog: todayFillLog
                        }));
                    } catch (e) {
                        console.error('保存 lastNumcatFillDebug 失败:', e);
                    }
                }
                // 同「两全/对比日昨成交量」的修复：needYesterday 场景下 yesterdayList 是
                // buildYesterdayListFromToday 用 todayList 名单造出来的，不能直接覆盖 auctionData[yesterday]，
                // 否则对比日原有、这次名单没覆盖到的股票会被冲掉，后续同步时误标记 in_watchlist=false 而消失。
                let shadowOnlyYesterdayStocks = [];
                let existingYesterdayList = null;
                if (needYesterday) {
                    fillVolume(yesterdayList, yesterday, !!opts.overwriteYesterday, false, yesterdayPatches); // 昨日：只填 volume
                    existingYesterdayList = (auctionData[yesterday] || []).slice();
                    const existingYesterdayNames = {};
                    existingYesterdayList.forEach(function(s) {
                        if (s && s.stock) existingYesterdayNames[s.stock.trim()] = true;
                    });
                    yesterdayList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const name = s.stock.trim();
                        if (!existingYesterdayNames[name]) return;
                        const target = existingYesterdayList.find(function(e) { return e.stock && e.stock.trim() === name; });
                        if (target) { target.volume = s.volume; }
                    });
                    shadowOnlyYesterdayStocks = yesterdayList.filter(function(s) {
                        return s && s.stock && !existingYesterdayNames[s.stock.trim()];
                    });
                    auctionData[yesterday] = existingYesterdayList;
                }

                // 「连抓三天补全」前天：与昨日完全同一套影子逻辑——只把 volume 合并回前天
                // 原有正式列表成员，前天原本没有的股票落影子记录（in_watchlist=false），
                // 不进前天第一页。
                if (needDayBefore) {
                    fillVolume(dayBeforeList, dayBefore, !!opts.overwriteDayBefore, false, dayBeforePatches); // 前天：只填 volume
                    const existingDayBeforeList = (auctionData[dayBefore] || []).slice();
                    const existingDayBeforeNames = {};
                    existingDayBeforeList.forEach(function(s) {
                        if (s && s.stock) existingDayBeforeNames[s.stock.trim()] = true;
                    });
                    dayBeforeList.forEach(function(s) {
                        if (!s || !s.stock) return;
                        const name = s.stock.trim();
                        if (!existingDayBeforeNames[name]) return;
                        const target = existingDayBeforeList.find(function(e) { return e.stock && e.stock.trim() === name; });
                        if (target) { target.volume = s.volume; }
                    });
                    auctionData[dayBefore] = existingDayBeforeList;
                }

                // 阶段四 Bug 5 修复：saveModule('auction') 已是 no-op（Bug 4），删除避免误导；
                // auctionData 即 _auctionMemCache（Bug 1+2），本地状态已由上面赋值更新
                window.invalidateTopicCache();

                // 阶段二 B：改用字段级 patch 上报，不再走整段 pushAuctionDataToCloud。
                // yesterdayPatches 同时包含"正式列表成员"和"影子记录"——对 patch 函数而言
                // 两者都是 upsert(date,stock) 定位 + 只写 volume，影子记录在 _auctionMemCache
                // 里新建时 in_watchlist 默认 false，正是预期行为；in_watchlist 字段不通过 patch 上报，
                // 由 syncAuctionListForDate 单独管理（清单改造项 2 边界问题）。
                if (todayPatches.length > 0) {
                    window.patchAuctionFieldBatch(today, todayPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch today ' + (e && e.message || e)); });
                }
                if (yesterdayPatches.length > 0) {
                    window.patchAuctionFieldBatch(yesterday, yesterdayPatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch yesterday ' + (e && e.message || e)); });
                }
                if (dayBeforePatches.length > 0) {
                    window.patchAuctionFieldBatch(dayBefore, dayBeforePatches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.patchAuctionFieldBatch dayBefore ' + (e && e.message || e)); });
                }

                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                // 三天模式显示分天结果，两天/单日保持原文案
                let resultText;
                if (opts.fillDayBefore) {
                    resultText = '✅ 连抓三天完成：竞价量+' + filledVolumeCount + ' / 涨幅+' + filledPctCount +
                        '（今日' + todayPatches.length + ' / 昨日' + yesterdayPatches.length + ' / 前日' + dayBeforePatches.length + ' 只），跳过 ' + skippedCount + ' 只无数据';
                    if (dayBeforeListWasEmpty) resultText += '（前日列表已用今日列表作为基础，新股票落影子记录）';
                } else {
                    const mode = (needToday && needYesterday) ? '昨日+今日' : (needToday ? '今日' : '昨日');
                    const action = (opts.overwriteToday || opts.overwriteYesterday) ? '覆盖' : '补全';
                    const yesterdayNote = (needYesterday && yesterdayListWasEmpty)
                        ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                        : '';
                    resultText = '✅ ' + mode + action + '：竞价量 ' + filledVolumeCount + ' / 涨幅 ' + filledPctCount + '，跳过 ' + skippedCount + ' 只无数据' + yesterdayNote;
                }
                window.setApiStatus('numcatApiStatus', resultText, true);
            } catch (err) {
                console.error('window.fetchAuctionFromNumcat 失败:', err);
                let msg = err && err.message ? err.message : '获取失败';
                if (msg.indexOf('Failed to fetch') >= 0) {
                    msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
                }
                window.setApiStatus('numcatApiStatus', '❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }

        // ================================================================
        // 接口诊断（早盘竞价 tab 独立版本）
        // 只读检查，不修改任何数据。用于排查"补全昨日成交量"（同花顺）和
        // "补全昨日竞价量"（猫抓）互相冲掉对方字段的问题：把当前内存里的
        // volume/yestVolume 真实取值、保存路径、保存按钮绑定、趋势图缓存
        // 一次性列出来，人工或截图/复制给开发者比对，不靠猜测。
        // 与热门股票 tab 的 runHotApiDiagnostics 完全独立，不共用任何函数、
        // 不读写 hotAuctionData / _hotFullRowCache 等热门股票的数据。
        // ================================================================
        export async function runAuctionApiDiagnostics() {
            const lines = [];
            const push = function(s) { lines.push(s); };
            const now = new Date();

            push('===== 早盘竞价 接口诊断报告 =====');
            push('生成时间：' + now.toLocaleString('zh-CN', { hour12: false }));
            push('');

            try {
                const sysToday = (typeof window._getLocalTodayStr === 'function') ? window._getLocalTodayStr() : '';
                const today = state.currentDate;
                const viewDate = today;
                const yesterday = window.getPreviousTradingDay(today);
                const dayBefore = yesterday ? window.getPreviousTradingDay(yesterday) : null;
                const dateOffsetNote = (sysToday && viewDate !== sysToday)
                    ? (viewDate > sysToday ? '【⚠️ 当前查看的是未来日期，尚未到交易日】' : '【当前查看的是历史日期】')
                    : '';
                push('【交易日】系统今天(sysToday)=' + (sysToday || '（无法确定）') + '　当前查看日期(viewDate)=' + viewDate + '　' + dateOffsetNote);
                push('　　　　  上一交易日(yesterday)=' + (yesterday || '（无法确定）'));
                push('　　　　  前两交易日(dayBefore)=' + (dayBefore || '（无法确定）'));
                push('');

                const auctionData = window.getAuctionData();
                const scMap = window._scMapCache || {};

                // ---- 今日列表体检 ----
                // 方案2：用 _auctionWatchlistIndex 判断正式成员，影子记录 = 不在索引里的行
                const _diagTodayWset = window._getAuctionWatchlistSet(today);
                const todayListRaw = (auctionData[today] || []).filter(function(s) { return s && s.stock; });
                const todayList = todayListRaw.filter(function(s) { return _diagTodayWset.has(s.stock.trim()); });
                const todayShadowCount = todayListRaw.filter(function(s) { return !_diagTodayWset.has(s.stock.trim()); }).length;
                push('【今日列表 ' + today + '】正式列表 ' + todayList.length + ' 只（原始 ' + todayListRaw.length + ' 只 | 影子记录 ' + todayShadowCount + ' 只）');
                let todayVolMiss = 0, todayYestMiss = 0, todayCodeMiss = 0;
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim();
                    if (!code) todayCodeMiss++;
                    if (window.getNumericVolume(s.volume) === null) todayVolMiss++;
                    if (window.getNumericVolume(s.yestVolume) === null) todayYestMiss++;
                });
                push('　　缺代码映射：' + todayCodeMiss + ' 只');
                push('　　缺竞价量(volume)：' + todayVolMiss + ' 只');
                push('　　缺成交量(yestVolume)：' + todayYestMiss + ' 只');
                push('　　逐只明细（股票 | 代码 | volume竞价量 | yestVolume成交量 | 涨幅）：');
                todayList.forEach(function(s) {
                    const code = (s.code || scMap[s.stock.trim()] || '').trim() || '(无)';
                    push('　　  ' + s.stock + ' | ' + code + ' | vol=' + (s.volume || '(空)') +
                         ' | yest=' + (s.yestVolume || '(空)') + ' | pct=' + (s.changePct || '(空)'));
                });
                push('');

                // ---- 观察组自动继承排查 ----
                // 🔍[调试] 专门排查"今日列表里凭空多出的股票"是否来自 ensureObservationStocks
                // （观察组自动继承：把上一交易日"竞/昨"高光达标股票自动加入今日列表）。
                // 逐一对照：今日正式列表里带 obsAutoAdded=true 标记的股票 vs 现在实时重新计算一遍
                // 上一交易日"竞/昨"高光集合，两者是否一致；不一致就说明标记是历史遗留、或计算口径变了。
                push('【观察组自动继承排查（window.ensureObservationStocks）】');
                try {
                    const obsMarkedRows = todayList.filter(function(s) { return s && s.obsAutoAdded === true; });
                    push('　　今日正式列表中带 obsAutoAdded=true 标记的股票：' + obsMarkedRows.length + ' 只');
                    if (obsMarkedRows.length > 0) {
                        obsMarkedRows.forEach(function(s) {
                            push('　　  ' + s.stock + ' | pct=' + (s.changePct || '(空)') + ' | volume=' + (s.volume || '(空)'));
                        });
                    }

                    if (yesterday && typeof window.getJingYestHighlightSetForDate === 'function') {
                        const rawMap = (typeof window.getJingYestStocksForDate === 'function') ? window.getJingYestStocksForDate(yesterday) : null;
                        const highlightSetNow = window.getJingYestHighlightSetForDate(yesterday);
                        push('　　现在重新计算 ' + yesterday + ' 的"竞/昨"高光集合（平行 + diff > 0）：');
                        push('　　　过滤前(Tier0) 共 ' + (rawMap ? rawMap.size : 0) + ' 只');
                        if (rawMap && rawMap.size > 0) {
                            rawMap.forEach(function(info, name) {
                                push('　　　　' + name + ' | diff=' + (info && info.diff) + ' | digitGap=' + (info && info.digitGap));
                            });
                        }
                        push('　　　过滤后(diff>0，即观察组应继承的名单) 共 ' + (highlightSetNow ? highlightSetNow.size : 0) + ' 只：' +
                             (highlightSetNow && highlightSetNow.size > 0 ? [...highlightSetNow].join('、') : '(无)'));

                        // 对照：标记为obsAutoAdded的股票，哪些不在"现在重算"的高光集合里（说明是历史遗留/口径变化）
                        const markedNames = new Set(obsMarkedRows.map(function(s) { return s.stock.trim(); }));
                        const staleMarked = [...markedNames].filter(function(n) { return !highlightSetNow || !highlightSetNow.has(n); });
                        const missingFromMarked = highlightSetNow ? [...highlightSetNow].filter(function(n) { return !markedNames.has(n); }) : [];
                        push('　　带标记但不在"现在重算"高光集合里的股票（' + staleMarked.length + ' 只，疑似历史遗留/口径已变化）：' +
                             (staleMarked.length > 0 ? staleMarked.join('、') : '(无)'));
                        push('　　在"现在重算"高光集合里但今日列表未标记obsAutoAdded的股票（' + missingFromMarked.length + ' 只，可能是人工已加入或其它路径加入）：' +
                             (missingFromMarked.length > 0 ? missingFromMarked.join('、') : '(无)'));
                    } else {
                        push('　　（无法重新计算：yesterday 未确定，或 window.getJingYestHighlightSetForDate 不存在）');
                    }

                    // localStorage 里记录的 obsAutoAdded_今日 集合，与内存里实际带标记的股票对照
                    try {
                        const lsObsAutoAdded = new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + today) || '[]'));
                        push('　　localStorage[obsAutoAdded_' + today + '] 记录：' + lsObsAutoAdded.size + ' 只：' +
                             (lsObsAutoAdded.size > 0 ? [...lsObsAutoAdded].join('、') : '(无)'));
                        push('　　localStorage[obsEnsured_' + today + ']（是否已跑过防重复标记）：' + (localStorage.getItem('obsEnsured_' + today) || '(未设置)'));
                    } catch (e) {
                        push('　　读取 localStorage obsAutoAdded 记录失败：' + e.message);
                    }
                } catch (e) {
                    push('　　观察组自动继承排查异常：' + e.message);
                }
                push('');

                // ---- 买入继承排查（ensureBoughtStocksForDate）----
                // 🔍[调试] 追踪"昨日买/持未卖 → 今日进入观察组显示持"的完整链路。
                // 对照两个数据源：getStocksData（股票列表页，权威来源）vs auctionData（竞价看板）。
                // 若某股票只在 auctionData 里有 bought=true 而 stocksData 没有，ensureBoughtStocksForDate
                // 读不到它，就不会补入今日观察组——这正是"昨日买未卖但今日没进观察组"的常见成因。
                push('【买入继承排查（window.ensureBoughtStocksForDate）】');
                try {
                    const _stocksData = (typeof window.getStocksData === 'function') ? window.getStocksData() : {};
                    const _prevTags = (yesterday && _stocksData[yesterday]) || [];
                    push('　　window.getStocksData[' + (yesterday || '?') + '] 共 ' + _prevTags.length + ' 条');
                    const _sdHolding = _prevTags.filter(function(s) { return s && s.name && s.sold !== true && (s.bought === true || s.hold === true); });
                    push('　　其中 bought/hold 未卖 共 ' + _sdHolding.length + ' 只：');
                    _sdHolding.forEach(function(s) {
                        push('　　  ' + (s.name || '').trim() + ' | bought=' + (s.bought === true) + ' | hold=' + (s.hold === true) + ' | sold=' + (s.sold === true));
                    });

                    const _aucPrev = (yesterday && auctionData[yesterday]) ? auctionData[yesterday] : [];
                    const _aucBoughtNames = _aucPrev.filter(function(s) { return s && s.bought === true && s.sold !== true; }).map(function(s) { return (s.stock || '').trim(); }).filter(Boolean);
                    push('　　对照 auctionData[' + (yesterday || '?') + '] bought=true未卖 共 ' + _aucBoughtNames.length + ' 只：' + (_aucBoughtNames.length > 0 ? _aucBoughtNames.join('、') : '(无)'));
                    const _leak = _aucBoughtNames.filter(function(n) { return !_sdHolding.some(function(s) { return (s.name || '').trim() === n; }); });
                    push('　　⚠️ 竞价看板有买但 stocksData 未记录（会丢失继承）共 ' + _leak.length + ' 只：' + (_leak.length > 0 ? _leak.join('、') : '(无)'));

                    try {
                        push('　　localStorage[obsBought_' + today + '] = ' + (localStorage.getItem('obsBought_' + today) || '(未设置)'));
                        push('　　localStorage[boughtEnsured_' + today + '] = ' + (localStorage.getItem('boughtEnsured_' + today) || '(未设置)'));
                        push('　　localStorage[obsAutoAdded_' + today + '] = ' + (localStorage.getItem('obsAutoAdded_' + today) || '(未设置)'));
                    } catch (e2) {
                        push('　　读取 localStorage 失败：' + e2.message);
                    }

                    // 今日 auctionData 中所有 obsAutoAdded=true 的股票快照（即继承补入的结果）
                    const _todayAuto = (auctionData[today] || []).filter(function(s) { return s && s.obsAutoAdded === true; });
                    push('　　今日 auctionData[' + today + '] 中 obsAutoAdded=true 共 ' + _todayAuto.length + ' 只：');
                    _todayAuto.forEach(function(s) {
                        push('　　  ' + (s.stock || '') + ' | bought=' + (s.bought === true) + ' | selected=' + (s.selected === true) + ' | sold=' + (s.sold === true));
                    });

                    // holdingNames 股票在今日 auctionData 的字段快照——坐实"在数据里但是影子记录被过滤"
                    const _holdingInToday = _sdHolding.map(function(s) { return (s.name || '').trim(); }).filter(Boolean);
                    const _todayRows = auctionData[today] || [];
                    push('　　holdingNames 股票在今日 auctionData[' + today + '] 的字段快照：');
                    _holdingInToday.forEach(function(n) {
                        const r = _todayRows.find(function(s) { return s && s.stock && s.stock.trim() === n; });
                        if (!r) {
                            push('　　  ' + n + ' → ❌ 不在今日 auctionData（缺失，会被补入）');
                        } else {
                            const _isFormal = _diagTodayWset.has(n);
                            push('　　  ' + n + ' | isFormal=' + _isFormal + ' | obsAutoAdded=' + (r.obsAutoAdded === true) + ' | selected=' + (r.selected === true) + ' | bought=' + (r.bought === true) + ' | sold=' + (r.sold === true) + (!_isFormal ? ' → ⚠️ 影子记录被渲染层过滤' : ''));
                        }
                    });
                } catch (e) {
                    push('　　买入继承排查异常：' + (e && e.message ? e.message : String(e)));
                }
                push('');

                // ---- 🔍[调试] 最近一次"猫抓补全"请求的原始返回快照 ----
                // 需要先点一次"猫抓补全"按钮，再点"运行诊断"，此段才有数据。
                // 直接展示猫抓接口这次对每只股票原始返回了什么（auc_pct_chg 有没有给），
                // 不再需要事后翻云端历史记录推理，一次性坐实涨幅缺失的真正原因。
                push('【最近一次猫抓补全请求快照（lastNumcatFillDebug）】');
                try {
                    const rawDebug = localStorage.getItem('lastNumcatFillDebug_' + today);
                    if (!rawDebug) {
                        push('　　（无记录：本次诊断前尚未点击过"猫抓补全"按钮，或该功能是刚更新的旧版本未生成记录）');
                    } else {
                        const dbg = JSON.parse(rawDebug);
                        push('　　请求时间：' + dbg.requestedAt);
                        push('　　overwrite模式：' + dbg.overwrite);
                        push('　　请求的股票代码总数：' + dbg.requestedCodesCount);
                        push('　　接口返回的原始记录总数（含昨日）：' + dbg.apiRawItemsCount);
                        push('　　接口返回中"今天"这个交易日的原始记录 ' + (dbg.apiRawItemsForToday || []).length + ' 条：');
                        (dbg.apiRawItemsForToday || []).forEach(function(r) {
                            push('　　　[原始] symbol=' + r.symbol + ' name=' + r.name + ' tradedate=' + r.tradedate +
                                 ' auc_vol=' + r.auc_vol + ' auc_pct_chg=' + (r.auc_pct_chg === undefined ? '(字段不存在)' : (r.auc_pct_chg === null || r.auc_pct_chg === '' ? '(空值)' : r.auc_pct_chg)));
                        });
                        push('　　逐只处理结果（fillLog，仅"今天"这一轮，共 ' + (dbg.fillLog || []).length + ' 条）：');
                        (dbg.fillLog || []).forEach(function(f) {
                            if (f.hadDayData === false) {
                                push('　　　✗ ' + f.stock + '(' + (f.code || '无代码') + ') | 未命中接口返回 | 原因：' + f.reasonNotWritten);
                            } else if (f.skippedReason) {
                                push('　　　- ' + f.stock + '(' + f.code + ') | 跳过：' + f.skippedReason + ' | 接口本次是否有这只股票的数据：' + f.hadDayData);
                            } else {
                                push('　　　' + (f.pctWrittenThisTime ? '✓' : '△') + ' ' + f.stock + '(' + f.code + ') | 接口返回auc_pct_chg=' +
                                     (f.apiReturnedPct === null ? '(空)' : f.apiReturnedPct) + ' | 接口返回auc_vol=' + f.apiReturnedVol +
                                     ' | 本次是否写入涨幅=' + f.pctWrittenThisTime + ' | 写入后changePct=' + (f.changePctAfter || '(空)') +
                                     (f.reasonNotWritten ? ' | 未写入原因：' + f.reasonNotWritten : ''));
                            }
                        });
                        // 专项对照：把这份快照里"接口未返回auc_pct_chg"的股票单独列出来，
                        // 直接对应截图里"看起来凭空多出来"的那几只，一眼就能看出是否是同一批。
                        const noApiPct = (dbg.fillLog || []).filter(function(f) { return f.hadDayData === true && !f.apiReturnedPct; });
                        push('　　★ 本次请求中，接口命中了股票但未返回auc_pct_chg（即涨幅字段本次确实是接口没给）的股票共 ' + noApiPct.length + ' 只：');
                        if (noApiPct.length > 0) {
                            push('　　　' + noApiPct.map(function(f) { return f.stock; }).join('、'));
                        }
                    }
                } catch (e) {
                    push('　　读取猫抓请求快照异常：' + (e && e.message ? e.message : String(e)));
                }
                push('');

                // ---- 对比日列表体检 ----
                // 方案2：用 _auctionWatchlistIndex 判断正式成员；对比日同时展示正式列表和全部数据
                const _diagYestWset = yesterday ? window._getAuctionWatchlistSet(yesterday) : new Set();
                const yesterdayListRaw = yesterday ? (auctionData[yesterday] || []).filter(function(s) { return s && s.stock; }) : [];
                const yesterdayList = yesterdayListRaw.filter(function(s) { return _diagYestWset.has(s.stock.trim()); });
                const yShadowCount = yesterdayListRaw.filter(function(s) { return !_diagYestWset.has(s.stock.trim()); }).length;
                push('【对比日列表 ' + (yesterday || '') + '】正式列表 ' + yesterdayList.length + ' 只（原始 ' + yesterdayListRaw.length + ' 只 | 影子记录 ' + yShadowCount + ' 只）');
                let yVolMiss = 0, yYestMiss = 0;
                yesterdayList.forEach(function(s) {
                    if (window.getNumericVolume(s.volume) === null) yVolMiss++;
                    if (window.getNumericVolume(s.yestVolume) === null) yYestMiss++;
                });
                push('　　缺竞价量(volume)：' + yVolMiss + ' 只');
                push('　　缺成交量(yestVolume)：' + yYestMiss + ' 只');
                push('　　逐只明细（股票 | volume竞价量 | yestVolume成交量）：');
                yesterdayList.forEach(function(s) {
                    push('　　  ' + s.stock + ' | vol=' + (s.volume || '(空)') + ' | yest=' + (s.yestVolume || '(空)'));
                });
                push('');

                // ---- 保存路径体检 ----
                push('【保存路径】');
                push('　　window.saveModule 函数存在：' + (typeof window.saveModule === 'function'));
                push('　　window.saveAuction 函数存在（表单提交绑定）：' + (typeof window.saveAuction === 'function'));
                const formEl = window._domGet('auctionForm');
                push('　　#auctionForm 表单元素存在：' + (!!formEl));
                push('　　#auctionForm onsubmit 绑定：' + (formEl && formEl.getAttribute('onsubmit') || '（未找到）'));
                try {
                    const raw = localStorage.getItem('stockApp_v42_auction');
                    push('　　localStorage[stockApp_v42_auction] 存在：' + (raw !== null) + '，长度=' + (raw ? raw.length : 0));
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        const todayInLS = (parsed[today] || []).length;
                        // [DATE-CLARIFY] auction 模块已改为纯云端 auction_watchlist + market_metrics + 内存缓存，
                        // 正常使用时不再向 stockApp_v42_auction 写入；该 key 仅保留旧数据供迁移/对账。
                        push('　　localStorage 中 ' + today + ' 的股票数：' + todayInLS +
                             (todayInLS === todayList.length
                                 ? '（与内存一致 ✅）'
                                 : '（与内存不一致，但属正常 ⚠️：auction 已拆分到云端 auction_watchlist / market_metrics 表，本地 key 不再更新；内存=' + todayList.length + '）'));
                    } else {
                        push('　　localStorage 中 ' + today + ' 的股票数：0（auction 已拆分到云端 auction_watchlist / market_metrics 表，本地 key 不再写入；内存=' + todayList.length + '）');
                    }
                } catch (e) {
                    push('　　localStorage 读取失败：' + e.message);
                }
                push('　　云端表 auction_watchlist 可用(window._auctionTableAvailable)：' + window._auctionTableAvailable + '，market_metrics 可用(window._marketMetricsTableAvailable)：' + window._marketMetricsTableAvailable);
                push('　　_syncState（云同步状态）：' + (window._syncState || '未知'));
                push('');

                // ---- 趋势图数据源体检 ----
                push('【趋势图数据源 window._auctionMemCache】');
                const todayCache = window._auctionMemCache[today] || [];
                const yestCache = yesterday ? (window._auctionMemCache[yesterday] || []) : [];
                push('　　' + today + ' 快照行数：' + todayCache.length);
                push('　　' + (yesterday || '') + ' 快照行数：' + yestCache.length);
                if (todayList.length > 0) {
                    const sample = todayList[0];
                    const cacheRow = todayCache.find(function(r) { return r.stock === sample.stock; });
                    push('　　抽样核对「' + sample.stock + '」：');
                    push('　　　内存 volume=' + (sample.volume || '(空)') + ' / 快照 volume=' + (cacheRow ? (cacheRow.volume || '(空)') : '（快照中无此股票）'));
                    push('　　　内存 yestVolume=' + (sample.yestVolume || '(空)') + ' / 快照 yest_volume=' + (cacheRow ? (cacheRow.yest_volume || '(空)') : '（快照中无此股票）'));
                    if (cacheRow && ((cacheRow.volume || '') !== (sample.volume || '') || (cacheRow.yest_volume || '') !== (sample.yestVolume || ''))) {
                        push('　　　⚠️ 内存与趋势图快照不一致，趋势图可能显示旧值，建议重新进入该 tab 或等待下次云端同步');
                    }
                }
                push('');

                // [BUG-FIX 2026-07-26] 新增：对比日 vs 当天 竞价量对比，
                // 帮助诊断"对比日和当天竞价量数值相同"的问题
                push('【对比日 vs 当天 竞价量对比（诊断数值相同问题）】');
                if (!yesterday) {
                    push('　　无法计算对比日（window.getPreviousTradingDay 返回空）');
                } else if (todayList.length === 0) {
                    push('　　当日列表为空，无法对比');
                } else {
                    let sameVolCount = 0;
                    let bothHaveVol = 0;
                    let todayOnlyVol = 0;
                    let yestOnlyVol = 0;
                    let neitherVol = 0;
                    const sameVolStocks = [];
                    todayList.forEach(function(s) {
                        const tVol = window.getStockHistoryValue(today, s.stock, 'volume', 'auction');
                        const yVol = window.getStockHistoryValue(yesterday, s.stock, 'volume', 'auction');
                        if (tVol !== null && yVol !== null) {
                            bothHaveVol++;
                            if (tVol === yVol) {
                                sameVolCount++;
                                if (sameVolStocks.length < 5) sameVolStocks.push(s.stock + '(都=' + tVol + ')');
                            }
                        } else if (tVol !== null && yVol === null) {
                            todayOnlyVol++;
                        } else if (tVol === null && yVol !== null) {
                            yestOnlyVol++;
                        } else {
                            neitherVol++;
                        }
                    });
                    push('　　当天有竞价量、对比日也有：' + bothHaveVol + ' 只');
                    push('　　当天有、对比日无：' + todayOnlyVol + ' 只');
                    push('　　当天无、对比日有：' + yestOnlyVol + ' 只');
                    push('　　两天都无：' + neitherVol + ' 只');
                    push('　　★ 两天竞价量相同的股票：' + sameVolCount + ' 只' + (sameVolStocks.length > 0 ? '（抽样：' + sameVolStocks.join('、') + '）' : ''));
                    if (sameVolCount > 0) {
                        push('　　　⚠️ 数值相同可能原因：');
                        push('　　　　1. API 确实返回了相同值（小盘股竞价量可能稳定）');
                        push('　　　　2. 之前的"覆盖"操作写入了相同值');
                        push('　　　　3. 云端 auction_watchlist / market_metrics 两个日期存的 volume 相同');
                        push('　　　建议：点击猫抓"全竞价量"重新抓取覆盖（需代理正常工作）');
                    }
                }
                push('');

                // ---- Realtime / 防抖 / 推送屏蔽窗口 体检 ----
                push('【Realtime 与推送状态】');
                push('　　window._justPushedAuction（是否处于"刚推送、屏蔽自身回显"窗口内）：' + window._justPushedAuction);
                push('　　window._auctionRealtimeTimer 是否有待执行的防抖拉取：' + (window._auctionRealtimeTimer !== null));
                push('　　说明：若两次点击补全按钮之间，window._justPushedAuction 曾经变回 false 且触发了云端拉取，');
                push('　　　　 云端当时若还没有另一字段的最新值，理论上会覆盖本地——本次已修复为');
                push('　　　　「云端有效值才覆盖，否则保留本地」，若仍复现请把本报告完整复制发出。');
                push('');

                push('===== 报告结束 =====');
            } catch (e) {
                push('');
                push('❌ 诊断过程出错：' + (e && e.message ? e.message : String(e)));
                if (e && e.stack) push(e.stack);
            }

            window.showAuctionDiagReport(lines.join('\n'));
            window.setApiStatus('auctionDiagStatus', '✅ 诊断完成，请复制报告发给开发者', true);
        }



        export function replaceConceptFromPaste() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : state.currentDate;
            const textarea = window._domGet('auctionPasteInput');
            const rawText = textarea ? textarea.value : '';
            const pasteText = rawText.trim();
            if (!pasteText) {
                window._domSetText('auctionImportStatus', '请先粘贴数据！');
                window._domSetColor('auctionImportStatus', '#dc2626');
                textarea && textarea.focus();
                return;
            }

            const lines = pasteText.split(/\r?\n/);
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];
            
            let replaceCount = 0;
            let notFoundCount = 0;
            const notFoundStocks = [];

            lines.forEach(line => {
                if (!line.trim()) return;
                
                const cells = line.split('\t');
                let stock = '';
                let newConcept = '';
                
                if (cells.length >= 2) {
                    stock = cells[0] ? cells[0].trim() : '';
                    newConcept = cells[1] ? cells[1].trim() : '';
                } else if (cells.length === 1) {
                    const parts = cells[0].trim().split(/\s+/);
                    if (parts.length >= 2) {
                        stock = parts[0];
                        newConcept = parts.slice(1).join('');
                    }
                }

                if (!stock || !newConcept) return;

                const existingIndex = existingList.findIndex(
                    item => item.stock && item.stock.trim() === stock
                );

                if (existingIndex >= 0) {
                    const existingNote = existingList[existingIndex].note || '';
                    let newNote = '';
                    
                    const bracketPattern = /(涨停|跌停|-?\d+\.?\d*%?)\(([^)]+)\)/g;
                    const matches = [...existingNote.matchAll(bracketPattern)];
                    
                    if (matches.length > 0) {
                        const lastMatch = matches[matches.length - 1];
                        const fullMatch = lastMatch[0];
                        const prefix = lastMatch[1];
                        const beforeLastMatch = existingNote.substring(0, lastMatch.index);
                        const afterLastMatch = existingNote.substring(lastMatch.index + fullMatch.length);
                        newNote = beforeLastMatch + prefix + '(' + newConcept + ')' + afterLastMatch;
                    } else {
                        const percentPattern = /(-?\d+\.?\d*%)/g;
                        const percentMatches = [...existingNote.matchAll(percentPattern)];
                        
                        if (percentMatches.length > 0) {
                            const lastPercentMatch = percentMatches[percentMatches.length - 1];
                            const beforeLastPercent = existingNote.substring(0, lastPercentMatch.index + lastPercentMatch[0].length);
                            const afterLastPercent = existingNote.substring(lastPercentMatch.index + lastPercentMatch[0].length);
                            newNote = beforeLastPercent + '(' + newConcept + ')' + afterLastPercent;
                        } else if (existingNote.includes('涨停')) {
                            newNote = existingNote.replace(/涨停/, '涨停(' + newConcept + ')');
                        } else if (existingNote.includes('跌停')) {
                            newNote = existingNote.replace(/跌停/, '跌停(' + newConcept + ')');
                        } else {
                            newNote = existingNote + '(' + newConcept + ')';
                        }
                    }
                    
                    existingList[existingIndex].note = newNote;
                    replaceCount++;
                } else {
                    notFoundCount++;
                    notFoundStocks.push(stock);
                }
            });

            if (replaceCount > 0) {
                window.setAuctionDateData(targetDate, existingList, 'replaceAuctionConceptFromPaste');
                window.saveData();
                window.invalidateTopicCache();
                window.markAuctionDirty(targetDate);
                window.scheduleCloudPush();
                
                // 同步更新已添加股票的收盘涨幅（只更新内存）
                existingList.forEach(item => {
                    if (item.stock && item.note) {
                        window.syncStockCloseFromAuction(item.stock, item.note);
                    }
                });
                
                // 同步题材，统一保存一次
                window.syncStockTopicsFromAuction();
                window.saveModule('stocks');
                
                window.renderAuctionForm();
                window.renderAuction();
                window.renderList();

                // 概念替换可能改变了note的格式，保险起见重新统计一次"最近多板"
                window.recalcDuibanFromAuction();
            }

            window._domSetValue('auctionPasteInput', '');
            let statusMsg = '✅ 替换了 ' + replaceCount + ' 条概念';
            if (notFoundCount > 0) {
                statusMsg += '，未找到: ' + notFoundStocks.slice(0, 3).join(', ') + (notFoundCount > 3 ? '...' : '');
            }
            window._domSetText('auctionImportStatus', statusMsg);
            window._domSetColor('auctionImportStatus', replaceCount > 0 ? '#059669' : '#dc2626');
            
            const submitBtn = window._domQuery('#auctionForm .submit-btn');
            if (submitBtn) {
                submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }





        // 渲染早盘竞价表单
