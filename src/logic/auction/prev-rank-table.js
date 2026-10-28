// prev-rank-table.js — 「昨日 20日涨幅名次表」的唯一装配处（Logic 层，§2 / §5 / §6）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-10-28，原话）：
//   「排名变化列那里，收盘是否重新算过一次，我希望重新算过一次，早上可以用竞价口径，
//     收盘时，用收盘口径，因为竞价时和收盘时会不同，不要搞混了，这样才能分辨出来。」
//   「我一般看竞价口径，收盘只是复盘用到。」
//
// ⇒ 名次变化这一列**必须跟着当前显示的那一列的口径走**，两种口径【各自配各自的昨天】：
//      · 竞价口径（9:26）：今天用 `range20-auction-leg.js` 反解出的竞价腿 ⇒ 昨天也必须用
//        【昨天 9:26 那一刻】的竞价腿名次（同一个读取器、同一次反解）；
//      · 收盘口径：今天用 `range20.js` 的收盘复利 ⇒ 昨天用 `stock_range20_pct` 里 leg='close' 的行。
//   ⛔ 绝不允许「今天竞价 vs 昨天收盘」—— 那两天的 T 腿不是同一把尺子，算出来的位移有一大半
//      是口径差，不是个股突破（用户要的恰恰是「分辨出来」）。
//
// ── 为什么竞价那一侧不在 Data 层做 ──────────────────────────────────────────────────────
//   竞价腿是从「收盘腿 + market_metrics 的 auc_pct_chg/change_pct」反解出来的
//   （`range20-auction-leg.js#_fetch` 内部完成），属于 Logic 层能力；
//   Data 层只交出原始行（`data/range20-prev-rank.js`）。
//   ⇒ 两条路径最后都汇到本文件的 `buildRankTable`（§6：名次口径只有一份实现）。
//
// ── 红线 ──────────────────────────────────────────────────────────────────────────────
//   §10：判不出就返回 null（任一来源读失败 / 该口径一行都没有），⛔ 绝不拿另一口径顶替，
//        ⛔ 也绝不用空表冒充「昨天谁都没名次」。
//   §19：版本号用 Vue `ref`（全局指纹在 `viewData` computed 里读它，裸 let 不建立依赖）。
//   §32：按 `date|leg` 会话缓存 + 单飞；同一口径同一天最多读一次。
//
// ⚠️ 与「收盘后自动重算」的分工：今天那一侧的换腿由 `range20.js#_scheduleCloseSwitch`
//   负责（15:00 后 +90s 重算并 bump version）；本模块只负责「跟着换口径的昨天」。
//   触发点在 `useAuctionBoard.js` 的 watch（依赖里带了 range20 的指纹令牌 + 竞价口径开关）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { ref } from 'vue';
import { readRange20PctRowsForDate } from '../../data/range20-prev-rank.js';
import { readAuctionLegRange20Pct } from './range20-auction-leg.js';
import { resolveT20LegMode, isAfterCloseOf } from './range20.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 名义上的两种腿（与 stock_range20_pct.leg 同名，⛔ 不新造词） */
export const PREV_LEG_CLOSE = 'close';
export const PREV_LEG_AUC = 'auc';

/** date|leg -> { ranks: Map<name, number>, pcts: Map<name, number>, count: number } | null */
const _cache = new Map();
/** date|leg -> Promise（单飞） */
const _inflight = new Map();
const CACHE_MAX = 24;

/**
 * 数据版本号（每次发布 +1）。
 * 🔴 必须是 Vue `ref`：全局指纹在 `viewData` computed 里读它，裸变量不建立依赖
 *   ⇒ 名次表到货后 computed 不重跑、整列永远 '—'（2026-10-28 实测踩过）。
 */
const _version = ref(0);

/** 当前版本（进 incremental-view 的全局指纹） */
export function getPrevRankFingerprintToken() {
  return String(_version.value);
}

/**
 * 【口径判定】名次变化这一列该跟哪个口径的昨天？
 *
 * = 「今天那一列实际用的口径」：
 *   · 竞价口径 toggle 打开 ⇒ 恒 'auc'（那一列显示的就是 9:26 反解值，任何日期都一样）；
 *   · 关闭 ⇒ 与 `range20.js` 的 T 腿口径【同一个函数】`resolveT20LegMode`：
 *       今天且未过 15:00 ⇒ 'auc'（早上看到的本来就是竞价腿）；
 *       已过 15:00 / 历史日 ⇒ 'close'（收盘后就是收盘口径）。
 *   ⛔ 两处必须同源（§6），否则会出现「今天这列是收盘复利、昨天按竞价反解比」的错配。
 *
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {boolean} byAuctionLeg 「竞价口径」toggle 是否打开
 * @returns {'auc'|'close'}
 */
export function resolvePrevRankLeg(date, byAuctionLeg) {
  const d = String(date || '').trim();
  if (byAuctionLeg) return PREV_LEG_AUC;
  if (!d) return PREV_LEG_CLOSE;
  const tIsToday = d === _getLocalTodayStr();
  return resolveT20LegMode(tIsToday, isAfterCloseOf(d)) === 'auc' ? PREV_LEG_AUC : PREV_LEG_CLOSE;
}

/** 数值解析：'%' / '+' 兼容；空 / 非法 ⇒ null（⛔ 不返回 0） */
function _num(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isNaN(n) ? null : n;
}

