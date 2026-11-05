// tvrb-ebb.js — 「退潮」判定（第二十一 / 二十五 / 三十二条的共同上游）
//
// 从 topic-vol-ratio-rules.js 拆出。这里只有【判定】，不产出买点块：
//   classifyMainTopic —— 主线题材识别（题材只数 / 连通性 / 分歧门槛）
//   detectEbbDay      —— 退潮日判定（含 _ebbPhaseOf 阶段划分、_prevLeaderDayState 昨龙状态）
//   secondEbbTopicOfPrevDay —— 前一日「退潮二次确认」的题材
//   buildEbbDayRecord —— 落库/审计用的退潮日记录
//
// ⛔ 买点块一律在 tvrb-blocks.js 里组装（本文件不碰 blocks）。

import { EBB_EVENT_WINDOW_DAYS, EBB_MAIN_TOPIC_TOP_N, EBB_MAIN_TOPIC_MIN_COUNT, EBB_DIVERGE_MIN_STREAK, EBB_PICK_TAG, EBB_NO_BUY_TAG, EBB_SECOND_BUY_TAG } from './tvrb-constants.js';
import { _normTopic, _sameTopicLoose, _num } from './tvrb-utils.js';

import { formatRangePct, SELL_OUT_TAG, HOLD_TAG } from '../decision/decision-rules.js';
import { passesAuctionShare, formatAuctionShare, auctionShareThresholdOf } from '../decision/auction-share.js';
import { getDragonLabel } from '../auction/dragon-rank.js';
import { totalDragonLabel } from '../auction/range20-top5-label.js';


/**
 * ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 【主线题材 or 轮动行情】—— 退潮规则的前置闸门（纯函数，可单测）。
 *
 * 用户原话（逐字）：
 *   「首先再说明下什么是主线龙头，20日涨幅中排名前10的，
 *     1.必须满足有3只以上同题材的才叫主线题材，也就是说主线题材必须至少有3只排在前10。
 *     2.而且总龙一是该题材的。这叫主线题材。
 *     3.如果都是不同题材，或者一个题材只有两只，这个算是轮动行情，按照常规操作就行。」
 *
 * 判据（对 20日涨幅【前十】按题材分组，只看【总龙一自己所在的那一组】）：
 *   · 组内只数 ≥ `EBB_MAIN_TOPIC_MIN_COUNT`（3）且总龙一属于该组 ⇒ `'main'`（主线题材）；
 *   · 组内只数 < 3 且榜单【确实是完整前十】⇒ `'rotation'`（轮动行情，⛔ 不触发退潮）；
 *   · 总龙一的题材【读不到】、或榜单【不满 10 只】（数据残缺 / 只注入了前五前八）⇒ `'unknown'`
 *     （§10：**判不出 ≠ 判出 false** —— 后几名里完全可能还有同题材的票，⛔ 不硬判成轮动）。
 *     ⚠️ 这一档【不拦】退潮（用户既有拍板「取不到就按首日处理，宁可多提醒一次」），
 *        但调用方必须把「无法确认主线题材」如实写进说明（§10 判定可追溯）。
 *
 * @param {Array<{name:string, topic:string, pct:number}>|null} pool 20日涨幅前十（逐只已带题材）
 * @param {string} leaderName 总龙一的名字（用于把它自己强行算进它那一组）
 * @param {string} leaderTopic 总龙一的题材（原始串，内部会做清洗 + 大类归一）
 * @param {(raw:string)=>string} [coreRes] 题材大类归一函数（见 _normTopic）
 * @returns {{kind:'main'|'rotation'|'unknown', count:number, total:number,
 *            topic:string, members:Array<{name:string,pct:number}>}}
 *          total = 参与统计的只数（= 榜单长度，通常 10；不够 10 只的日期如实小）
 */
export function classifyMainTopic(pool, leaderName, leaderTopic, coreRes) {
  const topic = _normTopic(leaderTopic, coreRes);
  const list = Array.isArray(pool) ? pool : [];
  const total = list.length;
  const members = [];
  if (!topic) {
    // §10：题材读不到 ⇒ 分组无从谈起（⛔ 不把「未知」当成「每组只有 1 只」的轮动）
    return { kind: 'unknown', count: 0, total: total, topic: '', members: members };
  }
  const lname = String(leaderName || '').trim();
  list.forEach(function(t) {
    if (!t) return;
    const nm = String(t.name || '').trim();
    if (!nm) return;
    // 总龙一本人一定属于它自己那一组（即便榜单富化时它的题材串解析成了别的东西，也不漏算自己）
    const hit = (lname && nm === lname) || _sameTopicLoose(t.topic, topic, coreRes);
    if (!hit) return;
    members.push({ name: nm, pct: _num(t.pct) });
  });
  const count = members.length;
  // ★ 能不能下「轮动行情」这个【否定结论】，取决于榜单够不够长（§10：判不出 ≠ 判出 false）：
  //   · 组内已经 ≥ 门槛 ⇒ 一定是主线题材（榜单再长也只会更多，结论不会翻）；
  //   · 组内 < 门槛，但榜单本身就是【完整的前十】⇒ 才是轮动行情；
  //   · 组内 < 门槛，而榜单不满 10 只（数据残缺 / 调用方只注入了前五或前八）⇒
  //     **无从判定**（后面那几名里完全可能还有同题材的票）⇒ 'unknown'，⛔ 不硬判成轮动。
  //   这一档正是「榜单没就绪」与「真的是轮动」的分水岭 —— 两者混为一谈会让规则在数据缺失时静默失效。
  const enough = total >= EBB_MAIN_TOPIC_TOP_N;
  let kind;
  if (count >= EBB_MAIN_TOPIC_MIN_COUNT) kind = 'main';
  else if (enough) kind = 'rotation';
  else kind = 'unknown';
  return {
    kind: kind,
    count: count,
    total: total,
    topic: topic,
    members: members
  };
}

