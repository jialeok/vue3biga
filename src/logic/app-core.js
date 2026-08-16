import { state } from './app-state.js';
import { _bindApi } from './app-core-api.js';
import { showToast } from '../composables/useToast.js';
import { fuyaoApiGet, tickerToThscode, LADDER_THSCODE } from '../data/api/fuyao-proxy.js';
import { numcatApiPost } from '../data/api/numcat-proxy.js';
import { normalizeAuctionNotes, pullAuctionFromTable, setAuctionDateData, _setInvalidateTopicCacheFn } from '../data/auction-data.js';
import { _dbgLog, _dbgLogVerbose } from '../data/debug-log.js';
import { pushHotTrendsToCloud } from '../data/hot-stocks.js';
import { pushJiwangNow, scheduleJiwangPush } from '../data/jiwang-data.js';
import { _closeAuctionShield, _openAuctionShield, _initAuctionMemCache } from '../data/session-and-shield.js';
import { loadCloudStockCodeMap, upsertStockCodeMap } from '../data/stock-code-map.js';
import { buildTopicCache, invalidateTopicCache, loadCloudTopics, pushStockTopicsToCloud, scanDataSourceForTopics } from '../data/stock-topics.js';
import { _moduleKey, getJiwangData, getNumericVolume, getStocksData, getSupabase, loadAllData } from '../data/supabase-client.js';
import { remainingBoards } from '../data/remaining-boards.js';
import { _addAuctionWatchlistMember, _extractWatchlistNamesFromRows, _getAuctionWatchlistSet, _setAuctionWatchlistForDate, getStockHistoryValue } from '../data/watchlist-and-metrics.js';
import { getJingYestHighlightSetForDate, getJingYestStocksForDate } from './auction/sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from './auction/stock-sync.js';
import { getStats } from './jiwang/helpers.js';
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from './note/helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from './scope/helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from './tagTitles/rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from './date/trading-day-helpers.js';
// §16 域拆分：纯日期工具已迁至 ./date/date-helpers.js（import 供本模块内部调用，re-export 供外部调用点零破坏）
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from './date/date-helpers.js';
export { getPreviousDate, getNextDate } from './date/date-helpers.js';
import { getNthPreviousTradingDay, recalcDuibanFromAuction, renderAuction, renderBidding, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, setApiStatus, showNumcatChoiceModal } from './ui-bridge.js';
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from './workflows/auction-sync.js';
import { useAuctionStore, _bindUiFns } from '../stores/auctionStore.js';
import { initAuctionTags } from '../stores/auctionTagStore.js';
import { useUiStore } from '../stores/uiStore.js';
// §16 修复：域函数迁至各域模块后，原 `export { ... } from` re-export 不会在本模块创建局部绑定；
// 而本模块 _bindApi 注册（第 786 行）与内部调用仍以这些名字作为局部变量引用，导致模块求值期
// ReferenceError（表现为浏览器「getAuctionData is not defined」→ 整页空白）。
// 故在此显式 import（与上方 date-helpers 的 import+export 写法一致），下方 re-export 行保留供外部调用点零破坏。
import { getBiddingData } from './bidding/bidding.js';
import { getRankData } from './rank/rank.js';
import { getMultiData } from './multi/multi.js';
import { getPatternData } from './pattern/pattern.js';
import { getTagTitlesData } from './tagTitles/tagTitles.js';
export { getTagTitlesData } from './tagTitles/tagTitles.js';
import { markJiwangDirty, getTodayJiwang } from './jiwang/jiwang.js';
import { searchTickerCodeByName, autoCompleteMissingStockCodes, importStockCodeMap, extractCodeFromFuyaoItem, getStockHistoryTopics, replaceConceptFromPaste } from './stocks/stocks.js';
import { getAuctionData, getTodayAuction, getTodayGroupList, markAuctionDirty, patchAuctionField, patchAuctionFieldBatch, _sanitizeAuctionPatch, _splitAuctionPatch, _mergeAuctionPatchLocal, clearAuctionDateData, deleteAuctionDateData, mergeAuctionDateRows, clearAllAuctionDates, repairAuctionInWatchlistForDate, reconcileAuctionWatchlistFromLocalStorage, reconcileAuctionWatchlist, backupAuctionData, rollbackAuctionData, importAuctionFromPaste, parseVolumeOnlyText, splitHistoryFillLine, importAuctionHistoryFill, fetchLadderConstituentsMain, fetchDayVolumes, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs, _fillTodayYesterdayVolumeFromThsImpl, fillYesterdayYesterdayVolumeFromThs, _fillYesterdayYesterdayVolumeFromThsImpl, fetchChangePctFromThs, _fetchChangePctFromThsImpl, fillAuctionHistoryGapPctFromThs, fillAuctionHistoryGapYestVolumeFromThs, fillYesterdayAuctionFromNumcat, fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat, fetchFiveDaysAuctionFromNumcat, fillTopicsFromNumcat, fetchMonitorWarningFromNumcat, fetchAuctionFromNumcat, AUCTION_WATCHLIST_FIELDS, AUCTION_METRICS_FIELDS, AUCTION_PATCHABLE_FIELDS, _auctionFirstClearDumped } from './auction/auction.js';
import { getHotspotData, getHotAuctionData, _openHotAuctionShield, _closeHotAuctionShield, _sanitizeHotPatch, _splitHotPatch, _mergeHotPatchLocal, patchHotField, patchHotFieldBatch, backupHotStocksData, importHotFromPaste, replaceHotConceptFromPaste, HOT_WATCHLIST_FIELDS, HOT_METRICS_FIELDS, HOT_PATCHABLE_FIELDS } from './hotspot/hotspot.js';
// §42 解环：以下共享工具/常量迁至 ./shared/core-shared.js，app-core 仅 import + re-export（行为不变），供内部调用与外部调用点零破坏。
import { getGroupData, _getAuctionStore, saveModule, scheduleCloudPush, saveData, _dumpAuctionSnapshot, _guardStack, _guardAssertDate, setBtnLoading, MODULE_KEYS } from './shared/core-shared.js';
export { getGroupData, _getAuctionStore, saveModule, scheduleCloudPush, saveData, _dumpAuctionSnapshot, _guardStack, _guardAssertDate, setBtnLoading } from './shared/core-shared.js';
// §16 拆分：启动期初始化副作用已迁至 app-core-init.js（initAppCore）。
import { initAppCore } from './app-core-init.js';
export { initAppCore };
// 重构（Phase 5 彻底）：导入期（Pinia 尚未激活）安全读取当前日期，避免模块顶层求值抛错。
export function _uiDateSafe() { try { return useUiStore().currentDate; } catch (e) { return ''; } }


        // 热门股票渲染：复用 renderAuction 底层逻辑，dataSource='hot'
        

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
        
        // 手动触发入口（控制台执行 reconcileAuctionWatchlist() 可重新跑一次诊断，忽略已执行标志）。
        // 注意：即使 force=true，也只会打印"本来会命中哪些股票"，不会再写云端。
        



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
        
        

        // 拆表后字段归属：
        //   hot_stocks：note, topics, selected, bought, sold, fixed, code
        //   market_metrics(scope='hot')：volume, yest_volume, change_pct, code
        // 公共字段 code 同时写入两张表。
        
        
        

        

        

        // 只把 patch 里出现的字段 merge 进 _hotFullRowCache 对应行；不存在则新建
        // 方案2：新建行不设 in_watchlist，正式/影子身份由 _hotWatchlistIndex 独立判断
        

        // 单条字段级写入的语法糖
        

        // 核心函数：批量字段级 upsert，按字段归属拆分到 hot_stocks / market_metrics(scope='hot')。
        
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
        
        
        

        // 从调用方传入的 patch 对象中，只挑出白名单内、且确实存在（!== undefined）的字段。
        // 之所以要求"确实存在"而不是"值为真"，是因为 false/''/0 都是合法的业务值
        // （比如 selected: false 也是一次有意义的字段更新，不能被过滤掉）。
        

        // 把 clean patch 拆成两张表各自的 patch。
        

        // 本地 merge：只把 clean patch 里出现的字段写进 _auctionMemCache 对应行，
        // 不存在的行则新建（方案2：新建行不携带 in_watchlist 字段，正式/影子身份由
        // _auctionWatchlistIndex 独立判断；"新建"只可能发生在单字段补数据场景——
        // 正式列表成员的创建/移除仍由 syncAuctionListForDate 负责）。
        // 不做整个数组替换、不做整个对象替换，只动被点名的字段。
        

        // 单条字段级写入：只上报/只覆盖 patch 里出现的字段。
        // date: 'YYYY-MM-DD'；stock: 股票名；patch: 形如 {volume: 'xxx'} 或 {yest_volume: 'xxx'}
        // 返回 {ok: true} 或 {ok: false, error}，调用方按需处理失败（沿用现有代码里
        // "推送失败仅 console.warn、不阻断主流程"的一贯风格，不在此函数内部强行抛出阻断 UI）。
        

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
        
        // ════════════════════════════════════════════════════════════════
        // 阶段一新增结束
        // ════════════════════════════════════════════════════════════════




        // 注：下方两个 auction 一次性迁移函数（migrateAuctionToTable / migrateAuctionDataToNewTables）已抽离至 src/data/legacy-migration.js（架构规范 §13 Migration / §16 纯 Vue3 红线），本文件不再承载迁移逻辑。


        // 手动拉取云端数据（点击云朵图标触发）
        export async function manualPullCloud() {
            try {
                await pullFromCloud();
                // §6：allData 为内存 cache（非真相源），此处为重建入口：清空后由 loadAllData() 重建。
                //     注：state._rankMemCache 等各域缓存为独立字段，不受 allData=null 连坐（rank 已解耦）。
                state.allData = null; loadAllData();
                renderList(); renderJiwang(); renderRank(); renderAuction();
                renderMulti(); renderHotspot(); renderPattern(); renderBidding();
                renderDuiban();
                renderEmotionBoard();
                if (typeof renderEtf === 'function') renderEtf();
            // 预加载云端题材库（非阻塞，完成后重建缓存并刷新第二页）
            loadCloudTopics().then(function() { invalidateTopicCache(); buildTopicCache(); renderAuction(); }).catch(function() {});
            // 重新加载云端股票代码映射
            loadCloudStockCodeMap().then(function() { if (typeof renderAuction === 'function') renderAuction(); }).catch(function() {});
            } catch (e) {
                _dbgLog('[AUCTION-ERR] manualPullCloud ' + (e && e.message || e));
            }
        }

        // ============================================================
        // 云端数据推送（防抖，操作停止 2 秒后触发）
        // ============================================================

        // 记录"确实发生过增删股票操作"的 auction 日期。
        // 只有被标记过的日期，在 pushToCloud 合并云端数据时才允许用本地名单覆盖云端，
        // 避免仅仅因为翻看某个历史日期（currentDate 指向它）就被误判为"允许增删"。
        // [已迁至 app-core-init.js initAppCore] auction dirty-date Set 初始化
        

        // 记录"jiwang 数据确实被改动过"的日期，saveData() 据此判断是否需要
        // 推送该日期到 jiwang_data 表，避免每次 saveData()（可能因为改股票、改题材等
        // 与 jiwang 无关的操作触发）都无谓地 upsert 一次 jiwang_data。
        // [已迁至 app-core-init.js initAppCore] jiwang dirty-date Set 初始化
        

        // ============================================================
        // 集中写入守卫 API（harden-auction-date-isolation）
        // 所有对 _auctionMemCache[date] 的写入/删除/整段替换/合并一律走这里。
        // 统一记录 [AUCTION-GUARD] 日志（targetDate、before/after 行数、source、调用栈前5帧），
        // 校验 date 非空，对单日 source 断言 date === auctionStore.currentDate（不一致只警告不阻断）。
        // ============================================================
                
        
        
        



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
        _computeBeijingToday = _computeBeijingToday;

        export function initApp() {
            initAppCore();
            // [ISSUE#1 修复] 启动默认落到"今天"：pullFromCloud 可能更新过 currentDate，
            // 这里重新读取 localStorage，但只有"恰为今天"才沿用，否则一律以北京时间为准
            // 重置为今天，避免打开后停在 8/5 等旧日期、并向前串数据（"未来的日期也继承 8/5"）。
            const _bt = _computeBeijingToday();
            const savedDate = localStorage.getItem('lastEditedDate_' + state.DATA_VERSION);
            if (savedDate && savedDate === _bt) {
                setCurrentDate(savedDate);
            } else {
                setCurrentDate(_bt);
            }
            // 触发原有的 DOMContentLoaded 逻辑（已绑定在页面底部）
            if (typeof _appInit === "function") _appInit();
            // §8 合规：启动拉取云端竞价标签（Supabase 持久化真相，跨设备不丢）
            initAuctionTags();
        }

        // [已迁至 app-core-init.js initAppCore] DATA_VERSION 初始化

        // 一次性清理：早期测试阶段遗留的陈旧 lastEditedDate（如 2025-01-02）会导致
        // 应用一直卡在那个日期。这里清除"去年今日"之前的值，让它退回默认走"今天"。
        // 只做一次判断、直接清除 key，不做动态阈值计算（之前的动态阈值方案因为在
        // initApp()/_appInit() 等多处各自独立读取同一个 key，顺序上互相覆盖，没有真正生效）。
        // [§16 修复] 原实现为顶层 IIFE，违反"app-core 不得无限增长"红线，已内联为模块顶层语句。
        // [已迁至 app-core-init.js initAppCore] 陈旧 lastEditedDate 清理

        // 统一日期写入口：同时更新全局 currentDate 与响应式 auctionStore.currentDate，
        // 杜绝"全局已切、store 未跟"导致的跨日期写错位（fetchLadderConstituentsMain 等以
        // auctionStore.currentDate 为 targetDate，store 滞后会把今天的数据写到旧日期）。
        // 不在此处做 localStorage 持久化——persist 仍由 _persistCurrentDateAsLastEdited 负责，
        // 以保留 jumpFromPage3ToPage2 等"仅切内存不 persist"的语义。
        export function setCurrentDate(newDate) {
            // [DATE-SWITCH] 记录所有日期切换入口，便于排查跨日期写/渲染串数据问题
            if (typeof _dbgLog === 'function') {
                const stack = (new Error().stack || '').split('\n').slice(2, 5).join(' <- ');
                _dbgLog('[DATE-SWITCH] 切换到 ' + newDate + ' | 来源: ' + stack);
            }
            useUiStore().currentDate = newDate;
            if (typeof _getAuctionStore() !== 'undefined' && _getAuctionStore()) {
                _getAuctionStore().currentDate = newDate;
            }
        }
        export function getCurrentDate() { return useUiStore().currentDate; }
        // [已迁至 app-core-init.js initAppCore] 启动诊断日志

        // [已迁至 app-core-init.js initAppCore] isStrengthSortEnabled 初始化

                export function _migrateFromV41() {
            const oldData = localStorage.getItem('stockAppData_v41');
            if (!oldData) return false;
            try {
                const parsed = JSON.parse(oldData);
                MODULE_KEYS.forEach(key => {
                    const val = parsed[key];
                    if (val !== undefined) {
                        localStorage.setItem(_moduleKey(key), JSON.stringify((key === 'holidays' || key === 'tradingDays') ? (val || []) : (val || {})));
                    }
                });
                localStorage.setItem(_moduleKey('_migrated'), '1');
                localStorage.removeItem('stockAppData_v41');
                return true;
            } catch (e) {
                return false;
            }
        }

        export { getRankData } from './rank/rank.js';

        export { getPatternData } from './pattern/pattern.js';
        
        // [已迁至 app-core-init.js initAppCore] currentFilter/isStockListCollapsed/editingId/topicAutoFilled 初始化

        // 判断是否为休市日
        export function isMarketClosed(d) {
            return !isTradingDay(d);
        }

        // 获取下一个交易日
        export function getNextTradingDay(dateStr) {
            let date = new Date(dateStr);
            date.setDate(date.getDate() + 1);
            
            while (isMarketClosed(date.toISOString().split('T')[0])) {
                date.setDate(date.getDate() + 1);
            }
            
            return date.toISOString().split('T')[0];
        }

        // 获取星期几（已迁至 ./date/date-helpers.js）


        // 备份早盘竞价数据（用于撤回）
        // type: 'import' 导入时备份, 'save' 保存时备份
        // 备份早盘竞价数据（用于撤回）
        // 只备份"这次操作实际改动的那一天"，不再备份最近30天范围。
        // 这样撤回时只会精准恢复这一天，彻底不会影响其它任何日期的历史数据。
        // date 参数：这次操作影响的具体日期，不传则默认当天（currentDate）
        

        // 撤回早盘竞价数据
        // 只精准恢复被备份的那一天，不碰其它任何日期

