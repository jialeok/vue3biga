// core-word-purge.js — 「删除核心词 ⇒ 同步清理股票题材库」的唯一实现（Logic 层）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-14 原话，逐字）：
//   「我的意思是我删除核心词后，关联的同义词一起删除，比如东方海洋有羊字辈，东方，水产品，农业，
//     这四个细分题材，我删除羊字辈题材，它只剩下东方，水产品，农业这三个题材，我再删除东方，
//     它只剩下水产品，农业这两个题材。这两个细分题材，因为我没有删除关联的核心词，
//     所以要完整保留。」
//   补充口径（同日选定）：① 匹配口径 = 【精确等于才删】；② 改名/改同义词本轮不做。
//
// 为什么需要这个模块（缺陷本体）：
//   `core_topics`（核心词表）与 `stock_topics`（股票题材库）是【两张解耦的表】。
//   核心词只是一层「题材词 → 大类」的匹配映射（`topic/core-category.js#makeCoreTopicResolver`），
//   匹配不到就【原样返回该段】⇒ 删掉核心词「羊字辈」后，阳光照明行里的「羊字辈」标签
//   仍然留在库中，并且会自己变成一个题材分组冒出来 —— 用户看到的「残留、题材会乱」。
//   修法：删核心词时把「精确等于该核心词 / 其同义词」的题材段从每只股票里摘掉，
//   其余细分题材一个不动（⛔ 绝不整只股票的题材清空，也绝不按子串连坐）。
//
// ⚠️ 为什么匹配口径是「精确等于」而不是子串：
//   匹配（归类）用子串是【为了收得进大类】，删除用子串会【误伤】——
//   实测库内：删「稀土」会把「稀土永磁」一起删掉（纯子串 70 只）；删「半导体」会波及
//   「第三代半导体」等 26 只。删除不可逆（§11），所以只删完全相同的段；
//   另在计划里单列 `substringOnly`（只是包含、不会删），由 UI 如实告诉用户，⛔ 不静默。
//
// ⚠️ 为什么必须「读→计划→确认→写→验证」而不是直接写（§11 危险删除红线）：
//   实测影响面：羊字辈 15 只、东方 8 只（干净可删），但主流题材是
//   电子/通信/算力 309 只、电力新能源 181 只、工业4.0 175 只、AI应用 169 只
//   ⇒ 必须先把「将影响 N 只股票的这些词」摆给用户看，绝不静默连坐。
// ══════════════════════════════════════════════════════════════════════════════════════

import { pullStockTopicsFromCloud, pushStockTopicsBatch, loadCloudTopics } from '../../data/stock-topics.js';
import { state } from '../app-state.js';
import { _dbgLog } from '../../data/debug-log.js';

/**
 * 把核心词摊平成「要删的词」列表（核心词名 + 全部同义词；去空白、去重，保持原顺序）。
 *
 * 去重按小写比较（「GPU」与「gpu」算同一个词）；返回的是**原始大小写**，用于 UI 展示与日志。
 *
 * @param {{name?:string, synonyms?:string[]}|null} coreWord
 * @returns {string[]}
 */
export function coreWordTokens(coreWord) {
    const c = coreWord || {};
    const name = String(c.name === null || c.name === undefined ? '' : c.name).trim();
    const syns = Array.isArray(c.synonyms) ? c.synonyms : [];
    const out = [];
    const seen = new Set();
    [name].concat(syns).forEach(function(t) {
        const v = String(t === null || t === undefined ? '' : t).trim();
        if (!v) return;
        const k = v.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(v);
    });
    return out;
}

