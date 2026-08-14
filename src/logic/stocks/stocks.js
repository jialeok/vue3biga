import { state } from '../app-state.js';
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
import { getJingYestHighlightSetForDate, getJingYestStocksForDate } from '../auction-sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../auction-stock-sync.js';
import { getStats } from '../jiwang-helpers.js';
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from '../note-helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from '../scope-helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from '../tag-rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from '../trading-day-helpers.js';
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from '../date/date-helpers.js';
import { _domGet, _domQuery, _domSetColor, _domSetText, _domSetValue, _getCommentInputValue, _readTrackEditFormData, _restoreStockCardExpand, closeCommentModal, closeHotEditModal, closeTrackEditModal, copyAllTopicStocks, copyTopicStocks, expandAllAuctionTrendPanels, expandAllAuctionTrendPanelsP2, getNthPreviousTradingDay, handleFileImport, jumpToAuctionPage1, jumpToAuctionPage2, openAuctionEdit, openAuctionNoteEditFromPage2, openCoreTopicModal, openHotEdit, recalcDuibanFromAuction, renderAuction, renderAuctionForm, renderBidding, renderComment, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, resetExpansionStateOnDateSwitch, restoreExpandedAuctionTrendPanels, restoreExpandedTopicGroupsP2, saveAuction, setApiStatus, setStockCodeMapStatus, setStockCodeMapStatusHot, showAuctionBuyPrompt, showAuctionDiagReport, showAuctionNoteInput, showAuctionNotePopup, showHint, showHotDiagReport, showNumcatChoiceModal, toggleAuctionBoard, toggleAuctionRowSelect, toggleAuctionSortHelp, toggleStrengthSort, toggleTopicGroupTrendPanels, updateCloudSyncUI } from '../ui-bridge.js';
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore, _bindUiFns } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getGroupData, patchHotFieldBatch, patchAuctionFieldBatch, _getAuctionStore, getAuctionData, mergeAuctionDateRows, markAuctionDirty, scheduleCloudPush, saveData, saveModule } from '../app-core.js';

