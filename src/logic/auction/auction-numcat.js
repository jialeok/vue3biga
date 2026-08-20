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

import { repairAuctionInWatchlistForDate, reconcileAuctionWatchlistFromLocalStorage, reconcileAuctionWatchlist, _sanitizeAuctionPatch, _splitAuctionPatch, _mergeAuctionPatchLocal, patchAuctionField, patchAuctionFieldBatch, markAuctionDirty, clearAuctionDateData, deleteAuctionDateData, mergeAuctionDateRows, clearAllAuctionDates, backupAuctionData, rollbackAuctionData, getAuctionData, getTodayAuction, getTodayGroupList, importAuctionFromPaste, importAuctionHistoryFill, parseVolumeOnlyText, splitHistoryFillLine, AUCTION_WATCHLIST_FIELDS, AUCTION_METRICS_FIELDS, AUCTION_PATCHABLE_FIELDS, _auctionFirstClearDumped } from './auction-helpers.js';

// ===== auction 域「猫抓/编号分类(numcat)相关簇」：物理拆分自 auction.js（§16），函数体逐字迁移 =====
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
        const fields = 'symbol,name,tradedate,auc_vol,auc_to_pre_vol_pct,auc_pct_chg';
        const result = await numcatApiPost('daily_auc', fields, params);
        const fieldList = result.fields || [];
        const items = result.items || [];
        const symbolIdx = fieldList.indexOf('symbol');
        const tradedateIdx = fieldList.indexOf('tradedate');
        const aucVolIdx = fieldList.indexOf('auc_vol');
        const ratioIdx = fieldList.indexOf('auc_to_pre_vol_pct');
        const aucPctIdx = fieldList.indexOf('auc_pct_chg');
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
            // [FIX 2026-08-20] 解析竞价涨幅 auc_pct_chg（专用字段，供「五日竞价涨幅」趋势图与排序使用）
            if (aucPctIdx >= 0) {
                const rawPct = row[aucPctIdx];
                if (rawPct !== null && rawPct !== undefined && rawPct !== '') {
                    const n = Number(rawPct);
                    if (!isNaN(n)) entry.pct = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
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
        let filledVolCount = 0, filledYestVolCount = 0, filledPctCount = 0, filledAucPctCount = 0, skippedCount = 0;
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
                // [FIX 2026-08-20] 竞价涨幅专用字段 auc_pct_chg：来自 daily_auc 接口，
                // 供「五日竞价涨幅」趋势图与排序使用（view-helpers/useSortToggles 优先读此字段）。
                // 只补空值，不覆盖已有值（与原 change_pct 补全策略一致）。
                if (entry.pct && !((s.aucPctChg || '').trim())) {
                    s.aucPctChg = entry.pct;
                    patch.auc_pct_chg = s.aucPctChg;
                    filledAucPctCount++;
                    changed = true;
                }
                // 收盘涨幅 change_pct：来自 daily 接口，向后兼容保留（部分老逻辑仍读 changePct/change_pct）
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
        const resultText = '✅ 连抓' + dates.length + '天完成：竞价量+' + filledVolCount + ' / 昨成交量(反推)+' + filledYestVolCount + ' / 竞价涨幅+' + filledAucPctCount + ' / 收盘涨幅+' + filledPctCount +
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
        let filledAucPctCount = 0;
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
                let aucPctWritten = false;
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
                        // [FIX 2026-08-20] 竞价涨幅专用字段 auc_pct_chg：供「五日竞价涨幅」趋势图与排序使用
                        // （view-helpers/useSortToggles 优先读此字段，避免被「获取涨幅」改写为常规涨幅而误判）
                        const needAucPct = overwrite || !((s.aucPctChg || '').trim());
                        if (needAucPct) {
                            s.aucPctChg = dayEntry.pct;
                            aucPctWritten = true;
                        }
                        // change_pct：向后兼容保留（部分老逻辑仍读 changePct/change_pct；今天会被 fuyao 快照覆盖为常规涨幅）
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
                if (volWritten || pctWritten || aucPctWritten) {
                    const patch = { stock: s.stock };
                    if (volWritten) patch.volume = s.volume;
                    if (aucPctWritten) patch.auc_pct_chg = s.aucPctChg;
                    if (pctWritten) {
                        patch.change_pct = s.changePct;
                        patch.note = s.note;
                    }
                    patchesArr.push(patch);
                    if (volWritten) filledVolumeCount++;
                    if (aucPctWritten) filledAucPctCount++;
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
                        aucPctWrittenThisTime: aucPctWritten,
                        changePctAfter: s.changePct || '',
                        aucPctChgAfter: s.aucPctChg || '',
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
            resultText = '✅ 连抓三天完成：竞价量+' + filledVolumeCount + ' / 竞价涨幅+' + filledAucPctCount + ' / 涨幅+' + filledPctCount +
                '（今日' + todayPatches.length + ' / 昨日' + yesterdayPatches.length + ' / 前日' + dayBeforePatches.length + ' 只），跳过 ' + skippedCount + ' 只无数据';
            if (dayBeforeListWasEmpty) resultText += '（前日列表已用今日列表作为基础，新股票落影子记录）';
        } else {
            const mode = (needToday && needYesterday) ? '昨日+今日' : (needToday ? '今日' : '昨日');
            const action = (opts.overwriteToday || opts.overwriteYesterday) ? '覆盖' : '补全';
            const yesterdayNote = (needYesterday && yesterdayListWasEmpty)
                ? '（对比日列表已用今日列表 ' + todayList.length + ' 只作为基础）'
                : '';
            resultText = '✅ ' + mode + action + '：竞价量 ' + filledVolumeCount + ' / 竞价涨幅 ' + filledAucPctCount + ' / 涨幅 ' + filledPctCount + '，跳过 ' + skippedCount + ' 只无数据' + yesterdayNote;
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
