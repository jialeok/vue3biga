// range20.js — 「20日涨幅」toggle 的数据层唯一实现（Logic 层，§15 独立业务模块）
//
// ===== 产品口径（2026-10-19 用户原话）=====
//   「名称换成20日涨幅……我打开这个toggle时，就会按照20日涨幅，由高到低排序。和十日涨幅toggle类似，
//    只是时间段涨幅不一样……这个20日涨幅你要算清楚（停牌也算，比如新华传媒停牌三天，每天涨幅是0%，
//    不涨也不跌，按照时间段也算进去，因为就给20天这个时间段），最新的时间点算到当天的竞价涨幅，
//    比如今天的，只算到竞价涨幅，昨天的或者历史的算到收盘。包括今天在内，算20天的。
//    ……记住用今天的竞价涨幅，而不是今天收盘涨幅。」
//
// ⇒ 三条硬口径：
//   ① 窗口 = 【含今天在内】的 20 个交易日（[T-19, T]）；
//   ② 复利累乘（与 range-window.js#compoundPct 同一实现，⛔ 不另写一套）；
//   ③ T 腿：展示日 === 本地今天 ⇒ **竞价涨幅**优先；历史日 ⇒ 收盘涨幅优先。
//
// ===== 与「十日涨幅」的关键差异（⛔ 别照抄它）=====
//   · 十日涨幅的 T 腿走 `range-window.js#resolveTDayPct`（15:00 后自动切收盘）；
//     本模块**刻意不切**：用户口径是「等收盘没我什么事了」，20 日这个数是给 9:25 决策用的参考，
//     收盘后再跳一次会让人对不上早上看到的名次。⇒ 见 resolveT20Leg 的注释。
//   · 十日涨幅直接读云端 `stock_range_pct`（worker 已经算好、覆盖当天名单）；
//     但**表里没有 20 日行**，且主键是 `(date, stock)` —— 20 日行若 upsert 会把当天的 10 日行
//     整行覆盖掉（十日涨幅 / 龙位 / 决策看板全线被污染）。⇒ **⛔ 本模块绝不写库**，
//     只在【会话内存】里缓存（按 date 键控），刷新页面重算。
//
// ===== 取数（用户 2026-10-19 定的口径，⛔ 不消耗猫抓额度）=====
//   阶段① 库内数据（0 请求 / 0 额度）：逐日行来自内存（`auction_watchlist` + `market_metrics` 合并，
//          见 auction-pull-window.js）。**立刻发布**，此时只作"占位近似值"（行上显示「n/20日」）。
//   阶段② 同花顺 K 线（免费额度、无每日次数限制）：**所有票都跑一遍**，用真收盘涨幅
//          【覆盖】阶段① 的历史日腿，再发布一次。猫抓 `daily`（每日 10 次额度）**完全不用**。
//
//   🔴 为什么必须覆盖（2026-10-19 事故，⛔ 别改回"只补缺"）：
//      `auction_watchlist.change_pct` 在早盘竞价时写入的是【竞价涨幅】，收盘后才被收盘涨幅覆盖；
//      没被覆盖的历史行就永久留下竞价值，而且该表只收录当天正式名单里的票 ⇒ 大量历史日缺行。
//      实测澳弘电子 20 日窗口：库内复算 59.30%，K 线复算 117.38%（用户用其它软件核对 = 117.4%）。
//      ⇒ 历史日唯一真相 = 同花顺日线（前复权，日间比值 = 真实收盘涨跌幅）。
//      ⚠️ 唯一例外 = T 日腿（今天）：用户口径是竞价涨幅，K 线的"今天收盘"⛔ 不许覆盖它。
//
// ===== 停牌怎么算（用户举例：新华传媒停牌三天，每天 0%）=====
//   停牌日没有成交 ⇒ 该日没有日涨幅腿。复利里 `×(1+0%)` 是**恒等变换**，
//   所以「跳过停牌日」与「按 0% 计入」得到的区间涨幅**数值完全一致**；
//   差别只体现在 `days` 上（停 3 天 ⇒ 17/20），行悬停提示会如实标出「n/20日」。
//   ⛔ 绝不给缺失的腿补 0 参与"有数据/没数据"的判定（§10：读取失败 ≠ 0%）。
//   唯一例外是「整段 20 天一根腿都没有」⇒ pct = null ⇒ 置底且不显示数值（不猜）。

import { ref } from 'vue';
import { state } from '../app-state.js';
import { getAuctionData } from '../app-core-api.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { compoundPct, parsePct, closeCoverUtcMs } from './range-window.js';
import { getDragonWindowDates } from './dragon-rank.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
// [R20-CLOUD 2026-10-20] 结果表读写（加速层：读失败降级为纯内存计算，⛔ 不影响正确性）
import { readRange20Rows, pickUsableRows, upsertRange20Rows } from '../../data/stock-range20-cache.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 窗口长度：含今天在内的 20 个交易日（用户口径「包括今天在内，算20天的」） */
export const RANGE20_WINDOW_DAYS = 20;

/**
 * [RANGE20 2026-10-19] 取数探针长度 = 45 个「App 日历交易日」。
 *
 * ★ 为什么不是 20（血泪，别"顺手改回 20"）：
 *   ① 本项目的交易日历 = `isTradingDay` = 「非周末 ∧ 不在 allData.holidays 里」，
 *      而 **云端 owner.data.holidays 目前是空数组**（实测 2026-10-19）⇒ 国庆/中秋这类
 *      工作日假期会被当成交易日。20 日窗口里就混进了 6 个假交易日：
 *      2026-09-25、10-01、10-02、10-05、10-06、10-07（同花顺 K 线里根本没有这几天）。
 *   ② [R20-PERSTOCK-WIN] 窗口现在是**按每只票自己的 N 个交易日**算（见 compound20）⇒
 *      停牌票要往前多回溯几天才凑得满 20 根（实测新华传媒停牌 10 天 ⇒ 需要 ~30 个真实交易日）。
 *      ⇒ 只取 20 或 30 个槽位，停牌票就永远凑不满，用户对不上炒股软件。
 *   ⇒ 解法：向后多要，拿到 K 线后用【真实有成交的日期】重建序列（见 pickRealWindowDates），
 *     再让每只票各自取最近 20 个有腿日 ⇒ 无论假期表修没修、票停没停牌都正确。
 */
export const RANGE20_PROBE_DAYS = 45;

/** 收盘涨幅候选键（云端/内存行为 snake_case；本地手工行可能是 camelCase） */
const CLOSE_KEYS = ['changePct', 'change_pct'];
/** 竞价涨幅候选键（专用字段，⛔ 绝不用 changePct 代替 —— 它会被收盘覆盖改写成收盘涨幅） */
const AUC_KEYS = ['auc_pct_chg', 'aucPctChg'];

