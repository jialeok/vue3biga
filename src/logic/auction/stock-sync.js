import { getStocksData } from '../../data/supabase-client.js';
import { getTodayAuction, saveData, getNextTradingDay, getAuctionData } from '../app-core-api.js';
import { extractTopics } from '../note/helpers.js';
import { setAuctionDateData } from '../../data/auction-data.js';
import { ensureTaggedCarryOverForDate } from './tag-carryover.js';

export function syncStockCloseFromAuction(stockName, note, currentDate) {
    if (!stockName) return;
    let close = '';
    if (note) {
        const match = note.match(/^([+-]?\d+\.?\d*)%/);
        if (match) close = match[1];
    }
    const stocksData = getStocksData();
    if (!stocksData[currentDate]) return;
    const stock = stocksData[currentDate].find(s => s.name && s.name.trim() === stockName.trim());
    if (stock && close !== '') {
        stock.close = close;
    }
}

export function syncStockTopicsFromAuction(currentDate) {
    const auctionList = getTodayAuction();
    const stocksData = getStocksData();
    if (!stocksData[currentDate]) return;

    let hasUpdate = false;

    stocksData[currentDate].forEach(stock => {
        if (!stock.name) return;

        const auctionItem = auctionList.find(item =>
            item.stock && item.stock.trim() === stock.name.trim()
        );

        if (auctionItem) {
            let topics = [];
            if (auctionItem.topics) {
                topics = auctionItem.topics.split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
            }
            if (topics.length === 0 && auctionItem.note) {
                topics = extractTopics(auctionItem.note);
            }
            const newXgcaiti = topics.join('，');

            if (newXgcaiti && newXgcaiti !== stock.xgcaiti) {
                stock.xgcaiti = newXgcaiti;
                hasUpdate = true;
            }
        }
    });

    if (hasUpdate) {
        saveData();
    }
}

/**
 * 打标签后立即把该股票补进「次一交易日」列表（观察组身份），保证次日一定可见。
 * [REFACTOR 2026-09-08] 补行逻辑收敛到 tag-carryover.js（与渲染前补行、worker 抓取名单
 * 共用同一口径），这里只负责触发 + 落库。继承身份统一为观察组（obsAutoAdded=true），
 * 不进正式成员索引，不影响 9:25 名单口径与强度统计。
 */
export function ensureStockInNextDay(stockName, date) {
    if (!stockName || !String(stockName).trim()) return;
    const nextDay = getNextTradingDay(date);
    if (!nextDay) return;
    const added = ensureTaggedCarryOverForDate(nextDay, [String(stockName).trim()]);
    if (added > 0) {
        setAuctionDateData(nextDay, getAuctionData()[nextDay] || [], 'auctionBoardTags');
        saveData();
    }
}