// topic-sync.js — 把「竞价一字」接口自带的题材【自动回填】进共享题材库（§6：题材只有一份库）
//
// 为什么需要它（用户原话 2026-09-18）：
//   「涨跌停看板那个股票的题材可以自动获取，用一字竞价看板的接口获取题材补充那些没有题材的股票，
//    这样我就不用那么麻烦去手动复制粘贴导入了，节省时间」
//   「所有题材都可以共享而不是独立」
//
// 现状（为什么以前只能手动导）：
//   · 「竞价一字」的接口 daily_auc_fd 自带两个题材字段（theme_names_kpl 开盘啦 / theme_names_xgb 选股宝），
//     已随快照落库在 `auction_yizi.theme_kpl` / `theme_xgb`；
//   · 「涨跌停」看板的题材只认共享题材库 `stock_topics`；
//   · 两条链路互不相通 ⇒ 用户只能在涨跌停看板里手动粘贴（他抱怨的「那么麻烦」）。
//
// 本模块做的事（一个动作，三个看板同时受益）：
//   读 `auction_yizi` 某日快照 → 挑出「接口有题材、而共享库里还没有」的股票 → 只把这部分补写进
//   `stock_topics`。写的是**同一个库**，所以「竞价一字」「涨跌停」「早盘竞价」立刻都能用上。
//
// ── 红线（每一条都对应一类真实事故）─────────────────────────────────────────
//   §10 读失败 ≠ 空：读 `auction_yizi` 失败 → 返回 {ok:false, reason:'read-failed'} 并只记日志，
//       ⛔ 绝不返回「没有可补的」这种会被误当成结论的形态。
//   §11 只补空缺、绝不覆盖：库里已有题材的股票一律跳过。
//       理由：用户手动导入/修正过的题材通常比接口更准（人工会加自己关心的分类），
//       被接口覆盖 = 把手工作业抹掉。这一条是需求 1 的**核心约束**，不是优化项。
//   §10 没有题材就不写：接口该行无题材 → 跳过。⛔ 绝不 push 空题材
//       （空串写进库会把「没有」变成「有但为空」，题材库的「空」语义是「尚不知道」，两者不同）。
//   §6  幂等：同一日期同一会话只跑一次（写入本身也是 merge 幂等，但没必要反复花钱包）。
//   §20 失败不阻断：本模块是**增强**，任何失败都不得让看板加载失败。调用方 await 后按普通数据用，
//       出错只体现在返回值的 reason/failed 上。
//
// ⚠️ 额度说明：本模块【只消费已落库的快照】，不调任何上游接口 → **零猫抓额度消耗**。
//    一字快照由 Edge Function auction-yizi-fetch 在北京 9:25 落库，这里只是把它自带的题材搬进题库。

import { reactive } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { readAuctionYiziForDate } from '../../data/auction-yizi.js';
import {
    isCloudTopicsLoaded,
    loadCloudTopics,
    snapshotNormalizedLibraryIndex,
    pushStockTopicsToCloud
} from '../../data/stock-topics.js';
import { normalizeStockName } from './stock-name.js';
// §6 单一真相：接口题材的「优先级 + 合法性过滤」沿用一字看板同一份实现
// （📌 注意：logic/topics → logic/yizi 是单向依赖，yizi 侧不反向引用本模块，不会成环）
import { resolveYiziTopics } from '../yizi/model.js';

