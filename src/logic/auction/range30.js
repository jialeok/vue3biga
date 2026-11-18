// range30.js — 「30日涨幅」的唯一计算实现（Logic 层，§2 / §5 / §15）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么是「一次性比值」而不是逐日连乘（2026-11-18 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「30日的计算方式就是刚才我们讨论的那个逻辑这样更高效一些」。
//
//   讨论结论（实测已验证）：N 日区间涨幅 = 期末收盘价 / 期初前收盘价 − 1。
//   数学上与「逐日涨幅复利连乘」完全等价 —— 复利连乘的每一项都是相邻收盘价比值，
//   连乘后中间项全部约掉，只剩首尾两个价 ⇒ 一次除法，⛔ 不需要 30 次乘法、不需要腿表。
//   实测（新华传媒 600825，10-28，30 日窗口 09-09~10-28）：
//     收盘价比值 5.31 → 14.81 = +178.91%   ≡  逐日连乘口径 +178.91%（完全一致）
//   附带好处：逐日连乘用的是库里两位小数的逐日涨幅，30 天会累积舍入误差
//     （指数侧实测差 0.02 个百分点）；收盘价比值没有这一步舍入 ⇒ 更接近官方值。
//
// ── 窗口定义（与官方「连续 N 个交易日」同口径）──────────────────────────────────────
//   · 窗口 = 含 asOf 在内往前数 30 个【交易日】（交易日历 = logic/date/trading-day-helpers.js）；
//   · 期初前收盘 = 窗口首日的【前一个交易日】收盘价。若该日停牌，取它之前最后一个有成交的收盘价
//     —— 停牌期间前收盘不变，这在数学上完全等价（实测：新华传媒 09-08 停牌 ⇒ 基准取 09-04）；
//   · 期末收盘 = asOf 当日收盘；asOf 停牌 ⇒ 取 ≤ asOf 的最后一个收盘（价格未变，等价）。
//
// ── 两种口径（用户：「有竞价口径和收盘口径，要注意下」）────────────────────────────
//   · 收盘口径：上面那个比值本身。落库（stock_range30_pct，leg='close'）。
//   · 竞价口径：把「今天那一根腿」从收盘涨幅换回 9:25 竞价涨幅。
//     实现不另写：`range-window.js#recoverAuctionLeg`（十日 / 二十日用的同一把尺子，§6），
//     见 `range30-auction-leg.js`。⛔ 竞价口径不落库（它随当天竞价实时变）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10 算不出 ⇒ **null**（⛔ 绝不补 0）：次新股（上市日在窗口内）、窗口内成交腿数不足、
//       基准价或期末价缺失，一律不出值；调用方让该行「无 30日涨幅」（置底），⛔ 不猜。
//   §11 默认关闭：开关关着时本模块【一个请求都不发】（取数由调用方按开关门控）。
//   §19 发布整块替换（date / map / version 一起换），读取方拿到稳定引用，⛔ 不原地改 Map。
//   §32 按日期会话缓存 + 单飞；单只票的 K 线失败登记在 `_tried`，force 才重试。
//
// ── 数据来源 ───────────────────────────────────────────────────────────────────────
//   腾讯前复权日线 `fetchQtDailyBars`（批量、免费、0 猫抓额度；同花顺通道当前 FUYAO_OFF）。
//   ⛔ 不复用 stock_daily_pct（那张表只有逐日涨幅、没有价，算不出一次性比值）。

