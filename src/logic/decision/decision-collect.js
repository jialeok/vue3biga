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
  SELL_TIME_MIDDAY,
  SELL_TIME_CLOSE
} from './decision-rules.js';

function _notReady(reason) {
  return {
    ready: false,
    reason: reason,
    topics: [],
    buy: { heavy: null, light: null, noYizi: null, smallTopic: null },
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

/**
 * 采集并计算某日的决策结论（同步：数据源全在内存里）。
 * @param {string} date 展示日 YYYY-MM-DD
 * @returns {{ready:boolean, reason:string, topics:Array, buy:object, sell:Array}}
 */
export function collectDecisionData(date) {
  if (!date) return _notReady('未选择日期');

  const prevDate = getPreviousTradingDay(date);
  const list = getTodayGroupList('auction', date) || [];
  if (list.length === 0) return _notReady('当日早盘竞价列表为空（数据可能尚未抓取）');

  // §10 闸门：题材【只数】是买入建议的核心依据（「股票数量n只」直接写进理由）。
  // 正式名单索引未就绪时 getTodayGroupList 会退化成原始列表（含观察组/影子行）→ 只数偏多 →
  // 可能把第 1 名题材判错、把不该买的票推成龙二。宁可不给建议，也不给错的建议。
  if (!_isAuctionWatchlistIndexReady(date)) return _notReady('当日正式名单尚未加载完成，暂不给建议');

  // 十日涨幅是「龙一/龙二」的唯一依据：没加载 ⇒ 无法给出买卖建议（§10 不拿空数据冒充结论）
  const rangeMap = getDragonRangePct(date);
  if (!rangeMap || rangeMap.size === 0) return _notReady('十日涨幅 / 龙头数据尚未加载完成');

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
  //   用户要求它们【也要计入买点决策】：9/8 第 1 名题材（大消费，2 个一字）的龙一是国芳集团，
  //   它是昨天评选出来的龙头、今天不在正式列表 → 早盘竞价画灰，但确实是同期龙头、有参考价值。
  //   ⛔ 只补【昨日龙头名册里的继承壳】：观察组 / 补一字的注入行噪声太大，用户没提，本次不加。
  //   countable=false ⇒ 不进题材数量 / 一字数统计（与早盘竞价统计条同口径）；
  //   inheritSold=false ⇒ 参与龙位与选票（真正被排除的是「昨日卖标签继承」的复盘行）。
  if (prevDragonMap) {
    Array.from(prevDragonMap.keys()).forEach(function(n) {
      const nm = String(n || '').trim();
      if (!nm || seen.has(nm)) return;
      const rm = rangeMap.get(nm);
      // §10：没有十日涨幅就排不进龙位，补进来只是噪声 → 不补
      if (!rm || rm.pct === null || rm.pct === undefined) return;
      if (inheritSold.has(nm)) return;               // 昨天已卖出 → 不补
      seen.add(nm);
      const meta = prevDragonMap.get(nm) || null;
      const raw = _dayRowMap.get(nm) || { stock: nm, code: (meta && meta.code) || '' };
      const row = _mkRow(nm, raw, false);
      rows.push(row);
      byName.set(nm, row);
    });
  }
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
  const buy = buildBuyPlan(topics, dragonMap, {
    ladderTopicGroups: ladder ? ladder.groups : [],
    ladderReady: ladder ? ladder.ready : false,
    ladderReason: ladder ? ladder.reason : ''
  });

  // 昨日龙头名册已在上方取过（prevDragonMap）—— 灰行补齐也要用它，⛔ 不重复取第二次。
  const prevDragonNames = prevDragonMap ? new Set(Array.from(prevDragonMap.keys())) : null;

  const prevBought = _prevBoughtNames(prevDate);
  const sellRows = [];
  prevBought.forEach(function(nm) {
    const row = byName.get(nm);
    // 今日不在列表里（继承过来的观察组票）也要给出卖出建议 —— 用户手上还拿着它
    sellRows.push({
      name: nm,
      topic: row ? row.topic : '',
      pct: row ? row.pct : null,
      inTodayList: !!row
    });
  });
  const sell = buildSellPlan(sellRows, topics, dragonMap, prevDragonNames);

  const sellTimes = [];
  sell.forEach(function(g) {
    g.items.forEach(function(it) {
      if (sellTimes.indexOf(it.sellAt) < 0) sellTimes.push(it.sellAt);
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
