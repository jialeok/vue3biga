// trend-model.js — 「竞价一字 · 趋势图」的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「一批趋势缓存行 + 窗口日期 → 某只股票的四条曲线」的纯变换：
// 不读 state、不发请求、不碰 DOM、不写库。单测见 trend-model.test.js。
//
// 【四条腿的口径（★ 与 Edge Function / 早盘竞价看板逐字一致，⛔ 不要另立一套）】
//   · 竞价量(万)     = auc_vol(手) ÷ 100
//        —— Edge 已把猫抓 auc_vol(手) 原样写进库，这里只做「手 → 万」的展示换算（1万 = 100手），
//           与早盘竞价看板 logic/auction/auction-numcat.js#668 同一换算。
//   · 昨日成交量(万) = yest_volume
//        —— Edge 侧已按 auc_vol ÷ auc_to_pre_vol_pct 反推好（与 workers/bidding-auto-fetch
//           logic/morning-workflow.js#567 同一式），这里原样透传，⛔ 不再算第二遍。
//   · 竞价涨幅(%)    = auc_pct_chg 文本（形如 "+10.02"）→ number
//   · 涨幅(%)        = change_pct 文本（形如 "+3.25"）→ number
//
// 【「十日涨幅」为什么不在这里】
//   它是这一行的**既有字段**（stock_range_pct → rangeText / rangeTone），
//   属于「快照 + 共享度量」的派生视图，⛔ 不进趋势缓存表（进去就会变成第二个真相源）。
//   UI 直接从行对象读，本模块不碰。
//
// 【§10】任一格没有数据 → 该点 value = null（TrendChart 会画成 '--' 断点）。
//   ⛔ 绝不用 0 顶替 —— 0 是真实的成交量/涨幅，用它顶「没数据」会把「未知」伪装成「平盘」。

/**
 * 百分比文本 → number|null。
 * 兼容上游/库里的几种长相：number（10.03）、'+10.03'、'-0.24'、'10.03%'、Unicode 负号（−）。
 * ⛔ 解析不出来返回 null（绝不退化成 0）。
 * @param {*} raw
 * @returns {number|null}
 */
export function pctTextToNum(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    const s = String(raw).replace(/[%\s]/g, '').replace(/^\+/, '').replace(/[−—]/g, '-');
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
}

/**
 * 空序列（窗口内每一天都是「无数据」）。
 * 用途：UI 在「这一天的趋势还没读到」时也能拿到结构一致的对象，模板不必到处判空。
 * @param {string[]} windowDates 升序（旧 → 新）
 * @returns {object}
 */
export function emptyYiziTrendSeries(windowDates) {
    const pts = function() {
        return (windowDates || []).map(function(d) { return { date: d, value: null }; });
    };
    return {
        volume: pts(),
        yestVolume: pts(),
        aucPctChg: pts(),
        changePct: pts(),
        latest: null,
        latestDate: '',
        hasAucPct: false,
        hasChangePct: false
    };
}

/**
 * 把「窗口内每一天」的趋势行组装成一只股票的四条曲线。
 *
 * @param {Array<object>} rows Data 层的趋势行（含 date / stock / aucVol / yestVolume / aucPctChg / changePct）
 * @param {string[]} windowDates 升序的交易日（旧 → 新）；点的顺序与日期轴一律以它为准
 * @param {string} stock 股票名（与 auction_yizi.stock 同键）
 * @returns {{volume:Array<{date:string,value:number|null}>,
 *            yestVolume:Array<{date:string,value:number|null}>,
 *            aucPctChg:Array<{date:string,value:number|null}>,
 *            changePct:Array<{date:string,value:number|null}>,
 *            latest:object|null, latestDate:string,
 *            hasAucPct:boolean, hasChangePct:boolean}}
 */
export function buildYiziTrendSeries(rows, windowDates, stock) {
    const dates = (windowDates || []).map(function(d) { return String(d); });
    const name = String(stock || '').trim();
    const series = emptyYiziTrendSeries(dates);
    if (!name || dates.length === 0) return series;

    // 按日期索引该股票的行（同一 date 只应有一行：表主键是 date+stock）
    const byDate = {};
    (rows || []).forEach(function(r) {
        if (!r || String(r.stock || '').trim() !== name) return;
        const d = String(r.date || '');
        if (!d) return;
        byDate[d] = r;
    });

    let latest = null;
    dates.forEach(function(d, i) {
        const r = byDate[d];
        if (!r) return;
        // 竞价量：手 → 万（四舍五入到整数万，与早盘竞价看板 volume 的整数口径一致）
        series.volume[i].value = (r.aucVol === null || r.aucVol === undefined) ? null : Math.round(Number(r.aucVol) / 100);
        series.yestVolume[i].value = (r.yestVolume === null || r.yestVolume === undefined) ? null : Number(r.yestVolume);
        series.aucPctChg[i].value = pctTextToNum(r.aucPctChg);
        series.changePct[i].value = pctTextToNum(r.changePct);
        // 最新一行 = 日期轴上**最后一个有任何数据**的那天（用于面板顶部的当前值汇总）
        if (series.volume[i].value !== null || series.yestVolume[i].value !== null ||
            series.aucPctChg[i].value !== null || series.changePct[i].value !== null) {
            latest = r;
            series.latestDate = d;
        }
    });
    series.latest = latest;
    series.hasAucPct = series.aucPctChg.some(function(p) { return p.value !== null; });
    series.hasChangePct = series.changePct.some(function(p) { return p.value !== null; });
    return series;
}

/**
 * 面板顶部「当前值汇总」的展示项（纯展示格式化，⛔ 不含任何业务口径）。
 * 数值全部来自 buildYiziTrendSeries 的结果 —— 与曲线同源，不会出现「曲线一个数、汇总另一个数」。
 * @param {object} series buildYiziTrendSeries 的返回值
 * @returns {Array<{label:string, value:string}>}
 */
export function trendMetricItems(series) {
    if (!series || !series.latest) return [];
    // ⚠️ 取「有数据的最新那一天」的值，而不是盲目取数组最后一项：
    //    盘中/9:25 之前，T 日那一格可能还是空的（value=null）；若直接读最后一项，
    //    会出现「标签写着最新日期 09-17、数值却是 '-'」的自相矛盾。
    //    这里按 latestDate 定位下标 → 标签与数值必然同一天（与曲线同源）。
    const idx = series.volume.findIndex(function(p) { return p.date === series.latestDate; });
    const at = function(arr) { return (idx >= 0 && arr[idx]) ? arr[idx].value : null; };
    const v = at(series.volume);
    const yv = at(series.yestVolume);
    const ap = at(series.aucPctChg);
    const cp = at(series.changePct);
    const last = series.latestDate ? series.latestDate.slice(5) : '';
    const pct = function(n) { return (n === null || n === undefined) ? '-' : ((n > 0 ? '+' : '') + n.toFixed(2) + '%'); };
    const vol = function(n) { return (n === null || n === undefined) ? '-' : (n + '万'); };
    return [
        { label: '最新日期', value: last || '-' },
        { label: '竞价量', value: vol(v) },
        { label: '昨日成交量', value: vol(yv) },
        { label: '竞价涨幅', value: pct(ap) },
        { label: '涨幅', value: pct(cp) }
    ];
}
