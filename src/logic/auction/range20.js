// range20.js — 「20日涨幅」toggle 的数据层唯一实现（Logic 层，§15 独立业务模块）
//
// ===== 产品口径（2026-10-19 用户原话）=====
//   「名称换成20日涨幅……我打开这个toggle时，就会按照20日涨幅，由高到低排序。和十日涨幅toggle类似，
//    只是时间段涨幅不一样……这个20日涨幅你要算清楚（停牌也算，比如新华传媒停牌三天，每天涨幅是0%，
//    不涨也不跌，按照时间段也算进去，因为就给20天这个时间段），最新的时间点算到当天的竞价涨幅，
//    比如今天的，只算到竞价涨幅，昨天的或者历史的算到收盘。包括今天在内，算20天的。
//    ……记住用今天的竞价涨幅，而不是今天收盘涨幅。」
//
// ⇒ 三条硬口径：
//   ① 窗口 = 【含今天在内】的 20 个交易日（[T-19, T]）；
//   ② 复利累乘（与 range-window.js#compoundPct 同一实现，⛔ 不另写一套）；
//   ③ T 腿：展示日 === 本地今天 ⇒ **竞价涨幅**优先；历史日 ⇒ 收盘涨幅优先。
//
// ===== 与「十日涨幅」的关键差异（⛔ 别照抄它）=====
//   · 十日涨幅的 T 腿走 `range-window.js#resolveTDayPct`（15:00 后自动切收盘）；
//     本模块**刻意不切**：用户口径是「等收盘没我什么事了」，20 日这个数是给 9:25 决策用的参考，
//     收盘后再跳一次会让人对不上早上看到的名次。⇒ 见 resolveT20Leg 的注释。
//   · 十日涨幅直接读云端 `stock_range_pct`（worker 已经算好、覆盖当天名单）；
//     但**表里没有 20 日行**，且主键是 `(date, stock)` —— 20 日行若 upsert 会把当天的 10 日行
//     整行覆盖掉（十日涨幅 / 龙位 / 决策看板全线被污染）。⇒ **⛔ 本模块绝不写库**，
//     只在【会话内存】里缓存（按 date 键控），刷新页面重算。
//
// ===== 取数（用户 2026-10-19 定的口径，⛔ 不消耗猫抓额度）=====
//   阶段① 库内数据（0 请求 / 0 额度）：逐日行来自 `market_metrics`（已被首屏 + 后台历史补齐
//          整段拉进内存，见 auction-pull-window.js）。T 腿取当行 `auc_pct_chg`，
//          历史日取 `change_pct`。**立刻发布**（此时可能只有 7~13 天，行上会显示「n/20日」）。
//   阶段② 同花顺 K 线补缺（免费额度、无每日次数限制）：只为「腿不够 20 天」的票发请求，
//          补齐后再发布一次（此时绝大多数票就是满 20 天）。
//          猫抓 `daily`（每日 10 次额度）**完全不用**。
//
// ===== 停牌怎么算（用户举例：新华传媒停牌三天，每天 0%）=====
//   停牌日没有成交 ⇒ 该日没有日涨幅腿。复利里 `×(1+0%)` 是**恒等变换**，
//   所以「跳过停牌日」与「按 0% 计入」得到的区间涨幅**数值完全一致**；
//   差别只体现在 `days` 上（停 3 天 ⇒ 17/20），行悬停提示会如实标出「n/20日」。
//   ⛔ 绝不给缺失的腿补 0 参与"有数据/没数据"的判定（§10：读取失败 ≠ 0%）。
//   唯一例外是「整段 20 天一根腿都没有」⇒ pct = null ⇒ 置底且不显示数值（不猜）。

import { ref } from 'vue';
import { state } from '../app-state.js';
import { getAuctionData } from '../app-core-api.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { compoundPct, parsePct } from './range-window.js';
import { getDragonWindowDates } from './dragon-rank.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 窗口长度：含今天在内的 20 个交易日（用户口径「包括今天在内，算20天的」） */
export const RANGE20_WINDOW_DAYS = 20;

