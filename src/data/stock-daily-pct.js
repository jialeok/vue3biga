// stock-daily-pct.js — 「逐日收盘涨幅腿」表 stock_daily_pct 的唯一读写入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-30 原话，逐字保留）：
//   「为什么每次打开都要实时计算，非常耗时间，比如那些历史数据先存好，次日在算次日，
//     这样不更快吗？为什么每次都要同花顺实时重新拉取，拉取当天的就可以，再加上历史日期，
//     有些票不在当天正式列表的，看表里有没有数据，有的话看哪天没有补哪天，没有的话，就全补，
//     这样局部补数据，而不是每次整体获取，这样很慢，影响体验。」
//
// ⇒ 本模块存的是【原料】而不是【结果】：
//   `stock_range20_pct` 存「以 T 为窗口末日的 20 日涨幅」—— 每天都是新日期 ⇒ 每天都不命中
//   ⇒ 每天把全部票重拉一遍（实测：54 只 / 上游 50% 挂 15s / 142 秒只写成功 1 行）。
//   窗口涨幅【不可拆解】（复利不能相减），所以那张表再大也复不了。
//   逐日腿可以：今天 T 的窗口 = [T-19, T]，明天 T+1 的窗口 = [T-18, T+1]，共享 18 根。
// ======================================================================================
//
// 🔴 本模块是【原料层】，不是结论 —— 失败语义与 stock-range20-cache 完全一致：
//   · 读取失败 / 表不存在 ⇒ 返回 null（调用方降级为「全部走同花顺」，即改造前的行为）；
//     ⛔ 绝不 throw、⛔ 绝不当成「这天没有数据」（§10）。
//   · 表不存在 ⇒ 只记一次告警 + 30s 冷却（用户跑完 SQL 不必刷新页面）。
//   · 写入失败 ⇒ 静默（下次打开重算一遍而已，不影响正确性）。
//
// 🔴 为什么只接受「同花顺日线」这一个来源（2026-10-19 实测，⛔ 别贪方便塞库内值进来）：
//   `auction_watchlist.change_pct` 早盘写的是【竞价涨幅】，收盘后才被收盘涨幅覆盖；
//   未覆盖的历史行永久留竞价值，且只收录当天正式名单的票 ⇒ 大量历史日缺行。
//   实测澳弘电子 20 日窗口：按库内值复算 59.30%，按同花顺 K 线 117.38%（用户炒股软件 117.4%）。
//   ⇒ 本表只写 src='kline' 的腿。库内竞价值要进来，只能走「当天 T 腿」那条路（由 range20.js
//     的 resolveT20Leg 现场取，⛔ 不落本表 —— 落进来第二天就会被当成收盘腿复用了）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/**
 * 会话内缓存：`from|to` -> Map<stock, Map<date, pct>>（命中即同步返回，§32 不重复请求）
 * ⚠️ key 用「区间」而不是单日：20 日窗口每次要的是同一段区间，单日 key 会天天不命中。
 */
const _cache = new Map();
/** 单飞：`from|to` -> Promise */
const _inflight = new Map();
/** 会话内 LRU 上限（每个 key = 一段区间，12 段足够覆盖「当前 + 切换过的几天」） */
const CACHE_MAX = 12;
/** 表不存在的告警只打一次 */
let _missingWarned = false;
/**
 * [R20-SUBSET] 「只读这几只票」那条路的缓存（与上面的全市场缓存**完全隔离**，见 readDailyPctRowsFor）。
 * key = `from|to`；value = { names:Set<股票>, map:Map<股票, Map<日期, 涨幅>> }
 */
const _subCache = new Map();
const _subInflight = new Map();
/** 收窄读的缓存段数上限：看板一次会话最多切十几天 */
const SUB_CACHE_MAX = 8;
/** 读失败冷却截止时刻（ms）—— 用户还没跑 create_stock_daily_pct.sql 时不白打 REST */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;

function _putCache(key, map) {
    _cache.set(key, map);
    while (_cache.size > CACHE_MAX) {
        const oldest = _cache.keys().next().value;
        if (oldest === undefined) break;
        _cache.delete(oldest);
    }
}

