import { ref } from 'vue';
import { getGroupData } from '../app-core-api.js';
import { getAuctionChangePctHistory, _getAuctionWatchlistSet } from '../../data/watchlist-and-metrics.js';
// [RANGE20 2026-10-19] `_signalCache` 已从本文件移除：它原先只服务于「量比抢筹」的指纹缓存
// （getVolGrabSet），该功能整体下线后此处再无消费者（§16 不留无用导入）。
import { _isFormalListRow } from './sort-rules.js';
import { getPreviousTradingDay } from '../date/trading-day-helpers.js';

        // [RANGE-PCT 2026-10-14 用户口径] ⛔ 原「三天竞跌」判定（getThreeDayJingDieSet）已【整体删除】：
        //   用户在 2026-10-14 明确「三天竞跌功能去掉，换成十日涨幅功能」——
        //   「十日涨幅」toggle 的排序键来自云端 stock_range_pct（见 logic/auction/range-pct-sort.js），
        //   与「竞价量连续递减」这套口径毫无关系，把它留下只会是 §16 意义上的死代码。
        //   ⚠️ 删除还带来一处实打实的性能收益：它原先挂在 incremental-view 的【全局指纹】里，
        //      每次视图重算（含每次切 toggle / 单格编辑）都要为全部股票往回扫 5 个交易日
        //      —— 现在整段扫描消失（详见 incremental-view.js 的指纹注释）。

        // ===== 弱转强（2026-09-01）=====
        // 定义（两条件必须同时满足）：
        //   ① 前 4 个交易日「五日涨幅(changePct)」连续跌天数 >= 2（不含当日快照；至少连续 2 个交易日下跌才算“连跌”，单日下跌不算弱转强）；
        //      “跌”定义：changePct <= 0（0% 视为跌，0% 是真实值非空数值）；从最近的前一交易日往回数，遇 changePct>0 中断。
        //   ② 竞价涨幅「转向」信号（弱转强核心）：上交易日竞价涨幅（auc_pct_chg T-1）<= 0
        //      （前一天仍弱：含 0%）且 当日竞价涨幅（auc_pct_chg T）>= 0（当天转强：非负即视为转强，含 0%）。
        //      例：T-1=-1% 且 T=+2% → 达标；T-1=-2% 且 T=0% → 达标（当天从负转正）；T-1=0% 且 T=+2% → 达标；
        //          T-1=+1% 且 T=+2% → 不达标（前一天未弱）。
        //      竞价涨幅取值严格用专用字段 auc_pct_chg（绝不读 changePct/change_pct，避免被“获取涨幅”快照改写误判）。
        // 返回 Map<股票名称, 连跌天数>，仅含「弱转强」达标股票。
        // 注意：本集合由 loadWeakStrongSet（异步批量拉取历史 change_pct 后写入 weakStrongSetRef）驱动，
        // 不再在同步 computed 内做 fire-and-forget hydrate——那依赖脆弱的模块缓存响应式重算，不可靠（实测恒空）。
        // 这是与「五日竞价涨幅」趋势图(loadTrendHistory)一致的显式异步加载模式。
        export const weakStrongSetRef = ref(null); // Map<name, downStreak> | null（仅 toggle 开启时有值）
        // [WEAK-STRONG 2026-09-01] 第二档集合：仅满足「竞价转向」(上交易日<=0 且 当日>=0) 但不满足「连跌>=2」的票。
        // 排序时排在高光(连跌+转向)之后、其余票之前；不点亮高光。
        export const weakStrongTurnSetRef = ref(null); // Map<name, todayAuc> | null

        export function getWeakStrongSet(dateStr, dataSource = 'auction') {
            return weakStrongSetRef.value;
        }

        export function getWeakStrongTurnSet(dateStr, dataSource = 'auction') {
            return weakStrongTurnSetRef.value;
        }

        let _wsLoadingPromise = null;
        export function loadWeakStrongSet(dateStr, dataSource = 'auction') {
            if (_wsLoadingPromise) return _wsLoadingPromise;
            _wsLoadingPromise = (async () => {
                try {
                    const auctionData = getGroupData(dataSource);
                    const todayList = auctionData[dateStr] || [];
                    // [SHADOW-GUARD 2026-09-07] 与竞昨/平行同口径：只统计当日正式名单内的股票，
                    // 排除 market_metrics 影子行与观察组空壳。影子行是收盘 cron / worker 写入指标表、
                    // 但不在当日 9:25 名单的股票——它们混进来会让弱转强高光在收盘后凭空变多
                    // （实测：收盘后 cron 写入影子行，高光从 1 只涨到 8 只，而列表里根本看不到它们）。
                    const _formalSet = _getAuctionWatchlistSet(dateStr);
                    // 条件②：当日竞价涨幅（专用字段 auc_pct_chg）必须 >= 0（非负即视为转强，含 0%；弱转强要求当天竞价不再为负）
                    const candidates = []; // { name, todayAuc }
                    todayList.forEach(item => {
                        if (!_isFormalListRow(item, _formalSet)) return;
                        const name = item.stock.trim();
                        const todayAuc = _parseAucPct(item.auc_pct_chg != null ? item.auc_pct_chg : item.aucPctChg);
                        if (todayAuc === null || todayAuc < 0) return; // 当天竞价涨幅必须 >= 0
                        candidates.push({ name, todayAuc });
                    });
                    if (candidates.length === 0) {
                        weakStrongSetRef.value = new Map();
                        weakStrongTurnSetRef.value = new Map();
                        return;
                    }
                    // 历史：批量拉取前 4 个交易日（T-1..T-4，不含当日快照）的 change_pct + auc_pct_chg（一次 in 查询，避免逐股 hydrate）
                    const dates = [];
                    let d = dateStr;
                    for (let i = 0; i < 4; i++) {
                        const p = getPreviousTradingDay(d);
                        if (!p) break;
                        dates.push(p);
                        d = p;
                    }
                    const hist = dates.length ? await getAuctionChangePctHistory(dates, dataSource) : new Map();
                    const t1Map = dates.length ? (hist.get(dates[0]) || new Map()) : new Map(); // T-1 的 auc 映射（dates[0] = T-1）
                    const result = new Map();        // 高光：条件①(连跌>=2) + 条件②(竞价转向) 同时达标
                    const turnSet = new Map();       // 第二档：仅条件②(竞价转向) 达标、条件①(连跌>=2) 未达标
                    for (const c of candidates) {
                        const name = c.name;
                        const todayAuc = c.todayAuc;
                        // 条件②：上交易日竞价涨幅（auc_pct_chg T-1）必须 <= 0（前一天仍弱，含 0%）；缺失按不达标
                        const t1Entry = t1Map.get(name);
                        const prevAuc = t1Entry ? t1Entry.auc : null;
                        const cond2 = prevAuc !== null && prevAuc <= 0;
                        if (!cond2) continue; // 竞价未转向（上交易日>0 或缺失）→ 非高光非转向，归第三档（底部）
                        // 条件①：前 4 交易日「五日涨幅」连续跌天数 >= 2（不含当日快照）
                        const downStreak = _countConsecutiveDown(name, dates, hist);
                        if (downStreak >= 2) {
                            result.set(name, downStreak); // 连跌(>=2) + 竞价转向 → 弱转强高光（第一档）
                        } else {
                            turnSet.set(name, todayAuc); // 仅竞价转向（未连跌>=2）→ 第二档（高光之后）
                        }
                    }
                    weakStrongSetRef.value = result;
                    weakStrongTurnSetRef.value = turnSet;
                } catch (e) {
                    weakStrongSetRef.value = new Map();
                    weakStrongTurnSetRef.value = new Map();
                } finally {
                    _wsLoadingPromise = null;
                }
            })();
            return _wsLoadingPromise;
        }

        // 解析竞价涨幅原始值（auc_pct_chg / aucPctChg）为数值；null/空/非法返回 null。
        // 仅读竞价涨幅专用字段，绝不回退到 changePct/change_pct（后者会被“获取涨幅”快照改写，导致弱转强误判）。
        function _parseAucPct(raw) {
            if (raw === null || raw === undefined) return null;
            const s = String(raw).replace('%', '').replace('+', '').trim();
            if (s === '') return null;
            const n = parseFloat(s);
            return isFinite(n) ? n : null;
        }

        // 基于批量拉取的 hist（Map<date, Map<stock, num>>）从最近的前一交易日(T-1)往回数连续「changePct<=0」的天数。
        // “跌”含 0%（0% 是真实值，非空缺）；遇 changePct>0 或数据缺失(null/undefined) 即中断（保守，不臆测缺失为跌）。
        function _countConsecutiveDown(name, dates, hist) {
            let streak = 0;
            for (let i = 0; i < dates.length; i++) {
                const dayMap = hist.get(dates[i]);
                const entry = dayMap ? dayMap.get(name) : undefined;
                if (!entry || entry.cp === null || entry.cp === undefined) break; // 数据缺失 → 无法确认连跌，中断
                if (entry.cp <= 0) streak++;                       // 跌（含 0%）
                else break;                                         // 涨幅>0 → 连跌中断
            }
            return streak;
        }
