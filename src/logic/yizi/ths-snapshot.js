// ths-snapshot.js — 「竞价一字」看板 · 同花顺 9:25 快照补数（Logic 层）
//
// 🔴 【为什么有这条链路（2026-10-26 用户拍板）】
//   猫抓数据（numcat `daily_auc_fd`）是竞价一字的原始数据源，但它在 10-23 / 10-26 连续
//   **连接级无响应**（正常 1750ms 返回，失败则 25000ms 超时 ×2，见 bidding_fetch_log
//   job=auction-yizi-fetch）。`auction_yizi` 因此自 2026-10-22 起就没有新数据。
//   用户口径：「竞价一字看板，你用同花顺的补 9 点 25 分快照就可以」
//            「猫爪那边多余的额度留给早盘竞价看板」。
//   ⇒ 本模块用**同花顺（0 猫爪额度）**重建「今天」的 9:25 一字快照。
//
// 🔴 【判定规则：为什么是"首封 09:25 + 收盘仍有封单"】
//   实测（.tmpdiag/probe-yizi-rule.cjs，2026-10-26 真实库 59 只涨停池）：
//     · 用 |竞价涨幅 − 收盘涨幅| ≤ 0.11 筛，命中 7 只，但其中「杰克科技」首封时间是 09:30、
//       竞价未匹配量为 -174（卖盘方向）⇒ 它【不是】一字，会被误收；
//     · 改用 `limit_up_time === '09:25'` 恰好命中 6 只，且这 6 只的竞价涨幅与收盘涨幅**完全相等**
//       （上海九百 +10.00/+10.00、多伦科技 +9.9509/+9.9509 …），全部是开盘即涨停。
//     · 再加 `seal_money > 0`（收盘仍有封单）⇒ 排除"开盘涨停后又开板"的票。
//   ⇒ 判据 = 首封时间 09:25 且 收盘封单额 > 0。两条都来自同一次涨停池响应，不额外花请求。
//
// 🔴 【⛔ 刻意不写的字段（§40 不凭猜测写库）】
//   · `seal_money` / `fa_0915`~`fa_0925l`（13 列分时封单额）：同花顺只有 9:25 **终态**，
//     没有 9:15→9:25 的分时序列。涨停池里的 `seal_money` 是**收盘**封单额，写成 9:25 封单额
//     就是伪造证据链（这个看板的核心就是那条分时曲线）⇒ 一律留空，由看板显示 `--`。
//     `auction_unmatched`（未匹配量）虽然方向可判，但单位无法用现有数据交叉验证
//     （6 只一字算出的"封单额"与收盘封单额差 8~22 倍且比例不一致）⇒ 同样不写。
//   · `theme_kpl` / `theme_xgb`：涨停池的 `limit_up_reason` 是"具身智能+机器人下线+风电树脂"
//     这类口语串，按 '+' 拆会把「机器人下线」这种伪题材写进**全站共享题材库**
//     （看板加载时会只补空缺地回填）⇒ 不写，走既有"共享题材库兜底"路径。
//
// 🔴 【只写"空"的日期】
//   库里当天已有行（= 猫爪真实数据，带完整 13 列）时 **直接返回 ok:false 不覆盖**。
//   猫爪额度恢复后它仍是第一优先数据源。
//
// 红线（§10）：读上游 / 读库失败必须如实返回 reason，⛔ 绝不把失败说成「今天没有一字」。

import { fuyaoApiGet, tickerToThscode } from '../../data/api/fuyao-proxy.js';
import { readAuctionYiziForDate, replaceAuctionYiziForDate } from '../../data/auction-yizi.js';
import { _dbgLog } from '../../data/debug-log.js';
import { beijingTodayStr } from './yizi-board.js';

const POOL_PATH = '/api/a-share/special-data/limit-up-pool';
const SNAPSHOT_PATH = '/api/a-share/auction/snapshot';
/** 竞价快照单次最多 100 个 thscode（接口契约，见 logic/auction/suspend.js 同款注记） */
const SNAPSHOT_CHUNK = 100;
/** 涨停池单页条数（实测 size=100 一次拿全 59 只） */
const POOL_PAGE_SIZE = 200;
/** 首封时间判据：竞价一字 = 9:25 集合竞价结束就已在涨停价 */
const YIZI_FIRST_TIME = '09:25';

