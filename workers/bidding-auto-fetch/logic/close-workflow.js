// close-workflow.js — 收盘涨幅覆盖主流程（runClose）
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
//   ② [方案A] 把 stock_range_pct 的「当天(T)腿」从竞价口径换成收盘口径 —— 0 额外请求：
//        prevAcc = 已存区间涨幅 ÷(1+竞价腿)，新区间涨幅 = prevAcc ×(1+收盘腿)。
//        口径实现在 src/logic/auction/range-window.js（前后端单一真相，见 replaceTDayLeg）。
//
// 【幂等】re-run 安全：
//   · change_pct：已是收盘口径（updated_at >= 当日 15:00）的行不再重写；
//   · T 腿：校正后 updated_at 变成现在（> 15:00），下次运行自动跳过。

import { beijingToday, isWeekend, compactToDateStr } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { numcatDaily } from '../data/numcat-api.js';
import { fetchSnapshotChangePct } from '../data/fuyao-api.js';
import {
  upsertMarketMetrics,
  upsertStockRangePct,
  readMarketMetricsForDate,
  readStockRangePctForDate
} from '../data/supabase-write.js';
// 区间涨幅 T 腿口径单一真相（纯函数，前端 close-pct-cover 共用同一份实现）
// ⚠️ 单文件打包（_bundle.mjs）会把本文件与 range-window.js 拼进同一个作用域，
//    因此这里【复用】range-window 的 parsePct，不再自己定义一份（同名会直接报重复声明）。
import { replaceTDayLeg, parsePct } from '../../../src/logic/auction/range-window.js';

/** 北京时间 15:00 收盘（与前端 close-pct-cover / dragon-rank 同口径） */
const CLOSE_HOUR = 15;

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
 * 猫抓 daily 拉当日收盘涨幅 → Map<code, number>。
 * 与早盘步骤5 同一个接口（symbol,tradedate,pct_chg），1 次请求覆盖全市场。
 */
async function fetchNumcatClosePct(env, codes, today) {
  const ymd = today.replace(/-/g, '');
  const symbols = codes.join(',');
  const data = await numcatDaily(env, symbols, ymd, ymd);
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  const sIdx = fields.indexOf('symbol');
  const dIdx = fields.indexOf('tradedate');
  const pIdx = fields.indexOf('pct_chg');
  const out = new Map();
  if (sIdx < 0 || dIdx < 0 || pIdx < 0) return out;
  items.forEach(row => {
    const code = String(row[sIdx] || '').trim();
    const d = compactToDateStr(String(row[dIdx] || '').trim());
    const raw = row[pIdx];
    if (!code || d !== today || raw === null || raw === undefined || raw === '') return;
    const n = Number(raw);
    if (!isNaN(n)) out.set(code, n);
  });
  return out;
}

