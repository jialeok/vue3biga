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
import { fuyaoApiGet, tickerToThscode } from './fuyao-proxy.js';

// ════════════════════════════════════════════════════════════════════════════════════════
// 【2026-11-18 线上事故：`web.ifzq.gtimg.cn` 开始整站返回 WAF 挑战页】
//   现象：早盘竞价看板「30日涨幅」toggle 打开后行上一直空白、也不按涨幅排序
//        （排序键就是这列数值，取不到 ⇒ 全部 null ⇒ 保持原序，看起来「toggle 没反应」）。
//   实测（同一台机器、同一天）：
//     · `web.ifzq.gtimg.cn/appstock/app/fqkline/get?...` ⇒ **HTTP 501** + 326 字节 HTML
//       `<script>var i=location.href;var v=window.btoa?...`（腾讯 WAF 的 JS 挑战页），
//       带 UA / Referer / Origin / Accept 任何组合都一样（⛔ 不是我们请求头写错）；
//     · 同路径换成 `ifzq.gtimg.cn`（去掉 `web.`）⇒ **HTTP 200 + JSON**，
//       响应头 `access-control-allow-origin: *`（浏览器可直连），32 只批量实测 **32/32、0.7 秒**。
//   ⇒ 本模块改成【多 host 失败切换】：默认先打 `ifzq.gtimg.cn`，不行自动换另一个，并锁定本次可用那个。
//     ⚠️ 挑战页是 HTML ⇒ 必须按「content-type / 首字符」判 JSON，⛔ 不能只看 `resp.ok`
//        （501 会被 `ok` 挡住，但 WAF 也可能 200 返回挑战页 —— 两条都要判）。
//     这条修复对下游三条链同时生效（30日涨幅 / 趋势图补点 / 逐日腿补缺），因为它们共用本模块。
// ════════════════════════════════════════════════════════════════════════════════════════

const QT_PATH = '/appstock/app/fqkline/get';

/**
 * 可用 host 列表（按优先级）。
 * ⚠️ 顺序有意义：`ifzq.gtimg.cn` 是 2026-11-18 实测**唯一**还回 JSON 的那个，
 *     `web.ifzq.gtimg.cn` 保留作兜底（万一哪天反过来）。
 */
const QT_HOSTS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];

// ════════════════════════════════════════════════════════════════════════════════════════
// 【2026-11-19 线上事故：腾讯两个 host 同日先后被 WAF 拦住 ⇒ 第三腿东财兜底】
//   真实浏览器取证（11:15~11:20，CDP）：
//     · `ifzq.gtimg.cn` 从「200 JSON」翻成 **501 + WAF 挑战页**（和 11-18 的 `web.` 一样）；
//     · `web.ifzq.gtimg.cn` TLS 握手失败（net::ERR_FAILED）；
//     · 两条腿全挂 ⇒ `[QT-KLINE] xxx 拉取失败: Failed to fetch` × 31 票 ⇒ 昨量列整列 '-'，
//       补数按钮点完还回报「库内字段已完整」（上游失败被误判为没缺口，见 ths-today-patch.js）。
//   东财 push2his qfq 日线（实测 2026-11-19 浏览器直连可用，CORS 放行）：
//     `https://48.push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.002748&...&klt=101&fqt=1`
//     世龙实业 11-18 volume=246258 手，与腾讯 qfq 同日值逐字一致 ⇒ 口径可信（同一前复权量纲）。
//   ⚠️ 只在腾讯两 host 都失败后才走它；⛔ 不换字段语义（仍输出 万股 / 前复权 / 日线）。
// ════════════════════════════════════════════════════════════════════════════════════════
const EM_HOSTS = ['https://48.push2his.eastmoney.com', 'https://push2his.eastmoney.com'];
const EM_PATH = '/api/qt/stock/kline/get';
const EM_FIELDS1 = 'f1,f2,f3,f4,f5';
const EM_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57';

