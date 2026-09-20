// yizi-supplement.js — 「早盘竞价看板 · 补竞价一字（按题材融入 + 十日涨幅合并排名）」的 Logic 层
//                     （纯函数叶子，§15 独立业务模块）
//
// ⚠️ 2026-09-20 第二次修正记录（先读，⛔ 不要再按旧版口径改回去）：
//   v1 把一字看板的题材分块【整块】追加在列表末尾。
//   v2 改为【按题材融入】早盘竞价已有题材组的组内末尾（用户确认「位置对了」）。
//   v3（本版）用户反馈「位置对了，但是显示还没对」，三点诉求：
//     ① 补入行要【完全按早盘竞价的行】显示：序号 / 股票名称 / 标签 / 题材 四列，
//        ⛔ 不显示封单额、⛔ 不显示十日涨幅列（用户原话：「竞价一字的那些封单额在 UI 这里不要显示了」
//        「后面的那个十日涨幅也要隐藏起来，只保留我说的那四个」）；
//     ② 序号不再沿用「竞价一字看板自己的块内序号」，而是
//        **按这只股票在同一个题材内的十日涨幅排名**、与原有行【合并排名后插到排名位置】
//        （用户原话：「一样参与早盘竞价看板题材 toggle 的龙一，龙二，龙三等排序」）；
//     ③ 字体 / 字样 / 显示效果（收盘名色、一字红线）与列表统一 —— 该诉求由 UI 侧
//        直接复用早盘竞价的类名实现（见 components/AuctionYiziSupplementRow.vue），本模块只负责
//        把「渲染序列 + 序号」算准。
//
// 需求口径（逐条对应实现，⛔ 改动前先读一遍）：
//   ① 只在「题材 toggle【单独】开启 + 补竞价一字开关打开」时生效；关掉开关立刻恢复原样；
//   ② 【融入】而不是整块追加：一字股落进早盘竞价【同一题材组】内，与原股票排在一起；
//   ③ 融入判据 = 一字股的任一题材命中该题材组的组名 → 进该组；命中多个组就分别进
//      （如华软科技「芯片,化工」→ 芯片组、化工组各出现一次）；
//   ④ 重复的不融：股票名已在早盘竞价列表里 → 整只跳过（列表本身就有这只票）；
//   ⑤ 补入的行带【小标记】：显示行上有 `mergedTopic`（被并入的组名），模板据此渲染「补」标；
//   ⑥ **组间顺序不变**（沿用 sortByTopicGroups 产出的题材组序 = 一字最多的题材排最前）；
//      **组内**：补入行插到「它在本题材组的十日涨幅排名位」，整段序号 1..N 连续重排；
//      ⚠️ 原有行彼此的相对顺序【不动】（它们本来就是同一把尺子排好的，
//         见 _mergeSegmentEntries 头注：只插补入行、不重排原有行）；
//   ⑦ 一字股的题材在当日列表里【一个组都没命中】→ 无处可融 → 收进「未并入」尾段（isOrphan）。
//      ⛔ 绝不静默丢弃：本功能的意义正是「看哪个题材的一字多」，藏掉几只等于给用户一个错误结论（§10）。
//
// 架构位置（§2 依赖方向 UI → Logic → Data）：
//   UI（AuctionBoardTable.vue 的融入序列渲染 + components/AuctionYiziSupplement*.vue）
//     → composables/useAuctionYiziSupplement.js（UI/VM 状态：开关态 / 展开态 / 曲线 / 文案）
//     → 本模块（**纯函数**：按题材融入 + 十日涨幅合并排名 → 分段渲染序列）
//     → logic/yizi/yizi-board.js（既有单一真相：auction_yizi 的题材分块结果）
//
// 【边界 —— 本模块刻意什么都不碰】
//   · ⛔ 不读、不写 auction_watchlist / market_metrics / 早盘竞价的任何内存缓存与排序状态；
//   · ⛔ 不写任何表（本功能全程零写入，纯展示，§10/§11 无风险面）；
//   · ⛔ **不改动入参**：原有行只在「序号真的变了」时才浅拷贝出新对象，其余情况原引用透出；
//   · ⛔ 不自算题材、不自算十日涨幅、不自选龙头 —— 只做「既有字段 → 渲染序列」的搬运与排序。
//
// 【十日涨幅为什么两边可比（§6 单一真相）】
//   早盘竞价侧：`opts.pctOf(stock)` = logic/auction/dragon-rank.js#getDragonRangePct 的云端缓存
//     （worker 用 numcat daily 按 range-window.js 复利口径算出的「近 10 个交易日区间涨幅」）；
//   竞价一字侧：块内行自带的 `rangePct`（同一张 stock_range_pct 表、同一份 range-window 复利口径，
//     由 logic/yizi/yizi-board.js 读表 + 小号补算后挂到行上）。
//   ⇒ 同一个数、同一张表、同一套复利口径，所以可以直接放在一个序列里排序。
//   ⚠️ 两边取不到值时一律视为「没有数据」→ 置底（⛔ 绝不用 0 冒充，§10）。
//
// 【题材判据为什么必须是同一份（§6）】
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
 * 「十日涨幅」数值归一：只接受有限数值，其余（null / '' / NaN / 非数）一律返回 null。
 * ⚠️ 返回 null 的语义是「**没有这个数据**」而不是「涨幅为 0」——两者排序含义完全不同（§10）。
 * @param {*} v
 * @returns {number|null}
 */
