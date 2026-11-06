// ladder-heal.js — 「最近多板 / 883410 成分股」名单源失败时的补救（Logic 层）
//
// ============================================================================
// [P0 2026-11-06 事故] 用户报障「早盘竞价看板最重要的每天股票入口没有票，只有龙头组和观察组」。
//
//   取证（bidding_fetch_log 01:25:35Z / 北京 09:25:35）：
//     ⚠️ 883410 成分股获取失败（已重试）: fuyao ... 错误: Data source unavailable
//     成分股数量: 0（⬇️ 降级模式：名单源不可用）
//     步骤2：⬇️ 降级模式 → 跳过 auction_watchlist 名单落库（避免写入残缺名单）
//   ⇒ 当天 auction_watchlist 只剩 17 行前端观察组壳行（obs_auto_added=true，前端明确不算正式成员），
//     market_metrics 却有 78 行 ⇒ 「数据在库里、列表里一只票都没有」。
//
//   根因不是数据源冲突，也不是前一天的改动，而是 2026-09-15 那条降级保护：
//     当时为了修「名单源 429 → 整轮 return → 三张表全空」，改成「降级也继续抓行情」，
//     顺手加了「降级时绝不写 auction_watchlist」。它保住了竞价数据，却把【常规组】清空。
//     §10 的「读取失败 ≠ 空数据」在这里被反过来用成了「读取失败 ⇒ 名单干脆不写」。
//
//   本模块的口径（两句话）：
//     ① 名单源恢复 ⇒ 写【今天真实 883410 名单】；
//     ② 名单源仍不可用 ⇒ 写【前一交易日正式成员】的兜底名单，并明确标 source='worker-fallback'，
//        同时保留 ladderDegraded=true ⇒ 第一页「最近多板源条数」显示 `--`（可观测，不伪装成 0）。
//     ⛔ 无论哪条路都不写「空名单」，也不把观察组壳行 / 20日补位票 / 标签票当正式成员。
//
//   【成本】0 次猫抓请求；降级时最多 1 次名单源重试；兜底只读已经读过的 Supabase 结果。
//   【时点】runMorning 里的自愈排在 P0/P1/P2/P3 全部落库之后，绝不会顶穿 9:26 硬指标。
// ============================================================================
import { beijingNow, beijingToday } from '../../_shared-source/date-utils.js';
import { fetchLadderConstituents } from '../data/fuyao-api.js';
import { readAuctionWatchlistForDate, upsertAuctionWatchlist } from '../data/supabase-write.js';

/** 883410 成分股正常在 55~95 只；少于这个数当成上游返回残缺，⛔ 绝不写进正式名单（§10） */
export const MIN_LADDER_ROWS = 30;

/** 兜底名单至少要有这么多正式成员才值得写，否则宁可不写并报警 */
export const MIN_FALLBACK_ROWS = 20;

/** 这些 source 不是「最近多板成分股」：20日补位票 / 前端观察组壳行 / 影子行 / 热点票 */
const NON_FORMAL_SOURCES = new Set(['range20', 'manual', 'shadow', 'hot']);

/** 9:25 名单锁定窗口（与 morning-workflow.js#fetchAndWriteWatchlist 同口径，唯一判据） */
export function isMorningWindow(nowBj) {
  const mins = nowBj.getUTCHours() * 60 + nowBj.getUTCMinutes();
  return mins >= 9 * 60 + 25 && mins <= 9 * 60 + 40;
}

/**
 * 纯函数：上游名册 → auction_watchlist 行。
 * 过滤无名/非法 code、按 name 去重；source 由调用方给（真实名单 'worker' / 兜底 'worker-fallback'）。
 */
export function buildLadderWatchlistRows(ladder, today, nowIso, source) {
  const out = [];
  const seen = new Set();
  (ladder || []).forEach(function (c) {
    if (!c) return;
    const name = String(c.name || '').trim();
    const code = String(c.code || '').trim();
    if (!name || !/^\d{6}$/.test(code) || seen.has(name)) return;
    seen.add(name);
    out.push({
      date: today,
      stock: name,
      code: code,
      source: source || 'worker',
      obs_auto_added: false,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker'
    });
  });
  return out;
}

/**
 * 纯函数：降级兜底名单 = 前一交易日的【正式成员】，排除观察组 / 补位票 / 影子行。
 * ⚠️ 只用已有读取结果（prevRows / todayRows），不额外发请求。
 * ⚠️ 达到 minRows 才返回，否则返回 [] —— 宁可不写，也不写一份残缺名单（§10 宁缺勿错）。
 */
export function pickFallbackWatchlistRows(prevRows, today, nowIso, minRows) {
  const isFormal = function (r) {
    if (!r) return false;
    if (r.obs_auto_added) return false;                       // 观察组壳行
    if (NON_FORMAL_SOURCES.has(String(r.source || '').trim())) return false;
    return /^\d{6}$/.test(String(r.code || '').trim());      // 没 code 的行不能当正式成员
  };
  const out = [];
  const seen = new Set();
  (prevRows || []).forEach(function (r) {
    if (!isFormal(r)) return;
    const name = String(r.name || '').trim();
    const code = String(r.code || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      date: today,
      stock: name,
      code: code,
      source: 'worker-fallback',
      obs_auto_added: false,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker'
    });
  });
  const need = minRows === undefined ? MIN_FALLBACK_ROWS : minRows;
  return out.length >= need ? out : [];
}

