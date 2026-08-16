// auction-sync-pull.js — 云端拉取（从 auction-sync.js 物理拆分）
// 仅移动位置，不改实现。
import { getSupabase, getStocksData, loadAllData } from '../../data/supabase-client.js';
import { saveFumianTopics } from '../../data/fumian-sync.js';
import { saveEtfBoardComment } from '../../data/etf-board-data.js';
import { saveBiddingTemplate } from '../../data/bidding-template-sync.js';
import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { getGroupData, getAuctionData, saveModule, patchAuctionFieldBatch, reconcileAuctionWatchlistFromLocalStorage, mergeAuctionDateRows, getHotAuctionData, _openHotAuctionShield, _closeHotAuctionShield } from '../app-core-api.js';
import { _getAuctionWatchlistSet } from '../../data/watchlist-and-metrics.js';
import { cleanseAuctionTagsOnce } from '../tagTitles/rules.js';
import { state } from '../app-state.js';
import { pullAuctionFromTable } from '../../data/auction-data.js';
import { _signalCache } from '../auction/sort-rules.js';
import { pullBiddingFromTable, pushBiddingToCloud } from '../../data/bidding-data.js';
import { pullJiwangFromTable } from '../../data/jiwang-data.js';
import { recalcDuibanFromAuction } from '../ui-bridge.js';
import { _openAuctionShield, _closeAuctionShield } from '../../data/session-and-shield.js';
import { syncStockTopicsFromAuction } from '../auction/stock-sync.js';
import { useUiStore } from '../../stores/uiStore.js';
import { _cloudBlobExtras } from './auction-sync-helpers.js';

        // ============================================================
        // 云端数据拉取（解锁后执行一次）
        // ============================================================
        export async function pullFromCloud() {
            // §3/§4 收口（P0-3 修复）：原 _setSyncStatus 用 document.getElementById('syncStatus') 在 logic 层
            // 直接写 DOM，绕过 LoginOverlay.vue 的响应式 statusText，造成双写冲突。同步状态属信息展示，
            // 且 statusText 为组件私有 ref、无供逻辑层写入的共享通道，故删除 DOM 写，仅保留诊断日志。
            try {
                const sb = getSupabase();
                const { data, error } = await sb
                    .from('user_data')
                    .select('data')
                    .eq('id', 'owner')
                    .single();

                if (error) throw error;
                if (!data || !data.data || Object.keys(data.data).length === 0) {
                    _dbgLog('[PULL] 云端暂无数据，使用本地数据');
                    return;
                }

                const cloudObj = data.data;

                // §8 收口（P0-1 修复）：原 cloud-pull 把云端 blob 各模块镜像写回 stockApp_v42_* localStorage，
                // 违反 §8「核心业务数据不得落 localStorage」。现各模块已迁移到「云端专用表 + 内存缓存(_xxxMemCache)」，
                // loadAllData 优先读内存缓存、不再从这些 localStorage key 读（src/data/supabase-client.js:199-214），
                // 故下方不再镜像 stocks/auction/bidding/rank/multi/hotspot/pattern/tagTitles/jiwang（云端已是唯一真相源）。
                // 仅 holidays / tradingDays 无对应内存缓存、仍由 loadAllData 从 localStorage 兜底读取（见 supabase-client.js:205），
                // 予以保留写入（非 §8 违规，无合适云端表，且被读回作为数据源）。
                const moduleKeys = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];
                const DV = 'v42';
                const _localStorageFallbackKeys = ['holidays', 'tradingDays'];
                moduleKeys.forEach(key => {
                    if (_localStorageFallbackKeys.indexOf(key) !== -1 && cloudObj[key] !== undefined) {
                        localStorage.setItem('stockApp_' + DV + '_' + key, JSON.stringify(cloudObj[key]));
                    }
                });
                localStorage.setItem('stockApp_' + DV + '__migrated', '1');

                // 其余散落 key
                // §8 收口：stockEtfComment 已并入 Supabase early_etf_data.comment 列（saveEtfBoardComment）；
                // biddingDefaultTemplate_v41 已双写 Supabase（saveBiddingTemplate）；coreTopics 另有云端路径 topic-rules.js（getCoreTopics）。
                // duibanData 不再双写 auction_duiban 表：该表为迁移遗留孤儿表（loadDuibanData 全代码 0 调用方，
                // DuibanBoard 实际读 recent_multi_data），收敛为只经 user_data blob(_cloudBlobExtras) 暂存，不再写孤儿表。
                // 上述字段以及 duibanComment/copiedStocksData/summaries 的「pull→push 暂存」已从 localStorage 改为模块内存 _cloudBlobExtras（见顶部声明），
                // 不再把业务数据写进 localStorage；云端双写保留作为 fail-soft 冗余真相源，绝不丢数据。
                const extraKeys = ['duibanData', 'duibanComment', 'stockEtfComment',
                                   'coreTopics', 'biddingDefaultTemplate_v41', 'copiedStocksData'];
                extraKeys.forEach(key => {
                    if (cloudObj[key] !== undefined) {
                        // §8 合规：暂存改为模块内存 _cloudBlobExtras（见顶部声明），不再写 localStorage
                        _cloudBlobExtras[key] = cloudObj[key];
                        // §8 双写：新增云端 Supabase（fire-and-forget，内部 try/catch 已 fail-soft）
                        try {
                            if (key === 'stockEtfComment') {
                                const cmts = cloudObj[key];
                                if (cmts && typeof cmts === 'object') {
                                    Object.keys(cmts).forEach(d => saveEtfBoardComment(d, cmts[d]));
                                }
                            }
                            else if (key === 'biddingDefaultTemplate_v41') saveBiddingTemplate(cloudObj[key]);
                        } catch (e) { console.error('[auction-sync] §8 双写异常(' + key + ')：', e && e.message); }
                    }
                });
                // summaries（带前缀的动态 key）：暂存改为内存 _cloudBlobExtras（§8 合规，不再逐 key 写 localStorage）
                if (cloudObj.summaries) {
                    _cloudBlobExtras.summaries = cloudObj.summaries;
                }
                // §8 已上云（写路径仅上云，已移除 localStorage 写入；读路径已切云端 loadFumianTopics → getFumianCache，localStorage 仅作冷启动兜底）。
                if (cloudObj.hasFumianTopics) {
                    // 双写：新增 Supabase upsert（失败自动降级，绝不破坏既有路径）；localStorage 写入已移除（用户已授权上云）
                    try {
                        await saveFumianTopics(cloudObj.hasFumianTopics);
                    } catch (e) {
                        console.error('[auction-sync] hasFumian 上云异常：', e && e.message);
                    }
                }
                if (cloudObj.scoreSettings) {
                    ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                        if (cloudObj.scoreSettings[type] !== undefined) {
                            localStorage.setItem('scoreSettings_' + type, JSON.stringify(cloudObj.scoreSettings[type]));
                        }
                    });
                }
                if (cloudObj.exportDate) {
                    const localDate = localStorage.getItem('lastEditedDate_v42');
                    // 云端日期必须不早于"去年今日"（粗略但可靠地过滤陈旧值，如早期测试留下的
                    // 2025-01-02），且比本地新，才允许覆盖本地
                    const _thisYear = new Date().getFullYear();
                    const _minValidDate = (_thisYear - 1) + '-01-01';
                    if (cloudObj.exportDate >= _minValidDate && (!localDate || cloudObj.exportDate > localDate)) {
                        localStorage.setItem('lastEditedDate_v42', cloudObj.exportDate);
                    }
                }

                // 重置内存中的 allData，让 loadAllData() 重新从 localStorage 读取
                // §6：rank 缓存经 state._rankMemCache 单独持有（与 allData 解耦），此 null 重置不连坐 rank；安全。
                state.allData = null;

                // 从 auction_watchlist + market_metrics 拉取 auction 数据（拆表后新增）
                // 若新表不可用或为空，保留本地数据（不清空）
                try {
                    const tableAuction = await pullAuctionFromTable();
                    // 阶段四 Bug 6 收尾修复：auction 已改为纯内存缓存（_auctionMemCache）+ 云端表，
                    // 不再落 localStorage（Bug 4），也不需要 allData = null 重置——
                    // pullAuctionFromTable 内部已原地清空+灌入 _auctionMemCache，
                    // 而 allData.auction 即 _auctionMemCache（Bug 1+2），引用自动同步。
                    if (Object.keys(tableAuction).length > 0) {
                        // 数据已灌入 _auctionMemCache，无需额外动作
                    }
                    // 新表为空时：保留本地数据，不清空（可能是迁移未完成或表刚创建）
                    // 更新状态签名，避免 pull 后立即触发无意义的 push
                    // 方案2：状态签名只统计正式成员（用 _auctionWatchlistIndex 判断）
                    const _pullWset = _getAuctionWatchlistSet(useUiStore().currentDate);
                    const todayList = (state._auctionMemCache[useUiStore().currentDate] || []).filter(function(s) { return s && s.stock && _pullWset.has(s.stock.trim()); });
                    state._lastPushedAuctionStatus = JSON.stringify(todayList.map(function(s) {
                        return { s: s.stock, sel: s.selected || false, b: s.bought || false,
                                 so: s.sold || false, f: s.fixed || false };
                    }));
                } catch(tableErr) {
                    _dbgLog('[AUCTION-ERR] pullAuctionFromTable ' + (tableErr && tableErr.message));
                }

                // pullAuctionFromTable 加载了所有日期的全量快照到 _auctionMemCache，
                // 首次渲染时 T-1 数据可能未就绪导致竞昨高光算成 0 并被指纹缓存锁住。
                // 指纹 _signalFpFor 只覆盖 watchlist 数据，不覆盖 _auctionMemCache 全量快照，
                // 所以全量快照就绪后指纹不变 → 缓存命中 → 返回旧的 0。
                // 修复：清空 _signalCache，强制重渲染时用完整全量快照重算。
                Object.keys(_signalCache).forEach(function(k) { delete _signalCache[k]; });
                _emit('auction-refresh');

                // 阶段六 影子bug6 收尾：拉取完成后立即对账，用 localStorage 旧正式列表纠正云端已提升的影子记录
                try {
                    const reconcileResult = await reconcileAuctionWatchlistFromLocalStorage();
                    if (!reconcileResult.skipped && reconcileResult.demoted > 0) {
                        _dbgLog('[RECONCILE] 首次对账降级 ' + reconcileResult.demoted + ' 只影子记录，触发重新渲染');
                        // 对账改了 _auctionMemCache 行的 in_watchlist，需重新渲染当前页
                        _emit('auction-refresh');
                    }
                } catch(e) {
                    _dbgLog('[AUCTION-ERR] reconcileAuctionWatchlistFromLocalStorage ' + (e && e.message || e));
                }

                // 一次性标签清洗（stockApp_v42_tag_cleanse_v1）：云端拉取完成后执行，
                // 按 deriveAuctionTagState 重算所有日期竞价行的 bought/sold/selected/fixed，
                // 清除历史遗留脏位（误标"买"、幽灵灰色"卖出"），并推送云端覆盖脏行。
                // 只跑一次；清洗前自动备份到 auctionData_tag_cleanse_backup。
                try {
                    await cleanseAuctionTagsOnce();
                    _emit('auction-refresh');
                } catch(e) {
                    _dbgLog('[AUCTION-ERR] cleanseAuctionTagsOnce ' + (e && e.message || e));
                }

                // 从 bidding_data 独立表拉取 bidding 数据（云端表是权威来源之一，
                // 但不能因为某次拉取没返回某个日期就把本地已保存的数据删掉）。
                try {
                    const tableBidding = await pullBiddingFromTable();
                    // 收集"正在推送到云端"或"有本地待推送编辑"的日期，这些日期不能被云端旧值覆盖。
                    const pendingDates = new Set();
                    if (state._biddingPushInFlight) state._biddingPushInFlight.forEach(function(d) { pendingDates.add(d); });
                    if (state._biddingDirtyDates) state._biddingDirtyDates.forEach(function(d) { pendingDates.add(d); });
                    if (state._justPushedBidding) pendingDates.add(useUiStore().currentDate);
                    const _beforeKeys = Object.keys(state._biddingMemCache || {}).join(',');
                    if (!state._biddingMemCache) state._biddingMemCache = {};
                    // [BUG-FIX] 改为只覆盖云端实际返回的日期；云端没返回的日期保留本地原值。
                    // 否则一次分页/网络抖动导致某天没返回，就会把本地该天数据清空——
                    // 这正是"保存后刷新数据消失"的根因之一。
                    Object.keys(tableBidding).forEach(function(d) {
                        if (!pendingDates.has(d)) state._biddingMemCache[d] = tableBidding[d];
                    });
                    if (state.allData) state.allData.bidding = state._biddingMemCache;
                    _dbgLog('[BIDDING-STARTUP] 云端表共 ' + Object.keys(tableBidding).length +
                        ' 天，合并前本地=' + _beforeKeys +
                        '，合并后=' + Object.keys(state._biddingMemCache).join(',') +
                        '，跳过推送中=' + Array.from(pendingDates).join(','));
                } catch(tableErr) {
                    console.warn('bidding_data 表拉取失败，回退到内存缓存:', tableErr.message);
                }

                // 从 jiwang_data 独立表拉取记忘看板数据（云端表是唯一权威来源）
                try {
                    const _beforeMerge = JSON.stringify((state._jiwangMemCache || {})[useUiStore().currentDate] || null).slice(0, 200);
                    const tableJiwang = await pullJiwangFromTable();
                    if (!state._jiwangMemCache) state._jiwangMemCache = {};
                    // 重要修复：以前这里会把"这次没在 pendingDates 里的本地日期"全部删掉，
                    // 再用 tableJiwang 里有的日期重新填回来。问题是——如果某个日期的数据
                    // 已经真正保存成功（三个 pending 标记都已清空），但这次 pullJiwangFromTable()
                    // 由于任何原因（网络抖动、分页边界、云端读取瞬时延迟等）没有把该日期的行
                    // 带回来，这段代码会把本地这条已保存的数据直接删掉——即"明明保存成功，
                    // 一下拉刷新就变空白"。
                    // 现在改为：只用 tableJiwang 里实际返回的日期去覆盖/更新本地缓存，
                    // 云端这次没返回的日期一律保留本地原值，不做任何删除。
                    const pendingDates = new Set();
                    if (state._jiwangDirtyDates) state._jiwangDirtyDates.forEach(function(d) { pendingDates.add(d); });
                    if (state._jiwangPushTimers) Object.keys(state._jiwangPushTimers).forEach(function(d) { pendingDates.add(d); });
                    if (state._justPushedJiwang) pendingDates.add(useUiStore().currentDate);
                    Object.keys(tableJiwang).forEach(function(d) {
                        if (!pendingDates.has(d)) state._jiwangMemCache[d] = tableJiwang[d];
                    });
                    if (state.allData) state.allData.jiwang = state._jiwangMemCache;
                    // 记忘看板是快照式渲染（display 为一次性 ref，非 reactive），必须显式通知刷新，
                    // 否则初始云端拉取虽已灌入 _jiwangMemCache，前台却一直空白直到用户手动保存。
                    _emit('jiwang-refresh');
                    const _afterMerge = JSON.stringify(state._jiwangMemCache[useUiStore().currentDate] || null).slice(0, 200);
                    _dbgLog('pullFromCloud: jiwang 合并完成, useUiStore().currentDate=' + useUiStore().currentDate +
                        ', 云端表共 ' + Object.keys(tableJiwang).length + ' 天, 云端是否含当前日期=' + tableJiwang.hasOwnProperty(useUiStore().currentDate) +
                        ', 合并前=' + _beforeMerge + ', 合并后=' + _afterMerge);
                    if (pendingDates.size > 0) {
                        _dbgLog('pullFromCloud: 跳过覆盖有本地待推送编辑的记忘看板日期: ' + Array.from(pendingDates).join(','));
                    }
                } catch(tableErr) {
                    console.warn('jiwang_data 表拉取失败，回退到内存缓存:', tableErr.message);
                    _dbgLog('pullFromCloud: jiwang_data 表拉取失败: ' + (tableErr && tableErr.message));
                }


                // 观察组可能受云端数据影响（上一交易日"竞/昨"达标股票可能变化），清除标记重新计算
                // 买入继承同理：昨日 bought/sold 状态可能被另一台设备改过，一并清除重算
                try { localStorage.removeItem('obsEnsured_' + useUiStore().currentDate); } catch(e) {}
                try { localStorage.removeItem('boughtEnsured_' + useUiStore().currentDate); } catch(e) {}
                try { localStorage.removeItem('obsBought_' + useUiStore().currentDate); } catch(e) {}

                _dbgLog('[PULL] 云端数据同步成功');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] pullFromCloud ' + (e && e.message || e));
            }
        }
