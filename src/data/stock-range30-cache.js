// stock-range30-cache.js — 「30日涨幅」结果表 stock_range30_pct 的唯一读写入口（Data 层，§5）
//
// 职责：把 range30.js 算好的 30 日涨幅按 (date, stock, leg) 缓存到云端，
//   让「第二次打开应用 / 切回某天 / 换台设备」不必再拉一遍腾讯 K 线。
//
// 🔴 本模块是【加速层】，不是真相源 —— 与 stock-range20-cache.js 逐字同款语义：
//   · 读取失败 ⇒ 返回 null（调用方降级为纯内存计算），⛔ 绝不 throw、⛔ 绝不当成「这天没有数据」；
//   · 表不存在 ⇒ 只记一次告警 + 30s 冷却（用户跑完 db/create_stock_range30_pct.sql 自动恢复）；
//   · 写入失败 ⇒ 静默（下次打开重算一遍而已，不影响正确性）。
//
// ⚠️ 与 `stock-range20-cache.js` 的区别：本表【只落 close 口径】。
//   竞价口径（9:26）不落库 —— 它依赖当天的竞价涨幅，落库就等于存了一份会过期的假收盘腿；
//   读取时由 `range30-auction-leg.js` 用 recoverAuctionLeg 实时反解（与十日/二十日同一把尺子，§6）。
//   ⇒ 所以这里不像 range20 那样做 byLeg 合并，rows 一律按 leg='close' 读写。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

const TABLE = 'stock_range30_pct';
const LEG = 'close';

/** date -> Map<stock, {pct:number|null, days:number}>（会话内第二层缓存，命中即同步） */
const _cache = new Map();
/** 单飞：date -> Promise（同一日期并发读只发一次请求） */
const _inflight = new Map();
/** 会话内 LRU 上限（与 range20 同款：留 12 个日期覆盖「当前 + 前后几天」） */
const CACHE_MAX = 12;
/** 表不存在的告警只打一次（生产站首次部署、用户还没跑 SQL 时会出现） */
let _missingWarned = false;
/**
 * 读失败冷却截止时刻（ms）。
 * 🔴 与 range20 同款理由：用户还没跑 SQL 时，每次 ensureRange30 都会白打一次注定失败的 REST。
 *   冷却 30s 后再试 —— 跑完 SQL 最多等半分钟自动恢复，不用刷新页面。
 */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;

function _putCache(date, map) {
    _cache.set(date, map);
    while (_cache.size > CACHE_MAX) {
        const oldest = _cache.keys().next().value;
        if (oldest === undefined) break;
        _cache.delete(oldest);
    }
}

/** 清空会话缓存（仅供测试 / 切账户时调用） */
export function clearRange30Cache() {
    _cache.clear();
    _inflight.clear();
    _cooldownUntil = 0;
    _missingWarned = false;
}

/** 数值解析：'%'/'+' 兼容；空 / 非法 ⇒ null（⛔ 不返回 0） */
function _num(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(String(raw).replace('%', '').replace('+', ''));
    return isNaN(n) ? null : n;
}

async function _fetch(date) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from(TABLE)
        .select('stock,pct,days,leg')
        .eq('date', date)
        .eq('leg', LEG);
    if (error) throw error;
    const map = new Map();
    (data || []).forEach(function (r) {
        if (!r || !r.stock) return;
        const name = String(r.stock).trim();
        if (!name) return;
        const pct = _num(r.pct);
        if (pct === null) return;              // 算不出的行不参与（§10：缺值 ≠ 0）
        map.set(name, { pct: pct, days: Number(r.days) || 0 });
    });
    return map;
}

/**
 * 读取某日已缓存的 30 日涨幅（会话内缓存 + 单飞）。
 *
 * @param {string} date 窗口结束日 T
 * @returns {Promise<Map<string,{pct:number, days:number}>|null>}
 *          null = 缓存层不可用（读失败 / 表不存在）⇒ 调用方按纯内存路径继续算，⛔ 不要当空数据处理
 */
export async function readRange30Rows(date) {
    const d = String(date || '').trim();
    if (!d) return new Map();
    const hit = _cache.get(d);
    if (hit) return hit;
    const fly = _inflight.get(d);
    if (fly) return fly;
    // 上次读失败还在冷却期 ⇒ 直接降级（⛔ 不重复打注定失败的请求）
    if (Date.now() < _cooldownUntil) return null;
    const p = _fetch(d).then(function (map) {
        _cooldownUntil = 0;
        _putCache(d, map);
        return map;
    }).catch(function (e) {
        // §10：这是加速层 ⇒ 失败不 throw，返回 null 让调用方降级。
        //   ⛔ 不写缓存：一次失败不能被记成「这天没有缓存」。
        _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[RANGE30-CACHE] ' + TABLE + ' 不可用（降级为纯内存计算，30s 后自动重试）：'
                + (e && e.message || e));
        }
        return null;
    }).finally(function () {
        if (_inflight.get(d) === p) _inflight.delete(d);
    });
    _inflight.set(d, p);
    return p;
}

/**
 * 批量写入（upsert）某日的 30 日涨幅（只写 close 口径）。
 *
 * @param {string} date
 * @param {Array<{stock:string, pct:number|null, days:number}>} rows 只传算出来的票（⛔ 不要传 null 行）
 * @returns {Promise<number>} 写入行数；失败返回 0（静默，不影响页面）
 */
export async function upsertRange30Rows(date, rows) {
    const d = String(date || '').trim();
    const list = (rows || []).filter(function (r) {
        return r && r.stock && r.pct !== null && r.pct !== undefined && !isNaN(r.pct);
    });
    if (!d || list.length === 0) return 0;
    const nowIso = new Date().toISOString();
    const payload = list.map(function (r) {
        return {
            date: d,
            stock: String(r.stock).trim(),
            pct: Number(r.pct).toFixed(2),
            days: Number(r.days) || 0,
            leg: LEG,
            updated_at: nowIso
        };
    });
    try {
        const sb = getSupabase();
        const { error } = await sb
            .from(TABLE)
            // 主键 (date,stock,leg) ⇒ onConflict 必须带 leg，否则 42P10 整批一行不写
            // （range20 在 2026-11-11 踩过这个坑，这里提前对齐）。
            .upsert(payload, { onConflict: 'date,stock,leg' });
        if (error) throw error;
        // 写成功 ⇒ 该日会话缓存作废（保证「自己写、自己马上读」拿到新值）
        _cache.delete(d);
        _inflight.delete(d);
        return payload.length;
    } catch (e) {
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[RANGE30-CACHE] 写入失败（不影响页面，下次打开会重算）：' + (e && e.message || e));
        }
        return 0;
    }
}
