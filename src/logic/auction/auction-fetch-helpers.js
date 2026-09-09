// auction-fetch-helpers.js — 竞价「抓取名单 / 代码映射」单一真相（Logic 层，§15）
//
// 收敛两类此前散落在 auction-numcat.js / auction-ths.js 里各写一遍的判定：
//
//  1) isAuctionFetchTarget：抓取名单口径 = 当日【正式成员 ∪ 观察组继承行】，排除 market_metrics 影子行。
//     观察组打标签继承票（如 9/9 万向德农）不在 _getAuctionWatchlistSet 里，若被过滤 → 全天无数据。
//
//  2) ensureAuctionCodeMapping：抓取前自动补全缺失的股票代码。
//     解析走 data/stock-code-resolver.js（同花顺宽基成分股反查，不占猫抓额度），
//     补到的代码写回内存 state._scMapCache + 云端 stockcodemap（跨设备复用，§8 不落 localStorage）。
//
// 同花顺侧原先【完全没有】这段代码，所以只要 stockcodemap 缺一行，
// 同花顺那 7 个按钮对这只票就是永久失效——这是「点了没数据」的一类根因。

import { state } from '../app-state.js';
import { _dbgLog } from '../../data/debug-log.js';
import { loadCloudStockCodeMap, upsertStockCodeMap } from '../../data/stock-code-map.js';
import { resolveCodesByNames } from '../../data/stock-code-resolver.js';

/**
 * 抓取名单口径（单一真相）。
 * @param {object} s 竞价行
 * @param {Set<string>} wset 当日正式成员集合（_getAuctionWatchlistSet(date)）
 */
export function isAuctionFetchTarget(s, wset) {
    if (!s || !s.stock) return false;
    const name = String(s.stock).trim();
    if (!name) return false;
    return wset.has(name) || s.obsAutoAdded === true; // 正式成员 或 观察组继承行
}

/**
 * 抓取前确保列表里的股票都有代码。
 * 只补「确实缺失」的：行内已有 s.code，或云端映射已有 → 不动。
 *
 * @param {Array<object>} list 竞价行数组（会就地写入 s.code）
 * @returns {Promise<{filled:number, failed:string[], missing:number}>}
 *          filled 补到的只数；failed 仍缺代码的名称（供状态栏点名提示）
 */
export async function ensureAuctionCodeMapping(list) {
    const rows = (list || []).filter(function(s) { return s && s.stock; });
    if (rows.length === 0) return { filled: 0, failed: [], missing: 0 };

    if (!state._scMapCache) state._scMapCache = {};
    if (Object.keys(state._scMapCache).length === 0) {
        try {
            await loadCloudStockCodeMap();
        } catch (e) {
            _dbgLog('[CODE-MAP] 云端代码映射加载失败: ' + (e && e.message || e));
        }
    }
    const scMap = state._scMapCache || {};

    const missingNames = [];
    const seen = new Set();
    rows.forEach(function(s) {
        const name = String(s.stock).trim();
        if (!name || seen.has(name)) return;
        if ((s.code || '').trim() || scMap[name]) return;
        seen.add(name);
        missingNames.push(name);
    });
    if (missingNames.length === 0) return { filled: 0, failed: [], missing: 0 };

    let resolved = {};
    try {
        resolved = await resolveCodesByNames(missingNames);
    } catch (e) {
        _dbgLog('[CODE-MAP] 名称→代码解析失败: ' + (e && e.message || e));
    }

    const pairs = [];
    const failed = [];
    rows.forEach(function(s) {
        const name = String(s.stock).trim();
        if (!name) return;
        let code = String(s.code || '').trim() || scMap[name] || '';
        if (!code && resolved[name]) code = resolved[name];
        if (!code) {
            if (missingNames.indexOf(name) >= 0) failed.push(name);
            return;
        }
        scMap[name] = code;
        if (!s.code) s.code = code;
        if (resolved[name]) pairs.push({ stock: name, code: code });
    });

    if (pairs.length > 0) {
        try {
            await upsertStockCodeMap(pairs);
            _dbgLog('[CODE-MAP] 自动补全代码 ' + pairs.length + ' 只: ' + pairs.map(function(p) { return p.stock + '=' + p.code; }).join('、'));
        } catch (e) {
            // §10：写云失败不能静默——内存已可用，但必须留痕，否则下次还会重复解析
            _dbgLog('[CODE-MAP] upsertStockCodeMap 失败（内存已补全，云端未落库）: ' + (e && e.message || e));
        }
    }
    if (failed.length > 0) {
        _dbgLog('[CODE-MAP] 仍缺代码 ' + failed.length + ' 只: ' + failed.join('、'));
    }
    return { filled: pairs.length, failed: failed, missing: missingNames.length };
}
