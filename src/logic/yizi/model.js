// model.js — 「竞价一字」看板的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「数据 → 展示结构」的纯变换：不读 state、不发请求、不碰 DOM、不写库。
// 由 logic/yizi/yizi-board.js（编排层）把数据准备好后调用，单测见 model.test.js。
//
// 【本文件与「涨跌停」看板的关系】
//   「按题材分块 / 组序 / 块内排序 / 选龙头 / 序号 / 题材展示与『无题材』判据 / 粘贴解析 / 封单额格式化」
//   这套规则两个看板【完全一样】，已抽到共享核心 logic/topics/topic-block.js（§6 单一真相）。
//   本文件只保留【竞价一字看板特有】的东西：
//     · 封单额的【时点口径】（9:20 / 9:25 两档，见下方第二节）
//     · 题材来源优先级解析（接口自带 开盘啦 → 选股宝 → 共享题材库 → 无）
//     · ST 剔除判据
//   块内排序度量与「涨跌停」看板一致 = 十日涨幅（rangePct），由编排层把值挂到行上后透传。
//   ⛔ 不要在这里重新实现分块逻辑。
//
// 复用自既有的单一真相（⛔ 不许在这里另造一套）：
//   · 组序     = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」同一套组序规则）
//   · 题材判据 = topic-sort.js#getStockTopicArr / getStockTopicsDisplay（与竞价看板题材单元格同口径）
//   · 题材合法 = note/helpers.js#isValidTopic（剔掉「题材33」/纯数字/单字）
//   · 十日涨幅 = auction/range-display.js#formatRangePct / rangeTone（与涨跌停看板同口径）

import {
    OTHER_TOPIC,
    buildTopicBlocks as buildTopicBlocksCore,
    filterNoTopicBlocks as filterNoTopicBlocksCore,
    parseTopicPaste,
    formatSealMoney
} from '../topics/topic-block.js';
import { formatRangePct, rangeTone } from '../auction/range-display.js';
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
// 二、封单额的两个时点口径（★ 用户指定：只看 9:20 与 9:25，不要 9:15）
// ============================================================================
//
// 背景（2026-09-18 用真实库数据核过，务必先读）：
//   上游 daily_auc_fd 的 fa_* 只在【该时点存在「匹配价 = 涨停价」的成交】时才有值。
//   实测 09-18 的 121 只一字票里：fa_0925l 非空仅 8 只、fa_0920f 非空 15 只，
//   而 fa_0915 有 92 只 —— 也就是说【绝大多数一字板的封单在 9:15 就定住了，
//   之后到 9:25 之间不再有新成交】，于是 9:20 / 9:25 那两个字段本身是空的。
//
//   ⛔ 因此绝不能把「封单额」直接取成 `fa_0925l` 字面值 —— 那会让 94% 的行显示 '-'。
//   ✅ 正确口径 = 「截至该时点的最后一笔封单额」：
//        · 9:20 口径 = 在 fa_0915…fa_0920f 范围内最后一笔非空
//        · 9:25 口径 = 在 fa_0915…fa_0925l 范围内最后一笔非空（≡ 库里的 seal_money 列）
//      「9:25 封单额」在语义上本来就不是「9:25 那一秒新成交的金额」，而是
//      「9:25 那一刻挂在涨停价上的封单」—— 没有再成交就沿用最近一笔，这才是真实含义。
//
//   顺带满足用户「9:15 的那个数据不要」：fa_0915 不再作为独立展示时点，
//   只在「截至 9:20」的序列里当最后兜底（9:20 之前没再成交的票，其 9:20 值就是 9:15 那笔）。

/** 9:20 时点（含 fa_0920f = 9:20 后首笔） */
export const SEAL_920 = '09:20';
/** 9:25 时点（含 fa_0925l = 9:25 后末笔） */
export const SEAL_925 = '09:25';

/**
 * 解析一个 fa_* 列名 → 时刻 + 后缀。
 *   `fa_0920`  → { time:'09:20', tail:'' }   该时点【前】最后一笔
 *   `fa_0920f` → { time:'09:20', tail:'f' }  该时点【后】第一笔
 *   `fa_0925l` → { time:'09:25', tail:'l' }  该时点【后】最后一笔
 * 解析失败 → null（列名不认识就跳过，⛔ 不猜）。
 * @param {string} col
 * @returns {{time:string, tail:string}|null}
 */
function _parseFaCol(col) {
    const m = /^fa_(\d{2})(\d{2})([a-z]*)$/.exec(String(col || ''));
    if (!m) return null;
    return { time: m[1] + ':' + m[2], tail: m[3] || '' };
}

