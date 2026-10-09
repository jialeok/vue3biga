// decision-chart-judge.js — 手动「竞价图形判断」表 decision_chart_judge 的唯一读写入口（Data 层，§5）
//
// 职责：
//   · 读：按【交易日 date】一次读回该日全部判断 → { 股票名: 'ok' | 'bad' } 的 map（看板按名字查）；
//   · 写：单行 upsert（主键 date + stock，幂等覆盖）；选回【默认】= 删掉那一行；
//   · 订阅：Realtime —— 另一台设备 / 另一个标签页改了判断后，本端看板自动跟着变。
//
// 分层边界（§6 语义只有一处）：
//   ⛔ 本文件【不定义】judge 的取值语义（'ok' = 符合 / 'bad' = 不符合）。
//      那是业务语义，唯一实现在 logic/decision/decision-chart-judge.js#JUDGE_*。
//      本层只把 judge 当成一个【非空字符串】存 / 取（⛔ 不在这里再写一遍字面量 'ok'/'bad'，
//      否则以后改口径就会出现「Logic 认 ok、Data 认 good」这种一半生效的裂缝）。
//      §10：读到空串 / 空白 / 脏值一律【丢弃该行】—— 宁可当成「没有判断」（= 默认），
//          也不把垃圾值塞给上层去猜。
//
// 红线（§10）：读取失败必须 throw，绝不能返回 {} 伪装成「今天没有手动判断」。
//              （返回空 map 的后果：用户屏上所有「我明明选过」的判断全变回【默认】，
//                看起来像功能失效 —— 必须与「真的没选过」区分开。）
// 红线（§8）：本表是云端业务数据，禁止用 localStorage 兜底。
// 红线（§11）：删除只做「按 date + stock 的精确单行删除 + 回读校验」，
//              ⛔ 绝不做「按 date 整日清空」（那会连带抹掉同日其它票的判断）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { _emit } from '../stores/eventBus.js';

export const CHART_JUDGE_TABLE = 'decision_chart_judge';

/** 本端保存后，Realtime 会回灌同一条变化 —— 打一个标，便于排查时区分「自己写的」与「别人写的」 */
const CHART_JUDGE_BOARD_KEY = 'chartjudge';

/**
 * 把 PostgREST 的「找不到表」原文翻译成「该干什么」。
 *
 * 与 data/limit-pool.js#_explainDbError 同一套路：PGRST205 / 42P01 不是「读数方式不对」，
 * 就是【表还没建】。直接翻成一句可执行的指引，省掉一整轮猜测。
 * ⚠️ 仍然 throw（§10：读取失败必须抛出），只是把原因说清楚，绝不退化成空 map。
 *
 * @param {*} e supabase-js 抛出的 error
 * @returns {Error}
 */
function _explainDbError(e) {
    const raw = (e && e.message) || String(e || '');
    const t = raw.toLowerCase();
    if (t.indexOf('could not find the table') >= 0 || t.indexOf('in the schema cache') >= 0 ||
        t.indexOf('does not exist') >= 0 || t.indexOf('pgrst205') >= 0 || t.indexOf('42p01') >= 0) {
        return new Error(CHART_JUDGE_TABLE +
            ' 表不存在：请在 Supabase Dashboard → SQL Editor 执行 db/create_decision_chart_judge.sql 建表（原文：' +
            raw + '）');
    }
    return e instanceof Error ? e : new Error(raw);
}

/** 股票名归一：空串 / 空白 → null（⛔ 不拿空格当名字） */
function _stockOrNull(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    return s ? s : null;
}

/**
 * 读取某交易日的全部手动判断。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Object>} { 股票名: judge字符串 }（可能为空对象 = 该日确实一个判断都没有）
 * @throws 读取失败时抛错（绝不静默返回空 —— 见文件头 §10 说明）
 */
