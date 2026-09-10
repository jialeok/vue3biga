// dragon-rank.js — 题材「龙头股」判定（Logic 层，§15 独立业务模块）
//
// 产品口径：
//   - 龙头只在【同一个题材组】内部比较（即界面上同颜色块，题材成员 >= 2 且为真实题材）；
//   - 比较依据 = 该股「近 10 个交易日区间涨幅」：窗口 [T-9, T]，含当天共 10 个交易日；
//   - 当天早盘取【竞价涨幅】占位，收盘后由【收盘涨幅】覆盖并重新计算；
//   - 组内按区间涨幅降序：最高 = 龙一，次高 = 龙二，依次类推。
//
// 数据链路（省猫抓额度，接口每天只有 10 次）：
//   猫抓 daily(symbols, startdate, enddate)  ← 【一次请求】覆盖全部股票 × 10 个交易日
//     ↓ 复利累乘算区间涨幅
//   Supabase stock_range_pct(date, stock)  ← 云端缓存，跨设备/跨会话复用
//     ↓
//   模块级 ref（ref-driven async loader，与 weakStrongSetRef 同范式）
//     ↓
//   view-helpers 同步读取 → item.dragonRank / item.dragonPct → 行内徽章
//
// 额度保护（关键）：
//   1) 云端有当天缓存且未过期 → 0 次请求；
//   2) 当天 15:00（北京）后缓存过期 → 当天最多再补 1 次（收盘涨幅覆盖重算）；
//   3) 单飞（inflight）保证并发调用只发一次请求；
//   4) 后台「龙头涨幅」按钮可 force 刷新（用户主动，不计入自动额度）。

import { ref } from 'vue';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { state } from '../app-state.js';
import { getAuctionData } from '../app-core-api.js';
import { _getAuctionFormalRowsForDate } from '../../data/watchlist-and-metrics.js';
// [FIX 2026-09-09] 10 日涨幅目标名单必须覆盖「观察组继承票」，否则带 * 的票永远没有 10 日涨幅：
// 观察组（打标签继承 / 前一日竞昨高光）只在视图层注入，既不在 _auctionMemCache 也不在 auction_watchlist。
import { getJingYestHighlightSetForDate } from './sort-rules.js';
import { getCarryOverNamesForDate } from './tag-carryover.js';
import { loadCloudStockCodeMap } from '../../data/stock-code-map.js';
import {
  readRangePctForDate,
  upsertRangePctRows,
  fetchNumcatDailyPctRange,
  fetchFuyaoDailyPctRange
} from '../../data/stock-range-pct.js';
import { _dbgLog } from '../../data/debug-log.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';

export const DRAGON_RANGE_DAYS = 10;
// 北京时间 15:00 之后，当天收盘涨幅已可覆盖早盘竞价涨幅 → 缓存视为过期需重算一次
const CLOSE_COVER_HOUR = 15;
// 同花顺兜底每会话每个日期最多走一次：猫抓额度用尽时避免每次渲染都发几十个请求
const _fuyaoFallbackDates = new Set();
// [FIX 2026-09-10] 缺口补齐按【股票名】标记（date|name）：名单是逐步到达的，按日期一次性标记
// 会让后到的票永远补不上。每只票每会话最多尝试一次；force 刷新（后台按钮）会清空重新补。
const _patchedNames = new Set();

// ===== 状态（模块级 ref，§7：不进 Pinia，遵循 weakStrongSetRef 同款 ref-driven 范式）=====
const dragonState = ref({ date: '', map: new Map(), version: 0 });
let _inflight = null; // { date, promise } 单飞保护

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
  if (dragonState.value.date === '' && dragonState.value.map.size === 0) return;
  dragonState.value = { date: '', map: new Map(), version: dragonState.value.version + 1 };
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

function _beijingHour() {
  return (new Date().getUTCHours() + 8) % 24;
}

/** 北京 15:00 对应的 UTC 时间戳（用于判断缓存是否早于收盘覆盖） */
function _closeCoverUtcMs(dateStr) {
  return Date.parse(dateStr + 'T07:00:00Z');
}

