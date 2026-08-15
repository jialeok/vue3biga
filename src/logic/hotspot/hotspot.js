import { state } from '../app-state.js';
if (!state._hotspotMemCache) state._hotspotMemCache = {}; // §6.1：域缓存下沉，hotspot 域拥有 _hotspotMemCache
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
import { getJingYestHighlightSetForDate, getJingYestStocksForDate } from '../auction/sort-rules.js';
import { syncStockCloseFromAuction, syncStockTopicsFromAuction } from '../auction/stock-sync.js';
import { getStats } from '../jiwang/helpers.js';
import { buildNoteFromFields, cleanTopicsForDisplay, parseNoteToFields } from '../note/helpers.js';
import { _backupScopeData, _mergePatchLocal, _patchScopeField, _sanitizePatch, _splitPatch } from '../scope/helpers.js';
import { _getLocalTodayStr, deriveAuctionTagState } from '../tagTitles/rules.js';
import { getMostRecentTradingDay, getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { getWeekday, getPreviousDate, getNextDate, _shiftDateStr, buildYesterdayListFromToday } from '../date/date-helpers.js';
import { _domGet, _domQuery, _domSetColor, _domSetText, _domSetValue, _getCommentInputValue, _readTrackEditFormData, _restoreStockCardExpand, closeCommentModal, closeHotEditModal, closeTrackEditModal, copyAllTopicStocks, copyTopicStocks, expandAllAuctionTrendPanels, expandAllAuctionTrendPanelsP2, getNthPreviousTradingDay, handleFileImport, jumpToAuctionPage1, jumpToAuctionPage2, openAuctionEdit, openAuctionNoteEditFromPage2, openCoreTopicModal, openHotEdit, recalcDuibanFromAuction, renderAuction, renderAuctionForm, renderBidding, renderComment, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, resetExpansionStateOnDateSwitch, restoreExpandedAuctionTrendPanels, restoreExpandedTopicGroupsP2, saveAuction, setApiStatus, setStockCodeMapStatus, setStockCodeMapStatusHot, showAuctionBuyPrompt, showAuctionDiagReport, showAuctionNoteInput, showAuctionNotePopup, showHint, showHotDiagReport, showNumcatChoiceModal, toggleAuctionBoard, toggleAuctionRowSelect, toggleAuctionSortHelp, toggleStrengthSort, toggleTopicGroupTrendPanels, updateCloudSyncUI } from '../ui-bridge.js';
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore, _bindUiFns } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';

// §16 域拆分：hotspot 域（原 app-core.js 迁出）
export function _openHotAuctionShield() {
    state._justPushedHotAuctionCounter++;
    state._justPushedHotAuction = true;
    if (state._justPushedHotAuctionTimer) {
        clearTimeout(state._justPushedHotAuctionTimer);
        state._justPushedHotAuctionTimer = null;
    }
}

export function _closeHotAuctionShield(delayMs) {
    state._justPushedHotAuctionCounter = Math.max(0, state._justPushedHotAuctionCounter - 1);
    if (state._justPushedHotAuctionCounter === 0) {
        if (state._justPushedHotAuctionTimer) clearTimeout(state._justPushedHotAuctionTimer);
        state._justPushedHotAuctionTimer = setTimeout(function() {
            state._justPushedHotAuction = false;
            state._justPushedHotAuctionTimer = null;
        }, delayMs || 2000);
    }
}

export function _sanitizeHotPatch(patch) {
    return _sanitizePatch(patch, HOT_PATCHABLE_FIELDS);
}

export function _splitHotPatch(cleanPatch) {
    return _splitPatch(cleanPatch, HOT_WATCHLIST_FIELDS, HOT_METRICS_FIELDS);
}

export function _mergeHotPatchLocal(date, stock, cleanPatch) {
    return _mergePatchLocal(date, stock, cleanPatch, state._hotFullRowCache, function(d) { state._hotFullRowCache[d] = []; });
}

export async function patchHotField(date, stock, patch) {
    return _patchScopeField(date, stock, patch, patchHotFieldBatch);
}

