// qt-quote.js — 腾讯【实时行情】「直连」通道（Data 层，§5）
//
// ════════════════════════════════════════════════════════════════════════════════════════
// 【为什么需要它 / 2026-11-02 用户报障（第三次报同一个现象）】
//   用户原话：「20日涨幅中，今天11月2日九阳股份和新华传媒这两只是灰色行，还是没有当天数据，
//     比如竞价涨幅，昨日成交量等，也就是五日趋势图没有显示出来，这个问题已经改了很多次了……
//     前四天历史记录是有的……会影响我早上选股的。」
//
//   根因不是「补缺代码写错了」，而是【竞价期没有任何一条数据腿能给出『今天』】：
//     · 腾讯历史日线（qt-kline.js）—— **当日 bar 要等收盘后才成型**，9:26 时序列最后一根
//       是上一交易日 ⇒ computeQtDayPatches 找不到「今天」，整日 continue ⇒ 当天 3 条腿全 null；
//     · 同花顺快照腿 —— FUYAO_OFF 总闸拦着（见 fuyao-proxy.js）；
//     · market_metrics —— 补位票不在 worker 9:25 抓取名单 ⇒ 库里没有该日行（实测 2026-11-02：
//       全表 56 行全是 source='worker'，source='range20' 自上线起 **0 行**）。
//   ⇒ 三条腿同时缺「今天」，趋势图当日必然全「--」。这是【类】问题，不是九阳/新华两只票的巧合。
//
// 【为什么腾讯实时行情是正确的那条腿 —— 有交叉验证，不是「应该能用」】
//   2026-11-02 实测（九阳股份 002242 / 新华传媒 600825，同一天同时对比两个源）：
//     腾讯 qt：今开 21.50 / 昨收 22.14 ⇒ 21.50/22.14-1 = **-2.8907%**
//     同花顺快照：auction_pct = **-2.8907%**        ← 逐位一致
//     腾讯 qt：今开 12.02 / 昨收 13.36 ⇒ **-10.0299%**
//     同花顺快照：auction_pct = **-10.0299%**       ← 逐位一致
//   ⇒ 竞价涨幅 = 今开 / 昨收 - 1 这个换算与同花顺口径【完全等价】（A 股开盘价 = 9:25 集合竞价成交价）。
//   响应头 `access-control-allow-origin: *`（实测）⇒ 浏览器可直连，⛔ 不经 fuyao-proxy
//   ⇒ 不受 FUYAO-OFF 影响、不烧同花顺配额、不依赖 Supabase 边缘函数是否被部署。
//
// 【⛔ 拿不到什么（§10 宁缺勿错，⛔ 绝不拿别的东西冒充）】
//   · 「竞价量」：[6] 是【当日累计成交量】，只有 9:25~9:30 那 5 分钟内它恰好等于集合竞价量 ——
//     ⛔ 但这条时窗推断不可靠（晚几秒打开就变成盘中累计），所以**本模块不产出竞价量**。
//     竞价量/竞价量比仍由同花顺快照腿负责（见 trend-patch.js 的受控放行）。
//   · 「竞价量比」：同花顺的定义是「集合竞价量 ÷ 过去 5 日平均集合竞价量」，腾讯的 [49] 量比是
//     另一个口径（盘中累计量 / 5 日均每分钟量），⛔ 两者不可互换。
//   · 名称字段 [1] 是 GBK 编码 ⇒ 本模块 **不解析名称**（只取数值字段），避免乱码连累解析。
//
// 【边界】
//   · 单票失败 / 取不到 ⇒ 该票不出现在返回 Map 里（调用方按「取不到 = 补 null」处理），
//     ⛔ 绝不 throw 中断整批、⛔ 绝不补 0。
//   · 行情时间戳 [30] 一并返回（'YYYY-MM-DD' + 'HH:MM:SS'）—— 调用方做「是不是今天」的闸门
//     必须用它，⛔ 不许用本地时钟猜（防跨日污染，与 worker / trend-patch 同一条安全约束）。
// ════════════════════════════════════════════════════════════════════════════════════════

import { _dbgLog } from '../debug-log.js';
import { qtSymOf } from './qt-kline.js';

const QT_QUOTE_BASE = 'https://qt.gtimg.cn/q=';
/** 单次请求的代码上限（腾讯该接口实测 60 个仍正常；取 40 与其它批量接口保持一致） */
const QT_QUOTE_CHUNK = 40;

