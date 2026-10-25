// auction-leg-ranges.js — 早盘竞价看板「竞价口径」toggle 的【唯一数据出口】（Logic 层，§2 / §5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有它（2026-10-25 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「还不如早盘竞价把弱转强toggle换成竞价口径toggle影响20日和10排名，也就是打开后，
//     按照竞价口径排序，关闭后恢复原样，（收盘后打开或者查看历史日期也方便，早上没开盘的
//     竞价口径不用打开也是竞价口径，因为没被收盘涨幅覆盖，主要是历史日期或者收盘后，
//     可以打开对照）这样在视觉上我一眼就能看出，也就是10日涨幅和竞价口径toggle可以同时打开，
//     20日涨幅也是一样，关掉竞价toggle后，就变成收盘口径（和原来一样），这样更加简单些。」
//
// ⇒ 这是一个【口径修饰开关】，不是主排序开关：
//     · 打开 = 「十日涨幅」「20日涨幅」两列改用 9:26 竞价口径的数值来排 + 显示；
//     · 关闭 = 逐字回到原来的收盘口径；
//     · ⛔ 不进主排序的互斥组（byRangePct / byRangePct20 / byJingYest …）—— 用户明确要求
//       「10日涨幅和竞价口径toggle可以同时打开」，互斥就会把它变成二选一。
//
// ── 数据从哪来（⛔ 不新建表、不新建口径，§6 单一真相）────────────────────────────────
//   · 十日：`range-auction-leg.js#readAuctionLegRangeMap`（题材量比看板选股用的【同一份】）；
//   · 二十日：`range20-auction-leg.js#readAuctionLegRange20Pct`（与买点侧总龙名次【同一次取数】）。
//   两者都只做一件事：把区间涨幅的【今天那一根腿】用 market_metrics 的
//   `auc_pct_chg` / `change_pct` 反解回 9:25 竞价（`range-window.js#recoverAuctionLeg`）。
//   ⇒ 早上没开盘 / 还没收盘覆盖时，反解前提不成立 ⇒ 原样返回 ⇒ 两套口径数值自然相同
//     （这正是用户说的「早上没开盘的竞价口径不用打开也是竞价口径」）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10：任一读取失败 ⇒ 那一侧 map 为 **null**（判不出），⛔ 绝不返回空 Map 冒充「这天没有数据」。
//        调用方据此让行上不显示数值（⛔ 不许拿收盘口径顶替，那等于拿错口径冒充对口径）。
//   §11：默认关闭；本模块在关闭时【一个请求都不会发】（取数由调用方按开关门控）。
//   §19：发布时整块替换 ref（日期 / 版本 / 两张 Map 一起换），读取方拿到的是稳定引用，
//        ⛔ 不在原地改 Map（否则下游 computed 会看不到变化、或者看到半更新状态）。
//   §32：按日期会话缓存 + 单飞，同一天最多各读一次（底层两个读取器自己也带缓存）。
//
// ⚠️ 与「题材龙位 / 决策看板」的关系：**无关**。
//   题材模式下龙一/龙二徽章仍然走收盘口径（`dragon-rank.js`），决策看板仍然走它自己的
//   `rankDragonsWithPctMap`（本来就是 9:26 口径）。本模块只喂早盘竞价那两个涨幅列。

import { ref } from 'vue';
import { readAuctionLegRangeMap } from './range-auction-leg.js';
import { readAuctionLegRange20Pct } from './range20-auction-leg.js';

/** 模块级状态（§7：不进 Pinia，与 dragonState / range20 的 _state 同款 ref-driven 范式） */
const _state = ref({
  date: '',
  loaded: false,   // true = 这一天已经尝试取过数（成功或失败都算「不再等」）
  map10: null,     // Map<股票名, {pct, days}> | null（null = 判不出）
  map20: null,     // Map<股票名, {pct, days}> | null（null = 判不出）
  version: 0
});

