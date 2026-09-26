// decision-rules.js — 「决策」看板的核心规则（Logic 层纯函数，§15 独立业务模块 / §21 模板零计算）
//
// 本文件【只有纯函数】：不读 state、不发请求、不碰 DOM、不 import 任何 store。
// 所有输入输出都是普通对象/数组 → 既方便单测，也保证后期加规则时只动这一个文件。
//
// ── 产品口径（2026-09-24 用户原话整理；后期还会继续完善，此处刻意做成可配置的常量）──
//
// 【买点】只看「排名第一 / 第二」两个题材（题材排名 = 早盘竞价「题材 toggle」的组序，同源）：
//   · 第 1 名题材【竞价一字 ≥ 2 个】⇒ 题材最强，按题材内龙头排名（龙一→龙二→…）取
//     【最靠前的两只非一字涨停】的股票（一字涨停买不进，必须跳过），两只都【重仓】；
//   · 第 1 名题材【竞价一字只有 1 个】⇒ 题材强度打折，改打法：
//       重仓【1 只】——按龙头顺序跳过一字取最靠前的那只（正常情况下就是龙一）；
//       轻仓【龙二～龙五】里「非一字 且 竞价涨幅 > 0」的股票（高开才买）。
//       ⚠️ 竞价涨幅缺失的行不算 > 0（§10：缺数据 ≠ 高开），会单独说明「几只缺竞价涨幅未纳入」；
//   · 第 1 名题材【竞价一字 0 个】⇒ 未达门槛，不给买入建议；
//   · 第 2 名题材：取【一只】最强的（同样按龙头顺序跳过一字），建议【轻仓】。
//   · 【无一字兜底（2026-09-25 用户口径）】当日【所有题材】的竞价一字都是 0 个 ⇒ 弱市，
//     改看【连板天梯 · 题材连扳】：取【股票数量最多】的题材（数量并列时并列的都取），
//     只在它的【龙一 / 龙二】里挑，最终只留【竞价高开】的票：
//       龙一低开 + 龙二高开 → 只买龙二；两只都高开 → 两只都买；两只都低开 → 只买龙一。
//     全部记【轻仓】（没有一字，强度打折）。
//     题材连扳里股票最多的题材【不足 NO_YIZI_MIN_TOPIC_COUNT 只】⇒ 【空仓】（太弱，不参与）。
//     ⚠️ 这条只在「全部题材一字 = 0」时生效；只要有任何一个题材有一字，就仍走上面的 ①～④。
//
// 【卖点】候选 = 【昨日】打过「买」标签的股票：
//   · 今日题材排【第 1 或 第 2】名 ⇒ 14:50 卖（拿满一天）；
//   · 今日题材排名【不在前二】⇒ 11:20 卖（排名靠后，弱了就早走）；
//   · 例外（2026-09-24 用户口径）：今日题材【排第 2】且该题材【只有 1 个竞价一字】⇒ 题材强度打折，
//     【只有龙一】能拿到尾盘（14:50 卖），【其余非龙一】11:20 卖。
//     这一条会让同一个题材组里同时出现两种时点，所以时点是【逐行】算的，不是整组一个值。
//     其中「昨日是龙头（十日涨幅最高）」是用户明确点出的典型情形，写在卖出理由里。
//     ⚠️ 未覆盖的组合一律回落到上面的通用规则，不会给出互相矛盾的建议。要改只改 _decideSellTime 一处。
//
// 【§10 红线】任何一段数据缺失 → 该段【不产出】（返回空/不给出建议），
//   绝不用 0 / '-' / 空字符串伪装成「有数据」。

import { sortByTopicGroups } from '../auction/topic-sort.js';
import { computeDragonRankMap, getDragonLabel } from '../auction/dragon-rank.js';
// 竞价开平（高开 / 低开 / 平开）复用连板天梯的唯一实现，⛔ 不在本文件另写一套阈值与文案（§6）
import { getAucOpenKind, getAucOpenText } from '../ladder/ladder-rules.js';
// 板块（创业板 / 科创板 / 北交所 = 20% / 30% 涨跌幅板）判定复用早盘竞价的唯一实现（§6）：
// 早盘竞价给这类票画浅灰删除线用的就是 isHighLimitBoard，⛔ 本文件不另写 /^(30|68)/ 这类正则。
import { isHighLimitBoard } from '../auction/limit-up.js';

/** 题材成组门槛：与早盘竞价统计条（topic-stats.js#TOPIC_STATS_MIN_GROUP）同源 —— 不足 2 只不成题材 */
export const DECISION_MIN_GROUP = 2;
/** 第 1 名题材触发「双票重仓」所需的最少竞价一字数量（用户口径：两个或两个以上一字） */
export const MIN_YIZI_HEAVY = 2;
/** 第 1 名题材触发「龙一重仓 + 龙二～龙五轻仓」所需的最少竞价一字数量（用户口径：只有一个竞价一字） */
export const MIN_YIZI_SINGLE = 1;
/** 第 1 名题材取几只；第 2 名题材取几只 */
export const PICK_COUNT_HEAVY = 2;
export const PICK_COUNT_SINGLE = 1;
export const PICK_COUNT_LIGHT = 1;
/** 「龙二～龙五」的档位区间（用户口径：龙一到龙五里，龙一做重仓，龙二到龙五找高开的做轻仓） */
export const LADDER_MIN_RANK = 2;
export const LADDER_MAX_RANK = 5;
/** 【无一字兜底】题材连扳里「股票数量最多」的题材至少要有这么多只；不足 ⇒ 太弱，空仓（用户口径） */
export const NO_YIZI_MIN_TOPIC_COUNT = 3;
/** 【无一字兜底】每个入选题材只看最靠前的两只（龙一 / 龙二） */
export const NO_YIZI_PICK_COUNT = 2;
/**
 * 【无一字 · 大题材兜底（2026-09-26 用户口径）】全部题材竞价一字 = 0 时：
 * 早盘竞价里【股票数量 ≥ 10 只】的题材（只看第 1 / 第 2 名）⇒ 选它的【龙一】轻仓。
 * 用户原话：9/4 电子/通信/算力 17 只、AI应用 10 只 → 各选这两个题材的龙一（哪个超过就选哪个）。
 * ⛔ 与 NO_YIZI_MIN_TOPIC_COUNT（题材连扳不足 3 只 → 空仓）是两条【并列】的规则：
 *    先判大题材，不满足才回到原来的「题材连扳」兜底 / 空仓。
 */
export const BIG_TOPIC_MIN_COUNT = 10;

// ===== [SMALL-TOPIC 2026-09-25]「题材太少 + 有 1~2 个一字」的高风险兜底 =====
// 用户口径：早盘竞价题材 toggle 下，排名第 1 / 第 2 的题材如果【股票数量 ≤ 4 只】却【有 1~2 个竞价一字】，
//   大概率是量化资金做出来的假强度（票太少、一字撑起来的排名），按常规规则选票【准确率很低】
//   ⇒ 这种情况下【不用常规规则】，改看连板天梯晋级看板「题材连扳」的题材股票数量来定题材。
/** 触发「高风险小题材」的题材股票数上限（≤ 4 只） */
export const SMALL_TOPIC_MAX_COUNT = 4;
/** 触发所需的一字数量区间（1 ~ 2 个） */
export const SMALL_TOPIC_MIN_YIZI = 1;
export const SMALL_TOPIC_MAX_YIZI = 2;
/** 改用题材连扳后，该题材在【早盘竞价】里的股票总数至少要这么多只才入选（< 4 只 → 排除） */
export const SMALL_TOPIC_MIN_AUCTION_COUNT = 4;
/** 数量最多的题材：在【龙一 ~ 龙五】这个区间里挑 */
export const SMALL_TOPIC_MAX_RANK = 5;
/** 数量最多的题材挑几只（第 1 只重仓，其余轻仓） */
export const SMALL_TOPIC_PICK_COUNT = 2;

/** 卖出时点 */
export const SELL_TIME_MIDDAY = '11:20';
export const SELL_TIME_CLOSE = '14:50';
/** 仓位建议文案 */
export const POSITION_HEAVY = '重仓';
export const POSITION_LIGHT = '轻仓';

const OTHER = '其它';

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 题材名 → 今日排名（1 起）。不在榜（未成组 / 是「其它」/ 不成题材）→ null */
function _topicRankMap(blocks) {
  const m = new Map();
  blocks.forEach(function(b) { m.set(b.topic, b.rank); });
  return m;
}

/**
 * 题材排名 —— 与早盘竞价「题材 toggle」【完全同一套组序口径】。
 * 刻意复用 sortByTopicGroups（早盘竞价就在用它），而不是在本文件另写一遍比较器：
 * 另写必然分叉，分叉就会出现「决策看板说第一、早盘竞价显示第二」的错位（§6 单一真相）。
 *
 * @param {Array<{name:string, topic:string, isYizi?:boolean, countable?:boolean,
 *                inheritSold?:boolean, code?:string, pct?:number|null, aucPct?:number|null}>} entries
 *        countable=false 的行（早盘竞价里「灰色名称 + 灰色题材」= 不在当日正式列表）
 *          不计入数量与一字数 —— 与早盘竞价统计条同口径；
 *          ⛔ 但【2026-09-26 用户口径】它们照常参与龙位与选票（同时期龙头有参考价值），
 *             真正【不参与】的是 inheritSold=true 的「昨日卖标签继承」复盘行（昨天卖了今天不该再买）。
 *        code = 股票代码（判 20%/30% 涨跌幅板用；缺失 → 不猜，§40）。
 *        aucPct = 当日竞价涨幅（%）；null = 缺数据（§10：不能当 0，也就不能当「高开」）。
 * @returns {Array<{rank:number, topic:string, count:number, yiziCount:number,
 *                  members:Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                                 code:string, countable:boolean, inheritSold:boolean}>}>}
 *          已剔除「其它」与不足 DECISION_MIN_GROUP 的题材；按组序（一字多 → 人多 → 题材名）升序。
 */