/** 复利累乘：日涨幅数组 → 区间涨幅(%) */
function _compoundPct(pctList) {
  if (!pctList || pctList.length === 0) return null;
  let acc = 1;
  for (const p of pctList) acc *= (1 + p / 100);
  return (acc - 1) * 100;
}

function _parsePct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isFinite(n) ? n : null;
}

/**
 * 异步加载某日的「10 日区间涨幅」（编排层：云端缓存 → 判定过期 → 猫抓一次 → 回写云端）。
 * @param {string} date - 当前看板日期 T
 * @param {{force?:boolean}} [opts] - force=true 忽略缓存强制拉一次（后台按钮）
 * @returns {Promise<Map<string, {pct:number|null, days:number}>|null>}
 */
export async function ensureDragonRangePct(date, opts) {
  const force = !!(opts && opts.force);
  if (!date) return null;
  const cur = dragonState.value;
  if (!force && cur.date === date && cur.map && cur.map.size > 0) {
    // [FIX 2026-09-10] 已加载过也要再补一次缺口：名单是逐步到达的（worker 写入 / 切日期后数据落地 /
    // 用户刷新），第一次计算时没在名单里的票会永远缺 10 日涨幅。这里只补「还没算出来的」，
    // 按股票名去重，不重复消耗额度。
    await _patchMissingRangePct(date, cur.map);
    return _currentMapOr(date, cur.map);
  }
  // 非强制：复用同一次进行中的请求（单飞，杜绝并发重复消耗额度）。
  // 强制（后台按钮）：用户显式要求重算，另起一次并接管 inflight（按钮本身有 backendLoading 防连点）。
  if (_inflight && _inflight.date === date && !force) return _inflight.promise;
  const p = _loadDragonRangePct(date, force);
  _inflight = { date: date, promise: p };
  try {
    return await p;
  } finally {
    if (_inflight && _inflight.promise === p) _inflight = null;
  }
}

async function _loadDragonRangePct(date, force) {
  // force（后台按钮）：清掉本会话的「已兜底 / 已补齐」标记，允许再补一次
  if (force) {
    _fuyaoFallbackDates.delete(date);
    _patchedNames.forEach(function(k) { if (k.indexOf(date + '|') === 0) _patchedNames.delete(k); });
  }
  // 1) 云端缓存（读取失败必须抛错，由调用方提示；不静默当空数据）
  let cloud = new Map();
  try {
    cloud = await readRangePctForDate(date);
  } catch (e) {
    _dbgLog('[DRAGON] 读取 stock_range_pct 失败: ' + (e && e.message || e));
    throw new Error('读取龙头涨幅缓存失败（表 stock_range_pct 是否已创建？执行 db/create_stock_range_pct.sql）：' + (e && e.message || e));
  }

  // 2) 过期判定：仅「系统今天 + 已过 15:00 + 缓存早于 15:00」才需要重算
  const sysToday = _getLocalTodayStr();
  let stale = false;
  if (date === sysToday && _beijingHour() >= CLOSE_COVER_HOUR) {
    const closeMs = _closeCoverUtcMs(date);
    let hasOld = false;
    cloud.forEach((v) => {
      const t = v && v.updatedAt ? Date.parse(v.updatedAt) : NaN;
      if (!t || t < closeMs) hasOld = true;
    });
    stale = hasOld || cloud.size === 0;
  }

  if (!force && cloud.size > 0 && !stale) {
    const map = new Map();
    cloud.forEach((v, k) => map.set(k, { pct: v.pct, days: v.days }));
    dragonState.value = { date: date, map: map, version: dragonState.value.version + 1 };
    // [FIX 2026-09-10] 云端缓存是【日期级】复用的：只要该日有任意一行就直接命中，
    // 于是历史上漏算的股票（当时缺代码 / 名单口径不含观察组）会被永久冻结成"没有 10 日涨幅"。
    // 这里做一次「缺谁补谁」的增量补齐（只走同花顺，不消耗猫抓额度）。
    await _patchMissingRangePct(date, map);
    return _currentMapOr(date, map);
  }

  // 3) 拉接口（一次请求覆盖全部股票 × 10 个交易日）
  const computed = await _fetchAndCompute(date);
  const map = new Map();
  computed.rows.forEach(r => map.set(r.stock, { pct: r.pct, days: r.days }));
  dragonState.value = { date: date, map: map, version: dragonState.value.version + 1 };
  // 主通道/兜底都可能漏掉个别票（猫抓该票无数据、代码刚补上等），同样做一次缺口补齐
  await _patchMissingRangePct(date, map);
  const _m = _currentMapOr(date, map);

  // 4) 回写云端（失败只提示，不阻断本次展示：内存已可用）
  _m.forEach(function(v, k) {
    if (computed.rows.some(function(r) { return r.stock === k; })) return;
    computed.rows.push({ stock: k, pct: v && v.pct !== undefined ? v.pct : null, days: v ? v.days : 0 });
  });
  try {
    await upsertRangePctRows(date, computed.rows);
  } catch (e) {
    _dbgLog('[DRAGON] 写入 stock_range_pct 失败: ' + (e && e.message || e));
    throw new Error('龙头涨幅已算出但写云失败（下次会重新请求）：' + (e && e.message || e));
  }
  return _m;
}

