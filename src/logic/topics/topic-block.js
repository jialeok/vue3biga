// topic-block.js — 【跨看板共享】的题材分块 / 题材粘贴解析 / 数值展示 纯函数（Logic 纯函数叶子，§15）
//
// 为什么要有这个模块（§6 单一真相）：
//   「涨跌停」看板（logic/limitpool/）与「竞价一字」看板（logic/yizi/）是【同一种布局】：
//   都是「按题材把股票聚成若干块 → 块内按某个数值降序 → 第一名当龙头 → 块头显示题材名+数量」。
//   两者唯一的差别是【块内排序用的那个数值】：
//     · 涨跌停   = 十日涨幅（rangePct）
//     · 竞价一字 = 9:25 封单额（sealMoney）
//   所以分块/排序/选龙头/切块 这套**规则**只应存在一份；各看板通过 metricKey 指定
//   自己的度量字段名 + extraOf 追加自己的展示字段，绝不复制第二份分块逻辑。
//
// 本模块只含纯函数：不读响应式状态、不发请求、不碰 DOM、不写库（由各看板的编排层喂数据）。
//
// 复用自既有单一真相（⛔ 不许在这里另造一套）：
//   · 组序     = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」完全同一套规则）
//   · 题材判据 = topic-sort.js#getStockTopicArr / getStockTopicsDisplay（与竞价看板题材单元格同口径）
//   · 题材合法 = note/helpers.js#isValidTopic

import { sortByTopicGroups, getStockTopicArr, getStockTopicsDisplay } from '../auction/topic-sort.js';
import { isValidTopic } from '../note/helpers.js';

export const OTHER_TOPIC = '其它';

// ============================================================================
// 一、题材分块（共享核心：切块 / 组内排序 / 选龙头 / 序号 / 题材展示与「无题材」判据）
// ============================================================================

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
 * 把一批行按题材切成「看板分块」结构（共享核心）。
 *
 * 流程（与两个看板完全一致）：
 *   ① 组序 = sortByTopicGroups（组大者前 → 题材名 → 「其它」置底），同题材必连续；
 *   ② 按顺序切成「连续同题材」的块；
 *   ③ 块内按 metric 降序（null 置底且保持原相对顺序）→ 序号即 metric 排名；
 *   ④ 块内第一名 = 龙头（要求 metric 非 null；无有效 metric 则【不选】龙头，绝不硬点一个）。
 *
 * @param {object[]} rows 行数组。每行需含 `stock`，题材原始文本放 `topicsText`（由调用方预置）。
 * @param {object} opts
 * @param {Map<string,string>} opts.primaryMap 整表分类结果（topic-sort.js#getPrimaryTopicMap）
 * @param {(row:object)=>string} opts.fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @param {(row:object)=>({pct:number|null, days:number}|null)} opts.metricOf 度量取值
 * @param {string} opts.metricKey 度量写在行内的字段名（涨跌停='rangePct'；竞价一字='sealMoney'）
 * @param {string} [opts.metricDaysKey] 度量天数写在行内的字段名（不传则不写）
 * @param {(row:object)=>(object|undefined)} [opts.extraOf] 追加本看板特有的展示字段
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string,
 *   leaderMetric:number|null, leaderDays:number, stocks:Array<object>}>}
 */
export function buildTopicBlocks(rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return [];

    const o = opts || {};
    const primaryMap = o.primaryMap;
    const fallbackFn = o.fallbackFn;
    const metricOf = typeof o.metricOf === 'function' ? o.metricOf : function() { return null; };
    const metricKey = o.metricKey || 'metric';
    const metricDaysKey = o.metricDaysKey || '';
    const extraOf = typeof o.extraOf === 'function' ? o.extraOf : null;

    const topicAt = function(idx) { return _topicOf(primaryMap, list[idx], fallbackFn); };
    const order = _poolOrder(list, topicAt);

    // 1) 按顺序切成「连续同题材」的块（顺序已由 sortByTopicGroups 保证同题材连续）
    const blocks = [];
    let cur = null;
    order.forEach(function(idx) {
        const topic = topicAt(idx);
        if (!cur || cur.topic !== topic) {
            cur = { topic: topic, rows: [] };
            blocks.push(cur);
        }
        cur.rows.push(list[idx]);
    });

    // 2) 块内按度量降序排 → 序号即度量排名；无有效值的置底并保持原相对顺序
    const out = [];
    blocks.forEach(function(b) {
        const scored = b.rows.map(function(r, i) {
            const mv = metricOf(r);
            const value = mv && mv.pct !== null && mv.pct !== undefined && isFinite(mv.pct) ? Number(mv.pct) : null;
            return {
                row: r,
                value: value,
                days: mv && isFinite(mv.days) ? Number(mv.days) : 0,
                pos: i
            };
        });
        scored.sort(function(a, c) {
            const av = a.value === null ? -Infinity : a.value;
            const cv = c.value === null ? -Infinity : c.value;
            if (cv !== av) return cv - av;
            return a.pos - c.pos;
        });

        const head = scored[0];
        const hasLeader = !!(head && head.value !== null);

        const stocks = scored.map(function(x, i) {
            // 题材判据的唯一入参形状（展示与「无题材」判定【共用同一份输入】，口径不可能分叉）
            const topicInput = { stock: x.row.stock, topics: x.row.topicsText };
            const base = {
                stock: x.row.stock,
                code: x.row.code || '',
                // 全题材展示文本（英文逗号分隔，无题材 → '-'）：经 topic-sort.js#getStockTopicsDisplay
                // 归一 —— 与早盘竞价看板「题材单元格」同一口径。为什么必须用英文逗号：全角「，」
                // 宽约一个汉字，一票多题材时白占近半行；英文「,」只有半宽，宽度全留给题材列。
                topicsDisplay: getStockTopicsDisplay(topicInput),
                // 是否【有题材】= 同一次 getStockTopicArr 的非空判定 —— 与上面的 '-' 显示同源：
                // topicsDisplay === '-' ⇔ hasTopic === false，绝不自造第二套「无题材」口径。
                hasTopic: getStockTopicArr(topicInput).length > 0,
                seq: i + 1,
                isLeader: hasLeader && i === 0
            };
            base[metricKey] = x.value;
            if (metricDaysKey) base[metricDaysKey] = x.days;
            const extra = extraOf ? extraOf(x.row) : null;
            return extra ? Object.assign(base, extra) : base;
        });

        out.push({
            topic: b.topic,
            count: stocks.length,
            hasLeader: hasLeader,
            leaderStock: hasLeader ? String(head.row.stock || '') : '',
            leaderMetric: hasLeader ? head.value : null,
            leaderDays: hasLeader ? head.days : 0,
            stocks: stocks
        });
    });

    return out;
}