export function rankDecisionTopics(entries) {
  const list = (entries || []).filter(function(e) { return e && e.name; });
  if (list.length === 0) return [];

  const topicOf = function(i) {
    const t = String(list[i].topic || '').trim();
    return t || OTHER;
  };
  const order = sortByTopicGroups(
    list.map(function(_, i) { return i; }),
    list.map(function(e) { return { stock: e.name }; }),
    function() { return 0; },                                  // 单一档位：决策看板不分层
    topicOf,
    null,                                                      // 组内顺序在此不关心，下面按龙头重排
    function(i) { return !!list[i].isYizi; },
    function(i) { return list[i].countable !== false; }
  );

  const blocks = [];
  let cur = null;
  order.forEach(function(i) {
    const tp = topicOf(i);
    if (!cur || cur.topic !== tp) {
      cur = { topic: tp, count: 0, yiziCount: 0, members: [] };
      blocks.push(cur);
    }
    const countable = list[i].countable !== false;
    cur.members.push({
      name: list[i].name,
      isYizi: !!list[i].isYizi,
      pct: _num(list[i].pct),
      aucPct: _num(list[i].aucPct),
      code: String(list[i].code || '').trim(),
      countable: countable,
      inheritSold: list[i].inheritSold === true
    });
    if (countable) {
      cur.count++;
      if (list[i].isYizi) cur.yiziCount++;
    }
  });

  return blocks
    .filter(function(b) { return b.topic !== OTHER && b.count >= DECISION_MIN_GROUP; })
    .map(function(b, i) { return Object.assign({ rank: i + 1 }, b); });
}

/**
 * 题材内龙头排名（龙一 / 龙二 / …）—— 与早盘竞价龙一徽章同源（computeDragonRankMap）。
 *
 * 候选集口径（2026-09-26 修订）：
 *   · m.pct === null → 缺十日涨幅，排不进龙位（§10：绝不当 0 参与比较）；
 *   · m.inheritSold === true → 「昨日卖标签继承」的复盘行不占龙位（昨天已卖出，今天不再买）；
 *   · ⛔ m.countable === false【不再排除】—— 那是早盘竞价里「灰色名称 + 灰色题材」的行
 *     （不在当日正式列表，但确实是同时期龙头，9/8 大消费龙一国芳集团就是这种行）。
 *     用户 2026-09-26 明确要求这类灰行【也要参与龙位与买点决策】，
 *     只是仍【不计入】题材数量 / 一字数（统计口径与早盘竞价统计条保持一致）。
 *
 * @param {Array<object>} blocks rankDecisionTopics 的返回
 * @returns {Map<string,{rank:number, pct:number, topic:string, groupSize:number}>}
 */
export function rankDragons(blocks) {
  const entries = [];
  const colored = new Set();
  (blocks || []).forEach(function(b) {
    colored.add(b.topic);
    b.members.forEach(function(m) {
      if (m.pct === null) return;
      if (m.inheritSold === true) return;     // 昨日已卖出的复盘行不占龙位
      entries.push({ name: m.name, topic: b.topic, pct: m.pct });
    });
  });
  return computeDragonRankMap(entries, { coloredTopics: colored, minGroupSize: DECISION_MIN_GROUP });
}

/**
 * 题材块 → 可买候选（按龙头名次升序）。三处选票共用这一份候选（§6 单一真相）：
 *   · 竞价一字       → 买不进，剔除；
 *   · inheritSold    → 「昨日卖标签继承」的复盘行，剔除（昨天已卖出）；
 *   · 非龙一 + 20%/30% 涨跌幅板（创业板 / 科创板 / 北交所）→ 剔除，顺延下一位
 *     [GROWTH-BOARD 2026-09-26 用户口径]：9/2 AI应用 3 个一字，按名次取到龙五芒果超媒（创业板），
 *     它在后排且是 20% 板 ⇒ 往下移一位改选龙六（龙版传媒）。
 *     ⛔ 龙一本身是 20% 板也照选（龙一是最强票，不因板块被跳过）。
 *     板块判定复用 limit-up.js#isHighLimitBoard（早盘竞价给这类票画删除线的就是它，§6 不另写正则）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {Array<{name:string, pct:number|null, aucPct:number|null, rank:number|null, code:string}>}
 */
function _buyCandidates(block, dragonMap) {
  if (!block) return [];
  const dragon = dragonMap || new Map();
  return (block.members || [])
    .filter(function(m) { return !m.isYizi && m.inheritSold !== true; })
    .map(function(m) {
      const d = dragon.get(m.name);
      return {
        name: m.name,
        pct: _num(m.pct),
        aucPct: _num(m.aucPct),
        code: m.code || '',
        rank: (d && d.rank) ? d.rank : null
      };
    })
    .filter(function(c) {                                  // [GROWTH-BOARD] 非龙一的 20%/30% 板顺延
      return !(c.rank !== 1 && isHighLimitBoard(c.code));
    })
    .sort(function(a, b) {
      const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
      const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
}

function _toPick(c, position) {
  return {
    name: c.name,
    dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
    dragonRank: c.rank,
    pct: c.pct,
    position: position
  };
}

/**
 * 【① 第 1 名题材 · 竞价一字 ≥ 2 个】重仓选票（2026-09-26 用户口径，替代「按名次取前两只」）
 *
 *   ① 龙一（龙头顺序最靠前的那只非一字）必选，重仓；
 *   ② 第二只不再按名次取龙二，改【按竞价涨幅最高】选（卡位概率大的人气票）；
 *   ③ 若「涨幅最高」那只【不是】名次第二的龙二（= 发生卡位/跳位）：
 *        → 涨幅最高那只【重仓】 + 【龙二】【轻仓】 ⇒ 一共选【3 只】；
 *      否则（涨幅最高的就是龙二）⇒ 维持原来的 2 只（都重仓）。
 *      例（9/1 农业 2 个一字）：龙二金健米业 +0.1%、龙三万向德农 +7.3%
 *        → 选 龙一（重仓）+ 万向德农（重仓）+ 金健米业（轻仓）＝ 3 只。
 *   §10：缺竞价涨幅的票不参与「涨幅最高」的竞争（≠ 0，也不等于最高）；全都缺 → 退回按名次取。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @returns {{picks:Array, notes:string[], jumped:boolean}}
 */
export function pickHeavyTwo(block, dragonMap) {
  const cands = _buyCandidates(block, dragonMap);
  const notes = [];
  if (cands.length === 0) return { picks: [], notes: notes, jumped: false };

  const head = cands[0];
  const rest = cands.slice(1);
  // 名次第二的那只（无论涨幅）
  const second = rest.length > 0 ? rest[0] : null;
  // 涨幅最高的那只（缺涨幅不参与；全部缺 → 退回名次第二）
  const withAuc = rest.filter(function(c) { return c.aucPct !== null; });
  const best = withAuc.length > 0
    ? withAuc.slice().sort(function(a, b) {
      if (b.aucPct !== a.aucPct) return b.aucPct - a.aucPct;
      const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
      const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    })[0]
    : second;

  const picks = [_toPick(head, POSITION_HEAVY)];
  let jumped = false;
  if (best) {
    picks.push(_toPick(best, POSITION_HEAVY));
    if (second && best.name !== second.name) {
      jumped = true;
      picks.push(_toPick(second, POSITION_LIGHT));
      notes.push('第二只按【竞价涨幅最高】选（' + best.name + ' ' + best.aucPct + '% ＞ ' +
        second.name + ' ' + second.aucPct + '%）→ 比名次第二的票更强（卡位概率大），' +
        best.name + POSITION_HEAVY + '、' + second.name + POSITION_LIGHT + '（共 3 只）');
    }
  }
  if (withAuc.length === 0 && rest.length > 0) {
    notes.push('其余票都缺竞价涨幅 → 第二只按【龙头名次】取（§10 不猜涨幅）');
  }
  return { picks: _reseq(picks), notes: notes, jumped: jumped };
}

/**
 * 在一个题材块里挑「能买的」：按龙头排名升序，跳过【竞价一字】（一字买不进），取前 maxCount 只。
 * @returns {Array<{seq:number, name:string, dragonLabel:string, dragonRank:number|null,
 *                  pct:number|null, position:string}>}
 */
export function pickBuyable(block, dragonMap, maxCount, position) {
  const candidates = _buyCandidates(block, dragonMap).slice(0, maxCount || 1);
  return _reseq(candidates.map(function(c) { return _toPick(c, position); }));
}

/**
 * 【第 2 名题材 · 取「排名最靠前的那只竞价高开」】
 *
 * 口径（2026-09-26 用户）：第 2 名题材不再「按龙头顺序取第一名」（那样会选到低开的票，
 *   实测 9/24 大消费 9 只里按名次取到了奥康国际（龙二、低开）），改为 ——
 *   【按龙头顺序跳过一字，取排名最靠前的那只「竞价高开」的股票，只选 1 只，轻仓】。
 *   例：龙一~龙八都低开、只有龙九高开 → 选龙九；
 *       龙一~龙三低开、龙四高开、龙八也高开 → 选龙四（名次更靠前的那个）。
 *
 * 判据与早盘竞价「龙标红色 = 竞价涨幅 > 0」同源（aucPct > 0），不另写阈值（§6）；
 * §10：竞价涨幅缺失 ≠ 高开，单独记 unknownCount 如实报出来，不静默丢掉。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number, highOpenCount:number}}
 */
export function pickFirstHighOpen(block, dragonMap, position) {
  if (!block) return { picks: [], unknownCount: 0, highOpenCount: 0 };
  const dragon = dragonMap || new Map();
  const cand = [];
  let unknownCount = 0;

  (block.members || []).forEach(function(m) {
    if (m.inheritSold === true) return;                      // 昨日已卖出的复盘行不占龙位，也不选它
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                               // 没有十日涨幅 → 排不进龙头顺序
    if (m.isYizi) return;                                    // 一字买不进
    const auc = _num(m.aucPct);
    if (auc === null) { unknownCount++; return; }            // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (auc <= 0) return;                                    // 只要高开
    cand.push({ name: m.name, pct: _num(m.pct), rank: rank });
  });

  cand.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;           // 龙头名次最靠前的优先
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return {
    picks: _reseq(cand.slice(0, PICK_COUNT_LIGHT).map(function(c) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: position
      };
    })),
    unknownCount: unknownCount,
    highOpenCount: cand.length
  };
}