// ===== 状态（模块级 ref，§7：不进 Pinia，与 dragonState / suspendState 同款 ref-driven 范式）=====
// map: Map<股票名, { pct:number, days:number }>
// version：发布一次自增一次（供 incremental-view 的行缓存指纹）
const _state = ref({ date: '', map: new Map(), version: 0 });
/** 已发布结果的内容签名（date -> string）：防止「内容没变却重复发布」把行缓存整表刷掉（§17/§36） */
const _sig = new Map();
/**
 * 🔴 date -> 该日已发布的【最高阶段】（1 = 只用库内逐日行；2 = 已合并同花顺 K 线）。
 *
 * 为什么必须有它（2026-10-19 实测事故，别删）：
 *   `useAuctionBoard` 的取数 watch 依赖 `viewData.items.length`，看板加载过程中行数会变好几次
 *   （实测 6 → 41）⇒ `ensureRange20` 被连续调用多次。阶段② 只有在第一次调用时才跑（`_klineTried`
 *   登记后不再请求），但【后续每次调用都会跑阶段①】——阶段① 只有库内腿（14 天），
 *   它一发布就把阶段② 刚算好的「满窗 20 天」覆盖回去，而且因为 K 线已登记为 tried，
 *   再也不会重算 ⇒ 屏幕上永远停在 14/20（实测 token 一路涨到 v8、days 分布却与阶段① 一模一样）。
 *   ⇒ 阶段① 【绝不能覆盖】已合并过的日期。
 */
const _stage = new Map();
/**
 * date -> 该日【已发布过的最好一份结果】（rows 数组）。
 * 用途：切日期 A→B→A 时，`_state` 里只剩 B 的 Map，而 A 的 K 线已登记 tried 不会再请求
 * ⇒ 没有这份缓存就只能退回「库内腿」，用户会看到数值突然变差。切回时直接用缓存复原。
 */
const _cache = new Map();
/** 同花顺补算「已经跑过的票」（date -> Set<股票名>）：同一会话同一票不重复请求（§32） */
const _klineTried = new Map();
/**
 * date -> (股票名 -> (YYYYMMDD -> 日涨幅%))：**跨轮累积**的 K 线腿。
 * 🔴 为什么不能只用当轮的 `extra`：上游偶发截断/熔断时一轮只成功一部分，
 *   失败票会在下一轮重试；若第二轮只拿「当轮 extra」去 merge，就会把第一轮已补好的票丢掉
 *   （baseLegs 里已经没有它们的历史腿了）⇒ 数值反而退回残缺。必须累积。
 */
const _klineAcc = new Map();
/**
 * date -> 已发布结果所用的【T 腿口径模式】（'auc' | 'close'）。
 *
 * 🔴 [FIX 2026-10-19 · R20-TSWITCH] 为什么必须有它：
 *   T 腿现在随 15:00 换腿（盘中竞价 / 收盘后收盘）。跨过 15:00 后必须**重算一次**，
 *   否则屏幕会一直停在早上那份「前19天收盘 × 今天竞价」的数（= 用户第二次反馈的现象）。
 *   ⛔ 不能靠 `_klineTried` 的失败重试碰运气 —— 早盘请求成功的票全被登记为 tried，
 *      收盘后一次都不会重跑。判据必须是「口径变了」，且只在口径真正变化时清一次登记，
 *      否则每次 ensureRange20 都清空 ⇒ 无限重复请求。
 */
const _legMode = new Map();
/** date -> timerId：收盘后自动重算的一次性定时器 */
const _closeTimer = new Map();
/** 单飞：`<date>|base` / `<date>|kline` -> Promise */
const _inflight = new Map();

/** 当前已发布的 20 日涨幅（仅当 date 匹配时有效，否则 null —— 切日期那帧必须视为「没有数据」） */
export function getRange20Pct(date) {
  const s = _state.value;
  if (!date || s.date !== date) return null;
  return s.map;
}

/** 增量渲染指纹令牌（异步到货必须让行缓存整体失效，否则数值/顺序陈旧） */
export function getRange20FingerprintToken() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + s.map.size;
}

/** 清空会话缓存（仅供测试 / 换数据源时调用） */
export function clearRange20() {
  _sig.clear();
  _klineTried.clear();
  _klineAcc.clear();
  _inflight.clear();
  _stage.clear();
  _cache.clear();
  _legMode.clear();
  _realDatesAcc.clear();
  _lastRows.clear();
  _closeTimer.forEach(function(t) { try { clearTimeout(t); } catch (e) { /* 忽略 */ } });
  _closeTimer.clear();
  _state.value = { date: '', map: new Map(), version: _state.value.version + 1 };
}

/**
 * 窗口日期：升序 [T-19 ... T]。
 * 复用 dragon-rank 的交易日回溯实现（§6 单一真相，⛔ 不在这里另写一份日历循环）。
 * @param {string} date 展示日 T
 * @param {number} [days] 槽位数（App 日历口径），缺省 = RANGE20_WINDOW_DAYS
 * @returns {string[]} 升序日期数组（日历不足时长度 < days）
 */
export function getRange20WindowDates(date, days) {
  const n = (days === null || days === undefined) ? RANGE20_WINDOW_DAYS : Number(days);
  const len = (isFinite(n) && n >= 1) ? Math.floor(n) : RANGE20_WINDOW_DAYS;
  return getDragonWindowDates(date, len).slice().reverse();
}

/**
 * 【纯函数】从「已合并的真实腿」里挑出【真实存在的交易日】，取最后 N 个作为最终窗口。
 *
 * ★ [RANGE20 2026-10-19] 为什么必须有这一步：App 日历可能把工作日假期当交易日
 *   （云端 holidays 为空数组时就是如此，见 RANGE20_PROBE_DAYS 的说明）。判据 = 「这一天
 *   有任何一只票拿到涨幅腿」⇒ 上游有成交 ⇒ 是真交易日。全市场 41 只票都拿不到的日期，
 *   只可能是非交易日（或全市场停牌，那也不该算进窗口）。
 * ⚠️ 窗口对【所有票全局一致】——⛔ 绝不按「每只票自己的腿数」各自取窗口，否则各票区间
 *   长度不同、涨幅不可比（stock-range-pct.js 头部同一个坑）。
 *
 * @param {Map<string, Map<string, number>>} legsByStock 股票名 -> (日期 -> 日涨幅%)
 * @param {string[]} probeDates 升序候选日期（App 日历口径）
 * @param {number} n 需要的交易日个数（= RANGE20_WINDOW_DAYS）
 * @returns {string[]} 升序的真实交易日（长度 <= n；真实交易日不足时就是全部）
 */
