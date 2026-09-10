// close-pct-cover.js — 【收盘涨幅自动覆盖】Logic 层闭环（§2：UI → Logic → Data → Supabase）
//
// 需求口径（用户）：
//   早盘 9:25 抓到的是【竞价涨幅】；收盘后必须自动抓取【收盘涨幅】覆盖掉它，
//   并且龙头（龙一/龙二…）排位要按收盘口径再算一次。
//
// 两个职责：
//   ① 【今日】15:00 后把 market_metrics.change_pct 从 9:25 竞价涨幅覆盖为真实收盘涨幅；
//   ② 【任何日期】把 stock_range_pct 的「当天(T)腿」从竞价口径换成收盘口径。
//      —— 方案A 之后区间涨幅由 9:25 worker 算好落库（T 腿=竞价涨幅），收盘后只需替换 T 腿：
//         prevAcc = 已存区间涨幅 ÷(1+竞价腿)，新区间涨幅 = prevAcc ×(1+收盘腿)，**0 额外请求**。
//
// 为什么以前不生效（2026-09-10 排查结论）：
//   1) worker（bidding-auto-fetch）当天 change_pct 与 auc_pct_chg 写的是【同一个竞价值】；
//   2) 唯一负责收盘覆盖的 pg_cron（db/supabase_auction_close_cron.sql，16:00 调
//      bidding-a?point=auction-close）在库里**从来没有执行记录** → 该链路等于空转。
//   结果：当天 change_pct 全天停留在 9:25 竞价涨幅。本模块把闭环收回前端 Logic 层，
//   不依赖任何外部 cron，进入看板（或跨过 15:00 门槛 / 5 分钟轮询）时自愈一次。