export async function readDecisionChartJudgeForDate(date) {
    const d = _stockOrNull(date);
    if (!d) return {};
    const sb = getSupabase();
    const map = {};
    const pageSize = 1000;
    // 分页安全上限：一天最多也就几十~几百只票，1000×5 仅用于防游标异常导致死循环
    const maxPages = 5;
    let from = 0;
    for (let page = 0; page < maxPages; page++) {
        const { data, error } = await sb
            .from(CHART_JUDGE_TABLE)
            .select('date,stock,judge')
            .eq('date', d)
            .range(from, from + pageSize - 1);
        if (error) throw _explainDbError(error);
        if (!data || data.length === 0) break;
        data.forEach(function(r) {
            const stock = _stockOrNull(r && r.stock);
            const judge = _stockOrNull(r && r.judge);
            // §10：脏值（空串 / 空白）当成「没有判断」，⛔ 不塞给上层
            if (stock && judge) map[stock] = judge;
        });
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return map;
}

/**
 * 写入 / 清除一条手动判断（§11：只碰 (date, stock) 这一行）。
 *
 * judge 传空（'' / null / undefined）⇒ 【删除】该行 —— 语义 = 用户选回了「默认」，
 * 表里没有行就等于「没手动判断过」，与从未点过完全等价（§6 不留两条看起来一样的路径）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {string} stock 股票简称
 * @param {string} judge 判断值（非空字符串写库；空 ⇒ 删行）
 * @returns {Promise<{written:number, removed:number}>}
 * @throws 保存失败时抛错（§10：绝不让用户以为保存成功了）
 */
export async function saveDecisionChartJudge(date, stock, judge) {
    const d = _stockOrNull(date);
    if (!d) throw new Error(CHART_JUDGE_TABLE + '：缺少日期，无法保存');
    const s = _stockOrNull(stock);
    if (!s) throw new Error(CHART_JUDGE_TABLE + '：缺少股票名，无法保存');
    const j = _stockOrNull(judge);
    const sb = getSupabase();

    if (!j) {
        // 「默认」⇒ 删掉这一行。⛔ 精确匹配 (date, stock) 单行；⛔ 不按 date 整日清空。
        // 带 .select('stock') 回读受影响行 ⇒ 返回真实删除条数，调用方可校验（§11 删除结果验证）。
        const { data, error } = await sb
            .from(CHART_JUDGE_TABLE)
            .delete()
            .eq('date', d)
            .eq('stock', s)
            .select('stock');
        if (error) throw _explainDbError(error);
        const removed = (data || []).length;
        _dbgLog('[CHART-JUDGE] 清除 ' + d + ' / ' + s + '（回到默认）：影响 ' + removed + ' 行');
        return { written: 0, removed: removed };
    }

    const { error } = await sb
        .from(CHART_JUDGE_TABLE)
        .upsert([{ date: d, stock: s, judge: j, updated_at: new Date().toISOString() }],
            { onConflict: 'date,stock' });
    if (error) throw _explainDbError(error);
    _dbgLog('[CHART-JUDGE] 保存 ' + d + ' / ' + s + ' = ' + j);
    return { written: 1, removed: 0 };
}

// ===== Realtime 订阅（§31：单模块持有 channel，start 先 stop 保证幂等，stop 配对 removeChannel）=====
// 用途：同一账号在另一台设备 / 另一个标签页改了判断后，本端看板无需手动刷新即可看到。
let _chartJudgeChannel = null;
let _chartJudgeReloadTimer = null;
// [PERF] 连续点几下必须合并成一次刷新（§22 批量合并）
const CHART_JUDGE_RELOAD_DEBOUNCE_MS = 500;

export function startChartJudgeRealtime() {
    stopChartJudgeRealtime();
    try {
        const sb = getSupabase();
        if (!sb) return;
        _chartJudgeChannel = sb
            .channel(CHART_JUDGE_TABLE + '_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: CHART_JUDGE_TABLE }, function() {
                if (_chartJudgeReloadTimer) clearTimeout(_chartJudgeReloadTimer);
                _chartJudgeReloadTimer = setTimeout(function() {
                    _chartJudgeReloadTimer = null;
                    _emit('data:realtime-update', { boards: CHART_JUDGE_BOARD_KEY });
                }, CHART_JUDGE_RELOAD_DEBOUNCE_MS);
            })
            .subscribe();
        console.log(CHART_JUDGE_TABLE + ' Realtime 订阅已启动');
    } catch (e) {
        // 订阅失败不影响主流程：本次判断已在屏上（乐观更新），只是跨设备同步晚一点。
        // §10：如实打日志，⛔ 不静默吞掉。
        _dbgLog('[CHART-JUDGE] Realtime 订阅失败 ' + (e && e.message || e));
    }
}

export function stopChartJudgeRealtime() {
    if (_chartJudgeReloadTimer) {
        clearTimeout(_chartJudgeReloadTimer);
        _chartJudgeReloadTimer = null;
    }
    if (_chartJudgeChannel) {
        try { getSupabase().removeChannel(_chartJudgeChannel); } catch (e) { /* 忽略 */ }
        _chartJudgeChannel = null;
    }
}
