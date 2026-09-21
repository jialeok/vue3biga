// model.js — 「涨跌停」看板的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「数据 → 展示结构」的纯变换：不读 state、不发请求、不碰 DOM、不写库。
// 由 logic/limitpool/limit-pool.js（编排层）把数据准备好后调用，单测见 model.test.js。
//
// 【本文件与「竞价一字」看板的关系】
//   「按题材分块 / 组序 / 块内排序 / 选龙头 / 序号 / 题材展示与『无题材』判据 / 粘贴解析 / 封单额格式化」
//   这套规则两个看板【完全一样】，已抽到共享核心 logic/topics/topic-block.js（§6 单一真相）。
//   本文件只保留【涨跌停看板特有】的东西：
//     · 块内排序度量 = 十日涨幅（rangePct）
//     · 十日涨幅展示口径 / 涨跌色
//   并对外保持原函数签名与输出字段名（rangePct / rangeDays / leaderPct），
//   使 UI 与既有单测零改动。⛔ 不要在这里重新实现分块逻辑。
//
// 复用自既有的单一真相：
//   · 组序     = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」同一套组序规则）
//   · 题材文本 = topic-sort.js#getStockTopicsDisplay（与竞价看板题材单元格同口径）

import {
    OTHER_TOPIC,
    buildTopicBlocks as buildTopicBlocksCore,
    filterNoTopicBlocks as filterNoTopicBlocksCore,
    parseTopicPaste,
    formatSealMoney
} from '../topics/topic-block.js';

// 十日涨幅展示口径（文本 / 涨跌方向）的唯一实现在 logic/auction/range-display.js，
// 与「竞价一字」看板共用（§6 单一真相）；此处直通再导出，使既有 import 路径零改动。
import { formatRangePct, rangeTone } from '../auction/range-display.js';

// 共享核心的直通导出（签名与语义都在共享模块里定义）
export { OTHER_TOPIC, parseTopicPaste, formatSealMoney, formatRangePct, rangeTone };

/**
 * 把一行池数据 + 十日涨幅，按题材切成「看板分块」结构。
 *
 * 实现 = 共享核心 buildTopicBlocks，度量字段名绑定为 rangePct / rangeDays。
 *
 * @param {object[]} rows 池行（含 stock/code/continueText/... 展示字段，题材原始文本在 topicsText）
 * @param {Map<string,string>} primaryMap 整表分类结果（getPrimaryTopicMap）
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @param {(row:object)=>({pct:number|null, days:number}|null)} rangePctOf 十日涨幅取值
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string,
 *   leaderPct:number|null, leaderDays:number, stocks:Array<object>}>}
 */
export function buildTopicBlocks(rows, primaryMap, fallbackFn, rangePctOf) {
    const blocks = buildTopicBlocksCore(rows, {
        primaryMap: primaryMap,
        fallbackFn: fallbackFn,
        metricOf: rangePctOf,
        metricKey: 'rangePct',
        metricDaysKey: 'rangeDays',
        extraOf: function(row) {
            return {
                changePct: row.changePct || '',
                continueText: row.continueText || '',
                reason: row.reason || '',
                limitTime: row.limitTime || '',
                sealMoney: row.sealMoney === null || row.sealMoney === undefined ? null : row.sealMoney,
                // ★ 2026-09-22 需求 2：竞价就涨停 'up' → 股票名下方实心红线；竞价就跌停 'down' → 实心绿线。
                //   由 Logic 编排层（limit-pool.js ⑥-c）按 market_metrics 的竞价涨幅算好，本层只透传。
                //   ⛔ null / undefined = 没打到板价【或没有竞价涨幅数据】→ 模板一律不标记，
                //      绝不当成 'up'/'down'（§10 无数据 ≠ 没有）。
                aucLimit: row.aucLimit || null
            };
        }
    });
    // 兼容既有字段名：leaderPct = 龙头股的十日涨幅（被 _signature 与既有调用读取）
    blocks.forEach(function(b) { b.leaderPct = b.leaderMetric; });
    return blocks;
}

/**
 * 「无题材」视图过滤（纯函数）：只留没有题材的股票（供人工统一补题材时截图）。
 *
 * 规则见共享核心 topics/topic-block.js#filterBlocksBy（裁行 / 序号重排 / 视图下不选龙头 / count 同步）。
 * 这里额外把 leaderPct 一并归零，保持与 buildTopicBlocks 的输出字段名一致。
 *
 * @param {Array<object>} blocks buildTopicBlocks 的输出
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterNoTopicBlocks(blocks) {
    const out = filterNoTopicBlocksCore(blocks);
    out.forEach(function(b) { b.leaderPct = null; });
    return out;
}

// formatRangePct / rangeTone 已抽到 logic/auction/range-display.js（见上方 import 的直通再导出）。
