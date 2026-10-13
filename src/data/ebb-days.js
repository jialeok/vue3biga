// ebb-days.js — 「题材量比」看板 · 【退潮判定表】tvrb_ebb_days 的唯一读写入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有这张表（2026-10-14 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「还有就是，我说的规则是，市场总龙头【首日】出现停牌或者占比不达标的情况下，这个规则才有效，
//     又比如明天可能新华传媒又停牌，那就不算了，我说的是首日注意了。」
//   （追问「取不到昨日状态怎么办」时用户答）：
//   「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断没有竞价量等
//     判断出来的，是缓存吧？你要完善这点」
//
// ⇒ 结论：把【每天算出来的退潮判定】落库，第二天要判「是不是首日」时直接读那一行，
//   而不是临时去内存 / 行情行里猜。
//
// ── 表结构（建表 SQL：db/create_tvrb_ebb_days.sql）────────────────────────────────────
//   date (pk) / leader_stock / leader_topic / leader_pct / leader_rank /
//   suspended / share / share_fail / ebb / buy_second / buy_second_pct / source / updated_at
//   · leader_stock = 那天算出来的【市场总龙】（昨日十日涨幅第一、有龙位）
//   · suspended    = 那天它【当日】是否停牌（suspend.js 的判定）
//   · share/share_fail = 那天它【当日】竞价占比 / 是否不达标
//   · ebb          = suspended || share_fail（那天算不算退潮）
//   · buy_second   = 那天买点侧唯一那只（当日十日涨幅第二）—— 留痕，供复核
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────────
//   · ⛔ 只读写本表；不碰其它表、不改任何行情事实（退潮判定是【结论】，不是数据本身）。
//   · §10：读取失败必须 throw（⛔ 不返回空 Map 假装「没有记录」）—— 上层据此退回推断口径并留痕；
//     唯一的例外是「表还不存在」（部署前置）⇒ 本会话不再重试、直接走退路（§32）。
//   · §32：按日期【会话内缓存 + 单飞】，同一批日期只请求一次。
//   · §11 删除安全：本模块只 select / upsert，⛔ 绝无 delete。
//
// 状态范式与 stock-range-pct / dragon-rank 一致（Data 层只读写自己那张表）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（唯一出处：建表 SQL 与代码都从这里对，⛔ 别在别处再写一次字符串） */
export const EBB_DAYS_TABLE = 'tvrb_ebb_days';

/** 列清单（与建表 SQL 一一对应；⛔ 加列必须同时改 SQL 与这里） */
const COLS = 'date,leader_stock,leader_topic,leader_pct,leader_rank,suspended,share,share_fail,ebb,buy_second,buy_second_pct,source,updated_at';

/** 表不存在（PGRST205 / 42P01 / 404）⇒ 本会话不再重试、直接走退路（§32 禁止反复请求不存在的表） */
let _tableMissing = false;

/** 会话内按日期缓存：date -> row | null（null = 这一天表里确实没有行，避免反复重查） */
const _cache = new Map();
/** 单飞：key(日期列表) -> Promise<Map<date,row>> */
const _inflight = new Map();

/** 该错误是不是「表不存在」（PostgREST 对未知表的回答） */
function _isMissingTable(error) {
    if (!error) return false;
    const code = String(error.code || '');
    const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
    return code === 'PGRST205' || code === '42P01' || /could not find the table|does not exist|schema cache/i.test(msg);
}

function _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/** 表里的行 → 业务形状（字段名收口在这里，⛔ 上层不直接读 snake_case） */
function _normalize(r) {
    return {
        date: String(r.date),
        leaderStock: String(r.leader_stock || ''),
        leaderTopic: String(r.leader_topic || ''),
        leaderPct: _num(r.leader_pct),
        leaderRank: _num(r.leader_rank),
        suspended: !!r.suspended,
        share: _num(r.share),
        shareFail: !!r.share_fail,
        ebb: !!r.ebb,
        buySecond: String(r.buy_second || ''),
        buySecondPct: _num(r.buy_second_pct),
        source: String(r.source || ''),
        updatedAt: r.updated_at || ''
    };
}

