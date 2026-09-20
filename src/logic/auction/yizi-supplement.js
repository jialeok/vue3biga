// yizi-supplement.js — 「早盘竞价看板 · 补竞价一字」的 Logic 层（纯函数叶子，§15 独立业务模块）
//
// 需求（用户原话要点）：
//   · 早盘竞价看板「单独题材 toggle」打开后，在顶部表头（序号 / 股票名称 / 题材 / X）的 X 位
//     加一个「补竞价一字」开关（默认关）；
//   · 打开 → 把「竞价一字」看板的一字板股票【按题材分类】补充到下面股票列表里（UI 显示格式相同），
//     有趋势图、点序号能展开，也能收起；
//   · 组序 = 「一字最多的题材排最前」（就是早盘竞价看板现有的逻辑）；
//   · 关掉 → 恢复成「只开题材 toggle」的原样；
//   · 🔴 只是显示层：⛔ 不动早盘竞价的数据层与逻辑，两看板数据互不干扰。
//
// 架构位置（§2 依赖方向 UI → Logic → Data）：
//   UI（components/AuctionYiziSupplement*.vue）
//     → composables/useAuctionYiziSupplement.js（UI/VM 状态：开关态 / 展开态 / 曲线）
//     → 本模块（**纯函数**：把一字看板的题材分块映射成「补充区显示分组」）
//     → logic/yizi/yizi-board.js（既有单一真相：auction_yizi 的题材分块结果）
//
// 【边界 —— 本模块刻意什么都不碰】
//   · ⛔ 不读、不写 auction_watchlist / market_metrics / 早盘竞价的任何内存缓存；
//   · ⛔ 不写任何表（本功能全程零写入，纯展示，§10/§11 无风险面）；
//   · ⛔ 不自算题材、不自算十日涨幅、不自选龙头 —— 只做「既有字段 → 显示对象」的搬运，
//        口径全部沿用竞价一字看板（§6 单一真相，绝不在早盘竞价这侧另立第二套）。
//
// 【组序 = 用户要求「按一字最多的排在前面」】
//   一字池里**每一行都是竞价一字** ⇒ 「该题材的一字只数」恒等于「该题材的组大小」。
//   因此「组大者居前、同大小按题材名、『其它』置底」这条规则同时满足两个要求：
//     ① 一字最多的题材排最前（用户要的）；
//     ② 与早盘竞价看板「题材 toggle」的组序逐字一致（同一个纯函数 sortByTopicGroups）。
//   竞价一字看板自己的分块已经这么排了（topics/topic-block.js#buildTopicBlocks →
//   topic-sort.js#sortByTopicGroups），这里**再显式排一次**：把这条需求写进代码本身，
//   ⛔ 不依赖「上游顺序将来不会变」这种假设（上游一旦改成别的顺序，这里仍然正确）。
//
// 【为什么要有「已在列表中」这一层（★ 本模块唯一稍微绕的地方）】
//   用户同时提了两个要求，天然有张力：
//     (a)「补充的竞价一字股票不是列表中[早盘竞价列表]的股票」→ 不能重复列出同一只票；
//     (b)「看哪个题材的一字多」→ 每个题材的一字**总只数**必须是真话。
//   若只按 (a) 过滤，某题材 7 只一字里有 5 只已在早盘竞价列表时，那一条会显示成「2只」——
//   用户据此判断「这个题材一字少」就是【错误结论】（本功能存在的意义正是这个判断）。
//   因此：**只数取真实值、行只列出「补充进来的那些」**，并在题材条上把差额如实写出来：
//     · totalCount  = 该题材一字总只数（排序键、题材条上的「N只」）
//     · count       = 补充行数（真正渲染的行）
//     · inListCount = 已在早盘竞价列表中的只数（题材条上如实标注，不藏）
//   ⛔ 绝不为了「行数对得上」而把 totalCount 改小（那是把用户最需要的信息篡改掉）。

import { OTHER_TOPIC } from '../topics/topic-block.js';

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
 * 一字看板的一行 → 补充区的一行（只搬运，⛔ 不重算任何口径）。
 *
 * ⚠️ `seq` 刻意**沿用一字看板块内序号**（= 该题材内十日涨幅排名），被排除的行不重排后面行的号：
 *    排名是「谁的十日涨幅更高」这个事实，重排会把它伪造成「1、2、3…」的连续假排名。
 *    因此补充区里序号可能出现「3、5」这样的跳号 —— 这是真实排名，不是丢行。
 * @param {object} s 一字看板 blocks[].stocks[] 的一行
 * @param {string} name 归一化后的股票名
 * @param {number} fallbackSeq 无 seq 时的行序回退值
 * @returns {object}
 */
