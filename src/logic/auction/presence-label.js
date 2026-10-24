/**
 * presence-label.js — 「涨幅前十 · 在列次数」标签的【唯一判定实现】（Logic 层纯函数）。
 *
 * ============================================================================
 * 用户口径（2026-10-23，逐字）：
 *   「你在早盘竞价看板，10日涨幅 toggle 单独打开后，把排名前十的股票，在这 10 个交易日中
 *     出现过几次标记起来，状态也存起来……也就是说在早盘竞价看板每天的列表中出现过几次，
 *     打上小标签比如"5次在列"，"首次在列"，单独打开 20 日涨幅 toggle 时也要，20 个交易日的
 *     也要存起来，也存在表里（排名前十的）。这样响应才快，我会用这个出现次数做分析。」
 *   补充确认（AskUserQuestion）：「只给前十名标」/「Supabase 定时算好落表」/「含今天」。
 * ============================================================================
 *
 * 职责边界（§3/§21）：
 *   · 本模块【只做两件事】：① 次数 → 标签文案；② 给当前排序后的前 N 行挂字段。
 *   · ⛔ 不取数、不请求、不排序、不判断「谁在名单里」——
 *     次数由 Data 层（src/data/auction-presence.js）读预计算表 `auction_presence` 得到，
 *     顺序由 view-helpers 的 `sortIndicesByRangePct`（range-pct-sort.js）给出。
 *
 * 「在列」的定义（§6 单一真相）：
 *   = 该票当天在 `auction_watchlist`（早盘竞价看板的正式名单）里。
 *   ⚠️ 补位的「20天」票是前端注入的展示行，**从不入库** ⇒ 历史日一律以 watchlist 为准；
 *      它们若在整个窗口里都没进过名单，次数就是 0（标签为「未在列」），这是真实信息、不是缺数据。
 *
 * §10 宁缺勿错：
 *   · 次数数据未到（counts = null）→ 全表不标（⛔ 绝不当 0 显示成「未在列」）；
 *   · 没有区间涨幅的行不占名次（与 range20-top5-label.js 的「总龙N」同一套口径），
 *     ⛔ 绝不因为「凑够 10 行」而给一只没有涨幅的票打标。
 *
 * [MAIN-BOARD-RANK 2026-10-24 用户口径] 「排名只算主板」：
 *   非主板（创业板 / 科创板 / 北交所）**不占前十名额**，名次顺延给下一只主板票。
 *   ⚠️ 只影响名次与标签，⛔ 不影响涨幅排序 —— 它们照旧按涨幅待在原位
 *      （用户在同一次 AskUserQuestion 里明确选的是「排序不动，只不占名次」，
 *        与 2026-10-07 龙标签「只排主板的，但十日涨幅排序不变」是同一条纪律）。
 *   判据走 limit-up.js#isMainBoardRankEligible（唯一实现，§6）。
 */

// [MAIN-BOARD-RANK 2026-10-24 用户口径] 「排名只算主板」的判据走 limit-up.js 的唯一实现（§6），
//   ⛔ 不在这里手写 /^30|68|43/ 前缀（板块分类只有 getBoardKind 一处真相）。
import { isMainBoardRankEligible } from './limit-up.js';

/** 打标只数（用户口径：前十名）。与 range20-top5-label.js#RANGE20_TOTAL_DRAGON_TOP_N 是同族常量但含义不同。 */
export const PRESENCE_TOP_N = 10;
/** 统计窗口（交易日数）：10 = 「10日涨幅」toggle；20 = 「20日涨幅」toggle。 */
export const PRESENCE_WINDOW_10 = 10;
export const PRESENCE_WINDOW_20 = 20;

/**
 * 【纯函数】次数 → 标签文案。
 *
 * 文案口径（用户给的样例是「5次在列」「首次在列」，其余档位按同一语感补齐）：
 *   · 0 次 → 「未在列」（整个窗口里一次都没进过名单 —— 对新龙头 / 补位票来说这正是关键信息）
 *   · 1 次 → 「首次在列」（窗口内只出现在今天 ⇒ 今天是它第一次上榜）
 *   · n 次 → 「n次在列」
 *
 * ⚠️ 非法值（null / '' / NaN / 负数）→ ''（模板 v-if 直接不渲染）。
 *   ⛔ 不把「没数据」写成「0次」：那是把「不知道」显示成「确认为零」（§10）。
 *
 * @param {number|string|null} cnt 窗口内（含今天）在列次数
 * @returns {string}
 */
export function presenceLabelOf(cnt) {
  if (cnt === null || cnt === undefined || cnt === '') return '';
  const n = Number(cnt);
  if (!isFinite(n) || n < 0) return '';
  const k = Math.floor(n);
  if (k === 0) return '未在列';
  if (k === 1) return '首次在列';
  return k + '次在列';
}

