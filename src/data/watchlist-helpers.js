// 历史趋势只读选择器（纯读取，无副作用，不触及核心同步逻辑）
// 从 watchlist-and-metrics.js 物理拆分而来，原导出通过 barrel re-export 保留，外部 import 路径不变。
import { state } from '../logic/app-state.js';
import { getNumericVolume } from './supabase-client.js';
import { _dbgLogVerbose } from './debug-log.js';

// 查询某只股票在某日期的曲线数据
// 阶段三 E：auction 数据源改读 _auctionMemCache（含 in_watchlist true/false 全部行，供趋势图历史查询）
// 从指定缓存里读某股票某日的字段值（供 getStockHistoryValue 主读+回退复用）
// [PERF-CORE] 按数组引用缓存 股票名→行 映射（含长度校验，行增删自动重建），
// 把 getStockHistoryValue 的每次 O(n) 线性 find 降为 O(1)。
// 信号集合函数（平行/竞昨/差值）每只股票要查 2 个字段 × 2 个缓存，
// 原来一次看板计算要执行上万次 trim 比较，是"分组后处理"耗时主因之一。
state._histRowMapCache = new WeakMap(); // rows数组 -> { len, map }
export function _histRowMapFor(rows) {
    let e = state._histRowMapCache.get(rows);
    if (!e || e.len !== rows.length) {
        const map = new Map();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r && r.stock) {
                const k = r.stock.trim();
                if (!map.has(k)) map.set(k, r);
            }
        }
        e = { len: rows.length, map: map };
        state._histRowMapCache.set(rows, e);
    }
    return e.map;
}
export function _readHistoryValueFrom(rows, stockName, field) {
    if (!rows) return null;
    const found = _histRowMapFor(rows).get(stockName);
    if (!found) return null;
    if (field === 'changePct') {
        // change_pct 存的是字符串，如 "+3.25%" / "-1.08%"，解析成数字（百分比数值本身，不除以100）
        const raw = found.change_pct || found.changePct || '';
        if (!raw) return null;
        const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
        return isNaN(num) ? null : num;
    }
    if (field === 'aucPctChg') {
        // auc_pct_chg（五日竞价涨幅）：与 change_pct 同源，存的是字符串如 "+3.25%"，解析成数字
        const raw = found.auc_pct_chg || found.aucPctChg || '';
        if (!raw) return null;
        const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
        return isNaN(num) ? null : num;
    }
    // 当日竞价指标（仅 market_metrics 有，不进历史趋势，只取当日值）
    if (field === 'umVol') {
        const raw = found.um_vol != null ? String(found.um_vol) : '';
        return raw.trim() !== '' ? raw : null;
    }
    if (field === 'openBidPct') {
        const raw = found.open_bid_pct != null ? String(found.open_bid_pct) : '';
        return raw.trim() !== '' ? raw : null;
    }
    if (field === 'aucVolRatio') {
        const raw = found.auc_vol_ratio != null ? String(found.auc_vol_ratio) : '';
        return raw.trim() !== '' ? raw : null;
    }
    if (field === 'aucTurnover') {
        const raw = found.auc_turnover != null ? String(found.auc_turnover) : '';
        return raw.trim() !== '' ? raw : null;
    }
    if (field === 'volume') {
        return getNumericVolume(found.volume);
    }
    // 本地内存行常用 camelCase yestVolume，云端/历史表用 snake_case yest_volume，两者都要兼容
    return getNumericVolume(found.yest_volume || found.yestVolume);
}

// 趋势图历史取数（含两个 tab 影子数据共享）：
// 本 tab 缓存优先；本 tab"该日没有这只股票的行"或"行里该字段为空"时，
// 回退读另一个 tab 的全量缓存（auction ↔ hot 互为影子数据源）。
// 【纯读取共享】不写任何一个表、不复制任何数据——两个 tab 第一页的股票数量、
// in_watchlist 归属、sync 逻辑完全不受影响；哈药股份这类只在热门股票 tab
// 存在的股票，永远不会因此出现在早盘竞价第一页（第一页渲染不经过本函数）。
// 两边都有数据但值不同时，本 tab 的值优先（只有本 tab 缺失才用对方的）。
export function getStockHistoryValue(date, stockName, field, dataSource='auction') {
    const primaryCache = dataSource === 'hot' ? state._hotFullRowCache : state._auctionMemCache;
    const fallbackCache = dataSource === 'hot' ? state._auctionMemCache : state._hotFullRowCache;
    const primaryVal = _readHistoryValueFrom(primaryCache[date], stockName, field);
    if (primaryVal !== null) return primaryVal;
    // 本 tab 缺失 → 回退另一个 tab 的影子数据
    const fallbackVal = _readHistoryValueFrom(fallbackCache[date], stockName, field);
    if (fallbackVal !== null) return fallbackVal;
    // 热门股票：再回退 hot_stock_trends 独立缓存（抓取程序/Worker 写入的历史趋势数据）
    if (dataSource === 'hot' && state._hotTrendsCache && state._hotTrendsCache[date]) {
        return _readHistoryValueFrom(state._hotTrendsCache[date], stockName, field);
    }
    // [DEBUG] 三处缓存均未命中，记录关键信息帮助定位"刷新后消失"
    _dbgLogVerbose('[HIST-MISS] date=' + date + ' stock=' + stockName + ' field=' + field +
        ' dataSource=' + dataSource +
        ' primaryRows=' + (primaryCache[date] ? primaryCache[date].length : 'null') +
        ' fallbackRows=' + (fallbackCache[date] ? fallbackCache[date].length : 'null') +
        ' hotTrendsRows=' + ((state._hotTrendsCache && state._hotTrendsCache[date]) ? state._hotTrendsCache[date].length : 'null'));
    return null;
}
