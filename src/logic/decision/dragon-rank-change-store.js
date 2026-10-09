// dragon-rank-change-store.js — 「龙标名次变化」的【按日取数 + 状态发布】（Logic 层）
//
// 分层（§15 一个业务模块 = View + Logic + Data；与手动「竞价图形判断」同一套拆法）：
//   components/decision/DecisionBuyBlock.vue / DecisionSellBlock.vue（只 {{ }} 渲染）
//     → composables/useDecisionBoard.js（只决定【什么时候】加载，§34）
//     → 本文件（工作流：补拉名单 → 读云端区间涨幅 → 调 collect 算昨日龙位 → 发布）
//     → logic/decision/decision-collect.js（与今日完全同一套「行组装 + 题材排名 + rankDragons」）
//     → data/stock-range-pct.js（stock_range_pct 的读写入口，§5）
//     → dragon-rank-change.js（纯映射 + 状态单例）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么需要这个文件（而不是在 collect 里顺手算）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   · collectDecisionData 是【同步】的、「只读内存真相」的（§4）；
//   · 「昨日龙位」要一份历史数据（前一交易日的十日涨幅），它不在 dragon-rank 的单日期主状态里
//     ⇒ 必须先【异步】把它读进内存，再让 collect 算。
//   §4 的分工：本文件 = 拿数据的那一侧；collect = 用数据算结论的那一侧。⛔ 两边都不越界。
//
// 🔴 两次取数的正当性（§32 相同数据不得重复请求）：
//   ① ensureAuctionDateDataLoaded(prevDate)：既有入口，幂等 + 单飞 + 首屏 30 天窗口内是 no-op
//      —— 决策看板通常看的就是最近几天，正常路径【0 额外请求】；
//   ② readRangePctForDate(prevDate)：读云端 stock_range_pct 【已经落库的】那一行（§5 的只读入口），
//      ⛔ 不会去调猫抓 daily、⛔ 不消费任何额度 —— 数据要么已被 worker / 收盘覆盖写过，要么就是没有。
//
// §10：任一环节失败 ⇒ 【不发布】（清空），屏上一枚徽标都不显示。
//   理由：龙标名次变化是【辅助信息】，它错了会让人误判强弱。宁可不显示，也不显示一个假的名次变化。
//   ⛔ 失败信息用 console.warn 如实留痕（与 decision-collect#_prevBuyNames 同一口径）——
//     它是「行情派生的辅助项」，不是用户输入的东西，弹红字会盖住真正需要他处理的问题。

import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { ensureAuctionDateDataLoaded } from '../auction/auction-pull-window.js';
import { readRangePctForDate } from '../../data/stock-range-pct.js';
import { collectDragonRankMap } from './decision-collect.js';
import { publishPrevDragonRank, clearPrevDragonRank, dragonRankChangeState } from './dragon-rank-change.js';

/**
 * 同一个展示日内最多尝试几次。
 * 为什么需要上限：`auction-refresh` 是【高频事件】（早盘 9:25 前后每一次 Realtime 变化都会发一次），
 *   若它每次都能触发一次云端读，就等于「行情每动一下就多读一次 stock_range_pct」（§32 红线）。
 *   所以这里三重闸门：① 已成功 → 直接返回；② 冷却期内 → 直接返回；③ 次数用尽 → 直接返回。
 * 8 次 × 8 秒 ≈ 首屏后 1 分钟内的自愈窗口，足以覆盖「打开页面比 30 天窗口拉取更早」的竞态。
 */
const MAX_ATTEMPTS = 8;
const RETRY_COOLDOWN_MS = 8000;

let _inflight = null;          // { date, promise } 单飞
let _attemptDate = '';         // 当前计入次数的是哪一天
let _attempts = 0;
let _lastAttemptAt = 0;

/**
 * 确保「展示日 date 的【前一交易日】龙位表」已就绪。
 *
 * 幂等：同一前一交易日成功过一次就不再算（进程内缓存，§32）；
 * 单飞：并发调用只会产生一次实际工作；
 * 有界：同一天最多尝试 MAX_ATTEMPTS 次、两次之间至少隔 RETRY_COOLDOWN_MS。
 *
 * ⚠️ 调用方【不要 await 它来做渲染】—— 它是后台补数：没算出来时屏上就是不显示徽标（§10），
 *    算出来之后通过 publishPrevDragonRank 换引用驱动看板重算（§17 ref-driven，绝不阻塞渲染）。
 *
 * @param {string} displayDate 决策看板当前展示日 YYYY-MM-DD
 * @param {string} mode 买点模式（MODE_VOL_RATIO / MODE_YIZI）——
 *        ⚠️ 必须与今日同一套（题材排名口径要一致，§6：今日 / 昨日两个龙位必须是同一把尺子量出来的）
 * @returns {Promise<Map|null>} 前一交易日龙位表；未就绪 / 失败 → null（已 console.warn 留痕）
 */
