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
// 【KLINE-FALLBACK 2026-09-11】猫抓额度（每天 10 次）在 16:00 常已用尽 → 整段重算拿不到窗口，
//   于是「缺腿行」（days < 窗口，例：次日继承票当时没有 T 腿）永远修不好（实测 7 只错值，
//   国芳集团 91.11%）。现在补一条【同花顺 K 线】通道（无额度限制）专门重算缺腿行，
//   让区间涨幅的修复完全不依赖猫抓额度。缺腿行【绝不】做代数换腿。
//
// 【幂等】re-run 安全：change_pct 值相同不写；区间涨幅值/天数相同不写。

import { beijingToday, isWeekend } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { numcatDaily } from '../data/numcat-api.js';
import { fetchSnapshotChangePct, fetchFuyaoKlineWindowPct } from '../data/fuyao-api.js';
import {
  upsertMarketMetrics,
  upsertStockRangePct,
  readMarketMetricsForDate,
  readStockRangePctForDate
} from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
// [EXTRAS-PATCH 2026-09-11] 竞价四要素（未匹配量/抢筹幅度/竞价量比/真换手率）补漏：
// 猫抓 daily_auc 对【当日】行不返回这四个字段，必须等结算后补写 —— 16:00 正是最合适的时机。
import { runAuctionExtrasPatch } from './extras-workflow.js';
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

/**
 * @param {object} env
 * @param {{date?:string}} [opts] date='YYYY-MM-DD' 可指定要覆盖的交易日（默认=北京今天）。
 *        用途：[REPAIR-DATE 2026-09-11] 手动修复历史某天（例如 9:25 写出过缺腿区间涨幅、
 *        或当天收盘覆盖没跑成）。交易日闸门校验的是【该参数日期】而非当前时刻，
 *        因此周末/盘后也能补修过去某一天。不传则完全保持原行为（= 补抓当天）。
 */
