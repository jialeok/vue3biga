// leader-diverge.js — 第二十五条【总龙首次分歧 / 二次分歧】判定（Logic 层，纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [LEADER-DIVERGE 2026-11-12 用户口径] 用户原话（逐字保留，本文件唯一需求来源）：
// ══════════════════════════════════════════════════════════════════════════════════════
//   「还有第二十五条，总龙首次分歧，定义，一条线：首板之后第一个竞价低开（个股分歧，
//     不是题材退潮），东方海洋在 11月04日，首次分歧（当时还没成为市场总龙，只是从 11月12日
//     倒推，它首次出现是在 11月6日变成总龙一主板的，然后霸榜三天，要霸榜总龙一至少三天
//     把这个条件也添加上去，按照竞价口径），首板之后，第一个竞价低开日（按照竞价口径）
//     或者涨幅高开低走收绿（竞价是高开的，但是收盘是负数绿的，按照收盘口径，这个要新增，
//     之前没考虑过的），当时竞价低开在 11月10日又分歧一次，从现在开始这叫二次分歧，
//     二次分歧等同于首次退潮了，所以从这天开始确认羊字辈退潮了，注意范围是 20 个交易日，
//     分首次分歧和二次分歧，二次分歧 5 个交易日内至少有两个连板（第一次分歧之后它可能是
//     大阳连板一起可能是纯连板，可能使和大阳一起排的趋势，如果是识别二次分歧就要看它是否
//     竞价低开或者按照收盘口径，先高开，收盘是负数绿的），也要添加这个条件识别二次分歧。
//     到 11月12日时，提示应该是二次分歧等同该题材退潮。二次分歧（退潮）还要看总龙一
//     属不属于新题材，看有没有新题材出现。」
//
// ── 上一版错在哪 ────────────────────────────────────────────────────────────────
//   上一版只有「题材退潮」一条线（占比塌 + 前两日连板），没有【个股分歧】这条线：
//     · 判不出「11-04 是首次分歧」—— 那天竞价是 **+4.68% 高开**（不是低开），
//       但收盘 **−4.09% 收绿** ⇒ 正是用户说「这个要新增，之前没考虑过的」那一条；
//     · 没有「霸榜总龙一 ≥3 天」这个资格判据；
//     · 没有「二次分歧 5 个交易日内至少两个连板」这个识别条件；
//     · 二次分歧没有和「题材退潮」打通 ⇒ 11-10 只能靠占比塌来解释，说不到「羊字辈确认退潮」。
//
// ── 本版判据 ───────────────────────────────────────────────────────────────────
//   ① 【总龙资格】`dragonDays ≥ DIVERGE_TOTAL_DAYS_MIN(3)`：这只票在近 20 个交易日里
//      **当总龙一的天数 ≥3**（按 9:25 竞价口径，由调用方喂 `isDragonOne`）。没资格 ⇒ 一律不判。
//      东方海洋：11-06 首次成为总龙一，11-06 / 11-09 / 11-10 霸榜三天 ⇒ 11-10 达标 ✅
//   ② 【分歧形态】任一成立（`isDivergeShape`）：
//        D1 竞价低开：`aucPct < 0`
//        D2 高开低走收绿：`aucPct > 0 且 closePct < 0`   ← 本轮新增（用户「这个要新增」）
//        D3 竞价占比塌陷：`share < 3.5%`（与第二十一条判据②同一把尺子，恒龙头档）
//      ⚠️ D3 是「二次分歧 = 首次退潮」能对上的唯一桥梁 —— 11-10 竞价 +0.69%（不是低开），
//         靠的是占比 2.93% 塌陷；用户对 11-10 的原话是「竞价低开」，
//         但库内竞价涨幅是 +0.69%，如实按三种形态取并集判定（⛔ 不篡改行情）。
//   ③ 【一次事件 = 连续满足日合并】（§6 与退潮事件计数同一口径）：
//      11-04(D2) + 11-05(D3) 连续 ⇒ 算 **1 次** = 首次分歧；
//      11-10(D3) + 11-11(D3) 连续 ⇒ 算 **1 次** = 二次分歧。
//      否则 11-05、11-11 会被数成第三次、第四次（用户：「没有第三次了」）。
//   ④ 【首板之后才有分歧】（用户「首板之后第一个竞价低开日」）：
//      起点 = 窗口内**第一次涨停**那天；之前的分歧不计数（那还是启动前的震荡）。
//   ⑤ 【二次分歧附加条件】首次分歧之后 `DIVERGE_SECOND_BOARD_WINDOW(5)` 个交易日内
//      至少 `DIVERGE_SECOND_MIN_BOARDS(2)` 个涨停（收盘口径）。达不到 ⇒ 不算二次分歧
//      （用户：「第一次分歧之后……可能是和大阳一起排的趋势」⇒ 连板不够就只是趋势）。
//      11-04 首次分歧之后 5 个交易日内：11-05 +10.06、11-06 +9.97、11-09 +10.08 ⇒ 3 个涨停 ✅
//   ⑥ 二次分歧 ⇒ **等同首次退潮**（用户原话）⇒ 题材从这天起确认退潮。
//
// ── 边界（§10 / §11）──────────────────────────────────────────────────────────
//   · `rows` 为空 / 少于 2 行 / 没有涨停那行 ⇒ 返回 `kind:'unknown'`（⛔ 不返 'none' 冒充「没有分歧」）
//   · `dragonDays` 读不到（null）⇒ `qualified:false` + `reason:'dragon-days-unknown'`，
//     但**不阻断**已有退潮链路（调用方只在 `kind` 明确时改文案，⛔ 不拿未知去推翻结论）
//   · ⛔ 本文件不读 state / 不发请求 / 不拼展示文案（§4 / §21：只给事实与短 reason）
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  DIVERGE_TOTAL_DAYS_MIN,
  DIVERGE_SECOND_MIN_BOARDS,
  DIVERGE_SECOND_BOARD_WINDOW,
  DIVERGE_WINDOW_DAYS
} from './tvrb-constants.js';
// §6 单一数据源：占比门槛 / 占比公式只认 auction-share 那一份实现（⛔ 不在这里另写一个 3.5 或 v/y*100）
import { auctionShareThresholdOf, computeAuctionShare } from '../decision/auction-share.js';

