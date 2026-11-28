// deviation-trend.js — 「官方偏离值 · 5 日趋势」的唯一算法层（纯函数 + 取数编排，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【用户口径（2026-11-28 原话）】
//   「在题材量比的选股侧的买点和卖点侧的股票下面添加官方偏离值的趋势图，五日的……
//     趋势图分为两部分，上面是竞价口径，下面是收盘口径。五日曲线图，连在一起。
//     比如小标签是 10 日，就做 10 日偏离值的，如果是 30 日的，就做 30 日偏离值的……
//     如果逼近红线用橙色，触发用红色。」
//
// ── 为什么单独一个模块 ────────────────────────────────────────────────────────────
//   · 画图要的是【5 个交易日 × 2 种口径】的偏离值序列，而面板/徽标只算「asOf 那一天」；
//   · 口径必须与徽标/面板**逐字一致**（同一个 `computeDeviation` + 同一个 `cumulativeDeviation`），
//     ⛔ 这里绝不另写一份公式（§6 一把尺子）；
//   · 视图零计算（§21）：点位、颜色档、红线全部在这里算好；
//   · 取数只在「用户点开某只票」时发生（§32 不重复请求）：
//       个股逐日腿 = 已有缓存的 `readDailyPctRowsFor`（通常 0 请求）
//       指数逐日腿 = `readIndexLegsForDates`（已有缓存）
//       竞价涨幅   = 5 天各一次的 `readMarketMetricsForDate`（同样有记忆缓存）
//     ⇒ 展开一张图最多 3 类请求，且同一只票同一日期再来一次是 0 请求（会话缓存）。
//
// ── 红线与颜色 ────────────────────────────────────────────────────────────────────
//   · 红线 = 该窗口的交易所阈值（10 日 +100% / 30 日 +200%；ST 与负向档由
//     `thresholdsForStock` 给，⛔ 不在这里硬编码）；「逼近」= 占阈值 ≥90%（DEV_NEAR_RATIO）。
//   · 触发（≥100%）红、逼近（≥90%）橙、留意（≥70%）紫、其余灰 —— 与徽标同一套比例。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  computeDeviation, pickBaseIndexForCode, DEV_NEAR_RATIO, DEV_WATCH_RATIO,
  DEV_STAGE_SEVERE, DEV_STAGE_NEAR, DEV_STAGE_WATCH, DEV_STAGE_OK
} from './abnormal-deviation.js';
import { readDeviationTrendSource } from '../../data/deviation-trend.js';

/** 曲线点数（用户：五日的） */
export const DEV_TREND_DAYS = 5;

/** 会话缓存上限（一只票一个 key；点开过多少只就留多少，超了丢最旧的） */
const CACHE_MAX = 120;
const _cache = new Map();
const _inflight = new Map();

function _sortByDate(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); }

/** 单点：把 `computeDeviation` 的事实裁成「这一个窗口」的一个点 */
function _pointOf(fact, date, windowDays) {
  const f = fact || {};
  const long = windowDays === 30;
  const dev = long ? f.dev30 : f.dev10;
  const thrPos = long ? f.thr30 : f.thr10;
  const thrNeg = long ? f.thr30Neg : f.thr10Neg;
  if (!f.ok || dev === null || dev === undefined || !isFinite(Number(dev))) {
    return { date: date, ok: false, dev: null, thr: null, ratio: null, tone: 'muted', text: '' };
  }
  const d = Number(dev);
  const t = Number(d >= 0 ? thrPos : thrNeg);
  const thr = isFinite(t) && t !== 0 ? t : null;
  const ratio = thr === null ? null : Math.abs(d) / Math.abs(thr);
  let tone = DEV_STAGE_OK;
  if (ratio !== null) {
    if (ratio >= 1) tone = DEV_STAGE_SEVERE;
    else if (ratio >= DEV_NEAR_RATIO) tone = DEV_STAGE_NEAR;
    else if (ratio >= DEV_WATCH_RATIO) tone = DEV_STAGE_WATCH;
  }
  return {
    date: date, ok: true, dev: d, thr: thr, ratio: ratio, tone: tone,
    text: (d >= 0 ? '+' : '') + d.toFixed(1) + '%'
  };
}

/**
 * 纯函数：算 5 个交易日的偏离值序列（竞价口径 + 收盘口径）。
 *
 * @param {object} o
 * @param {string} o.name 票名（只用于 ST 阈值判定）
 * @param {string} o.code 6 位代码
 * @param {Array<{date:string,pct:number|string}>} o.closeLegs 个股逐日收盘腿（≤ asOf）
 * @param {Array<{date:string,pct:number|string}>} o.indexLegs 对应指数逐日腿（≤ asOf）
 * @param {Map<string,number>} o.aucByDate 日期 → 当日 9:25 竞价涨幅（缺 ⇒ 该点竞价口径判不出）
 * @param {10|30} o.windowDays 徽标上那一档（10 日 / 30 日）
 * @param {string} o.asOf 窗口末日（历史复盘必须给）
 * @returns {{windowDays:number, asOf:string, dates:string[], auction:Array, close:Array,
 *            thr:number|null, thrText:string, hasAny:boolean, note:string}}
 */