// §16 域拆分：stocks 域（原 app-core.js 迁出）
export function getStockHistoryTopics(stockName) {
    if (!stockName) return '';
    if (state._topicCacheBuilt && state._topicCache) {
        const topics = state._topicCache[stockName.trim()];
        if (!topics || topics.size === 0) return '';
        return '(' + Array.from(topics).join('，') + ')';
    }
    // 无缓存时只扫最近3个月
    const TOPIC_CACHE_DAYS = 66;
    const auctionData = getAuctionData();
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

export async function searchTickerCodeByName(name) {
    if (!name) return '';
    try {
        const data = await fuyaoApiGet('/api/meta/tickers/search', {
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
        _dbgLog('[AUTO-CODE] 搜索 ' + name + ' 失败: ' + (e && e.message || e));
    }
    return '';
}

export async function autoCompleteMissingStockCodes(dataSource) {
    const ds = dataSource === 'hot' ? 'hot' : 'auction';
    const list = (getGroupData(ds)[useUiStore().currentDate] || []).filter(function(r) { return r && r.stock; });
    const scMap = state._scMapCache || {};
    const missing = list.filter(function(r) {
        const existing = (r.code || '').trim() || scMap[r.stock.trim()];
        return !existing;
    });
    if (missing.length === 0) {
        const msg = '没有缺失代码的股票';
        showToast(msg);
        return msg;
    }

    let completed = 0, failed = 0;
    const patches = [];
    const scPairs = [];
    for (let i = 0; i < missing.length; i++) {
        const item = missing[i];
        const name = item.stock.trim();
        const code = await searchTickerCodeByName(name);
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
            await upsertStockCodeMap(scPairs);
        } catch (e) {
            _dbgLog('[AUCTION-ERR] autoCompleteMissingStockCodes upsertStockCodeMap ' + (e && e.message || e));
        }
        try {
            if (ds === 'hot') {
                await patchHotFieldBatch(useUiStore().currentDate, patches);
            } else {
                await patchAuctionFieldBatch(useUiStore().currentDate, patches);
            }
        } catch (e) {
            _dbgLog('[AUCTION-ERR] autoCompleteMissingStockCodes patchFieldBatch ' + (e && e.message || e));
        }
    }

    const msg = '代码补全：' + completed + ' 只成功，' + failed + ' 只失败';
    showToast(msg);
    try {
        if (ds === 'hot') {
            if (typeof renderHotStocks === 'function') renderHotStocks();
        } else {
            if (typeof renderAuction === 'function') renderAuction();
        }
    } catch (e) {
        _dbgLog('[AUCTION-ERR] autoCompleteMissingStockCodes render ' + (e && e.message || e));
    }
    return msg;
}

export async function importStockCodeMap(rawText) {
    const targetDate = _getAuctionStore() ? _getAuctionStore().currentDate : useUiStore().currentDate;
    const raw = (rawText || '').trim();
    if (!raw) { throw new Error('请先粘贴数据'); }
    const map = Object.assign({}, state._scMapCache || {});
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
        await upsertStockCodeMap(scPairs);
    } catch (e) {
        _dbgLog('[AUCTION-ERR] importStockCodeMap upsertStockCodeMap ' + (e && e.message || e));
    }

    // 同步到今日竞价列表：将导入的名称追加到 auction[targetDate]（已存在的不重复添加）
    let addedToAuction = 0;
    if (newNames.length > 0) {
        // 阶段四 Bug 3 修复：getAuctionData() 已直接返回 _auctionMemCache，
        // 直接操作它即可，不再需要 allData.auction = auctionData 这种重赋值（原本是为了触发 localStorage 落地，现已不落地）
        const auctionData = getAuctionData();
        if (!Array.isArray(auctionData[targetDate])) setAuctionDateData(targetDate, [], 'importAuctionCodeMap-init');
        const list = auctionData[targetDate];
        const newStocksAdded = [];
        const newRows = [];
        newNames.forEach(name => {
            const exists = list.some(item => item && item.stock && item.stock.trim() === name);
            if (!exists) {
                // 方案2：行对象不携带 in_watchlist，通过 _addAuctionWatchlistMember 登记为正式成员
                newRows.push({ stock: name, volume: '', yestVolume: '', note: '', selected: false, bought: false, sold: false, fixed: false });
                _addAuctionWatchlistMember(targetDate, name);
                newStocksAdded.push(name);
                addedToAuction++;
            }
        });
        if (newRows.length > 0) mergeAuctionDateRows(targetDate, newRows, 'importAuctionCodeMap');
        // 主动往 auction[targetDate] 增加了股票，标记为脏日期，
        // 允许下次推送时用本地（含新增股票）的名单覆盖云端该日期
        markAuctionDirty(targetDate);
        // 阶段四 Bug 3 修复：新增的股票也走 patchAuctionFieldBatch 上报到云端（带 code 字段），
        // 不再依赖 saveModule('auction') 落 localStorage
        if (newStocksAdded.length > 0) {
            const scMap = state._scMapCache || {};
            const patches = newStocksAdded.map(function(name) {
                return { stock: name, code: scMap[name] || '', volume: '', yest_volume: '', note: '', change_pct: '', topics: '', selected: false, bought: false, sold: false, fixed: false };
            });
            patchAuctionFieldBatch(targetDate, patches).catch(function(e) { _dbgLog('[AUCTION-ERR] patchAuctionFieldBatch code-map-import ' + (e && e.message || e)); });
        }
        // 刷新由 Vue 组件在导入完成后统一触发（refreshRows + auctionStore.refresh）
    }

    scheduleCloudPush();
    // 同步代码到 auction_watchlist + market_metrics 的 code 列（拆表后新增）
    pushAuctionCodeToCloud(targetDate).catch(function(e) { _dbgLog('[AUCTION-ERR] importAuctionCodeMap pushAuctionCodeToCloud ' + targetDate + ' ' + (e && e.message || e)); });
    return `✅ 已导入 ${count} 条映射，${addedToAuction} 只已加入今日竞价列表`;
}

export function extractCodeFromFuyaoItem(item) {
    if (!item) return '';
    if (item.ticker) return String(item.ticker).trim();
    if (item.thscode) {
        const code = String(item.thscode).trim().replace(/\..*$/, '');
        if (/^\d{6}$/.test(code)) return code;
    }
    return '';
}

export async function replaceConceptFromPaste(rawText) {
    const targetDate = _getAuctionStore() ? _getAuctionStore().currentDate : useUiStore().currentDate;
    const pasteText = (rawText || '').trim();
    if (!pasteText) {
        throw new Error('请先粘贴数据！');
    }

    const lines = pasteText.split(/\r?\n/);
    const auctionData = getAuctionData();
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
        setAuctionDateData(targetDate, existingList, 'replaceAuctionConceptFromPaste');
        saveData();
        invalidateTopicCache();
        markAuctionDirty(targetDate);
        scheduleCloudPush();
        
        // 同步更新已添加股票的收盘涨幅（只更新内存）
        existingList.forEach(item => {
            if (item.stock && item.note) {
                syncStockCloseFromAuction(item.stock, item.note);
            }
        });
        
        // 同步题材，统一保存一次
        syncStockTopicsFromAuction();
        saveModule('stocks');
        
        // 概念替换可能改变了note的格式，保险起见重新统计一次"最近多板"
        recalcDuibanFromAuction();
    }

    let statusMsg = '✅ 替换了 ' + replaceCount + ' 条概念';
    if (notFoundCount > 0) {
        statusMsg += '，未找到: ' + notFoundStocks.slice(0, 3).join(', ') + (notFoundCount > 3 ? '...' : '');
    }
    return statusMsg;
}

