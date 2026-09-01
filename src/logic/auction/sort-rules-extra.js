        // "连续竞跌天数"：从 T 日开始往回看，连续 volume 递减（允许相等）的天数。
        // 最多看 5 天（T..T-5 共 6 个数据点）。
        // 若序列全等（无严格递减），天数为 0。
        // 返回 Map<股票名称, 下跌天数>。
        import { getGroupData } from '../app-core-api.js';
        import { getNumericVolume } from '../../data/supabase-client.js';
        import { getStockHistoryValue, hydrateStockHistoryRow } from '../../data/watchlist-and-metrics.js';
        import { _signalCache, _signalFpFor } from './sort-rules.js';
        import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
        import { getAuctionStockHistory } from '../tagTitles/rules.js';

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
        //   ① 五日涨幅(changePct)连续跌天数 >= 1（从最近交易日往回数，连续为负的天数）；
        //   ② 当日竞价涨幅（专用字段 auc_pct_chg）>= 0（止跌/企稳/反转信号）。
        // 返回 Map<股票名称, 连跌天数>，仅含「弱转强」达标股票。
        // 连跌天数口径：基于 getAuctionStockHistory 的每日 changePct（五日涨幅），从今天往回数
        //   连续 changePct<0 的天数；遇到 >=0 或字段缺失即停止（保守：缺失不计入连跌）。
        //   绝不读 auc_pct_chg 算连跌——连跌看「五日涨幅」、竞价涨幅是单独的 ② 条件。
        export function getWeakStrongSet(dateStr, dataSource='auction') {
            const __k = 'ws|' + (dataSource || 'auction') + '|' + dateStr;
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
            // [WEAK-STRONG 2026-09-01 FIX] 早盘竞价仅拉当日数据，过去交易日的 change_pct 需按需 hydrate。
            // 此处 fire-and-forget 触发补水（含去重），state 为 reactive，hydrate 完成后会触发 viewData 重算，
            // 从而自然刷新「弱转强」排序与高光。不同步 await，避免阻塞渲染。
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();
                let d = dateStr;
                for (let i = 0; i < MAX_DAYS; i++) {
                    const prev = getPreviousTradingDay(d);
                    if (!prev) break;
                    hydrateStockHistoryRow(prev, name, dataSource);
                    d = prev;
                }
            });
            const result = new Map();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();
                // 条件②：当日竞价涨幅（专用字段 auc_pct_chg）必须 >= 0
                const todayAuc = _parseWeakStrongAucPct(item);
                if (todayAuc === null || todayAuc < 0) return;
                // 条件①：五日涨幅连续跌天数 >= 1
                const downStreak = _getConsecutiveDownDays(name, dateStr, dataSource, MAX_DAYS);
                if (downStreak >= 1) result.set(name, downStreak);
            });
            if (__sc && __fp !== null && result.size > 0) __sc[__k] = { fp: __fp, value: result };
            return result;
        }

        function _parseWeakStrongAucPct(rawItem) {
            if (!rawItem) return null;
            const raw = rawItem.auc_pct_chg || rawItem.aucPctChg || rawItem.changePct || rawItem.change_pct || '';
            const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
            return isFinite(num) ? num : null;
        }

        function _parseChangePct(raw) {
            if (raw === null || raw === undefined) return null;
            const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
            return isFinite(num) ? num : null;
        }

        // 从最近交易日往回数，连续「五日涨幅(changePct)<0」的天数（最多 MAX_DAYS 天）。
        // [WEAK-STRONG 2026-09-01 FIX] 早盘竞价 9:25 当日涨幅尚未产生（change_pct 为 null）→ 前置缺失应「跳过」而非「中断」，
        // 否则所有股票连跌天数都会被 null 归零、弱转强集合恒空。已开始连跌后中途缺失才视为中断。
        function _getConsecutiveDownDays(name, dateStr, dataSource, maxDays) {
            const history = getAuctionStockHistory(name, dateStr, maxDays, dataSource); // 正序：早→晚
            let streak = 0;
            let started = false;
            for (let i = history.length - 1; i >= 0; i--) {
                const v = _parseChangePct(history[i].changePct);
                if (v === null) {
                    if (!started) continue; // 前置缺失（如当日涨幅未产生）→ 跳过不计入连跌
                    break; // 已开始连跌后遇缺失 → 连跌中断（保守）
                }
                started = true;
                if (v < 0) streak++;
                else break; // 涨幅>=0 → 连跌中断
            }
            return streak;
        }