function _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/**
 * 一行「没有十日涨幅」时的排序键：置底（与 topic-block.js / sortByTopicGroups 同款约定）。
 */
const NO_PCT = -Infinity;

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
 * 一字看板的一行 → 补入行的显示对象（只搬运，⛔ 不重算任何口径）。
 *
 * ⚠️ 本对象刻意【只带 UI 真要渲染的东西】，两道闸门分得很清：
 *    · **列表行**（AuctionYiziSupplementRow 的行本体）只渲染 序号 / 股票名称 / 标签 / 题材 ——
 *      封单额（9:20/9:25/变化量）、首封时刻、9:20 时点标都**不进本对象**（v3：用户要求四列）；
 *    · **展开后的趋势面板**（点序号才出现）顶部那一行照旧显示十日涨幅 —— 与「竞价一字」看板
 *      自己的面板同款同源，故 `rangeText / rangeTone` 必须保留。
 *    十日涨幅的**数值** `rankPct` 另有一用：它是组内合并排名的唯一依据（⛔ 不进行内显示）。
 *    ⛔ 需要封单额请去「竞价一字」看板看（那边口径更全，本功能只是显示层借用）。
 *
 * @param {object} s 一字看板 blocks[].stocks[] 的一行
 * @param {string} name 归一化后的股票名
 * @param {number} fallbackSeq 无 seq 时的行序回退值（该行在其题材块内的位置，1 起）
 * @param {string} mergedTopic 被并入的早盘竞价题材组名（'' = 未并入尾段）
 * @param {string} topicBg 该题材组的浅色背景（与组内原有行同色 → 视觉上是一整段）
 * @returns {object}
 */
function _toSupRow(s, name, fallbackSeq, mergedTopic, topicBg) {
    return {
        stock: name,
        // 序号：**由下方「组内合并排名」阶段赋值**（1 起）。初始值取一字板块内序号，
        // 仅在「未并入尾段」（无处可融、没有早盘竞价的题材组可比）时才会被直接沿用。
        seq: (isFinite(Number(s.seq)) && Number(s.seq) > 0) ? Number(s.seq) : fallbackSeq,
        // ★ 被并入哪一组（模板据此渲染「补」标与悬停说明；'' = 该股题材不在当日列表里，落在尾段）
        mergedTopic: mergedTopic || '',
        topicsDisplay: s.topicsDisplay || '-',
        // 连板标（首板/二板/三板…）：与早盘竞价行内那个连板标同源同义（limit-streak）
        continueText: s.continueText || '',
        // 十日涨幅【数值】：组内合并排名的唯一依据（⛔ 不在列表行里显示，见本函数头注）
        rankPct: _num(s.rangePct),
        // 十日涨幅【文本 / 色调】：**只供展开后的趋势面板**顶部那一行（列表行 ⛔ 不渲染），
        // 缺值留空串 → 模板显示 '-'（⛔ 不伪造 0 / '0.00%'，§10）
        rangeText: s.rangeText || '',
        rangeTone: s.rangeTone || '',
        // 该题材组的浅色底（与组内原有行同色；'' = 该题材不成组/不上色）
        topicBg: topicBg || ''
    };
}

