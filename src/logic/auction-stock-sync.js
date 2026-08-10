import { getStocksData } from '../data/supabase-client.js';
import { getTodayAuction, saveData, getNextTradingDay, getAuctionData } from './app-core-api.js';
import { extractTopics } from './note-helpers.js';
import { getStockCode } from '../data/stock-code-map.js';
import { setAuctionDateData } from '../data/auction-data.js';
import { _addAuctionWatchlistMember } from '../data/watchlist-and-metrics.js';

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

export function ensureStockInNextDay(stockName, date) {
    const nextDay = getNextTradingDay(date);
    if (!nextDay) return;
    const auctionData = getAuctionData();
    const dayList = auctionData[nextDay] || [];
    const exists = dayList.some(s => s && s.stock && s.stock.trim() === stockName.trim());
    if (!exists) {
        dayList.push({ stock: stockName.trim(), code: getStockCode(stockName), volume: '', yestVolume: '', note: '', obsAutoAdded: true });
        auctionData[nextDay] = dayList;
        setAuctionDateData(nextDay, dayList, 'auctionBoardTags');
        _addAuctionWatchlistMember(nextDay, stockName.trim());
        saveData();
    }
}