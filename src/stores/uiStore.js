import { state } from '../logic/app-state.js';
/**
 * uiStore.js — 全局 UI 状态 Pinia store（迁移批次 3.2）
 * currentDate / currentGroup / currentPage / currentTab
 * 向后兼容：state.currentDate / state.currentGroup / state.auctionCurrentPage / state.currentTab
 * state.currentDate 被大量代码直接读写，用 Object.defineProperty 做双向同步
 */
import { createPinia, defineStore } from 'pinia';
import { watch } from 'vue';

export const useUiStore = defineStore('ui', {
  state: () => ({
    currentDate: (typeof window !== 'undefined' && state.currentDate != null) ? state.currentDate : '',
    currentGroup: (typeof window !== 'undefined' && state.currentGroup != null) ? state.currentGroup : 'auction',
    currentPage: (typeof window !== 'undefined' && state.auctionCurrentPage != null) ? state.auctionCurrentPage : 0,
    currentTab: (typeof window !== 'undefined' && state.currentTab != null) ? state.currentTab : '',
  }),
  actions: {
    setDate(date) {
      this.currentDate = date || '';
    },
    switchGroup(group) {
      if (group !== 'auction' && group !== 'hot') return;
      this.currentGroup = group;
    },
    switchPage(page) {
      const p = parseInt(page, 10);
      if (isNaN(p) || p < 0) return;
      this.currentPage = p;
    },
    switchTab(tab) {
      this.currentTab = tab;
    },
  },
});

const _pinia = createPinia();
const store = useUiStore(_pinia);

if (typeof window !== 'undefined') {
  // 双向同步 state.currentDate ↔ store.currentDate（被大量代码直接读写）
  Object.defineProperty(window, 'currentDate', {
    get() { return store.currentDate; },
    set(v) { store.currentDate = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'currentGroup', {
    get() { return store.currentGroup; },
    set(v) { store.currentGroup = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'auctionCurrentPage', {
    get() { return store.currentPage; },
    set(v) { store.currentPage = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'currentTab', {
    get() { return store.currentTab; },
    set(v) { store.currentTab = v; },
    configurable: true,
  });

}

// watch 保障：若外部直接赋值 state.currentDate 已通过 setter 写入 store，
// 这里再用 watch 把 store 变化广播到可能挂载的其它全局镜像（兜底）
try {
  watch(() => store.currentDate, (v) => { if (state.currentDate !== v) state.currentDate = v; });
  watch(() => store.currentGroup, (v) => { if (state.currentGroup !== v) state.currentGroup = v; });
} catch (e) {}

export default store;