/**
 * 【纯函数】取该行在当前窗口下的区间涨幅（= 该 toggle 的排序键）。
 * 10 日窗口读 `rangePct`（云端 stock_range_pct），20 日窗口读 `rangePct20`（range20.js 现算）。
 * 两者语义不同（见 view-helpers 里这两个字段的长注释），⛔ 不可互相顶替。
 *
 * @param {{rangePct?:number|null, rangePct20?:number|null}|null} item
 * @param {number} windowDays 10 / 20
 * @returns {number|null} 缺值 → null（⛔ 不补 0）
 */
export function presenceSortValueOf(item, windowDays) {
  if (!item) return null;
  const v = (Number(windowDays) === PRESENCE_WINDOW_20) ? item.rangePct20 : item.rangePct;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 【纯函数】按「items 的当前顺序」给前 N 只挂「在列次数」标签（就地写字段，返回实际打标只数）。
 *
 * 入参 items 的顺序【必须已经是】该窗口下的涨幅降序（由 view-helpers 保证），本函数不再排序。
 * 对**每一个**非空行都会写这四个字段（模板只渲染字符串，§21 零计算）：
 *   · `presenceCnt`         : number|null 次数（null = 不打标 / 没数据）
 *   · `presenceLabel`       : '5次在列' / '首次在列' / '未在列' / ''
 *   · `presenceWindowDays`  : 10 / 20（悬停文案用）
 *   · `presenceCoveredDays` : 窗口内实际有名单数据的天数（悬停文案用，§10 如实用 n/N 报覆盖度）
 *
 * ★ 为什么「没选中的行也要显式写 null / ''」：这些行对象会进 incremental-view 的行缓存复用，
 *   只要有一次残留了标签，切 toggle / 换日期后就会在别的视图里冒出「5次在列」（§11 默认无行为）。
 *   与 assignTotalDragonRanks 同款结构性清零，不依赖三处默认值都写对。
 *
 * @param {Array<object>} items 已按涨幅降序的行数组
 * @param {number} [topN] 打标只数，缺省 10
 * @param {{windowDays?:number, counts?:Map<string,{cnt:number, dates?:string}>|null, coveredDays?:number}} [opts]
 *        counts = null 表示【数据未到】（全表不标）；coveredDays = 0 表示窗口内没有任何名单数据（同样不标）。
 * @returns {number} 实际打标只数（可能 < topN）
 */
export function assignPresenceLabels(items, topN, opts) {
  const list = items || [];
  const options = opts || {};
  const rawN = (topN === null || topN === undefined) ? PRESENCE_TOP_N : Number(topN);
  const cap = (isFinite(rawN) && rawN > 0) ? Math.floor(rawN) : PRESENCE_TOP_N;
  const windowDays = (Number(options.windowDays) === PRESENCE_WINDOW_20) ? PRESENCE_WINDOW_20 : PRESENCE_WINDOW_10;
  const coveredDays = Number(options.coveredDays) > 0 ? Math.floor(Number(options.coveredDays)) : 0;
  const counts = options.counts || null;
  // §10：次数数据没到 / 窗口内一天名单都没有 ⇒ 一律不标（⛔ 不拿 0 冒充「未在列」）
  const usable = !!(counts && coveredDays > 0);

  let rank = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    // 先无条件清零，再按需赋值（结构性保证：任何残留都会被这一轮擦掉）
    it.presenceCnt = null;
    it.presenceLabel = '';
    it.presenceWindowDays = windowDays;
    it.presenceCoveredDays = coveredDays;
    if (!usable || rank >= cap) continue;
    // §10：没有区间涨幅的行不占名次（与「总龙N」同口径），避免「数据没到」时按原顺序乱标
    if (presenceSortValueOf(it, windowDays) === null) continue;
    // [MAIN-BOARD-RANK 2026-10-24 用户口径] 非主板（创业板 / 科创板 / 北交所）**跳过且不占名次**：
    //   它们照旧显示在涨幅排序里的原位（排序一点没动），但「前十」的名额只数主板，
    //   名次自动顺延给下一只主板 ⇒ 屏幕上带标签的永远是主板票，且标签刚好十个。
    //   ⚠️ 代码缺失按「未知」处理 = 有资格（§10：判不出 ≠ 判出非主板）。
    if (!isMainBoardRankEligible(it.code)) continue;
    rank += 1;
    const name = it.stock ? String(it.stock).trim() : '';
    const hit = name && counts.has(name) ? counts.get(name) : null;
    // 命中率说明：今天在名单里的票 100% 能命中（它至少在 T 这天在列 ⇒ cnt >= 1）；
    // 命中不到只可能是「补位票在整个窗口里都没进过名单」⇒ 真实次数就是 0。
    const cnt = hit ? Number(hit.cnt) : 0;
    it.presenceCnt = isFinite(cnt) && cnt >= 0 ? Math.floor(cnt) : 0;
    it.presenceLabel = presenceLabelOf(it.presenceCnt);
  }
  return rank;
}