/**
 * [RANGE20 2026-10-19] 取数探针长度 = 30 个「App 日历交易日」。
 *
 * ★ 为什么不是 20（血泪，别"顺手改回 20"）：
 *   本项目的交易日历 = `isTradingDay` = 「非周末 ∧ 不在 allData.holidays 里」，
 *   而 **云端 owner.data.holidays 目前是空数组**（实测 2026-10-19）⇒ 国庆/中秋这类
 *   工作日假期会被当成交易日。20 日窗口（09-14~10-19）里就混进了 6 个假交易日：
 *   2026-09-25、10-01、10-02、10-05、10-06、10-07（同花顺 K 线里根本没有这几天）。
 *   ⇒ 若按 App 日历直接取 20 天，实际只覆盖 14 个真实交易日，用户要的「20 个交易日」拿不到，
 *     而且 days=14/20 会让各票看起来"缺数据"。
 *   ⇒ 解法：取数时向后多要 10 个槽位，拿到 K 线后用【真实有成交的日期】重建窗口
 *     （见 pickRealWindowDates），取最后 20 个真实交易日 ⇒ 无论假期表修没修都正确。
 */
export const RANGE20_PROBE_DAYS = 30;

/** 收盘涨幅候选键（云端/内存行为 snake_case；本地手工行可能是 camelCase） */
const CLOSE_KEYS = ['changePct', 'change_pct'];
/** 竞价涨幅候选键（专用字段，⛔ 绝不用 changePct 代替 —— 它会被收盘覆盖改写成收盘涨幅） */
const AUC_KEYS = ['auc_pct_chg', 'aucPctChg'];

// ===== 状态（模块级 ref，§7：不进 Pinia，与 dragonState / suspendState 同款 ref-driven 范式）=====
// map: Map<股票名, { pct:number, days:number }>
// version：发布一次自增一次（供 incremental-view 的行缓存指纹）
const _state = ref({ date: '', map: new Map(), version: 0 });
/** 已发布结果的内容签名（date -> string）：防止「内容没变却重复发布」把行缓存整表刷掉（§17/§36） */
const _sig = new Map();
/**
 * 🔴 date -> 该日已发布的【最高阶段】（1 = 只用库内逐日行；2 = 已合并同花顺 K 线）。
 *
 * 为什么必须有它（2026-10-19 实测事故，别删）：
 *   `useAuctionBoard` 的取数 watch 依赖 `viewData.items.length`，看板加载过程中行数会变好几次
 *   （实测 6 → 41）⇒ `ensureRange20` 被连续调用多次。阶段② 只有在第一次调用时才跑（`_klineTried`
 *   登记后不再请求），但【后续每次调用都会跑阶段①】——阶段① 只有库内腿（14 天），
 *   它一发布就把阶段② 刚算好的「满窗 20 天」覆盖回去，而且因为 K 线已登记为 tried，
 *   再也不会重算 ⇒ 屏幕上永远停在 14/20（实测 token 一路涨到 v8、days 分布却与阶段① 一模一样）。
 *   ⇒ 阶段① 【绝不能覆盖】已合并过的日期。
 */
const _stage = new Map();
/**
 * date -> 该日【已发布过的最好一份结果】（rows 数组）。
 * 用途：切日期 A→B→A 时，`_state` 里只剩 B 的 Map，而 A 的 K 线已登记 tried 不会再请求
 * ⇒ 没有这份缓存就只能退回「库内腿」，用户会看到数值突然变差。切回时直接用缓存复原。
 */
const _cache = new Map();
/** 同花顺补算「已经跑过的票」（date -> Set<股票名>）：同一会话同一票不重复请求（§32） */
const _klineTried = new Map();
/** 单飞：`<date>|base` / `<date>|kline` -> Promise */
const _inflight = new Map();

