// auction-leg-board.js — 「恒 9:25 竞价口径」20 日涨幅榜的【纯函数】唯一实现（Logic 层，§6）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [BOARD-CORE-SPLIT 2026-11-13] 为什么从 tvrb-auction-board.js 拆出来 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   这个榜现在有【两个运行环境】的消费者：
//     ① 浏览器：题材量比的候选池（tvrb-auction-board.js → 第二十八/二十九/三十/三十一/三十二条、
//        退潮主线题材计数、总龙一）；
//     ② **云端 Cloudflare Worker**：第二十五条「总龙分歧」要回看近 20 个交易日【每天的榜】，
//        才能算出「它到底霸榜总龙一几天」（用户 2026-11-13 口径：「都是在云端运行，关电脑也能用，
//        不要电脑本地的」）。
//   ① 所在的 `tvrb-auction-board.js` 顶部引着 `vue` + `data/` 层 ⇒ Worker 打包会被拖进浏览器
//   supabase-client ⇒ 云端只能另写一份排队次的逻辑（§6 红线）。
//   ⇒ 把**榜单本身**抽成零依赖纯函数，两边都调它；`tvrb-auction-board.js` 只保留取数 + 响应式状态。
//
//   ⛔ 别在别处再写一份「只主板 + 腿数门槛 + 9:25 名单白名单 + 涨幅降序」：那就是两个尺子。
//
// ── 口径（与 tvrb-auction-board.js 文件头一致，逐字不变）────────────────────────────
//   ① 白名单 = 当日 `market_metrics(scope='auction')` 里【有竞价涨幅】的票（= 9:25 名单）
//      ⇒ 16:30 收盘覆盖时塞进来的补位票恒不进榜；
//   ② 逐票过滤：名单内 ∧ 有数值 ∧ 腿数 ≥ RANGE20_LEADER_MIN_LEGS ∧ 只主板；
//   ③ 排序：涨幅降序 → 天数多者优先 → 名字升序（可复现）。
//   §10：任一前提不满足 ⇒ 该票不进榜（⛔ 不补 0、不猜板块）；读失败 ⇒ ready=false（⛔ 不返空数组冒充
//        「今天没有龙头」）。

import {
  RANGE20_LEADER_TOP_N,
  RANGE20_LEADER_WIDE_N,
  RANGE20_LEADER_TEN_N,
  RANGE20_LEADER_MIN_LEGS
} from './range20-board-consts.js';
// 「只主板」的判据与发布侧同一个函数（`range20-leaders.js#isMainBoardOnly` 的实现就是这一行）。
// ⚠️ 这里引 `limit-up.js`（零 import 的纯模块），引不到 `range20-leaders.js`（那是浏览器模块）。
import { getBoardKind, BOARD_MAIN } from './limit-up.js';

/**
 * 数值解析：空 / 非法 ⇒ null（⛔ 不返回 0，§10）；与 range20-auction-leg.js#_num 同口径。
 * ⚠️ 名字加 `Brd` 后缀是为了让 `workers/_bundle.mjs`（朴素拼接式打包器，非 esbuild）
 *    的「顶层重名必须 0 处」自检通过 —— 同一份产物里已经有两份 `_num` 了。
 */
