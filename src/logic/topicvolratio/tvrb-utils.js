// tvrb-utils.js — 「题材量比」规则层的【纯工具函数】（无副作用，无外部依赖）
//
// 从 topic-vol-ratio-rules.js 拆出。这一层只做「取数 / 归一 / 算词」：
//   _normTopic（题材串清洗 + 大类归一）、_sameTopicLoose（宽松认亲）、
//   _num / _pct2（数值解析，§10：读不到就是 null，⛔ 不补 0）、
//   _streakWord / _windowTextOf / _todayRankPhrase / _rankLabelOf（文案词）、
//   以及几个排名表读取小件（_range10RankMapOf / _closeRankOf / _rankTopEntries ...）。

import { NEW_DRAGON_LOOKBACK_DAYS } from './tvrb-constants.js';

import { totalDragonLabel } from '../auction/range20-top5-label.js';
import { buildRange10Ranked } from './range10-backup.js';
import { PRESENCE_TOP_N } from '../auction/presence-label.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [EBB-TOPIC-FIX 2026-10-22] 题材串归一（§6 唯一实现，⛔ 别在三个消费点各写一遍）
//
// 用户报障：「今天10月22日……提示板说【主线16950新华传媒首次退潮】，这个不是首次了」。
// 根因链（实测站库确认，完整过程见 data/watchlist-helpers.js 的 topics 分支注释）：
//   ① 新华传媒 10-21 / 10-22 都是【停牌补位票】（不在当天 watchlist 里）⇒ 题材走「昨日题材」退路；
//   ② 那条退路取 'topics' 时命中了读取器的 yest_volume 兜底 ⇒ 退潮行里 leader_topic = '16950'；
//   ③ 事件计数按题材认亲 ⇒ '16950' 在近 10 天里 0 次 ⇒ 误判【首次退潮】。
// 修好 ② 之后，【历史行】里仍留着 '26728' / '16950' 这两条脏数据（不能靠改库解决：
//   历史判定是审计留痕，而且用户明确不让动 worker 相关的表）⇒ 计数这一层必须【认得出脏值】：
//   · 题材名不可能是纯数字 ⇒ 纯数字一律视作【未知】（清洗成空串）；
//   · 任一侧题材未知 ⇒ 退回「同一只总龙」认亲（从紧，不乱认亲 —— 与既有认亲退路同一条口径）；
//   · 两侧都有题材 ⇒ 按题材比较，且支持「AI应用,数据中心」这种分段串。
// ⇒ 10-22 实测效果：今天的题材解析出 'AI应用'（题材库补位），历史 10-14/10-15 事件（1 次）
//   + 10-20 事件（1 次）= 2 次 ⇒ 第二十七条「无第三次」生效 ⇒ 不再误报首次退潮。
// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * 题材串清洗 + 大类归一：trim；**纯数字一律置空**（那是错值：题材名不可能是 '16950'）；
 * 再按核心词表把细分题材归到【大类】（用户口径：判定用的「题材」= 核心管理里的大类）。
 *
 * ★★ [CORE-CAT 2026-10-22 用户口径] 「文化传媒」⇒「AI应用」这一步是【必须】的：
 *   新华传媒行上的细分题材是「文化传媒」，而老周期在落库表里写的是「AI应用」——
 *   不归一 ⇒ 近 20 个交易日的退潮事件数从 2 掉到 0 ⇒ 误报【首次退潮】（10-22 用户报障）。
 *
 * @param {*} raw 原始题材串
 * @param {(raw:string)=>string} [coreRes] 大类归一函数（makeCoreTopicResolver 的返回）
 *        缺省 / null ⇒ 只做清洗，不做归一（= 本参数引入前的行为，§11 零行为变化）
 * @returns {string}
 */
export function _normTopic(raw, coreRes) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return '';
  if (typeof coreRes === 'function') {
    const t = String(coreRes(s) || '').trim();
    if (t) return t;
  }
  return s;
}

