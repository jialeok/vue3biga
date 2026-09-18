// model.js — 「竞价一字」看板的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「数据 → 展示结构」的纯变换：不读 state、不发请求、不碰 DOM、不写库。
// 由 logic/yizi/yizi-board.js（编排层）把数据准备好后调用，单测见 model.test.js。
//
// 【本文件与「涨跌停」看板的关系】
//   「按题材分块 / 组序 / 块内排序 / 选龙头 / 序号 / 题材展示与『无题材』判据 / 粘贴解析 / 封单额格式化」
//   这套规则两个看板【完全一样】，已抽到共享核心 logic/topics/topic-block.js（§6 单一真相）。
//   本文件只保留【竞价一字看板特有】的东西：
//     · 块内排序度量 = 9:25 封单额（sealMoney）
//     · 题材来源优先级解析（接口自带 开盘啦 → 选股宝 → 共享题材库 → 无）
//   并对外保持与涨跌停看板同形的输出字段，使 UI 结构可以基本一致。
//   ⛔ 不要在这里重新实现分块逻辑。
//
// 复用自既有的单一真相（⛔ 不许在这里另造一套）：
//   · 组序     = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」同一套组序规则）
//   · 题材判据 = topic-sort.js#getStockTopicArr / getStockTopicsDisplay（与竞价看板题材单元格同口径）
//   · 题材合法 = note/helpers.js#isValidTopic（剔掉「题材33」/纯数字/单字）

import {
    OTHER_TOPIC,
    buildTopicBlocks as buildTopicBlocksCore,
    filterNoTopicBlocks as filterNoTopicBlocksCore,
    parseTopicPaste,
    formatSealMoney
} from '../topics/topic-block.js';
import { isValidTopic } from '../note/helpers.js';

// 共享核心的直通导出（签名与语义都在共享模块里定义）
export { OTHER_TOPIC, parseTopicPaste, formatSealMoney };

// ============================================================================
// 一、题材来源优先级（竞价一字特有）
// ============================================================================

/**
 * 把一段上游题材文本切成「合法题材数组」。
 *
 * 上游猫抓 daily_auc_fd 的两个题材字段都是【一段文本】（形如 `机器人、人工智能`），
 * 不是数组 → 这里按项目既有的分隔符口径切开，并逐条过 isValidTopic。
 * ⚠️ 分隔符集合与 note/helpers.js#cleanTopicsForDisplay / topic-sort.js 保持一致（多一个 `|` 兜底），
 *    避免同一个题材串在不同路径被切出不同结果。
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function splitThemeText(raw) {
    if (!raw) return [];
    return String(raw)
        .split(/[，、,;；|]/)
        .map(function(t) { return t.trim(); })
        .filter(isValidTopic);
}

/**
 * 解析一只股票最终采用的题材文本（★ 用户指定口径）。
 *
 * 优先级（上一级有题材就不再往下取）：
 *   ① `theme_names_kpl` 开盘啦题材 —— 接口自带，主来源
 *   ② `theme_names_xgb` 选股宝题材 —— 接口自带，次来源
 *   ③ 共享题材库 `stock_topics` —— 手动导入的题材（与涨跌停看板 / 早盘竞价看板同一个库）
 *   ④ 都没有 → `''`（UI 会显示 '-'，并可用「无题材」开关过滤出来统一补）
 *
 * 返回 source 是为了「可解释」：界面上能看出这条题材到底是接口给的还是库里来的，
 * 排查「为什么这只票题材不对」时不必再猜。
 *
 * @param {object} row 库行（含 themeKpl / themeXgb）
 * @param {string} libraryTopics 共享题材库里该股票的题材文本（调用方预取，避免本模块碰数据层）
 * @returns {{text:string, source:'kpl'|'xgb'|'lib'|''}}
 */
export function resolveYiziTopics(row, libraryTopics) {
    const kpl = splitThemeText(row && row.themeKpl);
    if (kpl.length > 0) return { text: kpl.join(','), source: 'kpl' };
    const xgb = splitThemeText(row && row.themeXgb);
    if (xgb.length > 0) return { text: xgb.join(','), source: 'xgb' };
    const lib = splitThemeText(libraryTopics);
    if (lib.length > 0) return { text: lib.join(','), source: 'lib' };
    return { text: '', source: '' };
}

