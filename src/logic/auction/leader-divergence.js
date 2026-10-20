// leader-divergence.js — 「市场总龙一 · 首次分歧」判定（Logic 层，§15 独立业务模块，纯函数无副作用）
//
// ===== 产品口径（2026-10-20 用户原话，逐字锚点）=====
//   「分歧是什么意思？意思是竞价涨幅低于预期值（竞价涨幅首次小于0）。比如新华传媒连续11个板后，
//    竞价涨幅低开-1.06%，这是首次分歧了。」
//   「你应该找到这20个交易日的首板（首次涨停），从这个首板开始算起。」
//   「9月28日之前那些竞价低开的涨幅（没有涨停的）都不算分歧，所以要找到20日内的首板很关键。」
//   「10月16日出现分歧后涨停板，出现这个涨停板也很重要，这叫分歧转一致……转一致的意思是
//    大家一致看好，预期会涨，不然不会分歧后（下跌）有涨停，因为它是龙头。」
//   「如果分歧转一致后（涨停板为准），次日再低开（竞价涨幅小于0）……这也算第二次分歧了，
//    10月18日，又涨停，这叫做二次分歧转一致了。依次类推。」
//   「所以市场总龙一，第一次出现分歧的时候，是买点。」
//
// ===== 三个核心时间点（用户要求先理清、先注释，后期会用到这些术语）=====
//   ① 【首板时间】firstBoardYmd = 20 日窗口内【第一个收盘涨停日】。
//      ⛔ 首板之前的所有日子（小阴小阳 / 竞价忽高忽低）【一概不算分歧】—— 分歧计数从首板日起算。
//   ② 【首次分歧时间】firstDivergenceYmd = 首板日（含）之后第一个【竞价涨幅 < 0】的日子。
//      ⛔ 判定「今天是不是首次分歧」= 展示日是分歧日 ∧ [首板日, 展示日前一天] 里没有任何分歧日。
//   ③ 【分歧转一致时间】consensusYmd = 分歧日之后（可以隔几天）出现的【涨停日】。
//      分歧转一致后再低开 = 【第二次分歧】，再涨停 = 二次分歧转一致，依此类推（events 数组全留痕）。
//      ★ 本轮只【记录与说明】，不参与买点（用户「后期会用到这个术语，现在先别管」）。
//
// ===== 数据源（全部 0 猫抓额度）=====
//   · 每天收盘涨幅 pct：同花顺 K 线（fetchFuyaoDailyPctRange，免费）—— 涨停判定用；
//   · 每天竞价涨幅 openPct：同一根 K 线的 open_price / 昨收 - 1（A 股开盘价 = 9:25 集合竞价
//     成交价，两者同一价格）—— 分歧判定用；
//   · 展示日的竞价涨幅：优先用行情行的真实竞价涨幅（todayAucPct 入参），取不到退回 K 线 openPct。
//
// ===== 判不出（§10 宁缺勿错）=====
//   · 窗口内一根 K 线都没有 / 找不到首板 ⇒ canJudge=false（没有锚点，无从谈分歧）；
//   · 展示日既没有行情竞价涨幅、K 线也没这根 bar ⇒ canJudge=false；
//   · 停牌日（K 线缺 bar）【不算分歧日】（停牌没有竞价）—— 但首板日本身缺 bar ⇒ 判不出。

import { getCloseLimitState } from './limit-up.js';
import { isMainBoardOnly } from './range20-leaders.js';
import { sameTopicText } from '../decision/decision-collect.js';

