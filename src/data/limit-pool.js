// limit-pool.js — 涨跌停池表 limit_pool 的唯一读写入口（Data 层，§5）
//
// 职责：
//   · 读：按【交易日 date】读该日的涨停板 / 跌停板全量股票池（「涨跌停」看板唯一数据来源）；
//   · 写：整日对齐式写入（replaceLimitPoolForDate）—— 先 upsert 本次结果，再清掉该日该板
//         「本次已不在池中」的旧行，让表 = 当日快照真相；
//   · 抓：同花顺 fuyao 涨停池 / 跌停池（供前端自愈；worker 15:40 也走同一上游）；
//   · 订阅：limit_pool 的 Realtime（worker / 他端写完后，本端看板自动刷新）。
//
// 红线（§10）：读取失败必须 throw，绝不能返回空数组伪装成「今天没有涨跌停」。
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。
// 红线（§11）：删除只做「按 date + board 的小范围、精确匹配、带回读校验」，绝不做整表清空。

import { getSupabase } from './supabase-client.js';
import { fuyaoApiGet } from './api/fuyao-proxy.js';
import { _dbgLog } from './debug-log.js';
import { _emit } from '../stores/eventBus.js';

export const BOARD_UP = 'up';
export const BOARD_DOWN = 'down';

const FUYAO_LIMIT_UP_PATH = '/api/a-share/special-data/limit-up-pool';
const FUYAO_LIMIT_DOWN_PATH = '/api/a-share/special-data/limit-down-pool';
// 单页上限（上游文档：size ∈ 1..200）
const POOL_PAGE_SIZE = 200;
// 分页安全上限：防止上游 pagination 异常导致死循环
const POOL_MAX_PAGES = 10;

/**
 * 涨幅数值 → 库内统一文本口径（与 market_metrics.change_pct / stock_range_pct.range_pct 一致）。
 * 无法解析时返回 null（绝不用 0 顶替 —— 0 是一个真实涨幅）。
 * @param {*} raw
 * @returns {string|null} 形如 "+10.00" / "-9.98"
 */
function _fmtPct(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (!isFinite(n)) return null;
    return (n >= 0 ? '+' : '') + n.toFixed(2);
}

/**
 * 数值字段归一：非有限值 → null（不伪造 0）。
 */
function _numOrNull(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) ? n : null;
}

/**
 * 文本字段归一：空串/空白 → null（对齐上游「空字符串标准化为 null」的口径）。
 */
function _textOrNull(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    return s ? s : null;
}

/**
 * 上游 item → 入库行。
 * @param {object} it
 * @param {string} board BOARD_UP | BOARD_DOWN
 * @param {string} date YYYY-MM-DD
 * @param {string} nowIso
 */
function _toRow(it, board, date, nowIso) {
    const isUp = board === BOARD_UP;
    const code = String(it.ticker || it.thscode || '').trim().replace(/\..*$/, '');
    const name = String(it.name || '').trim();
    if (!name) return null;
    return {
        date: date,
        board: board,
        stock: name,
        code: /^\d{6}$/.test(code) ? code : null,
        thscode: _textOrNull(it.thscode),
        price: _numOrNull(it.last_price),
        change_pct: _fmtPct(it.price_change_ratio_pct),
        // 涨停池：涨停时间；跌停池：首次跌停时间
        limit_time: isUp ? _textOrNull(it.limit_up_time) : _textOrNull(it.first_limit_time),
        last_limit_time: isUp ? null : _textOrNull(it.last_limit_time),
        reason: isUp ? _textOrNull(it.limit_up_reason) : null,
        continue_text: isUp ? _textOrNull(it.continue_day_text) : null,
        continue_cnt: isUp ? _numOrNull(it.continue_day_cnt) : null,
        seal_money: isUp ? _numOrNull(it.seal_money) : null,
        max_seal_money: isUp ? _numOrNull(it.max_seal_money) : null,
        turnover_ratio: isUp ? null : _numOrNull(it.turnover_ratio_pct),
        updated_at: nowIso
    };
}

/**
 * 分页拉一个池的全部条目（上游 size 上限 200）。
 * @param {string} path
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{items:object[], total:number, timestamp:number}>}
 */