import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { getAuctionData } from '../app-core-api.js';
import { state } from '../app-state.js';
import { _dbgLog } from '../../data/debug-log.js';
import { readMarketMetricsForDate, upsertMarketMetricsRows } from '../../data/market-metrics.js';
import { readRangePctForDate, upsertRangePctRows, fetchNumcatDailyPctRange, fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { getDragonTargetRows } from './dragon-rank.js';
// 区间涨幅 T 腿口径单一真相（纯函数）。⚠️ 漏了这个 import 会让 _syncRangeTDay 抛
// ReferenceError，而它被 try/catch 吞掉 → T 腿校正静默失效（2026-09-10 审查发现）。
import { replaceTDayLeg } from './range-window.js';

/** 北京时间 15:00 收盘（与 dragon-rank 的收盘门槛同口径，此处独立常量避免反向依赖） */
export const CLOSE_COVER_HOUR = 15;

/** 失败的日期在该时长内不再重试：15:00 后行情可能尚未结算，给数据源留出时间并限制请求量 */
const FAIL_RETRY_MS = 10 * 60 * 1000;

// 本会话已成功覆盖过的日期（幂等：不重复烧猫抓额度）
const _coveredDates = new Set();
// date -> 上次失败时刻（FAIL_RETRY_MS 内不再重试）
const _failedAt = new Map();
// 单飞：并发调用只发一次请求
let _inflight = null;

function _beijingHour() {
    return (new Date().getUTCHours() + 8) % 24;
}

/** 该日收盘覆盖时刻（北京 15:00）对应的 UTC 时间戳 */
function _closeCoverUtcMs(dateStr) {
    if (!dateStr) return NaN;
    const base = Date.parse(dateStr + 'T00:00:00Z');
    if (Number.isNaN(base)) return NaN;
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

/**
 * 是否需要执行收盘口径校正。
 *   · 今天（北京 15:00 后）：抓取真实收盘涨幅覆盖 change_pct + 替换区间涨幅 T 腿；
 *   · 历史日期：只做「区间涨幅 T 腿口径校正」（0 请求）——历史上「盘中打开过页面」的日期
 *     可能留在竞价腿口径，不校正会让这些日期的龙头排名系统性偏低。
 */
export function isCloseCoverWindow(date) {
    if (!date) return false;
    if (!isTradingDay(date)) return false;
    const today = _getLocalTodayStr();
    if (date > today) return false;
    if (date < today) return true;
    return _beijingHour() >= CLOSE_COVER_HOUR;
}

/**
 * 判定某行 market_metrics 是否需要覆盖。
 *   - 云端没有 change_pct → 需要；
 *   - 该行写于当日 15:00【之后】→ 已是收盘口径，不需要（时间判定优先）；
 *   - 否则：change_pct 与 auc_pct_chg 数值完全相同 → 需要（9:25 worker 把竞价值复制进来的脏值）。
 * @param {object} cloudRow
 * @param {*} aucPct 行内竞价涨幅（可能取不到）
 * @param {string} date 看板日期（⚠️ 必须显式传入：readMarketMetricsForDate 的 select 里没有 date 列）
 */
function _needCover(cloudRow, aucPct, date) {
    if (!cloudRow) return true;
    const close = _parsePct(cloudRow.change_pct);
    if (close === null) return true;
    const closeMs = _closeCoverUtcMs(date);
    const t = cloudRow.updated_at ? Date.parse(cloudRow.updated_at) : NaN;
    // 时间判定优先于「与竞价相同」判定：一字板 / 停牌股的收盘价确实等于 9:25 竞价价
    // （如 桂林旅游 +9.99%、瑞尔特 +10.01%），change_pct 与 auc_pct_chg 相同是【合法的】。
    // 只要该行是 15:00 之后写入的，就认定已是收盘口径，不再重复覆盖。
    if (!Number.isNaN(t) && !Number.isNaN(closeMs) && t >= closeMs) return false;
    if (Number.isNaN(t) || !t) return true;
    const auc = _parsePct(aucPct);
    if (auc !== null && Math.abs(close - auc) < 1e-9) return true;
    return !Number.isNaN(closeMs) && t < closeMs;
}

/**
 * 收盘口径校正（幂等 + 单飞）。
 *
 * @param {string} date - 看板日期（YYYY-MM-DD）
 * @param {{force?:boolean}} [opts] - force=true 忽略本会话幂等/冷却标记
 * @returns {Promise<{ok:boolean, skipped:boolean, reason?:string, updated?:number, total?:number,
 *                    rangeFixed?:number, source?:string}>}
 */
export async function ensureClosePctCovered(date, opts) {
    const force = !!(opts && opts.force);
    if (!date) return { ok: false, skipped: true, reason: '缺少日期' };
    if (!isCloseCoverWindow(date)) {
        return { ok: false, skipped: true, reason: '未到收盘覆盖时间（仅当天 15:00 后 / 历史日期）' };
    }
    if (!force) {
        if (_coveredDates.has(date)) return { ok: true, skipped: true, reason: '本会话已覆盖' };
        const failedAt = _failedAt.get(date);
        if (failedAt && Date.now() - failedAt < FAIL_RETRY_MS) {
            return { ok: false, skipped: true, reason: '本会话已确认取不到收盘涨幅（稍后自动重试）' };
        }
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
    if (force) _failedAt.delete(date);
    const isToday = date === _getLocalTodayStr();

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

    // 3) 读云端 market_metrics 现状（覆盖面 & T 腿校正都要用）
    const cloudByName = new Map();
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

    // 4) 【今日】抓取真实收盘涨幅并覆盖 change_pct（历史日期不抓取，只做第 5 步）
    const freshPctByName = new Map(); // 本次新取到的收盘涨幅
    let source = '';
    let updated = 0;
    let total = 0;
    if (isToday) {
        const targets = [];
        rows.forEach(function(r) {
            const name = String((r && r.stock) || '').trim();
            if (!name) return;
            const code = String((r && (r.code || scMap[name])) || '').trim();
            if (!code) return; // 真的缺码 → 跳过，不伪造
            if (!force && !_needCover(cloudByName.get(name), (r.auc_pct_chg || r.aucPctChg), date)) return;
            targets.push({ name: name, code: code });
        });
        total = targets.length;
        if (targets.length > 0) {
            const ymd = date.replace(/-/g, '');
            const codeSet = new Set();
            targets.forEach(function(t) { codeSet.add(t.code); });

            // 主通道：猫抓 daily（1 次请求覆盖全市场）
            let numcatErr = null;
            try {
                const byCode = await fetchNumcatDailyPctRange(Array.from(codeSet).join(','), ymd, ymd);
                if (byCode && byCode.size > 0) {
                    targets.forEach(function(t) {
                        const dm = byCode.get(t.code);
                        if (dm && dm.has(ymd)) freshPctByName.set(t.name, dm.get(ymd));
                    });
                    if (freshPctByName.size > 0) source = 'numcat-daily';
                }
            } catch (e) {
                numcatErr = e;
                _dbgLog('[CLOSE-COVER] 猫抓 daily 不可用：' + (e && e.message || e));
            }
            // 兜底：同花顺 K 线（逐只，较慢）——覆盖【猫抓没返回的那部分票】。
            // [FIX 2026-09-10] 原实现只在「猫抓整体报错」时才兜底；实测猫抓对少数票
            // （停牌/次新/代码映射缺失）当日不返回行，这些票的 change_pct 会永远停在竞价涨幅
            // （9/10 实测 8/60 只）。改为按【缺失的票】补，且猫抓正常但当日未结算（整体空）时
            // 不再走同花顺逐只（同花顺同样取不到），避免每小时几十次无效请求（§32）。
            const missingTargets = targets.filter(function(t) { return !freshPctByName.has(t.name); });
            if (missingTargets.length > 0 && (numcatErr || freshPctByName.size > 0)) {
                try {
                    const byName = await fetchFuyaoDailyPctRange(
                        missingTargets.map(function(t) { return { stock: t.name, code: t.code }; }),
                        [date],
                        { concurrency: 4 }
                    );
                    let filled = 0;
                    if (byName && byName.size > 0) {
                        byName.forEach(function(dm, name) {
                            if (dm && dm.has(ymd) && !freshPctByName.has(name)) {
                                freshPctByName.set(name, dm.get(ymd));
                                filled++;
                            }
                        });
                    }
                    if (filled > 0) source = source ? (source + '+ths-kline') : 'ths-kline';
                    _dbgLog('[CLOSE-COVER] 同花顺补齐缺失 ' + filled + '/' + missingTargets.length + ' 只');
                } catch (e) {
                    _dbgLog('[CLOSE-COVER] 同花顺兜底失败：' + (e && e.message || e));
                }
            }

            if (freshPctByName.size === 0) {
                _failedAt.set(date, Date.now());
                return { ok: false, skipped: false, reason: '当日收盘涨幅取不到（可能行情尚未结算，稍后自动重试）' };
            }

            // 写入云端（只带 change_pct + updated_*，upsert 不会抹掉 volume/auc_pct_chg 等竞价字段）
            const nowIso = new Date().toISOString();
            const payload = [];
            freshPctByName.forEach(function(pct, name) {
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
                const cr = cloudByName.get(name);
                if (cr) { cr.change_pct = _fmtPct(pct); cr.updated_at = nowIso; }
            });
            if (payload.length === 0) {
                _failedAt.set(date, Date.now());
                return { ok: false, skipped: false, reason: '无可写入的收盘涨幅' };
            }
            try {
                await upsertMarketMetricsRows(payload);
            } catch (e) {
                _dbgLog('[CLOSE-COVER] 写入 market_metrics 失败：' + (e && e.message || e));
                return { ok: false, skipped: false, reason: '写入指标表失败：' + (e && e.message || e) };
            }
            updated = payload.length;

            // 同步内存行（界面「涨幅」列与趋势图直接读内存行，不回写会出现「云端已更新/界面没变」）
            try {
                const g = getAuctionData();
                const list = (g && g[date]) || [];
                const byName = new Map();
                list.forEach(function(r) {
                    if (!r || !r.stock) return;
                    const n = String(r.stock).trim();
                    if (n && !byName.has(n)) byName.set(n, r);
                });
                freshPctByName.forEach(function(pct, name) {
                    const row = byName.get(name);
                    if (row) row.changePct = _fmtPct(pct);
                });
            } catch (e) {
                _dbgLog('[CLOSE-COVER] 同步内存行失败（非致命）：' + (e && e.message || e));
            }
        }
    }

    // 5) 区间涨幅 T 腿口径校正（0 请求）
    let rangeFixed = 0;
    try {
        rangeFixed = await _syncRangeTDay(date, cloudByName, freshPctByName);
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 区间涨幅 T 腿校正失败（非致命）：' + (e && e.message || e));
    }

    if (updated === 0 && rangeFixed === 0) {
        _coveredDates.add(date);
        return { ok: true, skipped: true, reason: '全部已是收盘口径' };
    }
    _coveredDates.add(date);
    _dbgLog('[CLOSE-COVER] ' + date + ' 收盘口径校正完成：change_pct ' + updated + '/' + total +
        ' 只（来源=' + (source || '-') + '），区间涨幅 T 腿 ' + rangeFixed + ' 只');
    return { ok: true, skipped: false, updated: updated, total: total, rangeFixed: rangeFixed, source: source };
}

/**
 * 【区间涨幅 T 腿口径校正 / 方案A】
 * 9:25 worker 用【竞价涨幅】做 T 腿算好 stock_range_pct 并落库；收盘后 T 腿应改成【收盘涨幅】。
 * 无需重新拉取历史日线：区间涨幅是复利累乘，把 T 腿那一项换掉即可
 *   prevAcc = (1 + 已存区间涨幅) ÷ (1 + 竞价腿)      ← 去掉旧的 T 腿（竞价腿为 0/缺失时等价于不去除）
 *   新区间涨幅 = prevAcc × (1 + 收盘腿) - 1
 *
 * 幂等：只处理「写于该日 15:00 之前」的行（= 竞价腿口径）；校正后 updated_at 变成现在 → 不会重复换算。
 * @returns {Promise<number>} 实际校正的行数
 */
async function _syncRangeTDay(date, cloudByName, freshPctByName) {
    let rangeRows;
    try {
        rangeRows = await readRangePctForDate(date);
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 读取 stock_range_pct 失败：' + (e && e.message || e));
        return 0;
    }
    if (!rangeRows || rangeRows.size === 0) return 0;

    const closeMs = _closeCoverUtcMs(date);
    if (Number.isNaN(closeMs)) return 0;
    const out = [];
    rangeRows.forEach(function(v, name) {
        const t = v.updatedAt ? Date.parse(v.updatedAt) : NaN;
        // 已是收盘口径（写于 15:00 之后），或时间未知 → 不动（宁可保持现状，也不做不可靠的换算）
        if (Number.isNaN(t) || !t || t >= closeMs) return;
        const old = v.pct;
        if (old === null || old === undefined || !isFinite(old)) return;

        const m = cloudByName.get(name);
        // 优先用本次刚抓到的收盘涨幅；否则用云端 change_pct（必须是该日 15:00 之后写入的才可信）
        let closePct = freshPctByName && freshPctByName.has(name) ? freshPctByName.get(name) : null;
        if (closePct === null && m) {
            const mt = m.updated_at ? Date.parse(m.updated_at) : NaN;
            if (!Number.isNaN(mt) && mt >= closeMs) closePct = _parsePct(m.change_pct);
        }
        if (closePct === null || !isFinite(closePct)) return;

        // 旧的 T 腿 = worker 用的竞价涨幅（0 或缺失时对复利结果无影响，(1+0)=1）
        const auc = _parsePct(m && m.auc_pct_chg);
        // 口径实现在 range-window.js（前后端单一真相），这里只做编排
        const next = replaceTDayLeg(old, auc, closePct);
        if (next === null) return;
        out.push({ stock: name, pct: next, days: v.days });
    });
    if (out.length === 0) return 0;
    try {
        await upsertRangePctRows(date, out);
    } catch (e) {
        _dbgLog('[CLOSE-COVER] 写回区间涨幅 T 腿失败：' + (e && e.message || e));
        return 0;
    }
    return out.length;
}

/** 供后台按钮/手动触发：清掉本会话幂等标记后重跑一次 */
export function resetClosePctCover(date) {
    if (date) {
        _coveredDates.delete(date);
        _failedAt.delete(date);
    } else {
        _coveredDates.clear();
        _failedAt.clear();
    }
}
