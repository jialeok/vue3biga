// fetch-health.js — 「今天行情为什么没到」的诊断（Logic 层）
//
// 【用户口径来源】2026-10-26 用户报障原话：
//   「早盘竞价看板今天没有数据……是不是早上我打开，发现没有加载成功然后一直刷新导致，
//     一直刷新，把数据刷新没了？你要修复下，下面很多看板都是数据在加载中，一直没有加载出来」
//
// 实测结论（云端 + bidding_fetch_log，2026-10-26）：
//   · auction_watchlist 今天 50 行 —— 名单完好，**不是刷新刷没的**
//   · market_metrics(scope=auction) 今天 **0 行** —— 行情一条都没写进来
//   · bidding_fetch_log 09:25 那条 ok=false，detail.logs 明确写着
//     「numcat daily_auc … 今日调用额度已用完（上游 code=403）」，两把 key 都耗尽
//
// ⇒ 用户看到的「一直加载中」是【如实反映】—— 数据真的没到。缺的不是修复数据本身
//   （那是外部额度，代码变不出来），缺的是【把原因说清楚】：
//   否则用户只能反复刷新、怀疑自己操作，越刷越慢（每次刷新都要重跑一遍历史补齐）。
//
// 【§10 三段式】本模块严格区分三种状态，⛔ 绝不合并：
//   ① 读不到日志（异常）      → 不说原因，只报事实「今日行情未到」（不猜）
//   ② 读到了、没有记录（[]）  → 抓取**根本没跑**（与"跑了但失败"完全不同）
//   ③ 读到了、ok=false        → 抓取**跑了但失败**，且能给出具体原因
import { fetchMorningFetchLog } from '../../data/fetch-log.js';
import { _todayDataArrived } from './morning-sync.js';
import { beijingTodayStr } from './auction-pull-window.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { state } from '../app-state.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 额度类失败的关键词（上游返回 403「今日调用额度已用完」） */
const QUOTA_KEYS = ['额度', 'quota', 'Quota', '403'];

/** 从 detail.logs 里挑最能说明问题的一行（优先额度类，其次通用 error）
 *  ⚠️ 导出仅供单测（下划线前缀 = 内部函数，⛔ 业务代码不要直接调）。 */
export function _reasonFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  if (detail.error) return String(detail.error);
  const logs = Array.isArray(detail.logs) ? detail.logs.map(String) : [];
  if (logs.length === 0) return '';
  // ① 先找「额度用尽 / 403」这类根因行 —— 它是整条链失败的源头，比后面的连带错误有用
  for (let i = 0; i < logs.length; i++) {
    if (QUOTA_KEYS.some(function(k) { return logs[i].indexOf(k) !== -1; })) return logs[i];
  }
  // ② 再找明确带失败标记的行
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].indexOf('失败') !== -1 || logs[i].indexOf('错误') !== -1) return logs[i];
  }
  return '';
}

/** 一句话结论：把长日志压成用户能读懂的一句（⛔ 不糊成"网络错误"这种无信息量的话）
 *  ⚠️ 导出仅供单测。 */
export function _humanize(reason) {
  if (!reason) return '';
  if (QUOTA_KEYS.some(function(k) { return reason.indexOf(k) !== -1; })) {
    return '数据源（猫抓 numcat）今日调用额度已用尽，所有 key 都返回 403';
  }
  // 去掉 worker 日志前缀噪音，保留可读部分
  let t = String(reason).replace(/^⚠️?\s*/, '').replace(/^numcat\s+/, 'numcat ');
  if (t.length > 100) t = t.slice(0, 100) + '…';
  return t;
}

/**
 * 诊断「今天早盘竞价行情为什么没有」。
 *
 * @param {string} date 展示日（YYYY-MM-DD）
 * @returns {Promise<{need:boolean, level:string, title:string, text:string}>}
 *          need=false ⇒ 不需要提示（数据已到 / 不是今天 / 非交易日 / 今天压根没有任何行）
 *          level: 'warn'（抓取失败）| 'info'（抓取未执行）
 */
export async function diagnoseTodayAuction(date) {
  const none = { need: false, level: '', title: '', text: '' };
  if (!date) return none;
  // 只诊断「今天」：历史日的缺数据由按天补拉兜底，不吃"今日抓取失败"这套解释
  if (date !== beijingTodayStr()) return none;
  try {
    if (!isTradingDay(date)) return none;
  } catch (e) {
    // 日历读不到 ⇒ 不拦（§10 不因为辅助数据缺失就闭嘴），继续诊断
  }
  // 今天一行都没有 ⇒ 可能只是还没拉，这种情况下"名单未到"另有提示，不叠加本模块
  const rows = (state._auctionMemCache && state._auctionMemCache[date]) || [];
  if (rows.length === 0) return none;
  // 行情已经到齐 ⇒ 无需提示
  if (_todayDataArrived(date)) return none;

  const covered = rows.length;
  const head = '今日竞价行情尚未抓取到（名单已就绪 ' + covered + ' 只）';

  let logs;
  try {
    logs = await fetchMorningFetchLog(date);
  } catch (e) {
    // ① 读不到日志 ⇒ 只说事实，⛔ 不猜原因
    return {
      need: true,
      level: 'info',
      title: head,
      text: '抓取日志暂时读不到，无法确定原因。可稍后刷新一次再看；数据到齐会自动显示。',
    };
  }

  // ② 有日志
  if (Array.isArray(logs) && logs.length > 0) {
    const row = logs[0];
    if (row && row.ok === false) {
      const reason = _humanize(_reasonFromDetail(row.detail));
      return {
        need: true,
        level: 'warn',
        title: head,
        text: (reason ? reason + '。' : '自动抓取失败。')
          + '这是后台数据源的问题，不是你操作或网速的问题，反复刷新不会让它变好（刷新还会重跑一遍历史补齐，反而更卡）。',
      };
    }
    // ok=true 但行情仍没到 ⇒ 抓到的是别的时点 / 数据还在写入，如实说"再等等"
    return {
      need: true,
      level: 'info',
      title: head,
      text: '后台抓取记录显示成功，行情可能还在写入，稍等一会儿；到齐后会自动刷新。',
    };
  }

  // ③ 没有任何记录 ⇒ 抓取没跑（与"跑了但失败"不同，⛔ 别混成一句）
  return {
    need: true,
    level: 'info',
    title: head,
    text: '今天还没有自动抓取记录（定时任务可能未触发）。这不是你的操作问题，稍后再刷新一次即可。',
  };
}

/** 仅供测试 / 诊断 */
export function _resetFetchHealthForTest() {
  _dbgLog('[FETCH-HEALTH] 重置（测试用）');
}
