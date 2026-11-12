// tvrb-auction-board.js — 题材量比选股【恒 9:25 竞价口径】的 20 日涨幅榜（Logic 层，§4 / §6）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [TVRB-AUC-BOARD 2026-11-10 用户口径 · 整类修复] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户原话：「题材量比选股，我一直强调是用竞价口径的，而且每天收盘后都不要改变，
//             你看下所有的规则有没有规范这点。」
//
// ── 病根（11-10 实测取证，不是某一只股票的问题）────────────────────────────────────
//   题材量比所有吃「20 日涨幅榜」的规则（第三十 / 三十一 / 三十二 / 二十八 / 二十九条、
//   退潮主线题材计数、总龙一、分歧买点、数据闸门）都是从 `collectDecisionTopics` 的
//   `range20Top / range20Wide / range20Top10` 三个入参取候选池。
//   而这三个入参原先直接注入 `getRange20Leaders*` —— 那是浏览器【现算并发布】的榜：
//     · `resolveT20LegMode` 在 15:00 后把口径从 `auc` 切成 `close` ⇒ 作废缓存、重算、重新发布；
//     · 16:30 `supabase-heal.yml` 又用收盘口径全量覆盖 `stock_range20_pct`，
//       并往结果表塞进当日 9:25 名单之外的补位票（11-10 实测 6 只主板票无竞价涨幅）；
//   ⇒ 同一天早/晚的候选池成员与名次都不同 ⇒ 选出来的票变了。
//
// ── 本模块的做法（一处注入，全部规则受益；§6 单一真相）─────────────────────────────
//   ① 数值：`readAuctionLegRange20Pct(date)` —— 项目唯一实现，把结果表 `leg='close'` 的行
//      用 `market_metrics.auc_pct_chg / change_pct` 反解回 9:25 竞价腿（§6 同一把尺子）；
//      `leg='auc'` 的行原值即竞价口径，不再反解。
//   ② 候选池：**固定为当日 9:25 名单** = `market_metrics(scope='auction')` 里有 `auc_pct_chg` 的票
//      ⇒ 16:30 补位票恒不进榜（用户「列表的每只股票都有竞价口径的竞价涨幅」）。
//   ③ 门槛：与发布侧同一个 `RANGE20_LEADER_MIN_LEGS`、同一个 `isMainBoardOnly`（§6）。
//   ④ 三个榜单形状与 `getRange20Leaders*` 逐字一致 ⇒ 规则层 / 采集层一行都不用改（§11）。
//
//   ✅ 为什么「收盘后不改变」：竞价涨幅是 9:25 定值，`change_pct` 收盘后也是定值，
//      名单是 9:25 落库的快照 ⇒ 任何时刻打开、刷新、切日期回来，算出的都是同一份榜。
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 红线
// ══════════════════════════════════════════════════════════════════════════════════════
//   §10：`pctMap === null`（加速层不可用 / 读失败）或指标行读失败 ⇒ `ready=false`，
//        ⛔ 绝不返回空数组冒充「今天没有龙头」。调用方据此回落并如实标注。
//   §10：单只票前提不满足（无竞价涨幅 / 无数值 / 拿不到代码）⇒ 该票不进榜，
//        ⛔ 不补 0、不猜板块。
//   §11：纯只读 —— 不建表、不落库、不覆盖 `getRange20Leaders` 的发布结果。
//   §32：按日期会话缓存 + 单飞；两个 Data 层读取器本身也各带缓存/单飞 ⇒ 0 新增网络请求。
//
// 职责边界：⛔ 不选票、不判退潮、不判停牌/一字（那些由采集层 `_ebbCtxOf` 富化，§4）。
//         本模块只回答「这一天按竞价口径，20 日涨幅主板前五 / 前八 / 前十是谁」。

import { ref } from 'vue';
import { readAuctionLegRange20Pct } from '../auction/range20-auction-leg.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { buildAuctionLegBoard } from '../auction/auction-leg-board.js';

