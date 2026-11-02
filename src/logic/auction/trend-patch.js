// trend-patch.js — 趋势图「缺数据日」的同花顺免费兜底补缺（Logic 编排层，§4）
//
// 【为什么要它 / 2026-10-21 用户报障】
//   早盘竞价看板行展开的「近 5 日趋势」，补位票（range20 前五注入行，带「20天」标）在
//   展示日当天整格空白：库证据 = 时代万恒 2026-10-20 在 market_metrics 【无行】
//   （它不在当天正式列表 ⇒ worker 9:25 抓取名单里没有它 ⇒ 什么都没写），
//   而 hydrateStockHistoryRow 只会从 market_metrics 云端补水 ⇒ 永远补不到 ⇒ 趋势该日空白。
//
// 【数据来源 —— 0 猫抓额度】
//   ★ [QT-PATCH 2026-11-01] 同花顺通道停用期间（FUYAO_OFF，见 fuyao-proxy.js），
//     K 线腿自动改走【腾讯 qfq 日线直连】（data/api/qt-kline.js；与 stock_daily_pct 逐日腿
//     同一个源，backfill-daily-pct.mjs 已实测 524 条与同花顺真值 ±0.02 内 100% 一致），
//     快照腿整腿跳过。换算函数 computeQtDayPatches 与 computeKlineDayPatch 同语义。
//   同花顺通道可用时（FUYAO_OFF=false）走以下原始通道：
//   · K 线 historical（fetchFuyaoDailyPctRange，同一次请求顺带三样，零额外额度）：
//       - 涨幅     changePct  = close / 昨收 - 1（fetchFuyaoDailyPctRange 主返回，已实测与库内
//                    change_pct 逐位对齐：10-19 K线 -9.96% = 库内 -9.96%）；
//       - 竞价涨幅 aucPctChg  = open / 昨收 - 1（opts.openOut；A 股开盘价 = 9:25 集合竞价成交价；
//                    实测 10-19 K线 -9.89% = 库内 auc_pct_chg -9.89%）；
//       - 昨日成交量 yestVolume = 前一交易日 K 线 volume ÷ 1e4（万股；实测 10-16 的 8181 万股 ≈
//                    库内 10-19 行 yest_volume 8176，同单位同口径）。
//   · 竞价快照 auction/snapshot?stage=final（仅「当天」有；滚动最近交易日）：
//       - 竞价量   volume = auction_volume ÷ 100（手 → 万股）。
//         ⚠️ 9:25 集合竞价成交量是【瞬时值】，K 线里没有、过了当天上游就不再给 ——
//            所以历史缺日的竞价量恒为 null（趋势图画「--」，§10 宁缺勿错 ⛔ 不拿全天成交量冒充）。
//         ⚠️ timestamp 闸门：快照服务端日期 ≠ 目标日 ⇒ 整体拒绝（与 worker runTodaySnapshotPatch
//            同一条安全约束，防止把上一交易日的竞价量写到历史日头上）。
//
// 【边界 / 红线】
//   · ⛔ 只产出「趋势面板的展示数据」，⛔ 不写 _auctionMemCache、⛔ 不写 market_metrics /
//     auction_watchlist（§6 不产生影子真相；写库是 worker 的职责）。
//   · 缺什么补什么：库里已有值的字段一律不覆盖（调用方合并时只填 null 位）。
//   · K 线取不到 / 快照不认识该代码 ⇒ 该字段 null（趋势图该点画「--」，§10 绝不补 0）。
//   · 会话缓存 + 单飞（§32）：同一 (股票, 交易日) 的补缺结果缓存复用；「今天」不缓存
//     （盘中 K 线收盘价在动，缓存会画出过时的涨幅线）。
//
// @param {Array<{stock:string, code:string}>} items 要补缺的票（须带 code，K 线按代码请求）
// @param {Map<string, string[]>} missingByStock 股票名 -> 缺数据日列表（'YYYY-MM-DD'）
// @param {object} [opts] { requestTimeoutMs }
// @returns {Promise<Map<string, Map<string, {aucPctChg,changePct,yestVolume,volume,aucVolRatio}>>>}
//          股票名 -> (日期 -> 补缺值；拿不到的字段为 null —— 调用方只用来填 null 位)
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { fuyaoApiGet, tickerToThscode, isFuyaoOff, isFuyaoSnapshotAllowed } from '../../data/api/fuyao-proxy.js';
import { fetchQtDailyBars } from '../../data/api/qt-kline.js';
import { fetchQtRealtimeQuotes, qtAucPctOf, qtChangePctOf } from '../../data/api/qt-quote.js';
import { _dbgLog } from '../../data/debug-log.js';

