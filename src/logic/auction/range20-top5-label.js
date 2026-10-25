/**
 * range20-top5-label.js — 「20日涨幅」toggle 的【专属显示层】纯函数。
 *
 * ============================================================================
 * 用户口径（2026-10-20，逐字）：
 *   「我希望单独打开 20 日涨幅 toggle，我希望看到排名前五的标上总龙一，总龙二，总龙三，
 *     总龙四，总龙五的标签，其它票不标。就是按 20 日涨幅由高到低标这五只。」
 * ============================================================================
 *
 * 为什么单独建一个模块（而不是塞进 view-helpers 里就地算）：
 *   · 这是【只属于 20 日涨幅 toggle】的一条显示口径，其它 toggle 一律不标（用户明确「其它票不标」）
 *     ⇒ 把判定收在一处，日后要改（改只数 / 改文案 / 换口径）只动这里，⛔ 不会牵动其它模式；
 *   · 纯函数无依赖、可独立单测（§15 / §42），order 语义（缺值置底、不占名次）能被回归锁住。
 *
 * ⚠️ 本模块只做「按当前顺序打名次」，**排序不在这里做**：
 *   顺序由 view-helpers 的 `sortIndicesByRangePct`（range-pct-sort.js）给出 —— 与「十日涨幅」toggle
 *   同一个比较器（三级键：缺数据置底 → pct 降序 → 稳定），§6 单一真相，⛔ 不另写一套比较器。
 *
 * ⚠️ §10 宁缺勿错：没有 20 日涨幅的行（数据未到 / 腿太少算不出）**跳过且不占名次**，
 *   ⛔ 绝不补 0 让它顶上一个「总龙N」。
 */

/** 打标只数上限（用户口径：前五） */
export const RANGE20_TOTAL_DRAGON_TOP_N = 5;

// [MAIN-BOARD-RANK 2026-10-24 用户口径] 「总龙N」只发给主板：非主板（创业板/科创板/北交所）
//   **不占名次**，名次顺延给下一只主板票。判据走 limit-up.js 的唯一实现（§6），⛔ 不手写前缀。
import { isMainBoardRankEligible } from './limit-up.js';

/**
 * 名次文案。顺序即语义：第 1 名 = 总龙一（20 日涨幅第一）。
 * ⚠️ 用「一二三四五」而不是数字，是用户原话的写法（「总龙一，总龙二…」）。
 */
export const TOTAL_DRAGON_LABELS = ['总龙一', '总龙二', '总龙三', '总龙四', '总龙五'];

/**
 * 【纯函数】名次 → 标签文案。越界 ⇒ ''（模板 v-if 直接不渲染，⛔ 不产出「总龙6」这种越界文案）。
 * @param {number} rank 1 起的名次
 * @returns {string}
 */
export function totalDragonLabel(rank) {
  const n = Number(rank);
  if (!isFinite(n) || n < 1 || n > TOTAL_DRAGON_LABELS.length) return '';
  return TOTAL_DRAGON_LABELS[Math.floor(n) - 1];
}

/**
 * 【纯函数】按「items 的当前顺序」给前 N 只打「总龙N」标（就地写字段，返回实际打标只数）。
 *
 * 入参 items 的顺序【必须已经是】20 日涨幅降序（由 view-helpers 保证），本函数不再排序。
 * 对**每一个**非空行都会写这两个字段（模板只渲染字符串，§21 零计算）：
 *   · `totalDragonRank`  : 1..N（0 = 不打标）
 *   · `totalDragonLabel` : '总龙一' / … / ''
 *
 * ★ 为什么「没选中的行也要显式写 0 / ''」而不是留给行对象自己的默认值：
 *   这些行对象进过增量视图缓存复用，只要有一次残留了名次，切 toggle / 换日期后就会
 *   在别的视图里冒出「总龙三」（§11：可选能力必须能保证默认无行为）。
 *   显式清零是结构性的，不依赖三处默认值都写对。
 *
 * @param {Array<{rangePct20:number|null, totalDragonRank?:number, totalDragonLabel?:string}>} items
 * @param {number} [topN] 打标只数，缺省 5
 * @returns {number} 实际打标只数（可能 < topN：有值的行不足）
 */
export function assignTotalDragonRanks(items, topN) {
  const raw = (topN === null || topN === undefined) ? RANGE20_TOTAL_DRAGON_TOP_N : Number(topN);
  const cap = (isFinite(raw) && raw > 0) ? Math.floor(raw) : RANGE20_TOTAL_DRAGON_TOP_N;
  let rank = 0;
  const list = items || [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    const v = it.rangePct20;
    // §10：没有值就不参与名次（既不占位、也不补 0），且显式清零
    // [MAIN-BOARD-RANK 2026-10-24 用户口径] 非主板（创业板/科创板/北交所）同样【跳过且不占名次】：
    //   它们仍按 20 日涨幅待在列表原位（排序未变），但「总龙一~五」的名额只数主板。
    //   ⚠️ 代码缺失 = 未知板块 ⇒ 有资格（§10：判不出 ≠ 判出非主板）。
    if (rank >= cap || v === null || v === undefined || isNaN(v) || !isMainBoardRankEligible(it.code)) {
      it.totalDragonRank = 0;
      it.totalDragonLabel = '';
      continue;
    }
    rank += 1;
    it.totalDragonRank = rank;
    it.totalDragonLabel = totalDragonLabel(rank);
  }
  return rank;
}
