// inject-metrics-heal.js — 「补位票」历史行情行云端补建 / 补字段（runInjectedMetricsBackfill）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-23 原话）
// ══════════════════════════════════════════════════════════════════════════════════════
//   「今天不能重补下30日强势补位票的数据吗？也就是那两只，现在数据只有三个，趋势图也是几乎空白的，能补吗？」
//
// 【为什么补得动 —— 真实库取证（2026-11-23，只读）】
//   百洋股份 002696 / 慈文传媒 002343（当日「30日强势补位」两只）：
//     · 11-17~11-20 在 market_metrics 里**一行都没有**（不是字段空，是没行）⇒ 五日趋势图整段空白；
//     · 11-23 只有 ths-patch 写的 volume + auc_pct_chg + auc_turnover，
//       auc_vol_ratio / yest_volume / change_pct / um_vol / open_bid_pct 全 null；
//     · 对照：它们 11-10~11-13 的行（source='worker'，猫抓写的）九列齐全、量比 2.9~7.2。
//   ⇒ 「补得回来」的关键证据在 `morning-workflow.js` 里那条实测注记：
//     「8/07 起的每个历史日，四要素都是在【后续几天的窗口重刷】时才出现的」
//     ⇒ 猫抓 `daily_auc` 的 startdate~enddate **对历史日是会给值的**（不是只给当天）。
//   所以：一次猫抓区间请求就能把这几天的竞价量 / 竞价涨幅 / 量比 / 四要素一起拿回来；
//   历史日的「涨幅」用同花顺批量日线算（免费、0 猫抓额度），不再多烧一次额度。
//
// 【与既有两条链路的分工（⛔ 别互相抢活）】
//   ① `runAuctionExtrasPatch`（point=extras）：只补**已存在行**的四要素/竞价涨幅 —— 补不了「没行」；
//   ② `runTodaySnapshotPatch`（point=snapshot）：只用同花顺快照补**当天**，且按口径不碰量比；
//   ③ 本文件：专治**补位票整行缺失**（历史日新建行）+ 顺手补字段。三者字段口径完全一致。
//
// 【红线】
//   §1  竞价量比只认猫抓 —— 本文件量比唯一来源 `daily_auc.auc_vol_ratio`，⛔ 不用任何同花顺字段顶替；
//       ⚠️ 同花顺 K 线腿**只用来算 change_pct（日涨幅）**，绝不参与竞价字段。
//   §6  ⛔ 只写 `market_metrics`；不碰 `auction_watchlist`（当日名单仍 = 9:25 快照）、
//       不写 `stock_range*`、不改任何选股规则。
//   §10 读失败必须抛错（⛔ 不返回 []，否则会被当成「全缺」而重复新建/覆盖）；
//       猫抓某天没给值 ⇒ 那一天就不建行（⛔ 不写空行冒充「有数据」）。
//   §11 只补「库内为空」的字段、只新建「库里确实没有」的行；已有非空值一个都不覆盖（幂等）。
//
// 【额度】
//   · 1 次猫抓 `daily_auc`（区间覆盖整个窗口）。
//   · 同花顺批量日线：0 猫抓额度（10 只/批）。

import { beijingToday, compactToDateStr } from '../../_shared-source/date-utils.js';
import { numcatDailyAuc } from '../data/numcat-api.js';
import { fetchFuyaoBatchBars, barsToDailyPctMap } from '../data/fuyao-api.js';
import {
  upsertMarketMetrics, readMarketMetricsRowsForDate,
  readStockCodeMap, readCodesFromMetricsByNames,
  readRange30TopForDate, readRange20TopForDate
} from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
import { parseNumcatToMetrics } from './morning-workflow.js';