// 本会话已处理过的日期（含「跑完了但没什么可补」的情况 —— 那也是一个有效结论，不必反复重跑）
const _syncedDates = new Set();
// 单飞：同一天同一时刻只跑一次
let _inflight = null;
// 本会话内【按日期】累计补进共享库的只数：{ 'YYYY-MM-DD': n }
// 为什么需要它（而不是只用单次 filled）：
//   回填只在**第一个加载该日期的看板**里真正发生；相邻的另一个看板随后加载时命中
//   `_syncedDates` 去重 → 拿到 filled=0 → 界面上什么都不显示。用户关心「有没有自动补上」，
//   所以把结果按日期记下来，同一天的任何看板读到的都是同一个真数（⛔ 不是每块板各算一遍）。
// ⚠️ 必须【按日期】分开记，不能只留一个全局累计：
//   否则在 09-18 上会显示「已自动为 38 只…」——那 38 只其实是看 09-17 时补的，
//   日期切换后数字不动 = 与当前所见对不上（本项目对「数字必须可解释」的要求）。
//
// ★ 2026-09-18（第 5 轮复核）：本表做成【响应式】，并作为全应用**唯一真相**（§6）——
//   三个看板（竞价一字 / 涨跌停 / 早盘竞价）都通过 getAutoFilledForDate() 读它，
//   ⛔ 不再各自在 state 里留一份副本。理由（实测 2026-09-15 事故）：
//   副本只在「本看板自己那次 _load 真的走到回填那一步」时被写入；若那次回填因故中止
//   （读 auction_yizi 失败 / 题材库未就绪），而**另一个看板随后补上了**，
//   副本会永久停在 0 → 界面显示「没自动补」→ **与事实相反**（而这正是用户判断
//   「还要不要手动导入」的依据）。响应式化之后，任何一处写入都会被所有读取方立刻看到，
//   与「谁先加载、谁先走完」彻底解耦。
const _filledByDate = reactive({});

/** 该日期在本会话内累计补进库的只数（0 = 本会话没为这一天补过，或确实没什么可补） */
function _filledOf(date) {
    return (date && _filledByDate[date]) || 0;
}

/**
 * 取「本会话为某日期自动补进共享题材库的只数」—— 供 UI 提示读取（★ 需求 1 的可解释性）。
 *
 * ⚠️ 响应式读取：写入方（本模块 _sync 成功后）写完后，调用方的 computed 会自动重算。
 * ⛔ 看板/组合式不要再把结果抄进自己的 state —— 那就是第二份真相，会陈旧
 *    （实测 2026-09-15：涨跌停看板的副本停在 0，而当天其实已自动补了 49 只）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {number} 只数（0 = 本会话为这一天确实没补过任何一只）
 */
export function getAutoFilledForDate(date) {
    return _filledOf(date);
}

/**
 * 把某日「竞价一字」快照里接口自带的题材，自动补进共享题材库（**只补空缺、不覆盖、不写空**）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean, rows?:Array<object>}} [opts]
 *        · force=true 忽略本会话去重（手动触发用）；
 *        · rows=调用方**已经读好**的该日快照（竞价一字看板加载时手里就有），
 *          传进来可省掉一次重复的整日查询。⛔ 传进来的必须是 `auction_yizi` 的**原始行**
 *          （需带 `stock` / `code` / `themeKpl`（theme_kpl）/ `themeXgb`（theme_xgb）字段），
 *          不要传已加工过的展示行。
 * @returns {Promise<{ok:boolean, reason:string, date?:string, scanned?:number, withTopics?:number,
 *                    skippedHasTopics?:number, filled?:number, failed?:number, filledNames?:string[],
 *                    dateFilled:number}>}
 *          · `filled`     = **本次调用**真正写进库的只数（命中会话去重时为 0）；
 *          · `dateFilled` = **该日期在本会话内累计**写进库的只数（= getAutoFilledForDate(date)）。
 *            ⚠️ 仅供调用方**记日志/自行判断**；界面提示请直接 `getAutoFilledForDate(date)`
 *               （响应式单一真相，见该函数注释），⛔ 不要再抄进看板 state。
 *          ⚠️ 返回值只用于日志/可选提示，⛔ 任何 reason 都不得升级成看板级 error
 *          （本模块失败 = 「这次没自动补」，不是「看板坏了」）。
 */
export async function syncYiziTopicsIntoLibrary(date, opts) {
    const force = !!(opts && opts.force);
    if (!date) return { ok: false, reason: 'no-date', filled: 0, dateFilled: _filledOf(date) };
    const presetRows = (opts && opts.rows) || null;
    if (!force && _syncedDates.has(date)) {
        // 本日已跑过：本次 filled 当然是 0，但**累计值照旧返回** —— 界面上要能显示「补了多少」
        return { ok: true, reason: 'already-synced', date: date, filled: 0, dateFilled: _filledOf(date) };
    }
    if (_inflight && _inflight.date === date) return _inflight.promise;
    const p = _sync(date, presetRows).finally(function() {
        if (_inflight && _inflight.date === date) _inflight = null;
    });
    _inflight = { date: date, promise: p };
    return p;
}