/** 分歧形态编码（留痕用，UI 不必读） */
export const DIVERGE_SHAPE_LOW_OPEN = 'low-open';      // D1 竞价低开
export const DIVERGE_SHAPE_OPEN_HIGH_CLOSE_RED = 'open-high-close-red'; // D2 高开低走收绿
export const DIVERGE_SHAPE_SHARE = 'share';            // D3 竞价占比塌陷

function _n(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 这一天是不是【分歧形态】？
 *
 * @param {{aucPct?:number|null, closePct?:number|null, share?:number|null}} row
 *        aucPct = 9:25 竞价涨幅（%）；closePct = 当日收盘涨幅（%）；share = 竞价量/昨量（%）
 * @returns {string} '' = 不是分歧；否则返回命中的形态编码（多个命中取第一个，按 D1→D2→D3）
 */
export function isDivergeShape(row) {
  const r = row || {};
  const auc = _n(r.aucPct);
  const close = _n(r.closePct);
  const sh = _n(r.share);
  // D1 竞价低开（用户口径：按竞价口径）
  if (auc !== null && auc < 0) return DIVERGE_SHAPE_LOW_OPEN;
  // D2 高开低走收绿（本轮新增：竞价是高开的，收盘是负数绿的 ⇒ 按收盘口径）
  if (auc !== null && auc > 0 && close !== null && close < 0) return DIVERGE_SHAPE_OPEN_HIGH_CLOSE_RED;
  // D3 竞价占比塌陷（= 第二十一条判据②同一把尺子，恒龙头档）
  if (sh !== null && sh < auctionShareThresholdOf(true)) return DIVERGE_SHAPE_SHARE;
  return '';
}

/**
 * 把逐日行切成【分歧事件】：连续满足的日子合并成一次（§6 与退潮事件计数同一口径）。
 *
 * @param {Array<{date:string, aucPct?:number|null, closePct?:number|null, share?:number|null}>} rows
 *        必须是**按日期升序**的同一只票的逐日行（顺序错了会数错，调用方负责，见 `classifyLeaderDiverge`）
 * @param {string} [fromDate] 起点（含）：首板那天。传空 ⇒ 全文都算
 * @returns {Array<{date:string, endDate:string, days:number, shapes:string[]}>}
 */
export function buildDivergePhases(rows, fromDate) {
  const list = Array.isArray(rows) ? rows : [];
  const from = String(fromDate || '').trim();
  const out = [];
  let cur = null;
  list.forEach(function (r) {
    const d = String((r && r.date) || '').trim();
    if (!d) return;
    if (from && d < from) return;                 // 首板之前不算
    const shape = isDivergeShape(r);
    if (shape) {
      if (cur) {
        cur.endDate = d;
        cur.days += 1;
        cur.shapes.push(shape);
      } else {
        cur = { date: d, endDate: d, days: 1, shapes: [shape] };
        out.push(cur);
      }
    } else {
      cur = null;                                  // 断掉 ⇒ 下一次算新事件
    }
  });
  return out;
}

/**
 * ★★ [LEADER-DIVERGE] 总龙一的【首次分歧 / 二次分歧】判定。
 *
 * @param {Array<{date:string, aucPct?:number|null, closePct?:number|null, share?:number|null,
 *          limitUp?:boolean, isDragonOne?:boolean}>} rows
 *        同一只票近 20 个交易日逐日行（升序）。`limitUp` = 收盘涨停（含一字 / T字）。
 * @param {{dragonDays?:number|null, windowDays?:number}} [info]
 *        `dragonDays` = 该票近 N 日当【总龙一】的天数（竞价口径，调用方统计）；
 *        null / undefined = 读不到（§10：未知 ≠ 0，结论标 unknown 且不推翻既有链路）
 * @returns {{
 *   kind:'none'|'first'|'second'|'unknown',
 *   qualified:boolean,
 *   reason:string,
 *   firstDate:string, firstEndDate:string,
 *   secondDate:string, secondEndDate:string,
 *   eventCount:number,
 *   boardsAfterFirst:number,
 *   dragonDays:number|null,
 *   startDate:string,
 *   phases:Array
 * }}
 *        `kind:'second'` ⇒ **等同首次退潮**（用户原话），题材从 `secondDate` 那天起确认退潮。
 */
export function classifyLeaderDiverge(rows, info) {
  const o = info || {};
  const list = (Array.isArray(rows) ? rows : [])
    .filter(function (r) { return r && String(r.date || '').trim(); })
    .slice()
    .sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); });
  const win = Number(o.windowDays) > 0 ? Number(o.windowDays) : DIVERGE_WINDOW_DAYS;
  const winRows = list.slice(-win);

  const empty = {
    kind: 'unknown', qualified: false, reason: '', firstDate: '', firstEndDate: '',
    secondDate: '', secondEndDate: '', eventCount: 0, boardsAfterFirst: 0,
    dragonDays: null, startDate: '', phases: []
  };
  // §10：行不够 ⇒ 判不出（⛔ 不返 none）
  if (winRows.length < 2) {
    return Object.assign(empty, { reason: 'rows-missing' });
  }

  // ① 总龙资格：霸榜总龙一 ≥3 天（竞价口径）
  const dd = _n(o.dragonDays);
  const qualified = (dd !== null && dd >= DIVERGE_TOTAL_DAYS_MIN);

  // ④ 起点 = 窗口内第一次涨停那天（用户「首板之后第一个竞价低开日」）
  let startDate = '';
  for (let i = 0; i < winRows.length; i++) {
    if (winRows[i].limitUp === true) { startDate = String(winRows[i].date); break; }
  }
  if (!startDate) {
    // 没有涨停 ⇒ 这只票根本没启动过，谈不上分歧（这是【判出「没有」】，不是判不出）
    return Object.assign(empty, {
      kind: 'none', qualified: qualified, reason: 'no-limit-up', dragonDays: dd, phases: []
    });
  }

  const phases = buildDivergePhases(winRows, startDate);
  const first = phases[0] || null;
  const second = phases[1] || null;

  // ⑤ 二次分歧附加条件：首次分歧之后 5 个交易日内至少 2 个涨停
  let boardsAfterFirst = 0;
  if (first) {
    const iFirst = winRows.findIndex(function (r) { return String(r.date) === String(first.endDate); });
    if (iFirst >= 0) {
      winRows.slice(iFirst + 1, iFirst + 1 + DIVERGE_SECOND_BOARD_WINDOW).forEach(function (r) {
        if (r.limitUp === true) boardsAfterFirst += 1;
      });
    }
  }

  const base = {
    qualified: qualified,
    reason: '',
    dragonDays: dd,
    startDate: startDate,
    phases: phases,
    eventCount: phases.length,
    firstDate: first ? first.date : '',
    firstEndDate: first ? first.endDate : '',
    boardsAfterFirst: boardsAfterFirst,
    secondDate: second ? second.date : '',
    secondEndDate: second ? second.endDate : ''
  };

  // §10：总龙资格读不到 ⇒ 不硬判（调用方不会被这条推翻既有结论）
  if (dd === null) {
    return Object.assign({}, empty, base, { kind: 'unknown', reason: 'dragon-days-unknown' });
  }
  if (!qualified) {
    return Object.assign({}, empty, base, { kind: 'none', reason: 'not-total-dragon' });
  }
  if (!first) {
    return Object.assign({}, empty, base, { kind: 'none', reason: 'no-diverge-yet' });
  }
  if (!second) {
    return Object.assign({}, empty, base, { kind: 'first', reason: 'first-diverge' });
  }
  if (boardsAfterFirst < DIVERGE_SECOND_MIN_BOARDS) {
    // 用户：「第一次分歧之后可能是大阳连板，也可能是和大阳一起排的趋势」
    //   ⇒ 连板不够就只是趋势，不认二次分歧；但首次分歧仍然成立。
    return Object.assign({}, empty, base, { kind: 'first', reason: 'second-no-streak' });
  }
  return Object.assign({}, empty, base, { kind: 'second', reason: 'second-diverge' });
}