// 会话缓存：'股票名|YYYY-MM-DD' -> 补缺值对象（含 null 字段 = 「真的没有」，防重复请求 §32）。
// 「今天」的键不写进缓存（盘中涨幅在动，见上）。
const _patchCache = new Map();
// 单飞：'股票名' -> Promise（同一只票的并发补缺请求只发一次）
const _inflight = new Map();
/**
 * ★★ [FUYAO-SNAPSHOT 2026-11-02] 竞价快照腿的**硬超时**。
 *   这不是「顺手加个超时」，而是 2026-10-30 那次「点不动、切日期没反应」事故的正面教训：
 *   事故直接成因就是 6 处调用没传 timeoutMs ⇒ 单请求挂到边缘函数自己超时为止（约 120s），
 *   几十个永久 pending 请求把标签页网络占满。⇒ 本端点放行时**必须**带超时，且由
 *   fuyao-proxy.js 的 allowWhenOff 闸门强制校验（没 timeoutMs 的放行直接被拒）。
 *   实测代理健康时该接口 ~2.9s（2026-11-02），6s 留一倍余量。
 */
const SNAPSHOT_TIMEOUT_MS = 6000;

/** 北京时区「今天」'YYYY-MM-DD'（timestamp 闸门 / 当日判定用） */
function _beijingTodayYmd() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时区当前时刻 'HH:MM:SS'（收盘口径分界用，见实时行情腿） */
function _beijingHmsNow() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

/**
 * 【纯函数】腾讯 qfq 日线腿换算（[QT-PATCH 2026-11-01]，与 computeKlineDayPatch 同语义、同出口）。
 *
 * 为什么必须有它：同花顺通道 2026-10-30 起总闸停用（FUYAO_OFF，见 fuyao-proxy.js），
 * K 线腿毫秒级抛错 ⇒ 补位票/灰色行趋势图缺日永远补不上（用户报障的类根因）。
 * 腾讯 ifzq 与 stock_daily_pct 逐日腿同源（backfill-daily-pct.mjs 已实测 524 条 ±0.02 内
 * 100% 一致），换算口径与 computeKlineDayPatch 逐字对齐：
 *   · changePct  = close / 昨收 - 1（百分比，两位小数）
 *   · aucPctChg  = open / 昨收 - 1（A 股开盘价 = 9:25 集合竞价成交价）
 *   · yestVolume = 前一根 bar 的 volume(手) ÷ 100（手 → 万股；量纲已对 worker 库内核对）
 *   · volume / aucVolRatio 恒 null（日线里没有 9:25 竞价瞬时量，§10 绝不拿全天量冒充）
 *
 * @param {Array<{ymd:string, open:number|null, close:number, volHand:number|null}>|null} bars 腾讯日线（乱序可）
 * @param {string[]} days 要补的交易日（'YYYY-MM-DD'）
 * @param {object} [opts] { noBarYmd } —— 见下方「当日无 bar」分支
 * @returns {Map<string, {aucPctChg:number|null, changePct:number|null, yestVolume:number|null}>}
 */