/** 当前已发布的 20 日涨幅（仅当 date 匹配时有效，否则 null —— 切日期那帧必须视为「没有数据」） */
export function getRange20Pct(date) {
  const s = _state.value;
  if (!date || s.date !== date) return null;
  return s.map;
}

/** 增量渲染指纹令牌（异步到货必须让行缓存整体失效，否则数值/顺序陈旧） */
export function getRange20FingerprintToken() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + s.map.size;
}

/** 清空会话缓存（仅供测试 / 换数据源时调用） */
export function clearRange20() {
  _sig.clear();
  _klineTried.clear();
  _inflight.clear();
  _stage.clear();
  _cache.clear();
  _state.value = { date: '', map: new Map(), version: _state.value.version + 1 };
}

/**
 * 窗口日期：升序 [T-19 ... T]。
 * 复用 dragon-rank 的交易日回溯实现（§6 单一真相，⛔ 不在这里另写一份日历循环）。
 * @param {string} date 展示日 T
 * @param {number} [days] 槽位数（App 日历口径），缺省 = RANGE20_WINDOW_DAYS
 * @returns {string[]} 升序日期数组（日历不足时长度 < days）
 */
export function getRange20WindowDates(date, days) {
  const n = (days === null || days === undefined) ? RANGE20_WINDOW_DAYS : Number(days);
  const len = (isFinite(n) && n >= 1) ? Math.floor(n) : RANGE20_WINDOW_DAYS;
  return getDragonWindowDates(date, len).slice().reverse();
}

/**
 * 【纯函数】从「已合并的真实腿」里挑出【真实存在的交易日】，取最后 N 个作为最终窗口。
 *
 * ★ [RANGE20 2026-10-19] 为什么必须有这一步：App 日历可能把工作日假期当交易日
 *   （云端 holidays 为空数组时就是如此，见 RANGE20_PROBE_DAYS 的说明）。判据 = 「这一天
 *   有任何一只票拿到涨幅腿」⇒ 上游有成交 ⇒ 是真交易日。全市场 41 只票都拿不到的日期，
 *   只可能是非交易日（或全市场停牌，那也不该算进窗口）。
 * ⚠️ 窗口对【所有票全局一致】——⛔ 绝不按「每只票自己的腿数」各自取窗口，否则各票区间
 *   长度不同、涨幅不可比（stock-range-pct.js 头部同一个坑）。
 *
 * @param {Map<string, Map<string, number>>} legsByStock 股票名 -> (日期 -> 日涨幅%)
 * @param {string[]} probeDates 升序候选日期（App 日历口径）
 * @param {number} n 需要的交易日个数（= RANGE20_WINDOW_DAYS）
 * @returns {string[]} 升序的真实交易日（长度 <= n；真实交易日不足时就是全部）
 */
export function pickRealWindowDates(legsByStock, probeDates, n) {
  const want = (n === null || n === undefined) ? RANGE20_WINDOW_DAYS : Number(n);
  const keepN = (isFinite(want) && want >= 1) ? Math.floor(want) : RANGE20_WINDOW_DAYS;
  if (!probeDates || probeDates.length === 0) return [];
  const inProbe = new Set(probeDates);
  const hit = new Set();
  if (legsByStock) {
    legsByStock.forEach(function(legs) {
      if (!legs) return;
      legs.forEach(function(v, d) {
        if (inProbe.has(d) && v !== null && v !== undefined) hit.add(d);
      });
    });
  }
  // 保持 probeDates 的升序（⛔ 不依赖 Map 遍历顺序）
  const real = probeDates.filter(function(d) { return hit.has(d); });
  return real.slice(-keepN);
}

