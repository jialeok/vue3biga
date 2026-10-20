// stock-range20-cache.js — 「20日涨幅」结果表 stock_range20_pct 的唯一读写入口（Data 层，§5）
//
// 职责：把 range20.js / range20-leaders.js 算好的 20 日涨幅按 (date, stock) 缓存到云端，
//   让「第二次打开应用 / 切回某天 / 换台设备」不必再打同花顺 K 线。
//
// ★ 与 stock_range_pct（十日涨幅）**必须是两张表**（见 db/create_stock_range20_pct.sql 头部）：
//   那张表主键 (date,stock)、days 只有 10/8/9/7/6，20 日结果写进去会覆盖十天口径的行 ⇒
//   污染十日涨幅 / 龙位 / 决策看板 / 卖点段。§6 单一真相不允许这种混写。
//
// 🔴 本模块是【加速层】，不是真相源 —— 所以：
//   · 读取失败 ⇒ 返回 null（调用方降级为纯内存计算），⛔ 绝不 throw、⛔ 绝不当成「这天没有数据」；
//   · 表不存在 ⇒ 只记一次告警、本会话不再重试（否则每次都要白打一次失败的 REST）；
//   · 写入失败 ⇒ 静默（下次打开重算一遍而已，不影响正确性）。
//   对照：`stock-range-pct.js#readRangePctForDate` 失败必须 throw（那边是真相源，空 Map 会被误读成
//   「这天没算过」⇒ 重复消耗猫抓额度）。两个模块的失败语义刻意不同，⛔ 别"统一"。
//
// ★ leg（口径）列是本模块的第二条命脉：
//   'auc' = 盘中口径（前 19 日收盘 × 今天竞价），'close' = 收盘口径（20 日全收盘）。
//   读取时必须按【当前时刻应有的口径】过滤 —— leg 不匹配的行一律视为「还没有」，
//   否则收盘后会一直显示早上那份「前19收盘 × 今天竞价」的数（正是用户反馈过的现象）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** date -> Map<stock, {pct:number|null, days:number, leg:string}>（会话内第二层缓存，命中即同步） */
const _cache = new Map();
/** 单飞：date -> Promise（同一日期并发读只发一次请求） */
const _inflight = new Map();
/** 会话内 LRU 上限（与 stock-range-pct 同款：留 12 个日期覆盖「当前 + 前后几天」） */
const CACHE_MAX = 12;
/** 表不存在的告警只打一次（生产站首次部署、用户还没跑 SQL 时会出现） */
let _missingWarned = false;
/**
 * 读失败的冷却截止时刻（ms）。
 *
 * 🔴 为什么需要：用户还没在 Supabase 跑 `db/create_stock_range20_pct.sql` 时，每次
 *   `ensureRange20`（打开应用 / 切日期 / 名单变化）都会白打一次注定失败的 REST（~200ms+）。
 *   冷却 30s 后再试 —— 用户跑完 SQL 最多等半分钟自动恢复，不用刷新页面。
 *   ⛔ 别改成「本会话永久放弃」：那样用户建完表必须刷新才生效，反而更差。
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
export function clearRange20Cache() {
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
        .from('stock_range20_pct')
        .select('stock,pct,days,leg')
        .eq('date', date);
    if (error) throw error;
    const map = new Map();
    (data || []).forEach(function(r) {
        if (!r || !r.stock) return;
        const name = String(r.stock).trim();
        if (!name) return;
        map.set(name, {
            pct: _num(r.pct),
            days: Number(r.days) || 0,
            leg: r.leg ? String(r.leg) : 'close'
        });
    });
    return map;
}

/**
 * 读取某日已缓存的 20 日涨幅（会话内缓存 + 单飞）。
 *
 * @param {string} date 窗口结束日 T
 * @returns {Promise<Map<string,{pct:number|null, days:number, leg:string}>|null>}
 *          null = 缓存层不可用（读失败 / 表不存在）⇒ 调用方按纯内存路径继续算，⛔ 不要当空数据处理
 */
export async function readRange20Rows(date) {
    const d = String(date || '').trim();
    if (!d) return new Map();
    const hit = _cache.get(d);
    if (hit) return hit;
    const fly = _inflight.get(d);
    if (fly) return fly;
    // 上次读失败还在冷却期 ⇒ 直接降级（⛔ 不重复打注定失败的请求）
    if (Date.now() < _cooldownUntil) return null;
    const p = _fetch(d).then(function(map) {
        _cooldownUntil = 0;
        _putCache(d, map);
        return map;
    }).catch(function(e) {
        // §10：这是加速层 ⇒ 失败不 throw，返回 null 让调用方降级。
        //   ⛔ 不写缓存：一次失败不能被记成「这天没有缓存」。
        _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[RANGE20-CACHE] stock_range20_pct 不可用（降级为纯内存计算，30s 后自动重试）：'
                + (e && e.message || e));
        }
        return null;
    }).finally(function() {
        if (_inflight.get(d) === p) _inflight.delete(d);
    });
    _inflight.set(d, p);
    return p;
}

/**
 * 按【当前口径】过滤出可直接使用的行。
 *
 * @param {Map<string,{pct:number|null, days:number, leg:string}>|null} map readRange20Rows 的结果
 * @param {'auc'|'close'} leg 当前时刻应有的口径
 * @returns {Map<string,{pct:number, days:number}>} 只含「口径匹配 ∧ 有数值」的票
 */
export function pickUsableRows(map, leg) {
    const out = new Map();
    if (!map || !map.size) return out;
    const want = leg === 'auc' ? 'auc' : 'close';
    map.forEach(function(v, name) {
        if (!v || v.leg !== want) return;          // 🔴 口径不匹配 ⇒ 视为「还没有」，触发重算
        if (v.pct === null || v.pct === undefined || isNaN(v.pct)) return;
        out.set(name, { pct: v.pct, days: v.days || 0 });
    });
    return out;
}

/**
 * 批量写入（upsert）某日的 20 日涨幅。
 *
 * @param {string} date
 * @param {Array<{stock:string, pct:number|null, days:number}>} rows 只传算出来的票（⛔ 不要传 null 行）
 * @param {'auc'|'close'} leg 本批数据用的口径
 * @returns {Promise<number>} 写入行数；失败返回 0（静默，不影响页面）
 */
export async function upsertRange20Rows(date, rows, leg) {
    const d = String(date || '').trim();
    const want = leg === 'auc' ? 'auc' : 'close';
    const list = (rows || []).filter(function(r) {
        return r && r.stock && r.pct !== null && r.pct !== undefined && !isNaN(r.pct);
    });
    if (!d || list.length === 0) return 0;
    const nowIso = new Date().toISOString();
    const payload = list.map(function(r) {
        return {
            date: d,
            stock: String(r.stock).trim(),
            pct: Number(r.pct).toFixed(2),
            days: Number(r.days) || 0,
            leg: want,
            updated_at: nowIso
        };
    });
    try {
        const sb = getSupabase();
        const { error } = await sb
            .from('stock_range20_pct')
            .upsert(payload, { onConflict: 'date,stock' });
        if (error) throw error;
        // 写成功 ⇒ 该日会话缓存作废（保证「自己写、自己马上读」拿到新值）
        _cache.delete(d);
        _inflight.delete(d);
        return payload.length;
    } catch (e) {
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[RANGE20-CACHE] 写入失败（不影响页面，下次打开会重算）：' + (e && e.message || e));
        }
        return 0;
    }
}