/**
 * 作废「与这批写入日期有交集」的会话缓存区间。
 *
 * 🔴 [R20-CACHE-KEY 2026-10-30] 原来写成功就 `_cache.clear()` 全清 —— 看起来省事，实际很贵：
 *   本表一个窗口区间现在是 4000+ 行 / 4 个分页请求，而 K 线补算会**边补边写**。
 *   全清 ⇒ 紧接着的 `readDailyPctRows`（另一模块 leaders 也会调）又要重读 4 页
 *   ⇒ 「写一次 → 重读一次」来回打，页面首屏的读库次数被放大。
 *   ⇒ 只作废真正受影响的区间（key 是 `from|to`，字符串比较就够）。
 *
 * @param {string[]} dates 本批写入涉及的日期
 */
function _invalidateFor(dates) {
    if (!dates || dates.length === 0) return;
    let minD = dates[0], maxD = dates[0];
    dates.forEach(function(d) {
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
    });
    Array.from(_cache.keys()).forEach(function(k) {
        const parts = String(k).split('|');
        const f = parts[0], t = parts[1];
        // 区间与 [minD, maxD] 有交集才作废（字符串比较对 YYYY-MM-DD 安全）
        if (f <= maxD && t >= minD) _cache.delete(k);
    });
    // [R20-SUBSET] 收窄读的缓存段命名空间是隔离的，这里必须同步作废（否则刚写的腿读不到）
    Array.from(_subCache.keys()).forEach(function(k) {
        const parts = String(k).split('|');
        const f = parts[0], t = parts[1];
        if (f <= maxD && t >= minD) _subCache.delete(k);
    });
    _subInflight.clear();
}

/** 清空会话缓存（仅测试 / 切账户用） */
export function clearDailyPctCache() {
    _cache.clear();
    _inflight.clear();
    _subCache.clear();
    _subInflight.clear();
    _cooldownUntil = 0;
    _missingWarned = false;
}

/** 数值解析：'%' / '+' 兼容；空 / 非法 ⇒ null（⛔ 不返回 0） */
function _num(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(String(raw).replace('%', '').replace(/\+/g, ''));
    return isNaN(n) ? null : n;
}

/** 区间 key（统一成 YYYY-MM-DD，避免调用方传参格式差异造成假不命中） */
function _keyOf(from, to) {
    return String(from || '').trim() + '|' + String(to || '').trim();
}

/**
 * 在会话缓存里找一段【完全包含 [f, t]】的已读区间（[R20-COVER]）。
 * YYYY-MM-DD 是定长字符串，直接比大小即等于比日期。
 *
 * @returns {Map<string, Map<string, number>>|null}
 */
function _findCovering(f, t) {
    let best = null;
    let bestWidth = -1;
    Array.from(_cache.keys()).forEach(function(k) {
        const parts = String(k).split('|');
        const cf = parts[0], ct = parts[1];
        if (!(cf <= f && ct >= t)) return;
        // 多个都覆盖时取「最窄」的那个：切片要遍历它的股票集合，窄的更快
        const width = (ct < cf) ? 0 : (ct.length + cf.length + (ct > cf ? 1 : 0));
        if (best === null || width < bestWidth) { best = _cache.get(k); bestWidth = width; }
    });
    return best;
}

/**
 * 从已读区间里切出 [f, t] 那一段（不请求网络）。
 * 结构与 `readDailyPctRows` 的返回完全一致：`Map<股票, Map<日期, 日涨幅>>`。
 * 某只票在这个子区间里一根腿都没有 ⇒ 不放进去（与「读回来就是这样」等价）。
 */
function _sliceRange(src, f, t) {
    const out = new Map();
    if (!src || typeof src.forEach !== 'function') return out;
    src.forEach(function(dayMap, stock) {
        if (!dayMap || typeof dayMap.forEach !== 'function') return;
        let kept = null;
        dayMap.forEach(function(v, d) {
            const dd = String(d);
            if (dd < f || dd > t) return;
            if (!kept) kept = new Map();
            kept.set(dd, v);
        });
        if (kept) out.set(stock, kept);
    });
    return out;
}

/**
 * 分页把区间内所有逐日腿读回。
 *
 * 🔴 为什么必须分页（2026-10-30 实测，别删）：Supabase/PostgREST 单次响应**最多 1000 行**
 *   （实测 `?limit=3000` 只回 1000 行，静默截断、不报错）。而本表一个 45 交易日 × 400 只票的
 *   窗口有 ~20000 行 ⇒ 不分页就只能拿到前 1000 行，表现为「一部分票有腿、一部分票永远缺腿
 *   ⇒ 永远在补、永远补不完」，而且**完全静默**（最难查的那种）。
 *   分页靠 Range + 确定性排序（order date,stock）保证不重不漏；按 4 页一批并行，
 *   20000 行 ≈ 5 轮 ≈ 1~2 秒，且整段区间会进会话缓存，切日期不重读。
 *
 * @param {object} sb supabase client
 * @param {string} f 起始日（含）
 * @param {string} t 结束日（含）
 * @returns {Promise<Array<{date:string,stock:string,pct:string}>>}
 */
