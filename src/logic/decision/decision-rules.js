// decision-rules.js — 「决策」看板的核心规则（Logic 层纯函数，§15 独立业务模块 / §21 模板零计算）
//
// 本文件【只有纯函数】：不读 state、不发请求、不碰 DOM、不 import 任何 store。
// 所有输入输出都是普通对象/数组 → 既方便单测，也保证后期加规则时只动这一个文件。
//
// ── 产品口径（2026-09-24 用户原话整理；后期还会继续完善，此处刻意做成可配置的常量）──
//
// 【买点】只看「排名第一 / 第二」两个题材（题材排名 = 早盘竞价「题材 toggle」的组序，同源）：
//   · 第 1 名题材：竞价一字 ≥ 2 个 ⇒ 买【两只】——按题材内龙头排名（龙一→龙二→…）取
//     【最靠前的两只非一字涨停】的股票（一字涨停买不进，必须跳过），建议【重仓】；
//   · 第 2 名题材：取【一只】最强的（同样按龙头顺序跳过一字），建议【轻仓】。
//
// 【卖点】候选 = 【昨日】打过「买」标签的股票：
//   · 今日题材排【第 1 或 第 2】名 ⇒ 14:50 卖（拿满一天）；
//   · 今日题材排名【不在前二】⇒ 11:20 卖（排名靠后，弱了就早走）。
//     其中「昨日是龙头（十日涨幅最高）」是用户明确点出的典型情形，写在卖出理由里。
//     ⚠️ 用户只明确了这两条；「不在前二 且 昨日非龙头」未明确 —— 暂按【排名靠后 = 11:20】处理，
//        与另一分支同结果，不会给出互相矛盾的建议。要改只改 _decideSellTime 一处。
//
// 【§10 红线】任何一段数据缺失 → 该段【不产出】（返回空/不给出建议），
//   绝不用 0 / '-' / 空字符串伪装成「有数据」。

import { sortByTopicGroups } from '../auction/topic-sort.js';
import { computeDragonRankMap, getDragonLabel } from '../auction/dragon-rank.js';

/** 题材成组门槛：与早盘竞价统计条（topic-stats.js#TOPIC_STATS_MIN_GROUP）同源 —— 不足 2 只不成题材 */
export const DECISION_MIN_GROUP = 2;
/** 第 1 名题材触发「重仓」所需的最少竞价一字数量（用户口径：两个或两个以上一字） */
export const MIN_YIZI_HEAVY = 2;
/** 第 1 名题材取几只；第 2 名题材取几只 */
export const PICK_COUNT_HEAVY = 2;
export const PICK_COUNT_LIGHT = 1;
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
 * @param {Array<{name:string, topic:string, isYizi?:boolean, countable?:boolean, pct?:number|null}>} entries
 *        countable=false 的行（如「昨日卖标签继承」的复盘行）不计入数量与一字数 —— 与早盘竞价一致。
 * @returns {Array<{rank:number, topic:string, count:number, yiziCount:number,
 *                  members:Array<{name:string, isYizi:boolean, pct:number|null}>}>}
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
    cur.members.push({ name: list[i].name, isYizi: !!list[i].isYizi, pct: _num(list[i].pct), countable: countable });
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
      entries.push({ name: m.name, topic: b.topic, pct: m.pct });
    });
  });
  return computeDragonRankMap(entries, { coloredTopics: colored, minGroupSize: DECISION_MIN_GROUP });
}

/**
 * 在一个题材块里挑「能买的」：按龙头排名升序，跳过【竞价一字】（一字买不进），取前 maxCount 只。
 * @returns {Array<{seq:number, name:string, dragonLabel:string, pct:number|null, position:string}>}
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

  return candidates.map(function(c, i) {
    return {
      seq: i + 1,
      name: c.name,
      dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
      pct: c.pct,
      position: position
    };
  });
}

function _reasonBuy(block, rankWord) {
  if (!block) return '';
  return '题材排' + rankWord + '，股票数量' + block.count + '只，' + block.yiziCount + '个竞价一字';
}

/**
 * 生成买点计划。
 * @param {Array} blocks rankDecisionTopics 的返回
 * @param {Map} dragonMap rankDragons 的返回
 * @returns {{heavy:object|null, light:object|null}}
 *          block 里的 qualified=false 表示「未达一字门槛」——仍然展示题材与数字（§10 如实呈现），
 *          但 ⛔ 不给出买入建议（picks 为空），绝不拿不够格的数据冒充有效信号。
 */