/**
 * 【纯函数】总龙首次分歧日的【跟随高标】选股（≤2 只）。
 *
 * 用户口径（2026-10-20 原话）：「分歧日市场总龙一只会带动不同题材的高标股票（20日涨幅前五的，
 * 主板的），同题材的下跌很厉害……总龙三和总龙一同题材，淘汰掉，总龙五是非主板，淘汰掉」。
 *
 * 判据与退潮替补【同一把尺子】（§6，全部只搬运既有实现）：
 *   ① 排除总龙自己；② 排除非主板（isMainBoardOnly）；③ 排除与总龙同题材（sameTopicText 分段匹配）；
 *   ④ 剩下的按 20日涨幅排名（rank20 升序）取前 2 只。
 * §10：题材解析不到 ⇒ 无法证明「与总龙不同题材」⇒ 保守排除（trail 留痕，⛔ 不猜）。
 *
 * @param {Array<{name:string, code:string, topic:string, rank20:number}>|null} top5
 *        ebbCtx.top5（decision-collect 前五事实化结果，已含今日题材）
 * @param {string} leaderName 总龙名
 * @param {string} leaderTopic 总龙题材
 * @returns {{followers:Array<object>, trail:Array<{name:string, picked:boolean, reason:string}>}}
 */
export function pickDivergeFollowers(top5, leaderName, leaderTopic) {
  const followers = [];
  const trail = [];
  const ln = String(leaderName || '').trim();
  const lt = String(leaderTopic || '').trim();
  ((top5 || [])).forEach(function(c) {
    if (!c || !c.name) return;
    const name = String(c.name).trim();
    if (name === ln) return;                        // 总龙自己不进跟随（它是买点本身）
    if (!isMainBoardOnly(String(c.code || ''))) {
      trail.push({ name: name, picked: false, reason: '非主板（创业板/科创板/北交所）⇒ 排除' });
      return;
    }
    const tp = String(c.topic || '').trim();
    if (!tp) {
      trail.push({ name: name, picked: false, reason: '题材解析不到 ⇒ 无法证明与总龙不同题材，保守排除' });
      return;
    }
    if (sameTopicText(lt, tp)) {
      trail.push({ name: name, picked: false, reason: '与总龙一同题材（' + lt + '）⇒ 排除' });
      return;
    }
    if (followers.length < 2) {
      followers.push(c);
      trail.push({ name: name, picked: true, reason: '主板、与总龙一不同题材 ⇒ 入选' });
    } else {
      trail.push({ name: name, picked: false, reason: '两只跟随已选满 ⇒ 不再选' });
    }
  });
  return { followers: followers, trail: trail };
}

/**
 * 【纯函数】总龙分歧判定。
 *
 * @param {{
 *   pctByYmd: Map<string, number>,       // ymd(YYYYMMDD) -> 收盘涨幅%（K线；缺 bar = 无键）
 *   openPctByYmd: Map<string, number|null>, // ymd -> 竞价涨幅%（K线 open/昨收-1；有 bar 无 open ⇒ null）
 *   dates: string[],                     // 窗口交易日【升序】YYYY-MM-DD
 *   code: string,                        // 6 位代码（涨停幅度按板块判定）
 *   name: string,                        // 股票名（ST 判定）
 *   viewDate: string,                    // 展示日 YYYY-MM-DD
 *   todayAucPct: number|null,            // 展示日行情行的竞价涨幅（优先；null ⇒ 退回 K线 openPct）
 * }} input
 * @returns {{
 *   ready: boolean,          // 输入齐不齐（齐了才有资格谈判定；§10 能不能 vs 有没有）
 *   canJudge: boolean,       // 判据链走通了没有（false = 判不出，⛔ 不是「没分歧」）
 *   firstBoardYmd: string,   // 首板日 YYYY-MM-DD（判不出 ⇒ ''）
 *   firstDivergenceYmd: string, // 首次分歧日（判不出 ⇒ ''）
 *   todayFirstDivergence: boolean, // 展示日 = 首次分歧日（canJudge=false ⇒ 恒 false）
 *   todayAucPct: number|null,      // 展示日采用的竞价涨幅（来源见上）
 *   events: Array<{ymd:string, kind:'diverge'|'consensus', pct:number}>, // 首板起 分歧/转一致 全留痕
 * }}
 */