async function _fetchPoolAllPages(path, date) {
    const dateMs = Date.parse(date + 'T00:00:00+08:00');
    if (!isFinite(dateMs)) throw new Error('limit-pool: 日期非法 ' + date);
    const items = [];
    let total = -1;
    let timestamp = 0;
    for (let page = 1; page <= POOL_MAX_PAGES; page++) {
        const data = await fuyaoApiGet(path, {
            date_ms: dateMs,
            page: page,
            size: POOL_PAGE_SIZE
        });
        const arr = (data && data.item) || [];
        if (data && data.timestamp) timestamp = data.timestamp;
        arr.forEach(function(it) { if (it && it.name) items.push(it); });
        const pg = (data && data.pagination) || null;
        total = pg && typeof pg.total === 'number' ? pg.total : items.length;
        // 收齐 / 已无更多 → 结束
        if (arr.length === 0) break;
        if (items.length >= total) break;
        if (pg && page >= pg.pages) break;
    }
    return { items: items, total: total < 0 ? items.length : total, timestamp: timestamp };
}

/**
 * 抓取某交易日的涨停池 + 跌停池。
 *
 * ⚠️ 两个池【都要成功】才返回：任一失败直接 throw，调用方据此放弃写入
 *    （宁可保持旧快照，也不写出「只有涨停、没有跌停」的半张表）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{date:string, up:object[], down:object[], upTotal:number, downTotal:number, timestamp:number}>}
 */
export async function fetchLimitPoolFromFuyao(date) {
    if (!date) throw new Error('limit-pool: 缺少日期');
    const nowIso = new Date().toISOString();
    const upRes = await _fetchPoolAllPages(FUYAO_LIMIT_UP_PATH, date);
    const downRes = await _fetchPoolAllPages(FUYAO_LIMIT_DOWN_PATH, date);
    const up = upRes.items.map(function(it) { return _toRow(it, BOARD_UP, date, nowIso); }).filter(Boolean);
    const down = downRes.items.map(function(it) { return _toRow(it, BOARD_DOWN, date, nowIso); }).filter(Boolean);
    _dbgLog('[LIMIT-POOL] 抓取 ' + date + '：涨停 ' + up.length + '/' + upRes.total +
        ' 只，跌停 ' + down.length + '/' + downRes.total + ' 只');
    return {
        date: date,
        up: up,
        down: down,
        upTotal: upRes.total,
        downTotal: downRes.total,
        timestamp: upRes.timestamp || downRes.timestamp || 0
    };
}

/**
 * 读取某交易日的涨跌停池。
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<object>>} 行数组（可能为空 = 云端确实没有该日快照）
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readLimitPoolForDate(date) {
    if (!date) return [];
    const sb = getSupabase();
    const all = [];
    const pageSize = 1000;
    // 分页安全上限（单日池子真实规模数十~数百只；20000 行上限仅用于防上游/游标异常导致死循环）
    const maxPages = 20;
    let from = 0;
    for (let page = 0; page < maxPages; page++) {
        const { data, error } = await sb
            .from('limit_pool')
            .select('date,board,stock,code,thscode,price,change_pct,limit_time,last_limit_time,reason,continue_text,continue_cnt,seal_money,max_seal_money,turnover_ratio,updated_at')
            .eq('date', date)
            .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all
        .filter(function(r) { return r && r.stock && r.board; })
        .map(function(r) {
            return {
                date: r.date,
                board: r.board === BOARD_DOWN ? BOARD_DOWN : BOARD_UP,
                stock: String(r.stock).trim(),
                code: r.code || '',
                thscode: r.thscode || '',
                price: r.price === null || r.price === undefined ? null : Number(r.price),
                changePct: r.change_pct || '',
                limitTime: r.limit_time || '',
                lastLimitTime: r.last_limit_time || '',
                reason: r.reason || '',
                continueText: r.continue_text || '',
                continueCnt: r.continue_cnt === null || r.continue_cnt === undefined ? null : Number(r.continue_cnt),
                sealMoney: r.seal_money === null || r.seal_money === undefined ? null : Number(r.seal_money),
                maxSealMoney: r.max_seal_money === null || r.max_seal_money === undefined ? null : Number(r.max_seal_money),
                turnoverRatio: r.turnover_ratio === null || r.turnover_ratio === undefined ? null : Number(r.turnover_ratio),
                updatedAt: r.updated_at || ''
            };
        });
}

/**
 * upsert 一批涨跌停池行（主键 date+board+stock → 幂等覆盖）。
 * @param {Array<object>} rows
 * @returns {Promise<number>} 写入行数
 */
export async function upsertLimitPoolRows(rows) {
    if (!rows || rows.length === 0) return 0;
    const payload = rows.filter(function(r) { return r && r.date && r.board && r.stock; });
    if (payload.length === 0) return 0;
    const sb = getSupabase();
    // 分批：PostgREST 单次不宜过大
    const chunk = 500;
    for (let i = 0; i < payload.length; i += chunk) {
        const { error } = await sb
            .from('limit_pool')
            .upsert(payload.slice(i, i + chunk), { onConflict: 'date,board,stock' });
        if (error) throw error;
    }
    return payload.length;
}

