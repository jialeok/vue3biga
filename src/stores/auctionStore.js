﻿import { state } from '../logic/app-state.js';
import { useUiStore } from './uiStore.js';

let _uiFns = {};
export function _bindUiFns(fns) { _uiFns = fns; }
/**
 * auctionStore.js — 早盘竞价看板 Pinia store（迁移批次 3.3）
 * 从 IIFE + Vue.reactive 手写 store 重构为标准 Pinia defineStore
 * 保留 window.auctionStore 向后兼容赋值
 */
import { createPinia, defineStore } from 'pinia';
import { watch } from 'vue';

// ---------- 内部辅助函数 ----------
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

function syncGlobalCurrentDate(store) {
  try {
    if (typeof state.currentDate !== 'undefined' && state.currentDate !== store.currentDate) {
      state.currentDate = store.currentDate;
    }
  } catch (e) {}
}

export const useAuctionStore = defineStore('auction', {
  state: () => ({
    // 基础导航
    currentDate: (typeof window !== 'undefined' && state.currentDate != null) ? state.currentDate : '',
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
    setDate(date) {
      this.currentDate = date || '';
      this.expandedStocks.clear();
      this.p2ExpandedTopics.clear();
      this.highlightStock = '';
      this.highlightKeyword = '';
      this.sortState = createSortState();
      this.sortStateP2 = createSortStateP2();
      this.expandAll = false;
      this.expandAllP2 = false;
      syncGlobalCurrentDate(this);
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

// 独立 pinia 实例，模块加载即创建 store
const _pinia = createPinia();
const store = useAuctionStore(_pinia);

// 绑定 actions 引用（向后兼容：旧代码通过 store.actions.xxx 调用）
store.actions = {

  switchPage: (p) => store.switchPage(p),
  setSortState: (pg, k, v) => store.setSortState(pg, k, v),
  toggleTrendPanel: (s) => store.toggleTrendPanel(s),
  toggleP2Topic: (t) => store.toggleP2Topic(t),
  setExpandAll: (v, p) => store.setExpandAll(v, p),
  setHighlight: (s) => store.setHighlight(s),
  clearHighlight: () => store.clearHighlight(),
  setHighlightKeyword: (k) => store.setHighlightKeyword(k),
  clearHighlightKeyword: () => store.clearHighlightKeyword(),
  toggleRowSelect: (i) => store.toggleRowSelect(i),
  showNotePopup: (el, n) => store.showNotePopup(el, n),
  showNoteInput: (i, el) => store.showNoteInput(i, el),
  showBuyPrompt: (s) => store.showBuyPrompt(s),
  openEdit: (ds) => store.openEdit(ds),
  jumpToPage2: (s) => store.jumpToPage2(s),
  jumpToPage1: (s) => store.jumpToPage1(s),
  toggleStrengthSort: () => store.toggleStrengthSort(),
  toggleSortHelp: (p) => store.toggleSortHelp(p),
  toggleBoard: () => store.toggleBoard(),
  toggleTopicGroupTrendPanels: (t) => store.toggleTopicGroupTrendPanels(t),
  expandAllTrendPanels: (ds) => store.expandAllTrendPanels(ds),
  restoreExpandedTrendPanels: (ds) => store.restoreExpandedTrendPanels(ds),
  expandAllTrendPanelsP2: (ds) => store.expandAllTrendPanelsP2(ds),
  restoreExpandedTopicGroupsP2: (ds) => store.restoreExpandedTopicGroupsP2(ds),
  openCoreTopicModal: () => store.openCoreTopicModal(),
  openAuctionNoteEditFromPage2: (s) => store.openAuctionNoteEditFromPage2(s),
  copyAllTopicStocks: (t, ds) => store.copyAllTopicStocks(t, ds),
  copyTopicStocks: (t, l, ds) => store.copyTopicStocks(t, l, ds),
  setDate: (d) => store.setDate(d),
  refresh: () => store.refresh(),
  setStrengthSortEnabled: (v) => store.setStrengthSortEnabled(v),
  bumpDataVersion: (s) => store.bumpDataVersion(s),
};


// store -> global 同步（currentDate 变化时同步到 window）
try {
  watch(() => store.currentDate, () => syncGlobalCurrentDate(store));
  // uiStore.currentDate → auctionStore.currentDate 防御性同步
  // 确保任何通过 uiStore.setDate 切换日期的路径都能同步到 auctionStore
  const _uiStore = useUiStore();
  watch(() => _uiStore.currentDate, (v) => { if (v && store.currentDate !== v) store.currentDate = v; });
} catch (e) {}

export default store;