/**
 * 二次分歧日 → 退潮提示语（用户：「提示应该是二次分歧等同该题材退潮」）。
 * 只产出短语，标题拼装由调用方（§21：文案集中，但本函数只给可复用的短句）。
 *
 * @param {{kind:string, secondDate:string, firstDate:string, boardsAfterFirst:number}} d
 * @param {string} topic 题材名
 * @returns {string} 空串 = 不是二次分歧
 */
export function divergeTitleOf(d, topic) {
  const t = String(topic || '').trim() || '总龙题材';
  const x = d || {};
  if (x.kind !== 'second') return '';
  return t + '二次分歧 · 等同退潮';
}

/** 二次分歧/首次分歧的一句话依据（判定可追溯，§10；⛔ 不含行情数值以外的推测） */
export function divergeNoteOf(d, topic) {
  const x = d || {};
  const t = String(topic || '').trim() || '总龙题材';
  if (x.kind === 'second') {
    return '（第二十五条：总龙霸榜总龙一 ' + String(x.dragonDays) + ' 天（门槛 ' + DIVERGE_TOTAL_DAYS_MIN +
      '）；【首次分歧 ' + x.firstDate + '】之后 ' + DIVERGE_SECOND_BOARD_WINDOW + ' 个交易日内有 ' +
      String(x.boardsAfterFirst) + ' 个涨停（门槛 ' + DIVERGE_SECOND_MIN_BOARDS +
      '）；【二次分歧 ' + x.secondDate + '】⇒ 按用户口径【等同于首次退潮】，' + t + ' 从这天起确认退潮）';
  }
  if (x.kind === 'first') {
    return '（第二十五条：总龙霸榜总龙一 ' + String(x.dragonDays) + ' 天；【首次分歧 ' + x.firstDate +
      '】' + (x.reason === 'second-no-streak'
        ? ('之后 ' + DIVERGE_SECOND_BOARD_WINDOW + ' 个交易日内只有 ' + String(x.boardsAfterFirst) +
           ' 个涨停（门槛 ' + DIVERGE_SECOND_MIN_BOARDS + '）⇒ 属趋势，还不算二次分歧')
        : '') + '）';
  }
  return '';
}

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [LEADER-DIVERGE-WIRE 2026-11-13] 第二个入口：由【逐日事实数组】直接出判定。
//
// 为什么需要它：`classifyLeaderDiverge` 要的是「一票一天一行、已排好序、已是竞价口径」
// 的成品行。把「原始表行 → 成品行」这一步写在组合式里，就等于在 UI 层再实现一遍口径
// （§5 / §6 双向违规），而且单测无法独立构造。⇒ 这里给一个纯函数收口：
//   · `share` 走 `computeAuctionShare`（竞价量 ÷ 昨日成交量，§6 唯一实现）；
//   · `limitUp` 走「当日收盘涨幅 ≥ 该股涨停幅度 − 容差」（涨停幅度复用 `getLimitUpPct`，
//     主板 10 / 创业板科创板 20 / 北交所 30 / ST 5）；
//   · `isDragonOne` 由调用方给（来自**同一份**竞价口径榜，⛔ 这里不自己排队次）。
//
// ⚠️ 为什么 `closePct` 另取 `dailyPct` 而不用 `market_metrics.change_pct`：
//   那张表的 change_pct 长期停留在 9:25 竞价涨幅（收盘覆盖的 pg_cron 从未真正生效，
//   见 db/supabase_auction_close_cron.sql 的注释）⇒ 拿它判「收盘是不是绿的 / 是不是涨停」
//   会把 11-04 这种「高开低走收绿」的日子判反。`stock_daily_pct.pct` 才是收盘真值。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 涨停判定的容差（%）：收盘涨幅常见 9.97 / 9.98 / 10.00 等四舍五入值，⛔ 不做精确相等 */
export const DIVERGE_LIMIT_UP_TOLERANCE = 0.15;