export function computeQtDayPatches(bars, days, opts) {
    const out = new Map();
    if (!Array.isArray(bars) || bars.length === 0 || !Array.isArray(days)) return out;
    const noBarYmd = String((opts && opts.noBarYmd) || '');
    const sorted = bars.slice().sort(function (a, b) { return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0); });
    const round2 = function (x) { return Math.round(x * 100) / 100; };
    for (let i = 0; i < days.length; i++) {
        const d = days[i];
        let ti = -1;
        for (let k = 0; k < sorted.length; k++) { if (sorted[k].ymd === d) { ti = k; break; } }
        if (ti < 0) {
            // ★★ [QT-TODAY 2026-11-02] 「当日还没有 bar」≠「这一格什么都补不了」。
            //
            //   用户报障（第三次，逐字）：「九阳股份和新华传媒……还是没有当天数据，比如竞价涨幅，
            //   昨日成交量等……前四天历史记录是有的」。前四天有、只有今天空 —— 因为
            //   **腾讯日线的当日 bar 要收盘后才成型**（实测 2026-11-02 17:0x 的 sz002242 序列
            //   最后一根仍是 2026-10-30），于是「今天」恒 ti<0 ⇒ 整日 continue ⇒ 三条腿全 null。
            //   但其中【昨日成交量】与今天的 bar 无关，只需要「上一个交易日那一根」——
            //   序列最后一根就是它（且必须严格早于该日，防把未来的 bar 当昨收基准）。
            //   ⚠️ aucPctChg / changePct 仍然留 null：算它们需要【今天自己的】开/收盘价，
            //      日线里没有 ⇒ 交给后面的「快照腿 / 实时行情腿」补（§10 绝不拿昨天的数冒充今天）。
            if (noBarYmd && d === noBarYmd) {
                const last = sorted[sorted.length - 1];
                if (last && last.ymd < d && last.volHand != null && last.volHand > 0) {
                    out.set(d, { aucPctChg: null, changePct: null, yestVolume: round2(last.volHand / 100) });
                }
            }
            continue;                                              // 停牌 / 未上市 / 当日未成型 ⇒ 其余字段不补
        }
        const prev = ti > 0 ? sorted[ti - 1] : null;
        if (!prev || !prev.close || prev.close <= 0) continue;  // 首根无昨收基准 ⇒ 算不出（§10 不猜）
        const tb = sorted[ti];
        out.set(d, {
            aucPctChg: (tb.open != null && tb.open > 0) ? round2((tb.open / prev.close - 1) * 100) : null,
            changePct: round2((tb.close / prev.close - 1) * 100),
            yestVolume: (prev.volHand != null && prev.volHand > 0) ? round2(prev.volHand / 100) : null
        });
    }
    return out;
}

/**
 * 【纯函数】K 线腿换算：把 fetchFuyaoDailyPctRange 的三份出口换算成某一天的补缺值。
 *   · changePct  = keep(ymd)                        —— close/昨收-1（百分比数值）
 *   · aucPctChg  = openKeep(ymd)                    —— open/昨收-1（百分比数值）
 *   · yestVolume = volKeep(前一根K线) ÷ 1e4         —— 股 → 万股（与 yest_volume 同单位）
 * 「前一根」= volKeep 里【严格早于 ymd 的最近一天】—— 用 K 线自己的序列算，天然正确处理
 * 周末/假期，不依赖交易日历（与 _ebbCtxOf「纯函数不拖日历」同一纪律）。
 *
 * @param {string} ymd 'YYYYMMDD'（K 线键格式）
 * @param {Map<string, number>|null} keep fetchFuyaoDailyPctRange 主返回（日涨幅%）
 * @param {Map<string, number>|null} openKeep 开盘涨幅%（opts.openOut）
 * @param {Map<string, number>|null} volKeep 成交量（股，opts.volOut；含窗口外日子）
 * @returns {{aucPctChg:number|null, changePct:number|null, yestVolume:number|null}}
 */
export function computeKlineDayPatch(ymd, keep, openKeep, volKeep) {
    const changePct = (keep && keep.get(ymd) != null && isFinite(keep.get(ymd))) ? keep.get(ymd) : null;
    const aucPctChg = (openKeep && openKeep.get(ymd) != null && isFinite(openKeep.get(ymd))) ? openKeep.get(ymd) : null;
    let yestVolume = null;
    if (volKeep && volKeep.size > 0) {
        const days = Array.from(volKeep.keys()).sort();
        let prev = null;
        for (let i = 0; i < days.length; i++) {
            if (days[i] < ymd) prev = days[i]; else break;
        }
        if (prev != null) {
            const v = volKeep.get(prev);
            if (v != null && isFinite(v) && v > 0) yestVolume = v / 1e4;
        }
    }
    return { aucPctChg: aucPctChg, changePct: changePct, yestVolume: yestVolume };
}

