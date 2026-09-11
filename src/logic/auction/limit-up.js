// limit-up.js — 「竞价一字」（竞价涨停）判定（Logic 层，§15 独立业务模块，纯函数无副作用）
//
// 业务口径（2026-09-09 定）：
//   9:25 集合竞价结束时的竞价涨幅（auc_pct_chg）达到该股【涨停幅度】→ 视为「竞价一字」。
//   竞价一字意味着开盘竞价报价就是涨停价，是最强的一字板信号，需要在看板上用红线标出。
//
// 涨停幅度（按板块，A 股现行规则）：
//   - 主板（60 / 00 开头）：10%；ST / *ST 主板：5%
//   - 创业板（300 / 301）与 科创板（688 / 689）：20%（ST 同样 20%）
//   - 北交所（43 / 83 / 87 / 88 / 92 开头）：30%
//   - 代码缺失：按主板 10% 兜底（绝大多数标的所在板块），绝不因为缺代码而漏判/误判为 0。
//
// 容差：涨停价由「前收 × (1+幅度)」四舍五入到分，实际涨幅常见 9.98% / 10.02% / 10.05%，
//       因此判定用 EPS 容差，而不是严格 >= 幅度。

const LIMIT_MAIN = 10;    // 主板
const LIMIT_ST = 5;       // 主板 ST
const LIMIT_GROWTH = 20;  // 创业板 / 科创板
const LIMIT_BJ = 30;      // 北交所
// 四舍五入容差：10.02%、9.98% 都算一字；9.5% 不算
const EPS = 0.15;

/** 股票名是否 ST（含 *ST / ST / S*ST 等写法） */
export function isStStockName(stockName) {
    if (!stockName) return false;
    return /\*?\s*ST/i.test(String(stockName));
}

/**
 * 取涨停幅度（%）——只依赖代码与股票名，不做任何请求（Data 层职责外的纯计算）。
 * @param {string} code - 6 位股票代码（可为空）
 * @param {string} [stockName] - 股票名（用于 ST 判定）
 * @returns {number} 涨停幅度（%）
 */
export function getLimitUpPct(code, stockName) {
    const c = String(code || '').replace(/\D/g, '');
    if (!c) return isStStockName(stockName) ? LIMIT_ST : LIMIT_MAIN;
    if (/^(43|83|87|88|92)/.test(c)) return LIMIT_BJ;          // 北交所
    if (/^(30|68)/.test(c)) return LIMIT_GROWTH;               // 创业板 300/301，科创板 688/689
    if (/^(60|00|01)/.test(c)) return isStStockName(stockName) ? LIMIT_ST : LIMIT_MAIN; // 沪主板/深主板
    return isStStockName(stockName) ? LIMIT_ST : LIMIT_MAIN;
}

/** 解析竞价涨幅字符串（'+10.02%' / '-7.71%' / 10.02 / null）→ number|null。解析不出来返回 null（绝不退化成 0）。 */
export function parseAucPct(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(String(raw).replace('%', '').replace('+', '').trim());
    return isFinite(n) ? n : null;
}

/**
 * 竞价一字判定：竞价涨幅是否达到该股涨停幅度。
 * 无竞价涨幅字段 → false（不做任何猜测，避免把"没数据"显示成一字）。
 * @param {object} item - 竞价行（含 stock / auc_pct_chg / code 等）
 * @param {string} [code] - 股票代码；不传则用 item.code
 * @returns {boolean}
 */
export function isAuctionYiZi(item, code) {
    if (!item || !item.stock) return false;
    const pct = parseAucPct(item.auc_pct_chg || item.aucPctChg || '');
    if (pct === null) return false;
    const name = String(item.stock).trim();
    const cd = code || item.code || '';
    return pct + EPS >= getLimitUpPct(cd, name);
}

/**
 * 批量构建「竞价一字」股票名集合（供题材分组排序使用）。
 * @param {object[]} list - 行列表
 * @param {(item:object)=>string} [codeOf] - 取代码函数（缺省用 item.code）
 * @returns {Set<string>} 一字股名称集合（trim）
 */
