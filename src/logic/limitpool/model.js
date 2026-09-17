// model.js — 「涨跌停」看板的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「数据 → 展示结构」的纯变换：不读 state、不发请求、不碰 DOM、不写库。
// 由 logic/limitpool/limit-pool.js（编排层）把数据准备好后调用，单测见 model.test.js。
//
// 本模块刻意复用的两处【单一真相】：
//   · 组排序 = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」完全同一套组序规则）
//   · 题材文本清洗 = note/helpers.js#isValidTopic

import { sortByTopicGroups, getStockTopicArr, getStockTopicsDisplay } from '../auction/topic-sort.js';
import { isValidTopic } from '../note/helpers.js';
import { RANGE_WINDOW_DAYS } from '../auction/range-window.js';

export const OTHER_TOPIC = '其它';

/**
 * 一行粘贴文本的 token 切分口径（多空格 / 全角空格 / 常见分隔符一律切开）：
 *   `兆易创新 存储芯片,AI应用`
 *   `600000 平安银行 银行`
 *   `1. 兆易创新：存储芯片、AI应用`
 *   `兆易创新|存储芯片|AI应用`
 */
const PASTE_SEP_RE = /[\s\u3000,，、;；|:：/／#*]+/;
const LEADING_INDEX_RE = /^\s*\d+\s*[.、)）]\s*/;
const PLAIN_CODE_RE = /^\d{6}$/;
const CODE_WITH_SUFFIX_RE = /^(\d{6})\.(SH|SZ|BJ)$/i;

/**
 * 解析「手动粘贴导入题材」的文本（纯函数）。
 *
 * 规则：
 *   · 每行 = `股票名 [代码] 题材1 题材2 ...`；代码（6 位）可出现在任意位置，会被摘出来；
 *   · 同一只股票出现多行 → 题材合并去重（不覆盖）；
 *   · 题材一律过 isValidTopic（剔掉 `题材33` / 纯数字 / 单字 / `其它` 等无效值）；
 *   · 只有股票名、没有任何有效题材的行 → 计入 skipped（不写库，避免用空值抹掉库里已有题材）。
 *
 * @param {string} text
 * @returns {{rows:Array<{stock:string, code:string, topics:string[]}>, skipped:number, totalLines:number}}
 */
export function parseTopicPaste(text) {
    const out = [];
    const byStock = new Map();
    let skipped = 0;
    let totalLines = 0;
    if (!text || typeof text !== 'string') return { rows: out, skipped: skipped, totalLines: totalLines };

    text.split(/\r?\n/).forEach(function(rawLine) {
        const line = String(rawLine || '').replace(LEADING_INDEX_RE, '').trim();
        if (!line) return;
        totalLines++;
        const tokens = line.split(PASTE_SEP_RE).map(function(t) { return t.trim(); }).filter(Boolean);
        if (tokens.length < 2) { skipped++; return; }

        let stock = '';
        let code = '';
        const topics = [];
        tokens.forEach(function(tk) {
            const m = tk.match(CODE_WITH_SUFFIX_RE);
            if (m) { if (!code) code = m[1]; return; }
            if (PLAIN_CODE_RE.test(tk)) { if (!code) code = tk; return; }
            if (!stock) { stock = tk; return; }
            if (isValidTopic(tk)) topics.push(tk);
        });

        if (!stock) { skipped++; return; }
        const dedupTopics = [];
        const seen = new Set();
        topics.forEach(function(t) {
            const key = t.replace(/\s+/g, '').toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            dedupTopics.push(t);
        });
        // 没有有效题材：不写库（否则会用空题材覆盖 / 无意义写入）
        if (dedupTopics.length === 0) { skipped++; return; }

        const exist = byStock.get(stock);
        if (exist) {
            dedupTopics.forEach(function(t) {
                if (exist.topics.indexOf(t) < 0) exist.topics.push(t);
            });
            if (!exist.code && code) exist.code = code;
            return;
        }
        const row = { stock: stock, code: code, topics: dedupTopics };
        byStock.set(stock, row);
        out.push(row);
    });

    return { rows: out, skipped: skipped, totalLines: totalLines };
}

