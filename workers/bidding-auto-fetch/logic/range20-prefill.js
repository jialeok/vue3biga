// range20-prefill.js — 北京 09:26 云端「20 日涨幅」补缺（0 上游 / 0 猫抓额度）
//
// ============================================================================
// [R20-CLOUD 2026-11-06 用户口径] 「老问题也要修好」「全部改用云端的」
// ----------------------------------------------------------------------------
// 根因（不是逻辑错，是**抢跑**）：
//   Supabase pg_cron `range20-auc-precompute` 与 Cloudflare worker 都在北京 09:25:00 起跑。
//   Edge 的快路径要用 `market_metrics.auc_pct_chg` 当 T 腿，可 worker 到 01:25:10Z
//   （09:25:10）才把竞价涨幅写进库 ⇒ Edge 09:25:0x 读到的 T 腿是空的 ⇒ 快路径 0 行，
//   剩下的 K 线主循环又常常吃满 190s 预算 ⇒ 当天 `stock_range20_pct` 整表 0 行。
//   于是只能靠浏览器打开看板时 `prefillRange20FromDailyLegs` 现算写库 ——
//   用户「换台电脑就出问题」的观感就是这么来的。
//
// 修法（本文件）：把「用逐日腿补缺」这一步挪到 **09:26 的 worker cron**（ladder26 同一趟）。
//   此时 worker 的 P0 已落库完（T 腿有了），且它比 Edge 的 K 线重算便宜得多：
//     · 只读 3 张 Supabase 表 + 写 1 张，**0 个 K 线 / 腾讯 / 同花顺 / 猫抓请求**；
//     · 只补「当天还没有行」的票，已有值一律不覆盖（§6/§11 纯加法、幂等）；
//     · 腿不够 19 根一律不写（§10 宁缺勿错，绝不拿半截复利当 20 日涨幅）。
//
// 单一真相：复利口径复用前端/Edge 同源的 `range-window.js#parsePct / compoundPct`，
//   与 `db/edge/range20-precompute/index.ts#rangeFromLegs` 逐字等价（19 根历史腿 + 1 根 T 腿）。
//   ⛔ 不在这里另写一份计算公式。
//
// 部署：worker 由 .github/workflows/deploy-worker.yml 自动 wrangler deploy，
//   ⛔ 不需要用户在 Supabase Dashboard 手工重贴 Edge Function（这是选 worker 而不是 Edge 的原因）。
// ============================================================================
import { beijingNow, beijingToday } from '../../_shared-source/date-utils.js';
import {
  parsePct,
  compoundPct,
  RANGE20_MIN_TARGETS,
  isRange20TargetListReady
} from '../../../src/logic/auction/range-window.js';
import {
  readAuctionWatchlistForDate,
  readMarketMetricsForDate,
  readRange20StocksForDate,
  readDailyLegsForStocks,
  upsertRange20Rows,
} from '../data/supabase-write.js';

/** 与 Edge WINDOW_DAYS-1 完全一致：19 根历史腿 + 1 根 T 腿 = 20 日 */
export const RANGE20_LEG_DAYS = 19;

/** 腿表回看窗口（自然日）：足够跨过春节/国庆凑满 19 个交易日，与 Edge shiftYmd(-60) 一致 */
export const RANGE20_LOOKBACK_DAYS = 60;

// [CLOUD-0927-HEAL 2026-11-11 §11] 名单完整性下限 RANGE20_MIN_TARGETS /
// isRange20TargetListReady 从 `src/logic/auction/range-window.js` 引入（前后端唯一一份常量）。
// 9:25 与 9:26 是两条独立 cron、没有锁；抢跑时读到的只是「刚写了几行」的半截名单。
// 半截名单不许补位：宁可这一趟 0 写入，把机会留给 9:27 那一轮（幂等重跑）。

