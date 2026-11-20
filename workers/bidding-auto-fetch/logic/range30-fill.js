// range30-fill.js — 北京 09:26 / 09:27 / 16:03 云端补「当天名单」的 30 日涨幅
//
// ============================================================================
// [R30-CLOUD 2026-11-20 用户报障] 「30 日涨幅 toggle 有些股票后面的数值没有显示，空的」
// ----------------------------------------------------------------------------
// 生产取证（不是渲染 bug，是**数据供给缺口**）：
//   30 日涨幅原来只由 GitHub Actions `compute-range30-pct.mjs` 写。它的定时并不可靠：
//     cron 配的是北京 09:28 / 16:45 / 18:30，实测跑在 **北京 01:43 / 03:07 / 02:59**，
//     而且经常丢 —— 11-20 当天那三趟【一趟都没跑】。
//   凌晨那几趟跑的时候，当天的 `auction_watchlist` 还没生成（9:25 才写）⇒ 日志原文
//     「候选池 2026-09-17~2026-11-20（近 40 个交易日名单）」+「交易日历最新 2026-11-19」
//   ⇒ 候选池退化成「历史名单」，**当天首次出现的票整天没有 30 日涨幅**。
//   11-20 实测：京蓝科技 / 华升股份 / 格林达 / 江化微 / 海立股份 5 只全空，其余 492 行有值。
//   而这 5 只在同花顺批量日线里**都能拿到 42 根 bar**（含 11-20）⇒ 上游没问题，是漏算。
//
// 分工（⛔ 别让两边重复算同一批票，也别把 Worker 的 50 次 subrequest 配额顶爆）：
//   · 本模块 = **当天名单 ∪ 当天行情**里的票（实测 33 只 ⇒ 同花顺批量 4 次请求）；
//     ⇒ 专治「今天新冒出来的票」。
//   · Actions `compute-range30-pct.mjs` = 近 40 个交易日宽池（约 500 只），
//     ⇒ 专治「30天/20天补位、龙头组」这些**不在当天名单**的注入行。
//   两边都是幂等 upsert（主键 date,stock,leg），重叠部分算出同一个值。
//
// 口径（⛔ 不在这里另写公式，import `src/logic/auction/range30-math.js`）：
//   · 30 日涨幅 = 期末收盘 / 期初前收盘 − 1（一次性比值，与逐日连乘数学等价）；
//   · 停牌等价：取「≤ 目标日的最后一根 bar」；次新 / 腿数 < 10 一律判不出（§10 不补 0）。
//
// 两个时点两种窗口（与 Actions 的 09:28 / 16:45 完全同口径）：
//   · 开盘前（9:26 / 9:27）：end = **昨天**收盘 ⇒ 写「截至昨收」，前端反解竞价口径即可用；
//   · 收盘后（16:03）：end = **今天**收盘 ⇒ 覆盖成当天真实收盘口径。
//
// §10 读取失败立即停、不写；§11 只 upsert 本轮真算出来的行，算不出绝不写空。
// ============================================================================
import { beijingNow, beijingToday } from '../../_shared-source/date-utils.js';
import {
  windowFromTradingDays,
  range30InWindow,
  RANGE30_WINDOW_DAYS,
} from '../../../src/logic/auction/range30-math.js';
import {
  readAuctionWatchlistForDate,
  readMarketMetricsForDate,
  readRange30StocksForDate,
  readRecentTradeDates,
  upsertRange30Rows,
} from '../data/supabase-write.js';
import { fetchFuyaoBatchBars } from '../data/fuyao-api.js';
import { CONFIG } from '../config.js';

/** 拉日线时向前多留的自然日（要拿到 baseDate 那根 bar，长假也够） */
const R30_BAR_BUFFER_DAYS = 20;

/** 单趟最多补多少只（33 只 = 4 批；上限只是防止有人传进来几百只把配额打穿） */
const R30_MAX_STOCKS = 80;

// ⚠️ 单文件打包共作用域 ⇒ 顶层名必须全局唯一（_bundle.mjs 会体检拦截）
function r30ShiftDays(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}

/** 北京 15:00 后 = 当天已有收盘价（允许把 today 当窗口末日） */
function r30IsAfterClose(nowBj) {
  return nowBj.getUTCHours() > 15 || (nowBj.getUTCHours() === 15 && nowBj.getUTCMinutes() >= 5);
}

/**
 * 云端补「当天名单」的 30 日涨幅。
 *
 * @param {object} env
 * @param {{date?:string, overwrite?:boolean, endAtDate?:boolean, logs?:string[], maxStocks?:number}} opts
 *   - date      目标日（默认北京今天）
 *   - overwrite true = 重算并覆盖当天已有行（16:03 收盘口径必须开；09:26 必须关）
 *   - endAtDate true = 窗口末日取 date 当天（收盘后）；false = 取 date 之前最后一个交易日（开盘前）
 * @returns {Promise<{ok:boolean,date:string,leg:string,targets:number,covered:number,need:number,
 *   computed:number,written:number,noBars:number,failed:number,skipped:string,error:string,logs:string[]}>}
 */