/**
 * 两个题材串是否同一题材（支持 'AI应用,数据中心' 分段串；任一侧为空 ⇒ false）。
 * ★ 两侧都先过 `_normTopic`（清洗 + 大类归一）再比 —— 归一后相等即同一题材。
 * ★ 分段串认亲是【双向】的：'AI应用' 与 'AI应用,数据中心' 必须认成同一题材
 *   （旧实现只看前者的分段，后者反过来就认不上；两段串同时出现时更会互相漏认）。
 */
export function _sameTopicLoose(a, b, coreRes) {
  const x = _normTopic(a, coreRes);
  const y = _normTopic(b, coreRes);
  if (!x || !y) return false;
  if (x === y) return true;
  const split = function(s) {
    return s.split(/[,，/、+;；|]/).map(function(seg) { return seg.trim(); }).filter(Boolean);
  };
  const xs = split(x);
  const ys = split(y);
  return xs.some(function(sx) { return ys.some(function(sy) { return sy === sx; }); });
}

/** 退潮日【允许看分笔卖】的股票名集合（§6：唯一的取名实现，判定与改写共用） */
export function _ebbEligibleNames(ebb) {
  const set = new Set();
  if (!ebb) return set;
  if (ebb.siblingName) set.add(ebb.siblingName);
  if (ebb.secondName) set.add(ebb.secondName);
  return set;
}

/** 退潮日【买点侧替补】的股票名集合（卖点侧放行用：今天要买的票不能同时被要求竞价清仓） */
export function _ebbBuyPickNames(ebb) {
  const set = new Set();
  if (!ebb) return set;
  (ebb.buyPickNames || []).forEach(function(n) { if (n) set.add(String(n)); });
  // 兼容旧消费方：buySecondName 恒在 buyPickNames 里（§6 同一来源，这里再兜一次不亏）
  if (ebb.buySecondName) set.add(String(ebb.buySecondName));
  return set;
}

export function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 涨幅 → 「+35.21%」两位小数文案（★ 只用于【说明文字】，⛔ 不参与任何判定，§21 文案在 Logic 层拼好）。
 *
 * ⚠️ 为什么不复用 `formatRangePct`：那个是行上「十日涨幅」列的展示口径（**取整**，+35%），
 *   而说明区要跟用户核对「9:26 那一刻到底是多少」—— 取整会让 +35.21 与 +36.40 都显示成 +35%/+36%，
 *   看着像同一档，反而更难核对。缺值 ⇒ '—'（§10 不补 0）。
 * @param {number|string|null} v
 * @returns {string}
 */
