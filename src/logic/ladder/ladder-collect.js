// ladder-collect.js — 「连板天梯晋级」看板的数据采集（Logic 层，§15 独立业务模块）
//
// 职责边界（§4）：本文件只做「读内存真相 → 组装成规则层要的 rows」，
//   ⛔ 不发请求、不写库、不消费猫抓额度、不做任何业务判断（判断全在 ladder-rules.js）。
//
// 【数据照搬，不另起一套】用户明确要求：跟着早盘竞价走，早盘/收盘都是同一份数据，只改显示层。
//   因此下面每一项都复用早盘竞价既有的唯一真相（§6）：
//   · 当日列表            → getTodayGroupList（= 早盘竞价渲染用的同一个函数）
//   · 连板数（二板/三板…）→ buildLimitStreakMapForDate（与早盘竞价行内灰标同源）
//   · 竞价涨幅            → auc_pct_chg + parseAucPct（与早盘竞价龙标底色同源）
//   · 竞价一字            → isAuctionYiZi
//   · 收盘涨停 / 跌停     → getCloseLimitState（与早盘竞价蚂蚁线同源）
//   · 是否已到收盘口径    → isAuthoritativeCloseReached（与早盘竞价 closeWindow 同源）
//   · 十日涨幅            → getDragonRangePct（与早盘竞价十日涨幅同源）
//   · 题材                → getPrimaryTopicMap / classifyStockPrimaryTopic（题材 toggle 同一套）
//
// §10 红线：数据没加载完 = 「还没拉到」，绝不等于「今天没有」。
//   未就绪时返回 ready=false + 明确的 reason，由 UI 如实展示（⛔ 不许显示成「空看板」）。

import { getTodayGroupList } from '../app-core-api.js';
import { buildLimitStreakMapForDate } from '../auction/limit-streak.js';
import { parseAucPct, isAuctionYiZi, getCloseLimitState } from '../auction/limit-up.js';
import { getDragonRangePct, isAuthoritativeCloseReached } from '../auction/dragon-rank.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic } from '../auction/topic-sort.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
import { groupByStreak, groupByTopicLadder, countLadder } from './ladder-rules.js';

function _notReady(reason) {
  return { ready: false, reason: reason, groups: [], topicGroups: [], total: 0, closeReady: false };
}

/**
 * 采集并计算某日的连板天梯（同步：数据源全在内存里，0 请求）。
 * @param {string} date 展示日 YYYY-MM-DD
 * @returns {{ready:boolean, reason:string, groups:Array, total:number, closeReady:boolean}}
 */
export function collectLadderData(date) {
  if (!date) return _notReady('未选择日期');

  const list = getTodayGroupList('auction', date) || [];
  if (list.length === 0) return _notReady('当日早盘竞价列表为空（数据可能尚未抓取）');

  // 连板数是本看板的【分档依据】：没加载 ⇒ 连「几板」都定不了，绝不能显示成「今天没有连板股」
  const streakMap = buildLimitStreakMapForDate(date);
  if (!streakMap || streakMap.size === 0) return _notReady('连板数据尚未加载完成（需要前一交易日的历史行）');

  // 与决策看板同一闸门：正式名单索引未就绪时列表会退化成原始行 → 数量/口径不可信
  if (!_isAuctionWatchlistIndexReady(date)) return _notReady('当日正式名单尚未加载完成');

  // 是否已到权威收盘口径（北京 16:05 后 / 历史日）→ 决定「晋级」是收盘说了算还是先按一字算
  const closeReady = isAuthoritativeCloseReached(date);

  // 十日涨幅（辅助列）：未加载时该列留空（§10 不补 0），不阻断整个看板
  const rangeMap = getDragonRangePct(date);
  const pmap = getPrimaryTopicMap(list);

  const rows = [];
  const seen = new Set();
  list.forEach(function(r) {
    if (!r || !r.stock) return;
    const nm = String(r.stock).trim();
    if (!nm || seen.has(nm)) return;
    const st = streakMap.get(nm);
    // §10：连板未知（T-1 没有这一行）→ 不进本看板，绝不当「趋势/首板」混进来
    if (!st || !st.streak) return;
    seen.add(nm);

    const code = r.code || getStockCode(nm) || '';
    const aucPct = parseAucPct(r.auc_pct_chg || r.aucPctChg);
    // 收盘口径未成立时，行内 change_pct 只是 9:25 竞价副本 —— 由 judgePromotion 的
    // closeReady=false 分支拦住，不会拿它冒充收盘结果（与早盘竞价 closeWindow 同一闸门）。
    const closePct = parseAucPct(r.change_pct || r.changePct);
    const rm = rangeMap ? rangeMap.get(nm) : null;

    rows.push({
      name: nm,
      code: code,
      streak: st.streak,
      topic: pmap.has(nm) ? pmap.get(nm) : classifyStockPrimaryTopic(r),
      aucPct: aucPct,
      isYiZi: isAuctionYiZi(r, code),
      closeLimit: closeReady ? getCloseLimitState(closePct, code, nm) : null,
      pct: (rm && rm.pct !== undefined && rm.pct !== null) ? rm.pct : null
    });
  });

  const groups = groupByStreak(rows, { closeReady: closeReady });
  // 「题材连扳」模式：同一批 rows 换个切法（按题材看梯队完整性），⛔ 不重新采数据、口径完全同源
  const topicGroups = groupByTopicLadder(rows, { closeReady: closeReady });
  return {
    ready: true,
    reason: '',
    date: date,
    groups: groups,
    topicGroups: topicGroups,
    total: countLadder(groups),
    closeReady: closeReady
  };
}
