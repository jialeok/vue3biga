import { state } from '../app-state.js';
if (!state._stocksMemCache) state._stocksMemCache = {}; // §6.1：域缓存下沉，stocks 域拥有 _stocksMemCache
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
import { resolveCodesByNames } from '../../data/stock-code-resolver.js';
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
import { getNthPreviousTradingDay, recalcDuibanFromAuction, renderAuction, renderBidding, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, setApiStatus, showNumcatChoiceModal } from '../ui-bridge.js';
import { pullFromCloud, pushAuctionCodeToCloud, pushHotStocksDataToCloud, pushToCloud, syncAuctionListForDate, syncCloseChunk, syncHotStocksListForDate } from '../workflows/auction-sync.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { initAuctionTags } from '../../stores/auctionTagStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getGroupData, _getAuctionStore, saveModule, scheduleCloudPush, saveData } from '../shared/core-shared.js';
import { patchAuctionFieldBatch, getAuctionData, mergeAuctionDateRows, markAuctionDirty } from '../auction/auction.js';
import { patchHotFieldBatch } from '../hotspot/hotspot.js';

// [PERF-FIX 2026-09-13] 慢路径一次性索引（股票名 → 题材集合）。
// 背景：本函数被模板**逐行**调用（composables/auction-board-helpers.js#getTopicsDisplay →
// 第二页题材分组每行）。原实现在 _topicCache 未构建时，对每只股票各自全量扫描最近 66 天
// （5/6 实测：66 天 × ~632 行 ≈ 4.17 万行/次），N 行即 N × 4.17 万次 →
// 5/6 实测 71 行 ≈ 296 万次比较 + 正则，主线程被同步占满，翻页/题材 toggle 全部无响应。
// 而 importAuctionFromPaste 末尾只 invalidateTopicCache() 不重建，恰好留下 _topicCacheBuilt=false
// 的危险中间态 → 导入后首次进第二页必踩。
// 修复：把 O(N × M) 降为 O(M + N) —— 慢路径改为一次性构建 (股票 → 题材) 索引后查表。
// 语义与结果 100% 不变：同为最近 66 天窗口、不排除当天、同样取该股当日**首行**、同样括号解析与分隔符。
const TOPIC_CACHE_DAYS = 66;
let _slowTopicIndex = null;
let _slowTopicIndexFp = '';

function _buildSlowTopicIndex(auctionData) {
    const allDates = Object.keys(auctionData).sort();
    const recentDates = allDates.length > TOPIC_CACHE_DAYS
        ? allDates.slice(-TOPIC_CACHE_DAYS)
        : allDates;
    const index = Object.create(null);
    for (let i = 0; i < recentDates.length; i++) {
        const dayList = auctionData[recentDates[i]] || [];
        const seenInDay = new Set();     // 与原 find() 同语义：同一天同一只票只取首行
        for (let k = 0; k < dayList.length; k++) {
            const item = dayList[k];
            if (!item || !item.stock) continue;
            const name = item.stock.trim();
            if (seenInDay.has(name)) continue;
            if (!item.note) continue;
            // 快路径：纯涨幅 note（如 "+3.2%"）无括号，直接跳过，避免对每个单元格跑正则
            if (item.note.indexOf('(') < 0) continue;
            const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
            if (bracketMatches.length === 0) continue;
            seenInDay.add(name);
            let set = index[name];
            if (!set) { set = index[name] = new Set(); }
            for (let m = 0; m < bracketMatches.length; m++) {
                const topics = bracketMatches[m].replace(/[()]/g, '').split(/[,，、;；]/).map(t => t.trim()).filter(Boolean);
                for (let t = 0; t < topics.length; t++) set.add(topics[t]);
            }
        }
    }
    return index;
}

// 指纹：数据形态（日期数/最后日期/总行数）+ 题材缓存版本号。
// 版本号由 invalidateTopicCache() 自增，保证缓存失效后慢路径索引也一并重建，不会返回陈旧题材。
function _slowTopicIndexFingerprint(auctionData) {
    const ds = Object.keys(auctionData);
    let rows = 0;
    for (let i = 0; i < ds.length; i++) rows += ((auctionData[ds[i]] || []).length);
    ds.sort();
    return String(state._topicCacheVersion || 0) + '|' + ds.length + '|' + (ds[ds.length - 1] || '') + '|' + rows;
}

