// range-auction-leg.js — 「题材量比看板」用的【9:26 口径区间涨幅】读取器（Logic 层，§2 / §5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有它（2026-10-14 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「题材量比看板选股买点侧，为什么早上的，和收盘的不一样，我只想要早上 9 点 26 分的，
//     可能收盘后，涨幅覆盖了，又重新计算……因为我对照历史日期的时候就对不上，
//     比如今天我明明买了某只股票，过些时间我再翻开那个时期，又成另外一只股票，非常不合理。」
//
// ── 根因（已用真实数据坐实）──────────────────────────────────────────────────────────
//   区间涨幅的【当天那根腿（T 腿）】在 15:00 后被 close-pct-cover.js#_syncRangeTDay
//   由【9:25 竞价涨幅】换成【收盘涨幅】（range-window.js#replaceTDayLeg）。
//   而题材量比看板的选股是「题材内按龙位取票」，龙位 = 组内【十日涨幅】降序
//   （decision-rules.js#rankDragons → computeDragonRankMap）
//   ⇒ 每只票被换腿的幅度各不相同（= 该股「收盘 − 竞价」之差）⇒ 组内名次重排 ⇒ 龙一换人
//      ⇒ 选出来的票换了。实测（2026-10-13）：可比题材组 7 个里 【5 个】的龙一换人
//      （例：AI应用 慈文传媒 → 德才股份；医药 贝瑞基因 → 华北制药）。
//
// ── 本模块的作用 ─────────────────────────────────────────────────────────────────────
//   用【已落库的两个客观字段】把 T 腿反解回竞价口径 ⇒ 得到「9:26 那一刻」的十日涨幅：
//     · `stock_range_pct.range_pct`  —— 已含（收盘腿的）区间涨幅
//     · `market_metrics.change_pct`  —— 现在那根 T 腿（收盘涨幅）
//     · `market_metrics.auc_pct_chg` —— 9:25 那根 T 腿（竞价涨幅）
//   ⛔ 不建表、不改 worker、不改任何航情事实（§11）；**且能回溯全部历史日期**。
//   ⚠️ 只喂给【题材量比看板的买点侧选股】（用户拍板：退潮判定 / 市场总龙 保持现状不动），
//      `useTopicVolRatioBoard` 是唯一调用方。
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────────
//   · §10：读取失败必须 throw（⛔ 不返回空 Map 冒充「这天没有数据」）——
//     调用方据此把「9:26 口径未就绪」如实标出来，⛔ 绝不静默拿收盘口径顶替。
//   · §10：反解的前提（两行都已是收盘口径 & 两个涨幅都读得到）不满足 ⇒ **原样保留**，
//     ⛔ 绝不猜（详见 range-window.js#recoverAuctionLeg 的函数头）。
//   · §32：按日期【会话内缓存 + 单飞】，同一天最多两个请求（且 range 那份由 Data 层再缓存一层）。
//   · §26：进入看板/切日期时各调用一次；同一天切回来直接命中缓存，不会重复打接口。

import { readRangePctForDate } from '../../data/stock-range-pct.js';
import { readMarketMetricsForDate } from '../../data/market-metrics.js';
import { recoverAuctionLeg, closeCoverUtcMs } from './range-window.js';

/** 会话内按日期缓存：date -> Map<股票名, {pct, days}>（引用稳定 ⇒ 不白白触发下游重算，§19） */
const _cache = new Map();
/** 单飞：date -> Promise<Map> */
const _inflight = new Map();

/** 这个时间戳是不是【该日 15:00 之后】写的（= 该行已是收盘口径）。取不到 ⇒ false（§10 不猜） */
function _writtenAfterClose(iso, closeMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || Number.isNaN(closeMs)) return false;
  return t >= closeMs;
}

/**
 * 真正取数并反解那一段。
 *
 * ⚠️ 两个请求【并行发出】：必须让「区间行」与「指标行」尽可能取到同一时刻的快照 ——
 *   若一前一后，正好卡在 15:00 收盘覆盖中间，就可能出现
 *   「区间行已换收盘腿、指标行还停在竞价值」的错配（此时下面两个前提不同时成立 ⇒ 不换算，
 *   退回原值，属于安全降级；并行只是把这个窗口压到毫秒级，不是正确性的依赖）。
 *
 * @param {string} date
 * @returns {Promise<Map<string, {pct:number|null, days:number}>>}
 */
async function _fetch(date) {
  const closeMs = closeCoverUtcMs(date);
  const pair = await Promise.all([
    readRangePctForDate(date),
    readMarketMetricsForDate(date, 'auction')
  ]);
  const rangeRows = pair[0];
  const metricRows = pair[1];

  const mByName = new Map();
  (metricRows || []).forEach(function(r) {
    if (!r || !r.stock) return;
    const n = String(r.stock).trim();
    if (n && !mByName.has(n)) mByName.set(n, r);
  });

  const out = new Map();
  rangeRows.forEach(function(v, name) {
    const m = mByName.get(name);
    // ★ 只有【两行都已按收盘口径写入】才反解 —— 否则这一行的原值本来就是 9:26 口径，原样用
    //   （与 close-pct-cover 判定「要不要换腿」用的是同一把时间尺子，§6）
    const covered = !!(m && _writtenAfterClose(v.updatedAt, closeMs) && _writtenAfterClose(m.updated_at, closeMs));
    const pct = covered ? recoverAuctionLeg(v.pct, m.auc_pct_chg, m.change_pct) : v.pct;
    out.set(name, { pct: pct, days: v.days });
  });
  return out;
}

/**
 * 读取某日【9:26 口径】的区间涨幅（Map<股票名, {pct, days}>）。
 *
 * ⛔ 这是「题材量比看板买点侧选股」专用的【龙位 / 十日涨幅】输入：
 *   龙位 = 组内本 Map 的 pct 降序（decision-rules.js#rankDragonsWithPctMap），
 *   与「早盘竞价看板 / 决策看板」屏幕上那一列（收盘口径）**刻意不同** ——
 *   用户要的是「早上 9:26 那一刻选中的股票，任何时候翻回来都是同一批」。
 *
 * @param {string} date YYYY-MM-DD（展示日）
 * @returns {Promise<Map<string, {pct:number|null, days:number}>>} 该日库里【没有】的行不放键
 * @throws 任一读取失败 —— 由调用方决定降级（见文件头 §10）
 */
export function readAuctionLegRangeMap(date) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve(new Map());
  const hit = _cache.get(d);
  if (hit) return Promise.resolve(hit);
  const fly = _inflight.get(d);
  if (fly) return fly;
  const p = _fetch(d).then(function(map) {
    _cache.set(d, map);
    return map;
  }).finally(function() {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用） */
export function clearAuctionLegCache() {
  _cache.clear();
  _inflight.clear();
}
