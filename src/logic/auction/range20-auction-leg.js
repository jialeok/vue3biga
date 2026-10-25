// range20-auction-leg.js — 买点侧【20日涨幅 · 9:26 竞价口径】的读取 + 名次（Logic 层，§2 / §5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有它（2026-10-24 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，
//     因为一般都是早上选出来，收盘看的时候就不一样的，所以你在说明文字那里说明，它排名第几名
//     （我说有入选的时候）你不要解释，在上面说明时间他们的涨幅是多少排名第几就行了」
//
// ⇒ 买点侧的【20日涨幅通道】（退潮替补 = 总龙二~五 / 第二十八条切换日的新龙）选出来的票，
//   说明区要能写出「9:26 那一刻它的 20日涨幅是多少、排第几」。
//
// ── 与十日涨幅（range-auction-leg.js）同一条反解思路，⛔ 别另发明一套 ─────────────────
//   `stock_range20_pct` 的 `pct` 是【收盘口径】的 20 日复利（leg='close' 时，T 腿 = 今日收盘涨幅）。
//   把「今天」那一根腿从【收盘涨幅】换回【竞价涨幅】，其余 19 根不动 ⇒ 就是 9:26 那一刻的 20 日涨幅：
//     · `stock_range20_pct.pct`              —— 已含（收盘腿的）20 日复利
//     · `market_metrics.change_pct`          —— 现在那根 T 腿（收盘涨幅）
//     · `market_metrics.auc_pct_chg`         —— 9:25 那根 T 腿（竞价涨幅）
//   反解复用 `range-window.js#recoverAuctionLeg`（§6 唯一实现，与十日涨幅逐字同一把尺子）。
//
// ⚠️ `leg='auc'` 的行（页面在 15:00 前进过该日 ⇒ 当时就是用竞价腿算的）**原值就是 9:26 口径**
//   ⇒ 不再反解（再反解一次等于把竞价腿当收盘腿除，会算出一个看着很像真的假数）。
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 职责边界
// ══════════════════════════════════════════════════════════════════════════════════════
//   · 本模块【只做两件事】：读该日库里的 20 日涨幅 → 反解成 9:26 口径 → 只主板排队次。
//   · ⛔ 不选票、不判退潮、不改 `getRange20Leaders` 的发布结果（那是展示 / 退潮 / 总龙的口径，
//     用户明确锁定为「收盘后 20 天全收盘，与炒股软件对得上」——⛔ 不许被这里污染）。
//   · ⛔ 不建表、不落库、不改 worker（§11）。
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 红线
// ══════════════════════════════════════════════════════════════════════════════════════
//   §10：`readRange20Rows` 返回 null（加速层不可用 / 表不存在）⇒ 本模块返回 **null**（判不出），
//        ⛔ 绝不返回空 Map 冒充「这天没有数据」。调用方据此不写这条说明（⛔ 不猜名次）。
//   §10：单只票反解前提不满足（缺竞价涨幅 / 缺收盘涨幅）⇒ 该票**保留原值**（recoverAuctionLeg 内建），
//        ⛔ 不丢票、⛔ 不补 0。
//   §32：按日期【会话内缓存 + 单飞】，同一天最多两次读（且两份都走各自的 Data 层缓存）。
//
// ⚠️ 名次的口径（务必与用户看到的「20日涨幅」toggle 区分）：
//   · 名次在【当日 stock_range20_pct 的候选池内】排 —— 那正是产出前五 / 前八的那批票
//     （range20-leaders 的 coarseTop），所以前八名的名次是准的；
//   · 门槛与发布侧同一个常量（RANGE20_LEADER_MIN_LEGS）、同一个「只主板」判据（§6）。
//   ⇒ 文案里**必须写明**这是「9:26 竞价口径」，别让用户拿它去对收盘口径那一列。

import { readRange20Rows } from '../../data/stock-range20-cache.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { recoverAuctionLeg } from './range-window.js';
// 「只主板」与「可信门槛」都用发布侧那一个常量 / 那一个判据（§6：⛔ 不在这里另写一份）
import { RANGE20_LEADER_MIN_LEGS } from './range20-leaders.js';
import { getBoardKind, BOARD_MAIN } from './limit-up.js';