/** 腾讯行情时间戳 'YYYYMMDDHHMMSS' → { ymd:'YYYY-MM-DD', hms:'HH:MM:SS' }（非法 ⇒ 空串） */
export function qtParseStamp(raw) {
    const s = String(raw || '').trim();
    if (!/^\d{14}$/.test(s)) return { ymd: '', hms: '' };
    return {
        ymd: s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8),
        hms: s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14)
    };
}

/** 百分比两位小数（与库内 change_pct / auc_pct_chg 同精度） */
function _round2(x) {
    return Math.round(x * 100) / 100;
}

/**
 * 【纯函数】竞价涨幅 = 今开 / 昨收 - 1（A 股开盘价 = 9:25 集合竞价成交价，已实测与同花顺
 * auction_pct 逐位一致）。今开还没定（集合竞价未结束，腾讯给 0）⇒ null（§10 不猜）。
 */
export function qtAucPctOf(q) {
    if (!q) return null;
    const open = Number(q.open);
    const prev = Number(q.prevClose);
    if (!isFinite(open) || !isFinite(prev) || open <= 0 || prev <= 0) return null;
    return _round2((open / prev - 1) * 100);
}

/** 【纯函数】当前涨幅 = 现价 / 昨收 - 1。现价/昨收不可用 ⇒ null（§10 不猜）。 */
export function qtChangePctOf(q) {
    if (!q) return null;
    const price = Number(q.price);
    const prev = Number(q.prevClose);
    if (!isFinite(price) || !isFinite(prev) || price <= 0 || prev <= 0) return null;
    return _round2((price / prev - 1) * 100);
}

/**
 * 拉一批股票的腾讯实时行情。
 *
 * @param {string[]} codes6 6 位数字代码（'002242'）
 * @param {object} [opts] { timeoutMs=6000 }
 * @returns {Promise<Map<string, {ymd:string, hms:string, price:number|null,
 *                                prevClose:number|null, open:number|null, volHand:number|null}>>}
 *          code6 -> 行情。取不到 / 失败的票【不在 Map 里】（⛔ 不用空对象冒充「没有行情」）。
 */
export async function fetchQtRealtimeQuotes(codes6, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 6000;
    const list = (codes6 || []).map(function (c) { return String(c || '').trim(); })
        .filter(function (c) { return /^\d{6}$/.test(c); });
    const out = new Map();
    if (list.length === 0) return out;

    const uniq = Array.from(new Set(list));
    for (let i = 0; i < uniq.length; i += QT_QUOTE_CHUNK) {
        const chunk = uniq.slice(i, i + QT_QUOTE_CHUNK);
        const syms = chunk.map(qtSymOf).filter(Boolean);
        if (syms.length === 0) continue;
        try {
            const url = QT_QUOTE_BASE + syms.join(',');
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
            let text = '';
            try {
                const resp = await fetch(url, {
                    // ⛔ 与 qt-kline.js 同款请求头（该接口对裸 fetch 偶发拒绝）
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
                    signal: ctrl ? ctrl.signal : undefined
                });
                if (!resp.ok) throw new Error('qt-quote HTTP ' + resp.status);
                text = await resp.text();
            } finally {
                if (timer) clearTimeout(timer);
            }
            // 解析：v_<sym>="f0~f1~..."。GBK 名称会让 [1] 变乱码，但数值字段全是 ASCII ⇒ 不受影响
            // （⛔ 刻意不解析名称，见文件头「拿不到什么」）。
            const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                const f = m[2].split('~');
                const code = m[1].slice(2);
                if (f.length < 33) continue;
                const stamp = qtParseStamp(f[30]);
                const price = Number(f[3]);
                const prevClose = Number(f[4]);
                const open = Number(f[5]);
                const volHand = Number(f[6]);
                out.set(code, {
                    ymd: stamp.ymd,
                    hms: stamp.hms,
                    price: (isFinite(price) && price > 0) ? price : null,
                    prevClose: (isFinite(prevClose) && prevClose > 0) ? prevClose : null,
                    open: (isFinite(open) && open > 0) ? open : null,
                    volHand: (isFinite(volHand) && volHand >= 0) ? volHand : null
                });
            }
        } catch (e) {
            // 单批失败不连坐其余批（调用方对缺席票补 null，§10 不猜）
            _dbgLog('[QT-QUOTE] 拉取失败(' + chunk.length + ' 只): ' + ((e && e.message) || e));
        }
    }
    return out;
}
