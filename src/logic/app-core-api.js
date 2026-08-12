import { state } from './app-state.js';

let _fns = {};
export function _bindApi(fns) { _fns = fns; }

export function getCurrentDate() { return _fns.getCurrentDate(); }
export function getAuctionData() { return _fns.getAuctionData(); }
export function getGroupData(ds) { return _fns.getGroupData(ds); }
export function scheduleCloudPush() { return _fns.scheduleCloudPush(); }
export function markAuctionDirty(date) { return _fns.markAuctionDirty(date); }
export function saveData() { return _fns.saveData(); }
export function getTodayAuction() { return _fns.getTodayAuction(); }
export function getNextTradingDay(d) { return _fns.getNextTradingDay(d); }
export function getHotAuctionData() { return _fns.getHotAuctionData(); }
export function saveModule(m) { return _fns.saveModule(m); }
export function patchAuctionFieldBatch(d, p) { return _fns.patchAuctionFieldBatch(d, p); }
export function reconcileAuctionWatchlistFromLocalStorage() { return _fns.reconcileAuctionWatchlistFromLocalStorage(); }
export function mergeAuctionDateRows(d, r, s) { return _fns.mergeAuctionDateRows(d, r, s); }
export function _openHotAuctionShield() { return _fns._openHotAuctionShield(); }
export function _closeHotAuctionShield(t) { return _fns._closeHotAuctionShield(t); }
export function getStockHistoryTopics(stockName) { return _fns.getStockHistoryTopics(stockName); }
export function getRankData() { return _fns.getRankData(); }
export function getTagTitlesData() { return _fns.getTagTitlesData(); }
export function getTodayJiwang() { return _fns.getTodayJiwang(); }
export function getTodayGroupList(ds) { return _fns.getTodayGroupList(ds); }
export function markJiwangDirty(date) { return _fns.markJiwangDirty(date); }
export function replaceHotConceptFromPaste(...args) { return _fns.replaceHotConceptFromPaste(...args); }
export function importAuctionFromPaste(...args) { return _fns.importAuctionFromPaste(...args); }
export function replaceConceptFromPaste(...args) { return _fns.replaceConceptFromPaste(...args); }
export function importHotFromPaste(...args) { return _fns.importHotFromPaste(...args); }