import { ref } from 'vue';
import { fetchQtDailyBars } from '../../data/api/qt-kline.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { readRange30Rows, upsertRange30Rows } from '../../data/stock-range30-cache.js';
import { getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { _dbgLog } from '../../data/debug-log.js';
// ★ [RANGE30-CLOUD 2026-11-18] 数学部分搬到 `range30-math.js`（零 import 的纯函数）——
//   那样 Cloudflare Worker 也能直接用同一份公式算完落库，前端不必依赖「手机能不能连上腾讯」。
import {
  RANGE30_WINDOW_DAYS,
  RANGE30_MIN_LEGS,
  normalizeBars,
  barOnOrBefore,
  windowFromTradingDays,
  range30InWindow
} from './range30-math.js';

// 纯函数原样再导出：单测与既有调用方一直从本文件取这些名字，⛔ 不要改导出面。
export { RANGE30_WINDOW_DAYS, RANGE30_MIN_LEGS, normalizeBars, barOnOrBefore };

/**
 * K 线探测的自然日跨度。
 * 30 个交易日 ≈ 42 自然日，再留 18 天给长假 / 停牌 ⇒ 60 天足够覆盖「30 根腿 + 期初日那根」。
 */
export const RANGE30_PROBE_DAYS = 60;

/**
 * 【纯函数】构造 30 日窗口（前端口径：日历来自 `trading-day-helpers`）。
 *
 * ⚠️ 真正的窗口数学在 `range30-math.js#windowFromTradingDays`（worker 也用它）——
 *    本函数只负责「按前端的交易日历凑出 31 个升序交易日」，⛔ 不另写一套取窗逻辑。
 *
 * @param {string} asOf 窗口末日 YYYY-MM-DD（非交易日 ⇒ 自动退到最近交易日）
 * @param {number} [n] 窗口交易日数，默认 30
 * @returns {{dates:string[], start:string, end:string, baseDate:string}|null}
 */
export function buildRange30Window(asOf, n) {
  const want = Math.max(1, Number(n) || RANGE30_WINDOW_DAYS);
  const endIn = String(asOf || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endIn)) return null;
  const end = isTradingDay(endIn) ? endIn : getPreviousTradingDay(endIn);
  if (!end) return null;
  // 多取 1 天：升序列表里最前面那天就是 baseDate（窗口首日的前一个交易日）
  const asc = [];
  let cur = end;
  for (let i = 0; i <= want; i++) {
    if (!cur) break;
    asc.unshift(cur);
    if (i === want) break;
    cur = getPreviousTradingDay(cur);
  }
  return windowFromTradingDays(asc, endIn, want);
}

/**
 * 【纯函数】用日 K 序列算 30 日涨幅（一次性比值）。
 *
 * ⚠️ 真正的算式在 `range30-math.js#range30InWindow`（云端 worker 同一份）；
 *    本函数只负责「把前端的交易日历拼成窗口」。⛔ 别在这里复制第二份比例公式。
 *
 * @param {Array<{ymd:string, close:number}>} bars 该票日 K（任意顺序）
 * @param {string} asOf 窗口末日
 * @param {{days?:number, minLegs?:number}} [opts]
 * @returns {{pct:number, days:number, start:string, end:string,
 *            baseDate:string, baseClose:number, endDate:string, endClose:number}|null}
 *          null = 判不出（§10：次新股 / 腿数不足 / 缺基准价，⛔ 一律不补 0）
 */
export function range30FromBars(bars, asOf, opts) {
  const o = opts || {};
  return range30InWindow(bars, buildRange30Window(asOf, o.days), o);
}

// ══════════════════════════════════════════════════════════════════════════════════
// 会话状态（§7：不进 Pinia；与 range20 / auction-leg-ranges 同款 ref-driven 范式）
// ══════════════════════════════════════════════════════════════════════════════════
const _state = ref({
  date: '',
  loaded: false,     // true = 这一天已经尝试取过数（成功或失败都算「不再等」）
  map: null,         // Map<股票名, {pct, days}> | null（null = 判不出）
  version: 0
});

/** 单飞：{ date, promise } */
let _inflight = null;
/** 最近一次【被请求】的日期（与 state.date 分开：切日期后新日期必须仍能发布，见 auction-leg-ranges 的同款注释） */
let _latestDate = '';
/** date -> Set<股票名>：本会话已为该日期真的请求过 K 线却没出值的票（force 才重试） */
const _tried = new Map();

/** 清空（仅供测试 / 换数据源时调用） */
export function clearRange30() {
  _inflight = null;
  _latestDate = '';
  _tried.clear();
  _state.value = { date: '', loaded: false, map: null, version: _state.value.version + 1 };
}

/** 读【收盘口径】30 日涨幅（同步）。日期不匹配 / 未加载 / 判不出 ⇒ null */
export function getRange30Pct(date) {
  const s = _state.value;
  if (!date || s.date !== String(date)) return null;
  return s.map;
}

/** 该日是否「已经尝试取过数」（不论成功失败）—— 供视图层区分「还在读」与「读完了但判不出」 */
export function isRange30Loaded(date) {
  const s = _state.value;
  return !!date && s.date === String(date) && s.loaded;
}

/**
 * 增量渲染指纹令牌。
 * 异步到货必须让行缓存整体失效（§19/§23），否则行上数值与整表顺序会停在「还没到货」那一帧。
 */
export function getRange30FingerprintToken() {
  const s = _state.value;
  if (!s.date || !s.loaded) return 'off';
  return s.date + '|v' + s.version + '|n' + (s.map ? s.map.size : '-');
}

