// range-heal.js — 云端「区间涨幅」自愈（runRangePctHeal）
//
// 【为什么需要这个文件 / 2026-11-04 用户报障】
//   用户原话：「今天体验非常差，到现在 9 点 48 分题材量比才出票。是不是出票还是要打开电脑，
//   如果关闭电脑关机就不可以出票吗？我一般是关掉电脑，直接在手机看的，不依赖电脑的。」
//   实测取证：2026-11-04 那天
//     · worker 9:25 跑了（bidding_fetch_log ok=true），但日志写着
//       「⚠️ 区间涨幅无结果可写（numcat daily 不可用）」；
//     · stock_range_pct 当天 47 行的 updated_at **全部落在 09:46:04~09:46:09（北京）**
//       —— 那是【浏览器】打开页面时补算并回写的，不是 worker 写的。
//   ⇒ 结论：区间涨幅在 9:25 没算出来 → 云端空 → 谁打开页面谁补算 → **不开电脑就没人算**
//     → 手机上看不到十日涨幅 → 题材量比没有排序依据 → 出不了票。这就是「关机不出票」的根因。
//
// 【本模块做什么】
//   9:27 那一趟（cron `27 1 * * 2-6`，用户拍板「最迟 9 点 27 分，9:35 开盘了没用了」）
//   ⚠️ [CLOUD-0927-HEAL 2026-11-11] 这条 cron 原先只写在注释里、toml 里**根本没挂**，
//      所以本模块自 11-04 落地后从未自动跑过；现已挂到 workers/wrangler-bidding-auto-fetch.toml。
//      工作日是 Cloudflare 的 2-6（周一~周五），⛔ 别按标准 cron 写成 1-5。
//   在补竞价字段之后，再检查一次今天的 stock_range_pct：
//     · 覆盖率够（满窗行数 ≥ 当日竞价行数的 HEAL_MIN_COVERAGE）→ **零请求直接返回**（不烧额度）；
//     · 覆盖率不够 → 才发 1 次猫抓 daily（整个 [T-9, T] 窗口，请求数与只拉今天相同），
//       用与 9:25 早盘【完全同一份口径】（range-window.js 的窗口/复利/T 腿）算好落库。
//   ⇒ 正常日零成本，只有 9:25 那次真的失败时才多花 1 次额度把数据救回来。
//
// 【安全约束（§10 / §11 / NO-PARTIAL-WRITE）】
//   · 读库失败必须抛错中断 —— 绝不把「读不到」当成「全都缺」而整体重算覆盖；
//   · 只写【满窗】行（days === 窗口长度）。残缺行会按日期级复用地污染排序，
//     与 2026-09-15 龙头组事故同构 —— 残缺行只记日志、不落库；
//   · 只填【库内没有满窗值】的股票，已有的值永不覆盖 ⇒ 天然幂等，重复跑零副作用；
//   · 整体失败不致命（调用方 try/catch），绝不影响竞价字段补漏那条主链。

import { beijingToday, beijingNow, compactToDateStr } from '../../_shared-source/date-utils.js';
import { numcatDaily } from '../data/numcat-api.js';
import {
  upsertStockRangePct, readMarketMetricsForDate, readStockRangePctForDate
} from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
import { RANGE_WINDOW_DAYS, parsePct, buildRangeRows, isAuctionLegActive } from '../../../src/logic/auction/range-window.js';

/**
 * 覆盖率闸门：满窗行数 / 当日竞价行数 ≥ 该值 ⇒ 判定「健康」，不发猫抓请求。
 *
 * 为什么不取 100%：总有票真的缺腿（停牌、次新、窗口内上市），它们永远凑不满窗。
 * 只要绝大多数票有值，「题材量比能排序、能出票」这个目的就达到了，
 * 不值得为最后几只每天多烧一次额度。
 */
const RANGE_HEAL_MIN_COVERAGE = 0.8;

/** 单次 upsert 行数 */
const RANGE_HEAL_CHUNK = 400;

/** 北京当前小时（0~23）—— 决定 T 腿口径（15:00 前 = 竞价涨幅） */
function rangeHealIsAfterClose() {
  return beijingNow().getUTCHours() >= 15;
}

/**
 * 云端补齐当日 stock_range_pct（区间涨幅）。
 * @param {object} env
 * @param {{logs?:string[], date?:string, force?:boolean, minCoverage?:number}} [opts]
 *        date   缺省 = 北京今天（仅供排查时指定历史日）
 *        force  true = 跳过覆盖率闸门，强制重算（排查用；会把缺的满窗行补齐）
 * @returns {Promise<{ok:boolean, today:string, written:number, coverage:number, healthy:boolean, logs:string[]}>}
 */
