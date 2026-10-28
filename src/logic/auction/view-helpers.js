import { getTodayGroupList, getGroupData, getAuctionData } from '../app-core-api.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
// 注：getDigitCount / getNumericVolume 原为「环比」旧口径（今/昨比 + 位数差）服务，
// 2026-09-05 环比重构为「量比抢筹」后已无引用，故从 import 中移除（避免 dead code）。
// [TWO-MODES 2026-10-02] getRatioDiffInfoForDate 已随「平行」主排序分支（digitGap/diff 那套）
// 一并删除——平行 toggle 被「一字」toggle 占用、平行并入竞/昨，该函数在本文件再无引用（§16）。
import { getHighRatioStocksForDate, getParallelStocksForDate, getJingYestHighlightSetForDate } from './sort-rules.js';
import { ensureBoughtStocksForDate, ensureObservationStocks, deriveAuctionTagState, _buildTagStateCache } from '../tagTitles/rules.js';
// ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「竞价口径」toggle 的取值入口（把十日 / 20日涨幅
//   的今天那一根腿反解回 9:25 竞价）。⛔ 只读、本层不请求 —— 取数由 useAuctionBoard 的 watch 触发。
import { getAuctionLegRange10, getAuctionLegRange20 } from './auction-leg-ranges.js';
// [RANGE-PCT 2026-10-14 用户口径] 「十日涨幅」toggle 的排序纯函数（由高到低 / 缺数据置底 / 稳定）。
// 数据源 = getDragonRangePct(currentDate)（云端 stock_range_pct，与题材龙位徽章同源，§6）。
import { sortIndicesByRangePct } from './range-pct-sort.js';
// [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle（开关位由原「量比抢筹」改造）的取数入口。
//   与十日涨幅的最大差别：云端【没有】20 日行（表主键 (date,stock)，20 日行会覆盖 10 日行）
//   ⇒ 数据由 range20.js 在客户端按 20 个交易日复利现算、只放会话内存（详见该模块文件头）。
import { getRange20Pct } from './range20.js';
// [RANGE20-TOP5 2026-10-19] 「20日涨幅前五 · 龙头补位」：候选池 = 近 20 个交易日【每天正式列表】的并集
//   （⛔ 不是当天列表），只主板、取前五；当天列表里没有的注入独立区块（打「20天」标）。
//   ★ 只读本模块的会话内存（ref-driven），⛔ 本层不请求、不落库（取数由 useAuctionBoard 的 watch 触发）。
import { getRange20Leaders } from './range20-leaders.js';
import { getStockCode } from '../../data/stock-code-map.js';
// [AVG-VRATIO 2026-10-01 用户口径] 题材统计条最上面一行「平均竞价量比」的取值入口：
//   读某只股票【某日】的当日竞价量比（倍数，如 2.18）。
//   ⚠️ 2026-10-01 下午：字符串→数字的适配点【收归 Data 层】getAucVolRatio（§6 单一真相）——
//     同一口径现在有两个使用方（本文件的统计条 + topic-trend.js 的五日趋势图），
//     各写一份 Number() 适配必然分叉。此处只负责"取哪个字段、什么时候取"。
import { getAucVolRatio } from '../../data/watchlist-helpers.js';
import { _getAuctionWatchlistSet, _isAuctionFormalMember } from '../../data/watchlist-and-metrics.js';
import { state } from '../app-state.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';
import { getAuctionTagState } from '../ui-bridge.js';
import { getDisplayNote } from '../note/helpers.js';
import { useUiStore } from '../../stores/uiStore.js';
import { getStockTopicCount, getStockTopicsDisplay, getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap, sortByTopicGroups, buildTopicColorMap, TOPIC_ORDER_VOL_RATIO, TOPIC_ORDER_YIZI } from './topic-sort.js';
// [YIZI 2026-09-09] 竞价一字（竞价涨停）：行级红线标记 + 题材组间排序权重，单一真相在 limit-up.js。
// [CLOSE-LIMIT 2026-09-11] 同模块新增 getCloseLimitState：收盘涨停/跌停（蚂蚁线标记 + 题材统计）。
// [CLOSE-NAME-COLOR 2026-09-11] 同模块新增 getCloseNameTone：收盘涨幅 → 股票名字体颜色档位。
import { isAuctionYiZi, parseAucPct, formatAucPct, getCloseLimitState, getCloseNameTone, isHighLimitBoard } from './limit-up.js';
// [BOARD-SEQ 2026-10-25 用户口径] 区间涨幅模式（十日 / 20日）的「序号」= 主板名次（非主板不占号），
//   让屏幕序号与规则文案里的「第 N 名」用同一把尺子。判据/口径唯一实现在 board-seq.js（纯函数、可单测）。
import { buildMainBoardSeq } from './board-seq.js';
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
// 此处同步读取（与 range20 / suspend 同款 ref-driven 范式：异步取数 → 模块级 ref 发布 → 本文件同步读），
// 题材 toggle 开启时才参与计算。
// [TOPIC-STATS 2026-09-10] 题材块统计条（数量/一字/竞价高开/龙头…）：纯函数在 topic-stats.js
import { buildTopicStatsMap } from './topic-stats.js';
// [SEAL-VOLUME 2026-10-11] 封单量（手）的同步读取器：读 Data 层 limit_pool 内存缓存（§6 单一真相），
//   ⛔ 本文件不发请求、不消费猫抓额度 —— 「什么时候把 limit_pool 读进缓存」由组合式负责。
import { sealLotsOf } from './seal-volume.js';
// [DRAGON-GROUP 2026-09-14] 龙头组（第一页【观察组上方】的独立区块）：名册由 logic/auction/dragon-group.js
// 异步加载后经模块级 ref 暴露，此处【同步读取】（与 dragon-rank 同款 ref-driven 范式，绝不阻塞渲染）。
// 名册是唯一真相（§6）：本文件只负责「读名册 → 注入空壳行 → 给出 dragonIndices → 观察组去重」，
// 绝不在这里二次评选龙头（那样就是第二个真相源）。
import { getDragonLeadersForDisplay } from './dragon-group.js';
// [INHERIT-SELL 2026-09-23] 「昨日『卖』标签继承过来的复盘行」判定抽成独立模块：
// view-helpers（当天统计 + 着色）与 topic-trend（五日趋势）共用同一份判据（§6 单一真相）。
import { getPrevSoldInheritedSet } from './inherited-sold.js';
// [SUSPEND 2026-10-13] 当日停牌（上游无竞价/无成交）判定：数据由 suspend.js 异步加载后经模块级
// ref 暴露，此处【同步读取】——与 dragon-rank / dragon-group 同款 ref-driven 范式，绝不阻塞渲染、
// 不在此处发请求。判定单一真相在 suspend.js（§6）；本文件只把结果挂到行上供模板显示。
import { isSuspended } from './suspend.js';
// [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「20日涨幅」toggle 专属显示层：前五标「总龙一…总龙五」。
//   纯函数独立成模块（可单测），⛔ 与其它 toggle 的显示口径无关 —— 其它模式一律不标。
import { assignTotalDragonRanks, RANGE20_TOTAL_DRAGON_TOP_N } from './range20-top5-label.js';
// [PRESENCE 2026-10-23 用户口径] 「涨幅前十 · 在列次数」标签（「5次在列」「首次在列」）：
//   判定/文案全在 presence-label.js（纯函数、可单测），次数来自预计算表 auction_presence
//   （Data 层 auction-presence.js，⛔ 本层不发请求，只同步读会话缓存）。
import { assignPresenceLabels, PRESENCE_TOP_N, PRESENCE_WINDOW_10, PRESENCE_WINDOW_20 } from './presence-label.js';
import { getPresenceForDate } from '../../data/auction-presence.js';
// [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」模式下占比列 → 【名次变化】：
//   算法在 range20-rank-delta.js（纯函数、可单测），昨日名次来自 data/range20-prev-rank.js 的会话缓存
//   （⛔ 本层不发请求；取数由 useAuctionBoard 的 watch 触发 ensureRange20PrevRank）。
import { buildRange20RankDelta, RANGE20_DELTA_UNKNOWN_TEXT } from './range20-rank-delta.js';
import { getRange20PrevRankForDate } from '../../data/range20-prev-rank.js';

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
  return useAuctionTagStore().getTagState(date, stockName);
}

