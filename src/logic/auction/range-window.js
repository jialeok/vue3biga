// range-window.js — 「近 N 个交易日区间涨幅」的窗口口径纯函数（Logic 层 §15 独立业务模块）
//
// 为什么单独成模块：
//   区间涨幅是「龙一/龙二排名」的唯一排序依据，口径一旦混用就会系统性失真（不是个别股票问题）。
//   以下三条规则必须只有一份实现，所有计算路径（主通道 / 同花顺兜底 / 缺口补齐）共用：
//
//   ① 窗口 = [T-9, T] 共 10 个交易日（含当天 T）；
//   ② 区间涨幅 = 窗口内各日涨幅【复利累乘】∏(1+r) - 1（不是简单相加）；
//   ③ 当天(T)腿口径：
//        - 仅当「看板日期 = 系统今天」且「未到 15:00 收盘」→ 用 9:25 竞价涨幅占位（当日尚未走完）；
//        - 其余情况（今天已收盘 / 历史日期）→ 一律用当日【收盘涨幅】。
//      ⚠️ 历史日期若误用竞价涨幅，等于把「已经完整走完的一天」当成只走了竞价，区间涨幅与龙一
//         排名会系统性偏低；而且 stock_range_pct 是按【日期级】复用的——同一天不同股票的腿口径
//         混杂后，排名就不可比了。
//
// 纯函数红线：不读 state、不发请求、不碰 DOM、不写库。

export const RANGE_WINDOW_DAYS = 10;

/**
 * 标准化涨幅值：接受 number / '2.34%' / '+2.34%' / '-7.71%' / '' / null。
 * 无法解析时返回 null（绝不返回 0 —— 0 是一个真实涨幅，不能拿来表示「没有数据」）。
 * @param {*} raw
 * @returns {number|null}
 */
export function parsePct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return isFinite(n) ? n : null;
}

/**
 * 复利累乘：日涨幅数组 → 区间涨幅(%)。
 * @param {number[]} pctList
 * @returns {number|null} 空数组返回 null（不伪造 0）
 */
export function compoundPct(pctList) {
  if (!pctList || pctList.length === 0) return null;
  let acc = 1;
  for (const p of pctList) {
    if (p === null || p === undefined || isNaN(p)) continue;
    acc *= (1 + p / 100);
  }
  return (acc - 1) * 100;
}

/**
 * 当天(T)腿是否为「竞价占位」口径。
 * @param {string} date - 看板日期 YYYY-MM-DD
 * @param {string} sysToday - 系统今天 YYYY-MM-DD
 * @param {boolean} afterClose - 是否已过 15:00（北京）
 * @returns {boolean}
 */
export function isAuctionLegActive(date, sysToday, afterClose) {
  return !!date && date === sysToday && !afterClose;
}

/**
 * 解析「当天(T)腿」涨幅 —— 口径单一真相。
 * @param {boolean} isToday - 看板日期是否就是系统今天
 * @param {boolean} afterClose - 是否已过 15:00（北京）
 * @param {*} closePct - 当日收盘涨幅（日线源 / 行内常规涨幅）
 * @param {*} aucPct - 当日 9:25 竞价涨幅
 * @returns {number|null}
 */
export function resolveTDayPct(isToday, afterClose, closePct, aucPct) {
  const c = parsePct(closePct);
  const a = parsePct(aucPct);
  if (isToday && !afterClose) return a; // 今天未收盘：只有竞价涨幅可用
  return c !== null ? c : a;            // 已收盘/历史：收盘优先，取不到才退回竞价
}

/**
 * 【替换当天(T)腿】已知「用旧 T 腿算出的区间涨幅」，求「换成新 T 腿后的区间涨幅」。
 *
 * 用途（方案A）：9:25 worker 用【竞价涨幅】做 T 腿把区间涨幅算好并落库；
 * 收盘后 T 腿应改成【收盘涨幅】—— 区间涨幅是复利累乘，只需把 T 腿那一项换掉，
 * 无需重新拉 9 天历史日线（0 额外请求）。
 *
 *   区间涨幅 = ∏(1+r) - 1 = prevAcc × (1 + tLeg) - 1
 *   prevAcc        = (1 + rangePct) ÷ (1 + oldLeg)     ← 去掉旧 T 腿（oldLeg=0 时因数即 1）
 *   新区间涨幅      = prevAcc × (1 + newLeg) - 1
 *
 * @param {*} rangePct 已存的区间涨幅（%）
 * @param {*} oldLeg 旧的 T 腿涨幅（%）；null/0 表示当时不含 T 腿（等价于因数 1）
 * @param {*} newLeg 新的 T 腿涨幅（%）
 * @returns {number|null} 新区间涨幅（%）；任一必需入参不可用 → null（绝不伪造 0）
 */
export function replaceTDayLeg(rangePct, oldLeg, newLeg) {
  const r = parsePct(rangePct);
  const n = parsePct(newLeg);
  if (r === null || n === null) return null;
  const o = parsePct(oldLeg);
  const oldFactor = 1 + (o === null ? 0 : o) / 100;
  if (oldFactor === 0) return null; // 旧腿 -100%（理论不可能）→ 无法反解，放弃而不是给错值
  const prevAcc = (1 + r / 100) / oldFactor;
  const next = (prevAcc * (1 + n / 100) - 1) * 100;
  return isFinite(next) ? next : null;
}
