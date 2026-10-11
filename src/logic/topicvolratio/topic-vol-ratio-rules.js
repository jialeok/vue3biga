// topic-vol-ratio-rules.js — 「题材量比」看板 · 纯规则（Logic 层，§15 独立业务模块，可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-10-11 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「帮我再做一个看板，名称是题材量比……功能和布局设计和决策看板差不多。只是选股逻辑不一样。
//     选股逻辑按照早盘竞价看板题材的平均竞价量比由高到低选排名第一和排名第二的题材，
//     有题材中的个股数量有条件限制，小于4只的不入选，大于等于4小于等于8的入选1只，
//     大于8只的入选2只，因为早盘竞价看板股票数量就少，所以只有这三档，
//     入选的股票按龙一龙二……，龙一竞价涨停的，看龙二，龙二竞价涨停的看龙三……依次类推。」
//   举例：机器人 3 只（量比 78，排第一，数量不够排除）→ AI应用 5 只（68，排第二，选 1 只）
//        → 大消费 10 只（45，排第三，选 2 只）。
//
// 职责边界（§4 / §2）：本文件是【纯函数】—— 不读 state、不发请求、不写库、不消费猫抓额度、
//   只接受「已排好序的题材块 + 龙位名册」两个入参，产出 UI 可直接渲染的结构。
//
// 数据口径（§6 单一真相，⛔ 本文件绝不另写一套排名 / 分组）：
//   · 题材排名（平均竞价量比降序）→ 复用 decision-rules.js#rankDecisionTopics(entries, MODE_VOL_RATIO)
//     （由 decision-collect.js#collectDecisionTopics 调用 —— 与早盘竞价「题材 toggle」同一套组序口径）；
//   · 题材内龙位（龙一 / 龙二 …） → 复用 decision-rules.js#rankDragons（= computeDragonRankMap）——
//     ⭐【只发主板龙标签】这条闸门就在 computeDragonRankMap 里（创业板 / 科创板 rank 恒为 null），
//     所以「有没有龙位」不需要本文件再判一次板块：rank === null 就是它的结论（§6 不重复实现）。
//   · 行内徽标（十日涨幅 / 竞价涨幅 / 竞价量比 + 近 5 日趋势）→ 与决策看板同一批格式化函数。
//
// §10 红线：任何缺数据（十日涨幅未加载、竞价量比缺失、龙位算不出）都【不猜】：
//   · 缺量比 → 该题材平均量比显示「—」，且排在最后（由 sortByTopicGroups 的置底口径保证）；
//   · 无龙位（创业板 / 科创板）→ 不进候选（由下面 _dragonCandidates 的 rank 过滤保证）；
//   · 未就绪 → 由 decision-collect#collectDecisionTopics 给 ready=false + 明确 reason，UI 如实展示。

import { formatRangePct } from '../decision/decision-rules.js';
import { formatAucPct } from '../auction/limit-up.js';
import { getAucOpenKind } from '../ladder/ladder-rules.js';
import { getDragonLabel } from '../auction/dragon-rank.js';
import { VOL_RATIO_TREND_DAYS, decorateVolRatioFields } from '../decision/vol-ratio-trend.js';

