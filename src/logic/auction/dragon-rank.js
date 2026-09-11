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
  fetchNumcatDailyPctRange,
  fetchFuyaoDailyPctRange
} from '../../data/stock-range-pct.js';
import { _dbgLog } from '../../data/debug-log.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
// 口径单一真相（纯函数，worker 与前端共用同一份实现）
import {
  RANGE_WINDOW_DAYS, parsePct, compoundPct, resolveTDayPct, isAuctionLegActive,
  buildRangeRows, collectDailyLegs
} from './range-window.js';

export const DRAGON_RANGE_DAYS = RANGE_WINDOW_DAYS;
/** 北京时间 15:00 之后，当天收盘涨幅已可覆盖早盘竞价涨幅（T 腿口径判定用） */
const CLOSE_COVER_HOUR = 15;
/**
 * worker 收盘重算时刻（北京 16:00）+ 缓冲：此后云端的区间涨幅才是【权威收盘口径】。
 * 用于判断内存快照是否需要在跨过 16:00 后重读一次 —— 页面在 15:0x 已自愈重读过的用户，
 * 若不重读就拿不到 worker 16:00 的重算结果（§17 不能依赖用户手动刷新碰巧生效）。
 */
const WORKER_CLOSE_HOUR = 16;
const WORKER_CLOSE_BUFFER_MIN = 5;
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
// 已做过「缺票兜底抓取」的日期 → 已尝试的阶段（'intraday' 盘中 / 'close' 收盘后）。
// [RANGE-FULL-LEG 2026-09-11] 原来是一个 Set（每日期每会话最多一次）→ 9:26 那次尝试过后，
// 收盘后即使发现某行「缺腿」（当日继承票 9:25 没拿到 T 腿）也不会再补，错值一直挂到第二天。
// 现在改为「每阶段最多一次」：盘中最多 1 次（拿不到 T 腿时也可能只是白跑），收盘后最多再 1 次
// （此时 T 腿一定取得到=收盘涨幅，重算结果即最终正确值）。有界：每日最多 2 次。
const _fallbackTried = new Map();
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

/**
 * 兜底抓取的「阶段」：15:00 前 = 盘中（T 腿可能只能取到竞价涨幅，甚至取不到），
 * 15:00 起 = 收盘（T 腿一定取得到收盘涨幅 → 重算结果即最终值）。
 * 每阶段各允许一次兜底，避免盘中那次尝试把收盘后的自愈机会吃掉。
 */
function _fallbackPhase() {
  return _beijingMinutes() >= CLOSE_COVER_HOUR * 60 ? 'close' : 'intraday';
}

/** worker 收盘重算完成时刻（北京 16:05）对应的 UTC 时间戳 */
function _authoritativeCloseUtcMs(dateStr) {
  if (!dateStr) return NaN;
  const base = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(base)) return NaN;
  return base + (WORKER_CLOSE_HOUR - 8) * 3600000 + WORKER_CLOSE_BUFFER_MIN * 60000;
}

