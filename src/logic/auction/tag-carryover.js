/**
 * tag-carryover.js — 「打标签股票次日继承」单一真相（§6 唯一数据来源 / §16 业务模块拆分）
 *
 * ## 产品口径（2026-09-08 定稿）
 * 长按股票名或序号 → 打标签（买入 / 卖出 / 持有）。用户靠这些标签复盘自己买对/卖对，
 * 因此**当天打过标签的股票，次一交易日必须出现在早盘竞价列表里**，无论它：
 *   ① 次日仍在 9:25 正式名单（最近多板成分股）里；
 *   ② 次日只出现在观察组（前一日竞昨高光继承）里；
 *   ③ 次日既不在正式名单、也不在观察组里。
 * 继承身份统一为「观察组」（obsAutoAdded=true）：不进正式成员索引，不占 9:25 名单口径。
 *
 * ## 为什么独立成模块
 * 该口径同时被三处消费，必须只有一个实现，避免再次出现「各写一套、互相打架」：
 *   1. `ensureBoughtStocksForDate`（tagTitles/rules.js）—— 渲染前补行；
 *   2. `ensureStockInNextDay`（auction/stock-sync.js）—— 打标签瞬间立即补行，即时可见；
 *   3. worker / Edge Function 的抓取名单（服务端，读 auction_board_tags 表）。
 *
 * ## 真相层级
 *   标签持久真相 → Supabase 表 auction_board_tags(date, stock, tag)，经 auctionTagStore 读取
 *   本地列表      → Data 层内存缓存 getAuctionData()（state._auctionMemCache）
 *   继承行身份    → obsAutoAdded=true（观察组），不写正式成员索引
 *
 * ## 边界
 *   - 只继承「上一交易日」的标签，与 deriveAuctionTagState 的继承口径一致（只继承一天），
 *     杜绝空壳行自我复制导致的"越传越多"反馈环。
 *   - 只补行、不删行；读取失败/标签未就绪时返回空集合，绝不把"未就绪"当成"没有标签"（§10/§11）。
 */
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getAuctionData, markAuctionDirty, scheduleCloudPush } from '../app-core-api.js';
import { _dbgLog } from '../../data/debug-log.js';
import { getStockCode } from '../../data/stock-code-map.js';
import { useAuctionTagStore } from '../../stores/auctionTagStore.js';

// 计入继承的标签值（与 LongPressTagMenu 的三个按钮一致）
const CARRY_TAGS = ['buy', 'sell', 'hold'];

/**
 * 读取某一天的全部标签映射 { stockName: tag }。
 * 云端为唯一真相；store 未就绪（读取失败/未加载）时返回空对象，由调用方决定是否重试。
 */
export function getTaggedNamesForDate(date) {
    if (!date) return {};
    try {
        const all = useAuctionTagStore().getAllTagsForDate(date) || {};
        const out = {};
        Object.keys(all).forEach(function(name) {
            const n = String(name || '').trim();
            const t = all[name];
            if (n && CARRY_TAGS.indexOf(t) >= 0) out[n] = t;
        });
        return out;
    } catch (e) {
        _dbgLog('[TAG-CARRY] getTaggedNamesForDate(' + date + ') 读取失败：' + (e && e.message));
        return {};
    }
}

/**
 * 「次日应继承的打标签股票」集合：上一交易日打过 buy/sell/hold 的全部股票名。
 * @param {string} date 目标日期（次一交易日）
 * @returns {Set<string>} 股票名集合；标签源未就绪时返回空 Set（调用方不据此删数据）
 */
export function getCarryOverNamesForDate(date) {
    const out = new Set();
    if (!date) return out;
    const prevDay = getPreviousTradingDay(date);
    if (!prevDay) return out;
    const tagged = getTaggedNamesForDate(prevDay);
    Object.keys(tagged).forEach(function(n) { out.add(n); });
    if (out.size > 0) {
        _dbgLog('[TAG-CARRY] date=' + date + ' 上一交易日(' + prevDay + ')打标签 ' + out.size +
            ' 只：' + [...out].join('、'));
    }
    return out;
}

/**
 * 确保「次日应继承的打标签股票」存在于 date 的本地列表里。
 * 已在列表中的不动（保持其正式成员/观察组身份与已有数据）；缺失的补一条观察组空壳行。
 *
 * @param {string} date 目标日期
 * @param {string[]} [extraNames] 额外强制补入的股票名（打标签瞬间立即生效用）
 * @returns {number} 本次新增行数
 */
export function ensureTaggedCarryOverForDate(date, extraNames) {
    if (!date) return 0;
    const auctionData = getAuctionData();
    const dayList = auctionData[date] || [];
    const existing = new Set();
    dayList.forEach(function(r) {
        if (r && r.stock) existing.add(r.stock.trim());
    });

    const names = new Set();
    (extraNames || []).forEach(function(n) {
        if (n && String(n).trim()) names.add(String(n).trim());
    });
    getCarryOverNamesForDate(date).forEach(function(n) { names.add(n); });

    let added = 0;
    names.forEach(function(n) {
        if (existing.has(n)) return;
        dayList.push({
            stock: n,
            code: getStockCode(n) || '',
            volume: '',
            yestVolume: '',
            note: '',
            // 观察组身份：进观察组分栏、不进正式成员索引、不计入 9:25 名单与强度统计
            obsAutoAdded: true
        });
        existing.add(n);
        added++;
    });

    if (added > 0) {
        auctionData[date] = dayList;
        markAuctionDirty(date);
        scheduleCloudPush();
        _dbgLog('[TAG-CARRY] date=' + date + ' 补入打标签继承行 ' + added +
            ' 只（' + dayList.length + ' 行），已标记脏日期并安排上云服务');
    }
    return added;
}