/** 缺口补齐可能已经把 ref 换成了新 Map，这里取「当前生效」的那一份（§6 单一真相） */
function _currentMapOr(date, fallback) {
  const s = dragonState.value;
  return (s.date === date && s.map) ? s.map : fallback;
}

/**
 * 【10 日涨幅目标名单 · 单一真相 / 2026-09-09】
 * 取值集合必须等于「看板当天真正会渲染出来的行」，否则必然出现
 * 「同一屏里有的股票有 10 日涨幅、有的没有」——用户反馈的带 * 票缺失就是这么来的：
 *   ① 当日正式成员行（_getAuctionFormalRowsForDate，已排除 market_metrics 影子行）；
 *   ② 观察组继承名：打标签继承（tag-carryover）+ 前一日竞昨高光（sort-rules）。
 *      这两类只在视图层注入 renderList，不在 _auctionMemCache / auction_watchlist，
 *      所以「昨天打过标签 / 前日高光、今天不在 9:25 名单」的票（界面带 *）过去永远算不到。
 * 行数据优先取内存当日【全量】行（含 market_metrics 影子行，带 auc_pct_chg / code）；
 * 取不到就只留股票名（代码由 ensureAuctionCodeMapping / scMap 兜底）。
 * @param {string} date
 * @returns {object[]} 参与 10 日涨幅计算的行
 */
