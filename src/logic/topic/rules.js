import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { buildTopicCache } from '../../data/stock-topics.js';
import { getStockHistoryTopics, getRankData } from '../app-core-api.js';
import { extractTopics, getDisplayNote } from '../note/helpers.js';
import { state } from '../app-state.js';
import { useUiStore } from '../../stores/uiStore.js';
let _pullCoreTopicsFromCloudFn = null;
let _pushCoreTopicsToCloudFn = null;
export function _setCoreTopicsFns(pull, push) { _pullCoreTopicsFromCloudFn = pull; _pushCoreTopicsToCloudFn = push; }

        let _coreTopicsMemCache = null;

        // ===== core_topics 写入队列（§6 单一真相 + §10 失败必须可见）=================
        // 所有对云端 core_topics 的写入都必须经过这里，⛔ 禁止任何地方直接调 _pushCoreTopicsToCloudFn。
        // 理由（★ 2026-09-18 修「删除核心词没反应 / 前台却像成功」的根因）：
        //   旧实现是 `if (!state._coreTopicsPushingToCloud) { …推送… }` —— 当上一次推送还在飞行中时，
        //   后来的保存被【直接跳过】：不排队、不报错、也不通知调用方。云端因此保留旧值，
        //   界面只靠本地内存看着像成功，一刷新 / 一次重拉就「恢复原样」。
        // 现语义：串行单飞、绝不丢、最后一次写入胜出；返回 Promise 供 UI await 后反馈成败。
        let _coreTopicsPushChain = Promise.resolve();
        function _queueCoreTopicsPush(list) {
            const snapshot = Array.isArray(list) ? list.slice() : [];
            state._coreTopicsPushingToCloud = true;
            const p = _coreTopicsPushChain
                // 前一次失败不阻塞后续（各自失败已由各自调用方反馈），这里只做链路复位
                .catch(function() {})
                .then(function() { return _pushCoreTopicsToCloudFn(snapshot); })
                .finally(function() {
                    // 只有当自己是队尾时才清标志；若已被更新的保存接管，交给它清
                    if (_coreTopicsPushChain === p) state._coreTopicsPushingToCloud = false;
                });
            _coreTopicsPushChain = p;
            return p;
        }

        export async function loadCoreTopicsFromCloud() {
            try {
                const cloudTopics = await _pullCoreTopicsFromCloudFn();
                state._coreTopicsCloudLoaded = true;
                if (!cloudTopics || cloudTopics.length === 0) {
                    const defaultTopics = state.defaultCoreTopics || [];
                    if (defaultTopics.length > 0) {
                        _coreTopicsMemCache = defaultTopics;
                        _dbgLog('[CORE-TOPICS] 云端 core_topics 表为空，推送默认 ' + defaultTopics.length + ' 个核心词到云端');
                        _queueCoreTopicsPush(defaultTopics).catch(function(e) {
                            _dbgLog('[AUCTION-ERR] core_topics 初始化推送失败: ' + (e && e.message || e));
                        });
                    }
                    return;
                }
                const validCloud = cloudTopics.filter(function(t) {
                    return t && typeof t.name === 'string' && t.name.trim();
                });
                if (validCloud.length === 0) {
                    _dbgLog('[CORE-TOPICS] 云端 core_topics 数据无效，使用默认核心词');
                    _coreTopicsMemCache = state.defaultCoreTopics;
                    return;
                }
                _coreTopicsMemCache = validCloud;
                _dbgLog('[CORE-TOPICS] 从云端加载 ' + validCloud.length + ' 个核心词');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] loadCoreTopicsFromCloud 失败: ' + (e && e.message || e));
                _coreTopicsMemCache = state.defaultCoreTopics;
            }
        }

        export function getCoreTopics() {
            if (_coreTopicsMemCache && _coreTopicsMemCache.length > 0) return _coreTopicsMemCache;
            return state.defaultCoreTopics || [];
        }

        // ============ 伪题材（事件标记，不可作为题材分组） ============
        // 背景：核心词表里混进了描述「事件」而非「行业/概念」的词（如 并购重组），
        // 它会被当成题材建组，并把只有这类词的股票整个吸进组里，挤占该股票在真实题材里的名额。
        // [ARCH-V3 §6] 黑名单必须是单一真相：原先 StarStatsBoard / ui-bridge / useAuctionBoard /
        // auction-board-helpers 各自写死 '并购重组' 共 5 份，规则一改必漏改。
        // 这里统一定义，消费端一律走 isPseudoTopic()，不再散落字面量。
        export const PSEUDO_TOPICS = ['并购重组'];

        /**
         * 判断一个核心词/题材名是否为「伪题材」（不做题材分组，只作事件标记）。
         * @param {string} name
         * @returns {boolean}
         */
        export function isPseudoTopic(name) {
            if (!name) return false;
            return PSEUDO_TOPICS.indexOf(String(name).trim()) >= 0;
        }

        /**
         * 取「可用于分组的核心词」= 云端/默认核心词 去掉伪题材。
         * [ARCH-V3 §6] 只读派生，刻意不改 getCoreTopics() 本体：
         *   ① 核心词管理弹窗仍需展示完整清单；
         *   ② saveCoreTopics 回写云端必须保存完整清单，否则会静默删掉用户配置（违反 §10/§11）。
         * @returns {Array<{name:string, synonyms?:string[]}>}
         */
        export function getGroupableCoreTopics() {
            const all = getCoreTopics();
            if (!all || all.length === 0) return [];
            return all.filter(function(c) { return c && !isPseudoTopic(c.name); });
        }

        // core_topics 表 Realtime 回调入口：重拉云端核心词 → 刷新内存缓存与题材分组指纹缓存 → 通知 UI 重渲染。
        // 由 stock-topics.js 的 startCoreTopicsRealtime 在 postgres_changes 触发时调用（运行时调用，不涉模块顶层求值，安全）。
        export async function refreshCoreTopicsFromCloud() {
            try {
                await loadCoreTopicsFromCloud();   // 重拉云端 core_topics → 刷新 _coreTopicsMemCache
                _topicGroupsFp = null;             // 题材分组指纹缓存失效（核心词变了分组结果会变）
                _topicGroupsCache = null;
                _emit('auction-refresh');          // 通知第二页题材分类等 UI 重渲染
            } catch (e) {
                _dbgLog('[AUCTION-ERR] core_topics Realtime 刷新失败: ' + (e && e.message || e));
            }
        }

        // 保存核心词 = 更新内存缓存（题材分组立即生效）+ 排队写云端（§6 单一真相落在云端）。
        // 返回 Promise：UI 必须 await 它，成功给成功提示、失败给错误提示并回滚列表（§10）。
        // 注意 `_topicGroupsCache` 也要清：分组指纹里已含核心词，但显式清掉更稳（§22 不留中间态）。
        export function saveCoreTopics(topics) {
            const snapshot = Array.isArray(topics) ? topics.slice() : [];
            _coreTopicsMemCache = snapshot;
            _topicGroupsFp = null;
            _topicGroupsCache = null;
            return _queueCoreTopicsPush(snapshot);
        }

        // 获取最近5个交易日列表（从当前日期往前推，排除周末和假期）
        export function getLast5TradingDays() {
            const days = [];
            let date = useUiStore().currentDate;
            
            // 循环直到获取到5个交易日
            while (days.length < 5 && date) {
                if (isTradingDay(date)) {
                    days.push(date);
                }
                date = getPreviousTradingDay(date);
                if (!date) break;
            }
            
            return days;
        }

        // 根据核心词匹配题材
        export function matchTopicToCore(topic, coreTopics) {
            const matchedCores = [];
            const topicLower = topic.toLowerCase();
            
            coreTopics.forEach(core => {
                if (topicLower.includes(core.name.toLowerCase())) {
                    matchedCores.push(core.name);
                    return;
                }
                if (core.synonyms && core.synonyms.length > 0) {
                    for (let syn of core.synonyms) {
                        if (topicLower.includes(syn.toLowerCase())) {
                            matchedCores.push(core.name);
                            return;
                        }
                    }
                }
            });
            
            return matchedCores;
        }

        // ============ 题材上榜次数缓存（性能优化） ============
        // getTopicRankCountByDate / getTopicRankCountThisWeek 原实现每次调用都会
        // 重新遍历当天（或本周5天）的完整 rank 列表，且被"按题材分组"逐个调用，
        // 导致 O(天数 × 题材数 × 当天条目数) 的重复扫描，题材/天数越多越卡，
        // 且这两个函数在同一次渲染里会被反复触发（Vue computed 重算）。
        // 这里改为"结果按 (日期,题材) 缓存"，缓存失效只依赖 rankData[dateStr] 的
        // 数组引用是否变化（手动编辑保存/清除当天数据/云端拉取都会换新数组或删除该 key），
        // 不需要额外维护版本号，也不改变原有的匹配逻辑，只是不重复算。
        state._topicRankByDateCache = new Map();   // dateStr -> { ref, map: Map(topic -> count) }
        const _topicRankWeekDayCache = new Map();  // dateStr -> { ref, coreTopicsRaw, map: Map(topicName -> boolean) }

        // 统计本周题材在昨日最大成交额看板中出现的次数（缓存版，逻辑与原实现完全一致）
        // 同样支持可选传入 rankData/coreTopics，原因与 getTopicRankCountByDate 一致：
        // 避免在"按题材分组逐个调用"的循环里，每次都重新触发 getRankData()（→ loadAllData()
        // → syncStocksDataToStore() 写响应式 store）和 getCoreTopics()（→ 读 localStorage）。
        // 不传参时行为与原来完全一致。
        export function getTopicRankCountThisWeek(topicName, rankDataParam, coreTopicsParam) {
            try {
                const weekDays = getLast5TradingDays();
                const rankData = rankDataParam || getRankData();
                const coreTopics = coreTopicsParam || getCoreTopics();
                
                if (!weekDays || weekDays.length === 0 || !rankData || !coreTopics) {
                    return 0;
                }
                const coreTopicsRaw = JSON.stringify(coreTopics);
                
                let appearDays = 0;
                
                weekDays.forEach(day => {
                    const dayRankList = rankData[day] || [];

                    // 每天的"题材→是否出现"判定结果缓存，key=当天数组引用+coreTopics内容
                    let dayEntry = _topicRankWeekDayCache.get(day);
                    if (!dayEntry || dayEntry.ref !== dayRankList || dayEntry.coreTopicsRaw !== coreTopicsRaw) {
                        dayEntry = { ref: dayRankList, coreTopicsRaw, map: new Map() };
                        _topicRankWeekDayCache.set(day, dayEntry);
                    }

                    let hasTopic;
                    if (dayEntry.map.has(topicName)) {
                        hasTopic = dayEntry.map.get(topicName);
                    } else {
                        // 检查这一天是否有匹配该题材的股票（与原逻辑完全一致）
                        hasTopic = dayRankList.some(item => {
                            if (!item.concept) return false;
                            // 提取题材概念中的题材
                            const concepts = item.concept.split(/[,，、\s]+/).filter(c => c.trim());
                            // 检查是否有匹配核心词的题材
                            return concepts.some(concept => {
                                const matchedCores = matchTopicToCore(concept, coreTopics);
                                return matchedCores.includes(topicName);
                            });
                        });
                        dayEntry.map.set(topicName, hasTopic);
                    }
                    
                    if (hasTopic) {
                        appearDays++;
                    }
                });
                
                return appearDays;
            } catch (e) {
                console.error('getTopicRankCountThisWeek error:', e);
                return 0;
            }
        }

        // 通用词列表（不作为匹配依据）
        const genericWords = ['概念', '题材', '板块', '概念股', '产业链', '概念链'];

        // 判断两个题材是否匹配（1个以上汉字或字符相同，排除通用词）
        export function topicsMatch(topic1, topic2) {
            if (topic1 === topic2) return true;
            
            const chineseChars1 = topic1.match(/[\u4e00-\u9fa5]/g) || [];
            const chineseChars2 = topic2.match(/[\u4e00-\u9fa5]/g) || [];
            
            for (let i = 0; i <= chineseChars1.length - 2; i++) {
                const substr1 = chineseChars1.slice(i, i + 2).join('');
                if (genericWords.includes(substr1)) continue;
                
                for (let j = 0; j <= chineseChars2.length - 2; j++) {
                    const substr2 = chineseChars2.slice(j, j + 2).join('');
                    if (genericWords.includes(substr2)) continue;
                    
                    if (substr1 === substr2) {
                        return true;
                    }
                }
            }
            
            for (let i = 0; i < chineseChars1.length; i++) {
                const char1 = chineseChars1[i];
                if (genericWords.some(gw => gw.includes(char1))) continue;
                
                for (let j = 0; j < chineseChars2.length; j++) {
                    const char2 = chineseChars2[j];
                    if (genericWords.some(gw => gw.includes(char2))) continue;
                    
                    if (char1 === char2) {
                        return true;
                    }
                }
            }
            
            const alphaNum1 = topic1.match(/[a-zA-Z0-9]+/g) || [];
            const alphaNum2 = topic2.match(/[a-zA-Z0-9]+/g) || [];
            
            for (let i = 0; i < alphaNum1.length; i++) {
                for (let j = 0; j < alphaNum2.length; j++) {
                    if (alphaNum1[i].toLowerCase() === alphaNum2[j].toLowerCase()) {
                        return true;
                    }
                }
            }
            
            return false;
        }

        // [PERF] getTopicGroups 指纹缓存：toggle 只改排序状态不改数据，复用分组结果
        let _topicGroupsFp = null;
        let _topicGroupsCache = null;
        // 获取题材分组（使用核心词匹配）
        export function getTopicGroups(auctionList) {
            const __coreFp = getCoreTopics().map(c => c.name).join(',');
            const __fp = auctionList.length + '|' + auctionList.map(function(i) { return (i.stock||'') + ':' + (i.topics||''); }).join('\u00a7') + '|' + __coreFp;
            if (_topicGroupsFp === __fp && _topicGroupsCache) return _topicGroupsCache;
            const __tgT0 = performance.now();
            // [ARCH-V3 §6] 分组只用「可分组核心词」：伪题材(并购重组)不建组、不参与 matchTopicToCore，
            // 命中它的股票因此落到自己的其它真实题材组，没有任何真实题材时才进「其它」兜底组。
            const coreTopics = getGroupableCoreTopics();
            const __tgAfterCore = performance.now();
            // 预构建历史题材缓存，供当日 note 为空时回退使用
            buildTopicCache();
            const __tgAfterBuild = performance.now();
            const coreGroups = {};
            
            coreTopics.forEach(core => {
                coreGroups[core.name] = {};
            });
            
            const otherStocks = {};
            let __tgHistoryFallbackCalls = 0;
            let __tgHistoryFallbackTime = 0;
            
            auctionList.forEach(item => {
                // [BUG-FIX 2026-07-26] 兼容既有 note 括号格式，也兼容拆分字段后
                // 只存 changePct/topics 的新格式（热门股票等路径）。优先用 getDisplayNote
                // 重建完整 note，避免题材分组只看到空 note 而全部落入"其它"。
                const displayNote = getDisplayNote(item);
                let topics = extractTopics(displayNote);
                // 当日 note 为空时，回退到历史题材缓存（从历史日期的 note 中提取）
                if (topics.length === 0 && item.stock) {
                    const __hfT0 = performance.now();
                    const historyNote = getStockHistoryTopics(item.stock);
                    __tgHistoryFallbackTime += performance.now() - __hfT0;
                    __tgHistoryFallbackCalls++;
                    if (historyNote) {
                        topics = extractTopics(historyNote);
                    }
                }
                const volume = parseFloat(item.volume) || 0;
                const yestVolume = parseFloat(item.yestVolume) || 0;
                let ratioValue = 0;
                if (yestVolume > 0) {
                    ratioValue = (volume / yestVolume) * 100;
                }
                
                // 没有题材的股票也添加到"其它"分类
                if (topics.length === 0) {
                    if (!otherStocks[item.stock]) {
                        otherStocks[item.stock] = {
                            stock: item.stock,
                            topics: ['---'],
                            note: item.note || '',
                            changePct: item.changePct || '',
                            ratioValue: ratioValue,
                            ratio: ratioValue > 0 ? Math.round(ratioValue) + '%' : '-'
                        };
                    }
                    return;
                }
                
                // 有题材的股票按原有逻辑处理
                const stockTopicsByCore = {};
                
                topics.forEach(topic => {
                    const matchedCores = matchTopicToCore(topic, coreTopics);
                    
                    if (matchedCores.length > 0) {
                        matchedCores.forEach(coreName => {
                            if (!stockTopicsByCore[coreName]) {
                                stockTopicsByCore[coreName] = [];
                            }
                            if (!stockTopicsByCore[coreName].includes(topic)) {
                                stockTopicsByCore[coreName].push(topic);
                            }
                        });
                    } else {
                        if (!stockTopicsByCore['其它']) {
                            stockTopicsByCore['其它'] = [];
                        }
                        if (!stockTopicsByCore['其它'].includes(topic)) {
                            stockTopicsByCore['其它'].push(topic);
                        }
                    }
                });
                
                Object.keys(stockTopicsByCore).forEach(coreName => {
                    const stockData = {
                        stock: item.stock,
                        topics: stockTopicsByCore[coreName],
                        note: item.note || '',
                        changePct: item.changePct || '',
                        ratioValue: ratioValue,
                        ratio: ratioValue > 0 ? Math.round(ratioValue) + '%' : '-'
                    };
                    
                    if (coreName === '其它') {
                        if (!otherStocks[item.stock]) {
                            otherStocks[item.stock] = stockData;
                        } else {
                            stockTopicsByCore[coreName].forEach(t => {
                                if (!otherStocks[item.stock].topics.includes(t)) {
                                    otherStocks[item.stock].topics.push(t);
                                }
                            });
                        }
                    } else {
                        if (!coreGroups[coreName]) {
                            coreGroups[coreName] = {};
                        }
                        if (!coreGroups[coreName][item.stock]) {
                            coreGroups[coreName][item.stock] = stockData;
                        } else {
                            stockTopicsByCore[coreName].forEach(t => {
                                if (!coreGroups[coreName][item.stock].topics.includes(t)) {
                                    coreGroups[coreName][item.stock].topics.push(t);
                                }
                            });
                        }
                    }
                });
            });

            const validGroups = [];
            
            Object.keys(coreGroups).forEach(coreName => {
                const stocksArray = Object.values(coreGroups[coreName]);
                if (stocksArray.length >= 2) {
                    stocksArray.sort((a, b) => b.ratioValue - a.ratioValue);
                    validGroups.push({
                        topic: coreName,
                        stocks: stocksArray
                    });
                } else if (stocksArray.length === 1) {
                    const stockData = stocksArray[0];
                    if (!otherStocks[stockData.stock]) {
                        otherStocks[stockData.stock] = stockData;
                    } else {
                        stockData.topics.forEach(t => {
                            if (!otherStocks[stockData.stock].topics.includes(t)) {
                                otherStocks[stockData.stock].topics.push(t);
                            }
                        });
                    }
                }
            });

            // 计算每个题材的星星数和占比≥4.5%的股票数量
            validGroups.forEach(group => {
                // 统计占比≥4.5%的股票数量
                let highRatioCount = 0;
                group.stocks.forEach(stock => {
                    if (stock.ratioValue >= 4.5) {
                        highRatioCount++;
                    }
                });
                group.highRatioCount = highRatioCount;
                
                // 计算星星数
                if (highRatioCount >= 6) {
                    group.starCount = highRatioCount;
                } else if (highRatioCount >= 5) {
                    group.starCount = 5;
                } else if (highRatioCount >= 4) {
                    group.starCount = 4;
                } else if (highRatioCount >= 3) {
                    group.starCount = 3;
                } else if (highRatioCount >= 2) {
                    group.starCount = 2;
                } else if (highRatioCount >= 1) {
                    group.starCount = 1;
                } else {
                    group.starCount = 0;
                }
            });

            // 排序：按星星数从多到少，星星相同时按占比≥4.5%的股票数量从多到少
            validGroups.sort((a, b) => {
                if (b.starCount !== a.starCount) {
                    return b.starCount - a.starCount;
                }
                return b.highRatioCount - a.highRatioCount;
            });

            if (Object.keys(otherStocks).length > 0) {
                const otherStocksArray = Object.values(otherStocks);
                // 排序：有题材的股票放前面，没题材的股票（topics为['---']）放后面
                otherStocksArray.sort((a, b) => {
                    // 判断是否有题材（没题材的是 ['---']）
                    const aHasTopic = a.topics && a.topics.length > 0 && !(a.topics.length === 1 && a.topics[0] === '---');
                    const bHasTopic = b.topics && b.topics.length > 0 && !(b.topics.length === 1 && b.topics[0] === '---');

                    // 有题材的排在前面
                    if (aHasTopic && !bHasTopic) return -1;
                    if (!aHasTopic && bHasTopic) return 1;

                    // 同类型内按占比排序
                    return b.ratioValue - a.ratioValue;
                });
                validGroups.push({
                    topic: '其它',
                    stocks: otherStocksArray,
                    highRatioCount: 0,
                    starCount: 0
                });
            }

            const __tgTotal = performance.now() - __tgT0;
            if (__tgTotal > 50) {
                _dbgLog('[PERF-SEG] getTopicGroups 耗时' + __tgTotal.toFixed(1) + 'ms（共' + auctionList.length + '只股票）：getCoreTopics(localStorage)=' + (__tgAfterCore - __tgT0).toFixed(1) + 'ms，buildTopicCache=' + (__tgAfterBuild - __tgAfterCore).toFixed(1) + 'ms，历史题材回退=' + __tgHistoryFallbackTime.toFixed(1) + 'ms（' + __tgHistoryFallbackCalls + '只触发回退，均值' + (__tgHistoryFallbackTime / Math.max(1, __tgHistoryFallbackCalls)).toFixed(2) + 'ms/只），主循环及排序剩余=' + (__tgTotal - (__tgAfterBuild - __tgT0) - __tgHistoryFallbackTime).toFixed(1) + 'ms');
            }
            _topicGroupsFp = __fp;
            _topicGroupsCache = validGroups;
            return validGroups;
        }

        // 渲染第二页（题材分类）
