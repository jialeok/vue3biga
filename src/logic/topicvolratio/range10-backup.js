/**
 * range10-backup.js — 「十日涨幅 · 在列次数候补」的【唯一判定实现】（Logic 层纯函数）。
 *
 * ============================================================================
 * 用户口径（2026-10-24，逐字）：
 *   「10月20日，主线题材二次确认退潮当天，龙头首次分歧次日，按照题材平均量比排名第二的题材，
 *     比如松霖科技在的房地产，题材量比太小，只有 7.47，小于空仓门槛量比 25，题材量比太小禁止选入，
 *     应该选十日涨幅首次在列龙头而且是排名前十的，进行替换，而且排名靠前的，首次在列，
 *     排名靠前的是海洋王，排名第八。所以选它。」
 *   「排名第二的题材如果量比太小就用 10 日涨幅，首次在列进行候补，如果排名前十没有首次在列标签，
 *     就用二次在列排名靠前候补，因为龙头的量比都比题材大，那才是核心，应该用 10 日涨幅候补，
 *     这样可以选出有潜质的新龙，因为 20 日老周期结束，现在轮到十日周期。」
 *   「不管是首次在列，或者二次在列都要和 20 日涨幅的总龙一是不同题材，还有都是排名前十，
 *     这几个条件同时满足，不然如果不符合都要空仓。」
 *   「常规的是排名第一的题材如果平均量比小于标准 25，也一率作废。进入候选的是十日涨幅题材新股票的
 *     排名靠前的新股票（首次在列或者二次在列），新面孔。有首次在列的只选一只，没有首次在列的，
 *     选二次在列的。如果都没有，依旧空仓。」
 * ============================================================================
 *
 * 职责边界（§3/§4/§21）：
 *   · 本模块【只做一件事】：给一份「当日 10 日涨幅池」，挑出那【至多一只】候补票。
 *   · ⛔ 不取数、不落库、不发请求；池子由采集层（decision-collect#range10Rows）注入，
 *     在列次数由 Data 层（auction_presence）注入 —— 与本模块无关。
 *   · ⛔ 不判题材量比门槛（谁作废由规则层用 TVRB_CASH_ALERT_AVG_VR 一处判），
 *     本模块只回答「如果要用候补，该选谁 / 为什么选不出」。
 *
 * 「排名前十」的口径（§6 单一真相 —— 与屏幕上那枚标签同一把尺子）：
 *   = 早盘竞价看板「10 日涨幅」toggle 里**带在列次数标签**的那十只
 *     （presence-label.js#assignPresenceLabels：非主板【不占名次】、缺涨幅不占名次）。
 *   ⚠️ 10-20 实测：海洋王 按「只数主板」的名次是第 7，按屏幕行号是第 8 ——
 *      两种都能选中它；但口径必须唯一，故一律用「主板名次 ≤ PRESENCE_TOP_N」，
 *      这样「前十」与「带标签的那十只」永远是同一批（用户看到什么就能选什么）。
 *
 * 「首次在列 / 二次在列」的口径：
 *   · 首次在列 = 窗口内（含今天）在 `auction_watchlist` 只出现过 1 次；
 *   · 二次在列 = 出现过 2 次；
 *   · 次数由预计算表 auction_presence（window_days = 10）给出，标签文案复用 presenceLabelOf（§6）。
 *   §10：次数数据未到（counts = null / coveredDays = 0）⇒ 判不出 ⇒ ⛔ 绝不当 0 次用。
 *
 * 排序（§6）：复用 range-pct-sort.js#sortIndicesByRangePct（与「10 日涨幅」toggle 同一个排序函数），
 *   ⛔ 不在这里另写一份「按 pct 降序」—— 缺数据置底 / 稳定排序这两个细节一旦分叉，
 *   候补就会从「屏幕上第 8 行」滑到别的票上。
 */

import { sortIndicesByRangePct } from '../auction/range-pct-sort.js';
// [MAIN-BOARD-RANK] 「只有主板占名次」的判据走 limit-up.js 的唯一实现（§6），
//   ⛔ 不在这里手写 /^30|68|43/ 前缀（板块分类只有 getBoardKind 一处真相）。
import { isMainBoardRankEligible } from '../auction/limit-up.js';
import { PRESENCE_TOP_N, presenceLabelOf, PRESENCE_WINDOW_10 } from '../auction/presence-label.js';

