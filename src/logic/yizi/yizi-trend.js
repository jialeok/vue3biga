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
//        窗口已齐就 0 请求直接渲染；只有「窗口里有整日没有行 / 池内有股票整窗无行」时才调
//        Edge /trend 补缺口（后一个判据 = 2026-09-20 新增的历史补数触发点）。
//        ⛔ 不要改回「Edge 优先、库兜底」—— 那样每次打开面板 / 刷新页面都要先等一次接口往返
//        （用户原话：「趋势图数据要存起来，不用每次打开都要加载一次」）。
//        Edge 仍然是本表的【唯一写入者】（只 upsert 缺口、从不删，§11）。
//   🔴 读库必须分页（2026-09-20）：PostgREST 单次响应上限 1000 行且【静默截断】，
//        而存储窗口 10 天 × 池内上百只实测 1725 行 ⇒ 不分页就会丢掉最后几天
//        （= 趋势图要画的 5 天）⇒ 用户看到「数据有很多断点」。详见 loadYiziTrend 的注释。
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
 * 🔴 趋势窗口 = **两个数**，⛔ 不要再合成一个（2026-09-20 第二次定案，用户原话：
 *   「趋势图我要求和早盘竞价一样显示五日的，**存起来是十日的**」）。
 *
 *   · `YIZI_TREND_WINDOW`       = 5  → **显示窗口**（画几条点）
 *   · `YIZI_TREND_STORE_WINDOW` = 10 → **存储/补腿窗口**（读库、划缺口、调 /trend、落库）
 *
 * 为什么必须拆开：
 *   ① **观感**：`TrendChart` 是固定宽度 320px 按点数均分 —— 5 点 ≈ 66px/点（疏朗，与早盘竞价一致），
 *      10 点 ≈ 29px/点（拥挤）。更要命的是 10 天窗口会把**上一周的停牌/无数据日**一起拖进画面，
 *      中段出现一大片 `--` ⇒ 用户看到的就是「**数据有很多断点**」（本轮实测反馈）。
 *   ② **正确性**：「十日涨幅」的分母是 `[T-9, T]`，cron 也是 `window=10`
 *      ⇒ **必须继续存 10 天**，否则十日涨幅会从 10 根腿静默掉到 5 根腿（§U9 的教训）。
 *   ⇒ 一句话：**读 10 天、补 10 天、存 10 天，只画最后 5 天。**
 *
 * ⚠️ 额度与窗口长度**无关**：/trend 是「整窗口 = 竞价腿 1 次 + K 线腿 1 次」= **恒 2 次**
 *   ⇒ ⛔ 别把「改成 5 天」当成省额度的手段（它的唯一目的是观感 + 与早盘竞价对齐）。
 */
export const YIZI_TREND_WINDOW = 5;

/**
 * 存储窗口（近 N 个交易日，含 T 日）：**读库 / 划缺口 / 调 /trend / 落库**都用它。
 * 🔴 它只决定「存多少」，⛔ 不决定「画多少」（画多少 = `YIZI_TREND_WINDOW`）。
 * 与 「十日涨幅」的 `RANGE_WINDOW_DAYS` 同分母 ⇒ 两个数必须一起改（§6 单一真相）。
 */
export const YIZI_TREND_STORE_WINDOW = 10;