/**
 * 组内【合并排名】：把补入行插进「原有行按十日涨幅的排名位」，整段序号重排为 1..N。
 *
 * ★ 本函数的核心取舍（2026-09-20 v3 定稿，⛔ 不要再改成「重新排序原有行」）：
 *   原有行**不被本函数改变彼此的先后关系**，本函数只为补入行找插入位。
 *   为什么：早盘竞价的组内顺序本来就是同一把尺子排出来的 ——
 *     view-helpers 用 `getDragonRangePct(currentDate)`（本模块 `pctOf` 的同一个 Map）算出龙头排名，
 *     再交给 sortByTopicGroups 按 `rank 升序` 排 → 组内已是「十日涨幅降序（无值置底）」。
 *   所以「插到第一个十日涨幅比自己低的原有行之前」**就等于**「按十日涨幅合并成一条降序序列加号」，
 *   而且还多一层保证：用户已经认下来的组内相对顺序不会因为打开本开关而整体洗牌。
 *   ⛔ 反面做法（曾实现过、已废弃）：把原有行与补入行一起 sort。它对「组内本来就没排过序的段」
 *      （如组内只有 1 只、或「其它」组：computeDragonRankMap 只给成员≥2 的着色题材发排名）
 *      会把原有行顺手换位 —— 那不是本功能该干的事。
 *
 * 插入位的判据（与 sortByTopicGroups 的 `_rankNum` 置底约定同义）：
 *   · 原有行取不到十日涨幅（或整段都取不到）→ 视为「低于任何有值行」→ 有值的补入行插到它之前；
 *   · 补入行自己也取不到 → 落到该组**最末**（无数据不参与排名，也 ⛔ 不冒充 0，§10）。
 *
 * ⚠️ `pctOf` 为 null（云端十日涨幅缓存还没到）→ **整段没有排序基准** → 不做合并排名，
 *    补入行按一字板自己的顺序接到组内末尾，序号 1..N 顺排。
 *    这是刻意的：⛔ 不在没有基准时假装排过（§10）。
 *
 * ⚠️ 原有行只在「序号真的变了」时才浅拷贝 —— 序号没变的行保持**原对象引用**，
 *    保证 UI 侧 v-memo 指纹与响应式依赖不被无意义地打断（§17/§23 最小范围更新）。
 *
 * @param {Array<object>} rows 该题材组的原有行（已按看板自己的顺序排列）
 * @param {Array<object>} sups 该题材组待补入的显示行
 * @param {(stock:string)=>number|null} pctOf 原有行的十日涨幅取值器（null = 无基准数据）
 * @returns {Array<{kind:'row'|'sup', item?:object, sup?:object}>} 渲染序列（已带最终序号）
 */
