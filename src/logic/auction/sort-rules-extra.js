        // "连续竞跌天数"：从 T 日开始往回看，连续 volume 递减（允许相等）的天数。
        // 最多看 5 天（T..T-5 共 6 个数据点）。
        // 若序列全等（无严格递减），天数为 0。
        // 返回 Map<股票名称, 下跌天数>。
        import { ref } from 'vue';
        import { getGroupData } from '../app-core-api.js';
        import { getNumericVolume } from '../../data/supabase-client.js';
        import { getStockHistoryValue, getAuctionChangePctHistory } from '../../data/watchlist-and-metrics.js';
        import { _signalCache, _signalFpFor } from './sort-rules.js';
        import { getPreviousTradingDay } from '../date/trading-day-helpers.js';

        export function getThreeDayJingDieSet(dateStr, dataSource='auction') {
            const __k = 'tdjd|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = _signalCache;
            let __fp = null;
            if (__sc && _signalFpFor) {
                __fp = _signalFpFor(dateStr, dataSource);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            const MAX_DAYS = 5;
            const auctionData = getGroupData(dataSource);
            const todayList = auctionData[dateStr] || [];
            const result = new Map();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();
                const vol0 = getNumericVolume(item.volume);
                if (vol0 === null || vol0 <= 0) return;
                let curDate = dateStr;
                let curVol = vol0;
                let declineDays = 0;
                let hasStrictDecline = false;
                for (let i = 0; i < MAX_DAYS; i++) {
                    const prevDate = getPreviousTradingDay(curDate);
                    if (!prevDate) break;
                    const prevVol = getStockHistoryValue(prevDate, name, 'volume', dataSource);
                    if (prevVol === null || prevVol <= 0) break;
                    if (curVol <= prevVol) {
                        declineDays++;
                        if (curVol < prevVol) hasStrictDecline = true;
                        curDate = prevDate;
                        curVol = prevVol;
                    } else {
                        break;
                    }
                }
                if (declineDays > 0 && hasStrictDecline) {
                    result.set(name, declineDays);
                }
            });
            if (__sc && __fp !== null && result.size > 0) __sc[__k] = { fp: __fp, value: result };
            return result;
        }

        // ===== 弱转强（2026-09-01）=====
        // 定义（两条件必须同时满足）：
        //   ① 前 4 个交易日「五日涨幅(changePct)」连续跌天数 >= 2（不含当日快照；至少连续 2 个交易日下跌才算“连跌”，单日下跌不算弱转强）；
        //      “跌”定义：changePct <= 0（0% 视为跌，0% 是真实值非空数值）；从最近的前一交易日往回数，遇 changePct>0 中断。
        //   ② 当日竞价涨幅（专用字段 auc_pct_chg）>= 0（止跌/企稳/反转信号）。
        // 返回 Map<股票名称, 连跌天数>，仅含「弱转强」达标股票。
        // 注意：本集合由 loadWeakStrongSet（异步批量拉取历史 change_pct 后写入 weakStrongSetRef）驱动，
        // 不再在同步 computed 内做 fire-and-forget hydrate——那依赖脆弱的模块缓存响应式重算，不可靠（实测恒空）。
        // 这是与「五日竞价涨幅」趋势图(loadTrendHistory)一致的显式异步加载模式。
        export const weakStrongSetRef = ref(null); // Map<name, downStreak> | null（仅 toggle 开启时有值）

        export function getWeakStrongSet(dateStr, dataSource = 'auction') {
            return weakStrongSetRef.value;
        }

        let _wsLoadingPromise = null;
        export function loadWeakStrongSet(dateStr, dataSource = 'auction') {
            if (_wsLoadingPromise) return _wsLoadingPromise;
            _wsLoadingPromise = (async () => {
                try {
                    const auctionData = getGroupData(dataSource);
                    const todayList = auctionData[dateStr] || [];
                    // 条件②：当日竞价涨幅（专用字段 auc_pct_chg）>= 0
                    const candidates = [];
                    todayList.forEach(item => {
                        if (!item || !item.stock) return;
                        const name = item.stock.trim();
                        const todayAuc = _parseWeakStrongAucPct(item);
                        if (todayAuc === null || todayAuc < 0) return;
                        candidates.push(name);
                    });
                    if (candidates.length === 0) {
                        weakStrongSetRef.value = new Map();
                        return;
                    }
                    // 条件①：批量拉取前 4 个交易日（T-1..T-4，不含当日快照）的 change_pct（一次 in 查询，避免逐股 hydrate）
                    const dates = [];
                    let d = dateStr;
                    for (let i = 0; i < 4; i++) {
                        const p = getPreviousTradingDay(d);
                        if (!p) break;
                        dates.push(p);
                        d = p;
                    }
                    const hist = dates.length ? await getAuctionChangePctHistory(dates, dataSource) : new Map();
                    const result = new Map();
                    for (const name of candidates) {
                        const downStreak = _countConsecutiveDown(name, dates, hist);
                        if (downStreak >= 2) result.set(name, downStreak); // 至少连续 2 天下跌才算“连跌”
                    }
                    weakStrongSetRef.value = result;
                } catch (e) {
                    weakStrongSetRef.value = new Map();
                } finally {
                    _wsLoadingPromise = null;
                }
            })();
            return _wsLoadingPromise;
        }

        function _parseWeakStrongAucPct(rawItem) {
            if (!rawItem) return null;
            const raw = rawItem.auc_pct_chg || rawItem.aucPctChg || rawItem.changePct || rawItem.change_pct || '';
            const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
            return isFinite(num) ? num : null;
        }

        // 基于批量拉取的 hist（Map<date, Map<stock, num>>）从最近的前一交易日(T-1)往回数连续「changePct<=0」的天数。
        // “跌”含 0%（0% 是真实值，非空缺）；遇 changePct>0 或数据缺失(null/undefined) 即中断（保守，不臆测缺失为跌）。
        function _countConsecutiveDown(name, dates, hist) {
            let streak = 0;
            for (let i = 0; i < dates.length; i++) {
                const dayMap = hist.get(dates[i]);
                const v = dayMap ? dayMap.get(name) : undefined;
                if (v === undefined || v === null) break; // 数据缺失 → 无法确认连跌，中断
                if (v <= 0) streak++;                       // 跌（含 0%）
                else break;                                 // 涨幅>0 → 连跌中断
            }
            return streak;
        }
