// tvrb-plan-snapshot.js — 「题材量比」看板 · 【选股结论快照表】唯一读写入口（Data 层，§5）
//
// ★★ [TVRB-PLAN-SNAPSHOT 2026-11-11] 为什么必须有这张表：
//   用户原话「我有时要看历史日期复盘的，为什么老是搞失踪……这不是一只票问题，是整个类的问题」。
//   取证：选股结论只存在内存 ref `_buyPublished`，全仓库无落库；切日期 ⇒ 解冻 ⇒ 用【会漂移的
//   当前库内数据】重算 ⇒ 早期残缺结论被定稿冻结 ⇒ 票「消失」。11-10 的 stock_range20_pct
//   81 行全是 close 腿（16:30 覆盖）、market_metrics 的 11-10 行 11-11 09:25 又被重写过。
//   ⇒ 根治 = 把定稿那一刻的 plan 按日期存下来，历史日期优先读快照、永不重算（§6 单一真相）。
//
// ── 表结构（建表 SQL：db/create_tvrb_plan_snapshot.sql）───────────────────────
//   date(pk) / plan(jsonb) / leg / source / rules_sig / selection_sig / inputs_sig /
//   revision / settled_at / created_at
//
// ★ [SNAPSHOT-INPUTS 2026-11-11] `inputs_sig` = 输入完整度指纹（竞价榜就绪|量比达标|补位池非空）。
//   11-11 实证：当天 `stock_range20_pct` 的 auc 腿 0 行（云端预填撞 42P10 全灭）⇒ 补位池空，
//   结论在输入残缺时算出、按 rules_sig 命中后**永久冻结** ⇒ 用户「越改越乱」。
//   有了这一列：数据补齐 ⇒ 判 stale ⇒ 用完整输入重算并覆盖。
//
// 🔴 [TVRB-PLAN-SNAPSHOT-REVISABLE 2026-11-11] 第二版语义修正（用户明确要求）：
//   「历史日期既然能计算出来也要存起来……结果不是一成不变的」。
//   ⇒ 第一版的 `ignoreDuplicates / 只写一次 / 只写今天` **全部作废**：
//     任何日期算出来都写；用户在核心词管理改同义词 ⇒ 规则指纹变 ⇒ 历史日重算并覆盖。
//
// ── 红线 ───────────────────────────────────────────────────────────────────
//   · §10：四种状态必须分清 —— hit(有存档) / empty(表里确实没有) / unavailable(表不存在) /
//     error(读失败)。⛔ 绝不允许把 error / unavailable 折成「没有存档」去重算还静默。
//   · §11：本模块只 select / upsert，⛔ 绝无 delete。**覆盖是否安全由 Logic 层
//     `shouldPersistPlanSnapshot` 判定**（读档失败 / 表不存在 / 降级结论一律不覆盖），
//     ⛔ 本层不自行决定，也不再用 ignoreDuplicates 偷偷把「不许覆盖」写死。
//   · §32：按日期会话内缓存 + 单飞，同一天只查一次；写成功后同步缓存。
//   · 写入失败不抛给调用方（这次展示不该因为存不上而失败），但必须留痕（§10 禁止静默）。
//
// 状态范式与 ebb-days.js 一致（Data 层只读写自己那张表）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（唯一出处：建表 SQL 与代码都从这里对，⛔ 别在别处再写一次字符串） */
export const PLAN_SNAPSHOT_TABLE = 'tvrb_plan_snapshot';

/** 表不存在（PGRST205 / 42P01 / 404）⇒ 本会话不再重试（§32） */
let _tableMissing = false;

/**
 * ★★ [SNAPSHOT-INPUTS 2026-11-11] `inputs_sig` 列还不存在（用户尚未执行第三版 DDL）⇒ 降级读写。
 *
 * 🔴 为什么必须有：用户每天早上只用手机看线上网页、电脑常关。若新版前端把 `inputs_sig`
 *   写进 select / upsert，而库里还没这一列，PostgREST 会返回 `42703 undefined column`
 *   ⇒ **整张存档表读失败、写不进去** ⇒ 历史复盘/定稿冻结全部退化成「每次重算」。
 *   宁可【少一个防复发字段也照常工作】，也不能因为一个新增列让整张表不可用（§11 渐进升级）。
 *   ⚠️ 判定成功后本会话一直降级；用户下次执行 SQL 后刷新页面即自动恢复（本会话级，不写死）。
 */
let _inputsSigMissing = false;

/** select 列清单：全量版 / 降级版（少 inputs_sig）。⛔ 两处必须与读写共用，别各处再写一份。 */
const SEL_FULL = 'date,plan,leg,source,rules_sig,selection_sig,inputs_sig,revision,settled_at,created_at';
const SEL_BASE = 'date,plan,leg,source,rules_sig,selection_sig,revision,settled_at,created_at';