/**
 * 计算「删除某个核心词后，股票题材库要改成什么」——纯函数，无 IO，可单测（§15）。
 *
 * 语义（逐条对齐用户口径）：
 *   · 命中判据 = 题材段【精确等于】核心词名或任一同一词（忽略首尾空白与大小写）；
 *   · 命中 ⇒ 从该股题材集合里摘掉这一段，**其余题材原样保留、顺序不变**；
 *   · 未命中但含该词（子串）⇒ 保留，并记进 `substringOnly` 供 UI 如实提示；
 *   · 摘完会变空（该股全部题材都是这个词）⇒ 进 `blocked` 跳过，
 *     ⛔ 绝不把一只股票的题材整列清空（与 `pushStockTopicsToCloud` 的 empty-topics-guard 同一条护栏）。
 *
 * @param {Object<string, Set<string>|string[]>|null} library 股票题材库（`pullStockTopicsFromCloud()` 的返回）
 * @param {{name?:string, synonyms?:string[]}|null} coreWord 要删除的核心词
 * @returns {{
 *   words: string[], tokens: string[], rows: Array<{stock:string, kept:string[], removed:string[]}>,
 *   blocked: Array<{stock:string, removed:string[]}>,
 *   substringOnly: Array<{stock:string, words:string[]}>,
 *   affectedStocks: number, removedWords: number, totalStocks: number
 * }}
 */
export function planCoreWordPurge(library, coreWord) {
    const words = coreWordTokens(coreWord);
    const tokens = words.map(function(w) { return w.toLowerCase(); });
    const plan = {
        words: words,
        tokens: tokens,
        rows: [],
        blocked: [],
        substringOnly: [],
        affectedStocks: 0,
        removedWords: 0,
        totalStocks: 0
    };
    if (words.length === 0) return plan;

    const dict = (library && typeof library === 'object') ? library : {};
    const names = Object.keys(dict);
    plan.totalStocks = names.length;
    const tokenSet = new Set(tokens);

    names.forEach(function(stock) {
        const raw = dict[stock];
        const arr = (raw instanceof Set) ? Array.from(raw) : (Array.isArray(raw) ? raw : []);
        const kept = [];
        const removed = [];
        const subHit = [];
        arr.forEach(function(seg) {
            const s = String(seg === null || seg === undefined ? '' : seg).trim();
            if (!s) return;
            const lower = s.toLowerCase();
            if (tokenSet.has(lower)) { removed.push(s); return; }
            kept.push(s);
            // 只是包含（子串），不删 —— 只记录，供 UI 如实提示「这 N 只不会动」
            if (!subHit.length) {
                for (let i = 0; i < tokens.length; i++) {
                    if (lower.indexOf(tokens[i]) >= 0) { subHit.push(s); break; }
                }
            }
        });
        if (removed.length === 0) {
            if (subHit.length) plan.substringOnly.push({ stock: stock, words: subHit });
            return;
        }
        if (kept.length === 0) {
            // §11：摘完就空了 ⇒ 跳过并上报，⛔ 不把整只股票的题材清空
            plan.blocked.push({ stock: stock, removed: removed });
            return;
        }
        plan.rows.push({ stock: stock, kept: kept, removed: removed });
    });

    plan.affectedStocks = plan.rows.length;
    plan.removedWords = plan.rows.reduce(function(a, r) { return a + r.removed.length; }, 0);
    return plan;
}

/**
 * 读云端题材库并算出影响面（**只读，不写**）。
 *
 * §10：读失败 ⇒ 直接把异常抛给调用方（⛔ 不返回「0 只股票」的假计划）；
 *      读到 0 只 ⇒ 视为异常快照并抛错（实测库内 1921 只，0 只必然是读取异常，
 *      此时若继续「清理」，就会在空数据上做出判断 —— 正是 §11 明令禁止的形态）。
 *
 * @param {{name?:string, synonyms?:string[]}|null} coreWord
 * @returns {Promise<object>} planCoreWordPurge 的返回 + `libraryRows`
 */
export async function previewCoreWordPurge(coreWord) {
    const library = await pullStockTopicsFromCloud();
    const rows = library ? Object.keys(library).length : 0;
    if (rows === 0) {
        throw new Error('题材库读到 0 只股票（疑似读取异常），已中止');
    }
    const plan = planCoreWordPurge(library, coreWord);
    plan.libraryRows = rows;
    return plan;
}