export function ensurePrevDragonRank(displayDate, mode) {
  const d = String(displayDate || '').trim();
  if (!d) {
    clearPrevDragonRank();
    return Promise.resolve(null);
  }
  const prevDate = getPreviousTradingDay(d);
  if (!prevDate) {
    // 交易日历取不到 ⇒ 不知道「前一天」是哪天 ⇒ §10 不猜
    clearPrevDragonRank();
    return Promise.resolve(null);
  }
  // ① 已经算好这一天了 → 直接返回（高频调用时这里是绝大多数情况，0 请求）
  if (dragonRankChangeState.loaded && dragonRankChangeState.date === prevDate) {
    return Promise.resolve(dragonRankChangeState.map);
  }
  // ② 换了一天 → 次数归零（新的一天是全新的一份待办）
  if (_attemptDate !== prevDate) {
    _attemptDate = prevDate;
    _attempts = 0;
    _lastAttemptAt = 0;
    // 切日期的第一件事 = 把上一天的名次清掉：留着会显示成「今天 vs 昨天」的假变化（见 clearPrevDragonRank）
    if (dragonRankChangeState.date !== prevDate) clearPrevDragonRank();
  }
  // ③ 单飞
  if (_inflight && _inflight.date === prevDate) return _inflight.promise;
  // ④ 次数 / 冷却
  if (_attempts >= MAX_ATTEMPTS) return Promise.resolve(null);
  if (_lastAttemptAt && (Date.now() - _lastAttemptAt) < RETRY_COOLDOWN_MS) return Promise.resolve(null);

  _attempts += 1;
  _lastAttemptAt = Date.now();
  const p = _load(prevDate, mode);
  _inflight = { date: prevDate, promise: p };
  return p.finally(function() {
    if (_inflight && _inflight.promise === p) _inflight = null;
  });
}

/**
 * 实际取数 + 计算（失败一律吞掉并留痕：本函数只会被 ensurePrevDragonRank 调，调用方不需要 catch）。
 * @param {string} prevDate 前一交易日
 * @param {string} mode 买点模式
 * @returns {Promise<Map|null>}
 */
async function _load(prevDate, mode) {
  try {
    // ① 前一交易日的【名单】先进内存：collect 的题材分组建立在 getTodayGroupList(prevDate) 之上，
    //    名单不在内存时它会退化成空 / 残缺（§10），题材成员数虚低 ⇒ 龙位排不出来。
    //    既有入口：幂等 + 单飞 + 首屏 30 天窗口内 no-op。
    try {
      await ensureAuctionDateDataLoaded(prevDate);
    } catch (e) {
      console.warn('[DRAGON-RANK-CHANGE] 补拉前一交易日 ' + prevDate + ' 名单失败（本次不显示名次变化）', e);
      return null;
    }

    // ② 前一交易日的【十日涨幅】：读云端已落库的那一行（历史日 = 权威收盘口径，§5 只读入口）。
    //    ⛔ 读失败必须抛出（readRangePctForDate 的红线）⇒ 这里 catch 住、不发布。
    let rangeMap = null;
    try {
      rangeMap = await readRangePctForDate(prevDate);
    } catch (e) {
      console.warn('[DRAGON-RANK-CHANGE] 读取前一交易日 ' + prevDate + ' 区间涨幅失败（本次不显示名次变化）', e);
      return null;
    }
    if (!rangeMap || rangeMap.size === 0) {
      // 该日云端还没有区间涨幅（worker 未跑 / 非交易日）⇒ §10 未知，不发布
      console.warn('[DRAGON-RANK-CHANGE] 前一交易日 ' + prevDate + ' 云端无区间涨幅 ⇒ 暂不显示名次变化');
      return null;
    }

    // ③ 用【与今日完全同一套组装】算昨日龙位（§6 单一真相）：
    //    collectDecisionData 的题材排名 + rankDragons，唯一区别只是区间涨幅来自入参。
    const rec = collectDragonRankMap(prevDate, { mode: mode, rangeMap: rangeMap });
    if (!rec || !rec.ready || !rec.map || rec.map.size === 0) {
      console.warn('[DRAGON-RANK-CHANGE] 前一交易日 ' + prevDate + ' 龙位算不出来：' +
        ((rec && rec.reason) || '未知原因') + '（暂不显示名次变化）');
      return null;
    }

    publishPrevDragonRank(prevDate, rec.map);
    return rec.map;
  } catch (e) {
    // 兜底：本函数是【后台补数】，任何意外都不许冒泡成未处理的 rejection
    console.warn('[DRAGON-RANK-CHANGE] 前一交易日 ' + prevDate + ' 龙位计算异常（暂不显示名次变化）', e);
    return null;
  }
}

/** 仅供测试 / 诊断：清空「尝试次数」记忆（正常业务流程不需要调用） */
export function _resetDragonRankChangeLoaderMemo() {
  _inflight = null;
  _attemptDate = '';
  _attempts = 0;
  _lastAttemptAt = 0;
}