/** 与早盘 worker 完全相同的九个竞价字段（键集一致才好分桶） */
const R30BF_FIELDS = ['volume', 'yest_volume', 'change_pct', 'auc_pct_chg',
  'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];
/** 默认回看交易日数：五日趋势 + 1 天冗余（趋势面板取 5 列） */
const R30BF_DEFAULT_DAYS = 6;
/** 取日涨幅的批量日线起点前移（需要一根「窗口首日之前的 bar」当基准，跨长假也够） */
const R30BF_BAR_LEAD_DAYS = 20;

function r30bfIsEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** 'YYYY-MM-DD' 平移 N 个自然日（纯函数，不依赖交易日历） */
function r30bfShiftDays(ymd, delta) {
  const s = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s + 'T00:00:00Z') + delta * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 涨幅数值 → worker 口径字符串（'+X.XX%' / '-X.XX%'） */
function r30bfPctStr(n) {
  const x = Number(n);
  if (!isFinite(x)) return '';
  return (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
}

/**
 * 云端补建 / 补字段「补位票」的历史竞价行。
 *
 * @param {object} env
 * @param {object} [opts]
 *   · logs?: string[]              日志收集数组
 *   · date?: string                目标日（默认北京今天）；窗口末日 = 该日或之前最近的交易日
 *   · days?: number                回看交易日数（默认 6）
 *   · stocks?: string[]            只补这些股票名（默认 = 前一交易日 30 日榜前 50 ∪ 20 日榜前 25）
 * @returns {Promise<{ok:boolean, date:string, dates:string[], targets:number,
 *   created:number, filled:number, skipped:number, logs:string[]}>}
 */
export async function runInjectedMetricsBackfill(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const wantDate = String(o.date || '').trim() || beijingToday();
  const days = Number(o.days) > 0 ? Math.floor(Number(o.days)) : R30BF_DEFAULT_DAYS;
  logs.push('[r30backfill] 补位票历史行情行补建开始 date=' + wantDate + ' days=' + days);

  // ── 1. 交易日窗口（与早盘/收盘同一份日历，§6） ──────────────────────────────
  let window = [];
  try {
    window = await getRecentTradingDays(env, wantDate, days);
  } catch (e) {
    logs.push('[r30backfill] ❌ 交易日历获取失败: ' + ((e && e.message) || e));
    return { ok: false, date: wantDate, dates: [], targets: 0, created: 0, filled: 0, skipped: 0, logs };
  }
  window = (window || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (window.length === 0) {
    logs.push('[r30backfill] ⚠️ 无可用交易日，跳过');
    return { ok: false, date: wantDate, dates: [], targets: 0, created: 0, filled: 0, skipped: 0, logs };
  }
  const lastDay = window[window.length - 1];
  const prevDay = window.length >= 2 ? window[window.length - 2] : null;
  logs.push('[r30backfill] 窗口 ' + window[0] + '~' + lastDay + '（' + window.length + ' 天），前一交易日=' + (prevDay || '—'));

  // ── 2. 目标票：默认「前一交易日的 30 日补位榜 + 20 日补位榜」 ─────────────────
  //    ⚠️ 用【前一交易日】的榜而不是当天：当天榜要等收盘后才算得出（与 9:25 抓取名单同一条口径）。
  let names = Array.isArray(o.stocks) ? o.stocks.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (names.length === 0 && prevDay) {
    const settled = async function (p) { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e: e }; } };
    const [r30Res, r20Res] = await Promise.all([
      settled(readRange30TopForDate(env, prevDay, 50)),
      settled(readRange20TopForDate(env, prevDay, 25))
    ]);
    if (r30Res.ok) {
      (r30Res.v || []).forEach(r => { if (r && r.name) names.push(r.name); });
      logs.push('[r30backfill] 30日补位榜(' + prevDay + ') 取前 ' + (r30Res.v || []).length + ' 名');
    } else {
      logs.push('[r30backfill] ⚠️ 读 30 日榜失败: ' + ((r30Res.e && r30Res.e.message) || r30Res.e));
    }
    if (r20Res.ok) {
      (r20Res.v || []).forEach(r => { if (r && r.name) names.push(r.name); });
      logs.push('[r30backfill] 20日补位榜(' + prevDay + ') 取前 ' + (r20Res.v || []).length + ' 名');
    } else {
      logs.push('[r30backfill] ⚠️ 读 20 日榜失败: ' + ((r20Res.e && r20Res.e.message) || r20Res.e));
    }
  }
  names = Array.from(new Set(names));
  if (names.length === 0) {
    logs.push('[r30backfill] ⚠️ 没有目标票（榜单为空且未指定 stocks），跳过');
    return { ok: false, date: lastDay, dates: window, targets: 0, created: 0, filled: 0, skipped: 0, logs };
  }
  logs.push('[r30backfill] 目标票 ' + names.length + ' 只');

  // ── 3. 解析 code（列表里只有名字；⛔ 没 code 的票猫抓查不到，必须逐只留痕） ────
  let codeMap = {};
  try {
    codeMap = (await readStockCodeMap(env)) || {};
  } catch (e) {
    logs.push('[r30backfill] ⚠️ 读 stockcodemap 失败（继续用二级兜底）: ' + ((e && e.message) || e));
  }
  let missing = names.filter(n => !codeMap[n]);
  if (missing.length > 0) {
    try {
      const second = (await readCodesFromMetricsByNames(env, missing)) || {};
      let added = 0;
      Object.keys(second).forEach(function (n) {
        if (!codeMap[n] && second[n]) { codeMap[n] = second[n]; added++; }
      });
      if (added > 0) logs.push('[r30backfill] market_metrics.code 二级补码 ' + added + ' 只');
    } catch (e) {
      logs.push('[r30backfill] ⚠️ 二级补码失败: ' + ((e && e.message) || e));
    }
  }
  const targets = [];
  const noCode = [];
  names.forEach(function (n) {
    const code = String(codeMap[n] || '').trim();
    if (/^\d{6}$/.test(code)) targets.push({ name: n, code: code });
    else noCode.push(n);
  });
  if (noCode.length > 0) {
    logs.push('⚠️ [r30backfill] ' + noCode.length + ' 只查不到 code ⇒ 无法向猫抓取数（§10 留痕）: ' + noCode.join('、'));
  }
  if (targets.length === 0) {
    logs.push('[r30backfill] ⚠️ 无可用代码，跳过');
    return { ok: false, date: lastDay, dates: window, targets: 0, created: 0, filled: 0, skipped: noCode.length, logs };
  }
  const codes = targets.map(t => t.code);

  // ── 4. 读库内现状：哪些 (date, stock) 没行、哪些行缺字段 ─────────────────────
  const existing = {};         // date -> Map(name -> row)
  for (let i = 0; i < window.length; i++) {
    const d = window[i];
    let rows;
    try {
      rows = await readMarketMetricsRowsForDate(env, d, names);
    } catch (e) {
      logs.push('[r30backfill] ❌ 读取 ' + d + ' 失败（中断，避免误覆盖）: ' + ((e && e.message) || e));
      return { ok: false, date: lastDay, dates: window, targets: targets.length, created: 0, filled: 0, skipped: 0, logs };
    }
    const m = new Map();
    (rows || []).forEach(r => { if (!m.has(r.name)) m.set(r.name, r); });
    existing[d] = m;
  }
  let needNew = 0;
  let needFill = 0;
  window.forEach(function (d) {
    targets.forEach(function (t) {
      const cur = existing[d].get(t.name);
      if (!cur) { needNew++; return; }
      if (R30BF_FIELDS.some(f => r30bfIsEmpty(cur[f]))) needFill++;
    });
  });
  logs.push('[r30backfill] 库内现状：缺行 ' + needNew + ' 个 (日,票)，缺字段 ' + needFill + ' 个 (日,票)');
  if (needNew === 0 && needFill === 0) {
    logs.push('[r30backfill] ✅ 窗口内目标票已完整，无需补写（零请求）');
    return { ok: true, date: lastDay, dates: window, targets: targets.length, created: 0, filled: 0, skipped: 0, logs };
  }

  // ── 5. 一次猫抓区间请求（1 次额度）─────────────────────────────────────────
  const startYMD = window[0].replace(/-/g, '');
  const endYMD = lastDay.replace(/-/g, '');
  let aucData;
  try {
    aucData = await numcatDailyAuc(env, codes.join(','), startYMD, endYMD, logs);
  } catch (e) {
    logs.push('[r30backfill] ❌ numcat daily_auc 失败: ' + ((e && e.message) || e));
    return { ok: false, date: lastDay, dates: window, targets: targets.length, created: 0, filled: 0, skipped: 0, logs };
  }
  const fields = (aucData && aucData.fields) || [];
  const items = (aucData && aucData.items) || [];
  logs.push('[r30backfill] numcat 返回 ' + items.length + ' 行 · fields=' + JSON.stringify(fields));
  // 复用早盘同一份解析（口径唯一，§6）：volume=auc_vol/100、yest_volume=auc_vol/占比、越界闸门…
  //   ⚠️ 它返回的是 { metricsByDate, parsedCount, yestVolDerivedCount, outOfRange }（不是直接的 map），
  //      2026-11-23 第一版就是把整个对象当日历用 ⇒ 一行都写不出去（已由单测①钉住）。
  const parsed = parseNumcatToMetrics(items, fields, targets, logs, lastDay) || {};
  const parsedByDate = parsed.metricsByDate || {};
  logs.push('[r30backfill] 解析出 ' + Object.keys(parsedByDate).length + ' 个交易日、'
    + (parsed.parsedCount || 0) + ' 条');
  if (Array.isArray(parsed.outOfRange) && parsed.outOfRange.length > 0) {
    logs.push('⚠️ [r30backfill] ' + parsed.outOfRange.length + ' 条竞价涨幅物理越界已按口径丢弃（§10 留空不猜）');
  }

  // ── 6. 历史日「涨幅」：同花顺批量日线（0 猫抓额度）────────────────────────────
  //   ⚠️ 猫抓 daily_auc 给的是【竞价涨幅】，不是日涨幅。历史日的 change_pct 必须另找来源，
  //      否则趋势图那条「涨幅」线还是空的。同花顺批量日线免费，且与 stock_daily_pct 同源同口径。
  const closePctByCode = new Map();   // code -> Map<ymd, pct>
  try {
    const barsByCode = await fetchFuyaoBatchBars(
      env, codes, r30bfShiftDays(window[0], -R30BF_BAR_LEAD_DAYS), lastDay);
    barsByCode.forEach(function (bars, code) {
      const m = barsToDailyPctMap(bars);
      if (m && m.size > 0) closePctByCode.set(code, m);
    });
    logs.push('[r30backfill] 同花顺日线覆盖 ' + closePctByCode.size + '/' + codes.length + ' 只（用于 change_pct）');
  } catch (e) {
    // §10：失败只降级「涨幅」这一列，⛔ 不连坐竞价字段
    logs.push('⚠️ [r30backfill] 同花顺日线失败（change_pct 本次留空，趋势图由前端补点）: ' + ((e && e.message) || e));
  }

  // ── 7. 组装写入行：只新建「库里确实没有的」+ 只填「库内为空的」─────────────────
  const nowIso = new Date().toISOString();
  const rows = [];
  let created = 0;
  let filled = 0;
  window.forEach(function (d) {
    const parsedRows = parsedByDate[d] || [];
    const parsedByName = new Map();
    parsedRows.forEach(r => { if (r && r.stock && !parsedByName.has(r.stock)) parsedByName.set(r.stock, r); });
    targets.forEach(function (t) {
      const cur = existing[d].get(t.name) || null;
      const src = parsedByName.get(t.name) || null;
      const barsPct = closePctByCode.get(t.code);
      const closePct = barsPct ? barsPct.get(d) : null;

      if (!cur) {
        // 新建：⛔ 猫抓这一天没给值就不建行（不造空行冒充「有数据」，§10）
        if (!src) return;
        const row = {
          date: d, stock: t.name, scope: 'auction', code: t.code,
          source: 'numcat', updated_at: nowIso, updated_by: 'worker-r30backfill'
        };
        let any = false;
        R30BF_FIELDS.forEach(function (f) {
          if (f === 'change_pct') return;         // 单独处理（历史日用日线涨幅）
          if (!r30bfIsEmpty(src[f])) { row[f] = src[f]; any = true; }
        });
        // 涨幅：非窗口末日 ⇒ 收盘口径（日线真值）；窗口末日 ⇒ 竞价副本（16:00 close 会覆盖）
        const cp = (d !== lastDay && closePct !== null && closePct !== undefined)
          ? r30bfPctStr(closePct)
          : (src.change_pct || '');
        if (cp !== '') { row.change_pct = cp; any = true; }
        if (!any) return;                          // 一个值都没有 ⇒ 不建行
        rows.push(row);
        created++;
        return;
      }

      // 已有行：只补空位（§11 ⛔ 不覆盖已有非空值）
      const patch = { date: d, stock: t.name, scope: 'auction' };
      if (cur.code) patch.code = cur.code; else patch.code = t.code;
      let any = false;
      R30BF_FIELDS.forEach(function (f) {
        if (f === 'change_pct') return;
        if (!r30bfIsEmpty(cur[f])) return;
        const v = src ? src[f] : '';
        if (!r30bfIsEmpty(v)) { patch[f] = v; any = true; }
      });
      if (r30bfIsEmpty(cur.change_pct)) {
        // 历史日优先用日线真值；窗口末日用 cat 的竞价副本（当天的「涨幅」在竞价期就是竞价涨幅）
        const cp = (d !== lastDay && closePct !== null && closePct !== undefined)
          ? r30bfPctStr(closePct)
          : (src ? src.change_pct : '');
        if (!r30bfIsEmpty(cp)) { patch.change_pct = cp; any = true; }
      }
      if (!any) return;
      patch.source = 'numcat';
      patch.updated_at = nowIso;
      patch.updated_by = 'worker-r30backfill';
      rows.push(patch);
      filled++;
    });
  });

  if (rows.length === 0) {
    logs.push('⚠️ [r30backfill] 猫抓与日线都没有可写入的值（当天的行可能尚未结算，次日窗口重刷会自动补上）');
    return { ok: true, date: lastDay, dates: window, targets: targets.length, created: 0, filled: 0, skipped: noCode.length, logs };
  }

  // ── 8. 写入（Data 层按「键集」分桶 ⇒ 同批键集一致，⛔ 不会抹掉未提及的列）──────
  try {
    await upsertMarketMetrics(env, rows);
  } catch (e) {
    logs.push('[r30backfill] ❌ 写入失败: ' + ((e && e.message) || e));
    return { ok: false, date: lastDay, dates: window, targets: targets.length, created: 0, filled: 0, skipped: noCode.length, logs };
  }
  logs.push('✅ [r30backfill] 补写 ' + rows.length + ' 行（新建 ' + created + ' / 补字段 ' + filled + '），窗口 '
    + window[0] + '~' + lastDay);
  return {
    ok: true, date: lastDay, dates: window, targets: targets.length,
    created: created, filled: filled, skipped: noCode.length, logs: logs
  };
}