// 同一时刻多列时的先后：无后缀（该时刻前最后一笔）→ f（该时刻后第一笔）→ l（该时刻后最后一笔）
const TAIL_RANK = { '': 0, 'f': 1, 'l': 2 };

/**
 * 取「截至 hhmm 时刻的最后一笔封单额」（单位：元）。
 *
 * 实现刻意【不依赖列名数组顺序】，只用列名里的时刻 + 后缀判定 ——
 * 这样即使将来上游增删 fa_* 字段，本函数也不会因为「数组顺序变了」而静默算错。
 *
 * @param {object} row 库行（需含 `fa` = { fa_0915: number|null, … }）
 * @param {string} hhmm '09:20' | '09:25'
 * @returns {number|null} 无任何非空证据 → null（⛔ 不伪造 0）
 */
export function sealMoneyAt(row, hhmm) {
    const fa = row && row.fa;
    if (!fa || !hhmm) return null;
    let bestTime = '';
    let bestRank = -1;
    let bestVal = null;
    Object.keys(fa).forEach(function(col) {
        const p = _parseFaCol(col);
        if (!p || p.time > hhmm) return;
        const v = fa[col];
        if (v === null || v === undefined || !isFinite(v)) return;
        const rank = TAIL_RANK[p.tail] === undefined ? 0 : TAIL_RANK[p.tail];
        if (p.time > bestTime || (p.time === bestTime && rank >= bestRank)) {
            bestTime = p.time;
            bestRank = rank;
            bestVal = Number(v);
        }
    });
    return bestVal;
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

// ============================================================================
// 三、ST 剔除（★ 用户指定：竞价一字看板不出现 ST 股票）
// ============================================================================

/** 股票简称里带 ST / *ST 的（A 股绝大多数 ST 股简称自带，作为 is_st 缺失时的兜底） */
const ST_NAME_RE = /^\*?ST/i;

/**
 * 该行是否属于「应剔除的 ST 股票」。
 *
 * 判据 = ① 库内 is_st === true（上游标注，权威）；或 ② 简称自带 ST / *ST。
 * ⚠️ §10：`is_st` 为 null / undefined（上游没给这个字段）**不等于**「不是 ST」，
 *    但也**不等于**「是 ST」→ 这时只认简称判据，绝不无依据地把行剔掉。
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isStStock(row) {
    if (!row) return false;
    if (row.isSt === true) return true;
    const nm = String(row.stock || '').trim();
    return ST_NAME_RE.test(nm);
}

/**
 * 从池行里剔除 ST（纯函数，返回新数组，不改入参）。
 *
 * 放置位置的理由：本表 `auction_yizi` 是【当日快照真相】，ST 行照旧落库、照旧可被其它消费端使用；
 * 「看板不出现 ST」是【展示口径】→ 在 Logic 分块前过滤，而不是在 Data 读取时丢弃（§6 单一真相）。
 *
 * 若过滤后一行不剩，调用方必须把 `stRemoved` 一并呈现（否则用户会以为「当天没有一字」）。
 *
 * @param {object[]} rows
 * @returns {{rows:object[], removed:number}}
 */
export function dropStRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const kept = list.filter(function(r) { return !isStStock(r); });
    return { rows: kept, removed: list.length - kept.length };
}

// ============================================================================
// 四、分块（共享核心 + 竞价一字的度量绑定）
// ============================================================================

/**
 * 把一批一字行切成「看板分块」结构。
 *
 * 实现 = 共享核心 buildTopicBlocks，度量字段名绑定为 `rangePct`（十日涨幅，%）——
 * **与「涨跌停」看板完全同一口径**（用户：「我需要的是十日涨幅计算龙头，和涨跌停的逻辑基本一样」）：
 *   选龙头 = 题材块内十日涨幅最高者；块内序号 = 十日涨幅排名。
 * （⛔ 无十日涨幅数据的行不参与龙头评选 —— 共享核心已保证：无有效 metric 就不选龙头。）
 *
 * ⚠️ 封单额【不参与排序/选龙头】，只作为行内展示列（按「9点20」toggle 切时点）。
 *    这样切 toggle 纯粹换一个显示值，不需要重算分块（§34 展示态与业务数据分离）。
 *
 * @param {object[]} rows 库行（含 stock/code/fa/rangePct/rangeDays/continueText/... ，
 *                          题材原始文本在 topicsText；rangePct/rangeDays 由编排层挂上）
 * @param {Map<string,string>} primaryMap 整表分类结果（getPrimaryTopicMap）
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string,
 *   leaderRangePct:number|null, rangePct:number|null, rangeDays:number, stocks:Array<object>}>}
 */