/**
 * 纯函数：与 Edge `rangeFromLegs` 逐字等价。
 * @param {number[]} hist 升序的历史腿（% 数值）
 * @param {number} tLeg 目标日 T 腿（竞价口径 = auc_pct_chg；收盘口径 = change_pct）
 * @returns {{pct:string, days:number}|null}
 */
export function compoundRange20(hist, tLeg) {
  if (!Array.isArray(hist) || hist.length < RANGE20_LEG_DAYS) return null;
  if (!Number.isFinite(tLeg)) return null;
  const win = hist.slice(-RANGE20_LEG_DAYS);
  const v = compoundPct(win.concat([tLeg]));
  if (v === null || !isFinite(v)) return null;
  return { pct: v.toFixed(2), days: win.length + 1 };
}

/** 北京 15:00 前 = 竞价口径(auc)，之后 = 收盘口径(close)——与 Edge 选腿、前端 resolveT20LegMode 同源 */
export function legModeOf(nowBj) {
  return nowBj.getUTCHours() < 15 ? 'auc' : 'close';
}

/** 纯函数：把腿表扁平行按股票归集成升序数值腿（坏值跳过，不折 0） */
export function groupLegs(rows) {
  const byStock = new Map();
  (rows || []).forEach(function (r) {
    if (!r) return;
    const s = String(r.stock || '').trim();
    const d = String(r.date || '').slice(0, 10);
    const p = parsePct(r.pct);
    if (!s || !d || p === null) return;
    let arr = byStock.get(s);
    if (!arr) { arr = []; byStock.set(s, arr); }
    arr.push({ d: d, p: p });
  });
  const out = new Map();
  byStock.forEach(function (arr, s) {
    arr.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    out.set(s, arr.map(x => x.p));
  });
  return out;
}

