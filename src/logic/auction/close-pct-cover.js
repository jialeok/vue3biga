// close-pct-cover.js — 【收盘涨幅自动覆盖】Logic 层闭环（§2：UI → Logic → Data → Supabase）
//
// 需求口径（用户）：
//   早盘 9:25 抓到的是【竞价涨幅】；收盘后必须自动抓取【收盘涨幅】覆盖掉它，
//   并且龙头（龙一/龙二…）排位要按收盘口径再算一次。
//
// 为什么以前不生效（2026-09-10 排查结论）：
//   1) worker（bidding-auto-fetch）只在 morning 写 market_metrics，且当天 change_pct 与
//      auc_pct_chg 写的是【同一个竞价值】（见 morning-workflow.js），它自己也声明
//      「后续 step5 会用收盘涨幅覆盖」—— 但 step5 只处理历史日期，当天永远不被覆盖；
//   2) 唯一负责收盘覆盖的 pg_cron（db/supabase_auction_close_cron.sql，16:00 调
//      bidding-a?point=auction-close）在库里**从来没有执行记录**（bidding_fetch_log 查无
//      time_point='auction-close' 的行）→ 该链路等于空转。
//   结果：当天 change_pct 全天停留在 9:25 竞价涨幅 → 收盘后看到的还是竞价涨幅，
//   10 日涨幅的 T 腿也跟着错（回退到 change_pct 时读到的是竞价值）。
//
// 本模块把闭环收回前端 Logic 层：不依赖任何外部 cron，进入看板（或跨过 15:00 门槛）时
// 自愈一次，并让龙头排位重算。

