import { getTodayGroupList, getGroupData, getAuctionData } from '../app-core-api.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
// 注：getDigitCount / getNumericVolume 原为「环比」旧口径（今/昨比 + 位数差）服务，
// 2026-09-05 环比重构为「量比抢筹」后已无引用，故从 import 中移除（避免 dead code）。
import { getHighRatioStocksForDate, getParallelStocksForDate, getJingYestHighlightSetForDate, getRatioDiffInfoForDate } from './sort-rules.js';
import { ensureBoughtStocksForDate, ensureObservationStocks, deriveAuctionTagState, _buildTagStateCache } from '../tagTitles/rules.js';
import { getThreeDayJingDieSet, getWeakStrongSet, getWeakStrongTurnSet, getVolGrabSet } from './sort-rules-extra.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { _getAuctionWatchlistSet, _isAuctionFormalMember } from '../../data/watchlist-and-metrics.js';
import { state } from '../app-state.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
import { getAuctionTagState } from '../ui-bridge.js';
import { getDisplayNote } from '../note/helpers.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getStockTopicCount, getStockTopicsDisplay, getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap, sortByTopicGroups, buildTopicColorMap } from './topic-sort.js';
// [YIZI 2026-09-09] 竞价一字（竞价涨停）：行级红线标记 + 题材组间排序权重，单一真相在 limit-up.js。
// [CLOSE-LIMIT 2026-09-11] 同模块新增 getCloseLimitState：收盘涨停/跌停（蚂蚁线标记 + 题材统计）。
// [CLOSE-NAME-COLOR 2026-09-11] 同模块新增 getCloseNameTone：收盘涨幅 → 股票名字体颜色档位。
import { isAuctionYiZi, parseAucPct, getCloseLimitState, getCloseNameTone, isHighLimitBoard } from './limit-up.js';
// [LIMIT-STREAK 2026-09-11] 趋势/连板标记（趋势 / 首板 / 二板 / 三板…）：只看【当天之前】的
// 历史交易日收盘涨幅，逐日回看数连续涨停。判定单一真相在 limit-streak.js（纯函数），
// 数据取内存已存的逐日 change_pct（首屏已整段拉入）→ 0 网络请求、0 猫抓额度。
// [LADDER 2026-09-24] 「按日期取连板映射」搬到 limit-streak.js 并导出：早盘竞价与「连板天梯」看板
// 共用同一份口径（§6）。此前它是本文件的私有函数 _buildLimitStreakMap，复制一份必然分叉。
import { buildLimitStreakMapForDate } from './limit-streak.js';
// [CLOSE-COUNT 2026-09-11] 「收盘口径」判定：题材统计条的收盘红绿/停板、行级收盘停板标记
// 只在收盘【权威口径】下才成立 —— 早盘（乃至 15:00~16:00 之间）的 change_pct 还可能是
// 9:25 写入的竞价副本，用它数红绿会把竞价方向当成收盘结果。
// 判定复用 dragon-rank 的单一真相 isAuthoritativeCloseReached（北京 16:05），不另写一份时间逻辑（§6）。
import { getDragonRangePct, computeDragonRankMap, isAuthoritativeCloseReached } from './dragon-rank.js';
// [DRAGON 2026-09-09] 题材龙头（龙一/龙二…）：区间涨幅状态由 dragon-rank.js 异步加载后经模块级 ref 暴露，
// 此处同步读取（与 weakStrongSetRef 同款 ref-driven 范式），题材 toggle 开启时才参与计算。
// [TOPIC-STATS 2026-09-10] 题材块统计条（数量/一字/竞价高开/龙头…）：纯函数在 topic-stats.js
import { buildTopicStatsMap } from './topic-stats.js';
// [DRAGON-GROUP 2026-09-14] 龙头组（第一页【观察组上方】的独立区块）：名册由 logic/auction/dragon-group.js
// 异步加载后经模块级 ref 暴露，此处【同步读取】（与 dragon-rank 同款 ref-driven 范式，绝不阻塞渲染）。
// 名册是唯一真相（§6）：本文件只负责「读名册 → 注入空壳行 → 给出 dragonIndices → 观察组去重」，
// 绝不在这里二次评选龙头（那样就是第二个真相源）。
import { getDragonLeadersForDisplay } from './dragon-group.js';
// [INHERIT-SELL 2026-09-23] 「昨日『卖』标签继承过来的复盘行」判定抽成独立模块：
// view-helpers（当天统计 + 着色）与 topic-trend（五日趋势）共用同一份判据（§6 单一真相）。
import { getPrevSoldInheritedSet } from './inherited-sold.js';

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
  return useAuctionTagStore().getTagState(date, stockName);
}

// ===== 三天竞跌独立逻辑（仅「连跌三天」toggle 开启时生效，与其它高光/排序逻辑完全隔离）=====
// 资格条件：连续竞跌天数 dd≥2（getThreeDayJingDieSet，基于「竞价量」递减，与涨幅无关）
// 排序：达标(dd≥2)整体置顶；同档内按「当天竞价涨幅」由高到低
// 绿色高光：dd≥2 且 当天竞价涨幅 ≥ 0（止跌/企稳/反转）才点亮；下跌中继(竞价涨幅<0)不点亮
// 竞价涨幅取值：专用字段 auc_pct_chg（五日竞价涨幅），绝不读 changePct/change_pct ——
//   后者会被「获取涨幅」(fuyao 快照 price_change_ratio_pct) 改写为当日常规涨幅，导致误判。
function _getThreeDayAuctionPct(rawItem) {
  if (!rawItem) return null;
  const raw = rawItem.auc_pct_chg || rawItem.aucPctChg || rawItem.changePct || rawItem.change_pct || '';
  const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
  return isFinite(num) ? num : null;
}

