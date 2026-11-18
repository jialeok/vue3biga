// tvrb-auction-board30.js — 题材量比选股【第三十五条】专用的 30 日涨幅榜（9:26 竞价口径 · 只主板）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么要有这个文件（而不是让规则层自己去读结果表）
// ══════════════════════════════════════════════════════════════════════════════════════
//   `stock_range30_pct` 结果表是【收盘口径】的表：
//     · 15:00 后 `resolveT20LegMode` 类型的口径切换、16:30 云端 heal 覆盖、补位票混入……
//       这一整类「同一天早/晚候选池与名次都不一样」的病，20 日榜已经踩过一次
//       （见 `tvrb-auction-board.js` 文件头 11-10 事故链）。
//   ⇒ 30 日榜【照抄那条已被验证的路】：
//     ① 数值：`readAuctionLegRange30Pct(date)` —— 项目唯一实现，把 `leg='close'` 的行
//        用 `market_metrics.auc_pct_chg / change_pct` 反解回 9:25 竞价腿（§6 同一把尺子）；
//     ② 候选池：固定为当日 9:25 名单（`market_metrics(scope='auction')` 里有 `auc_pct_chg` 的票）
//        ⇒ 16:30 补位票恒不进榜；
//     ③ 门槛：`RANGE30_MIN_LEGS`(10) + `getBoardKind === MAIN`（§6 唯一实现）；
//     ④ 排序：**不在此处实现** —— 直接复用 `auction-leg-board.js#buildAuctionLegBoard`
//        （20 日 / 30 日只差一个 `minDays` 和一个 pctMap，⛔ 绝不另写一份排序）。
//
//   用户口径（2026-11-18）：「记住是竞价口径」—— 这一句就是本模块存在的全部理由。
//
// ── 实测（11-18 复核，⚠️ 供将来改口径时对照）─────────────────────────────────────────
//   「限定 9:25 名单」与「用全表排序」在前五上【完全一致】（11-04 / 11-17 / 11-18 三天逐位相同），
//   因为进榜的票本来就都在 9:25 名单里。限定名单是为了防 16:30 补位票污染，不是为了改结论。
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────────
//   §10 `pctMap === null`（结果表不可用 / 读失败）或指标行读失败 ⇒ `ready=false`，
//       ⛔ 绝不返回空数组冒充「今天没有 30 日龙头」；调用方据此**不接管**并如实标注「判不出」。
//   §11 纯只读 —— 不建表、不落库、不触碰 `range30-leaders` 的发布结果（那一条服务于「30日涨幅」
//       toggle 与「市龙一~五」标签，口径/用途不同，⛔ 别合并）。
//   §32 按日期会话缓存 + 单飞；底层读取器本身也各带缓存 ⇒ 0 新增网络请求。

import { ref } from 'vue';
import { readAuctionLegRange30Pct } from '../auction/range30-auction-leg.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { buildAuctionLegBoard } from '../auction/auction-leg-board.js';
import { RANGE30_MIN_LEGS } from '../auction/range30-math.js';

/** 模块级状态（§7：不进 Pinia；与 tvrb-auction-board 同款 ref-driven 范式） */
const _state = ref({
  date: '',
  board: null,
  version: 0
});
/** 单飞：date -> Promise（同一天并发只算一遍） */
const _inflight = new Map();
/** 最近一次被请求的日期（切日期竞态护栏：只发布「最新那次请求」的结果） */
let _latestDate = '';

/**
 * 【纯函数】把「竞价口径 30 日涨幅 Map + 当日 9:25 竞价指标行」组装成榜。
 *
 * ★ 实现体完全复用 `buildAuctionLegBoard`（§6）：只把 `minDays` 换成 30 日的腿数门槛。
 *
 * @param {Map<string,{pct:number,days:number}>|null} pctMap 9:26 竞价口径 30 日涨幅（全市场）
 * @param {Array<{stock:string,code?:string,auc_pct_chg?:string|number}>|null} metricRows
 *        当日 `market_metrics(scope='auction')` 的行 —— 同时充当【候选池白名单】与【代码来源】
 * @param {{minDays?:number, codeOf?:(name:string)=>string}} [opts]
 * @returns {object} 见 auction-leg-board.js#buildAuctionLegBoard（`rank` 为全量主板降序）
 */
export function buildTvrbAuctionBoard30(pctMap, metricRows, opts) {
  const o = Object.assign({}, opts || {});
  if (typeof o.codeOf !== 'function') o.codeOf = getStockCode;
  if (!isFinite(Number(o.minDays)) || Number(o.minDays) <= 0) o.minDays = RANGE30_MIN_LEGS;
  return buildAuctionLegBoard(pctMap, metricRows, o);
}

/** 同步读某日已算好的竞价口径 30 日榜（null = 还没算过 / 判不出，§10 两者都按「未就绪」处理） */
export function getTvrbAuctionBoard30(date) {
  const d = String(date || '').trim();
  const s = _state.value;
  if (!d || s.date !== d || !s.board || !s.board.ready) return null;
  return s.board;
}

/** 「这一天到底试过没有」——成功或失败都算（供定稿门控区分「还在算」与「算不出来」，§10） */
export function hasTvrbAuctionBoard30Verdict(date) {
  const d = String(date || '').trim();
  return !!d && _state.value.date === d;
}

/** 响应式指纹：异步到货后让 `data` computed 自动重算一帧（与 getTvrbAuctionBoardToken 同款） */
export function getTvrbAuctionBoard30Token() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + (s.board ? s.board.rowCount : -1);
}

/**
 * 确保某日竞价口径 30 日榜已算好（幂等 + 单飞 + 会话缓存；永不 reject，失败按 §10 如实降级）。
 *
 * ⚠️ 两个 Data 层读取器自带缓存/单飞 ⇒ 0 新增网络请求（与 20 日榜同一份指标行）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<object>} buildTvrbAuctionBoard30 的结果（ready=false 也是有效结论）
 */
export function ensureTvrbAuctionBoard30(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(buildTvrbAuctionBoard30(null, null));
  _latestDate = d;
  const s = _state.value;
  if (s.date === d && s.board) return Promise.resolve(s.board);
  const fly = _inflight.get(d);
  if (fly) return fly;

  const p = Promise.all([
    readAuctionLegRange30Pct(d).catch(function() { return null; }),
    readMarketMetricsForDate(d, 'auction').catch(function() { return null; })
  ]).then(function(pair) {
    const board = buildTvrbAuctionBoard30(pair[0], pair[1]);
    // ⚠️ 切日期竞态：只发布「最新那次请求」的结果（§26 / §10）
    if (_latestDate === d) {
      _state.value = { date: d, board: board, version: _state.value.version + 1 };
    }
    return board;
  }).finally(function() {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 仅供测试：清空会话缓存（⛔ 正常业务流程无需调用） */
export function clearTvrbAuctionBoard30Cache() {
  _state.value = { date: '', board: null, version: 0 };
  _inflight.clear();
  _latestDate = '';
}
