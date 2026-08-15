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
import { getNthPreviousTradingDay, recalcDuibanFromAuction, renderAuction, renderBidding, renderDuiban, renderEmotionBoard, renderEtf, renderHotForm, renderHotspot, renderJiwang, renderList, renderMulti, renderPattern, renderRank, resetExpansionStateOnDateSwitch, setApiStatus, showNumcatChoiceModal } from '../ui-bridge.js';
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

// ===== auction 域「同花顺(THS)相关簇」：物理拆分自 auction.js（§16），函数体逐字迁移 =====
export async function fetchLadderConstituentsMain(btn) {
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
