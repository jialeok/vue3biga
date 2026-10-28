// prev-rank-table.js — 「昨日 20日涨幅名次表」的唯一装配处（Logic 层，§2 / §5 / §6）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-10-28，原话）：
//   「排名变化列那里，收盘是否重新算过一次，我希望重新算过一次，早上可以用竞价口径，
//     收盘时，用收盘口径，因为竞价时和收盘时会不同，不要搞混了，这样才能分辨出来。」
//   「我一般看竞价口径，收盘只是复盘用到。」
//
// ⇒ 【2026-10-28 15:49 用户第二次口述修正 —— 推翻了同日早先的「各自配各自的昨天」】
//   用户原话：
//     「注意我说的20日涨幅的当天竞价口径对比昨天的收盘口径的，比如10月26日，20日襄阳轴承的
//      竞价口径是58.37%，收盘口径是62.39%，昨10月27，襄阳轴承的收盘口径是77.49%，竞价口径
//      是68.96%，就是早上我打开时看到襄阳轴承是竞价口径排名比10月26日的襄阳轴承收盘口径的
//      排名增减变化（不是比10月26日的襄阳轴承竞价口径，这点你注意）」
//
//   ⇒ **基准腿恒为「昨日收盘口径」，与今天那一列是竞价还是收盘无关**：
//       · 今天 = 竞价口径（9:26 盘中 / 「竞价口径」toggle 打开）→ 比【昨日收盘】
//       · 今天 = 收盘口径（15:00 之后 / 历史日）              → 比【昨日收盘】
//
//   道理（别改回去）：昨天的竞价只是昨天盘中的一瞬，昨天的收盘才是昨天【定稿的最终强度】。
//   拿昨天的竞价当锚，量出来的位移里掺着「昨天自己从开盘走到收盘的那段漂移」，那不是隔夜强弱。
//   用户要的是「今早竞价有多强 vs 昨收有多强」= 隔夜发酵 / 资金态度变化。
//   ⛔ 别再让基准跟着 toggle 走 —— 早先那版就错在这里，用户已明确否掉。
//
// ── 为什么竞价那一侧不在 Data 层做 ──────────────────────────────────────────────────────
//   竞价腿是从「收盘腿 + market_metrics 的 auc_pct_chg/change_pct」反解出来的
//   （`range20-auction-leg.js#_fetch` 内部完成），属于 Logic 层能力；Data 层只交出原始行
//   （`data/range20-prev-rank.js`）。两条路径最后都汇到本文件 `buildRankTable`（§6 一处实现）。
//   ⚠️ 当前业务口径【只用 close】（见上方用户原话），auc 分支作为能力保留（ensurePrevRankTable
//      仍可按 leg='auc' 取），但 resolvePrevRankLeg() 不会再返回它 —— ⛔ 别因为「有分支」就顺手接上。
//
// ── 红线 ──────────────────────────────────────────────────────────────────────────────
//   §10：判不出就返回 null（任一来源读失败 / 该口径一行都没有），⛔ 绝不拿另一口径顶替，
//        ⛔ 也绝不用空表冒充「昨天谁都没名次」。
//   §19：版本号用 Vue `ref`（全局指纹在 `viewData` computed 里读它，裸 let 不建立依赖）。
//   §32：按 `date|leg` 会话缓存 + 单飞；同一口径同一天最多读一次。
//
// ⚠️ 与「收盘后自动重算」的分工：今天那一侧的换腿（竞价→收盘）由 `range20.js#_scheduleCloseSwitch`
//   负责（15:00 后 +90s 重算并 bump version）；本模块的基准腿恒为 close、**不随换腿变动**。
//   但今天那一列的值变了 ⇒ 名次差就变了 ⇒ `useAuctionBoard` 的 watch 仍要带 range20 指纹才重算。
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
 * 【基准腿】名次变化的「昨天」取哪个口径？
 *
 * 恒返回 'close' —— 昨天收盘是昨天【定稿的强度】，是唯一可当锚的东西。
 * 与今天那一列是竞价还是收盘【无关】：今天竞价也比昨天收盘，今天收盘也比昨天收盘。
 * ⛔ 不要在这里读 toggle / 当前时间；「今天这列是哪个口径」用 resolveTodayLeg()。
 *
 * @returns {'close'}
 */
export function resolvePrevRankLeg() {
  // 恒为「昨日收盘口径」。这是业务决策的唯一出口 —— ⛔ 不要在这里读 toggle / 时间：
  //   · 昨天收盘 = 昨天定稿的强度（唯一可当锚的东西）；
  //   · 昨天竞价 = 昨天盘中一瞬，拿它当锚等于把「昨天自己的日内漂移」算进今天的位移里。
  // 需要「今天这列是哪个口径」时用 resolveTodayLeg()，那是【文案用】，二者语义不同，别合并。
  return PREV_LEG_CLOSE;
}

/**
 * 【今日腿判定】今天那一列（「20日涨幅」列本身）此刻用的是哪个口径？
 *
 * ⚠️ 只用于【悬停文案】告诉用户「今天这列是竞价还是收盘」，⛔ 不参与基准腿选择
 *    （基准恒为昨日收盘，见 resolvePrevRankLeg 的注释）。
 *
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {boolean} byAuctionLeg 「竞价口径」toggle 是否打开
 * @returns {'auc'|'close'}
 */
export function resolveTodayLeg(date, byAuctionLeg) {
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
