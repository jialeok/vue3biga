import { state } from '../app-state.js';
if (!state._auctionMemCache) state._auctionMemCache = {}; // §6.1：域缓存下沉，auction 域拥有 _auctionMemCache
import { _bindApi } from '../app-core-api.js';
import { showToast } from '../../composables/useToast.js';
import { fuyaoApiGet, tickerToThscode, LADDER_THSCODE } from '../../data/api/fuyao-proxy.js';
import { numcatApiPost } from '../../data/api/numcat-proxy.js';
import { normalizeAuctionNotes, pullAuctionFromTable, setAuctionDateData, _setInvalidateTopicCacheFn } from '../../data/auction-data.js';
import { _dbgLog, _dbgLogVerbose } from '../../data/debug-log.js';
import { pushHotTrendsToCloud } from '../../data/hot-stocks.js';
import { pushJiwangNow, scheduleJiwangPush } from '../../data/jiwang-data.js';
import { _closeAuctionShield, _openAuctionShield, _initAuctionMemCache } from '../../data/session-and-shield.js';
import { loadCloudStockCodeMap, upsertStockCodeMap } from '../../data/stock-code-map.js';
import { buildTopicCache, invalidateTopicCache, loadCloudTopics, pushStockTopicsToCloud, scanDataSourceForTopics } from '../../data/stock-topics.js';
import { _moduleKey, getJiwangData, getNumericVolume, getStocksData, getSupabase, loadAllData } from '../../data/supabase-client.js';
import { remainingBoards } from '../../data/remaining-boards.js';
import { _addAuctionWatchlistMember, _extractWatchlistNamesFromRows, _getAuctionWatchlistSet, _setAuctionWatchlistForDate, getStockHistoryValue } from '../../data/watchlist-and-metrics.js';
import { getJingYestHighlightSetForDate, getJingYestStocksForDate } from './sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from './stock-sync.js';
import { getStats } from '../jiwang/helpers.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from '../note/helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from '../scope/helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from '../tagTitles/rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from '../date/date-helpers.js';
import { getNthPreviousTradingDay, recalcDuibanFromAuction, renderAuction, renderBidding, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, setApiStatus, showNumcatChoiceModal } from '../ui-bridge.js';
// §6 单真相边界说明：recalcDuibanFromAuction（定义于 ui-bridge.js）只写 recent_multi_data
// —— 这是 DuibanBoard 的 live 唯一真相源。auction_duiban 为迁移遗留孤儿表，已收敛：
// duiban-sync.js 的 saveDuibanData/loadDuibanData（0 调用方）已移除，auction-sync.js 不再向其双写；
// 该表停止写入，仅保留 Supabase 表结构（数据不丢），不在本模块处理。
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getGroupData, _dumpAuctionSnapshot, _guardStack, _getAuctionStore, _guardAssertDate, saveModule, setBtnLoading, scheduleCloudPush } from '../shared/core-shared.js';
// §P1-6：纯函数 parseVolumeOnlyText / splitHistoryFillLine 已抽取到 ./auction-helpers.js（行为等价）。

