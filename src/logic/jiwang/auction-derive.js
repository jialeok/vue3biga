// auction-derive.js — 「竞价变化看板 最近多板% 的 9:20 / 9:25」→ 过程结果 + 得出结论
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-23 原话）：
//   「过程结果那里，看竞价变化看板 9 点 25 分列的对应最近多板%数值，
//     数值大于 0，结果为正，数值小于 0，结果为负，
//     结果为正，得出结论那里，选出手，结果为负，结果那里选空仓」
//   「昨多板K线第一次出现中阳时，当天过程判断，竞价变化看板的最近多板%行的
//     9 点 25 分的数值，大于 9 点 20 分数值，那就是过程递增，得出结论那里，就写出手。
//     如果……9 点 25 分的数值，小于 9 点 20 分数值，得出结论那里，就写空仓。」
//   （用户对「9:25 与 9:20 完全相等」的答复：「算递增 → 出手」）
//
// ⇒ 两条分支，**按「观察」选，不是按「是否首次中阳」选**：
//   ┌────────────────────┬──────────────────────┬──────────┐
//   │ 观察                │ 过程结果              │ 得出结论  │
//   ├────────────────────┼──────────────────────┼──────────┤
//   │ 最近多板过程         │ 9:25 ≥ 9:20 → 过程递增 │ 出手      │
//   │                    │ 9:25 < 9:20 → 过程递减 │ 空仓      │
//   │ 最近多板结果         │ 9:25 > 0 → 结果为正    │ 出手      │
//   │                    │ 9:25 < 0 → 结果为负    │ 空仓      │
//   └────────────────────┴──────────────────────┴──────────┘
//
// ⚠️ 为什么分支依据是「观察」而不是「首次中阳」：
//   用户只在「首次中阳」这个场景讲明了 9:25 vs 9:20，但【小阳·前面不足2根】同样判「过程」。
//   而「过程」这个观察在下拉里只允许 过程递增 / 过程递减（见 JiwangBoard.vue#getGuochengOptionsByGuancha）
//   ⇒ 只要观察是「过程」，就必须走盘中方向分支，否则会产生「观察=过程 + 过程结果=结果为正」
//     这种下拉里根本不存在的非法组合。首次中阳只是「观察=过程」的一种情形。
//
// ⛔ 纯函数：不读 Supabase、不碰 Vue。数据由调用方（composable / 组件）注入。
// ══════════════════════════════════════════════════════════════════════════════════════

export const GUOCHENG_UP = '过程递增';
export const GUOCHENG_DOWN = '过程递减';
export const GUOCHENG_POSITIVE = '结果为正';
export const GUOCHENG_NEGATIVE = '结果为负';

export const JIELUN_ACT = '出手';
export const JIELUN_EMPTY = '空仓';

/**
 * 百分比字符串 → 数值。空 / 非数字 ⇒ null（⛔ 不返回 0，§10 不拿 0 冒充「涨跌持平」）
 * @param {string|number} raw
 * @returns {number|null}
 */
export function toPct(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace('%', '').replace('+', '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 由 9:20 / 9:25 两列推出「过程结果」+「得出结论」。
 *
 * @param {{
 *   time920?: string|number,
 *   time925?: string|number,
 *   byAuctionTrend?: boolean
 * }} opts
 *   byAuctionTrend = 观察是否为「最近多板过程」：
 *     true  → 走 9:25 vs 9:20 的盘中方向分支（过程递增 / 过程递减）
 *     false → 走 9:25 vs 0 的正负分支（结果为正 / 结果为负）
 * @returns {{guochengJieguo:string, jielun:string}|null}
 *          数据不足 / 9:25 恰好为 0（正负都不成立）⇒ null（⛔ 不猜）
 */
export function deriveGuochengAndJielun(opts) {
  const o = opts || {};
  const t925 = toPct(o.time925);

  // 分支一：观察 = 最近多板过程 ⇒ 看 9:25 相对 9:20 的方向；相等按递增处理（用户口径）
  if (o.byAuctionTrend) {
    const t920 = toPct(o.time920);
    if (t925 === null || t920 === null) return null;
    const up = t925 >= t920;
    return {
      guochengJieguo: up ? GUOCHENG_UP : GUOCHENG_DOWN,
      jielun: up ? JIELUN_ACT : JIELUN_EMPTY
    };
  }

  // 分支二：观察 = 最近多板结果 ⇒ 看 9:25 相对 0 的正负
  if (t925 === null) return null;
  if (t925 > 0) return { guochengJieguo: GUOCHENG_POSITIVE, jielun: JIELUN_ACT };
  if (t925 < 0) return { guochengJieguo: GUOCHENG_NEGATIVE, jielun: JIELUN_EMPTY };
  return null;   // 恰好 0：既不算正也不算负，留空给人工判断
}