/**
 * 取某一行在「题材分组」里的主题材。
 * 一票只归一（与早盘竞价第一页题材 toggle 同口径）：优先用整表分类结果，取不到再走单票兜底。
 * @param {Map<string,string>} primaryMap stockName → 主题材
 * @param {object} row
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @returns {string}
 */
function _topicOf(primaryMap, row, fallbackFn) {
    const nm = row && row.stock ? String(row.stock).trim() : '';
    if (primaryMap && nm && primaryMap.has(nm)) {
        const t = primaryMap.get(nm);
        if (t) return t;
    }
    let fb = '';
    try { fb = fallbackFn ? fallbackFn(row) : ''; } catch (e) { fb = ''; }
    return fb || OTHER_TOPIC;
}

/**
 * 池内排序（纯函数）：只产生「行索引数组」，不改动入参。
 * 组序复用 sortByTopicGroups（组大者前 → 题材名稳定 → 「其它」置底），全池同一个档位（tier=0）。
 * @param {object[]} rows
 * @param {(idx:number)=>string} topicAt
 * @returns {number[]}
 */
function _poolOrder(rows, topicAt) {
    const order = rows.map(function(_r, i) { return i; });
    if (order.length <= 1) return order;
    const sorted = sortByTopicGroups(order, rows, function() { return 0; }, topicAt);
    return Array.isArray(sorted) && sorted.length === order.length ? sorted : order;
}

/**
 * 把一行池数据 + 十日涨幅，按题材切成「看板分块」结构。
 *
 * @param {object[]} rows 池行（含 stock/code/continueText/... 展示字段）
 * @param {Map<string,string>} primaryMap 整表分类结果（getPrimaryTopicMap）
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @param {(row:object)=>({pct:number|null, days:number}|null)} rangePctOf 十日涨幅取值
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string, leaderPct:number|null, leaderDays:number, stocks:Array<object>}>}
 */
export function buildTopicBlocks(rows, primaryMap, fallbackFn, rangePctOf) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return [];

    const topicAt = function(idx) { return _topicOf(primaryMap, list[idx], fallbackFn); };
    const order = _poolOrder(list, topicAt);

    // 1) 按顺序切成「连续同题材」的块（顺序已由 sortByTopicGroups 保证同题材连续）
    const blocks = [];
    let cur = null;
    order.forEach(function(idx) {
        const topic = topicAt(idx);
        if (!cur || cur.topic !== topic) {
            cur = { topic: topic, stocks: [] };
            blocks.push(cur);
        }
        cur.stocks.push(list[idx]);
    });

    // 2) 块内按「十日涨幅降序」排 → 序号即十日涨幅排名；无有效涨幅的置底并保持原相对顺序
    blocks.forEach(function(b) {
        b.stocks = b.stocks.map(function(r, i) {
            const rp = rangePctOf ? rangePctOf(r) : null;
            const pct = rp && rp.pct !== null && rp.pct !== undefined && isFinite(rp.pct) ? Number(rp.pct) : null;
            return {
                row: r,
                pct: pct,
                days: rp && isFinite(rp.days) ? Number(rp.days) : 0,
                pos: i
            };
        });
        b.stocks.sort(function(a, c) {
            const av = a.pct === null ? -Infinity : a.pct;
            const cv = c.pct === null ? -Infinity : c.pct;
            if (cv !== av) return cv - av;
            return a.pos - c.pos;
        });

        const head = b.stocks[0];
        b.hasLeader = !!(head && head.pct !== null);
        b.leaderStock = b.hasLeader ? String(head.row.stock || '') : '';
        b.leaderPct = b.hasLeader ? head.pct : null;
        b.leaderDays = b.hasLeader ? head.days : 0;
        b.count = b.stocks.length;
        // 序号（1 起）+ 是否龙头（组内十日涨幅最高者）
        b.stocks = b.stocks.map(function(x, i) {
            // 题材判据的唯一入参形状（展示与「无题材」判定【共用同一份输入】，口径不可能分叉）
            const topicInput = { stock: x.row.stock, topics: x.row.topicsText };
            return {
                stock: x.row.stock,
                code: x.row.code || '',
                changePct: x.row.changePct || '',
                continueText: x.row.continueText || '',
                // 全题材展示文本（英文逗号分隔，无题材 → '-'）：由编排层预置的原始题材文本经
                // topic-sort.js#getStockTopicsDisplay 归一 —— 与早盘竞价看板「题材单元格」同一口径。
                // 为什么必须用英文逗号：全角「，」宽约一个汉字，一票多题材时白占近半行；
                // 英文「,」只有半宽。题材是本看板的主角列，宽度全留给它。
                topicsDisplay: getStockTopicsDisplay(topicInput),
                // 是否【有题材】= 同一次 getStockTopicArr 的非空判定 —— 与上面的 '-' 显示同源：
                // topicsDisplay === '-' ⇔ hasTopic === false，绝不自造第二套「无题材」口径。
                // 供「无题材」toggle 过滤（filterNoTopicBlocks）与人工补题材用。
                hasTopic: getStockTopicArr(topicInput).length > 0,
                reason: x.row.reason || '',
                limitTime: x.row.limitTime || '',
                sealMoney: x.row.sealMoney === null || x.row.sealMoney === undefined ? null : x.row.sealMoney,
                seq: i + 1,
                rangePct: x.pct,
                rangeDays: x.days,
                isLeader: b.hasLeader && i === 0
            };
        });
    });

    return blocks;
}