async function _fetchAll(sb, f, t) {
    const PAGE = 1000;
    // ★ [R20-COVER-1 2026-10-30] 试过把并发提到 6 / 8 来压缩轮数，实测**当场把链路打爆**：
    //   8 并发连发 8 个「筛 15k 行 + order by」的重查询，undici 直接 UND_ERR_CONNECT_TIMEOUT，
    //   6 并发同样失败 ⇒ 这里保持 4（§11 不动既有行为）。
    //   真正要提速只能减少【行数】，不是加大并发：一行一票的聚合视图方案见读表函数头注释。
    const PARALLEL = 4;
    const page = async function(from) {
        const { data, error } = await sb
            .from('stock_daily_pct')
            .select('date,stock,pct')
            .gte('date', f)
            .lte('date', t)
            .order('date', { ascending: true })
            .order('stock', { ascending: true })
            .range(from, from + PAGE - 1);
        if (error) throw error;
        return data || [];
    };
    const out = [];
    let cursor = 0;
    for (;;) {
        const batch = [];
        for (let i = 0; i < PARALLEL; i++) batch.push(page(cursor + i * PAGE));
        const pages = await Promise.all(batch);
        let full = 0;
        pages.forEach(function(p) {
            out.push.apply(out, p);
            if (p.length === PAGE) full++;
        });
        // 有一页没满 ⇒ 到底了（后续页必然也是空的，⛔ 不用再请求）
        if (full < PARALLEL) break;
        cursor += PARALLEL * PAGE;
        if (cursor > 200000) break;             // 防御性上限（正常窗口远达不到）
    }
    return out;
}

/**
 * 读取 [from, to] 区间内、**只限这几只票**的逐日腿（会话缓存 + 单飞 + 覆盖命中）。
 *
 * ★★ [R20-SUBSET 2026-10-30] 为什么必须再开一条「按票收窄」的读法（⛔ 不是重复实现）：
 *   原料表现在有 414 只票 × 45 个交易日 ≈ 1.8 万行。看板只需要【屏幕上那几十只】的腿，
 *   而 `readDailyPctRows` 会把全市场都读回来（16 个分页请求 / 实测 19.0 秒）——
 *   盘中（T 腿口径 = 竞价，云端结果表里的 close 行命中不了）这是最大的那一笔开销。
 *   收窄到 42 只 ⇒ 42 × 45 ≈ 1900 行 ⇒ **2 个请求**（实测 1~2 秒），口径一字不动。
 *
 * ⚠️ 与 `readDailyPctRows` 的缓存**完全隔离**（`_subCache` / 前缀 `s|`）：
 *   两条路的 key 空间不能混 —— 一个「只有 42 只票」的区间如果被 `_findCovering` 当成
 *   能覆盖全市场的区间，`range20-leaders`（要 400 只）就会拿到缺失的票，而且是**静默**的。
 *   所以覆盖命中额外要求「已读的票集合 ⊇ 本次要的票集合」。
 *
 * @param {string[]} stocks 只读这些票（去重后）
 * @param {string} from 起始日（含）
 * @param {string} to   结束日（含）
 * @returns {Promise<Map<string, Map<string, number>>|null>}
 *          结构同 readDailyPctRows；null = 读失败 ⇒ 调用方回退到全量读（⛔ 不要当空数据）
 */
