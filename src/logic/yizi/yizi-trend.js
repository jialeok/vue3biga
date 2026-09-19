// yizi-trend.js — 「竞价一字 · 趋势图」的 Logic 编排层（业务规则 / 协调，§4）
//
// 架构位置：UI（views/AuctionYiziBoard.vue + composables/useAuctionYizi.js）
//          → 本模块（窗口计算 / 会话缓存 / 单飞 / 缺口补拉 / 失败可见）
//          → Data（data/yizi-trend.js：① 读 yizi_trend 表；② 调 Edge /trend 补缺口）
//          → Supabase（表 yizi_trend）+ Edge Function auction-yizi-fetch/trend → 猫抓【小号】
//
// 数据链（★ 与「早盘竞价」看板同形，但**完全独立的取数通道**）：
//   · 竞价量 / 昨日成交量 / 竞价涨幅 ← Edge /trend 的 daily_auc 腿（小号，整窗口 1 次请求）
//   · 涨幅                          ← Edge /trend 的 daily 腿（小号，整窗口 1 次请求）
//   · 十日涨幅                      ← 这一行的既有字段（stock_range_pct），⛔ 不进趋势缓存
//   ⛔ 与早盘竞价看板用的 numcat-proxy（主账号 NUMCAT_API_KEY）毫无关系，绝不混用。
//
// 红线：
//   §10  读失败/接口失败必须【可见】：错误写进 yiziTrendState.error（reactive），UI 显示提示；
//        ⛔ 绝不把「取不到」静默成「这只股票没有历史」。同时【不阻断看板】——
//        趋势是附加信息，失败只让面板显示提示 + 断点，池子照常渲染。
//   §6/§34 本模块【不持有任何视图状态】：展开态、开关态都在 composable（组件内 ref）。
//        yiziTrendState 里只有「关于这一天的事实」：窗口日期、行、加载中、错误、说明。
//   ★ 库优先（2026-09-19 改）：`yizi_trend` 是【跨设备持久化缓存】，所以【先直读库】，
//        窗口已齐就 0 请求直接渲染；只有「窗口里有整日没有行」时才调 Edge /trend 补缺口。
//        ⛔ 不要改回「Edge 优先、库兜底」—— 那样每次打开面板 / 刷新页面都要先等一次接口往返
//        （用户原话：「趋势图数据要存起来，不用每次打开都要加载一次」）。
//        Edge 仍然是本表的【唯一写入者】（只 upsert 缺口、从不删，§11）。
//   §22  单飞 + 会话缓存：同一天同一瞬间只跑一次；已成功拉过的日期直接命中缓存，不再打接口。
//   §26  切日期：结果回来时先校验它仍是【最新一次请求】的日期，迟到的旧请求一律丢弃。
//   §11  本模块【不删除任何数据】（只读库 + 调补腿；写入者是 Edge Function，且只 upsert 缺口）。
//   ★ 额度：本模块只决定「要不要调 /trend」；真正的闸门（09:20~09:30 保护窗口 / 90 秒冷却 /
//      每日请求预算 / 整窗口 1 次请求）全在 Edge Function 里 —— 前端既绕不过，也不必重复实现。

import { reactive } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { getDragonWindowDates } from '../auction/dragon-rank.js';
import { readYiziTrendForDates, fetchYiziTrendFromEdge, mapTrendRow } from '../../data/yizi-trend.js';

