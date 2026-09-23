// topic-trend.js — 题材统计条「五日趋势」的纯计算 + 单日统计采集（§15 独立业务模块）
//
// 需求（2026-09-20）：
//   题材 toggle【单独】开启时，每个题材上方有统计条；点击统计条 → 展开【两张五日趋势图】：
//     上图 = 该题材这五个交易日的【名次】（名次由「一字数量」决定，与现在题材组排序同一把尺子）；
//     下图 = 该题材这五个交易日每天的【一字数量】。
//   ⛔ 不计「补竞价一字」补进来的股票：那部分一字涨停数量不算。
//
// ⛔⛔ 为什么「补竞价一字」天然被排除（不是靠 if 记得减掉）：
//   本模块的输入只有【当日早盘竞价自己那份列表】（getTodayGroupList('auction', date)）。
//   「补竞价一字」的行来自竞价一字看板的 auction_yizi 快照（logic/auction/yizi-supplement.js），
//   它们根本不在这个输入里 ⇒ 想算也算不进去。这是结构性排除，不是运行时过滤。
//
// [NOT-FORMAL 2026-09-23] ⛔ 只统计【当天 9:25 抓到的正式成员】（用户口径）：
//   观察组继承壳（obsAutoAdded，屏幕上画灰的那些）不进名次、不进一字数。
//   这三处必须同源，否则就是用户反馈的「视觉第 2、趋势图第 3」：
//     · 屏幕上的题材块顺序（view-helpers#sortByTopicGroups 的 countableOf）
//     · 题材统计条的数字（view-helpers#buildTopicStatsMap 的 entries）
//     · 本文件的趋势图名次 / 一字数
//   ⛔ 观察组壳【仍然渲染】在对应题材块里（次日继承功能需要），只是不贡献计数。
//
// 名次口径（与 sortByTopicGroups 同源，§6 单一真相）：
//   ① 一字数量降序 → ② 组内股票数降序 → ③ 题材名升序；
//   「其它」与「不足 2 只」的题材不参与名次（与 top-stats 的成组门槛 TOPIC_STATS_MIN_GROUP 同源）。
//   ⚠️ topicOnlyMode 下所有行同一档位（resolveTopicTier 恒 0），所以这里不需要再分层。
//
// §10 红线：某日列表为空 = 「没拉到 / 该日无数据」，绝不等于「0 个一字」→ 返回 null，
//   UI 画成 '--' 断点（与股票的五日趋势图同款），⛔ 不补 0。
//
// 本文件的两部分：
//   · buildTopicDayStats / buildTopicTrendSeries —— 【纯函数】，零依赖、可单测；
//   · collectTopicDayStats / collectTopicTrendSeries —— 采集层，只读内存（Logic 层既有单一真相），
//     ⛔ 不发请求、不写库、不碰 DOM。

