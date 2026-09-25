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
 *                pct?:number|null, aucPct?:number|null}>} entries
 *        countable=false 的行（如「昨日卖标签继承」的复盘行）不计入数量与一字数 —— 与早盘竞价一致。
 *        aucPct = 当日竞价涨幅（%）；null = 缺数据（§10：不能当 0，也就不能当「高开」）。
 * @returns {Array<{rank:number, topic:string, count:number, yiziCount:number,
 *                  members:Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null}>}>}
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
      countable: countable
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
 * [NOT-FORMAL-DRAGON 2026-09-25] 候选集 = 【计入统计的成员】：
 *   · m.pct === null → 缺十日涨幅，排不进龙位（§10：绝不当 0 参与比较）；
 *   · m.countable === false → 早盘竞价里画灰的行（如「昨日卖标签继承」的复盘行），
 *     与题材数量 / 一字数的计数口径同源 —— 灰行不计数的同时也不该占龙位，
 *     否则会出现「统计条说 5 只、龙一却是那只灰票」的错位（用户 2026-09-25 反馈的同类问题）。
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
      if (m.countable === false) return;      // 灰色复盘行不占龙位（与计数口径同源）
      entries.push({ name: m.name, topic: b.topic, pct: m.pct });
    });
  });
  return computeDragonRankMap(entries, { coloredTopics: colored, minGroupSize: DECISION_MIN_GROUP });
}

/**
 * 在一个题材块里挑「能买的」：按龙头排名升序，跳过【竞价一字】（一字买不进），取前 maxCount 只。
 * @returns {Array<{seq:number, name:string, dragonLabel:string, dragonRank:number|null,
 *                  pct:number|null, position:string}>}
 */
