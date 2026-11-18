/**
 * market-dragon-top5-label.js — 「30日涨幅」toggle 的【专属显示层】纯函数。
 *
 * ============================================================================
 * 用户口径（2026-11-18，逐字）：
 *   「单独打开30天涨幅，按30天涨幅排名前五股票后面分别标上，市龙一，市龙二……市龙五，
 *     只标这五只，就是全市场的龙一（我自认为的），在行情非常差时，市龙一是比20日总龙一要强的，
 *     你先要明白这个概念。现在要先打上标签。」
 * ============================================================================
 *
 * ── 「市龙」是什么（用户自造的概念，⛔ 不要拿它去跟官方榜单对账）──────────────────
 *   市龙 = 按【30 个交易日】区间涨幅排出来的全市场名次，市龙一 = 30 日涨幅第一。
 *   与「总龙」（20 日涨幅前五，range20-top5-label.js）是**两套独立名次**，口径不同：
 *     · 总龙 → 20 日窗口（短、灵敏，行情好时更贴主线）；
 *     · 市龙 → 30 日窗口（长、抗噪音，行情很差时 30 日还能排第一的往往是真强，
 *       用户原话「行情非常差时，市龙一是比20日总龙一要强的」）。
 *   两者所在的 toggle 也是互斥的（toggleSort 里 byRangePct30 会关掉 byRangePct20），
 *   所以同一屏不会同时出现两套名次 —— 这也是它们可以各自用不同配色而不冲突的前提。
 *
 * ── 为什么单独建模块（而不是塞进 view-helpers 就地算）──────────────────────────────
 *   · 这是【只属于 30日涨幅 toggle】的一条显示口径，其它 toggle 一律不标
 *     （用户「只标这五只」+ 既有「总龙N」的同一纪律）；
 *   · 纯函数、零依赖、可独立单测（§15 / §42）：缺值置底且不占名次、
 *     非主板不占名次、越界不出「市龙六」，这些语义都要能被回归锁住。
 *
 * ⚠️ 本模块只「按当前顺序打名次」，**排序不在这里做**：
 *   顺序由 view-helpers（range-pct-sort.js 的同一个比较器）给出 —— 与十日 / 20日涨幅
 *   同一个三级键（缺数据置底 → pct 降序 → 稳定），§6 单一真相，⛔ 不另写一套比较器。
 *
 * ⚠️ §10 宁缺勿错：没有 30 日涨幅的行（数据未到 / 腿数不足算不出）**跳过且不占名次**，
 *   ⛔ 绝不补 0 让它顶上一个「市龙N」。非主板同样跳过且不占名次（名次顺延给下一只主板票）。
 */

/** 打标只数上限（用户口径：前五） */
export const MARKET_DRAGON_TOP_N = 5;

// [MAIN-BOARD-RANK 2026-10-24 用户口径] 「市龙N」与「总龙N」同一条纪律：只发给主板，
//   非主板（创业板/科创板/北交所）**不占名次**。判据走 limit-up.js 的唯一实现（§6），⛔ 不手写前缀。
import { isMainBoardRankEligible } from './limit-up.js';

/**
 * 名次文案。顺序即语义：第 1 名 = 市龙一（30 日涨幅第一）。
 * ⚠️ 用「一二三四五」而不是数字，是用户原话的写法（「市龙一，市龙二…」）。
 */
export const MARKET_DRAGON_LABELS = ['市龙一', '市龙二', '市龙三', '市龙四', '市龙五'];

/**
 * 【纯函数】名次 → 标签文案。越界 ⇒ ''（模板 v-if 直接不渲染，⛔ 不产出「市龙6」这种越界文案）。
 * @param {number} rank 1 起的名次
 * @returns {string}
 */
export function marketDragonLabel(rank) {
  const n = Number(rank);
  if (!isFinite(n) || n < 1 || n > MARKET_DRAGON_LABELS.length) return '';
  return MARKET_DRAGON_LABELS[Math.floor(n) - 1];
}

/**
 * 【纯函数】按「items 的当前顺序」给前 N 只打「市龙N」标（就地写字段，返回实际打标只数）。
 *
 * 入参 items 的顺序【必须已经是】30 日涨幅降序（由 view-helpers 保证），本函数不再排序。
 * 对**每一个**非空行都会写这两个字段（模板只渲染字符串，§21 零计算）：
 *   · `marketDragonRank`  : 1..N（0 = 不打标）
 *   · `marketDragonLabel` : '市龙一' / … / ''
 *
 * ★ 为什么「没选中的行也要显式写 0 / ''」而不是留给行对象自己的默认值：
 *   这些行对象进过增量视图缓存复用，只要有一次残留了名次，切 toggle / 换日期后就会
 *   在别的视图里冒出「市龙三」（§11：可选能力必须能保证默认无行为）。显式清零是结构性的。
 *
 * @param {Array<{rangePct30:number|null, code?:string,
 *                marketDragonRank?:number, marketDragonLabel?:string}>} items
 * @param {number} [topN] 打标只数，缺省 5
 * @returns {number} 实际打标只数（可能 < topN：有值的行不足）
 */
export function assignMarketDragonRanks(items, topN) {
  const raw = (topN === null || topN === undefined) ? MARKET_DRAGON_TOP_N : Number(topN);
  const cap = (isFinite(raw) && raw > 0) ? Math.floor(raw) : MARKET_DRAGON_TOP_N;
  let rank = 0;
  const list = items || [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    const v = it.rangePct30;
    // §10：没有值 ⇒ 不参与名次（既不占位、也不补 0），且显式清零。
    // 非主板同理：仍按 30 日涨幅待在列表原位（排序未变），但「市龙一~五」的名额只数主板。
    // ⚠️ 代码缺失 = 未知板块 ⇒ 有资格（§10：判不出 ≠ 判出非主板）。
    if (rank >= cap || v === null || v === undefined || isNaN(v) || !isMainBoardRankEligible(it.code)) {
      it.marketDragonRank = 0;
      it.marketDragonLabel = '';
      continue;
    }
    rank += 1;
    it.marketDragonRank = rank;
    it.marketDragonLabel = marketDragonLabel(rank);
  }
  return rank;
}
