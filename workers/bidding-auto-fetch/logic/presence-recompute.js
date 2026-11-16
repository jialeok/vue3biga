// presence-recompute.js — 云端触发「十日涨幅 · 在列次数」预计算（第二十九条的必需输入）
//
// ★★ [PRESENCE-0926 2026-11-16 用户报障「每到收盘又变了」· 根因修复]
//
//   现场（真实时间戳，不是推测）：
//     · 09:25  `bidding_fetch_log(morning)`：猫抓返回 350 行【含 auc_vol_ratio】，
//              market_metrics 写 70 行 ⇒ 竞价量比在 09:25 就是齐的
//     · 09:27  `snapshot` 定稿（created_at 01:27:30Z）
//     · 但第二十九条要用的 `auction_presence`（某票在最近 10 个交易日名单里出现过几天）
//       由 pg_cron `auction-presence-open` 在**北京 09:30** 才生成 —— 比定稿晚 3 分钟
//     ⇒ `tvrb-plan.js#r10DataReady` 要求 `range10Presence.counts && coveredDays > 0`
//     ⇒ 09:27 恒 false ⇒「排名第二的题材量比太小 ⇒ 整块作废」每天都被 §10 放行
//     ⇒ 早上按「放行」定稿（多一个题材、多几只票），等表到货后页面一重算就翻脸
//       （11-16：3 只 → 1 只；revison 1 → 2 就是 16:27 那次重算）
//
//   ⇒ 修法：**由本 Worker 在 09:26（ladder26 那一趟）直接调 RPC 算一遍**，
//     把这张派生表的到货时间从 09:30 拉到 09:26，赶在 09:27 定稿之前。
//     pg_cron 那条仍保留（兜底），两边都是同一个库内函数，幂等（先删后插）。
//
//   ⚠️ 为什么放在 ladder26 而不是 snapshot：
//     ladder26 = 09:26，名单已最终落库（09:25:28），有整整一分钟余量；
//     snapshot = 09:27 本身就是定稿时刻，P0 时间线更紧，不宜再塞一次计算。
//
//   ⚠️ 本函数只读 `auction_watchlist` + 交易日表，**纯库内计算**：
//     零上游请求、零猫抓额度、不碰同花顺（不会 429）。
//
//   §10：失败【不阻断】本轮（这只是把派生表提前，正确性不依赖它）——
//   但必须如实打进 `bidding_fetch_log.detail.logs`，⛔ 不许静默吞掉。
import { sbHeaders } from '../data/supabase-write.js';
import { CONFIG } from '../config.js';

const RPC_TIMEOUT_MS = 8000;

/**
 * 触发一次 `recompute_auction_presence(p_date)`。
 *
 * @param {object} env Worker 环境（要 SUPABASE_URL / SUPABASE_ANON_KEY|SERVICE_ROLE_KEY）
 * @param {{date?:string, logs?:string[]}} opts date = YYYY-MM-DD（缺省由 RPC 侧自己算北京今天）
 * @returns {Promise<{ok:boolean, rows:number, date:string, logs:string[]}>}
 *          rows = 函数返回的写入行数（PostgREST 直接回整数）
 */
export async function runPresenceRecompute(env, opts) {
  const o = opts || {};
  const logs = Array.isArray(o.logs) ? o.logs : [];
  const date = String(o.date || '').trim();
  const base = String((env && env.SUPABASE_URL) || CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    logs.push('[presence] ⚠️ 缺 SUPABASE_URL ⇒ 跳过（在列次数仍由 pg_cron 09:26 兜底）');
    return { ok: false, rows: 0, date: date, logs: logs };
  }
  const body = date ? { p_date: date } : { p_date: null };
  const ctrl = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(RPC_TIMEOUT_MS) : undefined;
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/rest/v1/rpc/recompute_auction_presence', {
      method: 'POST',
      headers: sbHeaders(env || {}),
      body: JSON.stringify(body),
      signal: ctrl
    });
    const txt = await r.text();
    if (!r.ok) {
      logs.push('[presence] ⚠️ RPC ' + r.status + ' ' + txt.slice(0, 160) +
        ' ⇒ 本轮跳过（不阻断；pg_cron 09:26 仍会兜底）');
      return { ok: false, rows: 0, date: date, logs: logs };
    }
    const n = Number(String(txt || '').trim());
    const rows = isFinite(n) ? n : 0;
    logs.push('[presence] ✅ 在列次数（10/20 日窗口）云端重算完成：' + rows + ' 行，耗时 ' +
      (Date.now() - t0) + 'ms' + (date ? '（date=' + date + '）' : '') +
      '｜这是第二十九条的必需输入，必须在 09:27 定稿前就位');
    return { ok: true, rows: rows, date: date, logs: logs };
  } catch (e) {
    logs.push('[presence] ⚠️ RPC 异常: ' + ((e && e.message) || String(e)) +
      ' ⇒ 本轮跳过（不阻断；pg_cron 09:26 仍会兜底）');
    return { ok: false, rows: 0, date: date, logs: logs };
  }
}