export function _pct2(v) {
  const n = _num(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/**
 * 「按名字在题材块成员里找那一行」的【唯一实现】（§6）。
 *
 * ★ 为什么单独提出来：第三十条【弱势切抱团】与第三十二条【题材龙一竞价跌停 ⇒ 切抱团】都要
 *   把 20日涨幅池里的那只票，与本看板题材块里的【真实成员行】对上（要用它的 code / aucShare
 *   去抓分笔、算占比）。两份各写一遍就会在「同名不同块 / 缺行」时给出不同答案。
 *
 * @param {Array} list 题材块数组（每块含 members）
 * @param {string} name 股票名
 * @returns {object|null} 命中的成员行；找不到 ⇒ null（§10 不造空壳）
 */
export function _findMemberByName(list, name) {
  const want = String(name || '').trim();
  if (!want) return null;
  let hit = null;
  (list || []).forEach(function(b) {
    if (hit) return;
    (b.members || []).forEach(function(m) {
      if (!hit && m && String(m.name || '').trim() === want) hit = m;
    });
  });
  return hit;
}

/**
 * 连板档位文案（第三十一条专用，§6 单一真相的唯一收口处）。
 *
 * ★ 为什么要有这个小函数：decision-collect 富化 20日涨幅前十时已经把 `streakLabel`
 *   （= `getStreakLabel()` 的输出：「首板 / 二板 / … / 五板」）挂在每个池子元素上。
 *   ⛔ 规则层不许再自造一套档位表（否则「连板天梯」说『五板』、本看板说『5连板』，
 *      同一只在两个页面两种说法，用户核对时会对不上）。
 *   ⚠️ 回退：`streakLabel` 缺失（旧调用方 / 单测夹具没给）时才自拼；
 *      streak 未知（null）⇒ 返回 ''（§10 不猜、不拿 0 顶替成「趋势」）。
 *
 * @param {object} t  池子元素（读 .streakLabel）
 * @param {number|null} st 已归一化的连板天数
 * @returns {string} '五板' | '首板' | '5连板' | ''
 */
export function _streakWord(t, st) {
  if (st === null || st === undefined || !isFinite(Number(st))) return '';
  const n = Number(st);
  if (n < 1) return '';                       // 0 = 趋势（不是连板票）⇒ 不出档位文案，⛔ 不写「0连板」
  const lb = String((t && t.streakLabel) || '').trim();
  if (lb) return lb;
  return n === 1 ? '首板' : (n + '连板');
}

/**
 * ★★ [SECOND-LEADER-10 2026-10-24 用户口径] 排名第二的入选题材：它的【龙一】必须进入当天
 * 十日涨幅前十（9:26 竞价口径）—— 用户本轮新增的第二个入选条件。
 *
 * 用户原话（逐字）：
 *   「排名第二的题材规则，还需要完善下，添加规则，这个题材的龙一是否进入当天的10日涨幅前十？
 *     如果没进入，也不能选，只选排名第一的那个题材股票」
 *   「龙一是大亚圣象在十日涨幅排名11名（我按照当天收盘口径看到的，实际上是按照9点26分的竞价口径，
 *     你核查下……），没有进入前十，说明这个题材还是很弱。连它的龙一都没有进入当天的十日涨幅，
 *     说明没有带动性，后续基本上涨概率不大，风险很高。」
 *   「排名第二题材入选规则是，平均量比符合，题材龙一进入当天十日涨幅前十（竞价口径），
 *     只有满足这个条件。才能入选买点侧。」
 *
 * 口径（§6：两把尺子都必须与屏幕同源，⛔ 不许另写一份）：
 *   · 「龙一」= 组内【龙位 = 1】的那只。名册用 `buyDragonMap`（9:26 竞价口径的
 *     `rankDragonsWithPctMap`），与买点侧选股同一个名册；非主板不占龙位 ⇒ 不会出现「龙一是创业板」。
 *   · 「当天十日涨幅前十」= `PRESENCE_TOP_N`（与「10日涨幅」toggle 那十枚标签同一个常量），
 *     名次来自 `range10-backup.js#buildRange10Ranked`（与候补选股、与屏幕排序同一个实现）。
 *
 * ⚠️ 「排不出名次」分两种情况，⛔ 绝不能混（§10 的方向在这里是关键）：
 *   · 龙一【在池子里、但没有十日涨幅 / 非主板】⇒ 屏幕上它本来就没有名次、也不在那十枚标签里
 *     ⇒ 结论是确定的「没进前十」（judge = ''，rank = null）；
 *   · 龙一【根本不在池子里】/ 池子不可用 ⇒ 我们没看到它这一行 ⇒ **判不出**（judge = 'no-row' / 'no-pool'）
 *     ⇒ ⛔ 不许当成「没进」去否掉题材（判不出 ≠ 判出 false）。
 *
 * @param {object} blk 题材块（rankDecisionTopics 的一项：含 topic / members）
 * @param {Map} dragonMap 9:26 口径龙位名册
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap 十日涨幅名次（见 _range10RankMapOf）
 * @returns {{ok:boolean, judge:string, dragonName:string, rank:number|null, pct:number|null}}
 *          judge：'' = 判出来了；'no-dragon' / 'no-row' / 'no-pool' = 判不出（各自原因不同，文案要分开说）
 */
export function _secondTopicLeaderInTop10(blk, dragonMap, rankMap) {
  const topN = PRESENCE_TOP_N;
  const dm = dragonMap || new Map();
  let lead = null;
  ((blk && blk.members) || []).forEach(function(m) {
    if (lead || !m || !m.name) return;
    const d = dm.get(m.name);
    if (d && Number(d.rank) === 1) lead = m;
  });
  if (!lead) {
    return { ok: false, judge: 'no-dragon', dragonName: '', rank: null, pct: null };
  }
  const nm = String(lead.name).trim();
  if (!(rankMap instanceof Map) || rankMap.size === 0) {
    return { ok: false, judge: 'no-pool', dragonName: nm, rank: null, pct: null };
  }
  if (!rankMap.has(nm)) {
    // 池子里根本没有这只票 ⇒ 我们没看到它的十日涨幅 ⇒ 判不出（⛔ 不当成「没进」）
    return { ok: false, judge: 'no-row', dragonName: nm, rank: null, pct: null };
  }
  const hit = rankMap.get(nm) || null;
  const pct = hit ? _num(hit.pct) : null;
  const rawRank = hit ? Number(hit.rank) : NaN;
  const rank = (isFinite(rawRank) && rawRank > 0) ? rawRank : null;
  // rank === null ⇒ 它在池子里但排不出名次（没有十日涨幅 / 非主板）⇒ 不在那十枚标签里
  return { ok: rank !== null && rank <= topN, judge: '', dragonName: nm, rank: rank, pct: pct };
}

/**
 * 【纯函数】把十日涨幅池排成「主板名次」索引：`Map<股票名, {rank, pct}>`。
 * ⛔ 排序 / 名次 / 只主板 全部复用 range10-backup.js#buildRange10Ranked（§6 同一个实现），
 *   本函数只负责「换成按名字查」。
 */
export function _range10RankMapOf(rows) {
  const m = new Map();
  if (!Array.isArray(rows) || rows.length === 0) return m;
  buildRange10Ranked(rows).forEach(function(it) {
    if (it && it.name) m.set(it.name, { rank: it.rank, pct: it.pct });
  });
  return m;
}

/**
 * ★★ [DUAL-RANK 2026-10-24 用户口径] 一只票在【收盘口径】下的名次（复盘对照用）。
 *
 * 用户原话：「我明白了，就是按照竞价口径，上海九百就是排名前十首次在列的那只，但是收盘口径，
 *   兆威机电排在前十且出现首次在列。而上海九百，却排在 11，所以看起来产生错觉。复盘时出现困惑。
 *   你有没有办法让我复盘时，只看竞价口径的排名结果，但是收盘时我也想看，竞价口径我也想看
 *   原始的是怎么排名的。」
 *   ⇒ 屏幕上【继续以竞价口径（9:26）为准】（名字前面那个「第 N 名」永远是选股用的那一份），
 *     同时把【收盘口径】的名次并列写出来，让复盘时能直接对照，⛔ 不用去两个看板来回比对。
 *
 * ⛔ 本函数只产出事实，绝不参与任何判定（§6：选股口径一旦分叉就等于换了一套规则）。
 *
 * 三态返回（§10：判不出 ≠ 判出「没有名次」）：
 *   · `null`             ⇒ 收盘口径名次表不可用 / 这只票不在原始池里 ⇒ **判不出** ⇒ 文案一个字都不写；
 *   · `{rank:null,...}`  ⇒ 它在原始池里，但收盘口径下排不出名次（非主板 / 缺涨幅）⇒ 屏幕上本来就没名次；
 *   · `{rank:N,...}`     ⇒ 判出来了；`same=true` 表示与竞价口径名次相同（⇒ 文案可省，零噪声）。
 *
 * @param {Map|null} closeRankMap 收盘口径名次表（`_range10RankMapOf(o.range10Rows)`）
 * @param {string} name 股票名
 * @param {number|null} rank926 竞价口径名次（用来判「两套是否相同」）
 * @returns {{rank:number|null, pct:number|null, same:boolean}|null}
 */
export function _closeRankOf(closeRankMap, name, rank926) {
  if (!(closeRankMap instanceof Map) || closeRankMap.size === 0) return null;
  const nm = String(name || '').trim();
  if (!nm || !closeRankMap.has(nm)) return null;
  const it = closeRankMap.get(nm) || null;
  const r = it ? Number(it.rank) : NaN;
  const cur = Number(rank926);
  if (!isFinite(r) || r <= 0) return { rank: null, pct: it ? _num(it.pct) : null, same: false };
  return { rank: r, pct: it ? _num(it.pct) : null, same: isFinite(cur) && cur === r };
}

/**
 * 【纯函数】把一份名次表里「第 1 ~ topN 名」的票按名次取出来（供两套口径对照文案用）。
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap
 * @param {number} topN
 * @returns {Array<{name:string, rank:number, pct:number|null}>}
 */
export function _rankTopEntries(rankMap, topN) {
  const out = [];
  if (!(rankMap instanceof Map) || rankMap.size === 0) return out;
  rankMap.forEach(function(v, k) {
    const r = v ? Number(v.rank) : NaN;
    if (!isFinite(r) || r <= 0 || r > topN) return;
    out.push({ name: k, rank: r, pct: v ? _num(v.pct) : null });
  });
  out.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

/**
 * 【纯函数】★ [SMALL-TOPIC 2026-10-24 用户口径] 一个题材里，有哪些票进了【当天十日涨幅前十】。
 *
 * 用途：排名第一的入选题材、【数量 4~6 只】时（`TVRB_SMALL_TOPIC_MAX`），只许在这几只里选
 *       「名次最靠前的那一只」；一只都没有 ⇒ 该题材【弃掉】（见 buildTopicVolRatioPlan 里的收紧段）。
 *
 * ⚠️ 「判不出」与「判出 = 一只都没进」必须分开（§10 的方向在这里是关键，与
 *    `_secondTopicLeaderInTop10` 的解码方式刻意保持一致，两处是同一把尺子）：
 *   · `judge = 'no-pool'` ⇒ 名次表本身不可用（池子没读到 / 20 天补位行未就绪）⇒ **判不出**；
 *   · `judge = 'no-row'`  ⇒ 这个题材的成员【一只都不在池子里】⇒ 我们根本没看见它们 ⇒ **判不出**
 *                            （⛔ 不许当成「一只都没进前十」去弃掉题材）；
 *   · `judge = ''`        ⇒ 判出来了：`hits` = 池内成员里名次 ≤ PRESENCE_TOP_N 的（按名次升序），
 *                            `hits.length === 0` 就是确定的「一只都没进前十」。
 *
 * ⚠️ 残留缺口（如实记下，⛔ 不装作没有）：`judge = ''` 时若该题材【有成员不在池子里】，
 *    理论上那只缺行成员可能正躺在前十里 ⇒ 严格说结论带一点假设。实际池子 = 当日名单 + 20 天
 *    补位行 = 屏幕上全部有十日涨幅的行，缺行的都是灰行 / 注入壳（本来就无十日涨幅、屏幕上也没有
 *    名次标签）⇒ 与本看板其它判定（第二十九条候补、第二题材闸门）同一口径。要收紧的只有
 *    「一只都看不见」这一种，已单列为 `no-row`。
 *
 * @param {object} blk 题材块（rankDecisionTopics 的一项：含 topic / members）
 * @param {Map<string,{rank:number|null,pct:number|null}>} rankMap 十日涨幅名次（见 _range10RankMapOf）
 * @returns {{judge:string, hits:Array<{name:string,rank:number,pct:number|null}>, seen:number}}
 */
export function _topicTop10Hits(blk, rankMap) {
  const topN = PRESENCE_TOP_N;
  if (!(rankMap instanceof Map) || rankMap.size === 0) {
    return { judge: 'no-pool', hits: [], seen: 0 };
  }
  const hits = [];
  let seen = 0;
  ((blk && blk.members) || []).forEach(function(mm) {
    const nm = String((mm && mm.name) || '').trim();
    if (!nm || !rankMap.has(nm)) return;
    seen++;
    const it = rankMap.get(nm) || null;
    // rank === null ⇒ 它在池子里但排不出名次（没有十日涨幅 / 非主板）⇒ 屏幕上它本来就没有名次标签
    const r = it ? Number(it.rank) : NaN;
    if (isFinite(r) && r > 0 && r <= topN) {
      hits.push({ name: nm, rank: r, pct: it ? _num(it.pct) : null });
    }
  });
  if (seen === 0) return { judge: 'no-row', hits: [], seen: 0 };
  hits.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return { judge: '', hits: hits, seen: seen };
}


/**
 * 【纯函数】文案：历史榜窗口的描述 —— **必须如实暴露覆盖度**。
 *
 * 🔴 2026-10-22 用户当场质问「这个不是算20个交易日吗？为什么说是8个交易日？」：
 *   判定窗口确实是 20 个交易日（`NEW_DRAGON_LOOKBACK_DAYS = 20`，组合式按交易日历往前取 20 天），
 *   但落库表 `stock_range20_pct` 当时**只有 8 天有行**（该能力 2026-10-12 才上线）⇒
 *   `readTop5History` 的 `days` = 8，文案如实写 8。
 *   ⛔ 绝不能为了"看起来对"改写成 20 —— 那是把「没查过」伪装成「查过且没上榜」（§10 红线）。
 *   ⇒ 正解 = 把【窗口 20 / 实际 8】两个数同时写出来，用户一眼就能看出是数据缺口而不是算错。
 *
 * ✅ 2026-10-22 已用 `db/scripts/backfill-range20.mjs` 把表补齐到 20/20（09-16~10-21 + 10-22，
 *   共 252 只票；09-25 是中秋休市不算，停牌票按 §10 不写）。此时 `days` = 20 ⇒ 本函数返回
 *   「20 个交易日」，括号里的覆盖度自然消失 —— 文案自适应，不需要改判定逻辑。
 *   ⚠️ 分支仍必须保留：以后换设备 / 换库 / 新窗口刚上线时，覆盖度照样会不足，仍要如实暴露。
 *
 * @param {number} windowDays 历史榜实际覆盖天数
 * @returns {string}
 */
export function _windowTextOf(windowDays) {
  const n = Math.floor(Number(windowDays) || 0);
  if (n <= 0) return '（历史榜未读到）';
  if (n >= NEW_DRAGON_LOOKBACK_DAYS) return n + ' 个交易日';
  return n + ' 个交易日（实际覆盖 ' + n + '/' + NEW_DRAGON_LOOKBACK_DAYS + ' 天）';
}

/**
 * 【纯函数】文案：这只票【今天】在 20日涨幅榜上的名次。
 *
 * 🔴 2026-10-22 用户当场质问「你不是说按照当天竞价冰山冷热排在第六吗？现在怎么是排在前五？」
 *   根因 = 旧文案**硬编码**「【首次】上到前五」，而判定允许从【前八】里挑（用户口径「改用排名前八的」）
 *   ⇒ 只要选中的是新龙榜第 6/7/8 名，那句「上到前五」就是**假话**。
 *   ⚠️ [TVRB-AUC-BOARD 2026-11-10 已根治] 旧注释说「口径随时钟切换 ⇒ 同一个屏幕早晚看到的
 *     名次本来就会变」—— 那是规则输入直接吃 `getRange20Leaders`（15:00 切 auc→close 重发布）
 *     造成的事故，不是正常现象。现在题材量比的 20 日榜恒 9:25 竞价口径、名单固定，
 *     名次早晚一致；⛔ 别把旧结论当设计依据再加回口径切换。
 *   ⇒ 文案一律写【今日排名第 K 名】，把名次交给数据说话，⛔ 不再出现任何"上到前五"的断言。
 *
 * @param {number} rank20 今日名次（1 起）
 * @returns {string}
 */
export function _todayRankPhrase(rank20) {
  const r = Math.floor(Number(rank20) || 0);
  return r > 0 ? ('今日排名第 ' + r + ' 名') : '今日排名未定';
}

/**
 * 【纯函数】文案：名次标签。
 *
 * 🔴 为什么需要：`totalDragonLabel` 只定义了 1~5（第 6 名及以后返回 `''`），而本规则的候选池是
 *   【前八】⇒ 选中的是新龙榜第 6/7/8 名时，旧文案会把标签渲染成 **`总龙?`**（2026-10-22 实测）。
 *   ⇒ 前五照旧用「总龙一~五」；第 6~8 名如实写「20日涨幅第 K 名」；再往后写「榜外」。
 *
 * @param {number} rank20
 * @returns {string}
 */
export function _rankLabelOf(rank20) {
  const r = Math.floor(Number(rank20) || 0);
  if (r <= 0) return '20日涨幅榜外';
  const lb = totalDragonLabel(r);
  return lb || ('20日涨幅第 ' + r + ' 名');
}