// decision-collect.js — 「决策」看板的数据采集（Logic 层，§15 独立业务模块）
//
// 职责边界（§4）：本文件只做「读内存真相 → 组装成规则层要的 entries」，
//   ⛔ 不发请求、不写库、不消费猫抓额度、不做任何业务判断（判断全在 decision-rules.js）。
//
// 数据来源（§6 单一真相，全部复用早盘竞价既有口径，绝不另起一套）：
//   · 当日列表 + 题材        → getTodayGroupList / getPrimaryTopicMap / classifyStockPrimaryTopic
//   · 竞价一字               → isAuctionYiZi（limit-up.js，与早盘竞价行内红线同一判定）
//   · 十日涨幅 + 今日龙头排名 → getDragonRangePct / computeDragonRankMap（dragon-rank.js）
//   · 昨日龙头名册           → getDragonLeadersForDisplay（dragon-group.js，= 前一交易日评选出的龙头）
//   · 昨日「买」标签         → auctionTagStore（云端 auction_board_tags 的响应式镜像）
//   · 「昨日卖标签继承」剔除  → getPrevSoldInheritedSet（与早盘竞价统计/着色同一口径）
//
// §10 红线：数据没加载完 = 「还没拉到」，绝不等于「今天没有」。
//   未就绪时返回 ready=false + 明确的 reason，由 UI 如实展示（⛔ 不许显示成「空看板」）。

import { getTodayGroupList, getAuctionData } from '../app-core-api.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap } from '../auction/topic-sort.js';
import { isAuctionYiZi, parseAucPct } from '../auction/limit-up.js';
import { getDragonRangePct } from '../auction/dragon-rank.js';
import { getDragonLeadersForDisplay } from '../auction/dragon-group.js';
import { getPrevSoldInheritedSet } from '../auction/inherited-sold.js';
// [GRAY-DRAGON 2026-09-26] 灰行（不在当日正式列表的继承票）的观察组来源，与早盘竞价同款（§6）
import { getJingYestHighlightSetForDate } from '../auction/sort-rules.js';
import { _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
// [NO-YIZI 2026-09-25] 「全部题材竞价一字 0 个」的弱市兜底要读【连板天梯 · 题材连扳】的分组。
// ⛔ 直接复用 ladder-collect 的采集结果（0 请求、纯内存），而不是在这里另写一遍分组：
//    另写必然与天梯看板显示分叉 —— 用户是照着天梯看板的题材数去数的（§6 单一真相）。
import { collectLadderData } from '../ladder/ladder-collect.js';
import {
  rankDecisionTopics,
  rankDragons,
  isSmallRiskyTopic,
  buildBuyPlan,
  buildSellPlan,
  TOPIC_STREAK_WINDOW,
  SELL_TIME_MIDDAY,
  SELL_TIME_CLOSE
} from './decision-rules.js';
// [VRATIO-TREND 2026-10-01 用户口径] 「竞价量比（auc_vol_ratio）近 5 日」的取数与展示视图。
//   为什么挂在这一层而不是 decision-rules：规则文件是【纯函数】（不读 state），
//   而竞价量比要读内存真相（Data 层只读选择器）—— 本文件正是「读内存真相」的地方（§4）。
//   ⛔ 只是把已算好的字段挂到 pick / item 上，不做任何业务判断（判断仍全在 decision-rules）。
import {
  VOL_RATIO_TREND_DAYS,
  decorateVolRatioFields
} from './vol-ratio-trend.js';

function _notReady(reason) {
  return {
    ready: false,
    reason: reason,
    topics: [],
    buy: { heavy: null, light: null, noYizi: null, smallTopic: null, bigTopic: null },
    sell: [],
    sellTimes: []
  };
}

/**
 * 「连板天梯 · 题材连扳」的分组（只在【全部题材竞价一字 = 0】时才需要，懒采集）。
 * §10：采集失败 / 未就绪必须原样上报，绝不能退化成「今天没有连板梯队」。
 */
function _ladderTopicGroups(date) {
  try {
    const d = collectLadderData(date);
    return { ready: !!d.ready, groups: d.topicGroups || [], reason: d.ready ? '' : (d.reason || '') };
  } catch (e) {
    return { ready: false, groups: [], reason: (e && e.message) ? e.message : '连板天梯计算失败' };
  }
}

/** 昨日打过「买」标签的股票名集合（标签只继承一天，所以只看【前一日】） */
function _prevBoughtNames(prevDate) {
  const out = new Set();
  if (!prevDate) return out;
  try {
    const tags = useAuctionTagStore().tags || {};
    const dayTags = tags[prevDate] || {};
    Object.keys(dayTags).forEach(function(n) {
      if (dayTags[n] !== 'buy') return;
      const nm = String(n || '').trim();
      if (nm) out.add(nm);
    });
  } catch (e) {
    // 标签库没加载 → 返回空集（由上层 ready 判定处理，绝不抛给渲染层）
  }
  return out;
}

/** 从买点方案里抽出全部股票名（heavy / light / 各兜底方案的 blocks 都算「买点列表」） */
function _buyPlanNames(buy) {
  const out = new Set();
  if (!buy) return out;
  ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic'].forEach(function(k) {
    const b = buy[k];
    if (!b) return;
    (b.picks || []).forEach(function(p) { if (p && p.name) out.add(p.name); });
    (b.blocks || []).forEach(function(bb) {
      (bb.picks || []).forEach(function(p) { if (p && p.name) out.add(p.name); });
    });
  });
  return out;
}