// ══ 档位常量（§6 唯一实现：本看板的「取几只」只由这里决定）════════════════════════════════
// 用户口径：< 4 只不入选；4 ~ 8 只入选 1 只；> 8 只入选 2 只（早盘竞价股票少，只有这三档）。
// ⛔ 别自行改成 ≥ 8 / > 10 之类：三个边界与用户原话「小于4」「大于等于4小于等于8」「大于8」逐字对应。
/** 不入选门槛：题材股票数量 < 本值 ⇒ 该题材排除（顺延到下一题材） */
export const TVRB_MIN_COUNT = 4;
/** 中档上界：TVRB_MIN_COUNT ~ 本值 ⇒ 取 1 只 */
export const TVRB_MID_MAX = 8;
/** 中档取几只 */
export const TVRB_PICK_MID = 1;
/** 大档（> TVRB_MID_MAX）取几只 */
export const TVRB_PICK_BIG = 2;
/** 只取排名最靠前的【几个】入选题材（用户口径「排名第一和排名第二」，不足则顺延） */
export const TVRB_TOPIC_LIMIT = 2;

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 【题材股票数量 → 本看板档位】（§6 唯一实现）。
 *
 * 用户口径（2026-10-11）：
 *   < 4 只     → 'none'：该题材【不入选】（排除，顺延到下一题材）
 *   4 ~ 8 只   → 'mid' ：入选 1 只
 *   > 8 只     → 'big' ：入选 2 只
 *
 * §10：count 缺失 / 非法 → 按 0 处理 ⇒ 落到 'none'（不入选），
 *      ⛔ 绝不因为「数字没读到」就假装它是一只大题材去铺票。
 *
 * @param {number|string|null} count 题材在早盘竞价里的股票只数（block.count）
 * @returns {{tier:'none'|'mid'|'big', count:number, pickCount:number, rangeText:string}}
 */
export function resolveTvrbTier(count) {
  const n = _num(count);
  const c = (n === null || n < 0) ? 0 : Math.floor(n);
  if (c < TVRB_MIN_COUNT) {
    return { tier: 'none', count: c, pickCount: 0, rangeText: '不足 ' + TVRB_MIN_COUNT + ' 只' };
  }
  if (c <= TVRB_MID_MAX) {
    return {
      tier: 'mid', count: c, pickCount: TVRB_PICK_MID,
      rangeText: TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只'
    };
  }
  return {
    tier: 'big', count: c, pickCount: TVRB_PICK_BIG,
    rangeText: '> ' + TVRB_MID_MAX + ' 只'
  };
}

/**
 * 题材的【平均竞价量比】—— 与 rankDecisionTopics 用来排序的口径【完全一致】（§6 单一真相）。
 *
 * 口径 = 该题材组内【所有拿到量比的行】的量比之和 ÷ 拿到量比的行数。
 *   · 含灰行（不可计数的继承票）—— 与早盘竞价统计条同一个分母；
 *   · 一行都拿不到 ⇒ null（§10：绝不返回 0，那会被读成「量比极小」）。
 *
 * ⛔ 排序本身【不在这里做】：题材顺序由 rankDecisionTopics（= sortByTopicGroups）给出，
 *   本函数只负责把那个顺序背后的数值【显示出来】，两处若各写一份必然分叉。
 *
 * @param {object} block rankDecisionTopics 返回的题材块（members 里有 aucVolRatio）
 * @returns {number|null}
 */
export function avgVolRatioOf(block) {
  const ms = (block && block.members) || [];
  let sum = 0;
  let n = 0;
  ms.forEach(function(m) {
    const v = _num(m && m.aucVolRatio);
    if (v === null) return;
    sum += v;
    n++;
  });
  return n > 0 ? (sum / n) : null;
}

/** 平均竞价量比 → 展示文案（缺值 → '—'，§10 不补 0.00） */
export function formatAvgVolRatio(v) {
  const n = _num(v);
  return n === null ? '—' : n.toFixed(2);
}

/**
 * 给一只入选股票挂上 UI 要的展示字段（§21：模板零计算）。
 *   · pctText      十日涨幅（复用 decision-rules#formatRangePct；缺失 → 空串）
 *   · aucPctText   竞价涨幅文案（复用 limit-up#formatAucPct；缺失 → 空串）
 *   · aucTone      竞价涨幅配色档（复用 ladder-rules#getAucOpenKind：high/low/flat；缺失 → 空串）
 *   · volRatioText / volRatioTone / volRatioArrow / volRatioTrend / volRatioHasData
 *                  （复用 vol-ratio-trend#decorateVolRatioFields —— 与决策看板同一份实现）
 *
 * ⛔ launch 时 date 缺失 ⇒ 竞价量比趋势留空（不画错曲线）。
 * @param {object} p  入选股票行
 * @param {string} date 展示日
 */