/** 题材来源的展示标签（用于行内小字提示「这条题材哪来的」） */
export function themeSourceLabel(source) {
    if (source === 'kpl') return '开盘啦';
    if (source === 'xgb') return '选股宝';
    if (source === 'lib') return '题材库';
    return '';
}

// ============================================================================
// 二、分块（共享核心 + 竞价一字的度量绑定）
// ============================================================================

/**
 * 把一批一字行切成「看板分块」结构。
 *
 * 实现 = 共享核心 buildTopicBlocks，度量字段名绑定为 `sealMoney`（9:25 封单额，元）。
 * 选龙头 = 题材块内封单额最大者；块内序号 = 封单额排名。
 * （⛔ 无封单额数据的行不参与龙头评选 —— 共享核心已保证：无有效 metric 就不选龙头。）
 *
 * @param {object[]} rows 库行（含 stock/code/sealMoney/aucPct/... 展示字段，题材原始文本在 topicsText）
 * @param {Map<string,string>} primaryMap 整表分类结果（getPrimaryTopicMap）
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string,
 *   leaderSeal:number|null, sealMoney:number|null, stocks:Array<object>}>}
 */
export function buildYiziBlocks(rows, primaryMap, fallbackFn) {
    const blocks = buildTopicBlocksCore(rows, {
        primaryMap: primaryMap,
        fallbackFn: fallbackFn,
        metricOf: function(row) {
            const v = row && row.sealMoney;
            return (v === null || v === undefined || !isFinite(v)) ? null : { pct: Number(v), days: 0 };
        },
        metricKey: 'sealMoney',
        extraOf: function(row) {
            return {
                aucPct: (row && row.aucPct) || '',
                aucTone: aucTone(row && row.aucPct),
                // 封单额展示文本（亿元/万元）在 Logic 层算好，UI 直接渲染（§21 模板不做业务计算）
                sealText: formatSealMoney(row && row.sealMoney),
                sealTone: sealTone(row && row.sealMoney),
                // 封单证据强度：有封单的时点数（0~13）与首次封上时刻
                faCount: (row && row.faCount) ? Number(row.faCount) : 0,
                faFirst: (row && row.faFirst) || '',
                aucTurnover: (row && row.aucTurnover === null) || (row && row.aucTurnover === undefined)
                    ? null : Number(row.aucTurnover),
                themeSource: (row && row.themeSource) || '',
                themeSourceLabel: themeSourceLabel(row && row.themeSource),
                isSt: !!(row && row.isSt),
                // ST 小标：名称里已经写了 ST / *ST 的（A 股绝大多数 ST 股简称自带）就不再挂标，
                // 否则会出现「ST巨轮 [ST]」这种同一信息说两遍的冗余占位。
                stTag: !!(row && row.isSt) && String((row && row.stock) || '').toUpperCase().indexOf('ST') < 0
            };
        }
    });
    // 兼容性字段名：leaderSeal = 龙头股的封单额（与涨跌停看板的 leaderPct 同位置）
    blocks.forEach(function(b) { b.leaderSeal = b.leaderMetric; });
    return blocks;
}

/**
 * 「无题材」视图过滤（纯函数）：只留没有题材的股票（供人工统一补题材时截图）。
 *
 * 规则见共享核心 topics/topic-block.js#filterBlocksBy（裁行 / 序号重排 / 视图下不选龙头 / count 同步）。
 * 这里额外把 leaderSeal 一并归零，保持与 buildYiziBlocks 的输出字段名一致。
 *
 * @param {Array<object>} blocks buildYiziBlocks 的输出
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterYiziNoTopicBlocks(blocks) {
    const out = filterNoTopicBlocksCore(blocks);
    out.forEach(function(b) { b.leaderSeal = null; });
    return out;
}

// ============================================================================
// 三、展示口径（颜色 / 文本）
// ============================================================================

/**
 * 竞价涨幅涨跌方向（用于配色：涨红跌绿，与项目约定一致）。
 * 入参是库内文本口径（形如 '+10.02' / '-3.10' / ''）。
 * @param {string} text
 * @returns {'up'|'down'|'flat'}
 */