/** 取某个字段的数值（多键兼容；缺失/非法 → null，⛔ 不返回 0） */
function _numOf(row, keys) {
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
 * 收盘涨幅（历史日腿的唯一口径）。
 * @param {object} row 当日行
 * @returns {number|null}
 */
export function closeLegOf(row) {
  return _numOf(row, CLOSE_KEYS);
}

/**
 * T 腿口径（★ 本模块与十日涨幅的唯一实质差异，⚠️ 刻意如此，别"顺手统一"）：
 *   · 展示日 === 本地今天 → **竞价涨幅优先**（缺失才退回收盘涨幅）；
 *   · 展示日 是历史日   → 收盘涨幅优先（缺失才退回竞价涨幅）。
 * 为什么不像 resolveTDayPct 那样在 15:00 后切成收盘：用户口径
 * 「最新的时间点算到当天的竞价涨幅……等收盘没我什么事了，什么都买不了」——
 * 这个数是早上做参考用的，收盘后再跳一次会让人对不上 9:26 看到的名次。
 * @param {object} row 展示日当天的行
 * @param {boolean} tIsToday 展示日是否就是本地今天
 * @returns {number|null}
 */
export function resolveT20Leg(row, tIsToday) {
  const close = _numOf(row, CLOSE_KEYS);
  const auc = _numOf(row, AUC_KEYS);
  if (tIsToday) return auc !== null ? auc : close;
  return close !== null ? close : auc;
}

/**
 * 【纯函数】从「逐日行」抽每只票的日涨幅腿。
 *
 * @param {Array<{stock:string}>} targets 目标股票（按名去重，先到先得）
 * @param {string[]} ascDates 升序交易日（最后一个 = 展示日 T）
 * @param {Map<string, Map<string, object>>} rowsByDate 日期 -> (股票名 -> 当日行)
 * @param {{tIsToday?:boolean}} [opts] tIsToday：展示日是否为本地今天（决定 T 腿口径）
 * @returns {Map<string, Map<string, number>>} 股票名 -> (日期 -> 日涨幅%)
 *
 * §10：某天没有该票的行 / 该行没有可用涨幅 → 这根腿【不放进去】（days 会少 1），
 *      绝不补 0 —— 见文件头「停牌怎么算」。
 */
export function legs20FromRows(targets, ascDates, rowsByDate, opts) {
  const out = new Map();
  if (!targets || targets.length === 0 || !ascDates || ascDates.length === 0) return out;
  const tDate = ascDates[ascDates.length - 1];
  const tIsToday = !!(opts && opts.tIsToday);
  const seen = new Set();
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const name = t && t.stock ? String(t.stock).trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const legs = new Map();
    for (let k = 0; k < ascDates.length; k++) {
      const d = ascDates[k];
      const dayMap = rowsByDate ? rowsByDate.get(d) : null;
      const row = dayMap ? dayMap.get(name) : null;
      if (!row) continue;
      const v = (d === tDate) ? resolveT20Leg(row, tIsToday) : closeLegOf(row);
      if (v !== null) legs.set(d, v);
    }
    if (legs.size > 0) out.set(name, legs);
  }
  return out;
}

/**
 * 【纯函数】把「同花顺补算腿」合并进库内腿：**只补缺，绝不覆盖**（库内数据更权威、口径更近）。
 * @param {Map<string, Map<string, number>>} baseLegs 库内腿
 * @param {Map<string, Map<string, number>>|null} extraByStock 补算腿（股票名 -> (YYYYMMDD -> 日涨幅%)）
 * @param {string[]} ascDates 升序交易日（'YYYY-MM-DD'）
 * @returns {Map<string, Map<string, number>>} 新 Map（不修改入参）
 */