/**
 * 按谓词裁行（共享核心）：块内只保留 keep(stockItem) 为真的行；裁完变空的分块直接丢弃。
 *
 * 规则（全部是「结构不变、只裁行」的纯变换，不改动入参）：
 *   · 序号在【裁完后的行集合】上从 1 重排 —— 截图上序号连续，不留空洞；
 *   · ⛔ 裁完后【一律不选龙头】：龙头是「某题材内度量最高」的派生概念，
 *     被裁过的行已不构成原来的度量排名，保留龙头标会凭空造出一个错误的题材结论；
 *   · 分块 count 同步为裁完后的行数（题材条上的「N只」与真实可见行数一致）。
 *
 * @param {Array<object>} blocks buildTopicBlocks 的输出
 * @param {(stockItem:object)=>boolean} keep
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterBlocksBy(blocks, keep) {
    const list = Array.isArray(blocks) ? blocks : [];
    const pred = typeof keep === 'function' ? keep : function() { return true; };
    const out = [];
    list.forEach(function(b) {
        if (!b) return;
        const rows = (b.stocks || []).filter(function(s) { return s && pred(s); });
        if (rows.length === 0) return;
        out.push(Object.assign({}, b, {
            count: rows.length,
            hasLeader: false,
            leaderStock: '',
            leaderMetric: null,
            leaderDays: 0,
            stocks: rows.map(function(s, i) {
                return Object.assign({}, s, { seq: i + 1, isLeader: false });
            })
        }));
    });
    return out;
}

/**
 * 「无题材」视图过滤（两个看板共用同一判据）：只留 `hasTopic === false` 的行。
 * @param {Array<object>} blocks buildTopicBlocks 的输出
 * @returns {Array<object>}
 */
export function filterNoTopicBlocks(blocks) {
    return filterBlocksBy(blocks, function(s) { return !s.hasTopic; });
}

// ============================================================================
// 二、手动粘贴导入题材的解析（两个看板共享同一个导入入口 ⇒ 同一套解析规则）
// ============================================================================

/**
 * 解析「手动粘贴导入题材」的文本（纯函数）。
 *
 * 规则：
 *   · 每行 = `股票名 [代码] 题材1 题材2 ...`；代码（6 位）可出现在任意位置，会被摘出来；
 *   · 同一只股票出现多行 → 题材合并去重（不覆盖）；
 *   · 题材一律过 isValidTopic（剔掉 `题材33` / 纯数字 / 单字 / `其它` 等无效值）；
 *   · 只有股票名、没有任何有效题材的行 → 计入 skipped（不写库，避免用空值抹掉库里已有题材）。
 *
 * ⚠️ 写入的是【共享题材库 stock_topics】：与早盘竞价看板同一个库，两个看板天然互通。
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

// ============================================================================
// 三、封单额展示（两个看板共用同一口径）
// ============================================================================

/**
 * 封单额展示（亿元 / 万元）。
 *   · 无值或 0 → ''（⛔ 不显示 "0亿"，那会让人以为「封单为 0」而非「没有这个数据」）
 *   · ≥1 亿     → '3.20亿'
 *   · <1 亿     → '3200万'
 * @param {number|null} money 元
 * @returns {string}
 */
export function formatSealMoney(money) {
    if (money === null || money === undefined || !isFinite(money) || money === 0) return '';
    const yi = money / 1e8;
    if (Math.abs(yi) >= 1) return yi.toFixed(2) + '亿';
    return (money / 1e4).toFixed(0) + '万';
}
