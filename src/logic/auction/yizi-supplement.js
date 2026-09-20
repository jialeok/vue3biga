// yizi-supplement.js — 「早盘竞价看板 · 补竞价一字（按题材融入）」的 Logic 层（纯函数叶子，§15 独立业务模块）
//
// ⚠️ 2026-09-20 修正记录（上一版实现按用户反馈推翻重做）：
//   上一版把一字看板的题材分块【整块】追加在列表末尾（底部一大段「竞价一字补充」区）。
//   用户反馈：「不是这么补……竞价一字的股票会补充到【已经分好类的题材当中去】，
//   比如中材科技是通信/化工题材，补充后和西陇科学（化工）一起……相当于把竞价一字的股票
//   按照题材分类【融入】到原来的早盘竞价列表中，并标注哪些是补进去的，有个小标记，
//   如果遇到重复的，就不用融进去了……而不是整块放进去，修正下。」
//   ⇒ 本版语义：**按题材并入早盘竞价已有题材组的【组内末尾】**（详见下方逐条口径）。
//
// 需求口径（逐条对应实现，⛔ 改动前先读一遍）：
//   ① 只在「题材 toggle【单独】开启 + 补竞价一字开关打开」时生效；关掉开关立刻恢复原样；
//   ② 【融入】而不是整块追加：一字股落进早盘竞价【同一题材组】的组内末尾，与原股票排在一起；
//   ③ 融入判据 = 一字股的任一题材命中该题材组的组名 → 进该组；命中多个组就分别进
//      （如华软科技「芯片,化工」→ 芯片组、化工组各出现一次；中材科技「通信,化工」→ 化工组能见到它）；
//   ④ 重复的不融：股票名已在早盘竞价列表里 → 整只跳过（列表本身就有这只票，不重复列）；
//   ⑤ 补入的行带【小标记】：显示行上有 `mergedTopic`（被并入的组名），模板据此渲染「补」标与悬停说明；
//   ⑥ 组序⛔ 不变：沿用早盘竞价列表自己的组序（= 一字最多的题材排最前，由 sortByTopicGroups 产出），
//      本模块只做「组内追加」，一根手指都不碰组顺序、不碰原有行顺序；
//   ⑦ 字段只搬运不重算：序号 / 龙头 / 十日涨幅 / 连板 / 封单额全部沿用竞价一字看板已算好的口径；
//   ⑧ 一字股的题材在当日列表里【一个组都没命中】→ 无处可融 → 收进「未并入」尾段（isOrphan）。
//      ⛔ 绝不静默丢弃：本功能的意义正是「看哪个题材的一字多」，藏掉几只等于给用户一个错误结论（§10）。
//
// 架构位置（§2 依赖方向 UI → Logic → Data）：
//   UI（AuctionBoardTable.vue 的融入序列渲染 + components/AuctionYiziSupplement*.vue）
//     → composables/useAuctionYiziSupplement.js（UI/VM 状态：开关态 / 展开态 / 曲线 / 文案）
//     → 本模块（**纯函数**：把「一字题材分块」按题材融进「早盘竞价题材序列」）
//     → logic/yizi/yizi-board.js（既有单一真相：auction_yizi 的题材分块结果）
//
// 【边界 —— 本模块刻意什么都不碰】
//   · ⛔ 不读、不写 auction_watchlist / market_metrics / 早盘竞价的任何内存缓存与排序状态；
//   · ⛔ 不写任何表（本功能全程零写入，纯展示，§10/§11 无风险面）；
//   · ⛔ 不自算题材、不自算十日涨幅、不自选龙头 —— 只做「既有字段 → 显示对象」的搬运。
//
// 【题材判据为什么必须是同一份（§6 单一真相）】
//   两边组名都是【核心词名】：早盘竞价侧来自 topic-sort.js#getPrimaryTopicMap（本模块读行的
//   `groupTopic`，那是 Logic 层已算好的既成事实），一字侧来自 buildTopicBlocks 的 block.topic。
//   一字股「有哪些题材」则复用同一套核心词匹配 topic/rules.js#matchTopicToCore
//   （与早盘竞价看板、竞价一字看板的题材归类同一个函数），⛔ 绝不在这里另造第二套题材匹配。

import { OTHER_TOPIC } from '../topics/topic-block.js';
import { matchTopicToCore } from '../topic/rules.js';