/** PostgREST：列不存在（42703）或 schema cache 里没这个字段（PGRST204） */
function _isMissingColumn(error, col) {
    if (!error) return false;
    const code = String(error.code || '');
    const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
    if (code !== '42703' && code !== 'PGRST204') return false;
    return msg.indexOf(col) >= 0 || msg.indexOf('schema cache') >= 0;
}

/** date -> {status:'hit', plan} | null（null = 这天确实没有行） */
const _cache = new Map();
/** 单飞：date -> Promise */
const _inflight = new Map();

function _isMissingTable(error) {
    if (!error) return false;
    const code = String(error.code || '');
    const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
    return code === 'PGRST205' || code === '42P01' || /could not find the table|does not exist|schema cache/i.test(msg);
}

/**
 * 读某日的定稿快照（原始 DB 行，未解码）。
 * @returns {Promise<{status:'hit'|'empty'|'unavailable'|'error', row?:object, reason?:string}>}
 */
async function _fetchOne(d) {
    let data = null;
    let error = null;
    const query = function (cols) {
        return getSupabase()
            .from(PLAN_SNAPSHOT_TABLE)
            .select(cols)
            .eq('date', d)
            .limit(1);
    };
    const run = async function (cols) {
        try {
            const res = await query(cols);
            return { data: res.data, error: res.error };
        } catch (e) {
            return { data: null, error: e };
        }
    };
    let out = await run(_inputsSigMissing ? SEL_BASE : SEL_FULL);
    data = out.data; error = out.error;
    // ★ [SNAPSHOT-INPUTS] 库里还没 inputs_sig 这一列 ⇒ 降级重试一次，⛔ 不让新增列拖垮整张表
    if (error && !_inputsSigMissing && _isMissingColumn(error, 'inputs_sig')) {
        _inputsSigMissing = true;
        _dbgLog('[TVRB-SNAPSHOT] tvrb_plan_snapshot 还没有 inputs_sig 列 ⇒ 本会话降级读写' +
            '（不影响结论存取；执行 db/create_tvrb_plan_snapshot.sql 第三版后刷新即恢复完整校验）');
        out = await run(SEL_BASE);
        data = out.data; error = out.error;
    }
    if (error) {
        if (_isMissingTable(error)) {
            _tableMissing = true;
            _dbgLog('[TVRB-SNAPSHOT] 表 ' + PLAN_SNAPSHOT_TABLE +
                ' 不存在 ⇒ 本次会话历史日期按恒竞价口径重算（执行 db/create_tvrb_plan_snapshot.sql 后即生效）');
            return { status: 'unavailable', reason: 'table-missing' };
        }
        // §10 读取失败 ≠ 空数据
        _dbgLog('[TVRB-SNAPSHOT] 读取 ' + d + ' 失败：' + (error.message || error));
        return { status: 'error', reason: String(error.message || error) };
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { status: 'empty' };
    return { status: 'hit', row: row };
}

/**
 * 读取某日定稿快照（带会话缓存 + 单飞）。
 *
 * ⚠️ 返回的是【原始状态】，解码 / 结构校验由 Logic 层 `plan-snapshot-codec.js` 负责（§2 分层）。
 * ⚠️ error / unavailable 不写缓存：下次切回该日还能再试一次（§10 一次失败不能记成永久结论）。
 *
 * @param {string} date YYYY-MM-DD
 */
export async function readPlanSnapshot(date) {
    const d = String(date || '').trim();
    if (!d) return { status: 'error', reason: 'empty-date' };
    if (_tableMissing) return { status: 'unavailable', reason: 'table-missing' };
    const hit = _cache.get(d);
    if (hit !== undefined) {
        return hit ? { status: 'hit', row: hit } : { status: 'empty' };
    }
    const fly = _inflight.get(d);
    if (fly) return fly;
    const p = _fetchOne(d).then(function (r) {
        if (r.status === 'hit') _cache.set(d, r.row);
        else if (r.status === 'empty') _cache.set(d, null);
        return r;
    }).finally(function () {
        if (_inflight.get(d) === p) _inflight.delete(d);
    });
    _inflight.set(d, p);
    return p;
}

/**
 * 写入 / 修订某日的定稿快照（**任何日期**，含历史日期复盘重算）。
 *
 * 🔴 不再是「只写今天、只写一次」：用户明确要求「历史日期既然能计算出来也要存起来」，
 *    且「核心词同义词变更 ⇒ 选票结果也要变（这是我本身纠错行为）」。
 *    ⇒ `ignoreDuplicates` 已删除，正常 `upsert(on_conflict=date)` 允许修订。
 *
 * ⚠️ 「能不能覆盖」由 Logic 层 `shouldPersistPlanSnapshot` 判定后才调用本函数：
 *    读档失败 / 表不存在 / 降级结论 / 结论与规则都没变 ⇒ 调用方根本不会走到这里（§11）。
 * ⚠️ 不传 `created_at`：新行由 DB default 填首次时间；覆盖旧行时保持原值（修订留痕）。
 *
 * @param {string} date
 * @param {object} plain 已由 encodePlanSnapshot 编码过的纯 JSON 对象
 * @param {object} meta { rulesSig, selectionSig, inputsSig, revision }
 * @returns {Promise<boolean>} 是否真的写成功了
 */
export async function writePlanSnapshot(date, plain, meta) {
    const d = String(date || '').trim();
    if (!d || !plain || typeof plain !== 'object') return false;
    if (_tableMissing) return false;
    const m = meta || {};
    const payload = {
        date: d,
        plan: plain,
        leg: 'auc',
        source: 'tvrb-board',
        rules_sig: String(m.rulesSig || '').trim(),
        selection_sig: String(m.selectionSig || '').trim(),
        // ★ [SNAPSHOT-INPUTS 2026-11-11] 输入完整度指纹：数据从残缺变完整时靠它判 stale，
        //   避免把「auc 腿缺失 / 补位池空」时算出的残缺结论永久冻结（11-11 实证）。
        inputs_sig: String(m.inputsSig || '').trim(),
        revision: Math.max(1, Number(m.revision) || 1),
        settled_at: new Date().toISOString()
    };
    let error = null;
    const doUpsert = async function (p) {
        try {
            const res = await getSupabase()
                .from(PLAN_SNAPSHOT_TABLE)
                .upsert(p, { onConflict: 'date' });
            return res.error;
        } catch (e) {
            return e;
        }
    };
    const p1 = Object.assign({}, payload);
    if (_inputsSigMissing) delete p1.inputs_sig;
    error = await doUpsert(p1);
    // ★ [SNAPSHOT-INPUTS] 库里还没这一列 ⇒ 去掉该字段重试一次，⛔ 不许因为新增列写不进结论
    if (error && !_inputsSigMissing && _isMissingColumn(error, 'inputs_sig')) {
        _inputsSigMissing = true;
        _dbgLog('[TVRB-SNAPSHOT] tvrb_plan_snapshot 还没有 inputs_sig 列 ⇒ 本会话写入降级' +
            '（结论照常存档；执行 db/create_tvrb_plan_snapshot.sql 第三版后刷新即恢复完整校验）');
        const p2 = Object.assign({}, payload);
        delete p2.inputs_sig;
        error = await doUpsert(p2);
    }
    if (error) {
        if (_isMissingTable(error)) {
            _tableMissing = true;
            _dbgLog('[TVRB-SNAPSHOT] 表 ' + PLAN_SNAPSHOT_TABLE +
                ' 不存在 ⇒ 写入跳过（执行 db/create_tvrb_plan_snapshot.sql 后即生效）');
            return false;
        }
        _dbgLog('[TVRB-SNAPSHOT] 写入 ' + d + ' 失败：' + (error.message || error));
        return false;
    }
    // 写成功 ⇒ 会话缓存同步（下次读立刻命中新版本），并保留首次 created_at（§11 留痕）
    const prev = _cache.get(d);
    _cache.set(d, Object.assign({}, payload, {
        created_at: (prev && prev.created_at) ? prev.created_at : payload.settled_at
    }));
    return true;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用）。不清 _tableMissing（会话级结论）。 */
export function clearPlanSnapshotCache() {
    _cache.clear();
    _inflight.clear();
}

/** 仅测试用：把「表不存在」结论复位 */
export function _resetPlanSnapshotTableMissing() {
    _tableMissing = false;
}

/** 仅测试用：把「缺 inputs_sig 列」降级结论复位（模拟用户执行完第三版 DDL 后刷新页面） */
export function _resetPlanSnapshotColumns() {
    _inputsSigMissing = false;
}

/**
 * 当前会话是否支持 `inputs_sig` 列（false = 库里还没这一列，已降级）。
 *
 * 消费者：composable 的新鲜度判定 —— 不支持时⛔ 不能拿「存档里没有 inputs_sig」当过期，
 * 否则每次打开页面都会判 stale 重算一遍（降级模式下永远补不上这一列）。
 */
export function isPlanSnapshotInputsSigSupported() {
    return !_inputsSigMissing;
}
