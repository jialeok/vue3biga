// extras-workflow.js — 「竞价四要素」补漏（runAuctionExtrasPatch）
//
// 【为什么要单独一个补漏任务 / 2026-09-11 取证结论】
//   竞价四要素 = 未匹配量(um_vol) / 抢筹幅度(open_bid_pct) / 竞价量比(auc_vol_ratio) /
//               真换手率(auc_turnover)，是趋势图右侧与「量比抢筹高光」的核心判据。
//
//   猫抓 daily_auc 对【当日】这一行**不返回**这四个字段的值，只返回
//   auc_vol / auc_pct_chg / auc_to_pre_vol_pct；四要素要等这一天结算后才出现。
//   取证（.tmpdiag/diag_last_write.mjs，全表 3692 行，只读）：
//     · 9/11 同一轮写入（01:29:56~01:30:03）里：9/10 = 60/67 有四要素，9/11 = 0/67 全空；
//     · 全表唯一「最后一个写入时刻 = 当天」的日期就是 9/11，它四要素为 0；
//     · 8/07 起的每个历史日，四要素都是被【后续几天的窗口重刷】时才带上的。
//   ⇒ 9:25 早盘永远拿不到「当天」的四要素，重试只是白等（还会顶穿 9:26 硬指标），
//     必须有一个「结算后补写」的任务 —— 就是本文件。
//
// 【触发点】
//   ① 北京 16:00 close 主流程末尾自动跑（复用既有 cron，不需要新增触发器）；
//   ② 手动 /fetch?point=extras（想当天立刻看到 / 补历史缺口时用）。
//
// [QUOTA 2026-09-11] 自动跑时【排除当前交易日】：猫抓「当天不给四要素」是既定行为，
//   把今天算进待补集合的唯一效果 = 每天都白烧 1 次额度。实测：9/11 16:00 的补漏 patched=0，
//   而当天 9/11 的四要素依旧是 0/67（查询 market_metrics 证实 updated_by=*-close 48 行全空）。
//   现在只有「确实存在可补的历史缺口」才发 numcat 请求；窗口内全完整 → 零请求直接返回。
//   手动调用传 includeToday:true 可保留「含今天」的旧行为（用于排查）。
//
// 【安全约束（§11 删除安全 / §10 静默失败）】
//   · 只写这四个字段。upsert 用 resolution=merge-duplicates + missing=default，
//     绝不会抹掉 volume / change_pct / auc_pct_chg / yest_volume；
//   · 只有「库内该行四要素有缺失」且「numcat 本次给了非空值」才写 → 天然幂等，重复跑零副作用；
//   · 读取失败必须抛错，绝不能被当成「全都缺」而整体覆盖；
//   · 整体失败不致命，调用方 try/catch 后继续。

import { beijingToday, compactToDateStr } from '../../_shared-source/date-utils.js';
import { numcatDailyAuc } from '../data/numcat-api.js';
import { upsertMarketMetrics, readMarketMetricsExtrasForDate } from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
import { RANGE_WINDOW_DAYS } from '../../../src/logic/auction/range-window.js';

