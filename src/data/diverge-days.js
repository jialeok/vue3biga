// diverge-days.js — 「题材量比」看板 · 【总龙分歧判定表】tvrb_diverge_days 的唯一读写入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有这张表（2026-10-21 用户口径）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   用户报障：切到历史日期（如 10-19）时，买点侧先按旧规则渲染出常规选票，停顿几秒后
//   才换成「总龙首次分歧」提示板 —— 因为分歧判定要等总龙的 K 线（同花顺免费通道，~11s）。
//   用户原话：「逻辑没有错，但是显示上有问题，就不能直接显示正确的吗？」
//
// ⇒ 结论（与 tvrb_ebb_days 同一条拍板）：把【每天算出来的分歧判定】落库。
//   判定对历史日是【确定性】的（K 线历史不可变 + 竞价涨幅 9:25 后不变）⇒ 读回即用：
//   再切回该日时【一次到位】直接渲染分歧板，连 K 线都不用等；配合组合式的「判定未就绪 ⇒
//   买点侧先挂『判定计算中』占位、不渲染旧样式」门控，任何路径都不会再出现旧样式闪现。
//
// ── 表结构（建表 SQL：db/create_tvrb_diverge_days.sql）────────────────────────────────
//   date (pk) / leader_stock / leader_topic / can_judge / today_first /
//   first_board_ymd / first_divergence_ymd / today_auc_pct / updated_at
//   · can_judge    = 判据链走通了没有（false 的行【不写】—— §10 绝不落一行「猜的」判定）
//   · today_first  = 该日是不是总龙的【首次分歧日】（true ⇒ 该日买点侧 = 分歧板）
//   · first_board_ymd / first_divergence_ymd = 首板日 / 首次分歧日（留痕复核用）
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────────
//   · ⛔ 只读写本表；不碰其它表、不改任何行情事实（分歧判定是【结论】，不是数据本身）。
//   · §10：读取失败必须 throw（⛔ 不返回 null 假装「没有记录」）—— 上层据此继续走 K 线链路并留痕；
//     唯一的例外是「表还不存在」（部署前置）⇒ 本会话不再重试、直接走 K 线链路（§32）。
//   · §32：按日期【会话内缓存 + 单飞】，同一日期只请求一次。
//   · §11 删除安全：本模块只 select / upsert，⛔ 绝无 delete。
//   · 为什么【历史日也写】：分歧判定对历史日是确定性的（与退潮判定「suspend 只对今天可信」
//     不同 —— 本判定不依赖当日上游快照，全部输入来自不可变的 K 线历史）⇒ 写历史日是安全的，
//     而且正是用户「翻历史日期一次到位」诉求的根基。⛔ can_judge=false 恒不写。
//
// 状态范式与 ebb-days / stock-range-pct 一致（Data 层只读写自己那张表）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（唯一出处：建表 SQL 与代码都从这里对，⛔ 别在别处再写一次字符串） */
export const DIVERGE_DAYS_TABLE = 'tvrb_diverge_days';

/** 列清单（与建表 SQL 一一对应；⛔ 加列必须同时改 SQL 与这里） */
const COLS = 'date,leader_stock,leader_topic,can_judge,today_first,first_board_ymd,first_divergence_ymd,today_auc_pct,updated_at';

/** 表不存在（PGRST205 / 42P01 / 404）⇒ 冷却期内不再重试、直接走 K 线链路（§32 禁止反复请求不存在的表）
 *  ★ [2026-10-22 用户报障修复] 原实现是「会话级永久跳过」：用户在建表【前】打开的页面（SPA 长开不刷新）
 *    会永远记住「没有这张表」⇒ 建表后判定依旧每次重算、永远不落库。
 *    改成【10 分钟冷却窗】：冷却期内不发请求（§32 语义不变），过期后自动再探一次 ——
 *    失败则续一个冷却期，成功则本会话恢复正常读写。⇒ 建表后最多 10 分钟自愈，无需刷新页面。 */
const TABLE_MISSING_COOLDOWN_MS = 10 * 60 * 1000;
let _tableMissingUntil = 0;

/** 现在是否处于「表不存在」冷却期（冷却过期 ⇒ 自动重新探测一次） */
function _tableMissing() {
    return Date.now() < _tableMissingUntil;
}

function _markTableMissing() {
    _tableMissingUntil = Date.now() + TABLE_MISSING_COOLDOWN_MS;
    _dbgLog('[DIVERGE-DAYS] 表 ' + DIVERGE_DAYS_TABLE +
        ' 不存在（或还没建）⇒ ' + Math.round(TABLE_MISSING_COOLDOWN_MS / 60000) +
        ' 分钟内不再重试、直接走 K 线链路（执行 db/create_tvrb_diverge_days.sql 后最迟 10 分钟自动恢复）');
}

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
        canJudge: !!r.can_judge,
        todayFirst: !!r.today_first,
        firstBoardYmd: String(r.first_board_ymd || ''),
        firstDivergenceYmd: String(r.first_divergence_ymd || ''),
        todayAucPct: _num(r.today_auc_pct),
        updatedAt: r.updated_at || ''
    };
}

