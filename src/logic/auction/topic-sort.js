// topic-sort.js — 题材 toggle 专用排序/展示纯函数（§15 独立业务模块）
//
// 题材 toggle 是「联动辅助 toggle」：配合竞昨/竞昨占比/三天竞跌等主排序 toggle 使用，
// 在主排序完成后按「题材数量」做稳定叠加排序（题材多的排前，同数量内保持主排序顺序）。
// 本模块只含纯函数，无副作用、不依赖响应式状态，供 view-helpers.js 排序分支与 _enrichAuctionItem 调用。

import { extractTopics, getDisplayNote } from '../note/helpers.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';

/**
 * 取单只股票的题材数组。
 * 优先从 note 括号提取（extractTopics），其次从 item.topics（字符串或数组）解析，
 * 最后回退共享题材库 getStockHistoryTopics。
 * @param {object} item - auctionList 行对象（含 stock/note/topics 等字段）
 * @returns {string[]} 题材数组（已去重过滤，可能为空）
 */
export function getStockTopicArr(item) {
    if (!item) return [];
    const note = getDisplayNote(item);
    let arr = extractTopics(note);
    if (arr.length === 0 && item.topics) {
        const topicsStr = Array.isArray(item.topics) ? item.topics.join(',') : String(item.topics);
        arr = topicsStr.split(/[，、,;；]/).map(t => t.trim()).filter(t => t.length >= 2);
    }
    if (arr.length === 0 && item.stock) {
        const hist = getStockHistoryTopics(item.stock.trim());
        if (hist) {
            arr = hist.replace(/[()（）]/g, '').split(/[，、,;；]/).map(t => t.trim()).filter(t => t.length >= 2);
        }
    }
    return arr;
}

/**
 * 单只股票的题材数量（供排序使用）。
 * @param {object} item
 * @returns {number}
 */
export function getStockTopicCount(item) {
    return getStockTopicArr(item).length;
}

/**
 * 题材展示文本（逗号分隔，无题材返回 '-'）。
 * @param {object} item
 * @returns {string}
 */
export function getStockTopicsDisplay(item) {
    const arr = getStockTopicArr(item);
    return arr.length > 0 ? arr.join(',') : '-';
}

// === 题材 toggle 分组排序：复用「第二页题材分类」(getTopicGroups) 的同一套核心词匹配口径 ===
// 旧实现的坑：sortByTopicCountStable / sortByTopicWithinTiers 按「单只股票拥有的题材【数量】」排序
// （一只股有 3 个题材就排前面），与用户要的「题材【分组】」完全不是一回事。
// 新实现按「题材分组」排序：属于同一题材的股票聚到一起，哪个题材股票多哪个排前面，
// "其它"(无题材 / 未匹配核心词 / 组<2只) 一律置底；主排序档位(tier)顺序不变——高光/达标档(tier0)整体在最上。

import { getTopicGroups, getCoreTopics, matchTopicToCore } from '../topic/rules.js';

/**
 * 取「股票名 → 主题材」映射，复用第二页 getTopicGroups 的分类结果。
 * 一只股票可能同时命中多个核心题材（被分入多个组），这里取它在分组数组里【第一次出现】的组为主题材，
 * 保证首页排序时每只股票只落在一个题材组里（首页是单列，无法像第二页那样同时出现在多个分节）。
 * @param {object[]} auctionList - 当日完整列表（getTodayGroupList 返回，与第二页一致）
 * @returns {Map<string,string>} stockName(trim) → 主题材(core name 或 '其它')
 */
export function getPrimaryTopicMap(auctionList) {
    const map = new Map();
    if (!auctionList || auctionList.length === 0) return map;
    const groups = getTopicGroups(auctionList);
    for (const g of groups) {
        if (!g.stocks) continue;
        for (const s of g.stocks) {
            const nm = s && s.stock ? String(s.stock).trim() : '';
            if (nm && !map.has(nm)) map.set(nm, g.topic);
        }
    }
    return map;
}

/**
 * 单只股票的主题材（兜底分类）：用于不在 auctionList 内的注入行（如观察组壳行）。
 * 按核心词匹配，取第一个命中的核心词为主题材；无题材/未命中 → '其它'。
 * 与第一页 getTopicGroups 的多组归并口径一致（都走 matchTopicToCore）。
 * @param {object} item
 * @returns {string}
 */
export function classifyStockPrimaryTopic(item) {
    const topics = getStockTopicArr(item);
    if (topics.length === 0) return '其它';
    const cores = getCoreTopics();
    for (const topic of topics) {
        const matched = matchTopicToCore(topic, cores);
        if (matched && matched.length > 0) return matched[0];
    }
    return '其它';
}