/** 单飞：同一个日期同时只允许一次补数（防连点把库写出两批） */
const _inflight = new Map();

/**
 * 拉涨停池（按目标日）。分页拉全，⛔ 不取第一页了事（实测今天共 59 只 / 每页 50 ⇒ 会漏 9 只）。
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<object>>}
 */
async function _fetchPool(date) {
    const out = [];
    let page = 1;
    let pages = 1;
    do {
        const data = await fuyaoApiGet(POOL_PATH, { date: date, page: page, size: POOL_PAGE_SIZE });
        const items = (data && data.item) || [];
        for (let i = 0; i < items.length; i++) out.push(items[i]);
        const pg = (data && data.pagination) || {};
        pages = Number(pg.pages) || 1;
        page += 1;
        if (items.length === 0) break;   // 防御：空页直接停，避免上游 pagination 异常导致死循环
    } while (page <= pages && page <= 20);
    return out;
}

/**
 * 拉 9:25 终态快照。双闸门：`data_status === 'final'` 且服务端日期 === 目标日。
 * ⛔ 闸门不通过时返回 null（绝不用上一交易日的竞价量冒充今天）。
 * @param {string[]} thscodes
 * @param {string} date
 * @returns {Promise<Map<string,object>|null>} thscode → 快照行
 */
async function _fetchSnapshot(thscodes, date) {
    const byCode = new Map();
    let gated = false;
    for (let i = 0; i < thscodes.length; i += SNAPSHOT_CHUNK) {
        const chunk = thscodes.slice(i, i + SNAPSHOT_CHUNK);
        const data = await fuyaoApiGet(SNAPSHOT_PATH, { thscodes: chunk.join(','), stage: 'final' });
        const status = String((data && data.data_status) || '');
        const ts = Number(data && data.timestamp) || 0;
        const serverYmd = ts > 0 ? new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
        if (status !== 'final' || serverYmd !== date) {
            gated = true;
            _dbgLog('[YIZI-THS] 快照闸门拒绝：data_status=' + status + ' 服务端日=' + serverYmd + ' 目标日=' + date);
            break;
        }
        const arr = (data && data.item) || [];
        for (let k = 0; k < arr.length; k++) {
            const r = arr[k];
            if (r && r.thscode) byCode.set(String(r.thscode), r);
        }
    }
    return gated ? null : byCode;
}

/** 数值归一：非有限值 → null（⛔ 不用 0 顶替） */
function _numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/** 带符号的涨幅文本（与库内既有口径一致：+10.00 / -3.20） */
function _pctText(v) {
    const n = _numOrNull(v);
    if (n === null) return null;
    return (n >= 0 ? '+' : '') + n.toFixed(2);
}

/**
 * 用同花顺补「今天」的竞价一字快照。
 *
 * @param {string} [date] 目标日（缺省 = 北京今天）；⛔ 只接受今天（快照接口只提供当日数据）
 * @returns {Promise<{ok:boolean, date:string, count:number, pool:number, reason?:string, message:string, logs:string[]}>}
 */
