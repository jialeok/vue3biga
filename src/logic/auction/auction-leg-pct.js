// auction-leg-pct.js — 20日涨幅「反解成 9:25 竞价口径」的【纯函数】唯一实现（Logic 层）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [AUCLEG-SPLIT 2026-11-13] 为什么从 range20-auction-leg.js 拆出来 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   反解这件事现在有【三个】消费者：
//     ① 浏览器：买点侧「9:26 口径总龙名次」/ 20日涨幅 toggle（range20-auction-leg.js）；
//     ② 浏览器：第二十八条「老题材」要回看近 20 个交易日每天的竞价口径榜
//        （leader-first-topic.js）；
//     ③ **云端 Worker**：第二十五条「总龙分歧」要回看近 20 个交易日的竞价口径榜，
//        算「它到底霸榜总龙一几天」（用户 2026-11-13 口径：「都是在云端运行，关电脑也能用」）。
//   ①② 都在浏览器里，直接引 `range20-auction-leg.js` 就行；但那个文件顶部挂着
//   `data/stock-range20-cache.js` / `data/market-metrics.js`（浏览器 Data 层）
//   ⇒ ③ 一旦引它，Worker 打包就把浏览器 supabase-client 拖进去。
//   ⇒ 把纯函数这一段单独成文件（零 Data 层 import），两边都引它：**口径只有一份**（§6）。
//
//   ⛔ 别在 Worker 里另写一段反解：那正是用户最反感的「同一个口径两个尺子」。
//
// ── 口径（与 range20-auction-leg.js 文件头一致）────────────────────────────────────
//   `stock_range20_pct.pct` 在 `leg='close'` 时，T 腿 = 当日【收盘】涨幅；
//   把今天那根腿换回 9:25 竞价涨幅、其余 19 根不动 ⇒ 就是 9:26 那一刻的 20 日涨幅：
//     pct(close) / change_pct(收盘腿) / auc_pct_chg(竞价腿) → recoverAuctionLeg 反解
//   `leg='auc'` 的行原值就是竞价口径 ⇒ ⛔ 不再反解。
//
// §10：`rangeRows` 为 null ⇒ 返回 null（判不出），⛔ 绝不返回空 Map 冒充「这天没有数据」。

import { recoverAuctionLeg } from './range-window.js';

/** 数值解析：空 / 非法 ⇒ null（⛔ 不返回 0，§10） */
function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 【纯函数】把某日的「stock_range20_pct 原始行 + 当日竞价指标行」反解成
 * 【全市场 · 9:25 竞价口径】的 20 日涨幅 Map（⛔ 不筛主板、⛔ 不筛天数）。
 *
 * @param {Map<string,{pct:*,days:*,leg:string}>|null} rangeRows 某日的 `stock_range20_pct` 行
 * @param {Array<{stock:string, auc_pct_chg?:*, change_pct?:*}>|null} metricRows 该日 scope='auction' 行
 * @returns {Map<string,{pct:number,days:number}>|null} null = 加速层不可用（判不出，§10）
 */
export function buildAuctionLegPctMap(rangeRows, metricRows) {
  // §10：加速层不可用 ⇒ 判不出（⛔ 不返回空 Map 冒充「这天没有数据」）
  if (!rangeRows || typeof rangeRows.forEach !== 'function') return null;

  const mByName = new Map();
  (metricRows || []).forEach(function (r) {
    if (!r || !r.stock) return;
    const n = String(r.stock).trim();
    if (n && !mByName.has(n)) mByName.set(n, r);
  });

  const out = new Map();
  rangeRows.forEach(function (v, name) {
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