export function pickRealWindowDates(legsByStock, probeDates, n) {
  const want = (n === null || n === undefined) ? RANGE20_WINDOW_DAYS : Number(n);
  const keepN = (isFinite(want) && want >= 1) ? Math.floor(want) : RANGE20_WINDOW_DAYS;
  if (!probeDates || probeDates.length === 0) return [];
  const inProbe = new Set(probeDates);
  const hit = new Set();
  if (legsByStock) {
    legsByStock.forEach(function(legs) {
      if (!legs) return;
      legs.forEach(function(v, d) {
        if (inProbe.has(d) && v !== null && v !== undefined) hit.add(d);
      });
    });
  }
  // 保持 probeDates 的升序（⛔ 不依赖 Map 遍历顺序）
  const real = probeDates.filter(function(d) { return hit.has(d); });
  return real.slice(-keepN);
}

/** 取某个字段的数值（多键兼容；缺失/非法 → null，⛔ 不返回 0） */
function _numOf(row, keys) {
  if (!row) return null;
  for (let i = 0; i < keys.length; i++) {
    const raw = row[keys[i]];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = parsePct(raw);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 收盘涨幅（历史日腿的唯一口径）。
 * @param {object} row 当日行
 * @returns {number|null}
 */
export function closeLegOf(row) {
  return _numOf(row, CLOSE_KEYS);
}

/**
 * 某日 T 腿的口径模式：`'auc'` = 竞价口径（盘中）／`'close'` = 收盘口径（收盘后、历史日）。
 *
 * 🔴 [FIX 2026-10-19 · R20-TSWITCH] 这是本轮（用户第二次反馈）的**唯一实质改动**。
 *
 *   用户原话（逐字，别再只取一半）：
 *     「第20天也就是当天，早上开盘我看到前面19天加今天竞价涨幅，这是我早上看到的。
 *       收盘后这二十天全部是收盘涨幅计算20天涨幅，这样就和炒股软件对得上。
 *       这个就和那个趋势图覆盖类似。因为早上我需要看，收盘我也需要复盘用。」
 *
 *   ⇒ T 腿必须【随 15:00 换腿】，与十日涨幅 / 趋势图同一套 `resolveTDayPct` 语义。
 *     旧实现恒取竞价（注释还写着"收盘后再跳一次会让人对不上"），
 *     导致收盘后仍显示「前19天收盘 × 今天竞价」，与炒股软件（20 天全收盘）差出一大截：
 *     实测 2026-10-19 澳弘电子 103.06% vs 炒股软件 117.38%、新华传媒 182.47% vs 210.98%。
 *   ✅ 已用同花顺日线独立复算 4 只票的「20 天全收盘」：
 *      新华传媒 210.98 / 新华文轩 116.68 / 澳弘电子 117.38 / 九阳股份 91.89
 *      —— 与用户炒股软件**逐项差 0.00**，证明「全收盘口径」才是他要的对账基准。
 *
 * ⚠️ 时间尺子 = `range-window.js#closeCoverUtcMs`（§6 唯一实现，⛔ 别另写 Date 比较）。
 *
 * @param {boolean} tIsToday 展示日是否就是本地今天
 * @param {boolean} afterClose 该日是否已过北京 15:00
 * @returns {'auc'|'close'}
 */
export function resolveT20LegMode(tIsToday, afterClose) {
  return (tIsToday && !afterClose) ? 'auc' : 'close';
}

/**
 * 某日是否已过收盘覆盖时刻（北京 15:00）。
 * 取不到日期 / 日期非法 ⇒ false（§10 不猜；调用方据此退回「早上竞价口径」= 主用途）。
 * @param {string} date YYYY-MM-DD
 * @param {number} [nowMs] 注入当前时刻（单测用；缺省 = Date.now()）
 * @returns {boolean}
 */
export function isAfterCloseOf(date, nowMs) {
  const closeMs = closeCoverUtcMs(date);
  if (Number.isNaN(closeMs)) return false;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  return now >= closeMs;
}

/**
 * T 腿口径（★ 本模块与十日涨幅的实质差异只体现在**取值优先级**上，⛔ 别"顺手统一"成同一个函数）：
 *   · 展示日 === 本地今天 且 **未过 15:00** → 竞价涨幅优先（缺失才退回收盘涨幅）；
 *   · 展示日 已过 15:00 / 是历史日      → 收盘涨幅优先（缺失才退回竞价涨幅）。
 *
 * 与 `range-window.js#resolveTDayPct` 的区别只是形状（本函数直接从 row 取两个字段），
 * 语义必须**完全一致** —— 改这里先去看那个函数的注释。
 *
 * @param {object} row 展示日当天的行
 * @param {boolean} tIsToday 展示日是否就是本地今天
 * @param {boolean} afterClose 该日是否已过北京 15:00（缺省 false ⇒ 保守按竞价口径 = 早上主用途）
 * @returns {number|null}
 */
export function resolveT20Leg(row, tIsToday, afterClose) {
  const close = _numOf(row, CLOSE_KEYS);
  const auc = _numOf(row, AUC_KEYS);
  if (tIsToday && !afterClose) {
    // 区分「竞价腿确实缺失」与「竞价腿真的是 0%」：auc===null 才算缺失，0 是合法涨幅且优先
    return auc !== null ? auc : close;
  }
  return close !== null ? close : auc;
}

/**
 * 【纯函数】从「逐日行」抽每只票的日涨幅腿。
 *
 * @param {Array<{stock:string}>} targets 目标股票（按名去重，先到先得）
 * @param {string[]} ascDates 升序交易日（最后一个 = 展示日 T）
 * @param {Map<string, Map<string, object>>} rowsByDate 日期 -> (股票名 -> 当日行)
 * @param {{tIsToday?:boolean, afterClose?:boolean, useDbLegsForHistory?:boolean}} [opts]
 *        tIsToday：展示日是否为本地今天（决定 T 腿口径）
 *        afterClose：该日是否已过 15:00（T 腿是否已换成收盘口径，见 resolveT20LegMode）
 *        useDbLegsForHistory：历史日是否采用库内腿（默认 false，见下方 R20-CLOSE-LEG 说明）
 * @returns {Map<string, Map<string, number>>} 股票名 -> (日期 -> 日涨幅%)
 *
 * §10：某天没有该票的行 / 该行没有可用涨幅 → 这根腿【不放进去】（days 会少 1），
 *      绝不补 0 —— 见文件头「停牌怎么算」。
 */
export function legs20FromRows(targets, ascDates, rowsByDate, opts) {
  const out = new Map();
  if (!targets || targets.length === 0 || !ascDates || ascDates.length === 0) return out;
  const tDate = ascDates[ascDates.length - 1];
  const tIsToday = !!(opts && opts.tIsToday);
  const afterClose = !!(opts && opts.afterClose);
  // 🔴 [FIX 2026-10-19 · R20-CLOSE-LEG] 历史日是否采用库内腿。
  //   默认 **false**（= 历史日只认同花顺 K 线）：库内 `change_pct` 可能是早盘写入的竞价涨幅、
  //   且大量历史日缺行（见 merge20Legs 函数头）。§10「宁缺勿错」⇒ 拿不到真收盘就不给数，
  //   ⛔ 绝不拿一个不可信的库内值冒充收盘涨幅（那正是用户反馈「显示 42.7%，实际 117.4%」的根因）。
  //   仅供单测/诊断需要"只看库内"时显式传 true。
  const useDbLegs = !!(opts && opts.useDbLegsForHistory);
  const seen = new Set();
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const name = t && t.stock ? String(t.stock).trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const legs = new Map();
    for (let k = 0; k < ascDates.length; k++) {
      const d = ascDates[k];
      const dayMap = rowsByDate ? rowsByDate.get(d) : null;
      const row = dayMap ? dayMap.get(name) : null;
      const isT = (d === tDate);
      if (!isT && !useDbLegs) continue;      // 历史日：库内值不可信 ⇒ 跳过，等 K 线
      if (!row) continue;
      const v = isT ? resolveT20Leg(row, tIsToday, afterClose) : closeLegOf(row);
      if (v !== null) legs.set(d, v);
    }
    if (legs.size > 0) out.set(name, legs);
  }
  return out;
}

/**
 * 【纯函数】把「同花顺 K 线腿」合并进库内腿。
 *
 * 🔴 [FIX 2026-10-19 · R20-CLOSE-LEG] **历史日必须由 K 线【覆盖】库内值，⛔ 不再是「只补缺」。**
 *
 *   事实（2026-10-19 实测，别再凭"库内更权威"的直觉改回去）：
 *     `auction_watchlist.change_pct` 在【早盘竞价时写入的是竞价涨幅】，收盘后才被收盘涨幅覆盖。
 *     没被覆盖到的历史行就永久留下竞价值；而且该表只收录「当天正式名单」里的票 ⇒ 大量历史日【缺行】。
 *     实测澳弘电子 20 日窗口：watchlist 有 7 天缺行、2 天是早盘值（09-16 存 +0.50% 而真收盘 +10.00%，
 *     09-17 存 +6.02% 而真收盘 +9.99% —— 这两个数恰好等于 `market_metrics.auc_pct_chg`）。
 *     按库内值复算 = 59.30%，按 K 线复算 = 117.38%（用户用其它软件核对 = 117.4%）⇒ **库内口径错了近一倍**。
 *     ⇒ 历史日的唯一真相 = 同花顺日线（前复权，日间比值 = 真实收盘涨跌幅）。
 *
 * ⚠️ **T 日（今天）例外**：用户口径是「今天算竞价涨幅」，由 `resolveT20Leg` 决定，
 *     ⛔ K 线里的「今天收盘」绝不许覆盖它（否则早上算出来的数会变成收盘口径）。
 *
 * @param {Map<string, Map<string, number>>} baseLegs 库内腿（阶段① 占位值，可能含竞价值/缺行）
 * @param {Map<string, Map<string, number>>|null} extraByStock 补算腿（股票名 -> (YYYYMMDD -> 日涨幅%)）
 * @param {string[]} ascDates 升序交易日（'YYYY-MM-DD'）
 * @param {{tDate?:string, tKeepAuctionLeg?:boolean}} [opts]
 *        tDate：展示日 T；tKeepAuctionLeg：是否保护 T 腿不被 K 线覆盖（缺省 true = 旧行为）
 * @returns {Map<string, Map<string, number>>} 新 Map（不修改入参）
 */
export function merge20Legs(baseLegs, extraByStock, ascDates, opts) {
  const out = new Map();
  if (baseLegs) baseLegs.forEach(function(legs, name) { out.set(name, new Map(legs)); });
  if (!extraByStock || !ascDates) return out;
  const tDate = (opts && opts.tDate) ? String(opts.tDate) : '';
  // 缺省 true：向后兼容（未显式声明口径的调用方保持"T 腿受保护"的旧语义）
  const tKeepAuctionLeg = !(opts && opts.tKeepAuctionLeg === false);
  extraByStock.forEach(function(dayMap, name) {
    if (!name || !dayMap) return;
    let legs = out.get(name);
    if (!legs) { legs = new Map(); out.set(name, legs); }
    for (let i = 0; i < ascDates.length; i++) {
      const d = ascDates[i];
      // 🔴 T 日腿 = 竞价涨幅口径时，⛔ K 线不得覆盖（见函数头 2026-10-19 的说明）
      if (tDate && tKeepAuctionLeg && d === tDate) continue;
      const v = parsePct(dayMap.get(d.replace(/-/g, '')));
      // ★ 覆盖：K 线是真收盘；库内值可能是「早盘写入的竞价涨幅」或根本缺行
      if (v !== null) legs.set(d, v);
    }
  });
  return out;
}

/**
 * 【纯函数】复利累乘 → 每只票的 20 日涨幅。
 *
 * 🔴 [FIX 2026-10-19 · R20-PERSTOCK-WIN] **窗口按【每只票自己】的最近 N 个交易日算，⛔ 不是全市场统一截取。**
 *
 *   事实（2026-10-19 生产实测，别改回"全局一致窗口"）：
 *     新华传媒 09-07~09-18 停牌 10 个交易日 ⇒ 全市场统一的 20 天窗口里它只有 12 根腿：
 *       · 统一窗口（旧）＝ 193.41%（12/20日）
 *       · 个股 20 个交易日（本实现）＝ **210.98%** ＝ 用户炒股软件的值，逐位吻合。
 *     差别不在「停牌算不算」（`×(1+0%)` 恒等），而在**窗口被停牌日占位后挤掉了早期 8 天**。
 *     用户明确要求「跟炒股软件对得上」，且停牌票正是他的主战场 ⇒ 按个股窗口。
 *     ★ 满窗票（无停牌）两种算法完全等价 ⇒ 不影响其余任何票的数值。
 *
 * ⚠️ `ascDates` 必须是**全市场真实交易日序列**（可用长度 > N）：本函数从后往前挑「该票有腿的日子」
 *    凑满 N 根即止，所以调用方 ⛔ 不能再先 `slice(-20)`（那样会截断可回溯范围）。
 *
 * @param {Map<string, Map<string, number>>} legsByStock 股票名 -> (日期 -> 日涨幅%)
 * @param {string[]} ascDates 升序【真实】交易日（长度可 > 窗口）
 * @param {{windowDays?:number}} [opts] windowDays：每票窗口长度，缺省 RANGE20_WINDOW_DAYS
 * @returns {Array<{stock:string, pct:number, days:number}>}
 *
 * `days` = 实际参与累乘的天数（该票缺数据会 < 20）；`pct` 一根腿都没有 → 该票不出现在结果里
 * （调用方据此让行「没有数值」而不是「涨幅 0」）。
 */
export function compound20(legsByStock, ascDates, opts) {
  const rows = [];
  if (!legsByStock || !ascDates) return rows;
  const wanted = Number(opts && opts.windowDays);
  const n = (isFinite(wanted) && wanted >= 1) ? Math.floor(wanted) : RANGE20_WINDOW_DAYS;
  const want = new Set(ascDates);
  legsByStock.forEach(function(legs, name) {
    if (!legs || legs.size === 0) return;
    const list = [];
    // 从最近一天往前挑，凑满 n 根该票自己的腿即止（停牌日/缺数据日不占窗口位）
    for (let i = ascDates.length - 1; i >= 0 && list.length < n; i--) {
      const d = ascDates[i];
      if (!want.has(d) || !legs.has(d)) continue;
      const v = legs.get(d);
      if (v === null || v === undefined || isNaN(v)) continue;
      list.push(v);
    }
    if (list.length === 0) return;
    list.reverse();
    const pct = compoundPct(list);
    if (pct === null || !isFinite(pct)) return;
    rows.push({ stock: name, pct: pct, days: list.length });
  });
  return rows;
}

/** 内容签名（防止内容没变却重复发布 ⇒ 行缓存整表刷新） */
function _sigOf(rows) {
  if (!rows || rows.length === 0) return '0';
  const parts = rows.map(function(r) { return r.stock + ':' + r.pct.toFixed(4) + ':' + r.days; });
  parts.sort();
  return rows.length + '|' + parts.join(',');
}

/**
 * 发布（内容签名相同 ⇒ 不发布、不 bump version）
 *
 * 🔴 [R20-PUB-GUARD 2026-10-26] 守卫**不能**再把 `_state.value.date === date` 当作「跳过发布」的
 *   前置条件；但也不能干脆删掉——两种情况要分开处理（§22 增量化）：
 *
 *   · 内容【变了】（`sig` 与上次不同）      → 正常发布，`version + 1`（消费方必须重算）。
 *   · 内容【没变】但 `_state.date` 被别的日期顶掉了 → **只把日期拨回来，`version` 不动**。
 *     为什么：`getRange20Pct(date)` 有 `if (s.date !== date) return null` 的守卫，
 *     ⇒ `_state.date` 一旦停在旧日期，当前日期整列返回 null（屏幕上一片 `—`）。
 *     而 `version` 是行缓存指纹（`getRange20FingerprintToken`）的组成部分，只要 `date` 变了
 *     指纹就已变、消费方本来就会重算 ⇒ **这里再 bump 一次纯属多余**，代价是整块看板重排。
 *
 *   实测（2026-10-26 历史日 2026-10-20，云端命中 253 只 / 0 K 线请求）：
 *     同一份逐字节相同的结果在 60s 内被重复发布 **71 次**（同一秒 2~3 次），
 *     每次 bump 都让行缓存失效 ⇒ 切完日期后这几秒明显卡顿。
 */
function _publish(date, rows) {
  const sig = _sigOf(rows);
  const prevSig = _sig.get(date);
  const sameDate = (_state.value.date === date);
  const contentChanged = (prevSig !== sig);
  if (!contentChanged && sameDate) return _state.value.map;
  const map = new Map();
  (rows || []).forEach(function(r) { map.set(r.stock, { pct: r.pct, days: r.days }); });
  _sig.set(date, sig);
  _cache.set(date, (rows || []).slice());
  _state.value = {
    date: date,
    map: map,
    version: contentChanged ? _state.value.version + 1 : _state.value.version
  };
  return map;
}

/** 日期闸门（与 dragon-rank#ensureDragonRangePct 同口径）：未来日 / 非交易日 ⇒ 不产出数据 */
function _notTradable(date) {
  const today = _getLocalTodayStr();
  if (today && date > today) return true;
  try {
    return !isTradingDay(date);
  } catch (e) {
    // 交易日历读不到 → 不因它断功能（宁可多算也不静默失效）
    _dbgLog('[RANGE20] 交易日历读取失败（放行）: ' + (e && e.message || e));
    return false;
  }
}

/** 把窗口内的逐日行建索引（日期 -> 股票名 -> 行）；同名同日只取第一行 */
function _rowsByDateOf(ascDates) {
  const out = new Map();
  let data;
  try {
    data = getAuctionData() || {};
  } catch (e) {
    _dbgLog('[RANGE20] 内存逐日数据读取失败: ' + (e && e.message || e));
    data = {};
  }
  for (let i = 0; i < ascDates.length; i++) {
    const d = ascDates[i];
    const m = new Map();
    const list = data[d] || [];
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      if (!r || !r.stock) continue;
      const n = String(r.stock).trim();
      if (n && !m.has(n)) m.set(n, r);
    }
    out.set(d, m);
  }
  return out;
}

