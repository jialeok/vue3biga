// qt-kline.js — 腾讯前复权日线「直连」通道（Data 层，§5）
//
// ════════════════════════════════════════════════════════════════════════════════════════
// 【为什么需要它 / 2026-11-01 用户报障】
//   灰色行（20日补位票 / 观察组继承行）不在 worker 当日抓取名单 ⇒ market_metrics 没有该日行
//   ⇒ 趋势图该日断点（九阳股份/新华传媒 10-30、冰山冷热 10-28 实证）。
//   唯一的前端兜底 trend-patch.js 走同花顺 K 线，而 2026-10-30 起同花顺通道总闸
//   FUYAO_OFF=true（fuyao-proxy.js，上游整条断掉防挂死）⇒ K 线腿毫秒级抛错 ⇒ 永远补不上。
//
// 【为什么选腾讯 ifzq —— 三条都有实测背书，不是「应该可以」】
//   ① 直连 web.ifzq.gtimg.cn，响应带 `access-control-allow-origin: *`（2026-11-01 实测）
//      ⇒ 浏览器可直接 fetch，⛔ 不经 fuyao-proxy ⇒ 不受 FUYAO-OFF 影响、不烧同花顺配额；
//   ② 与 stock_daily_pct 逐日腿【同一个源】—— db/scripts/backfill-daily-pct.mjs 已实测
//      腾讯 qfq 与同花顺 K 线 524 条真值 ±0.02 内 100% 一致（口径可信度有据，⛔ 不是"应该一样"）；
//   ③ bar 格式 [日期, open, close, high, low, volume(手)] ⇒
//        竞价涨幅 = open / 昨收 - 1（A 股开盘价 = 9:25 集合竞价成交价）
//        涨幅     = close / 昨收 - 1
//        昨日成交量 = 前一交易日 volume(手) × 100 ÷ 1e4 = 手数 ÷ 100（万股）
//      量纲已核对：九阳股份 2026-10-27 腾讯 1,286,639 手 = 12,866 万股，
//      worker 库内 10-28 行 yest_volume = 12,882（差 0.12%，前复权因子，同量纲）。
//
// 【边界 / 红线】
//   · ⛔ 拿不到「竞价量 / 竞价量比」：日线 K 线里没有 9:25 集合竞价的瞬时量
//     （§10 绝不拿全天成交量冒充竞价量）。当天的竞价量由云端 range20-precompute
//     写 market_metrics（R20-METRICS），前端 hydrateStockHistoryRow 直接读取。
//   · 读取失败 / 空序列 ⇒ 该票不出现在返回 Map 里（调用方按「取不到 = 补 null」处理，
//     趋势图画「--」），⛔ 绝不 throw 中断整批、⛔ 绝不补 0。
//   · 北交所 (4/8/92 开头) 腾讯可能无 bar ⇒ 同上按取不到处理。
// ════════════════════════════════════════════════════════════════════════════════════════

import { _dbgLog } from '../debug-log.js';

const QT_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** 6 位代码 → 腾讯符号（与 db/edge/range20-precompute/index.ts#fetchQtBars 同一条规则，⛔ 两处别改岔） */
export function qtSymOf(code) {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c)) return '';
    return (/^(6|9)/.test(c) ? 'sh' : (/^(4|8|92)/.test(c) ? 'bj' : 'sz')) + c;
}

/**
 * 拉一批股票的腾讯前复权日线。
 *
 * @param {string[]} codes6 6 位数字代码（'600825'）
 * @param {string} fromYmd 'YYYY-MM-DD'（含；调用方应自行前移若干自然日，
 *                         因为窗口首日的涨幅要用「上一个交易日收盘价」做基准）
 * @param {string} toYmd 'YYYY-MM-DD'（含；盘中调用时腾讯会给当天尚未收盘的动态 bar，
 *                         调用方自己决定是否采信）
 * @param {object} [opts] { timeoutMs=8000, concurrency=4 }
 * @returns {Promise<Map<string, Array<{ymd:string, open:number|null, close:number, volHand:number|null}>>>}
 *          code6 -> 日线（正序）。取不到 / 失败的票【不在 Map 里】（⛔ 不用空数组冒充「没有数据」）。
 */
export async function fetchQtDailyBars(codes6, fromYmd, toYmd, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 8000;
    const conc = o.concurrency || 4;
    const list = (codes6 || []).map(function (c) { return String(c || '').trim(); }).filter(Boolean);
    const out = new Map();
    if (list.length === 0 || !fromYmd || !toYmd) return out;

    let cursor = 0;
    const worker = async function () {
        for (;;) {
            const i = cursor++;
            if (i >= list.length) return;
            const code = list[i];
            const sym = qtSymOf(code);
            if (!sym) continue;
            try {
                const url = QT_BASE + '?param=' + sym + ',day,' + fromYmd + ',' + toYmd + ',320,qfq';
                const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
                let resp;
                try {
                    resp = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
                        signal: ctrl ? ctrl.signal : undefined
                    });
                } finally {
                    if (timer) clearTimeout(timer);
                }
                if (!resp.ok) throw new Error('qt HTTP ' + resp.status);
                const j = await resp.json();
                const d = (j && j.data && j.data[sym]) || {};
                const rows = d.qfqday || d.day || [];
                const bars = [];
                for (let k = 0; k < rows.length; k++) {
                    const b = rows[k];
                    if (!Array.isArray(b) || !b[0]) continue;
                    const close = Number(b[2]);
                    if (!isFinite(close) || close <= 0) continue;
                    const openRaw = (b[1] == null) ? null : Number(b[1]);
                    const volRaw = (b[5] == null) ? null : Number(b[5]);
                    bars.push({
                        ymd: String(b[0]).slice(0, 10),
                        open: (openRaw != null && isFinite(openRaw) && openRaw > 0) ? openRaw : null,
                        close: close,
                        volHand: (volRaw != null && isFinite(volRaw) && volRaw >= 0) ? volRaw : null
                    });
                }
                if (bars.length > 0) out.set(code, bars);
                // 空序列 = 该票区间无 bar（停牌 / 北交所）⇒ 不进 Map，调用方按取不到处理（§10）
            } catch (e) {
                // 单票失败不连坐整批（其余票照常返回），调用方对缺席票补 null（§10）
                _dbgLog('[QT-KLINE] ' + code + ' 拉取失败: ' + ((e && e.message) || e));
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return out;
}