import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { getAuctionData } from '../app-core-api.js';
import { state } from '../app-state.js';
import { _dbgLog } from '../../data/debug-log.js';
import { readMarketMetricsForDate, upsertMarketMetricsRows } from '../../data/market-metrics.js';
import { fetchNumcatDailyPctRange, fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { getDragonTargetRows } from './dragon-rank.js';

/** 北京时间 15:00 收盘（与 dragon-rank 的 CLOSE_COVER_HOUR 同口径，此处独立常量避免反向依赖） */
export const CLOSE_COVER_HOUR = 15;

// 本会话已成功覆盖过的日期（幂等：不重复烧猫抓额度）
const _coveredDates = new Set();
// 本会话已确认「取不到当日收盘涨幅」的日期（接口全挂时不再反复重试）
const _failedDates = new Set();
// 单飞：并发调用只发一次请求
let _inflight = null;

function _beijingHour() {
    return (new Date().getUTCHours() + 8) % 24;
}

/** 该日收盘覆盖时刻（北京 15:00）对应的 UTC 时间戳 */
function _closeCoverUtcMs(dateStr) {
    const base = Date.parse(dateStr + 'T00:00:00Z');
    return base + (CLOSE_COVER_HOUR - 8) * 3600000;
}

function _parsePct(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim().replace('%', '').replace('+', '');
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
}

function _fmtPct(n) {
    if (!isFinite(n)) return '';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** 是否处于「当天已收盘、需要覆盖」的时间窗口 */
export function isCloseCoverWindow(date) {
    if (!date) return false;
    if (date !== _getLocalTodayStr()) return false;
    if (!isTradingDay(date)) return false;
    return _beijingHour() >= CLOSE_COVER_HOUR;
}

/**
 * 判定某行是否需要覆盖：
 *   - 云端没有 change_pct → 需要；
 *   - change_pct 与 auc_pct_chg 数值完全相同 → 需要（9:25 worker 把竞价值复制进来的脏值）；
 *   - 云端 updated_at 早于当日 15:00 → 需要（早上写的，不是收盘值）。
 * @returns {boolean}
 */
function _needCover(cloudRow, aucPct) {
    if (!cloudRow) return true;
    const close = _parsePct(cloudRow.change_pct);
    if (close === null) return true;
    const auc = _parsePct(aucPct);
    if (auc !== null && Math.abs(close - auc) < 1e-9) return true;
    const t = cloudRow.updated_at ? Date.parse(cloudRow.updated_at) : NaN;
    if (!t || Number.isNaN(t)) return true;
    return t < _closeCoverUtcMs(cloudRow.date || '');
}

/**
 * 收盘涨幅自动覆盖（幂等 + 单飞）。
 *
 * @param {string} date - 看板日期（YYYY-MM-DD）；非「系统今天」或没到 15:00 会直接跳过
 * @param {{force?:boolean}} [opts] - force=true 忽略本会话幂等标记（后台按钮/手动刷新用）
 * @returns {Promise<{ok:boolean, skipped:boolean, reason?:string, updated?:number, total?:number, source?:string}>}
 */
export async function ensureClosePctCovered(date, opts) {
    const force = !!(opts && opts.force);
    if (!date) return { ok: false, skipped: true, reason: '缺少日期' };
    if (!isCloseCoverWindow(date)) {
        return { ok: false, skipped: true, reason: '未到收盘覆盖时间（仅当天 15:00 后执行）' };
    }
    if (!force) {
        if (_coveredDates.has(date)) return { ok: true, skipped: true, reason: '本会话已覆盖' };
        if (_failedDates.has(date)) return { ok: false, skipped: true, reason: '本会话已确认取不到收盘涨幅' };
    }
    if (_inflight && _inflight.date === date) return _inflight.promise;

    const p = _runCover(date, force);
    _inflight = { date: date, promise: p };
    try {
        return await p;
    } finally {
        if (_inflight && _inflight.promise === p) _inflight = null;
    }
}

async function _runCover(date, force) {
    if (force) _failedDates.delete(date);

    // 1) 名单：与 10 日涨幅同一口径（正式成员 ∪ 观察组继承），否则带 * 的票收盘后不更新
    let rows = [];
    try {
        rows = getDragonTargetRows(date) || [];
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 名单读取失败：' + (e && e.message || e));
        return { ok: false, skipped: false, reason: '名单读取失败：' + (e && e.message || e) };
    }
    if (rows.length === 0) return { ok: false, skipped: true, reason: '当日名单为空' };

    // 2) 补代码（缺码票永远取不到行情，与抓取类功能同款前置动作）
    try {
        await ensureAuctionCodeMapping(rows);
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 补码失败（非致命）：' + (e && e.message || e));
    }
    const scMap = (state && state._scMapCache) || {};

    // 3) 读云端现状，筛出真正需要覆盖的行（避免无谓消耗额度）
    let cloudByName = new Map();
    try {
        const cloud = await readMarketMetricsForDate(date, 'auction');
        cloud.forEach(function(r) {
            const n = String(r.stock || '').trim();
            if (n && !cloudByName.has(n)) cloudByName.set(n, r);
        });
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 读取 market_metrics 失败：' + (e && e.message || e));
        return { ok: false, skipped: false, reason: '读取指标表失败：' + (e && e.message || e) };
    }

    const ymd = date.replace(/-/g, '');
    const targets = [];
    rows.forEach(function(r) {
        const name = String((r && r.stock) || '').trim();
        if (!name) return;
        const code = String((r && (r.code || scMap[name])) || '').trim();
        if (!code) return; // 真的缺码 → 跳过，不伪造
        if (!force && !_needCover(cloudByName.get(name), (r.auc_pct_chg || r.aucPctChg))) return;
        targets.push({ name: name, code: code, row: r });
    });
    if (targets.length === 0) {
        _coveredDates.add(date);
        return { ok: true, skipped: true, reason: '全部行已是收盘口径' };
    }

    // 4) 取当日收盘涨幅：主通道猫抓 daily（1 次请求覆盖全市场）；用尽/失败 → 同花顺 K 线兜底
    const pctByName = new Map();
    let source = '';
    const codeSet = new Set();
    targets.forEach(function(t) { codeSet.add(t.code); });
    try {
        const byCode = await fetchNumcatDailyPctRange(Array.from(codeSet).join(','), ymd, ymd);
        if (byCode && byCode.size > 0) {
            targets.forEach(function(t) {
                const dm = byCode.get(t.code);
                if (dm && dm.has(ymd)) pctByName.set(t.name, dm.get(ymd));
            });
            if (pctByName.size > 0) source = 'numcat-daily';
        }
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 猫抓 daily 不可用：' + (e && e.message || e));
    }
    if (pctByName.size === 0) {
        try {
            const byName = await fetchFuyaoDailyPctRange(
                targets.map(function(t) { return { stock: t.name, code: t.code }; }),
                [date],
                { concurrency: 4 }
            );
            if (byName && byName.size > 0) {
                byName.forEach(function(dm, name) {
                    if (dm && dm.has(ymd)) pctByName.set(name, dm.get(ymd));
                });
                if (pctByName.size > 0) source = 'ths-kline';
            }
        } catch (e) {
            _dbgLog('[CLOSE-COVER] 同花顺兜底失败：' + (e && e.message || e));
        }
    }
    if (pctByName.size === 0) {
        _failedDates.add(date);
        return { ok: false, skipped: false, reason: '当日收盘涨幅取不到（猫抓与同花顺双通道均失败）' };
    }

    // 5) 写入云端（只带 change_pct + updated_*，upsert 不会抹掉 volume/auc_pct_chg 等竞价字段）
    const nowIso = new Date().toISOString();
    const payload = [];
    pctByName.forEach(function(pct, name) {
        const t = targets.find(function(x) { return x.name === name; });
        if (!t) return;
        payload.push({
            date: date,
            stock: name,
            code: t.code,
            scope: 'auction',
            change_pct: _fmtPct(pct),
            updated_at: nowIso,
            updated_by: 'main-close-cover'
        });
    });
    if (payload.length === 0) {
        _failedDates.add(date);
        return { ok: false, skipped: false, reason: '无可写入的收盘涨幅' };
    }
    try {
        await upsertMarketMetricsRows(payload);
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 写入 market_metrics 失败：' + (e && e.message || e));
        return { ok: false, skipped: false, reason: '写入指标表失败：' + (e && e.message || e) };
    }

    // 6) 同步内存行（界面「涨幅」列与趋势图直接读内存行，不回写会出现「云端已更新/界面没变」）
    try {
        const g = getAuctionData();
        const list = (g && g[date]) || [];
        const byName = new Map();
        list.forEach(function(r) {
            if (!r || !r.stock) return;
            const n = String(r.stock).trim();
            if (n && !byName.has(n)) byName.set(n, r);
        });
        pctByName.forEach(function(pct, name) {
            const row = byName.get(name);
            if (row) row.changePct = _fmtPct(pct);
        });
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 同步内存行失败（非致命）：' + (e && e.message || e));
    }

    _coveredDates.add(date);
    _dbgLog('[CLOSE-COVER] ' + date + ' 收盘涨幅覆盖 ' + payload.length + '/' + targets.length + ' 只（来源=' + source + '）');
    return { ok: true, skipped: false, updated: payload.length, total: targets.length, source: source };
}

/** 供后台按钮/手动触发：清掉本会话幂等标记后重跑一次 */
export function resetClosePctCover(date) {
    if (date) {
        _coveredDates.delete(date);
        _failedDates.delete(date);
    } else {
        _coveredDates.clear();
        _failedDates.clear();
    }
}