/**
 * 趋势窗口长度（近 N 个交易日，含 T 日）。
 *
 * 🔴 2026-09-20 由 5 改为 10（用户实测反馈：「9-18 经纬股份涨幅只有最近两天的」）。
 *   · 旧窗口 5 天 = [09-14 … 09-18]，而该股 09-10~09-16 因控制权变更停牌
 *     ⇒ 09-14/15/16 三天上游没有数据 ⇒ 5 天窗口里只剩 09-17/09-18 两个点。
 *   · ⚠️ 关键：**真正有数据的 09-07/08/09 落在窗口之外**，所以「只补库」不会改善观感 ——
 *     必须同时把窗口扩到 10 天，补回来的数据才显示得出来。
 *   ⇒ 扩到 10 天的三个理由：
 *     ① 与「十日涨幅」的窗口 [T-9,T] **完全对齐**（图与主度量同一个分母，不再两套日历）；
 *     ② 与 `db/create_yizi_trend.sql` 里 cron 的 `window=10` 一致（本来就取 10 天落库）；
 *     ③ **不多烧一分额度** —— /trend 是「整窗口 = 竞价腿 1 次 + K 线腿 1 次」，
 *        5 天与 10 天都是 2 次请求。
 *   ⚠️ 「早盘竞价看板」仍是近 5 日：两看板的趋势窗口**口径独立、互不影响**
 *      （那边没有「十日涨幅」这个主度量，不需要 10 天）。
 */
export const YIZI_TREND_WINDOW = 10;

// ===== 本模块唯一的响应式真相（供 composable/UI 读取）=====
export const yiziTrendState = reactive({
    /** 这批趋势行属于哪一天（UI 用它做「日期对齐」判据，⛔ 不对齐不许渲染） */
    date: '',
    /** 窗口交易日（升序，旧 → 新）：曲线点的顺序与日期轴一律以它为准 */
    windowDates: [],
    /** 趋势行（Data 层 mapTrendRow 的形状；可能为空数组 = 该窗口确实还没有缓存） */
    rows: [],
    loading: false,
    /** 读失败 / 接口失败（§10 必须让用户看见；空串 = 没出错） */
    error: '',
    /** 本轮说明（缓存已齐 / 保护窗口 / 冷却 / 预算 / 某条腿失败）——可解释性，不是错误 */
    note: '',
    /** 数据来源：'edge'（走接口，可能含补拉）| 'db'（接口失败，回退直读库缓存） */
    source: '',
    updatedAt: ''
});

/** 单飞：同一日期同一时刻只跑一次加载 */
let _inflight = null;
/** 加载序号（单调递增）：切日期时迟到的旧请求不许写状态（§26） */
let _seq = 0;
/** 会话缓存：date → { date, windowDates, rows, note, source }（已成功拉到过的这一天不必再打接口） */
const _cache = new Map();

/** Edge 返回的 skipped 代码 → 人话（可解释性：让用户知道「为什么这次没去补数据」） */
const SKIP_TEXT = {
    'cache-complete': '趋势缓存已齐（本轮 0 次上游请求）',
    'protect-window': '处于 09:20~09:30 的 9:25 抓取保护窗口，本轮不补拉（先用已有缓存）',
    'cooldown': '距上次补拉不足 90 秒，本轮只读缓存',
    'budget': '本日趋势补拉次数已达上限，本轮只读缓存',
    'no-pool': '该日还没有一字池（9:25 抓取可能尚未完成），趋势暂时取不到',
    'no-code': '池内股票缺代码，无法补拉趋势'
};

/**
 * 趋势窗口（升序：旧 → 新）。
 *
 * 主通道 = 与「十日涨幅」同一个交易日日历（§6 单一真相：getDragonWindowDates 取前 N 个再翻正序），
 * 这样「趋势图的 X 轴」与「十日涨幅的分母」永远是同一批交易日，不会出现两套日历。
 * 兜底 = 只按周末回退（不认节假日）：宁可在窗口里多带一个非交易日（读库自然是空），
 * 也绝不因为交易日历没加载出来就把整块趋势图变成「加载失败」。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {string[]} 升序交易日
 */
