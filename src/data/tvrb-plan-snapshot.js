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
//   date(pk) / plan(jsonb) / leg / source / settled_at / created_at
//
// ── 红线 ───────────────────────────────────────────────────────────────────
//   · §10：四种状态必须分清 —— hit(有存档) / empty(表里确实没有) / unavailable(表不存在) /
//     error(读失败或快照损坏)。⛔ 绝不允许把 error / unavailable 折成「没有存档」去重算还静默。
//   · §11：本模块只 select / upsert，⛔ 绝无 delete；写入 ignoreDuplicates ⇒ 先写的定稿永不被覆盖。
//   · §32：按日期会话内缓存 + 单飞，同一天只查一次。
//   · 写入失败不抛给调用方（今天这次展示不该因为存不上而失败），但必须留痕（§10 禁止静默）。
//
// 状态范式与 ebb-days.js 一致（Data 层只读写自己那张表）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（唯一出处：建表 SQL 与代码都从这里对，⛔ 别在别处再写一次字符串） */
export const PLAN_SNAPSHOT_TABLE = 'tvrb_plan_snapshot';

/** 表不存在（PGRST205 / 42P01 / 404）⇒ 本会话不再重试（§32） */
let _tableMissing = false;

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
    try {
        const res = await getSupabase()
            .from(PLAN_SNAPSHOT_TABLE)
            .select('date,plan,leg,source,settled_at')
            .eq('date', d)
            .limit(1);
        data = res.data;
        error = res.error;
    } catch (e) {
        error = e;
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
 * 写入【今天】的定稿快照。幂等且只写一次：ignoreDuplicates ⇒ 已有行绝不覆盖（用户硬口径）。
 *
 * ⚠️ 「只写今天 / 只在定稿时调用」由 Logic 层保证；这里再挡一道「已缓存则跳过」，
 *     避免同一会话因意外二次调用重复发请求（§32）。
 *
 * @param {string} date
 * @param {object} plain 已由 encodePlanSnapshot 编码过的纯 JSON 对象
 * @returns {Promise<boolean>} 是否真的写成功了
 */
export async function writePlanSnapshot(date, plain) {
    const d = String(date || '').trim();
    if (!d || !plain || typeof plain !== 'object') return false;
    if (_tableMissing) return false;
    if (_cache.get(d)) return false;          // 已有存档 ⇒ 不覆盖（§11）
    const payload = {
        date: d,
        plan: plain,
        leg: 'auc',
        source: 'tvrb-board',
        settled_at: new Date().toISOString()
    };
    let error = null;
    try {
        const res = await getSupabase()
            .from(PLAN_SNAPSHOT_TABLE)
            .upsert(payload, { onConflict: 'date', ignoreDuplicates: true });
        error = res.error;
    } catch (e) {
        error = e;
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
    _cache.set(d, payload);                   // 写成功 ⇒ 会话缓存同步（下次读立刻命中）
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