/**
 * 该日的【收盘口径数据】是否已权威（供 view-helpers 给「收盘红绿 / 收盘停板」做闸门）。
 *
 * 为什么不能只用「北京 15:00」：15:00~16:00 之间 market_metrics.change_pct 很可能仍是
 * 9:25 写入的【竞价副本】（前端 close-pct-cover 与 worker 16:00 才把它改成收盘值）。
 * 用竞价数据当收盘结果去数「N红M绿」「涨停跌停」会系统性误导。
 * 因此门槛统一取本模块既有的「worker 权威重算时刻 = 北京 16:05」：
 *   · 历史日期 → true（次日早盘 worker 已把 change_pct 回填成收盘值）；
 *   · 当天     → 需已过 16:05；
 *   · 未来日期 → false。
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function isAuthoritativeCloseReached(date) {
  if (!date) return false;
  const today = _getLocalTodayStr();
  if (date < today) return true;
  if (date > today) return false;
  return Date.now() >= _authoritativeCloseUtcMs(date);
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
    // 需要重读的三种情况：收盘覆盖后登记过 / 内存快照早于 worker 的 16:00 权威重算时刻 / 云端为空且已过重试间隔
    const authMs = _authoritativeCloseUtcMs(date);
    const needReload = _reloadDates.has(date)
      || (cur.loadedAt > 0 && !Number.isNaN(authMs) && cur.loadedAt < authMs && Date.now() >= authMs)
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

  // 2) 补齐「缺行 / 缺腿」的目标股票。三级链路，从「不花额度」到「花额度」：
  //    [RANGE-FULL-LEG 2026-09-11] 收盘后额外把「缺腿行」（days < 窗口交易日数）也纳入待补：
  //    这类行当时没拿到 T 腿（次日继承票常见），只有【整段重算】能修好，代数换腿会算错。
  //    [LOCAL-RECOMPUTE 2026-09-11] 三级顺序（用户反馈「存起来了本地就能算」）：
  //      ① 本地重算（0 请求）：内存里已存齐窗口的票直接重算 —— 猫抓额度用尽时这是唯一出路；
  //      ② 猫抓 daily（1 请求）：补齐本地凑不出完整窗口的票（它能看到库里没有的历史日）；
  //      ③ 本地残缺值兜底（0 请求）：猫抓也拿不到时，写「N 天真实累乘」而不是留着错值。
  const phase = _fallbackPhase();
  const pending = _missingTargetRows(date, map, phase === 'close');
  if (pending.length > 0 && !(cloud.size === 0 && _inWorkerWindow(date))) {
    const expectedLegs = getDragonWindowDates(date).length;
    const applied = new Set();

    /** 统一落库：内存 map → 发布（驱动重渲染）→ 写云（失败只留痕，不影响本次展示） */
    const _applyAssembly = async function(rows, stage) {
      if (!rows || rows.length === 0) return;
      rows.forEach(function(r) {
        map.set(r.stock, { pct: r.pct, days: r.days });
        applied.add(r.stock);
      });
      _publish(date, map);
      try {
        await upsertRangePctRows(date, rows);
      } catch (e) {
        _dbgLog('[DRAGON] ' + stage + '结果写云失败: ' + (e && e.message || e));
      }
      _dbgLog('[DRAGON] ' + stage + '补齐 ' + rows.length + ' 只：' +
        rows.map(function(r) { return r.stock + '(' + Number(r.pct).toFixed(2) + '%/d' + r.days + ')'; }).join('、'));
    };

    // ---- ① 本地重算（0 请求）----
    let assembled = [];
    try {
      assembled = _assembleRangeFromMemory(date, pending);
    } catch (e) {
      _dbgLog('[DRAGON] 本地重算失败（非致命）: ' + (e && e.message || e));
    }
    const ready = assembled.filter(function(r) { return Number(r.days) >= expectedLegs; });
    // 凑不满窗口的先扣在手里当兜底（②失败或没覆盖到时才用）
    const lastResort = new Map();
    assembled.forEach(function(r) {
      if (Number(r.days) < expectedLegs) lastResort.set(r.stock, r);
    });
    await _applyAssembly(ready, '本地重算');

    // ---- ② 权威抓取：猫抓 daily 主 → 同花顺 K 线补（都不依赖本地内存）----
    const remain = pending.filter(function(r) {
      return !applied.has(String((r && r.stock) || '').trim());
    });
    if (remain.length > 0 && _fallbackTried.get(date) !== phase) {
      _fallbackTried.set(date, phase);
      let err = null;
      let rows = [];
      try {
        rows = await _fetchRangeFor(date, remain);
      } catch (e) {
        err = e;
        _dbgLog('[DRAGON] 缺票兜底抓取失败: ' + (e && e.message || e));
      }
      await _applyAssembly(rows, '缺票兜底(猫抓)');

      // 通道二：猫抓没覆盖到的（额度用尽 / 未结算 / 停牌股无行）走同花顺 K 线。
      // 2026-09-11 实测：猫抓额度白天就耗尽，只靠通道一，缺腿行会一直错到第二天。
      const stillRemain = remain.filter(function(r) {
        return !applied.has(String((r && r.stock) || '').trim());
      });
      if (stillRemain.length > 0) {
        try {
          const rows2 = await _fetchRangeFromKline(date, stillRemain);
          await _applyAssembly(rows2, '缺票兜底(同花顺K线)');
        } catch (e) {
          _dbgLog('[DRAGON] 同花顺 K 线兜底失败: ' + (e && e.message || e));
        }
      }

      if (cloud.size === 0 && applied.size === 0) {
        // 云端空 + 所有通道都取不到 → 必须让用户看见（§10 禁止静默失败），
        // 不能显示成「今天没有 10 日涨幅」
        throw err || new Error('10 日涨幅取不到（云端无缓存，猫抓 daily 与同花顺 K 线均未返回数据）：' + date);
      }
    }

    // ---- ③ 本地残缺值兜底（0 请求）：只给「云端压根没有这一行」的票垫一个真实累乘值 ----
    //   ⚠️ 为什么【不覆盖】云端已有的残缺行（2026-09-11 实测教训）：
    //     `days` 只表示「累了几根腿」，不表示「累的是哪几天」。实测 百大集团：
    //       · 云端残缺行 = 9 根腿（8/31~9/10，numcat 有 8/31 而我们的库没有）被代数换腿搞错；
    //       · 本地重算    = 9 根腿（9/1~9/11，因为我们库里没有 8/31 这行）。
    //     两者 days 相同、日期集合不同 → 「legs 不少于库内」并不能证明本地值更准
    //     （实际本地 44.62% 离真值 42.29% 更远）。所以残缺行一律留给 ② 的权威重算
    //     （猫抓 daily / 同花顺 K 线都能取到我们库里没有的历史日），两者都失败就保持原值
    //     —— 宁缺勿错。
    //     只有「云端完全没有这一行」时才用本地值垫底：那时权威通道已经失败过，
    //     有值(且是真实累乘、UI 会标注 (N/10日)) 总好过整列空白。
    const leftover = [];
    remain.forEach(function(r) {
      const n = String((r && r.stock) || '').trim();
      if (applied.has(n) || cloud.has(n)) return;
      const lr = lastResort.get(n);
      if (lr) leftover.push({ stock: lr.stock, pct: lr.pct, days: lr.days });
    });
    await _applyAssembly(leftover, '本地重算(部分窗口)');
  }
  return dragonState.value.date === date && dragonState.value.map ? dragonState.value.map : map;
}

