// leader-diverge-days.js — 第二十五条「总龙首次分歧 / 二次分歧 ⇒ 等同退潮」的【云端】预计算
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [LD-CLOUD 2026-11-13 用户口径 · 原话] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「你帮我完成啊，不要留着，记住都是在云端运行，关电脑也能用，不要电脑本地的，
//     我之前强调好几次了，把没完成的完成」
//
// ── 为什么这件事必须搬到云端 ──────────────────────────────────────────────────────
//   第二十五条的判定输入 = 这只票近 20 个交易日的【四列事实】：
//     ① 每天的竞价涨幅      market_metrics(scope='auction').auc_pct_chg
//     ② 每天的收盘涨幅      stock_daily_pct.pct        （判涨停 / 判「高开低走收绿」）
//     ③ 每天的竞价占比      auction_watchlist.volume ÷ yest_volume（判占比塌陷）
//     ④ 每天它是不是总龙一  ← 需要把【那一天】的 stock_range20_pct 反解成 9:25 竞价口径，
//                            再过「9:25 名单白名单 + 腿数门槛 + 只主板」这道闸门排第一
//   ④ 一天一次反解，20 天 = 20 次全套 —— 放在浏览器里就意味着「没开页面 = 没有判定」，
//   而用户在 2026-11-13 明确否掉了这种形态。⇒ 整个判定在 Cloudflare Worker 里算完落库，
//   前端只读一行（src/data/leader-diverge-days.js）。
//
// ── 与前端那条链的分工（⛔ 别混）────────────────────────────────────────────────
//   · 前端 `tvrb_diverge_days`  —— 【首次分歧】结论（首板日 / 首次分歧日），K 线链路算；
//   · 本文件 `tvrb_leader_diverge` —— 【首次 / 二次分歧】整段判定（kind / 霸榜天数 / 事件计数），
//     云端算。第二十五条「二次分歧 ⇒ 等同退潮」只认这张表。
//   ⚠️ 两边用的是**同一个纯函数** `runLeaderDiverge`（src/logic/topicvolratio/leader-diverge.js）
//      ⇒ 口径只有一份（§6），⛔ 这里绝不另写一套「低开 / 收绿 / 占比」判据。
//
// ── 一天跑两次（都挂在已有 cron 上，⛔ 不新增 cron；免费账户上限 5 条已用 4 条）──────
//   · 9:27 snapshot 末 ⇒ leg_phase='intraday'：今天的收盘腿还不存在 ⇒
//     D2（高开低走收绿）对【今天】不可能成立，D1（竞价低开）/ D3（占比塌陷）照常成立；
//   · 16:00 close 末   ⇒ leg_phase='close'：收盘腿齐全，三种形态全生效（用户要的 D2 靠这一趟）。
//   ⇒ 同一 (date, stock) 会被写两次，第二次是【信息更全】的覆盖（不是改口径）。
//     覆盖前后 kind 若发生变化会打日志（§10 判定可追溯，⛔ 不静默改写结论）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10：任一表读失败 ⇒ 本轮 ok=false 并如实报错，⛔ 绝不写一行「猜的」判定；
//        榜没就绪（少数据）⇒ 该展示日跳过并记日志（⛔ 不拿残缺榜挑总龙一）。
//   §11：只写本表（+ 读四张表），⛔ 不碰 stock_range20_pct / market_metrics / auction_watchlist。
//   §32：窗口级批量读（`date=in.(...)`），每个表 1~6 页；⛔ 不按日循环打 80 个请求。
//   §6：反解 / 榜单 / 判定全部复用前端同一份纯函数实现（见 import）。
// ============================================================================

import { beijingNow, beijingToday, normalizeDate } from '../../_shared-source/date-utils.js';
import { buildAuctionLegPctMap } from '../../../src/logic/auction/auction-leg-pct.js';
import { buildAuctionLegBoard } from '../../../src/logic/auction/auction-leg-board.js';
import { getLimitUpPct } from '../../../src/logic/auction/limit-up.js';
import { runLeaderDiverge } from '../../../src/logic/topicvolratio/leader-diverge.js';
import { DIVERGE_WINDOW_DAYS } from '../../../src/logic/topicvolratio/tvrb-constants.js';
import {
  readRecentTradeDates,
  readAuctionRowsForDates,
  readMetricsForDates,
  readRange20ForDates,
  readDailyPctForDates,
  upsertLeaderDivergeRows
} from '../data/supabase-write.js';

/** 一次最多补几个展示日（手动回补用；默认 1 = 只算今天） */
export const LD_MAX_WRITE_DAYS = 20;