export function buildYiziBlocks(rows, primaryMap, fallbackFn) {
    const blocks = buildTopicBlocksCore(rows, {
        primaryMap: primaryMap,
        fallbackFn: fallbackFn,
        metricOf: function(row) {
            const v = row && row.rangePct;
            if (v === null || v === undefined || !isFinite(v)) return null;
            return { pct: Number(v), days: isFinite(row.rangeDays) ? Number(row.rangeDays) : 0 };
        },
        metricKey: 'rangePct',
        metricDaysKey: 'rangeDays',
        extraOf: function(row) {
            const s920 = sealMoneyAt(row, SEAL_920);
            const s925 = sealMoneyAt(row, SEAL_925);
            const pct = row && row.rangePct;
            const days = (row && row.rangeDays) || 0;
            return {
                // ---- 封单额：两个时点都算好（文本 + 色调），UI 按 toggle 选一个渲染（§21 模板不做业务计算）
                seal920: s920,
                seal920Text: formatSealMoney(s920),
                seal920Tone: sealTone(s920),
                seal925: s925,
                seal925Text: formatSealMoney(s925),
                seal925Tone: sealTone(s925),
                // ---- 十日涨幅展示（块内排序/龙头判据已由共享核心写入 base.rangePct / base.rangeDays）
                rangeText: formatRangePct(pct, days),
                rangeTone: rangeTone(pct),
                // ---- 连板小标（首板/二板/三板…）：由编排层读涨跌停池 +1 得到；无依据时为空串（模板不渲染）
                continueText: (row && row.continueText) || '',
                // ---- 封单证据强度（仅用于 title 提示，不占列宽）
                faCount: (row && row.faCount) ? Number(row.faCount) : 0,
                faFirst: (row && row.faFirst) || '',
                // ---- 题材来源（可解释性）
                themeSource: (row && row.themeSource) || '',
                themeSourceLabel: themeSourceLabel(row && row.themeSource)
            };
        }
    });
    // 兼容性字段名：leaderRangePct = 龙头股的十日涨幅（与涨跌停看板的 leaderPct 同位置）
    blocks.forEach(function(b) { b.leaderRangePct = b.leaderMetric; });
    return blocks;
}

/**
 * 「无题材」视图过滤（纯函数）：只留没有题材的股票（供人工统一补题材时截图）。
 *
 * 规则见共享核心 topics/topic-block.js#filterBlocksBy（裁行 / 序号重排 / 视图下不选龙头 / count 同步）。
 * 这里额外把 leaderRangePct 一并归零，保持与 buildYiziBlocks 的输出字段名一致。
 *
 * @param {Array<object>} blocks buildYiziBlocks 的输出
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterYiziNoTopicBlocks(blocks) {
    const out = filterNoTopicBlocksCore(blocks);
    out.forEach(function(b) { b.leaderRangePct = null; });
    return out;
}

// ============================================================================
// 五、内容指纹（§17：变了才发布）
// ============================================================================

/**
 * 分块内容指纹：只有内容真正变化时才让编排层重放状态，避免无意义重渲染。
 * 选取的字段都是「会影响界面/结论」的字段：题材块序、块大小、龙头、每行的十日涨幅/连板/题材。
 * ⚠️ 两个时点的封单额都要进指纹：任一变化都必须重放（否则切 toggle 会看到陈旧值）。
 * @param {Array<object>} blocks
 * @param {string} date
 * @returns {string}
 */
export function yiziSignature(blocks, date) {
    const one = function(list) {
        return (list || []).map(function(b) {
            return b.topic + '#' + b.count + '#' + (b.leaderStock || '') + '#' +
                (b.leaderRangePct === null || b.leaderRangePct === undefined ? '' : b.leaderRangePct) +
                '[' + (b.stocks || []).map(function(s) {
                    return s.stock + ':' + (s.rangePct === null || s.rangePct === undefined ? '' : s.rangePct) +
                        ':' + (s.continueText || '') +
                        ':' + (s.seal920 === null || s.seal920 === undefined ? '' : s.seal920) +
                        ':' + (s.seal925 === null || s.seal925 === undefined ? '' : s.seal925) +
                        ':' + s.topicsDisplay;
                }).join(',') + ']';
        }).join('||');
    };
    return String(date || '') + '||YIZI||' + one(blocks);
}

// ============================================================================
// 六、看板状态与日期的对齐判据（§26 日期切换 / §23 数据集切换）
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
