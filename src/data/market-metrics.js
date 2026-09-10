// market-metrics.js — market_metrics 表读写（Data 层，§5 唯一数据访问入口）
//
// 该表是「市场指标 / 影子数据」的唯一落库表（早盘竞价 scope='auction' 与热门股票 scope='hot' 共用，
// 主键 (date, stock, scope)）。此前前端只有「读」的通道（pullAuctionFromTable 里 select），
// 所有写都由 worker / Edge Function 完成；收盘涨幅覆盖只能靠 pg_cron（从未真正生效，
// 见 db/supabase_auction_close_cron.sql），导致当天 change_pct 长期停留在 9:25 竞价涨幅。
// 这里补齐 Data 层的读写能力，供 Logic 层「收盘涨幅自动覆盖」闭环使用（§2 依赖方向：Logic → Data）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

const TABLE = 'market_metrics';
const PAGE = 1000;

/**
 * 读取某日某 scope 的全部指标行。
 * ⚠️ §10 红线：读取失败必须抛错，绝不能返回空数组冒充「没有数据」。
 * @param {string} date - YYYY-MM-DD
 * @param {string} [scope] - 'auction' | 'hot'，默认 'auction'
 * @returns {Promise<Array<{stock:string, code:string, change_pct:string, auc_pct_chg:string, updated_at:string}>>}
 */
export async function readMarketMetricsForDate(date, scope) {
  const sc = scope || 'auction';
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 客户端未初始化，无法读取 market_metrics');
  if (!date) throw new Error('readMarketMetricsForDate 缺少 date');

  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(TABLE)
      .select('stock,code,change_pct,auc_pct_chg,updated_at,updated_by')
      .eq('date', date)
      .eq('scope', sc)
      .range(from, from + PAGE - 1);
    if (error) throw new Error('读取 market_metrics 失败：' + (error.message || error));
    const rows = data || [];
    out.push.apply(out, rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * 写入/更新指标行（upsert，主键 date+stock+scope）。
 * ⚠️ 只更新调用方显式提供的列，未提供的列保持原值（Supabase upsert 语义），
 *    因此「收盘覆盖」只传 change_pct + updated_* 不会抹掉 volume / auc_pct_chg 等竞价字段。
 * @param {Array<object>} rows - 至少含 date / stock / scope
 * @returns {Promise<{written:number}>}
 */
export async function upsertMarketMetricsRows(rows) {
  const list = Array.isArray(rows) ? rows.filter(function(r) { return r && r.date && r.stock; }) : [];
  if (list.length === 0) return { written: 0 };
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 客户端未初始化，无法写入 market_metrics');

  list.forEach(function(r) { if (!r.scope) r.scope = 'auction'; });
  // 分批：单批过大容易被网关截断（与 auction-sync-push 同款对策）
  const BATCH = 200;
  let written = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const { error } = await sb
      .from(TABLE)
      .upsert(chunk, { onConflict: 'date,stock,scope' });
    if (error) {
      _dbgLog('[MARKET-METRICS] upsert 失败：' + (error.message || error));
      throw new Error('写入 market_metrics 失败：' + (error.message || error));
    }
    written += chunk.length;
  }
  return { written: written };
}
