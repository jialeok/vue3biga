import { state } from './app-state.js';
        // [PERF] 信号函数指纹缓存（模块级，导出供 sort-rules-extra.js 复用）
        export const _signalCache = {};
        export function _viewFpList(list) {
            if (!list || !list.length) return '0';
            var fp = list.length + '|';
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (!it) { fp += '_,'; continue; }
                fp += (it.stock || '') + ':' + (it.volume || '') + ':' + (it.yestVolume || '') + ':' + (it.changePct || '') + ',';
            }
            return fp;
        }
        import { getGroupData } from './app-core-api.js';
        import { getNumericVolume } from '../data/supabase-client.js';
        import { getStockHistoryValue, _histRowMapFor } from '../data/watchlist-and-metrics.js';
        import { _dbgLogVerbose } from '../data/debug-log.js';

        import { getPreviousTradingDay } from './trading-day-helpers.js';


        export function _signalFpFor(dateStr, dataSource) {
            var __g = getGroupData(dataSource);
            var __t1 = getPreviousTradingDay(dateStr);
            return _viewFpList(__g[dateStr]) + '' + _viewFpList(__g[__t1]);
        }

        export function getHighRatioStocksForDate(dateStr, dataSource='auction') {
            // [PERF-CORE] 指纹缓存：同一组输入数据在同帧/多次调用间直接复用结果
            const __k = 'hr|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = _signalCache;
            let __fp = null;
            if (__sc && _viewFpList) {
                const __g = getGroupData(dataSource);
                const __t1 = getPreviousTradingDay(dateStr);
                __fp = _viewFpList(__g[dateStr]) + '' + _viewFpList(__g[__t1]);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            const auctionData = getGroupData(dataSource);
            const todayList = auctionData[dateStr] || [];
            const prevDate = getPreviousTradingDay(dateStr);
            const prevList = prevDate ? (auctionData[prevDate] || []) : [];
            const prevMap = _histRowMapFor(prevList);

            const stockNames = new Set();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const todayVolume = getNumericVolume(item.volume);
                if (todayVolume === null || todayVolume === 0) return;
                const prevItem = prevMap.get(item.stock.trim());
                const prevVolume = prevItem ? getNumericVolume(prevItem.volume) : null;
                if (prevVolume === null || prevVolume === 0) return;
                const ratio = todayVolume / prevVolume;
                const roundedRatio = Math.round(ratio * 10) / 10; // 四舍五入到一位小数，与表格显示的"今/昨比"保持一致
                if (roundedRatio >= 1.5) {
                    stockNames.add(item.stock.trim());
                }
            });
            const __result = { count: stockNames.size, stockNames };
            if (__sc && __fp !== null) __sc[__k] = { fp: __fp, value: __result };
            return __result;
        }

        // 判断"平行"条件：T日竞价量 > T-1交易日竞价量，且 T-1交易日成交量 > T-2交易日成交量
        // 两个条件都满足才算达标；任一环节断点/无数据都判定为不满足
        // 字段说明：某天记录里的"yestVolume"字段，代表的是"该天的前一交易日的总成交量"
        //   因此"T-1交易日自身的总成交量" = 今日(T)记录里的 yestVolume 字段
        //        "T-2交易日自身的总成交量" = T-1记录里的 yestVolume 字段
        // 返回 Set<股票名称>，包含指定日期下所有满足条件的股票
        export function getParallelStocksForDate(dateStr, dataSource='auction') {
            // [PERF-CORE] 指纹缓存：同一组输入数据直接复用结果
            const __k = 'par|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = _signalCache;
            let __fp = null;
            if (__sc && _signalFpFor) {
                __fp = _signalFpFor(dateStr, dataSource);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            const auctionData = getGroupData(dataSource);
            const todayList = auctionData[dateStr] || [];
            const t1Date = getPreviousTradingDay(dateStr);

            const stockNames = new Set();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();

                const todayVolume = getNumericVolume(item.volume);
                // T的yestVolume字段 = T-1交易日自身的总成交量
                const t1OwnVolume = getNumericVolume(item.yestVolume);

                // T-1 竞价量、T-2 成交量 从全量快照缓存查询（含非自选股）
                const t1Volume = getStockHistoryValue(t1Date, name, 'volume', dataSource);
                // T-1的yestVolume字段 = T-2交易日自身的总成交量
                const t2OwnVolume = getStockHistoryValue(t1Date, name, 'yestVolume', dataSource);

                // 条件1：今日竞价量 > T-1交易日竞价量
                if (todayVolume === null || t1Volume === null) return;
                if (!(todayVolume > t1Volume)) return;

                // 条件2：T-1交易日成交量 > T-2交易日成交量
                if (t1OwnVolume === null || t2OwnVolume === null) return;
                if (!(t1OwnVolume > t2OwnVolume)) return;

                stockNames.add(name);
            });
            if (__sc && __fp !== null) __sc[__k] = { fp: __fp, value: stockNames };
            return stockNames;
        }

        // 计算一个正数的十进制位数（字符串长度）。用于"位数差"排序：
        // 位数差 = |今日竞价量位数 - 今日昨日成交量位数|，位数差越小说明竞价量与成交量的量级越接近，视为信号更清晰，排序优先级更高
        // 该定义在"环比"、"平行"、"竞/昨"三个排序场景下保持统一
        export function getDigitCount(num) {
            const intPart = Math.floor(Math.abs(num));
            return String(intPart).length;
        }

        // 计算指定日期下，每只股票的 {diff, digitGap}（不要求满足平行或竞/昨的达标条件，单纯计算数值）：
        //   今/昨比 = 今日竞价量 / T-1交易日竞价量
        //   昨/前比 = 昨日成交量(T记录的yestVolume) / 前日成交量(T-1记录的yestVolume)
        //   diff = 今/昨比 - 昨/前比（可正可负）
        //   digitGap = |今日竞价量位数 - 今日昨日成交量位数|
        // 任一比值无法计算（断点/分母为0）则该股票不在返回结果中
        // 供"环比"排序之外的"平行仅达标(Tier1)"和"竞/昨达标(Tier0)"两个场景共用，避免重复实现
        export function getRatioDiffInfoForDate(dateStr, dataSource='auction') {
            // [PERF-CORE] 指纹缓存：同一组输入数据直接复用结果
            const __k = 'rdi|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = _signalCache;
            let __fp = null;
            if (__sc && _signalFpFor) {
                __fp = _signalFpFor(dateStr, dataSource);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            const auctionData = getGroupData(dataSource);
            const todayList = auctionData[dateStr] || [];
            const t1Date = getPreviousTradingDay(dateStr);

            const infoMap = new Map();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();

                // 今/昨比：今日竞价量 / T-1竞价量（T-1数据从全量快照缓存查询，含非自选股）
                const todayVolume = getNumericVolume(item.volume);
                const t1Volume = getStockHistoryValue(t1Date, name, 'volume', dataSource);
                if (todayVolume === null || t1Volume === null || t1Volume === 0) return;
                const jingRatio = todayVolume / t1Volume;

                // 昨/前比：昨日成交量(今天记录的yestVolume) / 前日成交量(T-1记录的yestVolume)
                const yestVolume = getNumericVolume(item.yestVolume);
                const prevVolume = getStockHistoryValue(t1Date, name, 'yestVolume', dataSource);
                if (yestVolume === null || prevVolume === null || prevVolume === 0) return;
                const yestRatio = yestVolume / prevVolume;

                const digitGap = Math.abs(getDigitCount(todayVolume) - getDigitCount(yestVolume));
                infoMap.set(name, { diff: jingRatio - yestRatio, digitGap, jingRatio });
            });
            if (__sc && __fp !== null) __sc[__k] = { fp: __fp, value: infoMap };
            return infoMap;
        }

        // 判断"竞/昨"条件：必须先满足"平行"条件，再额外要求 今/昨比 > 昨/前比（即 diff > 0）
        // 返回 Map<股票名称, {diff, digitGap}>，key集合是 getParallelStocksForDate 结果的子集，且 diff 必然 > 0
        // 排序时先比 digitGap（从小到大），digitGap 相同再比 diff（从大到小）
        export function getJingYestStocksForDate(dateStr, dataSource='auction') {
            const parallelStockNames = getParallelStocksForDate(dateStr, dataSource);
            const infoMap = getRatioDiffInfoForDate(dateStr, dataSource);

            const stockDiffMap = new Map();
            parallelStockNames.forEach(name => {
                const info = infoMap.get(name);
                if (info && info.diff > 0) {
                    stockDiffMap.set(name, info);
                }
            });
            return stockDiffMap;
        }

        // "竞/昨"实际高光（蓝色高光）股票集合：平行 + 差值 > 0。
        // 界面上显示蓝色高光、"竞/昨数"统计、观察组继承统一使用本集合。
        // 排序 tier0 判定与高光显示口径必须统一调用本函数（同一份返回结果），杜绝分叉。
        export function getJingYestHighlightSetForDate(dateStr, dataSource='auction') {
            // [PERF-CORE] 指纹缓存：该函数在每次看板计算里被调用 3 次以上
            // （当日高光 + 前一日观察组判定 + 排序分支），口径完全一致时直接复用。
            const __k = 'jyh|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = _signalCache;
            let __fp = null;
            if (__sc && _signalFpFor) {
                __fp = _signalFpFor(dateStr, dataSource);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            // 优先实时计算（与抓取程序口径一致：本地 rawData + 全量快照缓存 _auctionMemCache / _hotFullRowCache）
            // 修复历史 Bug：原先优先用云端 daily_highlights 缓存，可能存的是旧的/错误的高光集合，
            // 导致本地数据更新后高光仍显示旧结果（与抓取程序不一致），且推送有 2s debounce + Realtime 延迟 → 延迟感。
            const stockDiffMap = getJingYestStocksForDate(dateStr, dataSource);
            if (stockDiffMap.size > 0) {
                _dbgLogVerbose('[JING-YEST-HL] ' + dateStr + ' 平行+diff>0 共' + stockDiffMap.size + '只：' +
                    [...stockDiffMap].map(function([n, i]) { return n + '(diff=' + (i && i.diff !== undefined ? i.diff.toFixed(2) : '?') + ',dg=' + (i && i.digitGap !== undefined ? i.digitGap : '?') + ')'; }).join('、'));
            }
            let __result;
            if (stockDiffMap.size > 0) {
                __result = new Set([...stockDiffMap].filter(([, info]) => info && info.diff > 0).map(([name]) => name));
            } else {
                __result = new Set();
            }
            if (__sc && __fp !== null) __sc[__k] = { fp: __fp, value: __result };
            return __result;
        }
