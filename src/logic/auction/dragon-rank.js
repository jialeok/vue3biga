// dragon-rank.js — 题材「龙头股」判定（Logic 层，§15 独立业务模块）
//
// 产品口径：
//   - 龙头只在【同一个题材组】内部比较（即界面上同颜色块，题材成员 >= 2 且为真实题材）；
//   - 比较依据 = 该股「近 10 个交易日区间涨幅」：窗口 [T-9, T]，含当天共 10 个交易日；
//   - 当天早盘取【竞价涨幅】占位，收盘后由【收盘涨幅】覆盖并重新计算；
//   - 组内按区间涨幅降序：最高 = 龙一，次高 = 龙二，依次类推。
//   - 龙一/龙二…本身【不落库】，是 view-helpers 按题材组现算的派生字段。
//
// ===== 数据链路（方案A / 2026-09-10 改造）=====
//   9:25 worker（workers/bidding-auto-fetch）在与历史涨幅【同一次】numcat daily 请求里，
//   把 [T-9, T] 的日涨幅按 range-window.js 的复利口径算成区间涨幅，直接写 stock_range_pct；
//   收盘后 close-pct-cover 用收盘涨幅替换 T 腿（0 额外请求）。
//   前端这里只做两件事：
//     ① 读云端缓存 → 发布到模块级 ref（view-helpers 同步读取 → 行内徽章/展开面板）；
//     ② 云端确实缺票时（前日竞昨高光不在 worker 抓取名单 / worker 当天写入失败）用
//        【一次】猫抓 daily 兜底补齐并回写云端。
//
//   ❌ 已经删除的「冗余功能代码」（正是加载慢与体验差的根源，改由 worker 承担）：
//      · 逐只同花顺 K 线兜底（实测 4.7 秒/只，64 只 ≈ 5 分钟）
//      · 后台缺口补齐 _patchMissingRangePct / MAX_PATCH_PER_PASS / _patchedNames / _patchRunning / 熔断
//      · 三段式过期判定（9:25 竞价快照 / 15:00 收盘 / 历史日收盘）+ _forceRecalcDates 强制重算登记
//      · _apiFailedDates / _fuyaoFallbackDates 等「本会话别再请求」的补偿标记
//
// 红线（§10）：读取失败必须 throw，绝不返回空 Map 伪装成「没有数据」。

import { ref } from 'vue';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { state } from '../app-state.js';
import { getAuctionData } from '../app-core-api.js';
import { _getAuctionFormalRowsForDate } from '../../data/watchlist-and-metrics.js';
// [FIX 2026-09-09] 目标名单必须覆盖「观察组继承票」，否则带 * 的票永远没有 10 日涨幅：
// 观察组（打标签继承 / 前一日竞昨高光）只在视图层注入，既不在 _auctionMemCache 也不在 auction_watchlist。
import { getJingYestHighlightSetForDate } from './sort-rules.js';
import { getCarryOverNamesForDate } from './tag-carryover.js';
import {
  readRangePctForDate,
  upsertRangePctRows,
  fetchNumcatDailyPctRange
} from '../../data/stock-range-pct.js';
import { _dbgLog } from '../../data/debug-log.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
// 口径单一真相（纯函数，worker 与前端共用同一份实现）
import { RANGE_WINDOW_DAYS, parsePct, compoundPct, resolveTDayPct, isAuctionLegActive } from './range-window.js';

export const DRAGON_RANGE_DAYS = RANGE_WINDOW_DAYS;
/** 北京时间 15:00 之后，当天收盘涨幅已可覆盖早盘竞价涨幅 */
const CLOSE_COVER_HOUR = 15;
/** 云端为空时的重试间隔：页面可能早于 9:25 打开，worker 写入后需要再读一次 */
const EMPTY_RETRY_MS = 15 * 1000;
/** 空缓存「主动重试」首次间隔 / 上限间隔 / 最大次数（指数退避，避免 worker 一直没写时空转） */
const EMPTY_RETRY_FIRST_MS = 20 * 1000;
const EMPTY_RETRY_MAX_MS = 5 * 60 * 1000;
const EMPTY_RETRY_MAX_TIMES = 20;
/** worker 写入 stock_range_pct 的时间窗（北京 9:25~9:45）。窗口内云端为空属正常，别抢跑兜底。 */
const WORKER_WRITE_FROM_MIN = 9 * 60 + 25;
const WORKER_WRITE_TO_MIN = 9 * 60 + 45;

