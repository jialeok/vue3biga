// daily-legs-heal.js — 云端逐日腿补齐（替代本机 08:00 的 WorkBuddy 定时任务）
//
// ============================================================================
// [DAILY-LEGS-CLOUD 2026-11-06 用户口径] 「本机的那些一律迁移到云端」「换掉电脑就出问题」
// ----------------------------------------------------------------------------
// 为什么之前必须靠电脑：Supabase Edge `healDailyLegsFromMetrics` 的闸③ 要求
//   `market_metrics.updated_by` 含 'close' 且 `updated_at >= 当日 15:00`。
//   2026-11-06 生产实测：11-04 是 8/87 行、11-05 是 8/86 行满足（其余都是 9:25 写入的
//   `auto-fetch-worker`，收盘覆盖只补写了少数票）⇒ 云端 heal 每天最多补 8 根腿。
//   剩下 80 根全靠本机脚本 `db/scripts/backfill-daily-pct.mjs --recent`（工作日 08:00）
//   用另一条更准的判据补上 —— 换电脑 / 关机就断，用户看到「20 日涨幅又不全」。
//
// 本模块把本机那条判据原样搬到 Cloudflare Worker（wrangler CI 自动部署，⛔ 不用手工粘贴 Edge）：
//   ★ 收盘覆盖判据：`change_pct !== auc_pct_chg`（差 ≥0.011）才认这根是【收盘腿】。
//     两者相等 ⇒ 还停在 9:25 竞价副本，拿它当收盘腿会让整条 20 日复利静默算错。
//     本机脚本用腾讯前复权日线逐条比对 426 条：通过 383 条里 382 条完全一致（99.7%），
//     被拒的 43 条只有 62.8% 碰巧正确 ⇒ 拒掉是对的（见 backfill-daily-pct.mjs 注释）。
//   ⚠️ 代价：收盘价恰好等于竞价值的票会被误拒（假阴性）—— 宁可少补一根，⛔ 不接受错值。
//
// 时点：
//   · 16:00 close 之后跑 ⇒ 允许写【今天】这根腿（收盘已覆盖），明天 9:26 的 20 日涨幅快路径才齐；
//   · 09:26 ladder26 里再跑一次 ⇒ 只补【今天之前】漏掉的日期，兜住「昨天 16:00 没跑成」；
//   · 两个时点都幂等：只写 `stock_daily_pct` 里不存在的 (date,stock)，⛔ 从不覆盖已有腿。
//
// 【成本】0 个上游请求、0 猫抓额度；只有 Supabase REST 读写。
// 【数据安全】§10 任一步读取失败立即停、不写；§11 纯新增，不删不改。
// ============================================================================
import { beijingNow, beijingToday } from '../../_shared-source/date-utils.js';
import {
  readMetricsLegsWindow,
  readDailyPctStocksForDate,
  upsertDailyPctRows
} from '../data/supabase-write.js';

/** 回看自然日（覆盖周末 + 小长假；与 Edge HEAL_LOOKBACK_DAYS=8 同量级，略放宽） */
export const DAILY_LEGS_LOOKBACK_DAYS = 12;

/** 与本机脚本 numPct 完全一致：'%'/'+' 剥掉，缺失 ⇒ null（⛔ 绝不返回 0） */
export function numPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', '').replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 纯函数：从 market_metrics 窗口挑出「可写的收盘腿」。
 * @param {Array} metricsRows [{stock,date,change_pct,auc_pct_chg}]
 * @param {Map<string,Set<string>>} existingByDate 每个日期已有的股票名
 * @param {string} today YYYY-MM-DD
 * @param {boolean} allowToday 是否允许写今天（只有 15:05 收盘后为 true）
 * @returns {{rows:Array, scanned:number, rejected:number, todaySkipped:number, already:number}}
 */
