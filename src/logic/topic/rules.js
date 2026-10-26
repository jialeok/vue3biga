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

        /**
         * [CORE-VER 2026-10-22] 核心词表变更信号：`_coreTopicsMemCache` 是非响应式模块变量，
         * 而「题材大类归一」的消费方（题材量比看板的 computed）在加载完成 / 用户改词后必须重算。
         * ⇒ 只 bump 一个纯信号（state._coreTopicsVersion），消费方 `void getCoreTopicsVersion()` 即可。
         * ⛔ 它不承载任何业务数据，**不允许**拿它当「核心词表已就绪」的判据（那是 `_coreTopicsCloudLoaded`）。
         */
        function _bumpCoreTopicsVersion() {
            state._coreTopicsVersion = (Number(state._coreTopicsVersion) || 0) + 1;
        }

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
                        _bumpCoreTopicsVersion();
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
                    _bumpCoreTopicsVersion();
                    return;
                }
                // [TOPIC-SEP 2026-10-02] 读入即自愈：把「顿号粘成一整串」的 synonym 拆开，
                //   否则那些词会一直失效（详见上方 normalizeCoreTopics 的事故说明）。
                _coreTopicsMemCache = normalizeCoreTopics(validCloud);
                _bumpCoreTopicsVersion();
                _dbgLog('[CORE-TOPICS] 从云端加载 ' + validCloud.length + ' 个核心词（已归一化 synonyms）');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] loadCoreTopicsFromCloud 失败: ' + (e && e.message || e));
                _coreTopicsMemCache = state.defaultCoreTopics;
                _bumpCoreTopicsVersion();
            }
        }

        export function getCoreTopics() {
            if (_coreTopicsMemCache && _coreTopicsMemCache.length > 0) return _coreTopicsMemCache;
            return state.defaultCoreTopics || [];
        }

        /**
         * [CORE-VER 2026-10-22] 核心词表版本号（响应式）。消费方在 computed 里 `void` 一下，
         * 即可在「云端加载完成 / 用户改完核心词」后自动重算 —— 见 `_bumpCoreTopicsVersion`。
         * @returns {number}
         */
        export function getCoreTopicsVersion() {
            return Number(state._coreTopicsVersion) || 0;
        }

        // ============ [TOPIC-SEP 2026-10-02] 题材词分隔符 · §6 单一真相 ============
        // 🔴 事故：核心词管理弹窗(CoreTopicModal)的 splitSynonyms 只认 [,，] 两种逗号，
        //    而【股票侧】标签拆分(getStockTopicArr / auction-helpers 等 8 处)用的是 [,，、;；]（含【顿号】）。
        //    两侧口径不一致 ⇒ 用户在弹窗里粘贴「工业互联网、智能制造、工业软件…」这种顿号文本时，
        //    会被当成【一个整体】存进 synonyms。而匹配是子串匹配(topic.includes(synonym))，
        //    整串永远匹配不上 ⇒ 这些词【静默全部失效】。
        //    实测脏数据：核心词「工业4.0」的 synonyms[0] =
        //      "工业互联网、智能制造、工业软件、数控机床、机器人、人形机器人、减速器、传感器、高端制造"
        //      ⇒ 连「工业4.0」这个标签自身都匹配不到该核心词（只能靠同组的「机器人概念」间接进组）。
        // ⛔ 从此分隔符只此一处定义，任何拆分题材词的地方都必须用它（组件也一样，不许再写死正则）。
        export const TOPIC_WORD_SEP_RE = /[,，、;；]/;

        /**
         * 按统一分隔符把一段文本拆成题材词数组（去空白、去空串、去重，保持原顺序）。
         * @param {string|null|undefined} text
         * @returns {string[]}
         */
        export function splitTopicWords(text) {
            const t = String(text === null || text === undefined ? '' : text).trim();
            if (!t) return [];
            const seen = new Set();
            const out = [];
            t.split(TOPIC_WORD_SEP_RE).forEach(function(s) {
                const v = String(s || '').trim();
                if (!v) return;
                const key = v.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                out.push(v);
            });
            return out;
        }

        /**
         * 核心词表归一化（自愈脏数据）。
         *
         * 只做一件事：把【含分隔符却被当成一整项】的 synonym 拆开（并去重）。
         * ⚠️ 为什么必须在【读取时】自愈，而不是等用户去弹窗里重新保存一次：
         *    云端的脏数据已经存在，用户根本看不出它坏了（弹窗里 join(',') 显示出来就是一长串，
        *    看起来"正常"）⇒ 不自愈的话，那些词会一直失效到有人手动重存为止。
         *
         * @param {Array<{name:string, synonyms:string[]}>|null} list
         * @returns {Array<{name:string, synonyms:string[]}>}
         */
        export function normalizeCoreTopics(list) {
            const arr = Array.isArray(list) ? list : [];
            return arr.map(function(c) {
                if (!c || typeof c.name !== 'string' || !c.name.trim()) return c;
                const raw = Array.isArray(c.synonyms) ? c.synonyms : [];
                const flat = [];
                const seen = new Set();
                raw.forEach(function(s) {
                    splitTopicWords(s).forEach(function(v) {
                        const key = v.toLowerCase();
                        if (seen.has(key)) return;
                        seen.add(key);
                        flat.push(v);
                    });
                });
                return { name: c.name, synonyms: flat };
            });
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
            _bumpCoreTopicsVersion();
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
        //
        // ── [PERF §22 2026-10-26] 两级缓存（CPU profile 实测自身耗时 760ms，是全应用最大单项）──────
        // 🔴 定位：.tmpdiag/cdp-profile.cjs 抓启动 profile，`index:3:34730` 的 forEach 回调
        //    自身耗时 **760ms**，即本函数里 `coreTopics.forEach(...)` 的每一项：
        //      · 每次调用都要对 34 个核心词的 name + 每个同义词各做一次 `toLowerCase()`
        //        （核心词表含同义词共 400+ 条）⇒ 单次调用 ≈ 500 次字符串分配；
        //      · 而本函数被「每个题材 × 每个交易日 × 每个看板」反复调用（分组、上榜次数、一字补题材）。
        //    ⇒ 纯 CPU 浪费，与数据量无关，**换成任何机型都一样慢**。
        // ✅ 修法（语义逐字不变，只去掉重复计算）：
        //    ① 【字典缓存】按 coreTopics 的「数组引用 + 长度」重建一份**已小写**的字典
        //       （与下方 _coreTopicsRawOf 同一套失效判据：引用变了就是内容变了）；
        //    ② 【结果缓存】以「小写题材名」为键把匹配结果存进 Map ——
        //       题材名是有限词表（几百个），预热后每次都是 O(1)。
        // ⚠️ 返回的仍然是**新数组**（与原实现契约一致），⛔ 不把缓存数组直接交出去，
        //    避免调用方原地 push 污染后续所有调用。
        let _m2cRef = null;
        let _m2cLen = -1;
        let _m2cDict = [];              // [{ name, nameLower, synsLower[] }]
        let _m2cMemo = new Map();       // topicLower → string[]

        function _ensureMatchDict(coreTopics) {
            if (coreTopics === _m2cRef && coreTopics.length === _m2cLen) return;
            _m2cRef = coreTopics;
            _m2cLen = coreTopics.length;
            _m2cDict = coreTopics.map(function(core) {
                const syns = Array.isArray(core.synonyms) ? core.synonyms : [];
                return {
                    name: core.name,
                    nameLower: String(core.name).toLowerCase(),
                    synsLower: syns.map(function(s) { return String(s).toLowerCase(); })
                };
            });
            _m2cMemo = new Map();   // 核心词表一变，旧的匹配结果全部作废
        }

        export function matchTopicToCore(topic, coreTopics) {
            if (!topic || !coreTopics || coreTopics.length === 0) return [];
            const topicLower = String(topic).toLowerCase();
            _ensureMatchDict(coreTopics);

            const hit = _m2cMemo.get(topicLower);
            if (hit) return hit.slice();

            const matchedCores = [];
            for (let i = 0; i < _m2cDict.length; i++) {
                const core = _m2cDict[i];
                if (topicLower.includes(core.nameLower)) {
                    matchedCores.push(core.name);
                    continue;
                }
                const syns = core.synsLower;
                for (let j = 0; j < syns.length; j++) {
                    if (topicLower.includes(syns[j])) {
                        matchedCores.push(core.name);
                        break;
                    }
                }
            }
            _m2cMemo.set(topicLower, matchedCores);
            return matchedCores.slice();
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
        // [PERF §19/§22] dateStr -> { ref, coreTopicsRaw, set: Set<命中核心词> }
        // 每天缓存「当日全部命中核心词集合」，而不是 Map<topicName,boolean>：
        // 后者只能省掉「同一个题材名」的重复扫描，而模板是【每个不同题材各调一次】⇒
        // 每个题材仍会全量扫一遍当天列表（实测切日期时 matchTopicToCore 自耗时 708ms）。
        // 改为集合后，全量扫描每（天 × 数据代）只做一次，输出数值完全不变。
        const _topicRankWeekDayCache = new Map();
        // [PERF §36] coreTopics 内容指纹按（数组引用 + 长度）缓存：
        // 避免「每个题材组 × 每天」都重跑一次 JSON.stringify（核心词表可达上百条含同义词）。
        // 引用未变即内容未变；长度也纳入 key 以防御极小概率的原地 push/splice。
        let _coreTopicsJsonRef = null;
        let _coreTopicsJsonLen = -1;
        let _coreTopicsJsonCache = '';
        function _coreTopicsRawOf(coreTopics) {
            if (coreTopics !== _coreTopicsJsonRef || coreTopics.length !== _coreTopicsJsonLen) {
                _coreTopicsJsonRef = coreTopics;
                _coreTopicsJsonLen = coreTopics.length;
                _coreTopicsJsonCache = JSON.stringify(coreTopics);
            }
            return _coreTopicsJsonCache;
        }

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
                const coreTopicsRaw = _coreTopicsRawOf(coreTopics);
                
                let appearDays = 0;
                
                weekDays.forEach(day => {
                    const dayRankList = rankData[day] || [];

                    // [PERF §19/§22] 每天的「当日全部命中核心词集合」缓存：
                    // key = 当天数组引用 + coreTopics 内容指纹，命中即 O(1) 查表。
                    // 语义与原实现完全等价：原来
                    //   dayRankList.some(item => item.concept.split(…).some(c =>
                    //       matchTopicToCore(c, coreTopics).includes(topicName)))
                    // 的判定 == (topicName ∈ 所有 matchTopicToCore 结果的并集) == set.has(topicName)。
                    // 逐题材组调用时，全量扫描由 O(题材数 × 每天条目数 × 概念数)
                    // 降为 每（天 × 数据代）一次 O(每天条目数 × 概念数)。
                    let dayEntry = _topicRankWeekDayCache.get(day);
                    if (!dayEntry || dayEntry.ref !== dayRankList || dayEntry.coreTopicsRaw !== coreTopicsRaw) {
                        const hitSet = new Set();
                        for (let i = 0; i < dayRankList.length; i++) {
                            const item = dayRankList[i];
                            if (!item || !item.concept) continue;
                            // 提取题材概念中的题材（与原逻辑完全一致）
                            const concepts = item.concept.split(/[,，、\s]+/).filter(c => c.trim());
                            for (let j = 0; j < concepts.length; j++) {
                                const matchedCores = matchTopicToCore(concepts[j], coreTopics);
                                for (let k = 0; k < matchedCores.length; k++) hitSet.add(matchedCores[k]);
                            }
                        }
                        dayEntry = { ref: dayRankList, coreTopicsRaw, set: hitSet };
                        _topicRankWeekDayCache.set(day, dayEntry);
                    }

                    if (dayEntry.set.has(topicName)) {
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