/** 用户口径编号（规则手册「第二十九条」；本模块只供文案引用，⛔ 不参与判定） */
export const RANGE10_BACKUP_RULE_NO = '二十九';
/** 窗口天数：候补看的是「10 日涨幅」周期（用户：「20 日老周期结束，现在轮到十日周期」） */
export const RANGE10_BACKUP_WINDOW_DAYS = PRESENCE_WINDOW_10;
/** 首次在列的次数 */
export const RANGE10_CNT_FIRST = 1;
/** 二次在列的次数 */
export const RANGE10_CNT_SECOND = 2;

/**
 * 【纯函数】把注入的十日涨幅池排成「屏幕顺序 + 主板名次」。
 *
 * @param {Array<{name:string, code?:string, topic?:string, pct:number|string|null}>} pool
 *        当日名单（decision-collect#range10Rows：name / code / topic / pct=十日涨幅）
 * @returns {Array<{name:string, code:string, topic:string, pct:number|null,
 *                  mainBoard:boolean, rank:number|null}>}
 *         按涨幅降序（= 屏幕行序）；rank = 主板名次（非主板 / 缺涨幅 ⇒ null，不占名次）
 */
export function buildRange10Ranked(pool) {
  const items = [];
  const seen = new Set();
  (pool || []).forEach(function(r) {
    if (!r) return;
    const name = String(r.name || r.stock || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const raw = r.pct;
    let pct = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (isFinite(n)) pct = n;
    }
    items.push({
      name: name,
      code: String(r.code || '').trim(),
      topic: String(r.topic || '').trim(),
      pct: pct,
      // sortIndicesByRangePct 的行契约是 `row.stock`（与早盘竞价的 renderList 同形）
      stock: name
    });
  });
  if (items.length === 0) return [];

  // 排序走【同一个实现】（§6）：把「池」映射成它要的 rows + rangeMap，索引数组自己造。
  const rangeMap = new Map();
  items.forEach(function(it) { rangeMap.set(it.name, { pct: it.pct }); });
  const order = sortIndicesByRangePct(items.map(function(_, i) { return i; }), items, rangeMap);

  const out = [];
  let rank = 0;
  order.forEach(function(idx) {
    const it = items[idx];
    const mainBoard = isMainBoardRankEligible(it.code);
    let r = null;
    // 与 presence-label.js#assignPresenceLabels 完全同序：缺涨幅 / 非主板 ⇒ 跳过且【不占名次】
    if (it.pct !== null && mainBoard) {
      rank += 1;
      r = rank;
    }
    out.push({
      name: it.name, code: it.code, topic: it.topic, pct: it.pct,
      mainBoard: mainBoard, rank: r
    });
  });
  return out;
}

/**
 * 【纯函数】挑出那至多一只「十日涨幅候补」。
 *
 * 判定顺序（每一步都写进 trail，可追溯 —— §10 结论必须能被复核）：
 *   ① 取「主板名次 ≤ topN」的那十只（缺涨幅 / 非主板不占名次）；
 *   ② 逐只剔除：已在今日买点侧（不重复）/ 题材未知（判不出是否同题材）/ 与排除题材同类；
 *   ③ 第一档 = 首次在列（cnt=1），第二档 = 二次在列（cnt=2）；
 *      按名次从前往后取第一只（用户：「有首次在列的只选一只，没有首次在列的，选二次在列的」）。
 *      ⚠️ 「没有首次在列」按【剔除后仍可用】解释：一档里全是同题材 / 重复的，
 *         等于「没有可用的首次在列」⇒ 才看二档；两档都空 ⇒ 返回 pick=null（= 空仓）。
 *   ④ 选中即停，⛔ 绝不多选（用户：「有首次在列的只选一只」）。
 *
 * @param {Array} pool 见 buildRange10Ranked
 * @param {{counts?:Map<string,{cnt:number}>|null, coveredDays?:number, topN?:number,
 *          excludeName?:Set<string>, excludeTopics?:string[],
 *          sameTopic?:(a:string,b:string)=>boolean}} [opts]
 *        counts        = auction_presence 的次数表（null ⇒ 数据未到 ⇒ 判不出）
 *        coveredDays   = 窗口内实际有名单数据的天数（0 ⇒ 判不出）
 *        excludeName   = 今日买点侧已有的股票名（防重复）
 *        excludeTopics = 必须避开的题材（20 日涨幅总龙一的题材 + 当日被作废的弱题材）
 *        sameTopic     = 题材认亲（规则层注入【大类归一】后的比较函数，§6）；缺省严格相等
 * @returns {{ready:boolean, reason:string, pick:object|null, tier:'first'|'second'|'',
 *            trail:Array<object>, topN:number, coveredDays:number, windowDays:number}}
 */