/**
 * [VRATIO-TREND 2026-10-01 用户口径] 给买点 / 卖点的每一行挂上「竞价量比（auc_vol_ratio）」：
 *   · `volRatioText`     行内徽标文案（如「量比 2.18」；缺值 → 空串 ⇒ 模板不渲染，§10）
 *   · `volRatioTrend`    近 5 个交易日的点集（喂 TrendChart，点开行才画）
 *   · `volRatioHasData`  有无有效点（false ⇒ 模板画一行「暂无数据」，⛔ 不画满屏 '--'）
 *
 * 为什么在这里收口（而不是在 decision-rules 里逐处构造）：
 *   · 规则文件是纯函数、不许读 state；竞价量比必须读内存真相（Data 层只读选择器）；
 *   · 买点有 5 个档（heavy/light + noYizi/smallTopic/bigTopic 的 blocks）、卖点有 N 组，
 *     若在每个构造点各补一次，日后加档位必漏 —— 这里【一处遍历收口】，与 _buyPlanNames 同一范式。
 *
 * ⛔ 只挂展示字段，不改任何选票结论；⛔ 不发请求（近 30 自然日已在内存缓存里，§32）。
 *
 * @param {object} buy  buildBuyPlan 的返回
 * @param {Array} sell  buildSellPlan 的返回
 * @param {string} date 展示日（= 决策看板当前日期）
 */
function _decorateVolRatioTrend(buy, sell, date) {
  if (!date) return;
  if (buy) {
    ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic'].forEach(function(k) {
      const b = buy[k];
      if (!b) return;
      (b.picks || []).forEach(function(p) { decorateVolRatioFields(p, date, VOL_RATIO_TREND_DAYS); });
      (b.blocks || []).forEach(function(bb) {
        (bb.picks || []).forEach(function(p) { decorateVolRatioFields(p, date, VOL_RATIO_TREND_DAYS); });
      });
    });
  }
  (sell || []).forEach(function(g) {
    (g.items || []).forEach(function(it) { decorateVolRatioFields(it, date, VOL_RATIO_TREND_DAYS); });
  });
}