export function buildYiZiSet(list, codeOf) {
    const set = new Set();
    if (!list || list.length === 0) return set;
    list.forEach(function(it) {
        if (!it || !it.stock) return;
        const name = String(it.stock).trim();
        if (!name) return;
        const cd = codeOf ? codeOf(it) : (it.code || '');
        if (isAuctionYiZi(it, cd)) set.add(name);
    });
    return set;
}

/**
 * 【收盘】涨停 / 跌停判定（2026-09-11 新增，用于「收盘停板」蚂蚁线标记与同题材统计）。
 *
 * 与 isAuctionYiZi（竞价口径）严格区分：本函数只看【收盘涨幅】。
 *   · 竞价一字 = 9:25 竞价报价就打在涨停价上（实线红线，盘中信号）；
 *   · 收盘涨停 = 全天走完后收在涨停价（红色蚂蚁线，收盘结果）。
 * 两者可以同时成立（竞价一字往往收在涨停），视觉上由调用方决定优先级，本模块只出判定。
 *
 * 涨停幅度复用 getLimitUpPct（按板块/ST），容差同样复用 EPS：
 *   收盘涨停：pct + EPS >= +幅度（涨停价四舍五入到分 → 实测 +9.88% / +9.97% 都算涨停）
 *   收盘跌停：pct - EPS <= -幅度（跌停同理，实测 -9.97% 算跌停）
 *
 * @param {*} closePct - 收盘涨幅：number 或 '+9.98%' / '-9.97%' 这类字符串
 * @param {string} [code] - 6 位股票代码（缺省兜底主板 10%）
 * @param {string} [stockName] - 股票名（用于 ST 判定）
 * @returns {'up'|'down'|null} 'up'=收盘涨停 / 'down'=收盘跌停 / null=都不是或没有涨幅数据
 *          ⚠️ 无数据一律返回 null，绝不把「没数据」当成「没涨停」以外的任何东西（§10）。
 */
export function getCloseLimitState(closePct, code, stockName) {
    const pct = (typeof closePct === 'number')
        ? (isFinite(closePct) ? closePct : null)
        : parseAucPct(closePct);
    if (pct === null) return null;
    const limit = getLimitUpPct(code, stockName);
    if (pct + EPS >= limit) return 'up';
    if (pct - EPS <= -limit) return 'down';
    return null;
}

/**
 * 【收盘】股票名字体颜色档位（2026-09-11 新增）。
 *
 * 需求：收盘涨幅 > 0 → 股票名红色；< 0 → 绿色；= 0 → 保持默认色（黑）；
 *      早盘一律默认色（此时 change_pct 只是 9:25 竞价副本，不是收盘结果）。
 * 与 getCloseLimitState（是否停板）是两件事：本函数只表「涨跌方向」，不看幅度阈值。
 *
 * ⚠️ 【闸门内置、缺省即不上色】—— 这是刻意的安全设计：
 *    闸门条件（题材模式 + 该日已是收盘口径）必须写在函数里，而不是靠每个调用方记得加 if。
 *    ctx 缺失 / byTopic=false / closeWindow=false 一律返回 null → 保持默认黑。
 *    这样「忘了传 ctx」的后果是「不上色」（安全方向），绝不会变成「用竞价副本冒充收盘结果」。
 *    closeWindow = isAuthoritativeCloseReached(date)（北京 16:05 起才为 true）。
 *
 * ⚠️ 无数据（null / '' / 非数）同样返回 null，绝不把「没数据」着色（§10）。
 *
 * @param {*} closePct - 收盘涨幅：number 或 '+1.23%' / '-2.34%' 这类字符串
 * @param {{byTopic?:boolean, closeWindow?:boolean}} ctx - 显示闸门；缺任一项 → null
 * @returns {'up'|'down'|null} 'up'=红（涨）/ 'down'=绿（跌）/ null=默认色（平盘 / 无数据 / 未到收盘口径）
 */
export function getCloseNameTone(closePct, ctx) {
    if (!ctx || !ctx.byTopic || !ctx.closeWindow) return null;
    const pct = (typeof closePct === 'number')
        ? (isFinite(closePct) ? closePct : null)
        : parseAucPct(closePct);
    if (pct === null || pct === 0) return null;
    return pct > 0 ? 'up' : 'down';
}