export async function runClose(env, opts) {
  const logs = [];
  const today = (opts && opts.date) || beijingToday();
  logs.push('today=' + today + (opts && opts.date ? '（手动指定日期）' : ''));

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

  // 6. [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏。
  //    放在最后：① 16:00 当日已结算，猫抓这时才给四要素；② 它只写四个字段（merge 语义），
  //    不影响前面的 change_pct 覆盖；③ 失败不致命 —— 最迟次日早盘窗口重刷也会自动补上。
  logs.push('步骤5：补写竞价四要素（未匹配量/抢筹幅度/竞价量比/真换手率）...');
  let extrasPatched = 0;
  try {
    // [QUOTA 2026-09-11] 只传窗口、不传 [today] 兜底：四要素补漏默认【排除当天】
    // （猫抓对当日行不给这四个字段，算进待补集合只是白烧 1 次额度）。
    // rangeDates 为空时交给函数自取默认窗口（同样是 [T-9,T] 再去掉今天）。
    const ex = await runAuctionExtrasPatch(env, { logs: logs, dates: rangeDates });
    extrasPatched = ex.patched || 0;
  } catch (e) {
    logs.push('竞价四要素补漏失败（非致命）: ' + e.message);
  }

  const completenessSummary = '✅ 收盘覆盖 ' + written + '/' + metrics.length + ' 只（来源=' + source +
    '），区间涨幅更新 ' + rangeFixed + ' 只，竞价四要素补写 ' + extrasPatched + ' 行';
  logs.push('数据完整性汇总: ' + completenessSummary);
  logs.push('完成: 收盘涨幅覆盖 ' + written + ' 只, 区间涨幅更新 ' + rangeFixed + ' 只, 四要素补写 ' + extrasPatched + ' 行');
  return {
    ok: true,
    today,
    stocksCount: metrics.length,
    pctUpdated: written,
    rangeFixed: rangeFixed,
    extrasPatched: extrasPatched,
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
 * ①b [KLINE-FALLBACK 2026-09-11] 缺腿行专修（猫抓额度用尽时的唯一出路）：对库内
 *    `days < 窗口` 的行，用同花顺 K 线（无额度限制）重新组装 [T-9, T] 整段 → 同样
 *    「不劣化才覆盖」。没有它时这类行既不会被 ① 覆盖（猫抓拿不到窗口），也会被 ② 跳过。
 * ② 降级（猫抓不可用、当日涨幅来自同花顺 snapshot，没有历史窗口）：对库内仍是竞价口径
 *    （updated_at < 当日 15:00）且未在 ①/①b 覆盖的【完整行】，用 replaceTDayLeg 换掉 T 腿。
 *    缺腿行（days < 窗口）绝不换腿（代数反解必然更错，见 RANGE-FULL-LEG）。
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

  // ①b [KLINE-FALLBACK 2026-09-11] 缺腿行专修：猫抓窗口不可用时改用同花顺 K 线整段重算。
  //   为什么必须单列这一步：① 依赖猫抓 daily（每天仅 10 次额度，16:00 常已用尽）；
  //   ②（换腿）对缺腿行【主动跳过】（代数反解必然更错）。两者叠加 → 缺腿行永远修不好
  //   （2026-09-11 实测 7 只：国芳集团 91.11% / 百大集团 43.67% …全部是昨日错值）。
  //   同花顺 K 线无额度限制 → 用它对「库内 days < 窗口」的行重新组装，让修复不依赖猫抓。
  //   只处理缺腿行（通常个位数），并发 3 + 重试 + 熔断在 fetchFuyaoKlineWindowPct 内部。
  if (rangeDates.length > 0) {
    const incomplete = [];
    storedRows.forEach(r => {
      if (touched.has(r.stock)) return;
      const d = Number(r.days) || 0;
      if (d <= 0 || d >= rangeDates.length) return; // 只修缺腿行（完整行已由 ①/② 负责）
      const m = byName.get(r.stock);
      if (!m || !m.code) return;
      incomplete.push({ name: r.stock, code: m.code });
    });
    if (incomplete.length > 0) {
      try {
        const kByCode = await fetchFuyaoKlineWindowPct(env, incomplete, rangeDates, { concurrency: 3 });
        const dailyByCode2 = {};
        const tLegByCode2 = {};
        const targets2 = [];
        const tDash = today;
        incomplete.forEach(t => {
          const dm = kByCode.get(t.name);
          if (!dm) return;
          const hist = {};
          rangeDates.forEach(d => {
            if (d === tDash) return;
            const ymd = String(d).replace(/-/g, '');
            const v = dm.get(ymd);
            if (v !== undefined && isFinite(v)) hist[ymd] = v;
          });
          dailyByCode2[t.code] = hist;
          const tv = dm.get(String(tDash).replace(/-/g, ''));
          if (tv !== undefined && isFinite(tv)) tLegByCode2[t.code] = tv;
          targets2.push({ name: t.name, code: t.code });
        });
        let klineFixed = 0;
        if (targets2.length > 0) {
          const built2 = buildRangeRows(targets2, rangeDates, dailyByCode2, tLegByCode2);
          built2.forEach(r => {
            const old = stored.get(r.stock);
            const newPct = Number(Number(r.pct).toFixed(2));
            if (old) {
              const oldPct = parsePct(old.range_pct);
              const oldDays = Number(old.days) || 0;
              if (oldDays > r.days) return; // 不劣化覆盖（K 线窗口也不全时宁可不写）
              if (newPct !== null && oldPct !== null && Math.abs(oldPct - newPct) < PCT_EPS && oldDays === r.days) return;
            }
            out.push({
              date: today,
              stock: r.stock,
              range_pct: newPct.toFixed(2),
              days: r.days,
              updated_at: nowIso
            });
            touched.add(r.stock);
            klineFixed++;
          });
        }
        logs.push('区间涨幅缺腿行 K 线重算：' + incomplete.length + ' 只缺腿，K 线返回 ' +
          targets2.length + ' 只，修正 ' + klineFixed + ' 只');
      } catch (e) {
        logs.push('区间涨幅缺腿行 K 线重算失败（非致命）: ' + e.message);
      }
    }
  }

  // ② 降级：只换 T 腿（仅处理 ① 未覆盖、且仍是竞价口径的行）
  let skippedIncomplete = 0;
  storedRows.forEach(r => {
    if (touched.has(r.stock)) return;
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    if (Number.isNaN(t) || !t || t >= closeMs) return; // 已是收盘口径 → 不动
    const old = parsePct(r.range_pct);
    if (old === null) return;
    // [RANGE-FULL-LEG 2026-09-11] 缺腿行不做代数换算：replaceTDayLeg 假定「已存值含竞价 T 腿」，
    // 而缺腿行当时根本没进来 T 腿（days < 窗口）→ 换算只会算得更错（国芳 81.17% → 91.11%）。
    // 这类行只能靠整段重算：① 猫抓窗口 / ①b 同花顺 K 线窗口；两者都不可用时宁可不写（§10）。
    if (Number(r.days) < RANGE_WINDOW_DAYS) { skippedIncomplete++; return; }
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
    logs.push('区间涨幅无需更新（已是收盘口径）' +
      (skippedIncomplete > 0 ? '；另有 ' + skippedIncomplete + ' 个缺腿行未做换腿（不写错值，待下次整段重算）' : ''));
    return 0;
  }
  if (skippedIncomplete > 0) {
    logs.push('⚠️ 有 ' + skippedIncomplete + ' 个缺腿行（days < ' + RANGE_WINDOW_DAYS +
      '）不做换腿换算：只能靠整段重算（猫抓窗口 / 同花顺 K 线）修好');
  }
  await upsertStockRangePct(env, out);
  return out.length;
}
