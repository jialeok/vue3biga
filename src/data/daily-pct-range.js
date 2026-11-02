// daily-pct-range.js — 「K 线区间日涨幅」统一读取器（Data 层，§5/§6 单一入口）
//
// ════════════════════════════════════════════════════════════════════════════════════════
// 【为什么需要它 / 2026-11-02 用户报障「9:26 题材量比不出票，交易被迫终止」】
//
//   FUYAO-OFF 总闸（data/api/fuyao-proxy.js 的 FUYAO_OFF=true）把 `fetchFuyaoDailyPctRange`
//   变成了「入口即 throw」。全仓有 7 个调用点拿它当唯一的 K 线腿：
//     range20.js（20日涨幅 toggle 阶段②）、range20-leaders.js（前五精算）、
//     useTopicVolRatioBoard.js（分歧预热 + 总龙分歧判定）、dragon-rank.js（十日涨幅龙位兜底）、
//     range-fill.js / close-pct-cover.js / ths-today-patch.js（补缺/收盘覆盖/今日补丁）。
//   上一轮只给 trend-patch.js 单独加了腾讯腿 ⇒ 其余 7 处全部断源 ⇒ 9:26–9:43（云端 cron
//   自愈之前）整条 20日涨幅/总龙/分歧链在前端无 K 线可用，题材量比看板「计算中」挂死。
//
// 【本文件的职责】
//   把「K 线腿选谁」收敛到一个入口（§6 单一真相）：
//     · 同花顺通道可用（!isFuyaoOff）⇒ 透传 `fetchFuyaoDailyPctRange`（既有行为逐字不变，§11）；
//     · 同花顺通道停用（FUYAO-OFF）  ⇒ 腾讯 qfq 日线直连（api/qt-kline.js，与 stock_daily_pct
//       同源——db 回填脚本实测两源 524 条真值 ±0.02 内 100% 一致），不经 fuyao-proxy
//       ⇒ 不受总闸影响、0 同花顺配额、浏览器可直连（CORS *）。
//   两腿输出契约**完全同形**（调用方一行都不用改语义）：
//     主返回  Map<股票名, Map<YYYYMMDD, 收盘涨幅%>>（窗口内、wantSet 命中的日子）
//     openOut Map<股票名, Map<YYYYMMDD, 开盘涨幅%|null>>（竞价涨幅 = open/昨收-1；缺 open 补 null）
//     volOut  Map<股票名, Map<YYYYMMDD, 成交量（股）|null>>（腾讯给的是手 ⇒ ×100 转股，量纲对齐 fuyao）
//
// 【红线（与 stock-range-pct.js 同一条，§10）】
//   · 读取失败绝不返回「看似合法的空」去冒充没数据——单票失败该票不进 Map（调用方按
//     「取不到 = 补 null」处理），⛔ 不伪装、⛔ 不补 0、⛔ 不 throw 中断整批；
//   · 起点前移 20 个自然日（窗口首日涨幅需要「上一个交易日收盘价」做基准，覆盖长假）；
//   · 北交所 (4/8/92 开头) 腾讯可能无 bar ⇒ 该票不进 Map，与同花顺腿行为一致；
//   · 当天的竞价量/量比任何 K 线源都给不了（§10 不拿全天量冒充竞价量）——那由云端
//     R20-METRICS 写 market_metrics，与本文件无关。
// ════════════════════════════════════════════════════════════════════════════════════════

import { isFuyaoOff } from './api/fuyao-proxy.js';
import { fetchQtDailyBars } from './api/qt-kline.js';
import { fetchFuyaoDailyPctRange } from './stock-range-pct.js';
import { _dbgLog } from './debug-log.js';

const DAY_MS = 86400000;