function _decoratePick(p, date) {
  p.pctText = formatRangePct(p.pct);
  const ap = _num(p.aucPct);
  // §10：formatAucPct / getAucOpenKind 内部都按「缺数据 → 空」处理，缺值 ⇒ 徽标不渲染
  p.aucPctText = (ap === null) ? '' : formatAucPct(ap);
  p.aucTone = (ap === null) ? '' : (getAucOpenKind(ap) || '');
  if (date) decorateVolRatioFields(p, date, VOL_RATIO_TREND_DAYS);
  return p;
}

/**
 * 题材块 → 本看板的【可买候选序列】（按【龙位升序】：龙一 → 龙二 → …）。
 *
 * 成分（§6：只做「成员 × 龙位名册」的联结与排序，⛔ 不自己判板块）：
 *   · 龙位取自 dragonMap（= rankDragons 的返回）。⭐【只发主板龙标签】的闸门就在
 *     computeDragonRankMap 里：创业板 300/301、科创板 688/689 的 rank 恒为 null ⇒
 *     这里 `rank === null` 直接剔除，与早盘竞价「没有龙标签」的判定完全同源
 *     （⛔ 绝不在这里另写 getBoardKind / startsWith('30') 之类的板块判断 —— 那就是第二份规则）。
 *   · ⛔ 竞价一字的成员【保留】在序列里（由调用方跳过并顺延）——
 *     用户口径是「龙一竞价涨停的，看龙二」，所以它必须占在序列里才能被识别为「被跳过的那一档」。
 *   · 排序：龙位升序；同龙位（理论上不会出现）按股票名，保证结果可复现、不随机。
 *
 * @param {object} block 题材块（含 members；members 里有 name / isYizi / pct / aucPct / aucVolRatio）
 * @param {Map} dragonMap 龙位名册（rankDragons 的返回）
 * @returns {Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                  aucVolRatio:number|null, rank:number}>}
 */