// ===== auction 域「纯工具/辅助函数簇」：物理拆分自 auction.js（§16），函数体逐字迁移，未改实现 =====
export async function repairAuctionInWatchlistForDate(dateArg) {
    const date = dateArg || useUiStore().currentDate;
    if (!date) { throw new Error('无法确定要恢复的日期'); }

    const sb = getSupabase();
    try {
        _dbgLog('[REPAIR] repairAuctionInWatchlistForDate 开始 date=' + date);
        const { data: cloudRows, error: readErr } = await sb.from('auction_watchlist')
            .select('stock, selected, bought, sold, fixed, obs_auto_added').eq('date', date);
        if (readErr) throw readErr;

        if (!cloudRows || cloudRows.length === 0) {
            _dbgLog('[REPAIR] date=' + date + ' 云端 watchlist 无任何记录，无需恢复');
            throw new Error(date + ' 云端 watchlist 没有任何记录，无法恢复（不是"被隐藏"，而是本来就没有数据）');
        }

        // §6 红线：观察组（obs_auto_added=true）绝不并入正式成员索引（与 pullAuctionMarketDataForDate /
        // pullAuctionFromTable / syncAuctionListForDate 同口径）。云端 auction_watchlist 含 obs 行
        // （d94b4bc 后同步层推送全部行含 obs），若不过滤会把观察组算进「最近多板总数量」→ 84≠78。
        const cloudStocks = new Set((cloudRows || []).filter(function(r) { return r && r.obs_auto_added !== true; })
            .map(function(r) { return (r.stock || '').trim(); }));
        const obsStocks = (cloudRows || []).filter(function(r) { return r && r.obs_auto_added === true; })
            .map(function(r) { return (r.stock || '').trim(); });
        _dbgLog('[REPAIR] date=' + date + ' 云端 watchlist 共' + cloudRows.length + '条（正式' + cloudStocks.size + ' + 观察组' + obsStocks.length + '）：' +
            Array.from(cloudStocks).join('、') + (obsStocks.length ? '；观察组不并入索引：' + obsStocks.join('、') : ''));

        // 方案2：把云端 watchlist 正式成员名单合并进本地正式成员索引（只增不删，影子记录保持原样）
        if (!state._auctionWatchlistIndex[date]) state._auctionWatchlistIndex[date] = new Set();
        const localSet = state._auctionWatchlistIndex[date];
        let repairedCount = 0;
        cloudStocks.forEach(function(name) {
            if (!localSet.has(name)) {
                localSet.add(name);
                repairedCount++;
            }
        });

        _dbgLog('[REPAIR] date=' + date + ' 恢复完成，云端 watchlist 正式成员 ' + cloudStocks.size + '条，修复本地异常' + repairedCount + '条（观察组 ' + obsStocks.length + ' 条未并入索引）');
        console.log('✅ 已恢复 ' + date + '：云端 watchlist 共 ' + cloudRows.length + ' 条，' + repairedCount + ' 条本地显示异常已修复（影子记录未改动）');

        if (date === useUiStore().currentDate) {
            renderAuction();
            renderList();
        }
    } catch (e) {
        _dbgLog('[REPAIR-ERR] repairAuctionInWatchlistForDate date=' + date + ' ' + (e && e.message || e));
        console.error('❌ 恢复失败：' + (e && e.message || e));
    }
}

export async function reconcileAuctionWatchlistFromLocalStorage() {
    const RECONCILE_FLAG = 'stockApp_v42_auction_reconciled_v1';
    try {
        const raw = localStorage.getItem('stockApp_v42_auction');
        if (!raw) {
            _dbgLog('[RECONCILE-DEBUG] 跳过：localStorage[stockApp_v42_auction] 无数据（auction 已不再写入此 key，属正常现象）');
            return { skipped: true, reason: 'localStorage 无数据', disabled: true };
        }
        const parsed = JSON.parse(raw);
        const wouldDemote = [];
        Object.keys(parsed).forEach(function(date) {
            const lsStocks = new Set((parsed[date] || [])
                .filter(function(s) { return s && (s.stock || s.name); })
                .map(function(s) { return (s.stock || s.name).trim(); }));
            if (lsStocks.size === 0) return;
            const memRows = state._auctionMemCache[date] || [];
            const wset = _getAuctionWatchlistSet(date);
            memRows.forEach(function(row) {
                if (row && row.stock && wset.has(row.stock.trim()) && !lsStocks.has(row.stock.trim())) {
                    wouldDemote.push({ date: date, stock: row.stock.trim(), volume: row.volume || '' });
                }
            });
        });
        if (wouldDemote.length > 0) {
            _dbgLog('[RECONCILE-DEBUG] ⛔ 降级写入已禁用。若未禁用，本次会误将 ' + wouldDemote.length + ' 只正式记录打回影子记录（基准是过期的 localStorage 旧快照，不可信）：' + wouldDemote.map(function(d){ return d.date + ':' + d.stock; }).join(', '));
            console.warn('[RECONCILE-DEBUG] 降级写入已禁用，命中详情：', wouldDemote);
        } else {
            _dbgLog('[RECONCILE-DEBUG] 本次对账无命中（0 只会被误伤），符合预期');
        }
        localStorage.setItem(RECONCILE_FLAG, '1'); // 合规：一次性对账调试标记（§8 允许）
        return { skipped: false, demoted: 0, wouldHaveDemoted: wouldDemote.length, detail: wouldDemote, disabled: true };
    } catch (e) {
        console.warn('[RECONCILE-DEBUG] 诊断执行失败:', e.message);
        return { skipped: true, reason: e.message, error: true };
    }
}

