/**
 * useSortToggles.js
 * 早盘竞价看板排序 composable（Vue 3）
 *
 * 职责：封装 page1/page2 的排序逻辑，纯函数无副作用。
 * 从 src/ui/composables/auction-composables.js 拆分而来，去 window 化为 ES module。
 */
import { ref, computed } from 'vue';
import { getNumericVolume } from '../data/supabase-client.js';
import { getDigitCount } from '../logic/auction/sort-rules.js';
import { _dbgLog } from '../data/debug-log.js';

// 三天竞跌「当天竞价涨幅」提取（与 view-helpers.js 口径一致）：
// 专用字段 auc_pct_chg（五日竞价涨幅），绝不读 changePct/change_pct（会被「获取涨幅」改写为常规涨幅）。
function _getThreeDayAuctionPct(rawItem) {
  if (!rawItem) return null;
  const raw = rawItem.auc_pct_chg || rawItem.aucPctChg || rawItem.changePct || rawItem.change_pct || '';
  const num = parseFloat(String(raw).replace('%', '').replace('+', ''));
  return isFinite(num) ? num : null;
}

// ============================================================
// Composable: useAuctionSort
// ------------------------------------------------------------
// 封装 page1/page2 的排序逻辑，纯函数无副作用。
// ============================================================
export function useAuctionSort() {
    function getNumericVolumeSafe(v) {
        return getNumericVolume(v);
    }

    function getDigitCountSafe(v) {
        return getDigitCount(v);
    }

    function sortPage1RenderOrder(renderOrder, auctionList, ctx) {
        const { sortState, historyCountMap, prevDayMap, signalSets } = ctx;
        const { highRatio, parallel, jingYest, ratioDiff, threeDayJingDie } = signalSets || {};
        const jingYestHighlightSet = jingYest;
        const threeDayJingDieSet = threeDayJingDie;

        if (sortState.byWeakStrong) {
            return renderOrder.map((idx) => ({
                idx,
                c: auctionList[idx] && auctionList[idx].stock
                    ? (historyCountMap.get(auctionList[idx].stock.trim()) || 0)
                    : 0
            })).sort((a, b) => b.c - a.c).map(x => x.idx);
        }

        if (sortState.byRatio) {
            return renderOrder.map((idx, pos) => {
                const it = auctionList[idx];
                const nm = it && it.stock ? it.stock.trim() : '';
                const tv = it ? getNumericVolumeSafe(it.volume) : null;
                const yv = it ? getNumericVolumeSafe(it.yestVolume) : null;
                let r = null;
                if (tv !== null && tv !== 0) {
                    const pi = prevDayMap.get(nm);
                    const pv = pi ? getNumericVolumeSafe(pi.volume) : null;
                    if (pv !== null && pv !== 0) r = tv / pv;
                }
                const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCountSafe(tv) - getDigitCountSafe(yv)) : null;
                const hr = nm && highRatio && highRatio.stockNames.has(nm);
                const tier = hr ? 0 : (r !== null ? 1 : 2);
                return { idx, pos, r, dg, tier };
            }).sort((a, b) => {
                if (a.tier !== b.tier) return a.tier - b.tier;
                if (a.tier === 0 || a.tier === 1) {
                    if (a.dg === null && b.dg === null) return a.pos - b.pos;
                    if (a.dg === null) return 1;
                    if (b.dg === null) return -1;
                    if (a.dg !== b.dg) return a.dg - b.dg;
                    return b.r - a.r;
                }
                return a.pos - b.pos;
            }).map(x => x.idx);
        }

        if (sortState.byJingYestRatio) {
            const info = ratioDiff;
            return renderOrder.map((idx, pos) => {
                const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                const tier = ih ? 0 : 1;
                const fi = ih ? (info ? info.get(nm) : null) : null;
                return { idx, pos, jr: fi ? fi.jingRatio : null, tier };
            }).sort((a, b) => {
                if (a.tier !== b.tier) return a.tier - b.tier;
                if (a.tier === 0) {
                    if (a.jr === null && b.jr === null) return a.pos - b.pos;
                    if (a.jr === null) return 1;
                    if (b.jr === null) return -1;
                    return b.jr - a.jr;
                }
                return a.pos - b.pos;
            }).map(x => x.idx);
        }

        if (sortState.byThreeDayJingDie) {
            return renderOrder.map((idx, pos) => {
                const it = auctionList[idx];
                const nm = it && it.stock ? it.stock.trim() : '';
                const dd = nm && threeDayJingDieSet ? (threeDayJingDieSet.get(nm) || 0) : 0;
                // 同档排序按「当天竞价涨幅 auc_pct_chg」由高到低（专项字段，与绿光口径一致）
                const pctVal = _getThreeDayAuctionPct(it);
                const isQualified = dd >= 2;
                return { idx, pos, isQualified, pctVal };
            }).sort((a, b) => {
                if (a.isQualified !== b.isQualified) return a.isQualified ? -1 : 1;
                if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
                if (a.pctVal === null) return 1;
                if (b.pctVal === null) return -1;
                return b.pctVal - a.pctVal;
            }).map(x => x.idx);
        }

        if (sortState.byParallel) {
            const ps = parallel;
            const info = ratioDiff;
            if (sortState.byJingYest) {
                return renderOrder.map((idx, pos) => {
                    const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                    const ip = ps && ps.has(nm);
                    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                    const tier = ih ? 0 : (ip ? 1 : 2);
                    const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                    return { idx, pos, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.dg === null && b.dg === null) return a.pos - b.pos;
                        if (a.dg === null) return 1;
                        if (b.dg === null) return -1;
                        if (a.dg !== b.dg) return a.dg - b.dg;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }
            return renderOrder.map((idx, pos) => {
                const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                const q = nm && ps && ps.has(nm);
                const fi = q ? (info ? info.get(nm) : null) : null;
                return { idx, pos, q, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null };
            }).sort((a, b) => {
                if (a.q !== b.q) return a.q ? -1 : 1;
                if (a.q) {
                    if (a.dg === null && b.dg === null) return a.pos - b.pos;
                    if (a.dg === null) return 1;
                    if (b.dg === null) return -1;
                    if (a.dg !== b.dg) return a.dg - b.dg;
                    return b.diff - a.diff;
                }
                return a.pos - b.pos;
            }).map(x => x.idx);
        }

        return renderOrder;
    }

    function sortPage2GroupStocks(stocks, ctx) {
        const { auctionByName, prevAuctionByName, sortState, signalSets, highRatioInfo } = ctx;
        const { parallel, jingYest, ratioDiff, threeDayJingDie } = signalSets || {};
        const jingYestHighlightSet = jingYest;
        const parallelStockNames = parallel;
        const threeDayJingDieSet = threeDayJingDie;

        if (sortState.byRatio) {
            return stocks.map((s, pos) => {
                const nm = s.stock ? s.stock.trim() : '';
                if (!nm) return { s, pos, ratio: null, digitGap: null, tier: 2 };
                const ti = auctionByName.get(nm);
                const tv = ti ? getNumericVolumeSafe(ti.volume) : null;
                const yv = ti ? getNumericVolumeSafe(ti.yestVolume) : null;
                let r = null;
                if (tv !== null && tv !== 0) {
                    const pi = prevAuctionByName.get(nm);
                    const pv = pi ? getNumericVolumeSafe(pi.volume) : null;
                    if (pv !== null && pv !== 0) r = tv / pv;
                }
                const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCountSafe(tv) - getDigitCountSafe(yv)) : null;
                const hr = nm && highRatioInfo && highRatioInfo.stockNames.has(nm);
                const tier = hr ? 0 : (r !== null ? 1 : 2);
                return { s, pos, ratio: r, digitGap: dg, tier };
            }).sort((a, b) => {
                if (a.tier !== b.tier) return a.tier - b.tier;
                if (a.tier === 0 || a.tier === 1) {
                    if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                    if (a.digitGap === null) return 1;
                    if (b.digitGap === null) return -1;
                    if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                    return b.ratio - a.ratio;
                }
                return a.pos - b.pos;
            }).map(x => x.s);
        }

        if (sortState.byJingYestRatio) {
            const info = ratioDiff;
            return stocks.map((s, pos) => {
                const nm = s.stock ? s.stock.trim() : '';
                const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                const tier = ih ? 0 : 1;
                const fi = ih ? (info ? info.get(nm) : null) : null;
                return { s, pos, jr: fi ? fi.jingRatio : null, tier };
            }).sort((a, b) => {
                if (a.tier !== b.tier) return a.tier - b.tier;
                if (a.tier === 0) {
                    if (a.jr === null && b.jr === null) return a.pos - b.pos;
                    if (a.jr === null) return 1;
                    if (b.jr === null) return -1;
                    return b.jr - a.jr;
                }
                return a.pos - b.pos;
            }).map(x => x.s);
        }

        if (sortState.byThreeDayJingDie) {
            return stocks.map((s, pos) => {
                const nm = s.stock ? s.stock.trim() : '';
                const dd = nm && threeDayJingDieSet ? (threeDayJingDieSet.get(nm) || 0) : 0;
                // 同档排序按「当天竞价涨幅 auc_pct_chg」由高到低（专项字段，与绿光口径一致）
                const pctVal = _getThreeDayAuctionPct(s);
                const isQualified = dd >= 2;
                return { s, pos, isQualified, pctVal };
            }).sort((a, b) => {
                if (a.isQualified !== b.isQualified) return a.isQualified ? -1 : 1;
                if (a.pctVal === null && b.pctVal === null) return a.pos - b.pos;
                if (a.pctVal === null) return 1;
                if (b.pctVal === null) return -1;
                return b.pctVal - a.pctVal;
            }).map(x => x.s);
        }

        if (sortState.byParallel && parallelStockNames) {
            const info = ratioDiff;
            if (sortState.byJingYest) {
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    const ip = parallelStockNames.has(nm);
                    const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                    const tier = ih ? 0 : (ip ? 1 : 2);
                    const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                    return { s, pos, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                        if (a.digitGap === null) return 1;
                        if (b.digitGap === null) return -1;
                        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
            }
            return stocks.map((s, pos) => {
                const nm = s.stock ? s.stock.trim() : '';
                const q = nm && parallelStockNames.has(nm);
                const fi = q ? (info ? info.get(nm) : null) : null;
                return { s, pos, q, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null };
            }).sort((a, b) => {
                if (a.q !== b.q) return a.q ? -1 : 1;
                if (a.q) {
                    if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                    if (a.digitGap === null) return 1;
                    if (b.digitGap === null) return -1;
                    if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                    return b.diff - a.diff;
                }
                return a.pos - b.pos;
            }).map(x => x.s);
        }

        return stocks;
    }

    return { sortPage1RenderOrder, sortPage2GroupStocks, getNumericVolumeSafe, getDigitCountSafe };
}

_dbgLog('[USE-SORT-TOGGLES] composable 已就绪');