/** 目标清单归一（去重 + 补代码） */
function _targetsOf(rows) {
  const out = [];
  const seen = new Set();
  (rows || []).forEach(function(r) {
    const name = r && r.stock ? String(r.stock).trim() : '';
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ stock: name, code: (r && r.code) ? String(r.code).trim() : '' });
  });
  return out;
}

/** 代码兜底：内存行 → scMap（与 dragon-rank 同源，§6 不另造一套代码解析） */
function _fillCodes(targets) {
  const scMap = (state && state._scMapCache) || {};
  targets.forEach(function(t) {
    if (!t.code && scMap[t.stock]) t.code = String(scMap[t.stock]).trim();
  });
}

/** date -> 最近一次传入的行清单（收盘换腿的定时器需要用同一份目标清单重算） */
const _lastRows = new Map();

/**
 * date -> 已确认的「真实交易日」升序数组（**只增不减**）。
 *
 * 🔴 [R20-PROGRESS 2026-10-20] 为什么必须累积：分批发布时早期只有 3 只票的腿，
 *   `pickRealWindowDates` 的判据是「该日全市场任一票有腿」—— 那 3 只恰好都停牌的日子
 *   就会被误判成非交易日 ⇒ 窗口变短 ⇒ 数值偏小，下一批再跳回来 ⇒ 用户看见数字闪。
 *   累积并集（单调收敛）后窗口只会变长不会缩短。
 */