function _mergeSegmentEntries(rows, sups, pctOf) {
    const list = (rows || []).filter(Boolean);
    const supList = (sups || []).filter(Boolean);
    const hasBasis = typeof pctOf === 'function';

    // 每个插入位（0..list.length）之前要放的补入行：位 i = 「排在 list[i] 前面」，位 list.length = 排在全部之后
    const slots = [];
    for (let i = 0; i <= list.length; i++) slots.push([]);
    const tail = [];                                 // 取不到十日涨幅的补入行 → 该组最末

    if (!hasBasis) {
        // 无基准：不排序，沿用一字板自己的行序接在组内末尾
        supList.forEach(function(s) { tail.push(s); });
    } else {
        const rowPcts = list.map(function(r) { return _num(pctOf(r.stock)); });
        // 补入行之间先按十日涨幅降序（无值置底、同值按一字板自己的行序）——
        // 多只补入时位次本身也要按涨幅，否则「序号=涨幅名次」在后半段立刻不成立。
        const pairs = supList.map(function(s, i) { return { s: s, pct: _num(s.rankPct), pos: i }; });
        pairs.sort(function(a, b) {
            const av = (a.pct === null) ? NO_PCT : a.pct;
            const bv = (b.pct === null) ? NO_PCT : b.pct;
            if (av !== bv) return bv - av;
            return a.pos - b.pos;
        });
        pairs.forEach(function(p) {
            if (p.pct === null) { tail.push(p.s); return; }
            let at = list.length;
            for (let i = 0; i < list.length; i++) {
                const rv = rowPcts[i];
                // 原有行无值 → 视作「比任何有值行都低」；有值且更低 → 补入行排在它前面
                if (rv === null || rv < p.pct) { at = i; break; }
            }
            slots[at].push(p.s);
        });
    }

    // 按「原有行原序」铺开，只在对应位置前插入补入行 → 原有行的相对顺序天然不动
    const ordered = [];
    list.forEach(function(r, i) {
        slots[i].forEach(function(s) { ordered.push({ kind: 'sup', sup: s }); });
        ordered.push({ kind: 'row', item: r });
    });
    slots[list.length].forEach(function(s) { ordered.push({ kind: 'sup', sup: s }); });
    tail.forEach(function(s) { ordered.push({ kind: 'sup', sup: s }); });

    // 序号 1..N 重排（原有行序号没变 → 原引用透出，不做无谓拷贝）
    return ordered.map(function(e, i) {
        const seqNo = i + 1;
        if (e.kind === 'sup') {
            e.sup.seq = seqNo;
            return { kind: 'sup', sup: e.sup };
        }
        const cur = Number(e.item.seqNo) || 0;
        if (cur === seqNo) return { kind: 'row', item: e.item };
        return { kind: 'row', item: Object.assign({}, e.item, { seqNo: seqNo }) };
    });
}

/**
 * 把「竞价一字」按题材【融入】早盘竞价的题材分组序列（纯函数，不改动入参）。
 *
 * 输出结构（供模板逐字段直出，满足 §21 模板不做业务计算）：
 *   `{ segments: [{ key, topic, isOrphan, entries }], stats }`
 *   · `entries` = 该题材组的**最终渲染序列**（原有行与补入行已交错排好、序号已重排），
 *     元素形如 `{ kind:'row', item }` 或 `{ kind:'sup', sup }`；
 *   · `segments` 的**先后顺序** = 早盘竞价看板自己的题材组序（本模块 ⛔ 不碰组间顺序）。
 *
 * ⚠️ 分组切法：只按【相邻行是否同 groupTopic】切「连续段」，不按组名归并。
 *    题材模式下同题材必然连续（view-helpers 的 sortByTopicGroups 保证），这里再按相邻切一次，
 *    即使上游将来改成不连续，结果也只是「同一题材分成两段」（顺序 = 渲染顺序，逐行保真）。
 *
 * ⚠️ 一字股同名跨块出现（上游分块口径不同时可能）→ 题材集合取并集，只渲染一行。
 *
 * @param {Array<{groupTopic?:string, stock?:string, seqNo?:number, topicBg?:string}>} auctionRows
 *        早盘竞价【题材单独开启】时的最终渲染行序列（`filteredRegularItems`，按渲染顺序）。
 *        ⚠️ 每行必须带 `groupTopic`（Logic 层 view-helpers 已赋值）；缺失时按「其它」处理。
 * @param {Array<object>} yiziBlocks 竞价一字看板的题材分块（`yiziBoardState.blocks`），形状：
 *        `[{ topic, count, stocks: [{ stock, seq, topicsDisplay, isLeader, continueText,
 *                                    rangePct, rangeText, rangeTone, seal*, firstTimeText }] }]`
 * @param {{excludeNames?:Set<string>|string[], coreTopics?:Array<object>,
 *          pctOf?:((stock:string)=>number|null)|null}} [opts]
 *        excludeNames = 早盘竞价当前列表的股票名（重复的不融）；
 *        coreTopics = 可分组核心词；
 *        pctOf = 原有行的十日涨幅取值器（缺省/为 null → 不做合并排名，补入行接在组内末尾）。
 * @returns {{segments: Array<object>, stats: {yiziTotal:number, mergedStocks:number,
 *           mergedRows:number, inListCount:number, orphanCount:number}}}
 */
