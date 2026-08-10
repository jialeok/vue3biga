/**
 * auctionTagStore.js — 竞价看板标签系统 Pinia store（迁移批次 3.4）
 * 原 localStorage["auctionBoardTags"] 读写逻辑（在 auction-pages.js 中）拆出
 * 结构: { "2026-08-07": { "大晟文化": "buy", ... } }
 * 标签值: 'buy' | 'sell' | 'hold' | null
 */
import { createPinia, defineStore } from 'pinia';

const STORAGE_KEY = 'auctionBoardTags';

function loadTagsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveTagsToStorage(tags) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch (e) {}
}

export const useAuctionTagStore = defineStore('auctionTag', {
  state: () => ({
    tags: (typeof localStorage !== 'undefined') ? loadTagsFromStorage() : {},
  }),
  actions: {
    getTagState(date, stock) {
      if (!date || !stock) return null;
      const t = this.tags[date];
      return (t && t[String(stock).trim()]) || null;
    },
    setTag(date, stock, tag) {
      if (!date || !stock) return;
      const key = String(stock).trim();
      if (!this.tags[date]) this.tags[date] = {};
      if (tag) this.tags[date][key] = tag;
      else delete this.tags[date][key];
      saveTagsToStorage(this.tags);
    },
    removeTag(date, stock) {
      if (!date || !stock) return;
      const key = String(stock).trim();
      if (this.tags[date]) {
        delete this.tags[date][key];
        if (Object.keys(this.tags[date]).length === 0) delete this.tags[date];
      }
      saveTagsToStorage(this.tags);
    },
    getAllTagsForDate(date) {
      if (!date) return {};
      return this.tags[date] || {};
    },
    clearTagsForDate(date) {
      if (!date) return;
      delete this.tags[date];
      saveTagsToStorage(this.tags);
    },
  },
});

const _pinia = createPinia();
const store = useAuctionTagStore(_pinia);

export default store;