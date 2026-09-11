// range-window.js — 「近 N 个交易日区间涨幅」的窗口口径纯函数（Logic 层 §15 独立业务模块）
//
// 为什么单独成模块：
//   区间涨幅是「龙一/龙二排名」的唯一排序依据，口径一旦混用就会系统性失真（不是个别股票问题）。
//   以下三条规则 + 「组装成行」必须只有一份实现，所有计算路径共用：
//     · worker 早盘 9:25 首算（T 腿=竞价涨幅）→ buildRangeRows
//     · worker 收盘 16:00 重算（T 腿=收盘涨幅）→ buildRangeRows
//     · 前端兜底抓取 / 收盘 T 腿换算 → buildRangeRows / replaceTDayLeg
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
 * 【组装区间涨幅行】「窗口 + 复利 + T 腿」三条规则的唯一实现（worker 早盘 / worker 收盘共用）。
 *
 * 调用方只负责「准备数据」：
 *   · rangeDates  —— 升序交易日 [T-9 ... T]；
 *   · dailyByCode —— code -> { YYYYMMDD: 日涨幅 }，历史日数据（当天由 tLegByCode 覆盖，此处可有可无）；
 *   · tLegByCode  —— code -> 当天(T)腿涨跌幅（9:25 竞价涨幅 / 收盘涨幅，由调用方决定口径）。
 * 本函数只做：逐日取腿 → 复利累乘 → 输出 { stock, code, pct, days }，不读写 state / 不发请求。
 *
 * ⚠️ tLegByCode 缺该股票时，当天那根腿【不参与】累乘（days 会少 1）——调用方应先按
 *    「当天腿是否可得」筛掉目标，否则会算出「不含当天」的残缺区间涨幅。
 *
 * @param {Array<{name:string, code:string}>} targets 参与计算的股票（按 name 去重，先到先得）
 * @param {string[]} rangeDates 升序交易日 ['YYYY-MM-DD', ...]
 * @param {Object} dailyByCode code -> { YYYYMMDD: number }
 * @param {Object} tLegByCode code -> number 当天(T)腿涨跌幅
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>}
 */
export function buildRangeRows(targets, rangeDates, dailyByCode, tLegByCode) {
  const rows = [];
  if (!targets || targets.length === 0 || !rangeDates || rangeDates.length === 0) return rows;
  const tYmd = String(rangeDates[rangeDates.length - 1]).replace(/-/g, '');
  const seen = new Set();
  targets.forEach(function(t) {
    if (!t || !t.code || !t.name) return;
    const name = String(t.name).trim();
    if (!name || seen.has(name)) return;
    const dm = (dailyByCode && dailyByCode[t.code]) || null;
    const legs = [];
    rangeDates.forEach(function(d) {
      const ymd = String(d).replace(/-/g, '');
      let v;
      if (ymd === tYmd) {
        v = tLegByCode ? tLegByCode[t.code] : undefined;
      } else {
        v = dm && Object.prototype.hasOwnProperty.call(dm, ymd) ? dm[ymd] : null;
      }
      if (v === null || v === undefined || !isFinite(v)) return;
      legs.push(Number(v));
    });
    const pct = compoundPct(legs);
    if (pct === null) return; // 一个交易日都没有 → 不写空行（避免前端反复兜底抓取）
    seen.add(name);
    rows.push({ stock: name, code: t.code, pct: pct, days: legs.length });
  });
  return rows;
}

/**
 * 【按日取腿】把「每个交易日一整行数据」映射成组装区间涨幅所需的两张表。
 *
 * 用途（[LOCAL-RECOMPUTE 2026-09-11]）：区间涨幅的历史日数据其实【已经存在库里】
 * （每天一行 market_metrics.change_pct，前端首屏就把最近 30 个自然日拉进内存了）。
 * 所以当云端 stock_range_pct 出现「缺腿行」（days < 窗口长度）时，完全可以用内存里
 * 已存的逐日涨幅【本地重新组装】出完整区间涨幅 —— **0 次猫抓请求**，不消耗额度，
 * 也不受「猫抓当日不给数据 / 额度用尽」的影响。
 *
 * 纯函数：不读 state、不发请求、不碰 DOM（调用方负责把内存数据准备好传进来）。
 *
 * @param {Array<{name:string, code?:string}>} targets 参与计算的股票（按 name 去重，先到先得）
 * @param {string[]} ascDates 升序交易日 ['YYYY-MM-DD', ...]，最后一项必须是 T
 * @param {Map<string, Map<string, object>>} rowsByDate date -> (股票名 -> 当日行)
 * @param {function(object, string): (number|null)} legOf (当日行, 日期) => 该日腿涨幅（%）
 *        口径由调用方决定（单一真相仍是 resolveTDayPct / isAuctionLegActive）
 * @returns {{targets:Array<{name:string, code:string}>, dailyByCode:Object, tLegByCode:Object}}
 *          可直接喂给 buildRangeRows（组装成行的唯一实现）
 */
export function collectDailyLegs(targets, ascDates, rowsByDate, legOf) {
  const dailyByCode = Object.create(null);
  const tLegByCode = Object.create(null);
  const out = [];
  if (!targets || targets.length === 0 || !ascDates || ascDates.length === 0) {
    return { targets: out, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
  }
  const tDate = ascDates[ascDates.length - 1];
  const seen = new Set();
  targets.forEach(function(t) {
    if (!t || !t.name) return;
    const name = String(t.name).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    // 缺 code 的票用「名字键」占位：buildRangeRows 只要求 key 稳定唯一，
    // 有 code 时用 code（与 worker 同键），没 code 也不至于整只票被丢掉。
    const key = t.code ? String(t.code) : ('n:' + name);
    const dm = Object.create(null);
    ascDates.forEach(function(d) {
      const row = rowsByDate && rowsByDate.get(d) ? rowsByDate.get(d).get(name) : null;
      if (!row) return;
      const v = legOf ? legOf(row, d) : null;
      if (v === null || v === undefined || !isFinite(v)) return;
      if (d === tDate) tLegByCode[key] = Number(v);
      else dm[String(d).replace(/-/g, '')] = Number(v);
    });
    dailyByCode[key] = dm;
    out.push({ name: name, code: key });
  });
  return { targets: out, dailyByCode: dailyByCode, tLegByCode: tLegByCode };
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
