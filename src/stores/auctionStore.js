import { useUiStore } from './uiStore.js';
import { defineStore } from 'pinia';

let _uiFns = {};
export function _bindUiFns(fns) { _uiFns = fns; }
/**
 * auctionStore.js — 早盘竞价看板 Pinia store（单一真相源，app 级 Pinia）
 * 重构（biga-auction-arch-refactor Phase 0/1）：
 * - 删除本文件内独立的 createPinia() 孤儿实例（之前 window.auctionStore 与组件用的
 *   useAuctionStore() 指向两个不同实例，互相漂移）。
 * - 全应用仅 main.js 一处 app.use(createPinia())；本 store 只通过 useAuctionStore() hook 访问。
 * - 日期单一真相源 = useUiStore().currentDate；setDate 直接写入 uiStore（真理），
 *   auctionStore.currentDate 仅作显示镜像，由 main.js 的单向 watch 从 uiStore 同步，避免双真相。
 * - 向后兼容的 .actions API 改为导出 auctionActions（委托到当前 app 级 store 实例），
 *   不再依赖孤儿实例上挂的 store.actions。
 */

// 安全访问器：模块顶层求值时若 Pinia 尚未激活，useAuctionStore() 会抛错，这里兜底返回 null。
function _liveStore() { try { return useAuctionStore(); } catch (e) { return null; } }

export function safeCall(fn, ...args) {
  try {
    if (typeof fn === 'function') return fn(...args);
  } catch (e) {
    console.warn('[AUCTION-STORE] 全局函数调用失败:', e);
  }
  return undefined;
}

function createSortState() {
  return {
    auction: { byData: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false },
    hot: { byData: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false }
  };
}

function createSortStateP2() {
  return {
    auction: { byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false },
    hot: { byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false }
  };
}

function tabKey() {
  return 'auction';
}

