import { state } from '../logic/app-state.js';
/**
 * uiStore.js — 全局 UI 状态 Pinia store（单一真相源，app 级 Pinia）
 * currentDate / currentGroup / currentPage / currentTab
 *
 * 重构（biga-auction-arch-refactor Phase 0/1）：
 * - 删除本文件内独立的 createPinia() 孤儿实例（之前 window.currentDate 绑到孤儿实例，
 *   而组件用 app 级 useUiStore()，两套实例互相漂移 → 日期一切换就全乱）。
 * - 全应用仅 main.js 一处 app.use(createPinia())；日期唯一真相源 = useUiStore().currentDate。
 * - window.currentDate 改为委托到 app 级 useUiStore()（仅作向后兼容别名，不是第二个真相）。
 * - state.currentDate 由 app-state.js 统一委托到本 store，故此处不再双向桥接。
 */
import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({
    currentDate: '',
    currentGroup: (typeof window !== 'undefined' && state.currentGroup != null) ? state.currentGroup : 'auction',
    currentPage: (typeof window !== 'undefined' && state.auctionCurrentPage != null) ? state.auctionCurrentPage : 0,
    currentTab: (typeof window !== 'undefined' && state.currentTab != null) ? state.currentTab : '',
  }),
  actions: {
    setDate(date) {
      this.currentDate = date || '';
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

if (typeof window !== 'undefined') {
  // 单一真相源：window.currentDate 委托到 app 级 useUiStore()（不再持有孤儿实例）。
  // 任何通过 window.currentDate 读写的代码，最终都落在同一个 app 级 store 实例上。
  Object.defineProperty(window, 'currentDate', {
    get() { try { return useUiStore().currentDate; } catch (e) { return ''; } },
    set(v) { try { useUiStore().currentDate = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, 'currentGroup', {
    get() { try { return useUiStore().currentGroup; } catch (e) { return 'auction'; } },
    set(v) { try { useUiStore().currentGroup = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, 'auctionCurrentPage', {
    get() { try { return useUiStore().currentPage; } catch (e) { return 0; } },
    set(v) { try { useUiStore().currentPage = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, 'currentTab', {
    get() { try { return useUiStore().currentTab; } catch (e) { return ''; } },
    set(v) { try { useUiStore().currentTab = v; } catch (e) {} },
    configurable: true,
  });
}

// 向后兼容默认导出：委托到 app 级 useUiStore() 的 Proxy（非孤儿实例、非第二真相源）。
const _uiProxy = new Proxy({}, {
  get(_t, p) { try { const s = useUiStore(); const v = s[p]; return typeof v === 'function' ? v.bind(s) : v; } catch (e) { return undefined; } },
  set(_t, p, v) { try { useUiStore()[p] = v; } catch (e) {} return true; },
  has(_t, p) { try { return p in useUiStore(); } catch (e) { return false; } },
});
export default _uiProxy;