// ===== 状态（模块级 ref，§7：不进 Pinia，遵循 weakStrongSetRef 同款 ref-driven 范式）=====
// loadedAt：本次内存 map 的加载时刻（epoch ms），用于「跨过 15:00 收盘门槛后重读一次」。
const dragonState = ref({ date: '', map: new Map(), version: 0, loadedAt: 0 });
let _inflight = null; // { date, promise } 单飞保护
// 需要强制重读的日期（收盘覆盖写入了新的 T 腿后登记，用完即焚）
const _reloadDates = new Set();
// 已做过「缺票兜底抓取」的日期：每会话每个日期最多一次，避免反复烧猫抓额度
const _fallbackTried = new Set();
// 空缓存主动重试（一次性定时器，指数退避，拿到数据即停止）
let _emptyRetryTimer = null;
let _emptyRetryDelay = 0;
let _emptyRetryCount = 0;

/**
 * 云端为空时安排一次重读（页面早于 9:25 worker 写入时打开的场景）。
 * 有界：指数退避 + 最大次数，拿到数据立刻停止，不会长期空转（§32 禁止重复请求）。
 */
function _scheduleEmptyRetry(date) {
  if (_emptyRetryTimer || _emptyRetryCount >= EMPTY_RETRY_MAX_TIMES) return;
  const delay = _emptyRetryDelay === 0 ? EMPTY_RETRY_FIRST_MS : Math.min(_emptyRetryDelay * 2, EMPTY_RETRY_MAX_MS);
  _emptyRetryDelay = delay;
  _emptyRetryTimer = setTimeout(function() {
    _emptyRetryTimer = null;
    _emptyRetryCount++;
    const s = dragonState.value;
    if (s.date !== date || s.map.size > 0) return; // 已拿到数据（或已切日期）→ 不再重试
    ensureDragonRangePct(date).catch(function(e) {
      console.warn('[DRAGON] 空缓存重试失败:', e && e.message);
    });
  }, delay);
}

function _stopEmptyRetry() {
  if (_emptyRetryTimer) { clearTimeout(_emptyRetryTimer); _emptyRetryTimer = null; }
  _emptyRetryDelay = 0;
  _emptyRetryCount = 0;
}

/** 当前已加载的区间涨幅（仅当 date 匹配时有效，否则返回 null）。同步读取，供 view-helpers 用。 */
export function getDragonRangePct(date) {
  const s = dragonState.value;
  if (!date || s.date !== date) return null;
  return s.map;
}

/**
 * 单只股票的「近 10 个交易日区间涨幅」（供展开面板核对数据准确性）。
 * 无数据 / 未加载 / 日期不匹配 → 返回 null（调用方必须据此【不显示该项】，
 * 绝不能退化为 0 或 '-' 伪装成"涨幅为 0"，否则会误导用户核对结果）。
 * @param {string} date
 * @param {string} stockName
 * @returns {{pct:number|null, days:number}|null}
 */
export function getStockRangePct(date, stockName) {
  const map = getDragonRangePct(date);
  if (!map || !stockName) return null;
  const v = map.get(String(stockName).trim());
  return v || null;
}

/** 增量渲染指纹令牌：龙头数据变化时必须让行缓存整体失效。 */
export function getDragonFingerprintToken() {
  const s = dragonState.value;
  return s.date + '|v' + s.version + '|n' + s.map.size;
}

export function clearDragonRangePct() {
  _stopEmptyRetry();
  if (dragonState.value.date === '' && dragonState.value.map.size === 0) return;
  dragonState.value = { date: '', map: new Map(), version: dragonState.value.version + 1, loadedAt: 0 };
}

/**
 * 让指定日期的 10 日涨幅/龙头排位【重读并重算一次】。
 * 供「收盘涨幅覆盖」成功后调用：覆盖把 change_pct 从竞价值换成真实收盘值，
 * 同时 stock_range_pct 的 T 腿也被替换，必须重读才能按收盘口径重新排位。用完即焚。
 * @param {string} date
 */
export function invalidateDragonRange(date) {
  if (!date) return;
  _reloadDates.add(date);
  if (dragonState.value.date === date) clearDragonRangePct();
}

/** 窗口日期（降序：[T, T-1, ... , T-9]，最多 10 个交易日） */
export function getDragonWindowDates(date) {
  const dates = [date];
  let d = date;
  for (let i = 0; i < DRAGON_RANGE_DAYS - 1; i++) {
    d = getPreviousTradingDay(d);
    if (!d) break;
    dates.push(d);
  }
  return dates;
}

function _beijingMinutes() {
  const n = new Date();
  return ((n.getUTCHours() + 8) % 24) * 60 + n.getUTCMinutes();
}