/**
 * 【第 2 名题材 · 选票总入口】（2026-09-26 用户口径，两条规则有先后）
 *
 *   ①【优先】龙一【不是】竞价一字（一字买不进，所以才看龙一）→ 【直接买龙一】，
 *      不看竞价涨跌幅（高开 / 低开 / 平开都买）。
 *   ② 龙一【是】竞价一字（或题材里根本没有可判定的龙一）→ 退回【pickFirstHighOpen】：
 *      按龙头顺序跳过一字，取【名次最靠前的那只竞价高开】的股票 1 只。
 *      例：龙一是字 → 龙一~龙三低开、龙四高开、龙八也高开 → 选龙四（名次优先，不是涨幅优先）。
 *
 * ⛔ 两条规则只覆盖【第 2 名题材】，① / ② / ③（第 1 名题材）不受影响（用户只对第 2 名提了这条）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number, highOpenCount:number,
 *            viaDragonOne:boolean, dragonOneYizi:boolean}}
 */
export function pickSecondTopicBuy(block, dragonMap, position) {
  if (!block) {
    return { picks: [], unknownCount: 0, highOpenCount: 0, viaDragonOne: false, dragonOneYizi: false };
  }
  const dragon = dragonMap || new Map();

  // 龙一 = 本题材块里龙头名次为 1、且是【计入统计】的成员（灰行不占龙位，也不选它）
  const dragonOne = (block.members || []).find(function(m) {
    if (m.inheritSold === true) return false;
    const d = dragon.get(m.name);
    return !!d && d.rank === 1;
  }) || null;

  // ① 龙一存在 且 不是一字 → 直接买龙一（不看竞价涨跌幅）
  if (dragonOne && !dragonOne.isYizi) {
    return {
      picks: _reseq([{
        name: dragonOne.name,
        dragonLabel: getDragonLabel(1),
        dragonRank: 1,
        pct: _num(dragonOne.pct),
        position: position
      }]),
      unknownCount: 0,
      highOpenCount: 0,
      viaDragonOne: true,
      dragonOneYizi: false
    };
  }

  // ② 龙一买不进（是一字）或排不出龙一 → 老规则：名次最靠前的那只高开票
  const r = pickFirstHighOpen(block, dragonMap, position);
  r.viaDragonOne = false;
  r.dragonOneYizi = !!dragonOne;                 // true = 龙一是字才走的回退；false = 根本没有龙一
  return r;
}

/**
 * 【龙二～龙五补票】第 1 名题材只有 1 个竞价一字时的【轻仓】候选。
 *
 * 口径（2026-09-24 用户）：”看龙二到龙五，除了竞价一字买不到外，买竞价涨幅大于 0 的
 * （早盘竞价看板的龙标是红色的龙二到龙五的股票）”。
 * 所谓「龙标是红色」= 早盘竞价 AuctionDragonBadge 的底色口径：竞价涨幅 > 0 → 红。
 * 因此这里的判据就是 aucPct > 0，与那枚徽章同源，不再另写一个阈值（§6）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {Set<string>} excludeNames 已被重仓挑走的股票（避免同一只既重仓又轻仓）
 * @param {string} position 仓位文案
 * @returns {{picks:Array, unknownCount:number}} unknownCount = 因【缺竞价涨幅】而无法判定的只数
 *          （§10：它们不是「不高开」，如实报出来，不静默丢掉）
 */
export function pickLadder(block, dragonMap, excludeNames, position) {
  if (!block) return { picks: [], unknownCount: 0 };
  const dragon = dragonMap || new Map();
  const exclude = excludeNames || new Set();
  const hit = [];
  let unknownCount = 0;

  block.members.forEach(function(m) {
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                                            // 没有十日涨幅 → 排不进龙二~龙五
    if (rank < LADDER_MIN_RANK || rank > LADDER_MAX_RANK) return;         // 只看龙二到龙五
    if (exclude.has(m.name)) return;
    if (m.isYizi) return;                                                 // 一字买不进
    if (m.aucPct === null || !isFinite(m.aucPct)) { unknownCount++; return; } // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (m.aucPct <= 0) return;                                            // 只要高开
    hit.push({ name: m.name, pct: m.pct, rank: rank });
  });

  hit.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return {
    picks: _reseq(hit.map(function(c) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: position
      };
    })),
    unknownCount: unknownCount
  };
}

/**
 * 【高风险小题材判定 · 2026-09-25 用户口径】
 * 题材【股票数量 ≤ SMALL_TOPIC_MAX_COUNT 只】且【竞价一字 1~2 个】⇒ 疑似量化假强度，
 * 常规规则（按一字多少排题材、再买龙一/龙二）准确率很低 → 改用⑥的兜底规则。
 *
 * @param {object} block rankDecisionTopics 的题材块（rank 1 / 2 的那两个）
 * @returns {boolean}
 */
export function isSmallRiskyTopic(block) {
  if (!block) return false;
  const c = Number(block.count) || 0;
  const y = Number(block.yiziCount) || 0;
  return c > 0 && c <= SMALL_TOPIC_MAX_COUNT && y >= SMALL_TOPIC_MIN_YIZI && y <= SMALL_TOPIC_MAX_YIZI;
}

/**
 * 【⑥ 兜底 · 龙一～龙五里挑「竞价高开」的两只】
 *
 * 口径（2026-09-25 用户，两次口径合并）：题材股票数量最多的那个题材，在【龙一到龙五】里
 * 只挑【竞价高开】（竞价涨幅 > 0）的票，分两种情形：
 *
 *   ① 龙一【高开】→ 龙一占一个名额并【重仓】，另一个名额给【其余高开票里竞价涨幅最高】的那只【轻仓】。
 *      例：龙一 +1%、龙二 −2%、龙三 +3.6%、龙四 0%、龙五 +6.5%
 *          → 高开的 = 龙一 / 龙三 / 龙五 → 取 龙一（重仓）+ 龙五（涨幅最高，轻仓）。
 *
 *   ② 龙一【低开 / 平开 / 缺竞价涨幅】→ 【舍弃龙一】，只在【龙二 ~ 龙五】的高开票里选，
 *      有两只以上高开时只取【竞价涨幅最高的两只】，【两只都轻仓】（龙一走弱就不再重仓）。
 *      例：龙一 −6%、龙二 −2%、龙三 +3.6%、龙四 0%、龙五 +6.5%
 *          → 高开的 = 龙三 / 龙五 → 取 龙五、龙三，都轻仓。
 *
 * 排序规则刻意固定为「竞价涨幅降序 → 龙头名次 → 股票名」，保证结果稳定可复现（不随机）。
 *
 * @param {object} block 题材块
 * @param {Map} dragonMap 龙头排名
 * @param {number} maxRank 只看龙一 ~ 第 maxRank 名
 * @param {number} maxCount 取几只（龙一高开时第 1 只重仓、其余轻仓；龙一不高开时【全部轻仓】）
 * @returns {{picks:Array, unknownCount:number, dragonOneHighOpen:boolean}}
 */
export function pickTopDragonsByAuc(block, dragonMap, maxRank, maxCount) {
  if (!block) return { picks: [], unknownCount: 0, dragonOneHighOpen: false };
  const dragon = dragonMap || new Map();
  const top = maxRank || SMALL_TOPIC_MAX_RANK;
  const hit = [];
  let unknownCount = 0;
  let dragonOneHighOpen = false;

  (block.members || []).forEach(function(m) {
    if (m.inheritSold === true) return;                      // 昨日已卖出的复盘行不占龙位，也不选它
    const d = dragon.get(m.name);
    const rank = d ? d.rank : null;
    if (rank === null) return;                               // 没有十日涨幅 → 排不进龙一~龙五
    if (rank < 1 || rank > top) return;
    if (m.isYizi) return;                                    // 一字买不进
    const auc = _num(m.aucPct);
    if (auc === null) { unknownCount++; return; }            // §10 缺竞价涨幅 ≠ 高开，也不等于不高开
    if (auc <= 0) return;                                    // 只要高开
    if (rank === 1) dragonOneHighOpen = true;
    hit.push({ name: m.name, pct: _num(m.pct), rank: rank, auc: auc });
  });

  hit.sort(function(a, b) {
    if (b.auc !== a.auc) return b.auc - a.auc;               // 先按【竞价涨幅】降序
    if (a.rank !== b.rank) return a.rank - b.rank;           // 同涨幅 → 龙头名次靠前的优先
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); // 仍相同 → 股票名，保证稳定
  });

  const limit = maxCount || SMALL_TOPIC_PICK_COUNT;
  // ① 龙一高开 → 龙一固定占第一个名额（重仓）+ 其余里涨幅最高的一只（轻仓）
  // ② 龙一不高开 → 舍弃龙一，只取【龙二~龙五】里涨幅最高的 maxCount 只，全部轻仓
  const dragonOne = hit.find(function(c) { return c.rank === 1; }) || null;
  const chosen = dragonOne
    ? [dragonOne].concat(hit.filter(function(c) { return c.rank !== 1; }).slice(0, limit - 1))
    : hit.slice(0, limit);

  return {
    picks: _reseq(chosen.map(function(c, i) {
      return {
        name: c.name,
        dragonLabel: getDragonLabel(c.rank),
        dragonRank: c.rank,
        pct: c.pct,
        position: (dragonOne && i === 0) ? POSITION_HEAVY : POSITION_LIGHT
      };
    })),
    unknownCount: unknownCount,
    dragonOneHighOpen: dragonOneHighOpen
  };
}

/** 重排序号（龙一在最前，序号从 1 连续；合并「重仓 + 轻仓」后必须重排，否则序号会重复） */
function _reseq(picks) {
  return picks.map(function(p, i) { p.seq = i + 1; return p; });
}

function _reasonBuy(block, rankWord) {
  if (!block) return '';
  return '题材排' + rankWord + '，股票数量' + block.count + '只，' + block.yiziCount + '个竞价一字';
}

/**
 * 第 1 名题材按【竞价一字数量】分三档给方案（唯一实现；后期改门槛只改这里）。
 *  ⛔ 重仓 / 轻仓混在同一个题材块里（picks 按龙头顺序排列），序号连续：
 *     用户要的格式是「序号｜名称（龙几）｜十日涨幅｜重仓/轻仓」，重仓轻仓在【行尾】区分，
 *     ⛔ 不再写「建议」二字（2026-09-24 用户要求：行尾直接就是结论）。
 *     没必要把同一题材拆成两个块、重复渲染一遍题材名和数据（不省空间反占空间）。
 * @param {object} first 【第 1 名】题材块（调用方保证非空）
 * @returns {{mode:string, qualified:boolean, picks:Array, notes:string[]}}
 */