const _realDatesAcc = new Map();

/** 合并两份 K 线腿（a 为底，b 覆盖同名同日） */
function _mergeAccMaps(a, b) {
  const out = new Map();
  if (a) a.forEach(function(m, n) { out.set(n, new Map(m)); });
  if (b) b.forEach(function(m, n) {
    if (!n || !m) return;
    let cur = out.get(n);
    if (!cur) { cur = new Map(); out.set(n, cur); }
    m.forEach(function(v, ymd) { cur.set(ymd, v); });
  });
  return out;
}

/** 累积真实交易日（见 _realDatesAcc 的说明） */
function _unionRealDates(date, merged, probeDates) {
  const cur = pickRealWindowDates(merged, probeDates, probeDates.length);
  const prev = _realDatesAcc.get(date);
  if (!prev) { _realDatesAcc.set(date, cur); return cur; }
  const s = new Set(prev);
  cur.forEach(function(d) { s.add(d); });
  const union = probeDates.filter(function(d) { return s.has(d); });
  _realDatesAcc.set(date, union);
  return union;
}

/** 本轮算出的结果 ∪ 云端表里的结果（同名以本轮为准） */
function _mergeRowsWithCloud(freshRows, cloudMap) {
  if (!cloudMap || cloudMap.size === 0) return freshRows || [];
  const m = new Map();
  cloudMap.forEach(function(v, n) { m.set(n, { stock: n, pct: v.pct, days: v.days }); });
  (freshRows || []).forEach(function(r) { if (r && r.stock) m.set(r.stock, r); });
  return Array.from(m.values());
}