/**
 * 【退潮日】判据（纯函数，可单测）。
 *
 * 数据来源 = decision-collect#_ebbCtxOf 采好的「事实」（市场总龙 / 今日停牌 / 今日占比 /
 *   同题材龙位成员 / 市场总龙二 / 买点侧替补与五只去留留痕），⛔ 本函数不读 state、不发请求（§4）。
 *
 * ── 退潮是什么（★ 2026-10-20 用户口径的【定义澄清】）──────────────────────────────────
 *   「退潮是指总龙一在某个题材停牌或者占比不符，导致是整个题材的股票预期走势很差，
 *     叫题材退潮，不是个股退潮。」⇒ 退潮的主体是【总龙所在的题材】，不是总龙那只票本身。
 *
 * ── 判据（★ 用户口径：「龙一停牌或者占比不达标……两种情况，有一种存在就算退潮」）──────────
 *   ① 市场总龙【今日停牌】⇒ 退潮（停牌 = 最强的那只都停了）；
 *   ② 市场总龙【今日竞价占比不达标】⇒ 退潮。
 *   ⛔ ② 的占比【缺数据】⇒【不判】（§10：未知 ≠ 不达标）；门槛走 auction-share 的唯一实现。
 *   ⛔ 两条都不成立 ⇒ 返回 null（= 不是退潮日，⛔ 不回落到「没有总龙」）。
 *
 * ── ★★【首次 / 二次确认】（2026-10-20 用户口径，本轮新增）─────────────────────────────
 *   用户原话：「判断是不是首日要看它最近10天的表现，如果十天内出现首日退潮，那今天就不能算是
 *     首日了，而是确认主线退潮……提示语改下首日退潮，改成具体的题材名称，比如，主线AI应用
 *     首次退潮。第二次的时候，改成比如，AI应用二次确认退潮。注意没有第三次了，退潮后基本不看了
 *     这个题材了。」
 *   ⇒ 判定 = 【近 10 个交易日】里、同题材的【退潮事件】次数（ebbHistory 注入）：
 *     · 0 次 ⇒ 本次为【首次退潮】（提示语 = 主线{题材}首次退潮）；
 *     · 1 次 ⇒ 本次为【二次确认退潮】（提示语 = {题材}二次确认退潮）；
 *     · ≥ 2 次 ⇒【无第三次】：本规则不再触发，返回 null（按平常日子选股）。
 *   ⚠️ 【事件】≠【天数】：总龙连续多日停牌 / 不达标只算【一次】事件（第二天起是延续，
 *     由下面的「昨日闸门」拦住不触发；历史计数时也把连续退潮日合并，⛔ 别数成多次）。
 *   ⚠️ 计数按【题材】认（leaderTopic）；题材取不到时退回按【同一只总龙】认（§10 从紧，不乱认亲）。
 *
 * ── ★★【昨日闸门】（第八轮 · 2026-10-14 用户口径，保留）─────────────────────────────
 *   用户原话：「我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
 *     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
 *   ⇒ 上面①/② 成立【且】上一交易日【同一只总龙】还没处在坏状态 ⇒ 才触发本规则；
 *     昨天就已经停牌 / 占比不达标 ⇒ 今天算延续 ⇒ 返回 null（本规则不生效）。
 *
 *   「昨日状态」的两条来源（按优先级，见 _prevLeaderDayState）：
 *     ① 【落库的昨日判定】—— verdict 来自 tvrb_ebb_days 表 ⇒ 最权威；
 *     ② 退路：库里昨日那一行的【竞价量 / 占比】推断；
 *     ③ 两处都取不到 ⇒ 按【可触发】处理（继续提醒）—— 用户拍板「取不到就按首日处理，别漏掉风险」。
 *   ⚠️ 只认「同一只总龙」：昨日那只总龙与今日不是同一只 ⇒ 对今天这只而言本来就是新事件。
 *
 * ── ★★【闸门 A：主线题材 or 轮动行情】（[EBB-MAIN-TOPIC 2026-10-25 用户口径]）──────────────
 *   用户原话：「必须满足有3只以上同题材的才叫主线题材，也就是说主线题材必须至少有3只排在前10。
 *     而且总龙一是该题材的，这叫主线题材。如果都是不同题材，或者一个题材只有两只，
 *     这个算是轮动行情，按照常规操作就行。」
 *   ⇒ 判据见 `classifyMainTopic`（前十按题材分组，只看总龙所在那组）：
 *     · 组内 ≥ `EBB_MAIN_TOPIC_MIN_COUNT`(3) 且含总龙一 ⇒ 主线题材 ⇒ 继续往下判；
 *     · 组内 < 3（含「前十题材全不同」）⇒ 轮动行情 ⇒ 返回 null（⛔ 不触发，用户「按常规操作」）；
 *     · 总龙题材读不到 ⇒ 'unknown' ⇒ 不拦，但说明里必须写「无法确认主线题材」（§10）。
 *   ⚠️ 为什么轮动行情不算退潮：用户 10-20 对退潮的定义是「总龙一在某个题材停牌/占比不符 ⇒
 *     整个题材的股票预期走势很差」—— 主体是【题材】。一个题材只有 1~2 只票，它构不成题材周期。
 *
 * ── ★★【闸门 B：总龙是不是连板被砸开】（[EBB-STREAK 2026-10-25 用户口径]）────────────────
 *   用户原话：「看总龙一是不是分歧，要看它是不是连板涨停。比如前天涨停板，昨天涨停板，
 *     今天占比不符合（或者停牌），这叫首次退潮。必须前面两天是涨停板，今天占比不符合（竞价口径）。
 *     如果前两天不是涨停板，这不叫分歧，这叫趋势。按照常规操作就行。」
 *   ⇒ `ebbCtx.leaderStreak`（= limit-streak#computeStreak，T-1 起连续收盘涨停天数）：
 *     · ≥ `EBB_DIVERGE_MIN_STREAK`(2) ⇒ 连板被砸开 ⇒ 继续往下判；
 *     · 0 / 1（趋势 / 首板）⇒ 返回 null（这叫趋势，按常规操作）；
 *     · null（T-1 没有行 / 涨幅缺失 ⇒ 无从判定）⇒ 不拦，但说明里必须写「连板状态读不到」（§10）。
 *   ★ 8-03 实测（用户报障那一天）：总龙艾艾精工 T-2 = -3.05%、T-1 = -5.87% ⇒ streak=0
 *     ⇒ 新规则下不再报退潮（旧实现只看占比 1.8% < 3.5% 就报了，正是用户说的「这叫趋势」）。
 *
 * ── 涨幅口径（★ 2026-10-20 改定）────────────────────────────────────────────────────
 *   总龙 = 【当日 20日涨幅】全市场第一（getRange20Leaders，与「20日涨幅」toggle 的总龙一同一只）。
 *   20日按每票自己的交易日回溯、停牌票靠补位照样进榜 —— 这正是改用 20日的原因：
 *   十日口径在总龙停牌那天根本排不出它（当日快照没它的行）。
 *   卖点侧的【市场总龙二】仍用【昨日十日涨幅第二】的旧口径（用户「其它规则不变」）。
 *
 * @param {{ready:boolean, leader:object|null, leaderSuspended:boolean, leaderShare:number|null,
 *          siblingDragons:Array, secondInfo:object|null, prevLeader:object|null,
 *          buyPicks:Array, buyTrail:Array,
 *          topicPool?:Array<{name:string, topic:string, pct:number}>,
 *          leaderStreak?:number|null, leaderStreakLabel?:string}|null} ebbCtx
 *        见 decision-collect#_ebbCtxOf（[EBB-R20] buyPicks / buyTrail 为本轮新增的两个事实；
 *        ★ [EBB-MAIN-TOPIC 2026-10-25] topicPool = 20日涨幅前十富化；
 *        ★ [EBB-STREAK 2026-10-25] leaderStreak = 总龙连板天数，null = 无从判定）
 * @param {{leader_stock?:string, ebb?:boolean}|null} [prevEbbDay]
 *        ★ [EBB-R8] 上一交易日在 tvrb_ebb_days 里落库的判定行（缺省 = 表里还没有 / 表不存在）
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string,
 *          ebb:boolean}>|null} [ebbHistory]
 *        ★ [EBB-R20] 近 22 个交易日的退潮判定落库行（组合式读 tvrb_ebb_days 注入；
 *        前 20 天是「事件窗口」，多取的 2 天只用来判「连续退潮日合并成一次事件」）。
 *        缺省 / 空 ⇒ 按 0 次事件处理（= 首次退潮；与「取不到就按首日处理」同一拍板）。
 *        ★ [EBB-20D 2026-10-22 用户口径] 窗口由 10 天扩到【20 个交易日】：
 *          「时间太短没有检查到10月13日那天」—— 10 天窗口跨不过一个完整的老周期。
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（= 第 20 个交易日的日期）
 * @returns {null|object} null = 不是退潮日（或事实未就绪 / 是延续 / 无第三次 /
 *          ★ [EBB-MAIN-TOPIC] 轮动行情 / ★ [EBB-STREAK] 前两日不是都涨停）；否则见下方返回结构
 */