/**
 * 题材分组叠加排序（核心修复逻辑）。
 * 在各主排序档位(tier)内部，按「题材分组」重排：
 *   - 取出本档位内每只股票的主题材(primaryTopicOf)；
 *   - 统计本档位内各题材组的股票数，按【组大小降序】排列题材组；
 *   - "其它"组永远排在本档位最末；
 *   - 同一题材组内部，保持主排序的相对顺序(pos 兜底，稳定)。
 * 档位(tier)顺序本身不变：tier0(高光/达标)整体在最上，tier1/tier2 依次在后。
 *
 * @param {number[]} renderOrder - 主排序后的索引数组（已分好档位）
 * @param {object[]} renderList - 完整行列表
 * @param {(idx:number)=>number} tierFn - 给定 renderList 索引，返回主排序档位(0=最高档)
 * @param {(idx:number)=>string} primaryTopicOf - 给定 renderList 索引，返回主题材(与第二页分类一致)
 * @returns {number[]} 重排后的索引数组
 */
export function sortByTopicGroups(renderOrder, renderList, tierFn, primaryTopicOf) {
    if (!renderOrder || renderOrder.length === 0) return renderOrder;
    if (typeof tierFn !== 'function' || typeof primaryTopicOf !== 'function') return renderOrder;

    // 1) 按档位分组
    const tierGroups = new Map();
    renderOrder.forEach((idx, pos) => {
        const t = tierFn(idx);
        if (!tierGroups.has(t)) tierGroups.set(t, []);
        tierGroups.get(t).push({ idx, pos, topic: primaryTopicOf(idx) });
    });

    const out = [];
    // 2) 档位从小到大（tier0 在最上）
    [...tierGroups.keys()].sort((a, b) => a - b).forEach(t => {
        const arr = tierGroups.get(t);
        // 本档位内各题材组的股票数
        const sizeMap = new Map();
        for (const x of arr) sizeMap.set(x.topic, (sizeMap.get(x.topic) || 0) + 1);
        // 题材组去重后排序：真实题材按组大小降序；"其它"永远最末
        const topics = [...new Set(arr.map(x => x.topic))];
        topics.sort((a, b) => {
            if (a === '其它') return 1;
            if (b === '其它') return -1;
            const d = (sizeMap.get(b) || 0) - (sizeMap.get(a) || 0);
            if (d !== 0) return d;
            return a < b ? -1 : (a > b ? 1 : 0);
        });
        // 3) 按题材组顺序输出，组内保持主排序相对顺序（稳定）
        for (const tp of topics) {
            for (const x of arr) {
                if (x.topic === tp) out.push(x.idx);
            }
        }
    });
    return out;
}

// === 题材背景配色（纯表现层，仅题材 toggle 下使用）===
// 非常浅的同类色：不同题材分配不同浅色，让同一题材聚在一起时形成统一浅色带，视觉更清晰。
// 仅对「成员数 >= minCount」的真实题材上色；"其它"(无题材/未匹配核心词/组<2只) 与不足 minCount 的题材不上色。
const TOPIC_BG_PALETTE = [
    '#ffe3e3', // 浅红
    '#fff4d6', // 浅黄
    '#e3f5d6', // 浅绿
    '#d6ecff', // 浅蓝
    '#f3e1ff', // 浅紫
    '#ffe1ef', // 浅粉
    '#dffaf3', // 浅青
    '#f7e1d6', // 浅橙
    '#e6e1ff', // 薰衣草
    '#e1fff0', // 薄荷
    '#fff0e1', // 蜜桃
    '#d9f2ff', // 天蓝
    '#ffe9d6', // 杏色
    '#eef0d6'  // 橄榄
];

/**
 * 题材背景色映射：给定「股票名 → 主题材」映射，仅对成员数 >= minCount 的【真实题材】分配浅色背景。
 * "其它" 与 成员不足 minCount 的题材不上色（Map 中不存在该 key，UI 取到即空）。
 * 组越大的题材分配越靠前的调色板颜色（区分度更高）；同大小时按题材名稳定排序，保证每次渲染颜色一致。
 *
 * 该映射属于纯表现数据，由 Logic 层算好后随 item 透出给 UI（§15 独立业务模块，不污染业务数据）。
 *
 * @param {Map<string,string>} primaryTopicMap - stockName(trim) → 主题材（来自 getPrimaryTopicMap）
 * @param {number} minCount - 题材成员最小数（默认 2，即「两只以上才标记」）
 * @returns {Map<string,string>} 题材名(core) → 浅色背景（'其它'/不足 minCount 的不在 Map 中）
 */
export function buildTopicColorMap(primaryTopicMap, minCount = 2) {
    const counts = new Map();
    if (primaryTopicMap) {
        for (const topic of primaryTopicMap.values()) {
            counts.set(topic, (counts.get(topic) || 0) + 1);
        }
    }
    const eligible = [...counts.entries()]
        .filter(([topic, c]) => topic !== '其它' && c >= minCount)
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const map = new Map();
    eligible.forEach(([topic], i) => {
        map.set(topic, TOPIC_BG_PALETTE[i % TOPIC_BG_PALETTE.length]);
    });
    return map;
}