/**
 * 删除某日某板里「已不在本次快照中」的旧行（§11 删除安全）。
 *
 * 安全约束（调用方必须保证）：
 *   · keepStocks 是【本次权威抓取结果】的股票名集合，不是猜的；
 *   · keepStocks 为空 ⇒ 本次该板确实是 0 只（如强势日没有跌停）→ 删除该板该日全部行，这是正确结果；
 *   · 只按 (date, board) 限定范围，绝不触碰其它日期；
 *   · 带 .select('stock') 回读受影响行 → 返回真实删除条数，调用方可校验。
 *
 * @param {string} date
 * @param {string} board
 * @param {string[]} keepStocks
 * @returns {Promise<number>} 实际删除行数
 */
export async function deleteStaleLimitPoolRows(date, board, keepStocks) {
    if (!date || !board) return 0;
    const keep = (keepStocks || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
    const sb = getSupabase();
    let q = sb.from('limit_pool').delete().eq('date', date).eq('board', board);
    if (keep.length > 0) q = q.not('stock', 'in', '(' + keep.map(function(s) { return '"' + s.replace(/"/g, '') + '"'; }).join(',') + ')');
    const { data, error } = await q.select('stock');
    if (error) throw error;
    return (data || []).length;
}

/**
 * 【整日对齐写入】把某交易日的涨跌停池整体替换为本次抓取结果。
 *
 * 顺序：先 upsert（本次结果全部就位）→ 再删旧行（本次已不在池中的）。
 * 这样即使删旧行失败，也只会「多留几行旧数据」，不会出现「该日池子为空」的空窗。
 *
 * ⚠️ 仅允许在「涨停池 + 跌停池都抓成功」后调用（见 fetchLimitPoolFromFuyao 的合约）。
 *
 * @param {{date:string, up:object[], down:object[]}} snapshot
 * @returns {Promise<{written:number, deletedUp:number, deletedDown:number}>}
 */
export async function replaceLimitPoolForDate(snapshot) {
    if (!snapshot || !snapshot.date) throw new Error('limit-pool: 缺少快照日期');
    const date = snapshot.date;
    const up = snapshot.up || [];
    const down = snapshot.down || [];
    const written = await upsertLimitPoolRows(up.concat(down));
    const deletedUp = await deleteStaleLimitPoolRows(date, BOARD_UP, up.map(function(r) { return r.stock; }));
    const deletedDown = await deleteStaleLimitPoolRows(date, BOARD_DOWN, down.map(function(r) { return r.stock; }));
    _dbgLog('[LIMIT-POOL] ' + date + ' 整日对齐完成：写入 ' + written + ' 行，' +
        '清掉涨停旧行 ' + deletedUp + ' 条、跌停旧行 ' + deletedDown + ' 条');
    return { written: written, deletedUp: deletedUp, deletedDown: deletedDown };
}

// ===== Realtime 订阅（§31：单模块持有 channel，start 先 stop 保证幂等，stop 配对 removeChannel）=====
// 复用既有订阅模式的唯一目的：worker 15:40 写完后，已打开看板的设备无需手动刷新即可看到当天涨跌停池。
let _limitPoolChannel = null;
let _limitPoolReloadTimer = null;
// [PERF] 批量写入（worker 整日对齐 = 上百条变更）必须合并成一次刷新（§22 批量合并）。
const LIMIT_POOL_RELOAD_DEBOUNCE_MS = 500;

export function startLimitPoolRealtime() {
    stopLimitPoolRealtime();
    try {
        const sb = getSupabase();
        if (!sb) return;
        _limitPoolChannel = sb
            .channel('limit_pool_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'limit_pool' }, function() {
                if (_limitPoolReloadTimer) clearTimeout(_limitPoolReloadTimer);
                _limitPoolReloadTimer = setTimeout(function() {
                    _limitPoolReloadTimer = null;
                    _emit('data:realtime-update', { boards: 'limitpool' });
                }, LIMIT_POOL_RELOAD_DEBOUNCE_MS);
            })
            .subscribe();
        console.log('limit_pool Realtime 订阅已启动');
    } catch (e) {
        _dbgLog('[LIMIT-POOL] Realtime 订阅失败 ' + (e && e.message || e));
    }
}

export function stopLimitPoolRealtime() {
    if (_limitPoolReloadTimer) {
        clearTimeout(_limitPoolReloadTimer);
        _limitPoolReloadTimer = null;
    }
    if (_limitPoolChannel) {
        try { getSupabase().removeChannel(_limitPoolChannel); } catch (e) { /* 忽略 */ }
        _limitPoolChannel = null;
    }
}