// ⚠️ 单文件打包（workers/_bundle.mjs）会把所有模块拼进同一个作用域，
//    顶层标识符必须全局唯一 —— 这里一律加 extras 前缀，避免与其它文件重名导致重复声明。
const EXTRAS_FIELDS = ['um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];
/** 单次 upsert 的行数（Supabase 单次请求不宜过大） */
const EXTRAS_CHUNK = 400;

function extrasIsEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** 未匹配量：numcat 给的是「手」，库内存「万手」（与 volume 同口径，÷100 取整） */
function extrasFmtUmVol(v) {
  const n = Number(v);
  return isNaN(n) ? '' : String(Math.round(n / 100));
}

/** 其余三项都是百分数 / 倍数，统一保留 2 位小数 */
function extrasFmt2(v) {
  const n = Number(v);
  return isNaN(n) ? '' : n.toFixed(2);
}

/**
 * 补写竞价四要素。
 * @param {object} env      worker env（需要 SUPABASE_* 与 NUMCAT_API_KEY）
 * @param {object} [opts]   { days?: number, logs?: string[], dates?: string[], includeToday?: boolean }
 *        includeToday=false（默认）：自动跑时排除当前交易日 —— 当天四要素猫抓不给，
 *        把它算进待补只会每天白烧一次额度（实测 9/11 16:00 patched=0 且当天仍 0/67）。
 * @returns {Promise<{ok:boolean, today:string, patched:number, dates:string[], logs:string[]}>}
 */
export async function runAuctionExtrasPatch(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = beijingToday();
  const days = Number(o.days) || RANGE_WINDOW_DAYS;
  const includeToday = !!o.includeToday;
  logs.push('[extras] 竞价四要素补漏开始 today=' + today + (includeToday ? '（含今天）' : '（自动排除今天）'));

  // 1. 交易日窗口（默认 [T-9, T]，与早盘/收盘同一份交易日历）
  let dates = Array.isArray(o.dates) && o.dates.length > 0 ? o.dates.slice() : [];
  if (dates.length === 0) {
    try {
      dates = await getRecentTradingDays(env, today, days);
    } catch (e) {
      logs.push('[extras] 交易日历获取失败: ' + e.message);
    }
  }
  if (dates.length === 0) {
    logs.push('[extras] ⚠️ 无可用交易日，跳过');
    return { ok: false, today, patched: 0, dates: [], logs, reason: '无可用交易日' };
  }
  dates.sort();
  // [QUOTA 2026-09-11] 自动跑排除「今天」：当天四要素永远拿不到，见文件头说明。
  if (!includeToday) dates = dates.filter(d => d !== today);
  if (dates.length === 0) {
    logs.push('[extras] ✅ 待补窗口内只剩当天（当天四要素猫抓不提供）→ 零请求直接返回');
    return { ok: true, today, patched: 0, dates: [], logs, reason: '只剩当天' };
  }
  const startYMD = dates[0].replace(/-/g, '');
  const endYMD = dates[dates.length - 1].replace(/-/g, '');

  // 2. 读库内现状：只补「有缺失」的行（§10：读取失败必须抛错，不能当成全缺）
  const existing = {};   // date -> Map(name -> row)
  let missingTotal = 0;
  for (const d of dates) {
    let rows;
    try {
      rows = await readMarketMetricsExtrasForDate(env, d);
    } catch (e) {
      logs.push('[extras] ❌ 读取 ' + d + ' 失败（中断，避免误覆盖）: ' + e.message);
      return { ok: false, today, patched: 0, dates: dates, logs, error: e.message };
    }
    const m = new Map();
    rows.forEach(r => {
      if (!m.has(r.name)) m.set(r.name, r);
      if (EXTRAS_FIELDS.some(f => extrasIsEmpty(r[f]))) missingTotal++;
    });
    existing[d] = m;
  }
  logs.push('[extras] 窗口 ' + dates.length + ' 天，库内缺四要素的行 ' + missingTotal + ' 行');
  if (missingTotal === 0) {
    logs.push('[extras] ✅ 窗口内四要素已完整，无需补写');
    return { ok: true, today, patched: 0, dates: dates, logs };
  }

  // 3. 一次 numcat daily_auc 拿整个窗口（请求数与「只拉今天」相同）
  const codeSet = new Set();
  dates.forEach(d => existing[d].forEach(r => { if (r.code) codeSet.add(r.code); }));
  const codes = Array.from(codeSet);
  if (codes.length === 0) {
    logs.push('[extras] ⚠️ 库内无可用的股票代码，跳过');
    return { ok: false, today, patched: 0, dates: dates, logs, reason: '无可用代码' };
  }

  let data;
  try {
    data = await numcatDailyAuc(env, codes.join(','), startYMD, endYMD);
  } catch (e) {
    logs.push('[extras] ❌ numcat daily_auc 失败: ' + e.message);
    return { ok: false, today, patched: 0, dates: dates, logs, error: e.message };
  }
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  const symI = fields.indexOf('symbol');
  const dateI = fields.indexOf('tradedate');
  const idx = {
    um_vol: fields.indexOf('um_vol'),
    open_bid_pct: fields.indexOf('open_bid_pct'),
    auc_vol_ratio: fields.indexOf('auc_vol_ratio'),
    auc_turnover: fields.indexOf('auc_turnover')
  };
  if (symI < 0 || dateI < 0) {
    logs.push('[extras] ❌ numcat 返回字段不完整: ' + JSON.stringify(fields));
    return { ok: false, today, patched: 0, dates: dates, logs, error: '字段不完整' };
  }
  if (EXTRAS_FIELDS.some(f => idx[f] < 0)) {
    logs.push('[extras] ⚠️ numcat 本次未返回全部四要素字段: ' + JSON.stringify(idx));
  }
  logs.push('[extras] numcat 返回 ' + items.length + ' 行');

  // 4. 只补「库内缺 + 本次有值」的行
  const nowIso = new Date().toISOString();
  const rows = [];
  items.forEach(row => {
    const code = String(row[symI] || '').trim();
    const dateStr = compactToDateStr(String(row[dateI] || '').trim());
    if (!code || !dateStr || !existing[dateStr]) return;

    const byName = existing[dateStr];
    // 同一 code 可能对应库内多行（理论上不会），这里全补
    byName.forEach(cur => {
      if (cur.code && cur.code !== code) return;
      const patch = { date: dateStr, stock: cur.name, scope: 'auction' };
      if (cur.code) patch.code = cur.code;
      let any = false;
      if (extrasIsEmpty(cur.um_vol) && idx.um_vol >= 0) {
        const v = extrasFmtUmVol(row[idx.um_vol]);
        if (v !== '') { patch.um_vol = v; any = true; }
      }
      if (extrasIsEmpty(cur.open_bid_pct) && idx.open_bid_pct >= 0) {
        const v = extrasFmt2(row[idx.open_bid_pct]);
        if (v !== '') { patch.open_bid_pct = v; any = true; }
      }
      if (extrasIsEmpty(cur.auc_vol_ratio) && idx.auc_vol_ratio >= 0) {
        const v = extrasFmt2(row[idx.auc_vol_ratio]);
        if (v !== '') { patch.auc_vol_ratio = v; any = true; }
      }
      if (extrasIsEmpty(cur.auc_turnover) && idx.auc_turnover >= 0) {
        const v = extrasFmt2(row[idx.auc_turnover]);
        if (v !== '') { patch.auc_turnover = v; any = true; }
      }
      if (!any) return;
      patch.source = 'worker';
      patch.updated_at = nowIso;
      patch.updated_by = 'auto-fetch-worker-extras';
      rows.push(patch);
      // 补过之后就地标记，避免同一行被重复写入
      EXTRAS_FIELDS.forEach(f => { if (patch[f] !== undefined) cur[f] = patch[f]; });
    });
  });

  if (rows.length === 0) {
    logs.push('[extras] ⚠️ numcat 本次未给出任何可补的四要素值（当日未结算时属正常，次日窗口重刷会自动补上）');
    return { ok: true, today, patched: 0, dates: dates, logs };
  }

  // 5. 分批写入
  let patched = 0;
  for (let i = 0; i < rows.length; i += EXTRAS_CHUNK) {
    const chunk = rows.slice(i, i + EXTRAS_CHUNK);
    try {
      await upsertMarketMetrics(env, chunk);
      patched += chunk.length;
    } catch (e) {
      logs.push('[extras] ❌ 第 ' + (Math.floor(i / EXTRAS_CHUNK) + 1) + ' 批写入失败: ' + e.message);
    }
  }
  logs.push('[extras] ✅ 补写 ' + patched + '/' + rows.length + ' 行竞价四要素');
  return { ok: patched > 0, today, patched: patched, dates: dates, logs };
}