// ===== 本模块唯一的响应式真相（供 composable/UI 读取）=====
export const yiziTrendState = reactive({
    /** 这批趋势行属于哪一天（UI 用它做「日期对齐」判据，⛔ 不对齐不许渲染） */
    date: '',
    /**
     * **显示窗口**交易日（升序，旧 → 新）：曲线点的顺序与日期轴一律以它为准。
     * 🔴 长度 = `YIZI_TREND_WINDOW`（5），⛔ 不是存储窗口（10）——
     *    库里多出来的那 5 天只喂「十日涨幅」，不进这里（§6 不给 UI 第二份更长的真相）。
     */
    windowDates: [],
    /** 趋势行（Data 层 mapTrendRow 的形状；⚠️ 与 windowDates 同长同区间；可能为空数组 = 该窗口确实还没有缓存） */
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
 * 交易日窗口（升序：旧 → 新）。
 *
 * 主通道 = 与「十日涨幅」同一个交易日日历（§6 单一真相：getDragonWindowDates 取前 N 个再翻正序），
 * 这样「趋势图的 X 轴」与「十日涨幅的分母」永远是同一批交易日，不会出现两套日历。
 * 兜底 = 只按周末回退（不认节假日）：宁可在窗口里多带一个非交易日（读库自然是空），
 * 也绝不因为交易日历没加载出来就把整块趋势图变成「加载失败」。
 *
 * ⚠️ `getDragonWindowDates` 本身**最多返回 10 个交易日** ⇒ 本函数最多也只能要 10 个；
 *    ⛔ 别指望用它取 20 天（要更长窗口得先扩 dragon 日历，那是另一件事）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {number} [count] 要几个交易日；缺省 = 存储窗口（10）。**显示窗口（5）靠调用方传 5**。
 * @returns {string[]} 升序交易日
 */
function _windowDatesFor(date, count) {
    const want = (count && isFinite(count) && count > 0) ? Number(count) : YIZI_TREND_STORE_WINDOW;
    try {
        const desc = getDragonWindowDates(date);   // [T, T-1, …] 降序，最多 10 个交易日
        const take = (desc || []).slice(0, want).filter(Boolean);
        if (take.length > 0) return take.slice().reverse();
    } catch (e) {
        _dbgLog('[AUCTION-YIZI] 趋势窗口计算失败（回退按自然日）: ' + (e && e.message || e));
    }
    const out = [];
    const d = new Date(date + 'T00:00:00Z');
    let guard = 0;
    while (out.length < want && guard < 90) {
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
    // ★ 2026-09-20：小号额度耗尽（上游 code=403「今日调用额度已用完」）必须【说清楚】——
    //    否则用户看到的就是「图上还是断点，但也没说为什么」，会误以为功能坏了。
    //    ⛔ 也不会自动去烧主账号：那是早盘竞价的额度（用户明确要求两个账号互不侵占）。
    if (payload && payload.quotaExhausted) {
        bits.push('本看板小号今日额度已用完（上游 403），先展示已有缓存；额度次日 0 点重置后会自动继续补');
    }
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
 * 🔴 「读 10 天、画 5 天」的边界全在本函数内：
 *    · 读库 / 划缺口 / 调 /trend 用 **存储窗口（10）** ⇒ 十日涨幅的原料永远是满的；
 *    · 返回并写进 `yiziTrendState` 的 `windowDates` / `rows` 只有 **显示窗口（5）**。
 *    ⇒ 调用方（composable / UI）**不需要知道有 10 天这件事**，照旧按 state 画即可。
 *
 * 🔴 2026-09-20 断点事故（本轮修复）：用户报「09-18 趋势图数据有很多断点（数据不全）」。
 *    真因不在抓取、也不在窗口长短，而在**读库被 PostgREST 静默截断**：
 *    存储窗口 10 天 × 池内上百只 = 1725 行，而单次响应上限 1000 行（db-max-rows），
 *    按 date 升序读 ⇒ 被砍掉的恰好是**最后几天**（= 趋势图要画的那几天）。
 *    修法有三条，缺一条都还会复发：
 *      ① Data 层分页（readYiziTrendForDates / Edge readTrendRows），见各自的 REST_PAGE_SIZE 注释；
 *      ② 补完之后【回库重读】，⛔ 不再直接用 Edge 响应的 rows（它同样是 PostgREST 读出来的）；
 *      ③ 缺口判据加上「池内有股票整窗无行」（见下方 ②），否则历史日期的池子永远是空心图。
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean, stocks?:string[]}} [opts] force = 忽略会话缓存重新拉（手动刷新用）；
 *        stocks = **本日看板池的股票名**（composable 传入）。用途见下方 ② 的 (b) 判据：
 *        「池里有股票在整个存储窗口一行都没有」= 它从来没被补过（历史日期的池子就是这样空心的）
 *        ⇒ 这就是「用小号补历史数据」的触发点。⛔ 不传时退化为旧的「整日无行」判据（向后兼容）。
 * @returns {Promise<{date:string, windowDates:string[], rows:Array<object>, note:string, source:string}|null>}
 */
export async function loadYiziTrend(date, opts) {
    const force = !!(opts && opts.force);
    const stocks = (opts && Array.isArray(opts.stocks))
        ? opts.stocks.map(function(s) { return String(s == null ? '' : s).trim(); }).filter(Boolean)
        : [];
    if (!date) return null;
    if (_inflight && _inflight.date === date && !force) return _inflight.promise;
    const p = _load(date, force, stocks).finally(function() {
        if (_inflight && _inflight.date === date) _inflight = null;
    });
    _inflight = { date: date, promise: p };
    return p;
}

async function _load(date, force, stocks) {
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
    // 🔴 两个窗口（口径见文件顶部常量注释）：
    //    · 存储窗口（10）= `storeDates` → 读库 / 划缺口 / 调 /trend 都用它（保证十日涨幅的原料齐）
    //    · 显示窗口（5） = 存储窗口的**末尾 5 天**（末尾即 T）→ 真正画出来、写进 state 的
    //    ⛔ 千万别把这两个合成一个：合了就会出现上一轮的两种病（画 5 天→十日涨幅缺腿 / 画 10 天→满屏断点）。
    let storeDates = _windowDatesFor(date, YIZI_TREND_STORE_WINDOW);
    let windowDates = storeDates.slice(-YIZI_TREND_WINDOW);
    // 先把 X 轴摆成显示窗口（5），避免「先渲染 10 个点、数据回来后跳成 5 个点」的闪烁
    yiziTrendState.windowDates = windowDates;
    yiziTrendState.error = '';
    yiziTrendState.note = '';
    yiziTrendState.source = '';

    let storeRows = [];
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
            storeRows = await readYiziTrendForDates(storeDates);
            source = 'db';
        } catch (e) {
            dbError = (e && e.message) || String(e);
            _dbgLog('[AUCTION-YIZI] ' + date + ' 读 yizi_trend 失败: ' + dbError);
        }
        if (!isLatest()) return null;

        // ── ② 缺口判定：**按存储窗口（10 天）判**，⛔ 不是按显示窗口（5 天）────────────
        //    为什么必须按 10 天判：【十日涨幅】要吃 [T-9,T] 的逐日涨幅，只要这 10 天里有
        //    「整日没有行」就该去补。若按 5 天判，会出现「图看着齐了、十日涨幅却悄悄掉腿」
        //    （§U9 实测：补库不配套扩窗口 ⇒ 历史日期静默降级 10 根腿 → 5 根腿）。
        //
        //    两个判据（★ 第二个是 2026-09-20 新增，历史日期空心图的根因）：
        //    (a) 【整日无行】：窗口里有某一天一行都没有 → 一定要补（旧判据，保留）；
        //    (b) 【池内整窗空】：看板当前池里有股票在**整个存储窗口**一行都没有
        //        ⇒ 它从来没被补过（实测：09-10/09-14/09-15/09-16 的池子就是这么空心的，
        //          09-18 的池子却全齐 —— 因为 /trend 只按「某个 T 的池子」补，谁看过谁才被补）
        //        ⇒ 用户一展开，就自动去补这一池的历史。
        //    ⛔ 刻意【不】把「某天某格为 null」当缺口：停牌 / 上游本就没有数据的日子
        //       （实测 经纬股份 09-14~09-16 无当日涨幅 = 停牌），补一万次也补不出来，
        //       判成缺口会让每次展开都白烧一次小号额度（预算只有 6 次/天）。§10：显示 '-' 就是诚实。
        const covered = new Set();
        const coveredPair = new Set();
        storeRows.forEach(function(r) {
            if (!r) return;
            if (r.date) covered.add(r.date);
            if (r.date && r.stock) coveredPair.add(r.date + '|' + r.stock);
        });
        const gaps = storeDates.filter(function(d) { return !covered.has(d); });
        const poolEmpty = (stocks || []).filter(function(s) {
            return !storeDates.some(function(d) { return coveredPair.has(d + '|' + s); });
        });

        if (gaps.length > 0 || poolEmpty.length > 0 || force) {
            try {
                // Edge 侧自己会「读缓存 + 只补缺口」，返回的 rows 是补完之后**存储窗口**的全部行。
                // 🔴 这里必须传存储窗口（10）：传 5 会让库里第 6~10 天永远补不上（十日涨幅随之少腿）。
                const payload = await fetchYiziTrendFromEdge({ date: date, window: YIZI_TREND_STORE_WINDOW });
                if (!isLatest()) return null;
                // 窗口以 Edge 为准：它才知道「近 N 个交易日」真正是哪几天（前端那份只是本地日历推算）
                if (Array.isArray(payload.window) && payload.window.length > 0) {
                    storeDates = payload.window.map(function(d) { return String(d); });
                }
                note = _noteOf(payload);
                source = 'edge';
                // 🔴 补完之后【回库重读】，⛔ 不用 payload.rows —— 三条理由：
                //    ① §6：库才是持久化真相，Edge 只是写入者（它写完的行也该从库里读回来核对）；
                //    ② payload.rows 同样是 PostgREST 读出来的（Edge 内部 readTrendRows），
                //       历史上被 1000 行上限截断过 ⇒ 直接用会把刚补齐的数据又截成残缺
                //       （这正是 2026-09-20「补了还是断点」的成因）；
                //    ③ 回读还能顺带确认「写入是否真的生效」，而不是相信响应里的 written 计数。
                //    ⛔ 只在回读失败时才退回 payload.rows（fail-soft，绝不因回读失败就白屏）。
                try {
                    storeRows = await readYiziTrendForDates(storeDates);
                } catch (e) {
                    _dbgLog('[AUCTION-YIZI] ' + date + ' 补后回读 yizi_trend 失败（改用接口返回体）: ' + (e && e.message || e));
                    storeRows = (payload.rows || []).map(mapTrendRow);
                }
            } catch (e) {
                edgeError = (e && e.message) || String(e);
                _dbgLog('[AUCTION-YIZI] ' + date + ' 调趋势接口失败（改用已有缓存渲染）: ' + edgeError);
            }
            if (!isLatest()) return null;
        } else {
            note = SKIP_TEXT['cache-complete'];
        }

        // ── ②' 收敛到【显示窗口】：屏上画 5 天，state 里也只留这 5 天 ─────────────────
        //    §6：state 不保留「比屏上更长」的第二份真相。多出来的那 5 天只服务于
        //    十日涨幅（它自己直读库，不经过这里）与「下次打开不必再补」。
        windowDates = storeDates.slice(-YIZI_TREND_WINDOW);
        const dispSet = new Set(windowDates);
        rows = storeRows.filter(function(r) { return r && dispSet.has(r.date); });

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
