import { _setGetLocalTodayStr } from './trading-day-helpers.js';
import { _dbgLog, _dbgLogVerbose } from '../data/debug-log.js';
import { getStockHistoryValue, _isAuctionWatchlistStock, _addAuctionWatchlistMember } from '../data/watchlist-and-metrics.js';
import { getJingYestHighlightSetForDate } from './auction-sort-rules.js';
import { getPreviousTradingDay, isTradingDay } from './trading-day-helpers.js';
import { getStocksData } from '../data/supabase-client.js';
import { getStockCode } from '../data/stock-code-map.js';
import { getAuctionData, scheduleCloudPush, markAuctionDirty } from './app-core-api.js';
import { state } from './app-state.js';

        export function deriveAuctionTagState(name, date, _cache, inheritOnly) {
            const result = { sold: false, bought: false, selected: false, source: 'none' };
            if (!name || !date) return result;
            const stocksData = getStocksData();
            let todayRec;
            if (_cache && _cache.todayMap) {
                todayRec = _cache.todayMap.get(name);
            } else {
                todayRec = (stocksData[date] || []).find(function(s) { return s && s.name && s.name.trim() === name; });
            }
            if (!inheritOnly && todayRec) {
                if (todayRec.sold === true) { result.sold = true; result.source = 'today'; }
                else if (todayRec.bought === true) { result.bought = true; result.source = 'today'; }
                else if (todayRec.hold === true) { result.selected = true; result.source = 'today'; }
                return result;
            }
            const prevDay = getPreviousTradingDay(date);
            if (prevDay) {
                let prevRec;
                if (_cache && _cache.prevMap) {
                    prevRec = _cache.prevMap.get(name);
                } else {
                    prevRec = (stocksData[prevDay] || []).find(function(s) { return s && s.name && s.name.trim() === name; });
                }
                const prevIsInheritedOnly = prevRec && prevRec.inheritedHold === true && prevRec.bought !== true;
                // [REFACTOR 2026-08-14] 区分买入/持有/卖出继承
                if (prevRec && !prevIsInheritedOnly && prevRec.sold === true) {
                    result.sold = true; result.source = 'inherited';
                } else if (prevRec && !prevIsInheritedOnly && prevRec.sold !== true && prevRec.bought === true) {
                    result.bought = true; result.source = 'inherited';
                } else if (prevRec && !prevIsInheritedOnly && prevRec.sold !== true && prevRec.hold === true) {
                    result.selected = true; result.source = 'inherited';
                }
            }
            return result;
        }


        // 配合 deriveAuctionTagState 的 _cache 参数使用：为指定 date 预建 {todayMap, prevMap}。
        // todayMap/prevMap 均为 姓名(trim后)→记录 的 Map，供同一次渲染内所有 deriveAuctionTagState
        // 调用复用，避免 O(每行 × stocksData长度) 的重复线性扫描。
        export function _buildTagStateCache(date) {
            const stocksData = getStocksData();
            const prevDay = getPreviousTradingDay(date);
            const todayMap = new Map();
            (stocksData[date] || []).forEach(function(s) { if (s && s.name) todayMap.set(s.name.trim(), s); });
            const prevMap = new Map();
            if (prevDay) {
                (stocksData[prevDay] || []).forEach(function(s) { if (s && s.name) prevMap.set(s.name.trim(), s); });
            }
            return { todayMap, prevMap };
        }

        // 方案 B：applyDerivedTagToRow 已删除。
        // 标签不再写入 auctionData 行（bought/sold/fixed 不存储），渲染时由
        // deriveAuctionTagState 实时派生。selected 保留在 auctionData 上但仅代表手动点选。
        // 旧的"标签同步"机制（applyDerivedTagToRow ↔ ensureBoughtStocksForDate 互相打架）
        // 彻底消除，根因（汇得科技死循环、华电能源幽灵买、莫名灰色卖出）一并根治。

        // 一次性标签清洗（stockApp_v42_tag_cleanse_v1）。
        // 方案 B 后：auctionData 不再存储 bought/sold/fixed 派生位，无需清洗。
        // 保留 flag 避免重复执行，函数体简化为 no-op。
        export async function cleanseAuctionTagsOnce() {
            const FLAG = 'stockApp_v42_tag_cleanse_v1';
            try { if (localStorage.getItem(FLAG)) return; } catch (e) { return; }
            try { localStorage.setItem(FLAG, JSON.stringify({ time: new Date().toISOString(), skipped: 'planB' })); } catch (e) {}
            _dbgLog('[TAG-CLEANSE] 方案 B：auctionData 不再存储派生标签，跳过清洗');
        }

        // 返回本地"今天"日期字符串（YYYY-MM-DD），与 goToday() 使用同一套本地时区取法，
        // 避免用 UTC（new Date().toISOString().slice(0,10)）导致的跨时区错位。
        export function _getLocalTodayStr() {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        _setGetLocalTodayStr(_getLocalTodayStr);

        // 前一天"竞/昨"实际高光（蓝色高光）达标股票，自动带入当天观察组（早盘竞价 tab 专属）：
        // 与 ensureBoughtStocksForDate 平行，但继承的是"前一天竞昨高光集合"而非"买卖标签"。
        // 口径与界面显示、"竞/昨数"统计保持一致（统一走 getJingYestHighlightSetForDate）。
        // 历史锁定：只对"今天及以后"生效（允许预览下一交易日），历史日期只读不改——
        // 避免在查看历史日期时，用当前 prevDay 高光集回溯改写已保存好的历史列表。
        // [恢复说明] 该函数曾在本项目拆分时遗失，导致观察组只显示"恰好已在当天列表里"的前日高光，
        // 而非完整的前一日竞昨集合（表现为 8/13 观察组只剩 2 只而非应继承的 6 只）。此处按原版逻辑恢复。
        export function ensureObservationStocks(date) {
            if (!date) return;
            const today = _getLocalTodayStr();
            // 历史锁定：只对"今天及以后"生效（允许预览下一交易日）。打开/查看历史日期时绝不自动继承或清理任何股票，
            // 只如实显示保存时的样子。
            if (date < today) return;
            // 非交易日（周末/节假日）不自动继承上一交易日股票，避免非交易日被填充上一交易日数据。
            if (!isTradingDay(date)) {
                _dbgLog('[OBS-ENSURE] ' + date + ' 非交易日，跳过观察组继承');
                return;
            }

            const prevDay = getPreviousTradingDay(date);
            if (!prevDay) return;

            _dbgLog('[OBS-ENSURE] === 调用开始 === date=' + date + ' prevDay=' + prevDay);

            // 上一交易日"竞/昨"实际高光（蓝色高光）达标股票，口径与界面显示、"竞/昨数"统计保持一致
            const obsStocksRaw = getJingYestHighlightSetForDate(prevDay);
            if (!obsStocksRaw || obsStocksRaw.size === 0) {
                // 数据未就绪时不设标记，等待下次渲染重试（数据加载完成后快照缓存会有值）
                _dbgLog('[OBS-ENSURE] === 调用结束（提前返回）=== prevDay=' + prevDay + ' 高光集合为空（数据可能未就绪），本轮不处理，等下次渲染重试');
                return;
            }
            _dbgLog('[OBS-ENSURE] prevDay=' + prevDay + ' 高光集合 ' + obsStocksRaw.size + ' 只：' + [...obsStocksRaw].join('、'));

            // 观察组 = 符合竞昨条件（平行+差值>0）的股票，与手动买卖标签无关（含已卖出）。
            const obsStocks = new Set(obsStocksRaw);

            const auctionData = getAuctionData();
            const dayList = auctionData[date] || [];
            const existingNames = new Set(dayList.map(function(s) { return s.stock ? s.stock.trim() : ''; }));

            // 已自动添加的股票名集合（与 ensureBoughtStocksForDate 共用 obsAutoAdded_<date>）
            const autoAdded = JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]');
            const autoAddedSet = new Set(autoAdded);

            const signature = [...obsStocks].sort().join('|');
            const alreadyEnsured = localStorage.getItem('obsEnsured_' + date) === signature;

            let hasNew = false;
            const _beforeLen = dayList.length;

            if (!alreadyEnsured) {
                obsStocks.forEach(function(name) {
                    if (!existingNames.has(name)) {
                        // 不在当日列表中 → 自动添加为观察组正式成员（空壳行，待抓取/手动补量）
                        dayList.push({ stock: name, code: getStockCode(name), volume: '', yestVolume: '', note: '', obsAutoAdded: true });
                        _addAuctionWatchlistMember(date, name);
                        autoAddedSet.add(name);
                        hasNew = true;
                    }
                });
            }

            if (hasNew) {
                _dbgLog('[OBS-ENSURE] date=' + date + ' before=' + _beforeLen + ' after=' + dayList.length);
                auctionData[date] = dayList;
                markAuctionDirty(date);
                scheduleCloudPush();
            }

            localStorage.setItem('obsAutoAdded_' + date, JSON.stringify([...autoAddedSet]));
            localStorage.setItem('obsEnsured_' + date, signature);
            _dbgLog('[OBS-ENSURE] === 调用结束 === 应继承' + obsStocks.size + '只，本轮' + (hasNew ? '有变动(' + _beforeLen + '→' + dayList.length + '条)' : '无变动') + '，signature=' + (alreadyEnsured ? '一致跳过' : '已重算'));
        }

        // 买入/持有/卖出股票进次日观察组（早盘竞价 tab 专属，与 ensureObservationStocks 平行）：
        // 只继承一天，不会无限往后传——判断依据只看 getStocksData()[昨天]（点击"卖/买/持有"
        // 标签直接写入的权威数据，只有用户在股票列表页手动新增/编辑/复制过的股票才会出现在这里）。
        // 之前的实现读的是 auctionData[prevDay]，但观察组自动补入的空壳行也会写进 auctionData，
        // 一旦某只股票被自动补入过一次，哪怕之后完全没人管它，也会靠着自己产生的空壳记录
        // 一天天无限传递下去——造成"很久以前的旧股票、没有当天数据也一直出现"的问题。
        // 改成只看 getStocksData() 后，由于该数据只在用户真正操作时才会写入，
        // 观察组自动补入的空壳股票不会出现在这里，自然只继承一天。
        //   · 今日列表没有 → 自动加入：in_watchlist=true（进第一页）+ obsAutoAdded=true
        //     （观察组语义，导入时受 8617 行的继承保护不被冲掉）+ 延续昨天是"买"/"持"/"卖"的标记
        //   · 今日已有（比如最近多板本来就有）→ 不动任何数据，只把名字记入 obsBought_<date> 集合
        // [BUG-FIX 2026-07-27] 已卖出（sold=true）的股票也纳入继承：用户要求卖出标签同样进入次日观察组。
        // "买"/"持"/"卖"字显示：渲染层按当天实时标签（isBought/isSelected/isSold，来自 getStocksData()[state.currentDate]
        // 的实时同步）优先判断，只有当天没有再打标签时才回退用 obsBought_<date> 集合的继承快照；
        // 这样如果继承进来后又用"复制到交易日"等方式把标签改成了"持"，上标会跟着变，不会锁死成"买"。
        // 观察组继承来的（obsAutoAdded=true）即使 bought=true 也不给红色背景（用户明确不要背景）。
        //
        // 防重复机制说明（曾经的坑）：原来用一个死板的 'boughtEnsured_<date>'='1' 标记，一旦设置
        // 就永久跳过，本意是"不要把用户手动从观察组删掉的股票强行加回来"。但这导致只要标记
        // 曾经被设置过（哪怕是旧版本代码、或数据还没就绪时的一次执行），后续代码逻辑升级、
        // 或者"昨日持有名单"发生变化，都不会重新计算——表现为"某只股票明明该进观察组，
        // 但页面上死活不出现"。现在改为签名机制：签名 = 当前应继承的持有名单（排序拼接），
        // 名单变化就重新跑一次补入逻辑。权威来源只认 getStocksData()，无记录即清除。
        // [REFACTOR 2026-08-14] 重写标签继承逻辑：
        // 观察组 = 前一日竞昨高光集 + 前一日【观察组内】打标签的股票（obsBought_）
        // 常规组 = watchlist + 前一日【常规组内】打标签的股票（regularBought_，自动添加到列表）
        // 卖出也继承（要观察）。只继承一天：跳过 inheritedHold 的仅继承记录。
        // 历史日期只清理不添加。
        export function ensureBoughtStocksForDate(date) {
            if (!date) return;
            const today = _getLocalTodayStr();
            const isHistorical = date < today;
            if (!isTradingDay(date)) {
                _dbgLog('[BOUGHT-ENSURE] ' + date + ' 非交易日，跳过');
                return;
            }
            const prevDay = getPreviousTradingDay(date);
            if (!prevDay) return;
            _dbgLog('[BOUGHT-ENSURE] === 调用开始 === date=' + date + ' prevDay=' + prevDay);

            const prevStocksTags = getStocksData()[prevDay];
            if (!prevStocksTags || prevStocksTags.length === 0) {
                _dbgLog('[BOUGHT-ENSURE] === 调用结束 === getStocksData[' + prevDay + '] 为空');
                return;
            }

            // 前一日竞昨高光集（决定观察组/常规组归属）
            const prevObsSet = getJingYestHighlightSetForDate(prevDay);

            // 分两组继承
            const obsInherited = [];
            const regularInherited = [];
            prevStocksTags.forEach(function(s) {
                if (!s || !s.name) return;
                const name = s.name.trim();
                const isInheritedOnly = s.inheritedHold === true && s.bought !== true;
                if (isInheritedOnly) return;
                const hasTag = s.bought === true || s.hold === true || s.sold === true;
                if (!hasTag) return;
                if (prevObsSet && prevObsSet.has(name)) {
                    obsInherited.push(name);
                } else {
                    regularInherited.push(name);
                }
            });
            _dbgLog('[BOUGHT-ENSURE] 观察组继承 ' + obsInherited.length + ' 只，常规组继承 ' + regularInherited.length + ' 只');

            localStorage.setItem('obsBought_' + date, JSON.stringify(obsInherited));
            localStorage.setItem('regularBought_' + date, JSON.stringify(regularInherited));

            const auctionData = getAuctionData();
            const dayList = auctionData[date] || [];
            const existingNames = new Set(dayList.map(function(s) { return s.stock ? s.stock.trim() : ''; }));
            const _existingRowMap = {};
            dayList.forEach(function(s) { if (s && s.stock) _existingRowMap[s.stock.trim()] = s; });

            // 回溯清理：移除旧逻辑残留的错误 obsAutoAdded/regularAutoAdded
            const _validObsNames = new Set([...obsInherited, ...(prevObsSet || [])]);
            const _validRegularNames = new Set(regularInherited);
            let _cleanedCount = 0;
            dayList.forEach(function(row) {
                if (!row || !row.stock) return;
                const n = row.stock.trim();
                if (row.obsAutoAdded === true && !_validObsNames.has(n)) {
                    row.obsAutoAdded = undefined;
                    _cleanedCount++;
                }
                if (row.regularAutoAdded === true && !_validRegularNames.has(n)) {
                    row.regularAutoAdded = undefined;
                    _cleanedCount++;
                }
            });
            if (_cleanedCount > 0) {
                auctionData[date] = dayList;
                markAuctionDirty(date);
                scheduleCloudPush();
                _dbgLog('[BOUGHT-ENSURE] 回溯清理 ' + _cleanedCount + ' 只错误行');
            }

            if (isHistorical) {
                _dbgLog('[BOUGHT-ENSURE] === 调用结束（历史，只清理）=== obs=' + obsInherited.length + ' reg=' + regularInherited.length + ' 清理=' + _cleanedCount);
                return;
            }

            let hasNew = false;
            const autoAdded = JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]');
            const autoAddedSet = new Set(autoAdded);

            function _addOne(name, isObs) {
                if (existingNames.has(name)) {
                    const row = _existingRowMap[name];
                    const _isFormal = _isAuctionWatchlistStock(date, name);
                    const flag = isObs ? 'obsAutoAdded' : 'regularAutoAdded';
                    if (row && (!_isFormal || row[flag] !== true)) {
                        _addAuctionWatchlistMember(date, name);
                        row[flag] = true;
                        if (!((row.code || '').trim())) {
                            const c = getStockCode(name);
                            if (c) row.code = c;
                        }
                        hasNew = true;
                        if (isObs) autoAddedSet.add(name);
                    }
                    return;
                }
                const newRow = { stock: name, code: getStockCode(name), volume: '', yestVolume: '', note: '' };
                if (isObs) { newRow.obsAutoAdded = true; autoAddedSet.add(name); }
                else { newRow.regularAutoAdded = true; }
                dayList.push(newRow);
                _addAuctionWatchlistMember(date, name);
                hasNew = true;
            }

            obsInherited.forEach(function(n) { _addOne(n, true); });
            regularInherited.forEach(function(n) { _addOne(n, false); });

            if (hasNew) {
                auctionData[date] = dayList;
                markAuctionDirty(date);
                scheduleCloudPush();
            }
            localStorage.setItem('obsAutoAdded_' + date, JSON.stringify([...autoAddedSet]));
            _dbgLog('[BOUGHT-ENSURE] === 调用结束 === obs=' + obsInherited.length + ' reg=' + regularInherited.length + ' 新增=' + hasNew);
        }

        export function getAuctionStockHistory(stockName, endDate, count, dataSource='auction') {
            const days = [];
            let d = endDate;
            for (let i = 0; i < count; i++) {
                if (!d) break;
                // 优先 auction 本地缓存数据，回退 scraper_raw_data 缓存（对比日曲线）
                days.push({
                    date: d,
                    volume: getStockHistoryValue(d, stockName, 'volume', dataSource),
                    yestVolume: getStockHistoryValue(d, stockName, 'yestVolume', dataSource),
                    changePct: getStockHistoryValue(d, stockName, 'changePct', dataSource),
                    aucPctChg: getStockHistoryValue(d, stockName, 'aucPctChg', dataSource)
                });
                d = getPreviousTradingDay(d);
            }
            return days.reverse(); // 正序：从早到晚
        }

        // 将 'YYYY-MM-DD' 格式化为 'MM-DD' 用于图表横轴标签