// §16 域拆分：stocks 域（原 app-core.js 迁出）
export function getStockHistoryTopics(stockName) {
    if (!stockName) return '';
    if (state._topicCacheBuilt && state._topicCache) {
        const topics = state._topicCache[stockName.trim()];
        if (!topics || topics.size === 0) return '';
        return '(' + Array.from(topics).join('，') + ')';
    }
    // 无缓存：一次性构建索引后查表（不再逐股票全量扫描，见上方 [PERF-FIX 2026-09-13]）
    const auctionData = getAuctionData();
    const fp = _slowTopicIndexFingerprint(auctionData);
    if (!_slowTopicIndex || _slowTopicIndexFp !== fp) {
        _slowTopicIndex = _buildSlowTopicIndex(auctionData);
        _slowTopicIndexFp = fp;
    }
    const hist = _slowTopicIndex[stockName.trim()];
    if (!hist || hist.size === 0) return '';
    return '(' + Array.from(hist).join('，') + ')';
}

export async function searchTickerCodeByName(name) {
    const target = name ? name.trim() : '';
    if (!target) return '';
    // [FIX 2026-09-09] 同花顺 /api/meta/tickers/search 只支持按【代码】反查：
    // q=600371 → 返回 name='万向德农'；q=万向德农 → item 恒为空。
    // 因此「按名称查代码」必须走宽基指数成分股反查（data/stock-code-resolver.js），
    // 旧的 search 实现从未成功过，后台「自动补全代码」按钮形同虚设。
    try {
        const resolved = await resolveCodesByNames([target]);
        if (resolved[target]) return resolved[target];
    } catch (e) {
        _dbgLog('[AUTO-CODE] 名称→代码解析 ' + target + ' 失败: ' + (e && e.message || e));
    }
    // 兜底：入参本身像代码时（用户粘贴了 600371 / 600371.SH），按代码反查确认
    try {
        const data = await fuyaoApiGet('/api/meta/tickers/search', {
            q: target.replace(/\.(SH|SZ|BJ)$/i, ''),
            asset_type: 'a-share',
            limit: 5
        });
        if (!data || !Array.isArray(data.item) || data.item.length === 0) return '';
        const match = data.item.find(function(it) {
            return it && it.name && it.name.trim() === target;
        });
        const item = match || data.item[0];
        if (item && item.ticker) return String(item.ticker).trim();
    } catch (e) {
        _dbgLog('[AUTO-CODE] 搜索 ' + target + ' 失败: ' + (e && e.message || e));
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
        // [FIX 2026-09-14 §16] 原为：
        //   if (ds === 'hot') { if (typeof renderHotStocks === 'function') renderHotStocks(); }
        //   else { if (typeof renderAuction === 'function') renderAuction(); }
        // renderHotStocks 是旧 window 全局渲染函数，已于 2026-08-15 的 hot 死代码清理中删除
        // （ui-bridge.js 亦无此导出），该分支求值恒 false = 一直是空操作。
        // 这里删除死守卫（不再保留"半旧半新"的隐藏状态），仅保留真实存在的窗口桥接渲染。
        if (ds !== 'hot') renderAuction();
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

// [FIX 2026-09-14] extractCodeFromFuyaoItem 已下沉到零依赖叶子模块 code-helpers.js
// （原因：auction-ths.js 需要它，而从 auction-ths.js 反向 import 本文件会形成环形依赖）。
// 这里保留同名再导出（barrel），外部 import 路径与身份零变化。
export { extractCodeFromFuyaoItem } from './code-helpers.js';

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
        
        // 概念替换可能改变了note的格式，保险起见重新统计一次"最近多板"/早盘ETF
        recalcDuibanFromAuction(targetDate);
    }

    let statusMsg = '✅ 替换了 ' + replaceCount + ' 条概念';
    if (notFoundCount > 0) {
        statusMsg += '，未找到: ' + notFoundStocks.slice(0, 3).join(', ') + (notFoundCount > 3 ? '...' : '');
    }
    return statusMsg;
}