export async function patchHotFieldBatch(date, items) {
    if (!date || !Array.isArray(items) || items.length === 0) return { ok: true, rows: 0 };
    _openHotAuctionShield();
    try {
        const now = new Date().toISOString();
        const watchlistRows = [];
        const metricsRows = [];
        const localOps = [];

        // 方案2：用 _hotWatchlistIndex 独立 Set 判断正式成员，不依赖行对象上的 in_watchlist 字段
        const watchlistSet = state._hotWatchlistIndex[date] || new Set();
        function isWatchlistStock(nameTrim) {
            return watchlistSet.has(nameTrim);
        }
        isWatchlistStock = isWatchlistStock;

        items.forEach(function(item) {
            if (!item || !item.stock) return;
            const nameTrim = item.stock.trim();
            if (!nameTrim) return;
            const cleanPatch = _sanitizeHotPatch(item);
            if (Object.keys(cleanPatch).length === 0) return;
            const split = _splitHotPatch(cleanPatch);

            // 只有正式成员才写hot_stocks表；影子记录只写market_metrics
            const isInWatchlist = isWatchlistStock(nameTrim);
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
            _mergeHotPatchLocal(date, op.stock, op.cleanPatch);
        });

        // [DEBUG] 记录进入云端同步前的表就绪状态，帮助定位"刷新后消失"问题
        _dbgLog('[PATCH-HOT] date=' + date + ' 待写入 metrics=' + metricsRows.length +
            ' watchlist=' + watchlistRows.length +
            ' state._hotAuctionTableAvailable=' + state._hotAuctionTableAvailable +
            ' state._marketMetricsTableAvailable=' + state._marketMetricsTableAvailable +
            ' 样本=' + (metricsRows[0] && metricsRows[0].stock || 'N/A'));

        // 云端同步：等待表就绪最多 5 秒
        if (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable) {
            const waitStart = Date.now();
            while (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable && Date.now() - waitStart < 5000) {
                await new Promise(function(r) { setTimeout(r, 100); });
            }
            if (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable) {
                // [BUG-FIX] 原 ok:true 会让调用方误以为云端写入成功，导致 UI 显示绿勾。
                // 实际云端未写入，刷新后数据会丢失。改为 ok:false，让调用方走错误分支提示用户重试。
                console.warn('patchHotFieldBatch：hot_stocks 与 market_metrics 表均未就绪，本地缓存已更新但云端未同步。日期:', date);
                return { ok: false, rows: localOps.length, cloudSkipped: true, error: new Error('云端表未就绪，数据未上传（已暂存本地）') };
            }
        }

        const sb = getSupabase();
        if (state._hotAuctionTableAvailable && watchlistRows.length > 0) {
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
                    state._marketMetricsTableAvailable = false;
                }
                throw error;
            }
            state._marketMetricsTableAvailable = true;
            _dbgLog('[PATCH-HOT] market_metrics 写入成功 date=' + date + ' rows=' + metricsRows.length);
        }

        return { ok: true, rows: localOps.length };
    } catch (e) {
        console.warn('patchHotFieldBatch 失败(本地缓存已更新，仅云端未同步):', date, e && e.message);
        return { ok: false, error: e };
    } finally {
        _closeHotAuctionShield(2000);
    }
}

export function getHotspotData() { return state._hotspotMemCache || loadAllData().hotspot; }

export function getHotAuctionData() { return state._hotAuctionData || (state._hotAuctionData = {}); }

export function backupHotStocksData(type, date) {
    return _backupScopeData({
        type: type, date: date,
        getDataFn: getHotAuctionData,
        backupKeyPrefix: 'hotStocksData',
        label: '热门股票'
    });
}