// ══ ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 现在有【两个消费者】，共用同一次取数 ══════════
//   ① 买点侧的「9:26 口径总龙名次」—— 要 Map<名, {pct, days, rank}>（只主板、只够天数的票）；
//   ② 早盘竞价看板的「竞价口径」toggle —— 要【全市场】的 Map<名, {pct, days}>（不筛主板：
//      那一列本来就是「全表排序 + 逐行标数值」，创业板也要有数，否则开关一开这些行就空了）。
//   ⇒ 缓存分两层：底层永远是【全市场 pct Map】（同一次请求、同一份反解，§6 一把尺子），
//      名次 Map 由它【派生】并另缓存一份（引用稳定 ⇒ 不白触发下游重算，§19）。
/** date -> Map<股票名, {pct, days}> | null（null = 判不出，与原实现同口径） */
const _cachePct = new Map();
/** date -> Map<股票名, {pct, days, rank}>（从 _cachePct 派生，按日期记忆） */
const _cacheRank = new Map();
/** 单飞：date -> Promise<Map|null> */
const _inflight = new Map();

/** 数值解析：空 / 非法 ⇒ null（⛔ 不返回 0，§10） */
function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 【纯函数】把「9:26 口径的 20 日涨幅行」排成主板名次（降序）。
 *
 * 排序规则与发布侧 `rankLeaders` 完全同构（涨幅降序 → 天数多者优先 → 名字升序），
 * 这样同一批票在本函数与「20日涨幅」toggle 上的相对顺序不会因排序细节分叉。
 *
 * @param {Array<{name:string, pct:number|null, days:number}>} rows
 * @param {{minDays?:number}} [opts] 缺省 = RANGE20_LEADER_MIN_LEGS（与发布侧同一个可信门槛）
 * @returns {Map<string,{pct:number, days:number, rank:number}>}
 *          只含「有数值 ∧ 天数达标 ∧ 主板」的票；⛔ 非主板 / 缺值不占名次
 */