export function aucTone(text) {
    const s = String(text === null || text === undefined ? '' : text).trim();
    if (!s) return 'flat';
    const n = parseFloat(s.replace('%', ''));
    if (!isFinite(n)) return 'flat';
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'flat';
}

/**
 * 封单额强弱分档（纯表现，供 UI 选样式类）。
 *   · 无值 / 0 → 'flat'（⛔ 不把「没有这个数据」渲染成「封单弱」）
 *   · ≥ 1 亿   → 'strong'
 *   · 其余     → 'normal'
 * @param {number|null} money 元
 * @returns {'strong'|'normal'|'flat'}
 */
export function sealTone(money) {
    if (money === null || money === undefined || !isFinite(money) || money === 0) return 'flat';
    return Math.abs(money) >= 1e8 ? 'strong' : 'normal';
}

/** 竞价涨幅展示文本（库内已存 '+10.02' 文本口径，这里只做兜底归一） */
export function formatAucPct(text) {
    const s = String(text === null || text === undefined ? '' : text).trim();
    return s || '-';
}

// ============================================================================
// 四、内容指纹（§17：变了才发布）
// ============================================================================

/**
 * 分块内容指纹：只有内容真正变化时才让编排层重放状态，避免无意义重渲染。
 * 选取的字段都是「会影响界面/结论」的字段：题材块序、块大小、龙头、每行的封单额与题材。
 * @param {Array<object>} blocks
 * @param {string} date
 * @returns {string}
 */
export function yiziSignature(blocks, date) {
    const one = function(list) {
        return (list || []).map(function(b) {
            return b.topic + '#' + b.count + '#' + (b.leaderStock || '') + '#' +
                (b.leaderSeal === null || b.leaderSeal === undefined ? '' : b.leaderSeal) +
                '[' + (b.stocks || []).map(function(s) {
                    return s.stock + ':' + (s.sealMoney === null || s.sealMoney === undefined ? '' : s.sealMoney) +
                        ':' + s.topicsDisplay + ':' + s.faCount;
                }).join(',') + ']';
        }).join('||');
    };
    return String(date || '') + '||YIZI||' + one(blocks);
}

// ============================================================================
// 五、看板状态与日期的对齐判据（§26 日期切换 / §23 数据集切换）
// ============================================================================

/**
 * 看板状态里的快照日期，是否与 UI 当前选中的日期一致。
 *
 * 为什么需要这个判据（真实事故形态，2026-09-18 浏览器实测）：
 *   切换日期后，新日期的加载需要一次云端读取。在这个「还没回来」的窗口里，
 *   `yiziBoardState.blocks / count` **仍然是上一天的内容**，而页头日期已经是新的一天。
 *   若直接按 `count > 0` 渲染，就会把【上一天的一字池】当成【这一天的一字池】显示出来
 *   —— 实测出现「页头 09-14、正文却是 09-17 的 129 只」。这比显示「加载中」严重得多：
 *   用户会据此得出「这一页的数据不对」的结论，且看不出是没加载完。
 *
 * 因此：**只有日期对齐时，快照才可被当作这一天的真相**；
 * 日期不对齐一律视为「还没准备好」→ UI 显示加载中，⛔ 绝不显示另一天的行。
 *
 * ⚠️ 与 §10 不冲突：这**不是**把「读取失败」当成「空」——读取失败走 error 分支（保持 throw）；
 *    这里处理的是「数据还没到」这个独立的中间态。
 *
 * @param {string} stateDate   yiziBoardState.date（快照所属日期）
 * @param {string} currentDate uiStore.currentDate（UI 当前选中日期）
 * @returns {boolean} true = 状态属于当前选中日，可渲染
 */
export function isBoardDateAligned(stateDate, currentDate) {
    return !!stateDate && !!currentDate && String(stateDate) === String(currentDate);
}

