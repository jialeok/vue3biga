/**
 * fumian-sync.js — 负面题材标记云端双写（§8 合规改造）
 *
 * 改造点：hasFumianTopic_<date> 为派生业务标记（负面题材布尔），原仅存 localStorage，
 * 清缓存/换设备即丢。现改为「Supabase topic_fumian + localStorage 兜底」双写：
 *   写  → saveFumianTopics(map)：upsert 到 Supabase，绝不碰 localStorage（localStorage 由 auction-sync 保留兜底）。
 *   读  → loadFumianTopics()：select 云端重建 map 并填充 _fumianCache；读路径已切换：checkHasFumianTopic → getFumianCache（云缓存优先，localStorage 冷启动兜底）。
 *
 * 失败降级：所有云端调用 try/catch 包裹，出错仅 console.error + 返回 null/false，
 * 绝不 throw、绝不破坏 localStorage 既有路径。Supabase 表未建时自动降级，不丢数据。
 */
import { getSupabase } from './supabase-client.js';

const TABLE = 'topic_fumian';

// 内存缓存：云读取结果，供 checkHasFumianTopic 同步读取（避免改成 async 破坏调用方）
let _fumianCache = null;
export function getFumianCache(key) {
    if (_fumianCache && Object.prototype.hasOwnProperty.call(_fumianCache, key)) return _fumianCache[key];
    return null; // 未命中（含云未拉取）→ 调用方回退 localStorage
}

/**
 * 双写 hasFumianTopic_* 到 Supabase。
 * @param {Object<string,string>} map 形如 { 'hasFumianTopic_<date>': 'true'|'false' }
 * @returns {Promise<boolean>} 成功（含全部降级）返回 true；真正的本地异常返回 false（不抛出）
 *
 * 约定：值为 'true' 一定 upsert has_fumian=true；值为 'false' 也 upsert has_fumian=false（保持显式），
 *   而非跳过——显式落 false 可避免云端残留旧值造成误判。如偏好「仅写 true 省写量」，可改为跳过 false。
 */
export async function saveFumianTopics(map) {
  const sb = getSupabase();
  if (!sb || !map) return true; // 无 sb 时按降级处理，不视为失败
  try {
    for (const [key, val] of Object.entries(map)) {
      const date = key.startsWith('hasFumianTopic_') ? key.slice('hasFumianTopic_'.length) : key;
      if (!date) continue;
      const hasFumian = val === 'true' || val === true;
      const { error } = await sb
        .from(TABLE)
        .upsert(
          { date, has_fumian: hasFumian, updated_at: new Date().toISOString() },
          { onConflict: 'date' }
        );
      if (error) {
        console.error('[fumian-sync] 上云失败：', error.message || error);
      }
    }
    return true;
  } catch (e) {
    console.error('[fumian-sync] 上云失败：', e && e.message);
    return false;
  }
}

/**
 * 从 Supabase 读取全部 hasFumianTopic_* 重建为 localStorage 同构 map。
 * @returns {Promise<Object<string,string>|null>} 形如 { 'hasFumianTopic_<date>': 'true'|'false' }；失败返回 null（不抛出）
 */
export async function loadFumianTopics() {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from(TABLE).select('date, has_fumian');
    if (error) {
      console.error('[fumian-sync] 云端读取失败：', error.message || error);
      return null;
    }
    const map = {};
    (data || []).forEach((r) => {
      if (!r.date) return;
      map['hasFumianTopic_' + r.date] = r.has_fumian ? 'true' : 'false';
    });
    if (Object.keys(map).length) _fumianCache = map;
    return map;
  } catch (e) {
    console.error('[fumian-sync] 云端读取异常：', e && e.message);
    return null;
  }
}