/**
 * 从入参抽 `{stock, code6}` —— 【行内 code 优先】，这是 2026-11-18 报障的修复点。
 *
 * 🔴 为什么必须优先行内 code（实测取证，别再改回只看 getStockCode）：
 *   `getStockCode` 读的是 `stockcodemap` 表，实测**只有 1184 行**（全市场 5000+）。
 *   2026-11-18 当天正式名单 32 行实测：`stockcodemap` 只命中 **16 行**，另一半（亚玛顿 / 北纬科技 /
 *   华东重机 / 华胜天成 …）在表里根本没有 ⇒ 全部被跳过 ⇒ 用户看到「30日涨幅一列全空」。
 *   而这 32 行在 `auction_watchlist` 里 **code 列 32/32 都有值**（worker 抓取时落的真值）。
 *   ⇒ 行内 code 是事件真值，永远先用它（与 `range20-leaders.js#codeOfRow` 同一个解析优先级，§6）。
 *
 * @param {Array} rows [{stock, code}] / ['名称']
 * @returns {Array<{stock:string, code:string}>} code = 6 位数字，判不出时为空串（§10 不猜）
 */
function _targetsOf(rows) {
  const out = [];
  const seen = new Set();
  (rows || []).forEach(function (r) {
    const n = String((r && r.stock) || r || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    const raw = (r && (r.code !== undefined ? r.code : r.stock_code)) || '';
    let code = String(raw).replace(/\D/g, '');
    if (code.length !== 6) code = String(getStockCode(n) || '').replace(/\D/g, '');
    out.push({ stock: n, code: code.length === 6 ? code : '' });
  });
  return out;
}

function _publish(date, map) {
  _state.value = {
    date: date,
    loaded: true,
    map: map,
    version: _state.value.version + 1
  };
}

/**
 * 确保某日的 30 日涨幅已算好（幂等；已加载且不 force ⇒ 直接返回）。
 *
 * 三步（顺序不许颠倒）：
 *   ① 读结果表（加速层；不可用 ⇒ null，⛔ 不当「没有数据」）；
 *   ② 扣掉已命中的票，剩下的批量拉腾讯日 K 现算（一次请求覆盖多只，§32）；
 *   ③ 写回结果表（写失败静默）+ 发布内存 Map。
 *
 * @param {string} date 窗口末日
 * @param {Array<{stock:string, code?:string}>|string[]} rows 需要出值的票（看板行 / 补位候选池）
 *        ★ 行里带 `code` 就优先用它（事件真值）；缺才回退 `getStockCode`（见 `_targetsOf` 注释）。
 * @param {{force?:boolean}} [opts] force = 用户点开开关的手动重试 ⇒ 清空「已试过」登记
 * @returns {Promise<void>} 永不 reject
 */
export function ensureRange30(date, rows, opts) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve();
  const o = opts || {};
  // ★ 目标 = {stock, code}：code 用【行内真值优先】解析，⛔ 不再只认 stockcodemap（那是 2026-11-18
  //   「30日涨幅一列全空」的根因，详见 `_targetsOf` 注释）。
  const targets = _targetsOf(rows);
  _latestDate = d;

  const s = _state.value;
  if (o.force) _tried.delete(d);
  // 同一天、已加载、且本次要的票都在结果里 ⇒ 无需重算（名单 9:25 逐步到达时不重复打请求）
  if (!o.force && s.date === d && s.loaded && _coversAll(s.map, targets, _tried.get(d))) return Promise.resolve();
  if (_inflight && _inflight.date === d) return _inflight.promise;
  if (targets.length === 0) return Promise.resolve();

  const promise = (async function () {
    // ① 结果表
    let cached = null;
    try {
      cached = await readRange30Rows(d);
    } catch (e) {
      cached = null;                       // §10：加速层失败 ⇒ 纯内存路径，⛔ 不当空数据
    }
    const map = new Map();
    if (cached) cached.forEach(function (v, k) { map.set(k, v); });

    // ★★ [RANGE30-CLOUD 2026-11-18] 结果表一读到就【先发布一次】，再去拉 K 线补缺。
    //   为什么必须分两次发布（这是「手机上一片空白」的第二道病根）：
    //     · 云端 worker 已把当天数值算好落库 ⇒ 常态下这一步就有全部数值，
    //       用户点开 toggle 应当「立刻看到」，而不是等 K 线（32 只 × 4 并发最多几十秒）；
    //     · 手机网络到不了腾讯时（2026-11-18 现场就是这样），若只在最后才发布，
    //       屏幕会一直空白 —— 库里明明有值却显示不出来。
    //   ⛔ 只发布真实读到的行，不造数（§10）。
    if (_latestDate === d && map.size > 0) _publish(d, new Map(map));

    // ② 缺的票批量拉 K 线现算
    const tried = _tried.get(d) || new Set();
    const missing = targets.filter(function (t) {
      return !map.has(t.stock) && !tried.has(t.stock);
    });
    if (missing.length > 0) {
      const codes = [];
      const codeSet = new Set();
      const codeOfName = new Map();
      missing.forEach(function (t) {
        if (!t.code) return;               // ⛔ 拿不到代码 ⇒ 判不出（不猜）
        if (!codeSet.has(t.code)) { codeSet.add(t.code); codes.push(t.code); }
        codeOfName.set(t.stock, t.code);
      });
      // 登记「已请求过」（含判不出代码的）：次新股 / 长期停牌 / 真没代码的票不重复烧请求（§32）
      missing.forEach(function (t) { tried.add(t.stock); });
      _tried.set(d, tried);

      if (codes.length > 0) {
        const from = _shiftYmd(d, -RANGE30_PROBE_DAYS);
        let barsByCode = new Map();
        try {
          barsByCode = await fetchQtDailyBars(codes, from, d, { timeoutMs: 9000, concurrency: 4 });
        } catch (e) {
          _dbgLog('[RANGE30] ' + d + ' 腾讯日线批量失败：' + ((e && e.message) || e));
          barsByCode = new Map();
        }
        const writeRows = [];
        codeOfName.forEach(function (code, name) {
          const got = range30FromBars(barsByCode.get(code) || null, d, {});
          if (!got) return;                  // §10：算不出 ⇒ 不出值（⛔ 不补 0）
          map.set(name, { pct: got.pct, days: got.days });
          writeRows.push({ stock: name, pct: got.pct, days: got.days });
        });
        if (writeRows.length > 0) {
          // ③ 落库（失败静默：下次打开重算一遍而已，不影响正确性）
          try { await upsertRange30Rows(d, writeRows); } catch (e) { /* 加速层，忽略 */ }
        }
        // ★ [RANGE30-DIAG 2026-11-18] 「一列全空」这类报障必须能从日志里分清是哪一段断掉的（§10）：
        //   请求了 N 只 → 算出 M 只。M=0 且 N>0 ⇒ 腾讯侧没给 bar 或窗口构造失败（日历未就绪）；
        //   0<N<请求数 ⇒ 部分票次新 / 停牌（正常判不出）。⛔ 这只是留痕，不改变任何行为。
        _dbgLog('[RANGE30] ' + d + ' 请求 ' + codes.length + ' 只 → 算出 ' + writeRows.length + ' 只'
          + '（名单 ' + targets.length + ' 只）');
      }
    }

    // ④ 发布（⚠️ 期间可能已切日期 ⇒ 只发布「最新那个请求」的结果，否则旧日期会污染新日期）
    if (_latestDate !== d) return;
    _publish(d, map);
  })().catch(function (e) {
    // 任何意外都不能把「判不出」变成「没有数据」：仍发布（可能是空 Map）并留痕
    _dbgLog('[RANGE30] ' + d + ' 计算异常：' + ((e && e.message) || e));
    if (_latestDate === d) _publish(d, new Map());
  }).finally(function () {
    if (_inflight && _inflight.promise === promise) _inflight = null;
  });

  _inflight = { date: d, promise: promise };
  return promise;
}

/**
 * 名单是否已被结果完全覆盖（缺一个就得重算 —— 9:25 名单是逐步到达的）。
 *
 * ★ 两条「不阻塞」豁免（⛔ 少了任一条，同一天每次调用都会重算一遍）：
 *   ① 目标本身解析不出代码 ⇒ 它永远不会有值，不能拿它把「已覆盖」永久卡成 false；
 *   ② 目标本轮已请求过却没出值（次新股 / 长期停牌 / 腿数不足）⇒ 那是 §10 的「判不出」，
 *      不是「还没算」，force 之前不该重复打请求。
 */
function _coversAll(map, targets, tried) {
  if (!map) return false;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (map.has(t.stock)) continue;
    if (!t.code) continue;
    if (tried && tried.has(t.stock)) continue;
    return false;
  }
  return true;
}

/** 'YYYY-MM-DD' ± n 天（纯字符串，⛔ 不用本地时区避免跨时区偏一天） */
function _shiftYmd(ymd, n) {
  const t = Date.parse(String(ymd || '').slice(0, 10) + 'T00:00:00Z');
  if (!isFinite(t)) return String(ymd || '').slice(0, 10);
  return new Date(t + Number(n || 0) * 86400000).toISOString().slice(0, 10);
}