export const useAuctionStore = defineStore('auction', {
  state: () => ({
    // 基础导航
    currentDate: '',
    currentGroup: 'auction',
    currentPage: 0,

    // 数据源
    auctionData: {},
    hotAuctionData: {},

    // UI 状态
    expandedStocks: new Set(),
    p2ExpandedTopics: new Set(),
    highlightStock: '',
    highlightKeyword: '',

    // 排序状态（按 tab 隔离）
    sortState: createSortState(),
    sortStateP2: createSortStateP2(),

    // 全部展开
    expandAll: false,
    expandAllP2: false,

    // 强度排序开关
    strengthSortEnabled: false,

    // 标签派生信号版本
    stocksDataVersion: 0,

    // 按数据源隔离的版本号
    dataVersions: { auction: 0 },

    // actions 占位（下方绑定）
    actions: null,
  }),
  actions: {
    // --- 导航 ---

    switchPage(page) {
      const p = parseInt(page, 10);
      if (isNaN(p) || p < 0 || p > 3) return;
      this.currentPage = p;
    },

    // --- 排序 ---
    setSortState(page, key, value) {
      const t = tabKey();
      if (page === 1 && this.sortState[t]) {
        this.sortState[t][key] = !!value;
      } else if (page === 2 && this.sortStateP2[t]) {
        this.sortStateP2[t][key] = !!value;
      }
    },

    // --- 展开/收起 ---
    toggleTrendPanel(stockName) {
      if (!stockName) return;
      const set = this.expandedStocks;
      if (set.has(stockName)) set.delete(stockName); else set.add(stockName);
    },

    toggleP2Topic(topic) {
      if (!topic) return;
      const key = tabKey() + '|' + topic;
      const set = this.p2ExpandedTopics;
      if (set.has(key)) set.delete(key); else set.add(key);
    },

    setExpandAll(value, page) {
      if (page === 2) this.expandAllP2 = !!value;
      else this.expandAll = !!value;
    },

    // --- 高亮 ---
    setHighlight(stockName) {
      this.highlightStock = stockName || '';
    },
    clearHighlight() {
      this.highlightStock = '';
    },

    setHighlightKeyword(keyword) {
      this.highlightKeyword = (keyword || '').trim().toLowerCase();
    },

    clearHighlightKeyword() {
      this.highlightKeyword = '';
    },

    // --- 交互代理（直接调用 window 全局函数，safeCall 内部兜底） ---
    toggleRowSelect(index) {
      safeCall(_uiFns.toggleAuctionRowSelect, index);
    },

    showNotePopup(el, note) {
      safeCall(_uiFns.showAuctionNotePopup, el, note);
    },

    showNoteInput(index, el) {
      safeCall(_uiFns.showAuctionNoteInput, index, el);
    },

    showBuyPrompt(stockName) {
      safeCall(_uiFns.showAuctionBuyPrompt, stockName);
    },

    openEdit() {
      safeCall(_uiFns.openAuctionEdit);
    },

    jumpToPage2(stockName) {
      safeCall(_uiFns.jumpToAuctionPage2, stockName);
    },

    jumpToPage1(stockName) {
      safeCall(_uiFns.jumpToAuctionPage1, stockName);
    },

    toggleStrengthSort() {
      safeCall(_uiFns.toggleStrengthSort);
    },

    toggleSortHelp(panelId) {
      safeCall(_uiFns.toggleAuctionSortHelp, panelId);
    },

    toggleBoard() {
      safeCall(_uiFns.toggleAuctionBoard);
    },

    toggleTopicGroupTrendPanels(topic) {
      safeCall(_uiFns.toggleTopicGroupTrendPanels, topic);
    },

    expandAllTrendPanels(dataSource) {
      safeCall(_uiFns.expandAllAuctionTrendPanels, dataSource);
    },

    restoreExpandedTrendPanels(dataSource) {
      safeCall(_uiFns.restoreExpandedAuctionTrendPanels, dataSource);
    },

    expandAllTrendPanelsP2(dataSource) {
      safeCall(_uiFns.expandAllAuctionTrendPanelsP2, dataSource);
    },

    restoreExpandedTopicGroupsP2(dataSource) {
      safeCall(_uiFns.restoreExpandedTopicGroupsP2, dataSource);
    },

    openCoreTopicModal() {
      safeCall(_uiFns.openCoreTopicModal);
    },

    openAuctionNoteEditFromPage2(stockName) {
      safeCall(_uiFns.openAuctionNoteEditFromPage2, stockName);
    },

    copyAllTopicStocks(topic, dataSource) {
      safeCall(_uiFns.copyAllTopicStocks, topic, dataSource);
    },

    copyTopicStocks(topic, limit, dataSource) {
      safeCall(_uiFns.copyTopicStocks, topic, limit, dataSource);
    },

    // --- 日期 ---
    // 单一真相源 = useUiStore().currentDate（app 级）。这里同时写 uiStore（真理）与本地镜像。
    setDate(date) {
      useUiStore().currentDate = date || '';
      this.currentDate = date || '';
      this.expandedStocks.clear();
      this.p2ExpandedTopics.clear();
      this.highlightStock = '';
      this.highlightKeyword = '';
      this.sortState = createSortState();
      this.sortStateP2 = createSortStateP2();
      this.expandAll = false;
      this.expandAllP2 = false;
    },

    // --- 刷新 ---
    refresh() {
      safeCall(_uiFns.renderAuction, 'auction');
    },

    // --- 强度排序开关镜像 ---
    setStrengthSortEnabled(value) {
      this.strengthSortEnabled = !!value;
    },

    // --- 按数据源失效信号 ---
    bumpDataVersion(source) {
      if (this.dataVersions && source in this.dataVersions) {
        this.dataVersions[source] = (this.dataVersions[source] || 0) + 1;
      }
    },
  },
});

