// §P1-6 纯函数抽取（源自 src/views/AuctionBoard.vue）
// 仅收纳展示层「无副作用、不依赖组件实例/响应式状态、输入输出明确」的纯函数：
// 数值/百分比格式化、颜色与状态判定、字符串解析、简单的回退查表等。
// 原 AuctionBoard.vue 改为从本模块 import 同名函数，模板与脚本调用方式不变，行为完全等价。
// 依赖的外部查询函数（getStockHistoryTopics / getTopicRankCountThisWeek）均为确定性只读查询，
// 本模块不引入任何有状态/有副作用逻辑。

import { getStockHistoryTopics } from '../logic/stocks/stocks.js';
import { getTopicRankCountThisWeek } from '../logic/topic/rules.js';

/**
 * 把星数映射为展示符号：<=0 显示 "-"，>=6 显示 "N★"，否则重复 ★。
 * @param {number} starCount
 * @returns {string}
 */
export function getStarSymbols(starCount) {
    if (starCount <= 0) return '-';
    if (starCount >= 6) return starCount + '★';
    return '★'.repeat(starCount);
}

/**
 * 从备注文本里提取第一个百分比（如 "+3.2%"），取不到返回 "-"。
 * @param {string} note
 * @returns {string}
 */
export function extractChangeFromNote(note) {
    if (!note) return '-';
    const m = note.match(/([+-]?\d+\.?\d*%)/);
    return m ? m[1] : '-';
}

/**
 * 计算涨跌幅的展示文本：
 * - 优先用 item.changePct；合法百分比且 |值|<=20 原样显示，否则显示 "-"
 * - 没有 changePct 时回退从 item.note 中提取
 * @param {object} item
 * @returns {string}
 */
export function getChangePctDisplay(item) {
    if (item && item.changePct) {
        if (/^[+-]?\d+\.?\d*%$/.test(item.changePct)) {
            const num = parseFloat(item.changePct);
            if (!isNaN(num) && Math.abs(num) <= 20) return item.changePct;
            return '-';
        }
        return item.changePct;
    }
    return extractChangeFromNote(item ? item.note : '');
}

/**
 * 题材分组是否可展开（某些固定分组不可展开）。
 * @param {string} topic
 * @returns {boolean}
 */
export function canGroupExpand(topic) {
    return topic !== '其它' && topic !== '并购重组';
}

/**
 * 题材名称的固定样式（常量）。
 * @returns {string}
 */
export function getTopicNameStyle() {
    return 'color:#6b7280;font-weight:400;';
}

/**
 * 根据涨跌幅展示文本返回颜色 class。
 * @param {object} stock
 * @returns {string}
 */
export function getChangeClass(stock) {
    const v = getChangePctDisplay(stock);
    if (v.includes('涨停') || (v.startsWith('-') === false && v !== '-')) return 'auction-topic-change auction-change-red';
    if (v.startsWith('-')) return 'auction-topic-change auction-change-green';
    return 'auction-topic-change';
}

/**
 * 题材展示文本：优先用 item.topics，缺省时回退共享题材库（getStockHistoryTopics）。
 * @param {object} stock
 * @returns {string}
 */
export function getTopicsDisplay(stock) {
    let topics = stock.topics ? stock.topics.join(',') : '';
    if (!topics.trim() && stock.stock) {
        const hist = getStockHistoryTopics(stock.stock);
        if (hist) topics = hist.replace(/[()（）]/g, '').replace(/[，、;；]/g, ',');
    }
    const trimmed = topics.replace(/[，、;；]/g, ',').trim();
    return trimmed ? trimmed : '-';
}

/**
 * 把 "YYYY-MM-DD" 压缩为 "M月D" 的短日期展示。
 * @param {string} dateStr
 * @returns {string}
 */
export function formatDateShort(dateStr) {
    const parts = dateStr.split('-');
    return `${parseInt(parts[1])}月${parseInt(parts[2])}`;
}

/**
 * 历史趋势箭头：比较相邻两天的强度/星级，返回 { text, color }（安全对象，供 :style 渲染）。
 * @param {object} dayData
 * @param {object} nextDayData
 * @returns {{text:string, color:string}}
 */
export function getHistoryArrow(dayData, nextDayData) {
    if (!dayData.hasData) return { text: '-', color: '#9ca3af' };
    if (!nextDayData) return { text: '', color: '' };
    const currS = dayData.strength || 0, prevS = nextDayData.strength || 0;
    const currStar = dayData.starCount || 0, prevStar = nextDayData.starCount || 0;
    if (currS > prevS) return { text: '⬆', color: '#ef4444' };
    if (currS < prevS) {
        if (prevS > 70 && prevStar > 0) return { text: '≈', color: '#ef4444' };
        if (prevStar === 0 && currStar > 0) return { text: '⬆', color: '#ef4444' };
        return { text: '⬇', color: '#10b981' };
    }
    return { text: '平', color: '#f97316' };
}

/**
 * 题材本周上榜次数文案（确定性只读查询）。
 * @param {string} topic
 * @returns {string}
 */
export function getRankAppearText(topic) {
    try {
        const cnt = getTopicRankCountThisWeek(topic);
        return cnt > 0 ? ` 上榜${cnt}次` : '';
    } catch (e) { return ''; }
}

/**
 * 统一备注中标点（中文逗号/顿号/分号 -> 英文逗号，全角括号 -> 半角）。
 * @param {string} note
 * @returns {string}
 */
export function _normalizeNotePunct(note) {
    return String(note || '').replace(/[，、;；]/g, ',').replace(/[（]/g, '(').replace(/[）]/g, ')');
}

/**
 * 在基础备注上补全题材（回退共享题材库），返回完整备注文本。
 * @param {object} item
 * @param {string} baseNote
 * @returns {string}
 */
export function _buildFullNoteWithTopics(item, baseNote) {
    let note = _normalizeNotePunct(baseNote);
    if (!note.includes('(') && item && item.stock) {
        try {
            const histTopics = getStockHistoryTopics(item.stock);
            if (histTopics) {
                const cleanTopics = String(histTopics).replace(/[()（）]/g, '').replace(/[，、;；]/g, ',');
                if (cleanTopics.trim()) {
                    const pctMatch = note.match(/^([+-]?\d+\.?\d*%)/);
                    const pct = pctMatch ? pctMatch[1] : (note.replace(/[()（），,]/g, '').trim());
                    note = (pct || '') + '(' + cleanTopics + ')';
                }
            }
        } catch (e) {}
    }
    return note;
}
