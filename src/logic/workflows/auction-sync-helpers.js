// auction-sync-helpers.js — 辅助函数与共享内存状态（从 auction-sync.js 物理拆分）
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

        // §8 合规：pullFromCloud/pushToCloud 之间传递的「blob 额外字段」(duibanData/duibanComment/
        // stockEtfComment/coreTopics/biddingDefaultTemplate_v41/copiedStocksData/summaries 等)
        // 原以 localStorage 做暂存（业务数据落 localStorage，违反 §8）。现改为模块内存对象暂存：
        // 语义与数据流完全不变（pull 写入、push 读出），仅存储介质从 localStorage 换成内存；
        // 重启后由下次 pullFromCloud 从云端 user_data blob 重新填充，不丢数据（这些字段本身也都有
        // 各自的云端真相源，或仅作 blob 冗余备份）。scoreSettings/holidays/tradingDays 等 §8 允许的
        // UI 偏好/兜底 key 仍按原样走 localStorage。
        // （本对象被 pull/push 子模块共享引用，保持单一内存实例。）
        export const _cloudBlobExtras = {};

        // syncCloseChunk：把竞价笔记里的收盘涨幅/题材同步回 stocksData，最后统一保存并重算多板统计。
        // syncIdx/itemsToSync/targetDate 为调用方（auction.js）注入的外部自由变量，本函数仅读取。
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
