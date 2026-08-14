/**
 * bidding-template-sync.js — 竞价默认模板云端同步（§8 合规）
 *
 * 双写（dual-write）+ 失败降级：
 *   - 写：saveBiddingTemplate() 将竞价默认模板数组 upsert 到 Supabase 表 auction_bidding_template
 *        （固定 id='default' 单行存储）；失败仅 console.error 并返回 false，绝不 throw、绝不碰 localStorage。
 *   - 读：loadBiddingTemplate() 从 auction_bidding_template 读回模板数组；失败返回 null，调用方回退到 localStorage。
 *
 * 全部操作 fail-soft：Supabase 表未建 / 网络异常时，localStorage 读取路径（auction-sync）不受影响。
 * 注：本模块只负责云端双写，localStorage 兜底由 auction-sync.js 保留，本文件绝不删除或改写 localStorage 数据。
 */
import { getSupabase } from './supabase-client.js';

const TABLE = 'auction_bidding_template';

/**
 * 将竞价默认模板数组双写到 Supabase（单行 id='default'）。
 * @param {Array} templates 竞价默认模板数组（如 [{name:'大盘ETF'}, ...]）
 * @returns {Promise<boolean>} 成功 true / 失败 false（不抛异常）
 */
export async function saveBiddingTemplate(templates) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const { error } = await sb
      .from(TABLE)
      .upsert(
        { id: 'default', templates, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      );
    if (error) console.error('[bidding-template-sync] 上云失败：', error && error.message);
    return !error;
  } catch (e) {
    console.error('[bidding-template-sync] 上云失败：', e && e.message);
    return false;
  }
}

/**
 * 从 Supabase 读取竞价默认模板数组。
 * @returns {Promise<Array|null>} 成功返回模板数组，失败/无数据返回 null（调用方回退 localStorage）。
 */
export async function loadBiddingTemplate() {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from(TABLE)
      .select('templates')
      .eq('id', 'default')
      .maybeSingle();
    if (error) {
      console.error('[bidding-template-sync] 云端读取失败：', error && error.message);
      return null;
    }
    return data && data.templates ? data.templates : null;
  } catch (e) {
    console.error('[bidding-template-sync] 云端读取异常：', e && e.message);
    return null;
  }
}