export function pickBuyable(block, dragonMap, maxCount, position) {
  if (!block) return [];
  const dragon = dragonMap || new Map();
  const candidates = block.members
    .filter(function(m) { return !m.isYizi; })
    .map(function(m) {
      const d = dragon.get(m.name);
      return { name: m.name, pct: m.pct, rank: d ? d.rank : null };
    })
    .sort(function(a, b) {
      const ra = (a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank);
      const rb = (b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    })
    .slice(0, maxCount);

  return _reseq(candidates.map(function(c) {
    return {
      name: c.name,
      dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
      dragonRank: c.rank,
      pct: c.pct,
      position: position
    };
  }));
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
    base.mode = 'double';
    base.qualified = true;
    base.picks = pickBuyable(first, dragonMap, PICK_COUNT_HEAVY, POSITION_HEAVY);
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
 *   · countable === false → 早盘竞价里画灰的行（昨日卖标签继承的复盘行）不占龙位；
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
    if (r.countable === false) return;                     // 灰色复盘行不占龙位（与计数同源）
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
 * 生成买点计划。
 * @param {Array} blocks rankDecisionTopics 的返回
 * @param {Map} dragonMap rankDragons 的返回
 * @param {{ladderTopicGroups?:Array, ladderReady?:boolean, ladderReason?:string}} [opts]
 *        【无一字兜底】要用的连板天梯「题材连扳」分组（只有「全部题材一字 = 0」时才用得上；
 *        由 decision-collect 采集后传进来，本文件保持纯函数、不碰数据源）
 *        ⓘ 龙一 / 龙二的排名人群用的是 blocks 自身（早盘竞价题材组），无需额外传参
 * @returns {{heavy:object|null, light:object|null, noYizi:object|null}}
 *          heavy = 第 1 名题材的方案；light = 第 2 名题材的方案；
 *          noYizi = 「全部题材竞价一字 = 0」时的弱市兜底方案（三者互斥：noYizi 非空时前两者必为 null）。
 *          qualified=false 表示「未达一字门槛 / 太弱」——仍然展示题材与数字（§10 如实呈现），
 *          但 ⛔ 不给出买入建议（picks 为空），绝不拿不够格的数据冒充有效信号。
 */
export function buildBuyPlan(blocks, dragonMap, opts) {
  const list = blocks || [];
  const first = list.find(function(b) { return b.rank === 1; }) || null;
  const second = list.find(function(b) { return b.rank === 2; }) || null;

  // [NO-YIZI 2026-09-25] 当日【所有题材】都没有竞价一字 → 弱市，改走「连板天梯 · 题材连扳」兜底规则。
  // ⛔ 判据是【全部题材的一字总数】，不是「第 1 名题材的一字数」：
  //    用户原话是「当天所有的题材都没有一字涨停的股票时」。
  const totalYizi = list.reduce(function(n, b) { return n + (Number(b.yiziCount) || 0); }, 0);
  if (list.length > 0 && totalYizi === 0) {
    const o = opts || {};
    return {
      heavy: null,
      light: null,
      noYizi: buildNoYiziPlan(o.ladderTopicGroups || [], {
        dragonMap: dragonMap,
        ladderReady: o.ladderReady,
        ladderReason: o.ladderReason,
        // 龙一 / 龙二的排名人群 = 早盘竞价题材组（blocks 自身），⛔ 不是「题材连扳」的子集
        auctionTopicBlocks: list
      })
    };
  }

  // 第 2 名题材：用户只要求「选一只最强的、轻仓」，未设一字门槛（后期要加只需改这里）
  const light = second ? {
    block: second,
    rankWord: '第二',
    reason: _reasonBuy(second, '第二'),
    mode: 'light',
    qualified: true,
    notQualifiedText: '',
    picks: pickBuyable(second, dragonMap, PICK_COUNT_LIGHT, POSITION_LIGHT),
    notes: []
  } : null;

  return {
    // ⛔ first 为空时必须返回 null：UI 用 v-if="buyHeavy" 判空，
    //    返回空壳对象会让模板去读 block.block.topic 直接崩（当日没有成组题材时会走到这里）
    heavy: first ? _buildFirstBlock(first, dragonMap) : null,
    light: light,
    noYizi: null
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
    '　① 排名第 1 的题材，竞价一字 ≥ ' + MIN_YIZI_HEAVY + ' 个 → 取最靠前的 ' + PICK_COUNT_HEAVY +
      ' 只【非一字涨停】的股票（一字买不进，自动跳过），两只都' + POSITION_HEAVY + '；',
    '　② 排名第 1 的题材，竞价一字【只有 ' + MIN_YIZI_SINGLE + ' 个】→ ' + POSITION_HEAVY +
      '买 ' + PICK_COUNT_SINGLE + ' 只（龙头顺序跳过一字，正常就是龙一）；',
    '　　同时在【' + getDragonLabel(LADDER_MIN_RANK) + '～' + getDragonLabel(LADDER_MAX_RANK) +
      '】里挑「非一字 且 竞价涨幅 > 0」的高开票做' + POSITION_LIGHT + '（= 早盘竞价里龙标为红色的那几只）；',
    '　③ 排名第 1 的题材，竞价一字 0 个 → 不达买入条件（题材排名就是按一字数排的，所以这等价于',
    '　　【全部题材】都没有一字 → 直接改走下面的 ⑤，不再只展示数据）；',
    '　④ 排名第 2 的题材 → 取 ' + PICK_COUNT_LIGHT + ' 只最强的（同样按龙头顺序跳过一字），' + POSITION_LIGHT + '。',
    '　⑤ 【无一字弱市】当日【全部题材】的竞价一字都是 0 个 → 改看【连板天梯 · 题材连扳】：',
    '　　取【股票数量最多】的题材（数量并列时，并列的题材【全都取】，每个都按同一规则选票）；',
    '　　每个入选题材只看它最靠前的两只（龙一 / 龙二），最终【只留竞价高开】的票：',
    '　　　· 龙一低开 + 龙二高开 → 只买龙二；· 两只都高开 → 两只都买；· 两只都低开 → 只买龙一；',
    '　　全部记【' + POSITION_LIGHT + '】（没有一字，强度打折）。',
    '　　题材连扳里股票最多的题材【不足 ' + NO_YIZI_MIN_TOPIC_COUNT + ' 只】→ 【空仓】（太弱，不参与）。',
    '　　缺竞价涨幅的票【不算高开】，会如实说明有几只未纳入（§10 不猜）。',
    '　龙一 / 龙二 = 题材内【十日涨幅】从高到低，与早盘竞价龙一徽章同一口径',
    '　（只在【当日正式列表】的股票里排：灰色名称 / 灰色题材的继承行不占龙位）。',
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
