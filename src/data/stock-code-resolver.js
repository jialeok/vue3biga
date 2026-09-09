// stock-code-resolver.js — 「股票名称 → 6 位代码」解析服务（Data 层，§5）
//
// 【为什么需要单独一个模块】
// 旧实现（stocks.js#searchTickerCodeByName / auction-numcat.js#_autoFillMissingCodes）
// 依赖同花顺 `/api/meta/tickers/search?q=中文名`，实测该接口**只支持按代码反查**：
//   q=600371    → 返回 { ticker:'600371', name:'万向德农' }   ✅
//   q=万向德农  → item 恒为空                                 ❌
//   q=平安银行  → item 恒为空                                 ❌
// 也就是说自动补码功能从来没成功过：观察组继承票 / 手动粘贴票只要不在 stockcodemap 里，
// 就会被「缺少代码映射」静默跳过 → 表现为「这只票整天没有数据」（9/9 万向德农事故）。
//
// 【可行通道】同花顺成分股列表接口 `/api/a-share-index/constituents/ths-stock-list`
// 返回 { thscode, ticker, name }，是唯一能按中文名反查代码、且不消耗猫抓额度的通道。
// 实测覆盖：
//   000001.SH（上证综指）→ 2228 只（含 万向德农 600371 / 千金药业 600479）
//   399106.SZ（深证综指）→ 2938 只（含 沃特股份 002886）
// 两者合并 ≈ 5166 只，覆盖全 A 主板/创业板。
//
// 【红线】
//   §10 读取失败 ≠ 空数据：拉取失败时不写入缓存、不返回空 Map，下次仍会重试。
//   §8  结果不落 localStorage；解析到的映射由 Logic 层写入云端 stockcodemap（唯一持久真相）。

import { fuyaoApiGet } from './api/fuyao-proxy.js';
import { _dbgLog } from './debug-log.js';

// 覆盖全 A 的宽基指数（顺序无所谓，结果合并去重）
const UNIVERSE_INDEXES = ['000001.SH', '399106.SZ'];

let _nameCodeMap = null;   // { 名称: 6位代码 } 内存缓存（单次会话内复用）
let _inflight = null;      // 单飞：并发调用只拉一次

/**
 * 加载「全 A 名称→代码」表（内存缓存）。
 * @param {boolean} [force=false] 强制重新拉取
 * @returns {Promise<Object>} { 名称: 代码 }
 */
export async function loadUniverseNameCodeMap(force) {
    if (_nameCodeMap && !force) return _nameCodeMap;
    if (_inflight) return _inflight;
    _inflight = (async function() {
        const m = {};
        await Promise.all(UNIVERSE_INDEXES.map(async function(thscode) {
            try {
                const data = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: thscode });
                const items = (data && data.item) || [];
                items.forEach(function(it) {
                    if (!it || !it.name || !it.ticker) return;
                    m[String(it.name).trim()] = String(it.ticker).trim();
                });
            } catch (e) {
                // §10：单只指数失败不能污染整体结论，但必须留痕，且不得缓存空结果
                _dbgLog('[CODE-RESOLVER] 成分股 ' + thscode + ' 拉取失败: ' + (e && e.message || e));
            }
        }));
        const n = Object.keys(m).length;
        if (n > 0) {
            _nameCodeMap = m;
            _dbgLog('[CODE-RESOLVER] 名称→代码表已加载，共 ' + n + ' 只');
        } else {
            _dbgLog('[CODE-RESOLVER] 名称→代码表加载为空（上游异常），本会话不缓存');
        }
        return _nameCodeMap || m;
    })();
    try {
        return await _inflight;
    } finally {
        _inflight = null;
    }
}

/**
 * 按股票名称批量解析代码。
 * @param {string[]} names 股票名称数组
 * @returns {Promise<Object>} { 名称: 代码 }（解析不到的名称不出现在结果里）
 */
export async function resolveCodesByNames(names) {
    const out = {};
    const list = (names || []).map(function(n) { return String(n || '').trim(); }).filter(Boolean);
    if (list.length === 0) return out;
    const map = await loadUniverseNameCodeMap();
    list.forEach(function(n) {
        const code = map[n];
        if (code) out[n] = code;
    });
    return out;
}

/** 仅供测试/调试：清空内存缓存 */
export function _resetStockCodeResolverCache() {
    _nameCodeMap = null;
    _inflight = null;
}