/** 北京 15:00 对应的 UTC 时间戳（用于判断内存缓存是否还是「竞价腿口径」） */
function _closeCoverUtcMs(dateStr) {
  return Date.parse(dateStr + 'T00:00:00Z') + (CLOSE_COVER_HOUR - 8) * 3600000;
}

/** 是否处于 worker 写入区间涨幅的时间窗（云端为空属正常，不该抢跑兜底） */
function _inWorkerWindow(date) {
  if (date !== _getLocalTodayStr()) return false;
  const mins = _beijingMinutes();
  return mins >= WORKER_WRITE_FROM_MIN && mins <= WORKER_WRITE_TO_MIN;
}

/**
 * 加载某日的「10 日区间涨幅」：读云端 → 发布 → （缺票时）一次猫抓 daily 兜底 → 回写云端。
 * @param {string} date - 当前看板日期 T
 * @param {{force?:boolean}} [opts] - force=true 忽略缓存重读一次（后台按钮）
 * @returns {Promise<Map<string, {pct:number|null, days:number}>|null>}
 */
export async function ensureDragonRangePct(date, opts) {
  const force = !!(opts && opts.force);
  if (!date) return null;
  const cur = dragonState.value;
  if (!force && cur.date === date && cur.map) {
    const isEmpty = cur.map.size === 0;
    // 需要重读的三种情况：收盘覆盖后登记过 / 内存是 15:00 前的竞价腿口径且现在已过收盘 / 云端为空且已过重试间隔
    const needReload = _reloadDates.has(date)
      || (cur.loadedAt > 0 && cur.loadedAt < _closeCoverUtcMs(date) && Date.now() >= _closeCoverUtcMs(date))
      || (isEmpty && Date.now() - cur.loadedAt >= EMPTY_RETRY_MS);
    if (!needReload) return cur.map;
  }
  // 非强制：复用同一次进行中的请求（单飞，杜绝并发重复消耗额度）。
  if (_inflight && _inflight.date === date && !force) return _inflight.promise;
  const p = _load(date, force);
  _inflight = { date: date, promise: p };
  try {
    return await p;
  } finally {
    if (_inflight && _inflight.promise === p) _inflight = null;
  }
}

/** 发布到内存（换新引用 + 版本号自增，驱动依赖它的行重渲染 §17；不刷新 loadedAt 时按原值透传） */
function _publish(date, map, loadedAt) {
  dragonState.value = {
    date: date,
    map: map,
    version: dragonState.value.version + 1,
    loadedAt: loadedAt === undefined ? Date.now() : loadedAt
  };
}

async function _load(date, force) {
  if (force) {
    _fallbackTried.delete(date);
    _reloadDates.delete(date);
  }
  // 1) 云端缓存（读取失败必须抛错，由调用方提示；不静默当空数据 —— §10）
  let cloud;
  try {
    cloud = await readRangePctForDate(date);
  } catch (e) {
    _dbgLog('[DRAGON] 读取 stock_range_pct 失败: ' + (e && e.message || e));
    throw new Error('读取龙头涨幅缓存失败（表 stock_range_pct 是否已创建？执行 db/create_stock_range_pct.sql）：' + (e && e.message || e));
  }
  const map = new Map();
  cloud.forEach(function(v, k) { map.set(k, { pct: v.pct, days: v.days }); });
  // §33：先发布云端已有数据 —— 绝不因为随后可能发生的「兜底补齐」而把整份数据扣住不显示。
  _publish(date, map);
  _reloadDates.delete(date);
  // 云端还没有这一天的数据（页面早于 9:25 打开 / worker 尚未写完）→ 安排一次有界重读
  if (map.size === 0) _scheduleEmptyRetry(date);

  // 2) 云端缺票 → 一次猫抓 daily 兜底（覆盖「前日竞昨高光」等不在 worker 抓取名单里的票，
  //    以及 worker 当天写入失败的情况）。云端非空时不抢跑 worker 的 9:25 写入。
  const missing = _missingTargetRows(date, map);
  if (missing.length > 0 && !_fallbackTried.has(date) && !(cloud.size === 0 && _inWorkerWindow(date))) {
    _fallbackTried.add(date);
    let rows = [];
    let err = null;
    try {
      rows = await _fetchRangeFor(date, missing);
    } catch (e) {
      err = e;
      _dbgLog('[DRAGON] 缺票兜底抓取失败: ' + (e && e.message || e));
    }
    if (rows.length > 0) {
      rows.forEach(function(r) { map.set(r.stock, { pct: r.pct, days: r.days }); });
      _publish(date, map);
      try {
        await upsertRangePctRows(date, rows);
      } catch (e) {
        // 内存已生效，写云失败只留痕（下次仍会重新读云端，不影响本次展示）
        _dbgLog('[DRAGON] 兜底结果写云失败: ' + (e && e.message || e));
      }
      _dbgLog('[DRAGON] 缺票兜底补齐 ' + rows.length + '/' + missing.length + ' 只：' + rows.map(function(r) { return r.stock; }).join('、'));
    } else if (cloud.size === 0) {
      // 云端空 + 兜底也取不到 → 必须让用户看见（§10 禁止静默失败），不能显示成「今天没有 10 日涨幅」
      throw err || new Error('10 日涨幅取不到（云端无缓存，猫抓 daily 也未返回数据）：' + date);
    }
  }
  return dragonState.value.date === date && dragonState.value.map ? dragonState.value.map : map;
}