export async function reconcileAuctionWatchlist(force) {
    if (force) localStorage.removeItem('stockApp_v42_auction_reconciled_v1');
    return await reconcileAuctionWatchlistFromLocalStorage();
}

export function _sanitizeAuctionPatch(patch) {
    return _sanitizePatch(patch, AUCTION_PATCHABLE_FIELDS);
}

export function _splitAuctionPatch(cleanPatch) {
    return _splitPatch(cleanPatch, AUCTION_WATCHLIST_FIELDS, AUCTION_METRICS_FIELDS);
}

export function _mergeAuctionPatchLocal(date, stock, cleanPatch) {
    return _mergePatchLocal(date, stock, cleanPatch, state._auctionMemCache, function(d) { setAuctionDateData(d, [], 'patchAuctionFieldBatch-init'); });
}

export async function patchAuctionField(date, stock, patch) {
    return _patchScopeField(date, stock, patch, patchAuctionFieldBatch);
}

export async function patchAuctionFieldBatch(date, items) {
    if (!date || !Array.isArray(items) || items.length === 0) return { ok: true, rows: 0 };
    _openAuctionShield();
    try {
        const now = new Date().toISOString();
        const watchlistRows = [];
        const metricsRows = [];
        const localOps = [];
        // 方案2：用 _auctionWatchlistIndex 独立 Set 判断正式成员，不依赖行对象上的 in_watchlist 字段
        const watchlistSet = _getAuctionWatchlistSet(date);
        function isWatchlistStock(nameTrim) {
            return watchlistSet.has(nameTrim);
        }
        isWatchlistStock = isWatchlistStock;
        items.forEach(function(item) {
            if (!item || !item.stock) return;
            const nameTrim = item.stock.trim();
            if (!nameTrim) return;
            const cleanPatch = _sanitizeAuctionPatch(item);
            if (Object.keys(cleanPatch).length === 0) return; // 没有合法字段可写，跳过
            const split = _splitAuctionPatch(cleanPatch);
            const isInWatchlist = isWatchlistStock(nameTrim);
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

        if (state._auctionTableAvailable && watchlistRows.length > 0) {
            const sb = getSupabase();
            const { error } = await sb.from('auction_watchlist')
                .upsert(watchlistRows, { onConflict: 'date,stock' });
            if (error) throw error;
        }
        if (state._marketMetricsTableAvailable && metricsRows.length > 0) {
            const sb = getSupabase();
            const { error } = await sb.from('market_metrics')
                .upsert(metricsRows, { onConflict: 'date,stock,scope' });
            if (error) throw error;
        }

        // 云端成功后再做本地 merge，避免云端失败时本地和云端出现"本地领先云端"的假象
        localOps.forEach(function(op) {
            _mergeAuctionPatchLocal(date, op.stock, op.cleanPatch);
        });

        return { ok: true, rows: localOps.length };
    } catch (e) {
        _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch ' + (e && e.message));
        return { ok: false, error: e };
    } finally {
        _closeAuctionShield(2000);
    }
}

export function markAuctionDirty(date) {
    if (date) state._auctionDirtyDates.add(date);
}

export function clearAuctionDateData(date, source) {
    if (!date || typeof date !== 'string') { _dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
    if (!_auctionFirstClearDumped) { _dumpAuctionSnapshot('before-first-clear'); }
    var before = (state._auctionMemCache[date] || []).length;
    state._auctionMemCache[date] = [];
    // 方案2：清空该日期的正式成员索引
    state._auctionWatchlistIndex[date] = new Set();
    _dbgLog('[AUCTION-GUARD] clear date=' + date + ' before=' + before + ' after=0 source=' + source + _guardStack());
    if (_getAuctionStore() && date !== _getAuctionStore().currentDate) {
        try { _dbgLog('[AUCTION-GUARD] sample-clear date=' + date + ' source=' + source); } catch(e){}
    }
    _guardAssertDate(date, source);
    if (!_auctionFirstClearDumped) { _auctionFirstClearDumped = true; _dumpAuctionSnapshot('after-first-clear'); }
}

export function deleteAuctionDateData(date, source) {
    if (!date || typeof date !== 'string') { _dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
    var before = (state._auctionMemCache[date] || []).length;
    delete state._auctionMemCache[date];
    // 方案2：删除该日期的正式成员索引
    delete state._auctionWatchlistIndex[date];
    _dbgLog('[AUCTION-GUARD] delete date=' + date + ' before=' + before + ' after=0 source=' + source + _guardStack());
    _guardAssertDate(date, source);
}

export function mergeAuctionDateRows(date, rows, source) {
    if (!date || typeof date !== 'string') { _dbgLog('[AUCTION-GUARD] ⚠️ invalid date source=' + source); return; }
    if (!state._auctionMemCache[date]) state._auctionMemCache[date] = [];
    var before = state._auctionMemCache[date].length;
    var list = state._auctionMemCache[date];
    // 方案2：行对象不再携带 in_watchlist，merge 时直接写入行数据；
    // 调用方若需要把这些行标记为正式成员，应另外调用 _addAuctionWatchlistMember / _setAuctionWatchlistForDate。
    (rows || []).forEach(function(row) {
        if (!row || !row.stock) return;
        var idx = list.findIndex(function(r) { return r && r.stock === row.stock; });
        if (idx >= 0) list[idx] = row; else list.push(row);
    });
    var after = list.length;
    _dbgLog('[AUCTION-GUARD] merge date=' + date + ' before=' + before + ' after=' + after + ' source=' + source + _guardStack());
    if (_getAuctionStore() && date !== _getAuctionStore().currentDate) {
        try { _dbgLog('[AUCTION-GUARD] sample date=' + date + ' source=' + source + ' stocks=' + (rows||[]).slice(0,3).map(function(r){return r&&r.stock||'?';}).join(',')); } catch(e){}
    }
    _guardAssertDate(date, source);
}

export function clearAllAuctionDates(source) {
    var dates = Object.keys(state._auctionMemCache);
    _dbgLog('[AUCTION-GUARD] ⚠️ clearAll dates=' + dates.length + ' source=' + source + _guardStack());
    dates.forEach(function(d) { delete state._auctionMemCache[d]; });
    // 方案2：清空所有日期的正式成员索引
    state._auctionWatchlistIndex = {};
}

export function backupAuctionData(type, date) {
    return _backupScopeData({
        type: type, date: date,
        getDataFn: getAuctionData,
        backupKeyPrefix: 'auctionData',
        watchlistIndex: state._auctionWatchlistIndex,
        label: '竞价'
    });
}

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
        deleteAuctionDateData(backupDate, 'restore');
    } else {
        // 方案2：优先用备份时保存的 watchlist 索引恢复正式成员名单。
        // 行对象不携带 in_watchlist 字段，索引是正式/影子身份的唯一权威来源。
        // 旧备份无 watchlist 字段时，回退到 _extractWatchlistNamesFromRows（兼容旧数据可能携带的 in_watchlist 字段）。
        if (Array.isArray(backupDayData)) {
            const backupWatchlist = backupPayload.watchlist;
            if (Array.isArray(backupWatchlist) && backupWatchlist.length > 0) {
                _setAuctionWatchlistForDate(backupDate, backupWatchlist);
            } else {
                // 旧备份兜底：仅取非观察组行作为正式成员（§6：obs 观察组绝不进正式索引）
                _setAuctionWatchlistForDate(backupDate,
                    _extractWatchlistNamesFromRows(backupDayData.filter(function(r) { return !(r && r.obsAutoAdded === true); })));
            }
        }
        setAuctionDateData(backupDate, backupDayData, 'restore');
        // 把这一天的所有数据字段 patch 到云端（camelCase → snake_case）
        const scMap = state._scMapCache || {};
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
            patchAuctionFieldBatch(backupDate, patches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch backup-revert ' + (e && e.message || e)); });
        }
    }
    // 用户主动确认"撤回"了 backupDate 这一天的数据，标记为脏日期，
    // 允许下次推送时用撤回后的本地状态覆盖云端该日期
    markAuctionDirty(backupDate);

    // 撤回后清除全部备份，避免下次撤回到错误状态
    localStorage.removeItem('auctionData_import_backup');
    localStorage.removeItem('auctionData_import_backup_time');
    localStorage.removeItem('auctionData_save_backup');
    localStorage.removeItem('auctionData_save_backup_time');

    // 刷新页面显示
    renderAuction();
    showToast('✅ 已撤回早盘竞价数据');
    return true;
}

export function getAuctionData() {
    return getGroupData('auction');
}

export function getTodayAuction() {
    const list = getAuctionData()[useUiStore().currentDate] || [];
    const watchlistSet = _getAuctionWatchlistSet(useUiStore().currentDate);
    return list.filter(function(r) { return r && r.stock && watchlistSet.has(r.stock.trim()); });
}

export function getTodayGroupList(dataSource='auction') {
    const list = getGroupData(dataSource)[useUiStore().currentDate] || [];
    if (dataSource === 'hot') {
        // 方案2：_hotAuctionData 只从 hot_stocks 表加载正式成员，无需过滤
        return list.filter(function(r) { return r && r.stock; });
    }
    // auction 分组：正式成员 = _auctionWatchlistIndex（§6：只含正式成员，已排除 obsAutoAdded 观察组）。
    // 观察组(obsAutoAdded)虽不计入正式索引/总数量，但仍作为「观察组」显示在竞价看板（保留次日观察组继承功能）。
    const watchlistSet = _getAuctionWatchlistSet(useUiStore().currentDate);
    const result = list.filter(function(r) {
        return r && r.stock && (watchlistSet.has(r.stock.trim()) || r.obsAutoAdded === true);
    });
    // [DEBUG-VUE-FIX 2026-07-25] 暴露"后台有导入记录、前台不显示"这类问题的
    // 第一手证据：原始条数 vs 实际渲染条数 vs 被过滤掉的影子记录名单。
    // 只在条数发生变化（有过滤发生）时打印，避免刷屏。
    if (list.length > 0 && result.length !== list.length) {
        const filteredOut = list.filter(function(r) { return !r || !r.stock || !watchlistSet.has(r.stock.trim()); })
            .map(function(r) { return (r && r.stock ? r.stock.trim() : '(无名)') + '[shadow]'; });
        _dbgLog('[AUCTION-DEBUG] getTodayGroupList(' + dataSource + ') currentDate=' + useUiStore().currentDate +
            ' 原始' + list.length + '条 → 正式列表' + result.length + '条，被过滤' + filteredOut.length + '条：' + filteredOut.join(', '));
    }
    return result;
}

export async function importAuctionFromPaste(rawText) {
    const targetDate = _getAuctionStore() ? _getAuctionStore().currentDate : useUiStore().currentDate;
    const sysToday = (typeof _getLocalTodayStr === 'function') ? _getLocalTodayStr() : '';
    if (sysToday && targetDate > sysToday) {
        _dbgLog('[DATE-WARN] importAuctionFromPaste 写入未来日期 targetDate=' + targetDate + ' sysToday=' + sysToday + '，请确认这是预期行为');
    }
    _dbgLog('[AUCTION-WRITE] importAuctionFromPaste targetDate=' + targetDate);
    const pasteText = (rawText || '').trim();
    if (!pasteText) {
        throw new Error('请先粘贴数据！');
    }

    // 备份早盘竞价数据（用于撤回）
    backupAuctionData('import');

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

    buildTopicCache();

    // 兼容 \r\n（Excel/Windows换行）和 \n
    const lines = pasteText.split(/\r?\n/);
    const auctionData = getAuctionData();
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
                var note = buildNoteFromFields(changePctStr, topicsStr);
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
            var note = buildNoteFromFields(changePctStr, topicsStr);
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
                var note = buildNoteFromFields(changePctStr, topicsStr);
                noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
            }
        }
    });

    if (fullDataList.length === 0 && noteList.length === 0) {
        throw new Error('未能解析到有效数据！');
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
                const historyTopics = getStockHistoryTopics(dataItem.stock);
                existingNote = historyTopics;
                var parsed = parseNoteToFields(historyTopics);
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
            const historyTopics = getStockHistoryTopics(dataItem.stock);
            var parsedHist = parseNoteToFields(historyTopics);
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
        const historyTopics = getStockHistoryTopics(noteItem.stock);
        var historyParsed = parseNoteToFields(historyTopics);
        var newChangePct = noteItem.changePct || '';
        var newTopics = noteItem.topics || '';
        
        if (existingIndex >= 0) {
            var existingChangePct = auctionList[existingIndex].changePct || '';
            var existingTopics = auctionList[existingIndex].topics || '';
            // 兼容：如果旧数据没有 changePct/topics 字段，从 note 解析
            if (!existingChangePct && !existingTopics && auctionList[existingIndex].note) {
                var exParsed = parseNoteToFields(auctionList[existingIndex].note);
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
            auctionList[existingIndex].note = buildNoteFromFields(
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
                note: buildNoteFromFields(finalChangePct, finalTopics),
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

    setAuctionDateData(targetDate, auctionList, 'importAuctionFromPaste');
    // §6：粘贴导入全量覆盖，但观察组继承残留行(obsAutoAdded)不进正式成员索引（避免 87≠76）
    _setAuctionWatchlistForDate(targetDate, auctionList
        .filter(function(r) { return !(r && r.obsAutoAdded === true); })
        .map(function(r) { return r && r.stock; }));
    saveModule('auction');
    invalidateTopicCache();
    // 同步到 auction_watchlist + market_metrics（阶段二 C：改为字段级 patch）
    // 粘贴导入是全量数据写入，覆盖所有业务字段；正式成员身份由 _auctionWatchlistIndex
    // 管理，syncAuctionListForDate 负责同步正式列表到云端 auction_watchlist
    (function() {
        const scMap = state._scMapCache || {};
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
                    await patchAuctionFieldBatch(targetDate, patches);
                    // 同步正式列表到云端 auction_watchlist（索引已在 setAuctionDateData 后更新）
                    await syncAuctionListForDate(targetDate);
                } catch (e) {
                    _dbgLog('[AUCTION-ERR] importAuctionFromPaste 云端同步 ' + (e && e.message || e));
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
                pushStockTopicsToCloud(p.stock, topicsArr, p.code).catch(function(e) {
                    _dbgLog('[AUCTION-ERR] importAuctionFromPaste pushStockTopicsToCloud ' + p.stock + ' ' + (e && e.message || e));
                });
            });
        }
    })();
    let statusMsg = '✅ ';
    if (fullDataCount > 0) statusMsg += `新增${fullDataCount}条`;
    if (fullDataUpdateCount > 0) statusMsg += ` 更新${fullDataUpdateCount}条`;
    if (noteUpdateCount > 0) statusMsg += ` 更新注释${noteUpdateCount}条`;
    if (noteNewCount > 0) statusMsg += ` 新增注释${noteNewCount}条`;

    // 异步分批同步收盘涨幅（每帧30条），避免主线程卡死导致 localStorage 写入失败
    setTimeout(syncCloseChunk, 60);

    return statusMsg;
}