/**
 * 归一化「排除名单」（= 早盘竞价当前列表里的股票名）。
 * 只为去重比较用：字符串化 + trim；空名丢弃；接受 Set / Array（其它一律当空）。
 * @param {Set<string>|string[]|null|undefined} names
 * @returns {Set<string>}
 */
function _toNameSet(names) {
    const set = new Set();
    if (names instanceof Set) {
        names.forEach(function(n) { _addName(set, n); });
        return set;
    }
    if (Array.isArray(names)) {
        names.forEach(function(n) { _addName(set, n); });
        return set;
    }
    return set;
}

function _addName(set, n) {
    const s = String(n === null || n === undefined ? '' : n).trim();
    if (s) set.add(s);
}

/**
 * 一字股的「核心题材集合」（供与题材组名做相等匹配）。
 *
 * ⚠️ 复用 topic/rules.js#matchTopicToCore —— 与早盘竞价看板 / 竞价一字看板归类题材用的是
 *    同一个函数、同一份「可分组核心词」，因此这里得到的名字与两边的组名【天然同名】。
 *
 * @param {string} topicsDisplay 一字行的全题材展示文本（英文逗号分隔；'-' = 无题材）
 * @param {Array<{name:string, synonyms?:string[]}>} coreTopics 可分组核心词（topic/rules.js#getGroupableCoreTopics）
 * @returns {Set<string>}
 */
function _coreSetOf(topicsDisplay, coreTopics) {
    const set = new Set();
    if (!coreTopics || coreTopics.length === 0) return set;
    const txt = String(topicsDisplay === null || topicsDisplay === undefined ? '' : topicsDisplay).trim();
    if (!txt || txt === '-') return set;
    txt.split(',').forEach(function(t) {
        const name = t.trim();
        if (!name) return;
        matchTopicToCore(name, coreTopics).forEach(function(core) { set.add(core); });
    });
    return set;
}

/**
 * 一字看板的一行 → 补入行（只搬运，⛔ 不重算任何口径）。
 *
 * ⚠️ `seq` 刻意**沿用一字看板块内序号**（= 该题材内十日涨幅排名），被排除/被截断的行不重排后面行的号：
 *    排名是「谁的十日涨幅更高」这个事实，重排会把它伪造成「1、2、3…」的连续假排名。
 *    因此补入行里序号可能出现「3、5」这样的跳号 —— 这是真实排名，不是丢行。
 *
 * @param {object} s 一字看板 blocks[].stocks[] 的一行
 * @param {string} name 归一化后的股票名
 * @param {number} fallbackSeq 无 seq 时的行序回退值（该行在其题材块内的位置，1 起）
 * @param {string} mergedTopic 被并入的早盘竞价题材组名（'' = 未并入尾段）
 * @returns {object}
 */
function _toDisplayRow(s, name, fallbackSeq, mergedTopic) {
    const seq = Number(s.seq);
    return {
        stock: name,
        // 序号 = 该题材内十日涨幅排名（缺值时按行序回退，绝不留空序号）
        seq: (isFinite(seq) && seq > 0) ? seq : fallbackSeq,
        // ★ 被并入哪一组（模板据此渲染「补」标与悬停说明；'' = 该股题材不在当日列表里，落在尾段）
        mergedTopic: mergedTopic || '',
        topicsDisplay: s.topicsDisplay || '-',
        // 龙头 = 该题材块内十日涨幅最高者（一字看板已选好，⛔ 这里不重选）
        isLeader: !!s.isLeader,
        continueText: s.continueText || '',
        // 十日涨幅：行内既有字段（文本 + 色调档），⛔ 不在这里重算区间涨幅
        rangeText: s.rangeText || '',
        rangeTone: s.rangeTone || 'flat',
        // 封单额（9:20 口径，= 一字看板的默认口径）+ 色调档
        seal920Text: s.seal920Text || '',
        seal920Tone: s.seal920Tone || 'flat',
        // 封单额 9:25 相对 9:20 的变化量（供悬停提示；行内只显示 9:20 口径）
        sealDeltaText: s.sealDeltaText || '',
        sealDeltaTone: s.sealDeltaTone || 'flat',
        // 首封时刻（一字看板已降级为悬停提示，这里一并搬运，信息不丢、不占列宽）
        firstTimeText: s.firstTimeText || ''
    };
}