export function detectEbbDay(ebbCtx, prevEbbDay, ebbHistory, coreRes, windowFrom) {
  // §10：事实未就绪（昨日涨幅还没读回来 / 全列表一只票都排不出）⇒ 不判退潮
  if (!ebbCtx || !ebbCtx.ready || !ebbCtx.leader) return null;
  const leader = ebbCtx.leader;
  const leaderName = String(leader.name || '').trim();
  // ★ [EBB-TOPIC-FIX 2026-10-22] 题材串归一：纯数字（= 脏值，实测 '16950' / '26728'）视作未知，
  //   否则标题会渲染成「主线16950首次退潮」，且按题材认亲会全部落空（见文件头 [EBB-TOPIC-FIX]）。
  // ★★ [CORE-CAT 2026-10-22] 再归到【大类】：'文化传媒' ⇒ 'AI应用'（用户口径，见 _normTopic）。
  const leaderTopic = _normTopic(leader.topic, coreRes);
  const leaderPct = _num(leader.pct);
  if (!leaderName || leaderPct === null) return null;      // §10：涨幅读不到 ⇒ 不判

  // ── 判据 ①/② ──
  // ★★ [EBB-R20 2026-10-20] 判据②的占比门槛【恒按龙头档】：总龙一 = 20日涨幅全市场第一，
  //   它本身就是市场龙头。旧实现「按它今日十日龙位取档（龙一 3.5% / 其余 2%）」是总龙还选
  //   「昨日十日涨幅第一」时代的写法 —— 那时的总龙几乎总是今日龙一，两档等价；
  //   改成 20日选总龙后，总龙完全可能是当日十日口径的龙三（10-20 实测：新华传媒 20日 202.59%
  //   全市场第一，但十日口径里它是 AI应用 的龙三、占比 2.7%）⇒ 若仍按十日龙位落到 2% 档，
  //   2.7% 会被误判「达标」，用户拍板的「今天新华传媒占比不达标 ⇒ 二次确认退潮」整条静默失效
  //   （🔴 这正是「改了选法、忘了改门槛取档」的伴生缺陷，§38 同类根因）。
  //   判据②的本意 = 「全市场最强的那只票竞价占比塌了」，龙头门槛（3.5%，含容错 4%）才是本意。
  const leaderIsDragonOne = true;
  const sh = _num(ebbCtx.leaderShare);
  let reason = '';
  if (ebbCtx.leaderSuspended) {
    reason = 'suspend';
  } else if (sh !== null && !passesAuctionShare(sh, leaderIsDragonOne)) {
    // 门槛恒为龙头档（3.5%）：总龙一的竞价占比塌了才算「占比不符」（用户 10-20 口径）。
    reason = 'share';
  }
  if (!reason) return null;

  // ══════════════════════════════════════════════════════════════════════════════════════
  // ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 闸门 A：这是【主线题材】还是【轮动行情】？
  //   用户原话：「必须满足有3只以上同题材的才叫主线题材……而且总龙一是该题材的，这叫主线题材。
  //     如果都是不同题材，或者一个题材只有两只，这个算是轮动行情，按照常规操作就行。」
  //   ⇒ 轮动行情【根本不存在「题材退潮」这回事】—— 退潮的主体是题材（用户 10-20 的定义澄清：
  //     「退潮是指总龙一在某个题材停牌或者占比不符，导致整个题材的股票预期走势很差」），
  //     一个题材只有 1~2 只票时它构不成一个「题材周期」，占比塌了只是这只票自己的事。
  //   ⛔ 因此轮动行情 = 返回 null（按常规操作选股），而不是「照旧提示但降级文案」。
  //   ⚠️ 题材读不到 ⇒ 'unknown' ⇒ 【不拦】(§10 从紧但不静默失效)，由下面 phaseNote 如实说明。
  // ══════════════════════════════════════════════════════════════════════════════════════
  const mt = classifyMainTopic(ebbCtx.topicPool, leaderName, leader.topic, coreRes);
  if (mt.kind === 'rotation') return null;

  // ══════════════════════════════════════════════════════════════════════════════════════
  // ★★ [EBB-STREAK 2026-10-25 用户口径] 闸门 B：总龙一【前两个交易日是不是都涨停】？
  //   用户原话：「看总龙一是不是分歧，要看它是不是连板涨停。比如前天涨停板，昨天涨停板，
  //     今天占比不符合（或者停牌），这叫首次退潮。必须前面两天是涨停板，今天占比不符合（竞价口径）。
  //     如果前两天不是涨停板，这不叫分歧，这叫趋势。按照常规操作就行。」
  //   ⇒ streak ≥ 2（= T-1、T-2 都是收盘涨停）才是「连板被砸开」的分歧；
  //     streak = 0 / 1（趋势 / 首板）⇒ 占比塌了只是【趋势中的一次回落】⇒ 返回 null。
  //   ⚠️ 8-03 实测（用户报障的那一天）：总龙【艾艾精工】T-2 07-30 = -3.05%、T-1 07-31 = -5.87%，
  //     两天都不是涨停 ⇒ streak=0 ⇒ 新规则下【不再触发退潮】—— 正是用户说的「这叫趋势」。
  //   §10：streak 读不到（null，如补位票在 T-1 没有行）⇒ 不拦，但 phaseNote 必须如实说明「无从判定」。
  // ══════════════════════════════════════════════════════════════════════════════════════
  const streakRaw = ebbCtx.leaderStreak;
  const streak = (streakRaw === null || streakRaw === undefined || !isFinite(Number(streakRaw)))
    ? null : Number(streakRaw);
  if (streak !== null && streak < EBB_DIVERGE_MIN_STREAK) return null;

  // ── ★★【昨日闸门】（第八轮，保留）──
  const prev = _prevLeaderDayState(ebbCtx, prevEbbDay, leaderName);
  if (prev.bad) return null;   // 昨日同一只总龙已在坏状态 ⇒ 今天是延续 ⇒ 本规则不触发

  // ── ★★【首次 / 二次确认】（[EBB-R20 2026-10-20 用户口径]）──
  //   近 20 个交易日里同题材的【退潮事件】次数（连续退潮日合并为一次）：0 ⇒ 首次、1 ⇒ 二次确认、
  //   ≥2 ⇒ 无第三次 ⇒ 本规则不再触发（返回 null，按平常日子选股 —— 用户「退潮后基本不看了这个题材了」）。
  //   ★ [EBB-20D 2026-10-22 用户口径] 窗口 10 → 20 个交易日；且题材按【大类】认亲（coreRes）。
  const phase = _ebbPhaseOf(leaderTopic, leaderName, ebbHistory, coreRes, windowFrom);
  if (phase.count >= 2) return null;
  const isFirst = (phase.count === 0);
  // 提示语（用户给的原样示例）：首日 = 「主线AI应用首次退潮」；第二次 = 「AI应用二次确认退潮」
  const topicText0 = leaderTopic || '总龙题材';
  const phaseTitle = isFirst
    ? ('主线' + topicText0 + '首次退潮')
    : (topicText0 + '二次确认退潮');
  const phaseNote = isFirst
    ? ('（近 ' + EBB_EVENT_WINDOW_DAYS + ' 个交易日内【' + topicText0 + '】没有退潮事件 ⇒ 本次为【首次退潮】' +
       (prev.source === 'unknown' ? '；昨日状态两处都取不到 ⇒ 按【可触发】处理，宁可多提醒一次' : '') + '）')
    : ('（近 ' + EBB_EVENT_WINDOW_DAYS + ' 个交易日内【' + topicText0 + '】已出现过 ' + phase.count + ' 次退潮事件' +
       (phase.lastDate ? ('，最近一次 ' + phase.lastDate) : '') + ' ⇒ 本次为【二次确认退潮】）');

  // ── 两道新闸的判定留痕（§10：判定必须可追溯，⛔ 不静默）──
  //   ① 主线题材：前十里同题材几只、分别是谁（用户是照着这个数去核对的）；
  //   ② 连板分歧：前两个交易日是不是都涨停（streak ≥ 2 = 二板起）。
  const mainTopicText = (mt.kind === 'main')
    ? ('主线题材确认：20日涨幅前 ' + mt.total + ' 名里有 ' + mt.count + ' 只【' + mt.topic + '】（' +
       mt.members.map(function(m) { return m.name; }).join('、') + '）；')
    : (mt.topic
      ? ('⚠️ 20日涨幅榜只拿到 ' + mt.total + ' 只（不足 ' + EBB_MAIN_TOPIC_TOP_N + '）、组内 ' + mt.count +
         ' 只同题材 ⇒ 无法确认主线题材（口径：前 ' + EBB_MAIN_TOPIC_TOP_N + ' 名里 ≥' +
         EBB_MAIN_TOPIC_MIN_COUNT + ' 只同题材），本次按可触发处理；')
      : ('⚠️ 总龙题材读不到 ⇒ 无法确认主线题材（口径：前 ' + EBB_MAIN_TOPIC_TOP_N + ' 名里 ≥' +
         EBB_MAIN_TOPIC_MIN_COUNT + ' 只同题材），本次按可触发处理；'));
  const streakText = (streak === null)
    ? '⚠️ 总龙前两个交易日的连板状态读不到 ⇒ 无法确认是不是连板分歧，本次按可触发处理；'
    : ('总龙前两个交易日连续涨停（' + (ebbCtx.leaderStreakLabel || (streak + '板')) + '）⇒ 属连板分歧；');
  const basisNote = '（' + mainTopicText + streakText.slice(0, -1) + '）';

  // ── 【看分笔卖】的两只（用户口径逐条对应；用户拍板：龙位可顺延、总龙二不顺延）──
  //   ① 同题材可用龙位 = 总龙所在题材内 rank ≥ 2 的成员，按龙位升序取第一个【非竞价一字 + 非停牌】的
  //      （龙二不可用 ⇒ 顺延龙三、龙四……）；
  //   ② 市场总龙二 = 昨日涨幅第二那只，且必须是【它自己题材的龙一】、与总龙【不同题材】、
  //      非竞价一字、非停牌（⛔ 不回落到涨幅第三 —— 用户明确「它必须正好是涨幅第二」）。
  const sib = (ebbCtx.siblingDragons || []).filter(function(s) {
    return _num(s.rank) !== null && Number(s.rank) >= 2 && !s.isYizi && !s.suspended;
  })[0] || null;
  const si = ebbCtx.secondInfo;
  const secondOk = !!(si &&
    Number(si.rank) === 1 && !si.isYizi && !si.suspended &&
    String(si.topic || '').trim() !== leaderTopic &&
    String(si.name || '').trim() !== leaderName);

  const leaderPctText = formatRangePct(leaderPct);
  const shareText = formatAuctionShare(sh);
  const thresholdText = formatAuctionShare(auctionShareThresholdOf(leaderIsDragonOne));
  const topicText = leaderTopic || '—';
  const whyText = (reason === 'suspend')
    ? '今日【停牌】'
    : ('今日竞价占比 ' + shareText + ' ＜ ' + (leaderIsDragonOne ? '龙头门槛' : '门槛') + ' ' + thresholdText);
  const sibLabel = sib ? getDragonLabel(Number(sib.rank)) : '';

  const picksText = (function() {
    const arr = [];
    if (sib) {
      arr.push('【' + sibLabel + sib.name + '】（同题材 ' + topicText + ' 的可用龙位' +
        (Number(sib.rank) === 2 ? '' : ' · 龙二不可用已顺延') + '）');
    }
    if (secondOk) {
      arr.push('【' + si.name + '】（市场总龙二：昨日十日涨幅第二 ' + formatRangePct(_num(si.pct)) +
        '，' + (String(si.topic || '').trim() || '—') + ' 的龙一）');
    }
    return arr;
  })();

  // ── ★★ 买点侧替补【≤2 只】（[EBB-R20 2026-10-20 用户口径]）────────────────────────────
  //   从 20日涨幅总龙一~五里：排非主板 → 排与总龙同题材 → 取排名最靠前的前两只（采集层已选好，
  //   本层只把每只的 20日涨幅 / 总龙N 标签 / 停牌·一字麻烦如实格式化）。
  const rawPicks = Array.isArray(ebbCtx.buyPicks) ? ebbCtx.buyPicks : [];
  const buyPicksOut = rawPicks.map(function(p) {
    const pPct = _num(p.pct);
    const pRank20 = Number(p.rank20) || 0;
    return {
      name: String(p.name || ''),
      code: String(p.code || ''),
      topic: String(p.topic || '').trim(),
      pct: pPct,
      pctText: formatRangePct(pPct),
      days: Number(p.days) || 0,
      rank20: pRank20,
      // 总龙N 标签：与「20日涨幅」toggle 同一份实现（§6），配不上名次的给 ''（§10 不硬造）
      label: totalDragonLabel(pRank20),
      isYizi: !!p.isYizi,
      suspended: !!p.suspended,
      trouble: p.suspended ? '⚠️ 但它今日【停牌】，买不进。'
        : (p.isYizi ? '⚠️ 但它今日【竞价一字涨停】，竞价买不进（要不要打板由你自己定）。' : '')
    };
  }).filter(function(p) { return !!p.name; });
  const bsOn = buyPicksOut.length > 0;
  const bs = bsOn ? buyPicksOut[0] : null;
  // 兼容别名（旧字段还有两处只读消费：落库行的 buySecond / 卖点侧放行）—— 语义 = 第一只替补
  const bsTrouble = bsOn
    ? buyPicksOut.map(function(p) { return p.trouble; }).filter(function(t) { return !!t; }).join('')
    : '（20日涨幅前五还没算出来 / 五只里选不出符合条件的替补 ⇒ 买点侧暂不给出替补）';
  // 五只去留留痕（规则层写进行内说明，判定可追溯，§10）
  const trailText = (function() {
    const arr = (Array.isArray(ebbCtx.buyTrail) ? ebbCtx.buyTrail : []).map(function(t) {
      const lb = totalDragonLabel(Number(t.rank20) || 0);
      return '【' + (lb || '总龙?') + t.name + '】' + String(t.reason || '');
    });
    return arr.join('；');
  })();
  // 「首日 / 二次确认」判定的依据来自哪里 —— 如实写进说明（§10 判定可追溯；⛔ 不静默）
  const firstDayNote = (prev.source === 'table')
    ? ('（昨日状态取自落库判定：' + prev.detail + '）')
    : (prev.source === 'inferred'
      ? ('（昨日落库判定缺失 ⇒ 按行情行推断：' + prev.detail + '）')
      : ('（昨日状态两处都取不到 ⇒ 本次按【可触发】处理，宁可多提醒一次）'));

  return {
    // ── 判据 / 事实 ──
    reason: reason,                                  // 'suspend' | 'share'
    leaderName: leaderName,
    leaderTopic: leaderTopic,
    leaderPct: leaderPct,
    leaderPctText: leaderPctText,
    leaderSuspended: !!ebbCtx.leaderSuspended,
    leaderShare: sh,
    leaderShareText: shareText,
    leaderThresholdText: thresholdText,
    leaderIsDragonOne: leaderIsDragonOne,
    whyText: whyText,
    // ★ [EBB-R20] 阶段：'first' 首次退潮 / 'second' 二次确认退潮（≥2 次事件 ⇒ 本函数返回 null）
    phase: isFirst ? 'first' : 'second',
    phaseTitle: phaseTitle,
    phaseCount: phase.count,
    phaseNote: phaseNote,
    // ★★ [EBB-MAIN-TOPIC 2026-10-25] 闸门 A 的判定事实（'main' | 'unknown'；'rotation' 已在上文返回 null）
    //   count = 前十里与总龙同题材的只数，total = 该榜实际长度（不够 10 只的日期如实小）。
    mainTopicKind: mt.kind,
    mainTopicCount: mt.count,
    mainTopicTotal: mt.total,
    mainTopicTopic: mt.topic,
    mainTopicText: mainTopicText,
    // ★★ [EBB-STREAK 2026-10-25] 闸门 B 的判定事实（streak = null ⇒ 无从判定；已拦下的 streak < 2 不会走到这里）
    leaderStreak: streak,
    leaderStreakLabel: String(ebbCtx.leaderStreakLabel || ''),
    streakText: streakText,
    // 两道新闸的合并留痕（detail / buyDetail 已内联，此字段供其它消费方复用）
    basisNote: basisNote,
    // ★ [EBB-R8] 昨日判定的来源与依据（'table' 落库判定 / 'inferred' 昨日行情行推断 / 'unknown' 取不到）
    firstDay: isFirst,
    firstDaySource: prev.source,
    firstDayPrevLeader: prev.prevLeaderName,
    // ── 允许【看分笔卖】的两只（空串 = 该只今天不成立）──
    siblingName: sib ? String(sib.name) : '',
    siblingRank: sib ? Number(sib.rank) : null,
    siblingLabel: sibLabel,
    secondName: secondOk ? String(si.name) : '',
    secondTopic: secondOk ? String(si.topic || '') : '',
    secondPct: secondOk ? _num(si.pct) : null,
    secondPctText: secondOk ? formatRangePct(_num(si.pct)) : '',
    // ── ★ 买点侧替补【≤2 只】（[EBB-R20] 当日 20日涨幅口径）──
    buyPicks: buyPicksOut,
    buyPicksOn: bsOn,
    buyPickNames: buyPicksOut.map(function(p) { return p.name; }),
    // 五只去留留痕的展示文案（替补块行内说明用，判定可追溯 §10）
    buyTrailText: trailText,
    // 兼容别名（= 第一只替补；落库行 / 卖点放行等旧消费方只读）
    buySecondOn: bsOn,
    buySecondName: bs ? bs.name : '',
    buySecondTopic: bs ? bs.topic : '',
    buySecondPct: bs ? bs.pct : null,
    buySecondPctText: bs ? bs.pctText : '',
    buySecondLabel: bs ? bs.label : '',
    buySecondCode: bs ? bs.code : '',
    buySecondTrouble: bsTrouble,
    // 标题上直接列出那两只是谁（没有则如实说「一只都没有」）
    picksText: picksText.length > 0 ? picksText.join('、') : '（本日无符合条件的票）',
    // ── 文案（§21：模板零计算）──
    headline: '⚠️ ' + phaseTitle + ' · 卖点收紧',
    detail: '市场总龙【' + leaderName + '】（' + topicText + '，20日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ 判定为【' + phaseTitle + '】（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。' +
      firstDayNote + phaseNote + basisNote + '卖点侧：' +
      (picksText.length > 0
        ? ('只有 ' + picksText.join('、') + ' 可以【' + EBB_PICK_TAG + '】（等开盘看分笔，不看占比）；')
        : '今天没有符合条件的【同题材可用龙位】【市场总龙二】；') +
      '其余股票一律【' + SELL_OUT_TAG + '】（含原本标【' + HOLD_TAG + '】的）—— 开盘就走，降低风险。',
    buyHeadline: bsOn
      ? ('⚠️ ' + phaseTitle + ' · 买点替补只有这 ' + buyPicksOut.length + ' 只（' + EBB_SECOND_BUY_TAG + '）')
      : ('⚠️ ' + phaseTitle + ' · 建议空仓 · 不开仓'),
    buyOnlyLabelText: bsOn
      ? ('退潮替补 · 买点只有这 ' + buyPicksOut.length + ' 只（' + phaseTitle + '）')
      : '',
    buyDetail: '市场总龙【' + leaderName + '】（' + topicText + '，20日涨幅 ' + leaderPctText + '）' +
      whyText + ' ⇒ ' + phaseTitle + '，风险高。' + firstDayNote + phaseNote + basisNote +
      (bsOn
        ? ('买点侧今天【只买替补】（从 20日涨幅总龙一~五里选：先排非主板（创业板/科创板/北交所），' +
           '再排与总龙一同题材，剩下取排名最靠前的前两只）：' +
           buyPicksOut.map(function(p) {
             return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' + p.pctText + '）';
           }).join('、') + '。' + (trailText ? ('五只去留：' + trailText + '。') : '') +
           (bsTrouble ? bsTrouble + ' ' : '') +
           '下方其余入选票一律【' + EBB_NO_BUY_TAG + '】（整段灰化），除替补外没有买点。')
        : ('当天【选不出替补】（' + bsTrouble + '）' + (trailText ? ('五只去留：' + trailText + '。') : '') +
           '下方选股【整体变灰】仅为参考，建议今天不开仓（空仓）。'))
  };
}