/**
 * 【纯函数】把一批 [{stock, pct}] 排成名次表（1 起；同值按股票名定序）。
 *
 * ⛔ 两种口径【共用】这一个实现：排序细节一旦分叉，「+6」就会变成口径差的产物。
 *
 * @param {Array<{stock:string, pct:number}>} list
 * @returns {{ranks: Map<string,number>, pcts: Map<string,number>, count: number}|null}
 *          count = 0 ⇒ null（判不出，⛔ 不返回空表）
 */
export function buildRankTable(list) {
  const clean = [];
  (list || []).forEach(function(it) {
    if (!it) return;
    const name = String(it.stock || it.name || '').trim();
    if (!name) return;
    const pct = _num(it.pct);
    if (pct === null) return;                 // §10 算不出的票不进榜
    clean.push({ stock: name, pct: pct });
  });
  if (clean.length === 0) return null;
  clean.sort(function(a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return String(a.stock).localeCompare(String(b.stock), 'zh');
  });
  const ranks = new Map();
  const pcts = new Map();
  clean.forEach(function(it, i) {
    ranks.set(it.stock, i + 1);
    pcts.set(it.stock, it.pct);
  });
  return { ranks: ranks, pcts: pcts, count: clean.length };
}

/**
 * 【纯函数】从该日的原始行里挑出【收盘口径】那一批。
 *
 * 规则：同一只票两腿并存时取 leg='close'（那是这一天 20 日复利的权威值）；
 * 只有 leg='auc' 行的票 ⇒【不收】——它那一天是按竞价腿算的，拿来当收盘腿比就是混口径
 * （用户：「不要搞混了」）；这一天这类票在收盘口径下就是「判不出」，显示 '—'。
 * leg 为空（历史脏数据）按 close 对待（表里 leg 缺省的旧行本来就是收盘口径）。
 *
 * @param {Array<{stock:string,pct:*,leg:string}>} rows
 * @returns {Array<{stock:string,pct:*}>}
 */
export function pickCloseLegRows(rows) {
  const byName = new Map();
  (rows || []).forEach(function(r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    const leg = String(r.leg || PREV_LEG_CLOSE).trim().toLowerCase();
    const prev = byName.get(name);
    if (!prev) { byName.set(name, { stock: name, pct: r.pct, leg: leg }); return; }
    // 已经有 close ⇒ 不再被 auc 覆盖；已有 auc ⇒ close 进来要顶掉它
    if (prev.leg !== PREV_LEG_CLOSE && leg === PREV_LEG_CLOSE) {
      byName.set(name, { stock: name, pct: r.pct, leg: leg });
    }
  });
  const out = [];
  byName.forEach(function(v) { if (v.leg === PREV_LEG_CLOSE) out.push({ stock: v.stock, pct: v.pct }); });
  return out;
}

/** date|leg -> 缓存 key */
function _key(date, leg) { return date + '|' + leg; }

function _put(key, rec) {
  _cache.set(key, rec);
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
  _version.value += 1;
}

/**
 * 【同步读】取某日某口径的名次表（未加载 ⇒ null）。
 * ⛔ 本函数不发请求；取数见 `ensurePrevRankTable`。
 *
 * @param {string} date YYYY-MM-DD（= 上一交易日）
 * @param {'auc'|'close'} leg
 * @returns {{ranks: Map<string,number>, pcts: Map<string,number>, count:number}|null}
 */
export function getPrevRankTable(date, leg) {
  const d = String(date || '').trim();
  if (!d) return null;
  return _cache.get(_key(d, leg === PREV_LEG_AUC ? PREV_LEG_AUC : PREV_LEG_CLOSE)) || null;
}

/**
 * 【异步读】确保某日某口径的名次表已加载（会话缓存 + 单飞）。
 *
 * @param {string} date YYYY-MM-DD（= 上一交易日）
 * @param {'auc'|'close'} leg
 * @returns {Promise<{ranks:Map,pcts:Map,count:number}|null>} null = 判不出（该口径没有可信数据）
 * @throws 读取失败时抛错（§10；调用方走 apiStatus 让用户看见）
 */
export async function ensurePrevRankTable(date, leg) {
  const d = String(date || '').trim();
  const L = leg === PREV_LEG_AUC ? PREV_LEG_AUC : PREV_LEG_CLOSE;
  if (!d) return null;
  const key = _key(d, L);
  if (_cache.has(key)) return _cache.get(key);
  if (_inflight.has(key)) return _inflight.get(key);

  const task = (async function() {
    try {
      let rec = null;
      if (L === PREV_LEG_AUC) {
        // 竞价口径：与「今天那一列」同一个读取器、同一次反解（§6 一把尺子）
        const map = await readAuctionLegRange20Pct(d);
        if (map && typeof map.forEach === 'function') {
          const list = [];
          map.forEach(function(v, name) { list.push({ stock: name, pct: v && v.pct }); });
          rec = buildRankTable(list);
        }
      } else {
        const rows = await readRange20PctRowsForDate(d);
        rec = buildRankTable(pickCloseLegRows(rows));
      }
      _put(key, rec);              // null 也缓存：同一口径同一天别反复问（缓存有 TTL，见 Data 层）
      if (!rec) _dbgLog('[R20-PREV] ' + d + ' 的 ' + L + ' 口径名次表判不出');
      return rec;
    } catch (e) {
      _dbgLog('[R20-PREV] 读 ' + d + '（' + L + '）名次表失败: ' + ((e && e.message) || e));
      throw e;                     // §10：失败不写缓存
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, task);
  return task;
}

/** 清空会话缓存（仅供测试 / 换账户） */
export function clearPrevRankTableCache() {
  _cache.clear();
  _inflight.clear();
  _version.value += 1;
}