export function mergeYiziIntoAuctionRows(auctionRows, yiziBlocks, opts) {
    const rows = Array.isArray(auctionRows) ? auctionRows : [];
    const blocks = Array.isArray(yiziBlocks) ? yiziBlocks : [];
    const o = opts || {};
    const excluded = _toNameSet(o.excludeNames);
    const coreTopics = Array.isArray(o.coreTopics) ? o.coreTopics : [];
    const pctOf = typeof o.pctOf === 'function' ? o.pctOf : null;

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

    // ---- 2) 一字股候选：跨块去重 + 汇总「该股的核心题材集合 + 十日涨幅数值」 ----
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
                // 同名（跨块）：题材取并集，十日涨幅取第一个非空值，仍只渲染一行
                _coreSetOf(s.topicsDisplay, coreTopics).forEach(function(t) { exist.coreSet.add(t); });
                if (exist.rankPct === null) exist.rankPct = _num(s.rangePct);
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
            const c = { name: name, row: s, fallbackSeq: i + 1, coreSet: coreSet, rankPct: _num(s.rangePct) };
            byName.set(name, c);
            cands.push(c);
        });
    });

    // ---- 3) 融入：逐只一字股按题材命中，落到对应题材组的【候选集】 ----
    const orphans = [];
    let mergedStocks = 0;
    let mergedRows = 0;
    let inListCount = 0;
    cands.forEach(function(c) {
        if (excluded.has(c.name)) { inListCount++; return; }   // 用户口径：列表里已有的不重复融
        let hit = 0;
        segments.forEach(function(seg) {
            if (!c.coreSet.has(seg.topic)) return;
            // topicBg 取该组第一行（原有行的题材浅色底）→ 补入行与同组原有行同底色，视觉是一整段
            const bg = (seg.rows[0] && seg.rows[0].topicBg) || '';
            const sup = _toSupRow(c.row, c.name, c.fallbackSeq, seg.topic, bg);
            // 跨块同名时以并集后的最优十日涨幅为准（同一个数据，防御性取非空）
            if (sup.rankPct === null) sup.rankPct = c.rankPct;
            seg.sups.push(sup);
            hit++;
        });
        if (hit === 0) {
            orphans.push(_toSupRow(c.row, c.name, c.fallbackSeq, '', ''));
            return;
        }
        mergedStocks++;
        mergedRows += hit;
    });

    // ---- 4) 逐段定序：组内「原有行 + 补入行」按十日涨幅合并排名，序号 1..N ----
    // 为什么只对「真有补入行」的段做合并排名：没有补入行时段的渲染序列必须与纯看板视图
    // **逐行逐号一致**（本功能只是显示层叠加，不该顺手改动别的题材组）。
    const out = segments.map(function(seg) {
        if (seg.sups.length === 0) {
            return {
                key: seg.key,
                topic: seg.topic,
                isOrphan: false,
                entries: seg.rows.map(function(r) { return { kind: 'row', item: r }; })
            };
        }
        return {
            key: seg.key,
            topic: seg.topic,
            isOrphan: false,
            entries: _mergeSegmentEntries(seg.rows, seg.sups, pctOf)
        };
    });

    // ---- 5) 「未并入」尾段（只在真有未并入时才追加，不产生空段） ----
    // 为什么必须显示而不是默默丢掉：本功能存在的意义就是「看哪个题材的一字多」，
    // 藏掉几只 = 给用户一个错误的题材热度结论（§10 不隐藏缺失）。
    // ⚠️ 尾段里各股来自**不同**题材、没有可比的题材组，故 ⛔ 不做合并排名，
    //    序号沿用它们在一字板自己题材块里的排名（= 真实排名，不伪造连续号）。
    if (orphans.length > 0) {
        out.push({
            key: 'orphan',
            topic: '',
            isOrphan: true,
            entries: orphans.map(function(s) { return { kind: 'sup', sup: s }; })
        });
    }

    return {
        segments: out,
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
