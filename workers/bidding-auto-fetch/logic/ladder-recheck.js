// ladder-recheck.js — 北京 09:26 云端「最近多板 883410」二次确认 + 新进成分股竞价数据补抓
//
// ============================================================================
// [P0-2 2026-11-06 用户要求] 「最近多板源头也要修好」「全部改用云端的」「最迟 9 点 26 分」
// ----------------------------------------------------------------------------
// 事故回顾：11-06 09:25 上游 `Data source unavailable` ⇒ 9:25 那轮降级，
//   auction_watchlist 只剩 17 行观察组壳行 ⇒ 常规组全空（应用最重要的数据入口没了）。
//   09:4x 手工拨测同一个 883410 接口就恢复了（HTTP 200 / 2790ms / 57 只）。
//   ⇒ 单靠「9:25 内重试」不够：上游可能在 9:25:xx ~ 9:26 之间才恢复。
//
// 本模块 = 一条独立的云端 cron（wrangler `26 1 * * 2-6`，Cloudflare 免费额度 3/5），
//   在 09:26（开盘前 4 分钟）做三件事，全部幂等：
//     ① 9:25 已写入足量【真实 883410 名单】⇒ 直接跳过，0 网络请求、0 猫抓额度（§32）；
//     ② 否则再问一次真实名单源：恢复 ⇒ 写今天真实名单，并清掉 9:25 的 `worker-fallback` 行；
//     ③ 对「真实名单里有、但今天 market_metrics 还没数据 / 缺竞价量比」的票，
//        用【猫抓 daily_auc】一次性补上（1 次额度，按请求次数算不按股票数算）。
//
// ⛔⛔ 竞价量比唯一来源 = 猫抓 `daily_auc.auc_vol_ratio`（9:25 竞价时间段口径）。
//    同花顺 `auction_volume_ratio` 是开盘后口径，**任何时段、任何路径、兜底也不许用**。
//    本文件不 import 任何同花顺快照函数，就是为了从依赖上把这条路封死（用户 2026-11-06 原话）。
//
// 【成本上限】上游名单源 1 次（自带 12s 预算）+ 猫抓 1 次 + 少量 Supabase REST；
//  9:26:00 起跑，最坏 9:26:20 完成，仍在用户「最迟 9:26 获取完」的竞价窗口内。
// 【数据安全】§10 读取失败一律停止；§11 删除只针对当日 `source='worker-fallback'`，
//  且必须发生在「真实名单写入成功 + 重读复核达标」之后，删除后再复核一次。
// ============================================================================
import { beijingNow, beijingToday } from '../../_shared-source/date-utils.js';
import { fetchLadderConstituents } from '../data/fuyao-api.js';
import { numcatDailyAuc } from '../data/numcat-api.js';
import {
  readAuctionWatchlistForDate,
  readMarketMetricsSnapshotFieldsForDate,
  upsertAuctionWatchlist,
  upsertMarketMetrics,
  deleteLadderFallbackRows,
} from '../data/supabase-write.js';
import {
  MIN_LADDER_ROWS,
  MIN_FALLBACK_ROWS,
  isMorningWindow,
  buildLadderWatchlistRows,
  pickFallbackWatchlistRows,
} from './ladder-heal.js';
import { parseNumcatToMetrics } from './morning-workflow.js';

/** 今日正式成员里「真实 883410 名单」的条数（⛔ 兜底名单不算达标） */
export function countRealLadderRows(todayRows) {
  return (todayRows || []).filter(function (r) {
    return r && !r.obs_auto_added
      && String(r.source || '').trim() === 'worker'
      && /^\d{6}$/.test(String(r.code || '').trim());
  }).length;
}

/**
 * 纯函数：要不要在这一趟重查名单？
 * 只有「真实名单条数 < 门槛」才跑 —— 正常日 9:25 已写 55~95 行 ⇒ 恒跳过，零副作用。
 */