export function buildDeviationTrend(o) {
  const x = o || {};
  const name = String(x.name || '').trim();
  const code = String(x.code || '').trim();
  const asOf = String(x.asOf || '').slice(0, 10);
  const windowDays = Number(x.windowDays) === 30 ? 30 : 10;
  const aucByDate = (x.aucByDate instanceof Map) ? x.aucByDate : new Map();

  const closeLegs = (x.closeLegs || [])
    .filter(function (l) { return l && l.date && (!asOf || String(l.date) <= asOf); })
    .map(function (l) { return { date: String(l.date).slice(0, 10), pct: l.pct }; })
    .sort(_sortByDate);
  const indexLegs = (x.indexLegs || [])
    .filter(function (l) { return l && l.date && (!asOf || String(l.date) <= asOf); })
    .map(function (l) { return { date: String(l.date).slice(0, 10), pct: l.pct }; })
    .sort(_sortByDate);

  const out = {
    windowDays: windowDays, asOf: asOf, dates: [], auction: [], close: [],
    thr: null, thrText: '', hasAny: false, note: ''
  };
  if (!name || !code) { out.note = '缺少股票代码，算不出偏离值'; return out; }
  if (indexLegs.length === 0) { out.note = '对应指数的逐日腿还没有数据'; return out; }

  // 交易日历以【指数】为准（指数不停牌），只取最后 5 个交易日
  const dates = indexLegs.slice(-DEV_TREND_DAYS).map(function (l) { return l.date; });
  out.dates = dates;

  dates.forEach(function (d) {
    const sLegs = closeLegs.filter(function (l) { return l.date <= d; });
    // ① 收盘口径：当天就是库里的收盘腿
    const fClose = computeDeviation({
      code: code, name: name, stockLegs: sLegs, indexLegs: indexLegs,
      asOf: d, basis: 'close'
    });
    out.close.push(_pointOf(fClose, d, windowDays));

    // ② 竞价口径：当天个股腿换成 9:25 竞价涨幅，指数当天那根强制按 0（与面板同一套）
    const auc = aucByDate.get(d);
    if (auc === undefined || auc === null || !isFinite(Number(auc))) {
      out.auction.push({ date: d, ok: false, dev: null, thr: null, ratio: null, tone: 'muted', text: '' });
    } else {
      const s2 = sLegs.filter(function (l) { return l.date !== d; })
        .concat([{ date: d, pct: Number(auc) }]).sort(_sortByDate);
      const fAuc = computeDeviation({
        code: code, name: name, stockLegs: s2, indexLegs: indexLegs,
        asOf: d, basis: 'auction', indexTodayFlat: true
      });
      out.auction.push(_pointOf(fAuc, d, windowDays));
    }
  });

  // 红线：取【最后一条算得出】的点的阈值（正/负方向由它自己带）
  for (let i = out.close.length - 1; i >= 0; i--) {
    const p = out.close[i];
    if (p.ok && p.thr !== null) { out.thr = p.thr; break; }
  }
  if (out.thr === null) {
    for (let i = out.auction.length - 1; i >= 0; i--) {
      const p = out.auction[i];
      if (p.ok && p.thr !== null) { out.thr = p.thr; break; }
    }
  }
  out.thrText = out.thr === null ? '' : ((out.thr >= 0 ? '+' : '') + out.thr + '%');
  out.hasAny = out.close.some(function (p) { return p.ok; }) ||
    out.auction.some(function (p) { return p.ok; });
  if (!out.hasAny) {
    out.note = '这 5 个交易日的偏离值都判不出（逐日腿或指数腿不足一整个窗口）';
  }
  return out;
}

function _cachePut(key, val) {
  _cache.set(key, val);
  while (_cache.size > CACHE_MAX) {
    const first = _cache.keys().next().value;
    if (first === undefined) break;
    _cache.delete(first);
  }
}

/**
 * 取数 + 计算 + 会话缓存（同一只票同一天同一窗口只会算一次）。
 *
 * ⚠️ §10：任何一步读失败 ⇒ 返回 `{ ok:false, error }`，⛔ 绝不拿空曲线冒充「没有异动」。
 *
 * @param {{name:string, code:string, windowDays:10|30, asOf:string}} p
 * @returns {Promise<{ok:boolean, trend?:object, error?:string}>}
 */
export async function loadDeviationTrend(p) {
  const name = String((p && p.name) || '').trim();
  const code = String((p && p.code) || '').trim();
  const windowDays = Number(p && p.windowDays) === 30 ? 30 : 10;
  const asOf = String((p && p.asOf) || '').slice(0, 10);
  if (!name || !code) return { ok: false, error: '缺少股票代码，算不出偏离值' };
  const idx = pickBaseIndexForCode(code);
  if (!idx || !idx.code) return { ok: false, error: '这只票没有对应的官方指数（北交所 / 代码缺失）' };
  const key = asOf + '|' + name + '|' + windowDays;
  if (_cache.has(key)) return { ok: true, trend: _cache.get(key) };
  if (_inflight.has(key)) return _inflight.get(key);

  const task = (async function () {
    const src = await readDeviationTrendSource({ stock: name, indexCode: idx.code, asOf: asOf });
    if (!src || src.ok !== true) {
      return { ok: false, error: (src && src.error) || '逐日腿读取失败' };
    }
    const trend = buildDeviationTrend({
      name: name, code: code, windowDays: windowDays, asOf: asOf,
      closeLegs: src.closeLegs, indexLegs: src.indexLegs, aucByDate: src.aucByDate
    });
    _cachePut(key, trend);
    return { ok: true, trend: trend };
  })();

  _inflight.set(key, task);
  try {
    return await task;
  } finally {
    _inflight.delete(key);
  }
}

/** 仅供测试 / 切日期时清会话缓存 */
export function clearDeviationTrendCache() {
  _cache.clear();
  _inflight.clear();
}