function _toDisplayRow(s, name, fallbackSeq) {
    const seq = Number(s.seq);
    return {
        stock: name,
        // 序号 = 该题材内十日涨幅排名（缺值时按行序回退，绝不留空序号）
        seq: (isFinite(seq) && seq > 0) ? seq : fallbackSeq,
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
 * 一字看板的题材分块 → 补充区显示分组（纯函数，不改动入参）。
 *
 * 输入 = `yiziBoardState.blocks`（竞价一字看板的既有产物），形状：
 *   `[{ topic, count, stocks: [{ stock, seq, topicsDisplay, isLeader, continueText,
 *                                rangeText, rangeTone, seal920Text, seal920Tone,
 *                                sealDeltaText, sealDeltaTone, firstTimeText, ... }] }]`
 *
 * 输出 = 显示分组（只保留本功能区真正要渲染的字段，且都已是「可直出」的文本，
 *        满足 §21：模板不做业务计算）：
 *   `[{ topic, totalCount, count, inListCount,
 *       stocks: [{ stock, seq, topicsDisplay, isLeader, continueText,
 *                  rangeText, rangeTone, seal920Text, seal920Tone,
 *                  sealDeltaText, sealDeltaTone, firstTimeText }] }]`
 *
 * 排序：一字总只数（totalCount）降序 → 题材名 → 「其它」恒置底。
 *   ⚠️ 排序键用 totalCount 而不是 count：「哪个题材一字多」问的是总量，
 *      被早盘竞价列表占掉的那几只也照样是这个题材的一字。
 *
 * ⚠️ 一行都没有的块（0 行）会被丢弃；但「有行、只是全都在早盘竞价列表里」的块
 *    **会保留**（count=0 / stocks=[]）—— 题材条照旧显示真实只数，
 *    否则用户会以为这个题材今天没有一字（正是本功能要避免的错误结论）。
 *
 * @param {Array<object>} blocks 一字看板的题材分块
 * @param {{excludeNames?: Set<string>|string[]}} [opts] excludeNames = 早盘竞价当前列表的股票名（用于去重）
 * @returns {Array<{topic:string, totalCount:number, count:number, inListCount:number, stocks:Array<object>}>}
 */
export function buildYiziSupplementGroups(blocks, opts) {
    const list = Array.isArray(blocks) ? blocks : [];
    const excluded = _toNameSet(opts && opts.excludeNames);
    const groups = [];

    list.forEach(function(b) {
        if (!b) return;
        const raw = (b.stocks || []).filter(function(s) {
            return !!(s && s.stock && String(s.stock).trim());
        });
        if (raw.length === 0) return;

        // 块内同名只算一次（防上游重复落行把「一字只数」算多 → 用户看到虚高的题材热度）
        const seen = new Set();
        const rows = [];
        raw.forEach(function(s) {
            const name = String(s.stock).trim();
            if (seen.has(name)) return;
            seen.add(name);
            rows.push({ name: name, row: s });
        });

        const kept = [];
        rows.forEach(function(x, i) {
            if (excluded.has(x.name)) return;
            kept.push(_toDisplayRow(x.row, x.name, i + 1));
        });

        groups.push({
            topic: (b.topic && String(b.topic).trim()) || OTHER_TOPIC,
            totalCount: rows.length,
            count: kept.length,
            inListCount: rows.length - kept.length,
            stocks: kept
        });
    });

    groups.sort(function(a, b) {
        if (a.topic === OTHER_TOPIC) return 1;
        if (b.topic === OTHER_TOPIC) return -1;
        if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
        return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
    });

    return groups;
}

/**
 * 补充区汇总文案所需的最小统计（纯函数）：一字总只数 / 补充只数 / 题材个数 / 已在列表只数。
 *
 * ⚠️ 「总只数」与「补充只数」必须分开给：题材条与汇总行都要能同时说出
 *    「这个题材一共几只一字」和「其中几只是我补进来的」，否则用户无法判断题材热度。
 *
 * @param {Array<{totalCount:number, count:number}>} groups buildYiziSupplementGroups 的输出
 * @returns {{stockCount:number, topicCount:number, totalStockCount:number, inListCount:number}}
 */
export function summarizeSupplement(groups) {
    const list = Array.isArray(groups) ? groups : [];
    let stockCount = 0;
    let totalStockCount = 0;
    list.forEach(function(g) {
        if (!g) return;
        if (isFinite(g.count)) stockCount += Number(g.count);
        if (isFinite(g.totalCount)) totalStockCount += Number(g.totalCount);
    });
    return {
        stockCount: stockCount,
        topicCount: list.length,
        totalStockCount: totalStockCount,
        inListCount: totalStockCount - stockCount
    };
}