export function merge20Legs(baseLegs, extraByStock, ascDates) {
  const out = new Map();
  if (baseLegs) baseLegs.forEach(function(legs, name) { out.set(name, new Map(legs)); });
  if (!extraByStock || !ascDates) return out;
  extraByStock.forEach(function(dayMap, name) {
    if (!name || !dayMap) return;
    let legs = out.get(name);
    if (!legs) { legs = new Map(); out.set(name, legs); }
    for (let i = 0; i < ascDates.length; i++) {
      const d = ascDates[i];
      if (legs.has(d)) continue;                       // 已有（库内）→ 不覆盖
      const v = parsePct(dayMap.get(d.replace(/-/g, '')));
      if (v !== null) legs.set(d, v);
    }
  });
  return out;
}

/**
 * 【纯函数】复利累乘 → 每只票的 20 日涨幅。
 *
 * @param {Map<string, Map<string, number>>} legsByStock 股票名 -> (日期 -> 日涨幅%)
 * @param {string[]} ascDates 升序交易日（只统计窗口内的腿）
 * @returns {Array<{stock:string, pct:number, days:number}>}
 *
 * `days` = 实际参与累乘的天数（停牌/缺数据会 < 20）；`pct` 一根腿都没有 → 该票不出现在结果里
 * （调用方据此让行「没有数值」而不是「涨幅 0」）。
 */
export function compound20(legsByStock, ascDates) {
  const rows = [];
  if (!legsByStock || !ascDates) return rows;
  const want = new Set(ascDates);
  legsByStock.forEach(function(legs, name) {
    if (!legs || legs.size === 0) return;
    const list = [];
    legs.forEach(function(v, d) {
      if (want.has(d)) list.push(v);
    });
    if (list.length === 0) return;
    const pct = compoundPct(list);
    if (pct === null || !isFinite(pct)) return;
    rows.push({ stock: name, pct: pct, days: list.length });
  });
  return rows;
}

/** 内容签名（防止内容没变却重复发布 ⇒ 行缓存整表刷新） */
function _sigOf(rows) {
  if (!rows || rows.length === 0) return '0';
  const parts = rows.map(function(r) { return r.stock + ':' + r.pct.toFixed(4) + ':' + r.days; });
  parts.sort();
  return rows.length + '|' + parts.join(',');
}

/** 发布（内容签名相同 ⇒ 不发布、不 bump version） */
function _publish(date, rows) {
  const sig = _sigOf(rows);
  if (_sig.get(date) === sig && _state.value.date === date) return _state.value.map;
  const map = new Map();
  (rows || []).forEach(function(r) { map.set(r.stock, { pct: r.pct, days: r.days }); });
  _sig.set(date, sig);
  _cache.set(date, (rows || []).slice());
  _state.value = { date: date, map: map, version: _state.value.version + 1 };
  return map;
}

/** 已发布行集的总天数（质量指标：阶段① 只在「比现有更好」时才发布，⛔ 不许把好数据打回差的） */
function _sumRowDays(rows) {
  let s = 0;
  (rows || []).forEach(function(r) { s += (r && r.days) || 0; });
  return s;
}
/** 同上，但入参是已发布的 Map<股票,{pct,days}> */
function _sumMapDays(map) {
  let s = 0;
  if (map) map.forEach(function(v) { s += (v && v.days) || 0; });
  return s;
}

/** 日期闸门（与 dragon-rank#ensureDragonRangePct 同口径）：未来日 / 非交易日 ⇒ 不产出数据 */
function _notTradable(date) {
  const today = _getLocalTodayStr();
  if (today && date > today) return true;
  try {
    return !isTradingDay(date);
  } catch (e) {
    // 交易日历读不到 → 不因它断功能（宁可多算也不静默失效）
    _dbgLog('[RANGE20] 交易日历读取失败（放行）: ' + (e && e.message || e));
    return false;
  }
}