function _resolveTargetRows(date) {
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

/**
 * 【缺口补齐 / 2026-09-10】云端缓存已存在但覆盖不全时的「缺谁补谁」。
 * 背景（用户实测）：stock_range_pct 的复用与过期判定都是【日期级】的——只要该日有任意一行
 * 且未过期就直接命中，于是某次计算漏掉的股票会被永久冻结成"没有 10 日涨幅"。
 * 真实成因有两种，都会造成「同一屏里有的票有、有的没有」：
 *   ① 计算时名单还没加载全（9/10 实测：metrics 60 行，缓存只有 11 行）；
 *   ② 该票当时缺股票代码（stockcodemap 无记录）→ 拿不到 K 线被跳过。
 * 这里只对【缺失 / pct 为 null】的目标股票用同花顺重算（不消耗猫抓额度），
 * 算完 upsert 回云端并并入内存 Map，跨设备同样生效。
 *
 * ⚠️ 标记粒度是【股票名】而不是【日期】：名单是逐步到达的（worker 9:25 写入、用户刷新、
 * 切换日期后数据落地），若按日期一次性标记，名单后来变长的部分就再也补不上了。
 * 每只票整个会话最多尝试一次，新出现的票仍有机会。
 * @param {string} date
 * @param {Map<string,{pct:number|null,days:number}>} map - 会被就地补全
 */
async function _patchMissingRangePct(date, map) {
  if (!date || !map) return;
  const rows = _resolveTargetRows(date);
  if (rows.length === 0) return; // 当日数据还没加载完 → 本次不标记，下次还有机会

  let scMap = state._scMapCache || {};
  const _codeOf = function(r, name) { return String(r.code || scMap[name] || '').trim(); };
  const missing = [];
  rows.forEach(function(r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    if (_patchedNames.has(date + '|' + name)) return;
    const cur = map.get(name);
    if (cur && cur.pct !== null && cur.pct !== undefined && !isNaN(cur.pct)) return;
    const code = _codeOf(r, name);
    if (!code) return; // 先记为待补码，下面统一补一次再判定
    missing.push({ row: r, name: name, code: code });
  });
  if (missing.length === 0) {
    // 全缺代码 → 尝试自动补码后重来一次（补不到就保持"无数据"，绝不伪造）
    try {
      const cm = await ensureAuctionCodeMapping(rows);
      if (cm && cm.filled > 0) scMap = state._scMapCache || scMap;
    } catch (e) {
      _dbgLog('[DRAGON] 补齐前自动补码失败: ' + (e && e.message || e));
    }
    rows.forEach(function(r) {
      if (!r || !r.stock) return;
      const name = String(r.stock).trim();
      if (!name || _patchedNames.has(date + '|' + name)) return;
      const cur = map.get(name);
      if (cur && cur.pct !== null && cur.pct !== undefined && !isNaN(cur.pct)) return;
      const code = _codeOf(r, name);
      if (code) missing.push({ row: r, name: name, code: code });
    });
  }
  missing.forEach(function(x) { _patchedNames.add(date + '|' + x.name); });
  if (missing.length === 0) return;

  const dates = getDragonWindowDates(date);
  const ascDates = dates.slice().reverse();
  const afterClose = _beijingHour() >= CLOSE_COVER_HOUR;
  let byName = null;
  try {
    byName = await fetchFuyaoDailyPctRange(
      missing.map(function(x) { return { stock: x.name, code: x.code }; }),
      dates
    );
  } catch (e) {
    _dbgLog('[DRAGON] 缺口补齐同花顺请求失败: ' + (e && e.message || e));
    return;
  }
  if (!byName || byName.size === 0) return;

  const out = [];
  missing.forEach(function(x) {
    const dayMap = byName.get(x.name);
    if (!dayMap) return;
    const list = [];
    ascDates.forEach(function(d) {
      const ymd = d.replace(/-/g, '');
      let v = dayMap.has(ymd) ? dayMap.get(ymd) : null;
      if (d === date) {
        // 与主计算同口径：收盘后用收盘涨幅覆盖，盘中/历史日用竞价涨幅占位
        if (afterClose) {
          if (v === null) v = _parsePct(x.row.changePct || x.row.change_pct || '');
          if (v === null) v = _parsePct(x.row.auc_pct_chg || x.row.aucPctChg || '');
        } else {
          v = _parsePct(x.row.auc_pct_chg || x.row.aucPctChg || '');
        }
      }
      if (v !== null) list.push(v);
    });
    const pct = _compoundPct(list);
    if (pct === null) return;
    out.push({ stock: x.name, pct: pct, days: list.length });
    map.set(x.name, { pct: pct, days: list.length });
  });
  if (out.length === 0) return;
  _dbgLog('[DRAGON] 缺口补齐 ' + out.length + '/' + missing.length + ' 只：' + out.map(function(r) { return r.stock; }).join('、'));
  try {
    await upsertRangePctRows(date, out);
  } catch (e) {
    _dbgLog('[DRAGON] 缺口补齐写云失败: ' + (e && e.message || e));
  }
  // 补进内存 Map 后必须让 ref 换新引用 + 版本号自增，否则展开面板/徽章读到的仍是旧快照（§17）
  const next = new Map(map);
  dragonState.value = { date: date, map: next, version: dragonState.value.version + 1 };
}

async function _fetchAndCompute(date) {
  const dates = getDragonWindowDates(date);
  const rows = _resolveTargetRows(date);
  if (rows.length === 0) return { rows: [], requested: 0, dates: dates };

  let scMap = state._scMapCache || {};
  if (Object.keys(scMap).length === 0) {
    try {
      await loadCloudStockCodeMap();
      scMap = state._scMapCache || {};
    } catch (e) {
      _dbgLog('[DRAGON] 代码映射加载失败: ' + (e && e.message || e));
    }
  }
  // [FIX 2026-09-09] 缺代码的票永远算不出涨幅（9/9 万向德农即此因），先自动补一次
  try {
    const cm = await ensureAuctionCodeMapping(rows);
    if (cm.filled > 0) scMap = state._scMapCache || scMap;
  } catch (e) {
    _dbgLog('[DRAGON] 自动补码失败: ' + (e && e.message || e));
  }

  const codeOf = {};
  const codeSet = new Set();
  rows.forEach(function(r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    const code = String(r.code || scMap[name] || '').trim();
    if (!code) return;
    codeOf[name] = code;
    codeSet.add(code);
  });
  if (codeSet.size === 0) return { rows: [], requested: 0, dates: dates };

  const startYmd = dates[dates.length - 1].replace(/-/g, '');
  const endYmd = dates[0].replace(/-/g, '');

  // 主通道：猫抓 daily（1 次请求覆盖全部股票 × 10 日）
  let byCode = null;
  try {
    byCode = await fetchNumcatDailyPctRange(Array.from(codeSet).join(','), startYmd, endYmd);
  } catch (e) {
    _dbgLog('[DRAGON] 猫抓 daily 不可用: ' + (e && e.message || e));
  }
  // 兜底通道：猫抓额度用尽 / 返回空 → 用同花顺收盘价自算日涨幅（不消耗猫抓额度）
  let byName = null;
  if ((!byCode || byCode.size === 0) && !_fuyaoFallbackDates.has(date)) {
    _fuyaoFallbackDates.add(date);
    _dbgLog('[DRAGON] 启用同花顺兜底计算 10 日涨幅（' + Object.keys(codeOf).length + ' 只）');
    try {
      byName = await fetchFuyaoDailyPctRange(
        Object.keys(codeOf).map(function(n) { return { stock: n, code: codeOf[n] }; }),
        dates
      );
      _dbgLog('[DRAGON] 同花顺兜底取到 ' + byName.size + ' 只');
    } catch (e) {
      _dbgLog('[DRAGON] 同花顺兜底失败: ' + (e && e.message || e));
    }
  }

  // 当天(T)涨幅口径（§用户口径）：
  //   - 15:00 前（盘中）：daily 的 T 值是「盘中实时涨幅」，不是竞价涨幅 → 必须用本地【竞价涨幅】占位；
  //   - 15:00 后（收盘）：daily 的 T 值已是【收盘涨幅】→ 用它覆盖，取不到再退回本地竞价涨幅/收盘涨幅。
  // 其余历史日一律用 daily 的日涨幅。
  const afterClose = _beijingHour() >= CLOSE_COVER_HOUR;
  const out = [];
  const ascDates = dates.slice().reverse(); // 升序 T-9 → T
  rows.forEach(function(r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    const code = codeOf[name];
    if (!code) return;
    const dayMap = byName ? byName.get(name) : (byCode ? byCode.get(code) : null);
    const list = [];
    ascDates.forEach(function(d) {
      const ymd = d.replace(/-/g, '');
      let v = dayMap && dayMap.has(ymd) ? dayMap.get(ymd) : null;
      if (d === date) {
        if (afterClose) {
          if (v === null) v = _parsePct(r.changePct || r.change_pct || '');
          if (v === null) v = _parsePct(r.auc_pct_chg || r.aucPctChg || '');
        } else {
          v = _parsePct(r.auc_pct_chg || r.aucPctChg || '');
        }
      }
      if (v !== null) list.push(v);
    });
    out.push({ stock: name, pct: _compoundPct(list), days: list.length });
  });
  return { rows: out, requested: codeSet.size, dates: dates };
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
