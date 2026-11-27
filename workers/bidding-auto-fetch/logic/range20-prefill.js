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
  readRecentTradeDates,
  upsertDailyPctRows,
} from '../data/supabase-write.js';
import { fetchFuyaoBatchBars, barsToDailyPctMap } from '../data/fuyao-api.js';
import { CONFIG } from '../config.js';

/** 与 Edge WINDOW_DAYS-1 完全一致：19 根历史腿 + 1 根 T 腿 = 20 日 */
export const RANGE20_LEG_DAYS = 19;

/** [FILL-START-BAR] 批量日线起点要比窗口首日早这么多自然日，才能拿到首日涨幅的基准 bar */
export const R20_FILL_BAR_LEAD_DAYS = 20;

// ⚠️ 单文件打包共作用域 ⇒ 顶层名必须全局唯一（与 r20ShiftDays / r30ShiftDays 区分）
function r20FillShiftDays(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}

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

/**
 * ★★ [LEGS-FILL-CLOUD 2026-11-20 用户报障] 「20 日涨幅有些票是空的，历史日期也有很多」
 *
 * 根因（生产实测，不是渲染 bug）：
 *   `stock_daily_pct`（逐日腿缓存）**只覆盖「进过当天名单的票」**——
 *   `daily-legs-heal.js` 从 `market_metrics` 取票，而 market_metrics 只有名单里的票。
 *   于是**新面孔**（11-20 首次出现的京蓝科技 / 海立股份等）在腿表里只有 2~4 行，
 *   远不足 `RANGE20_LEG_DAYS = 19` ⇒ 本函数一直判 `shortLegs` 一律不写
 *   ⇒ 那只票的 20 日涨幅**永远是空白**（历史日同理：那天的新面孔全部缺）。
 *   对照：有值的票（上海电影 38 行 / 世龙实业 31 行 / 东方海洋 38 行）腿是齐的。
 *
 * 修法：腿不够就**在云端现补腿**，用同花顺批量前复权日线（10 只/批）把
 *   「19 个交易日里缺的那几根」写进 `stock_daily_pct`，再把 20 日涨幅算出来。
 *   · 只补窗口内**确实缺**的 (date,stock)，已有腿一根都不碰（§11 纯加法、幂等）；
 *   · `src='fuyao_kline'` 与云端 `metrics_close` / 本机 `metrics` 明确区分，事后可对账；
 *   · 前复权口径与 `compute-range30-pct.mjs` / 前端 K 线补算完全一致（§6）；
 *   · 分批 10 只 ⇒ 33 只只要 4 次 subrequest（⛔ 逐只打会顶爆 Cloudflare 50 次配额）。
 *   · §10：拿不到就不写（⛔ 绝不补 0、绝不伪造腿），留给下一次幂等重跑。
 *
 * @param {object} env
 * @param {{stocks:string[], tradeDates:string[], codeOf:Function, haveOf:Function,
 *          logs?:string[], budgetMs?:number}} opts
 * @returns {Promise<{ok:boolean, requested:number, fetched:number, written:number,
 *          skipped:string, error:string, rows:Array}>}
 */
