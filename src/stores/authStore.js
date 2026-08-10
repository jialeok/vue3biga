import { state } from '../logic/app-state.js';
/**
 * authStore.js — 登录态 Pinia store（迁移批次 3.1）
 * 从 src/data/session-and-shield.js 拆出会话 token / Realtime channel / 推送屏蔽状态
 * 向后兼容：state._sessionToken / state.unlocked / state._justPushed* 等全局引用
 */
import { createPinia, defineStore } from 'pinia';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    sessionToken: (typeof window !== 'undefined' && state._sessionToken != null) ? state._sessionToken : null,
    realtimeChannel: (typeof window !== 'undefined' && state._realtimeChannel != null) ? state._realtimeChannel : null,
    unlocked: (typeof window !== 'undefined') ? !!state.unlocked : false,
    _justPushed: (typeof window !== 'undefined') ? !!state._justPushed : false,
    _justPushedAuction: (typeof window !== 'undefined') ? !!state._justPushedAuction : false,
    _justPushedAuctionCounter: (typeof window !== 'undefined' && typeof state._justPushedAuctionCounter === 'number') ? state._justPushedAuctionCounter : 0,
    _justPushedAuctionTimer: (typeof window !== 'undefined' && state._justPushedAuctionTimer != null) ? state._justPushedAuctionTimer : null,
  }),
  actions: {
    setSessionToken(token) {
      this.sessionToken = token;
    },
    clearSession() {
      this.sessionToken = null;
      this.realtimeChannel = null;
      this.unlocked = false;
    },
    openAuctionShield() {
      this._justPushedAuctionCounter++;
      this._justPushedAuction = true;
      if (this._justPushedAuctionTimer) {
        clearTimeout(this._justPushedAuctionTimer);
        this._justPushedAuctionTimer = null;
      }
    },
    closeAuctionShield(delayMs) {
      this._justPushedAuctionCounter = Math.max(0, this._justPushedAuctionCounter - 1);
      if (this._justPushedAuctionCounter === 0) {
        if (this._justPushedAuctionTimer) clearTimeout(this._justPushedAuctionTimer);
        const self = this;
        this._justPushedAuctionTimer = setTimeout(function () {
          self._justPushedAuction = false;
          self._justPushedAuctionTimer = null;
        }, delayMs || 2000);
      }
    },
  },
});

// 独立 pinia 实例，模块加载即创建 store（向后兼容 window 全局引用）
const _pinia = createPinia();
const store = useAuthStore(_pinia);

if (typeof window !== 'undefined') {
  // 双向同步：state._sessionToken ↔ store.sessionToken
  Object.defineProperty(window, '_sessionToken', {
    get() { return store.sessionToken; },
    set(v) { store.sessionToken = v; },
    configurable: true,
  });
  Object.defineProperty(window, '_realtimeChannel', {
    get() { return store.realtimeChannel; },
    set(v) { store.realtimeChannel = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'unlocked', {
    get() { return store.unlocked; },
    set(v) { store.unlocked = !!v; },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushed', {
    get() { return store._justPushed; },
    set(v) { store._justPushed = !!v; },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuction', {
    get() { return store._justPushedAuction; },
    set(v) { store._justPushedAuction = !!v; },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuctionCounter', {
    get() { return store._justPushedAuctionCounter; },
    set(v) { store._justPushedAuctionCounter = v; },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuctionTimer', {
    get() { return store._justPushedAuctionTimer; },
    set(v) { store._justPushedAuctionTimer = v; },
    configurable: true,
  });

}

export default store;