export async function patchTodayYiziFromThs(date) {
    const logs = [];
    const log = function (m) { logs.push(m); _dbgLog('[YIZI-THS] ' + m); };
    const fail = function (reason, extra) {
        return Object.assign({ ok: false, date: date || '', count: 0, pool: 0, reason: reason, message: reason, logs: logs }, extra || {});
    };

    const today = beijingTodayStr();
    const d = String(date || today).trim() || today;
    if (d !== today) {
        // ⛔ 只补今天：`auction/snapshot` 只有当日数据，补历史只会拿到今天的行写进历史日期
        return fail('只允许补今天（' + today + '），收到 ' + d + '；历史日需等猫抓额度恢复后由 auction-yizi-fetch 抓取');
    }

    const fly = _inflight.get(d);
    if (fly) return fly;

    const task = (async function () {
        // ① 今天库里已经有行 ⇒ 那是猫抓的真实数据（含 13 列分时封单额），⛔ 绝不覆盖
        let existing = [];
        try {
            existing = await readAuctionYiziForDate(d);
        } catch (e) {
            // §10：读库失败必须如实说，不能顺势写成"今天没有"
            return fail('读取 auction_yizi 失败：' + (e && e.message || e) + '（本次未写入任何数据）');
        }
        if (existing.length > 0) {
            return Object.assign(fail('库里已有 ' + existing.length + ' 行（猫抓数据优先，不覆盖）'), { count: existing.length });
        }

        // ② 涨停池（0 猫爪额度）
        let pool = [];
        try {
            pool = await _fetchPool(d);
        } catch (e) {
            return fail('读取同花顺涨停池失败：' + (e && e.message || e));
        }
        log('涨停池 ' + pool.length + ' 只（' + d + '）');
        if (pool.length === 0) {
            // 今天没涨停 = 真的没有池子（非交易日 / 数据未出），不是失败
            return fail('同花顺涨停池返回 0 只：今天可能不是交易日，或收盘数据尚未生成');
        }

        // ③ 按判据筛一字（首封 09:25 且收盘仍有封单），同时收集要查快照的代码
        const picked = [];
        pool.forEach(function (p) {
            const firstTime = String(p.limit_up_time || '').trim();
            const seal = _numOrNull(p.seal_money);
            if (firstTime.indexOf(YIZI_FIRST_TIME) !== 0) return;
            if (seal === null || seal <= 0) return;
            const code = String(p.ticker || '').trim();
            if (!/^\d{6}$/.test(code)) return;      // §40：不猜代码
            picked.push({ p: p, code: code, thscode: String(p.thscode || tickerToThscode(code)) });
        });
        log('判据命中 ' + picked.length + ' 只（首封 ' + YIZI_FIRST_TIME + ' 且收盘封单额>0）');
        if (picked.length === 0) {
            return fail('今日没有「首封 09:25 且收盘仍封」的票 ⇒ 同花顺口径下无竞价一字', { pool: pool.length });
        }

        // ④ 9:25 终态快照（双闸门）
        let snapMap;
        try {
            snapMap = await _fetchSnapshot(picked.map(function (x) { return x.thscode; }), d);
        } catch (e) {
            return fail('读取同花顺竞价快照失败：' + (e && e.message || e), { pool: pool.length });
        }
        if (!snapMap) {
            return fail('竞价快照闸门未通过（上游未返回「今天 · final」的 9:25 终态，本次未写入）', { pool: pool.length });
        }

        // ⑤ 组行：只写有证据的列
        const nowIso = new Date().toISOString();
        const rows = [];
        picked.forEach(function (x) {
            const s = snapMap.get(x.thscode);
            if (!s) return;                          // 快照里没有这只票 ⇒ 跳过，不猜
            rows.push({
                date: d,
                stock: String(x.p.name || '').trim(),
                code: x.code,
                symbol: x.thscode,
                name: String(x.p.name || '').trim(),
                // 9:25 竞价涨幅（同花顺 auction_pct，与库内 auc_pct_chg 同一口径：带符号文本）
                auc_pct_chg: _pctText(s.auction_pct),
                // 9:25 竞价成交额（元）
                auc_amt: _numOrNull(s.auction_amount),
                // 9:25 竞价换手率（%）
                auc_turnover: _numOrNull(s.auction_turnover_pct),
                is_st: x.p.is_st === true,
                updated_at: nowIso
            });
        });
        if (rows.length === 0) {
            return fail('命中票在竞价快照里一只都没取到（上游快照不覆盖这些代码），本次未写入', { pool: pool.length });
        }

        // ⑥ 整日对齐写入（当天本来是 0 行，所以等于纯插入；§11 删除安全由 Data 层保证）
        try {
            const r = await replaceAuctionYiziForDate(d, rows);
            log('写入 ' + r.written + ' 行，清掉旧行 ' + r.deleted + ' 条');
        } catch (e) {
            return fail('写入 auction_yizi 失败：' + (e && e.message || e), { pool: pool.length });
        }

        return {
            ok: true,
            date: d,
            count: rows.length,
            pool: pool.length,
            message: '已用同花顺补 ' + rows.length + ' 只（9:25 快照；封单额分时曲线同花顺没有，留空）',
            logs: logs
        };
    })().finally(function () { _inflight.delete(d); });

    _inflight.set(d, task);
    return task;
}