// 向后兼容：旧代码通过 store.actions.xxx 调用。改为委托到当前 app 级 store 实例
// （之前挂在孤儿实例上，app 级 store 拿不到 .actions，导致 useTrendChart 的滑动/事件代理失效）。
export const auctionActions = {
  switchPage: (p) => { const s = _liveStore(); if (s) s.switchPage(p); },
  setSortState: (pg, k, v) => { const s = _liveStore(); if (s) s.setSortState(pg, k, v); },
  toggleTrendPanel: (st) => { const s = _liveStore(); if (s) s.toggleTrendPanel(st); },
  toggleP2Topic: (t) => { const s = _liveStore(); if (s) s.toggleP2Topic(t); },
  setExpandAll: (v, p) => { const s = _liveStore(); if (s) s.setExpandAll(v, p); },
  setHighlight: (st) => { const s = _liveStore(); if (s) s.setHighlight(st); },
  clearHighlight: () => { const s = _liveStore(); if (s) s.clearHighlight(); },
  setHighlightKeyword: (k) => { const s = _liveStore(); if (s) s.setHighlightKeyword(k); },
  clearHighlightKeyword: () => { const s = _liveStore(); if (s) s.clearHighlightKeyword(); },
  toggleRowSelect: (i) => { const s = _liveStore(); if (s) s.toggleRowSelect(i); },
  showNotePopup: (el, n) => { const s = _liveStore(); if (s) s.showNotePopup(el, n); },
  showNoteInput: (i, el) => { const s = _liveStore(); if (s) s.showNoteInput(i, el); },
  showBuyPrompt: (st) => { const s = _liveStore(); if (s) s.showBuyPrompt(st); },
  openEdit: (ds) => { const s = _liveStore(); if (s) s.openEdit(ds); },
  jumpToPage2: (st) => { const s = _liveStore(); if (s) s.jumpToPage2(st); },
  jumpToPage1: (st) => { const s = _liveStore(); if (s) s.jumpToPage1(st); },
  toggleStrengthSort: () => { const s = _liveStore(); if (s) s.toggleStrengthSort(); },
  toggleSortHelp: (p) => { const s = _liveStore(); if (s) s.toggleSortHelp(p); },
  toggleBoard: () => { const s = _liveStore(); if (s) s.toggleBoard(); },
  toggleTopicGroupTrendPanels: (t) => { const s = _liveStore(); if (s) s.toggleTopicGroupTrendPanels(t); },
  expandAllTrendPanels: (ds) => { const s = _liveStore(); if (s) s.expandAllTrendPanels(ds); },
  restoreExpandedTrendPanels: (ds) => { const s = _liveStore(); if (s) s.restoreExpandedTrendPanels(ds); },
  expandAllTrendPanelsP2: (ds) => { const s = _liveStore(); if (s) s.expandAllTrendPanelsP2(ds); },
  restoreExpandedTopicGroupsP2: (ds) => { const s = _liveStore(); if (s) s.restoreExpandedTopicGroupsP2(ds); },
  openCoreTopicModal: () => { const s = _liveStore(); if (s) s.openCoreTopicModal(); },
  openAuctionNoteEditFromPage2: (st) => { const s = _liveStore(); if (s) s.openAuctionNoteEditFromPage2(st); },
  copyAllTopicStocks: (t, ds) => { const s = _liveStore(); if (s) s.copyAllTopicStocks(t, ds); },
  copyTopicStocks: (t, l, ds) => { const s = _liveStore(); if (s) s.copyTopicStocks(t, l, ds); },
  setDate: (d) => { const s = _liveStore(); if (s) s.setDate(d); },
  refresh: () => { const s = _liveStore(); if (s) s.refresh(); },
  setStrengthSortEnabled: (v) => { const s = _liveStore(); if (s) s.setStrengthSortEnabled(v); },
  bumpDataVersion: (sv) => { const s = _liveStore(); if (s) s.bumpDataVersion(sv); },
};

// 向后兼容默认导出：委托到 app 级 useAuctionStore() 的 Proxy（非孤儿实例、非第二真相源）。
// 原本默认导出是孤儿实例；现改为代理，旧代码 import auctionStore from '...' 仍可用且指向同一真相。
const _auctionProxy = new Proxy({}, {
  get(_t, p) { const s = _liveStore(); if (!s) return undefined; const v = s[p]; return typeof v === 'function' ? v.bind(s) : v; },
  set(_t, p, v) { const s = _liveStore(); if (s) s[p] = v; return true; },
  has(_t, p) { const s = _liveStore(); return s ? (p in s) : false; },
});
export default _auctionProxy;