async function _sync(date, presetRows) {
    // ① 写回前的【安全闸门】：题材库必须已从云端拉过。
    //    原因（真实数据丢失路径）：pushStockTopicsToCloud 的语义是「读云端已有 → 合并本次 → 写回」，
    //    它读 state._cloudTopicsCache。若为 null（= 从没拉过），「云端已有」会被读成空集 →
    //    写回时**覆盖掉线上已有的题材**。
    //    ⚠️ 判据用 isCloudTopicsLoaded()（拉过即可，哪怕拉到的是空库），
    //       ⛔ 不是 isTopicLibraryReady()（那个为空即 false，会让全新库永远填不进东西）。
    if (!isCloudTopicsLoaded()) {
        try {
            await loadCloudTopics();
        } catch (e) {
            _dbgLog('[TOPIC-SYNC] ' + date + ' 题材库加载异常: ' + (e && e.message || e));
        }
    }
    if (!isCloudTopicsLoaded()) {
        _dbgLog('[TOPIC-SYNC] ' + date + ' 题材库未成功加载 → 放弃自动回填（避免覆盖线上已有题材）');
        return { ok: false, reason: 'library-not-loaded', filled: 0, dateFilled: _filledOf(date) };
    }

    // ② 读一字快照（§10：失败如实回报「读失败」，⛔ 不伪装成「没有可补的」）
    //    调用方（竞价一字看板）手里已有原始行时会通过 opts.rows 传进来，省一次整日查询。
    let rows = presetRows;
    if (!rows) {
        try {
            rows = await readAuctionYiziForDate(date);
        } catch (e) {
            _dbgLog('[TOPIC-SYNC] ' + date + ' 读 auction_yizi 失败，本次不自动回填: ' + (e && e.message || e));
            return { ok: false, reason: 'read-failed', date: date, filled: 0, dateFilled: _filledOf(date) };
        }
    }

    // ③ 循环外取一次「云端库已有的归一化索引」，逐行判断「库里有没有题材」
    const libIndex = snapshotNormalizedLibraryIndex() || Object.create(null);

    let scanned = 0;
    let withTopics = 0;
    let skippedHasTopics = 0;
    let filled = 0;
    let failed = 0;
    const filledNames = [];

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.stock) continue;
        scanned++;

        // 只取【接口自带】的题材（第 3 参传空串 = 不把共享库自己算进去，否则永远都是「已有」）
        const res = resolveYiziTopics(r, '');
        if (!res || !res.text) continue;      // §10 接口没题材 → 跳过，绝不写空
        withTopics++;

        const nk = normalizeStockName(r.stock);
        const has = nk ? libIndex[nk] : null;
        if (has && has.size > 0) {            // §11 库里已有 → 绝不覆盖
            skippedHasTopics++;
            continue;
        }

        const topics = String(res.text).split(',').map(function(t) { return t.trim(); }).filter(Boolean);
        if (topics.length === 0) continue;

        try {
            await pushStockTopicsToCloud(r.stock, topics, r.code || '');
            filled++;
            filledNames.push(r.stock);
            // 就地更新本地索引：同一只票不会在一天里出现两次（表主键 date+stock），
            // 这里只是让「本次循环内的判断依据」与库里的真实状态保持同步（避免重复写）。
            if (nk) {
                if (!libIndex[nk]) libIndex[nk] = new Set();
                topics.forEach(function(t) { libIndex[nk].add(t); });
            }
        } catch (e) {
            failed++;
            _dbgLog('[TOPIC-SYNC] ' + date + ' 回填失败 ' + r.stock + ': ' + (e && e.message || e));
        }
    }

    // 记成「已同步」（含 filled=0：那也是有效结论 —— 接口这天的题材库里都有了）
    _syncedDates.add(date);
    _filledByDate[date] = _filledOf(date) + filled;

    if (filled > 0) {
        _dbgLog('[TOPIC-SYNC] ' + date + ' 自动回填题材 ' + filled + ' 只' +
            '（扫描 ' + scanned + '，接口有题材 ' + withTopics + '，库里已有跳过 ' + skippedHasTopics +
            '，失败 ' + failed + '）: ' + filledNames.join('、'));
    }
    return {
        ok: true,
        reason: 'done',
        date: date,
        scanned: scanned,
        withTopics: withTopics,
        skippedHasTopics: skippedHasTopics,
        filled: filled,
        failed: failed,
        filledNames: filledNames,
        dateFilled: _filledOf(date)
    };
}
