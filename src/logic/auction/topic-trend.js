// topic-trend.js — 题材统计条「五日趋势」的纯计算 + 单日统计采集（§15 独立业务模块）
//
// 需求（2026-09-20）：
//   题材 toggle【单独】开启时，每个题材上方有统计条；点击统计条 → 展开五日趋势图（共三张，见下）：
//     上图 = 该题材这五个交易日的【名次】（名次由「一字数量」决定，与现在题材组排序同一把尺子）；
//     下图 = 该题材这五个交易日每天的【一字数量】。
//   ⛔ 不计「补竞价一字」补进来的股票：那部分一字涨停数量不算。
//
// 需求追加（2026-10-01 下午 · 用户原话「把题材平均竞价量比也做一个五日趋势图放在题材条展开后显示，
//   放在一字数量趋势图下方，方便我观察下题材强度变化」）：
//   在一字数量图【下方】再挂第三张图 = 该题材每天【平均竞价量比】（= 统计条最上面那一行同口径）。
//   口径：同题材当日【列表上全部行】的竞价量比（倍数）算术平均，§10 缺量比的行不进分母；
//         整组一行都取不到量比 ⇒ 该点 null（断点），⛔ 不补 0.00。
//   ⚠️⚠️ 与统计条第一行的【唯一已知差异】（已在真实数据上实测，见下）：统计条的口径还包含
//     「不在当日列表、由视图注入的灰壳」（观察组壳 / 龙头继承壳）—— 那批行只在【当天】由
//     view-helpers 现场注入，历史日期无法重建（龙头名册 dragon_leaders 是按展示日异步加载的，
//     名册只保留当前展示日）。实测该批壳的数量：观察组壳 0 只/日（竞昨高光 ⊆ 前一日名单，
//     隔夜基本不落榜），龙头继承壳 0~4 只/日（多数 0~2）。⇒ 最后一天的点通常与统计条一致，
//     极少数情况会因某题材恰有一只龙头壳而略有出入。⛔ 不要为此在本文件里重建注入规则
//     （那就是第二套口径，§6；而且重建出来仍与屏幕不完全一致）。
//
// ⛔⛔ 为什么「补竞价一字」天然被排除（不是靠 if 记得减掉）：
//   本模块的输入只有【当日早盘竞价自己那份列表】（getTodayGroupList('auction', date)）。
//   「补竞价一字」的行来自竞价一字看板的 auction_yizi 快照（logic/auction/yizi-supplement.js），
//   它们根本不在这个输入里 ⇒ 想算也算不进去。这是结构性排除，不是运行时过滤。
//
// [NOT-FORMAL 2026-09-23 · 2026-10-01 口径澄清] 参与统计的行 = 【当日列表】（getTodayGroupList），
//   即「正式成员 + obsAutoAdded 观察组继承行（今天真抓到数据的那批）」，剔除昨日「卖」继承复盘行。
//   · 不在当日列表的【视图注入灰壳】（观察组壳 / 龙头继承壳）= 靠输入集合【结构性】排除：
//     它们由 view-helpers 现场注入 renderList，根本不是本模块输入的一部分（⛔ 不是靠某处 if 减掉）。
//   · ⚠️ 别再引入 _isAuctionFormalMember 做过滤：它把 obsAutoAdded 继承行也排除掉，
//     与看板 / 统计条口径不同，会立刻重现「视觉第 2、趋势图第 3」的错位（见下方 LISTED-TODAY 注释）。
//   三处必须同源，否则就是用户反馈的这类错位：
//     · 屏幕上的题材块顺序（view-helpers#sortByTopicGroups 的 countableOf）
//     · 题材统计条的数字（view-helpers#buildTopicStatsMap 的 entries）
//     · 本文件的趋势图名次 / 一字数 / 平均竞价量比
//
// 名次口径（与 sortByTopicGroups 同源，§6 单一真相）：
//   ⭐ [RATIO-ORDER 2026-10-01 用户口径] ①【平均竞价量比】降序 → ② 组内股票数降序 → ③ 题材名升序；
//   （改造前是「一字数量降序」为首键；用户要求题材按平均竞价量比排序，故首键换成量比，
//     一键一字数量【不再参与名次】。）
//   「其它」与「不足 2 只」的题材不参与名次（与 top-stats 的成组门槛 TOPIC_STATS_MIN_GROUP 同源）。
//   ⚠️ topicOnlyMode 下所有行同一档位（resolveTopicTier 恒 0），所以这里不需要再分层。
//   ⚠️ 已知差异：早盘竞价屏幕口径含【现场注入的 0~4 只灰壳】并算进均值分母，
//      历史日重建不出这些壳 ⇒ 当日的趋势图名次可能与屏幕顺序差 1 位（既有差异，见上面 LISTED-TODAY 段）。
//
// §10 红线：某日列表为空 = 「没拉到 / 该日无数据」，绝不等于「0 个一字」→ 返回 null，
//   UI 画成 '--' 断点（与股票的五日趋势图同款），⛔ 不补 0。
//
// 本文件的两部分：
//   · buildTopicDayStats / buildTopicTrendSeries —— 【纯函数】，零依赖、可单测；
//   · collectTopicDayStats / collectTopicTrendSeries —— 采集层，只读内存（Logic 层既有单一真相），
//     ⛔ 不发请求、不写库、不碰 DOM。