export async function runClose(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 名单 + 旧 T 腿来源：market_metrics（早盘写入的行含 code / auc_pct_chg / change_pct）。
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

  // 2. 收盘涨幅：猫抓 daily 主通道（1 次请求）→ 缺失的代码再用 fuyao snapshot 兜底
  //    ⚠️ 兜底必须按【缺失的代码】补，而不是「猫抓整体失败才兜底」：
  //    实测猫抓 daily 对少数票（停牌/次新/代码映射缺失）当日不返回行，若只做整体兜底，
  //    这些票的 change_pct 会永远停在 9:25 竞价涨幅（9/10 实测 8 只，其中 2 只停牌属正常）。
  const closeMs = _closeCoverUtcMs(today);
  const pctByCode = new Map();
  const sources = [];
  logs.push('步骤2：获取收盘涨幅（' + codes.length + ' 个代码）...');
  try {
    const byCode = await fetchNumcatClosePct(env, codes, today);
    byCode.forEach((v, k) => pctByCode.set(k, v));
    if (pctByCode.size > 0) sources.push('numcat-daily');
    logs.push('猫抓 daily 返回 ' + pctByCode.size + ' 只');
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
      logs.push('fuyao snapshot 补齐缺失 ' + filled + '/' + missingCodes.length + ' 只');
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

  // 3. 覆盖 market_metrics.change_pct（只带 change_pct + updated_*，不会抹掉 volume / auc_pct_chg 等竞价字段）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricRows = [];
  metrics.forEach(m => {
    if (!m.code) return;
    if (!pctByCode.has(m.code)) return;
    const pct = pctByCode.get(m.code);
    // 幂等：已经是收盘口径（写于当日 15:00 之后）且值未变 → 跳过（省写入，不产生无意义 updated_at）
    const t = m.updated_at ? Date.parse(m.updated_at) : NaN;
    const prev = parsePct(m.change_pct);
    if (!Number.isNaN(t) && t >= closeMs && prev !== null && Math.abs(prev - pct) < 1e-9) return;
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

  // 4. [方案A] 区间涨幅 T 腿口径校正（0 额外请求）
  logs.push('步骤4：校正 stock_range_pct 的当天(T)腿...');
  let rangeFixed = 0;
  try {
    rangeFixed = await syncRangeTDay(env, today, closeMs, byName, pctByCode, nowIso, logs);
  } catch (e) {
    logs.push('区间涨幅 T 腿校正失败（非致命）: ' + e.message);
  }

  const completenessSummary = '✅ 收盘覆盖 ' + written + '/' + metrics.length + ' 只（来源=' + source +
    '），区间涨幅 T 腿校正 ' + rangeFixed + ' 只';
  logs.push('数据完整性汇总: ' + completenessSummary);
  logs.push('完成: 收盘涨幅覆盖 ' + written + ' 只, 区间涨幅 T 腿 ' + rangeFixed + ' 只');
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
 * 【区间涨幅 T 腿口径校正 / 方案A】
 * 早盘 worker 用【竞价涨幅】做 T 腿把区间涨幅算好并落库；收盘后 T 腿应改成【收盘涨幅】。
 * 区间涨幅是复利累乘，只需把 T 腿那一项换掉，无需重新拉 9 天历史日线（0 额外请求）：
 *   prevAcc = (1 + 已存区间涨幅) ÷ (1 + 竞价腿)
 *   新区间涨幅 = prevAcc × (1 + 收盘腿) - 1
 * 口径实现在 range-window.js#replaceTDayLeg（与前端 close-pct-cover 共用，单一真相）。
 */
async function syncRangeTDay(env, today, closeMs, byName, pctByCode, nowIso, logs) {
  let rangeRows;
  try {
    rangeRows = await readStockRangePctForDate(env, today);
  } catch (e) {
    logs.push('读取 stock_range_pct 失败: ' + e.message);
    return 0;
  }
  if (rangeRows.length === 0) {
    logs.push('stock_range_pct 当日无行（早盘未写入？），跳过 T 腿校正');
    return 0;
  }

  const out = [];
  rangeRows.forEach(r => {
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    // 已是收盘口径（写于 15:00 之后）→ 不重复换算（幂等）
    if (Number.isNaN(t) || !t || t >= closeMs) return;
    const old = parsePct(r.range_pct);
    if (old === null) return;
    const m = byName.get(r.stock);
    if (!m || !m.code) return;            // 没有代码 → 取不到收盘涨幅，保持现状
    if (!pctByCode.has(m.code)) return;
    const closePct = pctByCode.get(m.code);
    const aucLeg = parsePct(m.auc_pct_chg); // 旧的 T 腿 = 早盘写入的竞价涨幅
    const next = replaceTDayLeg(old, aucLeg, closePct);
    if (next === null || !isFinite(next)) return;
    out.push({ date: today, stock: r.stock, range_pct: Number(next).toFixed(2), days: r.days, updated_at: nowIso });
  });

  if (out.length === 0) return 0;
  await upsertStockRangePct(env, out);
  return out.length;
}
