// yizi-topic-order.js — 「补竞价一字」打开时的【题材组重排】纯函数（§15 独立业务模块）
//
// 需求口径（2026-09-20，用户原话转述，⛔ 改动前先读一遍）：
//   · 只开「题材」toggle 时：题材组顺序 = 既有口径（一字多的题材排最前 → 组大者居前 → 题材名稳定），
//     **一个字节都不许变**；
//   · 再打开「补竞价一字」toggle 时：那些【补进来的竞价一字】也要算进题材的「一字数量」里，
//     题材按这个新数量【由多到少重新排序】（一字最多的题材排最前）；
//   · 关掉「补竞价一字」→ 立刻恢复成「只开题材 toggle」的原样。
//
// 为什么必须是一个【独立小模块】而不是塞进 yizi-supplement.js / topic-sort.js：
//   · topic-sort.js#sortByTopicGroups 是「关闭补一字」时的既有口径（还要服务叠加主排序的多个模式），
//     往它里面加开关参数 = 让两种口径互相污染，关掉开关时很难证明行为 100% 不变；
//   · yizi-supplement.js 只负责「按题材融入 + 组内合并排名」，组间顺序它明确声明不碰；
//   · 于是「打开开关后组间怎么重排」这件事单独落在本模块 —— 它只在【开关打开】的渲染链路上被调用，
//     开关一关它根本不执行 ⇒ 「关闭即恢复原样」是结构性保证，而不是靠某个 if 记得还原。
//
// 架构位置（§2 UI → Logic → Data）：
//   components/AuctionBoardTable.vue（读 segments 渲染）
//     → composables/useAuctionYiziSupplement.js（只有 active 时才调本模块）
//     → 本模块（纯函数：分段序列 → 重排后的分段序列）
//
// 【边界 —— 本模块刻意什么都不碰】
//   · ⛔ 不读、不写任何数据层（auction_yizi / auction_watchlist / market_metrics 一律不碰）；
//   · ⛔ 不改早盘竞价的排序结果（viewData / filteredRegularItems 一个字段都不动）；
//   · ⛔ 不改段内顺序（段内「原有行 + 补入行」的十日涨幅合并排名由 yizi-supplement.js 负责），
//     本模块只搬动【段与段之间】的前后关系；
//   · ⛔ 不改入参：返回新数组，段对象本身原引用透出（保住 UI 侧的 key / v-memo 稳定性，§17）。
//
// 【两个计数口径（与既有 sortByTopicGroups 对齐，保证「关闭开关 = 原样」）】
//   一字权重 yizi = 组内【原有行】的一字数 + 【补入行】数
//     · 原有行的一字数：行上既有的 isYiZi（view-helpers 按 auc_pct_chg + 涨停幅度判好的既成事实）；
//     · 补入行数：来自竞价一字看板，它们**本身全都是一字**，所以补进来几只就加几；
//       ⚠️ 一只有多个题材时会分别融进多个组（yizi-supplement 的既有口径）→ 各组各加 1，
//          与「多题材合计 N 行」的汇总文案同源，不是重复计数。
//   组规模 size = 组内原有行数 + 补入行数（= 该段最终渲染的行数）
//     · 关闭开关时补入行恒为 0 → 两个权重退化成既有口径的 yiZiMap / sizeMap。

import { OTHER_TOPIC } from '../topics/topic-block.js';

/** 段位等级：真实题材组 → 「其它」→ 「未并入」尾段（越大越靠后） */
const RANK_REAL = 0;
const RANK_OTHER = 1;
const RANK_ORPHAN = 2;

/**
 * 一段的排序权重。
 *
 * ⚠️ entries 的两种元素（见 logic/auction/yizi-supplement.js）：
 *   `{ kind:'row', item }` = 早盘竞价原有行；`{ kind:'sup', sup }` = 补进来的竞价一字行。
 *   除此之外的形状一律不计（防御性：上游将来加新 kind 时不至于把行数算错成 NaN）。
 *
 * @param {object} seg mergeYiziIntoAuctionRows 产出的一个分段
 * @returns {{yizi:number, size:number, rows:number, rowYiZi:number, sups:number}}
 */
export function segmentWeight(seg) {
    const entries = (seg && seg.entries) || [];
    let rows = 0;
    let rowYiZi = 0;
    let sups = 0;
    entries.forEach(function(e) {
        if (!e) return;
        if (e.kind === 'sup') { sups++; return; }
        if (e.kind !== 'row') return;
        rows++;
        if (e.item && e.item.isYiZi) rowYiZi++;
    });
    return { yizi: rowYiZi + sups, size: rows + sups, rows: rows, rowYiZi: rowYiZi, sups: sups };
}

function _rankOf(seg) {
    if (!seg) return RANK_ORPHAN;
    if (seg.isOrphan) return RANK_ORPHAN;      // 「未并入」尾段：永远最末（与既有「其它置底」同义）
    if (String(seg.topic || '').trim() === OTHER_TOPIC) return RANK_OTHER;
    return RANK_REAL;
}

/**
 * 【补竞价一字】打开后的题材组重排（稳定排序，不改动入参）。
 *
 * 排序键（与 topic-sort.js#sortByTopicGroups 的题材组排序同构，只把「补进来的」算进去）：
 *   ① 段位：真实题材组 → 「其它」→ 「未并入」尾段（后两者永远在最后，与既有口径一致）；
 *   ② 一字权重降序（= 原有行一字数 + 补入行数）——用户要的「一字多的题材排最前」；
 *   ③ 组规模降序（= 该段最终行数）——一字权相同时，题材内股票多的排前（既有次级口径）；
 *   ④ 题材名升序 —— 兜底，保证同权重时每次渲染顺序一致（§19 稳定依赖）。
 *
 * ⚠️ 为什么「其它」不参与一字权重竞争：sortByTopicGroups 里「其它」就是无条件置底的
 *    （无题材 / 未匹配核心词 / 组<2只 的集合，不是一个真题材），本模块必须保持同一语义，
 *    否则开关一开「其它」会因为补进来的几只未分类一字而蹿到前面 —— 那是明显的回归。
 *
 * @param {Array<object>} segments mergeYiziIntoAuctionRows 产出的分段序列
 * @returns {Array<object>} 重排后的**新数组**（段对象引用不变；空/非数组原样返回）
 */
export function sortSegmentsByYiziWeight(segments) {
    if (!Array.isArray(segments) || segments.length <= 1) return segments || [];
    const weighted = segments.map(function(seg, i) {
        return { seg: seg, i: i, rank: _rankOf(seg), w: segmentWeight(seg), topic: String((seg && seg.topic) || '') };
    });
    weighted.sort(function(a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.w.yizi !== b.w.yizi) return b.w.yizi - a.w.yizi;   // 一字多的排最前
        if (a.w.size !== b.w.size) return b.w.size - a.w.size;   // 组大的排前
        if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1;
        return a.i - b.i;                                        // 稳定兜底（保持原相对顺序）
    });
    return weighted.map(function(x) { return x.seg; });
}