function _numBrd(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', '').replace('+', '').replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

/**
 * 【纯函数】把「竞价口径 20 日涨幅 Map + 当日 9:25 竞价指标行」组装成三份榜单。
 *
 * @param {Map<string,{pct:number,days:number}>|null} pctMap 9:25 竞价口径 20 日涨幅（全市场）
 * @param {Array<{stock:string,code?:string,auc_pct_chg?:string|number}>|null} metricRows
 *        当日 `market_metrics(scope='auction')` 的行 —— 同时充当【候选池白名单】与【代码来源】
 * @param {{minDays?:number, codeOf?:(name:string)=>string}} [opts]
 *        `codeOf` = 行内没带代码时的兜底代码源（浏览器传 getStockCode；Worker 传自己的 codeMap）。
 *        ⛔ 不传 ⇒ 只认行内 code（拿不到代码的票不计入榜 —— 宁可少一只，也不猜板块，§10）
 * @returns {{ready:boolean, reason:string, top5:Array, wide:Array, top10:Array,
 *            rank:Array, rankMap:Map, rowCount:number, listed:number, covered:number,
 *            excludedNoAuc:number, excludedNoCode:number}}
 *          ready=false ⇒ 三个榜单一律 []，调用方必须回落且如实标注（§10）。
 */
export function buildAuctionLegBoard(pctMap, metricRows, opts) {
  const empty = function (reason) {
    return {
      ready: false, reason: reason,
      top5: [], wide: [], top10: [], rank: [], rankMap: new Map(),
      rowCount: 0, listed: 0, covered: 0,
      excludedNoAuc: 0, excludedNoCode: 0
    };
  };
  // §10：读失败 / 表不可用 ⇒ 判不出（⛔ 不返回空数组冒充「今天没有龙头」）
  if (!pctMap || typeof pctMap.forEach !== 'function') return empty('range20-read-failed');
  if (!Array.isArray(metricRows)) return empty('metrics-read-failed');

  const o = opts || {};
  const minDays = isFinite(Number(o.minDays)) && Number(o.minDays) > 0
    ? Number(o.minDays) : RANGE20_LEADER_MIN_LEGS;
  const codeOf = typeof o.codeOf === 'function' ? o.codeOf : null;

  // ① 9:25 名单白名单（有竞价涨幅才算「当天在列表里」）
  const listedSet = new Set();
  const codeByName = new Map();
  let excludedNoAuc = 0;
  metricRows.forEach(function (r) {
    if (!r || !r.stock) return;
    const name = String(r.stock).trim();
    if (!name) return;
    if (_numBrd(r.auc_pct_chg) === null) { excludedNoAuc++; return; }
    listedSet.add(name);
    const c = String(r.code || '').replace(/\D/g, '');
    if (c && !codeByName.has(name)) codeByName.set(name, c);
  });
  if (listedSet.size === 0) return empty('empty-auction-list');

  // ② 逐票过滤：名单内 ∧ 有数值 ∧ 腿数够 ∧ 只主板
  let covered = 0;
  let excludedNoCode = 0;
  const keep = [];
  pctMap.forEach(function (v, name) {
    const nm = String(name || '').trim();
    if (!nm || !listedSet.has(nm) || !v) return;
    const pct = _numBrd(v.pct);
    if (pct === null) return;
    covered++;
    const days = Number(v.days) || 0;
    if (days < minDays) return;
    let code = codeByName.get(nm) || '';
    if (!code && codeOf) {
      try { code = String(codeOf(nm) || '').replace(/\D/g, ''); } catch (e) { code = ''; }
    }
    if (!code) { excludedNoCode++; return; }
    // §6：只主板的判据与发布侧同一个函数，⛔ 不在这里另写一套代码段规则
    if (getBoardKind(code) !== BOARD_MAIN) return;
    keep.push({ stock: nm, code: code, pct: pct, days: days });
  });

  // ③ 排序与 `rankLeaders` 同构（涨幅降序 → 天数多者优先 → 名字升序），保证结果可复现
  keep.sort(function (a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.days !== a.days) return b.days - a.days;
    return a.stock < b.stock ? -1 : (a.stock > b.stock ? 1 : 0);
  });
  if (keep.length === 0) return empty('no-mainboard-rows');

  return {
    ready: true,
    reason: '',
    top5: keep.slice(0, RANGE20_LEADER_TOP_N),
    wide: keep.slice(0, RANGE20_LEADER_WIDE_N),
    top10: keep.slice(0, RANGE20_LEADER_TEN_N),
    rank: keep,
    // 说明区要用的「9:25 那一刻涨幅 + 第几名」——与选股榜【同一份 rank】，
    // ⛔ 不再另起一份名次（11-10 之前这里读的是含 16:30 补位票的旧 Map，名次会对不上）。
    rankMap: new Map(keep.map(function (r, i) {
      return [r.stock, { pct: r.pct, days: r.days, rank: i + 1 }];
    })),
    rowCount: keep.length,
    listed: listedSet.size,
    covered: covered,
    excludedNoAuc: excludedNoAuc,
    excludedNoCode: excludedNoCode
  };
}
