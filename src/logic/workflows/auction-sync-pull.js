// auction-sync-pull.js — 云端拉取（从 auction-sync.js 物理拆分）
// 仅移动位置，不改实现。
import { getSupabase, getStocksData, loadAllData } from '../../data/supabase-client.js';
import { saveFumianTopics } from '../../data/fumian-sync.js';
import { saveEtfBoardComment } from '../../data/etf-board-data.js';
import { saveBiddingTemplate } from '../../data/bidding-template-sync.js';
import { _dbgLog } from '../../data/debug-log.js';
import { _emit } from '../../stores/eventBus.js';
import { getGroupData, getAuctionData, saveModule, patchAuctionFieldBatch, reconcileAuctionWatchlistFromLocalStorage, mergeAuctionDateRows, getHotAuctionData, _openHotAuctionShield, _closeHotAuctionShield } from '../app-core-api.js';
import { _getAuctionWatchlistSet } from '../../data/watchlist-and-metrics.js';
import { cleanseAuctionTagsOnce } from '../tagTitles/rules.js';
import { state } from '../app-state.js';
import { pullAuctionFromTable } from '../../data/auction-data.js';
import { _signalCache } from '../auction/sort-rules.js';
import { pullBiddingFromTable, pushBiddingToCloud } from '../../data/bidding-data.js';
import { pullJiwangFromTable } from '../../data/jiwang-data.js';
import { recalcDuibanFromAuction } from '../ui-bridge.js';
import { _openAuctionShield, _closeAuctionShield } from '../../data/session-and-shield.js';
import { syncStockTopicsFromAuction } from '../auction/stock-sync.js';
import { useUiStore } from '../../stores/uiStore.js';
import { _cloudBlobExtras } from './auction-sync-helpers.js';
import { getAuctionRecentSinceDate } from '../auction/auction-pull-window.js';

        // 更早历史的后台补齐：整个会话只做一次，且必须等首屏窗口拉完后再发起。
        // §33：首屏加载与后续补齐分离；§10：失败只影响「更早的历史」，窗口内数据完好。
        let _olderPullStarted = false;

        /**
         * [BOOT-GATE 2026-10-03 用户反馈「为什么决策看板加载那么慢」] 后台补齐的【启动时机】。
         *
         * 🔴 【定位】（真实浏览器实测，证据：.tmpdiag/probe-boot-v4.json / boot-longtasks.json）
         *   启动后 2 秒内并发 72 个请求，全程 125 个 Supabase 请求；其中 market_metrics 一个表
         *   就 68 个分页请求（每页 1000 行），一直排到 22.5 秒才结束。
         *   浏览器对单域名只有 ~6 条并发连接 ⇒ 首屏真正需要的「近 30 天窗口」那十来个请求
         *   被这 68 个「更早历史」的分页请求堵在队列里，决策看板因此要等好几秒才有数据。
         *   根因就在下面这行原来写的是 `setTimeout(…, 0)`：注释写着「不与首屏渲染/并发取页竞争」，
         *   但 0ms 等于「立刻发起」，照样把连接池占满（§32 重复/并发请求红线的实际表现）。
         *
         * ✅ 【修法】把「更早历史」整体推到首屏确实画完之后再开始：
         *   ① 先等 OLDER_PULL_DELAY_MS（默认 10s）—— 足够「窗口拉取（约 12 个请求）+ 首次渲染」完成；
         *   ② 再等浏览器空闲（requestIdleCallback；不支持则直接执行）。
         *   ⛔ 不改拉取范围 / 不改顺序 / 不碰任何写路径，只改「什么时候开始」。
         *   ⛔ 正确性不受影响：窗口外的日期被切到时由 ensureAuctionDateDataLoaded 按天补拉兜底
         *      （见 logic/auction/auction-pull-window.js），§10 失败不标记已加载、下次照样重试。
         *   ⚠️ 不用 rAF（后台标签页会被冻结），也不用裸 requestIdleCallback（空闲来得太早、等于没推迟）。
         */
        const OLDER_PULL_DELAY_MS = 10000;

        // ══════════════════════════════════════════════════════════════════════════════════
        // ★★ [MORNING-QUIET / OLDER-BOUND 2026-10-26 用户报障「9:26 打开，到 9:36 都没打开成功，很卡」]
        //
        // 🔴 【实测证据】（.tmpdiag/perf-boot.cjs / perf-tables.cjs，2026-10-26 真实库）
        //   · 首屏窗口拉取（sinceDate = 30 个自然日）：4 个请求 / 1,968 行 / 0.54MB / 4.2s —— 没问题。
        //   · 下面这段「更早历史补齐」：**67 个请求 / 65,971 行 / 17.84MB / 桌面 14.3s**
        //     （auction_watchlist 旧 11,521 行 3.57MB + market_metrics 旧 54,450 行 14.27MB）。
        //     手机上要几分钟：17.84MB 下载 + 主线程 JSON.parse 6.6 万行 + 逐日合并。
        //   · 它原来在首屏后 10 秒（≈ 09:26:10）无条件启动 —— 正好压在
        //     ① worker 9:25 写库最忙（实测单页最慢 3s）、② 用户正在看盘 这个窗口上。
        //   ⇒ 用户感受 = 页面出来了但一直卡、点不动、切日期没反应，十几分钟用不了。
        //
        // 【改法·四条，全部只改"什么时候取/取多深"，⛔ 不改"取什么"，行集合与合并语义零变化】
        //   ① 【早盘静默】09:10~09:26 不启动补齐 —— 只保护 9:25 worker 写库那几分钟。
        //   ② 【深度有界】只补到「题材慢路径索引」需要的那点历史，⛔ 不再把 4 年整表拉下来。
        //      依据：内存里需要深历史的消费方是 stocks.js#TOPIC_CACHE_DAYS = 66 个交易日
        //      与 range20.js#RANGE20_PROBE_DAYS = 45 个交易日（20日涨幅前五 / 退潮判定）。
        //      首屏窗口 30 天 ≈ 21 交易日 ⇒ 再往前 70 自然日 ⇒ 合计 ≈ 68 交易日，够 45 且有余量。
        //      更早的日期由 ensureAuctionDateDataLoaded 按天补拉（幂等 + 单飞，切到哪天补哪天）。
        //   ③ 【让步】补齐期间分页并发降到 2（首屏仍是 6）—— 宁可慢，也不要和用户操作抢连接。
        //
        // ══════════════════════════════════════════════════════════════════════════════════
        // ★★ [WAKE-CONTRACT 2026-10-26 二次修正] 上一版把 ④ 写成「当前展示日不受影响就不刷新」，
        //   结果把【主题材量比永久不出数据】的事故做出来了，已回滚该判断。事故复盘：
        //
        //   🔴 现象：用户 9:26 打开，早盘竞价有数据，题材量比一直不产出（10:12 仍未出）。
        //   🔴 链路：题材量比 → ensureRange20Leaders(d) → 需要「正式列表索引」覆盖 45 个交易日
        //      → 这 45 天【只能】由本段补齐拉进内存（range20 自己不调 ensureAuctionDateDataLoaded）
        //      → 唤醒它的信号只有两条：① 本段补齐完成后 emit('auction-refresh')
        //        ② range20 自己的 _scheduleWarmRetry（3s/10s/30s/60s，4 次后永久放弃）
        //   🔴 病灶：上一版用 `cur < until`（当前展示日 < 30天前）判断"是否受影响"。
        //      展示日是【今天】时永远 false ⇒ 一次都不 emit；而 _scheduleWarmRetry 早在 9:27 就耗尽
        //      ⇒ 补齐虽然把 45 天数据拉进了内存，却没有任何人通知题材量比重算
        //      ⇒ 永久停在「候选池为空 ⇒ 本次不产出」。
        //   🔴 判断错在哪：把「屏幕那一天」当成唯一消费者，漏掉了【深历史消费者】
        //      （20日涨幅前五 45 个交易日 / 退潮判定 / 决策看板）。
        //
        //   ✅ 正确契约：补齐一旦真的补进了日期，就必须发一次「历史索引已就绪」通知。
        //      这不是"无关刷新"—— 整个会话只发生一次（_olderPullStarted 保证），
        //      不是每个 tick 都刷，§22「高频数据增量化」管的是高频，不是这一次性加载完成。
        //      而各看板自己 bumpVersion 后按自己的边界重算（§17 响应式边界不越界）。
        // ══════════════════════════════════════════════════════════════════════════════════
        /** 早盘静默期（北京时间的分钟数）：只做首屏那 4 个请求，⛔ 不做任何后台补齐。
         *  ★ 终点从 9:45 改回 9:26：那 19 分钟让题材量比从「9:36 可用」变成「9:50 可用」，
         *    正是用户「半个钟都没加载完成」的体感来源。真正治卡顿的是①②③（17.84MB → ~2.7MB），
         *    不是靠时间段硬拦（§36：不许用延迟执行掩盖问题）。 */
        const MORNING_QUIET_FROM_MIN = 9 * 60 + 10;
        const MORNING_QUIET_TO_MIN = 9 * 60 + 26;
        /** 窗口之外再往前补多少个自然日（≈ 让 TOPIC_CACHE_DAYS=66 交易日吃满；实测 ≈3.5k 行 / 1.2MB） */
        const OLDER_EXTRA_DAYS = 70;
        /** 补齐期间的分页并发（首屏仍是 6）—— 后台任务必须让步 */
        const OLDER_PULL_CONCURRENCY = 2;

        /** 北京时间的分钟数（与 morning-sync.js 同口径；⛔ 不受设备时区影响） */
        function _beijingMinutesNow() {
            const d = new Date();
            const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
            return local.getUTCHours() * 60 + local.getUTCMinutes();
        }

        /** 日期字符串平移 N 天（UTC 运算，⛔ 不用本地时区，避免跨时区漂一天） */
        function _shiftDateStr(dateStr, deltaDays) {
            const p = String(dateStr).split('-');
            const t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
            return new Date(t + deltaDays * 86400000).toISOString().slice(0, 10);
        }

        function _scheduleOlderAuctionPull(sinceDate) {
            if (_olderPullStarted) return;
            _olderPullStarted = true;
            const _runOlderPull = function() {
                // ④ 页面不可见（手机切后台/锁屏）⇒ 先不补，避免白耗流量；等切回前台再补一次。
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                    _dbgLog('[AUCTION-PULL] 页面不可见 ⇒ 暂缓历史补齐（切回前台后补一次；在那之前切老日期由按天补拉兜底）');
                    try {
                        const _onVis = function() {
                            if (document.visibilityState !== 'visible') return;
                            document.removeEventListener('visibilitychange', _onVis);
                            setTimeout(_runOlderPull, 3000);
                        };
                        document.addEventListener('visibilitychange', _onVis);
                    } catch (e) { /* 事件挂不上就彻底放弃补齐（按天补拉仍可兜底，§10 不静默失败） */ }
                    return;
                }
                const until = sinceDate;
                const olderSince = _shiftDateStr(until, -OLDER_EXTRA_DAYS);
                pullAuctionFromTable({
                    sinceDate: olderSince,
                    untilDate: until,
                    concurrency: OLDER_PULL_CONCURRENCY
                })
                    .then(function(older) {
                        const n = older ? Object.keys(older).length : 0;
                        // ★ [WAKE-CONTRACT 2026-10-26] 必须发，且与「当前展示日」「n 是否为 0」都无关。
                        //   20日涨幅前五要 45 个交易日索引才能算（range20.js#RANGE20_PROBE_DAYS），
                        //   而它只从内存读索引、自己不补拉 ⇒ 本段是它唯一的数据入口。
                        //   漏发这一次 = 题材量比 / 退潮判定永久停在「候选池为空」（本次事故根因）。
                        //   ⚠️ 为什么不能只在 n > 0 时发：`older` 只统计「有【正式成员】行的日期」，
                        //      而索引 `state._auctionWatchlistIndex[d]` 是按【拉到行的每一天】回填的。
                        //      若这段只有影子行（或全是不在正式名单里的行），n 会是 0 但索引其实已经就绪
                        //      ⇒ 按 n 判会把该发的唤醒漏掉（§10：判不出 ≠ 判出"没有"）。
                        //   ⚠️ 整个会话只发生一次（_olderPullStarted 保证），不是高频刷新。
                        Object.keys(_signalCache).forEach(function(k) { delete _signalCache[k]; });
                        _emit('auction-refresh');
                        _dbgLog('[AUCTION-PULL] 历史后台补齐完成：再载入 ' + n + ' 天有正式成员的日期（' + olderSince + '~' + until +
                            '，首屏未阻塞）⇒ 已发 auction-refresh 唤醒 20日涨幅前五 / 题材量比 / 退潮判定重算');
                    })
                    .catch(function(e) {
                        _dbgLog('[AUCTION-ERR] pullAuctionFromTable(older) ' + (e && e.message || e));
                    });
            };
            // ① 早盘静默：落在这段时间里 ⇒ 把整个补齐推迟到静默期结束之后
            const nowMin = _beijingMinutesNow();
            const inQuiet = nowMin >= MORNING_QUIET_FROM_MIN && nowMin <= MORNING_QUIET_TO_MIN;
            const waitMs = inQuiet
                ? Math.max(OLDER_PULL_DELAY_MS, (MORNING_QUIET_TO_MIN - nowMin) * 60 * 1000)
                : OLDER_PULL_DELAY_MS;
            if (inQuiet) {
                _dbgLog('[AUCTION-PULL] 早盘静默期（' + Math.floor(nowMin / 60) + ':' + String(nowMin % 60).padStart(2, '0') +
                    '）⇒ 历史补齐推迟 ' + Math.round(waitMs / 60000) + ' 分钟后开始');
            }
            setTimeout(function() {
                // ③ 先让首屏独占连接池，再挑浏览器空闲的时刻开始补齐。
                if (typeof requestIdleCallback === 'function') {
                    try {
                        requestIdleCallback(_runOlderPull, { timeout: 5000 });
                        return;
                    } catch (e) { /* 降级到下面的直接执行 */ }
                }
                _runOlderPull();
            }, waitMs);
        }

        // ============================================================
        // 云端数据拉取（解锁后执行一次）
        // ============================================================
        export async function pullFromCloud() {
            // §3/§4 收口（P0-3 修复）：原 _setSyncStatus 用 document.getElementById('syncStatus') 在 logic 层
            // 直接写 DOM，绕过 LoginOverlay.vue 的响应式 statusText，造成双写冲突。同步状态属信息展示，
            // 且 statusText 为组件私有 ref、无供逻辑层写入的共享通道，故删除 DOM 写，仅保留诊断日志。
            try {
                const sb = getSupabase();
                const { data, error } = await sb
                    .from('user_data')
                    .select('data')
                    .eq('id', 'owner')
                    .single();

                if (error) throw error;
                if (!data || !data.data || Object.keys(data.data).length === 0) {
                    _dbgLog('[PULL] 云端暂无数据，使用本地数据');
                    return;
                }

                const cloudObj = data.data;

                // ★★ [BOARD-LOST-G3 2026-10-28 · §10「未知 ≠ 空」] 记住云端 blob 各模块分区的原样快照。
                //   为什么需要：pushToCloud 是整列覆盖 `user_data.data`（一个 JSON 列），
                //   而它的 payload 取自 `state.allData.*`（= 各域内存缓存）。若某个模块本次【根本没加载】，
                //   旧实现就会写 `{}` 上去 —— 用「未知」覆盖「已知」，正是 §10 红线。
                //   实测（.tmpdiag/audit-boot-writes.cjs）：一次首屏即发出
                //   `POST user_data {"id":"owner","data":{"stocks":{},"rank":{},"multi":{},"hotspot":{},…}}`。
                //   有了这份快照，push 侧就能「本地有货用本地、本地没货沿用云端刚刚读到的那份」。
                _cloudBlobExtras._blobSections = {};
                ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles']
                    .forEach(function (k) {
                        const v = cloudObj[k];
                        if (v && typeof v === 'object' && Object.keys(v).length > 0) _cloudBlobExtras._blobSections[k] = v;
                    });

                // §8 收口（P0-1 修复）：原 cloud-pull 把云端 blob 各模块镜像写回 stockApp_v42_* localStorage，
                // 违反 §8「核心业务数据不得落 localStorage」。现各模块已迁移到「云端专用表 + 内存缓存(_xxxMemCache)」，
                // loadAllData 优先读内存缓存、不再从这些 localStorage key 读（src/data/supabase-client.js:199-214），
                // 故下方不再镜像 stocks/auction/bidding/rank/multi/hotspot/pattern/tagTitles/jiwang（云端已是唯一真相源）。
                // 仅 holidays / tradingDays 无对应内存缓存、仍由 loadAllData 从 localStorage 兜底读取（见 supabase-client.js:205），
                // 予以保留写入（非 §8 违规，无合适云端表，且被读回作为数据源）。
                const moduleKeys = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];
                const DV = 'v42';
                const _localStorageFallbackKeys = ['holidays', 'tradingDays'];
                moduleKeys.forEach(key => {
                    if (_localStorageFallbackKeys.indexOf(key) !== -1 && cloudObj[key] !== undefined) {
                        localStorage.setItem('stockApp_' + DV + '_' + key, JSON.stringify(cloudObj[key]));
                    }
                });
                localStorage.setItem('stockApp_' + DV + '__migrated', '1');

                // 其余散落 key
                // §8 收口：stockEtfComment 已并入 Supabase early_etf_data.comment 列（saveEtfBoardComment）；
                // biddingDefaultTemplate_v41 已双写 Supabase（saveBiddingTemplate）；coreTopics 另有云端路径 topic-rules.js（getCoreTopics）。
                // duibanData 不再双写 auction_duiban 表：该表为迁移遗留孤儿表（loadDuibanData 全代码 0 调用方，
                // DuibanBoard 实际读 recent_multi_data），收敛为只经 user_data blob(_cloudBlobExtras) 暂存，不再写孤儿表。
                // 上述字段以及 duibanComment/copiedStocksData/summaries 的「pull→push 暂存」已从 localStorage 改为模块内存 _cloudBlobExtras（见顶部声明），
                // 不再把业务数据写进 localStorage；云端双写保留作为 fail-soft 冗余真相源，绝不丢数据。
                const extraKeys = ['duibanData', 'duibanComment', 'stockEtfComment',
                                   'coreTopics', 'biddingDefaultTemplate_v41', 'copiedStocksData'];
                extraKeys.forEach(key => {
                    if (cloudObj[key] !== undefined) {
                        // §8 合规：暂存改为模块内存 _cloudBlobExtras（见顶部声明），不再写 localStorage
                        _cloudBlobExtras[key] = cloudObj[key];
                        // §8 双写：新增云端 Supabase（fire-and-forget，内部 try/catch 已 fail-soft）
                        try {
                            if (key === 'stockEtfComment') {
                                const cmts = cloudObj[key];
                                if (cmts && typeof cmts === 'object') {
                                    Object.keys(cmts).forEach(d => saveEtfBoardComment(d, cmts[d]));
                                }
                            }
                            else if (key === 'biddingDefaultTemplate_v41') saveBiddingTemplate(cloudObj[key]);
                        } catch (e) { console.error('[auction-sync] §8 双写异常(' + key + ')：', e && e.message); }
                    }
                });
                // summaries（带前缀的动态 key）：暂存改为内存 _cloudBlobExtras（§8 合规，不再逐 key 写 localStorage）
                if (cloudObj.summaries) {
                    _cloudBlobExtras.summaries = cloudObj.summaries;
                }
                // §8 已上云（写路径仅上云，已移除 localStorage 写入；读路径已切云端 loadFumianTopics → getFumianCache，localStorage 仅作冷启动兜底）。
                if (cloudObj.hasFumianTopics) {
                    // 双写：新增 Supabase upsert（失败自动降级，绝不破坏既有路径）；localStorage 写入已移除（用户已授权上云）
                    try {
                        await saveFumianTopics(cloudObj.hasFumianTopics);
                    } catch (e) {
                        console.error('[auction-sync] hasFumian 上云异常：', e && e.message);
                    }
                }
                if (cloudObj.scoreSettings) {
                    ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                        if (cloudObj.scoreSettings[type] !== undefined) {
                            localStorage.setItem('scoreSettings_' + type, JSON.stringify(cloudObj.scoreSettings[type]));
                        }
                    });
                }
                if (cloudObj.exportDate) {
                    const localDate = localStorage.getItem('lastEditedDate_v42');
                    // 云端日期必须不早于"去年今日"（粗略但可靠地过滤陈旧值，如早期测试留下的
                    // 2025-01-02），且比本地新，才允许覆盖本地
                    const _thisYear = new Date().getFullYear();
                    const _minValidDate = (_thisYear - 1) + '-01-01';
                    if (cloudObj.exportDate >= _minValidDate && (!localDate || cloudObj.exportDate > localDate)) {
                        localStorage.setItem('lastEditedDate_v42', cloudObj.exportDate);
                    }
                }

                // 重置内存中的 allData，让 loadAllData() 重新从 localStorage 读取
                // §6：rank 缓存经 state._rankMemCache 单独持有（与 allData 解耦），此 null 重置不连坐 rank；安全。
                state.allData = null;

                // 从 auction_watchlist + market_metrics 拉取 auction 数据（拆表后新增）
                // 若新表不可用或为空，保留本地数据（不清空）
                // 【改造前】await pullAuctionFromTable() 无条件全表拉三张表 = 23 次串行 HTTP ≈ 25~40 秒，
                // 早盘 9:25 打开页面整段白屏。现在改为两阶段（详见 src/logic/auction/auction-pull-window.js）：
                //   ① 阻塞：只拉最近 AUCTION_RECENT_WINDOW_DAYS 个自然日（覆盖趋势图/竞昨/竞价口径反解全部诉求）
                //   ② 后台：更早的历史在空闲时补齐，完成后再 emit 一次刷新
                // 若新表不可用或为空，保留本地数据（不清空）
                try {
                    const sinceDate = getAuctionRecentSinceDate();
                    await pullAuctionFromTable({ sinceDate });
                    // 更新状态签名，避免 pull 后立即触发无意义的 push
                    // 方案2：状态签名只统计正式成员（用 _auctionWatchlistIndex 判断）
                    const _pullWset = _getAuctionWatchlistSet(useUiStore().currentDate);
                    const todayList = (state._auctionMemCache[useUiStore().currentDate] || []).filter(function(s) { return s && s.stock && _pullWset.has(s.stock.trim()); });
                    state._lastPushedAuctionStatus = JSON.stringify(todayList.map(function(s) {
                        return { s: s.stock, sel: s.selected || false, b: s.bought || false,
                                 so: s.sold || false, f: s.fixed || false };
                    }));
                    const _recentDays = Object.keys(state._auctionMemCache || {}).filter(function(d) { return d >= sinceDate; }).length;
                    _dbgLog('[AUCTION-PULL] 首屏窗口 sinceDate=' + sinceDate + ' 载入 ' + _recentDays + ' 天');

                    // ② 更早的历史：后台补齐，绝不阻塞首屏。失败也不影响窗口内数据（§10 fail-soft）。
                    // 用户若在补齐完成前切过去，由 ensureAuctionDateDataLoaded 按天补拉兜底。
                    _scheduleOlderAuctionPull(sinceDate);
                } catch(tableErr) {
                    _dbgLog('[AUCTION-ERR] pullAuctionFromTable ' + (tableErr && tableErr.message));
                }

                // pullAuctionFromTable 加载了所有日期的全量快照到 _auctionMemCache，
                // 首次渲染时 T-1 数据可能未就绪导致竞昨高光算成 0 并被指纹缓存锁住。
                // 指纹 _signalFpFor 只覆盖 watchlist 数据，不覆盖 _auctionMemCache 全量快照，
                // 所以全量快照就绪后指纹不变 → 缓存命中 → 返回旧的 0。
                // 修复：清空 _signalCache，强制重渲染时用完整全量快照重算。
                Object.keys(_signalCache).forEach(function(k) { delete _signalCache[k]; });
                _emit('auction-refresh');

                // 阶段六 影子bug6 收尾：拉取完成后立即对账，用 localStorage 旧正式列表纠正云端已提升的影子记录
                try {
                    const reconcileResult = await reconcileAuctionWatchlistFromLocalStorage();
                    if (!reconcileResult.skipped && reconcileResult.demoted > 0) {
                        _dbgLog('[RECONCILE] 首次对账降级 ' + reconcileResult.demoted + ' 只影子记录，触发重新渲染');
                        // 对账改了 _auctionMemCache 行的 in_watchlist，需重新渲染当前页
                        _emit('auction-refresh');
                    }
                } catch(e) {
                    _dbgLog('[AUCTION-ERR] reconcileAuctionWatchlistFromLocalStorage ' + (e && e.message || e));
                }

                // 一次性标签清洗（stockApp_v42_tag_cleanse_v1）：云端拉取完成后执行，
                // 按 deriveAuctionTagState 重算所有日期竞价行的 bought/sold/selected/fixed，
                // 清除历史遗留脏位（误标"买"、幽灵灰色"卖出"），并推送云端覆盖脏行。
                // 只跑一次；清洗前自动备份到 auctionData_tag_cleanse_backup。
                try {
                    await cleanseAuctionTagsOnce();
                    _emit('auction-refresh');
                } catch(e) {
                    _dbgLog('[AUCTION-ERR] cleanseAuctionTagsOnce ' + (e && e.message || e));
                }

                // 从 bidding_data 独立表拉取 bidding 数据（云端表是权威来源之一，
                // 但不能因为某次拉取没返回某个日期就把本地已保存的数据删掉）。
                try {
                    const tableBidding = await pullBiddingFromTable();
                    // 收集"正在推送到云端"或"有本地待推送编辑"的日期，这些日期不能被云端旧值覆盖。
                    const pendingDates = new Set();
                    if (state._biddingPushInFlight) state._biddingPushInFlight.forEach(function(d) { pendingDates.add(d); });
                    if (state._biddingDirtyDates) state._biddingDirtyDates.forEach(function(d) { pendingDates.add(d); });
                    if (state._justPushedBidding) pendingDates.add(useUiStore().currentDate);
                    const _beforeKeys = Object.keys(state._biddingMemCache || {}).join(',');
                    if (!state._biddingMemCache) state._biddingMemCache = {};
                    // [BUG-FIX] 改为只覆盖云端实际返回的日期；云端没返回的日期保留本地原值。
                    // 否则一次分页/网络抖动导致某天没返回，就会把本地该天数据清空——
                    // 这正是"保存后刷新数据消失"的根因之一。
                    Object.keys(tableBidding).forEach(function(d) {
                        if (!pendingDates.has(d)) state._biddingMemCache[d] = tableBidding[d];
                    });
                    if (state.allData) state.allData.bidding = state._biddingMemCache;
                    _dbgLog('[BIDDING-STARTUP] 云端表共 ' + Object.keys(tableBidding).length +
                        ' 天，合并前本地=' + _beforeKeys +
                        '，合并后=' + Object.keys(state._biddingMemCache).join(',') +
                        '，跳过推送中=' + Array.from(pendingDates).join(','));
                } catch(tableErr) {
                    console.warn('bidding_data 表拉取失败，回退到内存缓存:', tableErr.message);
                }

                // 从 jiwang_data 独立表拉取记忘看板数据（云端表是唯一权威来源）
                try {
                    const _beforeMerge = JSON.stringify((state._jiwangMemCache || {})[useUiStore().currentDate] || null).slice(0, 200);
                    const tableJiwang = await pullJiwangFromTable();
                    if (!state._jiwangMemCache) state._jiwangMemCache = {};
                    // 重要修复：以前这里会把"这次没在 pendingDates 里的本地日期"全部删掉，
                    // 再用 tableJiwang 里有的日期重新填回来。问题是——如果某个日期的数据
                    // 已经真正保存成功（三个 pending 标记都已清空），但这次 pullJiwangFromTable()
                    // 由于任何原因（网络抖动、分页边界、云端读取瞬时延迟等）没有把该日期的行
                    // 带回来，这段代码会把本地这条已保存的数据直接删掉——即"明明保存成功，
                    // 一下拉刷新就变空白"。
                    // 现在改为：只用 tableJiwang 里实际返回的日期去覆盖/更新本地缓存，
                    // 云端这次没返回的日期一律保留本地原值，不做任何删除。
                    const pendingDates = new Set();
                    if (state._jiwangDirtyDates) state._jiwangDirtyDates.forEach(function(d) { pendingDates.add(d); });
                    if (state._jiwangPushTimers) Object.keys(state._jiwangPushTimers).forEach(function(d) { pendingDates.add(d); });
                    if (state._justPushedJiwang) pendingDates.add(useUiStore().currentDate);
                    Object.keys(tableJiwang).forEach(function(d) {
                        if (!pendingDates.has(d)) state._jiwangMemCache[d] = tableJiwang[d];
                    });
                    if (state.allData) state.allData.jiwang = state._jiwangMemCache;
                    // 记忘看板是快照式渲染（display 为一次性 ref，非 reactive），必须显式通知刷新，
                    // 否则初始云端拉取虽已灌入 _jiwangMemCache，前台却一直空白直到用户手动保存。
                    _emit('jiwang-refresh');
                    const _afterMerge = JSON.stringify(state._jiwangMemCache[useUiStore().currentDate] || null).slice(0, 200);
                    _dbgLog('pullFromCloud: jiwang 合并完成, useUiStore().currentDate=' + useUiStore().currentDate +
                        ', 云端表共 ' + Object.keys(tableJiwang).length + ' 天, 云端是否含当前日期=' + tableJiwang.hasOwnProperty(useUiStore().currentDate) +
                        ', 合并前=' + _beforeMerge + ', 合并后=' + _afterMerge);
                    if (pendingDates.size > 0) {
                        _dbgLog('pullFromCloud: 跳过覆盖有本地待推送编辑的记忘看板日期: ' + Array.from(pendingDates).join(','));
                    }
                } catch(tableErr) {
                    console.warn('jiwang_data 表拉取失败，回退到内存缓存:', tableErr.message);
                    _dbgLog('pullFromCloud: jiwang_data 表拉取失败: ' + (tableErr && tableErr.message));
                }


                // 观察组可能受云端数据影响（上一交易日"竞/昨"达标股票可能变化），清除标记重新计算
                // 买入继承同理：昨日 bought/sold 状态可能被另一台设备改过，一并清除重算
                try { localStorage.removeItem('obsEnsured_' + useUiStore().currentDate); } catch(e) {}
                try { localStorage.removeItem('boughtEnsured_' + useUiStore().currentDate); } catch(e) {}
                try { localStorage.removeItem('obsBought_' + useUiStore().currentDate); } catch(e) {}

                _dbgLog('[PULL] 云端数据同步成功');
            } catch (e) {
                _dbgLog('[AUCTION-ERR] pullFromCloud ' + (e && e.message || e));
            }
        }
