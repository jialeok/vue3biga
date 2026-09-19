import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
        // ===== stock_topics 表操作（题材库独立表）=====
        // 从 stock_topics 表全量读取，返回 {stockName: Set(topics)}
        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';
        import { refreshCoreTopicsFromCloud } from '../logic/topic/rules.js';
        // ★ 2026-09-18：题材库的「归一化别名索引」用 —— 见下方 buildNormalizedTopicIndex 的事故说明。
        //   纯函数叶子（logic/topics/stock-name.js），无反向依赖，不会造成循环导入。
        import { normalizeStockName } from '../logic/topics/stock-name.js';
        // ★ 2026-09-19：判「共享库里这只票的题材算不算【真实题材】」复用 note 层唯一那份判据
        //   （logic/note/helpers.js#isValidTopic：剔掉「题材35」这类占位编号、纯数字、单字符、
        //   「其它/---」等伪题材）。⛔ 不要在这里另写一份正则 —— 两处口径一旦不一致，
        //   「库里的题材算不算数」与「note 里的题材算不算数」就会给出不同答案（§6 破）。
        //   纯函数叶子（无任何 import），不会造成循环导入。
        import { isValidTopic } from '../logic/note/helpers.js';

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
        //
        // 【两种语义，调用方必须显式选择】★ 2026-09-18 修「删掉的题材过一会儿又自己恢复」
        //   · merge（默认）：新旧题材【并集累加】、只增不减。
        //       适用于「只补空缺、不覆盖」的自动回填/抓取链路（§22 保留原语义，零行为变化）。
        //   · replace（opts.mode === 'replace'）：以本次传入的题材为【最终结果】，可真删。
        //       适用于用户在编辑框里显式增删题材（双击竞价量列 → 个股修改题材）。
        //
        //   ⚠️ 事故根因（必读，别再改回单一 merge）：
        //      原实现只有 merge 语义 —— 删掉「人工智能」时 newTopics 里确实没有它，
        //      但 existingSet 仍留着它 → 写回云端还是「旅游,人工智能,大消费」。
        //      涨跌停看板（limit-pool.js）、竞价一字看板（yizi-board.js）都走
        //      getStockHistoryTopics 读这张表 ⇒ 表现为「怎么删都删不掉，只有早盘竞价自己看着变了」。
        //      且 buildTopicCache 是「先用 cloud 填、再 scan 历史只 add 不覆盖」，
        //      任何一次缓存重建都会把旧题材加回来 ⇒ 表现为「过一会儿又恢复了」。
        //
        //   一只股票完全可能同时归属好几个题材分类（第二页题材分类要看全部），不设数量上限。
        //
        // @param {string} stockName
        // @param {string[]} topicsArray 题材名数组
        // @param {string} [code] 股票代码；为空则 payload 不带 code 列（不动库里已有代码）
        // @param {{mode?: 'merge'|'replace'}} [opts] 写入语义，默认 merge
        // @returns {Promise<{ok:boolean, mode:string, topics:string[], skipped?:string}>}
        export async function pushStockTopicsToCloud(stockName, topicsArray, code, opts) {
            if (!stockName) return { ok: false, mode: 'skip', topics: [], skipped: 'no-stock' };
            const sb = getSupabase();
            if (!sb) throw new Error('Supabase 未就绪，无法写入共享题材库');
            const trimmedName = stockName.trim();
            const newTopics = (topicsArray || []).filter(t => t && t.trim()).map(t => t.trim());
            const replaceMode = !!(opts && opts.mode === 'replace');

            // §11 删除护栏：replace 模式收到空题材时【拒绝写】。
            //   语义澄清：编辑框里把括号内容清空 = 「清掉这一行的题材显示」，
            //   【不等于】「把这只股票从跨看板共享题材库里抹掉」——
            //   后者影响面覆盖三看板 + 全部历史日期，属不可逆的整列清空，
            //   必须由专门入口（带二次确认）执行，不能由一次清空编辑触发。
            if (replaceMode && newTopics.length === 0) {
                _dbgLog('[TOPIC-LIB] replace 模式收到空题材，拒绝清空共享库: ' + trimmedName);
                return { ok: false, mode: 'replace', topics: [], skipped: 'empty-topics-guard' };
            }

            // 计算最终题材列表
            let mergedTopics;
            if (replaceMode) {
                // 替换：本次传入即最终结果（去重保序），可真删
                mergedTopics = Array.from(new Set(newTopics));
            } else {
                // 合并：取云端/本地缓存里该股票已有的题材，与本次新题材求并集
                const existingSet = (state._cloudTopicsCache && state._cloudTopicsCache[trimmedName])
                    ? new Set(state._cloudTopicsCache[trimmedName])
                    : new Set();
                newTopics.forEach(function(t) { existingSet.add(t); });
                mergedTopics = Array.from(existingSet);
            }
            const topicsStr = mergedTopics.join(',');

            const row = {
                stock: trimmedName,
                topics: topicsStr,
                updated_at: new Date().toISOString()
            };
            // ★ 2026-09-18：code 为空时【整列不出现在 payload 里】，而不是写 `code: ''`。
            //   原因：本函数走 upsert(onConflict:'stock')，对**已存在**的行就是 UPDATE；
            //   若入参没带代码（如自动回填的调用方拿不到代码），写 `''` 会把库里已有的好代码**清空**。
            //   省略该列 = 不动这一列。带了代码时行为与以前完全一致。
            if (code) row.code = code;
            const { error } = await sb.from('stock_topics')
                .upsert(row, { onConflict: 'stock' });
            if (error) throw error;

            // 同步更新本地缓存，避免下次 buildTopicCache 时丢失
            if (!state._cloudTopicsCache) state._cloudTopicsCache = {};
            state._cloudTopicsCache[trimmedName] = new Set(mergedTopics);
            if (state._topicCacheBuilt && state._topicCache) {
                state._topicCache[trimmedName] = new Set(mergedTopics);
                if (replaceMode) {
                    // 替换语义必须【整体重建别名索引】。原因：原实现只对 bucket 做 add，
                    // 被删掉的题材会永远留在归一化表里 → 名称变体（如「万  科Ａ」/「七 匹 狼」）
                    // 仍能查到旧题材，而精确名那一路已经查不到了 ⇒ 同一个库两种答案（§6 破）。
                    // 全量重建 O(N)（~1100 只），只在用户手动编辑题材时触发，代价可忽略。
                    state._topicCacheNorm = buildNormalizedTopicIndex(state._topicCache);
                } else {
                    // ★ 别名索引同步累加（与上面这行同语义：并集、不清空、不覆盖已有题材）。
                    //    ⛔ 不能只删 key 等重建 —— 这里不触发重建，删了就永远查不到（静默丢题材）。
                    const nk = normalizeStockName(trimmedName);
                    if (nk) {
                        if (!state._topicCacheNorm) state._topicCacheNorm = Object.create(null);
                        let bucket = state._topicCacheNorm[nk];
                        if (!bucket) { bucket = state._topicCacheNorm[nk] = new Set(); }
                        mergedTopics.forEach(function(t) { bucket.add(t); });
                    }
                }
            }
            return { ok: true, mode: replaceMode ? 'replace' : 'merge', topics: mergedTopics };
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
         * 题材库是否【已从云端拉取过】（哪怕是「拉到了但确实是空的」）。
         *
         * 与 isTopicLibraryReady() 的区别（这两个判据用途不同，⛔ 不要混用）：
         *   · isTopicLibraryReady()  → 「题材分类结果可信吗？」为空即不可信 → 拒绝产出结论（龙头评选等）；
         *   · isCloudTopicsLoaded()  → 「现在写回题材库安全吗？」
         *     写回走 pushStockTopicsToCloud（读云端已有 → 合并 → 写回）。
         *     `_cloudTopicsCache` 为 **null** 表示【还没拉过】→ 合并会把「云端已有」读成空集 →
         *     写回时**覆盖掉线上已有题材**（真实数据丢失）。此时必须拒绝写。
         *     而 `{}`（拉过、确实是空的）→ 合并结果正确，可以放心写（否则全新库永远填不进东西）。
         *
         * @returns {boolean}
         */
        export function isCloudTopicsLoaded() {
            return !!state._cloudTopicsCache;
        }

        /**
         * 取一份【云端题材库的归一化别名索引快照】`{归一化名: Set(题材)}`。
         *
         * 用途：批量判断「这批股票在库里已有题材吗」（如 logic/topics/topic-sync.js 的
         * 「只补空缺、不覆盖」闸门）。调用方在**循环外取一次**共用，避免逐行重建 O(N) 索引。
         *
         * @returns {object|null} 未加载（=null，⛔ 与「加载到空库」严格区分）时返回 null
         */
        export function snapshotNormalizedLibraryIndex() {
            if (!state._cloudTopicsCache) return null;
            return buildNormalizedTopicIndex(state._cloudTopicsCache);
        }

        /**
         * 取一份「共享题材库里**已有权威题材**的股票名索引」`{exact:Set, norm:Set}`。
         *
         * 用途：给「从历史 note 反推题材」这条链路做闸门 —— 库里有权威题材的股票，
         * 一律以库为准，不再用历史 note 反推（详见 scanDataSourceForTopics 的注释）。
         *
         * 「权威」的判据（两层，缺一不可）：
         *   ① 该股票在 `_cloudTopicsCache` 里有键，且题材集合非空；
         *   ② 集合里**至少有一个真实题材**（`isValidTopic`）。只有「题材20/题材21」这类占位编号的
         *      条目**不算权威** —— 那种条目本身没有信息量，若让它把历史 note 反推挡掉，
         *      反而会让本来能显示的题材消失（实测 2026-09-19：1392 只库里约 8 只属此类）。
         *
         * §10 语义：库**没拉过**（`_cloudTopicsCache === null`）→ 返回空索引 = 「谁都不权威」
         *   → 所有股票继续走历史 note 反推（行为与改动前完全一致，不会把看板清空）。
         *
         * @returns {{exact:Set<string>, norm:Set<string>}} exact=原名，norm=归一化名（别名兜底）
         */
        export function snapshotAuthoritativeLibraryIndex() {
            const idx = { exact: new Set(), norm: new Set() };
            if (!state._cloudTopicsCache) return idx;
            Object.keys(state._cloudTopicsCache).forEach(function(name) {
                const set = state._cloudTopicsCache[name];
                if (!set || set.size === 0) return;
                let hasRealTopic = false;
                set.forEach(function(t) { if (!hasRealTopic && isValidTopic(t)) hasRealTopic = true; });
                if (!hasRealTopic) return;
                idx.exact.add(name);
                const nk = normalizeStockName(name);
                if (nk) idx.norm.add(nk);
            });
            return idx;
        }

        /** 该股票在共享库里是否已有【权威题材】（= 应当以库为准、不再用历史 note 反推） */
        export function isLibraryAuthoritativeFor(stockName, authIdx) {
            if (!stockName) return false;
            const idx = authIdx || snapshotAuthoritativeLibraryIndex();
            const key = String(stockName).trim();
            if (!key) return false;
            if (idx.exact.has(key)) return true;
            const nk = normalizeStockName(key);
            return !!(nk && idx.norm.has(nk));
        }

        /**
         * 把共享题材库铺进「{股票名: Set(题材)}」形状的索引**底座**。
         *
         * §6 单一真相：`buildTopicCache`（快路径）与 `stocks.js#_buildSlowTopicIndex`（慢路径）
         * 必须**同序同源** —— 都是「先用共享库铺底，再用历史 note 只补空缺」。
         * ⛔ 不要在两边各写一份铺底循环：两处顺序一旦分叉，同一个库会给出两种答案。
         *
         * @param {object} index 目标索引（原地写入）
         * @returns {object} 同一个对象（便于链式书写）
         */
        export function seedTopicIndexFromLibrary(index) {
            if (!index || !state._cloudTopicsCache) return index;
            Object.keys(state._cloudTopicsCache).forEach(function(name) {
                const topics = state._cloudTopicsCache[name];
                if (topics && topics.size > 0) {
                    index[name] = new Set(topics);
                }
            });
            return index;
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
        // 其中「从历史数据反推题材」= 共享库的【兜底】，不是第二真相：
        //
        // 🔴🔴 2026-09-19 修「题材在早盘竞价里删掉了，涨跌停/竞价一字看板还显示；过一会儿又自己回来」：
        //
        //   事故现场（用户原话）：
        //     「9月15日桂林旅游的涨停板看板没有和早盘竞价看板的桂林旅游题材同步，我在早盘竞价
        //       看板那里改了桂林旅游把人工智能去掉了，但是涨跌停看板那里还显示」
        //   实测数据（云端只读核查）：
        //     stock_topics.桂林旅游 = 「旅游,大消费」（写入时间 2026-09-19，即用户那次编辑已**写对了**）；
        //     auction_watchlist 的 **2026-09-09** 行 note 仍为 `+9.99%(旅游，人工智能)`。
        //   根因：本函数在「共享库已铺好」之后，又对每一行 note 的括号内容做**只增不减**的并入
        //     （`state._topicCache[name].add(t)`）⇒ 库里明明已经删掉的「人工智能」，被 09-09 那条
        //     **历史 note**（历史文本是当时的真实记录，不会因为今天的编辑而消失）重新加回内存缓存。
        //     而涨跌停看板、竞价一字看板的题材都走 `getStockHistoryTopics` → `_topicCache`
        //     ⇒ 表现就是「怎么删都删不掉 / 过一会儿（缓存重建）又恢复」。
        //     ⚠️ 与「写入端 merge 语义删不掉」是**两个独立病灶**：写入端已在 77f2028 修好（replace 语义），
        //       这里补的是【读取端】——只修写入端，读取端仍会把旧题材捞回来，等于没修。
        //
        //   ✅ 修法（§6 单一真相）：共享题材库是跨看板题材的**唯一权威来源**；
        //      「从历史 note 反推」降级为**只对库里还没有的股票**生效的兜底。
        //      判据实现见 snapshotAuthoritativeLibraryIndex()（要求库里至少有一个真实题材，
        //      纯占位条目如「题材20」不在此列，避免误伤）。
        //
        //   ⚠️ 代价（有意接受，写下来免得后人当成 Bug 再改回去）：
        //      当历史 note 里存在「库里没有的真实题材」时，该题材不再显示 —— 这正是「用户删掉的题材
        //      不许复活」的必然代价。实测影响面（2026-07-11~09-19 全量 + 1392 只题库）：
        //      492 只「库里有权威题材」的股票中，仅 **8 只**会少显示 1~4 个次要题材（约 1.6%），
        //      其余「库无该股 / 库只有占位题材」的股票**行为完全不变**。
        //      这 8 只在用户下次编辑该股题材时会自愈（编辑会以本次题材为准整表写回共享库）。
        export function scanDataSourceForTopics(dataSource) {
            const TOPIC_CACHE_DAYS = 66;
            const allDates = Object.keys(dataSource).sort();
            const recentDates = allDates.length > TOPIC_CACHE_DAYS
                ? allDates.slice(-TOPIC_CACHE_DAYS)
                : allDates;
            // 库权威索引：整轮只建一次（O(库规模)），不要在逐行里反复算
            const authIdx = snapshotAuthoritativeLibraryIndex();
            recentDates.forEach(date => {
                const dayList = dataSource[date] || [];
                dayList.forEach(item => {
                    if (!item.stock) return;
                    const name = item.stock.trim();
                    // 🔴 库权威闸门：共享库已有该股题材 ⇒ 历史 note 不再参与（否则删掉的题材必复活）
                    if (isLibraryAuthoritativeFor(name, authIdx)) return;
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

        // ===== ★ 归一化别名索引（2026-09-18 新增，修「明明库里有题材却显示无题材」）=====
        //
        // 事故形态（同一个库、同一只票、两条链路给出不同写法）：
        //   当日名单（涨停池 / 猫抓 / 同花顺）       共享题材库 stock_topics
        //   七 匹 狼                              七匹狼
        //   万  科Ａ                              万科A
        //   远 望 谷                              远望谷
        //   → `state._topicCache[名称]` 精确匹配失败 → 看板判「无题材」→
        //     用户以为库里没这只票 → 手动重复导入（正是用户抱怨「那么麻烦」的一部分根因）。
        //
        // 为什么用【别名索引】而不是直接改原索引的键：
        //   原索引 `_topicCache` 的键还被别处（含展示用的原始名）依赖，改键会牵动展示口径；
        //   别名索引是**纯增量**——原索引一个键都不动，只在精确查不到时多查一次归一化表。
        //   对库里 1131 只里名称本就规范的绝大多数（实测 1128 只）零影响，只救回格式变体。
        //
        // ⚠️ 归一化只在【查不到】时启用（精确优先）：万一真有两只股票归一化后同名（理论上不存在），
        //    精确命中那一路会先返回，不会把两只票的题材混在一起。
        //
        // @param {object} cache 形如 { 股票名: Set<题材> }（_topicCache / 慢路径索引同构）
        // @returns {object} 形如 { 归一化名: Set<题材> }（同名合并为并集 —— 同一只票的不同写法）
        export function buildNormalizedTopicIndex(cache) {
            const idx = Object.create(null);
            if (!cache) return idx;
            Object.keys(cache).forEach(function(name) {
                const set = cache[name];
                if (!set || set.size === 0) return;
                const key = normalizeStockName(name);
                if (!key) return;
                let bucket = idx[key];
                if (!bucket) { bucket = idx[key] = new Set(); }
                set.forEach(function(t) { bucket.add(t); });
            });
            return idx;
        }

        /**
         * 按股票名读题材（精确优先 → 归一化兜底）。读不到返回 null（⛔ 不返回空 Set 冒充「这只票没题材」）。
         *
         * ⚠️ 只在 `_topicCache` 已构建时走这条路；未构建请走慢路径（见 logic/stocks/stocks.js）。
         *
         * @param {string} stockName
         * @returns {Set<string>|null}
         */
        export function lookupTopicsByName(stockName) {
            if (!stockName) return null;
            const key = String(stockName).trim();
            if (!key) return null;
            if (!state._topicCacheBuilt || !state._topicCache) return null;
            const exact = state._topicCache[key];
            if (exact && exact.size > 0) return exact;
            const nk = normalizeStockName(key);
            const norm = (nk && state._topicCacheNorm) ? state._topicCacheNorm[nk] : null;
            if (norm && norm.size > 0) return norm;
            return null;
        }

        export function buildTopicCache() {
            if (state._topicCacheBuilt && state._topicCache) return state._topicCache;
            state._topicCache = {};

            // 第一步：共享库铺底（§6 权威来源）。与慢路径 _buildSlowTopicIndex 同源同序，见 seedTopicIndexFromLibrary。
            seedTopicIndexFromLibrary(state._topicCache);

            const TOPIC_CACHE_DAYS = 66;
            // 第二步：只对「共享库还没有的股票」用历史 note 兜底（库有权威题材的会被闸门直接跳过，
            // 否则历史 note 里删不掉的旧题材会把库里的结果又加回来 —— 见 scanDataSourceForTopics 的注释）。
            scanDataSourceForTopics(state._auctionMemCache || {});
            scanDataSourceForTopics(state._hotAuctionData || {});
            // ⚠️ 别名索引必须在 `_topicCache` **全部填完之后**再建（含上面两个 scanDateSource 的写入），
            //    否则只索引到云端库那一半，从历史 note 解析出来的题材享受不到归一化兜底。
            state._topicCacheNorm = buildNormalizedTopicIndex(state._topicCache);
            state._topicCacheBuilt = true;
            return state._topicCache;
        }

        export function invalidateTopicCache() {
            state._topicCache = null;
            // ⚠️ 归一化别名索引必须【一起失效】。
            //    漏掉它 = 留着上一版数据的别名索引 → 后续精确查不到时用归一化兜底，
            //    会把【陈旧题材】返回给调用方（比读失败更隐蔽的一类错值，§22）。
            state._topicCacheNorm = null;
            state._topicCacheBuilt = false;
            state._topicCacheVersion = (state._topicCacheVersion || 0) + 1;
            state._topicCacheInvalidateCount = (state._topicCacheInvalidateCount || 0) + 1;
            const __now = performance.now();
            if (state._topicCacheLastInvalidateTs && (__now - state._topicCacheLastInvalidateTs) < 2000) {
                _dbgLog('[PERF-DEBUG] 题材缓存失效过于频繁：距上次失效仅 ' + (__now - state._topicCacheLastInvalidateTs).toFixed(0) + 'ms（累计失效 ' + state._topicCacheInvalidateCount + ' 次）来源: ' + ((new Error()).stack ? (new Error()).stack.split('\n')[2] : '?'));
            }
            state._topicCacheLastInvalidateTs = __now;
        }