function _dragonCandidates(block, dragonMap) {
  const dm = dragonMap || new Map();
  const out = [];
  ((block && block.members) || []).forEach(function(m) {
    if (!m || !m.name) return;
    const d = dm.get(m.name);
    const rank = (d && d.rank) ? d.rank : null;
    if (rank === null) return;   // 无龙位（创业板 / 科创板）⇒ 不参与本看板选股（与决策看板同口径）
    out.push({
      name: m.name,
      isYizi: !!m.isYizi,
      pct: _num(m.pct),
      aucPct: _num(m.aucPct),
      aucVolRatio: _num(m.aucVolRatio),
      rank: rank
    });
  });
  out.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

/**
 * 构造一个入选题材的块（题材头 + 入选理由 + 股票行 + 说明）。
 *
 * 选股（用户口径「按龙一龙二……，龙一竞价涨停的看龙二……」）：
 *   ① 候选序列 = _dragonCandidates(block, dragonMap) —— 已剔除无龙位票（创业板 / 科创板）、
 *      已按【龙位升序】排好（龙一 → 龙二 → …）；
 *   ② 从高到低依次取【非竞价涨停】的票，直到取满本档只数（1 或 2 只）；
 *   ③ 竞价涨停（竞价一字）的龙位 ⇒ 买不进 ⇒【跳过并顺延到下一龙位】（⛔ 但与决策看板的
 *      「占名次不递补」不同：本看板用户明确要求【往下顺延】）。
 *
 * @param {object} block   题材块（含 rank / topic / count / yiziCount / members）
 * @param {Map} dragonMap  龙位名册（rankDragons 的返回）
 * @param {string} date    展示日
 * @param {object} tier    resolveTvrbTier 的返回
 * @returns {object} UI 直接可渲染的题材块
 */
function _buildBlock(block, dragonMap, date, tier) {
  const avg = avgVolRatioOf(block);
  const cands = _dragonCandidates(block, dragonMap);
  const picked = [];
  const skipped = [];
  for (let i = 0; i < cands.length && picked.length < tier.pickCount; i++) {
    const c = cands[i];
    if (c.isYizi) { skipped.push(c); continue; }   // 竞价涨停 → 买不进 ⇒ 顺延下一龙位
    picked.push(c);
  }

  const picks = picked.map(function(c, i) {
    return _decoratePick({
      seq: i + 1,
      name: c.name,
      dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
      dragonRank: c.rank,
      pct: c.pct,
      aucPct: c.aucPct,
      aucVolRatio: c.aucVolRatio
    }, date);
  });

  const skippedNames = skipped.map(function(c) {
    return (c.rank ? getDragonLabel(c.rank) : '') + c.name;
  });

  const reason = '按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
    '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
    ' 只；按【龙一 → 龙二 → …】从高到低依次取其非【竞价涨停】的票';

  const notes = [];
  notes.push('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
    '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
    ' 只；入选股票按龙位从高到低依次取，遇到【竞价涨停（竞价一字）】的龙位则顺延到下一个龙位。');
  if (skippedNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedNames.join('、') +
      ' 竞价涨停（买不进）⇒ 已顺延到下一个龙位（用户口径：龙一涨停看龙二，龙二涨停看龙三……）。');
  }
  if (picks.length < tier.pickCount) {
    notes.push('⚠️ 本题材有龙位、且可买入（非竞价涨停）的票不足 ' + tier.pickCount +
      ' 只 ⇒ 实际取 ' + picks.length + ' 只（⛔ 不从其它题材补位）。');
  }

  return {
    topic: block.topic,
    rank: block.rank,
    count: block.count,
    yiziCount: block.yiziCount,
    avgVolRatio: avg,
    avgVolRatioText: formatAvgVolRatio(avg),
    tier: tier.tier,
    pickCount: tier.pickCount,
    rangeText: tier.rangeText,
    reason: reason,
    picks: picks,
    skippedNames: skippedNames,
    notes: notes,
    // §10：本题材是否真的选出了可买的票（false → 组件显示一行说明，不留空壳）
    qualified: picks.length > 0
  };
}

/**
 * 【本看板选股 · 唯一实现（§6）】。
 *
 * @param {Array} topics   rankDecisionTopics(entries, MODE_VOL_RATIO) 的返回（已按平均竞价量比降序、已剔除「其它」/不足 2 只）
 * @param {Map} dragonMap  rankDragons(topics) 的返回
 * @param {{date?:string}} [opts] date = 展示日（喂竞价量比近 5 日趋势）
 * @returns {{topics:Array, blocks:Array, excludedTopics:Array, notes:Array, pickCount:number}}
 *   topics        —— 全部参与排名的题材（含被排除的），按排名，供说明 / 复核
 *   blocks        —— 入选的题材块（≤ TVRB_TOPIC_LIMIT 个），每个含 picks
 *   excludedTopics—— 因数量 < 4 只被排除的题材（仅统计「选够两个之前」遇到的那些）
 *   notes         —— 看板级说明（被排除题材汇总等）
 *   pickCount     —— 实际选出的股票总数
 */