// §P1-6：原 export function parseVolumeOnlyText / splitHistoryFillLine 已迁至 ./auction-helpers.js。
// 保留同名导出（re-export），确保 app-core.js 及 auction.js 内部调用方完全等价、无需改动。

export async function importAuctionHistoryFill(rawText, targetDate, colType) {
    const pasteText = (rawText || '').trim();
    const sysToday = (typeof _getLocalTodayStr === 'function') ? _getLocalTodayStr() : '';
    if (sysToday && targetDate > sysToday) {
        _dbgLog('[DATE-WARN] importAuctionHistoryFill 写入未来日期 targetDate=' + targetDate + ' sysToday=' + sysToday + '，请确认这是预期行为');
    }

    if (!targetDate) {
        throw new Error('请先选择目标日期！');
    }

    if (!pasteText) {
        throw new Error('请先粘贴数据！');
    }
    const twoColField = colType || 'volume'; // 两列格式时，数字要填入的字段名

    _dbgLog('[AUCTION-WRITE] importAuctionHistoryFill targetDate=' + targetDate);

    // 列类型（竞价量/昨日成交量）改由参数 colType 传入，不再读取 DOM 单选

    // 备份早盘竞价数据（用于撤回），与现有导入功能共用同一套备份/撤回机制
    // 注意：这里备份的是 targetDate（用户选择要补录的历史日期），而不是当天，
    // 因为这次操作实际改动的就是 targetDate 这一天
    backupAuctionData('import', targetDate);

    const lines = pasteText.split(/\r?\n/);
    const auctionData = getAuctionData();
    const targetList = [...(auctionData[targetDate] || [])];
    // 股票是否存在的判断依据：当前正在查看的日期的早盘竞价列表（固定的股票列表，不可新增/删除）
    const currentStockSet = new Set(getTodayAuction().map(item => item.stock && item.stock.trim()).filter(Boolean));

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

        const rawCells = splitHistoryFillLine(line);
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
            _addAuctionWatchlistMember(targetDate, stock);
            existingIndex = targetList.length - 1;
            isNewRecord = true;
        }

        const nonEmptyCells = rawCells.slice(1).map(c => c.trim()).filter(c => c !== '');

        if (nonEmptyCells.length >= 2) {
            // 三列格式：股票名称[TAB]竞价量[TAB]昨日成交量，两个字段一起补
            const volumeText = rawCells[1] ? rawCells[1].trim() : '';
            const yestText = rawCells[2] ? rawCells[2].trim() : '';
            const parsedVolume = parseVolumeOnlyText(volumeText);
            const parsedYest = parseVolumeOnlyText(yestText);

            if (parsedVolume === null && parsedYest === null) {
                invalidCount++;
                if (isNewRecord) targetList.pop(); // 无法解析，撤销刚才新增的空记录
                return;
            }

            const item = targetList[existingIndex];
            let didFill = false;
            const patch = { stock: stock };

            if (parsedVolume !== null) {
                const isEmpty = getNumericVolume(item.volume) === null;
                item.volume = parsedVolume;
                patch.volume = parsedVolume;
                if (isEmpty) { filledCount++; } else { overwritedCount++; }
                didFill = true;
            }
            if (parsedYest !== null) {
                const isEmpty = getNumericVolume(item.yestVolume) === null;
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
            const parsedValue = parseVolumeOnlyText(valueText);
            if (parsedValue === null) {
                invalidCount++;
                if (isNewRecord) targetList.pop();
                return;
            }

            const item = targetList[existingIndex];
            const existingFieldValue = item[twoColField];
            const isEmpty = getNumericVolume(existingFieldValue) === null;
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
        let msg = '未补录任何数据';
        const parts = [];
        if (skippedNotInCurrent > 0) parts.push(`${skippedNotInCurrent}条不在当前股票列表中`);
        if (invalidCount > 0) parts.push(`${invalidCount}行无法识别`);
        if (parts.length) msg += `（${parts.join('，')}）`;
        return msg;
    }

    setAuctionDateData(targetDate, targetList, 'importAuctionHistoryFill');
    saveModule('auction');
    invalidateTopicCache();
    // 阶段二 C：改用字段级 patch 上报，只携带 volume/yest_volume，不再整段推送。
    if (historyPatches.length > 0) {
        patchAuctionFieldBatch(targetDate, historyPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] importAuctionHistoryFill patchAuctionFieldBatch ' + (e && e.message || e)); });
    }

    let statusMsg = `✅ ${targetDate} 补齐${filledCount}个字段`;
    if (overwritedCount > 0) statusMsg += ` 覆盖${overwritedCount}个字段`;
    if (addedCount > 0) statusMsg += ` 新增${addedCount}条数据记录`;
    if (skippedNotInCurrent > 0) statusMsg += ` 跳过${skippedNotInCurrent}条(不在当前股票列表中)`;
    if (invalidCount > 0) statusMsg += ` 无法识别${invalidCount}行`;
    return statusMsg;
}


