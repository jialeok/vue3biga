// auction-yizi.js — 竞价一字表 auction_yizi 的唯一读写入口（Data 层，§5）
//
// 职责：
//   · 读：按【交易日 date】读该日全量「竞价一字」快照（「竞价一字」看板唯一数据来源）；
//   · 写：整日对齐式写入（replaceAuctionYiziForDate）—— 先 upsert 本次结果，再清掉该日
//         「本次已不在池中」的旧行，让表 = 当日快照真相；
//   · 订阅：auction_yizi 的 Realtime（9:25 Edge Function auction-yizi-fetch 写完后，
//           已打开看板的设备无需手动刷新即可看到当天的一字池）。
//
// ⚠️ 本表与「早盘竞价看板」彻底解耦：
//   · 上游是猫抓数据的【另一只小号】接口 daily_auc_fd；
//   · 抓取执行者是【独立的】Edge Function auction-yizi-fetch（独立 URL / 独立令牌 /
//     独立 key / 独立 cron），不是 numcat-proxy、不是 bidding-a、不是任何 Cloudflare worker；
//   · 本 Data 层【只读库、不直连上游】：前端不做自愈抓取，也不碰任何 apikey。
//     原因：9:15~9:25 的竞价快照有强时效性，必须由 9:25 的定时任务一次性落库；
//     前端补抓只可能发生在「已经错过窗口」之后，无意义且会多烧一份小号额度。
//     （对比 limit-pool.js：涨跌停池是 15:40 收盘后数据，前端自愈补抓是有意义的兜底。）
//
// 红线（§10）：读取失败必须 throw，绝不能返回空数组伪装成「今天没有一字」。
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。
// 红线（§11）：删除只做「按 date 的小范围、精确匹配、带回读校验」，绝不做整表清空。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { _emit } from '../stores/eventBus.js';

/**
 * 把 PostgREST 的「找不到表」原文翻译成「该干什么」。
 *
 * 现场：看板红字 `Could not find the table 'public.auction_yizi' in the schema cache`
 * —— 这不是「读数方法不对」，就是【表还没建】（PGRST205 / 42P01）。
 * ⚠️ 仍然 throw（§10：读取失败必须抛出），只是把原因说清楚，绝不退化成空数组。
 *
 * @param {*} e supabase-js 抛出的 error
 * @returns {Error}
 */
function _explainDbError(e) {
    const raw = (e && e.message) || String(e || '');
    const t = raw.toLowerCase();
    if (t.indexOf('could not find the table') >= 0 || t.indexOf('in the schema cache') >= 0 ||
        t.indexOf('does not exist') >= 0 || t.indexOf('pgrst205') >= 0 || t.indexOf('42p01') >= 0) {
        return new Error('auction_yizi 表不存在：请在 Supabase Dashboard → SQL Editor 执行 db/create_auction_yizi.sql 建表（原文：' + raw + '）');
    }
    return e instanceof Error ? e : new Error(raw);
}

/** 数值字段归一：非有限值 → null（不伪造 0） */
function _numOrNull(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) ? n : null;
}

/** 文本字段归一：空串/空白 → '' （UI 直接渲染，无需再判 null） */
function _textOrEmpty(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim();
}

// 封单额证据链的列名（顺序 = 时间顺序，与 Edge Function 的 FA_SEQ 一致）
export const FA_COLUMNS = [
    'fa_0915', 'fa_0916', 'fa_0917', 'fa_0918', 'fa_0919',
    'fa_0920', 'fa_0920f', 'fa_0921', 'fa_0922', 'fa_0923', 'fa_0924',
    'fa_0925', 'fa_0925l'
];

// 读取列清单（显式列出：不猜列、不 select *，§40）
const SELECT_COLUMNS = [
    'date', 'stock', 'code', 'symbol', 'name',
    'auc_pct_chg', 'auc_amt', 'auc_turnover',
    'seal_money', 'fa_count', 'fa_first',
    'theme_kpl', 'theme_xgb', 'is_st',
    'updated_at'
].concat(FA_COLUMNS);

/**
 * 读取某交易日的竞价一字快照。
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<object>>} 行数组（可能为空 = 云端确实没有该日快照）
 * @throws 读取失败时抛错（绝不静默返回空）
 */
