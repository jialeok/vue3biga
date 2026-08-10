import { _dbgLog, _dbgLogVerbose } from '../data/debug-log.js';
import { getStockHistoryValue, _isAuctionWatchlistStock, _addAuctionWatchlistMember } from '../data/watchlist-and-metrics.js';
import { getPreviousTradingDay, isTradingDay } from './trading-day-helpers.js';
import { getStocksData } from '../data/supabase-client.js';
import { getStockCode } from '../data/stock-code-map.js';
import { getAuctionData, scheduleCloudPush, markAuctionDirty } from './app-core.js';
import { state } from './app-state.js';

        export function deriveAuctionTagState(name, date, _cache) {
            const result = { sold: false, bought: false, selected: false, source: 'none' };
            if (!name || !date) return result;
            const stocksData = getStocksData();
            let todayRec;
            if (_cache && _cache.todayMap) {
                todayRec = _cache.todayMap.get(name);
            } else {
                todayRec = (stocksData[date] || []).find(function(s) { return s && s.name && s.name.trim() === name; });
            }
            if (todayRec) {
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
                // 关键防护：前一日记录若"仅"是继承来的（inheritedHold===true 且用户未在该日期手动确认
                // bought=true），不再往下传——这是"只继承一天"的核心硬限制。
                // 但如果用户在继承来的日期上重新标记了"买"(bought=true)，那是真实确认，应当可以继续
                // 传递。copyToTomorrow 产生的记录只有 hold=true+inheritedHold=true（没有 bought=true），
                // 仍会被正确阻断；用户手动补标 bought=true 后才会放行。
                const prevIsInheritedOnly = prevRec && prevRec.inheritedHold === true && prevRec.bought !== true;
                // [BUG-FIX 2026-07-27] 卖出标签也要进入次日观察组：前一日卖出的股票，次日仍显示卖出标记，
                // 但只在次日生效（只继承一天），之后不再继续传递——因为继承来源只看 stocksData 前一日。
                if (prevRec && !prevIsInheritedOnly && prevRec.sold === true) {
                    result.sold = true; result.source = 'inherited';
                } else if (prevRec && !prevIsInheritedOnly && prevRec.sold !== true && (prevRec.bought === true || prevRec.hold === true)) {
                    result.selected = true; result.source = 'inherited';
                }
            }
            _dbgLogVerbose('[TAG-STATE] ' + name + ' @ ' + date + ' sold=' + result.sold + ' bought=' + result.bought + ' selected=' + result.selected + ' source=' + result.source);
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
        export function ensureBoughtStocksForDate(date) {
            if (!date) return;
            const today = _getLocalTodayStr();
            // 历史锁定：与 ensureObservationStocks 一致，只对"今天及以后"生效（允许预览下一交易日），历史日期只读不改。
            if (date < today) return;
            const isPreview = date > today;
            // [BUG-FIX 2026-07-26] 非交易日（周末/节假日）不自动继承买入/持有股票，
            // 与 ensureObservationStocks 保持一致，避免非交易日被填充上一交易日数据。
            if (!isTradingDay(date)) {
                _dbgLog('[BOUGHT-ENSURE] ' + date + ' 非交易日，跳过买入继承');
                return;
            }

            const prevDay = getPreviousTradingDay(date);
            if (!prevDay) return;

            // [DEBUG-VUE-FIX 2026-07-25] 默认可见的执行摘要（不依赖 _DBG_VERBOSE 开关）。
            // 之前只有 hasNew=true 时才走默认可见的 _dbgLog，导致"函数没跑"和"跑了但
            // 没变化"在日志里完全区分不出来——诊断报告只能看 localStorage[boughtEnsured_*]
            // 有没有设置来间接猜测，容易误判成"数据丢失/继承失败"。现在每次调用都留痕。
            _dbgLog('[BOUGHT-ENSURE] === 调用开始 === date=' + date + ' prevDay=' + prevDay);

            _dbgLogVerbose('[BOUGHT-ENSURE] enter date=' + date + ' prevDay=' + prevDay);
            try { _dbgLog('[BOUGHT-ENSURE] enter date=' + date + ' prevDay=' + prevDay); } catch(e){}

            // 权威来源只用 getStocksData()（点击"卖/买/持有"标签直接写入的地方，
            // 只有用户真正操作过的股票才会出现），不再看 auctionData[prevDay]。
            const prevStocksTags = getStocksData()[prevDay];
            // 昨天完全没有手动标签数据 → 数据未就绪，等下次渲染重试，不设标记（与观察组同一语义）
            if (!prevStocksTags || prevStocksTags.length === 0) {
                _dbgLog('[BOUGHT-ENSURE] === 调用结束（提前返回）=== window.getStocksData[' + prevDay + '] 为空，本轮不处理，等下次渲染重试');
                _dbgLogVerbose('[BOUGHT-ENSURE] window.getStocksData[' + prevDay + '] 为空，return。注意：若昨日在竞价看板点过"买"但未同步到股票列表页，这里读不到');
                return;
            }
            _dbgLogVerbose('[BOUGHT-ENSURE] prevStocksTags 共 ' + prevStocksTags.length + ' 条');

            // [BUG-FIX 2026-07-27] 买入/持有/卖出标签的股票都进入次日观察组。
            // 只继承一天：明天看的是明天的 getStocksData()[明天前一天]，不会无限往后传。
            const holdingNames = [];
            prevStocksTags.forEach(function(s) {
                if (!s || !s.name) return;
                const nameTrim = s.name.trim();
                const wasSold = s.sold === true;
                const wasBought = s.bought === true;
                const wasHeld = s.hold === true;
                if (wasSold || wasBought || wasHeld) {
                    holdingNames.push(nameTrim);
                    _dbgLogVerbose('[BOUGHT-ENSURE] 命中 ' + nameTrim + ' | sold=' + wasSold + ' bought=' + wasBought + ' hold=' + wasHeld);
                }
            });
            _dbgLogVerbose('[BOUGHT-ENSURE] holdingNames 共 ' + holdingNames.length + ' 只：' + (holdingNames.length > 0 ? holdingNames.join('、') : '(无)'));

            // 对照打印：auctionData[prevDay] 中 bought=true/sold=true 的股票——排查"竞价看板有标签但 stocksData 没有"的数据不一致
            try {
                const _aucPrev = (getAuctionData()[prevDay] || []).filter(function(s) { return s && s.stock; });
                const _aucTaggedNames = _aucPrev.filter(function(s) { return s.bought === true || s.sold === true || s.hold === true; }).map(function(s) { return s.stock.trim(); });
                _dbgLogVerbose('[BOUGHT-ENSURE] 对照 auctionData[' + prevDay + '] 有标签 共 ' + _aucTaggedNames.length + ' 只：' + (_aucTaggedNames.length > 0 ? _aucTaggedNames.join('、') : '(无)'));
                const _leak = _aucTaggedNames.filter(function(n) { return holdingNames.indexOf(n) < 0; });
                if (_leak.length > 0) {
                    _dbgLogVerbose('[BOUGHT-ENSURE] ⚠️ 竞价看板有标签但 stocksData 未记录（会丢失继承）：' + _leak.join('、'));
                }
            } catch (e) {
                _dbgLogVerbose('[BOUGHT-ENSURE] 对照 auctionData 异常：' + e.message);
            }

            const auctionData = getAuctionData();
            const dayList = auctionData[date] || [];
            const existingNames = new Set(dayList.map(function(s) { return s.stock ? s.stock.trim() : ''; }));
            const autoAdded = JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]');
            const autoAddedSet = new Set(autoAdded);
            // （已删除 obsBoughtRemoved_ "用户手动删除不再加回"机制：该键在全代码库只有读取、
            // 从未有任何写入，是失效的死代码；删除不影响任何现有行为）
            _dbgLogVerbose('[BOUGHT-ENSURE] 今日已有 ' + existingNames.size + ' 只');

            // 检查今日 auctionData 是否已完整正确包含所有 holdingNames（含：是否正式成员/obsAutoAdded）。
            // 这是签名机制的关键：不只是看 holdingNames 名单有没有变，还要看今日列表里这些股票是否真正存在且字段正确。
            // 否则会出现"用户删除了早盘竞价tap里某只观察组股票的卡片 / 股票在数据里但是影子记录"，
            // 而 holdingNames 没变签名一致就跳过，永远不会重新补入/修正——表现为"怎么复制都不显示"。
            // 方案2：用 _auctionWatchlistIndex 判断是否正式成员
            const _existingRowMap = {};
            dayList.forEach(function(s) { if (s && s.stock) _existingRowMap[s.stock.trim()] = s; });
            const _missingOrWrong = [];
            holdingNames.forEach(function(n) {
                const row = _existingRowMap[n];
                if (!row) {
                    _missingOrWrong.push(n + '(缺失)');
                } else if (!_isAuctionWatchlistStock(date, n) || row.obsAutoAdded !== true) {
                    _missingOrWrong.push(n + '(字段错:formal=' + _isAuctionWatchlistStock(date, n) + ',oa=' + row.obsAutoAdded + ')');
                }
            });
            // 签名 = 应继承名单 + 今日实际完整性状态。缺失/字段错时签名变化（|miss），全部正确时 |ok。
            // 名单变、股票被删、字段被改坏——都会让签名变化触发重跑；全部正确且名单没变才跳过。
            const signature = holdingNames.slice().sort().join('|') + '|v3|' + (_missingOrWrong.length === 0 ? 'ok' : 'miss:' + _missingOrWrong.length);
            if (_missingOrWrong.length === 0 && localStorage.getItem('boughtEnsured_' + date) === signature) {
                _dbgLog('[BOUGHT-ENSURE] === 调用结束（签名一致，跳过）=== 持有' + holdingNames.length + '只，今日列表已完整正确，无需改动');
                _dbgLogVerbose('[BOUGHT-ENSURE] 签名一致且今日完整跳过（boughtEnsured_' + date + '=' + signature + '）');
                return;
            }
            _dbgLogVerbose('[BOUGHT-ENSURE] 重算（旧=' + (localStorage.getItem('boughtEnsured_' + date) || '(无)') + ' → 新=' + signature + '）');

            // [BUG-FIX 2026-07-27] 记录"昨日买/持/卖"集合——渲染层据此显示"买"/"持"/"卖"字
            localStorage.setItem('obsBought_' + date, JSON.stringify(holdingNames));

            let hasNew = false;
            let addedCount = 0;
            holdingNames.forEach(function(name) {
                if (existingNames.has(name)) {
                    // 已在今日列表：检查字段是否正确。汇得科技曾被作为影子记录存在，
                    // 导致渲染层 getTodayAuction()/getTodayGroupList() 过滤掉它看不到。
                    // 方案2：这里就地修正为正式成员（登记到索引）+观察组+持，让它能被渲染显示。
                    const existingRow = _existingRowMap[name];
                    const _isFormal = _isAuctionWatchlistStock(date, name);
                    if (existingRow && (!_isFormal || existingRow.obsAutoAdded !== true)) {
                        _dbgLogVerbose('[BOUGHT-ENSURE] ⚠️ 修正已有行字段 ' + name + ' | 旧 isFormal=' + _isFormal + ' obsAutoAdded=' + existingRow.obsAutoAdded);
                        _addAuctionWatchlistMember(date, name);
                        existingRow.obsAutoAdded = true;
                        // [CODEMAP-FIX] 顺带补 code（如果这一行本来就缺）
                        if (!((existingRow.code || '').trim())) {
                            const _mapCode = getStockCode(name);
                            if (_mapCode) existingRow.code = _mapCode;
                        }
                        // 方案 B：不再写 selected/bought/sold —— 标签由 deriveAuctionTagState 在渲染时派生
                        hasNew = true;
                        addedCount++;
                        autoAddedSet.add(name);
                    } else {
                        _dbgLogVerbose('[BOUGHT-ENSURE] 跳过(今日已有且字段正确) ' + name);
                    }
                    return;
                }
                // 昨日"买"/"持"/"卖"→今日补入观察组（标签由 deriveAuctionTagState 在渲染时派生）。
                // 方案 B：不再写 selected/bought/sold —— 标签由 stocksData 的前一日记录在渲染时派生。
                // 方案2：行对象不携带 in_watchlist，通过 _addAuctionWatchlistMember 登记为正式成员
                // [CODEMAP-FIX] 从 stockcodemap 内存缓存补 code，避免买入继承的股票长期缺代码
                dayList.push({ stock: name, code: getStockCode(name), volume: '', yestVolume: '', note: '', obsAutoAdded: true });
                _addAuctionWatchlistMember(date, name);
                autoAddedSet.add(name);
                hasNew = true;
                addedCount++;
                _dbgLogVerbose('[BOUGHT-ENSURE] ✅ 补入观察组 ' + name);
            });

            if (hasNew) {
                try { _dbgLog('[BOUGHT-ENSURE] date=' + date + ' added=' + addedCount + ' stocks=' + (holdingNames||[]).slice(0,3).join(',')); } catch(e){}
                auctionData[date] = dayList;
                markAuctionDirty(date);
                scheduleCloudPush();
                _dbgLogVerbose('[BOUGHT-ENSURE] 新增/修正 ' + addedCount + ' 只，已写回 auctionData[' + date + ']');
            } else {
                _dbgLogVerbose('[BOUGHT-ENSURE] 本轮无新增');
            }
            localStorage.setItem('obsAutoAdded_' + date, JSON.stringify([...autoAddedSet]));
            localStorage.setItem('boughtEnsured_' + date, signature);
            _dbgLog('[BOUGHT-ENSURE] === 调用结束 === holdingNames=' + holdingNames.length + ' 新增/修正=' + addedCount + ' 缺失或字段错=' + _missingOrWrong.length + (_missingOrWrong.length > 0 ? '（' + _missingOrWrong.join(',') + '）' : ''));
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
                    changePct: getStockHistoryValue(d, stockName, 'changePct', dataSource)
                });
                d = getPreviousTradingDay(d);
            }
            return days.reverse(); // 正序：从早到晚
        }

        // 将 'YYYY-MM-DD' 格式化为 'MM-DD' 用于图表横轴标签