export async function readDailyPctRowsFor(stocks, from, to) {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    const names = [];
    const seen = new Set();
    (stocks || []).forEach(function(s) {
        const n = String(s || '').trim();
        if (!n || seen.has(n)) return;
        seen.add(n);
        names.push(n);
    });
    if (!f || !t || names.length === 0) return new Map();
    const key = f + '|' + t;
    const want = new Set(names);

    /** 只保留本次要的票 + 区间（复制成新 Map，⛔ 不要把缓存对象直接交出去） */
    const _slice = function(src) {
        const out = new Map();
        if (!src) return out;
        names.forEach(function(n) {
            const dm = src.get(n);
            if (!dm) return;
            const kept = new Map();
            dm.forEach(function(v, d) {
                const dd = String(d);
                if (dd >= f && dd <= t) kept.set(dd, v);
            });
            if (kept.size > 0) out.set(n, kept);
        });
        return out;
    };

    const hit = _subCache.get(key);
    if (hit && _isSubset(want, hit.names)) return _slice(hit.map);
    // 覆盖命中（区间更宽 + 票集合更全）⇒ 0 请求
    let best = null;
    Array.from(_subCache.entries()).forEach(function(e) {
        const parts = e[0].split('|');
        const cf = parts[0], ct = parts[1];
        if (!(cf <= f && ct >= t)) return;
        if (!_isSubset(want, e[1].names)) return;
        best = e[1];
    });
    if (best) return _slice(best.map);

    const fly = _subInflight.get(key + '|' + names.length);
    if (fly) return fly;

    const p = (async function() {
        const sb = getSupabase();
        const PAGE = 1000;
        // ⚠️ `in(stock, [...])` 的票名会全进 URL：414 个中文名 ≈ 10KB，过网关上限会 414。
        //   按 100 个一批（≈2.5KB）分批，每批内部顺序分页（收窄后通常 1 页就够）。
        const CHUNK = 100;
        const chunks = [];
        for (let i = 0; i < names.length; i += CHUNK) chunks.push(names.slice(i, i + CHUNK));
        const data = [];
        for (let c = 0; c < chunks.length; c++) {
            for (let from2 = 0; ; from2 += PAGE) {
                const res = await sb
                    .from('stock_daily_pct')
                    .select('date,stock,pct')
                    .in('stock', chunks[c])
                    .gte('date', f)
                    .lte('date', t)
                    .order('date', { ascending: true })
                    .order('stock', { ascending: true })
                    .range(from2, from2 + PAGE - 1);
                if (res.error) throw res.error;
                const arr = res.data || [];
                data.push.apply(data, arr);
                if (arr.length < PAGE) break;
                if (from2 > 200000) break;
            }
        }
        const out = new Map();
        data.forEach(function(r) {
            if (!r || !r.stock || !r.date) return;
            const name = String(r.stock).trim();
            const d = String(r.date).trim();
            const v = _num(r.pct);
            if (!name || !d || v === null) return;
            let m = out.get(name);
            if (!m) { m = new Map(); out.set(name, m); }
            m.set(d, v);
        });
        return out;
    })().then(function(map) {
        _subCache.set(key, { names: want, map: map });
        while (_subCache.size > SUB_CACHE_MAX) {
            const oldest = _subCache.keys().next().value;
            if (oldest === undefined) break;
            _subCache.delete(oldest);
        }
        return map;
    }).catch(function() {
        // §10：原料层 ⇒ 失败返回 null 让调用方回退全量读，⛔ 不缓存、⛔ 不当空数据
        return null;
    }).finally(function() {
        if (_subInflight.get(key + '|' + names.length) === p) _subInflight.delete(key + '|' + names.length);
    });
    _subInflight.set(key + '|' + names.length, p);
    return p;
}

/** a ⊆ b ? */
function _isSubset(a, b) {
    if (!b) return false;
    let ok = true;
    a.forEach(function(v) { if (!b.has(v)) ok = false; });
    return ok;
}

/**
 * 读取 [from, to] 区间内所有逐日腿（会话缓存 + 单飞）。
 *
 * @param {string} from 起始交易日 YYYY-MM-DD（含）
 * @param {string} to   结束交易日 YYYY-MM-DD（含）
 * @returns {Promise<Map<string, Map<string, number>>|null>}
 *          `Map<股票名, Map<日期, 日涨幅%>>`；
 *          null = 本层不可用（读取失败 / 表不存在）⇒ 调用方退回「全部走同花顺」，⛔ 不要当空数据
 */