export function buildTopicVolRatioPlan(topics, dragonMap, opts) {
  const list = (topics || []).filter(function(b) { return b && b.topic; });
  const date = opts && opts.date;
  const out = { topics: [], blocks: [], excludedTopics: [], notes: [], pickCount: 0 };

  list.forEach(function(b) {
    out.topics.push({
      rank: b.rank,
      topic: b.topic,
      count: b.count,
      yiziCount: b.yiziCount,
      avgVolRatio: avgVolRatioOf(b)
    });
  });
  if (list.length === 0) return out;

  // 沿题材排名（平均竞价量比降序）往下扫：数量不足的排除并顺延，直到选够 TVRB_TOPIC_LIMIT 个。
  for (let i = 0; i < list.length; i++) {
    if (out.blocks.length >= TVRB_TOPIC_LIMIT) break;
    const b = list[i];
    const tier = resolveTvrbTier(b.count);
    if (tier.tier === 'none') {
      out.excludedTopics.push({
        rank: b.rank, topic: b.topic, count: b.count, avgVolRatio: avgVolRatioOf(b)
      });
      continue;
    }
    out.blocks.push(_buildBlock(b, dragonMap, date, tier));
  }

  out.pickCount = out.blocks.reduce(function(n, blk) { return n + blk.picks.length; }, 0);

  if (out.excludedTopics.length > 0) {
    const names = out.excludedTopics.map(function(t) {
      return t.topic + '（' + t.count + ' 只，量比 ' + formatAvgVolRatio(t.avgVolRatio) + '）';
    }).join('、');
    out.notes.push('⚠️ 按平均竞价量比排名靠前、但股票数量不足 ' + TVRB_MIN_COUNT +
      ' 只 ⇒ 不入选并顺延到下一题材：' + names);
  }
  if (out.blocks.length < TVRB_TOPIC_LIMIT) {
    out.notes.push('当日只有 ' + out.blocks.length + ' 个题材满足条件（数量 ≥ ' + TVRB_MIN_COUNT +
      ' 只），不足 ' + TVRB_TOPIC_LIMIT + ' 个。');
  }

  return out;
}

/**
 * 【规则面板文案】—— 与决策看板同款（灰色问号点开的说明）。
 *
 * ⛔ 文案与判定必须同处一处（§6）：改了 buildTopicVolRatioPlan 的口径，请顺手改这里，
 *   否则用户点开规则看到的条文与实际选股不一致（那是比没有说明更坏的情况）。
 * ⛔ 文案里的数字用常量拼接（⛔ 不要在字符串里写死 4 / 8 / 2）。
 * @returns {string[]} 一行一条
 */
export function buildTvrbRulesLines() {
  return [
    '【题材量比】看板 · 选股规则',
    '一、题材排名：把早盘竞价看板的题材按【平均竞价量比】由高到低排序（与早盘竞价「题材 toggle」同一套组序）。',
    '二、题材数量门槛：题材内股票数量 < ' + TVRB_MIN_COUNT + ' 只 ⇒ 该题材【不入选】；' +
      TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_MID + ' 只；' +
      '> ' + TVRB_MID_MAX + ' 只 ⇒ 该题材选 ' + TVRB_PICK_BIG + ' 只。',
    '三、取几个题材：按排名从高到低往下扫，跳过数量不足的题材，只保留最靠前的 ' +
      TVRB_TOPIC_LIMIT + ' 个入选题材（不足时顺延，直到取够或没有合格题材）。',
    '四、选股顺序：入选题材内按【龙一 → 龙二 → 龙三 …】从高到低依次取票。',
    '五、竞价涨停剔除：某龙位股票【竞价涨停（竞价一字）】⇒ 当天买不进，跳过它并顺延到下一个龙位' +
      '（龙一涨停看龙二，龙二涨停看龙三……依次类推）。',
    '六、只数上限：每个入选题材最多取到本档只数（' + TVRB_PICK_MID + ' 或 ' + TVRB_PICK_BIG +
      ' 只）；该题材可买（非竞价涨停）的票不足时【少取】，⛔ 不从其它题材补位。',
    '七、仅主板：没有龙标签的票（创业板 300/301、科创板 688/689）不参与本看板选股（与决策看板同口径）。',
    '八、数据来源：完全复用早盘竞价看板的题材分组 / 竞价一字 / 十日涨幅 / 竞价量比（与决策看板同一份真相）。',
    '九、本看板【不抓数据、不落库、不消耗猫抓额度】：数据没加载完时如实提示「未就绪」，不给结论。',
    '十、本看板只负责【选股】；具体买卖时机（竞价买 / 尾盘买 / 竞价卖 / 尾盘卖 …）请看【决策】看板。'
  ];
}