/**
 * 把「竞价一字」按题材【融入】早盘竞价的题材分组序列（纯函数，不改动入参）。
 *
 * 输出结构（供模板逐字段直出，满足 §21 模板不做业务计算）：
 *   `{ segments: [{ key, topic, isOrphan, rows, sups }], stats }`
 *   · `rows` = 早盘竞价【原有行】原样引用（顺序、内容一个字节都不动）；
 *   · `sups` = 该组【补入行】（已排好的显示对象，见 _toDisplayRow）。
 *   模板渲染顺序 = 对每个 segment 先渲染 rows、再渲染 sups；
 *   组与组之间不插任何东西 → 视觉上就是「原列表的每个题材组末尾多了几行带「补」标的行」。
 *
 * ⚠️ 分组切法：只按【相邻行是否同 groupTopic】切「连续段」，不按组名归并。
 *    题材模式下同题材必然连续（view-helpers 的 sortByTopicGroups 保证），这里再按相邻切一次，
 *    即使上游将来改成不连续，结果也只是「同一题材分成两段」（顺序 = 渲染顺序，逐行保真），
 *    ⛔ 绝不会把行挪到别处 —— 本模块对原有行的唯一动作就是「原样透出」。
 *
 * ⚠️ 一字股同名跨块出现（上游分块口径不同时可能）→ 题材集合取并集，只渲染一行。
 *
 * @param {Array<{groupTopic?:string, stock?:string}>} auctionRows
 *        早盘竞价【题材单独开启】时的最终渲染行序列（`filteredRegularItems`，按渲染顺序）。
 *        ⚠️ 每行必须带 `groupTopic`（Logic 层 view-helpers 已赋值）；缺失时按「其它」处理。
 * @param {Array<object>} yiziBlocks 竞价一字看板的题材分块（`yiziBoardState.blocks`），形状：
 *        `[{ topic, count, stocks: [{ stock, seq, topicsDisplay, isLeader, continueText,
 *                                    rangeText, rangeTone, seal920*, sealDelta*, firstTimeText }] }]`
 * @param {{excludeNames?:Set<string>|string[], coreTopics?:Array<object>}} [opts]
 *        excludeNames = 早盘竞价当前列表的股票名（重复的不融）；coreTopics = 可分组核心词。
 * @returns {{segments: Array<object>, stats: {yiziTotal:number, mergedStocks:number,
 *           mergedRows:number, inListCount:number, orphanCount:number}}}
 */