function _windowDatesFor(date) {
    try {
        const desc = getDragonWindowDates(date);   // [T, T-1, …] 降序，最多 10 个交易日
        const take = (desc || []).slice(0, YIZI_TREND_WINDOW).filter(Boolean);
        if (take.length > 0) return take.slice().reverse();
    } catch (e) {
        _dbgLog('[AUCTION-YIZI] 趋势窗口计算失败（回退按自然日）: ' + (e && e.message || e));
    }
    const out = [];
    const d = new Date(date + 'T00:00:00Z');
    let guard = 0;
    while (out.length < YIZI_TREND_WINDOW && guard < 90) {
        guard++;
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
}

/**
 * 把 Edge /trend 的响应翻译成一句「本轮发生了什么」（可解释性）。
 * ⛔ 两条腿失败都要说出来 —— 否则用户只会看到「涨幅那条线是空的」而不知道原因（§10）。
 * @param {object} payload Edge 返回的 JSON
 * @returns {string}
 */
function _noteOf(payload) {
    const bits = [];
    const skip = payload && payload.skipped;
    if (skip && SKIP_TEXT[skip]) bits.push(SKIP_TEXT[skip]);
    const fetched = (payload && payload.fetched) || {};
    const legFail = function(leg, label) {
        if (leg && leg.ok === false) {
            bits.push(label + '补拉失败：' + (leg.error || '未知原因') + '（该曲线本次可能缺数据）');
        }
    };
    legFail(fetched.auc, '竞价腿（竞价量/昨日成交量/竞价涨幅）');
    legFail(fetched.daily, 'K线腿（涨幅）');
    const b = payload && payload.budget;
    if (b && b.cap > 0 && b.usedRequests >= b.cap) {
        bits.push('本日趋势上游请求 ' + b.usedRequests + '/' + b.cap + '（已达上限，之后的展开只读缓存）');
    }
    return bits.join('；');
}

/**
 * 加载某一天的趋势缓存（看板的唯一入口）。
 *
 * ⚠️ 这是「懒加载」：只在用户**第一次展开**某只股票的趋势面板时调用（+ 可选的 09:35 定时预热）。
 *    理由见 db/create_yizi_trend.sql：额度只有 10 次/天，绝不能在看板一打开就无条件补拉。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean}} [opts] force = 忽略会话缓存重新拉（手动刷新用）
 * @returns {Promise<{date:string, windowDates:string[], rows:Array<object>, note:string, source:string}|null>}
 */
export async function loadYiziTrend(date, opts) {
    const force = !!(opts && opts.force);
    if (!date) return null;
    if (_inflight && _inflight.date === date && !force) return _inflight.promise;
    const p = _load(date, force).finally(function() {
        if (_inflight && _inflight.date === date) _inflight = null;
    });
    _inflight = { date: date, promise: p };
    return p;
}

async function _load(date, force) {
    // 会话缓存命中：这一天已经成功拉过一次 → 直接复用（0 网络请求）。
    // ⚠️ 不要求 yiziTrendState.date 已是这一天 —— 用户「切走再切回来」时也应命中缓存，
    //    否则每次来回都会白打一次接口。⛔ 只有 force 才跳过缓存。
    if (!force && _cache.has(date)) {
        const cached = _cache.get(date);
        yiziTrendState.date = date;
        yiziTrendState.windowDates = cached.windowDates;
        yiziTrendState.rows = cached.rows;
        yiziTrendState.note = cached.note;
        yiziTrendState.source = cached.source;
        yiziTrendState.error = '';
        return cached;
    }

    const mySeq = ++_seq;
    const isLatest = function() { return mySeq === _seq; };

    yiziTrendState.loading = true;
    yiziTrendState.date = date;
    yiziTrendState.windowDates = _windowDatesFor(date);
    yiziTrendState.error = '';
    yiziTrendState.note = '';
    yiziTrendState.source = '';

    let windowDates = yiziTrendState.windowDates;
    let rows = [];
    let note = '';
    let source = '';
    let dbError = '';
    let edgeError = '';

    try {
        // ── ① 【库优先】直读 Supabase 的 yizi_trend（跨设备持久化缓存）────────────────
        // 为什么必须是这一步先走：趋势行一旦落库就是【长期有效】的业务数据，
        // 打开面板 / 刷新页面 99% 的情况只是「再读一次库」（PostgREST 百毫秒级），
        // ⛔ 没有任何理由每次都去调 Edge（网络往返 + 上游额度 + 可能被额度闸门挡住）。
        // 🔴 旧实现是「Edge 优先、库只做兜底」，于是每次打开都要先等一次接口往返 ——
        //    用户原话「趋势图数据要存起来，不用每次打开都要加载一次」说的就是这个。
        try {
            rows = await readYiziTrendForDates(windowDates);
            source = 'db';
        } catch (e) {
            dbError = (e && e.message) || String(e);
            _dbgLog('[AUCTION-YIZI] ' + date + ' 读 yizi_trend 失败: ' + dbError);
        }
        if (!isLatest()) return null;

        // ── ② 缺口判定：窗口里【整日没有行】= 缓存不完整（首次打开 / 池子换新 / 有几天没补过）
        //     ⇒ 才去调 Edge 补缺口（它自带 5 道额度闸门，且只 upsert、从不删，§11）。
        //     窗口已齐 ⇒ 本轮 0 请求，直接渲染（这就是「打开就出图」的关键）。
        const covered = new Set();
        rows.forEach(function(r) { if (r && r.date) covered.add(r.date); });
        const gaps = windowDates.filter(function(d) { return !covered.has(d); });

        if (gaps.length > 0 || force) {
            try {
                // Edge 侧自己会「读缓存 + 只补缺口」，返回的 rows 是补完之后该窗口的全部行。
                const payload = await fetchYiziTrendFromEdge({ date: date, window: YIZI_TREND_WINDOW });
                if (!isLatest()) return null;
                // 窗口以 Edge 为准：它才知道「近 N 个交易日」真正是哪几天（前端那份只是本地日历推算）
                if (Array.isArray(payload.window) && payload.window.length > 0) {
                    windowDates = payload.window.map(function(d) { return String(d); });
                }
                rows = (payload.rows || []).map(mapTrendRow);
                note = _noteOf(payload);
                source = 'edge';
            } catch (e) {
                edgeError = (e && e.message) || String(e);
                _dbgLog('[AUCTION-YIZI] ' + date + ' 调趋势接口失败（改用已有缓存渲染）: ' + edgeError);
            }
            if (!isLatest()) return null;
        } else {
            note = SKIP_TEXT['cache-complete'];
        }

        // ── ③ §10 失败必须可见 —— 而且【两个原因都要说出来】──────────────────────
        // 🔴 旧实现：库错误先写进 error，随后被 Edge 错误整条【覆盖】⇒
        //    用户只看到「趋势接口失败…请确认 auction-yizi-fetch 已部署」，
        //    完全看不到「yizi_trend 表还没建」这个真因（2026-09-19 事故现场：
        //    用户明明部署好了 TS，却被提示「没部署」，方向被彻底带偏）。
        const errBits = [];
        if (dbError) errBits.push('读趋势缓存失败：' + dbError);
        if (edgeError) {
            errBits.push('趋势接口失败：' + edgeError +
                (rows.length > 0 ? '（已用已有缓存渲染，可能不是最新）' : ''));
        }
        yiziTrendState.error = errBits.join('；');

        yiziTrendState.windowDates = windowDates;
        yiziTrendState.rows = rows;
        yiziTrendState.note = note;
        yiziTrendState.source = source;
        yiziTrendState.updatedAt = (rows[0] && rows[0].updatedAt) || '';

        const entry = {
            date: date,
            windowDates: windowDates,
            rows: rows,
            note: note,
            source: source
        };
        // 只有在「确实没报错」时才进会话缓存：
        // ⛔ 出错时不缓存，否则下一次展开会被缓存短路，永远等不到重试。
        if (!yiziTrendState.error) _cache.set(date, entry);
        return entry;
    } finally {
        if (isLatest()) yiziTrendState.loading = false;
    }
}

/**
 * 清空会话缓存（手动刷新 / 需要强制重取时调用）。
 * ⚠️ 只清前端内存缓存，⛔ 不碰云端任何数据（§11）。
 */
export function clearYiziTrendCache() {
    _cache.clear();
}