import { getTodayGroupList } from '../app-core-api.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic, buildTopicSizeMap } from './topic-sort.js';
import { isAuctionYiZi } from './limit-up.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { getDragonWindowDates } from './dragon-rank.js';
// [LISTED-TODAY 2026-09-23] 「当天正式列表」的唯一真相（§6）= getTodayGroupList（auction-helpers.js）。
// 趋势图的题材名次 / 一字数量与【屏幕上的题材块顺序、统计条数字】必须是同一集合，
// 否则就是用户反馈的「AI应用 视觉第 2、趋势图第 3」这类错位 ——
// 所以这里【不再二次过滤】：list 本身就是 getTodayGroupList 的结果，与看板 auctionList 天然相等。
// ⛔ 别把 _isAuctionFormalMember 加回来（它排除 obsAutoAdded 行，与看板口径不同 → 立刻错位）。
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getPrevSoldInheritedSet } from './inherited-sold.js';
// [AVG-VRATIO-TREND 2026-10-01] 当日竞价量比（倍数）的数值读取器：Data 层只读选择器，
//   与题材统计条最上面一行（view-helpers.js）【同一个值、同一份实现】（§6 单一真相）——
//   ⛔ 绝不在这里再写一遍 Number() 适配。
import { getAucVolRatio } from '../../data/watchlist-helpers.js';

/** 趋势窗口长度（交易日） */
export const TOPIC_TREND_DAYS = 5;
/** 成组门槛：与 topic-stats.js#TOPIC_STATS_MIN_GROUP 同源（不足 2 只不成题材、不排名次） */
export const TOPIC_TREND_MIN_GROUP = 2;

/**
 * 单日：按题材统计「股票数 / 一字数 / 平均竞价量比」并排名次。
 *
 * @param {Array<{topic:string, name:string, isYiZi?:boolean, volRatio?:number|null}>} entries
 *        当日参与统计的行（按名去重后的即可）= 当日列表行（含观察组继承行），与另两张图同一集合。
 *        volRatio = 当日竞价量比（倍数）；[AVG-VRATIO-TREND 2026-10-01] 缺值传 null（§10，⛔ 不要传 0）
 * @param {{minGroupSize?:number}} [opts]
 * @returns {Map<string, {topic:string, size:number, yiziCount:number, rank:number, avgVolRatio:number|null}>}
 *          只含「非其它 + 成员数达标」的题材；rank 从 1 起（1 = 一字最多 / 最强）。
 *          avgVolRatio：组内【有量比的行的量比均值】（分母不含缺值行）；一行都没有 ⇒ null
 *          （UI 画断点，⛔ 不显示 0.00 —— 那会被读成「量比很小」）。
 */
