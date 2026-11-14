// index-legs.js — 云端写「官方对应指数的逐日涨幅腿」（market_metrics, scope='index'）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【它解决什么】前端算「交易所官方收盘价格涨跌幅偏离值」需要【对应指数】的逐日涨幅
//   （沪主板=上证A股指数 sh000002／深主板=深证A股指数 sz399107／
//     创业板=创业板综指 sz399102／科创板=科创50 sh000688）。
//   用户硬红线「全部云端运行、关电脑也能用」⇒ 这个序列必须由 Worker 落库，
//   ⛔ 不许只在浏览器里现拉腾讯（那样换台电脑就得重拉，且离线打不开）。
//
// 【为什么挂在 closepost（16:03）而不是 close（16:00）】
//   🔴 血泪教训（11-13 生产日志）：免费版单次 invocation 只有 **50 次 subrequest**。
//   16:00 主轮跑完 runClose + snapshotPatch + dailyLegsHeal 已接近上限，再塞任何补写任务
//   就会爆 `Too many subrequests by single Worker invocation`，连运行日志都发不出去。
//   本模块 = 4 次腾讯日线 + 1 次 upsert = 5 次 subrequest，必须放在**独立的闭市后一轮**。
//
// 【为什么用腾讯而不是同花顺】
//   · 0 猫抓额度（额度 10 次/天要留给 9:25 竞价量比）；
//   · `qt-kline` 与 `stock_daily_pct` 逐日腿【同一个源】，偏差口径一致；
//   · 指数不需要前复权，日线稳定。
//
// 【§10 / §11】
//   · 取不到的指数 ⇒ 不写行（⛔ 不补 0、⛔ 不拿别的指数顶替）；
//   · 只 upsert 最近 N 个自然日的腿（幂等：PK=(date,stock,scope)，重复写不产生新行）；
//   · ⛔ 不删任何行、⛔ 不碰 scope='auction' / 'hot' 的数据。
// ══════════════════════════════════════════════════════════════════════════════════════

import { beijingToday } from '../../_shared-source/date-utils.js';
import { upsertMarketMetrics } from '../data/supabase-write.js';

const QT_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const QT_TIMEOUT_MS = 9000;

/**
 * 官方对应指数（⛔ 与前端 `logic/auction/abnormal-deviation.js#DEV_INDEX` 必须逐字一致；
 * 四家指数是交易所条文规定的，不是本项目自选）。
 */
export const INDEX_LEG_TARGETS = [
  { code: 'sh000002', name: '上证A股指数' },
  { code: 'sz399107', name: '深证A股指数' },
  { code: 'sz399102', name: '创业板综指' },
  { code: 'sh000688', name: '科创50' }
];

/**
 * 每次回补多少个自然日。
 *
 * 🔴 [ABN-DEV-FIX 2026-11-14] 由 20 改成 70 —— 20 个自然日只够 ~14 根腿，
 *   而官方【30 日偏离】要 30 根腿 ⇒ `cumulativeDeviation(stock, idx, 30)` 恒判 null
 *   ⇒ 面板上 5 只票「覆盖 0/5」，一个偏离值都出不来（11-14 亲测）。
 *   30 交易日 ≈ 44 自然日，留到 70 天兜住国庆 / 春节长假。
 *   行数：~48 个交易日 × 4 个指数 = 192 行，1 次 upsert，不占额外 subrequest。
 */
export const INDEX_LEGS_LOOKBACK_DAYS = 70;