/**
 * 「无题材」视图过滤（纯函数）：只留没有题材的股票（供人工统一补题材时截图）。
 *
 * 规则（全部是「结构不变、只裁行」的纯变换，不改动入参）：
 *   · 逐个分块保留 `hasTopic === false` 的行；裁完后变空的分块直接丢弃；
 *   · 序号在【裁完后的行集合】上从 1 重排 —— 截图上序号连续，不留空洞；
 *   · ⛔ 该视图下【一律不选龙头】：龙头是「某题材内十日涨幅最高」的派生概念，
 *     一只没有题材的股票不存在所属题材组，给它挂龙头标会凭空造出一个错误的题材结论；
 *   · 分块的 count 同步为裁完后的行数（题材条上的「N只」与真实可见行数一致）。
 *
 * @param {Array<object>} blocks buildTopicBlocks 的输出
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterNoTopicBlocks(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const out = [];
    list.forEach(function(b) {
        if (!b) return;
        const rows = (b.stocks || []).filter(function(s) { return s && !s.hasTopic; });
        if (rows.length === 0) return;
        out.push({
            topic: b.topic,
            count: rows.length,
            hasLeader: false,
            leaderStock: '',
            leaderPct: null,
            leaderDays: 0,
            stocks: rows.map(function(s, i) {
                return Object.assign({}, s, { seq: i + 1, isLeader: false });
            })
        });
    });
    return out;
}

/**
 * 十日涨幅展示文本（唯一口径）。
 *   · 无数据 → '-'（⛔ 禁止补 0：0% 是一个真实涨幅）
 *   · 满窗   → '+12.34%'
 *   · 缺腿   → '+12.34%(7/10日)'（与早盘竞价看板同一约定，明示「这只票窗口不全」）
 * @param {number|null} pct
 * @param {number} days
 * @param {number} [windowDays]
 * @returns {string}
 */
export function formatRangePct(pct, days, windowDays) {
    const win = windowDays || RANGE_WINDOW_DAYS;
    if (pct === null || pct === undefined || !isFinite(pct)) return '-';
    const txt = (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%';
    const d = isFinite(days) ? Number(days) : 0;
    if (d > 0 && d < win) return txt + '(' + d + '/' + win + '日)';
    return txt;
}

/**
 * 十日涨幅涨跌方向（用于配色：涨红跌绿，与项目约定一致）。
 * @param {number|null} pct
 * @returns {'up'|'down'|'flat'}
 */
export function rangeTone(pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return 'flat';
    if (pct > 0) return 'up';
    if (pct < 0) return 'down';
    return 'flat';
}

/**
 * 封单额展示（亿元 / 万元）。
 * @param {number|null} money 元
 * @returns {string}
 */
export function formatSealMoney(money) {
    if (money === null || money === undefined || !isFinite(money) || money === 0) return '';
    const yi = money / 1e8;
    if (Math.abs(yi) >= 1) return yi.toFixed(2) + '亿';
    return (money / 1e4).toFixed(0) + '万';
}