export function buildTopicDayStats(entries, opts) {
  const out = new Map();
  if (!entries || entries.length === 0) return out;
  const minSize = (opts && opts.minGroupSize) || TOPIC_TREND_MIN_GROUP;

  const groups = new Map();
  entries.forEach(function(e) {
    if (!e || !e.name) return;
    const topic = (e.topic || '').trim() || '其它';
    if (topic === '其它') return;               // 「其它」不是真题材，不参与名次
    let g = groups.get(topic);
    if (!g) {
      g = { topic: topic, size: 0, yiziCount: 0, ratioSum: 0, ratioN: 0 };
      groups.set(topic, g);
    }
    g.size++;
    // ⛔ 只认「当日早盘竞价列表里本来就一字」的行；补竞价一字的行不在 entries 里（见文件头说明）
    if (e.isYiZi) g.yiziCount++;
    // [AVG-VRATIO-TREND 2026-10-01] 平均竞价量比：分母 = 组内【拿得到量比】的行数。
    //   §10：缺量比的行【不进分母】（⛔ 绝不当 0 —— 会把「没抓到」变成「量比很小」，拉低均值）；
    //   量比真的是 0 则是有效值，照常计入（与「一字数量为 0 照常输出」同一处理）。
    const r = _toNum(e.volRatio);
    if (r !== null) { g.ratioSum += r; g.ratioN++; }
  });

  const eligible = [];
  groups.forEach(function(g) {
    if (g.size >= minSize) eligible.push(g);
  });
  // ⭐ [RATIO-ORDER 2026-10-01 用户口径] 与 sortByTopicGroups(by:'volRatio') 【逐键一致】：
  //   平均竞价量比降序 → 组大小降序 → 题材名升序。
  //   用户口径原文：「题材按平均竞价量比排序，平均竞价量比高的题材排在前面，这样能分出排在第一和第二的题材」。
  //   ⛔ 必须与屏幕上的题材块顺序同源：屏幕顺序 / 统计条那个数字 / 本图的「题材名次」是同一条链上的三处，
  //     口径一错位就会出现「屏幕排第 1、趋势图却写第 2」（同类三套口径错位本项目踩过）。
  //   §10：该日一行量比都拿不到的题材 → 置底（⛔ 绝不当 0 参与比大小）。
  //   ⚠️ 分母 = 该日的【当日列表】行（本文件的数据源），比早盘竞价屏幕口径【少 0~4 只注入灰壳】
  //      （历史日重建不出注入壳，见文件头登记）⇒ 当日名次与屏幕偶有 1 位出入属已知差异。
  eligible.sort(function(a, b) {
    const ra = a.ratioN > 0 ? (a.ratioSum / a.ratioN) : null;
    const rb = b.ratioN > 0 ? (b.ratioSum / b.ratioN) : null;
    if (ra === null && rb !== null) return 1;
    if (ra !== null && rb === null) return -1;
    if (ra !== null && rb !== null && rb !== ra) return rb - ra;
    const ds = b.size - a.size;
    if (ds !== 0) return ds;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });

  eligible.forEach(function(g, i) {
    out.set(g.topic, {
      topic: g.topic,
      size: g.size,
      yiziCount: g.yiziCount,
      rank: i + 1,
      // [AVG-VRATIO-TREND 2026-10-01] 组内量比均值（分母 = 有量比的行数）；一行都没有 ⇒ null
      avgVolRatio: g.ratioN > 0 ? (g.ratioSum / g.ratioN) : null
    });
  });
  return out;
}

