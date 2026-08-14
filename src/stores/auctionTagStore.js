/**
 * auctionTagStore.js — 竞价看板标签系统 Pinia store
 *
 * §8 合规改造（2026-08-14）：标签属于业务数据（买/卖/持），原仅存 localStorage，
 * 清缓存 / 换设备即丢，违反「业务数据必须持久化到 Supabase、跨设备不丢」。
 *
 * 改造后真相层级：
 *   渲染读取  → Pinia state.tags（同步，保证渲染不闪）
 *   本地快照  → localStorage['auctionBoardTags']（乐观落盘 + 云端不可用时兜底，非唯一真相）
 *   持久真相  → Supabase 表 auction_board_tags（date,stock,tag；启动拉取、写时 upsert/delete）
 *
 * 结构: { "2026-08-07": { "大晟文化": "buy", ... } }
 * 标签值: 'buy' | 'sell' | 'hold' | null
 */
import { defineStore } from 'pinia';
import { getSupabase } from '../data/supabase-client.js';

const STORAGE_KEY = 'auctionBoardTags';
const TABLE = 'auction_board_tags';

// 本地快照（最后一次已知值）：云端不可用时的兜底，不阻断渲染；不再是唯一真相。
function loadTagsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); // 合规：标签兜底快照（§8 允许，非唯一真相）
  } catch (e) {
    return {};
  }
}

function saveTagsToStorage(tags) {
  try {
    // 合规：本地快照仅为云端不可用兜底（§8 允许，非唯一真相），持久真相已上云（见 _persistTag/_persistClearDate）。
    // 保留此写以支撑「清缓存/换设备时仍有兜底」与首屏免闪烁；是否彻底移除待单独决策（RED LINE：勿静默删用户数据）。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch (e) {}
}

export const useAuctionTagStore = defineStore('auctionTag', {
  state: () => ({
    // 同步真相（渲染直接读），初始化自 localStorage 快照，启动后再被云端合并覆盖
    tags: loadTagsFromStorage(),
    _cloudLoaded: false,
  }),
  actions: {
    // 启动拉取云端标签：Supabase 才是持久化真相（§8）。云端缺失/失败不阻断，本地快照兜底。
    async loadTagsFromCloud() {
      const sb = getSupabase();
      if (!sb) return;
      try {
        const { data, error } = await sb.from(TABLE).select('date,stock,tag');
        if (error) {
          console.error('[auctionTagStore] 云端标签读取失败：', error.message || error);
          return;
        }
        const merged = { ...this.tags };
        (data || []).forEach((r) => {
          const d = r.date;
          const s = String(r.stock == null ? '' : r.stock).trim();
          if (!d || !s) return;
          if (!merged[d]) merged[d] = {};
          if (r.tag) merged[d][s] = r.tag;
          else delete merged[d][s];
        });
        this.tags = merged;
        this._cloudLoaded = true;
        saveTagsToStorage(this.tags);
      } catch (e) {
        console.error('[auctionTagStore] 云端标签读取异常：', e && e.message);
      }
    },
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
      saveTagsToStorage(this.tags); // 乐观落本地快照（不阻断渲染）
      this._persistTag(date, key, tag); // 异步上云（§8 持久化真相）
    },
    removeTag(date, stock) {
      if (!date || !stock) return;
      const key = String(stock).trim();
      if (this.tags[date]) {
        delete this.tags[date][key];
        if (Object.keys(this.tags[date]).length === 0) delete this.tags[date];
      }
      saveTagsToStorage(this.tags);
      this._persistTag(date, key, null);
    },
    getAllTagsForDate(date) {
      if (!date) return {};
      return this.tags[date] || {};
    },
    clearTagsForDate(date) {
      if (!date) return;
      delete this.tags[date];
      saveTagsToStorage(this.tags);
      this._persistClearDate(date);
    },
    // 单只标签上云：有值 upsert，null 删除
    async _persistTag(date, stock, tag) {
      const sb = getSupabase();
      if (!sb) return;
      try {
        if (tag) {
          const { error } = await sb
            .from(TABLE)
            .upsert({ date, stock, tag, updated_at: new Date().toISOString() }, { onConflict: 'date,stock' });
          if (error) console.error('[auctionTagStore] 标签上云失败：', error.message || error);
        } else {
          const { error } = await sb.from(TABLE).delete().eq('date', date).eq('stock', stock);
          if (error) console.error('[auctionTagStore] 标签删除上云失败：', error.message || error);
        }
      } catch (e) {
        console.error('[auctionTagStore] 标签上云异常：', e && e.message);
      }
    },
    // 清空某日期全部标签上云
    async _persistClearDate(date) {
      const sb = getSupabase();
      if (!sb) return;
      try {
        const { error } = await sb.from(TABLE).delete().eq('date', date);
        if (error) console.error('[auctionTagStore] 清空日期标签上云失败：', error.message || error);
      } catch (e) {
        console.error('[auctionTagStore] 清空日期标签上云异常：', e && e.message);
      }
    },
  },
});

// 启动入口：拉取云端标签（幂等，可重复调用）。由 app-core initApp 调用。
export async function initAuctionTags() {
  try {
    await useAuctionTagStore().loadTagsFromCloud();
  } catch (e) {
    console.error('[auctionTagStore] initAuctionTags 异常：', e && e.message);
  }
}

// 向后兼容默认导出：委托到 app 级 useAuctionTagStore() 的 Proxy（非孤儿实例、非第二真相源）。
const _tagProxy = new Proxy({}, {
  get(_t, p) {
    try {
      const s = useAuctionTagStore();
      const v = s[p];
      return typeof v === 'function' ? v.bind(s) : v;
    } catch (e) {
      return undefined;
    }
  },
  set(_t, p, v) {
    try {
      useAuctionTagStore()[p] = v;
    } catch (e) {}
    return true;
  },
  has(_t, p) {
    try {
      return p in useAuctionTagStore();
    } catch (e) {
      return false;
    }
  },
});
export default _tagProxy;