/**
 * 【纯函数】一天一行 → 判定输入行。
 *
 * @param {{date:string, isDragonOne?:boolean, aucPct?:*, closePct?:*, dailyPct?:*,
 *          volume?:*, yestVolume?:*, limitUpPct?:*}} day
 *        `aucPct` = 竞价涨幅（%）；`closePct` = 收盘涨幅（%，`market_metrics.change_pct`）；
 *        `dailyPct` = 收盘涨幅（%，`stock_daily_pct.pct`，更可信，优先用它判涨停）；
 *        `volume` / `yestVolume` = 当日竞价量 / 昨日成交量；`limitUpPct` = 该股涨停幅度
 * @returns {{date:string, aucPct:number|null, closePct:number|null, share:number|null,
 *            limitUp:boolean|null, isDragonOne:boolean}}
 *          `limitUp = null` ⇒ 拿不到收盘真值（§10 未知 ≠ 没涨停，⛔ 不折成 false 参与判定）
 */
export function buildDivergeDayRow(day) {
  const d = day || {};
  const auc = _n(d.aucPct);
  // 收盘涨幅：`dailyPct`（stock_daily_pct 真值）优先，退化到 change_pct
  const close = _n(d.dailyPct) !== null ? _n(d.dailyPct) : _n(d.closePct);
  // 竞价占比：与决策看板同一条公式（§6：只认 auction-share 那一份实现）
  const share = computeAuctionShare(d.volume, d.yestVolume);
  const thr = _n(d.limitUpPct);
  let limitUp = null;
  if (close !== null && thr !== null && thr > 0) {
    limitUp = close >= (thr - DIVERGE_LIMIT_UP_TOLERANCE);
  } else if (close !== null) {
    // 涨停幅度读不到（代码缺失）：按主板 10% 判，但只认「明显到 10%」的那一档 ——
    // 20% 板块的 15% 会被漏掉（漏判 = 少一个起点），⛔ 不会误判出涨停。
    limitUp = close >= (10 - DIVERGE_LIMIT_UP_TOLERANCE);
  }
  return {
    date: String(d.date || '').trim(),
    aucPct: auc,
    closePct: close,
    share: share,
    limitUp: limitUp,
    isDragonOne: !!d.isDragonOne
  };
}

