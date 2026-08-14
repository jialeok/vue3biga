import { state } from '../logic/app-state.js';
/**
 * authStore.js — 登录态 Pinia store（迁移批次 3.1）
 * 从 src/data/session-and-shield.js 拆出会话 token / Realtime channel / 推送屏蔽状态
 * 向后兼容：state._sessionToken / state.unlocked / state._justPushed* 等全局引用
 */
import { defineStore } from 'pinia';

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

// 单一真相源：window 上的登录态别名委托到 app 级 useAuthStore()（不再持有孤儿实例）。
if (typeof window !== 'undefined') {
  // 登录态全局别名委托（向后兼容 window._sessionToken / window.unlocked 等直接读写）
  Object.defineProperty(window, '_sessionToken', {
    get() { try { return useAuthStore().sessionToken; } catch (e) { return null; } },
    set(v) { try { useAuthStore().sessionToken = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, '_realtimeChannel', {
    get() { try { return useAuthStore().realtimeChannel; } catch (e) { return null; } },
    set(v) { try { useAuthStore().realtimeChannel = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, 'unlocked', {
    get() { try { return useAuthStore().unlocked; } catch (e) { return false; } },
    set(v) { try { useAuthStore().unlocked = !!v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushed', {
    get() { try { return useAuthStore()._justPushed; } catch (e) { return false; } },
    set(v) { try { useAuthStore()._justPushed = !!v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuction', {
    get() { try { return useAuthStore()._justPushedAuction; } catch (e) { return false; } },
    set(v) { try { useAuthStore()._justPushedAuction = !!v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuctionCounter', {
    get() { try { return useAuthStore()._justPushedAuctionCounter; } catch (e) { return 0; } },
    set(v) { try { useAuthStore()._justPushedAuctionCounter = v; } catch (e) {} },
    configurable: true,
  });
  Object.defineProperty(window, '_justPushedAuctionTimer', {
    get() { try { return useAuthStore()._justPushedAuctionTimer; } catch (e) { return null; } },
    set(v) { try { useAuthStore()._justPushedAuctionTimer = v; } catch (e) {} },
    configurable: true,
  });
}

// 向后兼容默认导出：委托到 app 级 useAuthStore() 的 Proxy（非孤儿实例、非第二真相源）。
const _authProxy = new Proxy({}, {
  get(_t, p) { try { const s = useAuthStore(); const v = s[p]; return typeof v === 'function' ? v.bind(s) : v; } catch (e) { return undefined; } },
  set(_t, p, v) { try { useAuthStore()[p] = v; } catch (e) {} return true; },
  has(_t, p) { try { return p in useAuthStore(); } catch (e) { return false; } },
});
export default _authProxy;