export async function runRange30Fill(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const date = o.date || beijingToday();
  const endAtDate = o.endAtDate === undefined ? r30IsAfterClose(beijingNow()) : !!o.endAtDate;
  const out = {
    ok: false, date: date, leg: 'close', targets: 0, covered: 0, need: 0,
    computed: 0, written: 0, noBars: 0, failed: 0, skipped: '', error: '', logs: logs
  };

  // ① 当天名单 + 当天行情（code 的真值在这两处）
  let wl, metrics;
  try {
    wl = await readAuctionWatchlistForDate(env, date);
    metrics = await readMarketMetricsForDate(env, date, 'auction');
  } catch (e) {
    out.error = '读取当日名单/行情失败: ' + ((e && e.message) || e);
    logs.push('[r30-fill] ❌ ' + out.error);
    return out;
  }
  const codeByStock = new Map();
  metrics.forEach(function (r) {
    if (!r || !r.name) return;
    const c = String(r.code || '').replace(/\D/g, '');
    if (c.length === 6) codeByStock.set(r.name, c);
  });
  const targets = Array.from(new Set(
    wl.map(r => r.name).concat(metrics.map(r => r.name)).filter(Boolean)
  ));
  out.targets = targets.length;
  if (targets.length === 0) {
    out.skipped = '当日名单与行情都为空 ⇒ 不写（§10 不把「读不到」当成「没有票」）';
    logs.push('[r30-fill] ⚠️ ' + out.skipped);
    return out;
  }

  // ② 已有行（09:26 一律不覆盖；16:03 才允许重算覆盖）
  let have = new Set();
  try {
    have = await readRange30StocksForDate(env, date);
  } catch (e) {
    out.error = '读取 stock_range30_pct 失败: ' + ((e && e.message) || e);
    logs.push('[r30-fill] ❌ ' + out.error);
    return out;
  }
  targets.forEach(function (s) { if (have.has(s)) out.covered++; });
  const need = o.overwrite ? targets.slice() : targets.filter(function (s) { return !have.has(s); });
  out.need = need.length;
  if (need.length === 0) {
    out.ok = true;
    out.skipped = '当天 ' + targets.length + ' 只云端已全覆盖 ⇒ 0 写入';
    logs.push('[r30-fill] ✅ ' + out.skipped);
    return out;
  }

  // ③ 交易日历（market_metrics 的日期是真值；⛔ 不用 auction_watchlist.date）
  //   要 30 个交易日窗口 + 1 个基准日 ⇒ 至少 31 天；多取 2 天留余量。
  let cal;
  try {
    cal = await readRecentTradeDates(env, date, RANGE30_WINDOW_DAYS + 2);
  } catch (e) {
    out.error = '读取交易日序列失败: ' + ((e && e.message) || e);
    logs.push('[r30-fill] ❌ ' + out.error);
    return out;
  }
  const calUse = endAtDate ? cal.concat([date]) : cal;
  const win = windowFromTradingDays(calUse, date, RANGE30_WINDOW_DAYS);
  if (!win || !win.baseDate) {
    out.ok = true;
    out.skipped = '交易日序列仅 ' + cal.length + ' 天，构造不出 30 日窗口 ⇒ 本趟不写';
    logs.push('[r30-fill] ⚠️ ' + out.skipped);
    return out;
  }

  // ④ 批量取日线（10 只/批）→ 逐只套用同一份纯函数
  const limited = need.slice(0, Math.max(1, Number(o.maxStocks) || R30_MAX_STOCKS));
  const codes = [];
  const noCode = [];
  limited.forEach(function (s) {
    const c = codeByStock.get(s) || '';
    if (/^\d{6}$/.test(c)) codes.push(c); else noCode.push(s);
  });
  if (codes.length === 0) {
    out.ok = true;
    out.skipped = '待补 ' + limited.length + ' 只全部没有 6 位代码 ⇒ 无法取日线';
    logs.push('[r30-fill] ⚠️ ' + out.skipped);
    return out;
  }
  let bars;
  try {
    bars = await fetchFuyaoBatchBars(
      env, codes,
      r30ShiftDays(win.start, -R30_BAR_BUFFER_DAYS),
      win.end
    );
  } catch (e) {
    out.error = '批量日线失败: ' + ((e && e.message) || e);
    logs.push('[r30-fill] ❌ ' + out.error);
    return out;
  }

  const nowIso = new Date().toISOString();
  const rows = [];
  let noBars = 0, undecidable = 0;
  limited.forEach(function (s) {
    const c = codeByStock.get(s) || '';
    if (!/^\d{6}$/.test(c)) { out.failed++; return; }
    const b = bars.get(c);
    if (!b || b.length === 0) { noBars++; return; }
    const got = range30InWindow(b, win, {});
    if (!got) { undecidable++; return; }
    rows.push({
      date: date,
      stock: s,
      pct: got.pct.toFixed(2),
      days: got.days,
      leg: 'close',
      updated_at: nowIso
    });
  });
  out.noBars = noBars;
  if (rows.length === 0) {
    out.ok = true;
    out.skipped = '待补 ' + limited.length + ' 只：无日线 ' + noBars + ' / 判不出 ' + undecidable +
      '/ 无代码 ' + noCode.length + ' ⇒ 一只都不写（§10 宁缺勿错）';
    logs.push('[r30-fill] ⚠️ ' + out.skipped);
    return out;
  }

  // ⑤ 一次分桶 upsert（键集一致，⛔ 不会 PGRST102）
  try {
    await upsertRange30Rows(env, rows);
  } catch (e) {
    out.error = 'stock_range30_pct 写入失败: ' + ((e && e.message) || e);
    logs.push('[r30-fill] ❌ ' + out.error);
    return out;
  }
  out.computed = rows.length;
  out.written = rows.length;
  out.ok = true;
  logs.push('[r30-fill] ✅ ' + date + ' 云端补 30 日涨幅 ' + rows.length + ' 行（窗口 ' +
    win.start + '~' + win.end + '，基准 ' + win.baseDate +
    '；目标 ' + out.targets + ' 已有 ' + out.covered + ' 待补 ' + out.need +
    ' 取价 ' + bars.size + '/' + codes.length + ' 只' +
    (noBars ? ' 无日线 ' + noBars : '') + (undecidable ? ' 判不出 ' + undecidable : '') +
    '；' + (o.overwrite ? '覆盖模式' : '只填空') + '）');
  return out;
}