/**
 * 【退潮事件计数】—— 「首次 / 二次确认 / 无第三次」的判定（§6：只此一份，⛔ 别在视图或组合式再数一遍）。
 *
 * 用户口径（2026-10-20）：「判断是不是首日要看它最近10天的表现，如果十天内出现首日退潮，
 *   那今天就不能算是首日了，而是确认主线退潮……注意没有第三次了。」
 *
 * ⚠️ 【事件】≠【天数】：总龙连续多日停牌 / 不达标只算一次事件 ——
 *   一条历史记录算「新事件」当且仅当它的【前一交易日】没有同题材的退潮记录
 *   （ebbHistory 的每行都带 prevDate，由组合式用 getPreviousTradingDay 链好；§6 日期口径不进本纯函数）。
 * ⚠️ 计数按【题材】认；题材取不到时退回按【同一只总龙】认（§10 从紧，不乱认亲）。
 * ⚠️ ebbHistory 缺省 / 空 ⇒ 计 0 次（= 首次退潮）—— 与用户拍板「取不到就按首日处理」同一口径。
 *
 * @param {string} topic 今日总龙的题材（可空）
 * @param {string} name 今日总龙名（题材为空时的认亲退路）
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string, ebb:boolean}>|null} history
 * @returns {{count:number, lastDate:string}} count = 近 10 个交易日内的退潮事件数；lastDate = 最近一次的日期
 */
