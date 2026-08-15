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
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from '../note/helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from '../scope/helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from '../tagTitles/rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from '../date/date-helpers.js';
import { _domGet, _domQuery, getNthPreviousTradingDay, recalcDuibanFromAuction, renderAuction, renderBidding, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, resetExpansionStateOnDateSwitch, setApiStatus, showNumcatChoiceModal } from '../ui-bridge.js';
// §6 单真相边界说明：recalcDuibanFromAuction（定义于 ui-bridge.js）只写 recent_multi_data
// —— 这是 DuibanBoard 的 live 唯一真相源。auction_duiban 是迁移遗留的孤儿表：仅由
// duiban-sync.js 的 saveDuibanData（触发于 auction-sync.js 的 §8 收口回写）写入、从不被读取，
// 不在本模块处理。收敛该双真相需改 duiban-sync.js / auction-sync.js（非本文件可编辑范围）。
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore, _bindUiFns } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getGroupData, _dumpAuctionSnapshot, _guardStack, _getAuctionStore, _guardAssertDate, saveModule, setBtnLoading, scheduleCloudPush } from '../shared/core-shared.js';
// §P1-6：纯函数 parseVolumeOnlyText / splitHistoryFillLine 已抽取到 ./auction-helpers.js（行为等价）。
import { parseVolumeOnlyText, splitHistoryFillLine } from './auction-helpers.js';

// §16 域拆分：auction 域（原 app-core.js 迁出）
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
export { parseVolumeOnlyText, splitHistoryFillLine };

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

export async function fetchLadderConstituentsMain(btn) {
    const statusEl = _domGet('thsApiStatus');
    // 锁定"点击那一刻"的日期，全程只认这一个值，杜绝异步等待期间日期漂移
    const targetDate = _getAuctionStore() ? _getAuctionStore().currentDate : useUiStore().currentDate;
    _dbgLog('[AUCTION-WRITE] fetchLadderConstituentsMain targetDate=' + targetDate);
    // 守卫：同花顺"最近多板"接口没有查询历史日期的能力，永远只返回"当前最近一个
    // 交易日"的实时成分股。只有当页面停留的日期恰好等于这个"最近交易日"才允许写入
    // （例如周六查看周五、交易日当天查看当天），否则接口返回的实时数据会被张冠李戴地
    // 覆盖写入一个不相关的历史日期，污染那天的数据（这正是之前多个历史日期出现同一批
    // 股票的根因）。
    const _mostRecentTD = getMostRecentTradingDay();
    if (targetDate !== _mostRecentTD) {
        setApiStatus('thsApiStatus', '⚠️ 已拒绝：最近多板接口只反映最近交易日（' + _mostRecentTD + '）的实时数据，不能写入 ' + targetDate + '，请切到 ' + _mostRecentTD + ' 再获取', false);
        _dbgLog('[AUCTION-WRITE] fetchLadderConstituentsMain 拒绝：targetDate=' + targetDate + ' ≠ 最近交易日=' + _mostRecentTD);
        return;
    }
    setBtnLoading(btn, true);
    try {
        const data = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: LADDER_THSCODE });
        const constituents = (data && data.item) || [];
        if (constituents.length === 0) {
            setApiStatus('thsApiStatus', '最近多板当前无成分股数据', false);
            return;
        }

        // 备份当日数据（用于撤回）—— 按锁存的 targetDate 备份，而非可能已变化的当前日期
        backupAuctionData('import', targetDate);

        const auctionData = getAuctionData();
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
            const d = deriveAuctionTagState(name, targetDate);
            if (d.source === 'today') {
                _dbgLogVerbose('[APPLY-TAG] ' + name + ' ← 当天=' + (d.sold ? 'sold' : d.bought ? 'bought' : 'hold'));
            } else if (d.source === 'inherited') {
                _dbgLogVerbose('[APPLY-TAG] ' + name + ' ← 前日=bought/hold → 今日持');
            }
            return row;
        }
        applyLatestTag = applyLatestTag;

        // 合并：新成分股列表为准，保留已有股票的备注/点选状态/行情
        const newList = constituents.map(function(c) {
            const name = (c.name || '').trim();
            const existing = existingMap[name];
            const code = extractCodeFromFuyaoItem(c) || (existing ? (existing.code || '') : '');
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
            return applyLatestTag(name, row);
        });

        // 保留"观察组继承"进来、但不在本次最近多板新名单里的股票（例如汇得科技：
        // 昨日买入未卖，理应作为次日观察组继续展示，但它当天不在最近多板成分股里，
        // 之前"获取最近多板"整体覆盖会把这一行连带删掉）。
        // 条件：existing 行是 obsAutoAdded=true（观察组自动补入，非用户手动导入的正式成分股）
        // 且未被标记为已卖出，才补回；已卖出的不需要再观察，让它自然消失即可。
        const newListNames = new Set(newList.map(function(r) { return r.stock; }));
        _dbgLogVerbose('[LADDER] 获取最近多板覆盖：新成分股 ' + newList.length + ' 只，保留观察组继承股中不在名单的');
        existingList.forEach(function(s) {
            if (!s || !s.stock) return;
            const name = s.stock.trim();
            if (newListNames.has(name)) return;
            if (s.obsAutoAdded !== true) return; // 不是观察组继承来的，不额外保留
            // 方案 B：标签不再写入行对象，用 deriveAuctionTagState 判断是否已卖出
            const _ts3 = deriveAuctionTagState(name, targetDate);
            const row = applyLatestTag(name, {
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
                _dbgLogVerbose('[LADDER] 丢弃(已卖) ' + name);
                return; // 已卖出：不再保留到次日观察组
            }
            _dbgLogVerbose('[LADDER] 保留(观察组继承) ' + name);
            newList.push(row);
        });
        _dbgLogVerbose('[LADDER] 覆盖后 newList 共 ' + newList.length + ' 只，其中 obsAutoAdded=' + newList.filter(function(r){return r.obsAutoAdded===true;}).length + ' 只');

        // 更新 stockcodemap（name → code，云端唯一真相源）
        const scMap = state._scMapCache || {};
        let mapUpdated = false;
        const scPairs = [];
        constituents.forEach(function(c) {
            const name = (c.name || '').trim();
            const code = extractCodeFromFuyaoItem(c);
            if (name && code && scMap[name] !== code) {
                scMap[name] = code;
                scPairs.push({ stock: name, code: code });
                mapUpdated = true;
            }
        });
        if (mapUpdated) {
            upsertStockCodeMap(scPairs).catch(function(e) { _dbgLog('[AUCTION-ERR] fetchLadderConstituentsMain upsertStockCodeMap ' + (e && e.message || e)); });
        }

        setAuctionDateData(targetDate, newList, 'fetchLadderConstituentsMain');
        // §6：获取最近多板是全量覆盖，但只有「非观察组」成分股才是正式成员；obsAutoAdded 继承行不进索引（避免 87≠76）
        _setAuctionWatchlistForDate(targetDate, newList
            .filter(function(r) { return !(r && r.obsAutoAdded === true); })
            .map(function(r) { return r && r.stock; }));
        saveModule('auction');
        invalidateTopicCache();

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
        markAuctionDirty(targetDate);
        scheduleCloudPush();
        pushAuctionCodeToCloud(targetDate).catch(function(e) { _dbgLog('[AUCTION-ERR] fetchLadderConstituentsMain pushAuctionCodeToCloud ' + (e && e.message || e)); });

        // 刷新表单和看板：只有当"接口返回时页面仍停留在 targetDate"才刷新当前视图，
        // 否则说明用户已经切到别的日期在忙别的事，此时若仍用刚写入的这批数据刷新
        // 界面上正显示的另一天，等于用错误日期的内容覆盖了正确的渲染，容易造成
        // "看着是这天的数据、其实是那天的"的混淆——所以此时只提示、不刷新视图。
        if (useUiStore().currentDate === targetDate) {
            renderAuction();
            renderList();
            setApiStatus('thsApiStatus', '✅ 已获取 ' + newList.length + ' 只最近多板股票', true);
        } else {
            setApiStatus('thsApiStatus', '✅ 已获取 ' + newList.length + ' 只最近多板股票（写入 ' + targetDate + '，当前页面在 ' + useUiStore().currentDate + '，切回该日期即可看到）', true);
        }
    } catch (err) {
        _dbgLog('[AUCTION-ERR] fetchLadderConstituentsMain ' + (err && err.message || err));
        let msg = err && err.message ? err.message : '拉取失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

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
    const dayStrPrev = _shiftDateStr(dayStr, -1);
    const dayStrNext = _shiftDateStr(dayStr, 1);
    const _acceptableDates = new Set([dayStr, dayStrPrev, dayStrNext]);
    let _debugLog = [];
    for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);
        await Promise.all(batch.map(async function(code) {
            try {
                const thscode = tickerToThscode(code);
                const data = await fuyaoApiGet('/api/a-share/prices/historical', {
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
                    _debugLog.push('[fetchDayVolumes] ' + code + '(' + thscode + ') dayStr=' + dayStr + ' items=' + items.length + ' candidates=' + _candidates.length + ' 未匹配到目标日期' + (_firstItemKeys ? ' itemKeys=' + _firstItemKeys : '') + (items.length > 0 ? ' firstItemDateMs=' + items[0].date_ms : ''));
                }
            } catch (e) {
                _debugLog.push('[fetchDayVolumes] ' + code + ' dayStr=' + dayStr + ' 异常: ' + (e && e.message));
                console.warn('获取 ' + code + ' 在 ' + dayStr + ' 的成交量失败:', e && e.message);
            }
        }));
    }
    if (_debugLog.length > 0) {
        console.log('[fetchDayVolumes] dayStr=' + dayStr + ' 共' + codes.length + '只 成功' + Object.keys(result).length + '只 失败/未匹配' + _debugLog.length + '只:\n' + _debugLog.join('\n'));
    }
    return result;
}