export function buildBuyPlan(blocks, dragonMap) {
  const list = blocks || [];
  const first = list.find(function(b) { return b.rank === 1; }) || null;
  const second = list.find(function(b) { return b.rank === 2; }) || null;

  const heavy = first ? {
    block: first,
    rankWord: '第一',
    reason: _reasonBuy(first, '第一'),
    qualified: first.yiziCount >= MIN_YIZI_HEAVY,
    notQualifiedText: '竞价一字不足 ' + MIN_YIZI_HEAVY + ' 个，未达买入条件',
    picks: []
  } : null;
  if (heavy && heavy.qualified) heavy.picks = pickBuyable(first, dragonMap, PICK_COUNT_HEAVY, POSITION_HEAVY);

  // 第 2 名题材：用户只要求「选一只最强的、轻仓」，未设一字门槛（后期要加只需改这里）
  const light = second ? {
    block: second,
    rankWord: '第二',
    reason: _reasonBuy(second, '第二'),
    qualified: true,
    notQualifiedText: '',
    picks: pickBuyable(second, dragonMap, PICK_COUNT_LIGHT, POSITION_LIGHT)
  } : null;

  return { heavy: heavy, light: light };
}

function _yiziWord(n) {
  return n > 0 ? ('有' + n + '个竞价一字涨停') : '无竞价一字涨停';
}

function _rankWord(rank) {
  if (rank === 1) return '第一';
  if (rank === 2) return '第二';
  return rank ? ('第' + rank + '名') : '';
}

/** 卖出时点决策（唯一实现；后期改规则只改这里） */
function _decideSellTime(topicRank) {
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
    const d = dragon.get(r.name);
    const isPrevDragon = prevUnknown ? null : prevSet.has(r.name);
    groups.get(key).push({
      name: r.name,
      topic: tp,
      topicRank: rank,
      isPrevDragon: isPrevDragon,
      dragonLabel: d ? getDragonLabel(d.rank) : '',
      dragonRank: d ? d.rank : null,
      pct: _num(r.pct),
      inTodayList: !!r.inTodayList,
      sellAt: _decideSellTime(rank)
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
    if (head.topicRank === 1 || head.topicRank === 2) {
      reason = '题材排在第一，第二，题材排' + rankWord + '，' + countText + '，该题材' + yiziText +
        '，' + prevText +
        '，建议' + SELL_TIME_CLOSE + '卖';
    } else {
      reason = '题材排不在第一，第二' + (rankWord ? ('，排' + rankWord) : '') + '，' + countText +
        '，该题材' + yiziText + '，' + prevTextElse +
        '，建议' + SELL_TIME_MIDDAY + '卖';
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
      ' 只【非一字涨停】的股票（一字买不进，自动跳过），建议' + POSITION_HEAVY + '；',
    '　② 排名第 2 的题材 → 取 ' + PICK_COUNT_LIGHT + ' 只最强的（同样按龙一→龙二顺序跳过一字），建议' + POSITION_LIGHT + '。',
    '　龙一 / 龙二 = 题材内【十日涨幅】从高到低，与早盘竞价龙一徽章同一口径。',
    '【卖点】候选 = 昨日打过「买」标签的股票：',
    '　① 今日题材排第 1 或第 2 → ' + SELL_TIME_CLOSE + ' 卖（拿满一天）；',
    '　② 今日题材排名不在前二（含今日未成组）→ ' + SELL_TIME_MIDDAY + ' 卖（排名靠后，弱了早走）。',
    '　「昨日是龙头（十日涨幅最高）」会写进卖出理由 —— 典型场景：昨日的龙一今天掉出前二 → ' + SELL_TIME_MIDDAY + ' 卖。',
    '说明：统计只数当日正式列表里的股票，「昨日卖标签继承」的复盘行不计入（与早盘竞价同一口径）。'
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
