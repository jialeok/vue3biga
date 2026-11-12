// leader-diverge-days.js — 第二十五条「总龙首次/二次分歧」云端判定表 tvrb_leader_diverge 的唯一读取入口
//                            （Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [LD-CLOUD 2026-11-13 用户口径 · 原话] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「你帮我完成啊，不要留着，记住都是在云端运行，关电脑也能用，不要电脑本地的，
//     我之前强调好几次了，把没完成的完成」
//
// ── 这个模块只做一件事：把「云端算好的判定」读回来 ─────────────────────────────────
//   判定本身（近 20 个交易日的竞价涨幅 / 收盘涨幅 / 竞价占比 / 每天是不是总龙一）
//   全部由 Cloudflare Worker 算完并写进 `tvrb_leader_diverge`
//   （workers/bidding-auto-fetch/logic/leader-diverge-days.js，9:27 + 16:00 各跑一次）。
//   前端 ⛔ 不重算、⛔ 不发 K 线请求、⛔ 不依赖本机开机 —— 只读一行。
//
// ── 消费方（唯一）────────────────────────────────────────────────────────────────
//   src/composables/useTopicVolRatioBoard.js#ensureLeaderDivergeDays
//   ⇒ 注入 `ebbCtx.leaderDiverge` ⇒ `tvrb-ebb.js#detectEbbDay`
//     （`dv.kind === 'second' && dv.qualified !== false` ⇒ 按用户口径「二次分歧等同首次退潮」）
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────
//   §10：读失败必须 throw（⛔ 不返回 null 假装「云端判定没有」）—— 上层据此留痕并退回旧口径；
//        唯一的例外是「表还不存在」（部署前置）⇒ 冷却期内不再重试（§32）。
//   §11：没有这一行 ⇒ 返回 null ⇒ 退潮判定与加这张表之前**逐字相同**（零风险回退）。
//   §32：按 (日期|股票) 会话缓存 + 单飞 + 30s 失败冷却，同一格只请求一次。
//   §11 删除安全：只 select，⛔ 绝无 delete / upsert（写入方只有云端 Worker）。

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** 表名（唯一出处；⛔ 别在别处再写一次字符串） */
export const LEADER_DIVERGE_TABLE = 'tvrb_leader_diverge';

/** 列清单（与 db/create_tvrb_leader_diverge.sql 一一对应；⛔ 加列必须同时改 SQL 与这里） */
const COLS = 'date,stock,kind,qualified,reason,dragon_days,event_count,start_date,first_date,' +
  'first_end_date,second_date,second_end_date,boards_after_first,window_days,leg_phase,rows,updated_at';

/** 表不存在（PGRST205 / 42P01 / 404）⇒ 10 分钟冷却，建表后自动自愈（与 diverge-days.js 同款） */
const TABLE_MISSING_COOLDOWN_MS = 10 * 60 * 1000;
let _tableMissingUntil = 0;

/** 读取失败冷却（§32：网络抖动不反复打；30s 后允许再试） */
const FAIL_COOLDOWN_MS = 30 * 1000;
let _failUntil = 0;

/** 会话缓存：`date|stock` -> row | null（null = 这一格云端确实没有行，避免反复重查） */
const _cache = new Map();
/** 单飞：key -> Promise<row|null> */
const _inflight = new Map();

function _isMissingTable(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
  return code === 'PGRST205' || code === '42P01' || /could not find the table|does not exist|schema cache/i.test(msg);
}

function _statOf(code, stock) {
  return String(code || '').trim() + '|' + String(stock || '').trim();
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 表里的行 → 业务形状（字段名收口在这里，⛔ 上层不直接读 snake_case）。
 *
 * ⚠️ 返回形状必须与 `tvrb-ebb.js#detectEbbDay` / `divergeNoteOf` 读的键**逐字对齐**：
 *    kind / qualified / dragonDays / firstDate / secondDate / boardsAfterFirst。
 */
function _normalize(r) {
  const rows = Array.isArray(r.rows) ? r.rows : [];
  return {
    source: 'cloud',
    date: String(r.date || ''),
    stock: String(r.stock || ''),
    kind: String(r.kind || 'unknown'),
    qualified: r.qualified === true,
    reason: String(r.reason || ''),
    dragonDays: _num(r.dragon_days),
    eventCount: _num(r.event_count) || 0,
    startDate: String(r.start_date || ''),
    firstDate: String(r.first_date || ''),
    firstEndDate: String(r.first_end_date || ''),
    secondDate: String(r.second_date || ''),
    secondEndDate: String(r.second_end_date || ''),
    boardsAfterFirst: _num(r.boards_after_first) || 0,
    windowDays: _num(r.window_days) || 0,
    legPhase: String(r.leg_phase || ''),
    rows: rows,
    updatedAt: r.updated_at || ''
  };
}

/** 真正发请求那一段（查完把结果 / 空结果写进会话缓存） */
async function _fetchOne(date, stock) {
  let data = null;
  let error = null;
  try {
    const res = await getSupabase().from(LEADER_DIVERGE_TABLE)
      .select(COLS)
      .eq('date', date)
      .eq('stock', stock)
      .limit(1);
    data = res.data;
    error = res.error;
  } catch (e) {
    error = e;
  }
  if (error) {
    if (_isMissingTable(error)) {
      _tableMissingUntil = Date.now() + TABLE_MISSING_COOLDOWN_MS;
      _dbgLog('[LD-DAYS] 表 ' + LEADER_DIVERGE_TABLE + ' 不存在（执行 db/create_tvrb_leader_diverge.sql 后最迟 10 分钟自愈）' +
        ' ⇒ 本会话不做第二十五条判定（退潮规则退回旧口径，§11）');
      return null;                                  // 「表还不存在」不是读失败，按「没有记录」处理
    }
    throw error;                                    // §10：真失败必须抛，⛔ 不静默成 null
  }
  const row = (data && data[0]) ? _normalize(data[0]) : null;
  _cache.set(_statOf(date, stock), row);
  return row;
}

/**
 * 读取某日 · 某只总龙一的【云端分歧判定】。
 *
 * @param {string} date  展示日 YYYY-MM-DD
 * @param {string} stock 该日的市场总龙一（⛔ 必须与云端写入时那只一致，否则读不到 ⇒ 退回旧口径）
 * @returns {Promise<object|null>} null = 云端还没算过这一格（≠ 读失败；读失败会 throw）
 * @throws 读取失败（除「表不存在」外）
 */
export async function readLeaderDivergeDay(date, stock) {
  const d = String(date || '').trim();
  const s = String(stock || '').trim();
  if (!d || !s) return null;
  if (Date.now() < _tableMissingUntil) return null;   // 冷却期内已知没有这张表 ⇒ 不发请求（§32）
  const key = _statOf(d, s);
  if (_cache.has(key)) return _cache.get(key);
  if (Date.now() < _failUntil) return null;           // 刚失败过 ⇒ 冷却期内不再重试（§32）

  const fly = _inflight.get(key);
  if (fly) return fly;
  const p = _fetchOne(d, s).catch(function (e) {
    _failUntil = Date.now() + FAIL_COOLDOWN_MS;
    throw e;
  }).finally(function () {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}

/** 清空会话缓存（仅供测试；⛔ 正常业务流程无需调用）。不清冷却窗（那是会话级结论）。 */
export function clearLeaderDivergeDaysCache() {
  _cache.clear();
  _inflight.clear();
}

/** 仅测试用：把冷却窗复位（表不存在 / 读取失败） */
export function _resetLeaderDivergeDaysCooldown() {
  _tableMissingUntil = 0;
  _failUntil = 0;
}