/** 把窗口内的逐日行建索引（日期 -> 股票名 -> 行）；同名同日只取第一行 */
function _rowsByDateOf(ascDates) {
  const out = new Map();
  let data;
  try {
    data = getAuctionData() || {};
  } catch (e) {
    _dbgLog('[RANGE20] 内存逐日数据读取失败: ' + (e && e.message || e));
    data = {};
  }
  for (let i = 0; i < ascDates.length; i++) {
    const d = ascDates[i];
    const m = new Map();
    const list = data[d] || [];
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      if (!r || !r.stock) continue;
      const n = String(r.stock).trim();
      if (n && !m.has(n)) m.set(n, r);
    }
    out.set(d, m);
  }
  return out;
}

/** 目标清单归一（去重 + 补代码） */
function _targetsOf(rows) {
  const out = [];
  const seen = new Set();
  (rows || []).forEach(function(r) {
    const name = r && r.stock ? String(r.stock).trim() : '';
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ stock: name, code: (r && r.code) ? String(r.code).trim() : '' });
  });
  return out;
}

/** 代码兜底：内存行 → scMap（与 dragon-rank 同源，§6 不另造一套代码解析） */
function _fillCodes(targets) {
  const scMap = (state && state._scMapCache) || {};
  targets.forEach(function(t) {
    if (!t.code && scMap[t.stock]) t.code = String(scMap[t.stock]).trim();
  });
}

/**
 * 确保某日的 20 日涨幅已就绪（幂等 / 单飞 / 会话缓存）。
 *
 * @param {string} date 展示日 T
 * @param {Array<{stock:string, code?:string}>} rows 看板当前渲染的行（目标清单的唯一来源）
 * @param {{onProgress?:(done:number,total:number)=>void, skipKline?:boolean}} [opts]
 *        skipKline：只跑阶段①（库内数据）—— 供单测/诊断用
 * @returns {Promise<Map<string,{pct:number,days:number}>>|null}
 */
