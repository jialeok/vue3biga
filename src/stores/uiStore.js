import { defineStore } from 'pinia';

/**
 * uiStore.js — 全局 UI 状态 Pinia store（单一真相源，app 级 Pinia）
 * currentDate / currentGroup / currentPage / currentTab
 *
 * 重构（biga-auction-arch-refactor Phase 5 彻底）：
 * - 删除早期 createPinia() 孤儿实例（Phase 0/1 完成）。
 * - 全应用仅 main.js 一处 app.use(createPinia())；UI 状态唯一真相源 = 本 store。
 * - 不再有 state / window 上的 currentDate 等第二真相别名（Phase 5 已迁出并清零）。
 * - 默认值直接写字面量，不再从 app-state.js 反向读取（避免自引用 / 多真相源）。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    currentDate: '',
    currentGroup: 'auction',
    currentPage: 0,
    currentTab: '',
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

// 向后兼容默认导出：委托到 app 级 useUiStore() 的 Proxy（非孤儿实例、非第二真相源）。
const _uiProxy = new Proxy({}, {
  get(_t, p) { try { const s = useUiStore(); const v = s[p]; return typeof v === 'function' ? v.bind(s) : v; } catch (e) { return undefined; } },
  set(_t, p, v) { try { useUiStore()[p] = v; } catch (e) {} return true; },
  has(_t, p) { try { return p in useUiStore(); } catch (e) { return false; } },
});
export default _uiProxy;
