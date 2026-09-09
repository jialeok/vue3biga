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
import { _getAuctionFormalRowsForDate } from '../../data/watchlist-and-metrics.js';
import { loadCloudStockCodeMap } from '../../data/stock-code-map.js';
import {
  readRangePctForDate,
  upsertRangePctRows,
  fetchNumcatDailyPctRange
} from '../../data/stock-range-pct.js';
import { _dbgLog } from '../../data/debug-log.js';

export const DRAGON_RANGE_DAYS = 10;
// 北京时间 15:00 之后，当天收盘涨幅已可覆盖早盘竞价涨幅 → 缓存视为过期需重算一次
const CLOSE_COVER_HOUR = 15;

// ===== 状态（模块级 ref，§7：不进 Pinia，遵循 weakStrongSetRef 同款 ref-driven 范式）=====
const dragonState = ref({ date: '', map: new Map(), version: 0 });
let _inflight = null; // { date, promise } 单飞保护

/** 当前已加载的区间涨幅（仅当 date 匹配时有效，否则返回 null）。同步读取，供 view-helpers 用。 */
export function getDragonRangePct(date) {
  const s = dragonState.value;
  if (!date || s.date !== date) return null;
  return s.map;
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
  if (!force && cur.date === date && cur.map && cur.map.size > 0) return cur.map;
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
    return map;
  }

  // 3) 拉接口（一次请求覆盖全部股票 × 10 个交易日）
  const computed = await _fetchAndCompute(date);
  const map = new Map();
  computed.rows.forEach(r => map.set(r.stock, { pct: r.pct, days: r.days }));
  dragonState.value = { date: date, map: map, version: dragonState.value.version + 1 };

  // 4) 回写云端（失败只提示，不阻断本次展示：内存已可用）
  try {
    await upsertRangePctRows(date, computed.rows);
  } catch (e) {
    _dbgLog('[DRAGON] 写入 stock_range_pct 失败: ' + (e && e.message || e));
    throw new Error('龙头涨幅已算出但写云失败（下次会重新请求）：' + (e && e.message || e));
  }
  return map;
}

async function _fetchAndCompute(date) {
  const dates = getDragonWindowDates(date);
  const rows = _getAuctionFormalRowsForDate(date) || [];
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
  const byCode = await fetchNumcatDailyPctRange(Array.from(codeSet).join(','), startYmd, endYmd);

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
    const dayMap = byCode.get(code);
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