export function rankMainBoardByPct(rows, opts) {
  const rawMin = Number((opts && opts.minDays) !== undefined ? opts.minDays : RANGE20_LEADER_MIN_LEGS);
  const minDays = isFinite(rawMin) ? rawMin : RANGE20_LEADER_MIN_LEGS;
  const keep = [];
  (rows || []).forEach(function(r) {
    if (!r) return;
    const name = String(r.name || r.stock || '').trim();
    if (!name) return;
    const pct = _num(r.pct);
    if (pct === null) return;                                   // §10 无值不参与排名
    const days = Number(r.days) || 0;
    if (days < minDays) return;                                 // 与发布侧同一个可信门槛
    const code = String(getStockCode(name) || '').replace(/\D/g, '');
    // ⛔ 代码拿不到 ⇒ 不算主板（这是主动往结论里加票，宁可少加也不加错 —— 与 isMainBoardOnly 同口径）
    if (getBoardKind(code) !== BOARD_MAIN) return;
    keep.push({ name: name, pct: pct, days: days, code: code });
  });
  keep.sort(function(a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.days !== a.days) return b.days - a.days;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  const out = new Map();
  keep.forEach(function(r, i) {
    out.set(r.name, { pct: r.pct, days: r.days, rank: i + 1 });
  });
  return out;
}

/**
 * 取数 + 反解（→ 【全市场】pct Map，⛔ 不筛主板、⛔ 不筛天数）。
 * @param {string} date
 * @returns {Promise<Map<string,{pct:number,days:number}>|null>}
 *          null = 加速层不可用（判不出，§10）
 */
async function _fetch(date) {
  const pair = await Promise.all([
    readRange20Rows(date),
    readMarketMetricsForDate(date, 'auction')
  ]);
  const rows = pair[0];
  const metricRows = pair[1];
  // §10：加速层不可用 ⇒ 判不出（⛔ 不返回空 Map 冒充「这天没有数据」）
  if (!rows || typeof rows.forEach !== 'function') return null;

  const mByName = new Map();
  (metricRows || []).forEach(function(r) {
    if (!r || !r.stock) return;
    const n = String(r.stock).trim();
    if (n && !mByName.has(n)) mByName.set(n, r);
  });

  const out = new Map();
  rows.forEach(function(v, name) {
    const nm = String(name || '').trim();
    if (!nm || !v) return;
    const raw = _num(v.pct);
    if (raw === null) return;
    const leg = String(v.leg || 'close');
    let pct = raw;
    if (leg !== 'auc') {
      // leg='close' ⇒ T 腿是收盘腿 ⇒ 反解回竞价腿（前提不满足时 recoverAuctionLeg 原样返回）
      const m = mByName.get(nm);
      if (m) {
        const rec = _num(recoverAuctionLeg(raw, m.auc_pct_chg, m.change_pct));
        if (rec !== null) pct = rec;
      }
    }
    out.set(nm, { pct: pct, days: Number(v.days) || 0 });
  });
  return out;
}

/**
 * 单飞 + 缓存地拿到某日的【全市场】竞价口径 20 日涨幅 Map。
 * ⚠️ null 会被缓存（「加速层不可用」是稳定条件，与改本函数之前的实现逐字一致）；
 *    【抛错不缓存】（§10：一次失败不能被记成「这天判不出」的永久结论）。
 * @param {string} d
 * @returns {Promise<Map<string,{pct:number,days:number}>|null>}
 */
function _ensure(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(null);
  const hit = _cachePct.get(d);
  if (hit !== undefined) return Promise.resolve(hit);
  const fly = _inflight.get(d);
  if (fly) return fly;
  const p = _fetch(d).then(function(map) {
    _cachePct.set(d, map);
    _cacheRank.delete(d);           // 底层换了 ⇒ 派生的名次作废
    return map;
  }).catch(function() {
    return null;                    // §10：读失败 ⇒ 判不出（⛔ 不写缓存）
  }).finally(function() {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 从全市场 pct Map 派生出「只主板 + 够天数」的名次 Map（判定全在 rankMainBoardByPct，§6） */
function _rankFrom(pctMap) {
  const items = [];
  pctMap.forEach(function(v, name) { items.push({ name: name, pct: v.pct, days: v.days }); });
  return rankMainBoardByPct(items, { minDays: RANGE20_LEADER_MIN_LEGS });
}

/**
 * ★★ [AUCTION-LEG-TOGGLE 2026-10-25 用户口径] 读取某日【9:26 竞价口径】的 20 日涨幅（**全市场**）。
 *
 * 用途：早盘竞价看板「竞价口径」toggle 打开时，「20日涨幅」列改为显示 / 排序这一份。
 * 与下方 `readAuctionLegRange20Rank` 【同一次取数、同一份反解】—— 只是不做主板 / 天数筛选。
 *
 * ⚠️ 与 `getRange20Pct(date)`（收盘口径，range20.js 现算）的差别只有【今天那一根腿】：
 *   那边是收盘涨幅复利，这边把今天那根腿换回 9:25 竞价涨幅 ⇒ 就是 9:26 那一刻看到的 20 日涨幅。
 *
 * @param {string} date YYYY-MM-DD（展示日）
 * @returns {Promise<Map<string,{pct:number,days:number}>|null>} null = 判不出（调用方据此不显示数值，§10）
 */
export function readAuctionLegRange20Pct(date) {
  return _ensure(date);
}

/**
 * 读取某日【9:26 竞价口径】的 20 日涨幅主板名次（Map<股票名, {pct, days, rank}>）。
 *
 * @param {string} date YYYY-MM-DD（展示日）
 * @returns {Promise<Map<string,{pct:number,days:number,rank:number}>|null>}
 *          null = 判不出（加速层不可用 / 表不存在）—— 调用方据此**不写**这条说明（§10 不猜）
 */
export function readAuctionLegRange20Rank(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(null);
  return _ensure(d).then(function(pctMap) {
    if (!pctMap) return null;                       // null = 判不出
    const hit = _cacheRank.get(d);
    if (hit) return hit;
    const rankMap = _rankFrom(pctMap);
    _cacheRank.set(d, rankMap);
    return rankMap;
  });
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用） */
export function clearAuctionLegRange20Cache() {
  _cachePct.clear();
  _cacheRank.clear();
  _inflight.clear();
}
