// range-display.js — 【跨看板共享】十日涨幅的展示口径（Logic 纯函数叶子，§15 / §6 单一真相）
//
// 为什么要有这个模块：
//   「涨跌停」看板与「竞价一字」看板都要在行内显示十日涨幅，且颜色/缺腿标注必须完全一致 ——
//   否则同一只票在两个看板会显示成两个样子（`+12.34%` vs `+12.34%(7/10日)`）。
//   所以这套「文本 + 涨跌方向」只有一份实现，两个看板共用。
//
// 纯函数红线：不读 state、不发请求、不碰 DOM、不写库。

import { RANGE_WINDOW_DAYS } from './range-window.js';

/**
 * 十日涨幅展示文本（唯一口径）。
 *   · 无数据 → '-'（⛔ 禁止补 0：0% 是一个真实涨幅）
 *   · 满窗   → '+12.34%'
 *   · 缺腿   → '+12.34%(7/10日)'（与早盘竞价看板同一约定，明示「这只票窗口不全」）
 * @param {number|null} pct
 * @param {number} days
 * @param {number} [windowDays]
 * @returns {string}
 */
export function formatRangePct(pct, days, windowDays) {
    const win = windowDays || RANGE_WINDOW_DAYS;
    if (pct === null || pct === undefined || !isFinite(pct)) return '-';
    const txt = (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%';
    const d = isFinite(days) ? Number(days) : 0;
    if (d > 0 && d < win) return txt + '(' + d + '/' + win + '日)';
    return txt;
}

/**
 * 十日涨幅涨跌方向（用于配色：涨红跌绿，与项目约定一致）。
 * @param {number|null} pct
 * @returns {'up'|'down'|'flat'}
 */
export function rangeTone(pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return 'flat';
    if (pct > 0) return 'up';
    if (pct < 0) return 'down';
    return 'flat';
}