export async function runRangePctHeal(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.date || beijingToday();
  const minCoverage = o.minCoverage === undefined ? RANGE_HEAL_MIN_COVERAGE : Number(o.minCoverage);
  logs.push('[range-heal] 区间涨幅自愈开始 today=' + today);

  // 1) 读当日竞价行（§10：读失败必须中断，不能当成「全都缺」）
  let metricsRows;
  try {
    metricsRows = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    logs.push('[range-heal] ❌ 读取 ' + today + ' market_metrics 失败（中断，避免误覆盖）: ' + e.message);
    return { ok: false, today, written: 0, coverage: 0, healthy: false, logs, error: e.message };
  }
  // ⚠️ readMarketMetricsForDate 返回的字段是 `name`（而 readStockRangePctForDate 返回 `stock`），
  //    两者形状不同 —— 这里统一映射成 { name, code, auc, chg }，别混用。
  const targets = (metricsRows || [])
    .filter(r => r && r.code && /^\d{6}$/.test(String(r.code).trim()))
    .map(r => ({ name: String(r.name || '').trim(), code: String(r.code).trim(), auc: r.auc_pct_chg, chg: r.change_pct }))
    .filter(r => r.name);
  if (targets.length === 0) {
    logs.push('[range-heal] ⚠️ ' + today + ' 无可用竞价行（名单未落库？）→ 跳过');
    return { ok: true, today, written: 0, coverage: 0, healthy: false, logs, reason: '无竞价行' };
  }

  // 2) 读库内已有区间涨幅，算「满窗覆盖率」
  let existing = [];
  try {
    existing = await readStockRangePctForDate(env, today);
  } catch (e) {
    logs.push('[range-heal] ❌ 读取 ' + today + ' stock_range_pct 失败（中断，避免误覆盖）: ' + e.message);
    return { ok: false, today, written: 0, coverage: 0, healthy: false, logs, error: e.message };
  }
  const fullNames = new Set();
  (existing || []).forEach(r => {
    if (!r || !r.stock) return;
    const pct = parsePct(r.range_pct);
    const days = Number(r.days);
    if (pct !== null && days === RANGE_WINDOW_DAYS) fullNames.add(String(r.stock).trim());
  });
  const coverage = fullNames.size / targets.length;
  logs.push('[range-heal] 竞价行 ' + targets.length + '，库内满窗 ' + fullNames.size +
    '（覆盖 ' + (coverage * 100).toFixed(0) + '%，闸门 ' + (minCoverage * 100).toFixed(0) + '%）');

  if (!o.force && coverage >= minCoverage) {
    logs.push('[range-heal] ✅ 覆盖率已达标 → 零请求直接返回（不烧猫抓额度）');
    return { ok: true, today, written: 0, coverage: coverage, healthy: true, logs };
  }

  // 3) 窗口交易日 [T-9, T]（与 9:25 早盘同一份交易日历 / 同一个 RANGE_WINDOW_DAYS）
  //    opts.dates 可显式指定窗口（手动修复历史日 / 单测注入，避免每次都去查交易日历）
  let rangeDates = (Array.isArray(o.dates) && o.dates.length > 0) ? o.dates.slice() : [];
  if (rangeDates.length === 0) {
    try {
      rangeDates = await getRecentTradingDays(env, today, RANGE_WINDOW_DAYS);
    } catch (e) {
      logs.push('[range-heal] ❌ 交易日历获取失败: ' + e.message);
      return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: e.message };
    }
  }
  if (!rangeDates || rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('[range-heal] ⚠️ 区间涨幅窗口异常(' + JSON.stringify(rangeDates || []) + ') → 放弃重算');
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, reason: '窗口异常' };
  }
  rangeDates.sort();

  // 4) 只对「库内还没有满窗值」的票重算 —— 请求的代码集也按这个裁剪（省上游压力）
  const need = targets.filter(t => !fullNames.has(t.name));
  if (need.length === 0) {
    logs.push('[range-heal] ✅ 待补票数为 0（剩余缺票属正常缺腿）→ 不请求');
    return { ok: true, today, written: 0, coverage: coverage, healthy: true, logs };
  }
  const symbols = need.map(t => t.code).join(',');
  const startYMD = rangeDates[0].replace(/-/g, '');
  const endYMD = rangeDates[rangeDates.length - 1].replace(/-/g, '');
  logs.push('[range-heal] 待补 ' + need.length + ' 只，请求猫抓 daily ' + rangeDates.length + ' 天窗口...');

  // 5) 一次猫抓 daily 拿整个窗口的逐日涨幅（1 次请求）
  let dailyData;
  try {
    dailyData = await numcatDaily(env, symbols, startYMD, endYMD, logs);
  } catch (e) {
    logs.push('[range-heal] ❌ 猫抓 daily 失败（区间涨幅本次仍未补上，等下次触发/收盘重算）: ' + e.message);
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: e.message };
  }
  const dFields = (dailyData && dailyData.fields) || [];
  const dItems = (dailyData && dailyData.items) || [];
  const dSymIdx = dFields.indexOf('symbol');
  const dDateIdx = dFields.indexOf('tradedate');
  const dPctIdx = dFields.indexOf('pct_chg');
  if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
    logs.push('[range-heal] ❌ 猫抓 daily 返回字段不完整: ' + JSON.stringify(dFields));
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, error: '字段不完整' };
  }
  // dailyByCode：code -> { YYYYMMDD: 日涨幅 }（与早盘 fetchDailyWindow 完全同构）
  const dailyByCode = {};
  let legCount = 0;
  dItems.forEach(row => {
    const code = String(row[dSymIdx] || '').trim();
    const tradedate = String(row[dDateIdx] || '').trim();
    const rawPct = row[dPctIdx];
    if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
    const dateStr = compactToDateStr(tradedate);
    const n = Number(rawPct);
    if (!dateStr || isNaN(n)) return;
    if (!dailyByCode[code]) dailyByCode[code] = {};
    dailyByCode[code][dateStr.replace(/-/g, '')] = n;
    legCount++;
  });
  logs.push('[range-heal] 猫抓 daily 返回 ' + legCount + ' 条腿，涉及 ' + Object.keys(dailyByCode).length + ' 只');
  if (legCount === 0) {
    logs.push('[range-heal] ⚠️ 猫抓本次一条腿都没给 → 放弃（不写任何行）');
    return { ok: false, today, written: 0, coverage: coverage, healthy: false, logs, reason: '无腿数据' };
  }

  // 6) T 腿：15:00 前用竞价涨幅（与 9:25 早盘口径一致），收盘后用当日收盘涨幅
  const afterClose = rangeHealIsAfterClose();
  const useAuctionLeg = isAuctionLegActive(today, today, afterClose);
  const tYmd = today.replace(/-/g, '');
  const tLegByCode = {};
  need.forEach(t => {
    let v;
    if (useAuctionLeg) {
      v = parsePct(t.auc);
    } else {
      const dm = dailyByCode[t.code];
      v = dm && Object.prototype.hasOwnProperty.call(dm, tYmd) ? dm[tYmd] : parsePct(t.chg);
    }
    if (v !== null && v !== undefined && isFinite(v)) tLegByCode[t.code] = Number(v);
  });

  // 只把「拿到当天 T 腿」的票交给 buildRangeRows（避免产出残缺行，见文件头 NO-PARTIAL-WRITE）
  const eligible = need.filter(t => tLegByCode[t.code] !== undefined);
  const noTLeg = need.length - eligible.length;
  const built = buildRangeRows(eligible, rangeDates, dailyByCode, tLegByCode);
  const nowIso = new Date().toISOString();
  const rows = built
    .filter(r => Number(r.days) === rangeDates.length)   // ⛔ 残缺行不落库
    .map(r => ({
      date: today,
      stock: r.stock,
      range_pct: Number(r.pct).toFixed(2),
      days: r.days,
      updated_at: nowIso
    }));
  logs.push('[range-heal] 计算完成：可写满窗行 ' + rows.length + ' / 待补 ' + need.length +
    (noTLeg > 0 ? '；' + noTLeg + ' 只无当天 T 腿（不写行）' : '') +
    (built.length > rows.length ? '；' + (built.length - rows.length) + ' 只缺历史腿（不写残缺行）' : ''));

  if (rows.length === 0) {
    logs.push('[range-heal] ⚠️ 没有可写的满窗行（等收盘整段重算或下次触发）');
    return { ok: true, today, written: 0, coverage: coverage, healthy: false, logs };
  }

  // 7) 分批写入（主键 date+stock，merge-duplicates；只含与本次重算相关的列，绝不抹 change_pct 等）
  let written = 0;
  for (let i = 0; i < rows.length; i += RANGE_HEAL_CHUNK) {
    const chunk = rows.slice(i, i + RANGE_HEAL_CHUNK);
    try {
      await upsertStockRangePct(env, chunk);
      written += chunk.length;
    } catch (e) {
      logs.push('[range-heal] ❌ 第 ' + (Math.floor(i / RANGE_HEAL_CHUNK) + 1) + ' 批写入失败: ' + e.message);
    }
  }
  const newCoverage = (fullNames.size + written) / targets.length;
  logs.push('[range-heal] ✅ 补写 ' + written + ' 行区间涨幅，覆盖率 ' +
    (coverage * 100).toFixed(0) + '% → ' + (Math.min(newCoverage, 1) * 100).toFixed(0) + '%');
  return { ok: written > 0, today, written: written, coverage: newCoverage, healthy: false, logs };
}