/**
 * 云端缺哪些目标股票（§6 名单单一真相见 getDragonTargetRows）。
 * ⚠️ 默认判定为「云端没有这一行」而不是「值为 null」：worker 写过的行即使涨幅为空也算已处理，
 * 否则会为了少数长期停牌/次新股反复发起兜底请求（§32 禁止重复请求）。
 *
 * [RANGE-FULL-LEG 2026-09-11] includeIncomplete=true 时，额外把「缺腿行」也算作待补：
 *   days < 该日窗口交易日数 → 说明当时没拿到 T 腿（区间涨幅少累乘了一天，系统性偏低）。
 *   仅收盘后（phase='close'）启用 —— 此时 T 腿必定取得到收盘涨幅，重算即最终正确值。
 *   刻意不在盘中启用：盘中 T 腿可能同样取不到，重算会得到又一个缺腿行 → 白烧一次额度。
 * @param {string} date
 * @param {Map<string, {pct:number|null, days:number}>} map
 * @param {boolean} [includeIncomplete]
 */
function _missingTargetRows(date, map, includeIncomplete) {
  let rows = [];
  try {
    rows = getDragonTargetRows(date) || [];
  } catch (e) {
    _dbgLog('[DRAGON] 目标名单读取失败: ' + (e && e.message || e));
    return [];
  }
  const expectedLegs = getDragonWindowDates(date).length;
  const out = [];
  const seen = new Set();
  rows.forEach(function(r) {
    const n = String((r && r.stock) || '').trim();
    if (!n || seen.has(n)) return;
    const cur = map.get(n);
    if (cur) {
      // 已有行 → 仅当被显式要求「补齐缺腿」且该行确实缺腿时才重新抓
      if (!includeIncomplete) return;
      if (!(Number(cur.days) > 0 && Number(cur.days) < expectedLegs)) return;
    }
    seen.add(n);
    out.push(r);
  });
  return out;
}