/**
 * 云端缺哪些目标股票（§6 名单单一真相见 getDragonTargetRows）。
 * ⚠️ 判定为「云端没有这一行」而不是「值为 null」：worker 写过的行即使涨幅为空也算已处理，
 * 否则会为了少数长期停牌/次新股反复发起兜底请求（§32 禁止重复请求）。
 */
function _missingTargetRows(date, map) {
  let rows = [];
  try {
    rows = getDragonTargetRows(date) || [];
  } catch (e) {
    _dbgLog('[DRAGON] 目标名单读取失败: ' + (e && e.message || e));
    return [];
  }
  const out = [];
  const seen = new Set();
  rows.forEach(function(r) {
    const n = String((r && r.stock) || '').trim();
    if (!n || seen.has(n) || map.has(n)) return;
    seen.add(n);
    out.push(r);
  });
  return out;
}

/**
 * 【兜底抓取】对指定股票用【一次】猫抓 daily 请求算出区间涨幅（不消耗多次额度）。
 * 口径与 worker 完全一致（共用 range-window.js 纯函数）。
 * @param {string} date
 * @param {Array<object>} targetRows
 * @returns {Promise<Array<{stock:string, pct:number, days:number}>>}
 */
async function _fetchRangeFor(date, targetRows) {
  try {
    await ensureAuctionCodeMapping(targetRows);
  } catch (e) {
    _dbgLog('[DRAGON] 兜底前自动补码失败: ' + (e && e.message || e));
  }
  const scMap = (state && state._scMapCache) || {};
  const dated = [];
  targetRows.forEach(function(r) {
    const name = String((r && r.stock) || '').trim();
    if (!name) return;
    const code = String((r && r.code) || scMap[name] || '').trim();
    if (code) dated.push({ name: name, code: code, row: r });
  });
  if (dated.length === 0) return [];

  const dates = getDragonWindowDates(date);
  const startYmd = dates[dates.length - 1].replace(/-/g, '');
  const endYmd = dates[0].replace(/-/g, '');
  const byCode = await fetchNumcatDailyPctRange(dated.map(function(d) { return d.code; }).join(','), startYmd, endYmd);
  if (!byCode || byCode.size === 0) return [];

  const ascDates = dates.slice().reverse(); // 升序 T-9 → T
  const sysToday = _getLocalTodayStr();
  const afterClose = ((new Date().getUTCHours() + 8) % 24) >= CLOSE_COVER_HOUR;
  const auctionLeg = isAuctionLegActive(date, sysToday, afterClose);

  const out = [];
  dated.forEach(function(d) {
    const dayMap = byCode.get(d.code);
    if (!dayMap) return;
    const legs = [];
    ascDates.forEach(function(day) {
      const ymd = day.replace(/-/g, '');
      let v = dayMap.has(ymd) ? dayMap.get(ymd) : null;
      if (day === date) {
        // T 腿口径单一真相：今天+未收盘 → 竞价涨幅占位；其余 → 收盘涨幅（缺失才回退行内涨幅/竞价）
        v = auctionLeg
          ? parsePct(d.row.auc_pct_chg || d.row.aucPctChg)
          : resolveTDayPct(false, afterClose, (v !== null && v !== undefined) ? v : (d.row.changePct || d.row.change_pct), d.row.auc_pct_chg || d.row.aucPctChg);
      }
      if (v !== null && v !== undefined && !isNaN(v)) legs.push(v);
    });
    const pct = compoundPct(legs);
    if (pct === null) return;
    out.push({ stock: d.name, pct: pct, days: legs.length });
  });
  return out;
}