export async function fillLegsFromKline(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const stocks = Array.from(new Set((o.stocks || []).map(s => String(s || '').trim()).filter(Boolean)));
  const tradeDates = (o.tradeDates || []).map(d => String(d || '').slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const out = { ok: false, requested: 0, fetched: 0, written: 0, skipped: '', error: '', rows: [] };
  if (stocks.length === 0 || tradeDates.length < RANGE20_LEG_DAYS) {
    out.skipped = '待补票 ' + stocks.length + ' 只 / 交易日 ' + tradeDates.length +
      ' 天（<' + RANGE20_LEG_DAYS + '）⇒ 不补';
    return out;
  }
  const codeOf = typeof o.codeOf === 'function' ? o.codeOf : function () { return ''; };
  const haveOf = typeof o.haveOf === 'function' ? o.haveOf : function () { return null; };
  const codes = stocks.map(s => String(codeOf(s) || '')).filter(c => /^\d{6}$/.test(c));
  if (codes.length === 0) {
    out.skipped = '待补 ' + stocks.length + ' 只全部没有 6 位代码（stockcodemap 也查不到）⇒ 无法取日线';
    logs.push('[legs-fill] ⚠️ ' + out.skipped);
    return out;
  }
  out.requested = codes.length;

  let bars;
  try {
    // 🔴 [FILL-START-BAR 2026-11-20 生产日志实锤] 起点必须【早于】窗口首日！
    //   首日那根日涨幅 = 首日收盘 / 前一根 bar 收盘 − 1，接口只返回请求区间内的 bar
    //   （不会白送更早的）⇒ 从窗口首日开始取会丢掉首日涨幅，19 根只补到 17~18 根，
    //   `compoundRange20` 仍判腿不足。11-17 实测：补了 205 行却只写出 1 行 20 日涨幅、
    //   覆盖度停在 86% —— 就是这个缺一根造成的整类失败。
    //   前移 20 个自然日（≈14 个交易日，够跨一次小长假），⛔ 不省这一个请求。
    bars = await fetchFuyaoBatchBars(
      env, codes,
      r20FillShiftDays(tradeDates[0], -R20_FILL_BAR_LEAD_DAYS),
      tradeDates[tradeDates.length - 1]
    );
  } catch (e) {
    out.error = '批量日线失败: ' + ((e && e.message) || e);
    logs.push('[legs-fill] ❌ ' + out.error);
    return out;
  }
  out.fetched = bars.size;

  const nowIso = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const code = String(codeOf(s) || '');
    if (!/^\d{6}$/.test(code)) continue;
    const b = bars.get(code);
    if (!b || b.length === 0) continue;
    const pctMap = barsToDailyPctMap(b);
    const have = haveOf(s);
    for (let k = 0; k < tradeDates.length; k++) {
      const d = tradeDates[k];
      if (have && typeof have.has === 'function' && have.has(d)) continue;
      const p = pctMap.get(d);
      if (!isFinite(p)) continue;                       // §10 取不到就不写，⛔ 不当 0%
      rows.push({
        date: d,
        stock: s,
        pct: (p < 0 ? '' : '+') + p.toFixed(2),
        src: 'fuyao_kline',
        updated_at: nowIso
      });
    }
  }
  if (rows.length === 0) {
    out.ok = true;
    out.skipped = '批量日线取到 ' + bars.size + '/' + codes.length +
      ' 只，但 19 个交易日里没有可补的新腿';
    logs.push('[legs-fill] ✅ ' + out.skipped);
    return out;
  }
  try {
    await upsertDailyPctRows(env, rows);
  } catch (e) {
    out.error = '写 stock_daily_pct 失败: ' + ((e && e.message) || e);
    logs.push('[legs-fill] ❌ ' + out.error);
    return out;
  }
  out.written = rows.length;
  out.rows = rows;
  out.ok = true;
  logs.push('[legs-fill] ✅ 同花顺批量日线补腿 ' + rows.length + ' 行（' +
    out.fetched + '/' + codes.length + ' 只取到，src=fuyao_kline）');
  return out;
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
    written: 0, shortLegs: 0, noTLeg: 0, skipped: '', error: '', logs: logs,
    // ★★ [LEGS-FILL-CLOUD 2026-11-20] 补腿留痕（验收用，⛔ 别只看 ok）
    shortBefore: 0,
    legsFill: null
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
  let legs = groupLegs(legRows);

  // ★★ [LEGS-FILL-CLOUD 2026-11-20] 腿不足 19 根 ⇒ 云端现补（这才是「新面孔 / 历史日空白」的根因修法）。
  //   顺序不能反：必须先有腿，下面的复利才算得出来。
  //   `o.fillLegs === false` 时跳过（给纯读场景 / 单测用，不产生上游请求）。
  const shortList = need.filter(function (s) {
    const hist = legs.get(s);
    return !hist || hist.length < RANGE20_LEG_DAYS;
  });
  out.shortBefore = shortList.length;
  out.legsFill = null;
  if (shortList.length > 0 && o.fillLegs !== false) {
    let tradeDates = [];
    try {
      // 交易日来源必须是 market_metrics（§已固化）：⛔ 不能拿 auction_watchlist.date
      // （国庆每天被写进 11 行垃圾）。want=19 = 19 根历史腿，不含 today 本身。
      tradeDates = await readRecentTradeDates(env, today, RANGE20_LEG_DAYS);
    } catch (e) {
      logs.push('[legs-fill] ⚠️ 读交易日序列失败（本轮不补腿，留给下一趟）: ' +
        ((e && e.message) || e));
      tradeDates = [];
    }
    if (tradeDates.length >= RANGE20_LEG_DAYS) {
      // code：market_metrics 的 code 是真值（9:25 主流程写入）；没有再回退一份名称索引。
      const codeByStock = new Map();
      metrics.forEach(function (r) {
        if (!r || !r.name) return;
        const c = String(r.code || '').replace(/\D/g, '');
        if (c.length === 6) codeByStock.set(r.name, c);
      });
      // 已有腿集合（按股票）⇒ 只补缺的那几天，已有腿一根都不碰。
      const haveByStock = new Map();
      legRows.forEach(function (r) {
        if (!r || !r.stock || !r.date) return;
        let set = haveByStock.get(r.stock);
        if (!set) { set = new Set(); haveByStock.set(r.stock, set); }
        set.add(String(r.date).slice(0, 10));
      });
      const fill = await fillLegsFromKline(env, {
        stocks: shortList,
        tradeDates: tradeDates,
        codeOf: function (s) { return codeByStock.get(s) || ''; },
        haveOf: function (s) { return haveByStock.get(s) || null; },
        logs: logs,
        budgetMs: (o.budgetMs === undefined ? CONFIG.BARS_FILL_BUDGET_MS : o.budgetMs)
      });
      out.legsFill = {
        requested: fill.requested, fetched: fill.fetched, written: fill.written,
        skipped: fill.skipped, error: fill.error
      };
      if (fill.written > 0) {
        // 合并后重新归集：groupLegs 会按日期升序排好，compoundRange20 再取最后 19 根。
        legs = groupLegs(legRows.concat(fill.rows.map(function (r) {
          return { stock: r.stock, date: r.date, pct: r.pct };
        })));
      }
    } else if (tradeDates.length > 0) {
      logs.push('[legs-fill] ⚠️ 交易日仅 ' + tradeDates.length + ' 天（<' + RANGE20_LEG_DAYS +
        '）⇒ 本轮不补腿');
    }
  }

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
  });  if (rows.length === 0) {
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
  // ★ [LEGS-FILL-CLOUD 2026-11-20] 补腿必须可观测：这是「新面孔 20 日涨幅空白」的唯一证据链。
  if (out.legsFill) {
    logs.push('[r20-prefill] 腿不足 ' + out.shortBefore + ' 只 ⇒ 云端批量补腿 ' +
      (out.legsFill.written || 0) + ' 行（取到 ' + (out.legsFill.fetched || 0) + '/' +
      (out.legsFill.requested || 0) + ' 只' +
      (out.legsFill.skipped ? ' / ' + out.legsFill.skipped : '') +
      (out.legsFill.error ? ' / ❌ ' + out.legsFill.error : '') + '）');
  }
  // [CLOUD-0927-HEAL 2026-11-11] 覆盖度必须可观测：低于 80% 时前端买点闸门会拒绝定稿，
  //   若不在这里点名，事后只能靠猜「为什么当天没出票」。9:27 会再补一次。
  const finalCovered = out.covered + rows.length;
  const finalCoverage = finalCovered / out.targets;
  logs.push('[r20-prefill] 覆盖度 ' + finalCovered + '/' + out.targets +
    ' = ' + (finalCoverage * 100).toFixed(0) + '%' +
    (finalCoverage < 0.8 ? ' ⚠️ 未达 80% ⇒ 9:27 将再补一次；前端买点闸门暂不定稿' : ' ✅ 达标'));
  return out;
}