/**
 * 执行清理：读 → 计划 → 批量写 → **刷新全局题材库缓存 + 重新读回验证**（§11 执行后必须验证）。
 *
 * ★★ [CORE-PURGE-SYNC 2026-11-14 用户口径] 为什么写完必须调 `loadCloudTopics()`：
 *   用户原话：「提示板那里就不要出现那东方和羊字辈的题材字样了，选股逻辑也是，也要跟着刷新」。
 *   联动是靠【题材库内容指纹】触发的：`getTopicLibraryDigest()` 读的是 `state._cloudTopicsCache`，
 *   它变了 ⇒ `currentRulesSig` 变 ⇒ `resolvePlanSnapshotFreshness` 判 stale（且**历史日也重算**）
 *   ⇒ `_buyPublished` 解冻 ⇒ 选股与提示板按现有题材重算并修订存档。
 *   ⚠️ 而 `pushStockTopicsBatch` 只在 `_cloudTopicsCache` 【已存在】时逐只更新 ——
 *      若当时库还没拉过（null），指纹就恒为空 ⇒ 存档判不出过期 ⇒ **什么都不刷新**。
 *   ⇒ 这里显式整库重拉一次：既保证指纹一定变，又让验证读的与 UI 读的是同一份（§6 不留两个真相）。
 *
 * 幂等：同一核心词重复调用，第二次 `affectedStocks = 0`、`written = 0`。
 *
 * @param {{name?:string, synonyms?:string[]}|null} coreWord
 * @returns {Promise<object>} plan + { written, verified, stillBad, libraryRows }
 */
export async function purgeCoreWordFromLibrary(coreWord) {
    const plan = await previewCoreWordPurge(coreWord);
    if (plan.affectedStocks === 0) {
        _dbgLog('[CORE-PURGE] 无需清理：' + (plan.words.join('、') || '(空)') + ' 在题材库里没有精确命中');
        return Object.assign(plan, { written: 0, verified: true, stillBad: [] });
    }
    const { written } = await pushStockTopicsBatch(plan.rows.map(function(r) {
        return { stock: r.stock, topics: r.kept };
    }));
    _dbgLog('[CORE-PURGE] 已从 ' + written + ' 只股票移除 ' + plan.removedWords + ' 个题材词：' +
        plan.words.join('、'));

    // ── ① 整库重拉：让 `_cloudTopicsCache`（= 题材库指纹的来源）与云端一致 ──
    //   `loadCloudTopics` 内部会 `_topicLibVersion + 1` ⇒ 各看板的 computed 重算一帧。
    let after = null;
    try {
        await loadCloudTopics();
        after = state._cloudTopicsCache || null;
    } catch (e) {
        _dbgLog('[CORE-PURGE] 写后重拉题材库失败（改用直读校验）: ' + (e && e.message || e));
    }

    // ── ② 回读校验：目标词必须真的从这些股票里消失（§11 执行后验证）──
    if (!after) {
        try {
            after = await pullStockTopicsFromCloud();
            // ★ 重拉失败时，把这份「直读到的全库」写回缓存：指纹的来源就是它（§6 单一真相），
            //   否则 `_cloudTopicsCache` 为 null ⇒ 指纹恒空 ⇒ 存档判不出过期 ⇒ 联动断掉。
            if (after) state._cloudTopicsCache = after;
        } catch (e) {
            _dbgLog('[CORE-PURGE] 写后校验读取失败: ' + (e && e.message || e));
        }
    }
    const tokenSet = new Set(plan.tokens);
    const stillBad = [];
    if (after) {
        plan.rows.forEach(function(r) {
            const raw = after[r.stock];
            const arr = (raw instanceof Set) ? Array.from(raw) : (Array.isArray(raw) ? raw : []);
            const still = arr.filter(function(s) {
                return tokenSet.has(String(s === null || s === undefined ? '' : s).trim().toLowerCase());
            });
            if (still.length) stillBad.push({ stock: r.stock, still: still });
        });
    }
    return Object.assign(plan, {
        written: written,
        verified: !!after && stillBad.length === 0,
        stillBad: stillBad,
        libraryRows: after ? Object.keys(after).length : 0
    });
}