export async function readAuctionYiziForDate(date) {
    if (!date) return [];
    const sb = getSupabase();
    const all = [];
    const pageSize = 1000;
    // 分页安全上限（单日一字池真实规模几只~百余只；10000 行上限仅用于防游标异常导致死循环）
    const maxPages = 10;
    let from = 0;
    for (let page = 0; page < maxPages; page++) {
        const { data, error } = await sb
            .from('auction_yizi')
            .select(SELECT_COLUMNS.join(','))
            .eq('date', date)
            .range(from, from + pageSize - 1);
        if (error) throw _explainDbError(error);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all
        .filter(function(r) { return r && r.stock; })
        .map(function(r) {
            const fa = {};
            FA_COLUMNS.forEach(function(col) {
                fa[col] = _numOrNull(r[col]);
            });
            return {
                date: r.date,
                stock: String(r.stock).trim(),
                code: r.code || '',
                symbol: r.symbol || '',
                // 上游原始名保留原名；正常等于 stock，改名时可看出差异
                name: _textOrEmpty(r.name) || String(r.stock).trim(),
                aucPct: r.auc_pct_chg || '',
                aucAmt: _numOrNull(r.auc_amt),
                aucTurnover: _numOrNull(r.auc_turnover),
                // 9:25 口径封单额（元）= 时间上最后一笔非空 fa_*，服务端已算好并落库
                sealMoney: _numOrNull(r.seal_money),
                faCount: _numOrNull(r.fa_count) === null ? 0 : Number(r.fa_count),
                faFirst: r.fa_first || '',
                fa: fa,
                themeKpl: r.theme_kpl || '',
                themeXgb: r.theme_xgb || '',
                isSt: r.is_st === true,
                updatedAt: r.updated_at || ''
            };
        });
}

/**
 * upsert 一批竞价一字行（主键 date+stock → 幂等覆盖）。
 * @param {Array<object>} rows
 * @returns {Promise<number>} 写入行数
 */
export async function upsertAuctionYiziRows(rows) {
    if (!rows || rows.length === 0) return 0;
    const payload = rows.filter(function(r) { return r && r.date && r.stock; });
    if (payload.length === 0) return 0;
    const sb = getSupabase();
    // 分批：PostgREST 单次不宜过大
    const chunk = 500;
    for (let i = 0; i < payload.length; i += chunk) {
        const { error } = await sb
            .from('auction_yizi')
            .upsert(payload.slice(i, i + chunk), { onConflict: 'date,stock' });
        if (error) throw _explainDbError(error);
    }
    return payload.length;
}

/**
 * 删除某日里「已不在本次快照中」的旧行（§11 删除安全）。
 *
 * 安全约束（调用方必须保证）：
 *   · keepStocks 是【本次权威抓取结果】的股票名集合，不是猜的；
 *   · keepStocks 为空 ⇒ 【直接返回 0，什么都不删】。一字池「当日真的一只都没有」几乎不可能
 *     出现（那样本就说明上游没就绪，调用方不该走到这里）；把它当成「清空整天」会把一次
 *     空返回放大成数据丢失事故。
 *   · 只按 date 限定范围，绝不触碰其它日期；
 *   · 带 .select('stock') 回读受影响行 → 返回真实删除条数，调用方可校验。
 *
 * @param {string} date
 * @param {string[]} keepStocks
 * @returns {Promise<number>} 实际删除行数
 */
export async function deleteStaleAuctionYiziRows(date, keepStocks) {
    if (!date) return 0;
    const keep = (keepStocks || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
    if (keep.length === 0) return 0;
    const sb = getSupabase();
    const q = sb.from('auction_yizi')
        .delete()
        .eq('date', date)
        .not('stock', 'in', '(' + keep.map(function(s) { return '"' + s.replace(/"/g, '') + '"'; }).join(',') + ')');
    const { data, error } = await q.select('stock');
    if (error) throw _explainDbError(error);
    return (data || []).length;
}

/**
 * 【整日对齐写入】把某交易日的竞价一字整体替换为本次快照。
 *
 * 顺序：先 upsert（本次结果全部就位）→ 再删旧行（本次已不在池中的）。
 * 这样即使删旧行失败，也只会「多留几行旧数据」，不会出现「该日池子为空」的空窗。
 *
 * @param {string} date YYYY-MM-DD
 * @param {Array<object>} rows 本次快照的入库行（含 date 字段）
 * @returns {Promise<{written:number, deleted:number}>}
 */
export async function replaceAuctionYiziForDate(date, rows) {
    if (!date) throw new Error('auction-yizi: 缺少快照日期');
    const list = (rows || []).filter(function(r) { return r && r.stock; });
    if (list.length === 0) throw new Error('auction-yizi: 快照为空，拒绝整日对齐（避免清空该日）');
    const written = await upsertAuctionYiziRows(list.map(function(r) {
        return Object.assign({}, r, { date: date });
    }));
    const deleted = await deleteStaleAuctionYiziRows(date, list.map(function(r) { return r.stock; }));
    _dbgLog('[AUCTION-YIZI] ' + date + ' 整日对齐完成：写入 ' + written + ' 行，清掉旧行 ' + deleted + ' 条');
    return { written: written, deleted: deleted };
}

// ===== Realtime 订阅（§31：单模块持有 channel，start 先 stop 保证幂等，stop 配对 removeChannel）=====
// 目的：9:25（auction-yizi-fetch）写完后，已打开看板的设备无需手动刷新即可看到当天一字池。
let _yiziChannel = null;
let _yiziReloadTimer = null;
// [PERF] 批量写入（整日对齐 = 多条变更）必须合并成一次刷新（§22 批量合并）
const YIZI_RELOAD_DEBOUNCE_MS = 500;

export function startAuctionYiziRealtime() {
    stopAuctionYiziRealtime();
    try {
        const sb = getSupabase();
        if (!sb) return;
        _yiziChannel = sb
            .channel('auction_yizi_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'auction_yizi' }, function() {
                if (_yiziReloadTimer) clearTimeout(_yiziReloadTimer);
                _yiziReloadTimer = setTimeout(function() {
                    _yiziReloadTimer = null;
                    _emit('data:realtime-update', { boards: 'yizi' });
                }, YIZI_RELOAD_DEBOUNCE_MS);
            })
            .subscribe();
        console.log('auction_yizi Realtime 订阅已启动');
    } catch (e) {
        _dbgLog('[AUCTION-YIZI] Realtime 订阅失败 ' + (e && e.message || e));
    }
}

export function stopAuctionYiziRealtime() {
    if (_yiziReloadTimer) {
        clearTimeout(_yiziReloadTimer);
        _yiziReloadTimer = null;
    }
    if (_yiziChannel) {
        try { getSupabase().removeChannel(_yiziChannel); } catch (e) { /* 忽略 */ }
        _yiziChannel = null;
    }
}
