// market-metrics.js — market_metrics 表读写（Data 层，§5 唯一数据访问入口）
//
// 该表是「市场指标 / 影子数据」的唯一落库表（早盘竞价 scope='auction' 与热门股票 scope='hot' 共用，
// 主键 (date, stock, scope)）。此前前端只有「读」的通道（pullAuctionFromTable 里 select），
// 所有写都由 worker / Edge Function 完成；收盘涨幅覆盖只能靠 pg_cron（从未真正生效，
// 见 db/supabase_auction_close_cron.sql），导致当天 change_pct 长期停留在 9:25 竞价涨幅。
// 这里补齐 Data 层的读写能力，供 Logic 层「收盘涨幅自动覆盖」闭环使用（§2 依赖方向：Logic → Data）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { createQueryMemo } from './query-memo.js';
// ★ [KEYSET-BUCKET 2026-11-05] 批量 upsert 必须按字段集分桶（见 upsert-buckets.js 的事故记录）
import { planUpsertBatches } from './upsert-buckets.js';

const TABLE = 'market_metrics';
const PAGE = 1000;

// ── §32 不重复请求：同一 (date, scope) 的并发读取合并 + 极短缓存 ──────────────────
//
// 【为什么必须加 2026-10-26】
//   首屏实测（CDP 抓真实网络）：同一个
//     market_metrics?select=stock,code,change_pct,auc_pct_chg,...&date=eq.2026-10-26&scope=eq.auction
//   在打开应用时被发了【5 次】—— 决策看板 / 题材量比 / 竞价看板各自在 mount 时调本函数
//   （§32 红线：禁止同一页面的多个组件分别请求同一业务数据）。
//   而这一整张表在首屏前 3 秒内被发了 12 个网络事件（6 个真实查询 + 6 个 CORS 预检），
//   才是「打开要等很久」的真实原因（数据量本身只有 1.8 MB）。
//
// 【实现】统一走 data/query-memo.js（§6：同一件事只允许一份实现）。
//   ⛔ 任何写入都立刻 bust 对应 key（见 upsertMarketMetricsRows），绝不出现「写完还读旧值」。
const _memo = createQueryMemo({ name: 'market_metrics', ttlMs: 1500 });

function _key(date, scope) { return date + '|' + scope; }

/** 仅供测试 / 诊断：清空单飞与缓存 */
export function _resetMarketMetricsMemo() {
  _memo.reset();
}

/**
 * 读取某日某 scope 的全部指标行。
 * ⚠️ §10 红线：读取失败必须抛错，绝不能返回空数组冒充「没有数据」。
 * ⚠️ 返回值可能与其它调用者共享同一数组引用（单飞/缓存的必然结果）——调用方**只读**，不得原地修改。
 * @param {string} date - YYYY-MM-DD
 * @param {string} [scope] - 'auction' | 'hot'，默认 'auction'
 * @returns {Promise<Array<{stock:string, code:string, change_pct:string, auc_pct_chg:string, updated_at:string}>>}
 */
export async function readMarketMetricsForDate(date, scope) {
  const sc = scope || 'auction';
  if (!date) throw new Error('readMarketMetricsForDate 缺少 date');
  return _memo.run(_key(date, sc), async function() {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase 客户端未初始化，无法读取 market_metrics');
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
  });
}

/**
 * 写入/更新指标行（upsert，主键 date+stock+scope）。
 *
 * 🔴 [KEYSET-BUCKET 2026-11-05] 这里原来写着「未提供的列保持原值（Supabase upsert 语义）」——
 *    **那句是错的**。批量 upsert 是一条 INSERT ... ON CONFLICT DO UPDATE，列清单取整批的并集，
 *    某行没写某列 ⇒ 该行在 VALUES 里是 NULL ⇒ `SET col = EXCLUDED.col` 把库里正确的值抹成 NULL。
 *    真实后果见 `data/upsert-buckets.js` 顶部事故记录（竞价量 321 → NULL）。
 *    现在统一走 `planUpsertBatches`：按字段集分桶，桶内字段全一致，不存在 NULL 填空。
 *
 * 调用方仍可「只提交需要写的字段」（例如收盘覆盖只传 change_pct + updated_*），
 * 前提是**别显式写成空值** —— 那是「明确要清空」的语义。
 *
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
  const batches = planUpsertBatches(list, BATCH);
  for (let i = 0; i < batches.length; i++) {
    const chunk = batches[i];
    const { error } = await sb
      .from(TABLE)
      .upsert(chunk, { onConflict: 'date,stock,scope' });
    if (error) {
      _dbgLog('[MARKET-METRICS] upsert 失败：' + (error.message || error));
      throw new Error('写入 market_metrics 失败：' + (error.message || error));
    }
    written += chunk.length;
  }
  // §10：写完立刻作废相关短缓存，否则紧接着的读取会拿到旧值（那就是"保存了但显示没变"）
  const touched = new Set();
  list.forEach(function(r) { touched.add(_key(r.date, r.scope)); });
  touched.forEach(function(k) { _memo.bust(k); });
  return { written: written };
}