export async function readDailyPctRows(from, to) {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f || !t) return new Map();
    const key = _keyOf(f, t);
    const hit = _cache.get(key);
    if (hit) return hit;
    // ★★ [R20-COVER 2026-10-30] 已被【更大区间】覆盖 ⇒ 直接切片，一个请求都不发。
    //
    //   为什么必须加（实测，用户报障「切换日期也不可以，就是卡顿」）：
    //   20 日涨幅读的是 [探针首日, 当前日期] 这段 45 天窗口。切一次日期窗口就平移一天 ⇒
    //   key 变成新串 ⇒ 原来的精确 key 命中不了 ⇒ **每次切日期都把 15,173 行 / 16 个请求重读一遍，
    //   实测 19.0 秒**（Supabase REST 单页 1000 行上限，一页约 1~4.5 秒）。
    //   而这段窗口 99% 的行是完全一样的 —— 只有头尾各一天不同。
    //   ⇒ 只要【会话里已经读过一段更宽的区间】，就在内存里切片返回：来回切日期 0 请求。
    //   ⚠️ 只是省网络，不改口径：切出来的就是同一批 (date, stock, pct)。
    const covering = _findCovering(f, t);
    if (covering) {
        const sliced = _sliceRange(covering, f, t);
        _putCache(key, sliced);     // 把切片也登记上，下次同区间直接命中（O(1)）
        return sliced;
    }
    const fly = _inflight.get(key);
    if (fly) return fly;
    if (Date.now() < _cooldownUntil) return null;

    const p = (async function() {
        const sb = getSupabase();
        const data = await _fetchAll(sb, f, t);
        const out = new Map();
        (data || []).forEach(function(r) {
            if (!r || !r.stock || !r.date) return;
            const name = String(r.stock).trim();
            const d = String(r.date).trim();
            const v = _num(r.pct);
            if (!name || !d || v === null) return;
            let m = out.get(name);
            if (!m) { m = new Map(); out.set(name, m); }
            m.set(d, v);
        });
        return out;
    })().then(function(map) {
        _cooldownUntil = 0;
        _putCache(key, map);
        return map;
    }).catch(function(e) {
        // §10：原料层 ⇒ 失败不 throw，返回 null 让调用方降级
        //   ⛔ 不写缓存：一次失败不能被记成「这段区间没有腿」
        _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[DAILY-PCT] stock_daily_pct 不可用（降级为全量同花顺，30s 后自动重试）：'
                + (e && e.message || e));
        }
        return null;
    }).finally(function() {
        if (_inflight.get(key) === p) _inflight.delete(key);
    });
    _inflight.set(key, p);
    return p;
}

/**
 * 批量写入逐日腿（幂等 upsert，主键 (date, stock)）。
 *
 * ⚠️ 只传【真的取到腿】的行（pct 非 null）—— 停牌 / 取不到 ⇒ 不写（§10 缺数据 ≠ 0%）。
 * ⚠️ 写入成功就把所有会话缓存的区间作废：本批新腿可能落在任何一段已缓存区间里，
 *    精确作废需要逐 key 比对，成本高于直接清空（本表只服务窗口计算，清空重读一次就够）。
 *
 * @param {Array<{date:string, stock:string, pct:number}>} rows
 * @returns {Promise<number>} 写入行数；失败返回 0（静默，不影响页面）
 */
export async function upsertDailyPctRows(rows) {
    const list = (rows || []).filter(function(r) {
        return r && r.stock && r.date && r.pct !== null && r.pct !== undefined && !isNaN(r.pct);
    });
    if (list.length === 0) return 0;
    const nowIso = new Date().toISOString();
    // 同一批里可能有重复 (date, stock)（跨轮累积时常见）⇒ 先按主键去重，后者覆盖前者
    const dedup = new Map();
    list.forEach(function(r) {
        const d = String(r.date).trim();
        const s = String(r.stock).trim();
        if (!d || !s) return;
        dedup.set(d + '\u0001' + s, { date: d, stock: s, pct: Number(r.pct).toFixed(2) });
    });
    const payload = [];
    dedup.forEach(function(v) {
        payload.push({
            date: v.date,
            stock: v.stock,
            pct: String(v.pct).charAt(0) === '-' ? v.pct : ('+' + v.pct),
            src: 'kline',
            updated_at: nowIso
        });
    });
    try {
        const sb = getSupabase();
        // 分批写：一次 POST 几千行会让请求体过大 / 触发网关限制（每批 500 行，实测稳）
        const CHUNK = 500;
        for (let i = 0; i < payload.length; i += CHUNK) {
            const { error } = await sb
                .from('stock_daily_pct')
                .upsert(payload.slice(i, i + CHUNK), { onConflict: 'date,stock' });
            if (error) throw error;
        }
        _invalidateFor(payload.map(function(r) { return r.date; }));
        _inflight.clear();
        return payload.length;
    } catch (e) {
        if (!_missingWarned) {
            _missingWarned = true;
            _dbgLog('[DAILY-PCT] 写入失败（不影响页面，下次打开会重算）：' + (e && e.message || e));
        }
        return 0;
    }
}