function _enrichAuctionItem(rawItem, index, ctx) {
  if (!rawItem) return null;
  const stockName = rawItem.stock ? rawItem.stock.trim() : '';
  const volume = parseFloat(rawItem.volume) || 0;
  const yestVolume = parseFloat(rawItem.yestVolume) || 0;
  const note = getDisplayNote(rawItem);

  let ratioValue = 0;
  let ratioDisplay = '-';
  if (yestVolume > 0) {
    ratioValue = (volume / yestVolume) * 100;
    ratioDisplay = Math.round(ratioValue) + '%';
  }

  let ratioArrow = '';
  if (ctx.prevAuctionMap && stockName) {
    const prevItem = ctx.prevAuctionMap.get(stockName);
    if (prevItem && prevItem.yestVolume) {
      const prevVolume = parseFloat(prevItem.volume) || 0;
      const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
      if (prevYestVolume > 0) {
        const prevRatio = Math.round((prevVolume / prevYestVolume) * 100);
        const currRatio = Math.round(ratioValue);
        if (currRatio > prevRatio) ratioArrow = '⬆';
        else if (currRatio < prevRatio) ratioArrow = '⬇';
      }
    }
  }

  // [REFACTOR 2026-08-14] 用 deriveAuctionTagState(inheritOnly=true) 获取继承标签
  // 当天的标签通过 todayChoice（_getAuctionTag）显示虚线箭头
  const _inheritState = deriveAuctionTagState(stockName, ctx.date, ctx.tagStateCache, true);
  const isSold = _inheritState.sold;
  const isBought = _inheritState.bought;
  const isSelected = _inheritState.selected;
  const isConfirmedSold = isSold || (stockName && ctx.confirmedSoldSet && ctx.confirmedSoldSet.has(stockName));
  const isGray = !isSelected && !isSold && !isBought && ratioValue < 4.5;

  let itemClass = 'auction-item';
  if (isSold) {
    itemClass += ' sold';
  } else if (isConfirmedSold && !isSold) {
    // 已确认卖出但非当天手动卖出：常规展示
  } else if (isBought) {
    itemClass += ' bought';
  } else if (isSelected) {
    itemClass += ' selected';
  }

  const isJingYestMatch = ctx.jingYestToggleChecked && ctx.jingYestHighlightSet && stockName && ctx.jingYestHighlightSet.has(stockName);
  const isParallelMatch = ctx.sortByParallelEnabled && !ctx.jingYestToggleChecked && stockName && ctx.parallelStocksToday && ctx.parallelStocksToday.has(stockName);
  // [VOL-GRAB 2026-09-05] 量比抢筹高光（原「环比」重构）：竞价量比(auc_vol_ratio) >= 10 且 抢筹幅度(open_bid_pct) > 1
  // 两条件同时满足才点亮；与 byRatio 排序分支共用 ctx.volGrabSet（单一真相，杜绝排序与高光两套口径）。
  // 旧口径（今/昨比 >= 1.5 的 highRatioToday）仅保留给「竞放量数」常驻统计，不再参与高光。
  const isHighRatioMatch = ctx.sortByRatioEnabled && stockName && ctx.volGrabSet && ctx.volGrabSet.has(stockName);
  // [THREE-DAY 2026-08-17-v2] 三天竞跌绿色高光：独立逻辑，仅 toggle 开启时生效。
  // 竞价涨幅取自专用字段 auc_pct_chg（避免被「获取涨幅」改写为常规涨幅而误判）。
  // dd≥2 且 当天竞价涨幅 ≥ 0（止跌/企稳/反转）才点亮绿色高光；下跌中继(竞价涨幅<0)不点亮。
  const _todayAucPct = _getThreeDayAuctionPct(rawItem);
  const isThreeDayJingDieMatch = ctx.sortByThreeDayJingDieEnabled && ctx.threeDayJingDieSet && stockName && (ctx.threeDayJingDieSet.get(stockName) || 0) >= 2 && _todayAucPct !== null && _todayAucPct >= 0;
  // [WEAK-STRONG 2026-09-01] 弱转强高光：仅「弱转强」toggle 开启且该股达标（五日涨幅连跌天数>=2 且 上交易日竞价涨幅<=0 且 当日竞价涨幅>0）。
  const isWeakStrongMatch = ctx.sortByWeakStrongEnabled && ctx.weakStrongSet && stockName && ctx.weakStrongSet.has(stockName);
  if (isJingYestMatch) {
    itemClass += ' jing-yest-match';
  } else if (isParallelMatch) {
    itemClass += ' parallel-match';
  } else if (isThreeDayJingDieMatch) {
    itemClass += ' three-day-jing-die';
  } else if (isWeakStrongMatch) {
    itemClass += ' weak-strong';
  } else if (isHighRatioMatch) {
    itemClass += ' high-ratio';
  }

  let numberClass = 'auction-number auction-trend-trigger';
  if (isGray) numberClass += ' gray-text';

  let stockClass = 'auction-stock-name auction-note-trigger';


  let ratioClass = 'auction-ratio auction-ratio-clickable';
  if (ratioValue >= 10) {
    ratioClass += ' highlight';
  } else if (ratioValue >= 4.5 && ratioValue < 10) {
    ratioClass += ' highlight-light';
  }

  let yestColorClass = 'auction-yest auction-yest-note';
  if (note) {
    if (note.includes('涨停')) {
      yestColorClass += ' auction-yest-red';
    } else if (note.includes('跌停')) {
      yestColorClass += ' auction-yest-green';
    } else {
      const numMatches = note.match(/-?\d+\.?\d*/g);
      if (numMatches && numMatches.length > 0) {
        const lastNum = parseFloat(numMatches[numMatches.length - 1]);
        if (lastNum > 0) yestColorClass += ' auction-yest-red';
        else if (lastNum < 0) yestColorClass += ' auction-yest-green';
      }
    }
  }

  const volumeDisplay = rawItem.volume ? Math.round(parseFloat(rawItem.volume)) : '-';
  const yestVolumeDisplay = rawItem.yestVolume ? Math.round(parseFloat(rawItem.yestVolume)) : '-';

  // §6/双身份标记：该股票既是「前一日竞昨高光（次日观察组）」，又同时位于今日正式列表
  // （今日 worker 自动获取的最近多板成分股）。用户需求：正式名单中这类股票旁加 * 号，
  // 以便分辨「它是观察组来源，但今天确实在正式列表里」——统计总数时它正常计入正式成员。
  const isFormalToday = ctx.isFormalToday ? ctx.isFormalToday(stockName) : false;
  const isObsFromPrev = ctx.isObsMember ? ctx.isObsMember(stockName) : false;
  // [DRAGON-GROUP 2026-09-14] 该股是否「前一交易日评选出的龙头」（展示日 D 的龙头组 = D-1 名册）。
  // 只读 ctx.dragonMap（Logic 层 dragon-group.js 已算好并落库），此处不做任何评选（§6 单一真相）。
  // ⚠️ 变量名刻意为 isLeaderFromPrev（对外字段 dragonGroup*）：与另一套「题材内龙头排名」
  //（dragonRank/dragonPct）区分，后者由本函数之外的重写逻辑赋值，容易与本组字段互相覆盖。
  const _dragonEntry = (ctx.dragonMap && stockName) ? ctx.dragonMap.get(stockName) : null;
  const isLeaderFromPrev = !!_dragonEntry;

  // [YIZI 2026-09-09] 竞价一字（竞价涨幅达到该股涨停幅度）→ 股票名下方红色下划线标记。
  // 仅题材 toggle 开启时判定（与龙头徽章同一显示口径），避免无谓计算。
  // 代码取行上 code 字段，缺则查内存代码映射；都缺时按主板 10% 兜底（limit-up.js 内处理）。
  // 展示文本只认专用竞价涨幅字段 auc_pct_chg（changePct 会被「获取涨幅」改写成常规涨幅，不能混用）
  const _aucPctNum = parseAucPct(rawItem.auc_pct_chg || rawItem.aucPctChg || '');
  const _yiZiCode = rawItem.code || (stockName ? getStockCode(stockName) : '') || '';
  const isYiZi = ctx.byTopic ? isAuctionYiZi(rawItem, _yiZiCode) : false;
  const aucPctText = (_aucPctNum === null) ? '' : (_aucPctNum > 0 ? '+' : '') + _aucPctNum.toFixed(2) + '%';

  // [CLOSE-COUNT / CLOSE-LIMIT 2026-09-11] 收盘涨幅 → 红绿 / 停板。
  // 两个前提缺一不可：① 题材 toggle 开启（与竞价一字同一显示口径）；
  // ② 该日已是收盘口径（ctx.closeWindow）—— 否则 change_pct 是 9:25 竞价副本，会误判。
  // 展示文本只认专用收盘字段 changePct/change_pct（market_metrics(auction) 为权威，见 auction-data.js）。
  const _closePct = ctx.closeWindow ? parseAucPct(rawItem.changePct || rawItem.change_pct || '') : null;
  const closeLimit = (ctx.byTopic && ctx.closeWindow)
    ? getCloseLimitState(_closePct, _yiZiCode, stockName)
    : null;

  // [CLOSE-NAME-COLOR 2026-09-11] 收盘涨幅 → 股票名【字体颜色】档位（>0 红 / <0 绿 / =0 或无数值 → 默认黑）。
  // 闸门条件与一字、停板完全同口径（题材 toggle 开启 + 该日已是收盘口径），但【判定写在函数内部】：
  // 早盘 change_pct 是 9:25 竞价副本 → closeWindow=false → 恒为 null → 名字保持默认色，
  // 收盘覆盖后（北京 16:05 起）自动出现颜色。只改字体颜色，不影响下方一字实线 / 停板蚂蚁线（border-bottom）。
  const closeNameTone = getCloseNameTone(_closePct, { byTopic: ctx.byTopic, closeWindow: ctx.closeWindow });

  // [HIGH-LIMIT-BOARD 2026-09-21] 涨跌幅放开板（科创板 688/689、创业板 300/301、北交所 43/83/87/88/92）
  //   → 股票名画【浅灰色删除线】，避免误买（20% / 30% 涨跌幅 + 需额外交易权限）。
  //   代码口径与上方竞价一字【完全同源】（_yiZiCode：行 code → 内存代码映射 → 空），
  //   ⛔ 不另起一套取代码逻辑（§6）。代码缺失 → false（不标，§40 不猜）。
  //   ⚠️ 不加 byTopic / closeWindow 闸门：这是「这只票是什么板」的固有属性，
  //      与「今天是早盘还是收盘」无关，任何模式、任何时间都该标出来（漏标 = 失去防误买的意义）。
  const isHighLimit = isHighLimitBoard(_yiZiCode);

  // [LISTED-TODAY 2026-09-23] 是否【在当天正式列表里】（= auctionList / getTodayGroupList 的成员）。
  //   判定唯一真相 = ctx.isFormalListed（由 computeAuctionViewData 一次性算出 _listedNames），
  //   本函数不另写一份（§6）。
  //   不在此列的 = 观察组 / 龙头【继承壳】（今天没抓到、由上方注入的空壳）+ 补竞价一字补入行：
  //   它们【照常渲染】（次日观察组继承功能需要），但 ① 不进任何统计（题材名次 / 一字数量 / 组大小）；
  //   ② 股票名与题材画灰（UI 层）。
  //   ⚠️ 注意区分：obsAutoAdded 的继承行只要【今天真抓到数据】就在当天正式列表里（会稽山 / 澳弘电子
  //      2026-09-23），不算「不在列表」—— 那是「打 * / 折叠豁免」的口径（_isAuctionFormalMember），别混。
  //   ⛔ §10：正式成员索引未就绪时**不得**判为「不在列表」（那会把还没拉到的数据整列表刷灰），
  //      此时 getTodayGroupList 退化为原始列表 ⇒ 全部在列（降级在数据源侧，本行无需再判）。
  const isFormalMember = ctx.isFormalListed ? ctx.isFormalListed(stockName) : true;

  // [LIMIT-STREAK 2026-09-11] 趋势/连板标记（趋势 / 首板 / 二板 / 三板…）。
  // 只在题材模式计算（与竞价一字 / 龙头徽章同一显示口径）；取值来自 ctx.limitStreakMap，
  // 该映射在 computeAuctionViewData 里【预构建一次】（不是逐行现算），数据源 = 前 9 个历史交易日
  // 收盘涨幅（不含当天，早盘也能算）。无历史数据 / 非题材模式 → ''（模板不渲染）。
  // ⚠️ 不设 closeWindow 闸门：它只读【历史日】的权威收盘涨幅，早盘就该显示（这正是用户要的）。
  const _streakEntry = (ctx.byTopic && ctx.limitStreakMap && stockName) ? ctx.limitStreakMap.get(stockName) : null;
  const streakLabel = _streakEntry ? _streakEntry.label : '';

  return {
    index,
    stock: stockName,
    volume: rawItem.volume || '',
    yestVolume: rawItem.yestVolume || '',
    volumeDisplay,
    yestVolumeDisplay,
    ratio: ratioDisplay,
    ratioArrow,
    ratioClass,
    numberClass,
    stockClass,
    itemClass,
    yestColorClass,
    note,
    bought: isBought,
    sold: isSold,
    selected: isSelected,
    confirmedSold: isConfirmedSold,
    todayChoice: _getAuctionTag(ctx.date, stockName),
    isGray,
    // 双身份：昨日观察组来源 ∩ 今日正式列表 → 股票名旁加 *（用户可分辨）
    obsFormalStar: isObsFromPrev && isFormalToday,
    // 观察组来源（无论今日是否正式，供视图分组/样式使用）
    isObsFromPrev,
    // [DRAGON-GROUP 2026-09-14] 龙头组字段（全部只读名册，零额外计算、零请求）。
    //   ⚠️ 命名刻意与「题材内龙头排名」区分开：dragonRank / dragonPct 属于另一套功能
    //   （同题材组内按十日涨幅排龙一/龙二，见 dragon-rank.js，且 items 组装末尾会重写 dragonPct）。
    //   本组字段一律以 dragonGroup* 前缀，避免被那步覆盖（曾因此出现过「龙头组十日涨幅全为空」）。
    //   · isDragonGroupMember   → 龙头组区块抽取 / 题材模式「龙」组内标记的判定依据；
    //   · dragonGroupFormalStar → 龙头 ∩ 今日正式列表 → 打 *（需求 4，与观察组 `*` 同一套「双身份」语义）；
    //   · dragonGroupTopic / dragonGroupPct / dragonGroupSize → 区块显示「题材 + 十日涨幅 + 题材成员数」。
    isDragonGroupMember: isLeaderFromPrev,
    dragonGroupFormalStar: isLeaderFromPrev && isFormalToday,
    dragonGroupTopic: _dragonEntry ? _dragonEntry.topic : '',
    dragonGroupPct: _dragonEntry ? _dragonEntry.pct : null,
    dragonGroupSize: _dragonEntry ? _dragonEntry.groupSize : 0,
    // [FEAT 2026-08-20] 题材 toggle：题材数量（供排序）与题材展示文本（供题材列显示）
    topicCount: getStockTopicCount(rawItem),
    topicsDisplay: getStockTopicsDisplay(rawItem),
    // [YIZI 2026-09-09] 竞价一字（竞价涨停）→ 股票名下红线；aucPctText 仅用于悬停提示
    isYiZi,
    aucPctText,
    // [DRAGON-COLOR 2026-09-11] 龙头徽章（龙一/龙二…）配色依据 = 当天竞价涨幅数值。
    // 取值只认专用竞价涨幅字段 auc_pct_chg（与上方 _aucPctNum 同一个值，零额外计算、
    // 无请求、不落库）：>0 红、<0 绿、=0 灰；null = 该股当日无竞价涨幅数据（按中性灰，不当 0 处理）。
    // 绝不复用 changePct/change_pct —— 后者会被收盘覆盖改写成收盘涨幅，颜色会跟着收盘变，
    // 与「跟随当天竞价涨幅」的需求不符。
    aucPctNum: _aucPctNum,
    // [CLOSE-LIMIT 2026-09-11] 收盘涨停('up')/跌停('down') → 股票名下绿色/红色【蚂蚁线（虚线）】标记。
    // null = 既非停板也没有收盘涨幅数据（不标记）。视觉优先级见 AuctionBoardTable：竞价一字实线优先。
    closeLimit,
    // [CLOSE-NAME-COLOR 2026-09-11] 股票名字体颜色档位：'up'=红（收盘涨）/ 'down'=绿（收盘跌）/
    // null=平盘、无数据、或未到收盘口径（保持默认黑）。模板只认这个字段，别在模板里再判符号。
    closeNameTone,
    // [HIGH-LIMIT-BOARD 2026-09-21] 涨跌幅放开板（科创 / 创业 / 北交所）→ 股票名浅灰色删除线。
    //   与 closeNameTone（收盘红绿）在 UI 侧【互斥】：安全提示压过装饰色，见 AuctionEntityRow#stockTextClass。
    isHighLimitBoard: isHighLimit,
    // [NOT-FORMAL 2026-09-23] 是否当天 9:25 正式名单成员（false = 观察组继承壳 / 影子行）。
    //   ① 统计口径：题材名次 / 一字数量 / 组大小只算 true 的行；② UI：false → 股票名与题材画灰。
    isFormalMember,
    // [LIMIT-STREAK 2026-09-11] 趋势/连板标记文案：'趋势' / '首板' / '二板' / '三板' / …
    // 由前 9 个历史交易日收盘涨幅派生（不含当天）。空串 = 非题材模式或无历史数据 → 模板不渲染。
    streakLabel,
    // [CLOSE-COUNT 2026-09-11] 收盘涨幅数值（仅收盘口径日期有值，否则 null），供题材统计条「2红9绿」计数。
    closePct: _closePct,
    // [TOPIC-SEQ 2026-09-11] 同题材组内序号（1 起）。只在「题材单独开启」时由调用方赋值；
    // 其余模式保持 0 → 模板回退到原来的全局序号（行为完全不变）。
    seqNo: 0,
    // [YIZI-SUP 2026-09-20] 本行所属的题材组名（题材【单独】开启时由下方 items 后置赋值，
    // 其余模式恒为 ''）。纯展示派生字段：⛔ 不参与排序、统计、缓存指纹以外的任何计算。
    // 用途：「补竞价一字」要把竞价一字按题材【融入】对应题材组，必须知道每行属于哪一组；
    // 分组边界是本题材分支内部算出来的（primaryTopicOfForColor），与其在 UI 侧用另一套算法
    // 反推（§6 必然分叉），不如把既成事实原样标出来。
    groupTopic: ''
  };
}