/**
 * 【退潮事件计数】—— 见上方长注释（_ebbPhaseOf 的既有实现）。
 *
 * ★ [EBB-TOPIC-FIX 2026-10-22] 认亲规则改成三段：
 *   ① 今日题材【有效】且该行题材【有效】⇒ 按题材比较（支持 'AI应用,数据中心' 分段串）；
 *   ② 任一侧题材【无效】（空 / 纯数字脏值）⇒ 退回「同一只总龙」认亲；
 *   ③ 都认不上 ⇒ 不算同一事件。
 *   ⛔ 与旧实现的差别只有「脏值时不再直接判不命中」这一条 —— 正是它导致 10-22 误报首次退潮。
 * ★★ [CORE-CAT 2026-10-22] 认亲前两侧都归到【大类】：「文化传媒」与「AI应用」= 同一题材
 *   （⛔ 不归一 ⇒ 10-22 的近 20 日事件数从 2 掉成 0 ⇒ 又变成「首次退潮」）。
 * ★ [EBB-20D 2026-10-22] 窗口 = 近 EBB_EVENT_WINDOW_DAYS（20）个交易日。
 *   ★ 窗口口径由组合式注入 `windowFrom`（= 第 20 个交易日的日期）—— ⛔ 不用「history 里最后 20 条」
 *     来近似：退潮落库表是【按天写】的，没开看板的日子没有行（实测 20 个交易日只有 7 行）
 *     ⇒ 「最后 20 行」可能横跨 40 多个交易日，那样数出来的事件数会偏多（误判「无第三次」）。
 *   `windowFrom` 缺省 ⇒ 退回「按已有日期取最新 20 个」（§11 老调用方零行为变化）。
 */