/**
 * T 腿口径切换（跨 15:00）：把「已按旧口径算过」的登记清掉，让阶段② 重跑一遍。
 *
 * 🔴 [R20-TSWITCH] 两个关键点，⛔ 别"优化"掉：
 *   ① `_klineTried` 必须清空：早盘请求成功的票全在里面，不清就一只都不会重跑 ⇒ 永远停在竞价口径。
 *   ② `_klineAcc` **保留历史日腿、只剔除 T 日腿**：早盘抓到的「今天」那根是盘中现价（不是收盘价），
 *      留着它会让收盘口径算出一个假数；而历史日腿是同一个数据源的同一天收盘，无需重付请求。
 *      ⇒ 剔除后重跑，即使上游部分失败，各票也还能靠历史腿 + 库内收盘 T 腿给出接近正确的值。
 *
 * @param {string} date 展示日 T
 * @param {string} fromMode 旧口径
 * @param {string} toMode 新口径
 */
function _switchLegMode(date, fromMode, toMode) {
  _klineTried.delete(date);
  const acc = _klineAcc.get(date);
  if (acc) {
    const ymd = String(date).replace(/-/g, '');
    acc.forEach(function(dayMap) { if (dayMap) dayMap.delete(ymd); });
  }
  _stage.delete(date);
  _inflight.delete(date + '|kline');
  _legMode.delete(date);
  _realDatesAcc.delete(date);       // 口径变了 ⇒ 让真实交易日重新累积（腿集合会变）
  _dbgLog('[RANGE20-TSWITCH] ' + date + ' T腿口径 ' + fromMode + ' → ' + toMode + '：清空补算登记并重算');
}

/**
 * 若本次是「盘中竞价口径」，安排一个一次性定时器在 15:00 后自动换腿重算。
 *
 * 为什么需要它：看板是 SPA，页面可能从早盘一直开到现在；没有用户交互 ⇒ `ensureRange20`
 * 不会再被调用 ⇒ 收盘后屏幕仍停在早上那份数（用户第二次反馈正是这个现象）。
 * ⚠️ 只是补丁：刷新/切日期时 `ensureRange20` 本身就会按新口径算（`_legMode` 无记录 ⇒ 直接 close）。
 * ⚠️ 多等 90s：15:00 那一刻同花顺日线的今日收盘可能还没更新，太早抓会拿到盘中价。
 *
 * @param {string} date 展示日 T
 * @param {string} legMode 本次发布所用的口径
 */
function _scheduleCloseSwitch(date, legMode) {
  if (legMode !== 'auc') return;
  if (_closeTimer.has(date)) return;
  const closeMs = closeCoverUtcMs(date);
  if (Number.isNaN(closeMs)) return;
  const delay = (closeMs + 90000) - Date.now();
  if (!(delay > 0) || delay > 2147483647) return;
  const timer = setTimeout(function() {
    _closeTimer.delete(date);
    const rows = _lastRows.get(date);
    if (!rows || rows.length === 0) return;
    try {
      ensureRange20(date, rows, { _tswitch: true }).catch(function() { /* 定时重算失败不影响主流程 */ });
    } catch (e) { /* 同上 */ }
  }, delay);
  _closeTimer.set(date, timer);
}

/**
 * 确保某日的 20 日涨幅已就绪（幂等 / 单飞 / 会话缓存）。
 *
 * @param {string} date 展示日 T
 * @param {Array<{stock:string, code?:string}>} rows 看板当前渲染的行（目标清单的唯一来源）
 * @param {{onProgress?:(done:number,total:number)=>void, skipKline?:boolean}} [opts]
 *        skipKline：只跑阶段①（库内数据）—— 供单测/诊断用
 * @returns {Promise<Map<string,{pct:number,days:number}>>|null}
 */