function _ymd(d) { return d.toISOString().slice(0, 10); }
function _shift(ymd, n) {
  const t = Date.parse(String(ymd) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return String(ymd);
  return _ymd(new Date(t + n * 86400000));
}

/** '+0.55' 这种文本（与 market_metrics 其它 scope 的 change_pct 同一约定） */
export function fmtPct(v) {
  // ⚠️ `Number(null) === 0` ⇒ 必须先挡掉 null/空串，否则「缺数据」会被写成 +0.00%（§10 事故经典）
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/**
 * 【纯函数】收盘序列 → 逐日涨幅腿（第一根没有前收 ⇒ 不出腿）。
 * @param {Array<{date:string, close:number}>} bars
 * @returns {Array<{date:string, pct:number}>}
 */
export function barsToLegs(bars) {
  const out = [];
  const arr = Array.isArray(bars) ? bars : [];
  for (let i = 1; i < arr.length; i++) {
    const a = Number(arr[i - 1] && arr[i - 1].close);
    const b = Number(arr[i] && arr[i].close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    out.push({ date: String(arr[i].date).slice(0, 10), pct: (b / a - 1) * 100 });
  }
  return out;
}

/**
 * 【纯函数】把「每只指数的日线」拼成要 upsert 的行（便于单测锁住形状 / 幂等 / §10 语义）。
 *
 * @param {Map<string, Array<{date:string, close:number}>>} barsByCode
 * @param {string} [fromDate] 只写 ≥ 这一天的腿（缺省 = 全写）
 * @returns {Array<{date:string, stock:string, code:string, change_pct:string, scope:string, updated_at:string}>}
 */
export function buildIndexLegRows(barsByCode, fromDate, nowIso) {
  const rows = [];
  const from = fromDate ? String(fromDate).slice(0, 10) : '';
  INDEX_LEG_TARGETS.forEach(function (t) {
    const bars = barsByCode && typeof barsByCode.get === 'function' ? barsByCode.get(t.code) : null;
    if (!bars || !bars.length) return;                    // §10：取不到 ⇒ 不写，⛔ 不补 0
    barsToLegs(bars).forEach(function (l) {
      if (from && l.date < from) return;
      const pct = fmtPct(l.pct);
      if (pct === null) return;
      rows.push({
        date: l.date,
        stock: t.name,
        code: t.code,
        change_pct: pct,
        scope: 'index',
        updated_at: nowIso || new Date().toISOString()
      });
    });
  });
  return rows;
}

/** 拉一只指数的日线（腾讯 ifzq；失败 ⇒ 空数组，⛔ 不抛） */
async function _fetchIndexBars(sym, fromYmd, toYmd) {
  const url = QT_BASE + '?param=' + sym + ',day,' + fromYmd + ',' + toYmd + ',320,qfq';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(QT_TIMEOUT_MS) : undefined
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    const d = (j && j.data && j.data[sym]) || {};
    const raw = d.qfqday || d.day || [];
    const out = [];
    raw.forEach(function (b) {
      if (!Array.isArray(b) || !b[0]) return;
      const close = Number(b[2]);
      if (!Number.isFinite(close) || close <= 0) return;
      out.push({ date: String(b[0]).slice(0, 10), close: close });
    });
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * 收盘后写「指数逐日腿」。
 *
 * @param {object} env
 * @param {object} [opts] { date='YYYY-MM-DD', lookbackDays=20 }
 * @returns {Promise<{ok:boolean, written:number, dates:number, missing:string[], logs:string[]}>}
 */
export async function runIndexLegsWrite(env, opts) {
  const o = opts || {};
  const logs = [];
  const today = String(o.date || beijingToday()).slice(0, 10);
  const lookback = Number(o.lookbackDays) > 0 ? Number(o.lookbackDays) : INDEX_LEGS_LOOKBACK_DAYS;
  const from = _shift(today, -lookback);

  const barsByCode = new Map();
  const missing = [];
  for (let i = 0; i < INDEX_LEG_TARGETS.length; i++) {
    const t = INDEX_LEG_TARGETS[i];
    // ⚠️ 串行而不是并发：4 次请求不值得为并发多占一次 subrequest 预算判断的心智，
    //    而且串行失败隔离更清楚（哪只挂了一眼能看出来）。
    const bars = await _fetchIndexBars(t.code, from, today);
    if (!bars.length) { missing.push(t.code); continue; }
    barsByCode.set(t.code, bars);
  }
  logs.push('指数日线可用 ' + (INDEX_LEG_TARGETS.length - missing.length) + '/' +
    INDEX_LEG_TARGETS.length + '（' + from + '~' + today + '）');
  if (missing.length > 0) {
    logs.push('⚠️ 取不到（这些板块的偏离值将算不出）: ' + missing.join('、'));
  }

  const rows = buildIndexLegRows(barsByCode, from, new Date().toISOString());
  if (rows.length === 0) {
    logs.push('⛔ 一条腿都没有 ⇒ 不写库（§10 缺数据不补 0）');
    return { ok: false, written: 0, dates: 0, missing: missing, logs: logs };
  }
  const dates = new Set(rows.map(function (r) { return r.date; })).size;
  try {
    await upsertMarketMetrics(env, rows);
    logs.push('✅ 写入指数腿 ' + rows.length + ' 行 / ' + dates + ' 个交易日');
    return { ok: true, written: rows.length, dates: dates, missing: missing, logs: logs };
  } catch (e) {
    logs.push('❌ 写 market_metrics(scope=index) 失败: ' + ((e && e.message) || e));
    return { ok: false, written: 0, dates: dates, missing: missing, logs: logs };
  }
}
