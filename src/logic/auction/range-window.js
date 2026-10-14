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
//          ⚠️ [T-LEG-FALLBACK 2026-09-14] 当日【竞价涨幅字段缺失】时退回「当日行内涨幅」(change_pct)，
//             绝不因此把 T 腿整根丢掉。缘由：9:25 之后 change_pct 写的就是当天的竞价副本
//             （worker P0 写入的 auc_pct_chg 值），盘中/收盘后则是当日实时/收盘涨幅 —— 两种都
//             比「缺一根腿、days=窗口-1 的系统性偏低值」更接近真值；丢掉 T 腿才是真正的错。
//             （实测 2026-09-14：market_metrics 当日 auc_pct_chg 全空，导致 46 行区间涨幅
//               days=9 = 只累到昨天，看板把「旧窗口」当成今天的十日涨幅。）
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
  if (isToday && !afterClose) {
    // [T-LEG-FALLBACK 2026-09-14] 竞价腿优先；缺失时退回当日行内涨幅 —— 见文件头 ③ 的说明。
    // 区分「竞价腿确实缺失」与「竞价腿真的是 0%」：a===null 才算缺失，0 是合法涨幅且优先。
    return a !== null ? a : c;
  }
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

/**
 * ★★ [TVRB-926 2026-10-14 用户口径] 【反解 T 腿】—— 把「已换成收盘腿的区间涨幅」还原成
 *    「T 腿 = 竞价涨幅」那一份（= 9:26 口径，用户要的「早上那一份」）。
 *
 * 用户原话：
 *   「题材量比看板选股买点侧，为什么早上的，和收盘的不一样，我只想要早上 9 点 26 分的……
 *     可能收盘后，涨幅覆盖了，又重新计算……因为我对照历史日期的时候就对不上，
 *     比如今天我明明买了某只股票，过些时间我再翻开那个时期，又成另外一只股票，非常不合理。」
 *
 * 为什么能反解（与 replaceTDayLeg 是【一对互逆运算】，故两处必须放在同一模块，§6）：
 *   正向：stored = (1 + old926) ÷ (1 + auc) × (1 + close) − 1
 *   反解：old926 = (1 + stored) ÷ (1 + close) × (1 + auc) − 1
 *   两个因子（竞价涨幅 / 收盘涨幅）都由 `market_metrics(scope='auction')` 的
 *   `auc_pct_chg` / `change_pct` 提供 —— 都是已落库的客观数据，**0 额外上游请求、0 额度**。
 *
 * ⚠️ 与「换腿」对称的三个前提（缺一不可，缺则【原样返回】，⛔ 绝不猜 —— §10）：
 *   ① `closePct`（收盘腿）读不到 ⇒ 无法判断这一行到底换过腿没有 ⇒ 原样；
 *   ② `aucPct`（竞价腿）读不到 ⇒ 无法还原那根腿（典型 = 那天整批 `auc_pct_chg` 缺失、
 *      9:25 的 T 腿走的是 `change_pct` 回退通道）⇒ 原样（拿 0 顶替会把整根腿凭空抹掉，更错）；
 *   ③ `closePct === -100` ⇒ 复利因子为 0，反解无意义 ⇒ 原样。
 *   ⚠️ 调用方还须【先确认这一行已是收盘口径】再调本函数（时间判定见 closeCoverUtcMs）；
 *      不是收盘口径的行，其原值本来就是 9:26 口径，调进来也只是恒等变换（见下面 ②③ 的注释）。
 *
 * @param {*} rangePct 库里已存的区间涨幅（%，可能已是收盘腿口径）
 * @param {*} aucPct   该股【当日竞价涨幅】（%，= 9:25 那根 T 腿；null ⇒ 不换算）
 * @param {*} closePct 该股【当日收盘涨幅】（%，= 现在那根 T 腿；null ⇒ 不换算）
 * @returns {number|null} 9:26 口径的区间涨幅（%）；缺数据 ⇒ 原值 / null（⛔ 绝不伪造 0）
 */
export function recoverAuctionLeg(rangePct, aucPct, closePct) {
  const r = parsePct(rangePct);
  if (r === null) return null;
  const c = parsePct(closePct);
  if (c === null) return r;                      // ① 不知道换没换腿 ⇒ 原样
  const a = parsePct(aucPct);
  if (a === null) return r;                      // ② 竞价腿读不到 ⇒ 原样（见函数头）
  const closeFactor = 1 + c / 100;
  if (closeFactor === 0) return r;               // ③ 无法反解 ⇒ 原样
  // 先退回「除当天以外的 9 天复利」，再乘上竞价那根腿 —— 与 replaceTDayLeg 逐字对称
  const prevAcc = (1 + r / 100) / closeFactor;
  const next = (prevAcc * (1 + a / 100) - 1) * 100;
  return isFinite(next) ? next : r;
}

/** 北京时间收盘时刻（用于判定某行是否已按收盘口径写入，与 close-pct-cover 同源） */
export const CLOSE_COVER_HOUR_BJ = 15;

/**
 * 某个日期「收盘覆盖时刻」对应的 UTC 时间戳（北京 15:00）。
 *
 * ⚠️ 这是「这一行是竞价腿口径还是收盘腿口径」的**唯一时间尺子**，两个消费者共用：
 *   · `close-pct-cover.js#_runCover`（决定要不要把 T 腿换成收盘腿）；
 *   · `range-auction-leg.js`（决定要不要把 T 腿反解回竞价腿）。
 *   §6：⛔ 绝不各写一份 —— 两处若分叉就会出现「换了腿却不反解」的静默错值。
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {number} UTC 毫秒；日期非法 ⇒ NaN
 */
export function closeCoverUtcMs(dateStr) {
  if (!dateStr) return NaN;
  const base = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(base)) return NaN;
  return base + (CLOSE_COVER_HOUR_BJ - 8) * 3600000;
}