export async function ensureRange20(date, rows, opts) {
  if (!date) return null;
  if (_notTradable(date)) {
    if (_state.value.date === date && _state.value.map.size === 0) return _state.value.map;
    _sig.delete(date);
    _publish(date, []);
    return _state.value.map;
  }
  const targets = _targetsOf(rows);
  if (targets.length === 0) return (_state.value.date === date) ? _state.value.map : null;

  // ---- 阶段①：库内数据（0 请求 / 0 额度），先发布出来 ----
  // ★ 取数用【探针窗口】= 30 个 App 日历交易日（比 20 多 10 个槽位）：App 日历可能把工作日
  //   假期当交易日（云端 holidays 为空数组时就是如此，见 RANGE20_PROBE_DAYS），多要 10 个槽位
  //   才能在阶段②用「真实有成交的日期」重建出完整 20 个交易日。
  const probeDates = getRange20WindowDates(date, RANGE20_PROBE_DAYS);
  const tIsToday = (date === _getLocalTodayStr());
  const rowsByDate = _rowsByDateOf(probeDates);
  const baseLegs = legs20FromRows(targets, probeDates, rowsByDate, { tIsToday: tIsToday });
  // 阶段①只能按 App 日历取最后 20 槽（此时没有 K 线去识别假交易日）⇒ 可能 days < 20，
  // 行悬停会如实写「n/20日」，阶段② 到货后自动修正（不是"猜"，是"先给能给的"）。
  const guessDates = probeDates.slice(-RANGE20_WINDOW_DAYS);
  // 🔴 阶段① 覆盖保护（见 _stage 的说明）：已合并过 K 线的日期，⛔ 绝不再被「只有库内腿」的结果覆盖。
  //   未合并过时也只在「总天数确实变多」时发布（行数从 6 → 41 时库内腿会变多，需要刷新）。
  if (_stage.get(date) === 2) {
    // 已合并过 K 线 ⇒ 用缓存里的那份结果复原（切日期回来时 `_state` 已被别的日期占着）
    if (_cache.has(date)) _publish(date, _cache.get(date));
  } else {
    const stage1Rows = compound20(baseLegs, guessDates);
    const curMap = (_state.value.date === date) ? _state.value.map : null;
    if (!curMap || _sumRowDays(stage1Rows) > _sumMapDays(curMap)) {
      _publish(date, stage1Rows);
    }
  }
  if (opts && opts.skipKline) return _state.value.map;

  // ---- 阶段②：同花顺 K 线补缺（免费额度；只跑腿不够的票）----
  const need = targets.filter(function(t) {
    const legs = baseLegs.get(t.stock);
    return !legs || legs.size < probeDates.length;
  });
  if (need.length === 0) return _state.value.map;
  const tried = _klineTried.get(date) || new Set();
  const todo = need.filter(function(t) { return !tried.has(t.stock); });
  if (todo.length === 0) return _state.value.map;

  const key = date + '|kline';
  const fly = _inflight.get(key);
  if (fly) return fly;

  const p = (async function() {
    _fillCodes(todo);
    if (todo.some(function(t) { return !t.code; })) {
      try {
        await ensureAuctionCodeMapping(todo);
      } catch (e) {
        _dbgLog('[RANGE20] 补码失败: ' + (e && e.message || e));
      }
      _fillCodes(todo);
    }
    const list = todo.filter(function(t) { return !!t.code; });
    if (list.length === 0) {
      _dbgLog('[RANGE20] 无可用代码，跳过同花顺补算（' + date + '）');
      return _state.value.map;
    }
    // 先登记再请求：同一会话同一票只跑一次（失败也不反复烧请求，§32/§36）
    list.forEach(function(t) { tried.add(t.stock); });
    _klineTried.set(date, tried);

    const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
    const extra = await fetchFuyaoDailyPctRange(
      list.map(function(t) { return { stock: t.stock, code: t.code }; }),
      probeDates,
      // retryShortWindow：上游偶发只回「最近 12 根」，窗口会被误判成次新股 ⇒ 强迫它重试，
      //   否则本 toggle 永远只有 12/20 天、各票天数不齐 ⇒ 区间涨幅不可比（见 stock-range-pct.js）。
      // requestTimeoutMs：上游偶发「不返回也不断开」⇒ 批量 Promise.all 永久挂住、整批发布不出来；
      //   15s 超时后按失败重试，最多浪费一次尝试，不会让整块看板卡死。
      // minCoverage：探针窗口里有非交易日（App 日历把工作日假期当交易日）⇒ 谁也凑不满 30 根，
      //   不设门槛会让每只票都跑满 3 次重试（实测 41 只 = 203 个请求）。凑够 20 根即完成。
      { concurrency: 3, retryShortWindow: true, requestTimeoutMs: 15000, minCoverage: RANGE20_WINDOW_DAYS, onProgress: onProgress }
    );
    const merged = merge20Legs(baseLegs, extra, probeDates);
    // ★ 用【真实交易日】重建最终窗口（剔除 App 日历里的工作日假期），全市场共用同一份窗口
    //   ⇒ 每只票的区间长度一致、涨幅可比；拿不到 20 个真实交易日时就有多少算多少（days 如实写）。
    const realDates = pickRealWindowDates(merged, probeDates, RANGE20_WINDOW_DAYS);
    _dbgLog('[RANGE20-PUB] ' + date + ' 补缺完成 extra=' + extra.size + ' merged=' + merged.size
      + ' real=' + realDates.length + '/' + RANGE20_WINDOW_DAYS);
    if (realDates.length < RANGE20_WINDOW_DAYS) {
      _dbgLog('[RANGE20] ' + date + ' 真实交易日只凑到 ' + realDates.length + '/' + RANGE20_WINDOW_DAYS
        + '（探针 ' + probeDates.length + ' 槽；云端 holidays 可能为空导致假期被当交易日）');
    }
    _publish(date, compound20(merged, realDates));
    _stage.set(date, 2);            // 🔴 标记「该日已合并 K 线」⇒ 后续阶段① 不再覆盖（见 _stage 说明）
    return _state.value.map;
  })().finally(function() {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}