/**
 * ★★ [LEADER-DIVERGE-WIRE] 逐日事实 → 第二十五条判定（组合式只调这一个函数）。
 *
 * @param {Array<object>} days 见 `buildDivergeDayRow`（顺序无所谓，内部按日期升序）
 * @returns {ReturnType<typeof classifyLeaderDiverge> & {rows:Array, dragonDays:number, windowDays:number}}
 *          `rows` 留痕（说明区可逐日追溯）；`kind:'unknown'` ⇒ 调用方不得据它改文案
 */
export function runLeaderDiverge(days) {
  const rows = (Array.isArray(days) ? days : [])
    .map(buildDivergeDayRow)
    .filter(function (r) { return !!r.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  if (rows.length === 0) {
    const empty = classifyLeaderDiverge([], { dragonDays: null });
    return Object.assign(empty, { rows: [], dragonDays: 0, windowDays: DIVERGE_WINDOW_DAYS });
  }
  // 总龙资格：近 N 日当【总龙一】的天数（口径 = 调用方喂的 isDragonOne，来自同一份竞价榜）
  const dragonDays = rows.filter(function (r) { return r.isDragonOne; }).length;
  const win = rows.slice(-DIVERGE_WINDOW_DAYS);
  const res = classifyLeaderDiverge(win, { dragonDays: dragonDays, windowDays: DIVERGE_WINDOW_DAYS });
  return Object.assign(res, { rows: win, dragonDays: dragonDays, windowDays: DIVERGE_WINDOW_DAYS });
}