/**
 * 把「逐日统计」拼成三张趋势图所需的点序列。
 *
 * @param {string} topic 题材名
 * @param {Array<{date:string, stats:Map|null}>} days 按时间【升序】（旧 → 新）
 * @returns {{topic:string, dates:string[],
 *            rankPoints:Array<{date:string,value:number|null}>,
 *            yiziPoints:Array<{date:string,value:number|null}>,
 *            ratioPoints:Array<{date:string,value:number|null}>,
 *            hasRank:boolean, hasYizi:boolean, hasRatio:boolean, dayCount:number}}
 *          value=null = 该日无数据（UI 画 '--' 断点，⛔ 不补 0）。
 *          [AVG-VRATIO-TREND 2026-10-01] ratioPoints = 每日题材平均竞价量比（倍数），
 *            同样 null = 该日无数据 / 该组一行量比都没有 ⇒ 断点，⛔ 不补 0.00。
 */
export function buildTopicTrendSeries(topic, days) {
  const name = String(topic || '').trim();
  const list = days || [];
  const dates = [];
  const rankPoints = [];
  const yiziPoints = [];
  const ratioPoints = [];
  list.forEach(function(d) {
    const date = (d && d.date) ? d.date : '';
    dates.push(date);
    const stats = (d && d.stats) ? d.stats.get(name) : null;
    if (!stats) {
      // §10：这一天没有该题材（或该日数据缺失）→ 三个序列都是 null，不是 0
      rankPoints.push({ date: date, value: null });
      yiziPoints.push({ date: date, value: null });
      ratioPoints.push({ date: date, value: null });
      return;
    }
    rankPoints.push({ date: date, value: stats.rank });
    yiziPoints.push({ date: date, value: stats.yiziCount });
    ratioPoints.push({ date: date, value: _toNum(stats.avgVolRatio) });
  });
  return {
    topic: name,
    dates: dates,
    rankPoints: rankPoints,
    yiziPoints: yiziPoints,
    ratioPoints: ratioPoints,
    hasRank: rankPoints.some(function(p) { return p.value !== null; }),
    hasYizi: yiziPoints.some(function(p) { return p.value !== null; }),
    hasRatio: ratioPoints.some(function(p) { return p.value !== null; }),
    dayCount: list.length
  };
}

// ===== 采集层（只读内存，⛔ 零请求 / 零写入）=====

/** 单日统计缓存：date → Map。避免同一天被多个题材反复重算（§19 不要在高频 computed 里重算大表） */
const _dayCache = new Map();
const _CACHE_MAX_DATES = 12;

/**
 * 采集【某一天】的题材统计（一字数 / 名次）。
 *
 * 数据源 = 当日早盘竞价列表（getTodayGroupList），题材分类复用 view-helpers 的同一套：
 *   getPrimaryTopicMap（第二页分类口径）→ 缺失者回退 classifyStockPrimaryTopic（注入行同款兜底）。
 *
 * @param {string} date 交易日 YYYY-MM-DD
 * @returns {Map|null} null = 该日没有任何数据（未加载 / 非交易日）→ 调用方画成断点（§10 不补 0）
 */
