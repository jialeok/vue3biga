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
 * - 向后兼容的 .actions API（auctionActions 兼容层）已于 A11 清理中移除（§16 死代码）：
 *   该层仅委托到 _uiFns 空桩，全项目 0 个外部调用点。保留 _auctionProxy 默认导出
 *   （LongPressTagMenu / AuctionEditModal 经它访问 live 的 bumpDataVersion / refresh）。
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
    auction: { byWeakStrong: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false },
    hot: { byWeakStrong: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false }
  };
}

function createSortStateP2() {
  return {
    auction: { byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false },
    hot: { byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false }
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

    // [A11 §16] 下方 19 个 safeCall(_uiFns.xxx) 委托全部为死代码：对应 ui-bridge 空桩已删除，
    // 这些 _uiFns 键在运行时始终为 undefined（AuctionBoard 一律走本地实现）。已整体移除。
    // 仅保留 live 的 refresh() → _uiFns.renderAuction（见下方“刷新”节）。

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

// 向后兼容默认导出：委托到 app 级 useAuctionStore() 的 Proxy（非孤儿实例、非第二真相源）。
// 原本默认导出是孤儿实例；现改为代理，旧代码 import auctionStore from '...' 仍可用且指向同一真相。
const _auctionProxy = new Proxy({}, {
  get(_t, p) { const s = _liveStore(); if (!s) return undefined; const v = s[p]; return typeof v === 'function' ? v.bind(s) : v; },
  set(_t, p, v) { const s = _liveStore(); if (s) s[p] = v; return true; },
  has(_t, p) { const s = _liveStore(); return s ? (p in s) : false; },
});
export default _auctionProxy;