export function needsLadderRecheck(todayRows, minRows) {
  const need = minRows === undefined ? MIN_LADDER_ROWS : minRows;
  return countRealLadderRows(todayRows) < need;
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * 纯函数：算出这一趟需要猫抓补哪些票。
 *   · 库里今天连行都没有 ⇒ 需要写【整行】；
 *   · 有行但 auc_vol_ratio 为空 ⇒ 只补这一列（⛔ 不覆盖其它已有值，§11）；
 *   · 已有量比 ⇒ 完全不碰（幂等，避免重复写库）。
 * 只认 6 位代码；按 code 去重；不会返回空 symbols 让调用方白烧额度。
 */
export function pickNumcatTargets(ladder, metricsRows, opts) {
  const byName = new Map();
  (metricsRows || []).forEach(function (r) {
    if (r && r.name) byName.set(String(r.name).trim(), r);
  });
  const seenCode = new Set();
  const fullRows = [];
  const ratioOnly = [];
  const symbols = [];
  const add = function (name, code) {
    if (!name || !/^\d{6}$/.test(code) || seenCode.has(code)) return;
    const m = byName.get(name);
    if (m && hasValue(m.auc_vol_ratio)) return;      // 已有量比 ⇒ 完全不碰（幂等）
    seenCode.add(code);
    symbols.push(code);
    if (!m) fullRows.push({ name: name, code: code });
    else ratioOnly.push({ name: name, code: code }); // 有行缺量比 ⇒ 只补这一列（§11）
  };
  (ladder || []).forEach(function (c) {
    if (!c) return;
    add(String(c.name || '').trim(), String(c.code || '').trim());
  });
  // ★★ [RANGE20-RATIO-HEAL 2026-11-11] 旧实现只遍历 `ladder`（883410 真实成分股），
  //   ⇒ 20 日涨幅补位票（不写 watchlist、不在 ladder 里）即便当天有 market_metrics 行、
  //     缺 `auc_vol_ratio`，9:26 也永远补不到 ⇒ 只能等 16:30 收盘后回填（用户竞价时间看不到）。
  //   11-11 实测「青岛食品」就是这个形状：9:27 前端补出 ths-patch 壳行、量比永久为空，
  //   而同为补位票的「海洋王」9:25 就抓到量比 1.94。
  //   ⇒ 打开本开关后，把「当日已有行但缺量比」的票一并纳入 ratioOnly。
  //   ⚠️ 仍然只在 `symbols.length > 0` 时才发 1 次猫抓请求；9:25 全抓全时 0 请求、0 额度（§32）。
  //   ⚠️ 只补 `auc_vol_ratio` 一列，⛔ 不覆盖其它已有字段（buildAucMetricsWriteRows ratioOnly 路径）。
  if (opts && opts.includeAllRows) {
    (metricsRows || []).forEach(function (r) {
      if (!r) return;
      add(String(r.name || '').trim(), String(r.code || '').trim());
    });
  }
  return { symbols: symbols, fullRows: fullRows, ratioOnly: ratioOnly };
}

const FULL_FIELDS = [
  'volume', 'change_pct', 'yest_volume', 'auc_pct_chg',
  'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover',
];

/**
 * 纯函数：把 parseNumcatToMetrics 的当天结果转成写库行。
 * 复用主流程的解析器（假 0 守卫 / 越界闸门 / 量纲换算全一致，§6 单一真相），
 * 但按 pickNumcatTargets 的分类决定「整行」还是「只补量比一列」。
 */
export function buildAucMetricsWriteRows(parsedToday, today, nowIso, targets) {
  const byName = new Map();
  (parsedToday || []).forEach(function (m) {
    if (m && m.stock) byName.set(String(m.stock).trim(), m);
  });
  const rows = [];
  (targets.fullRows || []).forEach(function (t) {
    const m = byName.get(t.name);
    if (!m) return;
    const row = {
      date: today,
      stock: t.name,
      code: t.code,
      scope: 'auction',
      source: 'worker',
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker',
    };
    let got = 0;
    FULL_FIELDS.forEach(function (k) {
      if (hasValue(m[k])) { row[k] = m[k]; got++; }
    });
    // ⛔ 一只字段都没拿到就别建空行：建了只会让「有行但全空」伪装成「已抓到」，
    //    题材量比闸门会把它算进分母却拿不到量比（§10 宁缺勿错，等 16:30 云端回填）。
    if (got > 0) rows.push(row);
  });
  (targets.ratioOnly || []).forEach(function (t) {
    const m = byName.get(t.name);
    if (!m || !hasValue(m.auc_vol_ratio)) return;
    // ⛔ 只带这一列：resolution=merge-duplicates 只更新 payload 里出现的列，
    //    绝不把 worker / 猫抓历史回填写好的其它字段抹掉（§11 覆盖即高风险）。
    rows.push({
      date: today,
      stock: t.name,
      scope: 'auction',
      auc_vol_ratio: m.auc_vol_ratio,
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker',
    });
  });
  return rows;
}

/**
 * 用猫抓 daily_auc 补「真实名单里的新票 / 缺量比的票」。
 * ⛔ 整个函数最多 1 次 numcat 请求；额度用尽直接优雅退出，不重试（§32）。
 */
async function fillAucFromNumcat(env, today, ladder, logs) {
  const out = { attempted: false, symbols: 0, written: 0, skipped: '', error: '' };
  let metricsRows;
  try {
    metricsRows = await readMarketMetricsSnapshotFieldsForDate(env, today);
  } catch (e) {
    out.error = '读取当日 market_metrics 失败 → 停止补抓（§10 不把读失败当空表）: ' + (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ ' + out.error);
    return out;
  }
  // ★ [RANGE20-RATIO-HEAL 2026-11-11] 打开「当日已有行但缺量比」的补抓（含 20 日补位票）。
  //   仍严格只在有缺口时才发 1 次请求；9:25 全抓全时 0 请求、0 猫抓额度（§32）。
  const targets = pickNumcatTargets(ladder, metricsRows, { includeAllRows: true });
  out.symbols = targets.symbols.length;
  if (targets.symbols.length === 0) {
    out.skipped = '当日 9:25 名单竞价量比齐全 → 0 次猫抓请求';
    logs.push('[ladder26] ✅ ' + out.skipped);
    return out;
  }
  out.attempted = true;
  const ymd = String(today).replace(/-/g, '');
  let data;
  try {
    data = await numcatDailyAuc(env, targets.symbols.join(','), ymd, ymd, logs);
  } catch (e) {
    out.error = (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ 猫抓 daily_auc 补抓失败（本次不重试、不连坐名单写入）: ' + out.error);
    return out;
  }
  const fields = (data && data.fields) || [];
  const items = (data && data.items) || [];
  if (fields.indexOf('symbol') < 0 || fields.indexOf('auc_vol_ratio') < 0 || items.length === 0) {
    out.skipped = '猫抓本次未返回 symbol/auc_vol_ratio（或 0 行）→ 不写任何行，量比留空待 16:30 云端回填';
    logs.push('[ladder26] ⚠️ ' + out.skipped);
    return out;
  }
  // ★ [RANGE20-RATIO-HEAL 2026-11-11] 解析白名单要覆盖「补抓目标」而不只是 ladder：
  //   `parseNumcatToMetrics` 用 codeToName 把猫抓 code 映射回库里的股票名， ladder 为 null
  //   （9:25 名单已足、只补缺量比票）时不能传 null（会 .forEach 崩），也不能只靠猫抓返回的
  //   name 兜底（别名/简繁不一致 ⇒ buildAucMetricsWriteRows 按库名匹配不上 ⇒ 白补一趟）。
  const allowList = (ladder || []).concat(targets.fullRows || [], targets.ratioOnly || [])
    .map(function (t) { return { name: t.name, code: t.code }; });
  const parsed = parseNumcatToMetrics(items, fields, allowList, logs, today);
  const rows = buildAucMetricsWriteRows(parsed.metricsByDate[today] || [], today, new Date().toISOString(), targets);
  if (rows.length === 0) {
    out.skipped = '猫抓返回 ' + items.length + ' 行但无一行可写（名单/字段不匹配）→ 留空不猜';
    logs.push('[ladder26] ⚠️ ' + out.skipped);
    return out;
  }
  try {
    await upsertMarketMetrics(env, rows);   // 内部按「键集签名」分桶，⛔ 不会 PGRST102
  } catch (e) {
    out.error = 'market_metrics 写入失败: ' + (e && e.message ? e.message : String(e));
    logs.push('[ladder26] ❌ ' + out.error);
    return out;
  }
  out.written = rows.length;
  logs.push('[ladder26] ✅ 猫抓 daily_auc 1 次请求 → 写入 market_metrics ' + rows.length +
    ' 行（新票整行 / 已有票只补 auc_vol_ratio，来源=猫抓竞价时间段）');
  return out;
}

/**
 * 9:26 云端二次确认主入口。
 * @returns {Promise<{ok:boolean,today:string,skipped:boolean,recovered:boolean,written:number,fallbackCleared:number,ladderCount:number|null,auc:object,logs:string[]}>}
 */
export async function runLadderRecheck(env, opts) {
  const o = opts || {};
  const logs = o.logs || [];
  const today = o.today || beijingToday();
  const nowIso = new Date().toISOString();
  const out = {
    ok: false, today: today, skipped: false, recovered: false,
    written: 0, fallbackCleared: 0, ladderCount: null,
    auc: { attempted: false, symbols: 0, written: 0, skipped: '', error: '' },
    logs: logs,
  };

  // ★★ [RANGE20-RATIO-HEAL 2026-11-11] 「名单二次确认」和「竞价量比补缺」是两件事。
  //   旧实现只在 ⑥（名单恢复成功路径）末尾补量比，而【9:25 名单足量】时 ① 就直接 return
  //   ⇒ 20 日涨幅补位票 / stockcodemap 缺票 即便当天已有 market_metrics 行、只是缺
  //     `auc_vol_ratio`，也永远补不到。11-11「青岛食品」就是这么丢的：9:25 名单 77 行足量
  //     ⇒ 9:26 走 skipped 分支、0 次猫抓请求，全天量比为空（海洋王因 9:25 就在名单里有 1.94）。
  //   ⇒ 统一收敛到 finish()：所有「数据可读」的返回路径都补一次，整轮最多 1 次猫抓，
  //     且仅在确有缺口时发请求（9:25 全抓全时 0 请求、0 额度，§32）。
  //   ⚠️ ladderForAuc：名单恢复成功时传真实 883410 名单（保留原有「新进成分股整行补写」）；
  //     否则传 null ⇒ pickNumcatTargets 只靠 includeAllRows 覆盖「当日已有行但缺量比」的票。
  let ladderForAuc = null;
  const finish = async function () {
    if (out.auc.attempted || out.auc.skipped || out.auc.error) return out;
    out.auc = await fillAucFromNumcat(env, today, ladderForAuc, logs);
    return out;
  };

  // ① 当日名单现状。读取失败必须停（§10），绝不把它当「空名单」往下写。
  let todayRows;
  try {
    todayRows = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder26] ❌ 读取当日 auction_watchlist 失败 → 停止: ' + (e && e.message ? e.message : String(e)));
    return out;
  }
  if (!needsLadderRecheck(todayRows, MIN_LADDER_ROWS)) {
    out.ok = true;
    out.skipped = true;
    logs.push('[ladder26] ✅ 9:25 已写入 ' + countRealLadderRows(todayRows) +
      ' 行真实 883410 名单（≥' + MIN_LADDER_ROWS + '）→ 不重查名单（0 上游请求）；' +
      '仅检查当日缺竞价量比的行（含 20 日补位票），无缺口则 0 猫抓额度');
    return finish();
  }

  const officialNames = new Set(todayRows.filter(r => !r.obs_auto_added).map(r => r.name));
  const inWin = isMorningWindow(beijingNow());
  logs.push('[ladder26] 当日真实名单 ' + countRealLadderRows(todayRows) + ' 行（<' + MIN_LADDER_ROWS +
    '）⇒ 重查 883410；9:25 窗口=' + inWin);

  // ② 再问一次真实名单源（fetchLadderConstituents 自带 4 次 / 12s 预算，不会顶穿 9:26）
  let ladder = null;
  try {
    const raw = await fetchLadderConstituents(env);
    if (Array.isArray(raw) && raw.length >= MIN_LADDER_ROWS) {
      ladder = raw;
      ladderForAuc = raw;
      out.recovered = true;
      out.ladderCount = raw.length;
      logs.push('[ladder26] ✅ 883410 恢复，拿到 ' + raw.length + ' 只');
    } else {
      logs.push('[ladder26] ⚠️ 883410 只返回 ' + (Array.isArray(raw) ? raw.length : 0) +
        ' 只（<' + MIN_LADDER_ROWS + '）→ 视为残缺，不写正式名单');
    }
  } catch (e) {
    logs.push('[ladder26] ⚠️ 883410 仍不可用: ' + (e && e.message ? e.message : String(e)));
  }

  // ③ 名单源仍挂 + 当日一个正式成员都没有 ⇒ 写前一日兜底（9:25 整轮可能压根没跑成）
  if (!ladder) {
    if (officialNames.size > 0) {
      logs.push('[ladder26] 名单源未恢复，但当日已有 ' + officialNames.size +
        ' 行正式成员（含 9:25 兜底）⇒ 保留现状，⛔ 不覆盖、不删除');
      out.ok = true;
      return finish();
    }
    const fb = pickFallbackWatchlistRows(o.prevRows, today, nowIso, MIN_FALLBACK_ROWS);
    if (fb.length === 0) {
      logs.push('[ladder26] ❌ 名单源未恢复且无足量前一日正式成员 → 不写名单，保留可观测的降级状态');
      return finish();
    }
    try {
      await upsertAuctionWatchlist(env, fb);
      out.written = fb.length;
      out.ok = true;
      logs.push('[ladder26] ⬇️ 写入前一日正式成员兜底 ' + fb.length + ' 行（source=worker-fallback）');
    } catch (e) {
      logs.push('[ladder26] ❌ 兜底名单写入失败: ' + (e && e.message ? e.message : String(e)));
    }
    return finish();
  }

  // ④ 写真实名单。非 9:25 窗口且当日已有正式成员 ⇒ 名单锁定，只更新已存在的行。
  let rows = buildLadderWatchlistRows(ladder, today, nowIso, 'worker');
  if (!inWin && officialNames.size > 0) {
    const before = rows.length;
    rows = rows.filter(r => officialNames.has(r.stock));
    logs.push('[ladder26] 非 9:25 窗口：名单锁定，只更新已存在的 ' + rows.length +
      ' 行，跳过 ' + (before - rows.length) + ' 只新成分股');
  }
  if (rows.length === 0) {
    logs.push('[ladder26] 名单锁定后无行可写 → 不写');
    return finish();
  }
  try {
    await upsertAuctionWatchlist(env, rows);
    out.written = rows.length;
    out.ok = true;
    logs.push('[ladder26] ✅ auction_watchlist 写入真实 883410 名单 ' + rows.length + ' 行');
  } catch (e) {
    logs.push('[ladder26] ❌ 真实名单写入失败 → 停止（⛔ 不清兜底、不补行情）: ' +
      (e && e.message ? e.message : String(e)));
    return out;
  }

  // ⑤ 清掉 9:25 写入的兜底行：必须「写入成功 + 重读复核达标」后才允许删（§11）
  let after;
  try {
    after = await readAuctionWatchlistForDate(env, today);
  } catch (e) {
    logs.push('[ladder26] ⚠️ 写入后重读失败 → 不删除任何兜底行: ' + (e && e.message ? e.message : String(e)));
    after = [];
  }
  if (countRealLadderRows(after) >= MIN_LADDER_ROWS) {
    try {
      const deleted = await deleteLadderFallbackRows(env, today);
      out.fallbackCleared = deleted;
      logs.push('[ladder26] ✅ 清理当日 source=worker-fallback 兜底行 ' + deleted + ' 行（带结果确认）');
      // [CLOUD-0927-HEAL 2026-11-11] readAuctionWatchlistForDate 现在读失败会抛错（§10）。
      //   删除后的复核必须单独接住，否则「复核读失败」会被下面那条 catch 误报成「清理兜底行失败」。
      try {
        const verify = await readAuctionWatchlistForDate(env, today);
        if (countRealLadderRows(verify) < MIN_LADDER_ROWS) {
          logs.push('[ladder26] ❌ 删除后复核：真实名单不足 ' + MIN_LADDER_ROWS + ' 行 → 报警，请人工检查');
          out.ok = false;
        }
      } catch (ve) {
        logs.push('[ladder26] ⚠️ 删除后复核读取失败（删除动作已成功，结果未确认）: ' +
          ((ve && ve.message) || String(ve)));
      }
    } catch (e) {
      logs.push('[ladder26] ⚠️ 清理兜底行失败（不影响刚写入的真实名单）: ' +
        (e && e.message ? e.message : String(e)));
    }
  } else {
    logs.push('[ladder26] ⚠️ 写入后复核未达标 → ⛔ 不删除任何兜底行（宁可多留几行，也不清空名单）');
  }

  // ⑥ 猫抓补新进票 / 缺量比票。失败只记日志，绝不影响已写好的真实名单。
  //    [RANGE20-RATIO-HEAL] 统一走 finish()：ladderForAuc 带真实名单 ⇒ 既补新进成分股整行，
  //    也靠 includeAllRows 补「当日已有行但缺 auc_vol_ratio」的 20 日补位票。
  return finish();
}
