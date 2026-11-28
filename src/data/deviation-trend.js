// deviation-trend.js — 「官方偏离值 5 日趋势图」的唯一取数入口（Data 层，§5）
//
// 只做一件事：把画这张图需要的三样原料读回来
//   ① 个股逐日收盘腿（stock_daily_pct）—— 复用 `readDailyPctRowsFor` 的分片缓存，通常 0 请求；
//   ② 对应指数的逐日腿（market_metrics scope=index）—— 复用 `readIndexLegsForDates` 的缓存；
//   ③ 最近 5 个交易日的 9:25 竞价涨幅（market_metrics scope=auction.auc_pct_chg）——
//      复用 `readMarketMetricsForDate` 的按 (date,scope) 记忆缓存。
//
// ⛔ 本模块不做任何计算（算法全在 `logic/auction/deviation-trend.js`），也不碰视图。
// ⚠️ §10 红线：任何一步读失败都返回 `{ok:false,error}`，⛔ 绝不把「读失败」变成「空曲线」。
// ⚠️ [PERF] 指数腿只读云端、不走腾讯兜底（allowQt:false）：这是用户点开一张小图，
//    不该为此去打可能被 WAF 挡的外网请求；云端缺腿就如实说「指数腿没有数据」。

import { readDailyPctRowsFor } from './stock-daily-pct.js';
import { readIndexLegsForDates, indexLegsOf, shiftYmd } from './index-daily-pct.js';
import { readMarketMetricsForDate } from './market-metrics.js';
import { numOfText } from '../logic/util/num-text.js';

/** from~to 之间的工作日（粗略交易日候选；真实交易日由指数腿自己决定） */
function weekdaysBetween(from, to) {
  const out = [];
  const end = Date.parse(String(to) + 'T00:00:00Z');
  let t = Date.parse(String(from) + 'T00:00:00Z');
  if (!isFinite(t) || !isFinite(end)) return out;
  for (; t <= end; t += 86400000) {
    const d = new Date(t);
    const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 读取趋势图原料。
 *
 * @param {object} o
 * @param {string} o.stock 票名
 * @param {string} o.indexCode 对应官方指数代码（如 sh000002；由调用方按板块给）
 * @param {string} o.asOf 窗口末日 'YYYY-MM-DD'
 * @returns {Promise<{ok:boolean, closeLegs?:Array, indexLegs?:Array,
 *                    aucByDate?:Map<string,number>, error?:string}>}
 */
export async function readDeviationTrendSource(o) {
  const x = o || {};
  const stock = String(x.stock || '').trim();
  const indexCode = String(x.indexCode || '').trim();
  const asOf = String(x.asOf || '').slice(0, 10);
  if (!stock || !indexCode || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return { ok: false, error: '缺少股票名 / 指数代码 / 日期，算不出偏离值' };
  }

  // ① 个股逐日腿（往前 120 个自然日足够覆盖 30 日窗口 + 5 个点）
  let daily = null;
  try {
    daily = await readDailyPctRowsFor([stock], shiftYmd(asOf, -120), asOf);
  } catch (e) {
    return { ok: false, error: '个股逐日腿读取失败' };
  }
  if (!daily) return { ok: false, error: '个股逐日腿读取失败' };
  const dm = daily.get(stock);
  const closeLegs = [];
  if (dm && typeof dm.forEach === 'function') {
    dm.forEach(function (pct, date) {
      const d = String(date || '').slice(0, 10);
      if (d && d <= asOf) closeLegs.push({ date: d, pct: pct });
    });
  }
  closeLegs.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  if (closeLegs.length === 0) return { ok: false, error: '这只票还没有逐日涨幅腿（stock_daily_pct）' };

  // ② 对应指数逐日腿（只读云端；缺就如实上报）
  let idxRes = null;
  try {
    idxRes = await readIndexLegsForDates(weekdaysBetween(shiftYmd(asOf, -70), asOf), {
      codes: [indexCode], allowQt: false
    });
  } catch (e) {
    return { ok: false, error: '对应指数逐日腿读取失败' };
  }
  const indexLegs = indexLegsOf(idxRes && idxRes.map, indexCode, asOf);
  if (indexLegs.length === 0) return { ok: false, error: '对应指数的逐日腿还没有数据' };

  // ③ 最近 5 个交易日的竞价涨幅（某天缺 ⇒ 那个点的竞价口径判不出，但收盘口径照画）
  const last5 = indexLegs.slice(-5).map(function (l) { return l.date; });
  const aucByDate = new Map();
  await Promise.all(last5.map(async function (d) {
    try {
      const rows = await readMarketMetricsForDate(d, 'auction');
      const hit = (rows || []).filter(function (r) { return r && String(r.stock || '').trim() === stock; })[0];
      if (!hit) return;
      const v = numOfText(hit.auc_pct_chg);
      if (v !== null) aucByDate.set(d, v);
    } catch (e) {
      // §10：某天竞价涨幅读失败 ⇒ 记为「这一点判不出」，⛔ 不当 0，也不影响另一条曲线
    }
  }));

  return { ok: true, closeLegs: closeLegs, indexLegs: indexLegs, aucByDate: aucByDate };
}
