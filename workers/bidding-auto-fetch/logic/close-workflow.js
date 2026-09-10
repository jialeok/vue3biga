// close-workflow.js — 收盘涨幅覆盖 + 区间涨幅重算主流程（runClose）
//
// 【为什么恢复这个流程 / 2026-09-10 审查结论】
//   2026-08-17 把收盘覆盖从本 worker 挪到了 Supabase Edge Function（bidding-a?point=auction-close，
//   pg_cron 16:00 触发），index.js 因此移除了 runClose 路由，本文件退化为「不再被调用的历史参考」。
//   但实测该 pg_cron 链路【从未成功执行过】：
//     · bidding_fetch_log 里 time_point='auction-close' 的记录数为 0；
//     · 手工触发 bidding-a?point=auction-close 返回 546（WORKER_RESOURCE_LIMIT）。
//   结果：当天 market_metrics.change_pct 全天停留在 9:25 竞价涨幅，龙头排位也按竞价口径排
//   —— 这正是用户反复反馈的「收盘后还是只显示早盘竞价涨幅」。
//   本 worker 的早盘 cron（北京 9:25）一直稳定运行，说明 Cloudflare 触发链路是可靠的，
//   因此把收盘覆盖收回这里（与早盘同一个 worker、同一套凭据、同一条部署链路）。
//
// 【两个职责】
//   ① 把 market_metrics.change_pct 从 9:25 竞价涨幅覆盖为真实收盘涨幅；
//   ② 把 stock_range_pct 的「当天(T)腿」从竞价口径换成收盘口径。
//
// 【为什么 ② 用「整段重算」而不是「反解换腿」/ 2026-09-10 二次加固】
//   原先实现是代数反解：prevAcc = (1+已存区间涨幅)÷(1+竞价腿)，新区间 = prevAcc×(1+收盘腿)。
//   它有两个硬伤：
//     · 幂等靠【时间戳】（updated_at >= 当日 15:00 就跳过）→ 前端在 15:00~16:00 之间抢跑写入的
//       任何值都会被本流程永久跳过（前端自愈与 worker 打架，错值冻结、与 change_pct 口径分叉）；
//     · 依赖「旧 T 腿确实等于 auc_pct_chg」这一假设，无法自证。
//   现在改成【用同一次猫抓 daily 请求的 10 天窗口整段重算】（请求数不变：1 次，只是窗口从
//   1 天扩到 10 天），幂等改为【值比较】，因此：
//     · 天然幂等：重算结果与库内一致 → 不写；不一致 → 覆盖（可自动修复任何被冻结的错值）；
//     · 与 change_pct 严格同源：两者都来自同一份猫抓 daily 数据，不会口径分叉；
//     · 「仅不劣化才覆盖」：重算出的天数少于库内天数时不覆盖（防上游返回被截断的窗口污染数据）。
//   猫抓不可用、只剩同花顺 snapshot 兜底当日涨幅时，退化为「只换 T 腿」（保留旧的 replaceTDayLeg 路径）。
//
// 【幂等】re-run 安全：change_pct 值相同不写；区间涨幅值/天数相同不写。

import { beijingToday, isWeekend } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { numcatDaily } from '../data/numcat-api.js';
import { fetchSnapshotChangePct } from '../data/fuyao-api.js';
import {
  upsertMarketMetrics,
  upsertStockRangePct,
  readMarketMetricsForDate,
  readStockRangePctForDate
} from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
// 区间涨幅口径单一真相（纯函数，worker 早盘/收盘与前端共用同一份实现）
// ⚠️ 单文件打包（_bundle.mjs）会把本文件与 range-window.js 拼进同一个作用域，
//    因此这里【复用】range-window 的 parsePct / RANGE_WINDOW_DAYS，不再自己定义一份
//    （同名会直接报重复声明）。
import {
  replaceTDayLeg,
  parsePct,
  buildRangeRows,
  RANGE_WINDOW_DAYS
} from '../../../src/logic/auction/range-window.js';

/** 北京时间 15:00 收盘（与前端 close-pct-cover / dragon-rank 同口径） */
const CLOSE_HOUR = 15;
/** 区间涨幅「值比较」的容差（range_pct 落库保留 2 位小数） */
const PCT_EPS = 0.005;