/** 真正发请求那一段（查完顺手把结果 / 空结果写进会话缓存） */
async function _fetchDays(miss) {
    let data = null;
    let error = null;
    try {
        const res = await getSupabase().from(DIVERGE_DAYS_TABLE).select(COLS).in('date', miss);
        data = res.data;
        error = res.error;
    } catch (e) {
        error = e;
    }
    if (error) {
        if (_isMissingTable(error)) {
            _markTableMissing();
            return new Map();
        }
        // §10：读取失败必须抛（⛔ 不静默成空 —— 上层要能区分「没记录」与「读失败」）
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
 * 读取【若干日期】的分歧判定。
 *
 * @param {string[]} dates YYYY-MM-DD 列表
 * @returns {Promise<Map<string, object>>} date -> row；⛔ 表里没有记录的日期【不放键】
 *          （调用方 `map.get(d) === undefined` 即「那天没有记录」）
 * @throws 读取失败（除「表不存在」外）时抛错 —— 由调用方决定降级
 */
export async function readDivergeDays(dates) {
    const out = new Map();
    const list = Array.from(new Set((dates || []).filter(function(d) { return !!d; })));
    if (list.length === 0) return out;
    if (_tableMissing()) return out;        // 冷却期内已知没有这张表 ⇒ 不再发请求（§32）

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

/** 便捷读取【一天】的分歧判定；没有记录 ⇒ null（表不存在 / 读失败向上抛，调用方决定降级） */
export async function readDivergeDay(date) {
    if (!date) return null;
    const m = await readDivergeDays([date]);
    return m.get(String(date)) || null;
}

/**
 * 写入（upsert）某一天的分歧判定。幂等：同一天重复写只是覆盖（onConflict: date）。
 *
 * ⚠️ 调用时机（唯一）：组合式的分歧判定链【真的算出 canJudge=true 的结论】之后 ——
 *   ⛔ 绝不放在 computed 里（computed 必须无副作用，§4）；⛔ can_judge=false 恒不写（§10 不落猜的判定）。
 * ⚠️ 失败【不抛给调用方】也不阻断看板：落库是「给下次切换用的」，本次展示不该因为写不进去而失败
 *   （但必须留痕，§10 禁止静默失败）。
 *
 * @param {object} row 业务形状（见 _normalize 的键；date 必填）
 * @returns {Promise<boolean>} 是否真的写成功了
 */
export async function upsertDivergeDay(row) {
    if (!row || !row.date) return false;
    // §10：判不出的结论绝不落库（那会伪装成「该日已判」）。
    // ★ [DIVERGE-DAYS-FIX 2026-10-22] 被闸拦截必须留痕 —— 本闸曾把【漏传 canJudge 字段】的
    //   正常写入也静默拦掉（表恒 0 行、零线索，排查代价极大）。留一条日志，§10 失败可见。
    if (!row.canJudge) {
        _dbgLog('[DIVERGE-DAYS] 拒写 ' + (row && row.date) + '：row.canJudge 非真（判不出 / 调用方漏传字段）');
        return false;
    }
    if (_tableMissing()) return false;
    const payload = {
        date: String(row.date),
        leader_stock: row.leaderStock || null,
        leader_topic: row.leaderTopic || null,
        can_judge: true,
        today_first: !!row.todayFirst,
        first_board_ymd: row.firstBoardYmd || null,
        first_divergence_ymd: row.firstDivergenceYmd || null,
        today_auc_pct: _num(row.todayAucPct),
        updated_at: new Date().toISOString()
    };
    let error = null;
    try {
        const res = await getSupabase().from(DIVERGE_DAYS_TABLE).upsert(payload, { onConflict: 'date' });
        error = res.error;
    } catch (e) {
        error = e;
    }
    if (error) {
        if (_isMissingTable(error)) {
            _markTableMissing();
            return false;
        }
        _dbgLog('[DIVERGE-DAYS] 写入 ' + row.date + ' 失败：' + (error.message || error));
        return false;
    }
    _cache.set(payload.date, _normalize(payload));   // 写成功 ⇒ 会话缓存同步（下次读立刻命中）
    return true;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用）。不清 `_tableMissingUntil`（那是会话级结论）。 */
export function clearDivergeDaysCache() {
    _cache.clear();
    _inflight.clear();
}

/** 仅测试用：把「表不存在」冷却期复位（正常流程不需要） */
export function _resetDivergeDaysTableMissing() {
    _tableMissingUntil = 0;
}
