/**
 * auctionTagStore.js — 竞价看板标签系统 Pinia store
 *
 * §8 合规（2026-08-16 修订）：标签属于业务数据（买/卖/持），唯一持久真相为
 * Supabase 表 auction_board_tags（date,stock,tag）。本 store 不再向 localStorage
 * 写入标签，满足「标签数据禁止存 localStorage」红线；云端不可用时，内存 state.tags
 * 仍可渲染，启动后由 loadTagsFromCloud 从云端拉取覆盖。
 *
 * 真相层级：
 *   渲染读取  → Pinia state.tags（同步，保证渲染不闪）
 *   持久真相  → Supabase 表 auction_board_tags（date,stock,tag；启动拉取、写时 upsert/delete）
 *   本地兜底  → localStorage['auctionBoardTags'] 仅「只读」回退（离线/首屏免闪），永不写回
 *
 * 结构: { "2026-08-07": { "大晟文化": "buy", ... } }
 * 标签值: 'buy' | 'sell' | 'hold' | null
 */
import { defineStore } from 'pinia';
import { getSupabase } from '../data/supabase-client.js';

const STORAGE_KEY = 'auctionBoardTags';
const TABLE = 'auction_board_tags';

// 本地快照（最后一次已知值）：仅作「只读」兜底（离线/首屏免闪），云端为唯一真相。
// 解析失败/结构异常一律返回 `{}` 但不写回（本地写本就禁用），损坏快照原样保留，云端为真相。
function loadTagsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return {}; // 合法空：从未写过本地快照
    const parsed = JSON.parse(raw);
    // 结构异常（非对象）一律视为损坏：返回空但不触发任何写回（write 已禁用）。
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // §11：读取失败不得伪装为空去覆盖旧数据；仅告警，快照原样保留，云端为真相。
    console.warn('[auctionTagStore] 本地标签快照损坏，已跳过（云端为唯一真相）：', e && e.message);
    return {};
  }
}

export const useAuctionTagStore = defineStore('auctionTag', {
  state: () => ({
    // 同步真相（渲染直接读）。初始化自本地只读快照（离线/首屏兜底），启动后由云端合并覆盖。
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
      this._persistTag(date, key, tag); // 异步上云（§8 持久化真相：唯一持久层）
    },
    removeTag(date, stock) {
      if (!date || !stock) return;
      const key = String(stock).trim();
      if (this.tags[date]) {
        delete this.tags[date][key];
        if (Object.keys(this.tags[date]).length === 0) delete this.tags[date];
      }
      this._persistTag(date, key, null);
    },
    getAllTagsForDate(date) {
      if (!date) return {};
      return this.tags[date] || {};
    },
    clearTagsForDate(date) {
      if (!date) return;
      delete this.tags[date];
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