export function _ebbPhaseOf(topic, name, history, coreRes, windowFrom) {
  const t0 = _normTopic(topic, coreRes);
  const n0 = String(name || '').trim();
  const all = (Array.isArray(history) ? history : []).filter(function(r) {
    return r && r.date && !!r.ebb;
  });
  // ── 窗口闸门 ──
  const from = String(windowFrom || '').trim();
  let rows;
  if (from) {
    rows = all.filter(function(r) { return String(r.date) >= from; });
  } else {
    const dateSet = new Set();
    all.forEach(function(r) { dateSet.add(String(r.date)); });
    const winSet = new Set(Array.from(dateSet).sort().slice(-EBB_EVENT_WINDOW_DAYS));
    rows = all.filter(function(r) { return winSet.has(String(r.date)); });
  }
  const hit = function(r) {
    const rt = _normTopic(r.leaderTopic, coreRes);
    if (t0 && rt) return _sameTopicLoose(rt, t0, coreRes);
    return String(r.leaderStock || '').trim() === n0 && !!n0;
  };
  // ⚠️ byDate 必须用【未截断】的 all：窗口第一天那行要看它的 prevDate 是否也在退潮（否则会把
  //   延续日误算成新事件）。prevDate 不在 rows 里 ⇒ 视作「不在退潮」⇒ 该行算新事件 —— 正确。
  const byDate = new Map();
  all.forEach(function(r) { byDate.set(String(r.date), r); });
  let count = 0;
  let lastDate = '';
  rows.forEach(function(r) {
    if (!hit(r)) return;
    const p = r.prevDate ? byDate.get(String(r.prevDate)) : null;
    if (p && hit(p)) return;   // 前一交易日同题材也在退潮 ⇒ 本次是延续，不是新事件
    count++;
    lastDate = String(r.date);
  });
  return { count: count, lastDate: lastDate };
}