export function collectTopicDayStats(date) {
  if (!date) return null;
  if (_dayCache.has(date)) return _dayCache.get(date);

  let list = [];
  try {
    list = getTodayGroupList('auction', date) || [];
  } catch (e) {
    return null;
  }
  // ⛔ 空列表【不缓存】：可能只是还没拉到，下次再试（缓存了就会一直显示"没数据"）
  if (list.length === 0) return null;

  const pmap = getPrimaryTopicMap(list);
  const psize = buildTopicSizeMap(pmap);
  // [LISTED-TODAY 2026-09-23] 统计集合 = getTodayGroupList(date)【本身】，不再二次过滤。
  //   为什么不过滤：getTodayGroupList 已经是「当天正式列表」的唯一口径（含 obs 继承但真抓到数据的行、
  //   不含 market_metrics 影子行），看板的 auctionList 就是它 ⇒ 两边集合天然相等。
  //   ⛔ 别再叠一层 _isAuctionFormalMember：它排除 obsAutoAdded 行，会让「趋势名次」比看板少算几只
  //   （2026-09-23 会稽山 / 澳弘电子：看板里在题材组内、趋势里却被剔除 → 名次与视觉对不上）。
  //   §10：索引未就绪 = 「还没拉到」，⛔ 不等于「当天没有正式成员」——
  //        getTodayGroupList 此时退化为原始列表（全计入），宁可多算也不把整天判空。
  // [INHERIT-SELL 2026-09-23] 与看板同源地剔除「昨日『卖』标签继承过来的复盘行」。
  //   不剔 ⇒ 统计条说 5 只、趋势名次按 7 只算，立刻重现「视觉 / 统计错位」。
  //   判据同样来自 logic/auction/inherited-sold.js（§6，绝不在本文件重写一遍）。
  const _inheritSold = getPrevSoldInheritedSet(date, getPreviousTradingDay(date));
  const entries = [];
  const seen = new Set();
  list.forEach(function(row) {
    if (!row || !row.stock) return;
    const nm = String(row.stock).trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    if (_inheritSold.has(nm)) return;
    const topic = pmap.has(nm) ? pmap.get(nm) : classifyStockPrimaryTopic(row, psize);
    // 一字判定与 view-helpers#yiZiOf 同源：行 code → 内存代码映射 → 空（limit-up.js 内按主板兜底）
    const code = row.code || getStockCode(nm) || '';
    // [AVG-VRATIO-TREND 2026-10-01] 当日竞价量比（倍数）：与题材统计条第一行【同一个字段、同一个读取器】
    //   （Data 层 getAucVolRatio，§6）。注意它读的是 market_metrics 的内存快照，与 row 是不是影子行无关 ——
    //   这也正是「屏幕上的图」与「统计条」能对齐的原因（同一把尺子）。
    //   §10：缺值 → null → 不进均值分母（⛔ 绝不补 0）。
    entries.push({ name: nm, topic: topic, isYiZi: isAuctionYiZi(row, code), volRatio: getAucVolRatio(date, nm) });
  });

  const stats = buildTopicDayStats(entries);
  if (_dayCache.size >= _CACHE_MAX_DATES) {
    const oldest = _dayCache.keys().next().value;
    if (oldest !== undefined) _dayCache.delete(oldest);
  }
  _dayCache.set(date, stats);
  return stats;
}

/**
 * 采集【某个题材】的五日趋势（名次 + 一字数量 + 平均竞价量比）。
 * @param {string} topic 题材名
 * @param {string} endDate 展示日（含），往前取 days 个交易日
 * @param {number} [days] 默认 TOPIC_TREND_DAYS(5)。⚠️ getDragonWindowDates 最多返回 10 个交易日
 * @returns {object} buildTopicTrendSeries 的返回值
 */
export function collectTopicTrendSeries(topic, endDate, days) {
  const n = days || TOPIC_TREND_DAYS;
  if (!endDate) return buildTopicTrendSeries(topic, []);
  // getDragonWindowDates 返回降序 [T, T-1, …]；趋势图要按时间【升序】画（旧 → 新）
  const desc = getDragonWindowDates(endDate).slice(0, n);
  const asc = desc.slice().reverse();
  const dayList = asc.map(function(d) {
    return { date: d, stats: collectTopicDayStats(d) };
  });
  return buildTopicTrendSeries(topic, dayList);
}

/** 清空单日缓存（日期切换 / 数据刷新后调用，§26 避免拿旧快照画新一天） */
export function clearTopicTrendCache() {
  _dayCache.clear();
}

/**
 * 宽松取数：null / undefined / '' / 非数字 → null（§10 缺数据 ≠ 0）。
 * 与 view-helpers 的 _num、topic-stats.js 的 _num 同语义 —— 但那是各自模块的私有工具，
 * 不在模块间共享（跨模块共享会把三个只读模块耦合成一个"工具库"，§18 边界更差）。
 * 这里只服务本文件的均值累加，故自留一份。
 */
function _toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