/** 模块级状态（§7：不进 Pinia；与 range20-leaders / auction-leg-ranges 同款 ref-driven 范式） */
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
 * 【纯函数】把「竞价口径 20 日涨幅 Map + 当日 9:25 竞价指标行」组装成三份榜单。
 *
 * ★ [BOARD-CORE-SPLIT 2026-11-13] **实现已搬到 ../auction/auction-leg-board.js**（零依赖纯模块），
 *   云端 Worker 的第二十五条判定要回看近 20 个交易日【每天的榜】，必须与这里同一把尺子（§6），
 *   而本文件顶部引着 vue + data/ 层 ⇒ 纯函数单独成文件，两边都引它。
 *
 * 这里只是「绑定浏览器代码源」的一层薄包装：`codeOf` 缺省 = getStockCode（与搬家前逐字相同，§11）。
 * ⛔ 判据 / 门槛 / 排序一律不在这里重复实现。
 *
 * @param {Map<string,{pct:number,days:number}>|null} pctMap 9:25 竞价口径 20 日涨幅（全市场）
 * @param {Array<{stock:string,code?:string,auc_pct_chg?:string|number}>|null} metricRows
 *        当日 `market_metrics(scope='auction')` 的行 —— 同时充当【候选池白名单】与【代码来源】
 * @param {{minDays?:number, codeOf?:(name:string)=>string}} [opts]
 * @returns {object} 见 auction-leg-board.js#buildAuctionLegBoard
 */
export function buildTvrbAuctionBoard(pctMap, metricRows, opts) {
  const o = Object.assign({}, opts || {});
  if (typeof o.codeOf !== 'function') o.codeOf = getStockCode;
  return buildAuctionLegBoard(pctMap, metricRows, o);
}

/** 同步读某日已算好的竞价口径榜（null = 还没算过 / 判不出，§10 两者都按「未就绪」处理） */
export function getTvrbAuctionBoard(date) {
  const d = String(date || '').trim();
  const s = _state.value;
  if (!d || s.date !== d || !s.board || !s.board.ready) return null;
  return s.board;
}

/** 「这一天到底试过没有」——成功或失败都算（供定稿门控区分「还在算」与「算不出来」，§10） */
export function hasTvrbAuctionBoardVerdict(date) {
  const d = String(date || '').trim();
  return !!d && _state.value.date === d;
}

/** 响应式指纹：异步到货后让 `data` computed 自动重算一帧（与 getRange20LeadersFingerprintToken 同款） */
export function getTvrbAuctionBoardToken() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + (s.board ? s.board.rowCount : -1);
}

/**
 * 确保某日竞价口径 20 日榜已算好（幂等 + 单飞 + 会话缓存；永不 reject，失败按 §10 如实降级）。
 *
 * ⚠️ 两个 Data 层读取器与 `readAuctionLegRange20Rank` 共用同一份缓存/单飞
 *    （`range20-auction-leg.js#_ensure` / `market-metrics.js#createQueryMemo`）⇒ 0 新增网络请求。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<object>} buildTvrbAuctionBoard 的结果（ready=false 也是有效结论）
 */
export function ensureTvrbAuctionBoard(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(buildTvrbAuctionBoard(null, null));
  _latestDate = d;
  const s = _state.value;
  if (s.date === d && s.board) return Promise.resolve(s.board);
  const fly = _inflight.get(d);
  if (fly) return fly;

  const p = Promise.all([
    readAuctionLegRange20Pct(d).catch(function() { return null; }),
    readMarketMetricsForDate(d, 'auction').catch(function() { return null; })
  ]).then(function(pair) {
    const board = buildTvrbAuctionBoard(pair[0], pair[1]);
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
export function clearTvrbAuctionBoardCache() {
  _state.value = { date: '', board: null, version: 0 };
  _inflight.clear();
  _latestDate = '';
}