// 获取前一天/后一天日期（已迁至 ./date/date-helpers.js）

        // 获取当日股票数据
        export function getTodayData() {
            return getStocksData()[useUiStore().currentDate] || [];
        }

        // 获取当日记忘数据
        

        // 获取分组数据（早盘竞价 / 热门股票），通过 dataSource 切换数据源
        // 'auction' 直接返回模块级独立内存缓存 _auctionMemCache（阶段四 Bug 1 修复），
        // 不再走 loadAllData().auction —— 后者虽然阶段四 Bug 2 修好后也指向 _auctionMemCache，
        // 但这里直接返回可以避开 loadAllData 的初始化副作用，并明确"渲染读的就是 patch 写的那份"。
        // 'hot' 读 _hotAuctionData 本地缓存

        // 获取早盘竞价数据（向后兼容：所有现有调用点不传参，行为不变）
        

        // 获取今日早盘竞价数据
        // 返回数组的浅拷贝，防止外部修改意外影响原始数据，确保日期间数据隔离
        // 方案2：行对象不再携带 in_watchlist 字段；正式成员由 _auctionWatchlistIndex[date]
        //   独立 Set 判断。_auctionMemCache[date] 同时存正式成员和影子记录（仅供趋势图
        //   历史查询），渲染/统计/批量操作都只应看到正式列表。
        

        // 获取今日指定分组（早盘竞价 / 热门股票）数据，供渲染函数按 dataSource 复用
        // 返回数组的浅拷贝，防止外部修改意外影响原始数据，确保日期间数据隔离
        // 方案2：auction 分组用 _auctionWatchlistIndex 判断正式成员；hot 分组天然只含正式成员。
        

                                



        // ============================================================
        // 热门股票独立函数集合（与早盘竞价完全分离，只读写 _hotAuctionData + hot_stocks 表）
        // 方案 3.2：复制原函数 → 改名 → 改数据源 → 改云端同步
        // ============================================================

        // 热门股票专用数据源（不共用 getGroupData，避免任何耦合）
        







        // 备份热门股票数据（用于撤回，独立 localStorage key）
        // 保留：被下方 importHotFromPaste（活路径，AI 视觉粘贴导入）调用，非死代码。
        

        // AI 视觉粘贴导入热门股票（保留：经 app-core-api → ai-vision-import → AuctionEditModal 可达）
        

        // 替换概念（热门股票独立版本）
        


        // 历史数据补录（热门股票独立版本）
        

        // 自动补全当前日期指定分组（auction/hot）下缺失代码的股票
        

        




        // 从粘贴导入早盘竞价数据
        // [VUE3-FIX] 改为纯逻辑函数：粘贴文本由 Vue 组件通过 rawText 参数传入（不再依赖 _domGet 读取 DOM），
        // 进度/结果以 Promise resolve 的字符串返回给组件显示（不再调用 _domSetText）。
        

        // 解析"258.5万"或"3528"这类竞价量文本，统一返回数字字符串（不做单位换算）
        // 带"万"字：提取"万"字前面的数字；不带"万"字：直接使用这个数字
        // 统一的"竞价量/成交量取值"帮助函数：把字面量 0（无论是数字0还是字符串"0"）也当作"无数据"处理，
        // 和主列表里"0 显示为 - "的约定保持一致（外部抓取程序偶尔会在没抓到数据时写入0，而不是留空）。
        // 返回：有效数值时返回 Number，否则返回 null（用于图表断点、补录判断、比值计算等所有场景）。
                

        // 历史数据补录：把一行文本切成单元格数组。
        // 优先按 TAB 分割（Excel 粘贴场景）；如果没有 TAB，则按"股票名称 + 空格分隔的数字"处理，
        // 方便手写录入：股票名称 竞价量 昨日成交量 / 股票名称 数字。
        // 按"从右往左，最多取2个纯数字/带万字的token"识别数值列，剩下的部分整体作为股票名称。
        


        // 历史数据补录：只补数值字段，不新增/删除股票。
        // 支持两种格式：
        //   三列（Tab分隔）：股票名称[TAB]竞价量[TAB]昨日成交量 —— 两个字段一起补
        //   两列（Tab分隔）：股票名称[TAB]数字 —— 按用户选择的单选（竞价量/昨日成交量）补对应字段
        // 规则：股票是否存在，以"当前正在查看的日期"（currentDate）的早盘竞价列表为准（这个列表是固定的，不能变）；
        //       只要该股票在当前列表里存在，就允许把数值补进"目标日期"（下拉框选的历史日期）对应的记录里；
        //       目标日期原本没有该股票的记录时，会新建一条只含数值的记录（不算新增股票，只是数据记录，因为该股票本身在当前列表里是存在的）；
        //       已有值不覆盖；当前列表里不存在的股票，直接跳过，不导入。
        

        // ============================================================
        // 股票接口数据拉取（同花顺 fuyao-proxy + 猫抓 numcat-proxy）
        // 仅新增功能，不改动任何已有函数与排序逻辑
        // ============================================================

        // 从同花顺接口返回项中提取 6 位股票代码：优先 ticker，缺失时从 thscode 截取
        


        // 按钮禁用/恢复（传入按钮元素和原始文本）

        // ---------- 同花顺：获取最近多板 883410 成分股并导入当日竞价列表 ----------
        // 【竞态修复】点击这个按钮到接口真正返回之间有网络耗时，这段时间里如果用户切换了
        // 页面日期（比如从"未来某天"切回今天），原写法全程读全局 currentDate，写入时
        // 用的就已经是"切换之后"的日期，导致数据写到了错误的一天（例如：在 7-20 当天
        // 把页面切到 7-21 点击本按钮，接口返回前又切回了 7-20，数据就误写进了 7-20）。
        // 修复方式：进入函数第一行就把当时的 currentDate 锁存成局部常量 targetDate，
        // 后续所有写入（内存/本地/云端）一律用 targetDate，不再读可能已变化的全局 currentDate。
        

        // 批量请求 fuyao historical 拿单天成交量
        // 返回 { ticker: volume(股) }，仅匹配 dayStr 当天的 K 线
        

        // 日期字符串偏移辅助：dayStr 加/减 n 天，返回 YYYY-MM-DD
        // _shiftDateStr（已迁至 ./date/date-helpers.js）

        // buildYesterdayListFromToday（已迁至 ./date/date-helpers.js）

        // ---------- 同花顺：补全昨日成交量（填两个交易日的 yestVolume，不动 volume） ----------
        

        // ---------- 同花顺：当天昨日成交量（单独调 yesterday 单天，只填 today.yestVolume；弹窗选择补全/覆盖） ----------
        // 早盘竞价 tab 专属实现：只读写 auctionData / thsApiStatus，与热门股票 tab 的
        // fillHotTodayYesterdayVolumeFromThs 完全独立，不共用任何业务函数或状态。
        

        

        // ---------- 同花顺：对比日昨成交量（单独调 dayBefore 单天，只填 yesterday.yestVolume；弹窗选择补全/覆盖） ----------
        // 早盘竞价 tab 专属实现：只读写 auctionData / thsApiStatus，与热门股票 tab 的
        // fillHotYesterdayYesterdayVolumeFromThs 完全独立，不共用任何业务函数或状态。
        

        

        // ---------- 同花顺：获取涨幅（snapshot 接口，支持补全/覆盖弹窗） ----------
        

        

        // ---------- 同花顺（早盘竞价）：历史断点涨幅补全 ----------
        // 与热门股票 tab 的 fillHotHistoryGapPctFromThs 完全独立的一套实现（不共用函数），
        // 写入走 patchAuctionFieldBatch（写 auction_watchlist + market_metrics / _auctionMemCache 缓存），
        // 三条红线相同：不读不写第一页正式列表语义、不调 syncAuctionListForDate、patch 只放 change_pct。
        // 早盘竞价的第一页列表由 getTodayAuction() 通过 _auctionWatchlistIndex 过滤正式成员得到，
        // 影子记录（不在索引里）不会出现在第一页，但趋势图能读到——正是本功能依赖的机制。
        // mode: 'fill'（补全，仅写 null 断点）| 'overwrite'（覆盖，重抓起点后所有交易日涨幅）
        

        // ---------- 同花顺（早盘竞价）：历史断点昨日成交量补全 ----------
        // 与上面 fillAuctionHistoryGapPctFromThs（历史断点涨幅）同一套定位逻辑，仅补全字段不同：
        // 以窗口内每只股票最早出现竞价量(volume)的日期为起点(startDate)，从该日起找出
        // yest_volume 缺失的断点日；为每只股票用 prices/historical 拉取
        // [最早断点日的前一交易日 ~ 今天] 整段日线，取每个断点日"前一交易日"的 volume
        // 作为该断点日的 yest_volume（与"当天/对比日昨成交量"按钮同样的 单位换算：股 ÷ 10000）。
        // 同样只经 patchAuctionFieldBatch 写 yest_volume 字段，不碰 in_watchlist / 第一页正式列表语义。
        

        // ---------- 猫抓：补全昨日竞价量（弹窗选择补全/覆盖） ----------
        

        // ---------- 猫抓：获取当天竞价量（弹窗选择补全/覆盖） ----------
        

        // ---------- 猫抓：全竞价量（弹窗选择补全/覆盖，两天统一） ----------
        

        // ---------- 猫抓：连抓三天补全（今日+昨日+前日，一次请求，纯补全不覆盖，不弹窗） ----------
        

        // ---------- 猫抓：连抓五天补全（竞价量+成交量反推，一次请求，纯补全不覆盖） ----------
        

        // ---------- 猫抓：补全题材（开盘啦，只填 topics 为空的股票） ----------
        

        // ---------- 猫抓：查询交易监管（严重异常波动，最近 5 个交易日） ----------
        

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
        

        // ================================================================
        // 接口诊断（早盘竞价 tab 独立版本）
        // 只读检查，不修改任何数据。用于排查"补全昨日成交量"（同花顺）和
        // "补全昨日竞价量"（猫抓）互相冲掉对方字段的问题：把当前内存里的
        // volume/yestVolume 真实取值、保存路径、保存按钮绑定、趋势图缓存
        // 一次性列出来，人工或截图/复制给开发者比对，不靠猜测。
        // 与热门股票 tab 的 runHotApiDiagnostics 完全独立，不共用任何函数、
        // 不读写 hotAuctionData / _hotFullRowCache 等热门股票的数据。
        // ================================================================
        



        





        // 渲染早盘竞价表单