export function buildLeaderDivergence(input) {
  const o = input || {};
  const pct = (o.pctByYmd instanceof Map) ? o.pctByYmd : new Map();
  const open = (o.openPctByYmd instanceof Map) ? o.openPctByYmd : new Map();
  const dates = Array.isArray(o.dates) ? o.dates.slice().sort() : [];
  const code = String(o.code || '');
  const name = String(o.name || '');
  const viewDate = String(o.viewDate || '').replace(/-/g, '');
  const none = {
    ready: false, canJudge: false, firstBoardYmd: '', firstDivergenceYmd: '',
    todayFirstDivergence: false, todayAucPct: null, events: []
  };
  if (!viewDate || dates.length === 0 || pct.size === 0) return none;

  const ymdOf = function(d) { return String(d).replace(/-/g, ''); };
  const viewYmd = ymdOf(viewDate);

  // ── ① 首板：窗口内【第一个收盘涨停日】（涨停幅度按板块，与连板天梯同一把尺子 §6）──
  let firstBoardYmd = '';
  for (let i = 0; i < dates.length; i++) {
    const ymd = ymdOf(dates[i]);
    const p = pct.get(ymd);
    if (p === undefined || p === null || !isFinite(Number(p))) continue;   // 停牌 / 缺 bar ⇒ 跳过
    if (getCloseLimitState(Number(p), code, name) === 'up') { firstBoardYmd = ymd; break; }
  }
  if (!firstBoardYmd) {
    // 窗口内没有涨停 ⇒ 没有锚点（首板之前的小阴小阳一概不算分歧 —— 用户口径）
    return Object.assign(none, { ready: true, canJudge: false });
  }

  // ── ② 首板起的 逐日事件流：分歧 = 竞价涨幅 < 0；转一致 = 涨停 ──
  const events = [];
  let firstDivergenceYmd = '';
  for (let i = 0; i < dates.length; i++) {
    const ymd = ymdOf(dates[i]);
    if (ymd < firstBoardYmd) continue;                       // 首板之前一概不算（用户口径）
    const closePct = pct.get(ymd);
    const isView = (ymd === viewYmd);
    // 竞价涨幅：展示日优先用行情行的真实竞价涨幅（9:25 那一刻），其余日子用 K 线 open/昨收。
    let aucPct;
    if (isView) {
      aucPct = (o.todayAucPct !== null && o.todayAucPct !== undefined && isFinite(Number(o.todayAucPct)))
        ? Number(o.todayAucPct)
        : (open.has(ymd) ? open.get(ymd) : null);
      if (aucPct === null || aucPct === undefined || !isFinite(Number(aucPct))) {
        // 展示日既没有行情竞价涨幅、K 线也没这根 bar 的 open ⇒ 判不出（§10）
        return Object.assign(none, { ready: true, canJudge: false, firstBoardYmd: firstBoardYmd });
      }
    } else {
      if (closePct === undefined || closePct === null) continue;   // 停牌 / 缺 bar ⇒ 不算分歧日
      const op = open.has(ymd) ? open.get(ymd) : null;
      // 中间日缺 open ⇒ 无法证明「那天没有低开」⇒ 整条「首次」链路判不出（§10 宁缺勿错）
      if (op === null || op === undefined || !isFinite(Number(op))) {
        return Object.assign(none, { ready: true, canJudge: false, firstBoardYmd: firstBoardYmd });
      }
      aucPct = Number(op);
    }
    if (aucPct < 0) {
      if (!firstDivergenceYmd) firstDivergenceYmd = ymd;
      events.push({ ymd: ymd, kind: 'diverge', pct: aucPct });
    } else if (getCloseLimitState(Number(closePct), code, name) === 'up') {
      events.push({ ymd: ymd, kind: 'consensus', pct: Number(closePct) });
    }
  }

  return {
    ready: true,
    canJudge: true,
    firstBoardYmd: firstBoardYmd,
    firstDivergenceYmd: firstDivergenceYmd,
    // 展示日 = 首次分歧日 ⇔ 首次分歧日就是展示日
    todayFirstDivergence: (firstDivergenceYmd === viewYmd),
    todayAucPct: (function() {
      const ev = events.filter(function(e) { return e.ymd === viewYmd; })[0];
      return ev ? ev.pct : null;
    })(),
    events: events
  };
}