export function importHotFromPaste() {
    const textarea = _domGet('hotPasteInput');
    const rawText = textarea ? textarea.value : '';
    const pasteText = rawText.trim();
    if (!pasteText) {
        const status = _domGet('hotImportStatus');
        status.textContent = '请先粘贴数据！';
        status.style.color = '#dc2626';
        textarea && textarea.focus();
        return;
    }
    backupHotStocksData('import');
    buildTopicCache();
    const scMap = state._scMapCache || {};
    const lines = pasteText.split(/\r?\n/);
    const hotData = getHotAuctionData();
    const existingList = hotData[useUiStore().currentDate] || [];
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
                var note = buildNoteFromFields(changePctStr, topicsStr);
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
            var note = buildNoteFromFields(changePctStr, topicsStr);
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
                var note = buildNoteFromFields(changePctStr, topicsStr);
                noteList.push({ stock: stock, note: note, changePct: changePctStr, topics: topicsStr });
            }
        }
    });

    if (fullDataList.length === 0 && noteList.length === 0) {
        const status = _domGet('hotImportStatus');
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
                const historyTopics = getStockHistoryTopics(dataItem.stock);
                existingNote = historyTopics;
                var parsed = parseNoteToFields(historyTopics);
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
            const historyTopics = getStockHistoryTopics(dataItem.stock);
            var parsedHist = parseNoteToFields(historyTopics);
            // [BUG-FIX] 新股票回填代码：优先 stockcodemap，再云端快照缓存。
            const cached = (state._hotFullRowCache[useUiStore().currentDate] || []).find(function(r) { return r && r.stock === dataItem.stock; });
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
        const historyTopics = getStockHistoryTopics(noteItem.stock);
        var historyParsed = parseNoteToFields(historyTopics);
        var newChangePct = noteItem.changePct || '';
        var newTopics = noteItem.topics || '';
        if (existingIndex >= 0) {
            var existingChangePct = hotList[existingIndex].changePct || '';
            var existingTopics = hotList[existingIndex].topics || '';
            if (!existingChangePct && !existingTopics && hotList[existingIndex].note) {
                var exParsed = parseNoteToFields(hotList[existingIndex].note);
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
            hotList[existingIndex].note = buildNoteFromFields(hotList[existingIndex].changePct, hotList[existingIndex].topics);
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
            const cached2 = (state._hotFullRowCache[useUiStore().currentDate] || []).find(function(r) { return r && r.stock === noteItem.stock; });
            hotList.push({
                stock: noteItem.stock, volume: '', yestVolume: '',
                code: scMap[noteItem.stock] || (cached2 ? (cached2.code || '') : '') || '',
                note: buildNoteFromFields(finalChangePct, finalTopics),
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
    getHotAuctionData()[useUiStore().currentDate] = hotList;
    invalidateTopicCache();
    // 同步到 hot_stocks 表：增删/状态用 syncHotStocksListForDate，
    // 但它不会把已有股票的 note/changePct/topics/volume 写到云端（只处理增删和选中状态），
    // 所以这里必须再补一次 pushHotStocksDataToCloud，否则涨幅/题材/注释等更新只留在本地，刷新后消失
    syncHotStocksListForDate(useUiStore().currentDate).catch(function(err) {
        console.error('importHotFromPaste syncHotStocksListForDate 失败:', err);
    });
    pushHotStocksDataToCloud(useUiStore().currentDate, hotList).catch(function(err) {
        console.error('importHotFromPaste pushHotStocksDataToCloud 失败:', err);
    });
    // 阶段八修复：热门股票导入之前从未把题材同步进跨 tab 共享的 stock_topics 表，
    // 与早盘竞价的粘贴导入补齐同一逻辑，两个 tab 才能真正共享同一份题材库。
    // 规则：新旧题材合并去重，全部保留，不设数量上限（pushStockTopicsToCloud 内部已处理合并）。
    (function() {
        const scMap = state._scMapCache || {};
        hotList.forEach(function(item) {
            if (!item || !item.stock || !item.topics) return;
            const nameTrim = item.stock.trim();
            const topicsArr = item.topics.split(/[,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) { return t; });
            if (topicsArr.length === 0) return;
            const code = scMap[nameTrim] || item.code || '';
            pushStockTopicsToCloud(nameTrim, topicsArr, code).catch(function(e) {
                console.warn('pushStockTopicsToCloud 失败（importHotFromPaste）:', nameTrim, e);
            });
        });
    })();
    const pasteInput = _domGet('hotPasteInput');
    if (pasteInput) pasteInput.value = '';
    const statusEl = _domGet('hotImportStatus');
    let statusMsg = '✅ ';
    if (fullDataCount > 0) statusMsg += `新增${fullDataCount}条`;
    if (fullDataUpdateCount > 0) statusMsg += ` 更新${fullDataUpdateCount}条`;
    if (noteUpdateCount > 0) statusMsg += ` 更新注释${noteUpdateCount}条`;
    if (noteNewCount > 0) statusMsg += ` 新增注释${noteNewCount}条`;
    statusEl.textContent = statusMsg;
    statusEl.style.color = '#059669';
    // 刷新表单和前台（不调 renderList/recalcDuibanFromAuction/syncCloseChunk）
    setTimeout(() => renderHotForm(), 0);
    setTimeout(() => renderAuction('hot'), 20);
    const submitBtn = _domQuery('#hotForm .submit-btn');
    if (submitBtn) submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function replaceHotConceptFromPaste() {
    const textarea = _domGet('hotPasteInput');
    const rawText = textarea ? textarea.value : '';
    const pasteText = rawText.trim();
    if (!pasteText) {
        const status = _domGet('hotImportStatus');
        status.textContent = '请先粘贴数据！';
        status.style.color = '#dc2626';
        textarea && textarea.focus();
        return;
    }
    const lines = pasteText.split(/\r?\n/);
    const hotData = getHotAuctionData();
    const existingList = hotData[useUiStore().currentDate] || [];
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
            var parsed = parseNoteToFields(newNote);
            existingList[existingIndex].changePct = parsed.changePct;
            existingList[existingIndex].topics = parsed.topics;
            replaceCount++;
        } else {
            notFoundCount++;
            notFoundStocks.push(stock);
        }
    });
    if (replaceCount > 0) {
        getHotAuctionData()[useUiStore().currentDate] = existingList;
        invalidateTopicCache();
        syncHotStocksListForDate(useUiStore().currentDate).catch(function(err) {
            console.error('replaceHotConceptFromPaste syncHotStocksListForDate 失败:', err);
        });
        // syncHotStocksListForDate 只同步增删/选中状态，不会把刚替换的 note/changePct/topics 写到云端
        // （这正是之前"粘贴导入题材、保存后刷新就消失"的原因）——这里补上真正写入这些字段的调用
        pushHotStocksDataToCloud(useUiStore().currentDate, existingList).catch(function(err) {
            console.error('replaceHotConceptFromPaste pushHotStocksDataToCloud 失败:', err);
        });
        renderHotForm();
        renderAuction('hot');
    }
    const pasteInput = _domGet('hotPasteInput');
    if (pasteInput) pasteInput.value = '';
    const statusEl = _domGet('hotImportStatus');
    let statusMsg = '✅ 替换了 ' + replaceCount + ' 条概念';
    if (notFoundCount > 0) statusMsg += '，未找到: ' + notFoundStocks.slice(0, 3).join(', ') + (notFoundCount > 3 ? '...' : '');
    statusEl.textContent = statusMsg;
    statusEl.style.color = replaceCount > 0 ? '#059669' : '#dc2626';
    const submitBtn = _domQuery('#hotForm .submit-btn');
    if (submitBtn) submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export const HOT_WATCHLIST_FIELDS = ['note', 'topics', 'selected', 'bought', 'sold', 'fixed', 'code'];

export const HOT_METRICS_FIELDS = ['volume', 'yest_volume', 'change_pct', 'code'];

export const HOT_PATCHABLE_FIELDS = HOT_WATCHLIST_FIELDS.concat(HOT_METRICS_FIELDS.filter(function(f) { return HOT_WATCHLIST_FIELDS.indexOf(f) < 0; }));