/**
 * 【三 · 持有 / 加仓】上一交易日的【买点】股票名集合。
 *
 * ⛔ 复用本文件自己的采集再算一遍前一天的决策，而不是另写一套「昨天买了什么」的规则（§6 单一真相）：
 *    另写必然与买点规则分叉，分叉就会出现「昨天明明选了它，今天却没标持有」。
 * ⛔ 只往回追【一层】（skipPrevBuy=true）：否则每天都要顺着交易日往前追整条链（§36 性能红线）。
 *
 * @param {string} prevDate 上一交易日
 * @returns {Set<string>|null} null = 昨天的买点没算出来（§10：未知 ≠ 昨天一只都没选）
 */
function _prevBuyNames(prevDate) {
  if (!prevDate) return null;
  try {
    const d = collectDecisionData(prevDate, { skipPrevBuy: true });
    if (!d || !d.ready || !d.buy) return null;
    return _buyPlanNames(d.buy);
  } catch (e) {
    // §10：算不出来 = 未知（null），⛔ 绝不退化成空 Set（那会被理解成「昨天一只都没选」）
    console.warn('[DECISION] 上一交易日买点计算失败，【持有 / 加仓】标记按未知处理', e);
    return null;
  }
}

/**
 * 【⑫ 题材级 · 昨有买入】昨天买过的票【今天】落在哪些题材里。
 *
 * ⚠️ 用【今日的题材归属】（byName 里的 topic）而不是昨天的题材名：看板显示的是今天的题材块，
 *    标签表达的是「今天这个题材在延续」，用同一份映射才不会出现「标签挂在一个今天不存在的题材上」。
 *    与 _mkRow 的题材口径完全同源（§6）。
 * §10：byName 缺人（今天不在任何池里）→ 该股不参与聚合；这不影响其它股票。
 *
 * @param {Set<string>} prevBought 上一交易日打过「买」标签的股票名集合
 * @param {Map<string,object>} byName 今日 股票名 → 行（含 topic）
 * @returns {Set<string>} 含「昨天有票买过」的题材名集合
 */
function _prevBoughtTopics(prevBought, byName) {
  const out = new Set();
  if (!prevBought || !byName) return out;
  prevBought.forEach(function(nm) {
    const row = byName.get(nm);
    const t = row ? String(row.topic || '').trim() : '';
    if (t) out.add(t);
  });
  return out;
}

/**
 * 一个买点方案里【全部买点块】的题材名集合。
 *
 * [STREAK-ALL-BLOCKS 2026-09-30 用户口径修正] ⛔ 不要再收窄成「只取 heavy / light」：
 *   计数范围必须与【展示范围】一致。上一版只取重仓 / 轻仓，结果 9/30 当天第 1/第 2 名题材
 *   都是「票少 + 1 个一字」的高风险小题材 ⇒ 买点全部落在 ⑥ 兜底方案 ⇒
 *   Ⓒ 入选次数整块看板一个都不显示（用户实测反馈，已用真实数据 100% 复现）。
 *   现在覆盖 5 个买点槽位：heavy / light / noYizi⑤ / smallTopic⑥ / bigTopic。
 *   —— 卖点侧【不在口径内】（卖点候选本来就是「昨天买过的票」，计入会把所有题材刷满、无区分度）。
 *
 * @param {object} buy buildBuyPlan 的返回值
 * @returns {Set<string>} 该日买点里出现过的题材名（一天最多算一次，Set 天然去重）
 */
function _buyPointTopics(buy) {
  const out = new Set();
  if (!buy) return out;
  const _add = function(b) {
    if (!b) return;
    const t = b.block ? String(b.block.topic || '').trim() : '';
    if (t) out.add(t);
    (b.blocks || []).forEach(function(bb) {
      const tt = (bb && bb.block) ? String(bb.block.topic || '').trim() : '';
      if (tt) out.add(tt);
    });
  };
  ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic'].forEach(function(k) { _add(buy[k]); });
  return out;
}