// ===== 「当日竞价涨幅 auc_pct_chg」读取器（原「三天竞跌」功能的私有助手，2026-10-14 保留）=====
// 三天竞跌已整体下线（开关位改为「十日涨幅」），但这个读取器仍被两处使用，故保留：
//   · 竞/昨（byJingYest）同档内按当日竞价涨幅降序 —— 与改造前逐字一致；
//   · 题材统计条条目里的 aucPct（竞价高开计数）。
// 取值只认专用字段 auc_pct_chg（五日竞价涨幅），绝不读 changePct/change_pct ——
//   后者会被「获取涨幅」(fuyao 快照 price_change_ratio_pct) 改写为当日常规涨幅，导致误判。
function _auctionPctOf(rawItem) {
  if (!rawItem) return null;
  const raw = rawItem.auc_pct_chg || rawItem.aucPctChg || rawItem.changePct || rawItem.change_pct || '';
  const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
  return isFinite(num) ? num : null;
}

// [AVG-VRATIO 2026-10-01] 当日竞价量比（倍数）的读取器已收归 Data 层 getAucVolRatio
//   （market_metrics(scope='auction').auc_vol_ratio，字符串→数字唯一适配点，§6 / §10：
//    缺值一律 null，⛔ 绝不当 0）。原先这里有一份私有副本 _readAucVolRatio，已删除 ——
//    趋势图（topic-trend.js）要用同一个值，两份实现必然在某个边界上分叉。

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
  // [TWO-MODES 2026-10-02 用户口径] ⛔ 原来的 `isParallelMatch`（平行单独开启时的绿色左边条）已删除：
  //   平行 toggle 已被「一字」toggle 占用，平行随之【并入竞/昨】（竞/昨 的 tier1 就是平行档）。
  //   ⇒ 该分支在删掉开关后【永远不成立】，属于死代码（§16）；平行的绿色边条也随之取消。
  //   用户在 AskUserQuestion 里明确选「保留现有『竞/昨』口径」，所以没有把这枚边条搬到竞/昨下面。
  // [RANGE20 2026-10-19 用户口径] ⛔ 原「量比抢筹」行级高光（isHighRatioMatch → .high-ratio 左侧橙条）
  //   已随该 toggle 一起【整体删除】：开关位改成的「20日涨幅」是【全列表排序 + 逐行标数值】，
  //   与「十日涨幅」同款，不产生任何行级高光（高光的存在意义是"挑出达标的那几只"，全列表排序下无意义）。
  //   ⚠️ 「竞放量数」(highRatioToday，今/昨比>=1.5) 是【常驻统计】，与 toggle 开关无关，保持原样不动。
  // [RANGE-PCT 2026-10-14] ⛔ 原「三天竞跌」绿色高光（isThreeDayJingDieMatch / three-day-jing-die）
  //   已随该 toggle 一起【整体删除】：新 toggle「十日涨幅」是【全列表排序 + 逐行标数值】，
  //   不产生任何行级高光（绿色左竖条的存在意义就是"挑出达标的那几只"，全列表排序下无意义）。
  // [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] ⛔ 原「弱转强」行级高光（isWeakStrongMatch → `.weak-strong`
  //   左侧绿条）已随该 toggle 整体下线（开关位换成「竞价口径」，它是口径修饰开关、不产生任何高光）。
  if (isJingYestMatch) {
    itemClass += ' jing-yest-match';
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
  // [RANGE20-TOP5 2026-10-19] 该股是否是「20日涨幅前五补位」注入的票（见 computeAuctionViewData 的注入段）。
  //   meta 里带 pct/days ⇒ 行上恒显示它的 20 个交易日区间涨幅（不需要打开 20日涨幅 toggle）。
  const _r20Meta = (ctx.range20LeaderMeta && stockName) ? ctx.range20LeaderMeta.get(stockName) : null;

  // [YIZI 2026-09-09] 竞价一字（竞价涨幅达到该股涨停幅度）→ 股票名下方红色下划线标记。
  // 仅题材 toggle 开启时判定（与龙头徽章同一显示口径），避免无谓计算。
  // 代码取行上 code 字段，缺则查内存代码映射；都缺时按主板 10% 兜底（limit-up.js 内处理）。
  // 展示文本只认专用竞价涨幅字段 auc_pct_chg（changePct 会被「获取涨幅」改写成常规涨幅，不能混用）
  const _aucPctNum = parseAucPct(rawItem.auc_pct_chg || rawItem.aucPctChg || '');
  const _yiZiCode = rawItem.code || (stockName ? getStockCode(stockName) : '') || '';
  const isYiZi = ctx.byTopic ? isAuctionYiZi(rawItem, _yiZiCode) : false;
  // 格式化搬到 limit-up.js#formatAucPct（与 parseAucPct 配对，§6 单一实现）：
  // 决策看板卖点行的「竞价涨幅」标签用的是同一个函数，⛔ 不再各处手写 toFixed(2)。
  const aucPctText = formatAucPct(_aucPctNum);

  // [SUSPEND 2026-10-13] 当日停牌：上游（猫抓/同花顺）都拿不到它的竞价与成交，于是本行的
  // 竞价量/占比会显示 '-' —— 外观与「上游没抓到数据」完全一致、极易误读（2026-10-13 新华传媒
  // 600825.SH 实例）。这里只【同步读】suspend.js 已加载好的结果（判定与取数都在那边，§6 单一真相），
  // 命中 → 模板在股票名旁挂「停牌」小标。判不出来（历史日期 / 接口不可用）→ false，不标（§10）。
  const suspended = isSuspended(ctx.date, stockName);

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
    // [RANGE20-TOP5 2026-10-19 用户口径] 「20日涨幅前五补位」字段（只读 ctx 传进来的会话内存）。
    //   · range20Leader → 模板据此打「20天」标签（用户：「要区分，就在后面添加标签"20天"」）；
    //   · range20LeaderPct / Days → 该票【20 个交易日区间涨幅】与其有效天数（区块与行上展示，
    //     它就是这个功能存在的理由，⚙ 与 rangePct20「只有 toggle 打开才显示」是两回事 —— 这个恒显示）；
    //   §10：没取到就 null / 0，⛔ 不显示成 0%。
    range20Leader: !!_r20Meta,
    range20LeaderPct: _r20Meta ? _r20Meta.pct : null,
    range20LeaderDays: (_r20Meta && _r20Meta.days) ? _r20Meta.days : 0,
    // [FEAT 2026-08-20] 题材 toggle：题材数量（供排序）与题材展示文本（供题材列显示）
    topicCount: getStockTopicCount(rawItem),
    topicsDisplay: getStockTopicsDisplay(rawItem),
    // [YIZI 2026-09-09] 竞价一字（竞价涨停）→ 股票名下红线；aucPctText 仅用于悬停提示
    isYiZi,
    aucPctText,
    // [SUSPEND 2026-10-13] 当日停牌（上游无竞价/无成交）→ 股票名旁「停牌」小标。
    // 数据来源 = suspend.js（同花顺 fuyao 判定，唯一实现）；本字段只读，模板不做任何判定。
    suspended,
    // [SUSPEND 2026-10-13] 该行解析出的代码（无则空串）。原为 _yiZiCode 局部变量，现一并出口：
    // suspend.js 需要「股票名 → 代码」调上游批量接口，看板侧直接从已 enrich 的 items 取用，
    // 不必各自回查一遍映射（§32 不重复请求 / 不重复解析）。
    code: _yiZiCode,
    // [DRAGON-COLOR 2026-09-11] 龙头徽章（龙一/龙二…）配色依据 = 当天竞价涨幅数值。
    // 取值只认专用竞价涨幅字段 auc_pct_chg（与上方 _aucPctNum 同一个值，零额外计算、
    // 无请求、不落库）：>0 红、<0 绿、=0 灰；null = 该股当日无竞价涨幅数据（按中性灰，不当 0 处理）。
    // 绝不复用 changePct/change_pct —— 后者会被收盘覆盖改写成收盘涨幅，颜色会跟着收盘变，
    // 与「跟随当天竞价涨幅」的需求不符。
    aucPctNum: _aucPctNum,
    // [RANGE-PCT 2026-10-14 用户口径] 「十日涨幅」toggle 下每行显示的数值（= 该模式排序键）。
    //   来源 = ctx.rangePctMap（云端 stock_range_pct，与题材龙位徽章同源，§6）。
    //   §10：未能取到 → null（模板不渲染该数值，⛔ 绝不当 0 或 '-' 显示）。
    //   ⚠️ 与 dragonGroupPct 的区别：后者是【昨日名册】里记下的十日涨幅（只对龙头组行有值，
    //     且用于默认模式的龙头区块）；本字段是【当日】十日区间涨幅，任何行都可能读到。
    rangePct: (function() {
      if (!ctx.sortByRangePctEnabled || !ctx.rangePctMap || !stockName) return null;
      const _e = ctx.rangePctMap.get(stockName);
      if (!_e) return null;
      const _v = _e.pct;
      if (_v === null || _v === undefined || _v === '') return null;
      const _n = Number(_v);
      return isFinite(_n) ? _n : null;
    })(),
    // [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle 下每行显示的数值（= 该模式排序键）。
    //   来源 = ctx.rangePct20Map（range20.js 现算的 20 个交易日复利区间涨幅，见该模块文件头）。
    //   §10：未能取到 → null（模板不渲染，⛔ 绝不当 0 显示）。
    //   `rangePct20Days` = 实际参与累乘的交易日数（停牌/缺数据会 < 20）——
    //     只用于悬停提示「n/20日」，⛔ 不参与排序、不进模板计算（§21）。
    rangePct20: (function() {
      if (!ctx.sortByRangePct20Enabled || !ctx.rangePct20Map || !stockName) return null;
      const _e = ctx.rangePct20Map.get(stockName);
      if (!_e) return null;
      const _v = _e.pct;
      if (_v === null || _v === undefined || _v === '') return null;
      const _n = Number(_v);
      return isFinite(_n) ? _n : null;
    })(),
    rangePct20Days: (function() {
      if (!ctx.sortByRangePct20Enabled || !ctx.rangePct20Map || !stockName) return 0;
      const _e = ctx.rangePct20Map.get(stockName);
      const _d = _e ? Number(_e.days) : 0;
      return isFinite(_d) && _d > 0 ? _d : 0;
    })(),
    // ★★ [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」模式下，占比列改成【名次变化】：
    //   对比昨日排名，上升 = 红色 +N，下降 = 绿色 -N（口径与算法全在 logic/auction/range20-rank-delta.js）。
    //   · 默认 null / '' —— 只有该 toggle 打开、且昨日名次表已到货时才赋值（§11 默认无行为）；
    //   · 必须显式给默认值：items 会被增量视图缓存复用，缺省值不一致会让名次变化串到别的模式里；
    //   · §10：昨日名次判不出 ⇒ 文案 '—'（⛔ 绝不用 0 冒充「没变化」）。
    range20RankDelta: null,
    range20RankDeltaText: '',
    range20RankDeltaTone: '',
    // [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「20日涨幅」toggle 专属的「总龙一…总龙五」名次。
    //   默认 0 / ''（= 不打标），只有该 toggle 打开时由 range20-top5-label.js 后置赋值 1..5。
    //   ★ 为什么在这里给【默认值】而不是只在那个模式里写：items 会经增量视图缓存复用，
    //     若只有某个模式写、其它模式不写，切 toggle 时残留的旧标签会串到别的视图里（§11 默认无行为）。
    totalDragonRank: 0,
    totalDragonLabel: '',
    // [PRESENCE 2026-10-23 用户口径] 「在列次数」标签的默认值 = 不标。
    //   只有「10日涨幅」/「20日涨幅」toggle 打开时才由 presence-label.js 后置赋值。
    //   ⚠️ 必须在这里显式给默认值（而不是只在那个模式里写）：items 会经增量视图缓存复用，
    //     缺省值不一致会让标签在切 toggle 后串到别的视图里（§11）。
    presenceCnt: null,
    presenceLabel: '',
    // [RANK-BOX 2026-10-24 用户口径] 序号「小方框」的 class（前十 + 主板 + 有在列次数才给），
    //   与 presenceLabel 同源同生灭；默认 '' ⇒ 序号照旧是纯数字（§11 默认无行为）。
    //   必须与上面几个字段一样显式给默认值，理由完全相同：行对象会被增量视图缓存复用。
    presenceRankClass: '',
    presenceWindowDays: 0,
    presenceCoveredDays: 0,
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
    // [BOARD-SEQ 2026-10-25 用户口径] 区间涨幅模式（十日 / 20日）下改由 buildMainBoardSeq 赋「主板名次」
    //   （非主板不占号），见下方 items 后置赋值那一段。
    seqNo: 0,
    // [BOARD-SEQ 2026-10-25 用户口径] 「这一行序号列留空」（= 非主板，位置不变但不占序号）。
    //   只在区间涨幅模式里可能为 true；模板读它决定「显示空」还是「显示 seqNo / 行号」。
    //   默认 false ⇒ 其它模式渲染与改动前逐字一致（§11）。
    seqBlank: false,
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
    return { items: [], obsIndices: [], regularIndices: [], dragonIndices: [], range20LeaderIndices: [], hiddenObsIndices: [], stats: { todayStrength: null, yesterdayStrength: null, strongCount: 0, totalCount: 0, highRatioCount: 0, jingYestCount: 0 }, rawCount: 0, date: currentDate, dataSource };
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

  // ============================================================
  // [RANGE20-TOP5 2026-10-19 用户口径] 「20日涨幅前五」补位行注入
  //
  // 用户原话：「当天我怕错过一些不在正式列表的市场龙头……比如今天的九阳股份，如果它不是继承上交易的
  //   龙头组，就消失了，我就看不见了……如果消失了，我看这个20天涨幅就没多大意义，就不准确。」
  //   「如果这五只也在当天列表中，那就不用重复补了。……要自动补上去，补到龙头组。……要区分，
  //    就在后面添加标签"20天"。」
  //
  // 与龙头组注入【同一条管线】（_injectedRows → renderList）：⛔ 不写 auctionData、⛔ 不推云端
  //   （§6 不产生影子记录）。当日云端若有同名行（worker 已并入抓取名单）就复用它的行情字段，
  //   否则是空壳 + 后续 enrich/数据层照常补 —— 用户要求「进入列表后也是一样可以获取数据」。
  //
  // ⚠️ 三条去重（用户「不用重复补」）：
  //   ① 已在当天正式列表里（_existingNames）→ 不注入；
  //   ② 已被龙头组注入（_injectNames）→ 不注入（它已经在龙头组区块里出现了）；
  //   ③ 已注入过的同一只（_range20Names）→ 不注入。
  //   ⇒ 只有「真·当天看不见的 20 日强势票」才会被补进来，绝不重复。
  // ============================================================
  const _range20Leaders = getRange20Leaders(currentDate);   // null = 该日还没有结论（§10 区别对待）
  const _range20Names = new Set();                          // 本次真正补进来的股票名
  const _range20Meta = new Map();                           // 股票名 -> {pct, days}（区块/行上显示用）
  function _maybeInjectRange20Leader(meta) {
    const n = meta && meta.stock ? String(meta.stock).trim() : '';
    if (!n) return;
    if (_existingNames.has(n) || _injectNames.has(n) || _range20Names.has(n)) return;
    _injectNames.add(n);
    _range20Names.add(n);
    _range20Meta.set(n, { pct: meta.pct, days: meta.days });
    const dayRow = _auctionDayRowMap.get(n);
    if (dayRow && dayRow.obsAutoAdded !== true) {
      // 当日云端有同名行（market_metrics 影子行）→ 复用其 volume/yestVolume/note/changePct，不留空壳
      _injectedRows.push(Object.assign({}, dayRow, { range20AutoAdded: true }));
    } else {
      _injectedRows.push({
        stock: n,
        code: (meta && meta.code) || getStockCode(n),
        volume: '', yestVolume: '', note: '',
        range20AutoAdded: true
      });
    }
  }
  if (_range20Leaders && _range20Leaders.length) {
    _range20Leaders.forEach(_maybeInjectRange20Leader);
  }

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

  // [TWO-MODES 2026-10-02] sortState 形状：`byParallel` 已删除（平行 toggle → 一字 toggle，
  //   平行并入竞/昨），新增 `topicOrderBy`（题材 / 一字两个 toggle 的【排序口径】，见 topic-sort.js）。
  //   ⚠️ 下面两处是【兜底默认值】：正常路径走到的是 store 里那一份（由 useAuctionBoard 维护）。
  //   [SWITCH-PICK 2026-10-02] 默认值 = 一字，必须与 auctionStore#createSortState 保持一致
  //     （§6：同一份状态在两处的默认值不同，会让「store 读不到」这一瞬间的口径跳变）。
  // [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] `byWeakStrong` 已随「弱转强」toggle 整体下线，
  //   开关位换成 `byAuctionLeg`（竞价口径）。⚠️ 键名 / 默认值必须与 useAuctionBoard#sortState
  //   和 auctionStore#createSortState 逐字一致（§6：三处默认值不同，会让「store 读不到」那一瞬间
  //   的口径跳变）。默认关闭 = 收盘口径，与加本功能之前逐字相同（§11）。
  const _defaultSortState = { byAuctionLeg: false, byRangePct20: false, byJingYest: false, byJingYestRatio: false, byRangePct: false, byTopic: false, topicOrderBy: TOPIC_ORDER_YIZI };
  let sortState;
  if (sortStateOverride) {
    sortState = sortStateOverride;
  } else {
    try {
      const store = useAuctionStore();
      sortState = store && store.sortState ? store.sortState[_p] : _defaultSortState;
    } catch {
      sortState = _defaultSortState;
    }
  }

  // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 「十日 / 20日涨幅 用哪一套口径」的【唯一分支点】。
  //   打开 = 9:26 竞价口径（历史日期 / 收盘后回看时，用它对齐「早上看到的那一批」）；
  //   关闭 = 收盘口径（云端原值，逐字回到旧行为）。
  //   ⛔ 排序键与行上数值必须取【同一个 Map】（§6：两处口径一旦分叉，就会出现「排序对不上数字」）。
  //   §10：竞价口径那一侧还没读到 / 判不出 ⇒ 返回 null ⇒ 行上不显示数值、排序按「缺数据置底」，
  //        ⛔ 绝不悄悄拿收盘口径顶替（那等于拿错尺子冒充对尺子）。
  const _range10MapFor = function() {
    return sortState.byAuctionLeg ? getAuctionLegRange10(currentDate) : getDragonRangePct(currentDate);
  };
  const _range20MapFor = function() {
    return sortState.byAuctionLeg ? getAuctionLegRange20(currentDate) : getRange20Pct(currentDate);
  };

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

  // [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] ⛔ 原「弱转强达标集合 / 竞价转向集合」两行已随
  //   「弱转强」toggle 整体下线（用户：「把原来弱转强toggle功能去掉换成我说的竞价口径toggle」）。
  //   连带删掉的不只是这两行：sort-rules-extra.js 整个文件（它就是为弱转强而存在的）、
  //   Data 层 getAuctionChangePctHistory（唯一消费者就是它）、行级高光 `.weak-strong`、
  //   增量指纹里的 `ws=` 令牌 —— 半旧半新是 §16 明令禁止的状态。

  // [RANGE20 2026-10-19] ⛔ 原「量比抢筹」达标集合（volGrabSet = getVolGrabSet(...)）已随该 toggle 删除：
  //   新开关「20日涨幅」的数据源是 range20.js 的会话内存 Map（下方 ctx 里按需读取），
  //   ⛔ 不再有「每行查一个达标集合」这种行级判定。

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

  // [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] ⛔ 这里原有 `if (sortState.byWeakStrong) { … }` 三档排序
  //   （tier0 高光 = 连跌≥2 且竞价转向 / tier1 仅竞价转向 / tier2 其余），整段已随「弱转强」toggle 删除。
  //   开关位由「竞价口径」占用 —— 但那是一个【口径修饰开关】，不是一个主排序档，
  //   所以它【不在这里占分支】，而是改由下面的 `_range10MapFor / _range20MapFor` 决定
  //   十日 / 20日涨幅用哪一份数值（见上方那两个函数的注释）。
  if (sortState.byJingYest) {
    // [FIX 2026-08-18] 同档排序按「当天竞价涨幅 auc_pct_chg」由高到低。
    //   分档条件不变：tier0=竞昨高光(平行+diff>0) / tier1=仅平行 / tier2=其它。
    //   原 digitGap+diff 排序键废弃，改用 _auctionPctOf（专用竞价涨幅字段）。
    //   [RANGE-PCT 2026-10-14] 本分支一行未动：「三天竞跌」下线不影响它 ——
    //     它历史上的「同档按竞价涨幅」只是因为当时两个 toggle 共用同一个读取器，不是同一套口径。
    // [RANGE-PCT 2026-10-14 §32 不重复调用] 这里原先【第二次】调用了
    //   getParallelStocksForDate(currentDate, dataSource) —— 而同一份结果在本函数上方
    //   （`parallelStocksToday`，resolveTopicTier 也在用）早就取过一次，参数完全相同。
    //   同一天同一数据源取两遍，即便上游有指纹缓存，也要白构建一次覆盖全表的指纹串。
    //   现改为复用同一个 Set（§6 单一真相：口径不可能分叉，因为就是同一个对象）。
    const parallelStockNamesForSort = parallelStocksToday;
    renderOrder = renderOrder.map((idx, pos) => {
      const it = renderList[idx];
      const stockName = it && it.stock ? it.stock.trim() : '';
      const isParallel = parallelStockNamesForSort.has(stockName);
      const isHighlight = stockName && jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
      const pctVal = _auctionPctOf(it);
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
  } else if (sortState.byRangePct) {
    // [RANGE-PCT 2026-10-14 用户口径] 「十日涨幅」toggle（开关位由原「三天竞跌」改造）：
    //   ★ 全部股票（龙头组 + 观察组 + 常规组，不分块）按「近 10 个交易日区间涨幅」由高到低排。
    //   用户原话：「我点击十日涨幅 toggle 后，十日涨幅由高到低排序，并标上十日涨幅数据。
    //   所有的股票都要排，包括龙头组，观察组，常规组。这样我就清楚找到市场总龙头。」
    //   数据源 = getDragonRangePct(currentDate)（云端 stock_range_pct，与题材龙位徽章/决策看板
    //   排名同一个来源同一个字段，§6 单一真相）；同步读取，**0 网络请求、0 猫抓额度**。
    //   §10：Map 未加载（null）或某行缺数据 → 该行置底且不参与 pct 比较（⛔ 绝不补 0）。
    //   ⚠️ 数据未到时不假装有值：ensureDragonRangePct 一发布新 Map，指纹变化会自动重算本视图。
    //   排序实现（含稳定/置底口径）收敛在 range-pct-sort.js 纯函数里，可独立单测（§15/§42）。
    const _rangeMap = _range10MapFor();
    renderOrder = sortIndicesByRangePct(renderOrder, renderList, _rangeMap);
  } else if (sortState.byRangePct20) {
    // [RANGE20 2026-10-19 用户口径] 「20日涨幅」toggle（开关位由原「量比抢筹」改造）：
    //   ★ 全部股票（龙头组 + 观察组 + 常规组，不分块）按「含今天在内的 20 个交易日区间涨幅」
    //     由高到低排，并逐行标出该数值 —— 与「十日涨幅」同款，只是时间段不同。
    //   用户原话：「和十日涨幅toggle类似，只是时间段涨幅不一样，这样在市场总龙出现分歧的时候，
    //   我可能用这个toggle做参考。」
    //   §6 单一真相：排序键与行上数值同源（同一个 Map）；排序实现复用 range-pct-sort.js 的
    //     三级键（缺数据置底 → pct 降序 → 稳定），⛔ 不在这里另写一套比较器。
    //   §10：Map 未就绪（null）或该行缺腿 → 置底且不参与比较（⛔ 绝不补 0）。
    //   ⚠️ 两个 map 各自独立：十日读云端 stock_range_pct；20 日读 range20.js 现算结果
    //      （云端没有 20 日行 —— 表主键 (date,stock)，写进去会覆盖 10 日行，见 range20.js 文件头）。
    const _rangeMap20 = _range20MapFor();
    renderOrder = sortIndicesByRangePct(renderOrder, renderList, _rangeMap20);
  }
  // [TWO-MODES 2026-10-02 用户口径] ⛔ 这里原有 `else if (sortState.byParallel)` 主排序分支（平行达标档
  //   按 digitGap 升序 → diff 降序；内层还套了一个永远走不到的 `if (sortState.byJingYest)` 子分支）
  //   —— 整段已删除（§16 不留死代码）：
  //     · 平行 toggle 的开关位被「一字」toggle 占用，`byParallel` 从状态里移除；
  //     · 平行随之【并入竞/昨】（竞/昨 的 tier0 = 平行+diff>0 高光、tier1 = 仅平行），
  //       这一层排序本来就被上面 `else if (sortState.byJingYest)` 覆盖（它在链上更靠前）；
  //     · 用户在 AskUserQuestion 里明确选了「保留现有『竞/昨』口径」，所以没有把 digitGap 排序搬过去。
  //   ⛔ 想恢复旧行为 ⇒ `git revert` 引入本改动的那次提交。

  // [FEAT 2026-08-20 v2] 题材 toggle：联动辅助叠加排序（按题材【分组】，非按单只股票题材数量）。
  // 复用第二页题材分类(getTopicGroups) 的同一套核心词匹配口径：把同题材股票聚到一起，
  // 哪个题材股票多哪个排前面，"其它"(无题材/未匹配核心词/组<2只) 置底。
  // 主排序档位(tier)顺序保持不变——竞昨高光/达标(tier0)整体置顶，档位【内部】再按题材组大小降序。
  // 覆盖 竞/昨、竞/昨占比（分层）与 默认/十日涨幅/20日涨幅（单层，等同全局分组）。
  // 修复点：v1 按「单只股票题材数量」排序（一只股题材多就排前），与用户要的「题材分组」不符；
  //       现改为与第二页一致的主题材分组，高光档位整体仍置顶、组内按题材聚并组大者居前。

  // 主排序档位解析：给定 renderList 索引，返回其档位（0=最高档/高光或达标）。
  // 必须与上方各主排序分支的 tier 口径完全一致，否则档位边界错位。
  function resolveTopicTier(idx) {
    const it = renderList[idx];
    const nm = it && it.stock ? it.stock.trim() : '';
    // [AUCTION-LEG-TOGGLE 2026-10-25] ⛔ 原「弱转强达标 ⇒ tier0 / 否则 tier1」已随该 toggle 删除。
    //   「竞价口径」不是分层排序（它只换数值来源、不改档位）⇒ 本函数不需要为它开分支。
    if (sortState.byJingYestRatio) {
      const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
      return ih ? 0 : 1;
    }
    if (sortState.byJingYest) {
      const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
      const ip = nm && parallelStocksToday && parallelStocksToday.has(nm);
      return ih ? 0 : (ip ? 1 : 2);
    }
    // [RANGE20 2026-10-19] ⛔ 原「量比抢筹」达标档在这里（tier0 = 竞价量比>=10 且 抢筹幅度>1，
    //   否则 tier1）—— 已随该 toggle 整体删除（§16：不留死分支）。
    // 其它主排序（默认 / 十日涨幅 / 20日涨幅）无分层概念，统一单档
    return 0;
  }

  // [TOPIC-MERGE 2026-09-09] 题材 toggle「单独开启」判定：没有任何主排序 toggle 参与时为真。
  // 单独开启题材 = 用户只想按题材看当日全量（含观察组继承票），不再区分观察组/常规组两块；
  // 一旦叠加任一主排序 toggle（竞昨/竞昨占比/十日涨幅/20日涨幅），
  // 观察组与常规组的既有显示方式保持不变（下方分组分支的 else/各专属分支原逻辑不动）。
  // ⚠️ [AUCTION-LEG-TOGGLE 2026-10-25] 「竞价口径」【不算】主排序 toggle（它只换数值来源，
  //   不改变分组 / 排序档位）⇒ ⛔ 不要把它加进下面这个判定，否则单独开题材时的分组方式会莫名改变。
  //
  // [TWO-MODES 2026-10-02] ⚠️ 这里【不再有】 `!sortState.byParallel` 那一项：
  //   平行 toggle 已被「一字」toggle 占用，`byParallel` 从排序状态里整体移除（平行并入竞/昨）。
  //   ⛔ 一字 toggle 走的是【同一个 byTopic 开关】（只是 topicOrderBy 不同），
  //      所以它天然落在这个 topicOnlyMode 里 —— 这正是用户要的
  //      「打开一字 toggle 后，显示也和单独打开题材 toggle 一样，只是排序变了」。
  const topicOnlyMode = !!sortState.byTopic
    && !jingYestToggleChecked
    && !sortState.byRangePct
    && !sortState.byRangePct20;

  // 题材背景色映射：仅在 byTopic 开启时计算，供下方 enrich 步骤给每行附上浅色背景。
  // 不同题材不同浅色、仅成员>=2 的真实题材上色、"其它"不上色（详细口径见 buildTopicColorMap）。
  let topicColorMap = null;
  let primaryTopicOfForColor = null;
  // [TOPIC-STATS 2026-09-10] 竞价一字判定函数（题材块内定义，提升到此处供统计条复用）
  let yiZiOf = null;
  // [RATIO-ORDER 2026-10-01] 题材量比取值函数（同上，在题材分支里赋值，题材组间排序用）
  let volRatioOf = null;

  // [DRAGON 2026-09-09] 龙头排名：只在题材 toggle 开启时计算（需求——只要题材开着标记就在，
  // 无论是否叠加其它 toggle）。口径：同题材组（= 界面同颜色块：真实题材 且 成员>=2）内部，
  // 按「近10个交易日区间涨幅」降序，最高=龙一。
  // 数据来自 dragon-rank.js 的异步缓存（10日区间涨幅，猫抓 daily 一次批量请求 + 云端缓存省额度）；
  // 未加载/无数据时 dragonRankMap 为 null → 行上不显示徽章、组内保持原顺序，绝不阻塞渲染。
  //
  // [GRAY-DRAGON 2026-09-26] 候选集 = 【renderList 全部行】，灰行照常参与同题材龙位排名。
  //   renderList = auctionList + 注入行（观察组壳 / 龙头继承壳 / 补一字补入行）。注入行就是界面上
  //   「灰色股票名 + 灰色题材」的那些 —— 它们【不在当天正式列表】，但同样能在 stock_range_pct 里
  //   查到十日涨幅，用户要求【它们也要排龙一 / 龙二 / …】（9/8 国芳股份 96.45% 应为龙一，
  //   沃华医药 / 爱仕达 / 百大集团 同理），只是【灰色名称 + 灰色题材保持不变】，
  //   这样一眼仍能看出「它不在今天的正式列表里」。
  //
  //   ⛔ 这里【曾经】加过 `if (!_listedNames.has(nm)) return;` 的闸门（2026-09-25 修决策看板
  //      9/16 / 9/17 龙位错位时误加的），结果是早盘竞价里灰行整片丢龙标 —— 本次移除。
  //      那道闸门本来也修不到决策看板：决策看板的龙位走 decision-rules.js 自己的 rankDragons
  //      （候选 = 它自己的题材块成员），【根本不读本文件的 dragonRankMap】。
  //      ⇒ 教训：各看板是独立业务模块（§15），「某个看板要排除非正式成员」只能写在该看板自己的
  //        规则里，⛔ 不能改早盘竞价共用的龙位函数（§6 单一真相 ≠ 让别的看板替我做过滤）。
  //
  //   §10：dragonPctMap 未加载 / 某行缺十日涨幅 → 该行不参与排名（不是当 0），绝不影响其它行。
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
      const pct = dragonPctMap.get(nm).pct;
      if (pct === null || pct === undefined || isNaN(pct)) return;
      // [MAIN-BOARD-ONLY 2026-10-07] 必须带上 code：龙标签只发主板，
      //   板块判定要用它（缺代码 ⇒ 名册兜底；再取不到 ⇒ 按「未知」照发，§10 不猜）。
      dragonEntries.push({
        name: nm,
        topic: primaryTopicOfForColor(i),
        pct: pct,
        code: raw.code || getStockCode(nm) || ''
      });
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

    // ⭐ [RATIO-ORDER 2026-10-01 用户口径] 题材组【组间排序】依据 = 该题材的【平均竞价量比】。
    //   用户原话：「以前单独打开题材 toggle，题材是按一字数量排序，我希望现在是按题材的平均竞价量比排序，
    //   平均竞价量比高的题材排在前面。这样能分出排在第一和第二的题材」。
    //   · 取值走 Data 层唯一适配点 getAucVolRatio（云端存字符串 → 数值），
    //     与统计条第一行「平均竞价量比」【同一个来源同一个字段】（§6 单一真相）；
    //   · ⚠️ 灰行（观察组 / 龙头继承壳）照常计入 —— 统计条那个数字的分母就「不分灰色和常规」，
    //     排序必须用同一个分母，否则用户拿统计条的数字核不出来顺序（§10 不制造自相矛盾的口径）；
    //   · §10：缺量比 → null（不进均值分母；整个题材一行都拿不到 → 该题材置底），⛔ 绝不当 0。
    const _volRatioCache = new Map();
    volRatioOf = function(idx) {
      if (_volRatioCache.has(idx)) return _volRatioCache.get(idx);
      const it = renderList[idx];
      const nm = it && it.stock ? String(it.stock).trim() : '';
      const v = nm ? getAucVolRatio(currentDate, nm) : null;
      _volRatioCache.set(idx, v);
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
          // 🔴 [MAIN-BOARD-ONLY 2026-10-07 用户口径] 组内排序键必须用【seq（十日涨幅位次）】，
          //   ⛔ 绝不能用 rank（龙位）—— 创业板 / 科创板的 rank 已经是 null，
          //   而 sortByTopicGroups 对「无排名者」一律【置底】⇒ 用 rank 当排序键会让
          //   中石科技（创业板，涨幅第一）掉到题材组最后，与用户「排序不变」的要求直接冲突。
          //   seq 是入组每一只票都有的十日涨幅位次 ⇒ 屏幕顺序与改造前逐行一致。
          return dk ? dk.seq : null;
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
      },
      // ⭐ [TWO-MODES 2026-10-02 用户口径] 第 8 参 = 题材组的【组间排序口径】—— **由 toggle 决定**：
      //   · 一字 toggle（topicOrderBy = 'yizi'，⚠️ 也是【缺省值】，见 auctionStore#createSortState）
      //     → **不传第 8 参** ⇒ 回到 sortByTopicGroups 的默认口径 =
      //     【竞价一字数量降序】→ 组大小 → 题材名。这就是用户说的「早期版本那个题材一字多的排在
      //     前面的逻辑」，⛔ 不是退回旧代码而是同一函数换口径。
      //   · 题材 toggle（topicOrderBy = 'volRatio'）→ 平均竞价量比降序（2026-10-01 起的口径）。
      //     ★ [RATIO-ONLY 2026-10-12 用户口径] 用户明确「不用管数量」⇒ 该档【只】按平均竞价量比
      //     降序排（量比相同按题材名），⛔ 「组大小」不再当第二键；改在 topic-sort.js 一处生效，
      //     topic-trend.js 的同源比较器已同步（§6 单一真相）。
      //   两者【共用这一个调用点】，所以「屏幕顺序 == 决策看板题材排名 == 趋势图名次」三处必然同源
      //   （决策侧 rankDecisionTopics 传的是同一个参数，§6 单一真相）。
      //   ⛔ 只有本调用点传它；涨跌停 / 一字看板 / 第二页题材块仍走默认的一字口径（各看板独立 §15）。
      sortState.topicOrderBy === TOPIC_ORDER_YIZI
        ? undefined
        : { by: TOPIC_ORDER_VOL_RATIO, volRatioOf: volRatioOf }
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

  // [RANGE-PCT 2026-10-14 用户口径] 「十日涨幅」模式：**全部股票一条列表**，不再按
  // 观察组 / 常规组分隔（下方分支同款折叠）。用户要的就是「一眼在一条降序表里找到市场总龙头」，
  // 若把观察组单独拎成一块，排序名次就会被区块边界打断。每行的 obs / 龙头身份仍由
  // itemClass / obsFormalStar / isDragonGroupMember 原样标记，身份不丢。
  // 注：原「三天竞跌」模式的分组注释随该功能整体删除（2026-10-14）。

  let obsIndices, regularIndices, hiddenObsIndices;
  // [DRAGON-GROUP 2026-09-14] 龙头组索引：非空时模板在【观察组之上】渲染独立「龙头组」区块
  // （与观察组用蚂蚁线隔开）。其余模式折叠为 [] → 龙头只按「组内标记」体现在原列表中。
  let dragonIndices = [];
  // [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」区块索引：非空时模板在【龙头组之后、观察组之前】
  // 渲染一个独立小组件（用户口径：「你可以新建一个小组件给它们，这样就不会乱，以后改的时候也方便」）。
  // 其余模式（题材 / 十日涨幅 / 20日涨幅 / 竞昨）一律折叠为 [] ——
  //   十日·20日涨幅模式下全部股票本来就折成一条降序表，补位行自然排在里面（和龙头组同款折叠）。
  let range20LeaderIndices = [];
  if (topicOnlyMode) {
    // [TOPIC-MERGE 2026-09-09] 题材单独开启：观察组与常规组融合为【单一列表】。
    // - obsIndices=[] → 模板不再渲染观察组区块与蚂蚁线分隔（showObsSeparator 自动为 false）；
    // - regularIndices = 完整 renderOrder → 观察组继承票一条不丢，只按题材分组聚在一起；
    // - 排序已由上方 sortByTopicGroups 按「题材分组」处理（组大者居前、"其它"置底），
    //   观察组票按其题材落进对应组别，不再单独成块。
    obsIndices = [];
    regularIndices = renderOrder.slice();
    hiddenObsIndices = [];
  } else if (sortState.byRangePct || sortState.byRangePct20) {
    // [RANGE-PCT 2026-10-14] 十日涨幅模式：折叠龙头组与观察组（dragonIndices 保持 []、obsIndices=[]）
    // → 模板不渲染两个独立区块与蚂蚁线；三组股票【全部】进 regularIndices 这一条列表，
    // 总数与默认模式一致（不隐藏、不增不减，§6 唯一数据源 = 9:25 列表 + 观察组/龙头继承壳）。
    // 排序由上方 byRangePct 分支给出：十日区间涨幅由高到低、缺数据置底。
    // [RANGE20 2026-10-19] 20 日涨幅模式【完全同款】（用户口径「和十日涨幅toggle类似」）：
    //   同一段分支，只是排序键换成 20 个交易日区间涨幅（见上方 byRangePct20 分支）。
    obsIndices = [];
    regularIndices = renderOrder.slice();
    hiddenObsIndices = [];
  } else if (jingYestToggleChecked) {
    hiddenObsIndices = [];
    _obsIndicesRaw.forEach(i => {
      const stockName = renderList[i].stock.trim();
      const matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(stockName);
      const item = renderList[i];
      const hasTodayData = item && ((item.volume || '').toString().trim() !== '' || (item.yestVolume || '').toString().trim() !== '');
      const isBoughtInherited = _obsBoughtSet.has(stockName) && hasTodayData;
      // 打* 的正式成员永不隐藏（与其它折叠观察组的分支口径一致）
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
    // [RANGE20-TOP5 2026-10-19] 20日补位区块抽取（独立小组件）。
    //   顺序 = `_range20Leaders` 的顺序（服务端已按 20 日涨幅降序 + 稳定 tie-break，§6 不在这里二次排序）。
    //   与龙头组去重：若同一只票已在龙头组区块里，补位区块不再重复渲染（用户「不用重复补」）。
    //
    //   🔴 [FIX 2026-10-19 · R20-BLOCK-LEAK] **判据必须是 `_range20Names`（本次真正注入的），
    //   ⛔ 不能用 `_range20Leaders`（全量前五）**：前五里「今天本来就在正式列表」的票只被
    //   `_existingNames.has(n)` 提前 return、从未走注入 ⇒ 行上没有 `range20Leader` 标记。
    //   若这里按全量名单捞索引，就会把它们从原本的龙头组/观察组【强行搬到补位区块】，
    //   于是区块里出现「无标签行」（实测 10-19 生产：新华传媒、新华文轩 被搬走），
    //   同时原组少行 ⇒ 位置错乱。补位区块只该装真正补进来的那几只。
    if (_range20Names.size > 0) {
      const _idxByName20 = new Map();
      renderList.forEach(function(row, i) {
        const nm = row && row.stock ? String(row.stock).trim() : '';
        if (nm && !_idxByName20.has(nm)) _idxByName20.set(nm, i);
      });
      range20LeaderIndices = (_range20Leaders || [])
        .map(function(m) {
          const nm = m && m.stock ? String(m.stock).trim() : '';
          // ⛔ 双重闸门：既要是本次注入的（_range20Names），也要在 renderList 里找得到
          if (!nm || !_range20Names.has(nm) || !_idxByName20.has(nm)) return -1;
          return _idxByName20.get(nm);
        })
        .filter(function(i) { return i >= 0 && !_dragonSet.has(i); });
    }
    const _r20Set = new Set(range20LeaderIndices);
    const _obsSet = new Set(obsIndices);
    regularIndices = renderOrder.filter(function(i) {
      return !_dragonSet.has(i) && !_obsSet.has(i) && !_r20Set.has(i);
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
    // [TWO-MODES 2026-10-02] `sortByParallelEnabled` 已随平行 toggle 一并移除（平行并入竞/昨，
    //   其唯一消费者 isParallelMatch 已删除）。`parallelStocksToday` 保留：竞/昨的 tier 计算还要用它。
    parallelStocksToday,
    // 注：highRatioToday（今/昨比>=1.5 集合）从 ctx 移除——行级高光功能已不存在，
    // 保留它只会误导后人。它仅用于下方 stats.highRatioCount（「竞放量数」常驻统计）。
    // [RANGE-PCT 2026-10-14] 「十日涨幅」toggle：行上要标出该数值（= 本模式的排序键）。
    //   rangePctMap 只在开关打开时读取（关着时 null ⇒ 行上不产出 rangePct，行为一字不变，§11）。
    //   ⛔ 只读、不请求、不落库 —— 数据由 ensureDragonRangePct 异步发布（失效由 incremental-view 的
    //      dragon= 指纹保证）。
    sortByRangePctEnabled: !!sortState.byRangePct,
    rangePctMap: sortState.byRangePct ? _range10MapFor() : null,
    // [RANGE20 2026-10-19] 「20日涨幅」toggle：同款只读入口，数据源换成 range20.js 的会话内存 Map。
    //   ⛔ 同样只读、本层不请求（取数由 useAuctionBoard 的 watch 触发 ensureRange20）；
    //      失效由 incremental-view 的 `range20=` / `rp20=` 指纹保证。
    sortByRangePct20Enabled: !!sortState.byRangePct20,
    rangePct20Map: sortState.byRangePct20 ? _range20MapFor() : null,
    // [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」的元数据（股票名 -> {pct, days}）与本轮真正补进来的名单。
    //   ⚠️ 与上面的 rangePct20Map 不是一回事：那个只覆盖「屏幕上已有的 41 行」且只在 toggle 打开时有值；
    //   这里覆盖「近 20 日曾经上榜、今天不在列表」的补位行，且【恒有值】（它就是这些行存在的理由）。
    range20LeaderMeta: _range20Meta,
    range20LeaderSet: _range20Names,
    // ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 当前这两个涨幅列用的是哪套口径 —— 传给行组件，
    //   让悬停文案写明「竞价口径（9:26）」而不是让用户自己猜（§21：模板零计算，判定在这里做完）。
    //   ⚠️ 只影响文案；选值已经在上面 rangePctMap / rangePct20Map 一处定掉（§6 不加第二个分支点）。
    sortByAuctionLegEnabled: !!sortState.byAuctionLeg
  };
  // [DRAGON-GROUP 2026-09-14] 最终渲染顺序 = 龙头组 → 观察组 → 常规组（龙头组排最前，需求 3）。
  // [RANGE20-TOP5 2026-10-19] 20日补位区块插在【龙头组之后、观察组之前】：
  //   它和龙头组同属「昨天/近 20 日挑出来的强势票」，放在一起看得顺，但块是分开的 ⇒ 不打乱既有分组。
  const fullOrder = dragonIndices.concat(range20LeaderIndices).concat(obsIndices).concat(regularIndices);

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
      // [MAIN-BOARD-ONLY 2026-10-07 用户口径] 创业板 / 科创板的 dk.rank 是 null
      //   ⇒ 归一成 0 ⇒ AuctionEntityRow 的 `v-if="item.dragonRank > 0"` 不渲染徽章
      //   （= 屏幕上「没有龙标签」，与用户口径一致）。
      //   ⚠️ dk 仍然存在（seq / pct 有值），所以十日涨幅那一列照常显示、排序也照常。
      it.dragonRank = (dk && dk.rank) ? dk.rank : 0;
      it.dragonPct = dk ? dk.pct : null;
    }
    return it;
  }).filter(Boolean);

  // ==========================================================================
  // [RANGE20-TOTAL-DRAGON 2026-10-20 用户口径] 「20日涨幅」toggle 专属显示层：
  //   由高到低给前五只打「总龙一…总龙五」标签，其它票一律不标（用户原话「其它票不标」）。
  //
  // ★ 为什么放在 items 组装【之后】：
  //   ① 此时 items 的顺序 = fullOrder = 最终渲染顺序，且该模式下三组已折叠为一条列表
  //      （dragonIndices=[]、obsIndices=[]，见上方 byRangePct20 分支）⇒ 下标 0..4 就是 20 日涨幅前五；
  //   ② 顺序本身由 sortIndicesByRangePct（与十日涨幅同一个比较器）给出，本层⛔ 不再排序（§6）。
  // ★ 只在 `byRangePct20` 打开时赋值 —— 其它 toggle 走 _enrichAuctionItem 的默认值 0/''
  //   ⇒ 用户要求的「其它 toggle 保留原样」是结构性保证，不是靠模板再判一次。
  // ⚠️ 不叠加题材单独模式：那时列表已按题材分组，顺序不再是 20 日涨幅降序，
  //   此时打「总龙N」会把名次标错（§10 宁缺勿错：宁可没有标签，也不给错误的龙头名次）。
  // ==========================================================================
  if (sortState.byRangePct20 && !topicOnlyMode) {
    assignTotalDragonRanks(items, RANGE20_TOTAL_DRAGON_TOP_N);
  }

  // ==========================================================================
  // [PRESENCE 2026-10-23 用户口径] 「涨幅前十 · 在列次数」标签（「5次在列」「首次在列」）。
  //
  // 用户原话：「10日涨幅 toggle 单独打开后，把排名前十的股票，在这 10 个交易日中出现过几次
  //   标记起来……打上小标签比如"5次在列"，"首次在列"，单独打开 20 日涨幅 toggle 时也要。」
  //   AskUserQuestion：「只给前十名标」/「Supabase 定时算好落表」/「含今天」。
  //
  // ★ 位置与「总龙N」完全同构（都在 items 组装之后、都用当前顺序）：
  //   两个涨幅 toggle 下三组已折叠成一条列表、顺序 = 区间涨幅降序
  //   （见上方 byRangePct / byRangePct20 两个分支），所以下标 0..9 就是「排名前十」。
  //   ⛔ 本层不再排序、不再判断谁在名单里（§6：顺序由 range-pct-sort.js 给，次数由表给）。
  //
  // ★ 数据来源：预计算表 auction_presence（Data 层 auction-presence.js 同步读会话缓存）。
  //   ⛔ 本文件绝不发请求；取数由 useAuctionBoard 的 watch 触发 ensurePresence，
  //   到货后 incremental-view 的 `presence=` 指纹变化 ⇒ 本视图自动重算（标签才出现）。
  //
  // ⚠️ 题材单独模式（topicOnlyMode）下顺序是「按题材分组」而非涨幅降序 ⇒ 传 null 让标签清空，
  //   与「总龙N」同一条纪律：宁可没有标签，也不给错误的名次（§10）。
  // ⚠️ 两个 toggle 都没开时不进这里 —— 走 _enrichAuctionItem 的默认值（null / ''），
  //   即「默认模式一条标签都不出现」（用户只要求这两个 toggle 下标）。
  // ==========================================================================
  if (sortState.byRangePct || sortState.byRangePct20) {
    const _presenceWindow = sortState.byRangePct20 ? PRESENCE_WINDOW_20 : PRESENCE_WINDOW_10;
    const _presenceRec = topicOnlyMode ? null : getPresenceForDate(currentDate, _presenceWindow);
    assignPresenceLabels(items, PRESENCE_TOP_N, {
      windowDays: _presenceWindow,
      // counts = null ⇒ 全表不标（数据未到 / 表还没建），⛔ 绝不把「不知道」显示成「未在列」
      counts: _presenceRec ? _presenceRec.counts : null,
      coveredDays: _presenceRec ? _presenceRec.coveredDays : 0
    });
  }

  // ★★ [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」模式：把占比列换成【名次变化】（对比昨日排名）。
  //   用户原话：「你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，
  //     比如+6，排名下降就用绿色，比如-7……这个数值变化，也很重要，可以看出个股突破。」
  //
  //   ⛔ 只在【20日涨幅单独排序】时生效：
  //     · `sortState.byRangePct20` 关闭 ⇒ 一行都不赋（走 _enrichAuctionItem 的默认 null/''）；
  //     · 题材单独模式（顺序是按题材分组，不是涨幅降序）⇒ 名次没有意义 ⇒ 不赋（§10 宁可没有）。
  //   ⛔ 本层不发请求：昨日名次表由 Data 层会话缓存提供，取数在 useAuctionBoard 的 watch 里，
  //     到货后 incremental-view 的 `r20delta=` 指纹变化 ⇒ 本视图自动重算（数值才出现）。
  //   §10：昨日名次没到货 / 某只票昨天不在榜 ⇒ 该行显示 '—'（⛔ 绝不用 0 冒充「没变化」）。
  if (sortState.byRangePct20 && !topicOnlyMode) {
    const _r20Map = _range20MapFor();
    const _prevRec = getRange20PrevRankForDate(getPreviousTradingDay(currentDate));
    const _deltaMap = buildRange20RankDelta(_r20Map, _prevRec);
    items.forEach(function(it) {
      const _nm = String(it.stock || '').trim();
      if (!_nm) return;
      const _d = _deltaMap.get(_nm) || null;
      it.range20RankDelta = _d;
      it.range20RankDeltaText = _d ? _d.text : RANGE20_DELTA_UNKNOWN_TEXT;
      it.range20RankDeltaTone = _d ? _d.tone : '';
    });
  }

  let topicStatsMap = null;
  if (topicOnlyMode && primaryTopicOfForColor) {
    const _rangeMap = getDragonRangePct(currentDate);
    // [LISTED-TODAY 2026-09-23] 计数类统计（数量 / 一字 / 竞价高开 / 收盘 / 龙头）只认【当天正式列表里的行】
    //   （观察组/龙头继承空壳不计数）—— 与上方 sortByTopicGroups 的 countableOf、下方趋势图
    //   collectTopicDayStats 完全同一口径，是「统计条数字 == 题材块顺序 == 趋势图名次」的结构性保证
    //   （不是靠三处各写一遍 if）。该口径【原样保留】，由 row.formal 标记交给 topic-stats.js 内部分流。
    //
    // 🔴 [AVG-VRATIO 2026-10-01 用户口径] 但「平均竞价量比」是【另一套分母】：用户明确要求
    //   「数量不分灰色和常规，只要显示在上面的都要算进去，这个和那个只算正式列表有区别要注意」。
    //   所以这里改为把【items 全部（= 最终渲染顺序 = 列表上真正显示的每一行，含灰行）】都送进去，
    //   由 topic-stats.js 自己按 formal 分流：计数走正式成员、平均量比走全部行。
    //   ⚠️ 成组门槛（不足 2 只正式成员的题材不出统计条）仍在 topic-stats.js 内部按 formal 判，
    //      因此「哪些题材会出现统计条」与改造前【逐字一致】。
    // [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）的同步读取器（Data 层内存缓存，⛔ 不发请求、
    //   不消费猫抓额度）。合计 / 变化的口径与格式化全在 topic-stats.js + seal-volume.js。
    const _sealPrevDate = getPreviousTradingDay(currentDate);
    const _entries = items.map(function(it) {
      const rp = (_rangeMap && _rangeMap.has(it.stock)) ? _rangeMap.get(it.stock).pct : null;
      return {
        topic: primaryTopicOfForColor(it.index),
        name: it.stock,
        isYiZi: !!it.isYiZi,
        aucPct: _auctionPctOf(renderList[it.index]),
        rangePct: (rp === undefined ? null : rp),
        // [CLOSE-COUNT 2026-09-11] 收盘口径下才带收盘涨幅（否则为 null → 逻辑层不产出该段）
        // ⚠️ 不再传 closeLimit：统计条的「停板 N涨停M跌停」按用户要求已移除（太占地方），
        //    停板只由股票名下蚂蚁线表达（见本文件 closeLimit 字段 + AuctionBoardTable）。
        closePct: it.closePct,
        // [NOT-FORMAL 2026-09-23] 是否今日 9:25 正式名单成员（false = 灰行）。
        //   计数类统计只看 true（口径不变）；[AVG-VRATIO 2026-10-01] 平均竞价量比【不分】；
        //   [SEAL-VOLUME 2026-10-11] 封单合计同样【不分】（与平均量比同一分母口径）。
        formal: !!it.isFormalMember,
        // [AVG-VRATIO 2026-10-01 用户口径] 当日竞价量比（倍数）→ 题材平均量比的分母/分子。
        volRatio: getAucVolRatio(currentDate, it.stock),
        // [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）：当日 + 上一交易日（后者只用于算「变化」）。
        //   非涨停 / 没有封单数据 ⇒ null（§10 ⛔ 不补 0，不会被算进合计，也算不出变化）。
        sealLots: sealLotsOf(currentDate, it.stock),
        sealLotsPrev: _sealPrevDate ? sealLotsOf(_sealPrevDate, it.stock) : null
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
    items.forEach(function(it) { it.topicStats = null; it.groupTopic = ''; });
    // ★★ [BOARD-SEQ 2026-10-25 用户口径] 区间涨幅模式（十日 / 20日）下，序号改成「主板名次」：
    //   非主板【位置不变、但不占序号】（序号列留空），主板按屏幕顺序 1,2,3…
    //   ⇒ 屏幕上的号与规则文案里的「第 N 名」是同一把尺子（都能被
    //     topic-vol-ratio-rules.js#buildRange10Ranked 的主板名次复核）。
    //   用户原话：「……因为有两只非主板的也在十日涨幅前十里面，我想把非主板的序号去掉，
    //     这样冰山冷热就和下面提示文案口径相同了。也就是非主板的位置可以不变，但是没有序号，
    //     因为我是看序号来判断排名的。」
    //   ⚠️ 口径/判据全在 board-seq.js（唯一实现，§6）；其它模式它一律返回 seqNo=0 / seqBlank=false
    //      ⇒ 本段在默认 / 题材 / 竞昨模式下零行为变化（§11）。
    const _seq = buildMainBoardSeq(items, sortState);
    items.forEach(function(it, i) {
      it.seqNo = _seq[i].seqNo;
      it.seqBlank = _seq[i].seqBlank;
    });
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
    // [RANGE20-TOP5 2026-10-19] 「20日涨幅前五补位」区块索引（独立小组件，紧跟龙头组之后）。
    //   [] = 该模式/该日没有可补的票（前五都在当天列表里，或还没算完 —— 两者的区别由 getRange20Leaders
    //   的 ready 标志表达，视图层不需要区分：没得补就是不渲染区块）。
    range20LeaderIndices,
    hiddenObsIndices,
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
