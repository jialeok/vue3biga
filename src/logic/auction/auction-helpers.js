// §P1-6 纯函数抽取（源自 src/logic/auction/auction.js）
// 仅收纳「无副作用、不依赖组件实例/响应式状态、输入输出明确」的纯函数。
// 这些函数被 auction.js 内部（importAuctionHistoryFill）以及 app-core.js 复用，
// 原文件保留同名 re-export，故所有调用方行为完全等价、无需改动。
// 严禁把任何有状态/有副作用的逻辑搬入本模块。

/**
 * 解析粘贴文本里的「纯成交量/数字」单元格。
 * - 含「万」时只返回数字部分（如 "123万" -> "123"）
 * - 否则仅当整段为合法数值（可带负号/小数）时原样返回，否则返回 null
 * @param {string} text
 * @returns {string|null}
 */
export function parseVolumeOnlyText(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.includes('万')) {
        const match = trimmed.match(/(-?\d+\.?\d*)\s*万/);
        return match ? match[1] : null;
    }
    const match = trimmed.match(/^-?\d+\.?\d*$/);
    return match ? trimmed : null;
}

/**
 * 把一行历史补录文本切分为 [股票名, ...数字单元格]。
 * 优先按 Tab 切分；否则按空白切分，并从行尾向前识别末尾的数字列作为数值部分。
 * @param {string} line
 * @returns {string[]}
 */
export function splitHistoryFillLine(line) {
    if (line.indexOf('\t') !== -1) {
        return line.split('\t');
    }
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
        return [line.trim()];
    }
    const isNumToken = (t) => parseVolumeOnlyText(t) !== null;
    let splitAt = tokens.length; // 数值列的起始下标
    for (let i = tokens.length - 1; i >= Math.max(1, tokens.length - 2); i--) {
        if (isNumToken(tokens[i])) {
            splitAt = i;
        } else {
            break;
        }
    }
    if (splitAt === tokens.length) {
        // 没有识别到末尾的数字 token，整行当作股票名称
        return [line.trim()];
    }
    const stockName = tokens.slice(0, splitAt).join(' ');
    const numCells = tokens.slice(splitAt);
    return [stockName, ...numCells];
}