// ===== 域常量（§16，原 auction.js 2909-2915）=====
export const AUCTION_WATCHLIST_FIELDS = ['note', 'topics', 'source', 'obs_auto_added', 'selected', 'bought', 'sold', 'fixed', 'code'];

export const AUCTION_METRICS_FIELDS = ['volume', 'yest_volume', 'change_pct', 'auc_pct_chg', 'time930', 'seal_count', 'code'];

export const AUCTION_PATCHABLE_FIELDS = AUCTION_WATCHLIST_FIELDS.concat(AUCTION_METRICS_FIELDS.filter(function(f) { return AUCTION_WATCHLIST_FIELDS.indexOf(f) < 0; }));

export var _auctionFirstClearDumped = false;

// ===== §P1-6 纯函数（原 auction-helpers.js，被 app-core.js 复用）=====
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

/**
 * 把一行历史补录文本切分为 [股票名, ...数字单元格]。
 * 优先按 Tab 切分；否则按空白切分，并从行尾向前识别末尾的数字列作为数值部分。
 * @param {string} line
 * @returns {string[]}
 */
export function splitHistoryFillLine(line) {
    if (line.indexOf('\t') !== -1) {
        return line.split('\t');
    }
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
        return [line.trim()];
    }
    const isNumToken = (t) => parseVolumeOnlyText(t) !== null;
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
