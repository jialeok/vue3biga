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

/**
 * 稳定叠加排序：按题材数量降序，同数量保持原顺序（pos 兜底）。
 * 在主排序 renderOrder 基础上做二次排序，不破坏同数量内的主排序结果。
 * @param {number[]} renderOrder - 主排序后的索引数组
 * @param {object[]} renderList - 完整行列表（renderOrder 的索引指向此数组）
 * @returns {number[]} 重排后的索引数组
 */
export function sortByTopicCountStable(renderOrder, renderList) {
    if (!renderOrder || renderOrder.length === 0) return renderOrder;
    return renderOrder.map((idx, pos) => ({
        idx: idx,
        pos: pos,
        count: getStockTopicCount(renderList[idx])
    })).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.pos - b.pos;
    }).map(x => x.idx);
}