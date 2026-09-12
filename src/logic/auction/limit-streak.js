// limit-streak.js — 「趋势 / 首板 / 二板 / 三板…」连板状态判定（Logic 层 §15 独立业务模块，纯函数无副作用）
//
// 业务口径（2026-09-11 定，用户需求「早上看盘就知道这只票是趋势还是连板」）：
//   只看【当前看板日 T 之前】的历史交易日（T-1, T-2, … T-9），**刻意排除当天 T** ——
//   当天早盘行情还没走完（change_pct 还是 9:25 竞价副本），拿它判连板没有参考意义。
//   从最近的历史交易日 T-1 起向过去数「连续收盘涨停」天数：
//     streak = 0 → 「趋势」（最近历史日不是涨停）
//     streak = 1 → 「首板」
//     streak = 2 → 「二板」
//     streak = 3 → 「三板」…… 依次类推（>10 用阿拉伯数字，不生造汉字）
//
//   涨停判定【复用收盘停板口径】getCloseLimitState（limit-up.js）：
//     同一份涨停幅度表（主板 10% / ST 5% / 创业科创 20% / 北交所 30%）+ 同一份 EPS 容差。
//     绝不另写一份阈值逻辑（§6 单一真相）—— 否则「停板蚂蚁线」与「连板标记」会在
//     9.88% / 10.02% 这类四舍五入边界上互相打架（同一根 K 线两种结论）。
//
// 数据来源：内存里已存的逐日 change_pct。首屏 auction-pull-window 已把最近 30 个自然日整段
//   拉进内存（与 dragon-rank._assembleRangeFromMemory 同款读法），因此本模块【0 网络请求、0 额度】。
//
// 纯函数红线：不读 state、不发请求、不碰 DOM、不写库。

import { getCloseLimitState, parseAucPct } from './limit-up.js';

/** 回看的历史交易日根数（T-1 … T-9，不含当天 T）——与 10 日区间窗口 [T-9,T] 去掉 T 后天然重合 */
export const STREAK_LOOKBACK_DAYS = 9;

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 连板档位文案。
 * @param {number} streak 连续收盘涨停天数（0 = 无连板）
 * @returns {string} '趋势' | '首板' | '二板' | '三板' | … '十板' | '11板'
 */
export function getStreakLabel(streak) {
    const n = Math.floor(Number(streak) || 0);
    if (n <= 0) return '趋势';
    if (n === 1) return '首板';
    if (n <= 10) return CN_NUM[n] + '板';
    return n + '板';
}

/** 数值化：number 原样（非有限数 → null），字符串走 parseAucPct，其余 → null（绝不用 0 顶替） */
function _toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v === null || v === undefined || v === '') return null;
    return parseAucPct(v);
}

/**
 * 数「连续收盘涨停」天数：从 descPcts[0]（最近的历史交易日 T-1）向过去数。
 * @param {Array<*>} descPcts 降序历史日收盘涨幅 [T-1, T-2, …]，元素可为 number / '+9.98%' / null
 * @param {string} [code] 6 位代码（涨停幅度判定用；缺省按主板 10% 兜底）
 * @param {string} [name] 股票名（ST 判定用）
 * @returns {{streak:number, label:string}|null}
 *          null = 最近的历史交易日【没有可用涨幅数据】→ 无从判定，调用方必须据此【不出标记】
 *                 （§10：绝不把「没数据」猜成「趋势」）
 */
export function computeStreak(descPcts, code, name) {
    if (!Array.isArray(descPcts) || descPcts.length === 0) return null;
    const nums = descPcts.map(_toNum);
    // 最近的历史日（T-1）没有涨幅 → 不判定（宁可不出标记，也不猜成「趋势」）
    if (nums[0] === null) return null;
    let streak = 0;
    for (let i = 0; i < nums.length; i++) {
        // 中间某日缺数据 → 连板链在此断开（不能跨过缺口继续数）
        if (nums[i] === null) break;
        if (getCloseLimitState(nums[i], code, name) !== 'up') break;
        streak++;
    }
    return { streak: streak, label: getStreakLabel(streak) };
}

/** 取行内收盘涨幅（兼容 snake_case / camelCase 两种别名），取不到 → null */
function _closePctOf(row) {
    if (!row) return null;
    const a = row.changePct;
    if (a !== undefined && a !== null && a !== '') return a;
    const b = row.change_pct;
    if (b !== undefined && b !== null && b !== '') return b;
    return null;
}

/**
 * 组装「股票名 → 连板状态」映射（供题材模式逐行读取，0 网络请求）。
 *
 * ⚠️ 名单基准 = 最近历史交易日 T-1 当天【有行】的股票：连 T-1 都没有这一行的票无从判定连板，
 *    直接不出标记（而不是伪造「趋势」）——§10。
 *
 * @param {string[]} descDates 降序历史交易日 ['T-1','T-2',…]（【不含】当天 T）
 * @param {Map<string, Map<string, object>>} rowsByDate date -> (股票名 -> 当日行)
 * @param {function(object, string): string} [codeOf] 取代码函数（缺省用 row.code）
 * @returns {Map<string, {streak:number, label:string}>}
 */
export function buildLimitStreakMap(descDates, rowsByDate, codeOf) {
    const out = new Map();
    if (!Array.isArray(descDates) || descDates.length === 0 || !rowsByDate) return out;
    const newestMap = rowsByDate.get(descDates[0]);
    if (!newestMap) return out;
    newestMap.forEach(function(row, name) {
        if (!name) return;
        const code = codeOf ? (codeOf(row, name) || '') : ((row && row.code) || '');
        const pcts = descDates.map(function(d) {
            const m = rowsByDate.get(d);
            const r = m ? m.get(name) : null;
            return r ? _closePctOf(r) : null;
        });
        const res = computeStreak(pcts, code, name);
        if (res) out.set(name, res);
    });
    return out;
}