// [已迁至 app-core-init.js initAppCore] state 绑定 _migrateFromV41/_guardStack/_guardAssertDate
// [已迁至 app-core-init.js initAppCore] _bindApi 注册 API 门面（getCurrentDate 等 29 个函数）
// [已迁至 app-core-init.js initAppCore] _bindUiFns 注册（renderAuction → auction-refresh，刷新链路必需）
// [已迁至 app-core-init.js initAppCore] _initAuctionMemCache 启动各 store 实时订阅
// [已迁至 app-core-init.js initAppCore] _setInvalidateTopicCacheFn 注入 invalidateTopicCache

// §16 域拆分：jiwang 域函数已迁出至 ./jiwang/jiwang.js
export { markJiwangDirty, getTodayJiwang } from './jiwang/jiwang.js';

// §16 域拆分：stocks 域函数已迁出至 ./stocks/stocks.js
export { autoCompleteMissingStockCodes, importStockCodeMap, getStockHistoryTopics, replaceConceptFromPaste } from './stocks/stocks.js';

// §16 域拆分：auction 域函数已迁出至 ./auction/auction.js
export { getTodayAuction, reconcileAuctionWatchlistFromLocalStorage, getAuctionData, getTodayGroupList, markAuctionDirty, patchAuctionField, patchAuctionFieldBatch, mergeAuctionDateRows, repairAuctionInWatchlistForDate, rollbackAuctionData, importAuctionFromPaste, importAuctionHistoryFill, fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs, fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fillAuctionHistoryGapPctFromThs, fillAuctionHistoryGapYestVolumeFromThs, fillYesterdayAuctionFromNumcat, fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat, fetchFiveDaysAuctionFromNumcat, fillTopicsFromNumcat, fetchMonitorWarningFromNumcat } from './auction/auction.js';

// §16 域拆分：hotspot 域函数已迁出至 ./hotspot/hotspot.js
export { getHotAuctionData, _openHotAuctionShield, _closeHotAuctionShield, replaceHotConceptFromPaste, importHotFromPaste, patchHotFieldBatch } from './hotspot/hotspot.js';