export function pickCloudDailyLegs(metricsRows, existingByDate, today, allowToday, nowIso) {
  const rows = [];
  let scanned = 0, rejected = 0, todaySkipped = 0, already = 0;
  (metricsRows || []).forEach(function (r) {
    if (!r) return;
    scanned++;
    const stock = String(r.stock || '').trim();
    const d = String(r.date || '').slice(0, 10);
    if (!stock || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (d > today) return;
    if (d === today && !allowToday) { todaySkipped++; return; }
    const c = numPct(r.change_pct);
    if (c === null) return;                          // §10 缺值不写，⛔ 不当 0%
    const a = numPct(r.auc_pct_chg);
    if (a !== null && Math.abs(c - a) < 0.011) { rejected++; return; }  // 还停在竞价副本
    const set = existingByDate && existingByDate.get(d);
    if (set && set.has(stock)) { already++; return; }
    rows.push({
      date: d,
      stock: stock,
      pct: (c < 0 ? '' : '+') + c.toFixed(2),
      src: 'metrics_close',
      updated_at: nowIso || new Date().toISOString()
    });
  });
  return { rows: rows, scanned: scanned, rejected: rejected, todaySkipped: todaySkipped, already: already };
}

// ⚠️ 单文件打包共作用域 ⇒ 顶层名必须全局唯一（与 range20-prefill.js 的 r20ShiftDays 区分）
function dailyLegsShiftDays(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}

/** 北京 15:05 之后才允许把「今天」当收盘腿（与 Edge legFinal / healOnly 同源） */
export function isAfterClose(nowBj) {
  return nowBj.getUTCHours() > 15 ||
    (nowBj.getUTCHours() === 15 && nowBj.getUTCMinutes() >= 5);
}

/**
 * 云端补齐主入口。
 * @returns {Promise<{ok:boolean,today:string,allowToday:boolean,scanned:number,written:number,rejected:number,already:number,error:string,logs:string[]}>}
 */
export async function runDailyLegsHeal(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const allowToday = o.allowToday === undefined ? isAfterClose(beijingNow()) : !!o.allowToday;
  const out = {
    ok: false, today: today, allowToday: allowToday, scanned: 0, written: 0,
    rejected: 0, already: 0, error: '', logs: logs
  };
  const from = dailyLegsShiftDays(today, -DAILY_LEGS_LOOKBACK_DAYS);

  let metrics;
  try {
    metrics = await readMetricsLegsWindow(env, from, today);
  } catch (e) {
    out.error = '读取 market_metrics 窗口失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[daily-legs] ❌ ' + out.error);
    return out;
  }
  out.scanned = metrics.length;
  const dates = Array.from(new Set(metrics
    .map(r => String((r && r.date) || '').slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today)))
    .sort();

  // 只查真正可能出现的日期，⛔ 不扫空日子（§32）
  const existingByDate = new Map();
  for (let i = 0; i < dates.length; i++) {
    try {
      existingByDate.set(dates[i], await readDailyPctStocksForDate(env, dates[i]));
    } catch (e) {
      out.error = '读取 ' + dates[i] + ' 已有腿失败 → 停止补写（§10）: ' +
        (e && e.message ? e.message : String(e));
      logs.push('[daily-legs] ❌ ' + out.error);
      return out;
    }
  }

  const picked = pickCloudDailyLegs(metrics, existingByDate, today, allowToday);
  out.rejected = picked.rejected;
  out.already = picked.already;
  if (picked.rows.length === 0) {
    out.ok = true;
    logs.push('[daily-legs] ✅ 窗口 ' + from + '~' + today + ' 已齐（扫描 ' + out.scanned +
      ' 行 / 已有 ' + out.already + ' / 竞价未覆盖拒 ' + out.rejected +
      ' / 盘中跳过 ' + picked.todaySkipped + '）⇒ 0 写入');
    return out;
  }
  try {
    await upsertDailyPctRows(env, picked.rows);
  } catch (e) {
    out.error = 'stock_daily_pct 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[daily-legs] ❌ ' + out.error);
    return out;
  }
  out.written = picked.rows.length;
  out.ok = true;
  logs.push('[daily-legs] ✅ 云端补齐逐日腿 ' + out.written + ' 行（窗口 ' + from + '~' + today +
    '，扫描 ' + out.scanned + ' / 已有 ' + out.already + ' / 竞价未覆盖拒 ' + out.rejected +
    '，src=metrics_close，0 上游请求）');
  return out;
}
