// auction-sync.js — 云端拉取/推送调度（从 app-core.js 抽离）
// 逻辑层 workflow：编排 data/ 层的 supabase 读写 + 本地缓存同步

        // 批量更新某日期所有股票的状态列（主程序拥有：selected/obs_auto_added）
        // 不触碰行情列（volume/yest_volume/note/code），避免覆盖抓取程序的数据
        // 方案 B：bought/sold/fixed 三列不再由本函数覆盖——标签唯一权威源是 stocksData
        // （股票列表页手动标签），行上残留的旧标签位已是废弃字段，覆写云端只会让
        // 陈旧值继续沉淀（"幽灵标签"）。云端这三列保持最后一次旧值自然退役。
        // 拆表后：只写 auction_watchlist，该表没有 in_watchlist 列（每行天然是正式成员）。
import { getSupabase, getStocksData, loadAllData } from '../../data/supabase-client.js';
import { saveFumianTopics } from '../../data/fumian-sync.js';
import { saveDuibanData } from '../../data/duiban-sync.js';
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
import { updateCloudSyncUI, recalcDuibanFromAuction } from '../ui-bridge.js';
import { _openAuctionShield, _closeAuctionShield } from '../../data/session-and-shield.js';
import { syncStockTopicsFromAuction } from '../auction/stock-sync.js';
import { useUiStore } from '../../stores/uiStore.js';

        export async function pushAuctionStatusForDate(date) {
            const sb = getSupabase();
            // 方案2：用 _auctionWatchlistIndex 判断正式成员，只推送正式成员的状态
            const watchlistSet = _getAuctionWatchlistSet(date);
            const auctionList = (getAuctionData()[date] || []).filter(function(s) { return s && s.stock && watchlistSet.has(s.stock.trim()); });
            if (auctionList.length === 0) return;
            const now = new Date().toISOString();
            // 分批并行更新（每批 25 个），避免过多并发请求
            const batchSize = 25;
            for (let i = 0; i < auctionList.length; i += batchSize) {
                const batch = auctionList.slice(i, i + batchSize);
                await Promise.all(batch.map(function(item) {
                    return sb.from('auction_watchlist')
                        .update({
                            selected: item.selected || false,
                            obs_auto_added: !!item.obsAutoAdded, // 之前漏更新，云端该列一直是插入时的旧值
                            updated_at: now,
                            updated_by: 'main'
                        })
                        .eq('date', date)
                        .eq('stock', item.stock.trim());
                }));
            }
        }

        // 脏日期全量同步（增删股票后调用）：同步 auction_watchlist 与本地正式列表一致。
        // 拆表后变化：
        //   - 只操作 auction_watchlist；market_metrics 影子记录不在这里删。
        //   - 云端有但本地无的股票：从 auction_watchlist 物理删除（不再置 in_watchlist=false）。
        //   - auction_watchlist 没有 in_watchlist 列，所有行天然是正式成员。
        // 方案2：用 _auctionWatchlistIndex 判断正式成员（localList 只含正式成员），
        //   同步完成后用 localStocks 覆盖该日期的索引，保持索引与云端一致。
        export async function syncAuctionListForDate(date) {
            const sb = getSupabase();
            // 方案2：用 _auctionWatchlistIndex 过滤正式成员
            const watchlistSet = _getAuctionWatchlistSet(date);
            const localList = (getAuctionData()[date] || []).filter(function(s) { return s && s.stock && watchlistSet.has(s.stock.trim()); });
            const localStocks = new Set(localList.map(function(s) { return s.stock.trim(); }));

            // 读取云端 auction_watchlist 该日期已有股票
            const { data: cloudRows, error: readErr } = await sb.from('auction_watchlist')
                .select('stock').eq('date', date);
            if (readErr) throw readErr;
            const cloudStocks = new Set((cloudRows || []).map(function(r) { return (r.stock || '').trim(); }));

            const now = new Date().toISOString();
            const scMap = state._scMapCache || {};

            // 1. 云端有但本地无的股票：从 auction_watchlist 物理删除
            const toRemove = [];
            cloudStocks.forEach(function(s) { if (!localStocks.has(s)) toRemove.push(s); });

            // === 安全护栏（2026-07-25 新增）===
            // 历史根因：本函数用"调用这一刻 _auctionMemCache[date] 里有什么"作为"用户真实
            // 删除了什么"的判断依据。如果调用发生在本地内存缓存尚未加载完整/尚未就绪的时刻，
            // localList 会被误判为"很小"或"空"，导致云端该日期几乎全部正式记录被当成"本地已删除"
            // 而物理删除——这是持久化写入，不会因为刷新/切页自动恢复。
            // 护栏逻辑：只要本次拟移除的数量占云端已有总数的比例过高（>60%）且云端本来不是空的，
            // 视为"本地快照可疑地不完整"，只记录诊断日志、跳过这次移除和推送，不做任何破坏性改动。
            const _cloudTotal = cloudStocks.size;
            const _removeRatio = _cloudTotal > 0 ? (toRemove.length / _cloudTotal) : 0;
            const _suspiciousWipe = _cloudTotal > 0 && _removeRatio > 0.6;
            if (_suspiciousWipe) {
                _dbgLog('[SYNC-GUARD] ⛔ window.syncAuctionListForDate date=' + date +
                    ' 疑似本地快照不完整，已跳过本次批量删除！云端共' + _cloudTotal +
                    '只，本地仅' + localStocks.size + '只，拟移除' + toRemove.length +
                    '只（比例' + Math.round(_removeRatio * 100) + '%）。' +
                    '本地样本：' + ([...localStocks].slice(0, 5).join('、') || '(空)') +
                    '。若该日期确实需要清空，请手动操作确认；本次不做任何改动。');
                return;
            }
            if (toRemove.length > 0) {
                _dbgLog('[SYNC-GUARD] window.syncAuctionListForDate date=' + date + ' 正常删除 ' +
                    toRemove.length + ' 只（云端' + _cloudTotal + '只 → 本地' + localStocks.size +
                    '只）：' + toRemove.join('、'));
                const { error: rmErr } = await sb.from('auction_watchlist')
                    .delete()
                    .eq('date', date)
                    .in('stock', toRemove);
                if (rmErr) throw rmErr;
            }

            // 2. 插入本地新增的股票（云端无的）
            const newStocks = localList.filter(function(s) { return !cloudStocks.has(s.stock.trim()); });
            if (newStocks.length > 0) {
                const newRows = newStocks.map(function(s) {
                    return {
                        date: date, stock: s.stock.trim(),
                        code: scMap[s.stock.trim()] || s.code || '',
                        volume: s.volume || '', yest_volume: s.yestVolume || '', note: s.note || '',
                        change_pct: s.changePct || '', topics: s.topics || '',
                        source: s.source || 'manual',
                        selected: s.selected || false, bought: s.bought || false,
                        sold: s.sold || false, fixed: s.fixed || false,
                        obs_auto_added: !!s.obsAutoAdded,
                        updated_at: now, updated_by: 'main'
                    };
                });
                const { error: insErr } = await sb.from('auction_watchlist')
                    .upsert(newRows, { onConflict: 'date,stock', ignoreDuplicates: true });
                if (insErr) throw insErr;
            }

            // 3. 更新现有股票（用单次 upsert 替代逐条 update，避免 N 次网络往返/部分成功）
            const existingStocks = localList.filter(function(s) { return cloudStocks.has(s.stock.trim()); });
            if (existingStocks.length > 0) {
                const statusRows = existingStocks.map(function(s) {
                    return {
                        date: date, stock: s.stock.trim(),
                        code: scMap[s.stock.trim()] || s.code || '',
                        volume: s.volume || '', yest_volume: s.yestVolume || '', note: s.note || '',
                        change_pct: s.changePct || '', topics: s.topics || '',
                        source: s.source || 'manual',
                        selected: s.selected || false, bought: s.bought || false,
                        sold: s.sold || false, fixed: s.fixed || false,
                        obs_auto_added: !!s.obsAutoAdded,
                        updated_at: now, updated_by: 'main'
                    };
                });
                const { error: updErr } = await sb.from('auction_watchlist')
                    .upsert(statusRows, { onConflict: 'date,stock' });
                if (updErr) throw updErr;
            }

            _dbgLog('[SYNC-GUARD] window.syncAuctionListForDate date=' + date + ' 完成：云端' + _cloudTotal +
                '只 → 本地' + localStocks.size + '只（删除' + toRemove.length + ' / 新增' + newStocks.length +
                ' / 更新状态' + existingStocks.length + '）');
            // 方案2：同步完成后更新本地正式成员索引（与云端 auction_watchlist 一致）
            state._auctionWatchlistIndex[date] = new Set(localStocks);
        }

        // 热门股票脏日期全量同步（改表名 hot_stocks、数据源 getGroupData('hot')）
        // 拆表后：hot_stocks 没有 in_watchlist 列，每行天然是正式成员；
        // 云端有但本地无的股票直接物理删除，不再置 in_watchlist=false。
        export async function syncHotStocksListForDate(date) {
            _openHotAuctionShield(); // 计数器式屏蔽窗口：与 window.patchHotFieldBatch 并发时互不干扰
            try {
            const sb = getSupabase();
            const localList = (getGroupData('hot')[date] || []).filter(function(s) { return s && s.stock; });
            const localStocks = new Set(localList.map(function(s) { return s.stock.trim(); }));

            const { data: cloudRows, error: readErr } = await sb.from('hot_stocks')
                .select('stock').eq('date', date);
            if (readErr) throw readErr;
            const cloudStocks = new Set((cloudRows || []).map(function(r) { return (r.stock || '').trim(); }));

            const now = new Date().toISOString();
            const scMap = state._scMapCache || {};

            // 1. 云端有但本地无的股票：从 hot_stocks 物理删除
            const toRemove = [];
            cloudStocks.forEach(function(s) { if (!localStocks.has(s)) toRemove.push(s); });

            // === 安全护栏（与 syncAuctionListForDate 同一护栏、同一根因）===
            const _cloudTotalHot = cloudStocks.size;
            const _removeRatioHot = _cloudTotalHot > 0 ? (toRemove.length / _cloudTotalHot) : 0;
            const _suspiciousWipeHot = _cloudTotalHot > 0 && _removeRatioHot > 0.6;
            if (_suspiciousWipeHot) {
                _dbgLog('[SYNC-GUARD] ⛔ window.syncHotStocksListForDate date=' + date +
                    ' 疑似本地快照不完整，已跳过本次批量删除！云端共' + _cloudTotalHot +
                    '只，本地仅' + localStocks.size + '只，拟移除' + toRemove.length +
                    '只（比例' + Math.round(_removeRatioHot * 100) + '%）。' +
                    '本地样本：' + ([...localStocks].slice(0, 5).join('、') || '(空)') +
                    '。若该日期确实需要清空，请手动操作确认；本次不做任何改动。');
            } else {
            if (toRemove.length > 0) {
                _dbgLog('[SYNC-GUARD] window.syncHotStocksListForDate date=' + date + ' 正常删除 ' +
                    toRemove.length + ' 只（云端' + _cloudTotalHot + '只 → 本地' + localStocks.size +
                    '只）：' + toRemove.join('、'));
                const { error: rmErr } = await sb.from('hot_stocks')
                    .delete()
                    .eq('date', date)
                    .in('stock', toRemove);
                if (rmErr) throw rmErr;
            }
            }

            // 2. 插入本地新增的股票（云端无的）
            const newStocks = localList.filter(function(s) { return !cloudStocks.has(s.stock.trim()); });
            if (newStocks.length > 0) {
                const newRows = newStocks.map(function(s) {
                    return {
                        date: date, stock: s.stock.trim(),
                        code: (s.code || '').trim() || scMap[s.stock.trim()] || '',
                        volume: s.volume || '', yest_volume: s.yestVolume || '', note: s.note || '',
                        change_pct: s.changePct || '', topics: s.topics || '',
                        selected: s.selected || false, bought: s.bought || false,
                        sold: s.sold || false, fixed: s.fixed || false,
                        obs_auto_added: !!s.obsAutoAdded,
                        updated_at: now, updated_by: 'main'
                    };
                });
                const { error: insErr } = await sb.from('hot_stocks')
                    .upsert(newRows, { onConflict: 'date,stock', ignoreDuplicates: true });
                if (insErr) throw insErr;
            }

            // 3. 更新现有股票（用单次 upsert 替代逐条 update）
            const existingStocks = localList.filter(function(s) { return cloudStocks.has(s.stock.trim()); });
            if (existingStocks.length > 0) {
                const statusRows = existingStocks.map(function(s) {
                    return {
                        date: date, stock: s.stock.trim(),
                        code: (s.code || '').trim() || scMap[s.stock.trim()] || '',
                        volume: s.volume || '', yest_volume: s.yestVolume || '', note: s.note || '',
                        change_pct: s.changePct || '', topics: s.topics || '',
                        selected: s.selected || false, bought: s.bought || false,
                        sold: s.sold || false, fixed: s.fixed || false,
                        obs_auto_added: !!s.obsAutoAdded,
                        updated_at: now, updated_by: 'main'
                    };
                });
                const { error: updErr } = await sb.from('hot_stocks')
                    .upsert(statusRows, { onConflict: 'date,stock' });
                if (updErr) throw updErr;
            }

            // 方案2：同步完成后更新本地正式成员索引
            state._hotWatchlistIndex[date] = new Set(localStocks);
            } finally {
                // 写入真正全部完成后，再留 2 秒缓冲吸收 Realtime 回显，而不是在写入尚未结束时就提前放开
                _closeHotAuctionShield(2000);
            }
        }

        // 热门股票接口按钮专用：全量 upsert 行情数据（volume/yest_volume/change_pct/topics/note 等）
        // 拆表后：
        //   - 正式列表成员 → hot_stocks
        //   - 非正式成员（影子记录）→ market_metrics(scope='hot')
        // 用途：补全成交量/竞价量/涨幅/题材/监管等按钮把字段写入云端
        // 注意：syncHotStocksListForDate 只同步状态/增删，不更新已有股票的 volume 等字段，故需要本函数
        export async function pushHotStocksDataToCloud(date, items, watchlistSnapshot) {
            // 原逻辑：表未就绪（loadHotStocksFromCloud 尚未跑完）时直接静默 return，
            // 会导致"登录/刷新后立刻点击同花顺接口按钮"时数据被无声丢弃、云端完全没写入。
            // 改为：最多等待 5 秒（loadHotStocksFromCloud 正常几百毫秒~1秒内完成），
            // 超时仍未就绪才放弃，并在控制台留痕方便排查。
            if (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable) {
                const waitStart = Date.now();
                while (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable && Date.now() - waitStart < 5000) {
                    await new Promise(function(r) { setTimeout(r, 100); });
                }
                if (!state._hotAuctionTableAvailable && !state._marketMetricsTableAvailable) {
                    console.warn('window.pushHotStocksDataToCloud 放弃：hot_stocks 与 market_metrics 表 5 秒内均未就绪，数据未写入云端。日期:', date);
                    return;
                }
            }
            _openHotAuctionShield();
            try {
            const sb = getSupabase();
            const scMap = state._scMapCache || {};
            const now = new Date().toISOString();
            // 判断依据：该股票是否已经是"当前 hotAuctionData[date] 正式列表"的成员。
            // 正式列表成员 → hot_stocks；不在正式列表里的股票 → market_metrics(scope='hot')。
            const existingWatchlistNames = {};
            const _watchlistSourceList = watchlistSnapshot !== undefined ? watchlistSnapshot : (getHotAuctionData()[date] || []);
            (_watchlistSourceList || []).forEach(function(s) {
                if (s && s.stock) existingWatchlistNames[s.stock.trim()] = true;
            });
            const watchlistRows = [];
            const metricsRows = [];
            const localOps = [];
            items.filter(function(s) { return s && s.stock; }).forEach(function(item) {
                const nameTrim = item.stock.trim();
                // [BUG-FIX] 防止本地/映射都没有 code 时，用 '' 覆盖云端已有的 code。
                let code = (scMap[nameTrim] || '').trim() || (item.code || '').trim();
                if (!code) {
                    const cached = (state._hotFullRowCache[date] || []).find(function(r) { return r && r.stock === nameTrim; });
                    code = cached ? (cached.code || '').trim() : '';
                }
                const isWatchlist = !!existingWatchlistNames[nameTrim];
                if (isWatchlist) {
                    const row = {
                        date: date, stock: nameTrim,
                        volume: item.volume || '', yest_volume: item.yestVolume || '', note: item.note || '',
                        change_pct: item.changePct || '', topics: item.topics || '',
                        selected: item.selected || false, bought: item.bought || false,
                        sold: item.sold || false, fixed: item.fixed || false,
                        obs_auto_added: !!item.obsAutoAdded,
                        updated_at: now, updated_by: 'main'
                    };
                    if (code) row.code = code;
                    watchlistRows.push(row);
                }
                // 影子记录写 market_metrics（只保留指标字段，避免空值覆盖）
                if (item.volume || item.yestVolume || item.changePct) {
                    const mRow = { date: date, stock: nameTrim, scope: 'hot', updated_at: now, updated_by: 'main' };
                    if (code) mRow.code = code;
                    if (item.volume) mRow.volume = item.volume;
                    if (item.yestVolume) mRow.yest_volume = item.yestVolume;
                    if (item.changePct) mRow.change_pct = item.changePct;
                    metricsRows.push(mRow);
                }
                localOps.push({
                    stock: nameTrim,
                    row: {
                        stock: item.stock,
                        code: code,
                        volume: item.volume || '',
                        yest_volume: item.yestVolume || '',
                        note: item.note || '',
                        change_pct: item.changePct || '',
                        topics: item.topics || '',
                        selected: item.selected || false,
                        bought: item.bought || false,
                        sold: item.sold || false,
                        fixed: item.fixed || false
                    }
                });
            });

            if (watchlistRows.length > 0 && state._hotAuctionTableAvailable) {
                const { error } = await sb.from('hot_stocks')
                    .upsert(watchlistRows, { onConflict: 'date,stock' });
                if (error) throw error;
            }
            if (metricsRows.length > 0 && state._marketMetricsTableAvailable) {
                const { error } = await sb.from('market_metrics')
                    .upsert(metricsRows, { onConflict: 'date,stock,scope' });
                if (error) throw error;
            }

            // 合并到本地全量快照缓存，避免趋势图读到旧数据
            if (!state._hotFullRowCache[date]) state._hotFullRowCache[date] = [];
            localOps.forEach(function(op) {
                const row = op.row;
                var idx = state._hotFullRowCache[date].findIndex(function(r) { return r.stock === row.stock; });
                if (idx >= 0) {
                    Object.keys(row).forEach(function(k) { state._hotFullRowCache[date][idx][k] = row[k]; });
                } else {
                    state._hotFullRowCache[date].push(row);
                }
            });
            } finally {
                _closeHotAuctionShield(2000);
            }
        }

        // pushToCloud 中调用：同步 auction 数据到新表
        export async function pushAuctionToCloud() {
            if (!state._auctionTableAvailable) return; // 表不可用时跳过，回退到 user_data
            _openAuctionShield();
            try {
            const dirtyDates = state._auctionDirtyDates ? Array.from(state._auctionDirtyDates) : [];

            // 1. 脏日期：全量同步（增删股票）
            for (let i = 0; i < dirtyDates.length; i++) {
                try { await syncAuctionListForDate(dirtyDates[i]); }
                catch(e) { _dbgLog('[AUCTION-ERR] window.syncAuctionListForDate date=' + dirtyDates[i] + ' ' + (e && e.message)); }
            }

            // 说明：曾经这里还有一个"当前日期：仅当状态签名变化时才推送"的兜底分支，
            // 每次都读取*触发这一刻*的 useUiStore().currentDate。但 scheduleCloudPush 是 2 秒防抖，
            // 如果用户在这 2 秒内切换了日期（保存后立刻翻页很常见），
            // 计时器触发时 useUiStore().currentDate 已经是新日期——导致把"刚编辑的那天"的推送，
            // 错误地当成"当前打开的这天"的状态推送来源，产生跨日期写串的问题
            // （表现为"今天的股票被写进了历史日期"）。
            // 所有真实编辑路径（saveAuction/导入/标签变化等）都已经在编辑发生的
            // 那一刻调用 markAuctionDirty(编辑时的日期)，dirtyDates 才是唯一可信来源，
            // 不需要也不应该再按"触发时刻的 useUiStore().currentDate"做兜底推送。

            // 2. 清空脏日期标记
            if (state._auctionDirtyDates) state._auctionDirtyDates.clear();
            } finally {
                _closeAuctionShield(2000);
            }
        }

        // 导入功能用：批量 upsert 行情+状态数据到 auction_watchlist
        // （用于 importAuctionFromPaste / importAuctionHistoryFill）
        // 拆表后：
        //   - 只写 auction_watchlist；影子记录由 patchAuctionFieldBatch / syncAuctionListForDate 维护。
        //   - 导入批次中的影子记录（in_watchlist!==true）若已存在于 auction_watchlist，
        //     则物理删除，替代旧 auction_data 时代的"置 in_watchlist=false 降级"。
        export async function pushAuctionDataToCloud(date, items) {
            if (!state._auctionTableAvailable) return;
            _openAuctionShield();
            try {
            const sb = getSupabase();
            const scMap = state._scMapCache || {};
            const now = new Date().toISOString();
            // 方案2：用 _auctionWatchlistIndex 判断正式成员（替代旧 in_watchlist===true 判断）
            const watchlistSet = _getAuctionWatchlistSet(date);
            const existingWatchlistNames = {};
            watchlistSet.forEach(function(name) { existingWatchlistNames[name] = true; });
            const rows = items.filter(function(s) { return s && s.stock && existingWatchlistNames[s.stock.trim()]; }).map(function(item) {
                const nameTrim = item.stock.trim();
                return {
                    date: date, stock: nameTrim,
                    code: scMap[nameTrim] || item.code || '',
                    volume: item.volume || '', yest_volume: item.yestVolume || '', note: item.note || '',
                    change_pct: item.changePct || '', topics: item.topics || '',
                    source: item.source || 'manual',
                    selected: item.selected || false, bought: item.bought || false,
                    sold: item.sold || false, fixed: item.fixed || false,
                    obs_auto_added: !!item.obsAutoAdded,
                    updated_at: now, updated_by: 'main'
                };
            });
            if (rows.length > 0) {
                const { error } = await sb.from('auction_watchlist')
                    .upsert(rows, { onConflict: 'date,stock' });
                if (error) throw error;
            }

            // 影子记录：从 auction_watchlist 物理删除（不再降级）
            const shadowItems = items.filter(function(s) { return s && s.stock && !existingWatchlistNames[s.stock.trim()]; });
            if (state._auctionTableAvailable && shadowItems.length > 0) {
                const shadowNames = shadowItems.map(function(s) { return s.stock.trim(); });
                const { error: delErr } = await sb.from('auction_watchlist')
                    .delete()
                    .eq('date', date)
                    .in('stock', shadowNames);
                if (delErr) throw delErr;
            }

            if (rows.length === 0 && shadowItems.length === 0) return;

            // 推送成功后，直接把这批数据合并进本地内存缓存，
            // 避免趋势图因 _justPushedAuction 屏蔽了 Realtime 回显而读不到当天刚导入/编辑的数据
            var _existingList = state._auctionMemCache[date] || [];
            var mergedRows = [];
            rows.forEach(function(row) {
                var idx = _existingList.findIndex(function(r) { return r.stock === row.stock; });
                var existing = idx >= 0 ? _existingList[idx] : null;
                var mergedRow = {
                    stock: row.stock, code: row.code,
                    volume: row.volume, yest_volume: row.yest_volume, note: row.note,
                    change_pct: row.change_pct, topics: row.topics,
                    selected: row.selected, bought: row.bought, sold: row.sold, fixed: row.fixed
                };
                mergedRows.push(mergedRow);
            });
            mergeAuctionDateRows(date, mergedRows, 'window.pushAuctionDataToCloud');

            // 更新状态签名（导入后状态可能变了）
            if (date === useUiStore().currentDate) {
                const wset = _getAuctionWatchlistSet(useUiStore().currentDate);
                state._lastPushedAuctionStatus = JSON.stringify((getAuctionData()[useUiStore().currentDate] || []).filter(function(s) { return s && s.stock && wset.has(s.stock.trim()); }).map(function(s) {
                    return { s: s.stock, sel: s.selected || false, b: s.bought || false,
                             so: s.sold || false, f: s.fixed || false };
                }));
            }
            } finally {
                _closeAuctionShield(2000);
            }
        }

        // 导入代码映射后：批量更新某日期的 code 列
        // 阶段二 C 改造：改用统一的 patchAuctionFieldBatch，只上报 code 列，
        // 不再各自发 update 请求；屏蔽窗口、updated_at/updated_by、本地 merge
        // 都由 patchAuctionFieldBatch 内部统一处理。
        // 拆表后：code 是公共字段，patchAuctionFieldBatch 会同时写入 auction_watchlist 与 market_metrics。
        export async function pushAuctionCodeToCloud(date) {
            if (!state._auctionTableAvailable && !state._marketMetricsTableAvailable) return;
            const scMap = state._scMapCache || {};
            // 方案2：用 _auctionWatchlistIndex 判断正式成员，只推送正式成员的 code
            const watchlistSet = _getAuctionWatchlistSet(date);
            const auctionList = (getAuctionData()[date] || []).filter(function(s) { return s && s.stock && watchlistSet.has(s.stock.trim()); });
            const items = [];
            auctionList.forEach(function(item) {
                var code = scMap[item.stock.trim()] || '';
                if (code) {
                    items.push({ stock: item.stock, code: code });
                }
            });
            if (items.length > 0) {
                await patchAuctionFieldBatch(date, items);
            }
        }

        // ============================================================
        // 云端数据拉取（解锁后执行一次）
        // ============================================================
        export async function pullFromCloud() {
            const _setSyncStatus = (v) => { try { const el = document.getElementById('syncStatus'); if (el) el.textContent = v; } catch {} };
            try {
                const sb = getSupabase();
                const { data, error } = await sb
                    .from('user_data')
                    .select('data')
                    .eq('id', 'owner')
                    .single();

                if (error) throw error;
                if (!data || !data.data || Object.keys(data.data).length === 0) {
                    _setSyncStatus('✅ 云端暂无数据，使用本地数据');
                    return;
                }

                const cloudObj = data.data;

                // §8-TODO：下方整段把云端业务数据（stocks/jiwang/rank/multi/hotspot/pattern/auction/bidding/tagTitles
                // 及 duibanData/stockEtfData/coreTopics 等散落 key）写回 localStorage，违反 §8「业务数据不得落 localStorage」。
                // 这是旧版 cloud-pull 缓存机制，迁移 Supabase 后应由内存缓存 + Realtime 取代；移除前需确认无其它模块依赖此 localStorage 兜底，待单独决策。
                // 将云端数据写入 localStorage（覆盖本地）
                const moduleKeys = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];
                const DV = 'v42';
                moduleKeys.forEach(key => {
                    if (cloudObj[key] !== undefined) {
                        // 已拆到独立表的模块：blob 中如果是空对象，不覆盖本地（数据在独立表中，空对象是拆表后的正常状态）
                        // jiwang 已完全脱离 localStorage（云端表是唯一数据源），一律跳过，不再写入
                        if (key === 'jiwang') return;
                        if ((key === 'bidding' || key === 'auction') &&
                            cloudObj[key] && typeof cloudObj[key] === 'object' &&
                            Object.keys(cloudObj[key]).length === 0) {
                            return; // 跳过，保留本地数据
                        }
                        localStorage.setItem('stockApp_' + DV + '_' + key, JSON.stringify(cloudObj[key]));
                    }
                });
                localStorage.setItem('stockApp_' + DV + '__migrated', '1');

                // 其余散落 key
                // §8 收口：duibanData 已双写 Supabase（saveDuibanData → duiban 表）；stockEtfComment 已并入 Supabase early_etf_data.comment 列（saveEtfBoardComment）；
                // biddingDefaultTemplate_v41 已双写 Supabase（saveBiddingTemplate）。三者仍保留下方 localStorage 兜底（fail-soft 降级，绝不丢数据）。
                // （过渡：duibanComment / copiedStocksData 暂无确认云端路径，按 §8 保留 localStorage 兜底；coreTopics 已另有云端路径 topic-rules.js。）
                const extraKeys = ['duibanData', 'duibanComment', 'stockEtfComment',
                                   'coreTopics', 'biddingDefaultTemplate_v41', 'copiedStocksData'];
                extraKeys.forEach(key => {
                    if (cloudObj[key] !== undefined) {
                        localStorage.setItem(key, JSON.stringify(cloudObj[key]));
                        // §8 双写：保留 localStorage 兜底 + 新增云端 Supabase（fire-and-forget，内部 try/catch 已 fail-soft）
                        try {
                            if (key === 'duibanData') saveDuibanData(cloudObj[key]);
                            else if (key === 'stockEtfComment') {
                                const cmts = cloudObj[key];
                                if (cmts && typeof cmts === 'object') {
                                    Object.keys(cmts).forEach(d => saveEtfBoardComment(d, cmts[d]));
                                }
                            }
                            else if (key === 'biddingDefaultTemplate_v41') saveBiddingTemplate(cloudObj[key]);
                        } catch (e) { console.error('[auction-sync] §8 双写异常(' + key + ')：', e && e.message); }
                    }
                });
                // summaries / hasFumianTopics（带前缀的动态 key）
                if (cloudObj.summaries) {
                    Object.entries(cloudObj.summaries).forEach(([k, v]) => localStorage.setItem(k, v));
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
                    _dbgLog('[AUCTION-ERR] window.pullAuctionFromTable ' + (tableErr && tableErr.message));
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
                    _dbgLog('[AUCTION-ERR] window.reconcileAuctionWatchlistFromLocalStorage ' + (e && e.message || e));
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
                    // 云端这次没返回的日期一律保留本地原值，不做任何删除——真正的删除
                    // 场景（用户主动清空当天数据）由 deleteJiwangFromCloud() 单独处理，
                    // 不需要也不应该依赖这里的"全量拉取"来清理。
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

                _setSyncStatus('✅ 云端数据同步成功');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] window.pullFromCloud ' + (e && e.message || e));
                _setSyncStatus('⚠️ 云端拉取失败，使用本地数据');
            }
        }

        export async function pushToCloud() {
            updateCloudSyncUI('syncing');
            try {
                // 复用 exportData 的数据收集逻辑
                loadAllData();
                // §6：下方一次性快照读取 state.allData.* 为内存缓存别名（= 各域 _xxxMemCache），用于构建 cloudObj 上传，非读 DB。
                const stockCount = Object.keys(state.allData.stocks || {}).reduce((n, d) => n + ((state.allData.stocks[d]||[]).length), 0);
                // 如果本地完全没有数据，跳过推送，防止把空数据覆盖云端
                if (stockCount === 0 && Object.keys(state.allData.jiwang || {}).length === 0) {
                    _dbgLog && _dbgLog('window.pushToCloud 跳过: 本地无数据，不覆盖云端');
                    updateCloudSyncUI('synced');
                    return;
                }
                const summaries = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('weekly_summary_') || key.startsWith('weekend_summary_') || key.startsWith('monthly_summary_'))) {
                        summaries[key] = localStorage.getItem(key);
                    }
                }
                const hasFumianTopics = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('hasFumianTopic_')) {
                        hasFumianTopics[key] = localStorage.getItem(key);
                    }
                }
                const scoreSettings = {};
                ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                    const val = localStorage.getItem('scoreSettings_' + type);
                    if (val) scoreSettings[type] = JSON.parse(val);
                });

                const payload = {
                    stocks: state.allData.stocks || {},
                    jiwang: state._jiwangTableAvailable ? {} : (state.allData.jiwang || {}),
                    rank: state.allData.rank || {},
                    multi: state.allData.multi || {},
                    hotspot: state.allData.hotspot || {},
                    pattern: state.allData.pattern || {},
                    bidding: state._biddingTableAvailable ? {} : (state.allData.bidding || {}),
                    auction: state._auctionTableAvailable ? {} : (state.allData.auction || {}),
                    tagTitles: state.allData.tagTitles || {},
                    holidays: state.allData.holidays || [],
                    duibanData: JSON.parse(localStorage.getItem('duibanData') || '{}'),
                    duibanComment: JSON.parse(localStorage.getItem('duibanComment') || '{}'),
                    stockEtfData: JSON.parse(localStorage.getItem('stockEtfData') || '{}'),
                    stockEtfComment: JSON.parse(localStorage.getItem('stockEtfComment') || '{}'),
                    coreTopics: JSON.parse(localStorage.getItem('coreTopics') || '[]'),
                    // [FIX 2026-07-24] 本地没有模板时绝不把空数组推上云。
                    // 云端 biddingDefaultTemplate 是 Worker 自动抓取的行名来源：
                    // 某次推送把 [] 带上云后，Worker 读不到任何行 → 当天自动抓取整天空白
                    // （2026-07-24 实发事故）。本地缺失时用硬编码默认模板兜底并自愈 localStorage。
                    biddingDefaultTemplate: (function() {
                        try {
                            const t = JSON.parse(localStorage.getItem('biddingDefaultTemplate_v41') || 'null');
                            if (Array.isArray(t) && t.length > 0) return t;
                        } catch (e) {}
                        const d = [
                            { name: '最近多板%' }, { name: '板块ETF(48)' }, { name: '昨日资金前十' },
                            { name: '大盘ETF' }, { name: '大盘（%）' }, { name: '封单家数' }, { name: '账号溢价' }
                        ];
                        try { localStorage.setItem('biddingDefaultTemplate_v41', JSON.stringify(d)); } catch (e) {}
                        return d;
                    })(),
                    scoreSettings: scoreSettings,
                    hasFumianTopics: hasFumianTopics,
                    summaries: summaries,
                    copiedStocksData: JSON.parse(localStorage.getItem('copiedStocksData') || '{}'),
                    exportDate: useUiStore().currentDate,
                    version: '4.2'
                };

                const sb = getSupabase();

                // auction 数据已拆表到 auction_watchlist + market_metrics，不再在 user_data blob 中合并
                // （旧合并逻辑已移除，由 pushAuctionToCloud 按列归属更新新表）

                const { error } = await sb
                    .from('user_data')
                    .upsert({ id: 'owner', data: payload, updated_at: new Date().toISOString() });

                if (error) throw error;
                // 标记刚推送，5秒内忽略自己触发的 Realtime 通知
                state._justPushed = true;
                setTimeout(function() { state._justPushed = false; }, 5000);
                // auction 数据同步到独立表（按列归属更新，不覆盖抓取程序的行情列）
                // 脏日期标记在 pushAuctionToCloud 内部清空
                try { await pushAuctionToCloud(); } catch(e) { console.warn('window.pushAuctionToCloud 失败:', e); _dbgLog('[PUSH-ERR] window.pushAuctionToCloud ' + (e && e.message || e)); }
                // bidding 数据同步到独立表
                try { await pushBiddingToCloud(useUiStore().currentDate); } catch(e) { console.warn('window.pushBiddingToCloud 失败:', e); }
                updateCloudSyncUI('synced');
            } catch (e) {
                console.error('window.pushToCloud 失败:', e);
                updateCloudSyncUI('offline');
            }
        }

            export function syncCloseChunk() {
                const end = Math.min(syncIdx + 30, itemsToSync.length);
                for (; syncIdx < end; syncIdx++) {
                    const item = itemsToSync[syncIdx];
                    const stocksData = getStocksData();
                    if (stocksData[targetDate]) {
                        const stock = stocksData[targetDate].find(s => s.name && s.name.trim() === item.stock.trim());
                        if (stock) {
                            const match = item.note.match(/^([+-]?\d+\.?\d*)%/);
                            if (match) stock.close = match[1];
                        }
                    }
                }
                if (syncIdx < itemsToSync.length) {
                    setTimeout(syncCloseChunk, 0);
                } else {
                    // 所有收盘涨幅同步完成，再同步题材，最后统一保存一次
                    syncStockTopicsFromAuction();
                    saveModule('stocks');
                    // 涨跌幅可能已批量新增/覆盖，重新统计"最近多板"/早盘ETF的总数量和跌涨比
                    recalcDuibanFromAuction(targetDate);
                }
            }
            state._syncCloseChunk = syncCloseChunk;