import { getTodayGroupList } from '../app-core-api.js';
import { getPrimaryTopicMap, classifyStockPrimaryTopic } from './topic-sort.js';
import { isAuctionYiZi } from './limit-up.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { getDragonWindowDates } from './dragon-rank.js';
// [NOT-FORMAL 2026-09-23] 「是不是当天 9:25 抓到的正式成员」的唯一真相（§6）。
// 趋势图的题材名次 / 一字数量与【屏幕上的题材块顺序、统计条数字】必须是同一口径，
// 否则就是用户反馈的「AI应用 视觉第 2、趋势图第 3」这类错位 —— 判据只认这一份，不另写。
import { _isAuctionFormalMember, _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';

/** 趋势窗口长度（交易日） */
export const TOPIC_TREND_DAYS = 5;
/** 成组门槛：与 topic-stats.js#TOPIC_STATS_MIN_GROUP 同源（不足 2 只不成题材、不排名次） */
export const TOPIC_TREND_MIN_GROUP = 2;

/**
 * 单日：按题材统计「股票数 / 一字数」并排名次。
 *
 * @param {Array<{topic:string, name:string, isYiZi?:boolean}>} entries 当日参与统计的行（按名去重后的即可）
 * @param {{minGroupSize?:number}} [opts]
 * @returns {Map<string, {topic:string, size:number, yiziCount:number, rank:number}>}
 *          只含「非其它 + 成员数达标」的题材；rank 从 1 起（1 = 一字最多 / 最强）。
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
      g = { topic: topic, size: 0, yiziCount: 0 };
      groups.set(topic, g);
    }
    g.size++;
    // ⛔ 只认「当日早盘竞价列表里本来就一字」的行；补竞价一字的行不在 entries 里（见文件头说明）
    if (e.isYiZi) g.yiziCount++;
  });

  const eligible = [];
  groups.forEach(function(g) {
    if (g.size >= minSize) eligible.push(g);
  });
  // 与 sortByTopicGroups 的题材组排序【逐键一致】：一字降序 → 组大小降序 → 题材名升序
  eligible.sort(function(a, b) {
    const dz = b.yiziCount - a.yiziCount;
    if (dz !== 0) return dz;
    const ds = b.size - a.size;
    if (ds !== 0) return ds;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });

  eligible.forEach(function(g, i) {
    out.set(g.topic, { topic: g.topic, size: g.size, yiziCount: g.yiziCount, rank: i + 1 });
  });
  return out;
}

/**
 * 把「逐日统计」拼成两张趋势图所需的点序列。
 *
 * @param {string} topic 题材名
 * @param {Array<{date:string, stats:Map|null}>} days 按时间【升序】（旧 → 新）
 * @returns {{topic:string, dates:string[],
 *            rankPoints:Array<{date:string,value:number|null}>,
 *            yiziPoints:Array<{date:string,value:number|null}>,
 *            hasRank:boolean, hasYizi:boolean, dayCount:number}}
 *          value=null = 该日无数据（UI 画 '--' 断点，⛔ 不补 0）。
 */
export function buildTopicTrendSeries(topic, days) {
  const name = String(topic || '').trim();
  const list = days || [];
  const dates = [];
  const rankPoints = [];
  const yiziPoints = [];
  list.forEach(function(d) {
    const date = (d && d.date) ? d.date : '';
    dates.push(date);
    const stats = (d && d.stats) ? d.stats.get(name) : null;
    if (!stats) {
      // §10：这一天没有该题材（或该日数据缺失）→ 两个序列都是 null，不是 0
      rankPoints.push({ date: date, value: null });
      yiziPoints.push({ date: date, value: null });
      return;
    }
    rankPoints.push({ date: date, value: stats.rank });
    yiziPoints.push({ date: date, value: stats.yiziCount });
  });
  return {
    topic: name,
    dates: dates,
    rankPoints: rankPoints,
    yiziPoints: yiziPoints,
    hasRank: rankPoints.some(function(p) { return p.value !== null; }),
    hasYizi: yiziPoints.some(function(p) { return p.value !== null; }),
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
  // §10：正式成员索引未就绪 = 「还没拉到」，⛔ 不等于「当天没有正式成员」。
  //   此时不过滤（全部计入），宁可多算也不把整天判空。
  const indexReady = _isAuctionWatchlistIndexReady(date);
  const entries = [];
  const seen = new Set();
  list.forEach(function(row) {
    if (!row || !row.stock) return;
    const nm = String(row.stock).trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    // [NOT-FORMAL 2026-09-23] 只统计当天 9:25 的正式成员：观察组继承壳（obsAutoAdded）不进统计，
    //   但它们在屏幕上仍按题材显示（灰色），与统计条 / 题材块顺序彻底同源。
    if (indexReady && !_isAuctionFormalMember(date, nm)) return;
    const topic = pmap.has(nm) ? pmap.get(nm) : classifyStockPrimaryTopic(row);
    // 一字判定与 view-helpers#yiZiOf 同源：行 code → 内存代码映射 → 空（limit-up.js 内按主板兜底）
    const code = row.code || getStockCode(nm) || '';
    entries.push({ name: nm, topic: topic, isYiZi: isAuctionYiZi(row, code) });
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
 * 采集【某个题材】的五日趋势（名次 + 一字数量）。
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