export async function ensureRange20(date, rows, opts) {
  if (!date) return null;
  if (_notTradable(date)) {
    if (_state.value.date === date && _state.value.map.size === 0) return _state.value.map;
    _sig.delete(date);
    _publish(date, []);
    return _state.value.map;
  }
  const targets = _targetsOf(rows);
  if (targets.length === 0) return (_state.value.date === date) ? _state.value.map : null;

  // T 腿口径（阶段⓪/①② 都要用，提到最前面算一次）
  const tIsToday = (date === _getLocalTodayStr());
  // 🔴 [FIX 2026-10-19 · R20-TSWITCH] T 腿口径随 15:00 换腿（用户口径：早上竞价 / 收盘后全收盘）
  const afterClose = isAfterCloseOf(date);
  const legMode = resolveT20LegMode(tIsToday, afterClose);
  const prevMode = _legMode.get(date);
  if (prevMode && prevMode !== legMode) _switchLegMode(date, prevMode, legMode);
  if (rows && rows.length) _lastRows.set(date, rows);

  // ---- 阶段⓪：云端结果表（0 K 线请求 · 跨会话/跨设备）----
  // 🔴 [R20-CLOUD 2026-10-20 用户反馈「20日涨幅加载太慢，十日涨幅早就出来了」]
  //   十日涨幅快是因为它读 `stock_range_pct` 表（1 次查询 ~100ms）；而 20 日涨幅每次打开
  //   都要现打 40+ 次同花顺 K 线（30~90s），刷新即白算。
  //   ⇒ 把算好的结果按 (date,stock) 落到 `stock_range20_pct`，这里先读出来直接发布。
  //   命中部分立即出数，只有「表里没有 / 口径不匹配」的票才走阶段②。
  //   ⚠️ 这是加速层：读失败返回 null ⇒ 降级为纯内存计算，功能不受影响（见 stock-range20-cache.js）。
  const cloudMap = (opts && opts.skipCloud)
    ? new Map()
    : pickUsableRows(await readRange20Rows(date), legMode);
  if (cloudMap.size > 0) {
    const cloudRows = [];
    cloudMap.forEach(function(v, n) { cloudRows.push({ stock: n, pct: v.pct, days: v.days }); });
    _publish(date, cloudRows);
    _dbgLog('[RANGE20-CLOUD] ' + date + ' 命中 ' + cloudMap.size + ' 只（leg=' + legMode + '，0 K线请求）');
  }

  // ---- 阶段①：库内数据（0 请求 / 0 额度）----
  // ★ 取数用【探针窗口】= 45 个 App 日历交易日（比 20 多 25 个槽位）：App 日历可能把工作日
  //   假期当交易日（云端 holidays 为空数组时就是如此，见 RANGE20_PROBE_DAYS），且停牌票要
  //   往前回溯才凑得满自己那 20 个交易日（见 compound20 的 R20-PERSTOCK-WIN）。
  const probeDates = getRange20WindowDates(date, RANGE20_PROBE_DAYS);
  const rowsByDate = _rowsByDateOf(probeDates);
  const baseLegs = legs20FromRows(targets, probeDates, rowsByDate, { tIsToday: tIsToday, afterClose: afterClose });
  // 🔴 [FIX 2026-10-19 · R20-CLOSE-LEG] **阶段① 本身不发布**。
  //   原因：历史日的库内 `change_pct` 不可信（早盘写入的竞价涨幅 / 缺行，见 merge20Legs 函数头），
  //   所以 baseLegs 现在只剩「T 腿」一根 —— 拿它发出去会得到一个只有 1 天的假数值。
  //   §10「宁缺勿错」⇒ 这一列在 K 线到货前显示 `—`，绝不显示一个对不上的数。
  //   （用户反馈过的「显示 42.7%，实际 117.4%」就是旧版把库内值当结果发出去的后果。）
  //   ✅ 真正「先出数」的活交给阶段⓪（云端结果表，那是 K 线算过的真值）与阶段② 的分批发布。
  if (_stage.get(date) === 2) {
    // 本会话已合并过 K 线 ⇒ 用缓存里的那份结果复原（切日期回来时 `_state` 已被别的日期占着）
    if (_cache.has(date)) _publish(date, _cache.get(date));
  }
  if (opts && opts.skipKline) return _state.value.map;

  // ---- 阶段②：同花顺 K 线（免费额度）----
  // 🔴 [FIX 2026-10-19 · R20-CLOSE-LEG] **所有票都要跑一次 K 线，⛔ 不再是「只跑腿不够的票」。**
  //   为什么：历史日的库内 `change_pct` 不可信（可能是早盘写入的竞价涨幅，且大量历史日缺行，
  //   见 merge20Legs 函数头）。若沿用「库内腿数够 30 天就跳过」的判据，
  //   那些「库内行数齐、但值全是竞价涨幅」的票就永远不会被纠正 ⇒ 数值静默偏差近一倍。
  //   `_klineTried` 保证同一会话同一票只请求一次（§32/§36），所以增量成本只有首轮一遍。
  // 🔴 [R20-CLOUD 2026-10-20] 云端结果表已命中的票**不再请求**（这才是「第二次打开秒开」的关键）。
  const need = targets;
  if (need.length === 0) return _state.value.map;
  const tried = _klineTried.get(date) || new Set();
  // 🔴 [R20-CLOUD] 云端表已命中的票跳过 —— 这条过滤就是「第二次打开秒开」的实现。
  const todo = need.filter(function(t) { return !tried.has(t.stock) && !cloudMap.has(t.stock); });
  if (todo.length === 0) return _state.value.map;

  const key = date + '|kline';
  const fly = _inflight.get(key);
  if (fly) return fly;

  const p = (async function() {
    _fillCodes(todo);
    if (todo.some(function(t) { return !t.code; })) {
      try {
        await ensureAuctionCodeMapping(todo);
      } catch (e) {
        _dbgLog('[RANGE20] 补码失败: ' + (e && e.message || e));
      }
      _fillCodes(todo);
    }
    const list = todo.filter(function(t) { return !!t.code; });
    if (list.length === 0) {
      _dbgLog('[RANGE20] 无可用代码，跳过同花顺补算（' + date + '）');
      return _state.value.map;
    }
    // 先登记再请求：防同一会话内并发重复请求（§32/§36）。
    // 🔴 但失败的票要【解除登记】—— 否则上游一次偶发故障（实测连续失败会触发熔断，
    //    41 只票只成功 5 只）就让这些票在本会话里永远只有 `—`。见下方 finally。
    list.forEach(function(t) { tried.add(t.stock); });
    _klineTried.set(date, tried);

    const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
    // 🔴 [R20-PROGRESS 2026-10-20] **分批发布**：每完成一批（并发 3）就用「已拿到的腿 + 云端表」
    //   重算并发布 ⇒ 用户 3~5 秒就能看到头几只，而不是等 40 只全跑完（旧实现 30~90s 纯白屏）。
    //   ⛔ 不要改成「全部跑完再发」：这就是用户反馈的「20日涨幅比十日涨幅慢很多」的直接原因之一。
    const _publishFrom = function(accKline) {
      try {
        const acc = _mergeAccMaps(_klineAcc.get(date), accKline);
        if (acc.size === 0) return;
        const mg = merge20Legs(baseLegs, acc, probeDates, {
          tDate: date,
          tKeepAuctionLeg: (legMode === 'auc'),
        });
        const rd = _unionRealDates(date, mg, probeDates);
        // 🔴🔴 [R20-PROGRESS-FIX 2026-10-20] 分批发布**只发本轮真拿到 K 线的票**（`acc` 的 key 集合）。
        //   踩过的坑（E2E 抓到的）：`merge20Legs(baseLegs, acc, …)` 会把 `baseLegs`（阶段①库内）
        //   一起并进来，而 baseLegs 现在**只有 T 腿**（历史日只认 K 线）⇒ K 线还没到的票在这里
        //   只剩「T 日一根腿」⇒ `compound20` 拿这一根算出来 = **T 日当天的涨幅**，冒充 20 日涨幅。
        //   实测：新华传媒发成 2.77%（= 它 10-19 当日收盘涨幅）、新华文轩 -9.99%、澳弘电子 10.00%
        //   （= 涨停）。这正是用户投诉过的「显示 42.7%，实际 117.4%」同一类错误（§10 宁缺勿错）。
        //   ⇒ 没腿的票这一列保持 `—`（title 已写明「正在用同花顺日线补算」），绝不发估值。
        const fresh = compound20(mg, rd).filter(function(r) {
          return acc.has(r.stock);
        });
        if (fresh.length === 0) return;
        _publish(date, _mergeRowsWithCloud(fresh, cloudMap));
      } catch (e) { /* 增量发布失败不影响最终发布 */ }
    };
    let extra = new Map();
    try {
      extra = await fetchFuyaoDailyPctRange(
        list.map(function(t) { return { stock: t.stock, code: t.code }; }),
        probeDates,
        // retryShortWindow：上游偶发只回「最近 12 根」，窗口会被误判成次新股 ⇒ 强迫它重试，
        //   否则本 toggle 永远只有 12/20 天、各票天数不齐 ⇒ 区间涨幅不可比（见 stock-range-pct.js）。
        // requestTimeoutMs：上游偶发「不返回也不断开」⇒ 批量 Promise.all 永久挂住、整批发布不出来；
        //   15s 超时后按失败重试，最多浪费一次尝试，不会让整块看板卡死。
        // minCoverage：探针窗口里有非交易日（App 日历把工作日假期当交易日）⇒ 谁也凑不满 45 根，
        //   不设门槛会让每只票都跑满 3 次重试（实测 41 只 = 203 个请求）。凑够 20 根即完成。
        // concurrency 3：实测 3 的成功率明显高于 5（并发高时上游更容易返回截断序列并触发熔断，
        //   实测并发 5 一次只成功 5/41 只）。宁可多几秒，也要拿到真收盘腿。
        {
          concurrency: 3, retryShortWindow: true, requestTimeoutMs: 15000,
          minCoverage: RANGE20_WINDOW_DAYS, onProgress: onProgress,
          onBatch: _publishFrom,      // §11：可选回调，不传则工厂行为逐字不变
        }
      );
    } finally {
      // 没拿到腿的票 → 从 tried 移除，下次 ensureRange20（行数变化 / 切日期回来）可再试一次；
      // 拿到腿的保持登记 ⇒ 同一会话不重复请求。
      list.forEach(function(t) { if (!extra.has(t.stock)) tried.delete(t.stock); });
      if (tried.size === 0) _klineTried.delete(date);
      else _klineTried.set(date, tried);
    }
    // ★ 累积本次拿到的新腿（跨轮复用：第二轮重试时不能丢掉第一轮已补好的票）
    if (extra.size > 0) {
      let acc = _klineAcc.get(date);
      if (!acc) { acc = new Map(); _klineAcc.set(date, acc); }
      extra.forEach(function(dayMap, name) {
        if (!name || !dayMap) return;
        let cur = acc.get(name);
        if (!cur) { cur = new Map(); acc.set(name, cur); }
        dayMap.forEach(function(v, ymd) { cur.set(ymd, v); });
      });
    }
    const accAll = _klineAcc.get(date) || extra;
    // ★ tDate = 展示日 T；tKeepAuctionLeg：盘中才保护 T 腿（收盘后必须让 K 线的今日收盘覆盖它）
    const merged = merge20Legs(baseLegs, accAll, probeDates, {
      tDate: date,
      tKeepAuctionLeg: (legMode === 'auc'),
    });
    // ★ 用【真实交易日】重建序列（剔除 App 日历里的工作日假期）。
    //   🔴 [R20-PERSTOCK-WIN] 这里**不再截到 20**：每只票在 `compound20` 里自己取最近 20 个有腿日，
    //   停牌票需要往前多回溯（截到 20 会把它的窗口挤短 ⇒ 对不上炒股软件）。
    //   `probeDates.length` = 保留探针范围内的全部真实交易日（升序，供每票回溯）。
    //   [R20-PROGRESS] 走累积并集 ⇒ 与分批发布用的是同一份窗口（否则最终结果会与中途显示的数不一致）。
    const realDates = _unionRealDates(date, merged, probeDates);
    // 常驻诊断（量小；本链路出问题时唯一可查的证据）：抽样一只票，看三个阶段各自的腿数。
    // 排查「数值偏小/天数不齐」时先看这里：base=阶段①库内腿、extra=K线、merged=覆盖后、real=全局窗口。
    let _dbgSample = '';
    try {
      const _t0 = (targets[0] && targets[0].stock) || '';
      if (_t0) {
        const _n = function(m) { const v = m && m.get(_t0); return v ? v.size : 0; };
        _dbgSample = ' sample=' + _t0 + ' base=' + _n(baseLegs) + ' extra=' + _n(extra) + ' merged=' + _n(merged)
          + ' tDate=' + date;
      }
    } catch (e) { /* 诊断失败不影响主流程 */ }
    _dbgLog('[RANGE20-PUB] ' + date + ' 补缺完成 extra=' + extra.size + ' merged=' + merged.size
      + ' realDays=' + realDates.length + ' leg=' + legMode + ' cloud=' + cloudMap.size + _dbgSample);
    if (realDates.length < RANGE20_WINDOW_DAYS) {
      _dbgLog('[RANGE20] ' + date + ' 真实交易日只凑到 ' + realDates.length + '/' + RANGE20_WINDOW_DAYS
        + '（探针 ' + probeDates.length + ' 槽；云端 holidays 可能为空导致假期被当交易日）');
    }
    // 🔴🔴 [R20-PROGRESS-FIX 2026-10-20] 最终发布同样**只发本轮真拿到 K 线的票**（与分批发布同一判据）。
    //   原因：`merged` 里也含 `baseLegs`（只有 T 腿）—— 上游失败/超时的票在这里只剩一根腿，
    //   直接发布等于把「T 日当天涨幅」冒充成「20 日涨幅」（§10 铁律：缺数据给 `—`，⛔ 不给错值）。
    //   这类票由下方延迟重试补齐；补齐前这一列显示 `—`（title 已写明「正在补算」）。
    const finalRows = compound20(merged, realDates).filter(function(r) {
      return accAll && accAll.has(r.stock);
    });
    _publish(date, _mergeRowsWithCloud(finalRows, cloudMap));
    _stage.set(date, 2);            // 🔴 标记「该日已合并 K 线」⇒ 后续阶段① 不再覆盖（见 _stage 说明）
    _legMode.set(date, legMode);    // 🔴 记录本次口径 ⇒ 跨 15:00 时据此触发重算（见 _switchLegMode）
    _scheduleCloseSwitch(date, legMode);   // 页面一直开着 ⇒ 15:00 后自动换腿重算一遍
    // 🔴 [R20-CLOUD] 把本轮【真正算出来】的票落库 ⇒ 下次打开/切日期/换设备都能 0 请求秒开。
    //   只写 accAll 里有的票（= 本会话用 K 线算过的）：云端表已命中的票本来就在库里，重复写只是浪费。
    //   upsert 内部已 try/catch，写失败不影响页面（下次打开重算一遍而已）。
    try {
      const _toSave = finalRows;
      if (_toSave.length > 0) await upsertRange20Rows(date, _toSave, legMode);
    } catch (e) { /* 落库失败静默：正确性不依赖它 */ }
    // 上游偶发（截断 / 熔断 / 超时）会让部分票这一轮拿不到腿 ⇒ 对它们这一列是 `—`（§10 不给错值）。
    // 安排【一次】延迟重试补齐：拿到的票已在 tried 里不会重复请求，_klineAcc 保证不丢已有腿。
    // ⛔ 只重试一次（_range20Retried 闸门），避免上游持续故障时无限打请求。
    if (extra.size < list.length && !(opts && opts._range20Retried)) {
      const _rowsForRetry = rows;
      setTimeout(function() {
        try {
          ensureRange20(date, _rowsForRetry, Object.assign({}, opts, { _range20Retried: true }));
        } catch (e) {
          _dbgLog('[RANGE20] 延迟重试失败（保持 —）: ' + (e && e.message || e));
        }
      }, 9000);
    }
    return _state.value.map;
  })().finally(function() {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}
