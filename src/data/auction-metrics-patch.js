// auction-metrics-patch.js — 竞价行情行的「按日补写」唯一入口（Data 层）
//
// 【为什么单独开一个模块，不复用别处的写路径】
//   bidding-data.js / hot-stocks-cloud.js 里都有 from('market_metrics') 的写操作，但那是各自
//   场景（竞价板保存、热门股同步）的专用逻辑，语义完全不同。这里只做一件事：
//   **按 (date, stock, scope) 把「竞价四要素」upsert 进库，且只 upsert、绝不 delete。**
//
// 【§11 删除安全】本模块没有任何 delete / truncate。唯一键 `date,stock,scope` 与
//   worker（workers/bidding-auto-fetch/data/supabase-write.js:90 `?on_conflict=date,stock,scope`）
//   完全一致 ⇒ 明天 worker 正常跑时会按同一键覆盖，临时补的数据不会变成"幽灵行"。
//
// 【§10 读取失败 ≠ 空数据】三个读函数失败一律 throw，绝不 return []。
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 竞价行在 market_metrics 里的 scope 值（与 worker / 全站看板同一常量口径） */
export const AUCTION_SCOPE = 'auction';

/** 每批 upsert 行数（Supabase 单请求体量控制，100 行 ≈ 20KB，远低于上限） */
const UPSERT_CHUNK = 100;

/**
 * 读某日的正式名单（auction_watchlist）—— 补数时用来确定"今天应该有哪些票"。
 * @param {string} date
 * @returns {Promise<Array<{stock:string,code:string}>>}
 * @throws 读失败（§10）
 */
export async function readAuctionRoster(date) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('auction_watchlist')
    .select('stock,code')
    .eq('date', date);
  if (error) throw error;
  return data || [];
}

/**
 * 读某日已有的竞价行（market_metrics scope=auction）—— 用来判断"哪些字段还是空的"。
 * @param {string} date
 * @returns {Promise<Array<object>>}
 * @throws 读失败（§10）
 */
export async function readAuctionMetrics(date) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('market_metrics')
    .select('stock,code,volume,yest_volume,change_pct,auc_pct_chg,auc_vol_ratio,auc_turnover')
    .eq('date', date)
    .eq('scope', AUCTION_SCOPE);
  if (error) throw error;
  return data || [];
}

/**
 * 批量 upsert 竞价行（唯一键 date,stock,scope）。
 *
 * ⚠️ 调用方必须自己保证「只提交需要写的字段」——本函数不判断"该不该覆盖"，
 *    它只负责把给到的行合并进去（缺失字段用 PostgreSQL 的 merge-duplicates 语义保留原值）。
 *
 * @param {Array<object>} rows 每行必须含 date / stock / scope
 * @returns {Promise<number>} 实际提交的行数
 * @throws 任一批失败（§10：不许静默失败）
 */
export async function upsertAuctionMetrics(rows) {
  const list = Array.isArray(rows) ? rows.filter(function(r) { return r && r.date && r.stock; }) : [];
  if (list.length === 0) return 0;
  const sb = getSupabase();
  let written = 0;
  for (let i = 0; i < list.length; i += UPSERT_CHUNK) {
    const chunk = list.slice(i, i + UPSERT_CHUNK);
    const { error } = await sb
      .from('market_metrics')
      .upsert(chunk, { onConflict: 'date,stock,scope' });
    if (error) {
      // §10：写失败必须让上层知道（不能"看起来补好了"）
      _dbgLog('[METRICS-PATCH] upsert 第 ' + (Math.floor(i / UPSERT_CHUNK) + 1) + ' 批失败: ' + error.message);
      throw error;
    }
    written += chunk.length;
  }
  return written;
}