function _fmtClosePct(n) {
  if (!isFinite(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** 该日收盘覆盖时刻（北京 15:00）对应的 UTC 时间戳 */
function _closeCoverUtcMs(dateStr) {
  const base = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(base)) return NaN;
  return base + (CLOSE_HOUR - 8) * 3600000;
}

/**
 * 猫抓 daily 拉 [T-9, T] 窗口，一次请求同时得到两样东西：
 *   · dailyByCode —— code -> { YYYYMMDD: 日涨幅 }，供区间涨幅整段重算（历史 9 天）；
 *   · pctByCode   —— code -> 当日(T)收盘涨幅，供覆盖 change_pct。
 * 与早盘步骤5 同一个接口（symbol,tradedate,pct_chg），请求次数与「只拉当天」完全相同。
 * @param {string[]} rangeDates 升序交易日 [T-9 ... T]（为空时退化为只拉当天）
 */
async function fetchNumcatDailyWindow(env, codes, rangeDates, today) {
  const ymdToday = today.replace(/-/g, '');
  const startYmd = rangeDates.length > 0 ? rangeDates[0].replace(/-/g, '') : ymdToday;
  const data = await numcatDaily(env, codes.join(','), startYmd, ymdToday);
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  const sIdx = fields.indexOf('symbol');
  const dIdx = fields.indexOf('tradedate');
  const pIdx = fields.indexOf('pct_chg');
  const dailyByCode = {};
  const pctByCode = new Map();
  if (sIdx < 0 || dIdx < 0 || pIdx < 0) return { dailyByCode, pctByCode };
  items.forEach(row => {
    const code = String(row[sIdx] || '').trim();
    const rawDate = String(row[dIdx] || '').trim();
    const raw = row[pIdx];
    if (!code || !rawDate || raw === null || raw === undefined || raw === '') return;
    const n = Number(raw);
    if (!isFinite(n)) return;
    // tradedate 是紧凑格式 YYYYMMDD（或带横杠），统一成 YYYYMMDD 作为窗口键
    const ymd = rawDate.replace(/-/g, '');
    if (ymd.length !== 8) return;
    if (!dailyByCode[code]) dailyByCode[code] = {};
    dailyByCode[code][ymd] = n;
    if (ymd === ymdToday) pctByCode.set(code, n);
  });
  return { dailyByCode, pctByCode };
}

export async function runClose(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 名单 + 旧值来源：market_metrics（早盘写入的行含 code / auc_pct_chg / change_pct）。
  //    用 market_metrics 而不是 auction_watchlist，天然覆盖观察组 / 打标签票（早盘同样为它们写了指标行）。
  logs.push('步骤1：读取当日 market_metrics...');
  let metrics;
  try {
    metrics = await readMarketMetricsForDate(env, today, 'auction');
  } catch (e) {
    logs.push('读取 market_metrics 失败: ' + e.message);
    return { ok: false, today, error: '读取 market_metrics 失败: ' + e.message, logs };
  }
  logs.push('market_metrics 读取 ' + metrics.length + ' 只');
  if (metrics.length === 0) {
    logs.push('❌ 当日 market_metrics 为空（早盘 9:25 可能未成功），无法覆盖收盘涨幅');
    return { ok: false, today, skipped: true, reason: '当日指标行为空', logs };
  }

  const byName = new Map();
  metrics.forEach(m => { if (!byName.has(m.name)) byName.set(m.name, m); });
  const codes = Array.from(new Set(metrics.map(m => m.code).filter(Boolean)));

  // 2. 区间涨幅窗口 [T-9, T]（与早盘同一份交易日历 / 同一个 RANGE_WINDOW_DAYS）
  let rangeDates = [];
  try {
    rangeDates = await getRecentTradingDays(env, today, RANGE_WINDOW_DAYS);
  } catch (e) {
    logs.push('区间涨幅窗口交易日获取失败: ' + e.message);
  }
  if (rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('⚠️ 区间涨幅窗口交易日历异常(' + JSON.stringify(rangeDates) + ')，本次不整段重算（退化为只换 T 腿）');
    rangeDates = [];
  }
  rangeDates.sort();

  // 3. 收盘涨幅 + 区间涨幅窗口：猫抓 daily 一次请求 → 缺失的代码再用 fuyao snapshot 兜底当日涨幅
  //    ⚠️ 兜底必须按【缺失的代码】补，而不是「猫抓整体失败才兜底」：
  //    实测猫抓 daily 对少数票（停牌/次新/代码映射缺失）当日不返回行，若只做整体兜底，
  //    这些票的 change_pct 会永远停在 9:25 竞价涨幅（9/10 实测 8 只，其中 2 只停牌属正常）。
  const closeMs = _closeCoverUtcMs(today);
  let dailyByCode = {};
  const pctByCode = new Map();
  const sources = [];
  logs.push('步骤2：猫抓 daily 获取收盘涨幅（' + codes.length + ' 个代码，窗口 ' +
    (rangeDates.length || 1) + ' 天）...');
  try {
    const win = await fetchNumcatDailyWindow(env, codes, rangeDates, today);
    dailyByCode = win.dailyByCode;
    win.pctByCode.forEach((v, k) => pctByCode.set(k, v));
    if (pctByCode.size > 0) sources.push('numcat-daily');
    logs.push('猫抓 daily 返回当日收盘涨幅 ' + pctByCode.size + ' 只，窗口含历史数据 ' +
      Object.keys(dailyByCode).length + ' 只');
  } catch (e) {
    logs.push('猫抓 daily 不可用: ' + e.message);
  }

  const missingCodes = codes.filter(c => !pctByCode.has(c));
  if (missingCodes.length > 0) {
    try {
      const snap = await fetchSnapshotChangePct(env, missingCodes);
      let filled = 0;
      Object.keys(snap.pctMap || {}).forEach(code => {
        const n = parsePct(snap.pctMap[code]);
        if (n !== null && !pctByCode.has(code)) { pctByCode.set(code, n); filled++; }
      });
      if (filled > 0) sources.push('fuyao-snapshot');
      logs.push('fuyao snapshot 补齐缺失当日涨幅 ' + filled + '/' + missingCodes.length + ' 只');
    } catch (e) {
      logs.push('fuyao snapshot 兜底失败: ' + e.message);
    }
  }

  const source = sources.join('+');
  if (pctByCode.size === 0) {
    logs.push('❌ 未能取到任何收盘涨幅（猫抓与同花顺均不可用 / 行情尚未结算），本次不覆盖');
    return { ok: false, today, error: '未能取到任何收盘涨幅', source: source || '-', logs };
  }
  logs.push('收盘涨幅来源=' + source + '，可用 ' + pctByCode.size + '/' + codes.length + ' 只');

  // 4. 覆盖 market_metrics.change_pct（只带 change_pct + updated_*，不会抹掉 volume / auc_pct_chg 等竞价字段）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricRows = [];
  metrics.forEach(m => {
    if (!m.code) return;
    if (!pctByCode.has(m.code)) return;
    const pct = pctByCode.get(m.code);
    // 幂等：值未变（无论写于何时）→ 跳过，不产生无意义的 updated_at
    const prev = parsePct(m.change_pct);
    const t = m.updated_at ? Date.parse(m.updated_at) : NaN;
    if (prev !== null && Math.abs(prev - pct) < 1e-9 && !Number.isNaN(t) && t >= closeMs) return;
    metricRows.push({
      date: today,
      stock: m.name,
      code: m.code,
      change_pct: _fmtClosePct(pct),
      scope: 'auction',
      source: 'worker',
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker-close'
    });
  });

  let written = 0;
  if (metricRows.length > 0) {
    try {
      await upsertMarketMetrics(env, metricRows);
      written = metricRows.length;
      logs.push('market_metrics 写入 ' + written + ' 行 change_pct');
    } catch (e) {
      logs.push('写入 market_metrics 失败: ' + e.message);
      return { ok: false, today, error: '写入 market_metrics 失败: ' + e.message, logs };
    }
  } else {
    logs.push('market_metrics 无需更新（已是收盘口径）');
  }

  // 5. 区间涨幅：整段重算（主通道）→ 只换 T 腿（降级，猫抓窗口不可用时）
  logs.push('步骤4：重算 stock_range_pct 区间涨幅（T 腿=当日收盘涨幅）...');
  let rangeFixed = 0;
  try {
    rangeFixed = await syncRangePct(env, today, closeMs, rangeDates, dailyByCode, pctByCode, byName, nowIso, logs);
  } catch (e) {
    logs.push('区间涨幅重算失败（非致命）: ' + e.message);
  }

  const completenessSummary = '✅ 收盘覆盖 ' + written + '/' + metrics.length + ' 只（来源=' + source +
    '），区间涨幅更新 ' + rangeFixed + ' 只';
  logs.push('数据完整性汇总: ' + completenessSummary);
  logs.push('完成: 收盘涨幅覆盖 ' + written + ' 只, 区间涨幅更新 ' + rangeFixed + ' 只');
  return {
    ok: true,
    today,
    stocksCount: metrics.length,
    pctUpdated: written,
    rangeFixed: rangeFixed,
    source: source,
    completenessSummary: completenessSummary,
    logs
  };
}

/**
 * 【区间涨幅重算 / 整段重算优先，换腿降级】
 *
 * ① 主通道（有 10 天窗口数据）：用 range-window.buildRangeRows 按 [T-9, T] 整段重算，
 *    与库内值比较 → 值/天数不同才写；天数变少则【不覆盖】（防上游返回被截断的窗口污染数据）。
 *    天然幂等，且能修复任何被冻结的错值。
 * ② 降级（猫抓不可用、当日涨幅来自同花顺 snapshot，没有历史窗口）：对库内仍是竞价口径
 *    （updated_at < 当日 15:00）且未在 ① 覆盖的行，用 replaceTDayLeg 换掉 T 腿。
 *
 * @returns {Promise<number>} 实际写入的行数
 */
async function syncRangePct(env, today, closeMs, rangeDates, dailyByCode, pctByCode, byName, nowIso, logs) {
  let storedRows;
  try {
    storedRows = await readStockRangePctForDate(env, today);
  } catch (e) {
    logs.push('读取 stock_range_pct 失败: ' + e.message);
    return 0;
  }
  const stored = new Map();
  storedRows.forEach(r => stored.set(r.stock, r));

  const out = [];
  const touched = new Set();

  // ① 整段重算
  if (rangeDates.length > 0 && Object.keys(dailyByCode).length > 0) {
    const targets = [];
    byName.forEach((m, name) => {
      if (!m.code || !pctByCode.has(m.code)) return; // 取不到当日腿的票不重算（避免算出「不含当天」的残缺区间）
      targets.push({ name: name, code: m.code });
    });
    const tLegByCode = {};
    pctByCode.forEach((v, code) => { tLegByCode[code] = v; });

    const built = buildRangeRows(targets, rangeDates, dailyByCode, tLegByCode);
    let skippedDegrade = 0;
    built.forEach(r => {
      const old = stored.get(r.stock);
      const newPct = Number(Number(r.pct).toFixed(2));
      if (old) {
        const oldPct = parsePct(old.range_pct);
        const oldDays = Number(old.days) || 0;
        if (newPct !== null && oldPct !== null && Math.abs(oldPct - newPct) < PCT_EPS && oldDays === r.days) return;
        if (oldDays > r.days) { skippedDegrade++; return; } // 不劣化覆盖
      }
      out.push({
        date: today,
        stock: r.stock,
        range_pct: newPct.toFixed(2),
        days: r.days,
        updated_at: nowIso
      });
      touched.add(r.stock);
    });
    logs.push('区间涨幅整段重算：' + built.length + ' 只参与，需更新 ' + touched.size + ' 只' +
      (skippedDegrade > 0 ? '，' + skippedDegrade + ' 只因重算天数少于库内而跳过（不劣化覆盖）' : ''));
  } else {
    logs.push('⚠️ 无 10 天窗口数据 → 区间涨幅退化为「只换 T 腿」');
  }

  // ② 降级：只换 T 腿（仅处理 ① 未覆盖、且仍是竞价口径的行）
  storedRows.forEach(r => {
    if (touched.has(r.stock)) return;
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    if (Number.isNaN(t) || !t || t >= closeMs) return; // 已是收盘口径 → 不动
    const old = parsePct(r.range_pct);
    if (old === null) return;
    const m = byName.get(r.stock);
    if (!m || !m.code || !pctByCode.has(m.code)) return;
    const next = replaceTDayLeg(old, parsePct(m.auc_pct_chg), pctByCode.get(m.code));
    if (next === null || !isFinite(next)) return;
    out.push({
      date: today,
      stock: r.stock,
      range_pct: Number(next).toFixed(2),
      days: r.days,
      updated_at: nowIso
    });
  });

  if (out.length === 0) {
    logs.push('区间涨幅无需更新（已是收盘口径）');
    return 0;
  }
  await upsertStockRangePct(env, out);
  return out.length;
}
