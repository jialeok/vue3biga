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
// 【★ 2026-11-05 第三轮：单靠上游成分股反查不行，必须多级兜底】
// 用户第 9 次报障「上海洗霸和大洋电机也没有当天数据」，E2E 复现：
//   日志「展示名单 78 只，其中带 6 位代码 76 只」⇒ 2 只被静默滤掉 ⇒ 竞价量永远 '-'。
// 逐层取证得到两个硬事实：
//   ① `stockcodemap` **不是全量表**：分页拉全表实测只有 **1130 行**（全市场 5000+），
//      上海洗霸(603200) / 大洋电机(002249) 这两个名字它一条都没有。
//   ② 唯一能按中文名反查的上游（宽基成分股 ths-stock-list）**当前被 `FUYAO_OFF` 总闸拦着**
//      （见 data/api/fuyao-proxy.js：只有竞价快照路径被「受控放行」），
//      所以本文件原来那条腿在线上是**完全失效**的 —— 一次都没成功过。
// 结论：解析顺序必须是「本地已有的真数据优先，上游兜底最后」。
//
// 【解析链（逐级收敛，能用上一级就绝不发下一级请求 —— §32）】
//   ① 内存缓存 `state._scMapCache`（同步读，0 请求）
//   ② `stockcodemap` 表（名称权威表，但不全量）
//   ③ `market_metrics` 里该股票**最近带 code 的行** —— worker 抓取时落的真值
//   ④ `auction_watchlist` 里该股票最近带 code 的行（③ 漏掉的再兜一层）
//   ⑤ 同花顺宽基成分股反查（覆盖全 A ≈5166 只，但受 FUYAO_OFF 限制，放行时才有效）
//
// 【红线】
//   §10 读取失败 ≠ 空数据：任何一级失败都**不当作「这只票没有代码」** —— 记日志继续往下兜，
//       全链走完仍为空才是真的查不到（调用方据此跳过这只有明确理由）。
//   §40 只查表/查上游，⛔ 不猜代码（不按前缀、谐音、补零推断）。
//   §8  结果不落 localStorage；持久化由 Logic 层写云端 stockcodemap（唯一持久真相）。
//   §6  内存缓存的写入只走 `stock-code-map.js#rememberStockCodes`（唯一写入者）。

import { fuyaoApiGet } from './api/fuyao-proxy.js';
import { getSupabase } from './supabase-client.js';
import { getStockCode, rememberStockCodes } from './stock-code-map.js';
import { _dbgLog } from './debug-log.js';

// 覆盖全 A 的宽基指数（顺序无所谓，结果合并去重）
const UNIVERSE_INDEXES = ['000001.SH', '399106.SZ'];
// 第 ⑤ 级的受控放行参数：与竞价快照同款（没有 timeoutMs 的一律拒绝，见 fuyao-proxy.js）
const UNIVERSE_TIMEOUT_MS = 12000;
// ③④ 两级最多每只票看多少天的历史行（按 date 倒序，只要最近的一个非空 code）
const HIST_DAYS_PER_STOCK = 6;

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
                // ★ 必须显式传 allowWhenOff + timeoutMs，否则会在 `new URL` 之前被总闸抛掉
                //   （2026-11-05 同款事故：ths-today-patch 的快照腿就是这么静默死了好几天）
                const data = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list',
                    { thscode: thscode }, { allowWhenOff: true, timeoutMs: UNIVERSE_TIMEOUT_MS });
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
 * 从某张「行里有 stock + code」的表里，按名字批量取最近的 code。
 *
 * 为什么按 date 倒序取「最近一行」而不是查全量：同一只票有几百个交易日，
 *   全量拉回来只为拿一个代码是浪费；`order(date desc)` + `limit` 让服务端帮我们收敛。
 *
 * @param {string} table 'market_metrics' | 'auction_watchlist'
 * @param {string[]} names
 * @param {Object} out 结果累加器 { 名称: 代码 }
 * @returns {Promise<number>} 本次新解析到的只数
 */