/** 6 位代码 → 东财 secid（沪市 1.，深/北 0.；⛔ 与腾讯 sh/sz 前缀是两套口径，别混用） */
export function emSecidOf(code) {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c)) return '';
    return (/^(6|9)/.test(c) ? '1.' : '0.') + c;
}

/** 东财 qfq 日线兜底；失败抛错（由调用方按「取不到」处理，§10 不伪造空数组） */
async function _fetchEmDailyBars(code6, fromYmd, toYmd, timeoutMs) {
    const secid = emSecidOf(code6);
    if (!secid) throw new Error('EM secid 解析失败: ' + code6);
    const qs = 'secid=' + secid
        + '&fields1=' + EM_FIELDS1 + '&fields2=' + EM_FIELDS2
        + '&klt=101&fqt=1'
        + '&beg=' + String(fromYmd).replace(/-/g, '')
        + '&end=' + String(toYmd).replace(/-/g, '');
    let lastErr = null;
    for (let h = 0; h < EM_HOSTS.length; h++) {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
        try {
            const resp = await fetch(EM_HOSTS[h] + EM_PATH + '?' + qs, {
                cache: 'no-store',
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!resp.ok) throw new Error('EM HTTP ' + resp.status);
            const text = await resp.text();
            const ctype = String((resp.headers && resp.headers.get && resp.headers.get('content-type')) || '');
            if (ctype.indexOf('html') !== -1 || text.charAt(0) !== '{') throw new Error('EM 非 JSON 响应');
            const j = JSON.parse(text);
            const lines = (j && j.data && j.data.klines) || [];
            const bars = [];
            for (let i = 0; i < lines.length; i++) {
                const a = String(lines[i]).split(',');
                const close = Number(a[2]);
                if (!a[0] || !isFinite(close) || close <= 0) continue;
                const openRaw = Number(a[1]);
                const volRaw = Number(a[5]);
                bars.push({
                    ymd: String(a[0]).slice(0, 10),
                    open: (isFinite(openRaw) && openRaw > 0) ? openRaw : null,
                    close: close,
                    volHand: (isFinite(volRaw) && volRaw >= 0) ? volRaw : null
                });
            }
            if (bars.length === 0) throw new Error('EM 返回空 K 线');
            return bars;
        } catch (e) {
            lastErr = e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    throw lastErr || new Error('EM 全部 host 均不可用');
}

/** 会话内优先使用的 host 下标（成功后锁定，失败的 host 不再每次先撞一遍） */
let _hostIdx = 0;

/**
 * 拉一次 JSON：按 host 列表依次尝试，任一成功即锁定该 host。
 *
 * @param {string} qs 查询串（如 `param=sh600519,day,2026-09-01,2026-11-18,320,qfq`）
 * @param {number} timeoutMs 单次超时
 * @returns {Promise<object>} 解析后的 JSON（失败抛最后一个错误，由调用方按「取不到」处理）
 */
async function _fetchQtJson(qs, timeoutMs) {
    let lastErr = null;
    for (let k = 0; k < QT_HOSTS.length; k++) {
        const idx = (_hostIdx + k) % QT_HOSTS.length;
        const url = QT_HOSTS[idx] + QT_PATH + '?' + qs;
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
        let resp;
        try {
            resp = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
                signal: ctrl ? ctrl.signal : undefined
            });
        } catch (e) {
            lastErr = e;
            continue;
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (!resp.ok) {
            lastErr = new Error('qt HTTP ' + resp.status);
            continue;
        }
        let text;
        try {
            text = await resp.text();
        } catch (e) {
            lastErr = e;
            continue;
        }
        const ctype = String((resp.headers && resp.headers.get && resp.headers.get('content-type')) || '');
        // ★ WAF 挑战页：HTML（含 `200 text/html` 的软拦截）⇒ 换 host，⛔ 别当数据解析
        if (ctype.indexOf('html') !== -1 || text.charAt(0) !== '{') {
            lastErr = new Error('qt 非 JSON 响应（疑似 WAF 挑战页，host=' + QT_HOSTS[idx] + '）');
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            lastErr = new Error('qt JSON 解析失败');
            continue;
        }
        _hostIdx = idx;                 // 锁定可用 host
        return parsed;
    }
    throw lastErr || new Error('qt 全部 host 均不可用');
}

/**
 * 第三腿：同花顺前复权日线（Data 层唯一入口 fuyao-proxy 的受控放行）。
 * ⛔ 只在腾讯 WAF + 东财限流两条都失败后才用；⛔ 必须带 allowWhenOff + timeoutMs。
 */
async function _fetchFuyaoDailyBars(code6, fromYmd, toYmd, timeoutMs) {
    const thscode = tickerToThscode(code6);
    if (!thscode) throw new Error('同花顺 thscode 解析失败: ' + code6);
    const data = await fuyaoApiGet('/api/a-share/prices/historical', {
        thscode: thscode,
        interval: '1d',
        start: Date.parse(String(fromYmd) + 'T00:00:00+08:00'),
        end: Date.parse(String(toYmd) + 'T00:00:00+08:00'),
        adjust: 'forward'
    }, { allowWhenOff: true, timeoutMs: timeoutMs || 12000 });
    const rows = (data && data.item) || [];
    const bars = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.date_ms == null || r.close_price == null) continue;
        const close = Number(r.close_price);
        if (!isFinite(close) || close <= 0) continue;
        const openRaw = Number(r.open_price);
        const volRaw = Number(r.volume);   // 同花顺给【股】，换成手与腾讯/东财同形
        bars.push({
            ymd: new Date(Number(r.date_ms) + 8 * 3600 * 1000).toISOString().slice(0, 10),
            open: (isFinite(openRaw) && openRaw > 0) ? openRaw : null,
            close: close,
            volHand: (isFinite(volRaw) && volRaw >= 0) ? volRaw / 100 : null
        });
    }
    if (bars.length === 0) throw new Error('同花顺返回空 K 线');
    return bars;
}

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
export async function fetchQtDailyBars(codes6, fromYmd, toYmd, opts) {    const o = opts || {};
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
                // ★ 2026-11-18：host 由 `_fetchQtJson` 统一做失败切换（见文件头注释），本处只拼查询串。
                const j = await _fetchQtJson('param=' + sym + ',day,' + fromYmd + ',' + toYmd + ',320,qfq', timeoutMs);
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
            } catch (qtErr) {
                // ★ [EM-FALLBACK 2026-11-19] 腾讯两 host 同时不可用 ⇒ 切东财 qfq 日线。
                //   两腿输出同形（ymd/open/close/volHand），调用方零改动；⛔ 空结果不伪造。
                try {
                    const bars = await _fetchEmDailyBars(code, fromYmd, toYmd, timeoutMs);
                    if (bars.length > 0) {
                        out.set(code, bars);
                        _dbgLog('[QT-KLINE] ' + code + ' 腾讯不可用，已切东财 qfq 日线（' + bars.length + ' 根）');
                    }
                } catch (emErr) {
                    // ★ [FUYAO-KLINE 2026-11-19] 最后一腿：同花顺历史 K 线（受控放行，0 猫抓额度）。
                    //   11-19 实测东财 burst 后 11 只票连备用 host 也全挂，而同花顺仍 200/15 根。
                    try {
                        const bars = await _fetchFuyaoDailyBars(code, fromYmd, toYmd, timeoutMs);
                        if (bars.length > 0) {
                            out.set(code, bars);
                            _dbgLog('[QT-KLINE] ' + code + ' 腾讯/东财均不可用，已切同花顺前复权日线（' + bars.length + ' 根）');
                        }
                    } catch (fyErr) {
                        // §10：三腿都失败必须留痕，且该票不进 Map（调用方显示 '--'，不补 0）
                        _dbgLog('[QT-KLINE] ' + code + ' 拉取失败: 腾讯=' + ((qtErr && qtErr.message) || qtErr)
                            + ' 东财=' + ((emErr && emErr.message) || emErr)
                            + ' 同花顺=' + ((fyErr && fyErr.message) || fyErr));
                    }
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return out;
}

// ────────────────────────────────────────────────────────────────────────────────
// 【指数日线】2026-11-14 新增：官方「收盘价格涨跌幅偏离值」要用【对应指数】的同期涨幅。
//
// ⛔ 为什么不能复用上面的 fetchQtDailyBars：
//   它按「6 位数字代码」拼 `sz000002`。而官方对应指数写的是 `sh000002`（上证A股指数）——
//   同样是 6 位数字，但前两位就成了「000002 = 万科A（深市）」⇒ 拿地产股当指数扣，
//   偏离值全错而且**零报错**。这是本项目血泪教训里最典型的「契约形态」坑。
//   ⇒ 指数必须【带市场前缀原样传】，单独一条通道。
//
// 指数不像个股：没有前复权（不需要）、不停牌 ⇒ 只用 `day` 段，缺失即上游问题。
// ────────────────────────────────────────────────────────────────────────────────

/** 指数代码规范化：'sh000002' / 'SZ399107' → 小写带前缀；非法 ⇒ ''（⛔ 不猜市场） */
export function qtIndexSymOf(indexCode) {
    const c = String(indexCode || '').trim().toLowerCase();
    return /^(sh|sz|bj)\d{6}$/.test(c) ? c : '';
}

/**
 * 拉一批【指数】的日线收盘序列。
 *
 * @param {string[]} indexCodes 带前缀代码 ['sh000002','sz399107']
 * @param {string} fromYmd 'YYYY-MM-DD'
 * @param {string} toYmd 'YYYY-MM-DD'
 * @param {object} [opts] { timeoutMs=8000, concurrency=4 }
 * @returns {Promise<Map<string, Array<{date:string, close:number}>>>}
 *          取不到 / 失败的指数【不在 Map 里】（⛔ 不用空数组冒充「没有数据」）
 */
export async function fetchQtIndexBars(indexCodes, fromYmd, toYmd, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 8000;
    const conc = o.concurrency || 4;
    const list = (indexCodes || []).map(qtIndexSymOf).filter(Boolean);
    const out = new Map();
    if (list.length === 0 || !fromYmd || !toYmd) return out;

    let cursor = 0;
    const worker = async function () {
        for (;;) {
            const i = cursor++;
            if (i >= list.length) return;
            const sym = list[i];
            try {
                // 与个股同一形态 `...,320,qfq`：2026-11-14 实测指数也认这个形态（返回 day 段）。
                // ⛔ 别改成 `,320,` 或省略末位 —— 未验证的形态一律不用。
                // host 走同一个失败切换（`_fetchQtJson`），2026-11-18 起 `web.` 子域已不可用。
                const j = await _fetchQtJson('param=' + sym + ',day,' + fromYmd + ',' + toYmd + ',320,qfq', timeoutMs);
                const d = (j && j.data && j.data[sym]) || {};
                const rows = d.qfqday || d.day || [];
                const bars = [];
                for (let k = 0; k < rows.length; k++) {
                    const b = rows[k];
                    if (!Array.isArray(b) || !b[0]) continue;
                    const close = Number(b[2]);
                    if (!isFinite(close) || close <= 0) continue;
                    bars.push({ date: String(b[0]).slice(0, 10), close: close });
                }
                if (bars.length > 0) out.set(sym, bars);
            } catch (e) {
                _dbgLog('[QT-INDEX] ' + sym + ' 拉取失败: ' + ((e && e.message) || e));
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return out;
}