/** 竞价快照分批（与 suspend.js 同一上游；这里要 auction_volume / auction_pct + 顶层闸门字段）。
 *  返回 { items, timestamp, dataStatus }——timestamp / data_status 在【顶层 data】上，
 *  是「这批竞价数据属于哪个交易日 / 是不是终态」的唯一判据（见下方快照腿的闸门）。
 *  ⚠️ [FUYAO-SNAPSHOT 2026-11-02] `fuyaoOpts` 必须带 `{ timeoutMs, allowWhenOff }`：
 *     总闸开着时本端点靠它受控放行（见 fuyao-proxy.js 的 SNAPSHOT_ONLY_PATH），
 *     且**没有 timeoutMs 一律拒绝** —— 10-30 卡死就是「无超时请求堆积」造成的。 */
async function _fetchAuctionSnapshotItems(thscodes, fuyaoOpts) {
    const out = [];
    let timestamp = 0;
    let dataStatus = '';
    for (let i = 0; i < thscodes.length; i += 40) {
        const chunk = thscodes.slice(i, i + 40);
        const data = await fuyaoApiGet('/api/a-share/auction/snapshot', {
            thscodes: chunk.join(','),
            stage: 'final'
        }, fuyaoOpts);
        if (i === 0) {
            timestamp = Number(data && data.timestamp) || 0;
            dataStatus = String((data && data.data_status) || '');
        }
        const arr = (data && data.item) || [];
        for (let k = 0; k < arr.length; k++) out.push(arr[k]);
    }
    return { items: out, timestamp: timestamp, dataStatus: dataStatus };
}