export async function fillYesterdayVolumeFromThs(btn) {
    const statusEl = _domGet('thsApiStatus');
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const yesterday = getPreviousTradingDay(today);
        const dayBefore = yesterday ? getPreviousTradingDay(yesterday) : null;
        if (!yesterday || !dayBefore) {
            setApiStatus('thsApiStatus', '❌ 无法确定前两个交易日', false);
            return;
        }

        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).slice();
        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }
        // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
        const yesterdayList = buildYesterdayListFromToday(todayList, auctionData, yesterday);
        const yesterdayListWasEmpty = (auctionData[yesterday] || []).length === 0;
        const scMap = state._scMapCache || {};

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
            setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺少代码映射，请先导入代码映射或获取最近多板）', false);
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
        setApiStatus('thsApiStatus', '【1/2】正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
        const volYesterday = await fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)

        todayList.forEach(function(s) {
            if (!s || !s.stock) return;
            if (getNumericVolume(s.yestVolume) !== null) return; // 已有值，跳过
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
        saveModule('auction');
        if (todayYestVolPatches.length > 0) {
            patchAuctionFieldBatch(today, todayYestVolPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch today yest_volume ' + (e && e.message || e)); });
        }

        // ===== 第二批：调取对比日的昨日成交量（yesterday.yestVolume ← dayBefore 的 volume）=====
        setApiStatus('thsApiStatus', '【2/2】正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
        const volDayBefore = await fetchDayVolumes(allCodes, dayBefore);

        yesterdayList.forEach(function(s) {
            if (!s || !s.stock) return;
            if (getNumericVolume(s.yestVolume) !== null) return;
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
        saveModule('auction');
        invalidateTopicCache();
        // 正式列表成员 + 影子记录统一走 patchAuctionFieldBatch（只写 yest_volume）
        if (yesterdayYestVolPatches.length > 0) {
            patchAuctionFieldBatch(yesterday, yesterdayYestVolPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch yesterday yest_volume ' + (e && e.message || e)); });
        }

        // 刷新表单和看板
        renderAuction();
        renderList();

        const todayTotal = todayList.length;
        const yesterdayTotal = yesterdayList.length;
        const yesterdaySource = yesterdayListWasEmpty
            ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
            : '';
        setApiStatus('thsApiStatus',
            '✅ 今日填 ' + todayFilled + '/' + todayTotal + '，对比日填 ' + yesterdayFilled + '/' + yesterdayTotal + yesterdaySource +
            '；跳过 今日' + todaySkipped + ' / 对比日' + yesterdaySkipped + '（无数据或缺代码）',
            true);
    } catch (err) {
        console.error('fillYesterdayVolumeFromThs 失败:', err);
        let msg = err && err.message ? err.message : '补全失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export function fillTodayYesterdayVolumeFromThs(btn) {
    showNumcatChoiceModal('当天昨日成交量模式', function(overwrite) {
        _fillTodayYesterdayVolumeFromThsImpl(btn, overwrite);
    });
}

export async function _fillTodayYesterdayVolumeFromThsImpl(btn, overwrite) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const yesterday = getPreviousTradingDay(today);
        if (!yesterday) {
            setApiStatus('thsApiStatus', '❌ 无法确定上一交易日', false);
            return;
        }
        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).slice();
        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
            return;
        }
        const scMap = state._scMapCache || {};
        const codeToName = {};
        todayList.forEach(function(s) {
            if (!s || !s.stock) return;
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) codeToName[code] = s.stock.trim();
        });
        const allCodes = Object.keys(codeToName);
        if (allCodes.length === 0) {
            setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺代码映射，请先获取最近多板）', false);
            return;
        }

        setApiStatus('thsApiStatus', '正在获取 ' + allCodes.length + ' 只股票在 ' + yesterday + ' 的成交量...', true);
        const volYesterday = await fetchDayVolumes(allCodes, yesterday); // ticker -> volume(股)

        let filled = 0, skipped = 0;
        // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 yest_volume
        const todayYestVolPatches = [];
        todayList.forEach(function(s) {
            if (!s || !s.stock) return;
            if (!overwrite && getNumericVolume(s.yestVolume) !== null) return; // 补全模式：已有值跳过
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
        saveModule('auction');
        invalidateTopicCache();
        if (todayYestVolPatches.length > 0) {
            patchAuctionFieldBatch(today, todayYestVolPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch today yest_volume ' + (e && e.message || e)); });
        }

        renderAuction();
        renderList();

        setApiStatus('thsApiStatus',
            '✅ ' + (overwrite ? '覆盖' : '补全') + ' 当天昨日成交量 ' + filled + '/' + todayList.length + '，跳过 ' + skipped + '（无数据或缺代码）',
            true);
    } catch (err) {
        console.error('fillTodayYesterdayVolumeFromThs 失败:', err);
        let msg = err && err.message ? err.message : '补全失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export function fillYesterdayYesterdayVolumeFromThs(btn) {
    showNumcatChoiceModal('对比日昨成交量模式', function(overwrite) {
        _fillYesterdayYesterdayVolumeFromThsImpl(btn, overwrite);
    });
}

export async function _fillYesterdayYesterdayVolumeFromThsImpl(btn, overwrite) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const yesterday = getPreviousTradingDay(today);
        const dayBefore = yesterday ? getPreviousTradingDay(yesterday) : null;
        if (!yesterday || !dayBefore) {
            setApiStatus('thsApiStatus', '❌ 无法确定前两个交易日', false);
            return;
        }
        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).slice();
        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }
        // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
        const yesterdayList = buildYesterdayListFromToday(todayList, auctionData, yesterday);
        const yesterdayListWasEmpty = (auctionData[yesterday] || []).length === 0;
        const scMap = state._scMapCache || {};
        const codeToName = {};
        yesterdayList.forEach(function(s) {
            if (!s || !s.stock) return;
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) codeToName[code] = s.stock.trim();
        });
        const allCodes = Object.keys(codeToName);
        if (allCodes.length === 0) {
            setApiStatus('thsApiStatus', '❌ 没有可补全的股票（缺代码映射，请先获取最近多板）', false);
            return;
        }

        setApiStatus('thsApiStatus', '正在获取 ' + allCodes.length + ' 只股票在 ' + dayBefore + ' 的成交量...', true);
        const volDayBefore = await fetchDayVolumes(allCodes, dayBefore);

        let filled = 0, skipped = 0;
        // 阶段二 B 改造：收集字段级 patch，结束时调用 patchAuctionFieldBatch 上报。
        // 【重点自查项】patch 对象里只能出现 yest_volume，绝对不能顺手塞 volume——
        // 原实现 pushAuctionDataToCloud 会把当时内存里的 row.volume 旧值一起带上，
        // 这是原 bug（先点同花顺再点猫抓互相覆盖）的触发点之一。
        const yesterdayPatches = [];
        yesterdayList.forEach(function(s) {
            if (!s || !s.stock) return;
            if (!overwrite && getNumericVolume(s.yestVolume) !== null) return; // 补全模式：已有值跳过
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
        invalidateTopicCache();
        // 阶段二 B：改用字段级 patch 上报，不再走整段 pushAuctionDataToCloud。
        // yesterdayPatches 同时包含正式列表成员和影子记录，对 patch 函数而言都是
        // upsert(date,stock) 定位 + 只写 yest_volume；in_watchlist 不通过 patch 上报。
        if (yesterdayPatches.length > 0) {
            patchAuctionFieldBatch(yesterday, yesterdayPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch yesterday ' + (e && e.message || e)); });
        }

        renderAuction();
        renderList();

        const yesterdaySource = yesterdayListWasEmpty
            ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
            : '';
        setApiStatus('thsApiStatus',
            '✅ ' + (overwrite ? '覆盖' : '补全') + ' 对比日昨成交量 ' + filled + '/' + yesterdayList.length + yesterdaySource + '，跳过 ' + skipped + '（无数据或缺代码）',
            true);
    } catch (err) {
        console.error('fillYesterdayYesterdayVolumeFromThs 失败:', err);
        let msg = err && err.message ? err.message : '补全失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export function fetchChangePctFromThs(btn) {
    showNumcatChoiceModal('获取涨幅模式', function(overwrite) {
        _fetchChangePctFromThsImpl(btn, overwrite);
    });
}

export async function _fetchChangePctFromThsImpl(btn, overwrite) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).filter(function(s) { return s && s.stock; });

        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }

        // 收集 thscode
        const scMap = state._scMapCache || {};
        const stockMap = {}; // thscode -> stock 对象
        const thscodes = [];
        todayList.forEach(function(s) {
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) {
                const thscode = tickerToThscode(code);
                if (thscode && !stockMap[thscode]) {
                    thscodes.push(thscode);
                    stockMap[thscode] = s;
                }
            }
        });

        if (thscodes.length === 0) {
            setApiStatus('thsApiStatus', '❌ 没有可查询的股票（缺少代码映射，请先获取最近多板）', false);
            return;
        }

        setApiStatus('thsApiStatus', '正在请求同花顺接口获取涨幅（' + thscodes.length + ' 只股票）...', true);

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
                data = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
            } catch (batchErr) {
                console.warn('snapshot 批量失败，降级逐只请求:', batchErr && batchErr.message);
                const rescued = [];
                for (let j = 0; j < chunk.length; j++) {
                    try {
                        const d1 = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk[j] });
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
                stock.note = buildNoteFromFields(stock.changePct, stock.topics);
                // patch 只携带本次改动的字段：change_pct + note
                changePctPatches.push({ stock: stock.stock, change_pct: stock.changePct, note: stock.note });
                filledCount++;
            });
        }

        auctionData[today] = todayList;
        saveModule('auction');
        invalidateTopicCache();
        renderAuction();
        renderList();

        // 同步到云端（字段级 patch，不再走整段 pushAuctionDataToCloud）
        if (changePctPatches.length > 0) {
            patchAuctionFieldBatch(today, changePctPatches).catch(function(e) {
                _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch changePct ' + (e && e.message || e));
            });
        }

        const action = overwrite ? '覆盖' : '补全';
        setApiStatus('thsApiStatus',
            '✅ ' + action + ' ' + filledCount + ' 只股票涨幅，跳过 ' + skippedCount + ' 只无数据或已有',
            true);
    } catch (err) {
        console.error('fetchChangePctFromThs 失败:', err);
        let msg = err && err.message ? err.message : '获取失败';
        if (msg.indexOf('Failed to fetch') >= 0) {
            msg = '代理请求失败，请确认 fuyao-proxy Edge Function 已部署';
        }
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function fillAuctionHistoryGapPctFromThs(btn, mode) {
    mode = (mode === 'overwrite') ? 'overwrite' : 'fill';
    const modeLabel = mode === 'overwrite' ? '覆盖' : '补全';
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        // 早盘竞价第一页正式列表（过滤影子记录）
        const todayList = getTodayAuction().filter(function(s) { return s && s.stock; });
        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
            return;
        }

        const scMap = state._scMapCache || {};
        const windowDates = [];
        let d = today;
        for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = getPreviousTradingDay(d); }
        if (windowDates.length === 0) {
            setApiStatus('thsApiStatus', '❌ 无法确定交易日序列', false);
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
                if (getStockHistoryValue(windowDates[i], name, 'volume', 'auction') !== null) { hasVol = true; break; }
            }
            if (!hasVol) missingVolumeInWindow++;
        });
        _dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 点击 | currentDate=' + today + ' | 正式列表=' + todayList.length +
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
                const vol = getStockHistoryValue(windowDates[i], name, 'volume', 'auction');
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
                const pct = getStockHistoryValue(dt, name, 'changePct', 'auction');
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
            const gapDates = rawGapDates.filter(isTradingDay);
            if (gapDates.length > 0) {
                gapMap[name] = { code: code, gapDates: gapDates, hadValueDates: hadValueDates, nonTradingSkip: rawGapDates.length - gapDates.length };
                totalGapDays += gapDates.length;
            } else {
                noGapNames.push(name);
            }
        });

        const stockNames = Object.keys(gapMap);
        _dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 目标汇总 | 有目标=' + stockNames.length + '（共' + totalGapDays + '天）' +
            ' | 窗口内有竞价量但无目标=' + noGapNames.length +
            ' | 窗口内无竞价量=' + noStartDateNames.length);
        if (stockNames.length === 0) {
            if (noStartDateNames.length > 0) {
                setApiStatus('thsApiStatus', '✅ 近5日涨幅无需' + modeLabel + '：' + noStartDateNames.length + ' 只股票窗口内无竞价量，无法定位起点；' + noGapNames.length + ' 只已有完整涨幅', true);
            } else {
                setApiStatus('thsApiStatus', '✅ 近5日涨幅无需' + modeLabel + '（所有股票已有完整涨幅）', true);
            }
            return;
        }

        setApiStatus('thsApiStatus',
            modeLabel + '模式：发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个目标日，正在逐只拉取历史K线...', true);

        const patchesByDate = {};
        let filledStocks = 0, failedStocks = 0, noDataStocks = 0;
        let filledGapDays = 0, overwrittenDays = 0, noDataGapDays = 0, nonTradingSkipTotal = 0;

        for (let si = 0; si < stockNames.length; si++) {
            const name = stockNames[si];
            const info = gapMap[name];
            nonTradingSkipTotal += (info.nonTradingSkip || 0);
            const earliestGap = info.gapDates[0];
            const baseDate = getPreviousTradingDay(earliestGap);
            if (!baseDate) {
                failedStocks++;
                _dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + ' 跳过：无法找到最早目标日 ' + earliestGap + ' 的前一交易日');
                continue;
            }
            const startMs = new Date(baseDate + 'T00:00:00').getTime();
            const endMs = new Date(today + 'T23:59:59').getTime();
            try {
                const data = await fuyaoApiGet('/api/a-share/prices/historical', {
                    thscode: tickerToThscode(info.code),
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
                    const prev = getPreviousTradingDay(gd);
                    return !closeByDate[gd] || (prev && !closeByDate[prev]);
                });
                _dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') ' + name + '(' + info.code + ') 返回K线日期=' + returnedDates.join(',') +
                    ' | 目标日=' + info.gapDates.join(',') +
                    (missingDates.length > 0 ? ' | 缺失前收/当日收=' + missingDates.join(',') : ''));
                let stockFilled = 0;
                let stockOverwritten = 0;
                let stockNoData = 0;
                info.gapDates.forEach(function(gapDate) {
                    const prevDate = getPreviousTradingDay(gapDate);
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
                    setApiStatus('thsApiStatus',
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
            patchAuctionFieldBatch(dt, patchesByDate[dt]).catch(function(e) {
                _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch 历史断点涨幅(' + modeLabel + ') ' + dt + ' ' + (e && e.message || e));
            });
        }

        renderAuction();

        _dbgLog('[AUCTION-BTN] 历史断点涨幅(' + modeLabel + ') 写入汇总 | 已写入股票=' + filledStocks +
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
        setApiStatus('thsApiStatus', statusParts.join('，') + '（影子记录，不影响任何日期的最近多板池）', true);
    } catch (err) {
        console.error('fillAuctionHistoryGapPctFromThs(' + modeLabel + ') 失败:', err);
        let msg = err && err.message ? err.message : (modeLabel + '失败');
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function fillAuctionHistoryGapYestVolumeFromThs(btn) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        // 早盘竞价第一页正式列表（过滤影子记录）
        const todayList = getTodayAuction().filter(function(s) { return s && s.stock; });
        if (todayList.length === 0) {
            setApiStatus('thsApiStatus', '❌ 当日列表为空，请先获取最近多板', false);
            return;
        }

        const scMap = state._scMapCache || {};
        const windowDates = [];
        let d = today;
        for (let i = 0; i < 5 && d; i++) { windowDates.unshift(d); d = getPreviousTradingDay(d); }
        if (windowDates.length === 0) {
            setApiStatus('thsApiStatus', '❌ 无法确定交易日序列', false);
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
                if (getStockHistoryValue(windowDates[i], name, 'volume', 'auction') !== null) { hasVol = true; break; }
            }
            if (!hasVol) missingVolumeInWindow++;
        });
        _dbgLog('[AUCTION-BTN] 历史断点昨日成交量 点击 | currentDate=' + today + ' | 正式列表=' + todayList.length +
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
                const vol = getStockHistoryValue(windowDates[i], name, 'volume', 'auction');
                if (vol !== null) { startDate = windowDates[i]; break; }
            }
            if (!startDate) { noStartDateNames.push(name); return; }
            const rawGapDates = [];
            let started = false;
            for (let i = 0; i < windowDates.length; i++) {
                const dt = windowDates[i];
                if (dt === startDate) started = true;
                if (!started) continue;
                const yv = getStockHistoryValue(dt, name, 'yestVolume', 'auction');
                if (yv === null) rawGapDates.push(dt);
            }
            const gapDates = rawGapDates.filter(isTradingDay);
            if (gapDates.length > 0) {
                gapMap[name] = { code: code, gapDates: gapDates, nonTradingSkip: rawGapDates.length - gapDates.length };
                totalGapDays += gapDates.length;
            } else {
                noGapNames.push(name);
            }
        });

        const stockNames = Object.keys(gapMap);
        _dbgLog('[AUCTION-BTN] 历史断点昨日成交量 断点汇总 | 有断点=' + stockNames.length + '（共' + totalGapDays + '天）' +
            ' | 窗口内有竞价量但无断点=' + noGapNames.length +
            ' | 窗口内无竞价量=' + noStartDateNames.length);
        if (stockNames.length === 0) {
            if (noStartDateNames.length > 0) {
                setApiStatus('thsApiStatus', '✅ 近5日昨日成交量无断点：' + noStartDateNames.length + ' 只股票窗口内无竞价量，无法定位起点；' + noGapNames.length + ' 只已有完整昨日成交量', true);
            } else {
                setApiStatus('thsApiStatus', '✅ 近5日昨日成交量无断点（所有股票已有完整昨日成交量）', true);
            }
            return;
        }

        setApiStatus('thsApiStatus',
            '发现 ' + stockNames.length + ' 只股票共 ' + totalGapDays + ' 个昨日成交量断点，正在逐只拉取历史日线...', true);

        const patchesByDate = {};
        let filledStocks = 0, failedStocks = 0, noDataStocks = 0;
        let filledGapDays = 0, noDataGapDays = 0, nonTradingSkipTotal = 0;

        for (let si = 0; si < stockNames.length; si++) {
            const name = stockNames[si];
            const info = gapMap[name];
            nonTradingSkipTotal += (info.nonTradingSkip || 0);
            const earliestGap = info.gapDates[0];
            const baseDate = getPreviousTradingDay(earliestGap);
            if (!baseDate) { failedStocks++; continue; }
            const startMs = new Date(baseDate + 'T00:00:00').getTime();
            const endMs = new Date(today + 'T23:59:59').getTime();
            try {
                const data = await fuyaoApiGet('/api/a-share/prices/historical', {
                    thscode: tickerToThscode(info.code),
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
                    const prev = getPreviousTradingDay(gd);
                    return !volByDate[prev];
                });
                _dbgLog('[AUCTION-BTN] 历史断点昨日成交量 ' + name + '(' + info.code + ') 返回成交量日期=' + returnedDates.join(',') +
                    ' | 断点日=' + info.gapDates.join(',') +
                    (missingDates.length > 0 ? ' | 缺失前日成交量=' + missingDates.join(',') : ''));
                let stockFilled = 0;
                let stockNoData = 0;
                info.gapDates.forEach(function(gapDate) {
                    const prevDate = getPreviousTradingDay(gapDate);
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
                    setApiStatus('thsApiStatus',
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
            patchAuctionFieldBatch(dt, patchesByDate[dt]).catch(function(e) {
                _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch 历史断点昨日成交量 ' + dt + ' ' + (e && e.message || e));
            });
        }

        renderAuction();

        _dbgLog('[AUCTION-BTN] 历史断点昨日成交量 写入汇总 | 已写入股票=' + filledStocks +
            ' | 已写入断点=' + filledGapDays +
            ' | 无成交量数据股票=' + noDataStocks + '（断点日=' + noDataGapDays + '）' +
            ' | 拉取失败=' + failedStocks +
            ' | 非交易日跳过=' + nonTradingSkipTotal);

        const statusParts2 = ['✅ 补全完成：' + filledStocks + ' 只股票、' + filledGapDays + ' 个断点日昨日成交量已写入'];
        if (noDataStocks > 0) statusParts2.push(noDataStocks + ' 只断点日无成交量数据');
        if (failedStocks > 0) statusParts2.push(failedStocks + ' 只拉取失败');
        if (nonTradingSkipTotal > 0) statusParts2.push('跳过 ' + nonTradingSkipTotal + ' 个非交易日断点');
        setApiStatus('thsApiStatus', statusParts2.join('，') + '（影子记录，不影响任何日期的最近多板池）', true);
    } catch (err) {
        console.error('fillAuctionHistoryGapYestVolumeFromThs 失败:', err);
        let msg = err && err.message ? err.message : '补全失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
        setApiStatus('thsApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export function fillYesterdayAuctionFromNumcat(btn) {
    showNumcatChoiceModal('补全昨日竞价量', function(overwrite) {
        fetchAuctionFromNumcat(btn, {
            fillYesterday: true, fillToday: false,
            overwriteYesterday: overwrite, overwriteToday: false
        });
    });
}

export function fetchTodayAuctionFromNumcat(btn) {
    showNumcatChoiceModal('获取当天竞价量', function(overwrite) {
        fetchAuctionFromNumcat(btn, {
            fillYesterday: false, fillToday: true,
            overwriteYesterday: false, overwriteToday: overwrite
        });
    });
}

export function fetchAllAuctionFromNumcat(btn) {
    showNumcatChoiceModal('全竞价量（昨日+今日）', function(overwrite) {
        fetchAuctionFromNumcat(btn, {
            fillYesterday: true, fillToday: true,
            overwriteYesterday: overwrite, overwriteToday: overwrite
        });
    });
}

export function fetchThreeDaysAuctionFromNumcat(btn) {
    fetchAuctionFromNumcat(btn, {
        fillToday: true, fillYesterday: true, fillDayBefore: true,
        overwriteToday: false, overwriteYesterday: false, overwriteDayBefore: false
    });
}

export async function fetchFiveDaysAuctionFromNumcat(btn) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const dates = [today];
        let d = today;
        for (let i = 0; i < 4; i++) {
            d = getPreviousTradingDay(d);
            if (!d) break;
            dates.push(d);
        }
        if (dates.length < 2) {
            setApiStatus('numcatApiStatus', '❌ 无法确定足够的历史交易日', false);
            return;
        }
        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).slice();
        if (todayList.length === 0) {
            setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }
        let scMap = state._scMapCache || {};
        if (Object.keys(scMap).length === 0 && typeof loadCloudStockCodeMap === 'function') {
            try { await loadCloudStockCodeMap(); } catch (e) {}
            scMap = state._scMapCache || {};
        }
        const allCodesSet = new Set();
        todayList.forEach(function(s) {
            if (!s || !s.stock) return;
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) allCodesSet.add(code);
        });
        if (allCodesSet.size === 0) {
            setApiStatus('numcatApiStatus', '❌ 没有可补全的股票（缺代码映射，请先导入代码映射）', false);
            return;
        }
        const symbols = Array.from(allCodesSet).join(',');
        const startYMD = dates[dates.length - 1].replace(/-/g, '');
        const endYMD = dates[0].replace(/-/g, '');
        const params = { symbols: symbols, startdate: startYMD, enddate: endYMD };
        setApiStatus('numcatApiStatus', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，连抓' + dates.length + '天，竞价量+昨成交量+涨幅）...', true);
        const fields = 'symbol,name,tradedate,auc_vol,auc_to_pre_vol_pct';
        const result = await numcatApiPost('daily_auc', fields, params);
        const fieldList = result.fields || [];
        const items = result.items || [];
        const symbolIdx = fieldList.indexOf('symbol');
        const tradedateIdx = fieldList.indexOf('tradedate');
        const aucVolIdx = fieldList.indexOf('auc_vol');
        const ratioIdx = fieldList.indexOf('auc_to_pre_vol_pct');
        if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
            setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
            return;
        }
        const aucByDate = {};
        items.forEach(function(row) {
            const code = String(row[symbolIdx] || '').trim();
            // [FIX 2026-08-15] 归一化 tradedate（'2026-08-10' → '20260810'），与请求窗口 ymd 对齐
            const tradedate = String(row[tradedateIdx] || '').trim().replace(/-/g, '');
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
        const dailyResult = await numcatApiPost('daily', 'symbol,tradedate,pct_chg', params);
        const dailyFieldList = dailyResult.fields || [];
        const dailyItems = dailyResult.items || [];
        const dSymbolIdx = dailyFieldList.indexOf('symbol');
        const dTradeIdx = dailyFieldList.indexOf('tradedate');
        const dPctIdx = dailyFieldList.indexOf('pct_chg');
        const pctByDate = {};
        if (dSymbolIdx >= 0 && dTradeIdx >= 0 && dPctIdx >= 0) {
            dailyItems.forEach(function(row) {
                const code = String(row[dSymbolIdx] || '').trim();
                // [FIX 2026-08-15] 归一化 tradedate（'2026-08-10' → '20260810'）
                const tradedate = String(row[dTradeIdx] || '').trim().replace(/-/g, '');
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
                if (entry.vol && getNumericVolume(s.volume) === null) {
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
                    s.note = buildNoteFromFields(s.changePct, s.topics);
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
        invalidateTopicCache();
        Object.keys(patchesByDate).forEach(function(dateStr) {
            patchAuctionFieldBatch(dateStr, patchesByDate[dateStr]).catch(function(e) {
                _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch ' + dateStr + ' ' + (e && e.message || e));
            });
        });
        renderAuction();
        renderList();
        const patchCounts = dates.map(function(d) { return (patchesByDate[d] || []).length; });
        const resultText = '✅ 连抓' + dates.length + '天完成：竞价量+' + filledVolCount + ' / 昨成交量(反推)+' + filledYestVolCount + ' / 涨幅+' + filledPctCount +
            '（各日只数：' + patchCounts.join('/') + '），跳过 ' + skippedCount + ' 只无数据';
        setApiStatus('numcatApiStatus', resultText, true);
    } catch (err) {
        console.error('fetchFiveDaysAuctionFromNumcat 失败:', err);
        let msg = err && err.message ? err.message : '获取失败';
        if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署';
        setApiStatus('numcatApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function fillTopicsFromNumcat(btn) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        // 方案2：用 _auctionWatchlistIndex 判断正式成员，只对正式成员补全题材
        const _ftWset = _getAuctionWatchlistSet(today);
        const todayList = (getAuctionData()[today] || []).filter(function(s) {
            return s && s.stock && _ftWset.has(s.stock.trim()) && !((s.topics || '').trim());
        });

        if (todayList.length === 0) {
            setApiStatus('numcatApiStatus', '❌ 没有需要补全题材的股票（所有股票已有题材）', false);
            return;
        }

        // 收集股票代码
        let scMap = state._scMapCache || {};
        // [FIX] 代码映射为空时按需从云端重新拉取一次（同 fetchAuctionFromNumcat）
        if (Object.keys(scMap).length === 0 && typeof loadCloudStockCodeMap === 'function') {
            try { await loadCloudStockCodeMap(); } catch (e) { _dbgLog('[NUMCAT-FIX] fillTopics 按需加载代码映射失败: ' + (e && e.message)); }
            scMap = state._scMapCache || {};
        }
        const codes = [];
        const codeToStock = {};
        const noCodeNames = [];   // 因缺少代码映射而未能发起查询的股票（对应「股票+代码表无对应」）
        todayList.forEach(function(s) {
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) {
                codes.push(code);
                codeToStock[code] = s;
            } else {
                noCodeNames.push(s.stock);
            }
        });

        if (codes.length === 0) {
            const hasAnyCode = todayList.some(function(s) { return (s.code || '').trim(); });
            setApiStatus('numcatApiStatus', hasAnyCode
                ? '❌ 没有可补全的股票（代码映射缺失，请先「设置-导入代码映射」或重新登录后重试）'
                : '❌ 没有可补全的股票（缺少代码映射）', false);
            return;
        }

        setApiStatus('numcatApiStatus', '正在请求猫抓接口补全题材（' + codes.length + ' 只股票）...', true);

        // 不传 tradedate，让接口默认查最新交易日（题材是股票属性，不依赖日期；
        // 传非交易日会返回"未找到选股数据"）
        const data = await numcatApiPost('screening',
            'symbol,theme_names_kpl',
            { symbols: codes.join(',') }
        );

        const fields = data.fields || [];
        const items = data.items || [];
        const symIdx = fields.indexOf('symbol');
        const themeIdx = fields.indexOf('theme_names_kpl');

        if (symIdx < 0 || themeIdx < 0) {
            setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
            return;
        }

        let filledCount = 0;
        let emptyThemeCount = 0;          // 接口返回了但 theme_names_kpl 为空 → 接口本身无题材数据
        const returnedCodes = new Set();   // 接口实际返回的行对应的代码集合
        // 阶段四 Bug 5 收尾：改用字段级 patch 上报，只携带本次真正改动的 topics 字段
        const topicsPatches = [];
        items.forEach(function(row) {
            const code = String(row[symIdx] || '').trim();
            const themeNames = String(row[themeIdx] || '').trim();
            const stock = codeToStock[code];
            returnedCodes.add(code);
            if (!stock) return;
            if (!themeNames) {
                emptyThemeCount++;
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
                emptyThemeCount++;
                return;
            }
            const allTopicsStr = topicList.join('，');
            stock.topics = allTopicsStr;
            topicsPatches.push({ stock: stock.stock, topics: allTopicsStr });
            // 同步推送到跨 tab 共享的 stock_topics 表（合并去重，不覆盖丢失旧题材）
            const stockCode = (stock.code || scMap[stock.stock.trim()] || '').trim();
            pushStockTopicsToCloud(stock.stock, topicList, stockCode).catch(function(e) {
                console.warn('pushStockTopicsToCloud 失败（fillTopicsFromNumcat）:', stock.stock, e);
            });
            filledCount++;
        });

        // 发起查询但接口未返回任何行的代码（代码无法被识别 / 接口确实无该票）
        const interfaceMissingCodes = codes.filter(function(c) { return !returnedCodes.has(c); });
        const interfaceMissingNames = interfaceMissingCodes.map(function(c) { return (codeToStock[c] && codeToStock[c].stock) || c; });

        saveModule('auction');
        invalidateTopicCache();
        renderAuction();
        renderList();

        // 同步到云端（字段级 patch，不再走整段 pushAuctionDataToCloud）
        if (topicsPatches.length > 0) {
            patchAuctionFieldBatch(today, topicsPatches).catch(function(e) {
                _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch topics ' + (e && e.message || e));
            });
        }

        // 诊断明细：区分三类「未补全」原因，让用户能直接判断是「代码映射缺失」还是「接口无题材」
        let detail = '';
        if (noCodeNames.length) {
            detail += '；代码映射缺失未查询(' + noCodeNames.length + ')：' + noCodeNames.slice(0, 25).join('、');
        }
        if (interfaceMissingNames.length) {
            detail += '；接口无返回(' + interfaceMissingNames.length + ')：' + interfaceMissingNames.slice(0, 25).join('、');
        }
        if (emptyThemeCount) {
            detail += '；接口返回但无题材(' + emptyThemeCount + ')';
        }
        const headline = filledCount > 0 ? ('✅ 补全 ' + filledCount + ' 只题材') : ('⚠️ 题材补全 0 只');
        setApiStatus('numcatApiStatus', headline + detail, filledCount > 0);
    } catch (err) {
        console.error('fillTopicsFromNumcat 失败:', err);
        let msg = err && err.message ? err.message : '获取失败';
        if (msg.indexOf('Failed to fetch') >= 0) {
            msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
        }
        setApiStatus('numcatApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function fetchMonitorWarningFromNumcat(btn) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        // 方案2：用 _auctionWatchlistIndex 判断正式成员，只查询正式成员的监管记录
        const _mwWset = _getAuctionWatchlistSet(today);
        const fullList = (getAuctionData()[today] || []).filter(function(s) { return s && s.stock && _mwWset.has(s.stock.trim()); });

        if (fullList.length === 0) {
            setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }

        // 收集股票代码
        const scMap = state._scMapCache || {};
        const codes = [];
        fullList.forEach(function(s) {
            const code = (s.code || scMap[s.stock.trim()] || '').trim();
            if (code) codes.push(code);
        });

        if (codes.length === 0) {
            setApiStatus('numcatApiStatus', '❌ 没有可查询的股票（缺少代码映射）', false);
            return;
        }

        // 先清除所有股票的监管标记（重新查询）
        fullList.forEach(function(s) { delete s.monitorWarning; });

        setApiStatus('numcatApiStatus', '正在请求猫抓接口查询监管记录（' + codes.length + ' 只股票）...', true);

        // 查最近 5 个交易日
        const startdate = getNthPreviousTradingDay(today, 5).replace(/-/g, '');
        const enddate = today.replace(/-/g, '');

        const data = await numcatApiPost('point_monitor',
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
            setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
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

        saveModule('auction');
        renderAuction();
        renderList();
        // 阶段四 Bug 5 收尾：monitorWarning 是纯内存字段（不在 auction_watchlist / market_metrics 的列里，
        // 也不在 AUCTION_PATCHABLE_FIELDS 白名单里），无需同步到云端。
        // 原本的 pushAuctionDataToCloud(today, ...) 会把整行（含 volume/yest_volume 等）
        // 一起带上，反而会覆盖云端其它字段，属于副作用大于收益的残留代码，直接删除。

        setApiStatus('numcatApiStatus',
            '✅ 查询到 ' + markedCount + ' 只股票有严重异常波动（最近 5 个交易日）',
            true);
    } catch (err) {
        console.error('fetchMonitorWarningFromNumcat 失败:', err);
        let msg = err && err.message ? err.message : '获取失败';
        if (msg.indexOf('Failed to fetch') >= 0) {
            msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
        }
        setApiStatus('numcatApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function fetchAuctionFromNumcat(btn, opts) {
    setBtnLoading(btn, true);
    try {
        const today = useUiStore().currentDate;
        const yesterday = getPreviousTradingDay(today);
        if (!yesterday) {
            setApiStatus('numcatApiStatus', '❌ 无法确定上一交易日', false);
            return;
        }
        // 「连抓三天补全」：前天（T-2）也纳入补全范围
        const dayBefore = opts.fillDayBefore ? getPreviousTradingDay(yesterday) : null;
        if (opts.fillDayBefore && !dayBefore) {
            setApiStatus('numcatApiStatus', '❌ 无法确定前两个交易日', false);
            return;
        }

        const auctionData = getAuctionData();
        const todayList = (auctionData[today] || []).slice();
        if (todayList.length === 0) {
            setApiStatus('numcatApiStatus', '❌ 当日列表为空，请先导入股票到表格', false);
            return;
        }
        // yesterdayList 始终基于 todayList（当前显示的表格），保留 auctionData[yesterday] 原有同名股票的业务字段
        const yesterdayList = opts.fillYesterday
            ? buildYesterdayListFromToday(todayList, auctionData, yesterday)
            : [];
        const yesterdayListWasEmpty = opts.fillYesterday && (auctionData[yesterday] || []).length === 0;
        // 前天列表同样处理：有正式列表就基于它保留字段，没有就造影子（落影子记录，不进前天第一页）
        const dayBeforeList = opts.fillDayBefore
            ? buildYesterdayListFromToday(todayList, auctionData, dayBefore)
            : [];
        const dayBeforeListWasEmpty = opts.fillDayBefore && (auctionData[dayBefore] || []).length === 0;
        let scMap = state._scMapCache || {};

        // [FIX] 代码映射为空时，先按需从云端重新拉取一次。
        // 启动期 loadCloudStockCodeMap 可能因登录时序 / 网络抖动失败，导致 _scMapCache 一直为空，
        // 后续猫抓直接报"缺少代码映射"。这里在真正抓取前兜底重试一次（失败不影响后续用 s.code 兜底）。
        if (Object.keys(scMap).length === 0 && typeof loadCloudStockCodeMap === 'function') {
            try {
                await loadCloudStockCodeMap();
            } catch (e) {
                _dbgLog('[NUMCAT-FIX] 按需加载代码映射失败: ' + (e && e.message));
            }
            scMap = state._scMapCache || {};
        }

        const needToday = opts.fillToday && todayList.length > 0;
        const needYesterday = opts.fillYesterday && yesterdayList.length > 0;
        const needDayBefore = opts.fillDayBefore && dayBeforeList.length > 0;
        if (!needToday && !needYesterday && !needDayBefore) {
            setApiStatus('numcatApiStatus', '❌ 没有可补全的股票', false);
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
            setApiStatus('numcatApiStatus', hasAnyCode
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
                    if (getNumericVolume(s.volume) === null) missing++;
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
        _dbgLog('[NUMCAT-DEBUG] 猫抓预检 | currentDate=' + today + ' | 缺失快照=' + JSON.stringify(preCheck));

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
        _dbgLog('[NUMCAT-DEBUG] 点击猫抓 | currentDate=' + today + ' | yesterday=' + yesterday +
            ' | dayBefore=' + (dayBefore || '(无)') + ' | opts=' + JSON.stringify({ fillToday: opts.fillToday, fillYesterday: opts.fillYesterday, fillDayBefore: opts.fillDayBefore, overwriteToday: opts.overwriteToday, overwriteYesterday: opts.overwriteYesterday, overwriteDayBefore: opts.overwriteDayBefore }) +
            ' | codes=' + allCodesSet.size + ' | params=' + JSON.stringify(params));

        const dayCountText = reqDates.length === 3 ? '三天' : (reqDates.length === 2 ? '两天' : '单日');
        const todayFieldHint = opts.fillToday ? '；今日同时补竞价量+涨幅' : '';
        setApiStatus('numcatApiStatus', '正在请求猫抓接口（' + allCodesSet.size + ' 只股票，' + dayCountText + todayFieldHint + '）...', true);

        const fields = 'symbol,name,tradedate,auc_vol,auc_pct_chg';
        const result = await numcatApiPost('daily_auc', fields, params);

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
        _dbgLog('[NUMCAT-DEBUG] 猫抓返回 rawItems=' + items.length + ' 各交易日行数=' + JSON.stringify(dateRowCounts) +
            ' fields=' + JSON.stringify(fieldList));
        if (symbolIdx < 0 || tradedateIdx < 0 || aucVolIdx < 0) {
            setApiStatus('numcatApiStatus', '❌ 返回数据字段不完整', false);
            return;
        }

        // 按日期分组：YYYYMMDD -> { code: { vol: aucVol(万), pct: "+2.5%", rawPct } }
        // [FIX 2026-08-15] 归一化 tradedate 为 YYYYMMDD（接口可能返回 '20260810' 或 '2026-08-10'，
        // 统一 key 避免与请求窗口 dates 的 ymd 比对时 miss，历史日期补全同样适用）。
        const aucByDate = {};
        items.forEach(function(row) {
            const code = String(row[symbolIdx] || '').trim();
            const tradedateRaw = String(row[tradedateIdx] || '').trim();
            const tradedate = tradedateRaw.replace(/-/g, '');
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
                    const needVol = overwrite || getNumericVolume(s.volume) === null;
                    if (needVol) {
                        s.volume = String(dayEntry.vol);
                        volWritten = true;
                    }
                    // 涨幅：仅今天(fillPct=true)且接口返回了pct时处理
                    if (fillPct && dayEntry.pct) {
                        const needPct = overwrite || !((s.changePct || '').trim());
                        if (needPct) {
                            s.changePct = dayEntry.pct;
                            s.note = buildNoteFromFields(s.changePct, s.topics);
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
                localStorage.setItem('lastNumcatFillDebug_' + today, JSON.stringify({ // 合规：诊断调试快照（§8 允许）
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
        invalidateTopicCache();

        // 阶段二 B：改用字段级 patch 上报，不再走整段 pushAuctionDataToCloud。
        // yesterdayPatches 同时包含"正式列表成员"和"影子记录"——对 patch 函数而言
        // 两者都是 upsert(date,stock) 定位 + 只写 volume，影子记录在 _auctionMemCache
        // 里新建时 in_watchlist 默认 false，正是预期行为；in_watchlist 字段不通过 patch 上报，
        // 由 syncAuctionListForDate 单独管理（清单改造项 2 边界问题）。
        if (todayPatches.length > 0) {
            patchAuctionFieldBatch(today, todayPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch today ' + (e && e.message || e)); });
        }
        if (yesterdayPatches.length > 0) {
            patchAuctionFieldBatch(yesterday, yesterdayPatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch yesterday ' + (e && e.message || e)); });
        }
        if (dayBeforePatches.length > 0) {
            patchAuctionFieldBatch(dayBefore, dayBeforePatches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch dayBefore ' + (e && e.message || e)); });
        }

        renderAuction();
        renderList();

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
        setApiStatus('numcatApiStatus', resultText, true);
    } catch (err) {
        console.error('fetchAuctionFromNumcat 失败:', err);
        let msg = err && err.message ? err.message : '获取失败';
        if (msg.indexOf('Failed to fetch') >= 0) {
            msg = '代理请求失败，请确认 numcat-proxy Edge Function 已部署且 NUMCAT_API_KEY 已设置';
        }
        setApiStatus('numcatApiStatus', '❌ ' + msg, false);
    } finally {
        setBtnLoading(btn, false);
    }
}


export const AUCTION_WATCHLIST_FIELDS = ['note', 'topics', 'source', 'obs_auto_added', 'selected', 'bought', 'sold', 'fixed', 'code'];

export const AUCTION_METRICS_FIELDS = ['volume', 'yest_volume', 'change_pct', 'time930', 'seal_count', 'code'];

export const AUCTION_PATCHABLE_FIELDS = AUCTION_WATCHLIST_FIELDS.concat(AUCTION_METRICS_FIELDS.filter(function(f) { return AUCTION_WATCHLIST_FIELDS.indexOf(f) < 0; }));

export var _auctionFirstClearDumped = false;