export function pickRange10Backup(pool, opts) {
  const o = opts || {};
  const rawN = Number(o.topN);
  const topN = (isFinite(rawN) && rawN > 0) ? Math.floor(rawN) : PRESENCE_TOP_N;
  const counts = (o.counts && typeof o.counts.get === 'function') ? o.counts : null;
  const coveredDays = Number(o.coveredDays) > 0 ? Math.floor(Number(o.coveredDays)) : 0;
  const excludeName = (o.excludeName && typeof o.excludeName.has === 'function') ? o.excludeName : new Set();
  const sameTopic = (typeof o.sameTopic === 'function')
    ? o.sameTopic
    : function(a, b) { return !!a && !!b && String(a) === String(b); };
  const excludeTopics = (Array.isArray(o.excludeTopics) ? o.excludeTopics : [])
    .map(function(t) { return String(t || '').trim(); })
    .filter(function(t) { return !!t; });

  const out = {
    ready: false,
    reason: '',
    pick: null,
    tier: '',
    trail: [],
    topN: topN,
    coveredDays: coveredDays,
    windowDays: RANGE10_BACKUP_WINDOW_DAYS
  };

  const ranked = buildRange10Ranked(pool);
  if (ranked.length === 0) {
    out.reason = '当日十日涨幅名单未就绪（数据未到）⇒ 判不出候补';
    return out;
  }
  // §10：次数未到 ⇒ 判不出（⛔ 绝不把「不知道」当成「首次在列」）
  if (!counts || coveredDays <= 0) {
    out.reason = '十日窗口的在列次数（auction_presence）未读到 ⇒ 判不出「首次 / 二次在列」⇒ 候补不生效';
    return out;
  }
  out.ready = true;

  const top = ranked.filter(function(it) { return it.rank !== null && it.rank <= topN; });
  if (top.length === 0) {
    out.reason = '十日涨幅前 ' + topN + ' 名里没有主板票 ⇒ 无可选候补';
    return out;
  }

  const judged = top.map(function(it) {
    const hit = counts.get(it.name);
    // 命中不到 ⇒ 窗口内真的一次都没进过名单（今天在名单里的票必然 cnt ≥ 1）⇒ 0 次
    const rawCnt = hit ? Number(hit.cnt) : 0;
    const cnt = (isFinite(rawCnt) && rawCnt >= 0) ? Math.floor(rawCnt) : 0;
    let reason = '';
    if (excludeName.has(it.name)) {
      reason = '已在今日买点侧（不重复列）';
    } else if (!it.topic) {
      reason = '题材未知 ⇒ 判不出是否与总龙一同题材（§10 不猜）';
    } else {
      for (let i = 0; i < excludeTopics.length; i++) {
        if (sameTopic(it.topic, excludeTopics[i])) {
          reason = '与【' + excludeTopics[i] + '】同题材（老周期 / 已作废题材）';
          break;
        }
      }
    }
    return {
      name: it.name, code: it.code, topic: it.topic, pct: it.pct, rank: it.rank,
      cnt: cnt, label: presenceLabelOf(cnt), reason: reason
    };
  });
  out.trail = judged;

  const first = judged.filter(function(j) { return !j.reason && j.cnt === RANGE10_CNT_FIRST; });
  const second = judged.filter(function(j) { return !j.reason && j.cnt === RANGE10_CNT_SECOND; });
  const tier1 = first[0] || null;
  const tier2 = second[0] || null;
  const pick = tier1 || tier2;
  if (!pick) {
    out.reason = '十日涨幅前 ' + topN + ' 名里没有【首次在列 / 二次在列】且与总龙一不同题材的主板票' +
      '（有首次在列只选一只；没有首次在列才看二次在列）⇒ 今天空仓';
    return out;
  }
  out.pick = pick;
  out.tier = tier1 ? 'first' : 'second';
  return out;
}