export function ensureTrendPatch(items, missingByStock, opts) {
    const o = opts || {};
    const list = (items || []).filter(function(it) {
        return it && it.stock && it.code &&
            Array.isArray(missingByStock && missingByStock.get(it.stock)) &&
            missingByStock.get(it.stock).length > 0;
    });
    if (list.length === 0) return Promise.resolve(new Map());

    // 单飞：同名的在途请求直接复用（快速展开/收起不会并发打两遍上游）
    const flyKey = list.map(function(it) { return it.stock; }).join(',');
    const fly = _inflight.get(flyKey);
    if (fly) return fly;

    const p = (async function() {
        const todayYmd = _beijingTodayYmd();

        // ① 过滤掉缓存已命中的 (股票, 日)；「今天」永不命中缓存（盘中数据在动）
        const want = [];   // [{stock, code, days:[ymd...]}]
        const result = new Map();
        list.forEach(function(it) {
            const name = String(it.stock).trim();
            const days = missingByStock.get(name).filter(function(d) {
                if (d === todayYmd) return true;                 // 今天：不读缓存（见上）
                if (_patchCache.has(name + '|' + d)) {
                    _putDay(result, name, d, _patchCache.get(name + '|' + d));
                    return false;
                }
                return true;
            });
            if (days.length > 0) want.push({ stock: name, code: it.code, days: days });
        });

        // ② K 线腿：涨幅 / 竞价涨幅 / 昨日成交量（一次请求三样）
        if (want.length > 0) {
            const allDates = [];
            const dateSet = new Set();
            want.forEach(function(w) { w.days.forEach(function(d) { if (!dateSet.has(d)) { dateSet.add(d); allDates.push(d); } }); });

            if (isFuyaoOff()) {
                // ★★ [QT-PATCH 2026-11-01] 同花顺通道停用（FUYAO_OFF，见 fuyao-proxy.js）⇒
                //   腾讯 qfq 日线直连（Data 层 qt-kline.js，与 stock_daily_pct 同源同口径，
                //   不经 fuyao-proxy ⇒ 不受总闸影响、0 同花顺配额）。换算语义与下方 fuyao 腿逐字一致：
                //   三样出口 = aucPctChg / changePct / yestVolume；竞价量 / 量比恒 null（§10）。
                //   历史日的竞价量任何上游都不再有（9:25 瞬时值），当天则由云端 R20-METRICS 写库兜底。
                try {
                    // 窗口首日需要「上一个交易日收盘价」做基准 ⇒ 起点前移 10 个自然日（覆盖长假）
                    const sortedDates = allDates.slice().sort();
                    const startMs = Date.parse(sortedDates[0] + 'T00:00:00+08:00') - 10 * 86400000;
                    const endMs = Date.parse(sortedDates[sortedDates.length - 1] + 'T00:00:00+08:00') + 2 * 86400000;
                    const toYmd = new Date(endMs).toISOString().slice(0, 10);
                    const fromYmd = new Date(startMs).toISOString().slice(0, 10);
                    const barsByCode = await fetchQtDailyBars(
                        want.map(function(w) { return w.code; }), fromYmd, toYmd, { timeoutMs: 8000, concurrency: 4 });
                    want.forEach(function(w) {
                        // ★ [QT-TODAY 2026-11-02] 传 noBarYmd：当日 bar 收盘前不存在，
                        //   但「昨日成交量」只依赖上一交易日那根 ⇒ 必须仍然产出（见函数头注释）。
                        const m = computeQtDayPatches(barsByCode.get(w.code) || null, w.days, { noBarYmd: todayYmd });
                        w.days.forEach(function(d) {
                            const p = m.get(d) || { aucPctChg: null, changePct: null, yestVolume: null };
                            _putDay(result, w.stock, d, {
                                aucPctChg: p.aucPctChg, changePct: p.changePct,
                                yestVolume: p.yestVolume, volume: null, aucVolRatio: null
                            });
                        });
                    });
                } catch (e) {
                    // §10：失败必须可见，但只降级本腿（其余腿照走），⛔ 不把「取不到」伪装成「没有数据」
                    _dbgLog('[TREND-PATCH] 腾讯K线腿失败: ' + (e && e.message || e));
                }
            } else {
            const openOut = new Map();
            const volOut = new Map();
            let pct = null;
            try {
                pct = await fetchFuyaoDailyPctRange(
                    want.map(function(w) { return { stock: w.stock, code: w.code }; }),
                    allDates,
                    { requestTimeoutMs: o.requestTimeoutMs || 15000, openOut: openOut, volOut: volOut }
                );
            } catch (e) {
                // §10：失败必须可见，但只降级本腿（快照腿照走），⛔ 不把「取不到」伪装成「没有数据」
                _dbgLog('[TREND-PATCH] K线腿失败: ' + (e && e.message || e));
            }
            want.forEach(function(w) {
                const keep = (pct && pct.get(w.stock)) || null;
                const openKeep = openOut.get(w.stock) || null;
                const volKeep = volOut.get(w.stock) || null;
                w.days.forEach(function(d) {
                    const ymd = d.replace(/-/g, '');
                    const r = computeKlineDayPatch(ymd, keep, openKeep, volKeep);
                    _putDay(result, w.stock, d, {
                        aucPctChg: r.aucPctChg, changePct: r.changePct,
                        yestVolume: r.yestVolume, volume: null, aucVolRatio: null
                    });
                });
            });
            } // else（同花顺通道可用）结束
        }

        // ③ 快照腿：只补「今天」的竞价量（auction_volume 手 → 万股），双重闸门防跨日
        //   ★★ [FUYAO-SNAPSHOT 2026-11-02] 总闸开着时**改为受控放行**（只放行这一个端点，且强制
        //   6s 超时）。原注释「当天的竞价量/量比改由云端 R20-METRICS 写 market_metrics」经实测证伪：
        //   `select count(*) from market_metrics where source='range20'` = **0 行**（自该能力上线起
        //   从未成功写过一行），所以「前端不补、等云端写」等于永远不补 —— 2026-11-02 九阳/新华
        //   竞价量、竞价量比整列空白就是这条假设的代价。竞价量比在别处没有任何等价来源
        //   （腾讯的 [49] 量比是另一个口径），只能走这里。
        const todayWant = want.filter(function(w) { return w.days.indexOf(todayYmd) >= 0; });
        const _snapLegOn = !isFuyaoOff() || isFuyaoSnapshotAllowed();
        if (todayWant.length > 0 && _snapLegOn) {
            try {
                // [TREND-PATCH-FIX 2026-10-22] 快照接口的 thscodes 参数【必须带交易所后缀】
                //   （thscode 格式）：传 6 位裸码实测返回 code:1002（上游错误）⇒ fuyaoApiGet throw
                //   ⇒ 快照腿整腿失败 ⇒ 当日竞价量/竞价涨幅/量比恒补不上（新华传媒 10-22 实证，
                //   600825 裸码 1002 / 600825.SH 成功 data_status=final）。这是【类】问题：
                //   所有走快照腿的补缺请求都命中，⛔ 不是单只票特例。K 线腿两码通吃、不用改。
                const snap = await _fetchAuctionSnapshotItems(todayWant.map(function(w) {
                    return tickerToThscode(w.code);
                }), { timeoutMs: SNAPSHOT_TIMEOUT_MS, allowWhenOff: isFuyaoOff() });
                // 🔴 双重日期闸门（与 worker runTodaySnapshotPatch 同一条安全约束）：
                //   ① data_status === 'final' —— 竞价终态才算数。实测 00:34 打开时快照仍挂着
                //      【上一交易日】的竞价（data_status='not_ready'）⇒ 不闸门就会把昨天的竞价量
                //      写到今天头上（这是本函数最阴险的坑，2026-10-21 探针实证）。
                //   ② 快照服务端 timestamp 的北京日期 === 目标日 —— 防止上游给「滚动最近交易日」。
                const snapYmd = snap.timestamp > 0
                    ? new Date(snap.timestamp + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
                if (snap.dataStatus !== 'final' || snapYmd !== todayYmd) {
                    _dbgLog('[TREND-PATCH] 快照闸门拒绝（status=' + snap.dataStatus +
                        ' 服务端日=' + snapYmd + ' 目标日=' + todayYmd + '）⇒ 当日竞价量本次补不上');
                } else {
                    const codeOf = {};
                    // [TREND-PATCH-FIX 2026-10-22] 双键登记：响应 item.thscode 带【.SH/.SZ 后缀】
                    //   （实测 "600825.SH"），此前只登记 6 位裸码键 ⇒ 即使请求成功也静默匹配失败。
                    //   两键都指同一股票名，后缀/裸码命中皆可（双保险 bug 的第二处）。
                    todayWant.forEach(function(w) {
                        const bare = String(w.code || '').trim();
                        codeOf[bare] = w.stock;
                        const ths = tickerToThscode(bare);
                        if (ths !== bare) codeOf[ths] = w.stock;
                    });
                    (snap.items || []).forEach(function(it) {
                        if (!it || !it.thscode) return;
                        const name = codeOf[it.thscode];
                        if (!name) return;
                        const prev = (result.get(name) && result.get(name).get(todayYmd)) ||
                            { aucPctChg: null, changePct: null, yestVolume: null, volume: null, aucVolRatio: null };
                        const day = Object.assign({}, prev);
                        // 竞价量：手 → 万股（实测 auction_amount ÷ price 校验：38830.49 手 = 388.3 万股 ✓）
                        if (day.volume == null && it.auction_volume != null && isFinite(Number(it.auction_volume))) {
                            day.volume = Number(it.auction_volume) / 100;
                        }
                        // 竞价涨幅：快照的 auction_pct 是 9:25 终态值，优先于 K 线 open 换算值
                        if (it.auction_pct != null && isFinite(Number(it.auction_pct))) {
                            day.aucPctChg = Number(it.auction_pct);
                        }
                        // 竞价量比（倍数）：同一次快照顺带（趋势面板有这张图，缺一天也是断线）
                        if (it.auction_volume_ratio != null && isFinite(Number(it.auction_volume_ratio))) {
                            day.aucVolRatio = Number(it.auction_volume_ratio);
                        }
                        _putDay(result, name, todayYmd, day);
                    });
                }
            } catch (e) {
                _dbgLog('[TREND-PATCH] 快照腿失败（竞价量本次补不上）: ' + (e && e.message || e));
            }
        }

        // ④ ★★ [QT-TODAY 2026-11-02] 「今天」的闭环：涨幅回填 + 腾讯实时行情兜底。
        //
        //   为什么必须有这一步（竞价期能不能看到当天涨幅，全看这里）：
        //     · 今天这根 K 线 bar 收盘后才成型 ⇒ K 线腿对「今天」只能给出「昨日成交量」；
        //     · 快照腿成功时能给 竞价量 / 竞价涨幅 / 竞价量比，但**给不出「涨幅」**（它没有收盘价）；
        //     · 于是「涨幅」这张图今天这一格永远是 `--` —— 用户报障里「五日趋势图没有显示出来」
        //       的另一半原因就在这。
        //
        //   两小步，⛔ 都只填 null 位（§10 不覆盖已有值）：
        //     ④.1 竞价期（15:00 前）的 change_pct 就是**竞价涨幅** —— 与 worker 9:25 写库
        //          / range20-precompute 的 `leg='auc'` 逐字同口径（15:05 那轮才覆盖成收盘涨幅）。
        //          所以只要竞价涨幅有了、涨幅还空着，就直接取它。
        //     ④.2 还空着的（快照腿失败 / 今开未定 / 本票不在快照返回里）⇒ 腾讯实时行情补：
        //          竞价涨幅 = 今开/昨收-1（已实测与同花顺 auction_pct 逐位一致），
        //          涨幅（15:00 后）= 现价/昨收-1。
        //          这条腿**不依赖 fuyao 与 Supabase**，是竞价期最可靠的一条。
        const _hmsNow = String(o.nowHms || _beijingHmsNow());   // nowHms 仅供单测注入，生产不传
        const _afterClose = _hmsNow >= '15:00:00';
        const _needQuote = [];
        todayWant.forEach(function(w) {
            const cur = (result.get(w.stock) && result.get(w.stock).get(todayYmd)) || null;
            if (!cur) { _needQuote.push(w); return; }
            if (cur.changePct == null && !_afterClose && cur.aucPctChg != null) {
                cur.changePct = cur.aucPctChg;                    // ④.1 竞价期同口径
            }
            if (cur.aucPctChg == null || cur.changePct == null) _needQuote.push(w);
        });
        if (_needQuote.length > 0) {
            try {
                const qmap = await fetchQtRealtimeQuotes(
                    _needQuote.map(function(w) { return String(w.code || '').trim(); }),
                    { timeoutMs: 5000 });
                _needQuote.forEach(function(w) {
                    const q = qmap.get(String(w.code || '').trim());
                    // 🔴 日期闸门：行情时间戳必须是【今天】。上游给的是「最近交易日」，
                    //   不闸门就会把上一交易日的今开写到今天头上（本函数最阴险的坑，同快照腿）。
                    if (!q || q.ymd !== todayYmd) return;
                    const auc = qtAucPctOf(q);
                    const chg = qtChangePctOf(q);
                    const prev = (result.get(w.stock) && result.get(w.stock).get(todayYmd)) ||
                        { aucPctChg: null, changePct: null, yestVolume: null, volume: null, aucVolRatio: null };
                    const day = Object.assign({}, prev);
                    if (day.aucPctChg == null && auc != null) day.aucPctChg = auc;
                    if (day.changePct == null) day.changePct = _afterClose ? chg : (auc != null ? auc : chg);
                    _putDay(result, w.stock, todayYmd, day);
                    _dbgLog('[TREND-PATCH-QT] ' + w.stock + ' 今日行情补齐（' + (q.hms || '—') + '）: 竞价涨幅=' +
                        (day.aucPctChg == null ? '—' : day.aucPctChg) + ' 涨幅=' +
                        (day.changePct == null ? '—' : day.changePct) + ' 竞价量=' +
                        (day.volume == null ? '—' : day.volume) + ' 量比=' +
                        (day.aucVolRatio == null ? '—' : day.aucVolRatio));
                });
            } catch (e) {
                // §10：失败必须可见，但只降级本腿（其余腿的结果照用），⛔ 不把「取不到」伪装成「没有」
                _dbgLog('[TREND-PATCH-QT] 实时行情腿失败（今日涨幅本次补不上）: ' + (e && e.message || e));
            }
        }

        // ⑤ 落缓存（「今天」不缓存 —— 盘中 K 线收盘价在动；负结果也缓存 = §32 防请求风暴）
        result.forEach(function(byYmd, name) {
            byYmd.forEach(function(v, d) {
                if (d !== todayYmd) _patchCache.set(name + '|' + d, v);
            });
        });
        return result;
    })().finally(function() {
        _inflight.delete(flyKey);
    });
    _inflight.set(flyKey, p);
    return p;
}

function _putDay(result, name, d, v) {
    let m = result.get(name);
    if (!m) { m = new Map(); result.set(name, m); }
    m.set(d, v);
}
