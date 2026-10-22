// trend-patch.js — 趋势图「缺数据日」的同花顺免费兜底补缺（Logic 编排层，§4）
//
// 【为什么要它 / 2026-10-21 用户报障】
//   早盘竞价看板行展开的「近 5 日趋势」，补位票（range20 前五注入行，带「20天」标）在
//   展示日当天整格空白：库证据 = 时代万恒 2026-10-20 在 market_metrics 【无行】
//   （它不在当天正式列表 ⇒ worker 9:25 抓取名单里没有它 ⇒ 什么都没写），
//   而 hydrateStockHistoryRow 只会从 market_metrics 云端补水 ⇒ 永远补不到 ⇒ 趋势该日空白。
//
// 【数据来源 —— 全部同花顺免费通道，0 猫抓额度（用户红线）】
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
import { fuyaoApiGet, tickerToThscode } from '../../data/api/fuyao-proxy.js';
import { _dbgLog } from '../../data/debug-log.js';

// 会话缓存：'股票名|YYYY-MM-DD' -> 补缺值对象（含 null 字段 = 「真的没有」，防重复请求 §32）。
// 「今天」的键不写进缓存（盘中涨幅在动，见上）。
const _patchCache = new Map();
// 单飞：'股票名' -> Promise（同一只票的并发补缺请求只发一次）
const _inflight = new Map();

/** 北京时区「今天」'YYYY-MM-DD'（timestamp 闸门 / 当日判定用） */
function _beijingTodayYmd() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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
 *  是「这批竞价数据属于哪个交易日 / 是不是终态」的唯一判据（见下方快照腿的闸门）。 */
async function _fetchAuctionSnapshotItems(thscodes) {
    const out = [];
    let timestamp = 0;
    let dataStatus = '';
    for (let i = 0; i < thscodes.length; i += 40) {
        const chunk = thscodes.slice(i, i + 40);
        const data = await fuyaoApiGet('/api/a-share/auction/snapshot', {
            thscodes: chunk.join(','),
            stage: 'final'
        });
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
        }

        // ③ 快照腿：只补「今天」的竞价量（auction_volume 手 → 万股），双重闸门防跨日
        const todayWant = want.filter(function(w) { return w.days.indexOf(todayYmd) >= 0; });
        if (todayWant.length > 0) {
            try {
                // [TREND-PATCH-FIX 2026-10-22] 快照接口的 thscodes 参数【必须带交易所后缀】
                //   （thscode 格式）：传 6 位裸码实测返回 code:1002（上游错误）⇒ fuyaoApiGet throw
                //   ⇒ 快照腿整腿失败 ⇒ 当日竞价量/竞价涨幅/量比恒补不上（新华传媒 10-22 实证，
                //   600825 裸码 1002 / 600825.SH 成功 data_status=final）。这是【类】问题：
                //   所有走快照腿的补缺请求都命中，⛔ 不是单只票特例。K 线腿两码通吃、不用改。
                const snap = await _fetchAuctionSnapshotItems(todayWant.map(function(w) {
                    return tickerToThscode(w.code);
                }));
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

        // ④ 落缓存（「今天」不缓存 —— 盘中 K 线收盘价在动；负结果也缓存 = §32 防请求风暴）
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