/** 腾讯腿：按 fetchFuyaoDailyPctRange 的契约输出（见文件头）。 */
async function _fetchQtDailyPctRange(items, dates, opts) {
    const list = (items || []).filter(function (it) { return it && it.stock && it.code; });
    const ymdList = (dates || []).map(function (d) { return String(d).replace(/-/g, ''); }).filter(Boolean);
    const out = new Map();
    if (list.length === 0 || ymdList.length === 0) return out;

    const sorted = ymdList.slice().sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const wantSet = new Set(ymdList);
    // 起点前移 20 个自然日（与同花顺腿同一条规则，⛔ 别"顺手"改小——长假会吃掉基准收盘价）
    const startMs = Date.parse(first.slice(0, 4) + '-' + first.slice(4, 6) + '-' + first.slice(6, 8) + 'T00:00:00+08:00') - 20 * DAY_MS;
    const endMs = Date.parse(last.slice(0, 4) + '-' + last.slice(4, 6) + '-' + last.slice(6, 8) + 'T00:00:00+08:00') + 2 * DAY_MS;
    const fromYmd = new Date(startMs).toISOString().slice(0, 10);
    const toYmd = new Date(endMs).toISOString().slice(0, 10);

    // 可选出口（缺省 undefined ⇒ 与同花顺腿同语义，§11）
    const openOut = (opts && opts.openOut instanceof Map) ? opts.openOut : null;
    const volOut = (opts && opts.volOut instanceof Map) ? opts.volOut : null;
    const retryShortWindow = !!(opts && opts.retryShortWindow);
    const minCoverage = (opts && opts.minCoverage) || 0;
    const needN = (minCoverage > 0) ? Math.min(minCoverage, wantSet.size) : wantSet.size;
    const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
    const onBatch = (opts && typeof opts.onBatch === 'function') ? opts.onBatch : null;
    const timeoutMs = (opts && opts.requestTimeoutMs) || 8000;

    /**
     * 把一只票的日线序列换算成三份 Map（纯函数段，与同花顺腿 fetchOnce 的换算逐条同义）。
     * @returns {{keep:Map, openKeep:Map|null, volKeep:Map|null, firstYmd:string, wantCover:number}}
     */
    function _convert(name, bars) {
        const series = [];
        (bars || []).forEach(function (b) {
            if (!b || !b.ymd || !isFinite(b.close) || b.close <= 0) return;
            series.push({
                ymd: String(b.ymd).replace(/-/g, ''),
                close: Number(b.close),
                open: (b.open != null && isFinite(Number(b.open)) && Number(b.open) > 0) ? Number(b.open) : null,
                // 腾讯 volume 单位 = 手；fuyao 契约 = 股 ⇒ ×100（量纲对齐，见文件头）
                vol: (b.volHand != null && isFinite(Number(b.volHand))) ? Number(b.volHand) * 100 : null
            });
        });
        series.sort(function (a, b) { return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0); });
        const keep = new Map();
        const openKeep = openOut ? new Map() : null;
        const volKeep = volOut ? new Map() : null;
        if (volKeep) {
            for (let k = 0; k < series.length; k++) volKeep.set(series[k].ymd, series[k].vol);
        }
        for (let k = 1; k < series.length; k++) {
            const prev = series[k - 1];
            const cur = series[k];
            if (!wantSet.has(cur.ymd)) continue;
            keep.set(cur.ymd, (cur.close / prev.close - 1) * 100);
            if (openKeep) {
                openKeep.set(cur.ymd, (cur.open != null && prev.close > 0)
                    ? (cur.open / prev.close - 1) * 100 : null);
            }
        }
        return {
            keep: keep, openKeep: openKeep, volKeep: volKeep,
            firstYmd: series.length > 0 ? series[0].ymd : '',
            wantCover: keep.size
        };
    }

    /** 发一轮请求并交付（含可选出口 / 进度 / 诊断），返回「没凑满窗口」的票清单。 */
    async function _round(codes, tag, doneOffset) {
        let barsByCode = null;
        try {
            // ⛔ fetchQtDailyBars 收【字符串数组】（6 位代码），不是 {stock,code} 对象——
            //   [FIX 2026-11-02] 首版误传对象数组 ⇒ qtSymOf('[object Object]') 恒空 ⇒
            //   全部 continue、0 请求、空 Map，K 线腿集体哑火（11-02 现场 45 天窗口 0/1 实证）。
            barsByCode = await fetchQtDailyBars(
                codes.map(function (c) { return String(c.code || '').trim(); }).filter(Boolean),
                fromYmd, toYmd, { timeoutMs: timeoutMs });
        } catch (e) {
            // fetchQtDailyBars 本身按票兜底不抛；这里兜整体意外（§10：本轮全按取不到处理，不伪装成功）
            _dbgLog('[QT-RANGE] ' + tag + ' 轮批量拉取整体失败: ' + ((e && e.message) || e));
            barsByCode = new Map();
        }
        const short = [];
        let done = 0;
        for (let i = 0; i < codes.length; i++) {
            const it = codes[i];
            const name = String(it.stock).trim();
            const got = _convert(name, barsByCode.get(String(it.code).trim()) || null);
            if (got.keep.size > 0) out.set(name, got.keep);
            // 与同花顺腿 TREND-PATCH-FIX 同语义：可选出口不绑定 keep.size>0（趋势图要「昨天 bar」）
            if (openOut && got.openKeep) openOut.set(name, got.openKeep);
            if (volOut && got.volKeep) volOut.set(name, got.volKeep);
            done++;
            if (onProgress) { try { onProgress(doneOffset + done, list.length); } catch (e) { /* 回调失败不影响取数 */ } }
            // 次新 / 长期停牌本来就不满窗 ⇒ 不算 short（与同花顺腿 listingShort 同判据）
            const listingShort = !!(got.firstYmd && got.firstYmd >= sorted[0]);
            if (got.wantCover < needN && !listingShort && retryShortWindow) short.push(it);
        }
        _dbgLog('[QT-RANGE] ' + tag + ' 轮：请求 ' + codes.length + ' 只，凑满窗口 '
            + (codes.length - short.length) + '/' + codes.length + '（need=' + needN + '）'
            + ' bars=' + barsByCode.size);
        return short;
    }

    // 第 1 轮全量；retryShortWindow=true（满窗调用方，如 range20）时对没凑满的票再追 2 轮。
    //   ⛔ 腾讯偶发限流同样会回短序列——不重试就会像同花顺那次一样各票天数不齐 ⇒ 区间涨幅不可比。
    let pending = list.slice();
    let processed = 0;
    let attempt = 0;
    const MAX_ATTEMPTS = retryShortWindow ? 3 : 1;
    while (pending.length > 0 && attempt < MAX_ATTEMPTS) {
        attempt++;
        if (attempt > 1) {
            await new Promise(function (r) { setTimeout(r, 300 * attempt); });   // 与同花顺腿同款退避
        }
        const short = await _round(pending, attempt === 1 ? 'first' : 'retry', processed);
        processed += pending.length;
        pending = short;
        // 与同花顺腿同语义：每轮结束回调一次累计结果（同一个 Map 引用，调用方自行拷贝）
        if (onBatch) { try { onBatch(out, processed, list.length); } catch (e) { /* 忽略 */ } }
    }
    return out;
}

/**
 * 「K 线区间日涨幅」统一入口（全仓唯一调用点，§6）。
 *
 * @param {Array<{stock:string, code:string}>} items 股票名 + 6 位代码
 * @param {string[]} dates 需要的交易日（YYYY-MM-DD，顺序任意）
 * @param {{concurrency?:number, onProgress?:(done:number,total:number)=>void,
 *          onBatch?:(acc:Map, done:number, total:number)=>void,
 *          retryShortWindow?:boolean, requestTimeoutMs?:number, minCoverage?:number,
 *          openOut?:Map, volOut?:Map}} [opts]
 *        与 fetchFuyaoDailyPctRange 的 opts 完全同形（两腿共用同一套语义）。
 * @returns {Promise<Map<string, Map<string, number>>>} 股票名 -> (YYYYMMDD -> 收盘涨幅%)
 */
export async function fetchDailyPctRange(items, dates, opts) {
    if (!isFuyaoOff()) {
        // 同花顺通道可用 ⇒ 既有行为逐字不变（§11）
        return fetchFuyaoDailyPctRange(items, dates, opts);
    }
    return _fetchQtDailyPctRange(items, dates, opts);
}