/**
 * 补写当日正式名单。三种调用方：
 *   · runMorning 末尾（ladderDegraded=true）：先重试名单源，失败才 allowFallback；
 *   · 手动 /fetch?point=ladder：上游恢复后只补名单，⛔ 不重算行情、⛔ 不烧猫抓额度；
 *   · 不允许「读取当日名单失败」时往下写（§10 读取失败 ≠ 空）。
 *
 * @returns {Promise<{ok:boolean,today:string,written:number,recovered:boolean,fallback:boolean,ladderCount:number|null,logs:string[]}>}
 */
export async function healLadderWatchlist(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const nowIso = new Date().toISOString();
  const out = {
    ok: false, today: today, written: 0, recovered: false,
    fallback: false, ladderCount: null, logs: logs
  };

  // 1) 当日名单现状（9:25 名单锁定的唯一依据）。读取失败必须停，不许当成空名单继续写。
  let todayRows;
  try {
    todayRows = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder-heal] ❌ 读取当日 auction_watchlist 失败 → 停止补写（避免误覆盖）: ' +
      (e && e.message ? e.message : String(e)));
    return out;
  }
  const officialNames = new Set(todayRows.filter(r => !r.obs_auto_added).map(r => r.name));

  // 2) 重试名单源（降级时这是第二次；手动入口是第一次）
  let ladder = null;
  try {
    const raw = await fetchLadderConstituents(env);
    if (Array.isArray(raw) && raw.length >= MIN_LADDER_ROWS) {
      ladder = raw;
      out.recovered = true;
      out.ladderCount = raw.length;
      logs.push('[ladder-heal] ✅ 883410 名单源恢复，拿到 ' + raw.length + ' 只 → 写入今天真实名单');
    } else {
      logs.push('[ladder-heal] ⚠️ 883410 只返回 ' + (Array.isArray(raw) ? raw.length : 0) +
        ' 只（<' + MIN_LADDER_ROWS + '），视为残缺，不写正式名单');
    }
  } catch (e) {
    logs.push('[ladder-heal] ⚠️ 883410 重试仍失败: ' + (e && e.message ? e.message : String(e)));
  }

  // 3) 真实名单优先；仍失败才用前一交易日正式成员兜底
  let rows;
  if (ladder) {
    rows = buildLadderWatchlistRows(ladder, today, nowIso, 'worker');
  } else if (o.allowFallback) {
    rows = pickFallbackWatchlistRows(o.prevRows, today, nowIso, MIN_FALLBACK_ROWS);
    if (rows.length === 0) {
      logs.push('[ladder-heal] ❌ 前一交易日也没有足量正式成员（<' + MIN_FALLBACK_ROWS +
        ' 只）→ 本次不写名单，保留可观测的降级状态');
      return out;
    }
    out.fallback = true;
    logs.push('[ladder-heal] ⬇️ 名单源仍不可用 → 写入前一交易日正式成员兜底名单 ' + rows.length +
      ' 行（source=worker-fallback，第一页源条数显示 `--`）');
  } else {
    logs.push('[ladder-heal] 名单源未恢复且本次不允许兜底 → 不写任何行（手动补名单请稍后重试）');
    return out;
  }

  // 4) 9:25 名单锁定：窗口外只允许更新已存在的正式成员；
  //    当日正式名单为空 ⇒ 说明 9:25 那轮根本没落库 ⇒ 允许全量补写（2026-09-15 既有口径）。
  const inWin = isMorningWindow(beijingNow());
  if (!inWin && officialNames.size > 0) {
    const before = rows.length;
    rows = rows.filter(r => officialNames.has(r.stock));
    logs.push('[ladder-heal] 非 9:25 窗口：当日名单锁定，只更新已存在的 ' + rows.length +
      ' 行，跳过 ' + (before - rows.length) + ' 只新成分股');
  } else if (!inWin) {
    logs.push('[ladder-heal] 非 9:25 窗口，但当日【正式名单】为空 ⇒ 视为 9:25 未成功，允许全量补写 ' +
      rows.length + ' 行');
  }

  if (rows.length === 0) {
    logs.push('[ladder-heal] 名单锁定后无行可写 → 不写');
    return out;
  }

  try {
    await upsertAuctionWatchlist(env, rows);
  } catch (e) {
    logs.push('[ladder-heal] ❌ 写入 auction_watchlist 失败: ' + (e && e.message ? e.message : String(e)));
    return out;
  }
  out.written = rows.length;
  out.ok = true;
  logs.push('[ladder-heal] ✅ auction_watchlist 写入 ' + rows.length + ' 行（' +
    (out.fallback ? '兜底名单' : '真实 883410 名单') + '）');
  return out;
}