async function _fillFromHistoryTable(table, names, out) {
    const miss = (names || []).filter(function(n) { return n && !out[n]; });
    if (miss.length === 0) return 0;
    const sb = getSupabase();
    const { data, error } = await sb.from(table)
        .select('stock,code,date')
        .in('stock', miss)
        // ⚠️ 必须用 `not('code','is',null)`：PostgREST 的 `neq` 遇 NULL 不放行（历史踩坑），
        //    写 `code=neq.''` 会把这些行整批漏掉，且零报错。
        .not('code', 'is', null)
        .order('date', { ascending: false })
        .limit(Math.min(1000, miss.length * HIST_DAYS_PER_STOCK));
    if (error) throw error;
    let n = 0;
    (data || []).forEach(function(row) {
        if (!row || !row.stock || !row.code) return;
        const name = String(row.stock).trim();
        const code = String(row.code).trim();
        if (!name || !/^\d{6}$/.test(code)) return;
        if (out[name]) return;      // 按 date 倒序 ⇒ 先到的就是最近的
        out[name] = code;
        n++;
    });
    return n;
}

/**
 * 按股票名称批量解析代码（五级兜底，见文件头）。
 *
 * @param {string[]} names 股票名称数组
 * @returns {Promise<Object>} { 名称: 6位代码 }（解析不到的名称不出现在结果里）
 */
export async function resolveCodesByNames(names) {
    const out = {};
    const list = Array.from(new Set((names || [])
        .map(function(n) { return String(n || '').trim(); })
        .filter(Boolean)));
    if (list.length === 0) return out;

    // ① 内存缓存（同步，0 请求）
    list.forEach(function(n) {
        const c = getStockCode(n);
        if (c) out[n] = c;
    });
    const left = function() { return list.filter(function(n) { return !out[n]; }); };
    if (left().length === 0) return out;

    // ② stockcodemap（名称权威表 —— 但实测不全量，⛔ 不能当唯一通道）
    try {
        const sb = getSupabase();
        const { data, error } = await sb.from('stockcodemap').select('stock,code').in('stock', left());
        if (error) throw error;
        (data || []).forEach(function(row) {
            if (!row || !row.stock || !row.code) return;
            const name = String(row.stock).trim();
            const code = String(row.code).trim();
            if (!name || !/^\d{6}$/.test(code)) return;
            if (!out[name]) out[name] = code;
        });
    } catch (e) {
        _dbgLog('[CODE-RESOLVER] stockcodemap 查询失败，继续走历史行兜底: ' + (e && e.message || e));
    }

    // ③ market_metrics 里该股票最近带 code 的行
    if (left().length > 0) {
        try { await _fillFromHistoryTable('market_metrics', list, out); } catch (e) {
            _dbgLog('[CODE-RESOLVER] market_metrics 兜底失败: ' + (e && e.message || e));
        }
    }

    // ④ auction_watchlist 里该股票最近带 code 的行
    if (left().length > 0) {
        try { await _fillFromHistoryTable('auction_watchlist', list, out); } catch (e) {
            _dbgLog('[CODE-RESOLVER] auction_watchlist 兜底失败: ' + (e && e.message || e));
        }
    }

    // ⑤ 同花顺宽基成分股反查（覆盖全 A；受 FUYAO_OFF 限制，放行时才有效）
    if (left().length > 0) {
        try {
            const map = await loadUniverseNameCodeMap();
            left().forEach(function(n) {
                const c = map && map[n];
                if (c && /^\d{6}$/.test(String(c).trim())) out[n] = String(c).trim();
            });
        } catch (e) {
            _dbgLog('[CODE-RESOLVER] 宽基成分股反查失败（不影响已解析到的）: ' + (e && e.message || e));
        }
    }

    // 回写内存缓存：让后续**同步**路径（getStockCode / 视图层壳行注入）也能命中，0 请求
    if (Object.keys(out).length > 0) rememberStockCodes(out);

    const unresolved = left();
    _dbgLog('[CODE-RESOLVER] 名称→代码 ' + Object.keys(out).length + '/' + list.length
        + (unresolved.length ? ' ⚠️ 五级兜底都查不到：' + unresolved.slice(0, 8).join(',') : ''));
    return out;
}

/** 仅供测试/调试：清空内存缓存 */
export function _resetStockCodeResolverCache() {
    _nameCodeMap = null;
    _inflight = null;
}