/**
 * ★★ [EBB-D1 2026-10-21 用户口径] 【昨日二次确认退潮的题材】—— 次日禁入买点侧（第二十六条）。
 *
 * 用户原话：「主线题材如果昨天已经二次确认退潮了，次日就不要进入买点侧了，也就是说次日即使
 *   这个题材符合平均量比的条件，题材平均量比排名第二，也不应该买了，因为风险很高。其它题材可以。
 *   ……你把买点侧的主线题材入选的票的区域，变成灰色，不用去掉，其它题材不变。」
 * （10-21 实例：AI应用 10-20 二次确认退潮，10-21 它平均量比排第二、慈文传媒进了买点侧 ⇒ 不合理。）
 *
 * 为什么 detectEbbDay 自己答不了这道题：它带「首日闸门 + 无第三次」，昨日已是第二次退潮事件 ⇒
 *   今天必返 null（按平常日子选股）—— 这正是本规则的空档：题材退潮后的第二天，它以「平常题材」
 *   的身份混进买点侧。本函数补上这道闸。
 *
 * 「昨日那笔退潮是不是二次确认」怎么数（⛔ 与 _ebbPhaseOf 同一把尺子，§6 绝不另写一套）：
 *   ① 取【上一交易日】（prevDate，由组合式注入，规则层不碰日期工具）那一行：ebb=false / 无行 ⇒ null；
 *   ② 从昨日往回走【连续同题材退潮日】（事件 ≠ 天数：连续退潮合并成一次事件），找到事件起点 S；
 *   ③ 数 S 之前、同题材的退潮事件次数（_ebbPhaseOf）：恰好 1 次 ⇒ 昨日那笔 = 二次确认 ⇒ 返回题材；
 *     0 次（首次退潮）⇒ 不在本规则内（首次退潮次日本来就由首日闸门/当日判定处理，用户未要求禁入）；
 *     ≥2 次 ⇒ 无第三次 ⇒ 同样不适用。
 *
 * ⛔ 纯函数：只读 ebbHistory（组合式按展示日读回的 tvrb_ebb_days 近 12 行，已带 prevDate 链）。
 * ⛔ ebbHistory 缺省 / 没读到昨日行 ⇒ null（§10：判不出来 ≠ 昨天没退潮，绝不拿「没数据」当「没退潮」
 *    —— 反过来也不行：没有落库行就不禁入，宁可漏禁也不误禁，§11 与既有判定同一取舍）。
 *
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string,
 *          ebb:boolean}>|null} history 近 12 个交易日的退潮判定落库行
 * @param {string} prevDate 展示日的上一交易日（YYYY-MM-DD；组合式注入，⛔ 规则层不自算）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（与 detectEbbDay 同一把尺子）
 * @returns {{topic:string, leaderName:string, since:string}|null}
 *          topic = 昨日二次确认退潮的题材；since = 该次事件的起点日（留痕用）；判不出 ⇒ null
 */
export function secondEbbTopicOfPrevDay(history, prevDate, coreRes, windowFrom) {
  const pd = String(prevDate || '').trim();
  if (!pd || !Array.isArray(history)) return null;
  const rows = history.filter(function(r) { return r && r.date && !!r.ebb; });
  const byDate = new Map();
  rows.forEach(function(r) { byDate.set(String(r.date), r); });
  const y = byDate.get(pd);
  if (!y) return null;                       // 昨天没有退潮判定（或未退潮）⇒ 不禁
  // ★ [EBB-TOPIC-FIX 2026-10-22] 与 _ebbPhaseOf 同一把清洗尺子（纯数字 = 脏值 ⇒ 未知）
  // ★★ [CORE-CAT 2026-10-22] 再归到【大类】（文化传媒 ⇒ AI应用），否则「连续退潮日」在这里断链
  const topic = _normTopic(y.leaderTopic, coreRes);
  const name = String(y.leaderStock || '').trim();
  const hit = function(r) {
    const rt = _normTopic(r.leaderTopic, coreRes);
    if (topic && rt) return _sameTopicLoose(rt, topic, coreRes);
    return String(r.leaderStock || '').trim() === name && !!name;   // 与 _ebbPhaseOf 同一认亲退路
  };
  // ② 从昨日往回走连续同题材退潮日 ⇒ 事件起点（连续退潮日合并为一次事件）
  let start = y;
  for (;;) {
    const p = start.prevDate ? byDate.get(String(start.prevDate)) : null;
    if (p && hit(p)) { start = p; continue; }
    break;
  }
  // ③ 起点之前、同题材的退潮事件次数：恰好 1 ⇒ 昨日这笔是【二次确认】
  const earlier = rows.filter(function(r) { return String(r.date) < String(start.date); });
  const phase = _ebbPhaseOf(topic, name, earlier, coreRes, windowFrom);
  if (phase.count !== 1) return null;
  return { topic: topic, leaderName: name, since: String(start.date) };
}

/**
 * 【昨日同一只总龙的坏状态】—— 「首日」判据的取数收口（§6：判定与取数同处一处，只有这一份）。
 *
 * 用户口径（2026-10-14）：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，
 *   因为现在的逻辑是通过判断没有竞价量等判断出来的，是缓存吧？你要完善这点」
 * ⇒ 优先用【落库的判定】（tvrb_ebb_days 表里昨日那一行），行情行推断只作退路。
 *
 * @param {object} ebbCtx decision-collect#_ebbCtxOf 的返回（含 prevLeader 事实）
 * @param {object|null} prevEbbDay tvrb_ebb_days 里【上一交易日】那一行（{leader_stock, ebb}）
 * @param {string} leaderName 今日总龙名
 * @returns {{source:'table'|'inferred'|'unknown', bad:boolean, prevLeaderName:string, detail:string}}
 *          bad=true ⇒ 昨日同一只总龙已在坏状态 ⇒ 今天不是首日
 */