export function prepareAuctionData(currentDate) {
  try { ensureBoughtStocksForDate(currentDate); } catch (e) { console.warn('ensureBoughtStocksForDate failed:', e); }
  try { ensureObservationStocks(currentDate); } catch (e) { console.warn('ensureObservationStocks failed:', e); }
}

export function computeAuctionViewData(dataSource, sortStateOverride) {
  dataSource = dataSource || 'auction';
  const _p = dataSource === 'hot' ? 'hot' : 'auction';
  const currentDate = useUiStore().currentDate;
  // [CLOSE-COUNT 2026-09-11] 收盘口径门槛（当天 15:00 起 / 历史日期）。
  // 收盘红绿统计与收盘停板标记都以它为闸门：早盘 change_pct 是竞价副本，不能当收盘结果用。
  const closeWindow = isAuthoritativeCloseReached(currentDate);

  const auctionList = getTodayGroupList(dataSource);
  if (!auctionList || auctionList.length === 0) {
    return { items: [], obsIndices: [], regularIndices: [], dragonIndices: [], hiddenObsIndices: [], stats: { todayStrength: null, yesterdayStrength: null, strongCount: 0, totalCount: 0, highRatioCount: 0, jingYestCount: 0 }, rawCount: 0, date: currentDate, dataSource };
  }

  const prevDate = getPreviousTradingDay(currentDate);

  // [OBS-FIX 2026-08-17] 观察组 = 前一日「竞昨高光全集」直接继承，与当天 9:25 名单无关。
  // getJingYestHighlightSetForDate 本身已修（sort-rules.js）：只算当日正式名单内（9:25 拉取的
  // watchlist 成员），排除 market_metrics 影子行 → 8/14 竞昨=16 只、8/17 观察组=16 只，
  // 竞昨数/蓝色高光/观察组三者一致（§17/§23 单一真相）。
  const _obsStocks = getJingYestHighlightSetForDate(prevDate, dataSource);
  const _obsBoughtSet = new Set(JSON.parse(localStorage.getItem('obsBought_' + currentDate) || '[]')); // 合规：防重复/调试标记（§8 允许）
  const _isObsMember = function(name) {
    if (!name) return false;
    if (_obsBoughtSet.has(name)) return true;
    return (_obsStocks && _obsStocks.has(name));
  };

  // [DRAGON-GROUP 2026-09-14] 龙头组名册（同步读，ref-driven —— 名册异步到货后本函数自动重算）。
  // 展示日 D 的龙头组 = 名册中 date = prevTradingDay(D) 的行（=「每天的龙头放到次日」）。
  // null = 尚未加载/加载失败 → 本次不产生龙头组（绝不用空列表伪装成「今天没有龙头」，§10）；
  // 名册的【评选】唯一实现在 logic/auction/dragon-group.js，本文件只读不选（§6 单一真相）。
  // 判定「某行是否属龙头组」只认 `_dragonMap.has(name)`（下文的区块抽取与排序都以名册为准，
  // 不再另写一份判定函数 —— 旧版那个 _isDragonPrev 包装已随排序重写删除，§42 不留死代码）。
  const _dragonMap = getDragonLeadersForDisplay(currentDate);
  // 凡应属观察组但不在当日列表的股票，构造渲染用空壳行（与 ensureObservationStocks 形状一致，便于 _enrichAuctionItem 统一处理）。
  const _existingNames = new Set(auctionList.map(function(s) { return s && s.stock ? s.stock.trim() : ''; }));
  const _injectNames = new Set();
  const _injectedRows = [];
  // [OBS-DATA 2026-08-15] 观察组空壳行回填当天真实数据：worker 9:25 已把观察组股票
  // （前一日 watchlist 合并进抓取名单）的数据写入 market_metrics，pullAuctionFromTable
  // 会把 market_metrics 的影子行合并进 _auctionMemCache[date]。注入观察组行时若缓存里有
  // 同名行（非 obsAutoAdded），复用其 volume/yestVolume/note/changePct，避免观察组显示空白。
  const _auctionDayRows = (getAuctionData()[currentDate] || []);
  const _auctionDayRowMap = new Map();
  _auctionDayRows.forEach(function(r) {
    if (r && r.stock) {
      const k = r.stock.trim();
      if (!_auctionDayRowMap.has(k)) _auctionDayRowMap.set(k, r);
    }
  });
  function _maybeInject(n) {
    if (!n) return;
    if (_existingNames.has(n) || _injectNames.has(n)) return;
    _injectNames.add(n);
    const dayRow = _auctionDayRowMap.get(n);
    if (dayRow && dayRow.obsAutoAdded !== true) {
      // worker/手动已抓到该股票当天数据：保留真实数据，仅补观察组身份标记（视图层不落库）
      _injectedRows.push(Object.assign({}, dayRow, { obsAutoAdded: true }));
    } else {
      _injectedRows.push({ stock: n, code: getStockCode(n), volume: '', yestVolume: '', note: '', obsAutoAdded: true });
    }
  }
  // [OBS-FIX 2026-08-15 v3] 观察组完整继承恢复：无论当天是否已抓取真实数据，都把
  // 「前一日竞昨高光 + obsBought」中不在当日列表的股票注入为观察组预览空壳行（蚂蚁线上观察组分栏）。
  //  - 修复全局少股：8/10 观察组 16≠18、8/11 观察组 26≠28（8/14 v2 禁止已抓取日注入导致观察组只剩交集）；
  //    观察组语义 = 前日竞昨高光完整集合，与"当日是否已抓取"无关。
  //  - 注入行仅用于视图渲染（renderList），不写入 auctionData、不推送云端（§6：观察组不落库、不产生影子记录）；
  //    历史锁定仍由 ensureObservationStocks（数据层）承担，视图层只如实呈现继承结果。
  //  - 注入行 obsAutoAdded=true，经 _isObsMember 判定进入观察组分栏（蚂蚁线上），绝不混入常规组（蚂蚁线下）。
  //  - 统计口径仍基于 auctionList + 正式成员索引（getAuctionBoardList 已过滤），注入壳不影响总数/涨跌比。
  if (_obsStocks) _obsStocks.forEach(_maybeInject);
  _obsBoughtSet.forEach(_maybeInject);

  // [DRAGON-GROUP 2026-09-14] 龙头组空壳行注入（需求 4：龙头「昨日在正式列表中、今日不在」也要出现）。
  // 与观察组注入同款：仅用于视图渲染，不写入 auctionData、不推云端（§6 不产生影子记录）。
  // 已落库到 dragon_leaders 的只有「名字/题材/十日涨幅」，当日行情（volume/yestVolume/note）若云端
  // 有同名行则复用（worker 9:25 会把龙头并入抓取名单 → market_metrics 有影子行），否则留空壳。
  // 标记 dragonAutoAdded=true 仅用于可观测性/调试（渲染归属由 dragonIndices 决定，不依赖此标记）；
  // 刻意【不设】obsAutoAdded —— 它不是观察组行，混用会让「观察组归属」出现第二个判据（§6）。
  function _maybeInjectDragon(n, meta) {
    if (!n) return;
    if (_existingNames.has(n) || _injectNames.has(n)) return;
    _injectNames.add(n);
    const dayRow = _auctionDayRowMap.get(n);
    if (dayRow && dayRow.obsAutoAdded !== true) {
      _injectedRows.push(Object.assign({}, dayRow, { dragonAutoAdded: true }));
    } else {
      _injectedRows.push({
        stock: n,
        code: (meta && meta.code) || getStockCode(n),
        volume: '', yestVolume: '', note: '',
        dragonAutoAdded: true
      });
    }
  }
  if (_dragonMap) _dragonMap.forEach(function(meta, name) { _maybeInjectDragon(name, meta); });

  // renderList 仅服务于视图渲染；真实业务数据(auctionList)保持不变，统计口径仍基于 auctionList。
  const renderList = _injectedRows.length ? auctionList.concat(_injectedRows) : auctionList;

  // [LISTED-TODAY 2026-09-23] 「在不在【当天正式列表】里」—— 一份判据，四处共用
  //   （题材排序 / 题材统计条 / 题材配色 / 行着色 + 五日趋势图）。
  //
  //   ⚠️⚠️ 口径必须严格 = 本函数开头的 auctionList（= getTodayGroupList）：
  //     · 它【含】obsAutoAdded 的观察组继承行 —— 会稽山 / 澳弘电子 2026-09-23 就是这种：
  //       在 auction_watchlist 里带 obs_auto_added=true，但今天 9:25 真抓到了数据，
  //       用户口径就是「它们在今天的正式列表里」（当日 61 行中 6 行属此类）。
  //     · 它【不含】market_metrics 影子行（不在 watchlist 且非 obs 的行已被 getTodayGroupList 过滤）。
  //   ⛔ 别再改用 _isAuctionFormalMember：它刻意【排除】obsAutoAdded 行，那是「打 * / 折叠豁免」的
  //     口径（2026-09-09 万向德农修复），与「当天正式列表」不是一回事。拿它当统计判据会让
  //     「显示在题材组里的行」与「统计数字」再次错位 —— 2026-09-23 会稽山 / 澳弘电子事故现场。
  //
  //   ⚠️⚠️ 必须声明在 renderList【之后】、题材排序分支【之前】：下面 sortByTopicGroups 的
  //   countableOf 回调会在排序过程中【同步执行】，而 const 存在 TDZ —— 声明写晚了就是
  //   "Cannot access '_listedNames' before initialization" ⇒ computeAuctionViewData 整体抛错，
  //   表现为「打开题材 toggle 却和没打开一样：无分组、无底色、无统计条」（2026-09-23 事故）。
  //   [INHERIT-SELL] 唯一例外：昨日打过「卖」标签 → 继承过来的复盘行（不在正式成员索引里）
  //     也不入列⇒ 画灰 + 不计数（当日"已卖出"，只剩复盘价值）。判据见 inherited-sold.js。
  //   §10：getTodayGroupList 在正式成员索引未就绪时退化为原始列表 → 此刻全算，
  //        ⛔ 绝不把整列表判成「不在列表」（不会整片刷灰）。
  const _listedNames = new Set();
  // [INHERIT-SELL 2026-09-23] 剔除「昨日打过『卖』标签 → 继承过来的复盘行」（不在当天正式成员索引里）。
  //   用户口径：这类票画灰 + 不计入统计，而昨日「买」标签继承的（仍在跟踪）保持原样。
  //   判据收在 logic/auction/inherited-sold.js（§6），同五日趋势共用一份。
  const _inheritSold = getPrevSoldInheritedSet(currentDate, prevDate);
  auctionList.forEach(function(it) {
    const nm = it && it.stock ? String(it.stock).trim() : '';
    if (!nm) return;
    if (_inheritSold.has(nm)) return;
    _listedNames.add(nm);
  });

  const auctionData = getGroupData(dataSource);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
  const prevPrevAuctionList = prevPrevDate ? (auctionData[prevPrevDate] || []) : [];

  let sortState;
  if (sortStateOverride) {
    sortState = sortStateOverride;
  } else {
    try {
      const store = useAuctionStore();
      sortState = store && store.sortState ? store.sortState[_p] : { byWeakStrong: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false };
    } catch {
      sortState = { byWeakStrong: false, byRatio: false, byParallel: false, byJingYest: false, byJingYestRatio: false, byThreeDayJingDie: false, byTopic: false };
    }
  }

  // [LIMIT-STREAK 2026-09-11] 趋势/连板映射：只在题材模式计算（需求：「单独打开题材 toggle」看趋势/连板）。
  // 预构建一次（不是逐行现算），供下方 ctx → _enrichAuctionItem 逐行读取。
  // 失败不影响看板主体（纯展示派生值）：降级为「无标记」，但必须留痕，绝不静默（§10 精神）。
  let limitStreakMap = null;
  if (sortState.byTopic) {
    try {
      limitStreakMap = buildLimitStreakMapForDate(currentDate);
    } catch (e) {
      console.warn('[LIMIT-STREAK] 连板映射构建失败，本次不显示趋势/连板标记:', e);
      limitStreakMap = new Map();
    }
  }

  const highRatioToday = getHighRatioStocksForDate(currentDate, dataSource);
  const jingYestHighlightSet = getJingYestHighlightSetForDate(currentDate, dataSource);
  const parallelStocksToday = getParallelStocksForDate(currentDate, dataSource);
  const jingYestToggleChecked = sortState.byJingYest || sortState.byJingYestRatio;

  // [WEAK-STRONG 2026-09-01] 弱转强达标集合（连跌天数>=1 且 竞价涨幅>=0）；仅该 toggle 开启时计算。
  const weakStrongSet = sortState.byWeakStrong ? getWeakStrongSet(currentDate, dataSource) : null;
  const weakStrongTurnSet = sortState.byWeakStrong ? getWeakStrongTurnSet(currentDate, dataSource) : null;

  // [VOL-GRAB 2026-09-05] 量比抢筹达标集合（竞价量比>=10 且 抢筹幅度>1）；仅该 toggle 开启时计算。
  // 排序与高光判定共用这一份结果，避免两处口径分叉。
  const volGrabSet = sortState.byRatio ? getVolGrabSet(currentDate, dataSource) : null;

  const _prevMap = new Map();
  if (prevAuctionList.length > 0) {
    for (const p of prevAuctionList) {
      if (p && p.stock) _prevMap.set(p.stock.trim(), p);
    }
  }
  const _prevPrevMap = new Map();
  if (prevPrevAuctionList.length > 0) {
    for (const p of prevPrevAuctionList) {
      if (p && p.stock) _prevPrevMap.set(p.stock.trim(), p);
    }
  }

  // [STATS-FIX 2026-09-08] 强度（涨跌比）只按「正式成员」计算，排除观察组(obsAutoAdded)行。
  // 观察组是用户前一日打标签/竞昨高光继承来的复盘名单，不是当日 9:25 名单成员；空壳行
  // volume/yestVolume 皆空 → hasDown 恒为 false，会被当成"强"计入分子，把强度虚高稀释
  // （2026-09-03 曾因观察组落库导致统计回归，此处从口径上根治）。
  // ⚠️ 双身份票（打*：观察组 ∩ 当日正式名单）按正式成员对待，仍计入强度；
  // 只有「纯观察组」（不在正式成员索引里）才排除。
  const _formalSet = _getAuctionWatchlistSet(currentDate) || new Set();
  const _formalOnly = function(list) {
    return (list || []).filter(function(r) {
      if (!r || !r.stock) return false;
      const n = r.stock.trim();
      return _formalSet.has(n) || r.obsAutoAdded !== true;
    });
  };
  const _statList = _formalOnly(auctionList);
  const _prevStatList = _formalOnly(prevAuctionList);

  let strongCount = 0;
  _statList.forEach(item => {
    let hasDown = false;
    if (item.stock) {
      const prevItem = _prevMap.get(item.stock.trim());
      if (prevItem && prevItem.yestVolume) {
        const prevVolume = parseFloat(prevItem.volume) || 0;
        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
        if (prevYestVolume > 0) {
          const prevRatioValue = (prevVolume / prevYestVolume) * 100;
          const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
          if (currRatioValue < prevRatioValue) hasDown = true;
        }
      }
    }
    if (!hasDown) strongCount++;
  });
  const totalCount = _statList.length;
  const todayStrength = totalCount > 0 ? Math.round((strongCount / totalCount) * 100) : null;

  let yStrongCount = 0;
  const yTotal = _prevStatList.length;
  if (yTotal > 0) {
    _prevStatList.forEach(item => {
      let hasDown = false;
      if (item.stock) {
        const pp = _prevPrevMap.get(item.stock.trim());
        if (pp && pp.yestVolume) {
          const ppv = parseFloat(pp.volume) || 0;
          const ppy = parseFloat(pp.yestVolume) || 0;
          if (ppy > 0) {
            const pprr = (ppv / ppy) * 100;
            const prr = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
            if (prr < pprr) hasDown = true;
          }
        }
      }
      if (!hasDown) yStrongCount++;
    });
  }
  const yesterdayStrength = yTotal > 0 ? Math.round((yStrongCount / yTotal) * 100) : null;

  let renderOrder = renderList.map((_, idx) => idx);

  if (sortState.byWeakStrong) {
            // [WEAK-STRONG 2026-09-01] 弱转强三档排序：
            //   tier0 高光 = 连跌天数>=2(条件①) 且 竞价转向(上交易日<=0 且 当日>=0，条件②)，两条件同时满足；
            //   tier1 第二档 = 仅竞价转向(条件②) 达标、连跌未达>=2（不点亮高光）；
            //   tier2 其余 = 竞价未转向（上交易日>0 或缺失）或当日<0，排在最末。
            //   同档内：tier0 按连跌天数由高到低、同日按「当日竞价涨幅」由高到低；tier1 按「当日竞价涨幅」由高到低；tier2 保持原序。
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const isHighlight = !!(weakStrongSet && weakStrongSet.has(stockName)); // tier0
      const isTurn = !isHighlight && !!(weakStrongTurnSet && weakStrongTurnSet.has(stockName)); // tier1
      const tier = isHighlight ? 0 : (isTurn ? 1 : 2);
      const downStreak = isHighlight ? weakStrongSet.get(stockName) : 0;
      const todayAuc = _getThreeDayAuctionPct(it);
      return { idx, pos, tier, isHighlight, isTurn, downStreak, todayAuc };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0) {
        if (b.downStreak !== a.downStreak) return b.downStreak - a.downStreak;
        if (a.todayAuc === null && b.todayAuc === null) return a.pos - b.pos;
        if (a.todayAuc === null) return 1;
        if (b.todayAuc === null) return -1;
        if (b.todayAuc !== a.todayAuc) return b.todayAuc - a.todayAuc;
        return a.pos - b.pos;
      }
      if (a.tier === 1) {
        // 第二档：仅竞价转向，按「当日竞价涨幅」由高到低（转得越猛越靠前）
        if (a.todayAuc === null && b.todayAuc === null) return a.pos - b.pos;
        if (a.todayAuc === null) return 1;
        if (b.todayAuc === null) return -1;
        if (b.todayAuc !== a.todayAuc) return b.todayAuc - a.todayAuc;
        return a.pos - b.pos;
      }
      return a.pos - b.pos; // tier2 保持原序
    }).map(x => x.idx);
  } else if (sortState.byRatio) {
    // [VOL-GRAB 2026-09-05] 量比抢筹（原「环比」toggle 重构后的排序规则）：
    //   达标 = 竞价量比(auc_vol_ratio) >= 10 且 抢筹幅度(open_bid_pct) > 1 —— 两条件【同时】满足才高光置顶；
    //   达标组内按「竞价量比」降序，量比相同则按「抢筹幅度」降序（抢得越猛越靠前）；
    //   未达标（任一条件不满足或字段缺失）保持原序排在其后。
    //   注：原环比的「今/昨比 >= 1.5 + 位数差」口径已废弃；「竞放量数」(highRatioToday) 是常驻统计，
    //   与 toggle 开关无关，保持原样不动，避免误伤既有展示。
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
      const g = stockName && volGrabSet ? volGrabSet.get(stockName) : null;
      return { idx, pos, qualified: !!g, volRatio: g ? g.volRatio : null, bidPct: g ? g.bidPct : null };
    }).sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      if (a.qualified) {
        if (b.volRatio !== a.volRatio) return b.volRatio - a.volRatio; // 竞价量比降序
        if (b.bidPct !== a.bidPct) return b.bidPct - a.bidPct;         // 同量比 → 抢筹幅度降序
      }
      return a.pos - b.pos;
    }).map(x => x.idx);

  } else if (sortState.byJingYest) {
    // [FIX 2026-08-18] 同档排序改为按「当天竞价涨幅 auc_pct_chg」由高到低（与三天竞跌口径一致）。
    //   分档条件不变：tier0=竞昨高光(平行+diff>0) / tier1=仅平行 / tier2=其它（与三天竞跌的"连续竞跌"条件不同）。
    //   原 digitGap+diff 排序键废弃，改用 _getThreeDayAuctionPct（专用竞价涨幅字段，与绿光口径一致）。
    const parallelStockNamesForSort = getParallelStocksForDate(currentDate, dataSource);
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const isParallel = parallelStockNamesForSort.has(stockName);
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
      const pctVal = _getThreeDayAuctionPct(it);
      return { idx, pos, tier, pctVal };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
      if (a.pctVal === null) return 1;
      if (b.pctVal === null) return -1;
      return b.pctVal - a.pctVal;
    }).map(x => x.idx);

  } else if (sortState.byJingYestRatio) {
    renderOrder = renderOrder.map((idx, pos) => {
      const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : 1;
      const vol = renderList[idx] ? (parseFloat(renderList[idx].volume) || 0) : 0;
      const yvol = renderList[idx] ? (parseFloat(renderList[idx].yestVolume) || 0) : 0;
      const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
      return { idx, pos, jr, tier };
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.jr === null && b.jr === null) return a.pos - b.pos;
      if (a.jr === null) return 1;
      if (b.jr === null) return -1;
      return b.jr - a.jr;
    }).map(x => x.idx);
  } else if (sortState.byThreeDayJingDie) {
    // [THREE-DAY 2026-08-17] 排序规则：
    //   1) 符合条件（连续竞跌天数 dd≥2）整体排在前面；
    //   2) 同档内按「当天竞价涨幅 auc_pct_chg」由高到低（专用竞价涨幅字段，与绿光口径一致；之前是竞价量比值 jr，已废弃）。
    const threeDayJingDieSet = getThreeDayJingDieSet(currentDate, dataSource);
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const dd = stockName && threeDayJingDieSet ? (threeDayJingDieSet.get(stockName) || 0) : 0;
      // 同档排序按「当天竞价涨幅 auc_pct_chg」由高到低（专项字段，与绿光口径一致）
      const pctVal = _getThreeDayAuctionPct(it);
      const isQualified = dd >= 2;
      return { idx, pos, isQualified, pctVal };
    }).sort((a, b) => {
      if (a.isQualified !== b.isQualified) return a.isQualified ? -1 : 1;
      if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
      if (a.pctVal === null) return 1;
      if (b.pctVal === null) return -1;
      return b.pctVal - a.pctVal;
    }).map(x => x.idx);
  } else if (sortState.byParallel) {
    if (sortState.byJingYest) {
      const parallelStockNamesForSort = getParallelStocksForDate(currentDate, dataSource);
      const allRatioDiffInfo = getRatioDiffInfoForDate(currentDate, dataSource);
      renderOrder = renderOrder.map((idx, pos) => {
        const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
        const isParallel = parallelStockNamesForSort.has(stockName);
        const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
        const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
        const fallbackInfo = (tier === 0 || tier === 1) ? allRatioDiffInfo.get(stockName) : null;
        const diff = fallbackInfo ? fallbackInfo.diff : null;
        const digitGap = fallbackInfo ? fallbackInfo.digitGap : null;
        return { idx, pos, diff, digitGap, tier };
      }).sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.tier === 0 || a.tier === 1) {
          if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
          if (a.digitGap === null) return 1;
          if (b.digitGap === null) return -1;
          if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
          return b.diff - a.diff;
        }
        return a.pos - b.pos;
      }).map(x => x.idx);
    } else {
      const parallelStockNames = getParallelStocksForDate(currentDate, dataSource);
      const allRatioDiffInfoForParallel = getRatioDiffInfoForDate(currentDate, dataSource);
      renderOrder = renderOrder.map((idx, pos) => {
        const stockName = renderList[idx] && renderList[idx].stock ? renderList[idx].stock.trim() : '';
        const qualifies = stockName && parallelStockNames.has(stockName);
        const info = qualifies ? allRatioDiffInfoForParallel.get(stockName) : null;
        return { idx, pos, qualifies, diff: info ? info.diff : null, digitGap: info ? info.digitGap : null };
      }).sort((a, b) => {
        if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
        if (a.qualifies) {
          if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
          if (a.digitGap === null) return 1;
          if (b.digitGap === null) return -1;
          if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
          return b.diff - a.diff;
        }
        return a.pos - b.pos;
      }).map(x => x.idx);
    }
  }

  // [FEAT 2026-08-20 v2] 题材 toggle：联动辅助叠加排序（按题材【分组】，非按单只股票题材数量）。
  // 复用第二页题材分类(getTopicGroups) 的同一套核心词匹配口径：把同题材股票聚到一起，
  // 哪个题材股票多哪个排前面，"其它"(无题材/未匹配核心词/组<2只) 置底。
  // 主排序档位(tier)顺序保持不变——竞昨高光/达标(tier0)整体置顶，档位【内部】再按题材组大小降序。
  // 覆盖 竞/昨、竞/昨占比、三天竞跌（分层）与 数据/环比/平行/默认（单层，等同全局分组）。
  // 修复点：v1 按「单只股票题材数量」排序（一只股题材多就排前），与用户要的「题材分组」不符；
  //       现改为与第二页一致的主题材分组，高光档位整体仍置顶、组内按题材聚并组大者居前。

  // 三天竞跌达标集合：提前算一次，下方档位解析与分组逻辑复用（避免重复计算）。
  const threeDayJingDieSet = sortState.byThreeDayJingDie ? getThreeDayJingDieSet(currentDate, dataSource) : null;

  // 主排序档位解析：给定 renderList 索引，返回其档位（0=最高档/高光或达标）。
  // 必须与上方各主排序分支的 tier 口径完全一致，否则档位边界错位。
  function resolveTopicTier(idx) {
    const it = renderList[idx];
    const nm = it && it.stock ? it.stock.trim() : '';
    if (sortState.byThreeDayJingDie) {
      // [FIX 2026-08-20] 高光档(tier0) = 绿色高光口径：连续竞跌 dd≥2 且 当天竞价涨幅≥0（止跌/企稳/反转）。
      // 下跌中继(dd≥2 但 竞价涨幅<0 或缺失)不点亮绿光 → 视为「其它」归入 tier1，
      // 否则题材分组会把绿光高光与下跌中继按题材打散混在一起（用户反馈的「高光很分散」）。
      // 此口径与 _enrichAuctionItem 中的 isThreeDayJingDieMatch 完全一致。
      const dd = nm && threeDayJingDieSet ? (threeDayJingDieSet.get(nm) || 0) : 0;
      if (dd >= 2) {
        const pct = _getThreeDayAuctionPct(it);
        const isGreen = pct !== null && pct >= 0;
        return isGreen ? 0 : 1;
      }
      return 1;
    }
    if (sortState.byWeakStrong) {
      // [WEAK-STRONG 2026-09-01] 高光档(tier0)=弱转强达标（连跌天数>=2 且 上交易日竞价涨幅<=0 且 当日竞价涨幅>0），否则 tier1。
      // 与 _enrichAuctionItem 中 isWeakStrongMatch 口径一致。
      const ws = nm && weakStrongSet ? weakStrongSet.has(nm) : false;
      return ws ? 0 : 1;
    }
    if (sortState.byJingYestRatio) {
      const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
      return ih ? 0 : 1;
    }
    if (sortState.byJingYest) {
      const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
      const ip = nm && parallelStocksToday && parallelStocksToday.has(nm);
      return ih ? 0 : (ip ? 1 : 2);
    }
    if (sortState.byRatio) {
      // [VOL-GRAB 2026-09-05] 量比抢筹：达标档(tier0)=竞价量比>=10 且 抢筹幅度>1，否则 tier1。
      // 与 _enrichAuctionItem 中 isHighRatioMatch 口径一致；题材 toggle 叠加时保证高光档仍整体置顶。
      const vg = nm && volGrabSet ? volGrabSet.has(nm) : false;
      return vg ? 0 : 1;
    }
    // 其它主排序（平行/数据/默认）无分层概念，统一单档
    return 0;
  }

  // [TOPIC-MERGE 2026-09-09] 题材 toggle「单独开启」判定：没有任何主排序 toggle 参与时为真。
  // 单独开启题材 = 用户只想按题材看当日全量（含观察组继承票），不再区分观察组/常规组两块；
  // 一旦叠加任一主排序 toggle（弱转强/量比抢筹/平行/竞昨/竞昨占比/三天竞跌），
  // 观察组与常规组的既有显示方式保持不变（下方分组分支的 else/各专属分支原逻辑不动）。
  const topicOnlyMode = !!sortState.byTopic
    && !sortState.byWeakStrong
    && !sortState.byRatio
    && !sortState.byParallel
    && !jingYestToggleChecked
    && !sortState.byThreeDayJingDie;

  // 题材背景色映射：仅在 byTopic 开启时计算，供下方 enrich 步骤给每行附上浅色背景。
  // 不同题材不同浅色、仅成员>=2 的真实题材上色、"其它"不上色（详细口径见 buildTopicColorMap）。
  let topicColorMap = null;
  let primaryTopicOfForColor = null;
  // [TOPIC-STATS 2026-09-10] 竞价一字判定函数（题材块内定义，提升到此处供统计条复用）
  let yiZiOf = null;

  // [DRAGON 2026-09-09] 龙头排名：只在题材 toggle 开启时计算（需求——只要题材开着标记就在，
  // 无论是否叠加其它 toggle）。口径：同题材组（= 界面同颜色块：真实题材 且 成员>=2）内部，
  // 按「近10个交易日区间涨幅」降序，最高=龙一。
  // 数据来自 dragon-rank.js 的异步缓存（10日区间涨幅，猫抓 daily 一次批量请求 + 云端缓存省额度）；
  // 未加载/无数据时 dragonRankMap 为 null → 行上不显示徽章、组内保持原顺序，绝不阻塞渲染。
  //
  // [NOT-FORMAL-DRAGON 2026-09-25] 候选集必须 = 【当天正式列表】（_listedNames），与题材统计条 /
  // 组间排序 / 行着色同源（§6 单一真相）。
  //   为什么要这道过滤：renderList = auctionList + 注入行（观察组壳 / 龙头继承壳 / 补一字补入行），
  //   注入行正是界面上「灰色股票名 + 灰色题材」的那些 —— 它们【不在当天正式列表里】，却同样能在
  //   stock_range_pct 里查到十日涨幅。旧实现不过滤 ⇒ 灰行占掉龙一/龙二位次，把真龙一挤成龙二、
  //   真龙二挤成龙三（用户 2026-09-25 反馈：9/16 电子/通信/算力 龙一被判成高开、
  //   9/17 龙二被判成高开）。
  //   ⚠️ 只过滤【龙位候选集】，不动 topicColorMap（底色）与渲染集合 —— 灰行仍照常渲染在组里，
  //      只是不挂龙标、不占用名次（用户 2026-09-23 反馈「底色没了」的坑别再踩）。
  //   §10：正式成员索引未就绪时 getTodayGroupList 退化为原始列表 → _listedNames 覆盖全量，
  //       ⛔ 绝不把整列表判成「不在列表」（不会整片丢龙标）。
  let dragonRankMap = null;
  const _buildDragonRankMap = function(order) {
    if (!sortState.byTopic || !primaryTopicOfForColor) return null;
    const dragonPctMap = getDragonRangePct(currentDate);
    if (!dragonPctMap || dragonPctMap.size === 0) return null;
    const dragonEntries = [];
    order.forEach(function(i) {
      const raw = renderList[i];
      const nm = raw && raw.stock ? String(raw.stock).trim() : '';
      if (!nm || !dragonPctMap.has(nm)) return;
      if (!_listedNames.has(nm)) return;              // 灰行（不在当天正式列表）不占龙位
      const pct = dragonPctMap.get(nm).pct;
      if (pct === null || pct === undefined || isNaN(pct)) return;
      dragonEntries.push({ name: nm, topic: primaryTopicOfForColor(i), pct: pct });
    });
    const coloredTopics = topicColorMap ? new Set(topicColorMap.keys()) : null;
    return computeDragonRankMap(dragonEntries, { coloredTopics: coloredTopics, minGroupSize: 2 });
  };

  if (sortState.byTopic) {
    // 题材 toggle：复用第二页题材分类，按题材分组排序（组大者居前、"其它"置底、档位顺序不变）。
    const primaryTopicMap = getPrimaryTopicMap(auctionList);
    // [MAJORITY-SIDE 2026-09-24] 兜底行也遵守「站队到数量多的一边」（与 getPrimaryTopicMap 同裁）
    const primaryTopicSize = buildTopicSizeMap(primaryTopicMap);
    const primaryTopicOf = (idx) => {
      const it = renderList[idx];
      const nm = it && it.stock ? String(it.stock).trim() : '';
      if (nm && primaryTopicMap.has(nm)) return primaryTopicMap.get(nm);
      // 兜底：注入行（如观察组壳行）不在 auctionList 内时，按核心词单独匹配一次
      return classifyStockPrimaryTopic(it, primaryTopicSize);
    };
    primaryTopicOfForColor = primaryTopicOf;

    // [YIZI 2026-09-09] 题材组间排序权重：9:25 竞价一字（竞价涨停）数量越多的题材排越前。
    // 判定只依赖行内 auc_pct_chg + 代码（内存映射），同步无请求；缺代码按主板 10% 兜底。
    // 无一字时 yiZiMap 全为 0 → 退化为「按题材数量降序」的既有口径，行为不变。
    // [TOPIC-STATS 2026-09-10] 统计条同样要数「一字」，故提升到外层作用域供两处复用（§6 单一真相）。
    const _yiZiCache = new Map();
    yiZiOf = function(idx) {
      if (_yiZiCache.has(idx)) return _yiZiCache.get(idx);
      const it = renderList[idx];
      const nm = it && it.stock ? String(it.stock).trim() : '';
      let v = false;
      if (nm) v = isAuctionYiZi(it, (it.code || getStockCode(nm) || ''));
      _yiZiCache.set(idx, v);
      return v;
    };
    // 题材组配色：仅成员>=2 的真实题材上浅色，不同题材不同色，"其它"不上色。
    // 融合模式（题材单独开启）下观察组行也要计入成组/上色，否则合并过来的观察组票拿不到背景色，
    // 视觉上仍像"两拨"，与「融合成一个整体」的诉求不符；叠加主排序时维持原口径（只按正式列表成组）。
    let _colorSourceMap = primaryTopicMap;
    if (topicOnlyMode) {
      _colorSourceMap = new Map(primaryTopicMap);
      renderList.forEach(function(it) {
        if (!it || !it.stock) return;
        const nm = String(it.stock).trim();
        if (!nm || _colorSourceMap.has(nm)) return;
        _colorSourceMap.set(nm, classifyStockPrimaryTopic(it, primaryTopicSize));
      });
    }
    // [NOT-FORMAL 2026-09-23] 题材【底色】刻意**不按正式成员过滤**（保留原口径）：
    //   底色只是「这几只属于同一个题材」的视觉分组，观察组继承行确实渲染在该组里，
    //   不给它们上色会让组看起来被腰斩。统计数字（统计条 / 趋势图 / 组间排序）才只数正式成员。
    //   ⚠️ 别顺手把 _listedNames 加进来 —— 加过一次，用户反馈「题材组内的底色不见了」。
    topicColorMap = buildTopicColorMap(_colorSourceMap, 2);

    // [DRAGON-SORT 2026-09-09] 题材【单独】开启时，同题材组内按龙头排名升序（龙一→龙二→龙三…）。
    // 排名必须在排序【之前】算好，所以这里先基于「主排序后的完整 renderOrder」算一版：
    // 该模式下 obsIndices=[] 且 regularIndices=renderOrder → fullOrder === renderOrder，与展示集合完全一致。
    // 叠加主排序 toggle 时不传 rankFn，组内保持原有相对顺序（既有口径一行不动）。
    if (topicOnlyMode) dragonRankMap = _buildDragonRankMap(renderOrder);
    renderOrder = sortByTopicGroups(
      renderOrder,
      renderList,
      resolveTopicTier,
      primaryTopicOf,
      topicOnlyMode && dragonRankMap
        ? (idx) => {
          const it = renderList[idx];
          const nm = it && it.stock ? String(it.stock).trim() : '';
          const dk = nm ? dragonRankMap.get(nm) : null;
          return dk ? dk.rank : null;
        }
        : null,
      yiZiOf,
      // [LISTED-TODAY 2026-09-23] 题材组的「一字数 / 组大小」只数【当天正式列表 auctionList 的行】。
      //   观察组 / 龙头【继承壳】（真正不在当天列表、由上方 _maybeInject* 注入的空壳）仍按题材落进
      //   对应组、照常渲染，但不贡献任何计数；它们正是被画成灰色的行 —— 所以「看到的灰行 == 不计数」，
      //   而「当天正式列表里的行（含 obs 继承但真抓到数据的）」既计数又不上灰，视觉与统计不再错位。
      //   ⚠️ 这是第 7 个参数 countableOf，⛔ 不能顶掉第 6 个 yiZiOf（顶掉就完全没有一字权重了）。
      (idx) => {
        const it = renderList[idx];
        const nm = it && it.stock ? String(it.stock).trim() : '';
        return nm ? _listedNames.has(nm) : false;
      }
    );
  }

  // [REFACTOR 2026-08-15] 从 auctionTagStore（云端标签真相）读已卖出集合，不读 stocksData
  const _confirmedSoldSet = (function() {
    const result = new Set();
    try {
      // §6/§8：标签唯一真相 = auctionTagStore（云端）
      const tags = useAuctionTagStore().tags;
      Object.keys(tags).forEach(function(d) {
        if (d > currentDate) return;
        const dayTags = tags[d] || {};
        Object.keys(dayTags).forEach(function(name) {
          if (dayTags[name] === 'sell') result.add(name.trim());
        });
      });
    } catch (e) {}
    return result;
  })();

  // [OBS-FIX 2026-08-14] _obsStocks / _obsBoughtSet / _isObsMember 已在函数顶部「视图注入」段统一定义，
  // 此处直接复用，确保「观察组归属口径」与「视图注入空壳行」完全一致（单一真相，杜绝两套定义分叉）。
  const _obsIndicesRaw = renderOrder.filter(i => renderList[i] && renderList[i].stock && _isObsMember(renderList[i].stock.trim()));

  // [OBS-STAR 2026-09-07] 正式成员豁免（双身份票 = UI 上打「*」的票：isObsMember && isFormalToday）。
  // 这类票本质是当日 9:25 正式成员，只是同时带「昨日观察组来源」身份。此前折叠观察组的三个分支
  // 把它们当成纯观察组壳：只要没命中该 toggle 的高光条件就 hidden → 正式成员从列表里凭空消失。
  // 用户口径：打* 的票按正式成员对待——永不隐藏、照常参与高光判定，命中时与常规高光票一起排在最前
  // （不单独给观察组做一套高光）。
  // [FIX 2026-09-09] 原实现直接查 _getAuctionWatchlistSet（「当日列表全集」，含观察组继承行），
  // 会把「纯观察组票」误判成今日正式成员 → 既让它享有"永不隐藏"豁免，又与打 * 口径分叉。
  // 改走 Data 层单一真相 _isAuctionFormalMember（行级 obsAutoAdded 优先），与 ctx.isFormalToday 同源。
  const _isFormalTodayMember = function(name) {
    return _isAuctionFormalMember(currentDate, name);
  };

  // [THREE-DAY 2026-08-17] 三天竞跌模式下，分组口径改为「达标(dd≥2)置顶 / 未达标在后」，
  // 不再按观察组/常规组分隔（解决"观察组永远排在前面"的问题）。真实 obs 身份仍由每行 itemClass/obsFormalStar 标记。
  // 注意：threeDayJingDieSet 已在上方题材分支前统一计算并复用，此处不再重复声明。

  let obsIndices, regularIndices, hiddenObsIndices;
  // [DRAGON-GROUP 2026-09-14] 龙头组索引：非空时模板在【观察组之上】渲染独立「龙头组」区块
  // （与观察组用蚂蚁线隔开）。其余模式折叠为 [] → 龙头只按「组内标记」体现在原列表中。
  let dragonIndices = [];
  if (topicOnlyMode) {
    // [TOPIC-MERGE 2026-09-09] 题材单独开启：观察组与常规组融合为【单一列表】。
    // - obsIndices=[] → 模板不再渲染观察组区块与蚂蚁线分隔（showObsSeparator 自动为 false）；
    // - regularIndices = 完整 renderOrder → 观察组继承票一条不丢，只按题材分组聚在一起；
    // - 排序已由上方 sortByTopicGroups 按「题材分组」处理（组大者居前、"其它"置底），
    //   观察组票按其题材落进对应组别，不再单独成块。
    obsIndices = [];
    regularIndices = renderOrder.slice();
    hiddenObsIndices = [];
  } else if (sortState.byThreeDayJingDie) {
    // [THREE-DAY 2026-08-17] 三天竞跌模式：折叠观察组（obsIndices=[]）→ 模板不再渲染观察组区块与蚂蚁线；
    // 所有股票（含不在今日正式列表的观察组票）进单一列表 → 总数与默认一致（90），不隐藏、不增不减（§6 唯一数据源=9:25 列表）。
    // 排序由上方 three-day 分支处理：dd≥2 达标置顶、同档按 auc_pct_chg（竞价涨幅）降序。
    obsIndices = [];
    regularIndices = renderOrder.slice();
    hiddenObsIndices = [];
  } else if (sortState.byWeakStrong) {
    // [WEAK-STRONG 2026-09-01] 参考「竞昨」toggle 的显示方式：折叠观察组区块（obsIndices=[]），
    // 不单独成块；弱转强达标（weakStrongSet 命中）或仅竞价转向（weakStrongTurnSet 命中）的观察组票并入主列表，
    // 由上方 byWeakStrong 排序分支统一排到前列（高光置顶、竞价转向次之）。其余未达标且非买入继承的观察组壳 → 隐藏。
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const matchesWeakStrong = (weakStrongSet && weakStrongSet.has(stockName)) || (weakStrongTurnSet && weakStrongTurnSet.has(stockName));
      const item = renderList[i];
      const hasTodayData = item && ((item.volume || '').toString().trim() !== '' || (item.yestVolume || '').toString().trim() !== '');
      const isBoughtInherited = _obsBoughtSet.has(stockName) && hasTodayData;
      // 打* 的正式成员永不隐藏（只按是否命中高光排先后），否则正式成员会从列表消失
      if (!matchesWeakStrong && !isBoughtInherited && !_isFormalTodayMember(stockName)) hiddenObsIndices.push(i);
    });
    obsIndices = [];
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
  } else if (sortState.byRatio) {
    // [VOL-GRAB 2026-09-05] 与「弱转强 / 竞昨」显示口径一致：折叠观察组区块（obsIndices=[]），
    // 达标的观察组票并入主列表，由上方 byRatio 排序分支统一置顶；未达标且非买入继承的观察组壳隐藏，
    // 否则整块观察组会渲染在高光票之前，导致「高光置顶」名不副实。
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const isQualified = !!(volGrabSet && volGrabSet.has(stockName));
      const item = renderList[i];
      const hasTodayData = item && ((item.volume || '').toString().trim() !== '' || (item.yestVolume || '').toString().trim() !== '');
      const isBoughtInherited = _obsBoughtSet.has(stockName) && hasTodayData;
      // 打* 的正式成员永不隐藏（同上，与弱转强分支口径一致）
      if (!isQualified && !isBoughtInherited && !_isFormalTodayMember(stockName)) hiddenObsIndices.push(i);
    });
    obsIndices = [];
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
  } else if (jingYestToggleChecked) {
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const item = renderList[i];
      const hasTodayData = item && ((item.volume || '').toString().trim() !== '' || (item.yestVolume || '').toString().trim() !== '');
      const isBoughtInherited = _obsBoughtSet.has(stockName) && hasTodayData;
      // 打* 的正式成员永不隐藏（同上，与弱转强分支口径一致）
      if (!matchesToday && !isBoughtInherited && !_isFormalTodayMember(stockName)) hiddenObsIndices.push(i);
    });
    obsIndices = [];
    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
  } else {
    // [DRAGON-GROUP 2026-09-14] 默认/平行模式（观察组区块可见）：把龙头组抽到最上方独立区块。
    //   ① 去重（需求 3）：一只票既是观察组又是龙头组 → 归龙头组，观察组里剔除（龙头组优先、排最前）；
    //   ② 龙头同时位于今日正式列表 → 打 *（需求 4，`dragonGroupFormalStar`，与观察组 `*` 同一套语义）；
    //   ③ 龙头「昨日在正式列表、今日不在」时，其空壳行已在上方注入 → 一并进龙头组（需求 4）。
    // 仅在【题材 toggle 未开】时抽出：题材模式下列表按题材重排，龙头改用「组内标记」辨认（需求 4），
    // 否则会出现「龙头同时在龙头区块和题材组里」的重复（避免混乱）。
    if (!sortState.byTopic && _dragonMap && _dragonMap.size > 0) {
      // 组内排序：按【十日区间涨幅】由高到低（需求：龙头组按十日涨幅降序）。
      // [DRAGON-GROUP 2026-09-15] 排序真相改为【名册本身】——先按名册排序，再映射到渲染行索引：
      //   旧写法是 `renderOrder.filter(命中) → 再 sort`，初始顺序取自 renderOrder，名册缺 pct 时
      //   会整体退化成「注入行在原列表里的位置」= 看着像乱序（用户实测「排序不对」）。
      //   现改为：① 名册按 pct 降序（缺失者殿后）→ ② 用 renderList 的 name→index 映射取行。
      //   这样「区块顺序 == 名册顺序」是结构保证，与 renderOrder / 注入位置无关。
      //   同幅 → 按题材名升序 → 按股票名升序（三级键，完全确定，不依赖插入顺序）。
      const _idxByName = new Map();
      renderList.forEach(function(row, i) {
        const nm = row && row.stock ? String(row.stock).trim() : '';
        if (nm && !_idxByName.has(nm)) _idxByName.set(nm, i);
      });
      dragonIndices = Array.from(_dragonMap.entries())
        .map(function(e) {
          const v = e[1] ? e[1].pct : null;
          const pct = (v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
          return {
            name: e[0],
            topic: (e[1] && e[1].topic) || '',
            pct: pct,
            idx: _idxByName.has(e[0]) ? _idxByName.get(e[0]) : -1
          };
        })
        .filter(function(x) { return x.idx >= 0; })
        .sort(function(a, b) {
          const pa = (a.pct === null) ? -Infinity : a.pct;
          const pb = (b.pct === null) ? -Infinity : b.pct;
          if (pb !== pa) return pb - pa;
          if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1;
          return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        })
        .map(function(x) { return x.idx; });
    }
    const _dragonSet = new Set(dragonIndices);
    obsIndices = _obsIndicesRaw.filter(function(i) { return !_dragonSet.has(i); }); // 去重：龙头不进观察组
    const _obsSet = new Set(obsIndices);
    regularIndices = renderOrder.filter(function(i) {
      return !_dragonSet.has(i) && !_obsSet.has(i);
    });
    hiddenObsIndices = [];
  }

  // 【_listedNames 已上移到 renderList 定义之后 —— 那里才是它唯一合法的位置：
  //  题材排序分支（sortByTopicGroups 的 countableOf）会同步调用它，声明写在下面会 TDZ 崩溃。】

  const ctx = {
    dataSource, date: currentDate, confirmedSoldSet: _confirmedSoldSet,
    isObsMember: _isObsMember,
    // 今日正式列表判定（worker 自动获取的最近多板成分股，含代码映射/手动新增的正式成员）。
    // [FIX 2026-09-09] 改走 _isAuctionFormalMember：观察组继承行（obsAutoAdded=true）不算今日正式成员，
    // 否则「昨天打过标签、今天不在 9:25 名单」的票会被误打 *（万向德农 9/9 就是这种情况）。
    // 与 _isFormalTodayMember（折叠豁免）同源，避免「显示星号」与「永不隐藏」两套标准。
    isFormalToday: function(name) {
      return _isAuctionFormalMember(currentDate, name);
    },
    // [LISTED-TODAY 2026-09-23] 「在不在当天正式列表里」的**统计/着色**口径。
    //   ⛔ 与上面的 `isFormalToday`（打 * / 折叠豁免）是【两套口径】，不要合并：
    //     · isFormalToday = _isAuctionFormalMember：排除 obsAutoAdded（万向德农 9/9 修复，用于 `*`）；
    //     · isFormalListed = auctionList / getTodayGroupList 成员：含 obs 继承但今天真抓到数据的行。
    //   用后者做统计判据，才能保证「显示在题材组里的行」与「统计数字 / 块顺序 / 趋势名次」不错位。
    //   §10：索引未就绪时 getTodayGroupList 退化为原始列表 ⇒ 全在列，⛔ 绝不整片刷灰。
    isFormalListed: function(name) {
      const nm = String(name === null || name === undefined ? '' : name).trim();
      if (!nm) return false;
      // 查上面那份集合（O(1)）：⛔ 不再逐行跑 _isAuctionFormalMember —— 它是 O(当日行数)，
      // 逐行调用 = O(n²)，题材模式下每次重算都要空转一遍。
      return _listedNames.has(nm);
    },
    // [DRAGON-GROUP 2026-09-14] 龙头组名册（股票名 → {topic,pct,groupSize,code}）。null = 未加载。
    // 供 _enrichAuctionItem 逐行读取（只读，不在 enrich 里评选 —— 单一真相在 dragon-group.js）。
    dragonMap: _dragonMap,
    prevAuctionList,
    prevAuctionMap: _prevMap,
    // [YIZI 2026-09-09] 题材 toggle 开关：竞价一字红线只在题材视图下计算/展示（与龙头徽章同一口径）
    byTopic: !!sortState.byTopic,
    // [LIMIT-STREAK 2026-09-11] 趋势/连板映射（股票名 → {streak,label}）。仅题材模式构建；
    // 非题材模式为 null → _enrichAuctionItem 里 streakLabel 恒为 ''（模板不渲染）。
    limitStreakMap: limitStreakMap,
    // [CLOSE-COUNT 2026-09-11] 该日是否已是收盘口径（当天 15:00 后 / 历史日期）。
    // false 时收盘涨幅不可信（= 竞价副本）→ 收盘红绿/停板/蚂蚁线一律不产出（§10 不用竞价数据冒充收盘结果）。
    closeWindow: closeWindow,
    tagStateCache: _buildTagStateCache(currentDate),
    jingYestToggleChecked,
    jingYestHighlightSet,
    sortByParallelEnabled: sortState.byParallel,
    parallelStocksToday,
    sortByRatioEnabled: sortState.byRatio,
    // 注：highRatioToday（原环比的今/昨比>=1.5 集合）已从 ctx 移除——高光改由 volGrabSet 判定，
    // 保留它只会误导后人以为高光仍走旧口径。它仅用于下方 stats.highRatioCount（「竞放量数」常驻统计）。
    sortByThreeDayJingDieEnabled: sortState.byThreeDayJingDie,
    threeDayJingDieSet: threeDayJingDieSet,
    sortByWeakStrongEnabled: sortState.byWeakStrong,
    weakStrongSet: weakStrongSet,
    volGrabSet: volGrabSet
  };
  // [DRAGON-GROUP 2026-09-14] 最终渲染顺序 = 龙头组 → 观察组 → 常规组（龙头组排最前，需求 3）。
  const fullOrder = dragonIndices.concat(obsIndices).concat(regularIndices);

  // 非「题材单独开启」时（叠加主排序 / 未开题材），fullOrder 可能与 renderOrder 不同
  // （折叠观察组会剔除未命中行）→ 必须按【最终展示集合】重算一次排名，避免被隐藏的票占用龙一位次。
  if (sortState.byTopic && !topicOnlyMode) dragonRankMap = _buildDragonRankMap(fullOrder);

  // [TOPIC-STATS 2026-09-10] 题材【单独开启】时，为每个题材块算一行统计小字（数量/一字/竞价高开/…）。
  // 统计口径与 sortByTopicGroups 的分组【完全同源】（同一个 primaryTopicOf、同一个渲染集合 fullOrder），
  // 杜绝"统计条数字和下面的行数对不上"。只在 topicOnlyMode 生效：叠加主排序时分组语义不同，不加。
  //
  // [TOPIC-SEQ 2026-09-11 重构] 统计条与「组内序号」都改为【在 items 上后置赋值】：
  //   · items 的顺序 = fullOrder = 最终渲染顺序（与分组口径天然一致）；
  //   · 每行已 enrich 好 isYiZi / aucPctNum / closePct / closeLimit，不必再重复解析一遍原始行；
  //   · 顺带把「同题材组内序号 seqNo」算出来（跨题材重置，1 起）——模板回退全局序号的逻辑不变。
  const items = fullOrder.map((i) => {
    const it = _enrichAuctionItem(renderList[i], i, ctx);
    if (it) {
      // 题材 toggle 开启时，给每行附上所属题材的浅色背景（未匹配/不足两只的题材为空 → 不上色）
      if (topicColorMap && primaryTopicOfForColor) {
        const tp = primaryTopicOfForColor(i);
        it.topicBg = (tp && topicColorMap.has(tp)) ? topicColorMap.get(tp) : '';
      } else {
        it.topicBg = '';
      }
      const dk = dragonRankMap ? dragonRankMap.get(it.stock) : null;
      it.dragonRank = dk ? dk.rank : 0;
      it.dragonPct = dk ? dk.pct : null;
    }
    return it;
  }).filter(Boolean);

  let topicStatsMap = null;
  if (topicOnlyMode && primaryTopicOfForColor) {
    const _rangeMap = getDragonRangePct(currentDate);
    // [LISTED-TODAY 2026-09-23] 只把【当天正式列表里的行】送进统计（观察组/龙头继承空壳不计数）。
    //   与上方 sortByTopicGroups 的 countableOf、下方趋势图 collectTopicDayStats 完全同一口径 ——
    //   三处同源才是「统计条数字 == 题材块顺序 == 趋势图名次」的结构性保证（不是靠三处各写一遍 if）。
    const _entries = items.filter(function(it) { return it.isFormalMember; }).map(function(it) {
      const rp = (_rangeMap && _rangeMap.has(it.stock)) ? _rangeMap.get(it.stock).pct : null;
      return {
        topic: primaryTopicOfForColor(it.index),
        name: it.stock,
        isYiZi: !!it.isYiZi,
        aucPct: _getThreeDayAuctionPct(renderList[it.index]),
        rangePct: (rp === undefined ? null : rp),
        // [CLOSE-COUNT 2026-09-11] 收盘口径下才带收盘涨幅（否则为 null → 逻辑层不产出该段）
        // ⚠️ 不再传 closeLimit：统计条的「停板 N涨停M跌停」按用户要求已移除（太占地方），
        //    停板只由股票名下蚂蚁线表达（见本文件 closeLimit 字段 + AuctionBoardTable）。
        closePct: it.closePct
      };
    });
    topicStatsMap = buildTopicStatsMap(_entries);

    // 统计条挂到每个题材块的【第一行】（其余行 null）；同时给出组内序号。
    // 二者共用同一个「题材切换」判断，保证统计条所在行 === 序号从 1 重新开始的那一行。
    // ⚠️⚠️ 落点必须是块的【第一行】，⛔ 不能跳过灰色行去找「第一行正式成员」（2026-09-23 事故）：
    //   统计条是整块的【表头】（flex-basis:100% 的整行），挂在第二行 ⇒ 第一行会渲染在统计条【上面】，
    //   看起来就像"飘在题材组外面"。而块首恰恰常是龙一（rankFn 排第一）—— 会稽山 / 澳弘电子
    //   作为各自题材的龙一，就是这样被挤出组外的。表头本来就属于整块，不属于某一行。
    let lastTopicKey = null;
    let seqInTopic = 0;
    let statsAssigned = false;
    items.forEach(function(it) {
      const tp = (primaryTopicOfForColor(it.index) || '其它').trim() || '其它';
      // [YIZI-SUP 2026-09-20] 把「本行所属题材组」原样透出（值就是上面这个 tp，零额外计算）：
      // 「补竞价一字」按题材融入时要定位到具体分组，见 _enrichAuctionItem 里 groupTopic 的说明。
      it.groupTopic = tp;
      if (tp !== lastTopicKey) {
        lastTopicKey = tp;
        seqInTopic = 0;
        statsAssigned = false;
      }
      if (!statsAssigned) {
        it.topicStats = topicStatsMap.get(tp) || null;
        statsAssigned = true;
      } else {
        it.topicStats = null;
      }
      seqInTopic++;
      it.seqNo = seqInTopic;
    });
  } else {
    // 非「题材单独开启」：不加统计条，序号保持 0 → 模板沿用原来的全局序号（行为不变）
    items.forEach(function(it) { it.topicStats = null; it.seqNo = 0; it.groupTopic = ''; });
  }

  return {
    date: currentDate,
    dataSource,
    rawCount: auctionList.length,
    items,
    obsIndices,
    regularIndices,
    // [DRAGON-GROUP 2026-09-14] 龙头组索引（第一页最上方独立区块）。[] = 该模式/该日无龙头组区块。
    dragonIndices,
    hiddenObsIndices,
    weakStrongSet,
    volGrabSet,
    stats: {
      todayStrength,
      yesterdayStrength,
      strongCount,
      totalCount,
      highRatioCount: highRatioToday.count,
      // [FIX 2026-08-17] 竞/昨数口径统一为「渲染列表 ∩ 当日竞昨全集」（与蓝色高光完全一致）。
      // 原先只统计 auctionList（正式列表）→ 8/14 显示 16，而蓝色高光（含观察组注入壳）显示 18，
      // 两者对不上（用户反馈）。渲染列表 = 正式列表 + 观察组注入壳，二者同源判定，数字必然一致。
      jingYestCount: renderList.filter(it => it && it.stock && jingYestHighlightSet && jingYestHighlightSet.has(it.stock.trim())).length
    }
  };
}