/**
 * 【⑬ 题材入选次数】过去（不含今日）窗口内——含今日共 TOPIC_STREAK_WINDOW 天 ——
 * 每个题材进入【买点】的【天数】（同一题材一天最多算 1 次）。
 *
 * 实现口径（用户 2026-09-30 已确认）：窗口含今日；数【全部买点块】（重仓 / 轻仓 /
 * 弱市兜底⑤ / 小题材兜底⑥ / 大题材兜底）——见 _buyPointTopics 的口径修正注释。
 *
 * ⚠️ 成本与 §36：这里要沿着交易日往回重算 4 天（今天的这一次由主流程自己算）。
 *    每次重算是【纯内存组装】（无请求、不写库、不消费额度），且：
 *    ① 只在【非 skipPrevBuy】的主流程里跑一次 ⇒ 内部递归不会再往下展开（否则指数爆炸）；
 *    ② 只在买点方案真有必要（下面直接挂在 buildBuyPlan 之前）时才跑。
 *    ⛔ 不要给它加「递归调用 collectDecisionData」的能力 —— 那正是 ① 要防的。
 *
 * §10 红线：窗口里【任意一天】算不出来（那天的列表 / 正式名单索引还没加载）⇒ 返回 null = 未知。
 *    ⛔ 绝不返回一个「偏低的次数」—— 用户是拿它判题材频率的，少算一次就会误判。
 *
 * @param {string} date 展示日
 * @returns {Map<string,number>|null} 题材名 → 过去窗口内入选天数（不含今日）；null = 未知
 */
function _topicStreakPast(date) {
  if (!date) return null;
  const days = [];
  let d = date;
  for (let i = 0; i < TOPIC_STREAK_WINDOW - 1; i++) {
    d = getPreviousTradingDay(d);
    if (!d) break;
    days.push(d);
  }
  if (days.length < TOPIC_STREAK_WINDOW - 1) return null;   // 交易日历不完整 ⇒ 窗口不完整

  const counts = new Map();
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    let set = null;
    try {
      // rangeOptional：历史日拿不到十日涨幅，但题材归属不需要它（见 collectDecisionData 的闸门注释）
      const rec = collectDecisionData(day, { skipPrevBuy: true, rangeOptional: true });
      if (rec && rec.ready && rec.buy) set = _buyPointTopics(rec.buy);
    } catch (e) {
      console.warn('[DECISION] 题材入选次数：' + day + ' 重算失败 → 次数按未知处理', e);
      set = null;
    }
    if (!set) return null;                                  // §10：任一天未知 ⇒ 整体未知
    set.forEach(function(t) { counts.set(t, (counts.get(t) || 0) + 1); });
  }
  return counts;
}

/**
 * 采集并计算某日的决策结论（同步：数据源全在内存里）。
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {{skipPrevBuy?:boolean, rangeOptional?:boolean}} [opts]
 *        skipPrevBuy=true → 不往回算上一交易日的买点（内部递归用，防止无限往前追）
 *        rangeOptional=true → 【十日涨幅没加载也继续算】（§10 的例外，见下方闸门注释）。
 *          只给「近 5 个交易日题材入选次数」的历史日重算用；⛔ UI 展示日【绝不要】传它 ——
 *          那样会拿一份没有涨幅的数据去给出买卖点，等于 §10 红线。
 * @returns {{ready:boolean, reason:string, topics:Array, buy:object, sell:Array}}
 */