export function _prevLeaderDayState(ebbCtx, prevEbbDay, leaderName) {
  const rowName = prevEbbDay ? String(prevEbbDay.leader_stock || '').trim() : '';
  if (prevEbbDay && rowName) {
    // ① 落库判定：只认【同一只总龙】（昨天是别的票当总龙 ⇒ 对今天这只而言本来就是首日）
    if (rowName === leaderName) {
      return {
        source: 'table', bad: !!prevEbbDay.ebb, prevLeaderName: rowName,
        detail: '昨日（同一只总龙 ' + rowName + '）落库判定 = ' + (prevEbbDay.ebb ? '退潮' : '未退潮')
      };
    }
    return {
      source: 'table', bad: false, prevLeaderName: rowName,
      detail: '昨日总龙是【' + rowName + '】，与今日【' + leaderName + '】不是同一只 ⇒ 今日为首日'
    };
  }
  // ② 退路：用【库里昨日那一行】的竞价量 / 占比推断（量 0 ⇒ 无竞价 ⇒ 停牌语义）
  const pl = ebbCtx && ebbCtx.prevLeader;
  if (pl) {
    return {
      source: 'inferred', bad: !!pl.bad, prevLeaderName: leaderName,
      detail: '昨日落库判定缺失 ⇒ 用昨日行情行推断：竞价量 ' +
        (pl.volume === null ? '—' : pl.volume) + '、占比 ' + formatAuctionShare(_num(pl.share)) +
        ' ⇒ ' + (pl.bad ? '已在坏状态' : '状态正常')
    };
  }
  // ③ 两处都取不到 ⇒ 无法确认 ⇒ 按首日处理（用户拍板：取不到就按首日处理，继续提醒）
  return {
    source: 'unknown', bad: false, prevLeaderName: '',
    detail: '昨日状态两处都取不到 ⇒ 按【首日】处理（宁可多提醒一次）'
  };
}

/**
 * 【落库行】—— tvrb_ebb_days 一天一行的那份数据（§6：形状收口在这里，⛔ 写表的那一端不自己拼）。
 *
 * 为什么要落库（用户原话 2026-10-14）：「你应该把数据存起来啊，做一个表也行，不然很难判断出来，
 *   因为现在的逻辑是通过判断没有竞价量等判断出来的，是缓存吧？你要完善这点」
 * ⇒ 把每天算出的退潮【判定】存下来，次日判「是不是首日」直接读那一行（见 _prevLeaderDayState ①）。
 *
 * ⚠️ 它与 detectEbbDay 的返回值【不是一回事】：
 *   · detectEbbDay 返回的是【今天要不要按退潮处理】—— 带「首日闸门」，昨天已退潮 ⇒ 今天返回 null；
 *   · 本函数返回的是【今天这只总龙到底算不算处在坏状态】—— ❗不带首日闸门（那正是次日判首日的输入）。
 *   ⇒ 所以 `ebb = suspended || shareFail` 用的是判据 ①/② 的【原始结论】，
 *     与 detectEbbDay 里 `reason` 的算法逐字同源（§6 同一把尺子，⛔ 别写成两个条件）。
 *
 * ⚠️ 调用方必须在【当前展示日 = 今天】时才写（suspend 判定只对今天可信，见 suspend.js 红线）；
 *   历史日写进去会把「今天没停牌」当成「那天没停牌」⇒ 次日读回来直接判错首日。
 *
 * @param {object|null} ebb detectEbbDay 的返回（可为 null = 今天不退潮 / 不是首日）
 * @param {object|null} ebbCtx 采集层的【事实】（必须有 ready + leader）
 * @param {string} date 判定日 YYYY-MM-DD
 * @returns {object|null} 业务形状的行（键见 data/ebb-days.js 的 _normalize）；事实未就绪 ⇒ null（§10 不猜）
 */
export function buildEbbDayRecord(ebb, ebbCtx, date) {
  const d = String(date || '').trim();
  if (!d) return null;
  // §10：事实未就绪（昨涨幅未读回 / 一只票都排不出）⇒ ⛔ 绝不落一行「猜的」判定，明天会拿它判首日
  if (!ebbCtx || !ebbCtx.ready || !ebbCtx.leader) return null;
  const leader = ebbCtx.leader;
  const name = String(leader.name || '').trim();
  if (!name) return null;

  // ★★ [EBB-REC-FIX 2026-10-22] 门槛取档必须与 detectEbbDay 的判据②【逐字同源】：那边是
  //   `const leaderIsDragonOne = true`（总龙一 = 20日涨幅全市场第一 ⇒ 恒按龙头档 3.5% 判）。
  //   旧实现这里写的是「按它今日十日龙位取档」⇒ 总龙今日不是龙一（10-22 新华传媒十日口径是龙三）
  //   就落到 2% 档 ⇒ 落库行出现「share=2.0 但 share_fail=false」这种自相矛盾：
  //   同一天 detectEbbDay 判它占比不达标（真实意图），落库却说达标 ⇒ 次日读回判首日直接判错。
  //   🔴 这正是「同一件事两处取档不一致」的伴生缺陷（§6 同一把尺子）。
  const isDragonOne = true;
  const sh = _num(ebbCtx.leaderShare);
  const suspended = !!ebbCtx.leaderSuspended;
  // 与 detectEbbDay 的判据 ② 逐字同源：缺数据（sh === null）⇒ 不判不达标（§10：未知 ≠ 不达标）
  const shareFail = (sh !== null && !passesAuctionShare(sh, isDragonOne));

  return {
    date: d,
    leaderStock: name,
    // ★ [EBB-TOPIC-FIX 2026-10-22] 落库前同样清洗：⛔ 绝不再把「纯数字」（= 误取的成交量）当题材写进表，
    //   否则明天读回来又要靠 _normTopic 兜一次（错值不进库才是根治）。
    leaderTopic: _normTopic(leader.topic),
    leaderPct: _num(leader.pct),
    leaderRank: _num(leader.rank),
    suspended: suspended,
    share: sh,
    shareFail: shareFail,
    // ★ 原始结论（不带首日闸门）—— 次日判「昨天这只票是不是已经在坏状态」就读它
    ebb: !!(suspended || shareFail),
    // ⚠️ 买点侧替补只在【今天确实触发退潮规则】时才有意义（ebb === null ⇒ 不放）
    //   [EBB-R20] 起为 ≤2 只，落库格式 = 名字「、」连接（buy_second_pct = 第一只的 20日涨幅）
    buySecond: (ebb && Array.isArray(ebb.buyPickNames) && ebb.buyPickNames.length > 0)
      ? ebb.buyPickNames.join('、')
      : ((ebb && ebb.buySecondName) ? String(ebb.buySecondName) : ''),
    buySecondPct: (ebb && _num(ebb.buySecondPct) !== null) ? _num(ebb.buySecondPct) : null,
    source: 'tvrb-board'
  };
}