/**
 * 【10 日涨幅目标名单 · 单一真相 / 2026-09-09】
 * 取值集合必须等于「看板当天真正会渲染出来的行」，否则必然出现
 * 「同一屏里有的股票有 10 日涨幅、有的没有」——用户反馈的带 * 票缺失就是这么来的：
 *   ① 当日正式成员行（_getAuctionFormalRowsForDate，已排除 market_metrics 影子行）；
 *   ② 观察组继承名：打标签继承（tag-carryover）+ 前一日竞昨高光（sort-rules）。
 *      这两类只在视图层注入 renderList，不在 _auctionMemCache / auction_watchlist。
 * 行数据优先取内存当日【全量】行（含 market_metrics 影子行，带 auc_pct_chg / code）；
 * 取不到就只留股票名（代码由 ensureAuctionCodeMapping / scMap 兜底）。
 * ⚠️ 该集合是「云端缺票兜底」的判断依据，也是收盘覆盖的名单来源（close-pct-cover 复用）。
 * @param {string} date
 * @returns {object[]} 参与 10 日涨幅计算的行
 */
export function getDragonTargetRows(date) {
  const byName = new Map();
  function _put(row) {
    if (!row || !row.stock) return;
    const n = String(row.stock).trim();
    if (n && !byName.has(n)) byName.set(n, row);
  }
  (_getAuctionFormalRowsForDate(date) || []).forEach(_put);

  const extra = new Set();
  try {
    const carry = getCarryOverNamesForDate(date);
    if (carry) carry.forEach(function(n) { if (n) extra.add(String(n).trim()); });
  } catch (e) {
    _dbgLog('[DRAGON] 打标签继承名读取失败: ' + (e && e.message || e));
  }
  try {
    const prevDate = getPreviousTradingDay(date);
    const set = prevDate ? getJingYestHighlightSetForDate(prevDate) : null;
    if (set) set.forEach(function(n) { if (n) extra.add(String(n).trim()); });
  } catch (e) {
    _dbgLog('[DRAGON] 前一日竞昨高光读取失败: ' + (e && e.message || e));
  }
  if (extra.size === 0) return Array.from(byName.values());

  // 内存当日全量行（含影子行）作为数据补齐来源：观察组继承票常被 worker 写过 market_metrics
  const memByName = new Map();
  try {
    const g = getAuctionData();
    ((g && g[date]) || []).forEach(function(r) {
      if (!r || !r.stock) return;
      const n = String(r.stock).trim();
      if (n && !memByName.has(n)) memByName.set(n, r);
    });
  } catch (e) {
    _dbgLog('[DRAGON] 当日内存行读取失败: ' + (e && e.message || e));
  }
  extra.forEach(function(n) {
    if (!n || byName.has(n)) return;
    byName.set(n, memByName.get(n) || { stock: n });
  });
  return Array.from(byName.values());
}

// ===== 纯函数：题材组内排名 =====
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 龙一/龙二…标签文案（超过 10 用数字，避免生造汉字） */
export function getDragonLabel(rank) {
  if (!rank || rank < 1) return '';
  if (rank <= 10) return '龙' + CN_NUM[rank];
  if (rank < 20) return '龙十' + CN_NUM[rank - 10];
  return '龙' + rank;
}

/**
 * 按题材组计算龙头排名。
 * @param {Array<{name:string, topic:string, pct:number}>} entries - 参与排名的股票
 * @param {{coloredTopics?: Set<string>|null, minGroupSize?: number}} [opts]
 *        coloredTopics 非空时只给「已上色题材」（= 界面同颜色块，成员>=2 的真实题材）排名
 * @returns {Map<string, {rank:number, pct:number, topic:string, groupSize:number}>}
 */
export function computeDragonRankMap(entries, opts) {
  const result = new Map();
  if (!entries || entries.length === 0) return result;
  const colored = (opts && opts.coloredTopics) || null;
  const minSize = (opts && opts.minGroupSize) || 2;

  const groups = new Map();
  entries.forEach(function(e) {
    if (!e || !e.name || !e.topic || e.topic === '其它') return;
    if (e.pct === null || e.pct === undefined || isNaN(e.pct)) return;
    if (colored && !colored.has(e.topic)) return;
    if (!groups.has(e.topic)) groups.set(e.topic, []);
    groups.get(e.topic).push(e);
  });

  groups.forEach(function(arr, topic) {
    if (arr.length < minSize) return;
    arr.sort(function(a, b) { return b.pct - a.pct; });
    arr.forEach(function(e, i) {
      result.set(e.name, {
        rank: i + 1,
        pct: e.pct,
        topic: topic,
        groupSize: arr.length
      });
    });
  });
  return result;
}