export function collectDecisionData(date, opts) {
  const skipPrevBuy = !!(opts && opts.skipPrevBuy);
  const rangeOptional = !!(opts && opts.rangeOptional);
  if (!date) return _notReady('未选择日期');

  const prevDate = getPreviousTradingDay(date);
  const list = getTodayGroupList('auction', date) || [];
  if (list.length === 0) return _notReady('当日早盘竞价列表为空（数据可能尚未抓取）');

  // §10 闸门：题材【只数】是买入建议的核心依据（「股票数量n只」直接写进理由）。
  // 正式名单索引未就绪时 getTodayGroupList 会退化成原始列表（含观察组/影子行）→ 只数偏多 →
  // 可能把第 1 名题材判错、把不该买的票推成龙二。宁可不给建议，也不给错的建议。
  if (!_isAuctionWatchlistIndexReady(date)) return _notReady('当日正式名单尚未加载完成，暂不给建议');

  // 十日涨幅是「龙一/龙二」的唯一依据：没加载 ⇒ 无法给出买卖建议（§10 不拿空数据冒充结论）
  //
  // [TOPIC-STREAK 2026-09-30] rangeOptional 的正当性（唯一的例外场景）：
  //   「近 5 个交易日题材入选次数」要对【历史日】重算买点，但 getDragonRangePct 只持有一个日期
  //   （dragonState.date === 当前展示日）⇒ 历史日必然拿不到涨幅 ⇒ 一律 _notReady ⇒ 功能没法做。
  //   而【题材归属 / 名次 / 一字数】完全不需要涨幅（rankDecisionTopics 只看 name/topic/isYizi/countable），
  //   涨幅只影响【题材内部选哪只票】（龙一 / 龙二）与 ⑨ 双主线的高开率比较 —— 都不改变
  //   「哪个题材进了买点」这个结论。因此只取 heavy / light 的题材名时，涨幅缺失不影响正确性。
  //   ⚠️ 代价：rangeOptional 下灰行（观察组继承票，需有十日涨幅才纳入）会被统一排除；
  //      灰行 countable=false，本来就不进题材只数，故对题材结论无影响（见 _mkRow / 灰行注释）。
  let rangeMap = getDragonRangePct(date);
  if (!rangeMap || rangeMap.size === 0) {
    if (!rangeOptional) return _notReady('十日涨幅 / 龙头数据尚未加载完成');
    rangeMap = new Map();
  }

  const inheritSold = getPrevSoldInheritedSet(date, prevDate);
  const pmap = getPrimaryTopicMap(list);
  // [MAJORITY-SIDE 2026-09-24] 兜底行（不在正式列表内的注入行）也遵守「站队到数量多的一边」
  const psize = buildTopicSizeMap(pmap);

  // 昨日龙头名册（= 前一交易日评选出的龙头）：Map<name,{topic,pct,groupSize,code}>
  // ⛔ 未加载时【传 null】而不是空 Set：空 Set 会让规则层把「还没拉到」判定成「昨日非龙头」（§10）。
  // [GRAY-DRAGON 2026-09-26] 提前到这里：它同时还是【灰行】的来源（见下方 _pushGrayRows）。
  const prevDragonMap = getDragonLeadersForDisplay(date);

  // [GRAY-DRAGON 2026-09-26] 当日已抓到数据的行（含 market_metrics 影子行）→ 给灰行回填真实竞价涨幅。
  // 与早盘竞价 view-helpers 的 _auctionDayRowMap 同一份数据来源（§6），⛔ 不另找一份。
  const _dayRowMap = new Map();
  try {
    (getAuctionData()[date] || []).forEach(function(r) {
      if (r && r.stock) {
        const k = String(r.stock).trim();
        if (k && !_dayRowMap.has(k)) _dayRowMap.set(k, r);
      }
    });
  } catch (e) {
    // §10：取不到就按「没有回填」处理（灰行竞价涨幅 = null），绝不抛给渲染层
  }

  const rows = [];
  const byName = new Map();
  const seen = new Set();

  /** 组装一行（正式列表行 / 灰行共用，保证口径一致） */
  const _mkRow = function(nm, raw, countable) {
    const code = (raw && (raw.code || raw.stockCode)) || getStockCode(nm) || '';
    const topic = pmap.has(nm) ? pmap.get(nm) : classifyStockPrimaryTopic(raw || { stock: nm }, psize);
    const rm = rangeMap.get(nm);
    return {
      name: nm,
      topic: String(topic || '').trim(),
      code: String(code || '').trim(),
      isYizi: isAuctionYiZi(raw || { stock: nm }, code),
      // 当日竞价涨幅（%）：null = 缺数据。解析器复用 limit-up.js#parseAucPct（§6 单一实现），
      // 与早盘竞价「龙标红底 = 竞价涨幅>0」完全是同一个值 —— 决策看板说的是「买红色的那几只」。
      aucPct: parseAucPct(raw ? (raw.auc_pct_chg || raw.aucPctChg) : null),
      pct: (rm && rm.pct !== undefined && rm.pct !== null) ? rm.pct : null,
      countable: countable,
      inheritSold: inheritSold.has(nm)
    };
  };

  list.forEach(function(r) {
    if (!r || !r.stock) return;
    const nm = String(r.stock).trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    const row = _mkRow(nm, r, !inheritSold.has(nm));
    rows.push(row);
    byName.set(nm, row);
  });

  // [GRAY-DRAGON 2026-09-26] 灰行 = 早盘竞价里「灰色名称 + 灰色题材」的行 = 【不在当日正式列表】。
  //   用户（两次）要求：灰行也要能进买点 —— 它们代表的是【老龙 / 观察组继承票】，有参考价值。
  //   事故现场：9/8 第 1 名题材大消费的龙一 = 国芳集团（灰），第 2 名题材农业的龙一 = 万向德农（灰）。
  //
  //   ⛔ 上一版只补了【昨日龙头名册】一个来源，覆盖不到观察组继承票（万向德农就属于这一类）→ 没修全。
  //      本次改成与 view-helpers#computeAuctionViewData 的注入行【三个来源完全同源】（§6 单一真相）：
  //        ① 前一日「竞昨高光」继承票（观察组主来源）  getJingYestHighlightSetForDate(prevDate)
  //        ② 前一日打标签买入继承票                    obsBought_<date>
  //        ③ 昨日龙头名册继承壳                        getDragonLeadersForDisplay(date)
  //      这与 dragon-group.js#_buildPool 的候选池口径也是同一套（只是它没导出，故在此按同一顺序复刻）。
  //
  //   countable=false ⇒ 不进题材数量 / 一字数统计（与早盘竞价统计条同口径）；
  //   龙位与选票【不因任何灰行身份而排除】—— 连「昨日卖标签继承」的行也照常参与
  //   （2026-09-27 修正：9/8 大消费龙一国芳集团就是「灰名 + 灰题材 + 灰色实心卖标签」，用户要它入选）。
  const _grayNames = new Set();
  try {
    const obs = prevDate ? getJingYestHighlightSetForDate(prevDate, 'auction') : null;
    if (obs && typeof obs.forEach === 'function') {
      obs.forEach(function(n) { if (n) _grayNames.add(String(n).trim()); });
    }
  } catch (e) {
    // §10：读失败 ≠ 空集合。这里只影响灰行的【补充来源】，主池仍可用，故如实记日志不静默吞掉。
    console.warn('[DECISION] 竞昨高光继承集读取失败，灰行来源缺失该部分', e);
  }
  try {
    // 合规（§8）：obsBought_<date> 是「防重复 / 调试标记」型本地缓存，与 view-helpers 同源；
    // 它不是业务真相源（业务真相 = auctionTagStore），仅用于还原观察组继承池。
    const bought = JSON.parse(localStorage.getItem('obsBought_' + date) || '[]');
    (bought || []).forEach(function(n) { if (n) _grayNames.add(String(n).trim()); });
  } catch (e) { /* 无 localStorage / 解析失败 → 忽略该来源，不影响主池 */ }
  if (prevDragonMap) {
    Array.from(prevDragonMap.keys()).forEach(function(n) {
      if (n) _grayNames.add(String(n).trim());
    });
  }

  _grayNames.forEach(function(n) {
    const nm = String(n || '').trim();
    if (!nm || seen.has(nm)) return;                // 已在正式列表里 → 不是灰行
    const rm = rangeMap.get(nm);
    // §10：没有十日涨幅就排不进龙位，补进来只是噪声 → 不补
    if (!rm || rm.pct === null || rm.pct === undefined) return;
    // ⛔ 不再因「昨日卖标签继承」跳过（09-27 用户口径：这类灰行也要能入选买点）
    seen.add(nm);
    const meta = prevDragonMap ? prevDragonMap.get(nm) : null;
    const raw = _dayRowMap.get(nm) || { stock: nm, code: (meta && meta.code) || '' };
    const row = _mkRow(nm, raw, false);
    rows.push(row);
    byName.set(nm, row);
  });
  if (rows.length === 0) return _notReady('当日列表没有可用于决策的股票名');

  const topics = rankDecisionTopics(rows);
  if (topics.length === 0) return _notReady('当日没有成组的题材（题材至少 2 只才成组）');

  const dragonMap = rankDragons(topics);

  // [NO-YIZI 2026-09-25] 只有下面两种情况才去采连板天梯分组（两条兜底规则要用）：
  //   ① 「全部题材竞价一字 = 0」的弱市兜底；
  //   ② [SMALL-TOPIC] 第 1 / 第 2 名题材是「票太少 + 有 1~2 个一字」的高风险小题材。
  // 平时不采 —— 白跑一次全量行的归堆没意义（§36 性能红线）。
  const first = topics.find(function(b) { return b.rank === 1; }) || null;
  const second = topics.find(function(b) { return b.rank === 2; }) || null;
  const totalYizi = topics.reduce(function(n, b) { return n + (Number(b.yiziCount) || 0); }, 0);
  // ③ [LADDER-VS-SECOND 2026-09-26] 第 2 名题材【只有 1 个一字】时要跟「题材连扳数量第一」比数量
  const needLadder = totalYizi === 0
    || isSmallRiskyTopic(first) || isSmallRiskyTopic(second)
    || (second && Number(second.yiziCount) === 1);
  const ladder = needLadder ? _ladderTopicGroups(date) : null;
  // 【三 · 持有 / 加仓】上一交易日的买点股票名（null = 未知 → 规则层一律不标，§10 不猜）
  const prevBuyNames = skipPrevBuy ? null : _prevBuyNames(prevDate);
  // 【⑫ 昨天已买】上一交易日【实际】打过「买」标签的股票名（§6：与卖点候选同一份数据源）。
  //   ⛔ 股票级判据，逐只比名字（2026-09-30 修正：上一版按题材判，会把整块都标上，误导）。
  //   在 buildBuyPlan 之前取：买点与卖点两边都要用它（一次采集、两处复用）。
  const prevBought = _prevBoughtNames(prevDate);
  // 【⑫ 题材级 · 昨有买入】把上面这批股票【按今日题材】聚合（题材行标【昨有买入】）。
  //   与上一行的股票级判据共用同一份 prevBought（§6：一处采集、两处复用，不会分叉）。
  const prevBoughtTopics = _prevBoughtTopics(prevBought, byName);
  // 【⑬ 题材入选次数】过去（不含今日）4 个交易日里每个题材进过买点几次；null = 窗口内有历史日未知。
  //   ⛔ 只在主流程算：内部递归调用一律带 skipPrevBuy=true ⇒ topicStreakPast 恒为 null ⇒
  //      不会再往下展开（否则 _topicStreakPast → collectDecisionData → _topicStreakPast … 指数爆炸）。
  const topicStreakPast = skipPrevBuy ? null : _topicStreakPast(date);
  const buy = buildBuyPlan(topics, dragonMap, {
    ladderTopicGroups: ladder ? ladder.groups : [],
    ladderReady: ladder ? ladder.ready : false,
    ladderReason: ladder ? ladder.reason : '',
    prevBuyNames: prevBuyNames,
    prevBoughtNames: prevBought,
    prevBoughtTopics: prevBoughtTopics,
    topicStreakPast: topicStreakPast
  });

  // 昨日龙头名册已在上方取过（prevDragonMap）—— 灰行补齐也要用它，⛔ 不重复取第二次。
  const prevDragonNames = prevDragonMap ? new Set(Array.from(prevDragonMap.keys())) : null;

  const sellRows = [];
  prevBought.forEach(function(nm) {
    const row = byName.get(nm);
    // 今日不在列表里（继承过来的观察组票）也要给出卖出建议 —— 用户手上还拿着它
    sellRows.push({
      name: nm,
      topic: row ? row.topic : '',
      pct: row ? row.pct : null,
      // [SELL-OPEN 2026-09-29] 今日竞价涨幅：卖点【细分提示】的唯一依据
      //   （深低开盯盘 / 小低开立刻出 / 小幅高开看分时）。row 不存在（今天不在任何池里）→ null，
      //   规则层按「缺数据」处理，回落原题材排名时点（§10 不猜方向）。
      aucPct: row ? row.aucPct : null,
      inTodayList: !!row
    });
  });
  // 【三 · 持有 / 加仓（卖点侧）】今天又在买点里的卖点候选 = 连续两天被选中 = 强势股，标【持有 / 加仓】
  const todayBuyNames = _buyPlanNames(buy);
  const sell = buildSellPlan(sellRows, topics, dragonMap, prevDragonNames, todayBuyNames);

  // [VRATIO-TREND 2026-10-01 用户口径] 给买点 / 卖点的每一行挂【竞价量比】的当日数值 + 近 5 日走势。
  //   ⛔ skipPrevBuy（内部递归算历史日买点，只为了拿题材名 / 股票名）不挂：
  //      那些结果不进 UI，挂了纯属白算（§36 不做无意义的重复计算）。
  if (!skipPrevBuy) _decorateVolRatioTrend(buy, sell, date);

  // [PREV-BOUGHT 2026-09-30 用户口径，同日两次修正] 「昨天买过」这件事现在有【两个】落点：
  //   · 题材行【昨有买入】(block.prevBoughtTag)：题材里【有】票昨天被打过「买」标签 ⇒ 题材在延续。
  //     判据 = prevBoughtTopics（本文件按【今日题材】把 prevBought 聚合出来，见 _prevBoughtTopics）。
  //   · 股票行【加仓】(pick.position)：这一只昨天真买过（判据 = prevBought，规则层逐只比名字）。
  //     ⛔ 股票行【不再】显示任何「昨天已买」徽标（上一版在这里，用户反馈会被读成个股结论）。
  //   · 卖点侧一律不标：卖点候选本来就是「昨天打过买标签的股票」，标了等于全标，没有信息量。
  //   三条都在规则层收口（§21 模板零计算），UI 直接读上述字段。

  const sellTimes = [];
  sell.forEach(function(g) {
    g.items.forEach(function(it) {
      // [SELL-OPEN 2026-09-29] 命中竞价高低开三档的行，时点以 sellHint.timeLabel 为准
      //（如「盯盘 · 10:00 前」「开盘立刻出」），未命中才用题材排名的 sellAt。
      const t = (it.sellHint && it.sellHint.timeLabel) ? it.sellHint.timeLabel : it.sellAt;
      if (sellTimes.indexOf(t) < 0) sellTimes.push(t);
    });
  });
  sellTimes.sort();

  return {
    ready: true,
    reason: '',
    date: date,
    prevDate: prevDate,
    topics: topics,
    buy: buy,
    sell: sell,
    sellTimes: sellTimes,
    // 规则面板要用到的常量（UI 不硬编码时间点，避免与规则层分叉）
    times: { midday: SELL_TIME_MIDDAY, close: SELL_TIME_CLOSE }
  };
}