export function mergeYiziIntoAuctionRows(auctionRows, yiziBlocks, opts) {
    const rows = Array.isArray(auctionRows) ? auctionRows : [];
    const blocks = Array.isArray(yiziBlocks) ? yiziBlocks : [];
    const o = opts || {};
    const excluded = _toNameSet(o.excludeNames);
    const coreTopics = Array.isArray(o.coreTopics) ? o.coreTopics : [];

    // ---- 1) 早盘竞价题材分组：按渲染顺序切「连续同 groupTopic」的段 ----
    const segments = [];
    let cur = null;
    rows.forEach(function(r) {
        if (!r) return;
        const topic = String(r.groupTopic || '').trim() || OTHER_TOPIC;
        if (!cur || cur.topic !== topic) {
            cur = { key: 'seg' + segments.length + ':' + topic, topic: topic, isOrphan: false, rows: [], sups: [] };
            segments.push(cur);
        }
        cur.rows.push(r);
    });

    // ---- 2) 一字股候选：跨块去重 + 汇总「该股的核心题材集合」 ----
    const cands = [];
    const byName = new Map();
    blocks.forEach(function(b) {
        if (!b) return;
        const blockTopic = (b.topic && String(b.topic).trim()) || OTHER_TOPIC;
        const list = Array.isArray(b.stocks) ? b.stocks : [];
        list.forEach(function(s, i) {
            if (!s || !s.stock) return;
            const name = String(s.stock).trim();
            if (!name) return;
            const exist = byName.get(name);
            if (exist) {
                // 同名（跨块）：题材取并集，仍只渲染一行
                _coreSetOf(s.topicsDisplay, coreTopics).forEach(function(t) { exist.coreSet.add(t); });
                return;
            }
            const coreSet = _coreSetOf(s.topicsDisplay, coreTopics);
            // 块名（该股在一字看板里的主题材）也计入：它本就是该股的核心题材之一，
            // 计入只是同源加固 —— 即使 topicsDisplay 因上游缺字段而为 '-'，仍能落回它的主题材组。
            if (blockTopic !== OTHER_TOPIC) coreSet.add(blockTopic);
            // 一个核心题材都没匹配到 = 该股在一字看板里本就归「其它」→ 与列表的「其它」组同义。
            // ⚠️ 只在这种情况下才用「其它」兜底：有真题材、只是当日列表里没这个组的股票，
            //    必须进「未并入」尾段（把它混进「其它」会湮掉「它属于哪个题材」这个信息）。
            if (coreSet.size === 0) coreSet.add(OTHER_TOPIC);
            const c = { name: name, row: s, fallbackSeq: i + 1, coreSet: coreSet };
            byName.set(name, c);
            cands.push(c);
        });
    });

    // ---- 3) 融入：逐只一字股按题材命中，追加到对应题材组的【组内末尾】 ----
    // 位置为什么是组内末尾：原有行的顺序 / 序号（seqNo）/ 题材统计条（挂在组内首行）一概不动，
    // 补入行紧随该组原有股票之后 —— 用户要的「和原来的股票一起排」「关闭后恢复原样」。
    const orphans = [];
    let mergedStocks = 0;
    let mergedRows = 0;
    let inListCount = 0;
    cands.forEach(function(c) {
        if (excluded.has(c.name)) { inListCount++; return; }   // 用户口径：列表里已有的不重复融
        let hit = 0;
        segments.forEach(function(seg) {
            if (!c.coreSet.has(seg.topic)) return;
            seg.sups.push(_toDisplayRow(c.row, c.name, c.fallbackSeq, seg.topic));
            hit++;
        });
        if (hit === 0) {
            orphans.push(_toDisplayRow(c.row, c.name, c.fallbackSeq, ''));
            return;
        }
        mergedStocks++;
        mergedRows += hit;
    });

    // ---- 4) 「未并入」尾段（只在真有未并入时才追加，不产生空段） ----
    // 为什么必须显示而不是默默丢掉：本功能存在的意义就是「看哪个题材的一字多」，
    // 藏掉几只 = 给用户一个错误的题材热度结论（§10 不隐藏缺失）。
    if (orphans.length > 0) {
        segments.push({ key: 'orphan', topic: '', isOrphan: true, rows: [], sups: orphans });
    }

    return {
        segments: segments,
        stats: {
            yiziTotal: cands.length,       // 当日一字池只数（按股票名去重后）
            mergedStocks: mergedStocks,    // 真正融进早盘竞价题材组的只数
            mergedRows: mergedRows,        // 融入的行数（多题材各融一次 → 可能大于只数）
            inListCount: inListCount,      // 已在早盘竞价列表中、按口径跳过的只数
            orphanCount: orphans.length    // 题材不在当日列表里、收进尾段的只数
        }
    };
}

/**
 * 融入情况汇总文案（纯函数：§21 格式化在 Logic 层做完，模板只直出）。
 *
 * ⚠️ 「已并入」与「已在列表中」必须分开说：前者是补进来的行，后者是被口径挡掉的票，
 *    混在一起用户无法核对「我列表里那几只一字是不是没被重复列出来」。
 *
 * @param {{yiziTotal?:number, mergedStocks?:number, mergedRows?:number,
 *          inListCount?:number, orphanCount?:number}} stats mergeYiziIntoAuctionRows 的 stats
 * @returns {string} 空串 = 无可说（一字池为空，调用方不渲染该行）
 */
export function formatMergeSummary(stats) {
    const s = stats || {};
    const total = Number(s.yiziTotal) || 0;
    if (total <= 0) return '';
    const merged = Number(s.mergedStocks) || 0;
    const rows = Number(s.mergedRows) || 0;
    const inList = Number(s.inListCount) || 0;
    const orphan = Number(s.orphanCount) || 0;
    const parts = ['一字 ' + total + ' 只', '已并入 ' + merged + ' 只'];
    // 多题材的一字会同时出现在多个组里 → 行数与只数不等，如实说清（否则用户会怀疑重复渲染）
    if (rows > merged) parts.push('多题材合计 ' + rows + ' 行');
    if (inList > 0) parts.push('已在列表中 ' + inList + ' 只');
    if (orphan > 0) parts.push('未并入 ' + orphan + ' 只');
    return parts.join(' · ');
}