function _buildFirstBlock(first, dragonMap) {
  const base = {
    block: first,
    rankWord: '第一',
    reason: _reasonBuy(first, '第一'),
    mode: 'none',
    qualified: false,
    notQualifiedText: '',
    picks: [],
    notes: []
  };
  const yz = first.yiziCount;
  if (yz >= MIN_YIZI_HEAVY) {
    // [HEAVY-TWO 2026-09-26] 不再是「按名次取前两只」：
    //   龙一必选重仓 + 第二只按【竞价涨幅最高】选；涨幅最高者不是龙二时再加龙二轻仓（共 3 只）。
    base.mode = 'double';
    base.qualified = true;
    const r = pickHeavyTwo(first, dragonMap);
    base.picks = r.picks;
    base.notes = base.notes.concat(r.notes);
    return base;
  }
  if (yz >= MIN_YIZI_SINGLE) {
    base.mode = 'single';
    base.qualified = true;
    // 重仓：龙头顺序里跳过一字取最靠前的 1 只（正常情况下就是龙一；龙一是一字时自动落到下一只）
    const head = pickBuyable(first, dragonMap, PICK_COUNT_SINGLE, POSITION_HEAVY);
    const exclude = new Set(head.map(function(p) { return p.name; }));
    const lad = pickLadder(first, dragonMap, exclude, POSITION_LIGHT);
    base.picks = _reseq(head.concat(lad.picks).sort(function(a, b) {
      const ra = (a.dragonRank === null ? Number.MAX_SAFE_INTEGER : a.dragonRank);
      const rb = (b.dragonRank === null ? Number.MAX_SAFE_INTEGER : b.dragonRank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }));
    if (lad.picks.length === 0) {
      base.notes.push('龙二到龙五中没有「非一字 且 竞价涨幅>0」的股票，本档无轻仓票');
    }
    if (lad.unknownCount > 0) {
      base.notes.push('另有 ' + lad.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）');
    }
    return base;
  }

  // ⚠️ 正常走不到这里：题材排名是按【一字数】排的（topic-sort#sortByTopicGroups），
  //    所以「第 1 名题材一字 = 0」必然意味着【全部题材】都是 0 —— 那种日子 buildBuyPlan
  //    已经先拦下来改走 ⑤（弱市兜底）了。留着它是为了以后有人改了排序口径却没同步改规则：
  //    宁可显示「未达买入条件」，也绝不给出来路不明的建议。
  base.mode = 'none';
  base.qualified = false;
  base.notQualifiedText = '该题材竞价一字为 0 个，未达买入条件';
  return base;
}

/** 开平文案；缺竞价涨幅（null）单列一类（§10：缺数据 ≠ 平开，不能混进「低开」） */
function _openWord(aucPct) {
  const kind = getAucOpenKind(aucPct);
  return kind ? getAucOpenText(kind) : '缺竞价涨幅';
}

/** 是否【竞价高开】：只有明确 > 0 才算；null（缺数据）不算（§10） */
function _isHighOpen(aucPct) {
  const n = _num(aucPct);
  return n !== null && n > 0;
}

/**
 * 【龙头候选排序 · 2026-09-25】把一组行整理成「龙一 / 龙二 / …」有序候选（纯函数，本文件私有）。
 *
 * 排序依据的优先级（与早盘竞价龙标同一份排名，§6 单一真相）：
 *   ① dragonMap 里的 rank（= computeDragonRankMap 的结果，早盘竞价行上那枚「龙一/龙二」徽章）；
 *   ② 没有 rank 的（少数未进早盘竞价题材组的行）按【十日涨幅】降序排在有 rank 的后面；
 *   ③ 仍相同 → 股票名，保证每次结果完全一致（不随机）。
 *
 * 剔除口径（与「题材数量 / 一字数」的计数口径同源）：
 *   · 竞价一字 → 买不进，不占龙位；
 *   · inheritSold === true → 「昨日卖标签继承」的复盘行不占龙位（灰行本身照常参与，见上）；
 *   · 十日涨幅缺失 → §10：绝不当 0 参与比较，直接排不进龙位。
 *
 * @param {Array<{name:string, pct:number|null, aucPct:number|null, isYiZi?:boolean,
 *                countable?:boolean}>} rows
 * @param {Map<string,{rank:number}>} dragon
 * @returns {Array<{name:string, rank:number, pct:number|null, aucPct:number|null}>}
 */
function _rankCandidates(rows, dragon) {
  const out = [];
  (rows || []).forEach(function(r) {
    if (!r || !r.name || r.isYiZi) return;                 // 一字买不进 → 不占龙位
    if (r.inheritSold === true) return;                    // 昨日已卖出的复盘行不占龙位
    const pct = _num(r.pct);
    if (pct === null) return;                              // §10：缺十日涨幅 → 排不进龙位
    const d = dragon.get(r.name);
    out.push({
      name: r.name,
      rank: (d && d.rank) ? d.rank : null,
      pct: pct,
      aucPct: _num(r.aucPct)
    });
  });
  out.sort(function(a, b) {
    const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
    const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
    if (ra !== rb) return ra - rb;
    if (a.pct !== b.pct) return b.pct - a.pct;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out.map(function(c, i) {
    return { name: c.name, rank: c.rank || (i + 1), pct: c.pct, aucPct: c.aucPct };
  });
}

/**
 * 按题材名在【早盘竞价题材块】里找同名块。
 * §6：龙一 / 龙二的排名人群必须与「早盘竞价龙标」完全一致 —— 题材连扳只负责决定
 * 【选哪个题材】（数量最多），龙头名次本身仍归早盘竞价口径（否则同一题材会出现两套龙一）。
 * @param {Array<object>} blocks rankDecisionTopics 的返回
 * @param {string} topic
 * @returns {object|null}
 */
function _findAuctionBlock(blocks, topic) {
  const key = String(topic || '').trim();
  if (!key || !blocks || blocks.length === 0) return null;
  for (let i = 0; i < blocks.length; i++) {
    if (String(blocks[i].topic || '').trim() === key) return blocks[i];
  }
  return null;
}

/**
 * 【无一字兜底买点 · 2026-09-25 用户口径】
 *
 * 触发条件（由 buildBuyPlan 判定）：当日【所有题材】的竞价一字都是 0 个 = 弱市。
 * 选票口径：
 *   ① 看【连板天梯 · 题材连扳】（ladder-rules#groupByTopicLadder 的同一份分组，§6 单一真相）；
 *   ② 取【股票数量最多】的题材 —— 数量并列时【并列的题材全都取】（用户举例：AI应用也是 3 只）；
 *   ③ 每个入选题材只看最靠前的两只（龙一 / 龙二），龙一 / 龙二 = 题材内【十日涨幅】排名
 *      （与早盘竞价龙一徽章同一口径 computeDragonRankMap）；
 *      ⚠️ 排名人群是【该题材在早盘竞价里的全量成员】（opts.auctionTopicBlocks），
 *         ⛔ 不是「题材连扳」那几只连板票的子集 —— 后者只是用来决定选哪个题材。
 *         旧实现拿子集 ∩ 全量排名 ⇒ 题材真龙一（当天没连板）被跳过、名次整体前移
 *         （2026-09-25 事故：9/16 电子/通信/算力 龙一被判成澳弘电子而非超声电子）；
 *   ④ 最终只留【竞价高开】的票：
 *        龙一低开 + 龙二高开 → 只买龙二；
 *        两只都高开           → 两只都买；
 *        两只都低开           → 只买龙一；
 *      ⚠️ 竞价涨幅缺失不算高开，会单独说明（§10 不猜）；
 *   ⑤ 全部记【轻仓】（没有一字，强度打折）；
 *   ⑥ 股票最多的题材【不足 NO_YIZI_MIN_TOPIC_COUNT 只】→ 【空仓】（太弱，不参与）。
 *
 * @param {Array<{topic:string, count:number,
 *                rows:Array<{name:string, pct:number|null, aucPct:number|null, isYiZi:boolean}>}>} topicGroups
 *        连板天梯「题材连扳」的分组（⛔ 直接由 ladder-collect 采集，与天梯看板显示完全一致）
 * @param {{dragonMap?:Map, ladderReady?:boolean, ladderReason?:string,
 *          auctionTopicBlocks?:Array}} [opts]
 *        ladderReady=false 表示连板数据没加载（§10：如实报「未就绪」，绝不退化成「今天没有连板股」）
 *        auctionTopicBlocks = 早盘竞价的题材块（rankDecisionTopics 的返回）—— 龙一 / 龙二的
 *        【排名人群】，⛔ 不传就只能退回「题材连扳」子集自排（会与早盘竞价龙标分叉）
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildNoYiziPlan(topicGroups, opts) {
  const o = opts || {};
  const dragon = o.dragonMap || new Map();

  const out = {
    mode: 'noYizi',
    qualified: false,
    emptyText: '',
    hintText: '当日全部题材【竞价一字 0 个】→ 改看连板天梯「题材连扳」：' +
      '取股票数量最多的题材的龙一 / 龙二，只留竞价高开的票，全部' + POSITION_LIGHT,
    blocks: [],
    notes: []
  };

  // §10：连板数据没加载 = 「还没拉到」，绝不等于「今天没有连板梯队」
  if (o.ladderReady === false) {
    out.emptyText = '连板天梯数据未就绪' + (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      '，无法按「无一字」规则选票';
    return out;
  }

  const groups = (topicGroups || []).filter(function(g) {
    return g && g.topic && g.topic !== OTHER && (Number(g.count) || 0) > 0;
  });
  if (groups.length === 0) {
    out.emptyText = '连板天梯「题材连扳」当日没有可用题材，无法按「无一字」规则选票 → 【空仓】';
    return out;
  }

  // ① 股票数量最多的那个数量（并列取全部）
  let maxCount = 0;
  groups.forEach(function(g) {
    const c = Number(g.count) || 0;
    if (c > maxCount) maxCount = c;
  });
  // ⑥ 太弱 → 空仓（用户口径：最多只有 2 只就不参与）
  if (maxCount < NO_YIZI_MIN_TOPIC_COUNT) {
    out.emptyText = '题材连扳里股票最多的题材【只有 ' + maxCount + ' 只】（不足 ' +
      NO_YIZI_MIN_TOPIC_COUNT + ' 只），强度太弱 → 【空仓】';
    return out;
  }

  const winners = groups.filter(function(g) { return (Number(g.count) || 0) === maxCount; });
  if (winners.length > 1) {
    out.notes.push('有 ' + winners.length + ' 个题材并列最多（' +
      winners.map(function(g) { return g.topic; }).join('、') + '），每个都按同一规则选票');
  }

  let totalPicks = 0;
  winners.forEach(function(g) {
    // ② 龙一 / 龙二 = 该题材【在早盘竞价口径下】的龙头前两名（与早盘竞价龙标同一份排名）。
    //    题材连扳只用来决定「选哪个题材」，不用来决定名次。找不到同名题材块才退回组内自排（§10 不猜）。
    const blk = _findAuctionBlock(o.auctionTopicBlocks, g.topic);
    const cand = _rankCandidates(blk ? blk.members : (g.rows || []), dragon);
    const top = cand.slice(0, NO_YIZI_PICK_COUNT);
    const d1 = top[0] || null;
    const d2 = top[1] || null;

    const notes = [];
    let picks = [];
    let unknownCount = 0;
    if (!blk) {
      notes.push('该题材在早盘竞价题材分组里没有同名题材 → 龙一 / 龙二 暂按「题材连扳」成员排名（§10 不猜）');
    }
    if (d1 && d1.aucPct === null) unknownCount++;
    if (d2 && d2.aucPct === null) unknownCount++;

    if (!d1) {
      notes.push('该题材在连板梯队里没有能排进龙一 / 龙二的股票（缺十日涨幅 或 全是一字）→ 不选票（§10 不猜）');
    } else {
      const h1 = _isHighOpen(d1.aucPct);
      const h2 = _isHighOpen(d2 ? d2.aucPct : null);
      if (h1 && h2) {
        picks = [d1, d2];
        notes.push('龙一、龙二【都是竞价高开】→ 两只都买');
      } else if (h1) {
        picks = [d1];
        notes.push('龙一【竞价高开】' + (d2 ? ('，龙二' + _openWord(d2.aucPct)) : '，无龙二') + ' → 只买龙一');
      } else if (h2) {
        picks = [d2];
        notes.push('龙一' + _openWord(d1.aucPct) + '，龙二【竞价高开】→ 只买高开的龙二');
      } else {
        picks = [d1];
        notes.push('龙一 / 龙二【都不是竞价高开】（' + _openWord(d1.aucPct) +
          (d2 ? ('、' + _openWord(d2.aucPct)) : '、无龙二') + '）→ 按规则只买龙一');
      }
    }
    if (unknownCount > 0) {
      notes.push('另有 ' + unknownCount + ' 只缺竞价涨幅，无法判定是否高开（§10 不猜）');
    }

    totalPicks += picks.length;
    out.blocks.push({
      // 复用买点块的数据结构，让 UI 直接复用 DecisionBuyBlock（⛔ 不另写一套渲染）
      block: { topic: g.topic, rank: null, count: Number(g.count) || 0, yiziCount: 0 },
      rankWord: '',
      reason: '全部题材竞价一字 0 个；该题材在连板天梯「题材连扳」里股票数量最多（' +
        (Number(g.count) || 0) + ' 只），只买龙一 / 龙二中【竞价高开】的票',
      mode: 'noYizi',
      qualified: true,
      notQualifiedText: '',
      picks: _reseq(picks.map(function(c) {
        return {
          name: c.name,
          dragonLabel: getDragonLabel(c.rank),
          dragonRank: c.rank,
          pct: c.pct,
          position: POSITION_LIGHT
        };
      })),
      notes: notes
    });
  });

  out.qualified = totalPicks > 0;
  if (!out.qualified) {
    out.emptyText = '股票数量最多的题材里没有可买的龙一 / 龙二 → 【空仓】';
  }
  return out;
}

/**
 * 【⑥ 高风险小题材兜底 · 2026-09-25 用户口径】
 *
 * 触发条件（由 buildBuyPlan 判定）：早盘竞价题材 toggle 下，排名【第 1 或第 2】的题材
 * 【股票数量 ≤ SMALL_TOPIC_MAX_COUNT 只】且【竞价一字 1~2 个】—— 票太少却被一字撑起排名，
 * 多半是量化做出来的假强度，常规规则（按一字多少选题材 → 买龙一 / 龙二）准确率很低
 * ⇒ 【不用常规规则】，改按下面这套来选：
 *
 *   ① 取【连板天梯 · 题材连扳】的题材分组（ladder-collect 同一份 0 请求结果，§6）；
 *   ② 每个候选题材再看它在【早盘竞价】里的股票总数，
 *      < SMALL_TOPIC_MIN_AUCTION_COUNT 只的【排除】（用户举例：AI应用早盘竞价只有 3 只 → 排除）；
 *   ③ 剩下的题材按【早盘竞价股票总数】降序取前 2 个
 *      （用户举例：电子/通信/算力 10 只 → 第一；电力新能源 4 只 → 第二）；
 *   ④ 第 1 个题材（数量最多）：在【龙一 ~ 龙五】里挑【竞价高开】的两只 ——
 *      龙一【重仓】，另一只给【竞价涨幅最高】的那只【轻仓】（一字买不进，自动跳过）；
 *   ⑤ 第 2 个题材：只取【龙一】，【轻仓】（一字买不进时顺延到下一只）；
 *   ⑥ 一个题材都筛不出来 → 【空仓】并如实说明（§10）。
 *
 * @param {Array<object>} auctionBlocks 早盘竞价题材块（rankDecisionTopics 的返回）
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string,
 *          riskyTopics?:Array}} [opts]
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildSmallTopicPlan(auctionBlocks, dragonMap, opts) {
  const o = opts || {};
  const dragon = dragonMap || new Map();

  const out = {
    mode: 'smallTopic',
    qualified: false,
    emptyText: '',
    hintText: '题材股票数量过少（≤ ' + SMALL_TOPIC_MAX_COUNT + ' 只）却有 1~2 个竞价一字（疑似量化）→ ' +
      '不按常规规则选票，改看连板天梯「题材连扳」：只保留早盘竞价里股票数 ≥ ' +
      SMALL_TOPIC_MIN_AUCTION_COUNT + ' 只的题材，按股票数量取前二。',
    blocks: [],
    notes: []
  };

  const risky = o.riskyTopics || [];
  if (risky.length > 0) {
    out.notes.push('常规规则已跳过：' + risky.map(function(b) {
      return b.topic + '（' + b.count + '只 / ' + b.yiziCount + '个一字）';
    }).join('、') + ' —— 股票太少且有 1~2 个一字，疑似量化，准确率低');
  }

  // §10：连板数据没加载 = 「还没拉到」，绝不等于「今天没有连板梯队」
  if (o.ladderReady === false) {
    out.emptyText = '连板天梯数据未就绪' + (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      '，无法按「小题材 + 一字」规则选票';
    return out;
  }

  // ① + ② 题材连扳候选 → 用早盘竞价股票总数过滤（< 4 只排除）
  const cands = [];
  (o.ladderTopicGroups || []).forEach(function(g) {
    if (!g || !g.topic || g.topic === OTHER) return;
    const blk = _findAuctionBlock(auctionBlocks, g.topic);
    if (!blk) return;
    const n = Number(blk.count) || 0;
    if (n < SMALL_TOPIC_MIN_AUCTION_COUNT) return;
    cands.push({ topic: g.topic, auctionCount: n, ladderCount: Number(g.count) || 0, block: blk });
  });
  if (cands.length === 0) {
    out.emptyText = '连板天梯「题材连扳」里没有「早盘竞价股票数 ≥ ' + SMALL_TOPIC_MIN_AUCTION_COUNT +
      ' 只」的题材，无法按「小题材 + 一字」规则选票 → 【空仓】';
    return out;
  }

  // ③ 按早盘竞价股票总数降序（同数 → 题材连扳数量降序 → 题材名），取前二
  cands.sort(function(a, b) {
    if (b.auctionCount !== a.auctionCount) return b.auctionCount - a.auctionCount;
    if (b.ladderCount !== a.ladderCount) return b.ladderCount - a.ladderCount;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });
  const winners = cands.slice(0, 2);
  if (winners.length > 1) {
    out.notes.push('题材连扳里按【早盘竞价股票数】排序：' + cands.map(function(c) {
      return c.topic + ' ' + c.auctionCount + '只';
    }).join('、'));
  }

  let totalPicks = 0;
  winners.forEach(function(w, idx) {
    const notes = [];
    let picks = [];
    if (idx === 0) {
      // ④ 数量最多的题材：龙一~龙五 里挑竞价高开的两只（龙一重仓 + 涨幅最高的一只轻仓）
      const r = pickTopDragonsByAuc(w.block, dragon, SMALL_TOPIC_MAX_RANK, SMALL_TOPIC_PICK_COUNT);
      picks = r.picks;
      if (picks.length === 0) {
        notes.push('龙一~龙五里没有「非一字 且 竞价高开」的股票 → 本题材不选票');
      } else if (!r.dragonOneHighOpen) {
        notes.push('龙一未高开 → 【舍弃龙一】，只在龙二~龙五里按竞价涨幅取最高的 ' +
          picks.length + ' 只，都' + POSITION_LIGHT);
      }
      if (r.unknownCount > 0) {
        notes.push('另有 ' + r.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）');
      }
    } else {
      // ⑤ 数量第二的题材：只取龙一，轻仓（一字买不进时由 pickBuyable 自动顺延）
      picks = pickBuyable(w.block, dragon, 1, POSITION_LIGHT);
      if (picks.length === 0) {
        notes.push('该题材没有可买的非一字股票 → 不选票');
      }
    }

    totalPicks += picks.length;
    out.blocks.push({
      block: { topic: w.topic, rank: null, count: w.auctionCount, yiziCount: w.block.yiziCount || 0 },
      rankWord: '',
      reason: idx === 0
        ? ('该题材在早盘竞价中股票数量最多（' + w.auctionCount + ' 只）→ 在龙一~龙五里取竞价高开的两只：' +
           '龙一高开则龙一' + POSITION_HEAVY + ' + 竞价涨幅最高的一只' + POSITION_LIGHT +
           '；龙一不高开则舍弃龙一，取龙二~龙五里涨幅最高的两只，都' + POSITION_LIGHT)
        : ('该题材在早盘竞价中股票数量第二（' + w.auctionCount + ' 只）→ 只取龙一，' + POSITION_LIGHT),
      mode: 'smallTopic',
      qualified: picks.length > 0,
      notQualifiedText: '',
      picks: picks,
      notes: notes
    });
  });

  out.qualified = totalPicks > 0;
  if (!out.qualified) {
    out.emptyText = '入选题材里没有可买的票 → 【空仓】';
  }
  return out;
}

/**
 * 【④ 低开龙一 · 文字提醒（2026-09-26 用户口径）】
 *
 * 用户原话：龙一如果【低开】，要自己去观察它的【竞价图形】是不是【跌停 L 形】；
 *   是 L 形就【尾盘买】。（9/3 捷荣技术就是这种情形）
 * ⚠️ 竞价图形本看板拿不到（没有分时数据），所以这里【只加提醒文字】，⛔ 不改任何选票结果与仓位。
 *
 * @param {object} blockObj 买点块（block + picks + notes）
 */
function _appendLowOpenDragonOneNote(blockObj) {
  if (!blockObj || !blockObj.block || !blockObj.picks || blockObj.picks.length === 0) return blockObj;
  const aucOf = new Map();
  (blockObj.block.members || []).forEach(function(m) { aucOf.set(m.name, _num(m.aucPct)); });
  blockObj.picks.forEach(function(p) {
    if (p.dragonRank !== 1) return;
    const auc = aucOf.get(p.name);
    if (auc === null || auc === undefined || auc >= 0) return;
    (blockObj.notes || (blockObj.notes = [])).push(
      '⚠️ 龙一「' + p.name + '」竞价低开（' + auc + '%）→ 请自行看它的竞价图形：' +
      '若出现【跌停 L 形】，改为【尾盘买】（本看板不判断图形，只做提醒）');
  });
  return blockObj;
}

/**
 * 【⑤ 第 2 名题材 · 与「连板天梯数量第一题材」比早盘竞价股票数（2026-09-26 用户口径）】
 *
 * 第 2 名题材（只有 1 个竞价一字）选票前，先做一次【题材替换】：
 *   ① 取【连板天梯 · 题材连扳】里【股票数量最多】的题材；
 *   ② 拿它回【早盘竞价】找同名题材块，比较两者的【早盘竞价股票数量】；
 *   ③ 谁的数量多就选谁；天梯那边更多 → 改成选天梯第一那个题材，仍按原规则选票。
 *      例（9/3）：第 2 名 = 大消费 7 只；天梯第一 = AI应用 4 只 → 回早盘竞价比：
 *      大消费 7 ＜ AI应用 10 ⇒ 改选 AI应用（若 AI应用 更少则沿用原规则）。
 * §10：连板天梯未就绪 → 如实说明「未做对比」，沿用原规则（绝不猜）。
 *
 * @param {Array} blocks 早盘竞价题材块（rankDecisionTopics 的返回）
 * @param {object} second 第 2 名题材块
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string}} opts
 * @returns {{block:object|null, notes:string[], replaced:boolean}}
 */
export function resolveSecondTopicByLadder(blocks, second, opts) {
  const o = opts || {};
  const notes = [];
  if (!second) return { block: null, notes: notes, replaced: false };
  if (o.ladderReady === false) {
    notes.push('连板天梯数据未就绪' + (o.ladderReason ? '（' + o.ladderReason + '）' : '') +
      ' → 未做「题材数量对比」，沿用第 2 名题材（§10 不猜）');
    return { block: second, notes: notes, replaced: false };
  }
  const groups = (o.ladderTopicGroups || []).filter(function(g) {
    return g && g.topic && g.topic !== OTHER && (Number(g.count) || 0) > 0;
  });
  if (groups.length === 0) return { block: second, notes: notes, replaced: false };

  let top = null;
  groups.forEach(function(g) {
    if (!top || (Number(g.count) || 0) > (Number(top.count) || 0)) top = g;
    else if ((Number(g.count) || 0) === (Number(top.count) || 0) &&
             String(g.topic) < String(top.topic)) top = g;      // 并列 → 题材名稳定
  });
  if (!top || String(top.topic).trim() === String(second.topic).trim()) {
    return { block: second, notes: notes, replaced: false };
  }
  const blk = _findAuctionBlock(blocks, top.topic);
  if (!blk) {
    notes.push('连板天梯里数量最多的题材「' + top.topic + '」在早盘竞价里没有同名题材 → 不做替换');
    return { block: second, notes: notes, replaced: false };
  }
  if (blk.count <= second.count) {
    notes.push('已与连板天梯数量最多的题材「' + top.topic + '」对比早盘竞价股票数：' +
      '本题材 ' + second.count + ' 只 ≥ ' + top.topic + ' ' + blk.count + ' 只 → 沿用本题材');
    return { block: second, notes: notes, replaced: false };
  }
  notes.push('连板天梯里数量最多的题材是「' + top.topic + '」（' + top.count + ' 只）；' +
    '回到早盘竞价比股票数：' + top.topic + ' ' + blk.count + ' 只 ＞ 本题材「' + second.topic +
    '」' + second.count + ' 只 → 改选【' + top.topic + '】');
  return { block: blk, notes: notes, replaced: true };
}

/**
 * 【⑥ 无一字 · 大题材兜底（2026-09-26 用户口径）】
 *
 * 触发：当日【全部题材竞价一字 = 0】，且第 1 / 第 2 名题材里有【股票数量 ≥ BIG_TOPIC_MIN_COUNT 只】的。
 * 选票：每个满足的大题材只取【龙一】一只，【轻仓】（没有一字，强度打折）。
 * ⛔ 这是【新增】的一条并列规则：原来的「题材连扳不足 3 只 → 空仓」保持不变，
 *    只是当大题材条件成立时【优先】走这里（9/4：电子/通信/算力 17 只、AI应用 10 只 → 各取龙一）。
 *
 * @param {Array<object>} bigBlocks 满足数量门槛的题材块（第 1 / 第 2 名里筛出来的）
 * @param {Map} dragonMap 龙头排名
 * @returns {{mode:string, qualified:boolean, emptyText:string, hintText:string, blocks:Array, notes:string[]}}
 */
export function buildBigTopicPlan(bigBlocks, dragonMap) {
  const out = {
    mode: 'bigTopic',
    qualified: false,
    emptyText: '',
    hintText: '当日全部题材【竞价一字 0 个】，但第 1 / 第 2 名题材里有【股票数量 ≥ ' +
      BIG_TOPIC_MIN_COUNT + ' 只】的大题材 → 改选这些大题材的【龙一】（' + POSITION_LIGHT + '）',
    blocks: [],
    notes: []
  };
  let totalPicks = 0;
  (bigBlocks || []).forEach(function(b) {
    const picks = pickBuyable(b, dragonMap, 1, POSITION_LIGHT);
    const notes = [];
    if (picks.length === 0) notes.push('该题材没有可买的非一字股票 → 不选票');
    totalPicks += picks.length;
    const obj = {
      block: b,
      rankWord: '',
      reason: '该题材在早盘竞价里有 ' + b.count + ' 只（≥ ' + BIG_TOPIC_MIN_COUNT +
        ' 只），当日无竞价一字 → 只取龙一，' + POSITION_LIGHT,
      mode: 'bigTopic',
      qualified: picks.length > 0,
      notQualifiedText: '',
      picks: picks,
      notes: notes
    };
    _appendLowOpenDragonOneNote(obj);
    out.blocks.push(obj);
  });
  out.qualified = totalPicks > 0;
  if (!out.qualified) out.emptyText = '大题材里没有可买的票 → 【空仓】';
  return out;
}

/**
 * 生成买点计划。
 * @param {Array} blocks rankDecisionTopics 的返回
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string}} [opts]
 *        【无一字兜底】要用的连板天梯「题材连扳」分组（只有「全部题材一字 = 0」时才用得上；
 *        由 decision-collect 采集后传进来，本文件保持纯函数、不碰数据源）
 *        ⓘ 龙一 / 龙二的排名人群用的是 blocks 自身（早盘竞价题材组），无需额外传参
 * @returns {{heavy:object|null, light:object|null, noYizi:object|null, smallTopic:object|null}}
 *          heavy = 第 1 名题材的方案；light = 第 2 名题材的方案；
 *          noYizi = 「全部题材竞价一字 = 0」时的弱市兜底方案；
 *          smallTopic = 「第 1 / 第 2 名题材票太少却有 1~2 个一字」时的兜底方案（⑥）。
 *          四者互斥：noYizi / smallTopic 任一非空时，heavy 与 light 必为 null。
 *          qualified=false 表示「未达一字门槛 / 太弱」——仍然展示题材与数字（§10 如实呈现），
 *          但 ⛔ 不给出买入建议（picks 为空），绝不拿不够格的数据冒充有效信号。
 */
export function buildBuyPlan(blocks, dragonMap, opts) {
  const list = blocks || [];
  const first = list.find(function(b) { return b.rank === 1; }) || null;
  const second = list.find(function(b) { return b.rank === 2; }) || null;
  const o = opts || {};

  // [SMALL-TOPIC 2026-09-25] 第 1 / 第 2 名题材是「票太少 + 有 1~2 个一字」的高风险小题材
  //   ⇒ 常规规则准确率低，【不用常规规则】，改走 ⑥（题材连扳 + 早盘竞价股票数 ≥ 4 只过滤）。
  //   ⛔ 即使连板天梯未就绪也【不退回】常规规则 —— 用户明确说这种情况下常规规则不符合，
  //      退回等于又给一次错误的建议；如实报「未就绪」（§10）。
  const risky = [];
  if (isSmallRiskyTopic(first)) risky.push(first);
  if (isSmallRiskyTopic(second)) risky.push(second);
  if (risky.length > 0) {
    return {
      heavy: null,
      light: null,
      noYizi: null,
      bigTopic: null,
      smallTopic: buildSmallTopicPlan(list, dragonMap, {
        ladderTopicGroups: o.ladderTopicGroups || [],
        ladderReady: o.ladderReady,
        ladderReason: o.ladderReason,
        riskyTopics: risky
      })
    };
  }

  // [NO-YIZI 2026-09-25] 当日【所有题材】都没有竞价一字 → 弱市，改走「连板天梯 · 题材连扳」兜底规则。
  // ⛔ 判据是【全部题材的一字总数】，不是「第 1 名题材的一字数」：
  //    用户原话是「当天所有的题材都没有一字涨停的股票时」。
  const totalYizi = list.reduce(function(n, b) { return n + (Number(b.yiziCount) || 0); }, 0);
  if (list.length > 0 && totalYizi === 0) {
    // [BIG-TOPIC 2026-09-26] 新增的并列规则【优先】：第 1 / 第 2 名题材里有【股票数 ≥ 10 只】的
    //   大题材 → 选这些大题材的龙一（轻仓）。不满足才回到原来的「题材连扳 / 空仓」。
    const bigs = [first, second].filter(function(b) {
      return b && (Number(b.count) || 0) >= BIG_TOPIC_MIN_COUNT;
    });
    if (bigs.length > 0) {
      return {
        heavy: null,
        light: null,
        noYizi: null,
        smallTopic: null,
        bigTopic: buildBigTopicPlan(bigs, dragonMap)
      };
    }
    return {
      heavy: null,
      light: null,
      smallTopic: null,
      bigTopic: null,
      noYizi: buildNoYiziPlan(o.ladderTopicGroups || [], {
        dragonMap: dragonMap,
        ladderReady: o.ladderReady,
        ladderReason: o.ladderReason,
        // 龙一 / 龙二的排名人群 = 早盘竞价题材组（blocks 自身），⛔ 不是「题材连扳」的子集
        auctionTopicBlocks: list
      })
    };
  }

  // 第 2 名题材：[2026-09-26 用户口径] 两条规则有先后 ——
  //   ①【优先】龙一不是竞价一字 → 直接买龙一，不看竞价涨跌幅（一字才买不进，能买就买龙一）；
  //   ② 龙一是一字（或排不出龙一）→ 取【名次最靠前的那只竞价高开】，只 1 只、轻仓。
  //   没有高开票 / 有票缺竞价涨幅都要如实说明（§10）。
  const lightNotes = [];
  let lightPicks = [];
  // ⑤【题材替换（2026-09-26 用户口径）】第 2 名题材【只有 1 个竞价一字】时，
  //   先和「连板天梯 · 题材连扳」里数量最多的题材比【早盘竞价股票数】，谁多就选谁。
  let lightBlock = second;
  let replaced = false;
  if (second && second.yiziCount === 1) {
    const rs = resolveSecondTopicByLadder(list, second, o);
    lightBlock = rs.block || second;
    replaced = rs.replaced;
    rs.notes.forEach(function(n) { lightNotes.push(n); });
  }
  if (lightBlock) {
    const r = pickSecondTopicBuy(lightBlock, dragonMap, POSITION_LIGHT);
    lightPicks = r.picks;
    if (r.viaDragonOne) {
      lightNotes.push('龙一「' + r.picks[0].name + '」不是竞价一字 → 直接买龙一（不看竞价涨跌幅）');
    } else {
      if (r.dragonOneYizi) {
        lightNotes.push('龙一是一字涨停（买不进）→ 跳过一字，取名次最靠前的「竞价高开」票');
      }
      if (r.picks.length === 0) {
        lightNotes.push('该题材没有「非一字 且 竞价高开」的股票 → 本档无轻仓票');
      }
      if (r.unknownCount > 0) {
        lightNotes.push('另有 ' + r.unknownCount + ' 只缺竞价涨幅，无法判定是否高开，未纳入（§10 不猜）');
      }
    }
  }
  const light = lightBlock ? {
    block: lightBlock,
    rankWord: replaced ? '' : '第二',
    // 题材下面的小字说明带上 ④ 的两条先后规则，用户对照看板时能直接看到「为什么选它」
    reason: _reasonBuy(lightBlock, replaced ? '' : '第二') +
      '　→ ④ 龙一不是一字则直接买龙一；龙一是一字则取名次最靠前的竞价高开票（都' + POSITION_LIGHT + '）',
    mode: 'light',
    qualified: true,
    notQualifiedText: '',
    picks: lightPicks,
    notes: lightNotes
  } : null;
  _appendLowOpenDragonOneNote(light);

  const heavy = first ? _buildFirstBlock(first, dragonMap) : null;
  _appendLowOpenDragonOneNote(heavy);

  return {
    // ⛔ first 为空时必须返回 null：UI 用 v-if="buyHeavy" 判空，
    //    返回空壳对象会让模板去读 block.block.topic 直接崩（当日没有成组题材时会走到这里）
    heavy: heavy,
    light: light,
    noYizi: null,
    smallTopic: null,
    bigTopic: null
  };
}

function _yiziWord(n) {
  return n > 0 ? ('有' + n + '个竞价一字涨停') : '无竞价一字涨停';
}

function _rankWord(rank) {
  if (rank === 1) return '第一';
  if (rank === 2) return '第二';
  return rank ? ('第' + rank + '名') : '';
}

/**
 * 卖出时点决策（唯一实现；后期改规则只改这里）。
 *
 * [2026-09-24 用户口径 · 第 2 名题材的例外]
 *   题材【排名第 2】且该题材【只有 1 个竞价一字】⇒ 题材强度打折，只有【龙一】能拿到尾盘：
 *       龙一  → 14:50 卖；
 *       其余非龙一（含今日未排上龙头的）→ 11:20 卖。
 *   ⚠️ 只适用于「第 2 名 + 恰好 1 个一字」这一个组合；其它组合仍走下面的通用规则。
 *
 * @param {number|null} topicRank 今日题材排名（null = 今日未成组）
 * @param {{yiziCount?:number|null, isDragonOne?:boolean}} [opts]
 *        isDragonOne = 该股是不是【今日】这个题材里的龙一（dragonRank === 1）
 * @returns {string} 卖出时点
 */
function _decideSellTime(topicRank, opts) {
  const o = opts || {};
  if (topicRank === 2 && o.yiziCount === MIN_YIZI_SINGLE) {
    return o.isDragonOne ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
  }
  return (topicRank === 1 || topicRank === 2) ? SELL_TIME_CLOSE : SELL_TIME_MIDDAY;
}

/**
 * 生成卖点计划。
 * @param {Array<{name:string, topic:string, pct:number|null, inTodayList:boolean}>} rows
 *        候选 = 昨日打过「买」标签的股票（topic 用【今日】的题材；不在今日列表时 topic 为空）
 * @param {Array} blocks rankDecisionTopics 的返回（用于查今日题材排名 / 数量 / 一字）
 * @param {Map} dragonMap 今日龙头排名（用于显示「龙几」）
 * @param {Set<string>|Map<string,any>|null} prevDragonNames 昨日龙头名册里的股票名（昨日龙一）；
 *        【null = 名册尚未加载】→ 「昨日是不是龙头」是未知（§10），理由里如实写「未加载」，
 *        ⛔ 绝不退化成「非龙头」—— 那会把「还没拉到」伪装成「已经判定过」。
 *        （卖出【时点】只看今日题材排名，不受此项影响，所以名册未加载照样给时点建议。）
 * @returns {Array<{topic:string, topicRank:number|null, count:number|null, yiziCount:number|null,
 *                 卖点行... }>} 按题材分组，组内按龙头排名升序
 */
export function buildSellPlan(rows, blocks, dragonMap, prevDragonNames) {
  if (!rows || rows.length === 0) return [];
  const rankMap = _topicRankMap(blocks || []);
  const infoMap = new Map();
  (blocks || []).forEach(function(b) { infoMap.set(b.topic, b); });
  const dragon = dragonMap || new Map();
  // §10：名册没加载 ⇒ 「昨日是否龙头」未知（null），不是 false
  const prevUnknown = !prevDragonNames;
  const prevSet = prevUnknown
    ? new Set()
    : (prevDragonNames instanceof Set ? prevDragonNames : new Set(Object.keys(prevDragonNames)));

  const groups = new Map();
  rows.forEach(function(r) {
    const tp = String(r.topic || '').trim();
    const key = tp || '（今日未成组）';
    if (!groups.has(key)) groups.set(key, []);
    const rank = rankMap.has(tp) ? rankMap.get(tp) : null;
    const info = infoMap.get(tp);
    const d = dragon.get(r.name);
    const isPrevDragon = prevUnknown ? null : prevSet.has(r.name);
    const dragonRank = d ? d.rank : null;
    // 时点是【逐行】算的：第 2 名 + 只有 1 个一字时，龙一与非龙一时点不同，同一组里会同时出现两种
    const sellAt = _decideSellTime(rank, {
      yiziCount: info ? info.yiziCount : null,
      isDragonOne: dragonRank === 1
    });
    groups.get(key).push({
      name: r.name,
      topic: tp,
      topicRank: rank,
      isPrevDragon: isPrevDragon,
      dragonLabel: dragonRank ? getDragonLabel(dragonRank) : '',
      dragonRank: dragonRank,
      pct: _num(r.pct),
      inTodayList: !!r.inTodayList,
      sellAt: sellAt
    });
  });

  const out = [];
  groups.forEach(function(items, key) {
    const head = items[0];
    const info = infoMap.get(head.topic);
    const count = info ? info.count : null;
    const yizi = info ? info.yiziCount : null;
    const rankWord = _rankWord(head.topicRank);
    const yiziText = (yizi === null) ? '题材今日未成组' : _yiziWord(yizi);
    const countText = (count === null) ? '股票数量未知' : ('股票数量' + count + '只');

    const prevText = (head.isPrevDragon === null)
      ? '昨日龙头名册未加载'
      : (head.isPrevDragon ? '昨日是龙头（十日涨幅最高）' : '昨日非龙头');
    const prevTextElse = (head.isPrevDragon === null)
      ? '昨日龙头名册未加载'
      : (head.isPrevDragon ? '但昨日是龙头（十日涨幅最高）' : '昨日非龙头');

    let reason;
    if (head.topicRank === 2 && yizi === MIN_YIZI_SINGLE) {
      // [2026-09-24] 第 2 名题材【只有 1 个竞价一字】→ 组内时点会分裂，理由必须把两种都说清
      reason = '题材排在第一，第二，题材排第二，' + countText + '，该题材只有' + yizi + '个竞价一字涨停，' +
        prevText + '，龙一' + SELL_TIME_CLOSE + '卖，其余非龙一' + SELL_TIME_MIDDAY + '卖';
    } else if (head.topicRank === 1 || head.topicRank === 2) {
      reason = '题材排在第一，第二，题材排' + rankWord + '，' + countText + '，该题材' + yiziText +
        '，' + prevText +
        '，' + SELL_TIME_CLOSE + '卖';
    } else {
      reason = '题材排不在第一，第二' + (rankWord ? ('，排' + rankWord) : '') + '，' + countText +
        '，该题材' + yiziText + '，' + prevTextElse +
        '，' + SELL_TIME_MIDDAY + '卖';
    }

    items.sort(function(a, b) {
      const ra = (a.dragonRank === null ? Number.MAX_SAFE_INTEGER : a.dragonRank);
      const rb = (b.dragonRank === null ? Number.MAX_SAFE_INTEGER : b.dragonRank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    items.forEach(function(it, i) { it.seq = i + 1; });

    out.push({
      topic: head.topic || '',
      groupKey: key,
      topicRank: head.topicRank,
      count: count,
      yiziCount: yizi,
      reason: reason,
      items: items
    });
  });

  // 题材间按「今日题材排名」升序（未成组的排最后），保证卖点顺序与买点口径一致
  out.sort(function(a, b) {
    const ra = (a.topicRank === null ? Number.MAX_SAFE_INTEGER : a.topicRank);
    const rb = (b.topicRank === null ? Number.MAX_SAFE_INTEGER : b.topicRank);
    if (ra !== rb) return ra - rb;
    return a.groupKey < b.groupKey ? -1 : 1;
  });
  return out;
}

/**
 * 规则说明文案（灰色小问号里显示的那些行）。
 * ⛔ 刻意放在 Logic 层：规则文案与规则实现必须同处一处，改规则时不会只改代码不改说明（§6）。
 *    后期要加规则 —— 加完实现就在下面加一行说明，UI 一行都不用动。
 * @returns {string[]}
 */
export function buildRulesLines() {
  return [
    '【买点】只看题材排名前二的题材（题材排名 = 早盘竞价「题材 toggle」的组序）：',
    '　① 排名第 1 的题材，竞价一字 ≥ ' + MIN_YIZI_HEAVY + ' 个 → 选【最靠前那只非一字】的票（正常是龙一）' +
      POSITION_HEAVY + '，',
    '　　第二只【不再按名次取龙二】，改取【其余票里竞价涨幅最高】的那只' + POSITION_HEAVY + '；',
    '　　若「涨幅最高」的【不是】龙二（发生卡位）→ 再加【龙二】' + POSITION_LIGHT +
      '，一共选【3 只】（9/1 农业：龙二 +0.1% ＜ 龙三 +7.3% → 龙三' + POSITION_HEAVY + '、龙二' + POSITION_LIGHT + '）；',
    '　　涨幅最高的恰好就是龙二 → 维持原来的 2 只，都' + POSITION_HEAVY + '。',
    '　　非龙一 且 是【创业板 / 科创板 / 北交所】（20% / 30% 涨跌幅板）→ 顺延下一位（9/2 芒果超媒 → 改选龙版传媒）。',
    '　② 排名第 1 的题材，竞价一字【只有 ' + MIN_YIZI_SINGLE + ' 个】→ ' + POSITION_HEAVY +
      '买 ' + PICK_COUNT_SINGLE + ' 只（龙头顺序跳过一字，正常就是龙一）；',
    '　　同时在【' + getDragonLabel(LADDER_MIN_RANK) + '～' + getDragonLabel(LADDER_MAX_RANK) +
      '】里挑「非一字 且 竞价涨幅 > 0」的高开票做' + POSITION_LIGHT + '（= 早盘竞价里龙标为红色的那几只）；',
    '　③ 排名第 1 的题材，竞价一字 0 个 → 不达买入条件（题材排名就是按一字数排的，所以这等价于',
    '　　【全部题材】都没有一字 → 直接改走下面的 ⑤，不再只展示数据）；',
    '　④ 排名第 2 的题材 → 先看【龙一】，两条规则有先后：',
    '　　　· 龙一【不是】竞价一字（一字才买不进）→ 【直接买龙一】' + PICK_COUNT_LIGHT + ' 只，' +
      POSITION_LIGHT + '，不看竞价涨跌幅；',
    '　　　· 龙一【是】竞价一字 → 按龙头顺序跳过一字，取【名次最靠前的那只竞价高开】的股票 ' +
      PICK_COUNT_LIGHT + ' 只，' + POSITION_LIGHT + '；',
    '　　　　（龙一~龙八全低开、只有龙九高开 → 就选龙九；龙四与龙八都高开 → 选名次更靠前的龙四）。',
    '　　　· 该题材【只有 1 个竞价一字】时先做【题材替换】：拿【连板天梯 · 题材连扳】里',
    '　　　　【股票数量最多】的题材，回到【早盘竞价】比两者股票数，谁多就选谁',
    '　　　　（9/3：第 2 名大消费 7 只 ＜ 天梯第一的 AI应用 10 只 → 改选 AI应用；否则沿用本题材）。',
    '　⑤ 【无一字弱市】当日【全部题材】的竞价一字都是 0 个 → 先看【大题材】，再改看【题材连扳】：',
    '　　　· 第 1 / 第 2 名题材里有【股票数量 ≥ ' + BIG_TOPIC_MIN_COUNT + ' 只】的 → 每个都只取【龙一】' +
      POSITION_LIGHT + '（9/4：电子/通信/算力 17 只、AI应用 10 只 → 各取龙一）；',
    '　　　· 否则改看【连板天梯 · 题材连扳】：',
    '　　取【股票数量最多】的题材（数量并列时，并列的题材【全都取】，每个都按同一规则选票）；',
    '　　每个入选题材只看它最靠前的两只（龙一 / 龙二），最终【只留竞价高开】的票：',
    '　　　· 龙一低开 + 龙二高开 → 只买龙二；· 两只都高开 → 两只都买；· 两只都低开 → 只买龙一；',
    '　　全部记【' + POSITION_LIGHT + '】（没有一字，强度打折）。',
    '　　题材连扳里股票最多的题材【不足 ' + NO_YIZI_MIN_TOPIC_COUNT + ' 只】→ 【空仓】（太弱，不参与）。',
    '　　缺竞价涨幅的票【不算高开】，会如实说明有几只未纳入（§10 不猜）。',
    '　⑥ 【小题材 + 一字 = 高风险】排名【第 1 或第 2】的题材【股票数量 ≤ ' + SMALL_TOPIC_MAX_COUNT +
      ' 只】且【竞价一字 ' + SMALL_TOPIC_MIN_YIZI + '~' + SMALL_TOPIC_MAX_YIZI + ' 个】：',
    '　　票太少却被一字撑起排名，多半是量化假强度，①②③④【都不适用】，改看【连板天梯 · 题材连扳】；',
    '　　　· 该题材在【早盘竞价】里的股票数【< ' + SMALL_TOPIC_MIN_AUCTION_COUNT + ' 只】→ 排除；',
    '　　　· 剩下的题材按【早盘竞价股票数】降序取前二；',
    '　　　· 数量最多的题材：在【龙一~龙五】里只取【竞价高开】的票 ——',
    '　　　　龙一高开 → 龙一' + POSITION_HEAVY + ' + 竞价涨幅最高的那只' + POSITION_LIGHT + '；',
    '　　　　龙一低开 / 平开 → 【舍弃龙一】，只在【龙二~龙五】里取竞价涨幅最高的两只，都' + POSITION_LIGHT + '；',
    '　　　· 数量第二的题材：只取【龙一】，' + POSITION_LIGHT + '。',
    '　龙一 / 龙二 = 题材内【十日涨幅】从高到低，与早盘竞价龙一徽章同一口径。',
    '　【灰行（灰色名称 / 灰色题材 = 不在当日正式列表）】照常参与龙位与选票 —— 它们是同时期的龙头，',
    '　　有参考价值（9/8 大消费龙一国芳集团就是灰行）；只是【不计入】题材数量 / 一字数（与早盘竞价统计条同口径）。',
    '　【「昨日卖标签继承」的复盘行】昨天已卖出 → 不占龙位、也不入选买点。',
    '　【低开龙一的提醒】龙一竞价低开时，请自行看它的竞价图形：若出现【跌停 L 形】→ 尾盘买',
    '　　（本看板没有分时数据、不做图形判断，只给这段文字提醒）。',
    '　重仓与轻仓混在同一个题材块里，序号连续，仓位写在每行行尾。',
    '【题材行的数据】题材名右边依次是：实心红圆点（里面的数字 = 题材排名）｜数量：n（股票只数）｜竞价一字：n。',
    '【卖点】候选 = 昨日打过「买」标签的股票，卖出时点写在每行行尾：',
    '　① 今日题材排第 1 或第 2 → ' + SELL_TIME_CLOSE + ' 卖（拿满一天）；',
    '　② 今日题材排名不在前二（含今日未成组）→ ' + SELL_TIME_MIDDAY + ' 卖（排名靠后，弱了早走）；',
    '　③ 例外：今日题材【排第 2】且该题材【只有 1 个竞价一字】→ 题材强度打折，',
    '　　 【只有龙一】' + SELL_TIME_CLOSE + ' 卖，【其余非龙一】' + SELL_TIME_MIDDAY + ' 卖（同一组里会同时出现两种时点）。',
    '　「昨日是龙头（十日涨幅最高）」会写进卖出理由 —— 典型场景：昨日的龙一今天掉出前二 → ' + SELL_TIME_MIDDAY + ' 卖。',
    '说明：统计只数当日正式列表里的股票，「昨日卖标签继承」的复盘行不计入（与早盘竞价同一口径）；',
    '　　　缺竞价涨幅的行不会当成「高开」，会如实说明有几只未纳入。'
  ];
}

/**
 * 数值 → 展示文本（§21：格式化在 Logic 层做完，模板只负责渲染）。
 * 缺失一律返回 ''（§10 绝不补 0 / '-'）。
 */
export function formatRangePct(pct) {
  const n = _num(pct);
  if (n === null) return '';
  return (n >= 0 ? '+' : '') + String(Math.round(n)) + '%';
}
