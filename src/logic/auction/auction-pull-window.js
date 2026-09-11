// auction-pull-window.js — 竞价数据「拉取窗口」单一真相（Logic 层）
//
// 【为什么需要这个模块】
// 改造前首屏 `pullAuctionFromTable()` 无条件全表拉取三张大表：
//   auction_watchlist 11600 行(12 页) + market_metrics(scope=auction) 7225 行(8 页)
//   + market_metrics(scope=hot) 2317 行(3 页) = 23 次【串行】HTTP。
// Supabase 单次响应上限 1000 行（页数无法消灭），实测单页 0.7~2.0s
//   → 早盘 9:25 打开页面要冻结 25~40 秒才出数据，这正是「数据源没法及时显示」的根因。
//
// 【本模块的方案】两阶段拉取，既不牺牲数据完整性，也不拖慢首屏：
//   阶段①（阻塞）：只拉最近 N 个自然日 —— 覆盖趋势图(5 交易日) / 弱转强(T-1..T-4) /
//                   竞昨并行 / 龙头排位 全部诉求，约 5 页并发请求 ≈ 2 秒。
//   阶段②（后台）：更早的历史在空闲时补齐，完成后再 emit 一次刷新。
//   兜底：用户切到窗口外的日期时，`ensureAuctionDateDataLoaded` 单独补拉那一天。
//
// 【§11 删除安全声明】本模块只影响「读」的范围。所有写路径都是按日期的 patch/upsert，
// 因此「内存里没有某天」绝不会导致云端那天的行被删除。
import { pullAuctionMarketDataForDate } from '../../data/watchlist-and-metrics.js';
import { state } from '../app-state.js';
import { _emit } from '../../stores/eventBus.js';
import { _dbgLog } from '../../data/debug-log.js';

/**
 * 首屏拉取窗口：最近多少个【自然日】。
 * 取 30 而不是 10：10 个自然日遇到长假（国庆/春节）会掉出 5 个交易日，
 * 导致趋势图近 5 日缺腿；30 天足以覆盖任意假期，且行数仍控制在 ~5 页内。
 */
export const AUCTION_RECENT_WINDOW_DAYS = 30;

/** 北京时区当日 YYYY-MM-DD（与 goToday() 同口径，不用 UTC 避免跨日错位） */
export function beijingTodayStr() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

/** 首屏窗口起点日期：今天往前推 AUCTION_RECENT_WINDOW_DAYS 个自然日 */
export function getAuctionRecentSinceDate() {
    const now = new Date();
    const base = new Date(now.getTime() - AUCTION_RECENT_WINDOW_DAYS * 86400000);
    const local = new Date(base.getTime() - base.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

// ===== 老日期按天补拉（用户切到窗口外日期时的兜底）=====
const _inflightDates = new Set();
const _loadedOnce = new Set();

/**
 * 确保某个日期的竞价数据已在内存；没在就单独拉这一天。
 * 幂等 + 单飞（同一天并发调用只会产生一次网络请求，§32 禁止重复请求）。
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<boolean>} 本次是否真的拉取了（false = 内存已有，无需请求）
 */
export async function ensureAuctionDateDataLoaded(date) {
    if (!date) return false;
    if (_loadedOnce.has(date)) return false;
    // 内存已有数组（哪怕是空数组也说明这一天云端确实没有数据，不再重复请求）
    if (state._auctionMemCache && Array.isArray(state._auctionMemCache[date])) {
        _loadedOnce.add(date);
        return false;
    }
    if (_inflightDates.has(date)) return false;
    _inflightDates.add(date);
    try {
        await pullAuctionMarketDataForDate(date);
        _loadedOnce.add(date);
        return true;
    } catch (e) {
        // §10：失败不许伪装成空数据——不标记已加载，下次还能重试
        _dbgLog('[AUCTION-DATE-LOADER] date=' + date + ' 补拉失败: ' + (e && e.message || e));
        return false;
    } finally {
        _inflightDates.delete(date);
    }
}

/**
 * 供 UI 层调用：日期切换后把该日数据补进内存，成功后触发竞价看板重渲染。
 * @returns {Promise<boolean>} 是否拉取过（拉取过才需要 emit）
 */
export async function ensureAuctionDateAndRefresh(date) {
    const pulled = await ensureAuctionDateDataLoaded(date);
    if (pulled) _emit('auction-refresh');
    return pulled;
}

/** 仅供测试/诊断：清空「已加载」记忆（正常业务流程不需要调用） */
export function _resetAuctionDateLoaderMemo() {
    _inflightDates.clear();
    _loadedOnce.clear();
}