/** 口径阶段：北京 15:00 前 = intraday（今天还没有收盘腿），之后 = close */
export function legPhaseOf(nowBj) {
  const d = nowBj || beijingNow();
  return d.getUTCHours() < 15 ? 'intraday' : 'close';
}

/** 把「行数组」按某列分组进 Map（保持确定性：入参已按 date.asc,stock.asc 读回） */
function _groupBy(rows, key) {
  const out = new Map();
  (rows || []).forEach(function (r) {
    const k = String((r && r[key]) || '').slice(0, 10);
    if (!k) return;
    let arr = out.get(k);
    if (!arr) { arr = []; out.set(k, arr); }
    arr.push(r);
  });
  return out;
}

/**
 * ★ 把「一天的全市场 20 日涨幅行」收成 `buildAuctionLegPctMap` 要的 Map<股票, {pct, days, leg}>。
 *
 * ⚠️ 主键 (date,stock,leg) ⇒ 同一天同股可能两行：
 *   · `leg='auc'` = 页面在 15:00 前跑过、当时就用竞价腿算的 ⇒ **原值就是 9:25 口径**；
 *   · `leg='close'` = 收盘腿的 20 日复利 ⇒ 需要反解。
 *   ⇒ **有 auc 行就优先用 auc**（免反解、无误差）；两行都在也只留一行。
 *   （与前端 `readRange20Rows` 的 byLeg 取舍同向：都用该口径自己的那一行。）
 *
 * @param {Array<{stock,pct,days,leg}>} dayRows
 * @returns {Map<string,{pct:*,days:*,leg:string}>}
 */
export function rangeRowsMapOf(dayRows) {
  const m = new Map();
  (dayRows || []).forEach(function (r) {
    const nm = String((r && r.stock) || '').trim();
    if (!nm) return;
    const leg = String(r.leg || 'close').trim().toLowerCase() === 'auc' ? 'auc' : 'close';
    const cur = m.get(nm);
    if (!cur || (cur.leg !== 'auc' && leg === 'auc')) {
      m.set(nm, { pct: r.pct, days: r.days, leg: leg });
    }
  });
  return m;
}

/**
 * 【纯函数】逐日事实 → 判定输入行（Worker 侧的「取哪几列」收口，⛔ 判据仍只在下游纯函数里）。
 *
 * @param {string[]} dates 升序窗口日期
 * @param {string} stock 总龙一
 * @param {{metrics:Map, daily:Map, auction:Map, leaderOfDay:Map<string,string>}} src
 * @returns {Array<object>} 直接喂 `runLeaderDiverge` 的 days
 */
export function buildDaysForStock(dates, stock, src) {
  const name = String(stock || '').trim();
  const out = [];
  (dates || []).forEach(function (d) {
    const m = (src.metrics.get(d) || new Map()).get(name) || null;
    const open = src.daily.get(d) || new Map();
    const au = src.auction.get(d) || new Map();
    const code = String((m && m.code) || '').replace(/\D/g, '');
    out.push({
      date: d,
      aucPct: m ? m.auc_pct_chg : null,
      // 收盘涨幅：stock_daily_pct 是收盘真值（market_metrics.change_pct 在收盘覆盖失效时
      // 仍停在 9:25 竞价涨幅 ⇒ 用它判「高开低走收绿 / 涨停」会判反，见 leader-diverge.js 文件头）
      dailyPct: open.has(name) ? open.get(name) : null,
      closePct: m ? m.change_pct : null,
      volume: au.has(name) ? au.get(name).volume : null,
      yestVolume: au.has(name) ? au.get(name).yest_volume : null,
      limitUpPct: code ? getLimitUpPct(code, name) : null,
      // 总龙一 = 【那一天】9:25 竞价口径榜的第 1 名（与前端同一份榜、同一把尺子）
      isDragonOne: String((src.leaderOfDay.get(d) || '')) === name
    });
  });
  return out;
}

/**
 * ★★ 入口：算「最近若干展示日」的总龙分歧判定并落库。
 *
 * @param {object} env
 * @param {{today?:string, days?:number, phase?:string, logs?:string[]}} [opts]
 *        today = 截止日（含），缺省北京今天；
 *        days  = 要写几个展示日（默认 1；手动回补可给 2~20）；
 *        phase = 'intraday' | 'close'，缺省按时钟判；
 *        logs  = 外部日志数组（与其它 point 同款留痕）
 * @returns {Promise<{ok:boolean, error?:string, today:string, phase:string,
 *          dates:string[], leaders:string[], written:number, skipped:Array, logs:string[]}>}
 */