/** 自然日回退（只用于拼腿表查询下界，不是交易日推算） */
// ⚠️ 单文件打包会把所有模块拼进同一作用域 ⇒ 顶层函数名必须全局唯一（_bundle.mjs 会体检拦截）
function r20ShiftDays(dateStr, delta) {
  const ms = Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 云端补缺主入口。
 * @returns {Promise<{ok:boolean,today:string,leg:string,targets:number,covered:number,need:number,written:number,shortLegs:number,noTLeg:number,skipped:string,error:string,logs:string[]}>}
 */
export async function runRange20Prefill(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const leg = o.leg || legModeOf(beijingNow());
  const out = {
    ok: false, today: today, leg: leg, targets: 0, covered: 0, need: 0,
    written: 0, shortLegs: 0, noTLeg: 0, skipped: '', error: '', logs: logs
  };

  // ① 今日名单（正式成员 + 观察组）与今日行情（T 腿）。§10：任一读取失败立即停，不写任何行。
  let wl, metrics;
  try {
    wl = await readAuctionWatchlistForDate(env, today);
    metrics = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    out.error = '读取当日名单/行情失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  // T 腿：竞价口径优先纯竞价涨幅；收盘口径用收盘涨幅。两者同源（9:25 时 change_pct 是竞价副本）。
  const tByStock = new Map();
  metrics.forEach(function (r) {
    if (!r || !r.name) return;
    const raw = leg === 'close' ? r.change_pct : (r.auc_pct_chg || r.change_pct);
    const p = parsePct(raw);
    if (p !== null) tByStock.set(r.name, p);
  });
  const targets = Array.from(new Set(
    wl.map(r => r.name).concat(metrics.map(r => r.name)).filter(Boolean)
  ));
  out.targets = targets.length;
  if (targets.length === 0) {
    out.skipped = '当日名单与行情都为空 ⇒ 不写（§10 不把「读不到」当成「没有票」）';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }
  // [CLOUD-0927-HEAL 2026-11-11 §11] 半截名单不许补位：9:27 会幂等重跑，⛔ 别把残缺榜定稿。
  if (!isRange20TargetListReady(targets)) {
    out.skipped = '当日名单/行情仅 ' + targets.length + ' 行（<' + RANGE20_MIN_TARGETS +
      '）⇒ 疑似 9:25 尚未落库完 / 9:26 抢跑，本趟 0 写入，交给 9:27 兜底';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ② 云端已有一律不碰（纯加法）。有任何 leg 的行都视作已覆盖，⛔ 不混口径覆盖。
  let have;
  try {
    have = await readRange20StocksForDate(env, today);
  } catch (e) {
    out.error = '读取 stock_range20_pct 失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  targets.forEach(function (s) { if (have.has(s)) out.covered++; });
  if (out.covered >= targets.length) {
    out.ok = true;
    out.skipped = '当天 ' + targets.length + ' 只票云端已全覆盖 ⇒ 0 写入';
    logs.push('[r20-prefill] ✅ ' + out.skipped);
    return out;
  }

  const need = targets.filter(function (s) {
    if (have.has(s)) return false;
    if (!tByStock.has(s)) { out.noTLeg++; return false; }
    return true;
  });
  out.need = need.length;
  if (need.length === 0) {
    out.ok = true;
    out.skipped = '缺 ' + (targets.length - out.covered) + ' 只但都没有 T 腿（竞价涨幅尚未落库）⇒ 一只都不写';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ③ 读历史腿（0 上游请求，按股票分批 in 过滤）
  let legRows;
  try {
    legRows = await readDailyLegsForStocks(
      env, r20ShiftDays(today, -RANGE20_LOOKBACK_DAYS), today, need
    );
  } catch (e) {
    out.error = '读取逐日腿失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  const legs = groupLegs(legRows);
  const nowIso = new Date().toISOString();
  const rows = [];
  need.forEach(function (s) {
    const hist = legs.get(s);
    if (!hist || hist.length < RANGE20_LEG_DAYS) { out.shortLegs++; return; }
    const r = compoundRange20(hist, tByStock.get(s));
    if (!r) { out.shortLegs++; return; }
    rows.push({
      date: today,
      stock: s,
      pct: r.pct,
      days: r.days,
      leg: leg,
      updated_at: nowIso
    });
  });
  if (rows.length === 0) {
    out.ok = true;
    out.skipped = '待补 ' + need.length + ' 只，但腿不足 ' + RANGE20_LEG_DAYS + ' 根的有 ' +
      out.shortLegs + ' 只 ⇒ 一只都不写（宁缺勿错）';
    logs.push('[r20-prefill] ⚠️ ' + out.skipped);
    return out;
  }

  // ④ 一次分桶 upsert（所有行键集相同，⛔ 不会 PGRST102）
  try {
    await upsertRange20Rows(env, rows);
  } catch (e) {
    out.error = 'stock_range20_pct 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[r20-prefill] ❌ ' + out.error);
    return out;
  }
  out.written = rows.length;
  out.ok = true;
  logs.push('[r20-prefill] ✅ ' + today + ' leg=' + leg + ' 云端补缺 ' + rows.length + ' 行' +
    '（目标 ' + out.targets + ' / 已有 ' + out.covered + ' / 缺T腿 ' + out.noTLeg +
    ' / 腿不足 ' + out.shortLegs + ' / 读腿 ' + legRows.length + ' 行；0 上游请求、0 猫抓额度）');
  // [CLOUD-0927-HEAL 2026-11-11] 覆盖度必须可观测：低于 80% 时前端买点闸门会拒绝定稿，
  //   若不在这里点名，事后只能靠猜「为什么当天没出票」。9:27 会再补一次。
  const finalCovered = out.covered + rows.length;
  const finalCoverage = finalCovered / out.targets;
  logs.push('[r20-prefill] 覆盖度 ' + finalCovered + '/' + out.targets +
    ' = ' + (finalCoverage * 100).toFixed(0) + '%' +
    (finalCoverage < 0.8 ? ' ⚠️ 未达 80% ⇒ 9:27 将再补一次；前端买点闸门暂不定稿' : ' ✅ 达标'));
  return out;
}