/** 逐日收盘涨幅的字段别名（内存行同时存在 snake/camel 两种写法） */
const CLOSE_PCT_KEYS = ['changePct', 'change_pct'];
/** 9:25 竞价涨幅的字段别名 */
const AUC_PCT_KEYS = ['auc_pct_chg', 'aucPctChg'];

/** 从行里按候选键取第一个可解析的涨幅；都取不到 → null（§10 绝不用 0 顶替） */
function _pctOf(row, keys) {
  if (!row) return null;
  for (let i = 0; i < keys.length; i++) {
    const raw = row[keys[i]];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = parsePct(raw);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 【本地重算 · 0 请求 / LOCAL-RECOMPUTE 2026-09-11】
 * 把「缺行 / 缺腿」的目标股票，用【已经拉进内存的逐日数据】重新组装成区间涨幅。
 *
 * 为什么需要它（用户反馈「数据自动获取后没存起来吗？存起来本地算也算得出」）：
 *   区间涨幅的历史日腿其实早已落库（每天一行 market_metrics.change_pct），而首屏会把最近
 *   30 个自然日整段拉进内存（auction-pull-window）。因此当 stock_range_pct 出现
 *   「days < 窗口长度」的残缺行时，根本不必再去猫抓要数据 —— 直接拿内存里的逐日涨幅
 *   + 已知的 T 腿重新 `buildRangeRows` 即可。好处：
 *     · 0 额度消耗（猫抓每天只有 10 次，16:00 那次经常已用尽）；
 *     · 不受「猫抓当日/近几日不给四要素或窗口」影响；
 *     · 与 worker 口径完全一致（同一个 range-window.js，同一个组装实现）。
 *
 * ⚠️ 绝不使用 replaceTDayLeg（代数换腿）：残缺行里根本没有那根竞价 T 腿，反解必然算错
 *    （2026-09-11 国芳集团 91.11% 事故）。这里走的是【重新组装】，不是换算。
 *
 * 内存里凑不满整个窗口时也会返回残缺结果（days < 窗口），由调用方决定是否作为兜底写入 ——
 * 「9 天真实累乘」也远好过「代数反解出来的错值」，且 UI 会显示 `+x.xx%(9/10日)`。
 *
 * @param {string} date 看板日期 T
 * @param {object[]} pendingRows 需要重算的目标行（来自 getDragonTargetRows 的子集）
 * @returns {Array<{stock:string, pct:number, days:number}>}
 */
function _assembleRangeFromMemory(date, pendingRows) {
  if (!date || !pendingRows || pendingRows.length === 0) return [];

  // 升序窗口 [T-9 ... T]，与 worker / _fetchRangeFor 同一份日期口径
  const ascDates = getDragonWindowDates(date).slice().reverse();

  // 逐日建「股票名 → 当日行」索引。只取每天第一行（同日同名不会重复，双保险）。
  const g = getAuctionData() || {};
  const rowsByDate = new Map();
  ascDates.forEach(function(d) {
    const m = new Map();
    const list = (g && g[d]) || [];
    list.forEach(function(r) {
      if (!r || !r.stock) return;
      const n = String(r.stock).trim();
      if (n && !m.has(n)) m.set(n, r);
    });
    rowsByDate.set(d, m);
  });

  const sysToday = _getLocalTodayStr();
  const afterClose = _beijingMinutes() >= CLOSE_COVER_HOUR * 60;
  const isToday = date === sysToday;

  // 腿口径单一真相：T 腿 → resolveTDayPct（今天未收盘取竞价，其余取收盘）；
  // 历史日 → 一律取收盘涨幅 change_pct（缺失才作罢，绝不补 0）。
  function legOf(row, d) {
    if (d === date) {
      return resolveTDayPct(isToday, afterClose, _pctOf(row, CLOSE_PCT_KEYS), _pctOf(row, AUC_PCT_KEYS));
    }
    return _pctOf(row, CLOSE_PCT_KEYS);
  }

  const collected = collectDailyLegs(
    pendingRows.map(function(r) {
      return { name: String((r && r.stock) || '').trim(), code: (r && r.code) || '' };
    }),
    ascDates,
    rowsByDate,
    legOf
  );
  return buildRangeRows(collected.targets, ascDates, collected.dailyByCode, collected.tLegByCode);
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
 * 【兜底抓取 · 通道二：同花顺 K 线】猫抓 daily 不可用（额度用尽 / 未结算）时用它补齐。
 *
 * [KLINE-FALLBACK 2026-09-11] 为什么必须有这一条：猫抓额度每天只有 10 次，
 * 2026-09-11 实测白天就把额度用尽（返回 403「今日调用额度已用完」），于是：
 *   · worker 16:00 的整段重算拿不到窗口 → 退化为「只换 T 腿」→ 缺腿行被跳过；
 *   · 前端猫抓兜底同样打不通 → 7 只缺腿行的错值（国芳集团 91.11%）当天无法自愈。
 * 同花顺 K 线没有每日额度限制（`close-pct-cover` 的收盘涨幅兜底早就用它），因此这里
 * 把它接成「通道二」，让 10 日涨幅的修复【完全不依赖猫抓额度】。
 *
 * ⚠️ 与已删除的「前端逐只同花顺补齐」不同（那是给全部 64 只票每只 4.7s 的常规补齐，
 *    是真的「加载一分钟」根因）：这里只跑【确实缺行/缺腿的少数票】，且只在猫抓通道
 *    失败后触发、每阶段最多一次，`fetchFuyaoDailyPctRange` 自带并发 3 + 截断重试 + 熔断。
 *
 * @param {string} date
 * @param {Array<object>} targetRows
 * @returns {Promise<Array<{stock:string, pct:number, days:number}>>}
 */
async function _fetchRangeFromKline(date, targetRows) {
  try {
    await ensureAuctionCodeMapping(targetRows);
  } catch (e) {
    _dbgLog('[DRAGON] K 线兜底前自动补码失败: ' + (e && e.message || e));
  }
  const scMap = (state && state._scMapCache) || {};
  const items = [];
  targetRows.forEach(function(r) {
    const name = String((r && r.stock) || '').trim();
    if (!name) return;
    const code = String((r && r.code) || scMap[name] || '').trim();
    if (code) items.push({ stock: name, code: code });
  });
  if (items.length === 0) return [];

  const dates = getDragonWindowDates(date);
  const ascDates = dates.slice().reverse(); // 升序 [T-9 ... T]
  // 同花顺 K 线取全窗口（含当天）：当天已收盘时 K 线里就有当天收盘价
  const byName = await fetchFuyaoDailyPctRange(items, ascDates, { concurrency: 3 });
  if (!byName || byName.size === 0) return [];

  const sysToday = _getLocalTodayStr();
  const afterClose = _beijingMinutes() >= CLOSE_COVER_HOUR * 60;
  const isToday = date === sysToday;
  const auctionLeg = isAuctionLegActive(date, sysToday, afterClose);
  const tYmd = date.replace(/-/g, '');

  const out = [];
  targetRows.forEach(function(r) {
    const name = String((r && r.stock) || '').trim();
    const dayMap = byName.get(name);
    if (!name || !dayMap) return;
    const row = r || {};
    const legs = [];
    ascDates.forEach(function(d) {
      const ymd = d.replace(/-/g, '');
      let v = dayMap.has(ymd) ? dayMap.get(ymd) : null;
      if (ymd === tYmd) {
        // T 腿口径单一真相（与 _fetchRangeFor 完全一致）：
        // 今天未收盘 → 竞价涨幅占位；否则收盘涨幅（K 线优先，缺失才回退行内涨幅）
        v = auctionLeg
          ? parsePct(row.auc_pct_chg || row.aucPctChg)
          : resolveTDayPct(isToday, afterClose,
              (v !== null && v !== undefined ? v : _pctOf(row, CLOSE_PCT_KEYS)),
              _pctOf(row, AUC_PCT_KEYS));
      }
      if (v === null || v === undefined || !isFinite(v)) return;
      legs.push(Number(v));
    });
    const pct = compoundPct(legs);
    if (pct === null) return;
    out.push({ stock: name, pct: pct, days: legs.length });
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