export async function runLeaderDivergeDays(env, opts) {
  const o = opts || {};
  const logs = Array.isArray(o.logs) ? o.logs : [];
  const today = normalizeDate(o.today) || beijingToday();
  const rawDays = Number(o.days);
  const days = isFinite(rawDays) && rawDays > 0
    ? Math.min(Math.floor(rawDays), LD_MAX_WRITE_DAYS) : 1;
  const phase = (o.phase === 'close' || o.phase === 'intraday') ? o.phase : legPhaseOf();
  // 窗口 = 20 个交易日；要写 days 个展示日 ⇒ 需要往前多取 days-1 天（每个展示日都用它自己那段 20 日）
  const wantDates = DIVERGE_WINDOW_DAYS + days - 1;

  const result = {
    ok: false, today: today, phase: phase,
    dates: [], leaders: [], written: 0, skipped: [], logs: logs
  };

  // ── ① 窗口日期（ascending，不含 today 之后；today 当天必须有名单行才算进窗口） ──
  const past = await readRecentTradeDates(env, _nextDate(today), wantDates);
  const dates = past.slice();
  result.dates = dates;
  if (dates.length === 0) {
    logs.push('[LD-CLOUD] ' + today + ' 往前取不到任何交易日（auction_watchlist 无行）⇒ 判定跳过');
    result.error = 'no-trade-dates';
    return result;
  }
  if (dates.length < wantDates) {
    logs.push('[LD-CLOUD] ⚠️ 窗口只取到 ' + dates.length + '/' + wantDates +
      ' 个交易日（' + dates[0] + '~' + dates[dates.length - 1] + '）⇒ 霸榜天数可能偏少，如实记录（§10 不补天）');
  }

  // ── ② 四张表一次批量读（窗口级，§32） ──
  const [aucRows, metricRows, rangeRows, dailyRows] = await Promise.all([
    readAuctionRowsForDates(env, dates),
    readMetricsForDates(env, dates),
    readRange20ForDates(env, dates),
    readDailyPctForDates(env, dates)
  ]);
  logs.push('[LD-CLOUD] ' + today + ' 窗口 ' + dates.length + ' 天（' + dates[0] + '~' +
    dates[dates.length - 1] + '）读取: watchlist=' + aucRows.length +
    ' metrics=' + metricRows.length + ' range20=' + rangeRows.length + ' daily=' + dailyRows.length);

  // ── ③ 分组（按日） ──
  //   ⚠️ `metricsByDate` 是 Map（按股票名取一行的 O(1) 查找），`metricsListByDate` 是**数组**
  //      —— `buildAuctionLegBoard` 第 2 参要的就是「那天的 9:25 名单行数组」（它内部逐行过白名单），
  //      给它 Map 会走到 `metrics-read-failed` 分支 ⇒ 整轮判不出（⛔ 别合并成一个）。
  const metricsByDate = new Map();
  const metricsListByDate = new Map();
  const codeByName = new Map();
  _groupBy(metricRows, 'date').forEach(function (arr, d) {
    const m = new Map();
    arr.forEach(function (r) {
      if (!m.has(r.stock)) m.set(r.stock, r);
      const c = String(r.code || '').replace(/\D/g, '');
      if (c && !codeByName.has(r.stock)) codeByName.set(r.stock, c);
    });
    metricsByDate.set(d, m);
    metricsListByDate.set(d, arr);
  });
  const dailyByDate = new Map();
  _groupBy(dailyRows, 'date').forEach(function (arr, d) {
    const m = new Map();
    arr.forEach(function (r) { if (!m.has(r.stock)) m.set(r.stock, r.pct); });
    dailyByDate.set(d, m);
  });
  const auctionByDate = new Map();
  _groupBy(aucRows, 'date').forEach(function (arr, d) {
    const m = new Map();
    arr.forEach(function (r) { if (!m.has(r.stock)) m.set(r.stock, r); });
    auctionByDate.set(d, m);
  });
  const rangeByDate = new Map();
  _groupBy(rangeRows, 'date').forEach(function (arr, d) {
    rangeByDate.set(d, rangeRowsMapOf(arr));
  });

  const codeOf = function (name) { return codeByName.get(String(name || '').trim()) || ''; };

  // ── ④ 逐日算出【那天 9:25 竞价口径榜的总龙一】（与前端 buildTvrbAuctionBoard 同一实现） ──
  const leaderOfDay = new Map();
  const boardFail = [];
  dates.forEach(function (d) {
    const pctMap = buildAuctionLegPctMap(rangeByDate.get(d) || null, metricsListByDate.get(d) || null);
    const board = buildAuctionLegBoard(pctMap, metricsListByDate.get(d) || null, { codeOf: codeOf });
    if (board.ready && board.rank.length > 0) {
      leaderOfDay.set(d, board.rank[0].stock);
    } else {
      boardFail.push(d + '(' + board.reason + ')');
    }
  });
  if (boardFail.length > 0) {
    logs.push('[LD-CLOUD] ⚠️ ' + boardFail.length + ' 天榜没就绪：' + boardFail.join(', ') +
      ' ⇒ 那几天的「总龙一」记为未知（⛔ 不猜，霸榜天数只按已知的天数计）');
  }

  // ── ⑤ 要写哪几个展示日（窗口末尾 days 天） ──
  const displayDates = dates.slice(-days);

  // ── ⑥ 逐展示日：判定 + 落库 ──
  const rowsToWrite = [];
  displayDates.forEach(function (dDisp) {
    const leader = leaderOfDay.get(dDisp) || '';
    if (!leader) {
      result.skipped.push({ date: dDisp, reason: 'board-not-ready' });
      logs.push('[LD-CLOUD] ' + dDisp + ' 那天的总龙一判不出（榜没就绪）⇒ 跳过（§10 不猜）');
      return;
    }
    // 该展示日的窗口 = 窗口内 ≤ 它的那些天（runLeaderDiverge 内部再按 20 截断）
    const iDisp = dates.indexOf(dDisp);
    const winDates = dates.slice(0, iDisp + 1);
    const dayRows = buildDaysForStock(winDates, leader, {
      metrics: metricsByDate,
      daily: dailyByDate,
      auction: auctionByDate,
      leaderOfDay: leaderOfDay
    });
    const v = runLeaderDiverge(dayRows);
    result.leaders.push(leader);
    rowsToWrite.push({
      date: dDisp,
      stock: leader,
      kind: v.kind,
      qualified: !!v.qualified,
      reason: String(v.reason || ''),
      dragon_days: Number.isFinite(Number(v.dragonDays)) ? Number(v.dragonDays) : null,
      event_count: Number(v.eventCount) || 0,
      start_date: v.startDate || null,
      first_date: v.firstDate || null,
      first_end_date: v.firstEndDate || null,
      second_date: v.secondDate || null,
      second_end_date: v.secondEndDate || null,
      boards_after_first: Number(v.boardsAfterFirst) || 0,
      window_days: Number(v.windowDays) || DIVERGE_WINDOW_DAYS,
      leg_phase: phase,
      // 逐日留痕（说明区可追溯「它是哪一天低开 / 哪一天收绿 / 哪一天占比塌」）
      rows: (v.rows || []).map(function (r) {
        return {
          date: r.date, aucPct: r.aucPct, closePct: r.closePct,
          share: r.share, limitUp: r.limitUp, isDragonOne: !!r.isDragonOne
        };
      }),
      updated_at: new Date().toISOString()
    });
    logs.push('[LD-CLOUD] ' + dDisp + ' 总龙=' + leader + ' kind=' + v.kind +
      ' 霸榜=' + (v.dragonDays === null ? '未知' : v.dragonDays) + '天' +
      ' 事件=' + v.eventCount + ' 首次=' + (v.firstDate || '—') +
      ' 二次=' + (v.secondDate || '—') + ' 首次后涨停=' + v.boardsAfterFirst +
      ' 阶段=' + phase + (v.reason ? ' 出口=' + v.reason : ''));
  });

  if (rowsToWrite.length === 0) {
    result.error = 'nothing-to-write';
    return result;
  }

  // ── ⑦ 落库（upsert，幂等；主键 date,stock） ──
  try {
    await upsertLeaderDivergeRows(env, rowsToWrite);
  } catch (e) {
    // §10：写失败必须可见（表还没建 / 网络）；⛔ 不影响 9:27 / 16:00 的其它步骤
    logs.push('[LD-CLOUD] ✗ 写 tvrb_leader_diverge 失败（执行 db/create_tvrb_leader_diverge.sql？）: ' +
      (e && e.message ? e.message : String(e)));
    result.error = 'write-failed: ' + (e && e.message ? e.message : String(e));
    return result;
  }

  result.written = rowsToWrite.length;
  result.ok = true;
  logs.push('[LD-CLOUD] ✓ 写入 ' + rowsToWrite.length + ' 行（' + rowsToWrite.map(function (r) {
    return r.date + '/' + r.stock + '=' + r.kind;
  }).join(', ') + '）阶段=' + phase);
  return result;
}

/** today 的下一天（readRecentTradeDates 用 lt.，要含 today 本身 ⇒ 传 next day） */
function _nextDate(dateStr) {
  const s = normalizeDate(dateStr);
  if (!s) return '';
  const t = new Date(s + 'T00:00:00Z').getTime() + 24 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