/** 单飞：{ date, promise } —— 同一天并发调用只发一轮请求 */
let _inflight = null;
/**
 * 最近一次【被请求】的日期。
 * 🔴 为什么必须单独记它（写单测时抓到的一个真实缺陷）：发布结果时的护栏如果拿 `_state.value.date`
 *   去比，会出现「A 已发布 ⇒ 请求 B ⇒ 护栏看到 state.date='A' ≠ '' 且 ≠ 'B' ⇒ 直接 return」
 *   ⇒ **切日期后新日期永远发布不出去**，用户会一直看到 A 的竞价口径数值。
 *   正确判据是「这次结果是不是最新那个请求的」：与 `_latestDate` 比。
 */
let _latestDate = '';

/**
 * 确保某日的两套「竞价口径区间涨幅」已加载（幂等；已加载直接返回）。
 *
 * @param {string} date YYYY-MM-DD（展示日）
 * @returns {Promise<void>} 永不 reject（失败降级为「该侧 null」，由调用方按 §10 处理）
 */
export function ensureAuctionLegRanges(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve();
  const s = _state.value;
  _latestDate = d;
  if (s.date === d && s.loaded) return Promise.resolve();
  if (_inflight && _inflight.date === d) return _inflight.promise;

  const promise = Promise.all([
    // 十日那份读取器按契约会 throw（§10）；这里降级为 null，而不是让整个 ensure 失败 ——
    // 二十日那一侧能出来就仍然可用（两侧互不拖累）。
    readAuctionLegRangeMap(d).catch(function() { return null; }),
    readAuctionLegRange20Pct(d).catch(function() { return null; })
  ]).then(function(pair) {
    // ⚠️ 期间用户可能已经切走日期 ⇒ 别用旧日期的结果污染新日期。
    //   判据 = 「这次结果是不是【最新那个请求】的」（与 _latestDate 比，⛔ 不是与已发布的 state.date 比，
    //   否则第一次发布之后的新日期永远发不出去 —— 见 _latestDate 的注释）。
    if (_latestDate !== d) return;
    _state.value = {
      date: d,
      loaded: true,
      map10: pair[0] || null,     // 只有 null/undefined 才塌成「判不出」；空 Map 是「这天确实没有行」（§10 两者不混）
      map20: pair[1] || null,
      version: _state.value.version + 1
    };
  }).finally(function() {
    if (_inflight && _inflight.promise === promise) _inflight = null;
  });

  _inflight = { date: d, promise: promise };
  return promise;
}

/**
 * 读【竞价口径】十日涨幅（同步）。日期不匹配 / 未加载 / 判不出 ⇒ null。
 * @param {string} date
 * @returns {Map<string,{pct:number,days:number}>|null}
 */
export function getAuctionLegRange10(date) {
  const s = _state.value;
  if (!date || s.date !== String(date) || !s.loaded) return null;
  return s.map10;
}

/**
 * 读【竞价口径】二十日涨幅（同步）。日期不匹配 / 未加载 / 判不出 ⇒ null。
 * @param {string} date
 * @returns {Map<string,{pct:number,days:number}>|null}
 */
export function getAuctionLegRange20(date) {
  const s = _state.value;
  if (!date || s.date !== String(date) || !s.loaded) return null;
  return s.map20;
}

/**
 * 该日是否「已经尝试取过数」（不论成功失败）。
 * 用途：视图层区分「还在读」与「读完了但判不出」——这两种给用户的话术不同（§10）。
 * @param {string} date
 */
export function isAuctionLegRangesLoaded(date) {
  const s = _state.value;
  return !!date && s.date === String(date) && s.loaded;
}

/**
 * 增量渲染指纹令牌。
 * ⚠️ 与 range20 的令牌同款理由（§19/§23）：异步到货必须让行缓存整体失效，
 *   否则行上数值与整表顺序会停在「还没到货」那一帧。
 */
export function getAuctionLegRangesFingerprintToken() {
  const s = _state.value;
  if (!s.date || !s.loaded) return 'off';
  return s.date + '|v' + s.version + '|n' + (s.map10 ? s.map10.size : '-') + '|n' + (s.map20 ? s.map20.size : '-');
}

/** 清空（仅供测试 / 换数据源时调用；⛔ 正常业务流程无需调用） */
export function clearAuctionLegRanges() {
  _inflight = null;
  _latestDate = '';
  _state.value = { date: '', loaded: false, map10: null, map20: null, version: _state.value.version + 1 };
}
