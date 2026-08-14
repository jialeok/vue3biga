import { getStocksData } from '../data/supabase-client.js';
import { saveData, getNextTradingDay } from './app-core-api.js';
import { state } from './app-state.js';
import { _emit } from '../stores/eventBus.js';
import { showToast } from '../composables/useToast.js';
import { pushRemainingNow } from '../data/remaining-boards.js';
import { useUiStore } from '../stores/uiStore.js';

function _genStockId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function deleteStock(id) {
    if (id === undefined || id === null || Number.isNaN(id)) {
        showToast('⚠️ 记录ID无效，无法删除');
        return;
    }
    if (!confirm('确定要删除这条记录吗？')) return;
    const currentDate = useUiStore().currentDate;
    const dayList = getStocksData()[currentDate];
    if (!dayList || !Array.isArray(dayList)) return;
    const idx = dayList.findIndex(s => s && s.id === id);
    if (idx === -1) {
        showToast('⚠️ 未找到该记录');
        return;
    }
    const stockName = dayList[idx].name || null;
    dayList.splice(idx, 1);
    if (dayList.length === 0) delete getStocksData()[currentDate];
    saveData();
    pushRemainingNow(currentDate);
    _emit('stocks-refresh');
    if (stockName) showToast('已删除 ' + stockName);
}

export function copyToTomorrow(id) {
    const currentDate = useUiStore().currentDate;
    const stock = (getStocksData()[currentDate] || []).find(s => s.id === id);
    if (!stock) {
        showToast('⚠️ 未找到股票数据');
        return;
    }
    const nextTradingDay = getNextTradingDay(currentDate);
    const sourceBought = stock.bought || false;
    const sourceSold = stock.sold || false;
    let shouldClearSoldRecords = false;
    if (stock.soldRecords && stock.soldRecords.length > 0) {
        const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
        const latestRecord = sortedRecords[0];
        if (latestRecord && latestRecord.type === '全清仓') {
            shouldClearSoldRecords = true;
        }
    }
    const newStock = {
        id: _genStockId(),
        name: stock.name || '',
        stage: stock.stage || '二板',
        xgcaiti: stock.xgcaiti || '',
        track: stock.track ? JSON.parse(JSON.stringify(stock.track)) : [],
        bought: false,
        sold: false,
        hold: sourceBought || stock.hold || false,
        inheritedHold: (sourceBought || stock.hold || false) ? true : undefined,
        watch: sourceSold || stock.watch || false,
        dragon: stock.dragon || false,
        recentMulti: stock.recentMulti || false,
        topicDirection: stock.topicDirection || false,
        sectorEtf: stock.sectorEtf || false,
        isSold: stock.isSold || false,
        soldRecords: shouldClearSoldRecords ? [] : (stock.soldRecords ? JSON.parse(JSON.stringify(stock.soldRecords)) : []),
        adjust: '',
        open: '',
        close: '',
        turnover: '',
        kbiliangkai: '',
        sfliangneng: '',
        nextDay: '',
        bomb: false,
        pattern: '',
        axis: '',
        remark: '',
        remarkType: ''
    };
    if (!getStocksData()[nextTradingDay]) {
        getStocksData()[nextTradingDay] = [];
    }
    const existingStock = getStocksData()[nextTradingDay].find(s => s.name === newStock.name);
    if (existingStock) {
        if (!confirm(nextTradingDay + ' 已存在 "' + newStock.name + '"，是否覆盖？')) {
            return;
        }
        getStocksData()[nextTradingDay] = getStocksData()[nextTradingDay].filter(s => s.name !== newStock.name);
    }
    getStocksData()[nextTradingDay].push(newStock);
    saveData();
    showToast('✅ 已复制 "' + newStock.name + '" 到 ' + nextTradingDay);
    if (currentDate === nextTradingDay) {
        _emit('stocks-refresh');
    }
}

export function copyToDate(id) {
    const currentDate = useUiStore().currentDate;
    const stock = (getStocksData()[currentDate] || []).find(s => s.id === id);
    if (!stock) {
        showToast('⚠️ 未找到股票数据');
        return;
    }
    const today = new Date(currentDate);
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + 30);
    const todayStr = today.toISOString().split('T')[0];
    const maxDateStr = maxDate.toISOString().split('T')[0];
    const selectedDate = prompt('请选择复制日期（' + todayStr + ' 至 ' + maxDateStr + '）：', todayStr);
    if (!selectedDate) return;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(selectedDate)) {
        showToast('⚠️ 日期格式不正确，请使用 YYYY-MM-DD 格式');
        return;
    }
    const sourceBought = stock.bought || false;
    const sourceSold = stock.sold || false;
    let shouldClearSoldRecords = false;
    if (stock.soldRecords && stock.soldRecords.length > 0) {
        const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
        const latestRecord = sortedRecords[0];
        if (latestRecord && latestRecord.type === '全清仓') {
            shouldClearSoldRecords = true;
        }
    }
    const newStock = {
        id: _genStockId(),
        name: stock.name || '',
        stage: stock.stage || '二板',
        xgcaiti: stock.xgcaiti || '',
        track: stock.track ? JSON.parse(JSON.stringify(stock.track)) : [],
        bought: false,
        sold: false,
        hold: sourceBought || stock.hold || false,
        inheritedHold: (sourceBought || stock.hold || false) ? true : undefined,
        watch: sourceSold || stock.watch || false,
        dragon: stock.dragon || false,
        recentMulti: stock.recentMulti || false,
        topicDirection: stock.topicDirection || false,
        sectorEtf: stock.sectorEtf || false,
        isSold: stock.isSold || false,
        soldRecords: shouldClearSoldRecords ? [] : (stock.soldRecords ? JSON.parse(JSON.stringify(stock.soldRecords)) : []),
        adjust: '',
        open: '',
        close: '',
        turnover: '',
        kbiliangkai: '',
        sfliangneng: '',
        nextDay: '',
        bomb: false,
        pattern: '',
        axis: '',
        remark: '',
        remarkType: ''
    };
    if (!getStocksData()[selectedDate]) {
        getStocksData()[selectedDate] = [];
    }
    const existingStock = getStocksData()[selectedDate].find(s => s.name === newStock.name);
    if (existingStock) {
        if (!confirm(selectedDate + ' 已存在 "' + newStock.name + '"，是否覆盖？')) {
            return;
        }
        getStocksData()[selectedDate] = getStocksData()[selectedDate].filter(s => s.name !== newStock.name);
    }
    getStocksData()[selectedDate].push(newStock);
    saveData();
    showToast('✅ 已复制 "' + newStock.name + '" 到 ' + selectedDate);
    if (currentDate === selectedDate) {
        _emit('stocks-refresh');
    }
}

export function editStock(id) {
    _emit('stock-edit', id);
}

export function openSoldEdit(stockId) {
    _emit('stock-sold-edit', stockId);
}

export function openTrackEdit(id) {
    _emit('stock-track-edit', id);
}