/** 真正发请求那一段（查完顺手把结果 / 空结果写进会话缓存） */
async function _fetchDays(miss) {
    let data = null;
    let error = null;
    try {
        const res = await getSupabase().from(EBB_DAYS_TABLE).select(COLS).in('date', miss);
        data = res.data;
        error = res.error;
    } catch (e) {
        error = e;
    }
    if (error) {
        if (_isMissingTable(error)) {
            _tableMissing = true;
            _dbgLog('[EBB-DAYS] 表 ' + EBB_DAYS_TABLE +
                ' 不存在 ⇒ 本次会话退回「按行情行推断」口径（执行 db/create_tvrb_ebb_days.sql 后即生效）');
            return new Map();
        }
        // §10：读取失败必须抛（⛔ 不静默成空 —— 那会把「读失败」伪装成「那天没退潮」）
        throw error;
    }
    const out = new Map();
    (data || []).forEach(function(r) {
        if (!r || !r.date) return;
        const row = _normalize(r);
        out.set(row.date, row);
    });
    // 查过但没返回的日期 → 记 null（「那天确实没记录」，下次不再白查一遍）
    miss.forEach(function(d) { _cache.set(d, out.get(d) || null); });
    out.forEach(function(v, k) { _cache.set(k, v); });
    return out;
}

/**
 * 读取【若干日期】的退潮判定。
 *
 * ⚠️ 一次读多天（而不是一天一次）：看板一次刷新要「今天的判定（准备写）」+
 *   「上一交易日的判定（判首日）」两天 —— 一次 `in` 查询就够（§32）。
 *
 * @param {string[]} dates YYYY-MM-DD 列表
 * @returns {Promise<Map<string, object>>} date -> row；⛔ 表里没有记录的日期【不放键】
 *          （调用方 `map.get(d) === undefined` 即「那天没有记录」）
 * @throws 读取失败（除「表不存在」外）时抛错 —— 由调用方决定降级
 */
export async function readEbbDays(dates) {
    const out = new Map();
    const list = Array.from(new Set((dates || []).filter(function(d) { return !!d; })));
    if (list.length === 0) return out;
    if (_tableMissing) return out;          // 本会话已知没有这张表 ⇒ 不再发请求（§32）

    const miss = [];
    list.forEach(function(d) {
        if (_cache.has(d)) {
            const v = _cache.get(d);
            if (v) out.set(d, v);
        } else {
            miss.push(d);
        }
    });
    if (miss.length === 0) return out;

    const key = miss.slice().sort().join('|');
    let fly = _inflight.get(key);
    if (!fly) {
        fly = _fetchDays(miss);
        _inflight.set(key, fly);
    }
    try {
        const m = await fly;
        m.forEach(function(v, k) { if (list.indexOf(k) >= 0) out.set(k, v); });
    } finally {
        if (_inflight.get(key) === fly) _inflight.delete(key);
    }
    return out;
}

/**
 * 写入（upsert）某一天的退潮判定。幂等：同一天重复写只是覆盖（onConflict: date）。
 *
 * ⚠️ 调用时机（唯一）：看板算出某天的退潮事实之后（组合式里的 watch）——
 *   ⛔ 绝不放在 computed 里（computed 必须无副作用，§4）。
 * ⚠️ 失败【不抛给调用方】也不阻断看板：落库是「给明天用的」，今天这次展示不该因为写不进去而失败
 *   （但必须留痕，§10 禁止静默失败）。
 *
 * @param {object} row 业务形状（见 _normalize 的键；date 必填）
 * @returns {Promise<boolean>} 是否真的写成功了
 */
export async function upsertEbbDay(row) {
    if (!row || !row.date) return false;
    if (_tableMissing) return false;
    const payload = {
        date: String(row.date),
        leader_stock: row.leaderStock || null,
        leader_topic: row.leaderTopic || null,
        leader_pct: _num(row.leaderPct),
        leader_rank: _num(row.leaderRank),
        suspended: !!row.suspended,
        share: _num(row.share),
        share_fail: !!row.shareFail,
        ebb: !!row.ebb,
        buy_second: row.buySecond || null,
        buy_second_pct: _num(row.buySecondPct),
        source: row.source || 'tvrb-board',
        updated_at: new Date().toISOString()
    };
    let error = null;
    try {
        const res = await getSupabase().from(EBB_DAYS_TABLE).upsert(payload, { onConflict: 'date' });
        error = res.error;
    } catch (e) {
        error = e;
    }
    if (error) {
        if (_isMissingTable(error)) {
            _tableMissing = true;
            _dbgLog('[EBB-DAYS] 表 ' + EBB_DAYS_TABLE +
                ' 不存在 ⇒ 写入跳过（执行 db/create_tvrb_ebb_days.sql 后即生效）');
            return false;
        }
        _dbgLog('[EBB-DAYS] 写入 ' + row.date + ' 失败：' + (error.message || error));
        return false;
    }
    _cache.set(payload.date, _normalize(payload));   // 写成功 ⇒ 会话缓存同步（下次读立刻命中）
    return true;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用）。不清 `_tableMissing`（那是会话级结论）。 */
export function clearEbbDaysCache() {
    _cache.clear();
    _inflight.clear();
}

/** 仅测试用：把「表不存在」结论复位（正常流程不需要） */
export function _resetEbbDaysTableMissing() {
    _tableMissing = false;
}
